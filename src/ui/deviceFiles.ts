import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DeviceFile } from '../core/types';

export class DeviceFileItem extends vscode.TreeItem {
  constructor(readonly file: DeviceFile, uri: vscode.Uri) {
    super(file.name, file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = uri.toString();
    this.resourceUri = uri;
    this.contextValue = file.isDirectory ? 'deviceDirectory' : 'deviceFile';
    this.iconPath = new vscode.ThemeIcon(file.isDirectory ? 'folder' : 'file');
    this.tooltip = file.isDirectory ? file.path : `${file.path} (${file.size} bytes)`;
    if (!file.isDirectory) this.command = { command: 'microPal.openDeviceFile', title: 'Open Device File', arguments: [this] };
  }
}

/** Root reads are explicit; reconnecting must never trigger a board-side query. */
export class DeviceFilesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly cache = new Map<string, DeviceFileItem[]>();
  private generation = 0;
  private readonly unsubscribe: () => void;
  constructor(private readonly manager: DeviceManager, private readonly filesystem: { toUri(path: string, session?: string): vscode.Uri }) {
    this.unsubscribe = manager.onDidChange(state => {
      if (['disconnected', 'connecting', 'reconnecting', 'flashing', 'error'].includes(state.phase)) this.clear();
    });
  }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.manager.state.port || ['disconnected', 'reconnecting', 'connecting', 'flashing', 'error'].includes(this.manager.state.phase)) return [];
    if (item instanceof DeviceFileItem) {
      if (!item.file.isDirectory) return [];
      return this.cache.get(item.file.path) ?? this.load(item.file.path);
    }
    if (this.cache.has('/')) return this.cache.get('/')!;
    const hint = new vscode.TreeItem('Open ESP32 Files in Explorer');
    hint.iconPath = new vscode.ThemeIcon('files');
    hint.command = { command: 'microPal.openDeviceFiles', title: 'Open ESP32 Files in Explorer' };
    return [hint];
  }
  private async load(path: string): Promise<DeviceFileItem[]> {
    const generation = this.generation;
    const session = this.manager.fileSystemSession;
    if (!session) return [];
    try {
      const files = await this.manager.listFiles(path, session);
      if (generation !== this.generation) return [];
      const items = files.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        .map(file => new DeviceFileItem(file, this.filesystem.toUri(file.path, session)));
      this.cache.set(path, items);
      return items;
    } catch (error) {
      void vscode.window.showErrorMessage(`MicroPal: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
  async refresh(): Promise<void> {
    this.clear();
    await this.load('/');
    this.changes.fire(undefined);
  }
  clear(): void { this.generation++; this.cache.clear(); this.changes.fire(undefined); }
  dispose(): void { this.unsubscribe(); this.changes.dispose(); }
}
