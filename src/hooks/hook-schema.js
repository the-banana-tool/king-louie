const VALID_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit'
]);

class HookDefinition {
  constructor(config = {}, options = {}) {
    const normalized = config || {};
    if (!normalized.name || typeof normalized.name !== 'string') {
      throw new Error('Hook name is required.');
    }

    if (!normalized.event || !VALID_EVENTS.has(normalized.event)) {
      throw new Error(
        `Hook '${normalized.name}' has invalid event. Expected one of: ${Array.from(VALID_EVENTS).join(', ')}`
      );
    }

    this.name = normalized.name;
    this.event = normalized.event;
    this.matcher = String(normalized.matcher || '*').trim() || '*';
    this.enabled = normalized.enabled !== false;
    this.description = String(normalized.description || '').trim();
    this.handler = String(normalized.handler || '').trim();
    this.directory = options.directory || '';

    if (!this.handler) {
      throw new Error(`Hook '${this.name}' is missing a handler.`);
    }
  }
}

module.exports = {
  HookDefinition,
  VALID_EVENTS
};
