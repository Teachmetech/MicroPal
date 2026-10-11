import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceManager } from '../src/core/deviceManager';
import type { DevicePort } from '../src/core/types';
import type { EsptoolFlasher } from '../src/transport/esptool';
import type { MicroPythonFirmwareService } from '../src/firmware/microPythonFirmware';

const ui = vi.hoisted(() => ({
  showQuickPick: vi.fn(), showOpenDialog: vi.fn(), showInputBox: vi.fn(),
  showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), withProgress: vi.fn(),
}));
const workspace = vi.hoisted(() => ({ isTrusted: true }));
vi.mock('vscode', () => ({ window: ui, workspace, ProgressLocation: { Notification: 15 } }));
const board: DevicePort = { path: '/dev/cu.usbmodem1', description: 'Test board', likelyEsp32: true };
const releases = [
  { boardId: 'ESP32_GENERIC_S3', variantId: '', version: '1.29.0', date: '2026-08-24', filename: 'ESP32_GENERIC_S3-20260824-v1.29.0.bin',
    url: 'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin', chip: 'esp32s3', offset: '0x0' },
  { boardId: 'ESP32_GENERIC_S3', variantId: '', version: '1.28.0', date: '2026-04-01', filename: 'ESP32_GENERIC_S3-20260401-v1.28.0.bin',
    url: 'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260401-v1.28.0.bin', chip: 'esp32s3', offset: '0x0' },
];
async function fixture() {
  const { createFirmwareFlashCommand } = await import('../src/ui/flashFirmware');
  const flash = vi.fn().mockResolvedValue(undefined);
  const flashFirmware = vi.fn(async (_port: DevicePort, action: (signal: AbortSignal) => Promise<void>) => action(new AbortController().signal));
  const output = { show: vi.fn(), appendLine: vi.fn() };
  const selectPort = vi.fn().mockResolvedValue(board);
  const firmware = {
    getReleases: vi.fn().mockResolvedValue(releases),
    download: vi.fn().mockImplementation(async release => ({ firmwarePath: '/tmp/downloaded.bin', release, sha256: 'a'.repeat(64), bytes: 1024 })),
  };
  const command = createFirmwareFlashCommand(
    { flashFirmware } as unknown as DeviceManager, { flash } as unknown as EsptoolFlasher,
    output, selectPort, firmware as unknown as MicroPythonFirmwareService,
  );
  return { command, flash, flashFirmware, selectPort, firmware, output };
}
function pickSource(source: 'local' | 'official') {
  ui.showQuickPick.mockImplementation(async (items, options) => {
    if (options.title === 'Firmware: select the chip') return items.find((item: { chip?: string }) => item.chip === 'esp32s3');
    if (options.title === 'Firmware: select the source') return items.find((item: { source?: string }) => item.source === source);
    return items[0];
  });
}
beforeEach(() => {
  vi.resetAllMocks(); workspace.isTrusted = true; pickSource('local');
  ui.showOpenDialog.mockResolvedValue([{ scheme: 'file', fsPath: '/tmp/firmware with spaces.bin' }]);
  ui.showInputBox.mockResolvedValue('0x0'); ui.showWarningMessage.mockResolvedValue('Flash Firmware');
  ui.withProgress.mockImplementation(async (_options, action) => action({ report: vi.fn() }, {
    isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
  }));
});
describe('firmware flashing workflow', () => {
  it('never acquires the serial port when final confirmation is dismissed', async () => {
    ui.showWarningMessage.mockResolvedValue(undefined); const { command, flashFirmware, flash } = await fixture();
    await command(); expect(flashFirmware).not.toHaveBeenCalled(); expect(flash).not.toHaveBeenCalled();
  });
  it('preserves local BIN selection, offset override and explicit erase confirmation', async () => {
    const { command, flash, firmware } = await fixture(); await command();
    expect(ui.showWarningMessage.mock.calls[0]?.join(' ')).toContain(board.path);
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toContain('/tmp/firmware with spaces.bin');
    expect(flash).toHaveBeenCalledWith({ chip: 'esp32s3', port: board.path, firmwarePath: '/tmp/firmware with spaces.bin', offset: '0x0', eraseAll: false }, expect.any(AbortSignal));
    expect(firmware.getReleases).not.toHaveBeenCalled(); expect(firmware.download).not.toHaveBeenCalled();
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/Connect/));
  });
  it('offers official MicroPython first and downloads without a file/address dialog', async () => {
    pickSource('official'); const { command, flash, firmware, output } = await fixture(); await command();
    const sources = ui.showQuickPick.mock.calls.find(call => call[1].title === 'Firmware: select the source')?.[0];
    expect(sources[0].source).toBe('official');
    expect(firmware.getReleases).toHaveBeenCalledWith('ESP32_GENERIC_S3', expect.any(AbortSignal));
    expect(firmware.download).toHaveBeenCalledWith(releases[0], expect.any(AbortSignal), expect.any(Function));
    expect(ui.showOpenDialog).not.toHaveBeenCalled(); expect(ui.showInputBox).not.toHaveBeenCalled();
    expect(flash).toHaveBeenCalledWith({ chip: 'esp32s3', port: board.path, firmwarePath: '/tmp/downloaded.bin', offset: '0x0', eraseAll: false }, expect.any(AbortSignal));
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toContain('1.29.0');
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toContain(releases[0]!.url);
    expect(output.appendLine.mock.calls.flat().join('\n')).toContain('a'.repeat(64));
  });
  it('allows an older stable version and full erase and confirms those choices', async () => {
    pickSource('official'); const defaults = ui.showQuickPick.getMockImplementation()!;
    ui.showQuickPick.mockImplementation(async (items, options) => {
      if (options.title === 'MicroPython: select the version') return items[1];
      if (options.title === 'Firmware: choose erase mode') return items[1];
      return defaults(items, options);
    });
    const { command, flash, firmware } = await fixture(); await command();
    expect(firmware.download.mock.calls[0]?.[0]).toEqual(releases[1]); expect(flash.mock.calls[0]?.[0].eraseAll).toBe(true);
    expect(ui.showWarningMessage.mock.calls[0]?.[1].detail).toMatch(/1\.28\.0[\s\S]*Erase entire flash/);
  });
  it('stops before serial acquisition when catalog progress is cancelled', async () => {
    pickSource('official'); ui.withProgress.mockImplementation(async (_options, action) => action({ report: vi.fn() }, {
      isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }),
    }));
    const { command, flashFirmware, firmware } = await fixture();
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(firmware.download).not.toHaveBeenCalled(); expect(flashFirmware).not.toHaveBeenCalled(); expect(ui.showInformationMessage).not.toHaveBeenCalled();
  });
  it('does not continue after cancellation at the end of a download', async () => {
    pickSource('official'); let cancel: (() => void) | undefined;
    ui.withProgress.mockImplementation(async (_options, action) => action({ report: vi.fn() }, {
      isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() {} }; },
    }));
    const { command, flashFirmware, firmware } = await fixture();
    firmware.download.mockImplementation(async release => { cancel?.(); return { firmwarePath: '/tmp/downloaded.bin', release, sha256: 'a'.repeat(64), bytes: 1024 }; });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' });
    expect(flashFirmware).not.toHaveBeenCalled(); expect(ui.showWarningMessage).not.toHaveBeenCalled();
  });
  it('rechecks trust after the final dialog', async () => {
    ui.showWarningMessage.mockImplementation(async () => { workspace.isTrusted = false; return 'Flash Firmware'; });
    const { command, flashFirmware } = await fixture(); await expect(command()).rejects.toThrow(/Trust this workspace/);
    expect(flashFirmware).not.toHaveBeenCalled();
  });
  it('cancels flashing through the progress notification', async () => {
    let cancel: (() => void) | undefined;
    ui.withProgress.mockImplementation(async (_options, action) => action({ report: vi.fn() }, {
      isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() {} }; },
    }));
    const { command, flash } = await fixture(); flash.mockImplementation(async (_options, signal: AbortSignal) => {
      cancel?.(); expect(signal.aborted).toBe(true); const error = new Error('Cancelled'); error.name = 'AbortError'; throw error;
    });
    await expect(command()).rejects.toMatchObject({ name: 'AbortError' }); expect(ui.showInformationMessage).not.toHaveBeenCalled();
  });
  it('stops when no port is selected', async () => {
    const { command, selectPort, flashFirmware } = await fixture(); selectPort.mockResolvedValue(undefined);
    await command(); expect(ui.showQuickPick).not.toHaveBeenCalled(); expect(flashFirmware).not.toHaveBeenCalled();
  });
  it('prevents concurrent wizards', async () => {
    const { command, selectPort } = await fixture(); let finish!: (port: DevicePort | undefined) => void;
    selectPort.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = command(); await expect(command()).rejects.toThrow(/already open/); finish(undefined); await pending;
  });
});
