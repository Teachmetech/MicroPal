import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProcessRunner } from '../core/types';

export type FirmwareChip = 'esp32' | 'esp32s3';
export interface FirmwareFlashOptions {
  chip: FirmwareChip;
  port: string;
  firmwarePath: string;
  offset: string;
  eraseAll: boolean;
}

export const FIRMWARE_PROFILES = {
  esp32: { label: 'ESP32', offset: '0x1000' },
  esp32s3: { label: 'ESP32-S3', offset: '0x0' }
} as const;

export class EsptoolFlasher {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly executable: () => string,
    private readonly output: (text: string) => void
  ) {}

  async flash(options: FirmwareFlashOptions, signal?: AbortSignal): Promise<void> {
    const executable = this.executable();
    const { chip, port, firmwarePath, offset, eraseAll } = options;
    if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) {
      throw new Error('Set the esptool executable to a nonempty path without NUL bytes.');
    }
    if (chip !== 'esp32' && chip !== 'esp32s3') {
      throw new Error('Choose a supported firmware chip: ESP32 or ESP32-S3.');
    }
    if (typeof port !== 'string' || /[\0\r\n]/.test(port) || !/^(?:\/dev\/\S+|COM[0-9]+)$/i.test(port)) {
      throw new Error('Choose a local serial port under /dev/ or a COM port number.');
    }
    if (typeof offset !== 'string' || offset.trim() !== offset || !/^0x[0-9a-f]+$/i.test(offset)) {
      throw new Error('Firmware offset must be a hexadecimal address such as 0x1000.');
    }
    const address = Number(offset);
    if (!Number.isInteger(address) || address > 0xffffffff || address % 0x1000 !== 0) {
      throw new Error('Firmware offset must be an unsigned 32-bit address aligned to 0x1000 bytes.');
    }
    if (typeof firmwarePath !== 'string' || firmwarePath.includes('\0') || !path.isAbsolute(firmwarePath) || path.extname(firmwarePath).toLowerCase() !== '.bin') {
      throw new Error('Choose an absolute firmware path to a .bin file.');
    }
    try {
      const file = await stat(firmwarePath);
      if (!file.isFile() || file.size === 0) throw new Error('Not a nonempty regular file.');
      await access(firmwarePath, constants.R_OK);
    } catch (error) {
      throw new Error('Firmware must be a readable, nonempty regular .bin file.', { cause: error });
    }

    // esptool v5 options for write-flash belong after the subcommand.
    const args = ['--chip', chip, '--port', port, '--baud', '460800', 'write-flash'];
    if (eraseAll === true) args.push('--erase-all');
    args.push(offset, firmwarePath);
    await this.runner.run({ executable, args }, { signal, timeoutMs: 600_000, onOutput: this.output });
  }
}
