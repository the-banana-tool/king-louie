// src/gui/push-queue.js
// The node's push.notify queue (push spec §6.2, C-1): content-free hints that
// a granted lease ended (`session_ended`) or paused for want of contact
// (`session_paused`), sent to the relay over the node's link. Small and in
// memory: sent at once while the link is up, else on its next `connected`;
// an entry over an hour old is dropped (the phone's next list says as much),
// and it holds at most PUSH_QUEUE_MAX entries, the oldest out. A relay older
// than push.notify answers `unknown_method`: logged once at debug for that
// link, and the queue is off until the next `connected`.
//
// The queue is the LeaseManager's (`leases.pushQueue`); a TakeManager queues
// its restart endings with `enqueue`, and the GUI's stop awaits `drain`.
const { createLogger } = require('../logging');

const PUSH_QUEUE_MAX = 32;
const PUSH_MAX_AGE_MS = 60 * 60 * 1000;
const { SESSION_KINDS } = require('../frontdoor/push/text');
const PUSH_KINDS = new Set(SESSION_KINDS);
// A send that failed because the link went: kept for the next `connected`.
const LINK_DOWN_CODES = new Set(['relay_offline', 'not_linked', 'peer_disconnected', 'closed']);

class PushQueue {
  constructor({ relayClient = null, clock = Date.now, log = createLogger('gui/push-queue'),
    maxEntries = PUSH_QUEUE_MAX, maxAgeMs = PUSH_MAX_AGE_MS } = {}) {
    Object.assign(this, { relayClient, clock, log, maxEntries, maxAgeMs });
    this.entries = []; // { params, at }
    this.inFlight = new Set();
    this.unsupported = false;
    this.listening = false;
    this._onUp = () => {
      this.unsupported = false;
      this._flush();
    };
  }

  start() {
    const relay = this.relayClient;
    if (this.listening || !relay || typeof relay.on !== 'function') return;
    relay.on('connected', this._onUp);
    this.listening = true;
    // What was queued before start (a take ended at a restart) goes now if the link came up
    // meanwhile: that connected was heard by nobody.
    this._flush();
  }

  // Stops waiting for the next `connected`; sends in flight still settle.
  stop() {
    const relay = this.relayClient;
    if (this.listening && relay && typeof relay.off === 'function') relay.off('connected', this._onUp);
    this.listening = false;
  }

  size() { return this.entries.length; }

  // { kind, id, to_device?, except_device?, expires_at? }: every field is
  // sent, null when not given. Sent now when the link is up.
  enqueue({ kind, id, to_device = null, except_device = null, expires_at = null }) {
    if (!PUSH_KINDS.has(kind)) throw new TypeError(`push kind ${kind} is not a push.notify kind`);
    if (this.unsupported) return;
    this.entries.push({ params: { kind, id, to_device, except_device, expires_at }, at: this.clock() });
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this._flush();
  }

  _canSend() {
    const relay = this.relayClient;
    return Boolean(relay && typeof relay.pushNotify === 'function' && typeof relay.isConnected === 'function' && relay.isConnected());
  }

  _flush() {
    const now = this.clock();
    this.entries = this.entries.filter((e) => now - e.at <= this.maxAgeMs);
    if (this.unsupported || !this._canSend()) return;
    const batch = this.entries;
    this.entries = [];
    for (const entry of batch) this._send(entry);
  }

  _send(entry) {
    let p;
    try {
      p = Promise.resolve(this.relayClient.pushNotify(entry.params));
    } catch (err) {
      p = Promise.reject(err);
    }
    const tracked = p.then(() => {}, (err) => this._failed(entry, err)).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  _failed(entry, err) {
    const code = err && err.code;
    if (code === 'unknown_method') {
      if (!this.unsupported) this.log.debug('the relay does not know push.notify; no session pushes on this link');
      this.unsupported = true;
      this.entries = [];
      return;
    }
    const relay = this.relayClient;
    if (LINK_DOWN_CODES.has(code) || !relay.isConnected()) {
      if (this.unsupported) return;
      this.entries.unshift(entry);
      while (this.entries.length > this.maxEntries) this.entries.shift();
      return;
    }
    this.log.debug(`push.notify not sent (${code || 'error'})`);
  }

  // Resolves when nothing is in flight, or after timeoutMs, whichever is
  // first. Entries waiting for a link that is down are not waited for.
  async drain({ timeoutMs = 2000 } = {}) {
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); });
    try {
      while (this.inFlight.size > 0) {
        const pending = Promise.allSettled([...this.inFlight]).then(() => 'settled');
        const r = await Promise.race([pending, timeout.then(() => 'timeout')]);
        if (r === 'timeout') return;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PushQueue, PUSH_QUEUE_MAX, PUSH_MAX_AGE_MS, PUSH_KINDS };
