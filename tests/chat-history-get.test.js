const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');

function setup(chats = []) {
  const handlers = new Map();
  const context = new Proxy({
    getChats: () => chats,
    getActiveChatId: () => chats[0]?.id || null
  }, { get: (target, key) => (key in target ? target[key] : () => null) });
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  return handlers;
}

describe('chat history retrieval IPC', () => {
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