import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('A valid semantic version is required for packaging.');
const local = process.argv.includes('--local');
const [major, minor, patch] = manifest.version.split('-')[0].split('.');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const version = local ? `${major}.${minor}.${BigInt(patch) + 1n}-local.${stamp}.b${randomUUID().slice(0, 8)}` : manifest.version;
const vsce = join(dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')), 'vsce');
const child = spawn(process.execPath, [vsce, 'package',
  ...(local ? [version, '--no-update-package-json', '--no-git-tag-version'] : []),
  '--no-dependencies', '--out', `micropal-${version}.vsix`], {
  stdio: 'inherit', shell: false,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
