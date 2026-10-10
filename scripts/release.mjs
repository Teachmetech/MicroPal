import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import semanticRelease from 'semantic-release';
import configuration from '../release.config.mjs';
import { assertConventionalTitle, validateReleaseArtifact } from './release-utils.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sourceCommit = process.env.GITHUB_SHA;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/production' || !/^[a-f0-9]{40,64}$/.test(sourceCommit || '')) {
  throw new Error('Public releases must run from a production push in GitHub Actions.');
}
if (git('rev-parse', 'HEAD') !== sourceCommit) throw new Error('Checkout does not match the workflow source commit.');
await mkdir('.release', { recursive: true });

// A rerun must reuse the original published bytes, including when the release
// commit is the single child of the triggering production commit.
const candidates = git('tag', '--list', 'v*').split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)).filter(tag => {
  const head = git('rev-parse', `${tag}^{commit}`);
  if (head === sourceCommit) return tag !== 'v0.2.1';
  return git('rev-list', '--parents', '-n', '1', head).split(' ').slice(1).join(' ') === sourceCommit && git('show', '-s', '--format=%s', head) === `chore(release): ${tag.slice(1)} [skip ci]`;
});
if (candidates.length > 1) throw new Error('Multiple release tags match this source commit; resolve the ambiguity before retrying.');
let tag = candidates[0];
if (!tag) {
  const previousTag = git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', sourceCommit);
  const subjects = git('log', '--format=%s', `${previousTag}..${sourceCommit}`).split('\n').filter(Boolean);
  for (const subject of subjects) assertConventionalTitle(subject);
  const result = await semanticRelease(configuration);
  tag = result ? result.nextRelease.gitTag : undefined;
}
if (!tag) {
  await appendFile(process.env.GITHUB_OUTPUT, 'released=false\n');
  console.log('No release-producing changes.');
} else {
  // Download into a clean directory, without --clobber. Existing tags/releases
  // are never replaced, and missing or inconsistent assets stop the run.
  const destination = '.release/published';
  await mkdir(destination, { recursive: true });
  execFileSync('gh', ['release', 'download', tag, '--repo', 'Teachmetech/MicroPal', '--dir', destination, '--pattern', 'release-manifest.json', '--pattern', '*.vsix'], { stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(`${destination}/release-manifest.json`, 'utf8'));
  if (manifest.asset !== `micropal-${tag.slice(1)}.vsix`) throw new Error('Unexpected release asset filename.');
  const bytes = await readFile(`${destination}/${manifest.asset}`);
  const extension = JSON.parse(execFileSync('unzip', ['-p', `${destination}/${manifest.asset}`, 'extension/package.json'], { encoding: 'utf8' }));
  validateReleaseArtifact(manifest, bytes, extension, { repository: 'Teachmetech/MicroPal', sourceCommit, tag, publisher: process.env.EXTENSION_PUBLISHER });
  await appendFile(process.env.GITHUB_OUTPUT, `released=true\ntag=${tag}\nversion=${manifest.version}\n`);
  console.log(`Verified GitHub release ${tag}; store publication runs separately.`);
}
