import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { DeviceManager } from '../src/core/deviceManager';
import type { ConnectionState, DeviceFile } from '../src/core/types';
import { DeviceFileItem, DeviceFilesProvider } from '../src/ui/deviceFiles';

const editor = vi.hoisted(() => {
  class TreeItem {
    constructor(readonly label: string, readonly collapsibleState = 0) {}
  }
  class ThemeIcon { constructor(readonly id: string) {} }
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  return { TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    window: { showErrorMessage: vi.fn() } };
});
vi.mock('vscode', () => editor);

function fixture() {
  const listeners = new Set<(state: ConnectionState) => void>();
  const manager = {
    state: { phase: 'connected', port: { path: '/dev/ttyUSB0', description: 'ESP32', likelyEsp32: true } } as ConnectionState,
    fileSystemSession: 'session-1' as string | undefined,
    listFiles: vi.fn<(path: string, session?: string) => Promise<DeviceFile[]>>().mockResolvedValue([]),
    onDidChange(listener: (state: ConnectionState) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const filesystem = {
    toUri: (path: string, session = manager.fileSystemSession) => ({
      scheme: 'micropal', authority: session, path,
      toString: () => `micropal://${session}${path}`,
    } as vscode.Uri),
  };
  const provider = new DeviceFilesProvider(manager as unknown as DeviceManager, filesystem);
  const directory = new DeviceFileItem({ name: 'lib', path: '/lib', isDirectory: true, size: 0 }, filesystem.toUri('/lib'));
  return { provider, manager, directory };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('device shortcut tree recovery', () => {
  it('keeps the initial connected hint without querying the board', async () => {
    const { provider, manager } = fixture();
    const items = await provider.getChildren();
    expect(items).toHaveLength(1);
    expect(items[0]?.command?.command).toBe('microPal.openDeviceFiles');
    expect(manager.listFiles).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('propagates an explicit refresh failure instead of reporting an empty directory', async () => {
    const { provider, manager } = fixture();
    const failure = new Error('Serial port is unavailable');
    manager.listFiles.mockRejectedValue(failure);
    await expect(provider.refresh()).rejects.toBe(failure);
    expect(editor.window.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('offers a repair action when expanding a folder fails without repeated notifications', async () => {
    const { provider, manager, directory } = fixture();
    manager.listFiles.mockRejectedValue(new Error('Stop the running program before accessing device files.'));
    for (let request = 0; request < 2; request++) {
      const items = await provider.getChildren(directory);
      expect(items).toHaveLength(1);
      expect(items[0]?.label).toMatch(/Repair ESP32 Files/);
      expect(items[0]?.command?.command).toBe('microPal.repairDeviceFiles');
      expect(items[0]?.tooltip).toMatch(/Stop the running program/);
    }
    expect(editor.window.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('discards a late folder failure after its tree generation is cleared', async () => {
    const { provider, manager, directory } = fixture();
    let reject!: (error: Error) => void;
    manager.listFiles.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = provider.getChildren(directory);
    provider.clear();
    reject(new Error('Previous connection failed'));
    expect(await pending).toEqual([]);
    expect(editor.window.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('does not cache a successful folder response for a newer device session', async () => {
    const { provider, manager, directory } = fixture();
    let resolve!: (files: DeviceFile[]) => void;
    manager.listFiles.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = provider.getChildren(directory);
    manager.fileSystemSession = 'session-2';
    resolve([{ name: 'old.py', path: '/lib/old.py', size: 1, isDirectory: false }]);
    expect(await pending).toEqual([]);
    expect(await provider.getChildren(directory)).toEqual([]);
    provider.dispose();
  });
});
