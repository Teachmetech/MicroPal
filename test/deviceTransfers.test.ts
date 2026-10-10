import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import * as vscode from 'vscode';

const api = vi.hoisted(() => {
  class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
    static from(value: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }) {
      return new Uri(value.scheme, value.authority ?? '', value.path ?? '', value.query, value.fragment);
    }
    static file(path: string) { return new Uri('file', '', path); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(base.scheme, base.authority, [base.path.replace(/\/$/, ''), ...parts].join('/')); }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  }
  class FileSystemError extends Error {
    constructor(readonly code: string, message: string | Uri = code) { super(String(message)); }
    static FileNotFound(message?: string | Uri) { return new FileSystemError('FileNotFound', message); }
    static FileExists(message?: string | Uri) { return new FileSystemError('FileExists', message); }
    static FileNotADirectory(message?: string | Uri) { return new FileSystemError('FileNotADirectory', message); }
    static NoPermissions(message?: string | Uri) { return new FileSystemError('NoPermissions', message); }
    static Unavailable(message?: string | Uri) { return new FileSystemError('Unavailable', message); }
  }
  return {
    Uri, FileSystemError, FileType: { File: 1, Directory: 2 }, activeSession: 'board-a',
    entries: new Map<string, { type: number; data: Uint8Array }>(),
    window: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    workspace: { fs: { stat: vi.fn(), copy: vi.fn() } },
  };
});
vi.mock('vscode', () => api);

const remote = (path = '/', authority = 'board-a') => vscode.Uri.from({ scheme: 'micropal', authority, path });
const local = (path: string) => vscode.Uri.file(path);
const filesystem = { toUri: () => remote('/', api.activeSession) };

beforeEach(() => {
  vi.resetAllMocks(); api.activeSession = 'board-a'; api.entries.clear();
  for (const uri of [remote(), remote('/lib'), local('/local'), local('/local/assets')]) api.entries.set(uri.toString(), { type: 2, data: new Uint8Array() });
  api.entries.set(local('/local/data.bin').toString(), { type: 1, data: new Uint8Array([0, 255, 128, 13, 10]) });
  api.entries.set(local('/local/assets/image.bin').toString(), { type: 1, data: new Uint8Array([0, 128, 255]) });
  api.entries.set(remote('/main.py').toString(), { type: 1, data: new Uint8Array([1, 2, 3]) });
  api.workspace.fs.stat.mockImplementation(async (uri: vscode.Uri) => {
    if (uri.scheme === 'micropal' && uri.authority !== api.activeSession) throw vscode.FileSystemError.Unavailable('Connection changed');
    const entry = api.entries.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: entry.type, ctime: 0, mtime: 0, size: entry.data.length };
  });
  api.workspace.fs.copy.mockImplementation(async (source: vscode.Uri, target: vscode.Uri, options: { overwrite: boolean }) => {
    if (api.entries.has(target.toString()) && !options.overwrite) throw vscode.FileSystemError.FileExists(target);
    const sourceKey = source.toString();
    for (const [key, entry] of [...api.entries]) if (key === sourceKey || key.startsWith(`${sourceKey}/`)) {
      api.entries.set(`${target.toString()}${key.slice(sourceKey.length)}`, { type: entry.type, data: Uint8Array.from(entry.data) });
    }
  });
});

