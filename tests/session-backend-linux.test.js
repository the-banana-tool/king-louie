// tests/session-backend-linux.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createX11Backend } = require('../src/session/backends/x11');
const { createWaylandBackend } = require('../src/session/backends/wayland');
const { jpegSize, XDOTOOL_KEYS } = require('../src/session/backends/linux-common');
const { selectBackend } = require('../src/session/backends');

const HAS_X = process.platform === 'linux' && Boolean(process.env.DISPLAY) && !process.env.WAYLAND_DISPLAY && fs.existsSync('/usr/bin/xdotool');

// A scripted xdotool: argv → stdout.
function fakeX(script) {
  const calls = [];
  const execFileImpl = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input });
    const key = [file.split('/').pop(), ...args].join(' ');
    for (const [pattern, out] of script) if (pattern.test(key)) return { stdout: typeof out === 'function' ? out(args) : out };
    return { stdout: '' };
  };
  return { calls, execFileImpl };
}

const GEOM = 'WINDOW=42\nX=100\nY=50\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n';
const baseScript = [
  [/^loginctl/, 'no\n'],
  [/^xdotool getactivewindow$/, '42\n'],
  [/^xdotool getwindowpid 42$/, '4242\n'],
  [/^xdotool getwindowgeometry --shell 42$/, GEOM],
  [/^xdotool getmouselocation --shell$/, 'X=1\nY=1\nSCREEN=0\nWINDOW=42\n'],
  [/^xdotool getmouselocation$/, 'x:1 y:1 screen:0 window:42\n']
];

