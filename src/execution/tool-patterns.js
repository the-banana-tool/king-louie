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

/**
 * Formats a tool call into a string pattern for policy checking.
 * e.g., Bash(ssh user@server) or Vault(get_token)
 */
function formatToolPattern(toolName, parameters = {}) {
  let detail = '';
  if (typeof parameters === 'string') {
    detail = parameters;
  } else if (parameters && typeof parameters === 'object') {
    if (parameters.command) detail = String(parameters.command);
    else if (parameters.filePath) detail = String(parameters.filePath);
    else if (parameters.path) detail = String(parameters.path);
    else if (parameters.key) detail = String(parameters.key);
    else if (parameters.action) detail = String(parameters.action);
    else if (parameters.subcommand) detail = String(parameters.subcommand);
    else detail = JSON.stringify(parameters);
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
