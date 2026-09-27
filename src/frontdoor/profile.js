// profile: frontdoor (fleet stage 4 §3.1). One 443 listener split by SNI:
// mcp.<domain> for OAuth, MCP, F3's phone API and node pairing; mesh.<domain>
// for pinned node links into F3's relay. It loads no agent code (see
// tests/service-profile-graph.test.js).
//
// Start order is §3.1's: checks 1–4, the identity, alerts, approvers and the
// own ledger, the TLS source (operator files are read before anything
// binds), the registry (check 6), the mesh transport and F3's relay behind
// it, the front door as its own node, then router, OAuth, MCP, pairing,
// mirror, phone routes and probe, the listener (check 5), ACME, check 7 and
// the SIGHUP handler. Everything started is registered for stopping as it
// starts, so a failure part-way stops what already runs, in reverse, and a
// step that hangs on the way down is abandoned after STOP_STEP_TIMEOUT_MS.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { createLogger } = require('../logging');
const { buildServicePorts } = require('../service/ports');
const { parsePushConfig } = require('../service/config');
const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
const { MeshTransport, timingSafeHexEqual } = require('../mesh/mesh-transport');
const { AuditLedger } = require('../audit/audit-ledger');
const { ApproverStore } = require('../approvals/approver-store');
const { CourierPump } = require('../approvals/courier');
const { createRelayDispatcher, trackDeviceStates } = require('../approvals/service-wiring');
const { startRelay } = require('./relay');
const { FrontDoorSelfLink } = require('./self-link');
const { frontDoorHosts } = require('./config');
const { runStartupChecks } = require('./startup-checks');
const { AlertCenter } = require('./alerts');
const { recordFrontDoorEvent } = require('./audit/own-ledger');
const { AuditMirror } = require('./audit/mirror');
const { NodeRegistry } = require('./router/node-registry');
const { JobCache } = require('./router/job-cache');
const { FleetRouter } = require('./router/router');
const { createFleetScopeRegistry } = require('./oauth/scopes');
const { ClientRegistry } = require('./oauth/clients');
const { PendingAuthorizations } = require('./oauth/pending');
const { OAuthServer } = require('./oauth/server');
const { GrantStore, AuthCodes } = require('./oauth/grants');
const { registerGrantRoutes } = require('./oauth/grant-routes');
const { TokenStore } = require('./oauth/tokens');
const { McpHttpEndpoint } = require('./mcp/http-endpoint');
const { PairingService } = require('./pairing/pairing-service');
const { createPairHandler } = require('./pairing/pair-http');
const { registerFrontDoorRoutes } = require('./phone-routes');
const { createApproverNotifier } = require('./notify');
const { SelfProbe, createProbeHandler } = require('./probe');
const { SniListener } = require('./tls/sni-listener');
const { OperatorTls } = require('./tls/operator-tls');
const { Challenges } = require('./protocol/challenges');
const { spkiHexFromRaw, nodeFingerprint, NODE_NAME_RE } = require('./protocol/messages');
const { RepinPublisher } = require('./repin');
const { auditConsoleRemovals } = require('./console-removals');
const { createFrontDoorHandler, createMcpHttpServer, createMeshHttpServer } = require('./http');
const TOOL_EXTENSIONS = require('./tool-extensions');

const log = createLogger('frontdoor');
const NO_PHONE = 'No phone enrolled on this front door: run "king-louie-service frontdoor enroll-device"';
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

// §3.6: a second link for a connected node key pings the old one this long.
const DUPLICATE_PING_MS = 5000;
// A link RPC the audit mirror waits on. A fetch that never settled would
// hold that node's mirror queue (sync and ingest) forever.
const MIRROR_FETCH_TIMEOUT_MS = 30000;
// Each shutdown step gets this long before the next one runs anyway, and
// the whole shutdown this long (under systemd's 90 s TimeoutStopSec).
const STOP_STEP_TIMEOUT_MS = 10000;
const STOP_TOTAL_TIMEOUT_MS = 60000;
const AUDIT_PRUNE_EVERY_MS = 24 * 3600000;
// The mesh. context asks for a client certificate. Without a session id
// context OpenSSL fails a resumption attempt outright, and a resumed
// session would skip the certificate the pin check reads; so every mesh
// connection is a full handshake: tickets off, and a fixed context.
const MESH_SESSION_ID_CONTEXT = 'kl-frontdoor-mesh';

