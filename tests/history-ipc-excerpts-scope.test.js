// tests/history-ipc-excerpts-scope.test.js
// history:excerpts (the recall line's drawer) asks the chat's scope as it is
// now (stage H4 review, finding 4; built the cautious way, the owner may
// overrule): an excerpt of another chat that the asking chat may no longer
// read comes back hidden, with none of its text, header or chat. Excerpts of
// the asking chat itself are what they were.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { resolveScope } = require('../src/history/scope');
const { createScopePolicy } = require('../src/history/scope-policy');
const { bridgeOriginFor } = require('../src/history/bridge-origin');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat, isoAt } = require('./helpers/history-fixture');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const OWN = 'The fence along the Lakeside lot is forty meters.';
const HIDDEN = { hidden: true };

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// Chat a (linked to b, scoped "linked") holds a reply at seq 3 that recalled
// one chunk of its own first message and one of chat b.
function setup({ withResolver = true } = {}) {
  t = openTempStore();
  const { store } = t;
  seedChat(store, { id: 'b', title: 'Lot notes', messages: [{ sender: 'user', text: GATE }] });
  seedChat(store, { id: 'a', title: 'Asking chat', messages: [{ sender: 'user', text: OWN }, { sender: 'user', text: 'What is the gate code?' }] });
  store.setLinks('a', ['b']);
  store.setHistoryScope('a', 'linked');
  const chunkIds = [...store.chunksOfMessage('a-m1'), ...store.chunksOfMessage('b-m1')].map((c) => c.id);
  assert.strictEqual(chunkIds.length, 2, 'precondition: one chunk each');
  store.appendMessage('a', {
    id: 'a-m3', sender: 'assistant', text: 'The code is 4417.', timestamp: isoAt(5000),
    context: { recalledChunkIds: chunkIds, recalledExcerpts: 2, recalledChats: ['b'], scope: 'linked' }
  }, { updatedAt: isoAt(5000) });
  const policy = createScopePolicy({ bridgeOriginFor });
  const handlers = new Map();
  const estimator = new TokenEstimator();
  registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    getHistoryStore: () => store,
    getHistoryRetriever: () => new Retriever({ store, estimator }),
    getSettings: () => ({}),
    ...(withResolver ? {
      getHistoryScopePolicy: () => policy,
      resolveHistoryScope: (chatId, requested = null) => resolveScope({ store, chatId, requested, policy })
    } : {})
  });
  const excerpts = async () => {
    const out = await handlers.get(IPC.HISTORY_EXCERPTS)({}, { chatId: 'a', seq: 3 });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    return out.excerpts;
  };
  return { store, excerpts };
}

const shown = (list) => list.filter((e) => !e.hidden);
const leaks = (list) => /4417|Lot notes|side gate/.test(JSON.stringify(list));

describe('history:excerpts follows the scope as it is now', () => {
  it('while the other chat is readable, its excerpt is shown under its title', async () => {
    const { excerpts } = setup();
    const list = await excerpts();
    assert.strictEqual(list.length, 2);
    assert.ok(list.every((e) => !('hidden' in e)));
    assert.strictEqual(list[0].text, OWN);
    assert.match(list[1].header, /^\[chat "Lot notes" · #1 · /);
    assert.strictEqual(list[1].text, GATE);
  });

  it('finding 4: once the other chat has a case its excerpt is hidden, and this chat\'s own is unchanged', async () => {
    const { store, excerpts } = setup();
    const before = await excerpts();
    store.updateChat('b', { caseId: 'case-lakeside' });
    const list = await excerpts();
    assert.strictEqual(list.length, 2, 'the hidden excerpt keeps its place');
    assert.deepStrictEqual(list[0], before[0]);
    assert.deepStrictEqual(list[1], HIDDEN);
    assert.ok(!leaks(list), 'no text, header or title of the other chat');
  });

  it('hidden too when the chat was unlinked, when the scope went back to "chat", and when the other chat became a case export or was deleted', async () => {
    const changes = {
      unlinked: (store) => store.setLinks('a', []),
      'scope chat': (store) => store.setHistoryScope('a', 'chat'),
      'case export': (store) => store.updateChat('b', { source: 'king-louie-json', importedFromCase: true })
    };
    for (const [label, change] of Object.entries(changes)) {
      const { store, excerpts } = setup();
      change(store);
      const list = await excerpts();
      assert.deepStrictEqual(list[1], HIDDEN, label);
      assert.strictEqual(shown(list).length, 1, label);
      assert.strictEqual(shown(list)[0].text, OWN, label);
      assert.ok(!leaks(list), label);
      t.cleanup();
      t = null;
    }
    // A deleted chat has no chunks left: nothing of it comes back at all.
    const { store, excerpts } = setup();
    store.deleteChat('b');
    const list = await excerpts();
    assert.ok(!leaks(list));
    assert.strictEqual(shown(list).length, 1);
  });

  it('linked again, it shows again: nothing is stored about the hiding', async () => {
    const { store, excerpts } = setup();
    store.setLinks('a', []);
    assert.deepStrictEqual((await excerpts())[1], HIDDEN);
    store.setLinks('a', ['b']);
    assert.strictEqual((await excerpts())[1].text, GATE);
  });

  it('a host with no scope resolver shows no other chat', async () => {
    const { excerpts } = setup({ withResolver: false });
    const list = await excerpts();
    assert.deepStrictEqual(list[1], HIDDEN);
    assert.strictEqual(list[0].text, OWN);
  });
});
