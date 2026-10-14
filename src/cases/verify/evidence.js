// src/cases/verify/evidence.js
// Cases stage 8 (spec §6.3): what may stand behind a `met` criterion. An
// evidence id is accepted only through the resolver for its prefix (`f-`
// the ledger, `chk-` a run of the check command); an id with no resolver
// holds nothing. Evidence sources (what a turn wrote, for the
// verify pass) are registered here too, with the marks a turn takes when it
// begins and the collector that reads what it wrote since (spec §6.9, §6.10).
const fs = require('fs');
const path = require('path');
const { norm } = require('../jsonl');
const { JobStore } = require('../executors/job-store');
const { CaseRecords } = require('../records');
const { FactLedger } = require('../ledger');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify-evidence');

// A fact of any of these alone may hold a criterion (R-C8-5); never
// `inferred`, never `unknown`.
const ELIGIBLE_PROVENANCE = Object.freeze(['user', 'sourced', 'external-agent']);

// Owner ruling R-C8-N8 (2026-10-14): a `user` fact whose source names an
// MCP channel (`mcp-stdio`, `mcp-frontdoor`, any `mcp-` channel) holds the
// owner's words as an MCP client sent them; nobody checked them (management
// surfaces, Q28). It stays in the ledger and is never evidence: create_case's
// objective fact over MCP and an answer given over MCP alike.
const isMcpChannel = (channel) => typeof channel === 'string' && channel.startsWith('mcp-');
const isUncheckedOwnerWords = (fact) => isObject(fact) && fact.provenance === 'user' && isObject(fact.source) && isMcpChannel(fact.source.channel);
// A fact that may stand behind a `met` criterion, as far as its provenance
// and channel go. The verify pass is shown only these.
const evidenceEligible = (fact) => isObject(fact) && ELIGIBLE_PROVENANCE.includes(fact.provenance) && !isUncheckedOwnerWords(fact);
const PREFIX_RE = /^[A-Za-z]+-$/;
const MISSING = Object.freeze({ exists: false, holds: false, reason: 'evidence-missing' });
const missing = () => ({ ...MISSING });

const resolvers = new Map();
const sources = new Map();
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// `fn(id, ctx) → { exists, holds, reason, provenance?, label? }`; `ctx` is
// whatever the caller of resolveEvidence passes. → a function that puts
// back what was registered before (tests).
function registerEvidenceResolver(prefix, fn) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) throw new Error('An evidence prefix is letters and one dash, like "f-".');
  if (typeof fn !== 'function') throw new Error('An evidence resolver is a function.');
  const before = resolvers.get(prefix);
  resolvers.set(prefix, fn);
  return () => {
    if (resolvers.get(prefix) !== fn) return;
    if (before) resolvers.set(prefix, before);
    else resolvers.delete(prefix);
  };
}

// Picks the resolver by the id's prefix, up to and including the first `-`.
// Never throws: a resolver that does holds nothing.
function resolveEvidence(id, ctx) {
  if (typeof id !== 'string') return missing();
  const dash = id.indexOf('-');
  const fn = dash > 0 ? resolvers.get(id.slice(0, dash + 1)) : null;
  if (!fn) return missing();
  try {
    const result = fn(id, ctx);
    if (!result || typeof result !== 'object') return missing();
    return result;
  } catch (err) {
    log.warn(`Evidence ${id} could not be resolved: ${err.message}`);
    return missing();
  }
}

// `fn(runtime, turn, evidence) → rows`, read by collectTurnEvidence.
function registerEvidenceSource(name, fn) {
  if (typeof name !== 'string' || !name) throw new Error('An evidence source has a name.');
  if (typeof fn !== 'function') throw new Error('An evidence source is a function.');
  const before = sources.get(name);
  sources.set(name, fn);
  return () => {
    if (sources.get(name) !== fn) return;
    if (before) sources.set(name, before);
    else sources.delete(name);
  };
}

const evidenceSources = () => [...sources.entries()].map(([name, fn]) => ({ name, fn }));

