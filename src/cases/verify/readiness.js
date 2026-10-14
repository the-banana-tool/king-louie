// src/cases/verify/readiness.js
// Cases stage 8 (spec §6.4): the ready-to-close list. Code reads the case's
// record and says what is open and whose it is to fix. No model call and no
// write.
//
// A `fix` line is fixed wording filled with ids and counts only: never a
// criterion's, a question's, a job's or a pull request's text, so it can be
// shown anywhere a status line can. Ids come from file names and from the
// stores' own patterns; an id a file gives for itself is not shown.
const crypto = require('crypto');
const path = require('path');
const { JobStore, TERMINAL_STATES } = require('../executors/job-store');
const { EnvelopeStore, ENVELOPE_STATUSES } = require('../executors/envelope');
const { listRecords } = require('../ingest/files');
const { readJson } = require('../jsonfile');
const { CheckStore, CheckError, checkPolicy, currentCheck } = require('./check');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify/readiness');

const ITEM_IDS = Object.freeze([
  'objective-confirmed', 'criteria-confirmed', 'criteria-met', 'unknowns-resolved', 'questions-answered', 'jobs-settled',
  'plan-settled', 'envelopes-closed', 'detours-settled', 'documents-reviewed', 'tree-clean', 'branch-merged', 'check-passing'
]);
// Whose each item is to fix.
const BY = Object.freeze({
  'objective-confirmed': 'owner',
  'criteria-confirmed': 'owner',
  'criteria-met': 'case',
  'unknowns-resolved': 'either',
  'questions-answered': 'owner',
  'jobs-settled': 'case',
  'plan-settled': 'case',
  'envelopes-closed': 'owner',
  'detours-settled': 'owner',
  'documents-reviewed': 'owner',
  'tree-clean': 'either',
  'branch-merged': 'either',
  'check-passing': 'case'
});
const SETTLED_PLAN = Object.freeze(['done', 'rejected', 'superseded']);
const FINISHED_STEP = Object.freeze(['done', 'cancelled']);
const CLOSED_ENVELOPE = Object.freeze(ENVELOPE_STATUSES.filter((s) => s !== 'requested' && s !== 'active'));
const OPEN_DETOUR = Object.freeze(['proposed', 'held', 'awaiting-mapping']);
const CRITERION_STATES = Object.freeze(['unmet', 'stale', 'failing']);
const REPO_TYPE = 'software-repo';
const CLOSE_PROPOSAL = 'close-proposal';

const CRITERION_ID = /^sc-\d{3,}$/;
const FACT_ID = /^f-\d{4,}$/;
const QUESTION_ID = /^q-\d{4,}$/;
const DETOUR_ID = /^d-\d{4,}$/;
const PLAN_ID = /^plan-\d{3,}$/;

const UNREADABLE = 'King Louie could not read this; the log says why.';
const REPO_UNKNOWN = 'The repository state is not known yet. It is read at the start of a turn.';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const idsOf = (list, pattern) => list.filter((id) => typeof id === 'string' && pattern.test(id));
// " (a, b)" when every id is one of ours; "" otherwise.
const named = (ids, total) => (ids.length && ids.length === total ? ` (${ids.join(', ')})` : '');
const plural = (n, one, many) => (n === 1 ? one : many);

const ok = () => ({ state: 'ok', count: 0, refs: [], fix: null, note: null });
const na = () => ({ state: 'n/a', count: 0, refs: [], fix: null, note: null });
const open = (count, refs, fix, note = null) => ({ state: 'open', count, refs, fix, note });
const unknown = (fix, note = null) => ({ state: 'unknown', count: 0, refs: [], fix, note });

function objectiveConfirmed({ view }) {
  const objective = view?.objective;
  if (!isObject(objective)) return open(1, [], 'Owner: give the case an objective in the case panel.');
  if (objective.state === 'confirmed') return ok();
  return open(1, [], 'Owner: confirm the objective in the case panel.');
}

const rowsOf = (view) => (Array.isArray(view?.criteria) ? view.criteria.filter(isObject) : []);
const isConfirmed = (row) => row.scope === 'confirmed';

