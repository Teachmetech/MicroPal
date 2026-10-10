import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import type { ConnectionState, DevicePort } from '../src/core/types';

const api = vi.hoisted(() => {
  class FileSystemError extends Error {
    readonly code = 'Unavailable';
    static Unavailable(message: string) { return new FileSystemError(message); }
  }
  return { FileSystemError, workspace: { workspaceFolders: [] as { uri: { scheme: string; authority: string; path: string; query: string; fragment: string } }[] } };
});
vi.mock('vscode', () => api);

class DurableState {
  readonly values = new Map<string, unknown>();
  updateAction?: (key: string, value: unknown) => Promise<void>;
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): Promise<void> {
    if (this.updateAction) return this.updateAction(key, value);
    this.apply(key, value); return Promise.resolve();
  }
  apply(key: string, value: unknown): void {
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}

class SessionDevice {
  private listeners = new Set<(state: ConnectionState) => void>();
  readonly restored: string[] = [];
  fileSystemSession: string | undefined;
  state: ConnectionState = { phase: 'connected' };
  constructor(session?: string) { this.fileSystemSession = session; }
  onDidChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  transition(session?: string): void {
    this.fileSystemSession = session;
    this.state = { phase: session ? 'connected' : 'disconnected' };
    for (const listener of this.listeners) listener(this.state);
  }
  async restoreFileSystemSession(_port: DevicePort, session: string): Promise<void> {
    this.restored.push(session); this.transition(session);
  }
}

async function fixture(options: { session: string | undefined } = { session: 'board-a' }) {
  const { DeviceSessionPersistence } = await import('../src/ui/deviceSessionPersistence');
  const state = new DurableState();
  const port = { path: '/dev/usb-a', serialNumber: 'usb-a', description: 'Test board', likelyEsp32: true };
  state.values.set('microPal.mount.board-a', { session: 'board-a', port });
  state.values.set('microPal.mount.other-window', { session: 'other-window', port });
  state.values.set('ordinary-setting', 42);
  const context = { globalState: state } as unknown as Pick<ExtensionContext, 'globalState'>;
  const device = new SessionDevice(options.session);
  const persistence = new DeviceSessionPersistence(context, device);
  return { state, context, device, persistence };
}

describe('durable device session revocation', () => {
  it.each(['disconnect', 'flash', 'tool setup'])('removes only the revoked session when %s clears it', async () => {
    const { state, device, persistence } = await fixture();
    device.transition(undefined);
    await persistence.flush();
    expect(state.values.has('microPal.mount.board-a')).toBe(false);
    expect(state.values.has('microPal.mount.other-window')).toBe(true);
    expect(state.values.get('ordinary-setting')).toBe(42);
  });

  it('revokes the previous session when connecting to another board', async () => {
    const { state, device, persistence } = await fixture();
    device.transition('board-b');
    state.values.set('microPal.mount.board-b', { session: 'board-b' });
    await persistence.flush();
    expect(state.values.has('microPal.mount.board-a')).toBe(false);
    expect(state.values.has('microPal.mount.board-b')).toBe(true);
  });

  it('preserves a restored session and same-session operation/presence events', async () => {
    const { state, device, persistence } = await fixture({ session: undefined });
    device.transition('board-a'); device.transition('board-a');
    await persistence.flush();
    expect(state.values.has('microPal.mount.board-a')).toBe(true);
  });

  it('starts deleting immediately and flush waits for durable completion', async () => {
    const { state, device, persistence } = await fixture();
    let complete!: () => void;
    state.updateAction = (key, value) => new Promise(resolve => { complete = () => { state.apply(key, value); resolve(); }; });
    device.transition(undefined);
    expect(complete).toBeTypeOf('function');
    let flushed = false;
    const flushing = persistence.flush().then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    complete(); await flushing;
    expect(state.values.has('microPal.mount.board-a')).toBe(false);
  });

  it('observes rejected writes without unhandled rejections and reports the failure through flush', async () => {
    const { state, device, persistence } = await fixture();
    state.updateAction = async () => { throw new Error('Storage unavailable'); };
    device.transition(undefined);
    await Promise.resolve(); await Promise.resolve();
    await expect(persistence.flush()).rejects.toThrow(/Storage unavailable/);
    expect(state.values.has('microPal.mount.board-a')).toBe(true);
  });

  it('reports synchronous storage errors through flush instead of throwing from a device listener', async () => {
    const { state, device, persistence } = await fixture();
    state.updateAction = () => { throw new Error('Storage update failed'); };
    expect(() => device.transition(undefined)).not.toThrow();
    await expect(persistence.flush()).rejects.toThrow(/Storage update failed/);
  });

  it('waits for all outstanding session deletions', async () => {
    const { state, device, persistence } = await fixture();
    const complete: (() => void)[] = [];
    state.updateAction = (key, value) => new Promise(resolve => { complete.push(() => { state.apply(key, value); resolve(); }); });
    device.transition('board-b'); state.values.set('microPal.mount.board-b', {});
    device.transition(undefined);
    let flushed = false; const flushing = persistence.flush().then(() => { flushed = true; });
    complete[0]!(); await Promise.resolve(); await Promise.resolve();
    expect(flushed).toBe(false);
    complete[1]!(); await flushing;
    expect(state.values.has('microPal.mount.board-a')).toBe(false);
    expect(state.values.has('microPal.mount.board-b')).toBe(false);
  });

  it('prevents a newly created Explorer controller from restoring a revoked mount', async () => {
    const { DeviceExplorer } = await import('../src/ui/deviceExplorer');
    const { state, context, device, persistence } = await fixture();
    device.transition(undefined); await persistence.flush();
    api.workspace.workspaceFolders = [{ uri: { scheme: 'micropal', authority: 'board-a', path: '/', query: '', fragment: '' } }];
    const restartedDevice = new SessionDevice();
    const explorer = new DeviceExplorer(context, restartedDevice, { toUri: () => { throw new Error('Not needed'); }, refresh() {} });
    await expect(explorer.restore()).rejects.toMatchObject({ code: 'Unavailable' });
    expect(restartedDevice.restored).toEqual([]);
    expect(state.values.has('microPal.mount.other-window')).toBe(true);
  });

  it('preserves an active descriptor on normal host disposal and stops listening', async () => {
    const { state, device, persistence } = await fixture();
    persistence.dispose(); persistence.dispose();
    device.transition(undefined);
    await persistence.flush();
    expect(state.values.has('microPal.mount.board-a')).toBe(true);
  });

  it('revokes a synchronously invalidated session on disposal even before a device event arrives', async () => {
    const { state, device, persistence } = await fixture();
    device.fileSystemSession = undefined;
    persistence.dispose(); persistence.dispose();
    await persistence.flush();
    expect(state.values.has('microPal.mount.board-a')).toBe(false);
  });
});
