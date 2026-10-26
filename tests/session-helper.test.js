// tests/session-helper.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { runSessionHelper, defaultSessionFile, helperLogDir, RECONNECT_DELAYS } = require('../src/session/helper');
const { selectBackend } = require('../src/session/backends');
const { HelperChannel } = require('../src/gui/helper-channel');
const S = require('../src/gui/session-secret');
const { setLogLevel } = require('../src/logging');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const NODE_ID = 'kl-hnef32472qzibi5r';
const USER = os.userInfo().username;

function setup() {
  // Native realpath: writeUserCopy requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-helper-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  const endpoint = POSIX ? path.join(base, 'h.sock') : `\\\\.\\pipe\\kl-helper-test-${crypto.randomBytes(6).toString('hex')}`;
  return { base, configDir, endpoint };
}

function writeCopy({ configDir, endpoint, secret = crypto.randomBytes(32) }) {
  const sid = POSIX ? null : 'S-1-5-21-1-2-3-1001';
  const file = S.writeUserCopy({
    platform: process.platform, configDir, user: USER, uid: UID, gid: GID, sid,
    content: { v: 1, node_id: NODE_ID, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() },
    runIcacls: () => {}
  });
  return { file, secret };
}

function fakeBackend(reports) {
  const calls = [];
  let i = 0;
  let locked = false;
  return {
    calls,
    setLocked(v) { locked = v; },
    probe: async () => { const r = reports[Math.min(i, reports.length - 1)]; i += 1; return r; },
    foreground: async () => { calls.push('foreground'); return { handle: '1', pid: 2, image: '/usr/bin/gedit' }; },
    locked: async () => locked,
    stopRecordings: async () => { calls.push('stopRecordings'); return []; },
    stop: async () => { calls.push('stop'); }
  };
}

const REPORT = { capabilities: ['gui.launch', 'gui.input'], probes: [], displays: [], limits: [], locked: false };

async function channelFor(endpoint, secretRef) {
  const channel = new HelperChannel({ endpoint, readSecret: () => ({ secret: secretRef.secret, nodeId: NODE_ID, sessionUser: USER, mtimeMs: 1 }), pingMs: 60000 });
  await channel.start();
  cleanups.push(() => channel.stop());
  return channel;
}

// checkUserCopyTrust: the Windows owner read is a PowerShell child; these
// tests' files are a temp dir's, owned by whoever runs them.
const quick = { delays: [20, 20, 20], rootUid: UID, attachLog: false, checkUserCopyTrust: async () => {} };

