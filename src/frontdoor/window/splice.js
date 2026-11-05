// /window/v1 (remote window plan, R-RW-3 to R-RW-5): the front door joins a
// window's socket on mcp.<domain> to its node's dial-back on mesh.<domain>. It
// holds no key and opens no record: the seal (docs/protocol/window-v1.md) runs
// end to end through it.
//
// Both legs are WebSocket clients, so each masks what it sends and refuses a masked
// frame it receives (RFC 6455 §5.1). This is the server of both legs, and it takes a
// frame's mask off as it passes. A raw pipe could be built through an undocumented ws
// path; the forwarder was chosen because reading each frame's header is what keeps
// the socket rules of window-v1 §5: binary and control frames only, no compression,
// no fragments, at most RECORD_WIRE_MAX. The payload goes through byte for byte, a
// chunk at a time. What is held is a frame's header and, until the node dials, up to
// PRE_READY_BYTES of what the window sent.
const crypto = require('crypto');
const { createLogger } = require('../../logging');
const { allows } = require('../../fleet/scope-rules');
const { peerCertFingerprint, timingSafeHexEqual } = require('../../mesh/mesh-transport');
const { NODE_ID_RE } = require('../../approvals/messages');
const { requestHost } = require('../http-util');
const { recordFrontDoorEvent } = require('../audit/own-ledger');
const { GRANT_WRITE_LIMIT, GRANT_WRITE_WINDOW_MS } = require('../router/router');
const { WindowSessions } = require('./sessions');
const { WINDOW_SCOPE, WINDOW_TOOL, BEARER_RE, authorizationCount } = require('./scope');

const log = createLogger('frontdoor/window');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTOCOL = 'kl-window-v1';
const WINDOW_PATH = '/window/v1';
const MESH_PATH_RE = /^\/window\/v1\/([A-Za-z0-9_-]{43})$/;
const WS_KEY_RE = /^[A-Za-z0-9+/]{22}==$/;
const NODE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SCOPE = WINDOW_SCOPE;
const TOOL = WINDOW_TOOL;
// Attempts by one grant, refused ones included. The router's limit on a grant's
// writes: an attempt writes audit lines on the main thread and may make a node dial.
const ATTACH_LIMIT = GRANT_WRITE_LIMIT;
const ATTACH_WINDOW_MS = GRANT_WRITE_WINDOW_MS;

const RPC_TIMEOUT_MS = 10000;
const DIAL_DEADLINE_MS = 30000;
const SWEEP_MS = 1000;
const CLOSE_GRACE_MS = 2000;
// window-v1's limits, written out because nothing under src/desktop-bridge/ may load
// here. tests/frontdoor-window.test.js holds them equal to the seal's.
const RECORD_WIRE_MAX = 1052697;
const PRE_READY_BYTES = 8192;
// hello_w: 0x01, version, eW (32), device_id (20), pub_dev (32).
const HELLO_W_BYTES = 86;
const HELLO_W_DEVICE_AT = 34;
const HELLO_W_DEVICE_END = 54;
const DEVICE_ID_RE = /^kld-[a-z2-7]{16}$/;

const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const CONTROL_MAX = 125;
const CLOSE_REFUSED = 1008;

const noop = () => {};

function closeFrame(code, reason) {
  const text = Buffer.from(String(reason), 'ascii');
  return Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 0xff]), text]);
}

