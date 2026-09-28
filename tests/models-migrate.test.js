// tests/models-migrate.test.js
// The one-time tier migration (spec 2026-09-27 §13): the tiers become one
// "Migrated settings" profile, stale model ids map to the catalog's current
// model of the same family where that is unambiguous, tier timeouts become
// role timeouts, and the old keys go only after the new ones are written.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  migrateTierSettings, stripLegacyKeys, runTierMigration, needsMigration, mapStaleTarget, LEGACY_DEFAULTS
} = require('../src/models/migrate-tiers');
const { createTurnModels } = require('../src/models/resolver');
const { Availability } = require('../src/models/availability');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const now = () => new Date('2026-09-27T12:00:00.000Z');
const opts = (extra = {}) => ({ catalog: fixtureCatalog(), now, createId: () => 'abc', ...extra });

// Shaped like an owner profile from before M2 (spec §16): standard tier on
// gpt-5.5 and active, smart on a Sonnet id the catalog no longer lists, fast
// on Groq, smart routing and the LLM router switched on.
const ownerShaped = () => ({
  activeProvider: 'groq',
  providerModels: { openai: 'gpt-4o-mini', groq: 'llama-3.3-70b-versatile' },
  inference: {
    activeTier: 'standard',
    tierMap: {
      fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      standard: { provider: 'openai', model: 'gpt-5.5' },
      smart: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }
    },
    timeoutsMs: { fast: 10000, standard: 40000, smart: 120000 },
    smartRouting: { enabled: true, rules: [] },
    llmRouting: { enabled: true, costSensitivity: 'medium' },
    agentLoopModel: 'gpt-4o-mini'
  },
  advisor: { enabled: false, model: 'gpt-4o' },
  cases: { timeZone: 'UTC', ingest: { maxPages: 100, vision: { provider: 'openai', model: 'gpt-5.5' } } },
  models: { ollama: { baseUrl: 'http://127.0.0.1:11434' } }
});

