// The front door's copy of each node's audit chain (fleet stage 4 §3.12),
// pulled with F3's own audit.slice RPC. It stores the node-signed slices as
// received, so offline history is still node-signed (never the front
// door's word); gap and break records are the front door's own statements,
// served separately as audit-status. Paging is forward from the mirror
// head with F3's `after` form (Deviation 28).
//
// The mirror is the owner's tamper evidence, so it is written defensively:
// - every slice is verified against the node's key (and its chain checked
//   again here) before anything about the node's state changes;
// - the head only moves once state.json is saved: a slice record appended
//   before a failed save is an unacknowledged tail, reused or dropped by
//   the next ingest, never counted twice;
// - state.json and slices.jsonl live in the service-writable data dir and
//   are parsed as untrusted input. A state that fails validation (or goes
//   missing while slices exist) is quarantined and the node marked broken
//   with an alert, never silently reset to "no history" — a reset would let
//   a later forged history anchor cleanly;
// - alerts are raised before the append and save that can throw.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { verifyAuditSlice } = require('../../audit/audit-ledger');
const { open, verifyEd25519 } = require('../../approvals/envelope');
const { NODE_ID_RE } = require('../../approvals/messages');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { err } = require('../errors');

const log = createLogger('frontdoor/audit-mirror');

const DAY_MS = 86400000;
// verifyAuditSlice reasons that come only after the node's signature and
// the message shape passed: the node itself signed a broken chain.
const TAMPERED = new Set(['hash_mismatch', 'broken_chain', 'head_mismatch', 'exceeds_head', 'before_anchor', 'foreign_entry']);
const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_RE = /^[a-z_]{1,64}$/;
const STATUSES = new Set(['ok', 'gap', 'broken']);
const STATE_KEYS = ['anchor', 'breaks', 'gaps', 'head', 'segment', 'status', 'v'];
const RECORD_KEYS = ['envelope', 'first_seq', 'last_seq', 'received_at', 'segment'];
const ENVELOPE_KEYS = ['alg', 'kid', 'payload', 'sig'];
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 1000; // gaps and breaks each; the oldest go first, status stays sticky
const MAX_PAGES = 1000;
const MAX_PAGE_LIMIT = 200; // F3's MAX_SLICE
const MAX_PAGE_BYTES = 524288; // the router's max_bytes
// head, anchor, created_at and the JSON framing around the entries, before
// base64url; the signature and key id sit outside the payload.
const MESSAGE_SLACK = 1024;
// Above this an oversize page is not even signature-checked (no link frame
// carries it; the mesh caps payloads at 1 MiB).
const HARD_PAYLOAD_CHARS = 16 * 1024 * 1024;
const invalid = () => ({ outcome: 'invalid', more: false });

const isSeq = (n) => Number.isInteger(n) && n >= 1;
const isHash = (h) => typeof h === 'string' && HASH_RE.test(h);
const isIso = (t) => typeof t === 'string' && t.length <= 40 && !Number.isNaN(Date.parse(t));
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const exactKeys = (o, keys, optional = []) => {
  const k = Object.keys(o);
  return keys.every((x) => Object.hasOwn(o, x)) && k.every((x) => keys.includes(x) || optional.includes(x));
};

// Every object in an untrusted file is built without a prototype, so a
// `__proto__` or `constructor` key is just data; the loaders below then copy
// only the fields they know into fresh objects.
function parseUntrusted(text) {
  return JSON.parse(text, (_k, v) => (isObj(v) ? Object.assign(Object.create(null), v) : v));
}

function emptyState() {
  return { v: 1, head: null, segment: 0, anchor: null, gaps: [], breaks: [], status: 'ok' };
}

function normHead(h) {
  if (h === null) return null;
  if (!isObj(h) || !exactKeys(h, ['hash', 'seq']) || !isSeq(h.seq) || !isHash(h.hash)) return undefined;
  return { seq: h.seq, hash: h.hash };
}

function normAnchor(a) {
  if (a === null) return null;
  if (!isObj(a) || !exactKeys(a, ['prev', 'seq']) || !isSeq(a.seq) || !(a.prev === null || isHash(a.prev))) return undefined;
  return { seq: a.seq, prev: a.prev };
}

