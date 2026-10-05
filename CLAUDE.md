# king-louie

Electron desktop chat app. Main process in `main.js`, renderer in `renderer.js`,
tools and providers under `src/`.

## Testing

Tests use **node's built-in test runner** (`node --test`), not Jest. Do not
invoke `jest` or `npx jest` — Jest will report "Test suite must contain at
least one test" because the files use `node:test`'s `describe`/`it` API and
no `test()`/`it()` calls jest can detect, and you'll miss real failures.

Run tests with:
- `npm test` — full suite (`node --test tests/*.test.js`)
- `node --test tests/<file>.test.js` — single file
- `npm run test:e2e` — sequential e2e suite

When iterating on a specific module, run just its test file directly with
`node --test`. Output uses TAP format; look for `# fail 0` / `# pass N` in the
summary block.

`--test-timeout` is 600000 because on Node 22 it bounds the **whole file**, not
just each test: node wraps each file in a test of its own, so a file whose
tests are all fast still fails `testTimeoutFailure` at `<file>:1:1` once its
total runtime passes the limit. Several case and ingest suites run 85-110 s
here and about 2.5x that on Windows CI, so a 120 s limit failed them. Node 24
(what Electron 41 bundles) does not bound the file wrapper, so this only ever
shows up on the Node 22 CI leg — the matrix runs both. A file-level timeout is
a slow file or a leaked handle, never a slow single test; `node --test` keeps
running until the loop drains, so an unclosed core, child process or server
hangs the file long after the last test passes. Cores built in a test get
`await core.shutdown()`.

`npm run test:e2e` launches the real Electron binary through Playwright's
`_electron` (`tests/e2e/helpers.js`). Every launch gets its own temporary
`--user-data-dir` (the helper throws `userData isolation failed` otherwise), so
e2e tests never touch the real profile; give `launchApp({ seed })` any files a
test needs. The helper deletes `ELECTRON_RUN_AS_NODE` from the child's env
(Electron treats an empty value the same as `1`); unset it in the shell too:

```bash
unset ELECTRON_RUN_AS_NODE && npm run test:e2e
```

Unit tests (`npm test`) don't launch Electron and are unaffected either way.

`tests/e2e/helpers.js`'s `launchApp()` already gives every launch its own fresh
`--user-data-dir` (removed again in `closeApp()`), so the e2e suite never reads
or writes your real King Louie profile — chats, settings, the vault.

## Running the app

`npm start` launches Electron normally. If it dies instantly with
`Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`
at `main.js:9`, the environment has `ELECTRON_RUN_AS_NODE=1` set — that makes
the Electron binary run as plain Node, so `app`, `protocol`, and `BrowserWindow`
are all undefined.

**This is the normal state of an agent shell.** Electron-based tools (VS Code's
integrated terminal, Electron-based CLI agents) set it for their own child
processes and it is inherited. Setting it to an empty string is **not**
enough — Electron treats a present-but-empty `ELECTRON_RUN_AS_NODE` the same
as `1` and still crashes at the same line. It has to be removed from the
environment entirely:

```bash
unset ELECTRON_RUN_AS_NODE && npm start
```

To drive the UI programmatically, use Playwright's `_electron` — it is already a
dependency. Launch `node_modules/electron/dist/electron.exe` (or
`dist/electron` on Linux, `dist/Electron.app/Contents/MacOS/Electron` on macOS)
and **delete `ELECTRON_RUN_AS_NODE` from the env you pass the child**, or the
launch fails with "Process failed to launch!". Pass
`--user-data-dir=<temp path>` to get a clean profile instead of mutating real
chats, settings, and the vault.

Click through `page.evaluate(() => document.getElementById(id).click())` rather
than `locator.click()`, and remember the onboarding wizard appears on a fresh
profile (`#wizard-skip-btn` dismisses it).

## Browser actions that change something

`src/tools/browser-acting.js` lists the browser actions that type, click, run
code or fill logins/payments. `ToolExecutor` asks the owner for these even when
the browser tool is on the "always approve" list or an agent's
`autoApproveTools`. Two explicit instructions lift the prompt: a permission rule
for the action (browser rules match `params.action`, so `allow Browser(click)`),
or an `ownerQuote` that appears on word boundaries in the owner's own message
for this turn (`ownerTurnText`, set only by the local chat send path, and never
honoured under `denyAutoApproval`). The quote proves the owner wrote the words,
not that they were about this action.

## Service mode

`node bin/king-louie-service.js run --data-dir <tmp> --profile agent` runs King Louie
headless (no Electron — `ELECTRON_RUN_AS_NODE` is irrelevant here). Everything under
`src/` must stay Electron-free except `src/ipc/`; `tests/electron-boundary.test.js`
enforces it. Host-specific behaviour is injected into `createCore(deps)` (`src/core/`).

## Logging

Use `createLogger` from `src/logging.js` instead of bare `console.*` calls.
Loggers are scoped by subsystem name and support hierarchical children,
level filtering, and structured metadata.

```js
const { createLogger } = require('./logging');   // or '../logging' from subdirs
const log = createLogger('my-module');

log.info('something happened');
log.warn('degraded', { latencyMs: 430 });

const child = log.child('sub-part');             // → [my-module/sub-part]
const bound = log.withContext({ sessionId: 's-1' }); // metadata on every call
```

Levels (low → high): `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`.
Default is `info`. Override with `KING_LOUIE_LOG_LEVEL` or `LOG_LEVEL` env var.

## History

`src/history/` is the history store (spec
`docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, stages H1-H3;
ADR `docs/adr/0001-history-messages-as-rows.md`). It is Electron-free.

- Chats, their messages (one row each, `seq` dense from 1 per chat) and
  attachments live in `<dataDir>/history.sqlite` (`node:sqlite`, WAL, one
  connection per core, closed at the end of `shutdown()`). `chat-data.json`
  keeps everything else.
- Code reaches chats through the core context: `listChats` (metadata with
  `messageCount`, `preview`, `lastMessageAt`), `getChat(id, { messages })`,
  `updateChat`, `appendMessageToChat`, `truncateChatFrom`, `getMessages`, or
  `getHistoryStore()` for the store itself. `getChats`/`setChats` are gone;
  `tests/history-no-legacy-chat-helpers.test.js` keeps them out of `src/`.
- On the first start after H1, the chats in `chat-data.json` move into the
  store, one transaction per chat, after a `chat-data.backup-<timestamp>.json`
  copy. A chat that fails stays in the JSON file and the chat list says how
  many; the move resumes on the next start. An old `chat-history.sqlite` is
  never read.
- A store that will not open is an error in the log and the chat list, never
  a fallback to the JSON file. Service CLI commands that build a core as root
  pass `history: { open: false }`. `import --dry-run` passes
  `history: { readonly: true }`: an existing store opens read-only, and a
  pre-H1 data dir gets an in-memory store filled from chat-data.json with
  nothing written.
- `history.sqlite*`, `chat-history.sqlite*` and `chat-data.backup-*` in the
  data dir are secret files for every tool (`SECRET_FILE_PREFIXES`) and
  write-guarded in case turns (`case-guard.js`). A chat that never moves is
  backed up once, not on every start (`migration_backup` in the store's meta).
- Schema changes are new entries in `SCHEMA_STEPS` (`src/history/schema.js`);
  never edit a released step. A read-only open refuses an older schema unless
  it passes `allowOlderSchema: true` (desktop import, which reads only chats
  and messages, so it can import from an H1 desktop): the file is not
  upgraded, and its index methods find nothing.
- `main.js` and `bin/king-louie-service.js` drop Node's SQLite
  ExperimentalWarning (`src/history/sqlite-warning.js`); tests still print it.
- Tests use `HistoryStore.open(':memory:')` or `tests/helpers/history-context.js`
  (the facade over one). On Windows an open store keeps its folder from being
  deleted, so a test that builds a core calls `closeOpenHistoryStores()`
  (`tests/helpers/close-history-stores.js`) before removing the data dir.
- H2 (BM25 recall): `appendMessage` chunks each message (`chunker.js`) and
  writes its FTS5 rows in the same transaction; never write `messages` or
  `chunks` another way. The tokenizer is `unicode61 tokenchars '_-'`: '.' and
  '/' separate tokens, so "app.js" matches a stored "src/app.js". A store
  upgraded from schema 1 is chunked after `core.start()`, not on open:
  `startChunkBackfill` (`src/history/backfill.js`) runs one
  `backfillChunks` batch per `setImmediate` tick, resumably, and stops when
  the store closes; search misses what is not indexed yet. Read-only and
  in-memory stores never backfill.
- Tools in `UNINDEXED_TOOLS` (`chunker.js`; `Vault`) make no chunks, so their
  secrets never reach search or recall; the tail's tool lines and ReadHistory
  show such a call's action and key only, and none of its result.
- Each turn, `ContextBuilder.build` gives the tail and the recalled block; the
  send path puts the block, the case orientation and the memory context in
  `options.systemPromptDynamic`, which Anthropic sends uncached after the
  cached `systemPrompt`. `history.recall.enabled: false` sends the tail only.
- Recall defaults come from LongHaul measurements (spec §6.7): the query is
  the new message alone (`queryUserTurns: 0`), `bm25TopK` 200, and the tail is
  the last `tailUserTurns` (4) user turns with the replies and tool results in
  their span (tool results capped at 1,000 tokens each, the tail at
  `tailMaxRows` rows), and local `Xenova/all-MiniLM-L6-v2` vectors are fused
  with BM25 (`dedupeCosine` 0.92). Settled on LongHaul in H3 (spec §6.7):
  the tail by a sweep of 2 to 8 user turns (4 is the smallest within noise of
  the best, under the 15K p90 ceiling), MiniLM over bge-small (0.456 / 0.612
  against 0.443 / 0.583 evidence recall / containment, at half the CPU). The
  other `history.recall` knobs (`completeMessageTokens`, `pairToolMessages`,
  per-turn `rerank`, `dedupeJaccard`, …) were measured and are off or inert by
  default. Change a default only with a LongHaul run
  that shows it; tests that check a mechanism pin their settings explicitly.
- Assistant replies carry `context` provenance; the recall line reads it and
  `history:excerpts` returns the excerpts. `SearchHistory`/`ReadHistory` are
  always loaded; their scope is the chat itself until stage H4.
- Tests use `tests/helpers/history-fixture.js` (a temp store; chats seeded
  through the real `appendMessage`); `tests/e2e/history-recall.test.js` is
  the end-to-end check.
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
- The local embedder and the cross-encoder run in the embed worker, a child
  process of `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (like the PDF
  worker), so they need Electron's RunAsNode fuse left on and
  `onnxruntime-node` unpacked from the asar (`build.asarUnpack`).
  `node scripts/check-embed-worker.js [--app <binary> --resources <dir>]`
  checks a checkout or a packaged build (it downloads the models once). Only
  the Windows x64 package has been checked; macOS and Linux are a residual.
  The other platforms' onnxruntime binaries are dropped by one top-level
  `build.files` pattern (`${platform}` macro); never give `build.win`/`mac`/
  `linux` a `files` list: electron-builder 26 then drops the top-level list,
  and `.git`, `tests` and `src/longhaul` go into the asar.
- Rerank (`history.recall.rerank.kind`): `local` (the cross-encoder) or `jev`,
  typesafe.ai's hosted Jev, opt-in (the pane's "Allow sending to typesafe.ai"
  box; `history:embedder.save` refuses any save with `jev` chosen without
  `confirmJev`, and a change of kind or Jev model resets `JevReranker`). It
  sends the query and about 100 chunks per rerank, in every chat, case chats
  included. One client, `TypesafeProvider` (decide-only: not registered, not
  in the catalog, unpriced), and one scorer, `src/history/jev-rerank.js`,
  shared with LongHaul. `JevReranker` starts only from
  `startHistoryEmbedding` and refuses under `KL_TEST_MODE`; a failure keeps
  the fused order with one warning per episode. Its key is
  `apiTokens.__typesafe_api_key`, encrypted like a provider token; the
  `Vault` tool cannot read it, and `import --from` does not carry it (enter
  it again on the service). Provenance has `reranker` and `rerankSkipped`.
  Tests use `tests/helpers/fake-jev-server.js`, never the network.
  Measured on LongHaul (spec §6.7): Jev, with or without whole messages,
  gave no better answer accuracy than the shipped defaults and lowered
  abstain accuracy, so it stays opt-in and no default changed.

