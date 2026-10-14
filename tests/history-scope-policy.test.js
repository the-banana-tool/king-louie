// tests/history-scope-policy.test.js
// The shipped scope policy (recall spec §6.3, stage H4; owner rulings
// R-H4-1, R-H4-2, R-H4-7): case chats, imported case-chat exports and bridge
// chats keep to themselves. Checked through resolveScope, the history IPC
// and a real ContextBuilder.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { resolveScope } = require('../src/history/scope');
const { createScopePolicy } = require('../src/history/scope-policy');
const { bridgeOriginFor, LEGACY_BRIDGE_TITLE_PREFIXES } = require('../src/history/bridge-origin');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat, isoAt, BASE_TIME } = require('./helpers/history-fixture');

const DAY = 86400000;
const QUESTION = 'what is the gate code for the Lakeside lot';
const ANSWER = 'the gate code for the Lakeside lot is 4417';
const policy = createScopePolicy({ bridgeOriginFor });

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// List order: a, b, case, export, tg, legacy, imp (a new chat goes to the front).
function setup() {
  t = openTempStore();
  const { store } = t;
  const chat = (id, title, extra = {}, text = `Notes kept in ${title}.`) => {
    store.createChat({ id, title, createdAt: isoAt(0), updatedAt: isoAt(0), messages: [], ...extra });
    store.appendMessage(id, { id: `${id}-m1`, sender: 'user', text, timestamp: isoAt(1) }, { updatedAt: isoAt(1) });
  };
  chat('imp', 'Imported session', { source: 'claude-code-jsonl' }, ANSWER);
  chat('legacy', `${LEGACY_BRIDGE_TITLE_PREFIXES[0]}Sam (1001)`);
  chat('tg', 'Field chat', { origin: 'telegram' }, ANSWER);
  chat('export', 'Exported case chat', { source: 'king-louie-json', importedFromCase: true }, ANSWER);
  chat('case', 'Lot sale', { caseId: 'case-1' }, ANSWER);
  chat('b', 'Lot notes', {}, ANSWER);
  seedChat(store, { id: 'a', title: 'Asking chat', startMinute: 600, messages: [{ sender: 'user', text: 'Filler note about the garden hose timer.' }] });
  const resolve = (chatId, requested = null) => resolveScope({ store, chatId, requested, policy });
  const handlers = new Map();
  const estimator = new TokenEstimator();
  registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    getHistoryStore: () => store,
    getHistoryRetriever: () => new Retriever({ store, estimator }),
    getSettings: () => ({}),
    getHistoryScopePolicy: () => policy,
    resolveHistoryScope: resolve
  });
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const builder = new ContextBuilder({
    store,
    retriever: new Retriever({ store, estimator }),
    estimator,
    // Rerank pinned off: a mechanism check, not a default.
    getSettings: () => ({ history: { recall: { rerank: { enabled: false } } } }),
    now: () => BASE_TIME + 10 * DAY,
    resolveScope: (chatId) => resolve(chatId)
  });
  const candidate = async (reader, id) => (await call(IPC.HISTORY_LINKS_GET, { chatId: reader })).candidates.find((c) => c.id === id);
  return { store, resolve, call, builder, candidate };
}

