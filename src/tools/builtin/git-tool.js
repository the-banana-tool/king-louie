const { Tool } = require('../tool-schema');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = [
  'status', 'log', 'diff', 'branch', 'show', 'blame', 'stash',
  'add', 'commit', 'checkout', 'merge', 'pull', 'push', 'fetch',
  'tag', 'remote', 'rev-parse', 'ls-files', 'init', 'clone'
];

// Block destructive flags that could cause data loss
const BLOCKED_ARGS = ['--force', '-f', '--hard', '--delete', '-D'];

// Block hook bypass flags — hooks exist for a reason
const BLOCKED_HOOK_BYPASS = ['--no-verify', '--no-gpg-sign', '-n'];

// Block interactive flags — not supported in non-interactive execution
const BLOCKED_INTERACTIVE = ['-i', '--interactive', '-p', '--patch'];

// Files that should never be committed (secrets, credentials)
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i, /\.env\.\w+$/i,
  /credentials\.json$/i, /secrets\.json$/i, /secret\.json$/i,
  /\.pem$/, /\.key$/, /id_rsa/, /id_ed25519/,
  /token\.json$/i, /auth\.json$/i,
  /\.netrc$/i, /\.npmrc$/i
];

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
        return { ok: false, error: `Argument "${arg}" is blocked for safety. Destructive git operations require explicit user approval via the Bash tool.` };
      }
    }

    // Block hook bypass flags
    for (const arg of args) {
      if (BLOCKED_HOOK_BYPASS.includes(arg)) {
        return { ok: false, error: `Argument "${arg}" is blocked. Git hooks must not be bypassed — if a hook fails, investigate and fix the underlying issue.` };
      }
    }

    // Block interactive flags (not supported in non-interactive execution)
    for (const arg of args) {
      if (BLOCKED_INTERACTIVE.includes(arg)) {
        return { ok: false, error: `Argument "${arg}" is blocked. Interactive git operations are not supported. Use non-interactive alternatives.` };
      }
    }

    // Prevent --amend — always create new commits to avoid destroying history
    if (command === 'commit' && args.some(a => a === '--amend')) {
      return {
        ok: false,
        error: 'git commit --amend is blocked. Always create new commits instead of amending. Amending can overwrite previous changes and lose work.'
      };
    }

    // Prevent force push to main/master
    if (command === 'push' && args.some(a => a === '--force' || a === '--force-with-lease' || a === '-f')) {
      return {
        ok: false,
        error: 'Force push is blocked for safety. If you need to force push, use the Bash tool with explicit user approval.'
      };
    }

    // Check for sensitive files in add/commit commands
    if (command === 'add') {
      // Block "git add -A" or "git add ." — prefer explicit file names
      if (args.includes('-A') || args.includes('--all') || args.includes('.')) {
        return {
          ok: false,
          error: 'git add -A/--all/. is blocked. Stage specific files by name to avoid accidentally including sensitive files (.env, credentials, keys).'
        };
      }

      // Check for sensitive file patterns in explicit adds
      for (const arg of args) {
        if (arg.startsWith('-')) continue;
        for (const pattern of SENSITIVE_FILE_PATTERNS) {
          if (pattern.test(arg)) {
            return {
              ok: false,
              error: `Refusing to stage "${arg}" — it matches a sensitive file pattern. This file likely contains secrets and should not be committed.`
            };
          }
        }
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