function criteriaConfirmed({ view }) {
  const rows = rowsOf(view);
  const proposed = rows.filter((row) => !isConfirmed(row));
  if (proposed.length) {
    const ids = idsOf(proposed.map((row) => row.id), CRITERION_ID);
    return open(proposed.length, ids, `Owner: confirm or drop ${proposed.length} proposed ${plural(proposed.length, 'criterion', 'criteria')}${named(ids, proposed.length)}.`);
  }
  if (!rows.length) return open(0, [], 'Owner: add or confirm a success criterion in the case panel.');
  return ok();
}

function criteriaMet({ view }) {
  const confirmed = rowsOf(view).filter(isConfirmed);
  // Nothing is confirmed: there is nothing to meet (criteria-confirmed says so).
  if (!confirmed.length) return na();
  const notMet = confirmed.filter((row) => row.state !== 'met');
  if (!notMet.length) return ok();
  const shown = notMet.filter((row) => typeof row.id === 'string' && CRITERION_ID.test(row.id));
  const parts = shown.map((row) => `${row.id} is ${CRITERION_STATES.includes(row.state) ? row.state : 'unmet'}`);
  const what = shown.length === notMet.length
    ? parts.join(', ')
    : `${notMet.length} confirmed ${plural(notMet.length, 'criterion is', 'criteria are')} not met`;
  return open(notMet.length, shown.map((row) => row.id), `Case: ${what}. Record the evidence as facts; the verify pass reads them.`);
}

function unknownsResolved({ runtime, meta }) {
  const { facts } = runtime.ledger(meta.id).view();
  const unresolved = [...facts.values()].filter((f) => f && f.status === 'active' && f.provenance === 'unknown' && f.loadBearing);
  if (!unresolved.length) return ok();
  const ids = idsOf(unresolved.map((f) => f.id), FACT_ID);
  const n = unresolved.length;
  return open(n, ids, `Resolve or retract ${n} load-bearing ${plural(n, 'unknown', 'unknowns')}${named(ids, n)}. The owner can answer ${plural(n, 'it', 'them')}; the case can source ${plural(n, 'it', 'them')}.`);
}

function questionsAnswered({ runtime, meta }) {
  // The proposal to close is not something left to do before closing.
  const waiting = runtime.questions(meta.id).open().filter((q) => isObject(q) && q.payload?.type !== CLOSE_PROPOSAL);
  if (!waiting.length) return ok();
  const ids = idsOf(waiting.map((q) => q.id), QUESTION_ID);
  const n = waiting.length;
  return open(n, ids, `Owner: answer ${n} open ${plural(n, 'question', 'questions')}${named(ids, n)}.`);
}

function jobsSettled({ meta }) {
  const store = new JobStore(meta.dir);
  // The id is the file's name; a job file that cannot be read is still open.
  const unsettled = store.ids().filter((id) => {
    let job = null;
    try {
      job = store.get(id);
    } catch {
      job = null;
    }
    return !isObject(job) || !TERMINAL_STATES.includes(job.state);
  });
  if (!unsettled.length) return ok();
  const n = unsettled.length;
  return open(n, unsettled, `Case: ${unsettled.join(', ')} ${plural(n, 'is', 'are')} still open. Wait for ${plural(n, 'it', 'them')} or cancel ${plural(n, 'it', 'them')}.`);
}

function planSettled({ meta }) {
  const plan = readJson(path.join(meta.dir, '.kl', 'plan.json'), null);
  if (plan === null) return ok();
  if (!isObject(plan)) return unknown(UNREADABLE);
  if (SETTLED_PLAN.includes(plan.status)) return ok();
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const unfinished = steps.filter((s) => !isObject(s) || !FINISHED_STEP.includes(s.state)).length;
  const refs = idsOf([plan.id], PLAN_ID);
  if (!unfinished) return open(0, refs, 'Case: the plan is not settled.');
  return open(unfinished, refs, `Case: the plan has ${unfinished} ${plural(unfinished, 'step', 'steps')} not finished.`);
}

