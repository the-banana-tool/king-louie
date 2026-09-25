// The relay's side of the node links (E3): a MeshTransport listening on
// relay.mesh_listen, MeshPairing for first contact, and a registry of paired
// nodes (<relayData>/relay/nodes.json, unique by name). F4 can replace the
// registry file with its own peer source.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { deriveNodeId } = require('../mesh/node-identity');
const { derivePeerId } = require('../mesh/mesh-identity');
const { createLinkRpc, LinkRpcError } = require('../approvals/link-rpc');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/node-hub');

const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// A `relay code` file is a few dozen bytes; anything much larger is not one.
const MAX_CODE_FILE_BYTES = 4096;

// A registry row is only trusted when its ids really derive from its key:
// nodes.json lives in the service-writable data dir, and node_id is what
// every signature check on the link is keyed on.
function isValidEntry(n) {
  try {
    return n !== null && typeof n === 'object' && typeof n.node_name === 'string' && NODE_NAME_RE.test(n.node_name)
      && typeof n.public_key === 'string' && n.node_id === deriveNodeId(n.public_key) && n.peer_id === derivePeerId(n.public_key);
  } catch {
    return false;
  }
}

class NodeHub extends EventEmitter {
  constructor({ identity, transport, pairing, registryFile, peerSource = null, codesDir = null, codePollMs = 1000 } = {}) {
    super();
    this.identity = identity;
    this.transport = transport;
    this.pairing = pairing;
    this.registryFile = registryFile;
    this.peerSource = peerSource;
    this.codesDir = codesDir;
    this.codePollMs = codePollMs;
    this.registry = [];
    this.handlers = new Map();
    this.rpcLink = createLinkRpc(transport);
    this.codeTimer = null;
    this._onChange = () => this._loadPeers();
  }

