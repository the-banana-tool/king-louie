// src/cases/executors/jobs.js
// Job lifecycle (cases stage 3 spec §3.5 step 13, §3.12, §3.13): commit a
// submitted job, poll open jobs, charge reported cost, settle terminal jobs,
// write the .kl/executors.json snapshot, cancel, reconcile, and copy
// background output into the case. Every function takes the registry first.
//
// Write order for money (charged exactly once, never twice):
//   1. Validate what the executor returned. An unknown state is refused
//      before anything is charged or written.
//   2. Write-ahead: the job file records the new `chargedUsd` and a
//      `pendingCharge` marker (state unchanged on disk).
//   3. Charge the case budget.
//   4. Record the job's charged total on the envelope (`usage.charged`),
//      which makes the envelope update idempotent.
//   5. Save the job with the marker cleared.
// A crash after 2 leaves the marker: the next poll completes step 4 and
// reports the charge as interrupted. The budget charge (3) is not
// idempotent, so it is never replayed: an interrupted charge can be missing
// from the budget, but it is never counted twice. A charge never goes down:
// a lower reported cost is journaled, not refunded (money spent stays spent,
// and the envelope's usd cap stays closed).
// Every mutation after an await re-reads the job from disk, and the steps
// from the re-read to the save run with no await in between, so a cancel
// that lands while a poll is out wins and the poll charges nothing.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const {
  JobStore, JobStateError, readSnapshot, writeSnapshot, OPEN_STATES, TERMINAL_STATES, isOpen
} = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const { PlanStore } = require('./plan');
const { readJsonSafe, writeJsonAtomic, roundUsd, money, cut } = require('./util');

const log = createLogger('executors/jobs');
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const MIN_POLL_MS = 60 * 1000;
const BUSY = 'Case is busy with a wake-up; try again in a minute.';
// States an executor may report. `submitting` (before the executor has the
// job) and `unreachable` (the node's verdict on failed polls) are the node's.
const NODE_ONLY_STATES = new Set(['submitting', 'unreachable']);
const ADAPTER_STATES = Object.freeze([...OPEN_STATES, ...TERMINAL_STATES].filter((s) => !NODE_ONLY_STATES.has(s)));

const runKey = (caseId, jobId) => `${caseId}/${jobId}`;
const isTerminal = (state) => TERMINAL_STATES.includes(state);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isJobStateError = (err) => Boolean(err) && err.code === 'JOB_STATE';
// Executor-sourced text is bounded before it reaches a job, the journal or
// the snapshot.
const clip = (text) => cut(String(text ?? ''), 300);
const validExternalId = (id) => typeof id === 'string' && id.trim() !== '';
const MAX_CONTACTS = 200;
const MAX_CONTACT_FIELDS = 20;

// Adapter-reported contacts are bounded before they are stored or shown:
// at most MAX_CONTACTS entries, each a flat record of at most
// MAX_CONTACT_FIELDS primitive fields, every string cut to 300 characters.
// Nested values are dropped.
function capContacts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (out.length >= MAX_CONTACTS) break;
    if (!isObject(c)) continue;
    const flat = {};
    for (const [k, v] of Object.entries(c).slice(0, MAX_CONTACT_FIELDS)) {
      if (typeof v === 'string') flat[clip(k)] = clip(v);
      else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) flat[clip(k)] = v;
    }
    out.push(flat);
  }
  return out;
}

// An executor's lastChange as ISO 8601, or `now` when it does not parse.
function isoOr(value, now) {
  const ms = typeof value === 'string' || typeof value === 'number' ? Date.parse(String(value)) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : now.toISOString();
}

function kindOf(entry) {
  if (!entry) return 'external';
  if (entry.kind === 'external-agent') return 'external';
  if (entry.direct) return 'direct';
  return entry.id;
}

function runDir(reg, caseId, jobId) {
  return path.join(reg.runsDir, caseId, jobId);
}

function readRunStatus(reg, caseId, jobId) {
  return readJsonSafe(path.join(runDir(reg, caseId, jobId), 'status.json'), null);
}

function writeRunStatus(reg, caseId, jobId, status) {
  writeJsonAtomic(path.join(runDir(reg, caseId, jobId), 'status.json'), status);
}

