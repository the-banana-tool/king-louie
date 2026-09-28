// tests/models-catalog.test.js
// The model catalog (spec 2026-09-27 §4): provider id map, merge order,
// overrides, dated ids, no prefix matching, scores, status.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { Catalog } = require('../src/models/catalog');
const ids = require('../src/models/provider-ids');
const { normalizeScores, stripDateSuffix, localEntry } = require('../src/models/normalize');
const ProviderFactory = require('../src/providers/provider-factory');
const { setLogLevel } = require('../src/logging');

// Some cases here deliberately trigger the catalog's warnings (a malformed
// cache file, a bad override key); silence them so TAP output stays clean.
setLogLevel('fatal');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-catalog-')); dirs.push(d); return d; };

describe('provider ids', () => {
  it('lists the 14 providers the factory registers', () => {
    assert.deepStrictEqual([...ids.KL_PROVIDERS].sort(), ProviderFactory.listRegistered().sort());
  });

  it('maps the six providers whose models.dev id differs, the rest to themselves', () => {
    assert.deepStrictEqual(Object.fromEntries(ids.KL_PROVIDERS.map((p) => [p, ids.modelsDevIdFor(p)])), {
      openai: 'openai', anthropic: 'anthropic', gemini: 'google', groq: 'groq', mistral: 'mistral',
      ollama: 'ollama-cloud', openrouter: 'openrouter', xai: 'xai', deepseek: 'deepseek', qwen: 'alibaba',
      together: 'togetherai', fireworks: 'fireworks-ai', cohere: 'cohere', copilot: 'github-copilot'
    });
    assert.strictEqual(ids.providerForModelsDevId('google'), 'gemini');
    assert.strictEqual(ids.providerForModelsDevId('not-a-king-louie-provider'), null);
    assert.strictEqual(ids.DEFAULT_OLLAMA_BASE_URL, 'http://127.0.0.1:11434');
  });
});

describe('Catalog lookup', () => {
  it('builds a full Entry from models.dev, with provenance and scores', () => {
    assert.deepStrictEqual(fixtureCatalog().get('openai', 'gpt-5.5'), {
      provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', family: 'gpt',
      releaseDate: '2026-04-23', knowledge: '2025-12-01',
      limits: { context: 1050000, input: 922000, output: 128000 },
      input: ['text', 'image', 'pdf'], output: ['text'],
      toolCall: true, structuredOutput: true,
      reasoning: { supported: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
      openWeights: false, local: false,
      cost: {
        input: 5, output: 30, cacheRead: 0.5, cacheWrite: null, reasoning: null,
        tiers: [{ aboveContext: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: null }]
      },
      scores: { intelligence: 60.1, coding: 55.2, agentic: 50.3, source: 'artificial-analysis' },
      sources: ['snapshot']
    });
  });

  it('finds providers under their King Louie key and ignores providers King Louie does not ship', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.get('gemini', 'gemini-2.5-pro').provider, 'gemini');
    assert.strictEqual(c.get('ollama', 'gpt-oss:120b').provider, 'ollama');
    assert.strictEqual(c.get('GEMINI', 'gemini-2.5-pro').id, 'gemini-2.5-pro', 'provider keys are case-insensitive');
    assert.ok(!c.list().some((e) => e.id === 'x-1'));
  });

  it('looks a dated id up exactly, then as its base', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.get('openai', 'gpt-5.5-2026-04-23').id, 'gpt-5.5');
    assert.strictEqual(c.get('openai', 'gpt-5.4-mini-2026-03-17').id, 'gpt-5.4-mini');
    assert.strictEqual(c.get('anthropic', 'claude-haiku-4-5-20251001').name, 'Claude Haiku 4.5 (dated)', 'an exact dated entry wins');
    assert.strictEqual(c.get('anthropic', 'claude-haiku-4-5-20260101').id, 'claude-haiku-4-5');
    assert.strictEqual(stripDateSuffix('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.strictEqual(stripDateSuffix('gpt-5.5-2026-04-23'), 'gpt-5.5');
    assert.strictEqual(stripDateSuffix('gpt-5.5'), 'gpt-5.5');
  });

  it('never matches by prefix: a dated mini model never gets the full model\'s price', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.get('openai', 'gpt-5.5-turbo'), null);
    assert.strictEqual(c.price('openai', 'gpt-5.5-turbo', { input: 1000 }), null);
    assert.strictEqual(c.price('openai', 'gpt-5.4-mini-2026-03-17', { input: 1_000_000 }).usd, 0.75);
  });

  it('returns null for unknown models, empty ids and models without a price', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.get('openai', 'no-such-model'), null);
    assert.strictEqual(c.get('openai', ''), null);
    assert.strictEqual(c.get('openai', 'gpt-image-1').cost, null);
    assert.strictEqual(c.price('openai', 'gpt-image-1', { input: 10 }), null);
  });

  it('lists entries sorted, all or for one provider, as copies', () => {
    const c = fixtureCatalog();
    assert.deepStrictEqual(c.list('anthropic').map((e) => e.id), ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-1', 'claude-sonnet-4-5']);
    assert.ok(c.list().length >= 17);
    const copy = c.get('openai', 'gpt-5.5');
    copy.cost.input = 999;
    assert.strictEqual(c.get('openai', 'gpt-5.5').cost.input, 5);
  });
});

