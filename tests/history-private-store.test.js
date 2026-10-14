// tests/history-private-store.test.js
// Schema step 5 and the chat's private mark in the store (spec
// 2026-10-13-local-inference-design.md §8.1, §8.4; R-LI-10): one-way, never
// taken from a chat object, unknown reads as private, and marking drops the
// chat's hosted vectors in the same transaction.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { SCHEMA_STEPS, applySchema, latestVersion } = require('../src/history/schema');
const { rowToChat, chatToRow } = require('../src/history/rows');
const { unit } = require('../src/history/embedders/vectors');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');

const LOCAL_KEY = 'local:Xenova/all-MiniLM-L6-v2';
const HOSTED_KEY = 'openai:text-embedding-3-small';
const OLLAMA_KEY = 'ollama:nomic-embed-text';

const dirs = [];
// A file at schema version 4 holding one chat, as H4 left it.
function versionFourFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-v4-'));
  dirs.push(dir);
  const file = path.join(dir, 'history.sqlite');
  const db = new DatabaseSync(file);
  assert.strictEqual(applySchema(db, SCHEMA_STEPS.slice(0, 4)), 4);
  db.exec("INSERT INTO chats (id, position, title) VALUES ('old', 0, 'Lakeside lot')");
  db.exec("INSERT INTO messages (id, chat_id, seq, sender, text, timestamp) VALUES ('old-m1', 'old', 1, 'user', 'the gate code is 4417', '2026-01-01T09:00:00.000Z')");
  db.close();
  return file;
}

const privateColumn = (dbPath, id) => {
  const db = readDb(dbPath);
  try {
    return db.prepare('SELECT private FROM chats WHERE id = ?').get(id)?.private;
  } finally {
    db.close();
  }
};

const embeddingCount = (store, model, chatId) => Number(store.db.prepare(
  'SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.model = ? AND c.chat_id = ?'
).get(model, chatId).n);

function embedChat(store, chatId, models) {
  const chunks = store.chunksOfChat(chatId);
  assert.ok(chunks.length > 0, 'the chat has chunks');
  for (const model of models) {
    assert.strictEqual(store.putEmbeddings(model, chunks.map((c, i) => ({ chunkId: c.id, vec: unit([1, i + 1]) }))), chunks.length);
  }
  return chunks.length;
}

