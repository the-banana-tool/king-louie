'use strict';

// The grant flow (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.6): turns a
// validated proposal into the phone card, a lease of kind `task`, re-sends it for about an hour,
// and tells the task manager what came of it. It holds no record: the manager writes those.
//
// One handle per task. A card is one request and the lease it makes; at most one is live, and only
// its lease id is listened for. Every answer about a card comes through the `state` event, the
// promise of `request` only for a request refused before any lease existed.

const { createLogger } = require('../logging');
const { TASK_USD_MAX } = require('../gui/lease-protocol');
const { newLeaseId } = require('../gui/leases');
const { plainCut, taskTitle } = require('./values');

const log = createLogger('tasks/grants');

// Twelve cards of five minutes (REQUEST_TTL_MS): about an hour.
const RESEND_LIMIT = 12;
const STOP_REASONS = new Set(['revoked', 'device_revoked']);

// One plain line of at most 60 code points; `Task` when nothing is left.
function taskName(text) {
  return taskTitle(typeof text === 'string' ? text : '');
}

function cardReason(client) {
  const name = plainCut((client && (client.client_name || client.kind)) || '');
  return `Task from ${name || 'a client'}`;
}

// The cap a raise asks for: doubled, far enough to be past what is spent (a sub-agent's bill can
// land all at once), at most TASK_USD_MAX. null when nothing above the spend can be asked for.
function raisedUsd(spend) {
  const spent = spend.usd;
  let next = Math.ceil(spend.cap_usd) * 2;
  while (next <= spent && next < TASK_USD_MAX) next *= 2;
  next = Math.min(next, TASK_USD_MAX);
  return next > spent ? next : null;
}

class GrantHandle {
  constructor({ leases, clock, resendLimit, task, proposal, origin, onChange }) {
    Object.assign(this, { leases, clock, resendLimit, task, origin, onChange });
    this.scope = proposal ? { sites: [...proposal.sites], allows: [...proposal.allows], minutes: proposal.minutes, usd: proposal.usd } : null;
    this.card = null; // { leaseId, scope, raise, granted }
    this.awaiting = false;
    this.left = 0; // cards this round may still send
    this.raising = false;
    this.closed = false;
    this.waiters = [];
    this.listener = (lease) => this._onLease(lease);
    this.leases.on('state', this.listener);
  }

  // What the policy reads, on every call. A lease with no classes (the raise of a look-only task)
  // grants nothing, so the task reads as it did.
  // It changes nothing: finding a revoked device is checkDevice's.
  state() {
    return { awaiting: this.awaiting, grant: this._liveGrant() };
  }

  // A device revoked out of band ends the lease now, and with it the task, through the event.
  checkDevice() {
    if (!this.closed && this.card && this.card.granted) this.leases.checkGrantingDevices();
  }

  // What the card that is out asks, or null.
  askingUsd() {
    return this.awaiting && this.card ? this.card.scope.usd : null;
  }

  _liveGrant() {
    const { card } = this;
    if (this.closed || !card || !card.granted || card.scope.allows.length === 0) return null;
    const lease = this.leases.find(card.leaseId);
    if (!lease || lease.state !== 'active' || this.leases.remainingMs(lease) <= 0) return null;
    return { sites: [...card.scope.sites], allows: [...card.scope.allows] };
  }

  // Resolves with the press, or with whatever else ends the wait. It never rejects.
  wait() {
    if (!this.awaiting) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  // The first round. Nothing to ask for is no card: a look-only task, or no proposal.
  sendFirst() {
    if (!this.scope || this.scope.allows.length === 0) return;
    this.left = this.resendLimit;
    this._send();
  }

  // One more card with what the last one asked, when none is out and no grant is live. `why` when
  // it asks past a cut, so that a card that cannot go or is denied says so. → whether it went.
  resend({ why = null } = {}) {
    if (this.closed || this.awaiting || !this.scope || this._liveCard()) return false;
    if (why) this.raising = why;
    this.left = 1;
    this._send();
    return true;
  }

  // A fresh request, never a change to the lease (spec §4.6): whatever is out or live goes first.
  // `why` is what it asks past: spend_cap, or duration, which asks at the same usd.
  raise({ usd, minutes, why = 'spend_cap' }) {
    if (this.closed) return;
    const old = this.card;
    this.card = null;
    if (old) this.leases.endLease(old.leaseId, 'spend_cap');
    const { sites = [], allows = [] } = this.scope || {};
    this.scope = { sites, allows, minutes: this.scope ? this.scope.minutes : minutes, usd };
    this.raising = why;
    this.left = this.resendLimit;
    this._send();
  }

  // The task is over, or the node stops: the lease goes, and nothing more is told.
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.leases.off('state', this.listener);
    const { card } = this;
    this.card = null;
    this.awaiting = false;
    this._wake();
    if (card) this.leases.endLease(card.leaseId, reason);
  }