describe('Linux selection', () => {
  it('prefers Wayland when both WAYLAND_DISPLAY and DISPLAY are set', () => {
    assert.equal(selectBackend({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
  });
});

describe('X11 backend (scripted xdotool)', () => {
  const readlink = (p) => (p === '/proc/4242/exe' ? '/usr/bin/gnome-calculator' : '/usr/bin/bash');

  it('probes: launch, screenshot, input; limits always say no_human_yield', async () => {
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    const r = await b.probe();
    assert.deepEqual(r.capabilities, ['gui.launch', 'gui.screenshot', 'gui.input']);
    assert.deepEqual(r.limits, ['no_human_yield']);
    const noLock = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    assert.deepEqual((await noLock.probe()).limits, ['no_human_yield', 'no_lock_detect']);
  });

  it('foreground reads the image from /proc, not from the window', async () => {
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    assert.deepEqual(await b.foreground(), { handle: '42', pid: 4242, image: '/usr/bin/gnome-calculator', bounds: { x: 100, y: 50, w: 800, h: 600 }, scale: 1 });
  });

  it('input: checks, hit test via the pointer, then xdotool with text on stdin only', async () => {
    const { calls, execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    const expect = { match: ['/usr/bin/gnome-calculator'], pids: [4242] };
    await b.input({ expect, action: { kind: 'type', text: 'rm -rf / 12+30=' }, yieldMs: 2000 });
    const typeCall = calls.find((c) => c.args[0] === 'type');
    assert.deepEqual(typeCall.args, ['type', '--clearmodifiers', '--file', '-']);
    assert.equal(typeCall.input, 'rm -rf / 12+30=');
    await b.input({ expect, action: { kind: 'click', handle: '42', rel: [10, 20], button: 'left', count: 2, mods: ['ctrl'] }, yieldMs: 0 });
    assert.ok(calls.some((c) => c.args.join(' ') === 'mousemove --sync 110 70'));
    assert.ok(calls.some((c) => c.args.join(' ') === 'keydown ctrl'));
    assert.ok(calls.some((c) => c.args.join(' ') === 'click --repeat 2 1'));
    await b.input({ expect, action: { kind: 'key', mods: ['ctrl'], key: 's', repeat: 1 }, yieldMs: 0 });
    assert.ok(calls.some((c) => c.args.join(' ') === 'key --clearmodifiers --repeat 1 ctrl+s'));
  });

  it('refuses: foreground_mismatch, outside_window, point_obscured, screen_locked', async () => {
    const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b.input({ expect: { match: ['/usr/bin/xterm'], pids: [1] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 })), 'foreground_mismatch');
    const expect = { match: ['/usr/bin/gnome-calculator'], pids: [4242] };
    assert.equal(await code(b.input({ expect, action: { kind: 'click', handle: '42', rel: [800, 1], button: 'left', count: 1, mods: [] }, yieldMs: 0 })), 'outside_window');
    const covered = fakeX([[/^xdotool getmouselocation --shell$/, 'X=1\nY=1\nSCREEN=0\nWINDOW=99\n'], [/^xdotool getwindowpid 99$/, '1\n'], ...baseScript]);
    const b2 = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl: covered.execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b2.input({ expect, action: { kind: 'click', handle: '42', rel: [10, 10], button: 'left', count: 1, mods: [] }, yieldMs: 0 })), 'point_obscured');
    const locked = fakeX([[/^loginctl/, 'yes\n'], ...baseScript]);
    const b3 = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl: locked.execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b3.input({ expect, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 })), 'screen_locked');
  });

  it('screenshot: import of one window, the size read from the JPEG itself', async () => {
    // A minimal JPEG header with an SOF0 of 640x480.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
    assert.deepEqual(jpegSize(jpeg), { width: 640, height: 480 });
    const { calls, execFileImpl } = fakeX([[/^import/, jpeg], ...baseScript]);
    const b = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    const shot = await b.screenshot({ handle: '42', maxWidth: 640, quality: 60 });
    assert.deepEqual(calls.find((c) => c.file.endsWith('/import')).args, ['-window', '42', '-resize', '640x>', '-quality', '60', 'jpg:-']);
    assert.deepEqual(shot.transform, { sx: 800 / 640, sy: 600 / 480, unit: 'px' });
  });

  it('an unknown key or modifier is key_invalid and never reaches xdotool (as the Windows and macOS workers answer)', async () => {
    const expect = { match: ['/usr/bin/gnome-calculator'], pids: [4242] };
    const bad = [
      { mods: [], key: 'XF86PowerOff' }, { mods: [], key: 'super+l' }, { mods: [], key: 'Return' }, { mods: [], key: 'ab' }, { mods: [], key: 'f25' },
      { mods: [], key: 'f0' }, { mods: [], key: '' }, { mods: [], key: undefined }, { mods: [], key: 7 }, { mods: [], key: 'toString' },
      { mods: ['hyper'], key: 'a' }, { mods: ['ctrl', 'constructor'], key: 'a' }
    ];
    for (const combo of bad) {
      const { calls, execFileImpl } = fakeX(baseScript);
      const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
      await assert.rejects(b.input({ expect, action: { kind: 'key', ...combo, repeat: 1 }, yieldMs: 0 }), (e) => e.code === 'key_invalid', JSON.stringify(combo));
      assert.equal(calls.filter((c) => ['key', 'keydown', 'keyup'].includes(c.args[0])).length, 0, `nothing was pressed for ${JSON.stringify(combo)}`);
    }
    // A click's modifiers are checked the same way, before the pointer moves.
    const { calls, execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    await assert.rejects(b.input({ expect, action: { kind: 'click', handle: '42', rel: [10, 20], button: 'left', count: 1, mods: ['hyper'] }, yieldMs: 0 }), (e) => e.code === 'key_invalid');
    assert.equal(calls.filter((c) => ['click', 'mousemove', 'keydown'].includes(c.args[0])).length, 0);
    // Every key the grammar knows still maps.
    for (const key of ['a', 'z', '0', '9', 'f1', 'f24', 'enter', 'pageup', '/', '\\']) {
      const ok = fakeX(baseScript);
      const b2 = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl: ok.execFileImpl, readlink, exists: () => true });
      await b2.input({ expect, action: { kind: 'key', mods: [], key, repeat: 1 }, yieldMs: 0 });
      assert.equal(ok.calls.filter((c) => c.args[0] === 'key').length, 1, key);
    }
  });

  it('maps the key grammar to X keysyms', () => {
    assert.equal(XDOTOOL_KEYS.enter, 'Return');
    assert.equal(XDOTOOL_KEYS.pageup, 'Prior');
    assert.equal(XDOTOOL_KEYS['/'], 'slash');
  });
});

describe('Wayland backend', () => {
  it('advertises gui.launch only and refuses the rest', async () => {
    const b = createWaylandBackend({ env: { WAYLAND_DISPLAY: 'wayland-0' } });
    const r = await b.probe();
    assert.deepEqual(r.capabilities, ['gui.launch']);
    assert.match(r.probes[0].hint, /Wayland/);
    await assert.rejects(b.screenshot({ handle: '1', maxWidth: 320, quality: 50 }), (e) => e.code === 'capability_unavailable');
    await assert.rejects(b.input({}), (e) => e.code === 'capability_unavailable');
    assert.equal(await b.foreground(), null);
  });
});

describe('real X11', { skip: !HAS_X }, () => {
  it('probes and reads the foreground', async () => {
    const b = createX11Backend({});
    const r = await b.probe();
    assert.ok(r.capabilities.includes('gui.launch'));
    const fg = await b.foreground();
    assert.ok(fg === null || typeof fg.image === 'string');
  });
});
