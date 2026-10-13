// tests/history-links-store.test.js
// Schema step 4 (recall spec §4.1, stage H4): chat_links and imports, and the
// store's history scope, link and import methods.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { SCHEMA_STEPS, applySchema, latestVersion } = require('../src/history/schema');
const { openTempStore, seedChat, readDb, isoAt } = require('./helpers/history-fixture');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// Chats a, b, c in list order (a new chat goes to the front).
function seedThree(store) {
  for (const id of ['c', 'b', 'a']) {
    seedChat(store, { id, title: `Chat ${id.toUpperCase()}`, messages: [{ sender: 'user', text: `the Lakeside lot, noted in ${id}` }] });
  }
}

const dirs = [];
// A file at schema version 3 holding one chat, as H3 left it.
function versionThreeFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-v3-'));
  dirs.push(dir);
  const file = path.join(dir, 'history.sqlite');
  const db = new DatabaseSync(file);
  assert.strictEqual(applySchema(db, SCHEMA_STEPS.slice(0, 3)), 3);
  db.exec("INSERT INTO chats (id, position, title) VALUES ('old', 0, 'Lakeside lot')");
  db.exec("INSERT INTO messages (id, chat_id, seq, sender, text, timestamp) VALUES ('old-m1', 'old', 1, 'user', 'the gate code is 4417', '2026-01-01T09:00:00.000Z')");
  db.close();
  return file;
}

