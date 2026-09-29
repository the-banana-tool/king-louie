# King Louie Chat History and Recall — Design Spec

- **Status:** Draft — design agreed with the owner 2026-09-25, awaiting spec review
- **Date:** 2026-09-25
- **Relates to:** `2026-09-22-king-louie-cases-design.md` (cases own curated
  facts and decisions; this spec owns verbatim history) and
  `2026-09-23-stage-program.md` (this work starts after the stages in that
  program have merged, §11.2).

## 1. Goal

Stop losing conversation history to compaction. Keep every message of every
chat verbatim in a local store, and on each turn give the model only the
history that matters for that turn: a short verbatim tail plus excerpts
retrieved by full-text and semantic search, under a token budget that does not
grow with the length of the chat. Spend local CPU instead of tokens. Make
"I told you that 300 messages ago" answerable, and make it visible what the
model was shown.

King Louie is open source. Nothing in the code, defaults or docs may be
specific to one person's setup. Model names, thresholds, weights and scopes
are settings.

### 1.1 Evidence

The owner's own agent sessions, measured on 2026-09-25, are the target case.
One Claude Code session (the cases and fleet stage program) contained 717
human messages and 1,886 tool calls, about 2.2 million tokens in total. It was
compacted 8 times; each compaction replaced roughly 275K tokens of history with
a 3 to 4K-token summary. Prose was 8% of the bytes; tool inputs and results
were 64%. Another session was compacted 5 times and lost details the owner
needed later.

The literature agrees that shorter, focused context beats a long transcript,
and that verbatim excerpts beat lossy summaries, provided retrieval is good
(Appendix A.4). No mainstream agent harness retrieves per turn from a full
local history; they summarize. The measured cost of doing it locally is small:
full-text search with BM25 is built into the Node runtime that ships with
Electron, brute-force vector search over 100K chunks takes about 94 ms, and a
small local embedding model indexes a 400-token chunk in 40 to 100 ms on a
mid-range laptop CPU (Appendix A.3).

King Louie already has a retrieval compactor (`src/context/conversation-compactor.js`),
but it needs an OpenAI key, indexes only prose, rebuilds its index per
process, and has never fired in the owner's profile. Tool calls and results are
persisted but filtered out before the model sees the next turn
(`src/ipc/chat-handlers.js:372`). All chats live in one JSON file rewritten on
every message (Appendix A.1).

### 1.2 Non-goals

- Replacing cases. Decisions, load-bearing unknowns and curated facts stay in
  the case ledger. A long chat should become a case (§9); this spec does not
  add a second pinned-facts mechanism.
- Extracting facts from turns with a model (Mem0-style memory). Lossy, costs a
  model call per turn, and duplicates the ledger.
- OCR or captioning of images. Images are stored, not indexed.
- A Rust implementation. The interfaces in §3.2 are the seams a native module
  could later replace; the SQLite schema is the contract.
- Paginated rendering of one very long chat in the renderer. The renderer
  loads one chat's messages at a time (§4.4); rendering within a chat is
  unchanged.
- Server-side context editing or provider memory tools. Recall is
  provider-independent.

## 2. Decisions

Settled with the owner on 2026-09-25:

| # | Decision | Consequence |
|---|---|---|
| D1 | Native modules are acceptable | Local embeddings use `@huggingface/transformers` with `onnxruntime-node`. Storage still uses the built-in `node:sqlite`, which needs no native module. |
| D2 | Tool calls and results are in scope | They are chunked and indexed like prose, ranked lower, and returned as quoted excerpts, never replayed as tool blocks. |
| D3 | Cross-chat recall is opt-in per chat, and other chats can be imported | Per-chat scope `chat`, `linked` or `all`; a link picker; importers for Claude Code sessions, Markdown transcripts and King Louie exports. |
| D4 | Long chats should become a case | No pinned block in this store. A nudge at a turn threshold offers conversion using the existing attach flow. |
| D5 | Optimize for fewest tokens per turn in very long chats, with the best recall the budget allows, and everything tunable | A per-turn token budget; every retrieval stage and weight is a setting; an evaluation script tunes the defaults. |
| D6 | The new store owns messages; implement after the current stage program | One-way migration out of `chat-data.json` with a backup; sequenced after F3, F6 and F7 land. |

Decisions made by the designer and labelled as such are in §16.

## 3. Architecture

Three layers, all Electron-free under `src/history/`:

1. **Store.** One SQLite database per data directory, `<dataDir>/history.sqlite`,
   opened with `node:sqlite` in WAL mode. It is the system of record for chats,
   messages and attachments, and holds the chunk, full-text and embedding
   indexes.
2. **Index.** Every appended message is split into chunks and written to the
   full-text index in the same transaction. Embeddings are computed off the
   main thread by a worker and written back as they finish.
3. **Recall.** On each turn a context builder assembles a verbatim tail and a
   recalled block under a budget. The model also gets two read-only tools,
   `SearchHistory` and `ReadHistory`, for anything the builder missed.

Per turn, in `src/ipc/chat-handlers.js`:

```
user message
  → store.appendMessage()                        (message + chunks + FTS rows, one transaction)
  → contextBuilder.build({ chatId, message })    (tail + recalled block + stats)
  → system prompt: stable part (cached) + dynamic part (case orientation, recalled block, memory context)
  → AgentLoop.run(tail + new message, tools, options)
  → assistant message appended with context provenance (§7)
  → embed worker catches up in the background
```

### 3.1 Principles

- **Nothing is condensed away.** Summaries never replace stored messages. The
  only lossy step is what the builder chooses to show this turn, and that is
  recorded.
- **Bounded per turn, unbounded on disk.** Input tokens are a function of the
  budget settings, not of chat length.
- **Degrade, never fail silently.** No embedder means BM25 only, with a
  warning and a UI badge. No store means an error, not a fallback to the JSON
  file.
- **The model can always ask for more.** The recalled block says it may be
  incomplete and names the tools, the same way orientation names
  `Ledger.query`.
- **Show your work.** Each assistant message records exactly which excerpts
  and which tail it was given, and exports include it.
