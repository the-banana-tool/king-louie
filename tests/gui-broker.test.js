// tests/gui-broker.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuiBroker, suspendsLease } = require('../src/gui/broker');
const { readGuiStatus, readGuiStatusRecord, statusPath } = require('../src/gui/status');
const { parseGuiConfig } = require('../src/gui/config');
const { GuiError } = require('../src/gui/errors');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
const tempDirs = [];
after(() => {
  // Newest first: a broker is stopped before its data dir is removed.
  // stop() writes one last status.json, and writeGuiStatus creates the
  // session dir it writes into, so stopping after the removal put the temp
  // dir back.
  for (const c of cleanups.reverse()) c();
  assert.deepEqual(tempDirs.filter((d) => fs.existsSync(d)), [], 'no temp dir is left behind');
});

const APPS = {
  calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
  notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' }
};
const guiConfig = parseGuiConfig({ enabled: true, apps: APPS }, { platform: 'win32' });
const INFO = { user: 'alice', platform: 'win32', pid: 7, capabilities: ['gui.launch', 'gui.screenshot', 'gui.input'], probes: [], displays: [], limits: [], locked: false, since: '2026-09-23T18:00:00.000Z' };

class FakeChannel extends EventEmitter {
  constructor(handlers = {}) { super(); this.connected = false; this.info = null; this.handlers = handlers; this.requests = []; }
  connect(info = INFO) { this.connected = true; this.info = { ...info }; this.emit('ready', this.info); }
  drop(reason = 'gone') { this.connected = false; this.info = null; this.emit('closed', reason); }
  async request(op, params, opts) {
    this.requests.push({ op, params, opts });
    if (!this.handlers[op]) throw new GuiError('unknown_op', op);
    return this.handlers[op](params, opts);
  }
}

function tempData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-broker-'));
  tempDirs.push(d);
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'service.pid'), String(process.pid));
  return d;
}

const CALC = { pid: 100, image: 'C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe' };
function handlers(overrides = {}) {
  return {
    processes: async ({ match }) => (match.some((m) => /CalculatorApp/i.test(m)) ? [CALC] : []),
    windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'Calculator', bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1.5, minimized: false }],
    foreground: async () => ({ handle: 'w1', pid: 100, image: CALC.image, bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1.5 }),
    screenshot: async () => ({ mime: 'image/jpeg', width: 1280, height: 720, data: Buffer.from('jpeg-bytes').toString('base64'), transform: { sx: 1.5, sy: 1.5, unit: 'px' } }),
    input: async () => ({ foregroundBefore: CALC, foregroundAfter: CALC }),
    launch: async () => ({ pid: 555 }),
    close: async ({ pids }) => ({ closed: pids }),
    release_all: async () => null,
    focus: async () => ({ focused: true }),
    ...overrides
  };
}

function broker(opts = {}) {
  const channel = new FakeChannel(handlers(opts.handlers));
  const audits = [];
  let t = Date.parse('2026-09-23T18:00:00.000Z');
  const b = new GuiBroker({
    channel, guiConfig, getPolicy: () => ({ allowed_roots: [] }), audit: { append: async (e) => { audits.push(e); } },
    dataDir: opts.dataDir || null, platform: 'win32', clock: () => t, heartbeatMs: 60000, realpath: (p) => p
  });
  // The broker sends no input without a lease manager (finding 4); these
  // tests are about the broker, so theirs always holds lease l1 for the job.
  if (opts.leases !== null) {
    b.setLeases(opts.leases || { assertUsable: () => ({ leaseId: 'l1' }), statusSummary: () => null, active: () => null, onHelperDisconnected() {}, setLocked() {} });
  }
  b.start();
  cleanups.push(() => b.stop());
  return { b, channel, audits, advance: (ms) => { t += ms; }, now: () => t };
}

const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
const ctx = { jobId: 'job-1', leaseId: null };

describe('how long an input may take (review finding 10)', () => {
  const { inputTimeoutMs } = require('../src/gui/broker');

  it('a click or a key keeps the channel default; typed text gets time for its length', async () => {
    const { b, channel } = broker();
    channel.connect();
    await b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 });
    assert.equal(channel.requests.find((r) => r.op === 'input').opts.timeoutMs, undefined);
    channel.requests.length = 0;
    const text = 'x'.repeat(2000);
    await b.input({ kind: 'type', text }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 });
    const sent = channel.requests.find((r) => r.op === 'input');
    assert.equal(sent.opts.timeoutMs, inputTimeoutMs({ kind: 'type', text }));
    assert.ok(sent.opts.timeoutMs > 60000, 'two thousand characters at xdotool\'s pace do not fit in ten seconds');
    assert.equal(inputTimeoutMs({ kind: 'type', text: 'é'.repeat(10) }), inputTimeoutMs({ kind: 'type', text: 'x'.repeat(10) }), 'counted in code points');
    assert.equal(inputTimeoutMs({ kind: 'click' }), undefined);
  });
});

describe('no lease manager, no input (review finding 4)', () => {
  it('a broker with no lease manager refuses every input before the helper hears of it', async () => {
    const { b, channel } = broker({ leases: null });
    channel.connect();
    assert.equal(await code(b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 })), 'lease_required');
    assert.deepEqual(channel.requests.filter((r) => r.op === 'input'), []);
  });
});

