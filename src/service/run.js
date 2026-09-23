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

// Each profile is required lazily so the runbook profile never loads the agent stack.
function loadProfile(profile) {
  if (profile === 'agent') {
    return {
      async start({ dataDir, features, ports, workspace }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        const core = createCore({
          ...servicePorts,
          features,
          ports,
          workingDirectory: workspace,
          // Stage 1: nothing remote (chat channels, gateway clients, cron,
          // webhooks) may approve an unsafe tool; stage 3 adds the phone approver.
          remoteApprovals: 'deny',
          builtinSkillsDir: path.join(__dirname, '..', '..', 'skills')
        });
        await core.start();
        try {
          // createCore starts the webhook listener fire-and-forget, so
          // core.start() can return while its bind is still in flight and its
          // handle already non-null. Wait for it before judging.
          await core.whenListenersSettled();
          assertEnabledListenersBound(core, features);
        } catch (err) {
          // Don't leave a half-started core (and its cron timers) behind.
          await core.shutdown().catch(() => {});
          throw err;
        }
        return { stop: () => core.shutdown(), masterKeySource: servicePorts.masterKeySource };
      }
    };
  }
  if (profile === 'runbook') {
    return {
      async start({ dataDir }) {
        const { buildServicePorts } = require('./ports');
        const servicePorts = buildServicePorts({ dataDir });
        // Stage 2 adds the runbook engine here. Stage 1 only proves the
        // profile boots with its own identity-free, agent-free module graph.
        return { stop: async () => {}, masterKeySource: servicePorts.masterKeySource };
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

async function runService({ dataDir: requestedDataDir, profile: profileOverride, signal, stdout = process.stdout }) {
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
      const config = loadServiceConfig(dataDir, { profile: profileOverride });
      profile = config.profile;
      log.info('service starting', { profile, dataDir, workspace, pid: process.pid });
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports, workspace });
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
