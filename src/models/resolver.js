// src/models/resolver.js
// The resolver (spec 2026-09-27 §6.3–§6.6). createTurnModels() freezes a
// profile and main override at turn launch; resolve() answers "which usable
// models, in order, fill this role for this call", with every skipped entry
// and its reasons. Usability itself is the injected explain() — the host's
// Availability#explain — so this module never touches a provider.
//
// The egress policy (spec 2026-10-13 §7.1, §7.2 item 1): under a policy a
// role's targets are only local models the guarantee accepts, borrowing
// happens only among them, and nothing here resolves to a hosted model.
const R = require('./roles');
const { egressPolicy, normalizePolicy, targetAllowed, refusalCode, refusalSubject } = require('./egress');

const EMPTY_PROFILE = Object.freeze({ id: null, name: '(no profile)', kind: 'user', roles: Object.freeze({ main: [], worker: [], utility: [] }) });

class UnknownRoleError extends Error {
  constructor(role) {
    super(`Unknown model role "${role}". Roles are main, worker, utility, vision, imageGeneration, or a custom role defined in Settings → Models → Advanced.`);
    this.name = 'UnknownRoleError';
    this.code = 'UNKNOWN_ROLE';
    this.role = role;
  }
}

const describeSkipped = (skipped) => skipped.map((s) => `${R.targetLabel(s.target)} (${s.reasons.join(' ')})`).join('; ');

class NoUsableModelError extends Error {
  // `code` is given when the call was under an egress policy
  // (PRIVATE_NO_LOCAL_MODEL, LOCAL_ONLY_ROLE_NO_MODEL): the message then says
  // why no local model took it, and that nothing went to a hosted one.
  constructor(resolution, profileName, code = null) {
    const { role, skipped, override } = resolution;
    let message;
    if (code) {
      const why = skipped.length ? ` Skipped: ${describeSkipped(skipped)}.` : '';
      message = `${refusalSubject(resolution.egress, role)} no local model it can use in the profile "${profileName}".${why} Add one in Settings → Models. Nothing was sent to a hosted model.`;
    } else if (override && skipped.length) {
      message = `The main model override ${R.targetLabel(skipped[0].target)} is not usable: ${skipped[0].reasons.join(' ')} Use the profile's main instead, or pick another model.`;
    } else if (!skipped.length) {
      message = `${role} has no models in the profile "${profileName}". Add one in Settings → Models.`;
    } else {
      message = `No usable model for ${role} in the profile "${profileName}". Skipped: ${describeSkipped(skipped)}. Fix them in Settings → Models, or switch the model.`;
    }
    super(message);
    this.name = 'NoUsableModelError';
    this.code = code || (override ? 'MAIN_OVERRIDE_UNUSABLE' : 'NO_USABLE_MODEL');
    this.role = role;
    this.skipped = skipped;
    this.override = Boolean(override);
  }
}

function mergeNeeds(a = {}, b = {}) {
  const out = { ...a, ...b };
  if (Number.isFinite(a.minContext) || Number.isFinite(b.minContext)) {
    out.minContext = Math.max(Number(a.minContext) || 0, Number(b.minContext) || 0);
  }
  return out;
}

/**
 * @param {object} options
 * @param {object|null} [options.egress] - the turn's egress policy (a private
 *   chat or case), or null. A value that is not a policy is read as an
 *   unreadable mark, which restricts.
 * @param {string[]} [options.localOnly] - role ids that are local-only in
 *   this profile, whatever the chat is.
 * @param {Function|null} [options.isGuaranteeTarget] - the local server
 *   registry's `(target) => true | reason`. Without one, every target is
 *   refused under a policy.
 */
