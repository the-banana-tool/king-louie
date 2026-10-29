'use strict';

// src/desktop-bridge/personal-node.js (spec 2026-10-28 §5.2, §6.3, §7.1):
// what the desktop knows about a personal node on this machine, and the
// programs it runs for it. Every process and file read is injected.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPersonalNodeRunner } = require('../src/desktop-bridge/personal-node');

const ME = 'S-1-5-21-1000-2000-3000-1001';
const OTHER = 'S-1-5-21-1000-2000-3000-1002';
const PERSONAL_YAML = 'name: laptop-01\nprofile: agent\nhosting: personal\n';

const temps = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

function layout(yaml = PERSONAL_YAML) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pn-'));
  temps.push(root);
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(configDir);
  fs.mkdirSync(dataDir);
  const nodeYaml = path.join(configDir, 'node.yaml');
  if (yaml !== null) fs.writeFileSync(nodeYaml, yaml);
  return { root, configDir, dataDir, nodeYaml, file: path.join(configDir, 'desktop-bridge.json') };
}

const mine = { owner: ME, link: false };
const admin = { owner: 'S-1-5-32-544', link: false };

function recording(entries, me = ME) {
  const calls = [];
  const fn = async (paths) => { calls.push(paths); return { me, entries }; };
  fn.calls = calls;
  return fn;
}

describe('detectPersonalNode', () => {
  it('says personal when the config dir, node.yaml and the data dir are owned by me', async () => {
    const { configDir, dataDir, nodeYaml, file } = layout();
    const inspectOwners = recording([mine, null, mine, mine]);
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners });
    const out = await runner.detectPersonalNode();
    assert.deepStrictEqual(out, { personal: true, name: 'laptop-01', dataDir, configDir, me: ME });
    assert.deepStrictEqual(inspectOwners.calls, [[configDir, file, nodeYaml, dataDir]]);
  });

  it('answers for a recorded data dir (the config dir beside it)', async () => {
    const { configDir, dataDir, file } = layout();
    const inspectOwners = recording([mine, mine, mine, mine]);
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, inspectOwners });
    const out = await runner.detectPersonalNode({ dataDir });
    assert.strictEqual(out.personal, true);
    assert.strictEqual(out.configDir, configDir);
    assert.strictEqual(inspectOwners.calls[0][1], file);
  });

  it('is not personal when a path is another account\'s, a link, missing, or node.yaml says otherwise', async () => {
    const cases = [
      [[mine, null, mine, { owner: OTHER, link: false }], 'other-owner'],
      [[{ owner: ME, link: true }, null, mine, mine], 'link'],
      [[mine, null, mine, null], 'missing'],
      [[mine, null, null, mine], 'not-personal']
    ];
    for (const [entries, reason] of cases) {
      const { file } = layout();
      const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners: recording(entries) });
      const out = await runner.detectPersonalNode();
      assert.strictEqual(out.personal, false, reason);
      assert.strictEqual(out.reason, reason);
    }
    const { file } = layout('name: laptop-01\nprofile: agent\nhosting: service\n');
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners: recording([mine, null, mine, mine]) });
    assert.strictEqual((await runner.detectPersonalNode()).reason, 'not-personal');
  });

  it('is not personal on an empty or short inspector reply, or when the inspector fails', async () => {
    const { file } = layout();
    for (const inspectOwners of [
      recording([mine, null, mine, mine], ''),
      recording([mine, mine]),
      async () => { throw new Error('powershell gone'); }
    ]) {
      const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners });
      const out = await runner.detectPersonalNode();
      assert.strictEqual(out.personal, false);
      assert.strictEqual(out.reason, 'unreadable');
    }
  });

  it('passes the name through shown', async () => {
    const { file } = layout("name: 'laptop‮-01'\nprofile: agent\nhosting: personal\n");
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners: recording([mine, null, mine, mine]) });
    const out = await runner.detectPersonalNode();
    assert.strictEqual(out.personal, true);
    assert.ok(!out.name.includes('‮'));
    assert.match(out.name, /hidden or control characters removed/);
  });

  it('is never personal off Windows, or for the e2e bridge-file override', async () => {
    const { file } = layout();
    const inspectOwners = recording([mine, null, mine, mine]);
    const posix = createPersonalNodeRunner({ platform: 'linux', env: {}, bridgeFile: file, inspectOwners });
    assert.strictEqual((await posix.detectPersonalNode()).personal, false);
    const e2e = createPersonalNodeRunner({ platform: 'win32', env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file }, inspectOwners });
    assert.strictEqual((await e2e.detectPersonalNode()).personal, false);
    assert.strictEqual(inspectOwners.calls.length, 0);
  });
});

