// tests/history-recall-mark.test.js
// The mark a chat gets when a turn is given text from another chat (stage
// H4 review, finding 1; owner ruling R-H4-1). The stored rows alone miss a
// turn that failed: its recall provenance is on no reply. The mark is set
// before any model call, is never cleared, and case:attach, case:create and
// the case nudge refuse on it.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { initializeTools, toolRegistry } = require('../src/tools');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { resolveScope, OPEN_POLICY } = require('../src/history/scope');
const { bridgeOriginFor } = require('../src/history/bridge-origin');
const { HistoryStore, createChatFacade } = require('../src/history');
const {
  assertChatAttachable, recalledOtherChats, recallMarked, ChatRecalledOtherChatsError
} = require('../src/cases/chat-attach');
const { canOfferCase } = require('../src/cases/case-nudge');
const { chatHarness } = require('./helpers/chat-harness');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

initializeTools();

const DAY = 86400000;
const QUESTION = 'what is the gate code for the Lakeside lot';
const ANSWER = 'The gate code for the Lakeside lot is 4417.';
const HISTORY = { recall: { rerank: { enabled: false, search: false } } };

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// List order a, b. Chat a links b and is scoped "linked".
function setup({ linked = true } = {}) {
  t = openTempStore();
  const { store } = t;
  seedChat(store, { id: 'b', title: 'Lot notes', messages: [{ sender: 'user', text: ANSWER }, { sender: 'assistant', text: 'Noted for the Lakeside lot.' }] });
  seedChat(store, { id: 'a', title: 'Asking chat', startMinute: 600, messages: [{ sender: 'user', text: 'Filler note about the garden hose timer.' }, { sender: 'assistant', text: 'Noted.' }] });
  if (linked) {
    store.setLinks('a', ['b']);
    store.setHistoryScope('a', 'linked');
  }
  const resolve = (chatId, requested = null) => resolveScope({ store, chatId, requested, policy: OPEN_POLICY });
  return { store, resolve };
}

describe('the store keeps the mark', () => {
  it('markRecalledOtherChats sets a time once, and says so for an unknown chat', () => {
    const { store } = setup();
    assert.strictEqual(store.getChat('a', { messages: false }).recalledOtherChatsAt, undefined);
    assert.strictEqual(store.markRecalledOtherChats('a'), true);
    const at = store.getChat('a', { messages: false }).recalledOtherChatsAt;
    assert.ok(!Number.isNaN(Date.parse(at)), 'a time');
    assert.strictEqual(store.markRecalledOtherChats('a'), true);
    assert.strictEqual(store.getChat('a', { messages: false }).recalledOtherChatsAt, at, 'the first mark stands');
    assert.strictEqual(store.markRecalledOtherChats('nobody'), false);
    assert.strictEqual(store.markRecalledOtherChats(''), false);
    assert.strictEqual(store.getChat('b', { messages: false }).recalledOtherChatsAt, undefined);
  });

  it('nothing clears it: a patch, a replace, an upsert, a create over the id, an append, a truncation, the scope', () => {
    const { store } = setup();
    store.markRecalledOtherChats('a');
    const at = store.getChat('a', { messages: false }).recalledOtherChatsAt;
    let n = 0;
    const facade = createChatFacade({ historyStore: store, createId: () => `id-${++n}` });
    const marked = () => store.getChat('a', { messages: false }).recalledOtherChatsAt;

    for (const value of [null, undefined, '', false, 0, '1999-01-01T00:00:00.000Z']) {
      store.updateChat('a', { recalledOtherChatsAt: value, title: 'Renamed' });
      assert.strictEqual(marked(), at, `updateChat ${JSON.stringify(value)}`);
    }
    store.updateChatsWhere((c) => c.id === 'a', () => ({ recalledOtherChatsAt: null }));
    assert.strictEqual(marked(), at, 'updateChatsWhere');
    store.appendMessage('a', { sender: 'user', text: 'more' }, { patch: { recalledOtherChatsAt: null } });
    assert.strictEqual(marked(), at, 'appendMessage patch');
    facade.appendMessageToChat('a', 'user', 'and more');
    assert.strictEqual(marked(), at, 'appendMessageToChat');
    facade.truncateChatFrom('a', 1);
    assert.strictEqual(store.messageCount('a'), 0);
    assert.strictEqual(marked(), at, 'truncation');
    store.setHistoryScope('a', 'chat');
    store.setLinks('a', []);
    assert.strictEqual(marked(), at, 'scope back to chat');
    store.replaceChat('a', { id: 'a', title: 'Replaced', messages: [] });
    assert.strictEqual(marked(), at, 'replaceChat');
    store.upsertChat({ id: 'a', title: 'Upserted', recalledOtherChatsAt: null, messages: [] });
    assert.strictEqual(marked(), at, 'upsertChat');
    store.createChat({ id: 'a', title: 'Created over', messages: [] });
    assert.strictEqual(marked(), at, 'createChat over the id');
  });

  it('a chat object that carries a mark keeps it when it is stored (a desktop copy)', () => {
    const { store } = setup();
    store.upsertChat({ id: 'copy', title: 'Copied', recalledOtherChatsAt: '2026-10-01T00:00:00.000Z', messages: [] });
    assert.strictEqual(store.getChat('copy', { messages: false }).recalledOtherChatsAt, '2026-10-01T00:00:00.000Z');
  });

  it('a read-only store marks nothing and says so', () => {
    const { store } = setup();
    store.close();
    t.store = HistoryStore.open(t.dbPath, { readonly: true });
    assert.strictEqual(t.store.markRecalledOtherChats('a'), false);
  });
});

