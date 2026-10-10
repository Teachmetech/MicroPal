import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertConventionalTitle, assertPublisher, assertPullRequestChangelog,
  pendingChangelogEntries, publishingEnvironment, renderReleaseChangelog, validateReleaseArtifact,
} from '../scripts/release-utils.mjs';

const previous = '# Changelog\n\n## Unreleased\n\n- Earlier change.\n\n## 0.2.1\n\n- History.\n';
const current = previous.replace('- Earlier change.', '- New behavior.\n  More detail.\n\n- Earlier change.');

describe('release policy', () => {
  it.each(['feat: add uploads', 'fix(serial): release port', 'docs!: replace setup', 'chore(deps): update dependencies', 'ci: update checks'])('accepts conventional title %s', title => {
    expect(() => assertConventionalTitle(title)).not.toThrow();
  });
  it.each(['Add uploads', 'feat:', 'Feat: uppercase type', 'unknown: change', 'fix: one\nfeat: two'])('rejects title %s', title => {
    expect(() => assertConventionalTitle(title)).toThrow(/Conventional Commit/);
  });
  it('requires a new human changelog entry in Unreleased for every pull request', () => {
    expect(() => assertPullRequestChangelog(previous, current)).not.toThrow();
    expect(() => assertPullRequestChangelog(previous, previous)).toThrow(/Unreleased/);
    expect(() => assertPullRequestChangelog(previous, previous + '\n- Wrong section.\n')).toThrow(/Unreleased/);
  });
  it('keeps multiline entries together and does not repeat earlier entries', () => {
    expect(pendingChangelogEntries(current, previous)).toEqual(['- New behavior.\n  More detail.']);
  });
  it('recognizes entries beneath Keep a Changelog category headings', () => {
    const categorized = current.replace('## Unreleased', '## [Unreleased]\n\n### Added');
    expect(() => assertPullRequestChangelog(previous, categorized)).not.toThrow();
  });
  it('preserves all source notes when generating the packaged changelog', () => {
    const rendered = renderReleaseChangelog(current, '0.3.0', 'Generated notes.', '2026-10-09');
    expect(rendered).toContain('## 0.3.0 (2026-10-09)');
    expect(rendered).toContain('Generated notes.');
    expect(rendered).toContain('- Earlier change.');
    expect(rendered).toContain('- New behavior.\n  More detail.');
    expect(rendered).toContain('## 0.2.1\n\n- History.');
  });
  it('requires an explicitly confirmed public publisher', () => {
    expect(() => assertPublisher({ name: 'micropal', publisher: 'Teachmetech' }, 'Teachmetech')).not.toThrow();
    expect(() => assertPublisher({ name: 'micropal', publisher: 'micropal-local' }, 'micropal-local')).toThrow(/local/);
    expect(() => assertPublisher({ name: 'micropal', publisher: 'Teachmetech' }, '')).toThrow(/EXTENSION_PUBLISHER/);
    expect(() => assertPublisher({ name: 'micropal', publisher: 'Teachmetech' }, 'other')).toThrow(/match/);
  });
});

describe('publisher authentication selection', () => {
  const environment = { VSCE_PAT: 'old-marketplace-token', OVSX_PAT: 'bootstrap-token', PATH: '/tools' };
  it('removes a transitional Marketplace PAT when Azure credentials were selected', () => {
    expect(publishingEnvironment(environment, { azure: true })).toEqual({ OVSX_PAT: 'bootstrap-token', PATH: '/tools' });
    expect(environment.VSCE_PAT).toBe('old-marketplace-token');
  });
  it('removes the bootstrap Open VSX PAT when trusted publishing was selected', () => {
    expect(publishingEnvironment(environment, { trusted: true })).toEqual({ VSCE_PAT: 'old-marketplace-token', PATH: '/tools' });
  });
  it('preserves explicit PAT authentication when no identity mode was selected', () => {
    expect(publishingEnvironment(environment, {})).toEqual(environment);
  });
});

describe('immutable release artifact', () => {
  const bytes = Buffer.from('packaged extension');
  const manifest = {
    schemaVersion: 1, repository: 'Teachmetech/MicroPal', sourceCommit: 'a'.repeat(40),
    version: '0.3.0', tag: 'v0.3.0', extensionId: 'Teachmetech.micropal',
    asset: 'micropal-0.3.0.vsix', sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const extension = { name: 'micropal', publisher: 'Teachmetech', version: '0.3.0' };
  const validate = (changes = {}, fileBytes = bytes, packageChanges = {}) => validateReleaseArtifact(
    { ...manifest, ...changes }, fileBytes, { ...extension, ...packageChanges },
    { repository: 'Teachmetech/MicroPal', sourceCommit: 'a'.repeat(40), tag: 'v0.3.0', publisher: 'Teachmetech' },
  );
  it('accepts exactly the expected source, identity, version and bytes', () => {
    expect(validate()).toBe('micropal-0.3.0.vsix');
  });
  it.each([
    { repository: 'other/project' }, { sourceCommit: 'b'.repeat(40) }, { tag: 'v0.3.1' },
    { extensionId: 'other.micropal' }, { asset: '../micropal-0.3.0.vsix' },
    { version: '0.3.0-beta.1' }, { schemaVersion: 2 },
  ])('rejects mismatched release metadata %j', changes => {
    expect(() => validate(changes)).toThrow();
  });
  it('rejects mismatched package metadata and modified bytes', () => {
    expect(() => validate({}, bytes, { version: '0.3.1' })).toThrow(/identity|version/);
    expect(() => validate({}, Buffer.from('different bytes'))).toThrow(/checksum/);
  });
});
