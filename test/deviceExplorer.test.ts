import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ConnectionState, DevicePort } from '../src/core/types';
import { DeviceExplorer } from '../src/ui/deviceExplorer';

const editor = vi.hoisted(() => ({
  workspaceFolders: [] as unknown[],
  updateWorkspaceFolders: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn(),
  executeCommand: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: editor,
  commands: { executeCommand: editor.executeCommand },
  window: { showInformationMessage: editor.showInformationMessage },
  FileSystemError: { Unavailable: (message: string) => Object.assign(new Error(message), { code: 'Unavailable' }) },
}));

function uri(scheme: string, authority: string, path = '/', query = '', fragment = ''): vscode.Uri {
  return { scheme, authority, path, query, fragment,
    toString: () => `${scheme}://${authority}${path}${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`,
  } as vscode.Uri;
}
function folder(value: vscode.Uri, index: number, name = 'folder'): vscode.WorkspaceFolder {
  return { uri: value, index, name };
}
function fixture(records = new Map<string, unknown>()) {
  const port: DevicePort = { path: '/dev/cu.usbmodem1', serialNumber: 'board-123', description: 'ESP32', likelyEsp32: true,
    vendorId: '303a', productId: '1001' };
  const device = {
    state: { phase: 'connected', port } as ConnectionState,
    fileSystemSession: 'session-1' as string | undefined,
    restoreFileSystemSession: vi.fn(async (savedPort: DevicePort, session: string) => {
      device.state = { phase: 'connected', port: savedPort };
      device.fileSystemSession = session;
    }),
  };
  const globalState = {
    keys: () => [...records.keys()],
    setKeysForSync: (_keys: readonly string[]) => {},
    get: <T>(key: string, defaultValue?: T): T | undefined => records.has(key) ? records.get(key) as T : defaultValue,
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) records.delete(key); else records.set(key, value); }),
  };
  const filesystem = { toUri: (_path: string) => uri('micropal', device.fileSystemSession ?? 'none'), refresh: vi.fn() };
  const explorer = new DeviceExplorer({ globalState }, device, filesystem);
  return { explorer, device, filesystem, globalState, records, port };
}

beforeEach(() => {
  vi.resetAllMocks();
  editor.workspaceFolders = [folder(uri('file', '', '/work/project'), 0, 'project')];
  editor.updateWorkspaceFolders.mockReturnValue(true);
  editor.onDidChangeWorkspaceFolders.mockReturnValue({ dispose: vi.fn() });
  editor.executeCommand.mockResolvedValue(undefined);
});

