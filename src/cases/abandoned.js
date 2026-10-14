// src/cases/abandoned.js
// Cases stage 8 (spec §6.2, §7.2): the approaches a case tried and dropped
// while it kept working. <case>/.kl/abandoned.jsonl is append-only: an
// `abandon` line adds a record, a `withdraw` line takes one out of the
// orientation, and nothing is ever edited or removed.
//
// The record is private case data. Nothing here reaches the cross-case
// index, and index-store.js builds no document from the file.
const path = require('path');
const { appendJsonl, readJsonl } = require('./jsonl');
const { plainLineProblem } = require('./hidden-chars');
const { normalizeForQuote } = require('./chat-integration');

const APPROACH_CHARS = [5, 200];
const WHY_CHARS = [5, 300];
const MAX_TRIED = 6;
const MAX_TRIED_CHARS = 200;
const ID_RE = /^ab-(\d{4,})$/;
const HIDDEN = '(text hidden: not one plain line)';
const ELLIPSIS = '…';

// One orientation line holds at most this much of each field.
const LINE_MAX = 300;
const LINE_APPROACH = 110;
const LINE_WHY = 130;
const LINE_IDS = 3;
const REF_RE = /^[A-Za-z]{1,4}-\d{1,8}$/;

class AbandonedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AbandonedError';
    this.code = code;
  }
}

const invalid = (message) => new AbandonedError('ABANDON_INVALID', message);
const idOf = (n) => `ab-${String(n).padStart(4, '0')}`;
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

function plainLine(value, name, [min, max]) {
  if (typeof value !== 'string') throw invalid(`"${name}" is one line of text.`);
  const text = value.trim();
  const problem = plainLineProblem(text);
  if (problem) throw invalid(`"${name}" is one plain line; ${problem}.`);
  if (text.length < min || text.length > max) throw invalid(`"${name}" is ${min} to ${max} characters; this one is ${text.length}.`);
  return text;
}

function idList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) throw invalid(`"${name}" is a list of ids.`);
  return [...new Set(value.map((id) => id.trim()))];
}

// `decisions` as the caller has them: a list of records or ids, what
// CaseRecords.decisions() returns ({ entries }), a Set or a Map.
function decisionIdSet(decisions) {
  if (decisions instanceof Map) return new Set(decisions.keys());
  if (decisions instanceof Set) return decisions;
  const list = Array.isArray(decisions) ? decisions : Array.isArray(decisions?.entries) ? decisions.entries : [];
  return new Set(list.map((d) => (typeof d === 'string' ? d : d?.id)).filter((id) => typeof id === 'string'));
}

