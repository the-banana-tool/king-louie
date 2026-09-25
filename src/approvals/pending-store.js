// Approval requests waiting for a phone, in memory only: a restart fails the
// job (parent §9), so a response replayed after a restart finds nothing here
// and gets unknown_request.
const { NonceCache } = require('./verify-device');

class PendingRequests {
  constructor({ now = Date.now, nonces = null } = {}) {
    this.now = now;
    this.items = new Map();
    this.nonces = nonces || new NonceCache({ now });
  }

  // entry = { request, bytes, envelope, currentAction, resolve, ... }
  add(entry) {
    this.items.set(entry.request.request_id, entry);
    return entry;
  }

  get(requestId) {
    return this.items.get(requestId) || null;
  }

  take(requestId) {
    const entry = this.items.get(requestId) || null;
    if (entry) this.items.delete(requestId);
    return entry;
  }

  // Removes and returns every entry whose expires_at has passed on this clock.
  expire(now = this.now()) {
    const removed = [];
    for (const [id, entry] of this.items) {
      if (now > Date.parse(entry.request.expires_at)) {
        this.items.delete(id);
        removed.push(entry);
      }
    }
    return removed;
  }

  list() {
    return [...this.items.values()];
  }

  get size() {
    return this.items.size;
  }
}

module.exports = { PendingRequests };
