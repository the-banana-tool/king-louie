// src/models/roles.js
// Model roles (spec 2026-09-27 §6.2): the three core roles every profile
// has, the two optional specialists, and custom roles (lowercase slugs).
// Tier names from before stage M2 read as the mapped role (§13).

const CORE_ROLES = Object.freeze(['main', 'worker', 'utility']);
const SPECIALIST_ROLES = Object.freeze(['vision', 'imageGeneration']);
const BUILTIN_ROLES = Object.freeze([...CORE_ROLES, ...SPECIALIST_ROLES]);
const TIER_TO_ROLE = Object.freeze({ fast: 'utility', standard: 'worker', smart: 'main' });
// What every model in a specialist role must be able to do.
const ROLE_NEEDS = Object.freeze({ vision: Object.freeze({ imageInput: true }) });
const DEFAULT_ROLE_TIMEOUTS_MS = Object.freeze({ main: 90000, worker: 30000, utility: 15000 });
const CUSTOM_ROLE_ID = /^[a-z][a-z0-9-]{1,39}$/;
// An adapter a local target names (spec 2026-10-13 §12.2): a slug, unique per model.
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,39}$/;
// The one provider key whose targets may name an adapter (LOCAL_PROVIDER in
// provider-ids.js, written out so this module keeps no requires).
const LOCAL = 'local';
const BUILTIN_LOWER = BUILTIN_ROLES.map((r) => r.toLowerCase());

const isCoreRole = (role) => CORE_ROLES.includes(role);
const isBuiltinRole = (role) => BUILTIN_ROLES.includes(role);

function isCustomRoleId(id) {
  return typeof id === 'string' && CUSTOM_ROLE_ID.test(id) && !BUILTIN_LOWER.includes(id);
}

function roleForTier(tier) {
  return TIER_TO_ROLE[String(tier || '').trim().toLowerCase()] || null;
}

// An agent's role: its own `role` when it names one, else its
// pre-M2 inferenceTier read as the mapped role (§13 step 5), else worker.
function roleForAgent(agent) {
  const own = typeof agent?.role === 'string' ? agent.role.trim() : '';
  if (own && (isBuiltinRole(own) || isCustomRoleId(own))) return own;
  return roleForTier(agent?.inferenceTier) || 'worker';
}

const isAdapterId = (v) => typeof v === 'string' && ADAPTER_ID.test(v);

// { provider, model, effort } with a lowercase provider and trimmed ids, or
// null when either the provider or the model is missing. A local target may
// also name an adapter (spec 2026-10-13 §12.2): kept only when the provider
// is local and the value is a slug, dropped everywhere else, so a target
// without one is exactly what it was.
function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = String(raw.provider || '').trim().toLowerCase();
  const model = String(raw.model || '').trim();
  if (!provider || !model) return null;
  const effort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : null;
  const adapter = typeof raw.adapter === 'string' ? raw.adapter.trim() : null;
  if (provider === LOCAL && isAdapterId(adapter)) return { provider, model, effort, adapter };
  return { provider, model, effort };
}

// A target's adapter, or null. The same model with and without one are two
// entries in a role (targetKey), and a label names it.
const adapterOf = (t) => (t && t.provider === LOCAL && isAdapterId(t.adapter) ? t.adapter : null);
const targetKey = (t) => `${t.provider}:${t.model}${adapterOf(t) ? `@${t.adapter}` : ''}`;
const targetLabel = (t) => (t ? `${t.provider}/${t.model}${adapterOf(t) ? ` + ${t.adapter}` : ''}` : '(none)');

module.exports = {
  CORE_ROLES,
  SPECIALIST_ROLES,
  BUILTIN_ROLES,
  TIER_TO_ROLE,
  ROLE_NEEDS,
  DEFAULT_ROLE_TIMEOUTS_MS,
  isCoreRole,
  isBuiltinRole,
  isCustomRoleId,
  roleForTier,
  roleForAgent,
  normalizeTarget,
  isAdapterId,
  adapterOf,
  targetKey,
  targetLabel
};
