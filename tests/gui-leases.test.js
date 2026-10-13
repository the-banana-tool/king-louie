// tests/gui-leases.test.js
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { open } = require('../src/approvals/envelope');
const { LeaseManager } = require('../src/gui/leases');
const { parseGuiConfig } = require('../src/gui/config');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const L = require('../src/gui/lease-protocol');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const guiConfig = parseGuiConfig({
  enabled: true,
  apps: {
    calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
    notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' }
  },
  lease: { max_inputs_per_minute: 10 }
}, { platform: 'win32' });
const ORIGIN = { client: 'claude.ai', session: 's-1', job_id: 'job-1' };

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
    // Moves the clock without running any timer (a sleeping laptop).
    jump(ms) { clock.t += ms; }
  };
}

class FakeRelay extends EventEmitter {
  constructor() { super(); this.connected = true; this.sent = []; this.methods = new Map(); }
  isConnected() { return this.connected; }
  async send(envelope, opts = {}) {
    if (!this.connected) throw Object.assign(new Error('relay_offline'), { code: 'relay_offline' });
    this.sent.push({ envelope, opts, message: open(envelope).message });
    return { ok: true };
  }
  registerMethod(name, fn) { this.methods.set(name, fn); }
  down() { this.connected = false; this.emit('disconnected'); }
  up() { this.connected = true; this.emit('connected'); }
  last(type) { return [...this.sent].reverse().find((s) => s.message.type === type); }
  all(type) { return this.sent.filter((s) => s.message.type === type); }
}

let phone;
let other;
let identity;
let relay;
let clock;
let timers;
let broker;
let audits;
let leases;
let openJobs;

beforeEach(async () => {
  openJobs = new Set(['job-1', 'job-2', 'job-3']);
  phone = createFakePhone({ name: 'Owner phone' });
  other = createFakePhone({ name: 'Second phone' });
  identity = testNodeIdentity({ key: 'gpu-box' });
  clock = { t: Date.parse('2026-09-23T18:00:00.000Z'), now() { return this.t; } };
  timers = fakeTimers(clock);
  const store = await approverStoreWith([phone.approverRecord(), other.approverRecord()], { now: () => clock.now() });
  stores.push(store);
  relay = new FakeRelay();
  broker = { calls: [], releaseAll: async () => { broker.calls.push('releaseAll'); }, focusApp: async (ids) => { broker.calls.push(['focus', ids]); }, capability: () => ({ limits: ['no_human_yield'] }), leaseChanged: () => {} };
  audits = [];
  leases = new LeaseManager({
    approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } },
    guiConfig, broker, audit: { append: async (e) => { audits.push(e); } }, nodeName: 'gpu-box', clock: () => clock.now(), timers,
    jobOpen: (jobId) => openJobs.has(jobId)
  });
  leases.start();
});

async function granted({ appIds = ['calculator'], minutes = 10, jobId = 'job-1' } = {}) {
  const p = leases.request({ jobId, origin: { ...ORIGIN, job_id: jobId }, appIds, minutes: 15, reason: 'Enter the totals' });
  const req = relay.last('kl.lease.request');
  const reply = leases.onGrant(phone.leaseGrant(req.envelope, { minutes }));
  assert.equal(reply.state, 'active');
  // The reply carries the status the node just signed: the phone's first contact token.
  assert.deepEqual(open(reply.status).message, relay.last('kl.lease.status').message);
  return p;
}

// A reply without the signed status it may carry.
const plain = ({ status, ...rest }) => rest;
// The newest contact token the node has sent for the lease, in a status or
// a view: what a phone that applies everything it receives holds.
const newestToken = (lease) => [...relay.sent].reverse().map((s) => s.message).find((m) => m.lease_id === lease.leaseId && typeof m.contact_token === 'string').contact_token;
// A watch as the apps build it: it echoes the newest token the phone holds
// (R-F5-15: only such a watch, from the granting phone, is contact).
const watchFrom = (device, lease, extra = {}) => device.leaseWatch(identity.nodeId, lease.leaseId, { signedAt: new Date(clock.now()).toISOString(), contactToken: newestToken(lease), ...extra });

const kinds = () => audits.map((a) => a.kind);

describe('request and grant', () => {
  it('grant → the lease is usable for its job only; the request carries the probe limits and a push', async () => {
    const lease = await granted();
    const req = relay.all('kl.lease.request')[0];
    assert.deepEqual(req.opts.push, { kind: 'lease', id: req.message.request_id, expires_at: req.message.expires_at });
    assert.deepEqual(req.message.lease.limits, ['no_human_yield']);
    assert.equal(req.message.lease.apps[0].path, 'C:\\Windows\\System32\\calc.exe');
    assert.equal(leases.assertUsable('job-1'), lease);
    assert.throws(() => leases.assertUsable('job-2'), (e) => e.code === 'lease_required');
    assert.equal(lease.expiresAt, clock.now() + 10 * 60000);
    assert.ok(kinds().includes('lease.requested') && kinds().includes('lease.granted'));
    assert.equal(relay.last('kl.lease.status').message.state, 'active');
  });

  it('a narrowed grant leases only the apps the phone kept', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator', 'notepad'], minutes: 15, reason: 'x' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { apps: ['notepad'], minutes: 5 }));
    assert.deepEqual((await p).apps, ['notepad']);
  });

  it('deny → lease_denied; a request left unanswered for 5 minutes → lease_request_expired', async () => {
    const denied = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { decision: 'deny' }));
    await assert.rejects(denied, (e) => e.code === 'lease_denied');
    const waiting = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    timers.advance(5 * 60000 + 1);
    await assert.rejects(waiting, (e) => e.code === 'lease_request_expired');
    assert.ok(kinds().includes('lease.denied'));
  });

  it('a grant that fails a check is audited and leaves the request pending', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const env = relay.last('kl.lease.request').envelope;
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env, { minutes: 16 })), { state: 'rejected', reason: 'minutes_out_of_range' });
    assert.ok(audits.some((a) => a.kind === 'lease.rejected' && a.data.check === 12));
    assert.deepEqual(plain(leases.onGrant(phone.leaseGrant(env, { minutes: 3 }))), { state: 'active' });
    await p;
  });

  it('lease_busy for another job; the same job gets its lease back or lease_pending', async () => {
    const pending = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'lease_pending');
    await assert.rejects(leases.request({ jobId: 'job-2', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'lease_busy');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    const lease = await pending;
    assert.equal(await leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), lease);
  });

  it('no phone to sign: approval_unavailable before any request goes out', async () => {
    const store = await approverStoreWith([]);
    stores.push(store);
    const none = new LeaseManager({ approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => false } }, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers });
    await assert.rejects(none.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'approval_unavailable');
    assert.equal(relay.all('kl.lease.request').length, 0);
  });

  it('refuses apps not in gui.apps and minutes out of range', async () => {
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['terminal'], minutes: 15, reason: 'x' }), (e) => e.code === 'invalid_params');
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 61, reason: 'x' }), (e) => e.code === 'invalid_params');
  });
});

// Fourth security review, finding 1 (R-F5-17): on Windows the service's
// write probe of the administrator's record of the node identity is run
// again before every new lease request (identityProbe, which the subsystem
// builds from probeIdentityRecord), as the approver set's probe is on every
// scan.
describe('the identity record is probed again before every new lease request', () => {
  const ask = (m) => m.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
  const manager = (identityProbe, log) => new LeaseManager({
    approvals: leases.approvals, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers, jobOpen: (jobId) => openJobs.has(jobId), identityProbe, log
  });
  const spy = () => { const lines = { error: [], info: [] }; return { lines, error: (m) => lines.error.push(m), info: (m) => lines.info.push(m), warn() {}, debug() {} }; };

  it('a record this process can now write: no request goes out, and it is logged once with what to do', async () => {
    let problem = '<configDir>/identity/node.json cannot be trusted: it is writable by the account running the service';
    let asked = 0;
    const log = spy();
    const m = manager(() => { asked += 1; return problem; }, log);
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(ask(m), (e) => e.code === 'capability_unavailable' && /node_identity_invalid/.test(e.message) && !/configDir/.test(e.message));
    }
    assert.equal(asked, 3, 'asked before every request');
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.equal(m.current(), null);
    assert.equal(log.lines.error.length, 1, 'logged when the answer changes, not every time');
    assert.match(log.lines.error[0], /writable by the account running the service/);
    assert.match(log.lines.error[0], /identity record --replace/);
    // Out of reach again: requests go out, and that is logged once too.
    problem = null;
    const pending = ask(m);
    assert.equal(relay.all('kl.lease.request').length, 1);
    assert.equal(log.lines.info.length, 1);
    pending.catch(() => {});
    m.stop();
  });

  it('a probe that throws proves nothing: refused; no probe (off Windows, or a host that ran none) changes nothing', async () => {
    const m = manager(() => { throw Object.assign(new Error('boom'), { code: 'EIO' }); }, spy());
    await assert.rejects(ask(m), (e) => e.code === 'capability_unavailable');
    assert.equal(relay.all('kl.lease.request').length, 0);
    const pending = ask(manager(null, spy()));
    assert.equal(relay.all('kl.lease.request').length, 1);
    pending.catch(() => {});
  });
});