function createTurnModels({ profile = null, mainOverride = null, customRoles = [], explain, egress = null, localOnly = [], isGuaranteeTarget = null } = {}) {
  if (typeof explain !== 'function') throw new Error('createTurnModels needs explain().');
  const frozen = structuredClone(profile || EMPTY_PROFILE);
  const override = R.normalizeTarget(mainOverride);
  const custom = new Map((Array.isArray(customRoles) ? customRoles : []).map((r) => [r.id, structuredClone(r)]));
  const copy = (list) => list.map((x) => ({ ...x }));
  const own = (role) => (Array.isArray(frozen.roles?.[role]) ? frozen.roles[role] : []);

  const turnPolicy = normalizePolicy(egress);
  // A localOnly that is not a list cannot be read: every role is local-only.
  const everyRoleLocalOnly = localOnly !== null && localOnly !== undefined && !Array.isArray(localOnly);
  const localOnlyRoles = new Set(Array.isArray(localOnly) ? localOnly.filter((r) => typeof r === 'string') : []);
  const rolePolicies = new Map();

  // The policy a call in this role is under: the turn's, else the role's own
  // local-only mark, else none.
  function egressFor(role) {
    if (turnPolicy) return turnPolicy;
    if (!everyRoleLocalOnly && !localOnlyRoles.has(role)) return null;
    if (!rolePolicies.has(role)) rolePolicies.set(role, egressPolicy({ reason: 'local-only-role', role: String(role) }));
    return rolePolicies.get(role);
  }

  // Split a list by the policy, before explain() is asked about anything:
  // a target the policy refuses is never tested, only named with its reason.
  const allow = (list, policy) => {
    if (!policy) return { kept: list, dropped: [] };
    const kept = [];
    const dropped = [];
    for (const target of list) {
      const verdict = targetAllowed(policy, target, isGuaranteeTarget);
      if (verdict === true) kept.push(target);
      else dropped.push({ target: { ...target }, reasons: [verdict] });
    }
    return { kept, dropped };
  };

  const check = (list, needs) => {
    const targets = [];
    const skipped = [];
    for (const target of list) {
      // A local target's adapter is part of the target (spec 2026-10-13
      // §12.2): an unknown or stale one makes it unusable, with a reason.
      const adapter = R.adapterOf(target);
      const verdict = explain(target.provider, target.model, adapter ? { needs, adapter } : { needs }) || {};
      if (verdict.usable) {
        targets.push({ ...target });
      } else {
        const reasons = Array.isArray(verdict.reasons) && verdict.reasons.length ? [...verdict.reasons] : ['Not usable.'];
        skipped.push({ target: { ...target }, reasons });
      }
    }
    return { targets, skipped };
  };

  const result = (role, checked, extra = {}) => ({
    role,
    targets: checked.targets,
    skipped: checked.skipped,
    borrowedFrom: null,
    override: false,
    explicit: false,
    useSettings: false,
    egress: null,
    ...extra
  });

  const borrowChain = (role) => (role === 'utility' ? ['worker', 'main'] : role === 'worker' ? ['main'] : []);

  const isKnownRole = (role) => R.isBuiltinRole(role) || custom.has(role);

  // A role's own needs (vision: image input; a custom role: its declared
  // needs) merged with the call's — applied whether resolve() is checking
  // the profile's list or a single explicit target (§6.3).
  function needsFor(role, needs) {
    if (role === 'vision') return mergeNeeds(R.ROLE_NEEDS.vision, needs);
    const c = custom.get(role);
    return c ? mergeNeeds(c.needs, needs) : needs;
  }

  // The configured candidates for a role, before any usability check. Under
  // a policy only the targets it allows: callers test and preview these.
  function candidatesUnder(role, policy) {
    const kept = (list) => allow(list, policy).kept;
    if (role === 'main') return override ? copy(kept([override])) : copy(kept(own('main')));
    if (role === 'worker' || role === 'utility') {
      if (kept(own(role)).length) return copy(kept(own(role)));
      const from = borrowChain(role).find((r) => kept(own(r)).length);
      return from ? copy(kept(own(from))) : [];
    }
    if (role === 'vision') {
      if (kept(own('vision')).length) return copy(kept(own('vision')));
      return kept([...own('utility'), ...own('worker'), ...own('main')]).map((x) => ({ ...x }));
    }
    if (role === 'imageGeneration') return policy ? [] : copy(own('imageGeneration'));
    const c = custom.get(role);
    if (c) {
      if (kept(own(role)).length) return copy(kept(own(role)));
      // A fallback of main previews main's own list, never the override —
      // matching how worker/utility preview a borrow from main above.
      return c.fallback === 'main' ? copy(kept(own('main'))) : candidatesUnder(c.fallback, policy);
    }
    throw new UnknownRoleError(role);
  }

  const candidatesFor = (role) => candidatesUnder(role, isKnownRole(role) ? egressFor(role) : null);

  // No image model runs on a local server, and the settings path is a hosted
  // one: under a policy image generation resolves to nothing, with one
  // skipped entry that says so.
  function imageRefusal(policy) {
    const target = own('imageGeneration')[0] ? { ...own('imageGeneration')[0] } : { provider: 'settings', model: 'imageGeneration', effort: null };
    const reason = policy.reason === 'local-only-role'
      ? 'Image generation is not available on a local model.'
      : 'Image generation is not available in a private chat.';
    return { target, reasons: [reason] };
  }

  // `policy` is the asking role's and is carried through a borrow or a
  // fallback: the role that lends its list does not change it. With no
  // policy, allow() keeps every target and this is the resolver as it was.
  function resolveUnder(role, need, policy) {
    const tag = { egress: policy };
    // A role's list after the policy, then explain(); the targets the policy
    // dropped come first in `skipped`.
    const checked = (list, before = []) => {
      const { kept, dropped } = allow(list, policy);
      const c = check(kept, need);
      return { targets: c.targets, skipped: [...before, ...dropped, ...c.skipped] };
    };
    if (role === 'main') {
      if (override) return result('main', checked([override]), { override: true, ...tag });
      return result('main', checked(own('main')), tag);
    }
    if (role === 'worker' || role === 'utility') {
      // An empty core role borrows from the next stronger one (§6.4); an
      // empty main never borrows from a weaker role. Under a policy "empty"
      // means no target the policy allows (R-LI-22): the borrow is among
      // local models only.
      const mine = allow(own(role), policy);
      if (mine.kept.length) return result(role, checked(own(role)), tag);
      const passed = [...mine.dropped];
      for (const from of borrowChain(role)) {
        const theirs = allow(own(from), policy);
        if (theirs.kept.length) return result(role, checked(own(from), passed), { borrowedFrom: from, ...tag });
        passed.push(...theirs.dropped);
      }
      return result(role, { targets: [], skipped: passed }, tag);
    }
    if (role === 'vision') {
      const mine = allow(own('vision'), policy);
      if (mine.kept.length) return result('vision', checked(own('vision')), tag);
      // The first image-capable model in utility, then worker, then main;
      // every skipped candidate along the way feeds the "no usable model"
      // error when none qualifies.
      const skipped = [...mine.dropped];
      for (const from of ['utility', 'worker', 'main']) {
        const c = checked(own(from));
        if (c.targets.length) return result('vision', { targets: [c.targets[0]], skipped: [] }, { borrowedFrom: from, ...tag });
        skipped.push(...c.skipped);
      }
      return result('vision', { targets: [], skipped }, tag);
    }
    if (role === 'imageGeneration') {
      if (policy) return result(role, { targets: [], skipped: [imageRefusal(policy)] }, tag);
      if (own('imageGeneration').length) return result(role, checked(own('imageGeneration')), tag);
      // Empty: today's imageGeneration settings keep applying (§6.4).
      return result(role, { targets: [], skipped: [] }, { useSettings: true, ...tag });
    }
    // A custom role: its own list, else its fallback core role's. A
    // fallback of main uses main's own list, never the main override
    // (matching the borrow chain above); the innermost borrowedFrom is
    // kept when the fallback itself had to borrow further.
    const c = custom.get(role);
    const mine = allow(own(role), policy);
    if (mine.kept.length) return result(role, checked(own(role)), tag);
    const inner = c.fallback === 'main'
      ? result('main', checked(own('main')), tag)
      : resolveUnder(c.fallback, need, policy);
    return { ...inner, role, skipped: [...mine.dropped, ...inner.skipped], borrowedFrom: inner.borrowedFrom || c.fallback };
  }

  function resolve(role, { needs = {}, explicit = null } = {}) {
    if (!isKnownRole(role)) throw new UnknownRoleError(role);
    const need = needsFor(role, needs);
    const policy = egressFor(role);
    if (explicit) {
      const target = R.normalizeTarget(explicit);
      if (!target) throw new Error(`A named model needs both a provider and a model id (got ${JSON.stringify(explicit)}).`);
      if (policy && role === 'imageGeneration') return result(role, { targets: [], skipped: [imageRefusal(policy)] }, { explicit: true, egress: policy });
      const { kept, dropped } = allow([target], policy);
      const c = check(kept, need);
      return result(role, { targets: c.targets, skipped: [...dropped, ...c.skipped] }, { explicit: true, egress: policy });
    }
    return resolveUnder(role, need, policy);
  }

  function mustResolve(role, options = {}) {
    const r = resolve(role, options);
    if (!r.targets.length && !r.useSettings) {
      // Under a policy the refusal says so, whatever else was wrong (a
      // refused main override included): nothing fell back to a hosted model.
      throw new NoUsableModelError(r, frozen.name, r.egress ? refusalCode(r.egress) : null);
    }
    return r;
  }

  return Object.freeze({
    profileId: frozen.id || null,
    profileName: frozen.name,
    mainOverride: override ? { ...override } : null,
    egress: turnPolicy,
    egressFor,
    configuredFor: (role) => copy(own(role)),
    candidatesFor,
    resolve,
    mustResolve
  });
}

// The call timeout for a role: models.roleTimeoutsMs, a specialist using
// worker's and a custom role its fallback's.
function roleTimeoutMs(settings, role, customRoles = []) {
  const table = { ...R.DEFAULT_ROLE_TIMEOUTS_MS, ...(settings?.models?.roleTimeoutsMs || {}) };
  let key = role;
  if (!R.isCoreRole(role)) {
    const c = (customRoles || []).find((r) => r.id === role);
    key = c ? c.fallback : 'worker';
  }
  const value = Number(table[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

module.exports = { createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs, EMPTY_PROFILE };