// Both lists are capped (capContacts), and so is the merge.
function mergeContacts(current = [], incoming = []) {
  const byId = new Map(capContacts(current).map((c) => [c.id, { ...c }]));
  for (const c of capContacts(incoming)) {
    if (c.id === undefined) continue;
    byId.set(c.id, { ...(byId.get(c.id) || {}), ...c });
  }
  return capContacts([...byId.values()]);
}

// `fn` may return false to leave the envelope file untouched.
function updateEnvelope(caseDir, envelopeId, fn) {
  if (!envelopeId) return null;
  const store = new EnvelopeStore(caseDir);
  const env = store.get(envelopeId);
  if (!env) return null;
  env.usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  if (fn(env) === false) return env;
  return store.write(env);
}

// Why an executor's answer cannot be applied, or null. Checked before any
// side effect: a bad state never charges, never moves the job.
function stateProblem(state, { optional = false } = {}) {
  if (optional && (state === undefined || state === null)) return null;
  if (typeof state === 'string' && ADAPTER_STATES.includes(state)) return null;
  return `the executor reported an unknown job state ${clip(JSON.stringify(state ?? null))} (expected one of ${ADAPTER_STATES.join(', ')})`;
}

function statusProblem(status) {
  if (!isObject(status)) return 'the executor returned no status object';
  const bad = stateProblem(status.state);
  if (bad) return bad;
  const cost = status.costUsd;
  if (cost !== undefined && cost !== null && !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) {
    return `the executor reported an invalid cost ${clip(JSON.stringify(cost))}`;
  }
  return null;
}

function journal(reg, caseId, text) {
  try {
    reg.caseRuntime.records(caseId).writeJournal('envelope', text, reg.now());
  } catch (err) {
    log.warn(`Case ${caseId}: writing a journal line failed: ${err.message}`);
  }
}

// Effects that run after the job is saved: budget crossings (a crossing can
// pause the case, which cancels its open jobs) and journal lines (a failing
// journal write never costs the job its save).
const newAfter = () => ({ crossings: [], journal: [] });

function flushAfter(reg, caseId, after) {
  for (const [category, crossedNow] of after.crossings) {
    try {
      reg.caseRuntime.onCrossings(caseId, category, crossedNow);
    } catch (err) {
      log.warn(`Case ${caseId}: handling the ${category} crossing failed: ${err.message}`);
    }
  }
  for (const text of after.journal) journal(reg, caseId, text);
}

// Writes the listed fields of `job` onto the job as it is on disk, keeping
// the disk state. Throws JobStateError (before anything is charged) when a
// cancel or other terminal write has landed since `job` was read.
function writeAhead(store, job, fields) {
  const disk = store.get(job.id);
  if (!isObject(disk)) return store.write(job);
  if (isTerminal(disk.state) && disk.state !== job.state) {
    throw new JobStateError(`${job.id} is ${disk.state}; not charging a late update`);
  }
  const next = { ...disk };
  for (const f of fields) next[f] = job[f];
  return store.write(next);
}

// The final save. A JOB_STATE refusal means a terminal write won (never in
// one process: see the header); the save is skipped, but the charge fields
// are carried onto the terminal record so no charge stays unrecorded.
function saveJob(store, job) {
  try {
    store.write(job);
    return true;
  } catch (err) {
    if (!isJobStateError(err)) throw err;
    const disk = store.get(job.id);
    log.warn(`Not saving ${job.id}: ${err.message}`);
    if (isObject(disk) && Number(disk.chargedUsd) !== Number(job.chargedUsd)) {
      store.write({ ...disk, chargedUsd: job.chargedUsd, costReported: Boolean(job.costReported || disk.costReported), pendingCharge: null });
    }
    return false;
  }
}

// Idempotent: the envelope keeps each job's charged total.
function envelopeCharge(caseDir, envelopeId, jobId, total) {
  updateEnvelope(caseDir, envelopeId, (env) => {
    const charged = isObject(env.usage.charged) ? env.usage.charged : {};
    const prev = Number(charged[jobId]) || 0;
    if (prev === total && jobId in charged) return false;
    env.usage.usd = roundUsd((Number(env.usage.usd) || 0) + total - prev);
    env.usage.charged = { ...charged, [jobId]: total };
    return true;
  });
}

