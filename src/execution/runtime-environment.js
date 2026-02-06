const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const DEFAULT_COMMANDS = [
  'git',
  'node',
  'npm',
  'python',
  'pip',
  'docker',
  'kubectl',
  'aws',
  'terraform',
  'gh',
  'grep',
  'sed',
  'awk',
  'bash',
  'pwsh',
  'powershell',
  'cmd'
];

const cache = new Map();

function sanitizeCommandName(name = '') {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '');
}

async function isCommandAvailable(commandName) {
  const normalized = sanitizeCommandName(commandName);
  if (!normalized) return false;

  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  const lookup = process.platform === 'win32'
    ? `where ${normalized}`
    : `command -v ${normalized}`;

  try {
    await execAsync(lookup, {
      windowsHide: true,
      timeout: 10000,
      shell: true
    });
    cache.set(normalized, true);
    return true;
  } catch {
    cache.set(normalized, false);
    return false;
  }
}

async function detectCommands(commands = DEFAULT_COMMANDS) {
  const unique = Array.from(new Set((commands || []).map(sanitizeCommandName).filter(Boolean)));
  const checks = await Promise.all(unique.map(async (name) => [name, await isCommandAvailable(name)]));
  return Object.fromEntries(checks);
}

function summarizeAvailability(availableCommands = {}) {
  const entries = Object.entries(availableCommands);
  const available = entries.filter(([, ok]) => ok).map(([name]) => name);
  const unavailable = entries.filter(([, ok]) => !ok).map(([name]) => name);
  return { available, unavailable };
}

let runtimeEnvironmentPromise = null;

async function getRuntimeEnvironment(options = {}) {
  if (runtimeEnvironmentPromise) {
    return runtimeEnvironmentPromise;
  }

  runtimeEnvironmentPromise = (async () => {
    const availableCommands = await detectCommands(options.commands || DEFAULT_COMMANDS);
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/sh');

    return {
      platform: process.platform,
      osRelease: process.release?.name || 'node',
      shell,
      workingDirectory: options.workingDirectory || process.cwd(),
      availableCommands,
      ...summarizeAvailability(availableCommands),
      detectedAt: new Date().toISOString()
    };
  })();

  return runtimeEnvironmentPromise;
}

module.exports = {
  DEFAULT_COMMANDS,
  getRuntimeEnvironment,
  isCommandAvailable,
  sanitizeCommandName
};
