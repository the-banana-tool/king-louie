// src/models/suggester.js
// The King Louie profile's picking rules (spec 2026-09-27 §7.1) and its
// proposals (§7.2), as pure functions over candidates: usable models with
// their catalog prices, scores and capabilities. Deterministic; every pick
// carries a one-line reason. Nothing here writes: the owner accepts.
const crypto = require('crypto');

const KING_LOUIE_DEFAULTS = Object.freeze({
  autoAccept: false,
  bandPoints: 3,
  workerAgenticRatio: 0.8,
  utilityIntelligenceRatio: 0.5,
  preferLocalUtility: false,
  blend: Object.freeze({ input: 3, output: 1 }),
  dismissedProposalId: null
});
const WORKER_MIN_CONTEXT = 128000;
const MAX_LIST = 3;
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PICKED_ROLES = Object.freeze(['main', 'worker', 'utility', 'vision', 'imageGeneration']);
const BORROW = Object.freeze({
  utility: ['utility', 'worker', 'main'],
  worker: ['worker', 'main'],
  // The resolver borrows an empty vision role from utility, then worker,
  // then main (src/models/resolver.js's resolve('vision')); a proposal's
  // cost effect follows the same chain so an empty vision reprices on what
  // it would actually run on, never "nothing to price".
  vision: ['vision', 'utility', 'worker', 'main']
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d) => (isNum(v) ? v : d);
const keyOf = (c) => `${c.provider}:${c.model}`;
const money = (rate) => `$${rate.toFixed(2)} per million tokens blended`;
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

function mergeKingLouieSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const blend = src.blend && typeof src.blend === 'object' && !Array.isArray(src.blend) ? src.blend : {};
  return {
    autoAccept: src.autoAccept === true,
    bandPoints: numOr(src.bandPoints, KING_LOUIE_DEFAULTS.bandPoints),
    workerAgenticRatio: numOr(src.workerAgenticRatio, KING_LOUIE_DEFAULTS.workerAgenticRatio),
    utilityIntelligenceRatio: numOr(src.utilityIntelligenceRatio, KING_LOUIE_DEFAULTS.utilityIntelligenceRatio),
    preferLocalUtility: src.preferLocalUtility === true,
    blend: {
      input: numOr(blend.input, KING_LOUIE_DEFAULTS.blend.input),
      output: numOr(blend.output, KING_LOUIE_DEFAULTS.blend.output)
    },
    dismissedProposalId: typeof src.dismissedProposalId === 'string' && src.dismissedProposalId ? src.dismissedProposalId : null
  };
}

// A usable model with what the catalog says about it. An unknown model has
// no price, so it is never picked (spec §5.1).
function candidateFromEntry(candidate, entry) {
  const e = entry && typeof entry === 'object' ? entry : null;
  const inputs = Array.isArray(e?.input) ? e.input : [];
  const outputs = Array.isArray(e?.output) ? e.output : [];
  return {
    provider: candidate.provider,
    model: candidate.model,
    name: e?.name || candidate.name || candidate.model,
    cost: e?.cost || null,
    scores: {
      intelligence: isNum(e?.scores?.intelligence) ? e.scores.intelligence : null,
      agentic: isNum(e?.scores?.agentic) ? e.scores.agentic : null
    },
    toolCall: e ? e.toolCall === true : false,
    imageInput: inputs.includes('image'),
    textOutput: outputs.includes('text'),
    imageOutput: outputs.includes('image'),
    context: isNum(e?.limits?.context) ? e.limits.context : null,
    local: Boolean(e?.local),
    efforts: Array.isArray(e?.reasoning?.efforts) ? [...e.reasoning.efforts] : []
  };
}

// Three parts input to one part output per million tokens (spec §7.1).
function blendedRate(cost, blend = KING_LOUIE_DEFAULTS.blend) {
  if (!cost || !isNum(cost.input) || !isNum(cost.output)) return null;
  const inPart = numOr(blend?.input, KING_LOUIE_DEFAULTS.blend.input);
  const outPart = numOr(blend?.output, KING_LOUIE_DEFAULTS.blend.output);
  if (!(inPart + outPart > 0)) return null;
  return (inPart * cost.input + outPart * cost.output) / (inPart + outPart);
}

function lowestEffort(efforts) {
  const list = Array.isArray(efforts) ? efforts : [];
  return EFFORT_ORDER.find((e) => list.includes(e)) || list[0] || null;
}

// Up to MAX_LIST, in order, first preferring a provider not yet listed
// (spec §7.1: spread across providers, which also gives verify a family).
function spread(ordered) {
  const out = [];
  const seen = new Set();
  for (const newProviderOnly of [true, false]) {
    for (const c of ordered) {
      if (out.length >= MAX_LIST) return out;
      if (seen.has(keyOf(c))) continue;
      if (newProviderOnly && out.some((x) => x.provider === c.provider)) continue;
      out.push(c);
      seen.add(keyOf(c));
    }
  }
  return out;
}

