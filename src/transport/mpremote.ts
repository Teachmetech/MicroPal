import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TextDecoder } from 'node:util';
import { DeviceFileSystemError } from '../core/fileErrors';
import type {
  CommandResult, CommandSpec, DeviceFile, DeviceFileStat, DevicePort, DeviceSettings, DeviceTransport, DeviceWriteOptions,
  InteractiveSession, ProcessRunner, ReplLauncher
} from '../core/types';

const COMMAND_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const BEGIN = '__MICROPAL_BEGIN__';
const END = '__MICROPAL_END__';
const ESP32_VENDORS = new Set(['303a', '10c4', '1a86', '0403']);

function usbId(value: string): string | undefined {
  if (/^(?:none|null|0+)$/i.test(value)) return undefined;
  return value.replace(/^0x/i, '').toLowerCase().padStart(4, '0');
}

/** mpremote emits fixed identifiers followed by free-form manufacturer/product text. */
export function parsePorts(output: string): DevicePort[] {
  const ports = new Map<string, DevicePort>();
  const id = '(?:0x)?[0-9a-f]{1,4}|None|null';
  const pattern = new RegExp(`^(\\S+)\\s+(\\S+)\\s+(${id}):(${id})(?:\\s+(.*))?$`, 'i');
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const [, portPath, serial, vendor, product, detail] = match;
    if (!portPath || !serial || !vendor || !product) continue;
    const vendorId = usbId(vendor);
    const productId = usbId(product);
    const serialNumber = /^(?:none|null)$/i.test(serial) ? undefined : serial;
    const description = (detail ?? '').split(/\s+/).filter(word => !/^(?:none|null)$/i.test(word)).join(' ').trim() || portPath;
    const candidate: DevicePort = {
      path: portPath,
      ...(serialNumber ? { serialNumber } : {}),
      ...(vendorId ? { vendorId } : {}),
      ...(productId ? { productId } : {}),
      description,
      likelyEsp32: ESP32_VENDORS.has(vendorId ?? '') || /esp(?:ressif|32)|cp210|ch34[01]|ch910|ft232/i.test(description)
    };
    // macOS reports tty and callout aliases for the same device. Prefer cu for outgoing sessions.
    const key = portPath.replace(/^\/dev\/(?:tty|cu)\./, '/dev/serial.');
    const existing = ports.get(key);
    if (!existing || portPath.startsWith('/dev/cu.')) ports.set(key, candidate);
  }
  return [...ports.values()];
}

export function normalizeRemotePath(value: string): string {
  if (value.includes('\0')) throw new Error('Remote paths cannot contain NUL bytes.');
  if (value.split('/').includes('..')) throw new Error('Remote paths cannot contain parent traversal (..).');
  return path.posix.normalize('/' + value.replace(/^\/+/, '')).replace(/\/$/, '') || '/';
}

function localAbsolute(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Choose a valid local file path.');
  return path.isAbsolute(value) || path.win32.isAbsolute(value) ? value : path.resolve(value);
}

