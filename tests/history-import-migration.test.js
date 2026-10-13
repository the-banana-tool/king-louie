// tests/history-import-migration.test.js
// An import never takes the place of a chat that is still in chat-data.json
// (stage H4 review, finding 3). The move out of the JSON file treats a chat
// whose id is already in the store, with the same message count, as moved:
// an import that was given that id would stand in for the original.
// - The CLI (no core) refuses while the store has no migration marker and
//   chat-data.json holds chats.
// - In a core, an import is never given an id chat-data.json still holds.
// - The move itself never takes an imported chat for the original.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { HistoryStore, migrateFromJson, MIGRATION_MARKER, beginChatImport, importChat } = require('../src/history');
const { runHistoryCommand } = require('../src/service/commands/history');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { openTempStore } = require('./helpers/history-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const FIXTURES = path.join(__dirname, 'fixtures', 'history');
const CLAUDE_CODE = path.join(FIXTURES, 'claude-code-session.jsonl');
const SESSION_ID = 'cc-sess-fixture-1';
const SESSION_MESSAGES = 7;
const HASH = 'a'.repeat(64);
const T = '2026-09-28T10:00:00.000Z';
const msg = (id, text) => ({ id, sender: 'user', text, timestamp: T });
// A native chat with the importer's id and as many messages as the session.
const original = () => ({
  id: SESSION_ID, title: 'The owner\'s own chat', caseId: 'case-lakeside',
  messages: Array.from({ length: SESSION_MESSAGES }, (_, i) => msg(`n${i}`, `Own note ${i} about the Lakeside lot.`))
});

const dirs = [];
const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
  closeOpenHistoryStores();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-import-migration-'));
  dirs.push(dir);
  return dir;
}
const sqlite = (dir) => path.join(dir, 'history.sqlite');
function jsonStoreIn(dir, chats) {
  const store = new JsonFileStore({ dir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  if (chats !== undefined) store.set('chats', chats);
  return store;
}
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('the store keeps an import off a reserved id', () => {
  it('beginChatImport skips an id the store was told is reserved, bare or suffixed', () => {
    const t = openTempStore();
    open.push(t);
    const { store } = t;
    const reserved = new Set(['md-lot', `md-lot-${HASH.slice(0, 8)}`]);
    store.reserveChatIds((id) => reserved.has(id));
    const begun = beginChatImport({ store, kind: 'markdown-transcript', sourceHash: HASH, chat: { id: 'md-lot', title: 'Lot' } });
    assert.strictEqual(begun.chatId, `md-lot-${HASH.slice(0, 8)}-2`);
    // Nothing reserved: the importer's own id, as before.
    store.reserveChatIds(null);
    const free = beginChatImport({ store, kind: 'markdown-transcript', sourceHash: 'b'.repeat(64), chat: { id: 'md-lot', title: 'Lot' } });
    assert.strictEqual(free.chatId, 'md-lot');
  });

  it('a check that throws reserves the id', () => {
    const t = openTempStore();
    open.push(t);
    const { store } = t;
    let calls = 0;
    store.reserveChatIds(() => { calls += 1; if (calls === 1) throw new Error('unreadable'); return false; });
    const begun = beginChatImport({ store, kind: 'markdown-transcript', sourceHash: HASH, chat: { id: 'md-lot', title: 'Lot' } });
    assert.strictEqual(begun.chatId, `md-lot-${HASH.slice(0, 8)}`);
    assert.strictEqual(store.isReservedChatId('anything'), false);
  });
});

describe('in a core, an import never gets an id chat-data.json still holds', () => {
  function makeCore(chats) {
    const dataDir = tmp();
    const store = jsonStoreIn(dataDir, chats);
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    });
    return { core, store, dataDir };
  }

  it('finding 3: a chat that could not move keeps its id; the import gets another, and the original is never dropped', async () => {
    // It cannot move: its messages are not a list. It stays in the JSON file.
    const stuck = { id: SESSION_ID, title: 'Stuck chat', messages: 'not a list' };
    const { core, store } = makeCore([stuck]);
    assert.strictEqual(core.context.getHistoryStatus().migrationFailed, 1);
    const history = core.context.getHistoryStore();
    assert.strictEqual(history.getMeta(MIGRATION_MARKER), null);
    assert.strictEqual(history.isReservedChatId(SESSION_ID), true);
    assert.strictEqual(history.isReservedChatId('some-other-id'), false);

    const out = await importChat({ store: history, filePath: CLAUDE_CODE });
    assert.strictEqual(out.imported, true);
    assert.notStrictEqual(out.chatId, SESSION_ID);
    assert.match(out.chatId, new RegExp(`^${SESSION_ID}-[0-9a-f]{8}$`));
    assert.strictEqual(history.getChat(SESSION_ID), null);
    assert.deepStrictEqual(store.get('chats'), [stuck]);

    // The batch channel (attached: the service's side) goes the same way.
    const gate = core.context.getHistoryImportGate();
    const begun = gate.begin({ kind: 'markdown-transcript', sourceHash: 'c'.repeat(64), chat: { id: SESSION_ID, title: 'Sent over the bridge' }, total: 1 });
    assert.notStrictEqual(begun.chatId, SESSION_ID);
    gate.abortOpen('test');
    await core.shutdown();
  });

  it('once every chat has moved nothing is reserved', async () => {
    const { core } = makeCore([{ id: 'c1', title: 'One', messages: [] }]);
    const history = core.context.getHistoryStore();
    assert.ok(history.getMeta(MIGRATION_MARKER));
    assert.strictEqual(history.isReservedChatId('c1'), false);
    const out = await importChat({ store: history, filePath: CLAUDE_CODE });
    assert.strictEqual(out.chatId, SESSION_ID);
    await core.shutdown();
  });
});

