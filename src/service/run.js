const path = require('path');
const { createLogger } = require('../logging');
const { acquireInstanceLock } = require('./pidfile');
const { loadServiceConfig } = require('./config');
const { ensureServicePaths, ensurePrivateDir } = require('../platform/paths');
const { attachServiceLogFile } = require('./log-file');

const log = createLogger('service');

// A listener the operator explicitly switched on must not be silently absent.
// `createCore` deliberately treats a failed bind as non-fatal (it only
// `log.warn`s), which in service mode means an unprivileged local user can
// squat 127.0.0.1:<port> before boot and leave the service running with
// `features.gateway: true` and no gateway, so every client that follows the
// README talks to the squatter instead. (The token no longer reaches disk
// unless the bind succeeded — see publishGatewayToken in
// src/gateway/gateway-token.js — but the port is still someone else's.)
// `doctor` and `status` never look at listeners, so nothing else would
// notice. Refuse to start instead.
function assertEnabledListenersBound(core, features) {
  const missing = [];
  // Both servers null their handle when start() rejects, so "has a handle" is
  // exactly "bound" (src/gateway/gateway-server.js,
  // src/webhooks/webhook-server.js) — but only once that start() has settled.
  // The webhook one assigns its handle synchronously and is kicked off
  // fire-and-forget, so callers must await core.whenListenersSettled() first.
  if (features.gateway && !core.getGatewayServer()?.wss) missing.push('gateway');
  if (features.webhooks && !core.getWebhookServer()?.httpServer) missing.push('webhooks');
  if (missing.length === 0) return;
  throw new Error(
    `refusing to run without ${missing.join(' and ')}: ${missing.length > 1 ? 'those listeners are' : 'that listener is'} `
    + 'enabled in the admin config but could not bind (port already in use?). '
    + 'Free the port or turn the feature off, then start the service again.'
  );
}

// loadNodeConfig options for one admin dir: an injected configDir (tests)
// and adminUid win; omitted, node-config's own platform defaults apply.
function adminDirOptions({ dataDir, adminUid, configDir }) {
  return {
    dataDir,
    ...(configDir ? { adminConfigDir: configDir } : {}),
    ...(adminUid === undefined ? {} : { adminUid })
  };
}

// The same admin dir and owner for startApprovals: the approver store checks
// approvers/ against adminUid, like node.yaml above.
function adminDirApprovalOptions({ adminUid, configDir }) {
  return {
    ...(configDir ? { configDir } : {}),
    ...(adminUid === undefined ? {} : { approverStoreOptions: { adminUid } })
  };
}

