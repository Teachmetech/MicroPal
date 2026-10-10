import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, DevicePort } from '../src/core/types';
import { ProcessError } from '../src/transport/processRunner';
import { SerialPortReleaseError, type SerialPortOwner } from '../src/transport/serialPortOwners';

const ui = vi.hoisted(() => ({ showWarningMessage: vi.fn(), workspace: { isTrusted: true } }));
vi.mock('vscode', () => ({ window: ui, workspace: ui.workspace }));

const board: DevicePort = {
  path: '/dev/cu.usbmodem1', serialNumber: 'BOARD-123', description: 'Test board', likelyEsp32: true,
};
const managed: SerialPortOwner = {
  pid: 123, uid: 501, command: '/private/MicroPal/tools/bin/mpremote connect /dev/cu.usbmodem1 repl',
  startTime: 'Fri Oct 9 10:00:00 2026', isMicroPalRepl: true, displayName: 'MicroPal mpremote REPL',
};
const external: SerialPortOwner = {
  pid: 456, uid: 501, command: '/private/tools/serial-monitor --secret-token=DO-NOT-DISPLAY',
  startTime: 'Fri Oct 9 10:01:00 2026', isMicroPalRepl: false, displayName: 'serial-monitor',
};

function busy(port = board.path): ProcessError {
  const stderr = `mpremote: failed to access ${port} (it may be in use by another program)\n`;
  return new ProcessError(`Command exited with code 1: ${stderr.trim()}`, { stdout: '', stderr }, 1);
}

function stillBusy(): SerialPortReleaseError {
  return new SerialPortReleaseError('The approved processes still own the serial port.', 'StillBusy');
}

