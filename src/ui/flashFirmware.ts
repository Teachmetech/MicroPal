import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DevicePort } from '../core/types';
import { FIRMWARE_PROFILES, type EsptoolFlasher, type FirmwareChip } from '../transport/esptool';

type FlashOutput = Pick<vscode.OutputChannel, 'show' | 'appendLine'>;

export function createFirmwareFlashCommand(
  device: DeviceManager,
  flasher: EsptoolFlasher,
  output: FlashOutput,
  selectPort: () => Promise<DevicePort | undefined>,
): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) throw new Error('A firmware flashing workflow is already open. Finish or cancel it first.');
    active = true;
    try {
      const port = await selectPort();
      if (!port) return;
      const chips = (Object.entries(FIRMWARE_PROFILES) as [FirmwareChip, { label: string; offset: string }][])
        .map(([chip, profile]) => ({ ...profile, chip, description: `Standard MicroPython image offset: ${profile.offset}` }));
      const profile = await vscode.window.showQuickPick(chips, {
        title: 'Firmware: select the chip', placeHolder: 'Match the chip and firmware to your exact board',
      });
      if (!profile) return;
      const selected = await vscode.window.showOpenDialog({
        title: 'Select firmware for your board', openLabel: 'Select Firmware',
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { 'Firmware binary': ['bin'] },
      });
      const firmware = selected?.[0];
      if (!firmware) return;
      if (firmware.scheme !== 'file') throw new Error('Choose a local firmware binary.');
      const offset = await vscode.window.showInputBox({
        title: 'Firmware flash address', value: profile.offset,
        prompt: 'Use the address on your board’s firmware download page. Defaults are for standard combined MicroPython images.',
        validateInput: value => /^0x[0-9a-f]{1,8}$/i.test(value.trim()) && Number(value.trim()) % 0x1000 === 0
          ? undefined : 'Enter a hexadecimal address aligned to 0x1000, such as 0x0 or 0x1000.',
      });
      if (offset === undefined) return;
      const erase = await vscode.window.showQuickPick([
        { label: 'Write firmware only', description: 'Erase only the sectors written by this image.', eraseAll: false },
        { label: 'Erase entire flash', description: 'Delete all device files and settings; useful for a fresh installation.', eraseAll: true },
      ], { title: 'Firmware: choose erase mode' });
      if (!erase) return;
      const answer = await vscode.window.showWarningMessage(
        `Flash ${profile.label} firmware on ${port.path}?`,
        { modal: true, detail: `Firmware: ${firmware.fsPath}\nAddress: ${offset.trim()}\nErase mode: ${erase.label}\n\nThis stops the current Run or REPL. Flash writes replace existing data in the written sectors; a full erase deletes all device files. Use a firmware image built for your exact board.` },
        'Flash Firmware',
      );
      if (answer !== 'Flash Firmware') return;
      output.show(true);
      output.appendLine(`\n[flash] ${profile.label} · ${port.path} · ${firmware.fsPath} · ${offset.trim()} · ${erase.label}`);
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'MicroPal: Flash Firmware', cancellable: true,
      }, async (_progress, token) => {
        const cancellation = new AbortController();
        const subscription = token.onCancellationRequested(() => cancellation.abort());
        if (token.isCancellationRequested) cancellation.abort();
        try {
          await device.flashFirmware(port, signal => flasher.flash({
            chip: profile.chip, port: port.path, firmwarePath: firmware.fsPath,
            offset: offset.trim(), eraseAll: erase.eraseAll,
          }, AbortSignal.any([signal, cancellation.signal])));
        } finally { subscription.dispose(); }
      });
      output.appendLine('[flash] Firmware flashed successfully.');
      void vscode.window.showInformationMessage('Firmware flashed. Reset the board if needed, then use MicroPal: Connect.');
    } finally { active = false; }
  };
}
