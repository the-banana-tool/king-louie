// src/cases/roles.js
// Case model roles (cases stage 2 spec §3.8; model roles spec 2026-09-27
// §6, §8). A case role maps onto a model role — orient and classify onto
// utility, draft onto worker, judge and verify onto main — or names an
// explicit provider and model. Tier names from before stage M2 read as the
// mapped role (§13 step 4); case.yaml is not rewritten for that.
const { createLogger } = require('../logging');
const { NO_RETRY } = require('../providers/failover-policy');
const { roleForTier } = require('../models/roles');
const { NoUsableModelError } = require('../models/resolver');

const log = createLogger('cases/roles');

const ROLES = Object.freeze(['orient', 'classify', 'draft', 'judge', 'verify']);
const CASE_ROLE_TO_MODEL_ROLE = Object.freeze({ orient: 'utility', classify: 'utility', draft: 'worker', judge: 'main', verify: 'main' });
const DEFAULT_ROLES = Object.freeze({
  orient: Object.freeze({ role: 'utility' }),
  classify: Object.freeze({ role: 'utility' }),
  draft: Object.freeze({ role: 'worker' }),
  judge: Object.freeze({ role: 'main' }),
  verify: Object.freeze({ role: 'main' })
});
// Orient and the judge loop offer tools; their models must call them.
const CASE_ROLE_NEEDS = Object.freeze({ orient: Object.freeze({ toolCall: true }), judge: Object.freeze({ toolCall: true }) });

const lower = (s) => String(s || '').trim().toLowerCase();

function providerFamily(provider, model) {
  const p = lower(provider);
  if (p === 'openrouter') {
    const m = String(model || '');
    const slash = m.indexOf('/');
    return slash > 0 ? lower(m.slice(0, slash)) : 'openrouter';
  }
  return p;
}

// Which model role a case role uses, and any explicit target. case.yaml
// roles win over settings.cases.roles, which win over the defaults.
function caseRoleSpec(role, { settings = {}, caseMeta = null } = {}) {
  if (!ROLES.includes(role)) throw new Error(`Unknown case role "${role}". Roles: ${ROLES.join(', ')}.`);
  const entry = caseMeta?.roles?.[role] || settings?.cases?.roles?.[role] || DEFAULT_ROLES[role];
  const fallback = CASE_ROLE_TO_MODEL_ROLE[role];
  if (!entry || typeof entry !== 'object') return { modelRole: fallback, explicit: null };
  const named = typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim() : null;
  const modelRole = named || roleForTier(entry.tier) || fallback;
  if (entry.provider && typeof entry.model === 'string' && entry.model.trim()) {
    return { modelRole, explicit: { provider: lower(entry.provider), model: entry.model.trim(), effort: null } };
  }
  if (entry.provider) log.warn(`Case role ${role} names the provider ${entry.provider} with no model; using the ${modelRole} role instead.`);
  return { modelRole, explicit: null };
}

function pick(caseRole, modelRole, resolved) {
  const [first] = resolved.targets;
  return {
    caseRole,
    modelRole,
    provider: first.provider,
    model: first.model,
    effort: first.effort || null,
    targets: resolved.targets.map((x) => ({ ...x })),
    skipped: resolved.skipped,
    borrowedFrom: resolved.borrowedFrom || null
  };
}

function resolveCaseRole(role, { settings = {}, caseMeta = null, turnModels, needs = {} } = {}) {
  if (!turnModels) throw new Error('Resolving a case role needs the turn\'s models.');
  const spec = caseRoleSpec(role, { settings, caseMeta });
  const need = { ...(CASE_ROLE_NEEDS[role] || {}), ...needs };
  if (role !== 'verify') {
    return pick(role, spec.modelRole, turnModels.mustResolve(spec.modelRole, { needs: need, explicit: spec.explicit }));
  }
  // verify: the first usable main model of a different provider family than
  // judge's (spec §6.4), else judge's with a warning, as before.
  const judge = resolveCaseRole('judge', { settings, caseMeta, turnModels });
  const judgeFamily = providerFamily(judge.provider, judge.model);
  if (spec.explicit) {
    const r = pick(role, spec.modelRole, turnModels.mustResolve(spec.modelRole, { needs: need, explicit: spec.explicit }));
    if (providerFamily(r.provider, r.model) === judgeFamily) {
      log.warn(`case.yaml roles.verify uses the same provider family as judge (${judgeFamily}); honouring it as written.`);
    }
    return r;
  }
  // fix round 1: judge can answer through its own explicit case.yaml
  // target even when main itself has nothing usable (e.g. every main
  // model lacks a token); verify has no target of its own to fall back
  // to in that case, so it takes judge's rather than failing the turn.
  let resolved;
  try {
    resolved = turnModels.mustResolve(spec.modelRole, { needs: need });
  } catch (err) {
    if (!(err instanceof NoUsableModelError)) throw err;
    log.warn(`verify falls back to judge's target: ${err.message}`);
    return { ...judge, caseRole: 'verify' };
  }
  const other = resolved.targets.filter((x) => providerFamily(x.provider, x.model) !== judgeFamily);
  if (other.length) return pick(role, spec.modelRole, { ...resolved, targets: other });
  log.warn(`verify falls back to the judge's provider family (${judgeFamily})`);
  return { ...judge, caseRole: 'verify' };
}

module.exports = { ROLES, DEFAULT_ROLES, CASE_ROLE_TO_MODEL_ROLE, CASE_ROLE_NEEDS, NO_RETRY, providerFamily, caseRoleSpec, resolveCaseRole };
