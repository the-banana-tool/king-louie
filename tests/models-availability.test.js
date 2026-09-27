// tests/models-availability.test.js
// Availability (spec 2026-09-27 §5): the four usability rules, listModels as
// the one connection test, auth failures, retest scheduling.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Availability } = require('../src/models/availability');
const { Catalog } = require('../src/models/catalog');
const { fixtureCatalog, FIXTURE_DIR } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

// Several cases here deliberately fail a connection test (bad key, no
// server, ECONNREFUSED); silence the resulting warnings so TAP output
// stays clean.
setLogLevel('fatal');

const NOW = new Date('2026-09-27T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

function setup({ credentials = ['openai'], statuses = {}, lists = {}, settings = {}, fetch } = {}) {
  let store = { ...statuses };
  const created = [];
  const events = [];
  const availability = new Availability({
    catalog: fixtureCatalog(),
    labels: { openai: 'OpenAI', anthropic: 'Anthropic', groq: 'Groq', gemini: 'Google Gemini', ollama: 'Ollama (Local)' },
    hasCredential: (p) => p === 'ollama' || credentials.includes(p),
    createProvider: async (p) => {
      created.push(p);
      return {
        listModels: async (opts) => {
          assert.ok(opts && opts.abortSignal, 'the test call carries a timeout signal');
          const r = lists[p];
          if (r instanceof Error) throw r;
          return r || [];
        }
      };
    },
    getStatuses: () => store,
    setStatuses: (s) => { store = s; },
    getSettings: () => settings,
    now: () => NOW,
    fetch: fetch || (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); })
  });
  availability.on('changed', (e) => events.push(e));
  return { availability, created, events, store: () => store };
}

describe('the one connection test', () => {
  it('uses listModels and stores the account\'s models under apiStatus', async () => {
    const { availability, store, events } = setup({ lists: { openai: ['gpt-5.5', 'gpt-4o', 'gpt-5.5'] } });
    const s = await availability.test('openai');
    assert.deepStrictEqual(s, { ok: true, error: null, message: 'Connected: 2 models.', checkedAt: NOW.toISOString(), models: ['gpt-4o', 'gpt-5.5'] });
    assert.deepStrictEqual(store().openai, s);
    assert.deepStrictEqual(events, [{ provider: 'openai', status: s }]);
  });

  it('records a failing test with its error, time and HTTP status', async () => {
    const err = Object.assign(new Error('Incorrect API key provided'), { status: 401 });
    const { availability } = setup({ lists: { openai: err } });
    const s = await availability.test('openai');
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.error, 'Incorrect API key provided');
    assert.strictEqual(s.httpStatus, 401);
    assert.strictEqual(s.checkedAt, NOW.toISOString());
    assert.deepStrictEqual(s.models, []);
  });

  it('fails without calling the provider when there is no credential', async () => {
    const { availability, created } = setup({ credentials: [] });
    const s = await availability.test('anthropic');
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.error, 'No token saved for this provider.');
    assert.deepStrictEqual(created, []);
  });

  it('refuses an unknown provider', async () => {
    await assert.rejects(setup().availability.test('nope'), /Unknown provider "nope"/);
  });

  it('shares one run between concurrent tests of a provider', async () => {
    const { availability, created } = setup({ lists: { openai: ['gpt-5.5'] } });
    await Promise.all([availability.test('openai'), availability.test('openai')]);
    assert.deepStrictEqual(created, ['openai']);
  });

  it('tests every credentialed provider, Ollama included, on testAll', async () => {
    const { availability } = setup({ credentials: ['openai', 'groq'], lists: { openai: ['gpt-5.5'], groq: ['llama-3.3-70b'] } });
    const all = await availability.testAll();
    assert.deepStrictEqual(Object.keys(all).sort(), ['groq', 'ollama', 'openai']);
    assert.strictEqual(all.ollama.ok, false, 'no Ollama server in this test');
  });
});

