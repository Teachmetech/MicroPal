import { randomUUID } from 'node:crypto';
import { DeviceFileSystemError } from './fileErrors';
import type {
  ConnectionState, DeviceFile, DeviceFileStat, DevicePort, DeviceSettings, DeviceTransport, DeviceWriteOptions, InteractiveSession,
} from './types';

type Owner = {
  kind: 'command' | 'run' | 'repl';
  controller?: AbortController;
  session?: InteractiveSession;
  completion: Promise<void>;
  closureFailure?: string;
};

function cancelled(): Error {
  const error = new Error('Device operation cancelled because the connection changed.');
  error.name = 'AbortError';
  return error;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function flashingInProgress(): Error {
  return new Error('Firmware flashing is in progress. Wait for it to finish or disconnect to cancel it.');
}
function toolSetupInProgress(): Error {
  return new Error('MicroPal tool setup is in progress. Finish or cancel setup before using device commands.');
}

/** Serial ownership is separate from logical availability: idle means no open handle. */
export class DeviceManager {
  private current: ConnectionState = { phase: 'disconnected' };
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private tail: Promise<void> = Promise.resolve();
  private owner?: Owner;
  private selected?: DevicePort;
  private fileSession?: string;
  private revision = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly discoveries = new Set<AbortController>();
  private discoveryIssue?: string;

  constructor(
    private readonly transport: DeviceTransport,
    private readonly settings: () => DeviceSettings,
    private readonly pollIntervalMs = 2000,
    private readonly toolsBusy: () => boolean = () => false,
  ) {}

  get state(): ConnectionState {
    return { ...this.current, port: this.current.port && { ...this.current.port } };
  }

  get fileSystemSession(): string | undefined { return this.fileSession; }
  get connectionRevision(): number { return this.revision; }

  onDidChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.disposed || this.timer) return;
    // Monitor only an explicitly selected device. Opening a board here would
    // interrupt boot.py/main.py; unused editor windows must not spawn discovery.
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async discover(): Promise<DevicePort[]> {
    if (this.disposed) throw new Error('Device manager is disposed.');
    if (this.toolsBusy()) throw toolSetupInProgress();
    const controller = new AbortController();
    this.discoveries.add(controller);
    try {
      const ports = await this.transport.discover(controller.signal);
      if (controller.signal.aborted) throw cancelled();
      return ports;
    } finally {
      this.discoveries.delete(controller);
    }
  }

  connect(port: DevicePort): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Device manager is disposed.'));
    if (this.toolsBusy()) return Promise.reject(toolSetupInProgress());
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.invalidate();
    this.selected = undefined;
    this.fileSession = undefined;
    return this.enqueue(revision, async () => {
      await this.releaseOwner();
      this.assertCurrent(revision);
      this.change({ phase: 'connecting', port });
      try {
        const { result } = this.process('command', signal => this.transport.probe(port, signal));
        await result;
        this.assertCurrent(revision);
        this.selected = { ...port };
        this.fileSession = randomUUID();
        this.change({ phase: 'connected', port });
      } catch (error) {
        if (this.isCurrent(revision)) this.change({ phase: 'error', port, message: errorMessage(error) });
        throw error;
      }
    });
  }

  /** A workspace mount can restart the extension host. Restore only a verified USB identity. */
  restoreFileSystemSession(port: DevicePort, session: string): Promise<void> {
    if (!port.serialNumber || !/^[a-z0-9-]+$/.test(session)) {
      return Promise.reject(new DeviceFileSystemError('Unavailable',
        'Reconnect the board and open ESP32 Files again. Its saved USB identity is unavailable.'));
    }
    if (this.disposed) return Promise.reject(new Error('Device manager is disposed.'));
    if (this.toolsBusy()) return Promise.reject(toolSetupInProgress());
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.invalidate();
    this.selected = undefined;
    this.fileSession = undefined;
    return this.enqueue(revision, async () => {
      await this.releaseOwner();
      this.assertCurrent(revision);
      try {
        const { result } = this.process('command', signal => this.transport.discover(signal));
        const ports = await result;
        this.assertCurrent(revision);
        const match = ports.find(candidate => this.matches(port, candidate));
        if (!match) throw new DeviceFileSystemError('Unavailable',
          'The board for ESP32 Files is unavailable. Connect it and open ESP32 Files again.');
        this.selected = { ...match };
        this.fileSession = session;
        this.change({ phase: 'connected', port: match });
      } catch (error) {
        if (this.isCurrent(revision)) this.change({ phase: 'disconnected', message: errorMessage(error) });
        throw error;
      }
    });
  }

  flashFirmware(port: DevicePort, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Device manager is disposed.'));
    if (this.toolsBusy()) return Promise.reject(toolSetupInProgress());
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.invalidate();
    // Bootloader enumeration is unrelated to a MicroPython connection. Stop
    // monitoring the previous identity before its serial handle is released.
    this.selected = undefined;
    this.fileSession = undefined;
    this.change({ phase: 'flashing', port });
    return this.enqueue(revision, async () => {
      try {
        await this.releaseOwner();
        this.assertCurrent(revision);
        const { result } = this.process('command', action);
        await result;
        this.assertCurrent(revision);
      } finally {
        // Flashing never restores a MicroPython connection, and an older flash
        // must not overwrite a later disconnect or explicit connection.
        if (this.isCurrent(revision)) this.change({ phase: 'disconnected' });
      }
    });
  }

  disconnect(): Promise<void> {
    this.invalidate();
    this.selected = undefined;
    this.fileSession = undefined;
    this.change({ phase: 'disconnected' });
    // Cleanup cannot be invalidated: a later connect must wait for handle closure.
    return this.append(() => this.releaseOwner());
  }

  runFile(localPath: string): Promise<void> {
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.revision;
    // Only the launch is queued. The caller still waits for program completion,
    // while a later Stop/Upload/REPL command can cancel this serial owner.
    return this.enqueue(revision, async () => {
      const port = this.commandPort();
      await this.releaseOwner();
      this.assertCurrent(revision);
      this.change({ phase: 'running', port, message: `Running ${localPath}` });
      const { owner, result } = this.process('run', signal => this.transport.runFile(port, localPath, signal));
      const completion = result.then(
        () => { if (this.isCurrent(revision)) this.change({ phase: 'connected', port: this.selected }); },
        error => {
          if (this.isCurrent(revision)) {
            this.change({ phase: 'connected', port: this.selected,
              message: owner.controller?.signal.aborted ? undefined : errorMessage(error) });
          }
          // Stopping an intentionally cancelled run is successful from the user's perspective.
          if (!owner.controller?.signal.aborted) throw error;
        },
      );
      // Attach a rejection handler before returning through the launch queue.
      void completion.catch(() => {});
      return { completion };
    }).then(({ completion }) => completion);
  }

  uploadFile(localPath: string, remotePath: string): Promise<void> {
    return this.command('Uploading file', true, (port, signal) => this.transport.uploadFile(port, localPath, remotePath, signal));
  }

  stop(): Promise<void> {
    return this.command('Stopping execution', true, (port, signal) => this.transport.stop(port, signal));
  }

  softReset(): Promise<void> {
    return this.command('Soft reset', true, (port, signal) => this.transport.softReset(port, signal));
  }

  listFiles(remotePath: string, expectedSession?: string): Promise<DeviceFile[]> {
    return this.command('Reading device files', false, (port, signal) => this.transport.listFiles(port, remotePath, signal), expectedSession);
  }

  readFile(remotePath: string, expectedSession?: string): Promise<string> {
    return this.command('Reading device file', false, (port, signal) => this.transport.readFile(port, remotePath, signal), expectedSession);
  }

  downloadFile(remotePath: string, localPath: string, expectedSession?: string): Promise<void> {
    return this.command('Downloading device file', false,
      (port, signal) => this.transport.downloadFile(port, remotePath, localPath, signal), expectedSession);
  }

  statFile(path: string, expectedSession?: string): Promise<DeviceFileStat> {
    return this.command('Inspecting device file', false,
      (port, signal) => this.transport.statFile(port, path, signal), expectedSession);
  }

  readFileBytes(path: string, expectedSession?: string): Promise<Uint8Array> {
    return this.command('Reading device file', false,
      (port, signal) => this.transport.readFileBytes(port, path, signal), expectedSession);
  }

  writeFileBytes(path: string, content: Uint8Array, options: DeviceWriteOptions, expectedSession?: string): Promise<void> {
    return this.command('Saving device file', false,
      (port, signal) => this.transport.writeFileBytes(port, path, content, options, signal), expectedSession);
  }

  createDirectory(path: string, expectedSession?: string): Promise<void> {
    return this.command('Creating device folder', false,
      (port, signal) => this.transport.createDirectory(port, path, signal), expectedSession);
  }

  deleteFile(path: string, options: { recursive: boolean }, expectedSession?: string): Promise<void> {
    return this.command('Deleting device file', false,
      (port, signal) => this.transport.deleteFile(port, path, options, signal), expectedSession);
  }

  renameFile(oldPath: string, newPath: string, options: { overwrite: boolean }, expectedSession?: string): Promise<void> {
    return this.command('Renaming device file', false,
      (port, signal) => this.transport.renameFile(port, oldPath, newPath, options, signal), expectedSession);
  }

  openRepl(): Promise<void> {
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.revision;
    return this.enqueue(revision, async () => {
      const port = this.commandPort();
      if (this.owner?.kind === 'repl') { this.owner.session?.show(); return; }
      await this.releaseOwner();
      this.assertCurrent(revision);
      this.change({ phase: 'busy', port, message: 'Opening REPL' });
      try {
        // Launching is itself inside the queue. A disconnect during launch waits
        // for the resulting session to close before allowing any next owner.
        const session = await this.transport.openRepl(port);
        const owner: Owner = { kind: 'repl', session, completion: Promise.resolve() };
        this.owner = owner;
        owner.completion = session.closed.then(
          () => this.finishRepl(owner, revision),
          error => {
            // A failed exit observer does not prove that the serial handle is free.
            owner.closureFailure = errorMessage(error);
            if (this.isCurrent(revision)) this.change({ phase: 'error', port, message: owner.closureFailure });
          },
        );
        if (!this.isCurrent(revision)) {
          await this.releaseOwner();
          throw cancelled();
        }
        this.change({ phase: 'repl', port });
        session.show();
      } catch (error) {
        if (this.isCurrent(revision)) this.change({ phase: 'connected', port: this.selected, message: errorMessage(error) });
        throw error;
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) { await this.tail; return; }
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.disconnect();
    this.listeners.clear();
  }

  private command<T>(
    message: string,
    mayInterrupt: boolean,
    action: (port: DevicePort, signal: AbortSignal) => Promise<T>,
    expectedSession?: string,
  ): Promise<T> {
    try { this.assertFileSession(expectedSession); } catch (error) { return Promise.reject(error); }
    if (this.current.phase === 'flashing') return Promise.reject(flashingInProgress());
    const revision = this.revision;
    return this.enqueue(revision, async () => {
      this.assertFileSession(expectedSession);
      const port = this.commandPort();
      if (!mayInterrupt && (this.owner?.kind === 'run' || this.owner?.kind === 'repl')) {
        throw new Error('Stop the running program or close the REPL before accessing device files.');
      }
      await this.releaseOwner();
      this.assertCurrent(revision);
      this.change({ phase: 'busy', port, message });
      let failure: string | undefined;
      try {
        const { result } = this.process('command', signal => action(port, signal));
        const value = await result;
        this.assertCurrent(revision);
        return value;
      } catch (error) {
        failure = errorMessage(error);
        throw error;
      } finally {
        if (this.isCurrent(revision)) this.change({ phase: 'connected', port: this.selected, message: failure });
      }
    });
  }

  private assertFileSession(expectedSession?: string): void {
    if (expectedSession !== undefined && expectedSession !== this.fileSession) {
      throw new DeviceFileSystemError('Unavailable',
        'This file belongs to a previous connection. Reopen it from ESP32 Files on the connected board.');
    }
  }

  private process<T>(kind: 'command' | 'run', action: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const owner: Owner = { kind, controller, completion: Promise.resolve() };
    this.owner = owner;
    const result = Promise.resolve().then(() => action(controller.signal)).finally(() => {
      if (this.owner === owner) this.owner = undefined;
    });
    owner.completion = result.then(() => {}, () => {});
    return { owner, result };
  }

  private async releaseOwner(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    owner.controller?.abort();
    const retryingFailedClosure = owner.closureFailure !== undefined;
    if (owner.session) await owner.session.close();
    // A fresh successful close can recover from an earlier failed exit observer.
    // close() must only resolve once its process is verified to have exited.
    if (!retryingFailedClosure) {
      await owner.completion;
      if (owner.closureFailure) throw new Error(owner.closureFailure);
    }
    if (this.owner === owner) this.owner = undefined;
  }

  private finishRepl(owner: Owner, revision: number, message?: string): void {
    if (this.owner !== owner) return;
    this.owner = undefined;
    if (this.isCurrent(revision)) this.change({ phase: 'connected', port: this.selected, message });
  }

  private commandPort(): DevicePort {
    if (!this.selected || ['disconnected', 'connecting', 'reconnecting', 'error'].includes(this.current.phase)) {
      throw new Error('Connect a device before running this command.');
    }
    return this.selected;
  }

  private invalidate(): number {
    this.revision += 1;
    this.owner?.controller?.abort();
    for (const controller of this.discoveries) controller.abort();
    return this.revision;
  }

  private isCurrent(revision: number): boolean { return !this.disposed && revision === this.revision; }
  private assertCurrent(revision: number): void {
    if (this.disposed) throw new Error('Device manager is disposed.');
    if (revision !== this.revision) throw cancelled();
  }
  private enqueue<T>(revision: number, action: () => Promise<T>): Promise<T> {
    if (this.toolsBusy()) return Promise.reject(toolSetupInProgress());
    return this.append(async () => {
      this.assertCurrent(revision);
      if (this.toolsBusy()) throw toolSetupInProgress();
      return action();
    });
  }
  private append<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private change(state: ConnectionState): void {
    this.current = { ...state, port: state.port && { ...state.port } };
    for (const listener of this.listeners) {
      // One observer must not prevent resource cleanup or other observers.
      try { listener(this.state); } catch { /* observers own their errors */ }
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.polling || !this.selected) return;
    this.polling = true;
    const revision = this.revision;
    try {
      const ports = await this.discover();
      if (!this.isCurrent(revision)) return;
      if (this.discoveryIssue && this.current.message === this.discoveryIssue) {
        this.change({ ...this.current, message: undefined });
      }
      this.discoveryIssue = undefined;
      const selected = this.selected;
      if (!selected) return;
      const match = ports.find(port => this.matches(selected, port));
      if (!match) {
        if (this.current.phase === 'reconnecting') return;
        const nextRevision = this.invalidate();
        // Port paths alone cannot prove that the same physical board returned.
        if (!selected.serialNumber || !this.settings().autoReconnect) this.fileSession = undefined;
        if (this.settings().autoReconnect) {
          this.change({ phase: 'reconnecting', port: selected, message: 'Waiting for the selected device to reappear.' });
        } else {
          this.selected = undefined;
          this.change({ phase: 'disconnected', message: 'Device disconnected. Automatic reconnection is disabled.' });
        }
        await this.enqueue(nextRevision, () => this.releaseOwner());
      } else if (this.current.phase === 'reconnecting' || match.path !== selected.path) {
        const nextRevision = match.path !== selected.path ? this.invalidate() : revision;
        if (!this.settings().autoReconnect) {
          this.selected = undefined;
          this.fileSession = undefined;
          this.change({ phase: 'disconnected', message: 'Automatic reconnection is disabled.' });
          await this.enqueue(nextRevision, () => this.releaseOwner());
          return;
        }
        if (match.path !== selected.path) this.change({ phase: 'reconnecting', port: selected });
        await this.enqueue(nextRevision, async () => {
          await this.releaseOwner();
          this.assertCurrent(nextRevision);
          this.selected = { ...match };
          this.fileSession ??= randomUUID();
          // Presence restores availability, without entering raw REPL or
          // interrupting whatever the board's boot files are running.
          this.change({ phase: 'connected', port: match, message: 'Device rediscovered; available for commands.' });
        });
      }
    } catch (error) {
      // Enumeration failure is not evidence that a board was unplugged.
      if (this.isCurrent(revision)) {
        const message = `Device discovery failed: ${errorMessage(error)}`;
        if (message !== this.discoveryIssue) this.change({ ...this.current, message });
        this.discoveryIssue = message;
      }
    } finally {
      this.polling = false;
    }
  }

  private matches(selected: DevicePort, candidate: DevicePort): boolean {
    if (!selected.serialNumber) return selected.path === candidate.path;
    return selected.serialNumber === candidate.serialNumber
      && (!selected.vendorId || selected.vendorId.toLowerCase() === candidate.vendorId?.toLowerCase())
      && (!selected.productId || selected.productId.toLowerCase() === candidate.productId?.toLowerCase());
  }
}
