import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import type { ProcessRunner } from '../core/types';

export const MANAGED_TOOL_PINS = { esptool: '5.0.2', mpremote: '1.29.0' } as const;
const PYTHON_INFO = 'import json, sys; print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable}))';
const TOOL_INFO = 'import importlib.metadata, json, sys; print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable, "prefix": sys.prefix, "packages": {name: importlib.metadata.version(name) for name in ("esptool", "mpremote")}}))';

export interface ManagedToolPaths { pythonPath: string; mpremotePath: string; esptoolPath: string; }
export interface SetupOptions {
  pythonPath?: string;
  repair?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function checkCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Tool setup cancelled.');
  error.name = 'AbortError';
  throw error;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Installs tools only on explicit request, without changing system Python. */
export class ManagedTools {
  private readonly root: string;
  private readonly lifetime = new AbortController();
  private ready?: ManagedToolPaths;
  private initialization?: Promise<void>;
  private initialized = false;
  private disposed = false;
  private active?: { controller: AbortController; completion: Promise<ManagedToolPaths> };

  constructor(
    storageRoot: string,
    private readonly runner: ProcessRunner,
    private readonly output: (text: string) => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) { this.root = resolve(storageRoot); }

  get paths(): ManagedToolPaths | undefined { return this.ready && { ...this.ready }; }
  get busy(): boolean { return this.active !== undefined; }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Managed tools service is disposed.'));
    if (this.initialized) return Promise.resolve();
    this.initialization ??= this.loadManifest().finally(() => { this.initialized = true; });
    return this.initialization;
  }