function frameHeader(first, length) {
  if (length <= 125) return Buffer.from([first, length]);
  if (length <= 0xffff) return Buffer.from([first, 126, length >> 8, length & 0xff]);
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

// What is wrong with a frame's first two bytes, or null.
function startProblem(first, second) {
  const opcode = first & 0x0f;
  if ((first & 0x80) === 0) return 'fragment';
  if ((first & 0x70) !== 0) return 'reserved_bits';
  if ((second & 0x80) === 0) return 'unmasked';
  if (![OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) return 'opcode';
  if (opcode !== OP_BINARY && (second & 0x7f) > CONTROL_MAX) return 'control_length';
  return null;
}

// One direction of the splice: masked frames in, unmasked frames out.
class FrameForwarder {
  constructor({ write, onClose, onRefused, onHelloShaped = null }) {
    this.write = write;
    this.onClose = onClose;
    this.onRefused = onRefused;
    this.onHelloShaped = onHelloShaped;
    this.header = Buffer.alloc(14);
    this.headerLength = 0;
    this.headerNeed = 2;
    this.remaining = 0;
    this.mask = null;
    this.maskAt = 0;
    this.opcode = 0;
    this.peek = null;
    this.peekLength = 0;
    this.stopped = false;
    this.flowing = true;
    this.afterFrame = null;
  }

  // A close frame may not be put inside the frame now going out.
  get inFrame() {
    return this.remaining > 0;
  }

  stop() {
    this.stopped = true;
  }

  // Finish the frame now going out, carry nothing after it, then call `then`.
  finishFrame(then) {
    this.afterFrame = then;
  }

  _send(bytes) {
    if (this.write(bytes) === false) this.flowing = false;
  }

  _refuse(what) {
    this.stopped = true;
    this.onRefused(what);
  }

  // → false when the destination asked the source to wait.
  feed(chunk) {
    this.flowing = true;
    let at = 0;
    while (at < chunk.length && !this.stopped) {
      at = this.remaining === 0 ? this._readHeader(chunk, at) : this._readPayload(chunk, at);
    }
    return this.flowing;
  }

  _readHeader(chunk, start) {
    let at = start;
    while (at < chunk.length && this.headerLength < this.headerNeed) {
      this.header[this.headerLength] = chunk[at];
      this.headerLength += 1;
      at += 1;
      if (this.headerLength === 2) {
        const problem = startProblem(this.header[0], this.header[1]);
        if (problem) {
          this._refuse(problem);
          return chunk.length;
        }
        const short = this.header[1] & 0x7f;
        this.headerNeed = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0) + 4;
      }
    }
    if (this.headerLength === this.headerNeed) this._startFrame();
    return at;
  }

  _startFrame() {
    const short = this.header[1] & 0x7f;
    let length = short;
    if (short === 126) length = this.header.readUInt16BE(2);
    if (short === 127) {
      const wide = this.header.readBigUInt64BE(2);
      length = wide > BigInt(RECORD_WIRE_MAX) ? RECORD_WIRE_MAX + 1 : Number(wide);
    }
    if (length > RECORD_WIRE_MAX) {
      this._refuse('too_long');
      return;
    }
    this.opcode = this.header[0] & 0x0f;
    this.mask = Buffer.from(this.header.subarray(this.headerNeed - 4, this.headerNeed));
    this.maskAt = 0;
    this.remaining = length;
    this.headerLength = 0;
    this.headerNeed = 2;
    if (this.onHelloShaped && this.opcode === OP_BINARY) {
      if (length === HELLO_W_BYTES) this.peek = Buffer.alloc(HELLO_W_DEVICE_END);
      else this.onHelloShaped = null;
    }
    this._send(frameHeader(this.header[0], length));
    if (length === 0) this._endFrame();
  }

  _readPayload(chunk, start) {
    const end = Math.min(chunk.length, start + this.remaining);
    const part = chunk.subarray(start, end);
    for (let i = 0; i < part.length; i += 1) {
      part[i] ^= this.mask[this.maskAt];
      this.maskAt = (this.maskAt + 1) & 3;
    }
    if (this.peek && this.peekLength < this.peek.length) this.peekLength += part.copy(this.peek, this.peekLength);
    this.remaining -= part.length;
    this._send(part);
    if (this.remaining === 0) this._endFrame();
    return end;
  }

  _endFrame() {
    if (this.peek) {
      const peek = this.peek;
      const report = this.onHelloShaped;
      this.peek = null;
      this.onHelloShaped = null;
      report(peek);
    }
    if (this.afterFrame && !this.stopped) {
      this.stopped = true;
      this.afterFrame();
      return;
    }
    if (this.opcode === OP_CLOSE && !this.stopped) {
      this.stopped = true;
      this.onClose();
    }
  }
}

// A WebSocket upgrade's key and offered protocols, or null when it is none.
function checkUpgrade(req) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !WS_KEY_RE.test(key)) return null;
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
  return { key, offered };
}