const factKey = (f) => `${norm(f.subject)}|${norm(f.attr)}`;

// `ctx.facts` is the ledger view's Map. Labels are ids and fixed words
// only: they are shown in notes and fix lines, where no case text belongs.
function resolveFact(id, ctx) {
  const facts = ctx && ctx.facts instanceof Map ? ctx.facts : null;
  const fact = facts ? facts.get(id) : null;
  if (!fact) return { exists: false, holds: false, reason: 'evidence-missing', label: `${id} is not in the ledger` };
  const base = { exists: true, provenance: fact.provenance ?? null, source: fact.source ?? null, sourceKind: fact.source?.kind ?? null };
  if (fact.status !== 'active') {
    const label = fact.status === 'superseded'
      ? `${id} was superseded${typeof fact.supersededBy === 'string' && fact.supersededBy ? ` by ${fact.supersededBy}` : ''}`
      : fact.status === 'retracted' ? `${id} was retracted` : `${id} is no longer active`;
    return { ...base, holds: false, reason: 'evidence-inactive', label };
  }
  if (!ELIGIBLE_PROVENANCE.includes(fact.provenance)) {
    const what = fact.provenance === 'unknown' ? 'an open unknown' : fact.provenance === 'inferred' ? 'inferred' : 'not a sourced fact';
    return { ...base, holds: false, reason: 'evidence-provenance', label: `${id} is ${what}` };
  }
  if (isUncheckedOwnerWords(fact)) {
    return { ...base, holds: false, reason: 'evidence-provenance', label: `${id} is the owner's words as an MCP client recorded them, unchecked` };
  }
  // The recommendation gate's `blockers` rule (gates.js): an active
  // load-bearing unknown on the same subject.attr.
  const key = factKey(fact);
  for (const other of facts.values()) {
    if (other.provenance === 'unknown' && other.status === 'active' && other.loadBearing && factKey(other) === key) {
      return { ...base, holds: false, reason: 'evidence-blocked', label: `${id} is under the open load-bearing unknown ${other.id}` };
    }
  }
  return { ...base, holds: true, reason: null, label: null };
}

registerEvidenceResolver('f-', resolveFact);

// A run of the check command (spec §6.3, §6.6). `ctx.checks` is the runs of
// .kl/checks.json and `ctx.snapshot` the case-type snapshot. A run holds
// only when it passed, with a clean tree, at the commit the repository is
// at now; when that commit is not known it does not hold.
function resolveCheck(id, ctx) {
  const run = (Array.isArray(ctx?.checks) ? ctx.checks : []).find((r) => isObject(r) && r.id === id);
  if (!run) return { exists: false, holds: false, reason: 'evidence-missing', label: `${id} is not a recorded check run` };
  const base = { exists: true, provenance: 'check', source: null, sourceKind: 'check' };
  const not = (label) => ({ ...base, holds: false, reason: 'check-not-current', label });
  const short = (head) => String(head).slice(0, 7);
  if (run.result !== 'pass') return not(`${id} did not pass`);
  if (run.dirty !== 0) return not(`${id} ran with uncommitted changes`);
  const snapshot = isObject(ctx?.snapshot) && !ctx.snapshot.stale && isObject(ctx.snapshot.state) ? ctx.snapshot.state : null;
  if (!snapshot || typeof snapshot.head !== 'string' || !snapshot.head) return not(`${id}: the repository state is stale or not known`);
  if (typeof run.head !== 'string' || run.head !== snapshot.head) {
    return not(`${id} ran at ${typeof run.head === 'string' && run.head ? short(run.head) : 'an unknown commit'}; the repository is now at ${short(snapshot.head)}`);
  }
  return { ...base, holds: true, reason: null, label: null };
}

registerEvidenceResolver('chk-', resolveCheck);

// ---- What a turn wrote (spec §6.5, §6.9) ----

