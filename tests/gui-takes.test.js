// tests/gui-takes.test.js
// TakeManager and the Take tool (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §5, §6, §9): a real LeaseManager with a fake relay and phone, a fake broker, a temp TakeStore.
const { describe, it, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { open } = require('../src/approvals/envelope');
const { LeaseManager } = require('../src/gui/leases');
const { parseGuiConfig } = require('../src/gui/config');
const { TakeStore } = require('../src/gui/take-store');
const { createTakeHolder } = require('../src/gui/take-holder');
const { TakeManager, SILENT_MS } = require('../src/gui/takes');
const { buildGuiTools } = require('../src/gui/tools');
const { GUI_TOOL_NAMES, GUI_ERROR_CODES, TAKE_TOOL_NAME } = require('../src/gui/errors');
const { TAKE_CODES } = require('../src/gui/take-policy');
const { REFUSE_UNSAFE_MESSAGE } = require('../src/approvals/executor-options');
const { setLogLevel } = require('../src/logging');
const { CHROME_FLAGS } = require('../src/browser/chrome-flags');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');
const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

const guiConfig = parseGuiConfig({
  enabled: true,
  apps: {
    chrome: { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', processes: ['chrome.exe'] },
    notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' }
  },
  take: { enabled: true, max_minutes: 180 },
  browser: 'chrome'
}, { platform: 'win32' });
const ORIGIN = { client: 'stdio-mcp', session: null, job_id: 'job-1' };
const FFMPEG = 'C:\\ffmpeg\\ffmpeg.exe';

function fakeTimers(clock) {
  let list = [];
  return {
    setTimeout(fn, ms) { const t = { fn, at: clock.now() + ms }; list.push(t); return t; },
    clearTimeout(t) { list = list.filter((x) => x !== t); },
    advance(ms) {
      clock.t += ms;
      for (;;) {
        const due = list.filter((x) => x.at <= clock.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        list = list.filter((x) => x !== due);
        due.fn();
      }
    },
    pending: () => list.length
  };
}

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; }
  isConnected() { return true; }
  async send(envelope, opts = {}) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  registerMethod() {}
  last(type) { return [...this.sent].reverse().find((s) => s.message.type === type); }
  all(type) { return this.sent.filter((s) => s.message.type === type); }
}

function fakeBroker() {
  // An emitter, as the real broker is: TakeManager listens for helper_lost.
  const b = Object.assign(new EventEmitter(), {
    calls: [],
    ffmpeg: FFMPEG,
    launchFails: null,
    stopResult: null,
    // A pending promise here holds that op until it settles (a lease ending mid-start).
    gate: {},
    launchResult: null,
    closed: [],
    recorder: () => b.ffmpeg,
    releaseAll: async () => {},
    capability: () => ({ limits: [] }),
    leaseChanged: () => {},
    focusApp: async () => {},
    async launchBrowser(req, ctx) {
      b.calls.push(['launchBrowser', req, ctx]);
      if (b.gate.launch) await b.gate.launch;
      if (b.launchFails) throw b.launchFails;
      return b.launchResult || { pid: 7, cdp: { port: 9222, path: '/x' } };
    },
    async recordStart(req, ctx) {
      b.calls.push(['recordStart', req, ctx]);
      if (b.gate.record) await b.gate.record;
      if (b.recordFails) throw b.recordFails;
      return { pid: 8, startedAt: 1000, path: req.path || 'C:\\rec\\take.mp4' };
    },
    async recordStop(req, ctx) {
      b.calls.push(['recordStop', req, ctx]);
      if (b.gate.stop) await b.gate.stop;
      return b.stopResult || { path: 'C:\\rec\\take.mp4', durationS: 12, bytes: 1000, truncated: false };
    },
    async keepAwake(on, ctx) { b.calls.push(['keepAwake', on, ctx]); return { on }; },
    async closeLaunched(pid, ctx) { b.closed.push([pid, ctx]); return { closed: [pid] }; }
  });
  return b;
}

const names = (calls) => calls.map((c) => c[0]);
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

let phone;
let other;
let identity;
let relay;
let clock;
let timers;
let broker;
let audits;
let leases;
let store;
let takes;
let holder;
let registry;
let attached;
let cwd;
let order;
let hooks;
let closes;
let approverOn;

beforeEach(async () => {
  phone = createFakePhone({ name: 'Owner phone' });
  other = createFakePhone({ name: 'Second phone' });
  identity = testNodeIdentity({ key: 'gpu-box' });
  clock = { t: Date.parse('2026-10-24T18:00:00.000Z'), now() { return this.t; } };
  timers = fakeTimers(clock);
  const approvers = await approverStoreWith([phone.approverRecord(), other.approverRecord()], { now: () => clock.now() });
  cleanups.push(() => approvers.cleanup());
  relay = new FakeRelay();
  broker = fakeBroker();
  order = [];
  hooks = {};
  closes = [];
  approverOn = true;
  audits = [];
  const audit = { append: async (e) => { audits.push(e); } };
  leases = new LeaseManager({
    approvals: { identity, approverStore: approvers, relayClient: relay, phoneApprover: { isAvailable: () => approverOn } },
    guiConfig, broker, audit, nodeName: 'gpu-box', clock: () => clock.now(), timers, jobOpen: () => true
  });
  leases.start();
  cleanups.push(() => leases.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-takes-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  store = new TakeStore({ dir: path.join(dir, 'takes'), clock: () => clock.now() });
  registry = {
    set: new Map(), removed: [], profiles: new Map(),
    setBrowser(k, b) { order.push('setBrowser'); this.set.set(k, b); },
    setActiveProfile(k, name) { this.profiles.set(k, name); },
    removeBrowser(k) { this.removed.push(k); this.set.delete(k); this.profiles.delete(k); }
  };
  attached = [];
  const attachBrowser = async (cdpUrl) => {
    if (hooks.attach) await hooks.attach;
    if (hooks.attachFails) throw new Error('no CDP');
    const browser = { cdpUrl, stopped: false, page: { url: () => 'https://a.example.com' }, stop: async () => { browser.stopped = true; } };
    attached.push(browser);
    return browser;
  };
  takes = new TakeManager({ leases, broker, store, guiConfig, registry, audit, clock: () => clock.now(), timers, attachBrowser,
    closeBrowser: async (b) => { closes.push(b); if (hooks.closeFails) throw new Error('CDP close failed'); } });
  holder = createTakeHolder();
  const set = holder.set;
  holder.set = (policy) => { order.push('holder.set'); set(policy); };
});

afterEach(async () => { await takes.stopAll(); });

const PARAMS = { name: 'BSEOA demo', sites: ['*.example.com'], minutes: 30, profile: 'demo' };

function begin(params = {}, extra = {}) {
  return takes.start({ jobId: 'job-1', origin: ORIGIN, nodeLocalOrigin: true, holder, params: { ...PARAMS, ...params }, workingDirectory: cwd, ...extra });
}

async function started(params = {}, extra = {}) {
  const p = begin(params, extra);
  await tick();
  const req = relay.last('kl.lease.request');
  leases.onGrant(phone.leaseGrant(req.envelope, { minutes: params.minutes || 30 }));
  return p;
}

describe('TakeManager.start', () => {
  it('start: request → grant → browser → recorder → keep awake → live', async () => {
    const out = await started();
    assert.deepEqual(names(broker.calls), ['launchBrowser', 'recordStart', 'keepAwake']);
    assert.deepEqual(broker.calls[0][1], { exe: guiConfig.apps.chrome.path, profile: 'demo', args: [...CHROME_FLAGS] }, 'the fleet passes CHROME_FLAGS to the helper');
    assert.deepEqual(broker.calls[0][2], { jobId: 'job-1' });
    assert.equal(broker.calls[1][1].ffmpeg, FFMPEG);
    assert.equal(broker.calls[1][1].takeId, out.take_id);
    assert.equal(broker.calls[1][1].path, undefined, 'the helper picks its own default');
    assert.equal(broker.calls[1][1].maxS, 30 * 60 + 60, 'ffmpeg bounds the file at the approved minutes plus one');
    assert.equal(broker.calls[2][1], true);
    assert.equal(attached[0].cdpUrl, 'http://127.0.0.1:9222');
    assert.equal(registry.set.get(`take:${out.take_id}`), attached[0]);
    assert.ok(holder.current, 'the take policy is set');
    assert.deepEqual(order, ['setBrowser', 'holder.set'], 'the browser is registered before any call can be approved for it');
    assert.equal(holder.current.browserKey, `take:${out.take_id}`);
    const lease = leases.current();
    assert.equal(lease.kind, 'take');
    const req = relay.last('kl.lease.request').message.lease;
    assert.equal(req.apps[0].id, guiConfig.browser);
    assert.equal(req.unattended, true);
    assert.equal(req.name, 'BSEOA demo');
    const record = store.get(out.take_id);
    assert.equal(record.state, 'live');
    assert.equal(record.grant.expires_at, new Date(lease.expiresAt).toISOString());
    assert.deepEqual(record.grant.sites, ['*.example.com']);
    assert.equal(store.summary(record).lease.expires_at, record.grant.expires_at);
    assert.deepEqual(out, {
      take_id: out.take_id, lease_id: lease.leaseId, granted_minutes: 30, expires_at: record.grant.expires_at,
      browser: { profile: 'demo', cdp: true }, recording: { path: 'C:\\rec\\take.mp4', started_at: new Date(1000).toISOString() }
    });
    assert.equal(record.recording.path, 'C:\\rec\\take.mp4');
    assert.deepEqual(record.recorder, { pid: 8, started_at: new Date(1000).toISOString() }, 'the record keeps the recorder pid');
    assert.equal(takes.live().take_id, out.take_id);
    assert.equal(takes.forJob('job-1').take_id, out.take_id);
  });

  it('a restart ends the last run\'s live take and kills its ffmpeg only while that pid is still ffmpeg', async () => {
    const out = await started({ minutes: 45 });
    assert.equal(broker.calls.find((c) => c[0] === 'recordStart')[1].maxS, 45 * 60 + 60);
    // A second record left live, whose pid now belongs to something else.
    const reused = store.create({ name: 'Other', job_id: 'job-9', state: 'live', recorder: { pid: 99, started_at: new Date(1000).toISOString() } });
    const looked = [];
    const killed = [];
    const findProcess = (pid) => { looked.push(pid); return pid === 8 ? { image: 'ffmpeg.exe' } : { image: 'notepad.exe' }; };
    // The service died: a new manager over the same store.
    const restarted = new TakeManager({ leases, broker, store, guiConfig, registry, clock: () => clock.now(), timers, findProcess, kill: (pid) => killed.push(pid) });
    assert.deepEqual(looked.sort(), [8, 99]);
    assert.deepEqual(killed, [8], 'only the pid whose image is ffmpeg');
    assert.equal(store.get(out.take_id).ended.reason, 'service_restarted');
    assert.equal(store.get(reused.take_id).ended.reason, 'service_restarted');
    await restarted.stopAll();
  });

  it('the phone denies: nothing launched, record ended with the reason', async () => {
    const p = begin();
    await tick();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { decision: 'deny' }));
    await assert.rejects(p, (e) => e.code === 'lease_denied');
    assert.deepEqual(broker.calls, []);
    const [record] = store.list();
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'denied');
    assert.equal(record.log.at(-1).ended, 'denied');
    assert.equal(holder.current, null);
    assert.equal(takes.live(), null);
  });

  it('a second take is take_busy with the live name only', async () => {
    await started();
    await assert.rejects(
      takes.start({ jobId: 'job-2', origin: { ...ORIGIN, job_id: 'job-2' }, nodeLocalOrigin: true, holder: createTakeHolder(), params: { ...PARAMS, name: 'Other' }, workingDirectory: cwd }),
      (e) => e.code === 'take_busy' && e.message === 'take_busy: a take is already live: BSEOA demo'
    );
    assert.equal(relay.all('kl.lease.request').length, 1);
  });

  it('a non-local origin is refused before the request', async () => {
    await assert.rejects(begin({}, { nodeLocalOrigin: false }), (e) => e.code === 'take_requires_local_origin');
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.deepEqual(store.list(), []);
  });

  it('takes off in node.yaml, and parameters that do not hold, are refused before anything', async () => {
    const off = new TakeManager({ leases, broker, store, guiConfig: { ...guiConfig, take: { enabled: false, maxMinutes: 240 } }, registry, clock: () => clock.now(), timers });
    await assert.rejects(off.start({ jobId: 'job-1', origin: ORIGIN, nodeLocalOrigin: true, holder, params: PARAMS, workingDirectory: cwd }),
      (e) => e.code === 'invalid_params' && /takes are off in node\.yaml/.test(e.message));
    const bad = [
      { name: 'two\nlines' }, { name: 'x'.repeat(61) }, { sites: [] }, { sites: ['https://a.example.com'] },
      { sites: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) }, { minutes: 181 }, { minutes: 0 },
      { apps: ['nope'] }, { apps: ['chrome'] }, { profile: '../x' }, { browser: ['evaluate'] }, { record: { dir: '..' } },
      { record: { fps: 0 } }, { record: { size: { width: 641, height: 480 } } }
    ];
    for (const p of bad) await assert.rejects(begin(p), (e) => e.code === 'invalid_params', JSON.stringify(p));
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.deepEqual(store.list(), []);
  });

  it('no ffmpeg: recorder_missing before any request', async () => {
    broker.ffmpeg = null;
    await assert.rejects(begin(), (e) => e.code === 'recorder_missing' && /winget install Gyan\.FFmpeg/.test(e.message) && /gui\.recorder\.ffmpeg/.test(e.message));
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.deepEqual(store.list(), []);
  });

  it('gui.recorder.ffmpeg wins over what the helper reports', async () => {
    const named = new TakeManager({ leases, broker, store, guiConfig: { ...guiConfig, recorder: { ffmpeg: 'D:\\tools\\ffmpeg.exe' } }, registry, clock: () => clock.now(), timers, attachBrowser: async () => ({ page: null, stop: async () => {} }), closeBrowser: async () => {} });
    broker.ffmpeg = null;
    const p = named.start({ jobId: 'job-1', origin: ORIGIN, nodeLocalOrigin: true, holder, params: PARAMS, workingDirectory: cwd });
    await tick();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30 }));
    await p;
    assert.equal(broker.calls.find((c) => c[0] === 'recordStart')[1].ffmpeg, 'D:\\tools\\ffmpeg.exe');
    await named.stopAll();
  });

  it('record: false runs with no recorder', async () => {
    broker.ffmpeg = null;
    const out = await started({ record: false });
    assert.deepEqual(names(broker.calls), ['launchBrowser', 'keepAwake']);
    assert.equal(out.recording, null);
    const stopped = await takes.stop(out.take_id);
    assert.equal(stopped.recording, null);
    assert.ok(!names(broker.calls).includes('recordStop'));
  });

  it('record.dir under the working folder names the file; outside it is refused', async () => {
    await assert.rejects(begin({ record: { dir: path.dirname(cwd) } }), (e) => e.code === 'invalid_params');
    await assert.rejects(begin({ record: { dir: `${cwd}-other` } }), (e) => e.code === 'invalid_params');
    await assert.rejects(begin({ record: { dir: 'videos' } }, { workingDirectory: null }), (e) => e.code === 'invalid_params');
    const out = await started({ record: { dir: 'videos', fps: 24, size: { width: 1280, height: 720 } } });
    const req = broker.calls.find((c) => c[0] === 'recordStart')[1];
    assert.equal(req.path, path.join(cwd, 'videos', `${out.take_id}.mp4`));
    assert.equal(req.fps, 24);
    assert.deepEqual(req.size, { width: 1280, height: 720 });
    assert.equal(out.recording.path, req.path);
  });

  it('DevToolsActivePort never appears: browser_launch_failed, lease released, no recorder', async () => {
    const { GuiError } = require('../src/gui/errors');
    broker.launchFails = new GuiError('browser_launch_failed');
    await assert.rejects(started(), (e) => e.code === 'browser_launch_failed');
    assert.equal(leases.current(), null);
    assert.ok(!names(broker.calls).includes('recordStart'));
    const [record] = store.list();
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'browser_launch_failed');
    assert.equal(holder.current, null);
    assert.equal(takes.live(), null);
  });

  it('the phone keeps the apps but drops the browser: nothing launched, the take ends', async () => {
    const p = begin({ apps: ['notepad'] });
    await tick();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30, apps: ['notepad'] }));
    await assert.rejects(p, (e) => e.code === 'take_app_not_allowed');
    assert.deepEqual(broker.calls, []);
    assert.equal(leases.current(), null);
    assert.equal(store.list()[0].ended.reason, 'browser_not_granted');
  });
});

