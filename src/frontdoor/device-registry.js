// The relay's view of phones: who may call the phone API, where to push, and
// the log of every enrollment and revocation it relayed (replayed to nodes on
// each relay.hello). Nodes never trust any of it; they verify signatures.
const fs = require('fs');
const path = require('path');
const { deviceIdFromJwk, isDeviceJwk, samePoint, open } = require('../approvals/envelope');
const { writeFileAtomic } = require('../approvals/approver-store');
const { DEVICE_ID_RE, NODE_ID_RE, isTimestamp } = require('../approvals/messages');
const { err } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('frontdoor/device-registry');

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

// A stored read key that is not a P-256 JWK (a hand-edited or corrupted
// file) is dropped on load, so the phone API never verifies against it.
function withReadKeyChecked(record) {
  if (record.read_jwk && isDeviceJwk(record.read_jwk) && isTimestamp(record.read_key_created_at)) return record;
  return { ...record, read_jwk: null, read_key_created_at: null };
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
        if (record && DEVICE_ID_RE.test(record.device_id)) this.devices.set(record.device_id, withReadKeyChecked(record));
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
      registered_at: existing ? existing.registered_at : new Date(this.now()).toISOString(),
      // The read key (android-slim §8.2) is the device's own and survives a
      // re-registration; only setReadKey changes it.
      read_jwk: existing ? existing.read_jwk || null : null,
      read_key_created_at: existing ? existing.read_key_created_at || null : null
    };
    this.devices.set(deviceId, record);
    this._save();
    return record;
  }

  // Stores the device's read key (android-slim §8.2, §8.7). `createdAt` is
  // the statement's (or the enrollment's) created_at: only a strictly newer
  // one replaces the stored key, an older or equal one is ignored. Answers
  // null for an unknown device, else { record, updated }. Throws
  // `bad_read_key` for a key that is not a P-256 JWK, one whose point is the
  // device key's, or a created_at that is not RFC 3339 UTC.
  setReadKey(deviceId, jwk, createdAt) {
    const record = DEVICE_ID_RE.test(deviceId) ? this.devices.get(deviceId) : null;
    if (!record) return null;
    if (!isDeviceJwk(jwk)) throw err('bad_read_key', 'the read key is not a P-256 JWK');
    if (samePoint(jwk, record.jwk)) throw err('bad_read_key', 'the read key is the device key');
    if (!isTimestamp(createdAt)) throw err('bad_read_key', 'created_at must be RFC 3339 UTC');
    if (record.read_jwk && record.read_key_created_at && Date.parse(createdAt) <= Date.parse(record.read_key_created_at)) {
      return { record, updated: false };
    }
    record.read_jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    record.read_key_created_at = createdAt;
    this._save();
    return { record, updated: true };
  }

  // Sets (or with null, clears) where the device's notifications go.
  // Returns a boolean, "wrote": true when it saved a change, false when it
  // wrote nothing (an unknown device, or the platform and token already held:
  // push spec §7.3, the phone re-sends its token at every cold start).
  setPush(deviceId, push) {
    const record = DEVICE_ID_RE.test(deviceId) ? this.devices.get(deviceId) : null;
    if (!record) return false;
    const next = push ? { platform: push.platform, token: push.token } : null;
    const held = record.push || null;
    if (next === null ? held === null : held !== null && held.platform === next.platform && held.token === next.token) return false;
    record.push = next;
    this._save();
    return true;
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
    // A crash mid-append leaves a torn tail with no newline; start on a fresh
    // line so this entry never fuses with the fragment.
    const lead = this._endsTorn() ? '\n' : '';
    fs.appendFileSync(this.logFile, `${lead}${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    this.logLines += 1;
    const { key } = logKey(envelope);
    if (key) this.logKeys.add(key);
    return true;
  }

  _endsTorn() {
    let fd;
    try {
      fd = fs.openSync(this.logFile, 'r');
      const { size } = fs.fstatSync(fd);
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false; // no log yet
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // Every parseable entry, in order. An unparseable line (a torn append) is
  // skipped with a warning rather than hiding every other entry: the log is
  // what carries revocations to nodes that were offline.
  log() {
    let text;
    try {
      text = fs.readFileSync(this.logFile, 'utf8');
    } catch {
      return [];
    }
    const entries = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) log.warn(`device log: skipped ${skipped} unparseable line(s)`, { file: this.logFile });
    return entries;
  }
}

module.exports = { DeviceRegistry, MAX_LOG_LINES };
