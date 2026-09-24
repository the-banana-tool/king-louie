// src/cases/triggers.js
// Re-orientation triggers (cases stage 2 spec §3.3). Pure apart from a log
// line: the runtime reads the case files and the baseline and passes them in.
const { toMs } = require('./clock');
const { createLogger } = require('../logging');

const log = createLogger('cases/triggers');

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function emptyBaseline() {
  return {
    acknowledgedAt: null,
    undermined: [],
    executorsMaterial: {},
    budgetCrossed: {},
    acknowledgedKeys: [],
    caseTypeMaterial: {},
    commitFailures: 0
  };
}

// Every (decision, cited fact) pair whose fact is no longer active.
function underminedKeys(decisions = [], facts = new Map()) {
  const out = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    for (const factId of Array.isArray(decision?.factIds) ? decision.factIds : []) {
      const f = facts.get(factId);
      if (f && f.status !== 'active') out.push({ key: `${decision.id}:${factId}`, decision, factId, fact: f });
    }
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v : []);

function detectTriggers(input = {}) {
  const {
    source = 'owner',
    now = new Date(),
    meta = {},
    facts = new Map(),
    decisions = [],
    budget = null,
    executors = null,
    plan = null,
    playbookChanges = [],
    hookTriggers = [],
    reorientAfterHours = 8
  } = input;
  const baseline = { ...emptyBaseline(), ...(input.baseline || {}) };
  const out = [];

  // Owner turns only: wake-ups leave "has anything changed?" to the orient step.
  if (source === 'owner' && meta && meta.lastOwnerTurnAt) {
    const last = toMs(meta.lastOwnerTurnAt);
    if (!Number.isFinite(last)) {
      log.warn(`lastOwnerTurnAt "${meta.lastOwnerTurnAt}" is not a date; no time-gap check.`);
    } else if (last > now.getTime()) {
      log.warn(`lastOwnerTurnAt ${new Date(last).toISOString()} is in the future; no time-gap check.`);
    } else {
      const hours = (now.getTime() - last) / 3600000;
      if (hours > reorientAfterHours) {
        out.push({
          kind: 'time-gap',
          key: 'time-gap',
          blocking: true,
          detail: `The owner's last turn was ${Math.floor(hours)} hours ago (${new Date(last).toISOString()}). Re-read the case before acting on anything decided then.`
        });
      }
    }
  }

  for (const u of underminedKeys(decisions, facts)) {
    if (list(baseline.undermined).includes(u.key)) continue;
    out.push({
      kind: 'decision-undermined',
      key: u.key,
      blocking: true,
      decisionIds: [u.decision.id],
      detail: `${u.decision.id} ("${u.decision.decision}") cites ${u.factId}, which is now ${u.fact.status}${u.fact.supersededBy ? ` by ${u.fact.supersededBy}` : ''}.`
    });
  }

  if (executors && typeof executors === 'object') {
    const known = baseline.executorsMaterial || {};
    for (const [id, entry] of Object.entries(executors)) {
      if (!entry || entry.stale) continue;
      if (!Object.prototype.hasOwnProperty.call(known, id)) continue;
      const material = entry.material ?? null;
      if (!deepEqual(material, known[id])) {
        out.push({
          kind: 'executor-change',
          key: `executor:${id}`,
          blocking: true,
          detail: `Executor ${id} changed: ${JSON.stringify(known[id])} -> ${JSON.stringify(material)}.`
        });
      }
    }
  }

  if (budget && typeof budget === 'object') {
    for (const [category, e] of Object.entries(budget)) {
      const seen = list(baseline.budgetCrossed?.[category]);
      for (const t of [80, 100]) {
        if (!list(e?.crossed).includes(t) || seen.includes(t)) continue;
        out.push({
          kind: 'budget-threshold',
          key: `budget:${category}:${t}`,
          blocking: true,
          detail: category === 'deadline'
            ? `${t} % of the time to the deadline (${e.at}) has passed.`
            : `The ${category} budget passed ${t} % (${e.spent} of ${e.limit}).`
        });
      }
    }
  }

  if (source === 'owner' && list(plan?.steps).some((s) => s && s.state === 'in-flight')) {
    out.push({
      kind: 'message-mid-plan',
      key: 'mid-plan',
      blocking: true,
      detail: 'The owner wrote while a plan step is in flight. Decide whether the message changes the plan before continuing it.'
    });
  }

  for (const p of list(playbookChanges)) {
    if (!p || !p.name) continue;
    out.push({
      kind: 'playbook-update',
      // C6 supplies its own `key` and `detail` (an `edited` change keeps the same version);
      // fall back to the name/version form when they are absent.
      key: typeof p.key === 'string' && p.key ? p.key : `playbook:${p.name}:${p.to ?? 'removed'}`,
      blocking: true,
      detail: typeof p.detail === 'string' && p.detail ? p.detail : `Playbook ${p.name} changed (${p.from ?? 'none'} -> ${p.to ?? 'removed'}).`
    });
  }

  for (const t of list(hookTriggers)) {
    if (!t || typeof t.key !== 'string' || typeof t.kind !== 'string') continue;
    if (list(baseline.acknowledgedKeys).includes(t.key)) continue;
    out.push({ ...t, blocking: t.blocking !== false, detail: String(t.detail || t.kind) });
  }

  return out;
}

module.exports = { detectTriggers, underminedKeys, emptyBaseline, deepEqual };
