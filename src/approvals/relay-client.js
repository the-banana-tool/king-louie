// The node's one link to its relay (spec §3.11): a dial-out-only
// MeshTransport to the relay pinned by `pair`, or to the front door named in
// <configDir>/front-door.json when F4's transport can dial it (E7). It
// implements the link interface the PhoneApprover, F5 and C4 use.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { MeshTransport } = require('../mesh/mesh-transport');
const { derivePeerId } = require('../mesh/mesh-identity');
const { createLinkRpc, LinkRpcError } = require('./link-rpc');
const { writeFileAtomic } = require('./approver-store');

const log = createLogger('approvals/relay-client');

// F3's own link methods (§4.6); nobody else may register these names.
const F3_METHODS = new Set([
  'relay.hello', 'approval.submit', 'approval.status', 'approval.response', 'message.submit',
  'enroll.open', 'enroll.done', 'enroll.claim', 'device.enroll', 'device.revoke', 'device.state',
  'audit.slice', 'audit.head'
]);
const RESERVED_PREFIXES = ['mesh.task.', 'mesh.channel.'];
// relay → node methods answered by the onMessage handler (service-wiring).
const NODE_INBOUND = ['approval.response', 'enroll.claim', 'device.enroll', 'device.revoke', 'audit.slice', 'audit.head'];

function isReservedMethod(name) {
  return F3_METHODS.has(name) || RESERVED_PREFIXES.some((p) => String(name).startsWith(p));
}

function readFrontDoor(configDir) {
  if (!configDir) return null;
  const file = path.join(configDir, 'front-door.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`could not read ${file}: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    log.warn(`${file} exists but is not valid JSON: ${err.message}`);
    return null;
  }
}

class RelayClient extends EventEmitter {
  constructor({ identity, nodeName = null, relayPin = null, configDir = null, dataDir = null,
    transportFactory = (options) => new MeshTransport(options), useTls = true,
    reconnectDelays = [1000, 5000, 15000, 30000], callTimeoutMs = 10000, now = Date.now } = {}) {
    super();
    this.identity = identity;
    this.nodeName = nodeName || identity.nodeName;
    this.pin = relayPin;
    this.configDir = configDir;
    this.linkFile = dataDir ? path.join(dataDir, 'approvals', 'link.json') : null;
    this.transportFactory = transportFactory;
    this.useTls = useTls;
    this.reconnectDelays = reconnectDelays;
    this.callTimeoutMs = callTimeoutMs;
    this.now = now;
    this.connected = false;
    this.relayInfo = null;
    // Spec §3.11's pair record has no peerId; recompute it from the pinned
    // publicKey the same way the mesh itself assigns one (Task 22 carries
    // storing peerId going forward, but old/minimal pins must keep working).
    this.relayPeerId = relayPin ? (relayPin.peerId || derivePeerId(relayPin.publicKey)) : null;
    this.handler = null;
    this.methods = new Map();
    this.started = false;
    this.stopped = false;
    // Escalating-backoff state. dialAttempt resets to 0 only after a
    // successful hello; mismatched is sticky (a relay_id mismatch means a
    // relay bug or a corrupt pin, not a transient outage) until one
    // succeeds, and always redials at the longest delay, logging an error
    // every time — re-pairing can fix it at any moment, so this must never
    // stop trying, but it also must never look like ordinary reconnect noise.
    this.dialAttempt = 0;
    this.mismatched = false;
    this.dialing = false;
    this.pendingFailureReason = null;
    this.retryTimer = null;
    this.transport = null;
    this.rpc = null;
  }

  async start() {
    if (this.started) return; // idempotent: a second start() is a no-op
    if (!this.pin) throw new Error('RelayClient needs a relay pin (run `king-louie-service pair wss://…` first)');
    this.started = true;
    this.stopped = false;
    this.transport = this.transportFactory({ identity: this.identity, listen: false, useTls: this.useTls, port: 0 });
    this.rpc = createLinkRpc(this.transport, { defaultTimeoutMs: this.callTimeoutMs });
    const refuseUnlessLinked = (peerId) => {
      if (!this.connected || peerId !== this.relayPeerId) {
        throw new LinkRpcError('not_linked', 'the relay link is not established');
      }
    };
    for (const method of NODE_INBOUND) {
      this.rpc.handle(method, (params, { peerId }) => {
        refuseUnlessLinked(peerId);
        if (!this.handler) throw new LinkRpcError('not_ready', 'the node is not ready for relay messages');
        return this.handler(method, params);
      });
    }
    this.rpc.onUnhandled((method, params, { peerId }) => {
      refuseUnlessLinked(peerId);
      const handler = this.methods.get(method);
      if (!handler) throw new LinkRpcError('unknown_method', `no handler for ${method}`);
      return handler(params, { peer: peerId });
    });
    this.transport.on('peerConnected', (peer) => {
      if (peer.peerId !== this.relayPeerId) return;
      this._onConnected().catch((err) => log.warn(`relay hello handling failed unexpectedly: ${err.message}`));
    });
    this.transport.on('peerDisconnected', ({ peerId }) => {
      if (peerId !== this.relayPeerId) return;
      // A fresh dial already in flight, or a peer the transport still shows
      // as connected (a newer connection has already replaced this one):
      // this is a stale echo of an earlier disconnect, not a new one.
      if (this.dialing) return;
      if (this.transport.getPeer(peerId)) return;
      this._onDisconnected();
    });
    // No address on the trusted peer: this client, not the transport, decides
    // when to dial again.
    this.transport.addTrustedPeer(this.relayPeerId, this.pin.publicKey, { displayName: 'relay', tlsFingerprint: this.pin.tlsFingerprint || null });
    await this.transport.start();
    this._writeLink();
    this._dial();
  }

