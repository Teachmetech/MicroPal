import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedTools } from '../src/tools/managedTools';

const ui = vi.hoisted(() => ({ showInformationMessage: vi.fn(), withProgress: vi.fn() }));
vi.mock('vscode', () => ({ window: ui, ProgressLocation: { Notification: 15 } }));

const paths = { pythonPath: '/tools/bin/python', mpremotePath: '/tools/bin/mpremote', esptoolPath: '/tools/bin/esptool' };

async function fixture() {
  const { createToolSetupCommands } = await import('../src/ui/toolSetup');
  const service = {
    initialize: vi.fn().mockResolvedValue(undefined), busy: false,
    paths: undefined as typeof paths | undefined,
    setup: vi.fn(async () => { service.paths = paths; return paths; }),
  };
  const device = { disconnect: vi.fn().mockResolvedValue(undefined) };
  const output = { show: vi.fn(), appendLine: vi.fn() };
  const settings = { pythonPath: '', mpremotePath: '', esptoolPath: '' };
  const commands = createToolSetupCommands(service as unknown as ManagedTools, device, output, () => settings);
  return { commands, service, device, output, settings };
}

beforeEach(() => {
  vi.resetAllMocks();
  ui.showInformationMessage.mockResolvedValue('Set Up Tools');
  ui.withProgress.mockImplementation(async (_options, task) => task({ report: vi.fn() }, {
    isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
  }));
});

describe('managed tool setup workflow', () => {
  it('offers setup on first use without installing when the offer is dismissed', async () => {
    const { commands, service, device } = await fixture();
    ui.showInformationMessage.mockResolvedValue(undefined);
    expect(await commands.ensure(['mpremote'])).toBe(false);
    expect(service.setup).not.toHaveBeenCalled();
    expect(device.disconnect).not.toHaveBeenCalled();
  });

  it('waits for serial ownership to end before installing', async () => {
    const { commands, service, device } = await fixture();
    let released = false;
    device.disconnect.mockImplementation(async () => { released = true; });
    service.setup.mockImplementation(async () => {
      expect(released).toBe(true);
      service.paths = paths; return paths;
    });
    expect(await commands.ensure(['mpremote', 'esptool'])).toBe(true);
    expect(service.setup).toHaveBeenCalledWith(expect.objectContaining({ repair: false, signal: expect.any(AbortSignal) }));
  });

  it('uses custom executable overrides without requiring managed setup', async () => {
    const { commands, service, settings } = await fixture();
    settings.esptoolPath = '/external/esptool';
    expect(await commands.ensure(['esptool'])).toBe(true);
    expect(service.setup).not.toHaveBeenCalled();
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not let a broken managed environment prevent use of explicit external tools', async () => {
    const { commands, service, settings } = await fixture();
    settings.mpremotePath = '/external/mpremote';
    service.initialize.mockRejectedValue(new Error('Broken managed environment'));
    expect(await commands.ensure(['mpremote'])).toBe(true);
  });

  it('does not reinstall an already ready environment for normal setup', async () => {
    const { commands, service, device } = await fixture();
    service.paths = paths;
    await commands.setup();
    expect(service.setup).not.toHaveBeenCalled();
    expect(device.disconnect).not.toHaveBeenCalled();
  });

  it('forces a replacement environment for repair and retains the configured Python choice', async () => {
    const { commands, service, settings } = await fixture();
    service.paths = paths; settings.pythonPath = '/my python/python3';
    await commands.repair();
    expect(service.setup).toHaveBeenCalledWith(expect.objectContaining({ repair: true, pythonPath: '/my python/python3' }));
  });

  it('leaves a blank Python setting undefined so setup auto-detects the interpreter', async () => {
    const { commands, service } = await fixture();
    await commands.setup();
    expect(service.setup).toHaveBeenCalledWith(expect.objectContaining({ pythonPath: undefined }));
  });

  it('passes cancellation to the installer and reports no success after cancellation', async () => {
    let cancel: (() => void) | undefined;
    ui.withProgress.mockImplementation(async (_options, task) => task({ report: vi.fn() }, {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() {} }; },
    }));
    const { commands, service } = await fixture();
    service.setup.mockImplementation(async (options?: { signal?: AbortSignal }) => {
      cancel?.(); expect(options?.signal?.aborted).toBe(true);
      const error = new Error('Cancelled'); error.name = 'AbortError'; throw error;
    });
    await expect(commands.setup()).rejects.toMatchObject({ name: 'AbortError' });
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
    expect(commands.busy).toBe(false);
  });

  it('blocks device work while setup is waiting for a serial owner to close', async () => {
    const { commands, device } = await fixture();
    let release!: () => void;
    device.disconnect.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const settingUp = commands.setup();
    await vi.waitFor(() => expect(commands.busy).toBe(true));
    await expect(commands.ensure(['mpremote'])).rejects.toThrow(/setup|install/i);
    await expect(commands.repair()).rejects.toThrow(/setup|install/i);
    release(); await settingUp;
    expect(commands.busy).toBe(false);
  });
});
