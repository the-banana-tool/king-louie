# Recall: the Hosted Jev Reranker, and LongHaul's Quota Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) An opt-in hosted reranker for chat-history recall, `history.recall.rerank.kind: 'local' | 'jev'` (default `'local'`), that sends the query and the top `rerank.topM` chunks to typesafe.ai's Jev and serves `SearchHistory` and, when `rerank.enabled`, every turn; a Jev failure never fails a turn. (B) A LongHaul run stops on a provider refusal that means "out of credit or quota" (`QUOTA`, exit 2, `spend.json` `stoppedBy: 'QUOTA'`) instead of recording one failed item per question. LongHaul gets `kl-recall-jev-rerank` / `kl-recall-vec-jev-rerank` on the app's own Jev client, and the last task measures Jev against the shipped path, with and without whole messages.

**Architecture:** One HTTP client, `TypesafeProvider` (`src/providers/typesafe-provider.js`), a decide-only provider extending `BaseProvider`: every request goes through `BaseProvider.request` with `options.abortSignal`; it is not registered with `ProviderFactory`, not one of the 14 catalog providers, has no catalog entry (unpriced, `costUsd: null`) and is never offered as a chat model. One scorer, `src/history/jev-rerank.js`: the probe's batched and pointwise `noul` request shapes, the group planner held under Jev's 32K-token state cap, a concurrency limiter; it sends nothing itself (it takes an `ask` transport). The app's `JevReranker` (`src/history/jev-reranker.js`) adds the key, the start gate (`startHistoryEmbedding` only, never under `KL_TEST_MODE`), the abort at `maxMs`, the hold-offs after a refusal or a 429/529, and one owner-visible warning per failure episode. `createRecallReranker` (`src/history/reranker.js`) dispatches each rerank call on `rerank.kind` to the local cross-encoder or to Jev; the Retriever records which ran (`reranker`) or why none did (`rerankSkipped`), and provenance carries both. The key is stored like the ElevenLabs key: `apiTokens.__typesafe_api_key` in the store, encrypted by the core's cipher. LongHaul's `src/longhaul/jev.js` wraps the same provider and scorer with retries, a token cap, the served-model check and counts. Part B is a narrow `isQuotaFailure` in `src/longhaul/retry.js`, read from what `ProviderError` already carries (status, `type`, `code`, message).

**Tech Stack:** Node 22+ (`fetch`, `AbortSignal.timeout`, `AbortSignal.any`), `node:test`, `node:http` (loopback fakes), `node:sqlite` through `HistoryStore`, Electron 41 renderer (the settings pane), LongHaul (`bin/longhaul.js`).

**Spec:** `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md` §6.3 step 6 (rerank), §6.7 (measurements: the "Jev hosted rerank, batched, topM 100 (probe)" row and the "Hosted rerank" finding), §7 (provenance), §14 (settings), §15 (failures). `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` §7 (the B0/H3/B3 addenda), §15 (error handling), §18 (first results: "A quota refusal arrives as HTTP 429 and was retried and recorded per item like a rate limit; it should stop the run as a refused key does (follow-up)"). Measured facts: `.superpowers/sdd/plans-2026-09-30-measured-facts.md`, section "Jev rerank probe" (numbers only). The probe this ports: branch `origin/exp/jev-rerank` at `93d38e9` (`src/longhaul/jev.js`, `src/longhaul/adapters/kl-recall-jev-rerank.js`, `tests/helpers/fake-jev-server.js`, `tests/longhaul-jev.test.js`); it is ported, never merged (main has moved: B3 rewrote `run.js` and `commands/run.js`, and `withRetries`, `EMBEDDINGS_MISSING`, `createRunnerScorer` are new). Terms follow `CONTEXT.md` (chunk, excerpt, recall vs retrieval, provenance, evidence recall).

**The Jev API (docs.typesafe.ai):** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, JSON `{ model: "jev-latest", state, questions: { <id>: { type: "noul", instructions, criteria } } }` → `{ model, answers: { <id>: { type, noul } }, usage: { input_tokens, output_tokens } }`. Errors 401, 422, 429, 529 (back off on 429/529). `jev-1.13.0`: 32K tokens of state per request (64K total), 40 requests/s, 100K tokens/s, input billed by the token, output free.

## Global Constraints

- Tests use node's built-in runner, never `jest`: `node --test tests/<file>.test.js`; look for `# fail 0`. **Never run the full `npm test`** (the owner says it is broken for unrelated reasons). Each task runs its own test files, then the sweep: `node --test tests/history-*.test.js tests/longhaul-*.test.js tests/renderer-history-*.test.js tests/electron-boundary.test.js tests/fake-embedder.test.js` (Tasks 1 and 2 add `tests/providers-*.test.js`). A sweep failure in a file the task did not touch is reported, not fixed.
- **No network in unit tests.** Jev is faked by `tests/helpers/fake-jev-server.js` (Task 2) on `127.0.0.1`; model providers by recorded response shapes or scripted clients. Nothing is ever sent to typesafe.ai from a test.
- **Opt-in only (ruling 1).** `rerank.kind` defaults to `'local'`; with `'local'` nothing reaches typesafe.ai, whether or not a key is saved. Choosing `'jev'` in the pane needs the "Allow sending to typesafe.ai" control ticked; the IPC refuses the switch without it. Nothing is sent under `KL_TEST_MODE`, and the hosted reranker starts only from `startHistoryEmbedding` (called by `startModelsBackgroundChecks`, which returns early under `KL_TEST_MODE`).
- Everything under `src/` stays Electron-free except `src/ipc/` (`tests/electron-boundary.test.js`). LongHaul may use `src/history/` and `src/providers/`; nothing outside `src/longhaul/` requires it (`tests/longhaul-boundary.test.js`).
- Every provider request goes through `BaseProvider.request` with `options.abortSignal` (`tests/providers-request-helper.test.js` reads every `*-provider.js`).
- Log through `createLogger` (`src/logging.js`), never bare `console.*`. No log line, error message, record, warning or provenance field carries chat, session, query or candidate text: Jev errors carry the HTTP status and a short error code only (a 422 body can echo the state).
- **Prices come only from `Catalog.price`. Jev is not in the catalog:** its calls are unpriced (`costUsd: null`, shown as "price unknown"), never `$0`; input tokens from `usage.input_tokens` are counted and shown. No price table is added anywhere.
- Renderer text from the host is set with `textContent`, never `innerHTML`. The key is never returned to the renderer.
- Open source: invented fixture values only (`Lakeside lot`, `4417`, `test-key-not-real-0001`, `*.example.com`, `192.0.2.x`). Never read `~/.longhaul`, `~/.claude`, `C:\Users\sblac\Programming\long-haul` or any key file; spec §6.7 gets numbers only.
- Vault tool calls and results make no chunks (`UNINDEXED_TOOLS`), so they are never rerank candidates and never sent to Jev (pinned by a Task 6 test).
- A Jev failure, timeout or missing key keeps the fused order for that turn or search, with one owner-visible warning per failure episode and a provenance note; it never fails a turn.

## Review Focus

1. **A candidate set over Jev's 32K-token state cap** (100 chunks at 1,500 characters is about 50K tokens; a pasted 200K-character message as the query or as a chunk). Expected: the planner splits candidates into groups each under 28K estimated tokens (3 characters a token over the JSON-escaped text, so dense text still fits under 32K), cuts a query longer than 2,000 tokens and any candidate too long to fit a group alone, and keeps every candidate's score in its place. No planned request is refused 422. Pinned: Task 3 (the fake server refuses state over 32K, proven with an uncut request; every planned group of the oversized set is answered 200 and every score lands in order).
2. **A slow or hung Jev call on the send path, against `rerank.maxMs` (2,000).** Expected: the turn waits at most `maxMs` (the Retriever's race), the request is aborted at the provider at the same `maxMs` so it stops running and billing, the fused order is kept, provenance says "the reranker took longer than rerank.maxMs (N ms)", and the owner gets one warning for the episode. Pinned: Task 5 (the Retriever's note), Task 6 (abort at `maxMs`, the fake server sees the connection dropped, one warning, the next success ends the episode; the per-turn path through the Retriever returns promptly).
3. **The key missing, or revoked mid-session.** Expected: no key: nothing is sent, provenance says "no typesafe.ai key is saved", one warning. A 401/403 (or 402, out of credit): Jev is paused with one warning and sends nothing more until a new key is saved or Retry is pressed; a 429/529 holds it off for the server's retry-after (30 s without one). Pinned: Task 6 (pause, silence, resume on `reset()`; hold-off by the injected clock), Task 7 (saving a key through the core resets a paused Jev).
4. **The model or the kind switched while a rerank is in flight** (the owner saves `kind: 'local'`, saves a new key, or a newer Jev model answers). Expected: the call in flight finishes or fails for its own query only; a failure that lands after the switch changes no state and raises no warning; the provenance name comes from the model the response names (`jev:<served model>`), not from the setting. Pinned: Task 6 (a 401 landing after a switch to local, and after a key change, leaves Jev `ready` with no warning; the new key is used next).
5. **Private text reaching Jev without the opt-in, or under `KL_TEST_MODE`.** Expected: with `kind: 'local'` and a key saved, nothing is sent; the IPC refuses saving `'jev'` without `confirmJev`; under `KL_TEST_MODE` the core never starts the hosted reranker and the reranker itself refuses before any request; Vault text is never a candidate. Pinned: Task 6 (dispatcher with kind local sends nothing; `KL_TEST_MODE` sends nothing; Vault secret absent from every request), Task 7 (IPC confirmation; a core under `KL_TEST_MODE` sends nothing on a turn with `kind: 'jev'` and a key saved).

---

## Seams this plan builds on

Actual names on `main` (`0a7cdfe`), read from the code:

| Seam | Where | Used by |
|---|---|---|
| `BaseLLMProvider` (exported as the module): `constructor(apiKey, { catalog, authMode })` validates the key (`validateApiKey`: a string of at least 8 characters, else `Invalid API key`); `static baseUrlFrom(options, fallback)`; `request(url, init, { abortSignal, model })` puts the signal on `fetch` and turns an abort into an `AbortError` with `partialLlmMetrics`; `getHeaders()` (`Content-Type: application/json`, `Authorization: Bearer <key>`); `buildLlmCallMetrics({ model, usage })` (unknown model: `costUsd: null`, `unpriced: true`); `buildError(response, details)` reads the body once and calls `buildProviderError` | `src/providers/base-provider.js` | Tasks 1, 2 |
| `buildProviderError(response, message, { provider, body, model })` → `ProviderError { status, statusText, provider, model, retryAfterMs (Retry-After header, else a "try again in" hint in the message), code (body.error.code), type (body.error.type), requestId }` | `src/providers/provider-error.js` | Tasks 1, 2 |
| The stream paths throw the `ProviderError` unchanged: `OpenAIProvider` `throw providerError` after `buildError` (~line 679), `AnthropicProvider` `throw await this.buildError(response)` (~line 274); `oneShot` and LongHaul's `createModelClient.complete` pass it through | `src/providers/openai-provider.js`, `anthropic-provider.js`, `one-shot.js`, `src/longhaul/model.js` | Task 1 |
| `classifyError` BILLING markers include the bare word `billing`, which an OpenAI rate-limit message can contain ("…adding a payment method at …/account/billing") | `src/providers/error-classifier.js` | Task 1 (why it is not reused) |
| `ProviderFactory.registerProvider` / `listRegistered()`: the 14 providers; `fromEnv` | `src/providers/provider-factory.js` | Task 2 (Jev is not registered) |
| `providerFiles()` = every `*-provider.js` but `base-provider.js`; three guards: no direct `fetch(`, every streaming method through `guardStream` (asserts `streams > 0`), `async listModels(options = {})` | `tests/providers-request-helper.test.js` | Task 2 |
| `retryable(err)` (429, 5xx, transport), `isAuthFailure` (401/403), `callErrorCode`, `authStopError(provider, status, forWhat)` → `UsageError(…, 'AUTH')`, `withRetries(fn, { retries = 3, baseDelayMs = 1000, wait, onRetry })` | `src/longhaul/retry.js` | Tasks 1, 9 |
| `cachedCall` stores an entry only after the call succeeds; a failed call is `hooks.cancel(ticket)`ed | `src/longhaul/model-cache.js` | Task 1 |
| `answerAndJudge`'s `failed(stage, err)`: `if (isAuthFailure(err)) throw authStopError(…)` | `src/longhaul/answer-stage.js` ~line 64 | Task 1 |
| `runAnswerStage`: pass 2a summarizer `catch`: `if (isAuthFailure(err)) throw authStopError(…, 'the summarizer')`; the outer `catch` calls `writeSpend(err.code || 'error')` (so `stoppedBy` is the code); `mapPool` starts no item after the first error | `src/longhaul/run.js` | Task 1 |
| `scoreOne` catches every adapter error into `errorRecord(base, err.message)`; `finish({ run, runId, dir, config, records, spend, setupCosts })`; `runEvidenceOnly` and pass 1 call `adapter.prepare(session, { upToSeq })`; `closeAdapters` runs in `runBenchmark`'s `finally` | `src/longhaul/run.js` | Task 10 |
| `UsageError(message, code = 'USAGE')`; the CLI prints a `UsageError`'s message and exits 2 | `src/longhaul/errors.js`, `src/longhaul/cli.js` | Tasks 1, 10 |
| `createKlRecallRerankAdapter({ recall, privateRoot, candidates: 'bm25' \| 'fused', rerankModel, scorer, runner, ...rest })`: forces `rerank.enabled` and `maxMs` 10 minutes, caches scores with `rerankCacheDir(privateRoot, sessionId, model)` + `RerankCache` + `createCachedReranker({ cache, questionId, scorer, stats })` (the scorer is called only on misses), exposes `stats`, `missingQuestionVectors` (fused), `close()` | `src/longhaul/adapters/kl-recall-rerank.js`, `src/longhaul/rerank.js` | Task 10 |
| `recallSettings(recall, budgetTokens, chunk)` validates `--recall` keys with `kept()`; `describe()` holds the full merged `recall` settings, and the answer cache key hashes `describe()` | `src/longhaul/adapters/kl-recall.js`, `answer-stage.js` | Tasks 4, 12 (Decision 9) |
| The adapter registry `FACTORIES`; `adapterNames()` is pinned as an exact list in `tests/longhaul-adapters.test.js:155` | `src/longhaul/adapters/index.js` | Task 10 |
| `commands/run.js`: `vec` config, `answering`, `positiveInt`, the per-adapter output loop | `src/longhaul/commands/run.js` | Task 10 |
| `HISTORY_DEFAULTS.recall.rerank` (frozen: `enabled`, `model`, `topM`, `maxMs`, `search`, `searchMaxMs`); `mergeHistorySettings`; `REMOTE_MODEL_RE`; the internal `remoteModel`, `isObject` | `src/history/settings.js` | Task 4 |
| `Retriever#_rerank(query, items, rerank, reranker)`: races `maxMs`, keeps the fused order on a throw, a timeout or unusable scores, and treats `RERANK_UNAVAILABLE` as silent; the constructor's `reranker` is used when `rerank.enabled` | `src/history/retriever.js` | Task 5 |
| `ContextBuilder#build` → `stats` built from the `retrieval` object the Retriever filled | `src/history/context-builder.js` | Task 5 |
| `createHostReranker(host)`; `EmbedderHost#rerank(query, texts, { maxMs })`, `preloadReranker()`, `_settings()`, `fail()`'s warning discipline (one log line and one `notify({ title, body })` toast per distinct failure, cleared by `retry()`) | `src/history/reranker.js`, `src/history/embedder-host.js` | Tasks 5, 6 |
| `EmbedError(code, message)`; `RERANK_UNAVAILABLE` is the Retriever's silent no-rerank | `src/history/embed-errors.js` | Task 6 |
| `searchHistoryExcerpts({ …, reranker })`: with `rerank.search` it runs step 6 under `searchMaxMs` | `src/history/search.js` | Task 6 (unchanged) |
| `UNINDEXED_TOOLS` (`Vault`) | `src/history/chunker.js` | Task 6 |
| create-core: `getApiTokens()` / `setApiTokens()` (`store.get/set('apiTokens')`, the store being `chat-data.json`), `encryptToken` / `decryptToken` (the injected `cipher`: Electron `safeStorage` on the desktop, AES-GCM master key in service mode); the ElevenLabs precedent `ELEVENLABS_TOKEN_STORE_KEY = '__elevenlabs_api_key'` with `hasStored…`, `save…` (trims), `clear…`, `getDecrypted…`; `embedderHost`'s `notify` toast through `deps.uiToastChannel`; `historyReranker` handed to the `Retriever` and to `get history()` (SearchHistory); `startHistoryEmbedding`; `shutdown()` stops the embedder before closing the store | `src/core/create-core.js` | Task 7 |
| `SECRET_FILE_PREFIXES` includes `chat-data.json` ("the store: provider tokens…") for every tool | `src/tools/utils.js:93` | Task 7 |
| The `Vault` tool reads `context.vault` = `createVault({ store: vaultStore, cipher })` (`config.json`), never the store's `apiTokens` | `src/tools/builtin/vault-tool.js` | Task 7 |
| Desktop import copies only provider tokens not starting `__`, plus `__elevenlabs_api_key` | `src/migration/desktop-source.js:271` | Open Question 3 |
| `registerHistoryHandlers(ipcMain, context)`: `embedderView()`, `HISTORY_EMBEDDER_SAVE` (refuses a value the merge would replace), `HISTORY_EMBEDDER_RETRY`; the `history` domain is proxied when attached | `src/ipc/history-handlers.js`, `src/desktop-bridge/allowlist.js` | Task 7 |
| `tests/history-ipc.test.js:90` pins `out.settings.rerank` to `{ enabled: false, search: true }` | test | Task 7 |
| Send path `turnContext = { …, embedder, vectorsSkipped, scope }` | `src/ipc/chat-handlers.js` ~line 654 | Task 8 |
| `historyEmbedderStatusText`, `historyEmbedderStateText`, `refreshHistoryEmbedderStatus`, `loadHistorySettings`, `saveHistorySettings`, `wireHistorySettings`, `recallVia`, `recallLineText`; the "History and recall" tab in `index.html`; `window.electron.history` in `preload.js` (`validateObject`, `validateString(value, name, { minLength })`) | `renderer.js`, `index.html`, `preload.js` | Task 8 |
| Test helpers: `openTempStore`, `seedChat`, `BASE_TIME` (`tests/helpers/history-fixture.js`); `FakeEmbedRunner` (`tests/helpers/fake-embed-runner.js`); `closeOpenHistoryStores`; `tmpHome`, `sink` (`tests/helpers/longhaul-helpers.js`); `fixtureCatalog()` (`openai/gpt-6-lite`, `anthropic/claude-haiku-4-5`); `writeSyntheticRoot`, `SYNTH_FIXTURES[0]` (`synth-small`, 6 questions) | `tests/helpers/`, `src/longhaul/synthetic.js` | all |

## File Structure

New:

| File | Responsibility |
|---|---|
| `src/providers/typesafe-provider.js` | `TypesafeProvider`: `ask({ model, state, questions }, { abortSignal })` through `BaseProvider.request`; error without body text; `TYPESAFE_BASE_URL`, `JEV_LATEST` |
| `src/history/jev-rerank.js` | The shared scorer: `jevScores`, `planBatches`, `groupStateTokens`, `clip`, `estTokens`, `limiter`, `noulOf`, the two question shapes, `MODES`, the caps |
| `src/history/jev-reranker.js` | `JevReranker`: key, start gate, `KL_TEST_MODE`, abort at `maxMs`, hold-offs, one warning per episode, `status()`, token counts |
| `src/longhaul/jev.js` | LongHaul's Jev client (retries, limiter, token cap, served-model check, counts), `createJevScorer`, `estimateJevTokens`, calibration and usage summaries |
| `src/longhaul/adapters/kl-recall-jev-rerank.js` | `kl-recall-jev-rerank` / `kl-recall-vec-jev-rerank` |
| `tests/helpers/fake-jev-server.js` | Loopback stand-in for `/v1/systemone` (ported from the probe, with failures, delay, the 32K cap, aborted-connection count) |

Modified: `src/history/{settings,retriever,context-builder,reranker,embedder-host}.js`, `src/core/create-core.js`, `src/ipc/{history-handlers,chat-handlers,constants}.js`, `preload.js`, `renderer.js`, `index.html`, `src/longhaul/{retry,answer-stage,run}.js`, `src/longhaul/adapters/index.js`, `src/longhaul/commands/run.js`, the two specs, `CLAUDE.md`.

New tests: `tests/longhaul-quota.test.js`, `tests/providers-typesafe.test.js`, `tests/history-jev-rerank.test.js`, `tests/history-rerank-provenance.test.js`, `tests/history-jev-reranker.test.js`, `tests/history-core-jev.test.js`, `tests/history-ipc-jev.test.js`, `tests/renderer-history-rerank.test.js`, `tests/longhaul-jev.test.js`, `tests/longhaul-jev-adapters.test.js`. Changed tests: `tests/providers-request-helper.test.js`, `tests/history-settings.test.js`, `tests/history-ipc.test.js`, `tests/longhaul-adapters.test.js`.

---

## Task 1: LongHaul stops on a quota refusal

**Files:**
- Modify: `src/longhaul/retry.js` (whole file below)
- Modify: `src/longhaul/answer-stage.js` (the import line, `failed()`)
- Modify: `src/longhaul/run.js` (the `./retry` import, the pass 2a summarizer `catch`)
- Test: `tests/longhaul-quota.test.js` (new)

**Interfaces:**
- Consumes: `ProviderError` fields `status`, `type`, `code`, `message` (built by `buildProviderError` from the response body; no provider change is needed, and the first describe block pins that the fields survive for OpenAI and Anthropic).
- Produces (all in `src/longhaul/retry.js`): `isQuotaFailure(err) → boolean`; `retryable(err)` now `false` for a quota failure; `quotaStopError(provider, status, forWhat = null) → UsageError` with `code: 'QUOTA'`; `stopErrorFor(err, provider, forWhat = null) → UsageError | null` (QUOTA first, then AUTH); `STOP_CODES` (frozen `['AUTH', 'QUOTA']`); `withRetries(fn, { retries, baseDelayMs, wait, onRetry, isRetryable = retryable })`. `isAuthFailure`, `callErrorCode`, `authStopError` unchanged.

What tells them apart, from the code: an OpenAI quota refusal is HTTP 429 whose body is `{ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota…' } }`, so the thrown `ProviderError` has `status 429`, `type` and `code` `insufficient_quota`; a rate limit is 429 with `code: 'rate_limit_exceeded'`. Anthropic's is HTTP 400 `invalid_request_error` whose message says "Your credit balance is too low…" (only the message tells it apart), or 402 `billing_error`; its rate limit is 429 `rate_limit_error`. DeepSeek and OpenRouter answer 402. The predicate never reads the word "billing" alone: an OpenAI rate-limit message can link the billing page.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-quota.test.js`:

```js
// tests/longhaul-quota.test.js
// A provider refusal that means the account is out of credit or quota stops
// a LongHaul run like a refused key (QUOTA, exit 2, spend.json stoppedBy
// QUOTA) for answer, judge and summarizer calls; a plain rate limit is still
// retried. The errors come from the real providers' buildError over recorded
// response shapes. No network: a loopback server stands in for the provider.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const {
  isQuotaFailure, retryable, withRetries, stopErrorFor, quotaStopError, STOP_CODES
} = require('../src/longhaul/retry');
const { runBenchmark } = require('../src/longhaul/run');
const { createAdapter } = require('../src/longhaul/adapters');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OPENAI_QUOTA = { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } };
const OPENAI_RATE = { error: { message: 'Rate limit reached for test-model in organization org-test on tokens per min (TPM). Please try again in 20ms. You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.', type: 'tokens', param: null, code: 'rate_limit_exceeded' } };
const ANTHROPIC_CREDIT = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
const ANTHROPIC_BILLING = { type: 'error', error: { type: 'billing_error', message: 'There is an issue with your billing.' } };
const ANTHROPIC_RATE = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' } };
const noWait = async () => {};

describe('the thrown error tells a quota refusal from a rate limit', () => {
  const openai = new OpenAIProvider('sk-test-1234567890');
  const anthropic = new AnthropicProvider('sk-ant-test-1234567890');

  it('OpenAI insufficient_quota: HTTP 429 with type and code on the ProviderError; not retryable', async () => {
    const err = await openai.buildError(jsonResponse(429, OPENAI_QUOTA));
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.type, 'insufficient_quota');
    assert.strictEqual(err.code, 'insufficient_quota');
    assert.strictEqual(isQuotaFailure(err), true);
    assert.strictEqual(retryable(err), false);
  });

  it('a plain OpenAI rate limit stays retryable, though its message links the billing page', async () => {
    const err = await openai.buildError(jsonResponse(429, OPENAI_RATE));
    assert.strictEqual(err.code, 'rate_limit_exceeded');
    assert.strictEqual(isQuotaFailure(err), false);
    assert.strictEqual(retryable(err), true);
  });

  it('Anthropic: a 400 credit-balance message and a 402 billing_error are quota; a 429 rate_limit_error is not', async () => {
    const credit = await anthropic.buildError(jsonResponse(400, ANTHROPIC_CREDIT));
    assert.strictEqual(credit.status, 400);
    assert.match(credit.message, /credit balance is too low/);
    assert.strictEqual(isQuotaFailure(credit), true);
    const billing = await anthropic.buildError(jsonResponse(402, ANTHROPIC_BILLING));
    assert.strictEqual(billing.type, 'billing_error');
    assert.strictEqual(isQuotaFailure(billing), true);
    const rate = await anthropic.buildError(jsonResponse(429, ANTHROPIC_RATE));
    assert.strictEqual(isQuotaFailure(rate), false);
    assert.strictEqual(retryable(rate), true);
  });

  it('any 402 is quota (DeepSeek "Insufficient Balance"); a message with no status is not', async () => {
    const err = await openai.buildError(jsonResponse(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } }));
    assert.strictEqual(isQuotaFailure(err), true);
    assert.strictEqual(isQuotaFailure(new TypeError('fetch failed')), false);
    assert.strictEqual(isQuotaFailure(new Error('insufficient quota')), false);
    assert.strictEqual(isQuotaFailure(null), false);
  });

  it('withRetries: a quota refusal is tried once, a rate limit four times; isRetryable overrides', async () => {
    let n = 0;
    const quota = Object.assign(new Error('quota'), { status: 429, type: 'insufficient_quota' });
    await assert.rejects(withRetries(async () => { n += 1; throw quota; }, { wait: noWait }), (e) => e === quota);
    assert.strictEqual(n, 1);
    n = 0;
    await assert.rejects(withRetries(async () => { n += 1; throw Object.assign(new Error('slow down'), { status: 429 }); }, { wait: noWait }));
    assert.strictEqual(n, 4);
    n = 0;
    const odd = Object.assign(new Error('odd'), { code: 'ODD' });
    await assert.rejects(withRetries(async () => { n += 1; throw odd; }, { wait: noWait, retries: 2, isRetryable: (e) => e.code === 'ODD' }));
    assert.strictEqual(n, 3);
  });

  it('stopErrorFor: QUOTA before AUTH, null for anything else', () => {
    const q = stopErrorFor(Object.assign(new Error('Your credit balance is too low'), { status: 403 }), 'anthropic');
    assert.ok(q instanceof UsageError);
    assert.strictEqual(q.code, 'QUOTA');
    assert.match(q.message, /^anthropic refused the call: the account is out of credit or quota \(403\); the run stopped\./);
    assert.strictEqual(stopErrorFor(Object.assign(new Error('no'), { status: 401 }), 'openai').code, 'AUTH');
    assert.strictEqual(stopErrorFor(Object.assign(new Error('x'), { status: 500 }), 'openai'), null);
    assert.match(quotaStopError('openai', 429, 'the summarizer').message, /\(429\) for the summarizer; the run stopped/);
    assert.deepStrictEqual([...STOP_CODES], ['AUTH', 'QUOTA']);
  });
});

const catalog = fixtureCatalog();
const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
const fixedNow = () => new Date('2026-10-04T10:15:00.000Z');
const quotaError = () => Object.assign(
  new Error('You exceeded your current quota, please check your plan and billing details.'),
  { status: 429, type: 'insufficient_quota', code: 'insufficient_quota' }
);

function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return home;
}

// Declines every question (the judge rules a decline abstained); out of
// quota from call number quotaAt on.
function client(provider, model, { quotaAt = null, judge = false } = {}) {
  return {
    provider, model, prompts: [],
    async complete(prompt) {
      this.prompts.push(prompt);
      if (quotaAt !== null && this.prompts.length >= quotaAt) throw quotaError();
      const text = judge ? JSON.stringify({ verdict: 'abstained', reason: 'fake reason' }) : "I don't know";
      const input = Math.ceil(prompt.length / 4);
      return { text, llmMetrics: { inputTokens: input, outputTokens: 5, costUsd: catalog.price(provider, model, { input, output: 5 }).usd } };
    }
  };
}

const options = (home, over = {}) => ({
  answerClient: client('openai', 'gpt-6-lite'),
  judgeClient: client('anthropic', 'claude-haiku-4-5', { judge: true }),
  prompts, catalog, cache: ModelCache.forHome(home), concurrency: 1, retry: { wait: noWait }, ...over
});
const onlySpend = (home) => {
  const [run] = fs.readdirSync(home.runs);
  return JSON.parse(fs.readFileSync(path.join(home.runs, run, 'spend.json'), 'utf8'));
};

describe('a run out of quota stops', () => {
  it('an answer call: QUOTA, stoppedBy QUOTA, nothing cached for it; a rerun finishes from the cache', async () => {
    const home = setup();
    const answerClient = client('openai', 'gpt-6-lite', { quotaAt: 4 });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: options(home, { answerClient }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /^openai refused the call: the account is out of credit or quota \(429\)/.test(err.message)
    );
    assert.strictEqual(answerClient.prompts.length, 4, 'the refusal is not retried and no item starts after it');
    const spend = onlySpend(home);
    assert.strictEqual(spend.stoppedBy, 'QUOTA');
    assert.strictEqual(spend.calls, 6, 'three answers and three judgments were paid before the refusal');

    let counts = null;
    const second = options(home, { onPlan: (p) => { counts = p.counts; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: second, now: fixedNow, commit: 'x' });
    assert.deepStrictEqual(counts, { answers: 6, answersCached: 3, judgments: 6, judgmentsCached: 3, summaries: 0, summariesCached: 0 });
    assert.strictEqual(second.answerClient.prompts.length, 3, 'only the answers the stopped run never got');
    assert.strictEqual(out.spend.stoppedBy, null);
    assert.ok(out.records.every((r) => !r.answerError));
  });

  it('a judge call: QUOTA naming the judge provider', async () => {
    const home = setup();
    const judgeClient = client('anthropic', 'claude-haiku-4-5', { judge: true, quotaAt: 2 });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: options(home, { judgeClient }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /^anthropic refused the call/.test(err.message)
    );
    assert.strictEqual(judgeClient.prompts.length, 2);
    assert.strictEqual(onlySpend(home).stoppedBy, 'QUOTA');
  });

  it('a summarizer call: QUOTA for the summarizer, called once', async () => {
    const home = setup();
    const cache = ModelCache.forHome(home);
    const summarizer = { provider: 'openai', model: 'gpt-6-lite', prompts: [], async complete(p) { this.prompts.push(p); throw quotaError(); } };
    const adapter = createAdapter('summarize-compact', {
      compactEveryTokens: 2000, summarizer: { client: summarizer, cache, prompt: prompts.summarize, retry: { wait: noWait } }
    });
    await assert.rejects(
      runBenchmark({ home, adapters: [adapter], answer: options(home, { cache }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /for the summarizer; the run stopped/.test(err.message)
    );
    assert.strictEqual(summarizer.prompts.length, 1);
    assert.strictEqual(onlySpend(home).stoppedBy, 'QUOTA');
  });

  it('from the CLI against a provider answering 429 insufficient_quota: exit 2, one request', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push(req.url);
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENAI_QUOTA));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    try {
      const { env, root } = tmpHome();
      writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
      const io = { stdout: sink(), stderr: sink(), env: { ...env, OPENAI_API_KEY: 'test-key-123456' } };
      const code = await main(['run', '--adapters', 'oracle',
        '--answer-provider', 'openai', '--answer-model', 'test-model', '--answer-base-url', url,
        '--judge-provider', 'openai', '--judge-model', 'test-judge', '--judge-base-url', url,
        '--allow-unpriced', '--concurrency', '1'], io);
      assert.strictEqual(code, 2, io.stderr.text);
      assert.match(io.stderr.text, /out of credit or quota \(429\)/);
      assert.strictEqual(requests.length, 1, 'not retried');
      const [run] = fs.readdirSync(path.join(root, 'runs'));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', run, 'spend.json'), 'utf8')).stoppedBy, 'QUOTA');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-quota.test.js`
Expected: FAIL; the first describe block fails with `isQuotaFailure is not a function` (it is not exported yet), and the run tests fail because the 429 is retried four times and recorded per item.

- [ ] **Step 3: Rewrite `src/longhaul/retry.js`**

Replace the whole file with:

```js
'use strict';
// Retries for LongHaul's provider calls (benchmark spec §15: an answer or
// judge call is retried three times, then recorded as an error). A 429, a
// 5xx or a transport failure is retried with exponential backoff, or after
// the provider's retry-after; anything else (a 400, a refused key) is thrown
// at once. A refusal that means the account is out of credit or quota is
// never retried, though it often arrives as a 429: waiting adds no credit,
// and every later call would fail the same way, so a run stops on it as on
// a refused key (QUOTA).
const { UsageError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What a ProviderError carries (buildProviderError reads the body): OpenAI
// answers 429 with error.type and error.code "insufficient_quota"; Anthropic
// answers 402 billing_error, or 400 invalid_request_error whose message says
// the credit balance is too low; DeepSeek and OpenRouter answer 402. A plain
// rate limit (OpenAI rate_limit_exceeded, Anthropic rate_limit_error) is none
// of these, even when its message links the billing page, so the word
// "billing" alone is never read (unlike error-classifier.js's BILLING).
const QUOTA_IDS = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_error', 'billing_hard_limit_reached']);
const QUOTA_MESSAGE = /credit balance is too low|exceeded your current quota|insufficient[ _](quota|balance|credits?|funds)/i;
const QUOTA_MESSAGE_STATUSES = new Set([400, 403, 429]);

function isQuotaFailure(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.status === 402) return true;
  if ([err.code, err.type].some((v) => QUOTA_IDS.has(String(v || '').toLowerCase()))) return true;
  return QUOTA_MESSAGE_STATUSES.has(err.status) && QUOTA_MESSAGE.test(String(err.message || ''));
}

function retryable(err) {
  if (!err) return false;
  if (isQuotaFailure(err)) return false;
  if (err.status === 429 || (Number.isInteger(err.status) && err.status >= 500)) return true;
  if (Number.isInteger(err.status)) return false;
  // A transport failure (fetch rejects with a TypeError): reset, DNS, timeout.
  return err.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(String(err.message || ''));
}

// A refused key: every later call would fail the same way, so a run stops.
function isAuthFailure(err) {
  return Boolean(err) && (err.status === 401 || err.status === 403);
}

// The UsageError codes that stop a run (a refused key, an exhausted account).
const STOP_CODES = Object.freeze(['AUTH', 'QUOTA']);

// The record code for a model call that failed (answer, judge or summary):
// over-budget for the cap, else <stage>-failed with the HTTP status if any.
function callErrorCode(stage, err) {
  if (err && err.code === 'OVER_BUDGET') return 'over-budget';
  return `${stage}-failed${Number.isInteger(err?.status) ? `:${err.status}` : ''}`;
}

// The error that stops a run on a refused key; forWhat names the caller
// when it is not the answer or judge model ("the summarizer").
function authStopError(provider, status, forWhat = null) {
  return new UsageError(`${provider} refused the API key (${status})${forWhat ? ` for ${forWhat}` : ''}; the run stopped. `
    + 'Finished calls are cached, so running again costs only what is left.', 'AUTH');
}

// The error that stops a run on an account out of credit or quota.
function quotaStopError(provider, status, forWhat = null) {
  return new UsageError(`${provider} refused the call: the account is out of credit or quota`
    + `${Number.isInteger(status) ? ` (${status})` : ''}${forWhat ? ` for ${forWhat}` : ''}; the run stopped. `
    + 'Add credit, then run again: finished calls are cached, so running again costs only what is left.', 'QUOTA');
}

// The error that stops a run for this failure (QUOTA before AUTH: a 403 can
// say the credit is gone), or null when the run goes on.
function stopErrorFor(err, provider, forWhat = null) {
  if (isQuotaFailure(err)) return quotaStopError(provider, err.status, forWhat);
  if (isAuthFailure(err)) return authStopError(provider, err.status, forWhat);
  return null;
}

// onRetry({ err, attempt, delayMs }) runs before each wait (a caller's log
// line). isRetryable replaces retryable (Jev also retries its own timeouts).
async function withRetries(fn, { retries = 3, baseDelayMs = 1000, wait = sleep, onRetry = null, isRetryable = retryable } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      if (onRetry) onRetry({ err, attempt, delayMs: delay });
      await wait(delay);
    }
  }
}

module.exports = {
  retryable, isQuotaFailure, isAuthFailure, STOP_CODES, callErrorCode, authStopError, quotaStopError, stopErrorFor, withRetries
};
```

- [ ] **Step 4: Stop the answer and judge calls on it**

In `src/longhaul/answer-stage.js`, replace

```js
const { isAuthFailure, callErrorCode, authStopError } = require('./retry');
```

with

```js
const { callErrorCode, stopErrorFor } = require('./retry');
```

and in `answerAndJudge`, replace

```js
    if (isAuthFailure(err)) throw authStopError(stage === 'answer' ? deps.answerClient.provider : deps.judgeClient.provider, err.status);
```

with

```js
    // A refused key or an exhausted account stops the run (AUTH, QUOTA).
    const stop = stopErrorFor(err, stage === 'answer' ? deps.answerClient.provider : deps.judgeClient.provider);
    if (stop) throw stop;
```

- [ ] **Step 5: Stop the summarizer on it**

In `src/longhaul/run.js`, replace

```js
const { isAuthFailure, retryable, callErrorCode, authStopError } = require('./retry');
```

with

```js
const { retryable, callErrorCode, stopErrorFor } = require('./retry');
```

and in `runAnswerStage`'s pass 2a, replace

```js
          // A refused key stops the run, as an answer's does. The cap, or a
          // call that failed after its retries (spec §15: three), is recorded
          // as a context error on this adapter's questions and the run goes
          // on. Anything else is a defect and is thrown.
          if (isAuthFailure(err)) throw authStopError(d.adapter.modelClient?.provider ?? 'The provider', err.status, 'the summarizer');
```

with

```js
          // A refused key or an exhausted account stops the run (AUTH,
          // QUOTA), as an answer's does. The cap, or a call that failed
          // after its retries (spec §15: three), is recorded as a context
          // error on this adapter's questions and the run goes on. Anything
          // else is a defect and is thrown.
          const stop = stopErrorFor(err, d.adapter.modelClient?.provider ?? 'The provider', 'the summarizer');
          if (stop) throw stop;
```

The outer `catch` already calls `writeSpend(err.code || 'error')`, so `stoppedBy` becomes `'QUOTA'` with no further change; `cachedCall` stores nothing for a call that threw, so a rerun pays only for what is left.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-quota.test.js tests/longhaul-answer-run.test.js tests/longhaul-answer-stage.test.js tests/longhaul-model-cache.test.js tests/longhaul-embed.test.js`
Expected: PASS, `# fail 0` (the existing AUTH tests are unchanged).

Then the sweep: `node --test tests/history-*.test.js tests/longhaul-*.test.js tests/renderer-history-*.test.js tests/electron-boundary.test.js tests/fake-embedder.test.js tests/providers-*.test.js`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/retry.js src/longhaul/answer-stage.js src/longhaul/run.js tests/longhaul-quota.test.js
git commit -m "fix(longhaul): a quota refusal stops the run (QUOTA) instead of being retried and recorded per item"
```

---

## Task 2: `TypesafeProvider` and the fake Jev server

**Files:**
- Create: `src/providers/typesafe-provider.js`
- Create: `tests/helpers/fake-jev-server.js`
- Modify: `tests/providers-request-helper.test.js` (the streaming guard skips the decide-only provider)
- Test: `tests/providers-typesafe.test.js` (new)

**Interfaces:**
- Consumes: `BaseLLMProvider` (`request`, `getHeaders`, `buildLlmCallMetrics`, `baseUrlFrom`, `validateApiKey`), `buildProviderError`.
- Produces: `TypesafeProvider` (module export) with `new TypesafeProvider(apiKey, { baseUrl?, catalog? })`, `baseUrl` (default `https://api.typesafe.ai`), `getProviderName() → 'typesafe'`, `getDefaultModel() → 'jev-latest'`, `getModels() → []`, `async listModels(options = {}) → []`, `async sendMessage()` (throws "not a chat model"), `async ask({ model = 'jev-latest', state, questions }, { abortSignal } = {}) → { answers, usage: { inputTokens, outputTokens }, model: <served>, llmMetrics }`, `async buildError(response, details) → ProviderError` whose message is `typesafe.ai answered HTTP <status>` and whose `type`/`code` are the body's only when they are short ids; statics `TypesafeProvider.TYPESAFE_BASE_URL`, `TypesafeProvider.JEV_LATEST`. A body that is not JSON throws `{ code: 'JEV_BAD_BODY', status }`.
- Produces (test helper): `startFakeJevServer({ failFirst = 0, failStatus = 429, failBody, retryAfter = null, delayMs = 0, stateTokenLimit = 32000, model = 'jev-1.13.0' }) → { url, requests: [{ path, auth, contentType, body, raw }], setFailure({ count, status, body, retryAfter }), setDelay(ms), aborted() → number, close() }`; `overlap(query, text)`.

- [ ] **Step 1: Write the fake server**

Create `tests/helpers/fake-jev-server.js`:

```js
// tests/helpers/fake-jev-server.js
// A loopback stand-in for typesafe.ai's POST /v1/systemone (Jev), ported
// from the exp/jev-rerank probe. Each noul question is answered with the
// share of the query's words its candidate holds (pointwise:
// state.candidate_passage against state.query_excerpt; batched: the
// state.candidates entry whose id the question names, against state.query).
// usage.input_tokens is the body's word count. Options: the first failFirst
// requests get failStatus with failBody (and a Retry-After header when
// retryAfter is set); every answer waits delayMs; a state over
// stateTokenLimit tokens (JSON characters / 3, Jev's 32K cap) gets 422;
// every answer names `model`. aborted() counts clients that dropped the
// connection before the answer. 127.0.0.1 only; never the network.
const http = require('http');

const words = (t) => String(t || '').toLowerCase().match(/[a-z0-9]+/g) || [];

function overlap(query, text) {
  const q = new Set(words(query));
  if (!q.size) return 0;
  const t = new Set(words(text));
  let n = 0;
  for (const w of q) if (t.has(w)) n += 1;
  return n / q.size;
}

async function startFakeJevServer({
  failFirst = 0, failStatus = 429, failBody = { detail: 'rate limited' }, retryAfter = null, delayMs = 0,
  stateTokenLimit = 32000, model = 'jev-1.13.0'
} = {}) {
  const state = { requests: [], failures: failFirst, failStatus, failBody, retryAfter, delayMs, aborted: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    res.on('close', () => { if (!res.writableEnded) state.aborted += 1; });
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, obj, headers = {}) => {
        const go = () => {
          if (res.destroyed) return;
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };
        if (state.delayMs > 0) setTimeout(go, state.delayMs);
        else go();
      };
      let body = null;
      try { body = JSON.parse(raw); } catch { return send(422, { detail: 'not json' }); }
      state.requests.push({ path: req.url, auth: req.headers.authorization || null, contentType: req.headers['content-type'] || null, body, raw });
      if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { detail: 'no route' });
      if (state.failures > 0) {
        state.failures -= 1;
        return send(state.failStatus, state.failBody, state.retryAfter !== null ? { 'retry-after': String(state.retryAfter) } : {});
      }
      if (JSON.stringify(body.state ?? '').length / 3 > stateTokenLimit) return send(422, { detail: 'state over the token limit' });
      const s = body.state || {};
      const answers = {};
      for (const [id, q] of Object.entries(body.questions || {})) {
        if (q.type !== 'noul') return send(422, { detail: 'noul only here' });
        const text = typeof s.candidate_passage === 'string' ? s.candidate_passage : (s.candidates || []).find((c) => c.id === id)?.text;
        if (text === undefined) return send(422, { detail: 'unknown candidate' });
        answers[id] = { type: 'noul', noul: overlap(s.query_excerpt ?? s.query, text) };
      }
      return send(200, { model, answers, usage: { input_tokens: words(raw).length, output_tokens: 0 } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    setFailure({ count = 1, status = 429, body = { detail: 'failed' }, retryAfter = null } = {}) {
      state.failures = count;
      state.failStatus = status;
      state.failBody = body;
      state.retryAfter = retryAfter;
    },
    setDelay(ms) { state.delayMs = ms; },
    aborted: () => state.aborted,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    })
  };
}

module.exports = { startFakeJevServer, overlap };
```

- [ ] **Step 2: Write the failing test**

Create `tests/providers-typesafe.test.js`:

```js
// tests/providers-typesafe.test.js
// TypesafeProvider (typesafe.ai's Jev): a decide-only provider. Its request
// goes through BaseProvider.request with the abort signal, its errors carry
// the status and never the body's text, its calls are unpriced, and it is
// never a chat model. Against the loopback fake server; no network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { fixtureCatalog } = require('./helpers/models-fixture');

const KEY = 'test-key-not-real-0001';
const ONE = { state: { query: 'gate code', candidates: [{ id: 'c1', text: 'the side gate code is 4417' }] }, questions: { c1: { type: 'noul', instructions: 'x' } } };

describe('TypesafeProvider', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  it('asks /v1/systemone with the Bearer key; returns answers, usage and the served model, unpriced', async () => {
    const p = new TypesafeProvider(KEY, { baseUrl: server.url, catalog: fixtureCatalog() });
    const out = await p.ask(ONE);
    assert.strictEqual(out.answers.c1.noul, 1);
    assert.strictEqual(out.model, 'jev-1.13.0');
    assert.ok(out.usage.inputTokens > 0);
    assert.strictEqual(out.usage.outputTokens, 0);
    assert.strictEqual(out.llmMetrics.costUsd, null, 'not in the catalog: unpriced, never $0');
    assert.strictEqual(out.llmMetrics.unpriced, true);
    const r = server.requests.at(-1);
    assert.strictEqual(r.path, '/v1/systemone');
    assert.strictEqual(r.auth, `Bearer ${KEY}`);
    assert.match(r.contentType, /application\/json/);
    assert.strictEqual(r.body.model, 'jev-latest');
    assert.deepStrictEqual(r.body.state, ONE.state);
  });

  it('an error carries the status and never the body text (a 422 can echo the state)', async () => {
    const bad = await startFakeJevServer({ failFirst: 1, failStatus: 422, failBody: { detail: [{ msg: 'state echo: the side gate code is 4417' }] } });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: bad.url });
      await assert.rejects(p.ask(ONE), (err) => err.name === 'ProviderError' && err.status === 422
        && err.message === 'typesafe.ai answered HTTP 422' && !JSON.stringify({ ...err.toJSON(), m: err.message }).includes('4417'));
    } finally {
      await bad.close();
    }
  });

  it('keeps a 429 retry-after and a short error type for the quota check, not the message', async () => {
    const slow = await startFakeJevServer({ failFirst: 1, failStatus: 429, retryAfter: 2, failBody: { error: { type: 'insufficient_quota', message: 'the side gate code is 4417' } } });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: slow.url });
      await assert.rejects(p.ask(ONE), (err) => err.status === 429 && err.retryAfterMs === 2000
        && err.type === 'insufficient_quota' && !err.message.includes('4417'));
    } finally {
      await slow.close();
    }
  });

  it('passes the abort signal: an abort cancels the request at the provider', async () => {
    const hung = await startFakeJevServer({ delayMs: 5000 });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: hung.url });
      const c = new AbortController();
      setTimeout(() => c.abort(), 20);
      const t0 = Date.now();
      await assert.rejects(p.ask(ONE, { abortSignal: c.signal }), (err) => err.name === 'AbortError');
      assert.ok(Date.now() - t0 < 2000);
    } finally {
      await hung.close();
    }
  });

  it('refuses a short key, is not a registered provider, and offers no chat model', async () => {
    assert.throws(() => new TypesafeProvider('short'), /Invalid API key/);
    assert.ok(!ProviderFactory.listRegistered().includes('typesafe'));
    const p = new TypesafeProvider(KEY);
    assert.strictEqual(p.baseUrl, 'https://api.typesafe.ai');
    assert.strictEqual(p.getProviderName(), 'typesafe');
    assert.deepStrictEqual(p.getModels(), []);
    assert.deepStrictEqual(await p.listModels(), []);
    await assert.rejects(p.sendMessage([]), /not a chat model/);
    await assert.rejects(p.ask({ state: 's', questions: {} }), /at least one question/);
    assert.strictEqual(TypesafeProvider.JEV_LATEST, 'jev-latest');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/providers-typesafe.test.js`
Expected: FAIL, `Cannot find module '../src/providers/typesafe-provider'`.

- [ ] **Step 4: Write the provider**

Create `src/providers/typesafe-provider.js`:

```js
// src/providers/typesafe-provider.js
// typesafe.ai's System One API (Jev), used only to rerank recall candidates
// (recall spec §6.3 step 6, history.recall.rerank.kind 'jev'). A decide-only
// provider: it answers noul/choice/score questions about a state and never
// holds a chat, so it is not registered with ProviderFactory, is not one of
// the 14 catalog providers, has no catalog entry (every call is unpriced:
// costUsd null, never $0) and is never offered as a chat model.
//
// POST <baseUrl>/v1/systemone, Bearer key, { model, state, questions } ->
// { model, answers: { <id>: { type, noul } }, usage: { input_tokens,
// output_tokens } }. Errors 401, 422, 429, 529. The request goes through
// BaseProvider.request with options.abortSignal. An error never carries the
// response body's text (a 422 can echo the state, which is chat text): the
// message is "typesafe.ai answered HTTP <status>", and only a short error
// type and code from the body are kept, for the quota check.
const BaseLLMProvider = require('./base-provider');
const { buildProviderError } = require('./provider-error');

const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
const JEV_LATEST = 'jev-latest';
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeId = (v) => (typeof v === 'string' && SAFE_ID.test(v) ? v : '');

class TypesafeProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, TYPESAFE_BASE_URL);
  }

  getProviderName() {
    return 'typesafe';
  }

  getDefaultModel() {
    return JEV_LATEST;
  }

  // Never offered as a chat model.
  getModels() {
    return [];
  }

  async listModels(options = {}) {
    void options;
    return [];
  }

  async sendMessage() {
    throw new Error('typesafe.ai Jev answers questions about a state; it is not a chat model.');
  }

  async ask({ model = JEV_LATEST, state, questions } = {}, options = {}) {
    if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
      throw new Error('ask needs at least one question');
    }
    const response = await this.request(`${this.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ model, state, questions })
    }, { ...options, model });
    if (!response.ok) throw await this.buildError(response, { model });
    let json;
    try {
      json = await response.json();
    } catch {
      throw Object.assign(new Error('typesafe.ai answered with a body that is not JSON'), { status: response.status, code: 'JEV_BAD_BODY' });
    }
    const served = typeof json?.model === 'string' && json.model ? json.model : model;
    return {
      answers: json && json.answers && typeof json.answers === 'object' ? json.answers : {},
      usage: { inputTokens: Number(json?.usage?.input_tokens) || 0, outputTokens: Number(json?.usage?.output_tokens) || 0 },
      model: served,
      llmMetrics: this.buildLlmCallMetrics({ model: served, usage: json?.usage || {} })
    };
  }

  async buildError(response, details = {}) {
    let body = null;
    try {
      const text = typeof response?.text === 'function' ? await response.text() : '';
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const e = body && typeof body.error === 'object' && body.error ? body.error : (body && typeof body === 'object' ? body : {});
    return buildProviderError(response, `typesafe.ai answered HTTP ${response?.status ?? 'without a status'}`, {
      provider: this.getProviderName(),
      body: { error: { type: safeId(e.type), code: safeId(e.code) } },
      ...details
    });
  }
}

TypesafeProvider.TYPESAFE_BASE_URL = TYPESAFE_BASE_URL;
TypesafeProvider.JEV_LATEST = JEV_LATEST;

