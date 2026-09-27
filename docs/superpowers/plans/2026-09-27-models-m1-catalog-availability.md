# Models M1: Catalog and Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give King Louie one maintained model catalog (prices and capabilities, offline-capable), one connection test per provider, a send path open to all 14 providers when they are usable, and a Stop button that cancels the model request and keeps the partial reply, marked.

**Architecture:** A new Electron-free `src/models/` subsystem holds the `Catalog` (bundled models.dev snapshot, cached live copy, overrides, local Ollama models, the single price function) and `Availability` (connection tests via each provider's `listModels()`, usability rules, `explain` reasons). Providers price every call through the catalog and send every request through one `BaseProvider.request()` helper that carries the abort signal; streaming loops report partial usage when aborted. The chat send path checks usability instead of a three-provider list and finalises a stopped run exactly once. Tiers, `tierMap`, `activeProvider`, `providerModels`, smart routing and the LLM router keep working unchanged; the tier resolver is simply fed prices and capabilities by the catalog.

**Tech Stack:** Node 22 (built-in `fetch`, `AbortSignal.timeout`, `Response`, `structuredClone`), `node:test`, Electron renderer (plain DOM), Playwright `_electron` for e2e.

**Spec:** `docs/superpowers/specs/2026-09-27-model-catalog-profiles-roles-design.md` (stage M1, §18). Sections in force for this plan: §3 (Catalog and Availability only), §4, §5, §9 (without "Retry with…"), §14 (`models.catalog`, `models.overrides`, `models.ollama`, `models.availability` only), §15 rows for the catalog, providers and Stop, §16 items for catalog, pricing, availability, stop and providers, §17.1 rows as they concern M1.

## Global Constraints

- Tests run with node's built-in runner: `npm test` (`node --test --test-timeout=120000 tests/*.test.js`) or `node --test tests/<file>.test.js`. Never `jest`. Look for `# fail 0` in the TAP summary.
- `npm test` must pass at the end of every task.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` enforces it, and `src/models/` is covered by it.
- Log through `createLogger` from `src/logging.js`, never bare `console.*` in `src/`. Scripts write their output with `process.stdout.write`.
- Open source: no personal names, machine names, domains or home paths in code, tests, fixtures or docs. Model names, URLs and thresholds are settings or generic test data.
- Unit tests never touch the network: inject `fetch`, point providers at the local fake server (`tests/helpers/fake-llm-server.js`), and price with the fixture catalog in `tests/fixtures/models/`.
- Settings keys and defaults, verbatim from spec §14 (M1 subset):
  `models.catalog = { fetch: true, refreshHours: 24, staleWarnDays: 30, modelsDevUrl: 'https://models.dev/api.json', scoresUrl: 'https://openrouter.ai/api/v1/models' }`, `models.overrides = {}`, `models.ollama = { baseUrl: 'http://127.0.0.1:11434' }`, `models.availability = { retestHours: 24 }`. Every key merges through `mergeSettings`.
- Catalog cache files live at `<dataDir>/catalog/models-dev.json` and `<dataDir>/catalog/scores.json`; the bundled snapshot at `src/models/snapshot/models-dev.json` and `src/models/snapshot/scores.json`.
- Provider id map (spec §4.3): gemini → `google`, qwen → `alibaba`, together → `togetherai`, fireworks → `fireworks-ai`, copilot → `github-copilot`, ollama → `ollama-cloud`; the rest identical. It lives only in `src/models/provider-ids.js`.
- No loose prefix matching of model ids anywhere. Dated ids match their base by stripping a trailing `-YYYY-MM-DD` or `-YYYYMMDD`.
- An unknown model is unpriced: `costUsd: null` with `unpriced: true`, never `0` or a guess. A call cut off by Stop is recorded with `usagePartial: true` and the usage reported so far; when nothing was reported its `costUsd` is `null`, never `0`.
- `ProviderStatus` is `{ ok, error, message, checkedAt, models: string[] }` (plus `authFailed`/`httpStatus` when set), stored under the existing `apiStatus` store key.
- Tiers, `inference.tierMap`, `activeProvider`, `providerModels`, smart routing and the LLM router keep working in M1. Do not remove them.
- The catalog refresh and the stale-provider retests are started by the host (`main.js`, `runService`) through `core.models.startBackgroundChecks()`, never by `createCore().start()`, and are skipped when `process.env.KL_TEST_MODE` is set.

## Review Focus

1. A profile upgraded from before M1 has `apiStatus` entries without `models` (or none at all) for providers with saved keys: the first send must not be refused. Expected: a missing status is tested on demand before the check, and a passing status without a model list falls back to the catalog (Task 6 and Task 9 tests pin this).
2. Anthropic's `/v1/models` lists only dated ids (`claude-sonnet-4-5-20250929`) while settings name the alias (`claude-sonnet-4-5`): the model must count as in the account. Expected: reachability matches a listed dated variant of the alias and vice versa (Task 6 test).
3. The owner presses Stop and immediately sends again in the same chat: the stopped run must neither delete the new run's controller nor append anything after its own stopped message. Expected: `activeRuns` is only cleared by the run that owns the controller, and executor events after Stop are dropped (Task 10 tests).
4. The cache directory cannot be written (disk full, read-only profile, a file where the folder should be): a refresh must not throw or lose the fetched data for this session. Expected: the write failure is logged and the in-memory catalog still updates (Task 2 test).
5. A stopped reply with no text is followed by a new message: an empty assistant message must not be sent to the next provider call (Anthropic rejects empty content). Expected: empty stopped replies are left out of the history built for the next turn (Task 10 test).

---

## File Structure

New, under `src/models/` (Electron-free):

| File | Responsibility |
|---|---|
| `provider-ids.js` | The 14 King Louie provider keys, the models.dev and OpenRouter id maps, the default Ollama address |
| `normalize.js` | models.dev and OpenRouter documents → `Entry` objects and score maps; trimming and validation; dated-id stripping |
| `pricing.js` | `priceWithCost(cost, usage)`, the only price arithmetic |
| `catalog.js` | `Catalog`: snapshot, cache, live refresh, overrides, local models, `get`/`list`/`price`/`status` |
| `ollama.js` | `discoverOllama()`: `/api/tags` and `/api/show` |
| `availability.js` | `Availability`: connection tests, statuses, usability rules, `explain`, `usable` |
| `capabilities.js` | `capabilitiesOf(catalog, provider, model)`, replacing `InferenceRouter.getCapabilities` |
| `index.js` | Re-exports, and the active catalog providers price against |
| `snapshot/models-dev.json`, `snapshot/scores.json` | Bundled catalog, regenerated by `npm run models:snapshot` |

Other new files: `src/providers/abort.js` (abort helpers), `src/tracking/llm-totals.js` (`sumLlmCalls`), `src/ipc/models-handlers.js` (catalog and availability channels), `scripts/models-snapshot.js`, `scripts/smoke-providers.js`, `scripts/lib/provider-checks.js`.

Modified: every provider in `src/providers/`, `src/providers/inference-router.js`, `src/tracking/usage-tracker.js` (and `src/tracking/pricing-tables.js` deleted), `src/core/settings.js`, `src/core/create-core.js`, `src/ipc/settings-handlers.js`, `src/ipc/chat-handlers.js`, `src/ipc/case-handlers.js`, `src/ipc/constants.js`, `src/ipc/register.js`, `src/execution/agent-loop.js`, `src/cases/case-runtime.js`, `src/cases/ingest/vision.js` (comment only), `src/service/run.js`, `main.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`, `package.json`, `CLAUDE.md`.

New tests: `tests/models-catalog.test.js`, `tests/models-pricing.test.js`, `tests/models-catalog-refresh.test.js`, `tests/models-snapshot.test.js`, `tests/models-provider-pricing.test.js`, `tests/providers-request-helper.test.js`, `tests/providers-fake-server.test.js`, `tests/models-availability.test.js`, `tests/models-ollama.test.js`, `tests/models-core.test.js`, `tests/models-ipc.test.js`, `tests/models-capabilities.test.js`, `tests/chat-usability.test.js`, `tests/chat-stop.test.js`, `tests/cases-stop.test.js`, `tests/renderer-models-text.test.js`, `tests/e2e/models-stop.test.js`; helpers `tests/helpers/models-fixture.js`, `tests/helpers/fake-llm-server.js`, `tests/helpers/chat-harness.js`; fixtures `tests/fixtures/models/models-dev.json`, `tests/fixtures/models/scores.json`.

Rewritten tests: `tests/usage-tracker.test.js` (pricing parts), `tests/gemini-provider.test.js` and `tests/mistral-provider.test.js` (pricing-table tests removed), `tests/ollama-provider.test.js` (default address), `tests/ollama-settings.test.js` (`settings:testProvider` section), `tests/inference-router.test.js` (capabilities test removed, auth hook test added), `tests/cases-ingest-vision.test.js` and `tests/helpers/ingest-harness.js` (capabilities from the catalog), `tests/desktop-bridge-dispatcher.test.js` (fake provider gains `listModels`), `tests/agent-loop.test.js` (abort tests added), `tests/core-settings.test.js` (models keys), `tests/settings-handlers.test.js` (key-change retest), `tests/e2e/inference-tiers.test.js` (usable-only provider list).

Deleted: `src/tracking/pricing-tables.js`. No test file is deleted; the spec's §16 list of tests to remove (`inference-router`, `smart-routing`, `provider-config-consistency`, tier parts of settings tests) belongs to M2, when tiers go.

---

## Task 1: Catalog core — provider ids, normalization, lookup and the price function

**Files:**
- Create: `src/models/provider-ids.js`, `src/models/normalize.js`, `src/models/pricing.js`, `src/models/catalog.js`, `src/models/index.js`
- Create: `tests/fixtures/models/models-dev.json`, `tests/fixtures/models/scores.json`, `tests/helpers/models-fixture.js`
- Test: `tests/models-catalog.test.js`, `tests/models-pricing.test.js`

**Interfaces:**
- Consumes: `createLogger` from `src/logging.js`.
- Produces:
  - `src/models/provider-ids.js`: `KL_PROVIDERS: string[]` (14 keys), `MODELS_DEV_IDS`, `OPENROUTER_VENDORS`, `DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'`, `normalizeProvider(p) → string`, `modelsDevIdFor(p) → string`, `providerForModelsDevId(id) → string|null`, `isKnownProvider(p) → boolean`.
  - `src/models/normalize.js`: `isPlainObject(v)`, `stripDateSuffix(id)`, `entryKey(provider, id)`, `emptyScores()`, `normalizeCost(cost)`, `normalizeModel(provider, raw) → Entry`, `normalizeModelsDev(data) → Entry[]`, `validateModelsDev(data) → boolean`, `trimModelsDev(data) → object`, `normalizeScores(openRouterJson) → { [lowercaseOpenRouterId]: { intelligence, coding, agentic } }`, `validateScores(json) → boolean`, `buildScoreIndex(scores) → Map`, `scoreFor(index, provider, id) → scores|null`, `localEntry(provider, { id, name?, context?, toolCall?, imageInput? }) → Entry`.
  - `src/models/pricing.js`: `priceWithCost(cost, usage) → { usd, parts: { input, cachedInput, cacheWrite, output, reasoning }, tier: number|null } | null`, where `usage = { input (uncached), cachedInput, cacheWrite, output (includes reasoning), reasoning }`.
  - `src/models/catalog.js`: `class Catalog extends EventEmitter` with `load({ snapshotDir?, cacheDir?, fetch?, getSettings?, now? }) → this`, `config() → models.catalog merged over CATALOG_DEFAULTS`, `get(provider, modelId) → Entry|null` (a copy), `list(provider?) → Entry[]` (copies, sorted), `price(provider, modelId, usage) → price|null`, `status() → { source: 'live'|'cache'|'snapshot', fetchedAt, snapshotDate, stale, models }`, `setLocalModels(provider, entries)`, event `'updated'` (payload `status()`). Also exports `CATALOG_DEFAULTS`, `DEFAULT_SNAPSHOT_DIR`.
  - `src/models/index.js`: re-exports all of the above plus `getActiveCatalog() → Catalog` and `setActiveCatalog(catalog|null)`.
  - `tests/helpers/models-fixture.js`: `FIXTURE_DIR`, `fixtureCatalog({ cacheDir?, getSettings?, fetch?, now? }) → Catalog` loaded from `tests/fixtures/models/`.
  - `Entry` (spec §4.2): `{ provider, id, name, family, releaseDate, knowledge, limits: { context, input, output }, input: string[], output: string[], toolCall, structuredOutput, reasoning: { supported, efforts }, openWeights, local, cost: { input, output, cacheRead, cacheWrite, reasoning, tiers: [{ aboveContext, input, output, cacheRead, cacheWrite }] } | null, scores: { intelligence, coding, agentic, source: 'artificial-analysis' }, sources: string[] }`.

- [ ] **Step 1: Write the fixture catalog and its helper**

Create `tests/fixtures/models/models-dev.json`. It has the bundled-snapshot shape `{ fetchedAt, source, data }`, where `data` is a models.dev document trimmed to a few providers. The gpt-5.5 rates are models.dev's list rates on 2026-09-27 (spec §1.1); everything else is test data.

```json
{
  "fetchedAt": "2026-09-27T00:00:00.000Z",
  "source": "models.dev",
  "data": {
    "openai": {
      "id": "openai",
      "name": "OpenAI",
      "models": {
        "gpt-5.5": {
          "id": "gpt-5.5", "name": "GPT-5.5", "family": "gpt", "attachment": true, "reasoning": true,
          "reasoning_options": [{ "type": "effort", "values": ["none", "low", "medium", "high", "xhigh"] }],
          "tool_call": true, "structured_output": true, "knowledge": "2025-12-01", "release_date": "2026-04-23",
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "open_weights": false,
          "limit": { "context": 1050000, "input": 922000, "output": 128000 },
          "cost": { "input": 5, "output": 30, "cache_read": 0.5, "tiers": [{ "input": 10, "output": 45, "cache_read": 1, "tier": { "type": "context", "size": 272000 } }] }
        },
        "gpt-5.4": {
          "id": "gpt-5.4", "name": "GPT-5.4", "family": "gpt", "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 400000, "output": 128000 },
          "cost": { "input": 2.5, "output": 15, "cache_read": 0.25 }
        },
        "gpt-5.4-mini": {
          "id": "gpt-5.4-mini", "name": "GPT-5.4 mini", "family": "gpt", "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 400000, "output": 128000 },
          "cost": { "input": 0.75, "output": 4.5, "cache_read": 0.075 }
        },
        "gpt-4o": {
          "id": "gpt-4o", "name": "GPT-4o", "family": "gpt", "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 128000, "output": 16384 },
          "cost": { "input": 2.5, "output": 10, "cache_read": 1.25 }
        },
        "gpt-3.5-turbo": {
          "id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "family": "gpt", "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] }, "limit": { "context": 16385, "output": 4096 },
          "cost": { "input": 0.5, "output": 1.5 }
        },
        "gpt-image-1": {
          "id": "gpt-image-1", "name": "GPT Image 1", "family": "gpt-image", "tool_call": false,
          "modalities": { "input": ["text", "image"], "output": ["image"] }, "limit": { "context": 0, "output": 0 }
        },
        "o4-mini": {
          "id": "o4-mini", "name": "o4-mini", "family": "o", "reasoning": true, "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 200000, "output": 100000 },
          "cost": { "input": 1.1, "output": 4.4, "reasoning": 8 }
        }
      }
    },
    "anthropic": {
      "id": "anthropic",
      "name": "Anthropic",
      "models": {
        "claude-sonnet-4-5": {
          "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "family": "claude-sonnet", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
        },
        "claude-opus-4-1": {
          "id": "claude-opus-4-1", "name": "Claude Opus 4.1", "family": "claude-opus", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 200000, "output": 32000 },
          "cost": { "input": 15, "output": 75, "cache_read": 1.5, "cache_write": 18.75 }
        },
        "claude-haiku-4-5": {
          "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "family": "claude-haiku", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 1, "output": 5, "cache_read": 0.1, "cache_write": 1.25 }
        },
        "claude-haiku-4-5-20251001": {
          "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5 (dated)", "family": "claude-haiku", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 1, "output": 5, "cache_read": 0.1, "cache_write": 1.25 }
        }
      }
    },
    "google": {
      "id": "google",
      "name": "Google",
      "models": {
        "gemini-2.5-pro": {
          "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "family": "gemini-pro", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1048576, "output": 65536 },
          "cost": { "input": 1.25, "output": 10, "cache_read": 0.31, "tiers": [{ "input": 2.5, "output": 15, "cache_read": 0.625, "tier": { "type": "context", "size": 200000 } }] }
        },
        "gemini-2.5-flash": {
          "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "family": "gemini-flash", "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1048576, "output": 65536 },
          "cost": { "input": 0.3, "output": 2.5, "cache_read": 0.075 }
        }
      }
    },
    "groq": {
      "id": "groq",
      "name": "Groq",
      "models": {
        "llama-3.3-70b": {
          "id": "llama-3.3-70b", "name": "Llama 3.3 70B", "family": "llama", "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] }, "limit": { "context": 131072, "output": 32768 },
          "cost": { "input": 0.59, "output": 0.79 }
        },
        "llama-vision-preview": {
          "id": "llama-vision-preview", "name": "Llama Vision Preview", "family": "llama", "tool_call": false,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 8192, "output": 8192 },
          "cost": { "input": 0.2, "output": 0.2 }
        }
      }
    },
    "openrouter": {
      "id": "openrouter",
      "name": "OpenRouter",
      "models": {
        "any-model": {
          "id": "any-model", "name": "Any Model", "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 1, "output": 2 }
        },
        "anthropic/claude-sonnet-4.5": {
          "id": "anthropic/claude-sonnet-4.5", "name": "Anthropic: Claude Sonnet 4.5", "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15 }
        }
      }
    },
    "ollama-cloud": {
      "id": "ollama-cloud",
      "name": "Ollama Cloud",
      "models": {
        "gpt-oss:120b": {
          "id": "gpt-oss:120b", "name": "gpt-oss 120B", "tool_call": true, "open_weights": true,
          "modalities": { "input": ["text"], "output": ["text"] }, "limit": { "context": 131072, "output": 32768 },
          "cost": { "input": 0, "output": 0 }
        }
      }
    },
    "deepseek": {
      "id": "deepseek",
      "name": "DeepSeek",
      "models": {
        "deepseek-chat": {
          "id": "deepseek-chat", "name": "DeepSeek Chat", "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] }, "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 0.28, "output": 0.42, "cache_read": 0.028 }
        }
      }
    },
    "not-a-king-louie-provider": {
      "id": "not-a-king-louie-provider",
      "name": "Elsewhere",
      "models": { "x-1": { "id": "x-1", "name": "X 1", "cost": { "input": 1, "output": 1 } } }
    }
  }
}
```

Create `tests/fixtures/models/scores.json` (the normalized scores shape, keyed by lowercase OpenRouter id):

```json
{
  "fetchedAt": "2026-09-27T00:00:00.000Z",
  "source": "artificial-analysis",
  "scores": {
    "openai/gpt-5.5": { "intelligence": 60.1, "coding": 55.2, "agentic": 50.3 },
    "anthropic/claude-sonnet-4.5": { "intelligence": 50, "coding": 48, "agentic": 52 },
    "anthropic/claude-haiku-4.5": { "intelligence": 40, "coding": null, "agentic": null }
  }
}
```

Create `tests/helpers/models-fixture.js`:

```js
// tests/helpers/models-fixture.js
// A Catalog loaded from the small fixture catalog in tests/fixtures/models/
// instead of the bundled snapshot, so exact-value tests never change when the
// snapshot is regenerated. Its fetch refuses: unit tests never touch the
// network.
const path = require('path');
const { Catalog } = require('../../src/models/catalog');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'models');

const noNetwork = async (url) => {
  throw new Error(`unit tests never touch the network (tried ${url})`);
};

function fixtureCatalog({ cacheDir = null, getSettings = () => ({}), fetch = noNetwork, now } = {}) {
  return new Catalog().load({ snapshotDir: FIXTURE_DIR, cacheDir, getSettings, fetch, ...(now ? { now } : {}) });
}

module.exports = { FIXTURE_DIR, fixtureCatalog };
```

- [ ] **Step 2: Write the failing catalog tests**

Create `tests/models-catalog.test.js`:

```js
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
```

- [ ] **Step 3: Write the failing pricing tests**

Create `tests/models-pricing.test.js`:

```js
// tests/models-pricing.test.js
// The single price function (spec 2026-09-27 §4.4) and the §1.1 evidence:
// five gpt-5.5 calls at models.dev list price total $0.5437.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { priceWithCost } = require('../src/models/pricing');
const { fixtureCatalog } = require('./helpers/models-fixture');

const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Spec §1.1: [input tokens, of which cached, output tokens, cost at list].
const SECTION_1_1_CALLS = [
  [39888, 0, 559, 0.2162],
  [43193, 39552, 185, 0.0435],
  [45211, 42624, 274, 0.0425],
  [45676, 44672, 264, 0.0353],
  [60765, 44672, 3446, 0.2062]
];

describe('Catalog.price', () => {
  it('prices the five §1.1 calls to $0.5437', () => {
    const catalog = fixtureCatalog();
    let total = 0;
    for (const [input, cached, output, expected] of SECTION_1_1_CALLS) {
      const r = catalog.price('openai', 'gpt-5.5', { input: input - cached, cachedInput: cached, output });
      assert.strictEqual(round4(r.usd), expected, `call with ${input} input tokens`);
      total += r.usd;
    }
    assert.strictEqual(round4(total), 0.5437);
  });

  it('returns the parts it priced separately', () => {
    const r = fixtureCatalog().price('anthropic', 'claude-haiku-4-5', { input: 1000, cachedInput: 3000, cacheWrite: 2000, output: 100 });
    assert.strictEqual(r.usd, 0.0043);
    assert.deepStrictEqual(r.parts, { input: 0.001, cachedInput: 0.0003, cacheWrite: 0.0025, output: 0.0005, reasoning: 0 });
    assert.strictEqual(r.tier, null);
  });

  it('applies the long-context tier only when the request\'s input exceeds it', () => {
    const c = fixtureCatalog();
    const over = c.price('openai', 'gpt-5.5', { input: 300000, output: 1000 });
    assert.strictEqual(over.usd, 3.045);
    assert.strictEqual(over.tier, 272000);
    assert.strictEqual(c.price('openai', 'gpt-5.5', { input: 272000 }).usd, 1.36, 'at the threshold, base rates');
    const cachedOver = c.price('openai', 'gpt-5.5', { input: 100000, cachedInput: 200000 });
    assert.strictEqual(cachedOver.tier, 272000, 'cached input counts toward the request size');
    assert.strictEqual(cachedOver.usd, 1.2);
  });

  it('prices reasoning at its own rate when the catalog has one, else as output', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.price('openai', 'o4-mini', { input: 1000, output: 500, reasoning: 200 }).usd, 0.00402);
    const plain = c.price('openai', 'gpt-5.5', { output: 500, reasoning: 200 });
    assert.strictEqual(plain.usd, 0.015);
    assert.strictEqual(plain.parts.reasoning, 0);
  });

  it('prices cached input at the input rate when no cache rate is listed', () => {
    assert.strictEqual(fixtureCatalog().price('groq', 'llama-3.3-70b', { cachedInput: 1000 }).usd, 0.00059);
  });

  it('returns null for an unpriced cost, never $0', () => {
    assert.strictEqual(priceWithCost(null, { input: 10 }), null);
    assert.strictEqual(priceWithCost({ input: 1, output: null }, { input: 10 }), null);
    assert.strictEqual(priceWithCost({ output: 1 }, { input: 10 }), null);
  });

  it('ignores negative and non-numeric counts', () => {
    assert.strictEqual(priceWithCost({ input: 1, output: 1 }, { input: -5, output: 'x' }).usd, 0);
  });
});
```

(Arithmetic for the non-obvious values: `cachedOver` is 100,000 × $10 + 200,000 × $1 per million = $1.20; `o4-mini` is 1,000 × 1.1 + 300 × 4.4 + 200 × 8 per million = $0.00402.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/models-catalog.test.js tests/models-pricing.test.js`
Expected: FAIL with `Cannot find module '../src/models/catalog'` (and `'../src/models/pricing'`).

- [ ] **Step 5: Write `src/models/provider-ids.js`**

```js
// src/models/provider-ids.js
// King Louie's provider keys and how they map onto the models.dev and
// OpenRouter namespaces (spec 2026-09-27 §4.3). The one place this map lives.

const KL_PROVIDERS = Object.freeze([
  'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'ollama', 'openrouter',
  'xai', 'deepseek', 'qwen', 'together', 'fireworks', 'cohere', 'copilot'
]);

// King Louie key → models.dev provider id. Keys not listed map to themselves.
// Ollama's catalog entries are Ollama Cloud's; local models come from the
// Ollama server itself (src/models/ollama.js).
const MODELS_DEV_IDS = Object.freeze({
  gemini: 'google',
  qwen: 'alibaba',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  copilot: 'github-copilot',
  ollama: 'ollama-cloud'
});

// King Louie key → the vendor prefix OpenRouter uses in its model ids, for
// attaching Artificial Analysis scores to the vendor's own models.
const OPENROUTER_VENDORS = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  xai: 'x-ai',
  deepseek: 'deepseek',
  mistral: 'mistralai',
  qwen: 'qwen',
  cohere: 'cohere'
});

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function modelsDevIdFor(provider) {
  const p = normalizeProvider(provider);
  return MODELS_DEV_IDS[p] || p;
}

function providerForModelsDevId(id) {
  const wanted = String(id || '').trim().toLowerCase();
  return KL_PROVIDERS.find((p) => modelsDevIdFor(p) === wanted) || null;
}

function isKnownProvider(provider) {
  return KL_PROVIDERS.includes(normalizeProvider(provider));
}

module.exports = {
  KL_PROVIDERS,
  MODELS_DEV_IDS,
  OPENROUTER_VENDORS,
  DEFAULT_OLLAMA_BASE_URL,
  normalizeProvider,
  modelsDevIdFor,
  providerForModelsDevId,
  isKnownProvider
};
```

- [ ] **Step 6: Write `src/models/normalize.js`**

```js
// src/models/normalize.js
// models.dev and OpenRouter documents → King Louie's catalog shapes
// (spec 2026-09-27 §4.1, §4.2). Pure functions; no I/O.
const { KL_PROVIDERS, modelsDevIdFor, OPENROUTER_VENDORS } = require('./provider-ids');

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const strList = (v, fallback) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : fallback);

// A response id such as gpt-5.5-2026-04-23 or claude-haiku-4-5-20251001 → its base id.
function stripDateSuffix(id) {
  return String(id || '').replace(DATE_SUFFIX, '');
}

function entryKey(provider, id) {
  return `${String(provider || '').toLowerCase()}:${String(id || '').toLowerCase()}`;
}

function emptyScores() {
  return { intelligence: null, coding: null, agentic: null, source: 'artificial-analysis' };
}

function tierFrom(aboveContext, t) {
  return { aboveContext, input: num(t.input), output: num(t.output), cacheRead: num(t.cache_read), cacheWrite: num(t.cache_write) };
}

// models.dev cost (USD per million tokens) → Entry.cost, or null when unpriced.
function normalizeCost(cost) {
  if (!isPlainObject(cost)) return null;
  const tiers = [];
  if (Array.isArray(cost.tiers)) {
    for (const t of cost.tiers) {
      if (!isPlainObject(t) || t.tier?.type !== 'context' || num(t.tier?.size) === null) continue;
      tiers.push(tierFrom(t.tier.size, t));
    }
  } else if (isPlainObject(cost.context_over_200k)) {
    tiers.push(tierFrom(200000, cost.context_over_200k));
  }
  tiers.sort((a, b) => a.aboveContext - b.aboveContext);
  return {
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cost.cache_read),
    cacheWrite: num(cost.cache_write),
    reasoning: num(cost.reasoning),
    tiers
  };
}

function effortsOf(options) {
  if (!Array.isArray(options)) return [];
  const effort = options.find((o) => isPlainObject(o) && o.type === 'effort' && Array.isArray(o.values));
  return effort ? effort.values.filter((v) => typeof v === 'string') : [];
}

// One models.dev model → Entry. `raw` needs at least an id.
function normalizeModel(provider, raw) {
  const id = String(raw.id);
  const limit = isPlainObject(raw.limit) ? raw.limit : {};
  const modalities = isPlainObject(raw.modalities) ? raw.modalities : {};
  return {
    provider,
    id,
    name: str(raw.name) || id,
    family: str(raw.family),
    releaseDate: str(raw.release_date),
    knowledge: str(raw.knowledge),
    limits: { context: num(limit.context), input: num(limit.input), output: num(limit.output) },
    input: strList(modalities.input, ['text']),
    output: strList(modalities.output, ['text']),
    toolCall: raw.tool_call === true,
    structuredOutput: raw.structured_output === true,
    reasoning: { supported: raw.reasoning === true, efforts: effortsOf(raw.reasoning_options) },
    openWeights: raw.open_weights === true,
    local: false,
    cost: normalizeCost(raw.cost),
    scores: emptyScores(),
    sources: []
  };
}

// models.dev api.json (or a trimmed copy of it) → Entry[] for King Louie's providers.
function normalizeModelsDev(data) {
  const out = [];
  if (!isPlainObject(data)) return out;
  for (const provider of KL_PROVIDERS) {
    const block = data[modelsDevIdFor(provider)];
    if (!isPlainObject(block) || !isPlainObject(block.models)) continue;
    for (const [key, raw] of Object.entries(block.models)) {
      if (!isPlainObject(raw)) continue;
      out.push(normalizeModel(provider, { ...raw, id: str(raw.id) || key }));
    }
  }
  return out;
}

// True when the document looks like models.dev: at least one of King Louie's
// providers with a models map.
function validateModelsDev(data) {
  if (!isPlainObject(data)) return false;
  return KL_PROVIDERS.some((p) => {
    const block = data[modelsDevIdFor(p)];
    return isPlainObject(block) && isPlainObject(block.models);
  });
}

// Keep only King Louie's 14 providers (about 450 KB of the 4.9 MB document).
function trimModelsDev(data) {
  const out = {};
  for (const p of KL_PROVIDERS) {
    const id = modelsDevIdFor(p);
    if (isPlainObject(data?.[id])) out[id] = data[id];
  }
  return out;
}

// OpenRouter /api/v1/models → { "<vendor>/<id>": { intelligence, coding, agentic } }
// with lowercase keys. Only benchmarks.artificial_analysis is kept; variants
// such as ":batch" are skipped.
function normalizeScores(json) {
  const out = {};
  const list = Array.isArray(json?.data) ? json.data : [];
  for (const m of list) {
    if (!isPlainObject(m) || typeof m.id !== 'string' || m.id.includes(':')) continue;
    const aa = m.benchmarks?.artificial_analysis;
    if (!isPlainObject(aa)) continue;
    const s = { intelligence: num(aa.intelligence_index), coding: num(aa.coding_index), agentic: num(aa.agentic_index) };
    if (s.intelligence === null && s.coding === null && s.agentic === null) continue;
    out[m.id.toLowerCase()] = s;
  }
  return out;
}

