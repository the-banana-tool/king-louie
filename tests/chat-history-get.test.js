// tests/chat-history-get.test.js
// chat:load gives every chat's metadata plus the active chat's messages;
// chat:get gives one chat; mutations go straight to the history store
// (recall spec §4.4).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { historyContext } = require('./helpers/history-context');

const msg = (id, sender, text, timestamp = '2026-09-29T12:00:00.000Z') => ({ id, sender, text, timestamp });
const withoutSeq = (messages) => messages.map(({ seq: _seq, ...m }) => m);

function setup(chats = [], activeChatId = chats[0]?.id || null, overrides = {}) {
  const handlers = new Map();
  const history = historyContext(chats);
  const state = { activeChatId };
  const context = new Proxy({
    ...history,
    getActiveChatId: () => state.activeChatId,
    setActiveChatId: (id) => { state.activeChatId = id; },
    createId: () => `id-${Math.random().toString(16).slice(2)}`,
    getSettings: () => ({}),
    ...overrides
  }, { get: (target, key) => (key in target ? target[key] : () => null) });
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { invoke, history, state };
}

const ACTIVE = { id: 'chat-active', title: 'Active', messages: [msg('m1', 'assistant', 'Ready')] };
const INACTIVE = {
  id: 'chat-old',
  title: 'Old',
  messages: [msg('m2', 'user', 'old user text', '2026-09-28T12:00:00.000Z'), msg('m3', 'assistant', 'old assistant text', '2026-09-28T12:01:00.000Z')]
};

describe('chat history IPC', () => {
  it('loads the active chat with messages and the others as metadata only', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE], ACTIVE.id);
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.activeChatId, ACTIVE.id);
    assert.deepStrictEqual(withoutSeq(data.chats[0].messages), ACTIVE.messages);
    assert.strictEqual(data.chats[0].messageCount, 1);
    assert.strictEqual(data.chats[1].messages, undefined);
    assert.strictEqual(data.chats[1].messageCount, 2);
    assert.strictEqual(data.chats[1].userMessageCount, 1);
    assert.strictEqual(data.chats[1].assistantMessageCount, 1);
    assert.strictEqual(data.chats[1].preview, 'old assistant text');
    assert.strictEqual(data.chats[1].lastMessageAt, '2026-09-28T12:01:00.000Z');
    assert.deepStrictEqual(data.history, { available: true, error: null, migrationFailed: 0 });
  });

  it('opens the first chat when the stored active id names no chat (review focus 3)', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE], 'deleted-long-ago');
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.activeChatId, ACTIVE.id);
    assert.ok(Array.isArray(data.chats[0].messages));
  });

  it('answers with no chats, and says why, when the history store did not open', async () => {
    const history = { available: false, error: 'file is not a database', migrationFailed: 0 };
    const { invoke } = setup([ACTIVE], ACTIVE.id, { getHistoryStatus: () => history });
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.deepStrictEqual(data, { chats: [], activeChatId: null, history });
  });

  it('passes the number of chats left behind by the migration to the renderer', async () => {
    const { invoke } = setup([ACTIVE], ACTIVE.id, { getHistoryStatus: () => ({ available: true, error: null, migrationFailed: 2 }) });
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.history.migrationFailed, 2);
    assert.strictEqual(data.chats.length, 1);
  });

  it('returns a single chat with its messages by id, and reports a missing one', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE]);
    const result = await invoke(IPC.CHAT_GET, { chatId: INACTIVE.id });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.chat.messages.map((m) => m.seq), [1, 2]);
    assert.deepStrictEqual(withoutSeq(result.chat.messages), INACTIVE.messages);
    assert.deepStrictEqual(await invoke(IPC.CHAT_GET, { chatId: 'missing' }), { ok: false, error: 'Chat not found.' });
  });

  it('persists renames and mode toggles, returning the chat with its messages', async () => {
    const { invoke, history } = setup([ACTIVE]);
    const renamed = await invoke(IPC.CHAT_RENAME, { chatId: ACTIVE.id, name: 'New name' });
    const agentMode = await invoke(IPC.CHAT_SET_AGENT_MODE, { chatId: ACTIVE.id, agentMode: true });
    assert.strictEqual(renamed.data.title, 'New name');
    assert.strictEqual(renamed.data.messages.length, 1);
    assert.strictEqual(agentMode.data.agentMode, true);
    assert.deepStrictEqual(history.getChat(ACTIVE.id, { messages: false }).title, 'New name');
  });

  it('creates a chat at the front and makes it active; deleting it moves to the first chat, with messages', async () => {
    const { invoke, state } = setup([ACTIVE, INACTIVE], ACTIVE.id);
    const created = await invoke(IPC.CHAT_CREATE, 'Fresh chat');
    assert.strictEqual(state.activeChatId, created.data.id);
    const listed = (await invoke(IPC.CHAT_LOAD)).data.chats.map((c) => c.id);
    assert.deepStrictEqual(listed, [created.data.id, ACTIVE.id, INACTIVE.id]);
    const deleted = await invoke(IPC.CHAT_DELETE, created.data.id);
    assert.strictEqual(deleted.data.activeChatId, ACTIVE.id);
    assert.deepStrictEqual(deleted.data.chats.map((c) => c.id), [ACTIVE.id, INACTIVE.id]);
    assert.ok(Array.isArray(deleted.data.chats[0].messages));
    assert.strictEqual(deleted.data.chats[1].messages, undefined);
  });

  it('truncates from an array index through seq and keeps seq dense', async () => {
    const chat = { id: 'chat-1', title: 'Chat', messages: [msg('m1', 'user', 'one'), msg('m2', 'assistant', 'two'), msg('m3', 'user', 'three')] };
    const { invoke, history } = setup([chat]);
    const result = await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 2 });
    assert.deepStrictEqual(result.data.messages.map((m) => [m.seq, m.text]), [[1, 'one'], [2, 'two']]);
    assert.deepStrictEqual(history.getMessages('chat-1').map((m) => m.id), ['m1', 'm2']);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 2 })).ok, false);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 0.5 })).ok, false);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'missing', fromIndex: 0 })).ok, false);
  });
});
