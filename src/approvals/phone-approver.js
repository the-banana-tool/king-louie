// PhoneApprover (program §4.12): signs a request over the exact action, hands
// it to the relay link, and accepts the first valid phone-signed response.
// Only a verified `approve` for the unchanged action ever resolves `approve`,
// and requestApproval maps only that to `true`.
const { createLogger } = require('../logging');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const {
  buildRequest, buildStatus, toolAction, actionHash, MessageError, TTL_MAX_MS, clampTtl
} = require('./messages');
const { verifyDeviceEnvelope, bytesSha256 } = require('./verify-device');
const { PendingRequests } = require('./pending-store');

const log = createLogger('approvals/phone-approver');

const DEFAULT_UNAVAILABLE = 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.';

class PhoneApprover {
  constructor({ identity, nodeName = null, approverStore, link, auditLedger, ttlMs = TTL_MAX_MS, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, buildRequest: build = buildRequest } = {}) {
    if (!identity || !approverStore || !auditLedger) throw new TypeError('PhoneApprover needs identity, approverStore and auditLedger');
    this.identity = identity;
    this.nodeName = nodeName || identity.nodeName;
    this.approverStore = approverStore;
    this.link = link || null;
    this.auditLedger = auditLedger;
    this.ttlMs = clampTtl(ttlMs);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.build = build;
    this.pendingRequests = new PendingRequests({ now });
    this.stopped = false;
    this._onConnected = () => this._resubmitAll();
    if (this.link && typeof this.link.on === 'function') this.link.on('connected', this._onConnected);
  }

  get nonces() {
    return this.pendingRequests.nonces;
  }

  // Why no request could reach a phone right now, or null. A store nobody
  // has run ready() on yet (or one whose probe failed) must read as
  // unavailable, the same as an empty approver set — never as "0 active
  // devices" dressed up to look like a normal, checked-and-empty set. A
  // stopped approver is unavailable outright. Neither the link's nor the
  // store's own checks are trusted not to throw (a flaky transport, a
  // filesystem error): a throw here must still resolve to a plain
  // "unavailable" reason, never an uncaught exception out of isAvailable()
  // or requestAction().
  unavailableReason() {
    if (this.stopped) return 'the service is stopping';
    if (!this.link) return 'no relay link on this node';
    let delivery;
    try {
      delivery = this.link.canDeliver();
    } catch (err) {
      return `the relay link could not be checked: ${err.message}`;
    }
    if (!delivery || !delivery.ok) return (delivery && delivery.reason) || 'the relay link cannot deliver';
    if (this.approverStore.untrusted) return this.approverStore.problem || 'the approver set has not been verified as admin-owned on this node';
    let activeCount;
    try {
      activeCount = this.approverStore.activeCount();
    } catch (err) {
      return `the approver set could not be checked: ${err.message}`;
    }
    if (activeCount === 0) return 'no enrolled device on this node';
    return null;
  }

  isAvailable() {
    return this.unavailableReason() === null;
  }

  _outcome(decision, { request_id = null, device_id = null, action_hash = null, reason = null } = {}) {
    return { decision, request_id, device_id, action_hash, reason };
  }

  _audit(kind, data) {
    return this.auditLedger.append({ kind, data });
  }

  _auditBestEffort(kind, data) {
    Promise.resolve()
      .then(() => this._audit(kind, data))
      .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
  }

