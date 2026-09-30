// src/history/embed-indexer.js
// Background embedding (recall spec §5.2): every intervalMs, or at once after
// an append, up to batchSize chunks with no vector for the active embedder
// key are embedded as documents and written back. The chat with the newest
// append goes first, then every other chunk by id. A key change (another
// model or kind) starts filling the new key; rows already written for the
// old key stay (a batch in flight when the key changed is written under the
// key it was embedded with). Nothing runs while the host has no ready
// embedder, on a read-only or in-memory store, or after stop().
//
// A batch the worker crashed on (WORKER_FAILURES) is retried one chunk at a
// time; a chunk that crashes it alone is written as a tombstone and never
// tried again for that key. Any other failure is reported to the host
// (host.fail), which turns vectors off until its retry.
const { mergeHistorySettings } = require('./settings');
const { embedInput } = require('./embedders/vectors');
const { WORKER_FAILURES } = require('./embed-errors');
const { createLogger } = require('../logging');

// Pending and embedded counts are recounted (a full scan) every this many
// batches, and adjusted in between.
const RECOUNT_EVERY = 50;

function startEmbedIndexer({
  store, host, getSettings, onProgress = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  log = createLogger('history/embed-indexer')
}) {
  let stopped = false;
  let timer = null;
  let running = null;
  let preferred = null;
  let epoch = store.vectorEpoch;
  let counts = null;
  let batches = 0;
  // Per key: the id-order cursor, and whether a full pass found nothing.
  const cursor = new Map();
  const idle = new Set();

  const settings = () => mergeHistorySettings((getSettings() || {}).history).embedder;
  const eligible = () => Boolean(store && store.isOpen && store.embeddable && !store.readonly && store.dbPath !== ':memory:');
  const progress = () => ({ key: counts ? counts.key : null, embedded: counts ? counts.embedded : 0, pending: counts ? counts.pending : 0 });

  async function embedRows(embedder, key, rows) {
    const vecs = await embedder.embed(rows.map((r) => embedInput(r.text)), { kind: 'document' });
    return store.putEmbeddings(key, rows.map((r, i) => ({ chunkId: r.id, vec: vecs[i] })));
  }

  // One batch, the crash isolation included. Returns counts and whether every
  // row was handled (embedded or tombstoned).
  async function embedBatch(embedder, key, rows) {
    try {
      return { embedded: await embedRows(embedder, key, rows), skipped: 0, handled: true };
    } catch (err) {
      if (!WORKER_FAILURES.has(err.code)) {
        host.fail(err);
        return { embedded: 0, skipped: 0, handled: false };
      }
    }
    let embedded = 0;
    let skipped = 0;
    for (const row of rows) {
      if (stopped) return { embedded, skipped, handled: false };
      try {
        embedded += await embedRows(embedder, key, [row]);
      } catch (err) {
        if (!WORKER_FAILURES.has(err.code)) {
          host.fail(err);
          return { embedded, skipped, handled: false };
        }
        store.putEmbeddings(key, [{ chunkId: row.id, vec: null }]);
        skipped += 1;
        log.warn('A chunk crashed the embed worker; it is skipped for this model', { chunkId: row.id, key });
      }
    }
    return { embedded, skipped, handled: true };
  }

  async function tick() {
    const none = { embedded: 0, skipped: 0 };
    if (stopped || !eligible()) return none;
    const embedder = host.current();
    if (!embedder) return none;
    const key = embedder.name;
    const cfg = settings();
    if (store.vectorEpoch !== epoch) {
      epoch = store.vectorEpoch;
      cursor.clear();
      idle.clear();
      counts = null;
    }
    if (!counts || counts.key !== key || batches % RECOUNT_EVERY === 0) {
      counts = { key, embedded: store.countEmbedded(key), pending: store.countPending(key, { maxChunksPerToolResult: cfg.maxChunksPerToolResult }) };
    }
    batches += 1;
    const opts = { limit: cfg.batchSize, maxChunksPerToolResult: cfg.maxChunksPerToolResult };
    let fromCursor = false;
    let rows = preferred !== null ? store.pendingEmbeddings(key, { ...opts, chatId: preferred }) : [];
    if (!rows.length) {
      preferred = null;
      if (idle.has(key)) return none;
      rows = store.pendingEmbeddings(key, { ...opts, afterId: cursor.get(key) || 0 });
      fromCursor = true;
      if (!rows.length) {
        // A full pass from the start that finds nothing: idle until an
        // append, a destructive change or a key change.
        if (cursor.get(key)) cursor.set(key, 0);
        else idle.add(key);
        return none;
      }
    }
    const out = await embedBatch(embedder, key, rows);
    if (fromCursor && out.handled) cursor.set(key, Math.max(cursor.get(key) || 0, ...rows.map((r) => r.id)));
    counts.embedded += out.embedded;
    counts.pending = Math.max(0, counts.pending - out.embedded - out.skipped);
    try {
      onProgress(progress());
    } catch (err) {
      log.debug(`embedding progress listener failed: ${err.message}`);
    }
    return { embedded: out.embedded, skipped: out.skipped };
  }

  const schedule = (ms) => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, ms);
  };

  function run() {
    timer = null;
    if (running || stopped) return;
    running = tick()
      .catch((err) => {
        log.warn(`Embedding stopped for this tick: ${err.message}`);
        return { embedded: 0, skipped: 0 };
      })
      .finally(() => {
        running = null;
        schedule(settings().intervalMs);
      });
  }

  const unsubscribe = typeof store.onAppend === 'function' ? store.onAppend((chatId) => api.nudge(chatId)) : () => {};

  const api = {
    nudge(chatId) {
      if (stopped) return;
      preferred = chatId === null || chatId === undefined ? null : String(chatId);
      idle.clear();
      if (!running) schedule(0);
    },
    tick,
    progress,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      unsubscribe();
      if (running) await running;
    }
  };
  schedule(0);
  return api;
}

module.exports = { startEmbedIndexer, RECOUNT_EVERY };
