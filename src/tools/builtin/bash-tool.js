const { exec } = require('child_process');
const { promisify } = require('util');
const { Tool } = require('../tool-schema');
const { sanitizeCommandName } = require('../../execution/runtime-environment');

const execAsync = promisify(exec);

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

    const validation = validateCommandAvailability(command, runtimeEnvironment);
    if (!validation.ok) {
      return {
        success: false,
        stdout: '',
        stderr: validation.error,
        exitCode: 127,
        environment: {
          platform: runtimeEnvironment.platform || process.platform,
          shell: runtimeEnvironment.shell || null
        }
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: Math.min(timeout, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: options.workingDirectory || process.cwd(),
        shell: true
      });

      return {
        success: true,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        environment: {
          platform: runtimeEnvironment.platform || process.platform,
          shell: runtimeEnvironment.shell || null
        }
      };
    } catch (error) {
      return {
        success: false,
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || error.message || '').trim(),
        exitCode: typeof error.code === 'number' ? error.code : 1,
        environment: {
          platform: runtimeEnvironment.platform || process.platform,
          shell: runtimeEnvironment.shell || null
        }
      };
    }
  }
});

module.exports = BashTool;
