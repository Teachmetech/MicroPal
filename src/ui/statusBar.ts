import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { ConnectionPhase, ConnectionState } from '../core/types';
const icons: Record<ConnectionPhase, string> = {
  disconnected: 'debug-disconnect', connecting: 'sync~spin', connected: 'plug', busy: 'sync~spin',
  running: 'play', repl: 'terminal', reconnecting: 'sync~spin', flashing: 'sync~spin', error: 'warning',
};
export class DeviceStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);
  private readonly stop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 59);
  private readonly unsubscribe: () => void;
  constructor(manager: DeviceManager) {
    this.item.name = 'MicroPal';
    this.stop.name = 'MicroPal Stop'; this.stop.text = '$(debug-stop)'; this.stop.command = 'microPal.stop'; this.stop.tooltip = 'Stop execution on the ESP32';
    this.unsubscribe = manager.onDidChange(state => this.update(state)); this.update(manager.state);
  }
  private update(state: ConnectionState): void {
    const present = ['connected', 'busy', 'running', 'repl'].includes(state.phase);
    this.item.text = `$(${icons[state.phase]}) MicroPal: ${state.phase}${state.port ? ` · ${state.port.path}` : ''}`;
    this.item.tooltip = [state.port?.description, state.message, 'Live output yields the serial port to MicroPal commands. Click to open the interactive REPL.'].filter(Boolean).join('\n');
    this.item.command = present ? 'microPal.openRepl' : 'microPal.connect';
    this.item.backgroundColor = state.phase === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
    if (present) this.stop.show(); else this.stop.hide();
    void vscode.commands.executeCommand('setContext', 'microPal.connected', present);
  }
  dispose(): void { this.unsubscribe(); this.item.dispose(); this.stop.dispose(); }
}
