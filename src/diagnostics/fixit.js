const fs = require('fs');

const STATUS_ICONS = {
  PASS: '\u2705',
  WARN: '\u26A0\uFE0F',
  FAIL: '\u274C',
  SKIP: '\u23ED\uFE0F',
  INFO: '\u2139\uFE0F',
};

async function checkProvider(context) {
  if (!context.providerFactory) {
    return { status: 'SKIP', message: 'No provider factory configured' };
  }
  const providers = typeof context.providerFactory.getProviders === 'function'
    ? context.providerFactory.getProviders()
    : null;
  const hasProviders = Array.isArray(providers) ? providers.length > 0 : !!providers;
  if (hasProviders) {
    const name = Array.isArray(providers) ? providers[0] : 'configured';
    return { status: 'PASS', message: `Connected to ${name}` };
  }
  return {
    status: 'WARN',
    message: 'No providers configured',
    fix: 'Add at least one provider (e.g. OpenAI) in Settings → Providers',
  };
}

async function checkChannels(context) {
  if (!context.channelRegistry) {
    return { status: 'SKIP', message: 'No channel registry configured' };
  }
  const channels = typeof context.channelRegistry.getChannels === 'function'
    ? context.channelRegistry.getChannels()
    : null;
  const count = Array.isArray(channels) ? channels.length : 0;
  if (count > 0) {
    return { status: 'PASS', message: `${count} channel(s) registered` };
  }
  return { status: 'INFO', message: 'No channels registered' };
}

async function checkMemory(context) {
  if (!context.memoryManager) {
    return { status: 'SKIP', message: 'No memory manager configured' };
  }
  return { status: 'PASS', message: 'Memory manager available' };
}

async function checkHooks(context) {
  if (!context.hookRegistry) {
    return { status: 'SKIP', message: 'No hook registry configured' };
  }
  return { status: 'PASS', message: 'Hook registry available' };
}

async function checkSkills(context) {
  if (!context.skillRegistry) {
    return { status: 'SKIP', message: 'No skill registry configured' };
  }
  const skills = typeof context.skillRegistry.getSkills === 'function'
    ? context.skillRegistry.getSkills()
    : null;
  const count = Array.isArray(skills) ? skills.length : 0;
  if (count > 0) {
    return { status: 'PASS', message: `${count} skill(s) loaded` };
  }
  return { status: 'PASS', message: 'Skill registry available' };
}

async function checkGateway(context) {
  if (!context.gateway) {
    return { status: 'SKIP', message: 'No gateway configured' };
  }
  return { status: 'PASS', message: 'Gateway available' };
}

async function checkDocker(context) {
  if (!context.sandboxExecutor) {
    return { status: 'SKIP', message: 'No sandbox executor configured' };
  }
  if (typeof context.sandboxExecutor.isDockerAvailable !== 'function') {
    return { status: 'SKIP', message: 'Sandbox executor does not support Docker detection' };
  }
  try {
    const available = await context.sandboxExecutor.isDockerAvailable();
    if (available) {
      return { status: 'PASS', message: 'Docker is available' };
    }
    return {
      status: 'WARN',
      message: 'Docker not detected',
      fix: 'Install Docker Desktop',
    };
  } catch (err) {
    return {
      status: 'WARN',
      message: `Docker check failed: ${err.message}`,
      fix: 'Install Docker Desktop',
    };
  }
}

async function checkCron(context) {
  if (!context.cronScheduler) {
    return { status: 'SKIP', message: 'No cron scheduler configured' };
  }
  const jobs = typeof context.cronScheduler.getJobs === 'function'
    ? context.cronScheduler.getJobs()
    : null;
  const count = Array.isArray(jobs) ? jobs.length : 0;
  if (count > 0) {
    return { status: 'PASS', message: `${count} scheduled job(s)` };
  }
  return { status: 'PASS', message: 'Cron scheduler available' };
}

async function checkBrowser(context) {
  if (!context.browserService) {
    return { status: 'SKIP', message: 'No browser service configured' };
  }
  return { status: 'PASS', message: 'Browser service available' };
}

async function checkDisk() {
  try {
    fs.accessSync(process.cwd(), fs.constants.W_OK);
    return { status: 'PASS', message: 'App data directory is writable' };
  } catch (err) {
    return {
      status: 'FAIL',
      message: `App data directory is not writable: ${err.message}`,
      fix: 'Check file permissions on the application directory',
    };
  }
}

class Fixit {
  constructor(context) {
    this.context = context || {};
  }

  getChecks() {
    return [
      { name: 'Provider Connectivity', fn: checkProvider },
      { name: 'Channels', fn: checkChannels },
      { name: 'Memory', fn: checkMemory },
      { name: 'Hooks', fn: checkHooks },
      { name: 'Skills', fn: checkSkills },
      { name: 'Gateway', fn: checkGateway },
      { name: 'Docker (Sandbox)', fn: checkDocker },
      { name: 'Cron Scheduler', fn: checkCron },
      { name: 'Browser Service', fn: checkBrowser },
      { name: 'Disk Access', fn: checkDisk },
    ];
  }

  async runAll() {
    const checks = this.getChecks();
    const results = [];

    for (const check of checks) {
      try {
        const result = await check.fn(this.context);
        results.push({ name: check.name, ...result });
      } catch (err) {
        results.push({
          name: check.name,
          status: 'FAIL',
          message: `Check threw an error: ${err.message}`,
        });
      }
    }

    return results;
  }

  formatResults(results) {
    const lines = ['King Louie Diagnostics', '======================'];

    for (const result of results) {
      const icon = STATUS_ICONS[result.status] || '?';
      lines.push(`[${result.status}] ${result.name} \u2014 ${result.message}`);
      if (result.fix) {
        lines.push(`      Fixit: ${result.fix}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = Fixit;
