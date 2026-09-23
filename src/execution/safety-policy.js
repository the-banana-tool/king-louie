const path = require('path');
const { toolRegistry } = require('../tools');

/**
 * Checks if a wildcard pattern matches a target string.
 * Supports '*' (matches 0 or more chars) and '?' (matches 1 char).
 */
function patternMatch(pattern, target) {
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
 */
function matchesPatternList(toolName, parameters, patternList = []) {
  if (!Array.isArray(patternList) || patternList.length === 0) return false;
  const formattedCall = formatToolPattern(toolName, parameters);

  for (const pattern of patternList) {
    if (!pattern) continue;
    // Direct match against formatted call: "Bash(ssh *)" vs "Bash(ssh host)"
    if (patternMatch(pattern, formattedCall)) return true;
    // Direct match against tool name: "Vault(*)" or "Vault"
    if (patternMatch(pattern, toolName)) return true;
    // Direct match against command/argument alone
    if (parameters?.command && patternMatch(pattern, String(parameters.command))) return true;
  }
  return false;
}

/**
 * Normalizes and checks if targetPath resides under one of allowedRoots.
 */
function isPathUnderRoots(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;

  const resolvedTarget = path.resolve(targetPath);
  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return true;
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
 * Classifies a tool call into a safety tier for a node.
 * Returns { tier: 'read' | 'routine' | 'unsafe' | 'denied', reason?: string }
 */
function classifyToolCall(toolName, parameters = {}, policy = {}, options = {}) {
  const allowedRoots = policy.allowed_roots || [];
  const remoteSessions = policy.remote_sessions || {};
  const alwaysConfirmPatterns = remoteSessions.always_confirm || [];
  const denyPatterns = remoteSessions.deny || [];

  // 1. Check deny patterns
  if (matchesPatternList(toolName, parameters, denyPatterns)) {
    return { tier: 'denied', reason: 'matched_deny_policy' };
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
  const readTools = new Set(['Read', 'Glob', 'Grep', 'status', 'get_state', 'list_machines', 'describe_machine', 'get_job', 'get_job_logs']);
  if (readTools.has(toolName)) {
    return { tier: 'read', reason: 'read_only_tool' };
  }

  return { tier: 'routine', reason: 'routine_tool' };
}

/**
 * Helper to determine if a remote-originated tool execution must override auto-approve.
 */
function isRemoteToolExecutionUnsafe(toolName, parameters, policy) {
  const classification = classifyToolCall(toolName, parameters, policy, { isRemoteSession: true });
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
