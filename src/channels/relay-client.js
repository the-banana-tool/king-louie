// src/channels/relay-client.js
// The contact relay contract (cases stage 4 spec §4.5): email via relay, SMS
// and voice. Send with an Idempotency-Key, poll /v1/events with a persisted
// cursor, and accept a co-located relay's signed push. fetch and crypto only.
//
// Hardening: relay requests never follow a redirect (a 3xx would re-send the
// owner's number and the question text to wherever it points), time out, and
// read at most MAX_RESPONSE_BYTES of a response.
//
// Each relay needs its own webhook secret (vault
// contact.relay.<name>.webhookSecret). The signature covers the timestamp and
// the body, not the <name> in the push URL, so two relays sharing a secret
// could push events in each other's name.
const crypto = require('crypto');
const { ContactDeliveryError } = require('./channel-plugin');
const { assertRelayBaseUrl } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const PUSH_SKEW_MS = 300 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
// Preflight M18: one hung relay must not stall the ladder or shutdown.
const REQUEST_TIMEOUT_MS = 15 * 1000;
// Accepted push signatures remembered until their timestamp goes stale.
const MAX_SEEN_PUSHES = 10000;
// A relay response is a page of at most 100 events; anything bigger is refused.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CURSOR_CHARS = 256;

// The body as text, reading no more than `limit` bytes. Throws past the cap.
async function readCapped(res, limit) {
  const tooBig = () => new Error(`response is over ${limit} bytes`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > limit) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

// The bearer token never reaches an error message or a log line, even when
// the relay (or the network stack) echoes it back.
function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(String(secret)).join('[redacted]') : s;
}

function errorForStatus(status, detail = '') {
  const suffix = detail ? `: ${String(detail).slice(0, 200)}` : '';
  if (status === 400 || status === 422) return new ContactDeliveryError('rejected', `relay rejected the message (${status})${suffix}`);
  if (status === 401 || status === 403) return new ContactDeliveryError('not-configured', `relay refused the credentials (${status})${suffix}`);
  if (status === 413) return new ContactDeliveryError('too-large', `relay says the message is too large (${status})${suffix}`);
  if (status === 429) return new ContactDeliveryError('rate-limited', `relay rate limit (${status})${suffix}`);
  return new ContactDeliveryError('unreachable', `relay error (${status})${suffix}`);
}

class ContactRelayClient {
  constructor({ name, baseUrl, getToken, fetchImpl = globalThis.fetch, log = createLogger('contact/relay'), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.name = name;
    this.baseUrl = assertRelayBaseUrl(baseUrl);
    this.getToken = typeof getToken === 'function' ? getToken : () => null;
    this.fetch = fetchImpl;
    this.log = log;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
  }

  async _request(method, pathname, { body = null, headers = {} } = {}) {
    const token = this.getToken();
    if (!token) throw new ContactDeliveryError('not-configured', `vault contact.relay.${this.name}.token is not set`);
    // The timeout covers the response body too, not only the headers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    let res;
    let text;
    try {
      res = await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: controller.signal
      });
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      const why = controller.signal.aborted ? `timed out after ${this.timeoutMs} ms` : redact(err?.message || err, token);
      throw new ContactDeliveryError('unreachable', `relay ${this.name} is unreachable: ${why}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 200 || res.status > 299) throw errorForStatus(res.status, redact(text, token));
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ContactDeliveryError('unreachable', `relay ${this.name} answered with something that is not JSON`);
    }
  }

  // POST /v1/messages; the same key returns the original message.
  async send(body, { idempotencyKey }) {
    const out = await this._request('POST', '/v1/messages', { body, headers: { 'idempotency-key': String(idempotencyKey) } });
    if (!out || !out.id) throw new ContactDeliveryError('unreachable', `relay ${this.name} returned no message id`);
    return { id: String(out.id), status: out.status || 'queued' };
  }

  async status(id) {
    return this._request('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  async lookup(idempotencyKey) {
    return this._request('GET', `/v1/messages?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
  }

  async events(cursor) {
    const q = cursor ? `after=${encodeURIComponent(cursor)}&limit=100` : 'limit=100';
    const out = await this._request('GET', `/v1/events?${q}`);
    const ok = typeof out.cursor === 'string' && out.cursor.length <= MAX_CURSOR_CHARS;
    if (!ok && out.cursor !== undefined && out.cursor !== null) this.log.warn(`relay ${this.name} sent an invalid cursor; keeping the old one`);
    return { events: Array.isArray(out.events) ? out.events : [], cursor: ok ? out.cursor : (cursor ?? null) };
  }
}

// Polls /v1/events every pollSec, cursor persisted per relay, backing off
// 30 s → 10 min on failure. onEvents(events) is router.ingestRelayEvents.
// shouldPoll(): false on a passive host (another process holds the ladder
// lease). A passive host neither fetches nor advances the cursor, so the
// events stay queued for whichever host is active (final review I1); the
// skip is not a failure and adds no backoff.
class RelayPoller {
  constructor({ client, state, onEvents, shouldPoll = () => true, pollSec = 30, log = createLogger('contact/relay-poll'), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.client = client;
    this.state = state;
    this.onEvents = onEvents;
    this.shouldPoll = shouldPoll;
    this.pollMs = (Number.isFinite(+pollSec) ? Math.max(1, +pollSec) : 30) * 1000;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.failures = 0;
    this.timer = null;
    this.running = false;
  }

  nextDelay() {
    if (!this.failures) return this.pollMs;
    return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.failures - 1));
  }