// Each profile is required lazily so the runbook profile never loads the agent stack.
function loadProfile(profile) {
  if (profile === 'agent') {
    return {
      async start({ dataDir, features, ports, workspace, audit, contact = null, adminUid, configDir }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const { loadNodeConfig } = require('./node-config');
        const { startApprovals } = require('../approvals/service-wiring');
        const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        // Fleet stage 7: the desktop bridge's ui/host ports, when enabled.
        // configDir: injectable so tests never fall through to the real
        // per-platform admin config dir (e.g. /etc/king-louie); production
        // callers omit it and get service-wiring's own platform default.
        // The same configDir (and adminUid) reach node.yaml and the approver
        // store below, so the bridge, node config and approvals all read one
        // admin dir.
        const { createDesktopBridgeHost } = require('../desktop-bridge/service-wiring');
        const desktopBridge = createDesktopBridgeHost({ dataDir, features, ports, adminUid, configDir });
        const nodeConfig = loadNodeConfig(adminDirOptions({ dataDir, adminUid, configDir }));
        // Fleet stage 3: an unsafe tool from anything remote (chat channels,
        // gateway clients, cron, webhooks) runs only with a signed phone
        // approval; with no enrolled phone or no relay it is refused.
        const approvals = await startApprovals({
          dataDir, ...adminDirApprovalOptions({ adminUid, configDir }),
          nodeConfig, ports: servicePorts, profile: 'agent', serviceConfig: { audit }
        });
        let core;
        try {
          // createCore itself can throw synchronously (bad deps, a bad
          // phoneApprover.ttlMs, …), not just its start() — both go in the
          // one try, or a throw from createCore would skip the approvals
          // teardown below entirely and leave a live relay link behind.
          core = createCore({
            ...servicePorts,
            ...desktopBridge.coreDeps,
            features,
            ports,
            workingDirectory: workspace,
            // Cases stage 4: the owner identity and contact addresses, from
            // the admin service.json only (runService loads it once, with
            // adminUid). The key is always present: it means service mode.
            contactConfig: contact ?? null,
            isService: true,
            remoteApprovals: 'phone',
            phoneApprover: approvals.phoneApprover,
            auditLedger: approvals.auditLedger,
            approvals, // Cases stage 4 (wave 3): the phone contact channel (relay link, admin approvers, node identity)
            nodePolicy: nodeConfig.policy,
            builtinSkillsDir: path.join(__dirname, '..', '..', 'skills')
          });
          await core.start();
        } catch (err) {
          // `core` is only assigned once createCore() itself has returned,
          // so a throw from createCore leaves it undefined here — nothing to
          // shut down. A rejecting core.start() is different: core.start()
          // may have partially started the core (cron timers, a listener
          // bind in flight) before rejecting, so it still needs a best-effort
          // shutdown ahead of stopping approvals.
          await desktopBridge.stop().catch(() => {});
          if (core) await core.shutdown().catch(() => {});
          await approvals.stop().catch(() => {});
          throw err;
        }
        try {
          // createCore starts the webhook listener fire-and-forget, so
          // core.start() can return while its bind is still in flight and its
          // handle already non-null. Wait for it before judging.
          await core.whenListenersSettled();
          assertEnabledListenersBound(core, features);
          await desktopBridge.start({ core, ports: servicePorts, approvals });
        } catch (err) {
          // Don't leave a half-started core (and its cron timers) behind.
          await desktopBridge.stop().catch(() => {});
          await core.shutdown().catch(() => {});
          await approvals.stop().catch(() => {});
          throw err;
        }
        return {
          // The bridge says bye and closes before the core goes down, and
          // approvals (relay link, courier, audit ledger) stop last. Each
          // later step runs even if an earlier stop() throws (a wedged
          // dispatcher, say) — never skip one and leave cron timers, stores
          // or a live relay link running.
          stop: async () => {
            try {
              await desktopBridge.stop();
            } finally {
              try {
                await core.shutdown();
              } finally {
                await approvals.stop();
              }
            }
          },
          masterKeySource: servicePorts.masterKeySource,
          desktopBridge,
          approvals
        };
      }
    };
  }
  if (profile === 'runbook') {
    return {
      async start({ dataDir, audit, adminUid, configDir }) {
        const { buildServicePorts } = require('./ports');
        const { loadNodeConfig } = require('./node-config');
        const { startApprovals } = require('../approvals/service-wiring');
        const servicePorts = buildServicePorts({ dataDir });
        // The runbook profile runs the relay link and the courier that the
        // `mcp` process sends its approval requests through; still no agent stack.
        const nodeConfig = loadNodeConfig(adminDirOptions({ dataDir, adminUid, configDir }));
        const approvals = await startApprovals({
          dataDir, ...adminDirApprovalOptions({ adminUid, configDir }),
          nodeConfig, ports: servicePorts, profile: 'runbook', serviceConfig: { audit }
        });
        return { stop: () => approvals.stop(), masterKeySource: servicePorts.masterKeySource, approvals };
      }
    };
  }
  throw new Error(`Unknown profile "${profile}"`);
}

