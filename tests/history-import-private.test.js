// tests/history-import-private.test.js
// An import adds the private mark and never removes one (local inference
// spec 2026-10-13 §8.2, §8.6; R-LI-28): a King Louie export that says
// "private": true is imported private, and so is any file imported with
// asPrivate (the dialog's "Import as private"); the chat is private before
// its first message is written, so no hosted embedder ever has its chunks
// pending. An export cannot clear a mark. A LongHaul import of a private
// export is a private session.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { importChat, createImportGate, parseImport } = require('../src/history/import-chats');
const { importRequest } = require('../src/ipc/import-picks');
const { main } = require('../src/longhaul/cli');
const { loadSession } = require('../src/longhaul/session-format');
const { openTempStore } = require('./helpers/history-fixture');
const { tmpHome, tmpDir, sink } = require('./helpers/longhaul-helpers');

const HOSTED_KEY = 'openai:text-embedding-3-small';
const AT = '2026-10-13T09:00:00.000Z';

function exportFile({ id = 'chat-fence', private: mark, dir = tmpDir(), name = 'fence.json' } = {}) {
  const chat = {
    id,
    title: 'Fence repair',
    createdAt: AT,
    updatedAt: AT,
    ...(mark !== undefined ? { private: mark } : {}),
    messages: [
      { sender: 'user', text: 'The side gate key is under the blue pot.', timestamp: AT },
      { sender: 'assistant', text: 'Noted: the key is under the blue pot by the side gate.', timestamp: AT }
    ]
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(chat));
  return file;
}

// Every append of the import checked the chat's mark at that moment.
function watchAppends(store) {
  const seen = [];
  store.onAppend((chatId) => seen.push(store.isPrivate(chatId)));
  return seen;
}
const pendingFor = (store, chatId) => store.pendingEmbeddings(HOSTED_KEY, { limit: 1000 }).filter((c) => c.chatId === chatId);

describe('importing under the private mark', () => {
  let t;
  afterEach(() => { if (t) t.cleanup(); t = null; });

  it('R-LI-28: an export that says private is imported private, before its first message', async () => {
    t = openTempStore();
    const file = exportFile({ private: true });
    const parsed = await parseImport(file);
    assert.strictEqual(parsed.chat.private, true);
    const seen = watchAppends(t.store);
    const out = await importChat({ store: t.store, filePath: file });
    assert.strictEqual(out.imported, true);
    assert.strictEqual(t.store.isPrivate(out.chatId), true);
    assert.ok(seen.length > 0 && seen.every((p) => p === true), 'every append saw a private chat');
    assert.deepStrictEqual(pendingFor(t.store, out.chatId), [], 'a hosted embedder has none of its chunks pending');
  });

  it('only exactly true counts in the export; an ordinary export imports as an ordinary chat', async () => {
    t = openTempStore();
    for (const [mark, name] of [['yes', 'a.json'], [1, 'b.json'], [undefined, 'c.json']]) {
      const file = exportFile({ private: mark, name, id: `chat-${name}` });
      const out = await importChat({ store: t.store, filePath: file });
      assert.strictEqual(t.store.isPrivate(out.chatId), false, String(mark));
    }
  });

  it('asPrivate imports any file private, and the commit request carries it only when exactly true', async () => {
    t = openTempStore();
    const file = exportFile({});
    const seen = watchAppends(t.store);
    const out = await importChat({ store: t.store, filePath: file, asPrivate: true });
    assert.strictEqual(t.store.isPrivate(out.chatId), true);
    assert.ok(seen.every((p) => p === true));
    assert.strictEqual(importRequest({ token: 'x', asPrivate: true }).asPrivate, true);
    assert.strictEqual(importRequest({ token: 'x', asPrivate: 'true' }).asPrivate, false);
    assert.strictEqual(importRequest({ token: 'x' }).asPrivate, false);
  });

  it('the batch path (an attached desktop) takes the mark with the chat at begin', () => {
    t = openTempStore();
    const gate = createImportGate({ getStore: () => t.store });
    const begun = gate.begin({
      kind: 'king-louie-json', sourceHash: 'a'.repeat(64), chat: { id: 'kl-batch', title: 'Fence repair', private: true }, total: 1
    });
    assert.strictEqual(t.store.isPrivate(begun.chatId), true);
    gate.append({ importId: begun.importId, messages: [{ sender: 'user', text: 'The side gate key is under the blue pot.', timestamp: AT }] });
    gate.finish({ importId: begun.importId });
    assert.strictEqual(t.store.isPrivate(begun.chatId), true);
  });

  it('R-LI-28: an export cannot clear a mark: one saying private false next to a private chat of the same id is a second chat', async () => {
    t = openTempStore();
    t.store.createChat({ id: 'kl-chat-fence', title: 'Fence repair', createdAt: AT, updatedAt: AT, messages: [] }, { private: true });
    const out = await importChat({ store: t.store, filePath: exportFile({ private: false }) });
    assert.notStrictEqual(out.chatId, 'kl-chat-fence');
    assert.strictEqual(t.store.isPrivate('kl-chat-fence'), true);
    assert.strictEqual(t.store.isPrivate(out.chatId), false);
  });

  it('the same file imported again with asPrivate marks the chat it returns', async () => {
    t = openTempStore();
    const file = exportFile({});
    const first = await importChat({ store: t.store, filePath: file });
    assert.strictEqual(t.store.isPrivate(first.chatId), false);
    const again = await importChat({ store: t.store, filePath: file, asPrivate: true });
    assert.strictEqual(again.imported, false);
    assert.strictEqual(again.chatId, first.chatId);
    assert.strictEqual(t.store.isPrivate(first.chatId), true);
  });
});

describe('longhaul import of a private export', () => {
  async function run(argv, env) {
    const stdout = sink();
    const stderr = sink();
    const code = await main(argv, { stdout, stderr, env });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  it('is a private session, and --public is refused for it', async () => {
    const { env, root } = tmpHome();
    const file = exportFile({ private: true, dir: tmpDir() });
    const pub = await run(['import', file, '--id', 'P', '--public', '--license', 'CC-BY-4.0'], env);
    assert.notStrictEqual(pub.code, 0);
    assert.match(pub.stderr, /private/);
    assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'P')), false);
    const r = await run(['import', file, '--id', 'Q'], env);
    assert.strictEqual(r.code, 0, r.stderr);
    const s = await loadSession(path.join(root, 'sessions', 'Q'));
    assert.strictEqual(s.manifest.private, true);
  });
});
