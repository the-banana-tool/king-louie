'use strict';
// Later messages that match a fact (benchmark spec §9 step 3): the candidates
// the needed-judge is shown. BM25 over a temporary history store of the whole
// session, fused with cosine hits when the session's embedding cache is
// complete and holds the query's vector. No embedding call is made here.
const fs = require('fs');
const path = require('path');
const { HistoryStore } = require('../../history');
const { HISTORY_SETTINGS_VERSION, mergeHistorySettings } = require('../../history/settings');
const { EmbeddingCache, cacheDir, vectorIndexFor, topByCosine } = require('../embeddings');
const { sha256Text } = require('../files');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/compaction-matches');

// The chunking kl-recall's store uses by default, so `longhaul embed`'s cache lines up.
const MATCHER_CHUNK = Object.freeze({ ...mergeHistorySettings({ version: HISTORY_SETTINGS_VERSION }).chunk });
const BM25_LIMIT = 50;
const COSINE_K = 50;

const factQueryText = (fact, quote) => `${fact}\n${quote}`;
const factQueryId = (text) => `compaction:${sha256Text(String(text))}`;

function buildStore(dir, session) {
  const store = HistoryStore.open(path.join(dir, 'history.sqlite'), { chunkOptions: MATCHER_CHUNK });
  try {
    const chatId = `longhaul-${session.manifest.sessionId}`;
    const first = session.messages[0];
    store.createChat({ id: chatId, title: session.manifest.sessionId, createdAt: first?.timestamp, updatedAt: first?.timestamp, messages: [] });
    for (const m of session.messages) {
      const { seq, ...message } = m;
      const out = store.appendMessage(chatId, message);
      if (!out || out.seq !== seq) {
        throw new Error(`seq drift in ${session.manifest.sessionId}: message ${m.id} is #${seq} in the session but #${out?.seq} in the store`);
      }
    }
    return { store, chatId };
  } catch (err) {
    try { store.close(); } catch { /* already failing */ }
    throw err;
  }
}

// The cosine side, or null when the cache is missing, incomplete or chunked
// another way (semantic is then skipped).
function vectorSide(home, sessionId, store, chatId, embed) {
  if (!embed) return null;
  const cache = EmbeddingCache.open(cacheDir(home.private, sessionId, embed.model));
  if (!cache.exists || JSON.stringify(cache.meta.chunk) !== JSON.stringify(MATCHER_CHUNK)) return null;
  try {
    return { cache, index: vectorIndexFor(cache, store.chunksOfChat(chatId), { sessionId, model: embed.model, provider: embed.provider }) };
  } catch (err) {
    log.debug('embedding cache not usable; lexical only', { sessionId, code: err.code ?? null });
    return null;
  }
}

// Session messages of the chunks, kept only after afterSeq, first hit per seq.
function laterSeqs(chunkRows, afterSeq) {
  const seqs = [];
  const seen = new Set();
  for (const c of chunkRows) {
    if (!(c.seq > afterSeq) || seen.has(c.seq)) continue;
    seen.add(c.seq);
    seqs.push(c.seq);
  }
  return seqs;
}

async function openMatcher({ home, sessionId, session, embed = null }) {
  fs.mkdirSync(home.tmp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(home.tmp, `kl-compaction-${process.pid}-`));
  let built;
  try {
    built = buildStore(dir, session);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const { store, chatId } = built;
  let vec;
  try {
    vec = vectorSide(home, sessionId, store, chatId, embed);
  } catch (err) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  async function laterMatches(fact, quote, afterSeq, { k = 8 } = {}) {
    const query = factQueryText(fact, quote);
    const hits = store.searchText(query, { chatIds: [chatId], limit: BM25_LIMIT });
    const lexicalSeqs = laterSeqs(store.chunks(hits.map((h) => h.chunkId)), afterSeq);
    let semanticSeqs = [];
    const q = vec ? vec.cache.question(factQueryId(query), query) : null;
    if (q) {
      const top = topByCosine(vec.index, q, { k: COSINE_K });
      semanticSeqs = laterSeqs(store.chunks(top.map((t) => t.chunkId)), afterSeq);
    }
    const fused = [];
    const seen = new Set();
    for (let i = 0; i < Math.max(lexicalSeqs.length, semanticSeqs.length); i++) {
      for (const seq of [lexicalSeqs[i], semanticSeqs[i]]) {
        if (seq === undefined || seen.has(seq)) continue;
        seen.add(seq);
        fused.push(seq);
      }
    }
    return {
      messages: fused.slice(0, k).map((seq) => session.index.get(seq)),
      lexical: lexicalSeqs.length,
      semantic: semanticSeqs.length
    };
  }

  async function release() {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { laterMatches, release };
}

module.exports = { openMatcher, factQueryText, factQueryId, MATCHER_CHUNK };
