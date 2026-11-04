// tests/gui-live-view.test.js
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { open } = require('../src/approvals/envelope');
const { LeaseManager } = require('../src/gui/leases');
const { LiveView } = require('../src/gui/live-view');
const { parseGuiConfig } = require('../src/gui/config');
const { verifyLeaseView, buildLeaseView, VIEW_MAX_BYTES } = require('../src/gui/lease-protocol');
const { SEALED_FRAME_MAX_BYTES } = require('../src/gui/live-view');
const { createSealPolicy } = require('../src/approvals/seal-policy');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const guiConfig = parseGuiConfig({ enabled: true, apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] } } }, { platform: 'win32' });

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; }
  isConnected() { return true; }
  async send(envelope, opts = {}) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  views() { return this.sent.filter((s) => s.message.type === 'kl.lease.view'); }
}

let clock;
let relay;
let leases;
let view;
let phone;
let identity;
let captures;
let frameBytes;

function jpeg(n) { return crypto.randomBytes(n).toString('base64'); }

beforeEach(async () => {
  phone = createFakePhone();
  identity = testNodeIdentity({ key: 'gpu-box' });
  clock = { t: Date.parse('2026-09-23T18:00:00.000Z') };
  relay = new FakeRelay();
  const store = await approverStoreWith([phone.approverRecord()], { now: () => clock.t });
  stores.push(store);
  captures = [];
  frameBytes = [20000];
  const broker = {
    releaseAll: async () => {}, focusApp: async () => {}, capability: () => ({ limits: [] }), leaseChanged: () => {},
    captureFrame: async ({ quality }) => {
      captures.push(quality);
      const n = frameBytes.length > 1 ? frameBytes.shift() : frameBytes[0];
      const data = jpeg(n);
      const bytes = Buffer.from(data, 'base64');
      return { appId: 'calculator', width: 960, height: 640, data, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('base64url') };
    }
  };
  leases = new LeaseManager({ approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } }, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.t, timers: { setTimeout: () => ({}), clearTimeout: () => {} }, jobOpen: () => true });
  view = new LiveView({ leases, broker, identity, relayClient: relay, guiConfig, clock: () => clock.t });
});