// By hand on both legs, so no ws receiver sits between them.
function writeSwitching(socket, { key, offered }, extra = {}) {
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (offered.includes(PROTOCOL)) lines.push(`Sec-WebSocket-Protocol: ${PROTOCOL}`);
  for (const [name, value] of Object.entries(extra)) lines.push(`${name}: ${value}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function hostHeaderCount(req) {
  let n = 0;
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') n += 1;
  return n;
}

function destroyLater(socket) {
  const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
  timer.unref?.();
  socket.once('close', () => clearTimeout(timer));
}

function prepare(socket) {
  socket.on('error', noop);
  socket.setTimeout?.(0);
  socket.setNoDelay?.(true);
}

function pathOf(req) {
  try {
    return new URL(req.url, 'https://window.invalid');
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function createWindowSplice({ tokens, grants, registry, nodeHub, windowResourceUrl, windowEnabled = () => false, config, auditLedger = null, now = Date.now, random = crypto.randomBytes } = {}) {
  // A function when the front door's port is known only after it listens.
  const resourceUrl = () => (typeof windowResourceUrl === 'function' ? windowResourceUrl() : windowResourceUrl);
  const sessions = new WindowSessions({
    maxSessionsPerGrant: config.maxSessionsPerGrant,
    maxSessionsPerDeviceNode: config.maxSessionsPerDeviceNode,
    maxBytesPerHour: config.maxBytesPerHour,
    now
  });
  const live = new Map();
  const attempts = new Map();
  const idleMs = config.idleS * 1000;
  const audit = (kind, data) => { recordFrontDoorEvent(auditLedger, kind, data); };

  function endLeg(socket, inbound, code, reason) {
    if (!socket || socket.destroyed) return;
    socket.resume();
    if (code !== null && !inbound.inFrame) socket.write(closeFrame(code, reason));
    socket.end();
    destroyLater(socket);
  }

  // `code` null: the two ends have closed each other, and only the sockets are left.
  function closeSession(s, code, reason) {
    if (s.closed) return;
    s.closed = true;
    live.delete(s.id);
    clearTimeout(s.closeTimer);
    s.fromWindow.stop();
    s.fromNode.stop();
    s.early = [];
    const { record } = s;
    sessions.remove(s.id);
    audit('window.session.closed', {
      session_id: s.id, device_id: record.device_id, bytes_in: record.bytes_in, bytes_out: record.bytes_out,
      seconds: Math.round((now() - record.opened_at) / 1000), reason
    });
    log.debug(`a window session on ${record.node_id} closed: ${reason}`);
    endLeg(s.window, s.fromNode, code, reason);
    endLeg(s.node, s.fromWindow, code, reason);
  }

  // One end sent its close frame, which has gone to the other end. The answer
  // comes back the same way, and then both sockets are done.
  function noteClose(s, side) {
    if (s.closed) return;
    if (!s.node) {
      closeSession(s, 1000, 'window_closed');
      return;
    }
    if (!s.closeFrom) {
      s.closeFrom = side;
      s.closeTimer = setTimeout(() => closeSession(s, null, `${side}_closed`), CLOSE_GRACE_MS);
      s.closeTimer.unref?.();
    } else if (s.closeFrom !== side) {
      closeSession(s, null, `${s.closeFrom}_closed`);
    }
  }

  // The close must reach the window, and a close frame cannot go inside a frame. So
  // a record on its way to the window finishes first (past the budget by at most that
  // record), under the grace; only then, or if it does not finish, the session closes.
  function overBudget(s) {
    if (s.draining) return;
    const close = () => closeSession(s, 4429, 'byte_budget');
    if (!s.fromNode.inFrame) {
      close();
      return;
    }
    s.draining = true;
    s.fromWindow.stop();
    s.fromNode.finishFrame(close);
    clearTimeout(s.closeTimer);
    s.closeTimer = setTimeout(close, CLOSE_GRACE_MS);
    s.closeTimer.unref?.();
  }

  function count(s, direction, bytes) {
    s.lastActivity = now();
    if (!sessions.addBytes(s.id, direction, bytes)) overBudget(s);
  }

  function carry(s, source, forwarder, destination, chunk) {
    if (!forwarder.feed(chunk) && !s.closed && !source.isPaused()) {
      source.pause();
      destination.once('drain', () => source.resume());
    }
  }

  function fromWindowChunk(s, chunk) {
    if (s.closed) return;
    count(s, 'in', chunk.length);
    if (s.closed || s.draining) return;
    if (!s.node) {
      s.earlyBytes += chunk.length;
      if (s.earlyBytes > PRE_READY_BYTES) {
        closeSession(s, CLOSE_REFUSED, 'too_early');
        return;
      }
    }
    carry(s, s.window, s.fromWindow, s.node, chunk);
  }

  function fromNodeChunk(s, chunk) {
    if (s.closed) return;
    count(s, 'out', chunk.length);
    if (s.closed) return;
    carry(s, s.node, s.fromNode, s.window, chunk);
  }

  // After the 101, because the window reads its answer as a close code. Nothing else
  // of a session exists yet.
  function refuse(socket, upgrade, code, reason, who = null) {
    if (who) audit('window.session.refused', { grant_id: who.grant_id, client_id: who.client_id, node_id: who.node_id, code: reason });
    writeSwitching(socket, upgrade);
    socket.resume();
    socket.end(closeFrame(code, reason));
    destroyLater(socket);
  }

  function nodeAnswered(s, answer) {
    if (s.closed || !answer || answer.ok !== false) return;
    closeSession(s, 4403, typeof answer.code === 'string' && NODE_CODE_RE.test(answer.code) ? answer.code : 'node_refused');
  }

  // A node that has dialled is there, whatever became of the call.
  function nodeFailed(s, err) {
    if (s.closed || s.node) return;
    if (err && err.code === 'unknown_method') closeSession(s, 4403, 'remote_window_off');
    else closeSession(s, 4404, 'node_offline');
  }

  function openSession(socket, head, upgrade, rec, nodeId) {
    const id = random(32).toString('base64url');
    const record = sessions.add({ session_id: id, grant_id: rec.grant_id, client_id: rec.client_id, node_id: nodeId });
    const dialBy = now() + DIAL_DEADLINE_MS;
    const s = {
      id, record, window: socket, node: null, early: [], earlyBytes: 0, closed: false, draining: false, closeFrom: null, closeTimer: null,
      dialBy, lastActivity: now(), fromWindow: null, fromNode: null
    };
    s.fromWindow = new FrameForwarder({
      write: (bytes) => {
        if (s.node) return s.node.write(bytes);
        s.early.push(bytes);
        return true;
      },
      onClose: () => noteClose(s, 'window'),
      onRefused: (what) => closeSession(s, CLOSE_REFUSED, `window_frame_${what}`),
      // The first binary frame, at hello_w's length and first byte, read at fixed offsets.
      onHelloShaped: (peek) => {
        if (peek[0] !== 0x01) return;
        const deviceId = peek.toString('latin1', HELLO_W_DEVICE_AT, HELLO_W_DEVICE_END);
        if (DEVICE_ID_RE.test(deviceId) && !sessions.setDevice(id, deviceId)) closeSession(s, 4429, 'session_limit');
      }
    });
    s.fromNode = new FrameForwarder({
      write: (bytes) => s.window.write(bytes),
      onClose: () => noteClose(s, 'node'),
      onRefused: (what) => closeSession(s, CLOSE_REFUSED, `node_frame_${what}`)
    });
    live.set(id, s);
    audit('window.session.opened', { session_id: id, grant_id: rec.grant_id, client_id: rec.client_id, node_id: nodeId });
    writeSwitching(socket, upgrade, { 'x-kl-window-session': id });
    const gone = () => closeSession(s, 1001, 'window_gone');
    socket.once('end', gone);
    socket.once('close', gone);
    socket.on('data', (chunk) => fromWindowChunk(s, chunk));
    if (head && head.length > 0) fromWindowChunk(s, head);
    if (s.closed) return;
    Promise.resolve()
      .then(() => nodeHub.rpc(nodeId, 'window.open', { session_id: id, expires_at: new Date(dialBy).toISOString() }, { timeoutMs: RPC_TIMEOUT_MS }))
      .then((answer) => nodeAnswered(s, answer), (err) => nodeFailed(s, err));
  }

  // Takes a slot in the grant's window. → { limited, audit }: `audit` once per window
  // of refusals, so the line that says so cannot be the flood. Empty ones go as met.
  function takeAttempt(grantId) {
    const t = now();
    for (const [id, entry] of attempts) {
      while (entry.times.length && entry.times[0] <= t - ATTACH_WINDOW_MS) entry.times.shift();
      if (entry.times.length === 0 && entry.auditedUntil <= t) attempts.delete(id);
    }
    const entry = attempts.get(grantId) || { times: [], auditedUntil: 0 };
    attempts.set(grantId, entry);
    if (entry.times.length < ATTACH_LIMIT) {
      entry.times.push(t);
      return { limited: false, audit: false };
    }
    if (entry.auditedUntil > t) return { limited: true, audit: false };
    entry.auditedUntil = t + ATTACH_WINDOW_MS;
    return { limited: true, audit: true };
  }

  // R-RW-3's order: the token, the rate of asking, the scope, the node, the limits.
  function onMcpUpgrade(req, socket, head) {
    prepare(socket);
    const upgrade = checkUpgrade(req);
    const url = pathOf(req);
    if (!upgrade || !url || url.pathname !== WINDOW_PATH || !upgrade.offered.includes(PROTOCOL)
      || hostHeaderCount(req) !== 1 || requestHost(req) !== hostOf(resourceUrl())) {
      socket.destroy();
      return;
    }
    const bearer = BEARER_RE.exec(String(req.headers.authorization || ''));
    const rec = bearer && authorizationCount(req) === 1 && windowEnabled() ? tokens.authenticate(bearer[1], { aud: resourceUrl() }) : null;
    // No audit line: no token was shown and anyone may ask, so one here would let
    // anyone grow the ledger.
    if (!rec) {
      refuse(socket, upgrade, 4401, 'invalid_token');
      return;
    }
    const asked = url.searchParams.getAll('node');
    const nodeId = asked.length === 1 && NODE_ID_RE.test(asked[0]) ? asked[0] : null;
    const who = { grant_id: rec.grant_id, client_id: rec.client_id, node_id: nodeId };
    const attempt = takeAttempt(rec.grant_id);
    if (attempt.limited) {
      refuse(socket, upgrade, 4429, 'rate_limited', attempt.audit ? who : null);
      return;
    }
    const grant = grants.live(rec.grant_id);
    if (!grant) {
      refuse(socket, upgrade, 4403, 'grant_revoked', who);
      return;
    }
    if (!allows(rec.scopes, TOOL, { required: SCOPE }).ok) {
      refuse(socket, upgrade, 4403, 'insufficient_scope', who);
      return;
    }
    const node = nodeId ? registry.byId(nodeId) : null;
    if (!node || !allows(rec.scopes, TOOL, { required: SCOPE, machine: node.node_name }).ok || !grants.machineMatches(grant, SCOPE, node.node_name, node.node_id)) {
      refuse(socket, upgrade, 4403, 'unknown_machine', who);
      return;
    }
    // features.remoteWindow needs profile: agent, so a runbook node is not asked.
    if (node.profile !== 'agent') {
      refuse(socket, upgrade, 4403, 'remote_window_off', who);
      return;
    }
    const presence = registry.presence(node.node_id);
    if (!presence || presence.online !== true) {
      refuse(socket, upgrade, 4404, 'node_offline', who);
      return;
    }
    if (sessions.grantAtLimit(rec.grant_id)) {
      refuse(socket, upgrade, 4429, 'session_limit', who);
      return;
    }
    openSession(socket, head, upgrade, rec, node.node_id);
  }

  function nodeIdOfCertificate(socket) {
    const fingerprint = peerCertFingerprint(socket);
    if (!fingerprint) return null;
    let found = null;
    for (const peer of registry.peers()) {
      if (timingSafeHexEqual(peer.tlsFingerprint, fingerprint)) found = peer.nodeId;
    }
    return found;
  }

  // → false when the path is not this splice's. A path that is, whatever else is
  // wrong with the dial, is dealt with here and answers true.
  function onMeshUpgrade(req, socket, head) {
    const url = pathOf(req);
    if (!url || (url.pathname !== WINDOW_PATH && !url.pathname.startsWith(`${WINDOW_PATH}/`))) return false;
    prepare(socket);
    const match = MESH_PATH_RE.exec(url.pathname);
    const s = match ? live.get(match[1]) : null;
    const upgrade = checkUpgrade(req);
    let nodeId = null;
    try {
      nodeId = s ? nodeIdOfCertificate(socket) : null;
    } catch (err) {
      log.warn(`reading a dial-back's certificate failed: ${err.message}`);
    }
    // The first dial wins. A session id alone admits nobody: the certificate must
    // be that of the node the session names.
    if (!s || !upgrade || s.node || nodeId !== s.record.node_id) {
      socket.destroy();
      return true;
    }
    s.node = socket;
    writeSwitching(socket, upgrade);
    for (const bytes of s.early) socket.write(bytes);
    s.early = [];
    const gone = () => closeSession(s, 1001, 'node_gone');
    socket.once('end', gone);
    socket.once('close', gone);
    socket.on('data', (chunk) => fromNodeChunk(s, chunk));
    if (head && head.length > 0) fromNodeChunk(s, head);
    return true;
  }

  function closeForGrant(grantId) {
    for (const s of [...live.values()]) {
      if (s.record.grant_id === grantId) closeSession(s, 4403, 'grant_revoked');
    }
  }

  // Every deadline, against `now`. A grant revoked by a path that does not reach
  // closeForGrant, and a node taken off the registry, end here too. An access token
  // running out does not: a session is bound to its grant (R-RW-4).
  function sweep() {
    const t = now();
    for (const s of [...live.values()]) {
      if (!grants.live(s.record.grant_id)) closeSession(s, 4403, 'grant_revoked');
      else if (!registry.byId(s.record.node_id)) closeSession(s, 4403, 'unknown_machine');
      else if (!s.node && t >= s.dialBy) closeSession(s, 4408, 'node_did_not_dial');
      else if (s.node && t - s.lastActivity >= idleMs) closeSession(s, 1001, 'idle');
    }
  }

  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();

  function stop() {
    clearInterval(timer);
    for (const s of [...live.values()]) closeSession(s, 1001, 'frontdoor_stopping');
  }

  return { onMcpUpgrade, onMeshUpgrade, closeForGrant, sweep, stop, sessions };
}

module.exports = { createWindowSplice, RECORD_WIRE_MAX, PRE_READY_BYTES, ATTACH_LIMIT, ATTACH_WINDOW_MS };
