import path from 'node:path';
import * as vscode from 'vscode';

function deviceUri(uri: vscode.Uri): void {
  if (uri.scheme !== 'micropal' || !uri.authority || !uri.path.startsWith('/') || uri.query || uri.fragment) {
    throw vscode.FileSystemError.NoPermissions('Select a file or folder in ESP32 Files.');
  }
}

function localUri(uri: vscode.Uri): void {
  if (uri.scheme !== 'file' || uri.query || uri.fragment) {
    throw vscode.FileSystemError.NoPermissions('Choose a file or folder on this computer for the transfer.');
  }
}

async function requireNewDestination(uri: vscode.Uri): Promise<void> {
  try { await vscode.workspace.fs.stat(uri); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'FileNotFound') return;
    throw error;
  }
  throw vscode.FileSystemError.FileExists('The transfer destination already exists. Choose a new name or remove it deliberately before copying.');
}

/** Capture the selected board before any picker so a later connection cannot retarget the upload. */
export async function uploadToDevice(
  filesystem: { toUri(path?: string): vscode.Uri },
  target: vscode.Uri | undefined,
  folders: boolean,
): Promise<void> {
  const root = filesystem.toUri('/');
  const destination = target ?? root;
  deviceUri(root); deviceUri(destination);
  if (destination.authority !== root.authority) throw vscode.FileSystemError.Unavailable('The selected folder belongs to a previous ESP32 connection. Reopen it from ESP32 Files.');
  const stat = await vscode.workspace.fs.stat(destination);
  if (!(stat.type & vscode.FileType.Directory)) throw vscode.FileSystemError.FileNotADirectory(destination);
  const selected = await vscode.window.showOpenDialog({
    title: folders ? 'Upload folders to ESP32' : 'Upload files to ESP32',
    openLabel: 'Upload', canSelectFiles: !folders, canSelectFolders: folders, canSelectMany: true,
  });
  if (!selected?.length) return;
  const transfers = selected.map(source => {
    localUri(source);
    const name = path.posix.basename(source.path);
    if (!name || name === '.' || name === '..') throw vscode.FileSystemError.NoPermissions('Select a named local file or folder.');
    return { source, target: vscode.Uri.joinPath(destination, name) };
  });
  // The provider validates the captured session again after the dialog.
  await vscode.workspace.fs.stat(destination);
  for (const transfer of transfers) {
    await requireNewDestination(transfer.target);
    await vscode.workspace.fs.copy(transfer.source, transfer.target, { overwrite: false });
  }
}

/** Workspace filesystem copy handles both file bytes and recursive directory transfers. */
export async function downloadFromDevice(source: vscode.Uri, fallbackDirectory: string): Promise<void> {
  deviceUri(source);
  const stat = await vscode.workspace.fs.stat(source);
  const name = path.posix.basename(source.path) || 'ESP32 Files';
  const destination = await vscode.window.showSaveDialog({
    title: stat.type & vscode.FileType.Directory ? 'Download folder from ESP32' : 'Download file from ESP32',
    saveLabel: 'Download', defaultUri: vscode.Uri.file(path.join(fallbackDirectory, name)),
  });
  if (!destination) return;
  localUri(destination);
  await vscode.workspace.fs.stat(source);
  await requireNewDestination(destination);
  await vscode.workspace.fs.copy(source, destination, { overwrite: false });
}
