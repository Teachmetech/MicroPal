import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semanticRelease from 'semantic-release';
import configuration from '../release.config.mjs';
import { validateReleaseArtifact } from '../scripts/release-utils.mjs';

it('releases 0.3.0 from the local baseline with a persisted changelog, version, tag and one verified VSIX', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const base = await mkdtemp(join(tmpdir(), 'micropal-release-test-'));
  const cwd = join(base, 'repo');
  const remote = join(base, 'remote.git');
  const environment = { ...process.env, GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', EXTENSION_PUBLISHER: 'teachmetech' };
  const originalPath = process.env.PATH;
  // The host can expose an incompatible Homebrew git before Apple's git.
  if (process.platform === 'darwin') {
    environment.PATH = `/usr/bin:${environment.PATH}`;
    process.env.PATH = environment.PATH;
  }
  const git = (...args) => execFileSync('git', args, { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await mkdir(cwd);
    execFileSync('git', ['init', '--bare', remote], { env: environment, stdio: 'ignore' });
    execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/production'], { env: environment, stdio: 'ignore' });
    git('init', '-b', 'production');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release-test@example.invalid');
    git('remote', 'add', 'origin', remote);
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(cwd, 'dist'));
    await writeFile(join(cwd, 'dist/extension.js'), 'exports.activate = () => {};\n');
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n.release/\n');
    await writeFile(join(cwd, '.vscodeignore'), '**\n!package.json\n!README.md\n!LICENSE\n!CHANGELOG.md\n!dist/extension.js\n');
    await writeFile(join(cwd, 'README.md'), '# MicroPal\n\nA release integration fixture.\n');
    await writeFile(join(cwd, 'LICENSE'), 'MIT License\n\nCopyright 2026\n');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({
      name: 'micropal', displayName: 'MicroPal', description: 'Release integration fixture', publisher: 'teachmetech',
      version: '0.2.1', license: 'MIT', engines: { vscode: '^1.95.0' }, main: './dist/extension.js',
      activationEvents: ['onStartupFinished'],
      repository: { type: 'git', url: 'https://github.com/Teachmetech/MicroPal.git' },
    }, null, 2));
    await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## 0.2.1\n\n- Local history.\n');
    git('add', '.');
    git('commit', '-m', 'chore: baseline');
    git('tag', 'v0.2.1');
    await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Public release automation with preserved notes.\n\n## 0.2.1\n\n- Local history.\n');
    git('add', '.');
    git('commit', '-m', 'feat: add public releases');
    git('push', '--follow-tags', 'origin', 'production');
    environment.GITHUB_SHA = git('rev-parse', 'HEAD');
    const plugins = configuration.plugins
      .filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) !== '@semantic-release/github')
      .map(plugin => plugin === './scripts/release-plugin.mjs' ? join(root, 'scripts/release-plugin.mjs') : plugin);
    const result = await semanticRelease({ ...configuration, repositoryUrl: pathToFileURL(remote).href, ci: false, plugins }, { cwd, env: environment });
    expect(result.nextRelease.version).toBe('0.3.0');
    expect(result.nextRelease.notes).toContain('- Public release automation with preserved notes.');
    expect(git('rev-parse', 'v0.3.0^')).toBe(environment.GITHUB_SHA);
    expect(JSON.parse(await readFile(join(cwd, 'package.json'))).version).toBe('0.3.0');
    const changelog = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('- Local history.');
    expect(changelog).toContain('- Public release automation with preserved notes.');
    expect(changelog).toMatch(/## \[Unreleased\]\s+## 0\.3\.0/);
    const manifest = JSON.parse(await readFile(join(cwd, '.release/release-manifest.json')));
    expect(manifest.sourceCommit).toBe(environment.GITHUB_SHA);
    // Publisher jobs execute on Ubuntu, where unzip inspects the actual package.
    if (process.platform !== 'win32') {
      const artifact = join(cwd, '.release', manifest.asset);
      const extension = JSON.parse(execFileSync('unzip', ['-p', artifact, 'extension/package.json'], { encoding: 'utf8' }));
      expect(validateReleaseArtifact(manifest, await readFile(artifact), extension, {
        repository: 'Teachmetech/MicroPal', sourceCommit: environment.GITHUB_SHA, tag: 'v0.3.0', publisher: 'teachmetech',
      })).toBe('micropal-0.3.0.vsix');
    }
  } finally {
    process.env.PATH = originalPath;
    await rm(base, { recursive: true, force: true });
  }
}, 60_000);