// A charge interrupted after its write-ahead: finish the envelope side and
// say so; the budget side is not replayed (see the header).
function settlePendingCharge(caseId, caseDir, job, after) {
  const p = job.pendingCharge;
  if (!p) return;
  envelopeCharge(caseDir, job.envelopeId, job.id, roundUsd(job.chargedUsd));
  const text = `The charge of ${money(p.usd)} for ${job.id} on ${job.executor} was interrupted. `
    + 'Its envelope usage is complete; the case budget may not include it (it is not re-applied, so it is never counted twice).';
  log.warn(`Case ${caseId}: ${text}`);
  after.journal.push(text);
  job.pendingCharge = null;
}

// The one charging point for executor cost: charge the difference from what
// was already charged, and count it against the envelope. Never negative.
function chargeTo(reg, caseId, caseDir, job, costUsd, after) {
  const total = Math.max(roundUsd(costUsd), roundUsd(job.chargedUsd));
  const delta = roundUsd(total - (Number(job.chargedUsd) || 0));
  if (!(delta > 0)) return;
  const prev = { chargedUsd: job.chargedUsd, pendingCharge: job.pendingCharge };
  job.chargedUsd = total;
  job.pendingCharge = { usd: delta, total, at: reg.now().toISOString() };
  try {
    writeAhead(new JobStore(caseDir), job, ['chargedUsd', 'costReported', 'pendingCharge']);
  } catch (err) {
    Object.assign(job, prev);
    throw err;
  }
  const r = reg.caseRuntime.budget(caseId).charge('usd', delta, { executor: job.executor, jobId: job.id });
  if (r && Array.isArray(r.crossedNow) && r.crossedNow.length) after.crossings.push(['usd', r.crossedNow]);
  envelopeCharge(caseDir, job.envelopeId, job.id, total);
  job.pendingCharge = null;
}

// Journals a reported cost below what was charged (not refunded) or above
// the maxCostUsd sent at submit (recorded in full), once per figure.
function noteReportedCost(caseId, job, cost, after) {
  const charged = roundUsd(job.chargedUsd);
  if (cost < charged && job.lowCostNoted !== cost) {
    job.lowCostNoted = cost;
    after.journal.push(`${job.executor} reported a cost of ${money(cost)} for ${job.id}, below the ${money(charged)} already charged. `
      + `The charge stays at ${money(charged)}: a charge is never refunded.`);
  }
  const max = job.maxCostUsd;
  if (typeof max === 'number' && Number.isFinite(max) && cost > max && job.overCostNoted !== cost) {
    job.overCostNoted = cost;
    const text = `${job.executor} reported a cost of ${money(cost)} for ${job.id}, above the ${money(max)} maximum sent at submit. `
      + 'The full cost is recorded.';
    log.warn(`Case ${caseId}: ${text}`);
    after.journal.push(text);
  }
}

// Settles a job that has just become terminal. Callers save the job after
// it; pass `after` (newAfter()) to run crossings and journal lines after
// that save. Without it they run at the end of this call.
function finishJob(reg, caseId, caseDir, job, after = null) {
  const sink = after || newAfter();
  settlePendingCharge(caseId, caseDir, job, sink);
  if (job.submittedAt && !job.costReported && (Number(job.estimateUsd) || 0) > (Number(job.chargedUsd) || 0)) {
    chargeTo(reg, caseId, caseDir, job, job.estimateUsd, sink);
  }
  if (job.wakeupId) {
    try {
      reg.caseRuntime.wakeups(caseId).cancel(job.wakeupId);
    } catch (err) {
      log.warn(`Cancelling the poll for ${job.id} failed: ${err.message}`);
    }
    job.wakeupId = null;
  }
  if (job.planStepId) {
    const done = job.state === 'done';
    new PlanStore(caseDir).updateStep(job.planStepId, done
      ? { state: 'done' }
      : { state: 'failed', reason: job.state === 'cancelled' ? 'cancelled' : (job.reason || job.state) });
  }
  if (!after) flushAfter(reg, caseId, sink);
}

