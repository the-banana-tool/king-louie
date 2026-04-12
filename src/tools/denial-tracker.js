/**
 * Denial tracker — counts consecutive user denials for a (tool, key)
 * pair and trips an auto-deny after a threshold so the model stops
 * asking for something the user has already said no to repeatedly.
 *
 * Session-scoped. Not persisted across restarts — a fresh session gets
 * a clean slate, because "I denied rm -rf yesterday" shouldn't block
 * "git rm foo.txt" today.
 *
 * Reset conditions:
 *   - a grant for the same key clears the counter
 *   - setPermissionRules() / addRule() for that pattern clears it too
 *     (the user's intent is now encoded in a rule)
 *
 * Used by ToolExecutor right before prompting the user: if the key
 * has hit the threshold, skip the prompt and return an auto-deny with
 * a note explaining why.
 */

const DEFAULT_THRESHOLD = 3;

class DenialTracker {
  constructor(options = {}) {
    this.threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
    // Map<string, number>
    this._counts = new Map();
  }

  _keyFor(toolName, parameters = {}) {
    // Match the same key a pattern rule would match. Falls back to the
    // tool name alone when the tool has no string field to key on
    // (e.g. Cron with object-shaped params).
    const candidates = ['command', 'url', 'query', 'pattern', 'file_path', 'path'];
    for (const field of candidates) {
      const value = parameters?.[field];
      if (typeof value === 'string' && value.length > 0) {
        return `${toolName}::${value}`;
      }
    }
    return `${toolName}::*`;
  }

  /**
   * Check whether the threshold has been reached. Returns a result
   * object that ToolExecutor can consult before prompting:
   *   { tripped: false }                     — keep asking
   *   { tripped: true, count, threshold }    — auto-deny
   */
  check(toolName, parameters) {
    const key = this._keyFor(toolName, parameters);
    const count = this._counts.get(key) || 0;
    if (count >= this.threshold) {
      return { tripped: true, count, threshold: this.threshold, key };
    }
    return { tripped: false, count, threshold: this.threshold, key };
  }

  recordDenial(toolName, parameters) {
    const key = this._keyFor(toolName, parameters);
    const next = (this._counts.get(key) || 0) + 1;
    this._counts.set(key, next);
    return next;
  }

  recordGrant(toolName, parameters) {
    const key = this._keyFor(toolName, parameters);
    this._counts.delete(key);
  }

  reset() {
    this._counts.clear();
  }

  size() {
    return this._counts.size;
  }
}

module.exports = DenialTracker;
