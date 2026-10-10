import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { assertConventionalTitle, assertPullRequestChangelog, unreleasedSection } from './release-utils.mjs';

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
if (event.pull_request) {
  assertConventionalTitle(event.pull_request.title);
  const previous = execFileSync('git', ['show', `${event.pull_request.base.sha}:CHANGELOG.md`], { encoding: 'utf8' });
  const current = execFileSync('git', ['show', `${event.pull_request.head.sha}:CHANGELOG.md`], { encoding: 'utf8' });
  assertPullRequestChangelog(previous, current);
  console.log('Conventional Commit title and Unreleased changelog entry verified.');
} else {
  unreleasedSection(await readFile('CHANGELOG.md', 'utf8'));
  console.log('Changelog structure verified.');
}
