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

The same drain runs the other way: a test that awaits an **unref'd** timer
(`withTimeout`, `AbortSignal.timeout()`) against a promise nothing else
settles has nothing holding the loop open, so node exits the file mid-await
("Promise resolution is still pending but the event loop has already
resolved") and cancels every test after it. Keep a ref'd `setTimeout` alive
across that await.

A Windows CI runner differs from a dev box in two ways tests must survive:
- Steps run under pwsh 7, whose `PSModulePath` reaches any node-spawned
  `powershell.exe` (5.1) and breaks its `Microsoft.PowerShell.Security`
  cmdlets (`Get-Acl` "could not be loaded", exit code still 0). `src/`
  avoids those cmdlets; a test that needs one spawns with
  `tests/helpers/windows-powershell-env.js`.
- `TEMP` is an 8.3 short path (`C:\Users\RUNNER~1\...`). Compare paths
  through `fs.realpathSync.native`, which expands it; the JS `realpathSync`
  resolves links but keeps the short name.

To reproduce both, run the suite from pwsh with `TEMP`/`TMP` pointed at the
short name of a long-named folder (`cmd /c for %I in ("<dir>") do @echo %~sI`).

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
  sends the query and about 100 chunks per rerank, in every chat but a case
  chat: a chat with a `caseId` is never sent and not reranked at all (owner
  decision 2026-10-06, per turn and `SearchHistory`; the fused order,
  `reranker: null`, `rerankSkipped: 'case-chat'`, no warning). One client, `TypesafeProvider` (decide-only: not registered, not
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
- H4 (scope, links, importers; plan
  `docs/superpowers/plans/2026-10-13-history-h4-scope-links-importers.md`,
  owner rulings R-H4-1 to R-H4-9 of 2026-10-13). Schema step 4 adds
  `chat_links` and `imports`. A chat's scope is `chats.history_scope`
  (`chat`, `linked`, `all`; default `chat`) and is never a field of the chat
  object (`rows.js` drops `historyScope`), so no import, export or
  `updateChat` patch can widen it. Outside the store, only
  `history:scope.set` and `history:links.set` (the chat menu's "Recall
  from" items and "Link chats…") write a scope or a link. Links go one way.
- Which chats a turn may read is decided in one place, on every turn and
  every tool call, from what is stored then: `resolveScope`
  (`src/history/scope.js`) with the app's policy, `createScopePolicy`
  (`src/history/scope-policy.js`; `core.context.resolveHistoryScope`,
  `getHistoryScopePolicy`). The policy pins these chats to `chat` whatever is
  stored, and `history:scope.set` refuses a wider scope for them
  (`SCOPE_PINNED`): a chat with a `caseId` (`case-chat`, R-H4-1), a King
  Louie export of a case chat (`importedFromCase`, reason
  `imported-case-chat`, R-H4-2) and a Telegram or Discord bridge chat
  (`bridge-chat`, R-H4-7; `src/history/bridge-origin.js`, which is not
  exported from the history index because it loads the channel bridges). The
  first two are in no other chat's scope, by link or by `all`
  (`history:links.set` answers `LINK_REFUSED`); a bridge chat is left out of
  `all` and is read only through an explicit link: by the chat that links
  it, under `linked` and under `all` (owner ruling 2026-10-13; under `all`,
  `resolveScope` asks the chat's own links with `explicit: true` and every
  other chat with `explicit: false`). A host
  with no policy gets `CLOSED_POLICY` (every chat reads itself);
  `OPEN_POLICY` is for unit tests and LongHaul.
- Only the chat's own turn reads the wider scope: the desktop send path
  passes `crossChat: true` to `ContextBuilder.build` and
  `historyCrossChat: true` in its executor options, which is what gives
  `SearchHistory` and `ReadHistory` a `resolveScope`. A sub-agent, a workflow
  task, a bridge chat's turn and a gateway session read their chat alone. A
  tool's `scope` argument only narrows; `ReadHistory` refuses a chat outside
  the scope before reading it. `upToSeq` cuts only the asking chat
  (`upToSeqChatId`), so "before this turn" hides nothing of a linked chat.
  Scope `chat` is what H3 sent (R-H4-6): no `history.recall` default
  changed, and `linked`/`all` are unmeasured (LongHaul asks inside one
  session). Provenance adds `scopeChats`, `recalledChats` and `scopePinned`;
  the recall line says "linked chats" or "all chats", an excerpt of another
  chat is headed `chat "<title>"` (`chatHeaderTitle`: one plain line, 60
  characters), and the block's preamble changes only when one is in it.
  `history:excerpts` asks the scope as it is now: an excerpt of another chat
  the asking chat may no longer read comes back as `{ hidden: true }`, with
  no text (the cautious reading; the owner may overrule).
- Attach (R-H4-1, R-H4-7; `assertChatAttachable` in
  `src/cases/chat-attach.js`, before Q29's check): `case:attach` and
  `case:create` refuse `IMPORTED_CHAT` for a chat with `source` set (or the
  `importedFromCase` mark) and `CHAT_RECALLED_OTHER_CHATS` for a chat that
  carries the recall mark or whose stored rows show it read another chat (a
  reply's `context.recalledChats`, a `SearchHistory` or `ReadHistory` result
  from another chat). `case:create` checks before any case is created, and
  no `force` lifts either. It cannot see text the owner pasted from another
  chat.
- The recall mark (`recalledOtherChatsAt` in the chat's meta, written only
  by `HistoryStore#markRecalledOtherChats`): set before another chat's text
  reaches a model, by the send path right after `ContextBuilder.build` when
  `stats.recalledChats` names a chat, and by `SearchHistory`/`ReadHistory`
  before they return such text, because a turn that fails or is cut off
  stores no reply and so no provenance. The store never clears it: every
  chat write (`_updateChatRow`, `createChat` over an id) carries the row's
  mark over the chat object it is given, and truncation and the scope do
  not touch it. A mark that cannot be written ends the turn before any
  model call (`RECALL_MARK_FAILED`), or the tool call with a bare failure.
  Code that hands a model another chat's text some new way marks first.
- Imports go through `src/history/import-chats.js` only (`importChat` for a
  file; `createImportGate`'s `begin`/`append`/`finish` for a chat that
  arrives parsed), over the importers in `src/history/importers/`
  (`claude-code-jsonl`, `king-louie-json`, `markdown-transcript`). An import
  never overwrites (R-H4-8): the chat gets an id no chat has
  (`freeChatId`), the chat and each message are built from fixed key lists,
  the same file again (by SHA-256) returns the first chat, and a grown copy
  of a session is a second chat. `parseImport`/`previewImport` check the
  file's size once, before any importer opens it: over 128 MB is
  `IMPORT_TOO_LARGE` (`MAX_IMPORT_BYTES`; Markdown keeps its 32 MB), and a
  JSONL line over 32M characters is `IMPORT_LINE_TOO_LONG`
  (`readJsonlLines`'s `maxLineChars`; LongHaul passes none). No refusal
  names the path. An import is never given an id `chat-data.json` still
  holds (`HistoryStore#reserveChatIds`, set by `create-core.js`), and the
  move out of that file never counts an imported chat as the chat it is
  moving. One import runs at a time per core; a
  half-written one is removed by the gate (a refused batch, 30 minutes
  without a call, the desktop that began it disconnecting, shutdown) or by
  `sweepUnfinishedImports` at the next start.
- An imported chat stays local (R-H4-2): its chunks are embedded only under
  a `local:` key (`isLocalKey`; `pendingEmbeddings`/`countPending` take
  `localOnly`), so Ollama counts as hosted, and with Jev chosen a turn or
  search whose scope holds an imported chat is not reranked
  (`rerankSkipped: 'imported-chat'`). Nothing scans an import: the dialog's
  warning (`IMPORT_WARNING_TEXT`, also in `index.html`; a test holds the two
  equal) is the only protection against a key in a transcript.
- Import IPC (R-H4-3): `history:import.pick` opens the file dialog in the
  main process (`src/ipc/import-picks.js`) and gives the renderer a token
  and the file's base name; `preview` and `commit` take the token and a
  Markdown heading pattern and nothing else, so no channel opens a path a
  renderer or a desktop sent. A file that can no longer be read answers
  `IMPORT_UNREADABLE` with a fixed sentence, never Node's error (it names
  the path). Attached, those three are local to the desktop
  (`LOCAL_CHANNELS`): it parses the file and sends the chat through the
  proxied `history:import.lookup`/`begin`/`append`/`finish`, which the
  service holds to the same key lists and caps (500 messages and 8 MB of
  JSON a batch). Scope and links are proxied with the rest of `history`, so
  they act on the service's store.
- `king-louie-service history import <file> [--pattern ID]`
  (`src/service/commands/history.js`, R-H4-4) runs with the service
  stopped, only as the account that owns the data dir, never as root or
  Administrator; it opens the store directly and builds no core, so it
  refuses while the store has no migration marker and `chat-data.json`
  still holds chats (start the service once first). Windows
  residual: the owner is not checked there (only an elevated prompt is
  refused), so a service installed under LOCAL SERVICE has no CLI import;
  its owner imports from the attached desktop. `history:index.status`,
  `history:reindex` and a `history reindex`/`status` command do not exist
  (R-H4-9).
- The case nudge (R-H4-5; `offerCaseNudge` in `src/cases/case-nudge.js`,
  called by the send path after a finished reply): at
  `history.caseNudgeAfterUserTurns` user messages (40; 0 is off; not in the
  settings pane) a chat with no case is marked `caseNudgedAt`, once, and
  gets one `status` row with `meta.action: 'convertToCase'` only when the
  attach checks above and the bridge rule would let it have a case. The
  renderer draws the row with a "Make this a case" button that opens the
  chat info's "New case…" flow. No prompt text is added.
- H4 tests: stores and chats as in H2 (`tests/helpers/history-fixture.js`);
  import files are the synthetic ones in `tests/fixtures/history/` or
  `tests/helpers/claude-code-fixture.js`; the nudge's send path runs through
  `tests/helpers/chat-harness.js`. The e2e files are
  `tests/e2e/history-scope-links.test.js`, `history-import.test.js`,
  `history-import-attached.test.js`, `case-nudge.test.js` and the second
  suite in `history-recall.test.js`. A test cannot drive the native file
  dialog: under `KL_TEST_MODE`, and only then, `KL_TEST_IMPORT_FILE` is the
  file "picked", read at each pick.
- H4 residuals and open questions are the plan's "What is left" section.
  The ones that change what a reader may assume: a chat detached from its
  case is an ordinary chat again (its stored scope applies and other chats
  may read it); two chats of one case cannot recall from each other; in an imported
  chat the owner's new message is still embedded as the turn's query by
  whatever embedder is active; a case-chat export is recognised only by the
  `caseId` in the file; desktop-to-service copies carry no scope or links.

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

## Local models

Spec `docs/superpowers/specs/2026-10-13-local-inference-design.md` (stage
L1; L2, a node serving the owner's other nodes, gets its own plan); plan
`docs/superpowers/plans/2026-10-13-local-inference-l1.md` (owner rulings
R-LI-*, Q-L1-*). Electron-free except `src/ipc/`.

- A local server is an OpenAI-compatible server the owner added, which is
  the mark that it is local (R-LI-4, R-LI-5). One provider key, `local`;
  model ids are `<serverId>/<model>` (`{ provider: 'local', model:
  'workstation/qwen3:8b' }`). `local` is not in `KL_PROVIDERS`:
  `explainTarget` asks the registry. Every kind (`ollama`, `lmstudio`,
  `llamacpp`, `vllm`, `openai-compatible`) is spoken to at
  `<baseUrl>/v1/chat/completions`.
- `LocalServers` (`src/models/local-servers.js`) owns the entries, their
  pins and the probe records (`<dataDir>/models/local-probes.json`); a
  probed model enters the catalog under `local` (`syncCatalog`), which is
  where the profile picker and the chat header list it from. Probe once,
  place by hand (R-LI-7). `LocalServerProvider`
  (`src/providers/local-server-provider.js`) is one instance per server
  (`providerFor`).
- Only `src/models/local-transport.js` opens a socket to a local server
  (calls, the probe and discovery alike). It dials only the pinned
  addresses, resolves nothing at request time, never follows a redirect
  (`LOCAL_REDIRECT`), uses no proxy or global agent, destroys a socket
  whose remote address is not pinned (`LOCAL_ADDRESS_MISMATCH`), checks a
  `tlsFingerprint` when one is set (`LOCAL_TLS_MISMATCH`) and queues past
  `maxConcurrent`. Never call `fetch` for a local server.
- Addresses (`src/models/local-address.js`, `resolveAndPin`): a name is
  resolved once, at add, at start and on "Check again", and every answer
  must be allowed. `loopback` and `lan` are allowed; `cgnat`
  (`100.64.0.0/10`) only with the entry's `allowCgnat` (R-LI-29);
  link-local, unspecified and public are refused. The grade (R-LI-30):
  `loopback` carries the guarantee; `lan` and `cgnat` only over https with
  a `tlsFingerprint`, else the server is for cost only and never used by a
  private chat or a local-only role.
- Desktop: `settings.models.localServers` is sealed. Only
  `LocalServers#write`, from the `models:local.*` handlers, replaces it;
  the core's `setSettings` keeps the stored value whatever a caller passes,
  and `import --from` does not carry it. `add`, `remove`, `recheck` and
  `fromOllama` act only for the app's own window (`NOT_LOCAL_WINDOW`
  otherwise); `probe` and `setModelInfo` for any marked desktop event. A
  server's key is the provider token `__local_<id>`.
  `tests/local-servers-config.test.js` fails when another file under
  `src/` names `localServers`.
- Service: local servers come only from the admin `service.json` block
  `localInference` (`localInference` joins `ADMIN_ONLY_KEYS`); a data-dir
  `models.localServers` is ignored with one warning, and every change over
  the bridge is `LOCAL_SERVER_ADMIN_ONLY`. The block is `{ servers: [{ id,
  name, kind, baseUrl, addresses?, tlsFingerprint?, allowCgnat?,
  maxConcurrent?, timeoutMs?, key?, adapters? }] }`, strict keys, at most
  32 servers. `key` is a `${vault:local.<name>}` reference and nothing
  else (a key written into the file, or a vault key outside `local.`, is
  refused): the `Vault` tool cannot read, change, delete or list a
  `local.` key (`src/models/local-vault-keys.js`). `adapters` is
  `[{ model, id, job, ref }]` (one id per model, at most 32 per model), the
  only source of adapters there. The pins are made in `start()`.
- The built-in `ollama` provider is never local (R-LI-31): its calls cost
  $0 but carry no `local`. "Use this Ollama as a local server"
  (`models:local.fromOllama`) adds a local server beside it.
- The egress policy (`src/models/egress.js`): a private chat or case, or a
  local-only role (`profile.localOnly`), makes a model call local or
  refused. `snapshotModels` freezes it into `TurnModels`, and a child run
  takes its parent's. Four checks: the resolver drops every target that is
  not a guarantee-grade local one (`mustResolve` throws
  `PRIVATE_NO_LOCAL_MODEL` or `LOCAL_ONLY_ROLE_NO_MODEL`), the router
  refuses a hosted target (`PRIVATE_HOSTED_TARGET`), a hosted provider
  refuses to send (`PRIVATE_HOSTED_CALL`), the transport pins. A mark that
  cannot be read (a closed store, an unknown chat, a `case.yaml` `private`
  that is not a boolean) is private. Under a policy a role borrows among
  local models only; an optional job (a title, the detour classifier, the
  case nudge, a case's verify pass after a reply) is skipped and a
  load-bearing one refused (R-LI-22). Nothing falls back to a hosted model.
- **A new model call goes through the router or takes the policy, and
  `tests/egress-inventory.test.js` lists the file** (with a label, in
  `tests/fixtures/egress-inventory.json`): a new caller of `fetch`, a
  socket, a provider, an embedder, a provider class's `this.request(`, or
  a call by name on a provider (`.sendMessage(`, `.sendMessageWithTools(`,
  `.streamMessage(`, `.streamMessageWithTools(`, `.rerank(`,
  `provider.ask(`) under `src/` fails it until someone labels it. A
  `gated` entry names `check`, the exact code of its policy check, which
  must be in the file's code (comments do not count); a `behind-gate` one
  names its `gate` file and that file's `check`. A file whose sends differ
  (`create-core.js`) is listed by `sites`, one label per construction, and
  every line of it that can send must match a site. A provider method
  reached another way (a variable, `oneShot`, a computed name) is out of
  the walk's scope (the test's header).
- A user skill's `llmProvider` (`src/skills/skill-models.js`) is held to
  the calling chat's policy on every call: the caller rides an
  AsyncLocalStorage set by `SkillRegistry#executeCommand`, a skill's
  `handleMessage` and `ToolExecutor` (with the run's own policy). Under a
  policy it is the router's local-only provider (or null, or
  `PRIVATE_NO_LOCAL_MODEL`); a Telegram or Discord caller has none; a call
  with no known caller is held to one while any chat is private
  (`HistoryStore#hasPrivateChats`).
- The private mark is one way. It is written only by
  `HistoryStore#markPrivate` (the chat's column; marking deletes the
  chat's vectors under every key but `local:`, in the same transaction,
  and moves `vectorEpoch` so a hosted batch in flight is not written)
  and `CaseRuntime.markPrivate` (`case.yaml` `private: true`; every chat of
  the case follows, R-LI-23). The owner's paths: `chat:markPrivate` and
  `case:markPrivate` (`src/ipc/private-mark.js`: the facts first, the mark
  on `confirm: true`, from the local desktop's event only), attaching with
  `makeCasePrivate`, "Import as private", an export that says `"private":
  true`. Nothing clears it (`PRIVATE_ONE_WAY`). A role's `localOnly` is one
  way for a generic save too (`LOCAL_ONLY_ONE_WAY_HERE`); only
  `models:local.unsetLocalOnly`, from the window, takes one off.
- A private chat is in no non-private chat's recall scope (R-LI-11,
  `private-chat`). A private chat's `create_case` makes a private case, and
  `answer_question`, `revoke_envelope` and `cancel_case_job` refuse a
  private case `private_case` wherever its text is hidden (MCP, a
  non-private chat), before its question, envelope or job is read. A case
  whose `case.yaml` lost its `private` key is still private while any of
  its chats carries the store's mark (`caseChatsPrivate`), and a private
  case's routed provider is under the case's policy even when the turn's
  models carry none. Marking a case says its questions still go out over
  the contact ladder (`questionsLeave`). A private case's text never reaches another case's
  search, the MCP surfaces or a non-private chat's management tools (id,
  title, status and `private: true` only); its approval card says the send
  leaves. A private case's detour goes only to a private case: routed to
  one that is not, it is refused `PRIVATE_CASE_REQUIRED` and asked again,
  and "new" makes a private case (Q-L1-6). In a private chat `Cron`,
  `SessionsSpawn`, remote dispatch and workflows are refused
  (`PRIVATE_NO_DETACHED_RUN`; a plan payload's `chatId` and
  `options.chatId` are both checked, and chat messages that name no chat
  are refused while any chat is private), so are `delegate` and the acting fleet tools
  (`PRIVATE_NO_DELEGATE`) and image generation (R-LI-33); read-aloud uses
  the system voice. Every other tool behaves as now (R-LI-9).
- Embeddings (R-LI-25): a private chat's chunks get only `local:` vectors,
  from the keep-local embedder (the default local model, Q-L1-4) when a
  hosted embedder is chosen; its query is embedded locally or not at all
  (`vectorsSkipped: 'private-chat'`), and Jev never reranks it.
- Cost (R-LI-13): `costUsd: 0` only for `local` (whose metrics carry
  `local: { server, class }`) and for a non-cloud `ollama` model (no
  `local`). Nothing else becomes $0. A reply's `llm` adds `localCalls` and
  `localTokens` (and `localServerIds` per role), the tracker totals local
  calls by server, and a case budget charges a local call nothing and
  records `localTokens`.
- Timeouts (Q-L1-3, Q-L1-5): a local call is bounded by the role timeout,
  or the entry's `timeoutMs` when that is larger, **only until its first
  output**; after that nothing cuts the reply, and Stop still stops. A
  local call streams whenever its caller does, agent mode included
  (`LocalServerProvider#streamMessageWithTools`, OpenAI-style tool-call
  deltas at `/v1/chat/completions` for every kind): first output is a text
  delta, a reasoning delta (`reasoning_content`, `reasoning`, `thinking`;
  never the reply's text) or a tool-call delta, never a role-only chunk.
  A non-streamed call's first output is the first byte of its body. It
  fails `LOCAL_TIMEOUT`, with no retry, and the route moves to the next
  target (under a policy only a local one). Hosted calls have no such
  timeout. A refused connection or a name that does not resolve is
  `LOCAL_UNREACHABLE` and moves on at once; under a policy, every local
  target failing is `LOCAL_MODEL_UNAVAILABLE` (R-LI-12).
- Adapters (R-LI-15, the seam only): a `local` target may name `adapter`
  (a slug); a model's adapter is declared as `{ id, job, ref }` and bound
  to the model's digest then. `LOCAL_ADAPTER_UNKNOWN`,
  `LOCAL_ADAPTER_STALE` (the model was pulled again),
  `LOCAL_ADAPTER_INVALID`.
- The other refusal codes: `LOCAL_ADDRESS_PUBLIC`,
  `LOCAL_ADDRESS_UNRESOLVED`, `LOCAL_URL_INVALID`, `LOCAL_PIN_INVALID`,
  `LOCAL_RECHECK_STALE` (a confirm whose `expected` addresses are not what
  the name answers now), `LOCAL_SERVER_UNKNOWN`, `LOCAL_SERVER_UNUSABLE`,
  `LOCAL_SERVER_INVALID`, `LOCAL_SERVER_EXISTS`, `LOCAL_SERVER_IN_USE`
  (removing a server a profile names), `LOCAL_CLOUD_MODEL` (an id ending `-cloud`/`:cloud`: on an Ollama server always, on any kind never guarantee grade and refused under a policy; an Ollama cloud
  id on a local server), `LOCAL_MODEL_NOT_LISTED`, `LOCAL_MODEL_UNFIT`,
  `LOCAL_MODEL_INFO_INVALID`, `LOCAL_TRANSPORT_REQUIRED`;
  `PRIVATE_CHAT_BUSY` (marking while a turn runs), `PRIVATE_BRIDGE_CHAT` (a
  Telegram or Discord chat cannot be marked). Inside the transport and the
  probe: `LOCAL_TRANSPORT_CLOSED`, `LOCAL_TRANSPORT_INVALID`,
  `LOCAL_URL_OUTSIDE`, `LOCAL_BODY_UNSUPPORTED`, `LOCAL_PROBE_STATUS`,
  `LOCAL_PROBE_MALFORMED`, `LOCAL_PROBE_TOO_LARGE`, `LOCAL_PROBE_TIMEOUT`.
  The renderer words `PRIVATE_NO_LOCAL_MODEL`, `LOCAL_ONLY_ROLE_NO_MODEL`
  and `LOCAL_MODEL_UNAVAILABLE` and adds "Open Models"; the stored error
  row keeps both (`errorCode`, `errorAction`).
- `npm run smoke:local` (`KL_SMOKE_LOCAL_URL`, `KL_SMOKE_LOCAL_MODEL`,
  `KL_SMOKE_LOCAL_KIND`, default `ollama`) adds, probes, streams a reply and
  makes one tool call against a real local server; with nothing set it
  says how and exits 0. Not part of `npm test`.
- Tests use the fake server (`tests/helpers/fake-llm-server.js`, on
  127.0.0.1; its first path segment says which side a request was for, and
  its `hang` and `slow` models are for timeouts) and an injected `lookup`
  for names, never a real local server or the network; a ref'd timer stays
  alive around every await a timeout should end.
  `tests/e2e/local-private.test.js` drives the UI end to end. Residuals
  (R-LI-21): a server that sends text on cannot be detected; which machine
  holds a LAN address is not proved; `Bash` can rewrite `chat-data.json`; a Markdown export's "This chat was
  private in King Louie." line is not read back by the Markdown importer
  (only a King Louie JSON export's `"private": true` imports as private);
  a server that answers a streamed request with one JSON body, or sends a
  tool call only when it is done (older Ollama), is bounded until that
  first output, so a long generation there can still time out; a user
  skill's model call outside any chat turn or command (its own timer) is
  held to a policy whenever any chat is private.

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
- Floor check: add `no-context` to `--adapters` (the question alone, nothing
  from the session; evidence recall 0). In an answer-stage run an answerable
  question it gets `correct` is stamped `answerableWithoutEvidence` on every
  record of that question; the summary and `report` (`floor-check.csv`) give
  each adapter's accuracy over all answerable questions and with the flagged
  ones left out, added beside the headline numbers, never in place of them.
  A run or report cohort without `no-context` shows none of it (absent, not
  zero). `report` also bands answerable questions `none`/`some`/`all` by the
  adapters other than `oracle`, `no-context` and `full-history`
  (`difficulty-bands.csv`, counts only). `--fake-models` always declines, so
  it flags nothing.
- `no-context` alone answers under `prompts/answer-no-context-v1.md` (best
  answer from general knowledge; `answer-v1.md` would make it decline), an
  adapter's `answerPrompt`. Its hash is in `config.json`
  (`answer.prompts.answerNoContext`), the adapter's `describe()` (so `cfg:`,
  never `setup:`: other series keep their identity) and its answer cache
  keys. A flag says this answer model got it right with nothing shown; it
  does not find a mislabelled abstain question (never flagged; `no-context`'s
  own abstain accuracy means nothing).
- Local recall jobs (local inference R-LI-14, spec §11): `kl-recall-rewrite`
  (`--rewrite-mode replace|append`), `kl-recall-abstain-check`
  (`--abstain-mode note|withhold`), `kl-recall-llm-rerank` and
  `kl-recall-vec-llm-rerank` (`--llm-rerank-mode pointwise|listwise`) and
  `kl-recall-digest` (`--digest-every-tokens`, `--digest-max-tokens`) run
  their job on a local model: `--local-provider ollama|openai-compatible
  --local-model <id> [--local-base-url <url>] [--local-context <tokens>]`
  (Ollama's default address when no URL is given). The client
  (`src/longhaul/local-client.js`) checks and pins the address as the app
  does and sends through `LocalServerProvider` at $0, so no
  `--send-private`; a LAN http address is accepted (LongHaul measures, it
  carries no guarantee) and `config.json` records its class. Codes, all
  exit 2: `LOCAL_REQUIRED` (a local adapter with no local client, an address
  that fails the check, an Ollama cloud id), `LOCAL_UNREACHABLE` (an Ollama
  server whose model list cannot be read: its digest is in every cache
  key), `LOCAL_MODEL_NOT_LISTED` (pull it first), `LOCAL_CALLS_MISSING` (the
  answer stage and its dry run are cache-only for these adapters: run the
  evidence-only run with the same settings first; it stops the run). A
  digest is never evidence, and a shown digest's covered messages count as
  leaks at or after `askAtSeq`. No product default changed;
  `--fake-models` supplies a fake local model (not cache-only), so
  `--adapters kl-recall-rewrite,kl-recall-abstain-check --fake-models` is a
  $0 smoke run.
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
- A long chat with no case is offered one, once (history stage H4, owner
  ruling R-H4-5; see History): a `status` row with a "Make this a case"
  button that opens the chat info's "New case…" flow. The model is told
  nothing, and the attach flow makes every check itself.

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
  `denyAutoApproval`, no owner messages). A case type may add wake-up tools (`wakeupToolsFor` in `src/cases/case-types/index.js`); `outreach` adds the four browser tools, look only: the case guard refuses typing and `denyAutoApproval` refuses `click`, so a wake-up reads an inbox and sends only through Executor jobs (spec `docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md`). A wake-up that fails backs off
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
the five `examples/fleet/*/service.json` files must list it too.

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
- **Importing a conversation** (history stage H4, R-H4-3): the file dialog,
  the preview and the parse run on the desktop (`history:import.pick`,
  `.preview`, `.commit` are `LOCAL_CHANNELS`), and the parsed chat goes to
  the service in batches over the proxied `history:import.lookup`, `.begin`,
  `.append`, `.finish`; the service never opens a path the desktop named,
  and removes a half-sent chat when that desktop disconnects. With the
  service unreachable the preview still shows (`serviceUnreachable`) and
  Import is off. A chat's scope and links are the service's.
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
  - A channel send to anyone but the owner (`ContactRouter.sendExternal`, no
    caller yet): `message` mode, and always an envelope. The caller names
    `envelopeId` and `executorId`; `sendEnvelope` (`envelope-ops.js`) reads
    the envelope from the case (a caller's envelope object is never used)
    and refuses unless it is intact, `active`, that executor's, names the
    channel, lists the recipient, is inside its window and caps and, when
    `signed`, has its phone grant. A delta is a refusal there.
    - The channel (owner decision 2026-10-12): the envelope's `channels`
      must list `channelId` (`call` = `voice`). The owner sees the list in
      the approval question and the phone summary; it is in the hash only
      when present, so an envelope without it hashes as before and allows
      no channel send (executor jobs only). Adding a channel is a `channel`
      delta the owner approves; never edit `envelopeCore` so that an
      envelope without a field hashes differently. Only `SEND_CHANNELS`
      ids (`telegram`, `discord`, `email`, `sms`, `voice`: the channels
      that address a third party; never `in-app`, `mobile` or `ntfy`) are
      accepted, each once. A new request always stores `channels` (`[]`
      when none is asked), so every new envelope gets the host-first phone
      summary: executor, recipients, usd cap, contacts, attempts, window,
      channels, then the intent; only the intent can be cut, and the
      summary refuses to be built if the host part would not fit F3's 300
      characters. The phone does not show rules, facts or who the
      recipients are (the app does). Only an envelope stored before the
      field has no key; it keeps its hashed intent-first summary.
    - Counting (`executors/channel-send.js`): after the gate,
      `reserveChannelSend` re-checks the envelope on disk and counts the
      send (envelope `usage` and a `reserved` `payloads` entry, the case's
      `contactsPerDay`, the global daily cap) before the adapter is called;
      a cap that would be passed refuses. `settleChannelSend` marks it
      `sent`, gives the count back when the adapter clearly refused
      (`ContactDeliveryError` `not-configured`, `rejected`, `too-large`,
      `rate-limited`), and keeps it counted (`unconfirmed`, `counted: true`)
      for anything else. It writes through `systemAction` (inline in a
      turn; another process holding the case refuses the send) and only in
      an `active` case. The check and its writes
      have no `await` between them: `systemAction` is no mutex inside one
      process. A job's fit-to-job-file section (`submit.js` steps 9 to 11)
      and a send's reservation share `ExecutorRegistry#countingLock`; a job
      records usage only at commit, so every fit reads the envelope through
      `withPendingJobs`, every `contactsPerDay` check subtracts
      `pendingJobContacts`, a send's settle runs under the same lock, and a
      released send never removes a contact an open job names. A global-cap
      reservation (a job's `reservedDay`, a send's `globalDay`) is released
      only into the day it was made on. Known and left: the usd cap is
      fitted against recorded cost only, so several pending jobs can each
      fit it. A channel send's money cost is not known and not charged.
  - In text, facts are quoted as `{{f-0042}}` references.
- Only a clear 4xx refusal fails an external submit. A timeout
  (`submitTimeoutMs`, or `host.fetch`'s `requestTimeoutMs`), a network error
  or a 5xx leaves the job `submitting` with its contacts held; the next turn
  start or sweep finds it by `externalRef` or resubmits it with the same
  idempotency key; after `maxPollErrors` unconfirmed tries it is `unreachable`,
  its contacts still counted. Cancelling it asks the executor by `externalRef`
  and cancels what it took. A job that ends with its contacts still counted
  (`unreachable`, or cancelled when the executor had it or could not be
  asked) is recorded as sent, once: the envelope's `payloads` and `usage`
  and the case's `contactsPerDay`. A job a crash left `submitting` (never
  marked `unconfirmed`) is only looked up by `externalRef`, never resubmitted:
  not found fails it as `interrupted` and frees its contacts; a lookup that
  fails is counted like an unconfirmed try (same bound, a poll wake-up from
  the first one). The sweep fetches executor statuses before it
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
- The approval card (`envelopeQuestionText`, `deltaQuestionText`) is what the
  owner approves, so it is never cut and never spoofable. "One plain line"
  is `plainLineProblem` in `src/cases/hidden-chars.js` (one definition; it
  includes the approval-v1 §5 table the phones and `mobile-app-channel.js`
  use, every non-ASCII space, runs of spaces, tabs and combining floods,
  because the card wraps). An `intent`, rule or recipient that is not one is
  refused, on a request and on a delta. The card is host-built lines first
  (caps, window, channels, recipients, fact ids), then labelled wording
  (`Intent:`, `Rule N:`, `Fact <id>:`), then `Case: <title>` last; stored
  text that is not one plain line shows as `(text hidden: not one plain
  line)`, never flattened. A request or delta whose card would pass 2,000
  characters is refused (`QUESTION_TOO_LONG`). Keep new card lines in that
  order and pass every model or ledger string through `shown`.
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
  private fact of that category; the lists are
  `settings.executors.outbound.categoryKeywords` on every path
  (`Executor.submit`, envelope requests, drafts, `sendExternal`), read
  through `ExecutorRegistry#settings`: a list from settings only adds to
  its built-in one, on the desktop and in service mode alike (owner
  decision 2026-10-12; nothing removes or empties a built-in list), and a
  malformed list keeps the built-ins with a warning. Rule 3 (message mode) blocks a date, price,
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
  refuses them outright rather than queuing them. The same notice replaces
  the options on any channel, the app and phone included, when a batch is
  over the channel's `maxChars` and the question's text would be cut
  (`renderBatch`): an approval or app-only question is never answerable
  from a cut text. A batch line shows at most 60 characters of the case
  title, on one line.
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
  for anyone but the owner needs an owner-approved envelope that names the
  channel (`envelopeId`, `executorId`; see Cases: executors), runs C3's
  outbound gate, counts the send against the envelope and the daily caps
  and sends `rendered`. Without the gate or the executor registry every
  non-owner send is refused.
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
  timeout; a repo whose own config defines drivers or commands is refused with `GIT_UNSAFE_CONFIG`, and
  so is an index entry whose name does not end where its length says: git reads past such a name, so
  two git runs can see different paths and asking git which submodules exist cannot be trusted).
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

## Cases: verified progress (stage 8)

Spec: `docs/superpowers/specs/2026-10-13-cases-stage8-verified-progress.md`;
plan `docs/superpowers/plans/2026-10-13-cases-stage8-verified-progress.md`
(owner rulings R-C8-1 to R-C8-11 and R-C8-N3 to N9, its Deviations and its review fixes).

- **Scope.** `brief.md` keeps `successCriteria` as strings; who wrote each
  one is `.kl/scope.json` (`ScopeStore`, `src/cases/scope.js`), keyed by
  `sc-NNN` and a hash of the folded text. A criterion or the objective is
  `proposed` or `confirmed`; a proposed one counts for nothing. Origins
  (`ORIGINS`): `model`, `detour`, `legacy` (open cases from before stage 8),
  `file` (an edit outside the tools), `mcp-create` (an objective
  `create_case` set over MCP, whose quote nobody checked; R-C8-N3; it also
  posts a pressed `scope-confirm` question, key `scope-confirm:created`,
  `mcpAnswerable: false`, uncharged, closed once the objective is confirmed
  another way: R-C8-N7) are born proposed; `owner-quote` (the `Brief` tool with a quote whose words are the
  criterion, `wordsInText`), `gating-answer`, `owner-create` (the form's
  objective, or `create_case` in the chat) and `owner-action` are born
  confirmed. Otherwise only a press (`case:confirmScope`, by the hash the
  owner was shown; `SCOPE_STALE` when it changed) or an answered
  `scope-confirm` question confirms. A scope answer confirms the
  objective only from a press (`in-app`, `mobile`) or King Louie's chat
  (`in-app-chat`, quote checked); over MCP or a contact channel it confirms
  the criteria alone (R-C8-2) and leaves the objective proposed (review fix,
  2026-10-14). The model never changes or drops a
  confirmed one (`CRITERION_CONFIRMED`, `OBJECTIVE_CONFIRMED`), and the
  `Brief` tool cannot confirm one it proposed (`CRITERION_DUPLICATE`).
  `createCase`'s `objectiveBy` is the host's, like `force`; no tool takes
  it. Gating needs one confirmed criterion; a brief already past gating is
  never sent back. Tests confirm with `confirmAll`
  (`tests/helpers/case-scope.js`).
- **Abandoned approaches**: `.kl/abandoned.jsonl` (`src/cases/abandoned.js`),
  append-only, written only by `Progress.abandon`, never in the cross-case
  index. `Fail` does not write it (R-C8-10).
- **States** (`unmet`, `met`, `stale`, `failing`) are computed on every read
  from `.kl/verification.json`'s records, the ledger and the check runs
  (`src/cases/verify/status.js`); the stored cache is only "what it was last
  time", for the regression trigger, and no reader takes it as a state. A
  record is written only through `acceptVerdict` (`verify/judge.js`), and
  only when every cited id holds. Evidence ids resolve by prefix
  (`registerEvidenceResolver`: `f-` facts, `chk-` check runs) and the pass's
  inputs come from `registerEvidenceSource` (`verify/evidence.js`); a later
  stage plugs in there. `external-agent` facts alone may make a criterion met
  (R-C8-5); each evidence row shows its provenance. A `user` fact whose
  `source.channel` starts with `mcp-` (the owner's words as an MCP client
  recorded them, unchecked: `create_case`'s objective fact over MCP, an
  answer given over MCP) is kept but never evidence: the `f-` resolver
  refuses it `evidence-provenance` and the pass is not shown it (R-C8-N8).
- **The verify pass** (`verify/judge.js`, `cases.verify`): on the `verify`
  case role (default `main`), charged to the case's `usd`, at most
  `maxPassesPerDay` (24), skipped past `skipAboveUsdPercent` (80) of `usd`,
  when the turn wrote nothing, with nothing confirmed, or when `when` is
  `request` / `off`. It sees the criteria and the case-tool results of the
  turn (R-C8-9), never the model's prose, up to `maxInputChars`. **It runs
  after the reply** (R-C8-11): `endTurn` commits and releases the case at
  once, the call goes out with no lock held, and its result lands in a
  system action of its own (a `verification` journal entry, its own commit,
  `case:changed` with `what: 'progress'`). A turn that starts meanwhile drops
  the result; shutdown stops the call and awaits it. Every charge of the
  call, in time or late, is a `verifySystemAction` of its own (`system:
  verify pass usage`), taken before the landing, so it is committed even
  when the landing is dropped (review fix, 2026-10-14). It never fails a turn.
  Tests wait with `runtime.verifyIdle(id)`. The panel's **Check now**
  (`case:verifyNow`, a press; refused when `when` is `off`, the case is not
  open, nothing is confirmed, or the cap or the usd mark is reached) runs the
  same pass outside a turn.
- **Regressions**: a criterion that was `met` and is `stale` or `failing`
  at the next turn start raises a blocking `criterion-regressed` trigger
  (`verify/hook.js`). A change the turn made itself (it superseded the fact,
  or the close run failed) is said in that turn's close block and is also
  raised at the next turn start: the close leaves it `met` in the cache
  (R-C8-N9).
- **Closing.** `readiness.js` computes the ready-to-close list (each item's
  owner: `owner`, `case`, `either`). `Progress.proposeDone` is refused
  (`NOT_READY`) unless every confirmed criterion is `met` (R-C8-1), and then
  asks a pressed `close-proposal` question; only the owner closes. The
  owner's Done (and "Mark done") is never refused for an open item; it shows
  the list first. Question types: `scope-confirm` (spoken; pressed for the
  one `create_case` over MCP asks), `close-proposal`
  and `check-approve` (pressed); a press is `in-app` or `mobile`
  (`PRESS_CHANNELS`), never `in-app-chat` or MCP. At `done` or `abandoned`
  the states and the list are frozen in `verification.json` and never
  recomputed (R-C8-7).
- **The check command** (`verify/check.js`; R-C8-3, N4 to N6): a
  `software-repo` case's `check` brief field, named by the owner (a quote
  holding the whole command, or the panel's `case:setCheck`). npm only:
  `npm test` or `npm run <script>`, no npm option before the script, no
  other npm command. Off by default (`cases.softwareRepo.check.enabled`);
  in service mode only the admin `service.json` `caseChecks.enabled` turns it
  on (`caseChecks` is in `ADMIN_ONLY_KEYS`). Approved once per exact argv and
  repository on a pressed `check-approve` card (`.kl/checks.json`). It runs
  only at the close of an owner turn in which the repository's head or dirty
  state changed, never in a wake-up, a system action or **Check now**, capped
  at `timeoutMs` (120 s) with the child and its children killed, and stopped
  with the turn. No shell and never `cmd.exe`: npm runs as `node.exe
  npm-cli.js` on Windows and every other `.cmd`/`.bat` is refused
  (`CHECK_SHIM`). The environment is `FIXED_ENV` plus `envAllow` (none in
  service mode); `KL_*`, `KING_LOUIE_*` and `ELECTRON_RUN_AS_NODE` never pass.
  The kept output tail is under `.kl/runs/`, which the case's `.gitignore`
  leaves out. A run is `chk-NNNN` evidence; tests replace the spawn with
  `host.runCheck`.
- No `case.yaml` key, MCP tool or scope was added; `open_case` and
  `list_cases` carry progress inside the untrusted wrapper.
- Residuals: `Bash` can write every new file under `.kl/` (the write guard
  covers Write, Edit and MultiEdit only), and `sourced` is model-declared;
  the check runs the repository's own scripts with the account's access,
  network and all, which nothing here makes read-only. A quote holds any run of
  the owner's words, so "don't count it as done just because the tests
  pass" can yield a confirmed criterion "the tests pass".

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
- A chat that holds management-tool results about another case is never
  attached to a case (owner decision Q29, 2026-10-12): `case:attach` and
  `case:create` with a chat refuse `CHAT_SAW_OTHER_CASES` (no `force`
  lifts it), and `CHAT_BUSY` while a turn runs in the chat; the owner
  starts a new chat. The rule is `src/cases/chat-attach.js`, read from the
  stored `toolUse`/`toolResult` rows; what it cannot tell (a call by slug,
  a sub-agent that used the tools, another run's text) it refuses. A new
  case tool blocks until it is in `NO_CASE_DATA`. Chats attached before
  the rule, imported or migrated, are not re-checked. The same check
  (`assertChatAttachable`) refuses two more chats first (history stage H4,
  owner rulings R-H4-1 and R-H4-7 of 2026-10-13; see History):
  `IMPORTED_CHAT` for a chat imported from a file, and
  `CHAT_RECALLED_OTHER_CHATS` for a chat that carries the recall mark, or
  whose stored replies or `SearchHistory`/`ReadHistory` results show it read
  another chat. No `force` lifts either.
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

## Session helper (fleet stage 5)

`src/gui/` (service side) and `src/session/` (the helper) implement desktop
apps and computer use on agent nodes (spec
`docs/superpowers/specs/2026-09-23-fleet-stage5-session-helper.md`;
protocols `docs/protocol/session-v1.md`, `docs/protocol/lease-v1.md`). Both
are Electron-free. `tests/service-profile-graph.test.js` keeps `src/session/`
and `src/gui/` off the runbook, relay and front-door graphs, except
`src/gui/config.js`, `errors.js` and `status.js` (and, on the relay and
front-door graphs, `relay-extension.js` and `lease-protocol.js`; on the
runbook graph, `lease-protocol.js`, for the empty listing below).

- **Off until enabled (owner ruling R-F5-14).** The GUI subsystem starts only
  when `node.yaml` says `gui: enabled: true`. No `gui` block, an empty one
  and one that only lists apps mean off; installing the helper enables
  nothing (`session install`, `session status` and `doctor` say "installed
  but not enabled in node.yaml" with the lines to add). A test config that
  means "on" writes `enabled: true`.
- `king-louie-service session` runs as the logged-in user (one session user
  per node). `session install --user NAME` (root/Administrator) writes
  `<configDir>/session/helper-secret.json` (klc1:), the per-user copy in
  `<configDir>/session/users/` (`<user>.json`; `<SID>.json` on Windows) and
  the login start. `session uninstall --user NAME` removes the login start,
  the copy and the canonical secret. `--session-file` is valid for `session`
  only. `session status` / `session probe` read the running helper's report
  from `<dataDir>/session/status.json`; a local probe is labelled as one and
  loads the real backend.
- **Consent (R-F5-9).** `session install` and `session uninstall` follow
  `desktop pair`: they print what is granted or removed first (the user by
  name and SID, uid off Windows; the node's name and id; what the helper can
  do; where it starts at login; the files), then ask `[y/N]` on a TTY
  (default no). Off a TTY they need `--yes` or refuse (exit 2) before
  anything is resolved or read. Nothing is minted, created or written before
  the answer. `--dry-run` asks nothing. `--yes` is valid for `desktop pair`,
  `device apply`, `identity record`, `session install` and `session
  uninstall` only (`YES_COMMANDS` in `src/service/cli.js`).
- **Who is installed (R-F5-2, R-F5-10).** One session user per node, decided
  by the SID the canonical file records (the uid off Windows:
  `session_sid`, `session_uid`), never the bare name. Another identity is
  refused (`session_user_mismatch`) until the first is uninstalled (an
  account deleted and made again under the same name is another identity:
  `session uninstall --user NAME` then removes what the file records for
  the old one, once `sessionIdentityState` says `gone`: on Windows only a
  SID of this machine's own accounts (its SID prefix) that maps to nothing.
  A domain or Entra ID SID that does not map is `unresolved`, since no
  domain controller may be in reach: its install stays, and is removed by
  naming the recorded identity exactly, `--user <SID>` (taken with nothing
  resolved) or the name with its domain. Off Windows a uid that `id` says
  nobody has is `gone`; a directory account whose directory is out of
  reach looks the same there, a residual. Tests inject
  `deps.identityState`, or the older yes/no `deps.identityExists`). An
  existing file that cannot be read, parsed or verified (admin-owned,
  decrypts, a valid secret) or records no identity refuses the install
  (`session_file_invalid`) and writes nothing (`inspectCanonical` in
  `session-secret.js`). The same identity rotates: a new secret, the same
  `endpoint_id` (the running service listens on the endpoint it started
  with, so no restart is needed). `session uninstall` needs no master key,
  clears a damaged file, leaves another user's file alone, and works from
  the recorded identity when the account no longer resolves. It checks
  every path before it asks and again before it removes (a link above one
  refuses with nothing removed; a link at a path is removed itself, never
  followed: `removeEntry`), and `--dry-run` lists everything the real run
  removes.
- **One user account (third security review, finding 4).** The helper's
  file is made readable by the SID it is installed for, so `session
  install` refuses anything that is not one person's account, before the
  question: `resolveSessionUser` asks `LookupAccountName` (P/Invoke in an
  encoded script; no `Microsoft.PowerShell.Security` cmdlet) for the SID
  and what the name is, and `assertSingleUserAccount` refuses every type
  but a user (a group, an alias, a well-known group, a computer, no type
  at all) and every SID that is not an account SID by its form
  (`classifyWindowsSid`: Everyone, Authenticated Users, SYSTEM, LOCAL and
  NETWORK SERVICE, Interactive, every `S-1-5-32-*`, `S-1-2-*`, `S-1-3-*`,
  a domain's own group RIDs; only `S-1-5-21-a-b-c-RID` and Entra ID
  `S-1-12-1-…` pass). Install checks the SID's form again whoever resolved
  it. Off Windows root (uid 0) is refused, and a name that is only a group
  never resolves. `session uninstall` resolves with `singleUser: false`,
  so an install made before this rule can still be removed.
- **What install checks (R-F5-12).** The master key is resolved read-only
  with the data dir's owner uid (as `import --from`), so a key file its
  owner does not own is refused. The node id is read where the store keeps
  it (the dot path `mesh.identity` of `chat-data.json`) and verified: the
  public key must be the public half of the private key held under the
  master key (`readNodeIdentity`, read-only; `resolveNodeIdentity` is that
  with the key resolution, shared with `identity record`). A record with its private key
  in the clear is refused (start the service once: it moves the key under
  the master key), and the store is read only as a regular file of at most
  64 MiB, no link followed and no pipe waited on. That alone proves only
  that whoever holds this data dir's master key stored the identity, which
  the service account does, so install also needs it to be the identity an
  administrator recorded (R-F5-17, below): no record, another identity or a
  record that cannot be trusted refuses before the question (`--dry-run`
  too), with nothing written. On Windows install
  also runs the installers' config-dir check (`WINDOWS_CONFIG_DIRS_SCRIPT`)
  after consent, gives the session user's SID read-control, read-attributes
  and synchronize on `session\users` itself (no inheritance; without it the
  helper, which runs as that user, cannot read who owns the directory and
  exits `session_file_insecure`; CreateFile always asks for synchronize),
  creates the per-user copy empty, narrows it with `icacls`,
  gives it to Administrators and only then writes it (removed if `icacls`
  fails); uninstall takes that directory entry off again. The helper checks
  before every connection that the copy and its
  directory are owned by SYSTEM or Administrators (`checkUserCopyTrust`,
  an awaited PowerShell child; tests inject the inspector, except the one
  in `tests/gui-session-secret.test.js` that runs the real check against a
  temp dir locked with `icacls` and an OWNER RIGHTS entry, and lifts the
  lock with one blind DACL write before cleanup).
- **The administrator's record of the node identity (R-F5-17).**
  `<configDir>/identity/node.json` (`{ v, node_id, public_key, recorded_at }`;
  `src/service/identity-record.js`) is what an administrator vouched for.
  Only `king-louie-service identity record` writes it
  (`src/service/commands/identity.js`; root or Administrator): it reads the
  identity as install does, prints the node's name, id and fingerprint,
  asks `[y/N]`, needs `--yes` off a terminal (exit 2 before anything is
  read), and writes nothing before the answer. `--replace` (valid for this
  command only) is needed to record another identity or to write over a
  record that cannot be used; the same identity again writes nothing;
  `identity show` prints it. Nothing else ever writes it, the service
  least of all: a start without a record records nothing.
  - Readers (`readIdentityRecord`, `checkNodeIdentityRecord`) trust it as
    the approver set is trusted. POSIX: the file, `identity/` and the
    config dir are owned by `adminUid` and not writable by anyone else, and
    none is a link. Windows: their owners, read by the handle-based
    inspector in a PowerShell child (`inspectWindowsOwners`; no `Get-Acl`),
    are Administrators, SYSTEM or the config dir's own owner, the config
    dir is not LOCAL SERVICE's, none is a link, and with `serviceProbe`
    (the service; never the admin CLI or doctor) this process can neither
    create a file in `identity/` nor open `node.json` for writing (only
    `EACCES`/`EPERM` is trusted; fourth security review), and the access
    lists of `identity\` and `node.json` let nobody but SYSTEM and
    Administrators change either (`windowsAclProblem` →
    `recordAclProblem`, after the probes; fifth security review, finding
    3: an entry giving the service WRITE_DAC alone passed the owner read
    and both probes). A list that cannot be read or judged is refused.
    That read is one more synchronous PowerShell child, so it runs where
    the owner read does (the start, and the GUI's own read when its host
    passed none), never in `probeIdentityRecord`. An owner nobody
    could read, a file that is not JSON, extra keys, an id that is not its
    key's: all `invalid`, never `none`. The key is what is compared, not
    the id.
  - Windows, a record this account may not read (`EPERM`/`EACCES` on
    `node.json`): still `invalid` (the service refuses to start), but the
    message names the three readers the record's access list has (SYSTEM,
    Administrators, LOCAL SERVICE) and says to run the service as LOCAL
    SERVICE, or an administrator's command from an elevated prompt; it
    never offers `identity record --replace` as the remedy, since that
    writes the same list again (`unreadable` on the read result; fifth
    security review, finding 2).
  - Windows, writing: `writeIdentityRecord` never keeps a directory that
    was there (an inherit-only entry left in it would reach the new file).
    It builds `.identity.new-*` beside it, gives the directory and then the
    empty file a protected ACL (SYSTEM and Administrators in full, LOCAL
    SERVICE read; `windowsRecordDirAclArgs` / `windowsRecordFileAclArgs`)
    and Administrators as owner, writes the record, swaps the directories
    with two renames and removes the old one; a failure puts it back. A
    service run by hand as any account but LOCAL SERVICE cannot read such a
    record and refuses to start. The old directory is never deleted
    recursively (`removeRecordDir`; fifth security review, finding 6): the
    old `node.json`, when it is a regular file, then `rmdir`. A directory
    that holds anything else, or a link, is left as `.identity.old-*` with
    nothing in it touched; the record is still written and the command
    says on stderr where it is and how many entries it holds (names from
    it are never repeated). Never use `fs.rmSync(…, { recursive })` there.
  - Windows, while the service runs: `probeIdentityRecord` is the write
    probe alone, and the lease manager asks it before every new lease
    request (`identityProbe`; off where the host ran no probe). A record
    the service can now write refuses the request
    (`capability_unavailable: gui (node_identity_invalid: …)`), logged
    when the answer changes; a running lease is not ended by it. The
    probe runs in `_sendRequest`, where every request is built, so the
    resume requests the node sends by itself are covered (after a
    suspension, on `_relayUp`; fifth security review, finding 4;
    `request()` passes `probed: true`). A resume it refuses sends nothing
    and ends the lease (`node_identity_invalid`, a free status `reason`;
    input then says `capability_unavailable`): nothing but an
    administrator and a restart brings the record back, so a suspended
    lease would wait for nothing. Not asked: a `no_contact` pause, which
    resumes on a watch, and a grant that answers a request sent earlier.
  - No record: `session install` refuses; the service starts with one
    warning; computer use is off (`node_identity_unrecorded`, with the
    command in the log, `session status` and doctor). A record of another
    identity, or one that is `invalid`: `session install` refuses and the
    service refuses to start (`NODE_IDENTITY_MISMATCH`,
    `NODE_IDENTITY_RECORD_INVALID`; `checkRecordedIdentity` in `run.js`,
    before `startApprovals`, agent and runbook profiles), with the remedy
    in the message. The GUI gets the result (`identityRecord`) and reads
    the record itself when its host passed none; only `match` turns it on.
  - Not checked: a front door, a relay host, and the other commands that
    load the identity (`pair`, `enroll-device`, `device apply`,
    `desktop pair`, `mcp`). The check is the service's own code: it
    catches an identity replaced in the data dir, not code inside the
    service process. doctor's `node identity record` row compares public
    keys only and says so, with what else it did not check
    (`identityMatchRow`). On Windows it also reads the access lists and
    the owners of the config dir, `identity\` and `node.json`
    (`recordAclProblem` with `whole: true`: the handle-based inspector,
    whose `path` line carries the owner; no `Get-Acl`) and fails the row
    when a list lets anyone but SYSTEM and Administrators change one of
    them: delete-child or add-subdirectory on the config dir (its own
    remedy), an inherit-only entry on `identity\`. It says "clean" only
    when all three are also owned by Administrators or SYSTEM; another
    owner is a `WARN` that says what was read and that an owner can
    rewrite a list (fifth security review, finding 5); lists it cannot
    read are "not checked", never clean. The service's own read asks about
    `identity\` and `node.json` only, since its owner rule accepts a
    hand-made config dir another account owns. It
    never runs the write probe (an administrator can always write).
  - Tests write the record with `recordIdentity` and read it with
    `IDENTITY_RECORD_TEST_OPTIONS` (`tests/helpers/identity-record.js`: the
    Windows owner read and access lists answered in place, for however
    many paths are asked about, no write probe, so no service-side
    access-list read either), passed as
    `deps.identityRecord` to `runSessionCommand`, `runIdentityCommand`,
    `loadProfile(...).start`, `createGuiSubsystem` and `runDoctor`. A test
    that wants a GUI that is on, or an install that goes through, records
    the identity first.
- **Helper- and file-supplied text** (what the helper says of itself in
  `status.json`, a name in the helper file) goes to an administrator's
  terminal only through `shown` (`src/service/commands/io.js`), which is
  built on `plainLineProblem` (`src/cases/hidden-chars.js`): one plain line
  as it is, anything else stripped of control, hidden and bidi characters
  and marked. `session status`, `session probe`, `session install` and
  `uninstall` and doctor use it. `RequestLease` refuses a `reason` that is
  not one plain line by the same definition.
- **A GUI that cannot start never stops the service (R-F5-11).** A helper
  file that is there but wrong (owner, not JSON, does not decrypt,
  malformed, another node's) gives a subsystem that is off with the reason
  `session_file_invalid`; any other failure to build or start it (the
  endpoint taken by another process, say) gives `gui_start_failed`.
  `createGuiSubsystem` and its `start()` never throw. Off means: one error
  log line without the file's contents, no channel, no leases, the ten tools
  registered only to refuse with the reason, and `status.json` carrying it
  for `session status` and `doctor`. Never a weaker mode.
- The login start (`src/session/autostart.js`): a Windows logon task
  `KingLouie Session <user>` (`schtasks` by absolute path, the user's SID,
  `LeastPrivilege`), a macOS LaunchAgent, a Linux XDG autostart entry. A
  file in a user's home is written only by a child running as that user
  (`session _write-autostart` / `_remove-autostart`, uid and gid dropped by
  `spawnSync`), never by the elevated process.
- `KL_SESSION_FILE` (or `--session-file`, which the login start passes)
  points the helper at its per-user file; it is checked like the default path.
- GUI tools check the `gui` capability first, so a node without a working
  helper refuses before any approval or lease. Input needs a phone-signed
  lease; images reach the model only from tools flagged `emitsImages: true`,
  and `ToolExecutor` detaches `_images` before anything stores a result (a
  `PostToolUse` hook's result included). The agent loop places images for
  the provider that answered each call (`_currentProviderName`).
- A lease is bound to a job, read from the run's origin: `origin.job_id`,
  else `chat:<origin.session>`. A run with neither is refused
  (`job_required`), and a job the node does not know to be open closes its
  lease (`job_closed`; `isJobOpen` in `src/gui/index.js`: the fleet
  `JobManager` has it and it is not terminal, or the chat exists). Nothing
  defaults to open (owner ruling R-F5-7, 2026-10-12).
- **No GUI tool without `fleet:unsafe` (R-F5-13, which widens R-F5-3).** A
  run that refuses unsafe calls (a front-door client whose grant does not
  cover `fleet:unsafe` here, and its sub-agents, background tasks and
  workflow children) is refused by all ten GUI tools, `ListApps` and
  `Screenshot` included: `REFUSE_UNSAFE_MESSAGE`, before parameters are
  read or the broker, lease manager or helper is touched (the `tool()`
  wrapper in `src/gui/tools.js` reads the `refuseUnsafe` mark on the
  requester, M19). Such a delegate turn is not offered the tools either
  (`delegateToolNames(registry, { refuseUnsafe })`). A session the node
  started itself, and a client with `fleet:unsafe`, keep them.
- **Only allowlisted apps launch (R-F5-14).** `LaunchApp` takes an app id
  from `gui.apps`; a path outside the allowlist is `app_not_allowlisted`
  and nobody is asked. An allowlisted app with an argument outside its globs
  or a file outside `allowed_roots` is still an unsafe launch for the phone.
- **Contact (R-F5-15).** Input needs the granting phone to stay in touch.
  Contact is the grant and a `kl.lease.watch` from the granting device
  that echoes a **contact token**: the node puts 16 fresh random bytes in
  every status and view it signs and remembers when it issued each, a phone
  echoes the newest it has applied, and a watch counts only with a token of
  this lease issued inside the window that has not made contact before
  (using one retires the older ones). So a relay cannot bank watches and
  feed them in later; it can still hold one for up to the window, so input
  ends at most two windows after the phone's last signature. Any other
  accepted watch (another device's, no token, an old one) still asks for
  frames and is never contact. `gui.lease.contact_s` (120, at most 300)
  after the last contact the lease is suspended with the reason
  `no_contact` (input refuses `lease_suspended_no_contact`; what was held is
  released; no resume request is sent) until the next contact, which never
  moves the expiry. Every accepted watch is answered with a status signed
  then, and the replies to grant, revoke and watch carry it
  (`{ state, reason?, status? }`), so a phone always holds a young token.
  The contact timer is armed again for what is left when it fires before
  the window has lapsed on either clock, so the suspension never waits for
  the next input.
  A lease suspended for want of contact is taken over by any other reason
  that comes up meanwhile (the helper dropping, the relay link going),
  which then needs its own resume grant. Watch and revoke nonces are kept
  per lease for its lifetime (`LeaseNonces`), not in a 10-minute cache.
  Lease tests that pass more than two minutes on the fake clock send
  watches that echo the newest token (`watchFrom` in
  `tests/gui-leases.test.js`) or expect the suspension; the fake clock jumps
  to the end of an advance before its timers run, so a test that reads when
  something happened moves a second at a time.
- **A revoked device's leases end (third security review, an owner-side
  decision taken conservatively).** A live lease whose granting device is
  no longer an active approver ends at once with the reason
  `device_revoked` (`release_all`, a status, a `lease.ended` audit entry;
  input then says `lease_revoked`), in whatever state it is: active,
  paused, or waiting for a resume. `LeaseManager#checkGrantingDevices`
  runs when a phone's revoke is staged (`ApproverStore#onDeviceRevoked`:
  at once), before every input, and every `GRANTOR_CHECK_MS` (5 s) while a
  lease is live, which is how a running node finds what `device revoke` or
  `device apply` wrote: five seconds at worst. "No longer active" is
  `isActive` false for any reason, an approver set that has become
  unreadable or untrusted included (fail closed).
- **Two clocks.** `LeaseManager` measures contact, token age, what is left
  of a lease and the input rate on a monotonic clock (`performance.now()`,
  injectable as `monotonic`) as well as the wall clock, and believes
  whichever says "over" first: a clock set back cannot extend anything. A
  test that injects only `clock` gets that one clock for both.
- **Any enrolled phone can stop a lease (R-F5-18).** A revoke from any
  enrolled, unrevoked device ends a lease, and any such device may watch
  it (never contact). Only the granting device resumes it
  (`not_granting_device`; a deny of a resume is any phone's). Every status
  names the granting device (`granted_by`). A phone learns what is running
  with the one device-signed request it already makes: `GET /v1/leases`
  asks each node (`lease.list` → `LeaseManager#listFor`) and appends
  `{ node_id, envelope: null, status }` with statuses signed for that
  listing; there is no unsigned listing.
- **A relay cannot hide a live lease from a phone (R-F5-20).** A phone's
  `GET /v1/leases` carries `?nonce=` (32 bytes it chose for that request;
  in the query, so under the request signature it already makes, and no
  extra prompt on Android). The relay hands it to each node, and
  `LeaseManager#listingFor` signs a `kl.lease.listing` over the nonce, the
  phone (`to_device`) and each listed lease's id and status `seq`, also
  when it lists nothing. A phone takes a node's answer whole or not at all
  (`verifyLeaseListing` in `lease-protocol.js` is the reference;
  `Leases.verifyListing` / `checkListing` in both phone cores): its own
  nonce, itself, and a signed status for every lease named. A pinned node
  with no listing that checks is shown as "Could not confirm with <node>"
  (`unconfirmedLeaseNodes` in both apps), never as nothing running; an
  offline, slow or older node gives the same, because the phone cannot
  tell those from a relay that kept the answer back. Statuses that come
  without a listing are still applied one by one. The node keeps no
  listing nonces. What is left: a relay can still make a node look
  unreachable (denial is visible, not preventable). A change to the
  listing changes `verifyLeaseListing`, both cores and the `listing-*`
  vectors together.
- **What the fourth security review added to the listing.**
  - Three states per pinned node on both phones (`leaseChecks`): not asked
    (no entry: "Not checked yet: <node>"), confirmed ("Checked <node> at
    <time>: no computer-use session", or the counts; only from a listing
    `checkListing` accepted, with the phone's own time), unconfirmed. A
    locked iOS session asks nothing and keeps the earlier answer with its
    time; Android writes the state only in `refreshLeases`, on the tap.
  - Every agent or runbook node with an identity and the relay link
    answers `lease.list`. Where no lease manager exists (gui not enabled,
    no helper, no record of the identity, a GUI that could not be built, a
    runbook node) `answerLeaseListsWithNone` (`run.js`) registers
    `offLeaseListing` (`lease-protocol.js`), which signs a listing that
    names nothing: no lease can be live there. A node with a lease manager
    answers from it. An older build cannot answer.
  - A listing reuses a lease's newest status (`_listedStatus`) while it
    still says what the lease is and, for a lease that has not ended, is
    under `LIST_RESIGN_MS` (5 s) old with a token that has not made
    contact; an ended lease's status is never signed again. So `lease.list`
    cannot run up `seq` or flush the contact tokens.
  - "May still start": both apps remember the leases they sign a grant for
    (`signedLeaseGrants`, in memory). A node-signed `pending` status of
    such a lease gives a banner row with the usual Stop
    (`Leases.mayStillStart`); it goes on a signed `ended`, or when an
    accepted listing no longer names it after the request expired on both
    clocks (`dropMayStartRows`, `Leases.keepsMayStart`). Nothing is
    revoked or sent again by itself.
  - That memory never decides whether a pending lease has a row (fifth
    security review, finding 1: a restart loses it and no other phone has
    it). Every lease an accepted listing names as `pending` gets a row
    with the same Stop (`notePendingListed` in both apps, after the
    listing check and `dropMayStartRows`; `Leases.listedPendingGetsRow`),
    except a request that is on screen with Allow and Deny and that this
    phone remembers no grant for. Memory chooses the words:
    `Leases.pendingTitle` / `pendingDetail` say "May still start on
    <node>" only for a remembered grant, otherwise "A request is waiting
    on <node>" and that this phone does not remember allowing it. A row
    without a remembered grant goes with the first accepted listing that
    no longer names the lease; a row that is there stays while its node
    still signs `pending`, listing or not (`noteListedLease`). Android
    does this only inside the "Check" tap and sends nothing for it.
  - `Leases.isListing` in both cores is the node's
    `VALIDATORS['kl.lease.listing']` (exact keys, a real `at`, at most
    eight leases, each once), checked after the signature.
- The lease is checked again inside `GuiBroker#input`, after the process
  lookup and immediately before the send; a broker with no lease manager
  sends no input. A click, scroll or drag lands only when the window under
  the point is the screenshot's own window (all three backends).
- **The typed buffer** (`TypedBuffer`, `text-guard.js`) models the keys:
  text and printable keys append, Enter is a line break (it no longer wipes
  the buffer), backspace removes one, and anything that moves the caret
  (navigation keys, tab, a click, a drag, and every suspension of the
  lease) leaves what was typed as a piece of unknown place; only a new
  lease starts with nothing typed. Text after that is refused when at most
  four runs of the pieces (one from the new text) spell a vault value in
  any arrangement, or when the pieces spell it in the order they were
  typed, in any number, up to the text being typed. The history keeps 64
  pieces and 4096 code points.
- **Removals (third security review, finding 1).** The guard follows a
  bare Backspace: in the text at the caret, and past its start after End
  (it takes from the end of the piece typed last, and of the ones before it
  while nothing but End has moved the caret; what it took is kept as the
  piece's `cut`, and the piece is checked with and without it). Nothing
  else that removes text is followed. Those mark the field **lossy** for
  the rest of the lease (`keyEffect` / `applyKey` in `text-guard.js`, the
  one place that says what a key does to the buffer): Delete, Insert,
  Backspace with a modifier, every ctrl/alt/meta chord that is not a caret
  key, a Backspace where the caret's place is unknown (or after End once
  the caret has been elsewhere), a removal whose outcome is unknown, and
  text or a Backspace after a selection (shift with a caret key, a click
  that is not a plain single left click, a drag). In a lossy field a link
  of the in-order check may be a piece less up to `LOSSY_EDGE` (4)
  characters at each end, or any run of `LOSSY_RUN` (3) or more from it,
  and the command and token-prefix checks also run with up to 4 characters
  dropped where pieces join (the same number at every join). Not followed,
  as that file's header lists: a removal that completes a value or command
  with nothing typed after it (the guard checks when text is typed, never
  when it is removed), pieces of one or two characters with more than 4
  removed beside each, a command whose joins lost different numbers of
  characters, what tab, escape or a function key does in the app, a menu's
  Cut/Delete/Paste, more than four pieces typed out of order, text the app
  adds or moves itself, text already in the field, and the keyboard layout
  (a key press is taken for its US character: `SHIFTED` in `keys.js`). A
  short or repetitive vault value can refuse ordinary typing that happens
  to spell it piece by piece, more easily in a lossy field.
- **The guard's cost is bounded (third review, finding 2).** A vault value
  over 512 characters (`VALUE_FOLLOW_MAX`) is checked as a substring of the
  text only, never across pieces. One check has `STEP_BUDGET` steps for its
  work across pieces and refuses with `text_guard_limit` when they run out
  (fail closed; the history that caused it lasts until a new lease). Tests
  pass `stepBudget` to reach it.
- **Typed text goes out in pieces** of at most `TYPE_CHUNK` (40) code
  points, the lease checked before each (`GuiBroker#input`), so a Stop
  lands within one piece; a failure carries what went out (`err.typed`) and
  the typed buffer holds exactly that. The X11 backend kills the `xdotool`
  that is typing on `release_all`.
- **Key chords that leave the leased app** are denied per platform
  (`deniedReason`; `LEAVES_THE_APP` in `src/gui/keys.js` is the list the
  tests walk, and the file's header says what remains). On Linux that
  includes `ctrl+F1` to `ctrl+F12` (workspaces on Xfce and KDE).
- **Windows of an app.** The helper lists a process's owned windows too
  (dialogs, menus, dropdown lists; `owned`). `Screenshot` captures the
  foreground window when it is the app's, else the largest main window,
  names the app's other open windows (`other_windows`, by a broker-issued
  id, never a handle) and takes `window` to capture one. A menu is never
  picked by a guess. `point_obscured` says to take a new screenshot and
  which window covers the point. macOS still lists normal-layer windows
  only.
- **What reaches the relay (R-F5-16).** The live view's action log never
  holds typed text: `Typed 42 characters`, `Key (a character)`; keys that
  are not text keep their names. Pictures still show the window. The audit
  ledger is served to the relay's mirror and holds the same and no more: a
  `Type` entry is `{ length }` (no hash of the text), a `Key` entry names
  the key only when it is not text, and the `params_sha256` of a
  `tier.decision` is taken over that form (`Tool#auditParameters`; every
  other tool is hashed as called). A refused key is not repeated in its
  refusal, and the helper logs a failed input by its code alone. A
  worker's stderr can quote what it was sent, so once a `LineWorker` child
  has been sent an `input` op its stderr lines are logged as
  `worker_stderr (N characters, not shown)`, never the line; before that
  they are diagnostics.
  `mobile/PRIVACY.md` lists every clear field. Both phones apply a status or
  view only when its node `seq` is newer than the last applied for that
  lease, and a view only when `to_device` is this device
  (`Leases.acceptsStatus` / `acceptsView` in both cores).
- Case turns keep `ListApps` and `Screenshot` only: the eight acting GUI
  tools are in `CASE_BLOCKED_TOOL_NAMES`. Wake-up turns get no GUI tool;
  delegate turns get all ten unless they refuse unsafe calls (owner rulings
  R-F5-4, R-F5-13). `ListApps` output is marked `untrusted_output`.
- Tests never touch a real LaunchAgent, autostart entry or scheduled task,
  the real config or data dir, or a real elevated install:
  `tests/session-autostart.test.js` only renders and plans (a fake
  `spawnSync`), and `tests/service-cli-session.test.js` injects `isAdmin`,
  `isTTY`, `confirm`, `resolveSessionUser`, `resolveKey`, `verifyConfigDir`,
  `runIcacls`, `execute`, `localProbe` and `runHelper` over temp dirs (its
  one real PowerShell call only reads a temp dir's ACL, to see it refused).
  A helper test passes `checkUserCopyTrust` (the real one reads owners
  through PowerShell). A test that calls `runSessionHelper`
  passes `deps.attachLog: false` (else it writes the user's real helper
  log) and its own `deps.backend`; lease tests sign with the fake phone's
  `leaseGrant` / `leaseRevoke` (`tests/helpers/fake-phone.js`).
- No test injects input except the opt-in e2e:
  `KL_E2E_GUI=1 node --test tests/e2e/session-helper.test.js` on Windows or
  macOS in an interactive session (drives Calculator and Notepad/TextEdit;
  hands off the mouse and keyboard while it runs). Without the variable the
  suite is skipped. It stops its helper child by closing the child's IPC
  channel: on Windows `child.kill()` runs no `SIGTERM` handler.
- Checked on Windows only: the POSIX cases (file modes and owners, the
  user-side autostart writer, the Unix socket and its `0711` dir) are
  skipped there; the macOS JXA worker and the real-X11 suite need their own
  OS; no elevated install, logon task, LaunchAgent or autostart entry has
  been run for real on any OS. The Windows and macOS workers' input paths
  inject into the real desktop, so no test runs them: their hit-test rules
  are pinned by reading the worker sources
  (`tests/session-backend-windows.test.js`), which shows the rule is
  written, not that it works. Swift and Kotlin are not compiled by
  `npm test`.
- Vectors: `node tests/vectors/lease-v1/generate.js --check` (46) and
  `node tests/vectors/session-v1/generate.js --check` (6).
- The phones: iOS signs only `kl.lease.watch` with its API session (owner
  ruling R-F5-8) and sends it only while the live lease view is on screen
  with the app in front (R-F5-19: `setLiveViewVisible`, called by
  `LiveLeaseView` alone); with the view closed it still polls for statuses,
  so the banner and Stop stay, and the banner says "Paused: open to let it
  continue" for `no_contact`. Both apps echo the newest contact token they
  applied in each watch and show a banner row with a working Stop for every
  lease a pinned node reports as running, saying who granted one this phone
  did not (R-F5-18); iOS asks when it becomes active with its session
  unlocked, Android only when the owner taps "Check for computer-use
  requests". Android fetches on tap, sends each
  Stop, Allow and Refresh once and shows an unanswered send as not confirmed
  (R-F5-1, R-F5-5), and a lease push there fetches nothing (R-F5-6); its
  Refresh asks for a fresh status first when its token is over a minute old
  (four prompts then, three otherwise). On
  Android a relay's reply never changes the lease state on screen: only a
  status or view the pinned node signed does (`applyLease`), so after Stop
  it says "Stop sent, not yet confirmed by the computer" and Stop stays
  enabled. Its live screen says "Paused: tap Refresh to let it continue"
  for `no_contact` (R-F5-15), still with no timer. The app
  modules have no test target, so `tests/mobile-lease-apps.test.js` pins
  these rules by reading the Swift and Kotlin sources (it shows the rules are
  written into the code, not that the apps build). On Android a property that
  `AppModel`'s `init` reaches (through `startDemo`) is declared above `init`:
  `leaseRequests` is, for that reason. `mobile/PRIVACY.md` says what a relay
  operator sees of a lease.