/** Only exact marker lines count; a marker inside a JSON string is harmless. */
export function parseStructuredOutput(output: string): unknown {
  const lines = output.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line === END ? [index] : []);
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || start >= end) {
    throw new Error('Invalid device response: missing, truncated, or ambiguous structured output.');
  }
  try {
    return JSON.parse(lines.slice(start + 1, end).join('\n')) as unknown;
  } catch {
    throw new Error('Invalid device response: malformed JSON output.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFiles(output: string, parent: string): DeviceFile[] {
  const response = parseStructuredOutput(output);
  const result = record(response) && typeof response.ok === 'boolean' ? filesystemResult(response) : response;
  if (!Array.isArray(result)) throw new Error('Invalid device response: expected a filesystem listing.');
  const names = new Set<string>();
  const files = result.map((entry: unknown): DeviceFile => {
    if (!record(entry) || typeof entry.name !== 'string' || !entry.name ||
      ['.', '..'].includes(entry.name) || entry.name.includes('/') || entry.name.includes('\0') ||
      typeof entry.isDirectory !== 'boolean' || typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || names.has(entry.name)) {
      throw new Error('Invalid device response: malformed filesystem entry.');
    }
    names.add(entry.name);
    return { name: entry.name, path: path.posix.join(parent, entry.name), isDirectory: entry.isDirectory, size: entry.size };
  });
  return files.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

function framed(body: string): string {
  return `${body}\nprint(${JSON.stringify(BEGIN)})\nprint(_esp_json.dumps(_esp_result))\nprint(${JSON.stringify(END)})`;
}

/** Each bounded board operation returns its OSError errno as data, never inferred from stderr. */
function filesystemCode(body: string): string {
  return framed(`import os as _esp_os, json as _esp_json\ntry:\n${body.split('\n').map(line => ' ' + line).join('\n')}\n _esp_result = {'ok': True, 'value': _esp_value}\nexcept OSError as _esp_error:\n _esp_errno = _esp_error.args[0] if _esp_error.args else 0\n _esp_result = {'ok': False, 'errno': _esp_errno, 'message': str(_esp_error)}`);
}

function filesystemResult(result: unknown): unknown {
  if (!record(result) || typeof result.ok !== 'boolean') throw new Error('Invalid device response: expected a filesystem result.');
  if (!result.ok) {
    if (typeof result.errno !== 'number' || typeof result.message !== 'string') {
      throw new Error('Invalid device response: malformed filesystem error.');
    }
    const codes = { 2: 'FileNotFound', 17: 'FileExists', 20: 'FileNotADirectory', 21: 'FileIsADirectory', 13: 'NoPermissions', 1: 'NoPermissions' } as const;
    const code = codes[result.errno as keyof typeof codes] ?? 'Unavailable';
    throw new DeviceFileSystemError(code, result.message);
  }
  return result.value;
}

function mutablePath(value: string): string {
  const remote = normalizeRemotePath(value);
  if (remote === '/') throw new DeviceFileSystemError('NoPermissions', 'The device root directory cannot be modified.');
  return remote;
}

// MicroPython exposes stat tuples and OSError numbers on all supported ESP32 filesystems.
const FILESYSTEM_HELPERS = `def _esp_stat_or_none(_esp_path):\n try:\n  return _esp_os.stat(_esp_path)\n except OSError as _esp_error:\n  if _esp_error.args and _esp_error.args[0] == 2:\n   return None\n  raise\ndef _esp_is_dir(_esp_stat):\n return bool(_esp_stat[0] & 0x4000)\ndef _esp_require_parent(_esp_parent):\n _esp_stat = _esp_os.stat(_esp_parent)\n if not _esp_is_dir(_esp_stat):\n  raise OSError(20, 'Parent path is not a directory')`;

function writeChecks(remote: string, options: DeviceWriteOptions): string {
  return `${FILESYSTEM_HELPERS}\n_esp_target = ${JSON.stringify(remote)}\n_esp_require_parent(${JSON.stringify(path.posix.dirname(remote))})\n_esp_existing = _esp_stat_or_none(_esp_target)\nif _esp_existing is None:\n if ${options.create ? 'False' : 'True'}:\n  raise OSError(2, 'File does not exist and creation is disabled')\nelse:\n if _esp_is_dir(_esp_existing):\n  raise OSError(21, 'Path is a directory')\n if ${options.overwrite ? 'False' : 'True'}:\n  raise OSError(17, 'File already exists and overwrite is disabled')`;
}

/** Bounded commands can use pipes; interactive REPL must use the real-terminal launcher. */
export class MpremoteTransport implements DeviceTransport {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly settings: () => DeviceSettings,
    private readonly launchRepl: ReplLauncher,
    private readonly onOutput?: (text: string) => void
  ) {}

  private command(args: string[]): CommandSpec {
    const settings = this.settings();
    if (!settings.mpremotePath.trim() || settings.mpremotePath.includes('\0')) {
      throw new Error('Set mpremotePath to the mpremote executable, not an empty or invalid path.');
    }
    if (settings.baudRate !== 115200) {
      throw new Error('mpremote supports 115200 baud only. Set MicroPal baudRate to 115200.');
    }
    return { executable: settings.mpremotePath, args };
  }

  private connected(port: DevicePort, args: string[]): CommandSpec {
    if (!port.path.trim() || port.path.includes('\0') || port.path.startsWith('-')) throw new Error('Choose a valid serial port.');
    // Discovery paths and explicit id:/port: selectors are individual process arguments.
    // Reserved discovery values must never replace an already-selected board.
    if (port.path === 'list' || port.path === 'auto' || port.path === '+') throw new Error('Choose an explicit serial port.');
    if (port.serialNumber !== undefined && (!port.serialNumber.trim() || /[\u0000-\u001f\u007f]/.test(port.serialNumber))) {
      throw new Error('Choose a board with a valid USB serial identity.');
    }
    // OS serial paths can be reused before the presence poll notices a board swap.
    // Resolve the USB identity for every subprocess, including upload and commit.
    const selector = port.serialNumber === undefined ? port.path : `id:${port.serialNumber}`;
    return this.command(['connect', selector, ...args]);
  }

  private execute(port: DevicePort, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    return this.runner.run(this.connected(port, args), { signal, timeoutMs });
  }

  private async filesystem(port: DevicePort, body: string, signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    return filesystemResult(parseStructuredOutput((await this.execute(port, ['resume', 'exec', filesystemCode(body)], signal, timeoutMs)).stdout));
  }

  async discover(signal?: AbortSignal): Promise<DevicePort[]> {
    const result = await this.runner.run(this.command(['connect', 'list']), { signal, timeoutMs: COMMAND_TIMEOUT_MS });
    return parsePorts(result.stdout);
  }

  async probe(port: DevicePort, signal?: AbortSignal): Promise<void> {
    await this.execute(port, ['resume', 'exec', 'pass'], signal);
  }

  async runFile(port: DevicePort, localPath: string, signal?: AbortSignal): Promise<void> {
    await this.runner.run(this.connected(port, ['soft-reset', 'run', localAbsolute(localPath)]), {
      signal, timeoutMs: 0, onOutput: this.onOutput
    });
  }

  async stop(port: DevicePort, signal?: AbortSignal): Promise<void> {
    // Entering raw REPL sends Ctrl-C. The manager must release the previous owner first.
    await this.execute(port, ['resume', 'exec', 'pass'], signal);
  }

  async softReset(port: DevicePort, signal?: AbortSignal): Promise<void> {
    await this.execute(port, ['soft-reset'], signal);
  }

  async uploadFile(port: DevicePort, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    const local = localAbsolute(localPath);
    const remote = normalizeRemotePath(remotePath);
    if (remote === '/') throw new Error('Choose a remote file path, not the root directory.');
    const parent = path.posix.dirname(remote);
    if (parent !== '/') {
      const code = `import os as _esp_os\n_esp_parent = ${JSON.stringify(parent)}\n_esp_current = ''\nfor _esp_part in _esp_parent.split('/'):\n if _esp_part:\n  _esp_current += '/' + _esp_part\n  try:\n   _esp_os.mkdir(_esp_current)\n  except OSError:\n   if not (_esp_os.stat(_esp_current)[0] & 0x4000):\n    raise`;
      await this.execute(port, ['resume', 'exec', code], signal);
    }
    await this.execute(port, ['resume', 'fs', 'cp', local, ':' + remote], signal, TRANSFER_TIMEOUT_MS);
  }

  async listFiles(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<DeviceFile[]> {
    const remote = normalizeRemotePath(remotePath);
    // This is an explicit device action: resume preserves the heap, but raw REPL stops running code.
    const code = filesystemCode(`_esp_path = ${JSON.stringify(remote)}\n_esp_value = []\nfor _esp_name in _esp_os.listdir(_esp_path):\n _esp_stat = _esp_os.stat(_esp_path.rstrip('/') + '/' + _esp_name)\n _esp_dir = bool(_esp_stat[0] & 0x4000)\n _esp_value.append({'name': _esp_name, 'isDirectory': _esp_dir, 'size': 0 if _esp_dir else _esp_stat[6]})`);
    const result = await this.execute(port, ['resume', 'exec', code], signal);
    return parseFiles(result.stdout, remote);
  }

  async readFile(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<string> {
    const remote = normalizeRemotePath(remotePath);
    // Stream hex inside a JSON string: the board retains only one small chunk, and
    // the host can validate UTF-8 even when a character crosses a read boundary.
    const code = `import binascii as _esp_binary\nprint(${JSON.stringify(BEGIN)})\nprint('{"hex":"', end='')\n_esp_size = 0\nwith open(${JSON.stringify(remote)}, 'rb') as _esp_file:\n while True:\n  _esp_chunk = _esp_file.read(512)\n  if not _esp_chunk:\n   break\n  _esp_size += len(_esp_chunk)\n  if _esp_size > ${MAX_TEXT_BYTES}:\n   break\n  print(_esp_binary.hexlify(_esp_chunk).decode('ascii'), end='')\nprint('","tooLarge":' + ('true' if _esp_size > ${MAX_TEXT_BYTES} else 'false') + '}')\nprint(${JSON.stringify(END)})`;
    const result = parseStructuredOutput((await this.execute(port, ['resume', 'exec', code], signal, 300_000)).stdout);
    if (!record(result) || typeof result.tooLarge !== 'boolean' || typeof result.hex !== 'string') {
      throw new Error('Invalid device response: expected file content.');
    }
    if (result.tooLarge) throw new Error('File is too large to preview (limit: 1 MiB). Download it instead.');
    if (result.hex.length > MAX_TEXT_BYTES * 2 || result.hex.length % 2 || !/^[0-9a-f]*$/i.test(result.hex)) {
      throw new Error('Invalid device response: malformed or oversized file content.');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(result.hex, 'hex'));
    } catch {
      throw new Error('Binary or non-UTF-8 file cannot be previewed. Download it instead.');
    }
    if (content.includes('\0')) throw new Error('Binary file cannot be previewed as UTF-8. Download it instead.');
    return content;
  }

  async statFile(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<DeviceFileStat> {
    const remote = normalizeRemotePath(remotePath);
    const result = await this.filesystem(port, `import time as _esp_time\n_esp_stat = _esp_os.stat(${JSON.stringify(remote)})\n_esp_dir = bool(_esp_stat[0] & 0x4000)\n_esp_epoch = 946684800 if _esp_time.gmtime(0)[0] == 2000 else 0\n_esp_value = {'isDirectory': _esp_dir, 'size': 0 if _esp_dir else _esp_stat[6], 'mtime': (_esp_stat[8] + _esp_epoch) * 1000}`, signal);
    if (!record(result) || typeof result.isDirectory !== 'boolean' || typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) || result.size < 0 || typeof result.mtime !== 'number' || !Number.isFinite(result.mtime) || result.mtime < 0) {
      throw new Error('Invalid device response: malformed file stat.');
    }
    return { isDirectory: result.isDirectory, size: result.size, mtime: result.mtime };
  }

  async readFileBytes(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const remote = normalizeRemotePath(remotePath);
    const stat = await this.statFile(port, remote, signal);
    if (stat.isDirectory) throw new DeviceFileSystemError('FileIsADirectory', 'Cannot read a directory as a file.');
    const temporary = await mkdtemp(path.join(tmpdir(), 'micropal-read-'));
    try {
      const local = path.join(temporary, 'content');
      await this.execute(port, ['resume', 'fs', 'cp', ':' + remote, local], signal, TRANSFER_TIMEOUT_MS);
      return new Uint8Array(await readFile(local));
    } finally {
      // ProcessRunner settles only after the child closes, including abort/timeout paths.
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async writeFileBytes(port: DevicePort, remotePath: string, content: Uint8Array, options: DeviceWriteOptions, signal?: AbortSignal): Promise<void> {
    const remote = mutablePath(remotePath);
    const checks = writeChecks(remote, options);
    await this.filesystem(port, checks + '\n_esp_value = None', signal);
    const temporary = await mkdtemp(path.join(tmpdir(), 'micropal-write-'));
    const stage = path.posix.join(path.posix.dirname(remote), `.micropal-upload-${randomUUID()}.tmp`);
    let stagingStarted = false;
    let committed = false;
    try {
      const local = path.join(temporary, 'content');
      await writeFile(local, content, { mode: 0o600 });
      stagingStarted = true;
      await this.execute(port, ['resume', 'fs', 'cp', local, ':' + stage], signal, TRANSFER_TIMEOUT_MS);
      // Recheck immediately before rename: a concurrent creator must not be overwritten.
      // os.rename commits without first deleting the destination. A filesystem that refuses
      // replacement leaves the existing bytes in place and returns its OSError.
      await this.filesystem(port, checks + `\n_esp_os.rename(${JSON.stringify(stage)}, _esp_target)\n_esp_value = None`, signal);
      committed = true;
    } finally {
      await rm(temporary, { recursive: true, force: true });
      if (stagingStarted && !committed) {
        if (signal?.aborted) {
          this.onOutput?.(`MicroPal: cancelled upload may have left staging file ${stage}. Remove it after reconnecting.\n`);
        } else {
          try {
            await this.filesystem(port, `try:\n _esp_os.remove(${JSON.stringify(stage)})\nexcept OSError as _esp_error:\n if not _esp_error.args or _esp_error.args[0] != 2:\n  raise\n_esp_value = None`, undefined);
          } catch {
            this.onOutput?.(`MicroPal: upload cleanup could not remove staging file ${stage}. Remove it after reconnecting.\n`);
          }
        }
      }
    }
  }

  async createDirectory(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<void> {
    const remote = normalizeRemotePath(remotePath);
    await this.filesystem(port, `${FILESYSTEM_HELPERS}\n_esp_current = ''\nfor _esp_part in ${JSON.stringify(remote)}.split('/'):\n if _esp_part:\n  _esp_current += '/' + _esp_part\n  _esp_stat = _esp_stat_or_none(_esp_current)\n  if _esp_stat is None:\n   _esp_os.mkdir(_esp_current)\n  elif not _esp_is_dir(_esp_stat):\n   raise OSError(20, 'Path is not a directory')\n_esp_value = None`, signal);
  }

  async deleteFile(port: DevicePort, remotePath: string, options: { recursive: boolean }, signal?: AbortSignal): Promise<void> {
    const remote = mutablePath(remotePath);
    await this.filesystem(port, `${FILESYSTEM_HELPERS}\ndef _esp_delete(_esp_path):\n _esp_stat = _esp_os.stat(_esp_path)\n if _esp_is_dir(_esp_stat):\n  if ${options.recursive ? 'True' : 'False'}:\n   for _esp_name in _esp_os.listdir(_esp_path):\n    _esp_delete(_esp_path.rstrip('/') + '/' + _esp_name)\n  _esp_os.rmdir(_esp_path)\n else:\n  _esp_os.remove(_esp_path)\n_esp_delete(${JSON.stringify(remote)})\n_esp_value = None`, signal, TRANSFER_TIMEOUT_MS);
  }

  async renameFile(port: DevicePort, oldPath: string, newPath: string, options: { overwrite: boolean }, signal?: AbortSignal): Promise<void> {
    const source = mutablePath(oldPath);
    const destination = mutablePath(newPath);
    if (destination.startsWith(source + '/')) {
      throw new DeviceFileSystemError('NoPermissions', 'Cannot move a directory into itself.');
    }
    await this.filesystem(port, `${FILESYSTEM_HELPERS}\n_esp_source = ${JSON.stringify(source)}\n_esp_target = ${JSON.stringify(destination)}\n_esp_source_stat = _esp_os.stat(_esp_source)\n_esp_require_parent(${JSON.stringify(path.posix.dirname(destination))})\nif _esp_source != _esp_target:\n _esp_target_stat = _esp_stat_or_none(_esp_target)\n if _esp_target_stat is not None:\n  if ${options.overwrite ? 'False' : 'True'}:\n   raise OSError(17, 'Destination already exists')\n  if _esp_is_dir(_esp_target_stat) and not _esp_is_dir(_esp_source_stat):\n   raise OSError(21, 'Destination is a directory')\n  if not _esp_is_dir(_esp_target_stat) and _esp_is_dir(_esp_source_stat):\n   raise OSError(20, 'Destination is not a directory')\n _esp_os.rename(_esp_source, _esp_target)\n_esp_value = None`, signal);
  }

  async downloadFile(port: DevicePort, remotePath: string, localPath: string, signal?: AbortSignal): Promise<void> {
    const remote = normalizeRemotePath(remotePath);
    if (remote === '/') throw new Error('Choose a remote file to download.');
    await this.execute(port, ['resume', 'fs', 'cp', ':' + remote, localAbsolute(localPath)], signal, TRANSFER_TIMEOUT_MS);
  }

  async openRepl(port: DevicePort): Promise<InteractiveSession> {
    return this.launchRepl(this.connected(port, ['repl']));
  }
}