describe('runSessionHelper', () => {
  // Security review finding 3: who owns the helper's file is checked before
  // it is believed, at the start and before every reconnect.
  it('finding 3: a per-user file that fails the owner check is never read: exit 1, no connection', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    let authed = 0;
    channel.on('ready', () => { authed += 1; });
    const { GuiError } = require('../src/gui/errors');
    const checked = [];
    const code = await runSessionHelper({
      sessionFile: file,
      deps: { ...quick, backend: fakeBackend([REPORT]), checkUserCopyTrust: async (o) => { checked.push(o); throw new GuiError('session_file_insecure', 'not owned by an administrator'); } }
    });
    assert.equal(code, 1);
    assert.equal(authed, 0);
    assert.equal(checked.length, 1);
    assert.equal(checked[0].path, file);
    assert.equal(checked[0].platform, process.platform);
  });

  it('finding 3: the owner check runs again before every reconnect, and a file that stopped passing ends the helper', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const { GuiError } = require('../src/gui/errors');
    let checks = 0;
    let swapped = false;
    const done = runSessionHelper({
      sessionFile: file,
      deps: { ...quick, backend: fakeBackend([REPORT]), checkUserCopyTrust: async () => { checks += 1; if (swapped) throw new GuiError('session_file_insecure', 'the file was replaced'); } }
    });
    await once(channel, 'ready');
    assert.equal(checks, 2, 'once at the start, once before the connection');
    swapped = true;
    channel._destroy(channel.current, 'test');
    assert.equal(await done, 1);
    assert.equal(checks, 3);
  });

  it('exits 1 when the per-user file is missing', async () => {
    const { base } = setup();
    assert.equal(await runSessionHelper({ sessionFile: path.join(base, 'nope.json'), deps: { ...quick, backend: fakeBackend([REPORT]) } }), 1);
  });

  it('exits 1 when the per-user file is readable by others', { skip: !POSIX }, async () => {
    const { configDir, endpoint } = setup();
    const { file } = writeCopy({ configDir, endpoint });
    fs.chmodSync(file, 0o644);
    assert.equal(await runSessionHelper({ sessionFile: file, deps: { ...quick, backend: fakeBackend([REPORT]) } }), 1);
  });

  it('connects, serves ops through its backend, and exits 0 on logout', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const backend = fakeBackend([REPORT]);
    const ac = new AbortController();
    const ready = once(channel, 'ready');
    const done = runSessionHelper({ sessionFile: file, signal: ac.signal, deps: { ...quick, backend } });
    const [info] = await ready;
    assert.deepEqual(info.capabilities, REPORT.capabilities);
    assert.equal((await channel.request('foreground', {})).image, '/usr/bin/gedit');
    ac.abort();
    assert.equal(await done, 0);
    assert.ok(backend.calls.includes('stop'));
    // A helper that stops stops its recordings first (demo takes, Task 9).
    assert.ok(backend.calls.indexOf('stopRecordings') >= 0 && backend.calls.indexOf('stopRecordings') < backend.calls.indexOf('stop'));
  });

  it('reconnects after a drop, re-reading its file (a rotated secret)', async () => {
    const { configDir, endpoint } = setup();
    const first = writeCopy({ configDir, endpoint });
    const secretRef = { secret: first.secret };
    const channel = await channelFor(endpoint, secretRef);
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    let ready = once(channel, 'ready');
    runSessionHelper({ sessionFile: first.file, signal: ac.signal, deps: { ...quick, backend: fakeBackend([REPORT]) } });
    await ready;
    const rotated = writeCopy({ configDir, endpoint });
    secretRef.secret = rotated.secret;
    ready = once(channel, 'ready');
    channel.current.socket.destroy();
    await ready;
    assert.equal(channel.connected, true);
  });

  it('re-probes and withdraws a sub-capability that stopped working; reports lock changes', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const backend = fakeBackend([REPORT, { ...REPORT, capabilities: ['gui.launch'] }]);
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const ready = once(channel, 'ready');
    // Listening before the helper starts: the first re-probe comes 30 ms after it connects.
    const changed = new Promise((resolve) => channel.on('event', (kind) => { if (kind === 'probe_changed') resolve(); }));
    runSessionHelper({ sessionFile: file, signal: ac.signal, deps: { ...quick, backend, reprobeMs: 30, lockPollMs: 20 } });
    await ready;
    await changed;
    assert.deepEqual(channel.info.capabilities, ['gui.launch']);
    const locked = new Promise((resolve) => channel.on('event', (kind) => { if (kind === 'locked') resolve(); }));
    backend.setLocked(true);
    await locked;
    assert.equal(channel.info.locked, true);
  });

  it('with no backend it still connects and reports why', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const ready = once(channel, 'ready');
    // No `platform` override: the per-user file is checked by this OS's rules, and
    // a POSIX check of a file made on Windows would refuse it before connecting.
    runSessionHelper({ sessionFile: file, signal: ac.signal, env: {}, deps: { ...quick, backend: null } });
    const [info] = await ready;
    assert.deepEqual(info.capabilities, []);
    assert.equal(info.probes[0].ok, false);
    assert.match(info.probes[0].hint, /no desktop session/i);
  });
});

