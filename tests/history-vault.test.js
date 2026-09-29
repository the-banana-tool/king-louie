// tests/history-vault.test.js
// Vault calls and results are never chunked, so no secret reaches the
// full-text index, the recalled block, SearchHistory or ReadHistory; where a
// Vault call is rendered for the model (tail tool lines, ReadHistory) it
// shows only the action and key.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { chunkMessage, toolUseSummary, UNINDEXED_TOOLS } = require('../src/history/chunker');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { initializeTools, toolRegistry } = require('../src/tools');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();

const SECRET = 'zq7-invented-secret-5550142';
const messages = () => [
  { sender: 'user', text: 'Store the invented test password and then read it back for the form.' },
  { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'store', key: 'signup_password', value: SECRET } },
  { sender: 'toolResult', toolName: 'Vault', result: { ok: true, message: 'Secret "signup_password" stored securely.' } },
  { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'retrieve', key: 'signup_password' } },
  { sender: 'toolResult', toolName: 'Vault', result: { ok: true, key: 'signup_password', value: SECRET }, text: `value ${SECRET}` },
  { sender: 'assistant', text: 'Stored and read back; the form field is filled.' }
];

describe('history: Vault is never indexed or shown', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('UNINDEXED_TOOLS holds Vault; its calls and results make no chunks', () => {
    assert.ok(UNINDEXED_TOOLS.has('Vault'));
    for (const m of messages().filter((x) => x.toolName === 'Vault')) assert.deepStrictEqual(chunkMessage(m), []);
    assert.strictEqual(toolUseSummary(messages()[1]), 'Vault: store signup_password');
  });

  it('searchText, SearchHistory and ReadHistory never return the secret; the tail line shows action and key', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: messages() });
    assert.deepStrictEqual(t.store.searchText(SECRET, {}), []);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks WHERE text LIKE ?').get(`%${SECRET}%`).n, 0);
    db.close();

    const estimator = new TokenEstimator();
    const retriever = new Retriever({ store: t.store, estimator });
    const history = { chatId: 'chat-1', store: t.store, retriever, estimator, getSettings: () => ({}) };
    const found = await toolRegistry.get('SearchHistory').execute({ query: SECRET }, { history });
    assert.ok(!JSON.stringify(found).includes(SECRET));
    const read = await toolRegistry.get('ReadHistory').execute({ fromSeq: 1, toSeq: 6 }, { history });
    assert.strictEqual(read.ok, true);
    assert.ok(!read.text.includes(SECRET), read.text);
    assert.match(read.text, /signup_password/);

    const builder = new ContextBuilder({ store: t.store, retriever, estimator, getSettings: () => ({}) });
    const built = await builder.build({ chatId: 'chat-1', message: `what is ${SECRET}?` });
    const sent = JSON.stringify(built.tail) + built.recalled.text;
    assert.ok(!sent.replace(`what is ${SECRET}?`, '').includes(SECRET), sent);
    assert.match(built.tail[built.tail.length - 1].text, /\[tool\] Vault: retrieve signup_password/);
  });

  it('the backfill of a version-1 store skips Vault messages too', () => {
    t = openTempStore();
    seedChat(t.store, { messages: messages() });
    t.store.close();
    const raw = new DatabaseSync(t.dbPath);
    raw.exec(`DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
      DROP TABLE chunks_fts; DROP TABLE chunks; DROP TABLE calibration;
      UPDATE schema_version SET version = 1;`);
    raw.close();
    t.store = HistoryStore.open(t.dbPath);
    t.store.backfillChunks();
    assert.deepStrictEqual(t.store.searchText(SECRET, {}), []);
    assert.ok(t.store.searchText('invented test password', {}).length > 0, 'the rest is indexed');
  });
});
