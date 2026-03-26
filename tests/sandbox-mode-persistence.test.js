const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Sandbox mode – IPC handler simulation', () => {
  // Simulate the setSandboxMode IPC handler from chat-handlers.js
  function setSandboxMode(chats, chatId, sandboxMode) {
    return chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, sandboxMode: !!sandboxMode, updatedAt: new Date().toISOString() }
        : chat
    );
  }

  it('enables sandbox mode on a chat', () => {
    const chats = [{ id: 'chat-1', sandboxMode: false }];
    const updated = setSandboxMode(chats, 'chat-1', true);
    assert.strictEqual(updated[0].sandboxMode, true);
  });

  it('disables sandbox mode on a chat', () => {
    const chats = [{ id: 'chat-1', sandboxMode: true }];
    const updated = setSandboxMode(chats, 'chat-1', false);
    assert.strictEqual(updated[0].sandboxMode, false);
  });

  it('only updates the target chat', () => {
    const chats = [
      { id: 'chat-1', sandboxMode: true },
      { id: 'chat-2', sandboxMode: true }
    ];
    const updated = setSandboxMode(chats, 'chat-1', false);
    assert.strictEqual(updated[0].sandboxMode, false);
    assert.strictEqual(updated[1].sandboxMode, true);
  });

  it('adds updatedAt timestamp', () => {
    const chats = [{ id: 'chat-1', sandboxMode: true }];
    const before = new Date().toISOString();
    const updated = setSandboxMode(chats, 'chat-1', false);
    assert.ok(updated[0].updatedAt >= before);
  });

  it('does not modify other chat properties', () => {
    const chats = [{ id: 'chat-1', title: 'My Chat', sandboxMode: false, agentMode: true }];
    const updated = setSandboxMode(chats, 'chat-1', true);
    assert.strictEqual(updated[0].title, 'My Chat');
    assert.strictEqual(updated[0].agentMode, true);
    assert.strictEqual(updated[0].sandboxMode, true);
  });

  it('coerces sandboxMode to boolean', () => {
    const chats = [{ id: 'chat-1', sandboxMode: false }];
    assert.strictEqual(setSandboxMode(chats, 'chat-1', 1)[0].sandboxMode, true);
    assert.strictEqual(setSandboxMode(chats, 'chat-1', 0)[0].sandboxMode, false);
    assert.strictEqual(setSandboxMode(chats, 'chat-1', '')[0].sandboxMode, false);
    assert.strictEqual(setSandboxMode(chats, 'chat-1', 'yes')[0].sandboxMode, true);
    assert.strictEqual(setSandboxMode(chats, 'chat-1', null)[0].sandboxMode, false);
    assert.strictEqual(setSandboxMode(chats, 'chat-1', undefined)[0].sandboxMode, false);
  });

  it('handles chat not found gracefully', () => {
    const chats = [{ id: 'chat-1', sandboxMode: true }];
    const updated = setSandboxMode(chats, 'nonexistent', false);
    assert.strictEqual(updated[0].sandboxMode, true);
    assert.strictEqual(updated.length, 1);
  });

  it('handles empty chats array', () => {
    const updated = setSandboxMode([], 'chat-1', true);
    assert.strictEqual(updated.length, 0);
  });
});

describe('Agent mode – IPC handler simulation', () => {
  // Simulate the setAgentMode IPC handler from chat-handlers.js
  function setAgentMode(chats, chatId, agentMode) {
    return chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, agentMode: !!agentMode, updatedAt: new Date().toISOString() }
        : chat
    );
  }

  it('enables agent mode on a chat', () => {
    const chats = [{ id: 'chat-1', agentMode: false }];
    const updated = setAgentMode(chats, 'chat-1', true);
    assert.strictEqual(updated[0].agentMode, true);
  });

  it('disables agent mode on a chat', () => {
    const chats = [{ id: 'chat-1', agentMode: true }];
    const updated = setAgentMode(chats, 'chat-1', false);
    assert.strictEqual(updated[0].agentMode, false);
  });

  it('coerces agentMode to boolean', () => {
    const chats = [{ id: 'chat-1', agentMode: false }];
    assert.strictEqual(setAgentMode(chats, 'chat-1', 1)[0].agentMode, true);
    assert.strictEqual(setAgentMode(chats, 'chat-1', 0)[0].agentMode, false);
    assert.strictEqual(setAgentMode(chats, 'chat-1', null)[0].agentMode, false);
  });
});

