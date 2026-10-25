// src/gui/leases.js
// Computer-use leases (fleet stage 5 spec §3.6): at most one pending, active
// or suspended lease per node, granted by a phone signature, limited to a job,
// a subset of the allowlisted apps and at most 60 minutes on the node clock.
// Memory only: a restart ends them all (fail-closed).
const { EventEmitter } = require('events');
const crypto = require('crypto');
// A lease id: a random UUID v4, as lease-v1 requires.
const LEASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const newLeaseId = () => crypto.randomUUID();
const { performance } = require('perf_hooks');
const { open } = require('../approvals/envelope');
const { NonceCache, bytesSha256 } = require('../approvals/verify-device');
const { createLogger } = require('../logging');
const { GuiError } = require('./errors');
const { TypedBuffer } = require('./text-guard');
const { suspendsLease } = require('./broker');
const { plainLineProblem } = require('../cases/hidden-chars');
const L = require('./lease-protocol');

const NONCE_TTL_MS = 10 * 60 * 1000;
const HISTORY_MAX = 32;
// A lease lasts at most an hour and iOS renews its watch every 20 s, so a
// real lease sees a few hundred control messages.
const CONTROL_NONCES_MAX = 4096;
// R-F5-15 (owner ruling, 2026-10-13): input needs the granting phone to stay
// in touch. A lease's input goes on only while the node has verified a
// signed message from the device that granted it within the contact window
// (gui.lease.contact_s: 120 s, at most CONTACT_MAX_S). Contact is the grant
// itself and a watch from that device that echoes a contact token the node
// issued inside the window and that has not made contact before (a replayed
// watch is refused before it gets here, and another device's watch is not
// contact). When the window lapses the lease is suspended, not ended, with
// this reason; such a watch from the granting device resumes it and never
// moves its expiry. All of it on the node's clock.
//
// Why a token (second security review, finding 3): a watch says nothing
// about when it was signed that the node can believe (the phones take their
// clock from the relay), so a relay could keep watches back and feed them
// in later, one every two minutes, long after the owner stopped looking.
// The node puts a fresh random token in every status and view it signs and
// remembers when it issued each. A phone echoes the newest it has applied,
// so its watch was signed after that token left the node. What is left: a
// relay can still hold one watch for up to the window, so input can go on
// for at most two windows after the phone's last signature, never longer.
const CONTACT_REASON = 'no_contact';
const CONTACT_DEFAULT_S = 120;
const CONTACT_MAX_S = 300;
// A lease issues a token with each status and view; one only counts inside
// the window, so the oldest are forgotten first.
const CONTACT_TOKENS_MAX = 2048;
// R-F5-18: how many ended leases a phone's listing names besides the live one.
const LISTED_ENDED = 4;
// How long a listing may reuse a live lease's newest status before it signs
// a new one (fourth security review): the relay may ask at will, and each
// new status costs a seq and a contact token.
const LIST_RESIGN_MS = 5000;

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
const END_ERROR = { denied: 'lease_denied', request_expired: 'lease_request_expired', revoked: 'lease_revoked', device_revoked: 'lease_revoked', expired: 'lease_expired', job_closed: 'job_closed', node_identity_invalid: 'capability_unavailable' };
// Why a suspended lease ends instead of asking to resume: the
// administrator's record of this node's identity can no longer be trusted
// (fifth security review, finding 4). Another value of a status's free
// `reason`, like device_revoked.
const IDENTITY_REASON = 'node_identity_invalid';
const IDENTITY_MESSAGE = 'gui (node_identity_invalid: the record of this node identity can no longer be trusted; see the service log)';
// Why a lease ends when the device that granted it is no longer an
// enrolled, unrevoked approver, and how often the node looks (an
// administrator's "device revoke" or "device apply" only writes a file).
const GRANTOR_REVOKED_REASON = 'device_revoked';
const GRANTOR_CHECK_MS = 5000;

class LeaseManager extends EventEmitter {
  // jobOpen fails closed (R-F5-7): with none given, no job is open.
  //
  // Two clocks (second security review, finding 9). `clock` is the wall
  // clock: what messages carry and what a phone is shown (expires_at).
  // `monotonic` cannot be set: it only counts time passing. How long ago
  // the granting phone was in touch, how old a contact token is, how much
  // of a lease is left and the input rate are measured on both, and
  // whichever says "over" first is believed: a wall clock set back cannot
  // keep a lease or its contact alive, and one set forward ends them early.
  // (The monotonic clock may stand still while the machine sleeps; the wall
  // clock then shows the time that passed.) A caller that injects only
  // `clock` (tests) gets that one clock for both.
  constructor({ approvals, guiConfig, broker = null, audit = null, nodeName = null, clock = Date.now, monotonic = null,
    timers = { setTimeout, clearTimeout }, jobOpen = () => false, identityProbe = null, log = createLogger('gui/leases') } = {}) {
    super();
    Object.assign(this, { approvals, guiConfig, broker, audit, clock, timers, jobOpen, identityProbe, log });
    this.monotonic = typeof monotonic === 'function' ? monotonic : (clock === Date.now ? () => performance.now() : clock);
    this.nodeName = nodeName || (approvals.identity && approvals.identity.nodeName) || 'unnamed-node';
    this.leases = [];
    this.pending = new Map(); // request_id → { request_id, lease_id, nonce, lease_hash, expires_at, lease, resume, ref, envelope, delivered, timer }
    // A grant answers one request, which lives five minutes: ten is enough.
    this.grantNonces = new NonceCache({ ttlMs: NONCE_TTL_MS, now: clock });
    this._onDown = () => this._relayDown();
    this._onUp = () => this._relayUp();
  }

