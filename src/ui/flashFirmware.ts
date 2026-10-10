import * as vscode from 'vscode';
import type { DeviceManager } from '../core/deviceManager';
import type { DevicePort } from '../core/types';
import type { EsptoolFlasher } from '../transport/esptool';
import { MICROPYTHON_BOARDS, type MicroPythonBoard, type MicroPythonFirmwareService } from '../firmware/microPythonFirmware';

type FlashOutput = Pick<vscode.OutputChannel, 'show' | 'appendLine'>;

export function createFirmwareFlashCommand(
  device: DeviceManager,
  flasher: EsptoolFlasher,
  output: FlashOutput,
  selectPort: () => Promise<DevicePort | undefined>,
  firmwareService: Pick<MicroPythonFirmwareService, 'getReleases' | 'download'>,
): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) throw new Error('A firmware flashing workflow is already open. Finish or cancel it first.');
    active = true;
    try {
      requireTrust();
      const port = await selectPort();
      if (!port) return;
      const chips = MICROPYTHON_BOARDS.map(board => ({ ...board, description: `Combined MicroPython image address: ${board.offset}` }));
      const profile = await vscode.window.showQuickPick(chips, {
        title: 'Firmware: select the chip', placeHolder: 'Match the chip and firmware to your exact board',
      });
      if (!profile) return;
      const source = await vscode.window.showQuickPick([
        { label: 'Download official MicroPython', description: 'Choose a variant and stable version from micropython.org', source: 'official' as const },
        { label: 'Use a local BIN file', description: 'Flash firmware you already downloaded or built', source: 'local' as const },
      ], { title: 'Firmware: select the source' });
      if (!source) return;
      const firmware = source.source === 'official'
        ? await officialFirmware(profile, firmwareService, output)
        : await localFirmware(profile);
      if (!firmware) return;
      requireTrust();
      const erase = await vscode.window.showQuickPick([
        { label: 'Write firmware only', description: 'Erase only the sectors written by this image.', eraseAll: false },
        { label: 'Erase entire flash', description: 'Delete all device files and settings; useful for a fresh installation.', eraseAll: true },
      ], { title: 'Firmware: choose erase mode' });
      if (!erase) return;
      const answer = await vscode.window.showWarningMessage(
        `Flash ${profile.label} firmware on ${port.path}?`,
        { modal: true, detail: `${firmware.description}\nFirmware: ${firmware.firmwarePath}\nAddress: ${firmware.offset}\nErase mode: ${erase.label}\n\nThis stops the current Run or REPL. Flash writes replace existing data in the written sectors; a full erase deletes all device files. Use a firmware image built for your exact board.` },
        'Flash Firmware',
      );
      if (answer !== 'Flash Firmware') return;
      requireTrust();
      output.show(true);
      output.appendLine(`\n[flash] ${profile.label} · ${port.path} · ${firmware.firmwarePath} · ${firmware.offset} · ${erase.label}`);
      await cancellableProgress('MicroPal: Flash Firmware', async (_progress, cancellation) => {
        requireTrust();
        await device.flashFirmware(port, signal => flasher.flash({
          chip: profile.chip, port: port.path, firmwarePath: firmware.firmwarePath,
          offset: firmware.offset, eraseAll: erase.eraseAll,
        }, AbortSignal.any([signal, cancellation])));
      });
      output.appendLine('[flash] Firmware flashed successfully.');
      void vscode.window.showInformationMessage('Firmware flashed. Reset the board if needed, then use MicroPal: Connect.');
    } finally { active = false; }
  };
}

interface SelectedFirmware { firmwarePath: string; offset: string; description: string; }

async function localFirmware(profile: MicroPythonBoard): Promise<SelectedFirmware | undefined> {
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
    prompt: 'Use the address supplied with your firmware. Defaults are for standard combined MicroPython images.',
    validateInput: value => /^0x[0-9a-f]{1,8}$/i.test(value.trim()) && Number(value.trim()) % 0x1000 === 0
      ? undefined : 'Enter a hexadecimal address aligned to 0x1000, such as 0x0 or 0x1000.',
  });
  if (offset === undefined) return;
  return { firmwarePath: firmware.fsPath, offset: offset.trim(), description: 'Source: local BIN file' };
}

async function officialFirmware(
  board: MicroPythonBoard, service: Pick<MicroPythonFirmwareService, 'getReleases' | 'download'>, output: FlashOutput,
): Promise<SelectedFirmware | undefined> {
  requireTrust();
  const releases = await cancellableProgress('MicroPal: Fetch MicroPython releases', (_progress, signal) => service.getReleases(board.id, signal));
  const variants = board.variants.filter(variant => releases.some(release => release.variantId === variant.id));
  if (!variants.length) throw new Error('No supported MicroPython variants were found. Try a local BIN file.');
  const variant = await vscode.window.showQuickPick(variants, {
    title: 'MicroPython: select the variant', placeHolder: 'Match the flash and PSRAM specifications of your exact board',
  });
  if (!variant) return;
  const versions = releases.filter(release => release.variantId === variant.id).map((release, index) => ({
    label: `v${release.version}`, description: `${index === 0 ? 'Latest stable · ' : ''}${release.date}`,
    detail: release.filename, release,
  }));
  const version = await vscode.window.showQuickPick(versions, { title: 'MicroPython: select the version' });
  if (!version) return;
  requireTrust();
  output.show(true);
  output.appendLine(`\n[firmware] Downloading MicroPython v${version.release.version} · ${board.label} · ${variant.label}\n[firmware] ${version.release.url}`);
  const downloaded = await cancellableProgress('MicroPal: Download MicroPython firmware', (progress, signal) => {
    let lastPercent = 0;
    return service.download(version.release, signal, ({ receivedBytes, totalBytes }) => {
      const percent = totalBytes ? receivedBytes / totalBytes * 100 : 0;
      progress.report({ message: `${(receivedBytes / 1024).toFixed(0)} KiB${totalBytes ? ` / ${(totalBytes / 1024).toFixed(0)} KiB` : ''}`, increment: Math.max(0, percent - lastPercent) });
      lastPercent = percent;
    });
  });
  output.appendLine(`[firmware] Downloaded ${downloaded.bytes} bytes · SHA-256 (local): ${downloaded.sha256}`);
  return { firmwarePath: downloaded.firmwarePath, offset: version.release.offset,
    description: `MicroPython v${version.release.version} · ${variant.label}\nSource: ${version.release.url}` };
}

function requireTrust(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using device tools.');
}

async function cancellableProgress<T>(
  title: string, action: (progress: vscode.Progress<{ message?: string; increment?: number }>, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      controller.signal.throwIfAborted();
      const result = await action(progress, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally { subscription.dispose(); }
  });
}
