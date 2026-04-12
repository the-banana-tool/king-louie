const { exec } = require('child_process');
const { promisify } = require('util');
const { Tool } = require('../tool-schema');
const { sanitizeCommandName } = require('../../execution/runtime-environment');
const SandboxExecutor = require('../../execution/sandbox-executor');

const execAsync = promisify(exec);
const sandboxExecutor = new SandboxExecutor();

const WINDOWS_BUILTINS = new Set([
  'cd',
  'dir',
  'echo',
  'set',
  'cls',
  'copy',
  'move',
  'type',
  'del',
  'if',
  'for'
]);

const POSIX_BUILTINS = new Set([
  'cd',
  'echo',
  'pwd',
  'export',
  'alias',
  'set',
  'test'
]);

function extractCommandNames(command = '') {
  return String(command || '')
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const cleaned = segment.replace(/^\([^)]*\)\s*/, '').trim();
      const firstToken = cleaned.split(/\s+/)[0] || '';
      return sanitizeCommandName(firstToken);
    })
    .filter(Boolean);
}

function validateCommandAvailability(command, runtimeEnvironment = {}) {
  const platform = runtimeEnvironment.platform || process.platform;
  const availableCommands = runtimeEnvironment.availableCommands || {};
  const builtins = platform === 'win32' ? WINDOWS_BUILTINS : POSIX_BUILTINS;
  const commandNames = extractCommandNames(command);

  for (const name of commandNames) {
    if (builtins.has(name)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(availableCommands, name) && !availableCommands[name]) {
      const shell = runtimeEnvironment.shell || (platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      return {
        ok: false,
        error: [
          `Command '${name}' is not available on this system.`,
          `Platform: ${platform}`,
          `Shell: ${shell}`,
          `Use a command supported by this environment or install '${name}' first.`
        ].join(' ')
      };
    }
  }

  return { ok: true };
}

const BashTool = new Tool({
  name: 'Bash',
  description: 'Execute shell commands for local development tasks.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this command does'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000)',
        minimum: 1,
        maximum: 600000
      }
    },
    required: ['command']
  },
  requiresApproval: true,
  dangerousPatterns: [
    /rm\s+-rf\s+\//i,
    /mkfs\./i,
    /dd\s+if=/i,
    /:(){\s*:|:&};:/,
    /del\s+\/s\s+\/q/i,
    /rmdir\s+\/s\s+\/q/i,
    /format\s+[a-z]:/i
  ],

  async execute(params, options = {}) {
    const { command, timeout = 120000 } = params;
    const runtimeEnvironment = options.runtimeEnvironment || {};

    const useSandbox = options.useSandbox !== false;
    const isDockerAvailable = await sandboxExecutor.isDockerAvailable();
    const willUseSandbox = useSandbox && isDockerAvailable;

    // Always validate command availability first, even if using sandbox.
    // If sandbox is used, assume POSIX builtins (linux environment)
    const validationEnvironment = willUseSandbox ? { platform: 'linux', shell: 'sh' } : runtimeEnvironment;
    const validation = validateCommandAvailability(command, validationEnvironment);
    if (!validation.ok) {
      return {
        success: false,
        stdout: '',
        stderr: validation.error,
        exitCode: 127,
        environment: validationEnvironment
      };
    }

    const execOptions = {
      timeout,
      workingDirectory: options.workingDirectory,
      sessionId: options.sessionId,
      useSandbox,
      signal: options.signal || null,
      // Streaming progress: when an onProgress callback is available,
      // SandboxExecutor uses spawn instead of exec so stdout lines are
      // emitted as they arrive instead of buffered until completion.
      onProgress: typeof options.onProgress === 'function' ? options.onProgress : null
    };

    return await sandboxExecutor.execute(command, execOptions);
  }
});

BashTool.sandboxExecutor = sandboxExecutor;

module.exports = BashTool;