describe('migrateTierSettings', () => {
  it('builds main, worker, utility and vision from the tiers, with the notes the owner sees', () => {
    const r = migrateTierSettings(ownerShaped(), opts());
    assert.strictEqual(r.fresh, false);
    assert.deepStrictEqual(r.profile.roles, {
      main: [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')],
      worker: [t('openai', 'gpt-5.5')],
      utility: [t('groq', 'llama-3.3-70b-versatile')],
      vision: [t('openai', 'gpt-5.5')]
    });
    assert.deepStrictEqual([r.profile.id, r.profile.name, r.profile.kind], ['p-abc', 'Migrated settings', 'migrated']);
    assert.strictEqual(r.profile.migration.at, '2026-09-27T12:00:00.000Z');
    assert.ok(r.notes.some((n) => n === 'smart tier: anthropic/claude-sonnet-4-20250514 is not in the model catalog; mapped to anthropic/claude-sonnet-4-5, the newest claude-sonnet model.'), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => /^fast tier: groq\/llama-3\.3-70b-versatile is not in the model catalog; kept as is/.test(n)), r.notes.join('\n'));
    assert.deepStrictEqual(r.profile.migration.notes, r.notes);
    assert.deepStrictEqual(r.settings.models.profiles, [r.profile]);
    assert.strictEqual(r.settings.models.defaultProfileId, 'p-abc');
    assert.deepStrictEqual(r.settings.models.roleTimeoutsMs, { main: 120000, worker: 40000, utility: 10000 });
    assert.strictEqual(r.settings.models.ollama.baseUrl, 'http://127.0.0.1:11434', 'other models keys are kept');
    assert.ok(r.settings.inference, 'the legacy keys stay until the second write');
  });

  it('with a failing Groq key: gpt-5.5 answers main first, and utility shows Groq unusable with the reason', () => {
    const catalog = fixtureCatalog();
    const r = migrateTierSettings(ownerShaped(), opts({ catalog }));
    const statuses = {
      openai: { ok: true, checkedAt: '2026-09-27T11:00:00.000Z', models: [] },
      anthropic: { ok: true, checkedAt: '2026-09-27T11:00:00.000Z', models: [] },
      groq: { ok: false, error: 'Invalid API Key', message: 'Invalid API Key', checkedAt: '2026-09-27T11:00:00.000Z', models: [] }
    };
    const availability = new Availability({
      catalog,
      labels: { groq: 'Groq' },
      hasCredential: () => true,
      createProvider: async () => { throw new Error('no provider calls here'); },
      getStatuses: () => statuses,
      setStatuses: () => {}
    });
    const models = createTurnModels({ profile: r.profile, explain: (p, m, o) => availability.explain(p, m, o) });
    assert.deepStrictEqual(models.resolve('main').targets, [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')]);
    const utility = models.resolve('utility');
    assert.deepStrictEqual(utility.targets, []);
    assert.strictEqual(utility.skipped.length, 1);
    assert.deepStrictEqual(utility.skipped[0].target, t('groq', 'llama-3.3-70b-versatile'));
    assert.match(utility.skipped[0].reasons[0], /Groq connection test failed at 2026-09-27T11:00:00\.000Z: Invalid API Key/);
  });

  it('puts only the active tier in main when the active tier is smart', () => {
    const raw = ownerShaped();
    raw.inference.activeTier = 'smart';
    const r = migrateTierSettings(raw, opts());
    assert.deepStrictEqual(r.profile.roles.main, [t('anthropic', 'claude-sonnet-4-5')]);
    assert.strictEqual(r.notes.filter((n) => n.startsWith('smart tier:')).length, 1, 'one note per tier');
  });

  it('fills a missing tier, provider or model from what shipped before M2', () => {
    const r = migrateTierSettings({ inference: { activeTier: 'fast' } }, opts({ catalog: null }));
    assert.deepStrictEqual(r.profile.roles.main, [t('groq', 'llama-3.3-70b-versatile'), t('anthropic', 'claude-sonnet-5')]);
    assert.deepStrictEqual(r.profile.roles.worker, [t('anthropic', 'claude-sonnet-5')]);
    assert.deepStrictEqual(r.settings.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 15000 });
    const byProvider = migrateTierSettings({ activeProvider: 'mistral', inference: { tierMap: { standard: { provider: 'openai' } } } }, opts({ catalog: null }));
    assert.deepStrictEqual(byProvider.profile.roles.worker, [t('openai', 'gpt-4o-mini')]);
  });

  it('leaves out a tier with no model, and says so', () => {
    const r = migrateTierSettings({ activeProvider: 'ollama', providerModels: { ollama: '' }, inference: { tierMap: { fast: { provider: 'ollama' } } } }, opts());
    assert.deepStrictEqual(r.profile.roles.utility, []);
    assert.ok(r.notes.includes('fast tier had no model for ollama; it was left out.'), r.notes.join('\n'));
  });

  it('a tier whose stored model is empty falls back to the provider\'s default, as the old runtime did, with a note (m1)', () => {
    const raw = { inference: { activeTier: 'standard', tierMap: { standard: { provider: 'openai', model: '' } } }, providerModels: { openai: '' } };
    const r = migrateTierSettings(raw, opts({ catalog: null }));
    assert.deepStrictEqual(r.profile.roles.main[0], t('openai', 'gpt-4o-mini'));
    assert.ok(r.notes.includes('standard tier had no model for openai; using openai\'s default model, gpt-4o-mini, as before.'), r.notes.join('\n'));
    // A provider with no shipped default takes the host's own default model.
    const other = migrateTierSettings({ inference: { tierMap: { fast: { provider: 'kl-other', model: '' } } }, providerModels: { 'kl-other': '' } }, opts({ catalog: null, providerDefaults: { 'kl-other': 'other-default' } }));
    assert.deepStrictEqual(other.profile.roles.utility, [t('kl-other', 'other-default')]);
    assert.ok(other.notes.some((n) => n.startsWith('fast tier had no model for kl-other; using kl-other\'s default model, other-default')), other.notes.join('\n'));
  });

  it('notes each removed routing setting the owner had set, and none that were off (m2)', () => {
    const r = migrateTierSettings(ownerShaped(), opts());
    for (const note of [
      'Smart routing was on; it was removed, so every message goes to main as written, prefixes included.',
      'The LLM model router was on; it was removed, and main answers every message.',
      'The agent loop model setting (gpt-4o-mini) was removed; the agent loop runs on main.',
      'The advisor model setting (gpt-4o) was removed; the advisor reviews on the turn\'s main model.'
    ]) assert.ok(r.notes.includes(note), `${note}\n---\n${r.notes.join('\n')}`);
    assert.deepStrictEqual(r.profile.migration.notes, r.notes);
    const rules = ownerShaped();
    rules.inference.smartRouting = { enabled: false, rules: [{ prefix: '/code', tier: 'smart' }] };
    rules.inference.llmRouting = { enabled: false };
    delete rules.inference.agentLoopModel;
    rules.advisor = { enabled: true, model: 'gpt-5.5' };
    const quiet = migrateTierSettings(rules, opts());
    assert.ok(quiet.notes.includes('Smart routing was off with 1 rule; it was removed, so every message goes to main as written, prefixes included.'), quiet.notes.join('\n'));
    assert.ok(!quiet.notes.some((n) => /LLM model router|agent loop model|advisor model/.test(n)), quiet.notes.join('\n'));
    // A store with no tier keys can still hold an advisor model.
    const fresh = migrateTierSettings({ advisor: { enabled: true, model: 'gpt-4o' } }, opts({ freshMain: [t('openai', 'gpt-5.5')] }));
    assert.strictEqual(fresh.fresh, true);
    assert.deepStrictEqual(fresh.profile.migration.notes, ['The advisor model setting (gpt-4o) was removed; the advisor reviews on the turn\'s main model.']);
    assert.strictEqual('migration' in migrateTierSettings({}, opts({ freshMain: [t('openai', 'gpt-5.5')] })).profile, false);
  });

  it('keeps a stale id the account still lists, without a note', () => {
    const r = migrateTierSettings(ownerShaped(), opts({ accountModels: { anthropic: ['claude-sonnet-4-20250514'] } }));
    assert.deepStrictEqual(r.profile.roles.main[1], t('anthropic', 'claude-sonnet-4-20250514'));
    assert.ok(!r.notes.some((n) => n.startsWith('smart tier:')));
  });

  it('gives a fresh install a Default profile whose main lists each provider\'s default model', () => {
    const freshMain = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'Anthropic', model: 'claude-sonnet-5' }, { provider: 'ollama', model: '' }];
    const r = migrateTierSettings({ models: { catalog: { fetch: false } } }, opts({ freshMain }));
    assert.strictEqual(r.fresh, true);
    assert.deepStrictEqual(r.profile, {
      id: 'p-abc',
      name: 'Default',
      kind: 'user',
      roles: { main: [t('openai', 'gpt-4o-mini'), t('anthropic', 'claude-sonnet-5')], worker: [], utility: [] }
    });
    assert.deepStrictEqual(r.notes, []);
    assert.strictEqual(r.settings.models.catalog.fetch, false);
    assert.strictEqual(r.settings.models.defaultProfileId, 'p-abc');
  });
});

