import { createHash } from 'node:crypto';

export const commitTypes = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];

export function assertConventionalTitle(title) {
  const pattern = new RegExp(`^(${commitTypes.join('|')})(\\([^()\\r\\n]+\\))?!?: \\S[^\\r\\n]*$`);
  if (!pattern.test(title)) throw new Error('Use a Conventional Commit title, for example "feat(serial): add reconnect".');
}

export function unreleasedSection(changelog) {
  const match = /^## \[?Unreleased\]?[^\r\n]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
  if (!match) throw new Error('CHANGELOG.md must contain a "## Unreleased" section.');
  return match[1].trim();
}

export function pendingChangelogEntries(current, previous) {
  const entries = text => {
    const result = [];
    for (const line of unreleasedSection(text).split('\n')) {
      if (/^- \S/.test(line)) result.push(line);
      else if (/^[ \t]+\S/.test(line) && result.length) result[result.length - 1] += `\n${line}`;
    }
    return result;
  };
  const old = new Set(entries(previous));
  return entries(current).filter(entry => !old.has(entry));
}

export function assertPullRequestChangelog(previous, current) {
  if (!pendingChangelogEntries(current, previous).length) {
    throw new Error('Add a new human-readable bullet to CHANGELOG.md under "## Unreleased" for this pull request.');
  }
}

export function assertPublisher(extension, expected) {
  if (!expected) throw new Error('Set the EXTENSION_PUBLISHER repository variable to the registered public publisher.');
  if (!extension.publisher || /(?:^|[-_])local(?:$|[-_])/i.test(extension.publisher)) throw new Error('A local publisher identity cannot be publicly released.');
  if (extension.publisher !== expected) throw new Error('EXTENSION_PUBLISHER must exactly match package.json publisher.');
  if (extension.name !== 'micropal') throw new Error('The release extension name must be micropal.');
}

export function publishingEnvironment(environment, { azure, trusted }) {
  const result = { ...environment };
  if (azure) delete result.VSCE_PAT;
  if (trusted) delete result.OVSX_PAT;
  return result;
}

export function renderReleaseChangelog(source, version, notes, date = new Date().toISOString().slice(0, 10)) {
  const human = unreleasedSection(source);
  const content = human && !notes.includes(human) ? `${human}\n\n### Commit summary\n\n${notes.trim()}` : notes.trim();
  return source.replace(/^## \[?Unreleased\]?[^\r\n]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m,
    `## [Unreleased]\n\n## ${version} (${date})\n\n${content}\n\n`);
}

export function validateReleaseArtifact(manifest, bytes, extension, expected) {
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported release manifest schema.');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Expected a stable release version.');
  if (manifest.repository !== expected.repository || manifest.sourceCommit !== expected.sourceCommit || manifest.tag !== expected.tag || manifest.tag !== `v${manifest.version}`) {
    throw new Error('Release repository, source commit or tag does not match this workflow run.');
  }
  const asset = `micropal-${manifest.version}.vsix`;
  if (manifest.asset !== asset) throw new Error('Unexpected release asset filename.');
  if (manifest.extensionId !== `${expected.publisher}.micropal` || `${extension.publisher}.${extension.name}` !== manifest.extensionId || extension.version !== manifest.version) {
    throw new Error('VSIX identity or version does not match the release manifest.');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('VSIX checksum does not match the release manifest.');
  return asset;
}