function normGap(g) {
  if (!isObj(g) || !exactKeys(g, ['at', 'from_seq', 'kind', 'to_seq'], ['anchor_prev'])) return null;
  if (g.kind !== 'gap' && g.kind !== 'pruned_before') return null;
  if (!isSeq(g.from_seq) || !isSeq(g.to_seq) || g.to_seq < g.from_seq || !isIso(g.at)) return null;
  const out = { kind: g.kind, from_seq: g.from_seq, to_seq: g.to_seq };
  if (Object.hasOwn(g, 'anchor_prev')) {
    if (!(g.anchor_prev === null || isHash(g.anchor_prev))) return null;
    out.anchor_prev = g.anchor_prev;
  }
  out.at = g.at;
  return out;
}

function normBreak(b) {
  if (!isObj(b) || !exactKeys(b, ['at', 'mirror_head', 'reason', 'seq'])) return null;
  if (typeof b.reason !== 'string' || !REASON_RE.test(b.reason)) return null;
  if (!(b.seq === null || (Number.isInteger(b.seq) && b.seq >= 0)) || !isIso(b.at)) return null;
  const mirrorHead = normHead(b.mirror_head);
  if (mirrorHead === undefined) return null;
  return { seq: b.seq, reason: b.reason, mirror_head: mirrorHead, at: b.at };
}

// A parsed state.json → a plain, validated state, or null when anything is
// off (including a status that contradicts the recorded breaks and gaps,
// which is what a hand-edited "back to ok" looks like).
function normalizeState(raw) {
  if (!isObj(raw) || !exactKeys(raw, STATE_KEYS) || raw.v !== 1) return null;
  const head = normHead(raw.head);
  const anchor = normAnchor(raw.anchor);
  if (head === undefined || anchor === undefined) return null;
  if (!Number.isInteger(raw.segment) || raw.segment < 0) return null;
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return null;
  if (!Array.isArray(raw.gaps) || raw.gaps.length > MAX_RECORDS) return null;
  if (!Array.isArray(raw.breaks) || raw.breaks.length > MAX_RECORDS) return null;
  const gaps = raw.gaps.map(normGap);
  const breaks = raw.breaks.map(normBreak);
  if (gaps.includes(null) || breaks.includes(null)) return null;
  if (breaks.length > 0 && raw.status !== 'broken') return null;
  if (gaps.some((g) => g.kind === 'gap') && raw.status === 'ok') return null;
  return { v: 1, head, segment: raw.segment, anchor, gaps, breaks, status: raw.status };
}

// One parsed slices.jsonl line → a plain record, or null.
function normalizeRecord(raw) {
  if (!isObj(raw) || !exactKeys(raw, RECORD_KEYS)) return null;
  if (!isIso(raw.received_at) || !Number.isInteger(raw.segment) || raw.segment < 0) return null;
  if (!isSeq(raw.first_seq) || !isSeq(raw.last_seq) || raw.last_seq < raw.first_seq) return null;
  const e = raw.envelope;
  if (!isObj(e) || !exactKeys(e, ENVELOPE_KEYS) || !ENVELOPE_KEYS.every((k) => typeof e[k] === 'string')) return null;
  return {
    received_at: raw.received_at,
    segment: raw.segment,
    first_seq: raw.first_seq,
    last_seq: raw.last_seq,
    envelope: { alg: e.alg, kid: e.kid, payload: e.payload, sig: e.sig }
  };
}

// The mirror's own look at a verified slice's entries, on top of
// verifyAuditSlice: whole-number sequence numbers, well-formed hashes, and
// an unbroken chain (seq +1, prev = the previous hash) inside the slice.
function entriesProblem(entries) {
  let previous = null;
  for (const e of entries) {
    if (!isObj(e) || !isSeq(e.seq) || !isHash(e.hash) || !(e.prev === null || isHash(e.prev))) return 'malformed_entry';
    if (previous && (e.seq !== previous.seq + 1 || e.prev !== previous.hash)) return 'broken_chain';
    previous = e;
  }
  return null;
}

const sameHead = (a, b) => (a === null || b === null ? a === b : a.seq === b.seq && a.hash === b.hash);

