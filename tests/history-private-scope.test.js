// tests/history-private-scope.test.js
// The private mark in the history scope (local inference spec
// 2026-10-13 §8.3; owner ruling R-LI-11): a private chat is in no chat's
// scope unless the reader is private too, by link or by "all", and an
// explicit link does not lift that. A private reader reads an ordinary chat
// under its stored scope. Checked through resolveScope with the shipped
// policy, the history IPC, a real ContextBuilder and the real history tools.
// Chats are marked through the store (nothing else can mark until Task 14).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { initializeTools, toolRegistry } = require('../src/tools');
const { resolveScope } = require('../src/history/scope');
const { createScopePolicy } = require('../src/history/scope-policy');
const { bridgeOriginFor } = require('../src/history/bridge-origin');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat, isoAt, BASE_TIME } = require('./helpers/history-fixture');

initializeTools();

const DAY = 86400000;
const QUESTION = 'what is the gate code for the Lakeside lot';
const SECRET = 'the gate code for the Lakeside lot is 4417';
const OTHER_SECRET = 'the gate code for the boathouse is 9001';
const policy = createScopePolicy({ bridgeOriginFor });

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// List order (a new chat goes to the front): a, o, q, p, tg, pc.
function setup() {
  t = openTempStore();
  const { store } = t;
  const chat = (id, title, text, extra = {}) => {
    store.createChat({ id, title, createdAt: isoAt(0), updatedAt: isoAt(0), messages: [], ...extra });
    store.appendMessage(id, { id: `${id}-m1`, sender: 'user', text, timestamp: isoAt(1) }, { updatedAt: isoAt(1) });
  };
  chat('pc', 'Private case chat', SECRET, { caseId: 'case-1' });
  chat('tg', 'Field chat', SECRET, { origin: 'telegram' });
  chat('p', 'Private lot notes', SECRET);
  chat('q', 'Private boathouse notes', OTHER_SECRET);
  chat('o', 'Open notes', 'The fence along the Lakeside lot is forty meters.');
  seedChat(store, { id: 'a', title: 'Asking chat', startMinute: 600, messages: [{ sender: 'user', text: 'Filler note about the garden hose timer.' }] });
  for (const id of ['p', 'q', 'pc']) assert.strictEqual(store.markPrivate(id).marked, true);
  const resolve = (chatId, requested = null) => resolveScope({ store, chatId, requested, policy });
  const estimator = new TokenEstimator();
  const handlers = new Map();
  registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    getHistoryStore: () => store,
    getHistoryRetriever: () => new Retriever({ store, estimator }),
    getSettings: () => ({}),
    getHistoryScopePolicy: () => policy,
    resolveHistoryScope: resolve
  });
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const getSettings = () => ({ history: { recall: { rerank: { enabled: false, search: false } } } });
  const builder = new ContextBuilder({
    store, retriever: new Retriever({ store, estimator }), estimator, getSettings,
    now: () => BASE_TIME + 10 * DAY, resolveScope: (chatId) => resolve(chatId)
  });
  const tools = (chatId) => {
    const history = { chatId, store, retriever: new Retriever({ store, estimator }), estimator, getSettings, resolveScope: (id, requested) => resolve(id, requested) };
    return {
      search: (params) => toolRegistry.get('SearchHistory').execute(params, { history }),
      read: (params) => toolRegistry.get('ReadHistory').execute(params, { history })
    };
  };
  return { store, resolve, call, builder, tools };
}

