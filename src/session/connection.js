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

// Ops whose failure is answered and logged by its code alone: an input's
// error can quote the key (R-F5-16); the take ops' can quote the argv, a
// path or ffmpeg's stderr (demo takes, Task 9).
const QUIET_OPS = new Set(['input', 'launch_browser', 'record_start', 'record_stop', 'keep_awake']);

// After the service connection has been gone this long, the helper stops
// its recordings (demo takes spec §9). A reconnect before then keeps them.
const RECORDING_GRACE_MS = 30000;

// `recorder`: what the helper found at startup ({ ffmpeg: <path> | null });
// a record_start that names no ffmpeg uses it.
function createOpHandler(backend, { platform = process.platform, realpath, recorder = { ffmpeg: null } } = {}) {
  const pathOptions = { platform, ...(realpath ? { realpath } : {}) };
  const ops = {
    launch: (p) => {
      // Re-resolved here, as the user, just before spawning (§3.4).
      assertPathsUnchanged({ exe: p.exe, files: p.files || [] }, pathOptions);
      return backend.launch({ exe: p.exe, argv: p.argv || [], files: p.files || [] });
    },
    launch_browser: (p) => {
      // The browser is an allowlisted app: re-resolved as launch's exe is.
      assertPathsUnchanged({ exe: p.exe, files: [] }, pathOptions);
      return backend.launchBrowser({ exe: p.exe, profile: p.profile, args: p.args || [] });
    },
    record_start: (p) => backend.recordStart({
      ffmpeg: p.ffmpeg || (recorder && recorder.ffmpeg) || null,
      takeId: p.take_id,
      path: p.path === undefined ? null : p.path,
      fps: p.fps,
      size: p.size === undefined ? null : p.size
    }),
    record_stop: (p) => backend.recordStop({ pid: p.pid }),
    keep_awake: (p) => backend.keepAwake({ on: p.on === true }),
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

// The 30 s rule (demo takes spec §9): `disconnected()` when the service
// connection closes arms one timer; `connected()` clears it; when it fires,
// every live recording is stopped. `stop()` (the helper ending) stops them
// at once. The timer is ref'd: the helper is running its reconnect loop.
function createRecordingGuard({ backend, timers = { setTimeout, clearTimeout }, graceMs = RECORDING_GRACE_MS, log = createLogger('session-helper/recordings') } = {}) {
  let timer = null;
  const stopAll = async () => {
    if (!backend || typeof backend.stopRecordings !== 'function') return;
    try {
      await backend.stopRecordings();
    } catch (err) {
      log.warn(`stopping recordings failed (${(err && err.code) || 'error'})`);
    }
  };
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  return {
    connected: clear,
    disconnected() {
      if (timer !== null) return;
      timer = timers.setTimeout(() => { timer = null; stopAll(); }, graceMs);
    },
    async stop() {
      clear();
      await stopAll();
    }
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
        // An input's failure is logged and answered by its code alone
        // (R-F5-16): a backend's own error can quote the command it ran, and
        // for a key press that command names the key.
        const quiet = QUIET_OPS.has(msg.op);
        if (!isGuiError(err)) this.log.warn(quiet ? `${msg.op} failed (${err.code || err.name || 'error'})` : `${msg.op} failed: ${err.message}`);
        this._send({ t: 'res', id: msg.id, ok: false, error: { code, message: quiet ? code : String(err.message || code).slice(0, 300), detail: isGuiError(err) ? err.info || {} : {} } });
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

module.exports = { connectToService, createOpHandler, createRecordingGuard, HelperSession, QUIET_OPS, RECORDING_GRACE_MS };
