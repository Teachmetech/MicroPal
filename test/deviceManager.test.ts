import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceManager } from '../src/core/deviceManager';
import type { DevicePort, DeviceSettings, DeviceTransport, InteractiveSession } from '../src/core/types';

const board: DevicePort = {
  path: '/dev/ttyACM0', serialNumber: 'BOARD-1', vendorId: '303a', productId: '1001',
  description: 'ESP32-S3', likelyEsp32: true,
};
const settings: DeviceSettings = {
  mpremotePath: 'mpremote', preferredPort: '', baudRate: 115200,
  autoReconnect: true, syncExclusions: [],
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transportDouble() {
  return {
    discover: vi.fn<DeviceTransport['discover']>().mockResolvedValue([board]),
    probe: vi.fn<DeviceTransport['probe']>().mockResolvedValue(undefined),
    runFile: vi.fn<DeviceTransport['runFile']>().mockResolvedValue(undefined),
    uploadFile: vi.fn<DeviceTransport['uploadFile']>().mockResolvedValue(undefined),
    stop: vi.fn<DeviceTransport['stop']>().mockResolvedValue(undefined),
    softReset: vi.fn<DeviceTransport['softReset']>().mockResolvedValue(undefined),
    listFiles: vi.fn<DeviceTransport['listFiles']>().mockResolvedValue([]),
    readFile: vi.fn<DeviceTransport['readFile']>().mockResolvedValue('print(42)'),
    statFile: vi.fn<DeviceTransport['statFile']>().mockResolvedValue({ isDirectory: false, size: 3, mtime: 1000 }),
    readFileBytes: vi.fn<DeviceTransport['readFileBytes']>().mockResolvedValue(new Uint8Array([0, 255, 1])),
    writeFileBytes: vi.fn<DeviceTransport['writeFileBytes']>().mockResolvedValue(undefined),
    createDirectory: vi.fn<DeviceTransport['createDirectory']>().mockResolvedValue(undefined),
    deleteFile: vi.fn<DeviceTransport['deleteFile']>().mockResolvedValue(undefined),
    renameFile: vi.fn<DeviceTransport['renameFile']>().mockResolvedValue(undefined),
    downloadFile: vi.fn<DeviceTransport['downloadFile']>().mockResolvedValue(undefined),
    openRepl: vi.fn<DeviceTransport['openRepl']>(),
    openConsole: vi.fn<NonNullable<DeviceTransport['openConsole']>>(),
    canOpenConsole: vi.fn<NonNullable<DeviceTransport['canOpenConsole']>>().mockReturnValue(true),
  };
}
const managers: DeviceManager[] = [];
function fixture(options: Partial<DeviceSettings> = {}, toolsBusy?: () => boolean) {
  const transport = transportDouble();
  const manager = new DeviceManager(transport, () => ({ ...settings, ...options }), 50, toolsBusy);
  managers.push(manager);
  return { manager, transport };
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  vi.useRealTimers();
});

