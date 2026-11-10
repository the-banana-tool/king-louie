const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { isNodeServiceLaunch, runNodeService } = require('../src/desktop-bridge/node-launcher');

const ARGV = ['K.exe', '--kl-node-service', 'C:\e.js', 'run', '--data-dir', 'C:\d', '--screen-host', 'app'];

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
    assert.deepStrictEqual(f.calls[0].args, ['C:\e.js', 'run', '--data-dir', 'C:\d', '--screen-host', 'app']);
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

  it('forwards SIGTERM/SIGINT to the child', async () => {
    const f = fakeSpawn();
    const p = runNodeService({ argv: ARGV, execPath: 'K.exe', env: {}, spawn: f.spawn });
    process.emit('SIGTERM');
    process.emit('SIGINT');
    assert.deepStrictEqual(f.child.killed, ['SIGTERM', 'SIGINT']);
    f.child.emit('exit', 0);
    await p;
    assert.strictEqual(process.listenerCount('SIGTERM') >= 0, true);
  });

  it('main.js checks isNodeServiceLaunch before requiring electron and before the single-instance claim', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const g = src.indexOf('isNodeServiceLaunch');
    assert.ok(g >= 0);
    assert.ok(g < src.indexOf("require('electron')"));
    assert.ok(g < src.indexOf('claimSingleInstance'));
  });
});