function validateScores(json) {
  return isPlainObject(json) && Array.isArray(json.data);
}

// OpenRouter ids write versions with dots where vendors use hyphens
// (claude-sonnet-4.5 against claude-sonnet-4-5); the index holds both.
const dotless = (key) => key.replace(/\./g, '-');

function buildScoreIndex(scores) {
  const index = new Map();
  for (const [key, value] of Object.entries(scores || {})) {
    const k = key.toLowerCase();
    index.set(k, value);
    if (!index.has(dotless(k))) index.set(dotless(k), value);
  }
  return index;
}

// Scores for one entry: OpenRouter's own entries by id, a vendor's by
// "<vendor>/<id>", each exact and then without a date suffix.
function scoreFor(index, provider, id) {
  const lower = String(id || '').toLowerCase();
  const ids = [...new Set([lower, stripDateSuffix(lower)])];
  let keys = [];
  if (provider === 'openrouter') keys = ids;
  else if (OPENROUTER_VENDORS[provider]) keys = ids.map((i) => `${OPENROUTER_VENDORS[provider]}/${i}`);
  for (const k of keys) {
    const hit = index.get(k) || index.get(dotless(k));
    if (hit) return hit;
  }
  return null;
}

// A model a local server reports (Ollama): zero cost, capabilities as reported.
function localEntry(provider, { id, name = null, context = null, toolCall = null, imageInput = false }) {
  return {
    provider,
    id: String(id),
    name: str(name) || String(id),
    family: null,
    releaseDate: null,
    knowledge: null,
    limits: { context: num(context), input: null, output: null },
    input: imageInput ? ['text', 'image'] : ['text'],
    output: ['text'],
    toolCall: toolCall === true,
    structuredOutput: false,
    reasoning: { supported: false, efforts: [] },
    openWeights: true,
    local: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, tiers: [] },
    scores: emptyScores(),
    sources: []
  };
}

module.exports = {
  isPlainObject,
  stripDateSuffix,
  entryKey,
  emptyScores,
  normalizeCost,
  normalizeModel,
  normalizeModelsDev,
  validateModelsDev,
  trimModelsDev,
  normalizeScores,
  validateScores,
  buildScoreIndex,
  scoreFor,
  localEntry
};
```

- [ ] **Step 7: Write `src/models/pricing.js`**

```js
// src/models/pricing.js
// The only price function (spec 2026-09-27 §4.4). Rates are USD per million
// tokens. usage: { input, cachedInput, cacheWrite, output, reasoning }, where
// input is the uncached input and reasoning is the part of output spent on
// reasoning (providers report reasoning tokens inside the output count).
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => (isNum(v) && v > 0 ? v : 0);
const round8 = (n) => Number(n.toFixed(8));

function priceWithCost(cost, usage = {}) {
  if (!cost || !isNum(cost.input) || !isNum(cost.output)) return null;
  const u = {
    input: count(usage.input),
    cachedInput: count(usage.cachedInput),
    cacheWrite: count(usage.cacheWrite),
    output: count(usage.output),
    reasoning: count(usage.reasoning)
  };
  // The long-context tier applies when the whole request's input exceeds it.
  const requestInput = u.input + u.cachedInput + u.cacheWrite;
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const tier = tiers
    .filter((t) => t && isNum(t.aboveContext) && requestInput > t.aboveContext)
    .sort((a, b) => b.aboveContext - a.aboveContext)[0] || null;
  const rate = (field) => {
    if (tier && isNum(tier[field])) return tier[field];
    return isNum(cost[field]) ? cost[field] : null;
  };
  const inputRate = rate('input');
  const outputRate = rate('output');
  // No listed cache rate: the provider bills those tokens as plain input.
  const cacheReadRate = rate('cacheRead') ?? inputRate;
  const cacheWriteRate = rate('cacheWrite') ?? inputRate;
  const reasoningRate = rate('reasoning');
  const reasoningTokens = reasoningRate === null ? 0 : Math.min(u.reasoning, u.output);
  const raw = {
    input: u.input * inputRate,
    cachedInput: u.cachedInput * cacheReadRate,
    cacheWrite: u.cacheWrite * cacheWriteRate,
    output: (u.output - reasoningTokens) * outputRate,
    reasoning: reasoningTokens * (reasoningRate || 0)
  };
  const parts = {};
  let total = 0;
  for (const [key, value] of Object.entries(raw)) {
    parts[key] = round8(value / 1e6);
    total += value / 1e6;
  }
  return { usd: round8(total), parts, tier: tier ? tier.aboveContext : null };
}

module.exports = { priceWithCost };
```

- [ ] **Step 8: Write `src/models/catalog.js`** (loading and lookup; Task 2 adds `refresh`)

```js
// src/models/catalog.js
// The model catalog (spec 2026-09-27 §4): what a model is, what it can do and
// what it costs. Sources merge in order, later winning field by field:
// bundled snapshot → cached live models.dev copy → Artificial Analysis scores
// → local models (Ollama) → owner overrides. Loading never touches the network.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { normalizeProvider } = require('./provider-ids');
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
    if (JSON.stringify(this._overrides()) !== this._overridesSig) this._rebuild();
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
    const entry = this._lookup(provider, modelId);
    return entry ? priceWithCost(entry.cost, usage) : null;
  }

  setLocalModels(provider, entries = []) {
    const p = normalizeProvider(provider);
    this._local.set(p, (Array.isArray(entries) ? entries : []).map((e) => ({ ...e, provider: p })));
    this._rebuild();
    this.emit('updated', this.status());
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
```

- [ ] **Step 9: Write `src/models/index.js`**

```js
// src/models/index.js
// The model subsystem (spec 2026-09-27): catalog, pricing and availability.
// Electron-free; tests/electron-boundary.test.js covers it.
const { Catalog, CATALOG_DEFAULTS, DEFAULT_SNAPSHOT_DIR } = require('./catalog');
const { priceWithCost } = require('./pricing');
const providerIds = require('./provider-ids');

let active = null;
let bundled = null;

// The catalog a provider prices against when none was injected: the core's
// once it has set one, else the bundled snapshot alone (never the network).
function getActiveCatalog() {
  if (active) return active;
  if (!bundled) bundled = new Catalog().load({});
  return bundled;
}

function setActiveCatalog(catalog) {
  active = catalog || null;
}

module.exports = {
  Catalog,
  CATALOG_DEFAULTS,
  DEFAULT_SNAPSHOT_DIR,
  priceWithCost,
  getActiveCatalog,
  setActiveCatalog,
  ...providerIds
};
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test tests/models-catalog.test.js tests/models-pricing.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 12: Commit**

```bash
git add src/models tests/fixtures/models tests/helpers/models-fixture.js tests/models-catalog.test.js tests/models-pricing.test.js
git commit -m "feat(models): catalog with provider id map, overrides and the single price function"
```

---

## Task 2: Settings for the models namespace, and the catalog refresh

**Files:**
- Modify: `src/core/settings.js:1-6` (requires), `:7-116` (`DEFAULT_SETTINGS`), `:118-220` (`mergeSettings`)
- Modify: `src/models/catalog.js` (add `refresh` and its helpers)
- Test: `tests/models-catalog-refresh.test.js` (new), `tests/core-settings.test.js` (add cases)

**Interfaces:**
- Consumes: `Catalog`, `CATALOG_DEFAULTS` (Task 1); `trimModelsDev`, `validateModelsDev`, `normalizeScores`, `validateScores` (Task 1).
- Produces:
  - `DEFAULT_SETTINGS.models = { catalog: { ...CATALOG_DEFAULTS }, overrides: {}, ollama: { baseUrl: 'http://127.0.0.1:11434' }, availability: { retestHours: 24 } }`, merged key by key in `mergeSettings`.
  - `Catalog#refresh({ force = false } = {}) → Promise<{ source, fetchedAt }>`: fetches models.dev and the OpenRouter scores when `models.catalog.fetch` is on and the cached copy is older than `refreshHours` (or `force`), sends `If-None-Match` with the cached ETag, writes `<cacheDir>/models-dev.json` as `{ fetchedAt, etag, data }` (data trimmed to the 14 providers) and `<cacheDir>/scores.json` as `{ fetchedAt, etag, source: 'artificial-analysis', scores }`, keeps the previous copy on any failure or malformed document, and emits `'updated'` when something changed. Never throws.

- [ ] **Step 1: Write the failing refresh tests**

Create `tests/models-catalog-refresh.test.js`:

```js
// tests/models-catalog-refresh.test.js
// Live catalog refresh (spec 2026-09-27 §4.1, §15): daily fetch with ETag,
// cache under <dataDir>/catalog/, fetch switch, malformed documents discarded,
// fallback to cache then snapshot. The fetch is injected; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { CATALOG_DEFAULTS } = require('../src/models/catalog');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-catalog-refresh-')); dirs.push(d); return d; };

const MODELS_URL = CATALOG_DEFAULTS.modelsDevUrl;
const SCORES_URL = CATALOG_DEFAULTS.scoresUrl;

const LIVE_MODELS = {
  openai: {
    id: 'openai',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5 live', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 5, output: 30, cache_read: 0.5 } }
    }
  },
  'not-ours': { id: 'not-ours', models: { a: { id: 'a' } } }
};
const LIVE_SCORES = {
  data: [{ id: 'openai/gpt-5.5', benchmarks: { artificial_analysis: { intelligence_index: 61, coding_index: 56, agentic_index: 51 } } }]
};

const json = (body, { status = 200, etag = null } = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) }
});

// routes: url → (init, callIndex) => Response. Records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: { ...(init.headers || {}) } });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init, calls.filter((c) => c.url === url).length);
  };
  fn.calls = calls;
  return fn;
}

const clock = (iso) => {
  const state = { now: new Date(iso) };
  return { now: () => state.now, set: (next) => { state.now = new Date(next); } };
};

const liveRoutes = () => ({
  [MODELS_URL]: (init, n) => (n > 1 && init.headers?.['If-None-Match'] === '"md-1"' ? new Response(null, { status: 304 }) : json(LIVE_MODELS, { etag: '"md-1"' })),
  [SCORES_URL]: (init, n) => (n > 1 && init.headers?.['If-None-Match'] === '"sc-1"' ? new Response(null, { status: 304 }) : json(LIVE_SCORES, { etag: '"sc-1"' }))
});

describe('Catalog.refresh', () => {
  it('fetches models.dev and scores, caches them trimmed, and serves them', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    const events = [];
    c.on('updated', (s) => events.push(s));
    const r = await c.refresh();
    assert.deepStrictEqual(r, { source: 'live', fetchedAt: '2026-09-28T08:00:00.000Z' });
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    assert.strictEqual(c.get('openai', 'gpt-5.5').scores.intelligence, 61);
    assert.ok(c.get('anthropic', 'claude-sonnet-4-5'), 'snapshot entries stay');
    const file = JSON.parse(fs.readFileSync(path.join(cacheDir, 'models-dev.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(file.data), ['openai'], 'trimmed to King Louie providers');
    assert.strictEqual(file.etag, '"md-1"');
    const scores = JSON.parse(fs.readFileSync(path.join(cacheDir, 'scores.json'), 'utf8'));
    assert.deepStrictEqual(scores.scores['openai/gpt-5.5'], { intelligence: 61, coding: 56, agentic: 51 });
    assert.strictEqual(events.length, 1);
  });

  it('does not fetch again within refreshHours; a forced refresh sends the ETag and keeps the copy on 304', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 2);
    t.set('2026-09-28T09:00:00Z');
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 2, 'fresh copy: no fetch');
    await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 4);
    assert.strictEqual(fetch.calls[2].headers['If-None-Match'], '"md-1"');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    assert.strictEqual(c.status().fetchedAt, '2026-09-28T09:00:00.000Z', '304 renews the copy');
  });

  it('fetches again once the cached copy is older than refreshHours', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    await c.refresh();
    t.set('2026-09-29T09:00:00Z');
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 4);
  });

  it('models.catalog.fetch false turns both fetches off', async () => {
    const fetch = fakeFetch(liveRoutes());
    const c = fixtureCatalog({ cacheDir: tmp(), fetch, getSettings: () => ({ models: { catalog: { fetch: false } } }) });
    const r = await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 0);
    assert.strictEqual(r.source, 'snapshot');
  });

  it('keeps the previous copy when the response is not JSON', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch({ [MODELS_URL]: () => new Response('not json', { status: 200 }), [SCORES_URL]: () => new Response('<html>', { status: 200 }) });
    const c = fixtureCatalog({ cacheDir, fetch });
    const events = [];
    c.on('updated', (s) => events.push(s));
    await c.refresh();
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5');
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'models-dev.json')), false);
    assert.strictEqual(c.status().source, 'snapshot');
    assert.strictEqual(events.length, 0);
  });

  it('discards a document that is not a models.dev catalog or an OpenRouter list', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch({ [MODELS_URL]: () => json({ openai: 5 }), [SCORES_URL]: () => json({ nope: true }) });
    const c = fixtureCatalog({ cacheDir, fetch });
    await c.refresh();
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'models-dev.json')), false);
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'scores.json')), false);
    assert.strictEqual(c.get('openai', 'gpt-5.5').scores.intelligence, 60.1);
  });

  it('keeps the previous copy on an HTTP error', async () => {
    const fetch = fakeFetch({ [MODELS_URL]: () => json({ error: 'down' }, { status: 503 }), [SCORES_URL]: () => json({ error: 'down' }, { status: 503 }) });
    const c = fixtureCatalog({ cacheDir: tmp(), fetch });
    await c.refresh();
    assert.strictEqual(c.status().source, 'snapshot');
  });

  it('falls back to the cached copy, then the snapshot, when the fetch fails', async () => {
    const cacheDir = tmp();
    await fixtureCatalog({ cacheDir, fetch: fakeFetch(liveRoutes()) }).refresh();
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const c = fixtureCatalog({ cacheDir, fetch: offline });
    await c.refresh({ force: true });
    assert.strictEqual(c.status().source, 'cache');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    const bare = fixtureCatalog({ cacheDir: tmp(), fetch: offline });
    await bare.refresh();
    assert.strictEqual(bare.status().source, 'snapshot');
  });

  it('serves the fetched copy for the session even when the cache dir cannot be written', async () => {
    const blocker = path.join(tmp(), 'not-a-dir');
    fs.writeFileSync(blocker, 'a file where the catalog folder should be');
    const c = fixtureCatalog({ cacheDir: blocker, fetch: fakeFetch(liveRoutes()) });
    const r = await c.refresh();
    assert.strictEqual(r.source, 'live');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
  });

  it('does nothing without a cache dir', async () => {
    const fetch = fakeFetch(liveRoutes());
    const c = fixtureCatalog({ fetch });
    await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 0);
  });
});
```

Append to `tests/core-settings.test.js`, inside the existing `describe('core settings', ...)` block, after the `'treats null as empty'` test:

```js
  it('carries the models defaults (spec 2026-09-27 §14, stage M1 keys)', () => {
    const merged = mergeSettings({});
    assert.deepStrictEqual(merged.models.catalog, {
      fetch: true, refreshHours: 24, staleWarnDays: 30,
      modelsDevUrl: 'https://models.dev/api.json',
      scoresUrl: 'https://openrouter.ai/api/v1/models'
    });
    assert.deepStrictEqual(merged.models.overrides, {});
    assert.deepStrictEqual(merged.models.ollama, { baseUrl: 'http://127.0.0.1:11434' });
    assert.deepStrictEqual(merged.models.availability, { retestHours: 24 });
  });

  it('merges models keys one by one and keeps the owner\'s values', () => {
    const merged = mergeSettings({
      models: {
        catalog: { fetch: false },
        overrides: { 'openai:gpt-5.5': { cost: { input: 4 } } },
        ollama: { baseUrl: 'http://192.0.2.10:11434' }
      }
    });
    assert.strictEqual(merged.models.catalog.fetch, false);
    assert.strictEqual(merged.models.catalog.refreshHours, 24);
    assert.deepStrictEqual(merged.models.overrides, { 'openai:gpt-5.5': { cost: { input: 4 } } });
    assert.strictEqual(merged.models.ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(merged.models.availability.retestHours, 24);
    assert.deepStrictEqual(mergeSettings({ models: { overrides: ['not', 'an', 'object'] } }).models.overrides, {});
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-catalog-refresh.test.js tests/core-settings.test.js`
Expected: FAIL (`c.refresh is not a function`; `Cannot read properties of undefined (reading 'catalog')`).

- [ ] **Step 3: Add the models namespace to `src/core/settings.js`**

At the top of the file, after the existing requires (lines 1-5), add:

```js
const { CATALOG_DEFAULTS } = require('../models/catalog');
const { DEFAULT_OLLAMA_BASE_URL } = require('../models/provider-ids');
```

In `DEFAULT_SETTINGS`, after the `inference: { ... }` block (ends at line 81) and before `notifications`, add:

```js
  // Model catalog and availability (spec 2026-09-27 §14; the stage M1 keys).
  // Tiers above keep routing until stage M2 migrates them to profiles.
  models: {
    catalog: { ...CATALOG_DEFAULTS },
    overrides: {},
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
    availability: { retestHours: 24 }
  },
```

In `mergeSettings`, after the `inference: { ... }` block (ends at line 162) and before `notifications`, add:

```js
    models: {
      ...(DEFAULT_SETTINGS.models || {}),
      ...(source.models || {}),
      catalog: {
        ...DEFAULT_SETTINGS.models.catalog,
        ...(source.models?.catalog || {})
      },
      overrides: source.models?.overrides && typeof source.models.overrides === 'object' && !Array.isArray(source.models.overrides)
        ? source.models.overrides
        : {},
      ollama: {
        ...DEFAULT_SETTINGS.models.ollama,
        ...(source.models?.ollama || {})
      },
      availability: {
        ...DEFAULT_SETTINGS.models.availability,
        ...(source.models?.availability || {})
      }
    },
```

- [ ] **Step 4: Add `refresh` to `src/models/catalog.js`**

After `readJson` (near the top), add the atomic writer and the fetch timeout:

```js
const FETCH_TIMEOUT_MS = 30000;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
```

Inside `class Catalog`, after `setLocalModels`, add:

```js
  // Fetch the live catalog and scores (spec §4.1): at most once per
  // refreshHours unless forced, with the cached ETag, never throwing. A
  // failure or a malformed document keeps the previous copy.
  async refresh({ force = false } = {}) {
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/models-catalog-refresh.test.js tests/core-settings.test.js tests/models-catalog.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/core/settings.js src/models/catalog.js tests/models-catalog-refresh.test.js tests/core-settings.test.js
git commit -m "feat(models): models settings namespace and the daily catalog refresh with ETag"
```

---

## Task 3: The snapshot script and the bundled snapshot

**Files:**
- Create: `scripts/models-snapshot.js`
- Create (generated, committed): `src/models/snapshot/models-dev.json`, `src/models/snapshot/scores.json`
- Modify: `package.json` (`scripts`)
- Test: `tests/models-snapshot.test.js`

**Interfaces:**
- Consumes: `trimModelsDev`, `validateModelsDev`, `normalizeScores`, `validateScores` (Task 1), `CATALOG_DEFAULTS` (Task 1), `Catalog`, `KL_PROVIDERS`.
- Produces: `scripts/models-snapshot.js` exporting `buildSnapshot({ fetch?, modelsDevUrl?, scoresUrl?, now? }) → Promise<{ modelsDev: { fetchedAt, source: 'models.dev', data }, scores: { fetchedAt, source: 'artificial-analysis', scores } }>`; `npm run models:snapshot` writes both files. After this task, `getActiveCatalog()` (no core) prices from the real snapshot.

- [ ] **Step 1: Write the failing test**

Create `tests/models-snapshot.test.js`:

```js
// tests/models-snapshot.test.js
// The bundled catalog (spec 2026-09-27 §4.1): the script that builds it, and
// the committed snapshot a fresh install works from, fully offline.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildSnapshot } = require('../scripts/models-snapshot');
const { Catalog, DEFAULT_SNAPSHOT_DIR } = require('../src/models/catalog');
const { KL_PROVIDERS } = require('../src/models/provider-ids');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('buildSnapshot', () => {
  it('trims models.dev to King Louie\'s providers and keeps only the Artificial Analysis scores', async () => {
    const fetch = async (url) => (url.includes('models.dev')
      ? json({ openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }, 'not-ours': { id: 'not-ours', models: {} } })
      : json({ data: [{ id: 'openai/gpt-5.5', benchmarks: { artificial_analysis: { intelligence_index: 60, coding_index: null, agentic_index: 50 } } }] }));
    const snap = await buildSnapshot({ fetch, now: () => new Date('2026-09-27T00:00:00Z') });
    assert.deepStrictEqual(Object.keys(snap.modelsDev.data), ['openai']);
    assert.strictEqual(snap.modelsDev.fetchedAt, '2026-09-27T00:00:00.000Z');
    assert.strictEqual(snap.modelsDev.source, 'models.dev');
    assert.deepStrictEqual(snap.scores.scores, { 'openai/gpt-5.5': { intelligence: 60, coding: null, agentic: 50 } });
  });

  it('refuses a document that is not a catalog, or a failed fetch', async () => {
    await assert.rejects(buildSnapshot({ fetch: async () => json({ nope: true }) }), /did not return a models\.dev catalog/);
    await assert.rejects(buildSnapshot({ fetch: async () => json({}, 500) }), /returned 500/);
  });
});

describe('the bundled snapshot', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(DEFAULT_SNAPSHOT_DIR, name), 'utf8'));

  it('is small and carries its date', () => {
    for (const name of ['models-dev.json', 'scores.json']) {
      const size = fs.statSync(path.join(DEFAULT_SNAPSHOT_DIR, name)).size;
      assert.ok(size < 1024 * 1024, `${name} is ${size} bytes`);
    }
    assert.ok(!Number.isNaN(Date.parse(read('models-dev.json').fetchedAt)));
    assert.ok(!Number.isNaN(Date.parse(read('scores.json').fetchedAt)));
  });

  it('covers every King Louie provider and loads without the network', () => {
    const catalog = new Catalog().load({ fetch: async () => { throw new Error('no network'); } });
    for (const provider of KL_PROVIDERS) assert.ok(catalog.list(provider).length > 0, `${provider} has models`);
    assert.ok(catalog.list().length >= 500, `${catalog.list().length} models`);
    assert.strictEqual(catalog.status().source, 'snapshot');
    assert.ok(Object.keys(read('scores.json').scores).length >= 100);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/models-snapshot.test.js`
Expected: FAIL with `Cannot find module '../scripts/models-snapshot'`.

- [ ] **Step 3: Write `scripts/models-snapshot.js`**

```js
#!/usr/bin/env node
// scripts/models-snapshot.js
// Regenerates the bundled model catalog (spec 2026-09-27 §4.1): models.dev
// trimmed to King Louie's 14 providers, and Artificial Analysis scores from
// OpenRouter's model list. Run before each release: npm run models:snapshot
const fs = require('fs');
const path = require('path');
const { trimModelsDev, validateModelsDev, normalizeScores, validateScores } = require('../src/models/normalize');
const { CATALOG_DEFAULTS, DEFAULT_SNAPSHOT_DIR } = require('../src/models/catalog');

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function buildSnapshot({
  fetch: fetchImpl = globalThis.fetch,
  modelsDevUrl = CATALOG_DEFAULTS.modelsDevUrl,
  scoresUrl = CATALOG_DEFAULTS.scoresUrl,
  now = () => new Date()
} = {}) {
  const [modelsDev, scores] = await Promise.all([getJson(fetchImpl, modelsDevUrl), getJson(fetchImpl, scoresUrl)]);
  if (!validateModelsDev(modelsDev)) throw new Error(`${modelsDevUrl} did not return a models.dev catalog.`);
  if (!validateScores(scores)) throw new Error(`${scoresUrl} did not return an OpenRouter model list.`);
  const fetchedAt = now().toISOString();
  return {
    modelsDev: { fetchedAt, source: 'models.dev', data: trimModelsDev(modelsDev) },
    scores: { fetchedAt, source: 'artificial-analysis', scores: normalizeScores(scores) }
  };
}

async function main() {
  const snap = await buildSnapshot();
  fs.mkdirSync(DEFAULT_SNAPSHOT_DIR, { recursive: true });
  const write = (name, doc) => {
    const file = path.join(DEFAULT_SNAPSHOT_DIR, name);
    fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
    return fs.statSync(file).size;
  };
  const modelBytes = write('models-dev.json', snap.modelsDev);
  const scoreBytes = write('scores.json', snap.scores);
  const providers = Object.keys(snap.modelsDev.data).length;
  const models = Object.values(snap.modelsDev.data).reduce((n, block) => n + Object.keys(block.models || {}).length, 0);
  process.stdout.write(`models-dev.json: ${providers} providers, ${models} models, ${Math.round(modelBytes / 1024)} KB\n`);
  process.stdout.write(`scores.json: ${Object.keys(snap.scores.scores).length} scored models, ${Math.round(scoreBytes / 1024)} KB\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`models:snapshot failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildSnapshot };
```

- [ ] **Step 4: Add the npm script**

In `package.json`, in `"scripts"`, after `"test:watch"`, add:

```json
    "models:snapshot": "node scripts/models-snapshot.js",
```

- [ ] **Step 5: Generate the snapshot (needs the network)**

Run: `npm run models:snapshot`
Expected output (numbers as of the day it runs; 2026-09-27 gave these):

```
models-dev.json: 14 providers, 742 models, 438 KB
scores.json: 189 scored models, 18 KB
```

If a provider is missing from the first line's count, stop and report it; do not hand-edit the snapshot.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models-snapshot.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add scripts/models-snapshot.js package.json src/models/snapshot/models-dev.json src/models/snapshot/scores.json tests/models-snapshot.test.js
git commit -m "feat(models): bundled catalog snapshot and npm run models:snapshot"
```

---

## Task 4: Providers price every call through the catalog; UsageTracker trusts the recorded cost

**Files:**
- Modify: `src/providers/base-provider.js` (whole file, below)
- Modify: `src/providers/anthropic-provider.js:15-58` (constructor, pricing table, headers), `:173-229` (cost methods), and the five API URLs at `:257`, `:304`, `:349`, `:565`, `:652`
- Modify: `src/providers/openai-provider.js:71-124` (constructor, pricing table) and the API URLs at `:220`, `:246`, `:278`, `:323`, `:411`, `:445`, `:600-601`, `:686`, `:760`
- Modify: `src/providers/gemini-provider.js:7-10`, `:32-39`; `src/providers/mistral-provider.js:4-7`, `:29-36`
- Modify constructors: `src/providers/cohere-provider.js:4-7` (and its `listModels` URL at `:183`), `copilot-provider.js:12-19`, `deepseek-provider.js:4-7`, `fireworks-provider.js:4-7`, `groq-provider.js:4-7`, `ollama-provider.js:1-9`, `openrouter-provider.js:4-7`, `qwen-provider.js:4-7`, `together-provider.js:4-7`, `xai-provider.js:4-7`
- Modify: `src/tracking/usage-tracker.js` (whole file, below)
- Delete: `src/tracking/pricing-tables.js`
- Test: `tests/models-provider-pricing.test.js` (new); rewrite `tests/usage-tracker.test.js:1-133`; delete the `'returns pricing table'` tests in `tests/gemini-provider.test.js:213-218` and `tests/mistral-provider.test.js:102-107`; update `tests/ollama-provider.test.js:13-16`

**Interfaces:**
- Consumes: `getActiveCatalog()` and `DEFAULT_OLLAMA_BASE_URL` from `src/models` (Task 1); `Catalog#price` (Task 1); the bundled snapshot (Task 3).
- Produces:
  - Every provider constructor is `(apiKey, options = {})` and passes `options` to `super`. `options.catalog` (a `Catalog`) prices its calls; `options.baseUrl` overrides its API base (trailing slashes removed); Copilot also takes `options.tokenExchangeUrl`; Ollama takes `options.serverUrl` (the Ollama address, default `http://127.0.0.1:11434`, API base `${serverUrl}/v1`) and `options.baseUrl` wins over it.
  - `BaseLLMProvider.baseUrlFrom(options, fallback) → string` (static).
  - `provider.getCatalog() → Catalog` (injected, else `getActiveCatalog()`).
  - `provider.normalizeUsage(usage) → { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens }` (Anthropic adds `cacheReadInputTokens`).
  - `provider.usageForPricing(normalized) → { input, cachedInput, cacheWrite, output, reasoning }`.
  - `provider.buildLlmCallMetrics({ model, usage, partial = false }) → { provider, model, ...normalizedUsage, costUsd: number|null, unpriced?: true, usagePartial?: true }`.
  - No provider has `getModelPricingTable`, `calculateCostUsd` or `resolveModelPricing`.
  - `UsageTracker#record(event)` uses `event.costUsd` as the cost when it is a finite number, else `null`; it never prices by itself.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-provider-pricing.test.js`:

```js
// tests/models-provider-pricing.test.js
// Provider classes get their prices from the catalog (spec 2026-09-27 §4.4):
// one price function, no per-provider tables, unknown models unpriced.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const DeepSeekProvider = require('../src/providers/deepseek-provider');
const UsageTracker = require('../src/tracking/usage-tracker');
const { getActiveCatalog } = require('../src/models');
const { fixtureCatalog } = require('./helpers/models-fixture');

const catalog = fixtureCatalog();
const round4 = (n) => Math.round(n * 1e4) / 1e4;

function memoryStore() {
  const data = {};
  return {
    get: (key, fallback = null) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => { data[key] = value; }
  };
}

describe('providers price calls through the catalog', () => {
  it('prices an OpenAI chat call with cached input at the catalog rates', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'gpt-5.5', usage: { prompt_tokens: 43193, completion_tokens: 185, total_tokens: 43378, prompt_tokens_details: { cached_tokens: 39552 } } });
    assert.strictEqual(round4(m.costUsd), 0.0435);
    assert.strictEqual(m.cachedInputTokens, 39552);
    assert.strictEqual(m.unpriced, undefined);
    assert.strictEqual(m.usagePartial, undefined);
  });

  it('prices the Responses API usage shape the same way', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'gpt-5.5', usage: { input_tokens: 43193, output_tokens: 185, input_tokens_details: { cached_tokens: 39552 }, output_tokens_details: { reasoning_tokens: 100 } } });
    assert.strictEqual(round4(m.costUsd), 0.0435);
    assert.strictEqual(m.reasoningTokens, 100);
  });

  it('prices a dated response model as its base model, and never by prefix', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    assert.strictEqual(p.buildLlmCallMetrics({ model: 'gpt-5.4-mini-2026-03-17', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }).costUsd, 0.75);
    const unknown = p.buildLlmCallMetrics({ model: 'gpt-5.5-turbo', usage: { prompt_tokens: 1000, completion_tokens: 10 } });
    assert.strictEqual(unknown.costUsd, null);
    assert.strictEqual(unknown.unpriced, true);
  });

  it('prices Anthropic cache reads and writes as separate counts', () => {
    const p = new AnthropicProvider('sk-ant-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'claude-haiku-4-5', usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 100 } });
    assert.strictEqual(m.costUsd, 0.0043);
    assert.strictEqual(m.cacheReadInputTokens, 3000);
  });

  it('prices DeepSeek cache hits at the cache rate', () => {
    const p = new DeepSeekProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'deepseek-chat', usage: { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 } });
    assert.strictEqual(m.costUsd, 0.028);
  });

  it('marks a partial call, and never prices one with nothing reported as $0', () => {
    const none = new OpenAIProvider('sk-test-123456', { catalog }).buildLlmCallMetrics({ model: 'gpt-5.5', usage: {}, partial: true });
    assert.strictEqual(none.costUsd, null);
    assert.strictEqual(none.usagePartial, true);
    const some = new AnthropicProvider('sk-ant-test-123456', { catalog }).buildLlmCallMetrics({ model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 1 }, partial: true });
    assert.strictEqual(some.costUsd, 0.001205);
    assert.strictEqual(some.usagePartial, true);
  });

  it('uses the active catalog when none is injected', () => {
    assert.strictEqual(new OpenAIProvider('sk-test-123456').getCatalog(), getActiveCatalog());
  });

  it('no provider keeps a price table of its own', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const p = ProviderFactory.create(key, 'test-key-123456');
      for (const method of ['getModelPricingTable', 'calculateCostUsd', 'resolveModelPricing']) {
        assert.strictEqual(typeof p[method], 'undefined', `${key}.${method}`);
      }
    }
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'src', 'tracking', 'pricing-tables.js')), false);
  });
});

