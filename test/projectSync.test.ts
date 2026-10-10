import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSync, remotePathForFile } from '../src/core/projectSync';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'esp32-sync-')); roots.push(root); return root; }
describe('sync planning', () => {
  it('selects nested files, excludes globs, and computes bytes', async () => {
    const root = await fixture();
    await mkdir(join(root, 'lib')); await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'main.py'), '123');
    await writeFile(join(root, 'lib', 'driver.py'), '4567');
    await writeFile(join(root, '.env'), 'secret');
    await writeFile(join(root, 'node_modules', 'x.py'), 'skip');
    const plan = await planSync(root, ['**/.env', '**/node_modules/**']);
    expect(plan.files.map(x => x.remotePath)).toEqual(['/lib/driver.py', '/main.py']);
    expect(plan.totalBytes).toBe(7);
  });
  it('never follows directory symlinks outside the project', async () => {
    const root = await fixture(); const outside = await fixture();
    await writeFile(join(outside, 'secret.py'), 'secret');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await planSync(root, [])).files).toEqual([]);
  });
  it('rejects files outside the selected project', () => {
    expect(() => remotePathForFile('/project', '/elsewhere/main.py')).toThrow(/outside/);
  });
  it('preserves hierarchy rather than flattening duplicate names', () => {
    expect(remotePathForFile('/project', '/project/lib/main.py')).toBe('/lib/main.py');
  });
});
