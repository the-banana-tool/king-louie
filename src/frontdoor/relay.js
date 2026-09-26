// startRelay (E1): the relay subset of the stage 4 front door. No core,
// providers, tools or agent code; its own NodeIdentity. With listeners
// 'external' it binds nothing and F4 mounts phoneApiHandler and the node hub
// on its own listeners.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { createLogger } = require('../logging');
const { MeshTransport } = require('../mesh/mesh-transport');
const { MeshPairing } = require('../mesh/mesh-pairing');
const { DeviceRegistry } = require('./device-registry');
const { ApprovalCache } = require('./approval-cache');
const { Invites } = require('./invites');
const { Mailbox } = require('./mailbox');
const { createPusher } = require('./push');
const { createPhoneApi } = require('./phone-api');
const { NodeHub } = require('./node-hub');
const { registerPhoneRoutes } = require('./routes');
const { registerNodeMethods } = require('./node-methods');
const { assertPrivateMeshHost } = require('./net');
const { relaySpkiPin } = require('./tls');
const RELAY_EXTENSIONS = require('./extensions');

const log = createLogger('frontdoor/relay');
// The pin a phone checks the relay's certificate against: sha256/ + the
// base64url SHA-256 of the leaf's SPKI (relaySpkiPin).
const SPKI_PIN_RE = /^sha256\/[A-Za-z0-9_-]{43}$/;

function assertSpkiPin(pin) {
  if (typeof pin !== 'string' || !SPKI_PIN_RE.test(pin)) throw new TypeError('phoneSpki must be sha256/ followed by 43 base64url characters');
}
const SWEEP_MS = 30000;

// Bounds on the phone listener. requestTimeout is the time a client gets to
// send its whole request (never 0, which would let a slow sender hold a
// socket forever); long polls wait on the response side and are unaffected.
// maxConnections also bounds how far concurrent failing requests can burst
// past the per-IP limit before they are charged; perIpConnections keeps one
// address from taking all of them (and locking every other phone out). It is
// a quarter of maxConnections, not a handful: many phones can share one
// address (CGNAT, office NAT), each holding a long poll and request sockets,
// and a valid phone there must not be refused because its neighbours are
// busy (final review I1).
const PHONE_LISTENER = Object.freeze({ requestTimeoutMs: 30000, headersTimeoutMs: 15000, maxConnections: 256, perIpConnections: 64 });

// The phone API's rate limits are keyed on the socket's remote address, and
// there is deliberately no trusted forwarded-for setting: the relay must see
// real client IPs. Behind a proxy or load balancer that hides them, every
// phone shares one per-IP budget, so a handful of unauthenticated calls a
// minute would lock all phones out.
function createPhoneServer({ useTls, cert = null, key = null, handler }) {
  const server = useTls ? https.createServer({ cert, key }, handler) : http.createServer(handler);
  server.requestTimeout = PHONE_LISTENER.requestTimeoutMs;
  server.headersTimeout = PHONE_LISTENER.headersTimeoutMs;
  server.maxConnections = PHONE_LISTENER.maxConnections;
  const perIp = new Map();
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress || 'unknown';
    const open = perIp.get(ip) || 0;
    if (open >= PHONE_LISTENER.perIpConnections) {
      socket.destroy();
      return;
    }
    perIp.set(ip, open + 1);
    socket.once('close', () => {
      const left = (perIp.get(ip) || 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
    });
  });
  return server;
}

// What an extension may use of the device registry: reads only. Registering
// a device is reserved to console enrollment (enroll.done) and the signed
// device route.
function readOnlyDevices(devices) {
  return Object.freeze({
    get: (id) => devices.get(id),
    list: () => devices.list(),
    devicesForNode: (nodeId) => devices.devicesForNode(nodeId),
    nodesForDevice: (deviceId) => devices.nodesForDevice(deviceId)
  });
}

