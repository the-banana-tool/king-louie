// tests/approvals-phone-approver.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { toolAction, actionHash, buildRequest, validateMessage, MAX_ACTION_BYTES } = require('../src/approvals/messages');
const { openSealed, isSealedShape, saltedHash } = require('../src/approvals/seal');
const { createSealPolicy, writeLatch } = require('../src/approvals/seal-policy');
const { AuditLedger } = require('../src/audit/audit-ledger');
const { canonicalize } = require('../src/platform/jcs');
const { addSink } = require('../src/logging');
const { ApproverStore } = require('../src/approvals/approver-store');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

// The link a relay client would be: records what the approver sends.
function fakeLink({ connected = true, canDeliver = { ok: true } } = {}) {
  const link = new EventEmitter();
  link.connected = connected;
  link.submitted = [];
  link.statuses = [];
  link.isConnected = () => link.connected;
  link.canDeliver = () => canDeliver;
  link.submit = async (env) => { link.submitted.push(env); };
  link.status = async (env) => { link.statuses.push(open(env).message); };
  link.connect = () => { link.connected = true; link.emit('connected'); };
  return link;
}

function fakeLedger() {
  const ledger = { entries: [], failing: false };
  ledger.append = async (entry) => {
    if (ledger.failing) throw new Error('audit_unavailable: disk full');
    ledger.entries.push(entry);
    return entry;
  };
  ledger.kinds = () => ledger.entries.map((e) => e.kind);
  return ledger;
}

// Timers the test fires by hand, so expiry needs no waiting.
function manualTimers() {
  const timers = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimer: (t) => { timers.delete(t); },
    fireAll: () => { for (const t of [...timers]) { timers.delete(t); t.fn(); } }
  };
}

async function setup({ phones = 1, link = fakeLink(), ttlMs = 300000, records = null } = {}) {
  const identity = testNodeIdentity();
  const devices = Array.from({ length: phones }, (_, i) => createFakePhone({ name: `Phone ${i + 1}` }));
  const store = await approverStoreWith(records || devices.map((d) => d.approverRecord()));
  stores.push(store);
  const ledger = fakeLedger();
  const timers = manualTimers();
  const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: ledger, ttlMs, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { identity, devices, store, ledger, link, timers, approver };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitForSubmit(link, n = 1) {
  for (let i = 0; i < 100 && link.submitted.length < n; i += 1) await tick();
  return link.submitted[n - 1];
}

// A ledger whose append() blocks on `kind` the first time it is called with
// it, until the test calls `release()`. Used to land a handleResponse (or
// requestAction) exactly inside its awaited audit, so a concurrent
// stop()/abort()/timer fire can race it.
function gatedLedger(kind) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ledger = { entries: [], failing: false };
  ledger.append = async (entry) => {
    if (entry.kind === kind) await gate;
    if (ledger.failing) throw new Error('audit_unavailable: disk full');
    ledger.entries.push(entry);
    return entry;
  };
  ledger.kinds = () => ledger.entries.map((e) => e.kind);
  ledger.release = () => release();
  return ledger;
}

// A raw setup, like setup(), but letting the caller supply its own ledger
// (setup() always builds a plain fakeLedger()).
async function rawSetup({ link = fakeLink(), ledger = fakeLedger(), ttlMs = 300000, now } = {}) {
  const identity = testNodeIdentity();
  const phone = createFakePhone();
  const store = await approverStoreWith([phone.approverRecord()]);
  stores.push(store);
  const timers = manualTimers();
  const approver = new PhoneApprover({
    identity, approverStore: store, link, auditLedger: ledger, ttlMs, now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer
  });
  return { identity, phone, store, ledger, link, timers, approver };
}

describe('PhoneApprover.requestAction', () => {
  it('signs, audits and submits the request, then resolves on an approval', async () => {
    const { approver, link, devices, ledger, identity } = await setup();
    const action = toolAction('Bash', { command: 'git push' }, '/srv/site');
    const pending = approver.requestAction(action, { origin: { client: 'gateway', session: 's-1' }, currentAction: () => toolAction('Bash', { command: 'git push' }, '/srv/site') });
    const request = await waitForSubmit(link);
    assert.equal(verifyEd25519(request, identity.publicKey.toString('hex')), true);
    const { message } = open(request);
    assert.equal(message.action_hash, actionHash(action));
    assert.deepEqual(message.origin, { client: 'gateway', session: 's-1', job_id: null });
    assert.deepEqual(approver.pending().map((p) => p.request_id), [message.request_id]);

    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: true, reason: null });
    const outcome = await pending;
    assert.deepEqual(outcome, { decision: 'approve', request_id: message.request_id, device_id: devices[0].deviceId, action_hash: message.action_hash, reason: null });
    assert.deepEqual(ledger.kinds(), ['approval.request', 'approval.response', 'approval.outcome']);
    assert.equal(link.statuses[0].state, 'approved');
    assert.deepEqual(approver.pending(), []);
  });

  it('requires currentAction', async () => {
    const { approver } = await setup();
    await assert.rejects(approver.requestAction(toolAction('Bash', { command: 'ls' }, null), {}), /currentAction required/);
  });

  it('clamps the TTL to 30–300 s', async () => {
    const short = await setup({ ttlMs: 1000 });
    short.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const { message } = open(await waitForSubmit(short.link));
    assert.equal(Date.parse(message.expires_at) - Date.parse(message.created_at), 30000);
    short.approver.stop();
  });

  it('is unavailable at once with no enrolled device or no delivery', async () => {
    const none = await setup({ records: [] });
    const outcome = await none.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) });
    assert.deepEqual(outcome, { decision: 'unavailable', request_id: null, device_id: null, action_hash: null, reason: 'no enrolled device on this node' });
    const stopped = await setup({ link: fakeLink({ canDeliver: { ok: false, reason: 'the King Louie service is not running on this node' } }) });
    assert.equal(stopped.approver.isAvailable(), false);
    assert.equal((await stopped.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) })).reason, 'the King Louie service is not running on this node');
  });

  it('fails with error when the action cannot be built or audited', async () => {
    const big = await setup();
    const tooLarge = { kind: 'tool', name: 'Write', params: { content: 'x'.repeat(300000) }, cwd: null, summary: 'Write' };
    assert.equal((await big.approver.requestAction(tooLarge, { currentAction: () => tooLarge })).reason, 'action_too_large');
    big.ledger.failing = true;
    const outcome = await big.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) });
    assert.equal(outcome.decision, 'error');
    assert.equal(outcome.reason, 'audit_unavailable');
    assert.equal(big.link.submitted.length, 0, 'an unaudited request is never sent');
  });

  it('expires on the node clock with an expired status', async () => {
    const { approver, link, timers, ledger } = await setup();
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    await waitForSubmit(link);
    timers.fireAll();
    assert.equal((await pending).decision, 'expired');
    assert.equal(link.statuses[0].state, 'expired');
    await tick();
    assert.ok(ledger.kinds().includes('approval.outcome'));
  });

  it('queued while down, submitted on connect, expires on node clock if the link never returns', async () => {
    const link = fakeLink({ connected: false });
    const { approver, timers, devices } = await setup({ link });
    const first = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    await tick();
    await tick();
    assert.equal(link.submitted.length, 0);
    link.connect();
    const request = await waitForSubmit(link);
    await approver.handleResponse(devices[0].respond(request, 'approve'));
    assert.equal((await first).decision, 'approve');

    link.connected = false;
    const second = approver.requestAction(toolAction('Bash', { command: 'pwd' }, null), { currentAction: () => toolAction('Bash', { command: 'pwd' }, null) });
    await tick();
    await tick();
    assert.equal(link.submitted.length, 1, 'nothing new was sent while down');
    timers.fireAll();
    assert.equal((await second).decision, 'expired');
  });
});

