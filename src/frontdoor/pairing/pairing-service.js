// Node pairing on the front door (fleet stage 4 §3.11, §4.3, §4.4). A code
// (F3's six words, ten minutes, bound to a node name) is issued by a phone
// or by the admin console; the node proves it holds the code with a signed
// kl.node.pair; the front door answers with its own signed accept and a
// pending pairing, which a phone's kl.node.enroll (or the admin's console
// record) turns into a registry record. Codes are stored hashed.
//
// Every check-then-act below (submit, decide, consoleConfirmed,
// consoleDeclined) runs without an await between the check and the state
// change, so two concurrent calls on one code or one pairing are decided in
// turn by the event loop: exactly one wins.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { DEVICE_ID_RE, NONCE_RE, NODE_ID_RE, isTimestamp } = require('../../approvals/messages');
const { WORDLIST } = require('../../mesh/mesh-pairing');
const { NODE_NAME_RE, PAIRING_ID_RE, RAW_ED25519_RE, HEX_SHA256_RE, pairingCodeHash, buildNodePairAccept } = require('../protocol/messages');
const { checkNodePair, checkNodeEnroll } = require('../protocol/checks');
const { recordFrontDoorEvent } = require('../audit/own-ledger');
const { err } = require('../errors');

const log = createLogger('frontdoor/pairing');