function pickRoles(candidates, rawSettings = {}) {
  const s = mergeKingLouieSettings(rawSettings);
  const all = (Array.isArray(candidates) ? candidates : []).filter(Boolean).map((c) => ({ ...c, rate: blendedRate(c.cost, s.blend) }));
  const priced = all.filter((c) => c.rate !== null);
  const byCost = (a, b) => a.rate - b.rate || keyOf(a).localeCompare(keyOf(b));
  const intel = (c) => (isNum(c.scores?.intelligence) ? c.scores.intelligence : null);
  const agentic = (c) => (isNum(c.scores?.agentic) ? c.scores.agentic : null);
  const target = (c, effort = null) => ({ provider: c.provider, model: c.model, effort });
  const failover = (c) => `${c.name}: failover, the next cheapest that qualifies.`;

  // main: tool calling, ranked by agentic then intelligence; within the
  // band of the best, the cheaper wins. textOutput isn't in §7.1, but main
  // drives the chat reply itself, so a model that can't produce text (an
  // image-only or audio-only model) is never a candidate however it scores.
  const mainPool = priced.filter((c) => c.textOutput && c.toolCall && agentic(c) !== null);
  if (!mainPool.length) {
    return { unavailable: 'No usable model that calls tools has both a price and an agentic score, so King Louie cannot propose a main model. Add a key for a provider whose models are scored, or fill a profile by hand.' };
  }
  const ranked = [...mainPool].sort((a, b) => (agentic(b) - agentic(a))
    || ((intel(b) ?? -1) - (intel(a) ?? -1))
    || byCost(a, b));
  const best = agentic(ranked[0]);
  const band = ranked.filter((c) => agentic(c) >= best - s.bandPoints);
  const first = [...band].sort(byCost)[0];
  const mainA = agentic(first);
  const mainI = intel(first);
  const roles = {};
  const reasons = {};

  const mainList = spread([first, ...ranked.filter((c) => c !== first)]);
  roles.main = mainList.map((c) => target(c));
  reasons.main = mainList.map((c, i) => {
    if (i > 0) return `${c.name}: failover, agentic ${agentic(c)}${c.provider !== first.provider ? ', another provider' : ''}.`;
    return band.length > 1
      ? `${c.name}: the cheapest of the ${band.length} models within ${s.bandPoints} points of the best agentic score (${best}); agentic ${mainA}, ${money(c.rate)}.`
      : `${c.name}: the best agentic score among usable tool-calling models (${mainA}), ${money(c.rate)}.`;
  });

  // worker: tool calling, 128K context, agentic at least the ratio of main's.
  // textOutput for the same reason as main: worker also answers directly.
  const workerList = spread(priced
    .filter((c) => c.textOutput && c.toolCall && isNum(c.context) && c.context >= WORKER_MIN_CONTEXT
      && agentic(c) !== null && agentic(c) >= s.workerAgenticRatio * mainA)
    .sort(byCost));
  roles.worker = workerList.map((c) => target(c));
  reasons.worker = workerList.length
    ? workerList.map((c, i) => (i === 0
      ? `${c.name}: the cheapest tool-calling model with at least 128K context whose agentic score (${agentic(c)}) is at least ${pct(s.workerAgenticRatio)} of main's (${mainA}), ${money(c.rate)}.`
      : failover(c)))
    : [`No usable model qualifies (tool calling, 128K context, an agentic score at least ${pct(s.workerAgenticRatio)} of main's ${mainA}); worker borrows from main.`];

  // utility: no tool need, intelligence at least the ratio of main's, at
  // the lowest effort; a local model with tools first when asked.
  const localFirst = s.preferLocalUtility
    ? all.filter((c) => c.local && c.toolCall && c.textOutput).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
    : [];
  const utilityPool = mainI === null
    ? []
    : priced.filter((c) => c.textOutput && intel(c) !== null && intel(c) >= s.utilityIntelligenceRatio * mainI).sort(byCost);
  const utilityList = spread([...localFirst, ...utilityPool]);
  roles.utility = utilityList.map((c) => target(c, lowestEffort(c.efforts)));
  let firstPriced = true;
  reasons.utility = utilityList.length
    ? utilityList.map((c) => {
      const effort = lowestEffort(c.efforts);
      const at = effort ? `, at ${effort} effort` : '';
      if (localFirst.includes(c)) return `${c.name}: a local model with tool support, preferred for utility${at}.`;
      if (!firstPriced) return `${c.name}: failover, the next cheapest that qualifies${at}.`;
      firstPriced = false;
      return `${c.name}: the cheapest model whose intelligence score (${intel(c)}) is at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}), ${money(c.rate)}${at}.`;
    })
    : [mainI === null
      ? 'Main\'s pick has no intelligence score to compare against, so no model qualifies; utility borrows from worker, then main.'
      : `No usable model has an intelligence score at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}); utility borrows from worker, then main.`];

  // vision: as utility, with image input, without the local preference.
  const visionList = mainI === null
    ? []
    : spread(priced
      .filter((c) => c.textOutput && c.imageInput && intel(c) !== null && intel(c) >= s.utilityIntelligenceRatio * mainI)
      .sort(byCost));
  roles.vision = visionList.map((c) => target(c));
  reasons.vision = visionList.length
    ? visionList.map((c, i) => (i === 0
      ? `${c.name}: the cheapest image-reading model whose intelligence score (${intel(c)}) is at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}), ${money(c.rate)}.`
      : failover(c)))
    : ['No usable image-reading model qualifies; vision uses the first image-capable model in utility, worker or main.'];

  // imageGeneration: priced image-output models, cheapest first.
  const imageList = spread(priced.filter((c) => c.imageOutput).sort(byCost));
  roles.imageGeneration = imageList.map((c) => target(c));
  reasons.imageGeneration = imageList.length
    ? imageList.map((c, i) => (i === 0 ? `${c.name}: the cheapest priced image model, ${money(c.rate)}.` : failover(c)))
    : ['No priced image model is usable; the image generation settings keep applying.'];

  return { roles, reasons };
}

