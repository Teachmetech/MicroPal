import type { ExtensionContext } from 'vscode';
import type { DeviceManager } from '../core/deviceManager';

/** A revoked URI must remain revoked when a mounted workspace restarts its host. */
export class DeviceSessionPersistence {
  private observedSession: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: Error[] = [];
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly context: Pick<ExtensionContext, 'globalState'>,
    private readonly device: Pick<DeviceManager, 'fileSystemSession' | 'onDidChange'>,
  ) {
    this.observedSession = device.fileSystemSession;
    this.unsubscribe = device.onDidChange(() => {
      if (!this.disposed) this.observe();
    });
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.failures.length === 1) throw this.failures[0];
    if (this.failures.length > 1) {
      throw new AggregateError(this.failures, this.failures.map(error => error.message).join('\n'));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // Connect invalidates its old session synchronously, before a queued state
    // event. Capture that transition without revoking an unchanged active mount.
    this.observe();
    this.disposed = true;
    this.unsubscribe();
  }

  private observe(): void {
    const current = this.device.fileSystemSession;
    const previous = this.observedSession;
    this.observedSession = current;
    if (!previous || previous === current) return;
    const failed = (error: unknown): void => {
      const detail = error instanceof Error ? error.message : String(error);
      this.failures.push(new Error(`Could not revoke the saved ESP32 file session: ${detail}`, { cause: error }));
    };
    try {
      // Start the durable deletion inside the event, not in a later flush.
      const update = this.context.globalState.update(`microPal.mount.${previous}`, undefined);
      const tracked: Promise<void> = Promise.resolve(update).catch(failed).finally(() => { this.pending.delete(tracked); });
      this.pending.add(tracked);
    } catch (error) { failed(error); }
  }
}
