import * as vscode from 'vscode';
import * as path from 'node:path';
import { DeviceManager } from './core/deviceManager';
import type { DevicePort } from './core/types';
import { planSync, remotePathForFile } from './core/projectSync';
import { MpremoteTransport } from './transport/mpremote';
import { NodeProcessRunner } from './transport/processRunner';
import { SerialPortOwners } from './transport/serialPortOwners';
import { EsptoolFlasher } from './transport/esptool';
import { SerialConsole } from './transport/serialConsole';
import { MicroPythonFirmwareService } from './firmware/microPythonFirmware';
import { createFirmwareFlashCommand } from './ui/flashFirmware';
import { createConnectCommand } from './ui/connectDevice';
import { createRepairDeviceFilesCommand } from './ui/repairDeviceFiles';
import { createTerminalLauncher } from './ui/terminalSession';
import { DeviceFileItem, DeviceFilesProvider } from './ui/deviceFiles';
import { DeviceFileSystem } from './ui/deviceFileSystem';
import { DeviceExplorer } from './ui/deviceExplorer';
import { downloadFromDevice, uploadToDevice } from './ui/deviceTransfers';
import { DeviceSessionPersistence } from './ui/deviceSessionPersistence';
import { DeviceStatusBar } from './ui/statusBar';
import { readSettings } from './settings';
import { ManagedTools } from './tools/managedTools';
import { resolveToolPath, type ToolName } from './tools/toolPaths';
import { createToolSetupCommands } from './ui/toolSetup';

