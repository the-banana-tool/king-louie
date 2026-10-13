// src/gui/helper-channel.js
// The service side of kl-session-v1 (fleet stage 5 spec §3.2): a pipe or
// socket any local account can open, where only a peer holding the session
// secret gets past the handshake, and every frame after it is sealed.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { createLogger } = require('../logging');
const P = require('./helper-protocol');
const { GuiError, fromWire } = require('./errors');
const { LEASE_LIMITS } = require('./lease-protocol');

const OP_TIMEOUTS = Object.freeze({ screenshot: 20000, launch: 30000 });
const DEFAULT_OP_TIMEOUT = 10000;
const GUI_CAPABILITIES = Object.freeze(['gui.launch', 'gui.screenshot', 'gui.input']);
const EVENT_KINDS = Object.freeze(['locked', 'unlocked', 'displays_changed', 'probe_changed']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

// What the helper reports is the user's process speaking: keep only known
// capabilities and limits, and bound every list.
function sanitizeProbe(msg) {
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    capabilities: list(msg.capabilities, 8).filter((c) => GUI_CAPABILITIES.includes(c)),
    probes: list(msg.probes, 32).filter(isPlainObject).map((p) => ({
      check: String(p.check || '').slice(0, 64), ok: p.ok === true, ...(p.hint ? { hint: String(p.hint).slice(0, 300) } : {})
    })),
    displays: list(msg.displays, 16).filter(isPlainObject),
    limits: list(msg.limits, 4).filter((l) => LEASE_LIMITS.includes(l)),
    locked: msg.locked === true
  };
}

class HelperChannel extends EventEmitter {
  constructor({ endpoint, readSecret, readMtime = () => null, platform = process.platform, audit = null, clock = Date.now,
    log = createLogger('gui/channel'), handshakeMs = 5000, pingMs = 10000, silenceMs = 30000, duplicatePingMs = 5000, maxUnauthenticated = 4 } = {}) {
    super();
    Object.assign(this, { endpoint, readSecret, readMtime, platform, audit, clock, log, handshakeMs, pingMs, silenceMs, duplicatePingMs, maxUnauthenticated });
    this.server = null;
    this.unauth = new Set();
    this.all = new Set();
    this.current = null;
  }

  get connected() {
    return Boolean(this.current && this.current.probe);
  }

  get info() {
    const c = this.current;
    if (!c || !c.probe) return null;
    return { user: c.hello.user, platform: c.hello.platform, pid: c.hello.pid, ...c.probe, since: c.since };
  }

  async start() {
    if (this.platform !== 'win32') {
      try {
        const st = fs.lstatSync(this.endpoint);
        if (st.isSymbolicLink()) throw new GuiError('unsafe_path', this.endpoint);
        fs.unlinkSync(this.endpoint);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    this.server = net.createServer((socket) => this._onSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      const options = this.platform === 'win32' ? { path: this.endpoint, readableAll: true, writableAll: true } : { path: this.endpoint };
      this.server.listen(options, () => { this.server.off('error', reject); resolve(); });
    });
    // The helper is another account: the protocol, not the mode, is the boundary.
    if (this.platform !== 'win32') fs.chmodSync(this.endpoint, 0o666);
  }

  async stop() {
    for (const conn of this.all) this._destroy(conn, 'service_stopped');
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    if (this.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch { /* already gone */ }
    }
  }

  request(op, params = {}, { jobId = null, leaseId = null, timeoutMs } = {}) {
    const conn = this.current;
    if (!conn || !conn.probe) return Promise.reject(new GuiError('helper_disconnected'));
    const id = conn.nextId;
    conn.nextId += 1;
    return new Promise((resolve, reject) => {
      const ms = timeoutMs || OP_TIMEOUTS[op] || DEFAULT_OP_TIMEOUT;
      const timer = unref(setTimeout(() => {
        conn.pending.delete(id);
        reject(new GuiError('op_timeout', `${op} took over ${ms} ms`));
      }, ms));
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.socket.write(conn.sealer.seal({ t: 'req', id, op, job_id: jobId, lease_id: leaseId, params }));
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(err);
      }
    });
  }

  _audit(kind, data) {
    if (!this.audit) return;
    Promise.resolve().then(() => this.audit.append({ kind, data })).catch((err) => this.log.warn(`audit ${kind} failed: ${err.message}`));
  }