describe('inspectLocal (C-1: the bridge read and the personal question from one inspector call)', () => {
  it('answers both from one call: a personal node with no bridge file yet', async () => {
    const { configDir, dataDir, file } = layout();
    const inspectOwners = recording([mine, null, mine, mine]);
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners });
    const out = await runner.inspectLocal();
    assert.strictEqual(inspectOwners.calls.length, 1);
    assert.strictEqual(out.trust.ok, false);
    assert.strictEqual(out.trust.code, 'BRIDGE_FILE_MISSING');
    assert.deepStrictEqual(out.node, { personal: true, name: 'laptop-01', dataDir, configDir, me: ME });
  });

  it('reads a trusted personal bridge file with its record and hosting', async () => {
    const { file } = layout();
    const { bridgeFileRecord } = require('../src/desktop-bridge/pairing');
    const publicKey = require('crypto').generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    fs.writeFileSync(file, JSON.stringify(bridgeFileRecord({ publicKey, port: 18796 })));
    const inspectOwners = recording([mine, mine, mine, mine]);
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners });
    const out = await runner.inspectLocal();
    assert.strictEqual(inspectOwners.calls.length, 1);
    assert.strictEqual(out.trust.ok, true, out.trust.error);
    assert.strictEqual(out.trust.hosting, 'personal');
    assert.strictEqual(out.trust.record.port, 18796);
    assert.strictEqual(out.node.personal, true);
  });

  it('keeps the fleet rule for an Administrators-owned layout, and the node is not personal', async () => {
    const { file } = layout(null);
    fs.writeFileSync(file, '{}');
    const runner = createPersonalNodeRunner({ platform: 'win32', env: {}, bridgeFile: file, inspectOwners: recording([admin, admin, null, null]) });
    const out = await runner.inspectLocal();
    assert.strictEqual(out.node.personal, false);
    assert.strictEqual(out.trust.code, 'BRIDGE_FILE_INVALID');
  });
});

// --- programs and files (§6.3, §7.1) ---

const { EventEmitter } = require('events');
const FIXTURES = path.join(__dirname, 'fixtures', 'desktop-personal-node');
const ENV = { SystemRoot: 'C:\\Windows', FOO: 'bar' };
const SCHTASKS = path.win32.join('C:\\Windows', 'System32', 'schtasks.exe');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

// child_process.execFile's callback shape; `answer(file, args)` returns
// { err, stdout, stderr }.
function fakeExecFile(answer) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const { err = null, stdout = '', stderr = '' } = answer(file, args) || {};
    setImmediate(() => cb(err, stdout, stderr));
  };
  fn.calls = calls;
  return fn;
}

function exitError(code) {
  const err = new Error(`Command failed with exit code ${code}`);
  err.code = code;
  return err;
}

// child_process.spawn: `script(child, args)` drives each child.
function fakeSpawn(script) {
  const calls = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    calls.push({ file, args, opts, child });
    setImmediate(() => script(child, args));
    return child;
  };
  fn.calls = calls;
  return fn;
}

function exits(code, stdout = '', stderr = '') {
  return (child) => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, null);
  };
}