// config: { phoneListen, tls: { certFile, keyFile }, meshListen, publicUrl, push } for 'own';
// for 'external' (the front door, fleet stage 4 §3.1) only { publicUrl, push },
// plus the front door's own `transport` (pinned in TLS) and `phoneSpki`
// (null until the front door has a certificate, then set with setPhoneSpki).
// testOnlyAllowPlainTransport: TESTS ONLY — lets 'external' take a plain
// ws:// transport without pinned client certificates. Never set in a service.
async function startRelay({ dataDir, config, identity, listeners = 'own', registry = null, extensions = RELAY_EXTENSIONS,
  useTls = true, senders = null, now = Date.now, transport = null, phoneSpki = null, testOnlyAllowPlainTransport = false } = {}) {
  if (!['own', 'external'].includes(listeners)) throw new TypeError("listeners must be 'own' or 'external'");
  const external = listeners === 'external';
  if (external) {
    if (!transport) throw new TypeError("listeners 'external' needs the front door's transport");
    if (!transport.identity || transport.identity.nodeId !== identity.nodeId) throw new TypeError("listeners 'external' needs a transport with the relay's own identity");
    // The skipped private-host check is safe only because the front door's
    // mesh drops unpinned client certificates in TLS.
    if (!(transport.useTls && transport.requireClientCert) && testOnlyAllowPlainTransport !== true) {
      throw new TypeError("listeners 'external' needs a transport with TLS and pinned client certificates (useTls, requireClientCert)");
    }
    if (phoneSpki !== null) assertSpkiPin(phoneSpki);
  }
  // Only the relay's own mesh listener is limited to private addresses: the
  // front door's mesh drops unpinned certificates in TLS (ruling 8, §3.2).
  if (!external) assertPrivateMeshHost(config.meshListen && config.meshListen.host);
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(path.join(relayDir, 'codes'), { recursive: true, mode: 0o700 });

  let cert = null;
  let key = null;
  // 'own' ignores both options and behaves exactly as F3 shipped it.
  let spki = external ? phoneSpki : null;
  if (useTls && !external) {
    cert = fs.readFileSync(config.tls.certFile, 'utf8');
    key = fs.readFileSync(config.tls.keyFile, 'utf8');
    spki = relaySpkiPin(cert);
  }

  const devices = new DeviceRegistry({ file: path.join(relayDir, 'devices.json'), now });
  const approvals = new ApprovalCache({ now });
  const invites = new Invites({ now });
  const mailbox = new Mailbox({ now });
  const pusher = createPusher(config.push || {}, {
    ...(senders ? { senders } : {}),
    onDropToken: (device) => devices.setPush(device.device_id, null)
  });
  const meshTransport = external ? transport : new MeshTransport({ identity, host: config.meshListen.host, port: config.meshListen.port, useTls });
  const pairing = new MeshPairing(identity, meshTransport);
  const nodeHub = new NodeHub({ identity, transport: meshTransport, pairing, registryFile: path.join(relayDir, 'nodes.json'), peerSource: registry, codesDir: path.join(relayDir, 'codes') });

  const relay = { identity, config, publicUrl: config.publicUrl, phoneSpki: spki, devices, approvals, invites, mailbox, pusher, nodeHub, log, now };
  // Route handlers see ctx.relay; they get the code/invite store the path
  // credentials are checked against, not the device registry.
  const phoneApi = createPhoneApi({ devices, relay: { invites }, now });
  relay.phoneApi = phoneApi;
  registerPhoneRoutes(relay);
  registerNodeMethods(relay);
  const extensionView = { phoneApi, nodeHub, mailbox, pusher, devices: readOnlyDevices(devices), approvals, log };
  for (const extension of extensions) extension(extensionView);

  let server = null;
  try {
    await nodeHub.start({ listen: listeners === 'own' });
    if (listeners === 'own') {
      server = createPhoneServer({ useTls, cert, key, handler: phoneApi.handler });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.phoneListen.port, config.phoneListen.host, resolve);
      });
    }
  } catch (err) {
    // A relay that failed to start must not leave a mesh listener behind.
    await nodeHub.stop().catch((stopErr) => log.warn(`stopping the node hub after a failed start: ${stopErr.message}`));
    throw err;
  }
  const sweeper = setInterval(() => { approvals.sweep(); mailbox.sweep(); invites.sweep(); }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
  log.info(`relay ${identity.nodeId} ready`, { phone: server ? server.address() : null, mesh: listeners === 'own' ? meshTransport.port : null, push: pusher.senders });

  return {
    phoneApi,
    phoneApiHandler: phoneApi.handler,
    nodeHub,
    mailbox,
    pusher,
    devices,
    approvals,
    invites,
    get phoneSpki() {
      return relay.phoneSpki;
    },
    // F4 (§3.3): after a certificate key change, relay.hello reports the new pin.
    setPhoneSpki(pin) {
      assertSpkiPin(pin);
      relay.phoneSpki = pin;
    },
    address() {
      return {
        phone: server ? { host: config.phoneListen.host, port: server.address().port } : null,
        mesh: listeners === 'own' ? { host: config.meshListen.host, port: meshTransport.port } : null
      };
    },
    async stop() {
      clearInterval(sweeper);
      // Parked long polls answer now instead of holding their sockets.
      approvals.releaseWaiters();
      if (server) {
        const closed = new Promise((resolve) => server.close(resolve));
        // Idle keep-alive sockets and parked long polls would hold close() open.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await closed;
      }
      await nodeHub.stop();
    }
  };
}

module.exports = { startRelay, RELAY_EXTENSIONS, createPhoneServer, PHONE_LISTENER };