describe('the attach rule and the nudge read the mark', () => {
  it('recallMarked: any value but a missing one', () => {
    assert.strictEqual(recallMarked({ id: 'a' }), false);
    assert.strictEqual(recallMarked({ id: 'a', recalledOtherChatsAt: null }), false);
    assert.strictEqual(recallMarked(null), false);
    for (const value of ['2026-10-13T10:00:00.000Z', '', false, 0, {}, true]) {
      assert.strictEqual(recallMarked({ id: 'a', recalledOtherChatsAt: value }), true, JSON.stringify(value));
    }
  });

  it('a marked chat with no row that shows it is refused CHAT_RECALLED_OTHER_CHATS', () => {
    const chat = { id: 'a', title: 'Fence', recalledOtherChatsAt: '2026-10-13T10:00:00.000Z', messages: [{ seq: 1, sender: 'user', text: 'hi' }] };
    assert.strictEqual(recalledOtherChats(chat.messages, 'a'), null, 'precondition: the rows show nothing');
    for (const caseId of ['case-lakeside', null]) {
      assert.throws(() => assertChatAttachable(chat, caseId), (e) => e instanceof ChatRecalledOtherChatsError && e.code === 'CHAT_RECALLED_OTHER_CHATS');
    }
    assert.doesNotThrow(() => assertChatAttachable({ ...chat, recalledOtherChatsAt: undefined }, 'case-lakeside'));
    // An import is still named as an import first.
    assert.throws(() => assertChatAttachable({ ...chat, source: 'markdown-transcript' }, null), (e) => e.code === 'IMPORTED_CHAT');
  });

  it('canOfferCase is false for a marked chat', () => {
    const messages = [{ seq: 1, sender: 'user', text: 'hi' }];
    assert.strictEqual(canOfferCase({ chat: { id: 'a' }, messages, bridgeOriginFor }), true);
    assert.strictEqual(canOfferCase({ chat: { id: 'a', recalledOtherChatsAt: '2026-10-13T10:00:00.000Z' }, messages, bridgeOriginFor }), false);
  });
});