describe('the four usability rules', () => {
  const passing = (models) => ({ ok: true, error: null, message: 'ok', checkedAt: hoursAgo(1), models });

  it('1. credentialed: no key, no use', () => {
    const v = setup({ credentials: [] }).availability.explain('anthropic', 'claude-sonnet-4-5');
    assert.strictEqual(v.usable, false);
    assert.deepStrictEqual(v.reasons, ['No token saved for Anthropic.']);
  });

  it('2. passing: never tested, or a failed test with its error and time', () => {
    assert.deepStrictEqual(setup().availability.explain('openai', 'gpt-5.5').reasons, ['OpenAI has not been tested yet.']);
    const failed = { openai: { ok: false, error: 'Incorrect API key provided', message: 'Incorrect API key provided', checkedAt: '2026-09-27T11:00:00.000Z', models: [] } };
    assert.deepStrictEqual(setup({ statuses: failed }).availability.explain('openai', 'gpt-5.5').reasons, [
      'OpenAI connection test failed at 2026-09-27T11:00:00.000Z: Incorrect API key provided'
    ]);
  });

  it('3. reachable: in this account\'s list, dated ids matching their alias', () => {
    const { availability } = setup({ credentials: ['openai', 'anthropic'], statuses: { openai: passing(['gpt-4o']), anthropic: passing(['claude-sonnet-4-5-20250929']) } });
    assert.deepStrictEqual(availability.explain('openai', 'gpt-5.5').reasons, ['gpt-5.5 is not in this OpenAI account\'s model list.']);
    assert.strictEqual(availability.explain('openai', 'gpt-4o').usable, true);
    assert.strictEqual(availability.explain('anthropic', 'claude-sonnet-4-5').usable, true, 'the alias of a listed dated id');
    assert.strictEqual(availability.explain('anthropic', 'claude-sonnet-4-5-20250929').usable, true);
  });

  it('3. reachable: an empty or missing list falls back to the catalog, except for Ollama', () => {
    const legacy = { openai: { ok: true, message: 'Connection successful', checkedAt: hoursAgo(1) } };
    const { availability } = setup({ statuses: { ...legacy, ollama: passing([]) } });
    assert.strictEqual(availability.explain('openai', 'gpt-5.5').usable, true, 'a status from before M1 has no model list');
    assert.deepStrictEqual(availability.explain('openai', 'my-own-model').reasons, ['my-own-model is not in this OpenAI account\'s model list.']);
    assert.strictEqual(availability.explain('ollama', 'gpt-oss:120b').usable, false, 'an empty Ollama server has no models');
  });

  it('4. fit: tool calling, image input, text output, context', () => {
    const { availability } = setup({ credentials: ['openai', 'groq'], statuses: { openai: passing(['gpt-3.5-turbo', 'gpt-4o', 'gpt-image-1']), groq: passing(['llama-vision-preview']) } });
    assert.deepStrictEqual(availability.explain('groq', 'llama-vision-preview', { needs: { toolCall: true } }).reasons, ['llama-vision-preview has no tool calling.']);
    assert.deepStrictEqual(availability.explain('openai', 'gpt-3.5-turbo', { needs: { imageInput: true } }).reasons, ['gpt-3.5-turbo takes no image input.']);
    assert.deepStrictEqual(availability.explain('openai', 'gpt-image-1', { needs: { textOutput: true } }).reasons, ['gpt-image-1 does not produce text.']);
    assert.deepStrictEqual(availability.explain('openai', 'gpt-4o', { needs: { minContext: 500000 } }).reasons, ['gpt-4o has a context of 128000 tokens, below 500000.']);
    assert.strictEqual(availability.explain('openai', 'gpt-4o', { needs: { toolCall: true, imageInput: true } }).usable, true);
  });

  it('a model the catalog does not know is usable, marked unpriced', () => {
    const { availability } = setup({ statuses: { openai: passing(['my-finetune']) } });
    const v = availability.explain('openai', 'my-finetune', { needs: { toolCall: true } });
    assert.strictEqual(v.usable, true);
    assert.strictEqual(v.entry, null);
    assert.deepStrictEqual(v.notes, ['my-finetune is not in the model catalog: unpriced, capabilities unknown.']);
  });

  it('no model chosen is a reason of its own', () => {
    const { availability } = setup({ statuses: { openai: passing(['gpt-5.5']) } });
    assert.deepStrictEqual(availability.explain('openai', '').reasons, ['No model is chosen for OpenAI.']);
  });

  it('lists usable models meeting the needs', () => {
    const { availability } = setup({ credentials: ['openai', 'groq'], statuses: { openai: passing(['gpt-5.5', 'gpt-image-1', 'my-finetune']), groq: { ok: false, error: 'bad key', checkedAt: hoursAgo(1), models: [] } } });
    assert.deepStrictEqual(availability.usable({ needs: { toolCall: true } }).map((c) => c.model), ['gpt-5.5', 'my-finetune']);
    assert.deepStrictEqual(availability.usable({ needs: { textOutput: true } }).map((c) => c.model), ['gpt-5.5', 'my-finetune']);
    const [first] = availability.usable({ needs: {} });
    assert.deepStrictEqual(first, {
      provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5', known: true, priced: true,
      cost: first.cost, context: 1050000, toolCall: true, imageInput: true, local: false
    });
    assert.strictEqual(first.cost.input, 5);
  });
});

