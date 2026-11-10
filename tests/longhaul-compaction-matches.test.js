'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionIndex } = require('../src/longhaul/session-format');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { HistoryStore } = require('../src/history');
const { EmbeddingCache, cacheDir } = require('../src/longhaul/embeddings');
const { openMatcher, factQueryText, factQueryId, MATCHER_CHUNK } = require('../src/longhaul/compaction/matches');

const TOKEN = 'ledgerport-7731';
const FACT = `The ${TOKEN} key rotates nightly`;
const QUOTE = `${TOKEN} rotates`;

function msg(seq, sender, text) {
  return { id: `m${seq}`, seq, sender, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString() };
}

function handBuilt({ withToken = [5, 40], extra = {} } = {}) {
  const messages = [];
  for (let seq = 1; seq <= 45; seq++) {
    let text = `filler ${seq} alpha beta gamma`;
    if (withToken.includes(seq)) text = `we set ${TOKEN} to rotate every night`;
    if (extra[seq]) text = extra[seq];
    messages.push(msg(seq, seq % 2 ? 'user' : 'assistant', text));
  }
  const manifest = { sessionId: 'hand-matches', private: false, license: 'test', messages: messages.length };
  return { manifest, messages, index: new SessionIndex(messages) };
}

describe('openMatcher', () => {
  let root;
  let home;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-matches-'));
    home = ensureDirs(resolveHome({ LONGHAUL_HOME: root }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns only matches after afterSeq', async () => {
    const session = handBuilt();
    const m = await openMatcher({ home, sessionId: 'hand-matches', session });
    try {
      const out = await m.laterMatches(FACT, QUOTE, 20);
      assert.deepEqual(out.messages.map((x) => x.seq), [40]);
      assert.equal(out.messages[0].text, session.index.get(40).text);
      assert.equal(out.lexical, 1);
      assert.equal(out.semantic, 0);
    } finally {
      await m.release();
    }
  });

  it('returns nothing when afterSeq is past every match', async () => {
    const m = await openMatcher({ home, sessionId: 'hand-matches', session: handBuilt() });
    try {
      assert.deepEqual((await m.laterMatches(FACT, QUOTE, 41)).messages, []);
    } finally {
      await m.release();
    }
  });

  it('cuts at k, best first, deduped by seq', async () => {
    const session = handBuilt({ withToken: [5, 30, 40, 42] });
    const m = await openMatcher({ home, sessionId: 'hand-matches', session });
    try {
      const all = await m.laterMatches(FACT, QUOTE, 20);
      assert.deepEqual(all.messages.map((x) => x.seq).sort((a, b) => a - b), [30, 40, 42]);
      assert.equal(new Set(all.messages.map((x) => x.seq)).size, all.messages.length);
      const one = await m.laterMatches(FACT, QUOTE, 20, { k: 1 });
      assert.equal(one.messages.length, 1);
      assert.equal(one.messages[0].seq, all.messages[0].seq);
    } finally {
      await m.release();
    }
  });

  it('keeps its store under tmp/kl-compaction-<pid>- and release() removes it', async () => {
    const m = await openMatcher({ home, sessionId: 'hand-matches', session: handBuilt() });
    const dirs = fs.readdirSync(home.tmp);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0].startsWith(`kl-compaction-${process.pid}-`));
    await m.release();
    assert.deepEqual(fs.readdirSync(home.tmp), []);
  });

  it('with embed and no cache, is lexical only and does not throw', async () => {
    const m = await openMatcher({ home, sessionId: 'hand-matches', session: handBuilt(), embed: { provider: 'openai', model: 'text-embedding-3-small' } });
    try {
      const out = await m.laterMatches(FACT, QUOTE, 20);
      assert.equal(out.semantic, 0);
      assert.deepEqual(out.messages.map((x) => x.seq), [40]);
    } finally {
      await m.release();
    }
  });

  it('fuses cosine hits from a complete cache with a cached query vector', async () => {
    const session = handBuilt({ extra: { 33: 'midnight credential swap happens here' } });
    const model = 'text-embedding-3-small';
    const store = HistoryStore.open(':memory:', { chunkOptions: MATCHER_CHUNK });
    const chatId = 'c';
    store.createChat({ id: chatId, title: 't', messages: [] });
    for (const { seq, ...message } of session.messages) store.appendMessage(chatId, message);
    const chunks = store.chunksOfChat(chatId);
    store.close();
    const cache = EmbeddingCache.open(cacheDir(home.private, 'hand-matches', model));
    cache.init({ model, provider: 'openai', dim: 2, chunk: MATCHER_CHUNK, sessionId: 'hand-matches' });
    cache.append(
      chunks.map((c) => ({ messageId: c.messageId, idx: c.idx, chars: c.text.length, truncated: false })),
      chunks.map((c) => (c.seq === 33 ? [1, 0] : [0, 1]))
    );
    const query = factQueryText(FACT, QUOTE);
    cache.addQuestion(factQueryId(query), query, [1, 0]);

    const m = await openMatcher({ home, sessionId: 'hand-matches', session, embed: { provider: 'openai', model } });
    try {
      const out = await m.laterMatches(FACT, QUOTE, 20);
      const seqs = out.messages.map((x) => x.seq);
      assert.deepEqual(seqs.slice(0, 2), [40, 33]);
      assert.ok(out.semantic > 0);
      assert.equal(out.lexical, 1);
    } finally {
      await m.release();
    }
  });
  it('finds later matches when more than the first cut of hits are inside the window', async () => {
    const messages = [];
    for (let seq = 1; seq <= 70; seq++) {
      let text = `filler ${seq} alpha beta gamma`;
      if (seq <= 60) text = `${TOKEN} rotates, ${TOKEN} rotates nightly`;
      if (seq === 65 || seq === 68) text = `later we noted ${TOKEN} once among many other words here today`;
      messages.push(msg(seq, seq % 2 ? 'user' : 'assistant', text));
    }
    const session = { manifest: { sessionId: 'hand-crowd', private: false, license: 'test', messages: 70 }, messages, index: new SessionIndex(messages) };
    const model = 'text-embedding-3-small';
    const store = HistoryStore.open(':memory:', { chunkOptions: MATCHER_CHUNK });
    store.createChat({ id: 'c', title: 't', messages: [] });
    for (const { seq, ...message } of messages) store.appendMessage('c', message);
    const chunks = store.chunksOfChat('c');
    store.close();
    const cache = EmbeddingCache.open(cacheDir(home.private, 'hand-crowd', model));
    cache.init({ model, provider: 'openai', dim: 2, chunk: MATCHER_CHUNK, sessionId: 'hand-crowd' });
    cache.append(
      chunks.map((c) => ({ messageId: c.messageId, idx: c.idx, chars: c.text.length, truncated: false })),
      chunks.map((c) => (c.seq <= 60 ? [1, 0] : c.seq === 65 || c.seq === 68 ? [0.8, 0.2] : [0, 1]))
    );
    const query = factQueryText(FACT, QUOTE);
    cache.addQuestion(factQueryId(query), query, [1, 0]);

    const m = await openMatcher({ home, sessionId: 'hand-crowd', session, embed: { provider: 'openai', model } });
    try {
      const out = await m.laterMatches(FACT, QUOTE, 62);
      assert.deepEqual(out.messages.slice(0, 2).map((x) => x.seq).sort((a, b) => a - b), [65, 68]);
      assert.ok(out.messages.every((x) => x.seq > 62));
      assert.equal(out.lexical, 2);
      assert.equal(out.semantic, 8);
    } finally {
      await m.release();
    }
  });
});
