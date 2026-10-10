import { randomUUID } from 'node:crypto';
import type { DevicePort, InteractiveSession, ProcessRunner } from '../core/types';

// This reader deliberately does not use mpremote's raw REPL, console TTY,
// extra input flushing, or board writes. pyserial/OS drivers may discard buffered
// bytes or toggle control lines on open; physical behavior requires hardware tests.
const READER = `import json, sys
import serial
from serial.tools import list_ports
selected = json.loads(sys.argv[1])
device = selected['path']
identity = selected.get('serialNumber')
if identity is not None:
 matches = [p for p in list_ports.comports() if p.serial_number == identity
  and (not selected.get('vendorId') or p.vid == int(selected['vendorId'], 16))
  and (not selected.get('productId') or p.pid == int(selected['productId'], 16))]
 if not matches:
  raise RuntimeError('The selected USB serial identity is no longer available.')
 aliases = {p.device.replace('/dev/tty.', '/dev/cu.', 1) for p in matches}
 if len(aliases) != 1:
  raise RuntimeError('The selected USB serial identity is ambiguous; select a unique device.')
 device = next((p.device for p in matches if p.device == device), next((p.device for p in matches if p.device.startswith('/dev/cu.')), matches[0].device))
connection = serial.Serial(port=None)
connection.baudrate = 115200
connection.timeout = 0.1
connection.dtr = False
connection.rts = False
if sys.platform != 'win32':
 connection.exclusive = True
connection.port = device
try:
 connection.open()
 sys.stdout.buffer.write(('\\x1eMICROPAL_READY_' + sys.argv[2] + '\\x1f').encode('ascii'))
 sys.stdout.buffer.flush()
 while True:
  data = connection.read(4096)
  if data:
   sys.stdout.buffer.write(data)
   sys.stdout.buffer.flush()
finally:
 connection.close()
`;

function cancelled(): Error {
  const error = new Error('Automatic output cancelled.');
  error.name = 'AbortError';
  return error;
}

/** The runner's settlement confirms child closure, including failed/cancelled startup. */
export class SerialConsole {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly pythonPath: () => string | undefined,
    private readonly onOutput: (text: string) => void,
    private readonly showOutput: () => void,
  ) {}

  async open(port: DevicePort, signal?: AbortSignal): Promise<InteractiveSession> {
    if (signal?.aborted) throw cancelled();
    const python = this.pythonPath();
    if (!python?.trim() || /[\0\r\n]/.test(python)) {
      throw new Error('Automatic output needs MicroPal: Set Up Tools, including its managed Python environment.');
    }
    if (!port.path.trim() || /[\0\r\n]/.test(port.path)) throw new Error('Choose a valid serial port.');
    if (port.serialNumber !== undefined && (!port.serialNumber.trim() || /[\u0000-\u001f\u007f]/.test(port.serialNumber))) {
      throw new Error('Choose a board with a valid USB serial identity.');
    }
    for (const id of [port.vendorId, port.productId]) {
      if (id !== undefined && !/^[0-9a-f]{1,4}$/i.test(id)) throw new Error('Choose a board with valid USB identifiers.');
    }
    const nonce = randomUUID();
    const marker = `\x1eMICROPAL_READY_${nonce}\x1f`;
    const controller = new AbortController();
    let startupFailure: Error | undefined;
    let pending = '';
    let ready = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void readiness.catch(() => {});
    const abort = () => { startupFailure ??= cancelled(); controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      startupFailure = new Error('Automatic output startup timed out. Check the serial port and reconnect.');
      controller.abort();
    }, 8000);
    const receive = (text: string) => {
      if (controller.signal.aborted) return;
      if (ready) { this.onOutput(text); return; }
      pending += text;
      const start = pending.indexOf(marker);
      if (start < 0) {
        if (pending.length > 16 * 1024) throw new Error('Automatic output did not return a valid startup response.');
        return;
      }
      const output = pending.slice(start + marker.length);
      if (output) this.onOutput(output);
      ready = true;
      clearTimeout(timer);
      pending = '';
      resolveReady();
    };
    const completion = Promise.resolve().then(() => this.runner.run({ executable: python,
      args: ['-I', '-u', '-c', READER, JSON.stringify(port), nonce] },
    { signal: controller.signal, timeoutMs: 0, onOutput: receive }));
    // A failed read still proves closure once the runner settles. Only the
    // startup error is rejected; a live session reports its exit through closed.
    const closed = completion.then(() => {
      if (!ready) rejectReady(startupFailure ?? new Error('Automatic output exited before opening its serial port.'));
    }, error => {
      if (!ready) rejectReady(startupFailure ?? error);
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
    try {
      await readiness;
      if (controller.signal.aborted) throw startupFailure ?? cancelled();
      return {
        closed,
        close: async () => { controller.abort(); await closed; },
        show: () => { if (!controller.signal.aborted) this.showOutput(); },
      };
    } catch (error) {
      controller.abort();
      // Never reject while the helper might still own the port. The runner
      // escalates TERM to KILL and resolves/rejects only after the close event.
      await closed;
      throw error;
    }
  }
}