const TTL_MS = 10 * 60 * 1000;
const KEEP_MS = 10 * 60 * 1000;
const CODE_WORDS = 6;
const MAX_ATTEMPTS = 5;
// pairing.json lives in the service-writable data dir, so it is read as
// untrusted input: a size cap before parsing, and at most this many entries.
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CODES = 1000;
// Live codes at once (one per node name). Issuing past it is refused
// (`too_many_codes`) until one expires or is used; nothing is evicted, so a
// flood never silently drops a code the owner is about to type.
const MAX_LIVE_CODES = 100;
const MAX_PAIRINGS = 1000;
const MAX_NONCES = 16;
const MAX_CAPABILITIES = 32;
const CAPABILITY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CODE_HASH_RE = NONCE_RE; // SHA-256 in base64url: 43 characters
const PROFILES = ['agent', 'runbook'];
const CONFIRMS = ['phone', 'console'];
const STATES = ['pending', 'enrolled', 'denied'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (re, v) => typeof v === 'string' && re.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isIssuer = (v) => v === 'console' || isStr(DEVICE_ID_RE, v);

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function nullProto(fields) {
  return Object.assign(Object.create(null), fields);
}

// A stored code → a clean null-prototype copy, or null when malformed.
function cleanCode(c) {
  if (!isPlainObject(c)) return null;
  const { code_hash: hash, node_name: name, expires_at_ms: exp, attempts, by, confirm } = c;
  if (!isStr(CODE_HASH_RE, hash) || !isStr(NODE_NAME_RE, name) || !isCount(exp) || !isCount(attempts) || !isIssuer(by) || !CONFIRMS.includes(confirm)) return null;
  return nullProto({ code_hash: hash, node_name: name, expires_at_ms: exp, attempts, by, confirm });
}

function cleanPairing(p) {
  if (!isPlainObject(p)) return null;
  const caps = p.capabilities;
  const nonces = p.nonces;
  const ok = isStr(PAIRING_ID_RE, p.pairing_id) && isStr(NODE_ID_RE, p.node_id) && isStr(NODE_NAME_RE, p.node_name)
    && PROFILES.includes(p.profile) && isStr(RAW_ED25519_RE, p.public_key) && isStr(HEX_SHA256_RE, p.tls_fingerprint)
    && (p.replaces === null || isStr(NODE_ID_RE, p.replaces)) && CONFIRMS.includes(p.confirm) && STATES.includes(p.state)
    && isCount(p.expires_at_ms) && isTimestamp(p.created_at)
    && Array.isArray(caps) && caps.length <= MAX_CAPABILITIES && caps.every((c) => isStr(CAPABILITY_RE, c))
    && Array.isArray(nonces) && nonces.length <= MAX_NONCES && nonces.every((n) => isStr(NONCE_RE, n));
  if (!ok) return null;
  return nullProto({
    pairing_id: p.pairing_id, node_id: p.node_id, node_name: p.node_name, profile: p.profile, capabilities: [...caps],
    public_key: p.public_key, tls_fingerprint: p.tls_fingerprint, replaces: p.replaces, confirm: p.confirm, state: p.state,
    expires_at_ms: p.expires_at_ms, created_at: p.created_at, nonces: [...nonces]
  });
}

// Keeps only the entries whose key appears once: a duplicated name or id is
// ambiguous, so neither copy is trusted.
function uniqueBy(list, key) {
  const counts = new Map();
  for (const x of list) counts.set(x[key], (counts.get(x[key]) || 0) + 1);
  return list.filter((x) => counts.get(x[key]) === 1);
}

class PairingService {
  constructor({ file, registry, identity, approverStore, frontdoorHost, meshUrl, meshCertFingerprint, alerts = null, auditLedger = null,
    notify = () => {}, now = Date.now, ttlMs = TTL_MS, maxAttempts = MAX_ATTEMPTS, maxLiveCodes = MAX_LIVE_CODES, writeFile = writeFileAtomic } = {}) {
    // Fail closed: every dependency that decides who may enrol is required.
    if (typeof file !== 'string' || file === '') throw new TypeError('PairingService needs its pairing.json path');
    if (!registry || typeof registry.byName !== 'function' || typeof registry.addSigned !== 'function') throw new TypeError('PairingService needs the node registry');
    if (!identity || typeof identity.nodeId !== 'string' || typeof identity.sign !== 'function') throw new TypeError('PairingService needs the front door identity');
    if (!approverStore || typeof approverStore.get !== 'function') throw new TypeError('PairingService needs the admin approver store');
    if (typeof frontdoorHost !== 'string' || frontdoorHost === '') throw new TypeError('PairingService needs the front door host');
    if (typeof meshUrl !== 'string' || meshUrl === '') throw new TypeError('PairingService needs the mesh URL');
    if (typeof meshCertFingerprint !== 'function') throw new TypeError('PairingService needs meshCertFingerprint()');
    this.file = file;
    this.registry = registry;
    this.identity = identity;
    this.approverStore = approverStore;
    this.frontdoorHost = frontdoorHost;
    this.meshUrl = meshUrl;
    this.meshCertFingerprint = meshCertFingerprint;
    this.alerts = alerts;
    this.auditLedger = auditLedger;
    this.notify = notify;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.maxLiveCodes = maxLiveCodes;
    this.writeFile = writeFile;
    this.codes = [];
    this.pairings = new Map();
    // A change in memory that has not reached pairing.json yet (its save
    // threw). The next save writes it; sweep() retries.
    this.dirty = false;
    this._load();
  }

  // Never throws. A file that cannot be read or parsed is moved aside (as
  // for clients.json and tokens.json) and the service starts with no codes
  // and no pairings: the owner issues a new code. Malformed entries in a
  // readable file are dropped one by one.
  _load() {
    let text;
    try {
      const st = fs.statSync(this.file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) {
        this._quarantine(st.isFile() ? `is larger than ${MAX_FILE_BYTES} bytes` : 'is not a file');
        return;
      }
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') this._quarantine(`cannot be read (${e.code || e.message})`);
      return;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!isPlainObject(data) || data.v !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.pairings)) {
      this._quarantine('is not a valid pairing list');
      return;
    }
    // The newest entries (a file is written oldest first).
    const codes = uniqueBy(data.codes.slice(-MAX_CODES).map(cleanCode).filter(Boolean), 'node_name');
    const pairings = uniqueBy(data.pairings.slice(-MAX_PAIRINGS).map(cleanPairing).filter(Boolean), 'pairing_id');
    const dropped = (data.codes.length - codes.length) + (data.pairings.length - pairings.length);
    if (dropped > 0) log.warn(`${this.file}: dropped ${dropped} malformed or duplicate entr${dropped === 1 ? 'y' : 'ies'}`);
    this.codes = codes;
    for (const p of pairings) this.pairings.set(p.pairing_id, p);
  }

  _quarantine(why) {
    const aside = `${this.file}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.file, aside);
      log.error(`${this.file} ${why}; moved it to ${aside} and starting with no pairing codes`);
    } catch (e) {
      // Pairing state is short-lived (10 minutes): starting empty only means
      // the owner issues a new code, so this never stops the front door.
      log.error(`${this.file} ${why} and cannot be moved aside (${e.code || e.message}); starting with no pairing codes`);
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.writeFile(this.file, `${JSON.stringify({ v: 1, codes: this.codes, pairings: [...this.pairings.values()] }, null, 2)}\n`);
    this.dirty = false;
  }

  // Saves, or puts the in-memory change back and rethrows: for changes a
  // retry should simply redo (issuing a code, consuming a good one).
  _commit(undo) {
    try {
      this._save();
    } catch (e) {
      undo();
      throw e;
    }
  }

  // Saves, or keeps the change in memory and marks it dirty: for changes
  // that must hold even when the disk fails (a counted wrong code, a
  // decision already taken).
  _persist() {
    try {
      this._save();
    } catch (e) {
      this.dirty = true;
      log.error(`saving ${this.file} failed (${e.code || e.message}); the change holds in memory and is saved on the next write`);
    }
  }

  // _commit for a decision: on a failed save the decision is undone and
  // refused with a coded error, so the caller retries.
  _commitDecision(p, undo) {
    try {
      this._commit(undo);
    } catch (e) {
      log.error(`saving ${this.file} failed (${e.code || e.message}); the decision on ${p.pairing_id} was not taken`);
      throw err('save_failed', 'the decision could not be saved; try again');
    }
  }

  sweep() {
    const t = this.now();
    this.codes = this.codes.filter((c) => c.expires_at_ms + KEEP_MS > t);
    for (const [id, p] of this.pairings) if (p.expires_at_ms + KEEP_MS < t) this.pairings.delete(id);
    if (this.dirty) this._persist();
  }

  _state(p) {
    return p.state === 'pending' && this.now() > p.expires_at_ms ? 'expired' : p.state;
  }

  // confirm: who turns the pairing into a record — the phone (kl.node.enroll)
  // or the admin console (frontdoor code --confirm). Console-issued codes
  // without --confirm still wait for a phone (§3.11).
  async issue(nodeName, { by, confirm = null } = {}) {
    if (typeof nodeName !== 'string' || !NODE_NAME_RE.test(nodeName)) throw err('bad_node_name', 'node_name must be 1–64 of A–Z, a–z, 0–9, . _ -');
    if (!isIssuer(by)) throw err('bad_issuer', 'a pairing code is issued by an enrolled phone (its device id) or by the console');
    if (confirm !== null && !CONFIRMS.includes(confirm)) throw err('bad_confirm', 'confirm is phone or console');
    this.sweep();
    const t = this.now();
    // A new code for a name replaces that name's code, so it never counts.
    const live = this.codes.filter((c) => c.expires_at_ms >= t && c.node_name !== nodeName);
    if (live.length >= this.maxLiveCodes) {
      const soonest = Math.min(...live.map((c) => c.expires_at_ms));
      throw Object.assign(err('too_many_codes', `at most ${this.maxLiveCodes} pairing codes can be live at once; wait for one to expire`), {
        retryAfterS: Math.max(1, Math.ceil((soonest - t) / 1000))
      });
    }
    const words = [];
    for (let i = 0; i < CODE_WORDS; i += 1) words.push(WORDLIST[crypto.randomInt(WORDLIST.length)]);
    const code = words.join(' ');
    const expiresAt = this.now() + this.ttlMs;
    const before = this.codes;
    this.codes = [...this.codes.filter((c) => c.node_name !== nodeName), nullProto({
      code_hash: pairingCodeHash(code), node_name: nodeName, expires_at_ms: expiresAt, attempts: 0, by, confirm: confirm || (by === 'console' ? 'console' : 'phone')
    })];
    this._commit(() => { this.codes = before; });
    await recordFrontDoorEvent(this.auditLedger, 'frontdoor.pairing.code_issued', { node_name: nodeName, by });
    return { code, expires_at: new Date(expiresAt).toISOString() };
  }

  submit(envelope) {
    // Ruling T2-testkeys: published test node keys only where the admin
    // approver store allows test keys.
    const check = checkNodePair(envelope, { frontdoorHost: this.frontdoorHost, allowTestKeys: this.approverStore.allowTestKeys === true });
    if (!check.ok) return { ok: false, status: 400, reason: check.reason };
    const m = check.message;
    this.sweep();
    const code = this.codes.find((c) => c.node_name === m.node_name);
    if (!code) return { ok: false, status: 403, reason: 'code_rejected' };
    // Ruling T6-pair: during the lockout even the right code is refused.
    if (code.attempts >= this.maxAttempts) return { ok: false, status: 429, reason: 'too_many_attempts' };
    if (this.now() > code.expires_at_ms) return { ok: false, status: 410, reason: 'expired' };
    if (!sameHash(code.code_hash, m.code_hash)) {
      code.attempts += 1;
      this._persist();
      log.info(`a wrong pairing code for ${m.node_name} (${code.attempts}/${this.maxAttempts})`);
      return { ok: false, status: 403, reason: 'code_rejected' };
    }
    // Ruling T28-rename: a key already enrolled under another name would
    // move that node to this name when approved (the registry keys records
    // by node id), silently dropping the old name. The owner removes it first.
    const renamed = this._renameProblem(m.node_id, m.node_name);
    if (renamed) return { ok: false, status: 409, reason: renamed.code, message: renamed.message };
    const existing = this.registry.byName(m.node_name);
    const pairingId = `pr_${crypto.randomBytes(16).toString('base64url')}`;
    const t = this.now();
    let accept;
    try {
      // Built before any state changes, so a failure here consumes nothing.
      accept = buildNodePairAccept({ identity: this.identity, pairingId, nodeId: m.node_id, nonce: m.nonce, meshUrl: this.meshUrl, meshCertFingerprint: this.meshCertFingerprint() });
    } catch (e) {
      log.error(`building the pairing accept failed: ${e.message}`);
      return { ok: false, status: 500, reason: 'internal' };
    }
    const pairing = nullProto({
      pairing_id: pairingId,
      node_id: m.node_id,
      node_name: m.node_name,
      profile: m.profile,
      capabilities: [...m.capabilities],
      public_key: m.public_key,
      tls_fingerprint: check.tlsFingerprint,
      replaces: existing && existing.node_id !== m.node_id ? existing.node_id : null,
      confirm: code.confirm,
      state: 'pending',
      expires_at_ms: t + this.ttlMs,
      created_at: new Date(t).toISOString(),
      nonces: []
    });
    const before = this.codes;
    this.codes = this.codes.filter((c) => c !== code);
    this.pairings.set(pairingId, pairing);
    try {
      // The code is spent only once that is on disk: an accept is never
      // answered for a code a restart would bring back.
      this._commit(() => {
        this.codes = before;
        this.pairings.delete(pairingId);
      });
    } catch (e) {
      log.error(`saving ${this.file} failed (${e.code || e.message}); the pairing code was not spent`);
      return { ok: false, status: 500, reason: 'internal' };
    }
    if (pairing.confirm === 'phone') this._notify(pairingId);
    return { ok: true, status: 200, envelope: accept };
  }

  // An err() when nodeId is enrolled under a name other than nodeName, else null.
  _renameProblem(nodeId, nodeName) {
    const enrolled = this.registry.byId(nodeId);
    if (!enrolled || enrolled.node_name === nodeName) return null;
    return err('key_enrolled_as_other_name', `this node key is already enrolled as "${enrolled.node_name}"; remove ${enrolled.node_name} first, then pair it as "${nodeName}"`);
  }

  _notify(pairingId) {
    try {
      Promise.resolve(this.notify('pairing', pairingId)).catch((e) => log.warn(`pairing push failed: ${e && e.message}`));
    } catch (e) {
      log.warn(`pairing push failed: ${e.message}`);
    }
  }

  status(pairingId) {
    const p = typeof pairingId === 'string' ? this.pairings.get(pairingId) : undefined;
    return p ? { state: this._state(p) } : null;
  }

  pending() {
    const t = this.now();
    return [...this.pairings.values()]
      .filter((p) => p.confirm === 'phone' && this._state(p) === 'pending')
      .map((p) => ({
        pairing_id: p.pairing_id, node_name: p.node_name, node_id: p.node_id, profile: p.profile,
        public_key: p.public_key, tls_fingerprint: p.tls_fingerprint, replaces: p.replaces, expires_in_ms: Math.max(0, p.expires_at_ms - t)
      }));
  }

  async decide(pairingId, envelope, { deviceId } = {}) {
    const p = typeof pairingId === 'string' ? this.pairings.get(pairingId) : undefined;
    if (!p || p.confirm !== 'phone') throw err('unknown_pairing', 'no pairing with that id is waiting for a phone');
    if (p.state !== 'pending') throw err('already_decided', `this pairing is already ${p.state}`);
    const r = checkNodeEnroll(envelope, { approverStore: this.approverStore, frontdoorId: this.identity.nodeId, pairing: { ...p, nonces: new Set(p.nonces) }, now: this.now() });
    if (!r.ok) throw err(r.reason, `the enrollment was refused: ${r.reason}`);
    if (typeof deviceId !== 'string' || r.deviceId !== deviceId) throw err('bad_decision', 'the decision must be signed by the calling phone');
    if (r.message.decision === 'deny') {
      // A deny must survive a restart, or the pairing comes back pending and
      // could be approved later: saved, or rolled back and refused so the
      // phone retries.
      p.state = 'denied';
      p.nonces.push(r.message.nonce);
      this._commitDecision(p, () => {
        p.state = 'pending';
        p.nonces.pop();
      });
      return { state: 'denied' };
    }
    // The registry may have changed since submit (ruling T28-rename).
    const renamed = this._renameProblem(p.node_id, p.node_name);
    if (renamed) throw renamed;
    // The owner signed `replaces` as it was when the node submitted its code.
    // If the name now belongs to a node the owner was not shown (another
    // pairing for the name enrolled since), approving must not remove it.
    const current = this.registry.byName(p.node_name);
    const replacing = current && current.node_id !== p.node_id ? current.node_id : null;
    if (replacing && replacing !== p.replaces) {
      throw err('replaces_changed', `"${p.node_name}" was enrolled by another pairing since this one began; pair the node again`);
    }
    this.registry.addSigned(envelope, { acceptedAt: new Date(this.now()).toISOString() });
    p.state = 'enrolled';
    p.nonces.push(r.message.nonce);
    this._persist();
    await this._enrolled(p, deviceId, replacing);
    return { state: 'enrolled' };
  }

  consolePending(nodeName) {
    const p = [...this.pairings.values()].find((x) => x.confirm === 'console' && x.node_name === nodeName && this._state(x) === 'pending');
    return p ? { ...p, capabilities: [...p.capabilities], nonces: [...p.nonces] } : null;
  }

  async consoleConfirmed(pairingId) {
    const p = typeof pairingId === 'string' ? this.pairings.get(pairingId) : undefined;
    if (!p || p.confirm !== 'console' || this._state(p) !== 'pending') throw err('unknown_pairing', 'no console pairing with that id is pending');
    // Checked on the registry as it was before the reload: once the admin's
    // console record is loaded it carries the new name.
    const renamed = this._renameProblem(p.node_id, p.node_name);
    if (renamed) throw renamed;
    this.registry.load();
    const record = this.registry.byId(p.node_id);
    if (!record || record.source !== 'console') throw err('no_console_record', `no console record for ${p.node_id}: run frontdoor code ${p.node_name} --confirm as an administrator`);
    for (const k of ['node_name', 'profile', 'public_key', 'tls_fingerprint']) {
      if (record[k] !== p[k]) throw err('console_record_mismatch', `the console record for ${p.node_id} does not match this pairing (${k})`);
    }
    p.state = 'enrolled';
    this._persist();
    // The replacement the node's submit recorded: the registry may already
    // have been reloaded (SIGHUP) with the console record in place.
    await this._enrolled(p, 'console', p.replaces);
    return { state: 'enrolled' };
  }

  consoleDeclined(pairingId) {
    const p = typeof pairingId === 'string' ? this.pairings.get(pairingId) : undefined;
    if (!p || p.confirm !== 'console' || p.state !== 'pending') return false;
    p.state = 'denied';
    this._commitDecision(p, () => { p.state = 'pending'; });
    return true;
  }

  async _enrolled(p, by, replaced) {
    if (replaced && this.alerts) {
      try {
        this.alerts.raise('node_replaced', { subject: `node:${replaced}`, detail: { node_name: p.node_name, old_node_id: replaced, new_node_id: p.node_id } });
      } catch (e) {
        log.error(`raising node_replaced failed: ${e.message}`);
      }
    }
    await recordFrontDoorEvent(this.auditLedger, 'frontdoor.node.enrolled', { node_id: p.node_id, node_name: p.node_name, profile: p.profile, pairing_id: p.pairing_id, by });
    if (replaced) await recordFrontDoorEvent(this.auditLedger, 'frontdoor.node.replaced', { node_name: p.node_name, old_node_id: replaced, new_node_id: p.node_id, by });
  }
}

module.exports = { PairingService, TTL_MS };