describe('queryTask (C-10: the task XML, never the localised text)', () => {
  const runner = (answer, extra = {}) => {
    const execFile = fakeExecFile(answer);
    return { execFile, r: createPersonalNodeRunner({ platform: 'win32', env: ENV, execFile, ...extra }) };
  };

  it('queries the one task as XML, by schtasks\'s absolute path, with no shell', async () => {
    const { execFile, r } = runner(() => ({ stdout: fixture('enabled') }));
    assert.deepStrictEqual(await r.queryTask({ me: ME }), { state: 'registered' });
    assert.strictEqual(execFile.calls.length, 1);
    assert.strictEqual(execFile.calls[0].file, SCHTASKS);
    assert.deepStrictEqual(execFile.calls[0].args, ['/Query', '/TN', 'KingLouie Node', '/XML', 'ONE']);
    assert.ok(!execFile.calls[0].opts.shell);
  });

  it('reads <Settings><Enabled>false</Enabled> as disabled', async () => {
    const { r } = runner(() => ({ stdout: fixture('disabled') }));
    assert.deepStrictEqual(await r.queryTask({ me: ME }), { state: 'disabled' });
  });

  it('refuses another account\'s task, whatever its state', async () => {
    const { r } = runner(() => ({ stdout: fixture('other-account') }));
    assert.deepStrictEqual(await r.queryTask({ me: ME }), { state: 'other-account', userId: OTHER });
  });

  it('reads UTF-16 output too', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fixture('enabled'), 'utf16le')]);
    const { r } = runner(() => ({ stdout: utf16 }));
    assert.deepStrictEqual(await r.queryTask({ me: ME }), { state: 'registered' });
  });

  it('says missing on a non-zero exit, unknown when schtasks could not run or the XML says nothing', async () => {
    assert.deepStrictEqual(await runner(() => ({ err: exitError(1) })).r.queryTask({ me: ME }), { state: 'missing' });
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    assert.deepStrictEqual(await runner(() => ({ err: enoent })).r.queryTask({ me: ME }), { state: 'unknown' });
    const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
    assert.deepStrictEqual(await runner(() => ({ err: timedOut })).r.queryTask({ me: ME }), { state: 'unknown' });
    assert.deepStrictEqual(await runner(() => ({ stdout: '<Task></Task>' })).r.queryTask({ me: ME }), { state: 'unknown' });
  });

  it('compares with the SID the last owner read reported, and is unknown with no SID at all', async () => {
    const { file } = layout();
    const execFile = fakeExecFile(() => ({ stdout: fixture('enabled') }));
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, execFile, bridgeFile: file, inspectOwners: recording([mine, null, mine, mine]), whoAmI: async () => null });
    assert.deepStrictEqual(await r.queryTask(), { state: 'unknown' });
    await r.detectPersonalNode();
    assert.deepStrictEqual(await r.queryTask(), { state: 'registered' });
    const viaWhoAmI = createPersonalNodeRunner({ platform: 'win32', env: ENV, execFile, whoAmI: async () => ME });
    assert.deepStrictEqual(await viaWhoAmI.queryTask(), { state: 'registered' });
  });

  it('is unknown off Windows, and runs nothing', async () => {
    const execFile = fakeExecFile(() => ({ stdout: fixture('enabled') }));
    const r = createPersonalNodeRunner({ platform: 'linux', env: ENV, execFile });
    assert.deepStrictEqual(await r.queryTask({ me: ME }), { state: 'unknown' });
    assert.strictEqual(execFile.calls.length, 0);
  });

  it('names the task the installer registers', () => {
    assert.strictEqual(require('../src/desktop-bridge/personal-node').PERSONAL_TASK_NAME, require('../src/service/personal-install').PERSONAL_TASK_NAME);
    // The pane (loaded by the preload) reads it from protocol.js.
    assert.strictEqual(require('../src/desktop-bridge/protocol').PERSONAL_TASK_NAME, require('../src/service/personal-install').PERSONAL_TASK_NAME);
  });
});

describe('nodeRunning (the pidfile and the command line, as stop tests them)', () => {
  const SERVICE_LINE = '"C:\\Program Files\\King Louie\\King Louie.exe" "C:\\Program Files\\King Louie\\resources\\app.asar\\bin\\king-louie-service.js" run --data-dir "C:\\data"';
  const make = ({ pid = 4242, alive = true, cmdline = SERVICE_LINE } = {}) => {
    const seen = {};
    const r = createPersonalNodeRunner({
      platform: 'win32',
      env: ENV,
      readPidfile: async (dir) => { seen.dir = dir; return pid; },
      isRunning: (p) => { seen.alive = p; return alive; },
      commandLineOf: async (p) => { seen.cmd = p; return cmdline; }
    });
    return { r, seen };
  };

  it('reads the pidfile with the service\'s own reader by default', async () => {
    const { dataDir } = layout();
    fs.writeFileSync(path.join(dataDir, 'service.pid'), `${process.pid}\n`);
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, commandLineOf: async () => 'node bin/king-louie-service.js run --data-dir x' });
    assert.deepStrictEqual(await r.nodeRunning({ dataDir }), { running: true, pid: process.pid });
    fs.writeFileSync(path.join(dataDir, 'service.pid'), 'not a pid');
    assert.deepStrictEqual(await r.nodeRunning({ dataDir }), { running: false, pid: null });
  });

  it('asks /bin/ps by absolute path for the command line off Windows and Linux', async () => {
    const execFile = fakeExecFile(() => ({ stdout: 'node king-louie-service.js run\n' }));
    const r = createPersonalNodeRunner({ platform: 'darwin', env: ENV, execFile, readPidfile: async () => 4242, isRunning: () => true });
    assert.deepStrictEqual(await r.nodeRunning({ dataDir: '/data' }), { running: true, pid: 4242 });
    assert.strictEqual(execFile.calls[0].file, '/bin/ps');
    assert.deepStrictEqual(execFile.calls[0].args, ['-o', 'args=', '-p', '4242']);
  });

  it('exports the one firstLine: the first non-empty line, through shown', () => {
    const { firstLine } = require('../src/desktop-bridge/personal-node');
    assert.strictEqual(firstLine('\n  boom‮ \nmore'), 'boom [hidden or control characters removed]');
    assert.strictEqual(firstLine(''), '');
  });

  it('is running when the pidfile names a live king-louie-service run', async () => {
    const { r, seen } = make();
    assert.deepStrictEqual(await r.nodeRunning({ dataDir: 'C:\\data' }), { running: true, pid: 4242 });
    assert.deepStrictEqual(seen, { dir: 'C:\\data', alive: 4242, cmd: 4242 });
  });

  it('is not running with no pidfile, a dead pid, another program or relay run, or an unreadable command line', async () => {
    assert.deepStrictEqual(await make({ pid: null }).r.nodeRunning({ dataDir: 'C:\\data' }), { running: false, pid: null });
    assert.deepStrictEqual(await make({ alive: false }).r.nodeRunning({ dataDir: 'C:\\data' }), { running: false, pid: null });
    assert.deepStrictEqual(await make({ cmdline: 'notepad.exe' }).r.nodeRunning({ dataDir: 'C:\\data' }), { running: false, pid: 4242, other: true });
    assert.deepStrictEqual(await make({ cmdline: 'node king-louie-service.js relay run' }).r.nodeRunning({ dataDir: 'C:\\data' }), { running: false, pid: 4242, other: true });
    assert.deepStrictEqual(await make({ cmdline: null }).r.nodeRunning({ dataDir: 'C:\\data' }), { running: false, pid: 4242, other: true });
  });
});

