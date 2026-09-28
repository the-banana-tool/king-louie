// src/models/catalog.js
// The model catalog (spec 2026-09-27 §4): what a model is, what it can do and
// what it costs. Sources merge in order, later winning field by field:
// bundled snapshot → cached live models.dev copy → Artificial Analysis scores
// → local models (Ollama) → owner overrides. Loading never touches the network.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { normalizeProvider, isOllamaCloudModelId } = require('./provider-ids');
const N = require('./normalize');
const { priceWithCost } = require('./pricing');

const log = createLogger('models/catalog');

const DEFAULT_SNAPSHOT_DIR = path.join(__dirname, 'snapshot');
const CATALOG_DEFAULTS = Object.freeze({
  fetch: true,
  refreshHours: 24,
  staleWarnDays: 30,
  modelsDevUrl: 'https://models.dev/api.json',
  scoresUrl: 'https://openrouter.ai/api/v1/models'
});

// A local Ollama model's cost, matching normalize.js's localEntry() (final
// review I4).
const LOCAL_OLLAMA_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, tiers: [] });

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Reading ${file} failed: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    log.warn(`${file} is not valid JSON; ignoring it: ${err.message}`);
    return null;
  }
}

const FETCH_TIMEOUT_MS = 30000;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const validModelsDevFile = (doc) => N.isPlainObject(doc) && N.validateModelsDev(doc.data);
const validScoresFile = (doc) => N.isPlainObject(doc) && N.isPlainObject(doc.scores);

// Later source over earlier, field by field. Overrides merge one level deeper
// so { cost: { input: 4 } } changes only the input rate.
function mergeEntry(base, patch, tag, { deep = false } = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'provider' || key === 'id' || key === 'sources') continue;
    out[key] = deep && N.isPlainObject(value) && N.isPlainObject(base[key]) ? { ...base[key], ...value } : value;
  }
  out.sources = [...new Set([...(base.sources || []), tag])];
  return out;
}

class Catalog extends EventEmitter {
  constructor() {
    super();
    this._index = new Map();
    this._local = new Map();
    this._snapshot = { modelsDev: null, scores: null };
    this._cache = { modelsDev: null, scores: null };
    this._liveThisSession = false;
    this._overridesSig = '';
    this._suppressEnsure = false;
    this._refreshInFlight = null;
    this._deps = { snapshotDir: DEFAULT_SNAPSHOT_DIR, cacheDir: null, fetch: globalThis.fetch, getSettings: () => ({}), now: () => new Date() };
  }

  load({ snapshotDir = DEFAULT_SNAPSHOT_DIR, cacheDir = null, fetch = globalThis.fetch, getSettings = () => ({}), now = () => new Date() } = {}) {
    this._deps = { snapshotDir, cacheDir, fetch, getSettings, now };
    const snapModels = readJson(path.join(snapshotDir, 'models-dev.json'));
    this._snapshot.modelsDev = validModelsDevFile(snapModels) ? snapModels : null;
    if (!this._snapshot.modelsDev) log.warn(`No usable bundled model catalog in ${snapshotDir}.`);
    const snapScores = readJson(path.join(snapshotDir, 'scores.json'));
    this._snapshot.scores = validScoresFile(snapScores) ? snapScores : null;
    if (cacheDir) {
      const cachedModels = readJson(path.join(cacheDir, 'models-dev.json'));
      this._cache.modelsDev = validModelsDevFile(cachedModels) ? cachedModels : null;
      const cachedScores = readJson(path.join(cacheDir, 'scores.json'));
      this._cache.scores = validScoresFile(cachedScores) ? cachedScores : null;
    }
    this._rebuild();
    return this;
  }

  // models.catalog from settings over the defaults.
  config() {
    const settings = this._deps.getSettings() || {};
    return { ...CATALOG_DEFAULTS, ...(N.isPlainObject(settings.models?.catalog) ? settings.models.catalog : {}) };
  }

  _overrides() {
    const overrides = (this._deps.getSettings() || {}).models?.overrides;
    return N.isPlainObject(overrides) ? overrides : {};
  }

