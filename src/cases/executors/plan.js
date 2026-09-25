// src/cases/executors/plan.js
// Executor-first planning (cases stage 3 spec §3.4): every plan step names
// an executor and code checks it. A step the executor cannot do moves to one
// that can; no step lands on the owner without the owner's answer (R41).
const fs = require('fs');
const path = require('path');
const {
  readJsonSafe, writeJsonAtomic, localDate, countDays, roundUsd, DAY_PATTERN, EXECUTOR_ID_PATTERN, money
} = require('./util');

const STEP_UNITS = Object.freeze(['items', 'contacts', 'forms', 'pages']);
const STEP_STATES = Object.freeze(['pending', 'in-flight', 'done', 'failed', 'cancelled']);
const PLAN_STATUSES = Object.freeze(['proposed', 'approved', 'rejected', 'superseded', 'done']);
const LATENCY_ORDER = Object.freeze(['interactive', 'async-minutes', 'async-hours', 'async-days']);
const STEP_FIELDS = new Set(['id', 'title', 'description', 'dependsOn', 'priority', 'estimatedComplexity', 'executor', 'capability', 'serves', 'quantity', 'unit']);
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PLAN_ID = /^plan-(\d{3,})$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function parseSteps(text) {
  let raw = text;
  if (typeof text === 'string') {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `"steps" is not valid JSON: ${err.message}` };
    }
  }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.steps)) raw = raw.steps;
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: '"steps" must be JSON text of a non-empty list of steps.' };
  const steps = [];
  const errors = [];
  raw.forEach((s, i) => {
    const label = s && typeof s.id === 'string' && s.id ? s.id : `#${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`step ${label} is not an object`);
      return;
    }
    for (const k of Object.keys(s)) if (!STEP_FIELDS.has(k)) errors.push(`step ${label} has unknown field "${k}"`);
    if (typeof s.id !== 'string' || !STEP_ID.test(s.id)) errors.push(`step ${label} needs an id of 1 to 40 letters, digits, - or _`);
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) errors.push(`step ${label} needs a title`);
    if (typeof s.executor !== 'string' || !EXECUTOR_ID_PATTERN.test(s.executor)) errors.push(`step ${label} needs an executor id`);
    if (typeof s.capability !== 'string' || !s.capability.trim()) errors.push(`step ${label} needs a capability`);
    const quantity = s.quantity === undefined ? 1 : s.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) errors.push(`step ${label}: quantity must be a whole number ≥ 1`);
    const unit = s.unit === undefined ? 'items' : s.unit;
    if (!STEP_UNITS.includes(unit)) errors.push(`step ${label}: unit must be one of ${STEP_UNITS.join(', ')}`);
    if (s.dependsOn !== undefined && (!Array.isArray(s.dependsOn) || !s.dependsOn.every((d) => typeof d === 'string'))) {
      errors.push(`step ${label}: dependsOn must be a list of step ids`);
    }
    steps.push({
      id: s.id,
      title,
      description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : title,
      dependsOn: Array.isArray(s.dependsOn) ? [...s.dependsOn] : [],
      priority: Number.isFinite(s.priority) ? s.priority : i + 1,
      estimatedComplexity: typeof s.estimatedComplexity === 'string' ? s.estimatedComplexity : 'medium',
      executor: s.executor,
      capability: typeof s.capability === 'string' ? s.capability.trim() : '',
      serves: typeof s.serves === 'string' ? s.serves.trim() : '',
      quantity,
      unit
    });
  });
  if (errors.length) return { ok: false, error: `Plan refused: ${errors.join('; ')}.` };
  return { ok: true, steps };
}

function stepsToTaskGraph(steps) {
  return {
    tasks: steps.map((s) => ({
      id: s.id, title: s.title, description: s.description, dependsOn: s.dependsOn,
      priority: s.priority, estimatedComplexity: s.estimatedComplexity, agentId: 'main'
    }))
  };
}

function capable(entry, capability) {
  return Boolean(entry)
    && entry.available !== false
    && (entry.capabilities || []).some((c) => c === capability || c === 'any')
    && !(entry.cannot || []).includes(capability);
}

// Consent (R41): an ownerLabor entry counts only when its fact is an active
// `user` fact written by answering a plan (approve) or owner-task question
// that names the capability.
function isConsentBacked(entry, facts, questions) {
  if (!entry || typeof entry !== 'object' || typeof entry.capability !== 'string') return false;
  const f = facts.get(entry.factId);
  if (!f || f.status !== 'active' || f.provenance !== 'user' || f.source?.kind !== 'question') return false;
  const q = (questions || []).find((x) => x.id === f.source.ref);
  if (!q || !q.answer || q.answer.factId !== f.id) return false;
  const p = q.payload || {};
  if (p.type === 'plan') {
    return q.answer.optionId === 'approve' && Array.isArray(p.consentCapabilities) && p.consentCapabilities.includes(entry.capability);
  }
  if (p.type === 'owner-task') return p.capability === entry.capability;
  return false;
}

function checkPlan({
  steps, entries, brief = {}, facts = new Map(), questions = [], budget = {}, globalRemaining = () => null,
  now = new Date(), tz = 'UTC', attemptsDefault = 2
}) {
  const byId = entries instanceof Map ? entries : new Map((entries || []).map((e) => [e.id, e]));
  const warnings = [];
  const labor = Array.isArray(brief?.resources?.ownerLabor) ? brief.resources.ownerLabor : [];
  labor.forEach((e, i) => {
    if (!isConsentBacked(e, facts, questions)) warnings.push(`ownerLabor entry ${i + 1} is not backed by an owner answer; ignored`);
  });
  const consentFor = (cap) => {
    const e = labor.find((x) => x && x.capability === cap && isConsentBacked(x, facts, questions));
    return e ? e.factId : null;
  };
  const listed = Array.isArray(brief?.resources?.executors) ? brief.resources.executors : [];
  const allowed = listed.length ? new Set(listed) : null;
  const deadline = (DAY_PATTERN.test(String(brief?.deadline || '')) ? brief.deadline : null) || budget.deadline || null;
  const today = localDate(now, tz);

  const feasibility = (entry, step) => {
    if (step.unit !== 'contacts' || !entry) return { ok: true, days: null };
    const limits = [entry.constraints?.contactsPerDay, budget.contactsPerDayLimit, globalRemaining(entry.id)]
      .filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (!limits.length || !deadline) return { ok: true, days: null };
    const perDay = Math.min(...limits);
    const weekdays = Array.isArray(entry.constraints?.callingWindow?.weekdays) ? entry.constraints.callingWindow.weekdays : ALL_WEEKDAYS;
    const available = countDays(today, deadline, weekdays);
    if (perDay <= 0) {
      return { ok: false, days: { needed: null, available }, reason: `no contacts left per day (0/day); ${available} available before ${deadline}` };
    }
    const needed = Math.ceil(step.quantity / perDay);
    if (needed > available) {
      return { ok: false, days: { needed, available }, reason: `needs ${needed} days at ${perDay}/day; ${available} available before ${deadline}` };
    }
    return { ok: true, days: { needed, available } };
  };
  const estimate = (entry, step) => {
    const c = entry?.cost || {};
    return roundUsd((Number(c.perJob) || 0) + step.quantity * ((Number(c.perContact) || 0) + (Number(c.perAttempt) || 0) * attemptsDefault));
  };
  const rank = (e) => {
    const i = LATENCY_ORDER.indexOf(e.latency);
    return i === -1 ? LATENCY_ORDER.length : i;
  };

  const checked = steps.map((step) => {
    const entry = byId.get(step.executor);
    const reasons = [];
    let consent = 'none';
    let ok = true;
    if (step.executor === 'owner') {
      const factId = consentFor(step.capability);
      if (factId) consent = `recorded:${factId}`;
      else {
        ok = false;
        consent = 'required';
        reasons.push(`owner has not consented to ${step.capability}`);
      }
    } else if (!capable(entry, step.capability)) {
      ok = false;
      if (!entry) reasons.push(`${step.executor} is not a known executor`);
      else if (entry.available === false) reasons.push(`${step.executor} is unavailable: ${entry.reason}`);
      else reasons.push(`${step.executor} cannot do ${step.capability}`);
    }
    if (ok) {
      const feas = feasibility(entry, step);
      if (!feas.ok) reasons.push(feas.reason);
      return {
        ...step, state: 'pending', jobIds: [],
        check: { status: feas.ok ? 'ok' : 'flagged', reasons, estimateUsd: estimate(entry, step), days: feas.days, consent }
      };
    }
    const pick = [...byId.values()]
      .filter((e) => e.id !== 'owner' && e.id !== step.executor && (!allowed || allowed.has(e.id))
        && capable(e, step.capability) && feasibility(e, step).ok)
      .sort((a, b) => estimate(a, step) - estimate(b, step) || rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
    if (pick) {
      return {
        ...step, executor: pick.id, state: 'pending', jobIds: [],
        check: { status: 'rewritten', from: step.executor, reasons, estimateUsd: estimate(pick, step), days: feasibility(pick, step).days, consent: 'none' }
      };
    }
    return {
      ...step, state: 'pending', jobIds: [],
      check: { status: step.executor === 'owner' ? 'needs-consent' : 'flagged', reasons, estimateUsd: estimate(entry, step), days: null, consent }
    };
  });
  const estimateUsd = roundUsd(checked.reduce((sum, s) => sum + s.check.estimateUsd, 0));
  if (typeof budget.remainingUsd === 'number' && Number.isFinite(budget.remainingUsd) && estimateUsd > budget.remainingUsd) {
    warnings.push(`estimate ${money(estimateUsd)} exceeds remaining ${money(budget.remainingUsd)}`);
  }
  const consentCapabilities = [...new Set(checked.filter((s) => s.check.status === 'needs-consent').map((s) => s.capability))];
  return { steps: checked, warnings, estimateUsd, consentCapabilities };
}

const cell = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function renderPlanCard(plan) {
  const rows = [
    `Plan ${plan.id}: ${plan.goal || plan.summary || ''}`.trim(),
    '',
    '| # | Step | Executor | Capability | Qty | Est. cost | Days (need/avail) | Consent | Check |',
    '|---|---|---|---|---|---|---|---|---|',
    ...(plan.steps || []).map((s) => {
      const days = s.check?.days ? `${s.check.days.needed ?? '—'}/${s.check.days.available}` : '—';
      return `| ${s.id} | ${cell(s.title)} | ${s.executor} | ${s.capability} | ${s.quantity} ${s.unit} | ${money(s.check?.estimateUsd)} | ${days} | ${s.check?.consent || 'none'} | ${s.check?.status || 'ok'} |`;
    }),
    `|  | **Total** |  |  |  | ${money(plan.estimateUsd)} |  |  |  |`
  ];
  const notes = [];
  for (const s of plan.steps || []) {
    const why = (s.check?.reasons || []).join('; ');
    if (s.check?.status === 'rewritten') notes.push(`- ${s.id} rewritten from ${s.check.from} to ${s.executor}: ${why}`);
    else if (s.check?.status === 'flagged') notes.push(`- ${s.id} flagged: ${why}`);
    else if (s.check?.status === 'needs-consent') notes.push(`- ${s.id} needs the owner's consent: ${why}`);
  }
  for (const w of plan.warnings || []) notes.push(`- Warning: ${w}`);
  return [...rows, ...(notes.length ? ['', ...notes] : [])].join('\n');
}

