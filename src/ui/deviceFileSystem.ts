import * as vscode from 'vscode';
import type { ConnectionState, DeviceFile, DeviceFileStat, DeviceWriteOptions } from '../core/types';

interface DeviceFileSystemBackend {
  readonly state: ConnectionState;
  readonly fileSystemSession: string | undefined;
  statFile(path: string, expectedSession?: string): Promise<DeviceFileStat>;
  listFiles(path: string, expectedSession?: string): Promise<DeviceFile[]>;
  readFileBytes(path: string, expectedSession?: string): Promise<Uint8Array>;
  writeFileBytes(path: string, data: Uint8Array, options: DeviceWriteOptions, expectedSession?: string): Promise<void>;
  createDirectory(path: string, expectedSession?: string): Promise<void>;
  deleteFile(path: string, options: { recursive: boolean }, expectedSession?: string): Promise<void>;
  renameFile(oldPath: string, newPath: string, options: { overwrite: boolean }, expectedSession?: string): Promise<void>;
}

type Resource = { path: string; session: string };
const offlinePhases = new Set(['disconnected', 'connecting', 'reconnecting', 'flashing', 'error']);

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

/** Native Explorer operations use the same serial queue as all other device commands. */
export class DeviceFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly mtimes = new Map<string, number>();
  private readonly seen = new Set<string>();
  private metadataSession?: string;
  private disposed = false;

  constructor(private readonly device: DeviceFileSystemBackend) {}

  toUri(remotePath = '/', session = this.device.fileSystemSession): vscode.Uri {
    if (!session || !/^[a-zA-Z0-9.-]+$/.test(session)) throw vscode.FileSystemError.Unavailable('Connect an ESP32 with MicroPal before opening its files.');
    return vscode.Uri.from({ scheme: 'micropal', authority: session, path: this.normalizePath(remotePath) });
  }

  watch(uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    this.resource(uri);
    // Polling the filesystem would interrupt main.py or compete for the serial port.
    return { dispose() {} };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.operate(uri, async resource => {
      const stat = await this.call(resource, () => this.device.statFile(resource.path, resource.session));
      const mtime = Math.max(stat.mtime, this.mtimes.get(resource.path) ?? 0);
      this.mtimes.set(resource.path, mtime);
      return { type: stat.isDirectory ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime, size: stat.size };
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.operate(uri, async resource => {
      const files = await this.call(resource, () => this.device.listFiles(resource.path, resource.session));
      return files.map(file => {
        if (!file.name || file.name === '.' || file.name === '..' || /[/\\\u0000-\u001f\u007f]/.test(file.name)) {
          throw vscode.FileSystemError.Unavailable('The device returned an invalid filename.');
        }
        return [file.name, file.isDirectory ? vscode.FileType.Directory : vscode.FileType.File];
      });
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.operate(uri, async resource => {
      const bytes = await this.call(resource, () => this.device.readFileBytes(resource.path, resource.session));
      return Uint8Array.from(bytes);
    });
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const bytes = Uint8Array.from(content);
    return this.operate(uri, async resource => {
      this.protectRoot(resource.path);
      const existing = await this.lookup(resource);
      if (existing?.isDirectory) throw vscode.FileSystemError.FileIsADirectory(uri);
      if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      await this.call(resource, () => this.device.writeFileBytes(resource.path, bytes, options, resource.session));
      this.touch(resource.path, existing?.mtime);
      this.touch(this.parent(resource.path));
      this.emit(resource.session, [
        [resource.path, existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created],
        [this.parent(resource.path), vscode.FileChangeType.Changed],
      ]);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    return this.operate(uri, async resource => {
      const missing: string[] = [];
      let ancestor = resource.path;
      while (true) {
        const existing = await this.lookup({ ...resource, path: ancestor });
        if (existing?.isDirectory) break;
        if (existing) {
          if (ancestor === resource.path) throw vscode.FileSystemError.FileExists(uri);
          throw vscode.FileSystemError.FileNotADirectory(this.toUri(ancestor, resource.session));
        }
        missing.unshift(ancestor);
        if (ancestor === '/') throw vscode.FileSystemError.Unavailable('The ESP32 filesystem root is unavailable.');
        ancestor = this.parent(ancestor);
      }
      if (!missing.length) return;
      await this.call(resource, () => this.device.createDirectory(resource.path, resource.session));
      for (const path of missing) this.touch(path);
      this.touch(ancestor);
      this.emit(resource.session, [
        ...missing.map((path): [string, vscode.FileChangeType] => [path, vscode.FileChangeType.Created]),
        [ancestor, vscode.FileChangeType.Changed],
      ]);
    });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    return this.operate(uri, async resource => {
      this.protectRoot(resource.path);
      await this.call(resource, () => this.device.deleteFile(resource.path, options, resource.session));
      this.forget(resource.path);
      this.touch(this.parent(resource.path));
      this.emit(resource.session, [[resource.path, vscode.FileChangeType.Deleted], [this.parent(resource.path), vscode.FileChangeType.Changed]]);
    });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this.operate(oldUri, async old => {
      const target = this.resource(newUri);
      this.protectRoot(old.path); this.protectRoot(target.path);
      if (old.path === target.path) return;
      if (target.path.startsWith(`${old.path}/`)) throw vscode.FileSystemError.NoPermissions('A directory cannot be moved into itself.');
      const oldStat = await this.lookup(old);
      if (!oldStat) throw vscode.FileSystemError.FileNotFound(oldUri);
      const targetStat = await this.lookup(target);
      if (targetStat && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
      await this.call(old, () => this.device.renameFile(old.path, target.path, options, old.session));
      const descendants = [...this.mtimes].filter(([path]) => path.startsWith(`${old.path}/`));
      this.forget(old.path); this.forget(target.path);
      for (const [path, mtime] of descendants) this.touch(`${target.path}${path.slice(old.path.length)}`, mtime);
      this.touch(target.path, Math.max(oldStat.mtime, targetStat?.mtime ?? 0));
      this.touch(this.parent(old.path)); this.touch(this.parent(target.path));
      this.emit(old.session, [
        [old.path, vscode.FileChangeType.Deleted], [target.path, targetStat ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created],
        [this.parent(old.path), vscode.FileChangeType.Changed], [this.parent(target.path), vscode.FileChangeType.Changed],
      ]);
    });
  }

  refresh(): void {
    const session = this.activeSession();
    if (!session) return;
    const paths = new Set(['/', ...this.seen]);
    for (const path of paths) this.touch(path);
    this.emit(session, [...paths].map(path => [path, vscode.FileChangeType.Changed]));
  }

  notifyChanged(remotePath: string): void {
    const session = this.activeSession();
    if (!session) return;
    const path = this.normalizePath(remotePath);
    this.touch(path); this.touch(this.parent(path));
    this.emit(session, [[path, vscode.FileChangeType.Changed], [this.parent(path), vscode.FileChangeType.Changed]]);
  }

  dispose(): void {
    this.disposed = true;
    this.mtimes.clear(); this.seen.clear();
    this.changes.dispose();
  }

  private async operate<T>(uri: vscode.Uri, action: (resource: Resource) => Promise<T>): Promise<T> {
    try { return await action(this.resource(uri)); }
    catch (error) { throw this.mapError(error); }
  }

  private async call<T>(resource: Resource, action: () => Promise<T>): Promise<T> {
    this.assertActive(resource.session);
    try {
      const result = await action();
      this.assertActive(resource.session);
      return result;
    } catch (error) {
      // Even a successful old read/save must never appear to belong to a new board.
      this.assertActive(resource.session);
      throw error;
    }
  }

  private async lookup(resource: Resource): Promise<DeviceFileStat | undefined> {
    try { return await this.call(resource, () => this.device.statFile(resource.path, resource.session)); }
    catch (error) { if (codeOf(error) === 'FileNotFound') return undefined; throw error; }
  }

  private resource(uri: vscode.Uri): Resource {
    if (uri.scheme !== 'micropal' || uri.query || uri.fragment) throw vscode.FileSystemError.NoPermissions('This is not a writable MicroPal device file URI.');
    const path = this.normalizePath(uri.path);
    this.assertActive(uri.authority);
    this.seen.add(path);
    return { path, session: uri.authority };
  }

  private assertActive(session: string): void {
    if (!vscode.workspace.isTrusted) throw vscode.FileSystemError.NoPermissions('Trust this workspace before accessing ESP32 files.');
    if (this.disposed || !session || session !== this.device.fileSystemSession || offlinePhases.has(this.device.state.phase)) {
      throw vscode.FileSystemError.Unavailable('This ESP32 file belongs to a disconnected session. Run MicroPal: Repair ESP32 Files, then reopen it from ESP32 Files. Copy any unsaved edits before closing the old file.');
    }
    this.useMetadataSession(session);
  }

  private activeSession(): string | undefined {
    if (this.disposed || !vscode.workspace.isTrusted || offlinePhases.has(this.device.state.phase)) return undefined;
    const session = this.device.fileSystemSession;
    if (session) this.useMetadataSession(session);
    return session;
  }

  private useMetadataSession(session: string): void {
    if (this.metadataSession === session) return;
    this.metadataSession = session; this.mtimes.clear(); this.seen.clear();
  }

  private normalizePath(path: string): string {
    if (!path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
      throw vscode.FileSystemError.NoPermissions('ESP32 paths must be absolute and cannot contain traversal or control characters.');
    }
    return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  private protectRoot(path: string): void {
    if (path === '/') throw vscode.FileSystemError.NoPermissions('The ESP32 filesystem root cannot be replaced, renamed, or deleted.');
  }

  private parent(path: string): string { return path.slice(0, path.lastIndexOf('/')) || '/'; }

  private touch(path: string, boardMtime = 0): void {
    const stamp = Math.max(Date.now(), boardMtime + 1, (this.mtimes.get(path) ?? 0) + 1);
    this.mtimes.set(path, stamp);
  }

  private forget(path: string): void {
    for (const candidate of this.mtimes.keys()) if (candidate === path || candidate.startsWith(`${path}/`)) this.mtimes.delete(candidate);
  }

  private emit(session: string, changes: [string, vscode.FileChangeType][]): void {
    if (this.activeSession() !== session) return;
    const batch = new Map<string, vscode.FileChangeEvent>();
    for (const [path, type] of changes) batch.set(path, { type, uri: this.toUri(path, session) });
    this.changes.fire([...batch.values()]);
  }

  private mapError(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    switch (codeOf(error)) {
      case 'FileNotFound': return vscode.FileSystemError.FileNotFound(message);
      case 'FileExists': return vscode.FileSystemError.FileExists(message);
      case 'FileNotADirectory': return vscode.FileSystemError.FileNotADirectory(message);
      case 'FileIsADirectory': return vscode.FileSystemError.FileIsADirectory(message);
      case 'NoPermissions': return vscode.FileSystemError.NoPermissions(message);
      case 'Unavailable': return vscode.FileSystemError.Unavailable(message);
      default:
        if (error instanceof Error && error.name === 'AbortError') return vscode.FileSystemError.Unavailable(message);
        return error;
    }
  }
}