async function activeLease() {
  const p = leases.request({ jobId: 'job-1', origin: { client: 'claude.ai', session: null, job_id: 'job-1' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
  const req = relay.sent.filter((s) => s.message.type === 'kl.lease.request').pop();
  leases.onGrant(phone.leaseGrant(req.envelope, { minutes: 10 }));
  return p;
}

const at = async (ms) => { clock.t += ms; await view.tick(); };

describe('live view', () => {
  it('no frames without a watcher', async () => {
    await activeLease();
    await at(5000);
    assert.equal(relay.views().length, 0);
  });

  it('a watch subscribes the device for 60 s; frames every interval_s; signed views', async () => {
    const lease = await activeLease();
    const reply = view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    assert.equal(reply.state, 'active');
    // The reply carries the status the node signed for this watch, with the token the next watch echoes.
    assert.match(open(reply.status).message.contact_token, /^[A-Za-z0-9_-]{22}$/);
    await at(0);
    assert.equal(relay.views().length, 1);
    await at(1000);
    assert.equal(relay.views().length, 1, 'not before interval_s (3 s)');
    await at(2000);
    assert.equal(relay.views().length, 2);
    const v = relay.views()[1];
    assert.equal(v.opts.to_device, phone.deviceId);
    assert.equal(verifyLeaseView(v.envelope, { nodeId: identity.nodeId, nodePublicKeyHex: identity.publicKey.toString('hex') }).accepted, true);
    // Each view carries a contact token of its own, one the lease remembers issuing (R-F5-15).
    const tokens = relay.views().map((s) => s.message.contact_token);
    assert.equal(new Set(tokens).size, tokens.length);
    for (const t of tokens) assert.ok(lease.tokens.has(t));
    // A watch that echoes the newest one is contact.
    assert.equal(leases.verifyWatch(phone.leaseWatch(identity.nodeId, lease.leaseId, { contactToken: tokens.at(-1) })).contact, true);
    for (let i = 0; i < 20; i += 1) await at(3000);
    const count = relay.views().length;
    await at(3000);
    assert.equal(relay.views().length, count, 'the watch lapsed after 60 s');
  });

  // R-F5-18: a phone that did not grant the lease may watch it, to see what
  // it is about to stop. It gets views addressed to it; it is never contact.
  it('R-F5-18: another enrolled phone that watches gets its own views, and the lease still pauses without the granting phone', async () => {
    const second = createFakePhone({ name: 'Second phone' });
    const store = await approverStoreWith([phone.approverRecord(), second.approverRecord()], { now: () => clock.t });
    stores.push(store);
    leases.approvals.approverStore = store;
    const lease = await activeLease();
    const reply = view.onWatch(second.leaseWatch(identity.nodeId, lease.leaseId, { contactToken: open(relay.sent.at(-1).envelope).message.contact_token }));
    assert.equal(reply.state, 'active');
    await at(0);
    const views = relay.views();
    assert.equal(views.length, 1);
    assert.equal(views[0].opts.to_device, second.deviceId);
    assert.equal(views[0].message.to_device, second.deviceId);
    // The granting phone sent nothing: two minutes after the grant, input is refused.
    clock.t += 120001;
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended_no_contact');
  });

  it('at most 1 frame per second overall, even with inputs in between', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    await at(0);
    const start = captures.length;
    for (let i = 0; i < 10; i += 1) {
      view.recordAction(lease, { tool: 'Key', summary: 'Key a', result: 'ok' });
      await at(200);
    }
    assert.ok(captures.length - start <= 2, `${captures.length - start} captures in 2 s`);
  });

  it('an input triggers a frame sooner than the interval; actions ride along, oldest first', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    await at(0);
    view.recordAction(lease, { tool: 'Type', summary: 'Type "12+30=" (6 chars)', result: 'ok' });
    await at(1000);
    const last = relay.views().pop().message;
    assert.equal(last.actions.length, 1);
    assert.equal(last.actions[0].tool, 'Type');
  });

  it('re-encodes once at quality − 20 over max_frame_bytes, then drops the frame', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    frameBytes = [200000, 150000, 20000];
    await at(0);
    assert.deepEqual(captures.slice(-2), [60, 40]);
    assert.ok(relay.views().pop().message.frame);
    frameBytes = [200000, 190000, 20000];
    await at(3000);
    const dropped = relay.views().pop().message;
    assert.equal(dropped.frame, null);
    assert.equal(dropped.frame_dropped, true);
  });

  it('the biggest allowed frame keeps the view under 256 KiB', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    for (let i = 0; i < 60; i += 1) view.recordAction(lease, { tool: 'Type', summary: 'x'.repeat(120), result: 'refused:text_looks_secret' });
    frameBytes = [184320];
    await at(0);
    const v = relay.views().pop();
    assert.ok(Buffer.from(v.envelope.payload, 'base64url').length <= VIEW_MAX_BYTES);
    assert.ok(v.message.frame);
    assert.equal(v.message.actions.length, 50);
  });

  it('no frames while suspended or locked; a watch for an unknown lease is refused', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    leases.setLocked(true);
    await at(5000);
    assert.equal(relay.views().length, 0);
    leases.setLocked(false);
    leases.suspend(lease.leaseId, 'foreground_mismatch');
    await at(5000);
    assert.equal(relay.views().length, 0);
    assert.equal(view.onWatch(phone.leaseWatch(identity.nodeId, '00000000-0000-4000-8000-000000000000')).reason, 'unknown_lease');
  });
});

