// src/models/profiles.js
// Profiles (spec 2026-09-27 §6.1): named sets of models assigned to roles,
// stored in settings.models.profiles with settings.models.defaultProfileId
// naming the default. A chat or case picks one; the resolver
// (./resolver.js) turns one into the models a turn may use.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const R = require('./roles');
const { createTurnModels } = require('./resolver');

const log = createLogger('models/profiles');

const PROFILE_KINDS = Object.freeze(['user', 'king-louie', 'migrated']);
const MAX_NAME = 80;
const MAX_TARGETS = 20;

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function normalizeRoleList(list, roleName) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ProfileError('BAD_ROLE', `Role "${roleName}" must be a list of models.`);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const target = R.normalizeTarget(raw);
    if (!target) throw new ProfileError('BAD_TARGET', `Every model in role "${roleName}" needs a provider and a model.`);
    const key = R.targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  if (out.length > MAX_TARGETS) throw new ProfileError('BAD_ROLE', `Role "${roleName}" holds ${out.length} models; the most is ${MAX_TARGETS}.`);
  return out;
}

function normalizeRoles(roles) {
  if (roles !== undefined && roles !== null && !isPlainObject(roles)) throw new ProfileError('BAD_ROLE', 'A profile\'s roles must be an object.');
  const source = roles || {};
  const out = {};
  for (const role of R.CORE_ROLES) out[role] = normalizeRoleList(source[role], role);
  for (const [key, list] of Object.entries(source)) {
    if (R.CORE_ROLES.includes(key)) continue;
    if (R.SPECIALIST_ROLES.includes(key) || R.isCustomRoleId(key)) {
      out[key] = normalizeRoleList(list, key);
      continue;
    }
    throw new ProfileError('BAD_ROLE', `"${key}" is not a model role. Roles are main, worker, utility, vision, imageGeneration, or a custom role id in lowercase letters, digits and dashes.`);
  }
  return out;
}

function normalizeProfile(raw, { requireId = true } = {}) {
  if (!isPlainObject(raw)) throw new ProfileError('BAD_PROFILE', 'A profile must be an object.');
  const name = String(raw.name || '').trim();
  if (!name) throw new ProfileError('BAD_NAME', 'A profile needs a name.');
  if (name.length > MAX_NAME) throw new ProfileError('BAD_NAME', `A profile name is at most ${MAX_NAME} characters.`);
  const kind = raw.kind === undefined || raw.kind === null ? 'user' : raw.kind;
  if (!PROFILE_KINDS.includes(kind)) throw new ProfileError('BAD_KIND', `A profile kind is one of ${PROFILE_KINDS.join(', ')}.`);
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (requireId && !id) throw new ProfileError('BAD_ID', 'A stored profile needs an id.');
  const profile = { id, name, kind, roles: normalizeRoles(raw.roles) };
  if (isPlainObject(raw.migration)) {
    profile.migration = {
      at: String(raw.migration.at || ''),
      notes: Array.isArray(raw.migration.notes) ? raw.migration.notes.map(String) : []
    };
  }
  return profile;
}

// A custom role (spec §6.2): data only in stage M2; its editor is M3.
function normalizeCustomRole(raw) {
  if (!isPlainObject(raw) || !R.isCustomRoleId(raw.id) || !R.isCoreRole(raw.fallback)) return null;
  const n = isPlainObject(raw.needs) ? raw.needs : {};
  const needs = {
    ...(n.toolCall === true ? { toolCall: true } : {}),
    ...(n.imageInput === true ? { imageInput: true } : {}),
    ...(Number.isFinite(n.minContext) && n.minContext > 0 ? { minContext: n.minContext } : {})
  };
  return { id: raw.id, description: String(raw.description || '').trim(), needs, fallback: raw.fallback };
}

class Profiles {
  constructor({ getSettings, setSettings, catalog = null, createId = () => crypto.randomBytes(4).toString('hex') } = {}) {
    if (typeof getSettings !== 'function' || typeof setSettings !== 'function') throw new Error('Profiles needs getSettings() and setSettings().');
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.catalog = catalog;
    this.createId = createId;
  }

  _models() {
    const models = (this.getSettings() || {}).models;
    return isPlainObject(models) ? models : {};
  }

  _write(profiles, defaultProfileId) {
    const settings = this.getSettings() || {};
    this.setSettings({ ...settings, models: { ...(settings.models || {}), profiles, defaultProfileId } });
  }

