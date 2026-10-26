const os = require('os');
const path = require('path');
const { createLogger } = require('../logging');
const { acquireInstanceLock } = require('./pidfile');
const { loadServiceConfig } = require('./config');
const { ensureServicePaths, ensurePrivateDir, asarUnpackedPath } = require('../platform/paths');
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

// R-F5-17: this node's identity, loaded (or made, on a first start) from the
// data dir and held against the administrator's record of it in the config
// dir. Throws when the record names another identity or cannot be trusted;
// with no record it warns and goes on. → { identity, record }.
// hosting 'personal' (spec 2026-10-25 §6): the process is the owner of the
// data dir and the config dir (checked before this), so the record vouches
// for nothing more and is not read; its state is 'personal'.
// deps.identityRecord: tests only (how a temp dir's record is read).
function checkRecordedIdentity({ servicePorts, nodeConfig, dataDir, adminUid, configDir, hosting = 'service', deps = {} }) {
  const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
  const identity = getOrGenerateNodeIdentity(servicePorts.store, servicePorts.cipher, nodeConfig.name);
  if (hosting === 'personal') {
    return { identity, record: { state: 'personal', file: null, problem: null, recorded: null } };
  }
  const { assertRecordedIdentity } = require('./identity-record');
  const { adminConfigDir } = require('../platform/paths');
  const record = assertRecordedIdentity({
    configDir: configDir || adminConfigDir({ dataDir }), dataDir, identity,
    ...(adminUid === undefined ? {} : { adminUid }), ...(deps.identityRecord || {})
  });
  return { identity, record };
}

// R-F5-20 (fourth security review, finding 2): a node on which computer use
// is off still answers a phone's "what is running" with a listing it signs:
// nothing. Registered only where no lease manager exists (`gui` null, or a
// subsystem that is off), so no lease can be live and the answer is true; a
// node with a lease manager answers from it (src/gui/index.js). A node with
// no relay link has nobody to answer.
function answerLeaseListsWithNone(approvals, gui = null) {
  if (gui && gui.leases) return false;
  const relay = approvals && approvals.relayClient;
  if (!relay || typeof relay.registerMethod !== 'function' || !approvals.identity) return false;
  try {
    relay.registerMethod('lease.list', require('../gui/lease-protocol').offLeaseListing({ identity: approvals.identity, approverStore: approvals.approverStore }));
    return true;
  } catch (err) {
    // The link refuses a name that is taken: a GUI that failed while it was
    // being built can have registered its own lease.list first (it holds no
    // lease, so it lists nothing either). Never a reason to stop the service.
    log.warn(`lease.list was not registered for a node without computer use: ${err.message}`);
    return false;
  }
}

