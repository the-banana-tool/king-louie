// tests/session-backend-macos.test.js
//
// The launch and screenshot plumbing with fake child processes (any OS),
// and the real JXA worker on macOS only. Nothing injects input.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacosBackend } = require('../src/session/backends/macos');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const MAC = process.platform === 'darwin';

describe('macOS backend plumbing (fake tools)', () => {
  it('launch uses open -a, and -n with --args when there are args; argv only', async () => {
    const calls = [];
    const execFileImpl = async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; };
    const backend = createMacosBackend({ execFileImpl, worker: { call: async (op) => (op === 'pid_for_app' ? 4242 : null), stop: async () => {} } });
    assert.deepEqual(await backend.launch({ exe: '/System/Applications/TextEdit.app', argv: [], files: ['/tmp/a.txt'] }), { pid: 4242 });
    assert.deepEqual(calls[0], ['/usr/bin/open', '-a', '/System/Applications/TextEdit.app', '/tmp/a.txt']);
    await backend.launch({ exe: '/Applications/Tool.app', argv: ['--x', 'y'], files: [] });
    assert.deepEqual(calls[1], ['/usr/bin/open', '-n', '-a', '/Applications/Tool.app', '--args', '--x', 'y']);
  });

  it('screenshot: screencapture of one window, resized with sips, points transform, temp files removed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mac-shot-'));
    const calls = [];
    const execFileImpl = async (file, args) => {
      calls.push([file, ...args]);
      if (file === '/usr/sbin/screencapture') fs.writeFileSync(args[args.length - 1], Buffer.from('raw-jpeg'));
      if (file === '/usr/bin/sips' && args.includes('--out')) fs.writeFileSync(args[args.indexOf('--out') + 1], Buffer.from('small-jpeg'));
      if (file === '/usr/bin/sips' && args[0] === '-g') return { stdout: 'x\n  pixelWidth: 1280\n  pixelHeight: 960\n' };
      return { stdout: '' };
    };
    const worker = { call: async (op) => (op === 'window_info' ? { windowNumber: 77, bounds: { x: 0, y: 25, w: 800, h: 600 } } : null), stop: async () => {} };
    const backend = createMacosBackend({ execFileImpl, worker, tmpDir });
    const shot = await backend.screenshot({ handle: '77', maxWidth: 1280, quality: 70 });
    assert.deepEqual(calls[0].slice(0, 6), ['/usr/sbin/screencapture', '-x', '-o', '-l', '77', '-t']);
    assert.equal(shot.width, 1280);
    assert.deepEqual(shot.transform, { sx: 800 / 1280, sy: 600 / 960, unit: 'pt' });
    assert.equal(Buffer.from(shot.data, 'base64').toString(), 'small-jpeg');
    assert.deepEqual(fs.readdirSync(tmpDir), [], 'temp files are deleted');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('macOS JXA worker', { skip: !MAC }, () => {
  const backend = MAC ? createMacosBackend({}) : null;
  after(() => backend && backend.stop());

  it('probes itself; launch is always there', async () => {
    const r = await backend.probe();
    assert.ok(r.capabilities.includes('gui.launch'));
    assert.ok(r.probes.some((p) => p.check === 'screen_recording'));
    assert.ok(r.probes.some((p) => p.check === 'accessibility'));
  });

  it('reads the frontmost app and hit-tests its window', async () => {
    const fg = await backend.foreground();
    if (!fg || !fg.bounds) return;
    assert.equal(typeof fg.image, 'string');
    const hit = await backend.hitTest({ x: fg.bounds.x + 10, y: fg.bounds.y + 10 });
    assert.ok(hit === null || Number.isInteger(hit.pid));
  });

  it('refuses before injecting when the foreground is not leased', async () => {
    await assert.rejects(
      backend.input({ expect: { match: ['/nonexistent/Kl.app'], pids: [0] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 }),
      (e) => e.code === 'foreground_mismatch' || e.code === 'screen_locked'
    );
  });
});