// Demo takes (Task 9): the four take ops and the 30 s recording rule.
describe('take ops', () => {
  const { createOpHandler, createRecordingGuard } = require('../src/session/connection');

  it('createOpHandler dispatches the four ops to the backend, snake_case in, and an unknown op is still unknown_op', async () => {
    const calls = [];
    const backend = {
      launchBrowser: async (a) => { calls.push(['launchBrowser', a]); return { pid: 1, cdp: { port: 9222, path: '/devtools/browser/x' } }; },
      recordStart: async (a) => { calls.push(['recordStart', a]); return { pid: 2, startedAt: 5 }; },
      recordStop: async (a) => { calls.push(['recordStop', a]); return { path: 'C:\\r\\a.mp4', durationS: 1, bytes: 3, truncated: false }; },
      keepAwake: async (a) => { calls.push(['keepAwake', a]); return { on: a.on }; }
    };
    const realpath = (p) => p;
    const handle = createOpHandler(backend, { platform: 'win32', realpath, recorder: { ffmpeg: 'C:\\Users\\alice\\bin\\ffmpeg.exe' } });
    const exe = 'C:\\x\\chrome.exe';
    const take = 'take-0123456789ab';
    assert.deepEqual(await handle('launch_browser', { exe, profile: 'demo', args: ['--a'] }), { pid: 1, cdp: { port: 9222, path: '/devtools/browser/x' } });
    assert.deepEqual(await handle('launch_browser', { exe, profile: 'demo' }), { pid: 1, cdp: { port: 9222, path: '/devtools/browser/x' } });
    assert.deepEqual(await handle('record_start', { ffmpeg: 'C:\\ff\\ffmpeg.exe', take_id: take, path: 'C:\\r\\a.mp4', fps: 24, size: { width: 1280, height: 720 }, max_s: 3660 }), { pid: 2, startedAt: 5 });
    await handle('record_start', { take_id: take });
    assert.deepEqual(await handle('record_stop', { pid: 2 }), { path: 'C:\\r\\a.mp4', durationS: 1, bytes: 3, truncated: false });
    // Minor 6: by take id, for a record_start whose answer the service never got.
    await handle('record_stop', { take_id: take });
    assert.deepEqual(await handle('keep_awake', { on: true }), { on: true });
    assert.deepEqual(await handle('keep_awake', { on: 'yes' }), { on: false }, 'only true is on');
    assert.deepEqual(calls, [
      ['launchBrowser', { exe, profile: 'demo', args: ['--a'] }],
      ['launchBrowser', { exe, profile: 'demo', args: [] }],
      ['recordStart', { ffmpeg: 'C:\\ff\\ffmpeg.exe', takeId: take, path: 'C:\\r\\a.mp4', fps: 24, size: { width: 1280, height: 720 }, maxS: 3660 }],
      // No ffmpeg named: the one the helper found; no path: the helper's default; no max_s: unbounded.
      ['recordStart', { ffmpeg: 'C:\\Users\\alice\\bin\\ffmpeg.exe', takeId: take, path: null, fps: undefined, size: null, maxS: null }],
      ['recordStop', { pid: 2 }],
      ['recordStop', { takeId: take }],
      ['keepAwake', { on: true }],
      ['keepAwake', { on: false }]
    ]);
    await assert.rejects(handle('record_everything', {}), (e) => e.code === 'unknown_op');
    // No recorder found and none named: null reaches the backend, which says recorder_missing.
    const bare = createOpHandler(backend, { platform: 'win32', realpath });
    await bare('record_start', { take_id: take });
    assert.equal(calls.at(-1)[1].ffmpeg, null);
  });

  it('findFfmpeg walks PATH for ffmpeg.exe as the user, with no shell', () => {
    const { findFfmpeg } = require('../src/session/recorder');
    const have = new Set(['C:\\tools\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\later\\ffmpeg.exe']);
    const isFile = (p) => have.has(p);
    const env = { PATH: 'bin;C:\\Windows\\System32;"C:\\tools\\ffmpeg\\bin";C:\\later', PATHEXT: '.COM;.EXE;.BAT' };
    assert.equal(findFfmpeg({ platform: 'win32', env, isFile }), 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe', 'the first PATH entry that has it');
    assert.equal(findFfmpeg({ platform: 'win32', env: { ...env, PATH: '.;bin' }, isFile: () => true }), null, 'a relative entry is never searched');
    assert.equal(findFfmpeg({ platform: 'win32', env: { ...env, PATHEXT: '.COM;.BAT' }, isFile }), null, 'not when PATHEXT leaves .exe out');
    assert.equal(findFfmpeg({ platform: 'win32', env: { Path: 'C:\\later' }, isFile }), 'C:\\later\\ffmpeg.exe');
    assert.equal(findFfmpeg({ platform: 'win32', env: {}, isFile }), null);
    assert.equal(findFfmpeg({ platform: 'linux', env, isFile: () => true }), null, 'Windows only in D1');
  });

  it('launch_browser re-resolves the browser exe as launch does', async () => {
    const backend = { launchBrowser: async () => { throw new Error('not reached'); } };
    const handle = createOpHandler(backend, { platform: 'win32', realpath: () => 'C:\\elsewhere\\chrome.exe' });
    await assert.rejects(handle('launch_browser', { exe: 'C:\\x\\chrome.exe', profile_dir: 'C:\\p\\demo' }), (e) => e.code === 'path_changed');
  });

  function manualTimers() {
    const t = { now: 0, list: [] };
    t.setTimeout = (fn, ms) => { const h = { at: t.now + ms, fn, done: false }; t.list.push(h); return h; };
    t.clearTimeout = (h) => { if (h) h.done = true; };
    t.advance = async (ms) => {
      t.now += ms;
      for (const h of t.list) if (!h.done && h.at <= t.now) { h.done = true; h.fn(); }
      await new Promise((r) => setImmediate(r));
    };
    return t;
  }

  it('after the connection closes, stopRecordings runs once 30 s pass, and not when it reconnects at 29 s', async () => {
    const t = manualTimers();
    let stops = 0;
    const guard = createRecordingGuard({ backend: { stopRecordings: async () => { stops += 1; return []; } }, timers: t });
    guard.disconnected();
    await t.advance(29_000);
    guard.connected();
    await t.advance(10_000);
    assert.equal(stops, 0, 'a reconnect at 29 s keeps the recording');
    guard.disconnected();
    await t.advance(29_999);
    assert.equal(stops, 0);
    await t.advance(1);
    assert.equal(stops, 1);
    await t.advance(60_000);
    assert.equal(stops, 1, 'once');
    // A second close while the timer runs does not start another.
    guard.disconnected();
    guard.disconnected();
    await t.advance(30_000);
    assert.equal(stops, 2);
    // Stopping the helper stops them at once and leaves no timer.
    guard.disconnected();
    await guard.stop();
    assert.equal(stops, 3);
    await t.advance(30_000);
    assert.equal(stops, 3);
  });

  // Review M-6: the wiring in runSessionHelper, not only the guard.
  it('runSessionHelper: a drop with a reconnect keeps the recordings; 30 s without the service stops them', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    let channel = await channelFor(endpoint, { secret });
    const backend = fakeBackend([REPORT]);
    const t = manualTimers();
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const armed = () => t.list.filter((h) => !h.done).length;
    let ready = once(channel, 'ready');
    const done = runSessionHelper({ sessionFile: file, signal: ac.signal, deps: { ...quick, backend, timers: t, findFfmpeg: () => 'C:\\ff\\ffmpeg.exe' } });
    const [info] = await ready;
    const stops = () => backend.calls.filter((c) => c === 'stopRecordings').length;

    // A drop, then the helper is back within 29 s (it reconnects at once here).
    ready = once(channel, 'ready');
    channel._destroy(channel.current, 'test');
    await ready;
    await t.advance(29_000);
    assert.equal(armed(), 0, 'the reconnect cleared the timer');
    await t.advance(10_000);
    assert.equal(stops(), 0, 'a reconnect keeps the recording');

    // The service goes away and stays away.
    await channel.stop();
    // Bounded: a helper that never arms the timer fails here, not at the file timeout.
    for (let i = 0; armed() === 0; i += 1) {
      assert.ok(i < 100, 'the 30 s timer was never armed after the service went away');
      await new Promise((r) => setImmediate(r));
    }
    await t.advance(29_999);
    assert.equal(stops(), 0);
    await t.advance(1);
    assert.equal(stops(), 1, 'stopped once 30 s passed');

    // The recorder rides in the probe report, and the service keeps it.
    assert.deepEqual(info.recorder, { ffmpeg: 'C:\\ff\\ffmpeg.exe' });
    channel = null;
    ac.abort();
    assert.equal(await done, 0);
  });

  it('the probe_report the helper sends carries recorder: { ffmpeg }', async () => {
    const { configDir, endpoint } = setup();
    const { file } = writeCopy({ configDir, endpoint });
    const reports = [];
    const ac = new AbortController();
    const connect = async ({ probeReport }) => {
      reports.push(probeReport);
      const { EventEmitter } = require('events');
      const s = new EventEmitter();
      s.close = () => s.emit('closed');
      s.sendEvent = () => {};
      setImmediate(() => ac.abort());
      return s;
    };
    for (const found of ['C:\\ff\\ffmpeg.exe', null]) {
      reports.length = 0;
      const ctl = new AbortController();
      ac.abort = () => ctl.abort();
      assert.equal(await runSessionHelper({ sessionFile: file, signal: ctl.signal, deps: { ...quick, backend: fakeBackend([REPORT]), connect, findFfmpeg: () => found } }), 0);
      assert.deepEqual(reports[0].recorder, { ffmpeg: found });
      assert.deepEqual(reports[0].capabilities, REPORT.capabilities);
    }
  });

  it('a backend without stopRecordings, or one that fails, changes nothing', async () => {
    const t = manualTimers();
    const guard = createRecordingGuard({ backend: null, timers: t });
    guard.disconnected();
    await t.advance(30_000);
    await guard.stop();
    const failing = createRecordingGuard({ backend: { stopRecordings: async () => { throw new Error('C:\\r\\a.mp4 busy'); } }, timers: t, log: { warn: () => {} } });
    failing.disconnected();
    await t.advance(30_000);
    await failing.stop();
  });
});

