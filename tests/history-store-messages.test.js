// tests/history-store-messages.test.js
// appendMessage, truncateFrom and getMessages keep seq dense from 1
// (recall spec §4.1, §5.1 for the one-transaction append).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { HistoryStore } = require('../src/history');

const stores = [];
afterEach(() => { while (stores.length) stores.pop().close(); });
function memory(StoreClass = HistoryStore) {
  const store = StoreClass.open(':memory:');
  stores.push(store);
  return store;
}
const msg = (id, sender, text, extra = {}) => ({ id, sender, text, timestamp: '2026-09-29T10:00:00.000Z', ...extra });
const seqs = (store, chatId) => store.getMessages(chatId).map((m) => m.seq);

describe('HistoryStore messages', () => {
  it('appends at the next seq, updates updatedAt and merges the patch', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', updatedAt: '2026-09-01T00:00:00.000Z', messages: [msg('m1', 'assistant', 'How can I help you?')] });
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', name: 'a.png' };
    const result = store.appendMessage('c1', msg('m2', 'user', 'hello', { images: [image] }), {
      updatedAt: '2026-09-29T11:00:00.000Z',
      patch: { llmTotals: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 } }
    });
    assert.strictEqual(result.seq, 2);
    assert.deepStrictEqual(result.message, { ...msg('m2', 'user', 'hello', { images: [image] }), seq: 2 });
    const chat = store.getChat('c1', { messages: false });
    assert.strictEqual(chat.updatedAt, '2026-09-29T11:00:00.000Z');
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 });
    assert.deepStrictEqual(seqs(store, 'c1'), [1, 2]);
  });

  it('uses the message timestamp when no updatedAt is given, and lets the patch win', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One' });
    store.appendMessage('c1', msg('m1', 'user', 'a'));
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, '2026-09-29T10:00:00.000Z');
    store.appendMessage('c1', msg('m2', 'user', 'b'), { updatedAt: 'x', patch: { updatedAt: 'from-patch' } });
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, 'from-patch');
  });

  it('returns null for an unknown chat and writes nothing', () => {
    const store = memory();
    assert.strictEqual(store.appendMessage('missing', msg('m1', 'user', 'x')), null);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  });

  it('throws on an invalid message and leaves the chat as it was', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', updatedAt: 'before' });
    assert.throws(() => store.appendMessage('c1', { text: 'no sender' }, { updatedAt: 'after' }), /sender/);
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, 'before');
    assert.deepStrictEqual(seqs(store, 'c1'), []);
  });

  it('truncateFrom removes seq >= n with their attachments, and the next append reuses n', () => {
    const store = memory();
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b'), msg('m3', 'user', 'c', { images: [image] })] });
    assert.strictEqual(store.truncateFrom('c1', 2), 2);
    assert.deepStrictEqual(seqs(store, 'c1'), [1]);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
    assert.strictEqual(store.appendMessage('c1', msg('m4', 'user', 'again')).seq, 2);
    assert.strictEqual(store.truncateFrom('c1', 99), 0);
    assert.throws(() => store.truncateFrom('c1', 0), RangeError);
    assert.throws(() => store.truncateFrom('c1', 1.5), RangeError);
  });

  it('getMessages reads an inclusive range with a limit', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', messages: ['a', 'b', 'c', 'd', 'e'].map((t, i) => msg(`m${i}`, 'user', t)) });
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 2, toSeq: 4 }).map((m) => m.text), ['b', 'c', 'd']);
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 3 }).map((m) => m.seq), [3, 4, 5]);
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 2, limit: 2 }).map((m) => m.seq), [2, 3]);
    assert.deepStrictEqual(store.getMessages('missing'), []);
    assert.strictEqual(store.messageCount('c1'), 5);
    assert.strictEqual(store.messageCount('missing'), 0);
  });

  it('gives a copied chat fresh ids for message ids already stored (review focus 1)', () => {
    const store = memory();
    const messages = [msg('shared-1', 'user', 'blue folder'), msg('shared-2', 'assistant', 'noted')];
    store.createChat({ id: 'source', title: 'Source', messages });
    store.createChat({ id: 'copy', title: 'Source (copy)', messages }, { position: 'back' });
    const copy = store.getChat('copy').messages;
    assert.deepStrictEqual(copy.map((m) => m.text), ['blue folder', 'noted']);
    assert.ok(copy.every((m) => !m.id.startsWith('shared-')), 'the copy got its own ids');
    assert.deepStrictEqual(store.getChat('source').messages.map((m) => m.id), ['shared-1', 'shared-2']);
    const appended = store.appendMessage('copy', msg('shared-1', 'user', 'again'));
    assert.notStrictEqual(appended.message.id, 'shared-1');
  });

  it('runs work a subclass adds in _insertMessage inside the same transaction (the H2 seam)', () => {
    class Probe extends HistoryStore {
      _insertMessage(db, chatId, message, options) {
        const result = super._insertMessage(db, chatId, message, options);
        db.prepare('INSERT INTO probe (message_id) VALUES (?)').run(result.id);
        if (message.text === 'fail') throw new Error('probe failed');
        return result;
      }
    }
    const store = memory(Probe);
    assert.ok(store instanceof Probe);
    store.db.exec('CREATE TABLE probe (message_id TEXT)');
    store.createChat({ id: 'c1', title: 'One' });
    store.appendMessage('c1', msg('m1', 'user', 'ok'));
    assert.throws(() => store.appendMessage('c1', msg('m2', 'user', 'fail')), /probe failed/);
    assert.deepStrictEqual(store.db.prepare('SELECT message_id FROM probe').all().map((r) => r.message_id), ['m1']);
    assert.deepStrictEqual(seqs(store, 'c1'), [1]);
  });
});
