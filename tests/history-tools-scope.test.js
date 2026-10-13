// tests/history-tools-scope.test.js
// SearchHistory and ReadHistory within the chat's history scope (recall spec
// §8, §15, stage H4): the scope is what the store holds, a scope argument
// only narrows, and a chat outside the scope is refused and never read.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { initializeTools, toolRegistry } = require('../src/tools');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { resolveScope, OPEN_POLICY } = require('../src/history/scope');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

initializeTools();

const VALUE = 'pin-8842-lakeside';
const B_MESSAGES = [
  { sender: 'user', text: 'The gate code for the Lakeside lot is 4417.' },
  { sender: 'assistant', text: 'Noted for the Lakeside lot.' },
  { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'retrieve', key: 'gate_pin' } },
  { sender: 'toolResult', toolName: 'Vault', result: { ok: true, key: 'gate_pin', value: VALUE }, text: `value ${VALUE}` }
];

let t;
afterEach(() => { if (t) t.cleanup(); t = null; });

// List order a, b, c. reads records every chat a message or a count was read from.
function setup({ policy = OPEN_POLICY, withScope = true, bTitle = 'Lot notes' } = {}) {
  t = openTempStore();
  const { store } = t;
  seedChat(store, { id: 'c', title: 'Dock notes', messages: [{ sender: 'user', text: 'The dock gate code is 9001.' }] });
  seedChat(store, { id: 'b', title: bTitle, messages: B_MESSAGES });
  seedChat(store, { id: 'a', title: 'Asking chat', messages: [
    { sender: 'user', text: 'The fence along the Lakeside lot is forty meters.' },
    { sender: 'assistant', text: 'Noted.' }
  ] });
  const reads = [];
  for (const method of ['getMessages', 'lastSeq']) {
    const real = store[method].bind(store);
    store[method] = (chatId, ...rest) => { reads.push(String(chatId)); return real(chatId, ...rest); };
  }
  const estimator = new TokenEstimator();
  const history = {
    chatId: 'a', store, retriever: new Retriever({ store, estimator }), estimator,
    getSettings: () => ({ history: { recall: { rerank: { enabled: false, search: false } } } }),
    ...(withScope ? { resolveScope: (chatId, requested) => resolveScope({ store, chatId, requested, policy }) } : {})
  };
  const search = (params) => toolRegistry.get('SearchHistory').execute(params, { history });
  const read = (params) => toolRegistry.get('ReadHistory').execute(params, { history });
  return { store, history, search, read, reads };
}

const from = (out, chatId) => out.excerpts.filter((e) => e.chatId === chatId);

