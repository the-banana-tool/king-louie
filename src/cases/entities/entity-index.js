// src/cases/entities/entity-index.js
// The cross-case entity index (cases stage 7 spec §3.6, §4.6; program §4.9,
// §4.10, R38, R46) at <casesRoot>/.index/entities.json. Derived from each
// case's facts and ingest records, so deleting it is always safe.
//
// What leaves this module:
// - Cross-case hits carry a case's title and ids only (case id, fact id or
//   docId, the searched key): never a file name, a ref or another case's
//   text. A fuzzy name hit reports the key that was searched for, not the
//   other case's spelling. A document entity's `display` is its docId.
// - nonDisclosableSpans reports spans of the caller's own text; C3's gate
//   reads the span text from its payload, never from the index.
//
// nonDisclosableSpans must find an indexed value without a label in front
// of it (F5-doc: `0042-7781`), which regex extraction cannot. Besides the
// extraction of the text (run in overlapping windows, so the per-call cap of
// extractEntities never hides a later entity), it matches every indexed key
// of at least SURFACE_MIN characters against two normalised views of the
// text:
// - ids, phone numbers and emails against the alphanumeric stream of
//   src/cases/entities/fold.js (compatibility forms, every decimal digit
//   and Latin look-alike letters folded; hidden characters and combining
//   marks skipped; any punctuation, symbol or space a separator; units split
//   at letter/digit transitions and chained through at most MAX_GAP
//   separators). A match starts and ends on a unit boundary, so
//   `0042 7781`, `0042,7781`, `Loan0042-7781` and `00427781` all match
//   id:00427781, and `100427781` does not. An email also needs its units
//   joined only by separators an email carries, one of them an at sign;
// - addresses (and people and organisations with
//   cases.ingest.entities.spanNames) against the word stream: words as
//   plainWords reads them, street suffixes expanded, chained through gaps of
//   at most MAX_GAP characters, hidden characters removed first.
// A run under a bidi embedding, override or isolate is also scanned in the
// orders it may display in (see _occurrences). Both scans hash with a
// per-process random multiplier, extend at most MAX_STREAM_CHARS /
// MAX_WORDS from each unit or word, and verify a hash hit before reporting
// it, so the cost is linear in the text whatever the index holds.
//
// The file is untrusted on read (the cases root is writable by the model's
// Bash): it must be a regular file under a size cap, read through one
// descriptor; its shape, version and extractor hash (EXTRACTOR: the rules
// it was built with) are checked field by field into null-prototype
// objects, and anything off means a rebuild from the cases themselves. A
// case whose facts or ingest files changed since the file was written is
// re-indexed before a read; that check runs at most once per synchronous
// frame. A well-formed file forged with current fingerprints is still
// believed (the same stage-1 limit as a Bash-rewritten facts.jsonl).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CaseStore } = require('../case-store');
const { FactLedger } = require('../ledger');
const { writeAtomic } = require('../jsonfile');
const { HIDDEN_CLASS } = require('../hidden-chars');
const { createLogger } = require('../../logging');
const { DOC_ID } = require('../ingest/store');
const { listRecords, readTextStore, ingestStat, PROPOSAL_ID } = require('../ingest/files');
const { normalizeEntity, keyType, plainWords, STREET_SUFFIXES, ENTITY_TYPES, MAX_KEY_CHARS } = require('./normalize');
const { extractEntities, TEXT_KINDS } = require('./extract');
const { streamView, canonStream, MAX_GAP } = require('./fold');