class PlanStore {
  constructor(caseDir) {
    this.file = path.join(caseDir, '.kl', 'plan.json');
    this.archiveDir = path.join(caseDir, '.kl', 'plans');
  }

  read() {
    return readJsonSafe(this.file, null);
  }

  write(plan) {
    writeJsonAtomic(this.file, plan);
    return plan;
  }

  archive(plan) {
    writeJsonAtomic(path.join(this.archiveDir, `${plan.id}.json`), plan);
  }

  nextId() {
    let max = 0;
    const current = this.read();
    const m = current && PLAN_ID.exec(String(current.id));
    if (m) max = Number(m[1]);
    let names = [];
    try {
      names = fs.readdirSync(this.archiveDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const n of names) {
      const mm = PLAN_ID.exec(n.replace(/\.json$/, ''));
      if (mm) max = Math.max(max, Number(mm[1]));
    }
    return `plan-${String(max + 1).padStart(3, '0')}`;
  }

  updateStep(stepId, { state, addJob, note, reason } = {}) {
    const plan = this.read();
    if (!plan) return null;
    const step = (plan.steps || []).find((s) => s.id === stepId);
    if (!step) return plan;
    if (!Array.isArray(step.jobIds)) step.jobIds = [];
    if (addJob && !step.jobIds.includes(addJob)) step.jobIds.push(addJob);
    if (state) step.state = state;
    if (note !== undefined) step.note = note;
    if (reason !== undefined) step.reason = reason;
    if (plan.status === 'approved' && plan.steps.every((s) => s.state === 'done' || s.state === 'cancelled')) plan.status = 'done';
    this.write(plan);
    return plan;
  }
}

module.exports = {
  STEP_UNITS,
  STEP_STATES,
  PLAN_STATUSES,
  LATENCY_ORDER,
  parseSteps,
  stepsToTaskGraph,
  capable,
  isConsentBacked,
  checkPlan,
  renderPlanCard,
  PlanStore
};