  _onSocket(socket) {
    socket.on('error', () => {});
    if (this.unauth.size >= this.maxUnauthenticated) {
      socket.destroy();
      return;
    }
    const conn = { socket, state: 'hello', decoder: new P.FrameDecoder({ maxBytes: P.PLAIN_MAX }), dead: false, probe: null, acceptedAt: Date.now() };
    this.unauth.add(conn);
    this.all.add(conn);
    conn.timer = unref(setTimeout(() => this._destroy(conn, 'handshake_timeout'), this.handshakeMs));
    socket.on('data', (chunk) => this._onData(conn, chunk));
    socket.on('close', () => this._onClose(conn));
  }

  _onData(conn, chunk) {
    if (conn.dead) return;
    try {
      conn.decoder.push(chunk);
      let body;
      while (!conn.dead && (body = conn.decoder.next())) this._onFrame(conn, body);
    } catch (err) {
      const reason = err.code === 'frame_rejected' ? `frame_rejected: ${err.detail}` : err.message;
      if (conn.state !== 'ready') this._audit('gui.helper.auth_failed', { side: 'helper', reason });
      this._destroy(conn, reason);
    }
  }

  _onFrame(conn, body) {
    if (conn.state === 'ready') {
      this._onSealed(conn, conn.opener.open(body));
      return;
    }
    const msg = P.parsePlain(body);
    if (conn.state === 'hello') {
      if (msg.t !== 'hello' || msg.v !== 1 || !P.NONCE_RE.test(String(msg.nonce_h))) throw new GuiError('frame_rejected', 'expected hello');
      let canonical;
      try {
        canonical = this.readSecret();
      } catch (err) {
        this.log.error(`the session secret cannot be read: ${err.message}`);
        this._destroy(conn, 'no_secret');
        return;
      }
      // Windows account names are case-insensitive; `session install` stores the bare name.
      const sameUser = this.platform === 'win32'
        ? String(msg.user).toLowerCase() === String(canonical.sessionUser).toLowerCase()
        : msg.user === canonical.sessionUser;
      if (msg.node_id !== canonical.nodeId || !sameUser) {
        this._authFailed(conn, msg.node_id !== canonical.nodeId ? 'node_id differs from the canonical file' : 'user is not the session user');
        return;
      }
      Object.assign(conn, { hello: msg, secret: canonical.secret, nodeId: canonical.nodeId, mtimeMs: canonical.mtimeMs, nonceH: msg.nonce_h, nonceS: P.randomNonce(), state: 'auth' });
      conn.socket.write(P.encodeFrame({ t: 'challenge', v: 1, nonce_s: conn.nonceS, proof_s: P.serviceProof(conn.secret, conn.nodeId, conn.nonceH, conn.nonceS) }));
      return;
    }
    if (conn.state === 'auth' && msg.t === 'auth') {
      if (!P.proofEquals(msg.proof_h, P.helperProof(conn.secret, conn.nodeId, conn.nonceS, conn.nonceH))) {
        this._authFailed(conn, 'bad helper proof');
        return;
      }
      conn.state = 'deciding';
      this._admit(conn).catch((err) => this._destroy(conn, err.message));
      return;
    }
    throw new GuiError('frame_rejected', `unexpected ${String(msg.t).slice(0, 32)} frame`);
  }

  _authFailed(conn, reason) {
    this.log.warn(`session helper refused: ${reason}`);
    this._audit('gui.helper.auth_failed', { side: 'helper', reason });
    this._destroy(conn, 'auth_failed');
  }

  async _admit(conn) {
    const old = this.current;
    if (old && !old.dead) {
      // The newcomer's own handshake limit (the same on both ends) started
      // before this ping does. The ping is answered or given up on before
      // that limit runs out, so a silent helper is replaced on the
      // newcomer's first attempt instead of the newcomer timing out a
      // moment before the answer (security review finding 13c).
      const left = this.handshakeMs - (Date.now() - conn.acceptedAt) - Math.min(500, this.handshakeMs / 4);
      if (await this._pingOnce(old, Math.max(0, Math.min(this.duplicatePingMs, left)))) {
        if (!conn.dead) conn.socket.end(P.encodeFrame({ t: 'error', code: 'helper_already_connected' }));
        this._destroy(conn, 'helper_already_connected', { end: true });
        return;
      }
      this._audit('gui.helper.replaced', { old_pid: old.hello.pid, new_pid: conn.hello.pid });
      this._destroy(old, 'replaced');
    }
    if (conn.dead) return;
    clearTimeout(conn.timer);
    this.unauth.delete(conn);
    const { kSh, kHs } = P.deriveSessionKeys(conn.secret, conn.nodeId, conn.nonceH, conn.nonceS);
    Object.assign(conn, {
      sealer: P.createSealer(kSh, P.DIR_SH), opener: P.createOpener(kHs, P.DIR_HS),
      pending: new Map(), nextId: 1, lastHeard: this.clock(), pongWaiters: []
    });
    conn.socket.write(P.encodeFrame({ t: 'ready', session_id: crypto.randomUUID() }));
    conn.decoder.setMax(P.SEALED_MAX);
    conn.state = 'ready';
    this.current = conn;
    conn.pingTimer = unref(setInterval(() => this._tick(conn), this.pingMs));
    this._onData(conn, Buffer.alloc(0));
  }

