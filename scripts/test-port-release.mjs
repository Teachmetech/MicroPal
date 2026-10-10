import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// Native ownership/signal integration uses only disposable PTYs, never a board.
if (!['darwin', 'linux'].includes(process.platform)) {
  console.log('Serial-port release integration requires macOS or Linux.');
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'micropal-port-release-'));
try {
  const bundle = await build({
    stdin: {
      contents: "export { SerialPortOwners, SerialPortReleaseError } from './src/transport/serialPortOwners'; export { NodeProcessRunner } from './src/transport/processRunner';",
      resolveDir: resolve('.'), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
  });
  const bundlePath = join(directory, 'serial-owners.cjs');
  await writeFile(bundlePath, bundle.outputFiles[0].contents);
  const { SerialPortOwners, SerialPortReleaseError, NodeProcessRunner } = createRequire(import.meta.url)(bundlePath);
  const inspector = new SerialPortOwners(new NodeProcessRunner());
  for (const ignoreTermination of [false, true]) {
    const child = spawn('python3', ['-u', '-c', [
      'import os, pty, signal, time',
      'master, slave = pty.openpty()',
      ignoreTermination ? 'signal.signal(signal.SIGTERM, signal.SIG_IGN)' : '',
      'print(os.ttyname(slave), flush=True)',
      'while True: time.sleep(1)',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const closed = once(child, 'close');
    try {
      let text = '';
      const portPath = await new Promise((resolvePort, reject) => {
        const timeout = setTimeout(() => reject(new Error('PTY child did not report a path.')), 5_000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('PTY child exited before reporting its path.')); });
        child.stdout.on('data', chunk => {
          text += chunk;
          if (!text.includes('\n')) return;
          clearTimeout(timeout);
          resolvePort(text.split('\n')[0].trim());
        });
      });
      const owners = await inspector.inspect(portPath);
      assert.deepEqual(owners.map(owner => owner.pid), [child.pid], 'Only the disposable child owns its PTY');
      assert.equal(owners[0].isMicroPalRepl, false, 'An arbitrary Python process is never automatically classified');
      assert.ok(owners[0].displayName, 'Native ps provides a process display name');
      if (ignoreTermination) {
        await assert.rejects(inspector.release(portPath, owners), error =>
          error instanceof SerialPortReleaseError && error.code === 'StillBusy');
        assert.equal(child.exitCode, null, 'SIGTERM-resistant owner survives ordinary release');
        await inspector.release(portPath, owners, { force: true });
      } else {
        await inspector.release(portPath, owners);
      }
      const [, signal] = await closed;
      assert.equal(signal, ignoreTermination ? 'SIGKILL' : 'SIGTERM');
      assert.deepEqual(await inspector.inspect(portPath), [], 'The port has no remaining owners');
      console.log(`Disposable PTY ${ignoreTermination ? 'explicit force' : 'ordinary'} release passed.`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
