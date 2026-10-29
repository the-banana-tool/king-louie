// tests/gui-push-queue.test.js
// The node's small in-memory queue of push.notify hints (push spec §6.2).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PushQueue, PUSH_QUEUE_MAX, PUSH_MAX_AGE_MS } = require('../src/gui/push-queue');

const LEASE = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class FakeLink extends EventEmitter {
  constructor({ connected = true } = {}) { super(); this.connected = connected; this.calls = []; this.answer = null; }
  isConnected() { return this.connected; }
  async pushNotify(params) {
    if (!this.connected) throw Object.assign(new Error('the relay link is down'), { code: 'relay_offline' });
    this.calls.push(params);
    if (this.answer) return this.answer(params);
    return { ok: true };
  }
  up() { this.connected = true; this.emit('connected'); }
  down() { this.connected = false; this.emit('disconnected'); }
}

function capture() {
  const lines = [];
  const log = {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error']) log[level] = (msg) => lines.push({ level, msg });
  return { lines, log };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function build({ connected = true } = {}) {
  const link = new FakeLink({ connected });
  const clock = { t: Date.parse('2026-10-29T12:00:00.000Z') };
  const { lines, log } = capture();
  const queue = new PushQueue({ relayClient: link, clock: () => clock.t, log });
  queue.start();
  return { link, clock, lines, queue };
}

describe('PushQueue', () => {
  it('sends at once while the link is up, every field named', async () => {
    const { link, queue } = build();
    queue.enqueue({ kind: 'session_ended', id: LEASE(1), except_device: 'dev-b' });
    await settle();
    assert.deepEqual(link.calls, [{ kind: 'session_ended', id: LEASE(1), to_device: null, except_device: 'dev-b', expires_at: null }]);
  });

  it('entries queued before start, whose link came up before start, are sent by start (a take ended at a restart)', async () => {
    const link = new FakeLink({ connected: false });
    const queue = new PushQueue({ relayClient: link, clock: () => Date.parse('2026-10-29T12:00:00.000Z'), log: capture().log });
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    // The link connects while nothing listens yet (the GUI is built before it starts).
    link.up();
    await settle();
    assert.equal(link.calls.length, 0);
    queue.start();
    await settle();
    assert.deepEqual(link.calls.map((c) => c.id), [LEASE(1)]);
    queue.stop();
  });

  it('holds entries while the link is down and sends them on the next connected', async () => {
    const { link, queue } = build({ connected: false });
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    queue.enqueue({ kind: 'session_paused', id: LEASE(2), to_device: 'dev-a', expires_at: '2026-10-29T12:30:00.000Z' });
    await settle();
    assert.equal(link.calls.length, 0);
    link.up();
    await settle();
    assert.deepEqual(link.calls.map((c) => c.id), [LEASE(1), LEASE(2)]);
    assert.equal(queue.size(), 0);
  });

  it('drops an entry older than an hour when it would be sent', async () => {
    const { link, clock, queue } = build({ connected: false });
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    clock.t += 30 * 60000;
    queue.enqueue({ kind: 'session_ended', id: LEASE(2) });
    clock.t += PUSH_MAX_AGE_MS - 30 * 60000 + 1;
    link.up();
    await settle();
    assert.deepEqual(link.calls.map((c) => c.id), [LEASE(2)]);
  });

  it('holds at most 32 entries, the oldest out', async () => {
    const { link, queue } = build({ connected: false });
    assert.equal(PUSH_QUEUE_MAX, 32);
    for (let i = 1; i <= 40; i += 1) queue.enqueue({ kind: 'session_ended', id: LEASE(i) });
    assert.equal(queue.size(), 32);
    link.up();
    await settle();
    assert.equal(link.calls.length, 32);
    assert.equal(link.calls[0].id, LEASE(9));
    assert.equal(link.calls[31].id, LEASE(40));
  });

  it('an unknown-method answer is logged once at debug and drops the queue until the next connected', async () => {
    const { link, lines, queue } = build({ connected: false });
    link.answer = () => { throw Object.assign(new Error('no handler for push.notify'), { code: 'unknown_method' }); };
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    queue.enqueue({ kind: 'session_ended', id: LEASE(2) });
    link.up();
    await settle();
    await settle();
    queue.enqueue({ kind: 'session_ended', id: LEASE(3) });
    await settle();
    const about = lines.filter((l) => /push\.notify/.test(l.msg));
    assert.equal(about.length, 1);
    assert.equal(about[0].level, 'debug');
    assert.equal(queue.size(), 0);
    // An older relay never got LEASE(3): the queue was off for this link.
    assert.ok(!link.calls.some((c) => c.id === LEASE(3)));
    // A new link (perhaps an upgraded relay) is asked again.
    link.answer = null;
    link.down();
    link.up();
    queue.enqueue({ kind: 'session_ended', id: LEASE(4) });
    await settle();
    assert.equal(link.calls.at(-1).id, LEASE(4));
  });

  it('a send cut off by the link going down is kept for the next connected', async () => {
    const { link, queue } = build();
    link.answer = () => { link.connected = false; throw Object.assign(new Error('the relay link is down'), { code: 'relay_offline' }); };
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    await settle();
    assert.equal(queue.size(), 1);
    link.answer = null;
    link.up();
    await settle();
    assert.equal(link.calls.at(-1).id, LEASE(1));
    assert.equal(queue.size(), 0);
  });

  it('drain resolves once every send has settled, or at its timeout', async () => {
    const { link, queue } = build();
    let release;
    link.answer = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    let drained = false;
    const d = queue.drain({ timeoutMs: 5000 }).then(() => { drained = true; });
    await settle();
    assert.equal(drained, false);
    release();
    await d;
    assert.equal(drained, true);
    // A send that never answers: drain gives up at its timeout.
    link.answer = () => new Promise(() => {});
    queue.enqueue({ kind: 'session_ended', id: LEASE(2) });
    const started = Date.now();
    const keep = setTimeout(() => {}, 1000);
    await queue.drain({ timeoutMs: 50 });
    clearTimeout(keep);
    assert.ok(Date.now() - started < 900);
  });

  it('drain with nothing to send resolves at once; stop stops listening for connected', async () => {
    const { link, queue } = build({ connected: false });
    await queue.drain({ timeoutMs: 10 });
    queue.stop();
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    link.up();
    await settle();
    assert.equal(link.calls.length, 0);
  });

  it('a link without push.notify (no pushNotify) is left alone', async () => {
    const link = new EventEmitter();
    link.isConnected = () => true;
    const queue = new PushQueue({ relayClient: link, clock: () => 0, log: capture().log });
    queue.start();
    queue.enqueue({ kind: 'session_ended', id: LEASE(1) });
    await queue.drain({ timeoutMs: 10 });
    queue.stop();
  });
});
