const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');

describe('IPC constants – sandbox mode entries', () => {
  it('has CHAT_SET_SANDBOX_MODE constant', () => {
    assert.ok(IPC.CHAT_SET_SANDBOX_MODE);
    assert.strictEqual(IPC.CHAT_SET_SANDBOX_MODE, 'chat:setSandboxMode');
  });

  it('has CHAT_SET_AGENT_MODE constant', () => {
    assert.ok(IPC.CHAT_SET_AGENT_MODE);
    assert.strictEqual(IPC.CHAT_SET_AGENT_MODE, 'chat:setAgentMode');
  });

  it('has SETTINGS_SAVE_DEFAULTS constant', () => {
    assert.ok(IPC.SETTINGS_SAVE_DEFAULTS);
    assert.strictEqual(IPC.SETTINGS_SAVE_DEFAULTS, 'settings:saveDefaults');
  });

  it('sandbox and agent mode constants are distinct', () => {
    assert.notStrictEqual(IPC.CHAT_SET_SANDBOX_MODE, IPC.CHAT_SET_AGENT_MODE);
  });

  it('all chat constants are present', () => {
    const chatConstants = [
      'CHAT_LOAD',
      'CHAT_CREATE',
      'CHAT_SET_ACTIVE',
      'CHAT_RENAME',
      'CHAT_DELETE',
      'CHAT_ADD_MESSAGE',
      'CHAT_SPEAK_LAST',
      'CHAT_SEND_MESSAGE',
      'CHAT_STOP_RESPONSE',
      'CHAT_SET_AGENT_MODE',
      'CHAT_SET_SANDBOX_MODE',
      'CHAT_SET_WORKING_DIR',
      'CHAT_PICK_WORKING_DIR'
    ];

    for (const key of chatConstants) {
      assert.ok(IPC[key], `Missing IPC constant: ${key}`);
      assert.strictEqual(typeof IPC[key], 'string');
    }
  });

  it('all settings constants are present', () => {
    const settingsConstants = [
      'SETTINGS_LOAD',
      'SETTINGS_SAVE_TEMPLATE_VARIABLES',
      'SETTINGS_SAVE_USER_PROFILE',
      'SETTINGS_SAVE_VOICE',
      'SETTINGS_SAVE_ELEVENLABS_KEY',
      'SETTINGS_TEST_VOICE',
      'SETTINGS_SET_ACTIVE_PROVIDER',
      'SETTINGS_SET_PROVIDER_MODEL',
      'SETTINGS_SAVE_PROVIDER',
      'SETTINGS_TEST_PROVIDER',
      'SETTINGS_RUN_LLM_COMMAND',
      'SETTINGS_SET_INFERENCE_TIER',
      'SETTINGS_SAVE_NOTIFICATIONS',
      'SETTINGS_SAVE_DEFAULTS'
    ];

    for (const key of settingsConstants) {
      assert.ok(IPC[key], `Missing IPC constant: ${key}`);
      assert.strictEqual(typeof IPC[key], 'string');
    }
  });

  it('no duplicate constant values', () => {
    const values = Object.values(IPC);
    const unique = new Set(values);
    assert.strictEqual(values.length, unique.size, 'Found duplicate IPC constant values');
  });
});
