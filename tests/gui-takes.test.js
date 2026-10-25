// tests/gui-takes.test.js
// TakeManager and the Take tool (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §5, §6, §9): a real LeaseManager with a fake relay and phone, a fake broker, a temp TakeStore.
const { describe, it, after, beforeEach } = require('node:test');
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
  const b = {
    calls: [],
    ffmpeg: FFMPEG,
    launchFails: null,
    stopResult: null,
    recorder: () => b.ffmpeg,
    releaseAll: async () => {},
    capability: () => ({ limits: [] }),
    leaseChanged: () => {},
    focusApp: async () => {},
    async launchBrowser(req, ctx) {
      b.calls.push(['launchBrowser', req, ctx]);
      if (b.launchFails) throw b.launchFails;
      return { pid: 7, cdp: { port: 9222, path: '/x' } };
    },
    async recordStart(req, ctx) {
      b.calls.push(['recordStart', req, ctx]);
      return { pid: 8, startedAt: 1000, path: req.path || 'C:\\rec\\take.mp4' };
    },
    async recordStop(req, ctx) {
      b.calls.push(['recordStop', req, ctx]);
      return b.stopResult || { path: 'C:\\rec\\take.mp4', durationS: 12, bytes: 1000, truncated: false };
    },
    async keepAwake(on, ctx) { b.calls.push(['keepAwake', on, ctx]); return { on }; }
  };
  return b;
}

const names = (calls) => calls.map((c) => c[0]);
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
  audits = [];
  const audit = { append: async (e) => { audits.push(e); } };
  leases = new LeaseManager({
    approvals: { identity, approverStore: approvers, relayClient: relay, phoneApprover: { isAvailable: () => true } },
    guiConfig, broker, audit, nodeName: 'gpu-box', clock: () => clock.now(), timers, jobOpen: () => true
  });
  leases.start();
  cleanups.push(() => leases.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-takes-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  store = new TakeStore({ dir: path.join(dir, 'takes'), clock: () => clock.now() });
  registry = { set: new Map(), removed: [], setBrowser(k, b) { this.set.set(k, b); }, removeBrowser(k) { this.removed.push(k); this.set.delete(k); } };
  attached = [];
  const attachBrowser = async (cdpUrl) => {
    const browser = { cdpUrl, stopped: false, page: { url: () => 'https://a.example.com' }, stop: async () => { browser.stopped = true; } };
    attached.push(browser);
    return browser;
  };
  takes = new TakeManager({ leases, broker, store, guiConfig, registry, audit, clock: () => clock.now(), timers, attachBrowser, closeBrowser: async () => {} });
  holder = createTakeHolder();
});

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
    assert.deepEqual(broker.calls[0][1], { exe: guiConfig.apps.chrome.path, profile: 'demo', args: [] });
    assert.deepEqual(broker.calls[0][2], { jobId: 'job-1' });
    assert.equal(broker.calls[1][1].ffmpeg, FFMPEG);
    assert.equal(broker.calls[1][1].takeId, out.take_id);
    assert.equal(broker.calls[1][1].path, undefined, 'the helper picks its own default');
    assert.equal(broker.calls[2][1], true);
    assert.equal(attached[0].cdpUrl, 'http://127.0.0.1:9222');
    assert.equal(registry.set.get(`take:${out.take_id}`), attached[0]);
    assert.ok(holder.current, 'the take policy is set');
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
    assert.equal(takes.live().take_id, out.take_id);
    assert.equal(takes.forJob('job-1').take_id, out.take_id);
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
