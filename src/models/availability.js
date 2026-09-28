// src/models/availability.js
// Which providers and models King Louie can use right now (spec 2026-09-27
// §5). A model is usable for a job when its provider is credentialed, its
// last connection test passed, it is in the list the provider returned for
// this account, and it meets the job's needs.
const EventEmitter = require('events');
const { createLogger } = require('../logging');
const { KL_PROVIDERS, DEFAULT_OLLAMA_BASE_URL, normalizeProvider } = require('./provider-ids');
const { stripDateSuffix, localEntry } = require('./normalize');
const { discoverOllama } = require('./ollama');

const log = createLogger('models/availability');
const DEFAULT_TEST_TIMEOUT_MS = 20000;
const DEFAULT_RETEST_HOURS = 24;
const NO_TOKEN = 'No token saved for this provider.';

class Availability extends EventEmitter {
  constructor({
    catalog = null,
    hasCredential,
    createProvider,
    getStatuses,
    setStatuses,
    getSettings = () => ({}),
    fetch = globalThis.fetch,
    now = () => new Date(),
    labels = {},
    testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS
  } = {}) {
    super();
    for (const [name, fn] of Object.entries({ hasCredential, createProvider, getStatuses, setStatuses })) {
      if (typeof fn !== 'function') throw new Error(`Availability needs ${name}().`);
    }
    this.catalog = catalog;
    this.hasCredential = hasCredential;
    this.createProvider = createProvider;
    this.getStatuses = getStatuses;
    this.setStatuses = setStatuses;
    this.getSettings = getSettings;
    this.fetch = fetch;
    this.now = now;
    this.labels = labels || {};
    this.testTimeoutMs = testTimeoutMs;
    this._inFlight = new Map();
  }

  label(provider) {
    return this.labels[provider] || provider;
  }

  _settings() {
    return this.getSettings() || {};
  }