  _loadRegistry() {
    if (this.peerSource) return;
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.registryFile, 'utf8')).nodes || [];
    } catch {
      rows = [];
    }
    const valid = Array.isArray(rows) ? rows.filter(isValidEntry) : [];
    if (Array.isArray(rows) && valid.length !== rows.length) log.warn(`ignoring ${rows.length - valid.length} malformed node registry entries`);
    this.registry = valid;
  }

  _saveRegistry() {
    if (this.peerSource) return;
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.registryFile, `${JSON.stringify({ nodes: this.registry }, null, 2)}\n`);
  }

  // F4's peer source: { list() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }], on('change') }.
  _loadPeers() {
    if (this.peerSource) {
      this.registry = this.peerSource.list().map((p) => ({
        node_id: p.nodeId, node_name: p.name, public_key: p.publicKeyHex, peer_id: p.peerId, tls_fingerprint: p.tlsFingerprint || null, paired_at: null
      }));
    }
    for (const n of this.registry) this._trust(n);
  }

  _trust(n) {
    this.transport.addTrustedPeer(n.peer_id, n.public_key, { displayName: n.node_name, tlsFingerprint: n.tls_fingerprint || null });
  }

  async start({ listen = true } = {}) {
    this._loadRegistry();
    this._loadPeers();
    if (this.peerSource && typeof this.peerSource.on === 'function') this.peerSource.on('change', this._onChange);
    this.transport.onPairingRequest = (ws, msg) => this._onPairingRequest(ws, msg);
    this.transport.on('peerConnected', (peer) => {
      const node = this.nodeByPeer(peer.peerId);
      if (node) this.emit('connection', { nodeId: node.node_id, connected: true });
    });
    this.transport.on('peerDisconnected', ({ peerId }) => {
      const node = this.nodeByPeer(peerId);
      if (node) this.emit('connection', { nodeId: node.node_id, connected: false });
    });
    this.rpcLink.onUnhandled((method, params, { peerId }) => {
      const node = this.nodeByPeer(peerId);
      if (!node) throw new LinkRpcError('unknown_node', 'this peer is not a paired node');
      const handler = this.handlers.get(method);
      if (!handler) throw new LinkRpcError('unknown_method', `the relay has no handler for ${method}`);
      return handler(params, { nodeId: node.node_id });
    });
    if (listen) await this.transport.start();
    if (this.codesDir) {
      this.codeTimer = setInterval(() => this._pickUpCodes(), this.codePollMs);
      if (typeof this.codeTimer.unref === 'function') this.codeTimer.unref();
      this._pickUpCodes();
    }
  }

  async stop() {
    clearInterval(this.codeTimer);
    if (this.peerSource && typeof this.peerSource.removeListener === 'function') this.peerSource.removeListener('change', this._onChange);
    this.rpcLink.close();
    this.pairing.cleanup();
    await this.transport.stop();
  }

  // `relay code <name>` drops { code, node_name, expires_at } files here.
  // The directory is in the data dir, so every entry is untrusted: only
  // small regular files are read, and a pairing code is never logged.
  _pickUpCodes() {
    let names = [];
    try {
      names = fs.readdirSync(this.codesDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.codesDir, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > MAX_CODE_FILE_BYTES) throw new Error('not a small regular file');
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          // Never the parser's own message: it quotes the file, i.e. the code.
          throw new Error('unreadable');
        }
        const { code, node_name: nodeName, expires_at: expiresAt } = parsed || {};
        if (typeof code !== 'string' || !code.trim() || typeof nodeName !== 'string' || !NODE_NAME_RE.test(nodeName)) throw new Error('malformed');
        if (!(Date.parse(expiresAt) > Date.now())) throw new Error('expired');
        if (this.nodeByName(nodeName)) throw new Error(`a node named "${nodeName}" is already paired`);
        this.pairing.addCode(code, { nodeName });
      } catch (err) {
        log.warn(`ignoring a pairing code file: ${err.message}`);
      }
      try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
    }
  }

  _onPairingRequest(ws, msg) {
    const info = this.pairing.handlePairingRequest(ws, msg);
    if (!info) return;
    const nodeName = (info.meta && info.meta.nodeName) || info.nodeName;
    let nodeId = null;
    let problem = null;
    try {
      nodeId = deriveNodeId(info.publicKey);
      if (info.peerId !== derivePeerId(info.publicKey)) problem = 'peer id does not derive from the key';
    } catch {
      problem = 'not an Ed25519 node key';
    }
    if (!problem && (typeof nodeName !== 'string' || !NODE_NAME_RE.test(nodeName))) problem = 'bad node name';
    if (!problem && this.nodeByName(nodeName)) problem = 'name_taken';
    if (!problem && this.nodeById(nodeId)) problem = 'this node is already paired under another name';
    if (problem) {
      log.warn(`pairing ignored: ${problem}`);
      // MeshPairing already trusted the peer. Take that back, unless the
      // peer id is a node that is already paired: then put its registered
      // entry back rather than evicting it.
      const existing = this.nodeByPeer(info.peerId);
      if (existing) this._trust(existing);
      else this.transport.removeTrustedPeer(info.peerId);
      return;
    }
    this.registry.push({ node_id: nodeId, node_name: nodeName, public_key: info.publicKey, peer_id: info.peerId, tls_fingerprint: info.tlsFingerprint || null, paired_at: new Date().toISOString() });
    this._saveRegistry();
    log.info(`paired node ${nodeName} (${nodeId})`);
    this.emit('paired', { nodeId, nodeName });
  }

  nodes() {
    const online = new Set(this.transport.getConnectedPeers().map((p) => p.peerId));
    return this.registry.map((n) => ({ node_id: n.node_id, node_name: n.node_name, public_key: n.public_key, online: online.has(n.peer_id) }));
  }

  nodeById(nodeId) {
    return this.registry.find((n) => n.node_id === nodeId) || null;
  }

  nodeByPeer(peerId) {
    return this.registry.find((n) => n.peer_id === peerId) || null;
  }

  nodeByName(nodeName) {
    return this.registry.find((n) => n.node_name === nodeName) || null;
  }

  // → { code, expires_at }; a name already paired is name_taken.
  addCode(nodeName) {
    if (this.nodeByName(nodeName)) throw Object.assign(new Error(`a node named "${nodeName}" is already paired`), { code: 'name_taken', status: 409 });
    const { code } = this.pairing.generateCode({ nodeName });
    return { code, expires_at: new Date(Date.now() + this.pairing.timeoutMs).toISOString() };
  }

  remove(nodeName) {
    const node = this.nodeByName(nodeName);
    if (!node) return false;
    this.registry = this.registry.filter((n) => n !== node);
    this._saveRegistry();
    this.transport.removeTrustedPeer(node.peer_id);
    return true;
  }

  rpc(nodeId, method, params = {}, { timeoutMs = 10000 } = {}) {
    const node = this.nodeById(nodeId);
    if (!node) return Promise.reject(new LinkRpcError('unknown_node', `no node ${nodeId}`));
    return this.rpcLink.call(node.peer_id, method, params, { timeoutMs });
  }

  notify(nodeId, method, params = {}) {
    const node = this.nodeById(nodeId);
    if (node) this.rpcLink.notify(node.peer_id, method, params);
  }

  onNodeMessage(method, handler) {
    this.handlers.set(method, handler);
  }

  onConnection(fn) {
    this.on('connection', fn);
  }
}

module.exports = { NodeHub };