  _rebuild() {
    const index = new Map();
    const add = (entries, tag) => {
      for (const entry of entries) {
        const key = N.entryKey(entry.provider, entry.id);
        const prev = index.get(key);
        index.set(key, prev ? mergeEntry(prev, entry, tag) : { ...entry, sources: [tag] });
      }
    };
    if (this._snapshot.modelsDev) add(N.normalizeModelsDev(this._snapshot.modelsDev.data), 'snapshot');
    if (this._cache.modelsDev) add(N.normalizeModelsDev(this._cache.modelsDev.data), 'models.dev');

    const scoreIndex = N.buildScoreIndex({ ...(this._snapshot.scores?.scores || {}), ...(this._cache.scores?.scores || {}) });
    for (const [key, entry] of index) {
      const scores = N.scoreFor(scoreIndex, entry.provider, entry.id);
      if (scores) index.set(key, { ...entry, scores: { ...N.emptyScores(), ...scores } });
    }

    for (const [provider, entries] of this._local) add(entries, provider);

    const overrides = this._overrides();
    for (const [ref, patch] of Object.entries(overrides)) {
      const colon = ref.indexOf(':');
      if (colon <= 0 || !N.isPlainObject(patch)) {
        log.warn(`Ignoring model override "${ref}": expected "<provider>:<model>" with an object value.`);
        continue;
      }
      const provider = normalizeProvider(ref.slice(0, colon));
      const id = ref.slice(colon + 1).trim();
      if (!id) continue;
      const key = N.entryKey(provider, id);
      const base = index.get(key) || { ...N.normalizeModel(provider, { id }), sources: [] };
      index.set(key, mergeEntry(base, patch, 'override', { deep: true }));
    }
    this._overridesSig = JSON.stringify(overrides);
    this._index = index;
  }

  // Overrides live in settings; a change applies on the next lookup.
  _ensureCurrent() {
    if (this._suppressEnsure) return;
    if (JSON.stringify(this._overrides()) !== this._overridesSig) this._rebuild();
  }

  // Check overrides once, then run fn() with every nested get()/list()/
  // price() call skipping that check — for a pass that looks up many
  // entries (Availability#usable() over every candidate model), so
  // getSettings() and JSON.stringify(overrides) run once, not once per
  // candidate.
  withCurrent(fn) {
    this._ensureCurrent();
    const was = this._suppressEnsure;
    this._suppressEnsure = true;
    try {
      return fn();
    } finally {
      this._suppressEnsure = was;
    }
  }

  _lookup(provider, modelId) {
    this._ensureCurrent();
    const p = normalizeProvider(provider);
    const id = String(modelId || '').trim();
    if (!p || !id) return null;
    return this._index.get(N.entryKey(p, id)) || this._index.get(N.entryKey(p, N.stripDateSuffix(id))) || null;
  }

  get(provider, modelId) {
    const entry = this._lookup(provider, modelId);
    return entry ? structuredClone(entry) : null;
  }

