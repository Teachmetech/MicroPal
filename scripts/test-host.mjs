import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, basename } from 'node:path';

const editor = process.argv[2] ?? 'code';
if (!['code', 'cursor'].includes(editor) && !isAbsolute(editor)) throw new Error('Choose code, cursor, or an absolute editor executable path.');
if (process.platform === 'win32' && !/\.exe$/i.test(editor)) throw new Error('On Windows, pass the full path to Code.exe or Cursor.exe (not its .cmd shim).');
const directory = await mkdtemp(join(tmpdir(), `micropal-${basename(editor)}-`));
const reportPath = join(directory, 'result.json');
await mkdir(join(directory, 'profile', 'User'), { recursive: true });
await writeFile(join(directory, 'profile', 'User', 'settings.json'), JSON.stringify({
  'git.enabled': false, 'git.path': process.platform === 'darwin' ? '/usr/bin/git' : null,
  'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off',
}));
const child = spawn(editor, [
  `--extensionDevelopmentPath=${resolve('.')}`,
  `--extensionTestsPath=${resolve('test/host/index.cjs')}`,
  `--user-data-dir=${join(directory, 'profile')}`,
  `--extensions-dir=${join(directory, 'extensions')}`,
  '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', resolve('examples'), '--wait',
], { env: { ...process.env, MICROPAL_TEST_REPORT: reportPath }, stdio: 'inherit', shell: false });
let launchError;
child.on('error', error => { launchError = error; });
let report;
for (let attempt = 0; attempt < 120; attempt++) {
  if (launchError) throw launchError;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!report) throw new Error(`No editor test report after 60 seconds. Inspect ${directory}`);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
console.log(`Editor test logs: ${directory}`);

child.unref();
