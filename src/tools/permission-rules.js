/**
 * Pattern-based tool permission rules.
 *
 * Today king-louie's permission system has only a per-tool boolean
 * (`requiresApproval`) plus a global auto-approve list. That forces users
 * into a binary: approve every Bash call individually, or auto-approve
 * ALL Bash. There's no way to express "let me run any `git status` or
 * `npm test` without asking, but always ask before `rm`".
 *
 * This module evaluates ordered rules of shape:
 *   { tool, pattern, action: 'allow'|'ask'|'deny', source }
 *
 * Match precedence: first matching rule wins. If no rule matches,
 * evaluation falls back to the tool's default (`requiresApproval`).
 *
 * Pattern syntax:
 *   - "*"        — match anything (after the tool selector)
 *   - "git *"    — glob over the matched key (whitespace, * = any)
 *   - "git status" — exact prefix match
 *   - leading/trailing whitespace ignored
 *
 * For Bash, the matched key is `params.command`. For other tools, it's
 * the value of `params[keyField]` if a key field is configured for that
 * tool, otherwise the rule must use `pattern: '*'` (apply to all calls).
 */

// Map tool name → which parameter to match the pattern against. Tools not
// in this map can only use blanket `*` rules.
const TOOL_KEY_FIELDS = {
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern'
};

function compilePattern(pattern) {
  if (!pattern || pattern === '*') return /.*/s;
  // Escape regex metacharacters except for `*`, then replace `*` with `.*`.
  // Whitespace in pattern matches one or more whitespace runs in the input.
  const escaped = String(pattern)
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

// Fall-back order when a tool isn't in TOOL_KEY_FIELDS. Picks the first
// string field present, in this priority order. Lets new tools work with
// pattern rules without an explicit registry update.
const FALLBACK_KEY_FIELDS = ['command', 'url', 'query', 'pattern', 'file_path', 'path'];

function matchKeyForTool(toolName, params = {}) {
  const explicit = TOOL_KEY_FIELDS[toolName];
  if (explicit) {
    const value = params?.[explicit];
    return typeof value === 'string' ? value : null;
  }
  for (const field of FALLBACK_KEY_FIELDS) {
    const value = params?.[field];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Evaluate rules against a tool call. Returns:
 *   { matched: true, action: 'allow'|'ask'|'deny', rule } on first match
 *   { matched: false } when no rule applied
 */
function evaluateRules(rules, toolName, parameters = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { matched: false };
  }

  const callKey = matchKeyForTool(toolName, parameters);

  for (const rule of rules) {
    if (!rule || rule.tool !== toolName) continue;
    const action = String(rule.action || '').toLowerCase();
    if (!['allow', 'ask', 'deny'].includes(action)) continue;

    // Blanket rule — applies to every call of this tool.
    if (!rule.pattern || rule.pattern === '*') {
      return { matched: true, action, rule };
    }

    // Pattern rule but no key field configured — can't match.
    if (callKey === null) continue;

    let regex = rule._compiled;
    if (!regex) {
      try {
        regex = compilePattern(rule.pattern);
        rule._compiled = regex; // cache on rule object
      } catch {
        continue;
      }
    }
    if (regex.test(callKey)) {
      return { matched: true, action, rule };
    }
  }

  return { matched: false };
}

/**
 * Try to summarize a rule for telemetry / approval-dialog display.
 */
function describeRule(rule) {
  if (!rule) return null;
  const parts = [rule.tool || 'unknown'];
  if (rule.pattern && rule.pattern !== '*') parts.push(`'${rule.pattern}'`);
  parts.push(`→ ${rule.action || 'unknown'}`);
  if (rule.source) parts.push(`(${rule.source})`);
  return parts.join(' ');
}

module.exports = {
  evaluateRules,
  describeRule,
  compilePattern,
  matchKeyForTool,
  TOOL_KEY_FIELDS
};
