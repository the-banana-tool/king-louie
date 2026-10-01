// src/history/vector-index.js
// Vectors in memory (recall spec §5.3): one Float32Array matrix per
// (embedder key, chat), loaded from the embeddings table on first use and
// extended with the rows written since (by embeddings rowid), in an LRU
// bounded by history.recall.vectorCacheMb. Search is a brute-force dot
// product over unit vectors.
//
// A destructive store change (truncate, rewrite, delete, rebuild) bumps
// store.vectorEpoch and every cached matrix is dropped: a truncate lets a
// later chunk reuse a chunk id, and a cached row must never answer for it.
// A chat whose vectors alone would exceed the cap stops loading at the cap,
// is not cached and is not searched by vector (BM25 still covers it); the log
// says so once per chat. Other chats are evicted, least recently used first,
// before a matrix grows past the cap, so memory held here never exceeds it.
const { blobToVec, dot } = require('./embedders/vectors');
const { HISTORY_DEFAULTS } = require('./settings');
const { createLogger } = require('../logging');

const MB = 1024 * 1024;
const MIN_ROWS = 64;
const KIND_CODES = Object.freeze({ user: 1, assistant: 2, tool_use: 3, tool_result: 4, attachment: 5, summary: 6 });
const TOO_LARGE = Symbol('too large');
const DEFAULT_CAP_MB = HISTORY_DEFAULTS.recall.vectorCacheMb;
const keyOf = (model, chatId) => `${model}\u0000${chatId}`;

// A row: the vector, its chunk id and seq (int32 each), its kind (a byte).
const rowBytes = (dim) => dim * 4 + 4 + 4 + 1;

class VectorIndex {
  constructor({ store, getCapMb = () => DEFAULT_CAP_MB, log = createLogger('history/vectors') }) {
    this.store = store;
    this.getCapMb = getCapMb;
    this.log = log;
    this.entries = new Map();
    this.epoch = store ? store.vectorEpoch : 0;
    this.tooLarge = new Set();
    this.warned = new Set();
  }

  get bytes() {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  _cap() {
    const mb = Number(this.getCapMb());
    return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CAP_MB) * MB;
  }

  _check() {
    if (this.store.vectorEpoch !== this.epoch) {
      this.clear();
      this.epoch = this.store.vectorEpoch;
    }
  }

  clear() {
    this.entries.clear();
    this.tooLarge.clear();
  }

  stats() {
    return { chats: this.entries.size, bytes: this.bytes, capBytes: this._cap() };
  }

  skipped(model, chatId) {
    return this.tooLarge.has(keyOf(model, chatId));
  }

  // Evicts least recently used matrices (never `keep`) until `extra` more
  // bytes fit under the cap.
  _makeRoom(keep, extra, cap) {
    for (const k of [...this.entries.keys()]) {
      if (this.bytes + extra <= cap) return;
      if (k !== keep) this.entries.delete(k);
    }
  }