describe('capability lifecycle', () => {
  it('available only between ready and closed, advertising only probed sub-capabilities', () => {
    const { b, channel } = broker();
    assert.equal(b.capability().available, false);
    assert.throws(() => b.require('gui.launch'), (e) => e.code === 'capability_unavailable' && e.detail === 'gui');
    channel.connect({ ...INFO, capabilities: ['gui.launch'] });
    assert.equal(b.capability().available, true);
    assert.deepEqual(b.capability().apps, [{ id: 'calculator', name: 'Calculator' }, { id: 'notepad', name: 'Notepad' }]);
    b.require('gui.launch');
    assert.throws(() => b.require('gui.input'), (e) => e.code === 'capability_unavailable' && e.detail === 'gui.input');
    channel.info = { ...channel.info, capabilities: [] };
    channel.emit('event', 'probe_changed', channel.info);
    assert.throws(() => b.require('gui.launch'), (e) => e.detail === 'gui.launch');
    channel.drop();
    assert.equal(b.capability().available, false);
  });

  it('a disabled gui is never available', () => {
    const channel = new FakeChannel(handlers());
    const b = new GuiBroker({ channel, guiConfig: { ...guiConfig, enabled: false }, platform: 'win32' });
    b.start();
    channel.connect();
    assert.equal(b.capability().available, false);
    b.stop();
  });
});

describe('status.json', () => {
  it('is written on each change and read only when fresh and from the live service', () => {
    const dataDir = tempData();
    const { b, channel, now } = broker({ dataDir });
    channel.connect();
    const raw = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
    assert.equal(raw.available, true);
    assert.equal(raw.pid, process.pid);
    const at = Date.parse(raw.updated_at);
    assert.deepEqual(readGuiStatus({ dataDir, now: at + 1000 }), {
      available: true, capabilities: INFO.capabilities, apps: [{ id: 'calculator', name: 'Calculator' }, { id: 'notepad', name: 'Notepad' }], limits: [], lease: null
    });
    assert.equal(readGuiStatus({ dataDir, now: at + 31000 }).available, false, 'stale after 30 s');
    assert.equal(readGuiStatus({ dataDir, now: at + 1000, readPid: () => process.pid + 1 }).available, false, 'another pid');
    assert.equal(readGuiStatus({ dataDir, now: at + 1000, isRunning: () => false }).available, false, 'not running');
    assert.ok(readGuiStatusRecord({ dataDir, now: at + 1000 }).probes);
    channel.drop();
    assert.equal(JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8')).available, false);
    assert.ok(now());
    assert.ok(b);
  });

  it('a missing or corrupt file is simply unavailable', () => {
    const dataDir = tempData();
    assert.equal(readGuiStatus({ dataDir }).available, false);
    fs.mkdirSync(path.join(dataDir, 'session'), { recursive: true });
    fs.writeFileSync(statusPath(dataDir), '{nope');
    assert.equal(readGuiStatus({ dataDir }).available, false);
  });
});

describe('screenshots and coordinates', () => {
  it('Windows: physical pixels with DPI 1.5 and a downscaled screenshot', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.match(shot.screenshotId, /^ss-\d+$/);
    assert.equal(shot.width, 1280);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 640, 360, ['calculator']), { handle: 'w1', rel: [960, 540], appId: 'calculator' });
    assert.ok(channel.requests.find((r) => r.op === 'screenshot').params.handle === 'w1');
  });

  it('macOS: points, with a Retina 2x capture downscaled', async () => {
    const { b, channel } = broker({ handlers: { screenshot: async () => ({ mime: 'image/jpeg', width: 1280, height: 960, data: 'AA==', transform: { sx: 0.625, sy: 0.625, unit: 'pt' } }) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 640, 480, ['calculator']).rel, [400, 300]);
  });

  it('multi-monitor transform: window-relative, so a window at x=-1920 or moved later still maps; outside is refused', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 0, 0, ['calculator']).rel, [0, 0]);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 1279, 719, ['calculator']).rel, [1919, 1079]);
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1280, 10, ['calculator']), (e) => e.code === 'outside_window');
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, -1, 10, ['calculator']), (e) => e.code === 'outside_window');
  });

  it('a screenshot id from another job, an unleased app, or older than 10 minutes is stale', async () => {
    const { b, channel, advance } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.throws(() => b.mapPoint('job-2', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['notepad']), (e) => e.code === 'stale_screenshot');
    assert.throws(() => b.mapPoint('job-1', 'ss-999', 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    advance(10 * 60000 + 1);
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
  });

  it('keeps the last 16 screenshots per job', async () => {
    const { b, channel } = broker();
    channel.connect();
    const ids = [];
    for (let i = 0; i < 17; i += 1) ids.push((await b.screenshot({ app: 'calculator' }, ctx)).screenshotId);
    assert.throws(() => b.mapPoint('job-1', ids[0], 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    assert.ok(b.mapPoint('job-1', ids[16], 1, 1, ['calculator']));
  });

  it('Review Focus 1: displays_changed invalidates every kept screenshot', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    channel.emit('event', 'displays_changed', {});
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
  });

  it('Review Focus 5: a screenshot whose window is gone is stale, and that does not suspend a lease', async () => {
    const { b, channel } = broker({ handlers: { input: async () => { throw new GuiError('stale_screenshot', 'the window is gone'); } } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    const target = b.mapPoint('job-1', shot.screenshotId, 10, 10, ['calculator']);
    assert.equal(await code(b.input({ kind: 'click', handle: target.handle, rel: target.rel, button: 'left', count: 1, mods: [] }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 })), 'stale_screenshot');
    assert.equal(suspendsLease('stale_screenshot'), false);
    assert.equal(suspendsLease('point_obscured'), false);
    assert.equal(suspendsLease('user_active'), false);
    assert.equal(suspendsLease('screen_locked'), false);
    assert.equal(suspendsLease('foreground_mismatch'), true);
    assert.equal(suspendsLease('app_not_running'), true);
  });

  it('refuses while locked, a non-allowlisted app, no app and no lease, a minimized window and no process', async () => {
    const minimized = broker({ handlers: { windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, minimized: true }] } });
    minimized.channel.connect();
    assert.equal(await code(minimized.b.screenshot({ app: 'calculator' }, ctx)), 'window_minimized');
    const { b, channel } = broker();
    channel.connect();
    assert.equal(await code(b.screenshot({ app: 'terminal' }, ctx)), 'app_not_allowlisted');
    assert.equal(await code(b.screenshot({}, ctx)), 'app_required');
    assert.equal(await code(b.screenshot({ app: 'notepad' }, ctx)), 'app_not_running');
    channel.emit('event', 'locked', {});
    assert.equal(await code(b.screenshot({ app: 'calculator' }, ctx)), 'screen_locked');
    channel.emit('event', 'unlocked', {});
    assert.ok(await b.screenshot({ app: 'calculator' }, ctx));
  });

  it('input carries the leased apps as the expected set and reports where the focus went', async () => {
    const { b, channel } = broker({ handlers: { input: async () => ({ foregroundBefore: CALC, foregroundAfter: { pid: 4, image: 'C:\\Windows\\explorer.exe' } }) } });
    channel.connect();
    const out = await b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 2000 });
    const sent = channel.requests.find((r) => r.op === 'input');
    assert.deepEqual(sent.params.expect, { match: ['C:\\Windows\\System32\\calc.exe', 'CalculatorApp.exe'], pids: [100] });
    assert.equal(sent.params.yield_ms, 2000);
    assert.equal(out.afterMatches, false);
  });
});