describe('R-F5-7: a lease needs a known, open job', () => {
  it('R-F5-7: no job id is job_required, a job that is not open is job_closed, and nothing goes out', async () => {
    for (const jobId of [null, undefined, '', 42]) {
      await assert.rejects(leases.request({ jobId, origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_required', String(jobId));
    }
    await assert.rejects(leases.request({ jobId: 'job-unknown', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.equal(leases.current(), null);
    assert.ok(!kinds().includes('lease.requested'));
  });

  it('R-F5-7: with no jobOpen given, no job is open; one that throws counts as closed', async () => {
    const base = { approvals: leases.approvals, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers };
    await assert.rejects(new LeaseManager(base).request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    const throwing = new LeaseManager({ ...base, jobOpen: () => { throw new Error('store unavailable'); } });
    await assert.rejects(throwing.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    assert.equal(relay.all('kl.lease.request').length, 0);
  });

  it('R-F5-7: a grant for a job that closed is rejected at check 12 and ends the lease', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const env = relay.last('kl.lease.request').envelope;
    openJobs.delete('job-1');
    const reply = leases.onGrant(phone.leaseGrant(env));
    assert.deepEqual(plain(reply), { state: 'ended', reason: 'job_closed' });
    assert.deepEqual([open(reply.status).message.state, open(reply.status).message.reason], ['ended', 'job_closed']);
    await assert.rejects(p, (e) => e.code === 'job_closed');
    assert.ok(audits.some((a) => a.kind === 'lease.rejected' && a.data.check === 12 && a.data.reason === 'job_closed'));
    assert.equal(leases.current(), null);
    assert.equal(relay.last('kl.lease.status').message.reason, 'job_closed');
    // Nothing is left pending for that request.
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env)), { state: 'rejected', reason: 'unknown_request' });
  });

  it('R-F5-7: a lease whose job is gone ends at the next input and does not block another job', async () => {
    const lease = await granted();
    openJobs.delete('job-1');
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'job_closed');
    assert.equal(lease.state, 'ended');
    assert.equal(lease.endReason, 'job_closed');
    assert.ok(broker.calls.includes('releaseAll'));

    const second = await granted({ jobId: 'job-2' });
    openJobs.delete('job-2');
    // job-3 asks while job-2's lease is still on the books: no lease_busy.
    const third = leases.request({ jobId: 'job-3', origin: { ...ORIGIN, job_id: 'job-3' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
    assert.equal(second.endReason, 'job_closed');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    assert.equal((await third).jobId, 'job-3');
  });
});

describe('suspension and resume', () => {
  it('a foreground refusal suspends, releases input, and asks to resume without extending', async () => {
    const lease = await granted({ minutes: 10 });
    const originalExpiry = lease.expiresAt;
    // Three minutes in, with the granting phone watching (R-F5-15).
    for (let i = 0; i < 3; i += 1) {
      timers.advance(60000);
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
    }
    assert.equal(leases.noteInputOutcome(lease, { code: 'foreground_mismatch' }), true);
    assert.equal(lease.state, 'suspended');
    assert.ok(broker.calls.includes('releaseAll'));
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended');
    const resume = relay.last('kl.lease.request');
    assert.equal(resume.message.lease.resumes, lease.leaseId);
    assert.equal(resume.message.lease.max_minutes, 7);
    assert.ok(kinds().includes('lease.suspended'));
    leases.onGrant(phone.leaseGrant(resume.envelope, { minutes: 7 }));
    assert.equal(lease.state, 'active');
    assert.equal(lease.expiresAt, originalExpiry, 'a resume never extends');
    assert.ok(kinds().includes('lease.resumed'));
    assert.deepEqual(broker.calls.find((c) => Array.isArray(c) && c[0] === 'focus'), ['focus', ['calculator']]);
  });

  it('app_not_running suspends; point_obscured, user_active, stale_screenshot and screen_locked do not', async () => {
    const lease = await granted();
    for (const c of ['point_obscured', 'user_active', 'stale_screenshot', 'screen_locked', 'outside_window']) {
      assert.equal(leases.noteInputOutcome(lease, { code: c }), false, c);
      assert.equal(lease.state, 'active');
    }
    assert.equal(leases.noteInputOutcome(lease, { code: 'app_not_running' }), true);
    assert.equal(lease.state, 'suspended');
  });

  it('a foreground outside the leased set after an input suspends', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { afterMatches: false }), true);
    assert.equal(lease.suspendReason, 'foreground_changed');
  });

  it('crash, relaunch, resume: the app dying suspends, and a resume grant continues the lease', async () => {
    const lease = await granted();
    leases.noteInputOutcome(lease, { code: 'app_not_running' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 1 }));
    assert.equal(leases.assertUsable('job-1'), lease);
  });

  it('helper restart: the gui drops, the lease suspends; after a grant input works again', async () => {
    const lease = await granted();
    leases.onHelperDisconnected();
    assert.equal(lease.suspendReason, 'helper_disconnected');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 1 }));
    assert.equal(leases.assertUsable('job-1'), lease);
  });

  it('relay disconnect suspends at once; the resume is asked when the link returns', async () => {
    const lease = await granted();
    const before = relay.all('kl.lease.request').length;
    relay.down();
    assert.equal(lease.state, 'suspended');
    assert.equal(lease.suspendReason, 'relay_unreachable');
    assert.equal(relay.all('kl.lease.request').length, before, 'nothing sent while down');
    relay.up();
    const resume = relay.last('kl.lease.request');
    assert.equal(resume.message.lease.resumes, lease.leaseId);
    leases.onGrant(phone.leaseGrant(resume.envelope, { minutes: 1 }));
    assert.equal(lease.state, 'active');
  });

  it('a request made while the relay is down is delivered when it returns', async () => {
    relay.down();
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    await new Promise((r) => setImmediate(r));
    assert.equal(relay.all('kl.lease.request').length, 0);
    relay.up();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    await p;
  });

  it('human yield: user_active does not suspend; the owner switching apps does', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { code: 'user_active' }), false);
    assert.equal(leases.noteInputOutcome(lease, { code: 'foreground_mismatch' }), true);
  });
});

