// tests/history-search.test.js
// Full-text search over chunks (recall spec §6.3 step 1, §15 FTS row).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { openTempStore, seedChat } = require('./helpers/history-fixture');
const { ftsQuery } = require('../src/history/chunk-index');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

describe('history search', () => {
  let t;
  before(() => {
    t = openTempStore();
    seedChat(t.store, {
      messages: [
        { sender: 'user', text: GATE },
        { sender: 'assistant', text: 'Noted. I will edit src/app.js and check config.yaml before the deploy.' },
        { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'npm test' } },
        { sender: 'toolResult', toolName: 'Bash', result: { ok: true, stdout: 'all 12 tests passed for src/app.js on the first run' } },
        { sender: 'user', text: 'Unrelated message about the grocery list and the garden hose timer.' }
      ]
    });
    seedChat(t.store, { id: 'chat-2', messages: [{ sender: 'user', text: 'The gate code for the other property is 9001, not the Lakeside one.' }] });
  });
  after(() => t.cleanup());

  const messageOf = (hits) => t.store.chunks(hits.map((h) => h.chunkId)).map((c) => c.messageId);

  it('ranks by BM25, terms OR-ed, within the given chats', () => {
    const hits = t.store.searchText('what was the gate code?', { chatIds: ['chat-1'] });
    assert.ok(hits.length >= 1);
    assert.strictEqual(messageOf(hits)[0], 'chat-1-m1');
    assert.ok(!messageOf(hits).some((id) => id.startsWith('chat-2')));
    for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score);
    assert.ok(hits[0].score > 0);
  });

  it('keeps quoted phrases as phrases', () => {
    assert.strictEqual(ftsQuery('"gate code" 4417'), '"gate code" OR "4417"');
    const hits = t.store.searchText('"code at the Lakeside"', {});
    assert.deepStrictEqual(messageOf(hits), ['chat-1-m1']);
  });

  it('matches a filename typed with sentence punctuation after it', () => {
    assert.strictEqual(ftsQuery('check config.yaml.'), '"check" OR "config.yaml"');
    assert.deepStrictEqual(messageOf(t.store.searchText('config.yaml.', {})), ['chat-1-m2']);
    assert.deepStrictEqual(messageOf(t.store.searchText('did you change config.yaml?', { kinds: ['assistant'] })), ['chat-1-m2']);
    assert.deepStrictEqual(messageOf(t.store.searchText('src/app.js', { kinds: ['tool_result'] })), ['chat-1-m4']);
  });

  it('a file name alone finds a stored path, and the full path matches as a phrase', () => {
    assert.deepStrictEqual(messageOf(t.store.searchText('app.js', { kinds: ['tool_result'] })), ['chat-1-m4']);
    assert.deepStrictEqual(messageOf(t.store.searchText('did we change app.js?', { kinds: ['assistant'] })), ['chat-1-m2']);
    assert.deepStrictEqual(messageOf(t.store.searchText('"src/app.js"', { kinds: ['assistant'] })), ['chat-1-m2']);
    assert.deepStrictEqual(t.store.searchText('"lib/app.js"', {}), [], 'the phrase needs the whole path');
  });

  it('keeps a leading or trailing dash: a flag like --user-data-dir is one token', () => {
    const f = openTempStore();
    try {
      seedChat(f.store, { messages: [
        { sender: 'user', text: 'Launch it with --user-data-dir set to a temp folder.' },
        { sender: 'assistant', text: 'The user data folder is where the profile lives.' }
      ] });
      assert.strictEqual(ftsQuery('--user-data-dir?'), '"--user-data-dir?"');
      const hits = f.store.searchText('what did we pass to --user-data-dir?', {});
      assert.strictEqual(f.store.chunks(hits.map((h) => h.chunkId))[0].messageId, 'chat-1-m1');
    } finally {
      f.cleanup();
    }
  });

  it('never throws on FTS syntax, punctuation or unbalanced quotes', () => {
    for (const q of ['"', '*', 'NEAR(', 'col:x', 'what" is', '...', '   ', 'OR AND NOT', '^4417', '(gate']) {
      assert.doesNotThrow(() => t.store.searchText(q, {}), q);
      assert.ok(Array.isArray(t.store.searchText(q, {})));
    }
    assert.strictEqual(ftsQuery('...'), '');
    assert.deepStrictEqual(t.store.searchText('', {}), []);
  });

  it('filters by kinds, messageIds and upToSeq, and honours limit', () => {
    assert.deepStrictEqual(t.store.searchText('4417', { chatIds: ['chat-1'], upToSeq: 1 }), []);
    assert.strictEqual(t.store.searchText('4417', { chatIds: ['chat-1'], upToSeq: 2 }).length, 1);
    assert.deepStrictEqual(messageOf(t.store.searchText('src/app.js', { messageIds: ['chat-1-m2'] })), ['chat-1-m2']);
    assert.strictEqual(t.store.searchText('gate', { limit: 1 }).length, 1);
  });

  it('chunks(ids) returns rows in the order asked, with seq, sender and tool name', () => {
    const [a] = t.store.searchText('4417', { chatIds: ['chat-1'] });
    const [b] = t.store.searchText('npm', {});
    const rows = t.store.chunks([b.chunkId, 999999, a.chunkId]);
    assert.deepStrictEqual(rows.map((r) => r.id), [b.chunkId, a.chunkId]);
    assert.deepStrictEqual({ ...rows[1] }, {
      id: a.chunkId, messageId: 'chat-1-m1', chatId: 'chat-1', seq: 1, idx: 0, kind: 'user', text: GATE,
      chars: GATE.length, ts: '2026-01-01T09:00:00.000Z', sender: 'user', toolName: null
    });
    assert.strictEqual(rows[0].toolName, 'Bash');
    assert.deepStrictEqual(t.store.chunks([]), []);
  });

  it('counts: chunksOfMessage, messageChunkCounts, lastSeq, historyChars', () => {
    assert.deepStrictEqual(t.store.chunksOfMessage('chat-1-m1').map((c) => c.idx), [0]);
    const counts = t.store.messageChunkCounts(['chat-1-m1', 'chat-1-m3', 'nope']);
    assert.strictEqual(counts.get('chat-1-m1'), 1);
    assert.strictEqual(counts.get('nope'), undefined);
    assert.strictEqual(t.store.lastSeq('chat-1'), 5);
    assert.strictEqual(t.store.lastSeq('missing'), 0);
    assert.strictEqual(t.store.historyChars('chat-1', { upToSeq: 2 }), GATE.length);
    assert.ok(t.store.historyChars('chat-1') > GATE.length);
  });

  it('calibration round trip', () => {
    assert.strictEqual(t.store.calibration('test-model'), null);
    t.store.setCalibration('test-model', 3.6, 2);
    assert.deepStrictEqual({ ...t.store.calibration('test-model') }, { model: 'test-model', charsPerToken: 3.6, samples: 2 });
  });

  it('a residual SQLite error is logged and returns no hits', () => {
    const broken = openTempStore();
    try {
      seedChat(broken.store, { messages: [{ sender: 'user', text: GATE }] });
      broken.store.db.exec('DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au; DROP TABLE chunks_fts;');
      assert.deepStrictEqual(broken.store.searchText('4417', {}), []);
    } finally {
      broken.cleanup();
    }
  });
});