  async pollOnce() {
    if (!this.shouldPoll()) return { ok: true, count: 0, passive: true };
    try {
      const cursor = this.state.readCursor(this.client.name);
      const { events, cursor: next } = await this.client.events(cursor);
      // The lease can be lost while the fetch is in flight.
      if (!this.shouldPoll()) return { ok: true, count: 0, passive: true };
      if (events.length) await this.onEvents(events);
      this.state.writeCursor(this.client.name, next);
      this.failures = 0;
      return { ok: true, count: events.length };
    } catch (err) {
      this.failures += 1;
      this.log.warn(`polling relay ${this.client.name} failed (${err.message}); next try in ${Math.round(this.nextDelay() / 1000)} s`);
      return { ok: false, error: err.message };
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce();
      if (!this.running) return;
      this.timer = this.setTimer(loop, this.nextDelay());
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    };
    this.timer = this.setTimer(loop, 0);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

// X-KL-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>, ± 300 s.
function verifyRelayPush({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no webhook secret is configured' };
  const t = Date.parse(timestamp);
  const ts = Number.isFinite(t) ? t : Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > PUSH_SKEW_MS) return { ok: false, reason: 'stale or missing X-KL-Timestamp' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(signature || ''));
  if (!m) return { ok: false, reason: 'missing or malformed X-KL-Signature' };
  const want = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const got = Buffer.from(m[1], 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

// The handler behind POST /contact/relay/<name> on the loopback webhook server.
// A verified push is applied once: a replay inside the ± 300 s window gets
// 200 { replay: true } (a relay retrying after a lost response sees success)
// without reaching onEvents. The signature is remembered only after onEvents
// resolves, so a retry after a failed apply is processed, and a forged push
// can't block the real one. The router also drops duplicate event ids.
function createRelayPushHandler({ getSecret, hasRelay = () => true, onEvents, clock = () => new Date() }) {
  const seen = new Map(); // `${name}:${signature}` → forget-after ms
  return async (name, rawBody, headers = {}) => {
    if (!hasRelay(name)) return { status: 404, body: { error: 'unknown relay' } };
    const now = clock().getTime();
    const signature = headers['x-kl-signature'];
    const v = verifyRelayPush({ secret: getSecret(name), timestamp: headers['x-kl-timestamp'], signature, rawBody, now });
    if (!v.ok) return { status: 401, body: { error: v.reason } };
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } };
    }
    const events = Array.isArray(payload?.events) ? payload.events : [payload];
    for (const [k, until] of seen) if (until < now) seen.delete(k);
    const key = `${name}:${String(signature).toLowerCase()}`;
    if (seen.has(key)) return { status: 200, body: { ok: true, replay: true, applied: 0, skipped: events.length } };
    const r = await onEvents(name, events);
    seen.set(key, now + 2 * PUSH_SKEW_MS);
    while (seen.size > MAX_SEEN_PUSHES) seen.delete(seen.keys().next().value);
    return { status: 200, body: { ok: true, ...r } };
  };
}

module.exports = {
  ContactRelayClient, RelayPoller, assertRelayBaseUrl, errorForStatus, verifyRelayPush, createRelayPushHandler,
  BACKOFF_MIN_MS, BACKOFF_MAX_MS, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES
};