class AuditMirror {
  constructor({ dir, alerts = null, retentionDays = null, now = Date.now, pageLimit = 200, pageBytes = 262144 } = {}) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('AuditMirror needs a dir');
    if (retentionDays !== null && !(typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0)) {
      throw new TypeError('AuditMirror retentionDays must be null (unlimited) or a positive number');
    }
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_LIMIT) throw new TypeError(`AuditMirror pageLimit must be 1..${MAX_PAGE_LIMIT}`);
    if (!Number.isInteger(pageBytes) || pageBytes < 1024 || pageBytes > MAX_PAGE_BYTES) throw new TypeError(`AuditMirror pageBytes must be 1024..${MAX_PAGE_BYTES}`);
    if (typeof now !== 'function') throw new TypeError('AuditMirror now must be a function');
    this.dir = dir;
    this.alerts = alerts;
    this.retentionDays = retentionDays;
    this.now = now;
    // Fixed at construction: the page caps are what bound every fetch and
    // every stored line, so they are read-only afterwards.
    Object.defineProperty(this, 'pageLimit', { value: pageLimit, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(this, 'pageBytes', { value: pageBytes, enumerable: true, writable: false, configurable: false });
    this.states = new Map();
    // Nodes whose slices.jsonl tail is known to match the saved head (no
    // unacknowledged record after it), so ingest can skip re-reading it.
    this.tailClean = new Set();
    // Per-node queue: sync and ingestSlice for one node run one at a time.
    this.queues = new Map();
  }

  _nodeDir(nodeId) {
    if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) throw err('bad_node', 'not a node id');
    return path.join(this.dir, nodeId);
  }

  _iso() {
    return new Date(this.now()).toISOString();
  }

  // Alerting must never be what stops the mirror from recording what it saw.
  _alert(kind, nodeId, detail) {
    if (!this.alerts) return;
    try {
      this.alerts.raise(kind, { subject: `node:${nodeId}`, detail });
    } catch (e) {
      log.error(`could not raise ${kind} for ${nodeId}: ${e.message}`);
    }
  }

  // --- untrusted files -------------------------------------------------

  // A regular file's stat, null when absent; a symlink or directory where a
  // mirror file should be is refused.
  _lstatFile(file) {
    let st;
    try {
      st = fs.lstatSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    if (!st.isFile()) throw err('mirror_corrupt', `${path.basename(file)} is not a regular file`);
    return st;
  }

  _state(nodeId) {
    const dir = this._nodeDir(nodeId);
    if (this.states.has(nodeId)) return this.states.get(nodeId);
    const file = path.join(dir, 'state.json');
    let problem = null;
    let text = null;
    try {
      const st = this._lstatFile(file);
      if (st && st.size > MAX_STATE_BYTES) problem = 'oversize';
      else if (st) text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'mirror_corrupt') throw e; // an I/O failure is not evidence of anything: fail the call
      problem = 'not_a_file';
    }
    if (!problem && text === null) {
      if (!this._hasSlices(nodeId)) {
        const s = emptyState();
        this.states.set(nodeId, s);
        return s;
      }
      problem = 'state_missing';
    }
    if (!problem) {
      let parsed;
      try {
        parsed = parseUntrusted(text);
      } catch {
        problem = 'unparseable';
      }
      if (!problem) {
        const s = normalizeState(parsed);
        if (s) {
          this.states.set(nodeId, s);
          return s;
        }
        problem = 'invalid';
      }
    }
    return this._quarantine(nodeId, file, problem);
  }

  // A state.json that cannot be trusted: alert first, move it aside, and
  // carry on as `broken` from the newest stored slice's head (if any), so a
  // node's later history is still compared against what the mirror saw.
  _quarantine(nodeId, file, problem) {
    log.error(`the audit mirror state for ${nodeId} is unusable (${problem}); quarantined, node marked broken`);
    this._alert('audit_chain_break', nodeId, { reason: 'mirror_state_corrupt', problem });
    try {
      fs.renameSync(file, `${file}.corrupt-${this.now()}`);
    } catch (e) {
      if (e.code !== 'ENOENT') log.error(`could not move the corrupt mirror state for ${nodeId} aside: ${e.message}`);
    }
    const s = emptyState();
    const recovered = this._recoverHead(nodeId);
    if (recovered) {
      s.head = recovered.head;
      s.segment = recovered.segment;
    }
    s.breaks.push({ seq: null, reason: 'state_corrupt', mirror_head: s.head ? { ...s.head } : null, at: this._iso() });
    s.status = 'broken';
    this.states.set(nodeId, s);
    this.tailClean.delete(nodeId);
    try {
      this._writeState(nodeId, s);
    } catch (e) {
      // Still broken in memory; a restart finds state.json gone with slices
      // present and lands here again, so the failure stays loud.
      log.error(`could not save the quarantined mirror state for ${nodeId}: ${e.message}`);
    }
    return s;
  }

  _recoverHead(nodeId) {
    try {
      const recs = this._readSlices(nodeId).lines.filter((l) => l.rec);
      const last = recs.length ? recs[recs.length - 1].rec : null;
      if (!last) return null;
      const { message } = open(last.envelope);
      const entries = Array.isArray(message.entries) ? message.entries : [];
      const e = entries[entries.length - 1];
      if (!isObj(e) || !isSeq(e.seq) || !isHash(e.hash)) return null;
      return { head: { seq: e.seq, hash: e.hash }, segment: last.segment };
    } catch (e) {
      log.warn(`could not recover a head from the ${nodeId} mirror slices: ${e.message}`);
      return null;
    }
  }

  _hasSlices(nodeId) {
    try {
      const st = this._lstatFile(path.join(this._nodeDir(nodeId), 'slices.jsonl'));
      return Boolean(st && st.size > 0);
    } catch (e) {
      if (e.code === 'mirror_corrupt') return true;
      throw e;
    }
  }

  // slices.jsonl as raw lines, each with its validated record (or null),
  // plus whether the file ends in a torn (non-newline-terminated) fragment.
  _readSlices(nodeId) {
    const file = path.join(this._nodeDir(nodeId), 'slices.jsonl');
    if (!this._lstatFile(file)) return { lines: [], torn: false };
    const text = fs.readFileSync(file, 'utf8');
    const parts = text.split('\n');
    const torn = parts[parts.length - 1] !== '';
    parts.pop(); // the torn fragment, or the empty string after the last newline
    const maxLine = this._maxLineBytes();
    const lines = [];
    for (const raw of parts) {
      if (raw === '') continue;
      let rec = null;
      if (raw.length <= maxLine) {
        try {
          rec = normalizeRecord(parseUntrusted(raw));
        } catch {
          rec = null;
        }
      }
      if (!rec) log.warn(`skipping an unreadable line in the ${nodeId} mirror`);
      lines.push({ raw, rec });
    }
    return { lines, torn };
  }

  _maxPayloadChars() {
    return Math.ceil(((this.pageBytes + MESSAGE_SLACK) * 4) / 3);
  }

  _maxLineBytes() {
    return this._maxPayloadChars() + 16384;
  }

  _writeState(nodeId, s) {
    const dir = this._nodeDir(nodeId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(s, null, 2)}\n`);
  }

  _appendRecord(nodeId, record) {
    const dir = this._nodeDir(nodeId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'slices.jsonl');
    this._lstatFile(file); // never append through a symlink
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  // Saves first; the in-memory state only becomes `next` once the save
  // returned, so a failed save leaves the head (and everything else) where
  // it was and a retry recomputes the same change.
  _commit(nodeId, next) {
    this._writeState(nodeId, next);
    this.states.set(nodeId, next);
  }

  // Records after the saved head were appended by an ingest whose state
  // save failed (or a crash between the two). If the tail is exactly the
  // slice being ingested now it is reused; otherwise it is dropped, along
  // with any torn fragment, before the new record goes in.
  _reconcileTail(nodeId, s, record) {
    if (this.tailClean.has(nodeId)) return false;
    const { lines, torn } = this._readSlices(nodeId);
    const beyond = (r) => r.segment > s.segment || (r.segment === s.segment && (s.head === null || r.last_seq > s.head.seq));
    let keep = lines.length;
    while (keep > 0 && lines[keep - 1].rec && beyond(lines[keep - 1].rec)) keep -= 1;
    const unacked = lines.slice(keep).map((l) => l.rec);
    if (unacked.length === 0 && !torn) return false;
    if (!torn && unacked.length === 1) {
      const u = unacked[0];
      if (u.segment === record.segment && u.first_seq === record.first_seq && u.last_seq === record.last_seq
        && ENVELOPE_KEYS.every((k) => u.envelope[k] === record.envelope[k])) return true;
    }
    log.warn(`dropping ${unacked.length} unacknowledged slice record(s)${torn ? ' and a torn line' : ''} from the ${nodeId} mirror`);
    writeFileAtomic(path.join(this._nodeDir(nodeId), 'slices.jsonl'), lines.slice(0, keep).map((l) => `${l.raw}\n`).join(''));
    return false;
  }

  // --- reads -----------------------------------------------------------

  cursor(nodeId) {
    const s = this._state(nodeId);
    return s.head ? { ...s.head } : null;
  }

  breaks(nodeId) {
    return structuredClone(this._state(nodeId).breaks);
  }

  audit(nodeId) {
    return this._state(nodeId).status;
  }

  status(nodeId) {
    const s = this._state(nodeId);
    return { head_seq: s.head ? s.head.seq : 0, anchor: s.anchor ? { ...s.anchor } : null, gaps: structuredClone(s.gaps), breaks: structuredClone(s.breaks) };
  }

  // The stored slice that starts below before_seq (or the newest), exactly
  // as the node signed it, with the mirror segment it belongs to. The
  // current segment (the node's present chain) is preferred; an older
  // segment answers only when the current one has nothing below before_seq.
  // A record past the saved head (an unacknowledged tail) is never served.
  history(nodeId, { before_seq: beforeSeq } = {}) {
    if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) return null;
    if (beforeSeq !== undefined && beforeSeq !== null && !isSeq(beforeSeq)) return null;
    let recs;
    let s;
    try {
      s = this._state(nodeId);
      recs = this._readSlices(nodeId).lines.map((l) => l.rec).filter(Boolean);
    } catch (e) {
      log.warn(`could not read the ${nodeId} mirror history: ${e.message}`);
      return null;
    }
    const acked = (r) => r.segment < s.segment || (r.segment === s.segment && s.head !== null && r.last_seq <= s.head.seq);
    const candidates = recs.filter((r) => acked(r) && (!isSeq(beforeSeq) || r.first_seq < beforeSeq));
    if (candidates.length === 0) return null;
    const better = (r, best) => r.segment > best.segment || (r.segment === best.segment && r.last_seq >= best.last_seq);
    const pick = candidates.reduce((best, r) => (better(r, best) ? r : best));
    return { segment: pick.segment, envelope: { ...pick.envelope } };
  }

  // --- ingest ----------------------------------------------------------

  // Runs fn after every earlier sync/ingest of this node has settled. The
  // returned promise carries fn's result or rejection; the queue link
  // itself never rejects, so one failure never blocks the next caller.
  _serial(nodeId, fn) {
    const prior = this.queues.get(nodeId) || Promise.resolve();
    const run = prior.then(fn);
    const done = () => { if (this.queues.get(nodeId) === tracked) this.queues.delete(nodeId); };
    const tracked = run.then(done, done);
    this.queues.set(nodeId, tracked);
    return run;
  }

  // Public ingest goes through the same per-node queue as sync, so a direct
  // ingest can never interleave with a sync's fetch-then-store.
  ingestSlice(nodeId, envelope, nodeKeySpkiHex) {
    try {
      this._nodeDir(nodeId);
    } catch (e) {
      return Promise.reject(e);
    }
    return this._serial(nodeId, () => this._ingest(nodeId, envelope, nodeKeySpkiHex));
  }

  // A slice the node really signed but that the mirror cannot take (too big,
  // naming another node, withholding entries, ...) would otherwise stall the
  // mirror without a word. It is recorded once per mirror head as a break,
  // with an alert, and the head does not move.
  _refuseSigned(nodeId, reason, seq = null) {
    log.error(`a signed audit slice from ${nodeId} was refused: ${reason}`);
    this._break(nodeId, { seq, reason });
    return invalid();
  }

  _ingest(nodeId, envelope, nodeKeySpkiHex) {
    if (!isObj(envelope) || typeof envelope.payload !== 'string') {
      log.warn(`an audit slice from ${nodeId} was refused: not an envelope`);
      return invalid();
    }
    if (envelope.payload.length > this._maxPayloadChars()) {
      // Too big to parse, but the signature is checked over the raw bytes
      // first (up to a hard cap no link frame can exceed): only the node's
      // own oversize page is recorded.
      if (envelope.payload.length <= HARD_PAYLOAD_CHARS && envelope.kid === nodeId && verifyEd25519(envelope, nodeKeySpkiHex)) {
        return this._refuseSigned(nodeId, 'oversize_entry');
      }
      log.warn(`an audit slice from ${nodeId} was refused: larger than ${this.pageBytes} bytes`);
      return invalid();
    }
    let v;
    try {
      v = verifyAuditSlice(envelope, nodeKeySpkiHex);
    } catch {
      v = { ok: false, reason: 'malformed' };
    }
    if (!v.ok) {
      // Past the signature: the node itself signed entries that fail their
      // own hash or chain. Anything else (a bad signature, a bad shape)
      // is refused and changes nothing.
      if (TAMPERED.has(v.reason) && this._signedFor(envelope, nodeId)) return this._break(nodeId, { seq: null, reason: v.reason });
      log.warn(`an audit slice from ${nodeId} was refused: ${v.reason}`);
      return invalid();
    }
    const m = v.message;
    if (m.node_id !== nodeId) return this._refuseSigned(nodeId, 'wrong_node');
    if (m.entries.length > this.pageLimit) return this._refuseSigned(nodeId, 'oversize_page');
    if (m.head.seq < 0 || (m.head.seq === 0 ? m.head.hash !== null : !isHash(m.head.hash))) return this._refuseSigned(nodeId, 'malformed_head');
    const problem = entriesProblem(m.entries);
    if (problem) return this._break(nodeId, { seq: null, reason: problem });

    const s = this._state(nodeId);
    if (m.entries.length === 0) {
      if (s.head && (m.head.seq < s.head.seq || (m.head.seq === s.head.seq && m.head.hash !== s.head.hash))) {
        // The node's whole chain now ends before (or away from) the mirror
        // head: its history was truncated or rewritten.
        return this._break(nodeId, { seq: m.head.seq, reason: 'truncated' });
      }
      if (m.head.seq > (s.head ? s.head.seq : 0)) return this._refuseSigned(nodeId, 'withheld_entries', m.head.seq);
      return { outcome: 'empty', more: false };
    }
    const first = m.entries[0];
    const last = m.entries[m.entries.length - 1];
    const more = last.seq < m.head.seq;
    // F3's ledger answers `after` with the entries following that hash, or,
    // when it no longer has the hash, from its oldest retained entry, which
    // is the slice's signed anchor. So wherever the mirror cannot check
    // continuity against its own head (a first sync, a gap), an honest page
    // starts exactly at the anchor. A page that starts elsewhere is
    // withholding the entries between. The limit: a node that also lies
    // about its anchor (signs an anchor at the page's first entry) still
    // reads as a gap or a prune anchor; only continuity with the mirror
    // head, where there is one, catches that.
    const startsAtAnchor = first.seq === m.anchor.seq && first.prev === m.anchor.prev;

    if (!s.head) {
      if (!startsAtAnchor) return this._refuseSigned(nodeId, 'withheld_entries', first.seq);
      if (first.seq === 1) {
        if (first.prev !== null) return this._break(nodeId, { seq: 1, reason: 'first_prev_not_null' });
        return this._accept(nodeId, envelope, m, 'append', more, (n) => { n.anchor = { seq: 1, prev: null }; });
      }
      // The node pruned before we ever saw it: its oldest entry is our anchor.
      return this._accept(nodeId, envelope, m, 'anchor', more, (n) => {
        n.anchor = { seq: first.seq, prev: first.prev };
        pushCapped(n.gaps, { kind: 'pruned_before', from_seq: 1, to_seq: first.seq - 1, anchor_prev: first.prev, at: this._iso() });
      });
    }
    if (first.seq === s.head.seq + 1 && first.prev === s.head.hash) return this._accept(nodeId, envelope, m, 'append', more, () => {});
    if (first.seq > s.head.seq + 1) {
      // An honest gap: the page starts at the node's oldest retained entry
      // (its anchor), which is past the mirror head. startsAtAnchor with
      // first.seq > head + 1 is exactly that; an anchor at or below the head
      // (the node still has entries the page skipped) fails startsAtAnchor.
      if (!startsAtAnchor) return this._refuseSigned(nodeId, 'withheld_entries', first.seq);
      const gap = { kind: 'gap', from_seq: s.head.seq + 1, to_seq: first.seq - 1, at: this._iso() };
      log.warn(`audit gap on ${nodeId}: ${gap.from_seq}..${gap.to_seq} were pruned before the mirror saw them`);
      this._alert('audit_gap', nodeId, { from_seq: gap.from_seq, to_seq: gap.to_seq });
      return this._accept(nodeId, envelope, m, 'gap', more, (n) => {
        pushCapped(n.gaps, gap);
        if (n.status === 'ok') n.status = 'gap';
      });
    }
    // first.seq <= head.seq, or head + 1 with the wrong prev.
    const atHead = m.entries.find((e) => e.seq === s.head.seq);
    if (atHead && atHead.hash === s.head.hash) {
      // The page overlaps what the mirror already has and runs through its
      // head (a repeated page): nothing new, or append what follows the head.
      if (last.seq === s.head.seq) return { outcome: 'empty', more };
      return this._accept(nodeId, envelope, m, 'append', more, () => {});
    }
    if (last.seq < s.head.seq && this._storedHash(nodeId, s, last.seq) === last.hash) {
      // Entries the mirror already holds, ending below its head: the node
      // lost what came after (its signed head says so), or an old page was
      // replayed. Either way the chain did not fork; the head stays.
      return this._break(nodeId, { seq: last.seq, reason: m.head.seq < s.head.seq ? 'truncated' : 'replay' });
    }
    // The node's chain no longer continues the mirror head: a fork. Record
    // it and start a new segment from the node's current chain.
    const brk = { seq: first.seq, reason: 'fork', mirror_head: { ...s.head }, at: this._iso() };
    const known = s.breaks.some((b) => b.reason === 'fork' && b.seq === brk.seq && sameHead(b.mirror_head, brk.mirror_head));
    log.error(`audit chain break on ${nodeId}: fork at seq ${first.seq} (mirror head ${s.head.seq})`);
    if (!known) this._alert('audit_chain_break', nodeId, { reason: 'fork', seq: first.seq });
    return this._accept(nodeId, envelope, m, 'chain_break', more, (n) => {
      if (!known) pushCapped(n.breaks, brk, { keepFirst: true });
      n.status = 'broken';
      n.segment += 1;
      n.anchor = { seq: first.seq, prev: first.prev };
    });
  }

  // The hash of entry `seq` in the current segment as the mirror stored it,
  // or null when no stored slice of this segment holds it.
  _storedHash(nodeId, s, seq) {
    const recs = this._readSlices(nodeId).lines.map((l) => l.rec).filter((r) => r && r.segment === s.segment && r.first_seq <= seq && seq <= r.last_seq);
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const e = entriesOf(recs[i]).find((x) => x.seq === seq);
      if (e && isHash(e.hash)) return e.hash;
    }
    return null;
  }

  // The envelope names this node (kid and payload), read without trusting
  // the rest of it; used only after verifyAuditSlice passed the signature.
  _signedFor(envelope, nodeId) {
    try {
      return envelope.kid === nodeId && open(envelope).message.node_id === nodeId;
    } catch {
      return false;
    }
  }

  _accept(nodeId, envelope, m, outcome, more, mutate) {
    const s = this._state(nodeId);
    const first = m.entries[0];
    const last = m.entries[m.entries.length - 1];
    const next = structuredClone(s);
    mutate(next);
    next.head = { seq: last.seq, hash: last.hash };
    const record = {
      received_at: this._iso(),
      segment: next.segment,
      first_seq: first.seq,
      last_seq: last.seq,
      envelope: { alg: envelope.alg, kid: envelope.kid, payload: envelope.payload, sig: envelope.sig }
    };
    try {
      // slices.jsonl never exists without a state.json beside it, so a
      // missing state.json next to slices is always tampering, not a crash.
      if (!this._lstatFile(path.join(this._nodeDir(nodeId), 'state.json'))) this._writeState(nodeId, s);
      if (!this._reconcileTail(nodeId, s, record)) this._appendRecord(nodeId, record);
      this._commit(nodeId, next);
    } catch (e) {
      this.tailClean.delete(nodeId);
      log.error(`could not store an audit slice from ${nodeId}: ${e.message}`);
      throw e;
    }
    this.tailClean.add(nodeId);
    return { outcome, more };
  }

  // Records a break once per (reason, seq, mirror head), alerting first.
  _break(nodeId, record) {
    const s = this._state(nodeId);
    const same = s.breaks.find((b) => b.reason === record.reason && b.seq === record.seq && sameHead(b.mirror_head, s.head));
    if (same) return { outcome: 'chain_break', more: false };
    log.error(`audit chain break on ${nodeId}: ${record.reason}`);
    this._alert('audit_chain_break', nodeId, { reason: record.reason, seq: record.seq });
    const next = structuredClone(s);
    pushCapped(next.breaks, { seq: record.seq, reason: record.reason, mirror_head: s.head ? { ...s.head } : null, at: this._iso() }, { keepFirst: true });
    next.status = 'broken';
    this._commit(nodeId, next);
    return { outcome: 'chain_break', more: false };
  }

  // --- sync and retention ----------------------------------------------

  // One sync (or ingest) per node at a time: two overlapping syncs would
  // both page from the same head, and the second's (already stored) page
  // would look like a fork.
  sync(nodeId, { fetchSlice, spkiHex, maxPages = 50 } = {}) {
    try {
      this._nodeDir(nodeId);
      if (typeof fetchSlice !== 'function') throw err('bad_request', 'sync needs fetchSlice');
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw err('bad_request', `maxPages must be 1..${MAX_PAGES}`);
    } catch (e) {
      return Promise.reject(e);
    }
    return this._serial(nodeId, () => this._sync(nodeId, fetchSlice, spkiHex, maxPages));
  }

  async _sync(nodeId, fetchSlice, spkiHex, maxPages) {
    let outcome = 'empty';
    let worst = null;
    let more = false;
    for (let page = 0; page < maxPages; page += 1) {
      const head = this.cursor(nodeId);
      const envelope = await fetchSlice({ limit: this.pageLimit, after: head ? head.hash : null, max_bytes: this.pageBytes });
      const r = this._ingest(nodeId, envelope, spkiHex);
      outcome = r.outcome;
      more = r.more;
      if (['chain_break', 'gap', 'anchor'].includes(r.outcome) && !worst) worst = r.outcome;
      if (!r.more) break;
    }
    if (more) log.info(`audit sync of ${nodeId} stopped after ${maxPages} pages; the rest follows next sync`);
    try {
      this.prune(nodeId);
    } catch (e) {
      log.warn(`could not prune the ${nodeId} mirror: ${e.message}`);
    }
    return worst || outcome;
  }

  // Drops whole stored slices received more than retentionDays ago, but
  // never one that is evidence: the newest, the one holding the current
  // head, the first of each segment (where a fork's new chain starts), one
  // holding a break's mirror head (the chain the node walked away from),
  // the slices either side of a gap, or a line it cannot read.
  prune(nodeId) {
    this._nodeDir(nodeId);
    if (this.retentionDays === null || this.retentionDays === undefined) return 0;
    const s = this._state(nodeId);
    const { lines } = this._readSlices(nodeId);
    const recs = lines.filter((l) => l.rec);
    if (recs.length <= 1) return 0;
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    const keep = new Set([recs[recs.length - 1]]);
    const firstOfSegment = new Set();
    for (const l of recs) {
      if (!firstOfSegment.has(l.rec.segment)) {
        firstOfSegment.add(l.rec.segment);
        keep.add(l);
      }
    }
    const breakHeads = new Set(s.breaks.filter((b) => b.mirror_head).map((b) => b.mirror_head.hash));
    const holdsHead = (r) => s.head !== null && r.segment === s.segment && r.first_seq <= s.head.seq && s.head.seq <= r.last_seq;
    const bordersGap = (r) => s.gaps.some((g) => g.kind === 'gap' && (r.last_seq === g.from_seq - 1 || r.first_seq === g.to_seq + 1));
    const holdsBreakHead = (r) => breakHeads.size > 0 && entriesOf(r).some((e) => breakHeads.has(e.hash));
    const drop = (l) => l.rec && !keep.has(l) && Date.parse(l.rec.received_at) < cutoff
      && !holdsHead(l.rec) && !bordersGap(l.rec) && !holdsBreakHead(l.rec);
    const kept = lines.filter((l) => !drop(l));
    if (kept.length === lines.length) return 0;
    writeFileAtomic(path.join(this._nodeDir(nodeId), 'slices.jsonl'), kept.map((l) => `${l.raw}\n`).join(''));
    return lines.length - kept.length;
  }
}

// The entries of a stored record's envelope, read without re-verifying it
// (it was verified when stored); [] when the stored line does not open.
function entriesOf(record) {
  try {
    const { message } = open(record.envelope);
    return Array.isArray(message.entries) ? message.entries.filter(isObj) : [];
  } catch {
    return [];
  }
}

// Caps a gaps/breaks list, dropping the oldest; with keepFirst the first
// record (the first break the owner was told about) is never the one dropped.
function pushCapped(list, item, { keepFirst = false } = {}) {
  list.push(item);
  const excess = list.length - MAX_RECORDS;
  if (excess > 0) list.splice(keepFirst ? 1 : 0, excess);
}

module.exports = { AuditMirror };