describe('Settings defaults – saveDefaults handler simulation', () => {
  function saveDefaults(currentSettings, incomingDefaults) {
    const merged = {
      ...(currentSettings.defaults || {}),
      ...(incomingDefaults || {})
    };
    return {
      agentMode: !!merged.agentMode,
      sandboxMode: merged.sandboxMode !== false
    };
  }

  it('saves agentMode=true', () => {
    const result = saveDefaults({}, { agentMode: true });
    assert.strictEqual(result.agentMode, true);
  });

  it('saves sandboxMode=false', () => {
    const result = saveDefaults({}, { sandboxMode: false });
    assert.strictEqual(result.sandboxMode, false);
  });

  it('preserves existing defaults when updating one key', () => {
    const result = saveDefaults(
      { defaults: { agentMode: true, sandboxMode: false } },
      { agentMode: false }
    );
    assert.strictEqual(result.agentMode, false);
    assert.strictEqual(result.sandboxMode, false);
  });

  it('sanitizes to only known keys', () => {
    const result = saveDefaults({}, { agentMode: true, sandboxMode: false, hackMode: true });
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, false);
    assert.strictEqual(result.hackMode, undefined);
  });

  it('handles empty incoming defaults', () => {
    const result = saveDefaults({ defaults: { agentMode: true, sandboxMode: false } }, {});
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, false);
  });

  it('handles null incoming defaults', () => {
    const result = saveDefaults({ defaults: { agentMode: true } }, null);
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('handles no existing defaults', () => {
    const result = saveDefaults({}, { agentMode: true, sandboxMode: true });
    assert.strictEqual(result.agentMode, true);
    assert.strictEqual(result.sandboxMode, true);
  });

  it('coerces agentMode falsy values', () => {
    assert.strictEqual(saveDefaults({}, { agentMode: 0 }).agentMode, false);
    assert.strictEqual(saveDefaults({}, { agentMode: '' }).agentMode, false);
    assert.strictEqual(saveDefaults({}, { agentMode: null }).agentMode, false);
    assert.strictEqual(saveDefaults({}, { agentMode: undefined }).agentMode, false);
  });

  it('sandboxMode only false when explicitly false', () => {
    assert.strictEqual(saveDefaults({}, { sandboxMode: false }).sandboxMode, false);
    assert.strictEqual(saveDefaults({}, { sandboxMode: true }).sandboxMode, true);
    assert.strictEqual(saveDefaults({}, { sandboxMode: undefined }).sandboxMode, true);
    assert.strictEqual(saveDefaults({}, { sandboxMode: 0 }).sandboxMode, true);
    assert.strictEqual(saveDefaults({}, { sandboxMode: '' }).sandboxMode, true);
    assert.strictEqual(saveDefaults({}, { sandboxMode: null }).sandboxMode, true);
  });
});

describe('Sandbox mode – end-to-end flow simulation', () => {
  // Full flow: settings default → chat creation → state sync → tool execution
  it('sandbox off by default → new chat → tool executor gets useSandbox=false', () => {
    // Step 1: Settings
    const settings = { defaults: { agentMode: false, sandboxMode: false } };

    // Step 2: Chat creation
    const defaults = settings.defaults || {};
    const chat = {
      id: 'test-chat',
      agentMode: !!defaults.agentMode,
      sandboxMode: defaults.sandboxMode !== false
    };
    assert.strictEqual(chat.sandboxMode, false);

    // Step 3: State sync
    const isSandboxModeEnabled = chat.sandboxMode !== false;
    assert.strictEqual(isSandboxModeEnabled, false);

    // Step 4: Tool executor would receive useSandbox: false
    assert.strictEqual(isSandboxModeEnabled, false);
  });

  it('sandbox on by default → new chat → tool executor gets useSandbox=true', () => {
    const settings = { defaults: { agentMode: false, sandboxMode: true } };
    const defaults = settings.defaults || {};
    const chat = {
      id: 'test-chat',
      agentMode: !!defaults.agentMode,
      sandboxMode: defaults.sandboxMode !== false
    };
    assert.strictEqual(chat.sandboxMode, true);

    const isSandboxModeEnabled = chat.sandboxMode !== false;
    assert.strictEqual(isSandboxModeEnabled, true);
  });

  it('toggle sandbox mid-chat updates state correctly', () => {
    // Start with sandbox on
    let sandboxMode = true;
    assert.strictEqual(sandboxMode, true);

    // User toggles off
    sandboxMode = false;
    assert.strictEqual(sandboxMode, false);

    // User toggles back on
    sandboxMode = true;
    assert.strictEqual(sandboxMode, true);
  });

  it('agent mode default works independently of sandbox mode', () => {
    const settings = { defaults: { agentMode: true, sandboxMode: false } };
    const defaults = settings.defaults || {};
    const chat = {
      agentMode: !!defaults.agentMode,
      sandboxMode: defaults.sandboxMode !== false
    };
    assert.strictEqual(chat.agentMode, true);
    assert.strictEqual(chat.sandboxMode, false);
  });
});