  // The loaded (or newly loaded) matrix of one chat, or null.
  _entry(model, chatId) {
    this._check();
    const key = keyOf(model, chatId);
    if (this.tooLarge.has(key)) return null;
    const cap = this._cap();
    // The cap can be lowered while matrices are held: trim to it first (this
    // chat included, when it alone is now over; it then reloads from scratch).
    this._makeRoom(null, 0, cap);
    let e = this.entries.get(key);
    if (e) this.entries.delete(key);
    else e = { key, dim: 0, n: 0, capacity: 0, bytes: 0, matrix: null, ids: null, seqs: null, kinds: null, rowOf: new Map(), lastRowid: 0 };
    this.entries.set(key, e);
    try {
      this._extend(e, model, chatId, cap);
    } catch (err) {
      // Never keep a half-loaded matrix: it reloads from scratch next time.
      this.entries.delete(key);
      if (err !== TOO_LARGE) throw err;
      this.tooLarge.add(key);
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log.warn(`Vector search is off for chat ${chatId}: its vectors need more than history.recall.vectorCacheMb (${Math.round((cap / MB) * 100) / 100} MB). Keyword search still covers it.`);
      }
      return null;
    }
    return e.n ? e : null;
  }

  _grow(e, need, cap) {
    if (need <= e.capacity) return;
    const per = rowBytes(e.dim);
    if (need * per > cap) throw TOO_LARGE;
    const capacity = Math.min(Math.max(need, e.capacity * 2, MIN_ROWS), Math.floor(cap / per));
    this._makeRoom(e.key, capacity * per - e.bytes, cap);
    const matrix = new Float32Array(capacity * e.dim);
    const ids = new Int32Array(capacity);
    const seqs = new Int32Array(capacity);
    const kinds = new Uint8Array(capacity);
    if (e.matrix) {
      matrix.set(e.matrix.subarray(0, e.n * e.dim));
      ids.set(e.ids.subarray(0, e.n));
      seqs.set(e.seqs.subarray(0, e.n));
      kinds.set(e.kinds.subarray(0, e.n));
    }
    Object.assign(e, { matrix, ids, seqs, kinds, capacity, bytes: capacity * per });
  }

  _extend(e, model, chatId, cap) {
    for (const row of this.store.vectorRows(model, chatId, { afterRowid: e.lastRowid })) {
      e.lastRowid = Math.max(e.lastRowid, row.rowid);
      const vec = blobToVec(row.vec);
      if (!e.dim) e.dim = vec.length;
      if (vec.length !== e.dim) {
        if (!this.warned.has(`${e.key}\u0000dim`)) {
          this.warned.add(`${e.key}\u0000dim`);
          this.log.warn(`A ${vec.length}-dim vector in a ${e.dim}-dim matrix for ${model} was skipped`);
        }
        continue;
      }
      let i = e.rowOf.get(row.chunkId);
      if (i === undefined) {
        this._grow(e, e.n + 1, cap);
        i = e.n;
        e.n += 1;
        e.rowOf.set(row.chunkId, i);
      }
      e.matrix.set(vec, i * e.dim);
      e.ids[i] = row.chunkId;
      e.seqs[i] = row.seq;
      e.kinds[i] = KIND_CODES[row.kind] || 0;
    }
  }

  search({ model, query, chatIds, kinds = null, upToSeq = null, k = 50 }) {
    if (!model || !query || !query.length || !Array.isArray(chatIds)) return [];
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds.map((x) => KIND_CODES[x]).filter(Boolean)) : null;
    const limit = Number.isInteger(k) && k > 0 ? k : 50;
    // The best `limit` so far, highest cosine first, ties by chunk id.
    const top = [];
    for (const chatId of chatIds) {
      const e = this._entry(model, String(chatId));
      if (!e || e.dim !== query.length) continue;
      for (let i = 0; i < e.n; i++) {
        if (Number.isInteger(upToSeq) && !(e.seqs[i] < upToSeq)) continue;
        if (kindSet && !kindSet.has(e.kinds[i])) continue;
        const cos = dot(e.matrix, query, i * e.dim);
        const id = e.ids[i];
        if (top.length === limit) {
          const last = top[top.length - 1];
          if (cos < last.cosine || (cos === last.cosine && id > last.chunkId)) continue;
        }
        let at = top.length;
        while (at > 0 && (top[at - 1].cosine < cos || (top[at - 1].cosine === cos && top[at - 1].chunkId > id))) at -= 1;
        top.splice(at, 0, { chunkId: id, cosine: cos });
        if (top.length > limit) top.pop();
      }
    }
    return top.map((t, r) => ({ chunkId: t.chunkId, vectorRank: r + 1, cosine: t.cosine }));
  }

  // A chunk's vector from a matrix already loaded (cosine dedupe); never loads.
  vectorOf(model, chunk) {
    if (!chunk || !model) return null;
    this._check();
    const e = this.entries.get(keyOf(model, chunk.chatId));
    if (!e) return null;
    const i = e.rowOf.get(chunk.id);
    return i === undefined ? null : e.matrix.subarray(i * e.dim, (i + 1) * e.dim);
  }
}

module.exports = { VectorIndex };