module.exports = TypesafeProvider;
```

- [ ] **Step 5: Let the streaming guard skip the decide-only provider**

In `tests/providers-request-helper.test.js`, replace

```js
  it('every streaming method reads through guardStream', () => {
    for (const file of providerFiles()) {
```

with

```js
  it('every streaming method reads through guardStream', () => {
    // typesafe-provider.js answers questions about a state and never streams
    // a chat; the fetch and listModels guards still cover it.
    const DECIDE_ONLY = new Set(['typesafe-provider.js']);
    for (const file of providerFiles().filter((f) => !DECIDE_ONLY.has(f))) {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/providers-typesafe.test.js tests/providers-request-helper.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints, with `tests/providers-*.test.js`). Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/typesafe-provider.js tests/helpers/fake-jev-server.js tests/providers-typesafe.test.js tests/providers-request-helper.test.js
git commit -m "feat(providers): TypesafeProvider, a decide-only client for typesafe.ai Jev (unpriced, never a chat model)"
```

---

## Task 3: The shared Jev scorer (`src/history/jev-rerank.js`)

**Files:**
- Create: `src/history/jev-rerank.js`
- Test: `tests/history-jev-rerank.test.js` (new)

**Interfaces:**
- Consumes: an `ask(body, { abortSignal }) → Promise<{ answers, usage: { inputTokens, outputTokens }, model }>` transport (`TypesafeProvider#ask` from Task 2 has this shape; LongHaul's client in Task 9 too).
- Produces: `jevScores({ ask, model, query, texts, mode = 'batched', maxStateTokens = 28000, maxPerCall = 60, concurrency = 4, abortSignal = null }) → Promise<{ scores: number[], inputTokens, outputTokens, requests, model: <served or null> }>` (on failure the thrown error carries `err.jevUsage = { inputTokens, outputTokens, requests, model }`, and the requests not yet started never start); `planBatches(query, texts, { maxStateTokens, maxPerCall }) → { query, texts, groups: number[][] }` (query and texts possibly cut); `groupStateTokens(plan, group) → number`; `clip(text, maxTokens)`; `estTokens(text)` (`ceil(JSON.stringify(text).length / 3)`); `limiter(n) → (fn) => Promise`; `noulOf(answers, id)` (throws `code: 'JEV_NO_ANSWER'`); `pointwiseQuestion()`, `batchedQuestion(id)`; constants `MODES` (`['batched', 'pointwise']`), `STATE_TOKEN_LIMIT` 32000, `MAX_STATE_TOKENS` 28000, `MAX_PER_CALL` 60, `QUERY_MAX_TOKENS` 2000, `EST_CHARS_PER_TOKEN` 3.

The question wording and the criteria are the probe's, word for word: LongHaul's score cache is keyed by the query and chunk text only, and the probe's cached scores (under `rerank/<session>/jev-1.13.0-batched/`) stay valid only while the questions they answered are the ones asked.

- [ ] **Step 1: Write the failing test**

Create `tests/history-jev-rerank.test.js`:

```js
// tests/history-jev-rerank.test.js
// The shared Jev scorer (recall spec §6.3 step 6): batched groups held under
// the 32K-token state cap, the pointwise shape, scores in their places,
// usage counted, an abort or a failed group stops the rest. Against the
// loopback fake server through TypesafeProvider; no network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const {
  jevScores, planBatches, groupStateTokens, clip, estTokens, limiter, noulOf, MAX_STATE_TOKENS, STATE_TOKEN_LIMIT
} = require('../src/history/jev-rerank');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const { startFakeJevServer } = require('./helpers/fake-jev-server');

const KEY = 'test-key-not-real-0001';

describe('Jev scoring', () => {
  let server;
  let provider;
  const ask = (body, o) => provider.ask(body, o);
  before(async () => {
    server = await startFakeJevServer();
    provider = new TypesafeProvider(KEY, { baseUrl: server.url });
  });
  after(() => server.close());

  it('batched: one request per group, one noul per candidate, scores in order, usage counted', async () => {
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query: 'side gate code', texts: ['the side gate code is 4417', 'grocery list', 'the gate'] });
    assert.deepStrictEqual(out.scores.map((s) => Math.round(s * 3)), [3, 0, 1]);
    assert.strictEqual(out.requests, 1);
    assert.strictEqual(server.requests.length - n0, 1);
    assert.ok(out.inputTokens > 0);
    assert.strictEqual(out.model, 'jev-1.13.0');
    const r = server.requests.at(-1);
    assert.strictEqual(r.body.state.query, 'side gate code');
    assert.deepStrictEqual(r.body.state.candidates.map((c) => c.id), ['c1', 'c2', 'c3']);
    assert.deepStrictEqual(Object.keys(r.body.questions), ['c1', 'c2', 'c3']);
    const q = r.body.questions.c2;
    assert.strictEqual(q.type, 'noul');
    assert.match(q.instructions, /candidate with id "c2"/);
    assert.match(q.criteria.true, /states or establishes/);
    assert.match(q.criteria.false, /merely on a similar topic/);
  });

  it('pointwise: one request per candidate in the probe shape', async () => {
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query: 'gate code', texts: ['the gate code is 4417', 'weather'], mode: 'pointwise' });
    assert.deepStrictEqual(out.scores, [1, 0]);
    assert.strictEqual(server.requests.length - n0, 2);
    assert.deepStrictEqual(Object.keys(server.requests.at(-1).body.state).sort(), ['candidate_passage', 'query_excerpt']);
    assert.deepStrictEqual(Object.keys(server.requests.at(-1).body.questions), ['establishes']);
    await assert.rejects(jevScores({ ask, model: 'm', query: 'q', texts: ['a'], mode: 'listwise' }), /batched or pointwise/);
    assert.deepStrictEqual((await jevScores({ ask, model: 'm', query: 'q', texts: [] })).scores, []);
  });

  it('a candidate set over the 32K state cap is split and cut so every request is answered (Review Focus 1)', async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `${i % 2 ? 'gate code' : 'weather'} ${'x'.repeat(1490)}`);
    texts[7] = `gate code ${'y'.repeat(200000)}`;
    const query = `gate code ${'z'.repeat(50000)}`;
    // The fake enforces the cap: the uncut 200K-character candidate is refused.
    await assert.rejects(provider.ask({ state: { query: 'q', candidates: [{ id: 'c1', text: texts[7] }] }, questions: { c1: { type: 'noul', instructions: 'x' } } }),
      (err) => err.status === 422);
    const plan = planBatches(query, texts);
    assert.ok(plan.groups.length > 1);
    assert.ok(estTokens(plan.query) <= 2000, 'the query is cut');
    assert.ok(plan.texts[7].length < texts[7].length, 'the oversized candidate is cut');
    for (const g of plan.groups) {
      assert.ok(groupStateTokens(plan, g) <= MAX_STATE_TOKENS, `group of ${g.length}`);
      assert.ok(g.length <= 60);
    }
    assert.deepStrictEqual(plan.groups.flat(), texts.map((_, i) => i), 'every candidate once, in order');
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query, texts });
    assert.strictEqual(server.requests.length - n0, plan.groups.length, 'every planned request was answered');
    texts.forEach((_, i) => assert.ok(Number.isFinite(out.scores[i]), `score ${i}`));
    assert.ok(out.scores[1] > out.scores[0], 'scores stay in their places');
    assert.ok(MAX_STATE_TOKENS < STATE_TOKEN_LIMIT);
  });

  it('planBatches holds maxPerCall; clip cuts to the estimate', () => {
    assert.ok(planBatches('q', new Array(100).fill('short'), { maxPerCall: 40 }).groups.every((g) => g.length <= 40));
    assert.strictEqual(clip('abc', 10), 'abc');
    const cut = clip('w'.repeat(10000), 100);
    assert.ok(estTokens(cut) <= 100 && cut.length > 0);
    assert.ok(estTokens('"\n'.repeat(1000)) > estTokens('a'.repeat(2000)) / 2, 'escaping counts');
  });

  it('a failed group stops the groups not yet started, and the error carries the usage so far', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `gate ${i} ${'x'.repeat(3000)}`);
    const plan = planBatches('gate', texts, { maxStateTokens: 2500 });
    assert.ok(plan.groups.length >= 3);
    server.setFailure({ count: 1, status: 500 });
    const n0 = server.requests.length;
    await assert.rejects(jevScores({ ask, model: 'm', query: 'gate', texts, maxStateTokens: 2500, concurrency: 1 }),
      (err) => err.status === 500 && err.jevUsage.requests === 1);
    assert.strictEqual(server.requests.length - n0, 1);
  });

  it('an abort stops the call in flight and starts nothing more', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `gate ${i} ${'x'.repeat(3000)}`);
    server.setDelay(300);
    try {
      const c = new AbortController();
      setTimeout(() => c.abort(), 50);
      const n0 = server.requests.length;
      await assert.rejects(jevScores({ ask, model: 'm', query: 'gate', texts, maxStateTokens: 2500, concurrency: 1, abortSignal: c.signal }),
        (err) => err.name === 'AbortError');
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(server.requests.length - n0, 1);
    } finally {
      server.setDelay(0);
    }
  });

  it('noulOf refuses a missing or non-numeric score; limiter bounds concurrency', async () => {
    assert.strictEqual(noulOf({ a: { noul: 0.25 } }, 'a'), 0.25);
    for (const answers of [{}, { a: {} }, { a: { noul: null } }, { a: { noul: '0.5' } }]) {
      assert.throws(() => noulOf(answers, 'a'), (err) => err.code === 'JEV_NO_ANSWER');
    }
    const limit = limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    })));
    assert.strictEqual(peak, 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/history-jev-rerank.test.js`
Expected: FAIL, `Cannot find module '../src/history/jev-rerank'`.

- [ ] **Step 3: Write the scorer**

Create `src/history/jev-rerank.js`:

```js
// src/history/jev-rerank.js
// Scoring recall candidates with typesafe.ai's Jev (recall spec §6.3 step 6,
// rerank.kind 'jev'), shared by the app (jev-reranker.js) and LongHaul
// (src/longhaul/jev.js), so the request shapes exist once. Each candidate is
// asked a `noul` question ("does it establish what the query asks?"); the
// answer, a probability in [0, 1], is its score.
//   batched    one request per group of candidates, one question per
//              candidate (the app's mode: 0.24 s a turn at topM 100)
//   pointwise  one request per candidate (LongHaul only)
// Jev takes at most STATE_TOKEN_LIMIT tokens of state per request. Groups
// are planned on an estimate of 3 characters a token over the JSON-escaped
// text and kept under maxStateTokens (28K), so dense text still fits; a
// query longer than QUERY_MAX_TOKENS and a candidate too long for a group of
// its own are cut to fit. `ask` is the caller's transport
// (TypesafeProvider#ask, or LongHaul's retrying client); this module sends
// nothing itself. The question wording is the exp/jev-rerank probe's, word
// for word: LongHaul's score cache keys on the query and the chunk text only.
const EST_CHARS_PER_TOKEN = 3;
const STATE_TOKEN_LIMIT = 32000;
const MAX_STATE_TOKENS = 28000;
const MAX_PER_CALL = 60;
const QUERY_MAX_TOKENS = 2000;
// The state's own JSON around the query, and around each candidate.
const BASE_OVERHEAD = 200;
const PER_CANDIDATE_OVERHEAD = 80;
const MODES = Object.freeze(['batched', 'pointwise']);

const QUERY_FRAME = 'The query is a new message in a long chat between an owner and an assistant. '
  + 'Candidates are excerpts from earlier in the same chat.';
const CRITERIA = Object.freeze({
  true: 'The candidate states or establishes the specific fact, value, decision, event or result the query asks about, so it would help answer the query.',
  false: 'The candidate is merely on a similar topic, mentions the same words, or does not contain what the query asks about.'
});

const estTokens = (text) => Math.ceil(JSON.stringify(String(text ?? '')).length / EST_CHARS_PER_TOKEN);

// The text cut so its estimate is at most maxTokens.
function clip(text, maxTokens) {
  const s = String(text ?? '');
  if (estTokens(s) <= maxTokens) return s;
  let out = s.slice(0, Math.max(0, maxTokens * EST_CHARS_PER_TOKEN - 2));
  while (out.length && estTokens(out) > maxTokens) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

function pointwiseQuestion() {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does candidate_passage establish what query_excerpt asks about?`,
    criteria: { ...CRITERIA }
  };
}

function batchedQuestion(id) {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does the candidate with id "${id}" establish what the query asks about? Judge only that candidate.`,
    criteria: { ...CRITERIA }
  };
}

// Groups of candidate indexes whose state stays under maxStateTokens and
// holds at most maxPerCall candidates, in order; the query and any
// candidate too long for a group of its own come back cut.
function planBatches(query, texts, { maxStateTokens = MAX_STATE_TOKENS, maxPerCall = MAX_PER_CALL } = {}) {
  const q = clip(query, Math.min(QUERY_MAX_TOKENS, Math.floor(maxStateTokens / 4)));
  const base = estTokens(q) + BASE_OVERHEAD;
  const room = Math.max(1, maxStateTokens - base - PER_CANDIDATE_OVERHEAD);
  const items = texts.map((t) => clip(t, room));
  const groups = [];
  let cur = [];
  let used = base;
  items.forEach((text, i) => {
    const t = estTokens(text) + PER_CANDIDATE_OVERHEAD;
    if (cur.length && (used + t > maxStateTokens || cur.length >= maxPerCall)) {
      groups.push(cur);
      cur = [];
      used = base;
    }
    cur.push(i);
    used += t;
  });
  if (cur.length) groups.push(cur);
  return { query: q, texts: items, groups };
}

// The estimated state tokens of one planned group.
function groupStateTokens(plan, group) {
  return estTokens(plan.query) + BASE_OVERHEAD + group.reduce((n, i) => n + estTokens(plan.texts[i]) + PER_CANDIDATE_OVERHEAD, 0);
}

// At most `limit` calls of fn run at once.
function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function noulOf(answers, id) {
  const v = answers && answers[id] ? answers[id].noul : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw Object.assign(new Error(`typesafe.ai returned no score for candidate ${id}`), { code: 'JEV_NO_ANSWER' });
  }
  return v;
}

function abortError(signal) {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  e.cause = signal.reason;
  return e;
}

async function jevScores({
  ask, model, query, texts, mode = 'batched', maxStateTokens = MAX_STATE_TOKENS, maxPerCall = MAX_PER_CALL, concurrency = 4, abortSignal = null
}) {
  if (!MODES.includes(mode)) throw new Error(`Jev mode must be ${MODES.join(' or ')}, got ${JSON.stringify(mode)}`);
  const tally = { inputTokens: 0, outputTokens: 0, requests: 0, model: null };
  if (!texts.length) return { scores: [], ...tally };
  // One signal for every request of this call: the caller's abort, or the
  // first failure (a failed rerank keeps the fused order anyway, so the
  // other groups would be paid for nothing).
  const inner = new AbortController();
  const onAbort = () => inner.abort(abortSignal.reason);
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const limit = limiter(Math.max(1, concurrency));
  const call = (body) => limit(async () => {
    if (inner.signal.aborted) throw abortError(inner.signal);
    tally.requests += 1;
    let r;
    try {
      r = await ask(body, { abortSignal: inner.signal });
    } catch (err) {
      // Abort here, in the failing call's own continuation, so a queued
      // group sees the abort before the limiter starts it.
      inner.abort(err);
      throw err;
    }
    tally.inputTokens += Number(r?.usage?.inputTokens) || 0;
    tally.outputTokens += Number(r?.usage?.outputTokens) || 0;
    if (r?.model) tally.model = r.model;
    return r;
  });
  const scores = new Array(texts.length);
  try {
    if (mode === 'pointwise') {
      const q = clip(query, QUERY_MAX_TOKENS);
      const room = Math.max(1, maxStateTokens - estTokens(q) - BASE_OVERHEAD);
      await Promise.all(texts.map(async (text, i) => {
        const r = await call({ model, state: { query_excerpt: q, candidate_passage: clip(text, room) }, questions: { establishes: pointwiseQuestion() } });
        scores[i] = noulOf(r.answers, 'establishes');
      }));
    } else {
      const plan = planBatches(query, texts, { maxStateTokens, maxPerCall });
      await Promise.all(plan.groups.map(async (group) => {
        const ids = group.map((_, k) => `c${k + 1}`);
        const questions = {};
        for (const id of ids) questions[id] = batchedQuestion(id);
        const r = await call({ model, state: { query: plan.query, candidates: group.map((i, k) => ({ id: ids[k], text: plan.texts[i] })) }, questions });
        group.forEach((i, k) => { scores[i] = noulOf(r.answers, ids[k]); });
      }));
    }
  } catch (err) {
    inner.abort(err);
    if (err && typeof err === 'object') err.jevUsage = { ...tally };
    throw err;
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
  }
  return { scores, ...tally };
}

module.exports = {
  EST_CHARS_PER_TOKEN, STATE_TOKEN_LIMIT, MAX_STATE_TOKENS, MAX_PER_CALL, QUERY_MAX_TOKENS, MODES,
  estTokens, clip, pointwiseQuestion, batchedQuestion, planBatches, groupStateTokens, limiter, noulOf, jevScores
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/history-jev-rerank.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/jev-rerank.js tests/history-jev-rerank.test.js
git commit -m "feat(history): one Jev scorer for the app and LongHaul, groups held under the 32K state cap"
```

---

## Task 4: The `rerank.kind` and `rerank.jev` settings

**Files:**
- Modify: `src/history/settings.js` (the defaults, `mergeHistorySettings`'s `rerank`, a new export)
- Modify: `tests/history-settings.test.js` (the `RERANK` constant, the `require`, one new test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `HISTORY_DEFAULTS.recall.rerank.kind` (`'local'`), `HISTORY_DEFAULTS.recall.rerank.jev` (frozen `{ model: 'jev-latest' }`); `mergeHistorySettings(...).recall.rerank` now `{ enabled, kind, model, topM, maxMs, search, searchMaxMs, jev: { model } }`; `RERANK_KINDS` (frozen `['local', 'jev']`). `kind` is anything but `'local'` or `'jev'` → `'local'`; `jev.model` is checked with the hosted-model rule (`REMOTE_MODEL_RE`, no `.`/`..` segment).

Every LongHaul `kl-recall*` adapter's `describe()` holds the merged recall settings, so these two keys change every such adapter's answer cache key once (Decision 9): the first answer-stage run after this task re-answers its `kl-recall*` rows.

- [ ] **Step 1: Update the test**

In `tests/history-settings.test.js`, replace the `RERANK` line

```js
const RERANK = { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 };
```

with

```js
const RERANK = {
  enabled: false, kind: 'local', model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000,
  jev: { model: 'jev-latest' }
};
```

In its `require('../src/history/settings')` destructuring, add `RERANK_KINDS` after `EMBEDDER_KINDS`, so it reads

```js
const {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, RERANK_KINDS, mergeHistorySettings, embedderKey
} = require('../src/history/settings');
```

(If the current destructuring differs in layout, add `RERANK_KINDS` to it; keep every name it already imports.)

Then add this test inside `describe('history settings', …)`, right after the test `'rerank: type-checked one key at a time'`:

```js
  it('rerank.kind: local (the default) or jev; rerank.jev.model a hosted model id', () => {
    assert.deepStrictEqual(RERANK_KINDS, ['local', 'jev']);
    assert.strictEqual(mergeHistorySettings(undefined).recall.rerank.kind, 'local', 'opt-in only');
    assert.strictEqual(saved({ recall: { rerank: { kind: 'jev' } } }).recall.rerank.kind, 'jev');
    for (const kind of ['JEV', 'remote', '', null, 1, ['jev']]) {
      assert.strictEqual(saved({ recall: { rerank: { kind } } }).recall.rerank.kind, 'local', JSON.stringify(kind));
    }
    assert.strictEqual(saved({ recall: { rerank: { jev: { model: 'jev-1.13.0' } } } }).recall.rerank.jev.model, 'jev-1.13.0');
    for (const model of ['', '../x', 'a b', 42, null]) {
      assert.strictEqual(saved({ recall: { rerank: { jev: { model } } } }).recall.rerank.jev.model, 'jev-latest', JSON.stringify(model));
    }
    assert.deepStrictEqual(saved({ recall: { rerank: { jev: 'jev-1.13.0' } } }).recall.rerank.jev, { model: 'jev-latest' });
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall.rerank.jev));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/history-settings.test.js`
Expected: FAIL: the defaults test (no `kind`, no `jev`) and the new test.

- [ ] **Step 3: Add the keys**

In `src/history/settings.js`:

After `const EMBEDDER_KINDS = Object.freeze(['local', 'ollama', 'openai', 'none']);` add:

```js
// Step 6's reranker (spec §6.3): the local cross-encoder, or typesafe.ai's
// hosted Jev (opt-in: it sends the query and the top topM chunks).
const RERANK_KINDS = Object.freeze(['local', 'jev']);
```

Replace the `rerank:` line of `HISTORY_DEFAULTS.recall`

```js
    rerank: Object.freeze({ enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 }),
```

with

```js
    // kind: 'local' (this cross-encoder) or 'jev' (typesafe.ai, hosted,
    // opt-in; jev.model is what is asked for, the provenance names what
    // answered).
    rerank: Object.freeze({
      enabled: false,
      kind: 'local',
      model: 'Xenova/ms-marco-MiniLM-L-6-v2',
      topM: 100,
      maxMs: 2000,
      search: true,
      searchMaxMs: 6000,
      jev: Object.freeze({ model: 'jev-latest' })
    }),
```

In `mergeHistorySettings`, after `const rr = isObject(r.rerank) ? r.rerank : {};` add:

```js
  const rj = isObject(rr.jev) ? rr.jev : {};
```

and replace the returned `rerank: { … }` object

```js
      rerank: {
        enabled: flag(rr.enabled, d.rerank.enabled),
        model: localModel(rr.model, d.rerank.model),
        topM,
        maxMs: positive(rr.maxMs, d.rerank.maxMs),
        search: flag(rr.search, d.rerank.search),
        searchMaxMs: positive(rr.searchMaxMs, d.rerank.searchMaxMs)
      },
```

with

```js
      rerank: {
        enabled: flag(rr.enabled, d.rerank.enabled),
        kind: RERANK_KINDS.includes(rr.kind) ? rr.kind : d.rerank.kind,
        model: localModel(rr.model, d.rerank.model),
        topM,
        maxMs: positive(rr.maxMs, d.rerank.maxMs),
        search: flag(rr.search, d.rerank.search),
        searchMaxMs: positive(rr.searchMaxMs, d.rerank.searchMaxMs),
        jev: { model: remoteModel(rj.model, d.rerank.jev.model) }
      },
```

and add `RERANK_KINDS` to `module.exports`:

```js
module.exports = {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, RERANK_KINDS, LOCAL_MODEL_RE, REMOTE_MODEL_RE, mergeHistorySettings, embedderKey
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/history-settings.test.js tests/history-ipc.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-rerank.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/settings.js tests/history-settings.test.js
git commit -m "feat(history): history.recall.rerank.kind ('local' | 'jev', default local) and rerank.jev.model"
```

---

## Task 5: Which reranker ran, in the retrieval stats

**Files:**
- Modify: `src/history/retriever.js` (`_rerank`, its call in `retrieve`, the header comment)
- Modify: `src/history/context-builder.js` (two stats)
- Modify: `src/history/reranker.js` (`createHostReranker` names itself)
- Modify: `src/history/embedder-host.js` (`rerankModelName()`)
- Test: `tests/history-rerank-provenance.test.js` (new)

**Interfaces:**
- Consumes: the reranker callback contract `(query, chunks, { maxMs }) → Promise<number[]>`.
- Produces: the callback now also gets `{ maxMs, info }`, and a reranker that ran sets `info.name` (`'local:<model>'`, `'jev:<served model>'`). `Retriever#retrieve(..., stats)` sets `stats.reranker` (the name, `'unnamed'` for a reranker that set none) and `stats.rerankSkipped` (`null`) when a rerank ran; `stats.reranker = null` and `stats.rerankSkipped = <reason>` when one was on and did not run; neither when rerank is off or there was no candidate. Reasons: a `RERANK_UNAVAILABLE` error's message; `the reranker failed: <message>`; `the reranker took longer than rerank.maxMs (<n> ms)`; `the reranker returned no usable scores`. `ContextBuilder#build` → `stats.reranker` and `stats.rerankSkipped` (`null` when absent). `EmbedderHost#rerankModelName() → string`.

- [ ] **Step 1: Write the failing test**

Create `tests/history-rerank-provenance.test.js`:

```js
// tests/history-rerank-provenance.test.js
// Step 6 in provenance (recall spec §7): the retrieval stats name the
// reranker that ran, or say why a reranker that was on did not, and the
// context builder passes both on.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { createHostReranker } = require('../src/history/reranker');
const { EmbedderHost } = require('../src/history/embedder-host');
const { EmbedError } = require('../src/history/embed-errors');
const { mergeHistorySettings } = require('../src/history/settings');
const { setLogLevel } = require('../src/logging');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

setLogLevel('fatal');

const NOTES = [
  { sender: 'user', text: 'The side gate code is 4417.' },
  { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
  { sender: 'user', text: 'The gate hinge needs oil.' },
  { sender: 'user', text: 'Lunch is at noon on Fridays.' }
];
const recall = (rerank) => mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank } }).recall;
const named = (name) => async (query, chunks, { info } = {}) => {
  if (info) info.name = name;
  return chunks.map((c) => (c.text.includes('dock') ? 10 : 0));
};

describe('rerank provenance', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const setup = () => {
    t = openTempStore();
    seedChat(t.store, { messages: NOTES });
    return new Retriever({ store: t.store, estimator: new TokenEstimator() });
  };
  const run = async (retriever, rerank, reranker) => {
    const stats = {};
    const hits = await retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall(rerank), now: BASE_TIME, reranker, stats });
    return { hits, stats };
  };

  it('a reranker that ran is named; the reranked order is used', async () => {
    const r = setup();
    const { hits, stats } = await run(r, { enabled: true }, named('jev:jev-1.13.0'));
    assert.ok(hits[0].chunk.text.includes('dock'));
    assert.strictEqual(stats.reranker, 'jev:jev-1.13.0');
    assert.strictEqual(stats.rerankSkipped, null);
    const anon = await run(r, { enabled: true }, async (q, chunks) => chunks.map(() => 1));
    assert.strictEqual(anon.stats.reranker, 'unnamed');
  });

  it('rerank off: neither field is set', async () => {
    const { stats } = await run(setup(), { enabled: false }, named('x'));
    assert.strictEqual(stats.reranker, undefined);
    assert.strictEqual(stats.rerankSkipped, undefined);
  });

  it('says why a reranker that was on did not run', async () => {
    const r = setup();
    const unavailable = await run(r, { enabled: true }, async () => { throw new EmbedError('RERANK_UNAVAILABLE', 'no typesafe.ai key is saved'); });
    assert.deepStrictEqual([unavailable.stats.reranker, unavailable.stats.rerankSkipped], [null, 'no typesafe.ai key is saved']);
    const failed = await run(r, { enabled: true }, async () => { throw new Error('typesafe.ai failed (HTTP 500)'); });
    assert.strictEqual(failed.stats.rerankSkipped, 'the reranker failed: typesafe.ai failed (HTTP 500)');
    const slow = await run(r, { enabled: true, maxMs: 30 }, () => new Promise((resolve) => setTimeout(() => resolve([1, 1, 1]), 500)));
    assert.strictEqual(slow.stats.rerankSkipped, 'the reranker took longer than rerank.maxMs (30 ms)');
    const bad = await run(r, { enabled: true }, async () => [1]);
    assert.strictEqual(bad.stats.rerankSkipped, 'the reranker returned no usable scores');
    assert.strictEqual(bad.stats.reranker, null);
  });

  it('the context builder passes both on (null when rerank is off)', async () => {
    const retriever = setup();
    const build = async (rerank, reranker) => {
      const builder = new ContextBuilder({
        store: t.store, retriever, estimator: new TokenEstimator(),
        getSettings: () => ({ history: { version: 3, recall: { tailUserTurns: 1, rerank } } })
      });
      return (await builder.build({ chatId: 'chat-1', message: 'Which gate sticks?', upToSeq: 5, reranker })).stats;
    };
    const on = await build({ enabled: true }, named('local:Xenova/ms-marco-MiniLM-L-6-v2'));
    assert.strictEqual(on.reranker, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    assert.strictEqual(on.rerankSkipped, null);
    const off = await build({ enabled: false }, named('x'));
    assert.strictEqual(off.reranker, null);
    assert.strictEqual(off.rerankSkipped, null);
  });

  it('the local cross-encoder names itself local:<model>', async () => {
    const host = { rerank: async (q, texts) => texts.map(() => 0.5), rerankModelName: () => 'Xenova/ms-marco-MiniLM-L-6-v2' };
    const info = {};
    assert.deepStrictEqual(await createHostReranker(host)('gate', [{ text: 'a' }, { text: 'b' }], { maxMs: 100, info }), [0.5, 0.5]);
    assert.strictEqual(info.name, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    const embedderHost = new EmbedderHost({
      getSettings: () => ({ history: { recall: { rerank: { model: 'Xenova/other-reranker' } } } }),
      modelsDir: os.tmpdir(), createRunner: () => { throw new Error('not used'); }, createProvider: () => { throw new Error('not used'); }
    });
    assert.strictEqual(embedderHost.rerankModelName(), 'Xenova/other-reranker');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/history-rerank-provenance.test.js`
Expected: FAIL: `stats.reranker` is `undefined` where a name is expected, and `rerankModelName is not a function`.

- [ ] **Step 3: Record it in the Retriever**

In `src/history/retriever.js`:

In the header comment, replace the line

```js
// dedupeCosine) and whatever vectorSearch records. Step 2 takes the vector ranks from
```

with

```js
// dedupeCosine), reranker / rerankSkipped (step 6: the reranker that ran, or
// why one that was on did not) and whatever vectorSearch records. Step 2
// takes the vector ranks from
```

(Comment only; the line after it, `// the caller (vectorHits) or from the vectorSearch callback; step 6 takes a`, stays.)

After `const SHINGLE_WORDS = 5;` add:

```js
// A rerankSkipped reason is at most this long (provenance, the recall line).
const REASON_MAX = 200;
```

Replace the whole `_rerank` method (from its leading comment `// Step 6: the reranker rescores the first topM candidates` through its closing brace) with:

```js
  // Step 6: the reranker rescores the first topM candidates (already held to
  // the scope, the kinds and upToSeq) and its score replaces theirs; they
  // sort by it, and every other candidate keeps its score and order below
  // them. A reranker that throws, returns anything but one finite number
  // per chunk, or takes longer than rerank.maxMs (spec §15) leaves the order
  // as it was for this turn. stats gets reranker (info.name, set by the
  // reranker: 'local:<model>', 'jev:<model>') or rerankSkipped (why not).
  async _rerank(query, items, rerank, reranker, stats = null) {
    const note = (name, skipped) => {
      if (stats && typeof stats === 'object') {
        stats.reranker = name;
        stats.rerankSkipped = skipped === null ? null : String(skipped).slice(0, REASON_MAX);
      }
    };
    const m = Math.min(items.length, rerank.topM);
    if (m < 1) return items;
    const head = items.slice(0, m);
    const maxMs = Number.isFinite(rerank.maxMs) && rerank.maxMs > 0 ? rerank.maxMs : HISTORY_DEFAULTS.recall.rerank.maxMs;
    const info = {};
    let timer = null;
    let scores;
    try {
      scores = await Promise.race([
        Promise.resolve().then(() => reranker(query, head.map((item) => item.chunk), { maxMs, info })),
        new Promise((resolve) => { timer = setTimeout(resolve, maxMs, TIMED_OUT); })
      ]);
    } catch (err) {
      const reason = String((err && err.message) || err);
      // No reranker yet (the EmbedderHost starts with the background checks:
      // never under KL_TEST_MODE, not before startup finishes), or a hosted
      // one with no key or paused: the fused order, silently, with one debug
      // line per Retriever. The reranker itself warns the owner.
      if (err && err.code === 'RERANK_UNAVAILABLE') {
        if (!this._rerankUnavailableLogged) {
          this._rerankUnavailableLogged = true;
          log.debug('no reranker yet; keeping the fused order', { pairs: m });
        }
        note(null, reason);
        return items;
      }
      log.warn('reranker failed; keeping the fused order', { error: reason, pairs: m });
      note(null, `the reranker failed: ${reason}`);
      return items;
    } finally {
      clearTimeout(timer);
    }
    if (scores === TIMED_OUT) {
      log.warn('reranker slower than rerank.maxMs; keeping the fused order', { pairs: m, maxMs });
      note(null, `the reranker took longer than rerank.maxMs (${maxMs} ms)`);
      return items;
    }
    const list = scores && typeof scores.length === 'number' ? Array.from(scores) : null;
    if (!list || list.length !== m || !list.every(Number.isFinite)) {
      log.warn('reranker returned no usable scores; keeping the fused order', { pairs: m, got: list ? list.length : null });
      note(null, 'the reranker returned no usable scores');
      return items;
    }
    note(typeof info.name === 'string' && info.name ? info.name : 'unnamed', null);
    const reranked = head
      .map((item, i) => ({ ...item, score: list[i], signals: { ...item.signals, rerank: list[i], fused: item.score } }))
      .sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
    return [...reranked, ...items.slice(m)];
  }
```

In `retrieve`, replace

```js
    const deduped = rerank.enabled && rerankWith ? await this._rerank(query, unique, rerank, rerankWith) : unique;
```

with

```js
    const deduped = rerank.enabled && rerankWith ? await this._rerank(query, unique, rerank, rerankWith, stats) : unique;
```

- [ ] **Step 4: Pass it on in the context builder**

In `src/history/context-builder.js`, in `build`'s returned `stats`, after `vectorsSkipped: retrieval.vectorsSkipped ?? null,` add:

```js
        // Which reranker ran this turn (spec §6.3 step 6, §7), or why one
        // that was on did not; both null when rerank is off.
        reranker: retrieval.reranker ?? null,
        rerankSkipped: retrieval.rerankSkipped ?? null,
```

- [ ] **Step 5: Name the local cross-encoder**

Replace `src/history/reranker.js` with:

```js
// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
// It names itself in info.name ('local:<model>') for provenance.
function createHostReranker(host) {
  return async (query, chunks, { maxMs, info } = {}) => {
    const model = typeof host.rerankModelName === 'function' ? host.rerankModelName() : null;
    const scores = await host.rerank(String(query), chunks.map((c) => String(c.text)), { maxMs });
    if (info && typeof info === 'object' && model) info.name = `local:${model}`;
    return scores;
  };
}

module.exports = { createHostReranker };
```

In `src/history/embedder-host.js`, add this method right before `async rerank(query, texts, { maxMs = Infinity } = {}) {`:

```js
  // The cross-encoder rerank() would use now (provenance names it).
  rerankModelName() {
    return this._settings().recall.rerank.model;
  }

```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/history-rerank-provenance.test.js tests/history-retriever.test.js tests/history-search-rerank.test.js tests/history-context-builder.test.js tests/history-embedder-host.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/history/retriever.js src/history/context-builder.js src/history/reranker.js src/history/embedder-host.js tests/history-rerank-provenance.test.js
git commit -m "feat(history): retrieval stats name the reranker that ran, or why one that was on did not"
```

---

## Task 6: `JevReranker` and the reranker dispatch

**Files:**
- Create: `src/history/jev-reranker.js`
- Modify: `src/history/reranker.js` (add `createRecallReranker`)
- Modify: `src/history/embedder-host.js` (`preloadReranker` skips the cross-encoder when `kind` is `'jev'`)
- Test: `tests/history-jev-reranker.test.js` (new)

**Interfaces:**
- Consumes: `jevScores` (Task 3), `TypesafeProvider` (Task 2; injected through `createProvider`), `mergeHistorySettings` with `rerank.kind` / `rerank.jev.model` (Task 4), the `{ maxMs, info }` contract (Task 5), `EmbedError`.
- Produces: `new JevReranker({ getSettings, getKey, createProvider, notify = () => {}, now = Date.now, env = process.env, slowDownMs = 30000, concurrency = 4, log })` with `start()`, `async stop()` (aborts calls in flight), `reset()` (a new or removed key, or Retry: lifts a pause or a hold-off and ends the episode), `status() → { kind, model, state: 'off' | 'not-started' | 'no-key' | 'refused' | 'failing' | 'ready', error, hasKey, tokens, requests }`, `async rerank(query, texts, { maxMs, info }) → number[]`. Throws `EmbedError` codes: `RERANK_UNAVAILABLE` (KL_TEST_MODE, not started, no key, paused, held off: nothing sent), `RERANK_REFUSED` (401/403, or 402 / `insufficient_quota`), `RERANK_TIMEOUT` (aborted at `maxMs`), `RERANK_FAILED` (anything else). `createRecallReranker({ host, jev, getSettings }) → (query, chunks, { maxMs, info }) → Promise<number[]>`: `kind 'jev'` → `jev.rerank`, else the local cross-encoder.

Exact messages (provenance and the warning use them): `hosted reranking is off under KL_TEST_MODE`; `the hosted reranker is not started`; `no typesafe.ai key is saved (Settings > History and recall)`; `the saved typesafe.ai key is not valid`; `typesafe.ai refused the key (<status>); save a new key or press Retry`; `typesafe.ai says the account is out of credit (<status>); add credit, then press Retry`; `typesafe.ai asked to slow down (<status>)`; `typesafe.ai asked to slow down; reranking resumes shortly`; `typesafe.ai took longer than <n> ms`; `typesafe.ai failed (<HTTP n | code | network error>)`. The owner's warning is `Recall reranking with typesafe.ai is skipped: <message>`, once per episode (an episode ends at the next success or `reset()`).

- [ ] **Step 1: Write the failing test**

Create `tests/history-jev-reranker.test.js`:

```js
// tests/history-jev-reranker.test.js
// The hosted reranker (recall spec §6.3 step 6, §15): nothing sent with kind
// local, under KL_TEST_MODE, before start or with no key; one warning per
// failure episode; a refused key pauses it until reset; a 429 holds it off;
// a call slower than maxMs is aborted at the provider; a failure that lands
// after a switch changes nothing; Vault text is never sent. Loopback fake
// server only.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { JevReranker } = require('../src/history/jev-reranker');
const { createRecallReranker } = require('../src/history/reranker');
const { EmbedderHost } = require('../src/history/embedder-host');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { searchHistoryExcerpts } = require('../src/history/search');
const { mergeHistorySettings } = require('../src/history/settings');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const { setLogLevel } = require('../src/logging');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

setLogLevel('fatal');

const KEY = 'test-key-not-real-0001';
const TEXTS = ['the side gate code is 4417', 'grocery list'];
const jevSettings = (kind = 'jev', over = {}) => ({ history: mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank: { kind, enabled: true, ...over } } }) });
const waitFor = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('JevReranker', () => {
  let server;
  let key;
  let settings;
  let t = null;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());
  beforeEach(() => {
    key = KEY;
    settings = jevSettings();
    server.setFailure({ count: 0 });
    server.setDelay(0);
  });
  afterEach(() => {
    if (t) t.cleanup();
    t = null;
  });

  const make = ({ now, env = {} } = {}) => {
    const notes = [];
    const jev = new JevReranker({
      getSettings: () => settings, getKey: () => key,
      createProvider: (k) => new TypesafeProvider(k, { baseUrl: server.url }),
      notify: (toast) => notes.push(toast), env, ...(now ? { now } : {})
    });
    return { jev, notes };
  };

  it('scores with Jev batched, names the served model and counts the tokens', async () => {
    const { jev, notes } = make();
    jev.start();
    const info = {};
    const n0 = server.requests.length;
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS, { maxMs: 2000, info }), [1, 0]);
    assert.strictEqual(info.name, 'jev:jev-1.13.0');
    assert.strictEqual(server.requests.length - n0, 1);
    assert.strictEqual(server.requests.at(-1).body.model, 'jev-latest');
    assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
    const st = jev.status();
    assert.strictEqual(st.state, 'ready');
    assert.strictEqual(st.model, 'jev-1.13.0');
    assert.strictEqual(st.hasKey, true);
    assert.ok(st.tokens > 0);
    assert.strictEqual(st.requests, 1);
    assert.strictEqual(notes.length, 0);
  });

  it('sends nothing under KL_TEST_MODE, before start, or with no key (one warning for the missing key)', async () => {
    const n0 = server.requests.length;
    const test = make({ env: { KL_TEST_MODE: '1' } });
    test.jev.start();
    await assert.rejects(test.jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /KL_TEST_MODE/.test(err.message));
    const idle = make();
    await assert.rejects(idle.jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /not started/.test(err.message));
    assert.strictEqual(idle.jev.status().state, 'not-started');
    key = null;
    const { jev, notes } = make();
    jev.start();
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /^no typesafe\.ai key is saved/.test(err.message));
    }
    assert.strictEqual(jev.status().state, 'no-key');
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(test.notes.length + idle.notes.length, 0);
    assert.strictEqual(server.requests.length, n0, 'nothing reached typesafe.ai');
  });

  it('a key revoked mid-session (401) pauses Jev with one warning until reset (Review Focus 3)', async () => {
    const { jev, notes } = make();
    jev.start();
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    server.setFailure({ count: 1, status: 401 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED' && /refused the key \(401\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'refused');
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].body, /^Recall reranking with typesafe\.ai is skipped: typesafe\.ai refused the key \(401\)/);
    const n = server.requests.length;
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /refused the key/.test(err.message));
    assert.strictEqual(server.requests.length, n, 'nothing sent while paused');
    assert.strictEqual(notes.length, 1);
    jev.reset();
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(jev.status().state, 'ready');
  });

  it('a 429 holds Jev off for retry-after, then it resumes; a 402 pauses it (new episode, new warning)', async () => {
    let clock = 1000;
    const { jev, notes } = make({ now: () => clock });
    jev.start();
    server.setFailure({ count: 1, status: 429, retryAfter: 3 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => /asked to slow down \(429\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'failing');
    const n = server.requests.length;
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /resumes shortly/.test(err.message));
    assert.strictEqual(server.requests.length, n, 'nothing sent while held off');
    clock += 3001;
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(notes.length, 1);
    server.setFailure({ count: 1, status: 402 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED' && /out of credit \(402\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'refused');
    assert.strictEqual(notes.length, 2);
  });

  it('a call slower than maxMs is aborted at the provider; one warning; a success ends the episode (Review Focus 2)', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(3000);
    const aborted0 = server.aborted();
    const t0 = Date.now();
    await assert.rejects(jev.rerank('gate code', TEXTS, { maxMs: 50 }), (err) => err.code === 'RERANK_TIMEOUT' && /longer than 50 ms/.test(err.message));
    assert.ok(Date.now() - t0 < 1500);
    await waitFor(() => server.aborted() > aborted0);
    assert.strictEqual(notes.length, 1);
    server.setDelay(0);
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS, { maxMs: 2000 }), [1, 0]);
    assert.strictEqual(jev.status().error, null);
    server.setFailure({ count: 1, status: 500 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_FAILED' && /typesafe\.ai failed \(HTTP 500\)/.test(err.message));
    assert.strictEqual(notes.length, 2, 'a new episode after the success');
  });

  it('a failure that lands after a switch to local, or after a new key, changes nothing (Review Focus 4)', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(150);
    server.setFailure({ count: 1, status: 401 });
    const p = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    settings = jevSettings('local');
    await assert.rejects(p);
    assert.strictEqual(jev.status().state, 'off');
    settings = jevSettings('jev');
    assert.strictEqual(jev.status().state, 'ready', 'no refusal held from the old call');
    server.setFailure({ count: 1, status: 401 });
    const q = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    key = 'test-key-not-real-0002';
    jev.reset();
    await assert.rejects(q);
    assert.strictEqual(jev.status().state, 'ready');
    assert.strictEqual(notes.length, 0);
    server.setDelay(0);
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(server.requests.at(-1).auth, 'Bearer test-key-not-real-0002', 'the new key is used');
  });

  it('stop() aborts a call in flight without a warning', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(3000);
    const p = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    await jev.stop();
    await assert.rejects(p);
    assert.strictEqual(notes.length, 0);
    assert.strictEqual(jev.status().state, 'not-started');
  });

  it('dispatch: kind local uses the cross-encoder and sends nothing, even with a key saved (Review Focus 5)', async () => {
    const calls = [];
    const host = {
      rerank: async (q, texts) => { calls.push(texts.length); return texts.map(() => 0.5); },
      rerankModelName: () => 'Xenova/ms-marco-MiniLM-L-6-v2'
    };
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host, jev, getSettings: () => settings });
    settings = jevSettings('local');
    const n = server.requests.length;
    const info = {};
    assert.deepStrictEqual(await reranker('gate code', [{ text: 'a' }, { text: 'b' }], { maxMs: 2000, info }), [0.5, 0.5]);
    assert.strictEqual(info.name, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    assert.strictEqual(server.requests.length, n);
    settings = jevSettings('jev');
    const info2 = {};
    assert.deepStrictEqual(await reranker('gate code', TEXTS.map((text) => ({ text })), { maxMs: 2000, info: info2 }), [1, 0]);
    assert.strictEqual(info2.name, 'jev:jev-1.13.0');
    assert.deepStrictEqual(calls, [2]);
  });

  it('per turn: a Jev call slower than rerank.maxMs leaves the fused order and says why', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: 'The side gate code is 4417.' },
      { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
      { sender: 'user', text: 'Lunch is at noon.' }
    ] });
    settings = jevSettings('jev', { maxMs: 50 });
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host: { rerank: async () => [] }, jev, getSettings: () => settings });
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker });
    server.setDelay(3000);
    const stats = {};
    const t0 = Date.now();
    const hits = await retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: settings.history.recall, now: BASE_TIME, stats });
    assert.ok(Date.now() - t0 < 1500, 'the turn does not wait for typesafe.ai');
    assert.ok(hits.length >= 2);
    assert.strictEqual(stats.reranker, null);
    assert.match(stats.rerankSkipped, /longer than rerank\.maxMs \(50 ms\)/);
  });

  it('Vault results make no chunks, so their text never reaches typesafe.ai', async () => {
    const SECRET = 'zq7-invented-secret-5550142';
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: 'Store the invented test password and then read it back for the form.' },
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'store', key: 'signup_password', value: SECRET } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, message: 'Secret "signup_password" stored securely.' } },
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'retrieve', key: 'signup_password' } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, key: 'signup_password', value: SECRET }, text: `value ${SECRET}` },
      { sender: 'assistant', text: 'Stored and read back; the password form field is filled.' }
    ] });
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host: { rerank: async () => { throw new Error('not used'); } }, jev, getSettings: () => settings });
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker });
    const n = server.requests.length;
    const out = await searchHistoryExcerpts({
      store: t.store, retriever, chatId: 'chat-1', query: 'password form', limit: 10, settings: settings.history.recall, reranker, asOf: BASE_TIME
    });
    assert.ok(out.length >= 1);
    const sent = server.requests.slice(n);
    assert.ok(sent.length >= 1, 'the other chunks were reranked by Jev');
    for (const r of sent) assert.ok(!r.raw.includes(SECRET), 'no Vault text in any request');
  });

  it('with kind jev the cross-encoder is not preloaded', async () => {
    const runner = new FakeEmbedRunner();
    const host = new EmbedderHost({
      getSettings: () => ({ history: { recall: { rerank: { kind: 'jev', search: true } } } }),
      modelsDir: os.tmpdir(), createRunner: () => runner, createProvider: () => { throw new Error('not used'); }
    });
    host.start();
    await waitFor(() => host.status().state === 'ready');
    host.preloadReranker();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(runner.calls.filter((c) => c.op === 'load' && c.role === 'reranker').length, 0);
    await host.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/history-jev-reranker.test.js`
Expected: FAIL, `Cannot find module '../src/history/jev-reranker'`.

- [ ] **Step 3: Write `JevReranker`**

Create `src/history/jev-reranker.js`:

```js
// src/history/jev-reranker.js
// The hosted reranker (recall spec §6.3 step 6, §15): typesafe.ai's Jev,
// used when history.recall.rerank.kind is 'jev' (opt-in). It scores the
// top rerank.topM chunks through jevScores (batched) over TypesafeProvider.
// The host builds one and calls start() only from startHistoryEmbedding,
// which startModelsBackgroundChecks never calls under KL_TEST_MODE; under
// KL_TEST_MODE it also refuses on its own, before any request.
// Failures never fail a turn: rerank() throws and the Retriever keeps the
// fused order. Nothing sent: RERANK_UNAVAILABLE (no key, paused, held off,
// not started). A refused key (401/403) or an account out of credit (402,
// insufficient_quota) pauses Jev until reset() (a new key, a removed key,
// Retry); a 429/529 holds it off for the server's retry-after (slowDownMs
// without one); a call slower than maxMs is aborted at the provider. The
// owner gets one warning per failure episode (one toast and one log line);
// an episode ends at the next success or reset(). A failure that lands after
// reset() or after a switch away from 'jev' changes nothing. Messages carry
// statuses and codes only, never chat text.
const { mergeHistorySettings } = require('./settings');
const { EmbedError } = require('./embed-errors');
const { jevScores } = require('./jev-rerank');
const { createLogger } = require('../logging');

const SLOW_DOWN_MS = 30000;
const CONCURRENCY = 4;

class JevReranker {
  constructor({
    getSettings, getKey, createProvider, notify = () => {}, now = Date.now, env = process.env,
    slowDownMs = SLOW_DOWN_MS, concurrency = CONCURRENCY, log = createLogger('history/jev')
  }) {
    this.getSettings = getSettings;
    this.getKey = getKey;
    this.createProvider = createProvider;
    this.notify = notify;
    this.now = now;
    this.env = env || {};
    this.slowDownMs = slowDownMs;
    this.concurrency = concurrency;
    this.log = log;
    this.started = false;
    this.generation = 0;
    this.provider = null;
    this.providerKey = null;
    this.refused = null;
    this.slowUntil = 0;
    this.error = null;
    this.episode = false;
    this.tokens = 0;
    this.requests = 0;
    this.servedModel = null;
    this.inFlight = new Set();
  }

  start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
    for (const c of this.inFlight) c.abort(new EmbedError('EMBED_STOPPED', 'the hosted reranker stopped'));
    this.inFlight.clear();
  }

  // A new or removed key, or Retry: whatever paused or held Jev off is
  // lifted, the next failure warns again, and a call still in flight from
  // before can no longer change the state.
  reset() {
    this.generation += 1;
    this.refused = null;
    this.slowUntil = 0;
    this.error = null;
    this.episode = false;
    this.provider = null;
    this.providerKey = null;
  }

  status() {
    const rerank = this._rerankSettings();
    const hasKey = Boolean(this._key());
    let state;
    if (rerank.kind !== 'jev') state = 'off';
    else if (!this.started) state = 'not-started';
    else if (!hasKey) state = 'no-key';
    else if (this.refused && this.refused.generation === this.generation) state = 'refused';
    else if (this.error) state = 'failing';
    else state = 'ready';
    return { kind: rerank.kind, model: this.servedModel || rerank.jev.model, state, error: this.error, hasKey, tokens: this.tokens, requests: this.requests };
  }

  async rerank(query, texts, { maxMs = Infinity, info = null } = {}) {
    if (this.env.KL_TEST_MODE) throw new EmbedError('RERANK_UNAVAILABLE', 'hosted reranking is off under KL_TEST_MODE');
    if (!this.started) throw new EmbedError('RERANK_UNAVAILABLE', 'the hosted reranker is not started');
    const key = this._key();
    if (!key) {
      const message = 'no typesafe.ai key is saved (Settings > History and recall)';
      this._warn(message);
      throw new EmbedError('RERANK_UNAVAILABLE', message);
    }
    if (this.refused && this.refused.generation === this.generation) throw new EmbedError('RERANK_UNAVAILABLE', this.refused.message);
    if (this.now() < this.slowUntil) throw new EmbedError('RERANK_UNAVAILABLE', 'typesafe.ai asked to slow down; reranking resumes shortly');
    let provider;
    try {
      provider = this._providerFor(key);
    } catch {
      const message = 'the saved typesafe.ai key is not valid';
      this.refused = { generation: this.generation, message };
      this.error = message;
      this._warn(message);
      throw new EmbedError('RERANK_UNAVAILABLE', message);
    }
    const { model } = this._rerankSettings().jev;
    const gen = this.generation;
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = Number.isFinite(maxMs) && maxMs > 0
      ? setTimeout(() => controller.abort(new EmbedError('RERANK_TIMEOUT', `typesafe.ai took longer than ${maxMs} ms`)), maxMs)
      : null;
    try {
      const out = await jevScores({
        ask: (body, options) => provider.ask(body, options), model, query: String(query), texts: texts.map(String),
        mode: 'batched', concurrency: this.concurrency, abortSignal: controller.signal
      });
      this._count(out);
      if (gen === this.generation) {
        this.servedModel = out.model || model;
        this.error = null;
        this.episode = false;
      }
      if (info && typeof info === 'object') info.name = `jev:${out.model || model}`;
      return out.scores;
    } catch (err) {
      this._count(err && err.jevUsage);
      const failure = this._describe(err, controller.signal);
      if (gen === this.generation && this.started && this._rerankSettings().kind === 'jev') this._apply(failure);
      throw new EmbedError(failure.code, failure.message);
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  _rerankSettings() {
    return mergeHistorySettings((this.getSettings() || {}).history).recall.rerank;
  }

  _key() {
    try {
      const k = this.getKey();
      return typeof k === 'string' && k.trim() ? k.trim() : null;
    } catch (err) {
      this.log.debug(`The typesafe.ai key could not be read: ${err.message}`);
      return null;
    }
  }

  _providerFor(key) {
    if (!this.provider || this.providerKey !== key) {
      this.provider = this.createProvider(key);
      this.providerKey = key;
    }
    return this.provider;
  }

  _count(usage) {
    if (!usage) return;
    this.tokens += Number(usage.inputTokens) || 0;
    this.requests += Number(usage.requests) || 0;
  }

  _describe(err, signal) {
    const reason = signal.aborted ? signal.reason : null;
    if (reason && reason.code === 'RERANK_TIMEOUT') return { kind: 'failed', code: 'RERANK_TIMEOUT', message: reason.message };
    if (signal.aborted) return { kind: 'stopped', code: 'RERANK_FAILED', message: 'the hosted rerank was stopped' };
    const status = err && Number.isInteger(err.status) ? err.status : null;
    const ids = [err && err.type, err && err.code].map((v) => String(v || '').toLowerCase());
    if (status === 401 || status === 403) {
      return { kind: 'refused', code: 'RERANK_REFUSED', message: `typesafe.ai refused the key (${status}); save a new key or press Retry` };
    }
    if (status === 402 || ids.includes('insufficient_quota')) {
      return { kind: 'refused', code: 'RERANK_REFUSED', message: `typesafe.ai says the account is out of credit (${status ?? 'quota'}); add credit, then press Retry` };
    }
    if (status === 429 || status === 529) {
      return { kind: 'slow', code: 'RERANK_FAILED', message: `typesafe.ai asked to slow down (${status})`, retryAfterMs: err.retryAfterMs };
    }
    const what = status ? `HTTP ${status}` : (err && err.name === 'TypeError' ? 'network error' : (err && (err.code || err.name)) || 'error');
    return { kind: 'failed', code: 'RERANK_FAILED', message: `typesafe.ai failed (${what})` };
  }

  _apply(failure) {
    if (failure.kind === 'stopped') return;
    if (failure.kind === 'refused') this.refused = { generation: this.generation, message: failure.message };
    if (failure.kind === 'slow') {
      const wait = Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0 ? failure.retryAfterMs : this.slowDownMs;
      this.slowUntil = this.now() + wait;
    }
    this.error = failure.message;
    this._warn(failure.message);
  }

  _warn(message) {
    if (this.episode) return;
    this.episode = true;
    const text = `Recall reranking with typesafe.ai is skipped: ${message}`;
    this.log.warn(text);
    try {
      this.notify({ title: 'King Louie', body: text });
    } catch (err) {
      this.log.warn(`Recall warning could not be shown: ${err.message}`);
    }
  }
}

module.exports = { JevReranker, SLOW_DOWN_MS };
```

- [ ] **Step 4: Dispatch on `rerank.kind`**

In `src/history/reranker.js`, add at the top, after the header comment:

```js
const { mergeHistorySettings } = require('./settings');
```

and before `module.exports`:

```js
// The reranker the Retriever and SearchHistory get (spec §6.3 step 6):
// rerank.kind 'jev' sends to typesafe.ai through the JevReranker, anything
// else runs the local cross-encoder. Read per call, so a saved switch
// applies to the next turn; a Jev failure keeps the fused order and never
// falls back to the cross-encoder.
function createRecallReranker({ host, jev, getSettings }) {
  const local = createHostReranker(host);
  return (query, chunks, options = {}) => {
    const { kind } = mergeHistorySettings((getSettings() || {}).history).recall.rerank;
    if (kind === 'jev' && jev) return jev.rerank(String(query), chunks.map((c) => String(c.text)), options);
    return local(query, chunks, options);
  };
}
```

and change the export to `module.exports = { createHostReranker, createRecallReranker };`.

- [ ] **Step 5: Skip the cross-encoder preload when Jev reranks**

In `src/history/embedder-host.js`, in `preloadReranker()`, replace

```js
    if (!rerank.search && !rerank.enabled) return;
```

with

```js
    if (!rerank.search && !rerank.enabled) return;
    // Jev reranks instead (rerank.kind 'jev'): the cross-encoder's download
    // would buy nothing.
    if (rerank.kind === 'jev') return;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/history-jev-reranker.test.js tests/history-embedder-host.test.js tests/history-search-rerank.test.js tests/history-vault.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/history/jev-reranker.js src/history/reranker.js src/history/embedder-host.js tests/history-jev-reranker.test.js
git commit -m "feat(history): JevReranker, opt-in hosted rerank with one warning per failure episode; dispatch on rerank.kind"
```

---

## Task 7: The core: the key, the start gate, and the history IPC

**Files:**
- Modify: `src/core/create-core.js` (imports, the token store key, the reranker wiring, `startHistoryEmbedding`, the key functions, `shutdown`, the context)
- Modify: `src/ipc/history-handlers.js` (the embedder section, two new channels)
- Modify: `src/ipc/constants.js`, `preload.js`
- Modify: `tests/history-ipc.test.js` (one pinned line)
- Test: `tests/history-core-jev.test.js`, `tests/history-ipc-jev.test.js` (new)

**Interfaces:**
- Consumes: `JevReranker` and `createRecallReranker` (Task 6), `TypesafeProvider` (Task 2), the ElevenLabs key pattern (`getApiTokens`, `setApiTokens`, `encryptToken`, `decryptToken`).
- Produces: core `context.getJevReranker()`, `context.hasTypesafeKey() → boolean`, `context.saveTypesafeKey(key)` (trims, encrypts into `apiTokens.__typesafe_api_key`, then `jevReranker.reset()`), `context.clearTypesafeKey()` (removes it, then `reset()`); `context.getHistoryReranker()` is now the dispatcher; `deps.history.createJevProvider(key)` (tests only; default `new TypesafeProvider(key, { catalog })`). IPC: `history:embedder.status` / `.save` / `.retry` replies gain `jev` (the `JevReranker#status()` view) and `settings.rerank.kind`; `history:embedder.save` takes `rerank.kind` and `confirmJev`, and refuses switching to `'jev'` without `confirmJev: true`; `history:embedder.retry` also resets Jev; new `history:jev.saveKey` (`{ key }`, 8 to 512 characters, no whitespace) and `history:jev.clearKey`, both answering with the status view and never the key. Constants `HISTORY_JEV_SAVE_KEY`, `HISTORY_JEV_CLEAR_KEY`; preload `window.electron.history.saveJevKey({ key })`, `clearJevKey()`.

Where the key lives, read from the code: provider tokens are `store.get('apiTokens')` in the core's store (`chat-data.json`), each value `cipher.encryptString(token)` (Electron `safeStorage` on the desktop, the AES-GCM master key in service mode); non-chat keys share it under a `__` name (`__elevenlabs_api_key`, `__telegram_bot_token`). `chat-data.json` is in `SECRET_FILE_PREFIXES` for every tool, and the `Vault` tool reads only `context.vault` (`createVault({ store: vaultStore })`, `config.json`), so the model cannot read the key through either.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-core-jev.test.js`:

```js
// tests/history-core-jev.test.js
// The core with the hosted reranker (recall spec §6.3 step 6, §14): the key
// is stored encrypted with the provider tokens and the Vault tool cannot
// read it; under KL_TEST_MODE nothing is sent; after startHistoryEmbedding a
// turn with kind jev is reranked by Jev and provenance names it; saving a
// key lifts a refusal; shutdown stops it. Loopback fake server, fake runner.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { mergeHistorySettings } = require('../src/history/settings');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const vaultTool = require('../src/tools/builtin/vault-tool');

const KEY = 'test-key-not-real-0001';
const tempDirs = [];
let server;
let savedTestMode;

before(async () => {
  server = await startFakeJevServer();
  savedTestMode = process.env.KL_TEST_MODE;
  delete process.env.KL_TEST_MODE;
});
after(async () => {
  await server.close();
  if (savedTestMode === undefined) delete process.env.KL_TEST_MODE;
  else process.env.KL_TEST_MODE = savedTestMode;
});
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-jev-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  return {
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    history: { createEmbedRunner: () => new FakeEmbedRunner(), createJevProvider: (key) => new TypesafeProvider(key, { baseUrl: server.url }) }
  };
}

const jevHistory = () => mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank: { kind: 'jev', enabled: true } } });
function seed(ctx) {
  ctx.createChat({ id: 'c1', title: 'Lakeside lot', messages: [] });
  for (const text of ['The linen bandage goes in the canopic jar.', 'The side gate code is 4417.', 'Lunch is at noon on Fridays.', 'The canopic jar sits on the top shelf.']) {
    ctx.appendMessageToChat('c1', 'user', text);
  }
}
const ask = (ctx) => ctx.getContextBuilder().build({ chatId: 'c1', message: 'Where is the canopic jar?', upToSeq: 5 });

describe('createCore with the hosted reranker', () => {
  it('stores the key encrypted with the provider tokens; the Vault tool cannot read it', async () => {
    const deps = makeDeps();
    const core = createCore(deps);
    await core.start();
    const ctx = core.context;
    try {
      assert.strictEqual(ctx.hasTypesafeKey(), false);
      ctx.saveTypesafeKey(`  ${KEY}  `);
      assert.strictEqual(ctx.hasTypesafeKey(), true);
      const stored = deps.store.get('apiTokens', {}).__typesafe_api_key;
      assert.strictEqual(typeof stored, 'string');
      assert.notStrictEqual(stored, KEY, 'encrypted at rest');
      assert.strictEqual(deps.cipher.decryptString(stored), KEY);
      assert.ok(!JSON.stringify(ctx.getSettings()).includes(KEY), 'never in settings');
      const got = await vaultTool.execute({ action: 'retrieve', key: '__typesafe_api_key' }, { vault: ctx.vault });
      assert.strictEqual(got.ok, false);
      const listed = await vaultTool.execute({ action: 'list' }, { vault: ctx.vault });
      assert.ok(!listed.keys.includes('__typesafe_api_key'));
      ctx.clearTypesafeKey();
      assert.strictEqual(ctx.hasTypesafeKey(), false);
    } finally {
      await core.shutdown();
    }
  });

  it('under KL_TEST_MODE a turn with kind jev and a key saved sends nothing (Review Focus 5)', async () => {
    process.env.KL_TEST_MODE = '1';
    const core = createCore(makeDeps());
    try {
      await core.start();
      const ctx = core.context;
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      const n0 = server.requests.length;
      assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: true });
      const built = await ask(ctx);
      assert.strictEqual(built.stats.reranker, null);
      assert.match(built.stats.rerankSkipped, /KL_TEST_MODE|not started/);
      assert.strictEqual(server.requests.length, n0, 'nothing reached typesafe.ai');
      assert.strictEqual(ctx.getJevReranker().status().state, 'not-started');
    } finally {
      delete process.env.KL_TEST_MODE;
      await core.shutdown();
    }
  });

  it('after startHistoryEmbedding, kind jev reranks the turn and SearchHistory; provenance names it; shutdown stops it', async () => {
    const core = createCore(makeDeps());
    await core.start();
    const ctx = core.context;
    try {
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      ctx.startHistoryEmbedding();
      const n0 = server.requests.length;
      const built = await ask(ctx);
      assert.strictEqual(built.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(built.stats.rerankSkipped, null);
      assert.ok(server.requests.length > n0);
      assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
      const st = ctx.getJevReranker().status();
      assert.strictEqual(st.state, 'ready');
      assert.ok(st.tokens > 0);
      const info = {};
      await ctx.getHistoryReranker()('jar', [{ text: 'the canopic jar' }], { maxMs: 2000, info });
      assert.strictEqual(info.name, 'jev:jev-1.13.0', 'SearchHistory gets the same dispatcher');
    } finally {
      await core.shutdown();
    }
    assert.strictEqual(ctx.getJevReranker().status().state, 'not-started');
  });

  it('a refused key pauses Jev; saving a key lifts it (Review Focus 3)', async () => {
    const core = createCore(makeDeps());
    await core.start();
    const ctx = core.context;
    try {
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      ctx.startHistoryEmbedding();
      server.setFailure({ count: 1, status: 401 });
      const refused = await ask(ctx);
      assert.match(refused.stats.rerankSkipped, /refused the key \(401\)/);
      assert.strictEqual(ctx.getJevReranker().status().state, 'refused');
      ctx.saveTypesafeKey('test-key-not-real-0002');
      assert.strictEqual(ctx.getJevReranker().status().state, 'ready');
      const again = await ask(ctx);
      assert.strictEqual(again.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(server.requests.at(-1).auth, 'Bearer test-key-not-real-0002');
    } finally {
      await core.shutdown();
    }
  });
});
```

Create `tests/history-ipc-jev.test.js`:

```js
// tests/history-ipc-jev.test.js
// The history IPC for the hosted reranker (recall spec §14): the status
// carries the reranker and the Jev view; choosing jev needs the explicit
// confirmation; the key goes in and never comes back; Retry resets Jev.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { mergeHistorySettings } = require('../src/history/settings');

const KEY = 'test-key-not-real-0001';

describe('history IPC: the hosted reranker', () => {
  let settings;
  let saved;
  let cleared;
  let resets;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const jev = {
    status: () => ({ kind: settings.history.recall.rerank.kind, model: 'jev-latest', state: 'ready', error: null, hasKey: saved.length > 0, tokens: 12, requests: 1 }),
    reset() { resets += 1; }
  };
  registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    getJevReranker: () => jev,
    saveTypesafeKey: (k) => { saved.push(k); },
    clearTypesafeKey: () => { cleared += 1; }
  });
  beforeEach(() => {
    settings = { history: mergeHistorySettings({}) };
    saved = [];
    cleared = 0;
    resets = 0;
  });

  it('status: the reranker kind and the Jev view', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_STATUS, {});
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true, kind: 'local' });
    assert.strictEqual(out.jev.state, 'ready');
    assert.strictEqual(out.jev.tokens, 12);
  });

  it('choosing jev needs confirmJev; local and staying on jev do not (Review Focus 5)', async () => {
    const refused = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev' } });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /Allow sending to typesafe\.ai/);
    assert.strictEqual(settings.history.recall.rerank.kind, 'local', 'nothing saved');
    const ok = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev', enabled: true }, confirmJev: true });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(settings.history.recall.rerank.kind, 'jev');
    assert.strictEqual(ok.settings.rerank.kind, 'jev');
    const stay = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev', enabled: false } });
    assert.strictEqual(stay.ok, true, 'already chosen: no second confirmation');
    const back = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'local' } });
    assert.strictEqual(back.ok, true);
    assert.strictEqual(settings.history.recall.rerank.kind, 'local');
    const bad = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'remote' }, confirmJev: true });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Not a valid reranker/);
  });

  it('saveKey: checks the shape, saves it trimmed, never answers with it; clearKey removes it', async () => {
    for (const key of [undefined, 42, 'short', 'has a space inside', 'x'.repeat(513)]) {
      const out = await call(IPC.HISTORY_JEV_SAVE_KEY, { key });
      assert.strictEqual(out.ok, false, JSON.stringify(key));
    }
    assert.deepStrictEqual(saved, []);
    const out = await call(IPC.HISTORY_JEV_SAVE_KEY, { key: `  ${KEY}\n` });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(saved, [KEY]);
    assert.ok(!JSON.stringify(out).includes(KEY), 'the key never comes back');
    assert.strictEqual(out.jev.hasKey, true);
    const gone = await call(IPC.HISTORY_JEV_CLEAR_KEY, {});
    assert.strictEqual(gone.ok, true);
    assert.strictEqual(cleared, 1);
  });

  it('Retry resets Jev', async () => {
    await call(IPC.HISTORY_EMBEDDER_RETRY, {});
    assert.strictEqual(resets, 1);
  });
});
```

In `tests/history-ipc.test.js`, replace

```js
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true });
```

with

```js
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true, kind: 'local' });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-core-jev.test.js tests/history-ipc-jev.test.js tests/history-ipc.test.js`
Expected: FAIL: `ctx.hasTypesafeKey is not a function`, `IPC.HISTORY_JEV_SAVE_KEY` undefined (`handlers.get(undefined)` is not a function), and the pinned `rerank` view.

- [ ] **Step 3: Wire the core**

In `src/core/create-core.js`:

Replace

```js
const { createHostReranker } = require('../history/reranker');
```

with

```js
const { createRecallReranker } = require('../history/reranker');
const { JevReranker } = require('../history/jev-reranker');
const TypesafeProvider = require('../providers/typesafe-provider');
```

After `const ELEVENLABS_TOKEN_STORE_KEY = '__elevenlabs_api_key';` add:

```js
  const TYPESAFE_TOKEN_STORE_KEY = '__typesafe_api_key';
```

Replace

```js
  const historyReranker = createHostReranker(embedderHost);
```

with

```js
  // Step 6's hosted reranker (rerank.kind 'jev', opt-in): typesafe.ai's Jev.
  // It starts with startHistoryEmbedding, never under KL_TEST_MODE; its key
  // is read only when a rerank runs (getDecryptedTypesafeKey is declared
  // further down). The dispatcher picks it or the cross-encoder per call.
  const jevReranker = new JevReranker({
    getSettings: () => getSettings(),
    getKey: () => getDecryptedTypesafeKey(),
    createProvider: typeof deps.history?.createJevProvider === 'function'
      ? deps.history.createJevProvider
      : (key) => new TypesafeProvider(key, { catalog }),
    notify: (toast) => {
      if (!deps.uiToastChannel || typeof deps.uiToastChannel.send !== 'function') return;
      Promise.resolve()
        .then(() => deps.uiToastChannel.send(toast))
        .catch((err) => historyLog.warn(`Recall warning toast failed: ${err.message}`));
    }
  });
  const historyReranker = createRecallReranker({ host: embedderHost, jev: jevReranker, getSettings: () => getSettings() });
```

Replace

```js
  const startHistoryEmbedding = () => {
    if (historyStatus.available) embedderHost.start();
  };
```

with

```js
  const startHistoryEmbedding = () => {
    if (historyStatus.available) {
      embedderHost.start();
      jevReranker.start();
    }
  };
```

After the `getDecryptedElevenLabsToken` function (the one ending `return decryptToken(encryptedToken);\n  };` right after `clearElevenLabsToken`) add:

```js
  // typesafe.ai's key for the hosted reranker (recall spec §14): stored like
  // a provider token, encrypted, in the store (a secret file for every
  // tool); the Vault tool reads only the vault, so it cannot read it.
  // Saving or removing it lifts a refusal Jev holds for the old key.
  const hasTypesafeKey = () => Boolean(getApiTokens()[TYPESAFE_TOKEN_STORE_KEY]);

  const saveTypesafeKey = (token) => {
    const tokens = getApiTokens();
    tokens[TYPESAFE_TOKEN_STORE_KEY] = encryptToken(String(token).trim());
    setApiTokens(tokens);
    jevReranker.reset();
  };

  const clearTypesafeKey = () => {
    const tokens = getApiTokens();
    delete tokens[TYPESAFE_TOKEN_STORE_KEY];
    setApiTokens(tokens);
    jevReranker.reset();
  };

  const getDecryptedTypesafeKey = () => {
    const encrypted = getApiTokens()[TYPESAFE_TOKEN_STORE_KEY];
    return encrypted ? decryptToken(encrypted) : null;
  };
```

In `shutdown()`, after

```js
    await withTimeout(embedderHost.stop(), shutdownTimeoutMs, 'Embed worker shutdown', warnTimeout)
      .catch((err) => log.warn(`Embed worker shutdown failed: ${err.message}`));
```

add

```js
    await jevReranker.stop();
```

In the `context` object, after `getHistoryReranker: () => historyReranker,` add:

```js
    getJevReranker: () => jevReranker,
    hasTypesafeKey,
    saveTypesafeKey,
    clearTypesafeKey,
```

- [ ] **Step 4: The IPC**

In `src/ipc/constants.js`, after `HISTORY_EMBEDDER_RETRY: 'history:embedder.retry',` add:

```js
  HISTORY_JEV_SAVE_KEY: 'history:jev.saveKey',
  HISTORY_JEV_CLEAR_KEY: 'history:jev.clearKey',
```

In `src/ipc/history-handlers.js`, replace everything from the line `  // The embedder (recall spec §5.2, §14). Host strings (an error, a model` down to (not including) the closing `}` of `registerHistoryHandlers` with:

```js
  // The embedder (recall spec §5.2, §14) and the reranker (§6.3 step 6).
  // Host strings (an error, a model id) are shown with textContent. The
  // typesafe.ai key goes in through history:jev.saveKey and never comes back.
  const OFF = Object.freeze({ kind: 'none', key: null, state: 'off', download: null, error: null, tokens: 0 });
  const JEV_OFF = Object.freeze({ kind: 'local', model: null, state: 'off', error: null, hasKey: false, tokens: 0, requests: 0 });
  const hostOf = () => (typeof context.getEmbedderHost === 'function' ? context.getEmbedderHost() : null);
  const jevOf = () => (typeof context.getJevReranker === 'function' ? context.getJevReranker() : null);
  const settingsNow = () => ((typeof context.getSettings === 'function' && context.getSettings()) || {});
  const pick = (o, keys) => {
    const out = {};
    if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const embedderView = () => {
    const host = hostOf();
    const jev = jevOf();
    const indexer = typeof context.getEmbedIndexer === 'function' ? context.getEmbedIndexer() : null;
    const history = mergeHistorySettings(settingsNow().history);
    const rerank = history.recall.rerank;
    return {
      ok: true,
      untrustedText: true,
      status: host ? host.status() : { ...OFF },
      progress: indexer ? indexer.progress() : null,
      jev: jev ? jev.status() : { ...JEV_OFF, kind: rerank.kind },
      settings: { embedder: history.embedder, rerank: { enabled: rerank.enabled, search: rerank.search, kind: rerank.kind } }
    };
  };

  handle(IPC.HISTORY_EMBEDDER_STATUS, async () => embedderView());

  handle(IPC.HISTORY_EMBEDDER_SAVE, async ({ embedder, rerank, confirmJev }) => {
    if (typeof context.setSettings !== 'function') throw new Error('Settings are not available in this host.');
    const all = settingsNow();
    const current = mergeHistorySettings(all.history);
    const e = embedder && typeof embedder === 'object' ? embedder : {};
    const wanted = {
      ...current,
      embedder: {
        ...current.embedder,
        ...pick(e, ['kind', 'model']),
        ollama: { ...current.embedder.ollama, ...pick(e.ollama, ['baseUrl', 'model']) },
        openai: { ...current.embedder.openai, ...pick(e.openai, ['model']) }
      },
      recall: { ...current.recall, rerank: { ...current.recall.rerank, ...pick(rerank, ['enabled', 'search', 'kind']) } }
    };
    const next = mergeHistorySettings(wanted);
    // A value the merge would replace with its default is refused, never
    // saved as something the owner did not type.
    const trim = (v) => (typeof v === 'string' ? v.replace(/\/+$/, '') : v);
    const checks = [
      ['embedder kind', wanted.embedder.kind, next.embedder.kind],
      ['local model', wanted.embedder.model, next.embedder.model],
      ['Ollama address', trim(wanted.embedder.ollama.baseUrl), next.embedder.ollama.baseUrl],
      ['Ollama model', wanted.embedder.ollama.model, next.embedder.ollama.model],
      ['OpenAI model', wanted.embedder.openai.model, next.embedder.openai.model],
      ['per-turn rerank', wanted.recall.rerank.enabled, next.recall.rerank.enabled],
      ['SearchHistory rerank', wanted.recall.rerank.search, next.recall.rerank.search],
      ['reranker', wanted.recall.rerank.kind, next.recall.rerank.kind]
    ];
    const refused = checks.find(([, given, kept]) => given !== kept);
    if (refused) return { ok: false, error: `Not a valid ${refused[0]}: ${JSON.stringify(refused[1])}` };
    // Opt-in (spec §14): Jev sends chat excerpts to typesafe.ai, so the
    // switch to it needs the pane's explicit confirmation.
    if (next.recall.rerank.kind === 'jev' && current.recall.rerank.kind !== 'jev' && confirmJev !== true) {
      return { ok: false, error: 'Jev sends excerpts of your chats to typesafe.ai: tick "Allow sending to typesafe.ai" to choose it.' };
    }
    context.setSettings({ ...all, history: next });
    return embedderView();
  });

  handle(IPC.HISTORY_EMBEDDER_REBUILD, async () => {
    const host = hostOf();
    const key = host ? host.status().key : null;
    if (!key) return { ok: false, error: 'Embeddings are off.' };
    const removed = store().deleteEmbeddings(key);
    return { ...embedderView(), removed };
  });

  handle(IPC.HISTORY_EMBEDDER_RETRY, async () => {
    const host = hostOf();
    const jev = jevOf();
    if (!host && !jev) return { ok: false, error: 'Embeddings are not available in this host.' };
    if (host) host.retry();
    if (jev) jev.reset();
    return embedderView();
  });

  handle(IPC.HISTORY_JEV_SAVE_KEY, async ({ key }) => {
    if (typeof context.saveTypesafeKey !== 'function') throw new Error('The typesafe.ai key cannot be saved in this host.');
    const k = typeof key === 'string' ? key.trim() : '';
    if (k.length < 8 || k.length > 512 || /\s/.test(k)) return { ok: false, error: 'That does not look like a typesafe.ai key.' };
    context.saveTypesafeKey(k);
    return embedderView();
  });

  handle(IPC.HISTORY_JEV_CLEAR_KEY, async () => {
    if (typeof context.clearTypesafeKey !== 'function') throw new Error('The typesafe.ai key cannot be removed in this host.');
    context.clearTypesafeKey();
    return embedderView();
  });
```

In `preload.js`, in `history: { … }`, replace

```js
      retryEmbedder: () => ipcRenderer.invoke('history:embedder.retry')
```

with

```js
      retryEmbedder: () => ipcRenderer.invoke('history:embedder.retry'),
      // The typesafe.ai key goes in once and is never read back.
      saveJevKey: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.key, 'key', { minLength: 8 });
        return ipcRenderer.invoke('history:jev.saveKey', payload);
      },
      clearJevKey: () => ipcRenderer.invoke('history:jev.clearKey')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/history-core-jev.test.js tests/history-ipc-jev.test.js tests/history-ipc.test.js tests/history-core-embeddings.test.js tests/history-core.test.js tests/ipc-constants.test.js tests/desktop-bridge-allowlist.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/core/create-core.js src/ipc/history-handlers.js src/ipc/constants.js preload.js tests/history-core-jev.test.js tests/history-ipc-jev.test.js tests/history-ipc.test.js
git commit -m "feat(history): the core wires the Jev reranker; its key is stored encrypted like a provider token, behind an explicit opt-in"
```

---

## Task 8: Provenance on the send path, the recall line and the settings pane

**Files:**
- Modify: `src/ipc/chat-handlers.js` (`turnContext`)
- Modify: `renderer.js` (`recallVia`, the History and recall pane functions)
- Modify: `index.html` (the History and recall tab)
- Test: `tests/renderer-history-rerank.test.js` (new)

**Interfaces:**
- Consumes: `built.stats.reranker` / `built.stats.rerankSkipped` (Task 5); the IPC view `out.jev` and `out.settings.rerank.kind`, `window.electron.history.saveJevKey` / `clearJevKey`, `confirmJev` (Task 7).
- Produces: every assistant reply's `context` gains `reranker` and `rerankSkipped`; `recallVia(context)` ends in ` · reranked` when `context.reranker` is set; `historyRerankStatusText(jev) → string`; the pane's controls `history-rerank-kind`, `history-rerank-jev-confirm`, `history-rerank-jev-note`, `history-jev-key`, `history-jev-key-save-btn`, `history-jev-key-clear-btn`, `history-rerank-status`.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer-history-rerank.test.js`:

```js
// tests/renderer-history-rerank.test.js
// The reranker in the UI (recall spec §7, §14): the recall line says
// "reranked" when one ran, the pane says what Jev is doing and what it
// sends, saving it needs the confirmation, the key field is cleared and
// never filled from the host, and the send path copies the provenance.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');
const chat = read('src/ipc/chat-handlers.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: the reranker', () => {
  it('the recall line says reranked when a reranker ran', () => {
    const line = new Function(`${block('function formatCompactTokens(', '\nfunction renderRecallLine(')}; return recallLineText;`)();
    const base = { recalledExcerpts: 3, estTokens: { recalled: 1900 }, fullHistoryEstTokens: 412000 };
    assert.match(line({ ...base, embedder: 'local:Xenova/all-MiniLM-L6-v2', reranker: 'jev:jev-1.13.0' }), / · BM25 \+ vectors · reranked$/);
    assert.match(line({ ...base, embedder: 'none', reranker: 'local:Xenova/ms-marco-MiniLM-L-6-v2' }), / · BM25 · reranked$/);
    assert.match(line({ ...base, embedder: 'none', reranker: null, rerankSkipped: 'no typesafe.ai key is saved' }), / · BM25$/);
    assert.match(line({ ...base, embedder: 'none' }), / · BM25$/);
  });

  it('says what Jev is doing, with tokens and no price', () => {
    const f = new Function(`${block('function historyRerankStatusText(', '\nfunction stopHistoryStatusPoll(')}; return historyRerankStatusText;`)();
    assert.strictEqual(f(undefined), 'Reranking runs on this computer.');
    assert.strictEqual(f({ kind: 'local', state: 'off' }), 'Reranking runs on this computer.');
    assert.strictEqual(f({ kind: 'jev', state: 'not-started' }), 'Jev starts with the app’s background checks.');
    assert.strictEqual(f({ kind: 'jev', state: 'no-key' }), 'Jev is chosen, but no typesafe.ai key is saved: results keep their order.');
    assert.strictEqual(f({ kind: 'jev', state: 'refused', error: 'typesafe.ai refused the key (401); save a new key or press Retry' }),
      'Jev is paused, results keep their order: typesafe.ai refused the key (401); save a new key or press Retry');
    assert.strictEqual(f({ kind: 'jev', state: 'failing', error: 'typesafe.ai failed (HTTP 500)', tokens: 120 }),
      'Jev failed last time, results kept their order: typesafe.ai failed (HTTP 500). 120 tokens sent this session (price unknown).');
    assert.strictEqual(f({ kind: 'jev', state: 'ready', model: 'jev-1.13.0', tokens: 2400 }),
      'Jev is ready (jev-1.13.0). 2400 tokens sent this session (price unknown).');
    assert.doesNotMatch(f({ kind: 'jev', state: 'ready', tokens: 5 }), /\$/);
  });

  it('the pane: the choice, the one plain sentence, the confirmation and the key field', () => {
    for (const id of ['history-rerank-kind', 'history-rerank-jev-confirm', 'history-rerank-jev-note', 'history-jev-key',
      'history-jev-key-save-btn', 'history-jev-key-clear-btn', 'history-rerank-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /<option value="local">On this computer \(cross-encoder\)<\/option>/);
    assert.match(html, /<option value="jev">typesafe\.ai Jev \(hosted, opt-in\)<\/option>/);
    assert.match(html, /Jev sends your new message and about 100 excerpts of this chat to typesafe\.ai each time it reranks\./);
    assert.match(html, /<input id="history-jev-key"[^>]*type="password"/);
  });

  it('text by textContent only; the key field is cleared at once and never filled; saving sends the confirmation', () => {
    const pane = block('function historyRerankStatusText(', '\nfunction wireHistorySettings(');
    assert.doesNotMatch(pane, /innerHTML/);
    assert.match(pane, /textContent = historyRerankStatusText\(/);
    assert.strictEqual((pane.match(/'history-jev-key'/g) || []).length, 1, 'read in one place only');
    assert.match(pane, /input\.value = '';/);
    assert.match(pane, /confirmJev: document\.getElementById\('history-rerank-jev-confirm'\)\.checked/);
    assert.match(pane, /kind: document\.getElementById\('history-rerank-kind'\)\.value/);
    const wire = block('function wireHistorySettings(', '\nif (document.readyState');
    assert.match(wire, /on\('history-jev-key-save-btn', saveHistoryJevKey\)/);
    assert.match(wire, /on\('history-jev-key-clear-btn', clearHistoryJevKey\)/);
  });

  it('preload exposes the key channels; the send path copies the provenance', () => {
    for (const ch of ['history:jev.saveKey', 'history:jev.clearKey']) {
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${ch.replace('.', '\\.')}'`), ch);
    }
    assert.match(chat, /reranker: built\.stats\.reranker \?\? null/);
    assert.match(chat, /rerankSkipped: built\.stats\.rerankSkipped \?\? null/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/renderer-history-rerank.test.js`
Expected: FAIL: `found function historyRerankStatusText(` and the pane ids.

- [ ] **Step 3: Provenance on the send path**

In `src/ipc/chat-handlers.js`, in the `turnContext = { … }` object, after `vectorsSkipped: built.stats.vectorsSkipped ?? null,` add:

```js
          // Which reranker ran (spec §6.3 step 6, §7), or why one that was
          // on did not.
          reranker: built.stats.reranker ?? null,
          rerankSkipped: built.stats.rerankSkipped ?? null,
```

- [ ] **Step 4: The recall line**

In `renderer.js`, replace

```js
// Which retrieval a reply's recall ran (provenance embedder, vectorsSkipped).
function recallVia(context) {
  if (context?.embedder && context.embedder !== 'none') return 'BM25 + vectors';
  return context?.vectorsSkipped ? `BM25 only: ${context.vectorsSkipped}` : 'BM25';
}
```

with

```js
// Which retrieval a reply's recall ran (provenance embedder, vectorsSkipped)
// and whether a reranker ran (provenance reranker).
function recallVia(context) {
  let via = 'BM25';
  if (context?.embedder && context.embedder !== 'none') via = 'BM25 + vectors';
  else if (context?.vectorsSkipped) via = `BM25 only: ${context.vectorsSkipped}`;
  return context?.reranker ? `${via} · reranked` : via;
}
```

- [ ] **Step 5: The pane's functions**

In `renderer.js`, right before `function stopHistoryStatusPoll() {`, add:

```js
// The reranker (recall spec §6.3 step 6, §14). Jev is hosted and unpriced:
// the pane shows the tokens sent, never a price.
function historyRerankStatusText(jev) {
  const j = jev || {};
  if (j.kind !== 'jev') return 'Reranking runs on this computer.';
  const sent = ` ${Number(j.tokens) || 0} tokens sent this session (price unknown).`;
  switch (j.state) {
    case 'not-started': return 'Jev starts with the app’s background checks.';
    case 'no-key': return 'Jev is chosen, but no typesafe.ai key is saved: results keep their order.';
    case 'refused': return `Jev is paused, results keep their order: ${j.error || 'typesafe.ai refused the key'}`;
    case 'failing': return `Jev failed last time, results kept their order: ${j.error || 'unknown error'}.${sent}`;
    case 'ready': return `Jev is ready${j.model ? ` (${j.model})` : ''}.${sent}`;
    default: return '';
  }
}

```

Replace the whole `refreshHistoryEmbedderStatus` function with:

```js
async function refreshHistoryEmbedderStatus() {
  const el = document.getElementById('history-embedder-status');
  if (!el || !window.electron?.history?.embedderStatus) return null;
  const out = await window.electron.history.embedderStatus();
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Could not read the embedding status: ${(out && out.error) || 'unknown error'}`;
  const rerankEl = document.getElementById('history-rerank-status');
  if (rerankEl && out && out.ok) rerankEl.textContent = historyRerankStatusText(out.jev);
  return out;
}
```

In `loadHistorySettings`, after

```js
    document.getElementById('history-rerank-turn').checked = Boolean(out.settings.rerank.enabled);
```

add

```js
    const kind = out.settings.rerank.kind === 'jev' ? 'jev' : 'local';
    document.getElementById('history-rerank-kind').value = kind;
    document.getElementById('history-rerank-jev-confirm').checked = kind === 'jev';
```

Replace the whole `saveHistorySettings` function with:

```js
async function saveHistorySettings() {
  const el = document.getElementById('history-embedder-status');
  const val = (id) => document.getElementById(id).value.trim();
  const out = await window.electron.history.saveEmbedder({
    embedder: {
      kind: document.getElementById('history-embedder-kind').value,
      model: val('history-embedder-model'),
      ollama: { baseUrl: val('history-ollama-url'), model: val('history-ollama-model') },
      openai: { model: val('history-openai-model') }
    },
    rerank: {
      search: document.getElementById('history-rerank-search').checked,
      enabled: document.getElementById('history-rerank-turn').checked,
      kind: document.getElementById('history-rerank-kind').value
    },
    // Choosing Jev sends excerpts to typesafe.ai: the host refuses the
    // switch unless this box is ticked.
    confirmJev: document.getElementById('history-rerank-jev-confirm').checked
  });
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Not saved: ${(out && out.error) || 'unknown error'}`;
  const rerankEl = document.getElementById('history-rerank-status');
  if (rerankEl && out && out.ok) rerankEl.textContent = historyRerankStatusText(out.jev);
}

// The typesafe.ai key: sent once, the field cleared at once, never read
// back from the host.
async function saveHistoryJevKey() {
  const input = document.getElementById('history-jev-key');
  const key = input.value.trim();
  input.value = '';
  const status = document.getElementById('history-rerank-status');
  if (key.length < 8 || /\s/.test(key)) {
    status.textContent = 'That does not look like a typesafe.ai key.';
    return;
  }
  const out = await window.electron.history.saveJevKey({ key });
  status.textContent = out && out.ok ? historyRerankStatusText(out.jev) : `Key not saved: ${(out && out.error) || 'unknown error'}`;
}

async function clearHistoryJevKey() {
  if (!window.confirm('Remove the saved typesafe.ai key? Jev stops reranking until a key is saved again.')) return;
  const out = await window.electron.history.clearJevKey();
  document.getElementById('history-rerank-status').textContent = out && out.ok
    ? historyRerankStatusText(out.jev)
    : `Key not removed: ${(out && out.error) || 'unknown error'}`;
}
```

In `wireHistorySettings`, after `on('history-embedder-save-btn', saveHistorySettings);` add:

```js
  on('history-jev-key-save-btn', saveHistoryJevKey);
  on('history-jev-key-clear-btn', clearHistoryJevKey);
```

- [ ] **Step 6: The pane's controls**

In `index.html`, in the History and recall tab, replace

```html
              <label for="history-rerank-search">Rerank SearchHistory results</label>
              <input id="history-rerank-search" type="checkbox">
            </div>
```

with

```html
              <label for="history-rerank-search">Rerank SearchHistory results</label>
              <input id="history-rerank-search" type="checkbox">

              <label for="history-rerank-kind">Reranker</label>
              <select id="history-rerank-kind" class="provider-input">
                <option value="local">On this computer (cross-encoder)</option>
                <option value="jev">typesafe.ai Jev (hosted, opt-in)</option>
              </select>

              <label for="history-rerank-jev-confirm">Allow sending to typesafe.ai</label>
              <span>
                <input id="history-rerank-jev-confirm" type="checkbox">
                <span id="history-rerank-jev-note" class="provider-message">Jev sends your new message and about 100 excerpts of this chat to typesafe.ai each time it reranks.</span>
              </span>

              <label for="history-jev-key">typesafe.ai key</label>
              <span>
                <input id="history-jev-key" class="provider-input" type="password" autocomplete="off" spellcheck="false" placeholder="A saved key is never shown">
                <button id="history-jev-key-save-btn" type="button" class="btn">Save key</button>
                <button id="history-jev-key-clear-btn" type="button" class="btn">Remove key</button>
              </span>
            </div>
            <p id="history-rerank-status" class="provider-message"></p>
```

(Match the file's own line endings; the tests normalise CRLF.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/renderer-history-rerank.test.js tests/renderer-history-settings.test.js tests/renderer-history-text.test.js tests/history-core-embeddings.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 8: Check it in the app (manual, no key needed)**

```bash
unset ELECTRON_RUN_AS_NODE && npm start
```

Open Settings > History and recall: the Reranker choice, the sentence, the confirmation box and the key field show. Choose "typesafe.ai Jev", leave the box unticked, Save: the status line reads `Not saved: Jev sends excerpts of your chats to typesafe.ai: tick "Allow sending to typesafe.ai" to choose it.` Set it back to "On this computer" and Save. Enter no real key. Quit.

- [ ] **Step 9: Commit**

```bash
git add src/ipc/chat-handlers.js renderer.js index.html tests/renderer-history-rerank.test.js
git commit -m "feat(ui): the reranker choice, its opt-in and key in History and recall; the recall line says reranked"
```

---

## Task 9: LongHaul's Jev client on the app's provider

**Files:**
- Create: `src/longhaul/jev.js`
- Test: `tests/longhaul-jev.test.js` (new)

**Interfaces:**
- Consumes: `TypesafeProvider` (Task 2), `jevScores`, `limiter`, `MODES` (Task 3), `withRetries(fn, { isRetryable })` and `retryable` (Task 1, quota never retried), `UsageError`.
- Produces: `JEV_DEFAULT_MODEL` (`'jev-1.13.0'`), `DEFAULT_MODE` (`'batched'`), `DEFAULT_MAX_TOKENS` (20,000,000), `OVERHEAD_TOKENS` (`{ pointwise: 450, batched: 120 }`), `JEV_STOP_CODES` (`['JEV_SCORES_MISSING', 'JEV_OVER_TOKENS', 'JEV_MODEL_MISMATCH']`); `createJevClient({ apiKey, baseUrl, model, provider, concurrency = 24, timeoutMs = 60000, retries = 6, baseDelayMs = 500, wait, maxTokens = null, now }) → { ask(body, { abortSignal }), usage, model, concurrency }` (throws `UsageError` with no key; `ask` retries 429/529/5xx/timeouts/network errors, never 401/402/422/quota; refuses with `JEV_OVER_TOKENS` once `usage.inputTokens` reaches `maxTokens`; with a pinned model, a response naming another model is `JEV_MODEL_MISMATCH`); `createJevScorer({ client, mode = 'batched', calibration }) → { model: '<client model>-<mode>', score(query, texts) }`; `estimateJevTokens({ questions, topM, chunkCount, meanChunkTokens, mode }) → number`; `newCalibration()`, `calibrationSummary(cal)`, `usageSummary(usage)` (with `usd: null`, `price: 'unknown'`).

One client implementation: the probe's own `fetch` client is not ported; every request is `TypesafeProvider#ask` through `BaseProvider.request`, every request shape is `jevScores`. The model is pinned to `jev-1.13.0` so scores cached under `rerank/<session>/jev-1.13.0-<mode>/` (the probe's directory, whose `jev-latest` answers were `jev-1.13.0`) never mix with a later model's (Open Question 1).

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-jev.test.js`:

```js
// tests/longhaul-jev.test.js
// LongHaul's Jev client (src/longhaul/jev.js) on the app's TypesafeProvider
// and jevScores: batched by default, the pinned model, retries, refusals
// that are never retried, the timeout, the token cap and the served-model
// check; the cost is unpriced. Loopback fake server; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createJevClient, createJevScorer, estimateJevTokens, usageSummary, newCalibration, calibrationSummary,
  JEV_DEFAULT_MODEL, DEFAULT_MODE, OVERHEAD_TOKENS
} = require('../src/longhaul/jev');
const { UsageError } = require('../src/longhaul/errors');
const { startFakeJevServer } = require('./helpers/fake-jev-server');

const KEY = 'test-key-not-real-0001';
const noWait = async () => {};
const Q = { state: { query_excerpt: 'a', candidate_passage: 'a' }, questions: { establishes: { type: 'noul', instructions: 'x' } } };

describe('LongHaul Jev client', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  it('batched by default; asks for the pinned model; counts usage; unpriced', async () => {
    assert.strictEqual(DEFAULT_MODE, 'batched');
    assert.strictEqual(JEV_DEFAULT_MODEL, 'jev-1.13.0');
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const cal = newCalibration();
    const scorer = createJevScorer({ client, calibration: cal });
    assert.strictEqual(scorer.model, 'jev-1.13.0-batched');
    const n0 = server.requests.length;
    const scores = await scorer.score('side gate code', ['the side gate code is 4417', 'grocery list', 'the gate']);
    assert.deepStrictEqual(scores.map((s) => Math.round(s * 3)), [3, 0, 1]);
    assert.strictEqual(server.requests.length - n0, 1);
    assert.strictEqual(server.requests.at(-1).body.model, 'jev-1.13.0');
    assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
    assert.strictEqual(client.usage.ok, 1);
    assert.ok(client.usage.inputTokens > 0);
    assert.deepStrictEqual(client.usage.models, { 'jev-1.13.0': 1 });
    assert.strictEqual(calibrationSummary(cal).scores, 3);
    const s = usageSummary(client.usage);
    assert.strictEqual(s.usd, null, 'Jev is unpriced: never $0');
    assert.strictEqual(s.price, 'unknown');
    assert.strictEqual(s.inputTokens, client.usage.inputTokens);
  });

  it('pointwise: one request per pair; a bad mode is refused', async () => {
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const scorer = createJevScorer({ client, mode: 'pointwise' });
    assert.strictEqual(scorer.model, 'jev-1.13.0-pointwise');
    const n0 = server.requests.length;
    assert.deepStrictEqual(await scorer.score('gate code', ['the gate code is 4417', 'weather', 'gate']), [1, 0, 0.5]);
    assert.strictEqual(server.requests.length - n0, 3);
    assert.throws(() => createJevScorer({ client, mode: 'listwise' }), (err) => err instanceof UsageError && /batched or pointwise/.test(err.message));
  });

  it('retries a 429 and a 529 with a growing backoff, then succeeds', async () => {
    const flaky = await startFakeJevServer({ failFirst: 2 });
    try {
      const waits = [];
      const client = createJevClient({ apiKey: KEY, baseUrl: flaky.url, wait: async (ms) => { waits.push(ms); } });
      const r = await client.ask(Q);
      assert.strictEqual(r.answers.establishes.noul, 1);
      assert.strictEqual(client.usage.retries, 2);
      assert.deepStrictEqual(client.usage.status, { 429: 2, 200: 1 });
      assert.ok(waits[1] > waits[0], 'the backoff grows');
      flaky.setFailure({ count: 1, status: 529 });
      await client.ask(Q);
      assert.strictEqual(client.usage.retries, 3);
    } finally {
      await flaky.close();
    }
  });

  it('fails a 422, a 401 and a 402 at once, with the status only (never the body)', async () => {
    for (const status of [422, 401, 402]) {
      const bad = await startFakeJevServer({ failFirst: 5, failStatus: status, failBody: { detail: 'state echo: the side gate code is 4417' } });
      try {
        const client = createJevClient({ apiKey: KEY, baseUrl: bad.url, wait: noWait });
        await assert.rejects(client.ask(Q), (err) => err.status === status && !err.message.includes('4417'));
        assert.strictEqual(bad.requests.length, 1, `${status} is not retried`);
        assert.strictEqual(client.usage.failed, 1);
      } finally {
        await bad.close();
      }
    }
  });

  it('times out a request that never answers and retries it; refuses past the token cap; needs a key', async () => {
    const hung = await startFakeJevServer({ delayMs: 2000 });
    try {
      const client = createJevClient({ apiKey: KEY, baseUrl: hung.url, timeoutMs: 30, retries: 1, wait: noWait });
      await assert.rejects(client.ask(Q), (err) => err.code === 'JEV_TIMEOUT');
      assert.strictEqual(client.usage.timeouts, 2);
    } finally {
      await hung.close();
    }
    const capped = createJevClient({ apiKey: KEY, baseUrl: server.url, maxTokens: 1, wait: noWait });
    await capped.ask(Q);
    const n = server.requests.length;
    await assert.rejects(capped.ask(Q), (err) => err instanceof UsageError && err.code === 'JEV_OVER_TOKENS');
    assert.strictEqual(server.requests.length, n, 'nothing sent past the cap');
    assert.throws(() => createJevClient({ apiKey: '' }), /TYPESAFE_AI_KEY/);
  });

  it('a pinned model must be the one served; jev-latest takes whatever answers', async () => {
    const other = await startFakeJevServer({ model: 'jev-1.14.0' });
    try {
      const pinned = createJevClient({ apiKey: KEY, baseUrl: other.url, wait: noWait });
      await assert.rejects(pinned.ask(Q), (err) => err instanceof UsageError && err.code === 'JEV_MODEL_MISMATCH' && /--jev-model jev-1\.14\.0/.test(err.message));
      const latest = createJevClient({ apiKey: KEY, baseUrl: other.url, model: 'jev-latest', wait: noWait });
      assert.strictEqual((await latest.ask(Q)).model, 'jev-1.14.0');
      assert.strictEqual(other.requests.at(-1).body.model, 'jev-latest');
    } finally {
      await other.close();
    }
  });

  it('estimates input tokens per mode, cache ignored', () => {
    assert.strictEqual(estimateJevTokens({ questions: 10, topM: 100, chunkCount: 50, meanChunkTokens: 100, mode: 'batched' }), 10 * 50 * (100 + OVERHEAD_TOKENS.batched));
    assert.strictEqual(estimateJevTokens({ questions: 2, topM: 5, chunkCount: 500, meanChunkTokens: 10, mode: 'pointwise' }), 2 * 5 * (10 + OVERHEAD_TOKENS.pointwise));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-jev.test.js`
Expected: FAIL, `Cannot find module '../src/longhaul/jev'`.

- [ ] **Step 3: Write the client**

Create `src/longhaul/jev.js`:

```js
'use strict';
// typesafe.ai's Jev as LongHaul's hosted reranker (kl-recall-jev-rerank,
// kl-recall-vec-jev-rerank; recall spec §6.3 step 6, rerank.kind 'jev').
// One client with the app: every request is TypesafeProvider#ask
// (src/providers/typesafe-provider.js, through BaseProvider.request) and
// every request shape is jevScores (src/history/jev-rerank.js). This adds
// what a benchmark run needs: retries with backoff (429, 529, 5xx,
// timeouts, network errors; a refused key, an exhausted account or a 422
// is never retried), a concurrency limit across questions, a token cap
// (--jev-max-tokens), the served-model check (cached scores never mix model
// versions), counts for adapter-stats.json and a calibration histogram.
// Jev is not in the model catalog, so its cost is unpriced: input tokens are
// counted and reported with the price unknown, never $0. Nothing here logs
// or throws request or response text.
const { jevScores, limiter, MODES } = require('../history/jev-rerank');
const TypesafeProvider = require('../providers/typesafe-provider');
const { withRetries, retryable } = require('./retry');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/jev');

// The model asked for, and the cache directory's model part: pinned, so a
// later Jev never answers into this one's cache. The probe asked for
// jev-latest when it was jev-1.13.0; its scores are under
// rerank/<session>/jev-1.13.0-<mode>/.
const JEV_DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_MODE = 'batched';
const DEFAULT_MAX_TOKENS = 20000000;
// Input tokens a candidate costs besides its own text, for the estimate: the
// probe measured about 550 a pair pointwise at 141 estimated chunk tokens,
// and about 26K a question batched at topM 100.
const OVERHEAD_TOKENS = Object.freeze({ pointwise: 450, batched: 120 });
// The UsageError codes from here that stop a run (run.js RUN_STOP_CODES).
const JEV_STOP_CODES = Object.freeze(['JEV_SCORES_MISSING', 'JEV_OVER_TOKENS', 'JEV_MODEL_MISMATCH']);

const jevRetryable = (err) => retryable(err) || Boolean(err && err.code === 'JEV_TIMEOUT');

const newJevUsage = () => ({
  requests: 0, ok: 0, inputTokens: 0, outputTokens: 0, retries: 0, status: {}, timeouts: 0, networkErrors: 0,
  failed: 0, requestMs: [], models: {}
});

function createJevClient({
  apiKey, baseUrl = null, model = JEV_DEFAULT_MODEL, provider = null, concurrency = 24, timeoutMs = 60000,
  retries = 6, baseDelayMs = 500, wait = null, maxTokens = null, now = () => Date.now()
} = {}) {
  if (!provider && !apiKey) throw new UsageError('Jev needs an API key: set TYPESAFE_AI_KEY in the environment.');
  const p = provider || new TypesafeProvider(apiKey, baseUrl ? { baseUrl } : {});
  const usage = newJevUsage();
  const limit = limiter(concurrency);
  const pinned = !/-latest$/.test(model);

  async function once(body, abortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const t0 = now();
    usage.requests += 1;
    let r;
    try {
      r = await p.ask(body, { abortSignal: signal });
    } catch (err) {
      const callerAborted = Boolean(abortSignal && abortSignal.aborted);
      if (err && Number.isInteger(err.status)) {
        usage.status[err.status] = (usage.status[err.status] || 0) + 1;
      } else if (timeout.aborted && !callerAborted) {
        usage.timeouts += 1;
        throw Object.assign(new Error(`Jev request timed out after ${timeoutMs} ms`), { code: 'JEV_TIMEOUT' });
      } else if (!callerAborted) {
        usage.networkErrors += 1;
      }
      throw err;
    }
    usage.status[200] = (usage.status[200] || 0) + 1;
    usage.ok += 1;
    usage.requestMs.push(now() - t0);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.models[r.model] = (usage.models[r.model] || 0) + 1;
    if (pinned && r.model !== model) {
      throw new UsageError(`typesafe.ai served ${r.model} for ${model}; the run stopped so cached scores never mix model versions. `
        + `Pass --jev-model ${r.model} to score and cache under it.`, 'JEV_MODEL_MISMATCH');
    }
    return r;
  }

  function ask(body, { abortSignal = null } = {}) {
    return limit(async () => {
      try {
        if (maxTokens !== null && usage.inputTokens >= maxTokens) {
          throw new UsageError(`Jev token cap reached: ${usage.inputTokens} input tokens of ${maxTokens} (--jev-max-tokens); nothing more is sent.`, 'JEV_OVER_TOKENS');
        }
        return await withRetries(() => once({ ...body, model }, abortSignal), {
          retries, baseDelayMs, isRetryable: jevRetryable, ...(wait ? { wait } : {}),
          onRetry: ({ err, attempt, delayMs }) => {
            usage.retries += 1;
            log.debug('Jev retry', { status: err.status ?? null, code: err.code || null, attempt, waitMs: Math.round(delayMs) });
          }
        });
      } catch (err) {
        usage.failed += 1;
        throw err;
      }
    });
  }

  return { ask, usage, model, concurrency };
}

// Scores seen, for the calibration note: a 10-bin histogram of the noul
// values plus the per-call spread (max - min of one question's scores).
const newCalibration = () => ({ n: 0, bins: new Array(10).fill(0), sum: 0, sumSq: 0, spreads: [] });

function recordScores(cal, scores) {
  if (!cal || !scores.length) return;
  for (const s of scores) {
    cal.n += 1;
    cal.sum += s;
    cal.sumSq += s * s;
    cal.bins[Math.min(9, Math.max(0, Math.floor(s * 10)))] += 1;
  }
  if (scores.length > 1) cal.spreads.push(Math.max(...scores) - Math.min(...scores));
}

function calibrationSummary(cal) {
  if (!cal || !cal.n) return null;
  const mean = cal.sum / cal.n;
  const sd = Math.sqrt(Math.max(0, cal.sumSq / cal.n - mean * mean));
  const sorted = [...cal.spreads].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  return { scores: cal.n, mean, sd, bins: cal.bins, spreadMedian: q(0.5), spreadP10: q(0.1), calls: sorted.length };
}

function createJevScorer({ client, mode = DEFAULT_MODE, calibration = null }) {
  if (!MODES.includes(mode)) throw new UsageError(`--jev-mode must be ${MODES.join(' or ')}, got ${JSON.stringify(mode)}`);
  return {
    model: `${client.model}-${mode}`,
    async score(query, texts) {
      const out = await jevScores({ ask: client.ask, model: client.model, query, texts, mode, concurrency: client.concurrency || 24 });
      recordScores(calibration, out.scores);
      return out.scores;
    }
  };
}

// Input tokens a run would send with an empty cache (an upper estimate).
function estimateJevTokens({ questions, topM, chunkCount, meanChunkTokens, mode }) {
  return questions * Math.min(topM, chunkCount) * (meanChunkTokens + OVERHEAD_TOKENS[mode]);
}

function usageSummary(usage) {
  const ms = [...usage.requestMs].sort((a, b) => a - b);
  const pick = (p) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]) : null);
  return {
    requests: usage.requests, ok: usage.ok, failed: usage.failed, retries: usage.retries, status: usage.status,
    timeouts: usage.timeouts, networkErrors: usage.networkErrors, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    // Jev is not in the model catalog: unpriced, never $0.
    usd: null, price: 'unknown',
    requestMsMedian: pick(0.5), requestMsP90: pick(0.9), models: usage.models
  };
}

module.exports = {
  JEV_DEFAULT_MODEL, DEFAULT_MODE, DEFAULT_MAX_TOKENS, OVERHEAD_TOKENS, JEV_STOP_CODES,
  createJevClient, createJevScorer, estimateJevTokens, newCalibration, calibrationSummary, usageSummary
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/longhaul-jev.test.js tests/longhaul-boundary.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/jev.js tests/longhaul-jev.test.js
git commit -m "feat(longhaul): a Jev client on the app's TypesafeProvider and scorer (retries, token cap, pinned model, unpriced)"
```

---

## Task 10: The Jev adapters, `longhaul run`'s flags, and the run stops

**Files:**
- Create: `src/longhaul/adapters/kl-recall-jev-rerank.js`
- Modify: `src/longhaul/adapters/index.js` (two factories)
- Modify: `src/longhaul/run.js` (`RUN_STOP_CODES`, `scoreOne`, `finish`, the two `prepare` calls, the export)
- Modify: `src/longhaul/commands/run.js` (usage, options, config, output)
- Modify: `tests/longhaul-adapters.test.js` (the registry list)
- Test: `tests/longhaul-jev-adapters.test.js` (new)

**Interfaces:**
- Consumes: `createKlRecallRerankAdapter` (`rerankModel`, `scorer`), `createJevClient`, `createJevScorer`, `estimateJevTokens`, `JEV_STOP_CODES` and friends (Task 9), `estTokens`, `MODES` (Task 3), `stopErrorFor`, `STOP_CODES` (Task 1).
- Produces: adapters `kl-recall-jev-rerank` (BM25 candidates) and `kl-recall-vec-jev-rerank` (fused), config `{ jevMode = 'batched', jevModel = 'jev-1.13.0', sendPrivate, env, jevBaseUrl, maxTokens = 20000000, cachedOnly = false, jevClient, jevOptions, recall, …kl-recall-rerank's }`; `describe()` adds `reranker: 'typesafe.ai <model>-<mode>'`, `jevMode`, `jevModel` and its `recall.rerank.kind` is `'jev'`; `prepare` refuses a private session without `sendPrivate` (`PRIVATE_SESSION`) and, unless `cachedOnly`, a run estimate over `maxTokens` (`JEV_OVER_TOKENS`), before any request; `context` throws the first stopping failure (a `UsageError`, or `AUTH`/`QUOTA` through `stopErrorFor`); `runStats()` (numbers only). `run.js`: `RUN_STOP_CODES` (exported), `scoreOne` lets a `UsageError` with one of them through, `prepare(session, { upToSeq, questionCount })`, `finish` writes `adapter-stats.json` and returns `adapterStats`. CLI: `--jev-mode`, `--jev-model`, `--jev-max-tokens`, `--jev-base-url`; the key is `TYPESAFE_AI_KEY`; in the answer stage the adapters are `cachedOnly`.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-jev-adapters.test.js`:

```js
// tests/longhaul-jev-adapters.test.js
// kl-recall-jev-rerank and kl-recall-vec-jev-rerank: Jev reranks, scores are
// cached under private/rerank/<session>/<model>-<mode>/, a private session
// and an estimate over the token cap are refused before any request, a
// refused key or a spent account stops the run, the answer stage is
// cache-only, and longhaul run prints and writes the counts. Synthetic
// fixtures, loopback fake server; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { runBenchmark, RUN_STOP_CODES } = require('../src/longhaul/run');
const { JEV_STOP_CODES } = require('../src/longhaul/jev');
const { UsageError } = require('../src/longhaul/errors');
const runCommand = require('../src/longhaul/commands/run');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const KEY = 'test-key-not-real-0001';
const REF = { completeMessageTokens: 800, pairToolMessages: true };
const noWait = async () => {};
const now = () => new Date('2026-10-04T10:00:00.000Z');

function setupHome() {
  const { env, root } = tmpHome();
  writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
  return { env, root, home: ensureDirs(resolveHome(env)) };
}

async function runAll(adapter, session, questions) {
  const handle = await adapter.prepare(session, { questionCount: questions.length });
  const shown = [];
  try {
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      for (const s of [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]) assert.ok(s < q.askAtSeq);
      shown.push(r.evidenceSeqsShown);
    }
  } finally {
    await adapter.release(handle);
  }
  return shown;
}

describe('kl-recall-jev-rerank', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  const make = (home, extra = {}) => createAdapter('kl-recall-jev-rerank', {
    tmpRoot: home.tmp, privateRoot: home.private, recall: { ...REF, rerank: { topM: 5 } },
    env: { TYPESAFE_AI_KEY: KEY }, jevBaseUrl: server.url, jevOptions: { wait: noWait }, ...extra
  });

  it('is registered next to the cross-encoder probes; its stop codes stop a run', () => {
    for (const name of ['kl-recall-jev-rerank', 'kl-recall-vec-jev-rerank']) assert.ok(adapterNames().includes(name), name);
    for (const code of [...JEV_STOP_CODES, 'AUTH', 'QUOTA']) assert.ok(RUN_STOP_CODES.has(code), code);
    assert.ok(!RUN_STOP_CODES.has('PRIVATE_SESSION'), 'a per-question refusal is still recorded on its question');
  });

  it('reranks with Jev (batched); a second adapter is served from the cache and needs no key', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const first = make(home);
    assert.strictEqual(first.name, 'kl-recall-jev-rerank');
    const d = first.describe();
    assert.strictEqual(d.jevMode, 'batched');
    assert.strictEqual(d.reranker, 'typesafe.ai jev-1.13.0-batched');
    assert.strictEqual(d.recall.rerank.kind, 'jev');
    const n0 = server.requests.length;
    const a = await runAll(first, session, questions);
    assert.ok(server.requests.length > n0);
    const st = first.runStats();
    assert.ok(st.rerank.misses > 0 && st.jev.inputTokens > 0);
    assert.strictEqual(st.jev.usd, null, 'unpriced');
    assert.ok(fs.existsSync(path.join(home.private, 'rerank', 'synth-small', 'jev-1.13.0-batched', 'scores.jsonl')));
    const n1 = server.requests.length;
    const second = make(home, { env: {} });
    const b = await runAll(second, session, questions);
    assert.strictEqual(server.requests.length, n1, 'a cache hit sends no request and needs no key');
    assert.deepStrictEqual(b, a);
    assert.strictEqual(second.runStats().rerank.misses, 0);
  });

  it('pointwise has its own cache; the fused variant builds; a bad mode is refused', () => {
    const { home } = setupHome();
    assert.strictEqual(make(home, { jevMode: 'pointwise' }).describe().reranker, 'typesafe.ai jev-1.13.0-pointwise');
    const v = createAdapter('kl-recall-vec-jev-rerank', { tmpRoot: home.tmp, privateRoot: home.private, env: {} });
    assert.strictEqual(v.name, 'kl-recall-vec-jev-rerank');
    assert.strictEqual(v.describe().candidates, 'fused');
    assert.throws(() => make(home, { jevMode: 'listwise' }), /batched or pointwise/);
  });

  it('refuses a private session without --send-private, and an estimate over the token cap, before any request', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const n0 = server.requests.length;
    await assert.rejects(make(home, { maxTokens: 1 }).prepare(session, { questionCount: 10 }), (err) => err.code === 'JEV_OVER_TOKENS');
    session.manifest.private = true;
    await assert.rejects(make(home).prepare(session, { questionCount: 3 }), (err) => err.code === 'PRIVATE_SESSION' && /--send-private/.test(err.message));
    assert.strictEqual(server.requests.length, n0);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
    const ok = make(home, { sendPrivate: true });
    await ok.release(await ok.prepare(session, { questionCount: 3 }));
  });

  it('a refused key (401) stops the run with AUTH; a spent account (402) with QUOTA; neither is retried', async () => {
    for (const [status, code, re] of [[401, 'AUTH', /typesafe\.ai refused the API key \(401\) for the Jev reranker/], [402, 'QUOTA', /typesafe\.ai refused the call: the account is out of credit or quota \(402\) for the Jev reranker/]]) {
      const { home } = setupHome();
      const refusing = await startFakeJevServer({ failFirst: 1000, failStatus: status });
      try {
        const adapter = make(home, { jevBaseUrl: refusing.url });
        await assert.rejects(runBenchmark({ home, adapters: [adapter], now, commit: 'x' }),
          (err) => err instanceof UsageError && err.code === code && re.test(err.message));
        assert.strictEqual(refusing.requests.length, 1, `${status}: one request, then the run stops`);
      } finally {
        await refusing.close();
      }
    }
  });

  it('cache-only (the answer stage): a miss stops the run with JEV_SCORES_MISSING and sends nothing; a warm cache serves it', async () => {
    const { home } = setupHome();
    const n0 = server.requests.length;
    await assert.rejects(runBenchmark({ home, adapters: [make(home, { cachedOnly: true })], now, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'JEV_SCORES_MISSING' && /evidence-only run/.test(err.message));
    assert.strictEqual(server.requests.length, n0);
    await runBenchmark({ home, adapters: [make(home)], now, commit: 'x' });
    const n1 = server.requests.length;
    assert.ok(n1 > n0);
    const out = await runBenchmark({ home, adapters: [make(home, { cachedOnly: true, env: {} })], now, commit: 'x' });
    assert.strictEqual(server.requests.length, n1);
    assert.ok(out.records.every((r) => r.error === null));
  });

  it('longhaul run prints the Jev line (tokens, price unknown) and writes adapter-stats.json', async () => {
    const { env, home } = setupHome();
    const stdout = sink();
    const ctx = { home, env: { ...env, TYPESAFE_AI_KEY: KEY }, stdout, stderr: sink(), now, cwd: process.cwd() };
    const code = await runCommand.run(ctx, {
      adapters: 'kl-recall-jev-rerank', recall: ['rerank={"topM":5}'], 'jev-mode': 'batched', 'jev-base-url': server.url, 'send-private': false
    });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /kl-recall-jev-rerank\s+batched topM 5 .*input tokens \d+ \(price unknown\)/);
    const runDir = path.join(home.runs, fs.readdirSync(home.runs)[0]);
    const stats = JSON.parse(fs.readFileSync(path.join(runDir, 'adapter-stats.json'), 'utf8'))['kl-recall-jev-rerank'];
    assert.strictEqual(stats.mode, 'batched');
    assert.ok(stats.jev.requests > 0);
    assert.strictEqual(stats.jev.usd, null);
    assert.strictEqual(stats.scoreErrors, 0);
  });
});
```

In `tests/longhaul-adapters.test.js`, replace

```js
    assert.deepStrictEqual(adapterNames(), [
      'full-history', 'kl-recall', 'kl-recall-rerank', 'kl-recall-vec', 'kl-recall-vec-only', 'kl-recall-vec-rerank',
      'kl-recall-whole', 'oracle', 'real-compaction', 'sliding-window', 'summarize-compact'
    ]);
```

with

```js
    assert.deepStrictEqual(adapterNames(), [
      'full-history', 'kl-recall', 'kl-recall-jev-rerank', 'kl-recall-rerank', 'kl-recall-vec', 'kl-recall-vec-jev-rerank',
      'kl-recall-vec-only', 'kl-recall-vec-rerank', 'kl-recall-whole', 'oracle', 'real-compaction', 'sliding-window', 'summarize-compact'
    ]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-jev-adapters.test.js tests/longhaul-adapters.test.js`
Expected: FAIL: `Unknown adapter "kl-recall-jev-rerank"`, and `RUN_STOP_CODES` is undefined.

- [ ] **Step 3: Write the adapter**

Create `src/longhaul/adapters/kl-recall-jev-rerank.js`:

```js
'use strict';
// kl-recall-jev-rerank / kl-recall-vec-jev-rerank: kl-recall-rerank with
// typesafe.ai's Jev in place of the local cross-encoder (recall spec §6.3
// step 6, rerank.kind 'jev'): batched by default, or pointwise
// (src/longhaul/jev.js, on the app's TypesafeProvider and jevScores).
// Scores are cached like the cross-encoder's, under
// LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/, so a sweep over
// settings pays only for chunks not yet scored; a fully cached run needs no
// key. Refused before any request: a private session without sendPrivate
// (--send-private: its chunks and questions go to typesafe.ai), and a run
// whose estimate (cache ignored) is over maxTokens (--jev-max-tokens).
// cachedOnly (the answer stage and its dry run): a score not in the cache
// stops the run (JEV_SCORES_MISSING) rather than call Jev outside the
// priced plan; run the evidence-only run with the same settings first.
// The Retriever keeps the fused order on any reranker failure, so a failure
// every later question would share (a refused key: AUTH; an exhausted
// account: QUOTA; the token cap; a model mismatch; no key) is remembered and
// thrown from context(), and run.js lets it stop the run.
const { createKlRecallRerankAdapter } = require('./kl-recall-rerank');
const {
  JEV_DEFAULT_MODEL, DEFAULT_MODE, DEFAULT_MAX_TOKENS, createJevClient, createJevScorer, newCalibration, calibrationSummary,
  usageSummary, estimateJevTokens
} = require('../jev');
const { MODES, estTokens } = require('../../history/jev-rerank');
const { stopErrorFor } = require('../retry');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/jev-rerank');

function median(xs, p = 0.5) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function createKlRecallJevRerankAdapter({
  jevMode = DEFAULT_MODE, jevModel = JEV_DEFAULT_MODEL, sendPrivate = false, env = process.env, jevBaseUrl = null,
  maxTokens = DEFAULT_MAX_TOKENS, cachedOnly = false, jevClient = null, jevOptions = {}, candidates = 'bm25', recall = {}, ...rest
} = {}) {
  if (!MODES.includes(jevMode)) throw new UsageError(`--jev-mode must be ${MODES.join(' or ')}, got ${JSON.stringify(jevMode)}`);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new UsageError(`--jev-max-tokens must be a positive number, got ${JSON.stringify(maxTokens)}`);
  const name = candidates === 'fused' ? 'kl-recall-vec-jev-rerank' : 'kl-recall-jev-rerank';
  const cacheModel = `${jevModel}-${jevMode}`;
  const calibration = newCalibration();
  const perQuestion = { ms: [], pairs: [], errors: 0, errorCodes: {} };
  let client = jevClient;
  let jevScorer = null;
  let fatal = null;
  const getClient = () => {
    if (!client) {
      client = createJevClient({ apiKey: env.TYPESAFE_AI_KEY, model: jevModel, maxTokens, ...(jevBaseUrl ? { baseUrl: jevBaseUrl } : {}), ...jevOptions });
    }
    return client;
  };
  // Called only on a cache miss (createCachedReranker).
  const scorer = {
    async score(query, texts) {
      if (fatal) throw fatal;
      if (cachedOnly) {
        fatal = new UsageError(`${name}: Jev scores for ${texts.length} candidates are not cached for these settings, and the answer stage `
          + 'sends nothing outside its priced plan; nothing was sent. Run the same adapters and settings without the answer stage '
          + '(an evidence-only run) first.', 'JEV_SCORES_MISSING');
        throw fatal;
      }
      const t0 = Date.now();
      try {
        if (!jevScorer) jevScorer = createJevScorer({ client: getClient(), mode: jevMode, calibration });
        const out = await jevScorer.score(query, texts);
        perQuestion.ms.push(Date.now() - t0);
        perQuestion.pairs.push(texts.length);
        return out;
      } catch (err) {
        perQuestion.errors += 1;
        const code = (err && err.code) || (err && Number.isInteger(err.status) ? `HTTP_${err.status}` : 'unknown');
        perQuestion.errorCodes[code] = (perQuestion.errorCodes[code] || 0) + 1;
        const stop = err instanceof UsageError ? err : stopErrorFor(err, 'typesafe.ai', 'the Jev reranker');
        if (stop && !fatal) fatal = stop;
        log.warn('Jev scoring failed; this question keeps the fused order', { code, status: err?.status ?? null, pairs: texts.length, stops: Boolean(stop) });
        throw err;
      }
    }
  };
  const inner = createKlRecallRerankAdapter({
    ...rest, env, sendPrivate, candidates, rerankModel: cacheModel, scorer,
    recall: { ...recall, rerank: { ...(recall.rerank || {}), kind: 'jev' } }
  });
  const topM = inner.describe().recall.rerank.topM;
  let estimateTokens = 0;

  return {
    name,
    stats: inner.stats,
    describe() {
      return { ...inner.describe(), name, reranker: `typesafe.ai ${cacheModel}`, jevMode, jevModel };
    },
    ...(inner.missingQuestionVectors ? { missingQuestionVectors: (session, questions) => inner.missingQuestionVectors(session, questions) } : {}),

    async prepare(session, options = {}) {
      const sessionId = session.manifest.sessionId;
      if (session.manifest.private && sendPrivate !== true) {
        throw new UsageError(`Session ${sessionId} is private: ${name} sends its chunks and questions to typesafe.ai (Jev). `
          + 'Pass --send-private to allow that.', 'PRIVATE_SESSION');
      }
      const handle = await inner.prepare(session, options);
      try {
        if (!cachedOnly) {
          const chunks = handle.store.chunksOfChat(handle.chatId);
          const meanChunkTokens = chunks.length ? chunks.reduce((n, c) => n + estTokens(c.text), 0) / chunks.length : 0;
          const questions = Number.isInteger(options.questionCount) ? options.questionCount : 0;
          const est = estimateJevTokens({ questions, topM, chunkCount: chunks.length, meanChunkTokens, mode: jevMode });
          estimateTokens += est;
          log.info('Jev estimate (cache ignored)', {
            sessionId, questions, topM, meanChunkTokens: Math.round(meanChunkTokens), tokens: Math.round(est), runTokens: Math.round(estimateTokens)
          });
          if (estimateTokens > maxTokens) {
            throw new UsageError(`${name}: the run's Jev estimate, ${Math.round(estimateTokens)} input tokens (cache ignored), is over `
              + `--jev-max-tokens ${maxTokens}; nothing was sent.`, 'JEV_OVER_TOKENS');
          }
          if (session.manifest.private) log.info('chunks of a private session go to typesafe.ai (--send-private)', { sessionId });
        }
        return handle;
      } catch (err) {
        await inner.release(handle);
        throw err;
      }
    },

    async context(handle, args) {
      const out = await inner.context(handle, args);
      if (fatal) throw fatal;
      return out;
    },
    release: (handle) => inner.release(handle),
    close: () => inner.close(),

    // Numbers only, for adapter-stats.json.
    runStats() {
      return {
        mode: jevMode, cacheModel, topM, cachedOnly, estimateTokens: Math.round(estimateTokens),
        rerank: { ...inner.stats },
        uncachedQuestions: perQuestion.ms.length,
        uncachedMsMedian: median(perQuestion.ms),
        uncachedMsP90: median(perQuestion.ms, 0.9),
        uncachedPairsMedian: median(perQuestion.pairs),
        scoreErrors: perQuestion.errors,
        scoreErrorCodes: perQuestion.errorCodes,
        jev: client ? usageSummary(client.usage) : null,
        calibration: calibrationSummary(calibration)
      };
    }
  };
}

module.exports = { createKlRecallJevRerankAdapter };
```

- [ ] **Step 4: Register them**

In `src/longhaul/adapters/index.js`, after

```js
  'kl-recall-vec-rerank': (config) => require('./kl-recall-rerank').createKlRecallRerankAdapter({ ...config, candidates: 'fused' }),
```

add

```js
  // Step 6 by typesafe.ai's Jev (batched by default, or pointwise) over BM25
  // or fused candidates; scores cached under private/rerank (unpriced).
  'kl-recall-jev-rerank': (config) => require('./kl-recall-jev-rerank').createKlRecallJevRerankAdapter(config),
  'kl-recall-vec-jev-rerank': (config) => require('./kl-recall-jev-rerank').createKlRecallJevRerankAdapter({ ...config, candidates: 'fused' }),
```

- [ ] **Step 5: Let the run stop, give `prepare` the question count, write the counts**

In `src/longhaul/run.js`:

Replace the import line (as Task 1 left it)

```js
const { retryable, callErrorCode, stopErrorFor } = require('./retry');
```

with

```js
const { retryable, callErrorCode, stopErrorFor, STOP_CODES } = require('./retry');
```

After `const ANSWER_PROMPT_OVERHEAD_TOKENS = 1000;` add:

```js
// UsageErrors that stop a run when an adapter's context throws them: a
// refused key, an exhausted account (retry.js STOP_CODES), and the Jev
// adapters' cache-only miss, token cap and model mismatch (jev.js
// JEV_STOP_CODES, named here so run.js does not load the Jev client). Every
// other context error is recorded on its question.
const RUN_STOP_CODES = new Set([...STOP_CODES, 'JEV_SCORES_MISSING', 'JEV_OVER_TOKENS', 'JEV_MODEL_MISMATCH']);
```

In `scoreOne`, replace

```js
  } catch (err) {
    return { record: errorRecord(base, err.message), text: null };
  }
```

with

```js
  } catch (err) {
    if (err instanceof UsageError && RUN_STOP_CODES.has(err.code)) throw err;
    return { record: errorRecord(base, err.message), text: null };
  }
```

Replace the whole `finish` function with:

```js
function finish({ run, runId, dir, config, records, spend = null, setupCosts = [] }) {
  const summary = summarize(records, { setupCosts });
  const comparisons = comparisonsOf(records);
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (spend) writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), renderSummaryMarkdown(config, summary, { spend, comparisons }));
  // Adapters that count something of their own (the Jev adapters: requests,
  // tokens, latency; numbers only) write adapter-stats.json.
  const adapterStats = {};
  for (const a of run.adapters) if (typeof a.runStats === 'function') adapterStats[a.name] = a.runStats();
  if (Object.keys(adapterStats).length) writeFileAtomic(path.join(dir, 'adapter-stats.json'), `${JSON.stringify(adapterStats, null, 2)}\n`);
  const leaks = Object.values(summary).reduce((n, s) => n + s.leaks, 0);
  return { runId, dir, config, summary, records, comparisons, leaks, spend, adapterStats, staleTmpRemoved: run.staleTmpRemoved };
}
```

In `runEvidenceOnly`, replace

```js
      if (isSkipped(run.skippedAdapters, adapter, session)) continue;
      const handle = await adapter.prepare(session, { upToSeq });
```

with

```js
      if (isSkipped(run.skippedAdapters, adapter, session)) continue;
      const handle = await adapter.prepare(session, { upToSeq, questionCount: questions.length });
```

In `runAnswerStage`'s pass 1, replace

```js
          continue;
        }
        const handle = await adapter.prepare(session, { upToSeq });
```

with

```js
          continue;
        }
        const handle = await adapter.prepare(session, { upToSeq, questionCount: qs.length });
```

Add `RUN_STOP_CODES` to `module.exports`:

```js
module.exports = { runBenchmark, sigintHandler, gitCommit, removeStaleTmp, contextCapTokens, KL_TMP_PREFIX, RUN_ID_RE, ANSWER_PROMPT_OVERHEAD_TOKENS, RUN_STOP_CODES };
```

- [ ] **Step 6: The CLI flags**

In `src/longhaul/commands/run.js`:

In `USAGE`, after the line `'  --embed-provider: the embedder for kl-recall-vec: openai (default) or local (H3)',` add:

```js
  '  [--jev-mode batched|pointwise] [--jev-model jev-1.13.0] [--jev-max-tokens 20000000] [--jev-base-url <url>]',
  '  --jev-*: kl-recall-jev-rerank and kl-recall-vec-jev-rerank (key TYPESAFE_AI_KEY; unpriced, input tokens reported)',
```

In `options`, after `'send-private': { type: 'boolean', default: false },` add:

```js
    'jev-mode': { type: 'string' },
    'jev-model': { type: 'string' },
    'jev-max-tokens': { type: 'string' },
    'jev-base-url': { type: 'string' },
```

After the `const vec = { … };` statement add:

```js
    // kl-recall(-vec)-jev-rerank: typesafe.ai's Jev as the reranker, the key
    // TYPESAFE_AI_KEY from the environment, a private session only with
    // --send-private. In the answer stage (and its dry run) it is
    // cache-only: a score not cached refuses the run (JEV_SCORES_MISSING)
    // instead of calling Jev outside the priced plan.
    const jev = {
      sendPrivate: values['send-private'] === true, env: ctx.env, cachedOnly: answering,
      ...(values['jev-mode'] ? { jevMode: values['jev-mode'] } : {}),
      ...(values['jev-model'] ? { jevModel: values['jev-model'] } : {}),
      ...(values['jev-max-tokens'] ? { maxTokens: positiveInt(values['jev-max-tokens'], 'jev-max-tokens') } : {}),
      ...(values['jev-base-url'] ? { jevBaseUrl: values['jev-base-url'] } : {})
    };
```

In `adapterConfig`, after `'kl-recall-vec-rerank': vec,` add:

```js
      'kl-recall-jev-rerank': { recall, privateRoot: ctx.home.private, ...jev },
      'kl-recall-vec-jev-rerank': { ...vec, ...jev },
```

In the output, right after the `for (const [name, s] of Object.entries(result.summary)) { … }` loop and before `for (const c of result.comparisons || [])`, add:

```js
    // The Jev adapters' own counts (adapter-stats.json): tokens, unpriced.
    for (const [name, st] of Object.entries(result.adapterStats || {})) {
      const j = st.jev;
      const s = Number.isFinite(st.uncachedMsMedian) ? (st.uncachedMsMedian / 1000).toFixed(2) : '-';
      ctx.stdout.write(`${name.padEnd(nameWidth)} ${st.mode} topM ${st.topM}  pairs ${st.rerank?.pairs ?? 0} (cached ${st.rerank?.hits ?? 0})  `
        + `uncached s/question median ${s}  score errors ${st.scoreErrors}`
        + (j ? `  requests ${j.requests} retries ${j.retries} input tokens ${j.inputTokens} (price unknown) status ${JSON.stringify(j.status)}` : '  no request sent')
        + '\n');
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/longhaul-jev-adapters.test.js tests/longhaul-adapters.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-rerank.test.js tests/longhaul-run.test.js tests/longhaul-answer-run.test.js tests/longhaul-answer-cli.test.js tests/longhaul-quota.test.js`
Expected: PASS, `# fail 0`.

Then the sweep (Global Constraints). Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/longhaul/adapters/kl-recall-jev-rerank.js src/longhaul/adapters/index.js src/longhaul/run.js src/longhaul/commands/run.js tests/longhaul-jev-adapters.test.js tests/longhaul-adapters.test.js
git commit -m "feat(longhaul): kl-recall(-vec)-jev-rerank on the app's Jev client; a refused key, a spent account or a cache-only miss stops the run"
```

---

## Task 11: The specs and CLAUDE.md

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md` (§6.3 step 6, §7, §14, §15)
- Modify: `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (§7 addendum, §15, §18)
- Modify: `CLAUDE.md` (History, LongHaul)

**Interfaces:** none (documentation). §6.7 is filled by Task 12.

- [ ] **Step 1: Recall spec §6.3 step 6**

In the recall spec, replace

```
   `rerank.maxMs` (2,000) guards the latency: a slower reranker is skipped
   for that turn and logged (§15).
```

with

```
   `rerank.maxMs` (2,000) guards the latency: a slower reranker is skipped
   for that turn and logged (§15).
   `rerank.kind` picks the reranker: `local` (the default, the cross-encoder
   above) or `jev`, typesafe.ai's hosted Jev, opt-in. Jev gets the query and
   the top `rerank.topM` chunks: one `POST /v1/systemone` per group of
   candidates with one `noul` question per candidate ("does it state or
   establish what the query asks?"), groups held under 28K estimated tokens
   of state (Jev's cap is 32K; a longer query or chunk is cut to fit), four
   requests at a time; the answer, a probability, replaces the fused score.
   At 0.24 s a turn (§6.7) it serves `SearchHistory` (`rerank.search`) and
   each turn when `rerank.enabled`. Choosing it in the settings pane takes
   an explicit confirmation, and nothing is sent under `KL_TEST_MODE` (the
   hosted reranker starts with the background checks, like the embedder).
   A Jev failure, timeout or missing key keeps the fused order (§15); it
   never falls back to the cross-encoder. The client is `TypesafeProvider`
   (`src/providers/typesafe-provider.js`), a decide-only provider outside the
   catalog (unpriced); the scorer, `src/history/jev-rerank.js`, is shared
   with LongHaul's `kl-recall(-vec)-jev-rerank`.
```

- [ ] **Step 2: Recall spec §7**

Replace the JSON block

```json
"context": {
  "tail": { "fromSeq": 401, "toSeq": 419 },
  "recalledChunkIds": [8812, 8813, 9107],
  "estTokens": { "system": 3100, "tail": 2900, "recalled": 1850 },
  "fullHistoryEstTokens": 412000,
  "embedder": "local:Xenova/all-MiniLM-L6-v2",
  "scope": "chat"
}
```

with

```json
"context": {
  "tail": { "fromSeq": 401, "toSeq": 419 },
  "recalledChunkIds": [8812, 8813, 9107],
  "estTokens": { "system": 3100, "tail": 2900, "recalled": 1850 },
  "fullHistoryEstTokens": 412000,
  "embedder": "local:Xenova/all-MiniLM-L6-v2",
  "reranker": "jev:jev-1.13.0",
  "rerankSkipped": null,
  "scope": "chat"
}
```

and after the paragraph ending `"recall unavailable: BM25 only, embedding model not loaded" when degraded.` add:

```
`reranker` names the reranker that ran this turn (`local:<model>`, or
`jev:<model>` with the model the response named), null when none did;
`rerankSkipped` says why one that was on did not run (no key, a refused key,
slower than `rerank.maxMs`, a failure), null otherwise. The recall line ends
in "· reranked" when one ran.
```

- [ ] **Step 3: Recall spec §14**

In the settings block, replace

```js
    rerank: { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 },
```

with

```js
    rerank: {
      enabled: false, kind: 'local',                 // local | jev (hosted, opt-in)
      model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000,
      jev: { model: 'jev-latest' }                   // asked for; provenance names what answered
    },
```

and after the paragraph that ends `the weights and top-k values sit behind an\n"advanced" disclosure.` add:

```
The typesafe.ai key is not a setting. It is stored like a provider token:
encrypted by the core's cipher (Electron `safeStorage` on the desktop, the
AES-GCM master key in service mode) under `apiTokens.__typesafe_api_key` in
the store (`chat-data.json`, a secret file for every tool). It is entered in
the History and recall pane (`history:jev.saveKey`) and never returned to
the renderer; the `Vault` tool reads only the vault, so it cannot read it.
Saving or removing it lifts a pause Jev holds for the old key.
```

- [ ] **Step 4: Recall spec §15**

After the row

```
| Reranker slower than `rerank.maxMs` (2,000) | The rerank step is skipped for that turn and logged. |
```

add

```
| Hosted reranker (Jev) fails, times out, or has no key | The fused order for that turn or search, never the cross-encoder instead; provenance `rerankSkipped` says why; one owner-visible warning per failure episode (the next success ends it). The call is aborted at `rerank.maxMs` (`searchMaxMs` for SearchHistory). A refused key (401/403) or an account out of credit (402) pauses Jev, sending nothing, until a new key is saved or Retry; a 429/529 holds it off for the server's retry-after (30 s without one). |
```

- [ ] **Step 5: The benchmark spec**

In §7, after the paragraph that begins `**B3 addendum (2026-09-30): \`kl-recall-whole\` is a new adapter.**` and ends `in \`spend.json\` and the summary's \`setup\`, not per question as §8 step 5\nlists.`, add:

```
**Addendum (2026-10-04): `kl-recall-jev-rerank` and
`kl-recall-vec-jev-rerank` rerank with typesafe.ai's Jev,** the opt-in
hosted reranker the app ships as `rerank.kind: 'jev'` (recall spec §6.3
step 6), on the app's own client (`TypesafeProvider`) and scorer: batched
by default (`--jev-mode pointwise` for one request per pair), the model
pinned to `jev-1.13.0` (`--jev-model`; a response naming another model stops
the run, so cached scores never mix versions). Scores are cached under
`LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/`. A private session
needs `--send-private`; a run whose estimate is over `--jev-max-tokens`
(20M) is refused before any request. Jev is not in the model catalog, so
its cost is reported as input tokens with the price unknown. In the answer
stage they are cache-only (`JEV_SCORES_MISSING` on a miss): the
evidence-only run with the same settings comes first.
```

In §15, after the row

```
| Answer or judge call fails | Retried three times; then the question is recorded as `error` and excluded from rates, with the count shown. |
```

add

```
| A model call is refused for credit or quota (HTTP 402; OpenAI 429 `insufficient_quota`; Anthropic 400 "credit balance is too low" or 402 `billing_error`) | Not retried: the run stops like a refused key (`QUOTA`, exit 2, `spend.json` `stoppedBy: 'QUOTA'`), for answer, judge, summarizer and Jev calls; nothing is cached for the failed call, so a rerun finishes from the cache. A plain rate limit (429) is still retried. |
```

In §18, replace

```
and recorded per item like a rate limit; it should stop the run as a refused
key does (follow-up).
```

with

```
and recorded per item like a rate limit; it now stops the run as a refused
key does (`QUOTA`, §15).
```

(If the line breaks differ, replace the sentence "it should stop the run as a refused key does (follow-up)." wherever it wraps.)

- [ ] **Step 6: CLAUDE.md**

In the History section, after the bullet that ends `and \`.git\`, \`tests\` and \`src/longhaul\` go into the asar.`, add:

```
- Rerank (`history.recall.rerank.kind`): `local` (the cross-encoder) or `jev`,
  typesafe.ai's hosted Jev, opt-in (the pane's "Allow sending to typesafe.ai"
  box; `history:embedder.save` refuses the switch without `confirmJev`). It
  sends the query and about 100 chunks per rerank. One client,
  `TypesafeProvider` (decide-only: not registered, not in the catalog,
  unpriced), and one scorer, `src/history/jev-rerank.js`, shared with
  LongHaul. `JevReranker` starts only from `startHistoryEmbedding` and refuses
  under `KL_TEST_MODE`; a failure keeps the fused order with one warning per
  episode. Its key is `apiTokens.__typesafe_api_key`, encrypted like a
  provider token; the `Vault` tool cannot read it. Provenance has `reranker`
  and `rerankSkipped`. Tests use `tests/helpers/fake-jev-server.js`, never
  the network.
```

In the LongHaul section, before the bullet `- Smoke run of the answer stage (no models, no network, $0):`, add:

```
- `kl-recall-jev-rerank` / `kl-recall-vec-jev-rerank` rerank with Jev
  (`--jev-mode batched|pointwise`, `--jev-model jev-1.13.0`,
  `--jev-max-tokens`, key `TYPESAFE_AI_KEY`); scores are cached under
  `LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/`, a private session
  needs `--send-private`, and the cost is input tokens with the price unknown.
  In the answer stage they are cache-only (`JEV_SCORES_MISSING`): run the
  evidence-only run with the same settings first.
- A quota refusal (402, OpenAI `insufficient_quota`, Anthropic's
  credit-balance 400 or `billing_error`) is never retried and stops a run
  like a refused key: `QUOTA`, exit 2, `spend.json` `stoppedBy: 'QUOTA'`. A
  plain 429 is still retried.
```

- [ ] **Step 7: The sweep**

Run: `node --test tests/history-*.test.js tests/longhaul-*.test.js tests/renderer-history-*.test.js tests/electron-boundary.test.js tests/fake-embedder.test.js tests/providers-*.test.js tests/ipc-constants.test.js tests/desktop-bridge-allowlist.test.js`
Expected: `# fail 0`. Do not run `npm test`. Report any failure in a file this plan did not touch instead of fixing it.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-25-chat-history-recall-design.md docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md CLAUDE.md
git commit -m "docs: the opt-in Jev reranker (recall spec §6.3, §7, §14, §15) and LongHaul's QUOTA stop"
```

---

## Task 12: Measure Jev against the shipped path (owner's controller; commands only)

The owner's controller runs this task, not an implementer: the sessions are private, the runs send them to typesafe.ai, OpenAI and Anthropic, and the numbers must come from the runs, never be invented. Nothing here changes a default. The rule below is decided now, before any number is seen.

### Expected cost

Jev: about 26K input tokens a question at topM 100 (measured facts), about 3.6M tokens a full pass of the 138 questions per setting, about $0.15 at the published rate (the ruling's budget is about $0.3 a pass); the probe's cached scores (`jev-1.13.0-batched`, whole-message settings) may cover part of the second pass. The answer stage on `openai/gpt-6-luna` with the `anthropic/claude-haiku-4-5` judge: about $0.5 per adapter per pass, four adapter configurations, about $2. Total under $3. Every `kl-recall*` adapter's answer cache key changed with Task 4 (Decision 9), so `kl-recall-vec` is answered afresh; the dry run prices it.

- [ ] **Step 1: Preconditions**

Tasks 1–11 are merged. `node bin/longhaul.js home` prints a directory outside every repository. `TYPESAFE_AI_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are in the environment (never in a file in the repository). The local MiniLM vectors are cached for every session and question (H3 Task 16 did it; for a session added since: `node bin/longhaul.js embed --session <id> --provider local --model Xenova/all-MiniLM-L6-v2`). Run no other `longhaul` command on this `LONGHAUL_HOME` while a run is going.

- [ ] **Step 2: Evidence-only, the shipped defaults**

```bash
node bin/longhaul.js run --adapters kl-recall-vec,kl-recall-vec-jev-rerank \
  --embed-provider local --embed-model Xenova/all-MiniLM-L6-v2 --send-private
```

Expected: one evidence-recall line per adapter (`kl-recall-vec` about 0.456, as spec §6.7 records), then a line `kl-recall-vec-jev-rerank batched topM 100  pairs … uncached s/question median … requests … input tokens … (price unknown) status {"200":…}`, exit 0. A `QUOTA` or `AUTH` exit 2 names typesafe.ai: fix the key or the credit, run again (cached scores are kept).

- [ ] **Step 3: Evidence-only, with whole messages**

```bash
node bin/longhaul.js run --adapters kl-recall-vec,kl-recall-vec-jev-rerank \
  --embed-provider local --embed-model Xenova/all-MiniLM-L6-v2 \
  --recall completeMessageTokens=800 --recall pairToolMessages=true --send-private
```

Expected: as Step 2.

- [ ] **Step 4: Price the answer stage (two invocations, four configurations)**

```bash
node bin/longhaul.js run --adapters kl-recall-vec,kl-recall-vec-jev-rerank \
  --embed-provider local --embed-model Xenova/all-MiniLM-L6-v2 \
  --tier grid --answer-provider openai --answer-model gpt-6-luna \
  --judge-provider anthropic --judge-model claude-haiku-4-5 --dry-run

node bin/longhaul.js run --adapters kl-recall-vec,kl-recall-vec-jev-rerank \
  --embed-provider local --embed-model Xenova/all-MiniLM-L6-v2 \
  --recall completeMessageTokens=800 --recall pairToolMessages=true \
  --tier grid --answer-provider openai --answer-model gpt-6-luna \
  --judge-provider anthropic --judge-model claude-haiku-4-5 --dry-run
```

Expected: a `plan:` and an `estimate:` line each (a bound of about $1.5 each), then `dry run: no model was called`. `JEV_SCORES_MISSING` means Step 2 or 3 did not run with the same settings: run it, then price again.

- [ ] **Step 5: Run the answer stage**

The same two commands without `--dry-run`, with `--send-private`. Expected: per adapter an `answer accuracy … abstain accuracy …` line, and `spent $… on N calls`.

- [ ] **Step 6: Read the numbers**

From the four runs' `summary.json` and `adapter-stats.json`: per configuration, evidence recall, answer containment, answer accuracy (n), abstain accuracy, median and p90 context tokens; for Jev, the uncached median seconds a question, requests, retries, statuses and input tokens; each answer run's spend against its estimate. Name them: `A` = `kl-recall-vec` on the shipped defaults (the shipped path), `J` = `kl-recall-vec-jev-rerank` on the shipped defaults, `W` = `kl-recall-vec` with whole messages, `JW` = `kl-recall-vec-jev-rerank` with whole messages (answer accuracy each).

- [ ] **Step 7: Apply the rule (decided before the runs)**

Recommend turning whole messages on together with Jev only if `JW ≥ J + 0.02` **and** `JW ≥ A + 0.02` (one question is about 0.01 at n = 103; under 0.02 is noise). Otherwise record that it is not recommended and why. Either way, no default changes in this plan (`rerank.kind` stays `local`; `completeMessageTokens` 0, `pairToolMessages` false).

- [ ] **Step 8: Record it**

In the recall spec §6.7, add rows to the table (numbers only):

```
| H3 shipped defaults, plus Jev hosted rerank, batched, topM 100 (opt-in, `rerank.kind: 'jev'`) | <J evidence recall> | <J containment> |
| H3 shipped defaults with whole messages (`completeMessageTokens` 800, `pairToolMessages`) | <W evidence recall> | <W containment> |
| the same, plus Jev | <JW evidence recall> | <JW containment> |
```

then, after the table, a short block:

```
Answer accuracy on the grid tier (2026-10-<dd>, `openai/gpt-6-luna` answers,
`anthropic/claude-haiku-4-5` judge, <n> answerable questions; abstain accuracy
in brackets): shipped path <A> (<a>), with Jev <J> (<j>), whole messages <W>
(<w>), whole messages with Jev <JW> (<jw>). Jev took a median <s> s a
question uncached and <t>M input tokens a pass.
```

and a finding bullet under "Findings the settings rest on", replacing the "Hosted rerank." bullet's last sentence with the measured result and the rule's verdict ("recommended together with whole messages" or "not recommended: <which condition failed>").

Only if the rule holds, add one sentence to the pane in `index.html`, right after the `history-rerank-jev-note` span: `<span id="history-rerank-help" class="provider-message">On LongHaul, Jev with whole messages (history.recall.completeMessageTokens 800 and pairToolMessages on) answered <JW> of questions right, against <J> with Jev alone.</span>`, with the numbers filled in.

Commit the spec (and the pane, if changed):

```bash
git add docs/superpowers/specs/2026-09-25-chat-history-recall-design.md index.html
git commit -m "docs(history): Jev rerank measured on LongHaul, with and without whole messages (spec §6.7)"
```

---

## Notes on the probe port

- **What is ported, not merged:** the probe's batched and pointwise request shapes and question wording (into `src/history/jev-rerank.js`), its group planner (now also cutting an oversized query or chunk), its adapter (onto `createKlRecallRerankAdapter` as main has it, with `close()` and `missingQuestionVectors` passed through), its fake server (with failures by count, a delay, the 32K cap and an aborted-connection count) and its tests. Its own `fetch` client, its price constant and its `--jev-max-usd` are not: the client is `TypesafeProvider`, the cost is unpriced tokens, and the cap is `--jev-max-tokens`.
- **The probe's `run.js` and `commands/run.js` hunks** (`questionCount`, `adapter-stats.json`, the Jev output line) are rewritten against B3's `runEvidenceOnly` / `runAnswerStage` / `finish`, never applied as a diff.
- **The probe's default mode was pointwise**; the ruling makes batched the default (0.24 s against 0.8 s a question, and the better score).

## Decisions

### The owner's rulings (binding, 2026-10-04)

1. **Opt-in only.** `rerank.kind` defaults to `'local'`. `'jev'` sends about 100 excerpts of the chat to typesafe.ai per reranked query, so the pane says so in one plain sentence next to the choice, and saving `'jev'` needs an explicit confirmation control. Nothing is sent under `KL_TEST_MODE`, and never from a unit test (loopback fake server only). (Tasks 6, 7, 8.)
2. **What Jev serves.** With `'jev'` the hosted reranker serves `SearchHistory` (when `rerank.search`) and each turn when `rerank.enabled` (0.24 s measured, inside `rerank.maxMs` 2,000); with `'local'` behaviour is exactly as today. A Jev failure, timeout or missing key keeps the fused order, with one owner-visible warning per failure episode (the host's warning discipline) and a provenance note; it never fails a turn. (Tasks 5, 6, 7.)
3. **The client is a provider class extending `BaseProvider`**, every request through `BaseProvider.request` with `options.abortSignal`; decide-only: no chat, not one of the 14, not in the catalog, never offered as a chat model. Its key is stored the way a provider token is stored (encrypted), entered in the History and recall pane; the `Vault` tool must not be able to read it. (Tasks 2, 7; Decision 1.)
4. **Cost.** Jev is not in the catalog, so it is unpriced (`null`, "price unknown"), never $0; input tokens from `usage.input_tokens` are counted and shown like hosted embedding tokens. No price table. (Tasks 2, 6, 8, 9.)
5. **Provenance** gains `reranker` (`'jev:<model>'`, `'local:<model>'` or `null`) and `rerankSkipped` (reason or `null`); the recall line may say "reranked" when one ran. (Tasks 5, 8.)
6. **Vault results make no chunks**, so they are never candidates and never sent; pinned by a test. (Task 6.)
7. **LongHaul** ports the batched (default) and pointwise scorers and the adapters `kl-recall-jev-rerank` / `kl-recall-vec-jev-rerank` onto the app's Jev provider (one client implementation), scores cached under `LONGHAUL_HOME/private/rerank/` keyed by model and mode, refused for a private session without `--send-private`, cost reported as unknown-price tokens, tested against a loopback fake. (Tasks 3, 9, 10.)
8. **Quota stop.** A refusal that means out of credit or quota is not retryable and stops a LongHaul run like a refused key: `UsageError` `QUOTA`, exit 2, `spend.json` `stoppedBy: 'QUOTA'`, for answer, judge and summarizer calls; nothing cached for the failed call; a rerun finishes from the cache; a genuine rate-limit 429 keeps today's retries; the provider seam is changed only if it drops the fields (it does not: Decision 14). (Task 1.)
9. **The last task is a measurement the owner's controller runs**, commands only, with its rule decided beforehand; no default changes. (Task 12.)
10. **Abstain accuracy is not in this plan.**
11. **Tests:** `node --test tests/<file>.test.js`, never the full `npm test`; each task runs its files and the history/LongHaul sweep; no network; `src/` Electron-free except `src/ipc/`; `createLogger`; `textContent`; invented fixtures; `~/.longhaul`, `~/.claude`, the long-haul checkout and key files are never read. (Global Constraints.)
12. **Spec edits are a task:** recall spec §6.3 step 6, §7, §14, §15 and CLAUDE.md (Task 11); §6.7 by the measurement (Task 12).

### Rulings this plan makes

Where the brief, the code and the specs leave a choice:

1. **The key's home is `apiTokens.__typesafe_api_key`**, beside `__elevenlabs_api_key` and the bot tokens, encrypted by the core's `cipher` (`safeStorage` on the desktop, the AES-GCM master key in service mode). Not the vault: the `Vault` tool can read and list the vault (only `contact.` keys are hidden), and a key there would be one prompt away from the model. `chat-data.json` is a secret file for every tool (`SECRET_FILE_PREFIXES`). The key is entered in the History and recall pane, written through `history:jev.saveKey`, and never returned to the renderer (Task 7).
2. **The provider file is `src/providers/typesafe-provider.js`** so the request-helper guards (no direct `fetch`, `listModels(options = {})`) cover it; only the streaming guard skips it, since it never streams a chat. It is not registered with `ProviderFactory` and has no catalog entry (Task 2).
3. **A Jev error never carries the body's text:** the message is `typesafe.ai answered HTTP <status>` and only a short `type`/`code` id is kept (a 422 can echo the state, which is chat text).
4. **The app makes one attempt per rerank**, aborted at `maxMs` (2,000 per turn, `searchMaxMs` 6,000 for SearchHistory): a retry cannot fit the turn's budget. After a 429/529 it holds off for the retry-after (30 s without one); after a 401/403/402 it pauses until a new key or Retry. LongHaul retries (six times, backoff from 0.5 s), since a benchmark question can wait (Tasks 6, 9).
5. **A Jev failure keeps the fused order and never falls back to the cross-encoder** (ruling 2): a fallback would load a 90 MB model the owner opted out of, and its 2 s a turn would blow `maxMs` anyway. With `kind: 'jev'` the cross-encoder is not preloaded (Task 6).
6. **One warning per failure episode** follows `EmbedderHost.fail`'s discipline (one log line and one toast), with the episode ending at the next success or `reset()`, so a Jev outage that recovers and fails again warns again, and a missing key warns once until a key is saved.
7. **The app reranks batched, four requests at a time**; pointwise exists for LongHaul only (it is 0.8 s a question and 100 requests a turn).
8. **The questions are the probe's, word for word** (`jev-rerank.js`): LongHaul's score cache keys on the query and the chunk text, not on the question, so changed wording would silently reuse scores the probe got for other wording.
9. **Adding `rerank.kind` and `rerank.jev` to the defaults changes every `kl-recall*` adapter's `describe()`**, and so its answer cache key and report series, once. The alternative, hiding the two keys from `describe()` when `kind` is `local`, would make `describe()` lie about the settings. The cost is re-answering `kl-recall*` rows in the next answer-stage run (about $0.5 an adapter on the grid tier; Task 12 prices it); B3's published numbers are unaffected.
10. **The app asks for `jev-latest`, LongHaul for `jev-1.13.0`:** the app wants the newest model and names what answered in provenance; a benchmark must never mix model versions in one cache (`JEV_MODEL_MISMATCH`). See Open Question 1.
11. **LongHaul's Jev is cache-only in the answer stage** (`JEV_SCORES_MISSING`), like `EMBEDDINGS_MISSING` for question vectors: pass 1 builds contexts before the plan is priced, and a dry run must call nothing. The evidence-only run with the same settings fills the cache first (Task 12 runs it that way).
12. **LongHaul's Jev cap is in tokens** (`--jev-max-tokens`, 20M, about five full passes), not dollars: there is no price to convert with (ruling 4). The estimate is cache-ignored, so it errs high.
13. **The quota check is a narrow predicate in `src/longhaul/retry.js`**, not `error-classifier.js`'s `BILLING` reason: that one matches the bare word "billing", and an OpenAI rate-limit message can link the billing page, which would stop a run on a mere rate limit (pinned by a Task 1 test). The app's `JevReranker` reads the status (401/403/402/429/529) and `insufficient_quota` only.
14. **No `BaseProvider` change was needed for part B:** `buildProviderError` already keeps `status`, `type` and `code` from the body and the message; the stream paths of OpenAI and Anthropic throw that `ProviderError` unchanged through `oneShot` to `cachedCall`. Task 1's first block pins it with the providers' own `buildError` over recorded bodies.
15. **`scoreOne` lets through only the run-stopping `UsageError` codes** (`AUTH`, `QUOTA`, the three Jev codes); `PRIVATE_SESSION` from a context stays a per-question record as before, so no existing adapter's behaviour changes (Task 10).
16. **The recall line says only "reranked"** (ruling 5); why a rerank was skipped stays in provenance and in the warning, so the line does not grow a second failure clause beside the vectors' one.
17. **Attached, the key goes to the service:** the `history` domain is proxied, so `history:jev.saveKey` from the desktop writes the service's store, and the service's `JevReranker` uses it. This is the same path every history setting takes.

## Open Questions for the owner

Only the owner can settle these; each has the recommended answer, which is what the plan implements until told otherwise.

1. **Does typesafe.ai accept a versioned model id (`jev-1.13.0`) in `model`, or only `jev-latest`?** The docs list `jev-1.13.0` as a model; the probe only ever asked for `jev-latest`. *Recommended:* LongHaul asks for `jev-1.13.0` (reproducible, and it reuses the probe's cached scores); if the API refuses it (a 422 at Task 12 Step 2), pass `--jev-model jev-latest`, which caches under `jev-latest-batched` and still stops on a model change only when the id is pinned.
2. **Should Jev rerank in case chats too?** A case chat's chunks can hold private facts that C3's outbound gate keeps from other parties; the opt-in sentence says "this chat", and the hosted OpenAI embedder already sends every chunk of every chat, case chats included. *Recommended:* yes, the same as the hosted embedder: the owner's opt-in covers every chat, and the pane's sentence says so. The alternative is to skip the hosted rerank whenever the chat has a `caseId` (the local cross-encoder would not run either, by Decision 5).
3. **Should `king-louie-service import --from` carry the typesafe.ai key from a desktop profile?** Today it carries provider tokens and the ElevenLabs key only (`desktop-source.js` skips other `__` keys). *Recommended:* no, not in this plan: re-enter the key in the service's pane; carrying it is a change to the import's allowlist and its tests, best made with the next import change.

## Self-review

- **Spec coverage.** Ruling 1 (opt-in, the sentence, the confirmation, `KL_TEST_MODE`, loopback only): Global Constraints, Tasks 6, 7, 8. Ruling 2 (SearchHistory and per turn, fused order on failure, one warning per episode, provenance note): Tasks 5, 6, 7. Ruling 3 (a `BaseProvider` subclass, `request` with the abort signal, decide-only, the key stored like a provider token, the Vault cannot read it): Tasks 2, 7, Decision 1. Ruling 4 (unpriced, tokens shown, no price table): Tasks 2, 8, 9. Ruling 5 (`reranker`, `rerankSkipped`, "reranked"): Tasks 5, 8. Ruling 6 (Vault never sent): Task 6. Ruling 7 (both scorers, both adapters on one client, the cache keyed by model and mode, `--send-private`, unknown-price tokens, loopback tests): Tasks 3, 9, 10. Ruling 8 (QUOTA for answer, judge and summarizer, exit 2, `stoppedBy`, nothing cached, rerun from the cache, rate limits still retried, the provider seam checked): Task 1, Decisions 13, 14. Ruling 9 (the measurement, with its rule fixed in advance): Task 12. Ruling 10 (abstain accuracy): not in this plan. Ruling 11 (test commands, no full suite, no network, boundaries, `createLogger`, `textContent`, invented values, files never read): Global Constraints and every task's run step. Ruling 12 (spec and CLAUDE.md edits): Task 11; §6.7 in Task 12.
- **Review Focus pins.** 1: Task 3 ("a candidate set over the 32K state cap…"). 2: Task 5 ("says why…": slow), Task 6 ("a call slower than maxMs…", "per turn: a Jev call slower…"). 3: Task 6 ("a key revoked mid-session…", "a 429 holds…", "sends nothing… with no key"), Task 7 ("a refused key pauses Jev; saving a key lifts it"). 4: Task 6 ("a failure that lands after a switch…"). 5: Task 6 ("dispatch: kind local…", "sends nothing under KL_TEST_MODE…", "Vault results…"), Task 7 ("choosing jev needs confirmJev…", "under KL_TEST_MODE a turn…").
- **No placeholders.** Every step has its code or its exact text; Task 12's `<…>` marks are the measured numbers the controller fills in from the runs, by design.
- **Type consistency across tasks.** `ask(body, { abortSignal }) → { answers, usage: { inputTokens, outputTokens }, model }`: produced by Task 2, consumed by Task 3 (`jevScores`) and Task 9 (`once`). `jevScores(...) → { scores, inputTokens, outputTokens, requests, model }` and `err.jevUsage`: Task 3, consumed by Task 6 (`_count`) and Task 9 (`createJevScorer`). `MODES` (`['batched', 'pointwise']`): Task 3, consumed by Tasks 9 and 10 (the error text "batched or pointwise" in Tasks 3, 9, 10). The reranker callback `(query, chunks, { maxMs, info })` with `info.name`: Task 5, implemented by `createHostReranker` (Task 5), `JevReranker#rerank` and `createRecallReranker` (Task 6). `rerank.kind` / `rerank.jev.model`: Task 4, read by Tasks 6, 7, 10. `stats.reranker` / `stats.rerankSkipped`: Task 5, copied in Task 8, asserted in Tasks 6 and 7. `JevReranker#status()` states (`off`, `not-started`, `no-key`, `refused`, `failing`, `ready`): Task 6, viewed by Task 7's IPC, worded by Task 8's `historyRerankStatusText`. `saveTypesafeKey` / `clearTypesafeKey` / `hasTypesafeKey` / `getJevReranker`: Task 7's core and IPC. `stopErrorFor`, `STOP_CODES`, `withRetries({ isRetryable })`: Task 1, consumed by Tasks 9 and 10. `JEV_STOP_CODES` (Task 9) equals the Jev part of `RUN_STOP_CODES` (Task 10), pinned by a Task 10 test. `questionCount` in `prepare` options: Task 10's `run.js`, read by Task 10's adapter. `adapterStats` from `finish` and `runStats()`: Task 10.
