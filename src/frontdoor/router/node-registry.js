// Which nodes the front door trusts (fleet stage 4 §3.6): the union of
// console-confirmed records (admin-written <configDir>/frontdoor-nodes/, read
// with the node.yaml ownership check) and phone-confirmed records
// (<dataDir>/frontdoor/nodes.json, each re-verified against the admin-owned
// approvers on every load; the signatures decide, not the directory).
//
// Identity is always derived from the key: a record whose node_id does not
// derive from its public_key is refused, and peers() derives nodeId and
// peerId from the key again rather than trusting a stored id. The front
// door's own id (and so its key) is reserved.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { assertAdminOwned } = require('../../service/config');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { NODE_ID_RE, isTimestamp } = require('../../approvals/messages');
const { isTestNodeKey } = require('../../approvals/test-keys');
const { deriveNodeId } = require('../../mesh/node-identity');
const { derivePeerId } = require('../../mesh/mesh-identity');
const { spkiHexFromRaw, NODE_NAME_RE, RAW_ED25519_RE, HEX_SHA256_RE } = require('../protocol/messages');
const { verifyPhoneEnvelope } = require('../protocol/checks');
const { err } = require('../errors');

const log = createLogger('frontdoor/registry');

const CONSOLE_DIR = 'frontdoor-nodes';
const CONTROLS = { decides: 'which nodes this front door trusts', selfGrant: 'add a node of its own choosing' };
const PROFILES = ['agent', 'runbook'];
// nodes.rejected.json only ever grows by appending, but keeps the newest
// entries: at most this many, and a record too large to keep is cut to its id.
const QUARANTINE_MAX_ENTRIES = 200;
const QUARANTINE_MAX_ENTRY_BYTES = 64 * 1024;
// Removals remembered so a retried removal succeeds (see removeSigned).
const MAX_REMOVALS = 1000;
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

