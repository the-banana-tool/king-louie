// tests/desktop-source-history.test.js
// Desktop import reads a profile's chats from history.sqlite, through a
// read-only connection and node:sqlite's online backup into a private
// snapshot, plus any chats still in chat-data.json.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { createSafeReader, readDesktopSource } = require('../src/migration/desktop-source');
const { readHistoryChats } = require('../src/migration/desktop-history');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const msg = { id: 'm1', sender: 'user', text: 'the Lakeside lot', timestamp: '2026-09-20T10:00:00.000Z' };
const msgN = (i, prefix) => ({ id: `${prefix}-${i}`, sender: i % 2 ? 'assistant' : 'user', text: `note ${i} about the Lakeside lot`, timestamp: '2026-09-20T10:00:00.000Z' });

async function readSource(root) {
  const reader = createSafeReader({ root });
  const history = await readHistoryChats({ reader, tmpRoot: tempDir('kl-copy-') });
  return readDesktopSource({ userDataDir: root, reader, secrets: 'needs-desktop', history });
}

describe('desktop import and history.sqlite', () => {
  it('reads chats from history.sqlite and the ones still in chat-data.json', async () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'Moved', updatedAt: '2026-09-20T10:00:00.000Z', messages: [msg] });
    store.close();
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({
      chats: [{ id: 'left', title: 'Left behind', messages: [] }, { id: 'c1', title: 'Stale copy', messages: [] }]
    }));

    const source = await readSource(root);

    assert.deepStrictEqual(source.inventory.chats.map((c) => [c.id, c.title]), [['c1', 'Moved'], ['left', 'Left behind']]);
    const value = source.getValue('chat', 'c1');
    assert.deepStrictEqual(value.messages, [msg]);
    assert.strictEqual(value.messageCount, undefined);
    assert.deepStrictEqual(source.attention, []);
  });

  it('a backup of a store with an open writer connection yields all chats', async () => {
    const root = tempDir('kl-desktop-');
    const live = HistoryStore.open(path.join(root, 'history.sqlite'));
    stores.push(live);
    live.createChat({ id: 'first', title: 'Checkpointed', messages: [msg] });
    live.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    live.createChat({ id: 'fresh', title: 'Only in the WAL', messages: Array.from({ length: 50 }, (_, i) => msgN(i, 'fresh')) });
    for (let i = 0; i < 20; i += 1) live.createChat({ id: `more-${i}`, title: `More ${i}`, messages: [msgN(i, `more-${i}`)] });

    const { found, chats, attention } = await readHistoryChats({ reader: createSafeReader({ root }), tmpRoot: tempDir('kl-copy-') });

    assert.strictEqual(found, true);
    assert.deepStrictEqual(attention, []);
    assert.strictEqual(chats.length, 22);
    assert.deepStrictEqual(chats.map((c) => c.id).sort(), live.listChats().map((c) => c.id).sort());
    assert.strictEqual(chats.find((c) => c.id === 'fresh').messages.length, 50);
    // The writer is untouched and keeps writing.
    live.createChat({ id: 'after', title: 'After the import', messages: [] });
    assert.ok(live.getChat('after'));
  });

  it('snapshots with node:sqlite backup over a read-only connection, never reading the file as bytes', async () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'One', messages: [msg] });
    store.close();
    const calls = [];
    const backup = async (db, dest) => {
      calls.push(dest);
      assert.throws(() => db.exec("INSERT INTO meta (key, value) VALUES ('probe', 'x')"), /readonly|read-only/i);
      return sqlite.backup(db, dest);
    };
    const reader = { ...createSafeReader({ root }), readFile: () => assert.fail('history.sqlite is never read as bytes') };
    const { chats } = await readHistoryChats({ reader, tmpRoot: tempDir('kl-copy-'), backup });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(chats.map((c) => c.id), ['c1']);
  });

  it('removes its private snapshot', async () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'One', messages: [] });
    store.close();
    const tmpRoot = tempDir('kl-copy-');
    await readHistoryChats({ reader: createSafeReader({ root }), tmpRoot });
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
  });

  it('reports an unreadable history.sqlite and still reads chat-data.json', async () => {
    const root = tempDir('kl-desktop-');
    fs.writeFileSync(path.join(root, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [{ id: 'left', title: 'Left behind', messages: [] }] }));
    const source = await readSource(root);
    assert.deepStrictEqual(source.inventory.chats.map((c) => c.id), ['left']);
    assert.strictEqual(source.attention.length, 1);
    assert.strictEqual(source.attention[0].key, 'history.sqlite');
    assert.match(source.attention[0].note, /could not be read/);
  });

  it('refuses a history.sqlite with a second hard link and never opens it', async () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'One', messages: [] });
    store.close();
    fs.linkSync(path.join(root, 'history.sqlite'), path.join(tempDir('kl-elsewhere-'), 'linked.sqlite'));
    const { found, chats, attention } = await readHistoryChats({ reader: createSafeReader({ root }), tmpRoot: tempDir('kl-copy-') });
    assert.strictEqual(found, false);
    assert.deepStrictEqual(chats, []);
    assert.strictEqual(attention.length, 1);
    assert.strictEqual(attention[0].key, 'history.sqlite');
    assert.match(attention[0].note, /hard links/);
  });

  it('reads chat-data.json alone for a profile that never had history.sqlite', async () => {
    const root = tempDir('kl-desktop-');
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [{ id: 'old', title: 'Old', messages: [] }] }));
    const source = await readSource(root);
    assert.deepStrictEqual(source.inventory.chats.map((c) => c.id), ['old']);
    assert.deepStrictEqual(source.attention, []);
  });
});