describe('provider construction options', () => {
  it('every provider takes a baseUrl option, without a trailing slash', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const p = ProviderFactory.create(key, 'test-key-123456', { baseUrl: 'http://127.0.0.1:9/x/' });
      assert.strictEqual(p.baseUrl, 'http://127.0.0.1:9/x', key);
    }
  });

  it('every provider passes its options to the base class', () => {
    for (const key of ProviderFactory.listRegistered()) {
      assert.strictEqual(ProviderFactory.create(key, 'test-key-123456', { catalog }).getCatalog(), catalog, key);
    }
  });

  it('keeps each provider\'s real API base by default', () => {
    const base = (key) => ProviderFactory.create(key, 'test-key-123456').baseUrl;
    assert.strictEqual(base('openai'), 'https://api.openai.com/v1');
    assert.strictEqual(base('anthropic'), 'https://api.anthropic.com/v1');
    assert.strictEqual(base('cohere'), 'https://api.cohere.com/v2');
    assert.strictEqual(base('ollama'), 'http://127.0.0.1:11434/v1');
  });

  it('Ollama builds its API base from the server address', () => {
    assert.strictEqual(ProviderFactory.create('ollama', '', { serverUrl: 'http://192.0.2.5:11434/' }).baseUrl, 'http://192.0.2.5:11434/v1');
  });

  it('Copilot takes a token exchange URL', () => {
    const p = ProviderFactory.create('copilot', 'ghp_test123456', { tokenExchangeUrl: 'http://127.0.0.1:9/token' });
    assert.strictEqual(p.tokenExchangeUrl, 'http://127.0.0.1:9/token');
  });
});

describe('UsageTracker trusts the recorded cost', () => {
  it('records the call\'s own costUsd', () => {
    const tracker = new UsageTracker(memoryStore());
    const r = tracker.record({ provider: 'openai', model: 'gpt-5.5', inputTokens: 1000, outputTokens: 10, costUsd: 0.0053 });
    assert.strictEqual(r.cost, 0.0053);
    assert.strictEqual(tracker.getSessionUsage().totalCost, 0.0053);
  });

  it('records no cost for an unpriced call instead of guessing one', () => {
    const tracker = new UsageTracker(memoryStore());
    assert.strictEqual(tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 }).cost, null);
    assert.strictEqual(tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500, costUsd: null }).cost, null);
    assert.strictEqual(tracker.getSessionUsage().totalCost, 0);
  });
});
```

(`some.costUsd`: 1,200 input × $1 + 1 output × $5 per million = $0.001205.)

Rewrite `tests/usage-tracker.test.js` lines 1-133 (keep the `'Usage IPC handlers'` describe from line 134 on unchanged). The new top of the file:

```js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const UsageTracker = require('../src/tracking/usage-tracker');
const { registerUsageHandlers } = require('../src/ipc/usage-handlers');

describe('UsageTracker', () => {
  let tracker;
  let mockStore;

  beforeEach(() => {
    mockStore = {
      data: {},
      get(key, fallbackValue = null) {
        return Object.prototype.hasOwnProperty.call(this.data, key)
          ? this.data[key]
          : fallbackValue;
      },
      set(key, value) {
        this.data[key] = value;
      }
    };

    tracker = new UsageTracker(mockStore);
  });

  it('records usage with the cost the call carries', () => {
    const result = tracker.record({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.00045
    });

    assert.strictEqual(result.cost, 0.00045);
    assert.strictEqual(result.inputTokens, 1000);
    assert.strictEqual(result.outputTokens, 500);
  });

  it('accumulates session usage totals', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 2000, outputTokens: 1000 });

    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 3000);
    assert.strictEqual(session.outputTokens, 1500);
    assert.strictEqual(session.totalTokens, 4500);
    assert.strictEqual(session.turns, 2);
  });

  it('persists daily usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    const today = new Date().toISOString().slice(0, 10);
    const daily = tracker.getDailyUsage(today);

    assert.ok(daily);
    assert.strictEqual(daily.inputTokens, 1000);
    assert.strictEqual(daily.outputTokens, 500);
    assert.strictEqual(daily.turns, 1);
  });

  it('tracks provider breakdown in session and daily usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.record({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', inputTokens: 700, outputTokens: 300 });

    const session = tracker.getSessionUsage();
    assert.ok(session.providers.openai);
    assert.ok(session.providers.anthropic);
    assert.strictEqual(session.providers.openai.turns, 1);
    assert.strictEqual(session.providers.anthropic.turns, 1);

    const today = new Date().toISOString().slice(0, 10);
    const daily = tracker.getDailyUsage(today);
    assert.ok(daily.providers.openai);
    assert.ok(daily.providers.anthropic);
  });

  it('returns null cost when the call carries none', () => {
    const result = tracker.record({
      provider: 'unknown',
      model: 'unknown-model',
      inputTokens: 1000,
      outputTokens: 500
    });

    assert.strictEqual(result.cost, null);
  });

  it('never recomputes a recorded cost from its own table', () => {
    const result = tracker.record({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 0.1234
    });

    assert.strictEqual(result.cost, 0.1234);
    const session = tracker.getSessionUsage();
    assert.strictEqual(session.totalCost, 0.1234);
  });

  it('resets session usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.reset();

    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 0);
    assert.strictEqual(session.outputTokens, 0);
    assert.strictEqual(session.totalTokens, 0);
    assert.strictEqual(session.turns, 0);
    assert.deepStrictEqual(session.providers, {});
  });
});
```

(The old `describe('PricingTables', ...)` block, lines 117-133, is gone with the table.)

In `tests/gemini-provider.test.js` delete the whole `it('returns pricing table', ...)` test (lines 213-218). In `tests/mistral-provider.test.js` delete the whole `it('returns pricing table', ...)` test (lines 102-107).

In `tests/ollama-provider.test.js` replace lines 13-16 with:

```js
  it('instantiates with the default Ollama address', () => {
    const provider = new OllamaProvider();
    assert.strictEqual(provider.baseUrl, 'http://127.0.0.1:11434/v1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-provider-pricing.test.js tests/usage-tracker.test.js tests/ollama-provider.test.js`
Expected: FAIL (costs come from the old tables; `getCatalog is not a function`; baseUrl options ignored; Ollama address still `localhost`).

- [ ] **Step 3: Replace `src/providers/base-provider.js`**

```js
const { buildProviderError } = require('./provider-error');
const { getActiveCatalog } = require('../models');
const { createLogger } = require('../logging');

const log = createLogger('providers');

class BaseLLMProvider {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.authMode = options.authMode || 'api-key';
    // Prices come from the model catalog (spec 2026-09-27 §4.4). The core
    // injects its own; without one the bundled snapshot prices the call.
    this.catalog = options.catalog || null;
    if (this.authMode === 'api-key') {
      this.validateApiKey();
    }
  }

  /** A provider's API base: options.baseUrl when given, without trailing slashes. */
  static baseUrlFrom(options, fallback) {
    return String(options?.baseUrl || fallback).replace(/\/+$/, '');
  }

  getCatalog() {
    return this.catalog || getActiveCatalog();
  }

  validateApiKey() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length < 8) {
      throw new Error('Invalid API key');
    }
  }

  normalizeMessages(chatHistory = []) {
    return chatHistory
      .map((msg) => {
        if (msg.role && msg.content) {
          return { role: msg.role, content: msg.content };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: msg.text
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  formatMessages(chatHistory) {
    return this.normalizeMessages(chatHistory);
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  getDefaultModel() {
    throw new Error('getDefaultModel must be implemented by provider');
  }

  getProviderName() {
    return 'unknown';
  }

  normalizeUsage(usage = {}) {
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens) || 0;

    // Provider-specific cache reporting:
    //   OpenAI chat:      usage.prompt_tokens_details.cached_tokens (subset of prompt_tokens)
    //   OpenAI responses: usage.input_tokens_details.cached_tokens (subset of input_tokens)
    //   Anthropic:        usage.cache_read_input_tokens / cache_creation_input_tokens
    //                     (NOT included in input_tokens — separate counts)
    //   Gemini:           usage.cached_content_token_count (subset of prompt input)
    //   DeepSeek:         usage.prompt_cache_hit_tokens (subset of prompt_tokens)
    const cachedInputTokens =
      Number(
        usage?.prompt_tokens_details?.cached_tokens
        ?? usage?.input_tokens_details?.cached_tokens
        ?? usage?.cache_read_input_tokens
        ?? usage?.cached_content_token_count
        ?? usage?.prompt_cache_hit_tokens
        ?? 0
      ) || 0;
    const cacheCreationInputTokens =
      Number(usage?.cache_creation_input_tokens ?? 0) || 0;
    // Reasoning tokens are reported inside the output count.
    const reasoningTokens =
      Number(
        usage?.completion_tokens_details?.reasoning_tokens
        ?? usage?.output_tokens_details?.reasoning_tokens
        ?? 0
      ) || 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      reasoningTokens
    };
  }

  /**
   * Normalized usage → the catalog's usage shape. OpenAI-style providers
   * report cached input inside the input count; Anthropic overrides this.
   */
  usageForPricing(normalized) {
    return {
      input: Math.max(0, normalized.inputTokens - normalized.cachedInputTokens),
      cachedInput: normalized.cachedInputTokens,
      cacheWrite: normalized.cacheCreationInputTokens,
      output: normalized.outputTokens,
      reasoning: normalized.reasoningTokens
    };
  }

  /**
   * One call's metrics, priced by the catalog. An unknown model is unpriced
   * (costUsd null, unpriced true), never $0. A call cut off by Stop is
   * partial (usagePartial true); with nothing reported its cost is unknown.
   */
  buildLlmCallMetrics({ model, usage, partial = false } = {}) {
    const normalizedModel = model || this.getDefaultModel();
    const normalizedUsage = this.normalizeUsage(usage || {});
    const provider = this.getProviderName();

    let priced = null;
    try {
      priced = this.getCatalog().price(provider, normalizedModel, this.usageForPricing(normalizedUsage));
    } catch (err) {
      log.warn(`Pricing ${provider}/${normalizedModel} failed: ${err.message}`);
    }

    const reported = normalizedUsage.inputTokens
      + normalizedUsage.outputTokens
      + normalizedUsage.cachedInputTokens
      + normalizedUsage.cacheCreationInputTokens;
    const costUsd = priced && !(partial && reported === 0) ? priced.usd : null;

    return {
      provider,
      model: normalizedModel,
      ...normalizedUsage,
      costUsd,
      ...(priced ? {} : { unpriced: true }),
      ...(partial ? { usagePartial: true } : {})
    };
  }

  /**
   * Derive the human-readable message from a parsed error body.
   *
   * This is the union of what every provider's own `extractError` did:
   * OpenAI-shaped providers use `error.message`, Cohere puts it at the top
   * level as `message`, Copilot accepts either. Overriding is rarely needed.
   */
  messageFromErrorBody(body, response) {
    return (
      body?.error?.message
      || body?.message
      || `${response?.status ?? ''} ${response?.statusText ?? ''}`.trim()
    );
  }

  /**
   * Build a ProviderError from a failed Response.
   *
   * Providers previously threw `new Error(await this.extractError(response))`,
   * discarding the status code and `retry-after` header at the throw site and
   * forcing every consumer downstream to guess by substring-matching the
   * message. The message produced here is unchanged; the difference is that
   * the structured fields survive.
   *
   * Reads the body exactly once — a Response body is not re-readable, so this
   * must not be combined with a separate `extractError` call on the same
   * response.
   */
  async buildError(response, details = {}) {
    let body = null;
    let message = '';

    // Read the body through whichever accessor this response actually has.
    // Real fetch Responses expose both text() and json(), but transports and
    // test doubles frequently implement only one, and assuming text() would
    // silently degrade every such error to "401 Unauthorized".
    try {
      if (typeof response?.text === 'function') {
        const text = await response.text();
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON error bodies (HTML error pages from proxies, plain text
          // from local runtimes) still carry signal worth keeping in the
          // message, but must not blow up parsing.
          body = null;
          if (text && text.length <= 500) message = text.trim();
        }
      } else if (typeof response?.json === 'function') {
        body = await response.json();
      }
    } catch {
      body = null;
    }

    if (!message || body) {
      message = this.messageFromErrorBody(body, response);
    }

    return buildProviderError(response, message, {
      provider: this.getProviderName(),
      body,
      ...details
    });
  }

  async sendMessage() {
    throw new Error('sendMessage must be implemented by provider');
  }

  async streamMessage() {
    throw new Error('streamMessage must be implemented by provider');
  }

  getModels() {
    return [];
  }

  /**
   * Discover available models from the provider's API.
   * Override in subclasses that support model discovery.
   * @returns {Promise<Array<{id: string, name: string, capabilities: string[]}>>}
   */
  async discoverModels() {
    // Default: return static model list from getModels()
    return this.getModels().map(m => ({
      id: typeof m === 'string' ? m : m.id,
      name: typeof m === 'string' ? m : (m.name || m.id),
      capabilities: ['chat', 'streaming']
    }));
  }

  async listModels() {
    throw new Error('listModels must be implemented by provider');
  }
}

module.exports = BaseLLMProvider;
```

- [ ] **Step 4: Update Anthropic**

In `src/providers/anthropic-provider.js`:

1. Inside `class AnthropicProvider extends BaseLLMProvider {`, before `getProviderName()` (line 16), add:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.anthropic.com/v1');
  }

```

2. Delete `getModelPricingTable()` (lines 29-39).
3. Delete `calculateCostUsd(...)` with its doc comment (lines 173-200) and the `buildLlmCallMetrics(...)` override (lines 211-229). Keep `normalizeUsage` (lines 202-209) and add after it:

```js
  // Anthropic's input_tokens excludes cache reads and writes; they are
  // separate counts, each priced at its own catalog rate.
  usageForPricing(normalized) {
    return {
      input: normalized.inputTokens,
      cachedInput: normalized.cacheReadInputTokens,
      cacheWrite: normalized.cacheCreationInputTokens,
      output: normalized.outputTokens,
      reasoning: 0
    };
  }
```

4. Replace each `'https://api.anthropic.com/v1/messages'` (lines 257, 304, 349, 565) with `` `${this.baseUrl}/messages` `` and `'https://api.anthropic.com/v1/models'` (line 652) with `` `${this.baseUrl}/models` ``.

- [ ] **Step 5: Update OpenAI**

In `src/providers/openai-provider.js`:

1. Inside `class OpenAIProvider extends BaseLLMProvider {`, before `prependSystemPrompt` (line 72), add:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.openai.com/v1');
  }

```

2. Delete `getModelPricingTable()` (lines 104-120).
3. Replace every hardcoded URL: `'https://api.openai.com/v1/chat/completions'` (lines 220, 278, 601) → `` `${this.baseUrl}/chat/completions` ``; `'https://api.openai.com/v1/completions'` (lines 246, 323, 600) → `` `${this.baseUrl}/completions` ``; `'https://api.openai.com/v1/responses'` (lines 411, 445, 686) → `` `${this.baseUrl}/responses` ``; `'https://api.openai.com/v1/models'` (line 760) → `` `${this.baseUrl}/models` ``. After this, `grep -n "api.openai.com" src/providers/openai-provider.js` shows only the constructor default.

- [ ] **Step 6: Update Gemini and Mistral**

`src/providers/gemini-provider.js` lines 7-10 become:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://generativelanguage.googleapis.com/v1beta');
  }
```

and delete `getModelPricingTable()` (lines 32-39).

`src/providers/mistral-provider.js` lines 4-7 become:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.mistral.ai/v1');
  }
```

and delete `getModelPricingTable()` (lines 29-36).

- [ ] **Step 7: Update the remaining constructors**

Replace each constructor (lines 4-7 in every file below) with the version shown; nothing else in these files changes in this task except Cohere's `listModels` URL.

`src/providers/cohere-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.cohere.com/v2');
  }
```

and in its `listModels` (line 183) replace `'https://api.cohere.com/v1/models'` with `` `${this.baseUrl.replace(/\/v2$/, '/v1')}/models` ``.

`src/providers/deepseek-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.deepseek.com/v1');
  }
```

`src/providers/fireworks-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.fireworks.ai/inference/v1');
  }
```

`src/providers/groq-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.groq.com/openai/v1');
  }
```

`src/providers/openrouter-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://openrouter.ai/api/v1');
  }
```

`src/providers/qwen-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  }
```

`src/providers/together-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.together.xyz/v1');
  }
```

`src/providers/xai-provider.js`:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.x.ai/v1');
  }
```

`src/providers/copilot-provider.js` lines 12-19 become:

```js
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.githubToken = apiKey;
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.githubcopilot.com');
    this.tokenExchangeUrl = options.tokenExchangeUrl || 'https://api.github.com/copilot_internal/v2/token';
    this._copilotToken = null;
    this._copilotTokenExpiresAt = 0;
  }
```

`src/providers/ollama-provider.js` lines 1-9 become:

```js
const BaseLLMProvider = require('./base-provider');
const { DEFAULT_OLLAMA_BASE_URL } = require('../models/provider-ids');

class OllamaProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    // Ollama needs no key: a placeholder satisfies the base class, and
    // validateApiKey below is a no-op.
    super(apiKey || 'ollama-local', options);
    // options.serverUrl is the Ollama address (settings models.ollama.baseUrl);
    // options.baseUrl, when given, is the OpenAI-compatible API base itself.
    const server = String(options.serverUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this.baseUrl = options.baseUrl ? BaseLLMProvider.baseUrlFrom(options, '') : `${server}/v1`;
  }
```

- [ ] **Step 8: Replace `src/tracking/usage-tracker.js` and delete the price table**

```js
// UsageTracker totals what each call recorded. It never prices a call: the
// cost comes from the provider's catalog-priced metrics (spec 2026-09-27
// §4.4). A call without a known cost counts its tokens and no dollars.
const createTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  turns: 0
});

const recordedCost = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

class UsageTracker {
  constructor(store) {
    this.store = store;
    this.sessionUsage = {
      ...createTotals(),
      providers: {}
    };
  }

  static normalizeDate(date = null) {
    if (!date) {
      return new Date().toISOString().slice(0, 10);
    }

    if (date instanceof Date) {
      return date.toISOString().slice(0, 10);
    }

    const normalized = String(date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return normalized;
    }

    return new Date(normalized).toISOString().slice(0, 10);
  }

  ensureProviderTotals(collection, provider) {
    const providerKey = String(provider || 'unknown').trim().toLowerCase() || 'unknown';
    if (!collection[providerKey]) {
      collection[providerKey] = createTotals();
    }

    return { key: providerKey, totals: collection[providerKey] };
  }

  applyToTotals(totals, event, resolvedCost = null) {
    const inputTokens = Number(event?.inputTokens) || 0;
    const outputTokens = Number(event?.outputTokens) || 0;
    const cacheReadTokens = Number(event?.cacheReadTokens) || 0;
    const totalTokens = Number(event?.totalTokens) || (inputTokens + outputTokens + cacheReadTokens);
    const cost = resolvedCost === null ? 0 : Number(resolvedCost) || 0;

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.totalTokens += totalTokens;
    totals.totalCost = Number((totals.totalCost + cost).toFixed(8));
    totals.turns += 1;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      cost: resolvedCost
    };
  }

  record(event = {}) {
    const provider = String(event.provider || '').trim().toLowerCase();
    const model = String(event.model || '').trim();
    const resolvedCost = recordedCost(event.costUsd);

    const applied = this.applyToTotals(this.sessionUsage, event, resolvedCost);
    const providerSession = this.ensureProviderTotals(this.sessionUsage.providers, provider || 'unknown');
    this.applyToTotals(providerSession.totals, event, resolvedCost);

    const today = UsageTracker.normalizeDate();
    const dailyKey = `usage.daily.${today}`;
    const existingDaily = this.store.get(dailyKey, {
      ...createTotals(),
      providers: {}
    });

    const daily = {
      ...createTotals(),
      ...existingDaily,
      providers: {
        ...(existingDaily?.providers || {})
      }
    };

    this.applyToTotals(daily, event, resolvedCost);
    const providerDaily = this.ensureProviderTotals(daily.providers, provider || 'unknown');
    this.applyToTotals(providerDaily.totals, event, resolvedCost);
    this.store.set(dailyKey, daily);

    return {
      provider,
      model,
      ...applied,
      ...(event.usagePartial ? { usagePartial: true } : {}),
      durationMs: Number(event.durationMs) || 0
    };
  }

  getSessionUsage() {
    return {
      ...this.sessionUsage,
      providers: {
        ...(this.sessionUsage.providers || {})
      }
    };
  }

  getDailyUsage(date = null) {
    const key = `usage.daily.${UsageTracker.normalizeDate(date)}`;
    const daily = this.store.get(key, null);
    if (!daily) return null;
    return {
      ...daily,
      providers: {
        ...(daily.providers || {})
      }
    };
  }

  reset() {
    this.sessionUsage = {
      ...createTotals(),
      providers: {}
    };
  }
}

module.exports = UsageTracker;
```

Run: `git rm src/tracking/pricing-tables.js`

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/models-provider-pricing.test.js tests/usage-tracker.test.js tests/ollama-provider.test.js tests/gemini-provider.test.js tests/mistral-provider.test.js tests/copilot-provider.test.js tests/groq-provider.test.js tests/openrouter-provider.test.js tests/provider-factory.test.js tests/multimodal-provider-formatting.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: `# fail 0`. If a test elsewhere asserted a cost computed from the deleted tables, it now receives the catalog price or `null`; fix the assertion to the catalog value and name the test in the commit body.

- [ ] **Step 11: Commit**

```bash
git add -A src/providers src/tracking tests/models-provider-pricing.test.js tests/usage-tracker.test.js tests/gemini-provider.test.js tests/mistral-provider.test.js tests/ollama-provider.test.js
git commit -m "feat(models): providers price calls through the catalog; drop both price tables"
```

---

## Task 5: One request helper with the abort signal; partial usage on abort; all 14 providers against a fake server

**Files:**
- Modify: `src/providers/base-provider.js` (add `abortError`, `request`, `guardStream`; `listModels(options)` signature)
- Modify: every provider's API calls and streaming methods: `anthropic-provider.js`, `openai-provider.js`, `gemini-provider.js`, `cohere-provider.js`, `copilot-provider.js`, `deepseek-provider.js`, `fireworks-provider.js`, `groq-provider.js`, `mistral-provider.js`, `ollama-provider.js`, `openrouter-provider.js`, `qwen-provider.js`, `together-provider.js`, `xai-provider.js` (all in `src/providers/`)
- Create: `tests/helpers/fake-llm-server.js`, `scripts/lib/provider-checks.js`, `scripts/smoke-providers.js`
- Modify: `package.json` (`smoke:providers` script)
- Test: `tests/providers-request-helper.test.js`, `tests/providers-fake-server.test.js` (both new)

**Interfaces:**
- Consumes: provider construction options, `buildLlmCallMetrics({ model, usage, partial })` (Task 4); `fixtureCatalog()` (Task 1); `KL_PROVIDERS` (Task 1).
- Produces:
  - `provider.request(url, init = {}, options = {}) → Promise<Response>`: calls `globalThis.fetch(url, { ...init, signal: options.abortSignal })` (no `signal` key when there is none). If the fetch rejects after `options.abortSignal` aborted, it rethrows an `AbortError` carrying `err.partialLlmMetrics` (nothing reported, `costUsd: null`, `usagePartial: true`, model `options.model`).
  - `provider.guardStream(options, snapshot, read) → Promise`: runs `read()`; if it rejects while `options.abortSignal` is aborted (or with an `AbortError`), rethrows an `AbortError` with `err.partialLlmMetrics = buildLlmCallMetrics({ ...snapshot(), partial: true })`.
  - `provider.abortError(err, signal) → Error` named `AbortError` (a string abort reason becomes its message, the original is `cause`).
  - Every provider method that calls its API does so through `this.request(...)` with the call's `options`; `listModels(options = {})` on all 14 (and Ollama's `discoverModels(options = {})`) accept `{ abortSignal }`; every streaming method (`streamMessage`, Anthropic `streamMessageWithTools`, OpenAI `_streamResponses`) reads through `this.guardStream`.
  - `tests/helpers/fake-llm-server.js`: `startFakeLlmServer() → Promise<{ url, requests, setHold(on), failNext(status, message?), closedCount(), waitForClosedStream(count, timeoutMs?), close() }>`. Paths: first segment names the provider (`/openai/...`, `/anthropic/...`, `/gemini/...`, `/cohere/...`, `/copilot/...`, `/ollama/...`, any other segment gets the OpenAI dialect). Streams send `Hello`, then ` there` (hold mode stops after `Hello` and keeps the stream open). Anthropic's `message_start` reports `input_tokens: 1200, output_tokens: 1`. Tool calls return `Lookup` with `{ q: 'weather' }`. Ollama's `/api/tags` lists `test-model` and `vision-model`; `/api/show` reports `test-model` with context 8192 and tools, `vision-model` with vision.
  - `scripts/lib/provider-checks.js`: `LOOKUP_TOOL`, `checkStreaming(provider, { model, abortSignal? }) → { text, llmMetrics }`, `checkToolCall(provider, { model }) → tool response`, `runProviderChecks(provider, { model }) → { ok, text, toolName, parameters, costUsd, errors }`.
  - `scripts/smoke-providers.js`: `selectTargets(env) → [{ provider, key, model|null, options }]`, `KEY_ENV`; `npm run smoke:providers`.

- [ ] **Step 1: Write the fake server**

Create `tests/helpers/fake-llm-server.js`:

```js
// tests/helpers/fake-llm-server.js
// One local HTTP server that answers in every provider dialect King Louie
// ships: OpenAI-compatible chat completions, Anthropic messages, Gemini
// generateContent, Cohere v2 chat, Copilot's token exchange, and Ollama's
// native /api/tags and /api/show. The first path segment names the provider:
// a provider built with baseUrl `${url}/groq/openai/v1` gets the OpenAI
// dialect. Listens on 127.0.0.1 only.
//
// Hold mode: a stream stops after its first text chunk and stays open until
// the client goes away — how the Stop tests catch an abort mid-stream.
const http = require('http');

const TOOL_ARGS = Object.freeze({ q: 'weather' });
const OLLAMA_MODELS = Object.freeze({
  'test-model': { model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] },
  'vision-model': { model_info: {}, capabilities: ['completion', 'vision'] }
});

async function startFakeLlmServer() {
  const state = { requests: [], hold: false, closed: 0, waiters: [], open: new Set(), failNext: null };

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // A stream the client drops before it ends counts as an aborted stream.
  const startSse = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    state.open.add(res);
    res.on('close', () => {
      state.open.delete(res);
      if (!res.writableEnded) {
        state.closed += 1;
        for (const waiter of state.waiters.splice(0)) waiter();
      }
    });
  };
  const data = (res, payload) => res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  const hasTools = (body) => Array.isArray(body.tools) && body.tools.length > 0;

  const openaiChat = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { model, choices: [{ delta: { content: 'Hello' } }] });
      if (state.hold) return;
      data(res, { model, choices: [{ delta: { content: ' there' } }] });
      data(res, { model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
      data(res, '[DONE]');
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, {
        model,
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Lookup', arguments: JSON.stringify(TOOL_ARGS) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      });
      return;
    }
    sendJson(res, 200, { model, choices: [{ message: { role: 'assistant', content: 'Hello there' } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
  };

  const anthropicMessages = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { type: 'message_start', message: { model, usage: { input_tokens: 1200, output_tokens: 1 } } });
      if (hasTools(body) && !state.hold) {
        data(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Lookup' } });
        data(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } });
        data(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"weather"}' } });
        data(res, { type: 'content_block_stop', index: 0 });
        data(res, { type: 'message_delta', usage: { output_tokens: 5 } });
        data(res, { type: 'message_stop' });
        res.end();
        return;
      }
      data(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      data(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
      if (state.hold) return;
      data(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } });
      data(res, { type: 'content_block_stop', index: 0 });
      data(res, { type: 'message_delta', usage: { output_tokens: 2 } });
      data(res, { type: 'message_stop' });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, { model, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Lookup', input: TOOL_ARGS }], usage: { input_tokens: 20, output_tokens: 5 } });
      return;
    }
    sendJson(res, 200, { model, content: [{ type: 'text', text: 'Hello there' }], usage: { input_tokens: 12, output_tokens: 2 } });
  };

  const gemini = (res, body, tail) => {
    const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 };
    if (tail.includes(':streamGenerateContent')) {
      startSse(res);
      data(res, { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] });
      if (state.hold) return;
      data(res, { candidates: [{ content: { parts: [{ text: ' there' }] } }], usageMetadata });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, { candidates: [{ content: { parts: [{ functionCall: { name: 'Lookup', args: TOOL_ARGS } }] } }], usageMetadata });
      return;
    }
    sendJson(res, 200, { candidates: [{ content: { parts: [{ text: 'Hello there' }] } }], usageMetadata });
  };

  const cohere = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { type: 'content-delta', delta: { message: { content: { text: 'Hello' } } } });
      if (state.hold) return;
      data(res, { type: 'content-delta', delta: { message: { content: { text: ' there' } } } });
      data(res, { type: 'message-end', delta: { usage: { billed_units: { input_tokens: 12, output_tokens: 2 } } } });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, {
        model,
        message: { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Lookup', arguments: JSON.stringify(TOOL_ARGS) } }] },
        usage: { billed_units: { input_tokens: 20, output_tokens: 5 } }
      });
      return;
    }
    sendJson(res, 200, { model, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] } });
  };

  const modelsList = (res, provider) => {
    if (provider === 'gemini') return sendJson(res, 200, { models: [{ name: 'models/test-model', supportedGenerationMethods: ['generateContent'] }] });
    if (provider === 'cohere') return sendJson(res, 200, { models: [{ name: 'test-model' }] });
    return sendJson(res, 200, { data: [{ id: 'test-model' }] });
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const [provider = '', ...rest] = url.pathname.split('/').filter(Boolean);
      const tail = `/${rest.join('/')}`;
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      state.requests.push({ provider, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (state.failNext) {
        const { status, message } = state.failNext;
        state.failNext = null;
        sendJson(res, status, { error: { message } });
        return;
      }
      if (tail.endsWith('/copilot_internal/v2/token')) {
        sendJson(res, 200, { token: 'copilot-session', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        return;
      }
      if (provider === 'ollama' && tail === '/api/tags') {
        sendJson(res, 200, { models: Object.keys(OLLAMA_MODELS).map((name) => ({ name })) });
        return;
      }
      if (provider === 'ollama' && tail === '/api/show') {
        const info = OLLAMA_MODELS[body.model];
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: 'model not found' });
        return;
      }
      if (req.method === 'GET' && tail.endsWith('/models')) { modelsList(res, provider); return; }
      if (provider === 'anthropic' && tail.endsWith('/messages')) { anthropicMessages(res, body); return; }
      if (provider === 'gemini' && tail.includes(':')) { gemini(res, body, tail); return; }
      if (provider === 'cohere' && tail.endsWith('/chat')) { cohere(res, body); return; }
      if (tail.endsWith('/chat/completions')) { openaiChat(res, body); return; }
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    setHold: (on) => { state.hold = Boolean(on); },
    failNext: (status, message = 'rejected by the fake server') => { state.failNext = { status, message }; },
    closedCount: () => state.closed,
    waitForClosedStream: (count, timeoutMs = 3000) => new Promise((resolve, reject) => {
      if (state.closed >= count) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error(`no aborted stream within ${timeoutMs} ms (closed ${state.closed}, wanted ${count})`)), timeoutMs);
      const check = () => {
        if (state.closed >= count) {
          clearTimeout(timer);
          resolve();
        } else {
          state.waiters.push(check);
        }
      };
      state.waiters.push(check);
    }),
    close: () => new Promise((resolve) => {
      for (const res of state.open) res.destroy();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startFakeLlmServer };
```

