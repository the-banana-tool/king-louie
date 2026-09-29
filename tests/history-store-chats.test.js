// tests/history-store-chats.test.js
// Chat CRUD, ordering and listing metadata on the history store (recall spec
// §4.4): the same semantics as the facade it replaces.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../src/history');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function memory() {
  const store = HistoryStore.open(':memory:');
  stores.push(store);
  return store;
}
const msg = (id, sender, text, timestamp = '2026-09-29T10:00:00.000Z', extra = {}) => ({ id, sender, text, timestamp, ...extra });
const withoutSeq = (messages) => messages.map(({ seq: _seq, ...m }) => m);
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('HistoryStore chats', () => {
  it('orders chats by creation position, front and back', () => {
    const store = memory();
    store.createChat({ id: 'b', title: 'B' });
    store.createChat({ id: 'a', title: 'A' }, { position: 'front' });
    store.createChat({ id: 'c', title: 'C' }, { position: 'back' });
    assert.deepStrictEqual(store.listChats().map((c) => c.id), ['a', 'b', 'c']);
  });

  it('lists metadata with counts, preview and lastMessageAt, and no messages unless asked', () => {
    const store = memory();
    store.createChat({
      id: 'c1', title: 'Lakeside lot',
      messages: [
        msg('m1', 'assistant', 'How can I help you?', '2026-09-29T10:00:00.000Z'),
        msg('m2', 'user', 'remember the blue folder', '2026-09-29T10:01:00.000Z'),
        msg('m3', 'assistant', 'Noted.', '2026-09-29T10:02:00.000Z'),
        msg('m4', 'toolUse', '', '2026-09-29T10:03:00.000Z', { toolName: 'Bash', parameters: { command: 'ls' } })
      ]
    });
    store.createChat({ id: 'c2', title: 'Empty' }, { position: 'back' });
    const [c1, c2] = store.listChats();
    assert.strictEqual(c1.messages, undefined);
    assert.strictEqual(c1.messageCount, 4);
    assert.strictEqual(c1.userMessageCount, 1);
    assert.strictEqual(c1.assistantMessageCount, 2);
    assert.strictEqual(c1.preview, 'Noted.');
    assert.strictEqual(c1.lastMessageText, 'Noted.');
    assert.strictEqual(c1.lastMessageAt, '2026-09-29T10:02:00.000Z');
    assert.deepStrictEqual({ n: c2.messageCount, p: c2.preview, at: c2.lastMessageAt }, { n: 0, p: '', at: null });
    const full = store.listChats({ messages: true });
    assert.deepStrictEqual(full[0].messages.map((m) => m.seq), [1, 2, 3, 4]);
    assert.deepStrictEqual(full[1].messages, []);
  });

  it('lists a multi-chat fixture exactly, with one statement however many chats there are', () => {
    const store = memory();
    store.createChat({
      id: 'c1', title: 'Lakeside lot', pinned: true, llmTotals: { inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.001 },
      createdAt: '2026-09-29T09:00:00.000Z', updatedAt: '2026-09-29T10:03:00.000Z',
      messages: [
        msg('m1', 'assistant', 'How can I help you?', '2026-09-29T10:00:00.000Z'),
        msg('m2', 'user', 'remember the blue folder', '2026-09-29T10:01:00.000Z'),
        msg('m3', 'toolUse', '', '2026-09-29T10:03:00.000Z', { toolName: 'Bash' })
      ]
    }, { position: 'back' });
    store.createChat({ id: 'c2', title: 'Empty', createdAt: '2026-09-28T09:00:00.000Z' }, { position: 'back' });
    store.createChat({
      id: 'c3', title: 'Only tools', messages: [msg('t1', 'toolUse', 'ran it', '2026-09-27T10:00:00.000Z'), msg('t2', 'toolResult', 'done', '2026-09-27T10:00:01.000Z')]
    }, { position: 'back' });
    store.createChat({ id: 'c4', title: 'Front', messages: [msg('f1', 'user', 'y'.repeat(600), '2026-09-26T10:00:00.000Z')] }, { position: 'front' });

    const statements = [];
    const stmt = store._stmt.bind(store);
    store._stmt = (sql) => { statements.push(sql); return stmt(sql); };
    const listed = store.listChats();
    store._stmt = stmt;

    assert.strictEqual(statements.length, 1, 'no per-chat preview query');
    assert.deepStrictEqual(listed, [
      {
        id: 'c4', title: 'Front', messageCount: 1, userMessageCount: 1, assistantMessageCount: 0,
        preview: 'y'.repeat(500), lastMessageText: 'y'.repeat(500), lastMessageAt: '2026-09-26T10:00:00.000Z',
        ...pick(listed[0], ['createdAt', 'updatedAt'])
      },
      {
        id: 'c1', title: 'Lakeside lot', pinned: true, llmTotals: { inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.001 },
        createdAt: '2026-09-29T09:00:00.000Z', updatedAt: '2026-09-29T10:03:00.000Z',
        messageCount: 3, userMessageCount: 1, assistantMessageCount: 1,
        preview: 'remember the blue folder', lastMessageText: 'remember the blue folder', lastMessageAt: '2026-09-29T10:01:00.000Z'
      },
      {
        id: 'c2', title: 'Empty', createdAt: '2026-09-28T09:00:00.000Z', ...pick(listed[2], ['updatedAt']),
        messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, preview: '', lastMessageText: '', lastMessageAt: null
      },
      {
        id: 'c3', title: 'Only tools', ...pick(listed[3], ['createdAt', 'updatedAt']),
        messageCount: 2, userMessageCount: 0, assistantMessageCount: 0,
        preview: 'done', lastMessageText: 'done', lastMessageAt: '2026-09-27T10:00:01.000Z'
      }
    ]);
    assert.deepStrictEqual(store.listChats({ messages: true }).map((c) => [c.id, c.messages.length]), [['c4', 1], ['c1', 3], ['c2', 0], ['c3', 2]]);
  });

  it('cuts a long preview to 500 characters', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'Paste', messages: [msg('m1', 'user', 'x'.repeat(5000))] });
    assert.strictEqual(store.listChats()[0].preview.length, 500);
  });

  it('gets one chat with its messages in seq order, or without them', () => {
    const store = memory();
    const messages = [msg('m1', 'user', 'one'), msg('m2', 'assistant', 'two')];
    store.createChat({ id: 'c1', title: 'One', agentMode: true, messages });
    const chat = store.getChat('c1');
    assert.deepStrictEqual(chat.messages.map((m) => m.seq), [1, 2]);
    assert.deepStrictEqual(withoutSeq(chat.messages), messages);
    assert.strictEqual(chat.agentMode, true);
    assert.strictEqual(chat.messageCount, undefined, 'getChat carries no derived fields');
    assert.strictEqual(store.getChat('c1', { messages: false }).messages, undefined);
    assert.strictEqual(store.getChat(' c1 ').id, 'c1');
    assert.strictEqual(store.getChat('missing'), null);
    assert.strictEqual(store.getChat(''), null);
  });

  it('round-trips attachments through their own rows', () => {
    const store = memory();
    const image = { base64: Buffer.from('invented png').toString('base64'), mimeType: 'image/png', name: 'lot.png' };
    const doc = { base64: Buffer.from('invented pdf').toString('base64'), mimeType: 'application/pdf', name: 'offer.pdf', sizeBytes: 12 };
    store.createChat({ id: 'c1', title: 'Files', messages: [msg('m1', 'user', 'see attached', 't', { images: [image], documents: [doc] })] });
    assert.strictEqual(count(store, 'attachments'), 2);
    const [message] = store.getChat('c1').messages;
    assert.deepStrictEqual(message.images, [image]);
    assert.deepStrictEqual(message.documents, [doc]);
  });

  it('createChat with an existing id replaces that chat and moves it', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    store.createChat({ id: 'b', title: 'B', messages: [msg('m1', 'user', 'old')] }, { position: 'back' });
    store.createChat({ id: 'b', title: 'B again', messages: [] }, { position: 'front' });
    assert.deepStrictEqual(store.listChats().map((c) => [c.id, c.title, c.messageCount]), [['b', 'B again', 0], ['a', 'A', 0]]);
    assert.strictEqual(store.createChat({ title: 'no id' }), null);
  });

  it('replaceChat keeps the position, forces the id and replaces every message', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    store.createChat({ id: 'b', title: 'B', profileId: 'p1', messages: [msg('m1', 'user', 'old')] }, { position: 'back' });
    const replaced = store.replaceChat('b', { id: 'ignored', title: 'Replaced', messages: [msg('m2', 'user', 'new'), msg('m3', 'assistant', 'ok')] });
    assert.strictEqual(replaced.id, 'b');
    assert.strictEqual(replaced.profileId, undefined, 'fields not in the new chat are gone');
    assert.deepStrictEqual(replaced.messages.map((m) => [m.id, m.seq]), [['m2', 1], ['m3', 2]]);
    assert.deepStrictEqual(store.listChats().map((c) => c.id), ['a', 'b']);
    assert.strictEqual(store.replaceChat('missing', { title: 'x' }), null);
  });

  it('upsertChat creates or replaces', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    assert.strictEqual(store.upsertChat({ id: 'b', title: 'B' }, { position: 'back' }).id, 'b');
    assert.strictEqual(store.upsertChat({ id: 'a', title: 'A imported', messages: [msg('m1', 'user', 'hi')] }).title, 'A imported');
    assert.deepStrictEqual(store.listChats().map((c) => [c.id, c.messageCount]), [['a', 1], ['b', 0]]);
  });

  it('updateChat merges a patch, keeps null values, and can replace messages', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', caseId: 'case-1', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b')] });
    const patched = store.updateChat('c1', { title: 'Renamed', caseId: null, canvasState: { visible: true } });
    assert.strictEqual(patched.title, 'Renamed');
    assert.strictEqual(patched.caseId, null);
    assert.deepStrictEqual(patched.canvasState, { visible: true });
    assert.strictEqual(patched.messages.length, 2);
    assert.strictEqual(store.updateChat('c1', { title: 'Quiet' }, { messages: false }).messages, undefined);
    const tagged = store.updateChat('c1', { messages: [msg('m1', 'user', 'a', 't', { channel: 'telegram' })] });
    assert.deepStrictEqual(tagged.messages.map((m) => [m.id, m.seq, m.channel]), [['m1', 1, 'telegram']]);
    assert.strictEqual(store.updateChat('missing', { title: 'x' }), null);
  });

  it('writing back a listed chat or messages with seq stores no derived fields (review focus 2)', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'hi')] });
    const listed = store.listChats()[0];
    store.updateChat('c1', listed);
    const full = store.getChat('c1');
    store.replaceChat('c1', full);
    const row = store.db.prepare("SELECT meta_json FROM chats WHERE id = 'c1'").get();
    assert.strictEqual(row.meta_json, null);
    const messageRow = store.db.prepare("SELECT meta_json FROM messages WHERE id = 'm1'").get();
    assert.strictEqual(messageRow.meta_json, null);
    assert.deepStrictEqual(Object.keys(store.getChat('c1', { messages: false })).sort(), ['id', 'title']);
  });

  it('updateChatsWhere patches matching chats without messages and returns them', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', profileId: 'p-b', messages: [msg('m1', 'user', 'hi')] });
    store.createChat({ id: 'c2', title: 'Two', profileId: 'p-a' }, { position: 'back' });
    const seen = [];
    const changed = store.updateChatsWhere(
      (chat) => { seen.push(chat.messages); return chat.profileId === 'p-b'; },
      () => ({ profileId: null, updatedAt: '2026-09-29T12:00:00.000Z', messages: [] })
    );
    assert.deepStrictEqual(seen, [undefined, undefined]);
    assert.deepStrictEqual(changed.map((c) => [c.id, c.profileId, c.messages]), [['c1', null, undefined]]);
    assert.strictEqual(store.getChat('c1').messages.length, 1, 'a messages key in the patch is ignored');
    assert.deepStrictEqual(store.updateChatsWhere(() => true, () => null), []);
  });

  it('deleteChat removes its messages and attachments and says whether it deleted anything', () => {
    const store = memory();
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'x', 't', { images: [image] })] });
    store.createChat({ id: 'c2', title: 'Two' }, { position: 'back' });
    assert.strictEqual(store.deleteChat('c1'), true);
    assert.strictEqual(store.deleteChat('c1'), false);
    assert.deepStrictEqual(store.listChats().map((c) => c.id), ['c2']);
    assert.strictEqual(count(store, 'messages'), 0);
    assert.strictEqual(count(store, 'attachments'), 0);
  });

  it('refuses a chat whose messages are not a list or lack a sender, and writes nothing', () => {
    const store = memory();
    assert.throws(() => store.createChat({ id: 'bad', title: 'Bad', messages: 'nope' }), (err) => err.code === 'HISTORY_INVALID_MESSAGE');
    assert.throws(() => store.createChat({ id: 'bad', title: 'Bad', messages: [msg('m1', 'user', 'ok'), { text: 'no sender' }] }), /sender/);
    assert.strictEqual(store.getChat('bad'), null);
    assert.strictEqual(count(store, 'messages'), 0);
  });

  it('keeps chats across a reopen of the same file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-'));
    dirs.push(dir);
    const file = path.join(dir, 'history.sqlite');
    const first = HistoryStore.open(file);
    stores.push(first);
    first.createChat({ id: 'c1', title: 'Kept', messages: [msg('m1', 'user', 'hi')] });
    first.close();
    const second = HistoryStore.open(file);
    stores.push(second);
    assert.deepStrictEqual(withoutSeq(second.getChat('c1').messages), [msg('m1', 'user', 'hi')]);
  });
});
