const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');

function setup(chats = [], activeChatId = chats[0]?.id || null, overrides = {}) {
  const handlers = new Map();
  const context = new Proxy({
    getChats: () => chats,
    setChats: (next) => { chats.splice(0, chats.length, ...next); },
    getActiveChatId: () => activeChatId,
    setActiveChatId: (id) => { activeChatId = id; },
    createId: () => `id-${Math.random().toString(16).slice(2)}`,
    getSettings: () => ({}),
    ...overrides
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

  it('routes simple chat mutations through the history facade when present', async () => {
    const chat = { id: 'chat-1', title: 'Old name', messages: [] };
    const calls = [];
    const handlers = setup([chat], chat.id, {
      updateChat: (chatId, patch) => {
        calls.push({ chatId, patch });
        Object.assign(chat, patch);
        return { ...chat };
      }
    });

    const renamed = await handlers.get(IPC.CHAT_RENAME)({}, { chatId: chat.id, name: 'New name' });
    const agentMode = await handlers.get(IPC.CHAT_SET_AGENT_MODE)({}, { chatId: chat.id, agentMode: true });

    assert.strictEqual(renamed.data.title, 'New name');
    assert.strictEqual(agentMode.data.agentMode, true);
    assert.deepStrictEqual(calls.map((call) => [call.chatId, Object.keys(call.patch).sort()]), [
      ['chat-1', ['title', 'updatedAt']],
      ['chat-1', ['agentMode', 'updatedAt']]
    ]);
  });

  it('routes single-chat reads and truncation through the history facade when present', async () => {
    const chat = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        { id: 'm1', sender: 'user', text: 'one' },
        { id: 'm2', sender: 'assistant', text: 'two' },
        { id: 'm3', sender: 'user', text: 'three' }
      ]
    };
    const calls = [];
    const handlers = setup([chat], chat.id, {
      getChat: (chatId, options) => {
        calls.push({ method: 'getChat', chatId, options });
        return chatId === chat.id ? chat : null;
      },
      updateChat: (chatId, patch) => {
        calls.push({ method: 'updateChat', chatId, patch });
        Object.assign(chat, patch);
        return { ...chat };
      }
    });

    const result = await handlers.get(IPC.CHAT_TRUNCATE_FROM)({}, { chatId: chat.id, fromIndex: 2 });

    assert.strictEqual(result.data.messages.length, 2);
    assert.deepStrictEqual(chat.messages.map((m) => m.id), ['m1', 'm2']);
    assert.deepStrictEqual(calls.map((call) => [call.method, call.chatId]), [
      ['getChat', 'chat-1'],
      ['updateChat', 'chat-1']
    ]);
    assert.deepStrictEqual(calls[0].options, { messages: true });
    assert.deepStrictEqual(Object.keys(calls[1].patch).sort(), ['messages', 'updatedAt']);
  });
});
