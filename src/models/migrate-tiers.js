// src/models/migrate-tiers.js
// The one-time move from tiers to profiles (spec 2026-09-27 §13). The fast,
// standard and smart tiers become one "Migrated settings" profile; a saved
// model id the catalog no longer lists maps to the catalog's current model
// of the same family when exactly one family and one newest model match,
// else it is kept and the profile editor shows it unusable with the reason.
// Every mapping and every kept stale id is a note on the profile.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const R = require('./roles');
const { stripDateSuffix } = require('./normalize');

const log = createLogger('models/migrate');

const TIERS = Object.freeze(['fast', 'standard', 'smart']);
const LEGACY_TOP_KEYS = Object.freeze(['activeProvider', 'providerModels', 'inference']);

// What King Louie shipped before stage M2. The old mergeSettings filled these
// in for anything a stored setting left out, so they are what actually ran.
const LEGACY_DEFAULTS = Object.freeze({
  activeProvider: 'openai',
  providerModels: Object.freeze({
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-5',
    copilot: 'gpt-5.4',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    ollama: '',
    gemini: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini',
    xai: 'grok-4.3',
    deepseek: 'deepseek-flash',
    qwen: 'qwen-plus',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/gpt-oss-120b',
    cohere: 'command-a-03-2025'
  }),
  activeTier: 'standard',
  tierMap: Object.freeze({
    fast: Object.freeze({ provider: 'groq', model: 'llama-3.3-70b-versatile' }),
    standard: Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5' }),
    smart: Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5' })
  }),
  timeoutsMs: Object.freeze({ fast: 15000, standard: 30000, smart: 90000 })
});

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function hasLegacyModelSettings(raw) {
  return isPlainObject(raw) && LEGACY_TOP_KEYS.some((key) => raw[key] !== undefined);
}

function needsMigration(raw) {
  const profiles = isPlainObject(raw) && isPlainObject(raw.models) ? raw.models.profiles : null;
  return !(Array.isArray(profiles) && profiles.length > 0);
}

function legacyView(raw) {
  const inference = isPlainObject(raw.inference) ? raw.inference : {};
  const tier = String(inference.activeTier || '').toLowerCase();
  return {
    activeProvider: String(raw.activeProvider || LEGACY_DEFAULTS.activeProvider).toLowerCase(),
    providerModels: { ...LEGACY_DEFAULTS.providerModels, ...(isPlainObject(raw.providerModels) ? raw.providerModels : {}) },
    activeTier: TIERS.includes(tier) ? tier : LEGACY_DEFAULTS.activeTier,
    tierMap: { ...LEGACY_DEFAULTS.tierMap, ...(isPlainObject(inference.tierMap) ? inference.tierMap : {}) },
    timeoutsMs: { ...LEGACY_DEFAULTS.timeoutsMs, ...(isPlainObject(inference.timeoutsMs) ? inference.timeoutsMs : {}) }
  };
}

// The target a tier resolved to, exactly as InferenceRouter#resolve did.
function tierTarget(legacy, tier) {
  const cfg = isPlainObject(legacy.tierMap[tier]) ? legacy.tierMap[tier] : {};
  const provider = String(cfg.provider || legacy.activeProvider || 'openai').trim().toLowerCase();
  const model = String(cfg.model || legacy.providerModels[provider] || '').trim();
  return { provider, model };
}

function inAccount(list, id) {
  return list.includes(id) || list.some((m) => stripDateSuffix(m) === id || m === stripDateSuffix(id));
}

function mapStaleTarget(target, { catalog = null, accountModels = {} } = {}) {
  const keep = { target, note: null };
  if (!catalog || target.provider === 'ollama') return keep;
  if (catalog.get(target.provider, target.model)) return keep;
  const listed = Array.isArray(accountModels[target.provider]) ? accountModels[target.provider] : [];
  if (inAccount(listed, target.model)) return keep;
  const label = R.targetLabel(target);
  const entries = catalog.list(target.provider);
  const families = [...new Set(entries.map((e) => e.family).filter((f) => f && target.model.startsWith(`${f}-`)))];
  const longest = Math.max(0, ...families.map((f) => f.length));
  const best = families.filter((f) => f.length === longest);
  if (best.length !== 1) return { target, note: `${label} is not in the model catalog; kept as is (no single model family matches it).` };
  const family = best[0];
  // One entry per base id, preferring the undated alias over its dated twin.
  const byBase = new Map();
  for (const e of entries.filter((x) => x.family === family)) {
    const base = stripDateSuffix(e.id);
    if (!byBase.has(base) || e.id === base) byBase.set(base, e);
  }
  const ranked = [...byBase.values()].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  const [top, next] = ranked;
  const unambiguous = Boolean(top) && (ranked.length === 1 || (Boolean(top.releaseDate) && top.releaseDate !== (next.releaseDate || '')));
  if (!unambiguous) return { target, note: `${label} is not in the model catalog; kept as is (no single newest ${family} model).` };
  const mapped = { ...target, model: top.id };
  return { target: mapped, note: `${label} is not in the model catalog; mapped to ${R.targetLabel(mapped)}, the newest ${family} model.` };
}