describe('paths and selection', () => {
  it('backoff is 1, 2, 5, 10, 30 s', () => {
    assert.deepEqual(RECONNECT_DELAYS, [1000, 2000, 5000, 10000, 30000]);
  });

  it('the default file is the admin copy for this user; the log dir is per OS', () => {
    assert.equal(defaultSessionFile({ platform: 'linux', env: {}, user: 'alice' }), '/etc/king-louie/session/users/alice.json');
    assert.equal(defaultSessionFile({ platform: 'darwin', env: {}, user: 'alice' }), '/Library/Application Support/KingLouie/config/session/users/alice.json');
    assert.equal(defaultSessionFile({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' }, currentSid: () => 'S-1-5-21-1-2-3-1001' }),
      'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json');
    assert.deepEqual(helperLogDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } }), { dir: 'C:\\Users\\alice\\AppData\\Local\\KingLouie\\session\\logs', name: 'helper.log' });
    assert.deepEqual(helperLogDir({ platform: 'darwin', env: { HOME: '/Users/alice' } }), { dir: '/Users/alice/Library/Logs/KingLouie', name: 'session.log' });
    assert.deepEqual(helperLogDir({ platform: 'linux', env: { HOME: '/home/alice' } }), { dir: '/home/alice/.local/state/king-louie', name: 'session.log' });
  });

  it('selects the backend per OS; Linux prefers Wayland even with DISPLAY set', () => {
    assert.equal(selectBackend({ platform: 'win32', env: {} }), 'windows');
    assert.equal(selectBackend({ platform: 'darwin', env: {} }), 'macos');
    assert.equal(selectBackend({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
    assert.equal(selectBackend({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
    assert.equal(selectBackend({ platform: 'linux', env: { DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'x11');
    assert.equal(selectBackend({ platform: 'linux', env: { DISPLAY: ':0' }, xdpyinfoOk: () => false }), null);
    assert.equal(selectBackend({ platform: 'linux', env: {} }), null);
  });
});