function envelopesClosed({ meta }) {
  const store = new EnvelopeStore(meta.dir);
  const active = [];
  const requested = [];
  for (const id of store.ids()) {
    let env = null;
    try {
      env = store.get(id);
    } catch {
      env = null;
    }
    // Closed only when the file says so in a status the store knows; a
    // file that cannot be read is not known to be closed.
    if (isObject(env) && env.status === 'requested') requested.push(id);
    else if (!isObject(env) || !CLOSED_ENVELOPE.includes(env.status)) active.push(id);
  }
  const n = active.length + requested.length;
  if (!n) return ok();
  const parts = [];
  if (active.length) {
    const many = active.length > 1;
    parts.push(`${active.join(', ')} ${many ? 'are' : 'is'} still active. Revoke ${many ? 'them' : 'it'} or let ${many ? 'them' : 'it'} expire.`);
  }
  if (requested.length) {
    const many = requested.length > 1;
    parts.push(`${requested.join(', ')} ${many ? 'wait' : 'waits'} for your approval. Approve or reject ${many ? 'them' : 'it'}.`);
  }
  return open(n, [...active, ...requested], `Owner: ${parts.join(' ')}`);
}

function detoursSettled({ runtime, meta }) {
  const listed = runtime.detours.list(meta.id);
  if (!isObject(listed) || listed.error) return unknown(UNREADABLE);
  const waiting = (Array.isArray(listed.detours) ? listed.detours : []).filter((d) => isObject(d) && OPEN_DETOUR.includes(d.status));
  // A `pending:` blocker in `related` is a detour whose routing is not settled.
  const pending = (Array.isArray(meta.related) ? meta.related : [])
    .filter((r) => isObject(r) && typeof r.id === 'string' && r.id.startsWith('pending:'))
    .map((r) => r.id.slice('pending:'.length));
  const waitingIds = new Set(waiting.map((d) => d.id));
  const extra = pending.filter((id) => !waitingIds.has(id));
  const n = waiting.length + extra.length;
  if (!n) return ok();
  const questions = idsOf(waiting.map((d) => d.questionId), QUESTION_ID);
  if (questions.length === n) {
    return open(n, questions, `Owner: answer the routing ${plural(n, 'question', 'questions')} ${questions.join(', ')}.`);
  }
  const ids = idsOf([...waiting.map((d) => d.id), ...extra], DETOUR_ID);
  return open(n, ids, `Owner: ${n} ${plural(n, 'detour waits', 'detours wait')} to be routed${named(ids, n)}.`);
}

function documentsReviewed({ meta }) {
  // As the case list counts them: records are Bash-writable, so defensively.
  const n = listRecords(meta.dir).reduce((sum, rec) => sum + (Array.isArray(rec?.proposals) ? rec.proposals.filter((p) => isObject(p) && !isObject(p.review)).length : 0), 0);
  if (!n) return ok();
  return open(n, [], `Owner: ${n} document ${plural(n, 'proposal waits', 'proposals wait')} for review.`);
}

// The snapshot of a software-repo case, or a reason there is none to read.
function repoState({ runtime, meta }) {
  const snapshot = runtime.caseTypeSnapshot(meta.id);
  if (!isObject(snapshot) || snapshot.stale || !isObject(snapshot.state)) return null;
  return snapshot.state;
}

function treeClean(ctx) {
  if (ctx.meta.type !== REPO_TYPE) return na();
  const state = repoState(ctx);
  if (!state || !Number.isInteger(state.dirty) || state.dirty < 0) return unknown(REPO_UNKNOWN);
  if (state.dirty === 0) return ok();
  const n = state.dirty;
  return open(n, [], `The repository has ${n} uncommitted ${plural(n, 'change', 'changes')}. Commit or discard ${plural(n, 'it', 'them')}.`);
}

// Narrower than "PRs merged": nothing records which pull requests a case
// opened, so only a PR from the branch the repository is on is counted; the
// note says how many other open PRs were not.
function branchMerged(ctx) {
  if (ctx.meta.type !== REPO_TYPE) return na();
  const state = repoState(ctx);
  if (!state || !Array.isArray(state.openPrs) || typeof state.branch !== 'string' || !state.branch) return unknown(REPO_UNKNOWN);
  const prs = state.openPrs.filter(isObject);
  const mine = prs.filter((pr) => pr.headRefName === state.branch);
  const others = prs.length - mine.length;
  const note = others ? `${others} other open ${plural(others, 'PR is', 'PRs are')} not counted.` : null;
  if (!mine.length) return { ...ok(), note };
  const numbers = mine.map((pr) => pr.number).filter((n) => Number.isInteger(n) && n > 0);
  const n = mine.length;
  const refs = numbers.map((num) => `#${num}`);
  const what = numbers.length === n ? `${plural(n, 'PR', 'PRs')} ${refs.join(', ')}` : `${n} ${plural(n, 'PR', 'PRs')}`;
  return open(n, numbers.length === n ? refs : [], `${what} from this branch ${plural(n, 'is', 'are')} still open. Merge or close ${plural(n, 'it', 'them')}.`, note);
}

