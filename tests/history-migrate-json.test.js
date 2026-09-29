// tests/history-migrate-json.test.js
// The one-way move of chat-data.json's chats into history.sqlite (recall
// spec §11.1, §13 "migration", §15 "Migration of one chat fails").
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, migrateFromJson, MIGRATION_MARKER } = require('../src/history');
const { JsonFileStore } = require('../src/platform/json-file-store');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const NOW = '2026-09-29T12:00:00.000Z';
const BACKUP = 'chat-data.backup-2026-09-29T12-00-00-000Z.json';
const msg = (id, sender, text) => ({ id, sender, text, timestamp: '2026-09-28T10:00:00.000Z' });

function setup(chats, { extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-migrate-'));
  dirs.push(dir);
  const jsonStore = new JsonFileStore({ dir, name: 'chat-data', defaults: {} });
  jsonStore.set('activeChatId', 'c1');
  for (const [k, v] of Object.entries(extra)) jsonStore.set(k, v);
  jsonStore.set('chats', chats);
  const historyStore = HistoryStore.open(path.join(dir, 'history.sqlite'));
  stores.push(historyStore);
  const lines = [];
  const log = {
    info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]), debug: () => {}
  };
  // One tick per run: the first run's stamp is NOW, the next one a second later.
  let tick = 0;
  const now = () => new Date(Date.parse(NOW) + 1000 * tick++).toISOString();
  const run = () => migrateFromJson({ historyStore, jsonStore, jsonPath: jsonStore.path, log, now });
  return { dir, jsonStore, historyStore, lines, run };
}
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('chat-data.backup-'));

describe('migrateFromJson', () => {
  it('moves every chat in order, backs the file up first and sets the marker', () => {
    const chats = [
      { id: 'c1', title: 'Lakeside lot', llmTotals: { inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.001 }, messages: [msg('m1', 'user', 'blue folder'), msg('m2', 'assistant', 'noted')] },
      { id: 'c2', title: 'Second', messages: [] },
      { id: 'c3', title: 'No messages key' }
    ];
    const { dir, jsonStore, historyStore, run } = setup(chats);
    const before = fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8');

    assert.deepStrictEqual(run(), { migrated: 3, failed: [] });

    assert.deepStrictEqual(backups(dir), [BACKUP]);
    assert.strictEqual(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), before, 'the backup is the file as it was');
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['c1', 'c2', 'c3']);
    const c1 = historyStore.getChat('c1');
    assert.deepStrictEqual(c1.messages.map(({ seq, ...m }) => [seq, m]), [[1, chats[0].messages[0]], [2, chats[0].messages[1]]]);
    assert.deepStrictEqual(c1.llmTotals, chats[0].llmTotals);
    assert.deepStrictEqual(jsonStore.get('chats'), []);
    assert.strictEqual(readJson(dir).activeChatId, 'c1', 'everything but chats stays in chat-data.json');
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), NOW);
  });

  it('does nothing once the marker is set, even if chats reappear in the JSON file', () => {
    const { dir, jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [] }]);
    run();
    historyStore.deleteChat('c1');
    jsonStore.set('chats', [{ id: 'c1', title: 'One', messages: [] }]);
    assert.deepStrictEqual(run(), { migrated: 0, failed: [] });
    assert.deepStrictEqual(historyStore.listChats(), []);
    assert.deepStrictEqual(backups(dir), [BACKUP], 'no second backup');
  });

  it('sets the marker at once for an empty array, with no backup', () => {
    const { dir, historyStore, run } = setup([]);
    assert.deepStrictEqual(run(), { migrated: 0, failed: [] });
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), NOW);
    assert.deepStrictEqual(backups(dir), []);
  });

  it('leaves broken chats in the JSON array, moves the rest, reports and logs each, and resumes', () => {
    const good = { id: 'good', title: 'Good', messages: [msg('g1', 'user', 'fine')] };
    const badMessages = { id: 'bad-messages', title: 'Bad', messages: 'not a list' };
    const noSender = { id: 'no-sender', title: 'Bad', messages: [msg('n1', 'user', 'ok'), { id: 'n2', text: 'orphan' }] };
    const noId = { title: 'No id', messages: [] };
    const { jsonStore, historyStore, lines, run } = setup([good, badMessages, noSender, noId, 'not a chat']);

    const result = run();

    assert.strictEqual(result.migrated, 1);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['bad-messages', 'no-sender', '#3', '#4']);
    assert.ok(result.failed.every((f) => typeof f.error === 'string' && f.error));
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['good']);
    assert.strictEqual(historyStore.getChat('no-sender'), null, 'a failed chat leaves nothing half-written');
    assert.deepStrictEqual(jsonStore.get('chats'), [badMessages, noSender, noId, 'not a chat']);
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), null);
    assert.strictEqual(lines.filter(([level]) => level === 'error').length, 4);

    jsonStore.set('chats', [{ ...noSender, messages: [msg('n1', 'user', 'ok')] }]);
    assert.deepStrictEqual(run(), { migrated: 1, failed: [] });
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['good', 'no-sender']);
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), '2026-09-29T12:00:01.000Z');
  });

  it('counts a chat committed before a crash as moved, without duplicating it (review focus 5)', () => {
    const chat = { id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b')] };
    const { jsonStore, historyStore, run } = setup([chat, { id: 'c2', title: 'Two', messages: [] }]);
    historyStore.createChat(chat, { position: 'back' });

    assert.deepStrictEqual(run(), { migrated: 2, failed: [] });
    assert.deepStrictEqual(historyStore.listChats().map((c) => [c.id, c.messageCount]), [['c1', 2], ['c2', 0]]);
    assert.deepStrictEqual(jsonStore.get('chats'), []);
  });

  it('fails a chat already stored with a different message count', () => {
    const { jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a')] }]);
    historyStore.createChat({ id: 'c1', title: 'One', messages: [] });
    const result = run();
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.match(result.failed[0].error, /already/);
    assert.strictEqual(jsonStore.get('chats').length, 1);
  });

  it('fails the second of two chats with the same id', () => {
    const { jsonStore, run } = setup([{ id: 'c1', title: 'First', messages: [] }, { id: 'c1', title: 'Second', messages: [] }]);
    const result = run();
    assert.strictEqual(result.migrated, 1);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.deepStrictEqual(jsonStore.get('chats').map((c) => c.title), ['Second']);
  });

  it('moves a desktop-import copy that shares message ids with its source (review focus 1)', () => {
    const messages = [msg('shared-1', 'user', 'blue folder')];
    const { historyStore, run } = setup([
      { id: 'c1', title: 'Source', messages },
      { id: 'c1-copy', title: 'Source (copy)', messages }
    ]);
    assert.deepStrictEqual(run(), { migrated: 2, failed: [] });
    assert.strictEqual(historyStore.getChat('c1-copy').messages[0].text, 'blue folder');
  });

  it('moves nothing when the backup cannot be written', () => {
    const { dir, jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [] }]);
    fs.writeFileSync(path.join(dir, BACKUP), 'an older backup with the same name');
    const result = run();
    assert.strictEqual(result.migrated, 0);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.match(result.failed[0].error, /backup/);
    assert.deepStrictEqual(historyStore.listChats(), []);
    assert.strictEqual(jsonStore.get('chats').length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), 'an older backup with the same name');
  });

  it('reports a chats value that is not a list and changes nothing', () => {
    const { jsonStore, historyStore, run } = setup({ oops: true });
    const result = run();
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['chats']);
    assert.deepStrictEqual(jsonStore.get('chats'), { oops: true });
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), null);
  });
});
