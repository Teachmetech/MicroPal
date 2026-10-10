import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { DeviceManager } from '../../src/core/deviceManager';
import { DeviceFileSystem } from '../../src/ui/deviceFileSystem';
import { DeviceExplorer } from '../../src/ui/deviceExplorer';
import { DeviceSessionPersistence } from '../../src/ui/deviceSessionPersistence';
import { FakeTransport, fakePort } from './fakeTransport';

interface State { phase: 'mounting' | 'reloading' | 'finished'; session: string; activations: number; restores: number; }
let device: DeviceManager | undefined;
let persistence: DeviceSessionPersistence | undefined;
const steps: string[] = [];
let reportPath = '';

function step(message: string): void {
  steps.push(message);
  writeFileSync(join(dirname(reportPath), 'progress.txt'), steps.join('\n'));
}
async function until(predicate: () => Promise<boolean> | boolean, message: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function nativeCopy(source: vscode.Uri, targetFolder: vscode.Uri, expected: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('revealInExplorer', source);
  await vscode.commands.executeCommand('filesExplorer.copy');
  await vscode.commands.executeCommand('revealInExplorer', targetFolder);
  await vscode.commands.executeCommand('filesExplorer.paste');
  await until(async () => { try { await vscode.workspace.fs.stat(expected); return true; } catch { return false; } },
    `Native Explorer copy did not create ${expected.toString()}`);
}
async function verify(context: vscode.ExtensionContext, filesystem: DeviceFileSystem, manager: DeviceManager,
  observer: DeviceSessionPersistence, transport: FakeTransport, saved: State): Promise<void> {
  const folders = vscode.workspace.workspaceFolders!;
  assert.equal(folders.length, 2); assert.equal(folders[0]!.uri.scheme, 'file');
  assert.equal(folders[1]!.name, 'ESP32 Files'); assert.equal(folders[1]!.uri.scheme, 'micropal');
  assert.equal(folders[1]!.uri.authority, saved.session);
  assert.equal(manager.fileSystemSession, saved.session);
  step('Local folder above native ESP32 Files; original session restored after editor reload.');
  const fs = vscode.workspace.fs;
  const root = folders[1]!.uri;
  const remote = (path: string) => vscode.Uri.joinPath(root, path);
  const local = (path: string) => vscode.Uri.joinPath(folders[0]!.uri, path);
  const bytes = Uint8Array.from([0, 255, 1, 128, 13, 10, 0]);
  await fs.createDirectory(remote('binary/nested'));
  await fs.writeFile(remote('binary/nested/test.bin'), bytes);
  assert.deepEqual(Buffer.from(await fs.readFile(remote('binary/nested/test.bin'))), Buffer.from(bytes));
  await fs.rename(remote('binary/nested/test.bin'), remote('binary/nested/renamed.bin'));
  assert.equal((await fs.stat(remote('binary/nested/renamed.bin'))).size, bytes.length);
  await fs.delete(remote('binary'), { recursive: true });
  await assert.rejects(async () => await fs.stat(remote('binary/nested/renamed.bin')));
  step('Native workspace.fs creates, reads, renames, and recursively deletes binary files/folders.');

  await fs.createDirectory(local('upload/nested'));
  await fs.writeFile(local('upload/nested/data.bin'), bytes);
  await fs.copy(local('upload'), remote('upload'));
  assert.deepEqual(Buffer.from(await fs.readFile(remote('upload/nested/data.bin'))), Buffer.from(bytes));
  await fs.copy(remote('upload'), local('download'));
  assert.deepEqual(Buffer.from(await fs.readFile(local('download/nested/data.bin'))), Buffer.from(bytes));
  step('Recursive local-to-device and device-to-local workspace.fs copies preserve all binary bytes.');

  await fs.writeFile(local('move-up.bin'), bytes);
  await fs.rename(local('move-up.bin'), remote('move-up.bin'));
  await assert.rejects(async () => await fs.stat(local('move-up.bin')));
  assert.deepEqual(Buffer.from(await fs.readFile(remote('move-up.bin'))), Buffer.from(bytes));
  await fs.createDirectory(remote('move-down/nested'));
  await fs.writeFile(remote('move-down/nested/data.bin'), bytes);
  await fs.rename(remote('move-down'), local('move-down'));
  await assert.rejects(async () => await fs.stat(remote('move-down')));
  assert.deepEqual(Buffer.from(await fs.readFile(local('move-down/nested/data.bin'))), Buffer.from(bytes));
  step('Cross-provider file upload and directory download moves preserve bytes and delete the original only after copying.');

  const clipboard = await vscode.env.clipboard.readText();
  try {
    await fs.writeFile(local('native-upload.bin'), bytes);
    await fs.createDirectory(remote('native-target'));
    await nativeCopy(local('native-upload.bin'), remote('native-target'), remote('native-target/native-upload.bin'));
    assert.deepEqual(Buffer.from(await fs.readFile(remote('native-target/native-upload.bin'))), Buffer.from(bytes));
    await fs.createDirectory(local('native-download'));
    await nativeCopy(remote('native-target'), local('native-download'), local('native-download/native-target'));
    assert.deepEqual(Buffer.from(await fs.readFile(local('native-download/native-target/native-upload.bin'))), Buffer.from(bytes));
    step('Native Explorer Copy/Paste transfers a local binary file up and a device directory down.');
  } finally { await vscode.env.clipboard.writeText(clipboard); }

  const editable = remote('edit.py');
  await fs.writeFile(editable, Buffer.from('print("before")\n'));
  const document = await vscode.workspace.openTextDocument(editable);
  await vscode.window.showTextDocument(document);
  await transport.writeFileBytes(fakePort, '/edit.py', Buffer.from('print("after!")\n'), { create: false, overwrite: true });
  filesystem.refresh();
  await until(() => document.getText() === 'print("after!")\n',
    'Explicit Refresh did not reload the clean open editor after an external file change with unchanged board mtime', 8000);
  step('Explicit Refresh reloads an already-open clean editor after external changes with unchanged board mtime.');
  const change = new vscode.WorkspaceEdit();
  change.replace(editable, new vscode.Range(0, 0, document.lineCount, 0), 'print("saved from editor")\n');
  assert.equal(await vscode.workspace.applyEdit(change), true);
  assert.equal(document.isDirty, true);
  assert.equal(await document.save(), true);
  const savedBytes = await fs.readFile(editable);
  assert.equal(Buffer.from(savedBytes).toString('utf8'), 'print("saved from editor")\n');
  step('Native text editor edits and saves directly to the device filesystem.');

  const pending = new vscode.WorkspaceEdit(); pending.insert(editable, new vscode.Position(0, 0), '# unsaved\n');
  assert.equal(await vscode.workspace.applyEdit(pending), true);
  await manager.disconnect(); await manager.connect(fakePort);
  assert.notEqual(manager.fileSystemSession, saved.session);
  await observer.flush();
  assert.equal(context.globalState.get('microPal.mount.' + saved.session), undefined);
  await assert.rejects(async () => await new DeviceExplorer(context, manager, filesystem).restore(),
    { code: 'Unavailable' });
  step('Explicit disconnect revokes the durable session descriptor; a fresh Explorer cannot restore it.');
  let rejected = false;
  try { rejected = !await document.save(); }
  catch (error) { rejected = /session|connect|unavailable/i.test(String(error)); }
  assert.equal(rejected, true, 'Stale document save must fail');
  assert.equal(document.isDirty, true, 'Stale editor must retain unsaved changes');
  assert.deepEqual(Buffer.from(await manager.readFileBytes('/edit.py', manager.fileSystemSession)), Buffer.from(savedBytes));
  step('After changing the connection, old document saves fail, preserve dirty edits, and leave board bytes unchanged.');
  // Restore the original fixture identity solely to close its dirty editor without a save dialog.
  await manager.disconnect(); await manager.restoreFileSystemSession(fakePort, saved.session);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.equal(document.isDirty, false);
  filesystem.refresh();

  const descriptorKey = 'microPal.mount.' + saved.session;
  for (const delay of [0, 1]) {
    if (!manager.fileSystemSession) await manager.restoreFileSystemSession(fakePort, saved.session);
    const opening = new DeviceExplorer(context, manager, filesystem).open().then(
      () => undefined, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, delay));
    await manager.disconnect();
    await observer.flush();
    const outcome = await opening;
    if (outcome !== undefined) assert.equal((outcome as { code?: unknown }).code, 'Unavailable');
    assert.equal(context.globalState.get(descriptorKey), undefined,
      `Pending descriptor save must stay revoked after disconnect (${delay} ms delay)`);
  }
  step('Opening the native Explorer during disconnect leaves no saved descriptor at 0 ms and 1 ms delays.');
}

