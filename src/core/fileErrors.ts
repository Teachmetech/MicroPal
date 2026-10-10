export type DeviceFileSystemErrorCode = 'FileNotFound' | 'FileExists' | 'FileNotADirectory' |
  'FileIsADirectory' | 'NoPermissions' | 'Unavailable';

/** Filesystem failures sent explicitly by the board, separate from serial/process failures. */
export class DeviceFileSystemError extends Error {
  constructor(readonly code: DeviceFileSystemErrorCode, message: string) {
    super(message);
    this.name = 'DeviceFileSystemError';
  }
}
