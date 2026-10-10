import type { ManagedToolPaths } from './managedTools';

export type ToolName = 'mpremote' | 'esptool';

export function resolveToolPath(tool: ToolName, override: string, managed?: ManagedToolPaths): string {
  const custom = override.trim();
  if (custom) return custom;
  const executable = managed?.[`${tool}Path`];
  if (executable) return executable;
  throw new Error(`MicroPal ${tool} is not ready. Run MicroPal: Set Up Tools or configure a custom ${tool}Path.`);
}
