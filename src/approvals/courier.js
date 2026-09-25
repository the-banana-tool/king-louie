// File courier (spec §3.9): `mcp` and the admin CLI cannot open a second link
// with the node's key, so they hand node-signed messages to the running
// service through <dataDir>/approvals/outbox/ and read replies from their own
// inbox. The protection is the signatures, not the directory ACL: anything
// that can write outbox/ or inbox/ could try to push messages through the
// pump into the relay link, so the pump forwards only envelopes signed by
// this node's key (and enroll.done only for a code it saw opened), and
// producers verify whatever they read back. File names are matched against
// their exact pattern before they are ever used as a path component, and a
// file that survives that check is still lstat'd: only a regular,
// non-symlink file under the size cap is opened and parsed. A bad file is
// dropped, not retried, so it can never wedge the pump or a producer.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { readPidfile, isRunning } = require('../service/pidfile');
const { open, verifyEd25519 } = require('./envelope');
const { writeFileAtomic } = require('./approver-store');

const log = createLogger('approvals/courier');

// Full-filename patterns: matched against the whole name before it is ever
// joined onto a directory, so anything that doesn't match is never used as a
// path component and is simply left alone.
const OUTBOX_FILE_RE = /^\d+-[a-f0-9]{8}\.json$/;
const REPLY_FILE_RE = /^([a-f0-9]{16})\.json$/;
const MSG_FILE_RE = /^m-\d+-[a-f0-9]{8}\.json$/;
const INBOX_DIR_RE = /^p-(\d+)-[a-f0-9]{8}$/;
const KEY_RE = /^[a-f0-9]{16}$/;
const NOT_RUNNING = 'the King Louie service is not running on this node';
// Methods the pump forwards only with an envelope signed by this node, and
// the message type each must carry (message.submit: any node-signed type).
const SIGNED_METHODS = {
  'approval.submit': 'kl.approval.request',
  'approval.status': 'kl.approval.status',
  'message.submit': null,
  'enroll.open': 'kl.enroll.open',
  'enroll.done': 'kl.enroll.done'
};
// What a producer accepts from its inbox besides replies.
const INBOX_METHODS = new Set(['approval.response', 'enroll.claim']);
// 1 MiB: comfortably over MAX_ACTION_BYTES (262144, base64/JSON-expanded)
// plus envelope and message overhead, but small enough that anything with
// write access to outbox/ or inbox/ cannot make the pump or a producer read
// something huge before it even looks at the content.
const MAX_FILE_BYTES = 1024 * 1024;
// Not every platform defines O_NOFOLLOW (Windows does not); fall back to 0
// (no-op flag) there and rely on the lstat check instead.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function approvalsDir(dataDir) {
  return path.join(dataDir, 'approvals');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Reads a courier drop that has already been matched against its exact
// filename pattern. Refuses anything that isn't a regular, non-symlink file
// under the size cap, and never reads past that cap. Returns null for
// anything else (vanished, symlink, directory, oversized, unreadable,
// unparseable) so a hostile or malformed drop is dropped, never thrown.
function readCourierFile(file) {
  let lst;
  try {
    lst = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > MAX_FILE_BYTES) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed above */ } }
  }
}

class CourierError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CourierError';
    this.code = code;
  }
}