- [ ] **Step 2: Write the shared provider checks and the smoke script**

Create `scripts/lib/provider-checks.js`:

```js
// scripts/lib/provider-checks.js
// The provider checks shared by the fake-server test
// (tests/providers-fake-server.test.js) and the opt-in live check
// (npm run smoke:providers): stream a short reply, and make one tool call.
const LOOKUP_TOOL = Object.freeze({
  name: 'Lookup',
  description: 'Look up a fact. Call it with q set to the word weather.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
});

async function checkStreaming(provider, { model, abortSignal = null } = {}) {
  let text = '';
  const result = await provider.streamMessage(
    [{ role: 'user', content: 'Reply with exactly: Hello there' }],
    { model, max_tokens: 50, ...(abortSignal ? { abortSignal } : {}) },
    (chunk) => { text += chunk; }
  );
  return { text, llmMetrics: result?.llmMetrics || null };
}

async function checkToolCall(provider, { model } = {}) {
  return provider.sendMessageWithTools(
    [{ role: 'user', content: 'Call the Lookup tool with q set to weather. Do not answer in text.' }],
    [LOOKUP_TOOL],
    { model, max_tokens: 200 }
  );
}

// Both checks, never throwing: ok when text streamed and the tool was called.
async function runProviderChecks(provider, { model } = {}) {
  const out = { ok: false, text: '', toolName: null, parameters: null, costUsd: null, errors: [] };
  try {
    const streamed = await checkStreaming(provider, { model });
    out.text = streamed.text;
    out.costUsd = streamed.llmMetrics?.costUsd ?? null;
    if (!streamed.text.trim()) out.errors.push('stream: no text');
  } catch (err) {
    out.errors.push(`stream: ${err.message}`);
  }
  try {
    const response = await checkToolCall(provider, { model });
    out.toolName = response?.type === 'tool_use' ? response.toolName : null;
    out.parameters = response?.type === 'tool_use' ? response.parameters : null;
    if (out.toolName !== LOOKUP_TOOL.name) out.errors.push(`tool: expected a ${LOOKUP_TOOL.name} call, got ${response?.type || 'nothing'}`);
  } catch (err) {
    out.errors.push(`tool: ${err.message}`);
  }
  out.ok = out.errors.length === 0;
  return out;
}

module.exports = { LOOKUP_TOOL, checkStreaming, checkToolCall, runProviderChecks };
```

Create `scripts/smoke-providers.js`:

```js
#!/usr/bin/env node
// scripts/smoke-providers.js
// Opt-in live check (spec 2026-09-27 §16): for every provider whose key is in
// the environment, stream a short reply and make one tool call against the
// real API. It spends a little real money and is not part of npm test.
//   OPENAI_API_KEY=... npm run smoke:providers
// KL_SMOKE_MODEL_<PROVIDER> picks a provider's model (default: its default
// model). Ollama runs when KL_SMOKE_OLLAMA_URL and KL_SMOKE_MODEL_OLLAMA are set.
const ProviderFactory = require('../src/providers/provider-factory');
const { KL_PROVIDERS } = require('../src/models/provider-ids');
const { runProviderChecks } = require('./lib/provider-checks');

const KEY_ENV = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  copilot: ['GITHUB_TOKEN']
});

// Which providers to check, from the environment. Pure, for the tests.
function selectTargets(env = process.env) {
  const targets = [];
  for (const provider of KL_PROVIDERS) {
    const model = env[`KL_SMOKE_MODEL_${provider.toUpperCase()}`] || null;
    if (provider === 'ollama') {
      if (env.KL_SMOKE_OLLAMA_URL && model) targets.push({ provider, key: '', model, options: { serverUrl: env.KL_SMOKE_OLLAMA_URL } });
      continue;
    }
    const name = (KEY_ENV[provider] || []).find((n) => env[n]);
    if (name) targets.push({ provider, key: env[name], model, options: {} });
  }
  return targets;
}

async function main() {
  const targets = selectTargets();
  if (targets.length === 0) {
    process.stdout.write('No provider keys in the environment; nothing to check.\n');
    return;
  }
  let failed = 0;
  for (const target of targets) {
    const provider = ProviderFactory.create(target.provider, target.key, target.options);
    const model = target.model || provider.getDefaultModel();
    const result = await runProviderChecks(provider, { model });
    if (!result.ok) failed += 1;
    const cost = result.costUsd === null ? 'unpriced' : `$${result.costUsd}`;
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${target.provider} ${model} (${cost})${result.ok ? '' : `: ${result.errors.join('; ')}`}\n`);
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`smoke:providers failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { selectTargets, KEY_ENV };
```

In `package.json` `"scripts"`, after `"models:snapshot"`, add:

```json
    "smoke:providers": "node scripts/smoke-providers.js",
```

- [ ] **Step 3: Write the failing tests**

Create `tests/providers-request-helper.test.js`:

```js
// tests/providers-request-helper.test.js
// One request helper (spec 2026-09-27 §9): every provider fetch carries the
// abort signal, and an aborted call reports the usage it had so far.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const GroqProvider = require('../src/providers/groq-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const { fixtureCatalog } = require('./helpers/models-fixture');

const PROVIDERS_DIR = path.join(__dirname, '..', 'src', 'providers');
const providerFiles = () => fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('-provider.js') && f !== 'base-provider.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('BaseLLMProvider.request', () => {
  it('attaches options.abortSignal, and adds no signal without one', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => { seen.push(init); return new Response('{}'); };
    const p = new GroqProvider('test-key-123456');
    const controller = new AbortController();
    await p.request('http://127.0.0.1:9/x', { method: 'GET' }, { abortSignal: controller.signal });
    await p.request('http://127.0.0.1:9/x', { method: 'GET' }, {});
    assert.strictEqual(seen[0].signal, controller.signal);
    assert.strictEqual(seen[0].method, 'GET');
    assert.strictEqual('signal' in seen[1], false);
  });

  it('turns an abort before the response into an AbortError with an empty partial record', async () => {
    globalThis.fetch = async (_url, init) => { throw init.signal.reason; };
    const p = new GroqProvider('test-key-123456', { catalog: fixtureCatalog() });
    const controller = new AbortController();
    controller.abort('stopped by owner');
    await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: controller.signal, model: 'llama-3.3-70b' }), (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.match(err.message, /stopped by owner/);
      assert.strictEqual(err.partialLlmMetrics.usagePartial, true);
      assert.strictEqual(err.partialLlmMetrics.costUsd, null);
      assert.strictEqual(err.partialLlmMetrics.model, 'llama-3.3-70b');
      return true;
    });
  });

  it('leaves a failure that is not an abort untouched', async () => {
    const boom = new Error('fetch failed');
    globalThis.fetch = async () => { throw boom; };
    const p = new GroqProvider('test-key-123456');
    await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: new AbortController().signal }), (err) => err === boom);
  });
});

describe('BaseLLMProvider.guardStream', () => {
  it('attaches the usage reported before the abort, priced', async () => {
    const p = new AnthropicProvider('sk-ant-test-123456', { catalog: fixtureCatalog() });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      p.guardStream({ abortSignal: controller.signal }, () => ({ model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 1 } }), async () => { throw new DOMException('aborted', 'AbortError'); }),
      (err) => err.name === 'AbortError' && err.partialLlmMetrics.inputTokens === 1200 && err.partialLlmMetrics.costUsd === 0.001205 && err.partialLlmMetrics.usagePartial === true
    );
  });

  it('passes a read result and a non-abort failure through', async () => {
    const p = new GroqProvider('test-key-123456');
    assert.strictEqual(await p.guardStream({}, () => ({}), async () => 'done'), 'done');
    const boom = new Error('bad chunk');
    await assert.rejects(p.guardStream({}, () => ({}), async () => { throw boom; }), (err) => err === boom && !err.partialLlmMetrics);
  });
});

describe('every provider goes through the helper', () => {
  it('no provider calls fetch directly', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      assert.doesNotMatch(src, /(^|[^.\w])fetch\(/m, `${file} calls fetch directly; use this.request(url, init, options)`);
    }
  });

  it('every streaming method reads through guardStream', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      const streams = (src.match(/async (streamMessage|streamMessageWithTools|_streamResponses)\(/g) || []).length;
      const guarded = (src.match(/this\.guardStream\(/g) || []).length;
      assert.ok(streams > 0, `${file} has a streaming method`);
      assert.strictEqual(guarded, streams, `${file}: ${streams} streaming methods, ${guarded} guarded`);
    }
  });

  it('every listModels takes options', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      assert.match(src, /async listModels\(options = \{\}\)/, file);
    }
  });
});
```

Create `tests/providers-fake-server.test.js`:

```js
// tests/providers-fake-server.test.js
// All 14 providers stream text and make one tool call against a local fake
// server (spec 2026-09-27 §16, "providers") — what lets the send path drop
// its three-provider restriction — and every provider's stream stops at the
// provider when aborted, reporting the usage it had so far (§9).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { checkStreaming, checkToolCall, LOOKUP_TOOL } = require('../scripts/lib/provider-checks');
const { selectTargets } = require('../scripts/smoke-providers');

const BASES = {
  openai: '/openai/v1',
  anthropic: '/anthropic/v1',
  gemini: '/gemini/v1beta',
  groq: '/groq/openai/v1',
  mistral: '/mistral/v1',
  ollama: '/ollama/v1',
  openrouter: '/openrouter/api/v1',
  xai: '/xai/v1',
  deepseek: '/deepseek/v1',
  qwen: '/qwen/compatible-mode/v1',
  together: '/together/v1',
  fireworks: '/fireworks/inference/v1',
  cohere: '/cohere/v2',
  copilot: '/copilot'
};

describe('providers against a local fake server', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  const make = (key) => ProviderFactory.create(key, 'test-key-123456', {
    catalog,
    baseUrl: `${server.url}${BASES[key]}`,
    ...(key === 'copilot' ? { tokenExchangeUrl: `${server.url}/copilot/copilot_internal/v2/token` } : {})
  });
  const lastPost = (key) => [...server.requests].reverse().find((r) => r.provider === key && r.method === 'POST');
  const abortOnFirstChunk = async (provider, model) => {
    const controller = new AbortController();
    return provider
      .streamMessage([{ role: 'user', content: 'hi' }], { model, abortSignal: controller.signal }, () => controller.abort())
      .then(() => null, (err) => err);
  };

  it('covers every registered provider', () => {
    assert.deepStrictEqual(Object.keys(BASES).sort(), ProviderFactory.listRegistered().sort());
  });

  for (const key of Object.keys(BASES)) {
    describe(key, () => {
      it('streams a reply', async () => {
        server.setHold(false);
        const r = await checkStreaming(make(key), { model: 'test-model' });
        assert.strictEqual(r.text, 'Hello there');
        assert.strictEqual(r.llmMetrics.provider, key);
        const req = lastPost(key);
        assert.ok(req.body.model === 'test-model' || req.path.includes('test-model'), `${key} asked for the model`);
      });

      it('makes one tool call', async () => {
        server.setHold(false);
        const r = await checkToolCall(make(key), { model: 'test-model' });
        assert.strictEqual(r.type, 'tool_use');
        assert.strictEqual(r.toolName, LOOKUP_TOOL.name);
        assert.deepStrictEqual(r.parameters, { q: 'weather' });
        assert.strictEqual(r.llmMetrics.provider, key);
      });

      it('lists the account\'s models', async () => {
        assert.ok((await make(key).listModels()).includes('test-model'));
      });

      it('stops the request at the provider when aborted mid-stream, with partial usage', async () => {
        server.setHold(true);
        try {
          const before = server.closedCount();
          const err = await abortOnFirstChunk(make(key), 'test-model');
          assert.ok(err, 'the stream rejects');
          assert.strictEqual(err.name, 'AbortError');
          assert.strictEqual(err.partialLlmMetrics.usagePartial, true);
          assert.strictEqual(err.partialLlmMetrics.provider, key);
          await server.waitForClosedStream(before + 1);
        } finally {
          server.setHold(false);
        }
      });
    });
  }

  it('Anthropic keeps the input tokens message_start reported, priced, when aborted', async () => {
    server.setHold(true);
    try {
      const err = await abortOnFirstChunk(make('anthropic'), 'claude-haiku-4-5');
      assert.strictEqual(err.partialLlmMetrics.inputTokens, 1200);
      assert.strictEqual(err.partialLlmMetrics.costUsd, 0.001205);
    } finally {
      server.setHold(false);
    }
  });

  it('a stream that reported no usage before the abort has no cost, not $0', async () => {
    server.setHold(true);
    try {
      const err = await abortOnFirstChunk(make('openai'), 'gpt-5.5');
      assert.strictEqual(err.partialLlmMetrics.inputTokens, 0);
      assert.strictEqual(err.partialLlmMetrics.costUsd, null);
    } finally {
      server.setHold(false);
    }
  });

  it('Anthropic streams a tool call through streamMessageWithTools', async () => {
    server.setHold(false);
    const r = await make('anthropic').streamMessageWithTools([{ role: 'user', content: 'weather?' }], [LOOKUP_TOOL], { model: 'claude-haiku-4-5' }, () => {});
    assert.strictEqual(r.type, 'tool_use');
    assert.deepStrictEqual(r.parameters, { q: 'weather' });
    assert.strictEqual(r.llmMetrics.inputTokens, 1200);
  });

  it('an abort before the request is sent rejects at once with an empty partial record', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await make('groq')
      .streamMessage([{ role: 'user', content: 'hi' }], { model: 'test-model', abortSignal: controller.signal }, () => {})
      .then(() => null, (e) => e);
    assert.strictEqual(err.name, 'AbortError');
    assert.strictEqual(err.partialLlmMetrics.costUsd, null);
  });
});

describe('smoke:providers target selection', () => {
  it('checks providers whose key is in the environment, with an optional model', () => {
    assert.deepStrictEqual(selectTargets({ OPENAI_API_KEY: 'sk-x', KL_SMOKE_MODEL_OPENAI: 'gpt-5.5', CO_API_KEY: 'co-x' }), [
      { provider: 'openai', key: 'sk-x', model: 'gpt-5.5', options: {} },
      { provider: 'cohere', key: 'co-x', model: null, options: {} }
    ]);
  });

  it('checks Ollama only with an address and a model', () => {
    assert.deepStrictEqual(selectTargets({ KL_SMOKE_OLLAMA_URL: 'http://127.0.0.1:11434' }), []);
    assert.deepStrictEqual(selectTargets({ KL_SMOKE_OLLAMA_URL: 'http://127.0.0.1:11434', KL_SMOKE_MODEL_OLLAMA: 'qwen3:8b' }), [
      { provider: 'ollama', key: '', model: 'qwen3:8b', options: { serverUrl: 'http://127.0.0.1:11434' } }
    ]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/providers-request-helper.test.js tests/providers-fake-server.test.js`
Expected: FAIL (`p.request is not a function`; providers call `fetch` directly; aborted streams reject without `partialLlmMetrics`).

- [ ] **Step 5: Add the helpers to `src/providers/base-provider.js`**

Insert after `getCatalog()`:

```js
  /**
   * An abort as an Error named AbortError. A signal aborted with a string
   * reason (the case runtime does this) rejects fetch with that bare string.
   */
  abortError(err, signal) {
    if (err && typeof err === 'object' && err.name === 'AbortError') return err;
    const reason = signal?.reason;
    const e = new Error(typeof reason === 'string' && reason ? `Request aborted: ${reason}` : 'The operation was aborted.');
    e.name = 'AbortError';
    if (err !== undefined) e.cause = err;
    return e;
  }

  /**
   * The one way a provider calls its API (spec 2026-09-27 §9). The call's
   * options.abortSignal goes on every fetch, streaming or not, so Stop cancels
   * the request at the provider instead of letting it run on and bill. An
   * abort before the response arrives carries a partial record with nothing
   * reported. fetch is looked up per call so tests can stub it.
   */
  async request(url, init = {}, options = {}) {
    const signal = options?.abortSignal || null;
    try {
      return await globalThis.fetch(url, signal ? { ...init, signal } : init);
    } catch (err) {
      if (signal?.aborted) {
        const aborted = this.abortError(err, signal);
        if (!aborted.partialLlmMetrics) {
          aborted.partialLlmMetrics = this.buildLlmCallMetrics({ model: options.model, usage: {}, partial: true });
        }
        throw aborted;
      }
      throw err;
    }
  }

  /**
   * Run a stream's read loop. Aborted mid-stream, rethrow as an AbortError
   * carrying the usage the provider had reported so far (snapshot() returns
   * { model, usage }), marked usagePartial (spec §9).
   */
  async guardStream(options, snapshot, read) {
    try {
      return await read();
    } catch (err) {
      const signal = options?.abortSignal || null;
      if (signal?.aborted || err?.name === 'AbortError') {
        const aborted = this.abortError(err, signal);
        const { model, usage } = (typeof snapshot === 'function' && snapshot()) || {};
        aborted.partialLlmMetrics = this.buildLlmCallMetrics({ model, usage: usage || {}, partial: true });
        throw aborted;
      }
      throw err;
    }
  }
```

And change the base `listModels` to:

```js
  async listModels(_options = {}) {
    throw new Error('listModels must be implemented by provider');
  }
```

- [ ] **Step 6: Route every provider call through `request`, and guard every stream**

Apply the same three moves in every provider file.

**Move 1 — requests.** Every `await fetch(URL, INIT)` becomes `await this.request(URL, INIT, options)`, where `options` is the enclosing method's options parameter. In detail:

| File | Methods and the call to change |
|---|---|
| `anthropic-provider.js` | `sendMessage`, `sendMessageWithTools`, `streamMessageWithTools`, `streamMessage`: `fetch(`${this.baseUrl}/messages`, {...})` → `this.request(`${this.baseUrl}/messages`, {...}, options)`. `listModels()` → `listModels(options = {})` with `this.request(`${this.baseUrl}/models`, {...}, options)` |
| `openai-provider.js` | `sendMessage`, `_sendCompletions`, `sendMessageWithTools`, `_sendCompletionsWithTools`, `_sendResponses`, `_sendResponsesWithTools`, `streamMessage`, `_streamResponses`: each `fetch(...)` → `this.request(..., options)`. `listModels(options = {})` likewise |
| `gemini-provider.js` | `sendMessage`, `sendMessageWithTools`, `streamMessage`: `fetch(this.getApiUrl(...), {...})` → `this.request(this.getApiUrl(...), {...}, options)`; `listModels(options = {})` |
| `cohere-provider.js`, `deepseek-provider.js`, `fireworks-provider.js`, `groq-provider.js`, `mistral-provider.js`, `openrouter-provider.js`, `qwen-provider.js`, `together-provider.js`, `xai-provider.js` | `sendMessage`, `sendMessageWithTools`, `streamMessage` → `this.request(..., options)`; `listModels(options = {})` with `this.request(..., options)` |
| `ollama-provider.js` | as the row above, plus `discoverModels()` → `discoverModels(options = {})` with `this.request(`${baseUrl}/api/tags`, {}, options)` |
| `copilot-provider.js` | `getCopilotToken()` → `getCopilotToken(options = {})` with `this.request(this.tokenExchangeUrl, { headers: {...} }, options)`; `getRequestHeaders()` → `getRequestHeaders(options = {})` calling `this.getCopilotToken(options)`; in `sendMessage`, `sendMessageWithTools`, `streamMessage` and `listModels(options = {})`: `headers: await this.getRequestHeaders(options)` and `this.request(..., options)` |

**Move 2 — declarations.** In each streaming method, move the declarations the snapshot reads (`let usage`, `let model` or `const usage`, and `buildResult` where it exists) up to directly after the `if (!response.ok) ...` check, before `const reader = ...`.

**Move 3 — the guard.** Wrap everything from `const reader = response.body.getReader();` to the method's final `return ...;` in `return this.guardStream(options, SNAPSHOT, async () => { ... });`. The snapshot per method:

| File | Method | SNAPSHOT |
|---|---|---|
| `anthropic-provider.js` | `streamMessageWithTools`, `streamMessage` | `() => ({ model, usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } })` |
| `openai-provider.js` | `streamMessage` (the chat/completions path after the Responses early return), `_streamResponses` | `() => ({ model, usage })` |
| `gemini-provider.js` | `streamMessage` | `() => ({ model: requestedModel, usage })` |
| every other provider | `streamMessage` | `() => ({ model, usage })` |

The worked example — `GroqProvider.streamMessage` after all three moves (Mistral, Ollama and OpenRouter have the same text; xAI, DeepSeek, Qwen, Together, Fireworks, Copilot and Cohere have the same structure written more compactly):

```js
  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: {
          include_usage: true
        }
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    let usage = null;
    let model = requestedModel;
    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model, usage })
    });

    return this.guardStream(options, () => ({ model, usage }), async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return buildResult();

          try {
            const parsed = JSON.parse(data);
            if (parsed?.usage) {
              usage = parsed.usage;
            }

            if (parsed?.model) {
              model = parsed.model;
            }

            const content = parsed.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
          } catch {
            // Ignore malformed partial chunks
          }
        }
      }

      return buildResult();
    });
  }
```

And `GroqProvider.listModels` after Move 1:

```js
  async listModels(options = {}) {
    const response = await this.request(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.getHeaders()
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    return (data.data || []).map((model) => model.id).sort();
  }
```

In Anthropic's `streamMessageWithTools`, the `contentBlocks`, `currentBlockIndex`, `currentBlockType` and `inputJsonBuffer` declarations move inside the guarded callback with the reader; only `model` and `usage` stay outside. Its two `return this.parseToolResponse(...)` statements stay inside the callback unchanged.

`grep -rn "await fetch(\|= fetch(" src/providers/` must print nothing when this step is done.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/providers-request-helper.test.js tests/providers-fake-server.test.js`
Expected: PASS, `# fail 0`, in a few seconds.

Run the existing provider tests, which stub `global.fetch`:
`node --test tests/copilot-provider.test.js tests/gemini-provider.test.js tests/groq-provider.test.js tests/mistral-provider.test.js tests/ollama-provider.test.js tests/openrouter-provider.test.js tests/multimodal-provider-formatting.test.js tests/ollama-settings.test.js tests/inference-router.test.js`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/providers scripts/lib/provider-checks.js scripts/smoke-providers.js package.json tests/helpers/fake-llm-server.js tests/providers-request-helper.test.js tests/providers-fake-server.test.js
git commit -m "feat(providers): one request helper carries the abort signal; partial usage on abort; all 14 providers against a fake server"
```

---

## Task 6: Availability — the one connection test, the usability rules, and Ollama discovery

**Files:**
- Create: `src/models/ollama.js`, `src/models/availability.js`
- Modify: `src/models/index.js` (exports)
- Test: `tests/models-availability.test.js`, `tests/models-ollama.test.js` (both new)

**Interfaces:**
- Consumes: `Catalog#get`, `#list`, `#setLocalModels` (Task 1); `localEntry`, `stripDateSuffix` (Task 1); `KL_PROVIDERS`, `DEFAULT_OLLAMA_BASE_URL`, `normalizeProvider` (Task 1); `provider.listModels({ abortSignal })` (Task 5); `startFakeLlmServer()` (Task 5).
- Produces:
  - `discoverOllama({ baseUrl, fetch?, signal? }) → Promise<[{ id, context: number|null, toolCall: boolean|null, imageInput: boolean }]>`; throws `Ollama at <url> did not answer: …` when the server is down.
  - `class Availability extends EventEmitter`, constructed with `{ catalog, hasCredential(provider) → boolean, createProvider(provider) → Promise<provider>, getStatuses() → object, setStatuses(object), getSettings?, fetch?, now?, labels?, testTimeoutMs? }`:
    - `status(provider) → ProviderStatus|null`, `statusAll() → { [provider]: ProviderStatus|null }`
    - `test(provider) → Promise<ProviderStatus>` (the one connection test; concurrent calls share one run), `testAll() → Promise<{ [provider]: ProviderStatus }>` (credentialed providers, Ollama included), `ensureTested(provider) → Promise<ProviderStatus>` (tests only when no status exists), `retestStale() → Promise<string[]>` (providers retested), `forget(provider)`, `markAuthFailure(provider, error) → ProviderStatus`
    - `explain(provider, modelId, { needs }) → { usable, reasons: string[], notes: string[], entry: Entry|null }`
    - `usable({ needs }) → Candidate[]`, `Candidate = { provider, model, name, known, priced, cost, context, toolCall, imageInput, local }`
    - `needs = { toolCall?, imageInput?, textOutput?, minContext? }`
    - event `'changed'` with `{ provider, status }` (status `null` after `forget`).
  - `ProviderStatus = { ok, error, message, checkedAt, models: string[], authFailed?, httpStatus? }`. With no credential, `test` stores `{ ok: false, error: 'No token saved for this provider.', … }`.
  - `src/models/index.js` also exports `Availability` and `discoverOllama`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-availability.test.js`:

```js
// tests/models-availability.test.js
// Availability (spec 2026-09-27 §5): the four usability rules, listModels as
// the one connection test, auth failures, retest scheduling.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Availability } = require('../src/models/availability');
const { fixtureCatalog } = require('./helpers/models-fixture');

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
```

Create `tests/models-ollama.test.js`:

```js
// tests/models-ollama.test.js
// Ollama discovery (spec 2026-09-27 §5.4) against a local fake server: the
// address from models.ollama.baseUrl, /api/tags for installed models,
// /api/show for context length and capabilities.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { discoverOllama } = require('../src/models/ollama');
const { Availability } = require('../src/models/availability');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');