const INDEX_VERSION = 1;
const SURFACE_MIN = 5;
const NAME_MATCH = 0.8;
const ALL_KINDS = Object.freeze(['email', 'phone', 'id', 'address', 'person', 'org']);
const NAME_KINDS = Object.freeze(['person', 'org']);
const STREAM_KINDS = new Set(['id', 'phone', 'email']);
const WORD_KINDS = new Set(['address', 'person', 'org']);
const MAX_STREAM_CHARS = 80;
const MAX_WORDS = 16;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DISPLAY = 200;
const MAX_CASE_ID = 256;
const MAX_PROPOSAL_ENTITIES = 50;
const MAX_PAGES = 100000;
// extractEntities returns at most 500 entities per call; a 2,048-character
// window holds far fewer, and the overlap is longer than any entity its
// bounded regexes can match, so every entity lies whole in some window.
const EXTRACT_WINDOW = 2048;
const EXTRACT_OVERLAP = 512;
const FACT_ID = /^f-\d{4,}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Exactly C3's fact-reference grammar (gates.js REF_RE), bounded. Anything
// else in braces is scanned like any other text (C3 reports it anyway).
const REF_SPAN = /\{\{\s{0,8}f-\d{4,24}\s{0,8}\}\}/g;
const HIDDEN_RUN = new RegExp(`[${HIDDEN_CLASS}]+`, 'gu');
// A bidi embedding, override or isolate and what it controls, up to its
// pop, a line break or the end (fix-T7-r1 I3).
const BIDI_RUN = new RegExp(
  `[${[0x202a, 0x202b, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068].map((c) => String.fromCodePoint(c)).join('')}]`
  + `[^${[0x202c, 0x2069, 0x0a, 0x0d].map((c) => String.fromCodePoint(c)).join('')}]*`,
  'gu'
);
const ALNUM_GROUPS = /([\p{L}\p{N}\p{M}]+)/u;

// The extraction and matching rules the stored index was built with: a
// hash of the modules that define them. An index built by other rules is
// rebuilt (fix-T7-r1 I4), as C5 does for its tokenizer.
const EXTRACTOR = (() => {
  const h = crypto.createHash('sha256');
  for (const file of [require.resolve('./extract'), require.resolve('./normalize'), require.resolve('./fold'), require.resolve('../hidden-chars'), __filename]) {
    h.update(fs.readFileSync(file));
  }
  return h.digest('hex').slice(0, 16);
})();
const WORD_TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
const ASCII_WORD = /^[a-z0-9]+$/;

// ---- hashing ----
// A 32-bit polynomial hash with an odd multiplier drawn per process, so a
// payload cannot be written in advance to collide with an indexed key. A
// hit is always verified before it is reported; a collision only costs a
// comparison.

const BASE = (crypto.randomInt(1 << 30) * 2 + 1) | 0;
const step = (h, sym) => (Math.imul(h, BASE) + sym + 1) | 0;

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = step(h, s.charCodeAt(i));
  return h;
}

function hashWords(words) {
  let h = 0;
  for (const w of words) h = step(h, hashString(w));
  return h;
}

// ---- text views ----

// The text without hidden characters, and each of its code units' offset in
// the original.
function withoutHidden(s) {
  const map = new Int32Array(s.length);
  const parts = [];
  let j = 0;
  let last = 0;
  const keep = (from, to) => {
    parts.push(s.slice(from, to));
    for (let k = from; k < to; k++) map[j++] = k;
  };
  for (const m of s.matchAll(HIDDEN_RUN)) {
    keep(last, m.index);
    last = m.index + m[0].length;
  }
  keep(last, s.length);
  return { clean: parts.join(''), map: map.subarray(0, j) };
}

const canonWord = (w) => STREET_SUFFIXES[w] || w;
const keyWords = (value) => plainWords(value).split(' ').filter(Boolean).map(canonWord);