describe('Availability.usable() checks the catalog once per pass', () => {
  it('does not re-check catalog overrides once per candidate', () => {
    let getSettingsCalls = 0;
    const catalog = new Catalog().load({
      snapshotDir: FIXTURE_DIR,
      getSettings: () => { getSettingsCalls += 1; return {}; }
    });
    const models = catalog.list('openai').map((e) => e.id);
    let store = { openai: { ok: true, error: null, message: 'ok', checkedAt: hoursAgo(1), models } };
    const availability = new Availability({
      catalog,
      hasCredential: (p) => p === 'openai',
      createProvider: async () => ({ listModels: async () => [] }),
      getStatuses: () => store,
      setStatuses: (s) => { store = s; },
      now: () => NOW
    });
    assert.ok(models.length >= 5, 'the fixture openai catalog has several models to iterate');
    getSettingsCalls = 0;
    const candidates = availability.usable({ needs: {} });
    assert.strictEqual(candidates.length, models.length);
    assert.strictEqual(getSettingsCalls, 1, `catalog.getSettings() ran ${getSettingsCalls} times for one usable() pass over ${models.length} candidates`);
  });
});

describe('during use and over time', () => {
  it('an auth failure makes the provider unusable at once and keeps its model list', () => {
    const { availability, events } = setup({ statuses: { openai: { ok: true, error: null, message: 'ok', checkedAt: hoursAgo(1), models: ['gpt-5.5'] } } });
    const s = availability.markAuthFailure('openai', Object.assign(new Error('Invalid API key'), { status: 401 }));
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.authFailed, true);
    assert.deepStrictEqual(s.models, ['gpt-5.5']);
    assert.match(s.error, /OpenAI rejected the key: Invalid API key/);
    assert.strictEqual(availability.explain('openai', 'gpt-5.5').usable, false);
    assert.strictEqual(events.length, 1);
  });

  it('retests credentialed providers whose last test is older than retestHours, and never-tested ones', async () => {
    const { availability, created } = setup({
      credentials: ['openai', 'anthropic', 'groq'],
      statuses: { openai: { ok: true, checkedAt: hoursAgo(25), models: [] }, anthropic: { ok: true, checkedAt: hoursAgo(1), models: [] } },
      lists: { openai: ['gpt-5.5'], groq: ['llama-3.3-70b'] }
    });
    const retested = await availability.retestStale();
    assert.deepStrictEqual(retested.sort(), ['groq', 'openai']);
    assert.deepStrictEqual(created.sort(), ['groq', 'openai'], 'anthropic is fresh; Ollama was never set up');
  });

  it('honours models.availability.retestHours', async () => {
    const { availability } = setup({
      statuses: { openai: { ok: true, checkedAt: hoursAgo(3), models: [] } },
      lists: { openai: ['gpt-5.5'] },
      settings: { models: { availability: { retestHours: 2 } } }
    });
    assert.deepStrictEqual(await availability.retestStale(), ['openai']);
  });

  it('ensureTested tests only a provider with no status', async () => {
    const { availability, created } = setup({ statuses: { anthropic: { ok: false, checkedAt: hoursAgo(1), models: [] } }, credentials: ['openai', 'anthropic'], lists: { openai: ['gpt-5.5'] } });
    await availability.ensureTested('openai');
    await availability.ensureTested('anthropic');
    assert.deepStrictEqual(created, ['openai']);
  });

  it('forget drops the stored status', () => {
    const { availability, store, events } = setup({ statuses: { openai: { ok: true, checkedAt: hoursAgo(1), models: [] } } });
    availability.forget('openai');
    assert.strictEqual(store().openai, undefined);
    assert.deepStrictEqual(events, [{ provider: 'openai', status: null }]);
  });
});