class AbandonedStore {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'abandoned.jsonl');
    this.now = now;
  }

  // → { records, errors, nextId }. A malformed line is skipped into
  // `errors` with its 1-based line number.
  _fold() {
    const records = [];
    const byId = new Map();
    let highest = 0;
    const check = (line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error('not a record');
      const m = ID_RE.exec(String(line.id || ''));
      // An id a bad line used is never handed out again.
      if (m) highest = Math.max(highest, Number(m[1]));
      if (line.kind === 'abandon') {
        if (!m) throw new Error('an abandon line needs an id like ab-0001');
        if (byId.has(line.id)) throw new Error(`${line.id} is already in the file`);
        if (typeof line.approach !== 'string' || !line.approach.trim()) throw new Error(`${line.id} has no approach`);
        if (typeof line.why !== 'string' || !line.why.trim()) throw new Error(`${line.id} has no why`);
        const record = {
          id: line.id,
          at: strOrNull(line.at),
          turnId: strOrNull(line.turnId),
          approach: line.approach,
          why: line.why,
          tried: strings(line.tried),
          factIds: strings(line.factIds),
          decisionIds: strings(line.decisionIds),
          withdrawn: null
        };
        byId.set(record.id, record);
        records.push(record);
        return;
      }
      if (line.kind === 'withdraw') {
        const target = byId.get(line.target);
        if (!target) throw new Error(`withdraw names ${String(line.target)}, which is not in the file`);
        if (target.withdrawn) throw new Error(`${target.id} is already withdrawn`);
        target.withdrawn = { at: strOrNull(line.at), why: typeof line.why === 'string' ? line.why : '', turnId: strOrNull(line.turnId) };
        return;
      }
      throw new Error(`unknown kind ${JSON.stringify(line.kind)}`);
    };
    const { errors } = readJsonl(this.file, check);
    return { records, errors, nextId: highest + 1 };
  }

  // Every record, oldest first, withdrawn ones included.
  list() {
    const { records, errors } = this._fold();
    return { records, errors };
  }

  // The records that still stand, oldest first.
  active() {
    return this._fold().records.filter((r) => r.withdrawn === null);
  }

  // `facts` is the ledger view's Map (a fact of any status may be cited: the
  // fact that killed the approach may itself be superseded later);
  // `decisions` the case's decisions. An id that cannot be checked is refused.
  abandon({ approach, why, tried = [], factIds = [], decisionIds = [], turnId = null } = {}, { facts = null, decisions = null } = {}) {
    const record = {
      approach: plainLine(approach, 'approach', APPROACH_CHARS),
      why: plainLine(why, 'why', WHY_CHARS)
    };
    if (tried !== undefined && tried !== null && !Array.isArray(tried)) throw invalid('"tried" is a list of lines.');
    const triedList = tried || [];
    if (triedList.length > MAX_TRIED) throw invalid(`"tried" holds at most ${MAX_TRIED} lines; this has ${triedList.length}.`);
    record.tried = triedList.map((line) => plainLine(line, 'tried', [1, MAX_TRIED_CHARS]));
    record.factIds = idList(factIds, 'factIds');
    record.decisionIds = idList(decisionIds, 'decisionIds');
    const known = facts instanceof Map ? facts : new Map();
    for (const id of record.factIds) {
      if (!known.has(id)) throw invalid(`${id} is not a fact in this case's ledger.`);
    }
    const decided = decisionIdSet(decisions);
    for (const id of record.decisionIds) {
      if (!decided.has(id)) throw invalid(`${id} is not a decision of this case.`);
    }

    const { records, nextId } = this._fold();
    const folded = normalizeForQuote(record.approach);
    const same = records.find((r) => r.withdrawn === null && normalizeForQuote(r.approach) === folded);
    if (same) {
      throw new AbandonedError('ALREADY_ABANDONED', `${same.id} already records this approach as abandoned. Withdraw it first if it is being tried again.`);
    }
    const line = {
      kind: 'abandon',
      id: idOf(nextId),
      at: this.now().toISOString(),
      turnId: strOrNull(turnId),
      approach: record.approach,
      why: record.why,
      tried: record.tried,
      factIds: record.factIds,
      decisionIds: record.decisionIds
    };
    appendJsonl(this.file, line);
    const { kind, ...rest } = line;
    return { ...rest, withdrawn: null };
  }

  // Appends a `withdraw` line: the record stays in the file and leaves the
  // orientation. → the record as it now reads.
  withdraw(id, { why, turnId = null } = {}) {
    const reason = plainLine(why, 'why', WHY_CHARS);
    const target = this._fold().records.find((r) => r.id === id);
    if (!target) throw invalid(`${String(id)} is not an abandoned approach of this case.`);
    if (target.withdrawn) throw invalid(`${target.id} is already withdrawn.`);
    const line = { kind: 'withdraw', target: target.id, at: this.now().toISOString(), turnId: strOrNull(turnId), why: reason };
    appendJsonl(this.file, line);
    return { ...target, withdrawn: { at: line.at, why: line.why, turnId: line.turnId } };
  }
}

// Stored text is shown only when it is one plain line; it is never
// flattened into one (the file is not guarded against Bash).
function shown(text, max) {
  if (typeof text !== 'string' || !text.trim() || plainLineProblem(text.trim())) return HIDDEN;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}${ELLIPSIS}` : t;
}

function recordLine(r) {
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(r.at || '')) ? r.at.slice(0, 10) : '(no date)';
  const ids = strings(r.factIds).filter((id) => REF_RE.test(id));
  const cited = ids.length > LINE_IDS ? [...ids.slice(0, LINE_IDS), ELLIPSIS] : ids;
  const id = ID_RE.test(String(r.id || '')) ? r.id : 'ab-????';
  const line = `- ${id} ${date} ${shown(r.approach, LINE_APPROACH)}: ${shown(r.why, LINE_WHY)}${cited.length ? ` [${cited.join(', ')}]` : ''}`;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}${ELLIPSIS}` : line;
}

const earlierLine = (n) => `- ${ELLIPSIS} ${n} earlier; Progress abandoned lists them`;

// The orientation's lines: the newest `max` active records, newest first,
// one line each, the whole at most `maxChars`; then how many were left out
// by either cap.
function abandonedLines(records, { max = 8, maxChars = 1500 } = {}) {
  const active = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object' && !r.withdrawn);
  if (!active.length) return [];
  const lines = [];
  for (const record of active.slice(-max).reverse()) {
    const next = [...lines, recordLine(record)];
    const left = active.length - next.length;
    const size = next.join('\n').length + (left > 0 ? 1 + earlierLine(left).length : 0);
    if (size > maxChars) break;
    lines.push(next[next.length - 1]);
  }
  const left = active.length - lines.length;
  if (left > 0) lines.push(earlierLine(left));
  return lines;
}

module.exports = { AbandonedStore, AbandonedError, abandonedLines };