describe('history schema step 5: the private mark', () => {
  let t;
  let extra;
  afterEach(() => {
    if (extra) { try { extra.close(); } catch { /* closed */ } extra = null; }
    if (t) { t.cleanup(); t = null; }
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it('a new store is at schema 5 with chats.private', () => {
    t = openTempStore();
    assert.strictEqual(latestVersion(), 5);
    assert.strictEqual(t.store.schemaVersion, 5);
    assert.strictEqual(t.store.privacyAware, true);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 5);
    const column = db.prepare("SELECT * FROM pragma_table_info('chats') WHERE name = 'private'").get();
    assert.strictEqual(column.type, 'INTEGER');
    assert.strictEqual(Number(column.notnull), 1);
    assert.strictEqual(String(column.dflt_value), '0');
    db.close();
  });

  it('steps 1 to 4 are as released: step 5 is the only new one', () => {
    assert.deepStrictEqual(SCHEMA_STEPS.map((s) => s.version), [1, 2, 3, 4, 5]);
    const db = new DatabaseSync(':memory:');
    applySchema(db, SCHEMA_STEPS.slice(0, 4));
    const columns = db.prepare("SELECT name FROM pragma_table_info('chats')").all().map((r) => r.name);
    assert.ok(!columns.includes('private'));
    db.close();
  });

  it('a version-4 file opens at 5 with every chat not private', () => {
    const file = versionFourFile();
    extra = HistoryStore.open(file);
    assert.strictEqual(extra.schemaVersion, 5);
    assert.strictEqual(extra.privacyAware, true);
    assert.strictEqual(extra.isPrivate('old'), false);
    assert.deepStrictEqual(extra.chatRefs().map((r) => [r.id, r.private]), [['old', false]]);
    assert.deepStrictEqual(extra.getChat('old').messages.map((m) => m.text), ['the gate code is 4417']);
  });

  it('isPrivate is false by default and true after markPrivate; a second mark changes nothing', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', messages: [{ sender: 'user', text: 'the Lakeside lot' }] });
    seedChat(t.store, { id: 'b', messages: [{ sender: 'user', text: 'another chat' }] });
    assert.strictEqual(t.store.isPrivate('a'), false);
    assert.deepStrictEqual(t.store.markPrivate('a'), { marked: true, droppedVectors: 0 });
    assert.strictEqual(t.store.isPrivate('a'), true);
    assert.strictEqual(t.store.isPrivate('b'), false);
    assert.deepStrictEqual(t.store.markPrivate('a'), { marked: false, droppedVectors: 0 });
    assert.strictEqual(t.store.isPrivate('a'), true);
    assert.strictEqual(privateColumn(t.dbPath, 'a'), 1);
    assert.strictEqual(privateColumn(t.dbPath, 'b'), 0);
    // The mark is in the file, not in the connection.
    t.store.close();
    t.store = HistoryStore.open(t.dbPath);
    assert.strictEqual(t.store.isPrivate('a'), true);
    assert.strictEqual(t.store.isPrivate('b'), false);
  });

  it('an unknown chat cannot be marked, and reads as private', () => {
    t = openTempStore();
    assert.deepStrictEqual(t.store.markPrivate('missing'), { marked: false, droppedVectors: 0 });
    assert.deepStrictEqual(t.store.markPrivate(''), { marked: false, droppedVectors: 0 });
    assert.deepStrictEqual(t.store.markPrivate(null), { marked: false, droppedVectors: 0 });
    for (const id of ['missing', '', null, undefined, 42, {}]) assert.strictEqual(t.store.isPrivate(id), true, String(id));
  });

  it('a mark that cannot be read is private: a closed store, a broken read', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', messages: [{ sender: 'user', text: 'the Lakeside lot' }] });
    assert.strictEqual(t.store.isPrivate('a'), false);
    t.store.db.exec('ALTER TABLE chats RENAME COLUMN private TO private_gone');
    t.store._statements.clear();
    assert.strictEqual(t.store.isPrivate('a'), true);
    t.store.db.exec('ALTER TABLE chats RENAME COLUMN private_gone TO private');
    t.store.db.exec("UPDATE chats SET private = 7 WHERE id = 'a'");
    assert.strictEqual(t.store.isPrivate('a'), true, 'any value but 0 is private');
    t.store.close();
    assert.strictEqual(t.store.isPrivate('a'), true);
    assert.throws(() => t.store.markPrivate('a'));
  });

  it('R-LI-10: no method clears the mark', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', title: 'Private chat', messages: [{ sender: 'user', text: 'one' }, { sender: 'assistant', text: 'two' }, { sender: 'user', text: 'three' }] });
    t.store.markPrivate('a');
    const still = (what) => {
      assert.strictEqual(t.store.isPrivate('a'), true, what);
      assert.strictEqual(privateColumn(t.dbPath, 'a'), 1, what);
    };

    t.store.updateChat('a', { private: false });
    still('updateChat');
    t.store.updateChat('a', { private: 0, title: 'Renamed' });
    still('updateChat with a title');
    t.store.updateChatsWhere(() => true, () => ({ private: false }));
    still('updateChatsWhere');
    t.store.appendMessage('a', { sender: 'user', text: 'four' }, { patch: { private: false } });
    still('appendMessage with a patch');
    t.store.truncateFrom('a', 2);
    still('truncateFrom');
    t.store.replaceChat('a', { id: 'a', title: 'Replaced', private: false, messages: [{ sender: 'user', text: 'again' }] });
    still('replaceChat');
    t.store.upsertChat({ id: 'a', title: 'Upserted', private: false, messages: [] });
    still('upsertChat');
    t.store.setHistoryScope('a', 'all');
    t.store.setLinks('a', []);
    t.store.markRecalledOtherChats('a');
    still('scope, links and the recall mark');
    t.store.createChat({ id: 'a', title: 'Created over it', private: false, messages: [] });
    still('createChat over the id');
    t.store.createChat({ id: 'a', title: 'Created over it again', messages: [] }, { private: false });
    still('createChat over the id with private: false in the options');

    // No chat object ever carries the mark, and none is written to meta_json.
    assert.strictEqual('private' in t.store.getChat('a'), false);
    assert.strictEqual(t.store.listChats().some((c) => 'private' in c), false);
    const db = readDb(t.dbPath);
    assert.ok(!String(db.prepare("SELECT meta_json FROM chats WHERE id = 'a'").get().meta_json || '').includes('private'));
    db.close();
  });

  it('R-LI-10: nothing in the store writes the column back to 0', () => {
    const dir = path.join(__dirname, '..', 'src', 'history');
    for (const file of ['history-store.js', 'link-index.js', 'rows.js', 'chat-facade.js']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!/private\s*=\s*0/i.test(source), `${file} sets private = 0`);
      assert.ok(!/private\s*=\s*\?/i.test(source), `${file} sets private from a parameter`);
      assert.ok(!/unmarkPrivate|unmark\(|clearPrivate|setPrivate\b/i.test(source), `${file} has something that unmarks`);
    }
    const methods = Object.getOwnPropertyNames(HistoryStore.prototype).filter((name) => /private/i.test(name));
    // _privateMark reads the row; isPrivate and hasPrivateChats (review fix,
    // item 4a: a skill call with no known caller) read; markPrivate is the
    // one writer.
    assert.deepStrictEqual(methods.sort(), ['_privateMark', 'hasPrivateChats', 'isPrivate', 'markPrivate']);
    // Every statement that writes the column sets it to 1.
    const store = fs.readFileSync(path.join(dir, 'history-store.js'), 'utf8') + fs.readFileSync(path.join(dir, 'link-index.js'), 'utf8');
    const writes = store.match(/SET\s+[^;`']*\bprivate\b\s*=\s*[^,\s]+/gi) || [];
    assert.ok(writes.length >= 2, 'markPrivate and createChat write it');
    for (const write of writes) assert.match(write, /private = 1$/);
  });

  it('R-LI-10: marking deletes every vector that is not local:, in the same transaction', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', messages: [{ sender: 'user', text: 'For the record, the side gate code at the Lakeside lot is 4417.' }, { sender: 'assistant', text: 'Noted, the gate code is saved.' }] });
    seedChat(t.store, { id: 'b', messages: [{ sender: 'user', text: 'A second chat about the errands list.' }] });
    const inA = embedChat(t.store, 'a', [LOCAL_KEY, HOSTED_KEY, OLLAMA_KEY, 'LOCAL:Shouting/model']);
    const inB = embedChat(t.store, 'b', [LOCAL_KEY, HOSTED_KEY]);
    const epoch = t.store.vectorEpoch;

    assert.deepStrictEqual(t.store.markPrivate('a'), { marked: true, droppedVectors: inA * 3 });
    assert.strictEqual(embeddingCount(t.store, HOSTED_KEY, 'a'), 0);
    assert.strictEqual(embeddingCount(t.store, OLLAMA_KEY, 'a'), 0, 'the built-in ollama embedder is not local:');
    assert.strictEqual(embeddingCount(t.store, 'LOCAL:Shouting/model', 'a'), 0, 'the key prefix is matched exactly');
    assert.strictEqual(embeddingCount(t.store, LOCAL_KEY, 'a'), inA);
    assert.strictEqual(embeddingCount(t.store, LOCAL_KEY, 'b'), inB);
    assert.strictEqual(embeddingCount(t.store, HOSTED_KEY, 'b'), inB);
    assert.ok(t.store.vectorEpoch > epoch, 'vectorEpoch moved');

    // Marking a chat that is already private is no mark: the epoch stays.
    const after = t.store.vectorEpoch;
    assert.deepStrictEqual(t.store.markPrivate('a'), { marked: false, droppedVectors: 0 });
    seedChat(t.store, { id: 'c', messages: [{ sender: 'user', text: 'A third chat.' }] });
    embedChat(t.store, 'c', [LOCAL_KEY]);
    // Review fix, item 6: a mark that drops nothing still moves the epoch
    // (was: "the epoch stays"), so a hosted batch in flight is not written.
    assert.strictEqual(t.store.vectorEpoch, after, 'marking a private chat again is no mark');
    assert.deepStrictEqual(t.store.markPrivate('c'), { marked: true, droppedVectors: 0 });
    assert.ok(t.store.vectorEpoch > after, 'every mark moves the epoch');
  });

  it('R-LI-10: a mark whose delete fails leaves the chat unmarked and its vectors in place', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', messages: [{ sender: 'user', text: 'For the record, the side gate code at the Lakeside lot is 4417.' }] });
    const count = embedChat(t.store, 'a', [HOSTED_KEY]);
    const epoch = t.store.vectorEpoch;
    // The delete of the hosted vectors is refused by the database.
    t.store.db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON embeddings BEGIN SELECT RAISE(ABORT, 'delete refused'); END;");
    assert.throws(() => t.store.markPrivate('a'), /delete refused/);
    assert.strictEqual(privateColumn(t.dbPath, 'a'), 0);
    assert.strictEqual(t.store.isPrivate('a'), false);
    assert.strictEqual(embeddingCount(t.store, HOSTED_KEY, 'a'), count);
    assert.strictEqual(t.store.vectorEpoch, epoch);
    t.store.db.exec('DROP TRIGGER refuse_delete');
    assert.deepStrictEqual(t.store.markPrivate('a'), { marked: true, droppedVectors: count });
  });

  it('markPrivate inside a caller\'s transaction rolls back with it', () => {
    t = openTempStore();
    seedChat(t.store, { id: 'a', messages: [{ sender: 'user', text: 'the Lakeside lot' }] });
    assert.throws(() => t.store.transaction(() => {
      assert.strictEqual(t.store.markPrivate('a').marked, true);
      throw new Error('the caller failed');
    }), /the caller failed/);
    assert.strictEqual(t.store.isPrivate('a'), false);
  });

  it('createChat(chat, { private: true }) is private from its first row; private on the chat object is ignored', () => {
    t = openTempStore();
    t.store.createChat({ id: 'p', title: 'Private from the start', messages: [{ sender: 'user', text: 'the first message' }] }, { private: true });
    assert.strictEqual(t.store.isPrivate('p'), true);
    assert.strictEqual(privateColumn(t.dbPath, 'p'), 1);
    assert.strictEqual('private' in t.store.getChat('p'), false);

    t.store.createChat({ id: 'q', title: 'Says it is private', private: true, messages: [] });
    assert.strictEqual(t.store.isPrivate('q'), false);
    for (const [id, value] of [['r1', 1], ['r2', 'true'], ['r3', {}], ['r4', 'yes']]) {
      t.store.createChat({ id, title: 'Not exactly true', messages: [] }, { private: value });
      assert.strictEqual(t.store.isPrivate(id), false, String(value));
    }
    t.store.upsertChat({ id: 's', title: 'Upserted private', messages: [] }, { private: true });
    assert.strictEqual(t.store.isPrivate('s'), true);
    // An upsert over an existing chat cannot mark it either way.
    t.store.upsertChat({ id: 'q', title: 'Upserted again', messages: [] }, { private: true });
    assert.strictEqual(t.store.isPrivate('q'), false);
  });

  it('a deleted chat takes its mark with it: a new chat under the id starts unmarked', () => {
    t = openTempStore();
    t.store.createChat({ id: 'a', title: 'Private', messages: [] }, { private: true });
    assert.strictEqual(t.store.deleteChat('a'), true);
    assert.strictEqual(t.store.isPrivate('a'), true, 'unknown again');
    t.store.createChat({ id: 'a', title: 'A new chat', messages: [] });
    assert.strictEqual(t.store.isPrivate('a'), false);
  });

  it('chatRefs and chatRef carry private; rowToChat does not', () => {
    t = openTempStore();
    t.store.createChat({ id: 'b', title: 'Open', messages: [] });
    t.store.createChat({ id: 'a', title: 'Closed', messages: [] }, { private: true });
    assert.deepStrictEqual(t.store.chatRefs().map((r) => [r.id, r.private]), [['a', true], ['b', false]]);
    assert.strictEqual(t.store.chatRef('a').private, true);
    assert.strictEqual(t.store.chatRef('b').private, false);
    assert.strictEqual(t.store.chatRef('missing'), null);

    const row = t.store.db.prepare("SELECT * FROM chats WHERE id = 'a'").get();
    assert.strictEqual(row.private, 1);
    assert.strictEqual('private' in rowToChat(row), false);
    // One found in meta_json (written by hand, or by an older build) is dropped.
    assert.strictEqual('private' in rowToChat({ id: 'x', title: 't', meta_json: JSON.stringify({ private: false, channel: 'telegram' }) }), false);
    assert.strictEqual(chatToRow({ title: 't', private: true }).meta_json, null);
  });

  it('a store that is not privacy-aware reads every chat as private and cannot be marked', () => {
    const file = versionFourFile();
    extra = HistoryStore.open(file, { readonly: true, allowOlderSchema: true });
    assert.strictEqual(extra.schemaVersion, 4);
    assert.strictEqual(extra.privacyAware, false);
    assert.strictEqual(extra.isPrivate('old'), true);
    assert.strictEqual(extra.isPrivate('missing'), true);
    assert.deepStrictEqual(extra.chatRefs().map((r) => [r.id, r.private]), [['old', true]]);
    assert.strictEqual(extra.chatRef('old').private, true);
    assert.throws(() => extra.markPrivate('old'), /read-only/);
    assert.strictEqual(extra.getChat('old').title, 'Lakeside lot');
  });

  it('a read-only store at schema 5 reads the mark and refuses to set it', () => {
    t = openTempStore();
    t.store.createChat({ id: 'a', title: 'Closed', messages: [] }, { private: true });
    t.store.createChat({ id: 'b', title: 'Open', messages: [] });
    t.store.close();
    extra = HistoryStore.open(t.dbPath, { readonly: true });
    assert.strictEqual(extra.privacyAware, true);
    assert.strictEqual(extra.isPrivate('a'), true);
    assert.strictEqual(extra.isPrivate('b'), false);
    assert.throws(() => extra.markPrivate('b'), /read-only/);
    assert.strictEqual(extra.isPrivate('b'), false);
  });
});

describe('review fix, item 4a: whether any chat is private', () => {
  it('hasPrivateChats is false only for a store that answers none, and true once one is marked or the store cannot answer', () => {
    const store = HistoryStore.open(':memory:');
    try {
      store.createChat({ id: 'c-1', title: 'one', createdAt: '2026-10-13T09:00:00.000Z', updatedAt: '2026-10-13T09:00:00.000Z', messages: [] });
      assert.strictEqual(store.hasPrivateChats(), false);
      store.markPrivate('c-1');
      assert.strictEqual(store.hasPrivateChats(), true);
    } finally {
      store.close();
    }
    assert.strictEqual(store.hasPrivateChats(), true, 'a closed store cannot say none');
  });
});
