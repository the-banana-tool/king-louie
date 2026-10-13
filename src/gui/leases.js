// src/gui/leases.js
// Computer-use leases (fleet stage 5 spec §3.6): at most one pending, active
// or suspended lease per node, granted by a phone signature, limited to a job,
// a subset of the allowlisted apps and at most 60 minutes on the node clock.
// Memory only: a restart ends them all (fail-closed).
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { open } = require('../approvals/envelope');
const { NonceCache, bytesSha256 } = require('../approvals/verify-device');
const { createLogger } = require('../logging');
const { GuiError } = require('./errors');
const { TypedBuffer } = require('./text-guard');
const { suspendsLease } = require('./broker');
const L = require('./lease-protocol');

const NONCE_TTL_MS = 10 * 60 * 1000;
const HISTORY_MAX = 32;
// A lease lasts at most an hour and iOS renews its watch every 20 s, so a
// real lease sees a few hundred control messages.
const CONTROL_NONCES_MAX = 4096;

// The nonces of the watches and revokes one lease has accepted (security
// review finding 5). Those messages carry no validity window of their own,
// so a nonce is remembered for as long as the lease record is, not for ten
// minutes: a relay that kept a watch can never play it again for that lease.
// Same answers as NonceCache#get, so verifyDeviceEnvelope's check 8 applies.
class LeaseNonces {
  constructor(max = CONTROL_NONCES_MAX) {
    this.max = max;
    this.seen = new Map(); // nonce → sha256 of the bytes it came with
  }

  get(nonce) {
    const sha256 = this.seen.get(nonce);
    return sha256 === undefined ? null : { sha256 };
  }

  get full() { return this.seen.size >= this.max; }

  add(nonce, sha256) { this.seen.set(nonce, sha256); }
}
const NO_NONCES = Object.freeze({ get: () => null });
const END_ERROR = { denied: 'lease_denied', request_expired: 'lease_request_expired', revoked: 'lease_revoked', expired: 'lease_expired', job_closed: 'job_closed' };

class LeaseManager extends EventEmitter {
  // jobOpen fails closed (R-F5-7): with none given, no job is open.
  constructor({ approvals, guiConfig, broker = null, audit = null, nodeName = null, clock = Date.now,
    timers = { setTimeout, clearTimeout }, jobOpen = () => false, log = createLogger('gui/leases') } = {}) {
    super();
    Object.assign(this, { approvals, guiConfig, broker, audit, clock, timers, jobOpen, log });
    this.nodeName = nodeName || (approvals.identity && approvals.identity.nodeName) || 'unnamed-node';
    this.leases = [];
    this.pending = new Map(); // request_id → { request_id, lease_id, nonce, lease_hash, expires_at, lease, resume, ref, envelope, delivered, timer }
    // A grant answers one request, which lives five minutes: ten is enough.
    this.grantNonces = new NonceCache({ ttlMs: NONCE_TTL_MS, now: clock });
    this._onDown = () => this._relayDown();
    this._onUp = () => this._relayUp();
  }

  setBroker(broker) { this.broker = broker; }

  // The nonce store for a control message: the one of the lease it names
  // (read before anything is verified; an unknown lease is refused by the
  // verifier whatever store it gets).
  _controlNonces(envelope) {
    let claimed = null;
    try { claimed = open(envelope).message; } catch { claimed = null; }
    const lease = claimed && typeof claimed.lease_id === 'string' ? this.find(claimed.lease_id) : null;
    return lease ? lease.controlNonces : NO_NONCES;
  }

  setJobOpen(fn) { this.jobOpen = fn; }

  // Only `true` is open; a check that throws (a store that cannot be read) is closed.
  _jobIsOpen(jobId) {
    try {
      return this.jobOpen(jobId) === true;
    } catch (err) {
      this.log.warn(`job check for ${jobId} failed, treating the job as closed: ${err.message}`);
      return false;
    }
  }

  start() {
    const relay = this.approvals.relayClient;
    if (relay && typeof relay.on === 'function') {
      relay.on('disconnected', this._onDown);
      relay.on('connected', this._onUp);
    }
  }

  stop() {
    const relay = this.approvals.relayClient;
    if (relay && typeof relay.off === 'function') {
      relay.off('disconnected', this._onDown);
      relay.off('connected', this._onUp);
    }
    this.stopAll('service_stopped');
  }

