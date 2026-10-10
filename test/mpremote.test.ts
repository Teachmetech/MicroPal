import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MpremoteTransport, normalizeRemotePath, parsePorts, parseStructuredOutput } from '../src/transport/mpremote';
import type { CommandResult, CommandSpec, DevicePort, DeviceSettings, ProcessOptions, ProcessRunner } from '../src/core/types';

const board: DevicePort = { path: '/dev/cu.usbmodem123', description: 'ESP32', likelyEsp32: true };
const defaults: DeviceSettings = { mpremotePath: '/tools with spaces/mpremote', preferredPort: '', baudRate: 115200, autoReconnect: true, syncExclusions: [] };
const begin = '__MICROPAL_BEGIN__';
const end = '__MICROPAL_END__';
const envelope = (data: unknown) => `${begin}\r\n${JSON.stringify(data)}\r\n${end}\r\n`;
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class RecordingRunner implements ProcessRunner {
  calls: { spec: CommandSpec; options?: ProcessOptions }[] = [];
  result: CommandResult = { stdout: '', stderr: '' };
  error?: Error;
  async run(spec: CommandSpec, options?: ProcessOptions): Promise<CommandResult> {
    this.calls.push({ spec, options });
    if (this.error) throw this.error;
    return this.result;
  }
}
function setup(settings = { ...defaults }) {
  const runner = new RecordingRunner();
  const launches: CommandSpec[] = [];
  const session = { closed: Promise.resolve(), close: async () => {}, show: () => {} };
  const output: string[] = [];
  const transport = new MpremoteTransport(runner, () => settings, async spec => { launches.push(spec); return session; }, text => output.push(text));
  return { runner, transport, launches, session, output };
}
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'esp32-transport-'));
  tempDirs.push(dir);
  return dir;
}
function executeCode(spec: CommandSpec, root: string): string {
  const index = spec.args.indexOf('exec');
  expect(index).toBeGreaterThan(-1);
  // Keep device paths POSIX while mapping them to real host fixtures on every OS.
  // os.replace gives the fixture POSIX rename-overwrite semantics on Windows too.
  const harness = `import os, builtins\n_root = ${JSON.stringify(root)}\ndef _map(p):\n return os.path.join(_root, *p[len('/device/'):].split('/')) if p.startswith('/device/') else (_root if p == '/device' else p)\nfor _name in ['listdir', 'stat', 'mkdir', 'remove', 'rmdir']:\n _original = getattr(os, _name)\n setattr(os, _name, lambda p, *args, _original=_original, **kwargs: _original(_map(p), *args, **kwargs))\n_original_rename = os.replace\nos.rename = lambda src, dst: _original_rename(_map(src), _map(dst))\n_original_open = builtins.open\nclass _BoundedFile:\n def __init__(self, f): self.f = f\n def __enter__(self): return self\n def __exit__(self, *args): self.f.close()\n def read(self, size=-1):\n  if not 0 <= size <= 4096: raise AssertionError('Preview must use small bounded reads')\n  return self.f.read(size)\nbuiltins.open = lambda p, *args, **kwargs: _BoundedFile(_original_open(_map(p), *args, **kwargs))\n`;
  return execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', harness + spec.args[index + 1]!], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

/** Only the serial process boundary is replaced; generated board Python runs on fixtures. */
class FilesystemRunner implements ProcessRunner {
  readonly calls: CommandSpec[] = [];
  transfer?: (source: string, destination: string) => Promise<void>;
  constructor(readonly root: string) {}
  host(remote: string): string {
    if (!remote.startsWith('/device/')) throw new Error(`Unsafe test device path: ${remote}`);
    return path.join(this.root, remote.slice('/device/'.length));
  }
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    if (spec.args.includes('exec')) return { stdout: executeCode(spec, this.root), stderr: '' };
    const cp = spec.args.indexOf('cp');
    expect(cp).toBeGreaterThan(-1);
    const source = spec.args[cp + 1]!;
    const destination = spec.args[cp + 2]!;
    if (this.transfer) await this.transfer(source, destination);
    else writeFileSync(destination.startsWith(':') ? this.host(destination.slice(1)) : destination,
      readFileSync(source.startsWith(':') ? this.host(source.slice(1)) : source));
    return { stdout: '', stderr: '' };
  }
}
function filesystem() {
  const root = scratch();
  const runner = new FilesystemRunner(root);
  const output: string[] = [];
  return { root, runner, output, transport: new MpremoteTransport(runner, () => defaults,
    async () => ({ closed: Promise.resolve(), close: async () => {}, show: () => {} }), text => output.push(text)) };
}

