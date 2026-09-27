// src/cases/ingest/index.js
// IngestService (cases stage 7 spec §3.5): stores documents in a case, reads
// them (text layer, vision OCR), proposes facts, checks them, and applies the
// owner's review. Model work runs outside the case lock; only the short
// publishes of .kl/ingest/ files hold it, through CaseRuntime.systemAction.
//
// Everything that comes back from disk or a model is untrusted:
// - a docId is checked before any path is built from it (ruling M8), and a
//   record's `ref` resolves under the case's sources/ or the record fails
//   (ruling M7);
// - records, text stores, the page cache and kept publishes can be written
//   by the model's Bash or arrive in an import: they are reshaped, bounded
//   and checked against the docId they are stored under before use;
// - file names and model output are one-lined and capped wherever they are
//   stored or shown (ruling M10); page text only ever goes to a model
//   inside the untrusted fence (propose.js, review.js), and nothing from a
//   document or a reply becomes a path, a tool name or an option id.
//
// Residuals (documented, not closed here): between refPath() resolving a
// ref and the open() of the file, a directory on the way can be swapped for
// a link (the same TOCTOU as C2's write guard; the model's Bash can already
// read files); a forged page cache or kept publish is trusted like any other
// case file the shell can write (ruling M14, T7-forgedindex).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { QuestionStore } = require('../questions');
const { IngestError } = require('./errors');
const { resolveIngestSettings } = require('./settings');
const store = require('./store');
const files = require('./files');
const { openPdf: defaultOpenPdf } = require('./pdf');
const { extractPages, parsePages, textQuality, MIN_TEXT_CHARS } = require('./extract-text');
const vision = require('./vision');
const propose = require('./propose');
const review = require('./review');
const { MAX_REPLY_CHARS } = require('./call-model');

const SERVICES = new WeakMap();
const ingestServiceFor = (runtime) => (runtime && SERVICES.get(runtime)) || null;

const ORIGIN_KINDS = new Set(['owner-drop', 'owner-paste', 'tool']);
const OWNER_ORIGINS = new Set(['owner-drop', 'owner-paste']);
const WAITING = new Set(['paused', 'done', 'abandoned']);
// 'stored': a crash between the stored commit and the first extracting
// publish would otherwise leave a dropped document unread.
const RESUMABLE = new Set(['stored', 'extracting', 'proposing', 'checking']);
const BY = new Set(['owner', 'tool', 'auto', 'resume']);
const RETRY_MS = 60 * 1000;
const DOC_CHANGED = 'The document changed since it was read. Extract again.';
// A PDF reader that died or timed out fails the whole document (T3b/T4).
const READER_DOWN = new Set(['PDF_WORKER_FAILED', 'PDF_TIMEOUT']);
const TOO_LARGE = 'page too large for vision';
// Caps on what is stored or shown (ruling M10).
const NOTE_CAP = 300;
const MODEL_CAP = 120;
const MESSAGE_CAP = 200;
const JOURNAL_CAP = 4000;
const PAGES_SPEC_CAP = 2000;
// A cached page price above this was not written by the host.
const MAX_PAGE_USD = 100;
// Owner review (spec §3.5). Only the owner reviews: from the panel, or by
// answering a review question. The model has no path here.
const REVIEW_ACTIONS = new Set(['accept', 'edit', 'reject']);
const REVIEWER = /^(?:panel|question:q-\d{4,})$/;
const QUESTION_ID = /^q-\d{4,}$/;
const FACT_ID = /^f-\d{4,}$/;
const ID_CAP = 24;
const EDITABLE = Object.freeze(['stmt', 'subject', 'attr', 'unit', 'category', 'value']);
const VALUE_NOT_IN_QUOTE = 'The new value is not in the quoted text. Reject this proposal and tell King Louie the value in chat.';
// The review question's options are this fixed set; nothing from a document
// or a model becomes an option id.
const REVIEW_OPTIONS = new Set(['a', 'b', 'c']);

const round = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const money = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const pageNo = (n) => Number.isSafeInteger(n) && n >= 1;
const oneLine = (v, max) => store.oneLine(v, max);
// "CODE: sentence" for a record note, one line.
const noteOf = (err) => oneLine(`${err?.code ? `${err.code}: ` : ''}${err?.message || String(err)}`, NOTE_CAP);

// A record read from disk, reshaped so the pipeline never trips over a field
// of the wrong type (the file is case data anyone with a shell can edit).
function shapeRecord(rec) {
  const usd = isObj(rec.usd) ? rec.usd : {};
  return {
    ...rec,
    name: store.cleanName(typeof rec.name === 'string' ? rec.name : 'document'),
    note: typeof rec.note === 'string' ? oneLine(rec.note, NOTE_CAP) : null,
    pageCount: pageNo(rec.pageCount) ? rec.pageCount : null,
    pages: arr(rec.pages).filter((p) => isObj(p) && pageNo(p.n)),
    proposals: arr(rec.proposals).filter(isObj),
    refused: arr(rec.refused),
    failedChunks: arr(rec.failedChunks).filter((c) => isObj(c) && pageNo(c.fromPage) && pageNo(c.toPage)),
    proposedPages: arr(rec.proposedPages).filter(pageNo),
    truncated: isObj(rec.truncated) && pageNo(rec.truncated.fromPage) ? rec.truncated : null,
    usd: { ocr: money(usd.ocr), extract: money(usd.extract), verify: money(usd.verify) }
  };
}

// A text store for docId, or an empty one.
function shapeText(text, docId, sha256) {
  const pages = isObj(text) && text.docId === docId ? arr(text.pages) : [];
  return {
    docId,
    sha256,
    pages: pages.filter((p) => isObj(p) && pageNo(p.n) && typeof p.text === 'string' && (p.method === 'text' || p.method === 'ocr'))
  };
}

// A cached OCR page as the host writes it, or null.
function validCache(entry, n) {
  if (!isObj(entry) || entry.n !== n || entry.method !== 'ocr') return null;
  if (typeof entry.text !== 'string' || entry.text.length > MAX_REPLY_CHARS) return null;
  const usd = entry.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_PAGE_USD) return null;
  if (typeof entry.charged !== 'boolean') return null;
  return {
    n,
    method: 'ocr',
    text: entry.text,
    usd,
    usdEstimated: entry.usdEstimated === true,
    model: oneLine(entry.model, MODEL_CAP) || null,
    charged: entry.charged
  };
}

class IngestService {
  constructor({ runtime, callModel, getCapabilities = null, getSettings = () => ({}), log = null, now = () => new Date(), retryMs = RETRY_MS, openPdf = defaultOpenPdf }) {
    if (!runtime) throw new Error('IngestService requires a CaseRuntime.');
    if (typeof callModel !== 'function') throw new Error('IngestService requires callModel.');
    this.runtime = runtime;
    this.callModel = callModel;
    this.getCapabilities = typeof getCapabilities === 'function' ? getCapabilities : () => ({});
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.log = log || createLogger('cases/ingest');
    this.now = typeof now === 'function' ? now : () => new Date();
    this.retryMs = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : RETRY_MS;
    this.openPdf = typeof openPdf === 'function' ? openPdf : defaultOpenPdf;
    this.queue = [];
    this.running = false;
    this.idle = Promise.resolve();
    this.timer = null;
    this.pending = new Set();
    // Set by close() (ruling M16); every case write and model call in
    // flight is tracked so close() can await it.
    this.closed = false;
    this.inFlight = new Set();
    this.calls = new Set();
    SERVICES.set(runtime, this);
  }

  settings() {
    let raw = {};
    try {
      raw = this.getSettings()?.cases?.ingest || {};
    } catch (err) {
      this.log.warn(`Reading ingest settings failed: ${err.message}`);
    }
    return resolveIngestSettings(raw);
  }

  _timeZone() {
    try {
      const tz = this.getSettings()?.cases?.timeZone;
      return typeof tz === 'string' ? tz : '';
    } catch {
      return '';
    }
  }

  _notify(caseId, docId) {
    try {
      this.runtime._notify?.('case:changed', { caseId, what: 'sources', docId });
    } catch { /* the panel refreshes on its own */ }
  }

  _entities() {
    try {
      return typeof this.runtime.entityIndex === 'function' ? this.runtime.entityIndex() : null;
    } catch (err) {
      this.log.warn(`Entity index unavailable: ${err.message}`);
      return null;
    }
  }

  // Other cases holding the same bytes: case id and title only, never a
  // file name or anything from the other case.
  _alsoInCases(caseId, sha) {
    try {
      const seen = new Set();
      const out = [];
      for (const hit of this._entities()?.casesWithDocument(sha, { excludeCaseId: caseId }) || []) {
        if (!hit || hit.caseId === caseId || seen.has(hit.caseId)) continue;
        seen.add(hit.caseId);
        out.push({ caseId: hit.caseId, title: hit.title });
      }
      return out;
    } catch (err) {
      this.log.warn(`Cross-case document lookup failed: ${err.message}`);
      return [];
    }
  }

  _newRecord(stored, { name, origin, pageCount, caseStatus }) {
    const at = this.now().toISOString();
    return {
      docId: stored.docId,
      ref: stored.ref,
      name,
      sha256: stored.sha256,
      mime: stored.mime,
      origin,
      status: 'stored',
      createdAt: at,
      updatedAt: at,
      note: WAITING.has(caseStatus) ? `extraction waits: case is ${caseStatus}` : null,
      pageCount,
      pages: [],
      truncated: null,
      failedChunks: [],
      droppedProposals: 0,
      usd: { ocr: 0, extract: 0, verify: 0 },
      questionId: null,
      proposedPages: [],
      nextProposal: 1,
      proposals: [],
      refused: []
    };
  }

  // Opens a PDF only to count its pages; always closed.
  async _pageCount(mime, bytes, name, cfg) {
    if (mime !== 'application/pdf') return 1;
    const pdf = await this.openPdf(bytes, { name, maxBytes: cfg.maxBytes });
    try {
      if (pdf.pageCount > cfg.maxPages) {
        throw new IngestError('TOO_MANY_PAGES', `Cannot ingest ${name}: it has ${pdf.pageCount} pages; the limit is ${cfg.maxPages}.`);
      }
      return pdf.pageCount;
    } finally {
      await pdf.close().catch((err) => this.log.warn(`Closing ${name} failed: ${err.message}`));
    }
  }

