// startApprovals (program P9): everything a node needs for signed phone
// approvals, for both the agent and the runbook profile. It requires nothing
// from the agent stack, so the runbook profile's module graph stays small
// (tests/service-profile-graph.test.js).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');
const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
const { AuditLedger } = require('../audit/audit-ledger');
const { ApproverStore } = require('./approver-store');
const { PhoneApprover } = require('./phone-approver');
const { RelayClient } = require('./relay-client');
const { CourierPump } = require('./courier');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { open } = require('./envelope');

const log = createLogger('approvals/service');
const DAY_MS = 24 * 60 * 60 * 1000;
const RELAY_PIN_KEY = 'approvals.relay';

// A link for a node with no relay: nothing can be delivered, and says why.
function nullLink(reason) {
  const refuse = () => Promise.reject(Object.assign(new Error(reason), { code: 'relay_offline' }));
  return {
    isConnected: () => false,
    canDeliver: () => ({ ok: false, reason }),
    submit: refuse,
    status: refuse,
    send: refuse,
    call: refuse,
    notify: () => {},
    onMessage: () => {},
    registerMethod: () => {},
    on: () => {},
    off: () => {}
  };
}

function envelopeSha(envelope) {
  try {
    return sha256b64url(canonicalize(envelope));
  } catch {
    return null;
  }
}

// device.rejected fires on every malformed or forged device.enroll/revoke the
// relay forwards, so a peer hammering the link with garbage envelopes must
// not be able to grow the audit ledger without bound. At most REJECT_CAP are
// audited individually per rolling REJECT_WINDOW_MS; once a window's cap is
// hit, a single summary line is logged (never audited) and every further
// rejection in that same window is refused but not itself logged again.
const REJECT_WINDOW_MS = 60000;
const REJECT_CAP = 20;

function rejectedAuditLimiter() {
  let windowStart = 0;
  let count = 0;
  let warnedThisWindow = false;
  return () => {
    const now = Date.now();
    if (now - windowStart >= REJECT_WINDOW_MS) {
      windowStart = now;
      count = 0;
      warnedThisWindow = false;
    }
    count += 1;
    if (count > REJECT_CAP) {
      if (!warnedThisWindow) {
        warnedThisWindow = true;
        log.warn(`device.rejected audit entries are being rate-limited (cap ${REJECT_CAP}/min); further rejections this minute are refused but not individually audited`);
      }
      return false;
    }
    return true;
  };
}

// relay → node methods (spec §4.6). A response or claim for a request an
// out-of-process producer (mcp, the admin CLI) made goes to its courier inbox.
function createRelayDispatcher({ phoneApprover, approverStore, auditLedger, courierPump = null }) {
  const admitRejectedAudit = rejectedAuditLimiter();
  return async (method, params = {}) => {
    if (method === 'approval.response' || method === 'enroll.claim') {
      const inbox = courierPump ? courierPump.routeFor(method, params) : null;
      if (inbox) return { delivered: courierPump.deliver(inbox, method, params), accepted: null, reason: null };
      if (method === 'enroll.claim') return { delivered: false };
      const result = await phoneApprover.handleResponse(params.envelope);
      return { delivered: true, ...result };
    }
    if (method === 'device.enroll' || method === 'device.revoke') {
      const result = approverStore.stage(params.envelope);
      // The audited type/device_id come from what the envelope actually
      // says (open()'s message.type, null when the envelope is malformed),
      // never from the rpc method the relay happened to call it through.
      let type = null;
      let deviceId = null;
      try {
        const { message } = open(params.envelope);
        type = message.type;
        deviceId = type === 'kl.device.enroll' ? message.device && message.device.device_id : message.device_id;
      } catch {
        type = null;
        deviceId = null;
      }
      if (result.state !== 'duplicate') {
        const kind = result.state === 'rejected' ? 'device.rejected' : 'device.staged';
        if (kind !== 'device.rejected' || admitRejectedAudit()) {
          auditLedger.append({ kind, data: { type, device_id: deviceId, reason: result.reason || null, envelope_sha256: envelopeSha(params.envelope) } })
            .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
        }
      }
      return result;
    }
    if (method === 'audit.slice') {
      const { limit, before_seq: beforeSeq, after, max_bytes: maxBytes } = params;
      return { envelope: auditLedger.slice({ limit, before_seq: beforeSeq, after, max_bytes: maxBytes }) };
    }
    if (method === 'audit.head') return { envelope: auditLedger.head() };
    throw Object.assign(new Error(`no handler for ${method}`), { code: 'unknown_method' });
  };
}