// Throws (before any side effect) when the status cannot be applied.
function applyStatus(reg, caseId, caseDir, job, status, now, after = null) {
  const problem = statusProblem(status);
  if (problem) throw new Error(problem);
  const sink = after || newAfter();
  settlePendingCharge(caseId, caseDir, job, sink);
  const before = job.state;
  // Charges first, while the job still has its old state (a write-ahead
  // never persists a transition that finishJob has not settled yet).
  if (typeof status.costUsd === 'number') {
    job.costReported = true;
    const cost = roundUsd(status.costUsd);
    noteReportedCost(caseId, job, cost, sink);
    chargeTo(reg, caseId, caseDir, job, cost, sink);
  }
  if (status.resultFactId !== undefined) job.resultFactId = status.resultFactId;
  if (status.state !== before && !isTerminal(before)) {
    job.state = status.state;
    job.lastChange = isoOr(status.lastChange, now);
  } else if (status.lastChange) {
    const reported = isoOr(status.lastChange, now);
    if (reported > String(job.lastChange || '')) job.lastChange = reported;
  }
  if (Array.isArray(status.contacts)) job.contacts = mergeContacts(job.contacts, status.contacts);
  if (isTerminal(job.state) && !isTerminal(before)) finishJob(reg, caseId, caseDir, job, sink);
  if (!after) flushAfter(reg, caseId, sink);
}

async function statusFromSource(reg, caseId, job) {
  if (job.kind === 'external') {
    // commitSubmit refuses an external job without one; an open job that
    // still lacks it can never settle, so it is a poll error (then unreachable).
    if (!validExternalId(job.externalId)) throw new Error('the job has no external id to poll (the executor never returned one)');
    const adapter = await reg.adapter(job.executor);
    return adapter.status(job.externalId);
  }
  if (job.kind === 'workflow' || job.kind === 'runbook') {
    const st = readRunStatus(reg, caseId, job.id);
    return st ? { state: st.state, lastChange: st.finishedAt || st.startedAt || null } : null;
  }
  if (job.kind === 'owner') {
    const q = job.questionId ? reg.caseRuntime.questions(caseId).get(job.questionId) : null;
    if (!q) return null;
    if (q.answer) return { state: 'done', lastChange: q.answer.at, resultFactId: q.answer.factId || null };
    if (q.closed) return { state: 'cancelled', lastChange: q.closed.at };
  }
  return null;
}

// Returns the saved job, or null when it was settled elsewhere meanwhile.
async function pollJob(reg, caseId, caseDir, store, listed, settings, now) {
  const entry = reg.get(listed.executor, { caseId });
  const every = Math.max(MIN_POLL_MS, Number(entry?.pollEveryMs) || settings.pollEveryMs);
  let status = null;
  let failure = null;
  try {
    status = await statusFromSource(reg, caseId, listed);
    const problem = status === null || status === undefined ? null : statusProblem(status);
    if (problem) throw new Error(problem);
  } catch (err) {
    failure = err;
  }
  // Re-read after the await: a cancel may have landed while the poll was out.
  const job = store.get(listed.id);
  if (!isObject(job) || !isOpen(job.state) || job.state === 'submitting') return null;
  const after = newAfter();
  settlePendingCharge(caseId, caseDir, job, after);
  if (!failure) {
    job.lastPolledAt = now.toISOString();
    job.pollErrors = 0;
    job.stale = false;
    job.error = null;
    job.nextPollAt = new Date(now.getTime() + every).toISOString();
    if (status) applyStatus(reg, caseId, caseDir, job, status, now, after);
  } else {
    const message = clip(failure.message);
    job.pollErrors = (Number(job.pollErrors) || 0) + 1;
    job.error = message;
    if (job.pollErrors >= settings.maxPollErrors) {
      // Unreachable is material; stale is cleared so C2's trigger compares it.
      job.state = 'unreachable';
      job.stale = false;
      job.nextPollAt = null;
      job.lastChange = now.toISOString();
      job.reason = clip(`unreachable after ${job.pollErrors} failed polls: ${message}`);
      finishJob(reg, caseId, caseDir, job, after);
      after.journal.push(`Job ${job.id} on ${job.executor} is unreachable after ${job.pollErrors} failed polls: ${message}`);
    } else {
      job.stale = true;
      job.nextPollAt = new Date(now.getTime() + Math.min(every * 2 ** job.pollErrors, SIX_HOURS_MS)).toISOString();
    }
  }
  const saved = saveJob(store, job);
  flushAfter(reg, caseId, after);
  return saved ? job : null;
}