describe('Catalog scores', () => {
  it('attaches OpenRouter scores by vendor and id, dots or hyphens, dated or not', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.get('anthropic', 'claude-sonnet-4-5').scores.agentic, 52);
    assert.strictEqual(c.get('openrouter', 'anthropic/claude-sonnet-4.5').scores.agentic, 52);
    assert.strictEqual(c.get('anthropic', 'claude-haiku-4-5-20251001').scores.intelligence, 40);
    assert.deepStrictEqual(c.get('openai', 'gpt-5.4').scores, { intelligence: null, coding: null, agentic: null, source: 'artificial-analysis' });
  });

  it('normalizes an OpenRouter model list, skipping variants and unscored models', () => {
    assert.deepStrictEqual(normalizeScores({
      data: [
        { id: 'Anthropic/Claude-Sonnet-4.5', benchmarks: { artificial_analysis: { intelligence_index: 50, coding_index: 48, agentic_index: 52 } } },
        { id: 'anthropic/claude-sonnet-4.5:batch', benchmarks: { artificial_analysis: { intelligence_index: 1, coding_index: 1, agentic_index: 1 } } },
        { id: 'openai/gpt-5.5', benchmarks: { design_arena: [] } },
        { id: 'x/y', benchmarks: { artificial_analysis: { intelligence_index: null, coding_index: null, agentic_index: null } } }
      ]
    }), { 'anthropic/claude-sonnet-4.5': { intelligence: 50, coding: 48, agentic: 52 } });
  });
});

describe('Catalog sources and overrides', () => {
  it('a cached models.dev copy wins over the snapshot, field by field', () => {
    const cacheDir = tmp();
    fs.writeFileSync(path.join(cacheDir, 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-28T00:00:00.000Z',
      etag: '"a"',
      data: {
        openai: {
          id: 'openai',
          models: {
            'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5 (cached)', tool_call: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 6, output: 30 } },
            'gpt-9': { id: 'gpt-9', name: 'GPT-9', cost: { input: 1, output: 2 } }
          }
        }
      }
    }));
    const c = fixtureCatalog({ cacheDir });
    const e = c.get('openai', 'gpt-5.5');
    assert.strictEqual(e.name, 'GPT-5.5 (cached)');
    assert.strictEqual(e.cost.input, 6);
    assert.strictEqual(e.cost.cacheRead, null, 'the cost field is replaced whole');
    assert.deepStrictEqual(e.sources, ['snapshot', 'models.dev']);
    assert.deepStrictEqual(c.get('openai', 'gpt-9').sources, ['models.dev']);
    assert.ok(c.get('anthropic', 'claude-sonnet-4-5'), 'snapshot-only entries stay');
    assert.strictEqual(c.status().source, 'cache');
    assert.strictEqual(c.status().fetchedAt, '2026-09-28T00:00:00.000Z');
  });

  it('owner overrides win last, one level deep, and can add models the catalog lacks', () => {
    const settings = {
      models: {
        overrides: {
          'openai:gpt-5.5': { cost: { input: 4 } },
          'openai:my-finetune': { name: 'My fine-tune', toolCall: true, cost: { input: 1, output: 2 } },
          'ollama:qwen3:8b': { name: 'Qwen3 8B', toolCall: true },
          'bad-key-without-colon': { name: 'ignored' }
        }
      }
    };
    const c = fixtureCatalog({ getSettings: () => settings });
    const e = c.get('openai', 'gpt-5.5');
    assert.strictEqual(e.cost.input, 4);
    assert.strictEqual(e.cost.output, 30, 'the rest of cost stays');
    assert.deepStrictEqual(e.sources, ['snapshot', 'override']);
    assert.strictEqual(c.price('openai', 'my-finetune', { input: 1_000_000, output: 1_000_000 }).usd, 3);
    const local = c.get('ollama', 'qwen3:8b');
    assert.strictEqual(local.toolCall, true, 'a model id containing a colon splits at the first colon only');
    assert.strictEqual(local.cost, null, 'an override without cost leaves the model unpriced');
    settings.models.overrides['openai:gpt-5.5'] = { cost: { input: 7 } };
    assert.strictEqual(c.get('openai', 'gpt-5.5').cost.input, 7, 'a settings change applies without reloading');
  });

  it('adds local models with zero cost and emits updated', () => {
    const c = fixtureCatalog();
    const events = [];
    c.on('updated', (s) => events.push(s));
    c.setLocalModels('ollama', [localEntry('ollama', { id: 'llama3.1:8b', context: 131072, toolCall: true, imageInput: false })]);
    const e = c.get('ollama', 'llama3.1:8b');
    assert.strictEqual(e.local, true);
    assert.strictEqual(e.toolCall, true);
    assert.deepStrictEqual(e.sources, ['ollama']);
    assert.strictEqual(c.price('ollama', 'llama3.1:8b', { input: 5000, output: 500 }).usd, 0);
    assert.strictEqual(events.length, 1);
  });
});

