// src/gui/index.js
// The GUI subsystem (fleet stage 5 spec §3.11): the helper channel, the
// broker, leases and the live view, built once by the service's agent
// profile. Null when there is nothing to run: gui off, not an agent node, or
// no session helper installed. A helper file that is there but cannot be
// used gives a subsystem that is off and says why (owner ruling R-F5-11).
const { createLogger } = require('../logging');
const { HelperChannel } = require('./helper-channel');
const { GuiBroker } = require('./broker');
const { LeaseManager } = require('./leases');
const { LiveView } = require('./live-view');
const { registerGuiTools } = require('./tools');
const { readCanonical, canonicalMtime, endpointPath, canonicalPath, inspectCanonical } = require('./session-secret');
const { writeGuiStatus, SESSION_FILE_REMEDY } = require('./status');

const SESSION_FILE_INVALID = 'session_file_invalid';

// R-F5-11: desktop apps are off, for a reason. No helper channel, no broker,
// no lease manager and no link method exist; the GUI tools are registered
// only to refuse with the reason; status.json carries it for "session
// status" and doctor. The bad file is never read for anything else, and
// nothing falls back to a weaker mode.
function unavailableSubsystem({ reason, detail, guiConfig, dataDir, platform, log, clock = Date.now, heartbeatMs = 10000 }) {
  const message = `${reason}: ${detail}; ${SESSION_FILE_REMEDY}`;
  const apps = () => Object.values(guiConfig.apps).map((a) => ({ id: a.id, name: a.name }));
  const capability = () => ({
    available: false, reason, capabilities: [], user: null, platform: null, since: null, apps: apps(), limits: [], locked: false, lease: null
  });
  const writeStatus = () => {
    if (!dataDir) return;
    try {
      writeGuiStatus(dataDir, {
        v: 1, pid: process.pid, available: false, reason, detail, user: null, platform: null, capabilities: [], probes: [], limits: [],
        apps: apps(), since: null, updated_at: new Date(clock()).toISOString(), lease: null
      });
    } catch (err) {
      log.warn(`status.json not written: ${err.message}`);
    }
  };
  let heartbeat = null;
  return {
    unavailable: { reason, detail },
    broker: null, leases: null, liveView: null, channel: null,
    capability,
    registerTools(toolRegistry) {
      registerGuiTools(toolRegistry, { unavailable: { reason, message }, guiConfig, platform });
    },
    async start() {
      writeStatus();
      heartbeat = setInterval(writeStatus, heartbeatMs);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    },
    async stop() {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
}

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
  // R-F5-11: logged once, with the remedy and never the file's contents.
  const invalid = (detail) => {
    log.error(`desktop apps are off: ${detail}. To fix it, ${SESSION_FILE_REMEDY}.`, { reason: SESSION_FILE_INVALID });
    return unavailableSubsystem({ reason: SESSION_FILE_INVALID, detail, guiConfig: gui, dataDir, platform, log });
  };
  let canonical;
  try {
    canonical = read();
  } catch {
    // Why, in words that never quote the file (the thrown message may).
    const seen = inspectCanonical({ configDir, platform, cipher, adminUid, geteuid, requireIdentity: false });
    if (seen.state === 'none') {
      log.info('desktop apps are off: the session helper is not installed (king-louie-service session install --user NAME)');
      return null;
    }
    return invalid(seen.state === 'invalid' ? `${seen.file} ${seen.reason}` : `${canonicalPath(configDir)} could not be read`);
  }
  if (canonical.nodeId !== approvals.identity.nodeId) {
    return invalid(`${canonicalPath(configDir)} was written for node ${canonical.nodeId}, not this node (${approvals.identity.nodeId})`);
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