// Program §4.7. stale, fetchedAt, error and state are never material.
function buildSnapshot(reg, caseId, allJobs, before) {
  const next = {};
  for (const [id, e] of Object.entries(before || {})) if (e && e.override) next[id] = { override: e.override };
  const byExecutor = new Map();
  for (const j of allJobs) {
    if (!byExecutor.has(j.executor)) byExecutor.set(j.executor, []);
    byExecutor.get(j.executor).push(j);
  }
  for (const [id, list] of byExecutor) {
    if (list.every((j) => j.kind === 'direct')) continue;
    const open = list.filter((j) => isOpen(j.state));
    const lastChange = list.map((j) => j.lastChange).filter(Boolean).sort().pop() || null;
    const kind = list[0].kind;
    const material = kind === 'owner'
      ? { openTasks: open.length, lastChange }
      : {
        openJobs: open.length,
        lastChange,
        failedJobs: list.filter((j) => j.state === 'failed').length,
        unreachableJobs: list.filter((j) => j.state === 'unreachable').length
      };
    const staleJob = open.find((j) => j.stale);
    next[id] = {
      ...(next[id] || {}),
      fetchedAt: list.map((j) => j.lastPolledAt).filter(Boolean).sort().pop() || null,
      stale: Boolean(staleJob),
      error: staleJob ? clip(staleJob.error) : null,
      state: { jobs: Object.fromEntries(list.map((j) => [j.id, { externalId: j.externalId ? clip(j.externalId) : null, state: j.state }])) },
      material
    };
  }
  return next;
}

function materialChanged(before, next) {
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(next || {})]);
  for (const id of ids) {
    if (JSON.stringify(before?.[id]?.material ?? {}) !== JSON.stringify(next?.[id]?.material ?? {})) return true;
  }
  return false;
}

async function indexQuietly(reg, caseId, job) {
  try {
    await reg.indexJob(caseId, job);
  } catch (err) {
    log.warn(`Case ${caseId}: indexing ${job.id} failed: ${err.message}`);
  }
}

// Spec §3.12: a throw never leaves the refresh. A failed job poll, index
// write or snapshot is logged; a failed snapshot reports no material change.
async function refreshCase(reg, caseId, { force = false, budgetMs = null, jobIds = null } = {}) {
  return reg.caseRuntime.systemAction(caseId, 'executor refresh', async (meta) => {
    const caseDir = meta.dir;
    const store = new JobStore(caseDir);
    const settings = reg.settings();
    const now = reg.now();
    const limit = Number.isFinite(budgetMs) ? budgetMs : settings.refreshBudgetMs;
    const started = Date.now();
    const open = store.list()
      .filter((j) => isOpen(j.state) && j.state !== 'submitting' && (!jobIds || jobIds.includes(j.id)))
      .sort((a, b) => String(a.lastPolledAt || '').localeCompare(String(b.lastPolledAt || '')));
    for (const listed of open) {
      if (Date.now() - started > limit) break;
      if (!force && listed.nextPollAt && Date.parse(listed.nextPollAt) - now.getTime() > GRACE_MS) continue;
      let job;
      try {
        job = await pollJob(reg, caseId, caseDir, store, listed, settings, now);
      } catch (err) {
        // Applying failed part way (a disk error): nothing past the
        // write-ahead was saved; the next poll picks it up again.
        log.warn(`Case ${caseId}: applying the poll of ${listed.id} failed: ${err.message}`);
        continue;
      }
      if (job) await indexQuietly(reg, caseId, job);
    }
    try {
      const before = readSnapshot(caseDir);
      const next = buildSnapshot(reg, caseId, store.list(), before);
      const material = materialChanged(before, next);
      writeSnapshot(caseDir, next);
      return { material, snapshot: next };
    } catch (err) {
      log.warn(`Case ${caseId}: writing the executor snapshot failed: ${err.message}`);
      return { material: false, snapshot: null };
    }
  });
}

// R48: C2's sweep calls this for a due poll-executor wake-up, with no model.
async function pollWakeup(reg, caseId, wakeup) {
  const jobId = wakeup?.payload?.jobId || null;
  const r = await refreshCase(reg, caseId, { jobIds: jobId ? [jobId] : null });
  return { material: Boolean(r.material) };
}

// Releases a submitting job's reservation after the job is saved without
// it (a crash in between leaks the reservation, never releases it twice).
function takeReservation(job) {
  const n = job.state === 'submitting' ? Number(job.reservedContacts) || 0 : 0;
  if (n > 0) job.reservedContacts = 0;
  return n;
}