describe('Catalog status and resilience', () => {
  it('reports the snapshot as the source, with its date', () => {
    const s = fixtureCatalog({ now: () => new Date('2026-10-01T00:00:00Z') }).status();
    assert.strictEqual(s.source, 'snapshot');
    assert.strictEqual(s.fetchedAt, null);
    assert.strictEqual(s.snapshotDate, '2026-09-27T00:00:00.000Z');
    assert.strictEqual(s.stale, false);
    assert.ok(s.models > 0);
  });

  it('is stale after staleWarnDays', () => {
    assert.strictEqual(fixtureCatalog({ now: () => new Date('2026-11-30T00:00:00Z') }).status().stale, true);
  });

  it('starts empty, without throwing, when the snapshot is missing', () => {
    const c = new Catalog().load({ snapshotDir: path.join(tmp(), 'missing') });
    assert.deepStrictEqual(c.list(), []);
    assert.strictEqual(c.status().snapshotDate, null);
  });

  it('ignores a malformed cache file', () => {
    const cacheDir = tmp();
    fs.writeFileSync(path.join(cacheDir, 'models-dev.json'), 'not json');
    fs.writeFileSync(path.join(cacheDir, 'scores.json'), JSON.stringify({ nope: true }));
    const c = fixtureCatalog({ cacheDir });
    assert.strictEqual(c.status().source, 'snapshot');
    assert.strictEqual(c.get('openai', 'gpt-5.5').scores.agentic, 50.3);
  });
});

// Final review I4: a local Ollama model must never be priced at Ollama
// Cloud rates, even when a Cloud model happens to share its exact id (the
// review's own example, gpt-oss:20b, priced a real local model at
// $0.37/1M-in+1M-out). Only an id that says "-cloud"/":cloud" in Ollama's
// own naming for its Cloud models prices against the Cloud catalog entries.
describe('Catalog.price(): local Ollama models are never priced at Cloud rates', () => {
  const cacheDir = tmp();
  fs.writeFileSync(path.join(cacheDir, 'models-dev.json'), JSON.stringify({
    fetchedAt: '2026-09-28T00:00:00.000Z',
    data: {
      'ollama-cloud': {
        id: 'ollama-cloud',
        models: {
          'gpt-oss:20b': { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', cost: { input: 4, output: 20 } },
          'gpt-oss:20b-cloud': { id: 'gpt-oss:20b-cloud', name: 'GPT-OSS 20B (Cloud)', cost: { input: 4, output: 20 } }
        }
      }
    }
  }));

  it('prices a bare id at zero even when the catalog has a Cloud rate for that exact id', () => {
    const c = fixtureCatalog({ cacheDir });
    assert.strictEqual(c.get('ollama', 'gpt-oss:20b').cost.input, 4, 'sanity: the catalog does carry a Cloud rate for the bare id');
    const local = c.price('ollama', 'gpt-oss:20b', { input: 1_000_000, output: 1_000_000 });
    assert.notStrictEqual(local, null, 'a local id is priced at zero, never left unpriced');
    assert.strictEqual(local.usd, 0);
  });

  it('prices an explicit -cloud id at the Cloud catalog rate', () => {
    const c = fixtureCatalog({ cacheDir });
    const cloud = c.price('ollama', 'gpt-oss:20b-cloud', { input: 1_000_000, output: 1_000_000 });
    assert.strictEqual(cloud.usd, 24);
  });

  it('prices a :cloud id at the Cloud catalog rate the same way', () => {
    const colonCacheDir = tmp();
    fs.writeFileSync(path.join(colonCacheDir, 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-28T00:00:00.000Z',
      data: { 'ollama-cloud': { id: 'ollama-cloud', models: { 'gpt-oss:cloud': { id: 'gpt-oss:cloud', cost: { input: 4, output: 20 } } } } }
    }));
    const c = fixtureCatalog({ cacheDir: colonCacheDir });
    assert.strictEqual(c.price('ollama', 'gpt-oss:cloud', { input: 1_000_000, output: 1_000_000 }).usd, 24);
  });

  it('prices an id the catalog has never heard of at all at zero, not unpriced', () => {
    const c = fixtureCatalog({ cacheDir });
    const p = c.price('ollama', 'my-local-model', { input: 1_000_000, output: 1_000_000 });
    assert.notStrictEqual(p, null);
    assert.strictEqual(p.usd, 0);
  });

  it('does not change pricing for a non-Ollama provider', () => {
    const c = fixtureCatalog({ cacheDir });
    assert.strictEqual(c.price('openai', 'no-such-model', { input: 100, output: 100 }), null);
  });
});