// ── Producer side (mcp, admin CLI) ──────────────────────────────────────────
class FileCourier extends EventEmitter {
  constructor({ dataDir, identity = null, pollMs = 250, isAlive = isRunning, onPathWritten = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.identity = identity;
    this.pollMs = pollMs;
    this.isAlive = isAlive;
    this.onPathWritten = onPathWritten || (() => {});
    this.inboxName = `p-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.inbox = path.join(approvalsDir(dataDir), 'inbox', this.inboxName);
    this.outbox = path.join(approvalsDir(dataDir), 'outbox');
    this.waiting = new Map();
    this.handler = null;
    this.timer = null;
    this.lastConnected = false;
  }

  start() {
    for (const dir of [this.outbox, this.inbox]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.onPathWritten(dir);
    }
    this.lastConnected = this.isConnected();
    this.timer = setInterval(() => this._poll(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new CourierError('closed', 'courier stopped'));
    }
    this.waiting.clear();
    fs.rmSync(this.inbox, { recursive: true, force: true });
  }

  _link() {
    return readJson(path.join(approvalsDir(this.dataDir), 'link.json'));
  }

  canDeliver() {
    const pid = readPidfile(this.dataDir);
    if (!pid || !this.isAlive(pid)) return { ok: false, reason: NOT_RUNNING };
    if (!this._link()) return { ok: false, reason: 'no relay is paired with this node' };
    return { ok: true };
  }

  isConnected() {
    if (!this.canDeliver().ok) return false;
    const link = this._link();
    return Boolean(link && link.connected === true);
  }

  _post(method, params, replyTo) {
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const file = path.join(this.outbox, name);
    writeFileAtomic(file, `${JSON.stringify({ method, params, reply_to: replyTo })}\n`);
    this.onPathWritten(file);
  }

  call(method, params = {}, { timeoutMs = 10000 } = {}) {
    const delivery = this.canDeliver();
    if (!delivery.ok) return Promise.reject(new CourierError('unavailable', delivery.reason));
    const key = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        reject(new CourierError('timeout', `${method} got no reply from the service within ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiting.set(key, { resolve, reject, timer });
      this._post(method, params, { inbox: this.inboxName, key });
    });
  }

  notify(method, params = {}) {
    if (this.canDeliver().ok) this._post(method, params, null);
  }

  submit(envelope) {
    return this.call('approval.submit', { envelope });
  }

  status(envelope) {
    return this.call('approval.status', { envelope });
  }

  send(envelope, { push = null, to_device = null } = {}) {
    return this.call('message.submit', { envelope, push, to_device });
  }

  onMessage(handler) {
    this.handler = handler;
  }

  _poll() {
    const connected = this.isConnected();
    if (connected && !this.lastConnected) this.emit('connected');
    if (!connected && this.lastConnected) this.emit('disconnected');
    this.lastConnected = connected;
    let names;
    try {
      names = fs.readdirSync(this.inbox);
    } catch {
      return;
    }
    for (const name of names) {
      const replyMatch = REPLY_FILE_RE.exec(name);
      const isMessage = !replyMatch && MSG_FILE_RE.test(name);
      if (!replyMatch && !isMessage) continue; // not shaped like a reply or a message file: never read, never a path component
      const file = path.join(this.inbox, name);
      const body = readCourierFile(file);
      try { fs.unlinkSync(file); } catch { /* gone */ }
      if (replyMatch) {
        const key = replyMatch[1];
        if (!KEY_RE.test(key)) continue; // defensive: the capture group already matches this, but never trust it further than that
        const waiter = this.waiting.get(key);
        if (!waiter) {
          log.warn(`dropping a reply nobody asked for: ${name}`);
          continue;
        }
        this.waiting.delete(key);
        clearTimeout(waiter.timer);
        if (body && body.error) waiter.reject(new CourierError(body.error.code || 'error', body.error.message));
        else waiter.resolve(body ? body.result : null);
        continue;
      }
      if (!body || !INBOX_METHODS.has(body.method) || !this.handler) {
        log.warn(`dropping inbox file ${name}`);
        continue;
      }
      Promise.resolve()
        .then(() => this.handler(body.method, body.params || {}))
        .catch((err) => log.warn(`inbox ${body.method} failed: ${err.message}`));
    }
  }
}

// ── Service side ────────────────────────────────────────────────────────────
class CourierPump {
  constructor({ dataDir, relayClient, identity, rpcHandler = null, pollMs = 250, now = Date.now, isAlive = isRunning } = {}) {
    this.dataDir = dataDir;
    this.relayClient = relayClient;
    this.identity = identity;
    this.nodeKey = Buffer.from(identity.publicKey).toString('hex');
    this.rpcHandler = rpcHandler;
    this.pollMs = pollMs;
    this.now = now;
    this.isAlive = isAlive;
    this.outbox = path.join(approvalsDir(dataDir), 'outbox');
    this.inboxRoot = path.join(approvalsDir(dataDir), 'inbox');
    this.routes = new Map();
    this.codes = new Map();
    this.timer = null;
    this.busy = false;
  }