  list(provider = null) {
    this._ensureCurrent();
    const p = provider ? normalizeProvider(provider) : null;
    return [...this._index.values()]
      .filter((e) => !p || e.provider === p)
      .sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)))
      .map((e) => structuredClone(e));
  }

  price(provider, modelId, usage = {}) {
    const p = normalizeProvider(provider);
    const id = String(modelId || '').trim();
    // A local Ollama model is never priced at Ollama Cloud rates, even when
    // a Cloud model happens to share the exact id (for example
    // gpt-oss:20b) — only an explicit -cloud/:cloud id prices against the
    // Cloud catalog entries. This holds independent of whether a local
    // discovery has (yet) added its own entry to the index (final review I4).
    if (p === 'ollama' && id && !isOllamaCloudModelId(id)) {
      return priceWithCost(LOCAL_OLLAMA_COST, usage);
    }
    const entry = this._lookup(provider, modelId);
    return entry ? priceWithCost(entry.cost, usage) : null;
  }

  setLocalModels(provider, entries = []) {
    const p = normalizeProvider(provider);
    this._local.set(p, (Array.isArray(entries) ? entries : []).map((e) => ({ ...e, provider: p })));
    this._rebuild();
    this.emit('updated', this.status());
  }

  // Fetch the live catalog and scores (spec §4.1): at most once per
  // refreshHours unless forced, with the cached ETag, never throwing. A
  // failure or a malformed document keeps the previous copy. The startup
  // refresh and a forced "Refresh now" can overlap; a call arriving while
  // one is already in flight shares that run instead of fetching again.
  refresh(options = {}) {
    if (this._refreshInFlight) return this._refreshInFlight;
    const run = this._refresh(options).finally(() => { this._refreshInFlight = null; });
    this._refreshInFlight = run;
    return run;
  }

  async _refresh({ force = false } = {}) {
    const cfg = this.config();
    const done = () => {
      const s = this.status();
      return { source: s.source, fetchedAt: s.fetchedAt };
    };
    if (!cfg.fetch || !this._deps.cacheDir || typeof this._deps.fetch !== 'function') return done();
    const refreshHours = Number(cfg.refreshHours) > 0 ? Number(cfg.refreshHours) : CATALOG_DEFAULTS.refreshHours;
    const changed = await Promise.all([
      this._refreshOne('modelsDev', {
        url: cfg.modelsDevUrl,
        file: 'models-dev.json',
        refreshHours,
        force,
        parse: (doc) => (N.validateModelsDev(doc) ? { data: N.trimModelsDev(doc) } : null)
      }),
      this._refreshOne('scores', {
        url: cfg.scoresUrl,
        file: 'scores.json',
        refreshHours,
        force,
        parse: (doc) => (N.validateScores(doc) ? { source: 'artificial-analysis', scores: N.normalizeScores(doc) } : null)
      })
    ]);
    if (changed.some(Boolean)) {
      this._rebuild();
      this.emit('updated', this.status());
    }
    return done();
  }

  async _refreshOne(kind, { url, file, refreshHours, force, parse }) {
    const now = this._deps.now();
    const cached = this._cache[kind];
    if (!force && cached?.fetchedAt && now.getTime() - Date.parse(cached.fetchedAt) < refreshHours * 3600000) return false;
    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    let res;
    try {
      res = await this._deps.fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      log.warn(`Fetching ${url} failed; keeping the ${cached ? 'cached' : 'bundled'} copy: ${err.message}`);
      return false;
    }
    if (res.status === 304 && cached) {
      this._storeCache(kind, file, { ...cached, fetchedAt: now.toISOString() });
      return true;
    }
    if (!res.ok) {
      log.warn(`Fetching ${url} returned ${res.status}; keeping the previous copy.`);
      return false;
    }
    let doc;
    try {
      doc = await res.json();
    } catch (err) {
      log.warn(`${url} returned malformed JSON; keeping the previous copy: ${err.message}`);
      return false;
    }
    const parsed = parse(doc);
    if (!parsed) {
      log.warn(`${url} did not return a usable document; keeping the previous copy.`);
      return false;
    }
    const etag = typeof res.headers?.get === 'function' ? res.headers.get('etag') : null;
    this._storeCache(kind, file, { fetchedAt: now.toISOString(), etag: etag || null, ...parsed });
    return true;
  }

  // In memory first, so a cache dir that cannot be written still serves the
  // fetched copy for this session.
  _storeCache(kind, file, doc) {
    this._cache[kind] = doc;
    if (kind === 'modelsDev') this._liveThisSession = true;
    const target = path.join(this._deps.cacheDir, file);
    try {
      writeJsonAtomic(target, doc);
    } catch (err) {
      log.warn(`Writing ${target} failed; the fetched catalog lasts until restart: ${err.message}`);
    }
  }

  status() {
    const cfg = this.config();
    const source = this._liveThisSession ? 'live' : (this._cache.modelsDev ? 'cache' : 'snapshot');
    const fetchedAt = this._cache.modelsDev?.fetchedAt || null;
    const snapshotDate = this._snapshot.modelsDev?.fetchedAt || null;
    const effective = fetchedAt || snapshotDate;
    const ageMs = effective ? this._deps.now().getTime() - Date.parse(effective) : Infinity;
    return { source, fetchedAt, snapshotDate, stale: ageMs > Number(cfg.staleWarnDays) * 86400000, models: this._index.size };
  }
}

module.exports = { Catalog, CATALOG_DEFAULTS, DEFAULT_SNAPSHOT_DIR };