describe('Ollama discovery', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('reads installed models, their context length and capabilities', async () => {
    assert.deepStrictEqual(await discoverOllama({ baseUrl: `${server.url}/ollama/` }), [
      { id: 'test-model', context: 8192, toolCall: true, imageInput: false },
      { id: 'vision-model', context: null, toolCall: false, imageInput: true }
    ]);
  });

  it('says the server did not answer when nothing listens', async () => {
    await assert.rejects(discoverOllama({ baseUrl: 'http://127.0.0.1:9' }), /Ollama at http:\/\/127\.0\.0\.1:9 did not answer/);
  });

  it('tests Ollama at the configured address and adds its models to the catalog as local', async () => {
    let store = {};
    const catalog = fixtureCatalog();
    const availability = new Availability({
      catalog,
      hasCredential: () => true,
      createProvider: async () => { throw new Error('Ollama is tested through discovery, not a provider'); },
      getStatuses: () => store,
      setStatuses: (s) => { store = s; },
      getSettings: () => ({ models: { ollama: { baseUrl: `${server.url}/ollama` } } })
    });
    const s = await availability.test('ollama');
    assert.strictEqual(s.ok, true);
    assert.deepStrictEqual(s.models, ['test-model', 'vision-model']);
    const entry = catalog.get('ollama', 'test-model');
    assert.strictEqual(entry.local, true);
    assert.strictEqual(entry.limits.context, 8192);
    assert.strictEqual(catalog.price('ollama', 'test-model', { input: 1000, output: 100 }).usd, 0);
    assert.strictEqual(availability.explain('ollama', 'test-model', { needs: { toolCall: true } }).usable, true);
    assert.deepStrictEqual(availability.explain('ollama', 'vision-model', { needs: { toolCall: true } }).reasons, ['vision-model has no tool calling.']);
    assert.strictEqual(availability.explain('ollama', 'vision-model', { needs: { imageInput: true } }).usable, true);
  });

  it('a stopped Ollama fails its test with the reason', async () => {
    let store = {};
    const availability = new Availability({
      catalog: fixtureCatalog(),
      hasCredential: () => true,
      createProvider: async () => null,
      getStatuses: () => store,
      setStatuses: (s) => { store = s; },
      getSettings: () => ({ models: { ollama: { baseUrl: 'http://127.0.0.1:9' } } })
    });
    const s = await availability.test('ollama');
    assert.strictEqual(s.ok, false);
    assert.match(s.error, /did not answer/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-availability.test.js tests/models-ollama.test.js`
Expected: FAIL with `Cannot find module '../src/models/availability'`.

- [ ] **Step 3: Write `src/models/ollama.js`**

```js
// src/models/ollama.js
// Local Ollama discovery (spec 2026-09-27 §5.4): /api/tags lists installed
// models; /api/show gives each one's context length and capabilities (tool
// calling and image input where Ollama reports them).
const { createLogger } = require('../logging');

const log = createLogger('models/ollama');
const root = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

async function showModel(fetchImpl, base, name, signal) {
  try {
    const res = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const info = await res.json();
    const capabilities = Array.isArray(info?.capabilities) ? info.capabilities : null;
    const modelInfo = info?.model_info && typeof info.model_info === 'object' ? info.model_info : {};
    const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
    const context = contextKey && Number.isFinite(modelInfo[contextKey]) ? modelInfo[contextKey] : null;
    return {
      id: name,
      context,
      toolCall: capabilities ? capabilities.includes('tools') : null,
      imageInput: capabilities ? capabilities.includes('vision') : false
    };
  } catch (err) {
    log.warn(`Ollama /api/show for ${name} failed: ${err.message}`);
    return { id: name, context: null, toolCall: null, imageInput: false };
  }
}

async function discoverOllama({ baseUrl, fetch: fetchImpl = globalThis.fetch, signal = null } = {}) {
  const base = root(baseUrl);
  let res;
  try {
    res = await fetchImpl(`${base}/api/tags`, signal ? { signal } : {});
  } catch (err) {
    const e = new Error(`Ollama at ${base} did not answer: ${err.message}`);
    e.cause = err;
    throw e;
  }
  if (!res.ok) throw new Error(`Ollama at ${base} returned ${res.status} for /api/tags.`);
  const body = await res.json();
  const names = (Array.isArray(body?.models) ? body.models : [])
    .map((m) => m?.name || m?.model)
    .filter((n) => typeof n === 'string' && n);
  const found = [];
  for (const name of names) found.push(await showModel(fetchImpl, base, name, signal));
  return found;
}

module.exports = { discoverOllama };
```

- [ ] **Step 4: Write `src/models/availability.js`**

```js
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
      const message = err?.message || String(err);
      log.warn(`${this.label(p)} connection test failed: ${message}`);
      return this._store(p, {
        ok: false,
        error: message,
        message,
        checkedAt,
        models: [],
        ...(Number.isFinite(err?.status) ? { httpStatus: err.status } : {})
      });
    }
  }

  async testAll() {
    const targets = KL_PROVIDERS.filter((p) => this.hasCredential(p));
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
      if (!this.hasCredential(p)) return false;
      const s = this.status(p);
      if (p === 'ollama' && !s) return false;
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
    return models.some((m) => m === base || stripDateSuffix(m) === id);
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

  usable({ needs = {} } = {}) {
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
  }
}

module.exports = { Availability };
```

- [ ] **Step 5: Export from `src/models/index.js`**

Add to the requires:

```js
const { Availability } = require('./availability');
const { discoverOllama } = require('./ollama');
```

and add `Availability` and `discoverOllama` to `module.exports`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models-availability.test.js tests/models-ollama.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/models/ollama.js src/models/availability.js src/models/index.js tests/models-availability.test.js tests/models-ollama.test.js
git commit -m "feat(models): availability with the one connection test, usability rules and Ollama discovery"
```

---

## Task 7: Wire catalog and availability into the core, the settings channels and a models IPC

**Files:**
- Modify: `src/core/create-core.js` — requires (after line 67), catalog construction (after `setSettings`, line 293), provider construction and availability (after `clearProviderToken`, lines 954-959), `testProviderConnection` (lines 1437-1485), `/llm add` (line 1927), `inferenceRouter` (lines 2150-2161), `llmRouter` (lines 2509-2513), the skills `llmProvider` getter (lines 2693-2708), `context` (lines 3009-3175), the returned object (lines 3177-3197)
- Modify: `src/providers/inference-router.js:7-36` (constructor), `:176-192` (auth hook in `routeWithFallback`)
- Modify: `src/ipc/settings-handlers.js` — context destructuring (lines 8-38), `settings:load` (lines 54-95), `settings:saveProvider` (lines 329-348), `settings:testProvider` (lines 350-438), `settings:listModels` (lines 449-490), `settings:anthropicOAuthStart` and `…Disconnect` (lines 635-663)
- Create: `src/ipc/models-handlers.js`
- Modify: `src/ipc/constants.js` (models channels), `src/ipc/register.js` (register), `preload.js` (a `models` namespace after `usage`, line 918), `src/desktop-bridge/allowlist.js` (proxy the `models` domain, forward its two events)
- Modify: `main.js:80-87` (start the background checks), `src/service/run.js` (agent profile return object, lines 161-186; `runService` after `'service ready'`, line 305)
- Test: `tests/models-core.test.js`, `tests/models-ipc.test.js` (new); `tests/ollama-settings.test.js` (rewrite the `settings:testProvider` block, lines 38-75); `tests/settings-handlers.test.js` (add cases); `tests/inference-router.test.js` (add a case); `tests/desktop-bridge-allowlist.test.js:60` (the domain list)

**Interfaces:**
- Consumes: `Catalog`, `Availability`, `setActiveCatalog`, `KL_PROVIDERS` (Tasks 1, 6); `Catalog#refresh` (Task 2); provider options `catalog` and `serverUrl` (Task 4); `classifyError`, `FailoverReason` from `src/providers/error-classifier.js`.
- Produces:
  - `createCore(deps)` accepts `deps.fetch` (used for the catalog refresh and Ollama discovery; default `globalThis.fetch`) and returns `core.models = { catalog, availability, startBackgroundChecks() → Promise<{ skipped }> }`. `startBackgroundChecks` refreshes the catalog and retests stale providers, and does nothing when `process.env.KL_TEST_MODE` is set.
  - `core.context` gains: `getCatalog() → Catalog`, `getAvailability() → Availability`, `getProviderOptions(provider) → { catalog, serverUrl? }`, `testProviderConnection(provider) → Promise<{ ok, status, error? }>`, `reportProviderError(provider, error)` (marks 401/403 only), `onProviderKeyChanged(provider) → Promise<ProviderStatus|null>` (tests, or forgets the status when no credential is left).
  - `InferenceRouter` option `onProviderError(provider, error)`, called when a failure classifies as `auth` or `auth_permanent`.
  - `settings:testProvider` returns `testProviderConnection(provider)`; `settings:saveProvider` retests the provider in the background; `settings:load` includes `ollamaBaseUrl`.
  - IPC channels (constants in `src/ipc/constants.js`): `models:status` → `{ ok, catalog: status, providers: { [p]: ProviderStatus|null } }`; `models:refreshCatalog` → `{ ok, catalog }`; `models:testAll` → `{ ok, providers }`; `models:usable { needs }` → `{ ok, models: Candidate[] }`; `models:explain { provider, model, needs }` → `{ ok, usable, reasons, notes }`; `models:setOllamaBaseUrl { baseUrl }` → `{ ok, baseUrl, status }`.
  - Renderer events: `models:statusChanged` `{ provider, status }` and `models:catalogUpdated` (catalog status).
  - `window.electron.models.{ status, refreshCatalog, testAll, usable, explain, setOllamaBaseUrl, onStatusChanged, onCatalogUpdated }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-core.test.js`:

```js
// tests/models-core.test.js
// The core builds one catalog and one Availability (spec 2026-09-27 §3):
// providers price with it, the one connection test stores the account's
// models, 401s mark a provider unusable, and the background checks start
// only when the host asks and never in test mode.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { getActiveCatalog, setActiveCatalog, CATALOG_DEFAULTS } = require('../src/models');

const tempDirs = [];
const originalFetch = globalThis.fetch;
const originalTestMode = process.env.KL_TEST_MODE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTestMode === undefined) delete process.env.KL_TEST_MODE;
  else process.env.KL_TEST_MODE = originalTestMode;
  setActiveCatalog(null);
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeCore(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-models-core-'));
  tempDirs.push(dataDir);
  const sent = [];
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  const core = createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: (ch, p) => sent.push({ ch, p }) },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
    ...extra
  });
  return { core, store, sent, dataDir };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubProviderFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  };
  return seen;
}

describe('models in the core', () => {
  it('builds the catalog from the bundled snapshot and makes it the one providers price with', () => {
    const { core } = makeCore();
    assert.strictEqual(core.models.catalog.status().source, 'snapshot');
    assert.strictEqual(core.context.getCatalog(), core.models.catalog);
    assert.strictEqual(getActiveCatalog(), core.models.catalog);
    assert.strictEqual(core.context.getProviderOptions('openai').catalog, core.models.catalog);
    assert.strictEqual(core.context.getAvailability(), core.models.availability);
  });

  it('tests a provider with listModels and stores the account\'s models under apiStatus', async () => {
    const { core, store, sent } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    const seen = stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-4o' }] }) });
    const r = await core.context.testProviderConnection('openai');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.status.models, ['gpt-4o', 'gpt-5.5']);
    assert.deepStrictEqual(store.get('apiStatus').openai.models, ['gpt-4o', 'gpt-5.5']);
    assert.strictEqual(seen[0].headers.Authorization, 'Bearer sk-test-123456');
    assert.ok(sent.some((e) => e.ch === 'models:statusChanged' && e.p.provider === 'openai'));
  });

  it('reports a failed test as an error with its status', async () => {
    const { core } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ error: { message: 'Incorrect API key provided' } }, 401) });
    const r = await core.context.testProviderConnection('openai');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Incorrect API key provided');
    assert.strictEqual(r.status.httpStatus, 401);
  });

  it('gives Ollama the address from settings', () => {
    const { core } = makeCore();
    const settings = core.getSettings();
    core.context.setSettings({ ...settings, models: { ...settings.models, ollama: { baseUrl: 'http://192.0.2.7:11434' } } });
    assert.strictEqual(core.context.getProviderOptions('ollama').serverUrl, 'http://192.0.2.7:11434');
    assert.strictEqual(core.context.getProviderOptions('openai').serverUrl, undefined);
  });

  it('marks a provider unusable on a 401 during use, but not on a rate limit', () => {
    const { core } = makeCore();
    core.context.reportProviderError('openai', Object.assign(new Error('Incorrect API key provided'), { status: 401 }));
    assert.strictEqual(core.models.availability.status('openai').authFailed, true);
    core.context.reportProviderError('groq', Object.assign(new Error('Rate limit reached'), { status: 429 }));
    assert.strictEqual(core.models.availability.status('groq'), null);
    const wrapped = new Error('Provider call failed (iteration 1, model "m"): bad key');
    wrapped.cause = Object.assign(new Error('bad key'), { status: 403 });
    core.context.reportProviderError('anthropic', wrapped);
    assert.strictEqual(core.models.availability.status('anthropic').authFailed, true);
  });

  it('retests a saved key and forgets the status of a cleared one', async () => {
    const { core, store } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }] }) });
    assert.strictEqual((await core.context.onProviderKeyChanged('openai')).ok, true);
    store.set('apiTokens', {});
    assert.strictEqual(await core.context.onProviderKeyChanged('openai'), null);
    assert.strictEqual(store.get('apiStatus').openai, undefined);
  });

  it('starts no background checks in test mode', async () => {
    process.env.KL_TEST_MODE = '1';
    const calls = [];
    const { core } = makeCore({ fetch: async (url) => { calls.push(url); throw new Error('no'); } });
    assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: true });
    assert.deepStrictEqual(calls, []);
  });

  it('background checks refresh the catalog and retest stale providers', async () => {
    delete process.env.KL_TEST_MODE;
    const catalogCalls = [];
    const { core } = makeCore({
      fetch: async (url) => {
        catalogCalls.push(url);
        if (url === CATALOG_DEFAULTS.modelsDevUrl) return json({ openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5', cost: { input: 5, output: 30 } } } } });
        if (url === CATALOG_DEFAULTS.scoresUrl) return json({ data: [] });
        throw new Error(`unexpected ${url}`);
      }
    });
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }] }) });
    assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: false });
    assert.deepStrictEqual(catalogCalls.sort(), [CATALOG_DEFAULTS.modelsDevUrl, CATALOG_DEFAULTS.scoresUrl].sort());
    assert.strictEqual(core.models.catalog.status().source, 'live');
    assert.strictEqual(core.models.availability.status('openai').ok, true);
    assert.strictEqual(core.models.availability.status('ollama'), null, 'an Ollama never set up is not probed');
  });
});
```

Create `tests/models-ipc.test.js`:

```js
// tests/models-ipc.test.js
// The models channels (spec 2026-09-27 §5): catalog status and refresh,
// Test all, usable models and their reasons, the Ollama address.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');

function setup(overrides = {}) {
  const calls = { refresh: [], usable: [], explain: [], tested: [], settings: [] };
  let settings = { models: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } };
  const context = {
    getCatalog: () => ({
      status: () => ({ source: 'snapshot', fetchedAt: null, snapshotDate: '2026-09-27T00:00:00.000Z', stale: false, models: 742 }),
      refresh: async (opts) => { calls.refresh.push(opts); return { source: 'live', fetchedAt: '2026-09-28T00:00:00.000Z' }; }
    }),
    getAvailability: () => ({
      statusAll: () => ({ openai: { ok: true, models: ['gpt-5.5'] }, groq: null }),
      testAll: async () => ({ openai: { ok: true } }),
      test: async (p) => { calls.tested.push(p); return { ok: true, models: ['test-model'] }; },
      usable: ({ needs }) => { calls.usable.push(needs); return [{ provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5', known: true, priced: true, cost: { input: 5, output: 30 }, context: 1050000, toolCall: true, imageInput: true, local: false, extra: 'dropped' }]; },
      explain: (p, m, { needs }) => { calls.explain.push([p, m, needs]); return { usable: false, reasons: ['No token saved for Groq.'], notes: [], entry: { big: true } }; }
    }),
    getSettings: () => settings,
    setSettings: (next) => { calls.settings.push(next); settings = next; },
    ...overrides
  };
  const handlers = new Map();
  registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, context);
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { call, calls };
}

describe('models IPC', () => {
  it('reports catalog status and provider statuses', async () => {
    const { call } = setup();
    const r = await call(IPC.MODELS_STATUS);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.catalog.source, 'snapshot');
    assert.deepStrictEqual(r.providers.openai.models, ['gpt-5.5']);
  });

  it('forces a catalog refresh', async () => {
    const { call, calls } = setup();
    assert.strictEqual((await call(IPC.MODELS_REFRESH_CATALOG)).ok, true);
    assert.deepStrictEqual(calls.refresh, [{ force: true }]);
  });

  it('tests all providers', async () => {
    assert.deepStrictEqual(await setup().call(IPC.MODELS_TEST_ALL), { ok: true, providers: { openai: { ok: true } } });
  });

  it('lists usable models for sanitized needs, as plain candidate views', async () => {
    const { call, calls } = setup();
    const r = await call(IPC.MODELS_USABLE, { needs: { toolCall: 'yes', imageInput: true, textOutput: true, minContext: -1, extra: 1 } });
    assert.deepStrictEqual(calls.usable, [{ imageInput: true, textOutput: true }]);
    assert.strictEqual(r.models[0].extra, undefined);
    assert.strictEqual(r.models[0].model, 'gpt-5.5');
  });

  it('explains a model without sending the catalog entry', async () => {
    const { call, calls } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_EXPLAIN, { provider: 'groq', model: 'llama-3.3-70b', needs: { toolCall: true } }), {
      ok: true, usable: false, reasons: ['No token saved for Groq.'], notes: []
    });
    assert.deepStrictEqual(calls.explain, [['groq', 'llama-3.3-70b', { toolCall: true }]]);
    assert.strictEqual((await call(IPC.MODELS_EXPLAIN, {})).ok, false);
  });

  it('saves a valid Ollama address and tests it; refuses anything else', async () => {
    const { call, calls } = setup();
    assert.strictEqual((await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'not a url' })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'ftp://192.0.2.7' })).ok, false);
    const r = await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'http://192.0.2.7:11434/' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.baseUrl, 'http://192.0.2.7:11434');
    assert.strictEqual(calls.settings[0].models.ollama.baseUrl, 'http://192.0.2.7:11434');
    assert.deepStrictEqual(calls.tested, ['ollama']);
    assert.deepStrictEqual(r.status.models, ['test-model']);
  });

  it('says so when the host has no catalog', async () => {
    const { call } = setup({ getCatalog: () => null });
    const r = await call(IPC.MODELS_STATUS);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not available/);
  });
});
```

In `tests/ollama-settings.test.js`, replace the `describe('settings:testProvider', ...)` block (lines 38-75) with:

```js
  describe('settings:testProvider', () => {
    it('delegates to the one connection test, with no token needed for Ollama', async () => {
      const tested = [];
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async (p) => {
          tested.push(p);
          return { ok: true, status: { ok: true, message: 'Connected: 2 models.', models: ['llama3.1', 'qwen2.5'] } };
        }
      }));
      const result = await handler({}, { provider: 'ollama' });
      assert.strictEqual(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(tested, ['ollama']);
    });

    it('reports a missing token as the test\'s error', async () => {
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async () => ({ ok: false, error: 'No token saved for this provider.', status: { ok: false } })
      }));
      const result = await handler({}, { provider: 'openai' });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /No token saved/i);
    });

    it('refuses an unknown provider without testing', async () => {
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async () => { throw new Error('must not be called'); }
      }));
      assert.deepStrictEqual(await handler({}, { provider: 'nope' }), { ok: false, error: 'Unknown provider.' });
    });
  });
```

In `tests/settings-handlers.test.js`, before the final `setTimeout(...)` block, add:

```js
run('settings:saveProvider retests the provider in the background', async () => {
  const changed = [];
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    onProviderKeyChanged: async (provider) => { changed.push(provider); return { ok: true }; }
  }));
  const saved = await ipcMain.handlers.get('settings:saveProvider')({}, { provider: 'openai', token: 'sk-test-123456' });
  assert.deepStrictEqual(saved, { ok: true, hasToken: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(changed, ['openai']);
  await ipcMain.handlers.get('settings:saveProvider')({}, { provider: 'openai', clear: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(changed, ['openai', 'openai']);
});

run('settings:testProvider returns the one connection test\'s result', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    testProviderConnection: async (provider) => ({ ok: true, status: { ok: true, message: `tested ${provider}` } })
  }));
  const result = await ipcMain.handlers.get('settings:testProvider')({}, { provider: 'openai' });
  assert.deepStrictEqual(result, { ok: true, status: { ok: true, message: 'tested openai' } });
});

run('settings:load includes the Ollama address', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    getSettings: () => ({ activeProvider: 'openai', inference: {}, providerModels: {}, models: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } })
  }));
  const result = await ipcMain.handlers.get('settings:load')({});
  assert.strictEqual(result.data.ollamaBaseUrl, 'http://127.0.0.1:11434');
});
```

In `tests/inference-router.test.js`, add inside the `describe('InferenceRouter', ...)` block:

```js
  it('reports an auth failure to onProviderError, and a rate limit not at all', async () => {
    const reported = [];
    const authError = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    const router = new InferenceRouter({
      ...mockConfig({ providers: { anthropic: { getDefaultModel: () => 'claude-3', sendMessage: async () => { throw authError; } } } }),
      onProviderError: (provider, err) => reported.push([provider, err])
    });
    await assert.rejects(router.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {}));
    assert.deepStrictEqual(reported, [['anthropic', authError]]);

    const limited = [];
    const slow = new InferenceRouter({
      ...mockConfig({ providers: { anthropic: { getDefaultModel: () => 'claude-3', sendMessage: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } } } }),
      sleep: async () => {},
      onProviderError: (provider) => limited.push(provider)
    });
    await assert.rejects(slow.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {}));
    assert.deepStrictEqual(limited, []);
  });
```

In `tests/desktop-bridge-allowlist.test.js`, line 60 becomes:

```js
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas', 'executors', 'contact', 'contactPolicy', 'presence', 'models']);
```

and add `'models:usable': 'proxy',` to the `cases` object of the first test (after `'executors:list': 'proxy',`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-core.test.js tests/models-ipc.test.js tests/ollama-settings.test.js tests/inference-router.test.js tests/desktop-bridge-allowlist.test.js && node tests/settings-handlers.test.js`
Expected: FAIL (`core.models` undefined, `Cannot find module '../src/ipc/models-handlers'`, the new cases fail).

- [ ] **Step 3: The InferenceRouter auth hook**

In `src/providers/inference-router.js`, at the end of the constructor (after the `compressContext` assignment, line 35) add:

```js
    // Told about a 401/403 so availability can mark the provider unusable at
    // once (spec 2026-09-27 §5.3). Rate limits and timeouts are not reported.
    this.onProviderError = typeof options.onProviderError === 'function'
      ? options.onProviderError
      : null;
```

In `routeWithFallback`, directly after `attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;` (line 190) add:

```js
        if (this.onProviderError && (plan.reason === 'auth' || plan.reason === 'auth_permanent')) {
          try {
            this.onProviderError(config.provider, err);
          } catch (hookErr) {
            log.warn(`Reporting a ${config.provider} auth failure failed: ${hookErr.message}`);
          }
        }
```

- [ ] **Step 4: The core**

In `src/core/create-core.js`:

1. After `const UsageTracker = require('../tracking/usage-tracker');` (line 67) add:

```js
const { Catalog, Availability, setActiveCatalog } = require('../models');
const { classifyError, FailoverReason } = require('../providers/error-classifier');
```

2. After `const setSettings = (settings) => store.set('settings', mergeSettings(settings));` (line 293) add:

```js
  // Model catalog (spec 2026-09-27 §4): the bundled snapshot plus the copy
  // cached under <dataDir>/catalog/. Loading never touches the network; the
  // host starts the refresh through startModelsBackgroundChecks below.
  const modelsFetch = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
  const catalog = new Catalog().load({
    cacheDir: path.join(userDataPath, 'catalog'),
    fetch: modelsFetch,
    getSettings
  });
  setActiveCatalog(catalog);
  catalog.on('updated', (status) => ui.send('models:catalogUpdated', status));
```

3. After the `clearProviderToken` function (ends `return false;\n  };` near line 959) add:

```js
  // Providers for King Louie's own calls: the catalog prices them, and
  // Ollama talks to the address in models.ollama.baseUrl (spec §5.4).
  const providerOptionsFor = (providerType) => ({
    catalog,
    ...(providerType === 'ollama' ? { serverUrl: getSettings().models?.ollama?.baseUrl } : {})
  });

  const createProviderInstance = (providerType, token) => {
    if (providerType === 'anthropic' && token === '__anthropic_oauth__') {
      // OAuth mode — the token is refreshed async before the first API call.
      return ProviderFactory.createProvider(providerType, 'oauth-placeholder', { ...providerOptionsFor(providerType), authMode: 'oauth' });
    }
    return ProviderFactory.createProvider(providerType, token, providerOptionsFor(providerType));
  };

  const hasProviderCredential = (provider) => {
    if (provider === 'ollama') return true;
    if (provider === 'anthropic' && anthropicOAuth.isConnected()) return true;
    return Boolean(getApiTokens()[provider]);
  };

  // Availability (spec §5): one connection test per provider, its result
  // stored under the existing apiStatus key with the account's models.
  const availability = new Availability({
    catalog,
    labels: PROVIDER_LABELS,
    hasCredential: hasProviderCredential,
    createProvider: async (provider) => {
      const token = getDecryptedProviderToken(provider);
      if (provider === 'anthropic' && token === '__anthropic_oauth__') {
        const accessToken = await refreshAnthropicOAuthToken();
        return ProviderFactory.createProvider('anthropic', accessToken, { ...providerOptionsFor('anthropic'), authMode: 'oauth' });
      }
      return createProviderInstance(provider, token);
    },
    getStatuses: getApiStatus,
    setStatuses: setApiStatus,
    getSettings,
    fetch: modelsFetch
  });
  availability.on('changed', (change) => ui.send('models:statusChanged', change));

  // A 401 or 403 makes the provider unusable at once (spec §5.3). Rate
  // limits and timeouts do not change usability.
  const reportProviderError = (provider, error) => {
    if (!provider || !error) return;
    const root = error.cause && typeof error.cause === 'object' ? error.cause : error;
    const { reason } = classifyError(root, { provider });
    if (reason === FailoverReason.AUTH || reason === FailoverReason.AUTH_PERMANENT) {
      availability.markAuthFailure(provider, root);
    }
  };

  // A key saved, cleared or connected: test it, or drop the status when no
  // credential is left (spec §5.2).
  const onProviderKeyChanged = async (provider) => {
    if (!hasProviderCredential(provider)) {
      availability.forget(provider);
      return null;
    }
    return availability.test(provider);
  };

  // The catalog refresh and the stale-provider retests reach the network, so
  // the host starts them after start() (main.js, runService), never
  // createCore().start() — unit tests build cores all the time. KL_TEST_MODE
  // (every e2e launch and the service smoke test) keeps them off.
  const startModelsBackgroundChecks = async () => {
    if (process.env.KL_TEST_MODE) return { skipped: true };
    await Promise.all([
      catalog.refresh().catch((err) => log.warn(`Model catalog refresh failed: ${err.message}`)),
      availability.retestStale().catch((err) => log.warn(`Provider retests failed: ${err.message}`))
    ]);
    return { skipped: false };
  };
```

4. Replace the whole `testProviderConnection` function (lines 1437-1485) with:

```js
  // The one connection test (spec §5.2): the provider's listModels().
  const testProviderConnection = async (provider) => {
    const status = await availability.test(provider);
    return status.ok ? { ok: true, status } : { ok: false, error: status.error || status.message, status };
  };
```

5. In `/llm add`, after `saveProviderToken(provider, token);` (line 1927) add:

```js
      availability.test(provider).catch((err) => log.warn(`Testing ${provider} after /llm add failed: ${err.message}`));
```

6. Replace the `inferenceRouter` construction (lines 2150-2161) with:

```js
  const inferenceRouter = new InferenceRouter({
    getSettings,
    getProviderModel,
    getProviderToken: getDecryptedProviderToken,
    createProvider: (providerType, token) => createProviderInstance(providerType, token),
    onProviderError: reportProviderError
  });
```

7. In the `llmRouter = new LLMRouter({...})` block (lines 2509-2513), replace `createProvider: (providerType, token) => ProviderFactory.createProvider(providerType, token)` with `createProvider: (providerType, token) => createProviderInstance(providerType, token)`.

8. In the skills `get llmProvider()` getter (lines 2693-2708), replace `return ProviderFactory.createProvider(providerType, token);` with `return createProviderInstance(providerType, token);`.

9. In `const context = { ... }`, under `// Settings` after `setNotificationSettings,` add:

```js

    // Models (spec 2026-09-27 §4, §5)
    getCatalog: () => catalog,
    getAvailability: () => availability,
    getProviderOptions: providerOptionsFor,
    testProviderConnection,
    reportProviderError,
    onProviderKeyChanged,
```

10. In the returned object, after `saveProviderToken,` add:

```js
    // The host starts these after start(): see startModelsBackgroundChecks.
    models: { catalog, availability, startBackgroundChecks: startModelsBackgroundChecks },
```

- [ ] **Step 5: The settings channels**

In `src/ipc/settings-handlers.js`:

1. In the context destructuring (lines 8-38) add `testProviderConnection,` and `onProviderKeyChanged,` and `getProviderOptions,` after `updateStatus,`.

2. After the `const applyActiveProvider = ...` line (line 52) add:

```js
  // A saved, cleared or connected key is retested in the background (spec
  // 2026-09-27 §5.2); the result reaches the UI as models:statusChanged.
  const notifyKeyChanged = (provider) => {
    if (typeof onProviderKeyChanged !== 'function') return;
    Promise.resolve()
      .then(() => onProviderKeyChanged(provider))
      .catch((err) => log.warn(`Retesting ${provider} after a key change failed: ${err.message}`));
  };
```

3. In `settings:load`, after `activeProvider: settings.activeProvider || 'openai',` add:

```js
      ollamaBaseUrl: settings.models?.ollama?.baseUrl || '',
```

4. In `settings:saveProvider`, call `notifyKeyChanged(provider);` right after each `setApiTokens(tokens);` (the clear branch and the save branch). The return values stay `{ ok: true, hasToken: false }` and `{ ok: true, hasToken: true }`.

5. Replace the whole `settings:testProvider` handler (lines 350-438) with:

```js
  ipcMain.handle('settings:testProvider', wrapHandler('settings:testProvider', async (_event, { provider }) => {
    if (!providerLabels[provider]) {
      return { ok: false, error: 'Unknown provider.' };
    }
    if (typeof testProviderConnection !== 'function') {
      return { ok: false, error: 'Connection tests are not available in this host.' };
    }
    // The one connection test (spec 2026-09-27 §5.2): the provider's
    // listModels(), stored under apiStatus with the account's models.
    return testProviderConnection(provider);
  }));
```

6. In `settings:listModels`, replace `const instance = ProviderFactory.create(provider, token || 'ollama-local', { authMode });` with:

```js
        const providerOptions = typeof getProviderOptions === 'function' ? getProviderOptions(provider) : {};
        const instance = ProviderFactory.create(provider, token || 'ollama-local', { ...providerOptions, authMode });
```

7. In `settings:anthropicOAuthStart`, after the `updateStatus('anthropic', {...})` call add `notifyKeyChanged('anthropic');`. In `settings:anthropicOAuthDisconnect`, after `anthropicOAuth.clearStoredTokens();` add `notifyKeyChanged('anthropic');`.

- [ ] **Step 6: The models channels**

Add to `src/ipc/constants.js`, after the `USAGE_GET_DAILY` line:

```js

  // Model catalog and availability (spec 2026-09-27, stage M1).
  MODELS_STATUS: 'models:status',
  MODELS_REFRESH_CATALOG: 'models:refreshCatalog',
  MODELS_TEST_ALL: 'models:testAll',
  MODELS_USABLE: 'models:usable',
  MODELS_EXPLAIN: 'models:explain',
  MODELS_SET_OLLAMA_URL: 'models:setOllamaBaseUrl',
```

Create `src/ipc/models-handlers.js`:

```js
// src/ipc/models-handlers.js
// Catalog and availability channels (spec 2026-09-27 §4, §5; stage M1).
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

// What the renderer may ask for; anything else in `needs` is ignored.
function needsFrom(needs) {
  const n = needs && typeof needs === 'object' ? needs : {};
  return {
    ...(n.toolCall === true ? { toolCall: true } : {}),
    ...(n.imageInput === true ? { imageInput: true } : {}),
    ...(n.textOutput === true ? { textOutput: true } : {}),
    ...(Number.isFinite(n.minContext) && n.minContext > 0 ? { minContext: n.minContext } : {})
  };
}

const candidateView = (c) => ({
  provider: c.provider,
  model: c.model,
  name: c.name,
  known: c.known,
  priced: c.priced,
  cost: c.cost,
  context: c.context,
  toolCall: c.toolCall,
  imageInput: c.imageInput,
  local: c.local
});

function registerModelsHandlers(ipcMain, context = {}) {
  const catalog = () => {
    const c = typeof context.getCatalog === 'function' ? context.getCatalog() : null;
    if (!c) throw new Error('The model catalog is not available in this host.');
    return c;
  };
  const availability = () => {
    const a = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
    if (!a) throw new Error('Provider availability is not available in this host.');
    return a;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => (
    fn(payload && typeof payload === 'object' ? payload : {})
  )));

  handle(IPC.MODELS_STATUS, async () => ({ ok: true, catalog: catalog().status(), providers: availability().statusAll() }));

  handle(IPC.MODELS_REFRESH_CATALOG, async () => {
    await catalog().refresh({ force: true });
    return { ok: true, catalog: catalog().status() };
  });

  handle(IPC.MODELS_TEST_ALL, async () => ({ ok: true, providers: await availability().testAll() }));

  handle(IPC.MODELS_USABLE, async ({ needs }) => ({
    ok: true,
    models: availability().usable({ needs: needsFrom(needs) }).map(candidateView)
  }));

  handle(IPC.MODELS_EXPLAIN, async ({ provider, model, needs }) => {
    if (typeof provider !== 'string' || !provider) return { ok: false, error: 'provider is required.' };
    const verdict = availability().explain(provider, typeof model === 'string' ? model : '', { needs: needsFrom(needs) });
    return { ok: true, usable: verdict.usable, reasons: verdict.reasons, notes: verdict.notes };
  });

  handle(IPC.MODELS_SET_OLLAMA_URL, async ({ baseUrl }) => {
    let url;
    try {
      url = new URL(String(baseUrl || '').trim());
    } catch {
      return { ok: false, error: 'Enter a full address, such as http://127.0.0.1:11434.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'The Ollama address must start with http:// or https://.' };
    }
    const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    const settings = context.getSettings();
    context.setSettings({
      ...settings,
      models: { ...(settings.models || {}), ollama: { ...(settings.models?.ollama || {}), baseUrl: normalized } }
    });
    const status = await availability().test('ollama');
    return { ok: true, baseUrl: normalized, status };
  });
}

module.exports = { registerModelsHandlers };
```

In `src/ipc/register.js`, inside `registerHandlers` after the `require('./desktop-handlers')...` line, add:

```js
  require('./models-handlers').registerModelsHandlers(ipcMain, context);
```

In `preload.js`, after the `usage: { ... },` namespace (ends line 918), add:

```js
    models: {
      status: () => ipcRenderer.invoke('models:status'),
      refreshCatalog: () => ipcRenderer.invoke('models:refreshCatalog'),
      testAll: () => throttleInvoke('models:testAll', () => ipcRenderer.invoke('models:testAll')),
      usable: (payload = {}) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:usable', payload);
      },
      explain: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.provider, 'provider', { minLength: 1 });
        return ipcRenderer.invoke('models:explain', payload);
      },
      setOllamaBaseUrl: (baseUrl) => {
        validateString(baseUrl, 'baseUrl', { minLength: 1 });
        return ipcRenderer.invoke('models:setOllamaBaseUrl', { baseUrl });
      },
      onStatusChanged: (callback) => registerAdditive('models:statusChanged', callback),
      onCatalogUpdated: (callback) => registerAdditive('models:catalogUpdated', callback)
    },
```

In `src/desktop-bridge/allowlist.js`, append to `PROXIED_DOMAINS` (after `'presence'`):

```js
  // Models stage M1: catalog status, usable models, provider tests.
  'models'
```

and add `'models:statusChanged', 'models:catalogUpdated'` to `RENDERER_EVENTS` (after `'case:changed'`, with a comma after it).

- [ ] **Step 7: The hosts start the background checks**

In `main.js`, after the `try { await host.start(); } catch (err) { ... }` block (lines 80-87) add:

```js

  // Catalog refresh and stale provider retests (spec 2026-09-27 §4.1, §5.2),
  // started here rather than in createCore().start(). Attached mode has no core.
  if (host.core && host.core.models) host.core.models.startBackgroundChecks();
```

In `src/service/run.js`, in the agent profile's returned object (after `stop: async () => { ... },`, line 182) add:

```js
          startBackgroundChecks: () => core.models.startBackgroundChecks(),
```

and in `runService`, after `log.info('service ready', { profile, masterKeySource: running.masterKeySource });` add:

```js
    if (typeof running.startBackgroundChecks === 'function') {
      running.startBackgroundChecks().catch((err) => log.warn(`Model background checks failed: ${err.message}`));
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/models-core.test.js tests/models-ipc.test.js tests/ollama-settings.test.js tests/inference-router.test.js tests/desktop-bridge-allowlist.test.js tests/ipc-contract.test.js tests/preload-bridge.test.js tests/core-create.test.js tests/service-run.test.js && node tests/settings-handlers.test.js`
Expected: PASS, `# fail 0`, and every `run(...)` line of `settings-handlers.test.js` prints `✔`.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/core/create-core.js src/providers/inference-router.js src/ipc/settings-handlers.js src/ipc/models-handlers.js src/ipc/constants.js src/ipc/register.js src/desktop-bridge/allowlist.js preload.js main.js src/service/run.js tests/models-core.test.js tests/models-ipc.test.js tests/ollama-settings.test.js tests/settings-handlers.test.js tests/inference-router.test.js tests/desktop-bridge-allowlist.test.js
git commit -m "feat(models): one connection test, key-change retests and models IPC wired into the core"
```

---

## Task 8: Capabilities come from the catalog; `InferenceRouter.getCapabilities` is removed

**Files:**
- Create: `src/models/capabilities.js`
- Modify: `src/models/index.js` (export `capabilitiesOf`)
- Modify: `src/providers/inference-router.js:38-73` (delete `getCapabilities`)
- Modify: `src/core/create-core.js` — `createAgentRuntime` (the `inferenceRouter.getCapabilities(...)` line, originally 2199) and the ingest service's `getCapabilities` (originally line 3003)
- Modify: `src/cases/ingest/vision.js:1-7` (header comment only)
- Test: `tests/models-capabilities.test.js` (new); `tests/cases-ingest-vision.test.js:7`, `:20-66`, `:85-87` (use the catalog); `tests/helpers/ingest-harness.js:8`, `:18`, `:77` (use the catalog); `tests/inference-router.test.js:85-90` (delete the capabilities test)

**Interfaces:**
- Consumes: `Catalog#get` (Task 1), `fixtureCatalog()` (Task 1), the core's `catalog` (Task 7).
- Produces: `capabilitiesOf(catalog, provider, model) → { vision, toolCalling, streaming, pdfInput }` (the same four keys `getCapabilities` returned, in the same order). `vision` = the entry takes image input; `toolCalling` = the entry's `toolCall` (true for a model the catalog does not know, so an unknown model is not refused); `streaming` = true; `pdfInput` = vision and PDF input and the provider is Anthropic or Gemini (the providers `ImageHandler.formatDocumentForProvider` sends one-page PDFs to). An unknown or empty model has `vision: false`, `pdfInput: false`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-capabilities.test.js`:

```js
// tests/models-capabilities.test.js
// The catalog replaces InferenceRouter.getCapabilities (spec 2026-09-27
// §4.5), whose guesses were stale (Claude 4 counted as non-vision, Ollama
// tool calling guessed from the model name).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { capabilitiesOf } = require('../src/models/capabilities');
const InferenceRouter = require('../src/providers/inference-router');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { localEntry } = require('../src/models/normalize');

const catalog = fixtureCatalog();
const caps = (p, m) => capabilitiesOf(catalog, p, m);

describe('capabilitiesOf', () => {
  it('reads vision and tool calling from the catalog entry', () => {
    assert.deepStrictEqual(caps('anthropic', 'claude-sonnet-4-5'), { vision: true, toolCalling: true, streaming: true, pdfInput: true });
    assert.deepStrictEqual(caps('openai', 'gpt-4o'), { vision: true, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('openai', 'gpt-3.5-turbo'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('groq', 'llama-vision-preview'), { vision: true, toolCalling: false, streaming: true, pdfInput: false });
  });

  it('gives PDF input only to PDF-reading models of Anthropic and Gemini', () => {
    assert.strictEqual(caps('gemini', 'gemini-2.5-pro').pdfInput, true);
    assert.strictEqual(caps('openai', 'gpt-5.5').pdfInput, false, 'the catalog says pdf, but ImageHandler sends OpenAI page images');
  });

  it('reports what Ollama itself says, not a guess from the name', () => {
    const local = fixtureCatalog();
    local.setLocalModels('ollama', [localEntry('ollama', { id: 'llama3.1:8b', toolCall: false }), localEntry('ollama', { id: 'qwen2.5:7b', toolCall: true })]);
    assert.strictEqual(capabilitiesOf(local, 'ollama', 'llama3.1:8b').toolCalling, false);
    assert.strictEqual(capabilitiesOf(local, 'ollama', 'qwen2.5:7b').toolCalling, true);
  });

  it('does not refuse an unknown model, and never claims it sees images', () => {
    assert.deepStrictEqual(caps('openai', 'my-finetune'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('anthropic', ''), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(capabilitiesOf(null, 'openai', 'gpt-4o'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
  });

  it('the router no longer guesses capabilities', () => {
    assert.strictEqual(typeof new InferenceRouter({ getSettings: () => ({}) }).getCapabilities, 'undefined');
  });
});
```

In `tests/cases-ingest-vision.test.js`:

1. Replace line 7 (`const InferenceRouter = require('../src/providers/inference-router');`) with:

```js
const { capabilitiesOf } = require('../src/models/capabilities');
const { fixtureCatalog } = require('./helpers/models-fixture');
```

2. Replace lines 20-66 (the `router`/`caps` definitions and the whole `describe('InferenceRouter.getCapabilities (cases stage 7 fix)', ...)` block) with:

```js
// Capabilities come from the model catalog (models M1); the fixture catalog
// keeps these expectations fixed when the bundled snapshot is regenerated.
const catalog = fixtureCatalog();
const caps = (p, m) => capabilitiesOf(catalog, p, m);

describe('capabilities for ingest (from the catalog)', () => {
  it('marks current Anthropic models as vision-capable', () => {
    assert.strictEqual(caps('anthropic', 'claude-sonnet-4-5').vision, true);
    assert.strictEqual(caps('anthropic', 'claude-opus-4-1').vision, true);
    assert.strictEqual(caps('anthropic', 'claude-2.1').vision, false, 'a model the catalog does not know');
  });

  it('adds pdfInput for PDF-reading models of Anthropic and Gemini only', () => {
    assert.strictEqual(caps('anthropic', 'claude-sonnet-4-5').pdfInput, true);
    assert.strictEqual(caps('gemini', 'gemini-2.5-pro').pdfInput, true);
    assert.strictEqual(caps('openai', 'gpt-4o').pdfInput, false);
    assert.strictEqual(caps('openai', 'gpt-4o').vision, true);
  });

  it('returns the same four keys for every model', () => {
    for (const [p, m] of [['openai', 'gpt-4o'], ['groq', 'llama-3.3-70b'], ['openrouter', 'any-model'], ['ollama', 'llama3.1'], ['', '']]) {
      assert.deepStrictEqual(Object.keys(caps(p, m)), ['vision', 'toolCalling', 'streaming', 'pdfInput'], `${p}/${m}`);
    }
  });
});
```

3. In the `'fails closed: …'` test, replace the two lines

```js
    // The router reports vision for an empty Anthropic model name.
    assert.strictEqual(caps('anthropic', '').vision, true);
```

with

```js
    // An empty model name has no catalog entry, so no vision.
    assert.strictEqual(caps('anthropic', '').vision, false);
```

In `tests/helpers/ingest-harness.js`:

1. Replace line 8 (`const InferenceRouter = require('../../src/providers/inference-router');`) with:

```js
const { capabilitiesOf } = require('../../src/models/capabilities');
const { fixtureCatalog } = require('./models-fixture');
```

2. Replace line 18 (`const router = new InferenceRouter({ getSettings: () => ({}) });`) with:

```js
const catalog = fixtureCatalog();
```

3. Replace line 77 (`getCapabilities: (p, m) => router.getCapabilities(p, m),`) with:

```js
    getCapabilities: (p, m) => capabilitiesOf(catalog, p, m),
```

In `tests/inference-router.test.js`, delete the `it('returns capabilities for known models', ...)` test (lines 85-90).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-capabilities.test.js tests/cases-ingest-vision.test.js`
Expected: FAIL with `Cannot find module '../src/models/capabilities'`.

- [ ] **Step 3: Write `src/models/capabilities.js`**

```js
// src/models/capabilities.js
// What a model can do, from the catalog (spec 2026-09-27 §4.5). Replaces
// InferenceRouter.getCapabilities and keeps its four keys, so its callers
// (agent runtime, case ingest) did not have to change.

// ImageHandler.formatDocumentForProvider sends a one-page PDF as a document
// only to these; the others get the page image.
const PDF_DOCUMENT_PROVIDERS = Object.freeze(['anthropic', 'gemini']);

function capabilitiesOf(catalog, provider, model) {
  const p = String(provider || '').toLowerCase();
  const entry = catalog && model ? catalog.get(p, model) : null;
  if (!entry) {
    // Unknown: never claim it sees images, and do not refuse it tools.
    return { vision: false, toolCalling: true, streaming: true, pdfInput: false };
  }
  const vision = entry.input.includes('image');
  return {
    vision,
    toolCalling: entry.toolCall === true,
    streaming: true,
    pdfInput: vision && entry.input.includes('pdf') && PDF_DOCUMENT_PROVIDERS.includes(p)
  };
}

module.exports = { capabilitiesOf, PDF_DOCUMENT_PROVIDERS };
```

Add to `src/models/index.js`: `const { capabilitiesOf } = require('./capabilities');` and `capabilitiesOf` in `module.exports`.

- [ ] **Step 4: Remove the router's guess and use the catalog in the core**

Delete `getCapabilities(provider, model) { ... }` from `src/providers/inference-router.js` (lines 38-73).

In `src/core/create-core.js`:

1. Change the models require added in Task 7 to:

```js
const { Catalog, Availability, setActiveCatalog, capabilitiesOf } = require('../models');
```

2. In `createAgentRuntime`, replace

```js
    const capabilities = inferenceRouter.getCapabilities(resolution.providerType, resolution.model);
```

with

```js
    const capabilities = capabilitiesOf(catalog, resolution.providerType, resolution.model);
```

3. In the ingest service construction, replace

```js
      getCapabilities: (provider, model) => inferenceRouter.getCapabilities(provider, model),
```

with

```js
      getCapabilities: (provider, model) => capabilitiesOf(catalog, provider, model),
```

In `src/cases/ingest/vision.js`, lines 3-5 of the header comment become:

```js
// §3.4; R45). Vision is a capability of an already chosen model: a model is
// vision-eligible only when the model catalog says it takes image input and
// its provider is one ImageHandler formats image attachments for.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/models-capabilities.test.js tests/cases-ingest-vision.test.js tests/cases-ingest-core.test.js tests/cases-ingest-review.test.js tests/cases-ingest-service.test.js tests/inference-router.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `# fail 0`. `grep -rn "getCapabilities(" src/providers` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/models/capabilities.js src/models/index.js src/providers/inference-router.js src/core/create-core.js src/cases/ingest/vision.js tests/models-capabilities.test.js tests/cases-ingest-vision.test.js tests/helpers/ingest-harness.js tests/inference-router.test.js
git commit -m "feat(models): capabilities come from the catalog; drop the router's guesses"
```

---

## Task 9: The send path checks usability instead of the three-provider list

**Files:**
- Modify: `src/ipc/chat-handlers.js:326-331` (hoist `inference`), `:361-364` (the restriction), `:700-722` (the error path reports auth failures)
- Create: `tests/helpers/chat-harness.js`
- Test: `tests/chat-usability.test.js` (new); `tests/desktop-bridge-dispatcher.test.js:27-40` (the fake provider answers the connection test)

**Interfaces:**
- Consumes: `context.getAvailability()` with `ensureTested(provider)` and `explain(provider, model, { needs })` (Tasks 6, 7); `context.reportProviderError(provider, error)` (Task 7); `startFakeLlmServer()` (Task 5).
- Produces:
  - `chat:sendMessage` accepts any of the 14 providers. Before any model call it runs `availability.ensureTested(providerType)` and `availability.explain(providerType, model, { needs })`, with `needs.toolCall` for agent mode or a case turn and `needs.imageInput` when images are attached; an unusable model fails the send with `Cannot use <provider>/<model>: <reasons joined by spaces>`. A host without `getAvailability` skips the check.
  - A failed send reports its error through `context.reportProviderError(providerType, error)`.
  - `tests/helpers/chat-harness.js`: `chatHarness({ provider, providerType = 'openai', model = 'test-model', chat?, overrides? }) → { chat, sent, usage, send(payload) → Promise, stop() → Promise, context }`. The context's `appendMessageToChat` keeps metadata on the stored message; `getUsageTracker().record` pushes to `usage`; `createToolExecutorWithApprovals` returns an EventEmitter executor whose `execute` resolves `{ ok: true }`; `AgentLoop` is the real one; `overrides.onSend(channel, payload)` sees every IPC event sent to the renderer; anything not given resolves to a function returning `null`.

- [ ] **Step 1: Write the chat harness**

Create `tests/helpers/chat-harness.js`:

```js
// tests/helpers/chat-harness.js
// chat:sendMessage and chat:stopResponse against a minimal context, with the
// real AgentLoop. Anything not given resolves to a function returning null,
// which the send path treats as "feature absent".
const EventEmitter = require('events');
const IPC = require('../../src/ipc/constants');
const { registerChatHandlers } = require('../../src/ipc/chat-handlers');
const { initializeTools, toolRegistry } = require('../../src/tools');
const AgentLoop = require('../../src/execution/agent-loop');

initializeTools();

function chatHarness({ provider, providerType = 'openai', model = 'test-model', chat = null, overrides = {} } = {}) {
  const sent = [];
  const usage = [];
  const theChat = chat || { id: 'chat-1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  let nextId = 0;
  const context = {
    getChats: () => [theChat],
    setChats: () => {},
    appendMessageToChat: (_chatId, sender, text, metadata = {}) => {
      theChat.messages.push({ id: `m${theChat.messages.length}`, sender, text, ...metadata });
      return theChat;
    },
    runHookEvent: async () => ({}),
    resolveInference: async () => ({ providerType, provider, model, tier: 'standard', timeoutMs: 1000 }),
    getUsageTracker: () => ({ record: (event) => { usage.push(event); return { ...event, cost: event.costUsd ?? null }; } }),
    createUsageRecordFromMetrics: (m) => ({
      provider: m.provider,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : null,
      ...(m.usagePartial ? { usagePartial: true } : {})
    }),
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async () => {
      const executor = new EventEmitter();
      executor.allowedDirectories = [];
      executor.execute = async () => ({ ok: true });
      return executor;
    },
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    createId: () => `id-${++nextId}`,
    ...overrides
  };
  const ctx = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, ctx);
  const event = {
    sender: {
      send: (channel, payload) => {
        sent.push({ channel, payload });
        if (typeof context.onSend === 'function') context.onSend(channel, payload);
      },
      isDestroyed: () => false
    }
  };
  const send = (payload = {}) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: theChat.id, message: 'Hello', ...payload });
  const stop = () => handlers.get(IPC.CHAT_STOP_RESPONSE)(event, { chatId: theChat.id });
  return { chat: theChat, sent, usage, send, stop, context };
}