  // An existing record for docId whose ref is not a confined ref (M7):
  // storeDocument/adoptDocument would throw BAD_PATH on it (T2 carry), so the
  // record is marked failed in its own commit and the drop is refused with
  // that BAD_PATH. Nothing is read through the forged ref.
  async _refuseForgedRecord(meta, docId) {
    const bad = (dir) => {
      const prior = files.readRecord(dir, docId);
      if (!prior) return null;
      try {
        store.refPath(dir, prior.ref);
        return null;
      } catch (err) {
        if (err?.code !== 'BAD_PATH') throw err;
        return { rec: shapeRecord(prior), err };
      }
    };
    const found = bad(meta.dir);
    if (!found) return;
    await this._locked(meta.id, `ingest ${docId}: failed`, async (m) => {
      const now = bad(m.dir);
      if (!now) return;
      const note = noteOf(now.err);
      if (now.rec.status === 'failed' && now.rec.note === note) return;
      files.writeRecord(m.dir, { ...now.rec, status: 'failed', note, updatedAt: this.now().toISOString() });
      this.runtime.records(m.id).writeJournal('ingest', `The ingest record of ${now.rec.name} (${docId}) names a file outside sources/; it was marked failed and nothing was read.`, this.now());
    }, { commitMessage: `ingest-${docId}: failed ${found.rec.name}` });
    throw found.err;
  }

  // ---- storing ----

  async store(caseId, { name, mime, bytes, origin } = {}) {
    this._assertOpen();
    const meta = this.runtime.getCase(caseId);
    const kind = origin?.kind;
    if (!ORIGIN_KINDS.has(kind)) throw new IngestError('BAD_ORIGIN', `origin.kind must be one of ${[...ORIGIN_KINDS].join(', ')}.`);
    if (!(bytes instanceof Uint8Array)) throw new IngestError('BAD_BYTES', 'The document must be given as bytes.');
    const cfg = this.settings();
    const label = store.cleanName(typeof name === 'string' ? name : 'document');
    // Size first, then a private copy the caller cannot change under us.
    store.checkSize(label, bytes.length, cfg.maxBytes);
    const buf = Buffer.from(bytes);
    const type = store.sniffType({ name: label, mime: typeof mime === 'string' ? mime : '', bytes: buf });
    const pageCount = await this._pageCount(type.mime, buf, label, cfg);
    const hash = store.sha256(buf);
    const docId = store.docIdFor(hash);
    const originRec = { kind, at: this.now().toISOString() };
    await this._refuseForgedRecord(meta, docId);
    const result = await this._locked(meta.id, `ingest ${docId}: store`, async (m) => {
      const out = store.storeDocument(m.dir, {
        name: label, mime: type.mime, bytes: buf, origin: originRec, now: this.now(), timeZone: this._timeZone(), maxBytes: cfg.maxBytes, pages: pageCount
      });
      if (out.duplicate) return { out, status: m.status };
      files.ensureCacheIgnored(m.dir);
      files.writeRecord(m.dir, this._newRecord(out, { name: label, origin: originRec, pageCount, caseStatus: m.status }));
      this.runtime.records(m.id).writeJournal('ingest', `Stored ${label} as ${out.ref} (${out.docId}), added by ${kind === 'tool' ? 'King Louie' : 'the owner'}.`, this.now());
      return { out, status: m.status };
    }, { commitMessage: `ingest-${docId}: stored ${label}` });
    return this._afterStore(meta, result.out, result.status, kind === 'tool' ? 'tool' : 'auto');
  }

  async adopt(caseId, relPath, { origin = { kind: 'tool' } } = {}) {
    this._assertOpen();
    const meta = this.runtime.getCase(caseId);
    if (origin?.kind !== 'tool') throw new IngestError('BAD_ORIGIN', 'Adopted files have origin.kind "tool".');
    const cfg = this.settings();
    const found = store.resolveAdoptable(meta.dir, relPath, { maxBytes: cfg.maxBytes });
    const pageCount = await this._pageCount(found.mime, found.bytes, found.name, cfg);
    const originRec = { kind: 'tool', at: this.now().toISOString() };
    await this._refuseForgedRecord(meta, found.docId);
    const result = await this._locked(meta.id, `ingest ${found.docId}: adopt`, async (m) => {
      // The file is read outside the lock (page count) and again inside: a
      // file that changed in between is refused before a sidecar is
      // written, not recorded with the other version's page count. The
      // second check covers a change during adoptDocument's own read.
      const changed = () => ({ changed: new IngestError('CHANGED', `Cannot ingest ${found.name}: the file changed while it was being added. Try again.`) });
      if (store.resolveAdoptable(m.dir, relPath, { maxBytes: cfg.maxBytes }).sha256 !== found.sha256) return changed();
      const out = store.adoptDocument(m.dir, relPath, { origin: originRec, now: this.now(), maxBytes: cfg.maxBytes, pages: pageCount });
      if (out.sha256 !== found.sha256) return changed();
      if (out.duplicate) return { out, status: m.status };
      files.ensureCacheIgnored(m.dir);
      files.writeRecord(m.dir, this._newRecord(out, { name: found.name, origin: originRec, pageCount, caseStatus: m.status }));
      this.runtime.records(m.id).writeJournal('ingest', `King Louie added ${out.ref} (${out.docId}) for reading.`, this.now());
      return { out, status: m.status };
    }, { commitMessage: `ingest-${found.docId}: stored ${found.name}` });
    if (result.changed) throw result.changed;
    return this._afterStore(meta, result.out, result.status, null);
  }

  // Starts the automatic read after a new store (capped like a tool read);
  // `startBy` null leaves starting to the caller.
  _afterStore(meta, stored, caseStatus, startBy) {
    const rec = files.readRecord(meta.dir, stored.docId);
    if (!stored.duplicate) {
      this._notify(meta.id, stored.docId);
      if (startBy && !WAITING.has(caseStatus)) {
        this.extract(meta.id, stored.docId, { by: startBy }).catch((err) => this.log.warn(`Reading ${stored.docId} failed: ${err.message}`));
      }
    }
    return {
      docId: stored.docId,
      ref: stored.ref,
      status: typeof rec?.status === 'string' ? rec.status : 'stored',
      duplicate: Boolean(stored.duplicate),
      alsoInCases: this._alsoInCases(meta.id, stored.sha256)
    };
  }

  // ---- queue ----

  // pages for a document: parsed against its page count, which is itself
  // bounded by maxPages (a record's pageCount is untrusted).
  _pages(spec, rec, cfg) {
    if (spec === null || spec === undefined || spec === '') return null;
    const text = Array.isArray(spec) ? spec.join(',') : spec;
    if (typeof text !== 'string' && typeof text !== 'number') throw new IngestError('BAD_PAGES', 'pages must look like "1-3,7".');
    if (String(text).length > PAGES_SPEC_CAP) throw new IngestError('BAD_PAGES', 'pages must look like "1-3,7" and be shorter.');
    const limit = Math.min(pageNo(rec.pageCount) ? rec.pageCount : cfg.maxPages, cfg.maxPages);
    return parsePages(String(text), limit);
  }

