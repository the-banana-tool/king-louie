// src/cases/detours/hooks.js
// The two turn hooks cases stage 5 registers with the runtime (spec §3.6,
// program §4.20, R33). Phase 1 runs inside beginTurn before triggers and
// orientation: reconcile routing answers, release held proposals, refresh
// the case type's live state and raise the case-type trigger. Phase 2 runs
// after UserPromptSubmit passes: classify the owner's message, propose a
// detour, and for software-repo check the work already in flight.
//
// Neither hook may abort the owner's turn: every step is guarded, a failed
// step logs and the next one still runs. The case id always comes from the
// runtime's hook context, never from model or tool input.
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJsonIfChanged } = require('../jsonfile');
const { resolveCaseType } = require('../case-types');
const { createLogger } = require('../../logging');

const log = createLogger('cases/detours/hooks');

const snapshotFile = (meta) => path.join(meta.dir, '.kl', 'case-type.json');
const show = (v) => (v === null || v === undefined ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v));
const shortHash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 8);
const sameState = (a, b) => JSON.stringify([a?.state || null, a?.notes || []]) === JSON.stringify([b?.state || null, b?.notes || []]);

// Runs one hook step; a throw logs and yields `fallback`.
async function guarded(what, meta, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    log.warn(`Detour hook step "${what}" failed on case ${meta?.slug || meta?.id || '?'}: ${err && err.message ? err.message : String(err)}`);
    return fallback;
  }
}

function snapshots(runtime) {
  if (!(runtime._typeSnapshots instanceof Map)) runtime._typeSnapshots = new Map();
  return runtime._typeSnapshots;
}

// Refresh within cases.softwareRepo.refreshBudgetMs. On overrun the cached
// snapshot is used, marked stale, and the refresh finishes into memory; the
// next turn writes it under its lock.
async function refreshCaseType(runtime, meta) {
  const type = resolveCaseType(meta.type);
  if (typeof type.refresh !== 'function') return;
  const memory = snapshots(runtime);
  const pending = memory.get(meta.id);
  const disk = readJson(snapshotFile(meta), null);
  if (pending && !pending.stale && (!disk || String(pending.fetchedAt) > String(disk.fetchedAt))) {
    writeJsonIfChanged(snapshotFile(meta), pending);
  }
  const previous = runtime.caseTypeSnapshot(meta.id);
  let brief = {};
  try {
    brief = runtime.brief(meta.id).read().data || {};
  } catch {
    brief = {};
  }
  const budgetMs = runtime.settings().softwareRepo.refreshBudgetMs;
  const job = Promise.resolve()
    .then(() => type.refresh({ runtime, id: meta.id, brief, exec: runtime.host?.exec, now: runtime.now(), previous }))
    .then((snap) => ({ snap }), (err) => ({ err }));
  // Ref'd on purpose and always cleared below: an awaited unref'd timer gets
  // the test cancelled on Node 22 (controller ruling M8).
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), budgetMs);
  });
  const first = await Promise.race([job, late]);
  clearTimeout(timer);
  if (first.late) {
    if (previous) memory.set(meta.id, { ...previous, stale: true });
    job.then((r) => {
      if (r.snap) memory.set(meta.id, r.snap);
      else if (r.err) log.warn(`Refreshing the ${type.type} state of ${meta.slug} failed after the budget: ${r.err.message}`);
    });
    return;
  }
  if (first.err) {
    log.warn(`Refreshing the ${type.type} state of ${meta.slug} failed: ${first.err.message}`);
    return;
  }
  const snap = first.snap;
  memory.set(meta.id, snap);
  // Unchanged state keeps the file (and the case's git tree) as it was.
  if (disk && !disk.stale && sameState(disk, snap)) return;
  writeJsonIfChanged(snapshotFile(meta), snap);
}