describe('runCli (§6.3, C-9: the app\'s own binary as Node)', () => {
  it('runs process.execPath with ELECTRON_RUN_AS_NODE=1 and the app\'s entry, args as an array, stdin ignored, no shell', async () => {
    const spawn = fakeSpawn(exits(0, 'Paired.\n{"ok":true,"nodeId":"n-1","port":18796,"bridgeTurnedOn":true,"hosting":"personal"}\n'));
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn, execPath: 'C:\\app\\King Louie.exe', entryPath: 'C:\\app\\bin\\king-louie-service.js' });
    const out = await r.runCli(['desktop', 'pair', 'klpair1.x', '--yes', '--json', '--data-dir', 'C:\\data']);
    assert.strictEqual(out.code, 0);
    assert.deepStrictEqual(out.json, { ok: true, nodeId: 'n-1', port: 18796, bridgeTurnedOn: true, hosting: 'personal' });
    assert.match(out.stdout, /^Paired\./);
    const call = spawn.calls[0];
    assert.strictEqual(call.file, 'C:\\app\\King Louie.exe');
    assert.deepStrictEqual(call.args, ['C:\\app\\bin\\king-louie-service.js', 'desktop', 'pair', 'klpair1.x', '--yes', '--json', '--data-dir', 'C:\\data']);
    assert.strictEqual(call.opts.env.ELECTRON_RUN_AS_NODE, '1');
    assert.strictEqual(call.opts.env.FOO, 'bar');
    assert.strictEqual(call.opts.env.SystemRoot, 'C:\\Windows');
    assert.strictEqual(call.opts.stdio[0], 'ignore');
    assert.ok(!call.opts.shell);
    assert.strictEqual(call.opts.windowsHide, true);
  });

  it('defaults to this process and the repository\'s own entry script', async () => {
    const spawn = fakeSpawn(exits(0));
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn });
    await r.runCli(['stop']);
    assert.strictEqual(spawn.calls[0].file, process.execPath);
    assert.strictEqual(spawn.calls[0].args[0], path.resolve(__dirname, '..', 'bin', 'king-louie-service.js'));
  });

  it('gives json: null when the last line is not JSON, and keeps stderr', async () => {
    const spawn = fakeSpawn(exits(1, 'some text\n', 'it broke\nbadly\n'));
    const out = await createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn }).runCli(['x']);
    assert.deepStrictEqual({ code: out.code, json: out.json, stderr: out.stderr }, { code: 1, json: null, stderr: 'it broke\nbadly\n' });
  });

  it('kills the child at the timeout and says so', async () => {
    const spawn = fakeSpawn(() => {});
    const out = await createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn }).runCli(['desktop', 'pair'], { timeoutMs: 20 });
    assert.strictEqual(out.timedOut, true);
    assert.strictEqual(out.code, null);
    assert.strictEqual(spawn.calls[0].child.killed, true);
  });

  it('resolves, never throws, when the binary cannot be spawned', async () => {
    const spawn = fakeSpawn((child) => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    const out = await createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn }).runCli(['x']);
    assert.strictEqual(out.code, null);
    assert.match(out.error, /ENOENT/);
  });
});

