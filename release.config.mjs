import { commitTypes } from './scripts/release-utils.mjs';

const sections = {
  feat: 'Features', fix: 'Fixes', perf: 'Performance', refactor: 'Refactoring',
  docs: 'Documentation', test: 'Tests', build: 'Build', ci: 'Automation',
  chore: 'Maintenance', style: 'Style', revert: 'Reverts',
};

export default {
  branches: ['production'],
  repositoryUrl: 'https://github.com/Teachmetech/MicroPal.git',
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', {
      preset: 'conventionalcommits',
      releaseRules: [
        { breaking: true, release: 'major' },
        { type: 'feat', release: 'minor' },
        ...commitTypes.filter(type => type !== 'feat').map(type => ({ type, release: 'patch' })),
      ],
    }],
    ['@semantic-release/release-notes-generator', {
      preset: 'conventionalcommits',
      presetConfig: { types: commitTypes.map(type => ({ type, section: sections[type], hidden: false })) },
    }],
    ['@semantic-release/npm', { npmPublish: false }],
    './scripts/release-plugin.mjs',
    ['@semantic-release/git', {
      assets: ['CHANGELOG.md', 'package.json', 'package-lock.json'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }],
    ['@semantic-release/github', {
      assets: [
        { path: '.release/*.vsix', label: 'MicroPal extension (VS Code and Cursor)' },
        { path: '.release/release-manifest.json', label: 'Release source and VSIX checksum' },
        { path: '.release/CHECKSUMS.sha256', label: 'SHA-256 checksums' },
        { path: 'CHANGELOG.md', label: 'Complete changelog' },
      ],
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
    }],
  ],
};