describe('PhoneApprover.handleResponse', () => {
  async function started(opts = {}) {
    const ctx = await setup(opts);
    let live = { command: 'git push' };
    ctx.setLive = (v) => { live = v; };
    ctx.pending = ctx.approver.requestAction(toolAction('Bash', live, null), { currentAction: () => toolAction('Bash', live, null) });
    ctx.request = await waitForSubmit(ctx.link);
    return ctx;
  }

  it('first valid response decides; second gets already_decided; both audited', async () => {
    const { approver, devices, request, pending, ledger } = await started({ phones: 2 });
    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: true, reason: null });
    assert.deepEqual(await approver.handleResponse(devices[1].respond(request, 'deny')), { accepted: false, reason: 'already_decided' });
    assert.equal((await pending).decision, 'approve');
    await tick();
    assert.deepEqual(ledger.kinds().filter((k) => k.startsWith('approval.re')), ['approval.request', 'approval.response', 'approval.rejected']);
  });

  it('the same response twice is a replay', async () => {
    const { approver, devices, request } = await started();
    const response = devices[0].respond(request, 'deny');
    assert.equal((await approver.handleResponse(response)).accepted, true);
    assert.deepEqual(await approver.handleResponse(response), { accepted: false, reason: 'replay' });
  });

  it('change the action after approval: action_changed consumes the request', async () => {
    const { approver, devices, request, pending, setLive, link } = await started();
    setLive({ command: 'git push --force' });
    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: false, reason: 'action_changed' });
    const outcome = await pending;
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, 'action_changed');
    assert.equal(link.statuses[0].state, 'refused');
  });

  it('a response that fails its binding checks leaves the request pending', async () => {
    const { approver, devices, request } = await started();
    const other = devices[0].respond(request, 'approve', { overrides: { expires_at: '2030-01-01T00:00:00.000Z' } });
    assert.deepEqual(await approver.handleResponse(other), { accepted: false, reason: 'expires_mismatch' });
    assert.equal(approver.pending().length, 1);
    assert.equal((await approver.handleResponse(devices[0].respond(request, 'approve'))).accepted, true);
  });

  it('audit failure at step 13: not accepted, still pending, a retry succeeds', async () => {
    const { approver, devices, request, pending, ledger } = await started();
    ledger.failing = true;
    const response = devices[0].respond(request, 'approve');
    assert.deepEqual(await approver.handleResponse(response), { accepted: false, reason: 'audit_unavailable' });
    assert.equal(approver.pending().length, 1);
    ledger.failing = false;
    assert.deepEqual(await approver.handleResponse(response), { accepted: true, reason: null });
    assert.equal((await pending).decision, 'approve');
  });

  it('abort → withdrawn; later approve → unknown_request; tool never runs', async () => {
    const ctx = await setup();
    const controller = new AbortController();
    const metadata = { signal: controller.signal, workingDirectory: '/srv/site' };
    const result = ctx.approver.requestApproval('Bash', { command: 'rm -rf build' }, metadata);
    const request = await waitForSubmit(ctx.link);
    controller.abort();
    assert.equal(await result, false);
    assert.equal(ctx.link.statuses[0].state, 'withdrawn');
    assert.deepEqual(await ctx.approver.handleResponse(ctx.devices[0].respond(request, 'approve')), { accepted: false, reason: 'unknown_request' });
  });
});

