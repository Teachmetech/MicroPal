import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../src/core/types';
import { createRepairDeviceFilesCommand } from '../src/ui/repairDeviceFiles';

const ui = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'micropal' } }] as { uri: { scheme: string } }[] },
}));
vi.mock('vscode', () => ({ window: ui, workspace: ui.workspace }));

function fixture(phase: ConnectionState['phase'] = 'connected') {
  const device = { state: { phase } as ConnectionState, fileSystemSession: phase === 'connected' ? 'current-session' : undefined,
    connectionRevision: 0 };
  const explorer = {
    open: vi.fn(async () => {}),
    restore: vi.fn(async () => {
      device.connectionRevision++;
      device.fileSystemSession = 'saved-session';
      device.state = { phase: 'connected' };
    }),
  };
  const connect = vi.fn(async () => {
    device.connectionRevision++;
    device.fileSystemSession = 'new-session';
    device.state = { phase: 'connected' };
  });
  const refreshed: string[] = [];
  const repair = createRepairDeviceFilesCommand(device, explorer, connect, () => { refreshed.push(device.fileSystemSession!); });
  return { device, explorer, connect, refreshed, repair };
}

beforeEach(() => {
  vi.resetAllMocks();
  ui.workspace.isTrusted = true;
  ui.workspace.workspaceFolders = [{ uri: { scheme: 'micropal' } }];
});

describe('explicit ESP32 Files repair', () => {
  it('remounts the current connection then refreshes the native Explorer', async () => {
    const { repair, explorer, refreshed, connect } = fixture();
    await repair();
    expect(explorer.open).toHaveBeenCalledOnce();
    expect(explorer.restore).not.toHaveBeenCalled();
    expect(refreshed).toEqual(['current-session']);
    expect(connect).not.toHaveBeenCalled();
  });

  it('restores a mounted saved USB identity before offering a new connection', async () => {
    const { repair, device, explorer, connect, refreshed } = fixture('disconnected');
    await repair();
    expect(device.fileSystemSession).toBe('saved-session');
    expect(explorer.restore).toHaveBeenCalledOnce();
    expect(explorer.open).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(refreshed).toEqual(['saved-session']);
  });

  it('offers explicit Connect after an unrestorable mount and does not open twice', async () => {
    const { repair, explorer, connect, refreshed } = fixture('disconnected');
    explorer.restore.mockRejectedValue(new Error('This port has no USB serial identity.'));
    ui.showWarningMessage.mockResolvedValue('Connect');
    await repair();
    expect(ui.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/USB serial identity/),
      expect.objectContaining({ detail: expect.stringMatching(/unsaved|old.*file/i) }), 'Connect');
    expect(connect).toHaveBeenCalledOnce();
    expect(explorer.open).not.toHaveBeenCalled();
    expect(refreshed).toEqual(['new-session']);
  });

  it('does not report recovery when Connect selection is cancelled', async () => {
    const { device, explorer, connect, refreshed } = fixture('disconnected');
    ui.workspace.workspaceFolders = [];
    connect.mockImplementation(async () => {});
    ui.showWarningMessage.mockResolvedValue('Connect');
    const repair = createRepairDeviceFilesCommand(device, explorer, connect, () => { refreshed.push('wrong'); });
    await repair();
    expect(explorer.restore).not.toHaveBeenCalled();
    expect(refreshed).toEqual([]);
  });

  it.each(['running', 'repl', 'busy', 'connecting', 'reconnecting', 'flashing'] as const)(
    'does not acquire or interrupt a device in phase %s', async phase => {
      const { repair, explorer, connect, refreshed } = fixture(phase);
      await expect(repair()).rejects.toThrow(/stop|close|finish|wait|try/i);
      expect(explorer.open).not.toHaveBeenCalled();
      expect(explorer.restore).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(refreshed).toEqual([]);
    });

  it('rejects duplicate repair without creating another recovery prompt', async () => {
    const { repair, explorer, refreshed } = fixture('disconnected');
    explorer.restore.mockRejectedValue(new Error('Expired connection'));
    let answer!: (value: string | undefined) => void;
    ui.showWarningMessage.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const first = repair();
    await vi.waitFor(() => { expect(ui.showWarningMessage).toHaveBeenCalledOnce(); });
    await expect(repair()).rejects.toThrow(/already|in progress/i);
    answer(undefined);
    await first;
    expect(refreshed).toEqual([]);
  });

  it('does not offer Connect after a concurrent connection supersedes restoration', async () => {
    const { repair, device, explorer, connect } = fixture('disconnected');
    explorer.restore.mockImplementation(() => {
      device.connectionRevision++;
      return Promise.resolve().then(() => { device.connectionRevision++; throw new Error('Restoration cancelled'); });
    });
    await expect(repair()).rejects.toMatchObject({ name: 'AbortError' });
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('ignores a delayed Connect answer after an external disconnect', async () => {
    const { repair, device, explorer, connect } = fixture('error');
    explorer.restore.mockRejectedValue(new Error('Expired connection'));
    ui.showWarningMessage.mockImplementation(async () => { device.connectionRevision++; return 'Connect'; });
    await expect(repair()).rejects.toMatchObject({ name: 'AbortError' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('allows normal native filesystem reads during Explorer open', async () => {
    const { repair, device, explorer, refreshed } = fixture();
    explorer.open.mockImplementation(async () => { device.state = { phase: 'busy' }; });
    await repair();
    expect(refreshed).toEqual(['current-session']);
  });

  it('refreshes a newly mounted connection while native Explorer reads are busy', async () => {
    const { repair, device, explorer, connect, refreshed } = fixture('disconnected');
    explorer.restore.mockRejectedValue(new Error('Expired connection'));
    ui.showWarningMessage.mockResolvedValue('Connect');
    connect.mockImplementation(async () => {
      device.connectionRevision++;
      device.fileSystemSession = 'new-session';
      device.state = { phase: 'busy' };
    });
    await repair();
    expect(refreshed).toEqual(['new-session']);
  });

  it('rechecks trust before a delayed Connect fallback', async () => {
    const { repair, explorer, connect } = fixture('disconnected');
    explorer.restore.mockRejectedValue(new Error('Expired connection'));
    ui.showWarningMessage.mockImplementation(async () => { ui.workspace.isTrusted = false; return 'Connect'; });
    await expect(repair()).rejects.toThrow(/trust/i);
    expect(connect).not.toHaveBeenCalled();
  });
});