async function fixture() {
  const { createConnectCommand } = await import('../src/ui/connectDevice');
  const connect = vi.fn().mockResolvedValue(undefined);
  const owners = { inspect: vi.fn().mockResolvedValue([managed]), release: vi.fn().mockResolvedValue(undefined) };
  const selectPort = vi.fn().mockResolvedValue(board);
  const onConnected = vi.fn().mockResolvedValue(undefined);
  const output = { appendLine: vi.fn() };
  const autoRelease = vi.fn().mockReturnValue(true);
  const listeners = new Set<(state: ConnectionState) => void>();
  const device = {
    connectionRevision: 0,
    state: { phase: 'disconnected' } as ConnectionState,
    onDidChange: (listener: (state: ConnectionState) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    connect: async (port: DevicePort) => {
      device.connectionRevision += 1;
      change({ phase: 'connecting', port });
      try {
        await connect(port);
        change({ phase: 'connected', port });
      } catch (error) {
        change({ phase: 'error', port });
        throw error;
      }
    },
  };
  function change(state: ConnectionState) {
    device.state = state;
    for (const listener of listeners) listener(state);
  }
  const cancelRecovery = () => {
    device.connectionRevision += 1;
    change({ phase: 'disconnected' });
  };
  const command = createConnectCommand(device, owners, selectPort, onConnected, output, autoRelease);
  return { command, connect, owners, selectPort, onConnected, output, autoRelease, device, cancelRecovery, listeners };
}

beforeEach(() => { vi.resetAllMocks(); ui.workspace.isTrusted = true; });

describe('explicit device connection and serial recovery', () => {
  it('connects normally before inspecting other owners and opens files after success', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    await command();
    expect(connect).toHaveBeenCalledExactlyOnceWith(board);
    expect(owners.inspect).not.toHaveBeenCalled();
    expect(owners.release).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
  });

  it('cancels without connecting when no serial port is selected', async () => {
    const { command, selectPort, connect, owners, onConnected } = await fixture();
    selectPort.mockResolvedValue(undefined);
    await command();
    expect(connect).not.toHaveBeenCalled();
    expect(owners.inspect).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Serial port permission denied.'),
    new Error('Python firmware OSError: [Errno 16] Device or resource busy'),
    new Error('Cannot enter raw repl.'),
    new Error('Failed to access a device.'),
    busy('/dev/cu.another-board'),
    new ProcessError('Command timed out.', busy().result, 'ETIMEDOUT'),
    new ProcessError('Command cancelled.', busy().result, 'ABORT_ERR'),
    new ProcessError('Permission denied.', { stdout: '', stderr: `serial.serialutil.SerialException: [Errno 13] could not open port ${board.path}: Permission denied` }, 1),
    new ProcessError('Python failure.', { stdout: '', stderr: 'Traceback (most recent call last):\nOSError: [Errno 16] Device or resource busy' }, 1),
    new ProcessError('Bad response.', { stdout: busy().result.stderr, stderr: '' }, 1),
  ])('does not recover from unrelated connection failures: %s', async failure => {
    const { command, connect, owners, onConnected } = await fixture();
    connect.mockRejectedValue(failure);
    await expect(command()).rejects.toBe(failure);
    expect(owners.inspect).not.toHaveBeenCalled();
    expect(owners.release).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('preserves the original access failure when no process owns the selected port', async () => {
    const { command, connect, owners } = await fixture();
    const failure = busy();
    connect.mockRejectedValueOnce(failure);
    owners.inspect.mockResolvedValue([]);
    await expect(command()).rejects.toBe(failure);
    expect(owners.inspect).toHaveBeenCalledExactlyOnceWith(board.path);
    expect(owners.release).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
  });

  it('automatically releases only identified managed REPLs and retries the same board once', async () => {
    const { command, connect, owners, onConnected, output } = await fixture();
    connect.mockRejectedValueOnce(busy());
    await command();
    expect(owners.release).toHaveBeenCalledExactlyOnceWith(board.path, [managed], { signal: expect.any(AbortSignal) });
    expect(connect.mock.calls).toEqual([[board], [board]]);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(owners.inspect.mock.invocationCallOrder[0]!);
    expect(owners.release.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[1]!);
    expect(onConnected).toHaveBeenCalledOnce();
    expect(output.appendLine.mock.calls.flat().join('\n')).toContain('MicroPal mpremote REPL (PID 123)');
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
  });

  it.each([
    `serial.serialutil.SerialException: [Errno 16] could not open port ${board.path}: [Errno 16] Resource busy: '${board.path}'`,
    `serial.serialutil.SerialException: [Errno 16] Resource busy: '${board.path}'`,
    `serial.serialutil.SerialException: Could not exclusively lock port ${board.path}: [Errno 11] Resource temporarily unavailable`,
  ])('recovers from precise host serial busy failures for the selected port', async stderr => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(new ProcessError('Serial port access failed.', { stdout: '', stderr }, 1));
    await command();
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('also recognizes the exact mpremote access error without a ProcessError wrapper', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(new Error(busy().result.stderr.trim()));
    await command();
    expect(owners.release).toHaveBeenCalledOnce();
  });

  it('requires a modal process-specific approval when any owner is external', async () => {
    const { command, connect, owners, output } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([managed, external]);
    ui.showWarningMessage.mockResolvedValue('Release Port and Connect');
    await command();
    expect(ui.showWarningMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(board.path),
      expect.objectContaining({ modal: true, detail: expect.stringContaining('serial-monitor (PID 456)') }),
      'Release Port and Connect',
    );
    const detail = ui.showWarningMessage.mock.calls[0]?.[1].detail as string;
    expect(detail).toContain('MicroPal mpremote REPL (PID 123)');
    expect(detail).toMatch(/terminat|stop/i);
    expect(detail).toMatch(/unsaved work/i);
    expect(detail).not.toContain(external.command);
    expect(output.appendLine.mock.calls.flat().join('\n')).not.toContain(external.command);
    expect(owners.release).toHaveBeenCalledExactlyOnceWith(board.path, [managed, external], { signal: expect.any(AbortSignal) });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('requires approval for a managed REPL when automatic release is disabled', async () => {
    const { command, connect, owners, autoRelease } = await fixture();
    connect.mockRejectedValueOnce(busy());
    autoRelease.mockReturnValue(false);
    ui.showWarningMessage.mockResolvedValue('Release Port and Connect');
    await command();
    expect(ui.showWarningMessage).toHaveBeenCalledOnce();
    expect(owners.release).toHaveBeenCalledExactlyOnceWith(board.path, [managed], { signal: expect.any(AbortSignal) });
  });

  it('does not terminate or retry when the external-process prompt is cancelled', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([external]);
    ui.showWarningMessage.mockResolvedValue(undefined);
    await command();
    expect(owners.release).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('requires explicit force approval after an automatically released REPL remains busy', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockResolvedValue('Force Release and Connect');
    await command();
    expect(ui.showWarningMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(board.path),
      expect.objectContaining({ modal: true, detail: expect.stringContaining('MicroPal mpremote REPL (PID 123)') }),
      'Force Release and Connect',
    );
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toMatch(/force|SIGKILL/i);
    expect(owners.release.mock.calls).toEqual([
      [board.path, [managed], { signal: expect.any(AbortSignal) }],
      [board.path, [managed], { force: true, signal: expect.any(AbortSignal) }],
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not force termination or retry after the force prompt is cancelled', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockResolvedValue(undefined);
    await command();
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('requires separate release and force approvals for an external process', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([external]);
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockResolvedValueOnce('Release Port and Connect').mockResolvedValueOnce('Force Release and Connect');
    await command();
    expect(ui.showWarningMessage.mock.calls.map(call => call[2])).toEqual(['Release Port and Connect', 'Force Release and Connect']);
    expect(owners.release).toHaveBeenCalledTimes(2);
    expect(owners.release.mock.calls[1]?.[2]).toMatchObject({ force: true });
  });

  it('offers force for only the approved owners that remain after another owner exits', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValueOnce([managed, external]).mockResolvedValueOnce([external]);
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockResolvedValueOnce('Release Port and Connect').mockResolvedValueOnce('Force Release and Connect');
    await command();
    expect(owners.release.mock.calls).toEqual([
      [board.path, [managed, external], { signal: expect.any(AbortSignal) }],
      [board.path, [external], { force: true, signal: expect.any(AbortSignal) }],
    ]);
    expect(ui.showWarningMessage.mock.calls[1]?.[1].detail).toContain('serial-monitor (PID 456)');
    expect(ui.showWarningMessage.mock.calls[1]?.[1].detail).not.toContain('MicroPal mpremote REPL');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('propagates a force-release failure without reconnecting or offering another force attempt', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    const failure = new SerialPortReleaseError('The process still owns the port.', 'StillBusy');
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(stillBusy()).mockRejectedValueOnce(failure);
    ui.showWarningMessage.mockResolvedValue('Force Release and Connect');
    await expect(command()).rejects.toBe(failure);
    expect(ui.showWarningMessage).toHaveBeenCalledOnce();
    expect(owners.release).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('requires a typed release-timeout error before offering force termination', async () => {
    const { command, connect, owners } = await fixture();
    const failure = Object.assign(new Error('An unrelated failure.'), { name: 'SerialPortReleaseError', code: 'StillBusy' });
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(failure);
    await expect(command()).rejects.toBe(failure);
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(owners.inspect).toHaveBeenCalledOnce();
  });

  it.each(['IdentityChanged', 'PermissionDenied', 'InspectionFailed'])('does not offer force after release fails with %s', async code => {
    const { command, connect, owners } = await fixture();
    const failure = Object.assign(new Error('Release failed.'), { name: 'SerialPortReleaseError', code });
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(failure);
    await expect(command()).rejects.toBe(failure);
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not offer force for a new owner or a reused PID after termination times out', async () => {
    const { command, connect, owners } = await fixture();
    const failure = stillBusy();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValueOnce([managed]).mockResolvedValueOnce([{ ...managed, startTime: 'Fri Oct 9 10:02:00 2026' }]);
    owners.release.mockRejectedValueOnce(failure);
    await expect(command()).rejects.toBe(failure);
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(owners.release).toHaveBeenCalledOnce();
  });

  it('does not offer force when a newly observed owner joins an approved owner', async () => {
    const { command, connect, owners } = await fixture();
    const failure = stillBusy();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValueOnce([managed]).mockResolvedValueOnce([managed, external]);
    owners.release.mockRejectedValueOnce(failure);
    await expect(command()).rejects.toBe(failure);
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('retries after an approved owner exits between the termination timeout and reinspection', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValueOnce([managed]).mockResolvedValueOnce([]);
    owners.release.mockRejectedValueOnce(stillBusy());
    await command();
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('propagates the one retry failure without repeating recovery', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    const retryFailure = busy();
    connect.mockRejectedValueOnce(busy()).mockRejectedValueOnce(retryFailure);
    await expect(command()).rejects.toBe(retryFailure);
    expect(owners.inspect).toHaveBeenCalledOnce();
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('does not recover from an Explorer-opening failure after a successful connection', async () => {
    const { command, connect, owners, onConnected } = await fixture();
    const failure = busy();
    onConnected.mockRejectedValueOnce(failure);
    await expect(command()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
    expect(owners.inspect).not.toHaveBeenCalled();
    expect(owners.release).not.toHaveBeenCalled();
  });

  it('rejects concurrent connections without duplicating selection, prompts, or releases', async () => {
    const { command, connect, owners, selectPort } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([external]);
    let answer!: (choice: string | undefined) => void;
    ui.showWarningMessage.mockImplementation(() => new Promise<string | undefined>(resolve => { answer = resolve; }));
    const first = command();
    await vi.waitFor(() => { expect(ui.showWarningMessage).toHaveBeenCalledOnce(); });
    await expect(command()).rejects.toThrow(/already|in progress/i);
    expect(selectPort).toHaveBeenCalledOnce();
    expect(owners.inspect).toHaveBeenCalledOnce();
    expect(owners.release).not.toHaveBeenCalled();
    answer('Release Port and Connect');
    await first;
    expect(owners.release).toHaveBeenCalledOnce();
    await command();
    expect(selectPort).toHaveBeenCalledTimes(2);
  });

  it('stops recovery if another device command changes the connection during inspection', async () => {
    const { command, connect, owners, cancelRecovery, listeners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockImplementation(async () => { cancelRecovery(); return [managed]; });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(owners.release).not.toHaveBeenCalled();
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('does not terminate after another device command changes the connection during a prompt', async () => {
    const { command, connect, owners, cancelRecovery } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([external]);
    ui.showWarningMessage.mockImplementation(async () => { cancelRecovery(); return 'Release Port and Connect'; });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(owners.release).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not force termination after another device command changes the connection during the force prompt', async () => {
    const { command, connect, owners, cancelRecovery } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockImplementation(async () => { cancelRecovery(); return 'Force Release and Connect'; });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('aborts an active release and never retries after another command changes the connection', async () => {
    const { command, connect, owners, cancelRecovery } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockImplementation(async (_path, _owners, options: { signal: AbortSignal }) => {
      cancelRecovery();
      expect(options.signal.aborted).toBe(true);
    });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not begin recovery after an already superseded connect attempt fails', async () => {
    const { command, connect, owners, device } = await fixture();
    device.connect = async () => { device.connectionRevision += 1; throw busy(); };
    await expect(command()).rejects.toBeInstanceOf(ProcessError);
    expect(connect).not.toHaveBeenCalled();
    expect(owners.inspect).not.toHaveBeenCalled();
  });

  it('does not mistake a later failed connection to the same board for the original attempt', async () => {
    const { command, owners, device } = await fixture();
    const failure = busy();
    device.connect = async port => {
      device.connectionRevision += 1;
      await Promise.resolve();
      device.connectionRevision += 1;
      device.state = { phase: 'error', port };
      throw failure;
    };
    await expect(command()).rejects.toBe(failure);
    expect(owners.inspect).not.toHaveBeenCalled();
  });

  it('unsubscribes before the deliberate retry changes the connection revision', async () => {
    const { command, connect, listeners } = await fixture();
    connect.mockRejectedValueOnce(busy()).mockImplementationOnce(async () => { expect(listeners.size).toBe(0); });
    await command();
    expect(listeners.size).toBe(0);
  });

  it('does not connect if workspace trust is revoked while selecting a port', async () => {
    const { command, selectPort, connect, owners } = await fixture();
    selectPort.mockImplementation(async () => { ui.workspace.isTrusted = false; return board; });
    await expect(command()).rejects.toThrow(/trust.*workspace|workspace.*trust/i);
    expect(connect).not.toHaveBeenCalled();
    expect(owners.inspect).not.toHaveBeenCalled();
  });

  it('does not release processes if workspace trust is revoked while confirming a release', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.inspect.mockResolvedValue([external]);
    ui.showWarningMessage.mockImplementation(async () => { ui.workspace.isTrusted = false; return 'Release Port and Connect'; });
    await expect(command()).rejects.toThrow(/trust.*workspace|workspace.*trust/i);
    expect(owners.release).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not force release processes if workspace trust is revoked while confirming force', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockRejectedValueOnce(stillBusy());
    ui.showWarningMessage.mockImplementation(async () => { ui.workspace.isTrusted = false; return 'Force Release and Connect'; });
    await expect(command()).rejects.toThrow(/trust.*workspace|workspace.*trust/i);
    expect(owners.release).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not retry a connection if workspace trust is revoked during release', async () => {
    const { command, connect, owners } = await fixture();
    connect.mockRejectedValueOnce(busy());
    owners.release.mockImplementation(async () => { ui.workspace.isTrusted = false; });
    await expect(command()).rejects.toThrow(/trust.*workspace|workspace.*trust/i);
    expect(connect).toHaveBeenCalledOnce();
    expect(owners.release.mock.calls[0]?.[2].signal.aborted).toBe(true);
  });
});