// Every entity extractEntities finds, window by window. A window without
// an @ cannot hold an email, so the email pattern (the costly one on long
// runs of local-part characters) only runs where one could match.
const NO_EMAIL = TEXT_KINDS.filter((k) => k !== 'email');
function extractAll(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  for (let w = 0; ; w += EXTRACT_WINDOW - EXTRACT_OVERLAP) {
    const part = s.slice(w, w + EXTRACT_WINDOW);
    for (const e of extractEntities(part, { kinds: part.includes('@') ? TEXT_KINDS : NO_EMAIL })) {
      const start = w + e.start;
      const end = w + e.end;
      const id = `${start}:${end}:${e.type}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...e, start, end });
    }
    if (w + EXTRACT_WINDOW >= s.length) break;
  }
  return out;
}

// ---- the stored file ----

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const FINGERPRINT_FIELDS = Object.freeze(['factsSize', 'factsMtimeMs', 'ingestMtimeMs', 'ingestBytes', 'ingestCount']);
const validCaseId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_CASE_ID;

function validKey(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY_CHARS) return false;
  const colon = key.indexOf(':');
  return colon > 0 && ENTITY_TYPES.includes(key.slice(0, colon)) && key.length > colon + 1;
}

function sameFingerprint(a, b) {
  return Boolean(a && b) && FINGERPRINT_FIELDS.every((f) => a[f] === b[f]);
}

// The parsed file as fresh null-prototype objects, or null when anything is
// off (then the caller rebuilds).
function validIndex(raw) {
  if (!isObj(raw) || raw.version !== INDEX_VERSION || raw.extractor !== EXTRACTOR || !isObj(raw.cases) || !isObj(raw.entities)) return null;
  const cases = Object.create(null);
  for (const [id, fp] of Object.entries(raw.cases)) {
    if (!validCaseId(id) || !isObj(fp) || Object.keys(fp).length !== FINGERPRINT_FIELDS.length) return null;
    if (!FINGERPRINT_FIELDS.every((f) => Number.isFinite(fp[f]) && fp[f] >= 0)) return null;
    cases[id] = Object.fromEntries(FINGERPRINT_FIELDS.map((f) => [f, fp[f]]));
  }
  const entities = Object.create(null);
  for (const [key, e] of Object.entries(raw.entities)) {
    if (!validKey(key) || !isObj(e) || e.type !== keyType(key)) return null;
    if (typeof e.display !== 'string' || e.display.length > MAX_DISPLAY) return null;
    if (!Array.isArray(e.links) || !e.links.length) return null;
    const links = [];
    for (const l of e.links) {
      if (!isObj(l) || !validCaseId(l.caseId) || !cases[l.caseId]) return null;
      if (l.factId !== null && !(typeof l.factId === 'string' && FACT_ID.test(l.factId))) return null;
      if (l.docId !== null && !(typeof l.docId === 'string' && DOC_ID.test(l.docId))) return null;
      if ((l.factId === null && l.docId === null) || typeof l.disclosable !== 'boolean') return null;
      links.push({ caseId: l.caseId, factId: l.factId, docId: l.docId, disclosable: l.disclosable });
    }
    entities[key] = { type: e.type, display: e.display, links };
  }
  return { version: INDEX_VERSION, extractor: EXTRACTOR, builtAt: typeof raw.builtAt === 'string' ? raw.builtAt.slice(0, 40) : null, cases, entities };
}

const tokenSet = (key) => new Set(key.slice(key.indexOf(':') + 1).split(' ').filter(Boolean));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// A fact's statement and value, read separately: joined, the digits at the
// end of one and the start of the other would read as one phone number.
const factTexts = (f) => [
  typeof f.stmt === 'string' ? f.stmt : '',
  f.value === null || f.value === undefined ? '' : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)
];

class EntityIndex {
  constructor(casesRoot, { store = null, getSettings = null, log = null, maxFileBytes = MAX_FILE_BYTES } = {}) {
    if (!casesRoot) throw new Error('EntityIndex requires the cases root.');
    this.root = casesRoot;
    this.dir = path.join(casesRoot, '.index');
    this.file = path.join(this.dir, 'entities.json');
    this.store = store || new CaseStore({ root: casesRoot });
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.log = log || createLogger('cases/entities');
    this.maxFileBytes = maxFileBytes;
    this.data = null;
    this._matchers = new Map();
  }

  // ---- storage ----

  _empty() {
    return { version: INDEX_VERSION, extractor: EXTRACTOR, builtAt: new Date().toISOString(), cases: Object.create(null), entities: Object.create(null) };
  }

  _read() {
    let text;
    let fd;
    try {
      // Not a FIFO, device or link: lstat first, and open without blocking
      // on a FIFO swapped in meanwhile (fix-T7-r1 m4).
      if (!fs.lstatSync(this.file).isFile()) {
        this.log.warn('Entity index is not a regular file; rebuilding.');
        return null;
      }
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > this.maxFileBytes) {
        this.log.warn(`Entity index is not a file of at most ${this.maxFileBytes} bytes; rebuilding.`);
        return null;
      }
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (!n) break;
        off += n;
      }
      text = buf.toString('utf8', 0, off);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Entity index unreadable; rebuilding: ${err.message}`);
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      this.log.warn(`Entity index is not JSON; rebuilding: ${err.message}`);
      return null;
    }
    const data = validIndex(raw);
    if (!data) this.log.warn('Entity index is malformed or of another version; rebuilding.');
    return data;
  }

  _load() {
    if (this.data) return this.data;
    const loaded = this._read();
    if (loaded) {
      this.data = loaded;
      this._changed();
      return loaded;
    }
    this.data = this._empty();
    this._changed();
    for (const meta of this._cases()) this._index(meta);
    this._save();
    return this.data;
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const ignore = path.join(this.dir, '.gitignore');
      if (!fs.existsSync(ignore)) writeAtomic(ignore, '*\n');
      const text = `${JSON.stringify(this.data)}\n`;
      if (Buffer.byteLength(text) > this.maxFileBytes) {
        this.log.warn(`The entity index is over ${this.maxFileBytes} bytes; kept in memory only.`);
        return;
      }
      writeAtomic(this.file, text);
    } catch (err) {
      this.log.warn(`Writing the entity index failed: ${err.message}`);
    }
  }

  // Throws when the cases cannot be listed: an empty list would drop every
  // case from the index, and the outbound gate fails closed on a throw.
  _cases() {
    return this.store.list();
  }

  _fingerprint(meta) {
    let factsSize = 0;
    let factsMtimeMs = 0;
    try {
      const st = fs.statSync(path.join(meta.dir, 'facts.jsonl'));
      factsSize = st.size;
      factsMtimeMs = st.mtimeMs;
    } catch { /* no facts yet */ }
    const ingest = ingestStat(meta.dir);
    return { factsSize, factsMtimeMs, ingestMtimeMs: ingest.mtimeMs, ingestBytes: ingest.bytes, ingestCount: ingest.count };
  }

  _changed() {
    this._matchers = new Map();
    this._fresh = null;
  }

  // ---- building ----

  _drop(caseId) {
    for (const key of Object.keys(this.data.entities)) {
      const entry = this.data.entities[key];
      entry.links = entry.links.filter((l) => l.caseId !== caseId);
      if (!entry.links.length) delete this.data.entities[key];
    }
    delete this.data.cases[caseId];
    this._changed();
  }

  _index(meta) {
    const caseId = meta.id;
    this._drop(caseId);
    // A ledger that cannot be read throws: the case keeps no fingerprint, so
    // every later read retries it (and the gate fails closed meanwhile).
    const { facts } = new FactLedger(meta.dir).view();
    const seen = new Map();
    const link = (key, display, l) => {
      const id = JSON.stringify([key, l.factId, l.docId]);
      const same = seen.get(id);
      if (same) {
        same.disclosable = same.disclosable || l.disclosable;
        return;
      }
      let entry = this.data.entities[key];
      if (!entry) {
        entry = { type: keyType(key), display: String(display).slice(0, MAX_DISPLAY), links: [] };
        this.data.entities[key] = entry;
      }
      const made = { caseId, factId: l.factId, docId: l.docId, disclosable: l.disclosable };
      entry.links.push(made);
      seen.set(id, made);
    };

    for (const f of facts.values()) {
      if (f.status !== 'active' || f.provenance === 'inferred' || f.provenance === 'unknown') continue;
      if (!FACT_ID.test(String(f.id))) continue;
      const docId = typeof f.source?.docId === 'string' && DOC_ID.test(f.source.docId) ? f.source.docId : null;
      const l = { factId: f.id, docId, disclosable: f.disclosable === true };
      for (const t of factTexts(f)) for (const e of extractAll(t)) for (const key of e.keys) link(key, e.text, l);
    }

    for (const rec of listRecords(meta.dir)) {
      const docId = rec.docId;
      if (SHA256.test(String(rec.sha256 || ''))) link(`document:${rec.sha256}`, docId, { factId: null, docId, disclosable: false });
      for (const p of Array.isArray(rec.proposals) ? rec.proposals : []) {
        if (!isObj(p) || typeof p.id !== 'string' || !PROPOSAL_ID.test(p.id)) continue;
        const fact = facts.get(p.review?.factId);
        // Only a fact this document's ingest created may lend its
        // disclosable flag to the proposal's entities: a forged record
        // pointing at an unrelated disclosable fact is ignored.
        if (!fact || fact.status !== 'active' || !FACT_ID.test(String(fact.id))) continue;
        if (fact.source?.kind !== 'document' || fact.source?.docId !== docId) continue;
        if (fact.source.proposalId && fact.source.proposalId !== p.id) continue;
        const l = { factId: fact.id, docId, disclosable: fact.disclosable === true };
        for (const e of (Array.isArray(p.entities) ? p.entities : []).slice(0, MAX_PROPOSAL_ENTITIES)) {
          if (!isObj(e) || typeof e.type !== 'string' || e.type === 'document' || typeof e.text !== 'string') continue;
          for (const key of normalizeEntity(e.type, e.text.slice(0, MAX_DISPLAY))) link(key, e.text, l);
        }
      }
      const store = readTextStore(meta.dir, docId);
      const pages = Array.isArray(store?.pages) ? store.pages.slice(0, MAX_PAGES) : [];
      for (const page of pages) {
        if (!isObj(page) || typeof page.text !== 'string') continue;
        for (const e of extractAll(page.text)) {
          for (const key of e.keys) link(key, e.text, { factId: null, docId, disclosable: false });
        }
      }
    }
    this.data.cases[caseId] = this._fingerprint(meta);
    this._changed();
  }

  // Re-index every case whose facts or ingest files changed since the last
  // look, and drop cases that are gone. Called before every read, but runs
  // at most once per synchronous frame (C3's gateLeaves asks once per string
  // leaf): the result is kept until the next microtask, or until this index
  // changes. Returns the listed cases.
  _refresh() {
    if (this._fresh) return this._fresh;
    this._load();
    const metas = this._cases();
    let changed = false;
    const seen = new Set();
    for (const meta of metas) {
      seen.add(meta.id);
      if (!sameFingerprint(this.data.cases[meta.id], this._fingerprint(meta))) {
        this._index(meta);
        changed = true;
      }
    }
    for (const id of Object.keys(this.data.cases)) {
      if (!seen.has(id)) {
        this._drop(id);
        changed = true;
      }
    }
    if (changed) this._save();
    this._fresh = metas;
    queueMicrotask(() => { this._fresh = null; });
    return metas;
  }

  rebuild() {
    const cases = this._cases();
    this.data = this._empty();
    this._changed();
    for (const meta of cases) this._index(meta);
    this._save();
    return { cases: cases.length, entities: Object.keys(this.data.entities).length };
  }

  upsertCase(caseId) {
    this._load();
    const meta = this._cases().find((c) => c.id === caseId);
    if (!meta) return this.removeCase(caseId);
    // Ruling M12: C5 calls this on every reindex; an unchanged case is not
    // re-read (that would re-extract every text store).
    if (sameFingerprint(this.data.cases[caseId], this._fingerprint(meta))) return { unchanged: true };
    this._index(meta);
    this._save();
    return { indexed: true };
  }

  removeCase(caseId) {
    this._load();
    this._drop(caseId);
    this._save();
    return { removed: true };
  }

  // ---- matching ----

  // Hash tables of the indexed keys of `types`, for the two stream scans.
  _matcher(types) {
    const sig = [...types].sort().join(',');
    const cached = this._matchers.get(sig);
    if (cached) return cached;
    const m = { stream: new Map(), streamMax: 0, streamLens: new Uint8Array(MAX_STREAM_CHARS + 1), words: new Map(), wordsMax: 0 };
    const add = (table, h, value, key, extra = {}) => {
      const bucket = table.get(h) || [];
      const same = bucket.find((b) => b.value === value && b.email === extra.email);
      if (same) same.keys.push(key);
      else bucket.push({ value, keys: [key], ...extra });
      table.set(h, bucket);
    };
    for (const key of Object.keys(this.data.entities)) {
      const type = keyType(key);
      if (!types.has(type)) continue;
      const value = key.slice(key.indexOf(':') + 1);
      if (STREAM_KINDS.has(type)) {
        const canon = canonStream(value);
        if (!canon || canon.length < SURFACE_MIN || canon.length > MAX_STREAM_CHARS) continue;
        add(m.stream, hashString(canon), canon, key, { email: type === 'email' });
        m.streamMax = Math.max(m.streamMax, canon.length);
        m.streamLens[canon.length] = 1;
      } else if (WORD_KINDS.has(type)) {
        const words = keyWords(value);
        const joined = words.join(' ');
        if (joined.length < SURFACE_MIN || words.length > MAX_WORDS) continue;
        add(m.words, hashWords(words), joined, key);
        m.wordsMax = Math.max(m.wordsMax, words.length);
      }
    }
    this._matchers.set(sig, m);
    return m;
  }

  // Ids, phone numbers and emails in the alphanumeric stream of `s`
  // (src/cases/entities/fold.js): for each unit, the longest chain of units
  // that spells a reportable key. An email must also be joined only by
  // separators an email carries, one of them an at sign. `emit` gets
  // offsets in `s`.
  _streamScan(s, m, ok, emit) {
    if (!m.stream.size) return;
    const v = streamView(s);
    const { sym, uStart, uEnd, uLinked } = v;
    const units = uStart.length;
    const spells = (a, b, value) => {
      let k = 0;
      for (let i = uStart[a]; i < uEnd[b]; i++) if (sym[i] !== value.charCodeAt(k++)) return false;
      return k === value.length;
    };
    const emailJoined = (a, b) => {
      let at = false;
      for (let u = a + 1; u <= b; u++) {
        if (v.uGapBad[u]) return false;
        at = at || v.uGapAt[u];
      }
      return at;
    };
    // Hash hits of the chain from unit a, as (last unit, length, hash); at
    // most one per unit, and a unit adds at least one symbol.
    const hitB = new Int32Array(m.streamMax + 1);
    const hitLen = new Int32Array(m.streamMax + 1);
    const hitH = new Int32Array(m.streamMax + 1);
    for (let a = 0; a < units; a++) {
      let hits = 0;
      let h = 0;
      let len = 0;
      for (let b = a; b < units && len <= m.streamMax; b++) {
        if (b > a && !uLinked[b]) break;
        for (let i = uStart[b]; i < uEnd[b] && len <= m.streamMax; i++) {
          h = step(h, sym[i]);
          len += 1;
        }
        if (len > m.streamMax) break;
        if (m.streamLens[len] && m.stream.has(h)) {
          hitB[hits] = b;
          hitLen[hits] = len;
          hitH[hits] = h;
          hits += 1;
        }
      }
      let done = false;
      for (let x = hits - 1; x >= 0 && !done; x--) {
        const b = hitB[x];
        const len = hitLen[x];
        for (const entry of m.stream.get(hitH[x])) {
          if (entry.value.length !== len || !spells(a, b, entry.value)) continue;
          if (entry.email && !emailJoined(a, b)) continue;
          const key = entry.keys.find(ok);
          if (key) {
            emit(key, v.oStart[uStart[a]], v.oEnd[uEnd[b] - 1]);
            done = true;
            break;
          }
        }
      }
    }
  }

  // Addresses, people and organisations in the word stream of `clean`.
  _wordScan(clean, m, ok, emit) {
    if (!m.words.size) return;
    const units = [];
    let prevEnd = -1;
    for (const t of clean.matchAll(WORD_TOKEN)) {
      const raw = t[0];
      const lower = raw.toLowerCase();
      const words = ASCII_WORD.test(lower) ? [lower] : plainWords(raw).split(' ').filter(Boolean);
      const end = t.index + raw.length;
      if (!words.length) {
        prevEnd = -1;
        continue;
      }
      const joins = prevEnd >= 0 && t.index - prevEnd <= MAX_GAP;
      words.forEach((w, i) => {
        const word = canonWord(w);
        units.push({ start: t.index, end, word, h: hashString(word), linked: i > 0 || joins });
      });
      prevEnd = end;
    }
    const hitB = new Int32Array(m.wordsMax + 1);
    const hitH = new Int32Array(m.wordsMax + 1);
    for (let a = 0; a < units.length; a++) {
      let hits = 0;
      let h = 0;
      for (let b = a; b < units.length && b - a < m.wordsMax; b++) {
        if (b > a && !units[b].linked) break;
        h = step(h, units[b].h);
        if (m.words.has(h)) {
          hitB[hits] = b;
          hitH[hits] = h;
          hits += 1;
        }
      }
      let done = false;
      for (let x = hits - 1; x >= 0 && !done; x--) {
        const b = hitB[x];
        const joined = units.slice(a, b + 1).map((u) => u.word).join(' ');
        for (const entry of m.words.get(hitH[x])) {
          if (entry.value !== joined) continue;
          const key = entry.keys.find(ok);
          if (key) {
            emit(key, units[a].start, units[b].end);
            done = true;
            break;
          }
        }
      }
    }
  }

  // Extraction, the alphanumeric stream and the word stream over `s`;
  // `emit(key, start, end)` gets offsets in `s`.
  _scan(s, { types, ok }, emit) {
    const { clean, map } = withoutHidden(s);
    const fromClean = (key, start, end) => {
      if (end > start) emit(key, map[start], map[end - 1] + 1);
    };
    for (const e of extractAll(clean)) {
      const key = e.keys.find((k) => types.has(keyType(k)) && ok(k));
      if (key) fromClean(key, e.start, e.end);
    }
    const m = this._matcher(types);
    this._streamScan(s, m, ok, emit);
    this._wordScan(clean, m, ok, fromClean);
  }

  // Every occurrence in `text` of an indexed key of `types` that `ok`
  // accepts: → [{ key, start, end }] in original offsets, one per span.
  //
  // Bidi controls are hidden characters, so the scans read text in logical
  // order; a run under an embedding, override or isolate may display in
  // another order (`1877-2400` under U+202E shows as `0042-7781`). Each such
  // run is also scanned reversed code point by code point (an override) and
  // with its letter/digit groups in reverse order (an embedding or isolate
  // around numbers), and a hit in either reports the whole run
  // (fix-T7-r1 I3).
  _occurrences(text, { types, ok }) {
    const s = String(text ?? '');
    const out = [];
    const spans = new Set();
    // start * 2^26 + end is exact while offsets stay below 2^26.
    const numericIds = s.length < 0x4000000;
    const emit = (key, start, end) => {
      if (end <= start) return;
      const id = numericIds ? start * 0x4000000 + end : `${start}:${end}`;
      if (spans.has(id)) return;
      spans.add(id);
      out.push({ key, start, end });
    };
    this._scan(s, { types, ok }, emit);
    for (const run of s.matchAll(BIDI_RUN)) {
      const start = run.index;
      const end = start + run[0].length;
      const toRun = (key) => emit(key, start, end);
      this._scan([...run[0]].reverse().join(''), { types, ok }, toRun);
      this._scan(run[0].split(ALNUM_GROUPS).reverse().join(''), { types, ok }, toRun);
    }
    return out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  }

  // ---- reading ----

  _hits(scores, metas, excludeCaseId) {
    const titles = new Map(metas.map((c) => [c.id, c.title]));
    const out = [];
    const seen = new Set();
    for (const [key, { score, entity }] of scores) {
      const entry = this.data.entities[key];
      if (!entry) continue;
      for (const l of entry.links) {
        if (excludeCaseId && l.caseId === excludeCaseId) continue;
        const kind = l.factId ? 'fact' : 'document';
        const id = l.factId || l.docId;
        const dedupe = `${l.caseId}|${kind}|${id}|${entity}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ caseId: l.caseId, title: titles.get(l.caseId) || l.caseId, kind, id, score, entity });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  _keysFor(entity) {
    if (isObj(entity) && entity.type) return normalizeEntity(entity.type, entity.text);
    const text = String((isObj(entity) ? entity.text : entity) ?? '');
    // A bare string may be any kind: what the scans find in it, and the
    // whole string read as each kind.
    const known = (k) => Boolean(this.data.entities[k]);
    const keys = new Set(this._occurrences(text, { types: new Set(ALL_KINDS), ok: known }).map((o) => o.key));
    for (const type of ALL_KINDS) for (const k of normalizeEntity(type, text)) keys.add(k);
    return [...keys];
  }

  // → [{ caseId, title, kind: 'fact' | 'document', id, score, entity }].
  // `entity` is always a key of the query: a similar name in another case
  // scores below 1 but is reported under the searched key.
  searchEntities(entity, { excludeCaseId = null } = {}) {
    const metas = this._refresh();
    const keys = this._keysFor(entity);
    const scores = new Map(keys.map((k) => [k, { score: 1, entity: k }]));
    for (const k of keys) {
      const type = keyType(k);
      if (type !== 'person' && type !== 'org') continue;
      const mine = tokenSet(k);
      for (const other of Object.keys(this.data.entities)) {
        if (other === k || keyType(other) !== type) continue;
        const s = Math.round(jaccard(mine, tokenSet(other)) * 1000) / 1000;
        if (s >= NAME_MATCH && !(scores.get(other)?.score >= s)) scores.set(other, { score: s, entity: k });
      }
    }
    return this._hits(scores, metas, excludeCaseId);
  }

  matchText(text, { excludeCaseId = null } = {}) {
    const metas = this._refresh();
    const known = (k) => Boolean(this.data.entities[k]);
    const keys = new Set(this._occurrences(text, { types: new Set(ALL_KINDS), ok: known }).map((o) => o.key));
    return this._hits(new Map([...keys].map((k) => [k, { score: 1, entity: k }])), metas, excludeCaseId);
  }

  // → [{ caseId, title, docId }]; never the file name.
  casesWithDocument(sha256, { excludeCaseId = null } = {}) {
    const metas = this._refresh();
    const hash = String(sha256 || '').toLowerCase();
    if (!SHA256.test(hash)) return [];
    const entry = this.data.entities[`document:${hash}`];
    if (!entry) return [];
    const titles = new Map(metas.map((c) => [c.id, c.title]));
    return entry.links
      .filter((l) => l.caseId !== excludeCaseId)
      .map((l) => ({ caseId: l.caseId, title: titles.get(l.caseId) || l.caseId, docId: l.docId }));
  }

  // Spans of `text` naming an indexed entity that `caseId` holds no
  // disclosable fact about (program §4.9, R38). {{f-NNNN}} references are
  // blanked first; offsets are relative to the original text. Spans may
  // overlap (never two with the same bounds).
  nonDisclosableSpans(text, { caseId } = {}) {
    this._refresh();
    const original = String(text ?? '');
    const blanked = original.replace(REF_SPAN, (m) => ' '.repeat(m.length));
    let spanNames = false;
    try {
      spanNames = this.getSettings()?.cases?.ingest?.entities?.spanNames === true;
    } catch { /* default off */ }
    const types = new Set([...TEXT_KINDS, ...(spanNames ? NAME_KINDS : [])]);
    const memo = new Map();
    const ok = (key) => {
      let v = memo.get(key);
      if (v === undefined) {
        const entry = this.data.entities[key];
        v = Boolean(entry) && !entry.links.some((l) => l.caseId === caseId && l.factId && l.disclosable === true);
        memo.set(key, v);
      }
      return v;
    };
    return this._occurrences(blanked, { types, ok }).map((o) => ({
      span: { start: o.start, end: o.end, text: original.slice(o.start, o.end) },
      entity: o.key,
      reason: `entity ${o.key} is known only from non-disclosable records`
    }));
  }
}

module.exports = { EntityIndex, INDEX_VERSION };