  available() {
    const { relayClient, phoneApprover } = this.approvals;
    return Boolean(relayClient && phoneApprover && phoneApprover.isAvailable());
  }

  current() { return this.leases.find((l) => l.state !== 'ended') || null; }

  find(leaseId) { return this.leases.find((l) => l.leaseId === leaseId) || null; }

  active(jobId) {
    const l = this.current();
    return l && l.jobId === jobId && l.state === 'active' ? l : null;
  }

  remainingMs(lease) { return lease.expiresAt === null ? 0 : Math.max(0, lease.expiresAt - this.clock()); }

  nextSeq(lease) { lease.seq += 1; return lease.seq; }

  statusSummary() {
    const l = this.current();
    if (!l) return null;
    return { active: l.state === 'active', appIds: [...l.apps], expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt).toISOString() };
  }

  // The entry is handed to the ledger at once, so entries keep the order of
  // the calls; only its settling is left to a promise.
  _audit(kind, lease, extra = {}) {
    if (!this.audit) return;
    const data = { job_id: lease ? lease.jobId : null, lease_id: lease ? lease.leaseId : null, ...extra };
    const failed = (err) => this.log.warn(`audit ${kind} failed: ${err.message}`);
    try {
      Promise.resolve(this.audit.append({ kind, data })).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  _timer(fn, ms) {
    const t = this.timers.setTimeout(fn, Math.max(0, ms));
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  async request({ jobId, origin, appIds, minutes, reason, signal = null }) {
    // R-F5-7: a lease is bound to a job. A run with neither a job id nor a
    // chat id has none, and is refused before anything else is looked at.
    if (typeof jobId !== 'string' || !jobId) throw new GuiError('job_required', 'this run has no job or chat to bind a lease to');
    if (!this.available()) throw new GuiError('approval_unavailable');
    const cfg = this.guiConfig;
    if (!Array.isArray(appIds) || appIds.length < 1 || appIds.length > 8 || new Set(appIds).size !== appIds.length
      || appIds.some((id) => !Object.hasOwn(cfg.apps, id))) {
      throw new GuiError('invalid_params', '"apps" must be 1–8 distinct allowlisted app ids');
    }
    const max = Math.min(cfg.lease.maxMinutes, 60);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > max) throw new GuiError('invalid_params', `"minutes" must be 1–${max}`);
    // R-F5-7: a job that is not known to be open gets no lease; nothing is sent.
    if (!this._jobIsOpen(jobId)) throw new GuiError('job_closed', 'that job is not open on this node');
    let cur = this.current();
    // A lease whose own job is gone must not hold the node's one lease.
    if (cur && cur.jobId !== jobId && !this._jobIsOpen(cur.jobId)) {
      this._end(cur, 'job_closed');
      cur = null;
    }
    if (cur && cur.jobId !== jobId) throw new GuiError('lease_busy', 'another job holds this node\'s lease');
    if (cur && cur.state === 'active') return cur;
    if (cur && (cur.state === 'pending' || [...this.pending.values()].some((p) => p.ref === cur))) throw new GuiError('lease_pending', 'waiting for the phone');
    let lease = cur;
    if (!lease) {
      lease = {
        leaseId: crypto.randomUUID(), jobId, origin, reason: String(reason), requestedApps: [...appIds], maxMinutes: minutes,
        apps: [], state: 'pending', locked: false, endReason: null, suspendReason: null, expiresAt: null, deviceId: null,
        seq: 0, typed: new TypedBuffer(), inputTimes: [], waiters: [], expiryTimer: null, controlNonces: new LeaseNonces()
      };
      this.leases.push(lease);
      this._sendRequest(lease, { resume: false });
    } else {
      // A suspended lease whose resume request lapsed: ask again.
      this._sendRequest(lease, { resume: true });
    }
    return this._wait(lease, signal);
  }

  _wait(lease, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      lease.waiters.push(waiter);
      if (signal) {
        const onAbort = () => {
          lease.waiters = lease.waiters.filter((w) => w !== waiter);
          reject(new GuiError('cancelled', 'the request stays with the phone'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  _settle(lease, err = null) {
    const waiters = lease.waiters;
    lease.waiters = [];
    for (const w of waiters) (err ? w.reject(err) : w.resolve(lease));
  }

  _sendRequest(lease, { resume }) {
    const now = this.clock();
    const cfg = this.guiConfig;
    const ids = resume ? lease.apps : lease.requestedApps;
    const maxMinutes = resume ? Math.max(1, Math.ceil(this.remainingMs(lease) / 60000)) : lease.maxMinutes;
    const limits = this.broker && typeof this.broker.capability === 'function' ? this.broker.capability().limits || [] : [];
    const { message, envelope } = L.buildLeaseRequest({
      identity: this.approvals.identity, nodeName: this.nodeName, jobId: lease.jobId,
      apps: ids.map((id) => ({ id, name: cfg.apps[id].name, path: cfg.apps[id].path, processes: cfg.apps[id].processes })),
      maxMinutes, reason: lease.reason, resumes: resume, limits, origin: lease.origin, now, leaseId: lease.leaseId
    });
    const entry = {
      request_id: message.request_id, lease_id: message.lease_id, nonce: message.nonce, lease_hash: message.lease_hash,
      expires_at: message.expires_at, lease: message.lease, resume, ref: lease, envelope, delivered: false
    };
    entry.timer = this._timer(() => this._requestExpired(entry), L.REQUEST_TTL_MS);
    this.pending.set(entry.request_id, entry);
    this._audit('lease.requested', lease, { request_id: entry.request_id, apps: ids, minutes: maxMinutes, resumes: resume ? lease.leaseId : null });
    this._deliver(entry);
    this._status(lease);
  }

  _deliver(entry) {
    const relay = this.approvals.relayClient;
    if (!relay || !relay.isConnected()) return;
    relay.send(entry.envelope, { push: { kind: 'lease', id: entry.request_id, expires_at: entry.expires_at } })
      .then(() => { entry.delivered = true; })
      .catch((err) => this.log.info(`lease request held until the relay link returns: ${err.message}`));
  }

  _requestExpired(entry) {
    if (!this.pending.has(entry.request_id)) return;
    this.pending.delete(entry.request_id);
    const lease = entry.ref;
    this._audit('lease.expired', lease, { request_id: entry.request_id, reason: 'request_expired' });
    if (lease.state === 'pending') this._end(lease, 'request_expired');
    else this._settle(lease, new GuiError('lease_request_expired'));
  }

  onGrant(envelope) {
    const now = this.clock();
    const r = L.verifyLeaseGrant(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this.grantNonces,
      pending: this.pending, guiApps: this.guiConfig.apps, jobOpen: (jobId) => this._jobIsOpen(jobId), guiMaxMinutes: this.guiConfig.lease.maxMinutes
    }, now);
    if (!r.accepted) {
      let claimed = null;
      try { claimed = open(envelope).message; } catch { claimed = null; }
      this._audit('lease.rejected', claimed ? this.find(claimed.lease_id) : null, { check: r.check, reason: r.reason });
      // R-F5-7: a closed job cannot come back, so its pending lease ends here
      // instead of waiting out the request. job_closed is part of check 12,
      // which runs only after the device signature, the nonce and the
      // request binding (checks 1–11) held, so only an enrolled device's
      // answer to this very request gets this far.
      if (r.reason === 'job_closed') {
        const entry = claimed ? this.pending.get(claimed.request_id) : null;
        if (entry) {
          this._end(entry.ref, 'job_closed');
          return { state: 'ended', reason: 'job_closed' };
        }
      }
      return { state: 'rejected', reason: r.reason };
    }
    const m = r.message;
    this.grantNonces.add(m.nonce, bytesSha256(r.bytes));
    const entry = this.pending.get(m.request_id);
    this.pending.delete(m.request_id);
    this.timers.clearTimeout(entry.timer);
    const lease = entry.ref;
    lease.deviceId = r.deviceId;
    if (m.decision === 'deny') {
      this._audit('lease.denied', lease, { request_id: m.request_id, device_id: r.deviceId });
      this._end(lease, 'denied');
      return { state: 'ended' };
    }
    if (entry.resume && lease.expiresAt !== null && now >= lease.expiresAt) {
      this._end(lease, 'expired');
      return { state: 'ended' };
    }
    lease.apps = [...m.grant.apps];
    lease.expiresAt = L.effectiveExpiry({ verifiedAt: now, minutes: m.grant.minutes, resumeOf: entry.resume ? lease.expiresAt : null });
    lease.state = 'active';
    lease.suspendReason = null;
    lease.typed.reset();
    this._audit(entry.resume ? 'lease.resumed' : 'lease.granted', lease, {
      request_id: m.request_id, apps: lease.apps, minutes: m.grant.minutes, device_id: r.deviceId
    });
    if (entry.resume && this.broker) this.broker.focusApp(lease.apps).catch(() => {});
    this._armExpiry(lease);
    this._settle(lease);
    this._status(lease);
    return { state: 'active' };
  }

  _armExpiry(lease) {
    if (lease.expiryTimer) this.timers.clearTimeout(lease.expiryTimer);
    lease.expiryTimer = this._timer(() => {
      if (lease.state !== 'ended') {
        this._audit('lease.expired', lease, { reason: 'expired' });
        this._end(lease, 'expired');
      }
    }, lease.expiresAt - this.clock());
  }

  onRevoke(envelope) {
    let claimed = null;
    try { claimed = open(envelope).message; } catch { claimed = null; }
    const r = L.verifyLeaseRevoke(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this._controlNonces(envelope),
      knownLease: (id) => Boolean(this.find(id))
    });
    if (!r.accepted) {
      const lease = claimed ? this.find(claimed.lease_id) : null;
      if (r.reason === 'replay' && lease) {
        this._status(lease);
        return { state: lease.state };
      }
      this._audit('lease.rejected', lease, { check: r.check, reason: r.reason });
      return { state: 'rejected', reason: r.reason };
    }
    const lease = this.find(r.message.lease_id);
    // A revoke is never refused for a full store: playing one again only
    // ends a lease that has ended.
    if (!lease.controlNonces.full) lease.controlNonces.add(r.message.nonce, bytesSha256(r.bytes));
    if (lease.state === 'ended') {
      this._status(lease);
      return { state: 'ended' };
    }
    this._audit('lease.revoked', lease, { device_id: r.deviceId, reason: r.message.reason });
    this._end(lease, 'revoked');
    return { state: 'ended' };
  }

  verifyWatch(envelope) {
    const r = L.verifyLeaseWatch(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this._controlNonces(envelope),
      knownLease: (id) => Boolean(this.find(id))
    });
    if (!r.accepted) return { accepted: false, reason: r.reason };
    const lease = this.find(r.message.lease_id);
    // A watch that cannot be remembered could be played again: refused.
    if (lease.controlNonces.full) return { accepted: false, reason: 'too_many_watches' };
    lease.controlNonces.add(r.message.nonce, bytesSha256(r.bytes));
    this._audit('lease.watch', lease, { device_id: r.deviceId });
    return { accepted: true, reason: null, lease, deviceId: r.deviceId };
  }

  assertUsable(jobId) {
    const now = this.clock();
    const cur = this.current();
    // Review Focus 2: never trust that the expiry timer already ran.
    if (cur && cur.expiresAt !== null && now >= cur.expiresAt && cur.state !== 'pending') {
      this._audit('lease.expired', cur, { reason: 'expired' });
      this._end(cur, 'expired');
    }
    // R-F5-7: a lease does not outlive its job.
    const held = this.current();
    if (held && !this._jobIsOpen(held.jobId)) this._end(held, 'job_closed');
    const lease = this.current();
    if (!lease || lease.jobId !== jobId) {
      const last = [...this.leases].reverse().find((l) => l.jobId === jobId && l.state === 'ended');
      if (last && last.endReason === 'revoked') throw new GuiError('lease_revoked', 'call RequestLease for a new lease');
      if (last && last.endReason === 'expired') throw new GuiError('lease_expired', 'call RequestLease for a new lease');
      if (last && last.endReason === 'job_closed') throw new GuiError('job_closed', 'the job this lease belonged to is not open');
      throw new GuiError('lease_required', 'call RequestLease first');
    }
    if (lease.state === 'pending') throw new GuiError('lease_pending', 'waiting for the phone');
    if (lease.state === 'suspended') throw new GuiError('lease_suspended', lease.suspendReason);
    if (lease.locked) throw new GuiError('screen_locked');
    return lease;
  }

  chargeInput(lease) {
    const now = this.clock();
    lease.inputTimes = lease.inputTimes.filter((t) => now - t < 60000);
    if (lease.inputTimes.length >= this.guiConfig.lease.maxInputsPerMinute) {
      throw new GuiError('rate_limited', null, { retryAfter: Math.max(1, Math.ceil((lease.inputTimes[0] + 60000 - now) / 1000)) });
    }
    lease.inputTimes.push(now);
  }

  noteInputOutcome(lease, { code = null, afterMatches = true } = {}) {
    if (lease.state !== 'active') return false;
    if (code && suspendsLease(code)) { this.suspend(lease.leaseId, code); return true; }
    if (!code && !afterMatches) { this.suspend(lease.leaseId, 'foreground_changed'); return true; }
    return false;
  }

  suspend(leaseId, reason) {
    const lease = this.find(leaseId);
    if (!lease || lease.state !== 'active') return;
    lease.state = 'suspended';
    lease.suspendReason = reason;
    lease.typed.reset();
    if (this.broker) this.broker.releaseAll().catch(() => {});
    this._audit('lease.suspended', lease, { reason });
    this._status(lease);
    if (this.remainingMs(lease) <= 0) { this._end(lease, 'expired'); return; }
    const relay = this.approvals.relayClient;
    if (reason !== 'relay_unreachable' && relay && relay.isConnected()) this._sendRequest(lease, { resume: true });
  }

  onHelperDisconnected() {
    const lease = this.current();
    if (lease && lease.state === 'active') this.suspend(lease.leaseId, 'helper_disconnected');
  }

  setLocked(locked) {
    const lease = this.current();
    if (!lease || lease.locked === locked) return;
    lease.locked = locked;
    this._status(lease);
  }

  _relayDown() {
    const lease = this.current();
    if (lease && lease.state === 'active') this.suspend(lease.leaseId, 'relay_unreachable');
  }

  _relayUp() {
    const now = this.clock();
    for (const entry of this.pending.values()) {
      if (!entry.delivered && now <= Date.parse(entry.expires_at)) this._deliver(entry);
    }
    const lease = this.current();
    if (lease && lease.state === 'suspended' && ![...this.pending.values()].some((p) => p.ref === lease)) this._sendRequest(lease, { resume: true });
  }

  endForJob(jobId, reason = 'job_closed') {
    for (const lease of this.leases) if (lease.jobId === jobId && lease.state !== 'ended') this._end(lease, reason);
  }

  stopAll(reason = 'service_stopped') {
    for (const lease of this.leases) if (lease.state !== 'ended') this._end(lease, reason);
  }

  _end(lease, reason) {
    if (lease.state === 'ended') return;
    lease.state = 'ended';
    lease.endReason = reason;
    if (lease.expiryTimer) this.timers.clearTimeout(lease.expiryTimer);
    for (const [id, entry] of this.pending) {
      if (entry.ref === lease) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
      }
    }
    if (this.broker) this.broker.releaseAll().catch(() => {});
    if (!['revoked', 'expired', 'denied'].includes(reason)) this._audit('lease.ended', lease, { reason });
    this._settle(lease, new GuiError(END_ERROR[reason] || 'lease_required', END_ERROR[reason] ? null : reason));
    this._status(lease);
    const ended = this.leases.filter((l) => l.state === 'ended');
    if (ended.length > HISTORY_MAX) this.leases = this.leases.filter((l) => l !== ended[0]);
  }

  _status(lease) {
    const relay = this.approvals.relayClient;
    this.emit('state', lease);
    if (this.broker && typeof this.broker.leaseChanged === 'function') this.broker.leaseChanged();
    if (!relay || !relay.isConnected()) return;
    const envelope = L.buildLeaseStatus({
      identity: this.approvals.identity, leaseId: lease.leaseId, seq: this.nextSeq(lease), state: lease.state, locked: lease.locked,
      reason: lease.endReason || lease.suspendReason || null, expiresAt: lease.expiresAt, now: this.clock()
    });
    relay.send(envelope).catch((err) => this.log.debug(`lease status not sent: ${err.message}`));
  }
}

module.exports = { LeaseManager };
