const { Skill } = require('../../src/skills/skill-interface');
const { spawn, execSync } = require('child_process');
const path = require('path');

/**
 * Claude Code Skill
 *
 * Manages Claude Code CLI sessions from within King Louie.
 * Spawns `claude` as a subprocess and streams output back to the chat.
 *
 * Commands:
 *   /cc <prompt>              - Run a one-shot prompt
 *   /cc continue [prompt]     - Continue the most recent session
 *   /cc resume [search]       - Resume a session by ID or search term
 *   /cc worktree <prompt>     - Run in an isolated git worktree
 *   /cc sessions              - List recent Claude Code sessions
 *   /cc stop                  - Kill the running Claude Code process
 *   /cc status                - Check CLI availability and version
 */
class ClaudeCodeSkill extends Skill {
  constructor() {
    super();
    this.context = null;
    this.runningProcesses = new Map(); // chatId -> { proc, abortController }
  }

  getMetadata() {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      version: '1.0.0',
      description: 'Run and manage Claude Code CLI sessions from King Louie',
      author: 'King Louie Team',
      commands: ['cc'],
      resolvers: ['code', 'skill'],
      pinnable: true
    };
  }

  async initialize(context) {
    this.context = context;
    this.claudePath = this._findClaude();
    console.log(`[claude-code] Initialized. Claude CLI: ${this.claudePath || 'NOT FOUND'}`);
  }

  // ── Resolver ────────────────────────────────────────────────

  async resolveCode({ command, args = [], context }) {
    if (command !== 'cc') return null;

    const subcommand = args[0] || '';
    const rest = args.slice(1);

    switch (subcommand) {
      case 'status':
        return this._status();

      case 'stop':
        return this._stop(context.chatId);

      case 'sessions':
        return this._listSessions();

      case 'resume':
        return this._runClaude(context.chatId, {
          mode: 'resume',
          search: rest.join(' ') || undefined,
          prompt: undefined
        });

      case 'continue':
        return this._runClaude(context.chatId, {
          mode: 'continue',
          prompt: rest.length ? rest.join(' ') : undefined
        });

      case 'worktree':
        if (!rest.length) {
          return { ok: false, error: 'Usage: /cc worktree <prompt>' };
        }
        return this._runClaude(context.chatId, {
          mode: 'worktree',
          prompt: rest.join(' ')
        });

      case 'help':
      case '':
        return { ok: true, message: await this.getHelp(), format: 'markdown' };

      default:
        // Everything else is a prompt: /cc <prompt>
        return this._runClaude(context.chatId, {
          mode: 'print',
          prompt: [subcommand, ...rest].join(' ')
        });
    }
  }

  // ── Pinned mode: forward free-form messages to Claude Code ──

  async handleMessage(text, context) {
    if (!text.trim()) return null;

    // When pinned, all messages go straight to Claude Code as prompts
    return this._runClaude(context.chatId, {
      mode: 'print',
      prompt: text
    });
  }

  // ── Core execution ──────────────────────────────────────────

  async _runClaude(chatId, { mode, prompt, search }) {
    if (!this.claudePath) {
      return {
        ok: false,
        error: 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
      };
    }

    // Kill any existing process for this chat
    this._killProcess(chatId);

    const args = this._buildArgs(mode, prompt, search);

    return new Promise((resolve) => {
      const proc = spawn(this.claudePath, args, {
        cwd: this.context.workingDirectory,
        env: { ...process.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      this.runningProcesses.set(chatId, { proc, startedAt: Date.now() });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const processStartedAt = Date.now();

      proc.on('close', (code) => {
        this.runningProcesses.delete(chatId);
        const elapsed = ((Date.now() - processStartedAt) / 1000).toFixed(1);

        if (code === null) {
          resolve({ ok: true, message: '_Claude Code process stopped._', format: 'markdown' });
          return;
        }

        if (stdout.trim()) {
          const result = this._parseOutput(stdout, args.includes('json'));
          resolve(result);
          return;
        }

        if (stderr.trim()) {
          resolve({ ok: false, error: stderr.trim() });
          return;
        }

        resolve({
          ok: code === 0,
          message: code === 0 ? '_Claude Code completed with no output._' : `_Claude Code exited with code ${code}._`,
          format: 'markdown'
        });
      });

      proc.on('error', (err) => {
        this.runningProcesses.delete(chatId);
        resolve({ ok: false, error: `Failed to start Claude Code: ${err.message}` });
      });
    });
  }

  _buildArgs(mode, prompt, search) {
    // Use --output-format json for rich metadata, plain text as fallback
    const base = ['--print', '--output-format', 'json'];

    switch (mode) {
      case 'print':
        return [...base, prompt];

      case 'continue':
        if (prompt) return [...base, '--continue', prompt];
        return [...base, '--continue', 'continue from where we left off'];

      case 'resume': {
        const args = [...base, '--resume'];
        if (search) args.push(search);
        if (prompt) args.push(prompt);
        return args;
      }

      case 'worktree':
        return [...base, '--worktree', prompt];

      default:
        return [...base, prompt];
    }
  }

  _parseOutput(raw, isJson) {
    if (!isJson) {
      return { ok: true, message: raw.trim(), format: 'markdown' };
    }

    try {
      const data = JSON.parse(raw);

      if (data.is_error) {
        return { ok: false, error: data.result || 'Claude Code returned an error' };
      }

      const text = data.result || '';
      const meta = [];

      if (data.session_id) meta.push(`Session: \`${data.session_id.slice(0, 8)}...\``);
      if (data.num_turns) meta.push(`Turns: ${data.num_turns}`);
      if (data.duration_ms) meta.push(`Duration: ${(data.duration_ms / 1000).toFixed(1)}s`);
      if (data.total_cost_usd != null) meta.push(`Cost: $${data.total_cost_usd.toFixed(4)}`);

      const footer = meta.length
        ? `\n\n---\n_${meta.join(' | ')}_`
        : '';

      return {
        ok: true,
        message: text + footer,
        format: 'markdown',
        data: {
          sessionId: data.session_id,
          cost: data.total_cost_usd,
          duration: data.duration_ms,
          turns: data.num_turns,
          model: data.modelUsage ? Object.keys(data.modelUsage)[0] : undefined
        }
      };
    } catch {
      // JSON parse failed, treat as plain text
      return { ok: true, message: raw.trim(), format: 'markdown' };
    }
  }

  // ── Subcommands ─────────────────────────────────────────────

  _status() {
    if (!this.claudePath) {
      return {
        ok: false,
        error: 'Claude CLI not found in PATH.\nInstall: npm install -g @anthropic-ai/claude-code'
      };
    }

    let version = 'unknown';
    try {
      version = execSync(`"${this.claudePath}" --version`, {
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
    } catch { /* ignore */ }

    const running = this.runningProcesses.size;

    return {
      ok: true,
      message: [
        '**Claude Code Status**',
        '',
        `- **CLI Path:** \`${this.claudePath}\``,
        `- **Version:** ${version}`,
        `- **Running sessions:** ${running}`,
        `- **Working directory:** \`${this.context.workingDirectory}\``
      ].join('\n'),
      format: 'markdown'
    };
  }

  _stop(chatId) {
    const entry = this.runningProcesses.get(chatId);
    if (!entry) {
      return { ok: true, message: '_No Claude Code process running in this chat._', format: 'markdown' };
    }

    this._killProcess(chatId);
    return { ok: true, message: '_Claude Code process stopped._', format: 'markdown' };
  }

  async _listSessions() {
    if (!this.claudePath) {
      return { ok: false, error: 'Claude CLI not found.' };
    }

    try {
      // claude --resume with --print shows available sessions
      // We use `claude -r "" -p "list"` but that starts a session.
      // Instead, use the sessions directory directly.
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const fs = require('fs');
      const sessionsDir = path.join(homeDir, '.claude', 'projects');

      if (!fs.existsSync(sessionsDir)) {
        return { ok: true, message: '_No Claude Code sessions found._', format: 'markdown' };
      }

      // Find recent session files across project directories
      const sessions = [];
      const projects = fs.readdirSync(sessionsDir);

      for (const project of projects.slice(0, 20)) {
        const projectDir = path.join(sessionsDir, project);
        const stat = fs.statSync(projectDir);
        if (!stat.isDirectory()) continue;

        // Look for session .json files
        try {
          const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .slice(0, 10);

          for (const file of files) {
            const filePath = path.join(projectDir, file);
            const fileStat = fs.statSync(filePath);
            sessions.push({
              project: decodeURIComponent(project),
              sessionId: file.replace('.jsonl', ''),
              modifiedAt: fileStat.mtimeMs,
              size: fileStat.size
            });
          }
        } catch { /* skip unreadable dirs */ }
      }

      // Sort by most recent
      sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const recent = sessions.slice(0, 15);

      if (!recent.length) {
        return { ok: true, message: '_No Claude Code sessions found._', format: 'markdown' };
      }

      const lines = ['**Recent Claude Code Sessions**', ''];
      for (const s of recent) {
        const ago = this._timeAgo(s.modifiedAt);
        const sizeKb = Math.round(s.size / 1024);
        lines.push(`- \`${s.sessionId.slice(0, 8)}...\` | ${s.project} | ${ago} | ${sizeKb}KB`);
      }

      return { ok: true, message: lines.join('\n'), format: 'markdown' };
    } catch (err) {
      return { ok: false, error: `Failed to list sessions: ${err.message}` };
    }
  }

  // ── Fallback handler ────────────────────────────────────────

  async handleCommand(command, args, context) {
    return this.resolveCode({ command, args, context });
  }

  // ── Help ────────────────────────────────────────────────────

  async getHelp() {
    return [
      '## Claude Code Skill',
      '',
      'Run and manage Claude Code CLI sessions from King Louie.',
      '',
      '### Commands',
      '',
      '| Command | Description |',
      '|---------|-------------|',
      '| `/cc <prompt>` | Run a one-shot prompt through Claude Code |',
      '| `/cc continue [prompt]` | Continue the most recent session in this directory |',
      '| `/cc resume [search]` | Resume a session by search term |',
      '| `/cc worktree <prompt>` | Run in an isolated git worktree |',
      '| `/cc sessions` | List recent Claude Code sessions |',
      '| `/cc stop` | Kill the running Claude Code process |',
      '| `/cc status` | Check CLI availability and version |',
      '',
      '### Pinned Mode',
      '',
      'When pinned to a chat (`/pin claude-code`), all messages are sent',
      'directly to Claude Code as prompts without the `/cc` prefix.',
      '',
      '### Examples',
      '',
      '```',
      '/cc explain the auth middleware in src/auth.js',
      '/cc continue add error handling to the login endpoint',
      '/cc worktree refactor the database layer to use connection pooling',
      '/cc sessions',
      '```'
    ].join('\n');
  }

  // ── Utilities ───────────────────────────────────────────────

  _findClaude() {
    try {
      const result = execSync('which claude 2>/dev/null || where claude 2>NUL', {
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      // Take the first path if multiple found
      return result.split('\n')[0].trim();
    } catch {
      return null;
    }
  }

  _killProcess(chatId) {
    const entry = this.runningProcesses.get(chatId);
    if (entry && entry.proc) {
      try {
        // On Windows, need to kill the process tree
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${entry.proc.pid} /T /F 2>NUL`, { encoding: 'utf-8' });
        } else {
          entry.proc.kill('SIGTERM');
        }
      } catch { /* already dead */ }
      this.runningProcesses.delete(chatId);
    }
  }

  _timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async cleanup() {
    // Kill all running processes
    for (const [chatId] of this.runningProcesses) {
      this._killProcess(chatId);
    }
    console.log('[claude-code] Skill cleaned up.');
  }
}

module.exports = ClaudeCodeSkill;