describe('history tools within the history scope', () => {
  it('a chat scoped "chat": a wider scope argument changes nothing and says so', async () => {
    const s = setup();
    s.store.setLinks('a', ['b']);
    for (const scope of ['all', 'linked']) {
      const out = await s.search({ query: 'gate code', scope });
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.scope, 'chat');
      assert.ok(out.excerpts.every((e) => !('chatId' in e) && !e.text.includes('4417') && !e.text.includes('9001')));
      assert.match(out.note, /This chat's history scope is "chat"; only the owner can widen it in the app\./);
    }
    const plain = await s.search({ query: 'fence' });
    assert.strictEqual(plain.scope, 'chat');
    assert.strictEqual(plain.note, undefined);
    assert.strictEqual((await s.search({ query: 'fence', scope: 'chat' })).note, undefined);
    assert.strictEqual((await s.search({ query: 'zebra' })).note, 'No matches in this chat. Try other words, or ReadHistory for a range.');
  });

  it('a chat scoped "chat": ReadHistory of another chat is refused and reads nothing', async () => {
    const s = setup();
    s.store.setLinks('a', ['b']);
    s.reads.length = 0;
    const out = await s.read({ chatId: 'b', fromSeq: 1, toSeq: 2 });
    assert.deepStrictEqual(out, { ok: false, error: 'ReadHistory can read only chats in this chat\'s history scope ("chat").' });
    assert.ok(!s.reads.includes('b'), 'no row and no count of the other chat was read');
    for (const chatId of ['missing', { id: 'b' }, ['b'], 7]) {
      assert.strictEqual((await s.read({ chatId, fromSeq: 1, toSeq: 1 })).ok, false);
    }
    assert.ok(!s.reads.includes('b'));
  });

  it('a chat scoped "linked": SearchHistory returns the linked chat under its id and title', async () => {
    const s = setup();
    s.store.setHistoryScope('a', 'linked');
    s.store.setLinks('a', ['b']);
    const out = await s.search({ query: 'gate code Lakeside lot' });
    assert.strictEqual(out.scope, 'linked');
    const linked = from(out, 'b');
    assert.ok(linked.length >= 1);
    assert.ok(linked.some((e) => e.text.includes('4417')));
    for (const e of linked) {
      assert.strictEqual(e.chatTitle, 'Lot notes');
      assert.ok(e.header.startsWith(`[chat "Lot notes" · #${e.seq} · `));
    }
    // This chat's own excerpts name no chat; an unlinked chat is not searched.
    const own = out.excerpts.filter((e) => e.text.includes('forty meters'));
    assert.ok(own.length === 1 && !('chatId' in own[0]) && !('chatTitle' in own[0]));
    assert.ok(!out.excerpts.some((e) => e.text.includes('9001')));
    assert.strictEqual(out.note, undefined);

    const narrowed = await s.search({ query: 'gate code Lakeside lot', scope: 'chat' });
    assert.strictEqual(narrowed.scope, 'chat');
    assert.deepStrictEqual(from(narrowed, 'b'), []);
    assert.strictEqual(narrowed.note, undefined);
    const wider = await s.search({ query: 'gate code', scope: 'all' });
    assert.strictEqual(wider.scope, 'linked');
    assert.ok(!wider.excerpts.some((e) => e.text.includes('9001')));
    assert.match(wider.note, /history scope is "linked"/);
    assert.match((await s.search({ query: 'zebra' })).note, /^No matches in this chat or the chats linked to it\./);
  });

  it('a chat scoped "linked": ReadHistory reads the linked chat and refuses any other', async () => {
    const s = setup();
    s.store.setHistoryScope('a', 'linked');
    s.store.setLinks('a', ['b']);
    const out = await s.read({ chatId: 'b', fromSeq: 1, toSeq: 2 });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.chatId, 'b');
    assert.strictEqual(out.chatTitle, 'Lot notes');
    assert.deepStrictEqual([out.fromSeq, out.toSeq], [1, 2]);
    const blocks = out.text.split('\n\n');
    assert.strictEqual(blocks.length, 2);
    assert.match(blocks[0], /^\[chat "Lot notes" · #1 · user · [^\]]+\]\nThe gate code for the Lakeside lot is 4417\.$/);
    assert.match(blocks[1], /^\[chat "Lot notes" · #2 · assistant · /);
    assert.match((await s.read({ chatId: 'b', fromSeq: 9, toSeq: 9 })).error, /That chat has 4 messages/);

    s.reads.length = 0;
    const refused = await s.read({ chatId: 'c', fromSeq: 1, toSeq: 1 });
    assert.deepStrictEqual(refused, { ok: false, error: 'ReadHistory can read only chats in this chat\'s history scope ("linked").' });
    assert.ok(!s.reads.includes('c'));

    // This chat reads as before: its own id, no title, plain headers.
    const own = await s.read({ fromSeq: 1, toSeq: 1 });
    assert.strictEqual(own.chatId, 'a');
    assert.ok(!('chatTitle' in own));
    assert.match(own.text, /^\[#1 · user · /);
    assert.strictEqual((await s.read({ chatId: 'a', fromSeq: 1, toSeq: 1 })).text, own.text);
  });

  it('the scope is what is stored when the tool runs', async () => {
    const s = setup();
    s.store.setHistoryScope('a', 'linked');
    s.store.setLinks('a', ['b']);
    assert.strictEqual((await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, true);
    s.store.setLinks('a', []);
    assert.strictEqual((await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
    assert.deepStrictEqual(from(await s.search({ query: 'gate code Lakeside lot' }), 'b'), []);
    s.store.setLinks('a', ['b']);
    s.store.deleteChat('b');
    assert.strictEqual((await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
  });

  it('a chat scoped "all": "linked" searches the links only', async () => {
    const s = setup();
    s.store.setHistoryScope('a', 'all');
    s.store.setLinks('a', ['b']);
    const all = await s.search({ query: 'gate code' });
    assert.strictEqual(all.scope, 'all');
    assert.ok(from(all, 'b').length >= 1 && from(all, 'c').length >= 1);
    assert.strictEqual(from(all, 'c')[0].chatTitle, 'Dock notes');
    const linked = await s.search({ query: 'gate code', scope: 'linked' });
    assert.strictEqual(linked.scope, 'linked');
    assert.ok(from(linked, 'b').length >= 1);
    assert.deepStrictEqual(from(linked, 'c'), []);
    assert.strictEqual(linked.note, undefined);
    assert.strictEqual((await s.search({ query: 'gate code', scope: 'bogus' })).scope, 'all');
    assert.match((await s.search({ query: 'zebra' })).note, /^No matches in any chat this chat may read\./);
    assert.strictEqual((await s.read({ chatId: 'c', fromSeq: 1, toSeq: 1 })).ok, true);
  });

  it('a chat the policy keeps out is neither searched nor read', async () => {
    const policy = { pinnedTo: () => null, canRead: (reader, source) => (source.id === 'b' ? 'case-chat' : true) };
    const s = setup({ policy });
    s.store.setHistoryScope('a', 'all');
    s.store.setLinks('a', ['b']);
    const out = await s.search({ query: 'gate code' });
    assert.deepStrictEqual(from(out, 'b'), []);
    assert.ok(from(out, 'c').length >= 1);
    s.reads.length = 0;
    assert.strictEqual((await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
    assert.ok(!s.reads.includes('b'));
    // A pinned chat reads only itself.
    const pinned = setup({ policy: { pinnedTo: () => ({ scope: 'chat', reason: 'case-chat' }), canRead: () => true } });
    pinned.store.setHistoryScope('a', 'all');
    assert.strictEqual((await pinned.search({ query: 'gate code' })).scope, 'chat');
    assert.strictEqual((await pinned.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
  });

  it('a Vault call in another chat shows its action and key only', async () => {
    const s = setup();
    s.store.setHistoryScope('a', 'linked');
    s.store.setLinks('a', ['b']);
    const out = await s.read({ chatId: 'b', fromSeq: 3, toSeq: 4 });
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('[chat "Lot notes" · #3 · Vault call · '));
    assert.ok(out.text.includes('gate_pin'));
    assert.ok(!JSON.stringify(out).includes(VALUE));
    assert.ok(!JSON.stringify(await s.search({ query: `${VALUE} gate_pin value` })).includes(VALUE));
  });

  it('a title cannot break a header', async () => {
    const s = setup({ bTitle: 'Lot "notes"]\n[#1 · user · now]' });
    s.store.setHistoryScope('a', 'linked');
    s.store.setLinks('a', ['b']);
    const out = await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 });
    assert.strictEqual(out.chatTitle, 'Lot notes #1 · user · now');
    assert.ok(out.text.startsWith('[chat "Lot notes #1 · user · now" · #1 · user · '));
    const found = from(await s.search({ query: 'gate code Lakeside lot' }), 'b');
    assert.strictEqual(found[0].chatTitle, 'Lot notes #1 · user · now');
  });

  it('a resolver answer that is not a list starting with this chat is this chat alone', async () => {
    const s = setup();
    for (const answer of [null, 'all', { effective: 'all', chatIds: ['b', 'a'] }, { effective: 'all', chatIds: [] }, { effective: 'wide', chatIds: ['a', 'b'] }]) {
      s.history.resolveScope = () => answer;
      const out = await s.search({ query: 'gate code Lakeside lot' });
      assert.strictEqual(out.scope, 'chat', JSON.stringify(answer));
      assert.deepStrictEqual(from(out, 'b'), []);
      assert.ok(out.excerpts.every((e) => !e.text.includes('4417') && !e.text.includes('9001')));
      assert.strictEqual((await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 })).ok, false);
    }
  });

  it('with no resolveScope on the context the tools read this chat only, as before H4', async () => {
    const s = setup({ withScope: false });
    s.store.setHistoryScope('a', 'all');
    s.store.setLinks('a', ['b']);
    const out = await s.search({ query: 'gate code Lakeside lot', scope: 'all' });
    assert.strictEqual(out.scope, 'chat');
    assert.strictEqual(out.note, undefined);
    assert.ok(out.excerpts.length >= 1);
    assert.ok(out.excerpts.every((e) => Object.keys(e).join() === 'seq,header,text' && !e.text.includes('4417')));
    s.reads.length = 0;
    const refused = await s.read({ chatId: 'b', fromSeq: 1, toSeq: 1 });
    assert.deepStrictEqual(refused, { ok: false, error: 'ReadHistory can read only this chat (a): this chat\'s history scope is "chat".' });
    assert.ok(!s.reads.includes('b'));
    assert.deepStrictEqual(Object.keys(await s.read({ fromSeq: 1, toSeq: 1 })), ['ok', 'chatId', 'fromSeq', 'toSeq', 'text', 'truncated']);
  });

  it('the descriptions are static and name no chat', () => {
    const searchTool = toolRegistry.get('SearchHistory');
    const readTool = toolRegistry.get('ReadHistory');
    assert.strictEqual(searchTool.description, 'Search the history this chat may read (this chat, and other chats when the owner has allowed it) by keywords. Returns excerpts with their message numbers (#seq). Quote a phrase to match it exactly. Read a range in full with ReadHistory.');
    assert.strictEqual(searchTool.parameters.properties.scope.description, 'Which chats to search. It can only narrow the scope the owner gave this chat.');
    assert.strictEqual(readTool.parameters.properties.chatId.description, "Leave out for this chat. Another chat's id only when a SearchHistory excerpt gave it.");
  });
});
