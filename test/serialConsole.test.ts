import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandSpec, DevicePort, ProcessOptions, ProcessRunner } from '../src/core/types';
import { NodeProcessRunner } from '../src/transport/processRunner';
import { SerialConsole } from '../src/transport/serialConsole';

const board: DevicePort = { path: '/dev/stale', serialNumber: 'BOARD-1', vendorId: '303a', productId: '1001', description: 'ESP32', likelyEsp32: true };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function abortError() { const error = new Error('cancelled'); error.name = 'AbortError'; return error; }
function fixture() {
  const finished = deferred<CommandResult>();
  let call!: { spec: CommandSpec; options: ProcessOptions };
  const runner: ProcessRunner = { run: vi.fn((spec, options = {}) => { call = { spec, options }; return finished.promise; }) };
  const output: string[] = [];
  const show = vi.fn();
  const console = new SerialConsole(runner, () => '/managed env/bin/python', text => output.push(text), show);
  return { console, runner, output, show, finished, get call() { return call; }, ready() {
    call.options.onOutput?.(`\x1eMICROPAL_READY_${call.spec.args.at(-1)}\x1f`);
  } };
}
async function turn() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe('SerialConsole', () => {
  it('waits for a split readiness marker and keeps it out of streamed board output', async () => {
    const f = fixture();
    let ready = false;
    const opening = f.console.open(board).then(session => { ready = true; return session; });
    await turn();
    expect(ready).toBe(false);
    expect(f.call.spec.executable).toBe('/managed env/bin/python');
    expect(f.call.spec.args.slice(0, 3)).toEqual(['-I', '-u', '-c']);
    const marker = `\x1eMICROPAL_READY_${f.call.spec.args.at(-1)}\x1f`;
    f.call.options.onOutput?.(marker.slice(0, 10)); await turn();
    expect(ready).toBe(false);
    f.call.options.onOutput?.(marker.slice(10) + 'boot\n');
    const session = await opening;
    f.call.options.onOutput?.('héllo\n'); session.show();
    expect(f.output).toEqual(['boot\n', 'héllo\n']);
    expect(f.show).toHaveBeenCalledOnce();
    f.finished.resolve({ stdout: '', stderr: '' }); await session.closed;
  });

  it('does not permit handoff until the cancelled reader process has closed', async () => {
    const f = fixture(); const opening = f.console.open(board); await turn(); f.ready();
    const session = await opening;
    let released = false;
    const closing = session.close().then(() => { released = true; });
    await turn();
    expect(f.call.options.signal?.aborted).toBe(true);
    expect(released).toBe(false);
    f.finished.reject(abortError()); await closing; await session.closed;
    expect(released).toBe(true);
  });

  it('cancels a startup timeout and waits for verified process closure before rejecting', async () => {
    vi.useFakeTimers();
    const f = fixture(); let failed = false;
    const opening = f.console.open(board).catch(error => { failed = true; return error; });
    await turn(); await vi.advanceTimersByTimeAsync(8000);
    expect(f.call.options.signal?.aborted).toBe(true);
    expect(failed).toBe(false);
    f.finished.reject(abortError());
    expect((await opening).message).toMatch(/timed out/i);
  });

  it('preserves an original serial-open failure for explicit Connect recovery', async () => {
    const f = fixture();
    const error = new Error('failed to access /dev/stale (it may be in use by another program)');
    const opening = f.console.open(board); await turn(); f.finished.reject(error);
    await expect(opening).rejects.toBe(error);
  });

  it('rejects startup after confirmed closure if displaying the first output chunk throws', async () => {
    const f = fixture(); const displayError = new Error('Output display failed');
    const console = new SerialConsole(f.runner, () => '/managed/python', () => { throw displayError; }, () => {});
    let settled = false;
    const opening = console.open(board).catch(error => { settled = true; return error; });
    await turn();
    expect(() => f.call.options.onOutput?.(`\x1eMICROPAL_READY_${f.call.spec.args.at(-1)}\x1fboot`)).toThrow(displayError);
    f.finished.reject(displayError);
    for (let index = 0; index < 10; index += 1) await turn();
    expect(settled).toBe(true);
    expect(await opening).toBe(displayError);
  });

  it('rejects an aborted startup without spawning a process', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.console.open(board, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('requires a managed interpreter instead of choosing a global Python', async () => {
    const f = fixture(); const console = new SerialConsole(f.runner, () => undefined, () => {}, () => {});
    await expect(console.open(board)).rejects.toThrow(/Set Up Tools/);
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('cancels an in-flight startup without exposing late output', async () => {
    const f = fixture(); const abort = new AbortController();
    const opening = f.console.open(board, abort.signal); await turn(); abort.abort();
    f.ready(); f.call.options.onOutput?.('late board output'); f.finished.reject(abortError());
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.output).toEqual([]);
  });

  it('runs the real Python helper against a serial fixture without board writes or resets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'micropal-console-'));
    let session: Awaited<ReturnType<SerialConsole['open']>> | undefined;
    try {
      await mkdir(join(dir, 'serial', 'tools'), { recursive: true });
      await writeFile(join(dir, 'serial', 'tools', '__init__.py'), '');
      await writeFile(join(dir, 'serial', 'tools', 'list_ports.py'), `from types import SimpleNamespace\ndef comports():\n return [SimpleNamespace(device='RENAMED-PORT', serial_number='BOARD-1', vid=0x303a, pid=0x1001)]\n`);
      await writeFile(join(dir, 'serial', '__init__.py'), `import json, time\nclass Serial:\n def __init__(self, port=None, **kwargs):\n  assert port is None\n  self.dtr = True\n  self.rts = True\n  self._chunks = [b'boot\\n', 'main.py: héllo\\n'.encode('utf8')]\n def open(self):\n  assert self.dtr is False and self.rts is False\n  assert self.baudrate == 115200 and self.timeout == 0.1\n  with open(${JSON.stringify(join(dir, 'opened.json'))}, 'w') as f: json.dump({'port': self.port}, f)\n def read(self, size):\n  assert 0 < size <= 4096\n  if self._chunks: return self._chunks.pop(0)\n  time.sleep(0.05)\n  return b''\n def write(self, data): raise AssertionError('Must never write to the board')\n def reset_input_buffer(self): raise AssertionError('Must not discard boot output')\n def close(self): pass\n`);
      const actualRunner = new NodeProcessRunner();
      const runner: ProcessRunner = { run: (spec, options) => {
        const args = [...spec.args]; const index = args.indexOf('-c') + 1;
        args[index] = `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\n` + args[index];
        return actualRunner.run({ ...spec, args }, options);
      } };
      let output = '';
      const console = new SerialConsole(runner, () => process.platform === 'win32' ? 'python' : 'python3', text => { output += text; }, () => {});
      session = await console.open(board);
      const deadline = Date.now() + 3000;
      while (!output.includes('main.py: héllo\n') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(output).toBe('boot\nmain.py: héllo\n');
      expect(JSON.parse(await readFile(join(dir, 'opened.json'), 'utf8'))).toEqual({ port: 'RENAMED-PORT' });
      await session.close(); await session.closed;
    } finally { await session?.close(); await rm(dir, { recursive: true, force: true }); }
  }, 10_000);
});