function derivedId(raw) {
  try {
    return deriveNodeId(spkiHexFromRaw(raw));
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// null when the record is well formed, else the reason. `frontdoorId`, when
// given, is reserved: no record may claim it (or, since the id derives from
// the key, the front door's key).
function recordProblem(r, source, { frontdoorId = null } = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'malformed';
  if (typeof r.node_id !== 'string' || !NODE_ID_RE.test(r.node_id) || typeof r.node_name !== 'string' || !NODE_NAME_RE.test(r.node_name) || !PROFILES.includes(r.profile)) return 'malformed';
  if (typeof r.public_key !== 'string' || !RAW_ED25519_RE.test(r.public_key) || typeof r.tls_fingerprint !== 'string' || !HEX_SHA256_RE.test(r.tls_fingerprint)) return 'malformed';
  if (!isTimestamp(r.accepted_at) || r.source !== source) return 'malformed';
  const derived = derivedId(r.public_key);
  if (frontdoorId && (r.node_id === frontdoorId || derived === frontdoorId)) return 'reserved_node_id';
  if (derived !== r.node_id) return 'node_id_mismatch';
  return null;
}

class NodeRegistry extends EventEmitter {
  constructor({ configDir, dataDir, approverStore, frontdoorId, alerts = null, adminUid = 0, geteuid = defaultGeteuid, now = Date.now } = {}) {
    super();
    if (!approverStore || typeof approverStore.get !== 'function' || typeof approverStore.dir !== 'string') throw new TypeError('NodeRegistry needs the admin approver store (with its dir)');
    // Approvals are read only from the admin-owned config dir, never from
    // the service-writable data dir.
    if (isInside(approverStore.dir, dataDir)) {
      throw new Error(`NodeRegistry refuses approvers under the data dir (${approverStore.dir}); they must come from the admin config dir`);
    }
    if (typeof frontdoorId !== 'string' || !NODE_ID_RE.test(frontdoorId)) throw new TypeError('NodeRegistry needs the front door\'s own node id');
    this.configDir = configDir;
    this.dataDir = dataDir;
    this.approverStore = approverStore;
    this.frontdoorId = frontdoorId;
    this.alerts = alerts;
    this.adminUid = adminUid;
    this.geteuid = geteuid;
    this.now = now;
    this.phoneFile = path.join(dataDir, 'frontdoor', 'nodes.json');
    this.rejectedFile = path.join(dataDir, 'frontdoor', 'nodes.rejected.json');
    this.nodes = new Map();
    this.status = new Map();
    // Phone records this process removed, by node id → { record, saved }
    // (bounded, oldest first out). `saved` is false while the removal has not
    // reached nodes.json (the save threw); any successful save writes it.
    // load() never brings a removed node back, and removeSigned() of a
    // removed node saves if needed and succeeds again, so a retry after a
    // failed save reports success. Enrolling the node again forgets it.
    this.removals = new Map();
  }

  static consoleDir(configDir) {
    return path.join(configDir, CONSOLE_DIR);
  }

  // Admin CLI only (`frontdoor code … --confirm`).
  // With frontdoorId, that id (and so the front door's key) is refused here
  // as well as on load.
  static writeConsoleRecord(configDir, record, { frontdoorId = null } = {}) {
    const problem = recordProblem(record, 'console', { frontdoorId });
    if (problem) throw new Error(`refusing to write a console node record: ${problem}`);
    const dir = NodeRegistry.consoleDir(configDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileAtomic(path.join(dir, `${record.node_id}.json`), `${JSON.stringify(record, null, 2)}\n`, 0o644);
  }

  // Admin CLI only (`frontdoor remove-node <name>`).
  static removeConsoleRecord(configDir, nodeName) {
    const dir = NodeRegistry.consoleDir(configDir);
    if (!fs.existsSync(dir)) return false;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (r.node_name === nodeName) {
          fs.rmSync(path.join(dir, name));
          return true;
        }
      } catch {
        // not a record
      }
    }
    return false;
  }

  _raise(kind, subject, detail) {
    if (!this.alerts) return;
    try {
      this.alerts.raise(kind, { subject, detail });
    } catch (e) {
      log.error(`could not raise ${kind} for ${subject}: ${e.message}`);
    }
  }

  _invalid(record, reason) {
    const id = record && typeof record.node_id === 'string' && NODE_ID_RE.test(record.node_id) ? record.node_id : 'unknown';
    log.error(`node record ${id} rejected: ${reason}`);
    this._raise('node_record_invalid', `node:${id}`, { reason });
  }

  _testKeyRefused(record) {
    return this.approverStore.allowTestKeys !== true && isTestNodeKey(spkiHexFromRaw(record.public_key));
  }

  _loadConsole() {
    const out = new Map();
    const dir = NodeRegistry.consoleDir(this.configDir);
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      let record;
      try {
        assertAdminOwned(file, this.geteuid, this.adminUid, CONTROLS);
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        this._invalid({ node_id: name.replace(/\.json$/, '') }, e.message);
        continue;
      }
      const problem = recordProblem(record, 'console', { frontdoorId: this.frontdoorId })
        || (name !== `${record.node_id}.json` ? 'file_name_mismatch' : null)
        || (this._testKeyRefused(record) ? 'test_key' : null);
      if (problem) {
        this._invalid(record, problem);
        continue;
      }
      out.set(record.node_id, { ...record, signed: null, confirmed_by: 'console' });
    }
    return out;
  }

  // The envelope (from an active or, per R25, a later-revoked approver in the
  // admin store) must approve exactly this record.
  _phoneProblem(record) {
    const shape = recordProblem(record, 'phone', { frontdoorId: this.frontdoorId });
    if (shape) return shape;
    const v = verifyPhoneEnvelope(record.signed, { approverStore: this.approverStore, type: 'kl.node.enroll', frontdoorId: this.frontdoorId, acceptedAt: record.accepted_at });
    if (!v.ok) return v.reason;
    const m = v.message;
    if (m.decision !== 'approve') return 'not_approved';
    for (const k of ['node_id', 'node_name', 'profile', 'public_key', 'tls_fingerprint']) if (m[k] !== record[k]) return 'record_mismatch';
    if (this._testKeyRefused(record)) return 'test_key';
    return null;
  }

  // → { nodes, unreadable }: an unreadable file is quarantined whole rather
  // than read as empty (the next save would silently drop every node).
  _readPhone() {
    let text;
    try {
      text = fs.readFileSync(this.phoneFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { nodes: {}, unreadable: null };
      return { nodes: {}, unreadable: `cannot read: ${e.code || e.message}` };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.v === 1 && parsed.nodes && typeof parsed.nodes === 'object' && !Array.isArray(parsed.nodes)) return { nodes: parsed.nodes, unreadable: null };
    } catch {
      // fall through
    }
    return { nodes: {}, unreadable: text };
  }

  _savePhone() {
    const nodes = {};
    for (const r of this.nodes.values()) if (r.source === 'phone') nodes[r.node_id] = r;
    fs.mkdirSync(path.dirname(this.phoneFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.phoneFile, `${JSON.stringify({ v: 1, nodes }, null, 2)}\n`);
    for (const entry of this.removals.values()) entry.saved = true;
  }

  _quarantine(entries) {
    let existing = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.rejectedFile, 'utf8'));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
    const bounded = entries.map((e) => {
      if (Buffer.byteLength(JSON.stringify(e), 'utf8') <= QUARANTINE_MAX_ENTRY_BYTES) return e;
      const id = e.record && typeof e.record.node_id === 'string' ? e.record.node_id.slice(0, 64) : null;
      return { record: { node_id: id }, reason: e.reason, at: e.at, truncated: true };
    });
    fs.mkdirSync(path.dirname(this.rejectedFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.rejectedFile, `${JSON.stringify([...existing, ...bounded].slice(-QUARANTINE_MAX_ENTRIES), null, 2)}\n`);
  }

  load() {
    const nodes = this._loadConsole();
    const names = new Map([...nodes.values()].map((r) => [r.node_name, r.node_id]));
    const at = new Date(this.now()).toISOString();
    const rejected = [];
    const { nodes: stored, unreadable } = this._readPhone();
    let removedSince = false;
    if (unreadable !== null) {
      rejected.push({ record: null, raw: unreadable, reason: 'unreadable', at });
      this._invalid(null, 'unreadable');
    }
    for (const record of Object.values(stored)) {
      if (record && this.removals.has(record.node_id)) {
        removedSince = true;
        continue;
      }
      let reason = this._phoneProblem(record);
      if (!reason && nodes.has(record.node_id)) reason = nodes.get(record.node_id).source === 'console' ? 'shadowed_by_console' : 'duplicate_node';
      if (!reason && names.has(record.node_name)) reason = nodes.get(names.get(record.node_name)).source === 'console' ? 'shadowed_by_console' : 'duplicate_name';
      if (reason) {
        rejected.push({ record, reason, at });
        this._invalid(record, reason);
        continue;
      }
      nodes.set(record.node_id, record);
      names.set(record.node_name, record.node_id);
    }
    this.nodes = nodes;
    if (rejected.length) {
      this._quarantine(rejected);
      this._savePhone();
    } else if (removedSince) {
      try {
        this._savePhone();
      } catch (e) {
        log.error(`saving ${this.phoneFile} failed (${e.code || e.message}); the removed nodes stay removed in memory`);
      }
    }
    this.emit('change');
    return this.list();
  }

  // A phone-signed enrollment the pairing service already bound to its
  // pending pairing (checkNodeEnroll); the registry re-verifies the signature.
  addSigned(envelope, { acceptedAt = new Date(this.now()).toISOString() } = {}) {
    const v = verifyPhoneEnvelope(envelope, { approverStore: this.approverStore, type: 'kl.node.enroll', frontdoorId: this.frontdoorId });
    if (!v.ok) throw err(v.reason, `node enrollment refused: ${v.reason}`);
    const m = v.message;
    if (m.decision !== 'approve') throw err('not_approved', 'the phone denied this node');
    const record = { node_id: m.node_id, node_name: m.node_name, profile: m.profile, public_key: m.public_key, tls_fingerprint: m.tls_fingerprint, source: 'phone', accepted_at: acceptedAt, signed: envelope };
    const problem = recordProblem(record, 'phone', { frontdoorId: this.frontdoorId }) || (this._testKeyRefused(record) ? 'test_key' : null);
    if (problem) throw err(problem, `node enrollment refused: ${problem}`);
    const sameName = this.byName(m.node_name);
    const sameKey = this.byId(m.node_id);
    const replacing = m.replaces ? this.byId(m.replaces) : null;
    for (const old of [sameName, sameKey, replacing]) {
      if (old && old.source === 'console') {
        throw err('console_record', `"${old.node_name}" was confirmed at the front door console; replace it there with frontdoor code ${old.node_name} --confirm`);
      }
    }
    const removed = new Set();
    for (const old of [sameName, replacing]) if (old && old.node_id !== m.node_id) removed.add(old.node_id);
    for (const id of removed) this.nodes.delete(id);
    this.nodes.set(record.node_id, record);
    this.removals.delete(record.node_id);
    this._savePhone();
    for (const id of removed) this.emit('replaced', { oldId: id, newId: record.node_id });
    this.emit('change');
    return record;
  }

  // A verified kl.node.remove (challenge checked by the caller) →
  // { record, changed }. The node leaves memory, and its link is closed, even
  // when saving fails: that throws `save_failed`, with `removedNow: true` when
  // this call is the one that took the node out. Removing a node this process
  // already removed saves if that is still needed and succeeds, so a retry
  // reports success; `changed` says whether this call removed or saved
  // anything (false for a removal already on disk).
  removeSigned(message) {
    const id = message && message.node_id;
    const r = this.byId(id);
    if (!r) {
      const earlier = typeof id === 'string' ? this.removals.get(id) : undefined;
      if (!earlier) throw err('unknown_node', 'no such node');
      if (earlier.saved) return { record: earlier.record, changed: false };
      this._savePhoneOrThrow(earlier.record);
      return { record: earlier.record, changed: true };
    }
    if (r.source === 'console') throw err('console_record', `"${r.node_name}" was confirmed at the console; remove it there with frontdoor remove-node ${r.node_name}`);
    this.nodes.delete(r.node_id);
    this.removals.set(r.node_id, { record: r, saved: false });
    // Saved removals go first: forgetting an unsaved one would let a reload bring it back.
    while (this.removals.size > MAX_REMOVALS) {
      const [victim] = [...this.removals].find(([, e]) => e.saved) || [...this.removals][0];
      this.removals.delete(victim);
    }
    try {
      this._savePhoneOrThrow(r);
    } catch (e) {
      e.removedNow = true;
      throw e;
    } finally {
      // A listener that throws must not undo a good save or skip the caller's audit.
      for (const [event, payload] of [['removed', { nodeId: r.node_id, reason: 'phone' }], ['change', undefined]]) {
        try {
          this.emit(event, payload);
        } catch (e) {
          log.error(`a '${event}' listener failed after removing ${r.node_id}: ${e.message}`);
        }
      }
    }
    return { record: r, changed: true };
  }

  // A phone record this process removed (saved or not), else null.
  removal(id) {
    const entry = this.removals.get(id);
    return entry ? entry.record : null;
  }

  _savePhoneOrThrow(r) {
    try {
      this._savePhone();
    } catch (e) {
      log.error(`saving ${this.phoneFile} failed (${e.code || e.message}); ${r.node_id} is removed in memory only`);
      throw err('save_failed', 'the removal could not be saved');
    }
  }

  byId(id) {
    return this.nodes.get(id) || null;
  }

  byName(name) {
    for (const r of this.nodes.values()) if (r.node_name === name) return r;
    return null;
  }

  list() {
    return [...this.nodes.values()].map(({ signed, ...rest }) => rest);
  }

  pinnedCertSet() {
    return new Set(this.peers().map((p) => p.tlsFingerprint));
  }

  // nodeId and peerId come from the key, never from the stored id; a record
  // whose stored id disagrees (or that claims the front door) is left out.
  peers() {
    const out = [];
    for (const r of this.nodes.values()) {
      let publicKeyHex;
      let nodeId;
      try {
        publicKeyHex = spkiHexFromRaw(r.public_key);
        nodeId = deriveNodeId(publicKeyHex);
      } catch {
        nodeId = null;
      }
      if (!nodeId || nodeId !== r.node_id || nodeId === this.frontdoorId) {
        log.error(`leaving node record ${r.node_id} out of the peer list: its id does not derive from its key`);
        continue;
      }
      out.push({ peerId: derivePeerId(publicKeyHex), publicKeyHex, name: r.node_name, tlsFingerprint: r.tls_fingerprint, nodeId });
    }
    return out;
  }

  peerSource() {
    return { list: () => this.peers(), on: (ev, fn) => this.on(ev, fn), removeListener: (ev, fn) => this.removeListener(ev, fn) };
  }

  // Repeated takeovers of one node's link (MeshTransport 'peerTakeover'
  // with flapping) raise node_link_flapping. Returns the unsubscribe.
  watchTransport(transport) {
    const onTakeover = ({ peerId, count, windowMs, flapping }) => {
      if (!flapping) return;
      const peer = this.peers().find((p) => p.peerId === peerId);
      if (!peer) return;
      this._raise('node_link_flapping', `node:${peer.nodeId}`, { takeovers: count, window_s: Math.round(windowMs / 1000) });
    };
    transport.on('peerTakeover', onTakeover);
    return () => transport.removeListener('peerTakeover', onTakeover);
  }

  markOnline(nodeId, hello = {}) {
    const prev = this.status.get(nodeId);
    const bootChanged = Boolean(prev && prev.boot_id && hello.boot_id && prev.boot_id !== hello.boot_id);
    this.status.set(nodeId, { online: true, last_seen: new Date(this.now()).toISOString(), boot_id: hello.boot_id || (prev && prev.boot_id) || null, hello });
    return { bootChanged };
  }

  markOffline(nodeId) {
    const prev = this.status.get(nodeId) || {};
    this.status.set(nodeId, { ...prev, online: false, last_seen: new Date(this.now()).toISOString() });
  }

  presence(nodeId) {
    return this.status.get(nodeId) || null;
  }
}

module.exports = { NodeRegistry, recordProblem, QUARANTINE_MAX_ENTRIES };
