// The relay's view of phones: who may call the phone API, where to push, and
// the log of every enrollment and revocation it relayed (replayed to nodes on
// each relay.hello). Nodes never trust any of it; they verify signatures.
const fs = require('fs');
const path = require('path');
const { deviceIdFromJwk, open } = require('../approvals/envelope');
const { writeFileAtomic } = require('../approvals/approver-store');
const { DEVICE_ID_RE, NODE_ID_RE } = require('../approvals/messages');
const { err } = require('./errors');

const PLATFORMS = ['ios', 'android', 'demo'];
// The log is replayed to every node on each relay.hello, so it is bounded.
// The cap binds enrollments only: a revocation must never be blockable, and
// revocations are bounded by their own dedupe (one per signer and target).
const MAX_LOG_LINES = 10000;

// The dedupe key of a log entry: one enrollment per enrolled device, one
// revocation per (signer, target). A revocation by one device never shadows
// another device's revocation of the same target.
function logKey(envelope) {
  try {
    const { message } = open(envelope);
    if (message.type === 'kl.device.enroll' && message.device) return { kind: 'enroll', key: `enroll|${message.device.device_id}` };
    if (message.type === 'kl.device.revoke') return { kind: 'revoke', key: `revoke|${message.revoked_by}|${message.device_id}` };
  } catch {
    // not an envelope
  }
  return { kind: 'other', key: null };
}

class DeviceRegistry {
  constructor({ file, now = Date.now } = {}) {
    if (!file) throw new TypeError('DeviceRegistry needs a file');
    this.file = file;
    this.logFile = path.join(path.dirname(file), 'device-log.jsonl');
    // Read once here; appendLog keeps both up to date without re-reading.
    this.logLines = 0;
    this.logKeys = new Set();
    for (const entry of this.log()) {
      this.logLines += 1;
      const { key } = logKey(entry);
      if (key) this.logKeys.add(key);
    }
    this.now = now;
    this.devices = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // A record whose device_id does not fit the regex (a hand-edited or
      // corrupted file) is dropped on load rather than becoming a map key.
      for (const record of Object.values(parsed.devices || {})) {
        if (record && DEVICE_ID_RE.test(record.device_id)) this.devices.set(record.device_id, record);
      }
    } catch {
      // No registry yet.
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ devices: Object.fromEntries(this.devices) }, null, 2)}\n`);
  }

  get(deviceId) {
    return DEVICE_ID_RE.test(deviceId) ? this.devices.get(deviceId) || null : null;
  }

  list() {
    return [...this.devices.values()];
  }

  // device_id must be exactly the id its own key derives: it becomes both
  // this registry's map key and the id every other frontdoor store keys its
  // own records on, so it is never taken on the caller's word.
  register({ device_id: deviceId, jwk, name, platform }) {
    let derived;
    try {
      derived = deviceIdFromJwk(jwk);
    } catch {
      throw err('bad_device', 'jwk is not a valid P-256 device key');
    }
    if (!DEVICE_ID_RE.test(deviceId) || derived !== deviceId) throw err('bad_device', 'device_id does not derive from the key');
    if (!PLATFORMS.includes(platform)) throw err('bad_device', 'unknown platform');
    const existing = this.devices.get(deviceId);
    const record = {
      device_id: deviceId,
      jwk,
      name: String(name).slice(0, 64),
      platform,
      push: existing ? existing.push : null,
      nodes: existing ? existing.nodes : {},
      registered_at: existing ? existing.registered_at : new Date(this.now()).toISOString()
    };
    this.devices.set(deviceId, record);
    this._save();
    return record;
  }

  setPush(deviceId, push) {
    const record = DEVICE_ID_RE.test(deviceId) ? this.devices.get(deviceId) : null;
    if (!record) return null;
    record.push = push ? { platform: push.platform, token: push.token } : null;
    this._save();
    return record;
  }

  // nodeId becomes a key of record.nodes, so it is checked against its own
  // regex before it is ever written there.
  setNodeState(deviceId, nodeId, state) {
    if (!NODE_ID_RE.test(nodeId)) throw err('bad_node', 'node id is not well-formed');
    const record = DEVICE_ID_RE.test(deviceId) ? this.devices.get(deviceId) : null;
    if (!record) return null;
    record.nodes = { ...record.nodes, [nodeId]: state };
    this._save();
    return record;
  }

  // Devices a node's approval requests are pushed to and shown to.
  devicesForNode(nodeId) {
    if (!NODE_ID_RE.test(nodeId)) return [];
    return this.list().filter((d) => d.nodes && d.nodes[nodeId] === 'active');
  }

  nodesForDevice(deviceId) {
    if (!DEVICE_ID_RE.test(deviceId)) return [];
    const record = this.devices.get(deviceId);
    return record ? Object.entries(record.nodes || {}).map(([node_id, state]) => ({ node_id, state })) : [];
  }

  remove(deviceId) {
    if (!DEVICE_ID_RE.test(deviceId)) return false;
    const had = this.devices.delete(deviceId);
    if (had) this._save();
    return had;
  }

  // 'append', 'duplicate' (already logged: an enrollment of the same
  // device, or a revocation by the same signer of the same target) or
  // 'full' (an enrollment while the log holds MAX_LOG_LINES entries).
  // Revocations are never 'full'.
  logDecision(envelope) {
    const { kind, key } = logKey(envelope);
    if (key && this.logKeys.has(key)) return 'duplicate';
    if (kind !== 'revoke' && this.logLines >= MAX_LOG_LINES) return 'full';
    return 'append';
  }

  // → true when appended, false for a duplicate; throws `log_full` for an
  // enrollment at the cap.
  appendLog(envelope) {
    const decision = this.logDecision(envelope);
    if (decision === 'duplicate') return false;
    if (decision === 'full') throw err('log_full', `the device log is full (${MAX_LOG_LINES} entries)`);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.logFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    this.logLines += 1;
    const { key } = logKey(envelope);
    if (key) this.logKeys.add(key);
    return true;
  }

  log() {
    try {
      return fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

module.exports = { DeviceRegistry, MAX_LOG_LINES };