// The final review's fixes (I-2, I-3, I-4, minor 6).
describe('final review fixes', () => {
  it('I-2: the take\'s browser has the take\'s profile, so fill_credentials looks up browser_cred:<profile>:<host>; params.profile stays refused', async () => {
    const real = require('../src/tools/builtin/browser-registry');
    const { actions } = require('../src/tools/builtin/browser-tool');
    const mgr = new TakeManager({
      leases, broker, store, guiConfig, registry: real, audit: { append: async (e) => { audits.push(e); } }, clock: () => clock.now(), timers,
      attachBrowser: async () => ({ isRunning: true, page: { url: () => 'https://a.example.com/login' }, stop: async () => {} }), closeBrowser: async () => {}
    });
    try {
      const p = mgr.start({ jobId: 'job-1', origin: ORIGIN, nodeLocalOrigin: true, holder, params: { ...PARAMS, credentials: true }, workingDirectory: cwd });
      await tick();
      leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30 }));
      const out = await p;
      const key = `take:${out.take_id}`;
      assert.equal(real.activeProfileOf(key), 'demo');
      const asked = [];
      const res = await actions.fill_credentials({}, { browserKey: key, vault: { get: (k) => { asked.push(k); return null; } } });
      assert.equal(res.ok, false);
      assert.deepEqual(asked, ['browser_cred:demo:a.example.com']);
      const d = await holder.current.decide('BrowserSession', { action: 'fill_credentials', profile: 'other' });
      assert.equal(d.code, 'take_browser_managed');
      assert.equal((await holder.current.decide('BrowserSession', { action: 'fill_credentials' })).allow, true);
      await mgr.stop(out.take_id);
      assert.equal(real.activeProfileOf(key), null, 'the profile goes with the browser');
    } finally {
      await mgr.stopAll();
    }
  });

  it('I-2: the fake registry sees the profile set after the browser and before the policy', async () => {
    const out = await started();
    assert.equal(registry.profiles.get(`take:${out.take_id}`), 'demo');
  });

  it('I-3(a): a stop whose record_stop fails (the helper lost the recording) ends recorder_failed, never take_done', async () => {
    const { GuiError } = require('../src/gui/errors');
    const out = await started();
    broker.recordStop = async () => { throw new GuiError('unknown_recording'); };
    const stopped = await takes.stop(out.take_id);
    assert.equal(stopped.ended, 'recorder_failed');
    assert.equal(stopped.recording.duration_s, null);
    assert.equal(store.get(out.take_id).ended.reason, 'recorder_failed');
    assert.equal(leases.find(out.lease_id).endReason, 'recorder_failed');
    assert.equal(store.get(out.take_id).recording.path, 'C:\\rec\\take.mp4', 'the file is kept where it was');
    // A take with no recording asked for still ends take_done.
    const bare = await started({ record: false });
    assert.equal((await takes.stop(bare.take_id)).ended, 'take_done');
  });

  it('I-3(a): a stop whose recording had exited says so in the result (truncated, the duration known)', async () => {
    const out = await started();
    broker.stopResult = { path: 'C:\\rec\\take.mp4', durationS: 3, bytes: 10, truncated: true, exited: true };
    const stopped = await takes.stop(out.take_id);
    assert.deepEqual(stopped.recording, { path: 'C:\\rec\\take.mp4', duration_s: 3, bytes: 10, truncated: true });
    assert.equal(stopped.ended, 'recorder_failed');
  });

  it('I-3(b): helper_lost from the broker ends the live take helper_lost: holder cleared, lease ended by id, record ended, audited', async () => {
    const out = await started();
    const leaseId = leases.current().leaseId;
    broker.emit('helper_lost');
    await tick();
    await tick();
    const record = store.get(out.take_id);
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'helper_lost');
    assert.equal(record.log.at(-1).ended, 'helper_lost');
    assert.equal(holder.current, null);
    assert.equal(leases.find(leaseId).state, 'ended');
    assert.equal(leases.find(leaseId).endReason, 'helper_lost');
    assert.ok(audits.some((a) => a.kind === 'take.ended' && a.data.reason === 'helper_lost'));
    // With no live take it does nothing.
    broker.emit('helper_lost');
    await tick();
    assert.equal(store.get(out.take_id).ended.reason, 'helper_lost');
  });

  it('I-4: a take\'s lease.requested and lease.granted carry kind, name, sites, credentials and minutes, and no reason text', async () => {
    await started({ credentials: true, reason: 'Record the demo for the launch' });
    await tick();
    const requested = audits.find((a) => a.kind === 'lease.requested').data;
    const granted = audits.find((a) => a.kind === 'lease.granted').data;
    for (const data of [requested, granted]) {
      assert.equal(data.kind, 'take');
      assert.equal(data.name, 'BSEOA demo');
      assert.deepEqual(data.sites, ['*.example.com']);
      assert.equal(data.credentials, true);
      assert.equal(data.minutes, 30);
      assert.ok(!JSON.stringify(data).includes('Record the demo'), 'the reason is not in the ledger');
    }
    assert.ok(audits.filter((a) => a.kind.startsWith('lease.')).every((a) => a.data.kind === 'take'), 'every lease entry names its kind');
  });

  it('minor 6: a record_start that fails after the take id was sent is stopped by that take id before recorder_failed', async () => {
    const { GuiError } = require('../src/gui/errors');
    broker.recordFails = new GuiError('op_timeout', 'record_start took over 10000 ms');
    await assert.rejects(started(), (e) => e.code === 'recorder_failed');
    const [record] = store.list();
    const stops = broker.calls.filter((c) => c[0] === 'recordStop');
    assert.deepEqual(stops.map((c) => c[1]), [{ takeId: record.take_id }]);
    assert.equal(record.ended.reason, 'recorder_failed');
  });
});