describe('passive console transport', () => {
  it('passes the selected USB identity and cancellation to the passive launcher without any raw REPL command', async () => {
    const runner = new RecordingRunner();
    const session = { closed: Promise.resolve(), close: async () => {}, show: () => {} };
    const launch = vi.fn(async () => session);
    const controller = new AbortController();
    const transport = new MpremoteTransport(runner, () => defaults, async () => session, undefined, launch, () => true);
    const port = { ...board, serialNumber: 'stable-board-id' };
    expect(transport.canOpenConsole()).toBe(true);
    expect(await transport.openConsole(port, controller.signal)).toBe(session);
    expect(launch).toHaveBeenCalledWith(port, controller.signal);
    expect(runner.calls).toEqual([]);
  });

  it('reports missing managed console support without invoking custom mpremote', async () => {
    const { transport, runner } = setup();
    expect(transport.canOpenConsole()).toBe(false);
    await expect(transport.openConsole(board)).rejects.toThrow(/Set Up Tools/);
    expect(runner.calls).toEqual([]);
  });
});

describe('editable binary filesystem', () => {
  it('binds every upload stage and commit to the USB identity instead of a reusable serial path', async () => {
    const { root, runner, transport } = filesystem();
    const identified = { ...board, serialNumber: 'board-42' };
    await transport.writeFileBytes(identified, '/device/main.py', Buffer.from('new'), { create: true, overwrite: true });
    expect(readFileSync(path.join(root, 'main.py'), 'utf8')).toBe('new');
    expect(runner.calls.length).toBeGreaterThanOrEqual(3);
    expect(runner.calls.every(call => call.args[0] === 'connect' && call.args[1] === 'id:board-42')).toBe(true);
    await transport.readFileBytes(identified, '/device/main.py');
    expect(runner.calls.every(call => call.args[1] === 'id:board-42')).toBe(true);
  });
  it('stats normalized files and reports a typed missing-file error', async () => {
    const { root, transport } = filesystem();
    writeFileSync(path.join(root, 'data.bin'), Buffer.from([0, 255, 128]));
    expect(await transport.statFile(board, '/device//./data.bin')).toMatchObject({ isDirectory: false, size: 3 });
    const stat = await transport.statFile(board, '/device');
    expect(stat.isDirectory).toBe(true);
    expect(stat.mtime).toBeGreaterThan(1_000_000_000_000);
    await expect(transport.statFile(board, '/device/absent')).rejects.toMatchObject({ code: 'FileNotFound' });
  });
  it('round-trips binary bytes beyond the text preview limit through private temporary files', async () => {
    const { root, runner, transport } = filesystem();
    const content = Uint8Array.from({ length: 1024 * 1024 + 5 }, (_, index) => index % 256);
    const expected = Buffer.from(content);
    await transport.writeFileBytes(board, '/device/data.bin', content, { create: true, overwrite: false });
    // Compare every byte without walking a million indexed object properties.
    expect(readFileSync(path.join(root, 'data.bin')).equals(expected)).toBe(true);
    expect(Buffer.from(await transport.readFileBytes(board, '/device/data.bin')).equals(expected)).toBe(true);
    for (const spec of runner.calls.filter(call => call.args.includes('cp'))) {
      const local = spec.args.find(arg => path.isAbsolute(arg) && arg !== board.path)!;
      expect(existsSync(local)).toBe(false);
    }
  });
  it('enforces create and overwrite without changing existing bytes on refusal', async () => {
    const { root, transport } = filesystem();
    const file = path.join(root, 'main.py');
    writeFileSync(file, 'original');
    await expect(transport.writeFileBytes(board, '/device/main.py', Buffer.from('replacement'), { create: true, overwrite: false }))
      .rejects.toMatchObject({ code: 'FileExists' });
    await expect(transport.writeFileBytes(board, '/device/new.py', Buffer.from('new'), { create: false, overwrite: true }))
      .rejects.toMatchObject({ code: 'FileNotFound' });
    expect(readFileSync(file, 'utf8')).toBe('original');
    await transport.writeFileBytes(board, '/device/main.py', Buffer.from('replacement'), { create: false, overwrite: true });
    expect(readFileSync(file, 'utf8')).toBe('replacement');
  });
  it('preserves the destination and removes staging bytes after a failed upload', async () => {
    const { root, runner, transport } = filesystem();
    writeFileSync(path.join(root, 'main.py'), 'original');
    let local = '';
    let staged = '';
    runner.transfer = async (source, destination) => {
      local = source;
      staged = runner.host(destination.slice(1));
      writeFileSync(staged, 'partial');
      throw new Error('transfer failed');
    };
    await expect(transport.writeFileBytes(board, '/device/main.py', Buffer.from('new'), { create: true, overwrite: true }))
      .rejects.toThrow('transfer failed');
    expect(readFileSync(path.join(root, 'main.py'), 'utf8')).toBe('original');
    expect(existsSync(local)).toBe(false);
    expect(existsSync(staged)).toBe(false);
  });
  it('rechecks overwrite before committing a staged upload', async () => {
    const { root, runner, transport } = filesystem();
    runner.transfer = async (source, destination) => {
      writeFileSync(runner.host(destination.slice(1)), readFileSync(source));
      writeFileSync(path.join(root, 'main.py'), 'created during transfer');
    };
    await expect(transport.writeFileBytes(board, '/device/main.py', Buffer.from('new'), { create: true, overwrite: false }))
      .rejects.toMatchObject({ code: 'FileExists' });
    expect(readFileSync(path.join(root, 'main.py'), 'utf8')).toBe('created during transfer');
  });
  it('keeps host temporary data until the transfer closes and reports staged data on cancellation', async () => {
    const { root, runner, transport, output } = filesystem();
    writeFileSync(path.join(root, 'main.py'), 'original');
    let local = '';
    let finish: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const settled = new Promise<void>(resolve => { finish = resolve; });
    runner.transfer = async (source, destination) => {
      local = source;
      writeFileSync(runner.host(destination.slice(1)), 'partial');
      entered();
      await settled;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
    const abort = new AbortController();
    const pending = transport.writeFileBytes(board, '/device/main.py', Buffer.from('new'), { create: true, overwrite: true }, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    abort.abort();
    expect(existsSync(local)).toBe(true);
    finish();
    await rejected;
    expect(existsSync(local)).toBe(false);
    expect(readFileSync(path.join(root, 'main.py'), 'utf8')).toBe('original');
    expect(output.join('')).toMatch(/\.micropal.*(?:tmp|upload)/i);
  });
  it('creates nested directories idempotently and rejects a file in the parent path', async () => {
    const { root, transport } = filesystem();
    await transport.createDirectory(board, "/device/quotes ' and spaces/nested");
    await transport.createDirectory(board, "/device/quotes ' and spaces/nested");
    expect(existsSync(path.join(root, "quotes ' and spaces", 'nested'))).toBe(true);
    writeFileSync(path.join(root, 'file'), 'data');
    await expect(transport.createDirectory(board, '/device/file/nested')).rejects.toMatchObject({ code: 'FileNotADirectory' });
  });
  it('deletes files and recursively deletes directories only when requested', async () => {
    const { root, transport } = filesystem();
    mkdirSync(path.join(root, 'folder', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'folder', 'nested', 'main.py'), 'data');
    await expect(transport.deleteFile(board, '/device/folder', { recursive: false })).rejects.toThrow(/empty/i);
    expect(existsSync(path.join(root, 'folder', 'nested', 'main.py'))).toBe(true);
    await transport.deleteFile(board, '/device/folder', { recursive: true });
    expect(existsSync(path.join(root, 'folder'))).toBe(false);
    await expect(transport.deleteFile(board, '/device/folder', { recursive: true })).rejects.toMatchObject({ code: 'FileNotFound' });
  });
  it('renames files with overwrite policy and moves folders', async () => {
    const { root, transport } = filesystem();
    writeFileSync(path.join(root, 'old.py'), 'old');
    writeFileSync(path.join(root, 'new.py'), 'new');
    await expect(transport.renameFile(board, '/device/old.py', '/device/new.py', { overwrite: false }))
      .rejects.toMatchObject({ code: 'FileExists' });
    expect(readFileSync(path.join(root, 'old.py'), 'utf8')).toBe('old');
    await transport.renameFile(board, '/device/old.py', '/device/new.py', { overwrite: true });
    expect(readFileSync(path.join(root, 'new.py'), 'utf8')).toBe('old');
    expect(existsSync(path.join(root, 'old.py'))).toBe(false);
    mkdirSync(path.join(root, 'folder'));
    await transport.renameFile(board, '/device/folder', '/device/moved', { overwrite: false });
    expect((await transport.statFile(board, '/device/moved')).isDirectory).toBe(true);
  });
  it('refuses root mutation, parent traversal, and moving a directory into itself before executing', async () => {
    const { runner, transport } = filesystem();
    await expect(transport.writeFileBytes(board, '/', Buffer.from('x'), { create: true, overwrite: true })).rejects.toThrow(/root/i);
    await expect(transport.deleteFile(board, '/', { recursive: true })).rejects.toThrow(/root/i);
    await expect(transport.renameFile(board, '/', '/device/x', { overwrite: false })).rejects.toThrow(/root/i);
    await expect(transport.renameFile(board, '/device/dir', '/device/dir/nested', { overwrite: false })).rejects.toThrow(/itself/i);
    await expect(transport.createDirectory(board, '/device/../elsewhere')).rejects.toThrow(/traversal/i);
    expect(runner.calls).toHaveLength(0);
  });
  it('rejects directories for binary reads and writes with typed errors', async () => {
    const { root, transport } = filesystem();
    mkdirSync(path.join(root, 'folder'));
    await expect(transport.readFileBytes(board, '/device/folder')).rejects.toMatchObject({ code: 'FileIsADirectory' });
    await expect(transport.writeFileBytes(board, '/device/folder', Buffer.from('x'), { create: true, overwrite: true }))
      .rejects.toMatchObject({ code: 'FileIsADirectory' });
  });
  it('returns typed errors when listing a missing path or listing a file', async () => {
    const { root, transport } = filesystem();
    writeFileSync(path.join(root, 'main.py'), 'data');
    await expect(transport.listFiles(board, '/device/missing')).rejects.toMatchObject({ code: 'FileNotFound' });
    await expect(transport.listFiles(board, '/device/main.py')).rejects.toMatchObject({ code: 'FileNotADirectory' });
  });
  it.each([[2, 'FileNotFound'], [17, 'FileExists'], [20, 'FileNotADirectory'], [21, 'FileIsADirectory'], [13, 'NoPermissions'], [1, 'NoPermissions'], [28, 'Unavailable']])
    ('maps structured errno %i to %s without relying on stderr', async (errno, code) => {
      const { runner, transport } = setup();
      runner.result = { stdout: envelope({ ok: false, errno, message: 'board filesystem failed' }), stderr: 'FileNotFoundError misleading text' };
      await expect(transport.statFile(board, '/main.py')).rejects.toMatchObject({ code, message: expect.stringContaining('board filesystem failed') });
    });
});

describe('serial discovery', () => {
  it('preserves identifiers and descriptions across macOS, Linux, and Windows, preferring the macOS callout port', () => {
    expect(parsePorts([
      '/dev/tty.usbmodem123 ABC 303A:1001 Espressif USB JTAG/serial debug unit',
      '/dev/cu.usbmodem123 ABC 303a:1001 Espressif USB JTAG/serial debug unit',
      '/dev/ttyUSB0 None 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller',
      'COM12 XYZ 1a86:7523 QinHeng USB Serial',
      'COM14 FT42 0403:6001 FTDI FT232R USB UART',
      '/dev/ttyS0 None 0000:0000 None None',
      'COM7 None None:None Generic ESP32-S3 port',
      'COM8 None 2341:0043 Arduino Uno',
      'unrelated diagnostic output'
    ].join('\r\n'))).toEqual([
      { path: '/dev/cu.usbmodem123', serialNumber: 'ABC', vendorId: '303a', productId: '1001', description: 'Espressif USB JTAG/serial debug unit', likelyEsp32: true },
      { path: '/dev/ttyUSB0', vendorId: '10c4', productId: 'ea60', description: 'Silicon Labs CP2102 USB to UART Bridge Controller', likelyEsp32: true },
      { path: 'COM12', serialNumber: 'XYZ', vendorId: '1a86', productId: '7523', description: 'QinHeng USB Serial', likelyEsp32: true },
      { path: 'COM14', serialNumber: 'FT42', vendorId: '0403', productId: '6001', description: 'FTDI FT232R USB UART', likelyEsp32: true },
      { path: '/dev/ttyS0', description: '/dev/ttyS0', likelyEsp32: false },
      { path: 'COM7', description: 'Generic ESP32-S3 port', likelyEsp32: true },
      { path: 'COM8', vendorId: '2341', productId: '0043', description: 'Arduino Uno', likelyEsp32: false }
    ]);
  });
  it('lists ports without opening a selected board and uses a bounded command', async () => {
    const { runner, transport } = setup();
    runner.result.stdout = 'COM3 42 303a:1001 Espressif ESP32';
    const abort = new AbortController();
    expect((await transport.discover(abort.signal))[0]?.path).toBe('COM3');
    expect(runner.calls[0]?.spec.args).toEqual(['connect', 'list']);
    expect(runner.calls[0]?.options?.signal).toBe(abort.signal);
    expect(runner.calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
  });
});

describe('command construction', () => {
  it('uses an identified board selector for commands and REPL, retaining explicit ports for anonymous boards', async () => {
    const { runner, transport, launches } = setup();
    await transport.probe({ ...board, serialNumber: '--help + quotes \' valid' });
    await transport.openRepl({ ...board, serialNumber: 'board-42' });
    await transport.probe(board);
    expect(runner.calls[0]?.spec.args.slice(0, 2)).toEqual(['connect', "id:--help + quotes ' valid"]);
    expect(launches[0]?.args.slice(0, 2)).toEqual(['connect', 'id:board-42']);
    expect(runner.calls[1]?.spec.args.slice(0, 2)).toEqual(['connect', board.path]);
  });
  it.each(['', '   ', 'bad\0serial', 'bad\nserial', 'bad\rserial'])('refuses invalid known USB identity %j before opening a serial path', async serialNumber => {
    const { runner, transport, launches } = setup();
    await expect(transport.probe({ ...board, serialNumber })).rejects.toThrow(/serial|identity/i);
    await expect(transport.openRepl({ ...board, serialNumber })).rejects.toThrow(/serial|identity/i);
    expect(runner.calls).toHaveLength(0); expect(launches).toHaveLength(0);
  });
  it('runs an absolute file through a streaming process with explicit reset and no CLI baud option', async () => {
    const { runner, transport, output } = setup();
    const abort = new AbortController();
    await transport.runFile(board, "/project with spaces/a'\"$(touch nope).py", abort.signal);
    const call = runner.calls[0]!;
    expect(call.spec).toEqual({ executable: '/tools with spaces/mpremote', args: ['connect', '/dev/cu.usbmodem123', 'soft-reset', 'run', "/project with spaces/a'\"$(touch nope).py"] });
    expect(call.options?.timeoutMs).toBe(0);
    expect(call.options?.signal).toBe(abort.signal);
    call.options?.onOutput?.('hello\n');
    expect(output).toEqual(['hello\n']);
  });
  it('preserves heap state during probes and stop and uses explicit soft reset', async () => {
    const { runner, transport } = setup();
    await transport.probe(board);
    await transport.stop(board);
    await transport.softReset(board);
    expect(runner.calls.map(call => call.spec.args)).toEqual([
      ['connect', board.path, 'resume', 'exec', 'pass'],
      ['connect', board.path, 'resume', 'exec', 'pass'],
      ['connect', board.path, 'soft-reset']
    ]);
    expect(runner.calls.every(call => (call.options?.timeoutMs ?? 0) > 0)).toBe(true);
  });
  it('streams Stop and Soft Reset output while the passive console is paused', async () => {
    const { runner, transport, output } = setup();
    await transport.stop(board); await transport.softReset(board);
    runner.calls[0]!.options?.onOutput?.('stopped\n');
    runner.calls[1]!.options?.onOutput?.('MPY: soft reboot\n');
    expect(output).toEqual(['stopped\n', 'MPY: soft reboot\n']);
  });
  it('launches REPL in the supplied real-terminal launcher', async () => {
    const { transport, runner, launches, session } = setup();
    expect(await transport.openRepl(board)).toBe(session);
    expect(launches).toEqual([{ executable: defaults.mpremotePath, args: ['connect', board.path, 'repl'] }]);
    expect(runner.calls).toHaveLength(0);
  });
  it.each([['', 115200, /mpremote/i], ['mpremote', 9600, /115200/], ['bad\0path', 115200, /mpremote/i]])('rejects invalid executable or unsupported baud before launching', async (executable, baud, error) => {
    const { transport, runner, launches } = setup({ ...defaults, mpremotePath: executable as string, baudRate: baud as number });
    await expect(transport.probe(board)).rejects.toThrow(error as RegExp);
    await expect(transport.openRepl(board)).rejects.toThrow(error as RegExp);
    expect(runner.calls).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });
  it('resolves relative local paths so macro names cannot become commands', async () => {
    const { runner, transport } = setup();
    await transport.runFile(board, 'repl');
    expect(runner.calls[0]?.spec.args.at(-1)).toBe(path.resolve('repl'));
  });
  it('propagates process errors unchanged', async () => {
    const { runner, transport } = setup();
    runner.error = new Error('serial device disappeared');
    await expect(transport.probe(board)).rejects.toBe(runner.error);
  });
});

describe('remote filesystem', () => {
  it('normalizes POSIX paths while rejecting traversal and NUL bytes', () => {
    expect(normalizeRemotePath('lib//./drivers/')).toBe('/lib/drivers');
    expect(normalizeRemotePath('')).toBe('/');
    for (const invalid of ['../boot.py', '/lib/../boot.py', '/file\0name']) expect(() => normalizeRemotePath(invalid)).toThrow();
  });
  it('creates all missing parent directories with safe literals before uploading', async () => {
    const { runner, transport } = setup();
    const dir = scratch();
    const destination = "/device/folder ' with quotes/nested/hello.py";
    await transport.uploadFile(board, '/project dir/hello.py', destination);
    expect(runner.calls).toHaveLength(2);
    executeCode(runner.calls[0]!.spec, dir);
    executeCode(runner.calls[0]!.spec, dir); // Existing directories are allowed.
    expect(runner.calls[0]?.spec.args.slice(0, 4)).toEqual(['connect', board.path, 'resume', 'exec']);
    expect(runner.calls[1]?.spec.args).toEqual(['connect', board.path, 'resume', 'fs', 'cp', '/project dir/hello.py', `:${destination}`]);
    const hostDestination = path.join(dir, "folder ' with quotes", 'nested', 'hello.py');
    writeFileSync(hostDestination, 'created');
    expect(readFileSync(hostDestination, 'utf8')).toBe('created');
  });
  it('does not upload if creating a parent fails', async () => {
    const { runner, transport } = setup();
    runner.error = new Error('not a directory');
    await expect(transport.uploadFile(board, '/src/main.py', '/lib/module.py')).rejects.toThrow('not a directory');
    expect(runner.calls).toHaveLength(1);
  });
  it('lists actual filenames safely and returns normalized child paths', async () => {
    const { runner, transport } = setup();
    const dir = scratch();
    mkdirSync(path.join(dir, 'drivers'));
    writeFileSync(path.join(dir, "café '.py"), 'hi');
    runner.result.stdout = envelope([]);
    await transport.listFiles(board, '/device');
    runner.result.stdout = executeCode(runner.calls[0]!.spec, dir);
    const files = await transport.listFiles(board, '/device');
    expect(files).toEqual([
      { name: 'drivers', path: '/device/drivers', isDirectory: true, size: 0 },
      { name: "café '.py", path: "/device/café '.py", isDirectory: false, size: 2 }
    ]);
  });
  it.each([
    { entries: [{ name: '..', isDirectory: true, size: 0 }] },
    { entries: [{ name: '../main.py', isDirectory: false, size: 1 }] },
    { entries: [{ name: 'a/b', isDirectory: false, size: 1 }] },
    { entries: [{ name: 'x', isDirectory: 'yes', size: 1 }] },
    { entries: [{ name: 'x', isDirectory: false, size: -1 }] },
    { entries: [{ name: 'x', isDirectory: false, size: 1 }, { name: 'x', isDirectory: false, size: 1 }] },
    { entries: { error: 'not a listing' } }
  ])('rejects malformed filesystem entries', async ({ entries }) => {
    const { runner, transport } = setup();
    runner.result.stdout = envelope(entries);
    await expect(transport.listFiles(board, '/')).rejects.toThrow(/invalid|malformed/i);
  });
  it('reads UTF-8 with JSON framing and rejects binary or files larger than 1 MiB', async () => {
    const { runner, transport } = setup();
    const dir = scratch();
    const remote = "/device/quote ' file.py";
    const hostPath = path.join(dir, "quote ' file.py");
    const content = 'a'.repeat(511) + `éllo\n${begin}\n"world"\n`;
    writeFileSync(hostPath, content);
    runner.result.stdout = envelope({ hex: '', tooLarge: false });
    await transport.readFile(board, remote);
    const readSpec = runner.calls[0]!.spec;
    runner.result.stdout = executeCode(readSpec, dir);
    expect(await transport.readFile(board, remote)).toBe(content);
    writeFileSync(hostPath, Buffer.from([0xff, 0x00]));
    runner.result.stdout = executeCode(readSpec, dir);
    await expect(transport.readFile(board, remote)).rejects.toThrow(/binary|UTF-8/i);
    writeFileSync(hostPath, Buffer.from([65, 0, 66]));
    runner.result.stdout = executeCode(readSpec, dir);
    await expect(transport.readFile(board, remote)).rejects.toThrow(/binary|UTF-8/i);
    writeFileSync(hostPath, Buffer.alloc(1024 * 1024 + 1, 65));
    runner.result.stdout = executeCode(readSpec, dir);
    await expect(transport.readFile(board, remote)).rejects.toThrow(/1 MiB|too large/i);
  });
  it('rejects option-like port selectors rather than reporting a successful help command', async () => {
    const { runner, transport } = setup();
    await expect(transport.probe({ ...board, path: '--help' })).rejects.toThrow(/port/i);
    expect(runner.calls).toHaveLength(0);
  });
  it.each([
    { response: [] },
    { response: { hex: 'f', tooLarge: false } },
    { response: { hex: 'xx', tooLarge: false } },
    { response: { hex: '', tooLarge: 'false' } }
  ])('rejects malformed preview payloads', async ({ response }) => {
    const { runner, transport } = setup();
    runner.result.stdout = envelope(response);
    await expect(transport.readFile(board, '/main.py')).rejects.toThrow(/invalid/i);
  });
  it('downloads an explicit remote path to an absolute local path without interpreting quotes', async () => {
    const { runner, transport } = setup();
    await transport.downloadFile(board, "/a'\".py", '/downloads with spaces/main.py');
    expect(runner.calls[0]?.spec.args).toEqual(['connect', board.path, 'resume', 'fs', 'cp', ":/a'\".py", '/downloads with spaces/main.py']);
  });
});

describe('structured output framing', () => {
  it('ignores boot noise outside a single complete JSON envelope', () => {
    expect(parseStructuredOutput(`boot output\n${envelope({ text: 'hi' })}>>> `)).toEqual({ text: 'hi' });
  });
  it.each(['[]', `${begin}\n[]`, `${end}\n[]\n${begin}`, `${begin}\nnot JSON\n${end}`, `${envelope([])}${envelope([])}`])('rejects missing, truncated, invalid, or ambiguous output', value => {
    expect(() => parseStructuredOutput(value)).toThrow(/response|JSON|output/i);
  });
});
