const { createLogger } = require('../logging');
const { writePidfile, removePidfile } = require('./pidfile');
const { loadServiceConfig } = require('./config');

const log = createLogger('service');

// Each profile is required lazily so the runbook profile never loads the agent stack.
function loadProfile(profile) {
  if (profile === 'agent') {
    return {
      async start({ dataDir, features }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const ports = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        const core = createCore({ ...ports, features, builtinSkillsDir: require('path').join(__dirname, '..', '..', 'skills') });
        await core.start();
        return { stop: () => core.shutdown(), masterKeySource: ports.masterKeySource };
      }
    };
  }
  if (profile === 'runbook') {
    return {
      async start({ dataDir }) {
        const { buildServicePorts } = require('./ports');
        const ports = buildServicePorts({ dataDir });
        // Stage 2 adds the runbook engine here. Stage 1 only proves the
        // profile boots with its own identity-free, agent-free module graph.
        return { stop: async () => {}, masterKeySource: ports.masterKeySource };
      }
    };
  }
  throw new Error(`Unknown profile "${profile}"`);
}

async function runService({ dataDir, profile: profileOverride, signal, stdout = process.stdout }) {
  const { profile, features } = loadServiceConfig(dataDir, { profile: profileOverride });
  const running = await loadProfile(profile).start({ dataDir, features });
  writePidfile(dataDir);
  stdout.write(`${JSON.stringify({ event: 'ready', profile, dataDir, pid: process.pid, masterKeySource: running.masterKeySource })}\n`);

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
}

module.exports = { runService, loadProfile };
