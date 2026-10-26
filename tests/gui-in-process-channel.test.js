// tests/gui-in-process-channel.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { InProcessChannel, buildInProcessChannel } = require('../src/gui/in-process-channel');
const { GuiBroker } = require('../src/gui/broker');
const { parseGuiConfig } = require('../src/gui/config');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const quietLog = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
const FFMPEG = 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe';
const ALL_CAPS = ['gui.launch', 'gui.screenshot', 'gui.input'];
const guiConfig = parseGuiConfig({ enabled: true, apps: { notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' } } }, { platform: 'win32' });

function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    live,
    timers: {
      setInterval: (fn, ms) => { const id = nextId++; live.set(id, { fn, ms }); return id; },
      clearInterval: (id) => { live.delete(id); }
    },
    fn: (ms) => [...live.values()].find((x) => x.ms === ms).fn
  };
}

function fakeBackend(over = {}) {
  const calls = [];
  const backend = {
    calls,
    probe: async () => ({ capabilities: [...ALL_CAPS], probes: [], displays: [{ id: 1 }], limits: [], locked: false }),
    screenshot: async (p) => { calls.push(['screenshot', p]); return { mime: 'image/jpeg', width: 10, height: 10, data: 'AA==' }; },
    locked: async () => false,
    launchBrowser: async (p) => { calls.push(['launch_browser', p]); return { pid: 9, port: 9222 }; },
    ...over
  };
  return backend;
}

function channel(opts = {}) {
  const t = fakeTimers();
  const backend = opts.backend === undefined ? fakeBackend() : opts.backend;
  const ch = new InProcessChannel({
    backend, platform: 'win32', recorder: { ffmpeg: FFMPEG }, log: quietLog, timers: t.timers,
    reprobeMs: 60000, lockPollMs: 2000, clock: () => Date.parse('2026-10-25T12:00:00.000Z'), ...opts.extra
  });
  return { ch, t, backend };
}

const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

describe('InProcessChannel', () => {
  it('start() probes, sets info in the helper shape (recorder.ffmpeg included) and emits ready', async () => {
    const { ch } = channel();
    let readyInfo = null;
    ch.on('ready', (info) => { readyInfo = info; });
    assert.equal(ch.connected, false);
    assert.equal(ch.info, null);
    await ch.start();
    assert.equal(ch.connected, true);
    assert.deepEqual(ch.info, {
      user: os.userInfo().username, platform: 'win32', pid: process.pid,
      capabilities: ALL_CAPS, probes: [], displays: [{ id: 1 }], limits: [], locked: false,
      recorder: { ffmpeg: FFMPEG }, since: '2026-10-25T12:00:00.000Z'
    });
    assert.deepEqual(readyInfo, ch.info);
    await ch.stop();
  });

  it('request(op) calls the op handler and resolves; an unknown op is GuiError unknown_op', async () => {
    const { ch, backend } = channel();
    await ch.start();
    const shot = await ch.request('screenshot', { handle: 'w1', max_width: 800, quality: 70 }, { jobId: 'j1' });
    assert.equal(shot.mime, 'image/jpeg');
    assert.deepEqual(backend.calls, [['screenshot', { handle: 'w1', maxWidth: 800, quality: 70 }]]);
    assert.equal(await codeOf(ch.request('format_disk', {})), 'unknown_op');
    await ch.stop();
  });

  it('a backend error that is not a GuiError comes back as backend_failed', async () => {
    const { ch } = channel({ backend: fakeBackend({ screenshot: async () => { throw new Error('boom'); } }) });
    await ch.start();
    assert.equal(await codeOf(ch.request('screenshot', {})), 'backend_failed');
    await ch.stop();
  });

  it('request honours timeoutMs with op_timeout', async () => {
    const { ch } = channel({ backend: fakeBackend({ screenshot: () => new Promise(() => {}) }) });
    await ch.start();
    // A ref'd timer keeps the loop alive across the await (the channel's own is unref'd).
    const keep = setTimeout(() => {}, 5000);
    try {
      const err = await ch.request('screenshot', {}, { timeoutMs: 20 }).then(() => null, (e) => e);
      assert.equal(err.code, 'op_timeout');
      assert.match(err.message, /screenshot/);
    } finally {
      clearTimeout(keep);
    }
    await ch.stop();
  });

  it('request before start is helper_disconnected; it never emits closed', async () => {
    const { ch, t } = channel();
    let closed = 0;
    ch.on('closed', () => { closed += 1; });
    assert.equal(await codeOf(ch.request('screenshot', {})), 'helper_disconnected');
    await ch.start();
    assert.equal(t.live.size, 2, 'the watch runs');
    await ch.stop();
    assert.equal(ch.connected, false);
    assert.equal(t.live.size, 0, 'stop() stops the watch');
    assert.equal(await codeOf(ch.request('screenshot', {})), 'helper_disconnected');
    assert.equal(closed, 0);
  });

  it('a request in flight at stop() is rejected helper_disconnected', async () => {
    const { ch } = channel({ backend: fakeBackend({ screenshot: () => new Promise(() => {}) }) });
    await ch.start();
    const pending = ch.request('screenshot', {});
    await ch.stop();
    assert.equal(await codeOf(pending), 'helper_disconnected');
  });

  it('stop() stops a backend that has stop()', async () => {
    let stopped = 0;
    const { ch } = channel({ backend: fakeBackend({ stop: async () => { stopped += 1; } }) });
    await ch.start();
    await ch.stop();
    assert.equal(stopped, 1);
  });

  it('a watch event arrives as "event" (kind, payload) and probe_changed updates info', async () => {
    let caps = [...ALL_CAPS];
    let lockedNow = false;
    const backend = fakeBackend({
      probe: async () => ({ capabilities: caps, probes: [], displays: [], limits: [], locked: false }),
      locked: async () => lockedNow
    });
    const { ch, t } = channel({ backend });
    const events = [];
    ch.on('event', (kind, payload) => events.push([kind, payload]));
    await ch.start();
    lockedNow = true;
    await t.fn(2000)();
    assert.deepEqual(events, [['locked', {}]]);
    assert.equal(ch.info.locked, true);
    caps = ['gui.screenshot', 'not.a.capability'];
    await t.fn(60000)();
    assert.equal(events.length, 2);
    assert.equal(events[1][0], 'probe_changed');
    assert.deepEqual(events[1][1], ch.info, 'probe_changed carries the new info, as HelperChannel emits it');
    assert.deepEqual(ch.info.capabilities, ['gui.screenshot']);
    assert.equal(ch.info.locked, true, 'the lock state is kept across a probe change');
    assert.deepEqual(ch.info.recorder, { ffmpeg: FFMPEG });
    assert.equal(ch.info.user, os.userInfo().username);
    lockedNow = false;
    await t.fn(2000)();
    assert.deepEqual(events[2], ['unlocked', {}]);
    assert.equal(ch.info.locked, false);
    await ch.stop();
  });

  it('Review Focus 1: a backend whose probe has no gui.screenshot leaves capabilities without it; a GuiBroker over this channel reports capability() false', async () => {
    const backend = fakeBackend({ probe: async () => ({ capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false }) });
    const { ch } = channel({ backend });
    const b = new GuiBroker({ channel: ch, guiConfig, getPolicy: () => ({ allowed_roots: [] }), platform: 'win32', heartbeatMs: 60000, realpath: (p) => p });
    b.start();
    await ch.start();
    assert.deepEqual(ch.info.capabilities, ['gui.launch']);
    const cap = b.capability();
    assert.equal(cap.available, true);
    assert.equal(cap.capabilities.includes('gui.screenshot'), false);
    assert.throws(() => b.require('gui.screenshot'), (e) => e.code === 'capability_unavailable' && /gui\.screenshot/.test(e.message));
    b.stop();
    await ch.stop();
  });

  it('buildInProcessChannel with selectBackend → null gives a channel whose request is capability_unavailable', async () => {
    // No backend is selected for this platform, so nothing is loaded or spawned.
    const ch = buildInProcessChannel({ platform: 'sunos', env: {}, log: quietLog });
    assert.ok(ch instanceof InProcessChannel);
    await ch.start();
    assert.deepEqual(ch.info.capabilities, []);
    assert.equal(ch.info.probes[0].ok, false);
    assert.deepEqual(ch.info.recorder, { ffmpeg: null });
    assert.equal(await codeOf(ch.request('screenshot', {})), 'capability_unavailable');
    await ch.stop();
  });

  it('loading the module loads no backend', () => {
    const loaded = Object.keys(require.cache).filter((p) => /[\\/]session[\\/]backends[\\/](windows|macos|x11|wayland)/.test(p));
    assert.deepEqual(loaded, []);
  });
});