// The front door has no approvals of its own; a response addressed to it is
// for nothing it asked.
const NO_APPROVALS = Object.freeze({ handleResponse: async () => ({ accepted: false, reason: 'unknown_request' }) });

function meshSecureContext(identity) {
  return tls.createSecureContext({
    cert: identity.tlsCert, key: identity.tlsKey,
    sessionIdContext: MESH_SESSION_ID_CONTEXT, secureOptions: crypto.constants.SSL_OP_NO_TICKET
  });
}

// (fingerprintHex) → true only when it equals a pinned node certificate,
// compared in constant time against every pin (no early exit, no Set lookup).
// A throwing source pins nothing.
function makePinCheck(fingerprints, equal = timingSafeHexEqual) {
  return (fp) => {
    let list;
    try {
      list = fingerprints();
    } catch (err) {
      log.warn(`reading the pinned node certificates failed: ${err.message}`);
      return false;
    }
    let pinned = false;
    for (const known of list) if (equal(known, fp) === true) pinned = true;
    return pinned;
  };
}

// The audit mirror's fetchSlice for one node: F3's audit.slice over the
// link, bounded by its own timer as well as the link's.
function mirrorFetcher(nodeHub, nodeId, timeoutMs = MIRROR_FETCH_TIMEOUT_MS) {
  return async (params) => {
    let timer = null;
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`audit.slice from ${nodeId} timed out after ${timeoutMs} ms`), { code: 'timeout' })), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => nodeHub.rpc(nodeId, 'audit.slice', params, { timeoutMs })), expired]);
      return result && result.envelope;
    } finally {
      clearTimeout(timer);
    }
  };
}

