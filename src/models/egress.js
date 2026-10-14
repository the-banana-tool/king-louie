// src/models/egress.js
// The egress policy (spec 2026-10-13-local-inference-design.md §7.1): one
// value that says a model call may not leave the owner's hardware. `null`
// means no restriction. Anything else restricts: a value this module cannot
// read is treated as a policy, never as "no policy".
const { targetLabel } = require('./roles');

const EGRESS_REASONS = Object.freeze(['private-chat', 'private-case', 'local-only-role', 'unknown-mark']);

const LOCAL_PROVIDER = 'local';

/**
 * @param {object} spec
 * @param {'private-chat'|'private-case'|'local-only-role'|'unknown-mark'} spec.reason
 * @param {string|null} [spec.chatId]
 * @param {string|null} [spec.caseId]
 * @param {string} [spec.role] - the role, for `local-only-role` (present only when given)
 * @returns {Readonly<{ localOnly: true, reason: string, chatId: string|null, caseId: string|null, role?: string }>}
 */
function egressPolicy({ reason, chatId = null, caseId = null, role = null } = {}) {
  if (!EGRESS_REASONS.includes(reason)) {
    throw new Error(`An egress policy needs a reason from: ${EGRESS_REASONS.join(', ')}.`);
  }
  const policy = { localOnly: true, reason, chatId: chatId ?? null, caseId: caseId ?? null };
  if (typeof role === 'string' && role) policy.role = role;
  return Object.freeze(policy);
}

const isPolicy = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && value.localOnly === true && EGRESS_REASONS.includes(value.reason);

/**
 * `null` or `undefined` is no policy. A policy is returned frozen. Anything
 * else (a boolean, a string, an object that is not a policy) is a mark that
 * could not be read, which is treated as private.
 */
function normalizePolicy(value) {
  if (value === null || value === undefined) return null;
  if (!isPolicy(value)) return egressPolicy({ reason: 'unknown-mark' });
  return Object.isFrozen(value) ? value : egressPolicy(value);
}

/** Only the `local` provider key (a marked, address-checked local server). The built-in `ollama` provider is not local (R-LI-31). */
const isLocalProvider = (provider) => provider === LOCAL_PROVIDER;

function because(policy) {
  if (policy.reason === 'local-only-role') return `${policy.role || 'this role'} is local-only`;
  if (policy.reason === 'private-case') return 'this case is private';
  if (policy.reason === 'unknown-mark') return 'this chat\'s private mark could not be read, so it is treated as private';
  return 'this chat is private';
}

/**
 * May this target take a call under this policy?
 * @param {object|null} policy - `null`/`undefined`: no restriction
 * @param {{ provider: string, model: string }} target
 * @param {Function|null} isGuaranteeTarget - the local server registry's answer:
 *   exactly `true`, or a sentence saying why not (R-LI-30). Without one every
 *   target is refused.
 * @returns {true|string} `true`, or the reason it is refused
 */
function targetAllowed(policy, target, isGuaranteeTarget) {
  if (policy === null || policy === undefined) return true;
  const p = normalizePolicy(policy);
  const named = target && typeof target === 'object' && typeof target.provider === 'string' && typeof target.model === 'string' && target.model !== '';
  const label = named ? targetLabel(target) : 'This target';
  if (!named || !isLocalProvider(target.provider)) return `${label} is not a local model and ${because(p)}.`;
  const refused = `${label} is not a local model the guarantee accepts and ${because(p)}.`;
  if (typeof isGuaranteeTarget !== 'function') return refused;
  let verdict;
  try {
    verdict = isGuaranteeTarget(target);
  } catch {
    return refused;
  }
  if (verdict === true) return true;
  return typeof verdict === 'string' && verdict.trim() ? verdict : refused;
}

/** The code a refused call carries when no local model can take it (§7.2). */
function refusalCode(policy) {
  return policy && policy.reason === 'local-only-role' ? 'LOCAL_ONLY_ROLE_NO_MODEL' : 'PRIVATE_NO_LOCAL_MODEL';
}

/** The opening of the "no local model" message for a role under a policy. */
function refusalSubject(policy, role) {
  const p = normalizePolicy(policy) || egressPolicy({ reason: 'unknown-mark' });
  if (p.reason === 'local-only-role') return `${p.role || role} is local-only and has`;
  if (p.reason === 'private-case') return `This case is private and ${role} has`;
  if (p.reason === 'unknown-mark') return `This chat's private mark could not be read, so it is treated as private, and ${role} has`;
  return `This chat is private and ${role} has`;
}

module.exports = { EGRESS_REASONS, egressPolicy, normalizePolicy, isLocalProvider, targetAllowed, refusalCode, refusalSubject };
