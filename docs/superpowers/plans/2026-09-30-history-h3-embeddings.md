# History H3: Embeddings, Fusion, Rerank and the User-Turn Tail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall finds excerpts by meaning as well as by words: every chunk gets a vector from a local embedding model (or Ollama, or OpenAI) in the background, each turn fuses cosine hits with BM25 and drops near-duplicates by cosine, `SearchHistory` reranks with a local cross-encoder, and the tail counts user turns so an agent session never sends an empty tail again; the result is measured on LongHaul against the H2 numbers.

**Architecture:** Schema step 3 adds the `embeddings` table (one unit float32 vector per chunk per embedder key, `local:Xenova/bge-small-en-v1.5`). The local models run in an **embed worker**: a child process spawned from `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (the PDF sandbox's pattern), talking NDJSON over stdin and fd 3, restarted with backoff when onnxruntime crashes it. An `EmbedderHost` picks the embedder from `settings.history.embedder` and reports its state; an `EmbedIndexer` fills the table a batch at a time; a `VectorIndex` keeps per-chat float32 matrices in an LRU under `vectorCacheMb`; a `vectorSearch` callback gives the H2 `Retriever` its step-2 list, and a `vectorOf` callback its cosine dedupe. The cross-encoder moves from LongHaul's probe into the same worker and is wired behind `SearchHistory` (and an opt-in per-turn `rerank.enabled`). LongHaul's `kl-recall-vec`/`-rerank` gain `--embed-provider local` so the shipped defaults are measured with the app's own models.

**Tech Stack:** Node 24 `node:sqlite`, `node:child_process`, `@huggingface/transformers` 4.3.0 on native `onnxruntime-node` 1.30.0 (CPU), `node:test`, Electron 41 (renderer, packaging), LongHaul (`bin/longhaul.js`).

**Spec:** `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, stage H3 (§11.2). Sections in force: §3 and §3.2 (`Embedder`, `EmbedRunner`), §4.1 `embeddings`, §5.2, §5.3, §6.1 (rewritten by this plan: user turns), §6.2 (short follow-up fallback), §6.3 steps 2, 3, 6, 7, §6.7, §7 (`embedder` in provenance, the recall line's degraded wording), §12 rows touched below, §13 (embed runner, retriever vectors), §14 (`embedder` block, `dedupeCosine`, `vectorCacheMb`, `rerank`), §15 (embedder unavailable, worker crashes, download interrupted, reranker too slow), §16, Appendix A.3. Measured facts: `.superpowers/sdd/plans-2026-09-30-measured-facts.md` (the plan argues from it; cited as "measured facts"). Terms follow `CONTEXT.md` (chunk, excerpt, tail, recalled block, recall vs retrieval, provenance).

**Execution order (ruled 2026-09-30, the same in the B3 plan `docs/superpowers/plans/2026-09-30-longhaul-b3-answer-stage.md`):** H3 Tasks 1–14 → B3 Tasks 1–16 → H3 Tasks 15–16 → B3 Task 17. B3 rewrites `src/longhaul/run.js` (its Task 11), `src/longhaul/commands/run.js` (its Task 12, which already carries `--embed-provider`) and `renderSummaryMarkdown` in `src/longhaul/scoring.js` (its Task 9) whole; Task 15 here edits those files as B3 left them (`runEvidenceOnly` / `runAnswerStage`), never as they are on `main` today.

## Global Constraints

- Tests run with node's built-in runner, never `jest`: `node --test tests/<file>.test.js`; look for `# fail 0`. **The owner says the full `npm test` is currently broken for reasons unrelated to H3.** Each task runs only its own test files (listed in its steps). The final task runs `npm test` only if it is green on `main` at that point; otherwise it runs `node --test tests/history-*.test.js tests/longhaul-*.test.js tests/renderer-history-*.test.js tests/electron-boundary.test.js tests/fake-embedder.test.js` and says in its report which one it ran.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` covers every new file. The embed worker runs under `ELECTRON_RUN_AS_NODE=1` and never requires `electron`.
- Log through `createLogger` from `src/logging.js`; no bare `console.*` in `src/`.
- **No network and no model download in unit tests.** The worker is tested with `tests/helpers/fake-embed-backend.js` (loaded through `KL_EMBED_WORKER_BACKEND`, set only by `EmbedRunner({ testBackend })`), the host and core with `tests/helpers/fake-embed-runner.js`, the local backend with a fake transformers object, hosted embedders with `tests/helpers/fake-embedding-server.js` or a loopback `http` server, retrieval with `tests/helpers/fake-embedder.js` (28-word bag of words).
- Open source: invented fixture values only (`Lakeside lot`, `4417`, `example.com`, `192.0.2.x`); no personal names, paths or domains. Nothing from `~/.longhaul` or the owner's exports enters the repo; spec §6.7 gets numbers only.
- Vault messages are never embedded: `UNINDEXED_TOOLS` (`Vault`) makes no chunks, and embeddings exist only for chunks (pinned by a Task 3 test).
- Every provider request goes through `BaseProvider.request` (`OpenAIProvider#embed`, the new `OllamaProvider#embed`). The local model download is transformers.js's own fetch inside the worker; it is not a provider request and touches no key.
- Prices come only from `Catalog.price`. Hosted embedding tokens are counted (`Embedder#tokens`); the local embedder is unpriced and says so, never `$0`.
- Settings namespace `history`. H3 keys and defaults (spec §14, with this plan's measured changes): `history.embedder = { kind: 'local', model: 'Xenova/bge-small-en-v1.5', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' }, openai: { model: 'text-embedding-3-small' }, batchSize: 16, intervalMs: 2000, maxChunksPerToolResult: 0 }`; `history.recall` adds `dedupeCosine: 0.92`, `vectorCacheMb: 256`, `rerank: { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 }`, `tailUserTurns: 4` (provisional; Task 16 measures it), `tailMaxRows: 64`, `queryFallbackMinChars: 0`, and drops `tailMessages`; `history.version: 3`.
- An embedder key is `<kind>:<model>` (`local:Xenova/bge-small-en-v1.5`, `ollama:nomic-embed-text`, `openai:text-embedding-3-small`). Vectors are stored unit-length, little-endian float32. Changing the key never deletes vectors; "Rebuild embeddings" deletes the active key's rows only.
- Local model files live in `<dataDir>/models/<org>/<name>/` (LongHaul: `LONGHAUL_HOME/private/models/`), download once, then load with remote access off.
- `KL_TEST_MODE` never starts the embedder: the host starts from `startModelsBackgroundChecks` (called by `main.js` and `runService`, skipped under `KL_TEST_MODE`), never from `createCore().start()`.
- A turn never waits more than `QUERY_TIMEOUT_MS` (1,500) for its query embedding; on a timeout or failure the turn runs on BM25 alone and provenance says why.
- Schema changes are new `SCHEMA_STEPS` entries; never edit a released step.
- LongHaul may use `src/history/` and `src/providers/`; nothing in `src/` outside `src/longhaul/` requires it (`tests/longhaul-boundary.test.js`).
- Renderer text from the store or the host is set with `textContent`, never `innerHTML`.

## Review Focus

1. **The model download fails (offline first run, a proxy, a half-finished download).** Expected: recall runs on BM25 alone, the log and the owner get one warning ("Recall uses keyword search only: …"), the settings pane says "Not available", the next try is after 10 minutes, on Retry or on a settings change, and a model folder without the completion marker is deleted before that try so a torn file is never loaded. Pinned: Task 5 (partial folder discarded, no marker after a failed load) and Task 7 (state, one warning, retry after `retryMs`).
2. **The worker crashes in the middle of a batch (a native onnxruntime fault on one odd chunk).** Expected: only the request in flight fails; the worker restarts after 1 s / 5 s / 30 s with its models reloaded; the indexer retries the batch one chunk at a time and tombstones the chunk that crashes it alone, so it is never retried for that key; three crashes in ten minutes turn local embedding off for the session with a badge. A poison chunk therefore costs two of those three crashes (its batch, then itself alone) and never another; a second poison chunk inside the same ten minutes turns local embedding off until Retry (Decision 13). Pinned: Task 6 (crash, restart and reload, disabled after three) and Task 8 (poison chunk isolated and tombstoned).
3. **A chat with 100K chunks, or several big chats, against `vectorCacheMb`.** Expected: memory held for vectors never exceeds the cap (a matrix that would outgrow it stops loading), a chat too big for the cap on its own is searched by BM25 only with one log line and a provenance note, and other chats are evicted least recently used first. Pinned: Task 9 (too-large chat skipped with one warning; LRU eviction; bytes never over the cap) and Task 10 (the provenance note: `stats.vectorsSkipped` names `vectorCacheMb` for such a chat).
4. **The owner changes the embedder model while the backfill is running.** Expected: a batch already sent for the old model is written under the old key only; slices of the old model still queued are refused (`MODEL_CHANGED`) and never embedded by the new model under the old key; the new key fills from the start; retrieval uses only the active key's vectors. Pinned: Task 6 (queued old-model slice refused after a load of another model), Task 7 (a stale load result ignored) and Task 8 (in-flight batch lands under its own key; the next tick fills the new key).
5. **onnxruntime or transformers missing or failing in the packaged app** (asar not unpacked, the RunAsNode fuse off, a Windows DLL failure). Expected: the worker exits at once or answers `MODEL_UNAVAILABLE`, the error names the likely cause (the quick-exit hint), recall stays on BM25, and the app keeps running. Pinned: Task 5 (runtime `require` failure maps to `MODEL_UNAVAILABLE`), Task 6 (a worker that exits before replying gets the hint) and Task 14 (the packaging config test and the manual packaged check).

---

## H2 seams this plan builds on

Actual names on `main` (ccc46a7), read from the code:

| Seam | Where | Used by |
|---|---|---|
| `SCHEMA_STEPS` (array of `{ version, up(db) }`), `applySchema(db)`, `currentVersion`, `latestVersion`; one row in `schema_version` (replaced per step) | `src/history/schema.js` | Task 3 appends `{ version: 3 }` |
| `HistoryStore.open(dbPath, { readonly, allowOlderSchema, now, chunkOptions })`; `store.db`, `store.dbPath`, `store.readonly`, `store.isOpen`, `store.schemaVersion`, getter `store.indexed` (schema ≥ 2) | `src/history/history-store.js` | Tasks 3, 8 |
| `store.transaction(fn)`: `BEGIN IMMEDIATE`, nested savepoints, synchronous `fn(db)` only | same | Task 3 `putEmbeddings` |
| Every insert path ends in `_insertMessage` → `_indexMessage` → `insertChunks` (same transaction) | same, `chunk-index.js` | chunks exist when a message commits |
| `appendMessage(chatId, message, { updatedAt, patch }) → { message, seq }`; `truncateFrom(chatId, seq)`; `replaceChat`; `updateChat(id, { messages })`; `deleteChat`; `createChat` (deletes an existing chat with the id first) | same | Task 3 bumps `vectorEpoch`, fires `onAppend` |
| `prepared(db, sql)` per-connection statement cache | `src/history/chunk-index.js` | Task 3 |
| `chunks(id INTEGER PRIMARY KEY, message_id, chat_id, idx, kind, text, chars, ts)`; no AUTOINCREMENT, so a truncate lets a later chunk reuse an id | `SCHEMA_V2_SQL` | Task 9 invalidation |
| `store.chunks(ids)`, `chunksOfMessage`, `chunksOfChat`, `searchText(query, { chatIds, kinds, limit, upToSeq, messageIds, prefixMinChars })`, `tailScanPage(chatId, { beforeSeq, limit, toolCalls })`, `tailToolResults`, `lastSeq`, `messageChunkCounts`, `historyChars` | store | Tasks 2, 10 |
| `UNINDEXED_TOOLS` (`Vault`), `chunkMessage`, `toolUseSummary`, `toolResultText` | `src/history/chunker.js` | Task 3 test |
| `startChunkBackfill(store, { batchSize, schedule, log }) → { stop(), done }`; started in create-core's `start()`, stopped in `shutdown()` before the store closes; skips read-only and `:memory:` stores | `src/history/backfill.js` | Task 8 pattern, Task 12 |
| `new Retriever({ store, estimator, vectorSearch, reranker })`; `retrieve({ query, contextQueries, chatIds, kinds, excludeMessageIds, budgetTokens, upToSeq, settings, model, now, vectorHits, lexical, reranker, stats })`; `_vector` slices to `vectorTopK`; `_fuse` RRF; `_rerank(query, items, rerank, reranker)` races `maxMs`; exact-text dedupe runs before the rerank; `dedupeJaccard` in the budget loop; `inScope` guard on vector hits | `src/history/retriever.js` | Tasks 10, 11 |
| `new ContextBuilder({ store, retriever, estimator, getSettings, now })`; `build({ chatId, message, model, upToSeq, vectorHits, lexical, reranker })` → `{ tail, recalled, stats: { tail, recalledChunkIds, recalledExcerpts, estTokens, fullHistoryEstTokens, embedder: 'none', scope, query } }`; `_scan` (pages of `PAGE` 200), `_tail`, `_toolResults` (`TAIL_RESULT_PAGE` 20, `TAIL_RESULT_SCAN_MAX` 64), `isContent` | `src/history/context-builder.js` | Tasks 2, 10 |
| `HISTORY_DEFAULTS` (frozen), `mergeHistorySettings(source)`; recall has `tailMessages` 16, `vectorTopK` 50, `rerank { enabled, model, topM 20, maxMs }` | `src/history/settings.js` | Tasks 1, 2 |
| `searchHistoryExcerpts({ store, retriever, chatId, query, kinds, limit, settings, asOf })` | `src/history/search.js` | Task 11 |
| Tools read `context.history = { chatId, store, retriever, estimator, getSettings }` (create-core `get history()`) | `src/tools/builtin/history-tools.js` | Tasks 11, 12 |
| create-core: `historyStore`, `tokenEstimator`, `historyRetriever`, `contextBuilder`, `historyBackfill`; `paths.dataDir`; `createProviderInstance(type, token)`, `getDecryptedProviderToken`, `catalog`; `startModelsBackgroundChecks` (returns early under `KL_TEST_MODE`); `shutdown()` closes the store last; owner toast `deps.uiToastChannel.send({ title, body })` (contact host) | `src/core/create-core.js` | Task 12 |
| `setSettings(s)` stores `mergeSettings(s)`: **the whole merged object, defaults included, is saved** | create-core line ~380 | Tasks 1, 2 (legacy defaults) |
| Send path copies `built.stats.embedder` into provenance | `src/ipc/chat-handlers.js` ~665 | Task 12 |
| `registerHistoryHandlers(ipcMain, context)`; `IPC.HISTORY_EXCERPTS`, `IPC.HISTORY_SEARCH`; preload `window.electron.history`; the `history` domain is proxied when attached | `src/ipc/history-handlers.js`, `constants.js`, `preload.js`, `src/desktop-bridge/allowlist.js` | Tasks 12, 13 |
| `recallLineText(context)` ends in `· BM25`; `switchSettingsTab(tabName)` | `renderer.js` | Task 13 |
| `OpenAIProvider#embed(inputs, { model, dimensions, abortSignal }) → { vectors, usage: { input }, model }` via `this.request`; `OllamaProvider` (`baseUrl` is `<server>/v1`; `request`; `buildError`) | `src/providers/` | Task 4 |
| PDF sandbox: `spawn(process.execPath, ['--max-old-space-size=N', WORKER_PATH], { env: { ELECTRON_RUN_AS_NODE: '1', SYSTEMROOT }, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], windowsHide: true })`; worker writes fd 3 through `new net.Socket({ fd: 3 })`; `QUICK_EXIT_MS` hint about the RunAsNode fuse | `src/cases/ingest/pdf-sandbox.js`, `pdf-worker.js` | Tasks 5, 6 |
| LongHaul: `EmbeddingCache`, `cacheDir`, `validateModelName` (no `/`), `createEmbedClient`, `embedChunks`, `vectorIndexFor → { dim, matrix, chunkIds, seqs, size }`, `topByCosine`, `embedderFromEnv`; `RerankCache`, `createCachedReranker`, `loadCrossEncoder`; `recallSettings`; `runBenchmark`, `scoreOne`, `summarize`, `renderSummaryMarkdown` (Task 15 edits them as B3 Tasks 9 and 11 rewrote them: `runEvidenceOnly` / `runAnswerStage`) | `src/longhaul/` | Task 15 |
| Test helpers: `openTempStore`, `seedChat`, `readDb`, `isoAt`, `BASE_TIME` (`history-fixture.js`); `createBagOfWordsEmbedder`, `DEFAULT_VOCAB` (28 words); `startFakeEmbeddingServer`, `fakeVector` (64-dim); `closeOpenHistoryStores`; LongHaul `tmpHome`, `sink`, `setupHome` pattern | `tests/helpers/` | all |

## File Structure

New, under `src/history/` (Electron-free):

| File | Responsibility |
|---|---|
| `embed-errors.js` | `EmbedError` (with `code`), `WORKER_FAILURES` |
| `embedders/vectors.js` | `MAX_EMBED_CHARS`, `embedInput`, `unit`, `vecToBlob`, `blobToVec` |
| `embedders/profiles.js` | `profileFor(model)` (pooling, query/document prefixes), `prefixTexts` |
| `embedders/remote.js` | `createRemoteEmbedder({ kind: 'openai' \| 'ollama', model, provider })` |
| `embedders/local-backend.js` | Runs inside the worker: transformers.js loading, download marker, embedding and cross-encoder scoring |
| `embedders/local.js` | `createLocalEmbedder({ runner, model, modelsDir })`: the local `Embedder` over the runner |
| `embedding-index.js` | Schema step 3 SQL and every `embeddings` query, over a `DatabaseSync` |
| `embed-protocol.js` | NDJSON codec shared by runner and worker (`encodeMessage`, `LineReader`, base64 vectors) |
| `embed-worker.js` | The worker process (`runWorker`) |
| `embed-runner.js` | `EmbedRunner`: spawn, priority queue, slices, timeouts, crash backoff, disable |
| `embedder-host.js` | `EmbedderHost`: which embedder is live, its state, warnings, rerank |
| `embed-indexer.js` | `startEmbedIndexer`: background embedding, poison isolation, progress |
| `vector-index.js` | `VectorIndex`: per-chat matrices, LRU, brute-force cosine, `vectorOf` |
| `vector-search.js` | `createVectorSearch({ host, index })` → `{ vectorSearch, vectorOf }`; `QUERY_TIMEOUT_MS` |
| `reranker.js` | `createHostReranker(host)` |

Modified: `src/history/{settings,schema,history-store,retriever,context-builder,search,index}.js`, `src/tools/builtin/history-tools.js`, `src/providers/ollama-provider.js`, `src/core/create-core.js`, `src/ipc/{chat-handlers,history-handlers,constants}.js`, `preload.js`, `renderer.js`, `index.html`, `package.json`, `package-lock.json` (Task 14's install), `src/longhaul/{embeddings,rerank,run,scoring}.js` (`run.js` and `scoring.js` as B3 left them), `src/longhaul/commands/{embed,run}.js`, `src/longhaul/adapters/{kl-recall,kl-recall-vec,kl-recall-rerank}.js`, `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (§7 addenda, Task 16), `CLAUDE.md`.

New elsewhere: `scripts/check-embed-worker.js`, `tests/helpers/fake-embed-backend.js`, `tests/helpers/fake-embed-runner.js`.

New tests: `tests/history-embeddings-store.test.js`, `tests/history-embedders-remote.test.js`, `tests/history-embed-worker.test.js`, `tests/history-local-backend.test.js`, `tests/history-embed-runner.test.js`, `tests/history-embedder-host.test.js`, `tests/history-embed-indexer.test.js`, `tests/history-vector-index.test.js`, `tests/history-vector-search.test.js`, `tests/history-search-rerank.test.js`, `tests/history-core-embeddings.test.js`, `tests/renderer-history-settings.test.js`, `tests/history-packaging.test.js`, `tests/longhaul-local-embed.test.js`.

Changed tests: `tests/history-settings.test.js`, `tests/history-context-builder.test.js`, `tests/history-retriever.test.js`, `tests/history-ipc.test.js`, `tests/history-index.test.js`, `tests/history-backfill.test.js`, `tests/history-core.test.js`, `tests/history-vault.test.js`, `tests/desktop-source-history.test.js`, `tests/helpers/history-fixture.js`, `tests/renderer-history-text.test.js`, `tests/longhaul-adapter-kl-recall.test.js`, `tests/longhaul-rerank.test.js`.

---
## Task 1: The H3 settings (embedder, vectors, rerank) and a settings version

**Files:**
- Modify: `src/history/settings.js` (whole file below)
- Modify: `src/longhaul/adapters/kl-recall.js:37-59` (`recallSettings`)
- Test: `tests/history-settings.test.js` (whole file below)

**Interfaces:**
- Consumes: nothing.
- Produces: `HISTORY_SETTINGS_VERSION` (3); `mergeHistorySettings(source)` now also returns `version: 3` and `embedder: { kind, model, ollama: { baseUrl, model }, openai: { model }, batchSize, intervalMs, maxChunksPerToolResult }`, and `recall.dedupeCosine`, `recall.vectorCacheMb`, `recall.rerank.{ search, searchMaxMs }` (`topM` default 100); `EMBEDDER_KINDS`; `LOCAL_MODEL_RE`, `REMOTE_MODEL_RE`; `embedderKey(embedder) → 'local:<model>' | 'ollama:<model>' | 'openai:<model>' | null`. A source without `version: 3` is a settings file saved before H3: a `rerank.topM` of exactly 20 (the old shipped default, saved only because `setSettings` stores merged defaults) reads as unset. Task 2 adds the tail keys the same way.

Why `topM` 100: measured facts, "Rerank": topM 20 changes nothing at a 6K budget (the budget already selects 60–90 chunks); the knee is 100 (reference+fused 0.542 → 0.584, containment 0.563 → 0.592–0.602); 200 adds little for twice the time.

- [ ] **Step 1: Write the failing test**

Replace `tests/history-settings.test.js` with:

```js
// tests/history-settings.test.js
// The history settings namespace (recall spec §14; stages H2 and H3).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, mergeHistorySettings, embedderKey
} = require('../src/history/settings');
const { mergeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');

const RERANK = { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 };
const EMBEDDER = {
  kind: 'local',
  model: 'Xenova/bge-small-en-v1.5',
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
  openai: { model: 'text-embedding-3-small' },
  batchSize: 16,
  intervalMs: 2000,
  maxChunksPerToolResult: 0
};
const saved = (over = {}) => mergeHistorySettings({ version: HISTORY_SETTINGS_VERSION, ...over });

describe('history settings', () => {
  it('defaults match the spec', () => {
    const s = mergeHistorySettings(undefined);
    assert.strictEqual(s.version, 3);
    assert.deepStrictEqual(s.recall, {
      enabled: true, tailMessages: 16, tailTokens: 6000, tailMaxMessageTokens: 1500, tailIncludeToolCalls: true,
      tailIncludeToolResults: true, tailToolResultMaxTokens: 1000,
      recalledTokens: 6000, queryUserTurns: 0, bm25TopK: 200, rrfK: 60,
      kindWeights: { user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 },
      recencyWeight: 0.3, recencyHalfLifeDays: 30, maxChunksPerMessage: 4,
      vectorTopK: 50, dedupeCosine: 0.92, vectorCacheMb: 256, rerank: RERANK,
      completeMessageTokens: 0, prefixMinChars: 0, queryContextSeparate: false, pairToolMessages: false,
      diversifyFirst: false, dedupeJaccard: 0, recencyByPosition: false, recencyHalfLifeFraction: 0.25
    });
    assert.deepStrictEqual(s.embedder, EMBEDDER);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 40 });
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall));
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.embedder.ollama));
    assert.ok(!Object.isFrozen(s.recall), 'merged settings are a fresh object');
    assert.deepStrictEqual(EMBEDDER_KINDS, ['local', 'ollama', 'openai', 'none']);
  });

  it('merges one key at a time and keeps the rest', () => {
    const s = mergeHistorySettings({ recall: { enabled: false, kindWeights: { tool_result: 0.2 } }, chunk: { minChars: 10 }, embedder: { kind: 'none' } });
    assert.strictEqual(s.recall.enabled, false);
    assert.strictEqual(s.recall.kindWeights.tool_result, 0.2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 10 });
    assert.deepStrictEqual(s.embedder, { ...EMBEDDER, kind: 'none' });
  });

  it('falls back to the default for a value of the wrong type or out of range', () => {
    const s = mergeHistorySettings({
      recall: {
        enabled: 'no', queryUserTurns: -1, tailTokens: -5, recalledTokens: NaN, recencyHalfLifeDays: 0,
        recencyWeight: 3, bm25TopK: 0, maxChunksPerMessage: 2.7, kindWeights: null,
        tailIncludeToolResults: 0, tailToolResultMaxTokens: 0, recencyByPosition: 1, recencyHalfLifeFraction: -0.5,
        dedupeCosine: 1.5, vectorCacheMb: 0
      },
      chunk: { targetChars: 10 },
      readHistoryMaxTokens: 'lots'
    });
    assert.strictEqual(s.recall.enabled, true);
    assert.strictEqual(s.recall.queryUserTurns, 0);
    assert.strictEqual(s.recall.tailTokens, 6000);
    assert.strictEqual(s.recall.recalledTokens, 6000);
    assert.strictEqual(s.recall.recencyHalfLifeDays, 30);
    assert.strictEqual(s.recall.recencyWeight, 0.3);
    assert.strictEqual(s.recall.bm25TopK, 200);
    assert.strictEqual(s.recall.maxChunksPerMessage, 2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.strictEqual(s.chunk.targetChars, 1500);
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.strictEqual(s.recall.tailIncludeToolResults, true, 'a falsy non-boolean falls back to the default, not to false');
    assert.strictEqual(s.recall.tailToolResultMaxTokens, 1000);
    assert.strictEqual(s.recall.recencyByPosition, false);
    assert.strictEqual(s.recall.recencyHalfLifeFraction, 0.25);
    assert.strictEqual(s.recall.dedupeCosine, 0.92);
    assert.strictEqual(s.recall.vectorCacheMb, 256);
    assert.strictEqual(mergeHistorySettings({ recall: { dedupeCosine: 0 } }).recall.dedupeCosine, 0, '0 turns the cosine dedupe off');
  });

  it('rerank: type-checked one key at a time', () => {
    const d = RERANK;
    assert.deepStrictEqual(saved({ recall: { rerank: { enabled: true } } }).recall.rerank, { ...d, enabled: true });
    assert.deepStrictEqual(saved({ recall: { rerank: { topM: 50.9 } } }).recall.rerank, { ...d, topM: 50 });
    assert.deepStrictEqual(saved({ recall: { rerank: { enabled: 'yes', topM: 0 } } }).recall.rerank, d);
    assert.deepStrictEqual(saved({ recall: { rerank: true } }).recall.rerank, d);
    assert.deepStrictEqual(saved({ recall: { rerank: { maxMs: 500, model: 'Xenova/other-reranker' } } }).recall.rerank,
      { ...d, maxMs: 500, model: 'Xenova/other-reranker' });
    assert.deepStrictEqual(saved({ recall: { rerank: { search: false, searchMaxMs: 9000 } } }).recall.rerank, { ...d, search: false, searchMaxMs: 9000 });
    for (const maxMs of [0, -5, NaN, Infinity, '2000', null]) {
      assert.strictEqual(saved({ recall: { rerank: { maxMs } } }).recall.rerank.maxMs, 2000, String(maxMs));
      assert.strictEqual(saved({ recall: { rerank: { searchMaxMs: maxMs } } }).recall.rerank.searchMaxMs, 6000, String(maxMs));
    }
    for (const model of ['', '   ', 42, null, ['x'], '../escape', 'a/../b', 'C:\\models\\x', 'org/name:tag']) {
      assert.strictEqual(saved({ recall: { rerank: { model } } }).recall.rerank.model, d.model, JSON.stringify(model));
    }
    assert.strictEqual(saved({ recall: { rerank: { search: 'yes' } } }).recall.rerank.search, true);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall.rerank));
  });

  it('a settings file saved before H3 (no version): rerank.topM 20 was the shipped default and reads as unset', () => {
    assert.strictEqual(mergeHistorySettings({ recall: { rerank: { topM: 20 } } }).recall.rerank.topM, 100);
    assert.strictEqual(mergeHistorySettings({ recall: { rerank: { topM: 30 } } }).recall.rerank.topM, 30);
    assert.strictEqual(saved({ recall: { rerank: { topM: 20 } } }).recall.rerank.topM, 20, 'a version-3 file keeps a chosen 20');
  });

  it('embedder: kind, model ids, the Ollama address and the pacing are type-checked', () => {
    const e = (over) => mergeHistorySettings({ embedder: over }).embedder;
    assert.strictEqual(e({ kind: 'onnx' }).kind, 'local');
    assert.strictEqual(e({ kind: 'ollama' }).kind, 'ollama');
    for (const model of ['../evil', 'a/../b', 'C:\\x', 'org/name:tag', '', 42]) assert.strictEqual(e({ model }).model, EMBEDDER.model, JSON.stringify(model));
    assert.strictEqual(e({ model: 'Xenova/all-MiniLM-L6-v2' }).model, 'Xenova/all-MiniLM-L6-v2');
    assert.strictEqual(e({ ollama: { model: 'nomic-embed-text:latest' } }).ollama.model, 'nomic-embed-text:latest');
    assert.strictEqual(e({ ollama: { baseUrl: 'ftp://192.0.2.10' } }).ollama.baseUrl, EMBEDDER.ollama.baseUrl);
    assert.strictEqual(e({ ollama: { baseUrl: 'http://192.0.2.10:11434/' } }).ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(e({ openai: { model: 'text-embedding-3-large' } }).openai.model, 'text-embedding-3-large');
    assert.strictEqual(e({ batchSize: 0 }).batchSize, 16);
    assert.strictEqual(e({ batchSize: 1000 }).batchSize, 256);
    assert.strictEqual(e({ intervalMs: 50 }).intervalMs, 2000);
    assert.strictEqual(e({ maxChunksPerToolResult: -1 }).maxChunksPerToolResult, 0);
    assert.strictEqual(e({ maxChunksPerToolResult: 3 }).maxChunksPerToolResult, 3);
  });

  it('embedderKey names the model the vectors belong to', () => {
    const e = (over) => mergeHistorySettings({ embedder: over }).embedder;
    assert.strictEqual(embedderKey(e({})), 'local:Xenova/bge-small-en-v1.5');
    assert.strictEqual(embedderKey(e({ kind: 'ollama' })), 'ollama:nomic-embed-text');
    assert.strictEqual(embedderKey(e({ kind: 'openai' })), 'openai:text-embedding-3-small');
    assert.strictEqual(embedderKey(e({ kind: 'none' })), null);
  });

  it('budget-fill knobs: a flag and a fraction, else the default', () => {
    const on = mergeHistorySettings({ recall: { diversifyFirst: true, dedupeJaccard: 0.8 } }).recall;
    assert.strictEqual(on.diversifyFirst, true);
    assert.strictEqual(on.dedupeJaccard, 0.8);
    for (const bad of [{ diversifyFirst: 'yes', dedupeJaccard: 1.5 }, { diversifyFirst: 1, dedupeJaccard: -0.1 }, { dedupeJaccard: '0.8' }]) {
      const s = mergeHistorySettings({ recall: bad }).recall;
      assert.strictEqual(s.diversifyFirst, false, JSON.stringify(bad));
      assert.strictEqual(s.dedupeJaccard, 0, JSON.stringify(bad));
    }
  });

  it('is part of mergeSettings and DEFAULT_SETTINGS, and a merged file stays as merged', () => {
    assert.strictEqual(DEFAULT_SETTINGS.history.embedder.kind, 'local');
    assert.strictEqual(mergeSettings({}).history.recall.enabled, true);
    const merged = mergeSettings({ history: { recall: { recalledTokens: 2000, rerank: { topM: 20 } } } });
    assert.strictEqual(merged.history.recall.recalledTokens, 2000);
    assert.strictEqual(merged.history.recall.rerank.topM, 100);
    assert.strictEqual(merged.history.version, 3);
    const chosen = mergeSettings({ ...merged, history: { ...merged.history, recall: { ...merged.history.recall, rerank: { ...merged.history.recall.rerank, topM: 20 } } } });
    assert.strictEqual(chosen.history.recall.rerank.topM, 20, 'after the first merge, 20 is a choice');
    assert.strictEqual('retrieval' in merged.history, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-settings.test.js`
Expected: FAIL: `HISTORY_SETTINGS_VERSION` is undefined and the defaults have no `embedder`, `dedupeCosine` or `vectorCacheMb`.

- [ ] **Step 3: Write the implementation**

Replace `src/history/settings.js` with:

```js
// src/history/settings.js
// The `history` settings namespace (recall spec §14; stages H2 and H3).
// Every value is type-checked: a hand-edited settings file must never turn a
// budget into NaN, a negative number or a division by zero.
//
// version: setSettings stores the whole merged object, defaults included, so
// a file saved before H3 holds the old shipped defaults as if they were
// choices. A source without version 3 is such a file, and a value that was a
// shipped default then reads as unset (rerank.topM 20 here; the tail keys
// below). The output always carries version 3, so the mapping runs once.
const HISTORY_SETTINGS_VERSION = 3;
const EMBEDDER_KINDS = Object.freeze(['local', 'ollama', 'openai', 'none']);
// A local model id is org/name (or name): letters, digits, . _ -; it becomes
// a folder under <dataDir>/models, so no ':' and no '.'/'..' segment.
const LOCAL_MODEL_RE = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})?$/;
// A hosted model id may carry a tag (Ollama's "nomic-embed-text:latest").
const REMOTE_MODEL_RE = /^[A-Za-z0-9._:-]{1,100}(\/[A-Za-z0-9._:-]{1,100})?$/;
const LEGACY_RERANK_TOPM = 20;

const HISTORY_DEFAULTS = Object.freeze({
  // Defaults measured on the LongHaul private set (2026-09-30, 103 verified
  // questions over four real sessions; recall spec §6.7).
  recall: Object.freeze({
    enabled: true,
    // The tail (spec §6.1).
    tailMessages: 16,
    tailTokens: 6000,
    tailMaxMessageTokens: 1500,
    tailIncludeToolCalls: true,
    tailIncludeToolResults: true,
    tailToolResultMaxTokens: 1000,
    // Retrieval (spec §6.3).
    recalledTokens: 6000,
    queryUserTurns: 0,
    bm25TopK: 200,
    rrfK: 60,
    kindWeights: Object.freeze({ user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 }),
    recencyWeight: 0.3,
    recencyHalfLifeDays: 30,
    maxChunksPerMessage: 4,
    // Step 2: the top cosine hits fused with BM25 (above 50 bought nothing).
    vectorTopK: 50,
    // Step 7 with vectors: a candidate whose cosine to a selected chunk
    // exceeds this is dropped; 0 turns it off.
    dedupeCosine: 0.92,
    // The in-memory vector matrices, all chats together (spec §5.3).
    vectorCacheMb: 256,
    // Step 6: a local cross-encoder rescores the top topM. topM must exceed
    // what the budget selects (60-90 chunks at 6,000 tokens): 20 changed
    // nothing, 100 is the knee (about 2.2 s on a laptop CPU). enabled: every
    // turn (off: too slow per turn); search: SearchHistory, where the model
    // is waiting anyway, under searchMaxMs. maxMs: a per-turn rerank slower
    // than this is skipped for that turn (spec §15).
    rerank: Object.freeze({ enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 }),
    // Measured and left off (spec §6.7); 0 / false = off.
    completeMessageTokens: 0,
    pairToolMessages: false,
    prefixMinChars: 0,
    queryContextSeparate: false,
    diversifyFirst: false,
    dedupeJaccard: 0,
    recencyByPosition: false,
    recencyHalfLifeFraction: 0.25
  }),
  // Which embedder fills the embeddings table (spec §5.2). local runs in the
  // embed worker; ollama and openai go through their providers.
  embedder: Object.freeze({
    kind: 'local',
    model: 'Xenova/bge-small-en-v1.5',
    ollama: Object.freeze({ baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' }),
    openai: Object.freeze({ model: 'text-embedding-3-small' }),
    batchSize: 16,
    intervalMs: 2000,
    // 0: every chunk of a tool result is embedded; n: only its first n (all
    // are always in the full-text index).
    maxChunksPerToolResult: 0
  }),
  chunk: Object.freeze({ targetChars: 1500, minChars: 40 }),
  readHistoryMaxTokens: 8000
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// A count or budget >= min; `integer` floors it.
const atLeast = (value, fallback, min, integer = false) => {
  if (!finite(value) || value < min) return fallback;
  return integer ? Math.floor(value) : value;
};
const positive = (value, fallback) => (finite(value) && value > 0 ? value : fallback);
const fraction = (value, fallback) => (finite(value) && value >= 0 && value <= 1 ? value : fallback);
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const noDotSegment = (v) => !v.split('/').some((seg) => /^\.+$/.test(seg));
const localModel = (v, fallback) => (typeof v === 'string' && LOCAL_MODEL_RE.test(v) && noDotSegment(v) ? v : fallback);
const remoteModel = (v, fallback) => (typeof v === 'string' && REMOTE_MODEL_RE.test(v) && noDotSegment(v) ? v : fallback);
function httpUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value.replace(/\/+$/, '') : fallback;
  } catch {
    return fallback;
  }
}

function mergeEmbedder(source) {
  const e = isObject(source) ? source : {};
  const d = HISTORY_DEFAULTS.embedder;
  const o = isObject(e.ollama) ? e.ollama : {};
  const a = isObject(e.openai) ? e.openai : {};
  return {
    kind: EMBEDDER_KINDS.includes(e.kind) ? e.kind : d.kind,
    model: localModel(e.model, d.model),
    ollama: { baseUrl: httpUrl(o.baseUrl, d.ollama.baseUrl), model: remoteModel(o.model, d.ollama.model) },
    openai: { model: remoteModel(a.model, d.openai.model) },
    batchSize: Math.min(256, atLeast(e.batchSize, d.batchSize, 1, true)),
    intervalMs: atLeast(e.intervalMs, d.intervalMs, 100, true),
    maxChunksPerToolResult: atLeast(e.maxChunksPerToolResult, d.maxChunksPerToolResult, 0, true)
  };
}

function mergeHistorySettings(source) {
  const src = isObject(source) ? source : {};
  const legacy = src.version !== HISTORY_SETTINGS_VERSION;
  const r = isObject(src.recall) ? src.recall : {};
  const c = isObject(src.chunk) ? src.chunk : {};
  const d = HISTORY_DEFAULTS.recall;
  const weightsIn = isObject(r.kindWeights) ? r.kindWeights : {};
  const rr = isObject(r.rerank) ? r.rerank : {};
  const kindWeights = {};
  for (const [kind, weight] of Object.entries(d.kindWeights)) kindWeights[kind] = atLeast(weightsIn[kind], weight, 0);
  const topM = legacy && rr.topM === LEGACY_RERANK_TOPM ? d.rerank.topM : atLeast(rr.topM, d.rerank.topM, 1, true);
  return {
    version: HISTORY_SETTINGS_VERSION,
    recall: {
      enabled: flag(r.enabled, d.enabled),
      tailMessages: atLeast(r.tailMessages, d.tailMessages, 0, true),
      tailTokens: positive(r.tailTokens, d.tailTokens),
      tailMaxMessageTokens: positive(r.tailMaxMessageTokens, d.tailMaxMessageTokens),
      tailIncludeToolCalls: flag(r.tailIncludeToolCalls, d.tailIncludeToolCalls),
      tailIncludeToolResults: flag(r.tailIncludeToolResults, d.tailIncludeToolResults),
      tailToolResultMaxTokens: positive(r.tailToolResultMaxTokens, d.tailToolResultMaxTokens),
      recalledTokens: atLeast(r.recalledTokens, d.recalledTokens, 0),
      queryUserTurns: atLeast(r.queryUserTurns, d.queryUserTurns, 0, true),
      bm25TopK: atLeast(r.bm25TopK, d.bm25TopK, 1, true),
      rrfK: atLeast(r.rrfK, d.rrfK, 0),
      kindWeights,
      recencyWeight: fraction(r.recencyWeight, d.recencyWeight),
      recencyHalfLifeDays: positive(r.recencyHalfLifeDays, d.recencyHalfLifeDays),
      maxChunksPerMessage: atLeast(r.maxChunksPerMessage, d.maxChunksPerMessage, 1, true),
      vectorTopK: atLeast(r.vectorTopK, d.vectorTopK, 1, true),
      dedupeCosine: fraction(r.dedupeCosine, d.dedupeCosine),
      vectorCacheMb: positive(r.vectorCacheMb, d.vectorCacheMb),
      rerank: {
        enabled: flag(rr.enabled, d.rerank.enabled),
        model: localModel(rr.model, d.rerank.model),
        topM,
        maxMs: positive(rr.maxMs, d.rerank.maxMs),
        search: flag(rr.search, d.rerank.search),
        searchMaxMs: positive(rr.searchMaxMs, d.rerank.searchMaxMs)
      },
      completeMessageTokens: atLeast(r.completeMessageTokens, d.completeMessageTokens, 0),
      prefixMinChars: atLeast(r.prefixMinChars, d.prefixMinChars, 0, true),
      queryContextSeparate: flag(r.queryContextSeparate, d.queryContextSeparate),
      pairToolMessages: flag(r.pairToolMessages, d.pairToolMessages),
      diversifyFirst: flag(r.diversifyFirst, d.diversifyFirst),
      dedupeJaccard: fraction(r.dedupeJaccard, d.dedupeJaccard),
      recencyByPosition: flag(r.recencyByPosition, d.recencyByPosition),
      recencyHalfLifeFraction: positive(r.recencyHalfLifeFraction, d.recencyHalfLifeFraction)
    },
    embedder: mergeEmbedder(src.embedder),
    chunk: {
      targetChars: atLeast(c.targetChars, HISTORY_DEFAULTS.chunk.targetChars, 200, true),
      minChars: atLeast(c.minChars, HISTORY_DEFAULTS.chunk.minChars, 0, true)
    },
    readHistoryMaxTokens: positive(src.readHistoryMaxTokens, HISTORY_DEFAULTS.readHistoryMaxTokens)
  };
}

// The key an embedder's vectors are stored under (embeddings.model):
// "<kind>:<model>". null for kind none.
function embedderKey(embedder) {
  const e = isObject(embedder) ? embedder : HISTORY_DEFAULTS.embedder;
  if (e.kind === 'local') return `local:${e.model}`;
  if (e.kind === 'ollama') return `ollama:${e.ollama.model}`;
  if (e.kind === 'openai') return `openai:${e.openai.model}`;
  return null;
}

module.exports = {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, LOCAL_MODEL_RE, REMOTE_MODEL_RE, mergeHistorySettings, embedderKey
};
```

In `src/longhaul/adapters/kl-recall.js`, change the settings require to

```js
const { HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, mergeHistorySettings } = require('../../history/settings');
```

and in `recallSettings` pass the version, so a `--recall` value is taken as a choice, never mapped as a pre-H3 file:

```js
  const history = mergeHistorySettings({ version: HISTORY_SETTINGS_VERSION, recall: { ...recall, recalledTokens: budgetTokens }, chunk: { ...(chunk || {}) } });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-settings.test.js tests/core-settings.test.js tests/settings-handlers.test.js tests/longhaul-adapter-kl-recall.test.js tests/history-retriever.test.js tests/history-context-builder.test.js`
Expected: PASS, `# fail 0` (the retriever and builder read only keys that kept their names; if `core-settings` snapshots `DEFAULT_SETTINGS.history`, add `version` and `embedder` to its expectation).

- [ ] **Step 5: Commit**

```bash
git add src/history/settings.js src/longhaul/adapters/kl-recall.js tests/history-settings.test.js
git commit -m "feat(history): H3 settings: embedder block, dedupeCosine, vectorCacheMb, rerank topM 100 and search, settings version"
```

---

## Task 2: The tail in user turns, and the short follow-up fallback

**Files:**
- Modify: `src/history/settings.js` (tail keys, `queryFallbackMinChars`)
- Modify: `src/history/context-builder.js:37-214` (`build`, `_scan`, `_tail`)
- Modify: `src/longhaul/adapters/kl-recall.js` (`recallSettings`: name the renamed key)
- Test: `tests/history-settings.test.js`, `tests/history-context-builder.test.js`, `tests/longhaul-adapter-kl-recall.test.js`, `tests/history-core.test.js` (its default-tail expectations)

**Interfaces:**
- Consumes: Task 1's `mergeHistorySettings` and its `legacy` rule.
- Produces: `recall.tailUserTurns` (default 4, provisional until Task 16), `recall.tailMaxRows` (64), `recall.queryFallbackMinChars` (0 = off); `recall.tailMessages` is gone. `ContextBuilder#build` stats gain `tail.userTurns` and `queryFallbackTurns`. `context-builder.js` exports `TAIL_SCAN_MAX_ROWS` (2000) and `FALLBACK_MAX_TURNS` (3).

Why: measured facts, "Tail defect": agent sessions write one assistant row per tool round, so a tail counted in rows came out empty whenever 16 or more rounds followed the owner's last message (a tail never starts with an assistant row). Counting user turns makes the newest user message always part of the tail; the replies after it fill what is left of `tailTokens`, newest first; older turns come whole while they fit.

The short follow-up fallback ships off: no LongHaul question of that shape exists (measured facts, "Other measured"), so there is no default to measure. **Authoring follow-up questions is left to a later LongHaul stage, after B3** (ruled 2026-09-30; B3 does not add the kind): such a question needs a new question kind whose `askAtSeq` sits right after the user message it refers back to, plus validator and verification rules for it, which is benchmark design, not H3. Task 16 records this in spec §6.2.

- [ ] **Step 1: Write the failing tests**

In `tests/history-settings.test.js`, in the first test replace `tailMessages: 16,` with `tailUserTurns: 4, tailMaxRows: 64,` and add `queryFallbackMinChars: 0,` after `queryUserTurns: 0,`. Add, before the closing `});` of the `describe`:

```js
  it('tail keys: user turns, a row ceiling and the fallback threshold, type-checked', () => {
    const r = (over) => saved({ recall: over }).recall;
    assert.strictEqual(r({ tailUserTurns: 2 }).tailUserTurns, 2);
    for (const bad of [0, -1, '4', NaN]) assert.strictEqual(r({ tailUserTurns: bad }).tailUserTurns, 4, String(bad));
    assert.strictEqual(r({ tailUserTurns: 2.7 }).tailUserTurns, 2);
    assert.strictEqual(r({ tailMaxRows: 0 }).tailMaxRows, 64);
    assert.strictEqual(r({ tailMaxRows: 8 }).tailMaxRows, 8);
    assert.strictEqual(r({ queryFallbackMinChars: -1 }).queryFallbackMinChars, 0);
    assert.strictEqual(r({ queryFallbackMinChars: 20 }).queryFallbackMinChars, 20);
    assert.strictEqual('tailMessages' in r({ tailMessages: 10 }), false);
  });

  it('a settings file saved before H3: tailMessages becomes user turns; the shipped 8 and 16 read as unset', () => {
    const r = (over) => mergeHistorySettings({ recall: over }).recall;
    assert.strictEqual(r({ tailMessages: 16 }).tailUserTurns, 4);
    assert.strictEqual(r({ tailMessages: 8 }).tailUserTurns, 4);
    assert.strictEqual(r({ tailMessages: 10 }).tailUserTurns, 5, 'a chat exchange is two rows');
    assert.strictEqual(r({ tailMessages: 3 }).tailUserTurns, 2);
    assert.strictEqual(r({ tailMessages: 10, tailUserTurns: 3 }).tailUserTurns, 3, 'the new key wins');
    assert.strictEqual(saved({ recall: { tailMessages: 10 } }).recall.tailUserTurns, 4, 'a version-3 file has no tailMessages to map');
    const once = mergeSettings({ history: { recall: { tailMessages: 12 } } });
    assert.strictEqual(once.history.recall.tailUserTurns, 6);
    assert.strictEqual(mergeSettings(once).history.recall.tailUserTurns, 6, 'merging again keeps it');
  });
```

In the same file's last test, add `assert.strictEqual(DEFAULT_SETTINGS.history.recall.tailUserTurns, 4);`.

In `tests/history-context-builder.test.js` make these edits (line numbers as on `main`):

- Line 6: `const { ContextBuilder, FALLBACK_MAX_TURNS } = require('../src/history/context-builder');`
- Lines 50–51: title `'the tail is the last tailUserTurns user turns, verbatim and in order'`; settings `{ recall: { tailUserTurns: 4 } }` (the expected seqs 13–20 stay: the fillers alternate user and assistant, so four turns are the same eight rows).
- Replace the test at line 61 with:

```js
  it('by default the tail is the last 4 user turns, and no more', async () => {
    const s = setup(Array.from({ length: 40 }, (_, i) => filler(i + 1)));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), Array.from({ length: 8 }, (_, i) => 33 + i));
    assert.strictEqual(out.tail[0].sender, 'user');
    assert.strictEqual(out.stats.tail.userTurns, 4);
  });
```

- Replace the test at line 69 with:

```js
  it('stops at tailTokens but always keeps the newest user message', async () => {
    const s = setup(Array.from({ length: 6 }, (_, i) => filler(i + 1)), { recall: { tailTokens: 40 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [5, 6]);
    // Nothing fits after the user message: it is still the tail (H2 sent an empty one).
    s.builder.getSettings = () => ({ history: { recall: { tailTokens: 1 } } });
    assert.deepStrictEqual((await s.builder.build({ chatId: 'chat-1', message: 'x' })).tail.map((m) => m.seq), [5]);
  });
```

- Lines 94–95: comment `// tailUserTurns: the 4th user turn back starts at #3.` and settings `{ recall: { tailUserTurns: 4 } }` (expected `[3, 4, 5, 6, 7, 8, 9]` stays).
- In the test at line 383, replace the "old tailMessages 8" block, from `// With the old tailMessages 8 the eight rows are all assistant rows, and` through `assert.deepStrictEqual(eight.tail, []);` (lines 392–396), with:

```js
    // tailMaxRows 8: the user message and the newest seven replies; a tool
    // call is folded only into the reply that followed it.
    s.builder.getSettings = () => ({ history: { recall: { tailMaxRows: 8 } } });
    const capped = await s.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    assert.deepStrictEqual(capped.tail.map((m) => m.seq), [1, 13, 16, 19, 22, 25, 28, 31]);
    assert.ok(capped.tail[1].text.startsWith('[tool] Read: notes/part-4.md'), capped.tail[1].text);
    assert.ok(!capped.stats.tail.seqs.includes(8), 'round 3\'s call belongs to a reply that is not shown');
```

- Replace the test at line 399 with:

```js
  it('reaches the user message behind any number of tool rounds, keeping the newest replies that fit', async () => {
    const s = setup(agentChat(16));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    assert.strictEqual(out.tail.length, 17, 'H2 sent an empty tail here');
    assert.strictEqual(out.tail[0].seq, 1);

    const s40 = setup(agentChat(40), { recall: { tailTokens: 200 } });
    t.cleanup();
    t = s40.t;
    const tight = await s40.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    const seqs = tight.tail.map((m) => m.seq);
    assert.strictEqual(seqs[0], 1, 'the user message is always in');
    assert.ok(seqs.length > 1 && seqs.length < 41, `${seqs.length} rows`);
    assert.strictEqual(seqs.at(-1), 121, 'the newest reply');
    for (let i = 2; i < seqs.length; i += 1) assert.strictEqual(seqs[i] - seqs[i - 1], 3, 'the newest replies, contiguous');
    assert.strictEqual(tight.stats.tail.userTurns, 1);
  });
```

- Line 459: `{ recall: { tailUserTurns: 2, tailIncludeToolResults: true } }` (two turns are the old four rows).
- In `'enabled: false sends the tail only'` (line 196), line 203: the expected tail becomes `Array.from({ length: 8 }, (_, i) => 13 + i)`. Seq 1 is the gate note and seqs 2–20 are `filler(i)`, users at the odd seqs, so the last four user turns start at #13 (19, 17, 15, 13) and run to #20; H2's 16 rows were #5–#20.
- In `'an empty chat, or nothing that matches, gives an empty block'` (line 206), line 212: `assert.deepStrictEqual(out.stats.tail, { fromSeq: null, toSeq: null, seqs: [], shortened: [], userTurns: 0 });` (the empty branch now carries `userTurns: 0`, Step 3).

In `tests/history-core.test.js` (the `seededMessages(40)` chat: users at the odd seqs, the gate note at #3), the last four user turns are #33–#40, eight messages:

- In `'sends the tail and the new message, with the recalled block in the dynamic prompt'`: the comment `// The default tail, #25-#40 (16 messages), then the new message.` becomes `// The default tail, the last 4 user turns (#33-#40, 8 messages), then the new message.`; `assert.strictEqual(first.messages.length, 17, …)` becomes `assert.strictEqual(first.messages.length, 9, `sent ${first.messages.length} messages`);`; `'Seeded note 25 about the weekly grocery list and the garden hose timer.'` becomes `'Seeded note 33 about the weekly grocery list and the garden hose timer.'`.
- In `'stores provenance on the reply and calibrates the estimator'`: `assert.deepStrictEqual(ctx.tail, { fromSeq: 25, toSeq: 40 });` becomes `assert.deepStrictEqual(ctx.tail, { fromSeq: 33, toSeq: 40 });`.
- In `'history.recall.enabled false sends the tail only'`: `assert.strictEqual(calls[0].messages.length, 17, 'the default tail of 16 and the new message');` becomes `assert.strictEqual(calls[0].messages.length, 9, 'the default tail of 4 user turns (8 messages) and the new message');`.

(`'does not calibrate a turn that sends an image or a document'` puts its image on `messages[38]`, seq #39, a user message inside the new tail, so it is unchanged.)

Append to `tests/history-context-builder.test.js`:

```js
describe('ContextBuilder: the short follow-up fallback (spec §6.2)', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const chat = [
    { sender: 'user', text: 'What is the side gate code at the Lakeside lot?' },
    { sender: 'assistant', text: 'It is 4417.' },
    { sender: 'user', text: 'And the fence?' },
    { sender: 'assistant', text: 'Forty meters.' }
  ];

  it('is off by default: a short follow-up is the query alone', async () => {
    const s = setup(chat);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and the other one?' });
    assert.strictEqual(out.stats.query, 'and the other one?');
    assert.strictEqual(out.stats.queryFallbackTurns, 0);
  });

  it('with queryFallbackMinChars, previous user messages are added until the query has that many letters and digits', async () => {
    const s = setup(chat, { recall: { queryFallbackMinChars: 20 } });
    t = s.t;
    // 14 letters, then "And the fence?" adds 11: 25 >= 20, stop.
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and the other one?' });
    assert.strictEqual(out.stats.query, 'and the other one?\nAnd the fence?');
    assert.strictEqual(out.stats.queryFallbackTurns, 1);
    const long = await s.builder.build({ chatId: 'chat-1', message: 'what was the drainage pipe diameter?' });
    assert.strictEqual(long.stats.query, 'what was the drainage pipe diameter?');
    assert.strictEqual(long.stats.queryFallbackTurns, 0);
  });

  it('adds at most FALLBACK_MAX_TURNS previous messages', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ sender: 'user', text: `ok ${i}` }));
    const s = setup(many, { recall: { queryFallbackMinChars: 1000 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and?' });
    assert.strictEqual(out.stats.queryFallbackTurns, FALLBACK_MAX_TURNS);
    assert.strictEqual(out.stats.query, 'and?\nok 5\nok 4\nok 3');
  });
});
```

In `tests/longhaul-adapter-kl-recall.test.js`: line 65, replace `{ tailMessages: -1 }, { tailMessages: 2.5 }, { tailMessages: 'many' }` with `{ tailUserTurns: -1 }, { tailUserTurns: 2.5 }, { tailUserTurns: 'many' }`; lines 74–75, replace `tailMessages: 4` with `tailUserTurns: 2` in both places. Add after that test:

```js
  it('refuses --recall tailMessages and names the keys that replaced it', () => {
    assert.throws(() => createKlRecallAdapter({ recall: { tailMessages: 16 }, tmpRoot: tmpDir() }),
      (err) => err instanceof UsageError && /tailUserTurns/.test(err.message) && /tailMaxRows/.test(err.message));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/history-settings.test.js tests/history-context-builder.test.js tests/longhaul-adapter-kl-recall.test.js`
Expected: FAIL: `tailUserTurns` is undefined, the tail after 16 tool rounds is empty, `stats.queryFallbackTurns` and `FALLBACK_MAX_TURNS` are undefined.

- [ ] **Step 3: Write the implementation**

In `src/history/settings.js`, replace the `// The tail (spec §6.1).` line and `tailMessages: 16,` in `HISTORY_DEFAULTS.recall` with:

```js
    // The tail (spec §6.1), counted in user turns: the last tailUserTurns
    // user messages and the user and assistant messages after the oldest of
    // them. The newest user message is always in; the replies after it fill
    // what is left of tailTokens, newest first; older turns come whole while
    // they fit. tailMaxRows caps the rows. (H2 counted rows, and an agent
    // session, one assistant row per tool round, got an empty tail.)
    tailUserTurns: 4,
    tailMaxRows: 64,
```

add after `queryUserTurns: 0,`:

```js
    // A new message with fewer letters and digits than this also searches
    // with the previous user messages (at most 3) until it has them; 0 = off.
    // Off: no measured question of that shape yet (a later LongHaul stage).
    queryFallbackMinChars: 0,
```

add below `const LEGACY_RERANK_TOPM = 20;`:

```js
// tailMessages counted rows: 8 in the first H2, 16 after B0.
const LEGACY_TAIL_MESSAGES = new Set([8, 16]);
```

add below `mergeEmbedder`:

```js
// tailUserTurns, or from a pre-H3 file's tailMessages: a chat exchange is two
// rows, and a shipped default reads as unset.
function tailUserTurnsFrom(r, legacy, fallback) {
  if (r.tailUserTurns !== undefined) return atLeast(r.tailUserTurns, fallback, 1, true);
  const old = r.tailMessages;
  if (!legacy || !finite(old) || old < 1 || LEGACY_TAIL_MESSAGES.has(old)) return fallback;
  return Math.max(1, Math.ceil(old / 2));
}
```

and in `mergeHistorySettings`, replace `tailMessages: atLeast(r.tailMessages, d.tailMessages, 0, true),` with

```js
      tailUserTurns: tailUserTurnsFrom(r, legacy, d.tailUserTurns),
      tailMaxRows: atLeast(r.tailMaxRows, d.tailMaxRows, 1, true),
```

and add after the `queryUserTurns: …` line:

```js
      queryFallbackMinChars: atLeast(r.queryFallbackMinChars, d.queryFallbackMinChars, 0, true),
```

In `src/longhaul/adapters/kl-recall.js` `recallSettings`, add as the first statement inside `for (const key of Object.keys(recall)) {`:

```js
    if (key === 'tailMessages') {
      throw new UsageError('--recall tailMessages was replaced in H3: the tail counts user turns (tailUserTurns) with a row ceiling (tailMaxRows).');
    }
```

In `src/history/context-builder.js`, add below `const TAIL_RESULT_SCAN_MAX = 64;`:

```js
// The tail scan reads at most this many rows looking for its user messages;
// a user message further back than that is not reached (the tail is then
// empty, and everything in reach stays recallable).
const TAIL_SCAN_MAX_ROWS = 2000;
// The short follow-up fallback adds at most this many previous user messages.
const FALLBACK_MAX_TURNS = 3;
const indexableChars = (text) => (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
```

In `build`, replace the lines from `const previous = …` through `const contextQueries = …` with:

```js
    const users = scanned.filter((m) => m.sender === 'user' && hasText(m));
    const previous = users.slice(0, recall.queryUserTurns).map((m) => String(m.text));
    const fallback = this._fallbackTurns(String(message || ''), users.slice(recall.queryUserTurns), recall);
    const asked = [String(message || ''), ...fallback].filter((text) => text.trim()).join('\n');
    const separate = Boolean(recall.queryContextSeparate);
    const query = separate
      ? asked
      : [asked, ...previous].filter((text) => text.trim()).join('\n');
    const contextQueries = separate ? previous : [];
```

and in the returned `stats` add `queryFallbackTurns: fallback.length,` after `query`.

Replace `_scan` with:

```js
  // Newest first, a page at a time, until the tail and the query have the
  // user messages they need, the chat's start, or TAIL_SCAN_MAX_ROWS rows.
  // Only user and assistant rows, and tool calls when they are folded into
  // the tail. Tool results are read later, for the tail's span only (_tail).
  _scan(chatId, limit, recall) {
    const out = [];
    let users = 0;
    let before = limit;
    const need = Math.max(recall.tailUserTurns, recall.queryUserTurns + (recall.queryFallbackMinChars > 0 ? FALLBACK_MAX_TURNS : 0));
    while (before > 1 && users < need && out.length < TAIL_SCAN_MAX_ROWS) {
      const page = this.store.tailScanPage(chatId, {
        beforeSeq: before, limit: PAGE, toolCalls: Boolean(recall.tailIncludeToolCalls)
      });
      if (!page.length) break;
      for (const m of page) {
        out.push(m);
        if (m.sender === 'user' && hasText(m)) users += 1;
      }
      before = page[page.length - 1].seq;
    }
    return out;
  }

  // Spec §6.2: a new message too short to search on also searches with the
  // previous user messages, newest first, until the query has
  // queryFallbackMinChars letters and digits or FALLBACK_MAX_TURNS are added.
  _fallbackTurns(message, candidates, recall) {
    const min = recall.queryFallbackMinChars;
    let chars = indexableChars(message);
    if (!(min > 0) || chars >= min) return [];
    const out = [];
    for (const m of candidates) {
      if (out.length >= FALLBACK_MAX_TURNS || chars >= min) break;
      out.push(String(m.text));
      chars += indexableChars(m.text);
    }
    return out;
  }
```

In `_tail`, replace everything from the method's first line through the old `replyIndex` definition (the `entries` loop, `entries.reverse()`, the `while (… !== 'user') entries.shift()` loop and the old `replyIndex`) with:

```js
  _tail(scanned, { chatId, limit, recall, query, model }) {
    const content = scanned.filter(isContent);
    // Turns, newest first: a user message and the content rows after it.
    const turns = [];
    let rows = [];
    for (const m of content) {
      rows.push(m);
      if (m.sender !== 'user') continue;
      turns.push(rows.reverse());
      rows = [];
      if (turns.length >= recall.tailUserTurns) break;
    }
    // The newest turn: its user message always, then its replies newest
    // first while they fit tailTokens and tailMaxRows. Older turns come
    // whole while they fit. The tail starts at a user message (Mistral and
    // Gemini reject anything else); what is left out stays recallable.
    const entries = [];
    let used = 0;
    let userTurns = 0;
    if (turns.length) {
      const [newest, ...older] = turns;
      const user = this._entry(newest[0], { recall, query, model });
      used = user.tokens;
      const replies = [];
      for (const m of newest.slice(1).reverse()) {
        if (1 + replies.length >= recall.tailMaxRows) break;
        const e = this._entry(m, { recall, query, model });
        if (used + e.tokens > recall.tailTokens) break;
        replies.unshift(e);
        used += e.tokens;
      }
      entries.push(user, ...replies);
      userTurns = 1;
      for (const turn of older) {
        if (entries.length + turn.length > recall.tailMaxRows) break;
        const es = turn.map((m) => this._entry(m, { recall, query, model }));
        const tokens = es.reduce((n, e) => n + e.tokens, 0);
        if (used + tokens > recall.tailTokens) break;
        entries.unshift(...es);
        used += tokens;
        userTurns += 1;
      }
    }

    // Tool calls and results fold into the reply that followed them: the
    // content row right after them in the chat must be a shown assistant
    // reply. A call whose reply was left out (the newest turn keeps only its
    // newest replies) is not given to a later one.
    const chronological = [...content].reverse();
    const shownAt = new Map(entries.map((e, i) => [e.message.seq, i]));
    const firstAfter = (seq) => {
      let lo = 0;
      let hi = chronological.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (chronological[mid].seq > seq) hi = mid;
        else lo = mid + 1;
      }
      return lo < chronological.length ? chronological[lo] : null;
    };
    const replyIndex = (seq) => {
      const next = firstAfter(seq);
      if (!next || next.sender !== 'assistant' || !shownAt.has(next.seq)) return -1;
      return shownAt.get(next.seq);
    };
```

The rest of `_tail` (the `folded` map, tool calls, `_toolResults`, `messages`, the return) stays. In the returned `stats`, add `userTurns,` after `toSeq: …` in the non-empty branch, and make the empty branch `{ fromSeq: null, toSeq: null, seqs: [], shortened: [], userTurns: 0 }`.

Change the export line to `module.exports = { ContextBuilder, IMAGE_TOKEN_ESTIMATE, TAIL_RESULT_PAGE, TAIL_RESULT_SCAN_MAX, TAIL_SCAN_MAX_ROWS, FALLBACK_MAX_TURNS };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-settings.test.js tests/history-context-builder.test.js tests/longhaul-adapter-kl-recall.test.js tests/history-core.test.js tests/longhaul-run.test.js`
Expected: PASS, `# fail 0`.

Then the end-to-end recall check (Electron; the variable an agent shell inherits must be gone):

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-recall.test.js`
Expected: PASS. Its expectations (`context.tail` `{ fromSeq: 43, toSeq: 50 }` at line 73, at most 10 messages sent at line 80) already describe a four-user-turn tail of its 50-message chat (users at the odd seqs: #43–#50, eight messages plus the system prompt and the new one); they did not match H2's 16-row tail, so this step is also the first time the file passes against the shipped default.

- [ ] **Step 5: Commit**

```bash
git add src/history/settings.js src/history/context-builder.js src/longhaul/adapters/kl-recall.js tests/history-settings.test.js tests/history-context-builder.test.js tests/longhaul-adapter-kl-recall.test.js tests/history-core.test.js
git commit -m "fix(history): the tail counts user turns, so an agent session never sends an empty tail; short follow-up fallback (off)"
```

---

## Task 3: Schema step 3 (`embeddings`), the vector codec, and the store's embedding methods

**Files:**
- Create: `src/history/embed-errors.js`, `src/history/embedders/vectors.js`, `src/history/embedding-index.js`
- Modify: `src/history/schema.js` (append step 3), `src/history/history-store.js`
- Modify: `tests/helpers/history-fixture.js` (add `downgradeToVersion1`)
- Modify: `tests/history-index.test.js` (`'creates chunks, chunks_fts and calibration at version 2'`), `tests/history-backfill.test.js` (`versionOneStore`), `tests/history-core.test.js` (the H1-store test's `raw.exec`), `tests/history-vault.test.js` (`'the backfill of a version-1 store skips Vault messages too'`), `tests/desktop-source-history.test.js` (its H1-file helper's `db.exec`)
- Test: `tests/history-embeddings-store.test.js`

**Interfaces:**
- Consumes: `prepared(db, sql)` from `chunk-index.js`; H2's store internals.
- Produces:
  - `EmbedError(code, message)` with `.code`; `WORKER_FAILURES` (Set of `EMBED_WORKER_CRASHED`, `EMBED_WORKER_TIMEOUT`).
  - `vectors.js`: `MAX_EMBED_CHARS` (6000), `embedInput(text) → string`, `unit(values) → Float32Array` (a zero vector stays zero; empty or non-finite throws `EMBED_FAILED`), `vecToBlob(vec) → Buffer` (LE float32), `blobToVec(uint8) → Float32Array`.
  - `HistoryStore`: getter `embeddable` (schema ≥ 3); number `vectorEpoch` (bumped by every change that can remove a vector or reuse a chunk id: `createChat` when it replaced an existing chat, `replaceChat`, `updateChat` with `messages`, `deleteChat`, `truncateFrom`, `deleteEmbeddings`); `onAppend(fn(chatId, seq)) → unsubscribe`; `putEmbeddings(key, [{ chunkId, vec: Float32Array | null }]) → written` (`null` = tombstone, dim 0; a chunk that no longer exists is skipped); `pendingEmbeddings(key, { limit = 16, chatId = null, afterId = 0, maxChunksPerToolResult = 0 }) → [{ id, chatId, kind, text }]` (with `chatId`: that chat, newest first; else ids above `afterId`, ascending); `countPending(key, { maxChunksPerToolResult })`; `countEmbedded(key)` (tombstones excluded); `deleteEmbeddings(key) → removed`; `vectorRows(key, chatId, { afterRowid = 0 }) → iterable of { rowid, chunkId, dim, vec, seq, kind }` (tombstones excluded, by rowid).
  - Test helper `downgradeToVersion1(db)`.

- [ ] **Step 1: Write the failing test**

Create `tests/history-embeddings-store.test.js`:

```js
// tests/history-embeddings-store.test.js
// Schema step 3 and the store's embedding methods (recall spec §4.1, §5.2).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { vecToBlob, blobToVec, unit, embedInput, MAX_EMBED_CHARS } = require('../src/history/embedders/vectors');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');

const KEY = 'local:Xenova/bge-small-en-v1.5';
const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const vec = (...xs) => unit(xs);

describe('vectors', () => {
  it('stores little-endian float32 and reads it back', () => {
    const blob = vecToBlob(Float32Array.from([1, -2.5]));
    assert.strictEqual(Buffer.from(blob).toString('hex'), '0000803f000020c0');
    assert.deepStrictEqual(Array.from(blobToVec(new Uint8Array(blob))), [1, -2.5]);
  });

  it('unit() normalises, keeps a zero vector, refuses NaN and empty', () => {
    const v = unit([3, 4]);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
    assert.deepStrictEqual(Array.from(unit([0, 0])), [0, 0]);
    assert.throws(() => unit([NaN, 1]), (err) => err.code === 'EMBED_FAILED');
    assert.throws(() => unit([]), (err) => err.code === 'EMBED_FAILED');
  });

  it('embedInput() cuts at MAX_EMBED_CHARS and never sends an empty string', () => {
    assert.strictEqual(embedInput('x'.repeat(MAX_EMBED_CHARS + 10)).length, MAX_EMBED_CHARS);
    assert.strictEqual(embedInput('   '), ' ');
    assert.strictEqual(embedInput(null), ' ');
  });
});

describe('the embeddings table', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('schema step 3 adds it; an H2 store upgrades with every chunk pending', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'assistant', text: 'Noted, the gate code is saved for the site visit.' }] });
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 3);
    assert.deepStrictEqual(db.prepare("SELECT name FROM pragma_table_info('embeddings') ORDER BY cid").all().map((r) => r.name), ['chunk_id', 'model', 'dim', 'vec']);
    db.close();
    t.store.close();
    const raw = new DatabaseSync(t.dbPath);
    raw.exec('DROP TABLE embeddings; UPDATE schema_version SET version = 2;');
    raw.close();
    t.store = HistoryStore.open(t.dbPath);
    assert.strictEqual(t.store.embeddable, true);
    assert.strictEqual(t.store.countPending(KEY), 2);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });

  it('put, pending and vectorRows round-trip; a tombstone is never pending and never a vector', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: GATE },
      { sender: 'assistant', text: 'The north fence is forty meters.' },
      { sender: 'user', text: 'And the drainage pipe?' }
    ] });
    const pending = t.store.pendingEmbeddings(KEY, { limit: 10 });
    assert.deepStrictEqual(pending.map((r) => r.kind), ['user', 'assistant', 'user']);
    assert.strictEqual(pending[0].text, GATE);
    assert.strictEqual(pending[0].chatId, 'chat-1');
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: pending[0].id, vec: vec(1, 0) }, { chunkId: pending[1].id, vec: null }]), 2);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10 }).map((r) => r.id), [pending[2].id]);
    assert.strictEqual(t.store.countEmbedded(KEY), 1, 'a tombstone is not a vector');
    const rows = [...t.store.vectorRows(KEY, 'chat-1')];
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].chunkId, pending[0].id);
    assert.strictEqual(rows[0].seq, 1);
    assert.strictEqual(rows[0].kind, 'user');
    assert.strictEqual(rows[0].dim, 2);
    assert.deepStrictEqual(Array.from(blobToVec(rows[0].vec)), [1, 0]);
    assert.deepStrictEqual([...t.store.vectorRows(KEY, 'chat-1', { afterRowid: rows[0].rowid })], []);
    assert.strictEqual(t.store.countPending('openai:text-embedding-3-small'), 3, 'another key has rows of its own');
  });

  it('pending: the preferred chat newest first, else by id after the cursor', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: 'first gate note' }, { sender: 'user', text: 'second gate note' }] });
    seedChat(t.store, { id: 'chat-2', messages: [{ sender: 'user', text: 'other chat fence note' }] });
    const all = t.store.pendingEmbeddings(KEY, { limit: 10 });
    assert.deepStrictEqual(all.map((r) => r.chatId), ['chat-1', 'chat-1', 'chat-2']);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, chatId: 'chat-1' }).map((r) => r.id), [all[1].id, all[0].id]);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, afterId: all[0].id }).map((r) => r.id), [all[1].id, all[2].id]);
    assert.strictEqual(t.store.pendingEmbeddings(KEY, { limit: 1 }).length, 1);
  });

  it('maxChunksPerToolResult caps the chunks of one tool result that are embedded', () => {
    t = openTempStore();
    const long = Array.from({ length: 5 }, (_, i) => `Section ${i + 1} of the survey output. ${'drainage reading '.repeat(100)}`).join('\n\n');
    seedChat(t.store, { messages: [{ sender: 'toolResult', toolName: 'Bash', result: long }] });
    assert.strictEqual(t.store.chunksOfChat('chat-1').length, 5);
    assert.strictEqual(t.store.countPending(KEY), 5);
    assert.strictEqual(t.store.countPending(KEY, { maxChunksPerToolResult: 2 }), 2);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, maxChunksPerToolResult: 2 }).map((r) => r.text.slice(0, 9)), ['Section 1', 'Section 2']);
  });

  it('never holds a Vault call or result: they make no chunks, so nothing of them is pending', () => {
    t = openTempStore();
    const SECRET = 'sk-live-lakeside-4417-secret';
    seedChat(t.store, { messages: [
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'store', key: 'gate', value: SECRET } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, value: SECRET } },
      { sender: 'user', text: 'Thanks, the gate key is stored.' }
    ] });
    const pending = t.store.pendingEmbeddings(KEY, { limit: 50 });
    assert.deepStrictEqual(pending.map((r) => r.kind), ['user']);
    assert.ok(pending.every((r) => !r.text.includes(SECRET)));
    assert.strictEqual(t.store.countPending(KEY), 1);
  });

  it('truncate and delete cascade to the vectors and bump vectorEpoch; a vector for a gone chunk is not written', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'user', text: 'The fence is forty meters.' }] });
    const [a, b] = t.store.pendingEmbeddings(KEY, { limit: 10 });
    t.store.putEmbeddings(KEY, [{ chunkId: a.id, vec: vec(1, 0) }, { chunkId: b.id, vec: vec(0, 1) }]);
    const e0 = t.store.vectorEpoch;
    t.store.truncateFrom('chat-1', 2);
    assert.ok(t.store.vectorEpoch > e0);
    assert.strictEqual(t.store.countEmbedded(KEY), 1);
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: b.id, vec: vec(0, 1) }]), 0, 'no row for a chunk that is gone, no FK error');
    const e1 = t.store.vectorEpoch;
    t.store.deleteChat('chat-1');
    assert.ok(t.store.vectorEpoch > e1);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });

  it('deleteEmbeddings removes one key only and bumps vectorEpoch', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings(KEY, { limit: 1 });
    t.store.putEmbeddings(KEY, [{ chunkId: row.id, vec: vec(1, 0) }]);
    t.store.putEmbeddings('ollama:nomic-embed-text', [{ chunkId: row.id, vec: vec(0, 1) }]);
    const e0 = t.store.vectorEpoch;
    assert.strictEqual(t.store.deleteEmbeddings(KEY), 1);
    assert.ok(t.store.vectorEpoch > e0);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
    assert.strictEqual(t.store.countEmbedded('ollama:nomic-embed-text'), 1);
  });

  it('createChat bumps vectorEpoch only when it replaces an existing chat', () => {
    t = openTempStore();
    const e0 = t.store.vectorEpoch;
    t.store.createChat({ id: 'c-new', title: 'New chat', messages: [] });
    assert.strictEqual(t.store.vectorEpoch, e0, 'a new chat removes no vector');
    t.store.createChat({ id: 'c-new', title: 'The same id again', messages: [] });
    assert.ok(t.store.vectorEpoch > e0, 'replacing a chat can remove vectors');
  });

  it('onAppend fires after the append with the chat and seq; a throwing listener does not fail the append', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [] });
    const seen = [];
    const off = t.store.onAppend((chatId, seq) => seen.push([chatId, seq, t.store.chunksOfChat(chatId).length]));
    t.store.onAppend(() => { throw new Error('listener bug'); });
    const out = t.store.appendMessage('chat-1', { id: 'x1', sender: 'user', text: GATE, timestamp: '2026-01-01T09:00:00.000Z' });
    assert.strictEqual(out.seq, 1);
    assert.deepStrictEqual(seen, [['chat-1', 1, 1]]);
    off();
    t.store.appendMessage('chat-1', { id: 'x2', sender: 'user', text: 'again', timestamp: '2026-01-01T09:01:00.000Z' });
    assert.strictEqual(seen.length, 1);
  });

  it('a read-only store writes no vectors', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings(KEY, { limit: 1 });
    t.store.close();
    t.store = HistoryStore.open(t.dbPath, { readonly: true });
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: row.id, vec: vec(1, 0) }]), 0);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-embeddings-store.test.js`
Expected: FAIL with `Cannot find module '../src/history/embedders/vectors'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embed-errors.js`:

```js
// src/history/embed-errors.js
// Errors from embedding and reranking (recall spec §5.2, §15). Callers branch
// on the code:
//   EMBED_WORKER_CRASHED  the worker exited with a request in flight
//   EMBED_WORKER_TIMEOUT  a request ran past its timeout; the worker was killed
//   EMBED_DISABLED        the worker crashed too often; off for this session
//   EMBED_STOPPED         the runner was stopped (shutdown)
//   MODEL_UNAVAILABLE     a model did not load (download, runtime, files)
//   MODEL_NOT_LOADED, MODEL_CHANGED  a request for a model the worker does not hold
//   RERANK_TIMEOUT        rerank slices ran past their deadline
//   RERANK_UNAVAILABLE    no reranker yet: the EmbedderHost has not started
//                         (KL_TEST_MODE, e2e, before the background checks);
//                         the Retriever keeps the fused order without a warning
//   EMBEDDER_UNAVAILABLE  a hosted embedder cannot be built (no embed call)
//   EMBED_FAILED          anything else (a malformed reply, a bad vector)
class EmbedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
  }
}

// Failures of the worker process, not of the embedder: the runner restarts
// the worker, and the indexer isolates the chunk that caused it.
const WORKER_FAILURES = new Set(['EMBED_WORKER_CRASHED', 'EMBED_WORKER_TIMEOUT']);

module.exports = { EmbedError, WORKER_FAILURES };
```

Create `src/history/embedders/vectors.js`:

```js
// src/history/embedders/vectors.js
// Vector plumbing shared by the store, the embedders and the worker protocol.
const os = require('os');
const { EmbedError } = require('../embed-errors');

// The longest text sent to an embedder. text-embedding-3-* take 8,191
// tokens; the local models truncate at 512 tokens themselves. 6,000
// characters stays under the first at one character per token (the same
// limit as LongHaul's embed cache).
const MAX_EMBED_CHARS = 6000;
const LITTLE_ENDIAN = os.endianness() === 'LE';

function embedInput(text) {
  const s = String(text ?? '');
  const cut = s.length > MAX_EMBED_CHARS ? s.slice(0, MAX_EMBED_CHARS) : s;
  return cut.trim() ? cut : ' ';
}

// Unit length, so cosine is a dot product. A zero vector (a text with nothing
// the model reads) stays zero: it is close to nothing.
function unit(values) {
  const v = Float32Array.from(values || []);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (!v.length || !Number.isFinite(sum)) throw new EmbedError('EMBED_FAILED', 'the embedder returned an empty or non-finite vector');
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// Little-endian float32, as the embeddings table stores it (spec §4.1).
function vecToBlob(vec) {
  const out = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) out.writeFloatLE(vec[i], i * 4);
  return out;
}

// node:sqlite hands a BLOB back as a Uint8Array.
function blobToVec(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const n = Math.floor(u8.byteLength / 4);
  if (LITTLE_ENDIAN) return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + n * 4));
  const view = new DataView(u8.buffer, u8.byteOffset, n * 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

module.exports = { MAX_EMBED_CHARS, embedInput, unit, vecToBlob, blobToVec };
```

Create `src/history/embedding-index.js`:

```js
// src/history/embedding-index.js
// The embeddings table (recall spec §4.1, §5.2) as plain functions over the
// store's DatabaseSync, like chunk-index.js. A row is one chunk's vector for
// one embedder key ("local:Xenova/bge-small-en-v1.5"): unit length,
// little-endian float32. dim 0 with an empty vec is a tombstone: a chunk
// that crashed the embed worker on its own, never tried again for that key.
const { prepared } = require('./chunk-index');
const { vecToBlob } = require('./embedders/vectors');

const SCHEMA_V3_SQL = `
CREATE TABLE embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX idx_embeddings_model ON embeddings(model);
`;

const MISSING = 'NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model = ?)';
// maxChunksPerToolResult: only the first n chunks of a tool result.
const CAPPED = "(? = 0 OR c.kind <> 'tool_result' OR c.idx < ?)";
const capOf = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// Only for chunks that still exist: a truncate between the read and the
// write leaves nothing to write, and no foreign-key error.
function putEmbeddings(db, model, rows) {
  const stmt = prepared(db, `INSERT OR REPLACE INTO embeddings (chunk_id, model, dim, vec)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)`);
  let written = 0;
  for (const { chunkId, vec } of rows) {
    if (!Number.isInteger(chunkId)) continue;
    const blob = vec ? vecToBlob(vec) : Buffer.alloc(0);
    written += Number(stmt.run(chunkId, String(model), vec ? vec.length : 0, blob, chunkId).changes);
  }
  return written;
}

function pendingEmbeddings(db, model, { limit = 16, chatId = null, afterId = 0, maxChunksPerToolResult = 0 } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 16;
  const cap = capOf(maxChunksPerToolResult);
  const cols = 'c.id AS id, c.chat_id AS chatId, c.kind AS kind, c.text AS text';
  if (chatId !== null && chatId !== undefined) {
    return prepared(db, `SELECT ${cols} FROM chunks c WHERE c.chat_id = ? AND ${MISSING} AND ${CAPPED} ORDER BY c.id DESC LIMIT ?`)
      .all(String(chatId), String(model), cap, cap, max);
  }
  const after = Number.isInteger(afterId) && afterId > 0 ? afterId : 0;
  return prepared(db, `SELECT ${cols} FROM chunks c WHERE c.id > ? AND ${MISSING} AND ${CAPPED} ORDER BY c.id LIMIT ?`)
    .all(after, String(model), cap, cap, max);
}

function countPending(db, model, { maxChunksPerToolResult = 0 } = {}) {
  const cap = capOf(maxChunksPerToolResult);
  return Number(prepared(db, `SELECT count(*) AS n FROM chunks c WHERE ${MISSING} AND ${CAPPED}`).get(String(model), cap, cap).n);
}

function countEmbedded(db, model) {
  return Number(prepared(db, 'SELECT count(*) AS n FROM embeddings WHERE model = ? AND dim > 0').get(String(model)).n);
}

function deleteEmbeddings(db, model) {
  return Number(prepared(db, 'DELETE FROM embeddings WHERE model = ?').run(String(model)).changes);
}

// A chat's vectors for one key written after afterRowid, oldest first, with
// the chunk's seq and kind (the VectorIndex filters on both).
function vectorRows(db, model, chatId, { afterRowid = 0 } = {}) {
  return prepared(db, `SELECT e.rowid AS rowid, e.chunk_id AS chunkId, e.dim AS dim, e.vec AS vec, m.seq AS seq, c.kind AS kind
    FROM chunks c
    JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
    JOIN messages m ON m.id = c.message_id
    WHERE c.chat_id = ? AND e.dim > 0 AND e.rowid > ?
    ORDER BY e.rowid`).iterate(String(model), String(chatId), Number(afterRowid) || 0);
}

module.exports = { SCHEMA_V3_SQL, putEmbeddings, pendingEmbeddings, countPending, countEmbedded, deleteEmbeddings, vectorRows };
```

In `src/history/schema.js`, add `const { SCHEMA_V3_SQL } = require('./embedding-index');` below the chunk-index require, update the header comment's list ("chunks, FTS, embeddings, …"), and append to `SCHEMA_STEPS`:

```js
  // Recall stage H3: one vector per chunk per embedder key (spec §4.1). An
  // upgraded store has every chunk pending; the EmbedIndexer fills it.
  {
    version: 3,
    up(db) {
      db.exec(SCHEMA_V3_SQL);
    }
  }
```

In `src/history/history-store.js`:

- Below `const chunkIndex = require('./chunk-index');` add `const embeddingIndex = require('./embedding-index');`, and below `const INDEX_SCHEMA_VERSION = 2;` add:

```js
// The schema step that adds the embeddings table.
const EMBEDDINGS_SCHEMA_VERSION = 3;
```

- In the constructor, after `this._statements = new Map();` add:

```js
    // Bumped by every change that can drop a vector or let a later chunk
    // reuse a chunk id (truncate, rewrite, delete, rebuild): the VectorIndex
    // drops its cached matrices when it moves.
    this.vectorEpoch = 0;
    this._appendListeners = new Set();
```

- After the `get indexed()` getter add:

```js
  // False for a read-only store opened below schema 3.
  get embeddable() {
    return this.schemaVersion >= EMBEDDINGS_SCHEMA_VERSION;
  }

  // fn(chatId, seq) after each appendMessage has committed its message and
  // chunks (the EmbedIndexer embeds the newest chat first). A listener that
  // throws is logged; the append stands.
  onAppend(fn) {
    this._appendListeners.add(fn);
    return () => this._appendListeners.delete(fn);
  }

  _emitAppend(chatId, seq) {
    for (const fn of this._appendListeners) {
      try {
        fn(chatId, seq);
      } catch (err) {
        log.warn(`A history append listener failed: ${err.message}`);
      }
    }
  }

  _bumpVectorEpoch() {
    this.vectorEpoch += 1;
  }
```

- In `createChat`, inside the transaction, replace `this._stmt('DELETE FROM chats WHERE id = ?').run(id);` with the lines below. A new chat removes nothing, so it must not bump the epoch: every bump makes the `VectorIndex` drop all its matrices and the indexer recount, and a chat is created far more often than one is replaced.

```js
      // Only a chat that replaced an existing one can drop vectors.
      if (Number(this._stmt('DELETE FROM chats WHERE id = ?').run(id).changes) > 0) this._bumpVectorEpoch();
```
- In `replaceChat`, after `this._stmt('DELETE FROM messages WHERE chat_id = ?').run(key);` add `this._bumpVectorEpoch();`.
- In `updateChat`, inside `if (Array.isArray(nextMessages)) {`, after the `DELETE FROM messages` line add `this._bumpVectorEpoch();`.
- Replace `deleteChat` with:

```js
  deleteChat(id) {
    const key = normalizeId(id);
    if (!key) return false;
    const removed = Number(this._stmt('DELETE FROM chats WHERE id = ?').run(key).changes) > 0;
    if (removed) this._bumpVectorEpoch();
    return removed;
  }
```

- Replace `appendMessage` with:

```js
  appendMessage(chatId, message, { updatedAt, patch } = {}) {
    const id = normalizeId(chatId);
    if (!id) return null;
    const out = this.transaction((db) => {
      const row = this._chatRow(id);
      if (!row) return null;
      const inserted = this._insertMessage(db, id, message, { fallbackTimestamp: updatedAt });
      const { messages: _ignored, ...fields } = patch || {};
      this._updateChatRow(id, { ...rows.rowToChat(row), updatedAt: updatedAt || inserted.stored.timestamp, ...fields });
      return { message: inserted.stored, seq: inserted.seq };
    });
    if (out) this._emitAppend(id, out.seq);
    return out;
  }
```

- In `truncateFrom`, replace the `return this.transaction(…)` line with:

```js
    const removed = this.transaction(() => Number(this._stmt('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(id, from).changes));
    if (removed) this._bumpVectorEpoch();
    return removed;
```

- After `setCalibration`, add:

```js
  // Recall stage H3 (spec §4.1, §5.2, §5.3). A store below schema 3 has no
  // embeddings table: reads find nothing and writes do nothing; a read-only
  // store never writes.
  putEmbeddings(model, rows) {
    if (!this.embeddable || this.readonly || !Array.isArray(rows) || !rows.length) return 0;
    return this.transaction((db) => embeddingIndex.putEmbeddings(db, model, rows));
  }
  pendingEmbeddings(model, options = {}) { return this.embeddable ? embeddingIndex.pendingEmbeddings(this.db, model, options) : []; }
  countPending(model, options = {}) { return this.embeddable ? embeddingIndex.countPending(this.db, model, options) : 0; }
  countEmbedded(model) { return this.embeddable ? embeddingIndex.countEmbedded(this.db, model) : 0; }
  vectorRows(model, chatId, options = {}) { return this.embeddable ? embeddingIndex.vectorRows(this.db, model, chatId, options) : []; }
  deleteEmbeddings(model) {
    if (!this.embeddable || this.readonly) return 0;
    const removed = embeddingIndex.deleteEmbeddings(this.db, model);
    this._bumpVectorEpoch();
    return removed;
  }
```

In `tests/helpers/history-fixture.js`, add and export:

```js
// What an H1 profile looks like: the index tables dropped, schema_version 1.
// Takes a raw DatabaseSync on the store's file (the store closed).
function downgradeToVersion1(db) {
  db.exec(`DROP TABLE IF EXISTS embeddings;
    DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
    DROP TABLE chunks_fts; DROP TABLE chunks; DROP TABLE calibration;
    UPDATE schema_version SET version = 1;`);
}
```

(`module.exports = { BASE_TIME, isoAt, openTempStore, seedChat, readDb, downgradeToVersion1 };`)

Update the tests that turn a store back into an H1 file (the H2 `DROP …` block no longer resets the version, and the `embeddings` table would survive):

- `tests/history-backfill.test.js`, `versionOneStore`: replace the `db.exec(\`…\`)` block that starts `DROP TRIGGER chunks_ai;` and ends `UPDATE schema_version SET version = 1 WHERE version = 2;` (lines 24–28; line 23 is `new DatabaseSync`, keep it) with `downgradeToVersion1(db);` and add `downgradeToVersion1` to the fixture require. The `DELETE FROM meta WHERE key = 'chunks_backfill'` line after it stays.
- `tests/history-core.test.js`, in the test that seeds an H1 store (`seed.createChat({ id: 'c1', title: 'From H1', … })`): replace the `raw.exec(\`DROP TRIGGER … UPDATE schema_version SET version = 1;\`);` call (lines 156–158) with `downgradeToVersion1(raw);` and require it from `./helpers/history-fixture`.
- `tests/history-vault.test.js`, in `'the backfill of a version-1 store skips Vault messages too'`: replace the `raw.exec(\`DROP TRIGGER … UPDATE schema_version SET version = 1;\`);` call (lines 71–73) with `downgradeToVersion1(raw);`, with the same require.
- `tests/desktop-source-history.test.js`, in the helper that turns a store into an H1 file: replace the `db.exec(\`DROP TRIGGER … UPDATE schema_version SET version = 1;\`);` call (lines 158–161) with `downgradeToVersion1(db); db.exec("DELETE FROM meta WHERE key = 'chunks_backfill'");` (that block also clears the backfill marker, which `downgradeToVersion1` does not), with the same require.
- `tests/history-index.test.js`, `'creates chunks, chunks_fts and calibration at version 2'` (line 17): title `'creates chunks, chunks_fts and calibration (schema 2) and is at version 3'`; its `assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 2);` (line 22) ends `…get().v, 3);`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embeddings-store.test.js tests/history-index.test.js tests/history-backfill.test.js tests/history-core.test.js tests/history-vault.test.js tests/desktop-source-history.test.js tests/history-schema.test.js tests/history-store-chats.test.js tests/history-store-messages.test.js tests/history-migrate-json.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/embed-errors.js src/history/embedders/vectors.js src/history/embedding-index.js src/history/schema.js src/history/history-store.js tests/helpers/history-fixture.js tests/history-embeddings-store.test.js tests/history-index.test.js tests/history-backfill.test.js tests/history-core.test.js tests/history-vault.test.js tests/desktop-source-history.test.js
git commit -m "feat(history): schema step 3, the embeddings table, and the store's embedding methods"
```

---

## Task 4: Embedder profiles and the hosted embedders (OpenAI, Ollama)

**Files:**
- Create: `src/history/embedders/profiles.js`, `src/history/embedders/remote.js`
- Modify: `src/providers/ollama-provider.js` (add `embed`)
- Test: `tests/history-embedders-remote.test.js`

**Interfaces:**
- Consumes: `embedInput`, `unit` (Task 3); `EmbedError`.
- Produces:
  - `profileFor(model) → { pooling: 'cls' | 'mean', queryPrefix, docPrefix }`; `prefixTexts(model, texts, kind = 'document') → string[]`.
  - The **Embedder** shape every kind implements: `{ name, kind, model, dim (null until the first vector), tokens (running input-token count, 0 when unknown), embed(texts, { kind: 'query' | 'document' }) → Promise<Float32Array[]> }`, vectors unit length, one per text, in order.
  - `createRemoteEmbedder({ kind: 'openai' | 'ollama', model, provider }) → Embedder` (`name` is `openai:<model>` / `ollama:<model>`); throws `EMBEDDER_UNAVAILABLE` for a provider without `embed`.
  - `OllamaProvider#embed(inputs, { model, abortSignal }) → { vectors, usage: { input }, model }` through `this.request` (`POST <server>/api/embed`).

The OpenAI kind uses `OpenAIProvider#embed`, not the spec's `OpenAIEmbeddingProvider` (`src/memory/embedding-provider.js`), which calls `fetch` directly and so breaks "every provider request through `BaseProvider.request`".

- [ ] **Step 1: Write the failing test**

Create `tests/history-embedders-remote.test.js`:

```js
// tests/history-embedders-remote.test.js
// Per-model prefixes, and the OpenAI and Ollama embedders through their
// providers (recall spec §5.2). Loopback servers only; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { profileFor, prefixTexts } = require('../src/history/embedders/profiles');
const { createRemoteEmbedder } = require('../src/history/embedders/remote');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeEmbeddingServer } = require('./helpers/fake-embedding-server');

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

function ollamaServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(body)));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r))
  })));
}

describe('embedder profiles', () => {
  it('bge queries get the instruction and documents nothing; nomic gets both prefixes; others none', () => {
    assert.deepStrictEqual(prefixTexts('Xenova/bge-small-en-v1.5', ['gate code'], 'query'), ['Represent this sentence for searching relevant passages: gate code']);
    assert.deepStrictEqual(prefixTexts('Xenova/bge-small-en-v1.5', ['gate code'], 'document'), ['gate code']);
    assert.deepStrictEqual(prefixTexts('nomic-embed-text:latest', ['x'], 'query'), ['search_query: x']);
    assert.deepStrictEqual(prefixTexts('nomic-embed-text', ['x'], 'document'), ['search_document: x']);
    assert.deepStrictEqual(prefixTexts('text-embedding-3-small', ['x'], 'query'), ['x']);
    assert.deepStrictEqual(prefixTexts('Xenova/all-MiniLM-L6-v2', ['x']), ['x']);
    assert.strictEqual(profileFor('Xenova/bge-small-en-v1.5').pooling, 'cls');
    assert.strictEqual(profileFor('Xenova/all-MiniLM-L6-v2').pooling, 'mean');
    assert.strictEqual(profileFor('someone/unknown-model').pooling, 'mean');
  });
});

describe('OpenAI embedder', () => {
  let server;
  before(async () => { server = await startFakeEmbeddingServer(); });
  after(() => server.close());

  it('embeds through OpenAIProvider#embed: unit vectors, the key name, tokens counted', async () => {
    const provider = ProviderFactory.createProvider('openai', 'test-key-123456', { baseUrl: `${server.url}/v1` });
    const e = createRemoteEmbedder({ kind: 'openai', model: 'text-embedding-3-small', provider });
    assert.strictEqual(e.name, 'openai:text-embedding-3-small');
    assert.strictEqual(e.dim, null);
    const vecs = await e.embed(['the side gate code', 'the north fence'], { kind: 'document' });
    assert.strictEqual(vecs.length, 2);
    assert.ok(vecs[0] instanceof Float32Array);
    assert.ok(Math.abs(norm(vecs[0]) - 1) < 1e-5);
    assert.strictEqual(e.dim, 64);
    assert.ok(e.tokens > 0);
    assert.strictEqual(server.requests.at(-1).model, 'text-embedding-3-small');
    assert.deepStrictEqual(await e.embed([]), []);
  });

  it('a provider without an embeddings call is refused', () => {
    assert.throws(() => createRemoteEmbedder({ kind: 'openai', model: 'm', provider: {} }), (err) => err.code === 'EMBEDDER_UNAVAILABLE');
  });
});

describe('Ollama embedder', () => {
  it('POSTs /api/embed on the server address, through the provider, with the nomic prefix', async () => {
    const s = await ollamaServer((body) => ({ model: body.model, embeddings: body.input.map((_, i) => [i + 1, 1, 0]), prompt_eval_count: 7 }));
    try {
      const provider = ProviderFactory.createProvider('ollama', null, { serverUrl: s.url });
      const e = createRemoteEmbedder({ kind: 'ollama', model: 'nomic-embed-text', provider });
      const vecs = await e.embed(['gate'], { kind: 'query' });
      assert.strictEqual(s.seen[0].url, '/api/embed');
      assert.deepStrictEqual(s.seen[0].body, { model: 'nomic-embed-text', input: ['search_query: gate'] });
      assert.ok(Math.abs(vecs[0][0] - Math.SQRT1_2) < 1e-6);
      assert.strictEqual(e.tokens, 7);
      assert.strictEqual(e.name, 'ollama:nomic-embed-text');
    } finally {
      await s.close();
    }
  });

  it('a reply with the wrong number of vectors fails with EMBED_FAILED', async () => {
    const s = await ollamaServer(() => ({ embeddings: [] }));
    try {
      const provider = ProviderFactory.createProvider('ollama', null, { serverUrl: s.url });
      const e = createRemoteEmbedder({ kind: 'ollama', model: 'nomic-embed-text', provider });
      await assert.rejects(e.embed(['gate']), (err) => err.code === 'EMBED_FAILED' || /vectors/.test(err.message));
    } finally {
      await s.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-embedders-remote.test.js`
Expected: FAIL with `Cannot find module '../src/history/embedders/profiles'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embedders/profiles.js`:

```js
// src/history/embedders/profiles.js
// Per-model text handling (recall spec §5.2): the query and document
// prefixes a model was trained with, and its pooling (read by the local
// backend). Matched by a substring of the model id, so the Hugging Face id
// "Xenova/bge-small-en-v1.5" and Ollama's "nomic-embed-text:latest" both
// match. Unknown models: mean pooling, no prefixes.
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';
const PROFILES = Object.freeze([
  { match: 'bge-small-en', pooling: 'cls', queryPrefix: BGE_QUERY, docPrefix: '' },
  { match: 'bge-base-en', pooling: 'cls', queryPrefix: BGE_QUERY, docPrefix: '' },
  { match: 'nomic-embed-text', pooling: 'mean', queryPrefix: 'search_query: ', docPrefix: 'search_document: ' },
  { match: 'minilm', pooling: 'mean', queryPrefix: '', docPrefix: '' }
]);

function profileFor(model) {
  const id = String(model || '').toLowerCase();
  const hit = PROFILES.find((p) => id.includes(p.match));
  return hit
    ? { pooling: hit.pooling, queryPrefix: hit.queryPrefix, docPrefix: hit.docPrefix }
    : { pooling: 'mean', queryPrefix: '', docPrefix: '' };
}

function prefixTexts(model, texts, kind = 'document') {
  const p = profileFor(model);
  const prefix = kind === 'query' ? p.queryPrefix : p.docPrefix;
  return texts.map((t) => `${prefix}${t}`);
}

module.exports = { profileFor, prefixTexts };
```

Create `src/history/embedders/remote.js`:

```js
// src/history/embedders/remote.js
// The hosted embedders (recall spec §5.2): OpenAI through OpenAIProvider#embed
// and Ollama through OllamaProvider#embed, so every request goes through
// BaseProvider.request. Texts are cut to MAX_EMBED_CHARS and prefixed for the
// model; vectors come back unit length. The OpenAI kind sends chat text to
// OpenAI; the settings pane says so.
const { EmbedError } = require('../embed-errors');
const { embedInput, unit } = require('./vectors');
const { prefixTexts } = require('./profiles');

// Inputs per provider request; the providers' own limits are far higher.
const REMOTE_BATCH = 100;

function createRemoteEmbedder({ kind, model, provider }) {
  if (kind !== 'openai' && kind !== 'ollama') throw new TypeError(`not a hosted embedder kind: ${kind}`);
  if (!provider || typeof provider.embed !== 'function') {
    throw new EmbedError('EMBEDDER_UNAVAILABLE', `the ${kind} provider has no embeddings call`);
  }
  const embedder = {
    name: `${kind}:${model}`,
    kind,
    model,
    dim: null,
    tokens: 0,
    async embed(texts, { kind: textKind = 'document', abortSignal } = {}) {
      if (!Array.isArray(texts) || !texts.length) return [];
      const inputs = prefixTexts(model, texts.map(embedInput), textKind);
      const out = [];
      for (let i = 0; i < inputs.length; i += REMOTE_BATCH) {
        const slice = inputs.slice(i, i + REMOTE_BATCH);
        const res = await provider.embed(slice, { model, abortSignal });
        if (!res || !Array.isArray(res.vectors) || res.vectors.length !== slice.length) {
          throw new EmbedError('EMBED_FAILED', `the ${kind} embedder returned ${res && Array.isArray(res.vectors) ? res.vectors.length : 'no'} vectors for ${slice.length} texts`);
        }
        if (Number.isFinite(res.usage?.input)) embedder.tokens += res.usage.input;
        for (const v of res.vectors) out.push(unit(v));
      }
      if (embedder.dim === null) embedder.dim = out[0].length;
      if (out.some((v) => v.length !== embedder.dim)) throw new EmbedError('EMBED_FAILED', `the ${kind} embedder changed its vector size`);
      return out;
    }
  };
  return embedder;
}

module.exports = { createRemoteEmbedder, REMOTE_BATCH };
```

In `src/providers/ollama-provider.js`, add this method to `OllamaProvider` (next to `listModels`):

```js
  /**
   * Embeddings (recall spec §5.2): POST /api/embed on the Ollama server, one
   * vector per input, in input order. Returns { vectors, usage: { input },
   * model } like OpenAIProvider#embed. A non-2xx reply throws the provider
   * error.
   */
  async embed(inputs, { model, abortSignal } = {}) {
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('embed needs at least one input');
    if (!model) throw new Error('embed needs a model');
    const server = this.baseUrl.replace(/\/v1$/, '');
    const response = await this.request(`${server}/api/embed`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ model, input: inputs.map(String) })
    }, { abortSignal, model });
    if (!response.ok) throw await this.buildError(response, { model });
    const data = await response.json();
    const vectors = Array.isArray(data?.embeddings) ? data.embeddings : [];
    if (vectors.length !== inputs.length || vectors.some((v) => !Array.isArray(v))) {
      throw new Error(`embeddings reply has ${vectors.length} vectors for ${inputs.length} inputs`);
    }
    const input = Number(data?.prompt_eval_count);
    return { vectors, usage: { input: Number.isFinite(input) ? input : null }, model: data?.model || model };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embedders-remote.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/embedders/profiles.js src/history/embedders/remote.js src/providers/ollama-provider.js tests/history-embedders-remote.test.js
git commit -m "feat(history): embedder profiles and the OpenAI and Ollama embedders through their providers"
```

---

## Task 5: The embed worker and the local backend

**Files:**
- Create: `src/history/embed-protocol.js`, `src/history/embed-worker.js`, `src/history/embedders/local-backend.js`
- Create: `tests/helpers/fake-embed-backend.js`
- Test: `tests/history-embed-worker.test.js`, `tests/history-local-backend.test.js`

**Interfaces:**
- Consumes: `vecToBlob`, `blobToVec` (Task 3); `profileFor` (Task 4); `LOCAL_MODEL_RE` (Task 1).
- Produces:
  - `embed-protocol.js`: `encodeMessage(obj) → string` (one JSON line), `LineReader({ onMessage, onError, maxLineChars })` with `push(chunk)`, `vecToBase64(vec)`, `base64ToVec(str)`.
  - Wire protocol (requests on stdin, replies on fd 3): `{ id, op: 'load', role: 'embedder' | 'reranker', model, modelsDir, allowDownload }` → progress events `{ event: 'progress', id, file, loaded, total }` then `{ id, ok: true, dim }`; `{ id, op: 'embed', model, texts }` → `{ id, ok: true, vectors: [base64] }`; `{ id, op: 'rerank', model, query, texts }` → `{ id, ok: true, scores }`; failures `{ id, ok: false, code, message }` with `code` in `MODEL_UNAVAILABLE | MODEL_NOT_LOADED | MODEL_CHANGED | BAD_REQUEST | EMBED_FAILED`.
  - `runWorker({ input, write, backend, exit }) → { reader }`; the worker process loads the backend module named by `KL_EMBED_WORKER_BACKEND` (tests) or `./embedders/local-backend`, and calls its `createBackend()`.
  - Backend contract: `loadEmbedder({ model, modelsDir, allowDownload, onProgress }) → { dim, embed(texts) → Float32Array[] }` (unit length) and `loadReranker(same) → { score(query, texts) → number[] }`; a load that fails throws with `code: 'MODEL_UNAVAILABLE'`.
  - `local-backend.js`: `createLocalBackend({ load, threads })`, `createBackend()`, `modelDir(modelsDir, model)`, `COMPLETE_MARKER` (`.kl-complete.json`), `EMBED_DTYPE` (`q8`), `RERANK_DTYPE` (`fp32`), `WORKER_THREADS` (2).
  - `tests/helpers/fake-embed-backend.js`: `createBackend({ inProcess = false })`, bag-of-words; texts steer it (`__crash__`, `__hang__`, `__slow__`), model `fake/missing` fails to load.

Why these choices: int8 (`q8`) for the embedder is what Appendix A.3 measured (bge-small 102 ms per ~400-token chunk); fp32 for the cross-encoder is what the rerank probe measured (18–28 ms per pair, against 61 ms for int8 in A.3). Two ONNX threads keep a background backfill from taking every core of a desktop; LongHaul (Task 16) measures the throughput this gives.

- [ ] **Step 1: Write the failing tests**

Create `tests/helpers/fake-embed-backend.js`:

```js
// tests/helpers/fake-embed-backend.js
// A stand-in for src/history/embedders/local-backend.js (tests only). The
// embed worker loads it when KL_EMBED_WORKER_BACKEND names this file, which
// EmbedRunner sets only for an explicit testBackend. Vectors are the
// bag-of-words of fake-embedder.js (28 dims). Texts steer it:
//   "__crash__"  the worker process exits (a native crash); in-process, the
//                call throws EMBED_WORKER_CRASHED instead
//   "__hang__"   never answers
//   "__slow__"   answers after 150 ms
// Model "fake/missing" fails to load like a download with no network. Every
// load reports two progress events.
const { createBagOfWordsEmbedder, DEFAULT_VOCAB } = require('./fake-embedder');

function createBackend({ inProcess = false } = {}) {
  const bow = createBagOfWordsEmbedder();
  const steer = async (texts) => {
    if (texts.some((t) => String(t).includes('__crash__'))) {
      if (!inProcess) process.exit(70);
      throw Object.assign(new Error('the embed worker exited (code 70)'), { code: 'EMBED_WORKER_CRASHED' });
    }
    if (texts.some((t) => String(t).includes('__hang__'))) await new Promise(() => {});
    if (texts.some((t) => String(t).includes('__slow__'))) await new Promise((r) => setTimeout(r, 150));
  };
  const load = async ({ model, onProgress = () => {} }) => {
    if (model === 'fake/missing') throw Object.assign(new Error('fake/missing could not be loaded: fetch failed (offline)'), { code: 'MODEL_UNAVAILABLE' });
    onProgress({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 50, total: 100 });
    onProgress({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 100, total: 100 });
  };
  return {
    async loadEmbedder(opts) {
      await load(opts);
      return {
        dim: DEFAULT_VOCAB.length,
        async embed(texts) {
          await steer(texts);
          return (await bow.embed(texts)).map((v) => Float32Array.from(v));
        }
      };
    },
    async loadReranker(opts) {
      await load(opts);
      return {
        dim: null,
        async score(query, texts) {
          await steer(texts);
          const [q, ...docs] = await bow.embed([query, ...texts]);
          return docs.map((d) => d.reduce((s, x, i) => s + x * q[i], 0));
        }
      };
    }
  };
}

module.exports = { createBackend };
```

Create `tests/history-embed-worker.test.js`:

```js
// tests/history-embed-worker.test.js
// The embed worker's protocol (recall spec §5.2), in process: runWorker over
// a PassThrough stdin with the fake backend. The spawned process is Task 6's.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { runWorker } = require('../src/history/embed-worker');
const { encodeMessage, LineReader, base64ToVec, vecToBase64 } = require('../src/history/embed-protocol');
const { createBackend } = require('./helpers/fake-embed-backend');

const MODELS = require('path').join(require('os').tmpdir(), 'kl-embed-models-unused');

function harness() {
  const input = new PassThrough();
  const messages = [];
  const exits = [];
  let wake = () => {};
  const reader = new LineReader({ onMessage: (m) => { messages.push(m); wake(); }, onError: (err) => { throw err; } });
  runWorker({ input, write: (s) => reader.push(Buffer.from(s, 'utf8')), backend: createBackend({ inProcess: true }), exit: (code) => exits.push(code) });
  const send = (msg) => input.write(encodeMessage(msg));
  const reply = async (id) => {
    for (;;) {
      const r = messages.find((m) => m.id === id && m.event === undefined);
      if (r) return r;
      await new Promise((resolve) => { wake = resolve; });
    }
  };
  return { input, send, reply, messages, exits };
}

describe('embed protocol', () => {
  it('reads lines split anywhere, even inside a multi-byte character', () => {
    const got = [];
    const r = new LineReader({ onMessage: (m) => got.push(m), onError: (e) => { throw e; } });
    const bytes = Buffer.from(encodeMessage({ text: 'Lakeside lot · 4417' }) + encodeMessage({ n: 2 }), 'utf8');
    for (let i = 0; i < bytes.length; i += 3) r.push(bytes.subarray(i, i + 3));
    assert.deepStrictEqual(got, [{ text: 'Lakeside lot · 4417' }, { n: 2 }]);
  });

  it('fails on a line that is not a JSON object, or one over the size limit', () => {
    const errors = [];
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message) }).push(Buffer.from('not json\n'));
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message) }).push(Buffer.from('[1]\n'));
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message), maxLineChars: 10 }).push(Buffer.from('{"a":"0123456789"'));
    assert.strictEqual(errors.length, 3);
  });

  it('round-trips a vector through base64', () => {
    assert.deepStrictEqual(Array.from(base64ToVec(vecToBase64(Float32Array.from([0.5, -2])))), [0.5, -2]);
  });
});

describe('runWorker', () => {
  it('load reports progress, then the dimension', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS, allowDownload: true });
    const r = await h.reply(1);
    assert.deepStrictEqual(r, { id: 1, ok: true, dim: 28 });
    assert.deepStrictEqual(h.messages.filter((m) => m.event === 'progress').map((m) => [m.id, m.loaded, m.total]), [[1, 50, 100], [1, 100, 100]]);
  });

  it('embed returns one unit vector per text, as base64 float32', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    h.send({ id: 2, op: 'embed', model: 'fake/one', texts: ['the linen bandage', 'the canopic jar'] });
    const r = await h.reply(2);
    assert.strictEqual(r.ok, true);
    const vecs = r.vectors.map(base64ToVec);
    assert.strictEqual(vecs.length, 2);
    assert.strictEqual(vecs[0].length, 28);
    assert.ok(Math.abs(vecs[0].reduce((s, x) => s + x * x, 0) - 1) < 1e-5);
  });

  it('refuses embed before a load, and for a model it does not hold', async () => {
    const h = harness();
    h.send({ id: 1, op: 'embed', model: 'fake/one', texts: ['gate'] });
    assert.strictEqual((await h.reply(1)).code, 'MODEL_NOT_LOADED');
    h.send({ id: 2, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    await h.reply(2);
    h.send({ id: 3, op: 'embed', model: 'fake/two', texts: ['gate'] });
    assert.strictEqual((await h.reply(3)).code, 'MODEL_CHANGED');
  });

  it('rerank scores each text against the query', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'reranker', model: 'fake/rr', modelsDir: MODELS });
    await h.reply(1);
    h.send({ id: 2, op: 'rerank', model: 'fake/rr', query: 'linen bandage', texts: ['the tomb', 'a linen bandage', 'linen'] });
    const { scores } = await h.reply(2);
    assert.strictEqual(scores.length, 3);
    assert.ok(scores[1] > scores[0] && scores[1] >= scores[2]);
  });

  it('a model that fails to load answers MODEL_UNAVAILABLE and the worker stays up', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/missing', modelsDir: MODELS });
    const r = await h.reply(1);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'MODEL_UNAVAILABLE');
    assert.match(r.message, /offline/);
    h.send({ id: 2, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    assert.strictEqual((await h.reply(2)).ok, true);
  });

  it('refuses a malformed request with BAD_REQUEST', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    await h.reply(1);
    h.send({ id: 2, op: 'embed', model: 'fake/one', texts: 'not a list' });
    assert.strictEqual((await h.reply(2)).code, 'BAD_REQUEST');
    h.send({ id: 3, op: 'dance' });
    assert.strictEqual((await h.reply(3)).code, 'BAD_REQUEST');
  });

  it('a line that is not JSON ends the worker; so does the end of stdin', async () => {
    const h = harness();
    h.input.write('garbage\n');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.exits, [1]);
    const g = harness();
    g.input.end();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(g.exits, [0]);
  });
});
```

Create `tests/history-local-backend.test.js`:

```js
// tests/history-local-backend.test.js
// The local backend with a fake transformers.js: model folder, download
// marker, offline loads, dtypes, pooling, threads (recall spec §5.2, §15).
// No model is downloaded and no native runtime is loaded.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalBackend, modelDir, COMPLETE_MARKER } = require('../src/history/embedders/local-backend');

const MODEL = 'Xenova/bge-small-en-v1.5';
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tempModels = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-models-')); dirs.push(d); return d; };

function fakeTransformers({ failWith = null } = {}) {
  const calls = [];
  const env = {};
  return {
    env,
    calls,
    async pipeline(task, model, opts) {
      calls.push({ task, model, dtype: opts.dtype, threads: opts.session_options.intraOpNumThreads, remote: env.allowRemoteModels, cacheDir: env.cacheDir });
      if (failWith) throw failWith;
      opts.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 1, total: 2 });
      opts.progress_callback({ status: 'done', file: 'onnx/model_quantized.onnx' });
      return async (texts, o) => {
        calls.push({ run: texts.length, pooling: o.pooling, normalize: o.normalize });
        const d = 3;
        return { dims: [texts.length, d], data: Float32Array.from({ length: texts.length * d }, (_, i) => (i % d === 0 ? 1 : 0)) };
      };
    },
    AutoTokenizer: { from_pretrained: async () => (queries, { text_pair }) => ({ n: text_pair.length }) },
    AutoModelForSequenceClassification: {
      from_pretrained: async (model, opts) => {
        calls.push({ rerank: model, dtype: opts.dtype, remote: env.allowRemoteModels });
        return async (inputs) => ({ logits: { data: Float32Array.from({ length: inputs.n }, (_, i) => i * 0.5) } });
      }
    }
  };
}

describe('local backend', () => {
  it('first load downloads (remote on), q8 on 2 threads with the model\'s pooling, then writes the marker; the next load is offline', async () => {
    const models = tempModels();
    const T = fakeTransformers();
    const backend = createLocalBackend({ load: () => T });
    const progress = [];
    const e = await backend.loadEmbedder({ model: MODEL, modelsDir: models, allowDownload: true, onProgress: (p) => progress.push(p.loaded) });
    assert.deepStrictEqual(T.calls[0], { task: 'feature-extraction', model: MODEL, dtype: 'q8', threads: 2, remote: true, cacheDir: models });
    assert.deepStrictEqual(progress, [1], 'only progress events are passed on');
    assert.ok(fs.existsSync(path.join(models, 'Xenova', 'bge-small-en-v1.5', COMPLETE_MARKER)));
    const vecs = await e.embed(['gate', 'fence']);
    assert.strictEqual(vecs.length, 2);
    assert.deepStrictEqual(Array.from(vecs[1]), [1, 0, 0]);
    assert.strictEqual(e.dim, 3);
    assert.deepStrictEqual(T.calls[1], { run: 2, pooling: 'cls', normalize: true });
    await backend.loadEmbedder({ model: MODEL, modelsDir: models, allowDownload: true });
    assert.strictEqual(T.calls[2].remote, false, 'a complete model loads with remote access off');
  });

  it('a model folder without the marker is a stopped download: it is deleted before the next try', async () => {
    const models = tempModels();
    const dir = path.join(models, 'Xenova', 'bge-small-en-v1.5', 'onnx');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), 'half a file');
    const T = fakeTransformers({ failWith: new Error('fetch failed') });
    await assert.rejects(createLocalBackend({ load: () => T }).loadEmbedder({ model: MODEL, modelsDir: models }), (err) => err.code === 'MODEL_UNAVAILABLE' && /fetch failed/.test(err.message));
    assert.ok(!fs.existsSync(path.join(dir, 'model_quantized.onnx')), 'the partial file is gone');
    assert.ok(!fs.existsSync(path.join(models, 'Xenova', 'bge-small-en-v1.5', COMPLETE_MARKER)), 'a failed load writes no marker');
  });

  it('allowDownload false and nothing downloaded: MODEL_UNAVAILABLE without trying', async () => {
    const T = fakeTransformers();
    await assert.rejects(createLocalBackend({ load: () => T }).loadEmbedder({ model: MODEL, modelsDir: tempModels(), allowDownload: false }), (err) => err.code === 'MODEL_UNAVAILABLE');
    assert.strictEqual(T.calls.length, 0);
  });

  it('a runtime that does not load (no onnxruntime-node, a bad native binary) is MODEL_UNAVAILABLE naming the runtime', async () => {
    const load = () => { throw Object.assign(new Error('Cannot find module onnxruntime-node'), { code: 'MODULE_NOT_FOUND' }); };
    await assert.rejects(createLocalBackend({ load }).loadEmbedder({ model: MODEL, modelsDir: tempModels() }),
      (err) => err.code === 'MODEL_UNAVAILABLE' && /runtime/.test(err.message) && /MODULE_NOT_FOUND/.test(err.message));
  });

  it('refuses a model id that is not a plain org/name, and a relative models folder', async () => {
    for (const bad of ['../x', 'a/../b', 'a/b/c', 'C:\\x', 'org/name:tag']) {
      assert.throws(() => modelDir('/models', bad), (err) => err.code === 'MODEL_UNAVAILABLE', bad);
    }
    await assert.rejects(createLocalBackend({ load: () => fakeTransformers() }).loadEmbedder({ model: MODEL, modelsDir: 'models' }), (err) => err.code === 'MODEL_UNAVAILABLE');
  });

  it('the reranker loads fp32 and scores from the logits, one per text', async () => {
    const T = fakeTransformers();
    const r = await createLocalBackend({ load: () => T }).loadReranker({ model: 'Xenova/ms-marco-MiniLM-L-6-v2', modelsDir: tempModels() });
    assert.deepStrictEqual(T.calls[0], { rerank: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'fp32', remote: true });
    assert.deepStrictEqual(await r.score('gate', ['a', 'b', 'c']), [0, 0.5, 1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/history-embed-worker.test.js tests/history-local-backend.test.js`
Expected: FAIL with `Cannot find module '../src/history/embed-worker'` and `'../src/history/embedders/local-backend'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embed-protocol.js`:

```js
// src/history/embed-protocol.js
// The wire format between EmbedRunner and embed-worker.js: one JSON object
// per line (JSON escapes every newline inside a string). Requests go on the
// worker's stdin; replies and progress events come back on its fd 3. stdout
// is not connected, so a library that prints cannot corrupt a reply.
// Vectors travel as base64 little-endian float32.
const { StringDecoder } = require('node:string_decoder');
const { vecToBlob, blobToVec } = require('./embedders/vectors');

// A reply of 8 vectors of 1,024 dims is about 44 KB; a request of 8 texts at
// most 6,000 characters each. Anything near this is a broken peer.
const MAX_LINE_CHARS = 64 * 1024 * 1024;

const encodeMessage = (msg) => `${JSON.stringify(msg)}\n`;

class LineReader {
  constructor({ onMessage, onError, maxLineChars = MAX_LINE_CHARS }) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.maxLineChars = maxLineChars;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl;
    while (!this.dead && (nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.fail(new Error('a line that is not JSON'));
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.fail(new Error('a line that is not a JSON object'));
        return;
      }
      this.onMessage(msg);
    }
    if (this.buf.length > this.maxLineChars) this.fail(new Error('a line over the size limit'));
  }

  fail(err) {
    if (this.dead) return;
    this.dead = true;
    this.buf = '';
    this.onError(err);
  }
}

const vecToBase64 = (vec) => vecToBlob(vec).toString('base64');
const base64ToVec = (s) => blobToVec(new Uint8Array(Buffer.from(String(s), 'base64')));

module.exports = { MAX_LINE_CHARS, encodeMessage, LineReader, vecToBase64, base64ToVec };
```

Create `src/history/embed-worker.js`:

```js
// src/history/embed-worker.js
// The embed worker process (recall spec §3, §5.2). EmbedRunner spawns it the
// way pdf-sandbox.js spawns the PDF worker: from process.execPath with
// ELECTRON_RUN_AS_NODE=1 (the app binary in a packaged build, plain node in
// the service and LongHaul), no IPC channel, requests on stdin and replies on
// fd 3 (embed-protocol.js). It holds at most one embedding model and one
// cross-encoder, loaded on request, and answers one request at a time, in
// order. Native onnxruntime runs here: a crash kills this process, never the
// app. It exits when stdin ends (the parent closed it or died), when the
// parent is gone, or on a line it cannot read.
const net = require('node:net');
const { LineReader, encodeMessage, vecToBase64 } = require('./embed-protocol');

const PARENT_POLL_MS = 5000;
const CODES = new Set(['MODEL_UNAVAILABLE', 'MODEL_NOT_LOADED', 'MODEL_CHANGED', 'BAD_REQUEST', 'EMBED_FAILED']);
const coded = (code, message) => Object.assign(new Error(message), { code });
const isTexts = (v) => Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === 'string');

function runWorker({ input, write, backend, exit = (code) => process.exit(code) }) {
  const loaded = { embedder: null, reranker: null };
  let queue = Promise.resolve();
  const reply = (msg) => write(encodeMessage(msg));
  const fail = (id, err) => reply({
    id,
    ok: false,
    code: CODES.has(err && err.code) ? err.code : 'EMBED_FAILED',
    message: String((err && err.message) || err).slice(0, 300)
  });

  const holding = (role, model) => {
    const cur = loaded[role];
    if (!cur) throw coded('MODEL_NOT_LOADED', `no ${role} model is loaded`);
    if (cur.model !== model) throw coded('MODEL_CHANGED', `${model} is not the loaded ${role} model (${cur.model})`);
    return cur.handle;
  };

  async function handle(msg) {
    const { id, op } = msg;
    if (op === 'load') {
      const role = msg.role === 'reranker' ? 'reranker' : 'embedder';
      if (typeof msg.model !== 'string' || !msg.model) throw coded('BAD_REQUEST', 'load needs a model');
      const cur = loaded[role];
      if (cur && cur.model === msg.model) return reply({ id, ok: true, dim: cur.handle.dim ?? null });
      const onProgress = (p) => {
        if (p && p.status === 'progress') reply({ event: 'progress', id, file: String(p.file || ''), loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
      };
      loaded[role] = null;
      const opts = { model: msg.model, modelsDir: msg.modelsDir, allowDownload: msg.allowDownload !== false, onProgress };
      const h = role === 'reranker' ? await backend.loadReranker(opts) : await backend.loadEmbedder(opts);
      loaded[role] = { model: msg.model, handle: h };
      return reply({ id, ok: true, dim: h.dim ?? null });
    }
    if (op === 'embed') {
      if (!isTexts(msg.texts)) throw coded('BAD_REQUEST', 'embed needs a list of texts');
      const vectors = await holding('embedder', msg.model).embed(msg.texts);
      return reply({ id, ok: true, vectors: vectors.map(vecToBase64) });
    }
    if (op === 'rerank') {
      if (!isTexts(msg.texts) || typeof msg.query !== 'string') throw coded('BAD_REQUEST', 'rerank needs a query and a list of texts');
      const scores = await holding('reranker', msg.model).score(msg.query, msg.texts);
      return reply({ id, ok: true, scores: Array.from(scores, Number) });
    }
    throw coded('BAD_REQUEST', `unknown op ${JSON.stringify(op)}`);
  }

  const reader = new LineReader({
    onMessage: (msg) => {
      queue = queue.then(() => handle(msg)).catch((err) => fail(msg.id, err));
    },
    onError: () => exit(1)
  });
  input.on('data', (chunk) => reader.push(chunk));
  input.on('end', () => exit(0));
  return { reader };
}

if (require.main === module) {
  const out = new net.Socket({ fd: 3, readable: false, writable: true });
  out.on('error', () => process.exit(1));
  const backendPath = process.env.KL_EMBED_WORKER_BACKEND;
  const backend = (backendPath ? require(backendPath) : require('./embedders/local-backend')).createBackend();
  runWorker({ input: process.stdin, write: (s) => out.write(s), backend });
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (err) {
      if (err.code !== 'EPERM') process.exit(0);
    }
  }, PARENT_POLL_MS).unref();
}

module.exports = { runWorker };
```

Create `src/history/embedders/local-backend.js`:

```js
// src/history/embedders/local-backend.js
// The local models, loaded only inside the embed worker (recall spec §5.2,
// §6.3 step 6): an embedding model through @huggingface/transformers'
// feature-extraction pipeline (int8, CPU) and the cross-encoder the H3 rerank
// probe measured (fp32, CPU; it was src/longhaul/rerank.js's
// loadCrossEncoder). Both run on the native onnxruntime-node; transformers.js
// has no WASM path in Node (Appendix A.3).
//
// Model files download once into <modelsDir>/<org>/<name>/ and load from
// there afterwards with remote access off, so a model that downloaded works
// offline. A load that finished writes COMPLETE_MARKER; a model folder
// without it is a download that stopped part way, and it is deleted before
// the next try (spec §15: partial files are discarded).
const fs = require('fs');
const path = require('path');
const { profileFor } = require('./profiles');
const { LOCAL_MODEL_RE } = require('../settings');

const COMPLETE_MARKER = '.kl-complete.json';
const EMBED_DTYPE = 'q8';
const RERANK_DTYPE = 'fp32';
// ONNX threads per session: background work on a desktop takes two cores,
// not all of them.
const WORKER_THREADS = 2;
const RERANK_MAX_LENGTH = 512;

const unavailable = (message) => Object.assign(new Error(message), { code: 'MODEL_UNAVAILABLE' });

function modelDir(modelsDir, model) {
  if (typeof model !== 'string' || !LOCAL_MODEL_RE.test(model) || model.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw unavailable(`not a local model id (org/name): ${JSON.stringify(model)}`);
  }
  return path.join(modelsDir, ...model.split('/'));
}

function createLocalBackend({ load = () => require('@huggingface/transformers'), threads = WORKER_THREADS } = {}) {
  let T = null;
  const sessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1 };

  function prepare({ model, modelsDir, allowDownload }) {
    if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir)) throw unavailable(`${model} could not be loaded: no models folder`);
    const dir = modelDir(modelsDir, model);
    const marker = path.join(dir, COMPLETE_MARKER);
    const complete = fs.existsSync(marker);
    if (!complete && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!complete && !allowDownload) throw unavailable(`${model} is not downloaded`);
    if (!T) {
      try {
        T = load();
      } catch (err) {
        throw unavailable(`the local model runtime did not load (${err.code || err.message})`);
      }
    }
    T.env.cacheDir = modelsDir;
    T.env.allowLocalModels = false;
    T.env.allowRemoteModels = !complete;
    return { dir, marker, complete };
  }

  function finish({ dir, marker, complete }, model, dtype) {
    if (complete) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ model, dtype, at: new Date().toISOString() })}\n`);
  }

  const progressOf = (onProgress) => (e) => {
    if (e && e.status === 'progress') onProgress(e);
  };

  return {
    async loadEmbedder({ model, modelsDir, allowDownload = true, onProgress = () => {} }) {
      const p = prepare({ model, modelsDir, allowDownload });
      const { pooling } = profileFor(model);
      let extractor;
      try {
        extractor = await T.pipeline('feature-extraction', model, {
          dtype: EMBED_DTYPE, device: 'cpu', session_options: sessionOptions, progress_callback: progressOf(onProgress)
        });
      } catch (err) {
        throw unavailable(`${model} could not be loaded: ${err.message}`);
      }
      finish(p, model, EMBED_DTYPE);
      let dim = null;
      return {
        get dim() { return dim; },
        async embed(texts) {
          const out = await extractor(texts, { pooling, normalize: true });
          const [n, d] = out.dims;
          dim = d;
          const vecs = [];
          for (let i = 0; i < n; i++) vecs.push(Float32Array.from(out.data.subarray(i * d, (i + 1) * d)));
          return vecs;
        }
      };
    },

    async loadReranker({ model, modelsDir, allowDownload = true, onProgress = () => {} }) {
      const p = prepare({ model, modelsDir, allowDownload });
      let tokenizer;
      let net;
      try {
        const progress_callback = progressOf(onProgress);
        tokenizer = await T.AutoTokenizer.from_pretrained(model, { progress_callback });
        net = await T.AutoModelForSequenceClassification.from_pretrained(model, {
          dtype: RERANK_DTYPE, device: 'cpu', session_options: sessionOptions, progress_callback
        });
      } catch (err) {
        throw unavailable(`${model} could not be loaded: ${err.message}`);
      }
      finish(p, model, RERANK_DTYPE);
      return {
        dim: null,
        async score(query, texts) {
          const inputs = tokenizer(new Array(texts.length).fill(query), {
            text_pair: texts, padding: true, truncation: true, max_length: RERANK_MAX_LENGTH
          });
          const { logits } = await net(inputs);
          const width = logits.data.length / texts.length;
          return texts.map((_, k) => Number(logits.data[k * width]));
        }
      };
    }
  };
}

module.exports = {
  createLocalBackend, createBackend: () => createLocalBackend(), modelDir,
  COMPLETE_MARKER, EMBED_DTYPE, RERANK_DTYPE, WORKER_THREADS
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embed-worker.test.js tests/history-local-backend.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/embed-protocol.js src/history/embed-worker.js src/history/embedders/local-backend.js tests/helpers/fake-embed-backend.js tests/history-embed-worker.test.js tests/history-local-backend.test.js
git commit -m "feat(history): the embed worker, its NDJSON protocol, and the local transformers.js backend"
```

---

## Task 6: `EmbedRunner`: the worker's lifecycle, priorities, crashes and timeouts

**Files:**
- Create: `src/history/embed-runner.js`
- Test: `tests/history-embed-runner.test.js`

**Interfaces:**
- Consumes: the Task 5 protocol and worker; `EmbedError`.
- Produces: `class EmbedRunner extends EventEmitter`:
  - `new EmbedRunner({ spawn, execPath, workerPath, testBackend, timeouts: { load, query, rerank, document }, backoffMs = [1000, 5000, 30000], crashWindowMs = 600000, maxCrashes = 3, memoryMb = 1024, idleUnref = false, now })`
  - `load(role, model, { modelsDir, allowDownload = true }) → Promise<{ dim }>`: sets the model the runner keeps loaded for `role`, reloaded after every restart.
  - `embed(model, texts, { priority: 'query' | 'document' = 'document' }) → Promise<Float32Array[]>` (documents go in slices of `DOC_SLICE` = 8).
  - `rerank(model, query, texts, { deadlineMs = Infinity }) → Promise<number[]>` (length-sorted slices of `RERANK_SLICE` = 16; past `deadlineMs` rejects `RERANK_TIMEOUT`).
  - `reset()` re-enables after `disabled`; `stop() → Promise<void>`; getters `disabled`, `state` (`idle | running | disabled | stopped`).
  - Events: `progress` `{ role, model, file, loaded, total }`, `crashed` `{ code, signal, crashes, quick }`, `disabled` `{ crashes }`.
  - Rejections are `EmbedError` with the codes of Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/history-embed-runner.test.js`:

```js
// tests/history-embed-runner.test.js
// EmbedRunner over a real child process running the embed worker with the
// fake backend (recall spec §5.2, §15): priorities, crashes and restarts,
// the disable rule, timeouts, a model switch, stop, idle unref.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedRunner } = require('../src/history/embed-runner');

const BACKEND = require.resolve('./helpers/fake-embed-backend');
const MODELS = path.join(os.tmpdir(), 'kl-embed-models-unused');
const runners = [];
afterEach(async () => { while (runners.length) await runners.pop().stop(); });
const make = (opts = {}) => {
  const r = new EmbedRunner({ testBackend: BACKEND, backoffMs: [20, 20, 20], ...opts });
  runners.push(r);
  return r;
};
const load = (r, model = 'fake/one') => r.load('embedder', model, { modelsDir: MODELS });

describe('EmbedRunner', () => {
  it('loads with progress, then embeds in document slices, in order', async () => {
    const r = make();
    const progress = [];
    r.on('progress', (p) => progress.push([p.role, p.model, p.loaded]));
    assert.deepStrictEqual(await load(r), { dim: 28 });
    assert.deepStrictEqual(progress, [['embedder', 'fake/one', 50], ['embedder', 'fake/one', 100]]);
    const texts = Array.from({ length: 20 }, (_, i) => (i === 7 ? 'linen bandage' : `gate code ${i}`));
    const vecs = await r.embed('fake/one', texts);
    assert.strictEqual(vecs.length, 20);
    assert.ok(vecs.every((v) => v instanceof Float32Array && v.length === 28));
    assert.notDeepStrictEqual(Array.from(vecs[7]), Array.from(vecs[6]), 'each vector is its own text\'s');
    assert.strictEqual(r.state, 'running');
  });

  it('a query goes before document slices already queued', async () => {
    const r = make();
    await load(r);
    const order = [];
    const doc = (n) => r.embed('fake/one', Array.from({ length: 8 }, () => `__slow__ gate ${n}`)).then(() => order.push(`doc${n}`));
    const jobs = [doc(1), doc(2), doc(3)];
    await new Promise((resolve) => setImmediate(resolve));
    jobs.push(r.embed('fake/one', ['gate code'], { priority: 'query' }).then(() => order.push('query')));
    await Promise.all(jobs);
    assert.deepStrictEqual(order, ['doc1', 'query', 'doc2', 'doc3']);
  });

  it('a crash fails the request in flight; the next runs on a fresh worker with the model reloaded', async () => {
    const r = make();
    const crashes = [];
    r.on('crashed', (e) => crashes.push(e));
    await load(r);
    await assert.rejects(r.embed('fake/one', ['__crash__ gate']), (err) => err.code === 'EMBED_WORKER_CRASHED' && /code 70/.test(err.message));
    assert.strictEqual(crashes.length, 1);
    assert.strictEqual(crashes[0].code, 70);
    const [v] = await r.embed('fake/one', ['gate code']);
    assert.strictEqual(v.length, 28);
  });

  it('three crashes in the window disable it for the session; reset() brings it back', async () => {
    const r = make();
    let disabled = 0;
    r.on('disabled', () => { disabled += 1; });
    await load(r);
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(r.embed('fake/one', ['__crash__']), (err) => err.code === 'EMBED_WORKER_CRASHED');
    }
    assert.strictEqual(disabled, 1);
    assert.strictEqual(r.disabled, true);
    assert.strictEqual(r.state, 'disabled');
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'EMBED_DISABLED');
    r.reset();
    assert.strictEqual((await r.embed('fake/one', ['gate']))[0].length, 28);
  });

  it('crashes outside the window do not add up', async () => {
    let clock = 0;
    const r = make({ now: () => clock, crashWindowMs: 1000 });
    await load(r);
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(r.embed('fake/one', ['__crash__']), (err) => err.code === 'EMBED_WORKER_CRASHED');
      clock += 2000;
    }
    assert.strictEqual(r.disabled, false);
  });

  it('a request past its timeout kills the hung worker (EMBED_WORKER_TIMEOUT); the next works', async () => {
    const r = make({ timeouts: { document: 300 } });
    await load(r);
    await assert.rejects(r.embed('fake/one', ['__hang__']), (err) => err.code === 'EMBED_WORKER_TIMEOUT');
    assert.strictEqual((await r.embed('fake/one', ['gate']))[0].length, 28);
  });

  it('a model switch refuses the old model\'s queued slices; the one in flight finishes', async () => {
    const r = make();
    await load(r, 'fake/one');
    const first = r.embed('fake/one', ['__slow__ gate']);
    const queued = r.embed('fake/one', ['gate again']);
    const switched = load(r, 'fake/two');
    assert.strictEqual((await first).length, 1);
    await assert.rejects(queued, (err) => err.code === 'MODEL_CHANGED');
    await switched;
    assert.strictEqual((await r.embed('fake/two', ['gate']))[0].length, 28);
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'MODEL_CHANGED');
  });

  it('a model that fails to load fails its load and the requests waiting on it', async () => {
    const r = make();
    const loading = load(r, 'fake/missing');
    const waiting = r.embed('fake/missing', ['gate']);
    await assert.rejects(loading, (err) => err.code === 'MODEL_UNAVAILABLE' && /offline/.test(err.message));
    await assert.rejects(waiting, (err) => err.code === 'MODEL_UNAVAILABLE');
  });

  it('reranks in length-sorted slices, scores back in the given order; a passed deadline rejects RERANK_TIMEOUT', async () => {
    const r = make();
    await r.load('reranker', 'fake/rr', { modelsDir: MODELS });
    const texts = ['a linen bandage and more linen', 'the tomb', ...Array.from({ length: 30 }, (_, i) => `filler ${i}`)];
    const scores = await r.rerank('fake/rr', 'linen bandage', texts);
    assert.strictEqual(scores.length, 32);
    assert.ok(scores[0] > scores[1]);
    await assert.rejects(r.rerank('fake/rr', 'linen', ['x'], { deadlineMs: Date.now() - 1 }), (err) => err.code === 'RERANK_TIMEOUT');
  });

  it('a worker that exits before any reply gets the packaged-app hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-quick-exit-'));
    const workerPath = path.join(dir, 'exit.js');
    fs.writeFileSync(workerPath, 'process.exit(3);\n');
    try {
      const r = make({ workerPath });
      await assert.rejects(load(r), (err) => err.code === 'EMBED_WORKER_CRASHED' && /RunAsNode/.test(err.message) && /onnxruntime-node/.test(err.message));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() fails what is queued and in flight with EMBED_STOPPED, and later calls too', async () => {
    const r = make();
    await load(r);
    const hung = r.embed('fake/one', ['__hang__']);
    const queued = r.embed('fake/one', ['gate']);
    await new Promise((resolve) => setImmediate(resolve));
    await r.stop();
    await assert.rejects(hung, (err) => err.code === 'EMBED_STOPPED');
    await assert.rejects(queued, (err) => err.code === 'EMBED_STOPPED');
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'EMBED_STOPPED');
    assert.strictEqual(r.state, 'stopped');
  });

  it('idleUnref: a process that used the runner and never stopped it still exits', () => {
    const script = `
      const { EmbedRunner } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'history', 'embed-runner'))});
      const r = new EmbedRunner({ testBackend: ${JSON.stringify(BACKEND)}, idleUnref: true });
      r.load('embedder', 'fake/one', { modelsDir: ${JSON.stringify(MODELS)} })
        .then(() => r.embed('fake/one', ['gate']))
        .then((v) => process.stdout.write('embedded ' + v[0].length + '\\n'));
    `;
    const out = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /embedded 28/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-embed-runner.test.js`
Expected: FAIL with `Cannot find module '../src/history/embed-runner'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embed-runner.js`:

```js
// src/history/embed-runner.js
// Hosts the embed worker (recall spec §3.2 EmbedRunner, §5.2, §15) the way
// pdf-sandbox.js hosts the PDF worker: a child process spawned from
// process.execPath with ELECTRON_RUN_AS_NODE=1 (the app binary in a packaged
// build; plain node in the service and LongHaul), an env of only what it
// needs, no IPC channel, requests on stdin and replies on fd 3
// (embed-protocol.js). The worker loads native onnxruntime; a crash there
// kills the child, never this process.
//
// - One worker, one request at a time. Jobs run by priority: loads, then a
//   turn's query, then rerank slices, then document slices, so a query waits
//   at most one document slice (DOC_SLICE texts).
// - The runner remembers the model it keeps loaded per role (load()). A job
//   for another model fails with MODEL_CHANGED before it is sent, so a slice
//   queued for a model the owner switched away from is never embedded by the
//   new one. A fresh worker gets its models reloaded before its first job.
// - Every job has a timeout; one that runs out kills the worker (it is hung)
//   and counts as a crash.
// - A worker that exits with a job in flight fails that job
//   (EMBED_WORKER_CRASHED); the queue waits backoffMs[n] (1 s, 5 s, 30 s)
//   and starts a new worker. maxCrashes (3) within crashWindowMs (10 min)
//   disable the runner for the session: every job fails with EMBED_DISABLED
//   until reset().
// - idleUnref (LongHaul's CLI): while nothing is queued or in flight the
//   worker does not keep this process alive.
// - stop() fails every job with EMBED_STOPPED and kills the worker.
const childProcess = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LineReader, encodeMessage, base64ToVec } = require('./embed-protocol');
const { EmbedError } = require('./embed-errors');
const { createLogger } = require('../logging');

const log = createLogger('history/embed-runner');

const WORKER_PATH = path.join(__dirname, 'embed-worker.js');
const DOC_SLICE = 8;
const RERANK_SLICE = 16;
const PRIORITY = Object.freeze({ load: 0, query: 1, rerank: 2, document: 3 });
const DEFAULT_TIMEOUTS = Object.freeze({ load: 10 * 60000, query: 30000, rerank: 30000, document: 60000 });
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 5000, 30000]);
const DEFAULT_MEMORY_MB = 1024;
const QUICK_EXIT_MS = 5000;
const QUICK_EXIT_HINT = 'the embed worker ended at once, before any reply; likely cause in a packaged app: Electron\'s RunAsNode fuse is off, or onnxruntime-node is not unpacked from the asar';
const STDERR_MAX_CHARS = 8 * 1024;
const PASS_ENV = ['SYSTEMROOT', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

function decodeVectors(msg, count) {
  const list = Array.isArray(msg.vectors) ? msg.vectors : null;
  if (!list || list.length !== count) throw new EmbedError('EMBED_FAILED', `the embed worker returned ${list ? list.length : 'no'} vectors for ${count} texts`);
  return list.map(base64ToVec);
}

function decodeScores(msg, count) {
  const list = Array.isArray(msg.scores) ? msg.scores : null;
  if (!list || list.length !== count || !list.every(Number.isFinite)) throw new EmbedError('EMBED_FAILED', 'the embed worker returned no usable rerank scores');
  return list;
}

class EmbedRunner extends EventEmitter {
  constructor({
    spawn = childProcess.spawn, execPath = process.execPath, workerPath = WORKER_PATH, testBackend = null,
    timeouts = {}, backoffMs = DEFAULT_BACKOFF_MS, crashWindowMs = 10 * 60000, maxCrashes = 3,
    memoryMb = DEFAULT_MEMORY_MB, idleUnref = false, now = Date.now
  } = {}) {
    super();
    this.spawnFn = spawn;
    this.execPath = execPath;
    this.workerPath = workerPath;
    this.testBackend = testBackend;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.backoffMs = backoffMs;
    this.crashWindowMs = crashWindowMs;
    this.maxCrashes = maxCrashes;
    this.memoryMb = memoryMb;
    this.idleUnref = idleUnref;
    this.now = now;
    this.child = null;
    this.queue = [];
    this.inflight = null;
    this.nextId = 1;
    this.seq = 0;
    this.crashes = [];
    this._disabled = false;
    this.stopped = false;
    this.restartTimer = null;
    // What the runner keeps loaded per role, and what the current worker holds.
    this.desired = { embedder: null, reranker: null };
    this.workerModels = { embedder: null, reranker: null };
  }

  get disabled() { return this._disabled; }

  get state() {
    if (this.stopped) return 'stopped';
    if (this._disabled) return 'disabled';
    return this.child ? 'running' : 'idle';
  }

  load(role, model, { modelsDir, allowDownload = true } = {}) {
    const r = role === 'reranker' ? 'reranker' : 'embedder';
    this.desired[r] = { model, modelsDir, allowDownload };
    return this._enqueue(this._loadJob(r, this.desired[r]));
  }

  embed(model, texts, { priority = 'document' } = {}) {
    if (!Array.isArray(texts) || !texts.length) return Promise.resolve([]);
    const kind = priority === 'query' ? 'query' : 'document';
    const size = kind === 'query' ? texts.length : DOC_SLICE;
    const parts = [];
    for (let i = 0; i < texts.length; i += size) {
      const slice = texts.slice(i, i + size);
      parts.push(this._enqueue({
        op: 'embed', role: 'embedder', model, fields: { model, texts: slice },
        priority: PRIORITY[kind], timeoutMs: this.timeouts[kind], decode: (msg) => decodeVectors(msg, slice.length)
      }));
    }
    return Promise.all(parts).then((groups) => groups.flat());
  }

  async rerank(model, query, texts, { deadlineMs = Infinity } = {}) {
    if (!Array.isArray(texts) || !texts.length) return [];
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const out = new Array(texts.length);
    for (let b = 0; b < order.length; b += RERANK_SLICE) {
      if (this.now() > deadlineMs) throw new EmbedError('RERANK_TIMEOUT', 'the rerank ran past its deadline');
      const idx = order.slice(b, b + RERANK_SLICE);
      const slice = idx.map((i) => texts[i]);
      const scores = await this._enqueue({
        op: 'rerank', role: 'reranker', model, fields: { model, query, texts: slice },
        priority: PRIORITY.rerank, timeoutMs: this.timeouts.rerank, decode: (msg) => decodeScores(msg, slice.length)
      });
      idx.forEach((i, k) => { out[i] = scores[k]; });
    }
    return out;
  }

  reset() {
    this._disabled = false;
    this.crashes = [];
    this._pump();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._failAll('EMBED_STOPPED', 'the embed worker was stopped');
    const child = this.child;
    if (!child) return;
    this._kill(child, { expected: true });
    await Promise.race([child.klExited, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  }

  // ── queue ───────────────────────────────────────────────────────────────

  _loadJob(role, want) {
    return {
      op: 'load', role, model: want.model,
      fields: { role, model: want.model, modelsDir: want.modelsDir, allowDownload: want.allowDownload !== false },
      priority: PRIORITY.load, timeoutMs: this.timeouts.load, decode: (msg) => ({ dim: Number.isInteger(msg.dim) ? msg.dim : null })
    };
  }

  _enqueue(job) {
    if (this.stopped) return Promise.reject(new EmbedError('EMBED_STOPPED', 'the embed worker was stopped'));
    if (this._disabled) return Promise.reject(new EmbedError('EMBED_DISABLED', 'local embedding is off for this session: the worker kept crashing'));
    return new Promise((resolve, reject) => {
      this.queue.push({ ...job, seq: this.seq++, resolve, reject });
      this._pump();
    });
  }

  _next() {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const j = this.queue[i];
      if (best < 0 || j.priority < this.queue[best].priority || (j.priority === this.queue[best].priority && j.seq < this.queue[best].seq)) best = i;
    }
    return best < 0 ? null : this.queue.splice(best, 1)[0];
  }

  _pump() {
    if (this.inflight || this.stopped || this._disabled || this.restartTimer) return;
    const job = this._next();
    if (!job) {
      this._idle();
      return;
    }
    if (job.op !== 'load') {
      const want = this.desired[job.role];
      if (!want || want.model !== job.model) {
        job.reject(new EmbedError('MODEL_CHANGED', `${job.model} is not the ${job.role} model any more`));
        this._pump();
        return;
      }
      if (this.workerModels[job.role] !== job.model) {
        // A fresh worker: load the model first, then this job.
        this.queue.push(job);
        this._send({ ...this._loadJob(job.role, want), seq: -1, internal: true, resolve: () => {}, reject: () => {} });
        return;
      }
    }
    this._send(job);
  }

  _send(job) {
    if (!this.child) {
      try {
        this._spawn();
      } catch (err) {
        job.reject(new EmbedError('EMBED_WORKER_CRASHED', `the embed worker did not start: ${err.message}`));
        this._crashed({ code: null, signal: null, stderr: '', quick: true });
        return;
      }
    }
    job.id = this.nextId++;
    this.inflight = job;
    this._ref();
    job.timer = setTimeout(() => this._hung(job), job.timeoutMs);
    try {
      this.child.stdin.write(encodeMessage({ id: job.id, op: job.op, ...job.fields }));
    } catch (err) {
      log.warn('writing to the embed worker failed', { error: err.message });
      this._kill(this.child, { expected: false });
    }
  }

  _onMessage(child, msg) {
    const job = this.inflight;
    if (msg.event === 'progress') {
      if (job && msg.id === job.id && job.op === 'load') {
        this.emit('progress', { role: job.role, model: job.model, file: msg.file, loaded: msg.loaded, total: msg.total });
      }
      return;
    }
    if (!job || msg.id !== job.id) {
      this._kill(child, { expected: false, why: 'a reply nobody asked for' });
      return;
    }
    child.klReplied = true;
    clearTimeout(job.timer);
    this.inflight = null;
    if (msg.ok !== true) {
      const err = new EmbedError(String(msg.code || 'EMBED_FAILED'), String(msg.message || 'the embed worker failed'));
      if (job.op === 'load') this._failLoad(job, err);
      else job.reject(err);
    } else {
      let value;
      try {
        value = job.decode(msg);
      } catch (err) {
        job.reject(err);
        this._pump();
        return;
      }
      if (job.op === 'load') this.workerModels[job.role] = job.model;
      job.resolve(value);
    }
    this._pump();
  }

  // A failed load fails every queued job that needed that model.
  _failLoad(job, err) {
    job.reject(err);
    const want = this.desired[job.role];
    if (want && want.model === job.model) this.desired[job.role] = null;
    this.queue = this.queue.filter((j) => {
      if (j.role === job.role && j.model === job.model) {
        j.reject(err);
        return false;
      }
      return true;
    });
  }

  _failAll(code, message) {
    const err = new EmbedError(code, message);
    const job = this.inflight;
    this.inflight = null;
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    for (const j of this.queue.splice(0)) j.reject(err);
  }

  // ── the child ───────────────────────────────────────────────────────────

  _spawn() {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key];
    if (this.testBackend) env.KL_EMBED_WORKER_BACKEND = this.testBackend;
    const child = this.spawnFn(this.execPath, [`--max-old-space-size=${this.memoryMb}`, this.workerPath], {
      env, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], windowsHide: true
    });
    child.klStarted = this.now();
    child.klReplied = false;
    child.klExpected = false;
    child.klStderr = '';
    this.child = child;
    this.workerModels = { embedder: null, reranker: null };
    child.klExited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve();
        this._onExit(child, code, signal);
      });
      child.on('error', (err) => {
        log.warn('embed worker error', { error: err.message });
        if (child.pid === undefined) {
          resolve();
          this._onExit(child, null, null);
        }
      });
    });
    if (!child.stdin || !child.stdio || !child.stdio[3]) {
      this._kill(child, { expected: false });
      throw new Error('the worker has no pipes');
    }
    child.stderr?.on('data', (c) => {
      if (child.klStderr.length < STDERR_MAX_CHARS) child.klStderr += c.toString('utf8').slice(0, STDERR_MAX_CHARS - child.klStderr.length);
    });
    for (const s of [child.stdin, child.stderr, child.stdio[3]]) s?.on('error', () => {});
    const reader = new LineReader({
      onMessage: (m) => { if (child === this.child) this._onMessage(child, m); },
      onError: (err) => { if (child === this.child) this._kill(child, { expected: false, why: `bad reply: ${err.message}` }); }
    });
    child.stdio[3].on('data', (c) => reader.push(c));
  }

  _kill(child, { expected, why = null }) {
    if (!child) return;
    child.klExpected = child.klExpected || expected;
    if (why) log.warn('stopping the embed worker', { why, pid: child.pid });
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('embed worker kill failed', { pid: child.pid, error: err.message });
    }
  }

  _hung(job) {
    if (this.inflight !== job) return;
    job.hung = true;
    log.warn('embed worker request timed out', { op: job.op, timeoutMs: job.timeoutMs });
    this._kill(this.child, { expected: false });
  }

  _onExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.workerModels = { embedder: null, reranker: null };
    if (child.klExpected) return;
    const quick = !child.klReplied && this.now() - child.klStarted < QUICK_EXIT_MS;
    const job = this.inflight;
    this.inflight = null;
    if (job) {
      clearTimeout(job.timer);
      const err = job.hung
        ? new EmbedError('EMBED_WORKER_TIMEOUT', `the embed worker stopped answering (${job.op} after ${job.timeoutMs} ms)`)
        : new EmbedError('EMBED_WORKER_CRASHED', `the embed worker exited (code ${code}, signal ${signal})${quick ? `; ${QUICK_EXIT_HINT}` : ''}`);
      if (job.internal) {
        // A reload for a fresh worker died: fail what waited on it.
        this.queue = this.queue.filter((j) => {
          if (j.role === job.role && j.model === job.model) {
            j.reject(err);
            return false;
          }
          return true;
        });
      } else {
        job.reject(err);
      }
    }
    this._crashed({ code, signal, stderr: child.klStderr, quick });
  }

  _crashed({ code, signal, stderr, quick }) {
    const t = this.now();
    this.crashes = this.crashes.filter((x) => t - x < this.crashWindowMs);
    this.crashes.push(t);
    log.warn('embed worker crashed', { code, signal, crashes: this.crashes.length, stderr: String(stderr || '').slice(0, 500) });
    this.emit('crashed', { code, signal, crashes: this.crashes.length, quick });
    if (this.crashes.length >= this.maxCrashes) {
      this._disabled = true;
      this._failAll('EMBED_DISABLED', `the embed worker crashed ${this.crashes.length} times in ten minutes; local embedding is off for this session`);
      this.emit('disabled', { crashes: this.crashes.length });
      return;
    }
    const delay = this.backoffMs[Math.min(this.crashes.length - 1, this.backoffMs.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._pump();
    }, delay);
  }

  _ref() {
    if (!this.idleUnref || !this.child) return;
    this.child.ref?.();
    for (const s of [this.child.stdin, this.child.stderr, this.child.stdio?.[3]]) s?.ref?.();
  }

  _idle() {
    if (!this.idleUnref || !this.child || this.inflight) return;
    this.child.unref?.();
    for (const s of [this.child.stdin, this.child.stderr, this.child.stdio?.[3]]) s?.unref?.();
  }
}

module.exports = { EmbedRunner, DOC_SLICE, RERANK_SLICE, DEFAULT_TIMEOUTS, QUICK_EXIT_HINT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embed-runner.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`. (The tests spawn real `node` children; on Windows with an agent shell's `ELECTRON_RUN_AS_NODE` set they still run, since the variable is inert for `node`.)

- [ ] **Step 5: Commit**

```bash
git add src/history/embed-runner.js tests/history-embed-runner.test.js
git commit -m "feat(history): EmbedRunner: the embed worker's lifecycle, priorities, crash backoff and timeouts"
```

---

## Task 7: The local embedder and `EmbedderHost`

**Files:**
- Create: `src/history/embedders/local.js`, `src/history/embedder-host.js`
- Create: `tests/helpers/fake-embed-runner.js`
- Test: `tests/history-embedder-host.test.js`

**Interfaces:**
- Consumes: `EmbedRunner` API (Task 6: `load`, `embed`, `rerank`, `reset`, `stop`, events `progress` and `disabled`); `createRemoteEmbedder`, `prefixTexts` (Task 4); `embedInput`, `unit` (Task 3); `mergeHistorySettings`, `embedderKey` (Task 1).
- Produces:
  - `createLocalEmbedder({ runner, model, modelsDir, allowDownload = true }) → Embedder & { ready() → Promise<void> }` (`name` `local:<model>`; queries go at query priority).
  - `class EmbedderHost extends EventEmitter`: `new EmbedderHost({ getSettings, modelsDir, createRunner, createProvider(kind, embedderSettings), notify({ title, body }), now, retryMs = 600000, log })`; `start()`; `started`; `current() → Embedder | null` (only when `state === 'ready'`); `status() → { kind, key, state, download: { loaded, total } | null, error, tokens }`; `reason() → string | null` (why vectors cannot be used although they are on; `null` when ready or off by choice); `fail(err)` (callers report a failed embed); `retry()`; `rerank(query, texts, { maxMs }) → Promise<number[]>` (the local cross-encoder, `recall.rerank.model`, loaded on first use; throws when not started); `stop() → Promise<void>`. Emits `status` on every state change.
  - States: `off | starting | downloading | ready | unavailable | disabled` (see the file header).
  - `tests/helpers/fake-embed-runner.js`: `FakeEmbedRunner` (in-process, the fake backend behind the runner API) for Task 12.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/fake-embed-runner.js`:

```js
// tests/helpers/fake-embed-runner.js
// An in-process EmbedRunner stand-in (no child process): the fake backend's
// bag-of-words models behind load/embed/rerank/reset/stop. For tests that
// build a whole core (Task 12); the host's own tests drive a stub by hand.
const { EventEmitter } = require('node:events');
const { createBackend } = require('./fake-embed-backend');

class FakeEmbedRunner extends EventEmitter {
  constructor() {
    super();
    this.backend = createBackend({ inProcess: true });
    this.models = {};
    this.calls = [];
    this.resets = 0;
    this.stopped = false;
  }

  async load(role, model) {
    this.calls.push({ op: 'load', role, model });
    const onProgress = (p) => this.emit('progress', { role, model, file: p.file, loaded: p.loaded, total: p.total });
    const handle = role === 'reranker' ? await this.backend.loadReranker({ model, onProgress }) : await this.backend.loadEmbedder({ model, onProgress });
    this.models[role] = { model, handle };
    return { dim: handle.dim ?? null };
  }

  async embed(model, texts, { priority = 'document' } = {}) {
    this.calls.push({ op: 'embed', model, n: texts.length, priority });
    const cur = this.models.embedder;
    if (!cur || cur.model !== model) throw Object.assign(new Error(`${model} is not loaded`), { code: 'MODEL_CHANGED' });
    return cur.handle.embed(texts);
  }

  async rerank(model, query, texts, { deadlineMs = Infinity } = {}) {
    this.calls.push({ op: 'rerank', model, n: texts.length, deadlineMs });
    return this.models.reranker.handle.score(query, texts);
  }

  reset() { this.resets += 1; }

  async stop() { this.stopped = true; }
}

module.exports = { FakeEmbedRunner };
```

Create `tests/history-embedder-host.test.js`:

```js
// tests/history-embedder-host.test.js
// EmbedderHost (recall spec §5.2, §15): which embedder is live, its states,
// one owner warning per failure, retries, a model switch mid-load, the
// reranker. A stub runner stands in for the worker.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { EmbedderHost } = require('../src/history/embedder-host');
const { EmbedError } = require('../src/history/embed-errors');

class StubRunner extends EventEmitter {
  constructor() {
    super();
    this.loads = [];
    this.resets = 0;
    this.stopped = false;
  }
  load(role, model, opts) {
    let resolve;
    let reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.loads.push({ role, model, opts, resolve, reject });
    return p;
  }
  async embed(model, texts, opts) { this.lastEmbed = { model, texts, opts }; return texts.map(() => Float32Array.from([3, 4])); }
  async rerank(model, query, texts, opts) { this.lastRerank = { model, query, texts, opts }; return texts.map((_, i) => i); }
  reset() { this.resets += 1; }
  async stop() { this.stopped = true; }
}

const flush = () => new Promise((r) => setImmediate(r));
const RETRY = 600000;

function setup(embedder = {}, extra = {}) {
  let settings = { history: { embedder } };
  let now = 0;
  const runner = new StubRunner();
  const notices = [];
  const warnings = [];
  const providers = [];
  const host = new EmbedderHost({
    getSettings: () => settings,
    modelsDir: '/data/models',
    createRunner: () => runner,
    createProvider: (kind, cfg) => {
      providers.push({ kind, cfg });
      return extra.provider || { async embed(inputs) { return { vectors: inputs.map(() => [1, 0]), usage: { input: inputs.length } }; } };
    },
    notify: (n) => notices.push(n),
    now: () => now,
    retryMs: RETRY,
    log: { warn: (m) => warnings.push(m), info() {}, debug() {} }
  });
  return {
    host, runner, notices, warnings, providers,
    set: (e) => { settings = { history: { embedder: e } }; },
    advance: (ms) => { now += ms; }
  };
}

describe('EmbedderHost', () => {
  it('is off until started, and with kind none', () => {
    const s = setup();
    assert.strictEqual(s.host.current(), null);
    assert.strictEqual(s.host.status().state, 'off');
    assert.strictEqual(s.host.reason(), null, 'off by choice is not a degradation');
    const none = setup({ kind: 'none' });
    none.host.start();
    assert.strictEqual(none.host.status().state, 'off');
    assert.strictEqual(none.runner.loads.length, 0);
  });

  it('local: starting, downloading with progress, then ready with the model under its key', async () => {
    const s = setup();
    s.host.start();
    assert.strictEqual(s.host.status().state, 'starting');
    assert.deepStrictEqual(s.runner.loads.map((l) => [l.role, l.model, l.opts.modelsDir]), [['embedder', 'Xenova/bge-small-en-v1.5', '/data/models']]);
    s.runner.emit('progress', { role: 'embedder', model: 'Xenova/bge-small-en-v1.5', file: 'onnx/model_quantized.onnx', loaded: 10, total: 40 });
    s.runner.emit('progress', { role: 'embedder', model: 'Xenova/bge-small-en-v1.5', file: 'tokenizer.json', loaded: 5, total: 10 });
    assert.deepStrictEqual(s.host.status().download, { loaded: 15, total: 50 });
    assert.strictEqual(s.host.status().state, 'downloading');
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    const e = s.host.current();
    assert.strictEqual(s.host.status().state, 'ready');
    assert.strictEqual(e.name, 'local:Xenova/bge-small-en-v1.5');
    assert.strictEqual(s.host.status().key, 'local:Xenova/bge-small-en-v1.5');
    const [q] = await e.embed(['gate code'], { kind: 'query' });
    assert.ok(Math.abs(q[0] - 0.6) < 1e-6, 'unit length');
    assert.deepStrictEqual(s.runner.lastEmbed.texts, ['Represent this sentence for searching relevant passages: gate code']);
    assert.strictEqual(s.runner.lastEmbed.opts.priority, 'query');
    assert.strictEqual(s.host.reason(), null);
  });

  it('a download that fails: unavailable, one warning to the log and the owner, a retry after retryMs', async () => {
    const s = setup();
    s.host.start();
    s.runner.loads[0].reject(new EmbedError('MODEL_UNAVAILABLE', 'Xenova/bge-small-en-v1.5 could not be loaded: fetch failed (offline)'));
    await flush();
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.match(s.host.status().error, /offline/);
    assert.strictEqual(s.host.current(), null);
    assert.match(s.host.reason(), /embedding model not loaded/);
    assert.strictEqual(s.notices.length, 1);
    assert.match(s.notices[0].body, /keyword search only/);
    assert.strictEqual(s.warnings.length, 1);
    s.advance(RETRY - 1);
    assert.strictEqual(s.host.current(), null);
    assert.strictEqual(s.runner.loads.length, 1, 'no retry before retryMs');
    s.advance(1);
    s.host.current();
    assert.strictEqual(s.runner.loads.length, 2, 'retried');
    s.runner.loads[1].reject(new EmbedError('MODEL_UNAVAILABLE', 'still offline'));
    await flush();
    assert.strictEqual(s.notices.length, 1, 'the same failure is not shown twice');
    s.host.retry();
    assert.strictEqual(s.runner.loads.length, 3, 'Retry tries at once');
  });

  it('a model switch while loading: the old load is ignored, the new one wins', async () => {
    const s = setup();
    s.host.start();
    s.set({ model: 'Xenova/all-MiniLM-L6-v2' });
    assert.strictEqual(s.host.status().key, 'local:Xenova/all-MiniLM-L6-v2');
    assert.strictEqual(s.runner.loads.length, 2);
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    assert.strictEqual(s.host.current(), null, 'the old model finishing does not make it live');
    s.runner.loads[1].resolve({ dim: 384 });
    await flush();
    assert.strictEqual(s.host.current().name, 'local:Xenova/all-MiniLM-L6-v2');
    s.runner.loads[0].reject(new EmbedError('MODEL_UNAVAILABLE', 'late'));
    await flush();
    assert.strictEqual(s.host.status().state, 'ready', 'a late failure of the old load changes nothing');
  });

  it('the worker disabled after crashes: disabled for the session; Retry resets the runner', async () => {
    const s = setup();
    s.host.start();
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    s.runner.emit('disabled', { crashes: 3 });
    assert.strictEqual(s.host.status().state, 'disabled');
    assert.strictEqual(s.host.current(), null);
    s.advance(RETRY * 10);
    s.host.current();
    assert.strictEqual(s.runner.loads.length, 1, 'disabled is not retried on a timer');
    s.host.retry();
    assert.ok(s.runner.resets >= 1);
    assert.strictEqual(s.runner.loads.length, 2);
  });

  it('openai: built through createProvider, ready at once; a failed call reported with fail() makes it unavailable once', async () => {
    const s = setup({ kind: 'openai' });
    s.host.start();
    assert.strictEqual(s.host.status().state, 'ready');
    assert.deepStrictEqual(s.providers.map((p) => [p.kind, p.cfg.openai.model]), [['openai', 'text-embedding-3-small']]);
    assert.strictEqual(s.host.current().name, 'openai:text-embedding-3-small');
    s.host.fail(Object.assign(new Error('401 invalid key'), { status: 401 }));
    s.host.fail(Object.assign(new Error('401 invalid key'), { status: 401 }));
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.strictEqual(s.notices.length, 1);
    s.host.fail(new EmbedError('MODEL_CHANGED', 'switched'));
    assert.strictEqual(s.notices.length, 1, 'a switch race is not a failure');
  });

  it('a provider that cannot be built is unavailable with its message', () => {
    const s = setup({ kind: 'openai' });
    s.host.getSettings = () => ({ history: { embedder: { kind: 'openai' } } });
    s.host.createProvider = () => { throw new Error('No OpenAI key is saved'); };
    s.host.start();
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.match(s.host.status().error, /No OpenAI key/);
  });

  it('rerank loads the cross-encoder once and passes a deadline', async () => {
    const s = setup({ kind: 'none' });
    await assert.rejects(s.host.rerank('gate', ['a']), (err) => err.code === 'RERANK_UNAVAILABLE');
    s.host.start();
    const first = s.host.rerank('gate', ['a', 'b'], { maxMs: 500 });
    assert.deepStrictEqual(s.runner.loads.map((l) => [l.role, l.model]), [['reranker', 'Xenova/ms-marco-MiniLM-L-6-v2']]);
    s.runner.loads[0].resolve({ dim: null });
    assert.deepStrictEqual(await first, [0, 1]);
    assert.strictEqual(s.runner.lastRerank.opts.deadlineMs, 500);
    await s.host.rerank('gate', ['c']);
    assert.strictEqual(s.runner.loads.length, 1, 'loaded once');
    await s.host.stop();
    assert.strictEqual(s.runner.stopped, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-embedder-host.test.js`
Expected: FAIL with `Cannot find module '../src/history/embedder-host'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embedders/local.js`:

```js
// src/history/embedders/local.js
// The local Embedder (recall spec §5.2): texts cut and prefixed for the
// model here, embedded in the embed worker through the EmbedRunner, vectors
// made unit length. ready() loads the model (downloading it the first time).
const { embedInput, unit } = require('./vectors');
const { prefixTexts } = require('./profiles');

function createLocalEmbedder({ runner, model, modelsDir, allowDownload = true }) {
  const embedder = {
    name: `local:${model}`,
    kind: 'local',
    model,
    dim: null,
    tokens: 0,
    async ready() {
      const { dim } = await runner.load('embedder', model, { modelsDir, allowDownload });
      if (Number.isInteger(dim)) embedder.dim = dim;
    },
    async embed(texts, { kind = 'document' } = {}) {
      if (!Array.isArray(texts) || !texts.length) return [];
      const inputs = prefixTexts(model, texts.map(embedInput), kind);
      const vecs = await runner.embed(model, inputs, { priority: kind === 'query' ? 'query' : 'document' });
      const out = vecs.map(unit);
      if (embedder.dim === null && out.length) embedder.dim = out[0].length;
      return out;
    }
  };
  return embedder;
}

module.exports = { createLocalEmbedder };
```

Create `src/history/embedder-host.js`:

```js
// src/history/embedder-host.js
// Which embedder recall uses now (recall spec §5.2, §15), from
// settings.history.embedder, and its state for the settings pane, the recall
// line and provenance. Hosts (create-core) build one; nothing loads or
// downloads until start(), which create-core calls from
// startModelsBackgroundChecks (skipped under KL_TEST_MODE).
//   off          kind none, or not started
//   starting     the local model is loading
//   downloading  the local model's files are downloading (download: { loaded, total })
//   ready        embedding works
//   unavailable  the model did not load or a call failed; recall is BM25
//                only until retryMs passes, the settings change or retry()
//   disabled     the embed worker crashed three times in ten minutes; BM25
//                only for this session unless the settings change or retry()
// Each distinct failure is logged once and shown to the owner once per
// session (notify). Changing the embedder never deletes vectors: the new key
// fills in, and the old key's rows stay for a switch back. The reranker is
// always the local cross-encoder, whatever the embedder kind.
const { EventEmitter } = require('node:events');
const { mergeHistorySettings, embedderKey } = require('./settings');
const { createLocalEmbedder } = require('./embedders/local');
const { createRemoteEmbedder } = require('./embedders/remote');
const { EmbedError } = require('./embed-errors');
const { createLogger } = require('../logging');

const RETRY_MS = 10 * 60000;
const MESSAGE_MAX = 300;

class EmbedderHost extends EventEmitter {
  constructor({ getSettings, modelsDir, createRunner, createProvider, notify = () => {}, now = Date.now, retryMs = RETRY_MS, log = createLogger('history/embedder') }) {
    super();
    this.getSettings = getSettings;
    this.modelsDir = modelsDir;
    this.createRunner = createRunner;
    this.createProvider = createProvider;
    this.notify = notify;
    this.now = now;
    this.retryMs = retryMs;
    this.log = log;
    this.started = false;
    this.runner = null;
    this.key = null;
    this.kind = 'none';
    this.embedder = null;
    this.state = 'off';
    this.error = null;
    this.files = new Map();
    this.until = 0;
    this.loading = null;
    this.warned = new Set();
    this.rerankModel = null;
    this.rerankLoad = null;
  }

  _settings() {
    return mergeHistorySettings((this.getSettings() || {}).history);
  }

  start() {
    this.started = true;
    this._sync();
  }

  current() {
    this._sync();
    return this.state === 'ready' ? this.embedder : null;
  }

  status() {
    this._sync();
    const download = this.state === 'downloading' ? this._download() : null;
    return { kind: this.kind, key: this.key, state: this.state, download, error: this.error, tokens: this.embedder ? this.embedder.tokens : 0 };
  }

  // Why this turn's recall cannot use vectors although they are on
  // (provenance, the recall line); null when ready or off by choice.
  reason() {
    switch (this.state) {
      case 'ready':
      case 'off': return null;
      case 'starting':
      case 'downloading': return 'the embedding model is loading';
      case 'unavailable': return `embedding model not loaded: ${this.error}`;
      case 'disabled': return 'the embedding worker kept crashing';
      default: return null;
    }
  }

  retry() {
    this.warned.clear();
    this._switch(this.started ? embedderKey(this._settings().embedder) : null, this._settings().embedder);
  }

  // A caller's embed failed. A switch racing a call is not a failure.
  fail(err) {
    const code = err && err.code;
    if (code === 'MODEL_CHANGED') return;
    this.embedder = null;
    this.loading = null;
    this.error = String((err && err.message) || err).slice(0, MESSAGE_MAX);
    if (code === 'EMBED_DISABLED') {
      this._set('disabled');
    } else {
      this.until = this.now() + this.retryMs;
      this._set('unavailable');
    }
    const warnKey = `${this.key}\u0000${code || (err && err.status) || 'error'}`;
    if (this.warned.has(warnKey)) return;
    this.warned.add(warnKey);
    const text = `Recall uses keyword search only: ${this.error}`;
    this.log.warn(text);
    try {
      this.notify({ title: 'King Louie', body: text });
    } catch (notifyErr) {
      this.log.warn(`Recall warning could not be shown: ${notifyErr.message}`);
    }
  }

  async rerank(query, texts, { maxMs = Infinity } = {}) {
    if (!this.started) throw new EmbedError('RERANK_UNAVAILABLE', 'the reranker is not started');
    const model = this._settings().recall.rerank.model;
    const runner = this._runner();
    if (this.rerankModel !== model || !this.rerankLoad) {
      this.rerankModel = model;
      this.rerankLoad = runner.load('reranker', model, { modelsDir: this.modelsDir }).catch((err) => {
        this.rerankLoad = null;
        throw err;
      });
    }
    await this.rerankLoad;
    return runner.rerank(model, query, texts, { deadlineMs: Number.isFinite(maxMs) ? this.now() + maxMs : Infinity });
  }

  async stop() {
    this.started = false;
    if (this.runner) await this.runner.stop();
  }

  // ── internals ───────────────────────────────────────────────────────────

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', { state, key: this.key, error: this.error });
  }

  _download() {
    let loaded = 0;
    let total = 0;
    for (const f of this.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  }

  _runner() {
    if (!this.runner) {
      this.runner = this.createRunner();
      this.runner.on('progress', (p) => {
        if (p.role !== 'embedder' || !this.loading || p.model !== this.loading.model) return;
        this.files.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
        this._set('downloading');
      });
      this.runner.on('disabled', () => {
        if (this.kind === 'local') this.fail(new EmbedError('EMBED_DISABLED', 'the embedding worker crashed three times in ten minutes; local embedding is off for this session'));
      });
    }
    return this.runner;
  }

  _sync() {
    const cfg = this._settings().embedder;
    const key = this.started ? embedderKey(cfg) : null;
    if (key !== this.key) {
      this._switch(key, cfg);
      return;
    }
    if (this.state === 'unavailable' && this.now() >= this.until) this._switch(key, cfg);
  }

  _switch(key, cfg) {
    this.key = key;
    this.kind = key ? cfg.kind : 'none';
    this.embedder = null;
    this.error = null;
    this.loading = null;
    this.files = new Map();
    if (!key) {
      this._set('off');
      return;
    }
    if (cfg.kind === 'local') {
      const runner = this._runner();
      runner.reset();
      const embedder = createLocalEmbedder({ runner, model: cfg.model, modelsDir: this.modelsDir });
      const token = { model: cfg.model };
      this.loading = token;
      this._set('starting');
      embedder.ready().then(() => {
        if (this.loading !== token) return;
        this.loading = null;
        this.embedder = embedder;
        this._set('ready');
      }, (err) => {
        if (this.loading !== token) return;
        this.fail(err);
      });
      return;
    }
    try {
      const model = cfg.kind === 'openai' ? cfg.openai.model : cfg.ollama.model;
      this.embedder = createRemoteEmbedder({ kind: cfg.kind, model, provider: this.createProvider(cfg.kind, cfg) });
      this._set('ready');
    } catch (err) {
      this.fail(err);
    }
  }
}

module.exports = { EmbedderHost, RETRY_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embedder-host.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/embedders/local.js src/history/embedder-host.js tests/helpers/fake-embed-runner.js tests/history-embedder-host.test.js
git commit -m "feat(history): EmbedderHost: the live embedder, its states, one owner warning, retries, the local reranker"
```

---

## Task 8: Background embedding (`EmbedIndexer`)

**Files:**
- Create: `src/history/embed-indexer.js`
- Test: `tests/history-embed-indexer.test.js`

**Interfaces:**
- Consumes: store methods (Task 3: `pendingEmbeddings`, `putEmbeddings`, `countPending`, `countEmbedded`, `onAppend`, `vectorEpoch`, `embeddable`); `EmbedderHost#current()` and `#fail(err)` (Task 7); `WORKER_FAILURES`; `embedInput`.
- Produces: `startEmbedIndexer({ store, host, getSettings, onProgress, setTimer, clearTimer, log }) → { nudge(chatId), tick() → Promise<{ embedded, skipped }>, progress() → { key, embedded, pending }, stop() → Promise<void> }`. It subscribes to `store.onAppend` itself.

- [ ] **Step 1: Write the failing test**

Create `tests/history-embed-indexer.test.js`:

```js
// tests/history-embed-indexer.test.js
// Background embedding (recall spec §5.2): batches, the newest chat first,
// maxChunksPerToolResult, a poison chunk, a model switch mid-backfill,
// failures reported to the host. In-process embedders; manual ticks.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { startEmbedIndexer } = require('../src/history/embed-indexer');
const { unit } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');

const bow = createBagOfWordsEmbedder();
function fakeEmbedder(name = 'fake:bow', { failWhen = null, gate = null } = {}) {
  const calls = [];
  return {
    name, kind: 'fake', model: name, dim: 28, tokens: 0, calls,
    async embed(texts) {
      calls.push(texts.slice());
      if (gate) await gate;
      const err = failWhen && failWhen(texts);
      if (err) throw err;
      return (await bow.embed(texts)).map((v) => unit(v));
    }
  };
}
const crash = () => Object.assign(new Error('the embed worker exited (code 70)'), { code: 'EMBED_WORKER_CRASHED' });
const notes = (n, prefix = 'note') => Array.from({ length: n }, (_, i) => ({ sender: i % 2 ? 'assistant' : 'user', text: `${prefix} ${i} about the linen bandage and the gate code` }));

function setup({ embedder = fakeEmbedder(), history = {} } = {}) {
  const t = openTempStore();
  const failures = [];
  const timers = [];
  const host = { active: embedder, current() { return this.active; }, fail: (e) => failures.push(e) };
  const indexer = () => startEmbedIndexer({
    store: t.store, host, getSettings: () => ({ history }),
    setTimer: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {},
    log: { warn() {}, info() {}, debug() {} }
  });
  return { t, host, failures, timers, indexer };
}

describe('EmbedIndexer', () => {
  let t;
  let ix;
  afterEach(async () => { if (ix) await ix.stop(); ix = null; if (t) t.cleanup(); t = null; });

  it('embeds every chunk in batches of batchSize and reports progress', async () => {
    const s = setup({ history: { embedder: { batchSize: 8 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(20) });
    ix = s.indexer();
    for (let i = 0; i < 3; i += 1) await ix.tick();
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 20);
    assert.deepStrictEqual(ix.progress(), { key: 'fake:bow', embedded: 20, pending: 0 });
    assert.deepStrictEqual(s.host.active.calls.map((c) => c.length), [8, 8, 4]);
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
  });

  it('an append nudges it: the chat with the newest append goes first', async () => {
    const s = setup({ history: { embedder: { batchSize: 1 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(10) });
    seedChat(t.store, { id: 'chat-2', messages: [] });
    ix = s.indexer();
    s.timers.length = 0;
    t.store.appendMessage('chat-2', { id: 'n1', sender: 'user', text: 'The mummy mask is in the tomb.', timestamp: '2026-01-02T09:00:00.000Z' });
    assert.deepStrictEqual(s.timers, [0], 'scheduled at once');
    await ix.tick();
    assert.deepStrictEqual(s.host.active.calls[0], ['The mummy mask is in the tomb.']);
  });

  it('maxChunksPerToolResult: only the first n chunks of a tool result are embedded', async () => {
    const s = setup({ history: { embedder: { maxChunksPerToolResult: 2 } } });
    t = s.t;
    const long = Array.from({ length: 5 }, (_, i) => `Section ${i + 1} of the survey output. ${'drainage reading '.repeat(100)}`).join('\n\n');
    seedChat(t.store, { messages: [{ sender: 'toolResult', toolName: 'Bash', result: long }] });
    ix = s.indexer();
    await ix.tick();
    await ix.tick();
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 2);
    assert.strictEqual(ix.progress().pending, 0);
  });

  it('a chunk that crashes the worker is isolated and tombstoned; the rest are embedded; the host is not failed', async () => {
    const s = setup({ embedder: fakeEmbedder('fake:bow', { failWhen: (texts) => (texts.some((x) => x.includes('poison')) ? crash() : null) }) });
    t = s.t;
    seedChat(t.store, { messages: [...notes(3), { sender: 'user', text: 'poison text that crashes the model' }, ...notes(3, 'later')] });
    ix = s.indexer();
    const out = await ix.tick();
    assert.deepStrictEqual(out, { embedded: 6, skipped: 1 });
    assert.strictEqual(s.failures.length, 0);
    const db = readDb(t.dbPath);
    const dims = db.prepare("SELECT e.dim AS dim, c.text AS text FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.model = 'fake:bow'").all();
    db.close();
    assert.strictEqual(dims.find((r) => r.text.includes('poison')).dim, 0, 'a tombstone');
    assert.strictEqual(t.store.countPending('fake:bow'), 0, 'never retried for this key');
  });

  it('any other failure is reported to the host once and nothing is written', async () => {
    const s = setup({ embedder: fakeEmbedder('fake:bow', { failWhen: () => Object.assign(new Error('401 invalid key'), { status: 401 }) }) });
    t = s.t;
    seedChat(t.store, { messages: notes(4) });
    ix = s.indexer();
    await ix.tick();
    assert.strictEqual(s.failures.length, 1);
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 0);
  });

  it('a model switch mid-backfill: the batch in flight lands under its own key; the next tick fills the new key', async () => {
    let open;
    const gate = new Promise((r) => { open = r; });
    const a = fakeEmbedder('local:model-a', { gate });
    const s = setup({ embedder: a, history: { embedder: { batchSize: 4 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(8) });
    ix = s.indexer();
    const inFlight = ix.tick();
    await new Promise((r) => setImmediate(r));
    s.host.active = fakeEmbedder('local:model-b');
    open();
    await inFlight;
    assert.strictEqual(t.store.countEmbedded('local:model-a'), 4);
    assert.strictEqual(t.store.countEmbedded('local:model-b'), 0);
    await ix.tick();
    await ix.tick();
    assert.strictEqual(t.store.countEmbedded('local:model-b'), 8);
    assert.strictEqual(t.store.countEmbedded('local:model-a'), 4, 'the old key keeps its rows');
  });

  it('does nothing without a ready embedder, on a read-only store, or after stop()', async () => {
    const s = setup({ embedder: null });
    t = s.t;
    seedChat(t.store, { messages: notes(2) });
    ix = s.indexer();
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
    s.host.active = fakeEmbedder();
    await ix.stop();
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-embed-indexer.test.js`
Expected: FAIL with `Cannot find module '../src/history/embed-indexer'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/embed-indexer.js`:

```js
// src/history/embed-indexer.js
// Background embedding (recall spec §5.2): every intervalMs, or at once after
// an append, up to batchSize chunks with no vector for the active embedder
// key are embedded as documents and written back. The chat with the newest
// append goes first, then every other chunk by id. A key change (another
// model or kind) starts filling the new key; rows already written for the
// old key stay (a batch in flight when the key changed is written under the
// key it was embedded with). Nothing runs while the host has no ready
// embedder, on a read-only or in-memory store, or after stop().
//
// A batch the worker crashed on (WORKER_FAILURES) is retried one chunk at a
// time; a chunk that crashes it alone is written as a tombstone and never
// tried again for that key. Any other failure is reported to the host
// (host.fail), which turns vectors off until its retry.
const { mergeHistorySettings } = require('./settings');
const { embedInput } = require('./embedders/vectors');
const { WORKER_FAILURES } = require('./embed-errors');
const { createLogger } = require('../logging');

// Pending and embedded counts are recounted (a full scan) every this many
// batches, and adjusted in between.
const RECOUNT_EVERY = 50;

function startEmbedIndexer({
  store, host, getSettings, onProgress = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  log = createLogger('history/embed-indexer')
}) {
  let stopped = false;
  let timer = null;
  let running = null;
  let preferred = null;
  let epoch = store.vectorEpoch;
  let counts = null;
  let batches = 0;
  // Per key: the id-order cursor, and whether a full pass found nothing.
  const cursor = new Map();
  const idle = new Set();

  const settings = () => mergeHistorySettings((getSettings() || {}).history).embedder;
  const eligible = () => Boolean(store && store.isOpen && store.embeddable && !store.readonly && store.dbPath !== ':memory:');
  const progress = () => ({ key: counts ? counts.key : null, embedded: counts ? counts.embedded : 0, pending: counts ? counts.pending : 0 });

  async function embedRows(embedder, key, rows) {
    const vecs = await embedder.embed(rows.map((r) => embedInput(r.text)), { kind: 'document' });
    return store.putEmbeddings(key, rows.map((r, i) => ({ chunkId: r.id, vec: vecs[i] })));
  }

  // One batch, the crash isolation included. Returns counts and whether every
  // row was handled (embedded or tombstoned).
  async function embedBatch(embedder, key, rows) {
    try {
      return { embedded: await embedRows(embedder, key, rows), skipped: 0, handled: true };
    } catch (err) {
      if (!WORKER_FAILURES.has(err.code)) {
        host.fail(err);
        return { embedded: 0, skipped: 0, handled: false };
      }
    }
    let embedded = 0;
    let skipped = 0;
    for (const row of rows) {
      if (stopped) return { embedded, skipped, handled: false };
      try {
        embedded += await embedRows(embedder, key, [row]);
      } catch (err) {
        if (!WORKER_FAILURES.has(err.code)) {
          host.fail(err);
          return { embedded, skipped, handled: false };
        }
        store.putEmbeddings(key, [{ chunkId: row.id, vec: null }]);
        skipped += 1;
        log.warn('A chunk crashed the embed worker; it is skipped for this model', { chunkId: row.id, key });
      }
    }
    return { embedded, skipped, handled: true };
  }

  async function tick() {
    const none = { embedded: 0, skipped: 0 };
    if (stopped || !eligible()) return none;
    const embedder = host.current();
    if (!embedder) return none;
    const key = embedder.name;
    const cfg = settings();
    if (store.vectorEpoch !== epoch) {
      epoch = store.vectorEpoch;
      cursor.clear();
      idle.clear();
      counts = null;
    }
    if (!counts || counts.key !== key || batches % RECOUNT_EVERY === 0) {
      counts = { key, embedded: store.countEmbedded(key), pending: store.countPending(key, { maxChunksPerToolResult: cfg.maxChunksPerToolResult }) };
    }
    batches += 1;
    const opts = { limit: cfg.batchSize, maxChunksPerToolResult: cfg.maxChunksPerToolResult };
    let fromCursor = false;
    let rows = preferred !== null ? store.pendingEmbeddings(key, { ...opts, chatId: preferred }) : [];
    if (!rows.length) {
      preferred = null;
      if (idle.has(key)) return none;
      rows = store.pendingEmbeddings(key, { ...opts, afterId: cursor.get(key) || 0 });
      fromCursor = true;
      if (!rows.length) {
        // A full pass from the start that finds nothing: idle until an
        // append, a destructive change or a key change.
        if (cursor.get(key)) cursor.set(key, 0);
        else idle.add(key);
        return none;
      }
    }
    const out = await embedBatch(embedder, key, rows);
    if (fromCursor && out.handled) cursor.set(key, Math.max(cursor.get(key) || 0, ...rows.map((r) => r.id)));
    counts.embedded += out.embedded;
    counts.pending = Math.max(0, counts.pending - out.embedded - out.skipped);
    try {
      onProgress(progress());
    } catch (err) {
      log.debug(`embedding progress listener failed: ${err.message}`);
    }
    return { embedded: out.embedded, skipped: out.skipped };
  }

  const schedule = (ms) => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, ms);
  };

  function run() {
    timer = null;
    if (running || stopped) return;
    running = tick()
      .catch((err) => {
        log.warn(`Embedding stopped for this tick: ${err.message}`);
        return { embedded: 0, skipped: 0 };
      })
      .finally(() => {
        running = null;
        schedule(settings().intervalMs);
      });
  }

  const unsubscribe = typeof store.onAppend === 'function' ? store.onAppend((chatId) => api.nudge(chatId)) : () => {};

  const api = {
    nudge(chatId) {
      if (stopped) return;
      preferred = chatId === null || chatId === undefined ? null : String(chatId);
      idle.clear();
      if (!running) schedule(0);
    },
    tick,
    progress,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      unsubscribe();
      if (running) await running;
    }
  };
  schedule(0);
  return api;
}

module.exports = { startEmbedIndexer, RECOUNT_EVERY };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-embed-indexer.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/embed-indexer.js tests/history-embed-indexer.test.js
git commit -m "feat(history): background embedding: batches, newest chat first, poison-chunk isolation, key switches"
```

---

## Task 9: Vectors in memory (`VectorIndex`)

**Files:**
- Create: `src/history/vector-index.js`
- Test: `tests/history-vector-index.test.js`

**Interfaces:**
- Consumes: `store.vectorRows`, `store.vectorEpoch` (Task 3); `blobToVec`.
- Produces: `class VectorIndex`: `new VectorIndex({ store, getCapMb = () => 256, log })`; `search({ model, query: Float32Array, chatIds, kinds = null, upToSeq = null, k = 50 }) → [{ chunkId, vectorRank, cosine }]` (ranks 1-based, ties by chunk id); `vectorOf(model, chunk) → Float32Array | null` (only from a matrix already loaded; never loads); `skipped(model, chatId) → boolean` (the chat is over the cap on its own); `stats() → { chats, bytes, capBytes }`; `clear()`.

Why brute force: measured facts, "Vectors": cosine over ~17K chunks × 1536 floats took 40–60 ms per query in Node; Appendix A.3: 100K × 384 in 94 ms. At bge-small's 384 dims the 256 MB default holds about 500K chunks (≈ 400 bytes a row).

- [ ] **Step 1: Write the failing test**

Create `tests/history-vector-index.test.js`:

```js
// tests/history-vector-index.test.js
// VectorIndex (recall spec §5.3): brute-force cosine that matches a direct
// computation, filters, appends extending the matrix, reuse of chunk ids
// after a truncate, the vectorCacheMb cap (a chat too big alone, LRU).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { VectorIndex } = require('../src/history/vector-index');
const { unit, blobToVec } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

const KEY = 'fake:bow';
const bow = createBagOfWordsEmbedder();
const q = async (text) => unit((await bow.embed([text]))[0]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function embedAll(store, key = KEY) {
  for (;;) {
    const rows = store.pendingEmbeddings(key, { limit: 100 });
    if (!rows.length) return;
    const vecs = await bow.embed(rows.map((r) => r.text));
    store.putEmbeddings(key, rows.map((r, i) => ({ chunkId: r.id, vec: unit(vecs[i]) })));
  }
}

const TEXTS = [
  { sender: 'user', text: 'The linen bandage goes in the canopic jar.' },
  { sender: 'assistant', text: 'Salt and natron dry the body first.' },
  { sender: 'user', text: 'The mask and the amulet stay with the mummy.' },
  { sender: 'assistant', text: 'Linen wrapping and resin for the mummy.' },
  { sender: 'user', text: 'The gate code at the lot is 4417.' },
  { sender: 'assistant', text: 'A linen bandage for the priest.' }
];
const quietLog = (warns = []) => ({ warn: (m) => warns.push(m), info() {}, debug() {} });

describe('VectorIndex', () => {
  let t;
  afterEach(() => { if (t) t.cleanup(); t = null; });

  it('search matches a direct cosine top-k, ranks from 1', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('linen bandage');
    const hits = index.search({ model: KEY, query, chatIds: ['chat-1'], k: 3 });
    const direct = [...t.store.vectorRows(KEY, 'chat-1')]
      .map((r) => ({ id: r.chunkId, s: dot(blobToVec(r.vec), query) }))
      .sort((a, b) => b.s - a.s || a.id - b.id)
      .slice(0, 3);
    assert.deepStrictEqual(hits.map((h) => h.chunkId), direct.map((d) => d.id));
    assert.deepStrictEqual(hits.map((h) => h.vectorRank), [1, 2, 3]);
    assert.ok(Math.abs(hits[0].cosine - direct[0].s) < 1e-6);
  });

  it('holds hits to upToSeq and the kinds', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('linen bandage');
    const early = index.search({ model: KEY, query, chatIds: ['chat-1'], upToSeq: 4, k: 10 });
    const seqOf = new Map(t.store.chunksOfChat('chat-1').map((c) => [c.id, c.seq]));
    assert.ok(early.length > 0 && early.every((h) => seqOf.get(h.chunkId) < 4));
    const assistant = index.search({ model: KEY, query, chatIds: ['chat-1'], kinds: ['assistant'], k: 10 });
    const kindOf = new Map(t.store.chunksOfChat('chat-1').map((c) => [c.id, c.kind]));
    assert.ok(assistant.length > 0 && assistant.every((h) => kindOf.get(h.chunkId) === 'assistant'));
    assert.deepStrictEqual(index.search({ model: 'other:key', query, chatIds: ['chat-1'] }), []);
  });

  it('appends extend the loaded matrix without reading it again', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const reads = [];
    const original = t.store.vectorRows.bind(t.store);
    t.store.vectorRows = (model, chatId, opts) => { reads.push(opts.afterRowid); return original(model, chatId, opts); };
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('coffin tomb');
    assert.ok(index.search({ model: KEY, query, chatIds: ['chat-1'], k: 1 }).every((h) => h.cosine === 0), 'nothing about a coffin yet');
    t.store.appendMessage('chat-1', { id: 'new-1', sender: 'user', text: 'The coffin is in the tomb.', timestamp: '2026-01-02T09:00:00.000Z' });
    await embedAll(t.store);
    const [hit] = index.search({ model: KEY, query, chatIds: ['chat-1'], k: 1 });
    assert.strictEqual(t.store.chunks([hit.chunkId])[0].messageId, 'new-1');
    assert.strictEqual(reads[0], 0);
    assert.ok(reads.at(-1) > 0, 'only rows after the last one read');
  });

  it('a truncate lets a new chunk reuse an old id: the cached vector is dropped, never served stale', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS.slice(0, 3) });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    index.search({ model: KEY, query: await q('linen'), chatIds: ['chat-1'] });
    const oldId = t.store.chunksOfMessage('chat-1-m2')[0].id;
    t.store.truncateFrom('chat-1', 2);
    t.store.appendMessage('chat-1', { id: 'fresh', sender: 'user', text: 'The priest and the resin.', timestamp: '2026-01-03T09:00:00.000Z' });
    await embedAll(t.store);
    const fresh = t.store.chunksOfMessage('fresh')[0];
    assert.strictEqual(fresh.id, oldId, 'SQLite reused the id (the case this test is for)');
    const [hit] = index.search({ model: KEY, query: await q('priest resin'), chatIds: ['chat-1'], k: 1 });
    assert.strictEqual(hit.chunkId, fresh.id);
    const stored = blobToVec([...t.store.vectorRows(KEY, 'chat-1')].find((r) => r.chunkId === fresh.id).vec);
    assert.deepStrictEqual(Array.from(index.vectorOf(KEY, fresh)), Array.from(stored));
  });

  it('a chat whose vectors alone exceed vectorCacheMb is not searched by vector, with one warning; memory stays under the cap', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: Array.from({ length: 300 }, (_, i) => ({ sender: 'user', text: `linen note ${i} for the tomb` })) });
    seedChat(t.store, { id: 'small', messages: TEXTS.slice(0, 2) });
    await embedAll(t.store);
    const warns = [];
    // 300 rows × (28 × 4 + 9) bytes ≈ 36 KB, over a 0.03 MB (31 KB) cap.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.03, log: quietLog(warns) });
    const query = await q('linen');
    assert.deepStrictEqual(index.search({ model: KEY, query, chatIds: ['chat-1'] }), []);
    assert.strictEqual(index.skipped(KEY, 'chat-1'), true);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /vectorCacheMb/);
    index.search({ model: KEY, query, chatIds: ['chat-1'] });
    assert.strictEqual(warns.length, 1, 'warned once');
    assert.ok(index.search({ model: KEY, query, chatIds: ['small'] }).length > 0, 'a small chat is still searched');
    assert.ok(index.stats().bytes <= index.stats().capBytes);
  });

  it('evicts the least recently used chat to stay under the cap', async () => {
    t = openTempStore();
    for (const id of ['a', 'b', 'c']) seedChat(t.store, { id, messages: TEXTS.slice(0, 4) });
    await embedAll(t.store);
    // Each chat's matrix is 64 rows of capacity × 121 bytes ≈ 7.7 KB; 0.02 MB holds two.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.02, log: quietLog() });
    const query = await q('linen');
    index.search({ model: KEY, query, chatIds: ['a'] });
    index.search({ model: KEY, query, chatIds: ['b'] });
    index.search({ model: KEY, query, chatIds: ['a'] });
    index.search({ model: KEY, query, chatIds: ['c'] });
    assert.strictEqual(index.stats().chats, 2);
    assert.ok(index.stats().bytes <= index.stats().capBytes);
    const chunkOfB = t.store.chunksOfChat('b')[0];
    assert.strictEqual(index.vectorOf(KEY, chunkOfB), null, 'b was the least recently used');
    assert.ok(index.vectorOf(KEY, t.store.chunksOfChat('a')[0]), 'a stayed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-vector-index.test.js`
Expected: FAIL with `Cannot find module '../src/history/vector-index'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/vector-index.js`:

```js
// src/history/vector-index.js
// Vectors in memory (recall spec §5.3): one Float32Array matrix per
// (embedder key, chat), loaded from the embeddings table on first use and
// extended with the rows written since (by embeddings rowid), in an LRU
// bounded by history.recall.vectorCacheMb. Search is a brute-force dot
// product over unit vectors.
//
// A destructive store change (truncate, rewrite, delete, rebuild) bumps
// store.vectorEpoch and every cached matrix is dropped: a truncate lets a
// later chunk reuse a chunk id, and a cached row must never answer for it.
// A chat whose vectors alone would exceed the cap stops loading at the cap,
// is not cached and is not searched by vector (BM25 still covers it); the log
// says so once per chat. Other chats are evicted, least recently used first,
// before a matrix grows past the cap, so memory held here never exceeds it.
const { blobToVec } = require('./embedders/vectors');
const { createLogger } = require('../logging');

const MB = 1024 * 1024;
const MIN_ROWS = 64;
const KIND_CODES = Object.freeze({ user: 1, assistant: 2, tool_use: 3, tool_result: 4, attachment: 5, summary: 6 });
const TOO_LARGE = Symbol('too large');

// A row: the vector, its chunk id and seq (int32 each), its kind (a byte).
const rowBytes = (dim) => dim * 4 + 4 + 4 + 1;

class VectorIndex {
  constructor({ store, getCapMb = () => 256, log = createLogger('history/vectors') }) {
    this.store = store;
    this.getCapMb = getCapMb;
    this.log = log;
    this.entries = new Map();
    this.epoch = store ? store.vectorEpoch : 0;
    this.tooLarge = new Set();
    this.warned = new Set();
  }

  get bytes() {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  _cap() {
    const mb = Number(this.getCapMb());
    return (Number.isFinite(mb) && mb > 0 ? mb : 256) * MB;
  }

  _check() {
    if (this.store.vectorEpoch !== this.epoch) {
      this.clear();
      this.epoch = this.store.vectorEpoch;
    }
  }

  clear() {
    this.entries.clear();
    this.tooLarge.clear();
  }

  stats() {
    return { chats: this.entries.size, bytes: this.bytes, capBytes: this._cap() };
  }

  skipped(model, chatId) {
    return this.tooLarge.has(`${model}\u0000${chatId}`);
  }

  // Evicts least recently used matrices (never `keep`) until `extra` more
  // bytes fit under the cap.
  _makeRoom(keep, extra, cap) {
    for (const k of [...this.entries.keys()]) {
      if (this.bytes + extra <= cap) return;
      if (k !== keep) this.entries.delete(k);
    }
  }

  // The loaded (or newly loaded) matrix of one chat, or null.
  _entry(model, chatId) {
    this._check();
    const key = `${model}\u0000${chatId}`;
    if (this.tooLarge.has(key)) return null;
    let e = this.entries.get(key);
    if (e) this.entries.delete(key);
    else e = { key, dim: 0, n: 0, capacity: 0, bytes: 0, matrix: null, ids: null, seqs: null, kinds: null, rowOf: new Map(), lastRowid: 0 };
    this.entries.set(key, e);
    const cap = this._cap();
    try {
      this._extend(e, model, chatId, cap);
    } catch (err) {
      if (err !== TOO_LARGE) throw err;
      this.entries.delete(key);
      this.tooLarge.add(key);
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log.warn(`Vector search is off for chat ${chatId}: its vectors need more than history.recall.vectorCacheMb (${Math.round((cap / MB) * 100) / 100} MB). Keyword search still covers it.`);
      }
      return null;
    }
    return e.n ? e : null;
  }

  _grow(e, need, cap) {
    if (need <= e.capacity) return;
    const per = rowBytes(e.dim);
    if (need * per > cap) throw TOO_LARGE;
    const capacity = Math.min(Math.max(need, e.capacity * 2, MIN_ROWS), Math.floor(cap / per));
    this._makeRoom(e.key, capacity * per - e.bytes, cap);
    const matrix = new Float32Array(capacity * e.dim);
    const ids = new Int32Array(capacity);
    const seqs = new Int32Array(capacity);
    const kinds = new Uint8Array(capacity);
    if (e.matrix) {
      matrix.set(e.matrix.subarray(0, e.n * e.dim));
      ids.set(e.ids.subarray(0, e.n));
      seqs.set(e.seqs.subarray(0, e.n));
      kinds.set(e.kinds.subarray(0, e.n));
    }
    Object.assign(e, { matrix, ids, seqs, kinds, capacity, bytes: capacity * per });
  }

  _extend(e, model, chatId, cap) {
    for (const row of this.store.vectorRows(model, chatId, { afterRowid: e.lastRowid })) {
      e.lastRowid = Math.max(e.lastRowid, row.rowid);
      const vec = blobToVec(row.vec);
      if (!e.dim) e.dim = vec.length;
      if (vec.length !== e.dim) {
        if (!this.warned.has(`${e.key}\u0000dim`)) {
          this.warned.add(`${e.key}\u0000dim`);
          this.log.warn(`A ${vec.length}-dim vector in a ${e.dim}-dim matrix for ${model} was skipped`);
        }
        continue;
      }
      let i = e.rowOf.get(row.chunkId);
      if (i === undefined) {
        this._grow(e, e.n + 1, cap);
        i = e.n;
        e.n += 1;
        e.rowOf.set(row.chunkId, i);
      }
      e.matrix.set(vec, i * e.dim);
      e.ids[i] = row.chunkId;
      e.seqs[i] = row.seq;
      e.kinds[i] = KIND_CODES[row.kind] || 0;
    }
  }

  search({ model, query, chatIds, kinds = null, upToSeq = null, k = 50 }) {
    if (!model || !query || !query.length || !Array.isArray(chatIds)) return [];
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds.map((x) => KIND_CODES[x]).filter(Boolean)) : null;
    const limit = Number.isInteger(k) && k > 0 ? k : 50;
    // The best `limit` so far, highest cosine first, ties by chunk id.
    const top = [];
    for (const chatId of chatIds) {
      const e = this._entry(model, String(chatId));
      if (!e || e.dim !== query.length) continue;
      for (let i = 0; i < e.n; i++) {
        if (Number.isInteger(upToSeq) && !(e.seqs[i] < upToSeq)) continue;
        if (kindSet && !kindSet.has(e.kinds[i])) continue;
        let dot = 0;
        const off = i * e.dim;
        for (let d = 0; d < e.dim; d++) dot += e.matrix[off + d] * query[d];
        const id = e.ids[i];
        if (top.length === limit) {
          const last = top[top.length - 1];
          if (dot < last.cosine || (dot === last.cosine && id > last.chunkId)) continue;
        }
        let at = top.length;
        while (at > 0 && (top[at - 1].cosine < dot || (top[at - 1].cosine === dot && top[at - 1].chunkId > id))) at -= 1;
        top.splice(at, 0, { chunkId: id, cosine: dot });
        if (top.length > limit) top.pop();
      }
    }
    return top.map((t, r) => ({ chunkId: t.chunkId, vectorRank: r + 1, cosine: t.cosine }));
  }

  // A chunk's vector from a matrix already loaded (cosine dedupe); never loads.
  vectorOf(model, chunk) {
    if (!chunk || !model) return null;
    this._check();
    const e = this.entries.get(`${model}\u0000${chunk.chatId}`);
    if (!e) return null;
    const i = e.rowOf.get(chunk.id);
    return i === undefined ? null : e.matrix.subarray(i * e.dim, (i + 1) * e.dim);
  }
}

module.exports = { VectorIndex, KIND_CODES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-vector-index.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/vector-index.js tests/history-vector-index.test.js
git commit -m "feat(history): VectorIndex: per-chat float32 matrices under vectorCacheMb, brute-force cosine"
```

---

## Task 10: Vector search, fusion and the cosine dedupe in retrieval

**Files:**
- Create: `src/history/vector-search.js`
- Modify: `src/history/retriever.js` (constructor, `_rerank`, `retrieve`)
- Modify: `src/history/context-builder.js` (`build`)
- Modify: `src/history/index.js` (exports)
- Test: `tests/history-vector-search.test.js`, `tests/history-retriever.test.js`

**Interfaces:**
- Consumes: `EmbedderHost#current()`, `#reason()`, `#fail()` (Task 7); `VectorIndex#search`, `#vectorOf`, `#skipped` (Task 9); `WORKER_FAILURES`.
- Produces:
  - `QUERY_TIMEOUT_MS` (1500); `createVectorSearch({ host, index, queryTimeoutMs, setTimer, clearTimer }) → { vectorSearch, vectorOf }`. `vectorSearch({ query, chatIds, kinds, upToSeq, settings, stats })` → `[{ chunkId, vectorRank }]` and never throws; it sets `stats.embedder` (the key used, or `'none'`) and `stats.vectorsSkipped` (a reason, or `null`). `vectorOf(chunk) → Float32Array | null` for the active key.
  - `new Retriever({ store, estimator, vectorSearch, vectorOf, reranker })`; `retrieve({ …, vectorOf, stats })`: `stats` is passed to `vectorSearch`; with `recall.dedupeCosine > 0` and a vector for both chunks, a candidate whose cosine to a selected chunk exceeds it is dropped (`stats.cosineDuplicates`). `_rerank` calls `reranker(query, chunks, { maxMs })`.
  - `ContextBuilder#build({ …, vectorOf })`; `stats.embedder` is the key the turn's vectors came from (`'none'` without), `stats.vectorsSkipped` why vectors were not used (`null` when they were, or when recall did not run).

Step 7 on `main` drops exact-text duplicates before the rerank; that stays, with vectors or without: identical text has cosine 1, so it is a subset of the cosine rule, and keeping it before the rerank saves reranker pairs. The cosine rule then runs in the budget loop, like `dedupeJaccard`, against what is already selected.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-vector-search.test.js`:

```js
// tests/history-vector-search.test.js
// Spec §6.3 step 2 for the app: the query embedded as a query, cosine hits
// from the VectorIndex fused with BM25, never slowing a turn past
// QUERY_TIMEOUT_MS, and provenance saying which embedder was used or why none.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { createVectorSearch, QUERY_TIMEOUT_MS } = require('../src/history/vector-search');
const { VectorIndex } = require('../src/history/vector-index');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { unit } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const KEY = 'fake:bow';
const bow = createBagOfWordsEmbedder();
const recall = (over = {}) => mergeHistorySettings({ recall: over }).recall;
const quiet = { warn() {}, info() {}, debug() {} };

function embedder({ hang = false, fail = null } = {}) {
  const calls = [];
  return {
    name: KEY, dim: 28, tokens: 0, calls,
    async embed(texts, opts) {
      calls.push({ texts, opts });
      if (hang) return new Promise(() => {});
      if (fail) throw fail;
      return (await bow.embed(texts)).map((v) => unit(v));
    }
  };
}
function hostWith(e) {
  const failures = [];
  return { failures, current: () => e, reason: () => 'the embedding model is loading', fail: (err) => failures.push(err) };
}
async function embedAll(store) {
  const rows = store.pendingEmbeddings(KEY, { limit: 1000 });
  const vecs = await bow.embed(rows.map((r) => r.text));
  store.putEmbeddings(KEY, rows.map((r, i) => ({ chunkId: r.id, vec: unit(vecs[i]) })));
}
const MSGS = [
  { sender: 'user', text: 'The linen bandage goes in the canopic jar.' },
  { sender: 'assistant', text: 'Linen wrapping and resin for the mummy.' },
  { sender: 'user', text: 'Filler about the garden hose and the weekly list.' },
  { sender: 'assistant', text: 'More filler about the grocery list.' }
];

describe('vector search', () => {
  let t;
  afterEach(() => { if (t) t.cleanup(); t = null; });

  it('embeds the query as a query and returns ranked hits, with the key in stats', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: MSGS });
    await embedAll(t.store);
    const e = embedder();
    const { vectorSearch } = createVectorSearch({ host: hostWith(e), index: new VectorIndex({ store: t.store, log: quiet }) });
    const stats = {};
    const hits = await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall({ vectorTopK: 2 }), stats });
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map((h) => h.vectorRank), [1, 2]);
    assert.deepStrictEqual(e.calls[0], { texts: ['linen'], opts: { kind: 'query' } });
    assert.deepStrictEqual(stats, { embedder: KEY, vectorsSkipped: null });
  });

  it('no ready embedder: no hits, and stats says why', async () => {
    t = openTempStore();
    const { vectorSearch } = createVectorSearch({ host: hostWith(null), index: new VectorIndex({ store: t.store, log: quiet }) });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.deepStrictEqual(stats, { embedder: 'none', vectorsSkipped: 'the embedding model is loading' });
  });

  it('a query embedding slower than queryTimeoutMs: no hits this turn, and not a failure', async () => {
    t = openTempStore();
    const host = hostWith(embedder({ hang: true }));
    const { vectorSearch } = createVectorSearch({ host, index: new VectorIndex({ store: t.store, log: quiet }), queryTimeoutMs: 30 });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.match(stats.vectorsSkipped, /too slow/);
    assert.strictEqual(host.failures.length, 0);
    assert.strictEqual(QUERY_TIMEOUT_MS, 1500);
  });

  it('a failed query embedding is reported to the host; a worker crash is not', async () => {
    t = openTempStore();
    const failing = hostWith(embedder({ fail: Object.assign(new Error('401 invalid key'), { status: 401 }) }));
    const a = createVectorSearch({ host: failing, index: new VectorIndex({ store: t.store, log: quiet }) });
    assert.deepStrictEqual(await a.vectorSearch({ query: 'x', chatIds: ['chat-1'], settings: recall(), stats: {} }), []);
    assert.strictEqual(failing.failures.length, 1);
    const crashing = hostWith(embedder({ fail: Object.assign(new Error('exited'), { code: 'EMBED_WORKER_CRASHED' }) }));
    const b = createVectorSearch({ host: crashing, index: new VectorIndex({ store: t.store, log: quiet }) });
    await b.vectorSearch({ query: 'x', chatIds: ['chat-1'], settings: recall(), stats: {} });
    assert.strictEqual(crashing.failures.length, 0);
  });

  it('a chat over vectorCacheMb on its own: BM25 alone, and the provenance note names the cap', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: Array.from({ length: 300 }, (_, i) => ({ sender: 'user', text: `linen note ${i} for the tomb` })) });
    await embedAll(t.store);
    // As in the VectorIndex test: 300 rows × (28 × 4 + 9) bytes ≈ 36 KB, over a 0.03 MB (31 KB) cap.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.03, log: quiet });
    const { vectorSearch } = createVectorSearch({ host: hostWith(embedder()), index });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.deepStrictEqual(stats, { embedder: KEY, vectorsSkipped: 'this chat has more vectors than history.recall.vectorCacheMb holds' });

    const estimator = new TokenEstimator();
    const builder = new ContextBuilder({
      store: t.store, retriever: new Retriever({ store: t.store, estimator, vectorSearch }), estimator,
      getSettings: () => ({ history: { recall: { tailUserTurns: 1 } } }), now: () => BASE_TIME
    });
    const out = await builder.build({ chatId: 'chat-1', message: 'linen' });
    assert.match(out.stats.vectorsSkipped, /vectorCacheMb/);
    assert.ok(out.recalled.chunkIds.length > 0, 'BM25 still recalls');
  });

  it('fused with BM25, the vector list recalls a chunk below the BM25 cut; the builder records the key', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: MSGS });
    await embedAll(t.store);
    const estimator = new TokenEstimator();
    const { vectorSearch, vectorOf } = createVectorSearch({ host: hostWith(embedder()), index: new VectorIndex({ store: t.store, log: quiet }) });
    const retriever = new Retriever({ store: t.store, estimator, vectorSearch, vectorOf });
    const lexical = new Retriever({ store: t.store, estimator });
    // Equal kind weights, so the ranks alone decide the order.
    const settings = recall({ bm25TopK: 1, recencyWeight: 0, kindWeights: { user: 1, assistant: 1 } });
    const bm25 = await lexical.retrieve({ query: 'linen', chatIds: ['chat-1'], settings, now: BASE_TIME });
    const fused = await retriever.retrieve({ query: 'linen', chatIds: ['chat-1'], settings, now: BASE_TIME });
    assert.strictEqual(bm25.length, 1);
    assert.deepStrictEqual(new Set(fused.slice(0, 2).map((h) => h.chunk.messageId)), new Set(['chat-1-m1', 'chat-1-m2']));
    assert.ok(fused.some((h) => h.signals.bm25Rank === null && h.signals.vectorRank !== null), 'a vector-only hit');

    const builder = new ContextBuilder({ store: t.store, retriever, estimator, getSettings: () => ({ history: { recall: { tailUserTurns: 1 } } }), now: () => BASE_TIME });
    const out = await builder.build({ chatId: 'chat-1', message: 'linen' });
    assert.strictEqual(out.stats.embedder, KEY);
    assert.strictEqual(out.stats.vectorsSkipped, null);
    const plain = new ContextBuilder({ store: t.store, retriever: lexical, estimator, getSettings: () => ({}), now: () => BASE_TIME });
    assert.strictEqual((await plain.build({ chatId: 'chat-1', message: 'linen' })).stats.embedder, 'none');
  });
});
```

Append to `tests/history-retriever.test.js`:

```js
describe('Retriever: cosine dedupe (spec §6.3 step 7)', () => {
  const { unit } = require('../src/history/embedders/vectors');
  const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
  const bowEmbedder = createBagOfWordsEmbedder();
  let t;
  afterEach(() => t && t.cleanup());
  const msgs = [
    { sender: 'user', text: 'The side gate code at the Lakeside lot is 4417.' },
    { sender: 'user', text: 'Again: the gate code for the Lakeside lot is 4417.' },
    { sender: 'user', text: 'The fence along the lot is forty meters.' }
  ];
  async function vectorsOf(store) {
    const map = new Map();
    for (const c of store.chunksOfChat('chat-1')) map.set(c.id, unit((await bowEmbedder.embed([c.text]))[0]));
    return (chunk) => map.get(chunk.id) || null;
  }
  const has = (hits, id) => hits.some((h) => h.chunk.messageId === id);

  it('drops a near-duplicate by cosine when both have vectors', async () => {
    const s = setup(msgs);
    t = s.t;
    const vectorOf = await vectorsOf(t.store);
    const stats = {};
    const hits = await s.retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME, vectorOf, stats });
    assert.notStrictEqual(has(hits, 'chat-1-m1'), has(hits, 'chat-1-m2'), 'one of the two gate-code notes is kept');
    assert.ok(has(hits, 'chat-1-m3'), 'the fence note is not a duplicate');
    assert.strictEqual(stats.cosineDuplicates, 1);
  });

  it('keeps both at dedupeCosine 0, without vectors, or when a chunk has no vector', async () => {
    const s = setup(msgs);
    t = s.t;
    const vectorOf = await vectorsOf(t.store);
    const run = (over) => s.retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], now: BASE_TIME, settings: recall({ recencyWeight: 0 }), ...over });
    for (const hits of [
      await run({ vectorOf, settings: recall({ recencyWeight: 0, dedupeCosine: 0 }) }),
      await run({}),
      await run({ vectorOf: () => null })
    ]) {
      assert.ok(has(hits, 'chat-1-m1') && has(hits, 'chat-1-m2'));
    }
  });

  it('uses the constructor\'s vectorOf when the call gives none', async () => {
    const s = setup(msgs);
    t = s.t;
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), vectorOf: await vectorsOf(t.store) });
    const hits = await retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME });
    assert.notStrictEqual(has(hits, 'chat-1-m1'), has(hits, 'chat-1-m2'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/history-vector-search.test.js tests/history-retriever.test.js`
Expected: FAIL with `Cannot find module '../src/history/vector-search'` and both gate-code notes recalled in the cosine test.

- [ ] **Step 3: Write the implementation**

Create `src/history/vector-search.js`:

```js
// src/history/vector-search.js
// Spec §6.3 step 2 for the app: the turn's query embedded (kind 'query') by
// the host's embedder, then cosine top vectorTopK over the chats in scope
// from the VectorIndex. It never slows a turn by more than queryTimeoutMs
// and never throws: with no ready embedder, a slow or failed query embedding,
// or a chat over the vector cache cap, the turn runs on BM25 alone and stats
// says why (provenance, the recall line). A query that failed for a reason
// other than the worker crashing is reported to the host (host.fail).
const { WORKER_FAILURES } = require('./embed-errors');

// A query waits at most one document slice in the worker (EmbedRunner's
// DOC_SLICE, about 0.8 s at bge-small's measured 102 ms a chunk) plus its
// own embedding.
const QUERY_TIMEOUT_MS = 1500;
const TIMED_OUT = Symbol('query embedding timed out');

function createVectorSearch({ host, index, queryTimeoutMs = QUERY_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  async function vectorSearch({ query, chatIds, kinds = null, upToSeq = null, settings, stats = null }) {
    const note = (reason) => {
      if (stats) {
        stats.embedder = 'none';
        stats.vectorsSkipped = reason;
      }
      return [];
    };
    const embedder = host.current();
    if (!embedder) return note(host.reason());
    let timer = null;
    let vecs;
    try {
      vecs = await Promise.race([
        embedder.embed([String(query)], { kind: 'query' }),
        new Promise((resolve) => { timer = setTimer(resolve, queryTimeoutMs, TIMED_OUT); })
      ]);
    } catch (err) {
      if (!WORKER_FAILURES.has(err.code) && err.code !== 'MODEL_CHANGED') host.fail(err);
      return note(`the query could not be embedded (${err.message})`);
    } finally {
      clearTimer(timer);
    }
    if (vecs === TIMED_OUT) return note('the query embedding was too slow this turn');
    const hits = index.search({ model: embedder.name, query: vecs[0], chatIds, kinds, upToSeq, k: settings.vectorTopK });
    const over = (chatIds || []).some((id) => index.skipped(embedder.name, id));
    if (stats) {
      stats.embedder = embedder.name;
      stats.vectorsSkipped = over ? 'this chat has more vectors than history.recall.vectorCacheMb holds' : null;
    }
    return hits;
  }

  // Only from matrices already loaded, for the active key.
  const vectorOf = (chunk) => {
    const e = host.current();
    return e ? index.vectorOf(e.name, chunk) : null;
  };

  return { vectorSearch, vectorOf };
}

module.exports = { createVectorSearch, QUERY_TIMEOUT_MS };
```

In `src/history/retriever.js`:

- Header comment: replace the last two sentences ("H3 adds the embedder … stays the same.") with: `H3 supplies vectorSearch (vector-search.js), vectorOf for the cosine dedupe and the cross-encoder reranker (reranker.js); the signature of retrieve() stays the same.`
- Constructor:

```js
  // vectorSearch (optional): async ({ query, chatIds, kinds, upToSeq,
  // settings, stats }) => [{ chunkId, vectorRank }], ranks 1-based.
  // vectorOf (optional): (chunk) => its unit vector or null, for the cosine
  // dedupe (step 7 with vectors).
  // reranker (optional): async (query, chunks, { maxMs }) => scores, one
  // finite number per chunk, higher is more relevant. Used only when
  // rerank.enabled.
  constructor({ store, estimator, vectorSearch = null, vectorOf = null, reranker = null }) {
    this.store = store;
    this.estimator = estimator;
    this.vectorSearch = typeof vectorSearch === 'function' ? vectorSearch : null;
    this.vectorOf = typeof vectorOf === 'function' ? vectorOf : null;
    this.reranker = typeof reranker === 'function' ? reranker : null;
  }
```

- In `_rerank`, change the call to `Promise.resolve().then(() => reranker(query, head.map((item) => item.chunk), { maxMs }))`.
- `retrieve` signature: add `vectorOf = null` after `reranker = null`.
- Change the `vectorSearch` call to `vectors = await this.vectorSearch({ query, chatIds, kinds, upToSeq, settings: s, stats });`.
- Replace the step 7 comment above the exact-text filter with:

```js
    // Step 7, first half: drop exact text duplicates. It runs before step 6
    // so the reranker never spends a pair on a duplicate (a duplicate would
    // get the same score, so the selection is the same). With vectors, the
    // cosine half (dedupeCosine) runs in the budget loop below; identical
    // text has cosine 1, so this half is part of that rule too.
```

- After the `nearDuplicate` definition, add:

```js
    // Step 7 with vectors (dedupeCosine > 0): a candidate whose cosine to a
    // selected chunk exceeds it is dropped. Only chunks with a vector take
    // part; one without is kept (exact-text dedupe covered it above).
    const vecOf = typeof vectorOf === 'function' ? vectorOf : this.vectorOf;
    const cosineAt = s.dedupeCosine > 0 && vecOf ? s.dedupeCosine : 0;
    const selectedVecs = [];
    const vecCache = new Map();
    const vectorFor = (chunk) => {
      if (!vecCache.has(chunk.id)) {
        let v = null;
        try {
          v = vecOf(chunk);
        } catch {
          v = null;
        }
        vecCache.set(chunk.id, v && v.length ? v : null);
      }
      return vecCache.get(chunk.id);
    };
    const cosineDuplicate = (chunk) => {
      if (!cosineAt) return false;
      const v = vectorFor(chunk);
      if (!v) return false;
      return selectedVecs.some((o) => {
        if (o.length !== v.length) return false;
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += o[i] * v[i];
        return dot > cosineAt;
      });
    };
    let cosineDuplicates = 0;
```

- Replace `remember` with:

```js
    const remember = (chunk) => {
      if (jaccard) selectedShingles.push(shinglesOf(chunk));
      if (cosineAt) {
        const v = vectorFor(chunk);
        if (v) selectedVecs.push(v);
      }
    };
```

(`remember` is defined above `nearDuplicate` on `main`; move it below the new block, since it now reads `cosineAt`.)

- In `consider`, in the whole-message branch after the `if (nearDuplicate(item.chunk)) { … return; }` block, and again in the chunk branch after its `nearDuplicate` block, add:

```js
        if (cosineDuplicate(item.chunk)) {
          dropped.add(item.chunk.id);
          cosineDuplicates += 1;
          return;
        }
```

(in the chunk branch the indentation is one level less).

- In the `stats` block at the end add `stats.cosineDuplicates = cosineDuplicates;`.

In `src/history/context-builder.js` `build`:

- Signature: `async build({ chatId, message = '', model = null, upToSeq = null, vectorHits = null, lexical = true, reranker = null, vectorOf = null } = {})`.
- Before `let recalled = …` add `const retrieval = {};`, pass `vectorOf` and `stats: retrieval` in the `this.retriever.retrieve({ … })` call.
- In the returned `stats`, replace `embedder: 'none',` with:

```js
        // The embedder key this turn's vectors came from, and why there were
        // none (spec §7; the recall line reads both).
        embedder: retrieval.embedder || 'none',
        vectorsSkipped: retrieval.vectorsSkipped ?? null,
```

In `src/history/index.js`, add `const { createVectorSearch } = require('./vector-search');`, `const { VectorIndex } = require('./vector-index');`, `const { EmbedderHost } = require('./embedder-host');`, `const { EmbedRunner } = require('./embed-runner');`, `const { startEmbedIndexer } = require('./embed-indexer');` and export the five names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-vector-search.test.js tests/history-retriever.test.js tests/history-context-builder.test.js tests/longhaul-embed.test.js tests/longhaul-rerank.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/vector-search.js src/history/retriever.js src/history/context-builder.js src/history/index.js tests/history-vector-search.test.js tests/history-retriever.test.js
git commit -m "feat(history): vector search fused with BM25, cosine dedupe, and the embedder in provenance"
```

---

## Task 11: The cross-encoder behind `SearchHistory` (and the per-turn opt-in)

**Files:**
- Create: `src/history/reranker.js`
- Modify: `src/history/search.js` (`searchHistoryExcerpts`)
- Modify: `src/tools/builtin/history-tools.js` (`SearchHistory` passes `h.reranker`)
- Modify: `src/history/retriever.js` (`_rerank`: an unavailable reranker is a silent no-rerank)
- Test: `tests/history-search-rerank.test.js`

**Interfaces:**
- Consumes: `EmbedderHost#rerank(query, texts, { maxMs })` (Task 7, throws `RERANK_UNAVAILABLE` before `start()`); `Retriever` reranker callback with `{ maxMs }` (Task 10); `recall.rerank.{ search, searchMaxMs }` (Task 1).
- Produces: `createHostReranker(host) → (query, chunks, { maxMs }) → Promise<number[]>`; `searchHistoryExcerpts({ …, reranker = null })`: with a reranker and `rerank.search`, the retrieval runs step 6 with `topM` and `maxMs = searchMaxMs`; `context.history.reranker` is read by `SearchHistory` (Task 12 sets it). `Retriever#_rerank`: a reranker that throws `code: 'RERANK_UNAVAILABLE'` keeps the fused order with one debug line per `Retriever`, never a warning.

Why the silent case: `rerank.search` defaults to true and Task 12 always gives the core's retriever and `SearchHistory` the host's reranker, but the host starts only from the background checks, so under `KL_TEST_MODE`, in the e2e suite and before startup finishes every `SearchHistory` call would otherwise log "reranker failed". A reranker that is there and fails still warns.

Why only here by default: measured facts, "Rerank": topM 100 costs about 2.25 s per question uncached on the owner's laptop, too slow for every turn; `SearchHistory` is a turn where the model is already waiting on a tool. `rerank.enabled` keeps the per-turn opt-in with the existing `maxMs` (2,000) guard; at topM 100 on a laptop CPU it will often fall back to the fused order, and the settings pane says so.

- [ ] **Step 1: Write the failing test**

Create `tests/history-search-rerank.test.js`:

```js
// tests/history-search-rerank.test.js
// Step 6 behind SearchHistory (recall spec §6.3, §8): the reranker reorders
// the search under rerank.searchMaxMs; off with rerank.search false; a
// failing reranker keeps the fused order; per turn only with rerank.enabled.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { searchHistoryExcerpts } = require('../src/history/search');
const { createHostReranker } = require('../src/history/reranker');
const { searchHistoryTool } = require('../src/tools/builtin/history-tools');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { addSink } = require('../src/logging');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const recall = (over = {}) => mergeHistorySettings({ recall: over }).recall;
const NOTES = [
  { sender: 'user', text: 'The side gate code is 4417.' },
  { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
  { sender: 'user', text: 'The gate hinge needs oil.' }
];
const preferDock = (calls) => async (query, chunks, opts) => {
  calls.push({ query, n: chunks.length, opts });
  return chunks.map((c) => (c.text.includes('dock') ? 10 : 0));
};

describe('SearchHistory rerank', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const setup = () => {
    t = openTempStore();
    seedChat(t.store, { messages: NOTES });
    return new Retriever({ store: t.store, estimator: new TokenEstimator() });
  };

  it('reranks with the cross-encoder under searchMaxMs when rerank.search is on', async () => {
    const retriever = setup();
    const calls = [];
    const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: preferDock(calls), asOf: BASE_TIME });
    assert.ok(out[0].text.includes('dock'));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.maxMs, 6000);
  });

  it('rerank.search false: the fused order, the reranker never called', async () => {
    const retriever = setup();
    const calls = [];
    const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall({ rerank: { search: false } }), reranker: preferDock(calls), asOf: BASE_TIME });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(out.length, 3);
  });

  it('a reranker that throws keeps the fused order', async () => {
    const retriever = setup();
    const plain = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), asOf: BASE_TIME });
    const failing = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: async () => { throw new Error('model gone'); }, asOf: BASE_TIME });
    assert.deepStrictEqual(failing.map((e) => e.seq), plain.map((e) => e.seq));
  });

  it('a reranker that is not started yet (RERANK_UNAVAILABLE) keeps the fused order without a warning', async () => {
    const retriever = setup();
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.line); });
    try {
      const plain = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), asOf: BASE_TIME });
      const notStarted = createHostReranker({ rerank: async () => { throw Object.assign(new Error('the reranker is not started'), { code: 'RERANK_UNAVAILABLE' }); } });
      for (let i = 0; i < 2; i += 1) {
        const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: notStarted, asOf: BASE_TIME });
        assert.deepStrictEqual(out.map((e) => e.seq), plain.map((e) => e.seq));
      }
    } finally {
      remove();
    }
    assert.deepStrictEqual(warnings.filter((l) => l.includes('history/retriever')), []);
  });

  it('the SearchHistory tool passes the chat\'s reranker', async () => {
    const retriever = setup();
    const calls = [];
    const history = { chatId: 'chat-1', store: t.store, retriever, estimator: new TokenEstimator(), getSettings: () => ({}), reranker: preferDock(calls) };
    const out = await searchHistoryTool.execute({ query: 'gate' }, { history });
    assert.strictEqual(out.ok, true);
    assert.ok(out.excerpts[0].text.includes('dock'));
    assert.strictEqual(calls.length, 1);
  });

  it('per turn: only with rerank.enabled, under rerank.maxMs', async () => {
    t = openTempStore();
    // Four newer user turns fill a four-turn tail, so the notes are
    // recallable. The tail is pinned here, so Task 16 may change the default.
    seedChat(t.store, { messages: [...NOTES, ...Array.from({ length: 4 }, (_, i) => ({ sender: 'user', text: `filler ${i}` }))] });
    const calls = [];
    const estimator = new TokenEstimator();
    const retriever = new Retriever({ store: t.store, estimator, reranker: preferDock(calls) });
    let history = { recall: { tailUserTurns: 4 } };
    const builder = new ContextBuilder({ store: t.store, retriever, estimator, getSettings: () => ({ history }), now: () => BASE_TIME });
    await builder.build({ chatId: 'chat-1', message: 'gate' });
    assert.strictEqual(calls.length, 0, 'off by default');
    history = { recall: { tailUserTurns: 4, rerank: { enabled: true } } };
    await builder.build({ chatId: 'chat-1', message: 'gate' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.maxMs, 2000);
  });

  it('createHostReranker sends the chunk texts and the budget to the host', async () => {
    const seen = [];
    const rr = createHostReranker({ rerank: async (query, texts, opts) => { seen.push({ query, texts, opts }); return texts.map(() => 1); } });
    assert.deepStrictEqual(await rr('gate', [{ text: 'a' }, { text: 'b' }], { maxMs: 50 }), [1, 1]);
    assert.deepStrictEqual(seen, [{ query: 'gate', texts: ['a', 'b'], opts: { maxMs: 50 } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/history-search-rerank.test.js`
Expected: FAIL with `Cannot find module '../src/history/reranker'`.

- [ ] **Step 3: Write the implementation**

Create `src/history/reranker.js`:

```js
// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
function createHostReranker(host) {
  return (query, chunks, { maxMs } = {}) => host.rerank(String(query), chunks.map((c) => String(c.text)), { maxMs });
}

module.exports = { createHostReranker };
```

In `src/history/search.js`, replace `searchHistoryExcerpts` with:

```js
// SearchHistory reranks (spec §6.3 step 6, §6.7): the model is waiting on
// the tool anyway, so the cross-encoder's ~2 s at topM 100 is affordable
// here, under rerank.searchMaxMs, where it is not per turn. rerank.search
// false, or no reranker, leaves the fused order (or the per-turn opt-in).
async function searchHistoryExcerpts({ store, retriever, chatId, query, kinds = null, limit = 10, settings, asOf = Date.now(), reranker = null }) {
  const rr = settings && settings.rerank ? settings.rerank : null;
  const useRerank = Boolean(reranker && rr && rr.search);
  const s = useRerank ? { ...settings, rerank: { ...rr, enabled: true, maxMs: rr.searchMaxMs } } : settings;
  const hits = await retriever.retrieve({
    query, chatIds: [chatId], kinds, budgetTokens: null, settings: s, now: asOf, reranker: useRerank ? reranker : null
  });
  const chunks = hits.map((h) => h.chunk);
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, order: 'given' }).slice(0, limit);
}
```

In `src/tools/builtin/history-tools.js`, in `SearchHistory`'s `searchHistoryExcerpts({ … })` call, add `reranker: typeof h.reranker === 'function' ? h.reranker : null,` after `settings: settingsOf(h).recall`.

In `src/history/retriever.js`, in `_rerank`, replace the `catch` block

```js
    } catch (err) {
      log.warn('reranker failed; keeping the fused order', { error: err.message, pairs: m });
      return items;
```

with:

```js
    } catch (err) {
      // No reranker yet (the EmbedderHost starts with the background checks:
      // never under KL_TEST_MODE, not before startup finishes): the fused
      // order, silently, with one debug line per Retriever.
      if (err && err.code === 'RERANK_UNAVAILABLE') {
        if (!this._rerankUnavailableLogged) {
          this._rerankUnavailableLogged = true;
          log.debug('no reranker yet; keeping the fused order', { pairs: m });
        }
        return items;
      }
      log.warn('reranker failed; keeping the fused order', { error: err.message, pairs: m });
      return items;
```

(The retriever compares the code as a string and does not require `embed-errors.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-search-rerank.test.js tests/history-search.test.js tests/history-tools.test.js tests/history-ipc.test.js tests/history-retriever.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/reranker.js src/history/search.js src/history/retriever.js src/tools/builtin/history-tools.js tests/history-search-rerank.test.js
git commit -m "feat(history): rerank SearchHistory with the local cross-encoder; per-turn rerank stays opt-in"
```

---

## Task 12: Wiring in the core, provenance, and the history IPC for the embedder

**Files:**
- Modify: `src/core/create-core.js` (after the H2 recall block around line 318; `start()` around line 3023; `shutdown()` around line 3084; `startModelsBackgroundChecks` around line 1095; the tool context's `get history()` around line 2155; the `context` object around line 3229)
- Modify: `src/ipc/chat-handlers.js:665` (provenance)
- Modify: `src/ipc/history-handlers.js`, `src/ipc/constants.js`
- Test: `tests/history-core-embeddings.test.js`, `tests/history-ipc.test.js`

**Interfaces:**
- Consumes: `EmbedderHost`, `EmbedRunner`, `startEmbedIndexer`, `VectorIndex`, `createVectorSearch`, `createHostReranker` (Tasks 6–11); `deps.history.createEmbedRunner` (tests inject `FakeEmbedRunner`); `deps.uiToastChannel`.
- Produces:
  - `core.context`: `getEmbedderHost()`, `getVectorIndex()`, `getEmbedIndexer()`, `getHistoryReranker()`, `startHistoryEmbedding()`; the tool context's `history` gains `reranker`.
  - `startModelsBackgroundChecks()` also calls `startHistoryEmbedding()` (after its `KL_TEST_MODE` return, so tests and e2e never load a model).
  - Provenance (`context` on an assistant reply) gains `vectorsSkipped`.
  - IPC: `IPC.HISTORY_EMBEDDER_STATUS` (`history:embedder.status`) → `{ ok, untrustedText: true, status, progress, settings: { embedder, rerank: { enabled, search } } }`; `IPC.HISTORY_EMBEDDER_SAVE` (`history:embedder.save`, payload `{ embedder: { kind, model, ollama: { baseUrl, model }, openai: { model } }, rerank: { enabled, search } }`) → the status payload, or `{ ok: false, error }` for a value the settings merge would replace; `IPC.HISTORY_EMBEDDER_REBUILD` (`history:embedder.rebuild`) deletes the active key's vectors → `{ ok, removed, … }`; `IPC.HISTORY_EMBEDDER_RETRY` (`history:embedder.retry`). The `history` domain is already proxied when attached (`src/desktop-bridge/allowlist.js`), so these reach the service.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-core-embeddings.test.js`:

```js
// tests/history-core-embeddings.test.js
// The core with embeddings (recall spec §3, §5.2, §7): nothing loads until
// startHistoryEmbedding, KL_TEST_MODE never starts it, chunks get vectors in
// the background, a turn records the embedder, SearchHistory gets the
// reranker, shutdown stops the worker. An in-process fake runner; no model.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const KEY = 'local:Xenova/bge-small-en-v1.5';
const tempDirs = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps(runner) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-embed-'));
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
    history: { createEmbedRunner: () => runner }
  };
}

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function seed(ctx) {
  ctx.createChat({ id: 'c1', title: 'Lakeside lot', messages: [] });
  ctx.appendMessageToChat('c1', 'user', 'The linen bandage goes in the canopic jar.');
  ctx.appendMessageToChat('c1', 'assistant', 'Noted, the linen goes in the jar.');
  ctx.appendMessageToChat('c1', 'user', 'Where does the linen go?');
}

describe('createCore with embeddings', () => {
  it('embeds after startHistoryEmbedding, records the embedder on a turn, and stops the worker on shutdown', async () => {
    const runner = new FakeEmbedRunner();
    const core = createCore(makeDeps(runner));
    await core.start();
    const ctx = core.context;
    seed(ctx);
    const before = await ctx.getContextBuilder().build({ chatId: 'c1', message: 'linen', upToSeq: 3 });
    assert.strictEqual(before.stats.embedder, 'none');
    assert.strictEqual(before.stats.vectorsSkipped, null, 'not started is not a degradation');
    assert.strictEqual(runner.calls.length, 0, 'nothing loads before startHistoryEmbedding');

    ctx.startHistoryEmbedding();
    await waitFor(() => ctx.getEmbedderHost().status().state === 'ready');
    const store = ctx.getHistoryStore();
    for (let i = 0; i < 5 && store.countPending(KEY) > 0; i += 1) await ctx.getEmbedIndexer().tick();
    assert.strictEqual(store.countPending(KEY), 0);
    assert.ok(store.countEmbedded(KEY) >= 3);

    const after = await ctx.getContextBuilder().build({ chatId: 'c1', message: 'linen', upToSeq: 3 });
    assert.strictEqual(after.stats.embedder, KEY);
    assert.strictEqual(after.stats.vectorsSkipped, null);
    assert.ok(runner.calls.some((c) => c.op === 'embed' && c.priority === 'query'), 'the query went at query priority');

    const scores = await ctx.getHistoryReranker()('linen', [{ text: 'the tomb' }, { text: 'a linen bandage' }], { maxMs: 1000 });
    assert.ok(scores[1] > scores[0]);

    await core.shutdown();
    assert.strictEqual(runner.stopped, true);
  });

  it('KL_TEST_MODE: startBackgroundChecks never starts the embedder', async () => {
    const runner = new FakeEmbedRunner();
    const core = createCore(makeDeps(runner));
    const saved = process.env.KL_TEST_MODE;
    process.env.KL_TEST_MODE = '1';
    try {
      await core.start();
      await core.models.startBackgroundChecks();
      assert.strictEqual(core.context.getEmbedderHost().status().state, 'off');
      assert.strictEqual(runner.calls.length, 0);
    } finally {
      if (saved === undefined) delete process.env.KL_TEST_MODE;
      else process.env.KL_TEST_MODE = saved;
      await core.shutdown();
    }
  });

  it('the send path copies vectorsSkipped into provenance', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'chat-handlers.js'), 'utf8');
    assert.match(src, /vectorsSkipped: built\.stats\.vectorsSkipped \?\? null/);
  });
});
```

Append to `tests/history-ipc.test.js`:

```js
describe('history IPC: the embedder', () => {
  const { EventEmitter } = require('node:events');
  const { mergeHistorySettings } = require('../src/history/settings');
  let t;
  let settings;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const host = Object.assign(new EventEmitter(), {
    retried: 0,
    status: () => ({ kind: 'local', key: 'local:Xenova/bge-small-en-v1.5', state: 'ready', download: null, error: null, tokens: 0 }),
    retry() { this.retried += 1; }
  });
  before(() => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings('local:Xenova/bge-small-en-v1.5', { limit: 1 });
    t.store.putEmbeddings('local:Xenova/bge-small-en-v1.5', [{ chunkId: row.id, vec: Float32Array.from([1, 0]) }]);
    settings = { history: mergeHistorySettings({}) };
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      getHistoryStore: () => t.store,
      getEmbedderHost: () => host,
      getEmbedIndexer: () => ({ progress: () => ({ key: 'local:Xenova/bge-small-en-v1.5', embedded: 1, pending: 0 }) }),
      getSettings: () => settings,
      setSettings: (s) => { settings = s; }
    });
  });
  after(() => t.cleanup());

  it('status: the host state, the progress and the settings the pane shows', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_STATUS, {});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.strictEqual(out.status.state, 'ready');
    assert.deepStrictEqual(out.progress, { key: 'local:Xenova/bge-small-en-v1.5', embedded: 1, pending: 0 });
    assert.strictEqual(out.settings.embedder.kind, 'local');
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true });
  });

  it('save: merges the embedder and rerank choices; refuses a value the merge would replace', async () => {
    const ok = await call(IPC.HISTORY_EMBEDDER_SAVE, { embedder: { kind: 'ollama', ollama: { baseUrl: 'http://192.0.2.10:11434/' } }, rerank: { enabled: true } });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(settings.history.embedder.kind, 'ollama');
    assert.strictEqual(settings.history.embedder.ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(settings.history.recall.rerank.enabled, true);
    assert.strictEqual(settings.history.recall.tailTokens, 6000, 'other keys kept');
    const bad = await call(IPC.HISTORY_EMBEDDER_SAVE, { embedder: { model: '../escape' } });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /model/);
    assert.strictEqual(settings.history.embedder.model, 'Xenova/bge-small-en-v1.5', 'nothing saved');
  });

  it('rebuild deletes the active key\'s vectors; retry asks the host', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_REBUILD, {});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.removed, 1);
    assert.strictEqual(t.store.countEmbedded('local:Xenova/bge-small-en-v1.5'), 0);
    await call(IPC.HISTORY_EMBEDDER_RETRY, {});
    assert.strictEqual(host.retried, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/history-core-embeddings.test.js tests/history-ipc.test.js`
Expected: FAIL: `ctx.startHistoryEmbedding is not a function`; `IPC.HISTORY_EMBEDDER_STATUS` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/core/create-core.js`:

- Extend the history require (line 66) with `EmbedderHost, EmbedRunner, VectorIndex, createVectorSearch` and add `const { startEmbedIndexer } = require('../history/embed-indexer');` and `const { createHostReranker } = require('../history/reranker');` next to the backfill require.
- Replace the H2 block from `// Recall stage H2 (spec 2026-09-25 §6): token estimates, …` through the `contextBuilder` construction with:

```js
  // Recall stage H2 (spec 2026-09-25 §6): token estimates, BM25 retrieval
  // and the per-turn context builder, all over the history store.
  // Stage H3 (§5.2, §5.3, §6.3): embeddings. The EmbedderHost picks the
  // embedder from settings.history.embedder; the local one runs in the embed
  // worker (EmbedRunner, a child process). Nothing loads or downloads until
  // startHistoryEmbedding(), which startModelsBackgroundChecks calls (main.js
  // and runService; skipped under KL_TEST_MODE); until then recall is BM25
  // only. Model files live in <dataDir>/models.
  const tokenEstimator = new TokenEstimator({ store: historyStore });
  const embedderHost = new EmbedderHost({
    getSettings: () => getSettings(),
    modelsDir: path.join(paths.dataDir, 'models'),
    createRunner: typeof deps.history?.createEmbedRunner === 'function' ? deps.history.createEmbedRunner : () => new EmbedRunner(),
    // Declared further down; called only once the host has started.
    createProvider: (kind, cfg) => (kind === 'openai'
      ? createProviderInstance('openai', getDecryptedProviderToken('openai'))
      : ProviderFactory.createProvider('ollama', null, { catalog, serverUrl: cfg.ollama.baseUrl })),
    notify: (toast) => {
      if (!deps.uiToastChannel || typeof deps.uiToastChannel.send !== 'function') return;
      Promise.resolve()
        .then(() => deps.uiToastChannel.send(toast))
        .catch((err) => historyLog.warn(`Recall warning toast failed: ${err.message}`));
    }
  });
  const vectorIndex = new VectorIndex({
    store: historyStore,
    getCapMb: () => ((getSettings().history || {}).recall || {}).vectorCacheMb
  });
  const { vectorSearch, vectorOf } = createVectorSearch({ host: embedderHost, index: vectorIndex });
  const historyReranker = createHostReranker(embedderHost);
  const historyRetriever = new Retriever({ store: historyStore, estimator: tokenEstimator, vectorSearch, vectorOf, reranker: historyReranker });
  const contextBuilder = new ContextBuilder({
    store: historyStore,
    retriever: historyRetriever,
    estimator: tokenEstimator,
    // getSettings is declared further down; it is read only when a turn runs.
    getSettings: () => getSettings()
  });
  let embedIndexer = null;
  const startHistoryEmbedding = () => {
    if (historyStatus.available) embedderHost.start();
  };
```

(`getSettings` is a `const` declared at line 379, after this block; the closures above only run after `createCore` returns, as H2's `getSettings: () => getSettings()` already does.)

- In `startModelsBackgroundChecks`, right after the `if (process.env.KL_TEST_MODE) { … return { skipped: true }; }` block, add:

```js
    // Recall stage H3: the embedder (and a first model download) starts with
    // the other background checks, never under KL_TEST_MODE.
    startHistoryEmbedding();
```

- In `start()`, after the `startChunkBackfill` line, add:

```js
    // Recall stage H3: chunks get vectors in the background once the
    // embedder is ready (startHistoryEmbedding). Read-only and in-memory
    // stores never embed.
    if (historyStatus.available && !embedIndexer) embedIndexer = startEmbedIndexer({ store: historyStore, host: embedderHost, getSettings });
```

- In `shutdown()`, replace `if (historyBackfill) historyBackfill.stop();` with:

```js
    if (historyBackfill) historyBackfill.stop();
    if (embedIndexer) {
      await withTimeout(embedIndexer.stop(), shutdownTimeoutMs, 'Embedding shutdown', warnTimeout)
        .catch((err) => log.warn(`Embedding shutdown failed: ${err.message}`));
    }
    await withTimeout(embedderHost.stop(), shutdownTimeoutMs, 'Embed worker shutdown', warnTimeout)
      .catch((err) => log.warn(`Embed worker shutdown failed: ${err.message}`));
```

- In the tool context's `get history()`, add `reranker: historyReranker,` to the returned object.
- In the `context` object, after `getHistoryBackfill,` add:

```js
    getEmbedderHost: () => embedderHost,
    getVectorIndex: () => vectorIndex,
    getEmbedIndexer: () => embedIndexer,
    getHistoryReranker: () => historyReranker,
    startHistoryEmbedding,
```

In `src/ipc/chat-handlers.js`, in `turnContext`, after `embedder: built.stats.embedder,` add `vectorsSkipped: built.stats.vectorsSkipped ?? null,`.

In `src/ipc/constants.js`, after `HISTORY_SEARCH: 'history:search',` add:

```js
  // Recall stage H3: the embedder's state, choice, rebuild and retry.
  HISTORY_EMBEDDER_STATUS: 'history:embedder.status',
  HISTORY_EMBEDDER_SAVE: 'history:embedder.save',
  HISTORY_EMBEDDER_REBUILD: 'history:embedder.rebuild',
  HISTORY_EMBEDDER_RETRY: 'history:embedder.retry',
```

In `src/ipc/history-handlers.js`, update the header comment (add "and the embedder's state, choice, rebuild and retry (§5.2, §14)"), and inside `registerHistoryHandlers` after the `HISTORY_SEARCH` handler add:

```js
  // The embedder (recall spec §5.2, §14). Host strings (an error, a model
  // id) are shown with textContent.
  const OFF = Object.freeze({ kind: 'none', key: null, state: 'off', download: null, error: null, tokens: 0 });
  const hostOf = () => (typeof context.getEmbedderHost === 'function' ? context.getEmbedderHost() : null);
  const settingsNow = () => ((typeof context.getSettings === 'function' && context.getSettings()) || {});
  const pick = (o, keys) => {
    const out = {};
    if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const embedderView = () => {
    const host = hostOf();
    const indexer = typeof context.getEmbedIndexer === 'function' ? context.getEmbedIndexer() : null;
    const history = mergeHistorySettings(settingsNow().history);
    return {
      ok: true,
      untrustedText: true,
      status: host ? host.status() : { ...OFF },
      progress: indexer ? indexer.progress() : null,
      settings: { embedder: history.embedder, rerank: { enabled: history.recall.rerank.enabled, search: history.recall.rerank.search } }
    };
  };

  handle(IPC.HISTORY_EMBEDDER_STATUS, async () => embedderView());

  handle(IPC.HISTORY_EMBEDDER_SAVE, async ({ embedder, rerank }) => {
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
      recall: { ...current.recall, rerank: { ...current.recall.rerank, ...pick(rerank, ['enabled', 'search']) } }
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
      ['SearchHistory rerank', wanted.recall.rerank.search, next.recall.rerank.search]
    ];
    const refused = checks.find(([, given, kept]) => given !== kept);
    if (refused) return { ok: false, error: `Not a valid ${refused[0]}: ${JSON.stringify(refused[1])}` };
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
    if (!host) return { ok: false, error: 'Embeddings are not available in this host.' };
    host.retry();
    return embedderView();
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/history-core-embeddings.test.js tests/history-ipc.test.js tests/history-core.test.js tests/desktop-bridge-allowlist.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

Then: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-recall.test.js`
Expected: PASS (e2e sets `KL_TEST_MODE`, so the embedder stays off and the recall line reads as in H2).

- [ ] **Step 5: Commit**

```bash
git add src/core/create-core.js src/ipc/chat-handlers.js src/ipc/history-handlers.js src/ipc/constants.js tests/history-core-embeddings.test.js tests/history-ipc.test.js
git commit -m "feat(history): wire embeddings into the core: host, indexer, vector search, reranker, IPC, provenance"
```

---

## Task 13: The "History and recall" settings pane and the recall line

**Files:**
- Modify: `index.html` (nav option and tab after Memory)
- Modify: `renderer.js` (`recallLineText`, `switchSettingsTab`, new pane functions)
- Modify: `preload.js` (`history` object)
- Test: `tests/renderer-history-settings.test.js`, `tests/renderer-history-text.test.js`

**Interfaces:**
- Consumes: the four IPC channels of Task 12; provenance `embedder` and `vectorsSkipped`.
- Produces: `window.electron.history.embedderStatus()`, `saveEmbedder(payload)`, `rebuildEmbeddings()`, `retryEmbedder()`; renderer `historyEmbedderStatusText(status, progress) → string`, `recallVia(context) → 'BM25' | 'BM25 + vectors' | 'BM25 only: <reason>'`.

Minimal on purpose: the embedder choice, SearchHistory rerank, and the status line up front; model ids, the Ollama address and the per-turn rerank behind an "Advanced" disclosure. Weights and top-k stay in the settings file for now (spec §14 puts them behind "advanced" too; the pane can grow when someone needs them).

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer-history-settings.test.js`:

```js
// tests/renderer-history-settings.test.js
// Static checks on the History and recall pane (recall spec §14) and the
// recall line's retrieval word (§7): wording per state, text set with
// textContent only, the channels in preload, the controls in index.html.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: History and recall pane', () => {
  it('says what each state means', () => {
    const f = new Function(`${block('function historyEmbedderStatusText(', '\nfunction stopHistoryStatusPoll(')}; return historyEmbedderStatusText;`)();
    assert.strictEqual(f({ state: 'off' }), 'Off: recall uses keyword search only.');
    assert.strictEqual(f({ state: 'starting' }), 'Loading the embedding model…');
    assert.strictEqual(f({ state: 'downloading', download: { loaded: 25, total: 100 } }), 'Downloading the embedding model: 25%');
    assert.strictEqual(f({ state: 'ready' }, { embedded: 30, pending: 10 }), 'Ready. Embedding the history: 75% (10 chunks to go)');
    assert.strictEqual(f({ state: 'ready' }, { embedded: 40, pending: 0 }), 'Ready. All history is embedded.');
    assert.strictEqual(f({ state: 'unavailable', error: 'fetch failed' }), 'Not available, keyword search only: fetch failed');
    assert.strictEqual(f({ state: 'disabled', error: 'the embedding worker kept crashing' }), 'Stopped for this session, keyword search only: the embedding worker kept crashing');
  });

  it('sets text with textContent only, and opens with the tab', () => {
    const pane = block('function historyEmbedderStatusText(', '\nfunction wireHistorySettings(');
    assert.doesNotMatch(pane, /innerHTML/);
    assert.match(pane, /textContent/);
    assert.match(block('function switchSettingsTab(', '\nfunction sortSettingsNavOptions('), /tabName === 'history'/);
  });

  it('index.html has the tab and its controls', () => {
    assert.match(html, /<option value="history">History and recall<\/option>/);
    assert.match(html, /data-tab="history"/);
    for (const id of ['history-embedder-kind', 'history-rerank-search', 'history-embedder-model', 'history-ollama-url', 'history-ollama-model',
      'history-openai-model', 'history-rerank-turn', 'history-embedder-save-btn', 'history-embedder-retry-btn', 'history-embedder-rebuild-btn', 'history-embedder-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /sends chat text to OpenAI/);
  });

  it('preload exposes the four embedder channels', () => {
    for (const ch of ['history:embedder.status', 'history:embedder.save', 'history:embedder.rebuild', 'history:embedder.retry']) {
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${ch.replace('.', '\\.')}'`), ch);
    }
  });
});
```

In `tests/renderer-history-text.test.js`, add to the first test (after its existing assertions):

```js
    const { recallLineText: line } = new Function(`${fns}; return { recallLineText };`)();
    const base = { recalledExcerpts: 2, estTokens: { recalled: 900 }, fullHistoryEstTokens: 5000 };
    assert.match(line({ ...base, embedder: 'local:Xenova/bge-small-en-v1.5' }), / · BM25 \+ vectors$/);
    assert.match(line({ ...base, embedder: 'none', vectorsSkipped: 'embedding model not loaded: fetch failed' }), / · BM25 only: embedding model not loaded: fetch failed$/);
    assert.match(line({ ...base, embedder: 'none', vectorsSkipped: null }), / · BM25$/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/renderer-history-settings.test.js tests/renderer-history-text.test.js`
Expected: FAIL: `found function historyEmbedderStatusText(` and the recall line has no "vectors".

- [ ] **Step 3: Write the implementation**

In `index.html`, add after `<option value="memory">Memory</option>`:

```html
          <option value="history">History and recall</option>
```

and after the Memory tab's closing `</div>` (the `<!-- Tab: Memory -->` block):

```html
        <!-- Tab: History and recall -->
        <div class="settings-tab-content" data-tab="history">
          <section class="template-variables-card">
            <h3>History and recall</h3>
            <p>Each reply sees the recent messages plus excerpts found in the whole chat. Embeddings let recall find excerpts by meaning as well as by the words used.</p>
            <div class="template-variables-grid">
              <label for="history-embedder-kind">Embeddings</label>
              <select id="history-embedder-kind" class="provider-input">
                <option value="local">On this computer (downloads a small model once)</option>
                <option value="ollama">Ollama</option>
                <option value="openai">OpenAI (sends chat text to OpenAI)</option>
                <option value="none">Off (keyword search only)</option>
              </select>

              <label for="history-rerank-search">Rerank SearchHistory results</label>
              <input id="history-rerank-search" type="checkbox">
            </div>
            <details class="history-advanced">
              <summary>Advanced</summary>
              <div class="template-variables-grid">
                <label for="history-embedder-model">Local model</label>
                <input id="history-embedder-model" class="provider-input" type="text" spellcheck="false">

                <label for="history-ollama-url">Ollama address</label>
                <input id="history-ollama-url" class="provider-input" type="text" spellcheck="false">

                <label for="history-ollama-model">Ollama model</label>
                <input id="history-ollama-model" class="provider-input" type="text" spellcheck="false">

                <label for="history-openai-model">OpenAI model</label>
                <input id="history-openai-model" class="provider-input" type="text" spellcheck="false">

                <label for="history-rerank-turn">Rerank every turn (about 2 s a turn on a laptop CPU)</label>
                <input id="history-rerank-turn" type="checkbox">
              </div>
            </details>
            <div class="template-variables-actions">
              <button id="history-embedder-save-btn" type="button" class="btn btn-primary">Save</button>
              <button id="history-embedder-retry-btn" type="button" class="btn">Retry</button>
              <button id="history-embedder-rebuild-btn" type="button" class="btn btn-danger">Rebuild embeddings</button>
              <span id="history-embedder-status" class="provider-message">Loading…</span>
            </div>
          </section>
        </div>
```

In `preload.js`, in the `history: { … }` object, add a comma after `search`'s closing brace (the `}` after `return ipcRenderer.invoke('history:search', payload);`, line 937 on `main`: `search` is the object's last member today), then add after it:

```js
      embedderStatus: () => ipcRenderer.invoke('history:embedder.status'),
      saveEmbedder: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('history:embedder.save', payload);
      },
      rebuildEmbeddings: () => ipcRenderer.invoke('history:embedder.rebuild'),
      retryEmbedder: () => ipcRenderer.invoke('history:embedder.retry')
```

In `renderer.js`, replace `recallLineText` with:

```js
// Which retrieval a reply's recall ran (provenance embedder, vectorsSkipped).
function recallVia(context) {
  if (context?.embedder && context.embedder !== 'none') return 'BM25 + vectors';
  return context?.vectorsSkipped ? `BM25 only: ${context.vectorsSkipped}` : 'BM25';
}

function recallLineText(context) {
  const count = Number(context?.recalledExcerpts) || 0;
  const recalled = Number(context?.estTokens?.recalled) || 0;
  const full = Number(context?.fullHistoryEstTokens) || 0;
  return `recalled ${count} ${count === 1 ? 'excerpt' : 'excerpts'} · about ${formatCompactTokens(recalled)} tokens · from ${formatCompactTokens(full)} tokens of history · ${recallVia(context)}`;
}
```

In `switchSettingsTab`, at the end of the function add:

```js
  // History and recall: its status is read while the pane is open.
  if (tabName === 'history' && typeof loadHistorySettings === 'function') {
    loadHistorySettings().catch((err) => settingsLog.warn(`loading history settings failed: ${err.message}`));
  } else if (typeof stopHistoryStatusPoll === 'function') {
    stopHistoryStatusPoll();
  }
```

Add after `sortSettingsNavOptions` (these functions must stay in this order; the tests slice between them):

```js
// History and recall (recall spec §14): the embedder choice and its status.
// Everything shown comes from the host and is set with textContent.
let historyStatusTimer = null;

function historyEmbedderStatusText(status, progress) {
  const s = status || {};
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.floor((a / b) * 100)) : 0);
  switch (s.state) {
    case 'off': return 'Off: recall uses keyword search only.';
    case 'starting': return 'Loading the embedding model…';
    case 'downloading': return s.download && s.download.total > 0
      ? `Downloading the embedding model: ${pct(s.download.loaded, s.download.total)}%`
      : 'Downloading the embedding model…';
    case 'ready': {
      const embedded = Number(progress?.embedded) || 0;
      const pending = Number(progress?.pending) || 0;
      return pending > 0
        ? `Ready. Embedding the history: ${pct(embedded, embedded + pending)}% (${pending} chunks to go)`
        : 'Ready. All history is embedded.';
    }
    case 'unavailable': return `Not available, keyword search only: ${s.error || 'unknown error'}`;
    case 'disabled': return `Stopped for this session, keyword search only: ${s.error || 'the embedding worker kept crashing'}`;
    default: return '';
  }
}

function stopHistoryStatusPoll() {
  if (historyStatusTimer) clearInterval(historyStatusTimer);
  historyStatusTimer = null;
}

async function refreshHistoryEmbedderStatus() {
  const el = document.getElementById('history-embedder-status');
  if (!el || !window.electron?.history?.embedderStatus) return null;
  const out = await window.electron.history.embedderStatus();
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Could not read the embedding status: ${(out && out.error) || 'unknown error'}`;
  return out;
}

async function loadHistorySettings() {
  const out = await refreshHistoryEmbedderStatus();
  if (out && out.ok && out.settings) {
    const e = out.settings.embedder;
    document.getElementById('history-embedder-kind').value = e.kind;
    document.getElementById('history-embedder-model').value = e.model;
    document.getElementById('history-ollama-url').value = e.ollama.baseUrl;
    document.getElementById('history-ollama-model').value = e.ollama.model;
    document.getElementById('history-openai-model').value = e.openai.model;
    document.getElementById('history-rerank-search').checked = Boolean(out.settings.rerank.search);
    document.getElementById('history-rerank-turn').checked = Boolean(out.settings.rerank.enabled);
  }
  stopHistoryStatusPoll();
  historyStatusTimer = setInterval(() => { refreshHistoryEmbedderStatus().catch(() => {}); }, 2000);
}

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
      enabled: document.getElementById('history-rerank-turn').checked
    }
  });
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Not saved: ${(out && out.error) || 'unknown error'}`;
}

function wireHistorySettings() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', () => {
    fn().catch((err) => settingsLog.warn(`history settings: ${err.message}`));
  });
  on('history-embedder-save-btn', saveHistorySettings);
  on('history-embedder-retry-btn', async () => {
    await window.electron.history.retryEmbedder();
    await refreshHistoryEmbedderStatus();
  });
  on('history-embedder-rebuild-btn', async () => {
    if (!window.confirm('Delete this model\'s embeddings and embed the whole history again? Recall uses keyword search until it catches up.')) return;
    await window.electron.history.rebuildEmbeddings();
    await refreshHistoryEmbedderStatus();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHistorySettings);
else wireHistorySettings();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/renderer-history-settings.test.js tests/renderer-history-text.test.js tests/renderer-history-lazy.test.js`
Expected: PASS, `# fail 0`.

Then look at it: `unset ELECTRON_RUN_AS_NODE && npm start`, open Settings → History and recall on a fresh `--user-data-dir` (the `run` skill's Playwright pattern works too): the status line reads "Off: recall uses keyword search only." until the background checks start the embedder, then "Loading…"/"Downloading…" and "Ready". (That launch downloads the default model once into the temp profile.)

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js preload.js tests/renderer-history-settings.test.js tests/renderer-history-text.test.js
git commit -m "feat(history): History and recall settings pane; the recall line says BM25 or BM25 + vectors"
```

---

## Task 14: Packaging the local model runtime, and checking the packaged path

**Files:**
- Modify: `package.json` (`dependencies`, `build.asarUnpack`, `build.win/mac/linux.files`)
- Create: `scripts/check-embed-worker.js`
- Test: `tests/history-packaging.test.js`

**Interfaces:**
- Consumes: `EmbedRunner` (Task 6), `COMPLETE_MARKER` (Task 5), `HISTORY_DEFAULTS` (Task 1).
- Produces: `@huggingface/transformers` 4.3.0 and `onnxruntime-node` 1.30.0 as exact dependencies; `onnxruntime-node` unpacked from the asar; each platform's build without the other platforms' onnxruntime binaries; `scripts/check-embed-worker.js [--app <binary> --resources <dir>] [--keep]`, a manual check that is not part of `npm test`.

The packaged question: in a packaged app the worker is the app binary run with `ELECTRON_RUN_AS_NODE=1` (Electron's own Node, 24.14 in Electron 41), like the PDF worker. `onnxruntime-node` ships N-API prebuilt binaries, which are ABI-stable across Node and Electron, so no rebuild is needed; a `.node` file cannot load from inside an asar, so it must be unpacked (Electron redirects the `require` to `app.asar.unpacked`). Nothing here proves it works on a platform until the packaged check runs there: this task runs it on Windows x64 and records macOS and Linux as a residual, as the ingest stage did for its PDF worker.

- [ ] **Step 1: Install and look at what arrived**

Run: `npm install --save-exact @huggingface/transformers@4.3.0 onnxruntime-node@1.30.0`
Then: `ls node_modules/onnxruntime-node/bin` and `ls node_modules/onnxruntime-node/bin/*`
Expected: one `napi-v<N>` folder holding `win32`, `linux` and `darwin` folders. If the layout differs, use the real folder names in the globs of Step 3 and the test.
Then: `npm ls sharp`
Expected: either empty or `sharp@…` under `@huggingface/transformers`. If present, Step 3 also unpacks it.

- [ ] **Step 2: Write the failing test**

Create `tests/history-packaging.test.js`:

```js
// tests/history-packaging.test.js
// The local model runtime ships with the app (recall spec §12 package.json
// row): exact versions, onnxruntime-node unpacked from the asar (a .node file
// cannot load from inside it), each platform without the others' binaries,
// and no build pattern that would drop src/models (the model catalog).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ORT = 'node_modules/onnxruntime-node/bin/napi-v*';

describe('packaging the local model runtime', () => {
  it('pins @huggingface/transformers and onnxruntime-node', () => {
    assert.strictEqual(pkg.dependencies['@huggingface/transformers'], '4.3.0');
    assert.strictEqual(pkg.dependencies['onnxruntime-node'], '1.30.0');
  });

  it('unpacks onnxruntime-node (and sharp when transformers brought it)', () => {
    assert.ok(pkg.build.asarUnpack.includes('node_modules/onnxruntime-node/**'));
    if (fs.existsSync(path.join(root, 'node_modules', 'sharp'))) {
      assert.ok(pkg.build.asarUnpack.includes('node_modules/sharp/**'));
      assert.ok(pkg.build.asarUnpack.includes('node_modules/@img/**'));
    }
  });

  it('each platform build leaves out the other platforms\' onnxruntime binaries', () => {
    for (const [platform, others] of [['win', ['linux', 'darwin']], ['mac', ['win32', 'linux']], ['linux', ['win32', 'darwin']]]) {
      for (const other of others) assert.ok((pkg.build[platform].files || []).includes(`!${ORT}/${other}/**`), `${platform} drops ${other}`);
    }
  });

  it('never excludes a models folder: src/models is the model catalog, and model files live in the data dir', () => {
    const all = [...pkg.build.files, ...['win', 'mac', 'linux'].flatMap((p) => pkg.build[p].files || [])];
    assert.deepStrictEqual(all.filter((p) => p.startsWith('!') && /(^|\/)models(\/|$)/.test(p.replace(/^!/, ''))), []);
  });

  it('the runtime resolves from the app root, where the worker requires it', () => {
    assert.ok(require.resolve('@huggingface/transformers', { paths: [root] }));
    assert.ok(require.resolve('onnxruntime-node', { paths: [root] }));
  });
});
```

Run: `node --test tests/history-packaging.test.js`
Expected: FAIL on `asarUnpack` and the platform `files` (the dependencies test passes after Step 1).

- [ ] **Step 3: Write the configuration and the check script**

In `package.json`, `build.asarUnpack` becomes:

```json
    "asarUnpack": [
      "examples/playbooks/**",
      "node_modules/onnxruntime-node/**"
    ],
```

(append `"node_modules/sharp/**"` and `"node_modules/@img/**"` if Step 1 found sharp), and each platform block gains a `files` list (electron-builder adds a platform's `files` patterns to the top-level list):

```json
    "win": {
      "target": ["nsis"],
      "files": ["!node_modules/onnxruntime-node/bin/napi-v*/linux/**", "!node_modules/onnxruntime-node/bin/napi-v*/darwin/**"]
    },
    "mac": {
      "target": ["dmg", "zip"],
      "hardenedRuntime": true,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "notarize": true,
      "files": ["!node_modules/onnxruntime-node/bin/napi-v*/win32/**", "!node_modules/onnxruntime-node/bin/napi-v*/linux/**"]
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Utility",
      "files": ["!node_modules/onnxruntime-node/bin/napi-v*/win32/**", "!node_modules/onnxruntime-node/bin/napi-v*/darwin/**"]
    }
```

Create `scripts/check-embed-worker.js`:

```js
#!/usr/bin/env node
// scripts/check-embed-worker.js
// Manual check for recall stage H3 (not part of npm test; needs the network
// once): runs the embed worker the way King Louie does, loads the default
// local embedding model and the cross-encoder into a temp models folder,
// embeds and reranks one example, then loads the model again with downloads
// off (the offline path) and prints the model folder's files.
//   node scripts/check-embed-worker.js
//   node scripts/check-embed-worker.js --app "<King Louie binary>" --resources "<its resources folder>"
// With --app, the worker is <resources>/app.asar/src/history/embed-worker.js
// run by the app binary with ELECTRON_RUN_AS_NODE=1: the packaged path.
// --keep leaves the temp models folder in place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('node:util');
const { EmbedRunner } = require('../src/history/embed-runner');
const { HISTORY_DEFAULTS } = require('../src/history/settings');
const { COMPLETE_MARKER } = require('../src/history/embedders/local-backend');

async function main() {
  const { values } = parseArgs({ options: { app: { type: 'string' }, resources: { type: 'string' }, keep: { type: 'boolean' } } });
  if (values.app && !values.resources) throw new Error('--app needs --resources');
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-check-models-'));
  const runnerOpts = values.app
    ? { execPath: values.app, workerPath: path.join(values.resources, 'app.asar', 'src', 'history', 'embed-worker.js') }
    : {};
  const model = HISTORY_DEFAULTS.embedder.model;
  const reranker = HISTORY_DEFAULTS.recall.rerank.model;
  const runner = new EmbedRunner(runnerOpts);
  runner.on('progress', (p) => {
    if (p.total) process.stdout.write(`  ${p.model} ${p.file} ${Math.floor((p.loaded / p.total) * 100)}%   \r`);
  });
  let code = 0;
  try {
    let t0 = Date.now();
    const { dim } = await runner.load('embedder', model, { modelsDir });
    process.stdout.write(`\nloaded ${model} (dim ${dim}) in ${Date.now() - t0} ms\n`);
    t0 = Date.now();
    const [v] = await runner.embed(model, ['The side gate code at the Lakeside lot is 4417.']);
    process.stdout.write(`embedded one sentence in ${Date.now() - t0} ms: ${v.length} dims\n`);
    await runner.load('reranker', reranker, { modelsDir });
    const scores = await runner.rerank(reranker, 'gate code', ['The side gate code is 4417.', 'The fence is forty meters.']);
    process.stdout.write(`rerank scores ${scores.map((s) => s.toFixed(2)).join(', ')} (the first should be higher)\n`);
    const dir = path.join(modelsDir, ...model.split('/'));
    process.stdout.write(`completion marker: ${fs.existsSync(path.join(dir, COMPLETE_MARKER)) ? 'present' : 'MISSING'}\n`);
    process.stdout.write(`files: ${fs.readdirSync(dir, { recursive: true }).join(', ')}\n`);
    await runner.stop();
    const offline = new EmbedRunner(runnerOpts);
    try {
      await offline.load('embedder', model, { modelsDir, allowDownload: false });
      await offline.embed(model, ['offline check']);
      process.stdout.write('offline load from the models folder: ok\n');
    } finally {
      await offline.stop();
    }
  } catch (err) {
    process.stderr.write(`FAILED: ${err.code || ''} ${err.message}\n`);
    code = 1;
  } finally {
    await runner.stop();
    if (!values.keep) fs.rmSync(modelsDir, { recursive: true, force: true });
  }
  return code;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
});
```

- [ ] **Step 4: Run the tests, then the real runtime in this checkout**

Run: `node --test tests/history-packaging.test.js tests/longhaul-boundary.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

Run (network, about 120 MB of models, once): `node scripts/check-embed-worker.js`
Expected: `loaded Xenova/bge-small-en-v1.5 (dim 384)`, an embed time, two rerank scores with the first higher, `completion marker: present`, a file list that includes `onnx/model_quantized.onnx` (proof that transformers.js caches under `<modelsDir>/<org>/<name>/`, the folder the marker and the partial-download cleanup assume; if the files sit elsewhere, fix `modelDir` in `local-backend.js` to that layout and its test before going on), and `offline load from the models folder: ok`.

- [ ] **Step 5: Check the packaged path on Windows x64**

Run: `npm run build:win`
Then: `node scripts/check-embed-worker.js --app "dist/win-unpacked/King Louie.exe" --resources dist/win-unpacked/resources`
Expected: the same output as Step 4. If the worker ends at once, the error carries the quick-exit hint: check that `dist/win-unpacked/resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v*/win32/x64/onnxruntime_binding.node` exists, and that `package.json` sets no `electronFuses` (the RunAsNode fuse must stay on, as for the PDF worker).

Add to `CLAUDE.md`'s History section (Task 16 writes the rest of the H3 text):

```markdown
- The local embedder and the cross-encoder run in the embed worker, a child
  process of `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (like the PDF
  worker), so they need Electron's RunAsNode fuse left on and
  `onnxruntime-node` unpacked from the asar (`build.asarUnpack`).
  `node scripts/check-embed-worker.js [--app <binary> --resources <dir>]`
  checks a checkout or a packaged build (it downloads the models once). Only
  the Windows x64 package has been checked; macOS and Linux are a residual.
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/check-embed-worker.js tests/history-packaging.test.js CLAUDE.md
git commit -m "build(history): ship @huggingface/transformers and onnxruntime-node, unpacked, per-platform binaries; packaged worker check"
```

---

## Task 15: LongHaul on the app's local embedder and reranker

**Files:**
- Modify: `src/longhaul/embeddings.js` (`validateModelName`, `cacheDir`, `createEmbedClient`, `embedChunks`, `embedderFromEnv`, new `localEmbedderFor`, `localModelsDir`)
- Modify: `src/longhaul/rerank.js` (drop `loadCrossEncoder`, add `createRunnerScorer`)
- Modify: `src/longhaul/commands/embed.js`; `src/longhaul/commands/run.js` (only if B3 Task 12 left out a piece of `--embed-provider`)
- Modify: `src/longhaul/adapters/kl-recall-vec.js`, `src/longhaul/adapters/kl-recall-rerank.js`
- Modify: `src/longhaul/run.js` as B3 Task 11 rewrote it (`scoreOne`, `runBenchmark`), `src/longhaul/scoring.js` as B3 Task 9 left it (`summarize`, `renderSummaryMarkdown`)
- Test: `tests/longhaul-local-embed.test.js`; update `tests/longhaul-rerank.test.js`

This task runs after B3 Tasks 1–16 (the execution order in the header). Every edit below is anchored on B3's text, not on `main`'s.

**Interfaces:**
- Consumes: `EmbedRunner` (Task 6, `idleUnref`), `prefixTexts` (Task 4), `ContextBuilder#build({ vectorOf })` (Task 10), `recall.rerank.topM` default 100 (Task 1). From B3: `runBenchmark` → `runEvidenceOnly(run)` / `runAnswerStage(run, answer)` and `scoreOne` (its Task 11), the `run` command's `'embed-provider'` option and `vec` object (its Task 12), `summarize` / `renderSummaryMarkdown(config, summary, { spend, comparisons })` (its Task 9), and `makePrivate(root, sessionId)` in `tests/helpers/longhaul-helpers.js` (its Task 11).
- Produces:
  - `validateModelName` accepts `org/name` (one slash, no dot-only segment); `cacheDir` maps `/` to `__` (`Xenova__bge-small-en-v1.5`), `:` to `_` as before, so existing OpenAI caches keep their folders.
  - `createEmbedClient(...).embed(inputs, { kind })`; `embedChunks` embeds as `document`; questions are embedded as `query`.
  - `embedderFromEnv({ provider: 'local', runner, modelsDir })` → `localEmbedderFor({ runner, modelsDir })`; `localModelsDir(privateRoot)` → `<privateRoot>/models`.
  - `longhaul embed --provider local --model <org/name>`: nothing leaves the machine, so no `--send-private` and no `--max-usd`; prints `local, no cost`.
  - `longhaul run … --embed-provider local`: `kl-recall-vec(-only)` and `kl-recall-vec-rerank` embed questions with the app's local embedder, from the same `LONGHAUL_HOME/private/embeddings/` cache; `kl-recall-vec` passes `vectorOf` from its cache, so the cosine dedupe is measured.
  - `createRunnerScorer({ runner, model, modelsDir }) → { model, score(query, texts) }`; `kl-recall-rerank` uses it (the app's cross-encoder in the worker) unless a `scorer` is injected; its `topM` default is the app's (100).
  - Adapters may have `close()`; `runBenchmark` awaits every adapter's `close()` in a `finally` around both stages (`runEvidenceOnly` and `runAnswerStage`, the answer stage's deferred adapters included), so a run that throws, refuses or stops at `--dry-run` still stops the embed workers it started.
  - Each record has `tailEmpty` (null for adapters without a tail); `summary[adapter].emptyTail`; `summary.md` gets an "Empty tail" line.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-local-embed.test.js`:

```js
// tests/longhaul-local-embed.test.js
// LongHaul on the app's local embedder and reranker (recall stage H3): model
// ids with a slash, `embed --provider local` without --send-private,
// kl-recall-vec with --embed-provider local, the runner-backed scorer, the
// empty-tail count, and adapters closed after every run (B3's run.js). The
// fake backend in a real worker; never a model.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedRunner } = require('../src/history/embed-runner');
const embedCommand = require('../src/longhaul/commands/embed');
const { main } = require('../src/longhaul/cli');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter } = require('../src/longhaul/adapters');
const { EmbeddingCache, cacheDir, validateModelName } = require('../src/longhaul/embeddings');
const { createRunnerScorer } = require('../src/longhaul/rerank');
const { runBenchmark } = require('../src/longhaul/run');
const { createFakeModels } = require('../src/longhaul/fake-models');
const { loadPrompt } = require('../src/longhaul/prompts');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink, makePrivate } = require('./helpers/longhaul-helpers');

const BACKEND = require.resolve('./helpers/fake-embed-backend');
const MODELS = path.join(os.tmpdir(), 'kl-embed-models-unused');
const SESSION = 'synth-small';
const MODEL = 'Xenova/bge-small-en-v1.5';
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'longhaul');
const runners = [];
after(async () => { while (runners.length) await runners.pop().stop(); });
const runner = () => { const r = new EmbedRunner({ testBackend: BACKEND }); runners.push(r); return r; };

function setupHome() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return { env, home };
}
const ctxFor = (home, env) => ({ home, env, stdout: sink(), stderr: sink(), now: () => new Date(), cwd: process.cwd() });

describe('LongHaul with the local embedder', () => {
  it('model ids may be org/name; the cache folder maps the slash', () => {
    assert.strictEqual(validateModelName(MODEL), MODEL);
    assert.strictEqual(validateModelName('text-embedding-3-small'), 'text-embedding-3-small');
    for (const bad of ['../x', 'a/../b', 'a/b/c', 'a b']) assert.throws(() => validateModelName(bad), bad);
    assert.ok(cacheDir(path.join(os.tmpdir(), 'p'), 's', MODEL).endsWith(path.join('s', 'Xenova__bge-small-en-v1.5')));
  });

  it('embed --provider local fills the cache here, a private session included, with no --send-private', async () => {
    const { env, home } = setupHome();
    makePrivate(home.root, SESSION);
    const ctx = ctxFor(home, env);
    const code = await embedCommand.run(ctx, { session: SESSION, provider: 'local', model: MODEL }, [], { runner: runner() });
    assert.strictEqual(code, 0, ctx.stderr.text);
    const cache = EmbeddingCache.open(cacheDir(home.private, SESSION, MODEL));
    assert.strictEqual(cache.dim, 28);
    assert.strictEqual(cache.rows.length, cache.meta.chunksTotal);
    assert.strictEqual(cache.meta.provider, 'local');
    assert.match(ctx.stdout.text, /local, no cost/);
    const questions = await readQuestions(questionsFile(home.root, SESSION));
    assert.ok(questions.length > 0 && questions.every((q) => cache.question(q.id, q.question)));
  });

  it('kl-recall-vec --embed-provider local: runs from the cache and closes its runner', async () => {
    const { env, home } = setupHome();
    const r = runner();
    await embedCommand.run(ctxFor(home, env), { session: SESSION, provider: 'local', model: MODEL }, [], { runner: r });
    const session = await loadSession(sessionDir(home.root, SESSION));
    const questions = await readQuestions(questionsFile(home.root, SESSION));
    const adapter = createAdapter('kl-recall-vec', { tmpRoot: home.tmp, privateRoot: home.private, provider: 'local', model: MODEL, runner: r });
    assert.strictEqual(adapter.describe().embedder, `local/${MODEL}`);
    const handle = await adapter.prepare(session);
    try {
      const q = questions[0];
      const out = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      assert.strictEqual(typeof out.text, 'string');
      assert.ok(out.evidenceSeqsShown.every((s) => s < q.askAtSeq));
    } finally {
      await adapter.release(handle);
    }
    await adapter.close();
  });

  it('createRunnerScorer loads the cross-encoder once and scores through the runner', async () => {
    const scorer = createRunnerScorer({ runner: runner(), model: 'fake/rr', modelsDir: MODELS });
    const s = await scorer.score('linen bandage', ['the tomb', 'a linen bandage']);
    assert.ok(s[1] > s[0]);
    assert.strictEqual((await scorer.score('x', ['y'])).length, 1);
  });

  it('run reports how many questions had an empty tail', async () => {
    const stdout = sink();
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall,oracle'], { stdout, stderr: sink(), env: tmpHome().env });
    assert.strictEqual(code, 0);
    const summaryMd = stdout.text.match(/summary: (.+)$/m)[1].trim();
    const summary = JSON.parse(fs.readFileSync(path.join(path.dirname(summaryMd), 'summary.json'), 'utf8'));
    assert.strictEqual(typeof summary['kl-recall'].emptyTail, 'number');
    assert.strictEqual(summary.oracle.emptyTail, 0, 'no tail reported counts as not empty');
    assert.match(fs.readFileSync(summaryMd, 'utf8'), /Empty tail/);
  });

  it('runBenchmark closes every adapter: evidence only, the answer stage, and a run that throws', async () => {
    const { home } = setupHome();
    let closed = 0;
    const closing = () => ({
      name: 'closing',
      describe: () => ({ name: 'closing' }),
      prepare: async (session) => ({ session }),
      context: async () => ({ text: 'nothing here', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 3, latencyMs: 1, cpuMs: 1, cost: 0 }),
      release: async () => {},
      close: async () => { closed += 1; }
    });
    const now = () => new Date('2026-09-30T10:00:00.000Z');
    await runBenchmark({ home, adapters: [closing()], now, commit: 'x' });
    assert.strictEqual(closed, 1, 'evidence only');
    const fake = createFakeModels();
    const answer = { answerClient: fake.answer, judgeClient: fake.judge, prompts: { answer: loadPrompt('answer'), judge: loadPrompt('judge') }, catalog: fixtureCatalog(), dryRun: true };
    await runBenchmark({ home, adapters: [closing()], answer, now, commit: 'x' });
    assert.strictEqual(closed, 2, 'the answer stage, a dry run');
    await assert.rejects(runBenchmark({ home, adapters: [closing()], sessionIds: ['no-such-session'], now, commit: 'x' }), /No session/);
    assert.strictEqual(closed, 3, 'a run that throws');
  });
});
```

In `tests/longhaul-rerank.test.js`: replace `loadCrossEncoder` in the require (line 18) with `createRunnerScorer`; replace the test "names the no-save install when transformers.js is missing" (line 84) with:

```js
  it('createRunnerScorer passes the model and the models folder to the runner', async () => {
    const calls = [];
    const fake = {
      load: async (role, model, opts) => { calls.push(['load', role, model, opts.modelsDir]); return { dim: null }; },
      rerank: async (model, query, texts) => { calls.push(['rerank', model, texts.length]); return texts.map(() => 0); }
    };
    const scorer = createRunnerScorer({ runner: fake, model: 'fake/rr', modelsDir: '/lh/private/models' });
    await scorer.score('q', ['a', 'b']);
    await scorer.score('q', ['c']);
    assert.deepStrictEqual(calls, [['load', 'reranker', 'fake/rr', '/lh/private/models'], ['rerank', 'fake/rr', 2], ['rerank', 'fake/rr', 1]]);
  });
```

and at line 142 change `n <= 20), 'topM defaults to 20'` to `n <= 100), 'topM defaults to the app\'s 100'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/longhaul-local-embed.test.js tests/longhaul-rerank.test.js`
Expected: FAIL: `validateModelName` refuses `Xenova/bge-small-en-v1.5`; `createRunnerScorer` is not exported; `summary['kl-recall'].emptyTail` is undefined; `closed` stays 0.

- [ ] **Step 3: Write the implementation**

In `src/longhaul/embeddings.js`:

- Replace `MODEL_RE`, `validateModelName` and `cacheDir` with:

```js
// A model id, optionally org/name (the app's local models); a ':' tag is
// allowed for hosted ids. No dot-only segment: it becomes a folder.
const MODEL_RE = /^[A-Za-z0-9._:-]{1,100}(\/[A-Za-z0-9._-]{1,100})?$/;

function validateModelName(model) {
  const s = String(model || '');
  if (!MODEL_RE.test(s) || s.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw new UsageError(`--model must be a plain model id (org/name; letters, digits, . _ : -), got ${JSON.stringify(model)}`);
  }
  return s;
}

function cacheDir(privateRoot, sessionId, model) {
  return path.join(privateRoot, 'embeddings', sessionId, validateModelName(model).replace(/:/g, '_').replace(/\//g, '__'));
}
```

- In `createEmbedClient`, change `async embed(inputs) {` to `async embed(inputs, { kind = 'document' } = {}) {` and the call to `return await embedder.embed(inputs, { model, kind });`.
- In `embedChunks`, change `await client.embed(group.map((g) => g.text))` to `await client.embed(group.map((g) => g.text), { kind: 'document' })`.
- Add, before `embedderFromEnv`:

```js
// The app's local embedder (recall stage H3) for `embed` and kl-recall-vec:
// the embed worker through an EmbedRunner, models under modelsDir, the same
// prefixes the app uses. Nothing leaves this machine.
function localEmbedderFor({ runner, modelsDir }) {
  const { prefixTexts } = require('../history/embedders/profiles');
  const loading = new Map();
  return {
    local: true,
    async embed(inputs, { model, kind = 'document' } = {}) {
      if (!loading.has(model)) {
        loading.set(model, runner.load('embedder', model, { modelsDir }).catch((err) => {
          loading.delete(model);
          throw err;
        }));
      }
      await loading.get(model);
      const vectors = await runner.embed(model, prefixTexts(model, inputs, kind), { priority: kind === 'query' ? 'query' : 'document' });
      return { vectors, usage: { input: null }, model };
    }
  };
}

// Where LongHaul keeps downloaded local models (inside LONGHAUL_HOME).
const localModelsDir = (privateRoot) => path.join(privateRoot, 'models');
```

- Change `embedderFromEnv`'s signature to `function embedderFromEnv({ provider, env = process.env, baseUrl = null, providerInstance = null, runner = null, modelsDir = null })` and add at its top, after the `providerInstance` line:

```js
  if (provider === 'local') {
    if (!runner || !modelsDir) throw new UsageError('local embedding needs an embed runner and a models folder');
    return localEmbedderFor({ runner, modelsDir });
  }
```

- Export `localEmbedderFor` and `localModelsDir` (`module.exports.localEmbedderFor = localEmbedderFor; module.exports.localModelsDir = localModelsDir;`).

In `src/longhaul/rerank.js`, update the header comment (the cross-encoder is the app's, in the embed worker; no `npm i --no-save`), delete `loadCrossEncoder` and the `performance` require if unused, and add:

```js
// The cross-encoder the app ships (recall stage H3), in the embed worker
// through an EmbedRunner: loaded once, then each score() call reranks.
function createRunnerScorer({ runner, model = DEFAULT_RERANK_MODEL, modelsDir }) {
  let loading = null;
  return {
    model,
    async score(query, texts) {
      if (!loading) {
        loading = runner.load('reranker', model, { modelsDir }).catch((err) => {
          loading = null;
          throw err;
        });
      }
      await loading;
      return runner.rerank(model, query, texts);
    }
  };
}
```

and export `createRunnerScorer` in place of `loadCrossEncoder`. (`createCachedReranker` times the scorer itself; keep its `performance` require.)

In `src/longhaul/adapters/kl-recall-rerank.js`:

- Requires: `const { EmbedRunner } = require('../../history/embed-runner');`, `const { localModelsDir } = require('../embeddings');`, and `createRunnerScorer` in place of `loadCrossEncoder`.
- Signature: `function createKlRecallRerankAdapter({ recall = {}, privateRoot, candidates = 'bm25', rerankModel = DEFAULT_RERANK_MODEL, scorer = null, runner = null, ...rest } = {})`.
- `withRerank`: `{ ...recall, rerank: { enabled: true, maxMs: PROBE_RERANK_MAX_MS, ...(recall.rerank || {}) } }` (no `topM: 20`: the app's default, 100, applies).
- Replace the loading block with:

```js
  // The app's cross-encoder in the embed worker, started on the first cache
  // miss, once per adapter (shared with kl-recall-vec's local embedder).
  let ownRunner = null;
  const runnerFor = () => runner || (ownRunner ||= new EmbedRunner({ idleUnref: true }));
  let loading = null;
  const getScorer = () => {
    if (scorer) return scorer;
    if (!loading) loading = createRunnerScorer({ runner: runnerFor(), model: rerankModel, modelsDir: localModelsDir(privateRoot) });
    return loading;
  };
```

- Pass `runner: runnerFor()` only when fused and local: `createKlRecallVecAdapter({ ...rest, recall: withRerank, privateRoot, rerankerFor, ...(rest.provider === 'local' ? { runner: runnerFor() } : {}) })`.
- Add to the returned object: `async close() { if (typeof base.close === 'function') await base.close(); if (ownRunner) await ownRunner.stop(); },`.

In `src/longhaul/adapters/kl-recall-vec.js`:

- Requires: add `localModelsDir` to the embeddings require and `const { EmbedRunner } = require('../../history/embed-runner');`.
- Signature: add `runner = null, modelsDir = null` to the options.
- Replace the client setup with:

```js
  const isLocal = provider === 'local';
  let ownRunner = null;
  const runnerFor = () => runner || (ownRunner ||= new EmbedRunner({ idleUnref: true }));
  let client = null;
  const embedClient = () => {
    if (!client) {
      client = createEmbedClient({
        embedder: embedderFromEnv({
          provider, env, baseUrl, providerInstance,
          runner: isLocal ? runnerFor() : null,
          modelsDir: modelsDir || localModelsDir(privateRoot)
        }),
        model
      });
    }
    return client;
  };
```

- In `questionVector`: `if (isPrivate && !sendPrivate && !isLocal) {` and `const res = await embedClient().embed([embedText(question.question).text], { kind: 'query' });`.
- In `prepare`, after `const index = …`: `const rowOf = new Map(Array.from(index.chunkIds, (id, i) => [id, i]));` and store it: `handle.vec = { cache, index, rowOf, sessionId, isPrivate: Boolean(session.manifest.private) };`.
- In `context`, pass the cosine source to the builder:

```js
        const { index, rowOf } = handle.vec;
        const vectorOf = (chunk) => {
          const i = rowOf.get(chunk.id);
          return i === undefined ? null : index.matrix.subarray(i * index.dim, (i + 1) * index.dim);
        };
        const out = await handle.builder.build({
          chatId: handle.chatId, message: question.question, model: ESTIMATOR_MODEL, upToSeq: askAtSeq,
          vectorHits, lexical: !vectorOnly, reranker, vectorOf
        });
```

- Add to the returned object: `async close() { if (ownRunner) await ownRunner.stop(); },`.

In `src/longhaul/commands/embed.js`:

- Requires: `const { EmbedRunner } = require('../../history/embed-runner');` and add `localModelsDir` to the embeddings require.
- Usage string: `--provider openai|local`.
- After loading the session: `const isLocal = values.provider === 'local';` and make the private-session refusal `if (session.manifest.private && !isLocal && values['send-private'] !== true) {`.
- Replace the `embedder`/`client` lines with:

```js
    // local: the app's embedder in the embed worker; nothing leaves this machine.
    const runner = isLocal ? (deps.runner || new EmbedRunner({ idleUnref: true })) : null;
    const embedder = embedderFromEnv({
      provider: values.provider, env: ctx.env, baseUrl: values['base-url'] || null, providerInstance: deps.providerInstance,
      runner, modelsDir: localModelsDir(ctx.home.private)
    });
    const client = createEmbedClient({ embedder, model, wait: deps.wait });
```

- For the estimate: `const estUsd = isLocal ? 0 : priceTokens(values.provider, model, estTokens, deps.catalog);`, print `${isLocal ? 'local, no cost' : (estUsd === null ? 'price unknown' : `~${usd(estUsd)}`)}`, and guard the `--max-usd` refusal and the "sent to" note with `!isLocal`.
- Questions: `await client.embed(group.map((q) => embedText(q.question).text), { kind: 'query' })`.
- Final cost line: `ctx.stdout.write(`tokens ${tokens}; cost ${isLocal ? 'none (local)' : …}`)` keeping the existing text for hosted providers.
- In the `finally`, add first: `if (runner && !deps.runner) await runner.stop();`.

`src/longhaul/commands/run.js` is B3 Task 12's rewrite, which already carries `--embed-provider` so this task does not lose it. Check that it has all three pieces and add only a missing one: `'embed-provider': { type: 'string' }` in `options`; `[--embed-provider openai|local]` in `USAGE`; and `provider: values['embed-provider'] || 'openai',` in the `vec` object that `'kl-recall-vec'`, `'kl-recall-vec-only'` and `'kl-recall-vec-rerank'` share. Nothing else in the file changes.

In `src/longhaul/run.js` (B3 Task 11's rewrite):

- In `scoreOne`'s success record, after `chunkEvidenceRecall: chunkEvidenceRecall(q.evidenceSeqs, r.chunks),`, add `tailEmpty: Array.isArray(r.chunks?.tailSeqs) ? r.chunks.tailSeqs.length === 0 : null,`; in the `catch` record, after `chunkEvidenceRecall: null,`, add `tailEmpty: null,`. Both stages build their records through `scoreOne` (the answer stage's over-budget records too), so every record has the field.
- Add, above `runBenchmark`:

```js
// Adapters that hold a process (kl-recall-vec and kl-recall-rerank with the
// local embedder start an embed worker) release it here. A close that fails
// is logged; it never hides the run's own result or error.
async function closeAdapters(adapters) {
  for (const a of adapters) {
    if (typeof a.close !== 'function') continue;
    try {
      await a.close();
    } catch (err) {
      log.warn('an adapter did not close cleanly', { adapter: a.name, error: err.message });
    }
  }
}
```

- In `runBenchmark`, replace everything from `if (!answer) {` (the `usesModel` refusal after `if (!adapters.length) …`) through `return answer ? runAnswerStage(run, answer) : runEvidenceOnly(run);` with:

```js
  // Both stages (and the answer stage's deferred adapters, which are in this
  // list too) close every adapter, whether the run finishes, refuses, stops
  // at --dry-run or throws.
  try {
    if (!answer) {
      const needModel = adapters.filter((a) => a.usesModel).map((a) => a.name);
      if (needModel.length) {
        throw new UsageError(`${needModel.join(', ')} calls a summarizer model, so it runs only in the answer stage (--answer-model and --judge-model, or --fake-models).`);
      }
    }
    const { sets, skipped } = await loadRunSet({ dataRoot, sessionIds, includeUnverified });
    const run = {
      home, dataRoot, adapters, sets, skipped, skippedAdapters: adapterSkips(adapters, sets),
      budgetTokens, seed, includeUnverified, now, commit, staleTmpRemoved
    };
    return answer ? await runAnswerStage(run, answer) : await runEvidenceOnly(run);
  } finally {
    await closeAdapters(adapters);
  }
```

  One `finally` here covers `runEvidenceOnly` and `runAnswerStage` alike, including the answer stage's refusals before its own `try` (a private session, a judge that is the answer model, a grid run with `full-history`) and its `--dry-run` return. The `await` on both calls matters: without it the `finally` would close the adapters before the stage ran.

In `src/longhaul/scoring.js` (as B3 Task 9 left it):

- In `summarize`, add `emptyTail: ok.filter((r) => r.tailEmpty === true).length,` after `partial: …,`.
- In `renderSummaryMarkdown`, after the main table's loop (the `for (const [name, s] of Object.entries(summary)) { lines.push(`| ${name} | ${s.questions} | …`); }` that follows the `|---|---|…` header row) and before `const kinds = KINDS.filter((k) => k !== 'abstain');`, add:

```js
  lines.push('', `Empty tail (no tail message shown whole; H2's row-counted tail left agent sessions without one): ${Object.entries(summary).map(([name, s]) => `${name} ${s.emptyTail ?? 0}`).join(', ')}`);
```

  It goes in both the B0 and the B3 summary (the evidence tables are in both).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/longhaul-local-embed.test.js tests/longhaul-rerank.test.js tests/longhaul-embed.test.js tests/longhaul-run.test.js tests/longhaul-adapters.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-smoke.test.js tests/longhaul-boundary.test.js tests/longhaul-answer-run.test.js tests/longhaul-answer-cli.test.js tests/longhaul-answer-scoring.test.js`
Expected: PASS, `# fail 0`. B3's answer-stage tests cover the `run.js` and `scoring.js` it wrote; they must still pass with `tailEmpty`, `emptyTail`, the "Empty tail" line and the `finally`. (If a `longhaul-run` test compares a record's keys exactly, add `tailEmpty` to its expectation.)

Smoke run: `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle,kl-recall`
Expected: `oracle` evidence recall 1.000, exit 0, and the summary names the empty-tail counts.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul tests/longhaul-local-embed.test.js tests/longhaul-rerank.test.js
git commit -m "feat(longhaul): measure with the app's local embedder and cross-encoder; empty-tail count; adapters closed after every run"
```

---

## Task 16: Measure the H3 defaults on LongHaul, settle them, and record the result

**Files:**
- Modify: `src/history/settings.js` (only the defaults the rules below change), `tests/history-settings.test.js` (the same values); if `tailUserTurns` changes, also the tests Step 2 lists
- Modify: `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md` (§3, §3.1, §5.2, §6.1, §6.2, §6.3, §6.7, §12, §14, §15, §16)
- Modify: `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (§7's two B0 addenda)
- Modify: `CLAUDE.md` (History and LongHaul sections)

This task runs after B3 Tasks 1–16 and before B3 Task 17 (the header's execution order).

**Interfaces:**
- Consumes: everything above; the owner's private sessions in `LONGHAUL_HOME` (read by the commands only; nothing from them is copied into the repo).
- Produces: the shipped H3 defaults, measured; spec §6.7 rows (numbers only).

Rules decided before measuring (one question ≈ 0.01; differences under 0.02 are noise). "Recall" is evidence recall, "containment" strict answer containment; the H2 baseline (the shipped defaults) is 0.417 / 0.592, recall under 10K tokens back 0.79, p90 13.1K. (Spec §6.7's 0.89 under 10K was measured with whole-message completion on, which ships off; the shipped-defaults figure is 0.79, ruled 2026-09-30.)

- **tailUserTurns:** the smallest value whose overall recall and containment are within 0.02 of the best value swept, whose under-10K recall is at least 0.77 (the 0.79 baseline less the 0.02 noise), whose p90 total tokens is at most 15,000, and whose empty-tail count is the lowest swept. If no value meets every one of these conditions, keep the provisional 4 (the settings comment keeps "provisional"), put the whole sweep in the report to the owner (each value's recall, containment, under-10K recall, p90 and empty-tail count, and the condition it failed), record it in §6.7 as "provisional: no swept value met the rule", and go on to Step 3 with 4. The rule never ends without a value or without the sweep reported.
- **Acceptance of the shipped defaults** (`kl-recall-vec` on the local default model, with the chosen tail): recall ≥ 0.417 and containment ≥ 0.592. The BM25-only path the app falls back to (`kl-recall`, same tail) must be within 0.02 of 0.417 / 0.592. If either fails, stop and report the numbers to the owner; do not change a default to pass.
- **Embedder model:** if `Xenova/all-MiniLM-L6-v2` is within 0.02 of `Xenova/bge-small-en-v1.5` on both recall and containment, make MiniLM the default (2.4 times less CPU per chunk, Appendix A.3); else keep bge-small.
- **dedupeCosine:** if 0.92 is more than 0.02 below 0 (off) on recall or containment, ship 0.
- **Rerank:** report only (no default changes): `kl-recall-vec-rerank` at topM 100, and its cold median latency.

- [ ] **Step 1: Embed the private sessions with the local models (long: run in the background)**

```bash
export LONGHAUL_HOME="${LONGHAUL_HOME:-$HOME/.longhaul}"
SESSIONS=$(node -e "const { listSessions } = require('./src/longhaul/session-format'); console.log(listSessions(process.env.LONGHAUL_HOME).join(' '))")
for model in Xenova/bge-small-en-v1.5 Xenova/all-MiniLM-L6-v2; do
  for id in $SESSIONS; do node bin/longhaul.js embed --session "$id" --provider local --model "$model" || exit 1; done
done
```

Expected: per session `done: N chunks … embedded`, `local, no cost`. About 45K chunks per model; at the measured 42–102 ms a chunk this is roughly 30–80 minutes per model on the owner's CPU. Note the wall time per model for the report.

**Wait for Step 1 to finish before Step 2, and run no other `longhaul` command on this `LONGHAUL_HOME` while it runs.** Every `longhaul run` starts with `removeStaleTmp(home.tmp)`, which deletes every `kl-`-prefixed dir under `LONGHAUL_HOME/tmp`, a live `embed`'s `kl-embed-<pid>` store included (and a live answer run's `kl-ctx-<runId>`). That is a known B0 limitation: the cleanup cannot tell a dir left by a crash from one in use. Steps 2–4 run one command at a time for the same reason.

- [ ] **Step 2: Sweep the tail**

```bash
for n in 2 3 4 6 8; do node bin/longhaul.js run --adapters kl-recall --recall tailUserTurns=$n; done
```

From each run's stdout and `summary.md` note: recall, containment, p90 tokens, recall in the under-10K distance bucket, and the "Empty tail" count. Apply the tailUserTurns rule. If it keeps 4 (picked or kept as provisional), no test changes; if it picked 4, drop "provisional" from the settings comment. If it picks another value `n`, set `HISTORY_DEFAULTS.recall.tailUserTurns` to `n` in `src/history/settings.js` (drop "provisional" from the comment) and update every expectation that assumes the default of 4:

- `tests/history-settings.test.js`, six assertions: `tailUserTurns: 4` in the first test's defaults; in `'tail keys: …'`, the fallback in `for (const bad of [0, -1, '4', NaN]) … .tailUserTurns, 4` (the string `'4'` is a bad input and stays); in `'a settings file saved before H3: …'`, `r({ tailMessages: 16 }).tailUserTurns, 4`, `r({ tailMessages: 8 }).tailUserTurns, 4` and `saved({ recall: { tailMessages: 10 } }).recall.tailUserTurns, 4`; and `DEFAULT_SETTINGS.history.recall.tailUserTurns, 4` in the last test. Each becomes `n`.
- `tests/history-context-builder.test.js`: `'by default the tail is the last 4 user turns, and no more'` (title with `n`; seqs `Array.from({ length: 2 * n }, (_, i) => 41 - 2 * n + i)`; `userTurns` `n`) and `'enabled: false sends the tail only'` (`Array.from({ length: 2 * n }, (_, i) => 21 - 2 * n + i)`), for `n` ≤ 10 (the 20-row chat has 10 user turns).
- `tests/history-core.test.js`: `first.messages.length` and the `enabled false` `messages.length` become `2 * n + 1`; `'Seeded note 33 …'` becomes `'Seeded note ${41 - 2 * n} …'`; `ctx.tail` becomes `{ fromSeq: 41 - 2 * n, toSeq: 40 }`; the comments with them.
- `tests/e2e/history-recall.test.js`: line 73 `{ fromSeq: 51 - 2 * n, toSeq: 50 }`; line 80 `<= 2 * n + 2`.
- Task 11's per-turn test pins `tailUserTurns: 4` itself and does not change; Task 10's vector-search tests pin `tailUserTurns: 1`.

Then run `node --test tests/history-settings.test.js tests/history-context-builder.test.js tests/history-core.test.js tests/history-search-rerank.test.js tests/history-vector-search.test.js tests/longhaul-adapter-kl-recall.test.js` and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-recall.test.js`; a failure there that names the tail is one more expectation of the default: update it the same way and say so in the report.

- [ ] **Step 3: Measure the shipped defaults, the other model, and the cosine dedupe**

```bash
node bin/longhaul.js run --adapters kl-recall,kl-recall-vec --embed-provider local --embed-model Xenova/bge-small-en-v1.5
node bin/longhaul.js run --adapters kl-recall-vec --embed-provider local --embed-model Xenova/all-MiniLM-L6-v2
node bin/longhaul.js run --adapters kl-recall-vec --embed-provider local --embed-model Xenova/bge-small-en-v1.5 --recall dedupeCosine=0
```

Apply the acceptance, model and dedupeCosine rules. A model change: `HISTORY_DEFAULTS.embedder.model` and the `EMBEDDER` constant in `tests/history-settings.test.js`; a dedupe change: `dedupeCosine` in both. Re-run `node --test tests/history-settings.test.js` after any change. If acceptance fails, stop here and report.

- [ ] **Step 4: Report the reranker and the hosted reference**

```bash
node bin/longhaul.js run --adapters kl-recall-vec-rerank --embed-provider local --embed-model <the model Step 3 settled>
```

Note recall, containment and the median latency of this first (cold-cache) run. If the probe's OpenAI cache exists (`$LONGHAUL_HOME/private/embeddings/*/text-embedding-3-small`), also run `node bin/longhaul.js run --adapters kl-recall-vec --embed-model text-embedding-3-small` for the hosted comparison (it sends nothing when every question is cached; without `--send-private` it refuses rather than send).

- [ ] **Step 5: Record the result in the spec**

In §6.7, add rows to the table, filling each `<…>` slot with the value measured in Steps 2–4 (`<n>` the chosen tailUserTurns, `<model>` the chosen model, `<d>` the chosen dedupeCosine, `<r>`/`<c>` recall and containment to three decimals; numbers only, no session names, no question text):

```markdown
| H3: tail in user turns (`tailUserTurns` <n>), BM25 only | <r> | <c> |
| **H3 shipped defaults** (the tail above, local `<model>` vectors fused, `dedupeCosine` <d>) | **<r>** | **<c>** |
| H3, `Xenova/all-MiniLM-L6-v2` / `Xenova/bge-small-en-v1.5` (the other one) | <r> | <c> |
| H3, plus cross-encoder rerank, `topM` 100 (SearchHistory, or `rerank.enabled`) | <r> | <c> |
```

(if the tailUserTurns rule kept 4 as provisional, the first row reads "`tailUserTurns` 4, provisional: no swept value met the rule"), and under "Findings" keep the existing "The tail." bullet as it is (it already says "0.69 to 0.89 with whole-message completion on … 0.79 with the shipped defaults", the ruled wording) and add a bullet each for: the user-turn tail (empty-tail count before/after, under-10K recall against the 0.79 baseline, p90), local vectors against the OpenAI probe's +0.05 (the hosted row if Step 4 ran it), the rerank (gain and cold median latency per question), and the embedding wall time per model. Replace the paragraph after the table ("The spec's 0.8 recall target (§13) is not met with BM25 alone; H3 starts from these numbers.") with one sentence stating where the shipped H3 defaults leave the 0.8 target.

In §6.1, replace the first sentence ("The tail is the most recent `history.recall.tailMessages` (16) `user` and `assistant` messages, capped at `tailTokens` (6,000), and it starts at a `user` message.") with this block (`<n>` is the tailUserTurns Step 2 settled), and delete the two sentences "The default was 8 messages with results left out: … the tail came out empty (§6.7).", which the block replaces:

```markdown
The tail is counted in user turns: the last `history.recall.tailUserTurns`
(<n>) user messages and the user and assistant messages after the oldest of
them, capped at `tailTokens` (6,000) and `tailMaxRows` (64) rows. The newest
user message is always in it; the replies after it fill what is left, newest
first, and older turns come whole while they fit, so the tail starts at a
`user` message and is never empty while the chat has one within
`TAIL_SCAN_MAX_ROWS` (2,000) rows. A tool call or result is folded into the
reply that followed it only when that reply is shown. H2 counted
`tailMessages` rows instead; agent sessions write one assistant row per tool
round, so 16 rows after the owner's last message left an empty tail (§6.7).
A settings file saved before H3 maps its `tailMessages` to user turns (two
rows a turn; the shipped 8 and 16 read as unset).
```

Keep the rest of §6.1 (tool calls, tool results, the token accounting, shortening) as it is.

In §6.2, replace "A follow-up too short to search on is a known gap; … would need questions of that shape to measure." with: "`queryFallbackMinChars` (0, off) adds the previous user messages, at most three, to a message with fewer letters and digits than that. It is off until LongHaul has follow-up questions to measure it with: authoring them (a question kind asked right after the message it refers back to) belongs to a later LongHaul stage, after B3."

In §6.3 step 6, replace "`rerank.topM` (20)" with "`rerank.topM` (100)" and the sentence "`rerank.enabled` does nothing unless … (the Retriever never reads `rerank.model`)." with: "`SearchHistory` reranks by default (`rerank.search`, under `rerank.searchMaxMs`, 6,000), since the model is waiting on the tool anyway; per turn it is opt-in (`rerank.enabled`). The cross-encoder runs fp32 in the embed worker (§5.2)." In step 7, replace the first sentence with: "Drop exact text duplicates before step 6, then, in the budget step, a chunk whose cosine to an already selected chunk exceeds `dedupeCosine` (0.92) when both have vectors."

In §3.1's host-agnostic bullet and §5.2's first paragraph, replace the `worker_threads` / `utilityProcess` text with: "The embed worker is a child process spawned from `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (the app binary in a packaged build, `node` in the service), in both hosts, like the PDF worker: a native crash in onnxruntime ends the child, not the app." In §5.2's table, the `openai` row becomes "`OpenAIProvider#embed` (through `BaseProvider.request`)", the `ollama` row gains "through `OllamaProvider#embed`", and add under it: "Model files download into `<dataDir>/models/<org>/<name>/`; a completed load writes `.kl-complete.json`, and a folder without it is deleted before the next try. The embedder starts with the host's background checks (never under `KL_TEST_MODE`)."

In §12, the `package.json` row becomes: "`@huggingface/transformers` 4.3.0 and `onnxruntime-node` 1.30.0; `asarUnpack` for `onnxruntime-node`; each platform build drops the other platforms' onnxruntime binaries. (No `!**/models/**` pattern: it would drop `src/models/`, and model files live in the data dir.)" The `main.js` row drops "injects a `utilityProcess` embed runner".

In §14, update the block to the H3 keys (Global Constraints of this plan, with the values Steps 2–3 settled), and add `version: 3` with one line on why.

In §15, the "Embedder unavailable" row's "retry on the next catch-up tick" becomes "retry after 10 minutes, on a settings change or on Retry"; the "Embed worker crashes" row adds "the chunk that crashed it alone is skipped for that model".

In §16, replace the bge-small bullet with the measured decision from Step 3 (which model, its recall and containment against the other, and the CPU per chunk from A.3).

In the benchmark spec (`docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md`) §7, two B0 addenda are no longer true after Task 15; B3 Task 16 has added its own `kl-recall-whole` addendum there by now, so anchor on the text:

- In the `kl-recall-vec` addendum, replace "It is never published as a result: it sends every chunk of a session to a provider, which King Louie's recall never does, and it is not what H3 ships." with: "With its hosted embedder (the default, `--embed-provider openai`) it is never published as a result: it sends every chunk of a session to a provider, which King Louie's recall never does. With `--embed-provider local` (H3) it embeds with the app's own local model in the embed worker, cached under `LONGHAUL_HOME/private/embeddings/<session>/<org>__<name>/`; nothing leaves the machine, it is what H3 ships (`kl-recall` is the BM25 path the app falls back to), and it is published like `kl-recall`."
- In the `kl-recall-rerank` addendum, replace "Neither package is an app dependency; install them in a checkout with `npm i --no-save`." with "Since H3 both are app dependencies (`package.json`) and the cross-encoder runs in the app's embed worker; its model downloads once into `LONGHAUL_HOME/private/models/`.", and replace its last sentence's "the fused variant inherits `kl-recall-vec`'s hosted embedder and is never published as a result" with "the fused variant with the hosted embedder is never published as a result; with `--embed-provider local` it is published like `kl-recall`".
- In both addenda's bold lead, change "**B0 addendum (2026-09-30):" to "**B0 addendum (2026-09-30, amended by H3):" and "is an H3 probe, not a candidate system.**" to "is an H3 probe with a hosted embedder; with `--embed-provider local` it measures what H3 ships.**".

- [ ] **Step 6: Update CLAUDE.md**

In the History section: change "stages H1-H2" to "stages H1-H3"; replace the "Recall defaults come from LongHaul measurements …" bullet's tail description with the user-turn tail and the settled defaults; add:

```markdown
- H3 (vectors): `embeddings` (schema step 3) holds one unit float32 vector per
  chunk per embedder key (`local:<model>`, `ollama:<model>`,
  `openai:<model>`). `EmbedderHost` (`src/history/embedder-host.js`) picks the
  embedder from `settings.history.embedder` and starts only from
  `startModelsBackgroundChecks` (never under `KL_TEST_MODE`, never in
  `createCore().start()`); `startEmbedIndexer` fills the table in the
  background; `VectorIndex` keeps per-chat matrices under `vectorCacheMb`.
  Local models run in the embed worker (`embed-runner.js`, `embed-worker.js`)
  and download once into `<dataDir>/models/`. `SearchHistory` reranks with the
  local cross-encoder; per turn only with `rerank.enabled`.
- Tests never load a model: the worker with `tests/helpers/fake-embed-backend.js`
  (`new EmbedRunner({ testBackend })`), a core with `deps.history.createEmbedRunner`
  returning `FakeEmbedRunner` (`tests/helpers/fake-embed-runner.js`).
```

In the LongHaul section: replace "`kl-recall-rerank` … needs `npm i --no-save …`, never an app dependency." with: "`kl-recall-rerank` / `kl-recall-vec-rerank` use the app's cross-encoder in the embed worker (models under `LONGHAUL_HOME/private/models`), scores cached under `LONGHAUL_HOME/private/rerank/`. `longhaul embed --provider local --model <org/name>` and `run --embed-provider local` use the app's local embedder; nothing leaves the machine, so no `--send-private`. Summaries count questions with an empty tail."

- [ ] **Step 7: Run the tests**

Run `npm test`. If it is green, that is the check. If it fails (the owner reported the full suite broken for reasons unrelated to H3), re-run the failing files on `main` (`git worktree add --detach ../kl-main-check main`: without `--detach` it fails while `main` is checked out; then `node --test <those files>` in it, then `git worktree remove ../kl-main-check`): a file that fails on `main` too is that unrelated breakage. Then run the H3 set:

`node --test tests/history-*.test.js tests/longhaul-*.test.js tests/renderer-history-*.test.js tests/electron-boundary.test.js tests/fake-embedder.test.js`

and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-recall.test.js`.
Expected: `# fail 0`. The report says which suite ran and why.

- [ ] **Step 8: Commit**

```bash
git add src/history/settings.js tests/history-settings.test.js tests/history-context-builder.test.js tests/history-core.test.js tests/e2e/history-recall.test.js docs/superpowers/specs/2026-09-25-chat-history-recall-design.md docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md CLAUDE.md
git commit -m "docs(history): H3 measured on LongHaul; settle the tail, model and dedupe defaults; spec and CLAUDE.md"
```

---

## Decisions

Rulings this plan makes where the spec, the measured facts and the code disagree, or where the spec is silent:

1. **The embed worker is a child process in both hosts**, not `worker_threads` with an injected `utilityProcess` (spec §3.1, §5.2, §12's `main.js` row). A native crash in onnxruntime inside `worker_threads` kills the whole process; a child process spawned like the PDF worker isolates it, needs nothing from Electron (so `src/` stays Electron-free with no host seam), and is one code path for the desktop, the service and LongHaul.
2. **Default local model: `Xenova/bge-small-en-v1.5`**, as spec §14 and §16 say, over `all-MiniLM-L6-v2`, which A.3 measured at 42 ms a chunk against 102. bge-small is the one closer in retrieval quality to the hosted model the +0.05 vector gain was measured with; its extra CPU is background work, and a query is one short text. Task 16 measures both on the private set and switches to MiniLM if it is within noise (0.02) on both metrics.
3. **`rerank.topM` 100** (spec §14 says 20): measured, 20 changes nothing at a 6K budget and 100 is the knee. **SearchHistory reranks by default** (`rerank.search`, new) under `rerank.searchMaxMs` 6,000 (new): 2.25 s median per question uncached is too slow per turn but fine where the model is already waiting. `rerank.enabled` stays the per-turn opt-in with the existing `maxMs` 2,000, which on a laptop will often fall back to the fused order; the pane says "about 2 s a turn".
4. **The cross-encoder runs fp32** (the rerank probe measured 18–28 ms a pair) where A.3's int8 measured 61 ms; the embedder runs int8 (`q8`) as A.3 measured it.
5. **Hosted embedders go through the providers**: `OpenAIProvider#embed` instead of the spec's `OpenAIEmbeddingProvider` (it calls `fetch` directly), and a new `OllamaProvider#embed` on `/api/embed`, so every request goes through `BaseProvider.request`.
6. **No `!**/models/**` build pattern** (spec §12): it would drop `src/models/` (the model catalog). Model files live in `<dataDir>/models`, never in the tree; instead each platform build drops the other platforms' onnxruntime binaries.
7. **Exact-text dedupe stays before the rerank, with or without vectors** (spec §6.3 step 7 says "without vectors"): identical text has cosine 1, so it is a subset of the cosine rule, and dropping it early saves reranker pairs. The cosine rule runs in the budget loop against what is already selected, like `dedupeJaccard`.
8. **Settings saved before H3**: `setSettings` stores merged defaults, so a saved `rerank.topM` 20 or `tailMessages` 8/16 is the old shipped default, not a choice. `history.version` (3, new) marks a file as merged by H3; without it those values read as unset, and another `tailMessages` maps to `ceil(n / 2)` user turns.
9. **`tailUserTurns` 4 is provisional**: counted rows and user turns are not comparable (16 rows were 8 turns in a chat and less than one in an agent session). Task 16 sweeps 2–8 on LongHaul and sets it by a rule fixed in advance, against the under-10K recall of the shipped H2 defaults (0.79; spec §6.7's 0.89 was measured with whole-message completion on, which ships off). If no swept value meets every condition, 4 stays, still marked provisional, and the report carries the whole sweep.
10. **Follow-up questions are left to a later LongHaul stage, after B3** (owner ruling 2026-09-30; B3 does not add the kind). The fallback ships off (`queryFallbackMinChars` 0) with unit tests only; authoring follow-up questions needs a new question kind and its verification rules, which is benchmark design.
11. **An unavailable embedder retries after 10 minutes** (and on a settings change or Retry), not "on the next catch-up tick" (spec §15): a failed download retried every 2 s would hammer the network and the log.
12. **A chat too large for `vectorCacheMb` on its own is searched by BM25 only**, with one log line and a provenance note (spec is silent). Streaming its vectors from SQLite each turn would cost seconds; the owner can raise the cap.
13. **A chunk that crashes the worker alone is tombstoned** (a `dim 0` row) for that key and never retried, so one odd chunk cannot use up the three-crashes budget over and over (spec §15 is silent on a poison input). It still costs two of the three crashes the first time: the batch it was in, then the solo retry that confirms it. So a second poison chunk inside the same ten minutes (in the same batch or a later one) turns local embedding off for the session, with the badge, until Retry. Not counting the confirming crash would need the runner to know which requests are isolation retries; the plan accepts the cost instead, since Retry restores it and the chunks already tombstoned are not tried again.
14. **Two ONNX threads** per worker session, so a backfill does not take every core of a desktop. The A.3 per-chunk numbers were measured with the library default; Task 16 records the wall time the setting gives.
15. **The weights and top-k values stay out of the settings pane** (spec §14 puts them behind "advanced"): the pane holds only the embedder, the model ids, the Ollama address and the two rerank switches, as the owner asked for a minimal pane.
16. **An unavailable reranker is a silent no-rerank.** Before the `EmbedderHost` starts (never under `KL_TEST_MODE`, so not in the e2e suite, and not before the background checks run), `SearchHistory` gets `RERANK_UNAVAILABLE` from the host; the Retriever keeps the fused order with one debug line instead of a warning on every call (Task 11). A reranker that exists and fails still warns.

## Open Questions

Only the owner can decide these; each has a recommended answer, which is what the plan implements until told otherwise.

1. **Should King Louie download the local model from huggingface.co on its own the first time it starts after H3** (default `embedder.kind: 'local'`, about 35 MB for bge-small plus about 90 MB for the cross-encoder on the first `SearchHistory`), or wait for the owner to press a button in the pane? Recommended: download on its own, as spec §16 assumed ("models download on first enable", with `local` the default). It sends no chat data; the pane names the source and shows the progress.
2. **Is up to about 6 s acceptable for a `SearchHistory` call** (the rerank on a laptop CPU, `searchMaxMs` 6,000)? Recommended: yes; the model chose to search, and a slower rerank falls back to the fused order at 6 s rather than waiting longer.
3. **Ship H3 with only the Windows x64 package checked** (macOS and Linux as a documented residual, like ingest's PDF worker), or hold the release until the packaged check has run on macOS and Linux? Recommended: ship with the residual documented; the worker degrades to BM25 with a warning if the runtime fails there.
4. **The installer grows by the transformers.js and onnxruntime-node packages** (one platform's native runtime, tens of MB, after the per-platform exclusions). Acceptable? Recommended: yes; the models themselves are not bundled.