describe('explicit Explorer transfers', () => {
  it('uploads selected local files to the chosen device directory without decoding bytes', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.window.showOpenDialog.mockResolvedValue([local('/local/data.bin')]);
    await uploadToDevice(filesystem, remote('/lib'), false);
    expect(api.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true }));
    expect(api.workspace.fs.copy).toHaveBeenCalledWith(local('/local/data.bin'), remote('/lib/data.bin'), { overwrite: false });
    expect([...api.entries.get(remote('/lib/data.bin').toString())!.data]).toEqual([0, 255, 128, 13, 10]);
  });

  it('uploads folders recursively through the editor filesystem service', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.window.showOpenDialog.mockResolvedValue([local('/local/assets')]);
    await uploadToDevice(filesystem, undefined, true);
    expect(api.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true }));
    expect(api.workspace.fs.copy).toHaveBeenCalledWith(local('/local/assets'), remote('/assets'), { overwrite: false });
    expect([...api.entries.get(remote('/assets/image.bin').toString())!.data]).toEqual([0, 128, 255]);
  });

  it('retains the original upload session if another board is connected during the picker', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.window.showOpenDialog.mockImplementation(async () => { api.activeSession = 'board-b'; return [local('/local/data.bin')]; });
    await expect(uploadToDevice(filesystem, undefined, false)).rejects.toMatchObject({ code: 'Unavailable' });
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
    expect(api.entries.has(remote('/data.bin', 'board-b').toString())).toBe(false);
  });

  it('cancels an upload without copying and rejects local/mismatched device targets', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.window.showOpenDialog.mockResolvedValue(undefined);
    await uploadToDevice(filesystem, undefined, false);
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
    await expect(uploadToDevice(filesystem, local('/local'), false)).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(uploadToDevice(filesystem, remote('/', 'board-b'), false)).rejects.toMatchObject({ code: 'Unavailable' });
    await expect(uploadToDevice(filesystem, remote('/main.py'), false)).rejects.toMatchObject({ code: 'FileNotADirectory' });
  });

  it('validates every upload selection before starting any transfer', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.window.showOpenDialog.mockResolvedValue([local('/local/data.bin'), vscode.Uri.from({ scheme: 'https', authority: 'example.com', path: '/secret.bin' })]);
    await expect(uploadToDevice(filesystem, undefined, false)).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
  });

  it('refuses an existing upload destination instead of merging or overwriting it', async () => {
    const { uploadToDevice } = await import('../src/ui/deviceTransfers');
    api.entries.set(remote('/assets').toString(), { type: 2, data: new Uint8Array() });
    api.window.showOpenDialog.mockResolvedValue([local('/local/assets')]);
    await expect(uploadToDevice(filesystem, undefined, true)).rejects.toMatchObject({ code: 'FileExists' });
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
  });

  it('downloads files to a local path using the source name as the default', async () => {
    const { downloadFromDevice } = await import('../src/ui/deviceTransfers');
    api.window.showSaveDialog.mockResolvedValue(local('/downloads/main.py'));
    await downloadFromDevice(remote('/main.py'), '/local project');
    expect(api.window.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: local(path.join('/local project', 'main.py')) }));
    expect(api.workspace.fs.copy).toHaveBeenCalledWith(remote('/main.py'), local('/downloads/main.py'), { overwrite: false });
    expect([...api.entries.get(local('/downloads/main.py').toString())!.data]).toEqual([1, 2, 3]);
  });

  it('downloads a device folder into a new local folder through filesystem copy', async () => {
    const { downloadFromDevice } = await import('../src/ui/deviceTransfers');
    api.entries.set(remote('/lib/module.bin').toString(), { type: 1, data: new Uint8Array([0, 255]) });
    api.window.showSaveDialog.mockResolvedValue(local('/downloads/lib'));
    await downloadFromDevice(remote('/lib'), '/downloads');
    expect(api.workspace.fs.copy).toHaveBeenCalledWith(remote('/lib'), local('/downloads/lib'), { overwrite: false });
    expect([...api.entries.get(local('/downloads/lib/module.bin').toString())!.data]).toEqual([0, 255]);
  });

  it('rejects a stale download after the destination picker without changing local files', async () => {
    const { downloadFromDevice } = await import('../src/ui/deviceTransfers');
    api.window.showSaveDialog.mockImplementation(async () => { api.activeSession = 'board-b'; return local('/downloads/main.py'); });
    await expect(downloadFromDevice(remote('/main.py'), '/downloads')).rejects.toMatchObject({ code: 'Unavailable' });
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
  });

  it('cancels downloads and rejects nonlocal or existing destinations', async () => {
    const { downloadFromDevice } = await import('../src/ui/deviceTransfers');
    api.window.showSaveDialog.mockResolvedValue(undefined);
    await downloadFromDevice(remote('/main.py'), '/local');
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
    api.window.showSaveDialog.mockResolvedValue(remote('/new.py'));
    await expect(downloadFromDevice(remote('/main.py'), '/local')).rejects.toMatchObject({ code: 'NoPermissions' });
    api.window.showSaveDialog.mockResolvedValue(local('/local/data.bin'));
    await expect(downloadFromDevice(remote('/main.py'), '/local')).rejects.toMatchObject({ code: 'FileExists' });
    expect([...api.entries.get(local('/local/data.bin').toString())!.data]).toEqual([0, 255, 128, 13, 10]);
    expect(api.workspace.fs.copy).not.toHaveBeenCalled();
  });

  it('rejects a nondevice download source and preserves filesystem errors', async () => {
    const { downloadFromDevice } = await import('../src/ui/deviceTransfers');
    await expect(downloadFromDevice(local('/local/data.bin'), '/downloads')).rejects.toMatchObject({ code: 'NoPermissions' });
    const failure = new Error('Flash is full');
    api.window.showSaveDialog.mockResolvedValue(local('/downloads/main.py'));
    api.workspace.fs.copy.mockRejectedValue(failure);
    await expect(downloadFromDevice(remote('/main.py'), '/downloads')).rejects.toBe(failure);
  });
});