  async requestAction(action, { origin = null, signal = null, currentAction } = {}) {
    if (typeof currentAction !== 'function') throw new TypeError('currentAction required');
    const unavailable = this.unavailableReason();
    if (unavailable) return this._outcome('unavailable', { reason: unavailable });

    let built;
    try {
      built = this.build({ identity: this.identity, action, origin, ttlMs: this.ttlMs, now: this.now() });
    } catch (err) {
      if (err instanceof MessageError) return this._outcome('error', { reason: err.reason });
      throw err;
    }
    const { message, envelope, bytes } = built;
    const ids = { request_id: message.request_id, action_hash: message.action_hash };
    try {
      await this._audit('approval.request', { job_id: message.origin.job_id, envelope });
    } catch (err) {
      log.error(`approval.request not audited, so not sent: ${err.message}`);
      return this._outcome('error', { ...ids, reason: 'audit_unavailable' });
    }
    // stop() may have run while the audit above was in flight (it saw no
    // pending entry yet, so its own sweep never reached this request): check
    // again before this request is ever added to pendingRequests or handed
    // to the link, or a request built just before shutdown could still be
    // submitted, answered and approved after stop().
    if (this.stopped) {
      this._auditBestEffort('approval.outcome', { request_id: message.request_id, state: 'withdrawn', reason: 'the service is stopping', job_id: message.origin.job_id });
      return this._outcome('unavailable', { ...ids, reason: 'the service is stopping' });
    }
    if (signal && signal.aborted) {
      this._auditBestEffort('approval.outcome', { request_id: message.request_id, state: 'withdrawn', reason: null, job_id: message.origin.job_id });
      return this._outcome('withdrawn', ids);
    }

    return new Promise((resolve) => {
      const entry = { request: message, envelope, bytes, currentAction, resolve, signal, timer: null, onAbort: null, deciding: false };
      this.pendingRequests.add(entry);
      const delay = Math.max(0, Date.parse(message.expires_at) - this.now());
      entry.timer = this.setTimer(() => this._finish(message.request_id, 'expired', { statusState: 'expired' }), delay);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
      if (signal) {
        entry.onAbort = () => this._finish(message.request_id, 'withdrawn', { statusState: 'withdrawn' });
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this._submit(entry);
    });
  }

  // While the link is down the request stays pending; `connected` resubmits
  // every unexpired one (R16), since a restarted relay has an empty cache.
  _submit(entry) {
    if (!this.link || !this.link.isConnected()) return;
    Promise.resolve()
      .then(() => this.link.submit(entry.envelope))
      .catch((err) => log.warn(`approval.submit failed; will resubmit on reconnect: ${err.message}`));
  }

  _resubmitAll() {
    for (const entry of this.pendingRequests.list()) {
      if (this.now() <= Date.parse(entry.request.expires_at)) this._submit(entry);
    }
  }

  _sendStatus(requestId, state, deviceId, reason) {
    if (!this.link || !this.link.isConnected()) return;
    let status;
    try {
      status = buildStatus({ identity: this.identity, requestId, state, deviceId, reason, now: this.now() });
    } catch (err) {
      log.warn(`could not build status: ${err.message}`);
      return;
    }
    Promise.resolve()
      .then(() => this.link.status(status))
      .catch((err) => log.warn(`approval.status failed: ${err.message}`));
  }

  // `cause` is what a handleResponse racing this same request through its
  // step-13 audit await should blame once it finds the request gone
  // (withdrawn / stopped / expired); it defaults to `decision`, which is
  // right for the timer (`expired`) and the abort listener (`withdrawn`) —
  // only stop() needs to say something other than its own decision name.
  _finish(requestId, decision, { deviceId = null, reason = null, statusState = null, cause = null } = {}) {
    const entry = this.pendingRequests.take(requestId);
    if (!entry) return;
    entry.finishedCause = cause || decision;
    this.clearTimer(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    this._auditBestEffort('approval.outcome', { request_id: requestId, state: statusState || decision, reason, job_id: entry.request.origin.job_id });
    if (statusState) this._sendStatus(requestId, statusState, deviceId, reason);
    entry.resolve(this._outcome(decision, { request_id: requestId, device_id: deviceId, action_hash: entry.request.action_hash, reason }));
  }

  _reject(envelope, requestId, deviceId, reason) {
    let envelopeSha = null;
    try {
      envelopeSha = sha256b64url(canonicalize(envelope));
    } catch {
      envelopeSha = null;
    }
    this._auditBestEffort('approval.rejected', { request_id: requestId, device_id: deviceId, reason, envelope_sha256: envelopeSha });
    return { accepted: false, reason };
  }

  async handleResponse(envelope) {
    // Nothing is approved after stop(): checked first, ahead of even
    // verifying the envelope, since a stopped approver has no pending
    // requests of its own left to bind this response to anyway.
    if (this.stopped) return this._reject(envelope, null, null, 'stopped');

    // Checks 1–8.
    const verified = verifyDeviceEnvelope(envelope, {
      approverStore: this.approverStore,
      type: 'kl.approval.response',
      nodeId: this.identity.nodeId,
      nonces: this.pendingRequests.nonces
    });
    if (!verified.ok) return this._reject(envelope, null, null, verified.reason);
    const { message, bytes, deviceId } = verified;
    const requestId = message.request_id;

    // 9. Pending (and nobody else is mid-decision on it).
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return this._reject(envelope, requestId, deviceId, 'unknown_request');
    if (entry.deciding) return this._reject(envelope, requestId, deviceId, 'already_decided');
    const req = entry.request;

    // 10. Bound to exactly this request.
    if (message.nonce !== req.nonce) return this._reject(envelope, requestId, deviceId, 'nonce_mismatch');
    if (message.action_hash !== req.action_hash) return this._reject(envelope, requestId, deviceId, 'action_hash_mismatch');
    if (message.expires_at !== req.expires_at) return this._reject(envelope, requestId, deviceId, 'expires_mismatch');

    // 11. Fresh on the node's clock; the phone's signed_at is recorded, never judged.
    if (this.now() > Date.parse(req.expires_at)) return this._reject(envelope, requestId, deviceId, 'expired');

    // 12. The action, rebuilt from live state, is still the one approved.
    let live = null;
    try {
      live = actionHash(entry.currentAction());
    } catch {
      live = null;
    }
    if (live !== message.action_hash) {
      this.pendingRequests.nonces.add(message.nonce, bytesSha256(bytes));
      this._reject(envelope, requestId, deviceId, 'action_changed');
      this._finish(requestId, 'deny', { deviceId, reason: 'action_changed', statusState: 'refused' });
      return { accepted: false, reason: 'action_changed' };
    }

    // 13. Audited before it counts; on failure nothing is consumed and the phone may retry.
    entry.deciding = true;
    try {
      await this._audit('approval.response', { request_id: requestId, device_id: deviceId, decision: message.decision, envelope, job_id: req.origin.job_id });
    } catch (err) {
      entry.deciding = false;
      log.error(`approval.response not audited, so not accepted: ${err.message}`);
      return { accepted: false, reason: 'audit_unavailable' };
    }
    // The request may have been withdrawn (abort), stopped, or timed out on
    // its own timer while the audit above was in flight; report whichever of
    // those actually finished it rather than always guessing 'expired'.
    if (!this.pendingRequests.get(requestId)) return this._reject(envelope, requestId, deviceId, entry.finishedCause || 'expired');
    this.pendingRequests.nonces.add(message.nonce, bytesSha256(bytes));

    // 12 and 11, re-run: the step-13 await can itself take long enough for
    // the live action to change or the deadline to pass before this
    // decision is committed, and the pre-audit checks only proved the
    // request was still good *then*. The post-await hash is the only
    // guarantee the approval covers what will actually run.
    let liveAfterAudit = null;
    try {
      liveAfterAudit = actionHash(entry.currentAction());
    } catch {
      liveAfterAudit = null;
    }
    if (liveAfterAudit !== message.action_hash) {
      this._reject(envelope, requestId, deviceId, 'action_changed');
      this._finish(requestId, 'deny', { deviceId, reason: 'action_changed', statusState: 'refused' });
      return { accepted: false, reason: 'action_changed' };
    }
    if (this.now() > Date.parse(req.expires_at)) {
      this._reject(envelope, requestId, deviceId, 'expired');
      this._finish(requestId, 'expired', { deviceId, statusState: 'expired' });
      return { accepted: false, reason: 'expired' };
    }

    const approved = message.decision === 'approve';
    this._finish(requestId, approved ? 'approve' : 'deny', { deviceId, statusState: approved ? 'approved' : 'denied' });
    return { accepted: true, reason: null };
  }

  // The ToolExecutor requester: returns only true | false | 'timeout' |
  // 'unavailable' (program §3), and on a refusal says why in metadata.refusal.
  async requestApproval(toolName, parameters, metadata = {}) {
    // `metadata = {}` only covers `undefined`; an explicit `null` (a caller
    // that has no metadata object at all) must still be tolerated cleanly —
    // read through `meta`, and only ever write `.refusal` back onto a real
    // object.
    const hasMetadata = metadata !== null && typeof metadata === 'object';
    const meta = hasMetadata ? metadata : {};
    const refuse = (deniedBy, error) => {
      if (hasMetadata) metadata.refusal = { deniedBy, error };
      return 'unavailable';
    };
    let action;
    try {
      action = toolAction(toolName, parameters, meta.workingDirectory || null);
    } catch (err) {
      if (err instanceof MessageError) return refuse('unavailable', `Action cannot be shown on the phone (${err.reason}); nothing ran.`);
      throw err;
    }
    const outcome = await this.requestAction(action, {
      origin: meta.origin || null,
      signal: meta.signal || null,
      // Read live: metadata.workingDirectory at the moment a phone response
      // is being checked against reality, not the value captured when the
      // request was first signed.
      currentAction: () => toolAction(toolName, parameters, meta.workingDirectory || null)
    });
    switch (outcome.decision) {
      case 'approve':
        return true;
      case 'deny':
      case 'withdrawn':
        return false;
      case 'expired':
        return 'timeout';
      case 'error':
        if (outcome.reason === 'audit_unavailable') return refuse('audit', 'Audit ledger unavailable; nothing ran.');
        return refuse('unavailable', `Action cannot be shown on the phone (${outcome.reason}); nothing ran.`);
      default:
        return refuse('unavailable', outcome.reason ? `Phone approval unavailable: ${outcome.reason}. Nothing ran.` : DEFAULT_UNAVAILABLE);
    }
  }

  pending() {
    return this.pendingRequests.list().map((e) => ({ request_id: e.request.request_id, expires_at: e.request.expires_at, summary: e.request.action.summary }));
  }

  stop() {
    this.stopped = true;
    if (this.link && typeof this.link.off === 'function') this.link.off('connected', this._onConnected);
    for (const entry of this.pendingRequests.list()) {
      this._finish(entry.request.request_id, 'unavailable', { reason: 'the service is stopping', statusState: 'withdrawn', cause: 'stopped' });
    }
  }
}

module.exports = { PhoneApprover, DEFAULT_UNAVAILABLE };
