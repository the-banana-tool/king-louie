// tests/history-scope.test.js
// resolveScope (recall spec §6.3, stage H4): a chat's stored scope, its links
// and a policy give the chats a turn may read. Nothing else decides it.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { openTempStore, seedChat, isoAt } = require('./helpers/history-fixture');
const { SCOPES, narrowest, resolveScope, OPEN_POLICY, CLOSED_POLICY } = require('../src/history/scope');
const history = require('../src/history');

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// List order: a, b, c, d, e (a new chat goes to the front). c is a case
// chat, d a Telegram chat, e an imported one.
function seeded() {
  t = openTempStore();
  const { store } = t;
  const chat = (id, extra) => store.createChat({ id, title: `Chat ${id.toUpperCase()}`, createdAt: isoAt(0), updatedAt: isoAt(0), messages: [], ...extra });
  chat('e', { source: 'claude-code-jsonl' });
  chat('d', { origin: 'telegram' });
  seedChat(store, { id: 'c', title: 'Chat C', caseId: 'case-1', messages: [{ sender: 'user', text: 'the Lakeside lot' }] });
  chat('b');
  chat('a');
  return store;
}

const casePins = { pinnedTo: (r) => (r.caseId ? { scope: 'chat', reason: 'case-chat' } : null), canRead: () => true };