module.exports = { chatHarness };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/chat-usability.test.js`:

```js
// tests/chat-usability.test.js
// The send path checks usability instead of the fixed
// ['openai', 'anthropic', 'gemini'] list (spec 2026-09-27 §5.5, M-D7).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const { chatHarness } = require('./helpers/chat-harness');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');

// An availability double: a verdict per provider/model, and a record of calls.
function fakeAvailability(verdicts = {}) {
  const calls = [];
  return {
    calls,
    ensureTested: async (provider) => { calls.push(['ensureTested', provider]); return { ok: true }; },
    explain: (provider, model, { needs } = {}) => {
      calls.push(['explain', provider, model, needs]);
      return verdicts[`${provider}/${model}`] || { usable: true, reasons: [], notes: [], entry: null };
    }
  };
}

describe('chat:sendMessage and usability', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('answers through a provider outside the old three (Groq), when it is usable', async () => {
    const provider = ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
    const availability = fakeAvailability();
    const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
    const result = await h.send({ agentMode: false });
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.sender, 'assistant');
    assert.strictEqual(reply.text, 'Hello there');
    assert.deepStrictEqual(availability.calls, [['ensureTested', 'groq'], ['explain', 'groq', 'llama-3.3-70b', {}]]);
  });

  it('refuses an unusable model before any model call, with the reasons', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; }, sendMessageWithTools: async () => { called = true; return {}; } };
    const availability = fakeAvailability({ 'groq/llama-3.3-70b': { usable: false, reasons: ['Groq connection test failed at 2026-09-27T11:00:00.000Z: Invalid API Key'], notes: [], entry: null } });
    const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Cannot use groq/llama-3.3-70b: Groq connection test failed at 2026-09-27T11:00:00.000Z: Invalid API Key');
    assert.strictEqual(called, false);
    assert.ok(h.sent.some((e) => e.channel === 'chat:messageError'));
  });

  it('asks for tool calling in agent mode and for image input with images', async () => {
    const availability = fakeAvailability();
    const provider = { streamMessage: async () => ({}), sendMessageWithTools: async () => ({ type: 'text', content: 'ok' }) };
    const h = chatHarness({ provider, overrides: { getAvailability: () => availability } });
    await h.send({ agentMode: true, images: [{ base64: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'a.png' }] });
    const explain = availability.calls.find((c) => c[0] === 'explain');
    assert.deepStrictEqual(explain[3], { toolCall: true, imageInput: true });
  });

  it('tests a never-tested provider first (a profile from before the catalog)', async () => {
    const order = [];
    const availability = {
      ensureTested: async () => { order.push('ensureTested'); },
      explain: () => { order.push('explain'); return { usable: true, reasons: [], notes: [] }; }
    };
    const h = chatHarness({ provider: { streamMessage: async () => ({}) }, overrides: { getAvailability: () => availability } });
    await h.send({ agentMode: false });
    assert.deepStrictEqual(order, ['ensureTested', 'explain']);
  });

  it('reports a failed call so a 401 can mark the provider unusable', async () => {
    const reported = [];
    const authError = Object.assign(new Error('Invalid API Key'), { status: 401 });
    const provider = { streamMessage: async () => { throw authError; } };
    const h = chatHarness({ provider, providerType: 'groq', overrides: { reportProviderError: (p, err) => reported.push([p, err]) } });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(reported, [['groq', authError]]);
  });

  it('runs with no check in a host without availability', async () => {
    const h = chatHarness({ provider: { streamMessage: async () => ({}) }, providerType: 'mistral' });
    assert.notStrictEqual((await h.send({ agentMode: false })).ok, false);
  });

  it('the fixed three-provider list is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'chat-handlers.js'), 'utf8');
    assert.doesNotMatch(src, /does not support chat completions yet/);
    assert.doesNotMatch(src, /\['openai', 'anthropic', 'gemini'\]\.includes/);
  });
});
```


In `tests/desktop-bridge-dispatcher.test.js`, add a `listModels` method to `class FakeProvider` (after `constructor() { this.calls = 0; }`, line 28), so the core's connection test passes for the fake OpenAI:

```js
  // The core's one connection test (models M1) lists this account's models.
  async listModels() { return ['fake']; }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/chat-usability.test.js`
Expected: FAIL: the Groq send throws `Active provider does not support chat completions yet.`, the unusable model is not refused, and the source still contains the list.

- [ ] **Step 4: Change the send path**

In `src/ipc/chat-handlers.js`:

1. Next to `let answerText = '';` (line 327) add:

```js
    let inference = null;
```

2. Replace lines 361-364:

```js
      const inference = await resolveInference({ message: safeMessage, agentMode });
      if (!['openai', 'anthropic', 'gemini'].includes(inference.providerType)) {
        throw new Error('Active provider does not support chat completions yet.');
      }
```

with:

```js
      inference = await resolveInference({ message: safeMessage, agentMode });

      // Any usable provider may answer (spec 2026-09-27 §5.5): its connection
      // test passed, the model is in the account's list, and it can call tools
      // (agent mode, case turns) or read images when the owner attached some.
      // A provider never tested (a key saved elsewhere, a profile from before
      // the catalog) is tested now rather than refused.
      const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
      if (availability) {
        await availability.ensureTested(inference.providerType);
        const needs = {
          ...(agentMode || caseTurn ? { toolCall: true } : {}),
          ...(normalizedImages.length > 0 ? { imageInput: true } : {})
        };
        const verdict = availability.explain(inference.providerType, inference.model, { needs });
        if (!verdict.usable) {
          throw new Error(`Cannot use ${inference.providerType}/${inference.model || '(no model)'}: ${verdict.reasons.join(' ')}`);
        }
      }
```

3. In the `catch (error)` block, directly before `safeSend(event.sender, 'chat:messageError', {` (line 716) add:

```js
      // A 401 or 403 marks the provider unusable at once (spec §5.3).
      if (inference && typeof context.reportProviderError === 'function') {
        context.reportProviderError(inference.providerType, error);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/chat-usability.test.js tests/cases-chat.test.js tests/cases-detour-hooks.test.js tests/desktop-bridge-dispatcher.test.js tests/chat-defaults.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/chat-handlers.js tests/helpers/chat-harness.js tests/chat-usability.test.js tests/desktop-bridge-dispatcher.test.js
git commit -m "feat(chat): any usable provider may answer; unusable models are refused with reasons"
```

---

## Task 10: Stop that stops — the agent loop and the chat send path

**Files:**
- Create: `src/providers/abort.js`, `src/tracking/llm-totals.js`
- Modify: `src/execution/agent-loop.js` — requires (lines 1-14), the abort check (lines 195-215), `effectiveOptions` (lines 219-222), the provider-call `catch` (lines 276-277), after the attempt loop (line 307), the metrics block (lines 309-335), the four totals reducers (lines 338-346, 612-630, 636-653, 656-673); new methods `_stoppedResult`, `_recordCall`
- Modify: `src/ipc/chat-handlers.js` — requires (lines 1-7), run state (after line 332), history filter (line 379), executor events (lines 510-522), agent path (after `loop.run`, line 576), plain path (lines 627-669), finalize (line 672), `catch` (lines 700-722)
- Modify: `src/core/create-core.js` — `createUsageRecordFromMetrics` (originally lines 781-789)
- Test: `tests/chat-stop.test.js` (new); `tests/agent-loop.test.js` (one existing abort test changes, four added to `describe('abort signal', ...)`)

**Interfaces:**
- Consumes: `err.partialLlmMetrics` on aborted provider calls (Task 5); `chatHarness()` (Task 9); `startFakeLlmServer()` with hold mode (Task 5); `fixtureCatalog()` (Task 1).
- Produces:
  - `src/providers/abort.js`: `isAbortError(err) → boolean`; `partialMetricsOf(err, { provider, model }) → metrics` (the provider's partial record, or an empty one: zero tokens, `costUsd: null`, `usagePartial: true`).
  - `src/tracking/llm-totals.js`: `sumLlmCalls(calls) → { inputTokens, outputTokens, totalTokens, costUsd, partial?: true, unpriced?: true }`.
  - `AgentLoop`: passes its `abortSignal` to every provider call as `options.abortSignal`; a call rejected after abort is recorded as a partial call (usage tracker and `onUsageRecorded` included) and the run returns `{ type: 'stopped', content, iterations, tools, llm: { calls, totals } }`; a reply that lands after abort is recorded and the run still returns `stopped`.
  - `chat:sendMessage` on Stop: appends exactly one assistant message `{ text: <streamed text>, stopped: true, llm }` and sends `chat:messageComplete` with `stopped: true`; nothing from the run is appended afterwards (executor events after Stop are dropped); no advisor review, voice or title call runs. A run only removes its own controller from `activeRuns`. Usage events carry `usagePartial: true` for a cut-off call. Empty stopped replies stay out of the history sent to the next turn. A stopped case turn ends with summary `turn stopped by owner: <message>` and no journal.
  - `createUsageRecordFromMetrics(metrics)` copies `usagePartial`.

- [ ] **Step 1: Write the failing tests**

Create `tests/chat-stop.test.js`:

```js
// tests/chat-stop.test.js
// Stop (spec 2026-09-27 §9, §15): the request is aborted at the provider, the
// streamed text is kept as an assistant message marked stopped, nothing from
// the run is appended after it, and a cut-off call's usage is recorded as
// partial — never as $0.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const ProviderFactory = require('../src/providers/provider-factory');
const { chatHarness } = require('./helpers/chat-harness');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { sumLlmCalls } = require('../src/tracking/llm-totals');
const { partialMetricsOf, isAbortError } = require('../src/providers/abort');

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Stop in chat', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  // Stops the run as soon as the first chunk reaches the renderer.
  function stoppingHarness(options) {
    let h = null;
    let stopping = null;
    h = chatHarness({
      ...options,
      overrides: {
        ...(options.overrides || {}),
        onSend: (channel) => { if (channel === 'chat:messageChunk' && !stopping) stopping = h.stop(); }
      }
    });
    return { h, stopped: () => stopping };
  }

  const anthropic = () => ProviderFactory.create('anthropic', 'sk-ant-test-123456', { baseUrl: `${server.url}/anthropic/v1`, catalog });

  it('a plain reply: aborts the request, keeps the partial text marked stopped, records partial usage', async () => {
    server.setHold(true);
    try {
      const { h, stopped } = stoppingHarness({ provider: anthropic(), providerType: 'anthropic', model: 'claude-haiku-4-5' });
      const before = server.closedCount();
      const result = await h.send({ agentMode: false });
      assert.deepStrictEqual(await stopped(), { ok: true });
      await server.waitForClosedStream(before + 1);
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      const last = h.chat.messages[h.chat.messages.length - 1];
      assert.strictEqual(last.sender, 'assistant');
      assert.strictEqual(last.text, 'Hello');
      assert.strictEqual(last.stopped, true);
      assert.strictEqual(last.llm.calls.length, 1);
      assert.strictEqual(last.llm.calls[0].usagePartial, true);
      assert.strictEqual(last.llm.calls[0].inputTokens, 1200);
      assert.strictEqual(last.llm.calls[0].costUsd, 0.001205);
      assert.strictEqual(last.llm.totals.partial, true);
      assert.deepStrictEqual(h.usage.map((u) => [u.usagePartial, u.costUsd]), [[true, 0.001205]]);
      const complete = h.sent.filter((e) => e.channel === 'chat:messageComplete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual(complete[0].payload.stopped, true);
      assert.strictEqual(complete[0].payload.message, 'Hello');
    } finally {
      server.setHold(false);
    }
  });

  it('a plain reply cut off before the provider reported usage has no cost, not $0', async () => {
    server.setHold(true);
    try {
      const provider = ProviderFactory.create('openai', 'sk-test-123456', { baseUrl: `${server.url}/openai/v1`, catalog });
      const { h } = stoppingHarness({ provider, providerType: 'openai', model: 'gpt-5.5' });
      await h.send({ agentMode: false });
      const last = h.chat.messages[h.chat.messages.length - 1];
      assert.strictEqual(last.stopped, true);
      assert.strictEqual(last.llm.calls[0].costUsd, null);
      assert.strictEqual(last.llm.totals.unpriced, true);
      assert.strictEqual(last.llm.totals.partial, true);
      assert.deepStrictEqual(h.usage.map((u) => [u.usagePartial, u.costUsd]), [[true, null]]);
    } finally {
      server.setHold(false);
    }
  });

  it('an agent-mode reply: the loop stops at the provider and the cut-off call is recorded once', async () => {
    server.setHold(true);
    try {
      const { h } = stoppingHarness({ provider: anthropic(), providerType: 'anthropic', model: 'claude-haiku-4-5' });
      const before = server.closedCount();
      const result = await h.send({ agentMode: true });
      await server.waitForClosedStream(before + 1);
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      const afterUser = h.chat.messages.slice(h.chat.messages.findIndex((m) => m.sender === 'user') + 1);
      assert.deepStrictEqual(afterUser.map((m) => [m.sender, m.text, m.stopped]), [['assistant', 'Hello', true]]);
      assert.strictEqual(afterUser[0].llm.calls[0].usagePartial, true);
      assert.strictEqual(h.usage.length, 1);
      assert.strictEqual(h.usage[0].usagePartial, true);
    } finally {
      server.setHold(false);
    }
  });

  it('a tool that finishes after Stop appends nothing', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inTool = new Promise((resolve) => { entered = resolve; });
    const provider = {
      getProviderName: () => 'openai',
      sendMessageWithTools: async () => ({ type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } }),
      buildToolMessages: (_response, result, id) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
      ]
    };
    const h = chatHarness({
      provider,
      overrides: {
        createToolExecutorWithApprovals: async () => {
          const executor = new EventEmitter();
          executor.allowedDirectories = [];
          executor.execute = async (toolName, parameters) => {
            executor.emit('preExecute', { toolName, parameters });
            entered();
            await gate;
            executor.emit('postExecute', { toolName, result: { ok: true } });
            return { ok: true };
          };
          return executor;
        }
      }
    });
    const sending = h.send({ agentMode: true });
    await inTool;
    assert.deepStrictEqual(await h.stop(), { ok: true });
    release();
    const result = await sending;
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    assert.deepStrictEqual(h.chat.messages.slice(-3).map((m) => m.sender), ['user', 'toolUse', 'assistant']);
    assert.strictEqual(h.chat.messages[h.chat.messages.length - 1].stopped, true);
    assert.ok(!h.chat.messages.some((m) => m.sender === 'toolResult'));
    assert.ok(!h.sent.some((e) => e.channel === 'chat:toolResult'));
  });

  it('a stopped run that finishes late leaves a newer run of the same chat stoppable', async () => {
    const gates = [];
    let calls = 0;
    const provider = {
      getProviderName: () => 'openai',
      sendMessageWithTools: async () => {
        const n = calls++;
        await new Promise((resolve) => { gates[n] = resolve; });
        return { type: 'text', content: `late ${n}` };
      }
    };
    const h = chatHarness({ provider });
    const first = h.send({ agentMode: true, message: 'first' });
    while (!gates[0]) await tick();
    assert.deepStrictEqual(await h.stop(), { ok: true });
    const second = h.send({ agentMode: true, message: 'second' });
    while (!gates[1]) await tick();
    gates[0]();
    await first;
    assert.deepStrictEqual(await h.stop(), { ok: true }, 'the newer run is still registered');
    gates[1]();
    await second;
    assert.strictEqual(h.chat.messages.filter((m) => m.sender === 'assistant' && m.stopped).length, 2);
    assert.ok(!h.chat.messages.some((m) => m.text === 'late 0' || m.text === 'late 1'), 'no reply lands after its run was stopped');
  });

  it('an empty stopped reply stays out of the next turn\'s history', async () => {
    let seen = null;
    const provider = { streamMessage: async (messages) => { seen = messages; return {}; } };
    const chat = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        { id: 'a', sender: 'user', text: 'first question' },
        { id: 'b', sender: 'assistant', text: '', stopped: true },
        { id: 'c', sender: 'assistant', text: 'kept partial', stopped: true }
      ]
    };
    const h = chatHarness({ provider, chat });
    await h.send({ agentMode: false, message: 'second question' });
    assert.deepStrictEqual(seen.map((m) => m.text), ['first question', 'kept partial', 'second question']);
  });

  it('Stop with nothing running says so', async () => {
    const h = chatHarness({ provider: { streamMessage: async () => ({}) } });
    assert.deepStrictEqual(await h.stop(), { ok: false, error: 'No active response for this chat.' });
  });
});

