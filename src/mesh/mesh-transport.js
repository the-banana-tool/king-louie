const { EventEmitter } = require('events');
const https = require('https');
const WebSocket = require('ws');
const { MeshIdentity } = require('./mesh-identity');

const DEFAULT_PORT = 18791;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;
const RECONNECT_DELAYS = [5000, 10000, 20000, 60000];
const AUTH_TIMEOUT_MS = 10000;
const NONCE_WINDOW_SIZE = 1000;

class MeshTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.identity = config.identity;
    this.port = config.port || DEFAULT_PORT;
    this.host = config.host || '0.0.0.0';
    this.trustedPeers = config.trustedPeers || new Map();
    this.useTls = config.useTls !== false; // TLS on by default

    this.httpsServer = null;
    this.server = null;
    this.peers = new Map();
    this.pendingAuth = new Map();
    this.reconnectTimers = new Map();
    this.heartbeatInterval = null;
    this.seenNonces = new Set();
    this.running = false;
    this.onPairingRequest = null; // set by MeshPairing to handle pair:request messages
  }

  async start() {
    if (this.server) return;

    if (this.useTls && this.identity.tlsCert && this.identity.tlsKey) {
      // TLS mode: HTTPS server → WSS
      this.httpsServer = https.createServer({
        cert: this.identity.tlsCert,
        key: this.identity.tlsKey
      });

      this.server = new WebSocket.Server({ server: this.httpsServer });

      this.server.on('connection', (ws, req) => {
        this._handleInboundConnection(ws, req);
      });

      await new Promise((resolve, reject) => {
        this.httpsServer.listen(this.port, this.host, resolve);
        this.httpsServer.once('error', reject);
      });

      console.log(`[mesh] transport listening on wss://${this.host}:${this.port} (TLS)`);
    } else {
      // Fallback: plain WS (for tests or when TLS certs not available)
      this.server = new WebSocket.Server({
        host: this.host,
        port: this.port
      });

      this.server.on('connection', (ws, req) => {
        this._handleInboundConnection(ws, req);
      });

      await new Promise((resolve, reject) => {
        this.server.once('listening', resolve);
        this.server.once('error', reject);
      });

      console.log(`[mesh] transport listening on ws://${this.host}:${this.port} (no TLS)`);
    }

    this.running = true;
    this._startHeartbeat();
  }

  async stop() {
    this.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const peer of this.peers.values()) {
      try { peer.ws.close(); } catch { /* ignore */ }
    }
    this.peers.clear();

    for (const pending of this.pendingAuth.values()) {
      try { pending.ws.close(); } catch { /* ignore */ }
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    this.pendingAuth.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    if (this.httpsServer) {
      await new Promise((resolve) => this.httpsServer.close(resolve));
      this.httpsServer = null;
    }

    console.log('[mesh] transport stopped');
  }

  // --- Peer Management ---

  addTrustedPeer(peerId, publicKey, metadata = {}) {
    this.trustedPeers.set(peerId, {
      peerId,
      publicKey: typeof publicKey === 'string' ? publicKey : publicKey.toString('hex'),
      displayName: metadata.displayName || '',
      capabilities: metadata.capabilities || [],
      tlsFingerprint: metadata.tlsFingerprint || null,
      address: metadata.address || null,
      port: metadata.port || null,
      addedAt: Date.now()
    });
  }

  removeTrustedPeer(peerId) {
    this.trustedPeers.delete(peerId);
    const peer = this.peers.get(peerId);
    if (peer) {
      try { peer.ws.close(); } catch { /* ignore */ }
      this.peers.delete(peerId);
    }
  }

  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  getConnectedPeers() {
    return Array.from(this.peers.values()).map((p) => ({
      peerId: p.peerId,
      displayName: p.displayName,
      capabilities: p.capabilities,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      tlsVerified: p.tlsVerified || false
    }));
  }

  // --- Connect to a peer ---

  async connectToPeer(address, port) {
    const protocol = this.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${address}:${port}`;
    console.log(`[mesh] connecting to ${url}`);

    return new Promise((resolve, reject) => {
      const wsOptions = {};

      if (this.useTls) {
        // Accept self-signed certs — we verify via fingerprint pinning, not CA
        wsOptions.rejectUnauthorized = false;
      }

      const ws = new WebSocket(url, wsOptions);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timeout to ${url}`));
      }, AUTH_TIMEOUT_MS);

      ws.on('open', () => {
        // If TLS, capture the server's certificate fingerprint for pinning
        let serverCertFingerprint = null;
        if (this.useTls && ws._socket) {
          const peerCert = ws._socket.getPeerCertificate(true);
          if (peerCert && peerCert.raw) {
            const crypto = require('crypto');
            serverCertFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
          }
        }

        this._initiateAuth(ws, address, port, timeout, resolve, reject, serverCertFingerprint);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _initiateAuth(ws, address, port, timeout, resolve, reject, serverCertFingerprint) {
    const challenge = this.identity.generateChallenge();
    const authId = `auth-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    this.pendingAuth.set(authId, {
      ws,
      challenge,
      address,
      port,
      timeout,
      resolve,
      reject,
      direction: 'outbound',
      serverCertFingerprint
    });

    ws.send(JSON.stringify({
      type: 'auth:challenge',
      authId,
      challenge: challenge.toString('hex'),
      identity: this.identity.getPublicIdentity()
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'auth:response') {
          this._handleAuthResponse(authId, msg);
        } else if (msg.type === 'auth:complete') {
          this._handleAuthComplete(authId, msg);
        }
      } catch (err) {
        console.error('[mesh] auth message parse error:', err.message);
      }
    });
  }

  // --- Inbound connection handling ---

  _handleInboundConnection(ws, _req) {
    const authTimeout = setTimeout(() => {
      ws.close();
    }, AUTH_TIMEOUT_MS);

    const onMessage = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'pair:request' && this.onPairingRequest) {
          clearTimeout(authTimeout);
          this.onPairingRequest(ws, msg);
        } else if (msg.type === 'auth:challenge') {
          clearTimeout(authTimeout);
          this._respondToChallenge(ws, msg);
        }
      } catch (err) {
        console.error('[mesh] inbound auth parse error:', err.message);
        ws.close();
      }
    };

    ws.on('message', onMessage);
  }

  _respondToChallenge(ws, msg) {
    const { authId, challenge, identity: remoteIdentity } = msg;

    const trusted = this.trustedPeers.get(remoteIdentity.peerId);
    if (!trusted) {
      ws.send(JSON.stringify({ type: 'auth:reject', reason: 'not_trusted' }));
      ws.close();
      return;
    }

    // Verify TLS fingerprint if we have one pinned
    if (this.useTls && trusted.tlsFingerprint && remoteIdentity.tlsFingerprint) {
      if (trusted.tlsFingerprint !== remoteIdentity.tlsFingerprint) {
        console.warn(`[mesh] TLS fingerprint mismatch for ${remoteIdentity.peerId} - possible impersonation`);
        ws.send(JSON.stringify({ type: 'auth:reject', reason: 'tls_fingerprint_mismatch' }));
        ws.close();
        return;
      }
    }

    const challengeBuffer = Buffer.from(challenge, 'hex');
    const signature = this.identity.signChallenge(challengeBuffer);

    const myChallenge = this.identity.generateChallenge();

    this.pendingAuth.set(authId, {
      ws,
      challenge: myChallenge,
      remoteIdentity,
      direction: 'inbound',
      timeout: setTimeout(() => {
        this.pendingAuth.delete(authId);
        ws.close();
      }, AUTH_TIMEOUT_MS)
    });

    ws.send(JSON.stringify({
      type: 'auth:response',
      authId,
      signature: signature.toString('hex'),
      challenge: myChallenge.toString('hex'),
      identity: this.identity.getPublicIdentity()
    }));

    ws.removeAllListeners('message');
    ws.on('message', (data) => {
      try {
        const resp = JSON.parse(data);
        if (resp.type === 'auth:complete') {
          this._handleAuthComplete(authId, resp);
        } else if (resp.type && this.peers.has(remoteIdentity.peerId)) {
          this._handlePeerMessage(remoteIdentity.peerId, resp);
        }
      } catch (err) { console.debug('[mesh-transport] inbound message parse error:', err.message); }
    });
  }

  _handleAuthResponse(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'outbound') return;

    const { signature, challenge: theirChallenge, identity: remoteIdentity } = msg;

    const trusted = this.trustedPeers.get(remoteIdentity.peerId);
    if (!trusted) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Peer ${remoteIdentity.peerId} is not trusted`));
      return;
    }

    // Verify pinned TLS cert fingerprint against the actual server cert
    if (this.useTls && trusted.tlsFingerprint && pending.serverCertFingerprint) {
      if (trusted.tlsFingerprint !== pending.serverCertFingerprint) {
        pending.ws.close();
        this.pendingAuth.delete(authId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`TLS certificate fingerprint mismatch for ${remoteIdentity.peerId} - connection rejected`));
        return;
      }
    }

    // If we don't have a pinned fingerprint yet, pin it now (trust on first use)
    if (this.useTls && !trusted.tlsFingerprint && pending.serverCertFingerprint) {
      trusted.tlsFingerprint = pending.serverCertFingerprint;
    }

    // Also store the peer's declared TLS fingerprint for future inbound verification
    if (remoteIdentity.tlsFingerprint && !trusted.tlsFingerprint) {
      trusted.tlsFingerprint = remoteIdentity.tlsFingerprint;
    }

    const valid = MeshIdentity.verifyChallenge(
      pending.challenge,
      signature,
      trusted.publicKey
    );

    if (!valid) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Challenge verification failed'));
      return;
    }

    const mySignature = this.identity.signChallenge(
      Buffer.from(theirChallenge, 'hex')
    );

    pending.ws.send(JSON.stringify({
      type: 'auth:complete',
      authId,
      signature: mySignature.toString('hex')
    }));

    this._promoteToPeer(authId, pending.ws, remoteIdentity, pending);
  }

  _handleAuthComplete(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'inbound') return;

    const { signature } = msg;
    const trusted = this.trustedPeers.get(pending.remoteIdentity.peerId);
    if (!trusted) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      return;
    }

    const valid = MeshIdentity.verifyChallenge(
      pending.challenge,
      signature,
      trusted.publicKey
    );

    if (!valid) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      return;
    }

    this._promoteToPeer(authId, pending.ws, pending.remoteIdentity, pending);
  }

  _promoteToPeer(authId, ws, remoteIdentity, pending) {
    clearTimeout(pending.timeout);
    this.pendingAuth.delete(authId);

    const existingPeer = this.peers.get(remoteIdentity.peerId);
    if (existingPeer) {
      try { existingPeer.ws.close(); } catch { /* ignore */ }
    }

    const tlsVerified = this.useTls && (
      (pending.serverCertFingerprint != null) || // outbound: we saw their cert
      (remoteIdentity.tlsFingerprint != null)     // inbound: they declared fingerprint
    );

    const peerInfo = {
      peerId: remoteIdentity.peerId,
      displayName: remoteIdentity.displayName || '',
      capabilities: remoteIdentity.capabilities || [],
      publicKey: remoteIdentity.publicKey,
      tlsFingerprint: remoteIdentity.tlsFingerprint || pending.serverCertFingerprint || null,
      tlsVerified,
      ws,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      address: pending.address || null,
      port: pending.port || null
    };

    this.peers.set(remoteIdentity.peerId, peerInfo);

    ws.removeAllListeners('message');
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handlePeerMessage(remoteIdentity.peerId, msg);
      } catch (err) { console.debug('[mesh-transport] peer message parse error:', err.message); }
    });

    ws.on('close', () => {
      this._handlePeerDisconnect(remoteIdentity.peerId, peerInfo);
    });

    ws.on('error', (err) => {
      this.emit('peerError', { peerId: remoteIdentity.peerId, error: err });
    });

    const tlsLabel = tlsVerified ? ', TLS verified' : (this.useTls ? ', TLS' : '');
    console.log(`[mesh] peer authenticated: ${remoteIdentity.peerId} (${remoteIdentity.displayName || 'unnamed'}${tlsLabel})`);
    this.emit('peerConnected', peerInfo);

    if (pending.resolve) {
      pending.resolve(peerInfo);
    }
  }

  // --- Messaging ---

  send(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Peer not connected: ${peerId}`);
    }

    const envelope = MeshIdentity.createEnvelope(this.identity, peerId, payload);
    peer.ws.send(JSON.stringify({ type: 'mesh:message', envelope }));
    return envelope;
  }

  broadcast(payload) {
    const results = [];
    for (const [peerId] of this.peers) {
      try {
        results.push({ peerId, envelope: this.send(peerId, payload) });
      } catch (err) {
        results.push({ peerId, error: err.message });
      }
    }
    return results;
  }

  _handlePeerMessage(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.lastSeen = Date.now();

    if (msg.type === 'mesh:heartbeat') {
      return;
    }

    if (msg.type === 'mesh:message') {
      const { envelope } = msg;

      if (this.seenNonces.has(envelope.nonce)) {
        return; // replay
      }

      const trusted = this.trustedPeers.get(peerId);
      if (!trusted) return;

      const verification = MeshIdentity.verifyEnvelope(envelope, trusted.publicKey);
      if (!verification.valid) {
        console.warn(`[mesh] invalid envelope from ${peerId}: ${verification.reason}`);
        return;
      }

      this.seenNonces.add(envelope.nonce);
      this._pruneNonces();

      this.emit('peerMessage', {
        from: peerId,
        payload: envelope.payload,
        envelope
      });
    }
  }

  _pruneNonces() {
    if (this.seenNonces.size > NONCE_WINDOW_SIZE) {
      const excess = this.seenNonces.size - NONCE_WINDOW_SIZE;
      const iterator = this.seenNonces.values();
      for (let i = 0; i < excess; i++) {
        this.seenNonces.delete(iterator.next().value);
      }
    }
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastSeen > HEARTBEAT_TIMEOUT_MS) {
          console.log(`[mesh] peer timed out: ${peerId}`);
          try { peer.ws.close(); } catch { /* ignore */ }
          this.peers.delete(peerId);
          this.emit('peerDisconnected', { peerId, reason: 'timeout' });
          this._scheduleReconnect(peerId);
          continue;
        }

        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat' }));
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // --- Reconnection ---

  _handlePeerDisconnect(peerId, peerInfo) {
    this.peers.delete(peerId);
    console.log(`[mesh] peer disconnected: ${peerId}`);
    this.emit('peerDisconnected', { peerId, reason: 'closed' });

    if (peerInfo.address && peerInfo.port) {
      this._scheduleReconnect(peerId);
    }
  }

  _scheduleReconnect(peerId, attempt = 0) {
    if (!this.running) return;

    const trusted = this.trustedPeers.get(peerId);
    if (!trusted || !trusted.address || !trusted.port) return;

    if (this.peers.has(peerId)) return;

    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    console.log(`[mesh] reconnecting to ${peerId} in ${delay / 1000}s (attempt ${attempt + 1})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(peerId);
      if (!this.running || this.peers.has(peerId)) return;

      try {
        await this.connectToPeer(trusted.address, trusted.port);
      } catch {
        this._scheduleReconnect(peerId, attempt + 1);
      }
    }, delay);

    this.reconnectTimers.set(peerId, timer);
  }

  // --- RPC Helpers ---

  async sendRpc(peerId, method, params = {}) {
    const id = `rpc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('peerMessage', handler);
        reject(new Error(`RPC timeout: ${method} to ${peerId}`));
      }, 30000);

      const handler = (msg) => {
        if (msg.from !== peerId) return;
        if (msg.payload?.id !== id) return;

        clearTimeout(timeout);
        this.removeListener('peerMessage', handler);

        if (msg.payload.error) {
          reject(new Error(msg.payload.error));
        } else {
          resolve(msg.payload.result);
        }
      };

      this.on('peerMessage', handler);

      try {
        this.send(peerId, { method, params, id });
      } catch (err) {
        clearTimeout(timeout);
        this.removeListener('peerMessage', handler);
        reject(err);
      }
    });
  }

  sendRpcResponse(peerId, id, result, error = null) {
    const payload = error
      ? { id, error: typeof error === 'string' ? error : error.message }
      : { id, result };
    this.send(peerId, payload);
  }
}

module.exports = { MeshTransport, DEFAULT_PORT };
