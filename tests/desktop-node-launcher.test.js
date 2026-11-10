const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { isNodeServiceLaunch, prepareLauncherApp, runLauncher, runNodeService, LAUNCHER_DIR_NAME } = require('../src/desktop-bridge/node-launcher');

const ARGV = ['K.exe', '--kl-node-service', 'C:\\e.js', 'run', '--data-dir', 'C:\\d', '--screen-host', 'app'];

function fakeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.killed = [];
  child.kill = (s) => { child.killed.push(s); };
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  return { spawn, calls, child };
}

describe('node launcher', () => {
  it('detects the flag', () => {
    assert.strictEqual(isNodeServiceLaunch(ARGV), true);
    assert.strictEqual(isNodeServiceLaunch(['K.exe']), false);
  });

  it('spawns the same binary with ELECTRON_RUN_AS_NODE=1 and the rest of argv', async () => {
    const f = fakeSpawn();
    const p = runNodeService({ argv: ARGV, execPath: 'K.exe', env: { A: 'b' }, spawn: f.spawn });
    f.child.emit('exit', 0);
    await p;
    assert.strictEqual(f.calls[0].cmd, 'K.exe');
    assert.deepStrictEqual(f.calls[0].args, ['C:\\e.js', 'run', '--data-dir', 'C:\\d', '--screen-host', 'app']);
    assert.strictEqual(f.calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
    assert.strictEqual(f.calls[0].opts.env.A, 'b');
    assert.strictEqual(f.calls[0].opts.stdio, 'ignore');
    assert.strictEqual(f.calls[0].opts.windowsHide, true);
  });

  it('resolves the child exit code', async () => {
    const f = fakeSpawn();
    const p = runNodeService({ argv: ARGV, execPath: 'K.exe', env: {}, spawn: f.spawn });
    f.child.emit('exit', 7);
    assert.strictEqual(await p, 7);
  });

  it('resolves 1 when spawn errors', async () => {
    const f = fakeSpawn();
    const p = runNodeService({ argv: ARGV, execPath: 'K.exe', env: {}, spawn: f.spawn });
    f.child.emit('error', new Error('x'));
    assert.strictEqual(await p, 1);
  });

  it('resolves 1 when spawn throws synchronously, and leaves no signal listener', async () => {
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    const spawn = () => { throw new Error('ENOENT'); };
    assert.strictEqual(await runNodeService({ argv: ARGV, execPath: 'K.exe', env: {}, spawn }), 1);
    assert.strictEqual(process.listenerCount('SIGTERM'), term);
    assert.strictEqual(process.listenerCount('SIGINT'), int);
  });

  it('forwards SIGTERM/SIGINT to the child and removes its listeners on exit', async () => {
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    const f = fakeSpawn();
    const p = runNodeService({ argv: ARGV, execPath: 'K.exe', env: {}, spawn: f.spawn });
    process.emit('SIGTERM');
    process.emit('SIGINT');
    assert.deepStrictEqual(f.child.killed, ['SIGTERM', 'SIGINT']);
    f.child.emit('exit', 0);
    await p;
    assert.strictEqual(process.listenerCount('SIGTERM'), term);
    assert.strictEqual(process.listenerCount('SIGINT'), int);
  });

  it('prepareLauncherApp points userData at a temp folder and turns hardware acceleration off', () => {
    const calls = [];
    const app = {
      setPath: (name, dir) => calls.push(['setPath', name, dir]),
      disableHardwareAcceleration: () => calls.push(['disableHardwareAcceleration']),
    };
    const made = [];
    const tmp = path.join('T:', 'tmp');
    const dir = prepareLauncherApp(app, { tmpdir: tmp, mkdir: (d, o) => made.push([d, o]) });
    assert.strictEqual(dir, path.join(tmp, LAUNCHER_DIR_NAME));
    assert.strictEqual(LAUNCHER_DIR_NAME, 'king-louie-node-launcher');
    assert.deepStrictEqual(made, [[dir, { recursive: true }]]);
    assert.deepStrictEqual(calls, [['setPath', 'userData', dir], ['disableHardwareAcceleration']]);
  });

  it('prepareLauncherApp still sets userData when the folder cannot be made', () => {
    const calls = [];
    const app = { setPath: (n, d) => calls.push([n, d]), disableHardwareAcceleration: () => calls.push(['hw']) };
    prepareLauncherApp(app, { tmpdir: 'T', mkdir: () => { throw new Error('EACCES'); } });
    assert.deepStrictEqual(calls, [['userData', path.join('T', LAUNCHER_DIR_NAME)], ['hw']]);
  });

  it('runLauncher sets the temp userData before spawning, then exits with the child\'s code', async () => {
    const order = [];
    const app = {
      setPath: (name) => order.push(`setPath ${name}`),
      disableHardwareAcceleration: () => order.push('disableHardwareAcceleration'),
    };
    const f = fakeSpawn();
    const spawn = (...a) => { order.push('spawn'); return f.spawn(...a); };
    const exits = [];
    const p = runLauncher(app, { argv: ARGV, execPath: 'K.exe', env: {}, spawn, exit: (c) => exits.push(c), prepare: { tmpdir: 'T', mkdir: () => {} } });
    f.child.emit('exit', 3);
    assert.strictEqual(await p, 3);
    assert.deepStrictEqual(order, ['setPath userData', 'disableHardwareAcceleration', 'spawn']);
    assert.deepStrictEqual(exits, [3]);
    assert.strictEqual(f.calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  });

  it('main.js hands the launch to runLauncher before the app\'s electron require and the single-instance claim', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const g = src.indexOf('isNodeServiceLaunch(process.argv)');
    const run = src.indexOf("runLauncher(require('electron').app)");
    const appElectron = src.indexOf("const { app, BrowserWindow");
    assert.ok(g >= 0 && run > g, 'the guard, then the one launcher call');
    assert.ok(/runLauncher\(require\('electron'\)\.app\);\s*return;\s*\}/.test(src), 'the branch returns right after the call');
    assert.ok(appElectron > run, 'before the app\'s own require of electron');
    assert.ok(src.indexOf('claimSingleInstance') > run, 'before the single-instance claim');
  });
});