describe('history schema step 4', () => {
  let t;
  let extra;
  afterEach(() => {
    if (extra) { try { extra.close(); } catch { /* closed */ } extra = null; }
    if (t) { t.cleanup(); t = null; }
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it('a new store is at version 4 with chat_links and imports', () => {
    t = openTempStore();
    assert.strictEqual(latestVersion(), 4);
    assert.strictEqual(t.store.schemaVersion, 4);
    assert.strictEqual(t.store.linkable, true);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 4);
    const cols = (table) => db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map((r) => r.name);
    assert.deepStrictEqual(cols('chat_links'), ['chat_id', 'linked_chat_id']);
    assert.deepStrictEqual(cols('imports'), ['id', 'source_kind', 'source_path', 'source_hash', 'chat_id', 'imported_at', 'state', 'importer_version', 'message_count']);
    db.close();
  });

  it('a store at version 3 opens at 4 with its chat intact and scope "chat"', () => {
    const file = versionThreeFile();
    extra = HistoryStore.open(file);
    assert.strictEqual(extra.schemaVersion, 4);
    assert.strictEqual(extra.linkable, true);
    const chat = extra.getChat('old');
    assert.strictEqual(chat.title, 'Lakeside lot');
    assert.deepStrictEqual(chat.messages.map((m) => m.text), ['the gate code is 4417']);
    assert.strictEqual(extra.getHistoryScope('old'), 'chat');
    assert.deepStrictEqual(extra.getLinks('old'), []);
  });

  it('a read-only store left at version 3 is not linkable and answers with the neutral values', () => {
    const file = versionThreeFile();
    extra = HistoryStore.open(file, { readonly: true, allowOlderSchema: true });
    assert.strictEqual(extra.schemaVersion, 3);
    assert.strictEqual(extra.linkable, false);
    assert.deepStrictEqual(extra.getLinks('old'), []);
    assert.strictEqual(extra.getHistoryScope('old'), 'chat');
    assert.strictEqual(extra.findImport(HASH_A), null);
    assert.strictEqual(extra.getImport('i-1'), null);
    assert.deepStrictEqual(extra.unfinishedImports(), []);
    assert.strictEqual(extra.setHistoryScope('old', 'all'), false);
    assert.deepStrictEqual(extra.setLinks('old', ['x']), []);
    assert.strictEqual(extra.recordImport({ id: 'i-1', sourceKind: 'markdown-transcript', sourceHash: HASH_A, chatId: 'old' }), null);
    assert.strictEqual(extra.finishImport('i-1', { messageCount: 1 }), false);
    assert.deepStrictEqual(extra.chatRefs().map((r) => r.id), ['old']);
  });
});

describe('a chat\'s history scope', () => {
  let t;
  afterEach(() => { if (t) { t.cleanup(); t = null; } });

  it('defaults to "chat" and stores each of the three', () => {
    t = openTempStore();
    seedThree(t.store);
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
    for (const scope of ['linked', 'all', 'chat']) {
      assert.strictEqual(t.store.setHistoryScope('a', scope), true);
      assert.strictEqual(t.store.getHistoryScope('a'), scope);
    }
    assert.strictEqual(t.store.getHistoryScope('b'), 'chat');
  });

  it('refuses a value outside the three, and an unknown chat', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.setHistoryScope('a', 'linked');
    for (const bad of ['everything', '', null, undefined, 3, 'ALL']) {
      assert.throws(() => t.store.setHistoryScope('a', bad), RangeError);
    }
    assert.strictEqual(t.store.getHistoryScope('a'), 'linked');
    assert.strictEqual(t.store.setHistoryScope('missing', 'all'), false);
    assert.strictEqual(t.store.getHistoryScope('missing'), 'chat');
  });

  it('reads an unknown stored value as "chat"', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.db.prepare("UPDATE chats SET history_scope = 'everything' WHERE id = 'a'").run();
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
  });

  it('is never taken from a chat object', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.updateChat('a', { historyScope: 'all' });
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
    t.store.createChat({ id: 'n', title: 'New', historyScope: 'all', messages: [] });
    assert.strictEqual(t.store.getHistoryScope('n'), 'chat');
    t.store.replaceChat('b', { id: 'b', title: 'Chat B', historyScope: 'all', messages: [] });
    assert.strictEqual(t.store.getHistoryScope('b'), 'chat');
    t.store.upsertChat({ id: 'u', title: 'Upserted', historyScope: 'linked', messages: [] });
    assert.strictEqual(t.store.getHistoryScope('u'), 'chat');
    t.store.updateChatsWhere((chat) => chat.id === 'c', () => ({ historyScope: 'all' }));
    assert.strictEqual(t.store.getHistoryScope('c'), 'chat');
    for (const id of ['a', 'n', 'b', 'u', 'c']) assert.ok(!('historyScope' in t.store.getChat(id)), id);
    const db = readDb(t.dbPath);
    const metas = db.prepare('SELECT id, meta_json FROM chats').all();
    db.close();
    for (const row of metas) assert.ok(!String(row.meta_json || '').includes('historyScope'), row.id);
  });

  it('survives updateChat, appendMessage and replaceChat', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.setHistoryScope('a', 'linked');
    t.store.setLinks('a', ['b']);
    t.store.updateChat('a', { title: 'x' });
    t.store.appendMessage('a', { id: 'a-late', sender: 'user', text: 'one more', timestamp: isoAt(30) });
    assert.strictEqual(t.store.getHistoryScope('a'), 'linked');
    assert.deepStrictEqual(t.store.getLinks('a'), ['b']);
    t.store.replaceChat('a', { id: 'a', title: 'y', messages: [] });
    assert.strictEqual(t.store.getHistoryScope('a'), 'linked');
    assert.deepStrictEqual(t.store.getLinks('a'), ['b']);
  });

  it('a hand-written historyScope in meta_json is not read back', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.db.prepare("UPDATE chats SET meta_json = '{\"historyScope\":\"all\",\"profileId\":\"p-a\"}' WHERE id = 'a'").run();
    const chat = t.store.getChat('a', { messages: false });
    assert.ok(!('historyScope' in chat));
    assert.strictEqual(chat.profileId, 'p-a');
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
  });
});