describe('mapStaleTarget', () => {
  it('maps only an unambiguous family, never a local Ollama model or a known id', () => {
    const catalog = fixtureCatalog();
    assert.deepStrictEqual(mapStaleTarget(t('openai', 'gpt-5.5'), { catalog }), { target: t('openai', 'gpt-5.5'), note: null });
    assert.deepStrictEqual(mapStaleTarget(t('ollama', 'llama3.2:latest'), { catalog }), { target: t('ollama', 'llama3.2:latest'), note: null });
    assert.deepStrictEqual(mapStaleTarget(t('anthropic', 'claude-haiku-3'), { catalog }).target, t('anthropic', 'claude-haiku-4-5'));
    assert.deepStrictEqual(mapStaleTarget(t('anthropic', 'claude-sonnet-4-20250514'), { catalog }).target, t('anthropic', 'claude-sonnet-4-5'));
    const kept = mapStaleTarget(t('openai', 'davinci-002'), { catalog });
    assert.deepStrictEqual(kept.target, t('openai', 'davinci-002'));
    assert.match(kept.note, /kept as is/);
    assert.deepStrictEqual(mapStaleTarget(t('anthropic', 'claude-sonnet-4-20250514'), { catalog: null }).note, null);
  });

  // Fix round 1: models.dev family names are not id prefixes — gpt-5-mini,
  // gpt-4o-mini and gpt-4.1-mini all share family "gpt" (never "gpt-mini-"
  // as a literal prefix) in this fixture, just as they do in the real
  // catalog. A stale mini or nano id must map within its own shape, never
  // to a full-size model of the same family.
  it('matches a retired id by shape, not by treating the family name as an id prefix', () => {
    const catalog = fixtureCatalog();
    const mini = mapStaleTarget(t('openai', 'gpt-4.1-mini-2024-01-01'), { catalog });
    assert.deepStrictEqual(mini.target, t('openai', 'gpt-5.4-mini'));
    assert.match(mini.note, /mapped to openai\/gpt-5\.4-mini/);
    const nano = mapStaleTarget(t('openai', 'gpt-4.1-nano-2024-01-01'), { catalog });
    assert.deepStrictEqual(nano.target, t('openai', 'gpt-5.4-nano'));
    assert.match(nano.note, /mapped to openai\/gpt-5\.4-nano/);
  });

  it('keeps the id, with a reason, on a release-date tie or when the matching models have no release date', () => {
    const catalog = fixtureCatalog();
    // gpt-6-flex and gpt-7-flex share a shape and a release date: a tie.
    const tie = mapStaleTarget(t('openai', 'gpt-8-flex'), { catalog });
    assert.deepStrictEqual(tie.target, t('openai', 'gpt-8-flex'));
    assert.match(tie.note, /kept as is/);
    // gpt-6-lite and gpt-7-lite share a shape but neither has a release date.
    const noDate = mapStaleTarget(t('openai', 'gpt-8-lite'), { catalog });
    assert.deepStrictEqual(noDate.target, t('openai', 'gpt-8-lite'));
    assert.match(noDate.note, /kept as is/);
  });
});

