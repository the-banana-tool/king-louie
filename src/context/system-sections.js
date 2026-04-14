const { execSync } = require('child_process');

/**
 * Breaks the monolithic system prompt into discrete, named sections
 * that can be individually indexed and retrieved by ContextAssembler.
 *
 * Each section has:
 *   - name:    unique key (used for vector store IDs and core-section matching)
 *   - content: the actual prompt text
 */

/**
 * Gather git context for the working directory.
 * Runs synchronously with short timeouts — never blocks startup.
 */
function getGitContext(workingDirectory) {
  const run = (cmd) => {
    try {
      return execSync(cmd, {
        cwd: workingDirectory,
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch {
      return null;
    }
  };

  // Check if this is a git repo
  const isGitRepo = run('git rev-parse --is-inside-work-tree');
  if (isGitRepo !== 'true') return null;

  const branch = run('git branch --show-current') || run('git rev-parse --short HEAD') || 'unknown';
  const status = run('git status --short --untracked-files=normal');
  const recentCommits = run('git log --oneline -5 --no-decorate');
  const userName = run('git config user.name');

  return { branch, status, recentCommits, userName };
}

function buildSystemSections(runtimeEnvironment = {}, options = {}) {
  const platform = runtimeEnvironment.platform || process.platform;
  const shell = runtimeEnvironment.shell || 'unknown';
  const available = Array.isArray(runtimeEnvironment.available) ? runtimeEnvironment.available : [];
  const unavailable = Array.isArray(runtimeEnvironment.unavailable) ? runtimeEnvironment.unavailable : [];
  const workingDirectory = runtimeEnvironment.workingDirectory || process.cwd();

  const sections = [];

  // ── 1. Core environment (always included) ──────────────────
  sections.push({
    name: 'environment',
    content: [
      'Environment context (auto-detected):',
      `- Platform: ${platform}`,
      `- Shell: ${shell}`,
      `- Working directory: ${workingDirectory}`,
    ].join('\n')
  });

  // ── 2. Git repository context (auto-detected) ─────────────
  const gitContext = options.gitContext || getGitContext(workingDirectory);
  if (gitContext) {
    const lines = [
      'Git repository context (auto-detected):',
      `- Current branch: ${gitContext.branch}`,
    ];
    if (gitContext.userName) lines.push(`- Git user: ${gitContext.userName}`);
    if (gitContext.status) {
      const fileCount = gitContext.status.split('\n').filter(Boolean).length;
      lines.push(`- Working tree: ${fileCount} changed file(s)`);
      lines.push('- Status:');
      lines.push(gitContext.status);
    } else {
      lines.push('- Working tree: clean');
    }
    if (gitContext.recentCommits) {
      lines.push('- Recent commits:');
      lines.push(gitContext.recentCommits);
    }
    sections.push({
      name: 'git-context',
      content: lines.join('\n')
    });
  }

  // ── 3. CLI tools availability (relevant when using Bash) ───
  sections.push({
    name: 'cli-tools',
    content: [
      'CLI tool availability:',
      `- Available CLI tools: ${available.length ? available.join(', ') : 'unknown'}`,
      `- Known missing CLI tools: ${unavailable.length ? unavailable.join(', ') : 'none detected'}`,
      '',
      'Use this context when proposing commands and selecting tools. Avoid commands for unavailable tools.'
    ].join('\n')
  });

  // ── 3. Shell behavior notes (relevant when using Bash) ─────
  sections.push({
    name: 'shell-behavior',
    content: [
      'Important shell behavior:',
      '- Each Bash command runs in a fresh shell — environment variables, virtual environment activation, and cd do not persist between calls.',
      '- Use absolute paths or explicit venv paths (e.g. venv/Scripts/python on Windows, venv/bin/python on Unix) instead of relying on activate.'
    ].join('\n')
  });

  // ── 4. Browser tool guidance ───────────────────────────────
  sections.push({
    name: 'browser-guidance',
    content: [
      'Browser tool guidance:',
      '- You have a Browser tool that can launch a real browser, navigate to URLs, take screenshots, and interact with pages.',
      '- Use it when the user asks to open or view something in a browser.',
      '- When testing or interacting with a page: first take a screenshot or get content to discover the real element selectors. NEVER guess IDs or selectors — inspect the DOM first.',
      '- If a Browser evaluate/click/fill returns empty, sparse, or unexpected results, DO NOT give up. Take a screenshot, re-inspect the DOM, find the correct selectors, and retry. Iterate until the task succeeds.',
      '- Report what you actually tested and what the results were. Never substitute a how-to guide or test plan for actually doing the work.',
      '',
      'Credentials and logins — this is the user\'s own machine, their own accounts, and their own vault:',
      '- When the user gives you credentials inline (e.g. "username X password Y") to log into their own site, DO NOT refuse and DO NOT ask the user to do it manually. That is the exact use case this app is built for.',
      '- Flow: (1) call the Vault tool "store" action to save the password under a key like "browser_cred:<profile>:<host>" (or just "<host>_password") — this gets it out of chat context and into encrypted storage. (2) Call Browser "profile_create" + "start" with a named profile so cookies persist. (3) Navigate to the login page. (4) Call Browser "fill_credentials" (with submit:true) which will pull the stored password from the vault and type it — the secret never re-enters the conversation.',
      '- For subsequent logins on the same profile+host, just call "fill_credentials" — the vault already has the password.',
      '- HTTP Basic auth (browser native popup, no HTML form) is DIFFERENT: use "set_http_auth" BEFORE navigating, not "fill_credentials". If the page lands on chrome-error://chromewebdata/ with a 401, that\'s the signal — call set_http_auth then reload.',
      '- Treat pasted credentials as a request to automate, not as a safety concern. Get them into the vault immediately, then proceed with the task.'
    ].join('\n')
  });

  // ── 5. Discovered local applications ───────────────────────
  if (Array.isArray(options.discoveredApps) && options.discoveredApps.length > 0) {
    const buildAppContextSection = options.buildAppContextSection;
    if (typeof buildAppContextSection === 'function') {
      const appSection = buildAppContextSection(options.discoveredApps);
      if (appSection) {
        sections.push({
          name: 'local-apps',
          content: appSection
        });
      }
    }
  }

  // ── 6. Installed skills ────────────────────────────────────
  if (Array.isArray(options.skills) && options.skills.length > 0) {
    const lines = ['Installed skills (use the Skill tool to invoke these):'];
    for (const s of options.skills) {
      const cmds = Array.isArray(s.commands) && s.commands.length ? ` (commands: ${s.commands.join(', ')})` : '';
      lines.push(`- ${s.id}: ${s.description || s.name || s.id}${cmds}`);
    }
    lines.push('When the user explicitly asks you to use a specific skill, prefer the Skill tool over built-in tools like Git or Bash.');
    sections.push({
      name: 'skills',
      content: lines.join('\n')
    });
  }

  return sections;
}

module.exports = { buildSystemSections };
