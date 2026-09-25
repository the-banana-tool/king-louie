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
const SWEEP_MS = 30000;

// Bounds on the phone listener. requestTimeout is the time a client gets to
// send its whole request (never 0, which would let a slow sender hold a
// socket forever); long polls wait on the response side and are unaffected.
// maxConnections also bounds how far concurrent failing requests can burst
// past the per-IP limit before they are charged.
const PHONE_LISTENER = Object.freeze({ requestTimeoutMs: 30000, headersTimeoutMs: 15000, maxConnections: 256 });

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

// config: { phoneListen: { host, port }, tls: { certFile, keyFile }, meshListen: { host, port }, publicUrl, push: { apns?, fcm? } }
async function startRelay({ dataDir, config, identity, listeners = 'own', registry = null, extensions = RELAY_EXTENSIONS,
  useTls = true, senders = null, now = Date.now } = {}) {
  if (!['own', 'external'].includes(listeners)) throw new TypeError("listeners must be 'own' or 'external'");
  assertPrivateMeshHost(config.meshListen && config.meshListen.host);
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(path.join(relayDir, 'codes'), { recursive: true, mode: 0o700 });

  let cert = null;
  let key = null;
  let phoneSpki = null;
  if (useTls) {
    cert = fs.readFileSync(config.tls.certFile, 'utf8');
    key = fs.readFileSync(config.tls.keyFile, 'utf8');
    phoneSpki = relaySpkiPin(cert);
  }

  const devices = new DeviceRegistry({ file: path.join(relayDir, 'devices.json'), now });
  const approvals = new ApprovalCache({ now });
  const invites = new Invites({ now });
  const mailbox = new Mailbox({ now });
  const pusher = createPusher(config.push || {}, {
    ...(senders ? { senders } : {}),
    onDropToken: (device) => devices.setPush(device.device_id, null)
  });
  const transport = new MeshTransport({ identity, host: config.meshListen.host, port: config.meshListen.port, useTls });
  const pairing = new MeshPairing(identity, transport);
  const nodeHub = new NodeHub({ identity, transport, pairing, registryFile: path.join(relayDir, 'nodes.json'), peerSource: registry, codesDir: path.join(relayDir, 'codes') });

  const relay = { identity, config, publicUrl: config.publicUrl, phoneSpki, devices, approvals, invites, mailbox, pusher, nodeHub, log, now };
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
  log.info(`relay ${identity.nodeId} ready`, { phone: server ? server.address() : null, mesh: listeners === 'own' ? transport.port : null, push: pusher.senders });

  return {
    phoneApi,
    phoneApiHandler: phoneApi.handler,
    nodeHub,
    mailbox,
    pusher,
    devices,
    approvals,
    invites,
    phoneSpki,
    address() {
      return {
        phone: server ? { host: config.phoneListen.host, port: server.address().port } : null,
        mesh: listeners === 'own' ? { host: config.meshListen.host, port: transport.port } : null
      };
    },
    async stop() {
      clearInterval(sweeper);
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
