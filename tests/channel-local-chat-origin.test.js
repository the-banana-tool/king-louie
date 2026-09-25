// tests/channel-local-chat-origin.test.js
// A case can be attached only to chats whose messages are host-verified as
// the owner's (chat-handlers.js ownerMessages builder, case-handlers.js
// CASE_ATTACH). A Telegram/Discord bridge chat carries a remote sender's
// text stamped sender: 'user' too, so the chat it creates, and every
// message it appends, must be tagged with the channel they came from (F5).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const TelegramBridge = require('../src/channels/telegram-bridge');
const DiscordChannel = require('../src/channels/discord-bridge');

function makeGateway() {
  const gw = new EventEmitter();
  gw.sendToAgent = async () => {};
  return gw;
}

function makeSessionManager() {
  return {
    buildSessionKey: (agentId, channel, chatId) => `agent:${agentId}:${channel}:${chatId}`,
    getOrCreateSession: (key) => ({ key }),
    addMessage: () => {},
    listSessions: () => [],
    clearSession: () => false
  };
}

describe('bridge-created chats and messages carry their origin channel (F5)', () => {
  it('TelegramBridge tags the chat it creates and every message it appends', () => {
    const createCalls = [];
    const appendCalls = [];
    const bridge = new TelegramBridge({
      token: 't',
      gatewayServer: makeGateway(),
      sessionManager: makeSessionManager(),
      createLocalChat: (title, meta) => { createCalls.push({ title, meta }); return 'local-1'; },
      addMessageToLocalChat: (chatId, sender, text, meta) => { appendCalls.push({ chatId, sender, text, meta }); }
    });
    bridge.getOrCreateLocalChat('12345', 'Alex');
    bridge.addToLocalChat('12345', 'user', 'hello there');
    assert.strictEqual(createCalls.length, 1);
    assert.deepStrictEqual(createCalls[0].meta, { origin: 'telegram' });
    assert.strictEqual(appendCalls.length, 1);
    assert.deepStrictEqual(appendCalls[0].meta, { channel: 'telegram' });
  });

  it('DiscordChannel tags the chat it creates and every message it appends', () => {
    const createCalls = [];
    const appendCalls = [];
    const bridge = new DiscordChannel({
      token: 't',
      gatewayServer: makeGateway(),
      sessionManager: makeSessionManager(),
      createLocalChat: (title, meta) => { createCalls.push({ title, meta }); return 'local-1'; },
      addMessageToLocalChat: (chatId, sender, text, meta) => { appendCalls.push({ chatId, sender, text, meta }); }
    });
    bridge.getOrCreateLocalChat('67890', 'Sam');
    bridge.addToLocalChat('67890', 'assistant', 'reply text');
    assert.strictEqual(createCalls.length, 1);
    assert.deepStrictEqual(createCalls[0].meta, { origin: 'discord' });
    assert.strictEqual(appendCalls.length, 1);
    assert.deepStrictEqual(appendCalls[0].meta, { channel: 'discord' });
  });
});
