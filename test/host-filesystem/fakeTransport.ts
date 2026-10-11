import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';
import { DeviceFileSystemError } from '../../src/core/fileErrors';
import type { DeviceFile, DeviceFileStat, DevicePort, DeviceTransport, DeviceWriteOptions, InteractiveSession } from '../../src/core/types';

export const fakePort: DevicePort = { path: '/dev/micropal-fake-usb', serialNumber: 'MICROPAL-HOST-FIXTURE',
  vendorId: '303a', productId: '1001', likelyEsp32: true, description: 'Hardware-free ESP32 fixture' };

type Store = { files: Record<string, string | null>; discoveries: number; probes: number; present?: boolean };

/** Serial replacement only: all production manager/provider/explorer code remains real. */
export class FakeTransport implements DeviceTransport {
  private readonly store: Store;
  constructor(private readonly file: string) {
    this.store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Store : {
      files: { '/': null, '/boot.py': Buffer.from('# fake boot\n').toString('base64') }, discoveries: 0, probes: 0,
    };
    this.persist();
  }
  private persist(): void { writeFileSync(this.file, JSON.stringify(this.store)); }
  setPresent(present: boolean): void { this.store.present = present; this.persist(); }
  private entry(path: string): string | null {
    const entry = this.store.files[path];
    if (entry === undefined) throw new DeviceFileSystemError('FileNotFound', path);
    return entry;
  }
  private directory(path: string): void {
    if (this.entry(path) !== null) throw new DeviceFileSystemError('FileNotADirectory', path);
  }
  async discover(): Promise<DevicePort[]> {
    this.store.discoveries++; this.persist();
    return this.store.present === false ? [] : [{ ...fakePort }];
  }
  async probe(): Promise<void> { this.store.probes++; this.persist(); }
  async runFile(): Promise<void> { throw new Error('The filesystem host fixture never runs programs.'); }
  async stop(): Promise<void> {}
  async softReset(): Promise<void> {}
  async openRepl(): Promise<InteractiveSession> { throw new Error('The filesystem host fixture never opens a REPL.'); }
  async statFile(_port: DevicePort, path: string): Promise<DeviceFileStat> {
    const entry = this.entry(path);
    return { isDirectory: entry === null, size: entry === null ? 0 : Buffer.from(entry, 'base64').length, mtime: 1000 };
  }
  async listFiles(_port: DevicePort, path: string): Promise<DeviceFile[]> {
    this.directory(path);
    return Object.entries(this.store.files).filter(([key]) => key !== path && posix.dirname(key) === path)
      .map(([key, value]) => ({ name: posix.basename(key), path: key, isDirectory: value === null,
        size: value === null ? 0 : Buffer.from(value, 'base64').length }));
  }
  async readFileBytes(_port: DevicePort, path: string): Promise<Uint8Array> {
    const entry = this.entry(path);
    if (entry === null) throw new DeviceFileSystemError('FileIsADirectory', path);
    return Buffer.from(entry, 'base64');
  }
  async readFile(port: DevicePort, path: string): Promise<string> { return Buffer.from(await this.readFileBytes(port, path)).toString('utf8'); }
  async writeFileBytes(_port: DevicePort, path: string, bytes: Uint8Array, options: DeviceWriteOptions): Promise<void> {
    this.directory(posix.dirname(path));
    const existing = this.store.files[path];
    if (existing === null) throw new DeviceFileSystemError('FileIsADirectory', path);
    if (existing === undefined && !options.create) throw new DeviceFileSystemError('FileNotFound', path);
    if (existing !== undefined && !options.overwrite) throw new DeviceFileSystemError('FileExists', path);
    this.store.files[path] = Buffer.from(bytes).toString('base64'); this.persist();
  }
  async createDirectory(_port: DevicePort, path: string): Promise<void> {
    this.directory(posix.dirname(path));
    if (this.store.files[path] !== undefined) throw new DeviceFileSystemError('FileExists', path);
    this.store.files[path] = null; this.persist();
  }
  async deleteFile(_port: DevicePort, path: string, options: { recursive: boolean }): Promise<void> {
    this.entry(path);
    const children = Object.keys(this.store.files).filter(key => key.startsWith(path + '/'));
    if (children.length && !options.recursive) throw new DeviceFileSystemError('NoPermissions', 'Directory is not empty');
    for (const key of [path, ...children]) delete this.store.files[key];
    this.persist();
  }
  async renameFile(port: DevicePort, oldPath: string, newPath: string, options: { overwrite: boolean }): Promise<void> {
    this.entry(oldPath); this.directory(posix.dirname(newPath));
    if (this.store.files[newPath] !== undefined) {
      if (!options.overwrite) throw new DeviceFileSystemError('FileExists', newPath);
      await this.deleteFile(port, newPath, { recursive: true });
    }
    const moving = Object.entries(this.store.files).filter(([key]) => key === oldPath || key.startsWith(oldPath + '/'));
    for (const [key, value] of moving) { delete this.store.files[key]; this.store.files[newPath + key.slice(oldPath.length)] = value; }
    this.persist();
  }
  async uploadFile(port: DevicePort, local: string, remote: string): Promise<void> {
    await this.writeFileBytes(port, remote, readFileSync(local), { create: true, overwrite: true });
  }
  async downloadFile(port: DevicePort, remote: string, local: string): Promise<void> {
    writeFileSync(local, await this.readFileBytes(port, remote));
  }
}
