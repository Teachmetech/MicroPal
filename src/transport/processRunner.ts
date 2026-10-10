import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CommandResult, CommandSpec, ProcessOptions, ProcessRunner } from '../core/types';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 750;

interface Failure {
  message: string;
  code: number | string | null;
  name?: string;
}

export class ProcessError extends Error {
  constructor(message: string, public readonly result: CommandResult, public readonly code: number | string | null) {
    super(message);
    this.name = 'ProcessError';
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(spec: CommandSpec, options: ProcessOptions = {}): Promise<CommandResult> {
    const aborted: Failure = { message: 'Command cancelled.', code: 'ABORT_ERR', name: 'AbortError' };
    const toError = (failure: Failure, result: CommandResult): ProcessError => {
      const error = new ProcessError(failure.message, result, failure.code);
      if (failure.name) error.name = failure.name;
      return error;
    };
    if (options.signal?.aborted) throw toError(aborted, { stdout: '', stderr: '' });

    return new Promise<CommandResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let failure: Failure | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let closed = false;
      const spawnFailure = (error: NodeJS.ErrnoException): Failure => ({
        message: `Cannot run executable "${spec.executable}": ${error.message}. Check its installation and configured executable path (or editor PATH).`,
        code: error.code ?? 'SPAWN_ERROR',
      });
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(spec.executable, spec.args, {
          shell: false,
          detached: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: options.env ? { ...process.env, ...options.env } : undefined,
        });
      } catch (error) {
        reject(toError(spawnFailure(error as NodeJS.ErrnoException), { stdout: '', stderr: '' }));
        return;
      }

      const terminate = (reason: Failure): void => {
        if (closed || failure) return;
        failure = reason;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      };
      const onAbort = (): void => terminate(aborted);
      const capture = (text: string, target: Buffer[]): void => {
        const bytes = Buffer.from(text, 'utf8');
        const available = MAX_CAPTURE_BYTES - capturedBytes;
        if (available > 0) {
          const retained = bytes.subarray(0, available);
          target.push(retained);
          capturedBytes += retained.length;
        }
        if (options.onOutput) {
          try {
            options.onOutput(text);
          } catch (error) {
            terminate({ message: `Unable to display command output: ${String(error)}`, code: 'OUTPUT_CALLBACK' });
          }
        } else if (bytes.length > available) {
          terminate({ message: 'Command output exceeded the 8 MiB capture limit.', code: 'OUTPUT_LIMIT' });
        }
      };
      // Stream decoding keeps multibyte characters intact across pipe chunks.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => capture(text, stdout));
      child.stderr.on('data', (text: string) => capture(text, stderr));
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure ??= spawnFailure(error);
      });
      child.on('close', (code, signal) => {
        closed = true;
        clearTimeout(timeout);
        clearTimeout(forceKill);
        options.signal?.removeEventListener('abort', onAbort);
        const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
        if (failure) {
          reject(toError(failure, result));
        } else if (code !== 0) {
          const detail = result.stderr.trim().slice(-2000);
          reject(new ProcessError(`Command exited ${signal ? `with signal ${signal}` : `with code ${code}`}${detail ? `: ${detail}` : '.'}`, result, code));
        } else {
          resolve(result);
        }
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (timeoutMs > 0) {
        timeout = setTimeout(() => terminate({ message: `Command timed out after ${timeoutMs} ms.`, code: 'ETIMEDOUT' }), timeoutMs);
      }
      // Cancellation settles on close, never on kill: the next command must
      // not acquire the device while this process still owns its serial port.
    });
  }
}