describe('native ESP32 Explorer mount', () => {
  it('persists the current connection before a first mount can restart the extension host', async () => {
    const { explorer, records, port } = fixture();
    editor.updateWorkspaceFolders.mockImplementation(() => {
      expect(records.get('microPal.mount.session-1')).toEqual({ session: 'session-1', port });
      return true;
    });
    await explorer.open();
    const [start, count, ...added] = editor.updateWorkspaceFolders.mock.calls[0]!;
    expect(start).toBe(1); expect(count).toBe(0);
    expect(added.map(value => ({ name: value.name, uri: value.uri.toString() }))).toEqual([
      { name: 'ESP32 Files', uri: 'micropal://session-1/' },
    ]);
    expect(editor.executeCommand).toHaveBeenCalledWith('workbench.view.explorer');
  });

  it('preserves every non-device folder in order when replacing stale device roots', async () => {
    editor.workspaceFolders = [folder(uri('file', '', '/work/one'), 0, 'one'),
      folder(uri('micropal', 'old-session'), 1, 'old'), folder(uri('file', '', '/work/two'), 2, 'two'),
      folder(uri('other', 'server', '/repo'), 3, 'remote')];
    const { explorer } = fixture();
    await explorer.open();
    const [start, count, ...added] = editor.updateWorkspaceFolders.mock.calls[0]!;
    expect(start).toBe(1); expect(count).toBe(3);
    expect(added.map(value => ({ name: value.name, uri: value.uri.toString() }))).toEqual([
      { name: 'two', uri: 'file:///work/two' }, { name: 'remote', uri: 'other://server/repo' },
      { name: 'ESP32 Files', uri: 'micropal://session-1/' },
    ]);
  });

  it('reports rejected workspace updates without claiming the device was mounted', async () => {
    editor.updateWorkspaceFolders.mockReturnValue(false);
    const { explorer } = fixture();
    await expect(explorer.open()).rejects.toThrow(/workspace|Explorer/i);
    expect(editor.executeCommand).not.toHaveBeenCalled();
  });

  it('does not change the workspace when saving the restart descriptor fails', async () => {
    const { explorer, globalState } = fixture();
    globalState.update.mockRejectedValue(new Error('Storage is unavailable'));
    await expect(explorer.open()).rejects.toThrow(/storage/i);
    expect(editor.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it('waits for a workspace change event before accepting another mount update', async () => {
    const { explorer } = fixture();
    await explorer.open();
    await expect(explorer.open()).rejects.toThrow(/in progress/);
    await expect(explorer.close()).rejects.toThrow(/in progress/);
    expect(editor.updateWorkspaceFolders).toHaveBeenCalledOnce();
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'));
    editor.onDidChangeWorkspaceFolders.mock.calls[0]![0]({ added: [], removed: [] });
    await explorer.close();
    expect(editor.updateWorkspaceFolders).toHaveBeenCalledTimes(2);
  });

  it('focuses and refreshes an existing exact mount without updating workspace folders', async () => {
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'));
    const { explorer, filesystem } = fixture();
    await explorer.open();
    expect(editor.updateWorkspaceFolders).not.toHaveBeenCalled();
    expect(filesystem.refresh).toHaveBeenCalledOnce();
    expect(editor.executeCommand).toHaveBeenCalledWith('workbench.view.explorer');
  });

  it('moves an existing exact mount below local folders added after it', async () => {
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'),
      folder(uri('file', '', '/work/second'), 2, 'second'));
    const { explorer } = fixture();
    await explorer.open();
    const [start, count, ...added] = editor.updateWorkspaceFolders.mock.calls[0]!;
    expect(start).toBe(1); expect(count).toBe(2);
    expect(added.map(value => value.uri.toString())).toEqual(['file:///work/second', 'micropal://session-1/']);
  });

  it('explains explicit reconnection for ports without a USB serial identity before mounting', async () => {
    const { explorer, device } = fixture();
    device.state.port!.serialNumber = undefined;
    editor.updateWorkspaceFolders.mockImplementation(() => {
      expect(editor.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/no USB serial identity.*Connect again/i));
      return true;
    });
    await explorer.open();
  });

  it('requires a local workspace and an idle connected device before mounting', async () => {
    const { explorer, device } = fixture();
    for (const phase of ['disconnected', 'reconnecting', 'running', 'repl', 'busy'] as const) {
      device.state = { phase, port: device.state.port };
      await expect(explorer.open()).rejects.toThrow(/connect|idle|stop/i);
    }
    device.state.phase = 'connected'; editor.workspaceFolders = [];
    await expect(explorer.open()).rejects.toThrow(/local|folder/i);
    expect(editor.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it('does not mount an obsolete connection if persistence finishes after switching devices', async () => {
    const { explorer, device, globalState, records } = fixture();
    globalState.update.mockImplementation(async (key, value) => {
      if (value !== undefined) {
        device.fileSystemSession = 'session-2';
        records.delete(key); // The session observer revoked it while this write was pending.
        records.set(key, value); // A late write must not resurrect the old mount.
      } else records.delete(key);
    });
    await expect(explorer.open()).rejects.toThrow(/connection|session/i);
    expect(editor.updateWorkspaceFolders).not.toHaveBeenCalled();
    expect(records.has('microPal.mount.session-1')).toBe(false);
  });

  it('restores the saved session in a new extension instance after a workspace transition', async () => {
    const first = fixture(); await first.explorer.open();
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'));
    const second = fixture(first.records);
    second.device.fileSystemSession = undefined; second.device.state = { phase: 'disconnected' };
    await second.explorer.restore();
    expect(second.device.restoreFileSystemSession).toHaveBeenCalledWith(first.port, 'session-1');
    expect(second.device.fileSystemSession).toBe('session-1');
    expect(second.filesystem.refresh).toHaveBeenCalledOnce();
  });

  it('does not restore or acquire hardware when no device folder is mounted', async () => {
    const { explorer, device } = fixture();
    await explorer.restore();
    expect(device.restoreFileSystemSession).not.toHaveBeenCalled();
  });

  it.each([
    ['missing descriptor', undefined, uri('micropal', 'session-1')],
    ['stale session', { session: 'other-session', port: { path: '/dev/cu.usb1', serialNumber: '123', description: 'ESP32', likelyEsp32: true } }, uri('micropal', 'session-1')],
    ['malformed port', { session: 'session-1', port: { path: 'auto', serialNumber: '123', description: 'ESP32', likelyEsp32: true } }, uri('micropal', 'session-1')],
    ['manual port without USB identity', { session: 'session-1', port: { path: '/dev/cu.usb1', description: 'Manual', likelyEsp32: false } }, uri('micropal', 'session-1')],
    ['non-root URI', { session: 'session-1', port: { path: '/dev/cu.usb1', serialNumber: '123', description: 'ESP32', likelyEsp32: true } }, uri('micropal', 'session-1', '/lib')],
    ['URI with a query', { session: 'session-1', port: { path: '/dev/cu.usb1', serialNumber: '123', description: 'ESP32', likelyEsp32: true } }, uri('micropal', 'session-1', '/', 'snapshot=1')],
  ])('requires explicit reconnection for %s', async (_label, descriptor, mountedUri) => {
    const { explorer, device, records } = fixture();
    records.set('microPal.mount.session-1', descriptor);
    editor.workspaceFolders.push(folder(mountedUri, 1, 'ESP32 Files'));
    await expect(explorer.restore()).rejects.toMatchObject({ code: 'Unavailable' });
    expect(device.restoreFileSystemSession).not.toHaveBeenCalled();
  });

  it('propagates a failed USB identity check without refreshing old device files', async () => {
    const { explorer, device, records, port, filesystem } = fixture();
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'));
    records.set('microPal.mount.session-1', { session: 'session-1', port });
    device.restoreFileSystemSession.mockRejectedValue(new Error('Selected USB device is absent'));
    await expect(explorer.restore()).rejects.toThrow(/absent/);
    expect(filesystem.refresh).not.toHaveBeenCalled();
  });

  it('removes only device mounts when closing the Explorer connection', async () => {
    editor.workspaceFolders = [folder(uri('file', '', '/one'), 0, 'one'), folder(uri('micropal', 'session-1'), 1, 'ESP32 Files'),
      folder(uri('file', '', '/two'), 2, 'two')];
    const { explorer } = fixture(); await explorer.close();
    const [start, count, ...added] = editor.updateWorkspaceFolders.mock.calls[0]!;
    expect(start).toBe(1); expect(count).toBe(2);
    expect(added.map(value => value.uri.toString())).toEqual(['file:///two']);
  });

  it('reports failed removal and leaves already-closed workspaces alone', async () => {
    const { explorer } = fixture(); await explorer.close();
    expect(editor.updateWorkspaceFolders).not.toHaveBeenCalled();
    editor.workspaceFolders.push(folder(uri('micropal', 'session-1'), 1));
    editor.updateWorkspaceFolders.mockReturnValue(false);
    await expect(explorer.close()).rejects.toThrow(/workspace|Explorer/i);
  });
});