describe('lock, expiry and revoke', () => {
  it('lock pauses inputs, the clock runs, unlock continues without re-signing', async () => {
    const lease = await granted({ minutes: 10 });
    leases.setLocked(true);
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'screen_locked');
    assert.equal(relay.last('kl.lease.status').message.locked, true);
    timers.advance(60000);
    leases.setLocked(false);
    assert.equal(leases.assertUsable('job-1'), lease);
    assert.equal(lease.expiresAt, Date.parse('2026-09-23T18:10:00.000Z'));
  });

  it('Review Focus 3: screen_locked from the helper refuses without suspending', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { code: 'screen_locked' }), false);
    assert.equal(lease.state, 'active');
    assert.equal(relay.all('kl.lease.request').length, 1, 'no resume request');
  });

  it('expiry is on the node clock, whatever the phone clock said', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const signedAt = new Date(clock.now() - 3600000).toISOString();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 2, signedAt }));
    const lease = await p;
    timers.advance(2 * 60000);
    assert.equal(lease.state, 'ended');
    assert.equal(lease.endReason, 'expired');
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_expired');
    assert.ok(broker.calls.includes('releaseAll'));
    assert.ok(kinds().includes('lease.expired'));
  });

  it('Review Focus 2: an input after expires_at is refused even when the expiry timer has not fired', async () => {
    await granted({ minutes: 2 });
    timers.jump(2 * 60000 + 1);
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_expired');
  });

  it('revoke (mid-Drag) ends the lease and releases held buttons; the next input is lease_revoked', async () => {
    const lease = await granted();
    broker.calls.length = 0;
    const out = leases.onRevoke(other.leaseRevoke(identity.nodeId, lease.leaseId));
    assert.deepEqual(plain(out), { state: 'ended' });
    assert.deepEqual([open(out.status).message.state, open(out.status).message.reason], ['ended', 'revoked'], 'the reply carries the node-signed status');
    assert.ok(broker.calls.includes('releaseAll'));
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_revoked');
    assert.equal(relay.last('kl.lease.status').message.reason, 'revoked');
    assert.ok(kinds().includes('lease.revoked'));
  });

  it('a replayed revoke changes nothing and re-sends the status; an unknown lease is refused', async () => {
    const lease = await granted();
    const revoke = phone.leaseRevoke(identity.nodeId, lease.leaseId);
    leases.onRevoke(revoke);
    const statuses = relay.all('kl.lease.status').length;
    assert.equal(leases.onRevoke(revoke).state, 'ended');
    assert.equal(relay.all('kl.lease.status').length, statuses + 1);
    assert.deepEqual(leases.onRevoke(phone.leaseRevoke(identity.nodeId, '00000000-0000-4000-8000-000000000000')), { state: 'rejected', reason: 'unknown_lease' });
  });

  it('endForJob ends the job\'s lease; stopAll ends everything as service_stopped', async () => {
    const lease = await granted();
    leases.endForJob('job-2');
    assert.equal(lease.state, 'active');
    leases.endForJob('job-1');
    assert.equal(lease.endReason, 'job_closed');
    const second = await granted({ jobId: 'job-3' });
    leases.stopAll();
    assert.equal(second.endReason, 'service_stopped');
  });

  it('rate limit: max_inputs_per_minute, with retry_after', async () => {
    const lease = await granted();
    for (let i = 0; i < 10; i += 1) leases.chargeInput(lease);
    assert.throws(() => leases.chargeInput(lease), (e) => e.code === 'rate_limited' && e.retryAfter === 60);
    timers.advance(60001);
    leases.chargeInput(lease);
  });

  it('a watch from an enrolled device for a known lease is accepted once', async () => {
    const lease = await granted();
    const watch = other.leaseWatch(identity.nodeId, lease.leaseId);
    const ok = leases.verifyWatch(watch);
    assert.equal(ok.accepted, true);
    assert.equal(ok.deviceId, other.deviceId);
    assert.equal(leases.verifyWatch(watch).reason, 'replay');
  });

  // Security review finding 5: a watch or a revoke has no validity window of
  // its own, so its nonce is remembered for as long as its lease is.
  it('finding 5: a watch replayed after the old 10-minute cache has lapsed is still a replay', async () => {
    const lease = await granted({ minutes: 15 });
    const watch = other.leaseWatch(identity.nodeId, lease.leaseId);
    assert.equal(leases.verifyWatch(watch).accepted, true);
    timers.jump(11 * 60000);
    assert.equal(lease.state, 'active', 'the lease is still live');
    assert.deepEqual(leases.verifyWatch(watch), { accepted: false, reason: 'replay' });
    // A fresh watch is still accepted, and the same nonce under other bytes is not.
    assert.equal(leases.verifyWatch(other.leaseWatch(identity.nodeId, lease.leaseId)).accepted, true);
    const nonce = require('crypto').randomBytes(32).toString('base64url');
    assert.equal(leases.verifyWatch(phone.leaseWatch(identity.nodeId, lease.leaseId, { nonce })).accepted, true);
    timers.jump(11 * 60000);
    assert.equal(leases.verifyWatch(phone.leaseWatch(identity.nodeId, lease.leaseId, { nonce, signedAt: new Date(clock.now()).toISOString() })).reason, 'already_decided');
  });

  it('finding 5: a revoke replayed after the old cache lapsed, on an ended lease, is a replay that changes nothing', async () => {
    const lease = await granted();
    const watch = other.leaseWatch(identity.nodeId, lease.leaseId);
    leases.verifyWatch(watch);
    const revoke = phone.leaseRevoke(identity.nodeId, lease.leaseId);
    assert.deepEqual(plain(leases.onRevoke(revoke)), { state: 'ended' });
    timers.jump(11 * 60000);
    const rejected = audits.filter((a) => a.kind === 'lease.rejected').length;
    assert.equal(leases.onRevoke(revoke).state, 'ended');
    assert.equal(audits.filter((a) => a.kind === 'lease.rejected').length, rejected, 'a replay is not audited as a rejection');
    // The ended lease's watch nonces are kept with it too.
    assert.equal(leases.verifyWatch(watch).reason, 'replay');
  });

  it('finding 5: a lease remembers a bounded number of watch nonces and then refuses more; a revoke is never refused for that', async () => {
    const lease = await granted({ minutes: 15 });
    lease.controlNonces.max = 3;
    for (let i = 0; i < 3; i += 1) assert.equal(leases.verifyWatch(other.leaseWatch(identity.nodeId, lease.leaseId)).accepted, true);
    assert.deepEqual(leases.verifyWatch(other.leaseWatch(identity.nodeId, lease.leaseId)), { accepted: false, reason: 'too_many_watches' });
    assert.deepEqual(plain(leases.onRevoke(phone.leaseRevoke(identity.nodeId, lease.leaseId))), { state: 'ended' });
  });

  // R-F5-15 (owner ruling, 2026-10-13): input needs the granting phone to
  // stay in touch. `phone` grants in these tests; `other` is another
  // enrolled device. All on the node's (injected) clock.
  describe('R-F5-15: no contact from the granting phone suspends input', () => {
    const { CONTACT_REASON } = require('../src/gui/leases');
    const WINDOW = 120000;
    // The fake clock jumps to the end of an advance before its timers run;
    // where a test reads when something happened, it moves a second at a time.
    const seconds = (n) => { for (let i = 0; i < n; i += 1) timers.advance(1000); };

    it('the window is one constant, 2 minutes by default, set under gui.lease.contact_s and never above 5 minutes', () => {
      const { parseGuiConfig: parse, GUI_KEYS } = require('../src/gui/config');
      assert.equal(guiConfig.lease.contactS, 120);
      assert.ok(GUI_KEYS.lease.includes('contact_s'));
      assert.equal(parse({ enabled: true, lease: { contact_s: 300 } }, { platform: 'win32' }).lease.contactS, 300);
      assert.equal(parse({ enabled: true, lease: { contact_s: 30 } }, { platform: 'win32' }).lease.contactS, 30);
      for (const bad of [301, 600, 29, 0, 1.5, '120']) {
        assert.throws(() => parse({ enabled: true, lease: { contact_s: bad } }, { platform: 'win32' }), /gui\.lease\.contact_s must be an integer from 30 to 300/, String(bad));
      }
      assert.equal(CONTACT_REASON, 'no_contact');
    });

    it('the clock starts at the grant; when the window lapses the lease is suspended, not ended, and what was held is released', async () => {
      const lease = await granted();
      const expiresAt = lease.expiresAt;
      timers.advance(WINDOW - 1000);
      assert.equal(leases.assertUsable('job-1'), lease, 'still inside the window');
      broker.calls.length = 0;
      const requests = relay.all('kl.lease.request').length;
      timers.advance(1001);
      assert.equal(lease.state, 'suspended');
      assert.equal(lease.suspendReason, 'no_contact');
      assert.ok(broker.calls.includes('releaseAll'), 'held keys and buttons are released');
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
      const status = relay.last('kl.lease.status').message;
      assert.deepEqual([status.state, status.reason], ['suspended', 'no_contact']);
      assert.equal(relay.all('kl.lease.request').length, requests, 'no resume request is sent to the phone: a watch resumes it');
      assert.ok(audits.some((a) => a.kind === 'lease.suspended' && a.data.reason === 'no_contact'));
      assert.equal(lease.expiresAt, expiresAt);
      assert.equal(leases.current(), lease, 'it still holds the node\'s lease');
    });

    // Third security review, finding 3: a timer may fire a little early (a
    // coarse timer, two clocks that drift apart). It used to find the window
    // not yet lapsed, do nothing and never run again, so the suspension (the
    // status, release_all, the live view's stop) waited for the next input.
    it('a contact timer that fires early is armed again for the rest of the window', async () => {
      const lease = await granted();
      const early = lease.contactTimer;
      timers.clearTimeout(early); // it will not fire on time: it fires now, 30 ms early
      timers.advance(WINDOW - 30);
      broker.calls.length = 0;
      early.fn();
      assert.equal(lease.state, 'active', 'the window has not lapsed');
      timers.advance(29);
      assert.equal(lease.state, 'active');
      timers.advance(1);
      assert.equal(lease.state, 'suspended', 'suspended when the window lapses, with no input to find it');
      assert.equal(lease.suspendReason, 'no_contact');
      assert.ok(broker.calls.includes('releaseAll'));
      assert.deepEqual([relay.last('kl.lease.status').message.state, relay.last('kl.lease.status').message.reason], ['suspended', 'no_contact']);
    });

    it('an early contact timer after a later contact waits for that contact window, once', async () => {
      const lease = await granted();
      timers.advance(60000);
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
      const timer = lease.contactTimer;
      timers.clearTimeout(timer);
      timers.advance(WINDOW - 5000);
      timer.fn();
      timer.fn(); // and a second early firing leaves one timer, not two
      assert.equal(lease.state, 'active');
      timers.advance(4999);
      assert.equal(lease.state, 'active');
      timers.advance(1);
      assert.equal(lease.state, 'suspended');
      assert.equal(relay.all('kl.lease.status').filter((s) => s.message.state === 'suspended').length, 1);
    });

    it('a laptop that slept through the window: the next input finds the lapse without the timer', async () => {
      const lease = await granted();
      timers.jump(WINDOW + 1);
      assert.equal(lease.state, 'active', 'no timer ran');
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
      assert.equal(lease.state, 'suspended');
    });

    it('a fresh watch from the granting phone keeps it going, and resumes it after a lapse without extending it', async () => {
      const lease = await granted();
      const expiresAt = lease.expiresAt;
      // Watches a minute apart, each echoing the token the last answer brought: never suspended.
      for (let i = 0; i < 3; i += 1) {
        timers.advance(60000);
        const seen = leases.verifyWatch(watchFrom(phone, lease));
        assert.equal(seen.accepted, true);
        assert.equal(seen.contact, true);
        assert.equal(lease.state, 'active');
      }
      timers.advance(WINDOW + 1);
      assert.equal(lease.state, 'suspended');
      // The owner stays away for another two minutes. The newest token the
      // phone can hold (the one in the status that said "suspended") is
      // older than the window by then: this watch is not contact, but its
      // answer brings a fresh token.
      timers.advance(WINDOW);
      const stale = leases.verifyWatch(watchFrom(phone, lease));
      assert.deepEqual([stale.accepted, stale.contact], [true, false]);
      assert.equal(lease.state, 'suspended');
      assert.equal(open(stale.status).message.contact_token, newestToken(lease));
      // The next watch echoes it: contact.
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
      assert.equal(lease.state, 'active');
      assert.equal(lease.suspendReason, null);
      assert.equal(leases.assertUsable('job-1'), lease);
      assert.equal(lease.expiresAt, expiresAt, 'a resume never extends the lease');
      assert.equal(relay.last('kl.lease.status').message.state, 'active');
      assert.ok(audits.some((a) => a.kind === 'lease.resumed' && a.data.reason === 'contact'));
      // And the window runs again from that watch.
      timers.advance(WINDOW + 1);
      assert.equal(lease.state, 'suspended');
    });

    it('a replayed watch is not contact', async () => {
      const lease = await granted();
      timers.advance(60000);
      const watch = watchFrom(phone, lease);
      assert.equal(leases.verifyWatch(watch).accepted, true);
      // Replayed inside the window: it does not push the window out.
      timers.advance(90000);
      assert.equal(leases.verifyWatch(watch).reason, 'replay');
      timers.advance(30001);
      assert.equal(lease.state, 'suspended', 'two minutes after the one real watch');
      // Replayed after the lapse: it does not resume.
      assert.equal(leases.verifyWatch(watch).reason, 'replay');
      assert.equal(lease.state, 'suspended');
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
    });

    it('only the granting device counts: another enrolled device\'s watch is accepted for the live view and is not contact', async () => {
      const lease = await granted();
      timers.advance(60000);
      const seen = leases.verifyWatch(watchFrom(other, lease));
      assert.equal(seen.accepted, true);
      assert.equal(seen.deviceId, other.deviceId);
      timers.advance(60001);
      assert.equal(lease.state, 'suspended', 'two minutes after the grant, whatever the other phone sent');
      // Even echoing a token the node has just issued.
      const fromOther = leases.verifyWatch(watchFrom(other, lease));
      assert.deepEqual([fromOther.accepted, fromOther.contact], [true, false]);
      assert.equal(lease.state, 'suspended', 'and it does not resume it');
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
      assert.equal(lease.state, 'active');
    });

    // Second security review, finding 3: the relay passes every watch, and
    // the phones take their clock from it, so nothing in a watch says when
    // it was signed. A relay could bank watches and feed them in later.
    describe('finding 3: a watch is contact only with a token the node issued inside the window', () => {
      it('banked watches fed in later, one every two minutes, are not contact', async () => {
        const lease = await granted({ minutes: 15 });
        // The phone watches for a while; the relay delivers none of it and keeps every watch.
        const banked = [];
        for (let i = 0; i < 5; i += 1) banked.push(watchFrom(phone, lease, { signedAt: new Date(clock.now() + i * 20000).toISOString() }));
        // Then the owner stops looking. The relay feeds the banked watches in, one before each lapse.
        seconds(119);
        const first = leases.verifyWatch(banked[0]);
        assert.deepEqual([first.accepted, first.contact], [true, true], 'the one watch a relay can hold: its token is still inside the window');
        for (const watch of banked.slice(1)) {
          seconds(119);
          const fed = leases.verifyWatch(watch);
          assert.deepEqual([fed.accepted, fed.contact], [true, false], 'a banked watch echoes a token that is used, or too old');
        }
        assert.equal(lease.state, 'suspended');
        assert.equal(lease.suspendReason, 'no_contact');
        assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
        // Input stopped inside two windows of the phone's last signature (the grant, here).
        const suspendedAt = Date.parse(relay.all('kl.lease.status').find((s) => s.message.state === 'suspended').message.at);
        assert.ok(suspendedAt - Date.parse('2026-09-23T18:00:00.000Z') < 2 * WINDOW);
      });

      it('a watch that echoes a token older than the window is not contact, however new its nonce', async () => {
        const lease = await granted();
        timers.advance(WINDOW + 1);
        assert.equal(lease.state, 'suspended');
        // The status that said so carries the newest token there is. One
        // millisecond short of the window it would still make contact...
        const token = newestToken(lease);
        const issuedAt = Date.parse(relay.last('kl.lease.status').message.at);
        timers.advance(issuedAt + WINDOW - clock.now());
        // ...and at the window it does not, in a watch signed this instant.
        const late = leases.verifyWatch(watchFrom(phone, lease, { contactToken: token }));
        assert.deepEqual([late.accepted, late.contact], [true, false]);
        assert.equal(lease.state, 'suspended');
        // The same lease, a token one millisecond younger than the window: contact.
        const fresh = open(late.status).message.contact_token;
        timers.advance(WINDOW - 1);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: fresh })).contact, true);
        assert.equal(lease.state, 'active');
      });

      it('a token makes contact once: a second watch that echoes it is not contact', async () => {
        const lease = await granted();
        const token = newestToken(lease);
        timers.advance(30000);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: token })).contact, true);
        timers.advance(60000);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: token })).contact, false);
        timers.advance(60001);
        assert.equal(lease.state, 'suspended', 'two minutes after the one contact that token made');
      });

      it('using a token retires the older ones: a watch kept back and delivered after a later one is not contact', async () => {
        const lease = await granted();
        const older = watchFrom(phone, lease);
        timers.advance(20000);
        leases._sendStatus(lease);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
        timers.advance(60000);
        assert.equal(leases.verifyWatch(older).contact, false);
      });

      it('no token, a token the node never issued, another lease\'s token: accepted as a watch, never contact', async () => {
        const lease = await granted();
        timers.advance(WINDOW + 1);
        assert.equal(lease.state, 'suspended');
        for (const contactToken of [null, 'AAAAAAAAAAAAAAAAAAAAAA']) {
          const seen = leases.verifyWatch(watchFrom(phone, lease, { contactToken }));
          assert.deepEqual([seen.accepted, seen.contact], [true, false]);
          assert.equal(lease.state, 'suspended');
        }
        // A token that is not 16 bytes of base64url is not a watch at all.
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: 'short' })).reason, 'malformed');
        assert.ok(audits.some((a) => a.kind === 'lease.watch' && a.data.contact === false));
      });

      it('the iPhone\'s cadence (a watch every 20 s, echoing the newest token) keeps the lease alive to its expiry', async () => {
        const lease = await granted({ minutes: 10 });
        for (let t = 20000; t < 10 * 60000; t += 20000) {
          timers.advance(20000);
          const seen = leases.verifyWatch(watchFrom(phone, lease));
          assert.equal(seen.contact, true, `at ${t / 1000} s`);
          assert.equal(lease.state, 'active');
        }
        timers.advance(20000);
        assert.equal(lease.endReason, 'expired');
      });

      it('a locked screen sends no frames: the status that answers each watch still carries the next token', async () => {
        const lease = await granted();
        leases.setLocked(true);
        const views = relay.all('kl.lease.view').length;
        for (let i = 0; i < 12; i += 1) {
          timers.advance(20000);
          const seen = leases.verifyWatch(watchFrom(phone, lease));
          assert.equal(seen.contact, true);
          assert.equal(open(seen.status).message.contact_token, newestToken(lease));
        }
        assert.equal(relay.all('kl.lease.view').length, views);
        assert.equal(lease.state, 'active');
      });

      it('Android: Refresh after a pause gets a fresh status, and the watch that follows it is contact', async () => {
        const lease = await granted();
        // The owner taps Refresh once, a minute in.
        timers.advance(60000);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
        // Then nothing for five minutes: paused at 3:00.
        seconds(5 * 60);
        assert.equal(lease.state, 'suspended');
        // What the phone holds is five minutes old. Its first tap is answered with a status signed now...
        const first = leases.verifyWatch(watchFrom(phone, lease));
        assert.equal(first.contact, false);
        const status = open(first.status).message;
        assert.deepEqual([status.state, status.reason], ['suspended', 'no_contact']);
        // ...and the watch after that status makes contact.
        timers.advance(5000);
        const second = leases.verifyWatch(watchFrom(phone, lease, { contactToken: status.contact_token }));
        assert.equal(second.contact, true);
        assert.equal(open(second.status).message.state, 'active');
        assert.equal(leases.assertUsable('job-1'), lease);
      });

      it('the grant is the first contact, and its reply carries the first token: a just-granted lease makes contact with its first watch', async () => {
        const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
        const reply = leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 }));
        const lease = await p;
        const token = open(reply.status).message.contact_token;
        assert.match(token, /^[A-Za-z0-9_-]{22}$/);
        timers.advance(90000);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: token })).contact, true);
        timers.advance(90000);
        assert.equal(lease.state, 'active', 'three minutes after the grant');
      });

      it('every status and view carries its own token; an ended lease forgets them all', async () => {
        const lease = await granted();
        leases.setLocked(true);
        leases.setLocked(false);
        const tokens = relay.all('kl.lease.status').filter((s) => s.message.lease_id === lease.leaseId).map((s) => s.message.contact_token);
        assert.ok(tokens.length >= 3);
        assert.equal(new Set(tokens).size, tokens.length);
        const live = tokens.at(-1);
        leases.onRevoke(phone.leaseRevoke(identity.nodeId, lease.leaseId));
        assert.equal(lease.tokens.size, 0);
        assert.equal(leases.verifyWatch(watchFrom(phone, lease, { contactToken: live })).contact, false);
        assert.equal(lease.state, 'ended');
      });
    });

    it('expiry and Stop still end a lease that is suspended for no contact', async () => {
      const lease = await granted({ minutes: 5 });
      timers.advance(WINDOW + 1);
      assert.equal(lease.state, 'suspended');
      timers.advance(5 * 60000);
      assert.equal(lease.state, 'ended');
      assert.equal(lease.endReason, 'expired');
      // A watch after that resumes nothing.
      leases.verifyWatch(watchFrom(phone, lease));
      assert.equal(lease.state, 'ended');

      const second = await granted({ jobId: 'job-2' });
      timers.advance(WINDOW + 1);
      assert.equal(second.state, 'suspended');
      assert.deepEqual(plain(leases.onRevoke(other.leaseRevoke(identity.nodeId, second.leaseId))), { state: 'ended' });
      assert.equal(second.endReason, 'revoked');
      assert.throws(() => leases.assertUsable('job-2'), (e) => e.code === 'lease_revoked');
    });

    it('a watch that arrives after the lease\'s own expiry ends it instead of resuming it', async () => {
      const lease = await granted({ minutes: 3 });
      timers.jump(WINDOW + 1);
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
      timers.jump(2 * 60000);
      leases.verifyWatch(watchFrom(phone, lease));
      assert.equal(lease.state, 'ended');
      assert.equal(lease.endReason, 'expired');
    });

    it('a lease suspended for another reason is not resumed by a watch; its grant restarts the window', async () => {
      const lease = await granted();
      leases.suspend(lease.leaseId, 'foreground_changed');
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).accepted, true);
      assert.equal(lease.state, 'suspended');
      assert.equal(lease.suspendReason, 'foreground_changed');
      timers.advance(WINDOW + 1);
      assert.equal(lease.suspendReason, 'foreground_changed', 'the reason it was suspended for stands');
      leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 5 }));
      assert.equal(lease.state, 'active');
      timers.advance(WINDOW - 1000);
      assert.equal(lease.state, 'active', 'the window started again at the resume grant');
      timers.advance(1001);
      assert.equal(lease.suspendReason, 'no_contact');
    });

    it('RequestLease on a lease suspended for no contact asks the phone to resume it, like any suspended lease', async () => {
      const lease = await granted();
      timers.advance(WINDOW + 1);
      const requests = relay.all('kl.lease.request').length;
      const again = leases.request({ jobId: 'job-1', origin: { ...ORIGIN, job_id: 'job-1' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
      assert.equal(relay.all('kl.lease.request').length, requests + 1);
      assert.equal(relay.last('kl.lease.request').message.lease.resumes, lease.leaseId);
      leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 5 }));
      assert.equal(await again, lease);
      assert.equal(lease.state, 'active');
    });
  });

  // Third security review, hardening (b): when the phone that granted a
  // lease is revoked, the lease ends at once. It used to pause only when
  // the contact window ran out, and stay resumable by nobody.
  describe('the leases a revoked device granted end', () => {
    const fs = require('fs');
    const path = require('path');
    const store = () => leases.approvals.approverStore;
    const adminRevokes = (device) => {
      const record = device.approverRecord({ revokedAt: new Date(clock.now()).toISOString(), revokedBy: 'console' });
      fs.writeFileSync(path.join(store().dir, `${device.deviceId}.json`), JSON.stringify(record));
    };

    it('a revoke relayed from another phone (staged): the lease ends as it is staged, with release_all, a status and an audit entry', async () => {
      const lease = await granted();
      broker.calls.length = 0;
      assert.equal(store().stage(other.revoke(phone.deviceId, { now: clock.now() })).state, 'revoked-pending-apply');
      assert.equal(lease.state, 'ended');
      assert.equal(lease.endReason, 'device_revoked');
      assert.ok(broker.calls.includes('releaseAll'));
      const status = relay.last('kl.lease.status').message;
      assert.deepEqual([status.lease_id, status.state, status.reason], [lease.leaseId, 'ended', 'device_revoked']);
      assert.ok(audits.some((a) => a.kind === 'lease.ended' && a.data.reason === 'device_revoked' && a.data.lease_id === lease.leaseId));
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_revoked' && /phone that granted/.test(e.message));
      assert.equal(leases.current(), null);
    });

    it('a revoke written by the administrator (device revoke, device apply): found at the next check, five seconds at most', async () => {
      const { GRANTOR_CHECK_MS } = require('../src/gui/leases');
      assert.equal(GRANTOR_CHECK_MS, 5000);
      const lease = await granted();
      timers.advance(GRANTOR_CHECK_MS);
      assert.equal(lease.state, 'active', 'an enrolled device: nothing happens');
      adminRevokes(phone);
      timers.advance(GRANTOR_CHECK_MS - 1);
      assert.equal(lease.state, 'active', 'the node has not looked yet');
      timers.advance(1);
      assert.equal(lease.state, 'ended');
      assert.equal(lease.endReason, 'device_revoked');
      assert.equal(relay.last('kl.lease.status').message.reason, 'device_revoked');
    });

    it('the next input finds it without the timer', async () => {
      const lease = await granted();
      adminRevokes(phone);
      store().refresh(); // the store looks at its files once a second at most
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_revoked');
      assert.equal(lease.endReason, 'device_revoked');
    });

    it('the revocation of another device ends nothing; a paused lease of the revoked device ends too', async () => {
      const lease = await granted();
      assert.equal(store().stage(phone.revoke(other.deviceId, { now: clock.now() })).state, 'revoked-pending-apply');
      timers.advance(5000);
      assert.equal(lease.state, 'active');
      leases.suspend(lease.leaseId, 'foreground_changed');
      assert.equal(lease.state, 'suspended');
      adminRevokes(phone);
      timers.advance(5000);
      assert.equal(lease.state, 'ended');
      assert.equal(lease.endReason, 'device_revoked');
      assert.equal(relay.all('kl.lease.request').filter((s) => s.message.lease.resumes === lease.leaseId).length, 1, 'its resume request is not sent again');
    });

    it('a lease still waiting for its first grant is not ended: nobody granted it yet', async () => {
      const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'Enter the totals' });
      p.catch(() => {});
      adminRevokes(phone);
      timers.advance(5000);
      assert.equal(leases.current().state, 'pending');
      leases.stopAll();
    });

    it('stop() takes the manager off the store', async () => {
      await granted();
      assert.equal(store()._revokeListeners.size, 1);
      leases.stop();
      assert.equal(store()._revokeListeners.size, 0);
    });
  });

  // R-F5-18 (owner ruling, 2026-10-13): any enrolled phone can stop a
  // lease, and can see what it is stopping. Granting, resuming and contact
  // stay with the phone that granted it. A phone learns of live leases
  // from statuses this node signs, asked for with one signed request.
  describe('R-F5-18: any enrolled phone can stop a lease', () => {
    const WINDOW = 120000;

    it('another enrolled phone revokes a live lease: signature, nonce and lease id checked as for the granting one', async () => {
      const lease = await granted();
      const revoke = other.leaseRevoke(identity.nodeId, lease.leaseId);
      const out = leases.onRevoke(revoke);
      assert.equal(out.state, 'ended');
      assert.equal(lease.endReason, 'revoked');
      assert.ok(audits.some((a) => a.kind === 'lease.revoked' && a.data.device_id === other.deviceId));
      // The same bytes again: a replay that changes nothing. Its nonce under other bytes: refused.
      assert.equal(leases.onRevoke(revoke).state, 'ended');
      const second = await granted({ jobId: 'job-2' });
      const nonce = require('crypto').randomBytes(32).toString('base64url');
      assert.equal(leases.onRevoke(other.leaseRevoke(identity.nodeId, '00000000-0000-4000-8000-000000000000', { nonce })).reason, 'unknown_lease');
      assert.equal(second.state, 'active');
      // Suspended for want of contact: still stoppable by the other phone.
      timers.advance(WINDOW + 1);
      assert.equal(second.state, 'suspended');
      assert.equal(leases.onRevoke(other.leaseRevoke(identity.nodeId, second.leaseId)).state, 'ended');
    });

    it('a revoked phone and a phone this node does not know cannot stop it', async () => {
      const revoked = createFakePhone({ name: 'Lost phone' });
      const stranger = createFakePhone({ name: 'Stranger' });
      const store = await approverStoreWith([phone.approverRecord(), other.approverRecord(), revoked.approverRecord({ revokedAt: '2026-09-20T00:00:00.000Z', revokedBy: 'console' })], { now: () => clock.now() });
      stores.push(store);
      const strict = new LeaseManager({
        approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } },
        guiConfig, broker, audit: { append: async (e) => { audits.push(e); } }, nodeName: 'gpu-box', clock: () => clock.now(), timers, jobOpen: () => true
      });
      const p = strict.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      strict.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 }));
      const lease = await p;
      assert.deepEqual(plain(strict.onRevoke(revoked.leaseRevoke(identity.nodeId, lease.leaseId))), { state: 'rejected', reason: 'revoked_device' });
      assert.deepEqual(plain(strict.onRevoke(stranger.leaseRevoke(identity.nodeId, lease.leaseId))), { state: 'rejected', reason: 'unknown_device' });
      assert.equal(lease.state, 'active');
      // Nor watch it.
      assert.equal(strict.verifyWatch(revoked.leaseWatch(identity.nodeId, lease.leaseId)).reason, 'revoked_device');
      assert.equal(strict.verifyWatch(stranger.leaseWatch(identity.nodeId, lease.leaseId)).reason, 'unknown_device');
      assert.equal(strict.onRevoke(other.leaseRevoke(identity.nodeId, lease.leaseId)).state, 'ended');
    });

    it('another phone may watch, to see what it is stopping; its watch is never contact, with any token', async () => {
      const lease = await granted();
      timers.advance(60000);
      const seen = leases.verifyWatch(watchFrom(other, lease));
      assert.deepEqual([seen.accepted, seen.contact, seen.deviceId], [true, false, other.deviceId]);
      assert.ok(seen.status, 'it gets the signed status too');
      timers.advance(60001);
      assert.equal(lease.suspendReason, 'no_contact', 'two minutes after the grant');
      assert.equal(leases.verifyWatch(watchFrom(other, lease)).contact, false);
      assert.equal(lease.state, 'suspended');
    });

    it('a resume is granted only by the phone that granted the lease; any phone may refuse one', async () => {
      const lease = await granted();
      leases.suspend(lease.leaseId, 'foreground_changed');
      const resume = relay.last('kl.lease.request');
      assert.equal(resume.message.lease.resumes, lease.leaseId);
      assert.deepEqual(plain(leases.onGrant(other.leaseGrant(resume.envelope, { minutes: 5 }))), { state: 'rejected', reason: 'not_granting_device' });
      assert.equal(lease.state, 'suspended');
      assert.ok(audits.some((a) => a.kind === 'lease.rejected' && a.data.reason === 'not_granting_device' && a.data.device_id === other.deviceId));
      // The request is still open for the phone that granted it.
      assert.equal(leases.onGrant(phone.leaseGrant(resume.envelope, { minutes: 5 })).state, 'active');
      assert.equal(lease.grantedBy, phone.deviceId);
      // A deny from the other phone ends it, as a Stop would.
      leases.suspend(lease.leaseId, 'foreground_changed');
      assert.equal(leases.onGrant(other.leaseGrant(relay.last('kl.lease.request').envelope, { decision: 'deny' })).state, 'ended');
      assert.equal(lease.endReason, 'denied');
    });

    it('a first request is granted by whichever enrolled phone answers, and that phone is then the granting one', async () => {
      const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      assert.equal(leases.current().grantedBy, null);
      assert.equal(leases.onGrant(other.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 })).state, 'active');
      const lease = await p;
      assert.equal(lease.grantedBy, other.deviceId);
      timers.advance(60000);
      assert.equal(leases.verifyWatch(watchFrom(other, lease)).contact, true);
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, false);
    });

    it('every status says who granted the lease: nobody while it is pending or was denied, then the granting phone by id and name', async () => {
      const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      assert.equal(relay.last('kl.lease.status').message.granted_by, null);
      leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 }));
      const lease = await p;
      assert.deepEqual(relay.last('kl.lease.status').message.granted_by, { device_id: phone.deviceId, name: 'Owner phone' });
      leases.onRevoke(other.leaseRevoke(identity.nodeId, lease.leaseId));
      assert.deepEqual(relay.last('kl.lease.status').message.granted_by, { device_id: phone.deviceId, name: 'Owner phone' }, 'who stopped it is in the audit entry; this is who granted it');
      const denied = leases.request({ jobId: 'job-2', origin: { ...ORIGIN, job_id: 'job-2' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
      leases.onGrant(other.leaseGrant(relay.last('kl.lease.request').envelope, { decision: 'deny' }));
      await assert.rejects(denied, (e) => e.code === 'lease_denied');
      assert.equal(relay.last('kl.lease.status').message.granted_by, null);
    });

    it('a name that is not one plain line is left out; the device id is always there', async () => {
      const odd = createFakePhone({ name: 'Owner‮ phone\nGranted by the node' });
      const store = await approverStoreWith([odd.approverRecord()], { now: () => clock.now() });
      stores.push(store);
      const m = new LeaseManager({
        approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } },
        guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers, jobOpen: () => true
      });
      const p = m.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      m.onGrant(odd.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 10 }));
      await p;
      assert.deepEqual(relay.last('kl.lease.status').message.granted_by, { device_id: odd.deviceId, name: null });
    });

    it('listFor: an enrolled phone gets a status signed now for the live lease and for leases that ended lately; nobody else gets anything', async () => {
      assert.deepEqual(leases.listFor(phone.deviceId), []);
      const first = await granted();
      leases.onRevoke(phone.leaseRevoke(identity.nodeId, first.leaseId));
      const live = await granted({ jobId: 'job-2' });
      timers.advance(30000);
      const sent = relay.all('kl.lease.status').length;
      const listed = leases.listFor(other.deviceId).map((envelope) => open(envelope).message);
      assert.deepEqual(listed.map((m) => [m.lease_id, m.state, m.reason]), [[live.leaseId, 'active', null], [first.leaseId, 'ended', 'revoked']]);
      for (const m of listed) {
        assert.equal(m.type, 'kl.lease.status');
        assert.equal(m.at, new Date(clock.now()).toISOString(), 'signed for this request, not an old one');
        assert.deepEqual(m.granted_by, { device_id: phone.deviceId, name: 'Owner phone' });
      }
      assert.equal(relay.all('kl.lease.status').length, sent, 'answered to the phone that asked; not broadcast');
      // The live one carries a token the granting phone can make contact with.
      assert.equal(leases.verifyWatch(phone.leaseWatch(identity.nodeId, live.leaseId, { contactToken: listed[0].contact_token })).contact, true);
      // Each listing is newer than the last (the phones apply by seq).
      const again = leases.listFor(other.deviceId).map((envelope) => open(envelope).message);
      assert.ok(again[0].seq > listed[0].seq && again[1].seq > listed[1].seq);
      // A device this node does not know, a revoked one, and no device at all.
      assert.deepEqual(leases.listFor(createFakePhone().deviceId), []);
      assert.deepEqual(leases.listFor(null), []);
      assert.deepEqual(leases.listFor('not-a-device'), []);
    });

    // Fourth security review, finding 3: a relay can answer a phone's grant
    // with 503 and deliver it later. Until then the lease is pending, and a
    // listing names it as such, so the phone that signed the grant can show
    // "may still start" with a Stop. That Stop is an ordinary revoke.
    it('a pending lease is listed as pending; a revoke from any enrolled phone ends it, and the grant that was held back is then refused', async () => {
      const waiting = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      waiting.catch(() => {});
      const request = relay.last('kl.lease.request').envelope;
      const held = phone.leaseGrant(request, { minutes: 10 });
      const leaseId = open(request).message.lease_id;
      const answer = leases.listingFor(phone.deviceId, 'n'.repeat(43));
      assert.deepEqual(answer.statuses.map((e) => [open(e).message.lease_id, open(e).message.state]), [[leaseId, 'pending']]);
      const checked = L.verifyLeaseListing(answer.listing, { nodeId: identity.nodeId, nodePublicKeyHex: identity.publicKey.toString('hex'), nonce: 'n'.repeat(43), deviceId: phone.deviceId, statuses: answer.statuses });
      assert.equal(checked.accepted, true, checked.reason);
      // Stop, from the other phone (R-F5-18): the pending lease ends.
      const stopped = leases.onRevoke(other.leaseRevoke(identity.nodeId, leaseId));
      assert.equal(stopped.state, 'ended');
      assert.equal(open(stopped.status).message.state, 'ended');
      await assert.rejects(waiting, (e) => e.code === 'lease_revoked');
      // The grant the relay kept back arrives now: there is nothing left to grant.
      const late = leases.onGrant(held);
      assert.deepEqual([late.state, late.reason], ['rejected', 'unknown_request']);
      assert.equal(leases.current(), null);
      assert.deepEqual(leases.listingFor(phone.deviceId, 'n'.repeat(43)).statuses.map((e) => open(e).message.state), ['ended']);
    });

    it('listFor lists at most the live lease and the four that ended last', async () => {
      for (let i = 0; i < 6; i += 1) {
        openJobs.add(`job-x${i}`);
        const lease = await granted({ jobId: `job-x${i}` });
        leases.onRevoke(phone.leaseRevoke(identity.nodeId, lease.leaseId));
      }
      assert.equal(leases.listFor(phone.deviceId).length, 4);
      await granted({ jobId: 'job-1' });
      const listed = leases.listFor(phone.deviceId).map((envelope) => open(envelope).message.state);
      assert.deepEqual(listed, ['active', 'ended', 'ended', 'ended', 'ended']);
    });

    // R-F5-20 (owner ruling, 2026-10-13): a relay cannot hide a live lease
    // from a phone. Asked with the nonce the phone chose for this request,
    // the node also signs a listing: that nonce, the phone, and every lease
    // it lists by id and by the seq of the status it signed beside it. It is
    // signed when nothing is live too, so "nothing" can be told from silence.
    describe('R-F5-20: listingFor signs an answer a phone can check, also when nothing is live', () => {
      const NONCE = 'n'.repeat(43);
      const check = (answer, over = {}) => L.verifyLeaseListing(answer.listing, {
        nodeId: identity.nodeId, nodePublicKeyHex: identity.publicKey.toString('hex'), nonce: NONCE, deviceId: phone.deviceId, statuses: answer.statuses, ...over
      });

      it('nothing live: a signed listing of no leases, bound to the nonce and the phone', () => {
        const answer = leases.listingFor(phone.deviceId, NONCE);
        assert.deepEqual(answer.statuses, []);
        const m = open(answer.listing).message;
        assert.deepEqual(m, { v: 1, type: 'kl.lease.listing', node_id: identity.nodeId, to_device: phone.deviceId, nonce: NONCE, at: new Date(clock.now()).toISOString(), leases: [] });
        const r = check(answer);
        assert.equal(r.accepted, true, r.reason);
        assert.deepEqual(r.statuses, []);
      });

      it('names every lease it lists by id and by the seq of the status signed beside it', async () => {
        const first = await granted();
        leases.onRevoke(phone.leaseRevoke(identity.nodeId, first.leaseId));
        const live = await granted({ jobId: 'job-2' });
        const answer = leases.listingFor(phone.deviceId, NONCE);
        const statuses = answer.statuses.map((e) => open(e).message);
        assert.deepEqual(statuses.map((m) => [m.lease_id, m.state]), [[live.leaseId, 'active'], [first.leaseId, 'ended']]);
        assert.deepEqual(open(answer.listing).message.leases, statuses.map((m) => ({ lease_id: m.lease_id, seq: m.seq })));
        const r = check(answer);
        assert.equal(r.accepted, true, r.reason);
        assert.deepEqual(r.statuses.map((m) => m.state), ['active', 'ended']);
      });

      it('a relay that strips a status, swaps in an older one, or replays an old answer is caught', async () => {
        const live = await granted();
        const old = leases.listingFor(phone.deviceId, 'o'.repeat(43));
        const answer = leases.listingFor(phone.deviceId, NONCE);
        // An entry withheld; the listing itself withheld is simply no answer.
        assert.equal(check({ listing: answer.listing, statuses: [] }).reason, 'status_missing');
        // The same lease, but the status signed for an earlier listing.
        assert.equal(check({ listing: answer.listing, statuses: old.statuses }).reason, 'status_missing');
        // An answer signed for an earlier request (its own statuses with it).
        assert.equal(check(old).reason, 'nonce_mismatch');
        // An answer made for another phone, another node's key, a changed payload.
        assert.equal(check(leases.listingFor(other.deviceId, NONCE)).reason, 'wrong_device');
        assert.equal(check(answer, { nodePublicKeyHex: testNodeIdentity({ key: 'web-01' }).publicKey.toString('hex') }).reason, 'bad_signature');
        assert.equal(check({ listing: { ...answer.listing, sig: old.listing.sig }, statuses: answer.statuses }).reason, 'bad_signature');
        assert.equal(check({ listing: answer.statuses[0], statuses: answer.statuses }).reason, 'malformed', 'a status is not a listing');
        assert.equal(check({ listing: null, statuses: [] }).reason, 'malformed');
        // Statuses beside the ones it names (an older one of the same lease, junk) are not taken.
        const padded = check({ listing: answer.listing, statuses: [...old.statuses, { not: 'an envelope' }, null, ...answer.statuses] });
        assert.equal(padded.accepted, true, padded.reason);
        assert.deepEqual(padded.statuses.map((m) => [m.lease_id, m.seq]), [[live.leaseId, open(answer.statuses[0]).message.seq]]);
      });

      // Fourth security review, finding 2: a node with computer use off
      // (no lease manager at all) answers too, so "could not confirm" on a
      // phone means the node did not answer, not that it had nothing to say.
      it('offLeaseListing: a node with computer use off signs the same answer with nothing in it, for an enrolled phone and its nonce only', async () => {
        const off = L.offLeaseListing({ identity, approverStore: leases.approvals.approverStore, clock: () => clock.now() });
        const answer = await off({ device_id: phone.deviceId, nonce: NONCE });
        assert.deepEqual(answer.statuses, []);
        assert.deepEqual(open(answer.listing).message, { v: 1, type: 'kl.lease.listing', node_id: identity.nodeId, to_device: phone.deviceId, nonce: NONCE, at: new Date(clock.now()).toISOString(), leases: [] });
        const r = check(answer);
        assert.equal(r.accepted, true, r.reason);
        assert.deepEqual(r.statuses, []);
        assert.equal(check(await off({ device_id: other.deviceId, nonce: NONCE })).reason, 'wrong_device');
        for (const nonce of [undefined, null, '', 'short', 'n'.repeat(44), 7]) assert.deepEqual(await off({ device_id: phone.deviceId, nonce }), { statuses: [] });
        for (const device of [createFakePhone().deviceId, null, 'not-a-device']) assert.deepEqual(await off({ device_id: device, nonce: NONCE }), { statuses: [] });
        assert.deepEqual(await off(), { statuses: [] });
        // A store that cannot be read answers nobody.
        const broken = L.offLeaseListing({ identity, approverStore: { get() { throw new Error('unreadable'); } } });
        assert.deepEqual(await broken({ device_id: phone.deviceId, nonce: NONCE }), { statuses: [] });
      });

      it('no nonce, or one that is not 32 bytes of base64url: statuses as before and no listing; nobody but an enrolled phone gets one', async () => {
        await granted();
        for (const nonce of [undefined, null, '', 'short', 'n'.repeat(44), 7, {}]) {
          const answer = leases.listingFor(phone.deviceId, nonce);
          assert.equal(answer.listing, null);
          assert.equal(answer.statuses.length, 1);
        }
        for (const device of [createFakePhone().deviceId, null, 'not-a-device']) {
          assert.deepEqual(leases.listingFor(device, NONCE), { statuses: [], listing: null });
        }
      });
    });
  });

  // Second security review, finding 12. A lease paused for want of contact
  // is resumed by a watch alone. If the helper dropped (or the relay link
  // went) during the pause, nothing recorded it, and the watch resumed the
  // lease as if nothing had happened. The stronger reason now takes over,
  // and with it its own way back: a resume grant on the phone, and the app
  // brought to the front again.
  describe('second review finding 12: what happens during a pause for want of contact is not lost', () => {
    const WINDOW = 120000;
    const paused = async () => {
      const lease = await granted();
      timers.advance(WINDOW + 1);
      assert.equal(lease.suspendReason, 'no_contact');
      return lease;
    };

    it('the helper drops during the pause: the lease is suspended for that, and a watch alone no longer resumes it', async () => {
      const lease = await paused();
      const requests = relay.all('kl.lease.request').length;
      broker.calls.length = 0;
      leases.onHelperDisconnected();
      assert.deepEqual([lease.state, lease.suspendReason], ['suspended', 'helper_disconnected']);
      assert.deepEqual([relay.last('kl.lease.status').message.state, relay.last('kl.lease.status').message.reason], ['suspended', 'helper_disconnected']);
      assert.ok(audits.some((a) => a.kind === 'lease.suspended' && a.data.reason === 'helper_disconnected' && a.data.was === 'no_contact'));
      assert.equal(relay.all('kl.lease.request').length, requests + 1, 'the phone is asked to resume, as for any helper disconnect');
      assert.equal(relay.last('kl.lease.request').message.lease.resumes, lease.leaseId);
      // The granting phone looks again: contact, but not a resume.
      const seen = leases.verifyWatch(watchFrom(phone, lease));
      assert.deepEqual([seen.accepted, seen.contact], [true, true]);
      assert.deepEqual([lease.state, lease.suspendReason], ['suspended', 'helper_disconnected']);
      assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended');
      // Its resume grant brings it back, with the app focused again.
      assert.equal(leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 5 })).state, 'active');
      assert.equal(leases.assertUsable('job-1'), lease);
      assert.ok(broker.calls.some((c) => Array.isArray(c) && c[0] === 'focus'), 'refocused');
    });

    it('the relay link drops during the pause: suspended for that; the resume is asked when the link returns', async () => {
      const lease = await paused();
      const requests = relay.all('kl.lease.request').length;
      relay.down();
      assert.deepEqual([lease.state, lease.suspendReason], ['suspended', 'relay_unreachable']);
      relay.up();
      assert.equal(relay.all('kl.lease.request').length, requests + 1);
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
      assert.equal(lease.state, 'suspended', 'a watch does not resume it');
      leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 5 }));
      assert.equal(lease.state, 'active');
    });

    it('a pause for want of contact never replaces another reason, and nothing replaces an ended lease', async () => {
      const lease = await granted();
      leases.suspend(lease.leaseId, 'foreground_changed');
      timers.advance(WINDOW + 1);
      assert.equal(lease.suspendReason, 'foreground_changed');
      leases.suspend(lease.leaseId, 'no_contact');
      assert.equal(lease.suspendReason, 'foreground_changed');
      // One stronger reason does not replace another either.
      leases.onHelperDisconnected();
      assert.equal(lease.suspendReason, 'foreground_changed');
      leases.onRevoke(phone.leaseRevoke(identity.nodeId, lease.leaseId));
      leases.onHelperDisconnected();
      assert.deepEqual([lease.state, lease.endReason], ['ended', 'revoked']);
    });

    it('with nothing else wrong, the watch still resumes it', async () => {
      const lease = await paused();
      assert.equal(leases.verifyWatch(watchFrom(phone, lease)).contact, true);
      assert.deepEqual([lease.state, lease.suspendReason], ['active', null]);
    });
  });

  // Second security review, finding 9. The contact window, the lease's
  // expiry and the age of a contact token were all read off the wall clock,
  // so setting the clock back (an NTP step, a user, anyone who can) stopped
  // them: no lapse, no expiry. They now run on a monotonic clock as well,
  // and whichever clock says "over" first is believed.
  describe('second review finding 9: a clock change cannot extend contact or expiry', () => {
    const WINDOW = 120000;
    // A manager with the two clocks apart, and timers that never fire: the checks themselves must see it.
    async function twoClocks() {
      const wall = { t: Date.parse('2026-09-23T18:00:00.000Z') };
      const mono = { t: 5000 };
      const store = await approverStoreWith([phone.approverRecord(), other.approverRecord()], { now: () => wall.t });
      stores.push(store);
      const link = new FakeRelay();
      const manager = new LeaseManager({
        approvals: { identity, approverStore: store, relayClient: link, phoneApprover: { isAvailable: () => true } },
        guiConfig, broker, nodeName: 'gpu-box', clock: () => wall.t, monotonic: () => mono.t,
        timers: { setTimeout: () => ({}), clearTimeout: () => {} }, jobOpen: () => true
      });
      const p = manager.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
      const reply = manager.onGrant(phone.leaseGrant(link.last('kl.lease.request').envelope, { minutes: 10 }));
      const lease = await p;
      // Real time passes on both; a step moves the wall clock alone.
      const pass = (ms) => { wall.t += ms; mono.t += ms; };
      const step = (ms) => { wall.t += ms; };
      const newest = () => [...link.sent].reverse().map((s) => s.message).find((m) => typeof m.contact_token === 'string').contact_token;
      const watch = (extra = {}) => manager.verifyWatch(phone.leaseWatch(identity.nodeId, lease.leaseId, { contactToken: newest(), ...extra }));
      return { manager, lease, link, reply, pass, step, watch, wall, mono };
    }

    it('the clock set back an hour: input still pauses two minutes after the last contact', async () => {
      const { manager, lease, pass, step } = await twoClocks();
      pass(60000);
      step(-3600000);
      pass(WINDOW - 60000 - 1);
      assert.equal(manager.assertUsable('job-1'), lease, 'one millisecond inside the window');
      pass(1);
      assert.throws(() => manager.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
    });

    it('the clock set back: the lease still ends ten minutes after the grant, with the phone watching throughout', async () => {
      const { manager, lease, pass, step, watch } = await twoClocks();
      step(-86400000);
      for (let s = 20; s < 600; s += 20) {
        pass(20000);
        assert.equal(watch().contact, true, `at ${s} s`);
        assert.equal(manager.assertUsable('job-1'), lease);
      }
      assert.equal(manager.remainingMs(lease), 20000);
      pass(20000);
      assert.throws(() => manager.assertUsable('job-1'), (e) => e.code === 'lease_expired');
      assert.equal(lease.endReason, 'expired');
    });

    it('the clock set back: a contact token still ages, and a watch that echoes an old one is not contact', async () => {
      const { manager, lease, reply, pass, step } = await twoClocks();
      const token = open(reply.status).message.contact_token;
      step(-3600000);
      pass(WINDOW);
      assert.throws(() => manager.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
      assert.equal(manager.verifyWatch(phone.leaseWatch(identity.nodeId, lease.leaseId, { contactToken: token })).contact, false, 'two minutes old, whatever the wall clock says');
      assert.equal(lease.state, 'suspended');
    });

    it('the clock set forward ends things early, never late: contact lapses, tokens age, the lease expires', async () => {
      const a = await twoClocks();
      a.pass(1000);
      a.step(WINDOW);
      assert.throws(() => a.manager.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
      const b = await twoClocks();
      b.pass(1000);
      b.step(11 * 60000);
      assert.throws(() => b.manager.assertUsable('job-1'), (e) => e.code === 'lease_expired');
      // A resume never outlives the original lease on either clock.
      const c = await twoClocks();
      c.pass(60000);
      c.manager.suspend(c.lease.leaseId, 'foreground_changed');
      c.step(-3600000);
      c.manager.onGrant(phone.leaseGrant(c.link.last('kl.lease.request').envelope, { minutes: 9 }));
      assert.equal(c.lease.state, 'active');
      assert.equal(c.manager.remainingMs(c.lease), 9 * 60000);
      c.pass(9 * 60000 - 1);
      c.manager.verifyWatch(phone.leaseWatch(identity.nodeId, c.lease.leaseId));
      assert.notEqual(c.lease.state, 'ended');
      c.pass(1);
      c.manager.verifyWatch(phone.leaseWatch(identity.nodeId, c.lease.leaseId));
      assert.equal(c.lease.endReason, 'expired', 'ten minutes of real time after the first grant');
    });

    it('the rate limit runs on the monotonic clock too', async () => {
      const { manager, lease, pass, step } = await twoClocks();
      for (let i = 0; i < 10; i += 1) manager.chargeInput(lease);
      step(3600000);
      assert.throws(() => manager.chargeInput(lease), (e) => e.code === 'rate_limited', 'a clock set forward frees nothing');
      pass(60001);
      manager.chargeInput(lease);
    });

    it('with only a wall clock injected both clocks are that one; the service itself runs on performance.now()', async () => {
      assert.equal(leases.monotonic(), clock.now());
      const real = new LeaseManager({ approvals: { identity, approverStore: null, relayClient: relay, phoneApprover: { isAvailable: () => true } }, guiConfig, broker });
      const a = real.monotonic();
      assert.ok(Number.isFinite(a) && a >= 0 && a < Date.now() / 2, 'not epoch milliseconds');
      assert.ok(real.monotonic() >= a);
    });
  });

  it('statusSummary for status.json', async () => {
    assert.equal(leases.statusSummary(), null);
    const lease = await granted();
    assert.deepEqual(leases.statusSummary(), { active: true, appIds: ['calculator'], expiresAt: new Date(lease.expiresAt).toISOString() });
  });
});