// Each profile is required lazily so the runbook profile never loads the agent stack.
function loadProfile(profile) {
  if (profile === 'agent') {
    return {
      // deps: tests only (deps.gui reaches createGuiSubsystem's deps, for a
      // helper endpoint under a temp dir or a personal node's channel;
      // deps.personalOwner reaches assertPersonalOwner). runService passes
      // its own deps through, which are none outside tests.
      async start({ dataDir, features, ports, workspace, audit, contact = null, playbooks = null, localInference = null, caseChecks = null, adminUid, configDir, executors, deps = {} }) {
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
        const hosting = nodeConfig.hosting;
        const { adminConfigDir, desktopProfileDir } = require('../platform/paths');
        const cfgDir = configDir || adminConfigDir({ dataDir });
        // R-F5-17: the identity in the data dir must be the one an
        // administrator recorded, before anything is signed with it or any
        // link is opened. A mismatch, or a record that cannot be trusted,
        // stops the start; no record is a warning (and no computer use).
        // Personal hosting (spec 2026-10-25 §6): instead, this process must
        // own the data dir and the config dir, checked once, here, before
        // approvals and the GUI; anything else refuses (PERSONAL_NOT_OWNER).
        let recordedIdentity;
        try {
          if (hosting === 'personal') {
            const { assertPersonalOwner } = require('./personal-host');
            assertPersonalOwner({ dataDir, configDir: cfgDir, ...(deps.personalOwner || {}) });
            log.info(`hosting: personal (runs as ${os.userInfo().username}; the owner account is the trust boundary)`);
          }
          recordedIdentity = checkRecordedIdentity({ servicePorts, nodeConfig, dataDir, adminUid, configDir, hosting, deps });
        } catch (err) {
          await desktopBridge.stop().catch(() => {});
          throw err;
        }
        // Fleet stage 3: an unsafe tool from anything remote (chat channels,
        // gateway clients, cron, webhooks) runs only with a signed phone
        // approval; with no enrolled phone or no relay it is refused.
        const approvals = await startApprovals({
          dataDir, ...adminDirApprovalOptions({ adminUid, configDir }),
          // Personal hosting keeps the approver dir's owner read and drops
          // its write probe (the owner can always write there).
          approverStoreOptions: { ...adminDirApprovalOptions({ adminUid, configDir }).approverStoreOptions, hosting },
          nodeConfig, ports: servicePorts, profile: 'agent', serviceConfig: { audit }, identity: recordedIdentity.identity
        });
        let core;
        let fleet = null;
        // Fleet stage 5: desktop apps through the session helper (null when
        // gui is off or no helper is installed). configDir falls back to the
        // same per-platform admin dir service-wiring uses. Neither
        // createGuiSubsystem nor gui.start() throws: a GUI that cannot be
        // built or started is off with a reason, and the service goes on.
        let gui = null;
        try {
          const { createGuiSubsystem, isJobOpen } = require('../gui');
          gui = createGuiSubsystem({
            nodeConfig, dataDir, configDir: cfgDir, cipher: servicePorts.cipher, approvals, hosting,
            // R-F5-7, late-bound: the core and the fleet node are built after
            // this. Until both exist, and for any job neither knows, no job
            // is open (fail closed).
            jobOpen: (jobId) => isJobOpen({
              jobManager: fleet ? fleet.jobManager : null,
              chatExists: (chatId) => Boolean(core && core.context.getChat(chatId, { messages: false }))
            }, jobId),
            ...(adminUid === undefined ? {} : { adminUid }),
            // R-F5-17: the check made above; only a match turns desktop apps on.
            identityRecord: recordedIdentity.record,
            // deps.identityRecord (tests only) also says whether the GUI
            // runs the record's write probe again before a lease request.
            ...(deps.gui || deps.identityRecord ? { deps: { ...(deps.identityRecord ? { identityRecord: deps.identityRecord } : {}), ...(deps.gui || {}) } } : {})
          });
        } catch (err) {
          await desktopBridge.stop().catch(() => {});
          await approvals.stop().catch(() => {});
          throw err;
        }
        // R-F5-20: with computer use off, this node still tells its phones so.
        answerLeaseListsWithNone(approvals, gui);
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
            // Cases stage 6 (ruling T14-admin): the playbook source allowlist
            // and autoUpdate, from the admin service.json only.
            playbooksConfig: playbooks ?? { sources: [], autoUpdate: false },
            // Local inference stage L1 (R-LI-6): which servers are local comes
            // from the admin service.json only. The key is always present.
            localInference: localInference ?? { servers: [] },
            // Cases stage 8 (R-C8-3): whether a case may run its check
            // command, from the admin service.json only. Off without it.
            caseChecksConfig: { enabled: caseChecks?.enabled === true },
            isService: true,
            remoteApprovals: 'phone',
            phoneApprover: approvals.phoneApprover,
            auditLedger: approvals.auditLedger,
            gui, // Fleet stage 5: the GUI subsystem, or null
            // Personal hosting (R-PN-1): the OS no longer keeps the owner's
            // config dir (node.yaml, approvers) and the desktop app's profile
            // from the file tools, so they are denied outright.
            deniedDirs: hosting === 'personal' ? [cfgDir, desktopProfileDir({ platform: process.platform, env: process.env })] : [],
            approvals, // Cases stage 4 (wave 3): the phone contact channel (relay link, admin approvers, node identity)
            nodePolicy: nodeConfig.policy,
            builtinSkillsDir: path.join(__dirname, '..', '..', 'skills'),
            examplesDir: asarUnpackedPath(path.join(__dirname, '..', '..', 'examples', 'playbooks')),
            // Cases stage 3: executors only from the admin service.json (R42);
            // always present, so the registry is always in service mode here.
            adminExecutors: executors || { entries: {}, packageRoots: [] },
            // Cases stage 3's runbook executor reads this lazily; fleet stage
            // 4's node hosts the one engine (R24), started after createCore.
            get runbookEngine() { return fleet ? fleet.runbookEngine : null; },
            // The executor package root check is bound to the same admin
            // owner as node.yaml and the approver store (M16).
            ...(adminUid === undefined ? {} : { adminUid }),
            // The signed-grant audit path checks phone signatures against the
            // admin-owned approver store and this node's identity.
            approvalTrust: {
              approverStore: approvals.approverStore,
              nodeId: approvals.identity.nodeId,
              nodePublicKey: approvals.identity.publicKey
            }
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
          if (gui) await gui.stop().catch(() => {});
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
          // Fleet stage 4 §3.7: the runbook engine, JobManager, delegate
          // sessions and the fleet link methods, hosted by the service.
          const { startFleetNode } = require('../fleet/start');
          fleet = await startFleetNode({ dataDir, nodeConfig, approvals, core, adminUid, deps: { leaseManager: gui ? gui.leases : null, takeManager: gui ? gui.takes : null } });
          if (gui) await gui.start();
        } catch (err) {
          if (gui) await gui.stop().catch(() => {});
          if (fleet) await fleet.stop().catch(() => {});
          // Don't leave a half-started core (and its cron timers) behind.
          await desktopBridge.stop().catch(() => {});
          await core.shutdown().catch(() => {});
          await approvals.stop().catch(() => {});
          throw err;
        }
        return {
          // The fleet node stops first (its link methods refuse and the
          // courier handler is removed, so nothing is dispatched into a core
          // that is shutting down), the bridge says bye and closes before the
          // core goes down, and approvals (relay link, courier, audit
          // ledger) stop last. Each
          // later step runs even if an earlier stop() throws (a wedged
          // dispatcher, say) — never skip one and leave cron timers, stores
          // or a live relay link running.
          // The GUI stops before all of them: it ends every lease
          // service_stopped and closes the helper channel first.
          stop: async () => {
            try {
              if (gui) await gui.stop();
            } finally {
              try {
                if (fleet) await fleet.stop();
              } finally {
                try {
                  await desktopBridge.stop();
                } finally {
                  try {
                    await core.shutdown();
                  } finally {
                    await approvals.stop();
                  }
                }
              }
            }
          },
          startBackgroundChecks: () => core.models.startBackgroundChecks(),
          masterKeySource: servicePorts.masterKeySource,
          desktopBridge,
          approvals,
          fleet,
          gui
        };
      }
    };
  }
  if (profile === 'runbook') {
    return {
      async start({ dataDir, audit, adminUid, configDir, deps = {} }) {
        const { buildServicePorts } = require('./ports');
        const { loadNodeConfig } = require('./node-config');
        const { startApprovals } = require('../approvals/service-wiring');
        const servicePorts = buildServicePorts({ dataDir });
        // The runbook profile runs the relay link and the courier that the
        // `mcp` process sends its approval requests through; still no agent stack.
        const nodeConfig = loadNodeConfig(adminDirOptions({ dataDir, adminUid, configDir }));
        // R-F5-17: as on an agent node, before anything is signed or linked.
        const recordedIdentity = checkRecordedIdentity({ servicePorts, nodeConfig, dataDir, adminUid, configDir, deps });
        const approvals = await startApprovals({
          dataDir, ...adminDirApprovalOptions({ adminUid, configDir }),
          nodeConfig, ports: servicePorts, profile: 'runbook', serviceConfig: { audit }, identity: recordedIdentity.identity
        });
        // R-F5-20: a runbook node never runs computer use, and says so to a
        // phone that asks (the one file of src/gui/ this profile loads for it
        // is lease-protocol.js, which holds no agent code).
        answerLeaseListsWithNone(approvals);
        let fleet;
        try {
          const { startFleetNode } = require('../fleet/start');
          fleet = await startFleetNode({ dataDir, nodeConfig, approvals, adminUid });
        } catch (err) {
          await approvals.stop().catch(() => {});
          throw err;
        }
        return {
          stop: async () => {
            try {
              await fleet.stop();
            } finally {
              await approvals.stop();
            }
          },
          masterKeySource: servicePorts.masterKeySource,
          approvals,
          fleet
        };
      }
    };
  }
  if (profile === 'frontdoor') {
    return {
      // Fleet stage 4 §3.1: the front door requires only its own profile
      // module (and node-config); no core, providers, tools or runbooks.
      async start({ dataDir, adminUid, configDir, serviceConfig, deps = {} }) {
        const { loadNodeConfig } = require('./node-config');
        const { adminConfigDir } = require('../platform/paths');
        const { startFrontDoor } = require('../frontdoor/profile');
        const dir = configDir || adminConfigDir({ dataDir });
        const nodeConfig = loadNodeConfig(adminDirOptions({ dataDir, adminUid, configDir: dir }));
        return startFrontDoor({ dataDir, configDir: dir, ...(adminUid === undefined ? {} : { adminUid }), nodeConfig, serviceConfig, deps });
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
// deps: tests only, handed to the profile's start as they are.
async function runService({ dataDir: requestedDataDir, profile: profileOverride, signal, stdout = process.stdout, adminUid, deps = {} }) {
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
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports, workspace, audit: config.audit, contact: config.contact, playbooks: config.playbooks, localInference: config.localInference, caseChecks: config.caseChecks, adminUid, executors: config.executors, serviceConfig: config, deps });
    } catch (err) {
      // On Windows nothing reads the task's stderr, so the log file is the
      // only place a startup failure is visible.
      log.error(`service failed to start: ${err.message}`);
      throw err;
    }
    stdout.write(`${JSON.stringify({ event: 'ready', profile, dataDir, workspace, cwd: process.cwd(), pid: process.pid, masterKeySource: running.masterKeySource })}\n`);
    log.info('service ready', { profile, masterKeySource: running.masterKeySource });
    if (typeof running.startBackgroundChecks === 'function') {
      running.startBackgroundChecks().catch((err) => log.warn(`Model background checks failed: ${err.message}`));
    }

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

module.exports = { runService, loadProfile, assertEnabledListenersBound, answerLeaseListsWithNone };