describe('PhoneApprover.requestApproval', () => {
  it('maps outcomes to true | false | timeout | unavailable and sets metadata.refusal', async () => {
    const ctx = await setup();
    const approve = ctx.approver.requestApproval('Bash', { command: 'ls' }, { workingDirectory: '/tmp' });
    const request = await waitForSubmit(ctx.link);
    assert.equal(open(request).message.action.cwd, '/tmp');
    await ctx.approver.handleResponse(ctx.devices[0].respond(request, 'approve'));
    assert.equal(await approve, true);

    const deny = ctx.approver.requestApproval('Bash', { command: 'ls' }, {});
    await ctx.approver.handleResponse(ctx.devices[0].respond(await waitForSubmit(ctx.link, 2), 'deny'));
    assert.equal(await deny, false);

    const expire = ctx.approver.requestApproval('Bash', { command: 'ls' }, {});
    await waitForSubmit(ctx.link, 3);
    ctx.timers.fireAll();
    assert.equal(await expire, 'timeout');

    const bad = {};
    assert.equal(await ctx.approver.requestApproval('Bash', { n: NaN }, bad), 'unavailable');
    assert.deepEqual(bad.refusal, { deniedBy: 'unavailable', error: 'Action cannot be shown on the phone (non_canonical); nothing ran.' });

    ctx.ledger.failing = true;
    const audit = {};
    assert.equal(await ctx.approver.requestApproval('Bash', { command: 'ls' }, audit), 'unavailable');
    assert.deepEqual(audit.refusal, { deniedBy: 'audit', error: 'Audit ledger unavailable; nothing ran.' });

    const none = await setup({ records: [] });
    const meta = {};
    assert.equal(await none.approver.requestApproval('Bash', { command: 'ls' }, meta), 'unavailable');
    assert.equal(meta.refusal.deniedBy, 'unavailable');
    assert.match(meta.refusal.error, /^Phone approval unavailable: no enrolled device on this node\. Nothing ran\.$/);
  });

  it('stop() ends every pending request without approving it, with the reason in metadata.refusal', async () => {
    const ctx = await setup();
    const metadata = {};
    const pending = ctx.approver.requestApproval('Bash', { command: 'ls' }, metadata);
    await waitForSubmit(ctx.link);
    ctx.approver.stop();
    assert.equal(await pending, 'unavailable');
    assert.deepEqual(metadata.refusal, { deniedBy: 'unavailable', error: 'Phone approval unavailable: the service is stopping. Nothing ran.' });
  });

  it('tolerates a null metadata: a clean unavailable, nothing thrown, no refusal to set', async () => {
    const none = await setup({ records: [] });
    await assert.doesNotReject(async () => {
      const result = await none.approver.requestApproval('Bash', { command: 'ls' }, null);
      assert.equal(result, 'unavailable');
    });
  });
});

describe('PhoneApprover: nothing is approved after stop()', () => {
  it('a request whose approval.request audit is still in flight when stop() runs is never submitted or approved', async () => {
    const ledger = gatedLedger('approval.request');
    const { approver, link } = await rawSetup({ ledger });
    const pending = approver.requestApproval('Bash', { command: 'ls' }, {});
    await tick();
    // stop() runs before the audit above resolves, so it sees no pending
    // entry yet for this request — its own sweep cannot withdraw it.
    approver.stop();
    ledger.release();
    for (let i = 0; i < 10; i += 1) await tick();
    assert.equal(link.submitted.length, 0, 'a request built before stop() must never reach the phone once stopped');
    assert.equal(await pending, 'unavailable');
  });

  it('handleResponse refuses everything once stop() has run, even a genuine approval', async () => {
    const { approver, link, phone } = await rawSetup();
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const request = await waitForSubmit(link);
    approver.stop();
    assert.equal((await pending).decision, 'unavailable');
    assert.deepEqual(await approver.handleResponse(phone.respond(request, 'approve')), { accepted: false, reason: 'stopped' });
  });
});

describe('PhoneApprover: the action can change or expire during the step-13 audit', () => {
  it('a mutated action during the step-13 audit denies instead of approving', async () => {
    const ledger = gatedLedger('approval.response');
    const { approver, link, phone } = await rawSetup({ ledger });
    const params = { command: 'ls' };
    const pending = approver.requestApproval('Bash', params, {});
    const request = await waitForSubmit(link);
    const handled = approver.handleResponse(phone.respond(request, 'approve'));
    await tick();
    params.command = 'rm -rf /';
    ledger.release();
    assert.deepEqual(await handled, { accepted: false, reason: 'action_changed' });
    assert.equal(await pending, false);
  });

  it('the deadline passing during the step-13 audit finishes as expired, not approved', async () => {
    let clock = 0;
    const ledger = gatedLedger('approval.response');
    const { approver, link, phone } = await rawSetup({ ledger, now: () => clock });
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const request = await waitForSubmit(link);
    const handled = approver.handleResponse(phone.respond(request, 'approve'));
    await tick();
    clock = 400000; // past the 300000 ms default TTL, though the manual timer never auto-fires
    ledger.release();
    assert.deepEqual(await handled, { accepted: false, reason: 'expired' });
    assert.equal((await pending).decision, 'expired');
  });
});