  _liveCard() {
    const lease = this.card ? this.leases.find(this.card.leaseId) : null;
    return Boolean(lease) && lease.state !== 'ended';
  }

  _send() {
    const { scope, task } = this;
    const card = { leaseId: newLeaseId(), scope, raise: this.raising, granted: false };
    this.card = card;
    this.awaiting = true;
    this.left -= 1;
    this._tell({ kind: 'card', raise: card.raise });
    this.leases.request({
      jobId: `chat:${task.chat_id}`,
      origin: this.origin,
      minutes: scope.minutes,
      reason: cardReason(task.client),
      kind: 'task',
      task: { name: taskName(task.text), sites: scope.sites, allows: scope.allows, usd: scope.usd },
      leaseId: card.leaseId,
    }).catch((err) => this._refused(card, err));
  }

  // A request refused outright: no phone to ask, or a lease it cannot take. A card that had a
  // lease was answered through the event, and is no longer this.card.
  _refused(card, err) {
    if (this.closed || this.card !== card) return;
    log.warn('a task\'s card was not sent', { taskId: this.task.task_id, code: (err && err.code) || 'error' });
    this.card = null;
    this._settle({ kind: 'unavailable', raise: card.raise, code: (err && err.code) || null });
  }

  _onLease(lease) {
    const { card } = this;
    if (this.closed || !card || lease.leaseId !== card.leaseId) return;
    if (lease.state === 'active') {
      if (!card.granted) this._granted(card, lease);
      return;
    }
    if (lease.state !== 'ended') return;
    this.card = null;
    const reason = lease.endReason;
    if (STOP_REASONS.has(reason)) this._settle({ kind: 'stopped', raise: card.raise });
    else if (card.granted) this._settle({ kind: 'expired', raise: card.raise });
    else if (reason === 'denied') this._settle({ kind: 'denied', raise: card.raise });
    else if (reason !== 'request_expired') this._settle({ kind: 'unavailable', raise: card.raise, code: reason === 'node_identity_invalid' ? 'capability_unavailable' : reason });
    else if (this.left > 0) this._send();
    else this._settle({ kind: 'pending_exhausted', raise: card.raise });
  }

  _granted(card, lease) {
    card.granted = true;
    this.raising = false;
    this._settle({
      kind: 'granted',
      raise: card.raise,
      usd: card.scope.usd,
      grant: {
        lease_id: lease.leaseId,
        granted_at: new Date(this.clock()).toISOString(),
        by_device: lease.grantedBy,
        expires_at: new Date(lease.expiresAt).toISOString(),
      },
    });
  }

  // The manager hears first, so that a waiting call re-decides on what it wrote.
  _settle(change) {
    this.awaiting = false;
    this._tell(change);
    this._wake();
  }

  _tell(change) {
    try {
      this.onChange(change);
    } catch (err) {
      log.warn('a task did not take what came of its card', { taskId: this.task.task_id, kind: change.kind, error: err.message });
    }
  }

  _wake() {
    const { waiters } = this;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

class TaskGrants {
  constructor({ leases, clock = Date.now, resendLimit = RESEND_LIMIT } = {}) {
    if (!leases) throw new TypeError('TaskGrants needs a LeaseManager');
    Object.assign(this, { leases, clock, resendLimit });
  }

  // `proposal` is validated (validateProposal): the phone signs these fields. `origin` is the
  // phone's (approvalOrigin). `card: false` opens a handle that asks nothing yet, for a raise.
  open({ task, proposal, origin, onChange, card = true }) {
    const handle = new GrantHandle({ leases: this.leases, clock: this.clock, resendLimit: this.resendLimit, task, proposal, origin, onChange });
    if (card) handle.sendFirst();
    return handle;
  }
}

module.exports = { TaskGrants, taskName, raisedUsd };
