const { Tool } = require('../tool-schema');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = [
  'status', 'log', 'diff', 'branch', 'show', 'blame', 'stash',
  'add', 'commit', 'checkout', 'merge', 'pull', 'push', 'fetch',
  'tag', 'remote', 'rev-parse', 'ls-files', 'init', 'clone'
];

// Block destructive commands that could cause data loss
const BLOCKED_ARGS = ['--force', '-f', '--hard', '--delete', '-D'];

const gitTool = new Tool({
  name: 'Git',
  description: 'Execute git commands for version control operations',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Git subcommand (e.g., "status", "log", "diff")' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the git command' },
      cwd: { type: 'string', description: 'Working directory. Defaults to project root.' }
    },
    required: ['command']
  },
  requiresApproval: true,  // Git operations should require approval
  execute: async (params, context) => {
    const { command, args = [], cwd } = params;

    if (!ALLOWED_COMMANDS.includes(command)) {
      return { ok: false, error: `Git command "${command}" is not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}` };
    }

    // Check for blocked destructive args
    for (const arg of args) {
      if (BLOCKED_ARGS.includes(arg)) {
        return { ok: false, error: `Argument "${arg}" is blocked for safety. Use the Bash tool for destructive operations.` };
      }
    }

    const workDir = cwd || context?.workingDirectory || process.cwd();
    try {
      const { stdout, stderr } = await execFileAsync('git', [command, ...args], {
        cwd: workDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024  // 1MB
      });
      return { ok: true, output: stdout, stderr: stderr || undefined };
    } catch (err) {
      return { ok: false, error: err.message, stderr: err.stderr };
    }
  }
});

module.exports = gitTool;
