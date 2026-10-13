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

  // Third security review, hardening (a): a worker's stderr can quote what
  // it was sent (a PowerShell error record shows the line that failed), and
  // an input op is sent the text to type.
  it('a stderr line of a worker that has typed text is logged by its length, never its text, at any level', async () => {
    const lines = [];
    const log = { debug: (m, meta) => lines.push(['debug', m, meta]), info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]), trace: (m) => lines.push(['trace', m]) };
    let child;
    const fake = fakeSpawn((req) => ({ id: req.id, ok: true, result: null }));
    const spawnImpl = (...a) => { child = fake.spawnImpl(...a); return child; };
    const w = new LineWorker({ file: 'x', args: [], spawnImpl, log, name: 'windows-worker' });
    await w.call('foreground');
    child.stderr.write('Add-Type : cannot load\n');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lines.map((l) => l[1]), ['windows-worker: Add-Type : cannot load'], 'before any input a line is diagnostics');
    lines.length = 0;
    const typed = 'Lakeside lot gate code 4417';
    const first = `SendInput failed at line 12: ... ${typed} ...`;
    await w.call('input', { action: { kind: 'type', text: typed } });
    child.stderr.write(`${first}\n`);
    // And one that arrives after a later op that types nothing.
    await w.call('foreground');
    child.stderr.write(`late: ${typed}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.length, 2);
    for (const [level, message, meta] of lines) {
      assert.equal(level, 'debug');
      assert.ok(!JSON.stringify([message, meta]).includes('Lakeside') && !JSON.stringify([message, meta]).includes('4417'), message);
    }
    assert.deepEqual(lines.map((l) => l[1]), [
      `windows-worker: worker_stderr (${first.length} characters, not shown)`,
      `windows-worker: worker_stderr (${`late: ${typed}`.length} characters, not shown)`
    ]);
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

  it('a call that times out kills the hung worker; the next call gets a fresh one', async () => {
    const { children, spawnImpl } = manualSpawn();
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    const hung = w.call('screenshot', {}, { timeoutMs: 30 });
    const queued = w.call('foreground', {}, { timeoutMs: 5000 });
    queued.catch(() => {});
    await assert.rejects(hung, (e) => e.code === 'op_timeout');
    assert.equal(children[0].killed, 1, 'the worker that did not answer is killed');
    // What waited behind the hung op on the same worker fails now, not at its own timeout.
    await assert.rejects(queued, (e) => e.code === 'backend_failed');
    const next = w.call('foreground');
    await tick();
    assert.equal(children.length, 2, 'a fresh worker');
    children[1].reply({ ok: 1 });
    assert.deepEqual(await next, { ok: 1 });
    // The killed worker's exit arrives late and changes nothing.
    children[0].emit('exit', null);
    const after = w.call('foreground');
    await tick();
    assert.equal(children.length, 2);
    children[1].reply({ ok: 2 });
    assert.deepEqual(await after, { ok: 2 });
    await w.stop();
  });

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

// Security review finding 8. The Windows and macOS workers' input paths
// cannot be exercised by a test (they inject into the real desktop), so
// these read the sources: they show the rule is written, not that it works.
describe('finding 8, by reading the worker sources: the window under the point is the screenshot\'s own', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'session', 'backends', name), 'utf8');

  it('Windows: the root window under each point must be the target handle itself', () => {
    const src = read('windows-worker.ps1');
    assert.match(src, /IntPtr under = Native\.GetAncestor\(Native\.WindowFromPoint\(pt\), 2\);\s*\r?\n\s*if \(under == IntPtr\.Zero \|\| under != target\) throw new OpError\("point_obscured"/);
    assert.doesNotMatch(src, /under == IntPtr\.Zero \|\| !pids\.Contains\(\(int\)AppPidOf\(under\)\)/, 'no longer "any window of a leased pid"');
  });

  // Second review finding 4, by reading: the window list holds owned windows
  // too (dialogs, menus, dropdown lists), the hit test is unchanged, and a
  // refusal says which window covers the point.
  it('Windows: the window list includes owned windows and marks them; an obscured point names what covers it', () => {
    const src = read('windows-worker.ps1');
    const list = /static object Windows\(List<int> pids\) \{[\s\S]*?\n    \}/.exec(src);
    assert.ok(list, 'Windows() is there');
    assert.match(list[0], /foreach \(var h in VisibleWindows\(\)\)/);
    assert.doesNotMatch(list[0], /TopWindows\(\)/, 'not the unowned-only list');
    assert.match(list[0], /\{ "owned", Native\.GetWindow\(h, 4\) != IntPtr\.Zero \}/);
    const visible = /static List<IntPtr> VisibleWindows\(\) \{[\s\S]*?\n    \}/.exec(src);
    assert.ok(visible);
    assert.match(visible[0], /if \(Native\.IsWindowVisible\(h\)\) l\.Add\(h\);/);
    assert.doesNotMatch(visible[0], /GetWindow\(h, 4\)/, 'no owner filter');
    // Close still asks only the app's main windows to close.
    assert.match(src, /foreach \(var h in TopWindows\(\)\) if \(AppPidOf\(h\) == \(uint\)pid\) \{ Native\.PostMessage\(h, 0x0010/);
    assert.match(src, /throw new OpError\("point_obscured", "another window covers that point", Covering\(fg, under\)\);/);
    assert.match(src, /d\["covering"\] = new Dictionary<string, object> \{ \{ "handle", under\.ToInt64\(\)\.ToString\(\) \}, \{ "pid", \(int\)AppPidOf\(under\) \} \};/);
  });

  // Security review finding 7 (macOS, by reading only): the hit test looks
  // at every on-screen layer, not only the normal window layer.
  it('macOS: the hit test reads all on-screen layers, front to back, skipping only fully transparent windows', () => {
    const src = read('macos-worker.js');
    const hit = /function hitTest\(p\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(hit, 'hitTest is there');
    assert.match(hit[0], /onscreenWindows\(\)/);
    assert.doesNotMatch(hit[0], /windowList\(/, 'not the layer-0 list');
    const all = /function onscreenWindows\(\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(all);
    assert.doesNotMatch(all[0], /kCGWindowLayer/, 'no layer is left out');
    assert.match(all[0], /kCGWindowAlpha/);
  });

  it('macOS: the window under each point must be the target window number itself', () => {
    const src = read('macos-worker.js');
    assert.match(src, /if \(!under \|\| under\.handle !== String\(action\.handle\)\) throw new OpError\('point_obscured'/);
    assert.doesNotMatch(src, /if \(!under \|\| pids\.indexOf\(under\.pid\) < 0\) throw new OpError\('point_obscured'/);
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

  // Second review finding 4: the list is every visible top-level window of
  // the given processes, owned ones included, each marked. Read-only: this
  // looks at the window in front and injects nothing.
  it('lists the windows of the foreground window\'s process, each marked owned or not, the foreground one among them', async () => {
    assert.deepEqual(await backend.windows({ pids: [] }), []);
    const fg = await backend.foreground();
    if (!fg || !fg.bounds || !Number.isInteger(fg.pid)) return;
    const list = await backend.windows({ pids: [fg.pid] });
    assert.ok(list.length >= 1);
    for (const w of list) {
      assert.equal(typeof w.owned, 'boolean');
      assert.equal(w.pid, fg.pid);
      assert.ok(w.bounds.w > 0 && w.bounds.h > 0, 'no empty window');
    }
    // (Only when the same window is still in front: someone may be using this desktop.)
    const still = await backend.foreground();
    if (still && still.handle === fg.handle) assert.ok(list.some((w) => w.handle === fg.handle), 'the foreground window is listed, owned or not');
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
