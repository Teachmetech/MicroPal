import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type MicroPythonBoardId = 'ESP32_GENERIC' | 'ESP32_GENERIC_S3';
export interface FirmwareVariant { readonly id: string; readonly label: string; readonly description: string; }
export interface MicroPythonBoard {
  readonly id: MicroPythonBoardId; readonly label: string; readonly chip: 'esp32' | 'esp32s3';
  readonly offset: '0x1000' | '0x0'; readonly variants: readonly FirmwareVariant[];
}
export const MICROPYTHON_BOARDS: readonly MicroPythonBoard[] = [
  { id: 'ESP32_GENERIC', label: 'Generic ESP32', chip: 'esp32', offset: '0x1000', variants: [
    { id: '', label: 'Standard', description: 'ESP32 with at least 4 MiB flash, without PSRAM.' },
    { id: 'SPIRAM', label: 'SPIRAM / WROVER', description: 'ESP32 boards with external PSRAM.' },
    { id: 'UNICORE', label: 'Unicore / SOLO', description: 'Single-core ESP32 boards.' },
    { id: 'OTA', label: 'OTA', description: 'OTA partition layout; less space for the filesystem.' },
    { id: 'D2WD', label: 'D2WD', description: 'ESP32-D2WD with 2 MiB flash.' },
  ] },
  { id: 'ESP32_GENERIC_S3', label: 'Generic ESP32-S3', chip: 'esp32s3', offset: '0x0', variants: [
    { id: '', label: 'Standard', description: 'ESP32-S3 with at least 4 MiB flash and ordinary or no PSRAM.' },
    { id: 'SPIRAM_OCT', label: 'Octal PSRAM', description: 'ESP32-S3 boards with octal PSRAM.' },
  ] },
];
export interface FirmwareRelease {
  boardId: MicroPythonBoardId; variantId: string; version: string; date: string;
  filename: string; url: string; chip: 'esp32' | 'esp32s3'; offset: '0x1000' | '0x0';
}
export interface FirmwareProgress { receivedBytes: number; totalBytes?: number; }
export interface DownloadedFirmware { firmwarePath: string; sha256: string; bytes: number; release: FirmwareRelease; }
export interface FirmwareServiceOptions { fetch?: typeof fetch; }
const ORIGIN = 'https://micropython.org';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_FIRMWARE_BYTES = 16 * 1024 * 1024;
const MIN_FIRMWARE_BYTES = 64 * 1024;

function boardFor(id: MicroPythonBoardId): MicroPythonBoard {
  const board = MICROPYTHON_BOARDS.find(value => value.id === id);
  if (!board) throw new Error(`Unsupported board: ${id}`);
  return board;
}
function parseLink(board: MicroPythonBoard, href: string): FirmwareRelease | undefined {
  // Requiring the original spelling also excludes traversal, credentials, ports,
  // encoded paths, queries and fragments that URL normalization could conceal.
  const absolute = href.startsWith('/') ? `${ORIGIN}${href}` : href;
  const match = absolute.match(/^https:\/\/micropython\.org\/resources\/firmware\/([A-Z0-9_]+)(?:-([A-Z0-9_]+))?-(\d{4})(\d{2})(\d{2})-v(\d+\.\d+(?:\.\d+)?)\.bin$/);
  if (!match || match[1] !== board.id) return;
  const variantId = match[2] ?? '';
  if (!board.variants.some(value => value.id === variantId)) return;
  const date = `${match[3]}-${match[4]}-${match[5]}`;
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date ||
    !match[6]!.split('.').every(part => Number.isSafeInteger(Number(part)))) return;
  const filename = absolute.slice(absolute.lastIndexOf('/') + 1);
  return { boardId: board.id, variantId, version: match[6]!, date, filename, url: absolute, chip: board.chip, offset: board.offset };
}

/** Reads only stable combined BIN links actually present on the official board page. */
export function parseFirmwareReleases(boardId: MicroPythonBoardId, html: string): FirmwareRelease[] {
  const board = boardFor(boardId); const releases = new Map<string, FirmwareRelease>();
  for (const anchor of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gis)) {
    const release = parseLink(board, anchor[2]!);
    if (release) releases.set(release.url, release);
  }
  return [...releases.values()].sort((a, b) => {
    const first = a.version.split('.').map(Number); const second = b.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) { const difference = (second[i] ?? 0) - (first[i] ?? 0); if (difference) return difference; }
    return b.date.localeCompare(a.date) || board.variants.findIndex(value => value.id === a.variantId) - board.variants.findIndex(value => value.id === b.variantId);
  });
}
function cancelled(): Error { const error = new Error('Firmware request cancelled.'); error.name = 'AbortError'; return error; }
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : cancelled(); }
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  return new Promise<T>((accept, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
async function withDeadline<T>(external: AbortSignal | undefined, timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const abort = () => controller.abort(cancelled());
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timer = setTimeout(() => { const error = new Error('Firmware request timed out.'); error.name = 'TimeoutError'; controller.abort(error); }, timeoutMs);
  try { checkSignal(controller.signal); return await action(controller.signal); }
  finally { clearTimeout(timer); external?.removeEventListener('abort', abort); controller.abort(); }
}
function closeBody(response: Response): void { void response.body?.cancel().catch(() => {}); }
function contentLength(response: Response, maximum: number): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) { closeBody(response); throw new Error('Invalid HTTP content length.'); }
  const length = Number(raw);
  if (length > maximum) { closeBody(response); throw new Error('Official download exceeds the size limit.'); }
  return length;
}

