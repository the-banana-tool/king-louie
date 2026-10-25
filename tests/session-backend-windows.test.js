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

// Demo takes (Task 9): the browser, recording and keep-awake ops of the
// Windows backend, with a fake spawn, file reads and clock. Nothing real runs.
describe('Windows backend: launch_browser, record_start, record_stop (any OS, faked)', () => {
  const { createWindowsBackend } = require('../src/session/backends/windows');
  const LOCALAPPDATA = 'C:\\Users\\alice\\AppData\\Local';
  const ROOT = path.win32.join(LOCALAPPDATA, 'KingLouie', 'browser-profiles');

  // A clock that moves when a timer fires, by that timer's delay.
  function fakeTime() {
    const t = { now: 1_000_000 };
    t.clock = () => t.now;
    t.timers = {
      setTimeout: (fn, ms) => {
        const h = { cancelled: false };
        setImmediate(() => { if (h.cancelled) return; t.now += ms; fn(); });
        return h;
      },
      clearTimeout: (h) => { if (h) h.cancelled = true; }
    };
    return t;
  }

  function fakeChild({ onQ = 'exit' } = {}) {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = 0;
    child.kill = () => { child.killed += 1; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
    child.unref = () => {};
    child.written = [];
    child.stdin = { write: (s) => { child.written.push(s); if (s === 'q\n' && onQ === 'exit') child.emit('exit', 0, null); return true; }, end: () => {}, on: () => {} };
    child.stderr = new PassThrough();
    return child;
  }

  function spawnRecorder(childOpts) {
    const calls = [];
    const spawnImpl = (file, args, opts) => {
      const child = fakeChild(childOpts);
      calls.push({ file, args, opts, child });
      setImmediate(() => child.emit('spawn'));
      return child;
    };
    return { calls, spawnImpl };
  }

  const enoent = () => Object.assign(new Error('nope'), { code: 'ENOENT' });

  const TAKE = 'take-0123456789ab';
  // Every backend here gets a fake mkdir and unlink: nothing touches C:.
  function make(opts = {}) {
    const mkdirs = [];
    const backend = createWindowsBackend({
      env: { LOCALAPPDATA }, unlink: async () => {}, mkdir: async (p, o) => { mkdirs.push([p, o]); }, ...opts
    });
    backend.mkdirs = mkdirs;
    return backend;
  }

  it('launch_browser spawns chrome with a zero debugging port and reads DevToolsActivePort', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    let reads = 0;
    const readFile = async (p) => {
      assert.equal(p, path.win32.join(ROOT, 'demo', 'DevToolsActivePort'));
      reads += 1;
      if (reads <= 2) throw enoent();
      return '9222\n/devtools/browser/abc\n';
    };
    const backend = make({ spawnImpl, readFile, clock: t.clock, timers: t.timers });
    const profileDir = path.win32.join(ROOT, 'demo');
    const r = await backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo', args: ['--window-size=1280,800'] });
    assert.deepEqual(r, { pid: 4242, cdp: { port: 9222, path: '/devtools/browser/abc' } });
    assert.deepEqual(backend.mkdirs, [[profileDir, { recursive: true }]], 'the profile is created under the user\'s root');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'C:\\x\\chrome.exe');
    assert.deepEqual(calls[0].args, [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--window-size=1280,800']);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(reads, 3);
  });

  it('launch_browser removes a stale DevToolsActivePort before it spawns', async () => {
    const t = fakeTime();
    const order = [];
    const { spawnImpl } = spawnRecorder();
    const backend = make({
      clock: t.clock, timers: t.timers,
      spawnImpl: (...a) => { order.push('spawn'); return spawnImpl(...a); },
      unlink: async (p) => { order.push(`unlink ${p}`); throw enoent(); },
      readFile: async () => '9222\n/devtools/browser/abc'
    });
    await backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo' });
    assert.deepEqual(order, [`unlink ${path.win32.join(ROOT, 'demo', 'DevToolsActivePort')}`, 'spawn']);
  });

  it('launch_browser takes a profile name only', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, readFile: async () => '1\n/devtools/browser/x', clock: t.clock, timers: t.timers });
    for (const profile of ['', '..', '.', 'a/b', 'a\\b', 'C:\\x', 'demo.', 'demo ', 'a:b', 'x'.repeat(65), null, undefined, 7]) {
      await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile }), (e) => e.code === 'invalid_params' && e.message === 'invalid_params', String(profile));
    }
    const noEnv = make({ env: {}, spawnImpl, clock: t.clock, timers: t.timers });
    await assert.rejects(noEnv.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo' }), (e) => e.code === 'invalid_params');
    assert.equal(calls.length, 0, 'spawn never called');
    assert.deepEqual(backend.mkdirs, [], 'nothing created');
    const ok = await backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'Demo_2-x' });
    assert.equal(ok.cdp.port, 1);
  });

  // Review I-1: Chromium keeps the last of a repeated switch, so args could
  // move the profile or the debugging endpoint the helper fixed.
  it('launch_browser refuses args that would move the profile or the debugging endpoint', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, readFile: async () => '1\n/devtools/browser/x', clock: t.clock, timers: t.timers });
    for (const arg of [
      '--user-data-dir=C:\\anywhere', '--USER-DATA-DIR=C:\\anywhere', '-user-data-dir=C:\\x', '--user-data-dir',
      '--profile-directory=Default', '--remote-debugging-port=9222', '--Remote-Debugging-Port=9222',
      '--remote-debugging-address=0.0.0.0', '--remote-debugging-pipe',
      // Every form Chromium reads as a switch (it trims; Windows takes '/').
      '/user-data-dir=C:\\x', ' --user-data-dir=x', '\t-profile-directory=x ', '/Remote-Debugging-Port=1',
      '--REMOTE-DEBUGGING-PORT=9222', '--remote-debugging-io-pipes', '--remote-debugging-targets=x'
    ]) {
      await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo', args: ['--window-size=1280,800', arg] }),
        (e) => e.code === 'invalid_params' && e.message === 'invalid_params', arg);
    }
    await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo', args: [3] }), (e) => e.code === 'invalid_params');
    assert.equal(calls.length, 0, 'nothing spawned');
    // Another switch, even one that starts like a reserved one, and a non-switch argument pass.
    await backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo', args: ['--user-data-dir-x=1', '--window-size=1280,800', 'https://example.com/'] });
    assert.equal(calls.length, 1);
  });

  it('launch_browser refuses anything but an .exe', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, clock: t.clock, timers: t.timers });
    await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.bat', profile: 'demo' }), (e) => e.code === 'app_type_not_supported');
    assert.equal(calls.length, 0);
  });

  it('launch_browser kills and fails when the port file never appears', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    let reads = 0;
    const backend = make({ spawnImpl, readFile: async () => { reads += 1; if (reads === 5) return '9222\n'; throw enoent(); }, clock: t.clock, timers: t.timers });
    const start = t.now;
    await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo' }),
      (e) => e.code === 'browser_launch_failed' && e.message === 'browser_launch_failed');
    assert.equal(calls[0].child.killed, 1, 'kill called');
    assert.ok(t.now - start >= 10000, 'waited the whole 10 s');
    assert.ok(t.now - start < 10400);
    assert.ok(reads >= 49 && reads <= 52, `polled every 200 ms (${reads} reads)`);
  });

  it('launch_browser fails with its code alone when the exe cannot start', async () => {
    const t = fakeTime();
    const spawnImpl = () => {
      const child = fakeChild();
      setImmediate(() => child.emit('error', new Error('spawn C:\\x\\chrome.exe ENOENT')));
      return child;
    };
    const backend = make({ spawnImpl, clock: t.clock, timers: t.timers });
    await assert.rejects(backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profile: 'demo' }),
      (e) => e.code === 'browser_launch_failed' && !e.message.includes('chrome'));
  });

  it('record_start builds the ffmpeg argv, into the user\'s recordings by default', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, clock: t.clock, timers: t.timers });
    const dir = path.win32.join(LOCALAPPDATA, 'KingLouie', 'recordings', TAKE);
    const out = path.win32.join(dir, 'take.mp4');
    const r = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE });
    assert.deepEqual(r, { pid: 4242, startedAt: t.now, path: out });
    assert.deepEqual(backend.mkdirs, [[dir, { recursive: true }]]);
    assert.equal(calls[0].file, 'C:\\ff\\ffmpeg.exe');
    assert.deepEqual(calls[0].args, ['-y', '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
    assert.deepEqual(calls[0].opts.stdio, ['pipe', 'ignore', 'pipe']);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.shell, false);
    assert.ok(backend.recordings.has(4242));
    // A size scales; a given path is used as it is, and its directory is created.
    backend.recordings.clear(); // the fake children share a pid
    const given = 'D:\\work\\demo\\take.mp4';
    const r2 = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: given, fps: 24, size: { width: 1280, height: 720 } });
    assert.equal(r2.path, given);
    assert.deepEqual(backend.mkdirs[1], ['D:\\work\\demo', { recursive: true }]);
    assert.deepEqual(calls[1].args.slice(0, 9), ['-y', '-f', 'gdigrab', '-framerate', '24', '-i', 'desktop', '-vf', 'scale=1280:720']);
    assert.equal(calls[1].args.at(-1), given);
  });

  it('record_start refuses bad parameters before spawning; no ffmpeg is recorder_missing', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, clock: t.clock, timers: t.timers });
    const ok = { ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE };
    for (const bad of [
      { ...ok, ffmpeg: 'C:\\ff\\ffmpeg.cmd' },
      { ...ok, takeId: undefined }, { ...ok, takeId: 'take-0123' }, { ...ok, takeId: 'take-0123456789AB' }, { ...ok, takeId: '..\\take-0123456789ab' },
      { ...ok, path: 'take.mp4' }, { ...ok, path: 7 },
      { ...ok, fps: 0 }, { ...ok, fps: 121 }, { ...ok, fps: 2.5 },
      { ...ok, size: { width: 0, height: 720 } }, { ...ok, size: { width: 'x', height: 720 } }, { ...ok, size: { width: 1281, height: 720 } }
    ]) {
      await assert.rejects(backend.recordStart(bad), (e) => (e.code === 'invalid_params' || e.code === 'app_type_not_supported') && e.message === e.code, JSON.stringify(bad));
    }
    for (const ffmpeg of [null, undefined, '']) {
      await assert.rejects(backend.recordStart({ ...ok, ffmpeg }), (e) => e.code === 'recorder_missing');
    }
    const noEnv = make({ env: {}, spawnImpl, clock: t.clock, timers: t.timers });
    await assert.rejects(noEnv.recordStart(ok), (e) => e.code === 'invalid_params');
    assert.equal(calls.length, 0);
    assert.deepEqual(backend.mkdirs, []);
  });

  it('record_stop sends q and reports bytes; a dead ffmpeg reports exited', async () => {
    const t = fakeTime();
    let next = 500;
    const children = [];
    const spawnImpl = () => { const c = fakeChild(); c.pid = next++; children.push(c); setImmediate(() => c.emit('spawn')); return c; };
    const sizes = { 'C:\\r\\a.mp4': 1234 };
    const statSync = (p) => { if (!(p in sizes)) throw enoent(); return { size: sizes[p] }; };
    const backend = make({ spawnImpl, statSync, clock: t.clock, timers: t.timers });
    const { pid } = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    t.now += 12_500;
    const r = await backend.recordStop({ pid });
    assert.deepEqual(children[0].written, ['q\n']);
    assert.deepEqual(r, { path: 'C:\\r\\a.mp4', durationS: 12.5, bytes: 1234, truncated: false });
    assert.equal(children[0].killed, 0);
    assert.equal(backend.recordings.has(pid), false, 'forgotten once stopped');
    await assert.rejects(backend.recordStop({ pid }), (e) => e.code === 'unknown_recording');

    // An ffmpeg that died on its own: remembered, reported, not asked again.
    const second = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\b.mp4' });
    t.now += 3000;
    children[1].emit('exit', 1, null);
    assert.deepEqual(backend.recordings.get(second.pid).exited, true);
    t.now += 7000;
    const dead = await backend.recordStop({ pid: second.pid });
    assert.deepEqual(dead, { path: 'C:\\r\\b.mp4', durationS: 3, bytes: 0, truncated: true, exited: true, code: 1 });
    assert.deepEqual(children[1].written, [], 'no q to a dead ffmpeg');
  });

  // Final review, minor 6: a record_start whose answer the service never got is stopped by take id.
  it('record_stop { take_id } stops that take\'s recording; one still starting is stopped once it has; anything else is unknown_recording', async () => {
    const t = fakeTime();
    let next = 600;
    const children = [];
    let holdSpawn = null;
    const spawnImpl = () => {
      const c = fakeChild();
      c.pid = next++;
      children.push(c);
      if (holdSpawn) holdSpawn.then(() => c.emit('spawn'));
      else setImmediate(() => c.emit('spawn'));
      return c;
    };
    const backend = make({ spawnImpl, statSync: () => ({ size: 5 }), clock: t.clock, timers: t.timers });
    await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    const r = await backend.recordStop({ takeId: TAKE });
    assert.equal(r.path, 'C:\\r\\a.mp4');
    assert.deepEqual(children[0].written, ['q\n']);
    assert.equal(backend.recordings.size, 0);
    for (const bad of [{ takeId: TAKE }, { takeId: 'take-ffffffffffff' }, { takeId: 7 }, {}]) {
      await assert.rejects(backend.recordStop(bad), (e) => e.code === 'unknown_recording', JSON.stringify(bad));
    }
    // The stop arrives while ffmpeg is still starting: it waits for the start, then stops it.
    let release;
    holdSpawn = new Promise((resolve) => { release = resolve; });
    const OTHER = 'take-abcdefabcdef';
    const starting = backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: OTHER, path: 'C:\\r\\b.mp4' });
    const stopping = backend.recordStop({ takeId: OTHER });
    await new Promise((r2) => setImmediate(r2));
    release();
    await starting;
    const r2 = await stopping;
    assert.equal(r2.path, 'C:\\r\\b.mp4');
    assert.deepEqual(children[1].written, ['q\n']);
    assert.equal(backend.recordings.size, 0);
  });

  it('record_start answers recorder_failed, by its code alone, when the directory cannot be made', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder();
    const backend = make({ spawnImpl, clock: t.clock, timers: t.timers, mkdir: async () => { throw Object.assign(new Error('EACCES: D:\\work\\demo'), { code: 'EACCES' }); } });
    for (const extra of [{ path: 'D:\\work\\demo\\take.mp4' }, {}]) {
      await assert.rejects(backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, ...extra }),
        (e) => e.code === 'recorder_failed' && e.message === 'recorder_failed');
    }
    assert.equal(calls.length, 0, 'ffmpeg never started');
  });

  // Review M-3: a pid Windows hands out again finalises the old entry.
  it('a reused pid finalises the old entry before the new one is kept', async () => {
    const t = fakeTime();
    const children = [];
    const spawnImpl = () => { const c = fakeChild(); c.pid = 77; children.push(c); setImmediate(() => c.emit('spawn')); return c; };
    const backend = make({ spawnImpl, statSync: () => ({ size: 1 }), clock: t.clock, timers: t.timers });
    await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    children[0].emit('exit', 0, null);
    await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\b.mp4' });
    assert.equal(backend.recordings.get(77).path, 'C:\\r\\b.mp4');
    assert.equal(backend.recordings.get(77).child, children[1]);
    assert.deepEqual(children[0].written, [], 'the dead one is not sent q');
    const r = await backend.recordStop({ pid: 77 });
    assert.equal(r.path, 'C:\\r\\b.mp4');
  });

  it('record_stop kills an ffmpeg that ignores q after 15 s and reports truncated', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder({ onQ: 'ignore' });
    const backend = make({ spawnImpl, statSync: () => ({ size: 99 }), clock: t.clock, timers: t.timers });
    const { pid } = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    const before = t.now;
    const r = await backend.recordStop({ pid });
    assert.equal(calls[0].child.killed, 1);
    assert.ok(t.now - before >= 15000);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 99);
  });

  it('stopRecordings stops every live recording', async () => {
    const t = fakeTime();
    let next = 100;
    const children = [];
    const spawnImpl = () => { const c = fakeChild(); c.pid = next++; children.push(c); setImmediate(() => c.emit('spawn')); return c; };
    const backend = make({ spawnImpl, statSync: () => ({ size: 1 }), clock: t.clock, timers: t.timers });
    await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\b.mp4' });
    const results = await backend.stopRecordings();
    assert.equal(results.length, 2);
    assert.ok(children.every((c) => c.written.includes('q\n')));
    assert.equal(backend.recordings.size, 0);
    assert.deepEqual(await backend.stopRecordings(), []);
  });

  // Review M-5: the helper ending waits for a stop that is already going.
  it('stopRecordings waits for a stop already under way', async () => {
    const t = fakeTime();
    const { calls, spawnImpl } = spawnRecorder({ onQ: 'ignore' });
    const backend = make({ spawnImpl, statSync: () => ({ size: 1 }), clock: t.clock, timers: t.timers });
    const { pid } = await backend.recordStart({ ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: TAKE, path: 'C:\\r\\a.mp4' });
    let first = null;
    backend.recordStop({ pid }).then((r) => { first = r; });
    assert.equal(backend.recordings.size, 0, 'the stop took it');
    await backend.stopRecordings();
    assert.ok(first, 'the earlier stop had finished when stopRecordings returned');
    assert.equal(first.truncated, true);
    assert.equal(calls[0].child.killed, 1);
  });

  it('the worker has keep_awake over SetThreadExecutionState', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'session', 'backends', 'windows-worker.ps1'), 'utf8');
    assert.match(src, /\[DllImport\("kernel32\.dll"\)\] public static extern uint SetThreadExecutionState\(uint esFlags\);/);
    assert.match(src, /case "keep_awake"/);
    assert.match(src, /0x80000003/);
    assert.match(src, /0x80000000/);
  });

  it('keep_awake goes to the worker', async () => {
    const sent = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          sent.push(req);
          child.stdout.write(`${JSON.stringify({ id: req.id, ok: true, result: { on: req.params.on } })}\n`);
        }
      });
      return child;
    };
    const backend = createWindowsBackend({ env: { LOCALAPPDATA }, spawnImpl });
    assert.deepEqual(await backend.keepAwake({ on: true }), { on: true });
    assert.deepEqual(await backend.keepAwake({ on: false }), { on: false });
    assert.deepEqual(sent.map((r) => [r.op, r.params]), [['keep_awake', { on: true }], ['keep_awake', { on: false }]]);
    await backend.stop();
  });
});

describe('the other backends refuse the take ops', () => {
  const { GuiError } = require('../src/gui/errors');
  const backends = {
    macos: () => require('../src/session/backends/macos').createMacosBackend({ worker: { call: async () => null, stop: async () => {} } }),
    x11: () => require('../src/session/backends/x11').createX11Backend({ env: {} }),
    wayland: () => require('../src/session/backends/wayland').createWaylandBackend({})
  };
  for (const [name, make] of Object.entries(backends)) {
    it(`${name}: capability_unavailable for all four`, async () => {
      const b = make();
      for (const m of ['launchBrowser', 'recordStart', 'recordStop', 'keepAwake']) {
        await assert.rejects(b[m]({}), (e) => e instanceof GuiError && e.code === 'capability_unavailable' && /recording and browser launch are Windows only in D1/.test(e.message), `${name}.${m}`);
      }
      assert.deepEqual(await b.stopRecordings(), []);
    });
  }
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