// Tells the relay when an admin applies or revokes a device on this node, so
// it pushes to (and lists) the right phones.
function trackDeviceStates({ approverStore, relayClient, intervalMs = 5000 }) {
  let known = new Set(approverStore.list().filter((r) => approverStore.isAdminApplied(r.device_id)).map((r) => r.device_id));
  const push = () => {
    approverStore.refresh();
    const now = new Set(approverStore.list().filter((r) => approverStore.isAdminApplied(r.device_id)).map((r) => r.device_id));
    for (const id of now) if (!known.has(id)) relayClient.notify('device.state', { device_id: id, state: 'active' });
    for (const id of known) if (!now.has(id)) relayClient.notify('device.state', { device_id: id, state: 'revoked' });
    known = now;
  };
  const onConnected = () => {
    for (const id of known) relayClient.notify('device.state', { device_id: id, state: 'active' });
  };
  relayClient.on('connected', onConnected);
  const timer = setInterval(push, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    clearInterval(timer);
    relayClient.off('connected', onConnected);
  };
}

async function startApprovals({ dataDir, configDir = adminConfigDir({ dataDir }), nodeConfig, ports, profile = 'agent',
  serviceConfig = {}, identity = null, useTls = true, allowTestKeys = false, transportFactory, reconnectDelays,
  approverStoreOptions = {} } = {}) {
  const nodeIdentity = identity || getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeConfig.name);
  const retentionDays = (serviceConfig.audit && serviceConfig.audit.retentionDays) || 365;
  const auditLedger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity: nodeIdentity, nodeId: nodeIdentity.nodeId, writer: 'service', retentionDays });
  const pruned = auditLedger.prune();
  if (pruned.removedSegments) log.info(`pruned ${pruned.removedSegments} audit segment(s) older than ${retentionDays} days`);
  const pruneTimer = setInterval(() => {
    try { auditLedger.prune(); } catch (err) { log.warn(`audit prune failed: ${err.message}`); }
  }, DAY_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  // Built incrementally below so the failure teardown only tears down what
  // actually exists yet; `stop` (below) and the catch's teardown share this
  // one function so a failed start and a normal stop leave the same result.
  let approverStore = null;
  let phoneApprover = null;
  let relayClient = null;
  let courierPump = null;
  let stopTracking = () => {};

  const teardown = async () => {
    clearInterval(pruneTimer);
    // Each step is guarded on its own: a throw from stopTracking() or
    // phoneApprover.stop() must never skip relayClient.stop() — leaving a
    // live relay link behind is exactly what this teardown exists to
    // prevent, and it must run no matter what any earlier step does.
    try {
      stopTracking();
    } catch (err) {
      log.warn(`stopTracking failed during teardown: ${err.message}`);
    }
    try {
      if (phoneApprover) phoneApprover.stop();
    } catch (err) {
      log.warn(`phoneApprover.stop failed during teardown: ${err.message}`);
    }
    try {
      if (courierPump) courierPump.stop();
    } catch (err) {
      log.warn(`courierPump.stop failed during teardown: ${err.message}`);
    }
    if (relayClient) await relayClient.stop();
  };

  try {
    approverStore = new ApproverStore({
      dir: path.join(configDir, 'approvers'),
      stagedDir: path.join(dataDir, 'approvals', 'staged'),
      // Tests only: they cannot create root-owned files (geteuid, adminUid, platform).
      ...approverStoreOptions,
      allowTestKeys,
      serviceProbe: true
    });
    await approverStore.ready();

    const approvers = nodeConfig.approvers || { relay: null, requestTtlS: 300 };
    const relayPin = ports && ports.store ? ports.store.get(RELAY_PIN_KEY) || null : null;
    const frontDoor = fs.existsSync(path.join(configDir, 'front-door.json'));
    const wantsRelay = Boolean(approvers.relay) || frontDoor;
    let link;
    if (wantsRelay && relayPin) {
      relayClient = new RelayClient({
        identity: nodeIdentity, nodeName: nodeConfig.name, relayPin, configDir, dataDir, useTls,
        ...(transportFactory ? { transportFactory } : {}), ...(reconnectDelays ? { reconnectDelays } : {})
      });
      link = relayClient;
    } else {
      const reason = wantsRelay
        ? 'this node is not paired with its relay (run `king-louie-service pair wss://…`)'
        : 'no relay is configured for this node (approvers.relay in node.yaml)';
      if (wantsRelay) log.warn(reason);
      link = nullLink(reason);
    }

    phoneApprover = new PhoneApprover({
      identity: nodeIdentity,
      nodeName: nodeConfig.name,
      approverStore,
      link,
      auditLedger,
      ttlMs: (approvers.requestTtlS || 300) * 1000
    });

    if (relayClient) {
      courierPump = new CourierPump({ dataDir, relayClient, identity: nodeIdentity });
      relayClient.onMessage(createRelayDispatcher({ phoneApprover, approverStore, auditLedger, courierPump }));
      stopTracking = trackDeviceStates({ approverStore, relayClient });
      await relayClient.start();
      courierPump.start();
    }
    log.info('phone approvals ready', { profile, relay: relayClient ? relayPin.relay_id : null, activeDevices: approverStore.activeCount() });
  } catch (err) {
    // A failed start must not leave a live relay link, a live prune timer or
    // a live device-state poll behind it.
    await teardown().catch((teardownErr) => log.error(`teardown after a failed start also failed: ${teardownErr.message}`));
    throw err;
  }

  return {
    phoneApprover,
    auditLedger,
    relayClient,
    approverStore,
    identity: nodeIdentity,
    courierPump,
    stop: teardown
  };
}

