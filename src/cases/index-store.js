// src/cases/index-store.js
// The cross-case keyword index (cases stage 5 spec §3.1, program §4.10):
// BM25 over every case's facts, brief fields, questions, journal titles and
// software-repo live state, stored at <casesRoot>/.index/. Redaction happens
// here: a hit from another case carries text only for a disclosable fact or
// a brief title/objective. Everything is synchronous file I/O, and search
// never throws.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CaseStore } = require('./case-store');
const { FactLedger } = require('./ledger');
const { Brief } = require('./brief');
const { QuestionStore } = require('./questions');
const { readJson } = require('./jsonfile');
const { norm } = require('./jsonl');
const { TOKENIZER, tokenize } = require('./tokenize');
const { resolveCaseType } = require('./case-types');
const { createLogger } = require('../logging');

const VERSION = 1;
const K1 = 1.2;
const B = 0.75;
const TEXT_MAX = 2000;
const DOCS_MAX = 5000;
const JOURNAL_TITLE_MAX = 160;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// Windows device names: `.index/cases/NUL.json` would open the device.
const RESERVED_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const OPEN_STATUSES = Object.freeze(['draft', 'active', 'needs-direction', 'paused']);
const BRIEF_FIELDS = Object.freeze(['title', 'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'repo']);
const KIND_ORDER = Object.freeze({ brief: 0, fact: 1, question: 2, journal: 3 });
const JOURNAL_NAME = /^(\d{4}-\d{2}-\d{2}-\d{4})-([a-z0-9-]+?)(?:-(\d+))?\.md$/;
const FINGERPRINTED = Object.freeze(['case.yaml', 'facts.jsonl', 'brief.md', '.kl/questions', 'journal', '.kl/case-type.json']);

const clip = (s) => {
  const t = String(s ?? '');
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t;
};
const round = (n) => Math.round(n * 10000) / 10000;

function valueText(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function sortedTf(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const tf = {};
  for (const t of [...counts.keys()].sort()) tf[t] = counts.get(t);
  return tf;
}

// [mtimeMs, size] for a file; for a directory, [newest mtime of it and its
// entries, entry count], or [mtimeMs, -1] when it cannot be listed (onError
// hears why); [0, 0] when absent.
function stamp(p, onError) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return [0, 0];
  }
  if (!st.isDirectory()) return [st.mtimeMs, st.size];
  let names;
  try {
    names = fs.readdirSync(p);
  } catch (err) {
    onError(p, st, err);
    return [st.mtimeMs, -1];
  }
  let newest = st.mtimeMs;
  let count = 0;
  for (const name of names) {
    count += 1;
    try {
      newest = Math.max(newest, fs.statSync(path.join(p, name)).mtimeMs);
    } catch {
      // vanished between readdir and stat
    }
  }
  return [newest, count];
}

function fingerprintOf(dir, onError) {
  const fp = {};
  for (const rel of FINGERPRINTED) fp[rel] = stamp(path.join(dir, ...rel.split('/')), onError);
  return fp;
}

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrOrNull = (v) => v === null || typeof v === 'string';

// A stored document or record of the wrong shape is stale, never trusted.
function validDoc(d) {
  return isObj(d)
    && Object.hasOwn(KIND_ORDER, d.kind)
    && isStr(d.id)
    && isStr(d.text)
    && isStrOrNull(d.subject)
    && isStrOrNull(d.attr)
    && isStrOrNull(d.provenance)
    && typeof d.disclosable === 'boolean'
    && Number.isInteger(d.len) && d.len >= 0
    && isObj(d.tf)
    && Object.values(d.tf).every((n) => Number.isInteger(n) && n > 0);
}

function validRecord(rec, caseId) {
  return isObj(rec)
    && rec.caseId === caseId
    && ['slug', 'title', 'objective', 'type', 'status', 'created'].every((k) => isStr(rec[k]))
    && Array.isArray(rec.keys) && rec.keys.every(isStr)
    && isObj(rec.fingerprint)
    && Array.isArray(rec.docs) && rec.docs.every(validDoc);
}

// Only the part after the first `:` names the thing; an empty one would
// match any text in searchCases.
const keyHasValue = (k) => k.slice(k.indexOf(':') + 1).trim() !== '';

const sameFingerprint = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

class CrossCaseIndex {
  constructor(root, { store = null, log = null } = {}) {
    if (!root) throw new Error('CrossCaseIndex requires the cases root.');
    this.root = root;
    this.dir = path.join(root, '.index');
    this.casesDir = path.join(this.dir, 'cases');
    this.store = store || new CaseStore({ root });
    this.log = log || createLogger('cases/index');
    // C7 attaches its EntityIndex here (R46); null until then.
    this.entities = null;
    this.records = new Map();
    this.postings = null;
    this.loaded = false;
    this.memoryOnly = false;
    this.warned = new Set();
  }

  attachEntities(entityIndex) {
    this.entities = entityIndex || null;
  }

  _entities(method, ...args) {
    if (!this.entities || typeof this.entities[method] !== 'function') return;
    try {
      this.entities[method](...args);
    } catch (err) {
      this.log.warn(`Entity index ${method} failed: ${err.message}`);
    }
  }

  _warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  // ---- Files ----

  // Not jsonfile.writeJson: spec §3.1 names the temp file
  // <name>.<pid>.<rand>.tmp (two instances on one root never share one) and
  // stores compact JSON, while writeJson pretty-prints to <name>.tmp-<pid>-<ms>.
  // A failed write also switches the index to memory-only instead of throwing.
  _writeFile(file, text) {
    if (this.memoryOnly) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const gitignore = path.join(this.dir, '.gitignore');
      if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (err) {
      this.memoryOnly = true;
      this.log.warn(`The case index at ${this.dir} cannot be written (${err.message}); keeping it in memory.`);
    }
  }

  _caseFile(caseId) {
    return path.join(this.casesDir, `${caseId}.json`);
  }

  _writeMeta() {
    this._writeFile(path.join(this.dir, 'meta.json'), `${JSON.stringify({ version: VERSION, tokenizer: TOKENIZER, builtAt: new Date().toISOString() })}\n`);
  }

  _metaCurrent() {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8'));
    } catch {
      return false;
    }
    return Boolean(meta) && meta.version === VERSION && meta.tokenizer === TOKENIZER;
  }

  // ---- Documents ----

  _buildRecord(meta) {
    const dir = meta.dir;
    const fingerprint = this._fingerprint(dir);
    const fpKey = `${meta.id}:${JSON.stringify(fingerprint)}`;
    const part = (label, fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        this._warnOnce(`${fpKey}:${label}`, `Case index: skipped the ${label} of case ${meta.slug}: ${err.message}`);
        return fallback;
      }
    };
    const brief = part('brief', () => new Brief(dir).read().data || {}, {});
    const snapshot = part('case-type snapshot', () => readJson(path.join(dir, '.kl', 'case-type.json'), null), null);
    const docs = [];
    const add = (doc) => {
      const text = clip(doc.text);
      const toks = tokenize(text);
      docs.push({
        kind: doc.kind,
        id: doc.id,
        text,
        subject: doc.subject ?? null,
        attr: doc.attr ?? null,
        provenance: doc.provenance ?? null,
        disclosable: Boolean(doc.disclosable),
        at: doc.at || '',
        len: toks.length,
        tf: sortedTf(toks)
      });
    };

    const briefDocs = [];
    for (const field of BRIEF_FIELDS) {
      const raw = field === 'title' ? meta.title : brief[field];
      const text = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string').join('; ') : (typeof raw === 'string' ? raw : '');
      if (text.trim()) briefDocs.push({ kind: 'brief', id: field, text, subject: null, attr: field, disclosable: field === 'title' || field === 'objective' });
    }
    const state = snapshot && typeof snapshot === 'object' ? snapshot.state || {} : {};
    for (const pr of Array.isArray(state.openPrs) ? state.openPrs : []) {
      if (pr && Number.isInteger(pr.number)) briefDocs.push({ kind: 'brief', id: `pr:${pr.number}`, text: String(pr.title || ''), subject: null, attr: 'pr', disclosable: false });
    }
    for (const b of Array.isArray(state.branches) ? state.branches : []) {
      if (typeof b === 'string' && b) briefDocs.push({ kind: 'brief', id: `branch:${b}`, text: b.replace(/[/_-]+/g, ' '), subject: null, attr: 'branch', disclosable: false });
    }

    const rest = [];
    const facts = part('facts', () => new FactLedger(dir).view().facts, new Map());
    for (const f of facts.values()) {
      if (f.status !== 'active') continue;
      const text = [f.stmt, valueText(f.value), f.unit || ''].filter(Boolean).join(' ');
      rest.push({ kind: 'fact', id: f.id, text, subject: f.subject, attr: f.attr, provenance: f.provenance, disclosable: f.disclosable === true, at: f.at });
    }
    const questions = part('questions', () => new QuestionStore(dir, { caseId: meta.id }).list(), []);
    for (const q of questions) {
      const labels = (Array.isArray(q.options) ? q.options : []).map((o) => o.label).join(' ');
      const state2 = q.closed ? 'closed' : (q.answer ? 'answered' : 'open');
      rest.push({ kind: 'question', id: q.id, text: [q.text, labels].filter(Boolean).join(' '), subject: null, attr: state2, disclosable: false, at: q.createdAt });
    }
    const journal = part('journal', () => fs.readdirSync(path.join(dir, 'journal')), []);
    for (const name of journal) {
      const m = JOURNAL_NAME.exec(name);
      if (!m) continue;
      const first = part(`journal entry ${name}`, () => fs.readFileSync(path.join(dir, 'journal', name), 'utf8')
        .split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '', '');
      rest.push({ kind: 'journal', id: name, text: `${first.slice(0, JOURNAL_TITLE_MAX)} ${m[2]}`.trim(), subject: null, attr: m[2], disclosable: false, at: m[1] });
    }
    // Newest first when capping, then a stable order for storage.
    rest.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
    const kept = [...briefDocs, ...rest].slice(0, DOCS_MAX);
    for (const d of kept) add(d);
    docs.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));

    let keys = [];
    const type = resolveCaseType(meta.type);
    if (typeof type.indexKeys === 'function') {
      keys = part('index keys', () => type.indexKeys({ brief, snapshot }) || [], []);
    }
    return {
      caseId: meta.id,
      slug: meta.slug,
      title: String(meta.title || ''),
      objective: typeof brief.objective === 'string' ? brief.objective : '',
      type: String(meta.type || 'general'),
      status: String(meta.status || 'draft'),
      created: String(meta.created || ''),
      keys: [...new Set(keys.map(norm))].filter(keyHasValue).sort(),
      fingerprint,
      docs: docs.map(({ at, ...d }) => d)
    };
  }

  _store(record) {
    this.records.set(record.caseId, record);
    this.postings = null;
    this._writeFile(this._caseFile(record.caseId), `${JSON.stringify(record)}\n`);
  }

  _fingerprint(dir) {
    return fingerprintOf(dir, (p, st, err) => this._warnOnce(`unreadable:${p}:${st.mtimeMs}`, `Case index: cannot list ${p} (${err.message}); skipping it.`));
  }

  _validId(id) {
    if (typeof id === 'string' && ID_PATTERN.test(id) && !RESERVED_ID.test(id)) return true;
    this._warnOnce(`bad-id:${id}`, `Case index: skipped a case with id ${JSON.stringify(id)}; ids must match ${ID_PATTERN} and not be a Windows device name.`);
    return false;
  }

  // ---- Loading and freshness ----

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this._metaCurrent()) {
      this.rebuild();
      return;
    }
    let names = [];
    try {
      names = fs.readdirSync(this.casesDir).filter((n) => n.endsWith('.json'));
    } catch {
      names = [];
    }
    for (const name of names) {
      const caseId = name.slice(0, -5);
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(this.casesDir, name), 'utf8'));
      } catch {
        rec = null;
      }
      // A corrupt file, one whose caseId does not match its name, or one of
      // the wrong shape is stale: the next refresh rewrites it.
      if (validRecord(rec, caseId)) this.records.set(caseId, rec);
    }
  }

  _refresh() {
    this._load();
    const listed = new Set();
    for (const meta of this.store.list()) {
      if (!this._validId(meta.id)) continue;
      listed.add(meta.id);
      const rec = this.records.get(meta.id);
      if (!rec || !sameFingerprint(rec.fingerprint, this._fingerprint(meta.dir))) this._store(this._buildRecord(meta));
    }
    for (const caseId of [...this.records.keys()]) {
      if (!listed.has(caseId)) this._drop(caseId);
    }
  }

  _drop(caseId) {
    this.records.delete(caseId);
    this.postings = null;
    if (!this.memoryOnly) {
      try {
        fs.rmSync(this._caseFile(caseId), { force: true });
      } catch (err) {
        this.log.warn(`Case index: could not remove ${caseId}: ${err.message}`);
      }
    }
  }

  _postings() {
    if (this.postings) return this.postings;
    const terms = new Map();
    let total = 0;
    let count = 0;
    for (const rec of this.records.values()) {
      rec.docs.forEach((doc, i) => {
        count += 1;
        total += doc.len;
        for (const [t, n] of Object.entries(doc.tf)) {
          if (!terms.has(t)) terms.set(t, []);
          terms.get(t).push({ caseId: rec.caseId, i, n });
        }
      });
    }
    this.postings = { terms, count, avgdl: count ? total / count : 0 };
    return this.postings;
  }

  // ---- Public API ----

  rebuild() {
    const started = Date.now();
    this.loaded = true;
    this.records.clear();
    this.postings = null;
    let docs = 0;
    const ids = new Set();
    for (const meta of this.store.list()) {
      if (!this._validId(meta.id)) continue;
      const rec = this._buildRecord(meta);
      ids.add(rec.caseId);
      docs += rec.docs.length;
      this._store(rec);
    }
    if (!this.memoryOnly && fs.existsSync(this.casesDir)) {
      let names = [];
      try {
        names = fs.readdirSync(this.casesDir);
      } catch (err) {
        this.log.warn(`Case index: cannot list ${this.casesDir} (${err.message}); stale files stay.`);
      }
      for (const name of names) {
        if (name.endsWith('.json') && ids.has(name.slice(0, -5))) continue;
        try {
          fs.rmSync(path.join(this.casesDir, name), { force: true });
        } catch (err) {
          this.log.warn(`Case index: could not remove ${name}: ${err.message}`);
        }
      }
    }
    if (ids.size || fs.existsSync(this.dir)) this._writeMeta();
    this._entities('rebuild');
    return { cases: ids.size, docs, ms: Date.now() - started };
  }

  // Never throws: an index failure must not fail the write that called it.
  upsertCase(id) {
    if (!this._validId(id)) return { skipped: 'bad-id' };
    try {
      this._load();
      const meta = this.store.list().find((c) => c.id === id);
      if (!meta) {
        this.removeCase(id);
        return { removed: true };
      }
      const rec = this._buildRecord(meta);
      this._store(rec);
      this._entities('upsertCase', id);
      return { docs: rec.docs.length };
    } catch (err) {
      this.log.warn(`Case index: upsert of ${id} failed: ${err.message}`);
      return { skipped: 'error' };
    }
  }

  removeCase(id) {
    if (!this._validId(id)) return;
    try {
      this._load();
      this._drop(id);
    } catch (err) {
      this.log.warn(`Case index: removing ${id} failed: ${err.message}`);
    }
    this._entities('removeCase', id);
  }

  // Scored documents over all cases; text is used here only.
  _rank({ text, subject = null, attr = null }) {
    const q = [...new Set(tokenize(text))];
    const { terms, count, avgdl } = this._postings();
    const scores = new Map();
    const matched = new Map();
    for (const t of q) {
      const list = terms.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (count - list.length + 0.5) / (list.length + 0.5));
      for (const { caseId, i, n } of list) {
        const doc = this.records.get(caseId).docs[i];
        const k = `${caseId}\u0000${i}`;
        const s = idf * (n * (K1 + 1)) / (n + K1 * (1 - B + B * (doc.len / (avgdl || 1))));
        scores.set(k, (scores.get(k) || 0) + s);
        if (!matched.has(k)) matched.set(k, new Set());
        matched.get(k).add(t);
      }
    }
    const keyMatch = new Set();
    if (subject) {
      const s = norm(subject);
      const a = norm(attr);
      for (const rec of this.records.values()) {
        rec.docs.forEach((doc, i) => {
          if (doc.kind !== 'fact' || norm(doc.subject) !== s) return;
          const k = `${rec.caseId}\u0000${i}`;
          if (attr && norm(doc.attr) === a) {
            keyMatch.add(k);
            scores.set(k, (scores.get(k) || 0) + 5);
          } else if (scores.has(k)) {
            scores.set(k, scores.get(k) + 2);
          }
        });
      }
    }
    const out = [];
    for (const [k, score] of scores) {
      if (score <= 0 && !keyMatch.has(k)) continue;
      const [caseId, i] = k.split('\u0000');
      const rec = this.records.get(caseId);
      const doc = rec.docs[Number(i)];
      out.push({ rec, doc, score, tokens: matched.get(k) || new Set(), key: keyMatch.has(k), coverage: q.length ? (matched.get(k)?.size || 0) / q.length : 0 });
    }
    out.sort((x, y) => y.score - x.score
      || x.rec.created.localeCompare(y.rec.created)
      || x.doc.id.localeCompare(y.doc.id));
    return { hits: out, queryTokens: q };
  }

  _fresh(fn, fallback) {
    try {
      this._refresh();
      return fn();
    } catch (err) {
      this.log.warn(`Case index search failed: ${err.message}`);
      return fallback;
    }
  }

  search({ text = '', subject, attr, kinds, forCaseId = null, excludeCaseId = null, statuses, limit = 20, includePrivate = false } = {}) {
    return this._fresh(() => {
      const { hits } = this._rank({ text, subject, attr });
      return hits
        .filter((h) => !Array.isArray(kinds) || kinds.includes(h.doc.kind))
        .filter((h) => !excludeCaseId || h.rec.caseId !== excludeCaseId)
        .filter((h) => !Array.isArray(statuses) || statuses.includes(h.rec.status))
        .slice(0, Math.max(0, limit))
        .map((h) => {
          const own = forCaseId !== null && forCaseId !== undefined && h.rec.caseId === forCaseId;
          const shareable = (h.doc.kind === 'fact' && h.doc.disclosable === true)
            || (h.doc.kind === 'brief' && (h.doc.id === 'title' || h.doc.id === 'objective'));
          const visible = includePrivate === true || own || shareable;
          // Hidden text hides its names too: a redacted fact keeps its slugs
          // unless the caller named that pair, and a live-state id carries
          // the branch name or PR number.
          // A journal id is its file name, which can be hand-written, and its
          // attr is the kind from that name: both are hidden with the text.
          const journal = h.doc.kind === 'journal';
          const hiddenId = journal || (h.doc.kind === 'brief' && /^(branch|pr):/.test(h.doc.id));
          const slugs = visible || (h.doc.kind !== 'fact' && !journal) || h.key;
          return {
            caseId: h.rec.caseId,
            title: h.rec.title,
            kind: h.doc.kind,
            id: visible || !hiddenId ? h.doc.id : null,
            score: round(h.score),
            text: visible ? h.doc.text : null,
            redacted: !visible,
            subject: slugs ? h.doc.subject : null,
            attr: slugs ? h.doc.attr : null,
            provenance: h.doc.provenance,
            disclosable: h.doc.disclosable,
            caseStatus: h.rec.status,
            coverage: round(h.coverage),
            // Distinct query tokens the document holds (see gates.redactedClose).
            matched: h.tokens.size
          };
        });
    }, []);
  }

  // Cases ranked by their best documents (max + 0.3 × the next two); a case
  // is kept when it matched two distinct query tokens or one of its keys.
  // Private text scores here but never leaves: rows carry no text, so a
  // forCaseId option changes nothing and is not read.
  searchCases({ text = '', excludeCaseId = null, statuses, kinds, limit = 5 } = {}) {
    return this._fresh(() => {
      const { hits } = this._rank({ text });
      const lower = String(text || '').toLowerCase();
      const byCase = new Map();
      for (const h of hits) {
        if (Array.isArray(kinds) && !kinds.includes(h.doc.kind)) continue;
        if (excludeCaseId && h.rec.caseId === excludeCaseId) continue;
        if (Array.isArray(statuses) && !statuses.includes(h.rec.status)) continue;
        if (!byCase.has(h.rec.caseId)) byCase.set(h.rec.caseId, { rec: h.rec, scores: [], tokens: new Set() });
        const g = byCase.get(h.rec.caseId);
        g.scores.push(h.score);
        for (const t of h.tokens) g.tokens.add(t);
      }
      const rows = [];
      for (const g of byCase.values()) {
        const keyHit = g.rec.keys.some((k) => lower.includes(k.slice(k.indexOf(':') + 1)));
        if (g.tokens.size < 2 && !keyHit) continue;
        const s = g.scores.sort((a, b) => b - a);
        rows.push({
          caseId: g.rec.caseId,
          title: g.rec.title,
          slug: g.rec.slug,
          status: g.rec.status,
          created: g.rec.created,
          score: round(s[0] + 0.3 * ((s[1] || 0) + (s[2] || 0))),
          hits: s.length
        });
      }
      rows.sort((a, b) => b.score - a.score || a.created.localeCompare(b.created) || a.caseId.localeCompare(b.caseId));
      return rows.slice(0, Math.max(0, limit));
    }, []);
  }

  casesWithKey(key) {
    const wanted = norm(key);
    return this._fresh(() => [...this.records.values()]
      .filter((r) => r.keys.includes(wanted))
      .sort((a, b) => a.created.localeCompare(b.created))
      .map((r) => ({ caseId: r.caseId, title: r.title, status: r.status })), []);
  }

  // Exact per-case fields for findSimilarCases (one-token titles included).
  openCaseHeads() {
    return this._fresh(() => [...this.records.values()]
      .filter((r) => OPEN_STATUSES.includes(r.status))
      .sort((a, b) => a.created.localeCompare(b.created))
      .map((r) => ({ caseId: r.caseId, title: r.title, objective: r.objective, status: r.status })), []);
  }
}

module.exports = { CrossCaseIndex, INDEX_VERSION: VERSION, OPEN_STATUSES, ID_PATTERN };
