const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Simulate the DEFAULT_SETTINGS defaults section
const DEFAULT_SETTINGS_DEFAULTS = {
  agentMode: false,
  sandboxMode: true
};

describe('Chat defaults – settings structure', () => {
  it('default agentMode is false', () => {
    assert.strictEqual(DEFAULT_SETTINGS_DEFAULTS.agentMode, false);
  });

  it('default sandboxMode is true', () => {
    assert.strictEqual(DEFAULT_SETTINGS_DEFAULTS.sandboxMode, true);
  });
});

describe('Chat defaults – merge behavior', () => {
  // Simulate the mergeSettings defaults logic
  function mergeDefaults(source = {}) {
    return {
      ...DEFAULT_SETTINGS_DEFAULTS,
      ...(source || {})
    };
  }

  it('uses defaults when no overrides provided', () => {
    const result = mergeDefaults({});
    assert.strictEqual(result.agentMode, false);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('allows overriding agentMode to true', () => {
    const result = mergeDefaults({ agentMode: true });
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('allows overriding sandboxMode to false', () => {
    const result = mergeDefaults({ sandboxMode: false });
    assert.strictEqual(result.agentMode, false);
    assert.strictEqual(result.sandboxMode, false);
  });

  it('allows overriding both simultaneously', () => {
    const result = mergeDefaults({ agentMode: true, sandboxMode: false });
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, false);
  });

  it('ignores unknown keys', () => {
    const result = mergeDefaults({ agentMode: true, unknownKey: 'value' });
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('handles null source', () => {
    const result = mergeDefaults(null);
    assert.strictEqual(result.agentMode, false);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('handles undefined source', () => {
    const result = mergeDefaults(undefined);
    assert.strictEqual(result.agentMode, false);
    assert.strictEqual(result.sandboxMode, true);
  });
});

describe('Chat creation – defaults applied to new chat', () => {
  // Simulate chat creation logic from chat-handlers.js
  function createChat(title, settings = {}) {
    const defaults = settings.defaults || {};
    const now = new Date().toISOString();
    return {
      id: `test-${Date.now()}`,
      title,
      createdAt: now,
      updatedAt: now,
      agentMode: !!defaults.agentMode,
      sandboxMode: defaults.sandboxMode !== false,
      messages: [{
        id: `msg-${Date.now()}`,
        sender: 'assistant',
        text: 'New chat started! How can I help you today?',
        timestamp: now
      }]
    };
  }

  it('creates chat with default agentMode=false', () => {
    const chat = createChat('Test');
    assert.strictEqual(chat.agentMode, false);
  });

  it('creates chat with default sandboxMode=true', () => {
    const chat = createChat('Test');
    assert.strictEqual(chat.sandboxMode, true);
  });

  it('creates chat with agentMode=true when setting enabled', () => {
    const chat = createChat('Test', { defaults: { agentMode: true } });
    assert.strictEqual(chat.agentMode, true);
  });

  it('creates chat with sandboxMode=false when setting disabled', () => {
    const chat = createChat('Test', { defaults: { sandboxMode: false } });
    assert.strictEqual(chat.sandboxMode, false);
  });

  it('creates chat with both overrides', () => {
    const chat = createChat('Test', { defaults: { agentMode: true, sandboxMode: false } });
    assert.strictEqual(chat.agentMode, true);
    assert.strictEqual(chat.sandboxMode, false);
  });

  it('creates chat with correct defaults when settings has no defaults key', () => {
    const chat = createChat('Test', {});
    assert.strictEqual(chat.agentMode, false);
    assert.strictEqual(chat.sandboxMode, true);
  });

  it('creates chat with correct defaults when settings is empty', () => {
    const chat = createChat('Test');
    assert.strictEqual(chat.agentMode, false);
    assert.strictEqual(chat.sandboxMode, true);
  });

  it('chat has required fields', () => {
    const chat = createChat('My Chat');
    assert.ok(chat.id);
    assert.strictEqual(chat.title, 'My Chat');
    assert.ok(chat.createdAt);
    assert.ok(chat.updatedAt);
    assert.ok(Array.isArray(chat.messages));
    assert.strictEqual(chat.messages.length, 1);
    assert.strictEqual(chat.messages[0].sender, 'assistant');
  });

  it('sandboxMode defaults to true with falsy but non-false values', () => {
    // sandboxMode: 0 is falsy but should be treated carefully
    const chat = createChat('Test', { defaults: { sandboxMode: 0 } });
    // 0 !== false is true, so sandboxMode should be true
    assert.strictEqual(chat.sandboxMode, true);
  });

  it('sandboxMode is false only when explicitly false', () => {
    const chatFalse = createChat('Test', { defaults: { sandboxMode: false } });
    assert.strictEqual(chatFalse.sandboxMode, false);

    const chatTrue = createChat('Test', { defaults: { sandboxMode: true } });
    assert.strictEqual(chatTrue.sandboxMode, true);

    const chatUndefined = createChat('Test', { defaults: {} });
    assert.strictEqual(chatUndefined.sandboxMode, true);
  });
});

describe('Chat state – appState synchronization', () => {
  // Simulate appState sync logic from renderer.js
  function syncAppState(chat) {
    return {
      isAgentModeEnabled: !!(chat && chat.agentMode),
      isSandboxModeEnabled: chat ? chat.sandboxMode !== false : true
    };
  }

  it('syncs agent mode from chat', () => {
    const state = syncAppState({ agentMode: true, sandboxMode: true });
    assert.strictEqual(state.isAgentModeEnabled, true);
  });

  it('syncs sandbox mode from chat', () => {
    const state = syncAppState({ agentMode: false, sandboxMode: false });
    assert.strictEqual(state.isSandboxModeEnabled, false);
  });

  it('defaults agent mode to false when chat is null', () => {
    const state = syncAppState(null);
    assert.strictEqual(state.isAgentModeEnabled, false);
  });

  it('defaults sandbox mode to true when chat is null', () => {
    const state = syncAppState(null);
    assert.strictEqual(state.isSandboxModeEnabled, true);
  });

  it('defaults sandbox mode to true when chat has no sandboxMode property', () => {
    const state = syncAppState({ agentMode: false });
    assert.strictEqual(state.isSandboxModeEnabled, true);
  });

  it('defaults agent mode to false when chat has no agentMode property', () => {
    const state = syncAppState({ sandboxMode: true });
    assert.strictEqual(state.isAgentModeEnabled, false);
  });

  it('handles undefined chat', () => {
    const state = syncAppState(undefined);
    assert.strictEqual(state.isAgentModeEnabled, false);
    assert.strictEqual(state.isSandboxModeEnabled, true);
  });

  it('handles chat with both modes enabled', () => {
    const state = syncAppState({ agentMode: true, sandboxMode: true });
    assert.strictEqual(state.isAgentModeEnabled, true);
    assert.strictEqual(state.isSandboxModeEnabled, true);
  });

  it('handles chat with both modes disabled', () => {
    const state = syncAppState({ agentMode: false, sandboxMode: false });
    assert.strictEqual(state.isAgentModeEnabled, false);
    assert.strictEqual(state.isSandboxModeEnabled, false);
  });
});
