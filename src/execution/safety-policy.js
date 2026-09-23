const { toolRegistry } = require('../tools');
const { isPathUnderRoots } = require('../platform/path-roots');

// Tools that only observe state. classifyToolCall gives any other tool that
// passes its checks the `routine` tier.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'status', 'get_state', 'list_machines', 'describe_machine', 'get_job', 'get_job_logs']);

// Shell control operators that start a new command. `||` and `&&` come before
// `|` and `&` so the two-character forms are consumed whole. A lone `&` is
// included too: `echo hi & rm -rf /` runs both commands just as `;` would.
const SHELL_SEPARATORS = /\|\||&&|[;|&\r\n]/;

// `$(...)`, backticks and process substitution (`<(...)`, `>(...)`) run a
// command whose text only exists at run time, so no pattern list can say what
// they will do.
const COMMAND_SUBSTITUTION = /\$\(|`|[<>]\(/;

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

/**
 * Checks if a formatted tool call matches any pattern in a list.
 *
 * A shell command is tested whole and also one segment at a time, so
 * `Bash(git push*)` catches `cd repo && git push origin` as well as a bare
 * `git push`.
 */
function matchesPatternList(toolName, parameters, patternList = []) {
  if (!Array.isArray(patternList) || patternList.length === 0) return false;
  const formattedCall = formatToolPattern(toolName, parameters);

  // Bare command texts to try: the whole command plus each segment.
  const commands = [];
  if (parameters?.command) {
    const command = String(parameters.command);
    commands.push(command, ...splitShellSegments(command));
  }

  for (const pattern of patternList) {
    if (!pattern) continue;
    // Direct match against formatted call: "Bash(ssh *)" vs "Bash(ssh host)"
    if (patternMatch(pattern, formattedCall)) return true;
    // Direct match against tool name: "Vault(*)" or "Vault"
    if (patternMatch(pattern, toolName)) return true;
    for (const command of commands) {
      // Formatted per segment: "Bash(git push*)" vs "Bash(git push origin)"
      if (patternMatch(pattern, `${toolName}(${command})`)) return true;
      // Direct match against command/argument alone
      if (patternMatch(pattern, command)) return true;
    }
  }
  return false;
}

/**
 * Extracts potential file paths from tool parameters.
 */
function extractPathsFromParameters(toolName, parameters = {}) {
  const paths = [];
  if (!parameters || typeof parameters !== 'object') return paths;

  if (parameters.filePath) paths.push(parameters.filePath);
  if (parameters.path) paths.push(parameters.path);
  if (parameters.cwd) paths.push(parameters.cwd);
  if (parameters.workingDirectory) paths.push(parameters.workingDirectory);
  if (parameters.destination) paths.push(parameters.destination);
  if (parameters.dest) paths.push(parameters.dest);
  if (Array.isArray(parameters.sources)) {
    for (const s of parameters.sources) if (typeof s === 'string') paths.push(s);
  }
  return paths;
}

/**
 * Classifies a tool call from a remote-originated session into a safety tier
 * (spec §5.3).
 * Returns { tier: 'read' | 'routine' | 'unsafe' | 'denied', reason?: string }
 *
 * The `deny` and `always_confirm` pattern lists are a backstop, not a sandbox.
 * A command can be phrased many ways (`rm -fr /`, `rm -r -f /`, a script that
 * does the same), and no finite list of patterns catches them all. That is why
 * §5.3 also sends to `unsafe` anything the tool pipeline would ask about and
 * anything that touches a path outside `allowed_roots`; those checks, not the
 * pattern lists, are what keep a remote session contained.
 */
function classifyToolCall(toolName, parameters = {}, policy = {}) {
  const allowedRoots = policy.allowed_roots || [];
  const remoteSessions = policy.remote_sessions || {};
  const alwaysConfirmPatterns = remoteSessions.always_confirm || [];
  const denyPatterns = remoteSessions.deny || [];

  // 1. Check deny patterns
  if (matchesPatternList(toolName, parameters, denyPatterns)) {
    return { tier: 'denied', reason: 'matched_deny_policy' };
  }

  // A deny match above still wins; otherwise a command we can't read in full
  // has to go to a person.
  if (parameters?.command && COMMAND_SUBSTITUTION.test(String(parameters.command))) {
    return { tier: 'unsafe', reason: 'command_substitution' };
  }

  // 2. Check path containment against allowed_roots
  const paths = extractPathsFromParameters(toolName, parameters);
  for (const p of paths) {
    if (!isPathUnderRoots(p, allowedRoots)) {
      return { tier: 'unsafe', reason: 'path_outside_allowed_roots' };
    }
  }

  // 3. Check always_confirm patterns
  if (matchesPatternList(toolName, parameters, alwaysConfirmPatterns)) {
    return { tier: 'unsafe', reason: 'matched_always_confirm' };
  }

  // 4. Check tool registry requiresApproval or dangerous flags
  const tool = toolRegistry.get(toolName);
  if (tool) {
    if (typeof tool.isDangerous === 'function' && tool.isDangerous(parameters)) {
      return { tier: 'unsafe', reason: 'dangerous_operation' };
    }
    if (tool.requiresApproval) {
      return { tier: 'unsafe', reason: 'tool_requires_approval' };
    }
  }

  // 5. Default tier: read for non-mutating / status tools, routine for others
  if (READ_TOOLS.has(toolName)) {
    return { tier: 'read', reason: 'read_only_tool' };
  }

  return { tier: 'routine', reason: 'routine_tool' };
}

/**
 * Helper to determine if a remote-originated tool execution must override auto-approve.
 */
function isRemoteToolExecutionUnsafe(toolName, parameters, policy) {
  const classification = classifyToolCall(toolName, parameters, policy);
  return classification.tier === 'unsafe' || classification.tier === 'denied';
}

module.exports = {
  patternMatch,
  formatToolPattern,
  matchesPatternList,
  isPathUnderRoots,
  classifyToolCall,
  isRemoteToolExecutionUnsafe
};