describe('ending a take', () => {
  it('stop: recorder stopped, awake off, browser stopped, holder cleared, lease ended, result has path/duration/bytes', async () => {
    const out = await started();
    const lease = leases.current();
    const stopped = await takes.stop(out.take_id);
    assert.deepEqual(names(broker.calls), ['launchBrowser', 'recordStart', 'keepAwake', 'recordStop', 'keepAwake']);
    assert.deepEqual(broker.calls[3][1], { pid: 8 });
    assert.equal(broker.calls[4][1], false);
    assert.equal(attached[0].stopped, true);
    assert.deepEqual(registry.removed, [`take:${out.take_id}`]);
    assert.equal(holder.current, null);
    assert.equal(lease.state, 'ended');
    assert.equal(lease.endReason, 'take_done');
    assert.deepEqual(stopped, { recording: { path: 'C:\\rec\\take.mp4', duration_s: 12, bytes: 1000 }, steps: { done: 0, failed: 0, total: 0 }, ended: 'take_done' });
    const record = store.get(out.take_id);
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'take_done');
    assert.equal(record.recording.duration_s, 12);
    assert.equal(record.log.filter((l) => l.ended).length, 1);
    assert.equal(takes.live(), null);
    await tick();
    const ended = audits.filter((a) => a.kind === 'take.ended');
    assert.deepEqual(ended.map((a) => a.data), [{ take_id: out.take_id, job_id: 'job-1', reason: 'take_done' }]);
    // Idempotent: a second end changes nothing.
    await takes.end(out.take_id, 'service_stopped');
    assert.equal(store.get(out.take_id).ended.reason, 'take_done');
    assert.equal(names(broker.calls).filter((n) => n === 'recordStop').length, 1);
  });

  it('a teardown step that throws does not stop the rest', async () => {
    const out = await started();
    broker.recordStop = async () => { throw new Error('helper gone'); };
    await takes.stop(out.take_id);
    assert.equal(attached[0].stopped, true);
    assert.equal(holder.current, null);
    assert.equal(leases.current(), null);
    const record = store.get(out.take_id);
    assert.equal(record.state, 'ended');
    assert.equal(record.recording.path, 'C:\\rec\\take.mp4', 'the file is kept where it was');
  });

  it('a revoke from any phone ends the take', async () => {
    const out = await started();
    const lease = leases.current();
    leases.onRevoke(other.leaseRevoke(identity.nodeId, lease.leaseId));
    await tick();
    await tick();
    const record = store.get(out.take_id);
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'revoked');
    assert.ok(names(broker.calls).includes('recordStop'));
    assert.equal(holder.current, null);
  });

  it('turn end arms 30 minutes; a turn start disarms; silence ends it driver_silent with the file kept', async () => {
    const out = await started({ minutes: 120 });
    takes.onTurnEnd('job-1');
    assert.equal(store.get(out.take_id).state, 'waiting');
    timers.advance(SILENT_MS - 1000);
    takes.onTurnStart('job-1');
    assert.equal(store.get(out.take_id).state, 'live');
    timers.advance(SILENT_MS);
    assert.equal(store.get(out.take_id).state, 'live', 'disarmed');
    takes.onTurnEnd('job-1');
    timers.advance(SILENT_MS);
    await tick();
    await tick();
    const record = store.get(out.take_id);
    assert.equal(record.state, 'ended');
    assert.equal(record.ended.reason, 'driver_silent');
    assert.equal(record.recording.path, 'C:\\rec\\take.mp4');
    assert.equal(SILENT_MS, 30 * 60000);
  });

  it('the recorder exiting early ends the take recorder_failed and keeps the path', async () => {
    let out = await started();
    broker.stopResult = { path: 'C:\\rec\\take.mp4', durationS: 3, bytes: 10, truncated: true, exited: true };
    const stopped = await takes.stop(out.take_id);
    assert.equal(stopped.ended, 'recorder_failed');
    assert.equal(store.get(out.take_id).ended.reason, 'recorder_failed');
    assert.equal(stopped.recording.path, 'C:\\rec\\take.mp4');
    // The helper's word that ffmpeg is gone ends a live take at once.
    broker.stopResult = null;
    out = await started();
    await takes.onRecorderExit(8, 1);
    assert.equal(store.get(out.take_id).ended.reason, 'recorder_failed');
    assert.equal(store.get(out.take_id).recording.path, 'C:\\rec\\take.mp4');
  });

  it('screen lock ends the take screen_locked', async () => {
    const out = await started();
    leases.setLocked(true);
    await tick();
    await tick();
    assert.equal(store.get(out.take_id).ended.reason, 'screen_locked');
    assert.equal(leases.current(), null);
  });

  it('endForJob and stopAll end the live take with their reasons; a take left live at a restart is ended', async () => {
    let out = await started();
    await takes.endForJob('job-1', 'job_closed');
    assert.equal(store.get(out.take_id).ended.reason, 'job_closed');
    out = await started();
    await takes.stopAll();
    assert.equal(store.get(out.take_id).ended.reason, 'service_stopped');
    assert.equal(takes.summaryFor('job-1').state, 'ended');
    assert.equal(takes.summaryFor('job-9'), null);
    // get_job asks summaryFor on every call: a job with no take reads no file.
    const realList = store.list.bind(store);
    const realGet = store.get.bind(store);
    let reads = 0;
    store.list = () => { reads += 1; return realList(); };
    store.get = (id) => { reads += 1; return realGet(id); };
    try {
      assert.equal(takes.summaryFor('job-9'), null);
      assert.equal(reads, 0, 'no folder scan, no record read');
    } finally {
      store.list = realList;
      store.get = realGet;
    }
    const left = store.create({ name: 'left', job_id: 'job-3', state: 'live' });
    new TakeManager({ leases, broker, store, guiConfig, registry, clock: () => clock.now(), timers });
    assert.equal(store.get(left.take_id).ended.reason, 'service_restarted');
  });

  it('note appends one plain line to the log; status says the state and the lease time left', async () => {
    const out = await started();
    takes.note(out.take_id, 'Closed a cookie banner');
    assert.equal(store.get(out.take_id).log.at(-1).text, 'Closed a cookie banner');
    assert.throws(() => takes.note(out.take_id, 'a\nb'), (e) => e.code === 'invalid_params');
    assert.throws(() => takes.note(out.take_id, 'x'.repeat(501)), (e) => e.code === 'invalid_params');
    clock.t += 60000;
    const s = await takes.status(out.take_id);
    assert.equal(s.state, 'live');
    assert.equal(s.lease.left_s, 29 * 60);
    assert.equal(s.recording.path, 'C:\\rec\\take.mp4');
  });
});