  setup(options: SetupOptions = {}): Promise<ManagedToolPaths> {
    if (options.signal?.aborted) {
      try { checkCancelled(options.signal); } catch (error) { return Promise.reject(error); }
    }
    if (this.disposed) return Promise.reject(new Error('Managed tools service is disposed.'));
    if (this.active) return Promise.reject(new Error('Tool setup is already in progress.'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const completion = this.install(options, controller.signal).finally(() => {
      options.signal?.removeEventListener('abort', abort);
      this.active = undefined;
    });
    this.active = { controller, completion };
    return completion;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    this.active?.controller.abort();
    await this.active?.completion.catch(() => {});
    await this.initialization?.catch(() => {});
  }

  private async install(options: SetupOptions, signal: AbortSignal): Promise<ManagedToolPaths> {
    let environment: string | undefined;
    let temporaryManifest: string | undefined;
    let published = false;
    const progress = (text: string) => {
      checkCancelled(signal);
      options.onProgress?.(text);
      this.output(`${text}\n`);
      checkCancelled(signal);
    };
    const stream = (text: string) => this.output(text);
    try {
      await this.initialize();
      checkCancelled(signal);
      if (this.ready && !options.repair) return { ...this.ready };
      progress('Finding Python 3.10 or newer…');
      const interpreter = await this.findPython(options.pythonPath, signal);
      checkCancelled(signal);
      await mkdir(this.root, { recursive: true });
      checkCancelled(signal);
      const basename = `env-${randomUUID()}`;
      const candidate = join(this.root, basename);
      await mkdir(candidate);
      environment = candidate;
      checkCancelled(signal);
      progress('Creating a private Python environment…');
      try {
        await this.runner.run({ executable: interpreter, args: ['-I', '-m', 'venv', environment] },
          { signal, timeoutMs: 120_000, onOutput: stream });
      } catch (error) {
        checkCancelled(signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error(`Could not create the private tool environment. Install Python 3.10 or newer with venv and ensurepip support, or set MicroPal: Python Path to another Python executable. ${message(error)}`);
      }
      checkCancelled(signal);
      const paths = this.environmentPaths(environment);
      progress(`Installing esptool ${MANAGED_TOOL_PINS.esptool} and mpremote ${MANAGED_TOOL_PINS.mpremote}…`);
      await this.runner.run({ executable: paths.pythonPath,
        args: ['-I', '-m', 'pip', '--isolated', 'install', '--no-input', '--index-url', 'https://pypi.org/simple',
          '--no-cache-dir', `esptool==${MANAGED_TOOL_PINS.esptool}`, `mpremote==${MANAGED_TOOL_PINS.mpremote}`] },
      { signal, timeoutMs: 600_000, onOutput: stream,
        // pip --isolated ignores user settings but still reads system/site
        // configuration. The null device disables all pip configuration files.
        env: { PIP_CONFIG_FILE: this.platform === 'win32' ? 'nul' : '/dev/null' } });
      checkCancelled(signal);
      progress('Verifying tool versions and executables…');
      await this.verifyEnvironment(paths, signal);
      checkCancelled(signal);
      progress('Saving the verified tool environment…');
      temporaryManifest = join(this.root, `.tools-${randomUUID()}.json`);
      await writeFile(temporaryManifest, JSON.stringify({ schema: 1, environment: basename, pins: MANAGED_TOOL_PINS }),
        { flag: 'wx', mode: 0o600 });
      checkCancelled(signal);
      // Environments keep their original paths: moving a venv breaks the
      // absolute shebangs written into its console scripts. Only switch a pointer.
      await rename(temporaryManifest, join(this.root, 'tools.json'));
      published = true;
      this.ready = paths;
      return { ...paths };
    } finally {
      if (temporaryManifest) await rm(temporaryManifest, { force: true });
      // Runner promises settle after subprocess closure; cleanup cannot race pip.
      // Retain every successful environment, which another editor may still use.
      if (environment && !published) await rm(environment, { recursive: true, force: true });
    }
  }

  private async findPython(explicit: string | undefined, signal: AbortSignal): Promise<string> {
    if (explicit !== undefined && (!explicit.trim() || /[\0\r\n]/.test(explicit))) {
      throw new Error('Select a Python 3.10 or newer executable path, without shell arguments.');
    }
    const candidates = explicit !== undefined ? [{ executable: explicit, args: [] as string[] }]
      : this.platform === 'win32'
        ? [{ executable: 'py', args: ['-3'] }, { executable: 'python', args: [] }, { executable: 'python3', args: [] }]
        : [{ executable: 'python3', args: [] }, { executable: 'python', args: [] }];
    const failures: string[] = [];
    for (const candidate of candidates) {
      checkCancelled(signal);
      try {
        const response = await this.runner.run({ executable: candidate.executable,
          args: [...candidate.args, '-I', '-c', PYTHON_INFO] }, { signal, timeoutMs: 15_000 });
        checkCancelled(signal);
        const info: unknown = JSON.parse(response.stdout.trim());
        return this.pythonInfo(info);
      } catch (error) {
        checkCancelled(signal);
        failures.push(`${candidate.executable}: ${message(error)}`);
      }
    }
    throw new Error(`Python 3.10 or newer is required. Install Python with venv and pip support, or set MicroPal: Python Path to an existing Python executable. ${failures.join('; ')}`);
  }

  private pythonInfo(info: unknown): string {
    if (!object(info) || !Array.isArray(info.version)
      || info.version.length < 2 || !info.version.every(part => Number.isInteger(part))) {
      throw new Error('Python did not report a valid interpreter version.');
    }
    const [major, minor] = info.version as number[];
    if (major! < 3 || (major === 3 && minor! < 10)) throw new Error('Python 3.10 or newer is required.');
    const executable = info.executable;
    if (typeof executable !== 'string' || /[\0\r\n]/.test(executable)
      || !(this.platform === 'win32' ? win32.isAbsolute(executable) : isAbsolute(executable))) {
      throw new Error('Python did not report an absolute executable path.');
    }
    return executable;
  }

  private environmentPaths(environment: string): ManagedToolPaths {
    const windows = this.platform === 'win32';
    const scripts = join(environment, windows ? 'Scripts' : 'bin');
    return { pythonPath: join(scripts, windows ? 'python.exe' : 'python'),
      mpremotePath: join(scripts, windows ? 'mpremote.exe' : 'mpremote'),
      esptoolPath: join(scripts, windows ? 'esptool.exe' : 'esptool') };
  }

  private async verifyEnvironment(paths: ManagedToolPaths, signal: AbortSignal): Promise<void> {
    const environment = dirname(dirname(paths.pythonPath));
    for (const directory of [environment, dirname(paths.pythonPath)]) {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Managed tool environment must be a private directory, not a symlink.');
    }
    for (const [name, path] of Object.entries(paths)) {
      // Python itself may be a normal venv symlink to the base interpreter.
      const entry = await (name === 'pythonPath' ? stat(path) : lstat(path));
      if (!entry.isFile()) throw new Error(`Managed tool executable is invalid: ${path}`);
      await access(path, this.platform === 'win32' ? constants.F_OK : constants.X_OK);
      checkCancelled(signal);
    }
    const response = await this.runner.run({ executable: paths.pythonPath, args: ['-I', '-c', TOOL_INFO] },
      { signal, timeoutMs: 15_000 });
    checkCancelled(signal);
    const info: unknown = JSON.parse(response.stdout.trim());
    const executable = this.pythonInfo(info);
    if (!object(info) || typeof info.prefix !== 'string'
      || !this.samePath(executable, paths.pythonPath) || !this.samePath(info.prefix, environment)) {
      throw new Error('Python does not belong to the selected private tool environment.');
    }
    for (const [name, version] of Object.entries(MANAGED_TOOL_PINS)) {
      if (!object(info.packages) || info.packages[name] !== version) {
        throw new Error(`Managed ${name} must be version ${version}. Run Setup Tools to repair the installation.`);
      }
    }
  }

  private samePath(left: string, right: string): boolean {
    return this.platform === 'win32'
      ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  }

  private async loadManifest(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, 'tools.json'), 'utf8'));
      if (!object(value) || value.schema !== 1 || typeof value.environment !== 'string'
        || !/^env-[A-Za-z0-9-]+$/.test(value.environment) || !object(value.pins)
        || value.pins.esptool !== MANAGED_TOOL_PINS.esptool || value.pins.mpremote !== MANAGED_TOOL_PINS.mpremote) {
        throw new Error('The managed tools manifest is invalid or uses incompatible package versions.');
      }
      // The manifest selects only a basename. Executable paths always come from
      // our platform layout and are checked before launching the derived Python.
      const paths = this.environmentPaths(join(this.root, value.environment));
      await this.verifyEnvironment(paths, this.lifetime.signal);
      checkCancelled(this.lifetime.signal);
      this.ready = paths;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.output(`Managed tools are unavailable: ${message(error)} Run Setup Tools to repair the installation.\n`);
    }
  }
}
