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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// `{ inbox, key } | null` — anything else (an array, a string, extra keys, a
// non-string inbox/key) is refused outright: it is never coerced, and it is
// never passed on to _reply/_writeTo, which is what let an array reply_to.inbox
// reach path.join and throw.
function isValidReplyTo(v) {
  return v === null || (isPlainObject(v) && Object.keys(v).length === 2 && typeof v.inbox === 'string' && typeof v.key === 'string');
}

// Reads a courier drop that has already been matched against its exact
// filename pattern. Refuses anything that isn't a regular, non-symlink file
// no larger than MAX_FILE_BYTES — a directory that happens to have a name
// shaped like an outbox/inbox file is silently ignored by the same lstat,
// with no extra stat call or logging just for that case. The read itself is
// capped at MAX_FILE_BYTES + 1 bytes so a file that grows between the lstat
// and the read (TOCTOU) is still caught: reading that many bytes back means
// the file is at least that large, so it is refused rather than trusted.
// Returns null for anything else (vanished, symlink, directory, oversized,
// unreadable, unparseable) so a hostile or malformed drop is dropped, never
// thrown.
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
    const cap = MAX_FILE_BYTES + 1;
    const buf = Buffer.allocUnsafe(cap);
    const read = fs.readSync(fd, buf, 0, cap, 0);
    if (read > MAX_FILE_BYTES) return null;
    return JSON.parse(buf.toString('utf8', 0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed above */ } }
  }
}

