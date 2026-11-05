// Service host wiring for the desktop bridge (fleet stage 7 §3.4). Agent
// profile only; everything is inert unless the admin config turns
// features.desktopBridge or features.remoteWindow on. They are independent
// (R-RW-20): only desktopBridge listens, and only remoteWindow answers window.open.
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');

const log = createLogger('desktop-bridge');

function createDesktopBridgeHost({
  dataDir, features = {}, ports = {}, adminUid = 0,
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  configDir = adminConfigDir({ dataDir }),
  version = require(path.join(__dirname, '..', '..', 'package.json')).version
}) {
  if (!features.desktopBridge && !features.remoteWindow) {
    return { coreDeps: {}, start: async () => null, stop: async () => {}, server: null };
  }
  let dialer = null;
  let windowApprovals = null;
  const host = {
    server: null,
    // ui: the core's ambient events go to every connected window (never
    // prompts; the dispatcher filters). host.interactive: C2's R50 port.
    coreDeps: {
      ui: {
        send: (channel, payload) => { if (host.server) host.server.forwardAmbient(channel, payload); },
        reportError: (message) => log.warn(`core reported: ${message}`)
      },
      // A remote window is not the owner at this machine.
      host: { interactive: () => Boolean(host.server && host.server.connected.some((c) => !c.remote)) }
    },
    async start({ core, ports: servicePorts, approvals = null }) {
      const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
      const { loadNodeConfig } = require('../service/node-config');
      const { DesktopBridgeServer } = require('./bridge-server');
      const { DesktopImporter, buildImportTargets } = require('../migration/desktop-import');
      const nodeConfig = loadNodeConfig({ dataDir, adminConfigDir: configDir, geteuid, adminUid });
      const identity = getOrGenerateNodeIdentity(servicePorts.store, servicePorts.cipher, nodeConfig.name);
      const createImporter = async ({ scope, checkPath }) => new DesktopImporter({
        context: core.context,
        targets: await buildImportTargets({ context: core.context, dataDir }),
        dataDir,
        scope,
        checkPath,
        cipher: servicePorts.cipher,
        hosting: nodeConfig.hosting
      });
      const server = new DesktopBridgeServer({
        core,
        identity,
        cipher: servicePorts.cipher,
        configDir,
        dataDir,
        port: ports.desktopBridge,
        version,
        hosting: nodeConfig.hosting,
        geteuid,
        adminUid,
        approvals,
        createDispatcher: (opts) => require('./bridge-dispatcher').createBridgeDispatcher({ ...opts, createImporter })
      });
      // A failed bind is fatal (parent §4.3 I4): start() throws.
      if (features.desktopBridge) await server.start();
      host.server = server;
      if (features.remoteWindow) {
        const frontDoorPin = approvals && approvals.relayClient ? approvals.relayClient.frontDoorPin : null;
        if (frontDoorPin) {
          const { createWindowDialer, createWindowHandlers } = require('./window-dialer');
          dialer = createWindowDialer({ identity, frontDoorPin, server, lookup: approvals.relayClient.dnsLookup || null });
          windowApprovals = approvals;
          approvals.setWindowHandlers(createWindowHandlers({ server, dialer }));
        } else {
          log.warn('features.remoteWindow is on, but this node has no front door to dial (front-door.json): window.open stays off');
        }
      }
      return server;
    },
    async stop() {
      const server = host.server;
      host.server = null;
      if (windowApprovals) windowApprovals.setWindowHandlers(null);
      windowApprovals = null;
      if (dialer) dialer.stop();
      dialer = null;
      if (server) await server.stop();
    }
  };
  return host;
}

module.exports = { createDesktopBridgeHost };
