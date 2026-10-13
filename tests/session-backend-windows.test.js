// tests/session-backend-windows.test.js
//
// The real PowerShell/C# worker, on Windows only. Nothing here injects
// input: the input call is made to fail its checks before injection.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { LineWorker } = require('../src/session/backends/line-worker');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const WIN = process.platform === 'win32';

describe('LineWorker (any OS, with a fake child)', () => {
  function fakeSpawn(reply) {
    const calls = [];
    const spawnImpl = (file, args, opts) => {
      calls.push({ file, args, opts });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('exit', 0);
      child.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          child.stdout.write(`${JSON.stringify(reply(req))}\n`);
        }
      });
      return child;
    };
    return { calls, spawnImpl };
  }

  it('correlates replies by id, maps errors, spawns argv-only and hidden', async () => {
    const { calls, spawnImpl } = fakeSpawn((req) => (req.op === 'boom'
      ? { id: req.id, ok: false, error: { code: 'point_obscured', message: 'x', detail: { pid: 3 } } }
      : { id: req.id, ok: true, result: { op: req.op, params: req.params } }));
    const w = new LineWorker({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-File', 'w.ps1'], spawnImpl });
    assert.deepEqual(await w.call('foreground'), { op: 'foreground', params: {} });
    await assert.rejects(w.call('boom'), (e) => e.code === 'point_obscured' && e.info.pid === 3);
    assert.equal(calls.length, 1, 'one worker for many calls');
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.windowsHide, true);
    await w.stop();
  });

  it('a reply with U+2028 or U+2029 inside a string is still one line', async () => {
    // JSON.stringify leaves both raw; node:readline would end the line at each.
    const { spawnImpl } = fakeSpawn((req) => ({ id: req.id, ok: true, result: { title: 'a b c' } }));
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    assert.deepEqual(await w.call('windows', {}, { timeoutMs: 500 }), { title: 'a b c' });
    await w.stop();
  });

  it('a worker that dies fails what is in flight and restarts on the next call', async () => {
    let child;
    const spawnImpl = () => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      return child;
    };
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    const pending = w.call('foreground');
    child.emit('exit', 1);
    await assert.rejects(pending, (e) => e.code === 'backend_failed');
    const again = w.call('foreground', {}, { timeoutMs: 50 });
    await assert.rejects(again, (e) => e.code === 'op_timeout');
  });

  // A child that can be told to reply, exit or fail by hand.
  function manualSpawn() {
    const children = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = 0;
      child.kill = () => { child.killed += 1; };
      child.requests = [];
      child.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) child.requests.push(JSON.parse(line));
      });
      child.reply = (result) => child.stdout.write(`${JSON.stringify({ id: child.requests.at(-1).id, ok: true, result })}\n`);
      children.push(child);
      return child;
    };
    return { children, spawnImpl };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  for (const event of ['exit', 'error']) {
    it(`a late "${event}" of an old worker does not fail the calls of its replacement`, async () => {
      const { children, spawnImpl } = manualSpawn();
      const w = new LineWorker({ file: 'x', args: [], spawnImpl });
      const first = w.call('foreground');
      await tick();
      await w.stop(); // the old worker is told to go; its exit comes later
      await assert.rejects(first, (e) => e.code === 'backend_failed', 'a stopped worker fails what it had in flight');
      let settled = null;
      const second = w.call('foreground').then((v) => { settled = { ok: v }; return v; }, (e) => { settled = { error: e }; throw e; });
      await tick();
      assert.equal(children.length, 2, 'the next call started a new worker');
      children[0].emit(event, event === 'exit' ? 0 : new Error('late'));
      await tick();
      assert.equal(settled, null, 'the replacement\'s call is still in flight');
      // And the replacement is still the worker: no third child is spawned.
      children[1].reply({ from: 'second' });
      assert.deepEqual(await second, { from: 'second' });
      const third = w.call('foreground');
      await tick();
      assert.equal(children.length, 2);
      children[1].reply({ from: 'second again' });
      assert.deepEqual(await third, { from: 'second again' });
      await w.stop();
    });
  }

  it('a late reply of an old worker settles nothing of its replacement', async () => {
    const { children, spawnImpl } = manualSpawn();
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    const first = w.call('foreground');
    first.catch(() => {});
    await tick();
    await w.stop();
    const second = w.call('foreground');
    await tick();
    // The old worker answers with the id the new call happens to have.
    children[0].stdout.write(`${JSON.stringify({ id: children[1].requests[0].id, ok: true, result: { from: 'old' } })}\n`);
    await tick();
    children[1].reply({ from: 'new' });
    assert.deepEqual(await second, { from: 'new' });
    await w.stop();
  });
});

describe('the Windows worker script (any OS)', () => {
  it('is ASCII only', () => {
    // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page,
    // so a byte above 0x7F would be decoded differently from machine to machine.
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'src', 'session', 'backends', 'windows-worker.ps1'));
    assert.equal(bytes.findIndex((b) => b > 0x7f), -1);
  });
});

describe('Windows worker', { skip: !WIN }, () => {
  const { createWindowsBackend } = require('../src/session/backends/windows');
  const backend = WIN ? createWindowsBackend({}) : null;
  after(() => backend && backend.stop());

  it('probes itself', async () => {
    const r = await backend.probe();
    assert.ok(Array.isArray(r.capabilities));
    assert.ok(r.capabilities.every((c) => ['gui.launch', 'gui.screenshot', 'gui.input'].includes(c)));
    assert.ok(r.probes.every((p) => typeof p.check === 'string' && typeof p.ok === 'boolean'));
    assert.ok(Array.isArray(r.displays));
    assert.deepEqual(r.limits, []);
    assert.equal(typeof r.locked, 'boolean');
  });

  it('finds this node process by a bare image name', async () => {
    const found = await backend.processes({ match: ['node.exe'] });
    assert.ok(found.some((p) => p.pid === process.pid && /node\.exe$/i.test(p.image)));
  });

  it('reads the foreground window and hit-tests its centre', async () => {
    const fg = await backend.foreground();
    if (!fg || !fg.bounds) return;
    assert.equal(typeof fg.image, 'string');
    const hit = await backend.hitTest({ x: fg.bounds.x + Math.floor(fg.bounds.w / 2), y: fg.bounds.y + Math.floor(fg.bounds.h / 2) });
    assert.ok(hit === null || Number.isInteger(hit.pid));
  });

  it('refuses before injecting when the foreground is not leased', async () => {
    await assert.rejects(
      backend.input({ expect: { match: ['kl-no-such-app.exe'], pids: [0] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 }),
      (e) => e.code === 'foreground_mismatch' || e.code === 'screen_locked'
    );
  });

  it('a window that is gone is stale_screenshot', async () => {
    await assert.rejects(backend.screenshot({ handle: '1', maxWidth: 320, quality: 50 }), (e) => e.code === 'stale_screenshot');
  });

  it('launch refuses anything but an .exe', async () => {
    await assert.rejects(backend.launch({ exe: 'C:\\Windows\\System32\\cmd.bat', argv: [], files: [] }), (e) => e.code === 'app_type_not_supported');
  });
});
