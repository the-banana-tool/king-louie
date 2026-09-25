// src/cases/roles.js
// Case model roles (cases stage 2 spec §3.8, program §4.5). A role is a
// tier or an explicit provider/model; the router's tier map gains no roles.
const { createLogger } = require('../logging');

const log = createLogger('cases/roles');

const ROLES = Object.freeze(['orient', 'classify', 'draft', 'judge', 'verify']);
const TIERS = Object.freeze(['fast', 'standard', 'smart']);
const DEFAULT_ROLES = Object.freeze({
  orient: Object.freeze({ tier: 'fast' }),
  classify: Object.freeze({ tier: 'fast' }),
  draft: Object.freeze({ tier: 'standard' }),
  judge: Object.freeze({ tier: 'smart' }),
  verify: Object.freeze({ tier: 'smart' })
});

// Case loops fail over through routeWithFallback, never by retrying the
// same target inside the agent loop.
const NO_RETRY = Object.freeze({ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) });

const lower = (s) => String(s || '').trim().toLowerCase();

function tierTarget(tier, settings = {}) {
  const t = TIERS.includes(lower(tier)) ? lower(tier) : 'standard';
  const cfg = settings?.inference?.tierMap?.[t] || {};
  return {
    provider: lower(cfg.provider || settings?.activeProvider || 'openai'),
    model: typeof cfg.model === 'string' ? cfg.model : '',
    tier: t
  };
}

function entryTarget(entry, settings) {
  if (entry && typeof entry === 'object' && entry.provider) {
    return {
      provider: lower(entry.provider),
      model: typeof entry.model === 'string' ? entry.model : '',
      tier: TIERS.includes(lower(entry.tier)) ? lower(entry.tier) : 'standard'
    };
  }
  return tierTarget(entry?.tier, settings);
}

function providerFamily(provider, model) {
  const p = lower(provider);
  if (p === 'openrouter') {
    const m = String(model || '');
    const slash = m.indexOf('/');
    return slash > 0 ? lower(m.slice(0, slash)) : 'openrouter';
  }
  return p;
}

function resolveRole(role, { settings = {}, caseMeta = null, hasToken = () => true } = {}) {
  if (!ROLES.includes(role)) throw new Error(`Unknown case role "${role}". Roles: ${ROLES.join(', ')}.`);
  const explicit = caseMeta?.roles?.[role];
  const entry = explicit || settings?.cases?.roles?.[role] || DEFAULT_ROLES[role];
  const target = entryTarget(entry, settings);
  if (role !== 'verify') return target;

  const judge = resolveRole('judge', { settings, caseMeta, hasToken });
  const judgeFamily = providerFamily(judge.provider, judge.model);
  if (providerFamily(target.provider, target.model) !== judgeFamily) return target;
  if (explicit) {
    log.warn(`case.yaml roles.verify uses the same provider family as judge (${judgeFamily}); honouring it as written.`);
    return target;
  }
  for (const tier of ['smart', 'standard', 'fast']) {
    const candidate = tierTarget(tier, settings);
    if (providerFamily(candidate.provider, candidate.model) !== judgeFamily && hasToken(candidate.provider)) return candidate;
  }
  log.warn(`verify falls back to the judge's provider family (${judgeFamily})`);
  return judge;
}

module.exports = { ROLES, TIERS, DEFAULT_ROLES, NO_RETRY, tierTarget, providerFamily, resolveRole };
