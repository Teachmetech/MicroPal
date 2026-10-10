/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function smoke() {
  const extension = vscode.extensions.getExtension('teachmetech.micropal');
  assert.ok(extension, 'Development extension is discoverable');
  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension activates in a trusted empty workspace');
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['setupTools', 'repairTools', 'connect', 'openDeviceFiles', 'closeDeviceFiles', 'flashFirmware', 'disconnect', 'runFile', 'uploadFile', 'uploadFilesToDevice', 'uploadFolderToDevice', 'syncProject', 'stop', 'softReset', 'openRepl', 'refreshFiles', 'openDeviceFile', 'downloadFile', 'showOutput']) {
    assert.ok(commands.includes(`microPal.${command}`), `Command registered: ${command}`);
  }
  assert.equal(vscode.workspace.getConfiguration('microPal').get('baudRate'), 115200);
  assert.equal(vscode.workspace.getConfiguration('microPal').get('autoReconnect'), true);
  assert.equal(vscode.workspace.getConfiguration('microPal').get('autoReleasePort'), true);
  assert.equal(vscode.workspace.getConfiguration('microPal').get('esptoolPath'), '');
  assert.equal(vscode.workspace.getConfiguration('microPal').get('mpremotePath'), '');
  assert.equal(vscode.workspace.getConfiguration('microPal').get('pythonPath'), '');
  await vscode.commands.executeCommand('microPal.showOutput');
  await vscode.commands.executeCommand('microPal.disconnect');
  await assert.rejects(vscode.workspace.fs.stat(vscode.Uri.parse('micropal://stale-session/')),
    error => error.code === 'Unavailable', 'Writable provider rejects a disconnected session');
  console.log('MicroPal editor-host smoke tests passed (activation, 19 commands, settings, output, disconnect, filesystem registration).');
}

exports.run = async function run() {
  let report;
  try {
    await smoke();
    report = { passed: true, editor: vscode.env.appName, version: vscode.version };
  } catch (error) {
    report = { passed: false, error: String(error), editor: vscode.env.appName, version: vscode.version };
    throw error;
  } finally {
    if (process.env.MICROPAL_TEST_REPORT) require('node:fs').writeFileSync(process.env.MICROPAL_TEST_REPORT, JSON.stringify(report));
    setTimeout(() => { void vscode.commands.executeCommand('workbench.action.closeWindow'); }, 200);
  }
};