const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

function dedupe(list) {
  const seen = new Set();
  return list.filter((t) => {
    if (!t) return false;
    const key = R.targetKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function migrateTierSettings(raw, { catalog = null, accountModels = {}, freshMain = [], now = () => new Date(), createId = () => crypto.randomBytes(4).toString('hex') } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const models = isPlainObject(source.models) ? source.models : {};
  const id = `p-${createId()}`;
  if (!hasLegacyModelSettings(source)) {
    // A fresh install (spec §13 has nothing to migrate): main lists each
    // provider's own default model, in the app's provider order, so the
    // first provider the owner adds a key for answers at once; worker and
    // utility stay empty and borrow from main (§6.4).
    const main = dedupe((Array.isArray(freshMain) ? freshMain : []).map(R.normalizeTarget));
    const profile = { id, name: 'Default', kind: 'user', roles: { main, worker: [], utility: [] } };
    return { fresh: true, profile, notes: [], settings: { ...source, models: { ...models, profiles: [profile], defaultProfileId: id } } };
  }
  const legacy = legacyView(source);
  const notes = [];
  const byTier = {};
  for (const tier of TIERS) {
    const found = tierTarget(legacy, tier);
    if (!found.model) {
      notes.push(`${tier} tier had no model for ${found.provider}; it was left out.`);
      byTier[tier] = null;
      continue;
    }
    const { target, note } = mapStaleTarget({ provider: found.provider, model: found.model, effort: null }, { catalog, accountModels });
    if (note) notes.push(`${tier} tier: ${note}`);
    byTier[tier] = target;
  }
  const roles = {
    // Main: what chat used (the active tier), then the smart tier (§13 step 1).
    main: dedupe([byTier[legacy.activeTier], byTier.smart]),
    worker: dedupe([byTier.standard]),
    utility: dedupe([byTier.fast])
  };
  const vision = R.normalizeTarget(source.cases?.ingest?.vision);
  if (vision) roles.vision = [vision];
  const profile = { id, name: 'Migrated settings', kind: 'migrated', roles, migration: { at: now().toISOString(), notes } };
  const roleTimeoutsMs = {
    main: positive(legacy.timeoutsMs.smart, R.DEFAULT_ROLE_TIMEOUTS_MS.main),
    worker: positive(legacy.timeoutsMs.standard, R.DEFAULT_ROLE_TIMEOUTS_MS.worker),
    utility: positive(legacy.timeoutsMs.fast, R.DEFAULT_ROLE_TIMEOUTS_MS.utility)
  };
  return {
    fresh: false,
    profile,
    notes,
    settings: { ...source, models: { ...models, profiles: [profile], defaultProfileId: id, roleTimeoutsMs } }
  };
}

// §13 step 6. The whole `inference` object goes: every key in it is listed.
function stripLegacyKeys(raw) {
  const out = { ...(isPlainObject(raw) ? raw : {}) };
  for (const key of LEGACY_TOP_KEYS) delete out[key];
  if (isPlainObject(out.advisor) && 'model' in out.advisor) {
    const { model: _model, ...advisor } = out.advisor;
    out.advisor = advisor;
  }
  if (isPlainObject(out.cases) && isPlainObject(out.cases.ingest) && 'vision' in out.cases.ingest) {
    const { vision: _vision, ...ingest } = out.cases.ingest;
    out.cases = { ...out.cases, ingest };
  }
  return out;
}

// Never throws. A failed first write leaves the stored settings as they
// were and is retried at the next start (profiles are still absent); a
// failed second write leaves the old keys behind, which nothing reads.
function runTierMigration({ readRaw, writeRaw, removeLegacy = true, ...options } = {}) {
  let raw;
  try {
    raw = readRaw();
  } catch (err) {
    log.error(`Reading settings for the tier migration failed: ${err.message}`);
    return { migrated: false, error: err.message };
  }
  if (!needsMigration(raw)) return { migrated: false };
  let result;
  try {
    result = migrateTierSettings(raw, options);
    writeRaw(result.settings);
  } catch (err) {
    log.error(`Moving the tier settings to a profile failed; the old settings are untouched and the move is retried at the next start: ${err.message}`);
    return { migrated: false, error: err.message };
  }
  if (removeLegacy) {
    try {
      writeRaw(stripLegacyKeys(result.settings));
    } catch (err) {
      log.warn(`Removing the old tier settings failed; they are ignored from now on: ${err.message}`);
    }
  }
  if (result.fresh) log.info('No earlier model settings: created the Default profile from each provider\'s default model.');
  else log.info(`Moved the tier settings to the profile "${result.profile.name}".`);
  for (const note of result.notes) log.info(`Migration: ${note}`);
  return { migrated: true, fresh: result.fresh, profile: result.profile, notes: result.notes };
}

module.exports = {
  LEGACY_DEFAULTS,
  hasLegacyModelSettings,
  needsMigration,
  mapStaleTarget,
  migrateTierSettings,
  stripLegacyKeys,
  runTierMigration
};
