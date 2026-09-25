const { toolRegistry } = require('../tools');
const { isPathUnderRoots } = require('../platform/path-roots');
const path = require('path');
const {
  SHELL_SEPARATORS,
  normalizeWhitespace,
  splitShellSegments,
  patternMatch,
  formatToolPattern
} = require('./tool-patterns');

// Tools that only observe state. classifyToolCall gives any other tool that
// passes its checks the `routine` tier.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'status', 'get_state', 'list_machines', 'describe_machine', 'get_job', 'get_job_logs']);

// `$(...)`, backticks and process substitution (`<(...)`, `>(...)`) run a
// command whose text only exists at run time, so no pattern list can say what
// they will do.
const COMMAND_SUBSTITUTION = /\$\(|`|[<>]\(/;

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
function extractPathsFromParameters(toolName, parameters = {}, cwd = null) {
  const paths = [];
  if (!parameters || typeof parameters !== 'object') return paths;

  if (parameters.filePath) paths.push(parameters.filePath);
  // Read, Write, Edit and MultiEdit name their target `file_path` (MultiEdit:
  // per edit). Without these a remote Read or Edit outside allowed_roots was
  // classified read/routine.
  if (typeof parameters.file_path === 'string') paths.push(parameters.file_path);
  if (Array.isArray(parameters.edits)) {
    for (const e of parameters.edits) if (e && typeof e.file_path === 'string') paths.push(e.file_path);
  }
  if (parameters.path) paths.push(parameters.path);
  if (parameters.cwd) paths.push(parameters.cwd);
  if (parameters.workingDirectory) paths.push(parameters.workingDirectory);
  if (parameters.destination) paths.push(parameters.destination);
  if (parameters.dest) paths.push(parameters.dest);
  if (Array.isArray(parameters.sources)) {
    for (const s of parameters.sources) if (typeof s === 'string') paths.push(s);
  }
  // A relative path means "relative to where the tool runs", not to wherever
  // this process happens to be.
  if (!cwd) return paths;
  return paths.map((p) => (typeof p === 'string' && p && !path.isAbsolute(p) ? path.resolve(cwd, p) : p));
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
function classifyToolCall(toolName, parameters = {}, policy = {}, { cwd = null } = {}) {
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
  const paths = extractPathsFromParameters(toolName, parameters, cwd);
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
  normalizeWhitespace,
  splitShellSegments,
  SHELL_SEPARATORS,
  extractPathsFromParameters,
  matchesPatternList,
  isPathUnderRoots,
  classifyToolCall,
  isRemoteToolExecutionUnsafe
};