// The check command (spec §6.4, §6.6): n/a unless checks are on and this
// case's command is approved for its repository. Then ok only when the
// newest run passed, with a clean tree, at the commit the repository is at.
const CHECK_RUNS_AGAIN = 'It runs again at the end of a turn you start, when the repository has changed.';
function checkPassing(ctx) {
  const { runtime, meta } = ctx;
  if (meta.type !== REPO_TYPE || !checkPolicy(runtime).enabled) return na();
  let current = null;
  try {
    current = currentCheck(runtime, meta.id);
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
  }
  const store = new CheckStore(meta.dir, { now: () => runtime.now() });
  if (!current || !store.isApproved(current.argv, current.key)) return na();
  const run = store.newestRun();
  if (!run) return unknown(`The check has not run yet. ${CHECK_RUNS_AGAIN}`);
  if (run.result === 'fail' || run.result === 'timeout') {
    return open(1, [run.id], `Case: the check last ${run.result === 'timeout' ? 'timed out' : 'failed'} (${run.id}). Fix it and it runs again at the end of the turn.`);
  }
  if (run.result !== 'pass') return unknown(`The check could not be started (${run.id}). ${CHECK_RUNS_AGAIN}`);
  if (run.dirty !== 0) return open(1, [run.id], `The check last passed with uncommitted changes (${run.id}), which does not count. Commit or discard them. ${CHECK_RUNS_AGAIN}`);
  const state = repoState(ctx);
  if (!state || typeof state.head !== 'string' || !state.head) return unknown(REPO_UNKNOWN);
  if (run.head !== state.head) return unknown(`The check last passed at another commit (${run.id}). ${CHECK_RUNS_AGAIN}`);
  return ok();
}

const READERS = Object.freeze({
  'objective-confirmed': objectiveConfirmed,
  'criteria-confirmed': criteriaConfirmed,
  'criteria-met': criteriaMet,
  'unknowns-resolved': unknownsResolved,
  'questions-answered': questionsAnswered,
  'jobs-settled': jobsSettled,
  'plan-settled': planSettled,
  'envelopes-closed': envelopesClosed,
  'detours-settled': detoursSettled,
  'documents-reviewed': documentsReviewed,
  'tree-clean': treeClean,
  'branch-merged': branchMerged,
  'check-passing': checkPassing
});

// `view`: the progress view (verify/status.js `progressView`); read from
// the runtime when not given. → { ready, items, computedAt }; an item is
// { id, state: 'ok' | 'open' | 'unknown' | 'n/a', by, count, refs, fix, note }.
// One item's read failing makes that item `unknown`, never the whole list.
function closeReadiness(runtime, id, { view = null } = {}) {
  const meta = runtime.getCase(id);
  const ctx = { runtime, meta, view: view || runtime.progressView(meta.id) };
  const items = ITEM_IDS.map((itemId) => {
    let result;
    try {
      result = READERS[itemId](ctx);
    } catch (err) {
      // The message may hold case text or a path: it goes to the log only.
      log.warn(`Ready-to-close item ${itemId} of ${meta.slug} could not be read: ${err.message}`);
      result = unknown(UNREADABLE);
    }
    return { id: itemId, state: result.state, by: BY[itemId], count: result.count, refs: result.refs, fix: result.fix, note: result.note };
  });
  return {
    ready: items.every((i) => i.state === 'ok' || i.state === 'n/a'),
    items,
    computedAt: runtime.now().toISOString()
  };
}

// A hash of the list's item ids and states, in id order: what a declined
// close proposal is compared with. Counts, refs and the time are left out.
function readinessFingerprint(readiness) {
  const pairs = (Array.isArray(readiness?.items) ? readiness.items : [])
    .filter(isObject)
    .map((i) => [String(i.id), String(i.state)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex')}`;
}

module.exports = { closeReadiness, readinessFingerprint, ITEM_IDS };