describe('the shipped scope policy', () => {
  it('needs a bridgeOriginFor', () => {
    assert.throws(() => createScopePolicy(), TypeError);
    assert.throws(() => createScopePolicy({ bridgeOriginFor: 'telegram' }), TypeError);
  });

  it('an ordinary chat is not pinned and reads ordinary chats by link and by "all"', () => {
    const { store, resolve } = setup();
    assert.strictEqual(resolve('a').pinned, null);
    store.setLinks('a', ['b']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b']);
    store.setHistoryScope('a', 'all');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'imp']);
  });

  it('R-H4-1: a case chat stored as "all" reads only itself', async () => {
    const { store, resolve, call } = setup();
    store.setHistoryScope('case', 'all');
    store.setLinks('case', ['b']);
    for (const requested of [null, 'all', 'linked', 'chat']) {
      const r = resolve('case', requested);
      assert.strictEqual(r.stored, 'all');
      assert.strictEqual(r.effective, 'chat');
      assert.deepStrictEqual(r.chatIds, ['case']);
      assert.strictEqual(r.pinned.reason, 'case-chat');
    }
    const view = await call(IPC.HISTORY_LINKS_GET, { chatId: 'case' });
    assert.deepStrictEqual([view.scope, view.effectiveScope, view.pinned], ['all', 'chat', 'case-chat']);
    for (const scope of ['linked', 'all']) {
      assert.deepStrictEqual(await call(IPC.HISTORY_SCOPE_SET, { chatId: 'case', scope }), {
        ok: false, error: 'A case chat recalls only from itself.', code: 'SCOPE_PINNED', reason: 'case-chat'
      });
    }
    assert.strictEqual(store.getHistoryScope('case'), 'all');
  });

  it('R-H4-1: a case chat is in no other chat\'s scope, by link or by "all"', async () => {
    const { store, resolve, call, candidate } = setup();
    assert.deepStrictEqual(await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['b', 'case'] }), {
      ok: false, error: 'That chat cannot be linked.', code: 'LINK_REFUSED', refused: [{ id: 'case', reason: 'case-chat' }]
    });
    assert.deepStrictEqual(store.getLinks('a'), []);
    assert.deepStrictEqual(await candidate('a', 'case'), { id: 'case', title: 'Lot sale', linked: false, allowed: false, reason: 'case-chat' });

    // A link stored before the chat got its case.
    store.setLinks('a', ['b']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b']);
    store.updateChat('b', { caseId: 'case-2' });
    const linked = resolve('a');
    assert.deepStrictEqual(linked.chatIds, ['a']);
    assert.deepStrictEqual(linked.excluded, [{ chatId: 'b', reason: 'case-chat' }]);
    assert.deepStrictEqual(await candidate('a', 'b'), { id: 'b', title: 'Lot notes', linked: true, allowed: false, reason: 'case-chat' });

    store.setHistoryScope('a', 'all');
    const all = resolve('a');
    assert.ok(!all.chatIds.includes('case') && !all.chatIds.includes('b'));
    assert.deepStrictEqual(all.chatIds, ['a', 'imp']);
  });

  it('R-H4-1: a chat given a case after its scope was widened reads only itself on its next turn', async () => {
    const { store, builder } = setup();
    store.setLinks('a', ['b']);
    store.setHistoryScope('a', 'linked');
    const before = await builder.build({ chatId: 'a', message: QUESTION, crossChat: true });
    assert.ok(before.recalled.text.includes('4417'));
    assert.deepStrictEqual(before.stats.recalledChats, ['b']);

    store.updateChat('a', { caseId: 'case-3' });
    for (const scope of ['linked', 'all']) {
      store.setHistoryScope('a', scope);
      const after = await builder.build({ chatId: 'a', message: QUESTION, crossChat: true });
      assert.ok(!(after.recalled.text || '').includes('4417'));
      assert.strictEqual(after.stats.scope, 'chat');
      assert.strictEqual(after.stats.scopeChats, 1);
      assert.deepStrictEqual(after.stats.recalledChats, []);
      assert.strictEqual(after.stats.scopePinned, 'case-chat');
    }
  });

  it('R-H4-2: an imported case-chat export is in no other chat\'s scope', async () => {
    const { store, resolve, call, candidate } = setup();
    const refused = await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['export'] });
    assert.deepStrictEqual([refused.code, refused.refused], ['LINK_REFUSED', [{ id: 'export', reason: 'imported-case-chat' }]]);
    assert.strictEqual((await candidate('a', 'export')).reason, 'imported-case-chat');
    store.setLinks('a', ['export']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a']);
    assert.deepStrictEqual(resolve('a').excluded, [{ chatId: 'export', reason: 'imported-case-chat' }]);
    store.setHistoryScope('a', 'all');
    assert.ok(!resolve('a').chatIds.includes('export'));

    // And it reads only itself (new question N3).
    store.setHistoryScope('export', 'all');
    const own = resolve('export');
    assert.deepStrictEqual([own.effective, own.chatIds, own.pinned.reason], ['chat', ['export'], 'imported-case-chat']);
    const set = await call(IPC.HISTORY_SCOPE_SET, { chatId: 'export', scope: 'linked' });
    assert.deepStrictEqual([set.code, set.error], ['SCOPE_PINNED', 'A chat imported from a case recalls only from itself.']);
  });

  it('R-H4-7: a bridge chat reads only itself', async () => {
    const { store, resolve, call } = setup();
    for (const id of ['tg', 'legacy']) {
      store.setHistoryScope(id, 'all');
      store.setLinks(id, ['b']);
      const r = resolve(id);
      assert.deepStrictEqual([r.stored, r.effective, r.chatIds, r.pinned.reason], ['all', 'chat', [id], 'bridge-chat'], id);
      const set = await call(IPC.HISTORY_SCOPE_SET, { chatId: id, scope: 'linked' });
      assert.deepStrictEqual([set.code, set.error], ['SCOPE_PINNED', 'A Telegram or Discord chat recalls only from itself.']);
    }
  });

  it('R-H4-7: a bridge chat is left out of "all" unless linked, and can be linked', async () => {
    const { store, resolve, call, candidate } = setup();
    store.setHistoryScope('a', 'all');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'imp']);
    for (const id of ['tg', 'legacy']) assert.strictEqual((await candidate('a', id)).allowed, true, id);

    const saved = await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['tg', 'legacy'] });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(saved.links.map((l) => l.id), ['tg', 'legacy']);
    // Owner ruling 2026-10-13: under "all" the chat's own links count as
    // explicit, so a linked bridge chat is read there too (list order).
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'tg', 'legacy', 'imp']);
    assert.deepStrictEqual(resolve('a', 'all').chatIds, ['a', 'b', 'tg', 'legacy', 'imp']);
    assert.deepStrictEqual(resolve('a', 'linked').chatIds, ['a', 'tg', 'legacy']);
    // One link: the other bridge chat stays out of "all".
    store.setLinks('a', ['tg']);
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'tg', 'imp']);
    // The bridge chat itself still reads itself only.
    store.setHistoryScope('tg', 'all');
    store.setLinks('tg', ['a']);
    assert.deepStrictEqual([resolve('tg').effective, resolve('tg').chatIds], ['chat', ['tg']]);
    store.setLinks('a', ['tg', 'legacy']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'tg', 'legacy']);
    assert.deepStrictEqual(resolve('a').excluded, []);
  });

  it('under "all" a link never brings in a case chat or a case export', () => {
    const { store, resolve } = setup();
    store.setHistoryScope('a', 'all');
    store.setLinks('a', ['case', 'export', 'tg']);
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'tg', 'imp']);
    // A bridge chat with a case is a case chat: linked or not, it stays out.
    store.updateChat('tg', { caseId: 'case-9' });
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'b', 'imp']);
  });

  it('a case or an export mark wins over a bridge origin, linked or not', () => {
    const { store, resolve } = setup();
    store.updateChat('tg', { caseId: 'case-9' });
    store.setLinks('a', ['tg']);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').excluded, [{ chatId: 'tg', reason: 'case-chat' }]);
    assert.strictEqual(resolve('tg').pinned.reason, 'case-chat');
  });

  it('an imported chat with no case mark reads and is read like any chat', async () => {
    const { store, resolve, call, candidate } = setup();
    assert.deepStrictEqual(await candidate('a', 'imp'), { id: 'imp', title: 'Imported session', linked: false, allowed: true, reason: null });
    assert.strictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['imp'] })).ok, true);
    store.setHistoryScope('a', 'linked');
    assert.deepStrictEqual(resolve('a').chatIds, ['a', 'imp']);

    assert.strictEqual(resolve('imp').pinned, null);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'imp', linkedChatIds: ['b'] })).ok, true);
    assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { chatId: 'imp', scope: 'linked' })).ok, true);
    assert.deepStrictEqual(resolve('imp').chatIds, ['imp', 'b']);
  });
});
