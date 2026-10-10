import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertConventionalTitle, assertPublisher, renderReleaseChangelog, unreleasedSection } from './release-utils.mjs';

// semantic-release regenerates notes after the git plugin creates its commit.
// At that point Unreleased has been promoted, so retain its original contents.
const humanNotes = new Map();

export async function verifyConditions(_config, context) {
  const extension = JSON.parse(await readFile(join(context.cwd, 'package.json'), 'utf8'));
  assertPublisher(extension, context.env.EXTENSION_PUBLISHER);
}

export async function verifyRelease(_config, context) {
  if (!context.lastRelease.version) throw new Error('Missing release baseline: tag the existing local release v0.2.1 before the first public release.');
  for (const commit of context.commits) assertConventionalTitle(commit.message.split('\n')[0]);
  const changelog = await readFile(join(context.cwd, 'CHANGELOG.md'), 'utf8');
  if (!/^- \S/m.test(unreleasedSection(changelog))) throw new Error('A release requires human changelog notes under Unreleased.');
}

export async function generateNotes(_config, context) {
  const key = `${context.cwd}:${context.nextRelease.gitTag}`;
  const current = unreleasedSection(await readFile(join(context.cwd, 'CHANGELOG.md'), 'utf8'));
  if (current) humanNotes.set(key, current);
  const human = current || humanNotes.get(key);
  return human ? `### Maintainer notes\n\n${human}` : '';
}

export async function prepare(_config, context) {
  const cwd = context.cwd;
  const extension = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  if (extension.version !== context.nextRelease.version) throw new Error('The extension version was not prepared before packaging.');
  const source = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
  await writeFile(join(cwd, 'CHANGELOG.md'), renderReleaseChangelog(source, extension.version, context.nextRelease.notes));
  await mkdir(join(cwd, '.release'), { recursive: true });
  const asset = `micropal-${extension.version}.vsix`;
  execFileSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '--out', `.release/${asset}`], { cwd, stdio: 'inherit', env: context.env });
  const sha256 = createHash('sha256').update(await readFile(join(cwd, '.release', asset))).digest('hex');
  const manifest = {
    schemaVersion: 1,
    repository: 'Teachmetech/MicroPal',
    sourceCommit: context.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    version: extension.version,
    tag: context.nextRelease.gitTag,
    extensionId: `${extension.publisher}.${extension.name}`,
    asset,
    sha256,
  };
  await writeFile(join(cwd, '.release/release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(cwd, '.release/CHECKSUMS.sha256'), `${sha256}  ${asset}\n`);
  await writeFile(join(cwd, '.release/CHANGELOG.md'), await readFile(join(cwd, 'CHANGELOG.md')));
  await writeFile(join(cwd, '.release/release-notes.md'), context.nextRelease.notes);
}