describe('resolveScope', () => {
  it('names the scopes narrowest first', () => {
    assert.deepStrictEqual([...SCOPES], ['chat', 'linked', 'all']);
    assert.strictEqual(narrowest('all', 'linked'), 'linked');
    assert.strictEqual(narrowest('chat', 'all'), 'chat');
    assert.strictEqual(narrowest('linked', 'linked'), 'linked');
    assert.strictEqual(narrowest('all', 'bogus'), 'chat');
    assert.strictEqual(history.resolveScope, resolveScope);
    assert.strictEqual(history.OPEN_POLICY, OPEN_POLICY);
  });

  it('defaults to the chat itself', () => {
    const store = seeded();
    const r = resolveScope({ store, chatId: 'a' });
    assert.strictEqual(r.stored, 'chat');
    assert.strictEqual(r.effective, 'chat');
    assert.deepStrictEqual(r.chatIds, ['a']);
    assert.strictEqual(r.pinned, null);
    assert.deepStrictEqual(r.excluded, []);
  });

  it('linked gives the chat and its links, and follows a deleted chat', () => {
    const store = seeded();
    store.setHistoryScope('a', 'linked');
    store.setLinks('a', ['b', 'c']);
    assert.deepStrictEqual(resolveScope({ store, chatId: 'a' }).chatIds, ['a', 'b', 'c']);
    store.deleteChat('b');
    const r = resolveScope({ store, chatId: 'a' });
    assert.deepStrictEqual(r.chatIds, ['a', 'c']);
    assert.strictEqual(r.effective, 'linked');
  });

  it('all gives every chat, the asking chat first', () => {
    const store = seeded();
    store.setHistoryScope('b', 'all');
    const r = resolveScope({ store, chatId: 'b' });
    assert.strictEqual(r.effective, 'all');
    assert.deepStrictEqual(r.chatIds, ['b', 'a', 'c', 'd', 'e']);
  });

  it('a requested scope only narrows', () => {
    const store = seeded();
    store.setHistoryScope('a', 'all');
    store.setLinks('a', ['c']);
    assert.deepStrictEqual(resolveScope({ store, chatId: 'a', requested: 'chat' }).chatIds, ['a']);
    const linked = resolveScope({ store, chatId: 'a', requested: 'linked' });
    assert.strictEqual(linked.effective, 'linked');
    assert.strictEqual(linked.stored, 'all');
    assert.deepStrictEqual(linked.chatIds, ['a', 'c']);
    const bogus = resolveScope({ store, chatId: 'a', requested: 'bogus' });
    assert.strictEqual(bogus.effective, 'all');
    assert.strictEqual(bogus.chatIds.length, 5);
    for (const requested of [{ scope: 'all' }, ['all'], 7, '']) {
      assert.strictEqual(resolveScope({ store, chatId: 'a', requested }).effective, 'all');
    }

    const wide = resolveScope({ store, chatId: 'b', requested: 'all' });
    assert.strictEqual(wide.effective, 'chat');
    assert.deepStrictEqual(wide.chatIds, ['b']);
  });

  it('a pin caps the stored scope and keeps what was stored', () => {
    const store = seeded();
    store.setHistoryScope('c', 'all');
    store.setLinks('c', ['a']);
    const r = resolveScope({ store, chatId: 'c', policy: casePins });
    assert.strictEqual(r.stored, 'all');
    assert.strictEqual(r.effective, 'chat');
    assert.deepStrictEqual(r.chatIds, ['c']);
    assert.strictEqual(r.pinned.reason, 'case-chat');
    // The same policy leaves an ordinary chat alone.
    store.setHistoryScope('a', 'all');
    assert.strictEqual(resolveScope({ store, chatId: 'a', policy: casePins }).chatIds.length, 5);
  });

  it('a refused source is left out of all silently and out of linked with a reason', () => {
    const store = seeded();
    const calls = [];
    const policy = {
      pinnedTo: () => null,
      canRead: (reader, source, options) => {
        calls.push({ reader: reader.id, source: source.id, explicit: options.explicit });
        return source.caseId ? 'case-chat' : true;
      }
    };
    store.setHistoryScope('a', 'all');
    const all = resolveScope({ store, chatId: 'a', policy });
    assert.deepStrictEqual(all.chatIds, ['a', 'b', 'd', 'e']);
    assert.deepStrictEqual(all.excluded, []);
    assert.ok(calls.length && calls.every((c) => c.explicit === false && c.reader === 'a'));

    calls.length = 0;
    store.setHistoryScope('a', 'linked');
    store.setLinks('a', ['b', 'c']);
    const linked = resolveScope({ store, chatId: 'a', policy });
    assert.deepStrictEqual(linked.chatIds, ['a', 'b']);
    assert.deepStrictEqual(linked.excluded, [{ chatId: 'c', reason: 'case-chat' }]);
    assert.deepStrictEqual(calls, [{ reader: 'a', source: 'b', explicit: true }, { reader: 'a', source: 'c', explicit: true }]);
  });

  it('a policy answer that is not exactly true refuses', () => {
    const store = seeded();
    store.setHistoryScope('a', 'linked');
    store.setLinks('a', ['b']);
    for (const answer of [false, undefined, null, 1, '']) {
      const r = resolveScope({ store, chatId: 'a', policy: { pinnedTo: () => null, canRead: () => answer } });
      assert.deepStrictEqual(r.chatIds, ['a']);
      assert.strictEqual(r.excluded.length, 1);
      assert.strictEqual(typeof r.excluded[0].reason, 'string');
    }
  });

  it('a pin that names no known scope pins to the chat', () => {
    const store = seeded();
    store.setHistoryScope('a', 'all');
    const r = resolveScope({ store, chatId: 'a', policy: { pinnedTo: () => ({ scope: 'everything', reason: 'odd' }), canRead: () => true } });
    assert.strictEqual(r.effective, 'chat');
    assert.deepStrictEqual(r.chatIds, ['a']);
  });

  it('titles and refs cover every chat in scope', () => {
    const store = seeded();
    store.setHistoryScope('a', 'all');
    const r = resolveScope({ store, chatId: 'a' });
    assert.deepStrictEqual([...r.titles.keys()], r.chatIds);
    assert.strictEqual(r.titles.get('c'), 'Chat C');
    assert.deepStrictEqual(r.refs.map((ref) => ref.id), r.chatIds);
    assert.strictEqual(r.refs.find((ref) => ref.id === 'c').caseId, 'case-1');
    assert.strictEqual(r.refs.find((ref) => ref.id === 'd').origin, 'telegram');
    assert.strictEqual(r.refs.find((ref) => ref.id === 'e').source, 'claude-code-jsonl');
  });

  it('an unknown chat resolves to itself alone', () => {
    const store = seeded();
    const r = resolveScope({ store, chatId: 'missing', requested: 'all' });
    assert.deepStrictEqual({ ...r, titles: [...r.titles] }, { stored: 'chat', effective: 'chat', chatIds: ['missing'], titles: [], refs: [], pinned: null, excluded: [] });
  });

  it('reads what is stored now, every time', () => {
    const store = seeded();
    store.setHistoryScope('a', 'linked');
    store.setLinks('a', ['b']);
    assert.deepStrictEqual(resolveScope({ store, chatId: 'a', policy: casePins }).chatIds, ['a', 'b']);
    store.updateChat('a', { caseId: 'case-2' });
    assert.deepStrictEqual(resolveScope({ store, chatId: 'a', policy: casePins }).chatIds, ['a']);
  });

  it('the closed policy lets every chat read itself only', () => {
    const store = seeded();
    store.setHistoryScope('a', 'all');
    store.setLinks('a', ['b']);
    const r = resolveScope({ store, chatId: 'a', policy: CLOSED_POLICY });
    assert.strictEqual(r.effective, 'chat');
    assert.deepStrictEqual(r.chatIds, ['a']);
    assert.strictEqual(CLOSED_POLICY.canRead({ id: 'a' }, { id: 'b' }, { explicit: true }), 'no-policy');
  });
});
