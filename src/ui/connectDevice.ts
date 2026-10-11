import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DevicePort } from '../core/types';
import { ProcessError } from '../transport/processRunner';
import { SerialPortReleaseError, type SerialPortOwner } from '../transport/serialPortOwners';

interface PortOwners {
  inspect(portPath: string): Promise<SerialPortOwner[]>;
  release(portPath: string, owners: readonly SerialPortOwner[], options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}

type ConnectDevice = Pick<DeviceManager, 'connect' | 'state' | 'connectionRevision' | 'onDidChange'>;

function cancelled(): Error {
  const error = new Error('Connection recovery cancelled because the connection changed.');
  error.name = 'AbortError';
  return error;
}

function assertTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to a device or releasing serial-port processes.');
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Only host serial-open failures justify inspecting other processes. */
function isBusyAccessFailure(error: unknown, port: DevicePort): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  const accessFailure = new RegExp(`^(?:mpremote: )?failed to access ${escaped(port.path)} \\(it may be in use by another program\\)$`);
  if (!(error instanceof ProcessError)) return accessFailure.test(error.message.trim());
  // Timeout, cancellation, spawn, and output failures can contain stale stderr.
  if (typeof error.code !== 'number' || error.code === 0) return false;
  const selectedPort = new RegExp(`['"]?${escaped(port.path)}['"]?(?=[:\\s]|$)`);
  return error.result.stderr.split(/\r?\n/).some(value => {
    const line = value.trim();
    if (accessFailure.test(line)) return true;
    if (!/^(?:serial\.serialutil\.)?SerialException:/i.test(line) || !selectedPort.test(line)) return false;
    return /\[Errno 16\]/i.test(line) && /(?:Device or resource busy|Resource busy)/i.test(line) ||
      /Could not exclusively lock port/i.test(line) && /\[Errno 11\] Resource temporarily unavailable/i.test(line);
  });
}

function processList(owners: readonly SerialPortOwner[]): string {
  return owners.map(owner => `${owner.displayName} (PID ${owner.pid})`).join('\n');
}

function onlyApprovedOwners(approved: readonly SerialPortOwner[], current: readonly SerialPortOwner[]): boolean {
  return current.every(owner => approved.some(previous =>
    previous.pid === owner.pid && previous.uid === owner.uid && previous.startTime === owner.startTime && previous.command === owner.command));
}

/** Explicit Connect can recover a port, while device probes and Explorer reads never terminate other processes. */
export function createConnectCommand(
  device: ConnectDevice,
  owners: PortOwners,
  selectPort: () => Promise<DevicePort | undefined>,
  onConnected: () => Promise<void>,
  output: Pick<vscode.OutputChannel, 'appendLine'>,
  autoRelease: () => boolean,
): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) throw new Error('A device connection workflow is already in progress. Finish or cancel it first.');
    active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      assertTrusted();
      const selectionRevision = device.connectionRevision;
      const port = await selectPort();
      if (!port) return;
      assertTrusted();
      if (device.connectionRevision !== selectionRevision) throw cancelled();
      let attemptRevision = device.connectionRevision;
      try {
        // The manager releases its tracked Run/REPL before acquiring the port.
        const connecting = device.connect(port);
        attemptRevision = device.connectionRevision;
        await connecting;
      } catch (error) {
        if (!isBusyAccessFailure(error, port)) throw error;
        const matchesFailedConnection = () => device.state.phase === 'error' &&
          device.state.port?.path === port.path && device.state.port.serialNumber === port.serialNumber;
        if (device.connectionRevision !== attemptRevision || !matchesFailedConnection()) throw error;
        const revision = attemptRevision;
        const cancellation = new AbortController();
        const assertCurrent = () => {
          if (!vscode.workspace.isTrusted) { cancellation.abort(); assertTrusted(); }
          if (device.connectionRevision !== revision || !matchesFailedConnection()) cancellation.abort();
          if (cancellation.signal.aborted) throw cancelled();
        };
        unsubscribe = device.onDidChange(() => {
          if (device.connectionRevision !== revision) cancellation.abort();
        });
        assertCurrent();
        const portOwners = await owners.inspect(port.path);
        assertCurrent();
        if (!portOwners.length) throw error;

        const automatic = autoRelease() && portOwners.every(owner => owner.isMicroPalRepl);
        if (!automatic) {
          const answer = await vscode.window.showWarningMessage(
            `Release ${port.path} and connect?`,
            { modal: true, detail: `These processes currently own the serial port:\n\n${processList(portOwners)}\n\nRelease Port and Connect terminates these processes. Their serial monitors or REPLs will stop, and unsaved work may be lost.` },
            'Release Port and Connect',
          );
          assertCurrent();
          if (answer !== 'Release Port and Connect') return;
        }
        assertCurrent();
        output.appendLine(`[connect] ${automatic ? 'Automatically releasing MicroPal REPLs' : 'Releasing approved processes'} on ${port.path}: ${processList(portOwners).replace(/\n/g, ', ')}.`);
        try {
          await owners.release(port.path, portOwners, { signal: cancellation.signal });
        } catch (releaseError) {
          assertCurrent();
          if (!(releaseError instanceof SerialPortReleaseError) || releaseError.code !== 'StillBusy') throw releaseError;
          const remaining = await owners.inspect(port.path);
          assertCurrent();
          if (remaining.length) {
            if (!onlyApprovedOwners(portOwners, remaining)) throw releaseError;
            const force = await vscode.window.showWarningMessage(
              `Force release ${port.path} and connect?`,
              { modal: true, detail: `These processes still own the serial port after being asked to terminate:\n\n${processList(remaining)}\n\nForce Release and Connect forcibly stops them using SIGKILL. Unsaved work may be lost, and process cleanup cannot run.` },
              'Force Release and Connect',
            );
            assertCurrent();
            if (force !== 'Force Release and Connect') return;
            output.appendLine(`[connect] Force releasing approved processes on ${port.path}: ${processList(remaining).replace(/\n/g, ', ')}.`);
            await owners.release(port.path, remaining, { force: true, signal: cancellation.signal });
            assertCurrent();
          }
        }
        // Retrying changes the revision itself. Stop watching before that deliberate change.
        assertCurrent();
        unsubscribe();
        unsubscribe = undefined;
        await device.connect(port);
      }
      // Opening Explorer can fail independently after a successful connection.
      assertTrusted();
      await onConnected();
    } finally {
      unsubscribe?.();
      active = false;
    }
  };
}
