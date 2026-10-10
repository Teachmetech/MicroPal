import { describe, expect, it } from 'vitest';
import { resolveToolPath } from '../src/tools/toolPaths';

const managed = { pythonPath: '/private/tools/bin/python', mpremotePath: '/private/tools/bin/mpremote', esptoolPath: '/private/tools/bin/esptool' };

describe('tool path resolution', () => {
  it('uses the managed executable when no custom path is configured', () => {
    expect(resolveToolPath('mpremote', '', managed)).toBe('/private/tools/bin/mpremote');
    expect(resolveToolPath('esptool', '', managed)).toBe('/private/tools/bin/esptool');
  });

  it('keeps explicit external executables ahead of the managed installation', () => {
    expect(resolveToolPath('esptool', '/custom tools/esptool', managed)).toBe('/custom tools/esptool');
    expect(resolveToolPath('mpremote', 'mpremote', undefined)).toBe('mpremote');
  });

  it('requires setup instead of silently using a tool from PATH', () => {
    expect(() => resolveToolPath('esptool', '', undefined)).toThrow(/Set Up Tools/);
    expect(() => resolveToolPath('mpremote', '   ', undefined)).toThrow(/Set Up Tools/);
  });
});