describe('the private mark in the scope policy', () => {
  it('the refs the policy reads carry the mark', () => {
    const { store } = setup();
    assert.strictEqual(store.chatRef('p').private, true);
    assert.strictEqual(store.chatRef('a').private, false);
  });

  it('R-LI-11: refused under linked and all', async () => {
    const { store, resolve, call } = setup();
    store.setLinks('a', ['o', 'p']);
    store.setHistoryScope('a', 'linked');
    const linked = resolve('a');
    assert.deepStrictEqual(linked.chatIds, ['a', 'o']);
    assert.deepStrictEqual(linked.excluded, [{ chatId: 'p', reason: 'private-chat' }]);
    store.setHistoryScope('a', 'all');
    const all = resolve('a');
    assert.deepStrictEqual(all.chatIds, ['a', 'o']);
    assert.ok(!all.chatIds.includes('p') && !all.chatIds.includes('q') && !all.chatIds.includes('pc'));
    // The scope menu shows why, and a new link to a private chat is refused.
    const view = await call(IPC.HISTORY_LINKS_GET, { chatId: 'a' });
    assert.deepStrictEqual(view.candidates.find((c) => c.id === 'p'), { id: 'p', title: 'Private lot notes', linked: true, allowed: false, reason: 'private-chat' });
    assert.deepStrictEqual(view.candidates.find((c) => c.id === 'q'), { id: 'q', title: 'Private boathouse notes', linked: false, allowed: false, reason: 'private-chat' });
    assert.deepStrictEqual(await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['o', 'q'] }), {
      ok: false, error: 'That chat cannot be linked.', code: 'LINK_REFUSED', refused: [{ id: 'q', reason: 'private-chat' }]
    });
  });

  it('R-LI-11: a private chat reads a private chat', () => {
    const { store, resolve } = setup();
    store.setLinks('p', ['q']);
    store.setHistoryScope('p', 'linked');
    const linked = resolve('p');
    assert.deepStrictEqual(linked.chatIds, ['p', 'q']);
    assert.deepStrictEqual(linked.excluded, []);
    assert.strictEqual(linked.pinned, null);
    store.setHistoryScope('p', 'all');
    assert.deepStrictEqual(resolve('p').chatIds, ['p', 'a', 'o', 'q']);
  });

  it('a private reader reads an ordinary chat under its stored scope', () => {
    const { store, resolve } = setup();
    store.setLinks('p', ['o']);
    store.setHistoryScope('p', 'linked');
    assert.deepStrictEqual(resolve('p').chatIds, ['p', 'o']);
    assert.deepStrictEqual(resolve('p', 'chat').chatIds, ['p'], 'a tool can still narrow it');
  });

  it('a private case chat is first a case chat: it reads itself only and nobody reads it', () => {
    const { store, resolve } = setup();
    store.setHistoryScope('pc', 'all');
    const own = resolve('pc');
    assert.deepStrictEqual(own.chatIds, ['pc']);
    assert.strictEqual(own.pinned.reason, 'case-chat');
    // Not even another private chat, linked.
    store.setLinks('p', ['pc', 'q']);
    store.setHistoryScope('p', 'linked');
    assert.deepStrictEqual(resolve('p').excluded, [{ chatId: 'pc', reason: 'case-chat' }]);
    assert.deepStrictEqual(resolve('p').chatIds, ['p', 'q']);
  });

  it('marking the source after the link was stored removes it from the next resolve', () => {
    const { store, resolve } = setup();
    store.setLinks('a', ['o']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'o']);
    store.markPrivate('o');
    const after = resolve('a');
    assert.deepStrictEqual(after.chatIds, ['a']);
    assert.deepStrictEqual(after.excluded, [{ chatId: 'o', reason: 'private-chat' }]);
    assert.deepStrictEqual(store.getLinks('a'), ['o'], 'the link stays stored; it stops working');
    // Marking the reader lets it read the chat again.
    store.markPrivate('a');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'o']);
  });

  it('an explicit link does not lift it, also for a bridge chat', () => {
    const { store, resolve } = setup();
    store.setLinks('a', ['tg']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'tg'], 'a bridge chat is read through an explicit link (R-H4-7)');
    store.markPrivate('tg');
    assert.deepStrictEqual(resolve('a').excluded, [{ chatId: 'tg', reason: 'private-chat' }]);
    store.setHistoryScope('a', 'all');
    assert.ok(!resolve('a').chatIds.includes('tg'));
  });

  it('a mark the policy cannot read is a mark: only an exact false is "not private"', () => {
    const reader = { id: 'r', title: 'R', private: false };
    const privateReader = { id: 'r', title: 'R', private: true };
    for (const mark of [true, undefined, null, 1, 'no', 0]) {
      const source = { id: 's', title: 'S', private: mark };
      for (const explicit of [true, false]) {
        assert.strictEqual(policy.canRead(reader, source, { explicit }), 'private-chat', String(mark));
        assert.strictEqual(policy.canRead(privateReader, source, { explicit }), true, String(mark));
        // A reader is private only by an exact true.
        assert.strictEqual(policy.canRead({ ...reader, private: 1 }, source, { explicit }), 'private-chat');
        assert.strictEqual(policy.canRead({ id: 'r', title: 'R' }, source, { explicit }), 'private-chat');
      }
    }
    assert.strictEqual(policy.canRead(reader, { id: 's', title: 'S', private: false }, { explicit: false }), true);
    // The three older rules still come first.
    assert.strictEqual(policy.canRead(privateReader, { id: 's', title: 'S', private: true, caseId: 'case-1' }, { explicit: true }), 'case-chat');
    assert.strictEqual(policy.canRead(privateReader, { id: 's', title: 'S', private: true, importedFromCase: true }, { explicit: true }), 'imported-case-chat');
    assert.strictEqual(policy.canRead(reader, { id: 's', title: 'S', private: false, origin: 'telegram' }, { explicit: false }), 'bridge-chat');
    // The mark pins nothing by itself.
    assert.strictEqual(policy.pinnedTo(privateReader), null);
  });

  it('a turn of an ordinary chat recalls nothing from a private chat it is linked to', async () => {
    const { store, builder } = setup();
    store.setLinks('a', ['p']);
    store.setHistoryScope('a', 'linked');
    const built = await builder.build({ chatId: 'a', message: QUESTION, crossChat: true });
    assert.ok(!built.recalled.text.includes('4417'));
    assert.strictEqual(built.stats.scopeChats, 1);
    assert.deepStrictEqual(built.stats.recalledChats, []);
    // The private chat's own turn recalls from the private chat it is linked to.
    store.setLinks('q', ['p']);
    store.setHistoryScope('q', 'linked');
    const priv = await builder.build({ chatId: 'q', message: QUESTION, crossChat: true });
    assert.ok(priv.recalled.text.includes('4417'));
    assert.deepStrictEqual(priv.stats.recalledChats, ['p']);
  });

  it('R-LI-11: SearchHistory and ReadHistory follow', async () => {
    const { store, tools } = setup();
    store.setLinks('a', ['o', 'p']);
    store.setHistoryScope('a', 'linked');
    const reads = [];
    for (const method of ['getMessages', 'lastSeq']) {
      const real = store[method].bind(store);
      store[method] = (chatId, ...rest) => { reads.push(String(chatId)); return real(chatId, ...rest); };
    }
    const open = tools('a');
    const found = await open.search({ query: 'gate code Lakeside lot', scope: 'linked' });
    assert.strictEqual(found.ok, true);
    assert.ok(found.excerpts.every((e) => e.chatId !== 'p' && !e.text.includes('4417')), JSON.stringify(found.excerpts));
    reads.length = 0;
    const refused = await open.read({ chatId: 'p', fromSeq: 1, toSeq: 1 });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /can read only chats in this chat's history scope/);
    assert.ok(!reads.includes('p'), 'no row and no count of the private chat was read');
    assert.strictEqual((await open.read({ chatId: 'o', fromSeq: 1, toSeq: 1 })).ok, true, 'the ordinary linked chat is still read');

    store.setLinks('q', ['p']);
    store.setHistoryScope('q', 'linked');
    const priv = tools('q');
    const own = await priv.search({ query: 'gate code Lakeside lot', scope: 'linked' });
    assert.ok(own.excerpts.some((e) => e.chatId === 'p' && e.text.includes('4417')), JSON.stringify(own.excerpts));
    const read = await priv.read({ chatId: 'p', fromSeq: 1, toSeq: 1 });
    assert.strictEqual(read.ok, true);
    assert.ok(JSON.stringify(read).includes('4417'));
  });
});
