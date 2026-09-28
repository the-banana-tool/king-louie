// src/models/resolver.js
// The resolver (spec 2026-09-27 §6.3–§6.6). createTurnModels() freezes a
// profile and main override at turn launch; resolve() answers "which usable
// models, in order, fill this role for this call", with every skipped entry
// and its reasons. Usability itself is the injected explain() — the host's
// Availability#explain — so this module never touches a provider.
const R = require('./roles');

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
  constructor(resolution, profileName) {
    const { role, skipped, override } = resolution;
    let message;
    if (override && skipped.length) {
      message = `The main model override ${R.targetLabel(skipped[0].target)} is not usable: ${skipped[0].reasons.join(' ')} Use the profile's main instead, or pick another model.`;
    } else if (!skipped.length) {
      message = `${role} has no models in the profile "${profileName}". Add one in Settings → Models.`;
    } else {
      message = `No usable model for ${role} in the profile "${profileName}". Skipped: ${describeSkipped(skipped)}. Fix them in Settings → Models, or switch the model.`;
    }
    super(message);
    this.name = 'NoUsableModelError';
    this.code = override ? 'MAIN_OVERRIDE_UNUSABLE' : 'NO_USABLE_MODEL';
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

function createTurnModels({ profile = null, mainOverride = null, customRoles = [], explain } = {}) {
  if (typeof explain !== 'function') throw new Error('createTurnModels needs explain().');
  const frozen = structuredClone(profile || EMPTY_PROFILE);
  const override = R.normalizeTarget(mainOverride);
  const custom = new Map((Array.isArray(customRoles) ? customRoles : []).map((r) => [r.id, structuredClone(r)]));
  const copy = (list) => list.map((x) => ({ ...x }));
  const own = (role) => (Array.isArray(frozen.roles?.[role]) ? frozen.roles[role] : []);

  const check = (list, needs) => {
    const targets = [];
    const skipped = [];
    for (const target of list) {
      const verdict = explain(target.provider, target.model, { needs }) || {};
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
    ...extra
  });

  const borrowChain = (role) => (role === 'utility' ? ['worker', 'main'] : role === 'worker' ? ['main'] : []);

  function candidatesFor(role) {
    if (role === 'main') return override ? [{ ...override }] : copy(own('main'));
    if (role === 'worker' || role === 'utility') {
      if (own(role).length) return copy(own(role));
      const from = borrowChain(role).find((r) => own(r).length);
      return from ? copy(own(from)) : [];
    }
    if (role === 'vision') {
      if (own('vision').length) return copy(own('vision'));
      return [...own('utility'), ...own('worker'), ...own('main')].map((x) => ({ ...x }));
    }
    if (role === 'imageGeneration') return copy(own('imageGeneration'));
    const c = custom.get(role);
    if (c) return own(role).length ? copy(own(role)) : candidatesFor(c.fallback);
    throw new UnknownRoleError(role);
  }

  function resolve(role, { needs = {}, explicit = null } = {}) {
    if (explicit) {
      const target = R.normalizeTarget(explicit);
      if (!target) throw new Error(`A named model needs both a provider and a model id (got ${JSON.stringify(explicit)}).`);
      return result(role, check([target], needs), { explicit: true });
    }
    if (role === 'main') {
      if (override) return result('main', check([override], needs), { override: true });
      return result('main', check(own('main'), needs));
    }
    if (role === 'worker' || role === 'utility') {
      if (own(role).length) return result(role, check(own(role), needs));
      // An empty core role borrows from the next stronger one (§6.4); an
      // empty main never borrows from a weaker role.
      for (const from of borrowChain(role)) {
        if (own(from).length) return result(role, check(own(from), needs), { borrowedFrom: from });
      }
      return result(role, { targets: [], skipped: [] });
    }
    if (role === 'vision') {
      const need = mergeNeeds(R.ROLE_NEEDS.vision, needs);
      if (own('vision').length) return result('vision', check(own('vision'), need));
      // The first image-capable model in utility, then worker, then main.
      for (const from of ['utility', 'worker', 'main']) {
        const checked = check(own(from), need);
        if (checked.targets.length) return result('vision', { targets: [checked.targets[0]], skipped: [] }, { borrowedFrom: from });
      }
      return result('vision', { targets: [], skipped: [] });
    }
    if (role === 'imageGeneration') {
      if (own('imageGeneration').length) return result(role, check(own('imageGeneration'), needs));
      // Empty: today's imageGeneration settings keep applying (§6.4).
      return result(role, { targets: [], skipped: [] }, { useSettings: true });
    }
    const c = custom.get(role);
    if (c) {
      const need = mergeNeeds(c.needs, needs);
      if (own(role).length) return result(role, check(own(role), need));
      return { ...resolve(c.fallback, { needs: need }), role, borrowedFrom: c.fallback };
    }
    throw new UnknownRoleError(role);
  }

  function mustResolve(role, options = {}) {
    const r = resolve(role, options);
    if (!r.targets.length && !r.useSettings) throw new NoUsableModelError(r, frozen.name);
    return r;
  }

  return Object.freeze({
    profileId: frozen.id || null,
    profileName: frozen.name,
    mainOverride: override ? { ...override } : null,
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
