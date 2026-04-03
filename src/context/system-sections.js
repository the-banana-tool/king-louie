/**
 * Breaks the monolithic system prompt into discrete, named sections
 * that can be individually indexed and retrieved by ContextAssembler.
 *
 * Each section has:
 *   - name:    unique key (used for vector store IDs and core-section matching)
 *   - content: the actual prompt text
 */

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

  // ── 2. CLI tools availability (relevant when using Bash) ───
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
      '- Use it when the user asks to open or view something in a browser.'
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
