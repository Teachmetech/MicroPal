import { describe, expect, it, vi } from 'vitest';
import { createTerminalLauncher, type TerminalHost, type TerminalHandle } from '../src/ui/terminalSession';

function setup() {
  let closed: ((terminal: TerminalHandle) => void) | undefined;
  const handle: TerminalHandle = { processId: Promise.resolve(41), show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() };
  const host: TerminalHost = { create: vi.fn(() => handle), onClose: cb => { closed = cb; return () => { closed = undefined; }; } };
  return { handle, host, exit: () => closed?.(handle) };
}
describe('real terminal ownership', () => {
  it('passes executable and arguments separately and shows the terminal', async () => {
    const s = setup();
    const launcher = createTerminalLauncher(s.host, async () => undefined, 5);
    const spec = { executable: '/path with spaces/mpremote', args: ['connect', '/dev/cu.device', 'repl'] };
    const session = await launcher(spec);
    expect(s.host.create).toHaveBeenCalledWith(spec);
    session.show(); expect(s.handle.show).toHaveBeenCalled();
    s.exit(); await session.closed;
  });
  it('does not release ownership until the terminal AND process have exited', async () => {
    const s = setup(); let release!: () => void;
    const waitExit = new Promise<void>(r => { release = r; });
    const session = await createTerminalLauncher(s.host, () => waitExit, 5)({ executable: 'mpremote', args: ['repl'] });
    const closing = session.close(); let done = false; void closing.then(() => { done = true; });
    expect(s.handle.sendText).toHaveBeenCalledWith('\x18', false);
    s.exit(); await Promise.resolve(); await Promise.resolve();
    expect(done).toBe(false);
    release(); await closing; expect(done).toBe(true);
  });
  it('can retry OS verification after a failed terminal release', async () => {
    const s = setup();
    const waitExit = vi.fn().mockRejectedValueOnce(new Error('still running')).mockResolvedValue(undefined);
    const session = await createTerminalLauncher(s.host, waitExit, 5)({ executable: 'mpremote', args: ['repl'] });
    s.exit();
    await expect(session.closed).rejects.toThrow('still running');
    await expect(session.close()).resolves.toBeUndefined();
    expect(waitExit).toHaveBeenCalledTimes(2);
  });
  it('disposes an unresponsive terminal after the graceful exit deadline', async () => {
    const s = setup();
    vi.mocked(s.handle.dispose).mockImplementation(s.exit);
    const session = await createTerminalLauncher(s.host, async () => undefined, 5)({ executable: 'mpremote', args: ['repl'] });
    await session.close(); expect(s.handle.dispose).toHaveBeenCalledOnce();
  });
});
