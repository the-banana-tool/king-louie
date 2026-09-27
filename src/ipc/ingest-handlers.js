// src/ipc/ingest-handlers.js
// Owner surfaces for document ingest (cases stage 7 spec §3.9). The renderer
// sends bytes, never paths: a path would let renderer content copy any file
// the app can read into a case. Review and accept here are the owner's
// actions (by: 'panel'); the model's Ingest tool never reaches them.
//
// The renderer is still an untrusted input boundary:
// - every argument is checked before the service is called, with a fixed
//   error that does not echo it (ids with the service's own checkers,
//   ruling M8; sizes from the base64 length before anything is decoded,
//   ruling M13);
// - a failure is a fixed sentence chosen by error code, never err.message
//   (it can quote a path, a file name or document text); the details go to
//   the host log;
// - replies carry only the fields the panel shows, one-lined and capped,
//   and untrustedText: true whenever they can hold document-derived text
//   (file names, statements, quotes, verify notes), so the panel renders
//   them with textContent only.
//
// Attached (fleet stage 7), every case:* channel is proxied to the service,
// whose bridge dispatcher registers these same handlers, so the same checks
// run there (src/desktop-bridge/allowlist.js gives the slow ones a bounded
// long timeout).
const path = require('path');
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { CASE_ID_RE } = require('./playbook-handlers');
const { createLogger } = require('../logging');
const { DOC_ID, ACCEPTED_MIME, oneLine, cleanName } = require('../cases/ingest/store');
const { PROPOSAL_ID } = require('../cases/ingest/review');
const { PAGES_GRAMMAR } = require('../cases/ingest/extract-text');
const { REVIEW_ACTIONS, EDITABLE, FACT_ID } = require('../cases/ingest');

const log = createLogger('ipc/ingest');

const MAX_FILES = 10;
const MAX_CALL_BYTES = 100 * 1024 * 1024;
const MAX_NAME_INPUT = 255;
const MAX_MIME_INPUT = 255;
const MAX_REASON_INPUT = 1000;
const MAX_PAGES_INPUT = 2000;
const ID_CAP = 24;
const UNAVAILABLE = Object.freeze({ ok: false, error: 'Document ingest is not available in this host.' });
const GENERIC = 'Document ingest could not do that. The details are in the King Louie log.';
const SOURCES = Object.freeze({ drop: 'owner-drop', paste: 'owner-paste' });
const ORIGIN_KINDS = new Set(['owner-drop', 'owner-paste', 'tool']);
const METHODS = new Set(['text', 'ocr', 'pending-ocr', 'unreadable']);
const REVIEWED = new Set(['accepted', 'edited', 'rejected']);
const PROVENANCE = new Set(['user', 'sourced', 'inferred', 'external-agent', 'unknown']);
// Owner edits: the service one-lines them; these are the M10 caps.
const EDIT_CAP = Object.freeze({ stmt: 500, subject: 80, attr: 80, unit: 32, category: 32, value: 300 });
// Caps on reply fields (ruling M10) and on list lengths (a record is
// Bash-writable case data; maxPages and maxProposalsPerDoc are settings).
const CAP = Object.freeze({ name: 120, ref: 512, status: 32, note: 300, title: 200, stmt: 500, subject: 80, attr: 80, value: 300, unit: 32, category: 32, quote: 300, refused: 200, why: 300, at: 40, reviewer: 32 });
const MAX_ROWS = 1000;
const MAX_PAGES_SHOWN = 10000;
const MAX_PROPOSALS_SHOWN = 2000;
const MAX_REFUSED_SHOWN = 200;
const MAX_CASES_SHOWN = 20;
const MAX_CONFLICTS_SHOWN = 20;

