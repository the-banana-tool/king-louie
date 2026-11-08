// tests/helpers/fake-window-frontdoor.js
//
// The real createWindowSplice behind two loopback TLS listeners, mcp and mesh, with
// the real mcp and mesh HTTP servers. The registry, grants and tokens are small
// tables, and the NodeHub is a stub whose window.open dials back as a node does:
// over TLS with the node's own certificate, to this fake's mesh port.
//
// A node is { identity, name?, online?, profile?, server?, open?, onSocket?, tap? }.
// `open(params, { dial })` replaces the answer to window.open. Without it the node
// dials: `server`, a DesktopBridgeServer, then takes the socket through attachSealed
// (`tap` sees its transport first), and `onSocket(ws, params)` gets it otherwise.
const tls = require('tls');
const WebSocket = require('ws');
const { NodeIdentity } = require('../../src/mesh/node-identity');
const { normalizeScopes } = require('../../src/fleet/scope-rules');
const { machineMatches } = require('../../src/frontdoor/oauth/grants');
const { createMcpHttpServer, createMeshHttpServer } = require('../../src/frontdoor/http');
const { WINDOW_DEFAULTS } = require('../../src/frontdoor/config');
const { createWindowSplice } = require('../../src/frontdoor/window/splice');
const { wsTransport } = require('../../src/desktop-bridge/sealed-socket');
const { SOCKET_OPTIONS } = require('../../src/desktop-bridge/window-seal');
const { selfSigned, fingerprint } = require('./test-certs');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function startFakeWindowFrontDoor({ nodes = [], tokens = {}, config = {}, now = Date.now, windowEnabled = () => true } = {}) {
  const identity = new NodeIdentity({ nodeName: 'frontdoor' });
  const mcpCert = selfSigned({ commonName: 'mcp.kl.example.com' });
  const nodeList = nodes.map((node) => ({ online: true, profile: 'agent', ...node, name: node.name || node.identity.nodeName }));
  const byId = new Map(nodeList.map((node) => [node.identity.nodeId, node]));
  const auditLines = [];
  const rpcCalls = [];
  const tokenTable = new Map(Object.entries(tokens));
  const machineIds = Object.fromEntries(nodeList.map((node) => [node.name, node.identity.nodeId]));
  const liveGrants = new Map();
  for (const rec of tokenTable.values()) {
    liveGrants.set(rec.grant_id, { client_id: rec.client_id, scopes: normalizeScopes(rec.grant_scopes || rec.scopes), machine_ids: rec.machine_ids || machineIds });
  }

  let origin = null;
  let meshUrl = null;
  const resourceUrl = () => `${origin}/window/v1`;
  const toolTokens = {
    authenticate(token, { aud } = {}) {
      const rec = tokenTable.get(token);
      if (!rec || (rec.aud || resourceUrl()) !== aud) return null;
      return { grant_id: rec.grant_id, client_id: rec.client_id, scopes: [...rec.scopes], aud };
    }
  };
  const grants = { live: (id) => liveGrants.get(id) || null, machineMatches };
  const registry = {
    byId(id) {
      const node = byId.get(id);
      return node ? { node_id: id, node_name: node.name, profile: node.profile } : null;
    },
    peers: () => [...byId.values()].map((node) => ({ nodeId: node.identity.nodeId, tlsFingerprint: node.identity.tlsFingerprint })),
    presence(id) {
      const node = byId.get(id);
      return node && node.online ? { online: true } : null;
    }
  };

  const dial = (nodeIdentity, sessionId) => new WebSocket(`${meshUrl}/window/v1/${sessionId}`, {
    ...SOCKET_OPTIONS, cert: nodeIdentity.tlsCert, key: nodeIdentity.tlsKey, rejectUnauthorized: false, servername: 'mesh.kl.example.com'
  });

  const nodeHub = {
    async rpc(nodeId, method, params, options) {
      rpcCalls.push({ nodeId, method, params, options });
      const node = byId.get(nodeId);
      if (node.open) return node.open(params, { dial: (sessionId = params.session_id) => dial(node.identity, sessionId) });
      const ws = dial(node.identity, params.session_id);
      ws.on('error', () => {});
      if (node.server) {
        ws.once('open', () => {
          const transport = wsTransport(ws);
          if (node.tap) node.tap(transport);
          node.server.attachSealed({ sessionId: params.session_id, transport }).catch(() => {});
        });
      } else if (node.onSocket) {
        node.onSocket(ws, params);
      }
      return { ok: true };
    }
  };

  const splice = createWindowSplice({
    tokens: toolTokens, grants, registry, nodeHub, windowResourceUrl: resourceUrl,
    ...(windowEnabled ? { windowEnabled } : {}),
    config: { ...WINDOW_DEFAULTS, ...config },
    auditLedger: { append: async (line) => { auditLines.push(line); } },
    now
  });
  const mcpServer = createMcpHttpServer((req, res) => { res.writeHead(404); res.end(); }, {}, { onUpgrade: splice.onMcpUpgrade });
  const meshServer = createMeshHttpServer();
  meshServer.on('upgrade', (req, socket, head) => {
    if (splice.onMeshUpgrade(req, socket, head) !== true) socket.destroy();
  });
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const mcpListener = tls.createServer({ cert: mcpCert.cert, key: mcpCert.key, ALPNProtocols: ['http/1.1'] }, (socket) => {
    track(socket);
    mcpServer.emit('connection', socket);
  });
  const meshListener = tls.createServer({
    cert: identity.tlsCert, key: identity.tlsKey, ALPNProtocols: ['http/1.1'], requestCert: true, rejectUnauthorized: false
  }, (socket) => {
    track(socket);
    meshServer.emit('connection', socket);
  });
  mcpListener.on('tlsClientError', () => {});
  meshListener.on('tlsClientError', () => {});
  origin = `https://127.0.0.1:${await listen(mcpListener)}`;
  meshUrl = `wss://127.0.0.1:${await listen(meshListener)}`;

  return {
    origin,
    meshUrl,
    meshFingerprint: identity.tlsFingerprint,
    mcpFingerprint: fingerprint(mcpCert.cert),
    frontdoorId: identity.nodeId,
    splice,
    audit: auditLines,
    rpcCalls,
    dial,
    openSockets: () => sockets.size,
    setOnline(nodeId, online) { byId.get(nodeId).online = online; },
    removeNode(nodeId) { byId.delete(nodeId); },
    expireToken(token) { tokenTable.delete(token); },
    dropGrant(grantId) { liveGrants.delete(grantId); },
    revokeGrant(grantId) {
      liveGrants.delete(grantId);
      splice.closeForGrant(grantId);
    },
    // The profile's order: the listener goes first and destroys what it holds, so
    // both legs see 1006, and the splice's own stop finds nothing to tell.
    async stop() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([mcpListener, meshListener].map((server) => new Promise((resolve) => { server.close(resolve); })));
      splice.stop();
    }
  };
}

module.exports = { startFakeWindowFrontDoor };
