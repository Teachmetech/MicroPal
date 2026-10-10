import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// Explicit integration test: downloads pinned Python packages into a disposable
// private environment. This is separate from npm run check and uses no hardware.
const directory = await mkdtemp(join(tmpdir(), 'micropal-managed-smoke-'));
const logPath = join(directory, 'setup.log');
let log = '';
let tools;
let succeeded = false;
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
const previousPipConfig = process.env.PIP_CONFIG_FILE;
process.once('SIGINT', cancel);
try {
  const bundle = await build({
    stdin: {
      contents: "export { ManagedTools } from './src/tools/managedTools'; export { NodeProcessRunner } from './src/transport/processRunner';",
      resolveDir: resolve('.'), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
  });
  const bundlePath = join(directory, 'managed-tools.cjs');
  await writeFile(bundlePath, bundle.outputFiles[0].contents);
  const { ManagedTools, NodeProcessRunner } = createRequire(import.meta.url)(bundlePath);
  const runner = new NodeProcessRunner();
  const root = join(directory, 'storage with spaces');
  const pipConfig = join(directory, 'conflicting-pip.conf');
  await writeFile(pipConfig, '[global]\nno-index = true\n');
  process.env.PIP_CONFIG_FILE = pipConfig;
  tools = new ManagedTools(root, runner, text => { log += text; });
  await tools.initialize();
  assert.equal(tools.paths, undefined, 'Fresh profiles do not have managed tools');
  const paths = await tools.setup({
    pythonPath: process.argv[2]?.trim() || undefined, signal: cancellation.signal,
    onProgress: message => console.log(message),
  });
  for (const [name, expected] of [['esptool', '5.0.2'], ['mpremote', '1.29.0']]) {
    const result = await runner.run({ executable: paths[`${name}Path`], args: ['version'] }, { timeoutMs: 30_000 });
    assert.ok(result.stdout.includes(expected), `${name} reports the pinned version`);
    console.log(`${name}: ${result.stdout.trim()}`);
  }
  const reloaded = new ManagedTools(root, runner, text => { log += text; });
  await reloaded.initialize();
  assert.deepEqual(reloaded.paths, paths, 'The verified environment survives extension reload');
  assert.deepEqual(await reloaded.setup(), paths, 'Normal setup reuses verified tools');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(reloaded.setup({ repair: true, signal: aborted.signal }), { name: 'AbortError' });
  assert.deepEqual(reloaded.paths, paths, 'Cancelled repair preserves the working environment');
  await reloaded.dispose();
  succeeded = true;
  console.log('Managed setup integration passed: real installation with conflicting pip configuration, executable versions, reload, reuse, and cancelled repair.');
} catch (error) {
  await writeFile(logPath, log);
  console.error(`Setup log: ${logPath}`);
  console.error(log.slice(-4000));
  throw error;
} finally {
  process.removeListener('SIGINT', cancel);
  if (previousPipConfig === undefined) delete process.env.PIP_CONFIG_FILE;
  else process.env.PIP_CONFIG_FILE = previousPipConfig;
  await tools?.dispose();
  // Retain failure diagnostics, but remove all installed packages on success.
  if (succeeded) await rm(directory, { recursive: true, force: true });
}
