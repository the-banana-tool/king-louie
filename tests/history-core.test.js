// tests/history-core.test.js
// createCore opens <dataDir>/history.sqlite, moves chat-data.json's chats
// into it, reports a store that will not open, and closes it on shutdown
// (recall spec §4.4, §11.1, §15).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { createCore } = require('../src/core');
const { HistoryStore } = require('../src/history');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps(chats = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-core-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  store.set('chats', chats);
  return {
    dataDir,
    deps: {
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}
const T = '2026-09-28T10:00:00.000Z';
const msg = (id, sender, text) => ({ id, sender, text, timestamp: T });
const backups = (dir) => fs.readdirSync(dir).filter((f) => /^chat-data\.backup-.*\.json$/.test(f));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('createCore and the history store', () => {
  it('opens <dataDir>/history.sqlite and moves the JSON chats into it at construction', () => {
    const { dataDir, deps } = makeDeps([
      { id: 'c1', title: 'Lakeside lot', messages: [msg('m1', 'user', 'blue folder'), msg('m2', 'assistant', 'noted')] },
      { id: 'c2', title: 'Second', messages: [] }
    ]);
    const core = createCore(deps);
    const store = core.context.getHistoryStore();
    assert.ok(store instanceof HistoryStore);
    assert.strictEqual(core.context.historyStore, store);
    assert.strictEqual(store.dbPath, path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(core.context.listChats().map((c) => [c.id, c.messageCount]), [['c1', 2], ['c2', 0]]);
    assert.deepStrictEqual(deps.store.get('chats'), []);
    assert.strictEqual(backups(dataDir).length, 1);
    assert.deepStrictEqual(core.context.getHistoryStatus(), { available: true, error: null, migrationFailed: 0 });
  });

  it('reports how many chats could not be moved and leaves them in chat-data.json', () => {
    const bad = { id: 'bad', title: 'Bad', messages: 'not a list' };
    const { deps } = makeDeps([{ id: 'good', title: 'Good', messages: [] }, bad]);
    const core = createCore(deps);
    assert.strictEqual(core.context.getHistoryStatus().migrationFailed, 1);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['good']);
    assert.deepStrictEqual(deps.store.get('chats'), [bad]);
  });

  it('uses deps.history.dbPath when given', () => {
    const { dataDir, deps } = makeDeps();
    const other = path.join(dataDir, 'elsewhere', 'custom.sqlite');
    const core = createCore({ ...deps, history: { dbPath: other } });
    assert.strictEqual(core.context.getHistoryStore().dbPath, other);
    assert.ok(fs.existsSync(other));
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
  });

  it('never reads or changes an old chat-history.sqlite', () => {
    const { dataDir, deps } = makeDeps([{ id: 'from-json', title: 'From JSON', messages: [] }]);
    const blobFile = path.join(dataDir, 'chat-history.sqlite');
    const blob = new DatabaseSync(blobFile);
    blob.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO chats VALUES ('from-blob', 0, '{"id":"from-blob","title":"Blob","messages":[]}');`);
    blob.close();
    const before = sha(blobFile);
    const core = createCore(deps);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['from-json']);
    assert.strictEqual(sha(blobFile), before);
  });

  it('reports a store that will not open, leaves chat-data.json alone, and still starts', async () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Kept in JSON', messages: [] }]);
    fs.writeFileSync(path.join(dataDir, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    const core = createCore(deps);
    const status = core.context.getHistoryStatus();
    assert.strictEqual(status.available, false);
    assert.match(status.error, /not a database/);
    assert.throws(() => core.context.listChats(), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.throws(() => core.context.appendMessageToChat('c1', 'user', 'hi'), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.strictEqual(deps.store.get('chats').length, 1);
    assert.deepStrictEqual(backups(dataDir), []);
    await core.start();
    await core.shutdown();
  });

  it('opens nothing and moves nothing with history.open false', () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Stays', messages: [] }]);
    const core = createCore({ ...deps, history: { open: false } });
    assert.strictEqual(core.context.getHistoryStatus().available, false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
    assert.strictEqual(deps.store.get('chats').length, 1);
  });

  it('appends messages as rows and closes the store on shutdown', async () => {
    const { dataDir, deps } = makeDeps();
    const core = createCore(deps);
    core.context.createChat({ id: 'c1', title: 'One', messages: [] });
    const chat = core.context.appendMessageToChat('c1', 'user', 'hello');
    assert.deepStrictEqual(chat.messages.map((m) => [m.seq, m.text]), [[1, 'hello']]);
    await core.start();
    await core.shutdown();
    assert.strictEqual(core.context.getHistoryStore().isOpen, false);
    const reopened = HistoryStore.open(path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(reopened.getMessages('c1').map((m) => m.text), ['hello']);
    reopened.close();
  });

  it('exposes the context builder, token estimator and retriever over the store', () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    const { getContextBuilder, getTokenEstimator, getHistoryRetriever } = core.context;
    assert.strictEqual(typeof getContextBuilder().build, 'function');
    assert.strictEqual(typeof getTokenEstimator().estimate, 'function');
    assert.strictEqual(typeof getHistoryRetriever().retrieve, 'function');
  });

  it('chunks new messages with the chunk sizes in settings.history.chunk', () => {
    const { deps } = makeDeps();
    deps.store.set('settings', { history: { chunk: { targetChars: 200, minChars: 50 } } });
    const core = createCore(deps);
    core.context.createChat({ id: 'c1', title: 'One', messages: [] });
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about the lakeside gate and fence. `.repeat(3)).join('\n\n');
    core.context.appendMessageToChat('c1', 'user', paragraphs, {}, { returnChat: false });
    const store = core.context.getHistoryStore();
    const [message] = store.getMessages('c1');
    assert.ok(store.chunksOfMessage(message.id).length > 3);
  });
});
