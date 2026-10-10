import { describe, expect, it } from 'vitest';
import type { CommandSpec, ProcessRunner } from '../src/core/types';
import { ProcessError } from '../src/transport/processRunner';
import { SerialPortOwners, type SerialPortOwner } from '../src/transport/serialPortOwners';

const port = '/dev/cu.wchusbserial410';
const tools = '/Users/test/Library/Application Support/Cursor/User/globalStorage/micropal-local.micropal/tools';
const scripts = `${tools}/env-12345678-1234-4234-8234-123456789abc/bin`;
const repl = `${scripts}/python ${scripts}/mpremote connect ${port} repl`;
const started = 'Fri Oct  9 10:11:12 2026';
const lsofUsage = 'lsof 4.91\n latest revision: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/\n latest FAQ: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/FAQ\n latest man page: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/lsof_man\n usage: [-?abhlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-f[cgG]]\n [-F [f]] [-g [s]] [-i [i]] [+|-L [l]] [+|-M] [-o [o]] [-p s]\n [+|-r [t]] [-s [p:s]] [-S [t]] [-T [t]] [-u s] [+|-w] [-x [fl]] [--] [names]\nUse the ``-h\'\' option to get more help information.\n';
const expected: SerialPortOwner = {
  pid: 46459, uid: 501, command: repl, displayName: 'python', startTime: started, isMicroPalRepl: true,
};

interface ProcessFixture { pid: number; uid?: number; command?: string; startTime?: string; comm?: string; }
function fixture(initial: ProcessFixture[] = [{ pid: 46459 }], platform: NodeJS.Platform = 'darwin') {
  const calls: CommandSpec[] = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  let processes = initial;
  let time = 0;
  let onSignal = (pid: number, _signal: NodeJS.Signals) => { processes = processes.filter(owner => owner.pid !== pid); };
  let onInspect = () => {};
  let pathExists = async (_path: string) => true;
  const runner: ProcessRunner = { async run(spec) {
    calls.push(spec);
    if (spec.executable === 'lsof') {
      onInspect();
      if (!processes.length) throw new ProcessError('No open files', { stdout: '', stderr: '' }, 1);
      return { stdout: processes.map(owner => `p${owner.pid}\ncfixture\nu${owner.uid ?? 501}\n`).join(''), stderr: '' };
    }
    if (spec.executable !== 'ps') throw new Error('Unexpected executable');
    const owner = processes.find(candidate => candidate.pid === Number(spec.args[spec.args.indexOf('-p') + 1]));
    if (!owner) throw new ProcessError('No process', { stdout: '', stderr: '' }, 1);
    if (spec.args.includes('comm=')) return { stdout: `${owner.comm ?? `${scripts}/python`}\n`, stderr: '' };
    return { stdout: `  ${owner.uid ?? 501} ${owner.startTime ?? started} ${owner.command ?? repl}\n`, stderr: '' };
  } };
  const service = new SerialPortOwners(runner, {
    platform, uid: 501, pid: 999, managedToolsRoot: tools,
    signalProcess: (pid, signal) => { signals.push([pid, signal]); onSignal(pid, signal); },
    now: () => time,
    sleep: async ms => { time += ms; },
    pathExists: path => pathExists(path),
  });
  return { service, runner, calls, signals,
    setProcesses: (value: ProcessFixture[]) => { processes = value; },
    onSignal: (value: typeof onSignal) => { onSignal = value; },
    onInspect: (value: typeof onInspect) => { onInspect = value; },
    pathExists: (value: typeof pathExists) => { pathExists = value; },
  };
}

