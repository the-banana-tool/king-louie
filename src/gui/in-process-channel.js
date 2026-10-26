// src/gui/in-process-channel.js
// A personal node (spec 2026-10-25 §7) runs the service in the user's own
// login session, so the broker can drive the OS backend directly instead of
// a session helper over kl-session-v1. This channel gives GuiBroker the
// surface HelperChannel does (`ready`, `event`, `connected`, `info`,
// `request`), over the helper's own op handler and session watch. It never
// emits `closed`: there is no other process to lose.
const { EventEmitter } = require('events');
const os = require('os');
const { createLogger } = require('../logging');
const { GuiError, isGuiError } = require('./errors');
const { sanitizeProbe, OP_TIMEOUTS } = require('./helper-channel');
const { createOpHandler, QUIET_OPS } = require('../session/connection');
const { startSessionWatch, safeProbe } = require('../session/session-watch');
const { NO_BACKEND_REPORT } = require('../session/backends');

const DEFAULT_OP_TIMEOUT = 10000;
const NO_BACKEND_REASON = 'no desktop session was found for this service (no display, or Wayland without portals)';

class InProcessChannel extends EventEmitter {
  constructor({ backend, platform = process.platform, env = process.env, recorder = null, log = createLogger('gui/in-process'),
    timers, reprobeMs, lockPollMs, clock = Date.now } = {}) {
    super();
    Object.assign(this, { backend: backend || null, platform, env, log, timers, reprobeMs, lockPollMs, clock });
    this.recorder = Object.freeze({ ffmpeg: (recorder && recorder.ffmpeg) || null });
    this.handleOp = createOpHandler(this.backend, { platform, recorder: this.recorder });
    this.connected = false;
    this.info = null;
    this.watch = null;
    this.pending = new Set();
  }

  async start() {
    // As the session helper does before its first probe (the macOS prompts).
    if (this.backend && typeof this.backend.requestPermissions === 'function') {
      await Promise.resolve().then(() => this.backend.requestPermissions()).catch((err) => this.log.warn(`permission prompt failed: ${err.message}`));
    }
    const report = this.backend ? await safeProbe(this.backend, this.log) : NO_BACKEND_REPORT(NO_BACKEND_REASON);
    const withRecorder = { ...report, recorder: this.recorder };
    this.info = {
      user: os.userInfo().username, platform: this.platform, pid: process.pid,
      ...sanitizeProbe(withRecorder), since: new Date(this.clock()).toISOString()
    };
    this.connected = true;
    this.emit('ready', this.info);
    this.watch = startSessionWatch(this.backend, {
      report: withRecorder, recorder: this.recorder, log: this.log, emit: (kind, payload) => this._onWatch(kind, payload),
      reprobeMs: this.reprobeMs, lockPollMs: this.lockPollMs, ...(this.timers ? { timers: this.timers } : {})
    });
  }

  // As HelperChannel's sealed `event` frame: a probe change replaces the
  // probe part of info (the lock state kept) and is emitted with the new
  // info; a lock change updates info.locked and is emitted as it came.
  _onWatch(kind, payload) {
    if (!this.connected) return;
    const { user, platform, pid, since } = this.info;
    if (kind === 'probe_changed') {
      this.info = { user, platform, pid, ...sanitizeProbe({ ...payload, locked: this.info.locked }), since };
      this.emit('event', 'probe_changed', this.info);
      return;
    }
    if (kind === 'locked' || kind === 'unlocked') this.info = { ...this.info, locked: kind === 'locked' };
    this.emit('event', kind, payload || {});
  }

  request(op, params = {}, { timeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new GuiError('helper_disconnected'));
    const ms = timeoutMs ?? OP_TIMEOUTS[op] ?? DEFAULT_OP_TIMEOUT;
    return new Promise((resolve, reject) => {
      const entry = { reject: null, timer: null };
      const settle = (fn, value) => {
        if (!this.pending.has(entry)) return;
        this.pending.delete(entry);
        clearTimeout(entry.timer);
        fn(value);
      };
      entry.reject = (err) => settle(reject, err);
      entry.timer = setTimeout(() => entry.reject(new GuiError('op_timeout', `${op} took over ${ms} ms`)), ms);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      this.pending.add(entry);
      Promise.resolve()
        .then(() => this.handleOp(op, params))
        .then((result) => settle(resolve, result === undefined ? null : result), (err) => entry.reject(this._asGuiError(op, err)));
    });
  }

  // What the helper would have put on the wire: a GuiError keeps its code,
  // anything else is backend_failed, and a quiet op's message is not kept
  // (it can quote a key, an argv or a path).
  _asGuiError(op, err) {
    if (isGuiError(err)) return err;
    const quiet = QUIET_OPS.has(op);
    if (!quiet) this.log.warn(`${op} failed: ${err && err.message}`);
    else this.log.warn(`${op} failed (${(err && (err.code || err.name)) || 'error'})`);
    return new GuiError('backend_failed', quiet ? null : String((err && err.message) || 'backend_failed').slice(0, 300));
  }

  async stop() {
    if (this.watch) this.watch.stop();
    this.watch = null;
    this.connected = false;
    for (const entry of [...this.pending]) entry.reject(new GuiError('helper_disconnected'));
    if (this.backend && typeof this.backend.stop === 'function') {
      await Promise.resolve().then(() => this.backend.stop()).catch((err) => this.log.warn(`backend stop failed: ${err.message}`));
    }
  }
}

// The backend for this session, picked as the session helper picks it.
// Required here, not at the top: loading this module loads no backend.
function buildInProcessChannel({ platform = process.platform, env = process.env, log = createLogger('gui/in-process') } = {}) {
  const { selectBackend, loadBackend } = require('../session/backends');
  const { findFfmpeg } = require('../session/recorder');
  const name = selectBackend({ platform, env });
  const backend = name ? loadBackend(name, { env, log }) : null;
  let ffmpeg = null;
  try { ffmpeg = findFfmpeg({ platform, env }) || null; } catch { ffmpeg = null; }
  return new InProcessChannel({ backend, platform, env, recorder: { ffmpeg }, log });
}

module.exports = { InProcessChannel, buildInProcessChannel };
