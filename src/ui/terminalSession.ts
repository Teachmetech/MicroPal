import type { CommandSpec, InteractiveSession, ReplLauncher } from '../core/types';

export interface TerminalHandle {
  processId: PromiseLike<number | undefined>;
  show(): void;
  sendText(text: string, addNewLine: boolean): void;
  dispose(): void;
}
export interface TerminalHost {
  create(spec: CommandSpec): TerminalHandle;
  onClose(listener: (terminal: TerminalHandle) => void): () => void;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** VS Code close events may precede OS teardown after dispose(). Verify both. */
export async function waitForProcessExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new Error('Could not verify that the REPL process released its serial port. Close its terminal before retrying.');
    }
    await delay(50);
  }
  throw new Error('The REPL process has not exited. Close its terminal before retrying the device command.');
}

export function createTerminalLauncher(
  host: TerminalHost,
  waitExit: (pid: number | undefined) => Promise<void> = waitForProcessExit,
  graceMs = 750,
): ReplLauncher {
  return async spec => {
    let terminal: TerminalHandle;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    let closedEvent = false;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    // Attach an early handler: closing the editor can happen before a caller subscribes.
    void closed.catch(() => undefined);
    const unsubscribe = host.onClose(item => {
      if (item !== terminal || closedEvent) return;
      closedEvent = true;
      unsubscribe();
      void Promise.resolve(terminal.processId).then(waitExit).then(resolveClosed, rejectClosed);
    });
    try { terminal = host.create(spec); }
    catch (error) { unsubscribe(); throw error; }
    let closing: Promise<void> | undefined;
    const session: InteractiveSession = {
      closed,
      show: () => terminal.show(),
      close: () => {
        closing ??= (async () => {
          // A rejected closed promise means verification failed, not that the
          // handle is gone. A later explicit close may verify it again.
          if (closedEvent) { await Promise.resolve(terminal.processId).then(waitExit); return; }
          if (!closedEvent) {
            // Ctrl-X is handled locally by mpremote, not sent as a board interrupt.
            terminal.sendText('\x18', false);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
            } finally { if (timer) clearTimeout(timer); }
            if (!closedEvent) terminal.dispose();
          }
          // A failed release rejects rather than permitting a competing owner.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([closed, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('REPL terminal did not close. Close it manually and reconnect.')), 6000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        })().catch(error => { closing = undefined; throw error; });
        return closing;
      },
    };
    session.show();
    return session;
  };
}
