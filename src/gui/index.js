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
const { writeGuiStatus, SESSION_FILE_REMEDY, remedyFor } = require('./status');

const SESSION_FILE_INVALID = 'session_file_invalid';
// Anything else that stopped the GUI from being built or started (security
// review finding 2): the helper endpoint taken by another process, say.
const GUI_START_FAILED = 'gui_start_failed';
const failureDetail = (err) => String((err && err.message) || err || 'unknown error').slice(0, 300);

// R-F5-11: desktop apps are off, for a reason. No helper channel, no broker,
// no lease manager and no link method exist; the GUI tools are registered
// only to refuse with the reason; status.json carries it for "session
// status" and doctor. The bad file is never read for anything else, and
// nothing falls back to a weaker mode.
function unavailableSubsystem({ reason, detail, guiConfig, dataDir, platform, log, clock = Date.now, heartbeatMs = 10000 }) {
  const message = `${reason}: ${detail}; ${remedyFor(reason)}`;
  const apps = () => Object.values((guiConfig && guiConfig.apps) || {}).map((a) => ({ id: a.id, name: a.name }));
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

// Never throws (security review finding 2): whatever goes wrong while the GUI
// is built, the service that hosts it still starts. The result is then a
// subsystem that is off, with the reason gui_start_failed.
function createGuiSubsystem(options = {}) {
  try {
    return buildGuiSubsystem(options);
  } catch (err) {
    const { nodeConfig = null, dataDir = null, platform = process.platform, log = createLogger('gui') } = options;
    const detail = failureDetail(err);
    log.error(`desktop apps are off: the GUI could not be set up (${detail}). To fix it, ${remedyFor(GUI_START_FAILED)}.`, { reason: GUI_START_FAILED });
    return unavailableSubsystem({ reason: GUI_START_FAILED, detail, guiConfig: nodeConfig && nodeConfig.gui, dataDir, platform, log });
  }
}

// jobOpen fails closed: a host that passes none can hold no lease.
function buildGuiSubsystem({ nodeConfig, dataDir, configDir, cipher, approvals, platform = process.platform, jobOpen = () => false,
  adminUid = 0, geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1), log = createLogger('gui'), deps = {} } = {}) {
  const gui = nodeConfig.gui;
  if (nodeConfig.profile !== 'agent' || !gui || !gui.enabled) {
    // R-F5-14: off until node.yaml enables it; an installed helper changes nothing.
    log.info('desktop apps are off on this node: node.yaml does not say "gui: enabled: true" (or the profile is not agent)');
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
    // R-F5-18: statuses signed now, for a phone that opens and asks what is running.
    relay.registerMethod('lease.list', async ({ device_id: deviceId } = {}) => ({ statuses: leases.listFor(deviceId) }));
  }

  let brokerStarted = false;
  const quietly = async (fn) => { try { await fn(); } catch (err) { log.debug(`gui teardown: ${err.message}`); } };
  const subsystem = {
    broker, leases, liveView, channel,
    // Set when start() failed: { reason, detail }.
    unavailable: null,
    capability: () => broker.capability(),
    registerTools(toolRegistry) {
      registerGuiTools(toolRegistry, { broker, leases, liveView, guiConfig: gui, getPolicy, audit, platform });
    },
    // Never throws (security review finding 2). A start that fails (the
    // pipe or socket name is taken by another local process, say) closes
    // what it opened, ends every lease and leaves the capability unavailable
    // with a reason. The tools the core already registered refuse with it,
    // status.json carries it, and the service goes on without desktop apps.
    async start() {
      try {
        await channel.start();
        broker.start();
        brokerStarted = true;
        leases.start();
        if (relay) liveView.start();
        log.info('waiting for the session helper', { endpoint: channel.endpoint });
      } catch (err) {
        const detail = failureDetail(err);
        log.error(`desktop apps are off: the GUI could not start (${detail}). To fix it, ${remedyFor(GUI_START_FAILED)}.`, { reason: GUI_START_FAILED });
        await quietly(() => liveView.stop());
        await quietly(() => leases.stop());
        await quietly(() => channel.stop());
        subsystem.unavailable = { reason: GUI_START_FAILED, detail };
        // The broker stays up only to say why and to keep status.json fresh.
        if (!brokerStarted) await quietly(() => { broker.start(); brokerStarted = true; });
        await quietly(() => broker.setUnavailable({ reason: GUI_START_FAILED, detail, message: `${GUI_START_FAILED}: ${detail}; ${remedyFor(GUI_START_FAILED)}` }));
      }
    },
    async stop() {
      liveView.stop();
      leases.stop();
      if (brokerStarted) broker.stop();
      brokerStarted = false;
      await channel.stop();
    }
  };
  return subsystem;
}

module.exports = { createGuiSubsystem, isJobOpen };