describe('a take ends cleanly, whatever it holds', () => {
  const leaseNow = () => leases.current();
  const revoke = () => leases.onRevoke(other.leaseRevoke(identity.nodeId, leaseNow().leaseId));
  async function granting(params = {}) {
    const p = begin(params);
    await tick();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30 }));
    return p;
  }

  it('from the instant it ends the policy approves nothing, even while the recorder is stopping', async () => {
    const out = await started();
    const policy = holder.current;
    assert.equal((await policy.decide('BrowserPage', { action: 'screenshot' })).allow, true);
    const gate = deferred();
    broker.gate.stop = gate.promise;
    const stopping = takes.stop(out.take_id);
    assert.equal(holder.current, null, 'the holder is cleared before anything is awaited');
    assert.deepEqual(await policy.decide('BrowserPage', { action: 'screenshot' }), { allow: false, code: 'take_ended', error: 'the take has ended' });
    assert.equal(registry.set.has(`take:${out.take_id}`), true, 'still registered while recordStop waits');
    gate.resolve();
    await stopping;
    assert.equal(registry.set.has(`take:${out.take_id}`), false);
  });

  it('the take mints its lease id and ends exactly that lease', async () => {
    const asked = [];
    const request = leases.request.bind(leases);
    leases.request = (args) => { asked.push(args.leaseId); return request(args); };
    const out = await started();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    assert.equal(out.lease_id, asked[0]);
    assert.equal(relay.last('kl.lease.request').message.lease_id, asked[0]);
    await takes.stop(out.take_id);
    assert.equal(leases.find(asked[0]).state, 'ended');
    assert.equal(leases.find(asked[0]).endReason, 'take_done');
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['notepad'], minutes: 5, reason: 'x', leaseId: asked[0] }),
      (e) => e.code === 'invalid_params', 'an id already used is refused');
  });

  it('a job holding a computer_use lease gets lease_busy, and that lease survives', async () => {
    const cu = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['notepad'], minutes: 10, reason: 'other work' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 }));
    const held = await cu;
    await assert.rejects(begin(), (e) => e.code === 'lease_busy');
    assert.equal(held.state, 'active');
    assert.equal(leases.current(), held);
    assert.equal(store.list()[0].ended.reason, 'lease_busy');
  });

  it('a second take ending approval_unavailable records that reason, not the first take\'s', async () => {
    const first = await started();
    await takes.stop(first.take_id);
    approverOn = false;
    await assert.rejects(begin({ name: 'Second' }), (e) => e.code === 'approval_unavailable');
    const second = store.list().find((r) => r.name === 'Second');
    assert.equal(second.ended.reason, 'approval_unavailable');
    assert.equal(store.get(first.take_id).ended.reason, 'take_done');
  });

  it('attach fails: the launched Chrome is closed by its pid', async () => {
    hooks.attachFails = true;
    await assert.rejects(granting(), (e) => e.code === 'browser_launch_failed');
    assert.deepEqual(broker.closed, [[7, { jobId: 'job-1' }]]);
    assert.equal(leases.current(), null);
    assert.equal(store.list()[0].ended.reason, 'browser_launch_failed');
  });

  it('no debugging port: the launched Chrome is closed by its pid', async () => {
    broker.launchResult = { pid: 7, cdp: {} };
    await assert.rejects(granting(), (e) => e.code === 'browser_launch_failed');
    assert.deepEqual(broker.closed.map((c) => c[0]), [7]);
    assert.equal(attached.length, 0);
  });

  it('the lease ends while Chrome is launching: Chrome is closed by its pid, nothing else starts', async () => {
    const gate = deferred();
    broker.gate.launch = gate.promise;
    const p = granting();
    await tick();
    await tick();
    revoke();
    gate.resolve();
    await assert.rejects(p, (e) => e.code === 'lease_required');
    assert.deepEqual(broker.closed.map((c) => c[0]), [7]);
    assert.equal(attached.length, 0);
    assert.ok(!names(broker.calls).includes('recordStart'));
    assert.equal(store.list()[0].ended.reason, 'revoked');
    assert.equal(holder.current, null);
  });

  it('the lease ends while attaching: the browser is closed and unregistered, no recorder', async () => {
    const gate = deferred();
    hooks.attach = gate.promise;
    const p = granting();
    await tick();
    await tick();
    revoke();
    gate.resolve();
    await assert.rejects(p, (e) => e.code === 'lease_required');
    assert.equal(closes.length, 1, 'the late attach is closed over CDP too');
    assert.equal(attached[0].stopped, true);
    assert.equal(registry.set.size, 0);
    assert.deepEqual(broker.closed.map((c) => c[0]), [7], 'the ending found Chrome not attached yet and closed it by pid');
    assert.ok(!names(broker.calls).includes('recordStart'));
    assert.equal(holder.current, null);
  });

  it('the lease ends while the recorder starts: the recording is stopped and kept, the browser closed', async () => {
    const gate = deferred();
    broker.gate.record = gate.promise;
    const p = granting();
    for (let i = 0; i < 4; i += 1) await tick();
    assert.ok(names(broker.calls).includes('recordStart'));
    revoke();
    gate.resolve();
    await assert.rejects(p, (e) => e.code === 'lease_required');
    await takes.stopAll();
    assert.ok(names(broker.calls).includes('recordStop'));
    assert.equal(attached[0].stopped, true);
    assert.equal(registry.set.size, 0);
    const [record] = store.list();
    assert.equal(record.ended.reason, 'revoked');
    assert.equal(record.recording.path, 'C:\\rec\\take.mp4');
    assert.equal(holder.current, null);
  });

  it('the recorder fails after attach: browser closed, key removed, holder unset, lease released, recorder_failed', async () => {
    const { GuiError } = require('../src/gui/errors');
    broker.recordFails = new GuiError('recorder_failed');
    await assert.rejects(granting(), (e) => e.code === 'recorder_failed');
    assert.equal(closes.length, 1);
    assert.equal(attached[0].stopped, true);
    assert.equal(registry.set.size, 0);
    assert.equal(holder.current, null);
    assert.equal(leases.current(), null);
    assert.equal(store.list()[0].ended.reason, 'recorder_failed');
  });

  it('the CDP close fails on a stop: Chrome is closed by its pid; keep_browser leaves it running', async () => {
    let out = await started();
    hooks.closeFails = true;
    await takes.stop(out.take_id);
    assert.deepEqual(broker.closed.map((c) => c[0]), [7]);
    hooks.closeFails = false;
    broker.closed.length = 0;
    closes.length = 0;
    out = await started();
    await takes.stop(out.take_id, { keepBrowser: true });
    assert.deepEqual(closes, []);
    assert.deepEqual(broker.closed, []);
    assert.equal(attached.at(-1).stopped, true, 'only disconnected');
  });
});