// Runs each { name, fn } in order. A step that throws is logged; one that
// has not settled after timeoutMs is abandoned. Either way the next runs.
// Past totalMs the remaining steps are still started, but not waited for.
async function stopInOrder(steps, { timeoutMs = STOP_STEP_TIMEOUT_MS, totalMs = STOP_TOTAL_TIMEOUT_MS, onStep = null } = {}) {
  const deadline = Date.now() + totalMs;
  for (const { name, fn } of steps) {
    if (onStep) {
      try {
        onStep(name);
      } catch {
        // a test hook
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      log.warn(`shutdown passed its ${totalMs} ms deadline; stopping ${name} without waiting`);
      Promise.resolve().then(fn).catch((err) => log.warn(`stopping ${name}: ${err.message}`));
      continue;
    }
    const wait = Math.min(timeoutMs, left);
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`did not stop within ${wait} ms`)), wait); })
      ]);
    } catch (err) {
      log.warn(`stopping ${name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function warnAboutF3Nodes(dataDir) {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'nodes.json'), 'utf8')).nodes || [];
  } catch {
    rows = [];
  }
  if (Array.isArray(rows) && rows.length) {
    const names = rows.slice(0, 20).map((r) => (r && typeof r.node_name === 'string' && NODE_NAME_RE.test(r.node_name) ? r.node_name : '?')).join(', ');
    log.warn(`relay nodes.json lists ${names}${rows.length > 20 ? ', …' : ''}: F3 relay records are not used by a front door; run "king-louie-service pair https://mcp.<domain>" on each`);
  }
}

// deps (tests only): ports, listen, publicPort, lookup, probeCa,
// acmeAdapterFactory, allowTestKeys, approverStoreOptions, senders,
// mcpServerLimits, meshServerLimits, probeAllowLoopbackForTests, onStop(name).
async function startFrontDoor({ dataDir, configDir, adminUid = 0, geteuid = defaultGeteuid, nodeConfig, serviceConfig, toolExtensions = TOOL_EXTENSIONS, deps = {} } = {}) {
  runStartupChecks({ serviceConfig, nodeConfig });
  const fdConfig = nodeConfig.frontdoor;
  const domain = fdConfig.domain;
  const hosts = frontDoorHosts(domain);
  const publicUrl = `https://${hosts.mcp}`;
  const fdDir = path.join(dataDir, 'frontdoor');
  fs.mkdirSync(path.join(fdDir, 'oauth'), { recursive: true, mode: 0o700 });

  const steps = [];
  const started = (name, fn) => steps.push({ name, fn });
  const stopAll = () => stopInOrder(steps.splice(0).reverse(), { onStep: deps.onStop || null });

  try {
    const ports = deps.ports || buildServicePorts({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeConfig.name);
    const frontdoorId = identity.nodeId;
    log.info(`front door ${frontdoorId} (${nodeFingerprint(frontdoorId)}) for ${domain}`);

    // Pushes go out once the relay (devices, pusher) exists; before that
    // there is no phone to push to.
    let notify = () => {};
    const alerts = new AlertCenter({ file: path.join(fdDir, 'alerts.json'), push: (alert) => notify('alert', alert.id) });
    // R25: approvers only from the admin config dir. Test keys only when a
    // test says so, never from the data dir, env or service.json.
    const approverStore = new ApproverStore({
      dir: path.join(configDir, 'approvers'),
      stagedDir: path.join(dataDir, 'approvals', 'staged'),
      adminUid,
      geteuid,
      ...(deps.approverStoreOptions || {}),
      allowTestKeys: deps.allowTestKeys === true,
      serviceProbe: true
    });
    await approverStore.ready();
    const ownLedger = new AuditLedger({
      dir: path.join(dataDir, 'audit'), identity, nodeId: frontdoorId, writer: 'service',
      retentionDays: (serviceConfig.audit && serviceConfig.audit.retentionDays) || 365
    });
    const prune = () => {
      try {
        ownLedger.prune();
      } catch (err) {
        log.warn(`audit prune failed: ${err.message}`);
      }
    };
    prune();
    const pruneTimer = setInterval(prune, AUDIT_PRUNE_EVERY_MS);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
    started('audit prune', () => clearInterval(pruneTimer));

    // TLS source. Operator files are read now, so a bad file refuses start
    // before anything binds; ACME starts once the listener can answer
    // TLS-ALPN-01.
    let tlsSource;
    let announceRotation = async () => { throw new Error('the front door is still starting'); };
    if (fdConfig.tls) {
      tlsSource = new OperatorTls({ host: hosts.mcp, certFile: fdConfig.tls.certFile, keyFile: fdConfig.tls.keyFile, alerts });
      started('tls', () => tlsSource.stop());
      await Promise.resolve(tlsSource.start());
    } else {
      const { AcmeManager } = require('./tls/acme');
      tlsSource = new AcmeManager({
        domain, email: fdConfig.acme.email, directoryUrl: fdConfig.acme.directory, termsAgreed: fdConfig.acme.termsAgreed,
        dir: path.join(fdDir, 'acme'), cipher: ports.cipher, alerts, ...(deps.acmeAdapterFactory ? { adapterFactory: deps.acmeAdapterFactory } : {}),
        // Resolved only once repin.json is saved; until then AcmeManager keeps
        // its next-key file and the next start announces the rotation again.
        onRotated: (event) => announceRotation(event)
      });
      started('tls', () => tlsSource.stop());
    }
    // The fingerprint of the certificate mcp. serves now (read on every
    // probe run, so a reload or renewal is followed).
    const mcpFingerprint = () => {
      const cert = tlsSource.certificate();
      if (!cert || !cert.chain) throw new Error('no mcp. certificate is installed');
      return crypto.createHash('sha256').update(new crypto.X509Certificate(cert.chain).raw).digest('hex');
    };

    // Check 6: every registry record verifies (bad ones are quarantined).
    const registry = new NodeRegistry({ configDir, dataDir, approverStore, frontdoorId, alerts, adminUid, geteuid });
    registry.load();
    // Console records removed while the front door was stopped are audited.
    const consoleKnownFile = path.join(fdDir, 'console-nodes.json');
    const auditRemovals = (noticed, alreadyAudited = []) => auditConsoleRemovals({ configDir, file: consoleKnownFile, ledger: ownLedger, noticed, alreadyAudited });
    await auditRemovals('start');
    warnAboutF3Nodes(dataDir);
    const isPinnedNodeCert = makePinCheck(() => registry.peers().map((p) => p.tlsFingerprint));

    const transport = new MeshTransport({
      identity, listen: false, useTls: true, requireClientCert: true, isPinned: isPinnedNodeCert, duplicatePingMs: DUPLICATE_PING_MS
    });
    const relay = await startRelay({
      dataDir, identity, listeners: 'external', transport, phoneSpki: tlsSource.leafSpki(), registry: registry.peerSource(),
      config: { publicUrl, push: parsePushConfig(serviceConfig.relayRaw ? serviceConfig.relayRaw.push : undefined, 'service.json') },
      ...(deps.senders ? { senders: deps.senders } : {})
    });
    started('relay', () => relay.stop());
    // Dial-out-only start: no listener of its own, but the heartbeat runs and
    // the transport counts as running (a duplicate link's takeover needs it).
    await transport.start();
    const unwatchTransport = registry.watchTransport(transport);
    started('registry transport watch', () => unwatchTransport());
    notify = createApproverNotifier({ approverStore, devices: relay.devices, pusher: relay.pusher });

    // The front door as its own node (E3): F3's console enrollment, device
    // staging and history work against it unchanged.
    const selfLink = new FrontDoorSelfLink({ nodeHub: relay.nodeHub, dataDir, frontdoorId, publicUrl, spki: () => relay.phoneSpki });
    let adminRpc = async () => { throw Object.assign(new Error('the front door is still starting'), { code: 'not_ready' }); };
    const courierPump = new CourierPump({ dataDir, relayClient: selfLink, identity, rpcHandler: (method, params) => adminRpc(method, params) });
    relay.nodeHub.attachLocalNode({
      nodeId: frontdoorId, nodeName: nodeConfig.name, publicKeyHex: identity.publicKey.toString('hex'),
      dispatch: createRelayDispatcher({ phoneApprover: NO_APPROVALS, approverStore, auditLedger: ownLedger, courierPump })
    });
    selfLink.writeLink();
    courierPump.start();
    started('courier', () => courierPump.stop());
    const stopTracking = trackDeviceStates({ approverStore, relayClient: selfLink });
    started('device states', () => stopTracking());

    // Router, OAuth, MCP.
    const scopeRegistry = createFleetScopeRegistry();
    const cache = new JobCache({ file: path.join(fdDir, 'node-status.json') }).load();
    const router = new FleetRouter({ registry, nodeHub: relay.nodeHub, cache, scopeRegistry }).attach().start();
    started('router', () => router.stop());
    for (const extension of toolExtensions) extension({ scopeRegistry, router });
    for (const scope of fdConfig.oauth.scopesEnabled) {
      if (!scopeRegistry.has(scope)) throw new Error(`frontdoor.oauth.scopes_enabled lists "${scope}", which nothing registers`);
    }

    const oauthDir = path.join(fdDir, 'oauth');
    const clients = new ClientRegistry({ file: path.join(oauthDir, 'clients.json') });
    const pending = new PendingAuthorizations();
    const grants = new GrantStore({ file: path.join(oauthDir, 'grants.json'), approverStore, frontdoorId, alerts });
    grants.load();
    const codes = new AuthCodes();
    // Bound to the grant store: without it the token store authenticates nothing.
    const tokens = new TokenStore({
      file: path.join(oauthDir, 'tokens.json'), accessTtlMs: fdConfig.oauth.accessTokenTtlMs, refreshIdleTtlMs: fdConfig.oauth.refreshIdleTtlMs, grants
    });
    const challenges = new Challenges();
    let mcp = null;
    // The shared revoke helper (revokeGrantEverywhere) has already dropped
    // the grant's tokens when this runs; this only ends its MCP sessions.
    const onGrantRevoked = (grantId) => {
      if (mcp) mcp.endSessionsForGrant(grantId);
    };
    const oauth = new OAuthServer({
      domain, clients, pending, scopeRegistry, scopesEnabled: fdConfig.oauth.scopesEnabled, clientDefaults: fdConfig.oauth.clientDefaults,
      tokens, codes, grants, alerts, auditLedger: ownLedger, onGrantRevoked
    });
    registerGrantRoutes(relay.phoneApi, {
      pending, grants, codes, clients, challenges, approverStore, frontdoorId,
      // tokens: a backup. The token store already drops a revoked grant's
      // tokens on the grant store's 'revoked' event and checks grants.live()
      // on every use; revokeGrantEverywhere drops them here as well.
      scopeRules: () => scopeRegistry.rules(fdConfig.oauth.scopesEnabled), auditLedger: ownLedger, onGrantRevoked, tokens, nodes: registry
    });
    mcp = new McpHttpEndpoint({ mcpHost: hosts.mcp, resourceUrl: oauth.resourceUrl, tokens, grants, scopeRegistry, router, progressHoldS: fdConfig.mcp.progressHoldS });

    const listen = deps.listen || fdConfig.listen;
    const meshUrlFor = (port) => `wss://${hosts.mesh}${port === 443 ? '' : `:${port}`}/mesh/v1`;
    // Set again once the listener is bound (port 0 in tests); nothing can
    // reach /pair/v1 before that.
    const pairing = new PairingService({
      file: path.join(fdDir, 'pairing.json'), registry, identity, approverStore, frontdoorHost: hosts.mcp,
      meshUrl: meshUrlFor(deps.publicPort || listen.port), meshCertFingerprint: () => identity.tlsFingerprint,
      alerts, auditLedger: ownLedger, notify: (kind, id) => notify(kind, id)
    });

    const mirror = new AuditMirror({ dir: path.join(fdDir, 'mirror'), alerts, retentionDays: fdConfig.audit.retentionDays });
    router.on('hello', ({ nodeId }) => {
      const record = registry.byId(nodeId);
      if (!record) return;
      mirror.sync(nodeId, { fetchSlice: mirrorFetcher(relay.nodeHub, nodeId), spkiHex: spkiHexFromRaw(record.public_key) })
        .catch((err) => log.warn(`audit mirror sync for ${record.node_name} failed: ${err.message}`));
    });

    // The relay's phone pin and link.json follow the certificate mcp. serves.
    const spkiChanged = () => {
      const spki = tlsSource.leafSpki();
      if (spki && spki !== relay.phoneSpki) relay.setPhoneSpki(spki);
      selfLink.writeLink();
    };
    // Re-pin (§3.3.1): a rotated mcp. key is announced with a signed envelope.
    const repin = new RepinPublisher({ identity, publicUrl, file: path.join(fdDir, 'repin.json'), auditLedger: ownLedger, onPinChanged: spkiChanged });
    announceRotation = async (event) => {
      try {
        await repin.rotated(event);
      } catch (err) {
        log.error(`publishing the re-pin failed: ${err.message}; it is published again at the next start`);
        throw err;
      }
    };

    // After F3's routes (startRelay registered them): a front-door route
    // with the same method and path, POST /v1/pairing-codes, replaces F3's.
    registerFrontDoorRoutes(relay.phoneApi, {
      approverStore, devices: relay.devices, nodeHub: relay.nodeHub, registry, pairing, mirror, alerts, challenges, identity, domain,
      certificate: () => {
        const cert = tlsSource.certificate();
        return cert ? { notAfter: new Date(cert.notAfter).toISOString() } : null;
      },
      repin: () => repin.current(), ownLedger, auditLedger: ownLedger
    });

    let probe = null;
    const handler = createFrontDoorHandler({
      mcpHost: hosts.mcp, oauth, mcp, phoneApiHandler: relay.phoneApiHandler,
      pairHandler: createPairHandler({ pairing }),
      probeHandler: createProbeHandler({ expects: (nonce) => Boolean(probe && probe.expects(nonce)) })
    });
    const mcpServer = createMcpHttpServer(handler, deps.mcpServerLimits || {});
    const meshServer = createMeshHttpServer(deps.meshServerLimits || {});
    // Neither listens; the listener's stop() destroys the sockets they hold.
    started('http servers', () => { mcpServer.close(() => {}); meshServer.close(() => {}); });
    transport.attachServer(meshServer);
    const listener = new SniListener({
      host: listen.host, port: listen.port, domain,
      mcpContext: () => tlsSource.currentContext(),
      meshContext: meshSecureContext(identity),
      isPinnedNodeCert,
      isProbeCert: (fp) => Boolean(probe) && probe.isProbeCert(fp) === true,
      acmeChallenge: (name) => tlsSource.challengeFor(name),
      onMcpSocket: (s) => mcpServer.emit('connection', s),
      onMeshSocket: (s) => meshServer.emit('connection', s),
      onUnknownNodeKey: (info) => alerts.unknownNodeKey(info)
    });
    started('listener', () => listener.stop());
    await listener.start(); // check 5
    const publicPort = deps.publicPort || listener.address().port;
    pairing.meshUrl = meshUrlFor(publicPort);

    if (!fdConfig.tls) await tlsSource.start();
    spkiChanged();

    // Never allowLoopbackForTests outside a test: a name that resolves to
    // loopback must fail the probe.
    probe = new SelfProbe({
      domain, port: publicPort, file: path.join(fdDir, 'probe.json'), alerts,
      ownMeshFingerprint: () => identity.tlsFingerprint, ownMcpFingerprint: mcpFingerprint,
      ...(deps.probeAllowLoopbackForTests === true ? { allowLoopbackForTests: true } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}), ...(deps.probeCa ? { ca: deps.probeCa } : {})
    }).start();
    started('probe', () => probe.stop());

    adminRpc = async (method, params = {}) => {
      switch (method) {
        case 'frontdoor.status':
          return { frontdoor_id: frontdoorId, fingerprint: nodeFingerprint(frontdoorId), domain, mesh_cert_fingerprint: identity.tlsFingerprint, tls: tlsSource.status(), phones: approverStore.activeCount() };
        case 'frontdoor.code':
          return pairing.issue(params.node_name, { by: 'console', confirm: params.confirm === true ? 'console' : 'phone' });
        case 'frontdoor.pairing': {
          const p = pairing.consolePending(params.node_name);
          return p ? { pairing_id: p.pairing_id, node_id: p.node_id, node_name: p.node_name, profile: p.profile, public_key: p.public_key, tls_fingerprint: p.tls_fingerprint, replaces: p.replaces } : null;
        }
        case 'frontdoor.confirmed':
          return pairing.consoleConfirmed(params.pairing_id);
        case 'frontdoor.declined':
          return { ok: pairing.consoleDeclined(params.pairing_id) };
        case 'frontdoor.reload':
          registry.load();
          if (typeof params.removed === 'string' && NODE_NAME_RE.test(params.removed)) {
            await recordFrontDoorEvent(ownLedger, 'frontdoor.node.removed', { node_name: params.removed, by: 'console' });
          }
          await auditRemovals('reload', typeof params.removed === 'string' ? [params.removed] : []);
          return { nodes: registry.list().length };
        case 'frontdoor.nodes':
          return registry.list().map((r) => {
            const p = registry.presence(r.node_id) || {};
            return { node_id: r.node_id, node_name: r.node_name, profile: r.profile, source: r.source, tls_fingerprint: r.tls_fingerprint, online: Boolean(p.online), last_seen: p.last_seen || null };
          });
        case 'frontdoor.rotate_tls_key':
          return tlsSource.rotateKey();
        default:
          throw Object.assign(new Error(`${method} is not a front-door command`), { code: 'unknown_method' });
      }
    };

    // Check 7 is not fatal: a fresh front door is enrolled from its console.
    if (approverStore.activeCount() === 0) log.warn(NO_PHONE);

    // SIGHUP: console records and approvers are read again (remove-node,
    // an approver revoked at the console), then the certificate.
    const reloadTls = async () => {
      try {
        approverStore.refresh();
        registry.load();
      } catch (err) {
        log.warn(`re-reading the node registry failed: ${err.message}`);
      }
      await auditRemovals('reload');
      await tlsSource.reload();
      spkiChanged();
    };
    const onHup = () => {
      reloadTls().catch((err) => log.warn(`certificate reload failed: ${err.message}`));
    };
    if (process.platform !== 'win32') {
      process.on('SIGHUP', onHup);
      started('SIGHUP handler', () => process.removeListener('SIGHUP', onHup));
    }

    log.info(`front door ready on ${listen.host}:${listener.address().port} for ${hosts.mcp} and ${hosts.mesh}`);
    return {
      identity, relay, registry, router, pairing, oauth, tokens, grants, alerts, mirror, probe, tls: tlsSource, mcp,
      masterKeySource: ports.masterKeySource,
      address: () => listener.address(),
      reloadTls,
      adminRpc: (method, params) => adminRpc(method, params),
      stop: stopAll
    };
  } catch (err) {
    await stopAll();
    throw err;
  }
}

module.exports = {
  startFrontDoor, NO_PHONE, DUPLICATE_PING_MS, MIRROR_FETCH_TIMEOUT_MS, STOP_STEP_TIMEOUT_MS, STOP_TOTAL_TIMEOUT_MS,
  makePinCheck, mirrorFetcher, stopInOrder, meshSecureContext
};
