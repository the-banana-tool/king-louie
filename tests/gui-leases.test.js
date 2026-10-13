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
require('../src/gui/lease-protocol');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const guiConfig = parseGuiConfig({
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
  assert.deepEqual(leases.onGrant(phone.leaseGrant(req.envelope, { minutes })), { state: 'active' });
  return p;
}

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
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env, { minutes: 3 })), { state: 'active' });
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
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env)), { state: 'ended', reason: 'job_closed' });
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
    timers.advance(3 * 60000);
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
    assert.deepEqual(out, { state: 'ended' });
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

  it('statusSummary for status.json', async () => {
    assert.equal(leases.statusSummary(), null);
    const lease = await granted();
    assert.deepEqual(leases.statusSummary(), { active: true, appIds: ['calculator'], expiresAt: new Date(lease.expiresAt).toISOString() });
  });
});
