export interface DevicePort {
  path: string;
  serialNumber?: string;
  description: string;
  vendorId?: string;
  productId?: string;
  likelyEsp32: boolean;
}
export interface DeviceSettings {
  mpremotePath: string;
  preferredPort: string;
  baudRate: number;
  autoReconnect: boolean;
  autoShowOutput?: boolean;
  syncExclusions: string[];
}
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'running' | 'repl' | 'flashing' | 'reconnecting' | 'error';
export interface ConnectionState {
  phase: ConnectionPhase;
  port?: DevicePort;
  message?: string;
}
export interface DeviceFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}
export interface DeviceFileStat {
  isDirectory: boolean;
  size: number;
  mtime: number;
}
export interface DeviceWriteOptions { create: boolean; overwrite: boolean; }
export interface CommandSpec { executable: string; args: string[]; }
export interface CommandResult { stdout: string; stderr: string; }
export interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}
export interface ProcessRunner {
  run(spec: CommandSpec, options?: ProcessOptions): Promise<CommandResult>;
}
export interface InteractiveSession {
  closed: Promise<void>;
  close(): Promise<void>;
  show(): void;
}
export type ReplLauncher = (spec: CommandSpec) => Promise<InteractiveSession>;
export interface DeviceTransport {
  discover(signal?: AbortSignal): Promise<DevicePort[]>;
  probe(port: DevicePort, signal?: AbortSignal): Promise<void>;
  runFile(port: DevicePort, localPath: string, signal?: AbortSignal): Promise<void>;
  uploadFile(port: DevicePort, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>;
  stop(port: DevicePort, signal?: AbortSignal): Promise<void>;
  softReset(port: DevicePort, signal?: AbortSignal): Promise<void>;
  listFiles(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<DeviceFile[]>;
  readFile(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<string>;
  statFile(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<DeviceFileStat>;
  readFileBytes(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFileBytes(port: DevicePort, remotePath: string, content: Uint8Array, options: DeviceWriteOptions, signal?: AbortSignal): Promise<void>;
  createDirectory(port: DevicePort, remotePath: string, signal?: AbortSignal): Promise<void>;
  deleteFile(port: DevicePort, remotePath: string, options: { recursive: boolean }, signal?: AbortSignal): Promise<void>;
  renameFile(port: DevicePort, oldPath: string, newPath: string, options: { overwrite: boolean }, signal?: AbortSignal): Promise<void>;
  downloadFile(port: DevicePort, remotePath: string, localPath: string, signal?: AbortSignal): Promise<void>;
  openRepl(port: DevicePort): Promise<InteractiveSession>;
  /** Resolves after a passive serial reader is ready; rejection must follow confirmed process closure. */
  openConsole?(port: DevicePort, signal?: AbortSignal): Promise<InteractiveSession>;
  canOpenConsole?(): boolean;
}
