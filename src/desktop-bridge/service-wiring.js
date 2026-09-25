// Service host wiring for the desktop bridge (fleet stage 7 §3.4). Agent
// profile only; everything is inert unless the admin config turns
// features.desktopBridge on.
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
  if (!features.desktopBridge) {
    return { coreDeps: {}, start: async () => null, stop: async () => {}, server: null };
  }
  const host = {
    server: null,
    // ui: the core's ambient events go to the connected desktop (never
    // prompts; the dispatcher filters). host.interactive: C2's R50 port.
    coreDeps: {
      ui: {
        send: (channel, payload) => { if (host.server) host.server.forwardAmbient(channel, payload); },
        reportError: (message) => log.warn(`core reported: ${message}`)
      },
      host: { interactive: () => Boolean(host.server && host.server.connected != null) }
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
        cipher: servicePorts.cipher
      });
      const server = new DesktopBridgeServer({
        core,
        identity,
        cipher: servicePorts.cipher,
        configDir,
        dataDir,
        port: ports.desktopBridge,
        version,
        geteuid,
        adminUid,
        approvals,
        createDispatcher: (opts) => require('./bridge-dispatcher').createBridgeDispatcher({ ...opts, createImporter })
      });
      // A failed bind is fatal (parent §4.3 I4): start() throws.
      await server.start();
      host.server = server;
      return server;
    },
    async stop() {
      const server = host.server;
      host.server = null;
      if (server) await server.stop();
    }
  };
  return host;
}

module.exports = { createDesktopBridgeHost };