// A submit whose answer cannot be committed: the job fails, nothing is
// charged, and the executor is asked to drop the job it accepted.
// `keepReservation`: the contacts may already have been reached (a browser
// form clicked before the failure), so the daily-cap reservation stays used.
async function failSubmit(reg, caseId, job, submitted = {}, reason = 'failed', { keepReservation = false } = {}) {
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  if (validExternalId(submitted?.jobId)) job.externalId = submitted.jobId;
  let note = null;
  if (job.kind === 'external' && validExternalId(job.externalId)) {
    try {
      await (await reg.adapter(job.executor)).cancel(job.externalId);
    } catch (err) {
      note = clip(`the executor did not confirm the cancel of ${job.externalId}: ${err.message}`);
    }
  }
  const fresh = store.get(job.id);
  if (isObject(fresh) && isTerminal(fresh.state)) return fresh;
  job.reservedContacts = isObject(fresh) ? fresh.reservedContacts : job.reservedContacts;
  // Released only while the job on disk is still `submitting`: a committed
  // job keeps its reservation (contacts may already have been reached).
  const release = !keepReservation && (!isObject(fresh) || fresh.state === 'submitting') ? takeReservation(job) : 0;
  job.state = 'failed';
  job.reason = clip(reason);
  job.lastChange = reg.now().toISOString();
  const after = newAfter();
  finishJob(reg, caseId, caseDir, job, after);
  saveJob(store, job);
  if (release) await reg.releaseContacts(job.executor, release, { caseId });
  after.journal.push(`Job ${job.id} on ${job.executor} failed at submit: ${job.reason}${note ? ` (${note})` : ''}.`);
  flushAfter(reg, caseId, after);
  await indexQuietly(reg, caseId, job);
  return job;
}

// Idempotent: a commit interrupted part way (the job still `submitting`,
// its externalId and contactsCharged written ahead) is finished by
// reconcileSubmitting without recording the payload or charging contacts
// twice.
async function commitSubmit(reg, caseId, job, submitted = {}) {
  submitted = isObject(submitted) ? submitted : {};
  const problem = stateProblem(submitted.state, { optional: true });
  if (problem) return failSubmit(reg, caseId, job, submitted, problem);
  // An external job the node cannot poll would stay open forever.
  if (job.kind === 'external' && !validExternalId(submitted.jobId)) {
    return failSubmit(reg, caseId, job, submitted, 'the executor returned no job id');
  }
  const rt = reg.caseRuntime;
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const now = reg.now();
  const entry = reg.get(job.executor, { caseId });
  const after = newAfter();
  job.externalId = submitted.jobId ?? job.externalId ?? null;
  if (Array.isArray(submitted.contacts)) job.contacts = mergeContacts(job.contacts, submitted.contacts);
  job.submittedAt = job.submittedAt || now.toISOString();
  const contactsCharged = job.contactsCharged === true;
  job.contactsCharged = true;
  try {
    writeAhead(store, job, ['externalId', 'contacts', 'submittedAt', 'contactsCharged']);
  } catch (err) {
    if (!isJobStateError(err)) throw err;
    // Cancelled while the executor had it: nothing is committed or charged.
    log.warn(`Not committing ${job.id}: ${err.message}`);
    if (job.kind === 'external' && validExternalId(job.externalId)) {
      try {
        await (await reg.adapter(job.executor)).cancel(job.externalId);
      } catch (e) {
        log.warn(`Cancelling ${job.externalId} after a late commit failed: ${e.message}`);
      }
    }
    return store.get(job.id);
  }
  job.state = submitted.state || 'submitted';
  job.lastChange = job.submittedAt;
  updateEnvelope(caseDir, job.envelopeId, (env) => {
    const payloads = Array.isArray(env.payloads) ? env.payloads : [];
    if (payloads.some((p) => p && p.jobId === job.id)) return false;
    env.payloads = [...payloads, {
      n: job.n, at: job.submittedAt, jobId: job.id, payload: job.originalPayload, rendered: job.payload, hash: job.payloadHash, estimateUsd: job.estimateUsd
    }];
    const attempts = Number(job.originalPayload?.attemptsPerContact) || 1;
    for (const r of job.recipients || []) {
      if (!env.usage.contacts.includes(r)) env.usage.contacts.push(r);
      env.usage.attempts = { ...(env.usage.attempts || {}), [r]: (Number(env.usage.attempts?.[r]) || 0) + attempts };
    }
    return true;
  });
  if (!contactsCharged && job.newContacts > 0) {
    const r = rt.budget(caseId).charge('contactsPerDay', job.newContacts, { executor: job.executor, jobId: job.id });
    if (r && Array.isArray(r.crossedNow) && r.crossedNow.length) after.crossings.push(['contactsPerDay', r.crossedNow]);
  }
  if (entry && entry.latency !== 'interactive' && isOpen(job.state)) {
    const every = Math.max(MIN_POLL_MS, Number(entry.pollEveryMs) || reg.settings().pollEveryMs);
    job.wakeupId = rt.wakeups(caseId).ensure('poll-executor', { every, payload: { key: `poll:${job.id}`, executor: job.executor, jobId: job.id } });
    job.nextPollAt = new Date(now.getTime() + every).toISOString();
  }
  if (job.planStepId) new PlanStore(caseDir).updateStep(job.planStepId, { state: 'in-flight', addJob: job.id });
  if (isTerminal(job.state)) finishJob(reg, caseId, caseDir, job, after);
  saveJob(store, job);
  after.journal.unshift([
    `Job ${job.id} submitted to ${job.executor}${job.envelopeId ? ` under ${job.envelopeId}` : ''}${job.externalId ? ` (external id ${clip(job.externalId)})` : ''}.`,
    '',
    'Payload as sent:',
    '',
    '```json',
    JSON.stringify(job.payload, null, 2),
    '```'
  ].join('\n'));
  flushAfter(reg, caseId, after);
  await indexQuietly(reg, caseId, job);
  return job;
}