  _pingOnce(conn, ms) {
    return new Promise((resolve) => {
      if (conn.dead || conn.state !== 'ready') { resolve(false); return; }
      const timer = unref(setTimeout(() => { conn.pongWaiters = conn.pongWaiters.filter((w) => w !== done); resolve(false); }, ms));
      const done = () => { clearTimeout(timer); resolve(true); };
      conn.pongWaiters.push(done);
      try {
        conn.socket.write(conn.sealer.seal({ t: 'ping' }));
      } catch {
        resolve(false);
      }
    });
  }

  _tick(conn) {
    if (conn.dead) return;
    if (this.clock() - conn.lastHeard > this.silenceMs) { this._destroy(conn, 'silent'); return; }
    const mtime = this.readMtime();
    if (mtime !== null && conn.mtimeMs !== undefined && mtime !== conn.mtimeMs) { this._destroy(conn, 'rotated'); return; }
    try {
      conn.socket.write(conn.sealer.seal({ t: 'ping' }));
    } catch (err) {
      this._destroy(conn, err.message);
    }
  }

  _onSealed(conn, msg) {
    conn.lastHeard = this.clock();
    switch (msg.t) {
      case 'probe_report': {
        const first = conn.probe === null;
        conn.probe = sanitizeProbe(msg);
        if (first) {
          conn.since = new Date(this.clock()).toISOString();
          const info = this.info;
          this._audit('gui.helper.connected', { user: info.user, platform: info.platform, pid: info.pid, capabilities: info.capabilities });
          this.emit('ready', info);
        } else {
          this.emit('event', 'probe_changed', this.info);
        }
        return;
      }
      case 'res': {
        const p = conn.pending.get(msg.id);
        if (!p) return;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result);
        else p.reject(fromWire(msg.error));
        return;
      }
      case 'event': {
        if (!EVENT_KINDS.includes(msg.kind)) return;
        const data = isPlainObject(msg.data) ? msg.data : {};
        if (!conn.probe) return;
        if (msg.kind === 'locked' || msg.kind === 'unlocked') conn.probe.locked = msg.kind === 'locked';
        if (msg.kind === 'probe_changed') {
          conn.probe = sanitizeProbe({ ...data, locked: conn.probe.locked });
          this.emit('event', 'probe_changed', this.info);
          return;
        }
        this.emit('event', msg.kind, data);
        return;
      }
      case 'ping':
        conn.socket.write(conn.sealer.seal({ t: 'pong' }));
        return;
      case 'pong': {
        const waiters = conn.pongWaiters;
        conn.pongWaiters = [];
        for (const w of waiters) w();
        return;
      }
      default:
        throw new GuiError('frame_rejected', 'unknown sealed frame');
    }
  }

  _destroy(conn, reason, { end = false } = {}) {
    if (conn.dead) return;
    conn.dead = true;
    conn.closeReason = reason;
    clearTimeout(conn.timer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (!end) conn.socket.destroy();
    this.unauth.delete(conn);
    this._onClose(conn);
  }

  _onClose(conn) {
    if (!conn.dead) {
      conn.dead = true;
      conn.closeReason = conn.closeReason || 'closed';
      clearTimeout(conn.timer);
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      this.unauth.delete(conn);
    }
    if (conn.finished) return;
    conn.finished = true;
    this.all.delete(conn);
    if (this.current !== conn) return;
    this.current = null;
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GuiError('helper_disconnected'));
    }
    conn.pending.clear();
    if (conn.probe) {
      this._audit('gui.helper.disconnected', { reason: conn.closeReason });
      this.emit('closed', conn.closeReason);
    }
  }
}

module.exports = { HelperChannel, OP_TIMEOUTS, GUI_CAPABILITIES, sanitizeProbe };