// The only tools whose results may go to the verify pass (R-C8-9). A shell,
// a page or a file read can carry any third party's text.
const CASE_EVIDENCE_TOOLS = Object.freeze(['Ledger', 'Decide', 'Executor', 'Ingest', 'Progress']);
const TOOL_RESULT_CHARS = 1000;
const TOOL_RESULTS_CHARS = 4000;
const ACTION_CHARS = 40;
const ROW_TEXT_CHARS = 200;
const UNREADABLE_RESULT = '(result could not be read)';
const SOURCE_REF = /^sources\/([a-z][a-z0-9-]{1,39})\/(job-\d+)\//;

const flat = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One tool call of a turn, as the close of the turn may receive it:
// null for any tool that is not a case tool.
function toolResultRow(toolName, parameters, result) {
  if (!CASE_EVIDENCE_TOOLS.includes(toolName)) return null;
  let text;
  try {
    text = JSON.stringify(result);
  } catch {
    text = null;
  }
  if (typeof text !== 'string') text = UNREADABLE_RESULT;
  const action = isObject(parameters) && typeof parameters.action === 'string' ? flat(parameters.action, ACTION_CHARS) : '';
  return { tool: toolName, action: action || null, ok: isObject(result) && result.ok === true, text: text.slice(0, TOOL_RESULT_CHARS) };
}

// Rows a caller handed in are not trusted: filtered by tool again, each cut
// again, and 4,000 characters in all.
function boundToolResults(rows) {
  const out = [];
  let left = TOOL_RESULTS_CHARS;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (left <= 0) break;
    if (!isObject(row) || !CASE_EVIDENCE_TOOLS.includes(row.tool) || typeof row.text !== 'string') continue;
    const text = row.text.slice(0, Math.min(TOOL_RESULT_CHARS, left));
    left -= text.length;
    out.push({ tool: row.tool, action: typeof row.action === 'string' && row.action ? flat(row.action, ACTION_CHARS) : null, ok: row.ok === true, text });
  }
  return out;
}

// The lines of facts.jsonl as they are on disk (a line the ledger would
// skip still counts: the mark is a position in the file).
function ledgerLines(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`facts.jsonl in ${dir} cannot be read: ${err.message}`);
    return [];
  }
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// jobId -> how many of its results are recorded. Read from the case's own
// files, with or without an executor registry.
function jobRecordCounts(dir) {
  const out = {};
  for (const job of new JobStore(dir).list()) {
    if (typeof job.id === 'string') out[job.id] = Array.isArray(job.recordsSaved) ? job.recordsSaved.length : 0;
  }
  return out;
}

// Each confirmed criterion's state in a progress view: { 'sc-001': 'met' }.
function statesOf(view) {
  const out = {};
  for (const row of Array.isArray(view?.criteria) ? view.criteria : []) {
    if (row && row.scope === 'confirmed' && typeof row.id === 'string' && typeof row.state === 'string') out[row.id] = row.state;
  }
  return out;
}

// Taken last in beginTurn: where the record stood when the turn began.
// `states` is each confirmed criterion's computed state then (null when it
// could not be computed, or the case is closed), so the close can say which
// one left `met` during the turn. Reads only.
function turnMarks(runtime, caseId) {
  const meta = runtime.getCase(caseId);
  const jobs = jobRecordCounts(meta.dir);
  let snapshot = null;
  try {
    snapshot = runtime.caseTypeSnapshot(meta.id);
  } catch (err) {
    log.warn(`Marks of ${meta.slug}: the case-type snapshot is unavailable: ${err.message}`);
  }
  const state = isObject(snapshot) && isObject(snapshot.state) ? snapshot.state : {};
  let states = null;
  try {
    states = meta.status === 'done' || meta.status === 'abandoned' ? null : statesOf(runtime.progressView(meta.id));
  } catch (err) {
    log.warn(`Marks of ${meta.slug}: the criteria states are unavailable: ${err.message}`);
  }
  return {
    ledgerLines: ledgerLines(meta.dir).length,
    decisions: new CaseRecords(meta.dir).decisions().length,
    jobRecords: Object.values(jobs).reduce((n, c) => n + c, 0),
    jobs,
    head: typeof state.head === 'string' && state.head ? state.head : null,
    dirty: Number.isInteger(state.dirty) ? state.dirty : null,
    states
  };
}

