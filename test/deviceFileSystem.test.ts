import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, DeviceFile, DeviceFileStat, DeviceWriteOptions } from '../src/core/types';

const api = vi.hoisted(() => {
  class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
    static from(value: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }) {
      return new Uri(value.scheme, value.authority ?? '', value.path ?? '', value.query, value.fragment);
    }
    with(value: Partial<Uri>) {
      return new Uri(value.scheme ?? this.scheme, value.authority ?? this.authority, value.path ?? this.path,
        value.query ?? this.query, value.fragment ?? this.fragment);
    }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`; }
  }
  class EventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  class FileSystemError extends Error {
    constructor(readonly code: string, message: string | Uri = code) { super(String(message)); this.name = code; }
    static FileNotFound(message?: string | Uri) { return new FileSystemError('FileNotFound', message); }
    static FileExists(message?: string | Uri) { return new FileSystemError('FileExists', message); }
    static FileNotADirectory(message?: string | Uri) { return new FileSystemError('FileNotADirectory', message); }
    static FileIsADirectory(message?: string | Uri) { return new FileSystemError('FileIsADirectory', message); }
    static NoPermissions(message?: string | Uri) { return new FileSystemError('NoPermissions', message); }
    static Unavailable(message?: string | Uri) { return new FileSystemError('Unavailable', message); }
  }
  return { Uri, EventEmitter, FileSystemError, FileType: { File: 1, Directory: 2 }, FileChangeType: { Changed: 1, Created: 2, Deleted: 3 }, workspace: { isTrusted: true } };
});
vi.mock('vscode', () => api);

type Entry = { directory: boolean; data: Uint8Array; mtime: number };
function backendError(code: string, message = code): Error { return Object.assign(new Error(message), { code }); }

/** The serial boundary is replaced by a byte-preserving filesystem, not a mocked provider. */
class MemoryDevice {
  fileSystemSession: string | undefined = 'board-a';
  state: ConnectionState = { phase: 'connected' };
  readonly entries = new Map<string, Entry>([
    ['/', { directory: true, data: new Uint8Array(), mtime: 100 }],
    ['/main.py', { directory: false, data: new Uint8Array([0, 255, 13, 10, 128]), mtime: 100 }],
    ['/lib', { directory: true, data: new Uint8Array(), mtime: 100 }],
    ['/lib/module.py', { directory: false, data: new TextEncoder().encode('value = 1'), mtime: 100 }],
  ]);
  failure?: Error;
  writes: DeviceWriteOptions[] = [];
  private begin(expected?: string): void {
    if (expected !== this.fileSystemSession) throw backendError('Unavailable', 'Connection changed');
    if (this.failure) throw this.failure;
  }
  private entry(path: string): Entry {
    const entry = this.entries.get(path);
    if (!entry) throw backendError('FileNotFound', `Missing ${path}`);
    return entry;
  }
  async statFile(path: string, expected?: string): Promise<DeviceFileStat> {
    this.begin(expected); const entry = this.entry(path);
    return { isDirectory: entry.directory, size: entry.data.length, mtime: entry.mtime };
  }
  async listFiles(path: string, expected?: string): Promise<DeviceFile[]> {
    this.begin(expected);
    if (!this.entry(path).directory) throw backendError('FileNotADirectory');
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.entries].filter(([candidate]) => candidate.startsWith(prefix) && candidate !== path && !candidate.slice(prefix.length).includes('/'))
      .map(([candidate, entry]) => ({ path: candidate, name: candidate.slice(prefix.length), isDirectory: entry.directory, size: entry.data.length }));
  }
  async readFileBytes(path: string, expected?: string): Promise<Uint8Array> {
    this.begin(expected); const entry = this.entry(path);
    if (entry.directory) throw backendError('FileIsADirectory');
    return entry.data;
  }
  async writeFileBytes(path: string, data: Uint8Array, options: DeviceWriteOptions, expected?: string): Promise<void> {
    this.begin(expected); this.writes.push({ ...options });
    const existing = this.entries.get(path);
    if (existing?.directory) throw backendError('FileIsADirectory');
    if (!existing && !options.create) throw backendError('FileNotFound');
    if (existing && !options.overwrite) throw backendError('FileExists');
    this.entries.set(path, { directory: false, data: data.slice(), mtime: 100 });
  }
  async createDirectory(path: string, expected?: string): Promise<void> {
    this.begin(expected);
    const entry = this.entries.get(path);
    if (entry && !entry.directory) throw backendError('FileExists');
    let prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      prefix += `/${part}`;
      this.entries.set(prefix, { directory: true, data: new Uint8Array(), mtime: 100 });
    }
  }
  async deleteFile(path: string, options: { recursive: boolean }, expected?: string): Promise<void> {
    this.begin(expected); this.entry(path);
    const children = [...this.entries.keys()].filter(candidate => candidate.startsWith(`${path}/`));
    if (children.length && !options.recursive) throw backendError('NoPermissions', 'Directory is not empty');
    for (const child of children) this.entries.delete(child);
    this.entries.delete(path);
  }
  async renameFile(oldPath: string, newPath: string, options: { overwrite: boolean }, expected?: string): Promise<void> {
    this.begin(expected); this.entry(oldPath);
    if (this.entries.has(newPath) && !options.overwrite) throw backendError('FileExists');
    const moved = [...this.entries].filter(([candidate]) => candidate === oldPath || candidate.startsWith(`${oldPath}/`));
    for (const [candidate, entry] of moved) {
      this.entries.delete(candidate); this.entries.set(`${newPath}${candidate.slice(oldPath.length)}`, entry);
    }
  }
}

async function fixture() {
  const { DeviceFileSystem } = await import('../src/ui/deviceFileSystem');
  const device = new MemoryDevice();
  const fs = new DeviceFileSystem(device);
  const events: { type: number; path: string; authority: string }[][] = [];
  fs.onDidChangeFile(changes => events.push(changes.map(change => ({ type: change.type, path: change.uri.path, authority: change.uri.authority }))));
  return { device, fs, events, uri: (path = '/') => fs.toUri(path) };
}

beforeEach(() => { api.workspace.isTrusted = true; vi.restoreAllMocks(); });

describe('native device filesystem', () => {
  it('reads binary content without decoding or exposing the backend buffer', async () => {
    const { fs, uri } = await fixture();
    const bytes = await fs.readFile(uri('/main.py'));
    expect([...bytes]).toEqual([0, 255, 13, 10, 128]);
    bytes[0] = 42;
    expect([...(await fs.readFile(uri('/main.py')))]).toEqual([0, 255, 13, 10, 128]);
    expect(await fs.stat(uri('/main.py'))).toEqual({ type: 1, ctime: 0, mtime: 100, size: 5 });
    expect(await fs.readDirectory(uri())).toEqual([['main.py', 1], ['lib', 2]]);
  });

  it('copies Node Buffer results instead of returning a shared slice', async () => {
    const { fs, uri, device } = await fixture();
    const buffer = Buffer.from([0, 255, 128]);
    device.readFileBytes = async () => buffer;
    const bytes = await fs.readFile(uri('/main.py'));
    bytes[0] = 42;
    expect([...buffer]).toEqual([0, 255, 128]);
  });

  it('captures a caller-owned Buffer before awaiting the device', async () => {
    const { fs, uri, device } = await fixture();
    let resolve!: (stat: DeviceFileStat) => void;
    device.statFile = () => new Promise(done => { resolve = done; });
    const buffer = Buffer.from([0, 255, 128]);
    const saving = fs.writeFile(uri('/main.py'), buffer, { create: false, overwrite: true });
    buffer[0] = 42;
    resolve({ isDirectory: false, size: 5, mtime: 100 });
    await saving;
    expect([...device.entries.get('/main.py')!.data]).toEqual([0, 255, 128]);
  });

  it('saves edits and advances mtimes even when the board RTC does not change', async () => {
    const { fs, uri, device, events } = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    await fs.writeFile(uri('/main.py'), new Uint8Array([0, 128, 255]), { create: false, overwrite: true });
    expect([...device.entries.get('/main.py')!.data]).toEqual([0, 128, 255]);
    expect(device.writes).toEqual([{ create: false, overwrite: true }]);
    expect((await fs.stat(uri('/main.py'))).mtime).toBe(5000);
    await fs.writeFile(uri('/main.py'), new Uint8Array([7]), { create: false, overwrite: true });
    expect((await fs.stat(uri('/main.py'))).mtime).toBe(5001);
    expect(events[0]).toEqual([{ type: 1, path: '/main.py', authority: 'board-a' }, { type: 1, path: '/', authority: 'board-a' }]);
  });

  it('creates files and directories with parent notifications while respecting create/overwrite flags', async () => {
    const { fs, uri, device, events } = await fixture();
    await expect(fs.writeFile(uri('/missing.py'), new Uint8Array([1]), { create: false, overwrite: true })).rejects.toMatchObject({ code: 'FileNotFound' });
    await expect(fs.writeFile(uri('/main.py'), new Uint8Array([1]), { create: true, overwrite: false })).rejects.toMatchObject({ code: 'FileExists' });
    expect(events).toEqual([]);
    await fs.writeFile(uri('/new.py'), new Uint8Array([0, 255]), { create: true, overwrite: false });
    await fs.createDirectory(uri('/assets'));
    expect(device.entries.get('/assets')?.directory).toBe(true);
    expect(events).toEqual([
      [{ type: 2, path: '/new.py', authority: 'board-a' }, { type: 1, path: '/', authority: 'board-a' }],
      [{ type: 2, path: '/assets', authority: 'board-a' }, { type: 1, path: '/', authority: 'board-a' }],
    ]);
    await fs.createDirectory(uri('/assets'));
    expect(events).toHaveLength(2);
  });

  it('renames a directory and recursively deletes it without leaving old paths', async () => {
    const { fs, uri, device, events } = await fixture();
    await fs.rename(uri('/lib'), uri('/modules'), { overwrite: false });
    expect(device.entries.has('/lib/module.py')).toBe(false);
    expect(new TextDecoder().decode(await fs.readFile(uri('/modules/module.py')))).toBe('value = 1');
    expect(events[0]).toEqual([
      { type: 3, path: '/lib', authority: 'board-a' }, { type: 2, path: '/modules', authority: 'board-a' }, { type: 1, path: '/', authority: 'board-a' },
    ]);
    await expect(fs.delete(uri('/modules'), { recursive: false })).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(device.entries.has('/modules')).toBe(true);
    await fs.delete(uri('/modules'), { recursive: true });
    expect(device.entries.has('/modules/module.py')).toBe(false);
    expect(events[1]).toEqual([{ type: 3, path: '/modules', authority: 'board-a' }, { type: 1, path: '/', authority: 'board-a' }]);
  });

  it('announces all newly created ancestors when creating a nested directory', async () => {
    const { fs, uri, device, events } = await fixture();
    await fs.createDirectory(uri('/pictures/icons'));
    expect(device.entries.get('/pictures')?.directory).toBe(true);
    expect(events[0]).toEqual([
      { type: 2, path: '/pictures', authority: 'board-a' },
      { type: 2, path: '/pictures/icons', authority: 'board-a' },
      { type: 1, path: '/', authority: 'board-a' },
    ]);
  });

  it('advances a renamed file timestamp beyond the unchanged board RTC and respects overwrite', async () => {
    const { fs, uri, device, events } = await fixture();
    device.entries.get('/main.py')!.mtime = 10000;
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    await expect(fs.rename(uri('/main.py'), uri('/lib/module.py'), { overwrite: false })).rejects.toMatchObject({ code: 'FileExists' });
    expect(events).toEqual([]);
    await fs.rename(uri('/main.py'), uri('/lib/module.py'), { overwrite: true });
    expect((await fs.stat(uri('/lib/module.py'))).mtime).toBeGreaterThan(10000);
    expect([...(await fs.readFile(uri('/lib/module.py')))]).toEqual([0, 255, 13, 10, 128]);
    expect(events[0]).toEqual([
      { type: 3, path: '/main.py', authority: 'board-a' }, { type: 1, path: '/lib/module.py', authority: 'board-a' },
      { type: 1, path: '/', authority: 'board-a' }, { type: 1, path: '/lib', authority: 'board-a' },
    ]);
  });

  it('does not modify files or emit success notifications when a write fails', async () => {
    const { fs, uri, device, events } = await fixture();
    device.writeFileBytes = async () => { throw backendError('NoPermissions', 'Read-only flash'); };
    await expect(fs.writeFile(uri('/main.py'), new Uint8Array([1]), { create: false, overwrite: true })).rejects.toMatchObject({ code: 'NoPermissions' });
    expect([...device.entries.get('/main.py')!.data]).toEqual([0, 255, 13, 10, 128]);
    expect(events).toEqual([]);
    expect((await fs.stat(uri('/main.py'))).mtime).toBe(100);
  });

  it.each(['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable'])(
    'preserves the backend %s error classification and message', async code => {
      const { fs, uri, device, events } = await fixture();
      device.failure = backendError(code, `Board says ${code}`);
      await expect(fs.readFile(uri('/main.py'))).rejects.toMatchObject({ code, message: `Board says ${code}` });
      expect(events).toEqual([]);
    },
  );

  it('preserves unexpected errors for diagnostics instead of pretending a directory is empty', async () => {
    const { fs, uri, device } = await fixture();
    const failure = new Error('Serial process crashed'); device.failure = failure;
    await expect(fs.readDirectory(uri())).rejects.toBe(failure);
  });

  it('rejects stale and offline resource URIs without modifying the next board', async () => {
    const { fs, uri, device, events } = await fixture();
    const old = uri('/main.py');
    device.fileSystemSession = 'board-b';
    await expect(fs.writeFile(old, new Uint8Array([99]), { create: false, overwrite: true })).rejects.toMatchObject({ code: 'Unavailable' });
    expect(device.writes).toEqual([]);
    expect([...device.entries.get('/main.py')!.data]).toEqual([0, 255, 13, 10, 128]);
    device.state = { phase: 'disconnected' };
    await expect(fs.readFile(uri('/main.py'))).rejects.toMatchObject({ code: 'Unavailable' });
    expect(events).toEqual([]);
  });

  it('rejects a resource when the connection changes while its read is awaiting serial completion', async () => {
    const { fs, uri, device } = await fixture();
    let resolve!: (data: Uint8Array) => void;
    device.readFileBytes = () => new Promise(done => { resolve = done; });
    const reading = fs.readFile(uri('/main.py'));
    device.fileSystemSession = 'board-b';
    resolve(new Uint8Array([42]));
    await expect(reading).rejects.toMatchObject({ code: 'Unavailable' });
  });

  it('rejects an old dirty save if the connection changes between checking existence and writing', async () => {
    const { fs, uri, device, events } = await fixture();
    let resolve!: (stat: DeviceFileStat) => void;
    device.statFile = () => new Promise(done => { resolve = done; });
    const saving = fs.writeFile(uri('/main.py'), new Uint8Array([42]), { create: false, overwrite: true });
    device.fileSystemSession = 'board-b';
    resolve({ isDirectory: false, size: 5, mtime: 100 });
    await expect(saving).rejects.toMatchObject({ code: 'Unavailable' });
    expect(device.writes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rechecks workspace trust before an awaited save can write to the board', async () => {
    const { fs, uri, device } = await fixture();
    let resolve!: (stat: DeviceFileStat) => void;
    device.statFile = () => new Promise(done => { resolve = done; });
    const saving = fs.writeFile(uri('/main.py'), new Uint8Array([42]), { create: false, overwrite: true });
    api.workspace.isTrusted = false;
    resolve({ isDirectory: false, size: 5, mtime: 100 });
    await expect(saving).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(device.writes).toEqual([]);
  });

  it('does not return an old save as successful after its session is closed', async () => {
    const { fs, uri, device, events } = await fixture();
    let resolve!: () => void;
    device.writeFileBytes = () => new Promise(done => { resolve = done; });
    const saving = fs.writeFile(uri('/main.py'), new Uint8Array([42]), { create: false, overwrite: true });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    device.fileSystemSession = 'board-b'; resolve();
    await expect(saving).rejects.toMatchObject({ code: 'Unavailable' });
    expect(events).toEqual([]);
  });

  it('blocks every filesystem operation when workspace trust is absent', async () => {
    const { fs, uri, device } = await fixture();
    const target = uri('/main.py'); api.workspace.isTrusted = false;
    const operations = [
      () => fs.stat(target), () => fs.readDirectory(target), () => fs.readFile(target),
      () => fs.writeFile(target, new Uint8Array([7]), { create: true, overwrite: true }),
      () => fs.createDirectory(target), () => fs.delete(target, { recursive: true }),
      () => fs.rename(target, target, { overwrite: true }),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(() => fs.watch(target, { recursive: false, excludes: [] })).toThrow(/trust/i);
    expect(device.writes).toEqual([]);
  });

  it('confines operations to valid paths in one session and protects the root', async () => {
    const { fs, uri, device } = await fixture();
    for (const change of [
      { scheme: 'file' }, { query: 'snapshot=1' }, { fragment: 'section' },
      { path: '/../main.py' }, { path: '/lib/../main.py' }, { path: '/lib/./module.py' },
      { path: '/lib\\module.py' }, { path: '/bad\0name' }, { path: 'main.py' },
    ]) await expect(fs.readFile(uri('/main.py').with(change))).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(fs.delete(uri(), { recursive: true })).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(fs.writeFile(uri(), new Uint8Array(), { create: true, overwrite: true })).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(fs.rename(uri(), uri('/new-root'), { overwrite: true })).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(fs.rename(uri('/lib'), uri('/main.py').with({ authority: 'board-b' }), { overwrite: true })).rejects.toMatchObject({ code: 'Unavailable' });
    expect(device.entries.has('/')).toBe(true);
  });

  it('watches without querying the board and refreshes only the active root', async () => {
    const { fs, uri, device, events } = await fixture();
    device.failure = new Error('No hardware may be queried');
    const watcher = fs.watch(uri(), { recursive: true, excludes: [] });
    watcher.dispose();
    fs.refresh();
    fs.notifyChanged('/lib/module.py');
    expect(events).toEqual([
      [{ type: 1, path: '/', authority: 'board-a' }],
      [{ type: 1, path: '/lib/module.py', authority: 'board-a' }, { type: 1, path: '/lib', authority: 'board-a' }],
    ]);
    fs.dispose(); fs.refresh();
    expect(events).toHaveLength(2);
  });

  it('refreshes known open files without polling and advances timestamps after external same-RTC changes', async () => {
    const { fs, uri, device, events } = await fixture();
    const before = await fs.stat(uri('/main.py'));
    await fs.readFile(uri('/main.py'));
    device.entries.get('/main.py')!.data = new Uint8Array([1, 2, 3, 4, 5]);
    device.failure = new Error('Refresh must not poll the board');
    fs.refresh();
    expect(events[0]).toEqual([
      { type: 1, path: '/', authority: 'board-a' },
      { type: 1, path: '/main.py', authority: 'board-a' },
    ]);
    device.failure = undefined;
    expect((await fs.stat(uri('/main.py'))).mtime).toBeGreaterThan(before.mtime);
    expect([...(await fs.readFile(uri('/main.py')))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not refresh an offline board or revive modification times from an earlier session', async () => {
    const { fs, uri, device, events } = await fixture();
    await fs.writeFile(uri('/main.py'), new Uint8Array([1]), { create: false, overwrite: true });
    device.state = { phase: 'disconnected' }; fs.refresh();
    expect(events).toHaveLength(1);
    device.state = { phase: 'connected' }; device.fileSystemSession = 'board-b';
    expect((await fs.stat(uri('/main.py'))).mtime).toBe(100);
  });
});

