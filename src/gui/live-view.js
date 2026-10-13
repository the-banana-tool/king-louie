// src/gui/live-view.js
// The phone's live lease view (fleet stage 5 spec §3.7): frames only while a
// phone watches and the lease is active and unlocked, at most one capture per
// second in total, each view ≤ 256 KiB. Frames are never stored or audited;
// each view carries the frame's sha256.
const { createLogger } = require('../logging');
const L = require('./lease-protocol');

const ACTIONS_KEPT = 200;
const ACTIONS_PER_VIEW = 50;
const MIN_FRAME_GAP_MS = 1000;

class LiveView {
  constructor({ leases, broker, identity, relayClient, guiConfig, clock = Date.now, log = createLogger('gui/live-view'), watchMs = 60000, tickMs = 250 } = {}) {
    Object.assign(this, { leases, broker, identity, relayClient, guiConfig, clock, log, watchMs, tickMs });
    this.watchers = new Map(); // deviceId → { leaseId, until, cursor, lastFrameAt }
    this.actions = new Map(); // leaseId → [action]
    this.nextAction = 1;
    this.lastCaptureAt = -Infinity;
    this.inputPending = new Set();
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => { this.tick().catch((err) => this.log.warn(`live view tick failed: ${err.message}`)); }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.watchers.clear();
  }

  onWatch(envelope) {
    const r = this.leases.verifyWatch(envelope);
    if (!r.accepted) return { state: 'rejected', reason: r.reason };
    // The reply carries the status the node just signed (its contact token
    // is what the phone's next watch echoes); `state` beside it is in clear.
    const reply = { state: r.lease.state, ...(r.lease.state === 'suspended' && r.lease.suspendReason ? { reason: r.lease.suspendReason } : {}), ...(r.status ? { status: r.status } : {}) };
    const list = this.actions.get(r.lease.leaseId) || [];
    const lastSeq = list.length ? list[list.length - 1].seq : 0;
    const existing = this.watchers.get(r.deviceId);
    this.watchers.set(r.deviceId, {
      leaseId: r.lease.leaseId, until: this.clock() + this.watchMs,
      cursor: existing && existing.leaseId === r.lease.leaseId ? existing.cursor : Math.max(0, lastSeq - ACTIONS_KEPT),
      lastFrameAt: existing && existing.leaseId === r.lease.leaseId ? existing.lastFrameAt : -Infinity
    });
    return reply;
  }

  recordAction(lease, { tool, summary, result }) {
    const action = { seq: this.nextAction, at: new Date(this.clock()).toISOString(), tool: String(tool).slice(0, 32), summary: String(summary).slice(0, 120), result: String(result).slice(0, 80) };
    this.nextAction += 1;
    const list = this.actions.get(lease.leaseId) || [];
    list.push(action);
    while (list.length > ACTIONS_KEPT) list.shift();
    this.actions.set(lease.leaseId, list);
    this.inputPending.add(lease.leaseId);
    return action;
  }

  async _capture() {
    const cfg = this.guiConfig.liveView;
    const lease = this.leases.current();
    let shot = await this.broker.captureFrame({ appIds: lease.apps, maxWidth: cfg.maxWidth, quality: cfg.quality });
    if (!shot || !shot.appId) return { appId: null, frame: null, dropped: false };
    if (shot.bytes > cfg.maxFrameBytes) {
      shot = await this.broker.captureFrame({ appIds: lease.apps, maxWidth: cfg.maxWidth, quality: Math.max(10, cfg.quality - 20) });
      if (!shot || !shot.appId) return { appId: null, frame: null, dropped: false };
      if (shot.bytes > cfg.maxFrameBytes) return { appId: shot.appId, frame: null, dropped: true };
    }
    return { appId: shot.appId, frame: { mime: 'image/jpeg', width: shot.width, height: shot.height, sha256: shot.sha256, data: shot.data }, dropped: false };
  }

  _build(lease, deviceId, w, captured) {
    const list = (this.actions.get(lease.leaseId) || []).filter((a) => a.seq > w.cursor).slice(0, ACTIONS_PER_VIEW);
    const make = (frame, dropped) => L.buildLeaseView({
      identity: this.identity, leaseId: lease.leaseId, seq: this.leases.nextSeq(lease), toDevice: deviceId, state: lease.state,
      locked: lease.locked, remainingS: Math.floor(this.leases.remainingMs(lease) / 1000),
      foreground: { app_id: captured.appId, matches: captured.appId !== null }, frame, frameDropped: dropped, actions: list,
      contactToken: this.leases.mintContactToken(lease), now: this.clock()
    });
    let envelope = make(captured.frame, captured.dropped);
    // The payload is the JCS bytes, so its length is the view's size.
    if (Buffer.from(envelope.payload, 'base64url').length > L.VIEW_MAX_BYTES) envelope = make(null, true);
    return { envelope, lastSeq: list.length ? list[list.length - 1].seq : w.cursor };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      for (const [id, w] of this.watchers) if (w.until <= now) this.watchers.delete(id);
      const lease = this.leases.current();
      if (!lease || lease.state !== 'active' || lease.locked) return;
      if (now - this.lastCaptureAt < MIN_FRAME_GAP_MS) return;
      const intervalMs = this.guiConfig.liveView.intervalS * 1000;
      const afterInput = this.inputPending.has(lease.leaseId);
      const due = [...this.watchers].filter(([, w]) => w.leaseId === lease.leaseId && (afterInput || now - w.lastFrameAt >= intervalMs));
      if (due.length === 0) return;
      this.lastCaptureAt = now;
      this.inputPending.delete(lease.leaseId);
      let captured;
      try {
        captured = await this._capture();
      } catch (err) {
        this.log.debug(`live frame not captured: ${err.message}`);
        captured = { appId: null, frame: null, dropped: false };
      }
      for (const [deviceId, w] of due) {
        const { envelope, lastSeq } = this._build(lease, deviceId, w, captured);
        w.lastFrameAt = now;
        w.cursor = lastSeq;
        this.relayClient.send(envelope, { to_device: deviceId }).catch((err) => this.log.debug(`view not sent: ${err.message}`));
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { LiveView, ACTIONS_KEPT, ACTIONS_PER_VIEW };