  // Queues a read. by: 'owner' (the panel's Extract / Read-remaining button,
  // no page cap), 'tool' and 'auto' (capped per call), 'resume'.
  extract(caseId, docId, { pages = null, by = 'owner' } = {}) {
    try {
      this._assertOpen();
      store.checkDocId(docId);
      if (!BY.has(by)) throw new IngestError('BAD_REQUEST', `by must be one of ${[...BY].join(', ')}.`);
      const meta = this.runtime.getCase(caseId);
      const rec = files.readRecord(meta.dir, docId);
      if (!rec) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
      const wanted = this._pages(pages, rec, this.settings());
      return new Promise((resolve, reject) => {
        this.queue.push({ caseId: meta.id, docId, pages: wanted, by, resolve, reject });
        this._pump();
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  _pump() {
    if (this.running) return;
    this.running = true;
    this.idle = (async () => {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          job.resolve(await this._run(job));
        } catch (err) {
          this.log.warn(`Ingest of ${job.docId} in case ${job.caseId} failed: ${err.message}`);
          job.reject(err);
        }
      }
      this.running = false;
    })();
  }

  // ---- shutdown (ruling M16) ----

  _assertOpen() {
    if (this.closed) throw new IngestError('SHUTTING_DOWN', 'King Louie is shutting down; document ingest is stopped.');
  }

  // Every case write goes through here: refused once closed, and tracked
  // while it runs so close() can await it.
  _locked(caseId, label, fn, opts) {
    this._assertOpen();
    const p = this.runtime.systemAction(caseId, label, fn, opts);
    this.inFlight.add(p);
    const done = () => this.inFlight.delete(p);
    p.then(done, done);
    return p;
  }

  // No model call starts once closed: a read cut off here is left as it is
  // on disk and resumed at the next start. A call already running is
  // tracked: close() waits for it, so the charge that follows it (and any
  // onCrossings pause or question) happens before the case locks are
  // released. Every caller charges synchronously once the reply is back.
  _callModel(req) {
    this._assertOpen();
    const p = Promise.resolve().then(() => this.callModel(req));
    this.calls.add(p);
    const done = () => this.calls.delete(p);
    p.then(done, done);
    return p;
  }

  // Called by create-core's shutdown before releaseAll() (ruling M16): stops
  // the retry timer, refuses new jobs and case writes with SHUTTING_DOWN,
  // drops the queue, and waits for the case writes already inside a lock
  // and for the model calls in flight (create-core bounds the wait with
  // withTimeout). A call's charge runs synchronously in its caller once the
  // reply is back, so it is done by the time the macrotask below runs;
  // what the job would publish next is refused, so nothing commits after.
  async close() {
    this.closed = true;
    this.stop();
    for (const job of this.queue.splice(0)) {
      job.reject(new IngestError('SHUTTING_DOWN', 'King Louie is shutting down; document ingest is stopped.'));
    }
    await Promise.allSettled([...this.calls]);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled([...this.inFlight]);
  }

  // Resolves when the queue is empty (tests and shutdown).
  async drain() {
    while (this.running || this.queue.length) await this.idle;
  }

  // ---- publishing ----

  // A kept publish for docId, or null. Anything that does not describe this
  // docId (a forged or stale file) is dropped.
  _readKept(dir, docId) {
    const payload = files.readPendingPublish(dir, docId);
    if (payload === null) return null;
    const ok = isObj(payload) && isObj(payload.record) && payload.record.docId === docId
      && (payload.text === undefined || payload.text === null || (isObj(payload.text) && payload.text.docId === docId));
    if (ok) return payload;
    this.log.warn(`Dropping a kept ingest publish for ${docId}: it does not describe that document.`);
    files.clearPendingPublish(dir, docId);
    return null;
  }

  // Publishes payload { record, text?, message, journal? } through
  // systemAction. A kept earlier publish of the same document is folded in
  // first (its text store and journal lines are not lost to a later one);
  // when another process holds the lock, the merged payload is kept in
  // publish.json and retried. Republishing the kept payload itself passes
  // fold: false, so its journal lines are not added to themselves.
  async _publish(caseId, payload, { fold = true } = {}) {
    const meta = this.runtime.getCase(caseId);
    const docId = store.checkDocId(payload?.record?.docId);
    const key = `${meta.id}|${docId}`;
    const prior = fold ? this._readKept(meta.dir, docId) : null;
    const merged = {
      record: payload.record,
      text: payload.text || prior?.text || null,
      message: oneLine(payload.message, MESSAGE_CAP) || 'update',
      journal: [prior?.journal, payload.journal].filter((j) => typeof j === 'string' && j).join('\n').slice(-JOURNAL_CAP) || null,
      ...(payload.question || prior?.question ? { question: true } : {})
    };
    try {
      const out = await this._locked(meta.id, `ingest ${docId}: ${merged.message}`, async (m) => this._apply(m, merged), {
        commitMessage: `ingest-${docId}: ${merged.message}`
      });
      files.clearPendingPublish(meta.dir, docId);
      this.pending.delete(key);
      this._notify(meta.id, docId);
      return out;
    } catch (err) {
      if (err?.code !== 'CASE_BUSY') throw err;
      files.writePendingPublish(meta.dir, docId, merged);
      this.pending.add(key);
      this._arm();
      this.log.info(`Case ${meta.slug} is busy; ingest of ${docId} will publish "${merged.message}" later.`);
      return null;
    }
  }

  // Inside the lock; synchronous, so an inline run inside another action of
  // this process cannot interleave with it. A publish is built from the
  // record as the pipeline read it, which can be older than a review that
  // ran meanwhile (an owner review between the pipeline's stages, or a kept
  // publish replayed after one): reviews already on disk are kept, never
  // overwritten.
  _apply(m, payload) {
    let record = this._keepReviews(m.dir, { ...payload.record, updatedAt: this.now().toISOString() });
    if (payload.text) files.writeTextStore(m.dir, shapeText(payload.text, record.docId, record.sha256));
    if (payload.question) record = this._askReview(m, record);
    files.writeRecord(m.dir, record);
    const props = arr(record.proposals);
    if (record.questionId && props.length && props.every((p) => isObj(p) && p.review)) this._closeQuestion(m, record);
    if (payload.journal) this.runtime.records(m.id).writeJournal('ingest', String(payload.journal).slice(0, JOURNAL_CAP), this.now());
    return record;
  }

  // The on-disk reviews carried into a record about to be written. A review
  // is never undone, so one on disk wins over "not reviewed" in the new
  // record when both describe the same proposal (id, page and quote).
  _keepReviews(dir, record) {
    const disk = files.readRecord(dir, record.docId);
    if (!disk || !Array.isArray(record.proposals)) return record;
    const done = new Map(arr(disk.proposals).filter((p) => isObj(p) && isObj(p.review) && typeof p.id === 'string').map((p) => [p.id, p]));
    const questionId = record.questionId || (typeof disk.questionId === 'string' ? disk.questionId : null);
    if (!done.size) return { ...record, questionId };
    const same = (a, b) => isObj(a.anchor) && isObj(b.anchor) && a.anchor.page === b.anchor.page && a.anchor.quote === b.anchor.quote;
    const proposals = record.proposals.map((p) => {
      const d = isObj(p) && !p.review ? done.get(p.id) : null;
      return d && same(d, p) ? { ...p, review: d.review } : p;
    });
    const finished = proposals.length > 0 && proposals.every((p) => isObj(p) && p.review) && record.status === 'ready-for-review';
    return { ...record, proposals, questionId, status: finished ? 'reviewed' : record.status };
  }

  // A kept publish of docId is applied under the lock the caller holds, so
  // a review reads the newest state and a later replay cannot overwrite it.
  _foldKept(m, docId) {
    const kept = this._readKept(m.dir, docId);
    if (!kept) return;
    this._apply(m, kept);
    files.clearPendingPublish(m.dir, docId);
    this.pending.delete(`${m.id}|${docId}`);
    if (!this.pending.size) this.stop();
  }

  _arm() {
    if (this.closed || this.timer || !this.pending.size) return;
    this.timer = setInterval(() => {
      this.retryPending().catch((err) => this.log.warn(`Retrying ingest publishes failed: ${err.message}`));
    }, this.retryMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Publishes kept because another process held the case lock.
  async retryPending(caseId = null) {
    const cases = caseId ? [this.runtime.getCase(caseId)] : this.runtime.listCases();
    for (const meta of cases) {
      for (const docId of files.pendingPublishes(meta.dir)) {
        const payload = this._readKept(meta.dir, docId);
        if (payload) await this._publish(meta.id, payload, { fold: false });
      }
    }
    if (!this.pending.size) this.stop();
  }

  // The document's current state: a kept publish that could not be applied
  // yet is newer than the committed record.
  async _state(meta, docId) {
    try {
      const kept = this._readKept(meta.dir, docId);
      if (kept) await this._publish(meta.id, kept, { fold: false });
    } catch (err) {
      this.log.warn(`Publishing the kept ingest state of ${docId} failed: ${err.message}`);
    }
    const kept = this._readKept(meta.dir, docId);
    const raw = kept ? kept.record : files.readRecord(meta.dir, docId);
    if (!raw) return null;
    const rec = shapeRecord(raw);
    const text = shapeText(kept?.text || files.readTextStore(meta.dir, docId), docId, rec.sha256);
    return { rec, text };
  }

  // ---- the pipeline ----

  _price(purpose, usage, cfg) {
    const cost = usage?.cost;
    const tokens = Number.isFinite(Number(usage?.totalTokens)) && Number(usage.totalTokens) > 0 ? Number(usage.totalTokens) : 0;
    const who = `${oneLine(usage?.provider, 40)}:${oneLine(usage?.model, 80)}`;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) return { usd: cost, estimated: false, unpriced: 0 };
    if (cost === 0 && tokens === 0) return { usd: 0, estimated: false, unpriced: 0 };
    if (purpose === 'ocr') {
      this.log.warn(`No price for ${who}; charging the OCR estimate of $${cfg.ocrUsdPerPageEstimate} for this page.`);
      return { usd: cfg.ocrUsdPerPageEstimate, estimated: true, unpriced: 0 };
    }
    this.log.warn(`No price for ${who}; recording ${tokens} unpriced tokens for this ${purpose} call.`);
    return { usd: 0, estimated: false, unpriced: tokens };
  }

  // Every charge is followed by onCrossings (program §4.4), nothing that can
  // throw in between. → { stop, recorded }: stop when 100 % is crossed or
  // the charge could not be recorded (fail closed); recorded only when the
  // budget took the charge, so a cached page is marked charged only then
  // and an unrecorded page is charged on its next read.
  _charge(caseId, purpose, price, meta) {
    let crossedNow;
    try {
      ({ crossedNow } = this.runtime.budget(caseId).charge('usd', price.usd, { kind: `ingest:${purpose}`, ...meta, unpricedTokens: price.unpriced || 0 }));
    } catch (err) {
      this.log.error(`Charging ingest ${purpose} to case ${caseId} failed; stopping this read: ${err.message}`);
      return { stop: true, recorded: false };
    }
    try {
      this.runtime.onCrossings(caseId, 'usd', crossedNow);
    } catch (err) {
      this.log.error(`Budget crossings for case ${caseId} failed: ${err.message}`);
    }
    return { stop: Array.isArray(crossedNow) && crossedNow.includes(100), recorded: true };
  }

  // Before an extract or verify call: a usd limit already used up stops.
  _budgetGone(caseId) {
    try {
      const remaining = this.runtime.budget(caseId).remaining('usd');
      return typeof remaining === 'number' && remaining <= 0;
    } catch (err) {
      this.log.error(`Reading the budget of case ${caseId} failed; stopping this read: ${err.message}`);
      return true;
    }
  }

  _ocrModel(caseId, cfg) {
    return vision.pickOcrModel({
      getCapabilities: this.getCapabilities,
      configured: cfg.vision,
      roleModel: (role) => this.runtime.roleModel(caseId, role)
    });
  }

  // The page attachment, with reader failures sorted: a dead reader fails
  // the document (ctx.readerDown); a broken page is unreadable.
  async _attachment(sel, rec, n, ctx) {
    const image = rec.mime.startsWith('image/') ? { mime: rec.mime, bytes: ctx.bytes } : null;
    try {
      return await vision.pageAttachment({ getCapabilities: this.getCapabilities, sel, pdf: ctx.pdf, n, image });
    } catch (err) {
      if (READER_DOWN.has(err?.code)) {
        ctx.readerDown = ctx.readerDown || err;
        return { down: true };
      }
      if (err instanceof IngestError) return { error: oneLine(err.message, NOTE_CAP) };
      throw err;
    }
  }

  async _readPage(meta, rec, n, { rotation }, ctx) {
    const cached = validCache(files.readCachedPage(meta.dir, rec.docId, n), n);
    if (cached) {
      if (!cached.charged) {
        const { stop, recorded } = this._charge(meta.id, 'ocr', { usd: cached.usd, unpriced: 0 }, { docId: rec.docId, page: n });
        if (stop) ctx.stop = true;
        if (recorded) this._cache(meta, rec, { ...cached, charged: true });
      }
      return cached;
    }
    if (ctx.pageErrors.has(n)) return { method: 'unreadable', error: ctx.pageErrors.get(n) };
    if (ctx.readerDown) return { method: 'pending-ocr', error: 'reader' };
    if (ctx.stop) return { method: 'pending-ocr', error: 'budget' };
    if (ctx.visionReads >= ctx.cap) return { method: 'pending-ocr', error: 'cap' };
    let remaining;
    try {
      remaining = this.runtime.budget(meta.id).remaining('usd');
    } catch (err) {
      this.log.error(`Reading the budget of case ${meta.id} failed: ${err.message}`);
      return { method: 'pending-ocr', error: 'budget' };
    }
    if (typeof remaining === 'number' && remaining < ctx.cfg.ocrUsdPerPageEstimate) return { method: 'pending-ocr', error: 'budget' };
    let sel;
    try {
      sel = ctx.ocrModel || (ctx.ocrModel = this._ocrModel(meta.id, ctx.cfg));
    } catch (err) {
      if (err.code === 'NO_VISION_MODEL') return { method: 'unreadable', error: err.message };
      throw err;
    }
    const attachment = await this._attachment(sel, rec, n, ctx);
    if (attachment.down) return { method: 'pending-ocr', error: 'reader' };
    if (attachment.error) return { method: 'unreadable', error: attachment.error };
    ctx.visionReads += 1;
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
      try {
        res = await this._callModel({
          purpose: 'ocr',
          caseId: meta.id,
          provider: sel.provider,
          model: sel.model,
          system: vision.OCR_SYSTEM,
          text: vision.ocrUserText({ n, rotation }),
          attachment,
          maxTokens: 8192
        });
      } catch (err) {
        lastError = err;
      }
    }
    if (!res) return { method: 'unreadable', error: oneLine(`vision call failed: ${lastError?.message || 'no reply'}`, NOTE_CAP) };
    const price = this._price('ocr', res.usage, ctx.cfg);
    const entry = {
      n,
      method: 'ocr',
      text: String(res.text ?? '').slice(0, MAX_REPLY_CHARS),
      usd: price.usd,
      usdEstimated: price.estimated,
      model: oneLine(`${sel.provider}:${res.usage?.model || sel.model}`, MODEL_CAP),
      charged: false
    };
    // Cache first, then charge, then mark charged: a crash in between
    // never charges the page twice on resume.
    this._cache(meta, rec, entry);
    const { stop, recorded } = this._charge(meta.id, 'ocr', price, { docId: rec.docId, page: n });
    if (stop) ctx.stop = true;
    if (recorded) this._cache(meta, rec, { ...entry, charged: true });
    return entry;
  }

  // Cached OCR pages whose charge was not recorded (the budget write
  // failed, or a crash came between the cache write and the charge) are
  // charged now, in page order, before anything else: the record lists
  // them as ocr, so they are never read again to be charged on the way.
  // Marked charged only when recorded; a 100 % crossing stops this run.
  _sweepUncharged(meta, rec, ctx) {
    const last = Math.min(rec.pageCount || 1, ctx.cfg.maxPages);
    for (let n = 1; n <= last; n += 1) {
      const cached = validCache(files.readCachedPage(meta.dir, rec.docId, n), n);
      if (!cached || cached.charged) continue;
      const { stop, recorded } = this._charge(meta.id, 'ocr', { usd: cached.usd, unpriced: 0 }, { docId: rec.docId, page: n });
      if (recorded) this._cache(meta, rec, { ...cached, charged: true });
      if (stop) {
        ctx.stop = true;
        return;
      }
    }
  }

  // The page cache is local working state (ruling M14); a failed write
  // costs at most a second read of the page, so it never fails the read.
  _cache(meta, rec, entry) {
    try {
      files.writeCachedPage(meta.dir, rec.docId, entry);
    } catch (err) {
      this.log.warn(`Caching page ${entry.n} of ${rec.docId} failed: ${err.message}`);
    }
  }

  // Which pages this job reads. The first read takes every page (or the
  // pages asked for). Later, only pages left pending-ocr or unreadable are
  // read again, and only by an owner Extract or a call that names pages
  // (resolved gap 5): an automatic, resumed or tool read without pages
  // never spends on pages a cap or a budget stop left.
  _wantedPages(rec, job) {
    if (!rec.pages.length) return job.pages;
    const open = rec.pages.filter((p) => p.method === 'pending-ocr' || p.method === 'unreadable').map((p) => p.n);
    if (job.pages) return job.pages.filter((n) => open.includes(n));
    return job.by === 'owner' ? open : [];
  }

  // A reader for extractPages: a text layer over the reader's cap makes the
  // page unreadable as too large; a dead reader leaves every later page
  // pending-ocr; any other reader error on one page makes it unreadable.
  _reader(pdf, ctx) {
    if (!pdf) return null;
    return {
      pageCount: pdf.pageCount,
      pageRotation: (n) => pdf.pageRotation(n),
      pageText: async (n) => {
        if (ctx.readerDown) return '';
        try {
          return await pdf.pageText(n);
        } catch (err) {
          if (READER_DOWN.has(err?.code)) ctx.readerDown = err;
          else if (err instanceof IngestError && err.tooLarge === true) ctx.pageErrors.set(n, TOO_LARGE);
          else if (err instanceof IngestError && err.code === 'UNREADABLE_PDF') ctx.pageErrors.set(n, oneLine(err.message, NOTE_CAP));
          else throw err;
          return '';
        }
      }
    };
  }

  async _extract(meta, rec, text, job, ctx) {
    const wanted = this._wantedPages(rec, job);
    if (wanted && !wanted.length) return { rec: { ...rec, status: 'proposing', note: null }, text, read: new Set() };
    rec = { ...rec, status: 'extracting', note: null };
    await this._publish(meta.id, { record: rec, message: `extracting ${rec.name}`, journal: `Reading ${rec.name} (${rec.docId}).` });
    const result = await extractPages({ bytes: ctx.bytes, mime: rec.mime, name: rec.name }, {
      pdf: this._reader(ctx.pdf, ctx),
      readPage: (n, opts) => this._readPage(meta, rec, n, opts, ctx),
      limits: ctx.cfg,
      pages: wanted
    });
    const pages = new Map(rec.pages.map((p) => [p.n, p]));
    const texts = new Map(text.pages.map((p) => [p.n, p]));
    const read = new Set();
    for (const p of result.pages) {
      const { text: body, ...rest } = p;
      if (rest.error !== undefined && rest.error !== null) rest.error = oneLine(rest.error, NOTE_CAP);
      pages.set(p.n, { ...rest, chars: String(body || '').length });
      if (p.method === 'text' || p.method === 'ocr') {
        texts.set(p.n, { n: p.n, method: p.method, text: body });
        read.add(p.n);
      } else {
        texts.delete(p.n);
      }
    }
    const all = [...pages.values()].sort((a, b) => a.n - b.n);
    text = { docId: rec.docId, sha256: rec.sha256, pages: [...texts.values()].sort((a, b) => a.n - b.n) };
    const down = ctx.readerDown;
    rec = {
      ...rec,
      status: down ? 'failed' : 'proposing',
      note: down ? noteOf(down) : null,
      pageCount: result.pageCount,
      pages: all,
      usd: { ...rec.usd, ocr: round(all.reduce((s, p) => s + (p.method === 'ocr' ? money(p.usd) : 0), 0)) }
    };
    const counts = this._methods(rec);
    const summary = `text ${counts.text} · ocr ${counts.ocr} · pending ${counts.pendingOcr} · unreadable ${counts.unreadable}`;
    await this._publish(meta.id, {
      record: rec,
      text,
      message: down ? `failed ${rec.name}` : `read ${rec.name}`,
      journal: down
        ? `Reading ${rec.name} (${rec.docId}) stopped: ${noteOf(down)} (${summary}). Extract again to read the pages left.`
        : `Read ${rec.name} (${rec.docId}): ${summary}${ctx.stop ? '. Stopped at the budget limit.' : '.'}`
    });
    return { rec, text, read };
  }

  async _propose(meta, rec, text, read, ctx) {
    const done = new Set(rec.proposedPages);
    // Owner and resumed runs propose every page not yet proposed (failed
    // chunks and pages past a truncation included); a tool or automatic
    // run only the pages it read itself.
    const fresh = text.pages.filter((p) => !done.has(p.n) && (ctx.proposeAll || read.has(p.n)));
    const { chunks, truncated } = propose.buildChunks(fresh, ctx.cfg);
    const failedChunks = rec.failedChunks.filter((c) => !chunks.some((k) => k.fromPage <= c.toPage && k.toPage >= c.fromPage));
    const raw = [];
    const proposed = new Set(done);
    let usd = rec.usd.extract;
    const sel = this.runtime.roleModel(meta.id, 'draft');
    for (const chunk of chunks) {
      if (!ctx.stop && this._budgetGone(meta.id)) ctx.stop = true;
      if (ctx.stop) {
        failedChunks.push({ fromPage: chunk.fromPage, toPage: chunk.toPage, reason: 'budget' });
        continue;
      }
      let parsed = null;
      let failed = null;
      for (let attempt = 0; attempt < 2 && parsed === null && !ctx.stop; attempt += 1) {
        let res;
        try {
          res = await this._callModel({
            purpose: 'extract',
            caseId: meta.id,
            provider: sel.provider,
            model: sel.model,
            system: propose.EXTRACT_SYSTEM,
            text: propose.extractUserText(chunk),
            maxTokens: 4096
          });
        } catch (err) {
          failed = err;
          continue;
        }
        failed = null;
        const price = this._price('extract', res?.usage, ctx.cfg);
        usd += price.usd;
        if (this._charge(meta.id, 'extract', price, { docId: rec.docId }).stop) ctx.stop = true;
        parsed = propose.parseProposals(typeof res?.text === 'string' ? res.text : '');
      }
      if (parsed === null) {
        if (failed) this.log.warn(`Extract call for ${rec.docId} pages ${chunk.fromPage}-${chunk.toPage} failed: ${failed.message}`);
        failedChunks.push({ fromPage: chunk.fromPage, toPage: chunk.toPage, reason: failed ? 'call-failed' : ctx.stop ? 'budget' : 'invalid-json' });
        continue;
      }
      raw.push(...parsed);
      for (let n = chunk.fromPage; n <= chunk.toPage; n += 1) proposed.add(n);
    }
    const before = rec.proposals.length;
    const room = Math.max(0, ctx.cfg.maxProposalsPerDoc - before);
    const kept = raw.slice(0, room);
    const checked = review.checkProposals({ ...rec, proposals: [...rec.proposals, ...kept] }, text.pages, this.runtime.ledger(meta.id).view().facts);
    // An earlier truncation stays only while a readable page from it on is
    // still not proposed; a pass that covered the rest clears it.
    const leftFrom = (from) => text.pages.some((p) => p.n >= from && !proposed.has(p.n));
    const nextTruncated = truncated || (rec.truncated && leftFrom(rec.truncated.fromPage) ? rec.truncated : null);
    const unchanged = !chunks.length && nextTruncated === rec.truncated;
    rec = {
      ...checked,
      status: 'checking',
      truncated: nextTruncated,
      failedChunks,
      droppedProposals: (Number.isSafeInteger(rec.droppedProposals) && rec.droppedProposals > 0 ? rec.droppedProposals : 0) + (raw.length - kept.length),
      proposedPages: [...proposed].sort((a, b) => a - b),
      usd: { ...rec.usd, extract: round(usd) }
    };
    // Nothing was proposed and nothing changed: no commit, no journal line.
    if (unchanged) return rec;
    const added = checked.proposals.length - before;
    const notes = [
      `Proposed ${plural(kept.length, 'fact')} from ${rec.name} (${rec.docId}); ${plural(checked.refused.length, 'refused proposal')} in total.`,
      truncated ? `Stopped at maxExtractChars: pages from ${truncated.fromPage} were not read for proposals.` : null,
      failedChunks.length ? `Failed chunks: ${failedChunks.map((c) => `pages ${c.fromPage}-${c.toPage} (${oneLine(c.reason, 40)})`).join(', ')}.` : null
    ].filter(Boolean);
    await this._publish(meta.id, { record: rec, message: `checking ${plural(added, 'proposal')} from ${rec.name}`, journal: notes.join('\n') });
    return rec;
  }

  async _verifyOne(meta, rec, p, text, ctx) {
    let sel;
    try {
      sel = this.runtime.roleModel(meta.id, 'verify');
    } catch (err) {
      return { agrees: null, note: oneLine(`no verify model: ${err.message}`, NOTE_CAP), sawImage: false };
    }
    let attachment = null;
    if (p.anchor.ocr) {
      if (!vision.isVisionEligible(this.getCapabilities, sel)) return { agrees: null, note: 'not checked against the image', sawImage: false };
      const att = await this._attachment(sel, rec, p.anchor.page, ctx);
      // A reader that dies here does not fail the document: its pages are
      // already read. The proposal stays unverified (never accept-all) and
      // the note says why; the owner's Extract checks it again.
      if (att.down) return { agrees: null, note: 'not checked against the image: the PDF reader stopped', sawImage: false };
      if (att.error) return { agrees: null, note: 'not checked against the image', sawImage: false };
      attachment = att;
    }
    const pageText = text.pages.find((x) => x.n === p.anchor.page)?.text || '';
    let res;
    try {
      res = await this._callModel({
        purpose: 'verify',
        caseId: meta.id,
        provider: sel.provider,
        model: sel.model,
        system: review.VERIFY_SYSTEM,
        text: review.verifyUserText(p, review.verifyContext(pageText, p.anchor.quote)),
        attachment,
        maxTokens: 1024
      });
    } catch (err) {
      return { agrees: null, note: oneLine(`verify failed: ${err.message}`, NOTE_CAP), sawImage: false };
    }
    const price = this._price('verify', res?.usage, ctx.cfg);
    ctx.verifyUsd += price.usd;
    if (this._charge(meta.id, 'verify', price, { docId: rec.docId }).stop) ctx.stop = true;
    const verdict = review.parseVerify(typeof res?.text === 'string' ? res.text : '') || { agrees: null, note: 'verify returned no verdict' };
    return { ...verdict, sawImage: Boolean(attachment), model: oneLine(`${sel.provider}:${res?.usage?.model || sel.model}`, MODEL_CAP) };
  }

  async _check(meta, rec, text, ctx) {
    ctx.verifyUsd = 0;
    const proposals = [];
    for (const p of rec.proposals) {
      const v = p.checks?.verify;
      // Verified already, reviewed, or not a checked proposal: kept as is.
      // A budget-stopped verify is retried by the owner's Extract (gap 5).
      const retry = isObj(v) && v.note === 'budget' && ctx.proposeAll;
      if (p.review || !isObj(p.anchor) || (v && !retry)) {
        proposals.push(p);
        continue;
      }
      if (!ctx.stop && this._budgetGone(meta.id)) ctx.stop = true;
      const verify = ctx.stop
        ? { agrees: null, note: 'budget', sawImage: false }
        : await this._verifyOne(meta, rec, p, text, ctx);
      proposals.push({ ...p, checks: { ...p.checks, verify } });
    }
    const allReviewed = proposals.length > 0 && proposals.every((p) => p.review);
    rec = {
      ...rec,
      proposals,
      status: allReviewed ? 'reviewed' : 'ready-for-review',
      usd: { ...rec.usd, verify: round(rec.usd.verify + ctx.verifyUsd) }
    };
    const open = proposals.filter((p) => !p.review).length;
    await this._publish(meta.id, {
      record: rec,
      message: `${plural(open, 'proposal')} from ${rec.name}`,
      journal: `${plural(open, 'proposal')} from ${rec.name} (${rec.docId}) ready for review.`,
      question: true
    });
    return rec;
  }

  // The stored file's bytes: its ref must resolve under sources/ (M7), it
  // must be a regular file, and at most maxBytes are read however large it
  // has grown since it was stored.
  _readSource(dir, rec, cfg) {
    const file = store.refPath(dir, rec.ref);
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new IngestError('BAD_PATH', `${oneLine(rec.ref, 200)} is not a file.`);
      store.checkSize(rec.name, st.size, cfg.maxBytes);
      const buf = Buffer.alloc(Math.min(st.size, cfg.maxBytes) + 1);
      let got = 0;
      for (let n; got < buf.length && (n = fs.readSync(fd, buf, got, buf.length - got, got)) > 0;) got += n;
      store.checkSize(rec.name, got, cfg.maxBytes);
      return buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  }

  async _fail(meta, rec, note, journal) {
    await this._publish(meta.id, { record: { ...rec, status: 'failed', note }, message: `failed ${rec.name}`, journal })
      .catch((e) => this.log.warn(`Recording the failure of ${rec.docId} failed: ${e.message}`));
    return files.readRecord(meta.dir, rec.docId) || { ...rec, status: 'failed', note };
  }

  async _run(job) {
    const meta = this.runtime.getCase(job.caseId);
    const state = await this._state(meta, job.docId);
    if (!state) throw new IngestError('NOT_FOUND', `No document ${job.docId} in this case.`);
    let { rec, text } = state;
    // A resume job is checked again when it runs: one queued before an
    // automatic or owner read finished must not spend on the finished
    // document (it would propose everything left, as proposeAll).
    if (job.by === 'resume' && !RESUMABLE.has(rec.status)) return files.readRecord(meta.dir, job.docId) || rec;
    if (WAITING.has(meta.status)) {
      const note = `extraction waits: case is ${meta.status}`;
      if (rec.note !== note) await this._publish(meta.id, { record: { ...rec, note }, message: `waiting ${rec.name}` });
      return files.readRecord(meta.dir, job.docId);
    }
    // A tool or automatic read with nothing left to read on a document
    // already read returns as it is: no commit, no journal line.
    if ((job.by === 'tool' || job.by === 'auto') && rec.pages.length && !RESUMABLE.has(rec.status) && !this._wantedPages(rec, job).length) {
      return files.readRecord(meta.dir, job.docId) || rec;
    }
    const cfg = this.settings();
    let bytes;
    try {
      bytes = this._readSource(meta.dir, rec, cfg);
    } catch (err) {
      const why = err instanceof IngestError ? err
        : err?.code === 'ENOENT' ? new IngestError('NOT_FOUND', `${oneLine(rec.ref, 200)} is missing.`)
          : new IngestError('READ_FAILED', `${oneLine(rec.ref, 200)} could not be read (${oneLine(err?.code || err?.message, 40)}).`);
      return this._fail(meta, rec, noteOf(why), `${rec.name} (${rec.docId}) could not be read from ${oneLine(rec.ref, 200)}: ${noteOf(why)}. Nothing was read.`);
    }
    if (store.sha256(bytes) !== rec.sha256) {
      return this._fail(meta, rec, DOC_CHANGED, `${rec.name} (${rec.docId}) changed on disk since it was stored; nothing was read.`);
    }
    let mime;
    try {
      mime = store.sniffType({ name: path.basename(rec.ref), bytes }).mime;
      if (mime !== rec.mime) throw new IngestError('TYPE_MISMATCH', `${rec.name} is recorded as ${oneLine(rec.mime, 60)} but its contents are ${mime}.`);
    } catch (err) {
      if (!(err instanceof IngestError)) throw err;
      return this._fail(meta, rec, noteOf(err), `${rec.name} (${rec.docId}) was not read: ${noteOf(err)}`);
    }
    const ctx = {
      cfg,
      bytes,
      pdf: null,
      cap: job.by === 'owner' ? Infinity : cfg.maxVisionPagesPerDoc,
      visionReads: 0,
      stop: false,
      readerDown: null,
      pageErrors: new Map(),
      ocrModel: null,
      verifyUsd: 0,
      // A first read, an owner Extract or a resume proposes every page not
      // yet proposed; a later tool or automatic read only what it read.
      proposeAll: job.by === 'owner' || job.by === 'resume' || !(rec.proposedPages.length || rec.failedChunks.length || rec.truncated)
    };
    try {
      this._sweepUncharged(meta, rec, ctx);
      // A job whose kept publish close() waited on must not start a PDF
      // worker after shutdownPdfSandbox().
      this._assertOpen();
      if (mime === 'application/pdf') ctx.pdf = await this.openPdf(bytes, { name: rec.name, maxBytes: cfg.maxBytes });
      let read = new Set();
      if (job.pages || !['proposing', 'checking'].includes(rec.status) || job.by === 'owner') {
        ({ rec, text, read } = await this._extract(meta, rec, text, job, ctx));
      }
      if (rec.status === 'proposing') rec = await this._propose(meta, rec, text, read, ctx);
      if (rec.status === 'checking') rec = await this._check(meta, rec, text, ctx);
      return files.readRecord(meta.dir, rec.docId) || rec;
    } catch (err) {
      await this._fail(meta, rec, noteOf(err), `Reading ${rec.name} (${rec.docId}) failed: ${noteOf(err)}`);
      throw err;
    } finally {
      if (ctx.pdf) await ctx.pdf.close().catch((err) => this.log.warn(`Closing ${rec.docId} failed: ${err.message}`));
    }
  }

  // ---- review ----
  //
  // Only the owner accepts (R45): review() and acceptVerified() are called by
  // owner surfaces (the panel's IPC) and by the owner's answer to a review
  // question; no model tool reaches them. Accepted facts are `sourced` and
  // `disclosable: false` whatever their category, with the host-built
  // document source; the host never writes a `user` fact in the owner's name
  // (a panel outcome closes the question instead, R47).
  //
  // At accept time everything that needs no model call is checked again
  // (ruling M15): the stored bytes' sha256, the quote on a text page re-read
  // from those bytes, the proposal's fields (normalized again, capped and
  // one-lined), conflicts and duplicates against the ledger as it is now,
  // and, for accept-all, valueInQuote, with a skip on any difference from
  // the recorded checks. Two things stay trusted from the record, the same
  // Bash/import limit as facts.jsonl (program §4.24): the verify verdict
  // (re-deriving it needs a model call) and the origin (it decides whether
  // accept-all is offered). A forged verdict can therefore pass accept-all;
  // the fact stays private and owner-visible. An OCR page's text is a
  // model's reading too: it is checked only against the text store and
  // against the page really having no usable text layer.

  // A review question for a record ready for review, unless the owner added
  // the file (the owner reviews it in the panel). Tool files, and any origin
  // this stage does not know, never get option a (R45).
  _askReview(m, record) {
    const open = arr(record.proposals).filter((p) => isObj(p) && !p.review);
    const kind = ORIGIN_KINDS.has(record.origin?.kind) ? record.origin.kind : 'tool';
    if (!open.length || OWNER_ORIGINS.has(kind)) return record;
    try {
      if (record.questionId) {
        const q = this.runtime.questions(m.id).get(record.questionId);
        if (q && !q.answer && !q.closed) return record;
      }
      const passing = open.filter((p) => !review.skipReason(p)).length;
      const tool = kind === 'tool';
      const name = store.cleanName(typeof record.name === 'string' ? record.name : 'document');
      const text = `${plural(open.length, 'fact')} proposed from ${name} (${record.docId})${tool ? ', a file King Louie added' : ''}; ${passing} passed every check. Accepted facts are private.`;
      const options = [
        ...(!tool && passing > 0 ? [{ id: 'a', label: `Accept the ${passing} that passed every check` }] : []),
        { id: 'b', label: "I'll review them in the panel" },
        { id: 'c', label: 'Reject all' }
      ];
      const q = this.runtime.createQuestion(m.id, {
        kind: 'question',
        text,
        options,
        urgency: 'low',
        expiresAt: null,
        defaultOnSilence: 'hold',
        payload: { type: 'ingest:review', docId: record.docId, mcpAnswerable: false, about: { subject: 'ingest', attr: record.docId } }
      }, { charge: true });
      if (!q || q.held) {
        this.runtime.records(m.id).writeJournal('ingest', `No review question for ${record.docId}: the questionsPerDay budget is used up. The proposals wait in the panel.`, this.now());
        return record;
      }
      return { ...record, questionId: q.id };
    } catch (err) {
      // The proposals still wait in the panel; a failed question never
      // fails the publish.
      this.log.warn(`Asking for the review of ${record.docId} failed: ${err.message}`);
      return record;
    }
  }

  // The arguments of a review, checked before the case is touched.
  _reviewRequest(opts) {
    const o = isObj(opts) ? opts : {};
    if (!REVIEW_ACTIONS.has(o.action)) throw new IngestError('BAD_ACTION', 'action must be accept, edit or reject.');
    const by = o.by === undefined || o.by === null ? 'panel' : o.by;
    if (typeof by !== 'string' || !REVIEWER.test(by)) throw new IngestError('BAD_REQUEST', 'by must be "panel" or "question:<question id>".');
    let supersedes = null;
    if (o.supersedes !== undefined && o.supersedes !== null && o.supersedes !== '') {
      if (typeof o.supersedes !== 'string' || o.supersedes.length > ID_CAP || !FACT_ID.test(o.supersedes)) {
        throw new IngestError('BAD_SUPERSEDES', 'supersedes must name a fact id like f-0001.');
      }
      supersedes = o.supersedes;
    }
    let edit = null;
    if (o.action === 'edit') {
      if (!isObj(o.edit)) throw new IngestError('BAD_EDIT', 'edit needs the fields to change.');
      edit = Object.create(null);
      for (const [k, v] of Object.entries(o.edit)) {
        if (!EDITABLE.includes(k)) throw new IngestError('BAD_EDIT', `${oneLine(k, 40)} cannot be edited; only ${EDITABLE.join(', ')}.`);
        const ok = v === null || typeof v === 'string' || (k === 'value' && typeof v === 'number' && Number.isFinite(v));
        if (!ok) throw new IngestError('BAD_EDIT', `${k} must be text.`);
        edit[k] = v === '' ? null : v;
      }
      if (!Object.keys(edit).length) throw new IngestError('BAD_EDIT', 'edit needs the fields to change.');
    }
    return {
      action: o.action,
      by,
      supersedes,
      keepBoth: o.keepBoth === true,
      reason: o.action === 'reject' && typeof o.reason === 'string' ? oneLine(o.reason, NOTE_CAP) : '',
      edit
    };
  }

  // The proposal as the fact will carry it: only its known fields,
  // normalized again (the record is case data a shell can edit), with the
  // owner's edit applied.
  _reviewFields(p, req) {
    if (!isObj(p.anchor) || p.checks?.anchor !== 'ok') throw new IngestError('NOT_ANCHORED', `${p.id} has no verified quote and cannot be accepted.`);
    const clean = propose.normalizeProposal(p);
    const quoteLength = clean ? Array.from(clean.anchor.quote).length : 0;
    if (!clean || quoteLength < review.QUOTE_MIN || quoteLength > review.QUOTE_MAX) {
      throw new IngestError('NOT_ANCHORED', `${p.id} has no verified quote and cannot be accepted.`);
    }
    if (req.action !== 'edit') return { fields: clean, edit: null };
    const edit = req.edit;
    if (edit.category !== undefined && !propose.CATEGORIES.includes(edit.category)) {
      throw new IngestError('BAD_EDIT', `category must be one of ${propose.CATEGORIES.join(', ')}.`);
    }
    const fields = propose.normalizeProposal({ ...clean, ...edit });
    if (!fields) throw new IngestError('BAD_EDIT', 'stmt, subject and attr need text.');
    if (Object.prototype.hasOwnProperty.call(edit, 'value') && !review.valueInQuote(fields.value, clean.anchor.quote)) {
      throw new IngestError('VALUE_NOT_IN_QUOTE', VALUE_NOT_IN_QUOTE);
    }
    const shown = {};
    for (const k of Object.keys(edit)) shown[k] = fields[k];
    return { fields, edit: shown };
  }

  // Evidence that the quote is in the stored document, from its bytes
  // (spec §3.5). → { ocr }. The bytes and an open PDF are kept on ctx for
  // the other proposals of one accept-all; the caller closes the PDF.
  async _anchorEvidence(m, rec, p, ctx) {
    const n = p.anchor.page;
    const quote = p.anchor.quote;
    const moved = new IngestError('ANCHOR_CHANGED', `The quote is not on page ${pageNo(n) ? n : '?'} of the stored document. Extract again.`);
    const page = rec.pages.find((x) => x.n === n);
    if (!pageNo(n) || !page || (page.method !== 'text' && page.method !== 'ocr')) throw moved;
    const ocr = page.method === 'ocr';
    // The flag the verdict rests on must agree with the page it names.
    if (Boolean(p.anchor.ocr) !== ocr) throw moved;
    if (!ctx.bytes) {
      let bytes;
      try {
        bytes = this._readSource(m.dir, rec, ctx.cfg);
      } catch (err) {
        if (err instanceof IngestError) throw err;
        if (err?.code === 'ENOENT') throw new IngestError('NOT_FOUND', `${oneLine(rec.ref, 200)} is missing.`);
        throw new IngestError('READ_FAILED', `${oneLine(rec.ref, 200)} could not be read (${oneLine(err?.code || err?.message, 40)}).`);
      }
      if (store.sha256(bytes) !== rec.sha256) throw new IngestError('DOC_CHANGED', DOC_CHANGED);
      // The type decides where the anchor is checked (text layer, or the OCR
      // store for an image), so it comes from the bytes, not the record: a
      // text PDF recorded as an image would skip the text-layer re-read.
      let sniffed = null;
      try {
        sniffed = store.sniffType({ name: path.basename(String(rec.ref)), bytes }).mime;
      } catch (err) {
        if (!(err instanceof IngestError)) throw err;
      }
      if (sniffed !== rec.mime) throw new IngestError('DOC_CHANGED', DOC_CHANGED);
      ctx.bytes = bytes;
    }
    // The page's text layer, re-read from the bytes (none for an image).
    let layer = null;
    if (rec.mime.startsWith('text/')) {
      layer = n === 1 ? ctx.bytes.toString('utf8') : null;
    } else if (rec.mime === 'application/pdf') {
      if (!ctx.pdf) ctx.pdf = await this.openPdf(ctx.bytes, { name: rec.name, maxBytes: ctx.cfg.maxBytes });
      if (n > ctx.pdf.pageCount) throw moved;
      layer = await ctx.pdf.pageText(n);
    }
    if (layer !== null && review.quoteOffset(layer, quote) !== -1) return { ocr };
    // Text files are never read by OCR.
    if (!ocr || rec.mime.startsWith('text/')) throw moved;
    // An OCR quote: the page must really be one the reader sends to vision
    // (a page with a usable text layer is never read by OCR; a lowered
    // textQualityThreshold since the read can refuse here, and Extract
    // again settles it), and the quote must be in the stored OCR text.
    if (layer !== null && layer.replace(/\s/g, '').length >= MIN_TEXT_CHARS && textQuality(layer) >= ctx.cfg.textQualityThreshold) throw moved;
    const stored = shapeText(files.readTextStore(m.dir, rec.docId), rec.docId, rec.sha256).pages.find((x) => x.n === n && x.method === 'ocr');
    if (!stored || review.quoteOffset(stored.text, quote) === -1) throw moved;
    return { ocr: true };
  }

  // The record and proposal to review, with any kept publish folded in.
  _reviewTarget(m, docId, proposalId, { note = false } = {}) {
    this._foldKept(m, docId);
    const raw = files.readRecord(m.dir, docId);
    if (!raw) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
    const rec = this._withoutOrphans(m, shapeRecord(raw), { note });
    const idx = rec.proposals.findIndex((p) => p.id === proposalId);
    if (idx === -1) throw new IngestError('NOT_FOUND', `No proposal ${proposalId} in ${docId}.`);
    const p = rec.proposals[idx];
    if (p.review) throw new IngestError('ALREADY_REVIEWED', `${proposalId} was already ${oneLine(isObj(p.review) ? p.review.action : 'reviewed', 40)}.`);
    return { raw, rec, idx, p };
  }

  // An accept or edit is done only when the ledger holds its fact, from
  // this document and proposal. The record is written before the fact
  // (fix round 1), so a crash in between leaves a review naming a fact that
  // was never written; that id could later belong to an unrelated fact.
  // Such a review counts as not done: the proposal can be reviewed again.
  _withoutOrphans(m, rec, { note = false } = {}) {
    const accepts = rec.proposals.filter((p) => isObj(p.review) && p.review.action !== 'rejected');
    if (!accepts.length) return rec;
    const facts = this.runtime.ledger(m.id).view().facts;
    const orphans = new Set();
    for (const p of accepts) {
      const f = facts.get(p.review.factId);
      if (!f || f.source?.kind !== 'document' || f.source?.docId !== rec.docId || f.source?.proposalId !== p.id) orphans.add(p.id);
    }
    if (!orphans.size) return rec;
    if (note) {
      const list = [...orphans].map((id) => oneLine(id, ID_CAP)).join(', ');
      this.runtime.records(m.id).writeJournal('ingest', `${list} of ${rec.name} (${rec.docId}): the recorded review names no fact from this document in the ledger (a write was cut off); the proposal can be reviewed again.`, this.now());
    }
    return { ...rec, proposals: rec.proposals.map((p) => (orphans.has(p.id) ? { ...p, review: null } : p)) };
  }

  // Accept-all takes a proposal only when a fresh check agrees with the
  // recorded one (ruling M15). → why it is skipped, or null.
  _recheck(p, fields, facts) {
    const recorded = isObj(p.checks) ? p.checks : {};
    const fresh = { valueInQuote: review.valueInQuote(fields.value, fields.anchor.quote), ...review.ledgerMatches(fields, facts) };
    const why = review.skipReason({ ...p, checks: { ...recorded, ...fresh } });
    if (why) return why;
    const ids = (list) => arr(list).map((c) => (isObj(c) ? String(c.factId) : '')).sort().join(',');
    if (recorded.valueInQuote !== fresh.valueInQuote || (recorded.duplicateOf ?? null) !== fresh.duplicateOf || ids(recorded.conflicts) !== ids(fresh.conflicts)) {
      return 'its recorded checks differ from a check made now; review it in the panel';
    }
    return null;
  }

  // One review under the case lock the caller holds. The checks that need
  // the file (and the PDF reader) run first; then, with no await until the
  // end, the record is read again and the fact, the record and the journal
  // are written in one step. systemAction runs inline while this process
  // holds the lock, so a pipeline publish or another review can run between
  // our awaits; reading again after them is what keeps a proposal from
  // being accepted twice or a review from being lost.
  async _reviewLocked(m, docId, proposalId, req, ctx, { recheck = false } = {}) {
    const first = this._reviewTarget(m, docId, proposalId, { note: true });
    let shaped = null;
    let evidence = null;
    if (req.action !== 'reject') {
      shaped = this._reviewFields(first.p, req);
      evidence = await this._anchorEvidence(m, first.rec, first.p, ctx);
    }
    // ---- no await from here on ----
    const { raw, rec, idx, p } = this._reviewTarget(m, docId, proposalId);
    const key = (x) => JSON.stringify([propose.normalizeProposal(x), Boolean(x.anchor?.ocr)]);
    if (rec.sha256 !== first.rec.sha256 || rec.ref !== first.rec.ref || key(p) !== key(first.p)) {
      throw new IngestError('CHANGED', `${proposalId} changed while it was being reviewed. Review it again.`);
    }
    const at = this.now().toISOString();
    const ledger = this.runtime.ledger(m.id);
    let factInput = null;
    let outcome;
    if (req.action === 'reject') {
      outcome = { action: 'rejected', by: req.by, at, ...(req.reason ? { reason: req.reason } : {}) };
    } else {
      const { fields } = shaped;
      const facts = ledger.view().facts;
      if (recheck) {
        const why = this._recheck(p, fields, facts);
        if (why) throw new IngestError('SKIPPED', why);
      }
      const { conflicts } = review.ledgerMatches(fields, facts);
      if (req.supersedes && !conflicts.some((c) => c.factId === req.supersedes)) {
        throw new IngestError('BAD_SUPERSEDES', `${req.supersedes} is not an active fact that conflicts with ${proposalId}.`);
      }
      for (const c of conflicts) {
        if (c.factId === req.supersedes) continue;
        // An owner fact is replaced only when the owner names it.
        if (c.provenance === 'user') {
          throw new IngestError('CONFLICT', `${proposalId} conflicts with ${c.factId}, which the owner stated. Accept with supersedes "${c.factId}" to replace it.`);
        }
        if (!req.keepBoth) throw new IngestError('CONFLICT', `${proposalId} conflicts with ${c.factId}. Choose supersedes "${c.factId}" or keepBoth.`);
      }
      const v = isObj(p.checks?.verify) ? p.checks.verify : null;
      const kind = rec.origin?.kind;
      factInput = {
        provenance: 'sourced',
        source: {
          kind: 'document',
          ref: rec.ref,
          at: rec.createdAt,
          page: fields.anchor.page,
          quote: fields.anchor.quote,
          docId: rec.docId,
          proposalId,
          verified: evidence.ocr && v?.sawImage === true && v?.agrees === true ? 'anchor+image' : 'anchor',
          ocr: evidence.ocr,
          origin: ORIGIN_KINDS.has(kind) ? kind : 'tool'
        },
        stmt: fields.stmt,
        subject: fields.subject,
        attr: fields.attr,
        value: review.parseValue(fields.value),
        unit: fields.unit || null,
        category: fields.category,
        confidence: fields.confidence,
        supersedes: req.supersedes || null,
        disclosable: false,
        addedBy: `ingest:${rec.docId}${req.by === 'panel' ? '' : `:${req.by}`}`
      };
      outcome = {
        action: req.action === 'edit' ? 'edited' : 'accepted',
        by: req.by,
        at,
        // The id the ledger gives the next fact; no await until the assert.
        factId: ledger.nextId(),
        ...(shaped.edit ? { edit: shaped.edit } : {}),
        ...(req.supersedes ? { supersedes: req.supersedes } : {}),
        ...(req.keepBoth ? { keepBoth: true } : {})
      };
    }
    const reviewed = (list) => list.every((x) => x.review);
    let proposals = rec.proposals.map((x, i) => (i === idx ? { ...x, review: outcome } : x));
    const finished = reviewed(proposals);
    const status = finished && (rec.status === 'ready-for-review' || rec.status === 'reviewed') ? 'reviewed' : rec.status;
    let next = { ...rec, proposals, status, updatedAt: at };
    // The record first, then the fact. A failed record write leaves the
    // ledger untouched (an owner fact named in supersedes stays active); a
    // failed assert puts the record back as it was. Never a fact without its
    // review, nor a superseded owner fact without the fact that replaced it.
    files.writeRecord(m.dir, next);
    let fact = null;
    if (factInput) {
      try {
        fact = ledger.assert(factInput);
      } catch (err) {
        try {
          files.writeRecord(m.dir, raw);
        } catch (e) {
          this.log.error(`Restoring the record of ${docId} after a failed accept failed: ${e.message}`);
        }
        throw err;
      }
      if (fact.id !== outcome.factId) {
        outcome = { ...outcome, factId: fact.id };
        proposals = proposals.map((x, i) => (i === idx ? { ...x, review: outcome } : x));
        next = { ...next, proposals };
        files.writeRecord(m.dir, next);
      }
    }
    this.runtime.records(m.id).writeJournal('ingest', `${proposalId} of ${next.name} (${docId}) ${outcome.action} by ${req.by}${fact ? ` as ${fact.id}` : ''}.`, this.now());
    // Every proposal has a review: an open review question has nothing left
    // to ask, whoever finished it and whatever the status.
    if (finished && next.questionId) this._closeQuestion(m, next);
    try {
      this._entities()?.upsertCase(m.id);
    } catch (err) {
      this.log.warn(`Updating the entity index failed: ${err.message}`);
    }
    this._notify(m.id, docId);
    return { proposal: proposals[idx], fact };
  }

  async _closeReader(ctx) {
    if (ctx.pdf) await ctx.pdf.close().catch((err) => this.log.warn(`Closing a document after review failed: ${err.message}`));
    ctx.pdf = null;
  }

  // accept | edit | reject, from the panel or a question answer (never the model).
  async review(caseId, docId, proposalId, opts = {}) {
    store.checkDocId(docId);
    if (typeof proposalId !== 'string' || proposalId.length > ID_CAP || !review.PROPOSAL_ID.test(proposalId)) {
      throw new IngestError('BAD_PROPOSAL_ID', 'A proposal id looks like p-001.');
    }
    const req = this._reviewRequest(opts);
    return this._locked(caseId, `ingest ${docId}: review ${proposalId}`, async (m) => {
      const ctx = { cfg: this.settings(), bytes: null, pdf: null };
      try {
        return await this._reviewLocked(m, docId, proposalId, req, ctx);
      } finally {
        await this._closeReader(ctx);
      }
    }, { commitMessage: `ingest-${docId}: reviewed ${proposalId}` });
  }

  // A panel outcome closes an open review question; no fact is written in
  // the owner's name (R47).
  _closeQuestion(m, rec) {
    try {
      const questions = this.runtime.questions(m.id);
      const q = questions.get(rec.questionId);
      if (!q || q.answer || q.closed || q.payload?.type !== 'ingest:review' || q.payload?.docId !== rec.docId) return;
      const accepted = rec.proposals.filter((p) => p.review && p.review.action !== 'rejected').length;
      const rejected = rec.proposals.filter((p) => p.review?.action === 'rejected').length;
      const reason = `Reviewed in the panel: ${accepted} accepted, ${rejected} rejected.`;
      questions.close(q.id, { reason, by: 'panel' });
      this.runtime.records(m.id).writeJournal('ingest', `${q.id} closed for ${rec.docId}: ${reason}`, this.now());
    } catch (err) {
      // Answered meanwhile (another surface won the claim): nothing to close.
      this.log.warn(`Closing the review question of ${rec.docId} failed: ${err.message}`);
    }
  }

  async acceptVerified(caseId, docId, { by = 'panel' } = {}) {
    store.checkDocId(docId);
    if (typeof by !== 'string' || !REVIEWER.test(by)) throw new IngestError('BAD_REQUEST', 'by must be "panel" or "question:<question id>".');
    return this._locked(caseId, `ingest ${docId}: accept verified`, async (m) => {
      this._foldKept(m, docId);
      const raw = files.readRecord(m.dir, docId);
      if (!raw) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
      const rec = this._withoutOrphans(m, shapeRecord(raw));
      // Only owner-added files; a tool file, or an origin this stage does
      // not know, is reviewed proposal by proposal (R45).
      if (!OWNER_ORIGINS.has(rec.origin?.kind)) {
        const what = rec.origin?.kind === 'tool' ? 'a file King Louie added' : 'this file';
        throw new IngestError('NOT_AVAILABLE', `Accept all verified is not available for ${what}. Review each proposal.`);
      }
      const accepted = [];
      const skipped = [];
      const ctx = { cfg: this.settings(), bytes: null, pdf: null };
      try {
        for (const p of rec.proposals) {
          if (p.review) continue;
          const pid = typeof p.id === 'string' && p.id.length <= ID_CAP && review.PROPOSAL_ID.test(p.id) ? p.id : null;
          const why = pid ? review.skipReason(p) : 'it has no valid proposal id';
          if (why) {
            skipped.push({ pid: pid || oneLine(p.id, ID_CAP), why });
            continue;
          }
          try {
            await this._reviewLocked(m, docId, pid, { action: 'accept', by, supersedes: null, keepBoth: false, reason: '', edit: null }, ctx, { recheck: true });
            accepted.push(pid);
          } catch (err) {
            if (!(err instanceof IngestError)) throw err;
            skipped.push({ pid, why: oneLine(err.message, MESSAGE_CAP) });
          }
        }
      } finally {
        await this._closeReader(ctx);
      }
      return { accepted, skipped };
    }, { commitMessage: `ingest-${docId}: reviewed accept-verified` });
  }

  // The ingest:review answer (runs inside answerQuestion's systemAction).
  // The answer is untrusted input: the question must be a review question
  // naming a valid docId, and the option one of the fixed a/b/c that the
  // question offered. Anything else changes nothing.
  async onReviewAnswered(caseId, question) {
    const refuse = (reason) => ({ applied: false, reason });
    if (!isObj(question) || !isObj(question.payload) || question.payload.type !== 'ingest:review') return refuse('Not a document review question.');
    if (typeof question.id !== 'string' || question.id.length > ID_CAP || !QUESTION_ID.test(question.id)) return refuse('The question has no valid id.');
    const docId = question.payload.docId;
    if (typeof docId !== 'string' || !store.DOC_ID.test(docId)) return refuse('The question names no valid document.');
    const option = question.answer?.optionId;
    if (!REVIEW_OPTIONS.has(option) || !arr(question.options).some((o) => isObj(o) && o.id === option)) {
      return refuse('No review option was chosen; review the proposals in the panel.');
    }
    const by = `question:${question.id}`;
    try {
      if (option === 'b') return { applied: false };
      // A stale answer changes nothing: a question the record no longer
      // points at (Extract again asked a new one) or a record with nothing
      // left to review. A record with no question yet accepts the answer.
      const meta = this.runtime.getCase(caseId);
      this._foldKept(meta, docId);
      const found = files.readRecord(meta.dir, docId);
      if (!found) return refuse(`No document ${docId} in this case.`);
      const rec = this._withoutOrphans(meta, shapeRecord(found));
      if (rec.questionId !== undefined && rec.questionId !== null && rec.questionId !== question.id) {
        return refuse(`${question.id} is no longer the review question of ${docId}; review the proposals in the panel.`);
      }
      if (!arr(rec.proposals).some((p) => isObj(p) && !p.review)) return refuse(`Every proposal of ${docId} was already reviewed.`);
      if (option === 'a') {
        const r = await this.acceptVerified(caseId, docId, { by });
        return { applied: 'ingest', accepted: r.accepted, skipped: r.skipped };
      }
      return await this._rejectAll(caseId, docId, by);
    } catch (err) {
      this.log.warn(`Applying the answer to ${question.id} failed: ${err.message}`);
      return refuse(oneLine(err.message, MESSAGE_CAP));
    }
  }

  async _rejectAll(caseId, docId, by) {
    const meta = this.runtime.getCase(caseId);
    const found = files.readRecord(meta.dir, docId);
    if (!found) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
    const rec = this._withoutOrphans(meta, shapeRecord(found));
    const rejected = [];
    for (const p of arr(rec.proposals)) {
      if (!isObj(p) || p.review || typeof p.id !== 'string' || p.id.length > ID_CAP || !review.PROPOSAL_ID.test(p.id)) continue;
      try {
        await this.review(caseId, docId, p.id, { action: 'reject', reason: 'Rejected all from the review question.', by });
        rejected.push(p.id);
      } catch (err) {
        if (err?.code !== 'ALREADY_REVIEWED') throw err;
      }
    }
    return { applied: 'ingest', rejected };
  }

  // ---- reading ----

  _methods(rec) {
    const count = (m) => rec.pages.filter((p) => p.method === m).length;
    return { text: count('text'), ocr: count('ocr'), pendingOcr: count('pending-ocr'), unreadable: count('unreadable') };
  }

  // origin comes from the record, never from the sidecar (T2 carry).
  _summary(raw, cfg) {
    const rec = shapeRecord(raw);
    const methods = this._methods(rec);
    const reviewed = rec.proposals.filter((p) => isObj(p.review));
    const kind = rec.origin?.kind;
    return {
      docId: rec.docId,
      ref: rec.ref,
      name: rec.name,
      status: rec.status,
      note: rec.note || null,
      pages: rec.pageCount ?? null,
      methods,
      usd: round(rec.usd.ocr + rec.usd.extract + rec.usd.verify),
      estimateUsd: round((methods.pendingOcr + methods.unreadable) * cfg.ocrUsdPerPageEstimate),
      pending: rec.proposals.length - reviewed.length,
      accepted: reviewed.filter((p) => p.review.action !== 'rejected').length,
      rejected: reviewed.filter((p) => p.review.action === 'rejected').length,
      origin: ORIGIN_KINDS.has(kind) ? kind : null
    };
  }

  async list(caseId) {
    const meta = this.runtime.getCase(caseId);
    await this.retryPending(meta.id).catch((err) => this.log.warn(`Retrying ingest publishes failed: ${err.message}`));
    const cfg = this.settings();
    return files.listRecords(meta.dir).map((r) => this._summary(r, cfg));
  }

  async get(caseId, docId) {
    store.checkDocId(docId);
    const meta = this.runtime.getCase(caseId);
    await this.retryPending(meta.id).catch((err) => this.log.warn(`Retrying ingest publishes failed: ${err.message}`));
    const rec = files.readRecord(meta.dir, docId);
    if (!rec) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
    return rec;
  }

  text(caseId, docId, { pages = null } = {}) {
    store.checkDocId(docId);
    const meta = this.runtime.getCase(caseId);
    const rec = files.readRecord(meta.dir, docId);
    if (!rec) throw new IngestError('NOT_FOUND', `No document ${docId} in this case.`);
    const wanted = this._pages(pages, rec, this.settings());
    const only = wanted ? new Set(wanted) : null;
    return shapeText(files.readTextStore(meta.dir, docId), docId, rec.sha256).pages
      .filter((p) => !only || only.has(p.n))
      .map(({ n, method, text }) => ({ n, method, text }));
  }

  // At start: publishes kept from a busy lock, then reads that were cut off.
  // Cases that are paused, done or abandoned are left alone.
  async resume() {
    for (const meta of this.runtime.listCases()) {
      if (this.closed) return;
      await this.retryPending(meta.id).catch((err) => this.log.warn(`Retrying ingest publishes for ${meta.slug} failed: ${err.message}`));
      if (WAITING.has(meta.status)) continue;
      for (const rec of files.listRecords(meta.dir)) {
        if (this.closed) return;
        if (!RESUMABLE.has(rec.status)) continue;
        this.extract(meta.id, rec.docId, { by: 'resume' }).catch((err) => this.log.warn(`Resuming ${rec.docId} failed: ${err.message}`));
      }
    }
  }
}

// The owner's answer to a review question. In a process without an ingest
// worker (the mcp server) nothing is applied and the proposals wait in the
// panel.
QuestionStore.registerAnswerHandler('ingest:review', {
  onAnswered: async (question, _fact, { runtime, caseId }) => {
    const svc = ingestServiceFor(runtime);
    if (!svc) return { applied: false, reason: 'Document ingest does not run in this process; review the proposals in the panel.' };
    return svc.onReviewAnswered(caseId, question);
  }
});

module.exports = { IngestService, IngestError, ingestServiceFor, WAITING, OWNER_ORIGINS };