async function cancelJob(reg, caseId, jobId, reason = 'cancelled') {
  const rt = reg.caseRuntime;
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const listed = store.get(jobId);
  if (!listed) return { ok: false, error: `${jobId} was not found in this case.` };
  if (!isOpen(listed.state)) return { ok: false, error: `${jobId} is already ${listed.state}.` };
  let note = null;
  try {
    if (listed.kind === 'external' && validExternalId(listed.externalId)) {
      await (await reg.adapter(listed.executor)).cancel(listed.externalId);
    } else if (listed.kind === 'workflow' && listed.externalId) {
      const engine = reg.getWorkflowEngine();
      if (engine) engine.cancel(listed.externalId);
    } else if (listed.kind === 'runbook') {
      const run = reg.running.get(runKey(caseId, jobId));
      if (run) {
        if (!run.started) {
          const engine = reg.getRunbookEngine();
          if (engine && run.stamp !== undefined) engine.releaseExecution(run.name, run.stamp);
        }
        run.controller.abort();
        reg.running.delete(runKey(caseId, jobId));
      }
    } else if (listed.kind === 'owner' && listed.questionId) {
      rt.questions(caseId).close(listed.questionId, { reason, by: 'system' });
    }
  } catch (err) {
    note = clip(`the executor did not confirm the cancel: ${err.message}`);
  }
  // Re-read after the executor call: a poll may have settled it meanwhile.
  const job = store.get(jobId);
  if (!isObject(job) || !isOpen(job.state)) return { ok: false, error: `${jobId} is already ${job?.state}.` };
  const release = takeReservation(job);
  const after = newAfter();
  job.state = 'cancelled';
  job.reason = reason;
  job.lastChange = reg.now().toISOString();
  finishJob(reg, caseId, caseDir, job, after);
  saveJob(store, job);
  if (release) await reg.releaseContacts(job.executor, release, { caseId });
  after.journal.push(`Job ${job.id} on ${job.executor} cancelled: ${reason}${note ? ` (${note})` : ''}.`);
  flushAfter(reg, caseId, after);
  await indexQuietly(reg, caseId, job);
  return { ok: true, job, ...(note ? { note } : {}) };
}

// C2's _cancelExecutorJobs fires this without awaiting it, after setStatus
// has released the case lock, so it can interleave with a refresh or another
// cancel. What keeps that safe is the invariant in the header: each
// re-read-to-save section (cancelJob after its executor call, pollJob after
// its status fetch) has no await inside it.
async function cancelOpenJobs(reg, caseId, reason) {
  const cancelled = [];
  for (const job of reg.jobs(caseId).list().filter((j) => isOpen(j.state))) {
    const r = await cancelJob(reg, caseId, job.id, reason || 'cancelled');
    if (r.ok) cancelled.push(job.id);
  }
  return { cancelled };
}