- **Host-agnostic.** `src/history/` requires nothing from Electron.
  `tests/electron-boundary.test.js` applies. The Electron host may inject a
  utility-process embed runner; the service uses `worker_threads`.

### 3.2 Interfaces

```
HistoryStore
  open(path, { readonly? })            close()
  listChats() → ChatMeta[]             getChat(id, { messages: true }) → Chat
  createChat(chat)  updateChat(id, patch)  deleteChat(id)
  appendMessage(chatId, message) → { message, seq }
  truncateFrom(chatId, seq)            getMessages(chatId, { fromSeq, toSeq, limit })
  searchText(query, { chatIds, kinds, limit, upToSeq? }) → [{ chunkId, score }]
  chunks(ids) → Chunk[]                vectors(model, chatIds, { upToSeq? }) → { ids, matrix: Float32Array, dim }
  pendingEmbeddings(model, limit)      putEmbeddings(model, [{ chunkId, vec }])
  getLinks(chatId)  setLinks(chatId, ids)   recordImport(row)  findImport(sourceHash)
  calibration(model) / setCalibration(model, charsPerToken)

Embedder
  name, dim, embed(texts, { kind: 'query' | 'document' }) → Float32Array[]
  implementations: local-onnx, ollama, openai, none

Retriever
  retrieve({ query, chatIds, kinds, excludeMessageIds, budgetTokens, settings })
    → [{ chunk, score, signals: { bm25Rank, vectorRank, rerank, recency, kindWeight } }]

ContextBuilder
  build({ chatId, message, model, upToSeq? }) → { tail: Message[], recalled: { text, chunkIds, estTokens }, stats }
  // upToSeq: consider only messages with seq < upToSeq (used by the benchmark to ask at a point in time)

EmbedRunner (host seam)
  start(embedderConfig)  embed(texts, kind)  stop()   events: ready, error, crashed

Importer
  kind, detect(path) → boolean, preview(path) → { title, turns, sample }, parse(path) → { chat, messages }
```

## 4. The history store

### 4.1 Schema

```sql
schema_version(version INTEGER NOT NULL);

chats(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT, updated_at TEXT,
  agent_mode INTEGER, sandbox_mode INTEGER, case_id TEXT, working_directory TEXT,
  source TEXT,                 -- null for native chats; importer kind otherwise
  history_scope TEXT NOT NULL DEFAULT 'chat',   -- chat | linked | all
  meta_json TEXT               -- disabledMcpServers, llmTotals, caseNudgedAt, anything else
);

messages(
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, sender TEXT NOT NULL,   -- user | assistant | toolUse | toolResult | status
  text TEXT, timestamp TEXT NOT NULL,
  tool_name TEXT, params_json TEXT, result_json TEXT, run_id TEXT,
  llm_json TEXT, context_json TEXT, meta_json TEXT,
  UNIQUE(chat_id, seq)
);

attachments(
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- image | document
  name TEXT, mime TEXT, bytes BLOB, text TEXT   -- text: extracted document text, if any
);

chunks(
  id INTEGER PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL, idx INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- user | assistant | tool_use | tool_result | attachment | summary
  text TEXT NOT NULL, chars INTEGER NOT NULL, ts TEXT NOT NULL
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content='chunks', content_rowid='id',
  tokenize = "unicode61 tokenchars '_-./'"
);
-- triggers keep chunks_fts in step with chunks on insert and delete

embeddings(
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL,   -- little-endian float32
  PRIMARY KEY (chunk_id, model)
);

chat_links(chat_id TEXT NOT NULL, linked_chat_id TEXT NOT NULL, PRIMARY KEY (chat_id, linked_chat_id));

imports(id TEXT PRIMARY KEY, source_kind TEXT, source_path TEXT, source_hash TEXT UNIQUE,
        chat_id TEXT, imported_at TEXT);

calibration(model TEXT PRIMARY KEY, chars_per_token REAL NOT NULL, samples INTEGER NOT NULL);
```

`seq` is per chat, dense, and is the number the model sees (`#412`). Deleting
a message is not supported except through `truncateFrom`, which keeps `seq`
dense from the start. The FTS tokenizer keeps `_`, `-`, `.` and `/` inside
tokens so identifiers, file paths and hostnames match as typed; there is no
stemming.

### 4.2 Message shape