/** Performs network requests only when a caller explicitly requests a catalog or download. */
export class MicroPythonFirmwareService {
  private readonly root: string;
  private readonly fetcher: typeof fetch;
  constructor(storagePath: string, options: FirmwareServiceOptions = {}) {
    this.root = join(resolve(storagePath), 'firmware'); this.fetcher = options.fetch ?? fetch;
  }

  async getReleases(boardId: MicroPythonBoardId, signal?: AbortSignal): Promise<FirmwareRelease[]> {
    const board = boardFor(boardId);
    return withDeadline(signal, 30_000, async active => {
      const response = await this.request(`${ORIGIN}/download/${board.id}/`, active);
      const total = contentLength(response, MAX_CATALOG_BYTES); const chunks: Buffer[] = [];
      await this.consume(response, MAX_CATALOG_BYTES, total, active, async chunk => { chunks.push(Buffer.from(chunk)); });
      const releases = parseFirmwareReleases(board.id, Buffer.concat(chunks).toString('utf8'));
      if (!releases.length) throw new Error('The official page contains no supported stable firmware images. Try the official download website or a local BIN.');
      return releases;
    });
  }

  async download(release: FirmwareRelease, signal?: AbortSignal, onProgress?: (progress: FirmwareProgress) => void): Promise<DownloadedFirmware> {
    const expected = parseLink(boardFor(release.boardId), release.url);
    if (!expected || (Object.keys(expected) as (keyof FirmwareRelease)[]).some(key => expected[key] !== release[key])) {
      throw new Error('Invalid official firmware release metadata.');
    }
    // Copy before awaiting so a mutable caller cannot retarget an in-flight download.
    const selected = { ...expected };
    return withDeadline(signal, 120_000, async active => {
      checkSignal(active);
      await mkdir(this.root, { recursive: true });
      const generation = `download-${randomUUID()}`; const staging = join(this.root, `.${generation}.tmp`);
      await mkdir(staging);
      try {
        const response = await this.request(selected.url, active);
        const total = contentLength(response, MAX_FIRMWARE_BYTES); const hash = createHash('sha256');
        const header = Buffer.alloc(24); let headerLength = 0; let bytes = 0;
        const image = await open(join(staging, selected.filename), 'wx');
        try {
          bytes = await this.consume(response, MAX_FIRMWARE_BYTES, total, active, async (chunk, received) => {
            const copied = Math.min(24 - headerLength, chunk.byteLength);
            if (copied) { header.set(chunk.subarray(0, copied), headerLength); headerLength += copied; }
            hash.update(chunk); await image.writeFile(chunk);
            onProgress?.({ receivedBytes: received, ...(total === undefined ? {} : { totalBytes: total }) });
          });
          if (bytes < MIN_FIRMWARE_BYTES || header[0] !== 0xe9 || header.readUInt16LE(12) !== (selected.chip === 'esp32' ? 0 : 9)) {
            throw new Error('Invalid ESP firmware image: incomplete header, image too small, or wrong chip family.');
          }
          await image.sync();
        } finally { await image.close(); }
        checkSignal(active);
        const sha256 = hash.digest('hex');
        await writeFile(join(staging, `${selected.filename}.json`), JSON.stringify({ schema: 1, release: selected,
          sha256, bytes, verification: 'local-sha256', downloadedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
        checkSignal(active);
        const destination = join(this.root, generation); await rename(staging, destination);
        return { firmwarePath: join(destination, selected.filename), sha256, bytes, release: selected };
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    checkSignal(signal);
    const response = await abortable(this.fetcher(url, { signal, redirect: 'manual', headers: {
      'User-Agent': 'MicroPal firmware downloader', Accept: '*/*', 'Accept-Encoding': 'identity',
    } }), signal);
    if (response.status >= 300 && response.status < 400) {
      closeBody(response);
      throw new Error('Official firmware download redirected; redirects are refused to keep downloads on the selected official URL.');
    }
    if (response.status !== 200 || (response.url && response.url !== url)) {
      closeBody(response); throw new Error(`Official firmware request failed (HTTP ${response.status}).`);
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') { closeBody(response); throw new Error('Unexpected HTTP content encoding for official firmware response.'); }
    return response;
  }

  private async consume(response: Response, maximum: number, expected: number | undefined, signal: AbortSignal,
    accept: (chunk: Uint8Array, received: number) => Promise<void>): Promise<number> {
    if (!response.body) throw new Error('Invalid ESP firmware response: empty body.');
    const reader = response.body.getReader(); let received = 0;
    try {
      while (true) {
        checkSignal(signal); const part = await abortable(reader.read(), signal);
        if (part.done) break;
        received += part.value.byteLength;
        if (received > maximum) throw new Error('Official download exceeds the size limit.');
        await accept(part.value, received); checkSignal(signal);
      }
      if (expected !== undefined && received !== expected) throw new Error('Official download content length did not match the received bytes.');
      return received;
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