describe('abort helpers and totals', () => {
  it('sums calls, marking partial and unpriced totals', () => {
    assert.deepStrictEqual(sumLlmCalls([
      { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0.001 },
      { inputTokens: 1200, outputTokens: 1, totalTokens: 1201, costUsd: 0.001205, usagePartial: true }
    ]), { inputTokens: 1300, outputTokens: 11, totalTokens: 1311, costUsd: 0.002205, partial: true });
    assert.deepStrictEqual(sumLlmCalls([{ inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: null }]), { inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: 0, unpriced: true });
    assert.deepStrictEqual(sumLlmCalls([]), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  });

  it('knows an abort, and builds an empty partial record when the provider had none', () => {
    assert.strictEqual(isAbortError(new DOMException('aborted', 'AbortError')), true);
    assert.strictEqual(isAbortError(new Error('fetch failed')), false);
    const own = { usagePartial: true, inputTokens: 5 };
    assert.strictEqual(partialMetricsOf(Object.assign(new Error('x'), { partialLlmMetrics: own })), own);
    assert.deepStrictEqual(partialMetricsOf(new Error('x'), { provider: 'openai', model: 'gpt-5.5' }), {
      provider: 'openai', model: 'gpt-5.5', inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, costUsd: null, usagePartial: true
    });
  });
});
```

In `tests/agent-loop.test.js`, the existing test `it('returns stopped between iterations when aborted mid-run', ...)` (lines 236-263) aborts inside the first model call, which returns a `Bash` tool call. After this task a reply that lands after Stop never runs its tools, so rename the test to `it('returns stopped without running a tool the model asked for after Stop', ...)` and change its last assertion from `assert.strictEqual(result.tools.length, 1);` to:

```js
      assert.strictEqual(result.tools.length, 0, 'nothing from the run happens after Stop');
```

(`'abort preserves tool history accumulated before abort'` keeps passing: its first iteration's tool ran before the abort.)

Add to `tests/agent-loop.test.js`, inside `describe('abort signal', ...)` after its second test:

```js
    it('passes the abort signal to every model call', async () => {
      const controller = new AbortController();
      const seen = [];
      const provider = {
        sendMessageWithTools: async (_history, _tools, options) => {
          seen.push(options.abortSignal);
          return { type: 'text', content: 'done' };
        }
      };
      await new AgentLoop(provider, okExecutor(), { abortSignal: controller.signal }).run([], [], { model: 'm' });
      assert.deepStrictEqual(seen, [controller.signal]);
    });

    it('records a call cut off by Stop as partial and returns stopped', async () => {
      const controller = new AbortController();
      const recorded = [];
      const hooked = [];
      const provider = {
        getProviderName: () => 'anthropic',
        sendMessageWithTools: async () => {
          controller.abort();
          throw Object.assign(new DOMException('aborted', 'AbortError'), {
            partialLlmMetrics: { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 1200, outputTokens: 1, totalTokens: 1201, costUsd: 0.001205, usagePartial: true }
          });
        }
      };
      const loop = new AgentLoop(provider, okExecutor(), {
        abortSignal: controller.signal,
        usageTracker: { record: (e) => { recorded.push(e); return { ...e, cost: e.costUsd }; } },
        onUsageRecorded: (e) => hooked.push(e)
      });
      const result = await loop.run([], [], { model: 'claude-haiku-4-5' });
      assert.strictEqual(result.type, 'stopped');
      assert.strictEqual(result.llm.calls.length, 1);
      assert.strictEqual(result.llm.calls[0].usagePartial, true);
      assert.strictEqual(result.llm.totals.partial, true);
      assert.strictEqual(result.llm.totals.costUsd, 0.001205);
      assert.deepStrictEqual(recorded.map((e) => [e.usagePartial, e.costUsd]), [[true, 0.001205]]);
      assert.strictEqual(hooked.length, 1);
    });

    it('records a cut-off call with nothing reported as no cost, never $0', async () => {
      const controller = new AbortController();
      const provider = {
        getProviderName: () => 'openai',
        sendMessageWithTools: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); }
      };
      const result = await new AgentLoop(provider, okExecutor(), { abortSignal: controller.signal }).run([], [], { model: 'gpt-5.5' });
      assert.strictEqual(result.type, 'stopped');
      assert.strictEqual(result.llm.calls[0].costUsd, null);
      assert.strictEqual(result.llm.calls[0].model, 'gpt-5.5');
      assert.strictEqual(result.llm.totals.unpriced, true);
    });

    it('a reply that lands after Stop is recorded, and the turn still stops', async () => {
      const controller = new AbortController();
      const provider = {
        sendMessageWithTools: async () => {
          controller.abort();
          return { type: 'text', content: 'too late', llmMetrics: { provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.0001 } };
        }
      };
      const result = await new AgentLoop(provider, okExecutor(), { abortSignal: controller.signal }).run([], []);
      assert.strictEqual(result.type, 'stopped');
      assert.strictEqual(result.llm.calls.length, 1);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/chat-stop.test.js tests/agent-loop.test.js`
Expected: FAIL (`Cannot find module '../src/tracking/llm-totals'`; the loop does not pass the signal; a stopped reply is saved without `stopped` and with `(Session stopped by user)` or not at all).

- [ ] **Step 3: The helpers**

Create `src/providers/abort.js`:

```js
// src/providers/abort.js
// Telling a Stop apart from a failure, and what a stopped call is recorded as
// (spec 2026-09-27 §9).

function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// The usage the provider had reported before the abort (providers attach it
// as partialLlmMetrics), or, for a call cut off before any response, an
// empty partial record. Never priced as $0: its cost is unknown (null).
function partialMetricsOf(err, { provider = null, model = null } = {}) {
  if (err && typeof err === 'object' && err.partialLlmMetrics) return err.partialLlmMetrics;
  return {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    usagePartial: true
  };
}

module.exports = { isAbortError, partialMetricsOf };
```

Create `src/tracking/llm-totals.js`:

```js
// src/tracking/llm-totals.js
// Totals over one reply's model calls. A call cut off by Stop (usagePartial)
// or one without a known price (costUsd null) marks the totals partial or
// unpriced, so a reply never shows an incomplete cost as complete.
function sumLlmCalls(calls = []) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const totals = list.reduce((acc, call) => ({
    inputTokens: acc.inputTokens + (Number(call.inputTokens) || 0),
    outputTokens: acc.outputTokens + (Number(call.outputTokens) || 0),
    totalTokens: acc.totalTokens + (Number(call.totalTokens) || 0),
    costUsd: Number((acc.costUsd + (Number(call.costUsd) || 0)).toFixed(8))
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  if (list.some((call) => call.usagePartial)) totals.partial = true;
  if (list.some((call) => call.costUsd === null || call.unpriced === true)) totals.unpriced = true;
  return totals;
}

module.exports = { sumLlmCalls };
```

- [ ] **Step 4: The agent loop**

In `src/execution/agent-loop.js`:

1. After `const { createHeadlessPrompter } = require('../platform/prompter');` (line 13) add:

```js
const { partialMetricsOf } = require('../providers/abort');
const { sumLlmCalls } = require('../tracking/llm-totals');
```

2. Replace the abort check at the top of the `while` loop (lines 196-215, `if (this.abortSignal?.aborted) { return { type: 'stopped', ... }; }`) with:

```js
      if (this.abortSignal?.aborted) {
        return this._stoppedResult(iterations, executedTools, llmCalls);
      }
```

3. Replace lines 219-222 (`const effectiveOptions = ...`) with:

```js
      // After the first iteration, switch to the cheaper loop model
      const baseOptions = (iterations > 1 && this.loopModel)
        ? { ...options, model: this.loopModel }
        : options;
      // The run's abort signal rides on every model call, so Stop cancels the
      // request at the provider instead of after it returns (spec 2026-09-27 §9).
      const effectiveOptions = this.abortSignal
        ? { ...baseOptions, abortSignal: this.abortSignal }
        : baseOptions;
```

4. In the provider-call `catch (err) {` (line 276), make the first statements:

```js
        } catch (err) {
          // Stopped mid-call: record what the provider reported so far, then stop.
          if (this.abortSignal?.aborted) {
            this._recordCall(partialMetricsOf(err, {
              provider: this.provider?.getProviderName?.() || null,
              model: effectiveOptions.model || null
            }), llmCalls);
            return this._stoppedResult(iterations, executedTools, llmCalls);
          }
          lastErr = err;
```

(delete the original `lastErr = err;` line that followed the `catch`).

5. Replace `if (lastErr) throw lastErr;` (line 307) with:

```js
      if (!response && this.abortSignal?.aborted) {
        return this._stoppedResult(iterations, executedTools, llmCalls);
      }
      if (lastErr) throw lastErr;
```

6. Replace the whole metrics block (lines 309-335, from `if (response?.llmMetrics) {` to its closing brace) with:

```js
      if (response?.llmMetrics) this._recordCall(response.llmMetrics, llmCalls);

      // A reply that landed after Stop is recorded, but the turn still stops.
      if (this.abortSignal?.aborted) {
        return this._stoppedResult(iterations, executedTools, llmCalls);
      }
```

7. Replace each remaining inline totals reducer with `sumLlmCalls(llmCalls)`: the `const llmTotals = llmCalls.reduce(...)` in the `text` branch (lines 338-346) becomes `const llmTotals = sumLlmCalls(llmCalls);`; in the `guardrail_halt`, `error` and `max_iterations` results, `totals: llmCalls.reduce(...)` becomes `totals: sumLlmCalls(llmCalls)`.

8. After `run()` (before the `_observeForVerification` doc comment) add:

```js
  _stoppedResult(iterations, executedTools, llmCalls) {
    return {
      type: 'stopped',
      content: '(Session stopped by user)',
      iterations,
      tools: executedTools,
      llm: { calls: llmCalls, totals: sumLlmCalls(llmCalls) }
    };
  }

  // Every finished call, and a call cut off by Stop, is recorded (spec §9).
  _recordCall(metrics, llmCalls) {
    llmCalls.push(metrics);

    // Feed token count to API compaction tracker (a partial count would mislead it).
    if (this.useAPICompaction && this.apiCompaction && !metrics.usagePartial) {
      this.apiCompaction.updateTokenCount(metrics);
    }

    if (this.usageTracker && typeof this.usageTracker.record === 'function') {
      const usageEvent = this.usageTracker.record({
        provider: metrics.provider,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        totalTokens: metrics.totalTokens,
        costUsd: metrics.costUsd,
        ...(metrics.usagePartial ? { usagePartial: true } : {})
      });

      if (this.onUsageRecorded) {
        try {
          this.onUsageRecorded(usageEvent);
        } catch {
          // Non-fatal callback failure should never break the agent loop.
        }
      }
    }
  }
```

- [ ] **Step 5: The chat send path**

In `src/ipc/chat-handlers.js`:

1. After `const { NO_RETRY } = require('../cases/roles');` (line 7) add:

```js
const { partialMetricsOf } = require('../providers/abort');
const { sumLlmCalls } = require('../tracking/llm-totals');
```

2. Directly after `const abortController = new AbortController();` (line 332) add:

```js
    let stopped = false;
    let stopFinished = false;
    // A stopped run ends here, once: the streamed text as an assistant
    // message marked stopped, and nothing from the run after it (spec
    // 2026-09-27 §9). No advisor review, voice or title call follows.
    const finishStopped = async () => {
      if (stopFinished) return null;
      stopFinished = true;
      await endCaseTurn({ summary: `turn stopped by owner: ${safeMessage}`, journal: null });
      const stoppedChat = appendMessageToChat(chatId, 'assistant', fullResponse, { llm: llmSummary, stopped: true });
      safeSend(event.sender, 'chat:messageComplete', { chatId, responseId, message: fullResponse, llm: llmSummary, stopped: true });
      return stoppedChat;
    };
```

3. Replace line 379:

```js
      const allContentMessages = chatRaw.messages.filter((m) => m.sender === 'user' || m.sender === 'assistant');
```

with:

```js
      // A stopped reply with no text stays out: an empty assistant turn is
      // rejected by some providers.
      const allContentMessages = chatRaw.messages.filter((m) => (m.sender === 'user' || m.sender === 'assistant')
        && !(m.stopped && !String(m.text || '').trim()));
```

4. Make each executor listener (lines 510-522) return early once the run is stopped — nothing from the run lands after Stop:

```js
      executor.on('preExecute', ({ toolName, parameters }) => {
        if (abortController.signal.aborted) return;
        appendMessageToChat(chatId, 'toolUse', '', { toolName, parameters, runId });
        safeSend(event.sender, 'chat:toolUse', { chatId, runId, toolName, parameters });
      });

      executor.on('postExecute', ({ toolName, result }) => {
        if (abortController.signal.aborted) return;
        appendMessageToChat(chatId, 'toolResult', '', { toolName, result, runId });
        safeSend(event.sender, 'chat:toolResult', { chatId, runId, toolName, result });
      });

      executor.on('toolProgress', ({ toolName, progress }) => {
        if (abortController.signal.aborted) return;
        safeSend(event.sender, 'chat:toolProgress', { chatId, runId, toolName, progress });
      });
```

5. In the agent path, directly after the `const result = await loop.run(chat.messages, toolDefinitions, { ... });` statement (ends line 576), add:

```js
          // Stopped: keep what streamed; the stopped message is appended once, below.
          if (result?.type === 'stopped' || abortController.signal.aborted) {
            stopped = true;
            const stoppedCalls = result?.llm?.calls || [];
            llmSummary = { calls: stoppedCalls, totals: result?.llm?.totals || sumLlmCalls(stoppedCalls) };
            return;
          }
```

and change the `llmSummary = { calls: ..., totals: result?.llm?.totals || llmSummary.totals };` that follows `answerText = fullResponse;` to:

```js
          llmSummary = {
            calls: result?.llm?.calls || [],
            totals: result?.llm?.totals || sumLlmCalls(result?.llm?.calls || [])
          };
```

6. Replace the plain path from `const streamResult = await provider.streamMessage(...)` through the `llmSummary = { calls, totals: calls.reduce(...) };` statement (lines 628-651) with:

```js
          let streamResult = null;
          try {
            streamResult = await provider.streamMessage(chat.messages, { ...options, abortSignal: abortController.signal }, (chunk) => {
              if (abortController.signal.aborted) return;
              fullResponse += chunk;
              safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk });
            });
          } catch (err) {
            if (!abortController.signal.aborted) throw err;
            // Stopped mid-call: keep the usage the provider reported so far.
            streamResult = { llmMetrics: partialMetricsOf(err, { provider: inference.providerType, model: inference.model }) };
          }
          if (abortController.signal.aborted) stopped = true;

          // No advisor review runs on this path, so the model's answer is
          // just the accumulated response.
          answerText = fullResponse;

          const singleCall = streamResult?.llmMetrics || null;
          const calls = singleCall ? [singleCall] : [];
          llmSummary = { calls, totals: sumLlmCalls(calls) };
```

(the usage-tracker block after it stays as it is; it records the partial call too).

7. Replace `activeRuns.delete(chatId);` right after the `withNotificationTiming` call (line 672) with:

```js
      // Only this run's own controller: after a Stop, a newer run of the same
      // chat may already be registered.
      if (activeRuns.get(chatId) === abortController) activeRuns.delete(chatId);
      if (stopped || abortController.signal.aborted) {
        return finishStopped();
      }
```

8. Replace the `catch (error) { ... }` block (lines 700-722, including the Task 9 `reportProviderError` lines) with:

```js
    } catch (error) {
      // An early failure never registered this run; leave another run's controller alone.
      if (activeRuns.get(chatId) === abortController) activeRuns.delete(chatId);
      if (abortController.signal.aborted) {
        return finishStopped();
      }
      await endCaseTurn({ summary: `turn failed: ${error?.message || error}`, journal: null });
      // A 401 or 403 marks the provider unusable at once (spec §5.3).
      if (inference && typeof context.reportProviderError === 'function') {
        context.reportProviderError(inference.providerType, error);
      }
      safeSend(event.sender, 'chat:messageError', {
        chatId,
        responseId,
        error: error.message
      });
      throw error;
    }
```

In `src/core/create-core.js`, `createUsageRecordFromMetrics` becomes:

```js
  const createUsageRecordFromMetrics = (metrics = {}, durationMs = 0) => ({
    provider: metrics.provider,
    model: metrics.model,
    inputTokens: Number(metrics.inputTokens) || 0,
    outputTokens: Number(metrics.outputTokens) || 0,
    totalTokens: Number(metrics.totalTokens) || 0,
    costUsd: typeof metrics.costUsd === 'number' && Number.isFinite(metrics.costUsd) ? metrics.costUsd : null,
    ...(metrics.usagePartial ? { usagePartial: true } : {}),
    durationMs: Number(durationMs) || 0
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/chat-stop.test.js tests/agent-loop.test.js tests/cases-chat.test.js tests/chat-usability.test.js tests/verify-on-stop-integration.test.js tests/tool-guardrails-integration.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/providers/abort.js src/tracking/llm-totals.js src/execution/agent-loop.js src/ipc/chat-handlers.js src/core/create-core.js tests/chat-stop.test.js tests/agent-loop.test.js
git commit -m "feat(chat): Stop aborts the model request, keeps the partial reply marked stopped, and records partial usage"
```

---

## Task 11: Stop for case turns, from the case's chat

In this app the case view is the chat attached to the case: an owner turn started from it runs through `chat:sendMessage` and already has an `activeRuns` controller, but that controller never reached the case turn's own signal, and a wake-up turn running while the owner looks at the case had no cancellation path from the UI at all (only `abortUnattended()` at shutdown). This task adds both, on the same `chat:stopResponse` channel, and shows Stop while any turn runs on the open case.

**Files:**
- Modify: `src/cases/case-runtime.js` — `beginTurn` (after `this.turns.set(fresh.id, turn);`, line 1041), `endTurn`'s `finally` (lines 1084-1087), new `runningTurn` and `abortTurn` after `abortUnattended` (lines 1367-1371)
- Modify: `src/ipc/chat-handlers.js` — after the run state added in Task 10 (link the chat's abort to the case turn); `chat:stopResponse` (lines 741-749)
- Modify: `src/ipc/case-handlers.js` (a `case:runningTurn` channel, after `CASE_ORIENTATION`, line 93), `src/ipc/constants.js` (`CASE_RUNNING_TURN`), `preload.js` (`cases.runningTurn`, after `orientation`, line 838)
- Modify: `renderer.js` — `appState` (line 35), `setResponseActive` (lines 428-439), `handleSelectChat` (lines 7870-7887), the `cases.onChanged` listener (lines 2571-2581)
- Test: `tests/cases-stop.test.js` (new)

**Interfaces:**
- Consumes: `chatHarness()` (Task 9); Task 10's run state in `chat:sendMessage`.
- Produces:
  - `CaseRuntime#runningTurn(caseId) → { turnId, source } | null`; `CaseRuntime#abortTurn(caseId, reason = 'stopped by owner') → boolean` (any source, owner or wake-up).
  - `case:changed` notifications `{ caseId, what: 'turn', running: true|false, source }` when a turn begins and ends.
  - `chat:stopResponse { chatId }`: aborts the chat's own run when there is one; otherwise, for a chat attached to a case, aborts that case's running turn and returns `{ ok: true, caseTurn: true }`; otherwise `{ ok: false, error: 'No active response for this chat.' }`.
  - In a case chat, Stop also aborts the case turn (`turn.abort('stopped by owner')`).
  - `case:runningTurn { caseId }` → `{ ok, running, source }`; `window.electron.cases.runningTurn({ caseId })`.
  - Renderer: `appState.runningCaseTurns: Set<caseId>`; `refreshStopButton()` shows Stop (and hides Send) while the active chat has a response running or its case has a turn running.

- [ ] **Step 1: Write the failing tests**

Create `tests/cases-stop.test.js`:

```js
// tests/cases-stop.test.js
// Stop appears in the case view while a turn runs (spec 2026-09-27 §9): the
// case runtime can report and abort its running turn, the chat's Stop reaches
// the case turn, and Stop on a case chat with no chat run stops a wake-up.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CaseRuntime } = require('../src/cases');
const { chatHarness } = require('./helpers/chat-harness');

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-case-stop-')); dirs.push(d); return d; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('CaseRuntime running turns', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  it('reports, notifies and aborts the running turn, of any source', async () => {
    const events = [];
    const rt = new CaseRuntime({ root: tmp(), host: { notify: (e, p) => events.push([e, p]), interactive: () => true } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    rt.store.updateMeta(info.id, { status: 'active' });
    assert.strictEqual(rt.runningTurn(info.id), null);
    assert.strictEqual(rt.abortTurn(info.id), false);

    const turn = await rt.beginTurn(info.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.deepStrictEqual(rt.runningTurn(info.id), { turnId: 'wakeup-1', source: 'wakeup' });
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.caseId === info.id && p.what === 'turn' && p.running === true && p.source === 'wakeup'));

    assert.strictEqual(rt.abortTurn(info.id, 'stopped by owner'), true);
    assert.strictEqual(turn.signal.aborted, true);
    assert.strictEqual(turn.signal.reason, 'stopped by owner');

    await rt.endTurn(turn, { summary: 'stopped' });
    assert.strictEqual(rt.runningTurn(info.id), null);
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'turn' && p.running === false));

    const owner = await rt.beginTurn(info.id, { turnId: 'turn-1', source: 'owner' });
    assert.strictEqual(rt.abortTurn(info.id), true, 'owner turns too');
    assert.strictEqual(owner.signal.aborted, true);
    await rt.endTurn(owner, { summary: 'stopped' });
  });

  it('answers null and false for a case that does not exist', () => {
    const rt = new CaseRuntime({ root: tmp() });
    assert.strictEqual(rt.runningTurn('no-such-case'), null);
    assert.strictEqual(rt.abortTurn('no-such-case'), false);
  });
});

// A case runtime double for the chat path (like tests/cases-chat.test.js).
function fakeRuntime({ running = null } = {}) {
  const calls = { begin: [], end: [], aborted: [], turnAborts: [] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION', source: opts.source, triggers: [], abort: (reason) => calls.turnAborts.push(reason) };
    },
    runOwnerMessageHooks: async () => ({ notes: [], triggers: [] }),
    caseContext: (turn, extra) => ({ ...turn, ...extra }),
    routedProvider: (_turn, spec) => ({ getProviderName: () => spec.target.provider, sendMessageWithTools: async () => ({}) }),
    usageHook: () => () => {},
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); },
    abortTurn: (caseId, reason) => { calls.aborted.push([caseId, reason]); return Boolean(running); },
    runningTurn: () => running
  };
  return { runtime, calls };
}

describe('Stop on a case chat', () => {
  it('Stop during an owner turn aborts the case turn too, and ends it as stopped', async () => {
    const { runtime, calls } = fakeRuntime();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered = false;
    class WaitingLoop {
      async run() { entered = true; await gate; return { type: 'stopped', content: '', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } }; }
    }
    const chat = { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] };
    const h = chatHarness({
      provider: { sendMessageWithTools: async () => ({}) },
      chat,
      overrides: { getCaseRuntime: () => runtime, AgentLoop: WaitingLoop }
    });
    const sending = h.send({ message: 'What next?' });
    while (!entered) await tick();
    assert.deepStrictEqual(await h.stop(), { ok: true });
    assert.deepStrictEqual(calls.turnAborts, ['stopped by owner']);
    release();
    await sending;
    assert.strictEqual(calls.end.length, 1);
    assert.strictEqual(calls.end[0].summary, 'turn stopped by owner: What next?');
    assert.strictEqual(calls.end[0].journal, null);
    assert.strictEqual(chat.messages[chat.messages.length - 1].stopped, true);
  });

  it('Stop with no chat run stops the case\'s running wake-up turn', async () => {
    const { runtime, calls } = fakeRuntime({ running: { turnId: 'wakeup-1', source: 'wakeup' } });
    const h = chatHarness({ provider: {}, chat: { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => runtime } });
    assert.deepStrictEqual(await h.stop(), { ok: true, caseTurn: true });
    assert.deepStrictEqual(calls.aborted, [['case-1', 'stopped by owner']]);
  });

  it('says there is nothing to stop when neither the chat nor its case is running', async () => {
    const { runtime } = fakeRuntime();
    const h = chatHarness({ provider: {}, chat: { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => runtime } });
    assert.deepStrictEqual(await h.stop(), { ok: false, error: 'No active response for this chat.' });
  });
});

describe('the case view shows Stop while a turn runs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  it('tracks running case turns from case:changed and asks on chat switch', () => {
    assert.match(src, /runningCaseTurns: new Set\(\)/);
    assert.match(src, /payload\?\.what === 'turn'/);
    assert.match(src, /window\.electron\.cases\.runningTurn\(/);
  });

  it('shows Stop for a running case turn through one function', () => {
    assert.match(src, /function refreshStopButton\(\)/);
    assert.match(src, /appState\.runningCaseTurns\.has\(chat\.caseId\)/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-stop.test.js`
Expected: FAIL (`rt.runningTurn is not a function`; the chat's Stop never reaches the case turn; the renderer checks fail).

- [ ] **Step 3: The case runtime**

In `src/cases/case-runtime.js`:

1. In `beginTurn`, directly after `this.turns.set(fresh.id, turn);` add:

```js
        this._notify('case:changed', { caseId: fresh.id, what: 'turn', running: true, source });
```

2. In `endTurn`'s `finally` block, after `this._release(turn.dir, turn.turnId);` add:

```js
      this._notify('case:changed', { caseId: turn.caseId, what: 'turn', running: false, source: turn.source || 'owner' });
```

3. After `abortUnattended(reason = 'shutdown') { ... }` add:

```js
  // The turn running on a case right now: { turnId, source }, or null.
  runningTurn(caseId) {
    let id;
    try {
      id = this.getCase(caseId).id;
    } catch {
      return null;
    }
    const turn = this.turns.get(id);
    return turn ? { turnId: turn.turnId, source: turn.source || 'owner' } : null;
  }

  // Stop from the case's chat (spec 2026-09-27 §9): aborts the running turn,
  // an owner turn or a wake-up. False when no turn runs.
  abortTurn(caseId, reason = 'stopped by owner') {
    let id;
    try {
      id = this.getCase(caseId).id;
    } catch {
      return false;
    }
    const turn = this.turns.get(id);
    if (!turn || typeof turn.abort !== 'function') return false;
    turn.abort(reason);
    return true;
  }
```

- [ ] **Step 4: The chat channels**

In `src/ipc/chat-handlers.js`, directly after the `finishStopped` function added in Task 10, add:

```js
    // In a case chat, Stop also aborts the case turn itself, so its tools and
    // anything reading the turn's own signal stop too.
    if (caseTurn && typeof caseTurn.abort === 'function') {
      const turnToAbort = caseTurn;
      abortController.signal.addEventListener('abort', () => turnToAbort.abort('stopped by owner'), { once: true });
    }
```

Replace the `chat:stopResponse` handler (lines 741-749) with:

```js
  ipcMain.handle(IPC.CHAT_STOP_RESPONSE, wrapHandler(IPC.CHAT_STOP_RESPONSE, async (_event, { chatId }) => {
    const controller = activeRuns.get(chatId);
    if (controller) {
      controller.abort();
      activeRuns.delete(chatId);
      return { ok: true };
    }
    // No run of this chat: a case chat may be watching a wake-up turn on its
    // case, which the owner can stop from here (spec 2026-09-27 §9).
    const chat = getChats().find((item) => item.id === chatId);
    const caseRuntime = chat?.caseId && typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (caseRuntime && typeof caseRuntime.abortTurn === 'function' && caseRuntime.abortTurn(chat.caseId, 'stopped by owner')) {
      return { ok: true, caseTurn: true };
    }
    return { ok: false, error: 'No active response for this chat.' };
  }));
```

In `src/ipc/constants.js`, after `CASE_ORIENTATION: 'case:orientation',` add:

```js
  CASE_RUNNING_TURN: 'case:runningTurn',
```

In `src/ipc/case-handlers.js`, after the `IPC.CASE_ORIENTATION` handler add:

```js
  ipcMain.handle(IPC.CASE_RUNNING_TURN, wrapHandler(IPC.CASE_RUNNING_TURN, async (_event, { caseId } = {}) => {
    const turn = runtime().runningTurn(caseId);
    return { ok: true, running: Boolean(turn), source: turn ? turn.source : null };
  }));
```

In `preload.js`, in the `cases` namespace after `orientation: (payload) => { ... },` add:

```js
      runningTurn: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        return ipcRenderer.invoke('case:runningTurn', payload);
      },
```

- [ ] **Step 5: The renderer shows Stop while the open case runs a turn**

In `renderer.js`:

1. In `appState` after `activeResponses: new Set(),` (line 35) add:

```js
  // Case ids with a turn running now (case:changed, what: 'turn').
  runningCaseTurns: new Set(),
```

2. Replace `setResponseActive` (lines 428-439) with:

```js
// Stop replaces Send while the active chat streams a reply or its case runs a
// turn (an owner turn or a wake-up; spec 2026-09-27 §9).
function refreshStopButton() {
  const chat = getActiveChat();
  const busy = appState.activeResponses.has(appState.activeChatId)
    || Boolean(chat?.caseId && appState.runningCaseTurns.has(chat.caseId));
  if (dom.sendBtn) dom.sendBtn.hidden = busy;
  if (dom.stopBtn) dom.stopBtn.hidden = !busy;
}

function setResponseActive(active, chatId) {
  const id = chatId || appState.activeChatId;
  if (active) {
    appState.activeResponses.add(id);
  } else {
    appState.activeResponses.delete(id);
  }
  refreshStopButton();
  updateChatStreamingIndicators();
}
```

3. In `handleSelectChat`, replace the three lines

```js
  const isStreaming = appState.activeResponses.has(chatId);
  if (dom.sendBtn) dom.sendBtn.hidden = isStreaming;
  if (dom.stopBtn) dom.stopBtn.hidden = !isStreaming;
```

with

```js
  refreshStopButton();
```

and, after `refreshCaseQuestionsBar();` in the same function, add:

```js
  if (chat?.caseId && window.electron?.cases?.runningTurn) {
    window.electron.cases.runningTurn({ caseId: chat.caseId })
      .then((r) => {
        const state = unwrapIpcResult(r, 'Unable to read the case turn.');
        if (state?.running) appState.runningCaseTurns.add(chat.caseId);
        else appState.runningCaseTurns.delete(chat.caseId);
        refreshStopButton();
      })
      .catch((err) => chatLog.warn(`Case turn state failed: ${err.message}`));
  }
```

4. In the `window.electron.cases.onChanged((payload) => { ... })` listener (lines 2572-2580), make the first statements:

```js
    if (payload?.what === 'turn' && payload.caseId) {
      if (payload.running) appState.runningCaseTurns.add(payload.caseId);
      else appState.runningCaseTurns.delete(payload.caseId);
      refreshStopButton();
      return;
    }
```

(The Stop button's click handler already calls `chat.stopResponse(activeChatId)`; the backend now finds the case turn when the chat has no run of its own.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/cases-stop.test.js tests/cases-chat.test.js tests/chat-stop.test.js tests/cases-runtime.test.js tests/cases-runtime-unattended.test.js tests/cases-turn-runner.test.js tests/cases-service-wakeups.test.js tests/ipc-contract.test.js tests/preload-bridge.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/cases/case-runtime.js src/ipc/chat-handlers.js src/ipc/case-handlers.js src/ipc/constants.js preload.js renderer.js tests/cases-stop.test.js
git commit -m "feat(cases): Stop reaches the case turn, and the case chat shows Stop while any turn runs"
```

---

## Task 12: The UI — usable models only, the stopped marker, catalog status and Test all; e2e; CLAUDE.md

**Files:**
- Modify: `renderer.js` — `dom` (after line 120), `renderChatInfoPopover`'s tier handler (lines 3036-3051) and its provider/model section (lines 3052-3190), `renderChatMessages` (lines 3342-3358), `addMessage` (lines 7788-7828), `renderProviderCard` (lines 3755-3765 status, 3784-3785 controls, 3887-3890 actions), the settings loader (line 6810), the provider list click handler (lines 9611-9629); new functions in a `/* --- Models M1 ... --- */` block after `updateProviderStatus` (line 6864)
- Modify: `index.html:224-225` (catalog card above the provider list)
- Modify: `styles.css` (after the `.message-metrics-running` rule, line 1028; after `.chat-info-value`, line 642)
- Modify: `CLAUDE.md` (a `## Models` section after `## Logging`)
- Test: `tests/renderer-models-text.test.js` (new), `tests/e2e/models-stop.test.js` (new), `tests/e2e/inference-tiers.test.js:58-78` (rewrite one test)

**Interfaces:**
- Consumes: `window.electron.models.{ status, refreshCatalog, testAll, usable, explain, setOllamaBaseUrl, onStatusChanged, onCatalogUpdated }` and `settings:load`'s `ollamaBaseUrl` (Task 7); stopped messages `{ stopped: true, llm: { totals: { partial?, unpriced? } } }` (Task 10); `startFakeLlmServer()` with hold mode and the Ollama routes (Task 5); `launchApp`, `closeApp`, `evaluate`, `waitFor` from `tests/e2e/helpers.js`.
- Produces: element ids `chat-info-provider-select`, `chat-info-model-select`, `chat-info-model-note`, `models-catalog-status`, `models-refresh-catalog-btn`, `models-test-all-btn`; class `message-stopped-marker`; the Ollama card's `input[data-ollama-url]` and `button[data-action="save-ollama-url"]`; renderer functions `providerStatusText(status)`, `updateProviderStatusBadge(providerKey)`, `formatCatalogStatus(status)`, `loadModelsCatalogStatus()`, `handleSaveOllamaUrl()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer-models-text.test.js`:

```js
// tests/renderer-models-text.test.js
// Static checks on the renderer for models M1 (spec 2026-09-27 §11, §18):
// the chat info popover lists only usable models, a stopped reply is marked,
// and model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: models M1', () => {
  it('the chat info popover lists usable models, not a hardcoded provider list', () => {
    const popover = block('function renderChatInfoPopover()', '\nfunction ');
    assert.doesNotMatch(popover, /providerDisplayNames/);
    assert.match(popover, /window\.electron\.models\.usable\(/);
    assert.match(popover, /window\.electron\.models\.explain\(/);
    assert.doesNotMatch(popover, /window\.electron\.settings\.listModels\(/);
  });

  it('marks a stopped reply, as text', () => {
    const add = block('function addMessage(sender, text, metadata = {})', '\nasync function loadChats()');
    assert.match(add, /message-stopped-marker/);
    assert.match(add, /metadata\?\.stopped/);
    assert.match(add, /partial usage/);
    assert.match(add, /unpriced/);
  });

  it('keeps a stopped reply with no text visible', () => {
    assert.match(src, /if \(!displayText && !message\.stopped\) return;/);
  });

  it('shows catalog status, Refresh now, Test all and the Ollama address', () => {
    for (const id of ['models-catalog-status', 'models-refresh-catalog-btn', 'models-test-all-btn']) assert.match(html, new RegExp(`id="${id}"`));
    const models = block('/* --- Models M1: catalog status, Test all, the Ollama address --- */', '\nfunction closeContextMenu()');
    assert.doesNotMatch(models, /innerHTML\s*=\s*[^'"\s]/, 'catalog and status text is set with textContent');
    assert.match(src, /dataset\.action = 'save-ollama-url'/);
    assert.match(src, /window\.electron\.models\.onStatusChanged\(/);
  });
});
```

Create `tests/e2e/models-stop.test.js`:

```js
// tests/e2e/models-stop.test.js
// Models M1 end to end (spec 2026-09-27 §16): a fresh profile shows the
// bundled catalog (KL_TEST_MODE keeps the live fetch off), and Stop during a
// streamed reply from a fake provider (Ollama pointed at a local server)
// cancels the request and keeps the partial reply, marked stopped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

describe('E2E: model catalog and Stop', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    server.setHold(true);
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          settings: {
            activeProvider: 'ollama',
            providerModels: { ollama: 'test-model' },
            inference: { activeTier: 'standard', tierMap: { standard: { provider: 'ollama', model: 'test-model' } } },
            models: { ollama: { baseUrl: `${server.url}/ollama` } }
          }
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('a fresh profile shows the bundled snapshot catalog', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    const text = await waitFor(ctx, `(() => { const t = document.getElementById('models-catalog-status')?.textContent || ''; return t.includes('bundled snapshot') ? t : null; })()`);
    assert.match(text, /\d+ models/);
    await evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
  });

  it('Stop during a streamed reply cancels the request and keeps the partial reply, marked stopped', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `(document.querySelector('.message.assistant.streaming .message-content')?.textContent || '').includes('Hello')`, 30000);
    const before = server.closedCount();
    await evaluate(ctx, `document.getElementById('stop-btn').click(); true`);
    await server.waitForClosedStream(before + 1, 10000);
    await waitFor(ctx, `!!document.querySelector('.message.assistant .message-stopped-marker')`, 15000);

    const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
    const chat = data.chats.find((c) => c.id === data.activeChatId) || data.chats[0];
    const last = chat.messages[chat.messages.length - 1];
    assert.strictEqual(last.sender, 'assistant');
    assert.strictEqual(last.text, 'Hello');
    assert.strictEqual(last.stopped, true);
    assert.strictEqual(last.llm.calls[0].usagePartial, true);
    assert.strictEqual(last.llm.calls[0].costUsd, null);
    const sendVisible = await evaluate(ctx, `!document.getElementById('send-btn').hidden`);
    assert.strictEqual(sendVisible, true, 'Send comes back after Stop');
  });
});
```

In `tests/e2e/inference-tiers.test.js`, replace the test `it('provider dropdown includes new providers', ...)` (lines 58-78) with:

```js
  it('the provider list offers only usable providers', async () => {
    await waitFor(ctx, `(document.getElementById('chat-info-provider-select')?.options.length || 0) > 0`);
    const options = await evaluate(ctx, `
      Array.from(document.getElementById('chat-info-provider-select').options).map((o) => o.textContent)
    `);
    // A fresh profile has no tested provider: the only entries are the
    // current tier's provider, marked, or the hint to add a key.
    for (const text of options) {
      assert.ok(/not usable|No usable provider/.test(text), `a fresh profile offered a usable provider: ${text}`);
    }
  });
```

and add `waitFor` to its `require('./helpers')` import if it is not there.

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `node --test tests/renderer-models-text.test.js`
Expected: FAIL (`providerDisplayNames` still present; no stopped marker; no catalog card).

- [ ] **Step 3: The catalog card in `index.html`**

Replace lines 224-225:

```html
        <div class="settings-tab-content active" data-tab="providers">
          <div class="provider-list" id="provider-list"></div>
```

with:

```html
        <div class="settings-tab-content active" data-tab="providers">
          <section class="template-variables-card" id="models-catalog-card">
            <h3>Model catalog</h3>
            <p>Prices and capabilities for every model come from a catalog bundled with King Louie and refreshed daily from models.dev.</p>
            <div class="provider-message" id="models-catalog-status">Reading the catalog…</div>
            <div class="provider-actions">
              <button type="button" class="btn" id="models-refresh-catalog-btn"><i class="fas fa-rotate"></i> Refresh now</button>
              <button type="button" class="btn" id="models-test-all-btn"><i class="fas fa-plug"></i> Test all</button>
            </div>
          </section>
          <div class="provider-list" id="provider-list"></div>
```

- [ ] **Step 4: The renderer**

1. In `const dom = { ... }`, after `providerList: document.getElementById('provider-list'),` (line 120) add:

```js
  modelsCatalogStatus: document.getElementById('models-catalog-status'),
  modelsRefreshCatalogBtn: document.getElementById('models-refresh-catalog-btn'),
  modelsTestAllBtn: document.getElementById('models-test-all-btn'),
```

2. In `renderChatInfoPopover`, in the tier `change` handler (lines 3036-3051) replace

```js
      if (providerSelect) providerSelect.value = newInfo.provider || 'openai';
      if (populateModels) populateModels(newInfo.provider || 'openai', newInfo.model || '');
```

with

```js
      loadUsable(newInfo.provider || '', newInfo.model || '');
```

3. Replace the provider and model section — from `// Provider row (dropdown)` (line 3052) through `populateModels(tierInfo.provider || 'openai', tierInfo.model || '');` (line 3190) — with:

```js
  /* The provider and model lists hold only usable models (spec 2026-09-27
     §5, stage M1): a passing connection test, in this account's list, and
     able to call tools in agent mode. The current tier target always shows,
     marked with why it cannot be used. */
  const providerRow = document.createElement('div');
  providerRow.className = 'chat-info-row';
  const providerLabel = document.createElement('span');
  providerLabel.className = 'chat-info-label';
  providerLabel.appendChild(faIcon('fas fa-plug'));
  providerLabel.appendChild(document.createTextNode('Provider'));
  const providerSelect = document.createElement('select');
  providerSelect.className = 'chat-info-select';
  providerSelect.id = 'chat-info-provider-select';
  providerRow.appendChild(providerLabel);
  providerRow.appendChild(providerSelect);
  dom.chatInfoPopoverBody.appendChild(providerRow);

  const modelRow = document.createElement('div');
  modelRow.className = 'chat-info-row';
  const modelLabel = document.createElement('span');
  modelLabel.className = 'chat-info-label';
  modelLabel.appendChild(faIcon('fas fa-microchip'));
  modelLabel.appendChild(document.createTextNode('Model'));
  const modelSelect = document.createElement('select');
  modelSelect.className = 'chat-info-select';
  modelSelect.id = 'chat-info-model-select';
  modelRow.appendChild(modelLabel);
  modelRow.appendChild(modelSelect);
  dom.chatInfoPopoverBody.appendChild(modelRow);

  const modelNote = document.createElement('div');
  modelNote.className = 'chat-info-note';
  modelNote.id = 'chat-info-model-note';
  dom.chatInfoPopoverBody.appendChild(modelNote);

  const providerLabelOf = (key) => appState.settings?.providers?.[key]?.label || key;
  const popoverNeeds = () => (appState.isAgentModeEnabled ? { toolCall: true } : {});
  let usableModels = [];
  let usableFetchId = 0;

  // Why the current target cannot be used, if it cannot.
  const showCurrentVerdict = async (provider, model) => {
    modelNote.textContent = '';
    if (!provider) return;
    try {
      const verdict = unwrapIpcResult(
        await window.electron.models.explain({ provider, model: model || '', needs: popoverNeeds() }),
        'Unable to check the model.'
      );
      if (!verdict.usable) modelNote.textContent = verdict.reasons.join(' ');
    } catch (err) { modelLog.debug(`explain failed: ${err.message}`); }
  };

  const fillModels = (provider, selectedModel) => {
    modelSelect.innerHTML = '';
    let hasSelected = false;
    for (const m of usableModels.filter((c) => c.provider === provider)) {
      const opt = document.createElement('option');
      opt.value = m.model;
      opt.textContent = m.priced || m.local ? m.name : `${m.name} (unpriced)`;
      if (m.model === selectedModel) { opt.selected = true; hasSelected = true; }
      modelSelect.appendChild(opt);
    }
    if (selectedModel && !hasSelected) {
      const opt = document.createElement('option');
      opt.value = selectedModel;
      opt.textContent = `${selectedModel} (current, not usable)`;
      opt.selected = true;
      modelSelect.insertBefore(opt, modelSelect.firstChild);
    }
    modelSelect.disabled = modelSelect.options.length === 0;
  };

  const fillProviders = (currentProvider) => {
    providerSelect.innerHTML = '';
    const providers = [...new Set(usableModels.map((m) => m.provider))];
    for (const key of providers) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = providerLabelOf(key);
      if (key === currentProvider) opt.selected = true;
      providerSelect.appendChild(opt);
    }
    if (currentProvider && !providers.includes(currentProvider)) {
      const opt = document.createElement('option');
      opt.value = currentProvider;
      opt.textContent = `${providerLabelOf(currentProvider)} (not usable)`;
      opt.selected = true;
      providerSelect.insertBefore(opt, providerSelect.firstChild);
    }
    if (providerSelect.options.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No usable provider: add and test a key in Settings';
      opt.disabled = true;
      opt.selected = true;
      providerSelect.appendChild(opt);
    }
  };

  const loadUsable = async (currentProvider, currentModel) => {
    const fetchId = ++usableFetchId;
    try {
      const result = unwrapIpcResult(
        await window.electron.models.usable({ needs: { textOutput: true, ...popoverNeeds() } }),
        'Failed to list usable models.'
      );
      if (fetchId !== usableFetchId) return;
      usableModels = Array.isArray(result.models) ? result.models : [];
    } catch (err) {
      if (fetchId !== usableFetchId) return;
      usableModels = [];
      modelLog.warn(`usable models failed: ${err.message}`);
    }
    fillProviders(currentProvider);
    fillModels(currentProvider, currentModel);
    showCurrentVerdict(currentProvider, currentModel);
  };

  // Provider change → its first usable model, persisted to the active tier.
  providerSelect.addEventListener('change', async () => {
    const prevProvider = tierInfo.provider || '';
    const newProvider = providerSelect.value;
    fillModels(newProvider, '');
    const newModel = modelSelect.value || '';
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setTierProviderModel({
          tier: tierSelect.value, provider: newProvider, model: newModel
        }),
        'Failed to update provider.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();
      showCurrentVerdict(newProvider, newModel);
      addStatusMessage(`Provider changed: ${prevProvider || '(none)'} → ${newProvider}`);
    } catch (err) { providerLog.warn(`failed: ${err.message}`); }
  });

  // Model change → persist.
  modelSelect.addEventListener('change', async () => {
    const prevModel = tierInfo.model || '';
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setTierProviderModel({
          tier: tierSelect.value, model: modelSelect.value
        }),
        'Failed to update model.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();
      showCurrentVerdict(providerSelect.value, modelSelect.value);
      addStatusMessage(`Model changed (${providerSelect.value}): ${prevModel || '(default)'} → ${modelSelect.value || '(default)'}`);
    } catch (err) { modelLog.warn(`failed: ${err.message}`); }
  });

  loadUsable(tierInfo.provider || '', tierInfo.model || '');
```

4. In `renderChatMessages`, replace `if (!displayText) return; // message was entirely tool blocks` with:

```js
      if (!displayText && !message.stopped) return; // message was entirely tool blocks
```

and add `stopped: message?.stopped,` to the metadata object passed to `addMessage(message.sender, displayText, { ... })` (after `llm: message?.llm,`).

5. In `addMessage`, directly before `if (sender === 'assistant' && metadata?.llm?.totals) {` add:

```js
  // A reply cut off by Stop keeps its text and says so (spec 2026-09-27 §9).
  if (sender === 'assistant' && metadata?.stopped) {
    const marker = document.createElement('div');
    marker.className = 'message-stopped-marker';
    marker.appendChild(faIcon('fas fa-circle-stop'));
    marker.appendChild(document.createTextNode(' Stopped'));
    messageContent.appendChild(marker);
  }
```

and after the `if (runningTotals) { ... }` block inside the metrics section add:

```js
    if (callTotals.partial) callSpan.textContent += ' · partial usage';
    if (callTotals.unpriced) callSpan.textContent += ' · includes unpriced calls';
```

6. In `renderProviderCard`, replace the status block (lines 3755-3765):

```js
  const status = document.createElement('span');
  status.className = 'provider-status';
  if (provider.status?.ok) {
    ...
  } else {
    status.textContent = 'Not tested';
  }
```

with:

```js
  const status = document.createElement('span');
  status.className = 'provider-status';
  const statusView = providerStatusText(provider.status);
  if (statusView.cls) status.classList.add(statusView.cls);
  status.textContent = statusView.text;
  if (provider.status?.checkedAt) status.title = `Last tested ${new Date(provider.status.checkedAt).toLocaleString()}`;
```

After `controls.appendChild(input);` (line 3785) add:

```js
  // The Ollama address (models.ollama.baseUrl, spec 2026-09-27 §5.4).
  if (providerKey === 'ollama') {
    const addressLabel = document.createElement('label');
    addressLabel.textContent = 'Ollama address';
    const addressInput = document.createElement('input');
    addressInput.className = 'provider-input';
    addressInput.type = 'text';
    addressInput.dataset.ollamaUrl = 'true';
    addressInput.value = appState.settings.ollamaBaseUrl || '';
    addressInput.placeholder = 'http://127.0.0.1:11434';
    controls.appendChild(addressLabel);
    controls.appendChild(addressInput);
  }
```

After `actions.appendChild(clearBtn);` (line 3890) add:

```js
  if (providerKey === 'ollama') {
    const addressBtn = document.createElement('button');
    addressBtn.type = 'button';
    addressBtn.className = 'btn';
    addressBtn.appendChild(faIcon('fas fa-location-dot'));
    addressBtn.appendChild(document.createTextNode(' Save address'));
    addressBtn.dataset.action = 'save-ollama-url';
    addressBtn.dataset.provider = providerKey;
    actions.appendChild(addressBtn);
  }
```

7. After `updateProviderStatus` (ends line 6864) add:

```js
/* --- Models M1: catalog status, Test all, the Ollama address --- */

function providerStatusText(status) {
  if (status?.ok) return { text: 'Connected', cls: 'ok' };
  if (status?.authFailed) return { text: 'Key rejected', cls: 'error' };
  if (status) return { text: 'Error', cls: 'error' };
  return { text: 'Not tested', cls: '' };
}

// A background retest (key saved, 401 during use) updates the badge only, so
// a message the owner is reading on the card stays.
function updateProviderStatusBadge(providerKey) {
  const card = dom.providerList?.querySelector(`.provider-card[data-provider="${providerKey}"]`);
  const badge = card?.querySelector('.provider-status');
  if (!badge) return;
  const status = appState.settings?.providers?.[providerKey]?.status || null;
  const view = providerStatusText(status);
  badge.classList.remove('ok', 'error');
  if (view.cls) badge.classList.add(view.cls);
  badge.textContent = view.text;
  badge.title = status?.checkedAt ? `Last tested ${new Date(status.checkedAt).toLocaleString()}` : '';
}

function formatCatalogStatus(status) {
  if (!status) return 'Catalog status unavailable.';
  const when = status.fetchedAt || status.snapshotDate;
  const date = when ? new Date(when).toLocaleDateString() : 'unknown date';
  const source = { live: 'models.dev, fetched now', cache: 'cached copy of models.dev', snapshot: 'bundled snapshot' }[status.source] || String(status.source);
  const stale = status.stale ? ' This copy is old: press Refresh now, or check the network.' : '';
  return `Source: ${source}, ${date}. ${status.models} models.${stale}`;
}

function showCatalogStatus(status) {
  if (!dom.modelsCatalogStatus) return;
  dom.modelsCatalogStatus.textContent = formatCatalogStatus(status);
  dom.modelsCatalogStatus.classList.toggle('error', Boolean(status?.stale));
}

async function loadModelsCatalogStatus() {
  if (!dom.modelsCatalogStatus || !window.electron?.models) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.status(), 'Unable to read the catalog.');
    showCatalogStatus(result.catalog);
  } catch (err) {
    dom.modelsCatalogStatus.textContent = err.message;
    dom.modelsCatalogStatus.classList.add('error');
  }
}

async function handleSaveOllamaUrl() {
  const input = dom.providerList.querySelector('input[data-ollama-url]');
  const value = (input?.value || '').trim();
  setProviderMessage('ollama', 'Saving the address and testing Ollama…');
  try {
    const result = unwrapIpcResult(await window.electron.models.setOllamaBaseUrl(value), 'Unable to save the Ollama address.');
    appState.settings.ollamaBaseUrl = result.baseUrl;
    updateProviderStatus('ollama', result.status);
    setProviderMessage(
      'ollama',
      result.status?.ok ? `Address saved. ${result.status.message}` : `Address saved, but Ollama did not answer: ${result.status?.error || 'unknown error'}`,
      !result.status?.ok
    );
  } catch (err) {
    setProviderMessage('ollama', err.message, true);
  }
}

if (dom.modelsRefreshCatalogBtn) {
  dom.modelsRefreshCatalogBtn.addEventListener('click', async () => {
    dom.modelsRefreshCatalogBtn.disabled = true;
    if (dom.modelsCatalogStatus) dom.modelsCatalogStatus.textContent = 'Refreshing the catalog…';
    try {
      const result = unwrapIpcResult(await window.electron.models.refreshCatalog(), 'Catalog refresh failed.');
      showCatalogStatus(result.catalog);
    } catch (err) {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = err.message;
        dom.modelsCatalogStatus.classList.add('error');
      }
    } finally {
      dom.modelsRefreshCatalogBtn.disabled = false;
    }
  });
}

if (dom.modelsTestAllBtn) {
  dom.modelsTestAllBtn.addEventListener('click', async () => {
    dom.modelsTestAllBtn.disabled = true;
    try {
      const result = unwrapIpcResult(await window.electron.models.testAll(), 'Test all failed.');
      for (const [provider, status] of Object.entries(result.providers || {})) {
        if (appState.settings?.providers?.[provider]) appState.settings.providers[provider].status = status;
      }
      renderSettings();
    } catch (err) {
      chatLog.warn(`Test all failed: ${err.message}`);
    } finally {
      dom.modelsTestAllBtn.disabled = false;
    }
  });
}

if (window.electron?.models?.onStatusChanged) {
  window.electron.models.onStatusChanged(({ provider, status } = {}) => {
    const entry = appState.settings?.providers?.[provider];
    if (!entry) return;
    entry.status = status || null;
    updateProviderStatusBadge(provider);
  });
}

if (window.electron?.models?.onCatalogUpdated) {
  window.electron.models.onCatalogUpdated((status) => showCatalogStatus(status));
}
```

8. In the settings loader, after `loadMeshStatus().catch(() => {});` (line 6810) add:

```js
    loadModelsCatalogStatus().catch(() => {});
```

9. In the `dom.providerList.addEventListener('click', ...)` handler (lines 9611-9629), after the `set-active` branch add:

```js
    if (action === 'save-ollama-url') {
      handleSaveOllamaUrl();
    }
```

- [ ] **Step 5: Styles**

In `styles.css`, after the `.message-metrics-call, .message-metrics-running { ... }` rule (line 1028) add:

```css
.message-stopped-marker {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
```

After the `.chat-info-value { ... }` rule (line 642) add:

```css
.chat-info-note {
  font-size: 11px;
  color: var(--text-muted);
  padding: 0 0 6px;
}

.chat-info-note:empty {
  display: none;
}
```

- [ ] **Step 6: CLAUDE.md**

After the `## Logging` section add:

```markdown
## Models

`src/models/` holds the model catalog and provider availability (spec:
`docs/superpowers/specs/2026-09-27-model-catalog-profiles-roles-design.md`,
stage M1). It is Electron-free.

- Prices come only from `Catalog.price`; providers have no price tables. An
  unknown model is unpriced (`costUsd: null`), never $0. A call cut off by
  Stop is recorded with `usagePartial: true`.
- The bundled catalog is `src/models/snapshot/` (models.dev trimmed to the 14
  providers, plus Artificial Analysis scores from OpenRouter). Regenerate it
  before each release with `npm run models:snapshot` (needs the network).
- Unit tests never touch the network: inject `fetch`, point providers at
  `tests/helpers/fake-llm-server.js`, and price with the fixture catalog
  (`tests/helpers/models-fixture.js`, data in `tests/fixtures/models/`).
- The catalog refresh and the stale-provider retests start from the host
  (`core.models.startBackgroundChecks()` in `main.js` and `runService`), not
  from `createCore().start()`, and are skipped when `KL_TEST_MODE` is set.
- Every provider request goes through `BaseProvider.request(url, init,
  options)`, which carries `options.abortSignal`; never call `fetch` directly
  in a provider.
- `npm run smoke:providers` streams a reply and makes one tool call against
  each provider whose key is in the environment (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, …; `KL_SMOKE_MODEL_<PROVIDER>` picks a model). It
  spends a little real money and is not part of `npm test`.
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/renderer-models-text.test.js tests/renderer-sources-text.test.js tests/renderer-playbooks-text.test.js tests/ipc-contract.test.js`
Expected: PASS, `# fail 0`.

Run: `npm test`
Expected: `# fail 0`.

Run the e2e suites this task touches (they launch Electron; from an agent shell `ELECTRON_RUN_AS_NODE` must be removed, per CLAUDE.md):

```bash
unset ELECTRON_RUN_AS_NODE && node --test --test-concurrency=1 --test-timeout=120000 tests/e2e/models-stop.test.js tests/e2e/inference-tiers.test.js tests/e2e/chat-basics.test.js tests/e2e/settings-providers-save.test.js tests/e2e/cases.test.js
```

Expected: PASS. Then the whole e2e suite: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` — expected PASS.

- [ ] **Step 8: Commit**

```bash
git add renderer.js index.html styles.css CLAUDE.md tests/renderer-models-text.test.js tests/e2e/models-stop.test.js tests/e2e/inference-tiers.test.js
git commit -m "feat(ui): usable models only in the chat popover, stopped replies marked, catalog status and Test all"
```

---

