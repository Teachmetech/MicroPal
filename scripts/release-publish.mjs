import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { publishingEnvironment, validateReleaseArtifact } from './release-utils.mjs';

const store = process.argv[2];
if (!['vscode', 'openvsx'].includes(store)) throw new Error('Select vscode or openvsx.');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/production') {
  throw new Error('Store publication must run from a production push in GitHub Actions.');
}
const tag = process.env.RELEASE_TAG;
if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('A stable GitHub release tag is required.');
if (!process.env.EXTENSION_PUBLISHER) throw new Error('Set the EXTENSION_PUBLISHER repository variable to the registered publisher.');
const azure = process.env.VSCODE_AUTH_MODE === 'azure';
const trusted = process.env.OVSX_TRUSTED_PUBLISHING === 'true';
if (store === 'vscode' && !azure && !process.env.VSCE_PAT) {
  throw new Error('VS Code Marketplace publication needs configured Azure workload identity or the VSCE_PAT secret. GitHub release assets remain available.');
}
if (store === 'openvsx' && !trusted && !process.env.OVSX_PAT) {
  throw new Error('Open VSX publication needs OVSX_PAT for the first release, or trusted publishing after namespace verification and an active version. GitHub release assets remain available.');
}
const destination = `.release/publish-${store}`;
await mkdir(destination, { recursive: true });
const download = pattern => execFileSync('gh', ['release', 'download', tag, '--repo', 'Teachmetech/MicroPal', '--dir', destination, '--pattern', pattern], { stdio: 'inherit' });
download('release-manifest.json');
const manifest = JSON.parse(await readFile(`${destination}/release-manifest.json`, 'utf8'));
if (manifest.asset !== `micropal-${tag.slice(1)}.vsix`) throw new Error('Unexpected release asset filename.');
download(manifest.asset);
const path = `${destination}/${manifest.asset}`;
const extension = JSON.parse(execFileSync('unzip', ['-p', path, 'extension/package.json'], { encoding: 'utf8' }));
validateReleaseArtifact(manifest, await readFile(path), extension, {
  repository: 'Teachmetech/MicroPal', sourceCommit: process.env.GITHUB_SHA,
  tag, publisher: process.env.EXTENSION_PUBLISHER,
});
if (store === 'vscode') {
  execFileSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'publish', '--packagePath', path, ...(azure ? ['--azure-credential'] : [])], { stdio: 'inherit', env: publishingEnvironment(process.env, { azure }) });
} else {
  execFileSync(process.execPath, ['node_modules/ovsx/bin/ovsx', 'publish', path, ...(trusted ? ['--trusted-publishing'] : [])], { stdio: 'inherit', env: publishingEnvironment(process.env, { trusted }) });
}
console.log(`Published ${manifest.extensionId} ${manifest.version} to ${store}.`);
