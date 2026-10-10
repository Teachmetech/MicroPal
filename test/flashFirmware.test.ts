import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceManager } from '../src/core/deviceManager';
import type { DevicePort } from '../src/core/types';
import type { EsptoolFlasher } from '../src/transport/esptool';

const ui = vi.hoisted(() => ({
  showQuickPick: vi.fn(), showOpenDialog: vi.fn(), showInputBox: vi.fn(),
  showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), withProgress: vi.fn(),
}));
vi.mock('vscode', () => ({ window: ui, ProgressLocation: { Notification: 15 } }));

const board: DevicePort = { path: '/dev/cu.usbmodem1', description: 'Test board', likelyEsp32: true };

async function fixture() {
  const { createFirmwareFlashCommand } = await import('../src/ui/flashFirmware');
  const flash = vi.fn().mockResolvedValue(undefined);
  const flashFirmware = vi.fn(async (_port: DevicePort, action: (signal: AbortSignal) => Promise<void>) => action(new AbortController().signal));
  const output = { show: vi.fn(), appendLine: vi.fn() };
  const selectPort = vi.fn().mockResolvedValue(board);
  const command = createFirmwareFlashCommand(
    { flashFirmware } as unknown as DeviceManager,
    { flash } as unknown as EsptoolFlasher,
    output, selectPort,
  );
  return { command, flash, flashFirmware, selectPort };
}

beforeEach(() => {
  vi.resetAllMocks();
  ui.showQuickPick.mockResolvedValueOnce({ label: 'ESP32-S3', chip: 'esp32s3', offset: '0x0' })
    .mockResolvedValueOnce({ label: 'Write firmware only', eraseAll: false });
  ui.showOpenDialog.mockResolvedValue([{ scheme: 'file', fsPath: '/tmp/firmware with spaces.bin' }]);
  ui.showInputBox.mockResolvedValue('0x0');
  ui.showWarningMessage.mockResolvedValue('Flash Firmware');
  ui.withProgress.mockImplementation(async (_options, action) => action({}, {
    isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
  }));
});

describe('firmware flashing workflow', () => {
  it('never acquires the serial port when final confirmation is dismissed', async () => {
    ui.showWarningMessage.mockResolvedValue(undefined);
    const { command, flashFirmware, flash } = await fixture();
    await command();
    expect(flashFirmware).not.toHaveBeenCalled();
    expect(flash).not.toHaveBeenCalled();
  });

  it('confirms the target and passes the chosen image, chip, offset, and erase mode', async () => {
    const { command, flash } = await fixture();
    await command();
    expect(ui.showWarningMessage.mock.calls[0]?.join(' ')).toContain('/dev/cu.usbmodem1');
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toContain('/tmp/firmware with spaces.bin');
    expect(flash).toHaveBeenCalledWith({ chip: 'esp32s3', port: '/dev/cu.usbmodem1', firmwarePath: '/tmp/firmware with spaces.bin', offset: '0x0', eraseAll: false }, expect.any(AbortSignal));
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/Connect/));
  });

  it('cancels the flashing process through the progress notification', async () => {
    let cancel: (() => void) | undefined;
    ui.withProgress.mockImplementation(async (_options, action) => action({}, {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() {} }; },
    }));
    const { command, flash } = await fixture();
    flash.mockImplementation(async (_options, signal: AbortSignal) => {
      cancel?.();
      expect(signal.aborted).toBe(true);
      const error = new Error('Cancelled'); error.name = 'AbortError'; throw error;
    });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
  });

  it('stops the workflow when no port is selected', async () => {
    const { command, selectPort, flashFirmware } = await fixture();
    selectPort.mockResolvedValue(undefined);
    await command();
    expect(ui.showOpenDialog).not.toHaveBeenCalled();
    expect(flashFirmware).not.toHaveBeenCalled();
  });
});
