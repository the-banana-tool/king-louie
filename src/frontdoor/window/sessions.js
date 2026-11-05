// What the front door keeps of a window (remote window plan, R-RW-4, R-RW-5): one
// record per spliced session, ids and byte counts only, and the limits over them.
// `device_id` is what the clear hello_w claims. Only the node verifies it.
const MINUTE_MS = 60000;
const MINUTES = 60;

class WindowSessions {
  #records = new Map();
  #budgets = new Map();

  constructor({ maxSessionsPerGrant, maxSessionsPerDeviceNode, maxBytesPerHour, now = Date.now } = {}) {
    this.maxSessionsPerGrant = maxSessionsPerGrant;
    this.maxSessionsPerDeviceNode = maxSessionsPerDeviceNode;
    this.maxBytesPerHour = maxBytesPerHour;
    this.now = now;
  }

  get size() {
    return this.#records.size;
  }

  list() {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }

  grantAtLimit(grantId) {
    let count = 0;
    for (const record of this.#records.values()) if (record.grant_id === grantId) count += 1;
    return count >= this.maxSessionsPerGrant;
  }

  add({ session_id, grant_id, client_id, node_id }) {
    const record = { session_id, grant_id, client_id, node_id, device_id: null, opened_at: this.now(), bytes_in: 0, bytes_out: 0 };
    this.#records.set(session_id, record);
    this.#budgets.set(session_id, { total: 0, minutes: new Map() });
    return record;
  }

  remove(sessionId) {
    this.#records.delete(sessionId);
    this.#budgets.delete(sessionId);
  }

  // → false when this session passes the limit for its device on its node.
  setDevice(sessionId, deviceId) {
    const record = this.#records.get(sessionId);
    if (!record) return true;
    record.device_id = deviceId;
    let count = 0;
    for (const other of this.#records.values()) {
      if (other.device_id === deviceId && other.node_id === record.node_id) count += 1;
    }
    return count <= this.maxSessionsPerDeviceNode;
  }

  // Counts bytes in one direction, 'in' from the window or 'out' from the node.
  // → false when they pass the session's budget for the rolling hour, both
  // directions together, counted by the minute.
  addBytes(sessionId, direction, count) {
    const record = this.#records.get(sessionId);
    const budget = this.#budgets.get(sessionId);
    if (!record || !budget) return false;
    record[direction === 'in' ? 'bytes_in' : 'bytes_out'] += count;
    const minute = Math.floor(this.now() / MINUTE_MS);
    for (const [at, bytes] of budget.minutes) {
      if (at > minute - MINUTES) break;
      budget.total -= bytes;
      budget.minutes.delete(at);
    }
    budget.minutes.set(minute, (budget.minutes.get(minute) || 0) + count);
    budget.total += count;
    return budget.total <= this.maxBytesPerHour;
  }
}

module.exports = { WindowSessions };