// The unit files set WorkingDirectory=<dataDir>, which made the secret store
// the agent's own workspace: master.key, key-check, gateway-token,
// chat-data.json and config.json all sit in process.cwd(), and the ungated
// read tools (Read, Grep, Glob — none of which require approval) treat the
// working directory as in-bounds. A chat message was enough to read the
// master key. The service therefore runs in an explicit, empty workspace
// beside the data dir's other subdirectories; src/tools/utils.js separately
// denies the secret files outright, whatever the workspace is.
//
// The workspace is handed to createCore as its `workingDirectory`, which is
// what every tool executor and runtime environment inside the core uses. The
// process is *also* moved there, once, before the core starts: createCore does
// not own every consumer of `process.cwd()`, and the ones it does not own are
// exactly the ones that reach outside the process. A stdio MCP server
// configured without an explicit `cwd` (src/mcp/mcp-client.js) is spawned with
// the cwd it inherits, and the template, hook and sandbox directory fallbacks
// (src/templates/template-engine.js, src/hooks/hook-registry.js,
// src/execution/runtime-environment.js) resolve against it too. With the
// units' WorkingDirectory gone, that inherited cwd would otherwise be whatever
// the service manager happened to pick.
//
// This is a deliberate one-time host decision made before anything else runs,
// not a setting the core may change: createCore never chdirs (pinned by
// tests/core-create.test.js).
function ensureWorkspace(dataDir) {
  const workspace = path.join(dataDir, 'workspace');
  ensurePrivateDir(workspace);
  process.chdir(workspace);
  return workspace;
}

// adminUid: tests only (who owns the admin config); never from argv or config.
async function runService({ dataDir: requestedDataDir, profile: profileOverride, signal, stdout = process.stdout, adminUid }) {
  // Resolved once, here, because this is the only place that moves the
  // process: ensureWorkspace chdirs below, and a relative --data-dir would
  // then be re-resolved against the *new* cwd by everything built afterwards
  // — the master key, key-check, the pidfile and the memory stores would land
  // in <dataDir>/workspace/<dataDir> while the log file, written before the
  // chdir, stayed in <dataDir>. `status` reported "not running" while it ran
  // and `doctor` reported the key missing. Resolving before the chdir (rather
  // than sprinkling path.resolve over each consumer) makes every later
  // resolution agree with the operator's own cwd, which is what a separate
  // `status`, `doctor` or `vault set` process resolves against.
  const dataDir = path.resolve(requestedDataDir);
  const { logsDir } = ensureServicePaths(dataDir);
  const logFile = attachServiceLogFile(logsDir);
  // Before the core, its cron timers and its store writers exist: two `run`
  // processes sharing one data dir corrupt each other's stores, and with the
  // default feature set no listener binds, so a port clash would not have
  // caught it either.
  let lock;
  try {
    lock = acquireInstanceLock(dataDir);
  } catch (err) {
    log.error(err.message);
    logFile.close();
    throw err;
  }
  const workspace = ensureWorkspace(dataDir);
  try {
    let running;
    let profile;
    try {
      const config = loadServiceConfig(dataDir, { profile: profileOverride }, adminUid === undefined ? {} : { adminUid });
      profile = config.profile;
      log.info('service starting', { profile, dataDir, workspace, pid: process.pid });
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports, workspace, audit: config.audit, contact: config.contact, adminUid });
    } catch (err) {
      // On Windows nothing reads the task's stderr, so the log file is the
      // only place a startup failure is visible.
      log.error(`service failed to start: ${err.message}`);
      throw err;
    }
    stdout.write(`${JSON.stringify({ event: 'ready', profile, dataDir, workspace, cwd: process.cwd(), pid: process.pid, masterKeySource: running.masterKeySource })}\n`);
    log.info('service ready', { profile, masterKeySource: running.masterKeySource });

    await new Promise((resolve) => {
      const onShutdown = () => resolve();
      process.once('SIGTERM', onShutdown);
      process.once('SIGINT', onShutdown);
      process.on('message', (m) => { if (m && m.type === 'shutdown') onShutdown(); });
      if (signal) signal.addEventListener('abort', onShutdown, { once: true });
    });

    log.info('shutting down');
    await running.stop();
    log.info('stopped');
  } finally {
    lock.release();
    logFile.close();
  }
}

module.exports = { runService, loadProfile, assertEnabledListenersBound };