  start() {
    fs.mkdirSync(this.outbox, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.inboxRoot, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => { this.pollOnce().catch((err) => log.warn(`courier poll failed: ${err.message}`)); }, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Verifies the envelope with the real open() + verifyEd25519, signed by
  // this node's own key and naming this node — the security boundary the
  // pump enforces before anything reaches the relay.
  _nodeSigned(envelope, type) {
    if (!envelope || envelope.alg !== 'Ed25519' || envelope.kid !== this.identity.nodeId) return null;
    if (!verifyEd25519(envelope, this.nodeKey)) return null;
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      return null;
    }
    if (message.node_id !== this.identity.nodeId) return null;
    if (type && message.type !== type) return null;
    return message;
  }

  _writeTo(inboxName, fileName, body) {
    if (!INBOX_DIR_RE.test(inboxName)) return false;
    const dir = path.join(this.inboxRoot, inboxName);
    if (!fs.existsSync(dir)) return false;
    writeFileAtomic(path.join(dir, fileName), `${JSON.stringify(body)}\n`);
    return true;
  }

  _reply(replyTo, body) {
    if (!replyTo || !INBOX_DIR_RE.test(String(replyTo.inbox)) || !KEY_RE.test(String(replyTo.key))) return;
    this._writeTo(replyTo.inbox, `${replyTo.key}.json`, body);
  }

  // Which producer's inbox a relay → node message belongs to, or null.
  routeFor(method, params = {}) {
    if (method === 'approval.response') {
      try {
        const { message } = open(params.envelope);
        const route = this.routes.get(message.request_id);
        return route ? route.inbox : null;
      } catch {
        return null;
      }
    }
    if (method === 'enroll.claim') {
      const route = this.codes.get(params.code_id);
      return route ? route.inbox : null;
    }
    return null;
  }

  deliver(inboxName, method, params) {
    return this._writeTo(inboxName, `m-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`, { method, params });
  }

  async _handle(entry) {
    const { method, params = {}, reply_to: replyTo = null } = entry || {};
    if (Object.prototype.hasOwnProperty.call(SIGNED_METHODS, method)) {
      const message = this._nodeSigned(params.envelope, SIGNED_METHODS[method]);
      if (!message) {
        log.warn(`dropping ${method} from the outbox: not signed by this node`);
        this._reply(replyTo, { error: { code: 'rejected', message: 'not signed by this node' } });
        return;
      }
      if (method === 'enroll.done') {
        const code = this.codes.get(message.code_id);
        if (!code || this.now() > code.expiresAt) {
          log.warn(`dropping enroll.done for a code this service never opened (${message.code_id})`);
          this._reply(replyTo, { error: { code: 'rejected', message: 'unknown code_id' } });
          return;
        }
      }
      const inbox = replyTo && INBOX_DIR_RE.test(String(replyTo.inbox)) ? replyTo.inbox : null;
      if (method === 'approval.submit' && inbox) this.routes.set(message.request_id, { inbox, expiresAt: Date.parse(message.expires_at) });
      if (method === 'enroll.open' && inbox) this.codes.set(message.code_id, { inbox, expiresAt: Date.parse(message.expires_at) });
      try {
        this._reply(replyTo, { result: await this.relayClient.call(method, params) });
      } catch (err) {
        this._reply(replyTo, { error: { code: err.code || 'error', message: err.message } });
      }
      return;
    }
    if (this.rpcHandler) {
      try {
        this._reply(replyTo, { result: await this.rpcHandler(method, params) });
      } catch (err) {
        this._reply(replyTo, { error: { code: err.code || 'error', message: err.message } });
      }
      return;
    }
    log.warn(`dropping ${method} from the outbox: not a courier method`);
    this._reply(replyTo, { error: { code: 'unknown_method', message: `${method} is not forwarded` } });
  }

  // Bounds routes/codes (60 s past the request's/code's own expiry — well
  // past anything a producer could still be waiting on) and removes the
  // inbox of any producer whose pid is really dead, per the injected isAlive.
  _sweep() {
    const cutoff = this.now() - 60000;
    for (const map of [this.routes, this.codes]) {
      for (const [k, v] of map) if (v.expiresAt < cutoff) map.delete(k);
    }
    let names = [];
    try {
      names = fs.readdirSync(this.inboxRoot);
    } catch {
      return;
    }
    for (const name of names) {
      const dirMatch = INBOX_DIR_RE.exec(name);
      if (dirMatch && !this.isAlive(Number(dirMatch[1]))) fs.rmSync(path.join(this.inboxRoot, name), { recursive: true, force: true });
    }
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      let names = [];
      try {
        names = fs.readdirSync(this.outbox).filter((n) => OUTBOX_FILE_RE.test(n)).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const file = path.join(this.outbox, name);
        const entry = readCourierFile(file);
        // Removed whether it parsed or not, signed or not: a bad file must
        // never be retried, or it could loop the pump forever.
        try { fs.unlinkSync(file); } catch { continue; }
        await this._handle(entry);
      }
      this._sweep();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { FileCourier, CourierPump, CourierError, NOT_RUNNING };
