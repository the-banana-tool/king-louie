const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');

function setup(chats = [], activeChatId = chats[0]?.id || null) {
  const handlers = new Map();
  const context = new Proxy({
    getChats: () => chats,
    getActiveChatId: () => activeChatId
  }, { get: (target, key) => (key in target ? target[key] : () => null) });
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  return handlers;
}

describe('chat history retrieval IPC', () => {
  it('loads active chat messages and inactive chat metadata only', async () => {
    const active = {
      id: 'chat-active',
      title: 'Active',
      messages: [{ id: 'm1', sender: 'assistant', text: 'Ready', timestamp: '2026-09-29T12:00:00.000Z' }]
    };
    const inactive = {
      id: 'chat-old',
      title: 'Old',
      messages: [
        { id: 'm2', sender: 'user', text: 'old user text', timestamp: '2026-09-28T12:00:00.000Z' },
        { id: 'm3', sender: 'assistant', text: 'old assistant text', timestamp: '2026-09-28T12:01:00.000Z' }
      ]
    };
    const handlers = setup([active, inactive], active.id);

    const envelope = await handlers.get(IPC.CHAT_LOAD)({});
    const result = envelope.data;

    assert.strictEqual(result.activeChatId, active.id);
    assert.deepStrictEqual(result.chats[0].messages, active.messages);
    assert.strictEqual(result.chats[0].messageCount, 1);
    assert.strictEqual(result.chats[1].messages, undefined);
    assert.strictEqual(result.chats[1].messageCount, 2);
    assert.strictEqual(result.chats[1].userMessageCount, 1);
    assert.strictEqual(result.chats[1].assistantMessageCount, 1);
    assert.strictEqual(result.chats[1].preview, 'old assistant text');
    assert.strictEqual(result.chats[1].lastMessageAt, '2026-09-28T12:01:00.000Z');
  });

  it('returns a single chat with its messages by id', async () => {
    const chat = {
      id: 'chat-1',
      title: 'Recall me',
      messages: [
        { id: 'm1', sender: 'user', text: 'remember the blue folder' },
        { id: 'm2', sender: 'assistant', text: 'Noted.' }
      ]
    };
    const handlers = setup([chat]);

    const result = await handlers.get(IPC.CHAT_GET)({}, { chatId: 'chat-1' });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.chat, chat);
  });

  it('reports a missing chat without throwing', async () => {
    const handlers = setup([{ id: 'chat-1', title: 'Only chat', messages: [] }]);

    const result = await handlers.get(IPC.CHAT_GET)({}, { chatId: 'missing' });

    assert.deepStrictEqual(result, { ok: false, error: 'Chat not found.' });
  });
});