describe('launch, close and list', () => {
  it('records launched pids per job; force-kills only those', async () => {
    const { b, channel, audits } = broker({ handlers: { processes: async () => [{ pid: 555, image: CALC.image }, { pid: 100, image: CALC.image }] } });
    channel.connect();
    const launched = await b.launch({ tier: 'routine', reason: 'allowlisted', appId: 'calculator', exe: 'C:\\Windows\\System32\\calc.exe', argv: [], files: [], match: [] }, ctx, { approvedBy: 'allowlist' });
    assert.equal(launched.pid, 555);
    assert.ok(audits.some((a) => a.kind === 'gui.launch' && a.data.approved_by === 'allowlist' && a.data.app_id === 'calculator'));
    const closed = await b.close('calculator', true, ctx);
    const closes = channel.requests.filter((r) => r.op === 'close').map((r) => r.params);
    assert.deepEqual(closes, [{ pids: [555], force: true }, { pids: [100], force: false }]);
    assert.deepEqual(closed.closed.sort(), [100, 555]);
    assert.equal(await code(b.close('terminal', false, ctx)), 'app_not_allowlisted');
  });

  it('R-F5-7: a run with no job id keeps no launched pids and no screenshots', async () => {
    const { b, channel } = broker({ handlers: { processes: async () => [{ pid: 555, image: CALC.image }] } });
    channel.connect();
    const none = { jobId: null, leaseId: null };
    await b.launch({ tier: 'routine', reason: 'allowlisted', appId: 'calculator', exe: 'C:\\Windows\\System32\\calc.exe', argv: [], files: [], match: [] }, none, { approvedBy: 'allowlist' });
    await b.close('calculator', true, none);
    assert.deepEqual(channel.requests.filter((r) => r.op === 'close').map((r) => r.params), [{ pids: [555], force: false }], 'never a kill');
    const shot = await b.screenshot({ app: 'calculator' }, none);
    assert.match(shot.screenshotId, /^ss-\d+$/);
    for (const jobId of [null, undefined]) {
      assert.throws(() => b.mapPoint(jobId, shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    }
  });

  it('lists only allowlisted apps, with titles cut to 120 characters', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'x'.repeat(200), bounds: {}, scale: 1, minimized: false }] } });
    channel.connect();
    const apps = await b.listApps(ctx);
    assert.deepEqual(apps.map((a) => [a.id, a.running]), [['calculator', true], ['notepad', false]]);
    assert.equal(apps[0].windows[0].title.length, 120);
  });
});
