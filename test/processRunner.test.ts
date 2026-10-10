import { describe, expect, it } from 'vitest';
import { NodeProcessRunner, ProcessError } from '../src/transport/processRunner';

const runner = new NodeProcessRunner();
const node = (source: string, args: string[] = []) => ({
  executable: process.execPath,
  args: ['-e', source, '--', ...args],
});

describe('NodeProcessRunner', () => {
  it('scopes environment overrides to the child and inherits unspecified variables', async () => {
    const names = ['MICROPAL_RUNNER_OVERRIDE_TEST', 'MICROPAL_RUNNER_INHERITED_TEST', 'MICROPAL_RUNNER_ADDED_TEST'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.MICROPAL_RUNNER_OVERRIDE_TEST = 'parent value';
    process.env.MICROPAL_RUNNER_INHERITED_TEST = 'inherited value';
    delete process.env.MICROPAL_RUNNER_ADDED_TEST;
    const command = node(`process.stdout.write(JSON.stringify({
      overridden: process.env.MICROPAL_RUNNER_OVERRIDE_TEST,
      inherited: process.env.MICROPAL_RUNNER_INHERITED_TEST,
      added: process.env.MICROPAL_RUNNER_ADDED_TEST ?? null,
    }))`);
    try {
      const overridden = await runner.run(command, { env: {
        MICROPAL_RUNNER_OVERRIDE_TEST: 'child value', MICROPAL_RUNNER_ADDED_TEST: 'child addition',
      } });
      expect(JSON.parse(overridden.stdout)).toEqual({ overridden: 'child value', inherited: 'inherited value', added: 'child addition' });
      expect(process.env.MICROPAL_RUNNER_OVERRIDE_TEST).toBe('parent value');
      expect(process.env.MICROPAL_RUNNER_INHERITED_TEST).toBe('inherited value');
      expect(process.env.MICROPAL_RUNNER_ADDED_TEST).toBeUndefined();
      const inherited = await runner.run(command);
      expect(JSON.parse(inherited.stdout)).toEqual({ overridden: 'parent value', inherited: 'inherited value', added: null });
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it('passes filenames and shell metacharacters as literal arguments', async () => {
    const result = await runner.run(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', [
      'a file.py', ';echo unexpected', '$(echo unexpected)', 'quote"and\'apostrophe',
    ]));
    expect(JSON.parse(result.stdout)).toEqual([
      'a file.py', ';echo unexpected', '$(echo unexpected)', 'quote"and\'apostrophe',
    ]);
    expect(result.stderr).toBe('');
  });

  it('preserves stdout and stderr on nonzero exit', async () => {
    const error = await runner.run(node("process.stdout.write('partial'); process.stderr.write('port busy'); process.exitCode = 7"))
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({ code: 7, result: { stdout: 'partial', stderr: 'port busy' } });
    expect((error as Error).message).toContain('port busy');
  });

  it('reports a missing executable with a useful error', async () => {
    const error = await runner.run({ executable: 'micropal-executable-does-not-exist', args: [] })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({ code: 'ENOENT', result: { stdout: '', stderr: '' } });
    expect((error as Error).message).toMatch(/executable|install|PATH/i);
  });

  it('reports invalid executable settings as structured process errors', async () => {
    const error = await runner.run({ executable: '', args: [] }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({ code: 'ERR_INVALID_ARG_VALUE', result: { stdout: '', stderr: '' } });
  });

  it('times out a process and reports captured output', async () => {
    const error = await runner.run(node("process.stdout.write('ready'); setInterval(() => {}, 1000)"), { timeoutMs: 300 })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'ETIMEDOUT', result: { stdout: 'ready', stderr: '' } });
  });

  it('aborts without starting an already cancelled process', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runner.run({ executable: 'micropal-executable-does-not-exist', args: [] }, { signal: controller.signal })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
  });

  it('streams both outputs while also returning them', async () => {
    const chunks: string[] = [];
    const result = await runner.run(node("process.stdout.write('hello'); setTimeout(() => process.stderr.write('error'), 20)"), {
      timeoutMs: 0, onOutput: (text) => chunks.push(text),
    });
    expect(result).toEqual({ stdout: 'hello', stderr: 'error' });
    expect(chunks.join('')).toContain('hello');
    expect(chunks.join('')).toContain('error');
  });

  it('aborts only after the subprocess has closed', async () => {
    const controller = new AbortController();
    let pid = 0;
    const error = await runner.run(node("process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)"), {
      signal: controller.signal,
      onOutput: (text) => {
        pid = Number(text.trim());
        controller.abort();
      },
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('waits for graceful shutdown output before rejecting cancellation', async () => {
    const controller = new AbortController();
    const error = await runner.run(node(`
      process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('released'); process.exit(0); }, 100));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `), { signal: controller.signal, onOutput: (text) => { if (text.includes('ready')) controller.abort(); } })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError', result: { stdout: 'readyreleased', stderr: '' } });
  });

  it.skipIf(process.platform === 'win32')('forces termination when a process ignores SIGTERM', async () => {
    const controller = new AbortController();
    let pid = 0;
    const error = await runner.run(node(`
      process.on('SIGTERM', () => {});
      process.stdout.write(String(process.pid));
      setInterval(() => {}, 1000);
    `), { signal: controller.signal, onOutput: (text) => { pid = Number(text); controller.abort(); } })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('rejects oversized machine output with bounded captured data', async () => {
    const error = await runner.run(node("process.stdout.write('x'.repeat(9 * 1024 * 1024))"))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect((error as ProcessError).result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('streams long-running output completely while bounding captured data', async () => {
    let count = 0;
    const result = await runner.run(node("process.stdout.write('x'.repeat(9 * 1024 * 1024))"), {
      onOutput: (text) => { count += text.length; },
    });
    expect(count).toBe(9 * 1024 * 1024);
    expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
