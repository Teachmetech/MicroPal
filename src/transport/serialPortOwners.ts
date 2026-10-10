import { basename, posix } from 'node:path';
import { stat } from 'node:fs/promises';
import type { CommandResult, CommandSpec, ProcessRunner } from '../core/types';
import { ProcessError } from './processRunner';

const INSPECT_TIMEOUT_MS = 3_000;
const RELEASE_TIMEOUT_MS = 1_500;
const POLL_MS = 100;

export interface SerialPortOwner {
  pid: number;
  uid: number;
  command: string;
  displayName: string;
  startTime: string;
  isMicroPalRepl: boolean;
}

export interface SerialPortOwnerOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  pid?: number;
  managedToolsRoot?: string;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pathExists?: (path: string) => Promise<boolean>;
}

export class SerialPortReleaseError extends Error {
  constructor(message: string, public readonly code: 'StillBusy' | 'OwnerChanged' | 'UnsafeOwner' | 'SignalFailed') {
    super(message);
    this.name = 'SerialPortReleaseError';
  }
}

export class SerialPortOwners {
  private readonly platform: NodeJS.Platform;
  private readonly uid: number | undefined;
  private readonly pid: number;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pathExists: (path: string) => Promise<boolean>;

  constructor(private readonly runner: ProcessRunner, private readonly options: SerialPortOwnerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? process.getuid?.();
    this.pid = options.pid ?? process.pid;
    this.signalProcess = options.signalProcess ?? ((pid, signal) => { process.kill(pid, signal); });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.pathExists = options.pathExists ?? (async path => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  async inspect(portPath: string): Promise<SerialPortOwner[]> {
    return this.inspectOwners(portPath);
  }

  async release(portPath: string, owners: readonly SerialPortOwner[], options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const checkCancelled = () => this.checkCancelled(options.signal);
    checkCancelled();
    this.portPaths(portPath);
    // Copy approval snapshots so a caller cannot mutate an identity during an await.
    const approved = owners.map(owner => ({ ...owner }));
    for (const owner of approved) this.assertSafeOwner(owner);
    if (new Set(approved.map(owner => owner.pid)).size !== approved.length) {
      throw new SerialPortReleaseError('The approved serial-port owner list contains duplicate process IDs. Inspect the port again.', 'UnsafeOwner');
    }

    const inspectApproved = async () => {
      const current = await this.inspectOwners(portPath, options.signal);
      checkCancelled();
      for (const owner of current) {
        const previous = approved.find(candidate => candidate.pid === owner.pid);
        if (!previous || !this.sameIdentity(previous, owner)) {
          throw new SerialPortReleaseError('The serial-port owner changed. Inspect the port again before releasing it.', 'OwnerChanged');
        }
        this.assertSafeOwner(owner);
      }
      return current;
    };

    const signalApproved = async (signal: NodeJS.Signals) => {
      for (const previous of approved) {
        // lsof and ps are repeated before every individual signal, including SIGKILL.
        const current = await inspectApproved();
        checkCancelled();
        if (!current.some(owner => this.sameIdentity(previous, owner))) continue;
        try {
          this.signalProcess(previous.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw new SerialPortReleaseError(`Unable to release process ${previous.pid}: ${message(error)} Close its serial monitor or terminal and try again.`, 'SignalFailed');
          }
        }
        checkCancelled();
      }
    };

    const waitUntilFree = async () => {
      const deadline = this.now() + RELEASE_TIMEOUT_MS;
      // The iteration limit also bounds waiting if an injected or system clock stalls.
      for (let attempt = 0; attempt <= Math.ceil(RELEASE_TIMEOUT_MS / POLL_MS); attempt++) {
        const current = await inspectApproved();
        checkCancelled();
        if (!current.length) return true;
        if (this.now() >= deadline || attempt === Math.ceil(RELEASE_TIMEOUT_MS / POLL_MS)) return false;
        await this.sleep(Math.min(POLL_MS, Math.max(1, deadline - this.now())));
        checkCancelled();
      }
      return false;
    };

    await signalApproved('SIGTERM');
    checkCancelled();
    if (await waitUntilFree()) return;
    checkCancelled();
    if (options.force) {
      await signalApproved('SIGKILL');
      checkCancelled();
      if (await waitUntilFree()) return;
      checkCancelled();
    }
    throw new SerialPortReleaseError('The approved process still holds the serial port after termination. Close its terminal or explicitly force release, then try again.', 'StillBusy');
  }

  private async inspectOwners(portPath: string, signal?: AbortSignal): Promise<SerialPortOwner[]> {
    this.checkCancelled(signal);
    const paths = this.portPaths(portPath);
    const spec = { executable: 'lsof', args: ['-nP', '-Fpcu', '--', ...paths] };
    let result: CommandResult;
    try {
      result = await this.runner.run(spec, { timeoutMs: INSPECT_TIMEOUT_MS, signal, env: { LC_ALL: 'C' } });
    } catch (error) {
      this.checkCancelled(signal);
      if (!(error instanceof ProcessError) || error.code !== 1) throw this.inspectionError('lsof', error);
      // lsof exits 1 when any queried alias has no match, even if the other has an owner.
      result = error.result;
    }
    this.checkCancelled(signal);
    const missingPath = paths.some(path => result.stderr.split(/\r?\n/).includes(`lsof: status error on ${path}: No such file or directory`));
    if (!this.benignLsofDiagnostic(result.stderr, paths, missingPath)) {
      throw new Error(`Unable to inspect serial-port ownership with lsof: ${result.stderr.trim().slice(-1_000)}`);
    }
    if (missingPath && !result.stdout.trim()) {
      // PTY nodes and unplugged device nodes can disappear after their owner exits.
      // Confirm every alias is absent rather than interpreting a usage error as free.
      let exists: boolean[];
      try {
        exists = await Promise.all(paths.map(path => this.pathExists(path)));
      } catch (error) {
        this.checkCancelled(signal);
        throw new Error(`Unable to check whether the serial port disappeared: ${message(error)}`);
      }
      this.checkCancelled(signal);
      if (exists.every(value => !value)) return [];
      throw new Error('Unable to inspect serial-port ownership: a queried port alias is missing while another path still exists. Reconnect the device and try again.');
    }
    const records = parseLsof(result.stdout);
    const owners: SerialPortOwner[] = [];
    for (const record of records) {
      const identitySpec = { executable: 'ps', args: ['-ww', '-p', String(record.pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'args='] };
      const identity = await this.processDetails(identitySpec, signal);
      this.checkCancelled(signal);
      if (!identity) continue; // The process closed between lsof and ps.
      const parsed = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*\S)\s*$/.exec(identity.stdout);
      if (!parsed?.[1] || !parsed[2] || !parsed[3]) throw new Error(`Unable to inspect process ${record.pid}: ps returned an incomplete process identity.`);
      const uid = Number(parsed[1]);
      if (!Number.isSafeInteger(uid) || uid < 0 || uid !== record.uid) {
        throw new Error(`Unable to inspect process ${record.pid}: its ownership changed during inspection. Try again.`);
      }
      const command = parsed[3].trim();
      const display = await this.processDetails({ executable: 'ps', args: ['-p', String(record.pid), '-o', 'comm='] }, signal);
      this.checkCancelled(signal);
      if (!display) continue;
      const displayName = basename(display.stdout.trim()) || record.command;
      owners.push({ pid: record.pid, uid, command, startTime: parsed[2], displayName,
        isMicroPalRepl: uid === this.uid && this.isManagedRepl(command, paths) });
    }
    return owners;
  }

  private portPaths(portPath: string): string[] {
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      throw new Error('Automatic serial-port release is supported on macOS and Linux. On Windows, close the serial monitor or terminal holding the selected COM port, then reconnect.');
    }
    if (!portPath.startsWith('/dev/') || /[\0\r\n]/.test(portPath) || portPath.split('/').includes('..')) {
      throw new Error('Choose a valid absolute /dev/ serial-port path before inspecting its owner.');
    }
    if (this.platform === 'darwin' && /^\/dev\/(?:cu|tty)\./.test(portPath)) {
      const alias = portPath.replace(/^\/dev\/(cu|tty)\./, (_value, prefix: string) => `/dev/${prefix === 'cu' ? 'tty' : 'cu'}.`);
      return [portPath, alias];
    }
    return [portPath];
  }

  private async processDetails(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult | undefined> {
    this.checkCancelled(signal);
    try {
      const result = await this.runner.run(spec, { timeoutMs: INSPECT_TIMEOUT_MS, signal, env: { LC_ALL: 'C' } });
      this.checkCancelled(signal);
      return result;
    } catch (error) {
      this.checkCancelled(signal);
      if (error instanceof ProcessError && error.code === 1 && !error.result.stdout.trim() && !error.result.stderr.trim()) return undefined;
      throw this.inspectionError('ps', error);
    }
  }

  private isManagedRepl(command: string, paths: string[]): boolean {
    const root = this.options.managedToolsRoot;
    if (!root || !posix.isAbsolute(root) || /[\0\r\n]/.test(root)) return false;
    const escapedRoot = escapeRegex(posix.normalize(root).replace(/\/$/, ''));
    const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
    // ps flattens argv without quoting. Anchor known paths (which can contain spaces)
    // and accept only an unambiguous single selector and the sole `repl` command.
    const match = new RegExp(`^(${escapedRoot}/env-${uuid}/(?:bin|Scripts))/python(?:3(?:\\.\\d+)?)?(?:\\.exe)? \\1/mpremote(?:\\.exe)? connect (\\S+) repl$`).exec(command);
    const selector = match?.[2];
    return selector !== undefined && (paths.includes(selector) || /^id:[^\s]+$/.test(selector));
  }

  private assertSafeOwner(owner: SerialPortOwner): void {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid === this.pid ||
        this.uid === undefined || !Number.isSafeInteger(owner.uid) || owner.uid !== this.uid ||
        !owner.startTime || !owner.command) {
      throw new SerialPortReleaseError('This process cannot be released: only another process owned by your user can be signalled. Close its serial monitor or terminal manually.', 'UnsafeOwner');
    }
  }

  private sameIdentity(left: SerialPortOwner, right: SerialPortOwner): boolean {
    return left.pid === right.pid && left.uid === right.uid && left.startTime === right.startTime && left.command === right.command;
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('Serial-port release cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  private inspectionError(tool: string, error: unknown): Error {
    return new Error(`Unable to inspect serial-port ownership with ${tool}. Install or enable ${tool}, or close the serial monitor or terminal manually. ${message(error)}`);
  }

  private benignLsofDiagnostic(stderr: string, paths: string[], allowUsageFooter = false): boolean {
    if (!stderr.trim()) return true;
    let warningBlock = false;
    let usageFooter = false;
    let usageStarted = false;
    let helpSeen = false;
    for (const line of stderr.split(/\r?\n/)) {
      if (usageFooter) {
        if (!line.trim()) continue;
        if (!usageStarted && /^ latest (?:revision|FAQ|man page): (?:https?|ftp):\/\/\S+\s*$/.test(line)) continue;
        if (!usageStarted && /^ usage: \[.*\]\s*$/.test(line)) {
          usageStarted = true;
          continue;
        }
        if (usageStarted && !helpSeen && /^ (?:\[[^\r\n]*\]\s*)+$/.test(line)) continue;
        if (usageStarted && !helpSeen && line === "Use the ``-h'' option to get more help information.") {
          helpSeen = true;
          continue;
        }
        return false;
      }
      if (/^lsof:\s+WARNING:/i.test(line)) {
        warningBlock = true;
        continue;
      }
      if (warningBlock && (/^\s+Output information may be incomplete\.?\s*$/.test(line) ||
          /^\s+assuming "dev=(?:0x)?[0-9a-f]+" from mount table\s*$/i.test(line))) continue;
      warningBlock = false;
      if (!line.trim() || paths.some(portPath => line === `lsof: status error on ${portPath}: No such file or directory`)) continue;
      if (allowUsageFooter && /^lsof \d+(?:\.\d+)+\s*$/.test(line)) {
        usageFooter = true;
        continue;
      }
      return false;
    }
    return !usageFooter || (usageStarted && helpSeen);
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseLsof(output: string): Array<{ pid: number; uid: number; command: string }> {
  const records = new Map<number, { pid: number; uid: number; command: string }>();
  let current: { pid: number; uid?: number; command?: string } | undefined;
  const malformed = () => new Error('Unable to inspect serial-port ownership: lsof returned malformed process records.');
  const finish = () => {
    if (!current) return;
    if (current.uid === undefined || !current.command) throw malformed();
    const prior = records.get(current.pid);
    if (prior && (prior.uid !== current.uid || prior.command !== current.command)) throw malformed();
    records.set(current.pid, { pid: current.pid, uid: current.uid, command: current.command });
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      finish();
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw malformed();
      current = { pid: Number(value) };
    } else if (field === 'u') {
      if (!current || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw malformed();
      current.uid = Number(value);
    } else if (field === 'c') {
      if (!current || !value) throw malformed();
      current.command = value;
    } else if (field === 'f') {
      // macOS ships lsof 4.91, which emits fd fields even when -F omits f.
      // Multiple handles belong to the same process and do not change its identity.
      if (!current || !/^(?:\d+[rwu]?|cwd|rtd|txt|mem|mmap|ltx|pd|jld|DEL|NOFD)$/.test(value)) throw malformed();
    } else {
      throw malformed();
    }
  }
  finish();
  return [...records.values()];
}
