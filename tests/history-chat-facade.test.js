// tests/history-chat-facade.test.js
// appendMessageToChat keeps its signature and return value over appendMessage,
// with llmTotals kept incrementally (recall spec §4.4); a store that will not
// open fails every call loudly (§15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  HistoryStore, createChatFacade, chatLlmTotals, createUnavailableHistoryStore, HistoryUnavailableError
} = require('../src/history');
const { historyContext } = require('./helpers/history-context');

function facade(chats = []) {
  const historyStore = HistoryStore.open(':memory:');
  for (const chat of chats) historyStore.createChat(chat, { position: 'back' });
  let n = 0;
  let clock = 0;
  return createChatFacade({
    historyStore,
    createId: () => `gen-${++n}`,
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, clock++)).toISOString()
  });
}
const llm = (inputTokens, outputTokens, costUsd) => ({ totals: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd } });

describe('createChatFacade', () => {
  it('appendMessageToChat sets id, sender and timestamp itself and returns the whole chat', () => {
    const f = facade([{ id: 'c1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?', timestamp: 't0' }] }]);
    const chat = f.appendMessageToChat('c1', 'user', 'hi', { id: 'spoofed', sender: 'assistant', timestamp: '1999-01-01T00:00:00.000Z', seq: 99, channel: 'telegram' });
    const message = chat.messages[1];
    assert.strictEqual(message.id, 'gen-1');
    assert.strictEqual(message.sender, 'user');
    assert.strictEqual(message.timestamp, '2026-09-29T12:00:00.000Z');
    assert.strictEqual(message.seq, 2);
    assert.strictEqual(message.channel, 'telegram');
    assert.strictEqual(chat.updatedAt, '2026-09-29T12:00:00.000Z');
    assert.strictEqual(f.appendMessageToChat('missing', 'user', 'x'), null);
  });

  it('appendMessageToChat with returnChat false returns { message, seq } and never reads the chat messages', () => {
    // llmTotals already kept (every chat after its first append), so the
    // one-time re-sum for a chat without it does not run either.
    const f = facade([{ id: 'c1', title: 'Chat', llmTotals: chatLlmTotals([]), messages: [{ id: 'm0', sender: 'assistant', text: 'hello', timestamp: 't0' }] }]);
    const store = f.historyStore;
    const reads = [];
    const getChat = store.getChat.bind(store);
    const getMessages = store.getMessages.bind(store);
    store.getChat = (id, options = {}) => { reads.push(['getChat', options.messages]); return getChat(id, options); };
    store.getMessages = (...args) => { reads.push(['getMessages']); return getMessages(...args); };
    const r = f.appendMessageToChat('c1', 'toolUse', '', { toolName: 'Read', runId: 'r1' }, { returnChat: false });
    assert.strictEqual(r.seq, 2);
    assert.strictEqual(r.message.id, 'gen-1');
    assert.strictEqual(r.message.toolName, 'Read');
    assert.deepStrictEqual(reads.filter(([what, messages]) => what === 'getMessages' || messages !== false), []);
    assert.strictEqual(f.appendMessageToChat('missing', 'user', 'x', {}, { returnChat: false }), null);
    store.getChat = getChat;
    assert.deepStrictEqual(f.getChat('c1').messages.map((m) => [m.seq, m.sender]), [[1, 'assistant'], [2, 'toolUse']]);
  });

  it('keeps llmTotals incrementally, equal to summing every message', () => {
    const f = facade([{ id: 'c1', title: 'Chat', messages: [] }]);
    f.appendMessageToChat('c1', 'user', 'q1');
    f.appendMessageToChat('c1', 'assistant', 'a1', { llm: llm(100, 20, 0.00123456) });
    f.appendMessageToChat('c1', 'toolUse', '', { toolName: 'Bash', parameters: { command: 'ls' } });
    const chat = f.appendMessageToChat('c1', 'assistant', 'a2', { llm: llm(300, 40, 0.00000011) });
    assert.deepStrictEqual(chat.llmTotals, chatLlmTotals(chat.messages));
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 400, outputTokens: 60, totalTokens: 460, costUsd: 0.00123467 });
  });

  it('starts from the stored messages for a chat that has no llmTotals yet', () => {
    const f = facade([{ id: 'c1', title: 'Legacy', messages: [{ id: 'm1', sender: 'assistant', text: 'old', timestamp: 't', llm: llm(10, 5, 0.5) }] }]);
    const chat = f.appendMessageToChat('c1', 'assistant', 'new', { llm: llm(1, 1, 0.25) });
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 11, outputTokens: 6, totalTokens: 17, costUsd: 0.75 });
  });

  it('truncateChatFrom removes from a seq on and stamps updatedAt', () => {
    const f = facade([{ id: 'c1', title: 'Chat', updatedAt: 'before', messages: ['a', 'b', 'c'].map((t, i) => ({ id: `m${i}`, sender: 'user', text: t, timestamp: 't' })) }]);
    const chat = f.truncateChatFrom('c1', 2);
    assert.deepStrictEqual(chat.messages.map((m) => m.text), ['a']);
    assert.notStrictEqual(chat.updatedAt, 'before');
    assert.strictEqual(f.truncateChatFrom('missing', 1), null);
  });

  it('truncateChatFrom keeps llmTotals: money already spent stays counted', () => {
    const f = facade([{ id: 'c1', title: 'Chat', messages: [] }]);
    f.appendMessageToChat('c1', 'user', 'q1');
    f.appendMessageToChat('c1', 'assistant', 'a1', { llm: llm(100, 20, 0.5) });
    f.appendMessageToChat('c1', 'user', 'q2');
    const before = f.appendMessageToChat('c1', 'assistant', 'a2', { llm: llm(300, 40, 0.25) }).llmTotals;
    const chat = f.truncateChatFrom('c1', 3);
    assert.deepStrictEqual(chat.messages.map((m) => m.text), ['q1', 'a1']);
    assert.deepStrictEqual(chat.llmTotals, before);
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 400, outputTokens: 60, totalTokens: 460, costUsd: 0.75 });
    assert.notDeepStrictEqual(chat.llmTotals, chatLlmTotals(chat.messages));
    const next = f.appendMessageToChat('c1', 'assistant', 'a3', { llm: llm(1, 1, 0.25) });
    assert.deepStrictEqual(next.llmTotals, { inputTokens: 401, outputTokens: 61, totalTokens: 462, costUsd: 1 });
  });

  it('delegates the chat calls to the store', () => {
    const f = facade();
    f.createChat({ id: 'c1', title: 'One' });
    assert.strictEqual(f.updateChat('c1', { title: 'Renamed' }, { messages: false }).title, 'Renamed');
    assert.deepStrictEqual(f.listChats().map((c) => c.title), ['Renamed']);
    assert.strictEqual(f.deleteChat('c1'), true);
  });
});

describe('the unavailable store', () => {
  it('fails every chat call with HISTORY_UNAVAILABLE, naming the cause', () => {
    const store = createUnavailableHistoryStore(new Error('file is not a database'));
    const f = createChatFacade({ historyStore: store, createId: () => 'x' });
    for (const call of [() => f.listChats(), () => f.getChat('c1'), () => f.appendMessageToChat('c1', 'user', 'hi'), () => f.updateChat('c1', {}), () => f.truncateChatFrom('c1', 1)]) {
      assert.throws(call, (err) => err instanceof HistoryUnavailableError && err.code === 'HISTORY_UNAVAILABLE' && /file is not a database/.test(err.message));
    }
    store.close();
    assert.strictEqual(store.isOpen, false);
  });
});

describe('historyContext test helper', () => {
  it('builds a facade over an in-memory store seeded in order', () => {
    const ctx = historyContext([{ id: 'a', title: 'A', messages: [] }, { id: 'b', title: 'B', messages: [] }]);
    assert.deepStrictEqual(ctx.listChats().map((c) => c.id), ['a', 'b']);
    assert.strictEqual(ctx.getHistoryStatus().available, true);
    assert.ok(ctx.getHistoryStore() instanceof HistoryStore);
  });
});