describe('DeviceManager', () => {
  function consoleSession() {
    const ended = deferred<void>();
    return { ended, session: { closed: ended.promise, close: vi.fn(async () => { ended.resolve(); }), show: vi.fn() } };
  }

  it('connects with a passive console instead of interrupting the board with a REPL probe', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const { session } = consoleSession();
    transport.openConsole.mockResolvedValue(session);
    await manager.connect(board);
    expect(transport.probe).not.toHaveBeenCalled();
    expect(transport.openConsole).toHaveBeenCalledWith(board, expect.any(AbortSignal));
    expect(session.show).toHaveBeenCalledOnce();
    expect(manager.state.phase).toBe('connected');
  });

  it('keeps the automatic output notice when the ready reader exits during Connect', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    transport.openConsole.mockResolvedValue({ closed: Promise.resolve(), close: async () => {}, show: () => {} });
    await manager.connect(board);
    expect(manager.state).toMatchObject({ phase: 'connected', message: expect.stringMatching(/automatic output.*stopped/i) });
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.openConsole).toHaveBeenCalledOnce();
  });

  it('does not report Connect success if a ready reader cannot verify closure', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    transport.openConsole.mockResolvedValue({ closed: Promise.reject(new Error('Closure could not be confirmed')), close: async () => {}, show: () => {} });
    await expect(manager.connect(board)).rejects.toThrow(/closure could not be confirmed/i);
    expect(manager.state.phase).toBe('error');
    expect(manager.state.message).toMatch(/closure could not be confirmed/i);
    expect(manager.fileSystemSession).toBeUndefined();
  });

  it('releases the ready console if revealing its output panel fails during Connect', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const { session } = consoleSession(); session.show.mockImplementation(() => { throw new Error('Output panel failed'); });
    transport.openConsole.mockResolvedValue(session);
    await expect(manager.connect(board)).rejects.toThrow(/output panel failed/i);
    expect(session.close).toHaveBeenCalledOnce();
    expect(manager.state.phase).toBe('error');
  });

  it('resumes the passive console after Run completes without replaying the program', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const initial = consoleSession();
    transport.openConsole.mockResolvedValueOnce(initial.session).mockImplementation(async () => consoleSession().session);
    const program = deferred<void>(); transport.runFile.mockReturnValue(program.promise);
    await manager.connect(board);
    const running = manager.runFile('/main.py'); await settle();
    expect(initial.session.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.openConsole).toHaveBeenCalledOnce();
    program.resolve(); await running; await vi.advanceTimersByTimeAsync(100);
    expect(transport.openConsole).toHaveBeenCalledTimes(2);
    expect(transport.runFile).toHaveBeenCalledOnce();
    expect(transport.softReset).not.toHaveBeenCalled();
  });

  it('cancels an idle console startup before queued filesystem work acquires the port', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const initial = consoleSession(); const opening = deferred<InteractiveSession>();
    let signal: AbortSignal | undefined;
    transport.openConsole.mockResolvedValueOnce(initial.session).mockImplementation((_port, pendingSignal) => { signal = pendingSignal; return opening.promise; });
    await manager.connect(board); await manager.listFiles('/');
    await vi.advanceTimersByTimeAsync(100);
    const reading = manager.readFile('/main.py'); await settle();
    expect(signal?.aborted).toBe(true);
    expect(transport.readFile).not.toHaveBeenCalled();
    const late = consoleSession(); opening.resolve(late.session);
    await reading;
    expect(late.session.close).toHaveBeenCalledOnce();
    expect(transport.readFile).toHaveBeenCalledOnce();
  });

  it('waits for console closure before filesystem work and resumes only after a quiet queue', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const first = consoleSession();
    const released = deferred<void>();
    first.session.close.mockImplementation(async () => { await released.promise; first.ended.resolve(); });
    transport.openConsole.mockResolvedValueOnce(first.session).mockImplementation(async () => consoleSession().session);
    await manager.connect(board);
    const reading = manager.listFiles('/');
    await settle();
    expect(transport.listFiles).not.toHaveBeenCalled();
    released.resolve(); await reading;
    await manager.readFile('/main.py');
    expect(transport.openConsole).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.openConsole).toHaveBeenCalledTimes(2);
    expect(transport.runFile).not.toHaveBeenCalled();
    expect(transport.softReset).not.toHaveBeenCalled();
  });

  it('cancels a pending console launch on disconnect and closes its late session', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const opening = deferred<InteractiveSession>();
    let signal: AbortSignal | undefined;
    transport.openConsole.mockImplementation((_port, pendingSignal) => { signal = pendingSignal; return opening.promise; });
    const connecting = manager.connect(board).catch(error => error);
    await settle();
    const disconnected = manager.disconnect();
    expect(signal?.aborted).toBe(true);
    const { session } = consoleSession(); opening.resolve(session);
    await disconnected;
    expect((await connecting).name).toBe('AbortError');
    expect(session.close).toHaveBeenCalledOnce();
    expect(manager.state.phase).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.openConsole).toHaveBeenCalledTimes(1);
  });

  it('retains the closure guard when the automatic console cannot be released', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const { session } = consoleSession();
    session.close.mockRejectedValueOnce(new Error('serial handle still open'));
    transport.openConsole.mockResolvedValue(session);
    await manager.connect(board);
    await expect(manager.listFiles('/')).rejects.toThrow(/still open/);
    expect(transport.listFiles).not.toHaveBeenCalled();
    await manager.listFiles('/');
    expect(transport.listFiles).toHaveBeenCalledOnce();
  });

  it('pauses the console for manual REPL and resumes after the terminal closes', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const initial = consoleSession();
    transport.openConsole.mockResolvedValueOnce(initial.session).mockImplementation(async () => consoleSession().session);
    const repl = consoleSession(); transport.openRepl.mockResolvedValue(repl.session);
    await manager.connect(board);
    await manager.openRepl();
    expect(initial.session.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.openConsole).toHaveBeenCalledTimes(1);
    await expect(manager.listFiles('/')).rejects.toThrow(/close.*REPL/);
    repl.ended.resolve(); await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.openConsole).toHaveBeenCalledTimes(2);
  });

  it('stops a failed console without retrying during ordinary presence polling', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    const initial = consoleSession(); transport.openConsole.mockResolvedValue(initial.session);
    await manager.connect(board);
    initial.ended.resolve(); await settle();
    manager.start(); await vi.advanceTimersByTimeAsync(500);
    expect(transport.openConsole).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('connected');
    expect(manager.state.message).toMatch(/automatic output.*stopped/i);
    transport.openConsole.mockImplementation(async () => consoleSession().session);
    await manager.refreshOutput(); await vi.advanceTimersByTimeAsync(100);
    expect(transport.openConsole).toHaveBeenCalledTimes(2);
  });

  it('falls back to ordinary Connect with one setup notice when managed console tools are unavailable', async () => {
    const { manager, transport } = fixture({ autoShowOutput: true });
    transport.canOpenConsole.mockReturnValue(false);
    const notices: string[] = [];
    manager.onDidChange(state => { if (state.message?.includes('Set Up Tools')) notices.push(state.message); });
    await manager.connect(board);
    await manager.listFiles('/'); manager.start(); await vi.advanceTimersByTimeAsync(500);
    expect(transport.probe).toHaveBeenCalledOnce();
    expect(transport.openConsole).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
  });

  it('disables live output immediately on a settings refresh', async () => {
    const options = { autoShowOutput: true };
    const { manager, transport } = fixture(options);
    const { session } = consoleSession(); transport.openConsole.mockResolvedValue(session);
    await manager.connect(board);
    options.autoShowOutput = false;
    await manager.refreshOutput(); await vi.advanceTimersByTimeAsync(500);
    expect(session.close).toHaveBeenCalledOnce();
    expect(transport.openConsole).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('connected');
  });

  it('binds device documents to a connection session that is replaced by explicit reconnect', async () => {
    const { manager } = fixture();
    expect(manager.fileSystemSession).toBeUndefined();
    await manager.connect(board);
    const session = manager.fileSystemSession;
    expect(session).toMatch(/^[a-z0-9-]+$/);
    await manager.listFiles('/', session);
    expect(manager.fileSystemSession).toBe(session);
    await manager.disconnect();
    expect(manager.fileSystemSession).toBeUndefined();
    await manager.connect(board);
    expect(manager.fileSystemSession).not.toBe(session);
  });

  it('serializes binary filesystem actions and forwards write/delete/rename policy', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const session = manager.fileSystemSession!;
    expect(await manager.statFile('/data', session)).toEqual({ isDirectory: false, size: 3, mtime: 1000 });
    expect(await manager.readFileBytes('/data', session)).toEqual(new Uint8Array([0, 255, 1]));
    const data = new Uint8Array([255, 0]);
    await manager.writeFileBytes('/data', data, { create: false, overwrite: true }, session);
    await manager.createDirectory('/folder', session);
    await manager.renameFile('/data', '/folder/data', { overwrite: false }, session);
    await manager.deleteFile('/folder', { recursive: true }, session);
    expect(transport.writeFileBytes).toHaveBeenCalledWith(board, '/data', data,
      { create: false, overwrite: true }, expect.any(AbortSignal));
    expect(transport.renameFile).toHaveBeenCalledWith(board, '/data', '/folder/data',
      { overwrite: false }, expect.any(AbortSignal));
    expect(transport.deleteFile).toHaveBeenCalledWith(board, '/folder', { recursive: true }, expect.any(AbortSignal));
    expect(manager.state.phase).toBe('connected');
  });

  it('rejects an old document save after selecting another board', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const session = manager.fileSystemSession!;
    const other = { ...board, path: '/dev/ttyACM1', serialNumber: 'BOARD-2' };
    await manager.connect(other);
    await expect(manager.writeFileBytes('/main.py', new Uint8Array([1]),
      { create: true, overwrite: true }, session)).rejects.toMatchObject({ code: 'Unavailable' });
    expect(transport.writeFileBytes).not.toHaveBeenCalled();
    expect(manager.state.port).toEqual(other);
  });

  it('does not launch an edit queued before disconnect', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const blocked = deferred<void>();
    transport.uploadFile.mockReturnValueOnce(blocked.promise);
    const first = manager.uploadFile('/local/a', '/a');
    await settle();
    const edit = manager.writeFileBytes('/b', new Uint8Array([2]),
      { create: true, overwrite: true }, manager.fileSystemSession).catch(error => error);
    const disconnected = manager.disconnect();
    blocked.resolve();
    await Promise.all([first.catch(() => {}), disconnected]);
    expect((await edit).name).toBe('AbortError');
    expect(transport.writeFileBytes).not.toHaveBeenCalled();
  });

  it('refuses filesystem editing while a program owns the port', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _path, runningSignal) => { signal = runningSignal; return closed.promise; });
    const running = manager.runFile('/loop.py');
    await settle();
    try {
      await expect(manager.writeFileBytes('/data', new Uint8Array(),
        { create: true, overwrite: true }, manager.fileSystemSession)).rejects.toThrow(/stop.*program|close.*REPL/i);
      expect(signal?.aborted).toBe(false);
      expect(transport.writeFileBytes).not.toHaveBeenCalled();
    } finally { closed.resolve(); await running; }
  });

  it('restores a mounted session only after verifying the same USB identity without a REPL probe', async () => {
    const { manager, transport } = fixture();
    const renumbered = { ...board, path: '/dev/ttyACM9' };
    transport.discover.mockResolvedValue([renumbered]);
    await manager.restoreFileSystemSession(board, 'saved-session');
    expect(manager.fileSystemSession).toBe('saved-session');
    expect(manager.state).toMatchObject({ phase: 'connected', port: renumbered });
    expect(transport.probe).not.toHaveBeenCalled();
    await manager.readFileBytes('/data', 'saved-session');
    expect(transport.readFileBytes).toHaveBeenCalledWith(renumbered, '/data', expect.any(AbortSignal));
  });

  it('does not restore a filesystem session onto a different or unidentified board', async () => {
    const { manager, transport } = fixture();
    transport.discover.mockResolvedValue([{ ...board, serialNumber: 'OTHER' }]);
    await expect(manager.restoreFileSystemSession(board, 'saved-session')).rejects.toMatchObject({ code: 'Unavailable' });
    expect(manager.fileSystemSession).toBeUndefined();
    expect(manager.state.phase).toBe('disconnected');
    await expect(manager.restoreFileSystemSession({ ...board, serialNumber: undefined }, 'saved-session'))
      .rejects.toMatchObject({ code: 'Unavailable' });
    expect(transport.discover).toHaveBeenCalledTimes(1);
  });

  it('invalidates file documents before flashing begins', async () => {
    const { manager } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const flashing = manager.flashFirmware(board, () => closed.promise);
    expect(manager.fileSystemSession).toBeUndefined();
    closed.resolve(); await flashing;
  });

  it('rejects late wizard requests without changing connection state during tool setup', async () => {
    let busy = false;
    const { manager, transport } = fixture({}, () => busy);
    await manager.connect(board);
    await manager.disconnect();
    busy = true;
    let flashStarted = false;
    await expect(manager.connect(board)).rejects.toThrow(/tool setup.*progress/i);
    await expect(manager.flashFirmware(board, async () => { flashStarted = true; })).rejects.toThrow(/tool setup.*progress/i);
    await expect(manager.discover()).rejects.toThrow(/tool setup.*progress/i);
    expect(manager.state.phase).toBe('disconnected');
    expect(transport.probe).toHaveBeenCalledTimes(1);
    expect(transport.discover).not.toHaveBeenCalled();
    expect(flashStarted).toBe(false);
  });

  it('does not cancel the current serial owner for a connection request rejected during setup', async () => {
    let busy = false;
    const { manager, transport } = fixture({}, () => busy);
    await manager.connect(board);
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _file, activeSignal) => {
      signal = activeSignal; return closed.promise;
    });
    const running = manager.runFile('/main.py');
    await settle();
    busy = true;
    const connecting = manager.connect(board);
    const outcome = connecting.catch(error => error);
    try {
      expect(signal?.aborted).toBe(false);
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/tool setup.*progress/i) });
      expect(manager.state.phase).toBe('running');
    } finally {
      closed.resolve();
      await Promise.all([running, outcome]);
    }
  });

  it('rejects device commands submitted during setup even if setup finishes before the queue runs', async () => {
    let busy = false;
    const { manager, transport } = fixture({}, () => busy);
    await manager.connect(board);
    busy = true;
    const run = manager.runFile('/main.py');
    const repl = manager.openRepl();
    const upload = manager.uploadFile('/local/main.py', '/main.py');
    const outcomes = [run, repl, upload].map(command => command.catch(error => error));
    busy = false;
    for (const outcome of outcomes) {
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/tool setup.*progress/i) });
    }
    expect(transport.runFile).not.toHaveBeenCalled();
    expect(transport.openRepl).not.toHaveBeenCalled();
    expect(transport.uploadFile).not.toHaveBeenCalled();
    expect(manager.state.phase).toBe('connected');
  });

  it('blocks queued serial acquisitions when tool setup begins before they launch', async () => {
    let busy = false;
    const { manager, transport } = fixture({}, () => busy);
    await manager.connect(board);
    const closed = deferred<void>();
    transport.uploadFile.mockReturnValueOnce(closed.promise);
    const first = manager.uploadFile('/local/a.py', '/a.py');
    await settle();
    const queued = manager.uploadFile('/local/b.py', '/b.py');
    const outcome = queued.catch(error => error);
    busy = true;
    closed.resolve();
    await first;
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/tool setup.*progress/i) });
    expect(transport.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('still disconnects and waits for serial closure while tool setup is busy', async () => {
    let busy = false;
    const { manager, transport } = fixture({}, () => busy);
    await manager.connect(board);
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _file, activeSignal) => {
      signal = activeSignal; return closed.promise;
    });
    const running = manager.runFile('/main.py');
    await settle();
    busy = true;
    let disconnected = false;
    const disconnecting = manager.disconnect().then(() => { disconnected = true; });
    try {
      await settle();
      expect(signal?.aborted).toBe(true);
      expect(disconnected).toBe(false);
    } finally {
      closed.resolve();
      await Promise.all([running, disconnecting]);
    }
    expect(manager.state.phase).toBe('disconnected');
    await manager.dispose();
  });

  it('flashes an unconnected blank board without probing MicroPython and stays disconnected', async () => {
    const { manager, transport } = fixture();
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    const flashing = manager.flashFirmware(board, activeSignal => {
      signal = activeSignal;
      return closed.promise;
    });
    expect(manager.state).toMatchObject({ phase: 'flashing', port: board });
    await settle();
    expect(signal?.aborted).toBe(false);
    expect(transport.probe).not.toHaveBeenCalled();
    closed.resolve();
    await flashing;
    expect(manager.state.phase).toBe('disconnected');
    await expect(manager.readFile('/main.py')).rejects.toThrow(/connect/i);
    expect(transport.readFile).not.toHaveBeenCalled();
  });

  it('stays disconnected when firmware flashing fails', async () => {
    const { manager, transport } = fixture();
    await expect(manager.flashFirmware(board, async () => {
      throw new Error('Bootloader refused firmware');
    })).rejects.toThrow('Bootloader refused firmware');
    expect(manager.state.phase).toBe('disconnected');
    expect(transport.probe).not.toHaveBeenCalled();
  });

  it('cancels running code and queued work before waiting for serial closure to flash', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    let runSignal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _file, signal) => {
      runSignal = signal;
      return closed.promise;
    });
    const running = manager.runFile('/main.py');
    await settle();
    const queued = manager.uploadFile('/local/main.py', '/main.py').catch(error => error);
    let flashStarted = false;
    try {
      const flashing = manager.flashFirmware(board, async () => { flashStarted = true; });
      expect(runSignal?.aborted).toBe(true);
      expect(manager.state.phase).toBe('flashing');
      await settle();
      expect(flashStarted).toBe(false);
      expect(transport.uploadFile).not.toHaveBeenCalled();
      closed.reject(new Error('run cancelled; process closed'));
      await Promise.all([running, flashing]);
      expect((await queued).name).toBe('AbortError');
      expect(flashStarted).toBe(true);
      expect(manager.state.phase).toBe('disconnected');
      expect(transport.runFile).toHaveBeenCalledTimes(1);
      expect(transport.probe).toHaveBeenCalledTimes(1);
    } finally {
      closed.resolve();
      await Promise.all([running, queued]);
    }
  });

  it('waits for confirmed REPL exit before starting firmware flashing', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const close = vi.fn(async () => {});
    transport.openRepl.mockResolvedValue({ closed: closed.promise, close, show: () => {} });
    await manager.openRepl();
    let flashStarted = false;
    try {
      const flashing = manager.flashFirmware(board, async () => { flashStarted = true; });
      await settle();
      expect(close).toHaveBeenCalledTimes(1);
      expect(flashStarted).toBe(false);
      expect(manager.state.phase).toBe('flashing');
      closed.resolve();
      await flashing;
      expect(flashStarted).toBe(true);
      expect(manager.state.phase).toBe('disconnected');
    } finally {
      closed.resolve();
    }
  });

  it('refuses to flash when an uncertain REPL serial handle cannot be closed', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const close = vi.fn<InteractiveSession['close']>().mockRejectedValue(new Error('Process still alive'));
    transport.openRepl.mockResolvedValue({ closed: closed.promise, close, show: () => {} });
    await manager.openRepl();
    closed.reject(new Error('Could not verify process exit'));
    await settle();
    let flashStarted = false;
    try {
      await expect(manager.flashFirmware(board, async () => { flashStarted = true; })).rejects.toThrow('Process still alive');
      expect(flashStarted).toBe(false);
      expect(manager.state.phase).toBe('disconnected');
      expect(transport.probe).toHaveBeenCalledTimes(1);
    } finally {
      close.mockResolvedValue(undefined);
    }
  });

  it('ignores bootloader re-enumeration and cancels outstanding discovery during flashing', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const discovery = deferred<DevicePort[]>();
    let discoverySignal: AbortSignal | undefined;
    transport.discover.mockImplementation(signal => {
      discoverySignal = signal;
      return discovery.promise;
    });
    manager.start();
    await settle();
    const closed = deferred<void>();
    try {
      const flashing = manager.flashFirmware(board, () => closed.promise);
      expect(discoverySignal?.aborted).toBe(true);
      discovery.resolve([{ ...board, path: '/dev/ttyACM9' }]);
      await vi.advanceTimersByTimeAsync(200);
      expect(manager.state.phase).toBe('flashing');
      expect(transport.discover).toHaveBeenCalledTimes(1);
      closed.resolve();
      await flashing;
      await vi.advanceTimersByTimeAsync(200);
      expect(manager.state.phase).toBe('disconnected');
      expect(transport.discover).toHaveBeenCalledTimes(1);
      expect(transport.probe).toHaveBeenCalledTimes(1);
      expect(transport.runFile).not.toHaveBeenCalled();
    } finally {
      discovery.resolve([]);
      closed.resolve();
    }
  });

  it('rejects connect and a competing flash without interrupting the current flash', async () => {
    const { manager, transport } = fixture();
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    let secondStarted = false;
    const flashing = manager.flashFirmware(board, activeSignal => {
      signal = activeSignal;
      return closed.promise;
    });
    try {
      await expect(manager.connect(board)).rejects.toThrow(/flash/i);
      await expect(manager.flashFirmware(board, async () => { secondStarted = true; })).rejects.toThrow(/flash/i);
      await settle();
      expect(signal?.aborted).toBe(false);
      expect(secondStarted).toBe(false);
      expect(manager.state.phase).toBe('flashing');
      expect(transport.probe).not.toHaveBeenCalled();
    } finally {
      closed.resolve();
      await flashing;
    }
  });

  it('prevents ordinary device operations from acquiring the port while flashing', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const flashing = manager.flashFirmware(board, () => closed.promise);
    const commands = [
      manager.runFile('/main.py'), manager.uploadFile('/local/main.py', '/main.py'),
      manager.readFile('/main.py'), manager.openRepl(), manager.stop(),
    ].map(command => command.catch(error => error));
    try {
      await settle();
      expect(transport.runFile).not.toHaveBeenCalled();
      expect(transport.uploadFile).not.toHaveBeenCalled();
      expect(transport.readFile).not.toHaveBeenCalled();
      expect(transport.openRepl).not.toHaveBeenCalled();
      expect(transport.stop).not.toHaveBeenCalled();
      closed.resolve();
      await flashing;
      for (const result of await Promise.all(commands)) expect(result).toBeInstanceOf(Error);
    } finally {
      closed.resolve();
      await Promise.all([flashing, ...commands]);
    }
  });

  it('disconnect aborts flashing and waits for closure before a newer connection can start', async () => {
    const { manager, transport } = fixture();
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    const flashing = manager.flashFirmware(board, activeSignal => {
      signal = activeSignal;
      return closed.promise;
    });
    const flashResult = expect(flashing).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    let finished = false;
    const disconnecting = manager.disconnect().then(() => { finished = true; });
    const newerPort = { ...board, path: '/dev/ttyACM8' };
    const connecting = manager.connect(newerPort);
    try {
      await settle();
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(false);
      expect(manager.state.phase).toBe('disconnected');
      expect(transport.probe).not.toHaveBeenCalled();
      closed.resolve();
      await Promise.all([flashResult, disconnecting, connecting]);
      expect(manager.state).toMatchObject({ phase: 'connected', port: newerPort });
      expect(transport.probe).toHaveBeenCalledTimes(1);
    } finally {
      closed.resolve();
      await Promise.all([flashResult, disconnecting, connecting]);
    }
  });

  it('disposal aborts flashing and waits for the flashing process to close', async () => {
    const { manager, transport } = fixture();
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    const flashing = manager.flashFirmware(board, activeSignal => {
      signal = activeSignal;
      return closed.promise;
    });
    const flashResult = expect(flashing).rejects.toThrow(/disposed|cancel/i);
    await settle();
    let finished = false;
    const disposing = manager.dispose().then(() => { finished = true; });
    try {
      await settle();
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(false);
      closed.resolve();
      await Promise.all([flashResult, disposing]);
      expect(manager.state.phase).toBe('disconnected');
      expect(transport.probe).not.toHaveBeenCalled();
      await expect(manager.flashFirmware(board, async () => {})).rejects.toThrow(/disposed/i);
    } finally {
      closed.resolve();
      await Promise.all([flashResult, disposing]);
    }
  });

  it('does not enumerate at activation and still allows explicit discovery', async () => {
    const { manager, transport } = fixture();
    manager.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(transport.discover).not.toHaveBeenCalled();
    expect(await manager.discover()).toEqual([board]);
    expect(transport.discover).toHaveBeenCalledTimes(1);
    expect(transport.probe).not.toHaveBeenCalled();
    expect(manager.state.phase).toBe('disconnected');
  });

  it('requires an explicit successful probe before the first connection', async () => {
    const { manager, transport } = fixture();
    const probe = deferred<void>();
    transport.probe.mockReturnValue(probe.promise);
    const connecting = manager.connect(board);
    await settle();
    expect(manager.state.phase).toBe('connecting');
    probe.resolve();
    await connecting;
    expect(manager.state).toMatchObject({ phase: 'connected', port: board });
  });

  it('keeps a busy or permission failure distinct from device disappearance', async () => {
    const { manager, transport } = fixture();
    transport.probe.mockRejectedValueOnce(new Error('Permission denied: serial busy'));
    await expect(manager.connect(board)).rejects.toThrow('Permission denied');
    expect(manager.state.phase).toBe('error');
    manager.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(transport.probe).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('error');
  });

  it('serializes simultaneous file operations under one serial owner', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const upload = deferred<void>();
    transport.uploadFile.mockReturnValueOnce(upload.promise);
    const first = manager.uploadFile('/local/a.py', '/a.py');
    const second = manager.uploadFile('/local/b.py', '/b.py');
    await settle();
    expect(transport.uploadFile).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('busy');
    upload.resolve();
    await Promise.all([first, second]);
    expect(transport.uploadFile.mock.calls.map(call => call[2])).toEqual(['/a.py', '/b.py']);
    expect(manager.state.phase).toBe('connected');
  });

  it('exposes running until process exit and returns connected after completion', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const process = deferred<void>();
    transport.runFile.mockReturnValue(process.promise);
    const running = manager.runFile('/project/main.py');
    await settle();
    expect(manager.state.phase).toBe('running');
    process.resolve();
    await running;
    expect(manager.state.phase).toBe('connected');
  });

  it('waits for a cancelled run to close before stop opens the serial device', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _file, activeSignal) => {
      signal = activeSignal;
      return closed.promise;
    });
    const running = manager.runFile('/project/main.py');
    await settle();
    const stopping = manager.stop();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(transport.stop).not.toHaveBeenCalled();
    closed.reject(new Error('aborted'));
    await Promise.all([running, stopping]);
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('connected');
  });

  it('can stop a run requested in the same tick before it starts', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    transport.runFile.mockImplementation((_port, _file, signal) => new Promise<void>(resolve => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    }));
    await Promise.all([manager.runFile('/main.py'), manager.stop()]);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses background file reads and downloads while code is running', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const process = deferred<void>();
    transport.runFile.mockReturnValue(process.promise);
    const running = manager.runFile('/main.py');
    await settle();
    await expect(manager.listFiles('/')).rejects.toThrow(/running|stop/i);
    await expect(manager.readFile('/main.py')).rejects.toThrow(/running|stop/i);
    await expect(manager.downloadFile('/main.py', '/tmp/main.py')).rejects.toThrow(/running|stop/i);
    expect(transport.listFiles).not.toHaveBeenCalled();
    expect(transport.readFile).not.toHaveBeenCalled();
    process.resolve();
    await running;
  });

  it('closes the REPL and waits for its exit before an explicit upload', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const session: InteractiveSession = {
      closed: closed.promise, show: vi.fn(), close: vi.fn(async () => undefined),
    };
    transport.openRepl.mockResolvedValue(session);
    await manager.openRepl();
    expect(manager.state.phase).toBe('repl');
    await expect(manager.listFiles('/')).rejects.toThrow(/REPL|stop/i);
    const uploading = manager.uploadFile('/local/boot.py', '/boot.py');
    await settle();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(transport.uploadFile).not.toHaveBeenCalled();
    closed.resolve();
    await uploading;
    expect(manager.state.phase).toBe('connected');
  });

  it('returns connected when the user naturally closes the REPL', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    transport.openRepl.mockResolvedValue({ closed: closed.promise, close: async () => {}, show: () => {} });
    await manager.openRepl();
    closed.resolve();
    await settle();
    expect(manager.state.phase).toBe('connected');
  });

  it('retains an uncertain REPL lease when its exit observer fails', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const closed = deferred<void>();
    const close = vi.fn<InteractiveSession['close']>().mockRejectedValue(new Error('Process still alive'));
    transport.openRepl.mockResolvedValue({ closed: closed.promise, close, show: () => {} });
    await manager.openRepl();
    closed.reject(new Error('Could not verify serial process exit'));
    await settle();
    expect(manager.state.phase).toBe('error');
    await expect(manager.uploadFile('/local/main.py', '/main.py')).rejects.toThrow();
    await expect(manager.connect(board)).rejects.toThrow('Process still alive');
    expect(transport.uploadFile).not.toHaveBeenCalled();
    expect(transport.probe).toHaveBeenCalledTimes(1);
    close.mockResolvedValue(undefined);
    await manager.connect(board);
    expect(manager.state.phase).toBe('connected');
    expect(transport.probe).toHaveBeenCalledTimes(2);
  });

  it('retains connection after a user program error', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    transport.runFile.mockRejectedValue(new Error('ValueError: bad user code'));
    await expect(manager.runFile('/main.py')).rejects.toThrow('ValueError');
    expect(manager.state.phase).toBe('connected');
    expect(manager.state.message).toContain('ValueError');
  });

  it('retains connection after upload failure and allows a subsequent operation', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    transport.uploadFile.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(manager.uploadFile('/local/main.py', '/main.py')).rejects.toThrow('Permission denied');
    expect(manager.state.phase).toBe('connected');
    expect(await manager.readFile('/main.py')).toBe('print(42)');
  });

  it('reconnects the same identity on a new port without probing or replaying code', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const session = manager.fileSystemSession;
    await manager.runFile('/main.py');
    manager.start();
    await settle();
    transport.discover.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state.phase).toBe('reconnecting');
    const newPort = { ...board, path: '/dev/ttyACM7' };
    transport.discover.mockResolvedValue([newPort]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state).toMatchObject({ phase: 'connected', port: newPort });
    expect(manager.fileSystemSession).toBe(session);
    expect(transport.probe).toHaveBeenCalledTimes(1);
    expect(transport.runFile).toHaveBeenCalledTimes(1);
  });

  it('updates a changed port even when both poll snapshots contain the same identity', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    manager.start();
    await settle();
    const moved = { ...board, path: '/dev/ttyACM5' };
    transport.discover.mockResolvedValue([moved]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state).toMatchObject({ phase: 'connected', port: moved });
    await manager.uploadFile('/local/main.py', '/main.py');
    expect(transport.uploadFile.mock.calls[0]?.[0].path).toBe('/dev/ttyACM5');
    expect(transport.probe).toHaveBeenCalledTimes(1);
  });

  it('does not follow a renamed port when automatic reconnection is disabled', async () => {
    const { manager, transport } = fixture({ autoReconnect: false });
    await manager.connect(board);
    manager.start();
    await settle();
    transport.discover.mockResolvedValue([{ ...board, path: '/dev/ttyACM5' }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state.phase).toBe('disconnected');
  });

  it('never substitutes a reused path, absent stable identity, or different USB model', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    manager.start();
    await settle();
    for (const candidate of [
      { ...board, serialNumber: 'BOARD-2' },
      { ...board, serialNumber: undefined },
      { ...board, productId: '9999' },
    ]) {
      transport.discover.mockResolvedValue([candidate]);
      await vi.advanceTimersByTimeAsync(50);
      expect(manager.state.phase).toBe('reconnecting');
    }
  });

  it('allows a manually selected device without a stable identity to return at its path', async () => {
    const { manager, transport } = fixture();
    const manual = { ...board, serialNumber: undefined };
    await manager.connect(manual);
    const session = manager.fileSystemSession!;
    transport.discover.mockResolvedValue([]);
    manager.start();
    await settle();
    expect(manager.state.phase).toBe('reconnecting');
    expect(manager.fileSystemSession).toBeUndefined();
    transport.discover.mockResolvedValue([manual]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state.phase).toBe('connected');
    expect(manager.fileSystemSession).not.toBe(session);
    await expect(manager.writeFileBytes('/main.py', new Uint8Array(), { create: true, overwrite: true }, session))
      .rejects.toMatchObject({ code: 'Unavailable' });
    expect(transport.writeFileBytes).not.toHaveBeenCalled();
  });

  it('does not interpret a failed enumeration as hardware removal', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    transport.discover.mockRejectedValue(new Error('enumeration temporarily failed'));
    manager.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.state.phase).toBe('connected');
    expect(manager.state.message).toContain('enumeration temporarily failed');
    expect(transport.probe).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when automatic reconnection is disabled', async () => {
    const { manager, transport } = fixture({ autoReconnect: false });
    await manager.connect(board);
    transport.discover.mockResolvedValue([]);
    manager.start();
    await settle();
    expect(manager.state.phase).toBe('disconnected');
    transport.discover.mockResolvedValue([board]);
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.state.phase).toBe('disconnected');
    expect(transport.probe).toHaveBeenCalledTimes(1);
  });

  it('disconnect aborts discovery and prevents stale results from reconnecting', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const discovery = deferred<DevicePort[]>();
    let signal: AbortSignal | undefined;
    transport.discover.mockImplementation(activeSignal => { signal = activeSignal; return discovery.promise; });
    manager.start();
    await settle();
    await manager.disconnect();
    expect(signal?.aborted).toBe(true);
    discovery.resolve([board]);
    await settle();
    expect(manager.state.phase).toBe('disconnected');
  });

  it('stops background enumeration after explicit disconnect', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    manager.start();
    await settle();
    expect(transport.discover).toHaveBeenCalledTimes(1);
    await manager.disconnect();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.discover).toHaveBeenCalledTimes(1);
    expect(await manager.discover()).toEqual([board]);
    expect(transport.discover).toHaveBeenCalledTimes(2);
    expect(manager.state.phase).toBe('disconnected');
  });

  it('disconnect invalidates queued work and waits for the current serial process to exit', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const process = deferred<void>();
    transport.uploadFile.mockReturnValueOnce(process.promise);
    const uploading = manager.uploadFile('/local/a.py', '/a.py').catch(() => {});
    await settle();
    const queued = manager.uploadFile('/local/b.py', '/b.py');
    const queuedResult = expect(queued).rejects.toThrow(/cancel|disconnect|changed/i);
    let finished = false;
    const disconnecting = manager.disconnect().then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    process.resolve();
    await Promise.all([uploading, queuedResult, disconnecting]);
    expect(transport.uploadFile).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('disconnected');
  });

  it('disconnect cannot be undone by a probe that resolves after cancellation', async () => {
    const { manager, transport } = fixture();
    const probe = deferred<void>();
    transport.probe.mockReturnValue(probe.promise);
    const connecting = manager.connect(board);
    const connectResult = expect(connecting).rejects.toThrow(/cancel|disconnect|changed/i);
    await settle();
    const disconnecting = manager.disconnect();
    probe.resolve();
    await Promise.all([connectResult, disconnecting]);
    expect(manager.state.phase).toBe('disconnected');
  });

  it('closes a REPL that finishes launching after explicit disconnect', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    const launch = deferred<InteractiveSession>();
    const closed = deferred<void>();
    const close = vi.fn(async () => { closed.resolve(); });
    transport.openRepl.mockReturnValue(launch.promise);
    const opening = manager.openRepl();
    const openingResult = expect(opening).rejects.toThrow(/cancel|changed/i);
    await settle();
    const disconnecting = manager.disconnect();
    launch.resolve({ closed: closed.promise, close, show: () => {} });
    await Promise.all([openingResult, disconnecting]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.state.phase).toBe('disconnected');
  });

  it('cancels an unplugged run without replaying it when the board returns', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    let runSignal: AbortSignal | undefined;
    transport.runFile.mockImplementation((_port, _file, signal) => new Promise<void>(resolve => {
      runSignal = signal;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    }));
    const running = manager.runFile('/main.py');
    await settle();
    transport.discover.mockResolvedValue([]);
    manager.start();
    await settle();
    await running;
    expect(runSignal?.aborted).toBe(true);
    expect(manager.state.phase).toBe('reconnecting');
    transport.discover.mockResolvedValue([board]);
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.state.phase).toBe('connected');
    expect(transport.runFile).toHaveBeenCalledTimes(1);
  });

  it('soft reset preserves logical availability without a second probe or code replay', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    await manager.softReset();
    expect(transport.softReset).toHaveBeenCalledTimes(1);
    expect(transport.probe).toHaveBeenCalledTimes(1);
    expect(transport.runFile).not.toHaveBeenCalled();
    expect(manager.state.phase).toBe('connected');
  });

  it('notifies observers and stops notifying removed listeners', async () => {
    const { manager } = fixture();
    const phases: string[] = [];
    const remove = manager.onDidChange(state => phases.push(state.phase));
    await manager.connect(board);
    expect(phases).toEqual(['connecting', 'connected']);
    remove();
    await manager.disconnect();
    expect(phases).toEqual(['connecting', 'connected']);
  });

  it('disposal stops enumeration and rejects further commands', async () => {
    const { manager, transport } = fixture();
    await manager.connect(board);
    manager.start();
    await settle();
    await manager.dispose();
    const before = transport.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.discover).toHaveBeenCalledTimes(before);
    await expect(manager.connect(board)).rejects.toThrow(/disposed/i);
  });
});