describe('a sealing node\'s live view (R-SP-4, R-SP-8)', () => {
  let sealPhone;
  let policyState;

  beforeEach(async () => {
    sealPhone = createFakePhone({ boxKey: true });
    identity = testNodeIdentity({ box: true });
    const store = await approverStoreWith([sealPhone.approverRecord({ boxKey: true })], { now: () => clock.t });
    stores.push(store);
    policyState = { canSeal: null };
    const real = createSealPolicy({ approverStore: store, identity, dataDir: path.join(store.baseDir, 'data') });
    const sealPolicy = { ...real, canSeal: () => (policyState.canSeal === null ? real.canSeal() : policyState.canSeal), whyNot: () => 'no active phone holds a box key' };
    const broker = view.broker;
    leases = new LeaseManager({ sealPolicy, approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } }, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.t, timers: { setTimeout: () => ({}), clearTimeout: () => {} }, jobOpen: () => true });
    view = new LiveView({ leases, broker, identity, relayClient: relay, guiConfig, clock: () => clock.t });
  });

  async function watchedLease() {
    const p = leases.request({ jobId: 'job-1', origin: { client: 'claude.ai', session: null, job_id: 'job-1' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const req = relay.sent.filter((s) => s.message.type === 'kl.lease.request').pop();
    leases.onGrant(sealPhone.leaseGrant(req.envelope, { minutes: 10 }));
    const lease = await p;
    view.onWatch(sealPhone.leaseWatch(identity.nodeId, lease.leaseId));
    return lease;
  }
  const check = () => ({ nodeId: identity.nodeId, nodePublicKeyHex: identity.publicKey.toString('hex'), open: sealPhone.open });

  it('the clear part holds no frame, foreground or actions, and the phone reads them with the frame hash checked', async () => {
    const lease = await watchedLease();
    view.recordAction(lease, { tool: 'Type', summary: 'Typed 6 characters', result: 'ok' });
    await at(1000);
    const [sent] = relay.views();
    for (const key of ['foreground', 'frame', 'frame_dropped', 'actions']) assert.ok(!(key in sent.message), key);
    assert.deepEqual([sent.message.lease_id, sent.message.to_device, sent.message.state, typeof sent.message.contact_token], [lease.leaseId, sealPhone.deviceId, 'active', 'string']);
    assert.ok(sent.message.sealed);
    const r = verifyLeaseView(sent.envelope, check());
    assert.equal(r.accepted, true, r.reason);
    assert.equal(r.message.foreground.app_id, 'calculator');
    assert.equal(r.message.actions[0].summary, 'Typed 6 characters');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(r.message.frame.data, 'base64')).digest('base64url'), r.message.frame.sha256);
    // With no way to open it: the signature and the clear part, and nothing else.
    const unopened = verifyLeaseView(sent.envelope, { ...check(), open: undefined });
    assert.deepEqual([unopened.accepted, unopened.opened, unopened.message.frame], [true, false, undefined]);
  });

  it('a sealed frame whose hash does not hold is refused after opening', async () => {
    const data = jpeg(100);
    const envelope = buildLeaseView({
      identity, leaseId: '11111111-1111-4111-8111-111111111111', seq: 2, toDevice: sealPhone.deviceId, state: 'active', locked: false, remainingS: 5,
      foreground: { app_id: null, matches: false }, frame: { mime: 'image/jpeg', width: 10, height: 10, sha256: 'h'.repeat(43), data }, frameDropped: false, actions: [],
      sealPolicy: leases.sealPolicy
    });
    assert.equal(verifyLeaseView(envelope, check()).reason, 'frame_hash_mismatch');
  });

  it('a 170 KiB frame is captured again and, still over the sealed cap, dropped', async () => {
    frameBytes = [170 * 1024, 170 * 1024];
    captures = [];
    await watchedLease();
    await at(1000);
    assert.equal(captures.length, 2, 'the second capture targets the sealed cap');
    assert.ok(captures[1] < captures[0]);
    const [sent] = relay.views();
    const { message } = verifyLeaseView(sent.envelope, check());
    assert.deepEqual([message.frame, message.frame_dropped], [null, true]);
    assert.ok(Buffer.from(sent.envelope.payload, 'base64url').length <= VIEW_MAX_BYTES);
  });

  it('a frame the second capture brings under the sealed cap goes', async () => {
    frameBytes = [170 * 1024, SEALED_FRAME_MAX_BYTES];
    await watchedLease();
    await at(1000);
    const [sent] = relay.views();
    const { message } = verifyLeaseView(sent.envelope, check());
    assert.equal(message.frame_dropped, false);
    assert.equal(Buffer.from(message.frame.data, 'base64').length, SEALED_FRAME_MAX_BYTES);
    assert.ok(Buffer.from(sent.envelope.payload, 'base64url').length <= VIEW_MAX_BYTES);
  });

  it('Review Focus 5: a frame that fits the raw cap but not the sealed 256 KiB goes as frame: null, never oversize', async () => {
    frameBytes = [SEALED_FRAME_MAX_BYTES];
    const lease = await watchedLease();
    for (let i = 0; i < 50; i += 1) view.recordAction(lease, { tool: 'Key', summary: 'x'.repeat(120), result: 'y'.repeat(80) });
    await at(1000);
    const [sent] = relay.views();
    assert.ok(Buffer.from(sent.envelope.payload, 'base64url').length <= VIEW_MAX_BYTES);
    const r = verifyLeaseView(sent.envelope, check());
    assert.equal(r.accepted, true, r.reason);
    assert.deepEqual([r.message.frame, r.message.frame_dropped, r.message.actions.length], [null, true, 50]);
  });

  it('with sealing off, the configured cap still rules', async () => {
    assert.ok(guiConfig.liveView.maxFrameBytes > SEALED_FRAME_MAX_BYTES);
    leases.sealPolicy = null;
    frameBytes = [170 * 1024];
    await watchedLease();
    await at(1000);
    const { message } = open(relay.views()[0].envelope);
    assert.equal(Buffer.from(message.frame.data, 'base64').length, 170 * 1024);
  });

  it('latched with nobody to seal to: no capture, no view, and the lease ends', async () => {
    const lease = await watchedLease();
    policyState.canSeal = false;
    captures = [];
    await at(1000);
    assert.equal(captures.length, 0);
    assert.equal(relay.views().length, 0);
    assert.deepEqual([lease.state, lease.endReason], ['ended', 'no_sealed_recipient']);
  });

  it('nobody to seal to arriving between the capture and the send sends nothing', async () => {
    await watchedLease();
    const real = view.broker.captureFrame;
    view.broker.captureFrame = async (args) => { policyState.canSeal = false; return real(args); };
    await at(1000);
    assert.equal(relay.views().length, 0);
    view.broker.captureFrame = real;
  });
});