describe('GuiBroker#closeLaunched', () => {
  const { GuiBroker } = require('../src/gui/broker');
  function brokerWith(exitAfterPolls, { poll = null } = {}) {
    const requests = [];
    let polls = 0;
    const channel = {
      on() {}, off() {},
      async request(op, params) {
        requests.push([op, params]);
        if (op === 'processes') {
          polls += 1;
          if (poll) return poll(polls);
          return polls > exitAfterPolls ? [] : [{ pid: 7 }];
        }
        if (op === 'close') return { closed: params.pids };
        return null;
      }
    };
    const b = new GuiBroker({ channel, guiConfig, platform: 'win32', timers, monotonic: () => clock.now() });
    b._recordLaunched('job-1', 'chrome', 7);
    return { b, requests };
  }
  const closes = (requests) => requests.filter((r) => r[0] === 'close').map((r) => r[1]);
  async function drive(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 40 && !done; i += 1) { await tick(); timers.advance(500); }
    return promise;
  }

  it('a Chrome that exits when asked is not forced', async () => {
    const { b, requests } = brokerWith(1);
    const out = await drive(b.closeLaunched(7, { jobId: 'job-1' }));
    assert.deepEqual(closes(requests), [{ pids: [7], force: false }]);
    assert.equal(out.forced, false);
  });

  it('a Chrome still running after 5 s is forced', async () => {
    const { b, requests } = brokerWith(Infinity);
    const start = clock.now();
    const out = await drive(b.closeLaunched(7, { jobId: 'job-1' }));
    assert.deepEqual(closes(requests), [{ pids: [7], force: false }, { pids: [7], force: true }]);
    assert.equal(out.forced, true);
    assert.ok(clock.now() - start >= 5000);
  });

  it('a slow poll counts against the 5 s: a listing that takes 6 s is not waited for', async () => {
    const { b, requests } = brokerWith(0, { poll: () => new Promise((resolve) => { timers.setTimeout(() => resolve([]), 6000); }) });
    const start = clock.now();
    const out = await drive(b.closeLaunched(7, { jobId: 'job-1' }));
    assert.equal(out.forced, true);
    assert.deepEqual(closes(requests).at(-1), { pids: [7], force: true });
    assert.ok(clock.now() - start <= 5500, `forced within the bound (${clock.now() - start} ms)`);
  });

  it('a poll that fails is doubt, and doubt forces', async () => {
    const { GuiError } = require('../src/gui/errors');
    const { b, requests } = brokerWith(0, { poll: () => { throw new GuiError('op_timeout'); } });
    const out = await drive(b.closeLaunched(7, { jobId: 'job-1' }));
    assert.equal(out.forced, true);
    assert.deepEqual(closes(requests), [{ pids: [7], force: false }, { pids: [7], force: true }]);
    assert.deepEqual(out.closed, [7]);
  });

  it('a pid the job did not launch is refused, and nothing is sent', async () => {
    const { b, requests } = brokerWith(0);
    await assert.rejects(b.closeLaunched(8, { jobId: 'job-1' }), (e) => e.code === 'invalid_params');
    await assert.rejects(b.closeLaunched(7, { jobId: 'job-2' }), (e) => e.code === 'invalid_params');
    assert.deepEqual(requests, []);
  });
});