  list() {
    const stored = Array.isArray(this._models().profiles) ? this._models().profiles : [];
    const out = [];
    for (const raw of stored) {
      try {
        out.push(normalizeProfile(raw));
      } catch (err) {
        log.warn(`Ignoring stored profile ${raw?.id || '(no id)'}: ${err.message}`);
      }
    }
    return out;
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  defaultId() {
    const list = this.list();
    const wanted = this._models().defaultProfileId;
    if (wanted && list.some((p) => p.id === wanted)) return wanted;
    return list[0]?.id || null;
  }

  getDefault() {
    const id = this.defaultId();
    return id ? this.get(id) : null;
  }

  customRoles() {
    const raw = this._models().customRoles;
    return (Array.isArray(raw) ? raw : []).map(normalizeCustomRole).filter(Boolean);
  }

  _checkName(name, exceptId = null) {
    const lower = name.toLowerCase();
    if (this.list().some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)) {
      throw new ProfileError('DUPLICATE_NAME', `A profile named "${name}" already exists.`);
    }
  }

  // An effort must be one the catalog lists for that model (spec §6.1). A
  // model the catalog does not know keeps whatever effort it was given.
  _checkEfforts(profile) {
    if (!this.catalog) return;
    for (const [role, list] of Object.entries(profile.roles)) {
      for (const t of list) {
        if (!t.effort) continue;
        const entry = this.catalog.get(t.provider, t.model);
        if (!entry) continue;
        const efforts = Array.isArray(entry.reasoning?.efforts) ? entry.reasoning.efforts : [];
        if (!efforts.includes(t.effort)) {
          throw new ProfileError('BAD_EFFORT', `${t.model} in role "${role}" does not offer the effort "${t.effort}"${efforts.length ? `; it offers ${efforts.join(', ')}` : '; it has no effort setting'}.`);
        }
      }
    }
  }

  create({ name, kind = 'user', roles = {}, migration } = {}) {
    const profile = normalizeProfile({ id: `p-${this.createId()}`, name, kind, roles, ...(migration ? { migration } : {}) });
    this._checkName(profile.name);
    this._checkEfforts(profile);
    const list = this.list();
    list.push(profile);
    this._write(list, this.defaultId() || profile.id);
    return profile;
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    const next = normalizeProfile({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      id: current.id,
      kind: current.kind
    });
    this._checkName(next.name, id);
    this._checkEfforts(next);
    this._write(this.list().map((p) => (p.id === id ? next : p)), this.defaultId());
    return next;
  }

  duplicate(id, { name } = {}) {
    const source = this.get(id);
    if (!source) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    const base = String(name || `${source.name} copy`).trim();
    const taken = new Set(this.list().map((p) => p.name.toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} ${n}`;
    return this.create({ name: candidate, kind: 'user', roles: source.roles });
  }

  remove(id) {
    const list = this.list();
    const removed = list.find((p) => p.id === id);
    if (!removed) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    if (list.length === 1) throw new ProfileError('LAST_PROFILE', 'The last profile cannot be deleted.');
    const rest = list.filter((p) => p.id !== id);
    const current = this.defaultId();
    const defaultProfileId = current === id ? rest[0].id : current;
    this._write(rest, defaultProfileId);
    return { removed, defaultProfileId };
  }

  setDefault(id) {
    if (!this.get(id)) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    this._write(this.list(), id);
    return id;
  }

  // The frozen view one turn uses (spec §6.6). An unknown id falls back to
  // the default, logged: a chat or case can outlive the profile it named.
  snapshot({ profileId = null, mainOverride = null, explain } = {}) {
    let profile = profileId ? this.get(profileId) : null;
    if (profileId && !profile) log.warn(`Profile ${profileId} no longer exists; using the default profile.`);
    if (!profile) profile = this.getDefault();
    return createTurnModels({ profile, mainOverride, customRoles: this.customRoles(), explain });
  }
}

// A snapshot straight from a settings object, for a host with no Profiles
// instance (a case runtime built without a core). Read-only.
function snapshotFromSettings(settings, { profileId = null, mainOverride = null, explain } = {}) {
  const view = new Profiles({
    getSettings: () => settings || {},
    setSettings: () => { throw new Error('snapshotFromSettings is read-only.'); }
  });
  return view.snapshot({ profileId, mainOverride, explain });
}

module.exports = { Profiles, ProfileError, PROFILE_KINDS, normalizeProfile, normalizeCustomRole, snapshotFromSettings };
