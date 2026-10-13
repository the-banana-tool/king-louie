// src/gui/index.js
// The GUI subsystem (fleet stage 5 spec §3.11): the helper channel, the
// broker, leases and the live view, built once by the service's agent
// profile. Null when there is nothing to run: gui off, not an agent node, or
// no session helper installed.
const { createLogger } = require('../logging');
const { HelperChannel } = require('./helper-channel');
const { GuiBroker } = require('./broker');
const { LeaseManager } = require('./leases');
const { LiveView } = require('./live-view');
const { registerGuiTools } = require('./tools');
const { readCanonical, canonicalMtime, endpointPath } = require('./session-secret');

// R-F5-7: a job is open only while this node knows it and it has not ended.
// `chat:<id>` is a chat's own job (Deviation 38): open while the chat exists.
// Any other id is a fleet job: open while the JobManager has it and it is not
// terminal. An unknown id, a missing JobManager or chat lookup, and a lookup
// that throws are all closed.
function isJobOpen({ jobManager = null, chatExists = null } = {}, jobId) {
  if (typeof jobId !== 'string' || !jobId) return false;
  try {
    if (jobId.startsWith('chat:')) {
      const chatId = jobId.slice('chat:'.length);
      return Boolean(chatId) && typeof chatExists === 'function' && chatExists(chatId) === true;
    }
    if (!jobManager) return false;
    return Boolean(jobManager.getJob(jobId)) && !jobManager.isTerminal(jobId);
  } catch {
    return false;
  }
}

// jobOpen fails closed: a host that passes none can hold no lease.
function createGuiSubsystem({ nodeConfig, dataDir, configDir, cipher, approvals, platform = process.platform, jobOpen = () => false,
  adminUid = 0, geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1), log = createLogger('gui'), deps = {} } = {}) {
  const gui = nodeConfig.gui;
  if (nodeConfig.profile !== 'agent' || !gui || !gui.enabled) {
    log.info('desktop apps are off on this node (gui.enabled is false or the profile is not agent)');
    return null;
  }
  const read = () => readCanonical({ configDir, cipher, adminUid, geteuid });
  let canonical;
  try {
    canonical = read();
  } catch (err) {
    if (err.code === 'session_not_installed') {
      log.info('desktop apps are off: the session helper is not installed (king-louie-service session install --user NAME)');
      return null;
    }
    throw err;
  }
  if (canonical.nodeId !== approvals.identity.nodeId) {
    log.error(`the session helper was installed for node ${canonical.nodeId}, not this node (${approvals.identity.nodeId}); run "session install" again`);
    return null;
  }

  const audit = approvals.auditLedger || null;
  const channel = new HelperChannel({
    endpoint: deps.endpoint || endpointPath({ platform, endpointId: canonical.endpointId }),
    platform, audit, readSecret: read, readMtime: () => canonicalMtime(configDir)
  });
  const getPolicy = () => nodeConfig.policy;
  const broker = new GuiBroker({ channel, guiConfig: gui, getPolicy, audit, dataDir, platform });
  const leases = new LeaseManager({ approvals, guiConfig: gui, broker, audit, nodeName: nodeConfig.name, jobOpen });
  broker.setLeases(leases);
  const relay = approvals.relayClient || null;
  const liveView = new LiveView({ leases, broker, identity: approvals.identity, relayClient: relay, guiConfig: gui });
  if (relay) {
    relay.registerMethod('lease.grant', async ({ envelope } = {}) => leases.onGrant(envelope));
    relay.registerMethod('lease.revoke', async ({ envelope } = {}) => leases.onRevoke(envelope));
    relay.registerMethod('lease.watch', async ({ envelope } = {}) => liveView.onWatch(envelope));
  }

  return {
    broker, leases, liveView, channel,
    capability: () => broker.capability(),
    registerTools(toolRegistry) {
      registerGuiTools(toolRegistry, { broker, leases, liveView, guiConfig: gui, getPolicy, audit, platform });
    },
    async start() {
      await channel.start();
      broker.start();
      leases.start();
      if (relay) liveView.start();
      log.info('waiting for the session helper', { endpoint: channel.endpoint });
    },
    async stop() {
      liveView.stop();
      leases.stop();
      broker.stop();
      await channel.stop();
    }
  };
}

module.exports = { createGuiSubsystem, isJobOpen };