describe('stripLegacyKeys', () => {
  it('removes exactly the §13 step 6 keys', () => {
    const out = stripLegacyKeys(ownerShaped());
    assert.strictEqual('activeProvider' in out, false);
    assert.strictEqual('providerModels' in out, false);
    assert.strictEqual('inference' in out, false);
    assert.deepStrictEqual(out.advisor, { enabled: false });
    assert.deepStrictEqual(out.cases, { timeZone: 'UTC', ingest: { maxPages: 100 } });
    assert.deepStrictEqual(out.models, { ollama: { baseUrl: 'http://127.0.0.1:11434' } });
  });
});

describe('runTierMigration', () => {
  function memoryStore(initial, { failWrites = 0 } = {}) {
    let raw = initial;
    const writes = [];
    let failures = failWrites;
    return {
      writes,
      readRaw: () => raw,
      writeRaw: (next) => {
        if (failures > 0) { failures -= 1; throw new Error('disk full'); }
        writes.push(JSON.parse(JSON.stringify(next)));
        raw = next;
      },
      peek: () => raw
    };
  }

  it('writes the new keys first, then removes the old ones', () => {
    const store = memoryStore(ownerShaped());
    const r = runTierMigration({ ...store, ...opts() });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.writes.length, 2);
    assert.ok(store.writes[0].inference && store.writes[0].models.profiles.length === 1, 'first write: both');
    assert.ok(!('inference' in store.writes[1]) && store.writes[1].models.profiles.length === 1, 'second write: new only');
    assert.strictEqual(needsMigration(store.peek()), false);
  });

  it('keeps the old keys when asked to', () => {
    const store = memoryStore(ownerShaped());
    const r = runTierMigration({ ...store, ...opts(), removeLegacy: false });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.writes.length, 1);
    assert.ok(store.peek().inference && store.peek().models.profiles.length === 1);
  });

  it('running the migration twice creates one profile', () => {
    const store = memoryStore(ownerShaped());
    runTierMigration({ ...store, ...opts() });
    const again = runTierMigration({ ...store, ...opts({ createId: () => 'second' }) });
    assert.strictEqual(again.migrated, false);
    assert.deepStrictEqual(store.peek().models.profiles.map((p) => p.id), ['p-abc']);
  });

  it('a crash between the two writes leaves one profile and ignorable legacy keys', () => {
    const store = memoryStore(ownerShaped());
    const r = migrateTierSettings(store.readRaw(), opts());
    store.writeRaw(r.settings); // the first write happened, then the process died
    const again = runTierMigration({ ...store, ...opts({ createId: () => 'second' }) });
    assert.strictEqual(again.migrated, false);
    assert.deepStrictEqual(store.peek().models.profiles.map((p) => p.id), ['p-abc']);
  });

  it('a failed first write leaves the old settings untouched and reports the error', () => {
    const before = ownerShaped();
    const store = memoryStore(before, { failWrites: 1 });
    const r = runTierMigration({ ...store, ...opts() });
    assert.deepStrictEqual([r.migrated, r.error], [false, 'disk full']);
    assert.strictEqual(store.peek(), before);
    assert.deepStrictEqual(store.peek(), ownerShaped());
    assert.strictEqual(needsMigration(store.peek()), true, 'retried at the next start');
  });

  it('a failed second write keeps the profile and reports success', () => {
    const store = memoryStore(ownerShaped());
    let calls = 0;
    const writeRaw = (next) => { calls += 1; if (calls === 2) throw new Error('disk full'); store.writeRaw(next); };
    const r = runTierMigration({ readRaw: store.readRaw, writeRaw, ...opts() });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.peek().models.profiles.length, 1);
    assert.ok(store.peek().inference, 'the legacy keys are left behind, ignored');
  });

  it('treats an empty profile list as absent, and a null store as a fresh install', () => {
    assert.strictEqual(needsMigration({ models: { profiles: [] } }), true);
    assert.strictEqual(needsMigration(null), true);
    const store = memoryStore(null);
    assert.strictEqual(runTierMigration({ ...store, ...opts() }).fresh, true);
  });

  it('LEGACY_DEFAULTS holds what King Louie shipped before M2', () => {
    assert.strictEqual(LEGACY_DEFAULTS.activeProvider, 'openai');
    assert.deepStrictEqual(LEGACY_DEFAULTS.tierMap.fast, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    assert.deepStrictEqual({ ...LEGACY_DEFAULTS.timeoutsMs }, { fast: 15000, standard: 30000, smart: 90000 });
  });

  it('a fresh install after stage M2 (defaults carry no tier keys) gets the Default profile', () => {
    const { DEFAULT_SETTINGS } = require('../src/core/settings');
    const store = memoryStore(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const r = runTierMigration({ ...store, ...opts() });
    assert.deepStrictEqual([r.migrated, r.fresh, r.profile.name], [true, true, 'Default']);
  });
});
