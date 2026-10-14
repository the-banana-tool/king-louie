// src/cases/verify/hook.js
// Cases stage 8 (spec §6.3): two moments when the computed states of a
// case's criteria are compared or kept.
//
// - The `verification` turn-start hook compares each confirmed criterion's
//   state, computed now, with the cache of the last time it was written. A
//   criterion that was `met` and is now `stale` or `failing` raises a
//   blocking trigger, so the turn re-orients before it recommends, decides
//   or fails. `cache.states` is only ever a "what it was last time"; no
//   reader takes it as a state.
// - `freezeProgress` writes the progress a case closes with. Every later
//   read of the closed case returns that record as it is (R-C8-7).
const { plainLineProblem } = require('../hidden-chars');
const { statesOf } = require('./evidence');

const HOOK_NAME = 'verification';
const TRIGGER_KIND = 'criterion-regressed';
const TEXT_CHARS = 80;
const HIDDEN = '(text hidden: not one plain line)';
const REGRESSED = Object.freeze(['stale', 'failing']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isClosed = (status) => status === 'done' || status === 'abandoned';

// A criterion's text in a trigger: one plain line, cut and quoted.
function shownText(text) {
  if (typeof text !== 'string' || plainLineProblem(text)) return HIDDEN;
  return `"${Array.from(text).slice(0, TEXT_CHARS).join('').trimEnd()}"`;
}

// → { notes, triggers } for one turn start. Runs under the turn's lock,
// after the case-type refresh. A throw is caught by the runtime's hook
// runner like any hook's.
function verificationTurnStart(runtime, { caseId, meta }) {
  if (isClosed(meta?.status)) return { notes: [], triggers: [] };
  const store = runtime.verification(caseId);
  const file = store.read();
  const view = runtime.progressView(caseId, { file });
  const was = isObject(file.cache) && isObject(file.cache.states) ? file.cache.states : {};
  const notes = [];
  const triggers = [];
  for (const row of view.criteria) {
    if (row.scope !== 'confirmed' || was[row.id] !== 'met' || !REGRESSED.includes(row.state)) continue;
    // Reasons are ids and fixed words (verify/status.js, verify/evidence.js).
    const why = Array.isArray(row.reasons) && row.reasons.length ? row.reasons.join('; ') : 'its evidence no longer holds';
    notes.push(`${row.id} was met and is now ${row.state}: ${why}.`);
    triggers.push({
      kind: TRIGGER_KIND,
      key: `criterion:${row.id}:${row.recordId || 'none'}:${row.state}`,
      blocking: true,
      detail: `${row.id} (${shownText(row.text)}) was met and is now ${row.state}: ${why}.`
    });
  }
  store.setCache(statesOf(view));
  return { notes, triggers };
}

function registerVerificationHook(runtime) {
  runtime.addTurnStartHook(HOOK_NAME, (ctx) => verificationTurnStart(runtime, ctx));
}

// `progress` is runtime.progress(id) as it read before the status changed.
// → the frozen record.
function freezeProgress(runtime, id, { status, progress }) {
  if (!isObject(progress) || !isObject(progress.view)) throw new Error('freezeProgress needs the progress the case closes with.');
  return runtime.verification(id).freeze({
    at: runtime.now().toISOString(),
    status,
    summary: typeof progress.summary === 'string' ? progress.summary : null,
    criteria: Array.isArray(progress.view.criteria) ? progress.view.criteria : [],
    readiness: isObject(progress.readiness) ? progress.readiness : null
  });
}

module.exports = { registerVerificationHook, verificationTurnStart, freezeProgress, TRIGGER_KIND };