## Models

`src/models/` holds the model catalog and provider availability (spec:
`docs/superpowers/specs/2026-09-27-model-catalog-profiles-roles-design.md`,
stages M1 to M3). It is Electron-free.

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
- Model choice is profiles (`settings.models.profiles`, stage M2): named sets
  of models per role (main, worker, utility, vision, imageGeneration, custom).
  Tiers, `activeProvider`, `providerModels`, smart routing and the LLM router
  are gone; `src/models/migrate-tiers.js` reads them once at start. Every
  model call resolves through a `TurnModels` (`core.context.snapshotModels` /
  `resolveRole`) and fails over along the resolved list
  (`InferenceRouter#routeTargets`); a loop on a routed provider gets
  `failoverPolicy: NO_RETRY`.
- Tests configure models with `tests/helpers/profile-settings.js`
  (`profileSettings`, `everyRole`, `withCaseProfile`). A provider a test
  registers outside the 14 is usable when it has a saved token.
- Roles in use (stage M3): chat titles run on utility; SpawnAgent and
  BackgroundTask take a `role` (a bare call runs on worker), and a `model`
  an LLM names (SpawnAgent, a planned workflow task's `preferredModel`) must
  already be in the turn's profile (`requireInProfile`). The explorer is the
  read-only `code-explorer` agent on worker. A non-case agent-mode turn's
  prompt starts with `DELEGATION_GUIDANCE` (`src/context/system-sections.js`)
  only when `workerIsCheaper` (`src/models/delegation.js`) holds: worker has
  models of its own (no borrow from main) and its first model's blended
  catalog rate (the suggester's 3:1 input:output blend) is strictly below
  main's first. It reads only the frozen `TurnModels` and the catalog, so the
  cached prefix is stable within a profile; an unpriced model on either side
  leaves the guidance out. When worker borrows from main, the Models tab's
  profile cards and the King Louie panel say so.
- An agent-panel run (parallel, serial, with-deps) takes one `snapshotModels`
  when it starts and passes it to every agent's `createAgentRuntime`.
- Every routed call's `llmMetrics` carries `role`, `profileId`, `failover`
  and `borrowedFrom` (stamped by the router from `routedProvider({ meta })`)
  and `pricingUsage`; record usage with `UsageTracker.eventFromMetrics(m)` so
  the role and `pricingUsage` reach the tracker (case orient, classify and
  draft do). Ingest's model calls are not routed: `createCallModel` records
  OCR as `vision` and extract/verify under the role its caller passes (the
  case role's model role). A reply's `llm` has `subagents` and `byRole`
  (`summarizeTurnLlm`; a borrowed role's entry keeps `borrowedFrom`, shown as
  "worker (main) $0.20"); `UsageTracker` totals by role and model.
- The King Louie profile (`src/models/suggester.js`, `src/models/king-louie.js`)
  only proposes; the first Accept creates it, and only Accept (or
  `models.kingLouie.autoAccept`) changes it. Custom roles are saved through
  `Profiles#saveCustomRole` and never removed while a profile or case role
  names them.
- `king-louie-service models status|refresh` and `profiles list|show|set-default`
  work on the data dir; the writing ones refuse while the service runs.

## LongHaul (session memory benchmark)

`src/longhaul/` and `bin/longhaul.js` (spec
`docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md`; stage
B0 scores evidence recall; stage B3 adds the answer stage and reports). It is
Electron-free, may use `src/history/` and `src/providers/`, and nothing else in
`src/` may require it (`tests/longhaul-boundary.test.js`). It is left out of the
Electron build.

- Data lives in `LONGHAUL_HOME` (default `~/.longhaul/`: `private/`,
  `sessions/`, `questions/`, `runs/`, `reports/`, `tmp/`). The CLI refuses a
  `LONGHAUL_HOME` inside a git working tree, and any of those subdirectories
  that resolves into one or out of the home. `kl-recall`'s temporary history
  store (the session's full text) lives in `tmp/`, never the system temp dir;
  `run` removes `kl-*` dirs an interrupted run or `embed` left there (`embed`
  uses `kl-embed-<pid>` and removes stale ones itself). Never put a real
  session under the repository. Only the synthetic fixtures in `tests/fixtures/longhaul/` are
  committed. Regenerate them with
  `node bin/longhaul.js synth --out tests/fixtures/longhaul`;
  `tests/longhaul-synthetic.test.js` fails when they drift.
- Smoke run (no models, no network):
  `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle`.
  `oracle` must score evidence recall 1.000. Evidence recall counts only
  evidence shown whole; evidence shown in part (a cut or shortened message,
  some of its chunks, a folded tool call) is reported as `partial`. Any
  message shown whole or in part at or after `askAtSeq` is a leak and exits 1. Add `kl-recall` to the adapters to
  measure recall itself. Answer containment (`answerContained`, strict
  normalized substring; `answerTokensContained`, looser) is a secondary,
  judge-free column; `oracle` scores below 1.0 on it wherever an answer is a
  paraphrase, so compare adapters against oracle's containment, not 1.0.
- `longhaul import` reads Claude Code JSONL transcripts and King Louie chat
  exports (`.json`), picking the importer with `detectImporter`
  (`src/history/importers/index.js`); ids default to `cc-<hash>` / `kl-<hash>`.
- Session files are read with `readJsonlLines`
  (`src/history/importers/jsonl-lines.js`), never `node:readline`: readline
  also splits lines at U+2028/U+2029 inside JSON strings.
- `longhaul verify --session <id> --reviewer <initials>` reviews candidate
  questions in the terminal; add `--web` (`--port <n>`, `--no-open`) for a
  browser page (`src/longhaul/verify-web.js`, static files in
  `src/longhaul/web/`). It binds 127.0.0.1 only, every API call needs the
  per-run token from the printed URL's `#fragment`, other `Host` headers are
  refused, and nothing leaves the machine (no external assets, strict CSP, no
  session text in logs). Both flows share the rules in `src/longhaul/review.js`.
  The page sets session text with `textContent` only;
  `tests/longhaul-verify-web.test.js` fails on `innerHTML` in `verify.js`.
- `longhaul author` calls a real model with a key from the environment
  (`OPENAI_API_KEY`, ..., through `ProviderFactory.fromEnv`). Unit tests inject a
  fake client or point `--base-url` at `tests/helpers/fake-llm-server.js`.
  It refuses a private session (exit 2) unless `--send-private` is passed,
  since that sends spans of the session to the provider.
- `longhaul embed --session <id> --provider openai --model text-embedding-3-small
  --send-private [--batch 100] [--max-usd 1]` embeds every chunk of a session
  (chunked as kl-recall's store chunks it, keyed by message id and chunk idx)
  and its questions, through `OpenAIProvider#embed`, into
  `LONGHAUL_HOME/private/embeddings/<session>/<model>/` (`meta.json`,
  `index.jsonl`, little-endian float32 `vectors.f32`, `questions.jsonl`;
  `src/longhaul/embeddings.js`). That cache holds private data and never
  leaves `LONGHAUL_HOME/private`. Re-running skips what is cached; it refuses
  a private session without `--send-private`, and an estimate over
  `--max-usd`, before any request, and prints counts, tokens and the catalog
  price only, never text. The `kl-recall-vec` and `kl-recall-vec-only`
  adapters (an H3 probe, not a candidate system) fuse cosine top
  `vectorTopK` with BM25, or use cosine alone, and refuse a session whose
  cache is missing or incomplete. Tests use
  `tests/helpers/fake-embedding-server.js`.
- `kl-recall-rerank` / `kl-recall-vec-rerank` use the app's cross-encoder in
  the embed worker (models under `LONGHAUL_HOME/private/models`), scores
  cached under `LONGHAUL_HOME/private/rerank/`. `longhaul embed --provider
  local --model <org/name>` and `run --embed-provider local` use the app's
  local embedder; nothing leaves the machine, so no `--send-private`.
  Summaries count questions with an empty tail. Tests inject a fake `scorer`.
- The answer stage (B3): `longhaul run ... --answer-provider <p> --answer-model <m>
  --judge-provider <p> --judge-model <m>` adds answer accuracy (answerable questions
  judged `correct`), abstain accuracy (abstain questions the model declined) and the
  false-answer rate. The judge never sees the context and is never the answer model.
  Prompts are `src/longhaul/prompts/*-v1.md`; a change is a new versioned file, and
  every run's `config.json` records their hashes. Adapters added: `full-history`
  (the frontier tier only in the answer stage, and evidence-only runs; capped at the
  answer model's window, 128K when unknown), `real-compaction` (sessions with recorded
  compactions only), `summarize-compact` (a summarizer model every 10K tokens, answer
  stage only) and `kl-recall-whole` (the whole-message comparison the summary prints).
- Before any call, a run prices its plan from `Catalog#price` (input at 3 characters a
  token, output at max tokens: a close bound, not a guarantee; a spend guard stops the
  run at the cap and never resets within it) and refuses over `--max-usd` (default
  $50) or with an unpriced model unless `--allow-unpriced`; `--dry-run` prints the plan
  and calls nothing. `--tier frontier --sample 150 --long-context-sample N` is the
  headline sample. `full-history` and `real-compaction` are capped at what the answer
  model's catalog window holds (128K when unknown). A private session needs
  `--send-private` for the answer stage too. `runs/<id>/spend.json` is rewritten as
  the run goes, with `stoppedBy` when a run stops (`SIGINT` on Ctrl-C); a priced reply
  that reports no usage is charged at its estimate (`estimatedCalls`), never $0. In the
  answer stage and `--dry-run`, a `kl-recall-vec*` question with no cached vector
  refuses the run (`EMBEDDINGS_MISSING`): run `longhaul embed` first. Run no other `longhaul` command on the
  same `LONGHAUL_HOME` while a run is going: `run` starts by removing `tmp/kl-*` dirs,
  which would delete another run's contexts or an `embed`'s temp store.
- Model calls are cached under `LONGHAUL_HOME/private/model-cache/` (answers, verdicts,
  summaries: private text), so a rerun or a resumed run pays only for missing calls.
  Records hold verdicts and numbers only; the 10% judge sample is
  `private/spot-checks/<runId>.jsonl`, reviewed with `longhaul spot-check --run <id>
  --reviewer <initials>`. `longhaul report --runs <id>,<id>` writes publishable
  aggregate tables to `reports/<id>/` (`--public` refuses private runs); a series
  there is one adapter configuration at one tier, answer model, judge model and
  full commit, with one setup (`setup:` hashes the max tokens and prompt hashes).
- `kl-recall-jev-rerank` / `kl-recall-vec-jev-rerank` rerank with Jev
  (`--jev-mode batched|pointwise`, `--jev-model jev-1.13.0`,
  `--jev-max-tokens` (20M), `--jev-base-url`, key `TYPESAFE_AI_KEY`); scores
  are cached under `LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/`,
  a private session needs `--send-private`, and the cost is input tokens with
  the price unknown. In the answer stage and its dry run they are cache-only
  (`JEV_SCORES_MISSING`): run the evidence-only run with the same settings
  first.
- A quota refusal (402, OpenAI `insufficient_quota`, Anthropic's
  credit-balance 400 or `billing_error`) is never retried and stops a run
  like a refused key: `QUOTA`, exit 2, `spend.json` `stoppedBy: 'QUOTA'`. A
  plain 429 is still retried, Gemini's "exceeded your current quota" per-minute
  429 (`RESOURCE_EXHAUSTED`, a retry delay) included. A Jev adapter with no
  `TYPESAFE_AI_KEY` stops at its first uncached question (`JEV_NO_KEY`).
- Smoke run of the answer stage (no models, no network, $0):
  `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle,summarize-compact,real-compaction --fake-models`.

## Cases

`src/cases/` implements case repositories (spec:
`docs/superpowers/specs/2026-09-22-king-louie-cases-design.md`). A case is a
git repo under `<dataDir>/cases/` (override with `settings.cases.root` or
`KL_CASES_ROOT`), so **`git` must be on PATH** for anything that creates one.

- A chat with `caseId` runs every turn in case mode: `CaseRuntime.beginTurn`
  locks the case and builds the orientation, `endTurn` commits.
- The model writes the case only through the `Ledger`, `Brief`, `Decide` and
  `Recommend` tools. `facts.jsonl` is append-only; never rewrite it in code.
- Tests that create cases use a temp root. The e2e suite sets
  `KL_CASES_ROOT` before launching the app so the real profile is untouched.
- `provenance: 'user'` (a Ledger assert, and the Brief owner-only fields `why`,
  `hardConstraints`, `alreadyTried`) must carry a `quote` that appears in
  `caseContext.ownerMessages`. The chat send path fills that list with the
  owner's own messages. Without a match, the tool refuses. Tests that exercise
  user provenance must supply `ownerMessages`.
- Only `user` provenance is host-verified. `sourced` is model-declared, so a
  sourced fact is only as good as the source the model names. The write guard
  covers Write, Edit and MultiEdit, not Bash: in stage 1 a shell command can
  still rewrite `facts.jsonl`.

## Cases: unattended (stage 2)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md`.

- Status (`case.yaml` `status`, `statusReason`) changes only through
  `CaseRuntime.setStatus`, which requires a `kind` naming why (`src/cases/status.js`'s
  `REASON_KINDS`) and refuses without one; `status.js` also holds the
  transition table and the per-status tool rules. Every case tool checks
  `assertWritable`; `Decide`, `Recommend` and `Fail` also call
  `requireReoriented`, which refuses when no turn is registered, so tests that
  call them begin a turn first.
- Wake-ups: the protected cron system job `cases:wakeups` (every minute,
  `ensureWakeupJob`) calls `CaseRuntime.runDueWakeups`. A wake-up turn makes one
  `orient` call (charged like any other usage), then runs a `judge` loop
  confined to the case tools plus Read, Glob and Grep (`allowedToolNames`,
  `denyAutoApproval`, no owner messages). A wake-up that fails backs off
  through `retryBackoffMinutes` and briefs the owner on the third strike.
  Settings: `settings.cases.wakeups`; off with `enabled: false`.
- Budgets live in `.kl/budget.json`. `usd` and `deadline` at 100 % pause the
  case and record `statusReason.resumeTo` (the status to return to); per-day
  categories refuse their action until the local day rolls over. Raising a
  limit applies only through two host-verified paths, checked in
  `CaseRuntime.applyOwnerFact`: an answer to a host-created `budget-grant`
  question (routed through `CaseRuntime.answerQuestion`; a grant reply is just
  the amount), or an owner action (the case panel's Grant button,
  `CaseRuntime.grantBudget`, which validates the limit and writes an
  `owner-action`-sourced fact before applying the effect directly, no
  question involved). A model-created question or a quoted user-message fact
  naming the same budget subject/attr is recorded but changes no limit, so an
  owner's quoted "ok" in chat cannot self-serve a raise.
- Resuming from `needs-direction` is not limited to those two paths: any
  host-verified `user`-provenance fact with subject `direction` resumes the
  case in `applyOwnerFact`, whether it came from answering the `direction`
  question or from a quote-verified user-message fact recorded straight from
  chat (`caseContext.ownerMessages`) — the direction does not need to run
  through a question first.
- Questions live in `.kl/questions/`. Create them with
  `CaseRuntime.createQuestion`; answer them only through
  `CaseRuntime.answerQuestion` (exactly one host-verified `user` fact).
- Case-file writes outside a turn go through `CaseRuntime.systemAction`. Tests
  inject a fake clock with `new CaseRuntime({ now })` and a temp root.
- On shutdown, `create-core.js`'s `shutdown()` stops cron, calls
  `CaseRuntime.beginShutdown` and `abortUnattended` (blocking any new wake-up
  turn and signalling in-flight ones), awaits the in-flight `cases:wakeups`
  sweep (`wakeupsInFlight`, bounded by `shutdownTimeoutMs`), then calls
  `CaseRuntime.releaseAll` so a turn cut off by quit doesn't leave its case
  locked. The e2e suite runs every launch on its own throwaway
  `--user-data-dir` (see Testing above), so it never touches a real case
  store.

## Examples

`examples/` (fleet node configs, runbooks, sudoers, the Windows ACL script,
MCP client configs) and `docs/install-guide.md` hold invented values only.
`tests/examples.test.js` loads every example through the real loaders
(`loadNodeConfig`, `loadServiceConfig`, `RunbookEngine`), and
`tests/examples-e2e.test.js` runs every example runbook with its programs
faked. A new value in either place must pass `scanForPersonalValues` in
`tests/helpers/example-denylist.js`: `example.com` hosts, documentation IP
ranges, `+15550100`–`+15550199`, `<placeholder>` path segments.

`node.yaml`, and `features.*`/`ports.*` in the admin `service.json`, reject
unknown keys. A stage that parses a new `node.yaml` top-level key appends it to
`NODE_YAML_KEYS` in `src/service/node-config.js` in the same change. A new
feature or port is known once it is in `DEFAULT_FEATURES`/`DEFAULT_PORTS`, and
the four `examples/fleet/*/service.json` files must list it too.

## Attached mode

The desktop app can be a window onto a local `king-louie-service` (fleet stage 7,
spec `docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md`). The service
opens a loopback desktop bridge (`127.0.0.1`, default port `18796`) behind
`features.desktopBridge` in `<configDir>/service.json`, which is **off by default**
and binds to loopback only; port `0` (ephemeral, test-only) logs a warning. In
attached mode `main.js` builds no core and `src/ipc/attached-host.js` proxies the
allowlisted channels (`src/desktop-bridge/allowlist.js`; a stage whose domain must
work while attached appends it to `PROXIED_DOMAINS`).

- **Pairing:** start from Settings > Local service, then run the command it shows
  as root/Administrator: `king-louie-service desktop pair <request>`. The CLI
  prints the device's label and fingerprint first and asks "Trust this device?
  [y/N]" on a TTY (default no); off a TTY it needs `--yes` or refuses (exit 2).
  Nothing is written, not even a new node identity, before that consent. `--yes`
  passed to any other command is a usage error. The desktop's Confirm step passes
  the `nodeId` it displayed, and the desktop controller
  (`src/ipc/desktop-controller.js`) refuses with `PAIR_SERVICE_CHANGED` (the
  record changed), `PAIR_NOT_FOUND`, or `PAIR_CONFIRM_STALE` (no `nodeId`)
  rather than trust a stale or swapped record. Pending pairs expire. On Windows
  the bridge-file trust read is a PowerShell child process; keep it async
  (`readTrustedBridgeFile`), never on a synchronous path in the main process.
  Also `desktop unpair <device-id>`, `desktop list`, and
  `import --from <desktop userData> [--dry-run]` (service stopped; secrets only
  arrive through the desktop's own Import, never the CLI).
- **Detach** is a two-step confirm in the settings pane: the warning must render
  before "Detach anyway" is armed, and the second click only confirms if at least
  400 ms have passed since the warning painted — a fast double-click re-arms
  instead of detaching.
- **Unpair** forgets the pairing on the desktop and returns the administrator's
  follow-up, `king-louie-service desktop unpair <device-id>` (with `sudo` off
  Windows), which removes the device on the service side; the pane keeps showing
  it, surviving repaints and relaunches, until the owner dismisses it or starts
  pairing again.
- `--kl-standalone-once` runs one standalone session without changing the
  persisted mode: it turns channels, gateway, mesh and webhooks off from
  construction and builds cron paused (`createCore({ cronStartPaused: true })`,
  never started), so it can't act as a second consumer alongside the service;
  the `/llm` channel commands (Telegram/Slack/Discord) refuse while channels are
  off, before saving anything. Case wake-ups pause too (they run from the paused
  cron), including retries queued when a question is answered, because the
  desktop's cases may already have been copied into the service.
- Over the bridge, `settings:runLlmCommand` refuses the `/llm` channel actions
  outright (`CHANNELS_NOT_PROXIED`): channels are managed on the service.
- **Permission rules** the desktop adds are tagged `origin: 'desktop'` and are
  consulted only when no service rule matched (`src/tools/permission-rules.js`),
  so a desktop `allow` never lifts a service `deny`; service rules keep plain
  first-match order.
- A failed host start (attached or standalone) shows an error dialog
  (`dialog.showErrorBox`) and quits rather than leaving a half-started app.
- Only events marked by `markLocalDesktopEvent` (the standalone host's ipcMain
  wrapper and the bridge dispatcher; `src/core/origin.js`) get the on-screen
  approval dialog in the service.
- **`import --from`** never lets an administrator write the data dir directly.
  On POSIX, a root reader walks the desktop profile and a separate writer child
  drops to the data dir owner's uid and primary gid before running the importer;
  the master key is resolved read-only by the root reader and handed to the
  writer only over their stdio channel, never argv/env/logs. It refuses when
  there is no key yet (start the service once first) or the data dir doesn't
  exist. Windows has no setuid, so writes instead go through a write guard
  (`src/platform/write-guard.js`) that refuses a path routed through a symlink
  or junction; the guard narrows the window but can't close it against a
  service-account swap mid-write — documented as a residual, not a promise.
- **Lockout:** a handshake with a valid device signature is never refused by
  lockout; only further *failing* attempts for an already-locked-out device id
  are refused, closed `4429` at once (no delay is added).
- **E2E:** `launchAttached()` in `tests/e2e/helpers.js` starts a temporary
  service (`tests/e2e/_attach-service.js`, stub provider), pairs, attaches and
  relaunches; `ctx.service` has `kill()`, `restart()`, `stop()`. Every launch
  (attached or not) gets a fresh temp `--user-data-dir`, asserted by the app
  itself; `KL_CASES_ROOT` and `KL_DESKTOP_BRIDGE_FILE` are pinned per launch so
  an agent shell's own env never leaks in, and the forked test service pins its
  own `KL_CASES_ROOT` under its data dir. The old `KL_TEST_BRIDGE_*` escape hatch
  is gone.

## Approvals and relay

Fleet stage 3 (spec `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`, wire protocol
`docs/protocol/approval-v1.md`). On a service node, an unsafe remote tool call or `unsafe` runbook runs
only after an enrolled phone signs an approval over the exact action; only `=== true` approves. The
service only reads the approver set in `<configDir>/approvers/`; the admin CLI writes it. On Windows
the files carry no owner check, so the service trusts `approvers` only while (a) it cannot create a
file there (re-probed on every scan) and (b) the dir is owned by Administrators, SYSTEM or the config
dir's owner, and the config dir is not owned by LOCAL SERVICE (re-read when either dir's ChangeTime
moves). A dir's owner can always rewrite its ACL, so (b) is what stops a service-owned dir from
locking itself. `install` creates both dirs Administrators-owned, read and execute only for the
service. When the service runs as the same account that owns the config dir (a hand-made layout, like
the e2e test), the owner check cannot tell them apart.

- Relay host (admin `service.json` `relay` block; the mesh listener must be a loopback or private IP):
  `king-louie-service relay run`, `relay code <node-name>`, `relay nodes`, `relay remove-node <name>`, `relay qr`.
- Node, as the administrator: `king-louie-service pair wss://<relay-host>:<port>` and type the code at its
  prompt (piped on stdin also works), set `approvers.relay` in `node.yaml`, start the service, then
  `king-louie-service enroll-device`. The pairing proof binds the whole identity and `pair` refuses a
  missing or mismatched TLS fingerprint; after a refusal, run `relay remove-node <name>` on the relay and
  get a new code. `enroll-device` enrolls only on `y`/`yes` at its `[y/N]` prompt, which expires with
  the code.
  Enrollments and revocations relayed from phones are staged per node: apply them with
  `king-louie-service device apply` (`--yes` skips the `[y/N]` prompt, never the signature checks);
  `device list`, `device revoke <device-id>`.
- `mcp` asks through the running service (file courier); with the service stopped every unsafe runbook
  is denied at once.
- Audit: `<dataDir>/audit/ledger-YYYY-MM.jsonl`, hash-chained; `doctor` verifies the chain.
- Tests: `tests/approvals-*.test.js`, `tests/frontdoor-*.test.js`, `tests/audit-ledger.test.js`,
  `tests/service-cli-devices.test.js`, `tests/service-cli-relay.test.js`. Vectors live in
  `tests/vectors/approval-v1/`; after changing a message, run `node tests/vectors/approval-v1/generate.js`
  and commit the files (`--check` must say `41 vectors match`). `tests/approvals-e2e.test.js` spawns real
  processes and runs on Windows or as root; on Windows it denies itself write access to a temp
  `approvers/` dir with `icacls` (as an installer's ACL would) and lifts the deny before cleanup.
- Mobile apps (`mobile/`, built from `docs/protocol/approval-v1.md`): protocol-core tests are
  `swift test` in `mobile/ios/KLProtocol` (macOS) and `../gradlew test` in `mobile/android/protocol`
  (JDK 17, no Android SDK); both read `tests/vectors/approval-v1`. `mobile/PRIVACY.md` says what the
  relay operator can see.

## Cases: executors (stage 3)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage3-executors.md`.

- Executors live in `src/cases/executors/`. `ExecutorRegistry` resolves
  built-ins (`bash`, `files`, `web`, `browser`, `workflow`, `runbook`,
  `owner`), configured external agents, the per-case `override` in
  `.kl/executors.json` (narrowing only) and the floors (an outbound capability
  forces `outbound: message`, `authority ≥ envelope`). The floors come from
  the base capabilities before the case override: an override narrows the
  tools but never lowers the gate mode or the authority.
- External agents are packages with a `kingLouie.executor` block, loaded only
  from `<dataDir>/executors/` (desktop) or the admin `service.json`
  `executors.packageRoots` (service), and only with a matching
  `packageSha256`; `executors:list` shows the hash to pin. Secrets are
  `${vault:<key>}` references. The reference package is
  `examples/executors/phone-agent/` (errands API: `openapi.yaml`).
- The model plans with `Plan` and sends with `Executor`; senders send
  `rendered`, the gated payload. What each kind of job gets:
  - External agents and the browser: every string leaf through `gateLeaves`
    (`src/cases/gates.js`), in `message` mode when the executor has an
    outbound capability, else `query` mode. The statements of declared
    `payload.facts` are gated too; they leave with the facts' values.
  - An owner-approved envelope (`.kl/envelopes/`) is needed only when the
    executor's authority is `envelope` or `signed`. An external agent whose
    admin entry says `authority: none` and that has no outbound capability
    sends without one, in `query` mode, with only disclosable declared facts.
  - Workflow research tasks and runbook `params`: `query` mode, no envelope.
  - In text, facts are quoted as `{{f-0042}}` references.
- Only a clear 4xx refusal fails an external submit. A timeout
  (`submitTimeoutMs`, or `host.fetch`'s `requestTimeoutMs`), a network error
  or a 5xx leaves the job `submitting` with its contacts held; the next turn
  start or sweep finds it by `externalRef` or resubmits it with the same
  idempotency key; after `maxPollErrors` unconfirmed tries it is `unreachable`,
  its contacts still counted. Cancelling it asks the executor by `externalRef`
  and cancels what it took. The sweep fetches executor statuses before it
  takes the case lock and applies them inside it, each result once, and never
  over a newer poll.
- `external-agent` facts are written only by `Executor.results`;
  `brief.resources.ownerLabor` only by `syncPlan`. Tests that need a case with
  executors use `tests/helpers/executor-fixtures.js` (a temp data dir, a fake
  pinned package) and `tests/helpers/fake-errands-server.js`.
- In a case turn the browser tools only look and click, `WebFetch`/`WebSearch`
  are gated in query mode, and no tool writes ops memory, the executors folder,
  workflow files or the settings and vault stores (`chat-data.json`,
  `config.json`) in the data dir. `Bash` is not guarded.
- Envelopes activate when the owner approves the envelope question in the app
  or remotely (the question is `mcpAnswerable`), on the desktop and in
  service mode alike. Only an executor that declares `authority: signed`
  needs the phone: its envelope activates only on a verified phone signature
  over the live envelope hash. This is an owner decision and a deliberate
  exception to trust principle 3 for envelopes. An in-app Reject of a signed
  envelope rejects it and withdraws the phone request.
- Known gap (stage-1 Bash write guard), documented, not fixed: envelope files
  are not protected from `Bash`. The envelope hash includes `authority` but an
  `envelope`-authority hash has no key, and `envelopeFit` reads `status`
  from the file, so Bash can write an `active` envelope that no owner
  approved. The approval-gated `Git` tool can restore a revoked envelope
  (`revoked` is a file field outside the hash). Signed envelopes still need
  the phone grant.
- The outbound gate: `{{f-NNNN}}` renders only an active, disclosable `user`,
  `sourced` or `external-agent` fact (inside the envelope's `facts` when there
  is one). Rule 1 (both modes) blocks a pasted value of an inferred, unknown,
  non-disclosable or superseded fact, after NFKC folding and with grouped,
  locale and scaled number forms; object keys and number leaves get rule 1
  only. Rule 2 (message mode) blocks category keywords while the case holds a
  private fact of that category. Rule 3 (message mode) blocks a date, price,
  deadline or commitment that no `user` or `sourced` fact or approved wording
  backs. Rule 4 blocks C7 entity spans. Known gaps: homoglyphs (confusable
  letters are not folded), values split across sentences or leaves,
  spelled-out amounts, URL-encoded or joined text values, and the Bash
  write-guard gap above. The detectors are English only and fail closed.
  `query` mode runs rule 1 only.
- Browser jobs always run in the `kl-cases` browser profile (refused while the
  browser is open in another profile) and stay on the approved origin: a
  redirect or a field-triggered navigation off it stops the job before the
  next fill or click. A failure after the submit click counts as sent.
- Executor packages are pinned by `packageSha256` over their own files and
  must not contain `node_modules` (nor may the root or any directory between
  it and the package); bundle dependencies. `type: module` packages are
  refused. In service mode the package roots and every entry below them must
  be owned by the admin (the `adminUid` that owns `service.json`). An adapter
  runs with full privileges once loaded.
- `external-agent` provenance is host-only: the Ledger tool refuses it, and it
  never counts as the owner. It never satisfies rule 3, and a result that
  contradicts a `user` fact records a load-bearing conflict unknown instead of
  superseding it.
- The global daily cap (`constraints.contactsPerDay`) is shared by every case
  on this data dir (`<dataDir>/executors/usage.json`, under a mutex) and keeps
  its time zone until the local day rolls over. The desktop and a service node
  keep separate counters.
- The case guard (`src/cases/executors/case-guard.js`) runs for case turns and
  for any child run that carries a `guardContext` (`{ caseId }`). A case's
  research children are isolated `case-researcher` runs: no memory, profile or
  project context, only `WebSearch`, `WebFetch`, `Read`, `Glob` and `Grep`,
  never more than the parent's tools. `SpawnAgent` is refused in every case
  turn, since it would start an unguarded child.
- Fixtures and docs use invented values only (`Lakeside lot`, `+15550100`,
  `errands.example.com`); no personal names, numbers, paths or domains.

## Cases: detours and the cross-case index (stage 5)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage5-detours.md`.

- The cross-case index is `<casesRoot>/.index/` (`src/cases/index-store.js`,
  BM25). It is a cache: deleting `.index/` is always safe, and IPC
  `case:reindex` rebuilds it. Private facts never cross cases: a hit from
  another case carries text only for a `disclosable: true` fact or a brief
  `title`/`objective`; every other cross-case hit is `text: null, redacted:
  true`. Never pass `includePrivate` outside `index-store.js`; a test greps
  `src/` for it. A redacted hit counts as a duplicate (Ledger `unknown`,
  Ask) only by its key or with at least two matched query tokens, so a
  one-word probe cannot confirm another case's private value.
- `CaseRuntime.createCase` refuses an open case with the same or a close
  title/objective (`SimilarCaseError`, `code: 'SIMILAR_CASES'`) unless
  `force: true`. The model can never pass `force` itself — no case tool
  accepts it — it flows only from the owner's own choices: IPC `case:create`,
  and a detour's similar-case question. When a detour routed to "new" (from
  any channel) meets the similar-case refusal, the router re-proposes it as
  a pressed `detour-similar` question in the case (`mcpAnswerable: false`,
  never charged; posted as a card and sent up the ladder like any question)
  with "Create anyway" and one "Attach to <title>" per similar case (at most
  three; when the similar case is the detour's own, it is named as "this
  case" and "Attach to this case" keeps the work there). A press in the app (`case:answerQuestion`) or on the phone is
  applied at once (`answer-handlers.js` runs the router's reconcile);
  "Create anyway" creates the case with `force` only when the recorded
  answer to that question is that option from `in-app` or `mobile`, so
  `answer_question` (it is pressed), an answer recorded on `in-app-chat`
  and a model mapping words to it are refused. `DetourRouter.resolve` and `case:resolveDetour` take no `force`.
  Answering "new" alone never forces. Tests that create
  several cases sharing a title or an objective pass `force: true`.
- Detours live in `src/cases/detours/` and `.kl/detours.jsonl`. The owner's
  message is classified (`classify` role) after `UserPromptSubmit` passes; a
  host without an inference router skips it, and the classifier fails open —
  a timeout, a call error or a malformed reply is always treated as on-case
  (never as a detour), with at most one `detour` journal line per turn.
  Routing answers are applied at turn start, from `case:detours` and after
  `case:resolveDetour`.
  A failed resolution re-proposes the detour with `retryOf` set to the
  chain's first id; once any detour of that chain is attached or created,
  the others get a `superseded` row, their open routing question is closed
  and their `pending:` blocker is removed.
- A routing question is a spoken question and can be answered from any
  channel: in the app (its chat card, answered in words through
  `answer_question`; IPC `case:resolveDetour` remains, though the case
  panel no longer has a detours block) or by an agent session's
  `Detour.resolve`, over any C4 contact channel (Telegram, Discord, email,
  SMS, voice, the phone app), or through `answer_question` on `mcp-stdio`
  or on the front door under `cases:answer`. A contact-channel answer is
  applied at the next turn start, `case:detours` or `case:resolveDetour`.
  The first answer stands: a later, different answer gets no C4 conflict
  follow-up, only an ack saying the first answer stands (`contact.js`
  `_apply`, ruling INT-detour), and changes are made in the app. C5 has no
  re-route API, so changing a routing already applied is a manual step
  there. `delegate` remains a future source. Routing questions keep
  `mcpAnswerable` at its default of `true`.
- Case types are code in `src/cases/case-types/` (`general`, `outreach`,
  `software-repo`); `case.yaml.type` is validated at creation. A
  `software-repo` case runs read-only `git` and `gh` at turn start (tests
  inject `host.exec`); `gh` uses its own login. Its `repo` brief field
  (owner-only) must match a whole whitespace-separated token of the owner's
  quote — never a prefix, a substring, or text assembled across tokens.
- `case.yaml` `related` is written only by `CaseRuntime.addRelation` and
  `removeRelation`.

## Cases: contact channels (stage 4)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage4-channels.md`.

- Every open question in every case goes up a contact ladder
  (`src/cases/ladder.js`): `settings.contactPolicy.ladders[urgency]`, or
  `case.yaml` `channels` (`call` = `voice`). One process per cases root runs
  it (`<casesRoot>/.contact.lock`); its state is `<dataDir>/contact/`
  (`ladder.json`, `deliveries.json`, `inbox.jsonl`, `presence.json`).
- Answers from any channel go through `ContactRouter.handleReply`
  (`src/cases/contact.js`) and then `CaseRuntime.answerQuestion`. An adapter
  sets `ownerProven` only after its own check: Telegram and Discord accept
  only a private chat/DM with the contact owner id, and only from that
  sender; email must come from the owner's address, and have either an
  authenticated pass (the topmost `Authentication-Results` header) or the
  thread's `[KL-<token>]` token (`email-channel.js`); SMS needs the owner
  number plus `#TOKEN`; voice and SMS both go through the relay, and voice
  DTMF digits are owner-proven only by where the call was placed (the owner
  number), not by anything the caller proves; the phone app needs a
  device-signed envelope verified on the node. An explicit
  `#token` in a reply always beats reply-to/thread correlation, so a stray
  in-reply-to match can't steal an answer meant for a different question.
  Tokens are never rendered on a delivery-only channel such as ntfy
  (`caps.expectsReplies !== true` drops the reply footer), since there is
  nowhere for a reply to land. A different second answer never overwrites
  the first: the first answer stands, and a follow-up question asks which
  one stands, on the channel that gave the second answer
  (`contact.js` `_conflict`/`conflictFact`).
- Owner decision (M22, as amended by the management surfaces spec): a
  pressed question (`answerClass`; every `mcpAnswerable:false` one — a
  budget-grant, a budget-daily, a direction question, a commit-failed
  question, a wakeups-failing briefing — plus approvals and the other
  pressed kinds) is answered only by the buttons on its chat card or from
  the owner's paired phone. Every other channel (Telegram, Discord, email,
  SMS, voice) gets "Answer this in the app" instead of options or buttons;
  approvals are never persisted to the data-dir inbox, so a busy case
  refuses them outright rather than queuing them.
- The `in-app` rung posts the question into the case's chat (see
  Management surfaces); there is no Questions sidebar and no questions bar
  in the case panel. `in-app` keeps its place in every ladder. Presence is
  a heartbeat from window focus and input (`initPresenceHeartbeat`); away
  is set with the `set_away` tool (the contact host's `setAway` writes the
  stored policy's `away` field alone, validated as `setPolicy` validates
  it); the contact-policy editor (ladders, quiet hours,
  breakthrough, digest, channel readiness) is Settings > Contact, and a
  save there re-reads `away` first, so it keeps one set meanwhile. The contact policy is data-dir
  settings in service mode too; only the owner and addresses are
  admin-only.
- Case code that sends to a channel uses `ContactRouter.sendExternal`, which
  runs C3's outbound gate for anyone but the owner and sends `rendered`.
  Until C3's `gateLeaves` exists (`src/cases/gates.js`), every non-owner
  send is refused.
- Service mode: the owner identity and channel addresses come only from the
  admin `service.json` `contact` block (`contact` joins `ADMIN_ONLY_KEYS`);
  a data-dir `settings.contact` or a `channels.<ch>.contactOwnerUserId` is
  ignored with a warning. Relay tokens and mailbox passwords live in the
  vault under `contact.`; the `Vault` tool refuses any key starting
  `contact.` and hides them from `list`. A contact host that fails to start
  never fails `core.start()` — it logs the failure, leaves contact off, and
  (outside service mode) raises one owner-visible warning; the rest of the
  app keeps running; that includes a contact host that throws while being
  built, and an unreadable `presence.json` just starts presence empty. A
  host that is not currently holding the cases-root lease (a passive
  instance) refuses an inbound relay push with 503 and does not poll relay
  events or move the relay cursor, so the events wait for the active host
  (which dedupes by event id); Settings > Contact names the lease holder.
- Replies can trigger acks, and a spoofed owner number or From address is
  enough for SMS and email, so acks are budgeted in the router: at most one
  refusal ack (unknown token, unparsed, refused) per channel and sender per
  10 minutes, and 20 acks per channel per hour; the rest are dropped with a
  debug log. Email refuses `contact.email.from` equal to the owner address
  (it would read its own mail), marks everything it sends `Auto-Submitted:
  auto-generated` with a `<kl-…@from-domain>` Message-ID, and drops its own
  mail and RFC 3834 auto-replies.
- Known gaps, carried forward as PR notes rather than fixed here: a forged
  email DSN can trigger an early bounce escalation; the stage-1 gap that a
  local Bash command can rewrite `facts.jsonl` directly extends to a forged
  `inbox.jsonl` line for an ordinary (non-approval) question, which grants
  no more than that same class of local write access already does; an
  unauthenticated email from the owner's address (From is spoofable) whose
  text carries any live question or batch token answers that question or
  batch, not only its own thread's (knowing a live 30-bit token is treated
  as equivalent to knowing the thread; tokens are only ever sent to the
  owner); and an owner out-of-office reply that arrives through the relay is
  not recognised as automatic, because the relay `inbound` event (spec §4.5)
  carries no auto-submitted flag.
- Tests use `tests/helpers/loopback-channel.js` and the fake relay/SMTP
  helpers, never a real network; `KING_LOUIE_CONTACT_TICK_MS` shortens the
  tick.
- The phone app channel (`src/channels/mobile-app-channel.js`) exists only
  in the service with F3 approvals running: questions go out as node-signed
  `kl.question.ask` envelopes; an answer counts only as a device-signed
  `kl.question.answer` verified on the node (nonce, `signed_at` ± 300 s, live
  token), and it resolves only its own question. The relay routes are
  `src/frontdoor/question-routes.js`. The apps' Questions screen shows only
  questions signed by a pinned node and signs `signed_at` on the
  relay-corrected clock. Foreground presence is unsigned
  (`{ foreground, at }`), but the relay request carrying it is still
  device-authenticated, and on these phones the key needs biometrics: iOS
  pings every 60 s only while its API session is already unlocked (never a
  Face ID prompt of its own); Android sends no presence and loads questions
  only when the owner taps. Follow-up: a relay presence auth that needs no
  biometric prompt (an F3 pairing change) would let Android report presence.

## Front door

`src/frontdoor/` (fleet stage 4, spec
`docs/superpowers/specs/2026-09-23-fleet-stage4-front-door.md`) is the
`profile: frontdoor` service: one SNI listener for `mcp.<domain>` (OAuth, MCP,
F3's phone API, `/pair/v1`) and `mesh.<domain>` (pinned node links into F3's
relay). `docs/fleet/front-door.md` is the deployment guide. To run one
locally, give it `frontdoor.tls` with a self-signed certificate for
`mcp.kl.example.com` and a high port (`listen: { host: 127.0.0.1, port: 8443
}`), point both names at 127.0.0.1 in your hosts file, and run
`node bin/king-louie-service.js run --data-dir <tmp> --profile frontdoor`.

- **Delegate sessions and unsafe calls (owner decision M19).** A delegate
  session a node started itself (stdio, no front-door origin) is not refused
  here: its unsafe calls go to the phone, exactly like an unsafe runbook.
  Every other origin — a front-door client, a malformed origin, an unknown
  kind — fails closed (`shouldRefuseUnsafe` in `src/fleet/delegate-sessions.js`):
  refused unless the caller's grant covers `fleet:unsafe` for that node. A
  front-door client's unsafe call is never forwarded to the phone on its
  behalf; the scope check runs first.
- **Job visibility (ruling T11-owner).** A runbook job's cache entry has no
  owner, so any grant with `fleet:read` on the machine can read or watch it,
  and any grant with `fleet:run` there can cancel it (`cancel_job` needs
  `fleet:run`, `src/fleet/scope-rules.js`). A delegate job's entry is owned by the grant that started it
  (`FleetRouter._recordStart`, `src/frontdoor/router/router.js`); every other
  grant is told the job does not exist, even one with full access to the same
  machine.
- **SIGHUP** re-reads the admin approvers directory and the console node
  records (`src/frontdoor/console-removals.js`; a `frontdoor remove-node`
  made by hand while the service was stopped, or an approver revoked at the
  console, is audited/applied at the next start or `SIGHUP`), then the
  certificate (ACME or operator `tls`), in that order (`src/frontdoor/profile.js`).
- **Self-probe** (`src/frontdoor/probe.js`) refuses a DNS answer of loopback,
  unspecified or link-local for `mcp.`/`mesh.`, and pins the mcp. certificate
  by fingerprint; it does not refuse a private-LAN address (RFC 1918/ULA),
  a known limit.
- **Audit mirror breaks** (`src/frontdoor/doctor-checks.js`'s `BREAK_REASONS`:
  `fork`, `truncated`, `replay`, `withheld_entries`, `oversize_entry`,
  `oversize_page`, `wrong_node`, `malformed_head`, `mirror_state_corrupt`)
  each carry the owner's remedy in `doctor`'s own text. Acknowledging the
  alert on the phone clears doctor's "unacknowledged breaks" row only: the
  node's mirror status stays `broken` for good (nothing in
  `src/frontdoor/audit/mirror.js` sets it back). The documented reset
  (docs/fleet/front-door.md, doctor) is to stop the service, move
  `<dataDir>/frontdoor/mirror/<node_id>/` aside and start it: a fresh anchor.

Test helpers:
- `tests/helpers/test-certs.js`: CA, leaf and self-signed certificates in pure Node (never openssl).
- `tests/helpers/frontdoor-harness.js`: OAuth and MCP over plain HTTP with fake phones; `tests/helpers/oauth-test-client.js` speaks to it (and to a real front door over HTTPS with `tls: { ca, lookup }`).
- `tests/helpers/fake-node.js`: nodes as real `NodeFleetService`s behind a fake hub.
- Tests that start a whole front door (`frontdoor-e2e`, `frontdoor-bootstrap`) pass `deps.listen` with port 0 and a `lookup` that resolves the front door's names to 127.0.0.1.

## Playbooks (cases stage 6)

`src/cases/playbooks/` (spec: `docs/superpowers/specs/2026-09-23-cases-stage6-playbooks.md`). A playbook
is a data package (`playbook.yaml`, `steps.md`, optional `briefRules.md` and `sources.md`) vendored as a
plain copy into `<case>/playbooks/<name>/`, recorded in `case.yaml.playbooks[]` and `.kl/playbooks.json`.

- Playbooks are data. Validate with `validatePackage`; never `require` a path derived from a case or a
  package. Case types come only through `case-types-bridge.js` (C5's registry or its stand-in).
- Git for playbooks runs through `runGit` / `runGitSync` in `src/cases/git.js` (hardened `-c` flags
  including `core.fsmonitor=false`, the checked empty hooks dir outside every case, no prompts, 60 s
  timeout; a repo whose own config defines drivers or commands is refused with `GIT_UNSAFE_CONFIG`).
  Versions compare with `compareVersions`; there is no `semver`.
- Mutations (attach, adopt, update, remove, proposals) do network and temp-dir work first, then one
  `runtime.systemAction` (applying a proposal runs its git work inside it, so a race applies once).
  Owner gating questions become question records that never charge `questionsPerDay`; a `sourced` fact
  never satisfies an owner question.
- Playbook text shown to the model is framed with `frame()`, or reduced to validated fields and
  neutralised single lines (brief rules, gating keys and labels, materiality slugs). C3's executor
  section gives only a count of playbook brief rules; the draft prompt carries them to the executor.
  Package loads within one turn start share a memo (`beginEntriesScope`); anything outside it loads from
  disk. In a packaged build the `example:` playbooks are read from `app.asar.unpacked`
  (`build.asarUnpack`, `asarUnpackedPath`). The write guard covers `playbooks/`,
  `.gitmodules`, `.gitattributes` (at any depth) and `.git/`; the model changes a playbook only with
  `Playbook.propose` once the case is `done`. As elsewhere, Bash is not covered.
- Playbook IPC replies carry `untrustedText: true`: the renderer sets every playbook or case string with
  `textContent` (never `innerHTML` or markdown), and a proposal's patch shows in a `<pre>`.
- `case.yaml` is read with the strict parser (`parseCaseYaml`). A stage that adds a `case.yaml` key adds it
  to `CASE_YAML_KEYS` and to `tests/cases-store-yaml.test.js`.
- `playbooks.sources` is the allowlist (`example:` is always allowed); `autoUpdate` is separate from it.
  No `playbooks` block (the default `{ sources: [], autoUpdate: false }`) means no URL sources, local
  folders unrestricted, no auto-update. A local folder recorded in
  `.kl/playbooks.json` (case data) is read on update only under a matching `path:` entry, or after the
  owner confirms that one playbook (`confirmSource: true` with its `name`; a confirm without a name is
  refused). Tests build packages with `tests/helpers/playbook-fixture.js` in temp dirs.
- Where the allowlist comes from depends on the mode. On the desktop it is the owner's
  `settings.playbooks` (`sources`, `autoUpdate`). In service mode both come only from the `playbooks` block
  of the admin `service.json`, and the data-dir settings for them are ignored (with one warning). The
  admin block is stricter than the settings form: `~` is refused and every `path:` entry must be absolute.
- Attached, the `case:*` playbook channels are proxied to the service: `path:` sources and a
  proposal's `repoPath` are resolved on the service host as the service account, under the service's
  admin policy.

## Cases: document ingest (stage 7)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage7-ingest.md`.

- `src/cases/ingest/` stores documents under a case's `sources/` and reads
  them: the PDF text layer through `unpdf`, one-page copies through
  `pdf-lib` (both pure JS), and vision OCR through the existing providers.
  PDF parsing itself runs out of process (`src/cases/ingest/pdf-sandbox.js`):
  a separate worker process (spawned, no Node IPC), memory-capped, with
  wall-clock timeouts and framed stdin/fd3 I/O, so a hostile PDF cannot hang
  or OOM the desktop main process or the service. In a packaged app the
  worker is the app binary run with `ELECTRON_RUN_AS_NODE=1`, so PDF ingest
  needs Electron's `RunAsNode` fuse left on (the default: `package.json`
  `build` sets no `electronFuses`). Turning it off makes every PDF fail as
  unreadable; the `PDF worker failed` log names the fuse when the worker
  exits at once. Only the Windows x64 package has been checked. Proposals, text and page caches live
  in `.kl/ingest/` (the page cache, `publish.json` and C2's `budget.json` are
  written outside `systemAction`; everything else — records, sidecars,
  sources, the journal and facts — goes through it).
- Only the owner accepts a proposal (panel or a review question); accepted
  facts are `provenance: 'sourced'` and `disclosable: false` whatever their
  category, with a host-built, host-checked source. Accept-all re-checks
  everything that needs no model call at accept time (the stored bytes'
  hash, the quote re-read from those bytes, the proposal's fields, conflicts
  and duplicates) and skips on any difference; only the verify verdict and
  the origin stay record-trusted, the same Bash/import limit as
  `facts.jsonl` (a forged verdict can pass accept-all, but the fact stays
  private and owner-visible either way).
- The model reads document text with the `Ingest` tool's `text` action, not
  `Read`: `Read` on a file under `sources/` is an unguarded residual (no
  untrusted-output wrap, no cap) that the tool path exists to avoid.
- The entity index is `<casesRoot>/.index/entities.json` (derived; delete it
  freely). `CaseRuntime.entityIndex().nonDisclosableSpans(text, { caseId })`
  feeds C3's outbound gate (`gates.gateLeaves`); its documented residuals —
  what a disguised or split value can still slip past — are the comments in
  `src/cases/gates.js` and `src/cases/entities/fold.js`, not this file.
- In attached mode, a single file over about 47 MB is refused by the
  bridge's frame limit; add a document that large on the service host
  instead of dropping it from the desktop client.
- Tests generate PDFs in memory (`tests/helpers/ingest-fixtures.js`) and use
  `tests/helpers/ingest-harness.js`: a real `CaseRuntime` on a temp root and
  a scripted `callModel`, so no provider or token is needed. Call
  `svc.drain()` before asserting on a record.
- `king-louie-service mcp` runs no core and no ingest worker. With the
  service running on the data dir, its calls go through the courier to the
  service's `FleetToolHandler`, which on an agent node also serves the
  management tools (`src/mcp/case-tools.js`, channel `mcp-stdio`; see
  Management surfaces). With no service running,
  `mcp` serves the fleet tools only. No MCP channel answers a document
  review (`ingest:review`), whatever its `mcpAnswerable` says.
  Anything running as the service account can write the courier outbox
  and inbox, and so answer questions as `mcp-stdio` or forge the service's
  replies to `mcp` (a forged tool list is read only as names; `mcp` shows
  its own definitions): the same class of limit as Bash writing
  `facts.jsonl`.
- On the front door the case tools sit behind three scopes
  (`src/cases/mcp-tool-definitions.js`; registered from
  `src/frontdoor/tool-extensions.js`): `cases:read` (`list_cases`,
  `open_case`, `get_orientation`, `list_questions`, `list_envelopes`,
  `list_playbooks`, `get_presence`), `cases:answer` (`answer_question`,
  `set_away`) and `cases:manage` (`create_case`, `revoke_envelope`,
  `cancel_case_job`); the last two require `cases:read`. An admin enables
  them by listing them in `frontdoor.oauth.scopes_enabled`. Agent nodes
  serve them as `cases.<tool>` link methods, each with its own scope, on
  the `mcp-frontdoor` channel. Every tool in a write scope (all but
  `cases:read`) is limited per grant id to 30 calls in a sliding 60 s
  window (`FleetRouter`, `src/frontdoor/router/router.js`), refused with
  the node's `rate_limited` / `retry_after` shape. Only `list_cases` and
  `list_questions` fan out to every node (registered `fanout: true`);
  `registerTool` refuses a write tool declared fan-out, and a route that
  fans out for a tool not declared so is refused. `cases:write` is retired
  and never registered, so listing it in `scopes_enabled` stops the front
  door at startup. The pressed class is refused here as on every channel.

## Management surfaces

Spec `docs/superpowers/specs/2026-09-30-management-surfaces.md`; ADR
`docs/adr/0002-management-surfaces-mcp-first.md`; words in `CONTEXT.md`.

- One definition of the case management tools,
  `src/cases/mcp-tool-definitions.js` (no requires, deep-frozen; the front
  door loads it), served three ways by the one handler
  (`src/mcp/case-tools.js`): the front door (`mcp-frontdoor`, scopes
  above), `king-louie-service mcp` (`mcp-stdio`), and King Louie's chat
  tools (`src/tools/builtin/management-tools.js`, channel `in-app-chat`,
  always loaded, in every chat). Never in a wake-up
  turn: its `allowedToolNames` name only the case tools and
  `WAKEUP_BASE_TOOLS`. Never in a delegate turn either
  (`DELEGATE_EXCLUDED_TOOLS`; a front-door delegate reaches cases only
  through its own case scopes), and a run whose origin names a delegate
  job is refused by the tools themselves.
- In a case chat they act only on that case (owner decision Q27,
  2026-10-01): a case turn's context feeds that case's ledger and executor
  payloads, and the outbound gate knows only that case's private facts.
  The tools that act on a case (`CASE_SCOPED_TOOLS` in
  `src/mcp/case-tools.js`: the six read tools besides `get_presence`, and
  `answer_question`, `revoke_envelope`, `cancel_case_job`) take the
  handler's `caseScope`, which the chat tools set from the host's
  `caseContext` (or a child's `guardContext`), never from a parameter: the
  lists give that case alone, and a call naming another (or an unknown)
  case is refused `other_case`. `create_case`, `set_away` and
  `get_presence` are unaffected; a chat with no case keeps every case, and
  the MCP surfaces pass no scope.
- `in-app-chat` (the model relaying the owner's chat words) is not
  `in-app` (the card's buttons and the IPC: a press, no model between). No
  list that takes a recorded channel as proof of a press names it
  (`APP_ANSWER_CHANNELS` in `contact.js`, `PRESS_CHANNELS` in the detour
  router), and an ingest review refuses it like `mcp-*`.
- Read: `list_cases`, `open_case`, `get_orientation`, `list_questions`,
  `list_envelopes`, `list_playbooks`, `get_presence`. Spoken:
  `answer_question`, `set_away`, `create_case`, `revoke_envelope`,
  `cancel_case_job`. A question is spoken or pressed by `answerClass`
  (same module); the `case:questions` IPC puts it on every record it
  returns (`answerClass: 'spoken' | 'pressed'`, beside the recorded
  `answer`), and the renderer draws the card by it, with no copy of the
  rule. Pressed questions
  (approvals, money, direction, status, failures, ingest reviews,
  `detour-similar`, …) are refused by `answer_question` on every channel,
  in the chat (`in-app-chat`) included, and answered only by the card's buttons
  (`case:answerQuestion`, no model between) or the phone.
- Every spoken tool requires `quote`, the owner's verbatim words, at least
  three words on every channel (owner decision Q28, 2026-10-01; words are
  `Intl.Segmenter` word-like segments after the owner-quote fold, so a
  language written without spaces counts; a number run such as
  "1,000.00", "2026-10-05" or "12:30:45" is one token, and at least one
  word must hold a letter, so "go with 2" passes and an amount, date or
  time alone does not; shorter is refused `quote_too_short`). In-app,
  `ToolExecutor` puts its own `ownerTurnText` last in the execute context
  (never under `denyAutoApproval`) and the quote must appear in it on word
  boundaries after folding (`src/tools/owner-quote.js`, the browser
  `ownerQuote` check); a miss refuses. Over MCP the quote is recorded, not
  checked. The answer's fact is `provenance: 'user'` with the `channel`
  and the quote on its source. `create_case` never takes `force` (a
  `SIMILAR_CASES` refusal says to open the app); its objective must be
  words from the quote.
- In King Louie's chat, `revoke_envelope`, `cancel_case_job`, `set_away`
  and `create_case` (`ASKS_FIRST_TOOLS` in `management-tools.js`) go
  through the normal tool-approval prompt (`requiresApproval: true`), after
  which the quote is still checked. On a standalone desktop the
  always-approve list and permission rules lift it as for any tool. On a
  service node with phone approvals these four classify as `unsafe`
  (`classifyToolCall`: `tool_requires_approval`), and an `unsafe` tier
  cancels both, so they always go to the phone there. `answer_question`
  and the read tools never prompt. Every spoken tool is
  `requiresOwnerTurn`: on a run with no owner text (a gateway session,
  cron, `denyAutoApproval`) `ToolExecutor` refuses it `not_owner` before
  any hook, rule or prompt, so nobody is asked to approve a call that
  could only fail. The MCP surfaces call the handler directly and have
  their scopes instead (owner decision Q28, 2026-10-01).
- In a case chat a `create_case` refused `similar_cases` gets the message
  only, never the `similar` list (other cases' ids, titles and status, Q27).
- Options: the quote must name the chosen option, by its label on word
  boundaries or by its 1-based number when the number is the whole quote,
  is marked ("option 2", "number 2", "no. 2", "#2"), or follows "go with",
  "pick", "choose" or "select" and ends its clause ("go with 2", not "go
  with 2 weeks"). The option id never counts. Naming two options is
  `option_ambiguous`, none or another `option_not_in_quote`; both list the
  options as wrapped data. Free text records the quote itself.
- A question is posted when it is created: an assistant message in the
  case's most recently active chat (one is created when the case has
  none), with `question` metadata naming the record
  (`src/cases/question-chat.js`). It is an ordinary history row (tail,
  recall). The renderer draws a card from the question store, never from
  the message, and redraws it on `case:changed` whichever surface
  answered. A spoken reply is typed under the card and applied by the next
  turn's `answer_question`; the host never parses replies.
- Fleet tools in a service-run chat (`src/tools/builtin/fleet-chat-tools.js`):
  while the core has a `FleetToolHandler` (`startFleetNode` on an agent
  node calls `core.context.setFleetToolHandler`), the nine fleet tools are
  always-loaded chat tools, removed again at stop; standalone never has
  them. Calls carry a host-built origin of kind `service-chat`, which
  `shouldRefuseUnsafe` treats like stdio (an unsafe runbook still waits
  for the phone, after the usual tool approval). Wake-up and delegate
  turns (`DELEGATE_EXCLUDED_TOOLS`) never get them; case turns block the
  acting ones (`CASE_BLOCKED_TOOL_NAMES`) and keep the read ones. Attached, the turn runs in the service, so no new proxied
  domain is needed.