// A material field that differs from C2's baseline (.kl/triggers.json
// caseTypeMaterial). The key carries the new value, so a later change fires
// again even after this one was acknowledged.
function caseTypeTriggers(runtime, meta) {
  const material = runtime.caseTypeMaterial(meta.id);
  if (!material) return [];
  const baseline = readJson(path.join(meta.dir, '.kl', 'triggers.json'), null)?.caseTypeMaterial;
  if (!baseline || typeof baseline !== 'object') return [];
  const out = [];
  for (const [field, value] of Object.entries(material)) {
    if (value === null || value === undefined) continue;
    const old = baseline[field] ?? null;
    if (old === null || JSON.stringify(old) === JSON.stringify(value)) continue;
    out.push({
      kind: 'case-type-change',
      detail: `${field} changed: ${show(old)} → ${show(value)}`,
      blocking: true,
      key: `case-type:${field}:${shortHash(value)}`
    });
  }
  return out;
}

async function turnStart(runtime, { caseId }) {
  const meta = runtime.getCase(caseId);
  const out = await guarded('reconcile', meta, () => runtime.detours.reconcile(meta.id), null);
  if (out?.busy) log.warn(`Detour reconcile skipped on ${meta.slug}: busy`);
  if (out?.error) log.warn(`Detour reconcile failed on ${meta.slug}: ${out.error}`);
  await guarded('release held', meta, () => runtime.detours.releaseHeld(meta.id), []);
  await guarded('case-type refresh', meta, () => refreshCaseType(runtime, meta), null);
  const triggers = await guarded('case-type trigger', meta, () => caseTypeTriggers(runtime, runtime.getCase(meta.id)), []);
  return { triggers };
}

// "attach to "<title>" (<status>) / new case / drop": other cases' titles
// and statuses only, as the routing question's option labels carry them.
function optionsText(detour) {
  const parts = (Array.isArray(detour?.options) ? detour.options : [])
    .filter((o) => o.optionId !== 'decline')
    .map((o) => (o.optionId === 'new' ? 'new case' : o.label.replace(/^Attach to /, 'attach to ')));
  return [...parts, 'drop'].join(' / ');
}

async function ownerMessage(runtime, { caseId, ownerMessage: message, source }) {
  if (source !== 'owner' || typeof message !== 'string' || !message.trim()) return {};
  const meta = runtime.getCase(caseId);
  const turn = runtime.turns.get(meta.id) || null;
  const notes = [];
  // A throw here is a failed classification: on-case, like the classifier's own failures.
  const verdict = await guarded('classify', meta, () => runtime.classifier.classify(meta.id, { source: 'owner-message', text: message, turn }), null);
  if (verdict?.detour) {
    const reason = String(verdict.reason || '').replace(/[.\s]+$/, '');
    const proposed = await guarded('propose', meta, () => runtime.detours.propose(meta.id, {
      summary: message.slice(0, 300), reason, source: 'owner-message', turn
    }), { ok: false, error: 'the router failed; see the log.' });
    if (proposed?.ok) {
      notes.push(`Detour check: the owner's message asks for work outside this case's objective (${reason}). Do that part in this case only if the owner insists. Routing proposal ${proposed.questionId || proposed.detour.id} (${optionsText(proposed.detour)}) is waiting. Say so in one line, then continue with the on-case part.`);
    } else {
      log.warn(`Detour proposal from the owner's message failed on ${meta.slug}: ${proposed?.error}`);
      notes.push(`Detour check: the owner's message asks for work outside this case's objective (${reason}), and routing it failed: ${proposed?.error}`);
    }
  }
  const type = resolveCaseType(meta.type);
  if (typeof type.checkBeforeWriteFor === 'function') {
    // A missing or stale snapshot comes back as a caveat, never as "clear".
    const note = await guarded('check before write', meta, () => type.checkBeforeWriteFor(runtime, meta.id, message), null);
    if (note) notes.push(note);
  }
  return { notes };
}

function registerDetourHooks(runtime) {
  runtime.addTurnStartHook('detours', (ctx) => turnStart(runtime, ctx));
  runtime.addTurnStartHook('detours:classify', (ctx) => ownerMessage(runtime, ctx), { phase: 'owner-message' });
}

module.exports = { registerDetourHooks, refreshCaseType, caseTypeTriggers };