describe('the Take tool', () => {
  const toolsWith = (extra = {}) => Object.fromEntries(buildGuiTools({ broker: {}, leases, guiConfig, takes, ...extra }).map((t) => [t.name, t]));
  const opts = (extra = {}) => ({ origin: ORIGIN, takePolicy: holder, nodeLocalOrigin: true, workingDirectory: cwd, ...extra });

  it('Take is in GUI_TOOL_NAMES and hidden from refuseUnsafe delegate turns', async () => {
    assert.ok(GUI_TOOL_NAMES.includes('Take'));
    assert.equal(TAKE_TOOL_NAME, 'Take');
    for (const code of TAKE_CODES) assert.ok(GUI_ERROR_CODES.includes(code), code);
    const { Take } = toolsWith();
    assert.equal(Take.requiresApproval, false);
    assert.deepEqual(Take.parameters.properties.action.enum, ['start', 'run_steps', 'status', 'note', 'stop']);
    const { delegateToolNames } = require('../src/fleet/delegate-sessions');
    const fakeRegistry = { list: () => [{ name: 'Take' }, { name: 'Read' }] };
    const offered = delegateToolNames(fakeRegistry, { refuseUnsafe: true });
    assert.ok(!offered.has('Take'));
    const refusing = Object.assign(async () => false, { refuseUnsafe: true });
    assert.deepEqual(await Take.execute({ action: 'start', ...PARAMS }, opts({ approvalRequester: refusing })), { ok: false, error: REFUSE_UNSAFE_MESSAGE });
    assert.equal(relay.all('kl.lease.request').length, 0);
  });

  it('start, status, note, stop through the tool; run_steps checks its steps; a case turn is refused', async () => {
    const { Take } = toolsWith();
    const p = Take.execute({ action: 'start', ...PARAMS }, opts());
    await tick();
    await tick();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30 }));
    const out = await p;
    assert.equal(out.ok, true);
    assert.match(out.take_id, /^take-/);
    const status = await Take.execute({ action: 'status' }, opts());
    assert.equal(status.ok, true);
    assert.equal(status.state, 'live');
    assert.equal((await Take.execute({ action: 'note', text: 'Fixed it' }, opts())).ok, true);
    const steps = await Take.execute({ action: 'run_steps' }, opts());
    assert.deepEqual(steps, { ok: false, error: 'invalid_params: "steps" must be a list of 1–200 steps', code: 'invalid_params' });
    const busy = await Take.execute({ action: 'start', ...PARAMS }, opts({ origin: { ...ORIGIN, job_id: 'job-2' } }));
    assert.equal(busy.code, 'take_busy');
    const stopped = await Take.execute({ action: 'stop' }, opts());
    assert.equal(stopped.ok, true);
    assert.equal(stopped.ended, 'take_done');
    assert.equal(stopped.recording.path, 'C:\\rec\\take.mp4');
    const inCase = await Take.execute({ action: 'status' }, opts({ caseContext: { caseId: 'c-1' } }));
    assert.equal(inCase.ok, false);
    assert.equal((await Take.execute({ action: 'note', text: 'late' }, opts())).code, 'invalid_params');
  });

  it('no takes on this node: capability_unavailable', async () => {
    const { Take } = toolsWith({ takes: null });
    const out = await Take.execute({ action: 'status' }, opts());
    assert.equal(out.ok, false);
    assert.match(out.error, /^capability_unavailable/);
  });
});

