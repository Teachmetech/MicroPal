import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const editor = process.argv[2] ?? 'code';
if (!['code', 'cursor'].includes(editor) && !isAbsolute(editor)) throw new Error('Choose code, cursor, or an absolute editor executable path.');
if (process.platform === 'win32' && !/\.exe$/i.test(editor)) throw new Error('On Windows, pass Code.exe or Cursor.exe directly.');
// Direct Mac app launches give this isolated harness ownership of the actual
// editor PID, including reliable cleanup if the editor fails before activation.
const executable = process.platform === 'darwin' && editor === 'code' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
  : process.platform === 'darwin' && editor === 'cursor' ? '/Applications/Cursor.app/Contents/MacOS/Cursor' : editor;
// macOS Unix IPC sockets have a short path limit; its default temp directory
// plus an isolated profile can otherwise prevent Cursor from starting.
const directory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `micropal-fs-${basename(editor)}-`));
const reportPath = join(directory, 'result.json');
const fixture = join(directory, 'fixture-extension');
await mkdir(join(directory, 'profile', 'User'), { recursive: true });
await mkdir(join(directory, 'local-project'), { recursive: true });
await mkdir(fixture, { recursive: true });
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'micropal-filesystem-host-fixture',
  publisher: 'micropal-test', version: '0.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs',
  activationEvents: ['*'], extensionKind: ['ui'], capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true } }));
const bundle = await esbuild.build({ entryPoints: [resolve('test/host-filesystem/extension.ts')], bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', outfile: join(fixture, 'extension.cjs'), external: ['vscode'], write: false });
for (const file of bundle.outputFiles ?? []) { await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents); }
await writeFile(join(directory, 'profile', 'User', 'settings.json'), JSON.stringify({
  'git.enabled': false, 'git.path': process.platform === 'darwin' ? '/usr/bin/git' : null,
  'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off',
  'files.hotExit': 'onExitAndWindowClose', 'explorer.confirmDelete': false,
  'window.confirmSaveUntitledWorkspace': false,
}));
const desktopLog = await open(join(directory, 'desktop.log'), 'w');
const child = spawn(executable, [
  `--extensionDevelopmentPath=${fixture}`,
  `--user-data-dir=${join(directory, 'profile')}`,
  `--extensions-dir=${join(directory, 'extensions')}`, '--disable-extensions', '--disable-workspace-trust',
  '--skip-welcome', '--skip-release-notes', '--new-window', join(directory, 'local-project'), '--wait',
], { env: { ...process.env, MICROPAL_TEST_REPORT: reportPath }, stdio: ['ignore', desktopLog.fd, desktopLog.fd], shell: false });
let launchError;
child.on('error', error => { launchError = error; });
let exit;
child.on('exit', (code, signal) => { exit = { code, signal }; });
await desktopLog.close();
try {
  let report;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (launchError) throw launchError;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exit) throw new Error(`Editor exited before reporting: ${JSON.stringify(exit)}. Inspect ${directory}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!report) { child.kill('SIGTERM'); throw new Error(`No filesystem editor report after 90 seconds. Inspect ${directory}`); }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
  console.log(`Filesystem editor logs: ${directory}`);
} finally {
  if (process.platform === 'darwin') child.kill('SIGTERM');
  child.unref();
}
