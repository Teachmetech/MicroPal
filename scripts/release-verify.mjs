import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { validateReleaseArtifact } from './release-utils.mjs';

const [directory, tag, sourceCommit] = process.argv.slice(2);
if (!directory || !/^v\d+\.\d+\.\d+$/.test(tag || '') || !/^[a-f0-9]{40,64}$/.test(sourceCommit || '')) {
  throw new Error('Usage: EXTENSION_PUBLISHER=registered-publisher node scripts/release-verify.mjs DIRECTORY TAG SOURCE_COMMIT');
}
const manifest = JSON.parse(await readFile(`${directory}/release-manifest.json`, 'utf8'));
if (manifest.asset !== `micropal-${tag.slice(1)}.vsix`) throw new Error('Unexpected release asset filename.');
const path = `${directory}/${manifest.asset}`;
const extension = JSON.parse(execFileSync('unzip', ['-p', path, 'extension/package.json'], { encoding: 'utf8' }));
validateReleaseArtifact(manifest, await readFile(path), extension, { repository: 'Teachmetech/MicroPal', sourceCommit, tag, publisher: process.env.EXTENSION_PUBLISHER });
console.log(`Verified ${manifest.extensionId} ${manifest.version}, source ${sourceCommit}, SHA-256 ${manifest.sha256}.`);
