import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { readVSIXPackage, readZip } = require('@vscode/vsce/out/zip');
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'micropal local package '));
  directories.push(directory);
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'dist'));
  await copyFile(resolve('scripts/package.mjs'), join(directory, 'scripts/package.mjs'));
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.stringify({ name: 'micropal', publisher: 'teachmetech', version: '1.2.3',
    description: 'Local packaging fixture', engines: { vscode: '^1.95.0' }, main: './dist/extension.js',
    activationEvents: ['onStartupFinished'],
    repository: { type: 'git', url: 'https://github.com/Teachmetech/MicroPal.git' }, license: 'MIT',
    scripts: { 'vscode:prepublish': 'node build.mjs' } });
  const lock = JSON.stringify({ name: 'micropal', version: '1.2.3', lockfileVersion: 3 });
  await writeFile(join(directory, 'package.json'), manifest);
  await writeFile(join(directory, 'package-lock.json'), lock);
  await writeFile(join(directory, 'README.md'), '# MicroPal packaging fixture\n');
  await copyFile(resolve('LICENSE'), join(directory, 'LICENSE'));
  await writeFile(join(directory, '.vscodeignore'), '**\n!package.json\n!README.md\n!LICENSE\n!dist/extension.js\n');
  await writeFile(join(directory, 'dist/extension.js'), 'stale bundle');
  await writeFile(join(directory, 'build.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync("dist/extension.js", "fresh bundle");');
  const run = (...args) => execFileSync(process.execPath, [join(directory, 'scripts/package.mjs'), ...args],
    { cwd: directory, encoding: 'utf8', timeout: 30000 });
  return { directory, manifest, lock, run };
}

describe('VSIX packaging', () => {
  it('creates distinct local versions without modifying source versions or overwriting earlier test packages', async () => {
    const { directory, manifest, lock, run } = await fixture();
    run('--local');
    const [first] = (await readdir(directory)).filter(name => name.endsWith('.vsix'));
    expect(first).toMatch(/^micropal-1\.2\.4-local\..+\.vsix$/);
    const original = await readFile(join(directory, first));
    const packaged = await readVSIXPackage(join(directory, first));
    expect(packaged.manifest.version).toBe(first.slice('micropal-'.length, -'.vsix'.length));
    expect(packaged.manifest.publisher).toBe('teachmetech');
    const entries = await readZip(join(directory, first), () => true);
    expect(entries.get('extension/dist/extension.js').toString()).toBe('fresh bundle');
    expect([...entries.keys()]).not.toContain('extension/package-lock.json');
    run('--local');
    const packages = (await readdir(directory)).filter(name => name.endsWith('.vsix'));
    expect(packages).toHaveLength(2);
    expect(await readFile(join(directory, first))).toEqual(original);
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(directory, 'package-lock.json'), 'utf8')).toBe(lock);
  }, 30000);

  it('keeps normal packaging on the exact manifest version', async () => {
    const { directory, manifest, run } = await fixture();
    run();
    const packages = (await readdir(directory)).filter(name => name.endsWith('.vsix'));
    expect(packages).toEqual(['micropal-1.2.3.vsix']);
    expect((await readVSIXPackage(join(directory, packages[0]))).manifest.version).toBe('1.2.3');
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(manifest);
  }, 30000);
});
