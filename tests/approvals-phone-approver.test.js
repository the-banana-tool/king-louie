// tests/approvals-phone-approver.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { toolAction, actionHash } = require('../src/approvals/messages');
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