describe('SerialPortOwners inspection', () => {
  it('inspects the selected macOS port and its tty alias using literal arguments', async () => {
    const value = fixture();
    expect(await value.service.inspect(port)).toEqual([expected]);
    expect(value.calls[0]).toEqual({ executable: 'lsof', args: ['-nP', '-Fpcu', '--', port, '/dev/tty.wchusbserial410'] });
    expect(value.calls.some(call => call.executable === 'ps' && call.args.includes('-ww'))).toBe(true);
  });

  it('deduplicates process records and preserves distinct owners on Linux', async () => {
    const value = fixture([{ pid: 46459 }, { pid: 46459 }, { pid: 77, command: '/usr/bin/screen /dev/ttyUSB0', comm: '/usr/bin/screen' }], 'linux');
    const owners = await value.service.inspect('/dev/ttyUSB0');
    expect(owners.map(owner => [owner.pid, owner.displayName])).toEqual([[46459, 'python'], [77, 'screen']]);
    expect(value.calls[0]?.args).toEqual(['-nP', '-Fpcu', '--', '/dev/ttyUSB0']);
  });

  it('accepts mandatory fd fields emitted by stock macOS lsof 4.91', async () => {
    const value = fixture();
    const original = value.runner.run.bind(value.runner);
    value.runner.run = async (spec, options) => spec.executable === 'lsof'
      ? { stdout: 'p46459\ncPython\nu501\nf3\nf5\n', stderr: '' }
      : original(spec, options);
    expect(await value.service.inspect(port)).toEqual([expected]);
  });

  it('treats lsof exit 1 with empty output as an unowned port', async () => {
    expect(await fixture([]).service.inspect(port)).toEqual([]);
  });

  it('retains valid ownership output when lsof reports a warning', async () => {
    const value = fixture();
    const original = value.runner.run.bind(value.runner);
    value.runner.run = async (spec, options) => spec.executable === 'lsof'
      ? Promise.reject(new ProcessError('Warning', { stdout: 'p46459\ncPython\nu501\n', stderr: 'lsof: WARNING: cannot stat unrelated mount' }, 1))
      : original(spec, options);
    expect(await value.service.inspect(port)).toEqual([expected]);
  });

  it('accepts macOS lsof mount warning continuations only within their warning block', async () => {
    const value = fixture();
    const original = value.runner.run.bind(value.runner);
    value.runner.run = async (spec, options) => spec.executable === 'lsof'
      ? Promise.reject(new ProcessError('Warning', {
        stdout: 'p46459\ncPython\nu501\n',
        stderr: 'lsof: WARNING: can\'t stat() smbfs file system /Volumes/.timemachine/TimeMachine\n      Output information may be incomplete.\n      assuming "dev=3600000a" from mount table\n',
      }, 1))
      : original(spec, options);
    expect(await value.service.inspect(port)).toEqual([expected]);
    value.runner.run = async () => { throw new ProcessError('Bad output', {
      stdout: '', stderr: '      assuming "dev=3600000a" from mount table\n',
    }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect/i);
  });

  it('rejects unexpected diagnostics even after a valid lsof warning', async () => {
    const value = fixture();
    value.runner.run = async () => { throw new ProcessError('Bad output', {
      stdout: '', stderr: 'lsof: WARNING: cannot stat unrelated mount\n      permission denied\n',
    }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect|permission/i);
  });

  it('reports unavailable inspection tools instead of assuming the port is free', async () => {
    const value = fixture();
    value.runner.run = async () => { throw new ProcessError('not found', { stdout: '', stderr: '' }, 'ENOENT'); };
    await expect(value.service.inspect(port)).rejects.toThrow(/lsof.*install|install.*lsof/i);
  });

  it('does not treat a fatal lsof diagnostic as evidence that the port is free', async () => {
    const value = fixture();
    value.runner.run = async () => { throw new ProcessError('failure', { stdout: '', stderr: 'lsof: permission denied' }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect|permission/i);
  });

  it('reports a vanished port as free only after confirming every queried path is gone', async () => {
    const value = fixture([]);
    const checked: string[] = [];
    value.pathExists(async path => { checked.push(path); return false; });
    value.runner.run = async () => { throw new ProcessError('Missing file', {
      stdout: '', stderr: `lsof: status error on ${port}: No such file or directory\n${lsofUsage}`,
    }, 1); };
    expect(await value.service.inspect(port)).toEqual([]);
    expect(checked).toEqual([port, '/dev/tty.wchusbserial410']);
  });

  it('does not assume a vanished alias proves an existing selected port is free', async () => {
    const value = fixture([]);
    value.pathExists(async path => path === port);
    value.runner.run = async () => { throw new ProcessError('Missing alias', {
      stdout: '', stderr: `lsof: status error on /dev/tty.wchusbserial410: No such file or directory\n${lsofUsage}`,
    }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect/i);
  });

  it('keeps filesystem permission errors and unrelated lsof failures diagnostic', async () => {
    const value = fixture([]);
    value.pathExists(async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); });
    value.runner.run = async () => { throw new ProcessError('Missing port', {
      stdout: '', stderr: `lsof: status error on ${port}: No such file or directory\n${lsofUsage}`,
    }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/permission/i);
    value.pathExists(async () => false);
    value.runner.run = async () => { throw new ProcessError('Fatal failure', {
      stdout: '', stderr: `lsof: status error on ${port}: No such file or directory\nlsof: permission denied\n${lsofUsage}`,
    }, 1); };
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect|permission/i);
  });

  it('rejects malformed ownership and process identity output', async () => {
    const value = fixture();
    value.runner.run = async () => ({ stdout: 'pnot-a-pid\ncPython\nu501\n', stderr: '' });
    await expect(value.service.inspect(port)).rejects.toThrow(/inspect|ownership/i);
    value.runner.run = async spec => ({ stdout: spec.executable === 'lsof' ? 'p46459\ncPython\nu501\n' : 'truncated', stderr: '' });
    await expect(value.service.inspect(port)).rejects.toThrow(/identity|inspect/i);
  });

  it('provides actionable unsupported-platform guidance without running tools', async () => {
    const value = fixture([], 'win32');
    await expect(value.service.inspect('COM4')).rejects.toThrow(/Windows|supported/i);
    expect(value.calls).toEqual([]);
  });

  it.each([
    ['/usr/bin/python /tmp/mpremote connect /dev/cu.wchusbserial410 repl', false],
    [`${scripts}/python ${scripts}/mpremote connect ${port} run main.py`, false],
    [`${scripts}/python ${scripts}/mpremote connect ${port} exec print(1)`, false],
    [`${scripts}/python ${scripts}/mpremote connect ${port} fs ls`, false],
    [`${scripts}/python ${scripts}/esptool --port ${port} write-flash 0 firmware.bin`, false],
    [`${scripts}/python ${scripts}/mpremote connect ${port} repl exec print(1) repl`, false],
    [`${scripts}/python ${scripts}/mpremote connect /dev/cu.other repl`, false],
    [`${scripts}/python ${scripts}/mpremote connect /dev/tty.wchusbserial410 repl`, true],
    [`${scripts}/python3.13 ${scripts}/mpremote connect id:ESP32-serial repl`, true],
    [`${scripts}/python ${scripts}/mpremote connect id:two words repl`, false],
    [`${scripts}/python ${scripts}/mpremote connect id:ESP32 repl run file.py repl`, false],
    [`${scripts}/python ${scripts}/mpremote connect ${port} repl extra`, false],
    [`${scripts}/mpremote connect ${port} repl`, false],
  ])('classifies only a complete managed mpremote REPL command: %s', async (command, isMicroPalRepl) => {
    const value = fixture([{ pid: 46459, command }]);
    expect((await value.service.inspect(port))[0]?.isMicroPalRepl).toBe(isMicroPalRepl);
  });

  it('requires the configured managed storage root to recognize a REPL', async () => {
    const value = fixture();
    expect((await new SerialPortOwners(value.runner, { platform: 'darwin', uid: 501 }).inspect(port))[0]?.isMicroPalRepl).toBe(false);
  });

  it('preserves multiline external process arguments for identity without classifying them as managed', async () => {
    const command = '/usr/bin/python3 -c import os\nos.open("/dev/cu.wchusbserial410", os.O_RDWR)';
    const value = fixture([{ pid: 46459, command, comm: '/usr/bin/python3' }]);
    expect(await value.service.inspect(port)).toEqual([{ ...expected, command, displayName: 'python3', isMicroPalRepl: false }]);
  });

  it('does not automatically classify another user\'s managed REPL as releasable', async () => {
    const value = fixture([{ pid: 46459, uid: 502 }]);
    expect((await value.service.inspect(port))[0]?.isMicroPalRepl).toBe(false);
  });
});

describe('SerialPortOwners release', () => {
  it('signals the exact current owner and waits until the port is free', async () => {
    const value = fixture();
    await value.service.release(port, [expected]);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
    expect(await value.service.inspect(port)).toEqual([]);
  });

  it('does not signal a stale owner that already released the port', async () => {
    const value = fixture([]);
    await value.service.release(port, [expected]);
    expect(value.signals).toEqual([]);
  });

  it.each([
    { pid: 46459, uid: 502 },
    { pid: 46459, startTime: 'Fri Oct  9 10:12:12 2026' },
    { pid: 46459, command: '/usr/bin/python critical.py' },
    { pid: 100, command: '/usr/bin/screen' },
  ])('refuses to signal a changed owner or reused PID: %j', async current => {
    const value = fixture([current]);
    await expect(value.service.release(port, [expected])).rejects.toThrow(/changed|different|owner/i);
    expect(value.signals).toEqual([]);
  });

  it.each([1, 0, -10, 999])('never signals protected PID %s', async pid => {
    const value = fixture([{ pid }]);
    await expect(value.service.release(port, [{ ...expected, pid }])).rejects.toThrow(/process|PID|owner/i);
    expect(value.signals).toEqual([]);
  });

  it('never signals a process belonging to another user', async () => {
    const value = fixture([{ pid: 46459, uid: 502 }]);
    await expect(value.service.release(port, [{ ...expected, uid: 502 }])).rejects.toThrow(/user|owner/i);
    expect(value.signals).toEqual([]);
  });

  it('rechecks ownership before signaling each process', async () => {
    const value = fixture([{ pid: 46459 }, { pid: 55 }]);
    value.onSignal(() => value.setProcesses([{ pid: 55, startTime: 'Fri Oct  9 10:12:12 2026' }]));
    await expect(value.service.release(port, [expected, { ...expected, pid: 55 }])).rejects.toThrow(/changed|owner/i);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });

  it('leaves a newly acquired owner untouched while waiting for release', async () => {
    const value = fixture();
    value.onSignal(() => value.setProcesses([{ pid: 55, command: '/usr/bin/screen' }]));
    await expect(value.service.release(port, [expected], { force: true })).rejects.toThrow(/changed|owner/i);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });

  it('times out without escalating when an owner ignores graceful termination', async () => {
    const value = fixture();
    value.onSignal(() => {});
    await expect(value.service.release(port, [expected])).rejects.toThrow(/still|timed out|force/i);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });

  it('force terminates only the still-matching owner after graceful timeout', async () => {
    const value = fixture();
    value.onSignal((pid, signal) => { if (signal === 'SIGKILL') value.setProcesses([]); });
    await value.service.release(port, [expected], { force: true });
    expect(value.signals).toEqual([[46459, 'SIGTERM'], [46459, 'SIGKILL']]);
  });

  it('refuses force termination if the PID was reused during graceful waiting', async () => {
    const value = fixture();
    let inspections = 0;
    value.onSignal(() => {});
    value.onInspect(() => { if (++inspections === 4) value.setProcesses([{ pid: 46459, startTime: 'Fri Oct  9 10:12:12 2026' }]); });
    await expect(value.service.release(port, [expected], { force: true })).rejects.toThrow(/changed|owner/i);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });

  it('reports permission failures without trying a stronger signal', async () => {
    const value = fixture();
    value.onSignal(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
    await expect(value.service.release(port, [expected], { force: true })).rejects.toThrow(/permission|permitted/i);
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });

  it('does not inspect or signal after an already cancelled release', async () => {
    const value = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(value.service.release(port, [expected], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.calls).toEqual([]);
    expect(value.signals).toEqual([]);
  });

  it('does not signal when release is cancelled during inspection', async () => {
    const value = fixture();
    const controller = new AbortController();
    value.onInspect(() => controller.abort());
    await expect(value.service.release(port, [expected], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.signals).toEqual([]);
  });

  it('does not force terminate when release is cancelled while waiting', async () => {
    const value = fixture();
    const controller = new AbortController();
    value.onSignal(() => controller.abort());
    await expect(value.service.release(port, [expected], { force: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.signals).toEqual([[46459, 'SIGTERM']]);
  });
});