async function run(context: vscode.ExtensionContext): Promise<void> {
  reportPath = process.env.MICROPAL_TEST_REPORT ?? '';
  if (!reportPath) throw new Error('MICROPAL_TEST_REPORT is required for the isolated fixture.');
  const progress = join(dirname(reportPath), 'progress.txt');
  if (existsSync(progress)) steps.push(...readFileSync(progress, 'utf8').split('\n').filter(Boolean));
  const statePath = join(dirname(reportPath), 'fixture-state.json');
  const transport = new FakeTransport(join(dirname(reportPath), 'fake-device.json'));
  const manager = new DeviceManager(transport, () => ({ mpremotePath: 'unused', preferredPort: '', baudRate: 115200,
    autoReconnect: true, syncExclusions: [] }));
  device = manager;
  const observer = new DeviceSessionPersistence(context, manager);
  persistence = observer;
  const filesystem = new DeviceFileSystem(manager);
  context.subscriptions.push(filesystem, vscode.workspace.registerFileSystemProvider('micropal', filesystem, { isCaseSensitive: true }));
  const explorer = new DeviceExplorer(context, manager, filesystem);
  let state: State | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as State : undefined;
  if (state?.phase === 'finished') return;
  const activations = (state?.activations ?? 0) + 1;
  if (!state) {
    assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Start with a genuine single-folder workspace');
    assert.equal(vscode.workspace.workspaceFile, undefined);
    await manager.connect(fakePort);
    state = { phase: 'mounting', session: manager.fileSystemSession!, activations, restores: 0 };
    writeFileSync(statePath, JSON.stringify(state));
    step('Starting from one local folder; mounting native ESP32 Files.');
    await explorer.open();
  } else {
    state.activations = activations;
    await explorer.restore(); state.restores++;
    assert.equal(manager.fileSystemSession, state.session);
    writeFileSync(statePath, JSON.stringify(state));
    step(`Fresh extension host activation ${activations} restored the saved USB identity without probing.`);
  }
  await until(() => vscode.workspace.workspaceFile !== undefined &&
    (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'micropal') ?? false),
    'The ESP32 workspace folder never mounted');
  if (state.phase === 'mounting') {
    await observer.flush();
    assert.ok(context.globalState.get('microPal.mount.' + state.session), 'Active session descriptor survives workspace mount');
    state.phase = 'reloading'; writeFileSync(statePath, JSON.stringify(state));
    step('Reloading the editor window to verify persistent connection restoration.');
    // The initiating host is terminated; awaiting its RPC can reject Canceled.
    void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => {});
    return;
  }
  await verify(context, filesystem, manager, observer, transport, state);
  state.phase = 'finished'; writeFileSync(statePath, JSON.stringify(state));
  const { discoveries, probes } = JSON.parse(readFileSync(join(dirname(reportPath), 'fake-device.json'), 'utf8')) as { discoveries: number; probes: number };
  assert.equal(probes, 2, 'Only two deliberate connects probe the fake board; restoration does not');
  writeFileSync(reportPath, JSON.stringify({ passed: true, editor: vscode.env.appName, version: vscode.version,
    activations: state.activations, restorations: state.restores, discoveries, probes, steps }, null, 2));
  setTimeout(() => { void vscode.commands.executeCommand('workbench.action.closeWindow'); }, 200);
}

export function activate(context: vscode.ExtensionContext): void {
  void run(context).catch(error => {
    // A single-folder → multi-root transition may itself terminate this host.
    // The fresh host resumes from the persistent stage and produces the report.
    if (error instanceof Error && error.name === 'Canceled') return;
    const path = process.env.MICROPAL_TEST_REPORT;
    if (path) writeFileSync(path, JSON.stringify({ passed: false, editor: vscode.env.appName, version: vscode.version,
      error: error instanceof Error ? error.stack : String(error), steps }, null, 2));
    setTimeout(() => { void vscode.commands.executeCommand('workbench.action.closeWindow'); }, 200);
  });
}
export async function deactivate(): Promise<void> {
  persistence?.dispose();
  await Promise.all([device?.dispose(), persistence?.flush()]);
}