  // Single-flight: at most one dial attempt in progress at a time.
  _dial() {
    if (this.stopped || this.connected || this.dialing) return;
    this.dialing = true;
    const frontDoor = readFrontDoor(this.configDir);
    let attemptConnect;
    try {
      attemptConnect = frontDoor && typeof this.transport.connectPinned === 'function'
        ? this.transport.connectPinned(frontDoor)
        : this.transport.connectToPeer(this.pin.address, this.pin.port);
    } catch (err) {
      // connectPinned may throw synchronously instead of rejecting.
      attemptConnect = Promise.reject(err);
    }
    Promise.resolve(attemptConnect).then(
      () => { this.dialing = false; },
      (err) => {
        this.dialing = false;
        if (this.stopped) return;
        log.info(`relay not reachable (${err.message})`);
        this._handleLinkDown('connect_failed');
      }
    );
  }

  async _onConnected() {
    let hello;
    try {
      hello = await this.rpc.call(this.relayPeerId, 'relay.hello', { node_id: this.identity.nodeId, node_name: this.nodeName, versions: [1] });
    } catch (err) {
      log.warn(`relay hello failed: ${err.message}`);
      this._failLink('hello_failed');
      return;
    }
    if (!hello || hello.relay_id !== this.pin.relay_id) {
      log.error(`relay answered as ${hello && hello.relay_id}, but this node paired with ${this.pin.relay_id}; not using the link`);
      this._failLink('mismatch');
      return;
    }
    this.dialAttempt = 0;
    this.mismatched = false;
    this.connected = true;
    this.relayInfo = hello;
    this.since = new Date(this.now()).toISOString();
    this._writeLink();
    log.info(`linked to relay ${hello.relay_id}`);
    this.emit('connected');
  }

  // Drops the (transport-level connected, but not usable) peer and lets the
  // 'peerDisconnected' that produces drive the actual redial — one path, so
  // there is exactly one place that schedules it.
  _failLink(reason) {
    this.pendingFailureReason = reason;
    if (this.transport && typeof this.transport.disconnectPeer === 'function') {
      this.transport.disconnectPeer(this.relayPeerId);
    }
  }

  _onDisconnected() {
    const was = this.connected;
    this.connected = false;
    this._writeLink();
    if (was) this.emit('disconnected');
    const reason = this.pendingFailureReason || 'link_down';
    this.pendingFailureReason = null;
    this._handleLinkDown(reason);
  }

  _handleLinkDown(reason) {
    if (this.stopped) return;
    if (reason === 'mismatch') this.mismatched = true;
    const delay = this.mismatched
      ? this.reconnectDelays[this.reconnectDelays.length - 1]
      : this.reconnectDelays[Math.min(this.dialAttempt, this.reconnectDelays.length - 1)];
    if (!this.mismatched) this.dialAttempt += 1;
    const logAt = this.mismatched ? log.error : log.info;
    logAt(`relay link down (${reason}); retrying in ${delay} ms`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._dial(), delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  _writeLink() {
    if (!this.linkFile) return;
    try {
      fs.mkdirSync(path.dirname(this.linkFile), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.linkFile, `${JSON.stringify({
        connected: this.connected,
        since: this.connected ? this.since : null,
        relay_id: this.pin.relay_id,
        relay_public_url: this.relayInfo ? this.relayInfo.public_url : null,
        relay_spki: this.relayInfo ? this.relayInfo.phone_spki : null
      })}\n`);
    } catch (err) {
      log.warn(`could not write ${this.linkFile}: ${err.message}`);
    }
  }

  async stop() {
    this.started = false;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const was = this.connected;
    this.connected = false;
    try {
      if (this.rpc) this.rpc.close();
      if (this.transport) await this.transport.stop();
    } finally {
      this._writeLink();
    }
    if (was) this.emit('disconnected');
  }

  // ── Link interface ────────────────────────────────────────────────────────

  isConnected() {
    return this.connected;
  }

  // ok once paired, even while disconnected: requests wait for the link (R16).
  canDeliver() {
    return this.pin ? { ok: true } : { ok: false, reason: 'no relay is paired with this node' };
  }

  call(method, params = {}, { timeoutMs = this.callTimeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new LinkRpcError('relay_offline', 'the relay link is down'));
    return this.rpc.call(this.relayPeerId, method, params, { timeoutMs });
  }

  notify(method, params = {}) {
    if (!this.connected) {
      log.debug(`notify ${method} dropped: the relay link is down`);
      return;
    }
    this.rpc.notify(this.relayPeerId, method, params);
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

  // F3's relay → node methods: handler(method, params) → result.
  onMessage(handler) {
    this.handler = handler;
  }

  // Extension methods (E5): F4, F5 and C4 mount their own relay → node methods.
  registerMethod(name, handler) {
    if (isReservedMethod(name)) {
      throw Object.assign(new Error(`method_reserved: ${name} belongs to the approval link or the mesh`), { code: 'method_reserved' });
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`registerMethod(${name}): handler must be a function`);
    }
    if (this.methods.has(name)) {
      throw Object.assign(new Error(`method_exists: ${name} is already registered`), { code: 'method_exists' });
    }
    this.methods.set(name, handler);
  }
}

module.exports = { RelayClient, isReservedMethod, F3_METHODS, NODE_INBOUND, readFrontDoor };
