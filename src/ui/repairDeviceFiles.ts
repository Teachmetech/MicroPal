import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DeviceExplorer } from './deviceExplorer';

type RepairDevice = Pick<DeviceManager, 'state' | 'fileSystemSession' | 'connectionRevision'>;

function assertTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before repairing ESP32 Files.');
}

function cancelled(): Error {
  const error = new Error('ESP32 Files repair cancelled because the connection changed.');
  error.name = 'AbortError';
  return error;
}

function assertIdle(device: RepairDevice): void {
  switch (device.state.phase) {
    case 'connected': case 'disconnected': case 'error': return;
    case 'running': throw new Error('Stop the running program before repairing ESP32 Files.');
    case 'repl': throw new Error('Close the MicroPal REPL before repairing ESP32 Files.');
    default: throw new Error('Wait for the current device operation to finish, then try Repair ESP32 Files again.');
  }
}

/** Explicit recovery preserves verified saved identities and never revives revoked document permissions. */
export function createRepairDeviceFilesCommand(
  device: RepairDevice,
  explorer: Pick<DeviceExplorer, 'open' | 'restore'>,
  connect: () => Promise<void>,
  onRepaired: () => void | Promise<void>,
): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) throw new Error('An ESP32 Files repair is already in progress. Finish or cancel it first.');
    active = true;
    let revision = device.connectionRevision;
    const assertCurrent = () => {
      assertTrusted();
      if (device.connectionRevision !== revision) throw cancelled();
    };
    try {
      assertTrusted();
      assertIdle(device);
      if (device.state.phase === 'connected' && device.fileSystemSession) {
        const session = device.fileSystemSession;
        await explorer.open();
        assertCurrent();
        if (device.fileSystemSession !== session) throw cancelled();
        await onRepaired();
        return;
      }

      let failure = 'Connect a board to reopen ESP32 Files.';
      if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'micropal')) {
        try {
          // Restore deliberately increments the revision before its first await.
          const restoring = explorer.restore();
          revision = device.connectionRevision;
          await restoring;
          assertCurrent();
        } catch (error) {
          assertCurrent();
          if (error instanceof Error && error.name === 'AbortError') throw error;
          failure = error instanceof Error ? error.message : String(error);
        }
        if (device.state.phase === 'connected' && device.fileSystemSession) {
          const session = device.fileSystemSession;
          await explorer.open();
          assertCurrent();
          if (device.fileSystemSession !== session) throw cancelled();
          await onRepaired();
          return;
        }
      }
      assertCurrent();
      assertIdle(device);
      const choice = await vscode.window.showWarningMessage(`MicroPal: ${failure}`, {
        detail: 'Connect selects a board and reopens ESP32 Files. Old files with unsaved edits stay open and unavailable; copy those edits locally before closing them.',
      }, 'Connect');
      assertCurrent();
      assertIdle(device);
      if (choice !== 'Connect') return;
      // The shared Connect workflow handles approvals, cancellation, and mounting.
      await connect();
      assertTrusted();
      if (['connected', 'busy'].includes(device.state.phase) && device.fileSystemSession) await onRepaired();
    } finally { active = false; }
  };
}