// The relay-bound params rebuilt from scratch for each forwarded method, so
// an outbox entry can never smuggle extra keys through to the relay call.
function forwardParams(method, params) {
  if (method === 'message.submit') {
    return {
      envelope: params.envelope,
      push: Object.prototype.hasOwnProperty.call(params, 'push') ? params.push : null,
      to_device: Object.prototype.hasOwnProperty.call(params, 'to_device') ? params.to_device : null
    };
  }
  return { envelope: params.envelope };
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
      try {
        this._post(method, params, { inbox: this.inboxName, key });
      } catch (err) {
        this.waiting.delete(key);
        clearTimeout(timer);
        reject(err);
      }
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
        const key = replyMatch[1]; // already exactly 16 hex chars: REPLY_FILE_RE's capture group guarantees it
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
    let lst;
    try {
      lst = fs.lstatSync(dir);
    } catch {
      return false;
    }
    // Must be a real directory: refuse a symlink or junction standing in for it.
    if (!lst.isDirectory() || lst.isSymbolicLink()) return false;
    writeFileAtomic(path.join(dir, fileName), `${JSON.stringify(body)}\n`);
    return true;
  }

  // `replyTo` reaches here only as null or already shape-validated by
  // _handle (isValidReplyTo: exactly { inbox: string, key: string }), so
  // there is nothing left to coerce — only the format is checked.
  _reply(replyTo, body) {
    if (!replyTo || !INBOX_DIR_RE.test(replyTo.inbox) || !KEY_RE.test(replyTo.key)) return;
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
      // A closed (enroll.done already forwarded) or expired code is no
      // longer open (Task 19 carry: any path that acts on a code must check
      // its state is open), so a late claim has nowhere left to be routed.
      if (!route || route.closed || this.now() > route.expiresAt) return null;
      return route.inbox;
    }
    return null;
  }

  deliver(inboxName, method, params) {
    return this._writeTo(inboxName, `m-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`, { method, params });
  }

  // entry is whatever readCourierFile handed back for an outbox file: it may
  // be null (non-JSON, oversized, a symlink) or any JSON value at all, so
  // its shape is never trusted past this point. Anything that isn't exactly
  // { method: string, params: object, reply_to: null | { inbox: string, key: string } }
  // is dropped and logged, never dispatched to relayClient/rpcHandler and
  // never used to build a path.
  async _handle(entry) {
    if (!isPlainObject(entry)) {
      log.warn('dropping a malformed outbox entry: not an object');
      return;
    }
    const { method, params, reply_to: replyTo } = entry;
    if (!isValidReplyTo(replyTo)) {
      // reply_to itself can't be trusted enough to answer through — an
      // array here, for instance, must never reach _reply/_writeTo/path.join.
      log.warn('dropping a malformed outbox entry: malformed reply_to');
      return;
    }
    if (typeof method !== 'string' || !isPlainObject(params)) {
      log.warn(`dropping a malformed outbox entry (method=${JSON.stringify(method)}): params must be an object`);
      this._reply(replyTo, { error: { code: 'malformed', message: 'malformed outbox entry' } });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(SIGNED_METHODS, method)) {
      const message = this._nodeSigned(params.envelope, SIGNED_METHODS[method]);
      if (!message) {
        log.warn(`dropping ${method} from the outbox: not signed by this node`);
        this._reply(replyTo, { error: { code: 'rejected', message: 'not signed by this node' } });
        return;
      }
      const inbox = replyTo && INBOX_DIR_RE.test(replyTo.inbox) ? replyTo.inbox : null;
      if (method === 'enroll.done') {
        const code = this.codes.get(message.code_id);
        if (!code || code.closed || this.now() > code.expiresAt) {
          log.warn(`dropping enroll.done for a code this service never opened (${message.code_id})`);
          this._reply(replyTo, { error: { code: 'rejected', message: 'unknown code_id' } });
          return;
        }
        // Marks the code closed as part of forwarding enroll.done: a claim
        // that arrives after this must not be routed anywhere, the same as
        // one that arrives after the code's own expiry.
        code.closed = true;
      }
      // First binding wins, but a retry is not a rebind: a second forward of
      // the same id from the SAME inbox is PhoneApprover resubmitting after
      // the link was down (it resubmits every pending request on
      // 'connected'), and must go through again, or approvals break across
      // every relay reconnect. Only a DIFFERENT inbox claiming an id someone
      // else already bound is refused.
      if (method === 'approval.submit') {
        const existing = this.routes.get(message.request_id);
        if (existing && existing.inbox !== inbox) {
          log.warn(`dropping approval.submit for ${message.request_id}: already bound to a different inbox`);
          this._reply(replyTo, { error: { code: 'rejected', message: 'request_id already bound to a different inbox' } });
          return;
        }
        if (inbox) this.routes.set(message.request_id, { inbox, expiresAt: Date.parse(message.expires_at) });
      }
      if (method === 'enroll.open') {
        const existing = this.codes.get(message.code_id);
        if (existing && existing.inbox !== inbox) {
          log.warn(`dropping enroll.open for ${message.code_id}: already bound to a different inbox`);
          this._reply(replyTo, { error: { code: 'rejected', message: 'code_id already bound to a different inbox' } });
          return;
        }
        // Recorded even without a producer to reply to (inbox: null), so a
        // later enroll.done still finds it; routeFor('enroll.claim', …) then
        // simply has no inbox to deliver the claim to.
        this.codes.set(message.code_id, { inbox, expiresAt: Date.parse(message.expires_at), closed: false });
      }
      try {
        this._reply(replyTo, { result: await this.relayClient.call(method, forwardParams(method, params)) });
      } catch (err) {
        // Unbind on failure: nothing was actually forwarded, so the id must
        // not be left looking claimed — the next attempt (a retry, or a
        // different inbox once this one has given up) starts fresh.
        if (method === 'approval.submit') this.routes.delete(message.request_id);
        if (method === 'enroll.open') this.codes.delete(message.code_id);
        // enroll.done never reached the relay, so the code was never
        // actually closed: reopen it (same class as the approval.submit/
        // enroll.open unbinds above) so a retry of enroll.done is forwarded
        // again instead of being refused as an unknown/closed code.
        if (method === 'enroll.done') {
          const code = this.codes.get(message.code_id);
          if (code) code.closed = false;
        }
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
        try {
          await this._handle(entry);
        } catch (err) {
          // One bad entry must never skip the rest of the batch or the
          // sweep below — _handle already guards against the shapes it
          // knows about, but this is the backstop for anything it doesn't.
          log.warn(`outbox entry ${name} failed: ${err.message}`);
        }
      }
      this._sweep();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { FileCourier, CourierPump, CourierError, NOT_RUNNING };
