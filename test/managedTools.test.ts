import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CommandResult, ProcessOptions, ProcessRunner } from '../src/core/types';
import { ManagedTools } from '../src/tools/managedTools';

const roots: string[] = [];
const services: ManagedTools[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function aborted() { const error = new Error('Cancelled'); error.name = 'AbortError'; return error; }
function result(value: unknown): CommandResult { return { stdout: JSON.stringify(value), stderr: '' }; }

/** Doubles only the external Python/pip processes; service filesystem work is real. */
function runnerDouble(platform: NodeJS.Platform = 'darwin') {
  const scripts = platform === 'win32' ? 'Scripts' : 'bin';
  const pythonName = platform === 'win32' ? 'python.exe' : 'python';
  const toolName = (tool: string) => `${tool}${platform === 'win32' ? '.exe' : ''}`;
  const control = {
    candidates: new Map<string, { version: number[]; executable: string } | Error>(),
    failPip: undefined as Error | undefined,
    failVenv: undefined as Error | undefined,
    pip: undefined as ((options: ProcessOptions) => Promise<void>) | undefined,
    verify: undefined as (() => void) | undefined,
    packages: { esptool: '5.0.2', mpremote: '1.29.0' },
    skipTool: undefined as string | undefined,
  };
  const executable = async (path: string) => { await writeFile(path, 'fixture executable'); await chmod(path, 0o755); };
  const run = vi.fn<ProcessRunner['run']>(async (spec, options = {}) => {
    if (options.signal?.aborted) throw aborted();
    if (spec.args.includes('venv')) {
      const environment = spec.args.at(-1)!;
      await mkdir(join(environment, scripts), { recursive: true });
      await executable(join(environment, scripts, pythonName));
      if (control.failVenv) throw control.failVenv;
      return { stdout: '', stderr: '' };
    }
    if (spec.args.includes('pip')) {
      options.onOutput?.('Downloading pinned tools\n');
      if (control.pip) await control.pip(options);
      if (control.failPip) throw control.failPip;
      for (const tool of ['esptool', 'mpremote']) {
        if (control.skipTool !== tool) await executable(join(dirname(spec.executable), toolName(tool)));
      }
      return { stdout: '', stderr: '' };
    }
    if (spec.args.some(arg => arg.includes('importlib.metadata'))) {
      control.verify?.();
      return result({ version: [3, 11, 9], executable: spec.executable,
        prefix: dirname(dirname(spec.executable)), packages: control.packages });
    }
    const candidate = control.candidates.get(spec.executable + (spec.args[0] === '-3' ? ' -3' : ''));
    if (candidate instanceof Error) throw candidate;
    return result(candidate ?? { version: [3, 11, 9],
      executable: platform === 'win32' ? 'C:\\Python311\\python.exe' : '/usr/local/bin/python3' });
  });
  return { run, control };
}
async function fixture(platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'micropal-tools-'));
  roots.push(root);
  const storage = join(root, 'private tools');
  const runner = runnerDouble(platform);
  const output = vi.fn<(text: string) => void>();
  const service = new ManagedTools(storage, runner, output, platform);
  services.push(service);
  return { storage, runner, output, service };
}
function environmentOf(pythonPath: string) { return dirname(dirname(pythonPath)); }
async function environments(storage: string) { return (await readdir(storage)).filter(name => name.startsWith('env-')); }