describe('runTask and restartNode (§7.1: /Run; restart is stop then /Run, never /End)', () => {
  it('runs the task by name and says when', async () => {
    const execFile = fakeExecFile(() => ({ stdout: 'SUCCESS' }));
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, execFile, now: () => 1000 });
    assert.deepStrictEqual(await r.runTask(), { ok: true, ranAt: 1000 });
    assert.strictEqual(execFile.calls[0].file, SCHTASKS);
    assert.deepStrictEqual(execFile.calls[0].args, ['/Run', '/TN', 'KingLouie Node']);
  });

  it('reports a failed /Run with schtasks\'s first line through shown', async () => {
    const execFile = fakeExecFile(() => ({ err: exitError(1), stderr: 'ERROR: The system cannot find the file specified.\u202e\r\nmore\r\n' }));
    const out = await createPersonalNodeRunner({ platform: 'win32', env: ENV, execFile }).runTask();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'NODE_TASK_RUN_FAILED');
    assert.strictEqual(out.message, 'ERROR: The system cannot find the file specified. [hidden or control characters removed]');
  });

  it('stops with the CLI\'s stop on the data dir and runs nothing else (the controller checks the task and runs it)', async () => {
    const order = [];
    const spawn = fakeSpawn((child, args) => { order.push(['cli', ...args.slice(1)]); exits(0, 'stopped\n')(child); });
    const execFile = fakeExecFile((file, args) => { order.push(['schtasks', ...args]); return { stdout: 'SUCCESS' }; });
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn, execFile, now: () => 5 });
    assert.strictEqual(r.restartNode, undefined, 'no restart that runs the task without the task check');
    assert.deepStrictEqual(await r.stopNode({ dataDir: 'C:\\data' }), { ok: true });
    assert.deepStrictEqual(order, [['cli', 'stop', '--data-dir', 'C:\\data']]);
  });

  it('a stop that failed is NODE_STOP_FAILED with its first line', async () => {
    const spawn = fakeSpawn(exits(1, '', 'The node did not stop within 30 s.\n'));
    const execFile = fakeExecFile(() => ({ stdout: 'SUCCESS' }));
    const out = await createPersonalNodeRunner({ platform: 'win32', env: ENV, spawn, execFile }).stopNode({ dataDir: 'C:\\data' });
    assert.deepStrictEqual(out, { ok: false, code: 'NODE_STOP_FAILED', message: 'The node did not stop within 30 s.' });
    assert.strictEqual(execFile.calls.length, 0);
  });
});

describe('startFailureSince (§7.1: the node\'s own log)', () => {
  const LOG = [
    '2026-10-28T10:00:00.000Z ERROR [service] service failed to start: an old failure',
    '2026-10-28T10:05:01.000Z INFO [service] starting',
    '2026-10-28T10:05:02.000Z ERROR [service] service failed to start: port 18796 is in use\u202e',
    '2026-10-28T10:05:03.000Z ERROR [service] service failed to start: the newest',
    'not a log line',
    ''
  ].join('\n');

  it('takes the newest failure line written after the time, through shown', async () => {
    const seen = [];
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, readFile: async (file) => { seen.push(file); return LOG; } });
    const out = await r.startFailureSince(Date.parse('2026-10-28T10:05:00Z'), { dataDir: 'C:\\data' });
    assert.deepStrictEqual(out, { at: Date.parse('2026-10-28T10:05:03.000Z'), line: 'service failed to start: the newest' });
    assert.deepStrictEqual(seen, [path.join('C:\\data', 'logs', 'service.log')]);
    const marked = await createPersonalNodeRunner({ platform: 'win32', env: ENV, readFile: async () => LOG.split('\n').slice(0, 3).join('\n') })
      .startFailureSince(new Date('2026-10-28T10:05:00Z'), { dataDir: 'C:\\data' });
    assert.strictEqual(marked.line, 'service failed to start: port 18796 is in use [hidden or control characters removed]');
  });

  it('is null when nothing failed after the time, or the log cannot be read', async () => {
    const r = createPersonalNodeRunner({ platform: 'win32', env: ENV, readFile: async () => LOG });
    assert.strictEqual(await r.startFailureSince(Date.parse('2026-10-28T11:00:00Z'), { dataDir: 'C:\\data' }), null);
    const gone = createPersonalNodeRunner({ platform: 'win32', env: ENV, readFile: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
    assert.strictEqual(await gone.startFailureSince(0, { dataDir: 'C:\\data' }), null);
  });
});
