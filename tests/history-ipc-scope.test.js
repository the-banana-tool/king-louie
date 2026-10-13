// tests/history-ipc-scope.test.js
// history:scope.set and history:links.get/set (recall spec §6.3, stage H4):
// the only way a chat's history scope is widened.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { resolveScope } = require('../src/history/scope');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const PINS = { 'pin-case': 'case-chat', 'pin-bridge': 'bridge-chat', 'pin-import': 'imported-case-chat', 'pin-other': 'something-new' };
const SENTENCES = {
  'pin-case': 'A case chat recalls only from itself.',
  'pin-bridge': 'A Telegram or Discord chat recalls only from itself.',
  'pin-import': 'A chat imported from a case recalls only from itself.',
  'pin-other': 'This chat recalls only from itself.'
};

describe('history IPC: scope and links', () => {
  let t;
  let asked;
  let sent;
  const handlers = new Map();
  const sender = { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
  const call = (channel, payload) => handlers.get(channel)({ sender }, payload);
  const policy = {
    pinnedTo: (reader) => (PINS[reader.id] ? { scope: 'chat', reason: PINS[reader.id] } : null),
    canRead: (reader, source, opts) => {
      asked.push([reader.id, source.id, opts.explicit]);
      return source.id === 'closed' ? 'case-chat' : true;
    }
  };

  before(() => {
    t = openTempStore();
    // seedChat puts a new chat at the front: list order is the reverse.
    for (const id of Object.keys(PINS)) seedChat(t.store, { id, title: `Pinned ${id}` });
    seedChat(t.store, { id: 'closed', title: 'Closed notes' });
    seedChat(t.store, { id: 'c', title: 'Garden <b>plan</b>' });
    seedChat(t.store, { id: 'b', title: 'Lot notes', messages: [{ sender: 'user', text: GATE }] });
    seedChat(t.store, { id: 'a', title: 'Asking chat', messages: [{ sender: 'user', text: 'What is the gate code?' }] });
    const estimator = new TokenEstimator();
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      getHistoryStore: () => t.store,
      getHistoryRetriever: () => new Retriever({ store: t.store, estimator }),
      getSettings: () => ({}),
      getHistoryScopePolicy: () => policy,
      resolveHistoryScope: (chatId, requested = null) => resolveScope({ store: t.store, chatId, requested, policy })
    });
  });
  after(() => t.cleanup());
  beforeEach(() => {
    asked = [];
    sent = [];
    t.store.setHistoryScope('a', 'chat');
    t.store.setLinks('a', []);
  });

  it('history:links.get gives the stored scope, the links and every other chat as a candidate', async () => {
    t.store.setLinks('a', ['b']);
    const out = await call(IPC.HISTORY_LINKS_GET, { chatId: 'a' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.strictEqual(out.scope, 'chat');
    assert.strictEqual(out.effectiveScope, 'chat');
    assert.strictEqual(out.pinned, null);
    assert.deepStrictEqual(out.links, [{ id: 'b', title: 'Lot notes' }]);
    assert.deepStrictEqual(out.candidates.slice(0, 3), [
      { id: 'b', title: 'Lot notes', linked: true, allowed: true, reason: null },
      { id: 'c', title: 'Garden <b>plan</b>', linked: false, allowed: true, reason: null },
      { id: 'closed', title: 'Closed notes', linked: false, allowed: false, reason: 'case-chat' }
    ]);
    assert.strictEqual(out.candidates.length, 7);
    assert.ok(!out.candidates.some((c) => c.id === 'a'));
    // Candidates are asked as links: explicit.
    assert.ok(asked.length > 0 && asked.every(([reader, , explicit]) => reader === 'a' && explicit === true));
  });

  it('history:scope.set stores the scope, tells the renderer and returns the view', async () => {
    t.store.setLinks('a', ['b']);
    const out = await call(IPC.HISTORY_SCOPE_SET, { chatId: 'a', scope: 'linked' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.strictEqual(out.scope, 'linked');
    assert.strictEqual(out.effectiveScope, 'linked');
    assert.deepStrictEqual(out.links, [{ id: 'b', title: 'Lot notes' }]);
    assert.strictEqual(t.store.getHistoryScope('a'), 'linked');
    assert.deepStrictEqual(sent, [['chat:updated', { chatId: 'a' }]]);
    assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { chatId: 'a', scope: 'all' })).scope, 'all');
    assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { chatId: 'a', scope: 'chat' })).scope, 'chat');
  });

  it('history:scope.set refuses a value outside the three, and an unknown chat', async () => {
    for (const scope of ['everything', '', null, undefined, 3, ['all'], { scope: 'all' }]) {
      const out = await call(IPC.HISTORY_SCOPE_SET, { chatId: 'a', scope });
      assert.strictEqual(out.ok, false, JSON.stringify(scope));
      assert.ok(out.error);
    }
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
    assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { chatId: 'nobody', scope: 'all' })).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { scope: 'all' })).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_GET, { chatId: 'nobody' })).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_GET, {})).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'nobody', linkedChatIds: [] })).ok, false);
    assert.deepStrictEqual(sent, []);
  });

  it('history:scope.set refuses a scope wider than the pin, with a sentence per reason', async () => {
    for (const [id, reason] of Object.entries(PINS)) {
      for (const scope of ['linked', 'all']) {
        const out = await call(IPC.HISTORY_SCOPE_SET, { chatId: id, scope });
        assert.deepStrictEqual(out, { ok: false, error: SENTENCES[id], code: 'SCOPE_PINNED', reason });
      }
      assert.strictEqual(t.store.getHistoryScope(id), 'chat');
      const view = await call(IPC.HISTORY_LINKS_GET, { chatId: id });
      assert.strictEqual(view.pinned, reason);
      assert.strictEqual(view.effectiveScope, 'chat');
      // Narrowing is never refused.
      assert.strictEqual((await call(IPC.HISTORY_SCOPE_SET, { chatId: id, scope: 'chat' })).ok, true);
    }
  });

  it('history:links.set stores the links and leaves the scope alone', async () => {
    const out = await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['c', 'b', 'b', 'a', 'gone'] });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.deepStrictEqual(out.links, [{ id: 'b', title: 'Lot notes' }, { id: 'c', title: 'Garden <b>plan</b>' }]);
    assert.strictEqual(out.scope, 'chat');
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
    assert.deepStrictEqual(t.store.getLinks('a'), ['b', 'c']);
    assert.deepStrictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: [] })).links, []);
  });

  it('history:links.set refuses a chat the policy refuses, and stores nothing', async () => {
    t.store.setLinks('a', ['b']);
    const out = await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['c', 'closed'] });
    assert.deepStrictEqual(out, {
      ok: false, error: 'That chat cannot be linked.', code: 'LINK_REFUSED', refused: [{ id: 'closed', reason: 'case-chat' }]
    });
    assert.deepStrictEqual(t.store.getLinks('a'), ['b']);
  });

  it('history:links.set refuses a non-array, more than 200 entries and a non-string entry', async () => {
    t.store.setLinks('a', ['b']);
    const many = Array.from({ length: 201 }, (_, i) => `x-${i}`);
    for (const linkedChatIds of [undefined, null, 'b', { 0: 'b', length: 1 }, many, ['b', 7], ['b', null], ['b', '']]) {
      const out = await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds });
      assert.strictEqual(out.ok, false);
      assert.ok(out.error);
    }
    assert.deepStrictEqual(t.store.getLinks('a'), ['b']);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: Array.from({ length: 200 }, (_, i) => `x-${i}`) })).ok, true);
  });

  it('a deleted chat disappears from the links and the candidates', async () => {
    seedChat(t.store, { id: 'temp', title: 'Short lived' });
    t.store.setLinks('a', ['b', 'temp']);
    assert.strictEqual((await call(IPC.HISTORY_LINKS_GET, { chatId: 'a' })).links.length, 2);
    t.store.deleteChat('temp');
    const out = await call(IPC.HISTORY_LINKS_GET, { chatId: 'a' });
    assert.deepStrictEqual(out.links, [{ id: 'b', title: 'Lot notes' }]);
    assert.ok(!out.candidates.some((c) => c.id === 'temp'));
  });

  it('history:search follows the scope of the chat and names the other chat', async () => {
    const alone = await call(IPC.HISTORY_SEARCH, { chatId: 'a', query: 'Lakeside gate code', limit: 5 });
    assert.strictEqual(alone.ok, true);
    assert.ok(!alone.excerpts.some((e) => e.text.includes('4417')));
    assert.ok(alone.excerpts.every((e) => !('chatId' in e) && !('chatTitle' in e)));

    t.store.setLinks('a', ['b']);
    t.store.setHistoryScope('a', 'linked');
    const out = await call(IPC.HISTORY_SEARCH, { chatId: 'a', query: 'Lakeside gate code', limit: 5 });
    assert.strictEqual(out.untrustedText, true);
    const hit = out.excerpts.find((e) => e.text.includes('4417'));
    assert.ok(hit);
    assert.strictEqual(hit.chatId, 'b');
    assert.strictEqual(hit.chatTitle, 'Lot notes');
    assert.ok(hit.header.startsWith('[chat "Lot notes" · #1 · user · '));
    const own = out.excerpts.find((e) => !e.text.includes('4417'));
    if (own) assert.ok(!('chatId' in own));
  });
});

describe('history IPC: scope and links without a resolver', () => {
  let t;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  before(() => {
    t = openTempStore();
    seedChat(t.store, { id: 'b', title: 'Lot notes' });
    seedChat(t.store, { id: 'a', title: 'Asking chat' });
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, { getHistoryStore: () => t.store });
  });
  after(() => t.cleanup());

  it('a host with no policy widens nothing and links nothing', async () => {
    const view = await call(IPC.HISTORY_LINKS_GET, { chatId: 'a' });
    assert.strictEqual(view.ok, true);
    assert.strictEqual(view.pinned, 'no-policy');
    assert.deepStrictEqual(view.candidates, [{ id: 'b', title: 'Lot notes', linked: false, allowed: false, reason: 'no-policy' }]);
    const set = await call(IPC.HISTORY_SCOPE_SET, { chatId: 'a', scope: 'all' });
    assert.strictEqual(set.code, 'SCOPE_PINNED');
    assert.strictEqual(set.error, 'This chat recalls only from itself.');
    assert.strictEqual((await call(IPC.HISTORY_LINKS_SET, { chatId: 'a', linkedChatIds: ['b'] })).code, 'LINK_REFUSED');
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
    assert.deepStrictEqual(t.store.getLinks('a'), []);
  });
});
