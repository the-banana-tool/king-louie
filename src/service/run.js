const path = require('path');
const { createLogger } = require('../logging');
const { writePidfile, removePidfile } = require('./pidfile');
const { loadServiceConfig } = require('./config');
const { ensureServicePaths } = require('../platform/paths');
const { attachServiceLogFile } = require('./log-file');

const log = createLogger('service');

// A listener the operator explicitly switched on must not be silently absent.
// `createCore` deliberately treats a failed bind as non-fatal (it only
// `log.warn`s), which in service mode means an unprivileged local user can
// squat 127.0.0.1:<port> before boot and leave the service running with
// `features.gateway: true`, no gateway, and a freshly minted bearer token
// sitting in <dataDir>/gateway-token for any client that follows the README
// to hand straight to the squatter. `doctor` and `status` never look at
// listeners, so nothing else would notice. Refuse to start instead.
function assertEnabledListenersBound(core, features) {
  const missing = [];
  // Both servers null their handle when start() rejects, so "has a handle"
  // is exactly "bound" (src/gateway/gateway-server.js, src/webhooks/webhook-server.js).
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
      async start({ dataDir, features, ports }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        const core = createCore({
          ...servicePorts,
          features,
          ports,
          // Stage 1: nothing remote (chat channels, gateway clients, cron,
          // webhooks) may approve an unsafe tool; stage 3 adds the phone approver.
          remoteApprovals: 'deny',
          builtinSkillsDir: path.join(__dirname, '..', '..', 'skills')
        });
        await core.start();
        try {
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

async function runService({ dataDir, profile: profileOverride, signal, stdout = process.stdout }) {
  const { logsDir } = ensureServicePaths(dataDir);
  const logFile = attachServiceLogFile(logsDir);
  try {
    let running;
    let profile;
    try {
      const config = loadServiceConfig(dataDir, { profile: profileOverride });
      profile = config.profile;
      log.info('service starting', { profile, dataDir, pid: process.pid });
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports });
    } catch (err) {
      // On Windows nothing reads the task's stderr, so the log file is the
      // only place a startup failure is visible.
      log.error(`service failed to start: ${err.message}`);
      throw err;
    }
    writePidfile(dataDir);
    stdout.write(`${JSON.stringify({ event: 'ready', profile, dataDir, pid: process.pid, masterKeySource: running.masterKeySource })}\n`);
    log.info('service ready', { profile, masterKeySource: running.masterKeySource });

    await new Promise((resolve) => {
      const onShutdown = () => resolve();
      process.once('SIGTERM', onShutdown);
      process.once('SIGINT', onShutdown);
      process.on('message', (m) => { if (m && m.type === 'shutdown') onShutdown(); });
      if (signal) signal.addEventListener('abort', onShutdown, { once: true });
    });

    log.info('shutting down');
    try {
      await running.stop();
    } finally {
      removePidfile(dataDir);
    }
    log.info('stopped');
  } finally {
    logFile.close();
  }
}

module.exports = { runService, loadProfile, assertEnabledListenersBound };