let manager: DeviceManager | undefined;
let managedTools: ManagedTools | undefined;
let fileSessions: DeviceSessionPersistence | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const output = vscode.window.createOutputChannel('MicroPal');
  context.subscriptions.push(output);
  const tools = new ManagedTools(path.join(context.globalStorageUri.fsPath, 'tools'), new NodeProcessRunner(), text => output.append(text));
  managedTools = tools;
  const settings = () => readSettings(tools.paths);
  const toolSettings = () => {
    const config = vscode.workspace.getConfiguration('microPal');
    return {
      pythonPath: config.get<string>('pythonPath', ''),
      mpremotePath: config.get<string>('mpremotePath', ''),
      esptoolPath: config.get<string>('esptoolPath', ''),
    };
  };
  const launcher = createTerminalLauncher({
    create: spec => vscode.window.createTerminal({
      name: 'MicroPal REPL', shellPath: spec.executable, shellArgs: spec.args,
      isTransient: true,
    }),
    onClose: listener => {
      const subscription = vscode.window.onDidCloseTerminal(listener);
      return () => subscription.dispose();
    },
  });
  const console = new SerialConsole(new NodeProcessRunner(), () => tools.paths?.pythonPath,
    text => output.append(text), () => output.show(true));
  const device = new DeviceManager(new MpremoteTransport(new NodeProcessRunner(), settings, launcher, text => output.append(text),
    (port, signal) => console.open(port, signal), () => vscode.workspace.isTrusted && Boolean(tools.paths?.pythonPath)),
    settings, 2000, () => setup.busy);
  const setup = createToolSetupCommands(tools, device, output, toolSettings);
  manager = device;
  const filesystem = new DeviceFileSystem(device);
  const explorer = new DeviceExplorer(context, device, filesystem);
  const sessionPersistence = new DeviceSessionPersistence(context, device);
  fileSessions = sessionPersistence;
  const files = new DeviceFilesProvider(device, filesystem);
  const status = new DeviceStatusBar(device);
  let connectionEpoch = 0;
  let syncing = false;
  let lastMessage: string | undefined;
  let lastPhase = device.state.phase;
  const unsubscribe = device.onDidChange(state => {
    if (['connecting', 'disconnected', 'reconnecting'].includes(state.phase)) connectionEpoch++;
    if (state.message && state.message !== lastMessage) output.appendLine(`[${state.phase}] ${state.message}`);
    lastMessage = state.message;
    if (state.phase === 'connected' && lastPhase === 'reconnecting') filesystem.refresh();
    lastPhase = state.phase;
  });
  context.subscriptions.push(
    files, filesystem, status, sessionPersistence,
    vscode.window.registerTreeDataProvider('microPal.files', files),
    { dispose: unsubscribe },
  );
  const register = (name: string, action: (...args: unknown[]) => Promise<unknown> | unknown, required: ToolName[] = ['mpremote']) => {
    context.subscriptions.push(vscode.commands.registerCommand(`microPal.${name}`, async (...args: unknown[]) => {
      try {
        try {
          if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using device tools.');
          if (required.length && !await setup.ensure(required)) return;
          await action(...args);
        } finally {
          await sessionPersistence.flush();
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        const fileAction = ['openDeviceFiles', 'refreshFiles', 'openDeviceFile', 'downloadFile',
          'uploadFilesToDevice', 'uploadFolderToDevice'].includes(name);
        const choice = await vscode.window.showErrorMessage(`MicroPal: ${message}`,
          ...(fileAction ? ['Repair ESP32 Files', 'Show Output'] : ['Show Output']));
        if (choice === 'Show Output') output.show(true);
        else if (choice === 'Repair ESP32 Files') await vscode.commands.executeCommand('microPal.repairDeviceFiles');
      }
    }));
  };

  const portOwners = new SerialPortOwners(new NodeProcessRunner(), {
    managedToolsRoot: path.join(context.globalStorageUri.fsPath, 'tools'),
  });
  const connect = createConnectCommand(device, portOwners, async () => {
    // Load an existing console interpreter even when a custom mpremote path
    // makes setup.ensure unnecessary. This never installs or downloads tools.
    if (settings().autoShowOutput) await tools.initialize();
    const port = await selectPort(device, output);
    if (port && settings().autoShowOutput) output.show(true);
    return port;
  }, async () => {
    files.clear();
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file')) await explorer.open();
    else void vscode.window.showInformationMessage('Connected. Open a local project folder, then run MicroPal: Open ESP32 Files in Explorer.');
  }, output, () => vscode.workspace.getConfiguration('microPal').get<boolean>('autoReleasePort', true));
  register('connect', connect);
  const repairDeviceFiles = createRepairDeviceFilesCommand(device, explorer, connect, async () => {
    files.clear();
    filesystem.refresh();
    await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
  });
  register('repairDeviceFiles', repairDeviceFiles);
  register('openDeviceFiles', () => explorer.open());
  register('closeDeviceFiles', () => explorer.close(), []);
  register('uploadFilesToDevice', async target => {
    await uploadToDevice(filesystem, target instanceof vscode.Uri ? target : undefined, false);
    files.clear();
  });
  register('uploadFolderToDevice', async target => {
    await uploadToDevice(filesystem, target instanceof vscode.Uri ? target : undefined, true);
    files.clear();
  });
  register('setupTools', () => setup.setup(), []);
  register('repairTools', () => setup.repair(), []);
  const flasher = new EsptoolFlasher(new NodeProcessRunner(),
    () => resolveToolPath('esptool', toolSettings().esptoolPath, tools.paths),
    text => output.append(text));
  const firmware = new MicroPythonFirmwareService(context.globalStorageUri.fsPath);
  register('flashFirmware', createFirmwareFlashCommand(device, flasher, output, () => selectPort(device, output), firmware), ['esptool']);
  register('disconnect', () => device.disconnect(), []);
  register('showOutput', () => output.show(true), []);
  register('openRepl', () => device.openRepl());
  register('stop', () => device.stop());
  register('softReset', async () => { await device.softReset(); files.clear(); filesystem.refresh(); });
  register('runFile', async () => {
    const file = await savedFile();
    if (!file) return;
    if (!file.endsWith('.py')) throw new Error('Run Current File requires a saved Python (.py) file.');
    output.show(true); output.appendLine(`\n[run] ${path.basename(file)}`);
    await device.runFile(file);
  });
  register('uploadFile', async () => {
    const file = await savedFile();
    if (!file) return;
    const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    const destination = root ? remotePathForFile(root.uri.fsPath, file) : `/${path.basename(file)}`;
    await device.uploadFile(file, destination);
    files.clear();
    filesystem.notifyChanged(destination);
    void vscode.window.showInformationMessage(`Uploaded ${destination}`);
  });
  register('refreshFiles', async () => {
    const mount = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'micropal');
    if (device.state.phase !== 'connected' || (mount && mount.uri.authority !== device.fileSystemSession)) {
      await repairDeviceFiles();
      return;
    }
    filesystem.refresh();
    await files.refresh();
    await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
  });
  register('openDeviceFile', async item => {
    if (!(item instanceof DeviceFileItem) || item.file.isDirectory) return;
    if (!item.resourceUri) return;
    const document = await vscode.workspace.openTextDocument(item.resourceUri);
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('downloadFile', async item => {
    const source = item instanceof DeviceFileItem ? item.resourceUri : item instanceof vscode.Uri ? item : undefined;
    if (!source) return;
    const localRoot = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    await downloadFromDevice(source, localRoot?.uri.fsPath ?? context.globalStorageUri.fsPath);
  });
  register('syncProject', async () => {
    if (syncing) throw new Error('A project sync is already in progress.');
    if (!device.state.port || ['disconnected', 'connecting', 'reconnecting', 'error'].includes(device.state.phase)) throw new Error('Connect a device before syncing.');
    const root = await chooseWorkspace();
    if (!root) return;
    // A second request may have finished its workspace picker while this one waited.
    if (syncing) throw new Error('A project sync is already in progress.');
    const epoch = connectionEpoch;
    syncing = true;
    try {
      if (!await vscode.workspace.saveAll(false)) throw new Error('Save your project files before syncing.');
      const plan = await planSync(root.uri.fsPath, settings().syncExclusions);
      if (!plan.files.length) { void vscode.window.showInformationMessage('No files matched the project sync settings.'); return; }
      const answer = await vscode.window.showWarningMessage(
        `Upload ${plan.files.length} files (${formatBytes(plan.totalBytes)}) from “${root.name}” to ${device.state.port?.path}? Matching device files will be overwritten. The running program or REPL will stop.`,
        { modal: true, detail: 'Other device files are kept. Check MicroPal: Sync Exclusions before syncing secrets or large projects.' },
        'Upload Files',
      );
      if (answer !== 'Upload Files') return;
      let completed = 0;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MicroPal sync (cancel after current file)', cancellable: true }, async (progress, token) => {
        for (const file of plan.files) {
          if (token.isCancellationRequested) break;
          if (connectionEpoch !== epoch) throw new Error('The device connection changed. Sync stopped; reconnect and start a new sync.');
          await device.uploadFile(file.localPath, file.remotePath);
          filesystem.notifyChanged(file.remotePath);
          completed++;
          progress.report({ message: file.remotePath, increment: 100 / plan.files.length });
        }
      });
      files.clear();
      void vscode.window.showInformationMessage(`Uploaded ${completed} of ${plan.files.length} project files.`);
    } finally { syncing = false; }
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('microPal.mpremotePath') || event.affectsConfiguration('microPal.esptoolPath') || event.affectsConfiguration('microPal.baudRate')) {
      // Never switch executable/configuration underneath an active owner.
      void device.disconnect().catch(error => output.appendLine(String(error)));
    } else if (event.affectsConfiguration('microPal.autoShowOutput')) {
      void device.refreshOutput().catch(error => output.appendLine(String(error)));
    }
  }));
  // Mounting a second workspace root may restart the host. Restore the saved
  // USB identity before registering the filesystem, so initial reads can succeed.
  if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'micropal')) {
    try { await tools.initialize(); await explorer.restore(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[filesystem] ${message}`);
      void vscode.window.showWarningMessage(`MicroPal: ${message}`, 'Repair ESP32 Files').then(choice => {
        if (choice === 'Repair ESP32 Files') void vscode.commands.executeCommand('microPal.repairDeviceFiles');
      });
    }
  }
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('micropal', filesystem, { isCaseSensitive: true }));
  device.start();
}

async function savedFile(): Promise<string | undefined> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.uri.scheme !== 'file') throw new Error('Open a saved local file first.');
  if (document.isDirty && !await document.save()) return undefined;
  return document.uri.fsPath;
}

async function chooseWorkspace(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
  if (!folders?.length) throw new Error('Open a project folder before syncing.');
  if (folders.length === 1) return folders[0];
  const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: 'Select the local project to upload' });
  return choice?.folder;
}

async function selectPort(device: DeviceManager, output: vscode.OutputChannel): Promise<DevicePort | undefined> {
  let ports: DevicePort[] = [];
  try { ports = await device.discover(); }
  catch (error) { output.appendLine(`Discovery: ${String(error)}`); void vscode.window.showWarningMessage('Device discovery failed. Verify the mpremote path, or enter a serial port manually.'); }
  const preferred = vscode.workspace.getConfiguration('microPal').get<string>('preferredPort', '').trim();
  if (preferred) {
    const match = ports.find(port => preferred === port.path || (port.serialNumber && preferred === `id:${port.serialNumber}`));
    if (match) return match;
    if (!preferred.startsWith('id:')) return manualPort(preferred);
  }
  const choices = ports.sort((a, b) => Number(b.likelyEsp32) - Number(a.likelyEsp32)).map(port => ({ label: port.path, description: port.description, detail: port.likelyEsp32 ? 'ESP32 or common USB serial bridge candidate' : 'Serial device — board type is not verified', port }));
  const choice = await vscode.window.showQuickPick([...choices, { label: 'Enter serial port…', description: 'For an unlisted device', detail: '', port: undefined }], { title: 'Connect a MicroPython device', placeHolder: 'Select the ESP32 serial port' });
  if (!choice) return undefined;
  if (choice.port) return choice.port;
  const input = await vscode.window.showInputBox({ title: 'Serial port', prompt: 'Enter a local serial path such as /dev/cu.usbmodem1101, /dev/ttyUSB0, or COM3', validateInput: value => isSerialPath(value.trim()) ? undefined : 'Use a /dev/ serial path or a COM port name.' });
  return input ? manualPort(input.trim()) : undefined;
}
function isSerialPath(value: string): boolean { return /^(?:\/dev\/[^\s\x00]+|COM\d+)$/i.test(value); }
function manualPort(value: string): DevicePort {
  if (!isSerialPath(value)) throw new Error('Preferred Port must be a /dev/ serial path, COM port, or an available id:USB_SERIAL_NUMBER.');
  return { path: value, description: 'Manually selected serial port', likelyEsp32: false };
}
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`; }

export async function deactivate(): Promise<void> {
  const current = manager; manager = undefined;
  const tools = managedTools; managedTools = undefined;
  const sessions = fileSessions; fileSessions = undefined;
  // A normal host reload preserves a live mount. Explicit disconnections have
  // already revoked their descriptors; finish those writes before exiting.
  sessions?.dispose();
  await Promise.all([current?.dispose(), tools?.dispose(), sessions?.flush()]);
}