// Browser-runner spec §5, C-3, C-4: on a personal node the take launches Chrome itself through
// PlaywrightBrowser (no helper, no debugging port). Bundled Chromium, headless only.
describe('personal takes', () => {
  const PlaywrightBrowser = require('../src/browser/playwright-browser');
  const realRegistry = require('../src/tools/builtin/browser-registry');
  const { chromium } = require('playwright');
  let dataDir;
  let launches;
  let seen;
  let browsers;

  // Playwright's chromium, recording every launch's options.
  const recordingChromium = () => ({
    launchPersistentContext: (dir, opts) => { seen.push({ dir, opts }); return chromium.launchPersistentContext(dir, opts); },
    launch: (opts) => { seen.push({ opts }); return chromium.launch(opts); }
  });

  function personalManager(extra = {}) {
    return new TakeManager({
      leases, broker, store, guiConfig, registry: realRegistry, clock: () => clock.now(), timers, hosting: 'personal', dataDir,
      launchTakeBrowser: async (req) => {
        launches.push(req);
        const b = new PlaywrightBrowser({ chromium: recordingChromium() });
        browsers.push(b);
        await b.start({ userDataPath: req.userDataPath, executablePath: chromium.executablePath(), headless: true, viewport: null });
        return b;
      },
      ...extra
    });
  }

  beforeEach(() => {
    realRegistry.reset();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ptakes-'));
    launches = [];
    seen = [];
    browsers = [];
    takes = personalManager();
  });

  afterEach(async () => {
    await takes.stopAll();
    for (const b of browsers) await b.stop();
    realRegistry.reset();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('start launches through PlaywrightBrowser: no helper launch, no debugging port, registered with the profile, cdp: false', async () => {
    const out = await started();
    assert.ok(!names(broker.calls).includes('launchBrowser'), 'the helper launches nothing');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].userDataPath, path.join(dataDir, 'browser-profiles', 'demo'));
    assert.equal(launches[0].exe, guiConfig.apps.chrome.path);
    assert.equal(launches[0].profile, 'demo');
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].opts.args.some((a) => a.startsWith('--remote-debugging')), 'no debugging port');
    const key = `take:${out.take_id}`;
    assert.equal(realRegistry.registry.byKey.get(key), browsers[0]);
    assert.equal(realRegistry.activeProfileOf(key), 'demo');
    assert.equal(holder.current.browserKey, key);
    assert.deepEqual(out.browser, { profile: 'demo', cdp: false });
    assert.deepEqual(broker.closed, [], 'no pid to close');

    const res = await takes.stop(out.take_id);
    assert.equal(res.ended, 'take_done');
    assert.equal(browsers[0].isRunning, false, 'the stop closes the browser');
    assert.equal(realRegistry.registry.byKey.has(key), false);
    assert.equal(realRegistry.activeProfileOf(key), null);
  });

  it('every ending closes it: a revoke, the job closing, the helper lost', async () => {
    const endings = [
      () => leases.onRevoke(phone.leaseRevoke(identity.nodeId, leases.current().leaseId)),
      () => takes.endForJob('job-1', 'job_closed'),
      () => takes.onHelperLost()
    ];
    for (const end of endings) {
      const out = await started();
      const b = browsers.at(-1);
      assert.equal(b.isRunning, true);
      await end();
      await takes.end(out.take_id, 'ended');
      assert.notEqual(store.get(out.take_id).ended.reason, 'ended', 'the ending itself closed it');
      assert.equal(b.isRunning, false);
      assert.equal(realRegistry.registry.byKey.has(`take:${out.take_id}`), false);
    }
  });

  it('keep_browser: the key leaves the registry at once, the window stays; stopAll closes it', async () => {
    const out = await started();
    const key = `take:${out.take_id}`;
    await takes.stop(out.take_id, { keepBrowser: true });
    assert.equal(realRegistry.registry.byKey.has(key), false, 'out of every tool\'s reach');
    assert.equal(browsers[0].isRunning, true, 'the window stays');
    await takes.stopAll();
    assert.equal(browsers[0].isRunning, false, 'stopAll closes the kept browser');
  });

  it('a profile open under the default key is browser_launch_failed before any request or launch', async () => {
    realRegistry.setActiveProfile(realRegistry.DEFAULT_KEY, 'demo');
    await assert.rejects(begin(), (err) => err.code === 'browser_launch_failed' && /profile demo is open in another browser/.test(err.message));
    assert.equal(relay.last('kl.lease.request'), undefined, 'the phone is not asked');
    assert.equal(launches.length, 0);
    assert.equal(takes.live(), null);
  });

  it('a profile opened while the phone was asked is refused before the launch, and the lease released', async () => {
    const p = begin();
    await tick();
    realRegistry.setActiveProfile(realRegistry.DEFAULT_KEY, 'demo');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 30 }));
    await assert.rejects(p, (err) => err.code === 'browser_launch_failed');
    assert.equal(launches.length, 0);
    assert.equal(leases.current(), null);
    assert.equal(takes.live(), null);
  });

  it('a Playwright launch that throws is browser_launch_failed; nothing registered, no recorder', async () => {
    takes = personalManager({ launchTakeBrowser: async () => { throw new Error('Executable does not exist'); } });
    await assert.rejects(started(), (err) => err.code === 'browser_launch_failed');
    assert.equal(realRegistry.registry.byKey.size, 0);
    assert.ok(!names(broker.calls).includes('recordStart'));
    assert.equal(leases.current(), null);
  });

  it('the default launcher starts gui.apps[gui.browser] headed, maximized, no viewport, on <dataDir>/browser-profiles/<profile>', async () => {
    const calls = [];
    const page = { on() {}, url: () => 'about:blank' };
    const stub = {
      async launchPersistentContext(dir, opts) { calls.push({ dir, opts }); return { pages: () => [page], newPage: async () => page, close: async () => {} }; },
      async launch() { throw new Error('not a persistent launch'); }
    };
    takes = new TakeManager({
      leases, broker, store, guiConfig, registry: realRegistry, clock: () => clock.now(), timers, hosting: 'personal', dataDir,
      createBrowser: () => new PlaywrightBrowser({ chromium: stub })
    });
    const out = await started();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dir, path.join(dataDir, 'browser-profiles', 'demo'));
    const o = calls[0].opts;
    assert.equal(o.headless, false);
    assert.equal(o.viewport, null);
    assert.equal(o.executablePath, guiConfig.apps.chrome.path);
    assert.equal(o.channel, undefined);
    assert.deepEqual(o.args, [...CHROME_FLAGS, '--start-maximized']);
    assert.deepEqual(out.browser, { profile: 'demo', cdp: false });
    assert.ok(!names(broker.calls).includes('launchBrowser'));
  });
});
