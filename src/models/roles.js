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

// { provider, model, effort } with a lowercase provider and trimmed ids, or
// null when either the provider or the model is missing.
function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = String(raw.provider || '').trim().toLowerCase();
  const model = String(raw.model || '').trim();
  if (!provider || !model) return null;
  const effort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : null;
  return { provider, model, effort };
}

const targetKey = (t) => `${t.provider}:${t.model}`;
const targetLabel = (t) => (t ? `${t.provider}/${t.model}` : '(none)');

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
  targetKey,
  targetLabel
};