  setBroker(broker) { this.broker = broker; }

  // null, or why the administrator's record of the node identity cannot be
  // trusted now (identityProbe: probeIdentityRecord, Windows only). A probe
  // that throws proves nothing, so it is a problem too. Logged when the
  // answer changes, like the approver set's probe.
  _identityRecordProblem() {
    if (typeof this.identityProbe !== 'function') return null;
    let problem;
    try {
      problem = this.identityProbe();
    } catch (err) {
      problem = `the administrator's record of this node's identity could not be probed (${err.code || 'error'})`;
    }
    problem = problem || null;
    if (problem !== (this._recordProblem || null)) {
      if (problem) this.log.error(`no new computer-use lease is requested, and a suspended one ends instead of asking to resume: ${problem}. As root or an Administrator find out who could have changed it, run "king-louie-service identity record --replace" and restart the service.`, { reason: 'node_identity_invalid' });
      else this.log.info('the record of this node identity is out of reach of this process again; leases can be requested');
    }
    this._recordProblem = problem;
    return problem;
  }

  _contactWindowMs() {
    const s = Number(this.guiConfig.lease && this.guiConfig.lease.contactS);
    return Math.min(CONTACT_MAX_S, Number.isFinite(s) && s > 0 ? s : CONTACT_DEFAULT_S) * 1000;
  }

  // This instant on both clocks.
  _stamp() {
    return { wall: this.clock(), mono: this.monotonic() };
  }

  // Have `ms` passed since `stamp`, on either clock?
  _passed(stamp, ms) {
    return this.monotonic() - stamp.mono >= ms || this.clock() - stamp.wall >= ms;
  }

  // Is the lease's own time up, on either clock?
  _expired(lease) {
    return lease.expiresAt !== null && (this.clock() >= lease.expiresAt || this.monotonic() >= lease.expiresMono);
  }

  _contactLapsed(lease) {
    return lease.lastContact === null || this._passed(lease.lastContact, this._contactWindowMs());
  }

  // The granting device was heard from now: the window runs from here.
  _noteContact(lease) {
    lease.lastContact = this._stamp();
    this._armContact(lease, this._contactWindowMs());
  }

  // One contact timer a lease, due in `ms`. An unattended take has no
  // contact window (spec 2026-10-24 §6.3): no timer is ever armed for it.
  _armContact(lease, ms) {
    if (lease.unattended === true) return;
    if (lease.contactTimer) this.timers.clearTimeout(lease.contactTimer);
    lease.contactTimer = this._timer(() => this._checkContact(lease), ms);
  }

  // What is left of the contact window, on the clock that has less left.
  _contactLeftMs(lease) {
    const window = this._contactWindowMs();
    if (lease.lastContact === null) return 0;
    return window - Math.max(this.monotonic() - lease.lastContact.mono, this.clock() - lease.lastContact.wall);
  }

  // The window ran out with the lease active: suspended for want of contact,
  // unless the lease's own time is up as well, which ends it as expired. A
  // timer that fires before the window has lapsed on either clock (a coarse
  // or early timer; third security review, finding 3) is armed again for
  // what is left, so the suspension never waits for the next input.
  _checkContact(lease) {
    if (lease.unattended === true || lease.state !== 'active') return;
    if (!this._contactLapsed(lease)) {
      this._armContact(lease, Math.max(1, Math.ceil(this._contactLeftMs(lease))));
      return;
    }
    if (this._expired(lease)) {
      this._audit('lease.expired', lease, { reason: 'expired' });
      this._end(lease, 'expired');
      return;
    }
    this.suspend(lease.leaseId, CONTACT_REASON);
  }

  // A new contact token for a status or view of this lease, remembered with
  // its place in the order of issue and the time on the node's clock.
  mintContactToken(lease) {
    const token = L.newContactToken();
    lease.tokenIssued += 1;
    lease.tokens.set(token, { n: lease.tokenIssued, at: this._stamp() });
    while (lease.tokens.size > CONTACT_TOKENS_MAX) lease.tokens.delete(lease.tokens.keys().next().value);
    return token;
  }

