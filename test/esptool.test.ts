import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandSpec, ProcessOptions, ProcessRunner } from '../src/core/types';
import { EsptoolFlasher, FIRMWARE_PROFILES, type FirmwareChip, type FirmwareFlashOptions } from '../src/transport/esptool';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class RecordingRunner implements ProcessRunner {
  calls: { spec: CommandSpec; options?: ProcessOptions }[] = [];
  error?: Error;
  async run(spec: CommandSpec, options?: ProcessOptions): Promise<CommandResult> {
    this.calls.push({ spec, options });
    if (this.error) throw this.error;
    return { stdout: '', stderr: '' };
  }
}

function setup(executable = '/tools with spaces/esptool') {
  const root = mkdtempSync(path.join(tmpdir(), 'micropal-firmware-'));
  tempDirs.push(root);
  const firmwarePath = path.join(root, 'firmware.bin');
  writeFileSync(firmwarePath, Buffer.from([0xe9, 0x01, 0x02, 0x03]));
  const options: FirmwareFlashOptions = { chip: 'esp32', port: '/dev/cu.usbmodem123', firmwarePath, offset: '0x1000', eraseAll: false };
  const runner = new RecordingRunner();
  const output: string[] = [];
  const flasher = new EsptoolFlasher(runner, () => executable, text => output.push(text));
  return { root, options, runner, flasher, output };
}

describe('esptool flashing', () => {
  it.each([
    { chip: 'esp32' as const, offset: '0x1000' },
    { chip: 'esp32s3' as const, offset: '0x0' }
  ])('uses the $chip firmware profile offset without erasing all flash', async ({ chip, offset }) => {
    const { options, runner, flasher } = setup();
    await flasher.flash({ ...options, chip, offset: FIRMWARE_PROFILES[chip].offset });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.spec).toEqual({
      executable: '/tools with spaces/esptool',
      args: ['--chip', chip, '--port', '/dev/cu.usbmodem123', '--baud', '460800', 'write-flash', offset, options.firmwarePath]
    });
  });

  it('erases all flash only when explicitly selected, retaining esptool protection checks', async () => {
    const { options, runner, flasher } = setup();
    await flasher.flash({ ...options, eraseAll: true });
    expect(runner.calls[0]?.spec.args).toEqual([
      '--chip', 'esp32', '--port', options.port, '--baud', '460800', 'write-flash', '--erase-all', '0x1000', options.firmwarePath
    ]);
  });

  it('passes paths with spaces and shell metacharacters as literal process arguments', async () => {
    const executable = process.platform === 'win32' ? 'C:\\tools with spaces\\esptool.exe' : "/tools with spaces/esptool'$(touch nope)";
    const { root, options, runner, flasher } = setup(executable);
    const firmwarePath = path.join(root, process.platform === 'win32' ? "firmware ' $(touch nope).bin" : "firmware '\";$(touch nope).bin");
    writeFileSync(firmwarePath, Buffer.from([0xe9]));
    await flasher.flash({ ...options, firmwarePath });
    expect(runner.calls[0]?.spec.executable).toBe(executable);
    expect(runner.calls[0]?.spec.args.at(-1)).toBe(firmwarePath);
    expect(runner.calls[0]?.spec.args).toHaveLength(9);
  });

  it('forwards streaming output, cancellation, and a ten-minute deadline', async () => {
    const { options, runner, flasher, output } = setup();
    const abort = new AbortController();
    await flasher.flash(options, abort.signal);
    const processOptions = runner.calls[0]?.options;
    expect(processOptions?.signal).toBe(abort.signal);
    expect(processOptions?.timeoutMs).toBe(600_000);
    processOptions?.onOutput?.('Writing at 0x00001000...\n');
    expect(output).toEqual(['Writing at 0x00001000...\n']);
  });

  it('propagates process failure unchanged', async () => {
    const { options, runner, flasher } = setup();
    runner.error = new Error('Failed to connect to ESP32');
    await expect(flasher.flash(options)).rejects.toBe(runner.error);
  });

  it.each(['COM1', 'COM123', 'com3', 'Com12', '/dev/ttyUSB0', '/dev/serial/by-id/usb-Espressif_123'])('accepts explicit local serial port %s', async port => {
    const { options, runner, flasher } = setup();
    await flasher.flash({ ...options, port });
    expect(runner.calls[0]?.spec.args.slice(2, 4)).toEqual(['--port', port]);
  });

  it('accepts an aligned hexadecimal offset at the unsigned 32-bit boundary', async () => {
    const { options, runner, flasher } = setup();
    await flasher.flash({ ...options, offset: '0xFFFFF000' });
    expect(runner.calls[0]?.spec.args.at(-2)).toBe('0xFFFFF000');
  });
});

describe('firmware validation before starting esptool', () => {
  it.each(['', '   ', 'bad\0path'])('rejects invalid executable %j without launching', async executable => {
    const { options, runner, flasher } = setup(executable);
    await expect(flasher.flash(options)).rejects.toThrow(/esptool|executable/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['auto', 'esp32c3', '--help', 'toString'])('rejects unsupported chip %s without launching', async chip => {
    const { options, runner, flasher } = setup();
    await expect(flasher.flash({ ...options, chip: chip as FirmwareChip })).rejects.toThrow(/chip/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['', '--help', 'auto', 'COM', 'COM1\n', '/dev/', '/dev/cu.usbmodem\0', '/dev/ttyUSB0\n', '/dev/tty USB0', '/dev/ttyUSB0\t', 'socket://localhost:1234', 'rfc2217://host:1234', 'ttyUSB0'])('rejects invalid or non-local serial port %j without launching', async port => {
    const { options, runner, flasher } = setup();
    await expect(flasher.flash({ ...options, port })).rejects.toThrow(/port/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['', '4096', '-0x1000', '0x-1000', '0x1001', '0xFFFFFFFF', '0x100000000', '0x1000 --force', '0x1000\n', '0x', '0xGGGG'])('rejects invalid or unaligned hexadecimal offset %j without launching', async offset => {
    const { options, runner, flasher } = setup();
    await expect(flasher.flash({ ...options, offset })).rejects.toThrow(/offset|aligned|hexadecimal/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['', 'firmware.bin', '--help.bin', '/tmp/firmware\0.bin'])('rejects invalid firmware path %j without launching', async firmwarePath => {
    const { options, runner, flasher } = setup();
    await expect(flasher.flash({ ...options, firmwarePath })).rejects.toThrow(/firmware|absolute|path/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['missing', 'directory', 'empty', 'extension'])('rejects %s firmware without launching', async kind => {
    const { root, options, runner, flasher } = setup();
    const firmwarePath = path.join(root, kind === 'extension' ? 'firmware.txt' : `${kind}.bin`);
    if (kind === 'directory') mkdirSync(firmwarePath);
    if (kind === 'empty') writeFileSync(firmwarePath, Buffer.alloc(0));
    if (kind === 'extension') writeFileSync(firmwarePath, Buffer.from([0xe9]));
    await expect(flasher.flash({ ...options, firmwarePath })).rejects.toThrow(/firmware|file|\.bin/i);
    expect(runner.calls).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects an unreadable firmware file without launching', async () => {
    const { options, runner, flasher } = setup();
    chmodSync(options.firmwarePath, 0o000);
    try {
      await expect(flasher.flash(options)).rejects.toThrow(/firmware|readable|permission/i);
      expect(runner.calls).toHaveLength(0);
    } finally {
      chmodSync(options.firmwarePath, 0o600);
    }
  });
});