The stored message keeps today's in-memory shape (`id, sender, text,
timestamp` plus per-sender metadata: `images`, `documents`, `llm`, `toolName`,
`parameters`, `result`, `runId`). `getChat(id, { messages: true })` returns
exactly that shape so the renderer and every existing consumer see no
difference, with two additions: `seq`, and `context` on assistant messages
(§7). Images and documents are stored in `attachments` and re-inflated into
`images` / `documents` on read.

### 4.3 Chunking

Rules, applied at append time and identical for native and imported messages:

| Sender | Chunk kind | Rule |
|---|---|---|
| `user`, `assistant` | `user`, `assistant` | Split on blank lines, then lines, then hard-split, targeting `history.chunk.targetChars` (default 1,500, about 300 to 500 tokens); drop chunks under `minChars` (40). This is the existing splitter in `conversation-compactor.js`, moved. |
| `toolUse` | `tool_use` | One chunk: `<toolName>: <one-line summary>` where the summary is the command for shell tools, the path for file tools, the query for search tools, and the first 200 characters of the parameters otherwise. Write and Edit contents are chunked additionally as prose. |
| `toolResult` | `tool_result` | The result rendered as text (string results as-is, objects as pretty JSON), chunked as prose. `history.embedder.maxChunksPerToolResult` caps how many chunks of one result are embedded (default 0, unlimited); all chunks are always in the full-text index. |
| document attachment | `attachment` | Extracted text chunked as prose. |
| imported compaction summary | `summary` | Chunked as prose. |
| `status`, images | none | Not indexed. |

### 4.4 Facade over the store, and lazy chat loading

`getChats()` and `setChats()` in `src/core/create-core.js` are removed. Their
50 call sites (16 in `create-core.js`, 24 in `chat-handlers.js`, 5 in
`canvas-handlers.js`, 3 in `case-handlers.js`, 2 in `workflow-handlers.js`)
move to explicit store calls: `listChats()` for metadata, `getChat(id, {
messages: true })` for one chat, `updateChat` for patches, `appendMessage` for
messages. `appendMessageToChat(chatId, sender, text, metadata)` keeps its
signature and returns the updated chat as today, implemented over
`appendMessage`; `llmTotals` is recomputed incrementally from the appended
message and stored in `meta_json`.

`chat:load` returns every chat's metadata (with `messageCount` and
`lastMessageAt`) plus the messages of the active chat only. A new `chat:get`
returns one chat with messages; the renderer calls it when the active chat
changes and keeps at most the active chat's messages in memory. This is the
one renderer data-model change in this spec and it is what makes a 2 million
token chat affordable to open.

Implementation note, 2026-09-29: the compatibility slice of this data-model
change has landed before the SQLite store migration. `chat:get` now exists in
the JSON-backed IPC layer, `chat:load` returns messages only for the active chat
and metadata/preview/counts for inactive chats, and the renderer loads/merges
the active chat on startup and when switching chats. The H1 store/facade work
can replace the backing JSON reads with explicit store calls without another
renderer contract change.

Implementation note, 2026-09-29 H1 seam: `src/history/` now contains a
`JsonChatHistoryStore` facade over the existing `chat-data.json` `chats` array.
`createCore` exposes `historyStore`, `listChats`, `getChat` and `updateChat`
while preserving `getChats`, `setChats` and `appendMessageToChat` for current
call sites. `chat:load` and `chat:get` prefer the facade and fall back to the
legacy helpers in isolated tests. This is deliberately not the SQLite migration;
it is the adapter seam that lets later H1 steps move storage without changing
IPC or renderer contracts again.

`chat-data.json` keeps `activeChatId`, `apiTokens`, `apiStatus`, `settings`,
`toolApprovals`, `usage` and everything else it holds today. Only `chats`
moves.

## 5. Indexing

### 5.1 Synchronous part

`appendMessage` inserts the message, its attachments, its chunks and the FTS
rows in one transaction. A failed transaction throws; the caller (the send
path) fails the turn loudly. WAL mode and `busy_timeout = 5000` cover the
worker reading while the main thread writes.

### 5.2 Embeddings

An `EmbedRunner` hosts one `Embedder` off the main thread. The default runner
uses `worker_threads` (`src/history/embed-worker.js`) and works in both hosts.
The Electron host may inject `deps.history.embedRunner` backed by
`utilityProcess` for crash isolation; `main.js` does so, `src/service/run.js`
does not.

The catch-up loop: every `history.embedder.intervalMs` (2,000) or on demand
after an append, take up to `batchSize` (16) pending chunks for the active
model, embed them with `kind: 'document'`, write them back. Priority: the
chat with the most recent append first, then the rest by chunk id. Model
prefixes (`search_document:` for nomic, the bge query instruction, and so on)
live in the embedder implementation, keyed by model name.

Changing the embedder model does not delete old vectors; the new model's rows
fill in over time and retrieval uses whatever model is active. A settings
action "rebuild embeddings" deletes the active model's rows and re-queues.

Embedder implementations:

| Kind | Backend | Notes |
|---|---|---|
| `local` (default) | `@huggingface/transformers` on `onnxruntime-node`, int8 weights | Default model `Xenova/bge-small-en-v1.5` (384 dims, MIT). Model files download on first enable into `<dataDir>/models/` with progress in the UI; nothing is bundled in the installer. Offline first run means BM25 only until the download succeeds. |
| `ollama` | `POST /api/embed` on the configured Ollama base URL | Default model `nomic-embed-text`; the user must run Ollama. |
| `openai` | existing `OpenAIEmbeddingProvider` | Sends chunk text to OpenAI; the settings UI says so. |
| `none` | | BM25 only. |

Local rerankers (§6.3) use the same runner.

### 5.3 Vectors in memory

Retrieval loads the active model's vectors for the chats in scope into one
`Float32Array` matrix per chat, cached with an LRU bounded by
`history.retrieval.vectorCacheMb` (256). Appends extend the cached matrix.
Search is a brute-force dot product over unit vectors: measured at 94 ms for
100K × 384 on a 2021 laptop CPU, which covers roughly 40 million tokens of
history in scope before a query exceeds 100 ms. An approximate index is not
part of this spec.

## 6. Recall per turn

### 6.1 The tail

The tail is the most recent `history.retrieval.tailMessages` (8) `user` and
`assistant` messages, capped at `tailTokens` (6,000). With
`tailIncludeToolCalls` (true) each `toolUse` in that span appears as its
one-line summary, and `toolResult`s are omitted; they are reachable by recall
and `ReadHistory`. A tail message over `tailMaxMessageTokens` (1,500) is
replaced by its chunks that scored best for this turn's query, followed by a
marker: `[message #412 shortened: 3 of 11 paragraphs shown; ReadHistory 412
for the rest]`. This preserves today's behaviour for a large pasted article.

### 6.2 The query

The query text is the new user message plus the previous
`queryUserTurns` (2) user messages, newest first, joined with newlines. This
covers follow-ups that refer back with pronouns without a model call. An
optional model rewrite is not in this spec; the evaluation script (§13) will
show whether it is needed.

### 6.3 Retrieval

Scope is the chat's `history_scope`: `chat` (this chat), `linked` (this chat
plus its `chat_links`), or `all`. Chunks whose messages are already in the tail
are excluded.

1. **Lexical.** FTS5 `MATCH` over the scope with the query's terms OR-ed and
   any quoted phrases kept as phrases; FTS syntax in the query is escaped.
   Top `bm25TopK` (50) by `bm25()`.
2. **Semantic.** The query embedded with `kind: 'query'`; top `vectorTopK`
   (50) by cosine. Skipped when no embedder is active.
3. **Fusion.** Reciprocal rank fusion, `score = Σ 1 / (rrfK + rank)`,
   `rrfK` 60. With one signal only, that signal's ranks are used alone.
4. **Kind weight.** Multiply by `kindWeights`: `user` 1.2, `assistant` 1.0,
   `summary` 0.9, `attachment` 0.9, `tool_use` 0.7, `tool_result` 0.6.
5. **Recency.** Multiply by `(1 - w) + w · exp(-age / halfLife)`,
   `recencyWeight` 0.3, `recencyHalfLifeDays` 30.
6. **Rerank (optional).** When `rerank.enabled` (false), a local cross-encoder
   (`rerank.model`, default `Xenova/ms-marco-MiniLM-L-6-v2`) rescores the top
   `rerank.topM` (20) query/chunk pairs and its score replaces the fused score
   for those. Measured at about 60 ms per pair on CPU, so `topM` is the latency
   knob.
7. **Dedupe.** Drop a chunk whose cosine to an already selected chunk exceeds
   `dedupeCosine` (0.92); without vectors, drop exact text duplicates.
8. **Budget.** Take chunks in score order until `recalledTokens` (6,000),
   with at most `maxChunksPerMessage` (4) from one message. Adjacent chunks
   of one message merge.

### 6.4 The recalled block

Selected chunks are grouped by message and ordered by chat, then `seq`. The
block is plain text:

```
<recalled_history>
Excerpts retrieved from earlier in this conversation. They are verbatim and may be
incomplete. Use SearchHistory to look for more and ReadHistory to read a range of
messages by number.