async function cancelJobAsOwner(reg, caseId, jobId, reason = 'cancelled by the owner') {
  try {
    return await reg.caseRuntime.systemAction(caseId, `cancel ${jobId}`, () => cancelJob(reg, caseId, jobId, reason));
  } catch (err) {
    if (err && err.name === 'CaseBusyError') return { ok: false, error: BUSY };
    throw err;
  }
}

// A job still `submitting` at a turn start was interrupted: ask the executor
// whether it has it (GET /jobs?externalRef=), else fail it. A job whose
// externalId was already written ahead by commitSubmit is known accepted.
async function reconcileSubmitting(reg, caseId) {
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const out = [];
  for (const job of store.list().filter((j) => j.state === 'submitting')) {
    if (reg.inFlight.has(runKey(caseId, job.id))) continue;
    let found = null;
    if (job.kind === 'external') {
      if (validExternalId(job.externalId)) {
        found = { jobId: job.externalId };
      } else {
        try {
          const adapter = await reg.adapter(job.executor);
          if (typeof adapter.findByExternalRef === 'function') found = await adapter.findByExternalRef(`${caseId}/${job.id}`);
        } catch (err) {
          log.warn(`Reconciling ${job.id} failed; trying again next turn: ${err.message}`);
          continue;
        }
      }
    }
    if (found) {
      const committed = await commitSubmit(reg, caseId, job, found);
      out.push({ jobId: job.id, state: committed?.state === 'failed' ? 'failed' : 'submitted' });
      continue;
    }
    const fresh = store.get(job.id);
    if (!isObject(fresh) || fresh.state !== 'submitting') continue;
    const release = takeReservation(fresh);
    fresh.state = 'failed';
    fresh.reason = 'interrupted';
    fresh.lastChange = reg.now().toISOString();
    const after = newAfter();
    finishJob(reg, caseId, caseDir, fresh, after);
    saveJob(store, fresh);
    if (release) await reg.releaseContacts(fresh.executor, release, { caseId });
    flushAfter(reg, caseId, after);
    await indexQuietly(reg, caseId, fresh);
    out.push({ jobId: fresh.id, state: 'failed' });
  }
  return out;
}

// Background runs write only under <dataDir>/executors/runs/; the case copy
// happens here, under the case lock (R37). `copied` is saved on its own right
// after the copy, before the state is applied, so a failure later never
// copies the output again; refreshCase settles the state from status.json.
async function copyBackgroundOutput(reg, caseId) {
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const copied = [];
  for (const listed of store.list()) {
    if ((listed.kind !== 'workflow' && listed.kind !== 'runbook') || listed.copied) continue;
    try {
      const st = readRunStatus(reg, caseId, listed.id);
      if (!isObject(st)) continue;
      if (!ADAPTER_STATES.includes(st.state)) {
        log.warn(`Case ${caseId}: ${listed.id} has an unknown run state ${clip(JSON.stringify(st.state ?? null))}; not copying`);
        continue;
      }
      if (!isTerminal(st.state)) continue;
      const from = runDir(reg, caseId, listed.id);
      const to = path.join(caseDir, 'sources', listed.executor, listed.id);
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (name === 'status.json') continue;
        fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
      }
      // Re-read: the loop has awaited since the list was read.
      const job = store.get(listed.id);
      if (!isObject(job) || job.copied) continue;
      job.copied = true;
      store.write(job);
      copied.push(job.id);
      if (isOpen(job.state)) {
        const after = newAfter();
        applyStatus(reg, caseId, caseDir, job, { state: st.state, lastChange: st.finishedAt || null }, reg.now(), after);
        saveJob(store, job);
        flushAfter(reg, caseId, after);
      }
      await indexQuietly(reg, caseId, job);
    } catch (err) {
      log.warn(`Case ${caseId}: copying the output of ${listed.id} failed: ${err.message}`);
    }
  }
  return copied;
}

module.exports = {
  BUSY,
  ADAPTER_STATES,
  kindOf,
  runDir,
  readRunStatus,
  writeRunStatus,
  mergeContacts,
  capContacts,
  updateEnvelope,
  applyStatus,
  finishJob,
  commitSubmit,
  failSubmit,
  refreshCase,
  pollWakeup,
  cancelJob,
  cancelOpenJobs,
  cancelJobAsOwner,
  reconcileSubmitting,
  copyBackgroundOutput
};
