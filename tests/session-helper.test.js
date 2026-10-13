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

const quick = { delays: [20, 20, 20], rootUid: UID, attachLog: false };

describe('runSessionHelper', () => {
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
