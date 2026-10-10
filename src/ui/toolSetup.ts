import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { ManagedTools } from '../tools/managedTools';
import type { ToolName } from '../tools/toolPaths';

export interface ToolSetupSettings {
  pythonPath: string;
  mpremotePath: string;
  esptoolPath: string;
}

export function createToolSetupCommands(
  tools: ManagedTools,
  device: Pick<DeviceManager, 'disconnect'>,
  output: Pick<vscode.OutputChannel, 'show' | 'appendLine'>,
  settings: () => ToolSetupSettings,
) {
  let active = false;
  const unavailable = () => new Error('MicroPal tool setup is in progress. Finish or cancel setup before using device commands.');
  const run = async (repair: boolean): Promise<void> => {
    if (active || tools.busy) throw unavailable();
    active = true;
    try {
      await tools.initialize();
      if (!repair && tools.paths) {
        void vscode.window.showInformationMessage('MicroPal tools are ready. Use MicroPal: Repair Tools to rebuild the managed environment.');
        return;
      }
      output.show(true);
      output.appendLine(`\n[tools] ${repair ? 'Repairing' : 'Setting up'} the private MicroPal environment.`);
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: repair ? 'MicroPal: Repair Tools' : 'MicroPal: Set Up Tools', cancellable: true,
      }, async (progress, token) => {
        const cancellation = new AbortController();
        const subscription = token.onCancellationRequested(() => cancellation.abort());
        if (token.isCancellationRequested) cancellation.abort();
        try {
          progress.report({ message: 'Releasing the device connection…' });
          await device.disconnect();
          if (cancellation.signal.aborted) {
            const error = new Error('Tool setup cancelled.'); error.name = 'AbortError'; throw error;
          }
          await tools.setup({
            pythonPath: settings().pythonPath.trim() || undefined, repair, signal: cancellation.signal,
            onProgress: message => { progress.report({ message }); output.appendLine(`[tools] ${message}`); },
          });
        } finally { subscription.dispose(); }
      });
      output.appendLine('[tools] Managed tools are ready.');
      void vscode.window.showInformationMessage('MicroPal tools are ready. You can now Connect or Flash Firmware. Custom tool paths remain in effect when configured.');
    } finally { active = false; }
  };
  return {
    get busy(): boolean { return active || tools.busy; },
    setup: () => run(false),
    repair: () => run(true),
    async ensure(required: ToolName[]): Promise<boolean> {
      if (active || tools.busy) throw unavailable();
      if (required.every(tool => settings()[`${tool}Path`].trim())) return true;
      await tools.initialize();
      if (active || tools.busy) throw unavailable();
      const ready = () => required.every(tool => settings()[`${tool}Path`].trim() || tools.paths?.[`${tool}Path`]);
      if (ready()) return true;
      const choice = await vscode.window.showInformationMessage(
        'Set up MicroPal tools to continue. Setup requires Python 3.10+ and downloads esptool and mpremote into a private environment.',
        'Set Up Tools',
      );
      if (choice !== 'Set Up Tools') return false;
      await run(false);
      return ready();
    },
  };
}