describe('chat links', () => {
  let t;
  afterEach(() => { if (t) { t.cleanup(); t = null; } });

  it('setLinks drops duplicates, the chat itself and chats that do not exist; links are one-directional', () => {
    t = openTempStore();
    seedThree(t.store);
    const epoch = t.store.vectorEpoch;
    assert.deepStrictEqual(t.store.setLinks('a', ['b', 'c', 'b', 'a', 'missing']), ['b', 'c']);
    assert.deepStrictEqual(t.store.getLinks('a'), ['b', 'c']);
    assert.deepStrictEqual(t.store.getLinks('b'), []);
    assert.deepStrictEqual(t.store.getLinks('missing'), []);
    assert.strictEqual(t.store.vectorEpoch, epoch, 'links move no vector');
    t.store.setHistoryScope('a', 'linked');
    assert.strictEqual(t.store.vectorEpoch, epoch, 'a scope moves no vector');
  });

  it('getLinks follows the chat list order, not the order given', () => {
    t = openTempStore();
    seedThree(t.store);
    assert.deepStrictEqual(t.store.setLinks('a', ['c', 'b']), ['b', 'c']);
    assert.deepStrictEqual(t.store.getLinks('a'), ['b', 'c']);
  });

  it('setLinks replaces, clears, and ignores what is not a list of strings', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.setLinks('a', ['b', 'c']);
    assert.deepStrictEqual(t.store.setLinks('a', ['c']), ['c']);
    assert.deepStrictEqual(t.store.setLinks('a', [42, null, { id: 'b' }, 'b']), ['b']);
    assert.deepStrictEqual(t.store.setLinks('a', []), []);
    assert.deepStrictEqual(t.store.getLinks('a'), []);
    t.store.setLinks('a', ['b']);
    assert.deepStrictEqual(t.store.setLinks('a', 'b'), []);
    assert.deepStrictEqual(t.store.setLinks('missing', ['a']), []);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chat_links').get().n, 0);
    db.close();
  });

  it('deleting a chat removes its links, both ways', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.setLinks('a', ['b', 'c']);
    t.store.setLinks('c', ['a']);
    t.store.deleteChat('b');
    assert.deepStrictEqual(t.store.getLinks('a'), ['c']);
    t.store.deleteChat('a');
    const db = readDb(t.dbPath);
    assert.deepStrictEqual(db.prepare('SELECT chat_id, linked_chat_id FROM chat_links').all(), []);
    db.close();
  });

  it('createChat over an existing id drops that chat\'s links and scope', () => {
    t = openTempStore();
    seedThree(t.store);
    t.store.setLinks('a', ['b']);
    t.store.setLinks('c', ['a']);
    t.store.setHistoryScope('a', 'linked');
    t.store.createChat({ id: 'a', title: 'Chat A again', messages: [] });
    assert.deepStrictEqual(t.store.getLinks('a'), []);
    assert.deepStrictEqual(t.store.getLinks('c'), []);
    assert.strictEqual(t.store.getHistoryScope('a'), 'chat');
  });
});

describe('chat refs', () => {
  let t;
  afterEach(() => { if (t) { t.cleanup(); t = null; } });

  it('chatRefs gives id, title, caseId, source, origin and importedFromCase in list order, with no messages', () => {
    t = openTempStore();
    t.store.createChat({ id: 'd', title: 'Imported from a case', source: 'king-louie-json', importedFromCase: true, messages: [] });
    t.store.createChat({ id: 'c', title: 'Imported', source: 'claude-code-jsonl', importedFromCase: 'yes', messages: [] });
    t.store.createChat({ id: 'b', title: 'Bridge', origin: 'telegram', messages: [] });
    seedChat(t.store, { id: 'a', title: 'Case chat', caseId: 'case-1', messages: [{ sender: 'user', text: 'the Lakeside lot' }] });
    assert.deepStrictEqual(t.store.chatRefs(), [
      { id: 'a', title: 'Case chat', caseId: 'case-1', source: null, origin: null, importedFromCase: false },
      { id: 'b', title: 'Bridge', caseId: null, source: null, origin: 'telegram', importedFromCase: false },
      { id: 'c', title: 'Imported', caseId: null, source: 'claude-code-jsonl', origin: null, importedFromCase: false },
      { id: 'd', title: 'Imported from a case', caseId: null, source: 'king-louie-json', origin: null, importedFromCase: true }
    ]);
    assert.deepStrictEqual(t.store.chatRef('b'), { id: 'b', title: 'Bridge', caseId: null, source: null, origin: 'telegram', importedFromCase: false });
    assert.strictEqual(t.store.chatRef('missing'), null);
    assert.strictEqual(t.store.chatRef(''), null);
  });

  it('a caseId kept in meta_json still marks the chat', () => {
    t = openTempStore();
    t.store.createChat({ id: 'n', title: 'Odd', caseId: 42, messages: [] });
    assert.strictEqual(t.store.chatRef('n').caseId, 42);
  });
});