  // Does this watch's token make it contact? Only a token this lease issued,
  // inside the window, that is newer than every token that already made
  // contact: a token is good for one contact, and using one retires the
  // older ones with it (a relay that kept earlier watches back gains
  // nothing by delivering them after a later one).
  _tokenMakesContact(lease, token) {
    if (typeof token !== 'string') return false;
    const issued = lease.tokens.get(token);
    if (!issued || issued.n <= lease.tokenUsedUpTo) return false;
    if (this._passed(issued.at, this._contactWindowMs())) return false;
    lease.tokenUsedUpTo = issued.n;
    return true;
  }

  // A watch from the granting device that echoes a live contact token
  // (verifyWatch): contact. It resumes a lease that was suspended for want
  // of it, unless the lease's own time ran out meanwhile; a lease suspended
  // for any other reason still needs its resume grant.
  _onContact(lease, deviceId) {
    if (lease.state === 'ended' || lease.state === 'pending') return;
    this._noteContact(lease);
    if (lease.state !== 'suspended' || lease.suspendReason !== CONTACT_REASON) return;
    if (this._expired(lease)) {
      this._audit('lease.expired', lease, { reason: 'expired' });
      this._end(lease, 'expired');
      return;
    }
    lease.state = 'active';
    lease.suspendReason = null;
    // What was typed stays (suspend() set it aside as a piece): the field
    // still holds it.
    this._audit('lease.resumed', lease, { reason: 'contact', device_id: deviceId });
    this._status(lease);
  }

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
    // A revoke a phone sent through the relay takes effect as it is staged.
    const store = this.approvals.approverStore;
    if (store && typeof store.onDeviceRevoked === 'function') this._offRevoked = store.onDeviceRevoked(() => this.checkGrantingDevices());
  }

  // Is the device that granted this lease still an enrolled approver that
  // nobody has revoked (a revoke staged from a phone counts)? Anything else
  // is a no, a store that cannot be read or trusted included: the lease
  // rests on that device's signature.
  _grantorActive(lease) {
    try {
      return this.approvals.approverStore.isActive(lease.grantedBy) === true;
    } catch (err) {
      this.log.warn(`approver check failed, treating the granting device as revoked: ${err.message}`);
      return false;
    }
  }

  // Third security review, hardening (b): a lease does not outlive the
  // enrollment of the device that granted it. Every live lease whose
  // granting device is no longer active ends now (release_all, a status,
  // an audit entry), whatever state it is in; a lease still waiting for
  // its first grant has no granting device. Called when a revoke is staged,
  // before every input, and every GRANTOR_CHECK_MS while a lease is live.
  checkGrantingDevices({ refresh = false } = {}) {
    const store = this.approvals.approverStore;
    if (refresh && store && typeof store.refresh === 'function') store.refresh();
    for (const lease of this.leases) {
      if (lease.state === 'ended' || lease.grantedBy === null) continue;
      if (!this._grantorActive(lease)) this._end(lease, GRANTOR_REVOKED_REASON);
    }
  }

  // While the lease lives: look again every GRANTOR_CHECK_MS.
  _armGrantorCheck(lease) {
    if (lease.grantorTimer) this.timers.clearTimeout(lease.grantorTimer);
    lease.grantorTimer = this._timer(() => {
      lease.grantorTimer = null;
      if (lease.state === 'ended') return;
      this.checkGrantingDevices({ refresh: true });
      if (lease.state !== 'ended') this._armGrantorCheck(lease);
    }, GRANTOR_CHECK_MS);
  }

  stop() {
    const relay = this.approvals.relayClient;
    if (relay && typeof relay.off === 'function') {
      relay.off('disconnected', this._onDown);
      relay.off('connected', this._onUp);
    }
    if (this._offRevoked) { this._offRevoked(); this._offRevoked = null; }
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

  // What is left of the lease: the less of what the two clocks say.
  remainingMs(lease) {
    return lease.expiresAt === null ? 0 : Math.max(0, Math.min(lease.expiresAt - this.clock(), lease.expiresMono - this.monotonic()));
  }

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
    // Every entry names the lease's kind; a take's request and grant also say what the
    // phone was asked to approve (spec 2026-10-24 §7.2), its name but never its reason text.
    const data = { job_id: lease ? lease.jobId : null, lease_id: lease ? lease.leaseId : null, kind: lease ? lease.kind : null, ...extra };
    if (lease && lease.kind === 'take' && lease.take && (kind === 'lease.requested' || kind === 'lease.granted')) {
      Object.assign(data, {
        name: lease.take.name,
        sites: Array.isArray(lease.take.sites) ? [...lease.take.sites] : [],
        credentials: lease.take.credentials === true
      });
    }
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

  // kind 'take' (spec 2026-10-24 §6): take = { name, sites, browser,
  // credentials, unattended }, from a session the node started itself only
  // (nodeLocalOrigin), and only while gui.take.enabled is on.
  // leaseId: the id a new lease gets, minted by the caller (newLeaseId) so it
  // knows its own lease without watching events; a fresh one when not given.
  async request({ jobId, origin, appIds, minutes, reason, signal = null, kind = 'computer_use', take = null, nodeLocalOrigin = true, leaseId = null }) {
    // R-F5-7: a lease is bound to a job. A run with neither a job id nor a
    // chat id has none, and is refused before anything else is looked at.
    if (typeof jobId !== 'string' || !jobId) throw new GuiError('job_required', 'this run has no job or chat to bind a lease to');
    if (leaseId !== null && (typeof leaseId !== 'string' || !LEASE_ID_RE.test(leaseId) || this.find(leaseId))) {
      throw new GuiError('invalid_params', '"leaseId" must be a fresh lease id (newLeaseId)');
    }
    if (!L.LEASE_KINDS.includes(kind)) throw new GuiError('invalid_params', `"kind" must be one of ${L.LEASE_KINDS.join(', ')}`);
    const isTake = kind === 'take';
    if (isTake) {
      if (!(this.guiConfig.take && this.guiConfig.take.enabled === true)) throw new GuiError('invalid_params', 'takes are off in node.yaml');
      if (nodeLocalOrigin === false) throw new GuiError('take_requires_local_origin', 'a take is started only from a session this node started itself');
      if (!take || typeof take !== 'object' || Array.isArray(take)) throw new GuiError('invalid_params', 'a take needs its "take" block');
    }
    if (!this.available()) throw new GuiError('approval_unavailable');
    // Fourth security review, finding 1 (R-F5-17): on Windows the service
    // asks again, before every new request, whether it can write the
    // administrator's record of this node's identity. If it now can (or
    // that cannot be told), the record vouches for nothing: no request goes
    // out. A lease that is already running is not ended by this; a suspended
    // one of this job, which this call would have asked to resume, is (as in
    // _sendRequest).
    const recordProblem = this._identityRecordProblem();
    if (recordProblem) {
      const held = this.current();
      if (held && held.jobId === jobId && held.state === 'suspended') this._end(held, IDENTITY_REASON);
      throw new GuiError('capability_unavailable', IDENTITY_MESSAGE);
    }
    const cfg = this.guiConfig;
    if (!Array.isArray(appIds) || appIds.length < 1 || appIds.length > 8 || new Set(appIds).size !== appIds.length
      || appIds.some((id) => !Object.hasOwn(cfg.apps, id))) {
      throw new GuiError('invalid_params', '"apps" must be 1–8 distinct allowlisted app ids');
    }
    const max = isTake ? Math.min(cfg.take.maxMinutes, L.TAKE_MAX_MINUTES) : Math.min(cfg.lease.maxMinutes, L.MAX_MINUTES);
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
    // A lease of another kind is never handed back for this one.
    if (cur && cur.kind !== kind) throw new GuiError('lease_busy', `this job already holds a ${cur.kind} lease`);
    // An active lease of this job and kind is handed back as it is: a given leaseId is then not used.
    if (cur && cur.state === 'active') return cur;
    if (cur && (cur.state === 'pending' || [...this.pending.values()].some((p) => p.ref === cur))) throw new GuiError('lease_pending', 'waiting for the phone');
    let lease = cur;
    if (!lease) {
      lease = {
        leaseId: leaseId || newLeaseId(), jobId, origin, reason: String(reason), requestedApps: [...appIds], maxMinutes: minutes,
        // kind and the take's block as requested; an unattended take has no contact window and never pauses (R-D1-7).
        kind, take: isTake ? take : null, unattended: isTake && take.unattended === true, name: isTake ? take.name : null,
        // expiresAt is on the wall clock (what the phone is shown), expiresMono the same moment on the monotonic one.
        // grantedBy: the device whose grant made this lease (R-F5-15, R-F5-18): the only one that
        // resumes it or keeps it in contact. Any enrolled phone may stop it or watch it.
        apps: [], state: 'pending', locked: false, endReason: null, suspendReason: null, expiresAt: null, expiresMono: null,
        grantedBy: null, grantedByName: null,
        seq: 0, typed: new TypedBuffer(), inputTimes: [], waiters: [], expiryTimer: null, controlNonces: new LeaseNonces(),
        lastContact: null, contactTimer: null, grantorTimer: null,
        // Contact tokens: token → { n, at }; how many were issued; and the
        // newest one that has made contact.
        tokens: new Map(), tokenIssued: 0, tokenUsedUpTo: 0, lastStatus: null
      };
      this.leases.push(lease);
      this._sendRequest(lease, { resume: false, probed: true });
    } else {
      // A suspended lease whose resume request lapsed: ask again.
      this._sendRequest(lease, { resume: true, probed: true });
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

  // Every request is built here, the ones the node sends by itself included
  // (a resume after a suspension, and when the relay link returns), so this
  // is where the record of the node identity is asked about (fifth security
  // review, finding 4; `probed`: request() asked a moment ago). A request it
  // refuses ends the lease. Ended, not left suspended: a record this process
  // can write vouches for nothing until an administrator has written it anew
  // and restarted the service, so a suspended lease would wait for nothing,
  // and would ask again at every reconnect.
  _sendRequest(lease, { resume, probed = false }) {
    if (!probed && this._identityRecordProblem()) {
      this._end(lease, IDENTITY_REASON);
      return;
    }
    const now = this.clock();
    const cfg = this.guiConfig;
    const ids = resume ? lease.apps : lease.requestedApps;
    const maxMinutes = resume ? Math.max(1, Math.ceil(this.remainingMs(lease) / 60000)) : lease.maxMinutes;
    const limits = this.broker && typeof this.broker.capability === 'function' ? this.broker.capability().limits || [] : [];
    const { message, envelope } = L.buildLeaseRequest({
      identity: this.approvals.identity, nodeName: this.nodeName, jobId: lease.jobId,
      apps: ids.map((id) => ({ id, name: cfg.apps[id].name, path: cfg.apps[id].path, processes: cfg.apps[id].processes })),
      maxMinutes, reason: lease.reason, resumes: resume, limits, origin: lease.origin, now, leaseId: lease.leaseId,
      kind: lease.kind, take: lease.take
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
      pending: this.pending, guiApps: this.guiConfig.apps, jobOpen: (jobId) => this._jobIsOpen(jobId), guiMaxMinutes: this.guiConfig.lease.maxMinutes,
      guiTakeMaxMinutes: this.guiConfig.take ? this.guiConfig.take.maxMinutes : L.TAKE_MAX_MINUTES
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
          return this._reply(entry.ref, { state: 'ended', reason: 'job_closed' });
        }
      }
      return { state: 'rejected', reason: r.reason };
    }
    const m = r.message;
    const entry = this.pending.get(m.request_id);
    const lease = entry.ref;
    // R-F5-18: a resume is granted only by the phone that granted the lease
    // (any enrolled phone may refuse one, as any may stop the lease). The
    // request stays open for the granting phone.
    if (entry.resume && m.decision === 'grant' && r.deviceId !== lease.grantedBy) {
      this._audit('lease.rejected', lease, { check: null, reason: 'not_granting_device', device_id: r.deviceId });
      return { state: 'rejected', reason: 'not_granting_device' };
    }
    this.grantNonces.add(m.nonce, bytesSha256(r.bytes));
    this.pending.delete(m.request_id);
    this.timers.clearTimeout(entry.timer);
    if (m.decision === 'deny') {
      this._audit('lease.denied', lease, { request_id: m.request_id, device_id: r.deviceId });
      this._end(lease, 'denied');
      return this._reply(lease, { state: 'ended' });
    }
    if (entry.resume && this._expired(lease)) {
      this._end(lease, 'expired');
      return this._reply(lease, { state: 'ended' });
    }
    lease.apps = [...m.grant.apps];
    if (!entry.resume) {
      lease.grantedBy = r.deviceId;
      lease.grantedByName = this._deviceName(r.deviceId);
      this._armGrantorCheck(lease);
    }
    // The same rule on each clock: a resume never outlives the original lease on either.
    lease.expiresAt = L.effectiveExpiry({ verifiedAt: now, minutes: m.grant.minutes, resumeOf: entry.resume ? lease.expiresAt : null });
    lease.expiresMono = L.effectiveExpiry({ verifiedAt: this.monotonic(), minutes: m.grant.minutes, resumeOf: entry.resume ? lease.expiresMono : null });
    lease.state = 'active';
    lease.suspendReason = null;
    // A resume keeps what was typed, as a piece of unknown place (second
    // security review, finding 7); only a new lease starts with nothing.
    if (entry.resume) lease.typed.navigate();
    else lease.typed.reset();
    this._audit(entry.resume ? 'lease.resumed' : 'lease.granted', lease, {
      request_id: m.request_id, apps: lease.apps, minutes: m.grant.minutes, device_id: r.deviceId
    });
    if (entry.resume && this.broker) this.broker.focusApp(lease.apps).catch(() => {});
    // R-F5-15: the grant is the granting device's first contact.
    this._noteContact(lease);
    this._armExpiry(lease);
    this._settle(lease);
    this._status(lease);
    // The reply carries the status just signed, and with it the first
    // contact token: a phone that fetches nothing by itself (Android) can
    // make contact with its first watch.
    return this._reply(lease, { state: 'active' });
  }

  // What the node answers a grant, a revoke or a watch with: the state in
  // clear (the relay's word to the phone, which never shows it as the
  // lease's state) and the newest status this node signed for the lease,
  // which the phone verifies like any other.
  _reply(lease, answer) {
    return lease && lease.lastStatus ? { ...answer, status: lease.lastStatus } : answer;
  }

  _armExpiry(lease) {
    if (lease.expiryTimer) this.timers.clearTimeout(lease.expiryTimer);
    lease.expiryTimer = this._timer(() => {
      if (lease.state !== 'ended') {
        this._audit('lease.expired', lease, { reason: 'expired' });
        this._end(lease, 'expired');
      }
    }, this.remainingMs(lease));
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
        return this._reply(lease, { state: lease.state });
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
      return this._reply(lease, { state: 'ended' });
    }
    this._audit('lease.revoked', lease, { device_id: r.deviceId, reason: r.message.reason });
    this._end(lease, 'revoked');
    return this._reply(lease, { state: 'ended' });
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
    // R-F5-15: a watch from the device that granted this lease is contact
    // when it echoes a contact token issued inside the window that has not
    // made contact before. Any other watch (another enrolled device's, one
    // with no token, an old one a relay kept back) still asks for frames,
    // which go out only while the lease is active and so only while real
    // contact is being made; it is never contact.
    // Never trust that the expiry timer already ran: a lease whose own time
    // is up ends here, whatever this watch echoes.
    if (lease.state !== 'ended' && lease.state !== 'pending' && this._expired(lease)) {
      this._audit('lease.expired', lease, { reason: 'expired' });
      this._end(lease, 'expired');
    }
    const contact = lease.grantedBy !== null && r.deviceId === lease.grantedBy && lease.state !== 'ended'
      && this._tokenMakesContact(lease, r.message.contact_token);
    this._audit('lease.watch', lease, { device_id: r.deviceId, contact });
    const before = lease.lastStatus;
    if (contact) this._onContact(lease, r.deviceId);
    // Every accepted watch is answered with a status signed now, so the
    // phone always holds a token young enough for its next watch, also
    // while no frames flow (a locked screen, a suspended lease).
    if (lease.lastStatus === before) this._sendStatus(lease);
    return { accepted: true, reason: null, lease, deviceId: r.deviceId, contact, status: lease.lastStatus };
  }

  assertUsable(jobId) {
    const cur = this.current();
    // Review Focus 2: never trust that the expiry timer already ran.
    if (cur && cur.state !== 'pending' && this._expired(cur)) {
      this._audit('lease.expired', cur, { reason: 'expired' });
      this._end(cur, 'expired');
    }
    // R-F5-7: a lease does not outlive its job.
    const held = this.current();
    if (held && !this._jobIsOpen(held.jobId)) this._end(held, 'job_closed');
    // Nor the enrollment of the device that granted it.
    this.checkGrantingDevices();
    const lease = this.current();
    if (!lease || lease.jobId !== jobId) {
      const last = [...this.leases].reverse().find((l) => l.jobId === jobId && l.state === 'ended');
      if (last && last.endReason === 'revoked') throw new GuiError('lease_revoked', 'call RequestLease for a new lease');
      if (last && last.endReason === GRANTOR_REVOKED_REASON) throw new GuiError('lease_revoked', 'the phone that granted this lease is no longer enrolled; call RequestLease for a new lease');
      if (last && last.endReason === 'expired') throw new GuiError('lease_expired', 'call RequestLease for a new lease');
      if (last && last.endReason === 'job_closed') throw new GuiError('job_closed', 'the job this lease belonged to is not open');
      if (last && last.endReason === IDENTITY_REASON) throw new GuiError('capability_unavailable', IDENTITY_MESSAGE);
      throw new GuiError('lease_required', 'call RequestLease first');
    }
    if (lease.state === 'pending') throw new GuiError('lease_pending', 'waiting for the phone');
    // R-F5-15, by the clock itself: never trust that the timer already ran.
    this._checkContact(lease);
    if (lease.state === 'ended') throw new GuiError('lease_expired', 'call RequestLease for a new lease');
    if (lease.state === 'suspended' && lease.suspendReason === CONTACT_REASON) {
      throw new GuiError('lease_suspended_no_contact', 'the phone that granted this lease has not been in touch; input resumes when its owner looks at the live view again');
    }
    if (lease.state === 'suspended') throw new GuiError('lease_suspended', lease.suspendReason);
    if (lease.locked) throw new GuiError('screen_locked');
    return lease;
  }

  chargeInput(lease) {
    // On the monotonic clock: a wall clock set forward frees nothing.
    const now = this.monotonic();
    lease.inputTimes = lease.inputTimes.filter((t) => now - t < 60000);
    if (lease.inputTimes.length >= this.guiConfig.lease.maxInputsPerMinute) {
      throw new GuiError('rate_limited', null, { retryAfter: Math.max(1, Math.ceil((lease.inputTimes[0] + 60000 - now) / 1000)) });
    }
    lease.inputTimes.push(now);
  }

  noteInputOutcome(lease, { code = null, afterMatches = true } = {}) {
    if (lease.state !== 'active') return false;
    // An unattended take is not suspended (suspend() records the event); the input's own refusal still stands.
    if (code && suspendsLease(code)) { this.suspend(lease.leaseId, code); return lease.unattended !== true; }
    if (!code && !afterMatches) { this.suspend(lease.leaseId, 'foreground_changed'); return lease.unattended !== true; }
    return false;
  }

  // Suspends an active lease. One suspended for want of contact is taken
  // over by any other reason that comes up meanwhile (second security
  // review, finding 12): the helper dropping or the relay link going during
  // such a pause used to leave no trace, and the next watch resumed the
  // lease as if nothing had happened. The stronger reason brings its own
  // way back: a resume grant on the phone, and the app focused again.
  // Nothing else replaces a reason already recorded.
  //
  // An unattended take never pauses (R-D1-7, spec 2026-10-24 §6.3): the
  // event is recorded (lease.event) and the lease carries on; no resume
  // request is ever sent for it. What ends a lease still ends it.
  suspend(leaseId, reason) {
    const lease = this.find(leaseId);
    if (!lease) return;
    if (lease.unattended === true) {
      if (lease.state === 'active') this._audit('lease.event', lease, { reason });
      return;
    }
    const takesOver = lease.state === 'suspended' && lease.suspendReason === CONTACT_REASON && reason !== CONTACT_REASON;
    if (lease.state !== 'active' && !takesOver) return;
    lease.state = 'suspended';
    lease.suspendReason = reason;
    // A pause does not empty the field (second security review, finding 7):
    // a value typed half before it and half after must still be seen. What
    // was typed is kept as a piece whose place is unknown, as after any key
    // that moves the caret; this used to be wiped, for every reason.
    lease.typed.navigate();
    if (this.broker) this.broker.releaseAll().catch(() => {});
    this._audit('lease.suspended', lease, takesOver ? { reason, was: CONTACT_REASON } : { reason });
    this._status(lease);
    if (this.remainingMs(lease) <= 0) { this._end(lease, 'expired'); return; }
    const relay = this.approvals.relayClient;
    // No resume request for want of contact: nothing needs approving again,
    // a watch from the granting phone resumes it (R-F5-15).
    if (reason !== 'relay_unreachable' && reason !== CONTACT_REASON && relay && relay.isConnected()) this._sendRequest(lease, { resume: true });
  }

  onHelperDisconnected() {
    const lease = this.current();
    // suspend() decides: an active lease, or one paused only for want of contact.
    if (lease && lease.state !== 'pending') this.suspend(lease.leaseId, 'helper_disconnected');
  }

  setLocked(locked) {
    const lease = this.current();
    if (!lease || lease.locked === locked) return;
    lease.locked = locked;
    this._status(lease);
  }

  _relayDown() {
    const lease = this.current();
    if (lease && lease.state !== 'pending') this.suspend(lease.leaseId, 'relay_unreachable');
  }

  _relayUp() {
    const now = this.clock();
    for (const entry of this.pending.values()) {
      if (!entry.delivered && now <= Date.parse(entry.expires_at)) this._deliver(entry);
    }
    const lease = this.current();
    if (lease && lease.state === 'suspended' && lease.suspendReason !== CONTACT_REASON && ![...this.pending.values()].some((p) => p.ref === lease)) this._sendRequest(lease, { resume: true });
  }

  // Ends one lease by id (a take ends only the lease its own request made).
  endLease(leaseId, reason) {
    const lease = this.find(leaseId);
    if (lease && lease.state !== 'ended') this._end(lease, reason);
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
    if (lease.contactTimer) this.timers.clearTimeout(lease.contactTimer);
    if (lease.grantorTimer) this.timers.clearTimeout(lease.grantorTimer);
    lease.tokens.clear();
    for (const [id, entry] of this.pending) {
      if (entry.ref === lease) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
      }
    }
    if (this.broker) this.broker.releaseAll().catch(() => {});
    if (!['revoked', 'expired', 'denied'].includes(reason)) this._audit('lease.ended', lease, { reason });
    this._settle(lease, new GuiError(END_ERROR[reason] || 'lease_required', END_ERROR[reason] ? (reason === IDENTITY_REASON ? IDENTITY_MESSAGE : null) : reason));
    this._status(lease);
    const ended = this.leases.filter((l) => l.state === 'ended');
    if (ended.length > HISTORY_MAX) this.leases = this.leases.filter((l) => l !== ended[0]);
  }

  // The lease changed: tell the host, and the phones.
  _status(lease) {
    this.emit('state', lease);
    if (this.broker && typeof this.broker.leaseChanged === 'function') this.broker.leaseChanged();
    this._sendStatus(lease);
  }

  // The name an enrolled device goes by in its approver record, when that
  // is one plain line of at most 64 characters; null otherwise (the phones
  // then show the device id).
  _deviceName(deviceId) {
    try {
      const record = this.approvals.approverStore.get(deviceId);
      const name = record && typeof record.name === 'string' ? record.name : '';
      return name && Array.from(name).length <= 64 && plainLineProblem(name) === null ? name : null;
    } catch {
      return null;
    }
  }

  // A status signed now, with a fresh contact token and who granted the
  // lease; kept as the lease's newest, for the reply to a phone's message.
  _signStatus(lease) {
    const contactToken = lease.state === 'ended' ? null : this.mintContactToken(lease);
    const envelope = L.buildLeaseStatus({
      identity: this.approvals.identity, leaseId: lease.leaseId, seq: this.nextSeq(lease), state: lease.state, locked: lease.locked,
      reason: lease.endReason || lease.suspendReason || null, expiresAt: lease.expiresAt,
      contactToken,
      grantedBy: lease.grantedBy ? { deviceId: lease.grantedBy, name: lease.grantedByName } : null,
      kind: lease.kind, unattended: lease.unattended === true, name: lease.name || null, now: this.clock()
    });
    lease.lastStatus = envelope;
    // What that status says, when it was signed and with which token: a listing reuses it while all three still hold.
    lease.lastStatusOf = { says: this._statusSays(lease), at: this._stamp(), token: contactToken };
    return envelope;
  }

  // Everything a status says of a lease besides its seq, its time and its token.
  _statusSays(lease) {
    return JSON.stringify([lease.state, lease.locked, lease.endReason || lease.suspendReason || null, lease.expiresAt, lease.grantedBy, lease.grantedByName]);
  }

  // The status a listing gives for a lease (fourth security review). Every
  // lease.list used to sign a new one, and the relay may call lease.list as
  // often as it likes: each call cost the lease a seq and a contact token,
  // without bound, and enough of them pushed the tokens its phones hold out
  // of memory. So the lease's newest status is given again while it still
  // says what the lease is and, for a lease that has not ended, is under
  // LIST_RESIGN_MS old on both clocks and carries a token that is still
  // known and has not made contact (a phone must always get one it can
  // use). An ended lease's status is never signed again: nothing in it can
  // change. Otherwise a status is signed now.
  _listedStatus(lease) {
    const last = lease.lastStatusOf;
    if (lease.lastStatus && last && last.says === this._statusSays(lease)) {
      if (lease.state === 'ended') return lease.lastStatus;
      const issued = last.token === null ? null : lease.tokens.get(last.token);
      if (issued && issued.n > lease.tokenUsedUpTo && !this._passed(last.at, LIST_RESIGN_MS)) return lease.lastStatus;
    }
    return this._signStatus(lease);
  }

  // That status, sent to the phones. Nothing is signed while the relay link
  // is down: nobody could receive it.
  _sendStatus(lease) {
    const relay = this.approvals.relayClient;
    if (!relay || !relay.isConnected()) return;
    relay.send(this._signStatus(lease)).catch((err) => this.log.debug(`lease status not sent: ${err.message}`));
  }

  // An enrolled, real, unrevoked device of this node; false when that cannot be read.
  _enrolled(deviceId) {
    return L.isEnrolledDevice(this.approvals.approverStore, deviceId);
  }

  // R-F5-18: what a phone asks for when it opens (one signed request to the
  // relay, which names the device it authenticated): a status for the live
  // lease, if there is one (signed now, or its newest when that is a few
  // seconds old: _listedStatus), and for the few that ended last,
  // so a phone that granted nothing, or was restarted, can show a lease
  // that is running and stop it, and learns from the node's own signature
  // that one it knew has ended. Only for a device enrolled here and not
  // revoked; anyone else gets nothing. Answered to the asker, not
  // broadcast. The relay's word for who asks decides only whether this is
  // answered: the statuses say nothing the phones of this node are not sent
  // anyway, and what a phone does with one (watch, stop) it signs itself.
  listFor(deviceId) {
    if (!this._enrolled(deviceId)) return [];
    const live = this.current();
    const ended = this.leases.filter((l) => l.state === 'ended').slice(-LISTED_ENDED).reverse();
    return [...(live ? [live] : []), ...ended].map((lease) => this._listedStatus(lease));
  }

  // R-F5-20 (owner ruling, 2026-10-13): a relay cannot hide a live lease
  // from a phone. The phone puts a nonce it chose for this request in the
  // request it signs; the node answers with the statuses above and a listing
  // it signs over that nonce, that phone and exactly those statuses (each
  // lease by its id and the seq just signed), also when there are none. A
  // relay can then neither drop an entry nor replay an earlier "nothing":
  // the phone accepts the answer whole or not at all. The nonce is not
  // remembered here: it is the phone that needs it to be fresh. No nonce (an
  // older relay or phone) gives the statuses alone, and a device that is
  // not enrolled here gets nothing, as before.
  listingFor(deviceId, nonce) {
    const statuses = this.listFor(deviceId);
    if (!this._enrolled(deviceId) || typeof nonce !== 'string' || !L.LIST_NONCE_RE.test(nonce)) return { statuses, listing: null };
    return { statuses, listing: L.buildLeaseListing({ identity: this.approvals.identity, toDevice: deviceId, nonce, statuses, now: this.clock() }) };
  }
}

module.exports = { LeaseManager, newLeaseId, CONTACT_REASON, CONTACT_MAX_S, GRANTOR_REVOKED_REASON, GRANTOR_CHECK_MS, LIST_RESIGN_MS };
