// src/session/connection.js
// The helper side of kl-session-v1 (fleet stage 5 spec §3.2, §3.3). The
// helper authenticates the service before it sends anything but `hello`,
// and runs only what the service asks, through its OS backend.
const { EventEmitter } = require('events');
const netModule = require('net');
const { createLogger } = require('../logging');
const P = require('../gui/helper-protocol');
const { GuiError, isGuiError } = require('../gui/errors');
const { assertPathsUnchanged } = require('../gui/apps');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createOpHandler(backend, { platform = process.platform } = {}) {
  const ops = {
    launch: (p) => {
      // Re-resolved here, as the user, just before spawning (§3.4).
      assertPathsUnchanged({ exe: p.exe, files: p.files || [] }, { platform });
      return backend.launch({ exe: p.exe, argv: p.argv || [], files: p.files || [] });
    },
    processes: (p) => backend.processes({ match: p.match || [] }),
    windows: (p) => backend.windows({ pids: p.pids || [] }),
    foreground: () => backend.foreground(),
    focus: (p) => backend.focus({ handle: p.handle }),
    close: (p) => backend.close({ pids: p.pids || [], force: p.force === true }),
    screenshot: (p) => backend.screenshot({ handle: p.handle, maxWidth: p.max_width, quality: p.quality }),
    input: (p) => backend.input({ expect: p.expect, action: p.action, yieldMs: p.yield_ms }),
    release_all: () => backend.releaseAll(),
    probe: () => backend.probe()
  };
  return async (op, params = {}) => {
    if (!Object.hasOwn(ops, op)) throw new GuiError('unknown_op', String(op).slice(0, 32));
    if (!backend) throw new GuiError('capability_unavailable', 'gui');
    return ops[op](isPlainObject(params) ? params : {});
  };
}

class HelperSession extends EventEmitter {
  constructor(socket, sealer, opener, decoder, handleOp, log) {
    super();
    Object.assign(this, { socket, sealer, opener, decoder, handleOp, log, closed: false });
  }

  _send(obj) {
    if (!this.closed) this.socket.write(this.sealer.seal(obj));
  }

  sendEvent(kind, data = {}) {
    this._send({ t: 'event', kind, data });
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('closed', reason);
  }

  _onFrame(body) {
    const msg = this.opener.open(body);
    if (msg.t === 'ping') { this._send({ t: 'pong' }); return; }
    if (msg.t === 'pong') return;
    if (msg.t !== 'req' || !Number.isInteger(msg.id)) throw new GuiError('frame_rejected', 'unexpected frame');
    Promise.resolve()
      .then(() => this.handleOp(msg.op, msg.params, { jobId: msg.job_id || null, leaseId: msg.lease_id || null }))
      .then((result) => this._send({ t: 'res', id: msg.id, ok: true, result: result === undefined ? null : result }))
      .catch((err) => {
        const code = isGuiError(err) ? err.code : 'backend_failed';
        if (!isGuiError(err)) this.log.warn(`${msg.op} failed: ${err.message}`);
        this._send({ t: 'res', id: msg.id, ok: false, error: { code, message: String(err.message || code).slice(0, 300), detail: isGuiError(err) ? err.info || {} : {} } });
      });
  }
}

function connectToService({ endpoint, secret, nodeId, user, platform = process.platform, pid = process.pid, helperVersion = 'unknown',
  probeReport, handleOp, net = netModule, handshakeMs = 5000, log = createLogger('session-helper/connection') }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const decoder = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    const nonceH = P.randomNonce();
    let state = 'challenge';
    let session = null;
    let nonceS = null;
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      if (session) session.close(err.message);
      else reject(err);
    };
    const timer = setTimeout(() => fail(new GuiError('op_timeout', 'handshake')), handshakeMs);
    socket.on('error', (err) => fail(new GuiError('helper_disconnected', err.code || err.message)));
    socket.on('close', () => {
      clearTimeout(timer);
      if (session) session.close('disconnected');
      else reject(new GuiError('helper_disconnected', 'the service closed the connection'));
    });
    socket.on('connect', () => {
      socket.write(P.encodeFrame({ t: 'hello', v: 1, node_id: nodeId, nonce_h: nonceH, pid, user, platform, helper_version: helperVersion }));
    });
    socket.on('data', (chunk) => {
      try {
        decoder.push(chunk);
        let body;
        while ((body = decoder.next())) {
          if (state === 'ready') { session._onFrame(body); continue; }
          const msg = P.parsePlain(body);
          if (state === 'challenge') {
            if (msg.t !== 'challenge' || !P.NONCE_RE.test(String(msg.nonce_s))) throw new GuiError('frame_rejected', 'expected challenge');
            // The service proves itself first; a wrong proof sends nothing more.
            if (!P.proofEquals(msg.proof_s, P.serviceProof(secret, nodeId, nonceH, msg.nonce_s))) throw new GuiError('auth_failed', 'service');
            nonceS = msg.nonce_s;
            socket.write(P.encodeFrame({ t: 'auth', proof_h: P.helperProof(secret, nodeId, nonceS, nonceH) }));
            state = 'ready_wait';
            continue;
          }
          if (state === 'ready_wait') {
            if (msg.t === 'error') throw new GuiError(msg.code === 'helper_already_connected' ? 'helper_already_connected' : 'auth_failed', msg.code === 'helper_already_connected' ? null : 'service');
            if (msg.t !== 'ready') throw new GuiError('frame_rejected', 'expected ready');
            const { kSh, kHs } = P.deriveSessionKeys(secret, nodeId, nonceH, nonceS);
            decoder.setMax(P.SEALED_MAX);
            session = new HelperSession(socket, P.createSealer(kHs, P.DIR_HS), P.createOpener(kSh, P.DIR_SH), decoder, handleOp, log);
            state = 'ready';
            clearTimeout(timer);
            session._send({ t: 'probe_report', ...probeReport });
            resolve(session);
          }
        }
      } catch (err) {
        fail(isGuiError(err) ? err : new GuiError('frame_rejected', err.message));
      }
    });
  });
}

module.exports = { connectToService, createOpHandler, HelperSession };