function normalRow(row) {
  if (!isObject(row) || typeof row.kind !== 'string' || !row.kind || typeof row.id !== 'string' || !row.id) return null;
  return {
    kind: flat(row.kind, ACTION_CHARS),
    id: flat(row.id, ACTION_CHARS),
    text: flat(row.text, ROW_TEXT_CHARS),
    refs: (Array.isArray(row.refs) ? row.refs : []).filter((r) => typeof r === 'string' && r).map((r) => flat(r, ACTION_CHARS))
  };
}

// The first registered source (spec §6.10): jobs whose recorded results grew
// during the turn, each with the facts this turn wrote from its results.
function executorResultRows(runtime, turn, evidence) {
  const before = isObject(turn?.marks?.jobs) ? turn.marks.jobs : null;
  if (!before) return [];
  const facts = Array.isArray(evidence?.facts) ? evidence.facts : [];
  const rows = [];
  for (const job of new JobStore(turn.dir).list()) {
    if (typeof job.id !== 'string') continue;
    const count = Array.isArray(job.recordsSaved) ? job.recordsSaved.length : 0;
    if (count <= (Number(before[job.id]) || 0)) continue;
    const refs = facts
      .filter((f) => {
        const m = SOURCE_REF.exec(String(f?.source?.ref || ''));
        return Boolean(m) && m[1] === job.executor && m[2] === job.id;
      })
      .map((f) => f.id);
    rows.push({ kind: 'executor-result', id: job.id, text: `${flat(job.executor, 40)} ${flat(job.state, 40)}`.trim(), refs });
  }
  return rows;
}

registerEvidenceSource('executor-results', executorResultRows);

// What the turn wrote, read from the record (never from what a model said
// it wrote): → { changed, facts, decisions, executorResults, toolResults,
// extra }. A turn with no marks finds only the facts that carry its id.
function collectTurnEvidence(runtime, turn, evidence = {}) {
  const marks = isObject(turn?.marks) ? turn.marks : null;
  const dir = turn.dir;
  const past = new Set();
  if (marks && Number.isInteger(marks.ledgerLines)) {
    for (const line of ledgerLines(dir).slice(marks.ledgerLines)) {
      try {
        const entry = JSON.parse(line);
        if (isObject(entry) && entry.kind === 'fact' && typeof entry.id === 'string') past.add(entry.id);
      } catch {
        // A line the ledger skips too.
      }
    }
  }
  const facts = [...new FactLedger(dir).view().facts.values()]
    .filter((f) => past.has(f.id) || (typeof turn.turnId === 'string' && turn.turnId && f.addedBy === turn.turnId));
  const decisions = marks && Number.isInteger(marks.decisions)
    ? new CaseRecords(dir).decisions().slice(marks.decisions).filter(isObject)
    : [];
  let executorResults = [];
  const extra = [];
  for (const { name, fn } of evidenceSources()) {
    let rows = [];
    try {
      rows = fn(runtime, turn, { facts, decisions });
    } catch (err) {
      log.warn(`Evidence source ${name} failed on case ${turn.caseId}: ${err.message}`);
      continue;
    }
    const kept = (Array.isArray(rows) ? rows : []).map(normalRow).filter(Boolean);
    if (name === 'executor-results') executorResults = kept;
    else extra.push(...kept);
  }
  return {
    changed: facts.length > 0 || decisions.length > 0 || executorResults.length > 0,
    facts,
    decisions,
    executorResults,
    toolResults: boundToolResults(evidence?.toolResults),
    extra
  };
}

module.exports = {
  ELIGIBLE_PROVENANCE,
  evidenceEligible,
  registerEvidenceResolver,
  resolveEvidence,
  registerEvidenceSource,
  evidenceSources,
  CASE_EVIDENCE_TOOLS,
  toolResultRow,
  turnMarks,
  statesOf,
  collectTurnEvidence
};