describe('a turn that is given text from another chat marks the chat before any model call', () => {
  function turn({ linked = true, provider, overrides = {} } = {}) {
    const { store, resolve } = setup({ linked });
    const estimator = new TokenEstimator();
    const builder = new ContextBuilder({
      store, retriever: new Retriever({ store, estimator }), estimator,
      getSettings: () => ({ history: HISTORY }), now: () => BASE_TIME + 10 * DAY, resolveScope: (chatId) => resolve(chatId)
    });
    let n = 0;
    const facade = createChatFacade({ historyStore: store, createId: () => `t-${++n}` });
    const h = chatHarness({
      provider, providerType: 'openai', model: 'gpt-5.5', chat: { id: 'a' },
      overrides: { ...facade, getHistoryStore: () => store, getContextBuilder: () => builder, getSettings: () => ({ history: HISTORY }), ...overrides }
    });
    const send = () => h.send({ message: QUESTION, agentMode: false }).then((r) => r, (err) => ({ ok: false, error: err.message }));
    return { store, h, send };
  }

  it('finding 1: the model call fails, no reply is stored, and the chat still cannot be attached', async () => {
    const seen = [];
    const { store, send } = turn({
      provider: {
        streamMessage: async (_messages, options) => {
          // What the store says at the moment the model is called.
          seen.push({ marked: store.getChat('a', { messages: false }).recalledOtherChatsAt, prompt: String(options.systemPromptDynamic || '') });
          throw new Error('upstream is down');
        }
      }
    });
    const out = await send();
    assert.strictEqual(out.ok, false);
    assert.ok(seen.length >= 1, 'the model was called');
    assert.ok(seen[0].prompt.includes('4417'), 'precondition: the turn was given text from the other chat');
    assert.ok(seen[0].marked, 'the chat was marked before the model was called');

    const chat = store.getChat('a');
    assert.ok(!chat.messages.some((m) => m.sender === 'assistant' && m.context), 'precondition: no reply carries provenance');
    assert.strictEqual(recalledOtherChats(chat.messages, 'a'), null, 'precondition: the rows show nothing');
    assert.throws(() => assertChatAttachable(chat, 'case-lakeside'), (e) => e.code === 'CHAT_RECALLED_OTHER_CHATS');
    assert.throws(() => assertChatAttachable(chat, null), (e) => e.code === 'CHAT_RECALLED_OTHER_CHATS');
    assert.strictEqual(canOfferCase({ chat, messages: chat.messages, bridgeOriginFor }), false);
  });

  it('a turn that recalled nothing from another chat leaves the chat unmarked', async () => {
    const { store, send } = turn({ linked: false, provider: { streamMessage: async () => { throw new Error('upstream is down'); } } });
    await send();
    assert.strictEqual(store.getChat('a', { messages: false }).recalledOtherChatsAt, undefined);
    assert.doesNotThrow(() => assertChatAttachable(store.getChat('a'), 'case-lakeside'));
  });

  it('a mark that cannot be written fails the turn before the model is called', async () => {
    let calls = 0;
    const { store, send } = turn({ provider: { streamMessage: async () => { calls += 1; return {}; } } });
    for (const broken of [() => false, () => { throw new Error('disk full'); }]) {
      store.markRecalledOtherChats = broken;
      const out = await send();
      assert.strictEqual(out.ok, false);
      assert.match(String(out.error), /could not be recorded/);
      assert.doesNotMatch(String(out.error), /4417/);
    }
    assert.strictEqual(calls, 0, 'no model call');
    assert.ok(!store.getChat('a').messages.some((m) => m.sender === 'assistant' && m.seq > 2), 'no reply stored');
  });
});

describe('SearchHistory and ReadHistory mark the chat when they hand over text from another chat', () => {
  function tools({ linked = true } = {}) {
    const { store, resolve } = setup({ linked });
    const estimator = new TokenEstimator();
    const history = {
      chatId: 'a', store, retriever: new Retriever({ store, estimator }), estimator,
      getSettings: () => ({ history: HISTORY }), resolveScope: resolve
    };
    return {
      store,
      search: (params) => toolRegistry.get('SearchHistory').execute(params, { history }),
      read: (params) => toolRegistry.get('ReadHistory').execute(params, { history }),
      marked: () => store.getChat('a', { messages: false }).recalledOtherChatsAt
    };
  }

  it('SearchHistory: marked when an excerpt is from another chat, not when all are from this one', async () => {
    const x = tools();
    const mine = await x.search({ query: 'garden hose timer', scope: 'chat' });
    assert.strictEqual(mine.ok, true);
    assert.ok(mine.excerpts.length > 0);
    assert.strictEqual(x.marked(), undefined);
    const other = await x.search({ query: 'gate code Lakeside' });
    assert.ok(other.excerpts.some((e) => e.chatId === 'b'));
    assert.ok(x.marked());
  });

  it('ReadHistory: marked for another chat, not for this one', async () => {
    const x = tools();
    assert.strictEqual((await x.read({ fromSeq: 1, toSeq: 2 })).ok, true);
    assert.strictEqual(x.marked(), undefined);
    const out = await x.read({ chatId: 'b', fromSeq: 1, toSeq: 1 });
    assert.ok(out.text.includes('4417'));
    assert.ok(x.marked());
  });

  it('a refused read of a chat outside the scope marks nothing', async () => {
    const x = tools({ linked: false });
    assert.strictEqual((await x.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
    assert.strictEqual(x.marked(), undefined);
  });

  it('a mark that cannot be written: the tool refuses and returns none of the text', async () => {
    for (const broken of [() => false, () => { throw new Error('disk full'); }, undefined]) {
      const x = tools();
      x.store.markRecalledOtherChats = broken;
      for (const out of [await x.search({ query: 'gate code Lakeside' }), await x.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })]) {
        assert.strictEqual(out.ok, false);
        assert.doesNotMatch(JSON.stringify(out), /4417/);
        // A bare failure: the stored row blocks nothing by itself.
        assert.deepStrictEqual(Object.keys(out).sort(), ['error', 'ok']);
      }
      // This chat's own text is still served.
      assert.strictEqual((await x.read({ fromSeq: 1, toSeq: 1 })).ok, true);
      t.cleanup();
      t = null;
    }
  });
});