describe('PhoneApprover: a response racing expiry, abort or stop during step 13', () => {
  it('the timer firing during step 13 reports expired, not the generic guess', async () => {
    const ledger = gatedLedger('approval.response');
    const { approver, link, phone, timers } = await rawSetup({ ledger });
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const request = await waitForSubmit(link);
    const handled = approver.handleResponse(phone.respond(request, 'approve'));
    await tick();
    timers.fireAll();
    ledger.release();
    assert.deepEqual(await handled, { accepted: false, reason: 'expired' });
    assert.equal((await pending).decision, 'expired');
    assert.ok(ledger.kinds().includes('approval.rejected'));
  });

  it('an abort during step 13 reports withdrawn, not the generic guess', async () => {
    const ledger = gatedLedger('approval.response');
    const { approver, link, phone } = await rawSetup({ ledger });
    const controller = new AbortController();
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { signal: controller.signal, currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const request = await waitForSubmit(link);
    const handled = approver.handleResponse(phone.respond(request, 'approve'));
    await tick();
    controller.abort();
    ledger.release();
    assert.deepEqual(await handled, { accepted: false, reason: 'withdrawn' });
    assert.equal((await pending).decision, 'withdrawn');
  });

  it('stop() during step 13 reports stopped, not the generic guess', async () => {
    const ledger = gatedLedger('approval.response');
    const { approver, link, phone } = await rawSetup({ ledger });
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const request = await waitForSubmit(link);
    const handled = approver.handleResponse(phone.respond(request, 'approve'));
    await tick();
    approver.stop();
    ledger.release();
    assert.deepEqual(await handled, { accepted: false, reason: 'stopped' });
    assert.equal((await pending).decision, 'unavailable');
  });
});

describe('PhoneApprover availability', () => {
  it('an approver store nobody has called ready() on is unavailable, not silently "0 devices"', async () => {
    const identity = testNodeIdentity();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-untrusted-'));
    const store = new ApproverStore({ dir: path.join(base, 'approvers'), platform: 'linux' });
    const approver = new PhoneApprover({ identity, approverStore: store, link: fakeLink(), auditLedger: fakeLedger() });
    assert.equal(approver.isAvailable(), false);
    assert.equal(typeof approver.unavailableReason(), 'string');
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('an approver store with a problem is unavailable, naming the problem', async () => {
    const identity = testNodeIdentity();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-problem-'));
    const dir = path.join(base, 'approvers');
    fs.mkdirSync(dir, { recursive: true });
    // platform: 'win32' forces the writable-directory probe regardless of
    // the real OS; a fresh temp dir is writable, so ready() reports a problem.
    const store = new ApproverStore({ dir, platform: 'win32' });
    await store.ready();
    assert.equal(store.untrusted, true);
    assert.ok(store.problem);
    const approver = new PhoneApprover({ identity, approverStore: store, link: fakeLink(), auditLedger: fakeLedger() });
    assert.equal(approver.isAvailable(), false);
    assert.equal(approver.unavailableReason(), store.problem);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('Windows: availability follows the approvers dir ACL as it changes, not the startup verdict', async () => {
    const identity = testNodeIdentity();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-reprobe-'));
    const dir = path.join(base, 'approvers');
    fs.mkdirSync(dir);
    const phone = createFakePhone();
    fs.writeFileSync(path.join(dir, `${phone.deviceId}.json`), JSON.stringify(phone.approverRecord()));
    const state = { writable: true };
    const isProbe = (file) => path.basename(file).startsWith('.probe-');
    const fsImpl = {
      ...fs,
      openSync: (file, ...rest) => {
        if (!isProbe(file)) return fs.openSync(file, ...rest);
        if (state.writable) return 42;
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
      closeSync: (fd) => { if (fd !== 42) fs.closeSync(fd); },
      unlinkSync: (file) => { if (!isProbe(file)) fs.unlinkSync(file); }
    };
    const store = new ApproverStore({ dir, platform: 'win32', fsImpl, readOwners: () => ({ approvers: 'S-1-5-32-544', config: 'S-1-5-32-544' }) });
    await store.ready();
    const approver = new PhoneApprover({ identity, approverStore: store, link: fakeLink(), auditLedger: fakeLedger() });
    assert.match(approver.unavailableReason(), /writable by the account running the service/);
    state.writable = false;
    store.refresh();
    assert.equal(approver.unavailableReason(), null);
    state.writable = true;
    store.refresh();
    assert.match(approver.unavailableReason(), /writable by the account running the service/);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('a link or store that throws while being checked is unavailable, never an unhandled rejection', async () => {
    const { approver: withBadLink } = await rawSetup({ link: (() => { const l = fakeLink(); l.canDeliver = () => { throw new Error('link boom'); }; return l; })() });
    assert.equal(withBadLink.isAvailable(), false);
    assert.match(withBadLink.unavailableReason(), /link boom/);
    const outcome = await withBadLink.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) });
    assert.equal(outcome.decision, 'unavailable');
    assert.match(outcome.reason, /link boom/);

    const { approver: withBadStore, store } = await rawSetup();
    store.activeCount = () => { throw new Error('store boom'); };
    assert.equal(withBadStore.isAvailable(), false);
    assert.match(withBadStore.unavailableReason(), /store boom/);
  });
});

// Sealed phones (R-SP-1, R-SP-2, R-SP-5, R-SP-7): the real policy over a real
// store and a temp data dir. A phone's action is what it opens with its box key.
describe('PhoneApprover with a seal policy', () => {
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const PARAM = 'deploy --target hidden-parameter';
  const liveAction = () => toolAction('Bash', { command: PARAM }, '/srv/site');
  const ORIGIN = { client: 'gateway', session: 's-hidden-session', job_id: 'job-hidden-id' };
  const REQUEST_TYPE = 'kl.approval.request';

  async function sealedSetup({ holders = 1, plain = 0, nodeBox = true, link = fakeLink(), withPolicy = true } = {}) {
    const identity = testNodeIdentity({ box: nodeBox });
    const boxed = Array.from({ length: holders }, (_, i) => createFakePhone({ name: `Box phone ${i + 1}`, boxKey: true }));
    const others = Array.from({ length: plain }, (_, i) => createFakePhone({ name: `Plain phone ${i + 1}` }));
    const store = await approverStoreWith([...boxed.map((p) => p.approverRecord({ boxKey: true })), ...others.map((p) => p.approverRecord())]);
    stores.push(store);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-seal-approver-'));
    dirs.push(dataDir);
    const sealPolicy = withPolicy ? createSealPolicy({ approverStore: store, identity, dataDir }) : null;
    const ledger = fakeLedger();
    const timers = manualTimers();
    const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: ledger, sealPolicy, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    return { identity, boxed, others, store, dataDir, sealPolicy, ledger, link, approver };
  }
  const ask = (approver, signal = null) => approver.requestAction(liveAction(), { origin: ORIGIN, signal, currentAction: liveAction });

  it("with no box key anywhere the request is the clear shape and bytes match today's builder", async () => {
    const { identity, sealPolicy, approver, link, others } = await sealedSetup({ holders: 0, plain: 2 });
    const fixed = { identity, action: liveAction(), origin: ORIGIN, now: 1790000000000, requestId: '11111111-1111-4111-8111-111111111111', nonce: 'n'.repeat(43) };
    const today = buildRequest(fixed);
    const withPolicy = buildRequest({ ...fixed, sealPolicy });
    assert.deepEqual(withPolicy.bytes, today.bytes);
    assert.deepEqual(withPolicy.envelope, today.envelope);
    assert.equal(withPolicy.salt, null);
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    const { message } = open(request);
    assert.deepEqual(message.action, liveAction());
    assert.equal(message.action_hash, actionHash(liveAction()));
    assert.equal(Object.hasOwn(message, 'sealed'), false);
    assert.equal(approver.pending()[0].summary, liveAction().summary);
    await approver.handleResponse(others[0].respond(request, 'approve'));
    assert.deepEqual(Object.keys(await pending).sort(), ['action_hash', 'decision', 'device_id', 'reason', 'request_id'], 'a clear outcome has no salt key');
    approver.stop();
  });

  it('a policy absent is the clear path', async () => {
    const { approver, link } = await sealedSetup({ holders: 1, withPolicy: false });
    const pending = ask(approver);
    const { message } = open(await waitForSubmit(link));
    assert.deepEqual(message.action, liveAction());
    approver.stop();
    await pending;
  });

  it('with one phone holding a box key the request is sealed, it and the node are in keys, and only the box holder opens the action', async () => {
    const { approver, link, boxed, others, identity } = await sealedSetup({ holders: 1, plain: 1 });
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    assert.equal(verifyEd25519(request, identity.publicKey.toString('hex')), true);
    const { message } = open(request);
    assert.equal(validateMessage(REQUEST_TYPE, message), null);
    assert.equal(isSealedShape(REQUEST_TYPE, message), true);
    for (const key of ['action', 'origin', 'salt']) assert.equal(Object.hasOwn(message, key), false, key);
    assert.deepEqual(Object.keys(message.sealed.keys).sort(), [boxed[0].deviceId, identity.nodeId].sort());
    assert.deepEqual(message.node_box, identity.box.jwk);
    const opened = boxed[0].open(request, REQUEST_TYPE);
    assert.deepEqual(opened.content.action, liveAction());
    assert.deepEqual(opened.content.origin, { client: 'gateway', session: 's-hidden-session', job_id: 'job-hidden-id' });
    assert.throws(() => openSealed({ type: REQUEST_TYPE, message, recipientId: others[0].deviceId, agree: identity.box.agree }), (e) => e.reason === 'not_recipient');
    assert.deepEqual(openSealed({ type: REQUEST_TYPE, message, recipientId: identity.nodeId, agree: identity.box.agree }).content.action, liveAction(), 'the node reads its own audit entries');
    approver.stop();
    await pending;
  });

  it('every phone holding a box key is in keys', async () => {
    const { approver, link, boxed, identity } = await sealedSetup({ holders: 2 });
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    assert.deepEqual(Object.keys(open(request).message.sealed.keys).sort(), [boxed[0].deviceId, boxed[1].deviceId, identity.nodeId].sort());
    for (const phone of boxed) assert.deepEqual(phone.open(request, REQUEST_TYPE).content.action, liveAction());
    approver.stop();
    await pending;
  });

  it("a sealed request's action_hash is the salted hash and a response over it is accepted", async () => {
    const { approver, link, boxed } = await sealedSetup();
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    const { message, content } = boxed[0].open(request, REQUEST_TYPE);
    assert.equal(message.action_hash, saltedHash(content.salt, liveAction()));
    assert.notEqual(message.action_hash, actionHash(liveAction()));
    assert.equal(actionHash(liveAction(), { salt: content.salt }), message.action_hash);
    assert.deepEqual(await approver.handleResponse(boxed[0].respond(request, 'approve')), { accepted: true, reason: null });
    const outcome = await pending;
    assert.equal(outcome.decision, 'approve');
    assert.equal(outcome.action_hash, message.action_hash);
    assert.equal(outcome.salt, content.salt, 'a caller that re-checks the action needs the salt');
    approver.stop();
  });

  it('two requests for one action have different hashes', async () => {
    const { approver, link } = await sealedSetup();
    const one = ask(approver);
    const two = ask(approver);
    await waitForSubmit(link, 2);
    assert.notEqual(open(link.submitted[0]).message.action_hash, open(link.submitted[1]).message.action_hash);
    approver.stop();
    await Promise.all([one, two]);
  });

  it('a response over the unsalted hash is action_hash_mismatch', async () => {
    const { approver, link, boxed } = await sealedSetup();
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    const forged = boxed[0].respond(request, 'approve', { overrides: { action_hash: actionHash(liveAction()) } });
    assert.deepEqual(await approver.handleResponse(forged), { accepted: false, reason: 'action_hash_mismatch' });
    approver.stop();
    await pending;
  });

  it('a changed parameter under sealing is action_changed on the salted re-check', async () => {
    const { approver, link, boxed } = await sealedSetup();
    let command = PARAM;
    const pending = approver.requestAction(liveAction(), { origin: ORIGIN, currentAction: () => toolAction('Bash', { command }, '/srv/site') });
    const request = await waitForSubmit(link);
    command = 'deploy --force';
    assert.deepEqual(await approver.handleResponse(boxed[0].respond(request, 'approve')), { accepted: false, reason: 'action_changed' });
    const outcome = await pending;
    assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'action_changed']);
    approver.stop();
  });

  it('a parameter that changes during the response audit is action_changed on the second pass', async () => {
    const ledger = gatedLedger('approval.response');
    const { store, boxed, identity, dataDir, link } = await sealedSetup();
    const timers = manualTimers();
    const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: ledger, sealPolicy: createSealPolicy({ approverStore: store, identity, dataDir }), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    let command = PARAM;
    const pending = approver.requestAction(liveAction(), { origin: ORIGIN, currentAction: () => toolAction('Bash', { command }, '/srv/site') });
    const request = await waitForSubmit(link);
    const handling = approver.handleResponse(boxed[0].respond(request, 'approve'));
    await tick();
    command = 'deploy --force';
    ledger.release();
    assert.deepEqual(await handling, { accepted: false, reason: 'action_changed' });
    assert.equal((await pending).reason, 'action_changed');
    approver.stop();
  });

  it("a box key applied while a clear request is pending leaves that request's check unsalted and seals the next", async () => {
    const { approver, link, others, store } = await sealedSetup({ holders: 0, plain: 1 });
    const first = ask(approver);
    const clearRequest = await waitForSubmit(link);
    assert.equal(open(clearRequest).message.action_hash, actionHash(liveAction()));

    const boxPhone = createFakePhone({ name: 'New box phone', boxKey: true });
    fs.writeFileSync(path.join(store.dir, `${boxPhone.deviceId}.json`), JSON.stringify(boxPhone.approverRecord({ boxKey: true })), { mode: 0o644 });
    await store.ready();

    const second = ask(approver);
    const sealedRequest = await waitForSubmit(link, 2);
    assert.equal(isSealedShape(REQUEST_TYPE, open(sealedRequest).message), true);
    assert.deepEqual(await approver.handleResponse(others[0].respond(clearRequest, 'approve')), { accepted: true, reason: null });
    assert.equal((await first).decision, 'approve');
    assert.deepEqual(await approver.handleResponse(boxPhone.respond(sealedRequest, 'approve')), { accepted: true, reason: null });
    assert.equal((await second).decision, 'approve');
    approver.stop();
  });

  it('a device revoked after the request is refused revoked_device even though its wrap is in keys', async () => {
    const { approver, link, boxed, store } = await sealedSetup({ holders: 2 });
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    const [owner, thief] = boxed;
    assert.equal(store.stage(owner.revoke(thief.deviceId)).state, 'revoked-pending-apply');
    assert.ok(Object.hasOwn(open(request).message.sealed.keys, thief.deviceId), 'the wrap is still there');
    assert.deepEqual(await approver.handleResponse(thief.respond(request, 'approve')), { accepted: false, reason: 'revoked_device' });
    assert.equal((await approver.handleResponse(owner.respond(request, 'deny'))).accepted, true);
    assert.equal((await pending).decision, 'deny');
    approver.stop();
  });

  it('a device revoked before the request has no wrap', async () => {
    const { approver, link, boxed, store, identity } = await sealedSetup({ holders: 2 });
    const [owner, thief] = boxed;
    assert.equal(store.stage(owner.revoke(thief.deviceId)).state, 'revoked-pending-apply');
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    assert.deepEqual(Object.keys(open(request).message.sealed.keys).sort(), [owner.deviceId, identity.nodeId].sort());
    approver.stop();
    await pending;
  });

  it("a relay moving one request's sealed blob onto another's clear part opens nowhere and earns no response", async () => {
    const { approver, link, boxed, identity } = await sealedSetup();
    const pendingA = ask(approver);
    const pendingB = ask(approver);
    await waitForSubmit(link, 2);
    const [a, b] = link.submitted;
    const moved = { ...open(b).message, sealed: open(a).message.sealed };
    assert.throws(() => openSealed({ type: REQUEST_TYPE, message: moved, recipientId: identity.nodeId, agree: identity.box.agree }), (e) => e.reason === 'open_failed');
    // A phone that could not open it has nothing to hash; a response naming
    // A's hash on B's request is refused.
    const crossed = boxed[0].respond(b, 'approve', { overrides: { action_hash: open(a).message.action_hash } });
    assert.deepEqual(await approver.handleResponse(crossed), { accepted: false, reason: 'action_hash_mismatch' });
    approver.stop();
    await Promise.all([pendingA, pendingB]);
  });

  it('the approval.request audit entry holds the sealed envelope and no action key', async () => {
    const { approver, link, boxed, ledger } = await sealedSetup();
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    await approver.handleResponse(boxed[0].respond(request, 'deny'));
    await pending;
    await tick();
    const entry = ledger.entries.find((e) => e.kind === 'approval.request');
    assert.deepEqual(entry.data.envelope, request);
    assert.equal(Object.hasOwn(entry.data, 'action'), false);
    assert.equal(Object.hasOwn(open(entry.data.envelope).message, 'action'), false);
    approver.stop();
  });

  it('nothing the relay or the mirror sees holds a parameter, the summary or the origin', async () => {
    const lines = [];
    const removeSink = addSink((record) => { lines.push(record.line); });
    const { approver, link, boxed, ledger } = await sealedSetup();
    const pending = ask(approver);
    const request = await waitForSubmit(link);
    // Read only by the loopback bridge to the node's own paired window.
    assert.deepEqual(approver.pending().map((p) => p.summary), [liveAction().summary]);
    await approver.handleResponse(boxed[0].respond(request, 'approve'));
    await pending;
    await tick();
    removeSink();
    const decode = (v) => {
      if (Array.isArray(v)) return v.map(decode);
      if (v && typeof v === 'object') {
        const out = {};
        for (const [k, inner] of Object.entries(v)) out[k] = decode(inner);
        if (typeof v.payload === 'string') out.decoded = Buffer.from(v.payload, 'base64url').toString('utf8');
        return out;
      }
      return v;
    };
    const seen = JSON.stringify(decode({ submitted: link.submitted, statuses: link.statuses, ledger: ledger.entries, lines }));
    for (const hidden of [PARAM, 'hidden-parameter', 's-hidden-session', 'job-hidden-id', 'Bash(']) assert.equal(seen.includes(hidden), false, hidden);
    approver.stop();
  });

  describe('a relay that refuses a sealed request', () => {
    const refusingLink = (code) => {
      const link = fakeLink();
      link.submit = async (env) => { link.submitted.push(env); throw Object.assign(new Error('expected kl.approval.request'), { code }); };
      return link;
    };
    const logged = async (run) => {
      const lines = [];
      const removeSink = addSink((record) => { lines.push(record.line); });
      try {
        await run();
        await tick();
        await tick();
      } finally {
        removeSink();
      }
      return lines;
    };

    for (const code of ['malformed', 'bad_request']) {
      it(`${code} warns once, naming the relay's version and the upgrade order`, async () => {
        const { approver, link } = await sealedSetup({ link: refusingLink(code) });
        const asks = [];
        const lines = await logged(async () => {
          asks.push(ask(approver), ask(approver));
          await waitForSubmit(link, 2);
        });
        const warned = lines.filter((l) => /relay before node/.test(l));
        assert.equal(warned.length, 1, lines.join('\n'));
        assert.match(warned[0], /older than this node/);
        assert.equal(lines.some((l) => /will resubmit on reconnect/.test(l)), false);
        approver.stop();
        await Promise.all(asks);
      });
    }

    it('another failure of a sealed request is the ordinary retry', async () => {
      const { approver, link } = await sealedSetup({ link: refusingLink('link_down') });
      let pending;
      const lines = await logged(async () => {
        pending = ask(approver);
        await waitForSubmit(link);
      });
      assert.ok(lines.some((l) => /will resubmit on reconnect/.test(l)));
      assert.equal(lines.some((l) => /relay before node/.test(l)), false);
      approver.stop();
      await pending;
    });

    it('a clear request refused malformed is the ordinary retry', async () => {
      const { approver, link } = await sealedSetup({ holders: 0, plain: 1, link: refusingLink('malformed') });
      let pending;
      const lines = await logged(async () => {
        pending = ask(approver);
        await waitForSubmit(link);
      });
      assert.ok(lines.some((l) => /will resubmit on reconnect/.test(l)));
      assert.equal(lines.some((l) => /relay before node/.test(l)), false);
      approver.stop();
      await pending;
    });
  });

  it('a clear request still audits its job id', async () => {
    const { approver, link, ledger } = await sealedSetup({ holders: 0, plain: 1 });
    const pending = ask(approver);
    await waitForSubmit(link);
    assert.equal(ledger.entries.find((e) => e.kind === 'approval.request').data.job_id, 'job-hidden-id');
    approver.stop();
    await pending;
  });

  describe('latched with nobody to seal to', () => {
    it('a request is denied no_sealed_recipient, nothing is sent and nothing clear is audited', async () => {
      const { approver, link, dataDir, ledger, sealPolicy } = await sealedSetup({ holders: 0, plain: 1 });
      writeLatch(dataDir);
      assert.deepEqual([sealPolicy.sealing(), sealPolicy.canSeal()], [true, false]);
      const outcome = await ask(approver);
      assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'no_sealed_recipient']);
      await tick();
      assert.deepEqual(link.submitted, []);
      assert.deepEqual(approver.pending(), []);
      assert.equal(JSON.stringify(ledger.entries).includes('hidden-parameter'), false);
      assert.equal(ledger.entries.some((e) => e.kind === 'approval.request'), false);
      assert.deepEqual(ledger.entries.map((e) => [e.kind, e.data.state, e.data.reason]), [['approval.outcome', 'refused', 'no_sealed_recipient']]);
      approver.stop();
    });

    it("the tool call fails with the reason, and is not counted as the owner's no", async () => {
      const { approver, dataDir } = await sealedSetup({ holders: 0, plain: 1 });
      writeLatch(dataDir);
      const metadata = {};
      assert.equal(await approver.requestApproval('Bash', { command: PARAM }, metadata), 'unavailable');
      assert.match(metadata.refusal.error, /no_sealed_recipient/);
      approver.stop();
    });

    it('the node holding no box key of its own never sends clear', async () => {
      const { approver, link } = await sealedSetup({ holders: 1, nodeBox: false });
      const outcome = await ask(approver);
      assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'no_sealed_recipient']);
      assert.deepEqual(link.submitted, []);
      approver.stop();
    });

    it('an untrusted store never sends clear', async () => {
      const { approver, link, store, dataDir } = await sealedSetup();
      writeLatch(dataDir);
      store.list = () => [];
      const outcome = await ask(approver);
      assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'no_sealed_recipient']);
      assert.deepEqual(link.submitted, []);
      approver.stop();
    });

    it('with no phone holding a box key the denial says to enroll one', async () => {
      const { approver, dataDir } = await sealedSetup({ holders: 0, plain: 1 });
      writeLatch(dataDir);
      const metadata = {};
      await approver.requestApproval('Bash', { command: PARAM }, metadata);
      assert.match(metadata.refusal.error, /Enroll a phone or apply its box key/);
      assert.deepEqual(approver.sealRefusal().reason, 'no_sealed_recipient');
      approver.stop();
    });

    // The real policy over a store that is not trusted, whatever its phones hold.
    it('an untrusted approver set is named as the cause, not a missing phone', async () => {
      const { identity, store, dataDir, link } = await sealedSetup();
      writeLatch(dataDir);
      const untrusted = { list: () => [], isActive: () => false, untrusted: true, problem: 'the approver dir is writable by the service' };
      const sealPolicy = createSealPolicy({ approverStore: untrusted, identity, dataDir });
      const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: fakeLedger(), sealPolicy, setTimer: () => null, clearTimer: () => {} });
      const metadata = {};
      assert.equal(await approver.requestApproval('Bash', { command: PARAM }, metadata), 'unavailable');
      assert.match(metadata.refusal.error, /no_sealed_recipient/);
      assert.match(metadata.refusal.error, /the approver dir is writable by the service/);
      assert.doesNotMatch(metadata.refusal.error, /Enroll/);
      const outcome = await approver.requestAction(liveAction(), { currentAction: liveAction });
      assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'no_sealed_recipient']);
      approver.stop();
    });

    it('a latch that cannot be written is named as the cause while phones hold box keys', async () => {
      const { identity, store, dataDir, link } = await sealedSetup();
      const sealPolicy = createSealPolicy({ approverStore: store, identity, dataDir, writeLatchFile: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } });
      const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: fakeLedger(), sealPolicy, setTimer: () => null, clearTimer: () => {} });
      const metadata = {};
      assert.equal(await approver.requestApproval('Bash', { command: PARAM }, metadata), 'unavailable');
      assert.match(metadata.refusal.error, /no_sealed_recipient/);
      assert.match(metadata.refusal.error, /sealing\.json cannot be written/);
      assert.doesNotMatch(metadata.refusal.error, /Enroll/);
      assert.deepEqual(link.submitted, []);
      approver.stop();
    });

    it('a node with no box key of its own is named as the cause', async () => {
      const { approver } = await sealedSetup({ holders: 1, nodeBox: false });
      const metadata = {};
      await approver.requestApproval('Bash', { command: PARAM }, metadata);
      assert.match(metadata.refusal.error, /no box key of its own/);
      assert.doesNotMatch(metadata.refusal.error, /Enroll/);
      approver.stop();
    });

    it('sealRefusal is null while it can seal, and on the clear path', async () => {
      const sealing = await sealedSetup();
      assert.equal(sealing.approver.sealRefusal(), null);
      sealing.approver.stop();
      const clear = await sealedSetup({ holders: 0, plain: 1 });
      assert.equal(clear.approver.sealRefusal(), null);
      clear.approver.stop();
      const none = await sealedSetup({ withPolicy: false });
      assert.equal(none.approver.sealRefusal(), null);
      none.approver.stop();
    });

    it('a policy that throws is refused, never clear', async () => {
      const { identity } = await sealedSetup({ holders: 0, plain: 1 });
      const boom = () => { throw new Error('store boom'); };
      for (const sealPolicy of [{ sealing: boom }, { sealing: () => true, canSeal: boom }, { sealing: () => true, canSeal: () => true, recipients: boom }]) {
        assert.throws(() => buildRequest({ identity, action: liveAction(), sealPolicy }), (e) => e.reason === 'no_sealed_recipient');
      }
    });

    it('recipients that hold only the node are refused', async () => {
      const { identity } = await sealedSetup({ holders: 0, plain: 1 });
      const sealPolicy = { sealing: () => true, canSeal: () => true, recipients: () => ({ [identity.nodeId]: identity.box.jwk }), senderId: identity.nodeId, nodeBox: identity.box.jwk };
      assert.throws(() => buildRequest({ identity, action: liveAction(), sealPolicy }), (e) => e.reason === 'no_sealed_recipient');
    });
  });

  describe('sizes', () => {
    const sized = (bytes) => {
      const bare = { kind: 'tool', name: 'Write', params: { content: '' }, cwd: null, summary: 'Write' };
      return { ...bare, params: { content: 'x'.repeat(bytes - canonicalize(bare).length) } };
    };
    // What the front door's mirror takes, and the mesh's link frame.
    const MIRROR_PAGE = 262144;
    const FRAME = 1024 * 1024;

    async function policyFor(phones) {
      const identity = testNodeIdentity({ box: true });
      const boxed = Array.from({ length: phones }, () => createFakePhone({ boxKey: true }));
      const store = await approverStoreWith(boxed.map((p) => p.approverRecord({ boxKey: true })));
      stores.push(store);
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-seal-approver-'));
      dirs.push(dataDir);
      return { identity, dataDir, sealPolicy: createSealPolicy({ approverStore: store, identity, dataDir }) };
    }

    it('a full-size action in clear still builds; sealed it is refused action_too_large', async () => {
      const { identity, sealPolicy } = await policyFor(1);
      const full = sized(MAX_ACTION_BYTES);
      assert.equal(buildRequest({ identity, action: full }).salt, null);
      assert.throws(() => buildRequest({ identity, action: full, sealPolicy }), (e) => e.reason === 'action_too_large');
    });

    it('the approver answers a sealed oversize action with the existing error, sending nothing', async () => {
      const { approver, link } = await sealedSetup();
      const full = sized(MAX_ACTION_BYTES);
      const outcome = await approver.requestAction(full, { currentAction: () => full });
      assert.deepEqual([outcome.decision, outcome.reason], ['error', 'action_too_large']);
      assert.deepEqual(link.submitted, []);
      approver.stop();
    });

    it('the model reads plain words for a sealed oversize call, and the old words stay for a clear one', async () => {
      const big = { content: 'x'.repeat(MAX_ACTION_BYTES - 1024) };
      const sealed = await sealedSetup();
      const metadata = {};
      assert.equal(await sealed.approver.requestApproval('Write', big, metadata), 'unavailable');
      assert.equal(metadata.refusal.error, 'A sealed approval holds about 130 KB of parameters. Write it in smaller pieces. Nothing ran.');
      sealed.approver.stop();
      const huge = { content: 'x'.repeat(MAX_ACTION_BYTES) };
      const clear = await sealedSetup({ holders: 0, plain: 1 });
      const clearMeta = {};
      assert.equal(await clear.approver.requestApproval('Write', huge, clearMeta), 'unavailable');
      assert.match(clearMeta.refusal.error, /^Action cannot be shown on the phone \(action_too_large\)/);
      clear.approver.stop();
    });

    it('the largest action that seals, to eight phones and with the longest origin, fits a mirror page and a link frame', async () => {
      const { identity, sealPolicy, dataDir } = await policyFor(8);
      const longest = String.fromCodePoint(0x20ac).repeat(200);
      const origin = { client: longest, session: longest, job_id: longest };
      const fits = (bytes) => {
        try {
          return buildRequest({ identity, action: sized(bytes), origin, sealPolicy });
        } catch (err) {
          if (err.reason === 'action_too_large') return null;
          throw err;
        }
      };
      let low = 1024;
      let high = MAX_ACTION_BYTES;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (fits(mid)) low = mid;
        else high = mid;
      }
      assert.ok(low > 128 * 1024, `the room left for an action, ${low} bytes, is too small`);
      const built = fits(low);
      assert.equal(validateMessage(REQUEST_TYPE, built.message), null);
      assert.equal((Buffer.from(built.message.sealed.ct, 'base64url').length - 16) % 256, 0, 'padded to a whole block, inside the limit');

      const ledger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity, nodeId: identity.nodeId, writer: 'service' });
      // The largest a clear job id could be in an entry; a sealed entry holds none.
      await ledger.append({ kind: 'approval.request', data: { job_id: longest, envelope: built.envelope } });
      const slice = ledger.slice({ limit: 200, after: null, max_bytes: MIRROR_PAGE });
      assert.equal(open(slice).message.entries.length, 1);
      assert.ok(slice.payload.length <= Math.ceil(((MIRROR_PAGE + 1024) * 4) / 3), `the audit page is ${slice.payload.length} characters`);
      assert.ok(Buffer.byteLength(JSON.stringify({ method: 'audit.slice', params: { envelope: slice } })) < FRAME);
      assert.ok(Buffer.byteLength(JSON.stringify({ method: 'approval.submit', params: { envelope: built.envelope } })) < FRAME);
    });
  });
});
