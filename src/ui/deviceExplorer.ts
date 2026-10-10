import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DevicePort } from '../core/types';

interface ExplorerFileSystem {
  toUri(path: string): vscode.Uri;
  refresh(): void | Promise<void>;
}
interface MountDescriptor { port: DevicePort; session: string; }
const SCHEME = 'micropal';
const PREFIX = 'microPal.mount.';

function unavailable(message: string): vscode.FileSystemError {
  return vscode.FileSystemError.Unavailable(`${message} Run MicroPal: Connect to reopen ESP32 Files.`);
}
function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function descriptor(value: unknown, session: string): MountDescriptor {
  if (!record(value) || value.session !== session || !record(value.port)) {
    throw unavailable('The saved ESP32 connection has expired.');
  }
  const port = value.port;
  if (typeof port.path !== 'string' || !port.path.trim() || port.path.length > 4096 || port.path.includes('\0') ||
    port.path.startsWith('-') || ['auto', 'list', '+'].includes(port.path) ||
    typeof port.description !== 'string' || typeof port.likelyEsp32 !== 'boolean' ||
    (port.vendorId !== undefined && (typeof port.vendorId !== 'string' || !/^[0-9a-f]{4}$/i.test(port.vendorId))) ||
    (port.productId !== undefined && (typeof port.productId !== 'string' || !/^[0-9a-f]{4}$/i.test(port.productId)))) {
    throw unavailable('The saved ESP32 port is invalid.');
  }
  if (typeof port.serialNumber !== 'string' || !port.serialNumber.trim() || port.serialNumber.includes('\0')) {
    throw unavailable('This port has no USB serial identity and cannot be restored automatically.');
  }
  return { session, port: { path: port.path, description: port.description, likelyEsp32: port.likelyEsp32,
    serialNumber: port.serialNumber, ...(port.vendorId ? { vendorId: port.vendorId } : {}),
    ...(port.productId ? { productId: port.productId } : {}) } };
}

/** Native Explorer roots support transfers both ways; custom trees cannot accept drops into the local Explorer. */
export class DeviceExplorer {
  private pendingUpdate?: vscode.Disposable;

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'globalState'>,
    private readonly device: Pick<DeviceManager, 'state' | 'fileSystemSession' | 'restoreFileSystemSession'>,
    private readonly filesystem: ExplorerFileSystem,
  ) {}

  async open(): Promise<void> {
    this.assertNotUpdating();
    const { port, phase } = this.device.state;
    const session = this.device.fileSystemSession;
    if (!validSession(session) || !port || phase !== 'connected') {
      throw unavailable('An idle connected ESP32 is required. Stop the running program or close the REPL first.');
    }
    if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file')) {
      throw new Error('Open a local project folder before opening ESP32 Files in the Explorer.');
    }
    const root = this.filesystem.toUri('/');
    if (root.scheme !== SCHEME || root.authority !== session || root.path !== '/' || root.query || root.fragment) {
      throw unavailable('The ESP32 filesystem connection has changed.');
    }
    if (!port.serialNumber?.trim()) {
      void vscode.window.showInformationMessage('This board has no USB serial identity. If the editor reloads while opening ESP32 Files, run MicroPal: Connect again to reopen it.');
    }
    // Entering a multi-root workspace can restart this extension host. Save the
    // exact session first so only that verified USB identity can be restored.
    await this.context.globalState.update(PREFIX + session, { port: { ...port }, session } satisfies MountDescriptor);
    if (this.device.fileSystemSession !== session || this.device.state.phase !== 'connected') {
      // A delayed descriptor write must not revive a session already revoked by
      // Disconnect, flashing, or another Connect while storage was pending.
      await this.context.globalState.update(PREFIX + session, undefined);
      throw unavailable('The ESP32 connection changed while opening the Explorer.');
    }
    this.assertNotUpdating();
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    if (!folders.some(folder => folder.uri.scheme === 'file')) {
      throw new Error('Open a local project folder before opening ESP32 Files in the Explorer.');
    }
    const mounts = folders.filter(folder => folder.uri.scheme === SCHEME);
    if (mounts.length === 1 && folders.at(-1)?.uri.toString() === root.toString()) {
      await this.filesystem.refresh();
    } else {
      this.update(folders, [...folders.filter(folder => folder.uri.scheme !== SCHEME), { uri: root, name: 'ESP32 Files' }]);
    }
    await vscode.commands.executeCommand('workbench.view.explorer');
  }

  async restore(): Promise<void> {
    const roots = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === SCHEME) ?? [];
    if (!roots.length) return;
    const root = roots[0]!.uri;
    if (roots.length !== 1 || !validSession(root.authority) || root.path !== '/' || root.query || root.fragment) {
      throw unavailable('The mounted ESP32 filesystem has an invalid connection identity.');
    }
    const saved = descriptor(this.context.globalState.get<unknown>(PREFIX + root.authority), root.authority);
    await this.device.restoreFileSystemSession(saved.port, saved.session);
    await this.filesystem.refresh();
  }

  async close(): Promise<void> {
    this.assertNotUpdating();
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    if (!folders.some(folder => folder.uri.scheme === SCHEME)) return;
    this.update(folders, folders.filter(folder => folder.uri.scheme !== SCHEME));
  }

  private assertNotUpdating(): void {
    if (this.pendingUpdate) throw new Error('The Explorer workspace update is in progress. Try again after it finishes.');
  }

  private update(current: readonly vscode.WorkspaceFolder[], desired: readonly { uri: vscode.Uri; name?: string }[]): void {
    // Preserve the first local folder to avoid needlessly changing rootPath.
    let start = 0;
    while (start < current.length && start < desired.length &&
      current[start]?.uri.toString() === desired[start]?.uri.toString() && current[start]?.name === desired[start]?.name) start++;
    const changed = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.pendingUpdate?.dispose(); this.pendingUpdate = undefined;
    });
    this.pendingUpdate = changed;
    try {
      if (!vscode.workspace.updateWorkspaceFolders(start, current.length - start, ...desired.slice(start))) {
        throw new Error('The Explorer workspace could not be updated. Retry opening ESP32 Files.');
      }
    } catch (error) {
      changed.dispose(); this.pendingUpdate = undefined; throw error;
    }
  }
}
