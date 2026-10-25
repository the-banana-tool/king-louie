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
    channel, guiConfig: opts.guiConfig || guiConfig, getPolicy: () => ({ allowed_roots: [] }), audit: { append: async (e) => { audits.push(e); } },
    dataDir: opts.dataDir || null, platform: 'win32', clock: () => t, heartbeatMs: 60000, realpath: (p) => p,
    ...(opts.timers ? { timers: opts.timers } : {})
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
    assert.ok(inputTimeoutMs({ kind: 'type', text }) > 60000, 'two thousand characters at xdotool\'s pace do not fit in ten seconds');
    await b.input({ kind: 'type', text }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 });
    // Long text goes out a piece at a time (below); each piece gets the time its own length needs.
    const sent = channel.requests.filter((r) => r.op === 'input');
    for (const s of sent) assert.equal(s.opts.timeoutMs, inputTimeoutMs({ kind: 'type', text: s.params.action.text }));
    assert.equal(inputTimeoutMs({ kind: 'type', text: 'é'.repeat(10) }), inputTimeoutMs({ kind: 'type', text: 'x'.repeat(10) }), 'counted in code points');
    assert.equal(inputTimeoutMs({ kind: 'click' }), undefined);
  });
});

// Second security review, finding 5: one long Type was one op, so a Stop,
// an expiry or a suspension that came while it ran did not stop the keys
// (on X11 xdotool goes on for up to a minute). The service now sends typed
// text in short pieces and checks the lease before each one.
describe('second review finding 5: typed text goes out in short pieces, the lease checked before each', () => {
  const { TYPE_CHUNK, typeChunks } = require('../src/gui/broker');
  const typed = (channel) => channel.requests.filter((r) => r.op === 'input').map((r) => r.params.action.text);
  const where = { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 };

  it('pieces of at most TYPE_CHUNK code points, in order, that join back into the text; never half a character', () => {
    assert.ok(TYPE_CHUNK >= 20 && TYPE_CHUNK <= 64, 'short enough that a Stop lands within about a second on the slowest backend');
    const text = `${'a'.repeat(TYPE_CHUNK - 1)}😀${'b'.repeat(TYPE_CHUNK)}é\nlast`;
    const chunks = typeChunks(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((c) => Array.from(c).length <= TYPE_CHUNK && c.length > 0));
    assert.equal(chunks[0], `${'a'.repeat(TYPE_CHUNK - 1)}😀`, 'the pair stays whole');
    assert.deepEqual(typeChunks('short'), ['short']);
    assert.deepEqual(typeChunks('x'.repeat(TYPE_CHUNK)), ['x'.repeat(TYPE_CHUNK)]);
    assert.equal(typeChunks('x'.repeat(2000)).length, Math.ceil(2000 / TYPE_CHUNK));
  });

  it('every piece is its own input op with the same expected set, and the lease is checked before each', async () => {
    let checks = 0;
    const leases = { assertUsable: () => { checks += 1; return { leaseId: 'l1' }; }, statusSummary: () => null, active: () => null, onHelperDisconnected() {}, setLocked() {} };
    const { b, channel } = broker({ leases });
    channel.connect();
    const text = 'k'.repeat(TYPE_CHUNK * 3 + 7);
    const out = await b.input({ kind: 'type', text }, where);
    assert.deepEqual(typed(channel), typeChunks(text));
    assert.equal(typed(channel).length, 4);
    assert.equal(checks, 4, 'one lease check immediately before each piece');
    const ops = channel.requests.filter((r) => r.op === 'input');
    for (const op of ops) assert.deepEqual(op.params.expect, ops[0].params.expect);
    assert.equal(out.afterMatches, true);
    // A key or a click is still one op and one check.
    checks = 0;
    channel.requests.length = 0;
    await b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, where);
    assert.deepEqual([checks, channel.requests.filter((r) => r.op === 'input').length], [1, 1]);
  });

  it('Stop while a long text is being typed: the piece in flight ends, and no further piece is sent', async () => {
    let stopped = false;
    const leases = {
      assertUsable: () => { if (stopped) throw new GuiError('lease_revoked', 'call RequestLease for a new lease'); return { leaseId: 'l1' }; },
      statusSummary: () => null, active: () => null, onHelperDisconnected() {}, setLocked() {}
    };
    let n = 0;
    const { b, channel } = broker({ leases, handlers: { input: async () => { n += 1; if (n === 2) stopped = true; return { foregroundBefore: CALC, foregroundAfter: CALC }; } } });
    channel.connect();
    const text = 'k'.repeat(TYPE_CHUNK * 5);
    const err = await b.input({ kind: 'type', text }, where).then(() => null, (e) => e);
    assert.equal(err.code, 'lease_revoked');
    assert.equal(typed(channel).length, 2, 'the two pieces that were sent before the Stop, and none after');
    // What was sent, exactly: the typed buffer is built from this.
    assert.deepEqual(err.typed, { sent: text.slice(0, TYPE_CHUNK * 2), inFlight: '' });
  });

  it('a piece that fails says what went before it and what was in flight; a refusal before any piece says nothing was sent', async () => {
    let n = 0;
    const failing = broker({ handlers: { input: async () => { n += 1; if (n === 3) throw new GuiError('op_timeout', 'input'); return { foregroundBefore: CALC, foregroundAfter: CALC }; } } });
    failing.channel.connect();
    const text = `${'a'.repeat(TYPE_CHUNK)}${'b'.repeat(TYPE_CHUNK)}${'c'.repeat(TYPE_CHUNK)}${'d'.repeat(9)}`;
    const err = await failing.b.input({ kind: 'type', text }, where).then(() => null, (e) => e);
    assert.equal(err.code, 'op_timeout');
    assert.deepEqual(err.typed, { sent: 'a'.repeat(TYPE_CHUNK) + 'b'.repeat(TYPE_CHUNK), inFlight: 'c'.repeat(TYPE_CHUNK) });
    assert.equal(typed(failing.channel).length, 3);
    // The process lookup failed: nothing was sent, whatever the code.
    const early = broker({ handlers: { processes: async () => { throw new GuiError('helper_disconnected'); } } });
    early.channel.connect();
    const none = await early.b.input({ kind: 'type', text: 'abc' }, where).then(() => null, (e) => e);
    assert.equal(none.code, 'helper_disconnected');
    assert.deepEqual(none.typed, { sent: '', inFlight: '' });
    // Only typed text carries this.
    const click = await early.b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, where).then(() => null, (e) => e);
    assert.equal(click.typed, undefined);
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

  // Demo takes spec §6.3 (final review I-3): a helper gone 30 s is lost; one back sooner is not.
  function fakeTimers() {
    let now = 0;
    let list = [];
    return {
      setTimeout(fn, ms) { const h = { fn, at: now + ms }; list.push(h); return h; },
      clearTimeout(h) { list = list.filter((x) => x !== h); },
      advance(ms) {
        now += ms;
        for (const due of list.filter((x) => x.at <= now)) { list = list.filter((x) => x !== due); due.fn(); }
      },
      pending: () => list.length
    };
  }

  it('helper_lost: closed 29 s then ready is nothing; closed 30 s is one helper_lost', () => {
    const timers = fakeTimers();
    const { b, channel } = broker({ timers });
    const lost = [];
    b.on('helper_lost', () => lost.push(true));
    channel.connect();
    channel.drop();
    timers.advance(29000);
    channel.connect();
    timers.advance(60000);
    assert.equal(lost.length, 0, 'a reconnect within 30 s changes nothing');
    assert.equal(timers.pending(), 0);
    channel.drop();
    channel.drop();
    timers.advance(29999);
    assert.equal(lost.length, 0);
    timers.advance(1);
    assert.equal(lost.length, 1, 'one helper_lost, however many closes');
    assert.equal(timers.pending(), 0);
    // stop() clears an armed timer.
    channel.connect();
    channel.drop();
    assert.equal(timers.pending(), 1);
    b.stop();
    assert.equal(timers.pending(), 0);
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

// Second security review, finding 4. A window with an owner (a Save As or a
// message box, a Find or Print dialog, a pop-up menu, a combo box's list)
// was left out of the window list, so the model was shown the window behind
// it and every click there was refused as obscured. The helper now lists
// them (`owned: true`); these run the broker over a fake helper. What must
// not change: a click lands only on the window the screenshot was of.
describe('second review finding 4: dialogs, menus and lists of a leased app can be seen and clicked', () => {
  const MAIN = { handle: 'w1', pid: 100, image: CALC.image, title: 'Untitled - Notes', bounds: { x: 0, y: 0, w: 1200, h: 800 }, scale: 1, minimized: false, owned: false };
  const DIALOG = { handle: 'w2', pid: 100, image: CALC.image, title: 'Save As', bounds: { x: 300, y: 200, w: 600, h: 400 }, scale: 1, minimized: false, owned: true };
  const MENU = { handle: 'w3', pid: 100, image: CALC.image, title: '', bounds: { x: 10, y: 30, w: 180, h: 260 }, scale: 1, minimized: false, owned: true };
  const fgOf = (w) => async () => ({ handle: w.handle, pid: w.pid, image: w.image, bounds: w.bounds, scale: 1 });
  const captured = (channel) => channel.requests.filter((r) => r.op === 'screenshot').map((r) => r.params.handle);
  const click = (b, target) => b.input({ kind: 'click', handle: target.handle, rel: target.rel, button: 'left', count: 1, mods: [] }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 });

  it('Save As is in front: the screenshot is of the dialog, and a click goes to the dialog\'s own handle', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [DIALOG, MAIN], foreground: fgOf(DIALOG), screenshot: async () => ({ mime: 'image/jpeg', width: 600, height: 400, data: 'AA==', transform: { sx: 1, sy: 1, unit: 'px' } }) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(captured(channel), ['w2']);
    const target = b.mapPoint('job-1', shot.screenshotId, 500, 350, ['calculator']);
    assert.deepEqual(target, { handle: 'w2', rel: [500, 350], appId: 'calculator' });
    await click(b, target);
    assert.equal(channel.requests.find((r) => r.op === 'input').params.action.handle, 'w2', 'the hit test is against the window that was shown');
    // The window behind it is offered by id, with its title as untrusted text.
    assert.deepEqual(shot.otherWindows, [{ window: 'win-1', title: 'Untitled - Notes', owned: false, width: 1200, height: 800 }]);
  });

  it('a foreground window of the app that the list does not hold is used itself', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [MAIN], foreground: fgOf(DIALOG) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(captured(channel), ['w2']);
    assert.equal(b.mapPoint('job-1', shot.screenshotId, 1, 1, ['calculator']).handle, 'w2');
    // Not when the foreground is another process's window: then it is the app's largest main window.
    const other = broker({ handlers: { windows: async () => [MENU, MAIN], foreground: async () => ({ handle: 'x9', pid: 4, image: 'C:\\Windows\\explorer.exe', bounds: { x: 0, y: 0, w: 5, h: 5 }, scale: 1 }) } });
    other.channel.connect();
    await other.b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(captured(other.channel), ['w1'], 'never a small owned window by default, and never a window of another process');
  });

  it('a menu is open over the main window: the default screenshot is still the main window, and names the menu so the model can ask for it', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [MENU, MAIN], foreground: fgOf(MAIN) } });
    channel.connect();
    const main = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(captured(channel), ['w1']);
    assert.deepEqual(main.otherWindows, [{ window: 'win-1', title: '', owned: true, width: 180, height: 260 }]);
    // Asked for by id: the menu itself, and a click on it carries the menu's handle.
    const menu = await b.screenshot({ app: 'calculator', window: 'win-1' }, ctx);
    assert.deepEqual(captured(channel), ['w1', 'w3']);
    const target = b.mapPoint('job-1', menu.screenshotId, 20, 40, ['calculator']);
    assert.equal(target.handle, 'w3');
    await click(b, target);
    assert.equal(channel.requests.filter((r) => r.op === 'input').pop().params.action.handle, 'w3');
    // The same window keeps its id from one screenshot to the next.
    assert.deepEqual(menu.otherWindows.map((w) => w.window), ['win-2']);
    assert.deepEqual((await b.screenshot({ app: 'calculator' }, ctx)).otherWindows.map((w) => w.window), ['win-1']);
  });

  it('a window id is good only for a window the helper still lists for that app, in the job it was given to', async () => {
    let list = [MENU, MAIN];
    const { b, channel } = broker({ handlers: { windows: async () => list, foreground: fgOf(MAIN) } });
    channel.connect();
    await b.screenshot({ app: 'calculator' }, ctx);
    assert.equal(await code(b.screenshot({ app: 'calculator', window: 'win-1' }, { jobId: 'job-2', leaseId: null })), 'stale_screenshot', 'another job\'s id');
    assert.equal(await code(b.screenshot({ app: 'calculator', window: 'win-77' }, ctx)), 'stale_screenshot', 'an id nobody was given');
    list = [MAIN];
    assert.equal(await code(b.screenshot({ app: 'calculator', window: 'win-1' }, ctx)), 'stale_screenshot', 'the menu closed');
    list = [{ ...MENU, minimized: true }, MAIN];
    assert.equal(await code(b.screenshot({ app: 'calculator', window: 'win-1' }, ctx)), 'stale_screenshot');
    assert.deepEqual(captured(channel), ['w1'], 'nothing was captured for a refused id');
  });

  it('a window the helper lists for a process that is not the app\'s is never offered or captured', async () => {
    const foreign = { ...DIALOG, handle: 'x7', pid: 4444 };
    const { b, channel } = broker({ handlers: { windows: async () => [foreign, MAIN], foreground: fgOf(MAIN) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(shot.otherWindows, []);
    assert.deepEqual(captured(channel), ['w1']);
  });

  it('point_obscured tells the model to take a new screenshot, and names the app\'s own window that covers the point', async () => {
    const obscured = (detail) => async () => { throw new GuiError('point_obscured', null, { info: detail }); };
    const { b, channel } = broker({ handlers: { windows: async () => [MENU, MAIN], foreground: fgOf(MAIN), input: obscured({ image: CALC.image, pid: 100, covering: { handle: 'w3', pid: 100 } }) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    const target = b.mapPoint('job-1', shot.screenshotId, 20, 40, ['calculator']);
    await assert.rejects(click(b, target), (e) => e.code === 'point_obscured'
      && /take a new screenshot/.test(e.message) && /Screenshot with window "win-1"/.test(e.message) && e.info.pid === 100);
    // A window of another process over the point: a new screenshot, and no id.
    const foreign = broker({ handlers: { input: obscured({ covering: { handle: 'x9', pid: 4 } }) } });
    foreign.channel.connect();
    const s2 = await foreign.b.screenshot({ app: 'calculator' }, ctx);
    await assert.rejects(click(foreign.b, foreign.b.mapPoint('job-1', s2.screenshotId, 5, 5, ['calculator'])), (e) => e.code === 'point_obscured'
      && /take a new screenshot/.test(e.message) && !/win-/.test(e.message));
    // A helper that says nothing about what covers it (macOS, an older helper): the same advice.
    const silent = broker({ handlers: { input: obscured({}) } });
    silent.channel.connect();
    const s3 = await silent.b.screenshot({ app: 'calculator' }, ctx);
    await assert.rejects(click(silent.b, silent.b.mapPoint('job-1', s3.screenshotId, 5, 5, ['calculator'])), (e) => e.code === 'point_obscured' && /take a new screenshot/.test(e.message));
    assert.equal(suspendsLease('point_obscured'), false);
  });

  it('a resume focuses the app\'s main window, not a list or a menu that happens to be first', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [MENU, MAIN] } });
    channel.connect();
    await b.focusApp(['calculator']);
    assert.equal(channel.requests.find((r) => r.op === 'focus').params.handle, 'w1');
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
    // (The window is that process's own: the broker drops a listed window of any other pid.)
    const mine = { handle: 'w1', pid: 555, image: CALC.image, title: 'Calculator', bounds: { x: 0, y: 0, w: 800, h: 600 }, scale: 1, minimized: false };
    const { b, channel } = broker({ handlers: { processes: async () => [{ pid: 555, image: CALC.image }], windows: async () => [mine], foreground: async () => mine } });
    channel.connect();
    const none = { jobId: null, leaseId: null };
    await b.launch({ tier: 'routine', reason: 'allowlisted', appId: 'calculator', exe: 'C:\\Windows\\System32\\calc.exe', argv: [], files: [], match: [] }, none, { approvedBy: 'allowlist' });
    await b.close('calculator', true, none);
    assert.deepEqual(channel.requests.filter((r) => r.op === 'close').map((r) => r.params), [{ pids: [555], force: false }], 'never a kill');
    const shot = await b.screenshot({ app: 'calculator' }, none);
    assert.match(shot.screenshotId, /^ss-\d+$/);
    assert.deepEqual(shot.otherWindows, [], 'and no window ids');
    assert.equal(b.windowIds.size, 0);
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

describe('the take ops: launch_browser, record_start, record_stop, keep_awake', () => {
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const takeConfig = parseGuiConfig({ enabled: true, apps: { ...APPS, chrome: { name: 'Chrome', path: CHROME } }, browser: 'chrome' }, { platform: 'win32' });
  const takeHandlers = {
    launch_browser: async () => ({ pid: 4242, cdp: { port: 9333, path: '/devtools/browser/abc' } }),
    record_start: async () => ({ pid: 777, startedAt: '2026-09-23T18:00:01.000Z', path: 'C:\\rec\\tk-1\\take.mp4' }),
    record_stop: async () => ({ path: 'C:\\rec\\take.mp4', durationS: 12.5, bytes: 123456, truncated: false }),
    keep_awake: async ({ on }) => ({ on })
  };

  it('launchBrowser sends launch_browser with a 15 s timeout, records the pid under the browser app id and audits gui.browser.launch', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    const result = await b.launchBrowser({ exe: CHROME, profile: 'demo', args: ['--window-size=1280,720'] }, ctx);
    assert.deepEqual(result, { pid: 4242, cdp: { port: 9333, path: '/devtools/browser/abc' } });
    const sent = channel.requests.find((r) => r.op === 'launch_browser');
    assert.deepEqual(sent.params, { exe: CHROME, profile: 'demo', args: ['--window-size=1280,720'] });
    assert.deepEqual(Object.keys(sent.params).sort(), ['args', 'exe', 'profile'], 'no profile_dir or profileDir on the wire');
    assert.deepEqual(sent.opts, { jobId: 'job-1', timeoutMs: 15000 });
    assert.deepEqual([...b.launched.get('job-1').get('chrome')], [4242]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits.filter((a) => a.kind === 'gui.browser.launch'), [{ kind: 'gui.browser.launch', data: { job_id: 'job-1', exe: CHROME, pid: 4242 } }]);
  });

  it('launchBrowser with no job id keeps no pid', async () => {
    const { b, channel } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    await b.launchBrowser({ exe: CHROME, profile: 'demo' }, { jobId: null });
    assert.equal(b.launched.size, 0);
    assert.deepEqual(channel.requests.find((r) => r.op === 'launch_browser').params.args, []);
  });

  it('launchBrowser with no gui.browser refuses invalid_params and sends nothing', async () => {
    const { b, channel } = broker({ handlers: takeHandlers });
    channel.connect();
    assert.equal(await code(b.launchBrowser({ exe: CHROME, profile: 'demo' }, ctx)), 'invalid_params');
    assert.deepEqual(channel.requests.filter((r) => r.op === 'launch_browser'), []);
  });

  it('a failed launch_browser throws its code and audits nothing', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: { ...takeHandlers, launch_browser: async () => { throw new GuiError('browser_launch_failed', 'x'); } } });
    channel.connect();
    assert.equal(await code(b.launchBrowser({ exe: CHROME, profile: 'demo' }, ctx)), 'browser_launch_failed');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits, []);
  });

  it('recordStart sends record_start with take_id, returns the helper result and audits gui.record.start', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    const result = await b.recordStart({ ffmpeg: 'C:\\ffmpeg\\ffmpeg.exe', takeId: 'tk-1', path: 'C:\\rec\\take.mp4', fps: 30, size: '1280x720' }, ctx);
    assert.deepEqual(result, { pid: 777, startedAt: '2026-09-23T18:00:01.000Z', path: 'C:\\rec\\tk-1\\take.mp4' });
    const sent = channel.requests.find((r) => r.op === 'record_start');
    assert.deepEqual(sent.params, { ffmpeg: 'C:\\ffmpeg\\ffmpeg.exe', take_id: 'tk-1', path: 'C:\\rec\\take.mp4', fps: 30, size: '1280x720' });
    assert.deepEqual(sent.opts, { jobId: 'job-1' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits.filter((a) => a.kind === 'gui.record.start'), [{ kind: 'gui.record.start', data: { job_id: 'job-1', pid: 777 } }]);
  });

  it('recordStart leaves ffmpeg and path off the wire when not given', async () => {
    const { b, channel } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    await b.recordStart({ takeId: 'tk-1', fps: 30 }, ctx);
    const sent = channel.requests.find((r) => r.op === 'record_start').params;
    assert.ok(!('ffmpeg' in sent) && !('path' in sent));
    assert.equal(sent.take_id, 'tk-1');
  });

  it('recordStart with no integer pid in the result is recorder_failed and audits nothing', async () => {
    for (const answer of [null, {}, { pid: '777' }]) {
      const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: { ...takeHandlers, record_start: async () => answer } });
      channel.connect();
      assert.equal(await code(b.recordStart({ takeId: 'tk-1' }, ctx)), 'recorder_failed');
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(audits, []);
    }
  });

  it('recorder() is the ffmpeg the connected helper reported, else null', () => {
    const { b, channel } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    assert.equal(b.recorder(), null, 'no helper');
    channel.connect({ ...INFO, recorder: { ffmpeg: 'C:\\ffmpeg\\bin\\ffmpeg.exe' } });
    assert.equal(b.recorder(), 'C:\\ffmpeg\\bin\\ffmpeg.exe');
    channel.drop();
    channel.connect({ ...INFO, recorder: { ffmpeg: null } });
    assert.equal(b.recorder(), null, 'the helper found none');
    channel.drop();
    assert.equal(b.recorder(), null);
  });

  it('the channel keeps only an absolute, plain-line recorder.ffmpeg from the probe', () => {
    const { sanitizeProbe } = require('../src/gui/helper-channel');
    const ffmpeg = (v) => sanitizeProbe({ recorder: { ffmpeg: v } }).recorder.ffmpeg;
    assert.equal(ffmpeg('C:\\ffmpeg\\bin\\ffmpeg.exe'), 'C:\\ffmpeg\\bin\\ffmpeg.exe');
    assert.equal(ffmpeg('/usr/bin/ffmpeg'), '/usr/bin/ffmpeg');
    for (const bad of ['ffmpeg.exe', 'C:\\a\nb.exe', 'C:\\' + 'x'.repeat(1100), 42, null, undefined]) assert.equal(ffmpeg(bad), null);
    assert.equal(ffmpeg('C:\\ffmpeg\\\u202Eexe.gepmff'), null, 'a bidi override is not one plain line');
    assert.equal(ffmpeg('\\\\server\\share\\ffmpeg.exe'), null, 'UNC');
    assert.equal(ffmpeg('\\\\?\\C:\\ffmpeg\\ffmpeg.exe'), null, 'device path');
    assert.equal(ffmpeg('//server/share/ffmpeg'), null, 'POSIX-spelled UNC');
    assert.equal(ffmpeg('C:ffmpeg.exe'), null, 'drive-relative');
    assert.equal(sanitizeProbe({}).recorder.ffmpeg, null);
  });

  it('recordStop sends record_stop with a 20 s timeout and audits gui.record.stop with duration_s', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    const result = await b.recordStop({ pid: 777 }, ctx);
    assert.deepEqual(result, { path: 'C:\\rec\\take.mp4', durationS: 12.5, bytes: 123456, truncated: false });
    const sent = channel.requests.find((r) => r.op === 'record_stop');
    assert.deepEqual(sent.params, { pid: 777 });
    assert.equal(sent.opts.timeoutMs, 20000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits.filter((a) => a.kind === 'gui.record.stop'), [{ kind: 'gui.record.stop', data: { job_id: 'job-1', pid: 777, duration_s: 12.5, bytes: 123456, truncated: false } }]);
  });

  // Minor 6: a recording whose record_start the service gave up on is stopped by its take id.
  it('recordStop by take id sends { take_id } alone, and audits it', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    await b.recordStop({ takeId: 'take-0123456789ab' }, ctx);
    assert.deepEqual(channel.requests.find((r) => r.op === 'record_stop').params, { take_id: 'take-0123456789ab' });
    await new Promise((r) => setImmediate(r));
    assert.equal(audits.find((a) => a.kind === 'gui.record.stop').data.take_id, 'take-0123456789ab');
    await assert.rejects(b.recordStop({}, ctx), (e) => e.code === 'invalid_params');
  });

  it('keepAwake sends keep_awake and audits nothing', async () => {
    const { b, channel, audits } = broker({ guiConfig: takeConfig, handlers: takeHandlers });
    channel.connect();
    assert.deepEqual(await b.keepAwake(true, ctx), { on: true });
    assert.deepEqual(await b.keepAwake(false), { on: false });
    assert.deepEqual(channel.requests.filter((r) => r.op === 'keep_awake').map((r) => [r.params, r.opts]), [[{ on: true }, { jobId: 'job-1' }], [{ on: false }, { jobId: undefined }]]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits, []);
  });

  it('OP_TIMEOUTS gives launch_browser 15 s and record_stop 20 s', () => {
    const { OP_TIMEOUTS } = require('../src/gui/helper-channel');
    assert.equal(OP_TIMEOUTS.launch_browser, 15000);
    assert.equal(OP_TIMEOUTS.record_stop, 20000);
  });
});