// Refused in a file name: C0/C1 controls (tabs and line breaks among
// them), the Unicode line and paragraph separators, and the bidi controls
// that can reorder what the owner sees (LRM/RLM, Arabic letter mark,
// embeddings and overrides, isolates). Other invisible characters (zero-
// width joiners and variation selectors in emoji, for one) are allowed and
// cleanName strips them. Built from code points so no such character sits
// in this file.
const UNSAFE_NAME_RANGES = [[0x0000, 0x001f], [0x007f, 0x009f], [0x2028, 0x2029], [0x200e, 0x200f], [0x061c, 0x061c], [0x202a, 0x202e], [0x2066, 0x2069]];
const UNSAFE_NAME = new RegExp(`[${UNSAFE_NAME_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'u');
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class BadArgument extends Error {}
const bad = (message) => { throw new BadArgument(message); };

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const given = (v) => v !== undefined && v !== null && v !== '';
const text = (v, cap) => (typeof v === 'string' ? oneLine(v, cap) : null);
const pageNo = (n) => (Number.isSafeInteger(n) && n >= 1 ? n : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const usd = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const oneOf = (set, v) => (typeof v === 'string' && set.has(v) ? v : null);
const factId = (v) => (typeof v === 'string' && v.length <= ID_CAP && FACT_ID.test(v) ? v : null);
const proposalId = (v) => (typeof v === 'string' && v.length <= ID_CAP && PROPOSAL_ID.test(v) ? v : null);
const docId = (v) => (typeof v === 'string' && DOC_ID.test(v) ? v : null);
const marked = (r) => ({ ...r, untrustedText: true });

// ---- argument checks (each throws BadArgument with a fixed message) ----

function needCase(p) {
  if (!given(p.caseId)) bad('caseId is required.');
  if (typeof p.caseId !== 'string' || !CASE_ID_RE.test(p.caseId)) bad('caseId is not a valid case id.');
  return p.caseId;
}

function needDoc(p) {
  if (!given(p.docId)) bad('docId is required.');
  if (!docId(p.docId)) bad('docId is not a valid document id.');
  return p.docId;
}

function needProposal(p) {
  if (!given(p.proposalId)) bad('proposalId is required.');
  if (!proposalId(p.proposalId)) bad('proposalId is not a valid proposal id.');
  return p.proposalId;
}

// null for the whole document; else the grammar the service parses.
function checkPages(v) {
  if (!given(v)) return null;
  if (typeof v !== 'string' || v.length > MAX_PAGES_INPUT) bad('pages must look like "1-3,7".');
  const s = v.replace(/\s+/g, '');
  if (!PAGES_GRAMMAR.test(s)) bad('pages must look like "1-3,7".');
  return s;
}

// undefined is false; anything but a boolean is refused, so only === true counts.
function checkFlag(v, field) {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') bad(`${field} must be true or false.`);
  return v === true;
}

function checkEdit(action, edit) {
  if (action !== 'edit') {
    if (edit !== undefined && edit !== null) bad('edit is only for action "edit".');
    return null;
  }
  if (!isObj(edit) || !Object.keys(edit).length) bad('edit must name the fields to change.');
  const keys = Object.keys(edit);
  if (keys.length > EDITABLE.length || keys.some((k) => !EDITABLE.includes(k))) bad(`edit can change only ${EDITABLE.slice(0, -1).join(', ')} and ${EDITABLE[EDITABLE.length - 1]}.`);
  const out = Object.create(null);
  for (const k of keys) {
    const v = edit[k];
    const ok = v === null
      || (typeof v === 'string' && v.length <= EDIT_CAP[k])
      || (k === 'value' && typeof v === 'number' && Number.isFinite(v));
    if (!ok) bad('An edited field is too long or is not text.');
    out[k] = v;
  }
  return out;
}

// → [{ name, mime, base64, bytes }] after every structural and size check,
// nothing decoded yet (ruling M13).
function checkFiles(list) {
  if (!Array.isArray(list) || !list.length) bad('files must be a non-empty list.');
  if (list.length > MAX_FILES) bad(`At most ${MAX_FILES} files per drop.`);
  const out = list.map((f, i) => {
    if (!isObj(f)) bad(`files[${i}] must be { name, mime?, base64 }.`);
    let name = 'document';
    if (f.name !== undefined && f.name !== null) {
      if (typeof f.name !== 'string' || f.name.length > MAX_NAME_INPUT || UNSAFE_NAME.test(f.name)) {
        bad(`files[${i}].name must be a file name of at most ${MAX_NAME_INPUT} characters without control or direction characters.`);
      }
      name = cleanName(f.name);
    }
    let mime = '';
    if (f.mime !== undefined && f.mime !== null) {
      if (typeof f.mime !== 'string' || f.mime.length > MAX_MIME_INPUT) bad(`files[${i}].mime must be text.`);
      // Only the accepted types pass; any other declared type is dropped and
      // the extension decides (the service still checks the bytes).
      const declared = f.mime.trim().toLowerCase();
      mime = ACCEPTED_MIME.includes(declared) ? declared : '';
    }
    if (typeof f.base64 !== 'string' || f.base64.length % 4 !== 0) bad(`files[${i}].base64 must be base64 text.`);
    const padding = f.base64.endsWith('==') ? 2 : f.base64.endsWith('=') ? 1 : 0;
    return { name, mime, base64: f.base64, bytes: (f.base64.length / 4) * 3 - padding };
  });
  const total = out.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_CALL_BYTES) bad('At most 100 MB per drop.');
  // The alphabet last: the sizes above bound the scan.
  out.forEach((f, i) => { if (!BASE64.test(f.base64)) bad(`files[${i}].base64 must be base64 text.`); });
  return out;
}

// ---- errors: fixed sentences by code ----

const BY_CODE = Object.freeze({
  BAD_DOC_ID: 'docId is not a valid document id.',
  BAD_PROPOSAL_ID: 'proposalId is not a valid proposal id.',
  BAD_PAGES: 'pages must look like "1-3,7" and stay within the document.',
  BAD_PAGE: 'pages must look like "1-3,7" and stay within the document.',
  BAD_ACTION: 'action must be accept, edit or reject.',
  BAD_EDIT: 'edit can change only stmt, subject, attr, unit, category (one of the fact categories) and value, and stmt, subject and attr need text.',
  BAD_SUPERSEDES: 'supersedes must name an active fact that conflicts with this proposal.',
  NOT_FOUND: 'No such document or proposal in this case.',
  ALREADY_REVIEWED: 'This proposal has already been reviewed.',
  CONFLICT: 'This proposal conflicts with an active fact. Accept it with supersedes naming that fact, or keep both when the fact is not yours.',
  NOT_ANCHORED: 'This proposal has no verified quote and cannot be accepted. Reject it, or Extract again.',
  ANCHOR_CHANGED: 'The quote is no longer on its page of the stored document. Extract again.',
  DOC_CHANGED: 'The document changed since it was read. Extract again.',
  CHANGED: 'The proposal changed while it was being reviewed. Review it again.',
  VALUE_NOT_IN_QUOTE: 'The new value is not in the quoted text. Reject this proposal and tell King Louie the value in chat.',
  READ_FAILED: 'The stored document could not be read.',
  NOT_AVAILABLE: 'Accept all verified is only for files you added. Review each proposal.',
  CASE_BUSY: 'The case is busy with another change. Try again shortly.',
  CASE_NOT_FOUND: 'This case no longer exists.',
  SHUTTING_DOWN: 'King Louie is shutting down. Try again later.',
  RUNTIME_CLOSING: 'King Louie is shutting down. Try again later.'
});

// Why Accept all verified skipped a proposal, by the code the service gives
// (review.skipCode, the accept-time recheck, or a review error's code, which
// falls back to BY_CODE); anything else gets SKIP_OTHER.
const SKIP_WHY = Object.freeze({
  BAD_PROPOSAL_ID: 'It has no valid proposal id.',
  ALREADY_DONE: 'It was already reviewed.',
  QUOTE_NOT_FOUND: 'Its quote was not found on the page.',
  VALUE_NOT_QUOTED: 'Its value is not in the quoted text.',
  CONFLICTS: 'It conflicts with an active fact.',
  DUPLICATE: 'It duplicates an active fact.',
  VERIFY_DISAGREES: 'The verify check disagrees with it.',
  NOT_VERIFIED: 'It was not verified.',
  IMAGE_NOT_CHECKED: 'It was read by OCR and not checked against the page image.',
  CHECKS_CHANGED: 'Its recorded checks differ from a check made now.'
});
const SKIP_OTHER = 'It could not be accepted automatically.';

const codeOf = (err) => (typeof err?.code === 'string' ? err.code : '');
const logFailure = (channel, err) => log.warn(`${channel} failed: ${oneLine(`${codeOf(err) ? `${codeOf(err)}: ` : ''}${err?.message || err}`, 500)}`);

function failure(channel, err, overrides = {}) {
  if (err instanceof BadArgument) return { ok: false, error: err.message };
  const code = codeOf(err);
  if (Object.prototype.hasOwnProperty.call(overrides, code)) return { ok: false, error: overrides[code] };
  if (Object.prototype.hasOwnProperty.call(BY_CODE, code)) return { ok: false, error: BY_CODE[code] };
  logFailure(channel, err);
  return { ok: false, error: GENERIC };
}

// A store failure for one file, as a fixed reason after the owner's
// cleaned file name.
const FILE_WHY = Object.freeze(Object.assign(Object.create(null), {
  TYPE_MISMATCH: 'its contents do not match its type.',
  TOO_LARGE: 'it is larger than the ingest size limit.',
  TOO_MANY_PAGES: 'it has more pages than the ingest page limit.',
  ENCRYPTED: 'the PDF is password-protected.',
  UNREADABLE_PDF: 'it is not a readable PDF.',
  PDF_TIMEOUT: 'it is not a readable PDF.',
  PDF_WORKER_FAILED: 'it is not a readable PDF.',
  BAD_PATH: 'the earlier ingest record of the same document is damaged; it was marked failed.',
  CASE_BUSY: 'the case is busy with another change. Try again shortly.',
  CASE_NOT_FOUND: 'this case no longer exists.',
  SHUTTING_DOWN: 'King Louie is shutting down. Try again later.',
  RUNTIME_CLOSING: 'King Louie is shutting down. Try again later.'
}));

function fileFailure(name, err) {
  const code = codeOf(err);
  if (code === 'UNSUPPORTED_TYPE') {
    const ext = path.extname(name).slice(1).toLowerCase();
    return { name, error: `Cannot ingest ${name}: ${ext && ext.length <= 16 ? `.${ext}` : 'that file type'} is not supported.` };
  }
  if (FILE_WHY[code]) return { name, error: `Cannot ingest ${name}: ${FILE_WHY[code]}` };
  logFailure(IPC.CASE_INGEST_FILES, err);
  return { name, error: `Cannot ingest ${name}. The details are in the King Louie log.` };
}

// ---- reply shaping: only the panel's fields, capped ----

function shownValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return oneLine(v, CAP.value);
  let json = '';
  try {
    json = JSON.stringify(v) || '';
  } catch { /* cyclic: cannot come from JSON */ }
  return oneLine(json, CAP.value);
}

const shownCases = (list) => arr(list).filter(isObj).slice(0, MAX_CASES_SHOWN)
  .map((c) => ({ caseId: text(c.caseId, 100), title: text(c.title, CAP.title) }));

function shownStored(r) {
  if (!isObj(r)) return { docId: null, ref: null, status: null, duplicate: false, alsoInCases: [] };
  return {
    docId: docId(r.docId),
    ref: text(r.ref, CAP.ref),
    status: text(r.status, CAP.status),
    duplicate: r.duplicate === true,
    alsoInCases: shownCases(r.alsoInCases)
  };
}

function shownRow(d) {
  const m = isObj(d.methods) ? d.methods : {};
  return {
    docId: docId(d.docId),
    ref: text(d.ref, CAP.ref),
    name: text(d.name, CAP.name),
    status: text(d.status, CAP.status),
    note: text(d.note, CAP.note),
    origin: oneOf(ORIGIN_KINDS, d.origin),
    pages: pageNo(d.pages),
    methods: { text: count(m.text), ocr: count(m.ocr), pendingOcr: count(m.pendingOcr), unreadable: count(m.unreadable) },
    usd: usd(d.usd),
    estimateUsd: usd(d.estimateUsd),
    pending: count(d.pending),
    accepted: count(d.accepted),
    rejected: count(d.rejected)
  };
}

function shownChecks(c) {
  if (!isObj(c)) return null;
  const v = isObj(c.verify) ? c.verify : null;
  return {
    anchor: text(c.anchor, CAP.status),
    valueInQuote: typeof c.valueInQuote === 'boolean' ? c.valueInQuote : null,
    conflicts: arr(c.conflicts).filter(isObj).slice(0, MAX_CONFLICTS_SHOWN)
      .map((x) => ({ factId: factId(x.factId), provenance: oneOf(PROVENANCE, x.provenance) }))
      .filter((x) => x.factId),
    duplicateOf: factId(c.duplicateOf),
    verify: v ? {
      agrees: typeof v.agrees === 'boolean' ? v.agrees : null,
      note: text(v.note, CAP.note),
      sawImage: v.sawImage === true
    } : null
  };
}

function shownReview(r) {
  if (!isObj(r)) return null;
  return {
    action: oneOf(REVIEWED, r.action) || 'unknown',
    by: text(r.by, CAP.reviewer),
    at: text(r.at, CAP.at),
    factId: factId(r.factId),
    supersedes: factId(r.supersedes),
    keepBoth: r.keepBoth === true,
    reason: text(r.reason, CAP.note)
  };
}

function shownProposal(p) {
  if (!isObj(p) || !proposalId(p.id)) return null;
  const a = isObj(p.anchor) ? p.anchor : null;
  return {
    id: p.id,
    stmt: text(p.stmt, CAP.stmt),
    subject: text(p.subject, CAP.subject),
    attr: text(p.attr, CAP.attr),
    value: shownValue(p.value),
    unit: text(p.unit, CAP.unit),
    category: text(p.category, CAP.category),
    confidence: typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : null,
    anchor: a ? { page: pageNo(a.page), quote: text(a.quote, CAP.quote), ocr: a.ocr === true } : null,
    checks: shownChecks(p.checks),
    review: shownReview(p.review)
  };
}

function shownRecord(rec) {
  if (!isObj(rec)) return null;
  const truncated = isObj(rec.truncated) && pageNo(rec.truncated.fromPage) ? { fromPage: rec.truncated.fromPage } : null;
  return {
    docId: docId(rec.docId),
    ref: text(rec.ref, CAP.ref),
    name: cleanName(typeof rec.name === 'string' ? rec.name : 'document'),
    mime: typeof rec.mime === 'string' && ACCEPTED_MIME.includes(rec.mime) ? rec.mime : null,
    status: text(rec.status, CAP.status),
    note: text(rec.note, CAP.note),
    origin: { kind: oneOf(ORIGIN_KINDS, rec.origin?.kind) },
    createdAt: text(rec.createdAt, CAP.at),
    updatedAt: text(rec.updatedAt, CAP.at),
    pageCount: pageNo(rec.pageCount),
    pages: arr(rec.pages).filter((p) => isObj(p) && pageNo(p.n)).slice(0, MAX_PAGES_SHOWN).map((p) => ({
      n: p.n,
      method: oneOf(METHODS, p.method),
      ...(given(p.error) ? { error: text(String(p.error), CAP.note) } : {})
    })),
    truncated,
    failedChunks: arr(rec.failedChunks).filter((c) => isObj(c) && pageNo(c.fromPage) && pageNo(c.toPage)).slice(0, MAX_PAGES_SHOWN)
      .map((c) => ({ fromPage: c.fromPage, toPage: c.toPage })),
    usd: isObj(rec.usd) ? { ocr: usd(rec.usd.ocr), extract: usd(rec.usd.extract), verify: usd(rec.usd.verify) } : { ocr: 0, extract: 0, verify: 0 },
    proposals: arr(rec.proposals).slice(0, MAX_PROPOSALS_SHOWN).map(shownProposal).filter(Boolean),
    refused: arr(rec.refused).filter(isObj).slice(0, MAX_REFUSED_SHOWN).map((r) => ({ stmt: text(r.stmt, CAP.refused), reason: text(r.reason, CAP.refused) })),
    refusedDropped: count(rec.refusedDropped)
  };
}

function shownFact(f) {
  if (!isObj(f) || !factId(f.id)) return null;
  return {
    id: f.id,
    stmt: text(f.stmt, CAP.stmt),
    subject: text(f.subject, CAP.subject),
    attr: text(f.attr, CAP.attr),
    value: shownValue(f.value),
    unit: text(f.unit, CAP.unit),
    category: text(f.category, CAP.category),
    provenance: oneOf(PROVENANCE, f.provenance),
    disclosable: f.disclosable === true,
    supersedes: factId(f.supersedes),
    status: text(f.status, CAP.status)
  };
}

// ---- channels ----

function registerIngestHandlers(ipcMain, context = {}) {
  const service = () => (typeof context.getIngestService === 'function' ? context.getIngestService() : null);
  // Every handler catches its own failures: wrapHandler would otherwise
  // return err.message to the renderer.
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    let svc;
    try {
      svc = service();
    } catch (err) {
      logFailure(channel, err);
      svc = null;
    }
    if (!svc) return UNAVAILABLE;
    const p = isObj(payload) ? payload : {};
    try {
      return await fn(svc, p, needCase(p));
    } catch (err) {
      return failure(channel, err);
    }
  }));

  handle(IPC.CASE_INGEST_FILES, async (svc, p, caseId) => {
    const list = checkFiles(p.files);
    if (given(p.source) && !Object.prototype.hasOwnProperty.call(SOURCES, p.source)) bad('source must be "drop" or "paste".');
    const kind = p.source === 'paste' ? SOURCES.paste : SOURCES.drop;
    let maxBytes = Infinity;
    try {
      const n = typeof svc.settings === 'function' ? svc.settings()?.maxBytes : null;
      if (Number.isFinite(n) && n > 0) maxBytes = n;
    } catch (err) {
      logFailure(IPC.CASE_INGEST_FILES, err); // the service checks the size again
    }
    const results = [];
    for (const f of list) {
      if (f.bytes === 0) {
        results.push({ name: f.name, error: `Cannot ingest ${f.name}: it has no content.` });
        continue;
      }
      if (f.bytes > maxBytes) {
        results.push({ name: f.name, error: `Cannot ingest ${f.name}: it is larger than the ingest size limit.` });
        continue;
      }
      try {
        const bytes = Buffer.from(f.base64, 'base64');
        results.push(shownStored(await svc.store(caseId, { name: f.name, mime: f.mime, bytes, origin: { kind } })));
      } catch (err) {
        results.push(fileFailure(f.name, err));
      }
    }
    return marked({ ok: true, results });
  });

  handle(IPC.CASE_SOURCES, async (svc, _p, caseId) => {
    const rows = await svc.list(caseId);
    return marked({ ok: true, documents: arr(rows).filter(isObj).slice(0, MAX_ROWS).map(shownRow) });
  });

  handle(IPC.CASE_INGEST_RECORD, async (svc, p, caseId) => {
    const id = needDoc(p);
    try {
      return marked({ ok: true, record: shownRecord(await svc.get(caseId, id)) });
    } catch (err) {
      return failure(IPC.CASE_INGEST_RECORD, err, { NOT_FOUND: 'No such document in this case.' });
    }
  });

  // Reads take minutes; the panel follows progress through case:changed and
  // its own refresh. A refusal the service makes before queueing (unknown
  // document, pages outside it, shutting down) is already settled when the
  // next macrotask runs, so it is reported; a later failure is logged.
  handle(IPC.CASE_INGEST_EXTRACT, async (svc, p, caseId) => {
    const id = needDoc(p);
    const pages = checkPages(p.pages);
    const job = Promise.resolve().then(() => svc.extract(caseId, id, { by: 'owner', pages }));
    let queued = false;
    let early = null;
    job.catch((err) => {
      if (queued) logFailure(IPC.CASE_INGEST_EXTRACT, err);
      else early = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    queued = true;
    if (early) return failure(IPC.CASE_INGEST_EXTRACT, early, { NOT_FOUND: 'No such document in this case.' });
    return { ok: true, status: 'queued' };
  });

  handle(IPC.CASE_REVIEW_PROPOSAL, async (svc, p, caseId) => {
    const id = needDoc(p);
    const pid = needProposal(p);
    if (!REVIEW_ACTIONS.has(p.action)) bad('action must be accept, edit or reject.');
    const edit = checkEdit(p.action, p.edit);
    let supersedes = null;
    if (given(p.supersedes)) {
      supersedes = factId(p.supersedes);
      if (!supersedes) bad('supersedes must be a fact id like f-0001.');
    }
    const keepBoth = checkFlag(p.keepBoth, 'keepBoth');
    let reason = '';
    if (given(p.reason)) {
      if (typeof p.reason !== 'string' || p.reason.length > MAX_REASON_INPUT) bad(`reason must be text of at most ${MAX_REASON_INPUT} characters.`);
      reason = p.reason;
    }
    const out = await svc.review(caseId, id, pid, { action: p.action, edit, supersedes, keepBoth, reason, by: 'panel' });
    return marked({ ok: true, proposal: shownProposal(out?.proposal), fact: shownFact(out?.fact) });
  });

  handle(IPC.CASE_ACCEPT_VERIFIED, async (svc, p, caseId) => {
    const id = needDoc(p);
    let out;
    try {
      out = await svc.acceptVerified(caseId, id, { by: 'panel' });
    } catch (err) {
      return failure(IPC.CASE_ACCEPT_VERIFIED, err, { NOT_FOUND: 'No such document in this case.' });
    }
    return marked({
      ok: true,
      accepted: arr(out?.accepted).map(proposalId).filter(Boolean).slice(0, MAX_PROPOSALS_SHOWN),
      skipped: arr(out?.skipped).filter(isObj).slice(0, MAX_PROPOSALS_SHOWN)        // A fixed sentence by code, never the service's text (which can
        // quote the verify model's note), then "Review it in the panel."
        .map((s) => {
          const has = (map) => typeof s.code === 'string' && Object.prototype.hasOwnProperty.call(map, s.code);
          const why = has(SKIP_WHY) ? SKIP_WHY[s.code] : has(BY_CODE) ? BY_CODE[s.code] : SKIP_OTHER;
          return { pid: proposalId(s.pid), code: has(SKIP_WHY) || has(BY_CODE) ? s.code : null, why: `${why} Review it in the panel.` };
        })
    });
  });
}

module.exports = { registerIngestHandlers, MAX_FILES, MAX_CALL_BYTES };