[#412 · user · 3 days ago]
...

[#588 · Bash result · excerpt 2 of 9 · 2 days ago]
...

[chat "Fleet stage 3" · #91 · assistant · 12 days ago]
...
</recalled_history>
```

The cross-chat header form appears only for chunks from another chat. When
nothing is selected the block is omitted and the tools remain.

### 6.5 Placement and prompt caching

`options.systemPrompt` (stable) gains a sibling `options.systemPromptDynamic`.
The stable part is the system sections and the deferred-tools list from
`ContextAssembler`, unchanged across turns. The dynamic part is, in order: the
case-mode prompt and orientation when the chat is attached to a case, the
recalled block, then the memory context from `buildMemoryContextSection`.

`anthropic-provider.js` builds the system prompt as two text blocks with
`cache_control` on the first only; today it caches the whole string, and the
per-turn orientation and memory context break that cache every turn. Every
other provider concatenates the two parts with a blank line. `AgentLoop`
passes both through untouched.

Messages sent to the model are the tail plus the new user message. No
synthetic tool blocks are fabricated, so provider pairing rules are never at
risk.

### 6.6 Token estimates

`TokenEstimator` converts characters to tokens with a per-model ratio,
default 4 chars per token, corrected after every response from the ratio of
the provider's reported `inputTokens` to the characters sent (exponential
moving average, stored in `calibration`). Budgets in this spec are in those
estimated tokens.

## 7. Provenance

Every assistant message the send path appends carries:

```json
"context": {
  "tail": { "fromSeq": 401, "toSeq": 419 },
  "recalledChunkIds": [8812, 8813, 9107],
  "estTokens": { "system": 3100, "tail": 2900, "recalled": 1850 },
  "fullHistoryEstTokens": 412000,
  "embedder": "local:Xenova/bge-small-en-v1.5",
  "scope": "chat"
}
```

Chat exports include it. The renderer shows one line under the message,
"recalled 3 excerpts · about 1.9K tokens · from 412K tokens of history", that
expands to the excerpts (fetched by `history:excerpts`). The same line reads
"recall unavailable: BM25 only, embedding model not loaded" when degraded.

## 8. Tools

Registered in `src/tools/builtin/history-tools.js`, always in the core tool
set, read-only, `requiresApproval: false`:

- `SearchHistory({ query, scope?: 'chat'|'linked'|'all', kinds?: string[], limit?: number })`
  runs §6.3 without the budget step and returns up to `limit` (10) excerpts
  with `#seq`, sender, age and, for other chats, the chat id and title. `scope`
  may narrow the chat's own scope for that call; it can never widen it. A chat
  scoped to `chat` searches only itself whatever the model asks for.
- `ReadHistory({ chatId?, fromSeq, toSeq })` returns the verbatim messages in
  the range, tool results included, capped at `history.readHistoryMaxTokens`
  (8,000) with a truncation note. `chatId` may only name this chat or a chat
  within scope.

Both tools use the executor's existing `postExecute` path, so their results
are stored like any other tool result but are chunked with kind `tool_result`
and weight as such. This is deliberate: a recalled excerpt that the model then
reads in full is not re-indexed as new prose.

## 9. Cases

No pinned block. When a chat that is not attached to a case passes
`history.caseNudgeAfterUserTurns` (40) user messages, and `meta_json.caseNudgedAt`
is unset, the send path appends one `status` message with an action
`convertToCase`, sets `caseNudgedAt`, and adds one sentence to that turn's
dynamic system part: "This chat is long; if it is about a task with decisions
worth keeping, suggest the owner convert it to a case." The renderer renders
the action as a button that opens the existing attach flow in
`src/ipc/case-handlers.js`. Once attached, the recalled block sits after the
orientation (§6.5), `SearchHistory` still searches only chat history, and
`Ledger` remains the only place decisions live.

## 10. Cross-chat and import

### 10.1 Scope and links

`history_scope` is set per chat from the chat menu ("Recall from: this chat /
linked chats / all chats"); default `chat`. "Link chats…" opens a picker that
writes `chat_links`. Links are one-directional and the picker says so. The
default is private by design: a work chat never surfaces a personal chat
unless the owner linked it.

### 10.2 Importers

`src/history/importers/` with one module per kind, all producing a chat with
`source` set and messages in the stored shape, chunked by the same rules:

| Kind | Detects | Mapping |
|---|---|---|
| `claude-code-jsonl` | a `.jsonl` whose first records have `type` in `user`/`assistant` and `message.content` | `text` blocks → `user`/`assistant`; `tool_use` → `toolUse` (`toolName`, `parameters`); `tool_result` → `toolResult`; string user content with `isCompactSummary` → `status` with chunk kind `summary`; other record types skipped. Subagent files are skipped in this spec. |
| `markdown-transcript` | headings that alternate roles (`## User` / `## Assistant`, `### User`, `## Turn N`, `## Message N`, `## <Name>` / `## Assistant`) | Heuristic role detection; `preview` returns the detected turn count and the first five role assignments; the UI shows them and the owner confirms or picks a different heading pattern before `parse`. |
| `king-louie-json` | the app's own chat export | One-to-one. |

Imports are idempotent by `source_hash` (SHA-256 of the file); re-importing
the same file returns the existing chat. Imported chats are ordinary chats:
they can be continued, linked, scoped and deleted. Indexing runs in the
background like any other chat. Import is exposed as `history:import.preview`
and `history:import.commit` and as `king-louie-service history import <path>`.

## 11. Migration and rollout

### 11.1 Migration

On core start, if `history.sqlite` has no `migrated_from_json` marker and the
JSON store's `chats` array is non-empty:

1. Write `<dataDir>/chat-data.backup-<timestamp>.json`, a copy of the whole file.
2. For each chat, in its own transaction: insert the chat, its messages with
   dense `seq`, and its attachments; chunk and index. Verify the message count.
3. Chats that fail are logged with the error, left in the JSON array, and
   reported to the UI as "N chats could not be migrated; see log". Successful
   chats are removed from the array.
4. When the array is empty, set the marker. The backup is never deleted by the
   app.

Embedding backfill then runs in the background with a progress badge. The
migration is idempotent; a crash midway resumes on the next start.

### 11.2 Rollout

This work starts after F3, F6 and F7 have merged, because it edits the same
`create-core.js`, `chat-handlers.js` and `anthropic-provider.js` seams. There
is no dual-store mode. `history.retrieval.enabled` (true) is the kill switch:
off, the builder sends the tail only, tools stay registered, indexing continues.

Stages, each with its own implementation plan and each shippable on its own:
H1 store, migration, facades, lazy
chat loading; H2 chunking, full-text index, BM25 recall, context builder, the
two tools, provenance and the recall line; H3 embedders, fusion, rerank, the
evaluation script; H4 scope, links, importers, the case nudge.

## 12. Relationship to existing code

| Path | Change |
|---|---|
| `src/history/` (new) | `history-store.js`, `schema.js`, `chunker.js`, `retriever.js`, `context-builder.js`, `token-estimator.js`, `embedders/{local-onnx,ollama,openai,none}.js`, `embed-worker.js`, `embed-runner.js`, `importers/*.js`, `migrate-json.js`, `index.js` |
| `src/core/create-core.js` | opens the store from `paths.dataDir` (or `deps.history.dbPath`), runs migration on start, replaces `getChats`/`setChats` with store calls, exposes `getHistoryStore`, `getContextBuilder`, `getEmbedRunner` on `context`; `appendMessageToChat` keeps its signature |
| `src/ipc/chat-handlers.js` | send path uses the builder (§3), `chat:load` returns metadata plus the active chat, new `chat:get`, case nudge (§9), all `getChats` call sites |
| `src/ipc/history-handlers.js` (new), `src/ipc/constants.js`, `preload.js` | `history:search`, `history:excerpts`, `history:links.get/set`, `history:scope.set`, `history:import.preview/commit`, `history:index.status`, `history:reindex`, `chat:get` |
| `src/ipc/canvas-handlers.js`, `case-handlers.js`, `workflow-handlers.js` | `getChats` call sites |
| `src/workflows/workflow-engine.js`, `src/workflows/planner-executor.js` | `getConversationCompactor` replaced by `getContextBuilder`; parent history comes from the store |
| `src/execution/agent-loop.js` | passes `systemPromptDynamic` through; `APICompaction` unchanged |
| `src/providers/anthropic-provider.js` | stable/dynamic system blocks, `cache_control` on the stable block only |
| `src/providers/*` (others) | concatenate stable and dynamic |
| `src/cases/chat-integration.js` | `buildCaseSystemPrompt` returns the case part for the dynamic block instead of prepending to the base |
| `src/tools/builtin/history-tools.js` (new), `src/tools/index.js` | `SearchHistory`, `ReadHistory` |
| `src/context/conversation-compactor.js`, `tests/conversation-compactor.test.js` | removed; the chunker moves to `src/history/chunker.js` |
| `src/context/context-assembler.js` | unchanged in this spec; its tool-matching embeddings still use the OpenAI provider (follow-up: switch to the `Embedder` interface) |
| `src/core/settings.js` | new `history` namespace (§14) |
| `src/service/run.js`, `src/service/cli.js`, `src/service/commands/history.js` (new) | `history import`, `history reindex`, `history status` subcommands |
| `main.js` | injects a `utilityProcess` embed runner; filters the `node:sqlite` ExperimentalWarning |
| `renderer.js`, `styles.css`, `index.html` | active-chat loading via `chat:get`, recall line and excerpt drawer, chat menu items (scope, links, import, convert to case), settings section "History and recall", indexing and embedder badges |
| `package.json` | `@huggingface/transformers` dependency; `asarUnpack` for `onnxruntime-node`; `!**/models/**` excluded from the build |
| `src/bench/`, `bin/king-louie-bench.js` | the session memory benchmark, specified separately (§13) |
| `CLAUDE.md` | one section: where history lives, how to run the benchmark smoke test, the ExperimentalWarning |

`src/memory/` (the memory panel and `MemoryManager`) is untouched.

## 13. Testing

Unit tests with `node --test`, one file per module under `tests/history-*.test.js`,
each on a temp data directory:

- store: schema creation and versioning, append and dense `seq`, truncate,
  attachments round trip, links, imports idempotency, calibration.
- chunker: every row of §4.3, including a 60K-character tool result and a
  pasted article.
- retriever: BM25 alone, vectors alone, fusion, kind weights, recency, dedupe,
  per-message cap, budget fill, scope filtering, tail exclusion. Uses the
  existing bag-of-words fake embedder from `tests/conversation-compactor.test.js`.
- context builder: tail rules, shortened large messages, the block format,
  provenance, `enabled: false`.
- tools: scope enforcement, `ReadHistory` cap.
- embed runner: worker lifecycle with a fake embedder, crash and restart,
  `maxChunksPerToolResult`.
- importers: fixture files checked into `tests/fixtures/history/` that are
  synthetic (a ten-record Claude Code JSONL, a short Markdown transcript, a
  King Louie export). No real transcript enters the repo.
- migration: from a `chat-data.json` fixture, including one deliberately
  corrupt chat, verifying backup, partial success reporting and resume.
- providers: the Anthropic stable/dynamic system blocks and the concatenation
  in one other provider.
- `tests/electron-boundary.test.js` passes with `src/history/` present.
- e2e: send a message in a chat with 50 seeded messages on a temp data dir and
  assert the assistant message carries `context` and the recall line renders.

**Evaluation.** Retrieval quality is measured by the session memory benchmark
(`2026-09-25-session-memory-benchmark-design.md`), which imports a session,
asks verified questions at a point in the session, and reports evidence
recall, answer correctness, tokens per turn and latency per configuration.
This spec adds `upToSeq` to `ContextBuilder.build` and to the store's
`vectors` and `searchText` so the benchmark can ask at a sequence number
without leaking later messages. The owner's fixtures are his own sessions and
the transcript exports in his Downloads folder; they stay outside the repo.
The defaults in §14 are provisional until the benchmark has been run on the
2.2 million-token session; the acceptance target for that session is evidence
recall at a 6K recalled budget of at least 0.8 on its verified question set,
with the builder's output under 15K estimated tokens per turn.

## 14. Settings

```js
history: {
  retrieval: {
    enabled: true,
    tailMessages: 8, tailTokens: 6000, tailMaxMessageTokens: 1500, tailIncludeToolCalls: true,
    recalledTokens: 6000, queryUserTurns: 2,
    bm25TopK: 50, vectorTopK: 50, rrfK: 60,
    kindWeights: { user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 },
    recencyWeight: 0.3, recencyHalfLifeDays: 30,
    maxChunksPerMessage: 4, dedupeCosine: 0.92,
    rerank: { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 20, maxMs: 2000 },
    vectorCacheMb: 256
  },
  embedder: {
    kind: 'local',                                   // local | ollama | openai | none
    model: 'Xenova/bge-small-en-v1.5',
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
    openai: { model: 'text-embedding-3-small' },
    batchSize: 16, intervalMs: 2000, maxChunksPerToolResult: 0
  },
  chunk: { targetChars: 1500, minChars: 40 },
  caseNudgeAfterUserTurns: 40,
  readHistoryMaxTokens: 8000
}
```

Per chat: `history_scope` and `chat_links` (§10.1). Every key merges through
`mergeSettings` like the other namespaces and is editable in the settings
section "History and recall"; the weights and top-k values sit behind an
"advanced" disclosure.

## 15. Error handling

| Failure | Behaviour |
|---|---|
| Store will not open (corrupt file, locked, disk full) | Core start reports the error to the UI and the log; the JSON file is untouched; the app shows chats as unavailable rather than reading the JSON file. |
| `appendMessage` transaction fails | The turn fails with the error; nothing is sent to the provider. |
| Embedder unavailable (model download failed, Ollama down, key missing) | Retrieval runs BM25 only; one warning in the log per session; the recall line and a settings badge say so; retry on the next catch-up tick. |
| Embed worker crashes | Restart with backoff (1 s, 5 s, 30 s); after three crashes in ten minutes the local embedder is disabled for the session with a badge. |
| Model download interrupted | Partial files are discarded; the next enable retries. |
| Migration of one chat fails | That chat stays in the JSON array and is reported; the rest migrate; the backup exists before any change. |
| Reranker slower than `rerank.maxMs` (2,000) | The rerank step is skipped for that turn and logged. |
| FTS query syntax error from user text | The query is escaped before use; a residual error falls back to the vector signal alone, then to the tail alone. |
| `ReadHistory` range outside scope | The tool returns an error naming the allowed scope; nothing is read. |

## 16. Assumptions made without asking

Labelled decisions the owner can overturn:

- `node:sqlite` rather than better-sqlite3, because it is built into both the
  Node the service runs on and the Node bundled in Electron 41, proven here
  with FTS5, and needs no packaging work. It still prints an ExperimentalWarning
  on Node 24; the hosts filter that one warning.
- bge-small-en-v1.5 as the default local model: better retrieval quality than
  MiniLM for about 2.5x the CPU, still about 100 ms per chunk in the background.
- Models download on first enable rather than shipping in the installer.
- The tail excludes tool results by default and includes one-line tool call
  summaries.
- Reranking off by default until the evaluation script shows it earns its
  latency.
- Brute-force vector search only; no approximate index.
- Compaction summaries in imported Claude Code sessions are kept and indexed
  with kind `summary`, since they are the only record of what was condensed.
- Subagent transcripts in Claude Code sessions are not imported yet.
- The renderer holds only the active chat's messages; the sidebar uses
  metadata.
- `SearchHistory` and `ReadHistory` results are stored and indexed like any
  tool result rather than being exempt.
- `history_scope` defaults to `chat`, and links are one-directional.

## Appendix A: Research record (2026-09-25)

### A.1 What King Louie does today

- `ConversationCompactor` (`src/context/conversation-compactor.js`) already does chunk-level embedding retrieval in the send path (`src/ipc/chat-handlers.js:378`), but only with an OpenAI key (`src/memory/embedding-provider.js` is the sole embedder). The real profile has no `memory/embedding-cache.jsonl`, so it has never fired. Without a key the whole user/assistant history is sent every turn.
- Tool calls and results are persisted raw (`sender: toolUse | toolResult`) but filtered out before the model sees the next turn (`chat-handlers.js:372`). Only final prose crosses a turn boundary.
- `APICompaction` (`src/context/api-compaction.js`) blanks old tool results inside one agent-loop run, Anthropic-only by constructor default (`src/execution/agent-loop.js:72-79`), no unit tests.
- Storage: one `chat-data.json` (electron-store / `JsonFileStore`) holding chats, API tokens, usage and settings, rewritten whole on every append; attachments inline as base64. No FTS, no tokenizer (chars/4 everywhere), `contextWindow` metadata unused, no settings for any threshold.
- `cache_control` is Anthropic-only; the whole system prompt is one cached block (`anthropic-provider.js:100-114`), so the per-turn case orientation and memory context already invalidate the cache each turn.
- Thinking blocks are never round-tripped into tool-continuation messages (`anthropic-provider.js:501-559`).
- Headless turns (`agentExecutorAdapter`, `create-core.js:2292-2327`) build their own prompt and do not read chat history; only `workflowEngine` wires `getParentChatMessages` and the compactor.
- Precedent: cases (`src/cases/orientation.js`) rebuild a bounded block from disk each turn with an explicit "N more not shown; use Ledger.query" overflow marker. The stage program (§4.10) ruled "keyword/BM25 in pure JS; embeddings optional and only through existing providers" for the cross-case index.

### A.2 Measured data

Real King Louie profile: 46 chats, 40 user messages total, median 1 message per chat, 5 chats over 6K estimated tokens.

Claude Code session `7844ab46` (cases/fleet stage program), the target case:

| Measure | Value |
|---|---|
| Records / human messages / tool calls | 11,925 / 717 / 1,886 |
| Total | ~8.9M chars, ~2.2M tokens |
| Compactions | 8; summaries 10.6K to 15.6K chars each (~3 to 4K tokens) replacing ~275K tokens |
| Bytes by kind | text 8%, tool_use input 34%, tool_result 30%, injected user strings 28%, thinking <1% |
| Tool results | median 378 chars, p90 2,425, max 65,933 |
| By tool (calls, in KB, out KB) | Bash 1,013 / 783 / 1,365; Agent 453 / 971 / 498; Write 75 / 771 / 15; Read 22 / 3 / 670; SendMessage 223 / 356 / 47; Edit 66 / 45 / 13 |

Two other sessions: `c50cf468` 53 human messages, 285 tool calls, ~319K tokens, 1 compaction; `fa1e0e9a` 12 human messages, 58 tool calls, ~75K tokens, tool_result 57% of bytes. Across all projects: 43 sessions, 12 over 5 MB, largest 37 MB.

Downloads transcripts (Perplexity Computer exports, 2026-09-22): four files of 7.4K to 39K tokens, 70 to 131 turns, heading-delimited (`## Message N`, `## Turn N`, `### User`/`### Assistant`, `## Seth`/`## Assistant`). Personal data: local eval fixtures only.

### A.3 Benchmarks on the owner's machine (AMD Ryzen 5 5600H, 12 threads, Node 24.13, Electron 41.0.4)

| Experiment | Result |
|---|---|
| `node:sqlite` FTS5 + `bm25()` | Works in Node 24.13 (SQLite 3.50.4) and in Electron 41's bundled Node 24.14 (SQLite 3.51.2). Zero native modules. Emits ExperimentalWarning. |
| Brute-force cosine, Float32Array, single thread | 10K×384: 7 ms; 100K×384: 94 ms (154 MB); 100K×768: 136 ms; 500K×384: 228 ms (768 MB) |
| transformers.js 4.3 + onnxruntime-node, int8, ~400-token chunks, 64 docs | all-MiniLM-L6-v2 42 ms/chunk (384d, load 2.4 s); bge-small-en-v1.5 102 ms/chunk (384d); nomic-embed-text-v1.5 314 ms/chunk (768d, load 5 s) |
| Cross-encoder ms-marco-MiniLM-L-6-v2, int8 | 1,843 ms for 30 query/candidate pairs (~61 ms/pair) |
| transformers.js WASM in Node | Not available: `device: 'wasm'` rejected (only dml/webgpu/cpu); the web bundle is blocked by the package export map and, imported by path, still selects the Node backend |
| Footprint | node_modules 479 MB (onnxruntime-node all platforms); MiniLM + bge-small int8 79 MB; nomic int8 132 MB |

Implications: indexing a 2.2M-token session (~5.5K chunks) is ~4 minutes of background CPU with MiniLM; per-turn query embedding plus search is under 150 ms; reranking must be capped (~10 to 20 candidates) or optional.

### A.4 Literature: retrieval versus stuffing

- Lost in the Middle (Liu et al. 2023): U-shaped accuracy by answer position, holds for long-context models. https://arxiv.org/abs/2307.03172
- Chroma "Context Rot" (Jul 2025): 18 frontier models all degrade monotonically with input length at fixed task difficulty; a focused ~300-token span beat the full 113K-token history on LongMemEval; shuffled haystacks beat coherent ones. https://www.trychroma.com/research/context-rot
- NoLiMa (ICML 2025): GPT-4o 99.3% → 69.7% as context grows when needle and question share little vocabulary. https://arxiv.org/abs/2502.05167
- RULER (NVIDIA 2024): only about half of models advertising 32K+ clear 85% at 32K. https://github.com/NVIDIA/RULER
- LongMemEval (ICLR 2025): commercial assistants and long-context LLMs lose ~30% accuracy on sustained-interaction memory; session-decomposition chunking, fact-augmented keys and time-aware query expansion recover much of it. https://github.com/xiaowu0162/LongMemEval
- Counter-evidence: DeepMind "RAG or Long-Context LLMs?" (2024): long context beats RAG on quality when the corpus fits; Self-Route routes to RAG unless the model asks for full context. https://arxiv.org/abs/2407.16833 LaRA (ICML 2025): no universal winner; depends on model, length, task, retrieval quality. https://arxiv.org/abs/2502.09977
- "Fidelity Before Structure" (2026): verbatim chunks outperform lossy extracted artifacts for long-conversation memory. https://arxiv.org/pdf/2601.00821
- "Beyond RAG for Agent Memory" (2026): retrieval by decoupling and aggregation. https://arxiv.org/pdf/2602.02007

### A.5 Literature: memory architectures and production harnesses

- MemGPT/Letta: pinned core memory (~2K chars) + recall (raw history) + archival, both retrieved by model tool call, not every turn; 93.4% on DMR. https://arxiv.org/abs/2310.08560 https://docs.letta.com/guides/core-concepts/memory/archival-memory
- Mem0 (ECAI 2025): extracted memories; vs full context +26% LLM-judge, −91% p95 latency, >90% token savings on LoCoMo (vendor-reported). https://arxiv.org/abs/2504.19413
- Zep/Graphiti: temporal knowledge graph; 94.8% DMR, up to +18.5% LongMemEval (vendor-authored). https://arxiv.org/abs/2501.13956
- A-MEM (NeurIPS 2025): Zettelkasten-style linked notes; up to 6x multi-hop, −85 to −93% memory-op tokens. https://arxiv.org/pdf/2502.12110
- LangMem (2025): memory tools + consolidation on LangGraph store, pre-1.0. https://github.com/langchain-ai/langmem
- Generative Agents (2023): score = recency × importance × relevance, reference formula. https://agentpatterns.ai/agent-design/generative-agents-memory-stream/
- Recursive summarization (Wang et al. 2023) and Beyond Goldfish Memory (2022): lossy by construction. https://arxiv.org/pdf/2308.15022 https://arxiv.org/pdf/2107.07567
- Claude Code: tool-result trimming, then a structured summary near 95% capacity; CLAUDE.md and memory files re-read after compaction. https://code.claude.com/docs/en/memory https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f
- Anthropic context editing + memory tool (Sept 2025): server-side clearing after cache lookup; +29% (editing) and +39% (editing + memory), −84% tokens on a 100-turn internal benchmark. https://claude.com/blog/context-management https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Anthropic context engineering guidance. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI memory and Responses API conversation state. https://openai.com/index/memory-and-new-controls-for-chatgpt/ https://developers.openai.com/api/docs/guides/conversation-state
- Codex CLI (opaque server-side compaction blob), OpenCode (model-invoked Compress tool), Cursor (/summarize). https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/
- No mainstream harness does per-turn hybrid retrieval by default.

### A.6 Literature: per-turn retrieval design patterns

- 60% of multi-turn follow-ups carry unresolved coreference; rewrite or include recent turns in the query. https://alhena.ai/blog/query-rewriting-before-retrieval-multi-turn-rag/ CHIQ https://arxiv.org/pdf/2406.05013 HyDE https://aclanthology.org/2023.acl-long.99/
- Chunk per turn or turn pair plus an overlapping session window; keep tool_use/tool_result atomic (Anthropic requires the pair adjacent). https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- Prompt caching: Anthropic cache reads 10% of base price, writes 125%; any change invalidates everything after it, so retrieved context belongs after the stable prefix. https://platform.claude.com/docs/en/about-claude/pricing https://dev.to/gsatya147/where-to-cut-a-prompt-so-the-cache-actually-hits-41p6
- Hybrid BM25 + dense fused by reciprocal rank fusion: ~+7.4% NDCG over either alone on WANDS. https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/
- Cross-encoder reranking: +5 to +15 NDCG@10 typical, up to +20 on lexically hard sets. https://bigdataboutique.com/blog/rag-reranking-improving-retrieval-quality-with-cross-encoders

### A.7 Tooling survey (versions as of 2026-09-25)

- SQLite: `node:sqlite` (built-in, FTS5 confirmed above, `loadExtension` supported); better-sqlite3 13.0.3 (N-API, FTS5, self-published prebuilds); sql.js needs the `sql.js-fts5` fork for FTS5; sqlite-vec 0.1.9 (exact scan, native + wasm) https://github.com/asg017/sqlite-vec/releases ; sqlite-vss superseded.
- Pure-JS search: MiniSearch (real BM25, JSON persistence), FlexSearch, Orama (hybrid BM25 + vector in one package) https://github.com/oramasearch/orama
- Embeddings: @huggingface/transformers 4.3.0 (onnxruntime-node 1.30 in Node); fastembed; node-llama-cpp (GGUF embeddings); Ollama as external server (nomic-embed-text 73.8M pulls, mxbai-embed-large 11.4M, bge-m3 4.7M).
- Models (dim / params / notes): all-MiniLM-L6-v2 384 / 22M / Apache-2.0, no prefix; bge-small-en-v1.5 384 / 33M / MIT, query prefix; gte-small 384 / 33M; nomic-embed-text-v1.5 768 (Matryoshka) / 137M / 8K ctx / needs `search_query:`/`search_document:` prefixes; snowflake-arctic-embed-s/m 384/768; EmbeddingGemma-300M 768 / Gemma license / task prompts; Qwen3-Embedding-0.6B / Apache-2.0 / instruction prefix; jina-embeddings-v3/v4 non-commercial licenses (avoid).
- Vector stores: brute-force JS is sufficient at measured scale; hnswlib-node, usearch (native or wasm), LanceDB (native, real Electron load failures reported: https://github.com/continuedev/continue/issues/1232), Vectra, Orama.
- Rerankers: ms-marco-MiniLM-L-6-v2 (fastest), bge-reranker-v2-m3 (~14x slower), jina-reranker-v2 (~40 ms/pair CPU), mxbai-rerank-xsmall (DeBERTa, slow on CPU). https://www.mixedbread.com/blog/mxbai-rerank-v2
- Tokenizers: js-tiktoken / gpt-tokenizer (pure JS); @anthropic-ai/tokenizer marked beta/unstable; Anthropic recommends the count-tokens endpoint.
- Electron packaging: asarUnpack for `.node` files; onnxruntime-node Windows init failures reported (https://github.com/CherryHQ/cherry-studio/issues/20021); Cherry Studio moved ONNX work to `utilityProcess` for crash isolation (https://github.com/CherryHQ/cherry-studio/pull/19896).
- Reference apps: Cherry Studio (ONNX in utilityProcess), AnythingLLM (LanceDB), Continue.dev (transformers.js + LanceDB/sqlite-vec + keyword), Obsidian Smart Connections (WASM MiniLM, vectors as files), mem0 (vector + BM25 + entity fusion).
