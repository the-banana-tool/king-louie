// Signed approval requests the relay holds until they expire, with their last
// node-signed status. Memory only: after a relay restart the nodes resubmit.
const { EventEmitter } = require('events');
const { open } = require('../approvals/envelope');
const { validateMessage, NODE_ID_RE } = require('../approvals/messages');

const GRACE_MS = 60000;
// Long polls never wait longer than this, matching the mailbox's own cap:
// nothing in this store keeps a promise, a timer or a listener alive past it.
const MAX_WAIT_MS = 25000;
// A backstop the TTL sweep alone does not give: an envelope's expires_at is
// whatever the signing node put there, so a run of requests with a
// far-future expiry cannot be relied on to age out before sweep() is next
// called. Oldest entries (by insertion order, which tracks seq) go first.
const MAX_ITEMS = 5000;

const err = (code, message) => Object.assign(new Error(message || code), { code });

class ApprovalCache extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.items = new Map();
    this.seq = 0;
  }

  // `nodeId` is the mesh-authenticated identity of the caller, never read
  // from the envelope; the envelope must still be a well-formed
  // kl.approval.request whose own node_id agrees with it before its
  // request_id becomes a cache key.
  put(nodeId, envelope) {
    if (!NODE_ID_RE.test(nodeId)) throw err('bad_node', 'node id is not well-formed');
    const { message } = open(envelope);
    if (validateMessage('kl.approval.request', message) || message.node_id !== nodeId) {
      throw err('bad_request', 'not a valid approval request for this node');
    }
    const existing = this.items.get(message.request_id);
    this.seq += 1;
    const entry = {
      request_id: message.request_id,
      node_id: nodeId,
      envelope,
      expires_at: Date.parse(message.expires_at),
      status: existing ? existing.status : null,
      seq: this.seq
    };
    this.items.set(message.request_id, entry);
    this._bound();
    this.emit('change', this.seq);
    return entry;
  }

  get(requestId) {
    const entry = this.items.get(requestId);
    return entry ? { node_id: entry.node_id, envelope: entry.envelope, expires_at: entry.expires_at, status: entry.status, seq: entry.seq } : null;
  }

  // Returns false, never throws, for an unknown request or a status that
  // does not check out (wrong request, wrong node, or not even a valid
  // envelope): the caller treats all of those the same way.
  setStatus(requestId, statusEnvelope) {
    const entry = this.items.get(requestId);
    if (!entry) return false;
    let message;
    try {
      ({ message } = open(statusEnvelope));
    } catch {
      return false;
    }
    if (validateMessage('kl.approval.status', message) || message.request_id !== requestId || message.node_id !== entry.node_id) {
      return false;
    }
    this.seq += 1;
    entry.status = statusEnvelope;
    entry.seq = this.seq;
    this.emit('change', this.seq);
    return true;
  }

  // Unexpired requests of these nodes (and, for a minute after expiry, the
  // expired ones with their status, so a phone sees how they ended).
  list(nodeIds) {
    const wanted = new Set(nodeIds);
    const now = this.now();
    return [...this.items.values()]
      .filter((e) => wanted.has(e.node_id) && now <= e.expires_at + GRACE_MS)
      .sort((a, b) => a.seq - b.seq);
  }

  // Resolves once anything newer than afterSeq exists, or after timeoutMs
  // (clamped to MAX_WAIT_MS either way). The listener it registers is always
  // removed, on whichever path resolves the promise, so a caller that never
  // comes back for the result (a disconnected phone) leaves nothing behind.
  waitForChange(afterSeq, timeoutMs) {
    const limit = Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS);
    if (this.seq > afterSeq || limit <= 0) return Promise.resolve(this.seq);
    return new Promise((resolve) => {
      const onChange = (seq) => { clearTimeout(timer); resolve(seq); };
      const timer = setTimeout(() => { this.removeListener('change', onChange); resolve(this.seq); }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      this.once('change', onChange);
    });
  }

  sweep() {
    const now = this.now();
    for (const [id, e] of this.items) if (now > e.expires_at + GRACE_MS) this.items.delete(id);
  }

  _bound() {
    if (this.items.size <= MAX_ITEMS) return;
    let excess = this.items.size - MAX_ITEMS;
    for (const id of this.items.keys()) {
      if (excess-- <= 0) break;
      this.items.delete(id);
    }
  }
}

module.exports = { ApprovalCache, MAX_WAIT_MS };