describe('the move out of chat-data.json never takes an import for the original', () => {
  it('an imported chat with the same id and message count is a conflict, and the original stays in the JSON file', async () => {
    const dir = tmp();
    const history = HistoryStore.open(sqlite(dir));
    try {
      // An import made before anything moved (an older build's CLI).
      const out = await importChat({ store: history, filePath: CLAUDE_CODE });
      assert.strictEqual(out.chatId, SESSION_ID);
      assert.strictEqual(history.messageCount(SESSION_ID), SESSION_MESSAGES);

      const jsonStore = jsonStoreIn(dir, [original()]);
      const result = migrateFromJson({ historyStore: history, jsonStore, jsonPath: jsonStore.path, log: quiet });
      assert.strictEqual(result.migrated, 0);
      assert.deepStrictEqual(result.failed.map((f) => f.id), [SESSION_ID]);
      assert.strictEqual(result.failed[0].error, 'an imported chat with this id is already in history.sqlite');
      assert.strictEqual(jsonStore.get('chats').length, 1, 'the original is still in chat-data.json');
      assert.strictEqual(history.getMeta(MIGRATION_MARKER), null);
      assert.strictEqual(history.getChat(SESSION_ID, { messages: false }).source, 'claude-code-jsonl');
    } finally {
      history.close();
    }
  });
});

describe('service CLI — history import waits for the move out of chat-data.json', () => {
  const dirStat = (uid) => ({ uid, isDirectory: () => true, isSymbolicLink: () => false });
  const OWNER = { isAdmin: () => false, platform: 'linux', getuid: () => 1001, statDataDir: () => dirStat(1001), runningServicePid: () => null };
  async function run(dataDir) {
    const out = [];
    const err = [];
    const io = { stdin: Readable.from(['']), stdout: { write: (s) => out.push(String(s)) }, stderr: { write: (s) => err.push(String(s)) } };
    const code = await runHistoryCommand({ sub: 'import', arg: CLAUDE_CODE, flags: {}, dataDir, io, deps: OWNER });
    return { code, out: out.join(''), err: err.join('') };
  }
  const chatIds = (dir) => {
    const store = HistoryStore.open(sqlite(dir), { readonly: true });
    try {
      return store.listChats().map((c) => c.id);
    } finally {
      store.close();
    }
  };

  it('finding 3: a data dir never started, with chats in chat-data.json, is refused and no store is created', async () => {
    const dir = tmp();
    jsonStoreIn(dir, [original()]);
    const r = await run(dir);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.out, '');
    assert.match(r.err, /chat-data\.json/);
    assert.match(r.err, /Start the service once/);
    assert.match(r.err, /1 chat\b/);
    assert.strictEqual(fs.existsSync(sqlite(dir)), false);
  });

  it('a store with no migration marker and chats still in chat-data.json is refused and nothing is imported', async () => {
    const dir = tmp();
    HistoryStore.open(sqlite(dir)).close();
    jsonStoreIn(dir, [original(), { id: 'c2', title: 'Two', messages: [] }]);
    const r = await run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /2 chats\b/);
    assert.deepStrictEqual(chatIds(dir), []);
  });

  it('a chat-data.json that cannot be read is refused while there is no marker', async () => {
    for (const text of ['{ not json', JSON.stringify({ chats: 'nope' }), JSON.stringify(['a list'])]) {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'chat-data.json'), text);
      const r = await run(dir);
      assert.strictEqual(r.code, 1, text);
      assert.match(r.err, /chat-data\.json/);
      assert.strictEqual(fs.existsSync(sqlite(dir)), false);
    }
  });

  it('imports when the marker is set, when chat-data.json has no chats, and when there is no chat-data.json', async () => {
    // Moved already: the marker is set, whatever the JSON file says now.
    const moved = tmp();
    const store = HistoryStore.open(sqlite(moved));
    store.setMeta(MIGRATION_MARKER, T);
    store.close();
    jsonStoreIn(moved, [original()]);
    assert.strictEqual((await run(moved)).code, 0);
    assert.deepStrictEqual(chatIds(moved), [SESSION_ID]);

    const empty = tmp();
    jsonStoreIn(empty, []);
    const r = await run(empty);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(chatIds(empty), [SESSION_ID]);

    const none = tmp();
    assert.strictEqual((await run(none)).code, 0);
    assert.deepStrictEqual(chatIds(none), [SESSION_ID]);
  });
});