  ollamaBaseUrl() {
    return String(this._settings().models?.ollama?.baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  }

  status(provider) {
    const s = (this.getStatuses() || {})[normalizeProvider(provider)];
    return s && typeof s === 'object' ? s : null;
  }

  statusAll() {
    return Object.fromEntries(KL_PROVIDERS.map((p) => [p, this.status(p)]));
  }

  _store(provider, status) {
    this.setStatuses({ ...(this.getStatuses() || {}), [provider]: status });
    this.emit('changed', { provider, status });
    return status;
  }

  forget(provider) {
    const p = normalizeProvider(provider);
    const all = { ...(this.getStatuses() || {}) };
    if (!(p in all)) return;
    delete all[p];
    this.setStatuses(all);
    this.emit('changed', { provider: p, status: null });
  }

  // The one connection test (spec §5.2): listModels(), which proves the
  // credential and returns the account's models without spending tokens.
  // Ollama's test is discovery. Concurrent calls share one run.
  test(provider) {
    const p = normalizeProvider(provider);
    if (!KL_PROVIDERS.includes(p)) return Promise.reject(new Error(`Unknown provider "${provider}".`));
    if (this._inFlight.has(p)) return this._inFlight.get(p);
    const run = this._test(p).finally(() => this._inFlight.delete(p));
    this._inFlight.set(p, run);
    return run;
  }

  async _test(p) {
    const checkedAt = this.now().toISOString();
    if (!this.hasCredential(p)) {
      return this._store(p, { ok: false, error: NO_TOKEN, message: NO_TOKEN, checkedAt, models: [] });
    }
    try {
      const signal = AbortSignal.timeout(this.testTimeoutMs);
      let models;
      if (p === 'ollama') {
        const found = await discoverOllama({ baseUrl: this.ollamaBaseUrl(), fetch: this.fetch, signal });
        if (this.catalog && typeof this.catalog.setLocalModels === 'function') {
          this.catalog.setLocalModels('ollama', found.map((m) => localEntry('ollama', m)));
        }
        models = found.map((m) => m.id);
      } else {
        const instance = await this.createProvider(p);
        models = await instance.listModels({ abortSignal: signal });
      }
      const list = [...new Set((Array.isArray(models) ? models : []).map(String).filter(Boolean))].sort();
      return this._store(p, {
        ok: true,
        error: null,
        message: `Connected: ${list.length} model${list.length === 1 ? '' : 's'}.`,
        checkedAt,
        models: list
      });
    } catch (err) {
      // A 404/405/501 from the listing call itself means this provider does
      // not support listing models at all — not that the credential is bad.
      // Before this, that answer stored a failed test, which blocked every
      // later send until a manual retest (spec 2026-09-27 §5.1 rule 3, final
      // review I1). The account's list is simply unknown; explain()'s rule 3
      // already falls back to the catalog for an empty list.
      const status = Number.isFinite(err?.status) ? err.status : null;
      if (p !== 'ollama' && [404, 405, 501].includes(status)) {
        const message = `${this.label(p)} does not support listing models; using the catalog instead.`;
        return this._store(p, { ok: true, error: null, message, checkedAt, models: [] });
      }
      const message = err?.message || String(err);
      log.warn(`${this.label(p)} connection test failed: ${message}`);
      return this._store(p, {
        ok: false,
        error: message,
        message,
        checkedAt,
        models: [],
        ...(status !== null ? { httpStatus: status } : {})
      });
    }
  }

  // An Ollama never set up (no stored status) is left alone: not every owner
  // runs one, and probing an address nobody configured just logs noise.
  // Shared by testAll and retestStale.
  _skipUnsetupOllama(p) {
    return p === 'ollama' && !this.status(p);
  }

  async testAll() {
    const targets = KL_PROVIDERS.filter((p) => this.hasCredential(p) && !this._skipUnsetupOllama(p));
    const results = await Promise.all(targets.map((p) => this.test(p)));
    return Object.fromEntries(targets.map((p, i) => [p, results[i]]));
  }

  // Before a send: a provider never tested (a key saved in another process,
  // a profile from before stage M1) is tested now rather than refused.
  async ensureTested(provider) {
    const p = normalizeProvider(provider);
    return this.status(p) || this.test(p);
  }

  _retestHours() {
    const hours = Number(this._settings().models?.availability?.retestHours);
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RETEST_HOURS;
  }

  // At start (spec §5.2): providers whose last test is older than retestHours.
  // An Ollama that was never tested is left alone: not every owner runs one.
  async retestStale() {
    const maxAge = this._retestHours() * 3600000;
    const nowMs = this.now().getTime();
    const due = KL_PROVIDERS.filter((p) => {
      if (!this.hasCredential(p) || this._skipUnsetupOllama(p)) return false;
      const s = this.status(p);
      return !s || !s.checkedAt || nowMs - Date.parse(s.checkedAt) >= maxAge;
    });
    await Promise.all(due.map((p) => this.test(p)));
    return due;
  }

  // A 401 or 403 during use (spec §5.3): unusable at once, until the key is fixed and retested.
  markAuthFailure(provider, error) {
    const p = normalizeProvider(provider);
    if (!KL_PROVIDERS.includes(p)) return null;
    const prev = this.status(p) || {};
    const detail = error?.message || String(error || 'rejected');
    const message = `${this.label(p)} rejected the key: ${detail}`;
    return this._store(p, {
      ...prev,
      ok: false,
      error: message,
      message,
      checkedAt: this.now().toISOString(),
      models: Array.isArray(prev.models) ? prev.models : [],
      authFailed: true
    });
  }

  // Rule 3: in the account's list (a dated id matches its alias both ways).
  // An empty or missing list means the catalog's entries count, except for
  // Ollama, where an empty list means nothing is installed.
  _reachable(p, id, status) {
    const models = Array.isArray(status.models) ? status.models : [];
    if (models.length === 0) return p === 'ollama' ? false : Boolean(this.catalog && this.catalog.get(p, id));
    if (models.includes(id)) return true;
    const base = stripDateSuffix(id);
    if (models.some((m) => m === base || stripDateSuffix(m) === id)) return true;
    // Ollama tags an untagged name ":latest" implicitly, and accepts either
    // form for the other — "llama3.2" and "llama3.2:latest" name the same
    // model both ways (minor, final review).
    if (p === 'ollama') {
      const bare = id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id;
      if (models.some((m) => (m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m) === bare)) return true;
    }
    return false;
  }

  explain(provider, modelId, { needs = {} } = {}) {
    const p = normalizeProvider(provider);
    const id = String(modelId || '').trim();
    const reasons = [];
    const notes = [];
    if (!KL_PROVIDERS.includes(p)) return { usable: false, reasons: [`Unknown provider "${provider}".`], notes, entry: null };
    const label = this.label(p);
    if (!id) reasons.push(`No model is chosen for ${label}.`);
    if (!this.hasCredential(p)) {
      reasons.push(`No token saved for ${label}.`);
    } else {
      const s = this.status(p);
      if (!s) reasons.push(`${label} has not been tested yet.`);
      else if (!s.ok) reasons.push(`${label} connection test failed${s.checkedAt ? ` at ${s.checkedAt}` : ''}: ${s.error || s.message || 'unknown error'}`);
      else if (id && !this._reachable(p, id, s)) reasons.push(`${id} is not in this ${label} account's model list.`);
    }
    const entry = id && this.catalog ? this.catalog.get(p, id) : null;
    if (id && !entry) notes.push(`${id} is not in the model catalog: unpriced, capabilities unknown.`);
    if (entry) {
      if (needs.toolCall && entry.toolCall !== true) reasons.push(`${id} has no tool calling.`);
      if (needs.imageInput && !entry.input.includes('image')) reasons.push(`${id} takes no image input.`);
      if (needs.textOutput && !entry.output.includes('text')) reasons.push(`${id} does not produce text.`);
      if (Number.isFinite(needs.minContext) && !(entry.limits.context >= needs.minContext)) {
        reasons.push(`${id} has a context of ${entry.limits.context ?? 'unknown'} tokens, below ${needs.minContext}.`);
      }
    }
    return { usable: reasons.length === 0, reasons, notes, entry };
  }

  // An id the owner listed in models.overrides (settings key "<provider>:<id>"),
  // regardless of whether the catalog otherwise knows it.
  _hasOverride(p, id) {
    const overrides = this._settings().models?.overrides;
    return Boolean(overrides && typeof overrides === 'object' && Object.prototype.hasOwnProperty.call(overrides, `${p}:${id}`));
  }

  usable({ needs = {} } = {}) {
    // One overrides check for the whole pass, not one per candidate model:
    // explain() below calls catalog.get()/list() once per candidate, and
    // each of those otherwise re-checks settings for an overrides change.
    const build = () => {
      const out = [];
      for (const p of KL_PROVIDERS) {
        if (!this.hasCredential(p)) continue;
        const s = this.status(p);
        if (!s || !s.ok) continue;
        const listed = Array.isArray(s.models) ? s.models : [];
        const ids = listed.length ? listed : (p === 'ollama' || !this.catalog ? [] : this.catalog.list(p).map((e) => e.id));
        for (const id of ids) {
          const verdict = this.explain(p, id, { needs });
          if (!verdict.usable) continue;
          // The account's own model list can include non-chat ids the
          // catalog has never heard of (OpenAI's /v1/models mixes in
          // embedding, TTS, whisper and image model ids). explain() lets an
          // unknown id through, unpriced, rather than refusing it — right
          // for a single already-chosen model, wrong for a list a caller
          // wants to pick a chat model from. A caller that needs text
          // output drops those here, except a local Ollama model (whose
          // only source of truth is discovery, not the catalog) or an id
          // the owner explicitly overrode (controller ruling, Task 6 review).
          if (needs.textOutput && !verdict.entry && p !== 'ollama' && !this._hasOverride(p, id)) continue;
          const e = verdict.entry;
          out.push({
            provider: p,
            model: id,
            name: e?.name || id,
            known: Boolean(e),
            priced: Boolean(e?.cost),
            cost: e?.cost || null,
            context: e?.limits?.context ?? null,
            toolCall: e ? e.toolCall === true : null,
            imageInput: e ? e.input.includes('image') : null,
            local: Boolean(e?.local)
          });
        }
      }
      return out;
    };
    return this.catalog && typeof this.catalog.withCurrent === 'function' ? this.catalog.withCurrent(build) : build();
  }
}

module.exports = { Availability };