describe('import records', () => {
  let t;
  afterEach(() => { if (t) { t.cleanup(); t = null; } });
  const record = (store, over = {}) => store.recordImport({
    id: 'imp-1', sourceKind: 'markdown-transcript', sourcePath: '/work/example/lot.md', sourceHash: HASH_A,
    chatId: 'a', importerVersion: 1, ...over
  });

  it('recordImport, findImport, finishImport', () => {
    t = openTempStore({ now: () => '2026-01-02T00:00:00.000Z' });
    seedThree(t.store);
    const row = record(t.store);
    const expected = {
      id: 'imp-1', sourceKind: 'markdown-transcript', sourcePath: '/work/example/lot.md', sourceHash: HASH_A,
      chatId: 'a', importedAt: null, state: 'running', importerVersion: 1, messageCount: null
    };
    assert.deepStrictEqual(row, expected);
    assert.deepStrictEqual(t.store.findImport(HASH_A), expected);
    assert.deepStrictEqual(t.store.getImport('imp-1'), expected);
    assert.strictEqual(t.store.findImport(HASH_B), null);
    assert.strictEqual(t.store.getImport('imp-2'), null);
    assert.strictEqual(t.store.finishImport('imp-1', { messageCount: 12 }), true);
    assert.deepStrictEqual(t.store.findImport(HASH_A), { ...expected, state: 'done', messageCount: 12, importedAt: '2026-01-02T00:00:00.000Z' });
    assert.strictEqual(t.store.finishImport('imp-2', { messageCount: 1 }), false);
  });

  it('a second import of the same hash throws; one without a path stores null', () => {
    t = openTempStore();
    seedThree(t.store);
    record(t.store);
    assert.throws(() => record(t.store, { id: 'imp-2', chatId: 'b' }), /UNIQUE/);
    assert.strictEqual(t.store.getImport('imp-2'), null);
    const row = record(t.store, { id: 'imp-3', chatId: 'b', sourceHash: HASH_B, sourcePath: undefined, importerVersion: undefined });
    assert.strictEqual(row.sourcePath, null);
    assert.strictEqual(row.importerVersion, null);
    assert.throws(() => record(t.store, { id: 'imp-4', sourceHash: 'c'.repeat(64), chatId: 'missing' }), /FOREIGN KEY/);
    assert.throws(() => record(t.store, { id: 'imp-5', sourceHash: 'd'.repeat(64), state: 'paused' }), RangeError);
  });

  it('unfinishedImports lists only running ones', () => {
    t = openTempStore();
    seedThree(t.store);
    record(t.store);
    record(t.store, { id: 'imp-2', chatId: 'b', sourceHash: HASH_B });
    t.store.finishImport('imp-1', { messageCount: 1 });
    assert.deepStrictEqual(t.store.unfinishedImports().map((r) => r.id), ['imp-2']);
  });

  it('deleting the chat removes its import row', () => {
    t = openTempStore();
    seedThree(t.store);
    record(t.store);
    t.store.deleteChat('a');
    assert.strictEqual(t.store.findImport(HASH_A), null);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM imports').get().n, 0);
    db.close();
  });
});
