import * as vscode from 'vscode';
import type { DeviceSettings } from './core/types';
import type { ManagedToolPaths } from './tools/managedTools';
import { resolveToolPath } from './tools/toolPaths';
export function readSettings(managed?: ManagedToolPaths): DeviceSettings {
  const config = vscode.workspace.getConfiguration('microPal');
  return {
    mpremotePath: resolveToolPath('mpremote', config.get<string>('mpremotePath', ''), managed),
    preferredPort: config.get<string>('preferredPort', ''),
    baudRate: config.get<number>('baudRate', 115200),
    autoReconnect: config.get<boolean>('autoReconnect', true),
    autoShowOutput: config.get<boolean>('autoShowOutput', true),
    syncExclusions: config.get<string[]>('syncExclusions', []),
  };
}
