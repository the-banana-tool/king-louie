// Pattern helpers shared by the safety policy, the approval messages and the
// runbook profile. Dependency-free on purpose: safety-policy.js requires the
// tool registry, which the runbook profile must never load
// (tests/service-profile-graph.test.js), and the approval summary needs
// formatToolPattern there too.

// Shell control operators that start a new command. `||` and `&&` come before
// `|` and `&` so the two-character forms are consumed whole. A lone `&` is
// included too: `echo hi & rm -rf /` runs both commands just as `;` would.
const SHELL_SEPARATORS = /\|\||&&|[;|&\r\n]/;

/**
 * Collapses every run of whitespace (spaces, tabs, newlines) to one space and
 * trims the ends, so `rm  -rf /` and `rm\t-rf /` compare equal to `rm -rf /`.
 */
function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Splits a shell command into the individual commands it would run, each
 * whitespace-normalised. Empty pieces (e.g. from a trailing `;`) are dropped.
 */
function splitShellSegments(command) {
  return String(command)
    .split(SHELL_SEPARATORS)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

/**
 * Checks if a wildcard pattern matches a target string.
 * Supports '*' (matches 0 or more chars) and '?' (matches 1 char); every other
 * regex metacharacter in the pattern is matched literally. Whitespace in both
 * pattern and target is normalised first so extra spaces can't dodge a match.
 */
function patternMatch(pattern, target) {
  pattern = normalizeWhitespace(pattern);
  target = normalizeWhitespace(target);
  if (pattern === '*' || pattern === target) return true;
  const regexStr = '^' + pattern
    .replace(/[-[\]{}()+.,\\^$|#\s]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';
  const regex = new RegExp(regexStr, 'i');
  return regex.test(target);
}

// The field that says what each tool acts on, from its own schema. A tool ignores keys
// it does not declare, so a field read for every tool could name something other than
// what runs (Write with a decoy command). This file loads no registry: the runbook
// profile must not, so the table is here.
const ACTION_TOOLS = ['Browser', 'BrowserPage', 'BrowserExtract', 'BrowserSession', 'Cron', 'RemoteDispatch', 'TaskStatus',
  'Canvas', 'Ledger', 'Brief', 'Reorient', 'Plan', 'Executor', 'Detour', 'Playbook', 'Progress', 'Ingest'];
const DETAIL_FIELDS = Object.freeze({
  Bash: 'command',
  PowerShell: 'command',
  Git: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Vault: 'key',
  SpawnAgent: 'task',
  ...Object.fromEntries(ACTION_TOOLS.map((name) => [name, 'action']))
});

/**
 * Formats a tool call into a string pattern for policy checking and a phone card.
 * e.g., Bash(ssh user@server) or Vault(get_token). A tool with no entry shows all its
 * parameters, so it never names one that does nothing.
 */
function formatToolPattern(toolName, parameters = {}) {
  let detail = '';
  if (typeof parameters === 'string') {
    detail = parameters;
  } else if (parameters && typeof parameters === 'object') {
    const field = Object.hasOwn(DETAIL_FIELDS, toolName) ? DETAIL_FIELDS[toolName] : null;
    detail = field && parameters[field] ? String(parameters[field]) : JSON.stringify(parameters);
  }
  return `${toolName}(${detail})`;
}

module.exports = {
  SHELL_SEPARATORS,
  normalizeWhitespace,
  splitShellSegments,
  patternMatch,
  formatToolPattern
};