// The `mcp` process (spec §3.8, §3.9): it cannot open its own relay link, so
// its PhoneApprover talks to the running service through a FileCourier, and
// its audit entries say writer 'mcp'. With the service stopped every unsafe
// runbook is refused at once with that reason.
async function startMcpApprovals({ dataDir, configDir = adminConfigDir({ dataDir }), nodeConfig, ports, identity = null,
  approverStoreOptions = {}, pollMs } = {}) {
  const { FileCourier } = require('./courier');
  const nodeIdentity = identity || getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeConfig.name);
  const auditLedger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity: nodeIdentity, nodeId: nodeIdentity.nodeId, writer: 'mcp' });
  const approverStore = new ApproverStore({
    dir: path.join(configDir, 'approvers'),
    stagedDir: path.join(dataDir, 'approvals', 'staged'),
    ...approverStoreOptions,
    serviceProbe: true
  });
  await approverStore.ready();
  const courier = new FileCourier({ dataDir, identity: nodeIdentity, ...(pollMs ? { pollMs } : {}) }).start();
  const approvers = nodeConfig.approvers || { requestTtlS: 300 };
  const approver = new PhoneApprover({
    identity: nodeIdentity,
    nodeName: nodeConfig.name,
    approverStore,
    link: courier,
    auditLedger,
    ttlMs: (approvers.requestTtlS || 300) * 1000
  });
  courier.onMessage(async (method, params) => {
    if (method === 'approval.response') return approver.handleResponse(params.envelope);
    return null;
  });
  return {
    approver,
    auditLedger,
    courier,
    identity: nodeIdentity,
    stop() {
      approver.stop();
      courier.stop();
    }
  };
}

module.exports = { startApprovals, startMcpApprovals, createRelayDispatcher, trackDeviceStates, nullLink, RELAY_PIN_KEY };