describe('ManagedTools', () => {
  it('initializes an empty installation without creating files or launching Python', async () => {
    const { storage, runner, service } = await fixture();
    await service.initialize();
    expect(service.paths).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
    await expect(access(storage)).rejects.toThrow();
  });

  it('creates a private pinned environment, streams progress, and reloads verified readiness', async () => {
    const { storage, runner, output, service } = await fixture();
    const progress: string[] = [];
    const paths = await service.setup({ onProgress: message => progress.push(message) });
    expect(paths.pythonPath).toBe(join(environmentOf(paths.pythonPath), 'bin', 'python'));
    expect(paths.mpremotePath).toBe(join(environmentOf(paths.pythonPath), 'bin', 'mpremote'));
    expect(paths.esptoolPath).toBe(join(environmentOf(paths.pythonPath), 'bin', 'esptool'));
    expect(environmentOf(paths.pythonPath)).toMatch(new RegExp(`^${storage}/env-`));
    const creation = runner.run.mock.calls.find(([spec]) => spec.args.includes('venv'))!;
    expect(creation[0]).toEqual({ executable: '/usr/local/bin/python3',
      args: ['-I', '-m', 'venv', environmentOf(paths.pythonPath)] });
    const install = runner.run.mock.calls.find(([spec]) => spec.args.includes('pip'))!;
    expect(install[0].executable).toBe(paths.pythonPath);
    expect(install[0].args).toEqual(['-I', '-m', 'pip', '--isolated', 'install', '--no-input',
      '--index-url', 'https://pypi.org/simple', '--no-cache-dir', 'esptool==5.0.2', 'mpremote==1.29.0']);
    expect(install[1]?.timeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(output.mock.calls.flat().join('')).toContain('Downloading pinned tools');
    expect(progress.some(message => /Python/i.test(message))).toBe(true);
    expect(progress.some(message => /install/i.test(message))).toBe(true);
    expect(progress.some(message => /verif/i.test(message))).toBe(true);
    const manifest = JSON.parse(await readFile(join(storage, 'tools.json'), 'utf8'));
    expect(manifest).toEqual({ schema: 1, environment: basename(environmentOf(paths.pythonPath)),
      pins: { esptool: '5.0.2', mpremote: '1.29.0' } });
    expect(service.busy).toBe(false);
    const reloadRunner = runnerDouble();
    const reload = new ManagedTools(storage, reloadRunner, output);
    services.push(reload);
    await reload.initialize();
    expect(reload.paths).toEqual(paths);
    expect(reloadRunner.run.mock.calls.every(([spec]) => !spec.args.includes('pip'))).toBe(true);
    const count = reloadRunner.run.mock.calls.length;
    expect(await reload.setup()).toEqual(paths);
    expect(reloadRunner.run).toHaveBeenCalledTimes(count);
    const copy = reload.paths!;
    copy.mpremotePath = '/changed';
    expect(reload.paths?.mpremotePath).toBe(paths.mpremotePath);
  });

  it('falls back from unavailable or old Python candidates and uses their actual interpreter', async () => {
    const { runner, service } = await fixture();
    runner.control.candidates.set('python3', { version: [3, 9, 20], executable: '/old/python3' });
    runner.control.candidates.set('python', { version: [3, 10, 16], executable: '/opt/Python 3.10/bin/python3' });
    await service.setup();
    expect(runner.run.mock.calls.slice(0, 2).map(([spec]) => spec.executable)).toEqual(['python3', 'python']);
    expect(runner.run.mock.calls.find(([spec]) => spec.args.includes('venv'))?.[0].executable)
      .toBe('/opt/Python 3.10/bin/python3');
  });

  it.each(['darwin', 'win32'] as const)('disables inherited pip configuration on %s', async platform => {
    const { runner, service } = await fixture(platform);
    await service.setup();
    const install = runner.run.mock.calls.find(([spec]) => spec.args.includes('pip'))!;
    expect(install[1]?.env).toEqual({ PIP_CONFIG_FILE: platform === 'win32' ? 'nul' : '/dev/null' });
    expect(install[0].args).toContain('--isolated');
  });

  it('explains missing venv support while preserving ready tools during a failed repair', async () => {
    const { storage, runner, service } = await fixture();
    const oldPaths = await service.setup();
    const manifest = await readFile(join(storage, 'tools.json'), 'utf8');
    runner.control.failVenv = new Error('No module named ensurepip');
    await expect(service.setup({ repair: true })).rejects.toThrow(/install.*Python.*venv.*ensurepip/i);
    expect(service.paths).toEqual(oldPaths);
    expect(await readFile(join(storage, 'tools.json'), 'utf8')).toBe(manifest);
    expect(await environments(storage)).toEqual([basename(environmentOf(oldPaths.pythonPath))]);
  });

  it('preserves cancellation errors from environment creation', async () => {
    const { storage, runner, service } = await fixture();
    runner.control.failVenv = aborted();
    await expect(service.setup()).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.paths).toBeUndefined();
    expect(await environments(storage)).toEqual([]);
    expect(runner.run.mock.calls.some(([spec]) => spec.args.includes('pip'))).toBe(false);
  });

  it('reports actionable missing Python errors without creating an environment', async () => {
    const { storage, runner, service } = await fixture();
    runner.control.candidates.set('python3', new Error('not found'));
    runner.control.candidates.set('python', new Error('not found'));
    await expect(service.setup()).rejects.toThrow(/Python 3\.10.*install|install.*Python 3\.10/i);
    expect(service.paths).toBeUndefined();
    expect(service.busy).toBe(false);
    await expect(access(storage)).rejects.toThrow();
  });

  it('reports an explicitly selected old Python without silently using another interpreter', async () => {
    const { runner, service } = await fixture();
    runner.control.candidates.set('/custom/python', { version: [3, 9, 2], executable: '/custom/python' });
    await expect(service.setup({ pythonPath: '/custom/python' })).rejects.toThrow(/3\.10/);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('uses the Windows launcher only for discovery and derives Windows environment executables', async () => {
    const { runner, service } = await fixture('win32');
    const paths = await service.setup();
    expect(runner.run.mock.calls[0]?.[0].executable).toBe('py');
    expect(runner.run.mock.calls[0]?.[0].args.slice(0, 3)).toEqual(['-3', '-I', '-c']);
    expect(runner.run.mock.calls.find(([spec]) => spec.args.includes('venv'))?.[0].executable)
      .toBe('C:\\Python311\\python.exe');
    expect(paths.pythonPath).toBe(join(environmentOf(paths.pythonPath), 'Scripts', 'python.exe'));
    expect(paths.mpremotePath).toBe(join(environmentOf(paths.pythonPath), 'Scripts', 'mpremote.exe'));
    expect(paths.esptoolPath).toBe(join(environmentOf(paths.pythonPath), 'Scripts', 'esptool.exe'));
  });

  it('tries Python and Python3 after a missing Windows launcher', async () => {
    const { runner, service } = await fixture('win32');
    runner.control.candidates.set('py -3', new Error('not found'));
    runner.control.candidates.set('python', new Error('not found'));
    await service.setup();
    expect(runner.run.mock.calls.slice(0, 3).map(([spec]) => spec.executable)).toEqual(['py', 'python', 'python3']);
  });

  it('keeps an explicit Python path containing spaces and shell syntax as one executable', async () => {
    const { runner, service } = await fixture();
    const pythonPath = '/opt/Python 3;$(touch nope)/python3';
    runner.control.candidates.set(pythonPath, { version: [3, 12, 7], executable: pythonPath });
    await service.setup({ pythonPath });
    expect(runner.run.mock.calls[0]?.[0]).toMatchObject({ executable: pythonPath, args: ['-I', '-c', expect.any(String)] });
    expect(runner.run.mock.calls.find(([spec]) => spec.args.includes('venv'))?.[0].executable).toBe(pythonPath);
  });

  it('rejects a non-absolute interpreter reported by Python', async () => {
    const { runner, service } = await fixture();
    runner.control.candidates.set('/custom/python', { version: [3, 11, 1], executable: 'python' });
    await expect(service.setup({ pythonPath: '/custom/python' })).rejects.toThrow(/absolute/i);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('verifies pinned package versions before publishing an installation', async () => {
    const { storage, runner, service } = await fixture();
    runner.control.packages.esptool = '4.8.0';
    await expect(service.setup()).rejects.toThrow(/esptool.*5\.0\.2/i);
    expect(service.paths).toBeUndefined();
    expect(await environments(storage)).toEqual([]);
    await expect(access(join(storage, 'tools.json'))).rejects.toThrow();
  });

  it('refuses readiness when a derived tool executable is missing', async () => {
    const { storage, runner, service } = await fixture();
    runner.control.skipTool = 'mpremote';
    await expect(service.setup()).rejects.toThrow(/mpremote/i);
    expect(service.paths).toBeUndefined();
    expect(await environments(storage)).toEqual([]);
  });

  it.each(['../outside', '/tmp/outside', '..\\outside', 'C:\\outside', '.', 'env-safe/../outside'])
  ('ignores an unsafe manifest environment %s without executing it', async environment => {
    const { storage, runner, service } = await fixture();
    await mkdir(storage);
    await writeFile(join(storage, 'tools.json'), JSON.stringify({ schema: 1, environment,
      pins: { esptool: '5.0.2', mpremote: '1.29.0' }, pythonPath: '/untrusted/python' }));
    await service.initialize();
    expect(service.paths).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('ignores a manifest for different package pins without executing its environment', async () => {
    const { storage, runner, service } = await fixture();
    await mkdir(storage);
    await writeFile(join(storage, 'tools.json'), JSON.stringify({ schema: 1, environment: 'env-old',
      pins: { esptool: '4.8.0', mpremote: '1.29.0' } }));
    await service.initialize();
    expect(service.paths).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('refuses a symlinked environment directory from the manifest', async () => {
    const { storage, runner, service } = await fixture();
    await mkdir(storage);
    const outside = join(dirname(storage), 'outside');
    await mkdir(outside);
    await symlink(outside, join(storage, 'env-linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(storage, 'tools.json'), JSON.stringify({ schema: 1, environment: 'env-linked',
      pins: { esptool: '5.0.2', mpremote: '1.29.0' } }));
    await service.initialize();
    expect(service.paths).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('repairs beside a ready environment and retains both successful environments', async () => {
    const { storage, runner, service } = await fixture();
    const oldPaths = await service.setup();
    const newPaths = await service.setup({ repair: true });
    expect(newPaths.pythonPath).not.toBe(oldPaths.pythonPath);
    expect(service.paths).toEqual(newPaths);
    expect(await environments(storage)).toHaveLength(2);
    await access(oldPaths.mpremotePath);
    const creations = runner.run.mock.calls.filter(([spec]) => spec.args.includes('venv'));
    expect(creations.map(([spec]) => spec.args.at(-1))).toEqual([
      environmentOf(oldPaths.pythonPath), environmentOf(newPaths.pythonPath),
    ]);
  });

  it('preserves ready tools and their manifest when a replacement install fails', async () => {
    const { storage, runner, service } = await fixture();
    const oldPaths = await service.setup();
    const manifest = await readFile(join(storage, 'tools.json'), 'utf8');
    runner.control.failPip = new Error('Network unavailable');
    await expect(service.setup({ repair: true })).rejects.toThrow('Network unavailable');
    expect(service.paths).toEqual(oldPaths);
    expect(await readFile(join(storage, 'tools.json'), 'utf8')).toBe(manifest);
    expect(await environments(storage)).toEqual([basename(environmentOf(oldPaths.pythonPath))]);
  });

  it('waits for a cancelled replacement process to close before deleting it', async () => {
    const { storage, runner, service } = await fixture();
    const oldPaths = await service.setup();
    const entered = deferred<void>();
    const closed = deferred<void>();
    runner.control.pip = async () => { entered.resolve(); await closed.promise; };
    const controller = new AbortController();
    const setup = service.setup({ repair: true, signal: controller.signal });
    const outcome = expect(setup).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    controller.abort();
    try {
      expect(service.busy).toBe(true);
      expect(await environments(storage)).toHaveLength(2);
      expect(service.paths).toEqual(oldPaths);
    } finally {
      closed.reject(aborted());
      await outcome;
    }
    expect(service.busy).toBe(false);
    expect(service.paths).toEqual(oldPaths);
    expect(await environments(storage)).toEqual([basename(environmentOf(oldPaths.pythonPath))]);
  });

  it('does not publish readiness when cancellation arrives after version validation', async () => {
    const { storage, runner, service } = await fixture();
    const controller = new AbortController();
    runner.control.verify = () => controller.abort();
    await expect(service.setup({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.paths).toBeUndefined();
    await expect(access(join(storage, 'tools.json'))).rejects.toThrow();
    expect(await environments(storage)).toEqual([]);
  });

  it('rejects a pre-cancelled setup without subprocess or filesystem side effects', async () => {
    const { storage, runner, service } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(service.setup({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(access(storage)).rejects.toThrow();
    expect(service.busy).toBe(false);
  });

  it('rejects concurrent setup and disposal waits for the cancelled process to close', async () => {
    const { storage, runner, service } = await fixture();
    const entered = deferred<void>();
    const closed = deferred<void>();
    let signal: AbortSignal | undefined;
    runner.control.pip = async options => { signal = options.signal; entered.resolve(); await closed.promise; };
    const setup = service.setup();
    const outcome = expect(setup).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    await expect(service.setup({ repair: true })).rejects.toThrow(/already|busy|progress/i);
    let finished = false;
    const disposing = service.dispose().then(() => { finished = true; });
    try {
      await Promise.resolve();
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(false);
      expect(await environments(storage)).toHaveLength(1);
    } finally {
      closed.resolve();
      await Promise.all([outcome, disposing]);
    }
    expect(service.paths).toBeUndefined();
    expect(await environments(storage)).toEqual([]);
    await expect(service.setup()).rejects.toThrow(/disposed/i);
  });
});