const normTarget = (t) => ({ provider: t.provider, model: t.model, effort: t.effort || null });
const sameTargets = (a = [], b = []) => JSON.stringify(a.map(normTarget)) === JSON.stringify(b.map(normTarget));

function proposalId(roles) {
  const body = JSON.stringify(PICKED_ROLES.map((r) => [r, (roles?.[r] || []).map(normTarget)]));
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

// The first model a role would call under the proposal, borrowing as the
// resolver does (spec §6.4) when the role itself is empty.
function firstTarget(roles, role) {
  for (const r of BORROW[role] || [role]) {
    if (Array.isArray(roles?.[r]) && roles[r].length) return roles[r][0];
  }
  return null;
}

// A changed role's recent recorded calls, repriced on its proposed first
// model, minus what they were recorded as costing (spec §7.2).
function costEffectFor(role, roles, usage, price) {
  const u = usage?.[role];
  if (!u || !u.calls) return { usd: null, note: 'No recorded calls in the last 30 days.' };
  const to = firstTarget(roles, role);
  if (!to) return { usd: null, note: 'Nothing to price: this role would have no model.' };
  const next = price(to, u.usage || {});
  if (!isNum(next)) return { usd: null, note: `${to.model} is unpriced.` };
  const usd = Number((next - (Number(u.cost) || 0)).toFixed(8));
  const note = u.unpricedCalls
    ? `${u.calls} calls in the last 30 days, repriced; ${u.unpricedCalls} were unpriced, so their recorded cost is incomplete.`
    : `${u.calls} calls in the last 30 days, repriced.`;
  return { usd, note };
}

function buildProposal({ picks, current = null, usage = {}, price = () => null, nameOf = (t) => t.model } = {}) {
  const named = (t) => ({ ...normTarget(t), name: nameOf(t) });
  const changes = PICKED_ROLES
    .filter((role) => !sameTargets(current?.[role] || [], picks.roles[role] || []))
    .map((role) => ({
      role,
      from: (current?.[role] || []).map(named),
      to: (picks.roles[role] || []).map(named),
      reasons: picks.reasons[role] || [],
      costEffect: costEffectFor(role, picks.roles, usage, price)
    }));
  const estimates = changes.map((x) => x.costEffect.usd).filter(isNum);
  const costEffect = estimates.length
    ? {
      usd: Number(estimates.reduce((a, b) => a + b, 0).toFixed(8)),
      note: `Estimated from the last 30 days of recorded calls${estimates.length < changes.length ? '; some changed roles have no estimate' : ''}.`
    }
    : { usd: null, note: 'No estimate: no recorded calls to reprice for the changed roles.' };
  return {
    id: changes.length ? proposalId(picks.roles) : null,
    roles: picks.roles,
    reasons: picks.reasons,
    changes,
    costEffect,
    upToDate: changes.length === 0
  };
}

module.exports = {
  KING_LOUIE_DEFAULTS,
  WORKER_MIN_CONTEXT,
  PICKED_ROLES,
  mergeKingLouieSettings,
  candidateFromEntry,
  blendedRate,
  lowestEffort,
  pickRoles,
  proposalId,
  buildProposal
};
