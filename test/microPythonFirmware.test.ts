import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MICROPYTHON_BOARDS, MicroPythonFirmwareService, parseFirmwareReleases } from '../src/firmware/microPythonFirmware';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const origin = 'https://micropython.org';
const file = 'ESP32_GENERIC-20260824-v1.29.0.bin';
const firmwareUrl = `${origin}/resources/firmware/${file}`;
const anchor = (href: string) => `<a href="${href}">firmware</a>`;
const release = () => parseFirmwareReleases('ESP32_GENERIC', anchor(firmwareUrl))[0]!;
const image = () => { const bytes = Buffer.alloc(64 * 1024, 0xff); bytes[0] = 0xe9; bytes.writeUInt16LE(0, 12); return bytes; };
async function fixture(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'micropal-firmware-')); roots.push(root);
  return { root, service: new MicroPythonFirmwareService(root, { fetch: fetcher }) };
}

describe('official MicroPython catalog', () => {
  it('keeps chip, combined image address and supported variants explicit', () => {
    expect(MICROPYTHON_BOARDS.map(board => [board.id, board.chip, board.offset, board.variants.map(variant => variant.id)])).toEqual([
      ['ESP32_GENERIC', 'esp32', '0x1000', ['', 'SPIRAM', 'UNICORE', 'OTA', 'D2WD']],
      ['ESP32_GENERIC_S3', 'esp32s3', '0x0', ['', 'SPIRAM_OCT']],
    ]);
  });

  it('reads actual stable links, deduplicates and sorts versions numerically', () => {
    const html = [anchor(firmwareUrl), anchor(`/resources/firmware/${file}`),
      anchor('/resources/firmware/ESP32_GENERIC-SPIRAM-20260824-v1.29.0.bin'),
      anchor('/resources/firmware/ESP32_GENERIC-20200101-v1.9.bin'),
      anchor('/resources/firmware/ESP32_GENERIC-20200102-v1.10.0.bin')].join('\n');
    const releases = parseFirmwareReleases('ESP32_GENERIC', html);
    expect(releases.map(value => [value.version, value.variantId])).toEqual([['1.29.0', ''], ['1.29.0', 'SPIRAM'], ['1.10.0', ''], ['1.9', '']]);
    expect(releases[0]).toEqual({ boardId: 'ESP32_GENERIC', variantId: '', version: '1.29.0', date: '2026-08-24',
      filename: file, url: firmwareUrl, chip: 'esp32', offset: '0x1000' });
  });

  it('excludes development, application-only, UF2, other boards, obsolete variants and nonofficial URLs', () => {
    const paths = ['ESP32_GENERIC_S3-20260824-v1.29.0.uf2', 'ESP32_GENERIC_S3-20260824-v1.29.0.app-bin',
      'ESP32_GENERIC_S3-20260824-v1.29.0.elf', 'ESP32_GENERIC_S3-20260929-v1.30.0-preview.95.g5b5f06cb48.bin',
      'ESP32_GENERIC_S3-FLASH_4M-20260824-v1.29.0.bin', file, 'ESP32_GENERIC_S3-20260230-v1.29.0.bin'];
    const html = paths.map(name => anchor(`/resources/firmware/${name}`)).join('') +
      [anchor('https://evil.example/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin'),
        anchor('http://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin'),
        anchor('https://micropython.org@evil.example/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin'),
        anchor('/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin?download=1'),
        anchor('/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin#image'),
        anchor('/untrusted/../resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin')].join('') +
      anchor('/resources/firmware/ESP32_GENERIC_S3-SPIRAM_OCT-20260824-v1.29.0.bin') +
      anchor('/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin');
    expect(parseFirmwareReleases('ESP32_GENERIC_S3', html).map(value => value.variantId)).toEqual(['', 'SPIRAM_OCT']);
    expect(() => parseFirmwareReleases('UNKNOWN' as 'ESP32_GENERIC', html)).toThrow(/unsupported board/i);
  });

  it('fetches only on request and fails clearly when the page no longer has supported images', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(anchor(firmwareUrl)));
    const { root, service } = await fixture(fetcher);
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
    expect((await service.getReleases('ESP32_GENERIC')).map(value => value.filename)).toEqual([file]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${origin}/download/ESP32_GENERIC/`);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
    fetcher.mockResolvedValueOnce(new Response('<html>changed site</html>'));
    await expect(service.getReleases('ESP32_GENERIC')).rejects.toThrow(/no supported stable/i);
  });
});

describe('official firmware downloads', () => {
  it('atomically stores image bytes, SHA256 provenance and progress in private storage', async () => {
    const bytes = image();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
    const { root, service } = await fixture(fetcher); const progress = vi.fn();
    const result = await service.download(release(), undefined, progress);
    expect(await readFile(result.firmwarePath)).toEqual(bytes);
    expect(result.bytes).toBe(bytes.length); expect(result.release).toEqual(release());
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(dirname(dirname(result.firmwarePath))).toBe(join(root, 'firmware'));
    expect(progress).toHaveBeenLastCalledWith({ receivedBytes: bytes.length, totalBytes: bytes.length });
    const manifest = JSON.parse(await readFile(`${result.firmwarePath}.json`, 'utf8'));
    expect(manifest).toMatchObject({ release: release(), sha256: result.sha256, bytes: bytes.length, verification: 'local-sha256' });
    expect((await readdir(join(root, 'firmware'))).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('rejects forged metadata before fetching or touching storage', async () => {
    const fetcher = vi.fn<typeof fetch>(); const { root, service } = await fixture(fetcher);
    for (const forged of [{ ...release(), url: 'https://evil.example/fw.bin' }, { ...release(), offset: '0x0' as const },
      { ...release(), filename: '../escape.bin' }, { ...release(), version: '9.9.9' }]) {
      await expect(service.download(forged)).rejects.toThrow(/invalid official firmware/i);
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it.each([['empty', Buffer.alloc(0)], ['truncated header', Buffer.from([0xe9])], ['HTML response', Buffer.from('<html>not firmware</html>')]])(
    'rejects %s and leaves no files', async (_label, bytes) => {
      const { root, service } = await fixture(async () => new Response(bytes));
      await expect(service.download(release())).rejects.toThrow(/invalid ESP firmware/i);
      expect(await readdir(join(root, 'firmware'))).toEqual([]);
    });

  it('rejects size limit and content-length mismatch with cleanup', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(image(), { headers: { 'content-length': String(17 * 1024 * 1024) } }));
    const { root, service } = await fixture(fetcher);
    await expect(service.download(release())).rejects.toThrow(/size limit/i);
    fetcher.mockResolvedValueOnce(new Response(image(), { headers: { 'content-length': '999' } }));
    await expect(service.download(release())).rejects.toThrow(/length/i);
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
  });

  it('rejects redirects outside the official asset path without following them', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/fw.bin' } }));
    const { root, service } = await fixture(fetcher);
    await expect(service.download(release())).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(join(root, 'firmware'))).toEqual([]);
  });

  it('cancels during streaming and removes partial bytes', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(image()); }, cancel() {} });
    const { root, service } = await fixture(async () => new Response(body));
    await expect(service.download(release(), controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
  });

  it('does no work for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>(); const { root, service } = await fixture(fetcher);
    await expect(service.download(release(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.getReleases('ESP32_GENERIC', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it('checks the chip ID even when a download otherwise resembles an ESP image', async () => {
    const bytes = image(); bytes.writeUInt16LE(9, 12);
    const { root, service } = await fixture(async () => new Response(bytes));
    await expect(service.download(release())).rejects.toThrow(/wrong chip/i);
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
    const s3 = parseFirmwareReleases('ESP32_GENERIC_S3', anchor('/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin'))[0]!;
    const successful = await service.download(s3);
    expect(await readFile(successful.firmwarePath)).toEqual(bytes);
  });

  it('preserves streamed bytes and a header split across response chunks', async () => {
    const bytes = image();
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(bytes.subarray(0, 3)); stream.enqueue(bytes.subarray(3, 18)); stream.enqueue(bytes.subarray(18)); stream.close();
    } });
    const { service } = await fixture(async () => new Response(body));
    const result = await service.download(release());
    expect(await readFile(result.firmwarePath)).toEqual(bytes);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('enforces byte limits when the server omits content-length', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1)));
    const { root, service } = await fixture(fetcher);
    await expect(service.download(release())).rejects.toThrow(/size limit/i);
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(service.getReleases('ESP32_GENERIC')).rejects.toThrow(/size limit/i);
  });

  it('cancels a stalled fetch even when the injected server ignores the signal', async () => {
    const controller = new AbortController();
    const { service } = await fixture(() => new Promise(() => {}));
    const request = service.getReleases('ESP32_GENERIC', controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds a stalled catalog request with a deadline', async () => {
    const { service } = await fixture(() => new Promise(() => {})); vi.useFakeTimers();
    const request = service.getReleases('ESP32_GENERIC');
    const failure = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000); await failure;
  });

  it('cancels a stalled stream and removes its staging directory', async () => {
    const controller = new AbortController();
    const { root, service } = await fixture(async () => new Response(new ReadableStream<Uint8Array>()));
    const request = service.download(release(), controller.signal);
    const failure = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await readdir(join(root, 'firmware'))).toHaveLength(1));
    controller.abort(); await failure;
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
  });

  it('does not reuse or overwrite an earlier downloaded image', async () => {
    const { service } = await fixture(async () => new Response(image()));
    const first = await service.download(release()); const second = await service.download(release());
    expect(first.firmwarePath).not.toBe(second.firmwarePath);
    expect(await readFile(first.firmwarePath)).toEqual(await readFile(second.firmwarePath));
  });

  it('refuses partial HTTP responses that could masquerade as complete firmware', async () => {
    const { service } = await fixture(async () => new Response(image(), { status: 206, headers: { 'content-length': String(image().length) } }));
    await expect(service.download(release())).rejects.toThrow(/HTTP 206/);
  });

  it('requests identity encoding and refuses unexpected compressed response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(image(), { headers: { 'content-encoding': 'gzip' } }));
    const { service } = await fixture(fetcher);
    await expect(service.download(release())).rejects.toThrow(/encoding/i);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('accept-encoding')).toBe('identity');
  });

  it('closes the response body when oversized advertised length fails before streaming', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { service } = await fixture(async () => new Response(body, { headers: { 'content-length': String(17 * 1024 * 1024) } }));
    await expect(service.download(release())).rejects.toThrow(/size limit/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a stalled firmware response and removes its incomplete directory', async () => {
    let started!: () => void; const fetching = new Promise<void>(accept => { started = accept; });
    const { root, service } = await fixture(() => { started(); return new Promise(() => {}); });
    vi.useFakeTimers();
    const request = service.download(release());
    const failure = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    await fetching; await vi.advanceTimersByTimeAsync(120_000); await failure;
    expect(await readdir(join(root, 'firmware'))).toEqual([]);
  });
});
