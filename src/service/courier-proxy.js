// The root parent's side of the courier helper process (ruling T13-enroll).
// A root-run CLI command that talks to the service through the file courier
// (enroll-device) forks src/service/courier-child.js, which drops to the data
// dir's owner and runs the FileCourier; this class gives the command the same
// call()/onMessage()/stop() it had, over IPC, so root itself never reads,
// writes, chowns or unlinks inside approvals/.
//
// The child runs as the service account, which can debug or impersonate it,
// so everything it sends is untrusted: only the allowlisted message types, in
// their exact shapes, are accepted. Anything else kills the child and fails
// every pending call, as does the child exiting. `dead` is then set and
// `died` resolves with the reason, so the command can fail cleanly.
const { EventEmitter } = require('events');
const path = require('path');
const { fork } = require('child_process');
const { CourierError } = require('../approvals/courier');

const CHILD = path.join(__dirname, 'courier-child.js');
const INBOX_METHODS = new Set(['approval.response', 'enroll.claim']);
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CODE_RE = /^[a-z_.]{1,64}$/;
const LINK_STRING_KEYS = ['relay_id', 'relay_public_url', 'relay_spki', 'since'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasExactKeys(o, keys) {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

function jsonSize(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return Infinity;
  }
}

// link.json as the child read it: null, or an object whose known fields
// have the right types (unknown fields are dropped, never passed on).
function validLink(link) {
  if (link === null) return { ok: true, link: null };
  if (!isPlainObject(link)) return { ok: false };
  const out = { connected: link.connected === true };
  if (link.connected !== undefined && typeof link.connected !== 'boolean') return { ok: false };
  for (const k of LINK_STRING_KEYS) {
    const v = link[k];
    if (v === undefined || v === null) { out[k] = null; continue; }
    if (typeof v !== 'string' || v.length > 2048) return { ok: false };
    out[k] = v;
  }
  return { ok: true, link: out };
}

class CourierProxy extends EventEmitter {
  constructor({ dataDir, who = 'this command', pollMs = null, forkImpl = fork, childPath = CHILD } = {}) {
    super();
    this.dataDir = dataDir;
    this.who = who;
    this.pollMs = pollMs;
    this.forkImpl = forkImpl;
    this.childPath = childPath;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handler = null;
    this.dead = null;
    this.stopping = false;
    this.died = new Promise((resolve) => { this._resolveDied = resolve; });
    this.stderr = '';
  }

  // Resolves { link } once the child has dropped privileges and its courier
  // runs; rejects (and leaves `dead` set) if it cannot.
  start({ timeoutMs = 15000 } = {}) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = this.forkImpl(this.childPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });
    if (this.child.stderr) {
      this.child.stderr.on('data', (d) => { if (this.stderr.length < 4096) this.stderr += String(d); });
    }
    const ready = new Promise((resolve, reject) => {
      this._ready = { resolve, reject };
    });
    const timer = setTimeout(() => this._fail(new CourierError('timeout', `the courier helper did not start within ${timeoutMs} ms`)), timeoutMs);
    this.child.on('message', (msg) => this._onMessage(msg));
    this.child.on('exit', (code, signal) => {
      if (this.stopping) { this._fail(new CourierError('closed', 'courier stopped'), { kill: false }); return; }
      const detail = this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : '';
      this._fail(new CourierError('closed', `the courier helper exited (${signal || `code ${code}`})${detail}`), { kill: false });
    });
    this.child.on('error', (err) => this._fail(new CourierError('closed', `the courier helper failed: ${err.message}`)));
    this.child.send({ type: 'start', dataDir: this.dataDir, who: this.who, ...(this.pollMs ? { pollMs: this.pollMs } : {}) });
    return ready.finally(() => clearTimeout(timer));
  }

  _fail(err, { kill = true } = {}) {
    if (this.dead) return;
    this.dead = err;
    if (kill && this.child && this.child.exitCode === null) {
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (this._ready) { this._ready.reject(err); this._ready = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this._resolveDied(err);
    this.emit('dead', err);
  }

  _malformed(what) {
    this._fail(new CourierError('closed', `the courier helper sent a malformed message (${what}); it was stopped`));
  }

  _onMessage(msg) {
    if (this.dead) return;
    if (!isPlainObject(msg) || typeof msg.type !== 'string') { this._malformed('not an object'); return; }
    if (jsonSize(msg) > MAX_MESSAGE_BYTES) { this._malformed('too large'); return; }
    switch (msg.type) {
      case 'ready': {
        if (!this._ready || !hasExactKeys(msg, ['type', 'link'])) { this._malformed('ready'); return; }
        const v = validLink(msg.link);
        if (!v.ok) { this._malformed('ready.link'); return; }
        this._ready.resolve({ link: v.link });
        this._ready = null;
        return;
      }
      case 'reply': {
        const p = Number.isInteger(msg.id) ? this.pending.get(msg.id) : null;
        if (!p || typeof msg.ok !== 'boolean') { this._malformed('reply'); return; }
        if (msg.ok) {
          if (!hasExactKeys(msg, ['type', 'id', 'ok', 'result'])) { this._malformed('reply'); return; }
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg.result);
          return;
        }
        const e = msg.error;
        if (!hasExactKeys(msg, ['type', 'id', 'ok', 'error']) || !isPlainObject(e) || !hasExactKeys(e, ['code', 'message'])
          || typeof e.code !== 'string' || !CODE_RE.test(e.code) || typeof e.message !== 'string' || e.message.length > 2000) {
          this._malformed('reply.error');
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.reject(new CourierError(e.code, e.message));
        return;
      }
      case 'message': {
        if (!hasExactKeys(msg, ['type', 'method', 'params']) || !INBOX_METHODS.has(msg.method) || !isPlainObject(msg.params)) {
          this._malformed('message');
          return;
        }
        if (this.handler) {
          Promise.resolve().then(() => this.handler(msg.method, msg.params)).catch(() => {});
        }
        return;
      }
      case 'fatal': {
        if (!hasExactKeys(msg, ['type', 'message']) || typeof msg.message !== 'string' || msg.message.length > 2000) {
          this._malformed('fatal');
          return;
        }
        this._fail(new CourierError('unavailable', msg.message));
        return;
      }
      default:
        this._malformed(`type ${JSON.stringify(msg.type).slice(0, 40)}`);
    }
  }

  call(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      // The child enforces timeoutMs itself; this is only the backstop for
      // a child that stops answering.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CourierError('timeout', `${method} got no reply from the courier helper within ${timeoutMs + 5000} ms`));
      }, timeoutMs + 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.send({ type: 'call', id, method, params, timeoutMs });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CourierError('closed', `the courier helper is gone: ${err.message}`));
      }
    });
  }

  onMessage(handler) {
    this.handler = handler;
  }

  stop() {
    this.stopping = true;
    if (this.child && this.child.exitCode === null && this.child.connected) {
      try { this.child.send({ type: 'stop' }); } catch { /* gone */ }
      try { this.child.disconnect(); } catch { /* gone */ }
      // A child that does not leave on its own is killed shortly after.
      const child = this.child;
      const reaper = setTimeout(() => { if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, 2000);
      if (typeof reaper.unref === 'function') reaper.unref();
    }
    this._fail(new CourierError('closed', 'courier stopped'), { kill: false });
  }
}

module.exports = { CourierProxy, validLink };
