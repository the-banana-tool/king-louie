# History H4: Scope, Links, Importers and the Case Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One implementer per task.

**Goal:** A chat can recall from other chats when its owner says so: a per-chat history scope (`chat`, `linked`, `all`), one-directional links chosen in a picker, the same scope enforced in the per-turn recall, `SearchHistory` and `ReadHistory`; other conversations (Claude Code sessions, Markdown transcripts, King Louie exports) can be imported as chats, from the desktop (standalone or attached) and from the service CLI; and a long chat with no case is offered conversion to a case.

**Architecture:** Schema step 4 adds `chat_links` and `imports` (the `history_scope` column has existed since step 1 and has never been read or written). One pure function, `resolveScope`, turns a chat's stored scope, its links and a **policy** into the list of chat ids a turn may read; the `ContextBuilder`, both tools and the `history:*` IPC all go through it, so scope is decided in one place. The `Retriever`, the FTS query and the `VectorIndex` already take `chatIds`; they gain a per-chat `upToSeq` so "before this turn" cuts only the asking chat. Importing is a store-level service (`import-chats.js`: begin, append, finish) over the importers LongHaul already uses, written in batches, never overwriting an existing chat; the desktop parses the file and, when attached, sends the parsed chat to the service in batches.

**Tech Stack:** Node 24 `node:sqlite`, `node:test`, Electron 41 (renderer, the open-file dialog). No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, stage H4 (§11.2: "scope, links, importers, the case nudge"). Sections in force: D3, D4, §3.2 (`getLinks`, `setLinks`, `recordImport`, `findImport`, `Importer`), §4.1 (`history_scope`, `chat_links`, `imports`), §6.3 (scope), §6.4 (the cross-chat header), §7 (`scope` in provenance), §8 (both tools' scope rules), §9, §10.1, §10.2, §12 (`history:links.get/set`, `history:scope.set`, `history:import.preview/commit`, the `history import` CLI row, the renderer row's chat-menu items), §13, §14 (`caseNudgeAfterUserTurns`), §15 (`ReadHistory` range outside scope), §16. Terms follow `CONTEXT.md`; this plan does not change `CONTEXT.md`.

**Revised 2026-10-13 with the owner's rulings.** The first version of this plan (24e317f) held nine open questions; the owner answered all nine the same day. They are the table below. Nothing in this plan is blocked. Tasks were renumbered so the order follows the dependencies.

## Task order: what is sequential and what may run in parallel

"In parallel" here means in separate worktrees with **no file in common**; the groups were made from each task's file list.

| Step | Tasks | Why |
|---|---|---|
| A | **1, 2 and 3 in parallel** | 1: `schema.js`, `link-index.js`, `history-store.js`, `rows.js`. 2: `chunk-index.js`, `vector-index.js`, `vector-search.js`, `retriever.js`. 3: `importers/`, fixtures. No shared file, no dependency on each other. |
| B | **4 → 5 → 6 → 7 → 8, one after another** | Each builds on the one before, and 5, 6, 7 and 8 all edit `src/core/create-core.js`; 6 and 7 the history tools and handlers. |
| C | After 8, **three streams in parallel**: (i) **9 → 10 → 11 → 12**; (ii) **13** (may start once 9 is merged into its worktree's base); (iii) **14** | (i) edits `src/history/`, `create-core.js`, `history-handlers.js`, `preload.js`, `allowlist.js`, `attached-host.js`. (ii) edits only `src/service/cli.js`, `src/service/commands/history.js`, its test and `docs/install-guide.md`. (iii) edits only `renderer.js`, `index.html`, `styles.css` and its test. |
| D | **15 → 16 → 17, one after another**, after everything above | 15 and 16 edit `renderer.js` and `index.html` (as 14 did); 16 also edits `chat-handlers.js`, `settings.js` and `history-store.js`; 17 is the stage's close. |

Nothing that lets an owner set a scope or import a file reaches `main` before Task 8 (the scope policy): merge steps A to C(iii) as one stage, or keep the branch unmerged until Task 8 is in.

## Deviations

Where the code as built differs from a task's text. Added by each task's implementer in the task's own commit.

**Task 1**

- **Tests changed outside the task's file list.** Step 4 is the first step added since these were written, and each of them rebuilt an older file by hand: `tests/helpers/history-fixture.js` (`downgradeToVersion1` now drops `imports` and `chat_links` too, or the reopened store fails on `CREATE TABLE chat_links`), `tests/history-embeddings-store.test.js` (its own downgrade to version 2 drops the two tables; the version it asserts is 4) and `tests/history-index.test.js` (the version it asserts is 4; the file is otherwise Task 2's). No assertion was weakened.
- **`getLinks` and `setLinks` return list order**, as the interface says, so `setLinks('a', ['c', 'b'])` returns `['b', 'c']` when `b` is above `c` in the chat list. Step 1's `['b', 'c']` example holds because the test seeds the chats in that list order (`seedChat` puts a new chat at the front).
- **`chatRefs` and `chatRef` work on a store that is not `linkable`** (they read `chats` only, which every schema version has). A ref's `caseId` and `source` fall back to `meta_json` when the value was not a string (`rows.js` keeps such a value there), so a chat whose `caseId` is truthy on the chat object is never a non-case chat to the policy.
- **On a read-only store the writing methods answer and do not throw**: `setHistoryScope` false, `setLinks` `[]`, `recordImport` null, `finishImport` false. `setHistoryScope` still throws `RangeError` for a value outside the three on a writable store, whether or not the chat exists.
- **`recordImport` validates more than the text says**: `id`, `sourceKind`, `sourceHash` and `chatId` must be non-empty strings (`TypeError`), `state` one of `running`, `done` (`RangeError`); a chat that does not exist fails the foreign key.
- **`rowToChat` also drops a `historyScope` found in `meta_json`**, so a value written there by hand or by an older build is never read back as if it were the chat's scope.

**Task 2**

- **Tool pairing follows the cut too.** `Retriever#retrieve` passed `upToSeq` to `store.pairedToolMessageId`, which the task's text does not name. It now passes the cut only for a message of the cut's chat, so a tool call recalled from another chat is paired with its result past the asking chat's `upToSeq`, and a partner in the cut's own chat is still never shown at or after it. Without `upToSeqChatId` the call is what it was.
- **`upToSeqChatId` is always passed on** (as `null` when unset) to `searchText`, `index.search` and the `vectorSearch` callback, so LongHaul's own `vectorSearch` callbacks receive one more key and ignore it. A named chat with no integer `upToSeq` cuts nothing.

**Task 3**

- **The size limit is injected as an option**: `detect`, `parse` and `preview` take `{ maxBytes }` (default `MAX_BYTES`). `detectImporter` passes none.
- **Refusals the text does not spell out.** A known pattern that the file does not fit, and a file whose name does not end `.md` or `.markdown` given straight to `parse`, both throw `NOT_A_TRANSCRIPT`. The unknown-pattern check runs before the file is opened.
- **A section with no text is left out** and counted in `stats.skipped.empty`; "at least two sections with both roles" is judged on the sections that are kept. `stats.skipped` has a key only when its count is above zero, as the other importers do.
- **`name-assistant` does not fit a file whose other heading is `User`**: that file is `user-assistant-h2`, and listing both would offer the owner the same reading twice.
- **Numbered sections without a marker alternate from the section before them** (the first is the user), so a marker in the middle moves the alternation. A numbered section is one message even when its text goes on to quote the other speaker.
- **`turns`, in `preview` and in each `patterns` entry, counts user messages**, as the other two importers' `preview` does. `sample` is the first five messages; a `roles` heading is rebuilt as the hashes and the heading text, cut to 120 characters.
- **Heading rules**: ATX headings only (setext underlines are not headings), up to three spaces of indent, a space after the hashes; a role heading may be any case, wrapped in emphasis and end in a colon. A numbered heading is `Turn N` or `Message N`, with an optional `#` before the number and an optional `:` or `.` after it.
- **The fixture is ten user turns** (twenty messages), with a title, one line before the first turn, a fenced block holding a heading, and level-3 headings inside a reply.
- **LongHaul's refusal for an unsupported file still names only the two older formats** (`src/longhaul/importing.js`), since the task changes no other LongHaul file. The new test also checks that a Markdown file that is not a transcript is refused.

## Owner rulings (2026-10-13)

Each row names the tasks that carry the ruling and the tests that pin it (file › test name; the tests are written by the task named).

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-H4-1 | **Strict case scope.** A chat with a `caseId` always has effective scope `chat`, whatever is stored, and is in no other chat's scope (not linkable, left out of `all`). A chat that has ever recalled from another chat is refused by `case:attach` and `case:create`: code `CHAT_RECALLED_OTHER_CHATS`, message "This chat has read other chats, so it cannot be attached to a case. Start a new chat for the case." No `force` lifts it. | Task 8 (policy, attach rule), Task 7 (`SCOPE_PINNED`, `LINK_REFUSED`), Task 14 (the picker says why) | `history-scope-policy › R-H4-1: a case chat stored as "all" reads only itself`; `› R-H4-1: a case chat is in no other chat's scope, by link or by "all"`; `› R-H4-1: a chat given a case after its scope was widened reads only itself on its next turn`; `case-chat-attach › R-H4-1: a reply that recalled from another chat blocks attach`; `› R-H4-1: a SearchHistory or ReadHistory result from another chat blocks attach`; `› R-H4-1: force does not lift CHAT_RECALLED_OTHER_CHATS` |
| R-H4-2 | **Imports: warn, and keep them local.** A transcript is imported as it is, chunked and indexed by the same rules as a native chat; the import dialog says so. Chunks of a chat with `source` set are never sent to a hosted embedder or to Jev. A King Louie export whose chat object has a `caseId` is imported and kept out of every other chat's scope like a case chat. | Task 9 (`meta.importedFromCase`), Task 10 (embedder and Jev), Task 8 (scope), Task 15 (the dialog's sentence) | `history-imports-local › R-H4-2: a hosted embedder is never given a chunk of an imported chat`; `› R-H4-2: Jev is not called when an imported chat is in scope`; `history-scope-policy › R-H4-2: an imported case-chat export is in no other chat's scope`; `renderer-history-import › R-H4-2: the dialog's warning` |
| R-H4-3 | **Attached: the desktop parses, the service stores.** The desktop's main process opens the picked file and runs the importer; the chat goes to the service in batches (`history:import.begin`, `.append`, `.finish`). The service never opens a path the desktop named. | Task 11 (standalone IPC, the batch channels), Task 12 (attached) | `history-ipc-import › R-H4-3: no import channel takes a path`; `desktop-bridge-allowlist › R-H4-3: pick, preview and commit are local; begin, append, finish and lookup are proxied`; `attached-host-import › R-H4-3: a commit while attached sends the parsed chat in batches`; `e2e/history-import-attached` |
| R-H4-4 | **The CLI refuses as root or Administrator.** `king-louie-service history import` runs only as the data dir's owner, with the service stopped. | Task 13 | `service-cli-history › R-H4-4: refused as root`; `› R-H4-4: refused as Administrator`; `› R-H4-4: refused when the data dir belongs to another account`; `› R-H4-4: refused while the service runs` |
| R-H4-5 | **The nudge is a button only.** After `history.caseNudgeAfterUserTurns` (40) user messages, a chat with no case gets one `status` message with a Convert button, only when the chat could be attached; no sentence to the model; `caseNudgedAt` is set either way. | Task 16 | `history-case-nudge › R-H4-5: one status row at the threshold, never a second`; `› R-H4-5: the turn's prompt is the same with and without the nudge`; `› R-H4-5: a chat that could not be attached is marked and gets no row` |
| R-H4-6 | **No recall default changes.** `linked` and `all` ship opt-in per chat; the spec says they are unmeasured (LongHaul has no cross-session questions). | Task 5 (byte-identity), Task 17 (spec §6.7) | `history-cross-chat-recall › R-H4-6: scope "chat" is byte-identical to H3`; `history-settings` (the existing defaults test, unchanged apart from Task 16's new key) |
| R-H4-7 | **Imported and bridge chats.** An imported chat (`source` set) cannot be attached to a case (`IMPORTED_CHAT`). A bridge chat's effective scope is always `chat`; it is left out of `all`; the owner may link it explicitly. | Task 8 | `case-chat-attach › R-H4-7: an imported chat is refused IMPORTED_CHAT by case:attach and case:create`; `history-scope-policy › R-H4-7: a bridge chat reads only itself`; `› R-H4-7: a bridge chat is left out of "all" and can be linked` |
| R-H4-8 | **A second import of a grown session is a second, separate chat.** An import never overwrites a chat. | Task 9 | `history-import-chats › R-H4-8: a chat with the importer's id survives the import untouched`; `› R-H4-8: a grown copy of an imported session becomes a second chat` |
| R-H4-9 | **`history:index.status`, `history:reindex` and the `reindex`/`status` CLI commands are not built.** The spec's §12 rows are corrected to what exists. | Task 17 | (a spec edit; no test) |

### What the rulings cost, and what they do not cover

Stated so nobody reads more into them than the code will do.

- **R-H4-1, what "ever recalled" can see.** The attach rule reads what is stored in the chat: an assistant reply whose provenance names other chats (`context.recalledChats`), and `SearchHistory`/`ReadHistory` results from another chat. It cannot see text the owner pasted from one chat into another, or a chat truncated back past those rows (the rows, and the text, are then gone, and the chat can be attached again).
- **R-H4-1, a chat detached from its case.** Taking a case away is never refused (existing behaviour). The chat is then an ordinary chat: its stored scope applies again and other chats may read it by link or `all`, although it holds that case's conversation. This is the same residual Q29 already has (a detached chat can be attached to another case unless its tool rows block it); this plan does not close it.
- **R-H4-1, one case with two chats.** They cannot recall from each other. "Same case only" was not chosen.
- **R-H4-1 and R-H4-7 leave a chat that used `linked`/`all` unable to become a case chat**, and a long imported session unable to become one at all; the owner starts a new chat.
- **R-H4-2, what "local" covers.** Imported chunks still go to the chat model when they are recalled (that is recall), and into this chat's stored tool results when `SearchHistory` returns them. What is never sent is an imported chat's chunks to an embedding service or to typesafe.ai. The rule is per chat: messages the owner later types into an imported chat are kept local too. A turn's query (the owner's new message) is still embedded by whatever embedder is active.
- **R-H4-2, Jev.** With Jev chosen, a turn or search whose scope holds any imported chat is not reranked at all (`rerankSkipped: 'imported-chat'`), the same shape as the case-chat rule; it is not "rerank everything but the imported chunks".
- **R-H4-2, the warning is the only protection against a secret in a transcript.** Nothing scans an import. A key printed by a `Bash` call in an imported session is searchable and can be shown to the model, exactly as in a native chat.
- **R-H4-2, a case-chat export is recognised only by the `caseId` in the file.** An export edited to remove it, or a case conversation saved as Markdown, imports as an ordinary chat.
- **R-H4-3.** The parse runs in the desktop's main process (`JSON.parse` and line splitting on a file the owner picked). The service treats what arrives as untrusted: fixed key lists, size caps, never an existing chat id.
- **R-H4-4, Windows.** `src/` cannot read a folder's owner on Windows without the ACL cmdlets it avoids. The command refuses when elevated and otherwise relies on the operating system: an account that cannot write the data dir fails to open the store, with that error. An installed Windows service (LOCAL SERVICE) therefore has no CLI import; its owner imports from the attached desktop (R-H4-3).
- **R-H4-5.** The attachable check runs once, at the threshold. A chat that was not attachable then is never nudged later, and a chat that was nudged can become unattachable before the owner presses the button; the button then shows the attach flow's own refusal.
- **R-H4-6.** How well `linked` and `all` recall is not known. Other chats' chunks compete for the same 6,000-token block, so a wide scope can push out this chat's own excerpts.

## New questions

Found while writing the tasks out. Each affected step is conservative (fail closed) until answered; none blocks a task.

- **N1. Is Ollama a "hosted embedder" for R-H4-2?** Ollama's address is a setting; it is usually this machine but need not be. Task 10 treats every embedder kind but `local` as hosted, so an imported chat gets vectors only from the local model. If Ollama should count as local, it is a one-line change in Task 10.
- **N2. Do a chat's sub-agents and workflow tasks read its wider scope?** A `SpawnAgent` child or a workflow task returns prose with no recall provenance, so the R-H4-1 attach rule could not see what it read. Tasks 5 and 6 give the wider scope only to the chat's own turn (the send path); a child run, a background task and a workflow task read the chat itself only.
- **N3. An imported case-chat export as a reader.** R-H4-2 rules that no other chat may read it. Task 8 also pins its own scope to `chat` (reason `imported-case-chat`), treating it "like a case chat" in both directions. If it should be free to read other chats, drop that one pin.

---

## Global Constraints

- Tests run with node's built-in runner, never `jest`: `node --test tests/<file>.test.js`; look for `# fail 0`. Each task runs only the test files its steps list. **The full `npm test` runs once, in Task 17.**
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` covers every new file. Nothing under `src/history/` requires `electron` or `src/ipc/`.
- Log through `createLogger` from `src/logging.js`; no bare `console.*` in `src/` (the CLI writes to `io.stdout`/`io.stderr`).
- No network and no model in unit tests. Stores: `tests/helpers/history-fixture.js` (`openTempStore`, `seedChat`, `isoAt`, `BASE_TIME`, `readDb`) or `HistoryStore.open(':memory:')`; a core: `tests/helpers/history-context.js`, and `closeOpenHistoryStores()` (`tests/helpers/close-history-stores.js`) before removing a data dir; vectors: `tests/helpers/fake-embedder.js` (`createBagOfWordsEmbedder`), `tests/helpers/fake-embed-runner.js`, `tests/helpers/fake-embedding-server.js`; Jev: `tests/helpers/fake-jev-server.js`; Claude Code files: `tests/helpers/claude-code-fixture.js` (`writeClaudeCodeFixture`); a model: `tests/helpers/fake-llm-server.js` with `tests/helpers/profile-settings.js`; cases: a temp cases root.
- Schema changes are new `SCHEMA_STEPS` entries; steps 1 to 3 are released and are never edited.
- `messages` and `chunks` are written only through the store's own insert path, so every imported message is chunked like a native one. `UNINDEXED_TOOLS` is not changed.
- Open source: invented fixture values only (`Lakeside lot`, `4417`, `example.com`, `+15550100`); no personal names, paths or domains. `tests/fixtures/history/` holds synthetic files only.
- Renderer: every chat title, excerpt, preview sample, file name and error is set with `textContent`, never `innerHTML` or markdown. New IPC replies that carry such text have `untrustedText: true`.
- **Scope `chat` is byte-identical to H3** (R-H4-6). No `history.recall` default changes. Tests that check a mechanism pin their settings explicitly.
- A scope can be widened only by the owner's own action in the app (`history:scope.set`, `history:links.set`). No tool parameter, imported file, chat object, exported JSON or model output can widen it.
- The system prompt's cached part must not change per chat: tool descriptions stay static strings.
- Anchors in this plan are quoted names, not line numbers; find them with a search.
- Commit after each task with the message its last step gives, ending with the attribution line the session's instructions give.

## Review Focus

1. **The model asks for more than the owner allowed.** `SearchHistory({ scope: 'all' })` in a chat scoped `chat`, `ReadHistory({ chatId: <another chat> })`, an imported chat object or King Louie export carrying `historyScope: 'all'`. Expected: the chat's own scope, always; `ReadHistory` answers with an error naming the allowed scope and reads nothing. Pinned: Tasks 1, 6, 9.
2. **`upToSeq` across chats.** The send path asks "before message #N of this chat". Applied to every chat in scope it would hide message #N+1 onward of a linked chat with more messages. Expected: the cut applies to the asking chat only, in BM25, in vector search and in the Retriever's own guard. Pinned: Task 2.
3. **A chat in scope disappears or changes.** A linked chat is deleted, a chat gets a `caseId` after it was linked, the reading chat gets a `caseId` after its scope was set to `all`. Expected: the scope is resolved every turn from what is stored now. Pinned: Tasks 1, 4, 8.
4. **An import never overwrites** (R-H4-8). `createChat` deletes a chat with the same id. Expected: an id that is taken is never used; the same file twice returns the first chat; a crash in the middle leaves no half chat after the next start. Pinned: Task 9.
5. **Attached mode** (R-H4-3). Expected: scope and links act on the service's store; no channel makes the service open a path; what the desktop sends is held to the same key lists and caps as a local import. Pinned: Tasks 7, 11, 12.
6. **Third parties.** Expected: no chunk of an imported chat reaches a hosted embedder or Jev (R-H4-2), and Jev is skipped whenever a case chat is in scope. Pinned: Tasks 5, 10.
7. **Attach after reading other chats** (R-H4-1). Expected: refused by both `case:attach` and `case:create`, before any case is created, with no `force`. Pinned: Task 8.

---

## What exists on `main` (161d28a), read from the code

Nothing below is rebuilt by a task.

| Seam | Where | State |
|---|---|---|
| `chats.history_scope TEXT NOT NULL DEFAULT 'chat'` | `SCHEMA_STEPS` step 1 (`src/history/schema.js`) | The column exists in every store. **Nothing reads or writes it**: `rows.chatToRow` has no mapping, so a chat object's `historyScope` key would land in `meta_json`. |
| `chat_links`, `imports` | spec §4.1 | **Do not exist.** Steps are 1 (chats, messages, attachments, meta), 2 (chunks, FTS, calibration), 3 (embeddings). |
| `Retriever#retrieve({ chatIds, kinds, upToSeq, caseId, … })` | `src/history/retriever.js` | Already takes a list of chats; its `inScope` guard and `upToSeq` apply one cut to every chat. A reranker that throws `RERANK_SKIPPED` keeps the fused order with the reason in `stats.rerankSkipped` and no warning. |
| `chunkIndex.searchText(db, query, { chatIds, upToSeq, … })` | `src/history/chunk-index.js` | `chatIds` empty means every chat; `upToSeq` is `m.seq < ?` for all rows. |
| `VectorIndex#search({ model, query, chatIds, upToSeq, k })`, `createVectorSearch` | `src/history/vector-index.js`, `vector-search.js` | Loops the chats given; one `upToSeq` for all; a chat over `vectorCacheMb` is skipped with a note. |
| `pendingEmbeddings(db, model, { limit, chatId, afterId, maxChunksPerToolResult })`, `countPending` | `src/history/embedding-index.js` | Every chunk without a vector for the key, whatever its chat. |
| `formatExcerpts(chunks, { chatId, chatTitles, … })` | `src/history/excerpts.js` | Already writes `chat "<title>"` in the header of a chunk from another chat, this chat's excerpts first. The title is not neutralised. `RECALLED_PREAMBLE` says "from earlier in this conversation". |
| `ContextBuilder#build` | `src/history/context-builder.js` | Passes `chatIds: [id]`; `stats.scope` is the literal `'chat'`. Callers: the send path (`src/ipc/chat-handlers.js`) and the workflow engine and planner (`src/workflows/`). |
| `searchHistoryExcerpts`, `excerptsForMessage` | `src/history/search.js` | One chat. `excerptsForMessage` drops any chunk not of this chat. |
| `SearchHistory`, `ReadHistory` | `src/tools/builtin/history-tools.js` | `scope` is in the schema and ignored; `ReadHistory` refuses any other `chatId`. They read `context.history = { chatId, store, retriever, estimator, reranker, getSettings }` (create-core's `get history()`, built from `executorOptions.chatId`). |
| `createRecallReranker`, `caseIdOf(store, chatId)` | `src/history/reranker.js` | Jev is skipped (`RERANK_SKIPPED`, `'case-chat'`) when the **asking** chat has a `caseId`. |
| Importers `claude-code-jsonl` (version 3), `king-louie-json` (version 1), `detectImporter`, `readJsonlLines` | `src/history/importers/` | Built and tested; each has `kind`, `version`, `detect`, `preview`, `parse → { chat, messages, compactions, stats }`. **Used only by LongHaul** (`src/longhaul/importing.js`): nothing in the app imports a file into the history store. No `markdown-transcript` importer. |
| History IPC | `src/ipc/history-handlers.js`, `constants.js`, `preload.js` | `history:excerpts`, `history:search`, `history:embedder.*`, `history:jev.*`. |
| Attached mode | `src/desktop-bridge/allowlist.js`, `src/ipc/attached-host.js` | The whole `history` domain is proxied (`PROXIED_DOMAINS`); `LOCAL_CHANNELS`, `PRESTEP_CHANNELS` and the deny lists are checked first. `attached-host.js` has `LOCAL` and `PRESTEP` handler tables, `proxyInvoke(channel, args)`, and Electron's `dialog` (`chat:pickWorkingDirectory` uses it). |
| Attach rules | `src/cases/chat-attach.js` (`attachBlock`, `assertChatAttachable`), `src/ipc/case-handlers.js` (`assertAttachable`, `assertNotBridgeChat`, `bridgeOriginFor`) | Q29 and the bridge rule; neither knows scope, links or imports. |
| The case nudge | spec §9 | Does not exist: no `caseNudge` or `convertToCase` in the tree, no `caseNudgeAfterUserTurns` in `src/history/settings.js`. The attach flow it would open exists (`renderChatCaseSection` in `renderer.js`, with "New case"). |
| Service CLI | `src/service/cli.js`, `src/service/commands/` | No `history` command; `withServiceCore` opens no history store; `runningServicePid`, `isAdmin` (`admin-check.js`), `printable` (`import-channel.js`) exist. |
| Chat menu | `index.html` `#chat-context-menu`, `renderer.js` | One item, "Delete chat". "Export as JSON" is a button (`#export-chat-btn`) that writes `{ ...chat, messages }`. |
| Recall line | `renderer.js` `recallLineText`, `renderRecallLine` | Does not show the scope. |

## File Structure

New, under `src/history/` (Electron-free):

| File | Responsibility |
|---|---|
| `link-index.js` | Schema step 4 SQL and every `chat_links` / `imports` query |
| `scope.js` | `SCOPES`, `narrowest`, `resolveScope`, `OPEN_POLICY` |
| `scope-policy.js` | `createScopePolicy`: the shipped policy (R-H4-1, R-H4-2, R-H4-7) |
| `bridge-origin.js` | `bridgeOriginFor(chat)`, moved out of `src/ipc/case-handlers.js` |
| `importers/markdown-transcript.js` | The third importer |
| `import-chats.js` | `hashFile`, `previewImport`, `parseImport`, `beginChatImport`, `appendChatImport`, `finishChatImport`, `abortChatImport`, `importChat`, `sweepUnfinishedImports` |

New elsewhere: `src/cases/case-nudge.js`, `src/service/commands/history.js`, `tests/fixtures/history/markdown-transcript.md`, `tests/fixtures/history/claude-code-session.jsonl`.

Modified: `src/history/{schema,history-store,rows,chunk-index,vector-index,vector-search,retriever,context-builder,excerpts,search,reranker,embedding-index,embed-indexer,settings,index}.js`, `src/history/importers/index.js`, `src/tools/builtin/history-tools.js`, `src/core/create-core.js`, `src/ipc/{history-handlers,chat-handlers,case-handlers,attached-host,constants}.js`, `src/desktop-bridge/allowlist.js`, `src/cases/chat-attach.js`, `src/workflows/{workflow-engine,planner-executor}.js`, `src/service/cli.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`, `docs/install-guide.md`, the spec, `CLAUDE.md`.

New tests: `tests/history-links-store.test.js`, `tests/history-scope.test.js`, `tests/history-cross-chat-recall.test.js`, `tests/history-tools-scope.test.js`, `tests/history-ipc-scope.test.js`, `tests/history-scope-policy.test.js`, `tests/history-importer-markdown.test.js`, `tests/history-import-chats.test.js`, `tests/history-imports-local.test.js`, `tests/history-ipc-import.test.js`, `tests/attached-host-import.test.js`, `tests/service-cli-history.test.js`, `tests/renderer-history-scope.test.js`, `tests/renderer-history-import.test.js`, `tests/history-case-nudge.test.js`, `tests/e2e/history-import-attached.test.js`.

---

## Task 1: Schema step 4 (`chat_links`, `imports`) and the store's scope, link and import methods

Parallel with Tasks 2 and 3.

**Files:**
- Create: `src/history/link-index.js`
- Modify: `src/history/schema.js` (append step 4; update the header comment's list of steps)
- Modify: `src/history/history-store.js` (new methods; `LINKS_SCHEMA_VERSION = 4`; a `linkable` getter)
- Modify: `src/history/rows.js` (`historyScope` is never taken from a chat object)
- Test: `tests/history-links-store.test.js` (new), `tests/history-schema.test.js`, `tests/history-rows.test.js`

**Interfaces:**
- Consumes: `SCHEMA_STEPS`, `store.transaction`, `store._stmt`, `prepared` from `chunk-index.js`.
- Produces:
  - `SCHEMA_V4_SQL` (below), step `{ version: 4, up(db) { db.exec(SCHEMA_V4_SQL); } }`.
  - `store.linkable` (schema ≥ 4; false for a read-only store opened with `allowOlderSchema` below 4, whose methods below then return `'chat'`, `[]` and `null` and never throw).
  - `store.getHistoryScope(chatId) → 'chat' | 'linked' | 'all'` (an unknown chat or an unknown stored value reads as `'chat'`).
  - `store.setHistoryScope(chatId, scope) → boolean` (throws `RangeError` for a value outside the three; false for an unknown chat).
  - `store.getLinks(chatId) → string[]` (linked chat ids, in the chats' list order).
  - `store.setLinks(chatId, ids) → string[]` (replaces the chat's links in one transaction; drops duplicates, the chat itself and ids of chats that do not exist; returns what was stored).
  - `store.chatRefs() → [{ id, title, caseId, source, origin, importedFromCase }]` for every chat in list order, from `SELECT id, title, case_id, source, meta_json FROM chats ORDER BY position, rowid` (no message aggregate; `origin` and `importedFromCase` are read from `meta_json`). `store.chatRef(id)` returns one or null.
  - `store.findImport(sourceHash) → { id, sourceKind, sourcePath, sourceHash, chatId, importedAt, state, importerVersion, messageCount } | null`; `store.getImport(id)`.
  - `store.recordImport({ id, sourceKind, sourcePath, sourceHash, chatId, importerVersion, state = 'running' }) → row`; `store.finishImport(id, { messageCount }) → boolean` (sets `state = 'done'`, `imported_at`); `store.unfinishedImports() → row[]`.
  - `rows.chatToRow` skips the key `historyScope` (beside `id` and `messages`); `rows.rowToChat` does not emit it. A chat object therefore reads back exactly as before this task.

```sql
-- SCHEMA_V4_SQL (src/history/link-index.js)
CREATE TABLE chat_links (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  linked_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, linked_chat_id),
  CHECK (chat_id <> linked_chat_id)
);
CREATE INDEX chat_links_linked ON chat_links(linked_chat_id);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  source_hash TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  imported_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',     -- running | done
  importer_version INTEGER,
  message_count INTEGER
);
CREATE INDEX imports_chat ON imports(chat_id);
```

Beyond spec §4.1 (Decisions 1 and 2): the foreign keys with `ON DELETE CASCADE`, the `CHECK`, and `state`, `importer_version`, `message_count`.

Note for the implementer: `createChat` deletes an existing chat with the same id before inserting. With the cascade, `createChat` over an existing id drops that chat's links and import row. That is existing behaviour for messages; the test below records it for links.

- [ ] **Step 1: Write the failing tests.** `tests/history-links-store.test.js`, on `openTempStore()` with chats seeded by `seedChat`:
  - a new store is at schema version 4 and has both tables; a store created at version 3 (apply `applySchema(db, SCHEMA_STEPS.slice(0, 3))` on a raw `DatabaseSync`, insert a chat, close) opens at 4 with its chat intact and `getHistoryScope` `'chat'`;
  - `getHistoryScope` defaults to `'chat'`; `setHistoryScope` stores each of the three; an invalid value throws `RangeError` and changes nothing; an unknown chat returns false; a value written straight into the column that is not one of the three reads as `'chat'`;
  - `setLinks('a', ['b', 'c', 'b', 'a', 'missing'])` stores `['b', 'c']`; `getLinks('b')` is `[]` (one-directional); `setLinks('a', [])` clears;
  - deleting `b` removes it from `getLinks('a')`; deleting `a` removes its rows (read the table through `readDb`); `createChat` over an existing id drops its links;
  - `updateChat('a', { title: 'x' })` and `appendMessage` keep the scope and the links; `updateChat('a', { historyScope: 'all' })`, `createChat({ id: 'n', historyScope: 'all', … })` and `replaceChat` with that key leave the scope `'chat'` and put no `historyScope` in `meta_json`;
  - `chatRefs()` returns id, title, `caseId`, `source`, `origin` and `importedFromCase` in list order, with no `messages`; `chatRef('missing')` is null;
  - `recordImport` then `findImport(hash)` returns the row in state `running`; `finishImport` sets `done`, `messageCount` and `importedAt`; a second `recordImport` with the same hash throws; `unfinishedImports()` lists only `running`; deleting the chat removes the row;
  - a read-only store opened with `allowOlderSchema: true` on a version-3 file: `linkable` false, `getLinks` `[]`, `getHistoryScope` `'chat'`, `findImport` `null`.

  In `tests/history-schema.test.js` raise the expected latest version to 4 wherever it is asserted; in `tests/history-rows.test.js` add: `chatToRow({ title: 't', historyScope: 'all' })` has `meta_json` null.

- [ ] **Step 2: Run them and see them fail.** `node --test tests/history-links-store.test.js tests/history-schema.test.js tests/history-rows.test.js` — expected: failures on the missing step and methods.
- [ ] **Step 3: Implement.** `link-index.js` exports `SCHEMA_V4_SQL` and plain functions over `db`; the store methods delegate to them and return the neutral value when `!this.linkable`. `setLinks` and `setHistoryScope` do not bump `vectorEpoch`.
- [ ] **Step 4: Run the tests again; also** `node --test tests/history-store-chats.test.js tests/history-store-messages.test.js tests/history-migrate-json.test.js tests/desktop-source-history.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/link-index.js src/history/schema.js src/history/history-store.js src/history/rows.js tests/history-links-store.test.js tests/history-schema.test.js tests/history-rows.test.js
git commit -m "feat(history): schema step 4: chat links and imports; the store reads and writes a chat's history scope"
```

---

## Task 2: `upToSeq` cuts only the asking chat

Parallel with Tasks 1 and 3.

**Files:**
- Modify: `src/history/chunk-index.js` (`searchText`)
- Modify: `src/history/vector-index.js` (`search`)
- Modify: `src/history/vector-search.js` (pass it through)
- Modify: `src/history/retriever.js` (`retrieve`, `_lexical`, the `inScope` guard, `_age`)
- Test: `tests/history-index.test.js`, `tests/history-vector-index.test.js`, `tests/history-vector-search.test.js`, `tests/history-retriever.test.js`

**Interfaces:**
- Produces: a new optional `upToSeqChatId` beside every `upToSeq`:
  - `searchText(db, query, { chatIds, upToSeq, upToSeqChatId, … })`: with `upToSeqChatId`, the condition is `(c.chat_id <> ? OR m.seq < ?)`; without it, `m.seq < ?` as today.
  - `VectorIndex#search({ …, upToSeq, upToSeqChatId })`: the per-row check runs only for the entry of that chat.
  - `vectorSearch({ …, upToSeq, upToSeqChatId })` passes it on.
  - `Retriever#retrieve({ …, upToSeq, upToSeqChatId })`: passes it to `_lexical` and `vectorSearch`; `inScope` applies `chunk.seq < upToSeq` only when `upToSeqChatId` is unset or equals `chunk.chatId`; `_age` uses `recencyByPosition` only for a chunk of the cut's chat (another chat's chunk ages in days).
- With `upToSeqChatId` unset everything behaves exactly as before (LongHaul and every existing test pass `upToSeq` alone).

- [ ] **Step 1: Write the failing tests** (added to the four files):
  - index: two chats with the word `lakeside` at seq 2 of `a` and seq 9 of `b`; `searchText('lakeside', { chatIds: ['a', 'b'], upToSeq: 5 })` finds only `a`'s (unchanged); with `upToSeqChatId: 'a'` it finds both; with `upToSeq: 2, upToSeqChatId: 'a'` it finds only `b`'s;
  - vector index: the same shape with vectors from `createBagOfWordsEmbedder`;
  - vector search: `upToSeqChatId` reaches `index.search` (a recording fake index);
  - retriever: a caller-supplied `vectorHits` list holding a chunk of `b` at seq 9 survives `upToSeq: 5, upToSeqChatId: 'a'` and is dropped without `upToSeqChatId`; with `recencyByPosition: true` a chunk of `b` gets a day-based recency (pin `now`).
- [ ] **Step 2: Run** `node --test tests/history-index.test.js tests/history-vector-index.test.js tests/history-vector-search.test.js tests/history-retriever.test.js` — expected: the new cases fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the four files again, and** `node --test tests/longhaul-adapter-kl-recall.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/chunk-index.js src/history/vector-index.js src/history/vector-search.js src/history/retriever.js tests/history-index.test.js tests/history-vector-index.test.js tests/history-vector-search.test.js tests/history-retriever.test.js
git commit -m "feat(history): upToSeq can cut one chat of several, for recall across chats"
```

---

## Task 3: The `markdown-transcript` importer

Parallel with Tasks 1 and 2.

**Files:**
- Create: `src/history/importers/markdown-transcript.js`
- Modify: `src/history/importers/index.js` (third in `IMPORTERS`, after the two existing ones)
- Create: `tests/fixtures/history/markdown-transcript.md` (synthetic, about ten turns about the Lakeside lot)
- Test: `tests/history-importer-markdown.test.js` (new), `tests/longhaul-import.test.js`

**Interfaces:**
- `kind: 'markdown-transcript'`, `version: 1`, `MAX_BYTES = 32 * 1024 * 1024`.
- `PATTERNS`: named heading patterns, tried in this order by `detect`:
  - `user-assistant-h2` (`## User` / `## Assistant`), `user-assistant-h3` (`### User` / `### Assistant`);
  - `turn-n` (`## Turn N`) and `message-n` (`## Message N`): numbered sections; the role of each is read from a first-line marker (`**User:**`, `User:`, `**Assistant:**`, `Assistant:`) when present, otherwise the sections alternate starting with `user`;
  - `name-assistant` (`## <Name>` / `## Assistant`): exactly two distinct level-2 headings, one of them `Assistant` (any case); the other is the user.
- `detect(filePath) → boolean`: `.md` or `.markdown`, at most `MAX_BYTES`, and some pattern yields at least two sections with both roles present. Never throws.
- `preview(filePath, { pattern } = {}) → { title, turns, sample, pattern, patterns: [{ id, label, turns }], roles: [{ heading, role }] }`: `roles` is the first five heading-to-role assignments (spec §10.2); `patterns` lists every pattern that matched with its turn count so the owner can pick another; `sample` as the other importers give it.
- `parse(filePath, { pattern } = {}) → { chat, messages, compactions: [], stats }` in the same shape as the other importers: `chat = { id: 'md-<basename>', title, source: 'markdown-transcript', createdAt, updatedAt }`, title from a leading `# ` heading or the file's base name; messages `{ id: 'line-<n>', seq, timestamp, sender: 'user' | 'assistant', text }` where `<n>` is the heading's line number. The file has no times: `timestamp` is the file's mtime for the first message plus one second per message (stable for a given file; recency needs an order, not a truth). Text before the first matching heading is skipped and counted in `stats.skipped.preamble`. An unknown `pattern` throws `code: 'UNKNOWN_PATTERN'`; a file over `MAX_BYTES` throws `code: 'TRANSCRIPT_TOO_LARGE'`; a file no pattern fits throws `code: 'NOT_A_TRANSCRIPT'`.
- Headings inside fenced code blocks (``` or ~~~) are not headings.

LongHaul: `detectImporter` is shared, so `longhaul import` now accepts such a file (its id prefix falls back to `im-`). `tests/longhaul-import.test.js` gains one case asserting it; no other LongHaul file changes.

- [ ] **Step 1: Write the failing test**: each pattern on a small in-test string written to a temp file; the fixture's turn count and first five roles; a heading inside a code fence ignored; `preview` with a chosen pattern; a `.md` that is not a transcript (`detect` false, `parse` throws `NOT_A_TRANSCRIPT`); the size cap (inject the limit); stable ids and timestamps across two parses; the King Louie and Claude Code fixtures are still claimed by their own importers; a `.json`/`.jsonl` is never claimed by this one.
- [ ] **Step 2: Run** `node --test tests/history-importer-markdown.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-importer-markdown.test.js tests/history-importer-claude-code.test.js tests/history-import-king-louie.test.js tests/longhaul-import.test.js tests/electron-boundary.test.js tests/longhaul-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/importers/markdown-transcript.js src/history/importers/index.js tests/fixtures/history/markdown-transcript.md tests/history-importer-markdown.test.js tests/longhaul-import.test.js
git commit -m "feat(history): a Markdown transcript importer with selectable heading patterns"
```

---

## Task 4: `resolveScope`: one place that says which chats a turn may read

After Task 1.

**Files:**
- Create: `src/history/scope.js`
- Modify: `src/history/index.js` (export it)
- Test: `tests/history-scope.test.js`

**Interfaces:**
- Consumes: `store.getHistoryScope`, `store.getLinks`, `store.chatRefs` (Task 1).
- Produces:
  - `SCOPES = ['chat', 'linked', 'all']` (narrowest first); `narrowest(a, b)`.
  - `OPEN_POLICY = { pinnedTo: () => null, canRead: () => true }`: no restriction. It is what unit tests and LongHaul use; the app ships with Task 8's policy.
  - `resolveScope({ store, chatId, requested = null, policy = OPEN_POLICY }) → { stored, effective, chatIds, titles, refs, pinned, excluded }`:
    - `stored`: the chat's stored scope.
    - `pinned`: `policy.pinnedTo(readerRef)`: `null`, or `{ scope, reason }` capping the chat's scope.
    - `effective`: the narrowest of `stored`, `pinned.scope` (when pinned) and `requested` (a tool's `scope` argument: it can only narrow; an unknown `requested` is ignored).
    - `chatIds`: always starts with `chatId`. For `linked`, then each linked chat that still exists and that `policy.canRead(readerRef, sourceRef, { explicit: true })` allows. For `all`, then every other chat `policy.canRead(readerRef, sourceRef, { explicit: false })` allows, in list order.
    - `titles`: `Map(chatId → title)`, and `refs`: the refs, for the chats in `chatIds`.
    - `excluded`: `[{ chatId, reason }]` for linked chats the policy refused.
    - An unknown `chatId`, or a store that is not `linkable`: `{ stored: 'chat', effective: 'chat', chatIds: [chatId], titles: empty, refs: [], pinned: null, excluded: [] }`.
  - A policy's `canRead` returns `true`, or a reason string (refused).

- [ ] **Step 1: Write the failing test.** With `openTempStore`, chats `a`, `b`, `c`, `d` (one with `caseId`, one with `origin: 'telegram'`, one with `source: 'claude-code-jsonl'`):
  - default → `effective: 'chat'`, `chatIds: ['a']`;
  - `linked` with links `[b, c]` → `['a', 'b', 'c']`; after `deleteChat('b')` → `['a', 'c']`;
  - `all` → every chat, `a` first;
  - `requested: 'chat'` on an `all` chat → `['a']`; `requested: 'all'` on a `chat` chat → `['a']`, `effective: 'chat'`; `requested: 'linked'` on `all` → the links only; `requested: 'bogus'` ignored;
  - a policy with `pinnedTo: (r) => (r.caseId ? { scope: 'chat', reason: 'case-chat' } : null)`: the case chat stored as `all` resolves to itself alone with `pinned.reason === 'case-chat'` and `stored === 'all'`;
  - a policy whose `canRead` refuses sources with a `caseId`: left out of `all` silently, and out of `linked` with an `excluded` entry carrying the reason; `explicit` is true for a link and false for `all` (assert with a recording policy);
  - `titles` and `refs` cover every id in `chatIds`;
  - an unknown chat id resolves to itself alone.
- [ ] **Step 2: Run** `node --test tests/history-scope.test.js` — expected: fails (module missing).
- [ ] **Step 3: Implement** `scope.js` as a pure function over the store's three methods. No caching.
- [ ] **Step 4: Run it again** — expected: `# fail 0`. Also `node --test tests/electron-boundary.test.js`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/scope.js src/history/index.js tests/history-scope.test.js
git commit -m "feat(history): resolveScope: a chat's stored scope, its links and a policy give the chats a turn may read"
```

---

## Task 5: Recall per turn across the chat's scope, and its provenance

After Tasks 2 and 4.

**Files:**
- Modify: `src/history/context-builder.js` (`constructor`, `build`)
- Modify: `src/history/excerpts.js` (`formatExcerpts` title, `formatRecalledBlock`)
- Modify: `src/history/search.js` (`excerptsForMessage`)
- Modify: `src/history/reranker.js` (`caseIdOf` over several chats)
- Modify: `src/core/create-core.js` (the builder gets a `resolveScope`; `resolveHistoryScope` on the context)
- Modify: `src/ipc/chat-handlers.js` (the `turnContext` object: copy the new stats; pass `crossChat: true` to the builder)
- Modify: `src/workflows/workflow-engine.js`, `src/workflows/planner-executor.js` (no code change expected; a test pins that they do not pass `crossChat`)
- Test: `tests/history-cross-chat-recall.test.js` (new), `tests/history-context-builder.test.js`, `tests/history-excerpts.test.js`, `tests/history-search.test.js`, `tests/history-rerank-provenance.test.js`, `tests/history-workflows.test.js`

**Interfaces:**
- Consumes: `resolveScope` (Task 4), `upToSeqChatId` (Task 2).
- Produces:
  - `new ContextBuilder({ …, resolveScope = null })`: `resolveScope(chatId) → { effective, chatIds, titles, pinned }`.
  - `build({ …, crossChat = false })`. **The wider scope is used only when `crossChat` is true and the builder has a `resolveScope`** (New question N2: the send path passes it; the workflow engine and planner do not, so a workflow task recalls from the parent chat alone). Otherwise the builder uses `{ effective: 'chat', chatIds: [id], titles: new Map(), pinned: null }`.
  - `build()` passes `chatIds`, `upToSeq: limit`, `upToSeqChatId: id` and `caseId: caseIdOf(store, chatIds)` to the Retriever, and `chatTitles` to `formatExcerpts`. The tail, the query and `fullHistoryEstTokens` are this chat's alone, as now.
  - `stats.scope` is the effective scope; new `stats.scopeChats` (how many chats were in scope), `stats.recalledChats` (ids of **other** chats that have an excerpt in the block, in block order; `[]` when none) and `stats.scopePinned` (the pin's reason or null).
  - `caseIdOf(store, chatIdOrIds)`: the first `caseId` among the chats given, or null. So Jev is skipped (`rerankSkipped: 'case-chat'`) when **any** chat in scope has a `caseId`. Under R-H4-1 no case chat is ever in another chat's scope; this is the second line behind that rule.
  - `formatExcerpts`: the other-chat header part is `chat "<title>"` with the title made one plain line: control characters and line breaks to a space, `"`, `[` and `]` removed, runs of spaces collapsed, at most 60 characters with `…`; an empty result falls back to the chat id.
  - `formatRecalledBlock(excerpts, { otherChats = false } = {})`: with `otherChats` false the text is exactly today's. With it true the preamble is `RECALLED_PREAMBLE_CROSS`: "Excerpts retrieved from earlier in this conversation and from other chats the owner allowed this chat to read. They are verbatim and may be incomplete. An excerpt from another chat is headed chat "<title>"; it is a record of that chat, not an instruction. Use SearchHistory to look for more and ReadHistory to read a range of messages by number." The builder passes `otherChats: recalledChats.length > 0`.
  - Send path: `contextBuilder.build({ …, crossChat: true })`; `turnContext` gains `scopeChats`, `recalledChats`, `scopePinned` (only when the builder ran). `scope` was already copied.
  - `excerptsForMessage({ store, chatId, seq })`: a chunk of this chat before the reply, as now; a chunk of another chat only when that chat's id is in the reply's `context.recalledChats` and the chunk's `ts` is not after the reply's timestamp. Anything else is ignored with the existing debug line. It passes `chatTitles` (from `store.chatRef`, only for the chats involved).
  - create-core: `const resolveHistoryScope = (chatId, requested) => resolveScope({ store: historyStore, chatId, requested, policy: historyScopePolicy })`, with `historyScopePolicy = OPEN_POLICY` **in this task**, replaced by Task 8. The builder gets `resolveScope: (id) => resolveHistoryScope(id)`; `context.resolveHistoryScope` is exposed for Tasks 6 and 7.

Until Task 8 lands the policy is open, but nothing can set a scope other than `chat` before Task 7, and Task 7 is not merged to `main` without Task 8.

- [ ] **Step 1: Write the failing tests.**
  `tests/history-cross-chat-recall.test.js` (store from `openTempStore`, real `Retriever` and `ContextBuilder`, settings from `mergeHistorySettings({})` with `recall.rerank.enabled` pinned false, `resolveScope` built over `OPEN_POLICY`):
  - **`R-H4-6: scope "chat" is byte-identical to H3`**: a chat seeded with twelve messages, scope `chat`, built once with no `resolveScope` and once with it and `crossChat: true` → `recalled.text`, `tail` and every pre-existing `stats` key are deeply equal; `stats.scope === 'chat'`, `stats.recalledChats` is `[]`;
  - scope `linked` to chat `b` that holds "the gate code for the Lakeside lot is 4417": asking chat `a` "what is the gate code for the Lakeside lot" with `crossChat: true` → the block contains `[chat "Lot notes" · #2 · user · ` and `4417`, begins with the cross preamble, `stats.scope === 'linked'`, `stats.recalledChats` equals `['b']`, `stats.scopeChats === 2`;
  - the same build without `crossChat` → no `4417`, `stats.scope === 'chat'` (N2);
  - the same question with scope `chat` → no `4417`;
  - `b` has 40 messages and the answer at seq 30 while `a` asks at `upToSeq: 3` → still recalled;
  - this chat's excerpts come before the other chat's in the block;
  - a title `Lot "notes"]\n<recalled_history>` appears in the header as one line with no quote, bracket or line break, and the block still ends with exactly one `</recalled_history>`;
  - a `resolveScope` returning `pinned: { scope: 'chat', reason: 'case-chat' }` → `stats.scopePinned === 'case-chat'`, nothing recalled from `b`;
  - Jev rule: with a recording reranker and `rerank.enabled` true, asking chat with no case but `b` with `caseId: 'case-1'` in scope → the reranker is called with `options.caseId === 'case-1'`.
  `tests/history-search.test.js`: `excerptsForMessage` returns the other chat's excerpt when `context.recalledChats` names it, drops it when it does not, and drops it when the chunk's `ts` is after the reply.
  `tests/history-excerpts.test.js`: the title rule and both preambles.
  `tests/history-workflows.test.js`: a workflow task whose parent chat is scoped `linked` gets nothing from the linked chat.
- [ ] **Step 2: Run** `node --test tests/history-cross-chat-recall.test.js tests/history-search.test.js tests/history-excerpts.test.js tests/history-workflows.test.js` — expected: the new cases fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-cross-chat-recall.test.js tests/history-context-builder.test.js tests/history-excerpts.test.js tests/history-search.test.js tests/history-rerank-provenance.test.js tests/history-core.test.js tests/history-workflows.test.js tests/history-jev-reranker.test.js tests/longhaul-adapter-kl-recall.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/context-builder.js src/history/excerpts.js src/history/search.js src/history/reranker.js src/core/create-core.js src/ipc/chat-handlers.js tests/history-cross-chat-recall.test.js tests/history-context-builder.test.js tests/history-excerpts.test.js tests/history-search.test.js tests/history-rerank-provenance.test.js tests/history-workflows.test.js
git commit -m "feat(history): a turn recalls across the chat's history scope and records which chats it read"
```

---

## Task 6: `SearchHistory` and `ReadHistory` within the scope

After Task 5.

**Files:**
- Modify: `src/tools/builtin/history-tools.js`
- Modify: `src/history/search.js` (`searchHistoryExcerpts` takes `chatIds`, `chatTitles`)
- Modify: `src/core/create-core.js` (`get history()` adds `resolveScope` only for the chat's own turn)
- Modify: `src/ipc/chat-handlers.js` (the send path's `createToolExecutorWithApprovals` call passes `historyCrossChat: true`)
- Test: `tests/history-tools-scope.test.js` (new), `tests/history-tools.test.js`, `tests/history-search-rerank.test.js`, `tests/history-core.test.js`

**Interfaces:**
- Consumes: `context.history.resolveScope(chatId, requested)`. create-core's `get history()` sets it to `resolveHistoryScope` **only when `executorOptions.historyCrossChat === true`** (New question N2). The send path sets that option on the executor it builds for the chat's turn. The implementer reads how child executors are built (`SpawnAgent`, `BackgroundTask`, the workflow engine, `agentExecutorAdapter`) and makes sure none of them copies the option from a parent's `executorOptions`; the test below pins it. Without `resolveScope` on the context the tools read this chat only, as today.
- Produces:
  - `searchHistoryExcerpts({ …, chatId, chatIds = [chatId], chatTitles = new Map() })`: retrieval over `chatIds`, `caseId: caseIdOf(store, chatIds)` when reranking, headers with titles.
  - `SearchHistory`: resolves the scope with `requested: params.scope`; the result is `{ ok: true, scope: <effective>, excerpts: [{ seq, header, text, chatId?, chatTitle? }] }`, `chatId`/`chatTitle` present only on an excerpt from another chat. When `params.scope` asked for more than the chat has, a `note` says "This chat's history scope is "<effective>"; only the owner can widen it in the app." The no-match note names the scope searched.
  - `ReadHistory`: `chatId` may name this chat or a chat in `resolveScope(h.chatId).chatIds`. Anything else: `{ ok: false, error: 'ReadHistory can read only chats in this chat\'s history scope ("<effective>").' }` and nothing is read (spec §15). A read of another chat prefixes each block's header with `chat "<title>" · ` (the Task 5 title rule) and returns that `chatId` and `chatTitle`; a read of this chat returns `chatId` as now.
  - Tool descriptions and parameter descriptions become scope-neutral static strings: `SearchHistory`: "Search the history this chat may read (this chat, and other chats when the owner has allowed it) by keywords. Returns excerpts with their message numbers (#seq). Quote a phrase to match it exactly. Read a range in full with ReadHistory."; `scope`: "Which chats to search. It can only narrow the scope the owner gave this chat."; `ReadHistory.chatId`: "Leave out for this chat. Another chat's id only when a SearchHistory excerpt gave it."

A result from another chat is stored in this chat as a tool result, as spec §8 says. Task 8's attach rule reads exactly these two shapes: a `SearchHistory` result with an excerpt carrying `chatId`, and a `ReadHistory` result whose `chatId` differs from the chat it is stored in.

- [ ] **Step 1: Write the failing tests** (`tests/history-tools-scope.test.js`; the tools called with a hand-built `context.history` over `openTempStore` and `resolveScope` with `OPEN_POLICY`):
  - chat scoped `chat`: `SearchHistory({ query, scope: 'all' })` finds nothing from `b`, `scope: 'chat'`, and carries the widening note; `ReadHistory({ chatId: 'b', fromSeq: 1, toSeq: 2 })` → `ok: false`, the error names `"chat"`, and a spy on `store.getMessages` saw no call for `b`;
  - chat scoped `linked` to `b`: `SearchHistory` returns `b`'s excerpt with `chatId: 'b'` and `chatTitle`; `scope: 'chat'` narrows it away; `ReadHistory({ chatId: 'b', … })` returns `b`'s messages with the chat in each header; `ReadHistory({ chatId: 'c', … })` (not linked) is refused;
  - chat scoped `all`: `scope: 'linked'` searches the links only;
  - a Vault call in `b` read through `ReadHistory` shows action and key only;
  - no `resolveScope` on the context → today's behaviour.
  In `tests/history-core.test.js`: a core's executor built with `historyCrossChat: true` has `context.history.resolveScope`; one built without it does not; a `SpawnAgent` child of the first does not (use the file's existing way of building executors; if a child cannot be built there without a model, assert on the options object the child executor is created with).
- [ ] **Step 2: Run** `node --test tests/history-tools-scope.test.js tests/history-core.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-tools-scope.test.js tests/history-tools.test.js tests/history-search.test.js tests/history-search-rerank.test.js tests/history-vault.test.js tests/history-core.test.js` — expected: `# fail 0`. Then search the tests for the old description strings (`which is this chat`, `only this chat can be read`) and update any that pinned them.
- [ ] **Step 5: Commit.**

```bash
git add src/tools/builtin/history-tools.js src/history/search.js src/core/create-core.js src/ipc/chat-handlers.js tests/history-tools-scope.test.js tests/history-tools.test.js tests/history-search-rerank.test.js tests/history-core.test.js
git commit -m "feat(history): SearchHistory and ReadHistory follow the chat's history scope; a scope argument only narrows"
```

---

## Task 7: IPC for scope and links

After Task 6. Not merged to `main` without Task 8.

**Files:**
- Modify: `src/ipc/constants.js` (`HISTORY_SCOPE_SET: 'history:scope.set'`, `HISTORY_LINKS_GET: 'history:links.get'`, `HISTORY_LINKS_SET: 'history:links.set'`)
- Modify: `src/ipc/history-handlers.js`
- Modify: `preload.js` (`window.electron.history.{ setScope, getLinks, setLinks }`, each validating `chatId`)
- Modify: `src/core/create-core.js` (`resolveHistoryScope` and the policy reach the handlers' context)
- Test: `tests/history-ipc-scope.test.js` (new), `tests/history-ipc.test.js`, `tests/desktop-bridge-allowlist.test.js`

**Interfaces:**
- `history:links.get { chatId }` → `{ ok: true, untrustedText: true, scope: <stored>, effectiveScope, pinned: <reason|null>, links: [{ id, title }], candidates: [{ id, title, linked: boolean, allowed: boolean, reason: <string|null> }] }`. `candidates` is every other chat in list order; `allowed`/`reason` come from the policy's `canRead(reader, source, { explicit: true })`.
- `history:scope.set { chatId, scope }` → refuses a value outside the three (`{ ok: false, error }`), an unknown chat, and a scope wider than the policy's pin for this chat (`{ ok: false, error, code: 'SCOPE_PINNED', reason }`, with `error` from a fixed table keyed by the reason: `case-chat` "A case chat recalls only from itself.", `bridge-chat` "A Telegram or Discord chat recalls only from itself.", `imported-case-chat` "A chat imported from a case recalls only from itself.", anything else "This chat recalls only from itself."); otherwise stores it, emits `chat:updated` the way the other chat mutations in `chat-handlers.js` do, and returns the `links.get` view.
- `history:links.set { chatId, linkedChatIds }` → `linkedChatIds` must be an array of at most 200 strings; a chat the policy refuses is rejected (`{ ok: false, error: 'That chat cannot be linked.', code: 'LINK_REFUSED', refused: [{ id, reason }] }`, nothing stored); otherwise `store.setLinks` and the `links.get` view. Setting links does not change the scope (Task 14's dialog sets `linked` itself).
- `history:search` (existing, the owner-side search) uses `resolveHistoryScope(chatId)` and returns `chatId`/`chatTitle` on excerpts from other chats.
- All three new channels are in the proxied `history` domain: attached, they act on the service's store (R-H4-3). No allowlist line is added; the allowlist test gains the three channels as `'proxy'`.

- [ ] **Step 1: Write the failing tests** (`tests/history-ipc-scope.test.js`, with the fake `ipcMain` pattern of `tests/history-ipc.test.js` and a context holding a temp store and a `resolveHistoryScope` over a small recording policy): each reply shape above; an invalid scope; a pinned chat (`SCOPE_PINNED`, column unchanged, each of the four sentences); a refused link (nothing stored); `links.set` with a non-array, a 201-entry array and a non-string entry refused; a deleted chat disappears from `links`; every reply with titles has `untrustedText: true`. In `tests/desktop-bridge-allowlist.test.js` add the three channels as `'proxy'`.
- [ ] **Step 2: Run** `node --test tests/history-ipc-scope.test.js tests/desktop-bridge-allowlist.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-ipc-scope.test.js tests/history-ipc.test.js tests/history-ipc-jev.test.js tests/desktop-bridge-allowlist.test.js tests/renderer-history-settings.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/ipc/constants.js src/ipc/history-handlers.js preload.js src/core/create-core.js tests/history-ipc-scope.test.js tests/history-ipc.test.js tests/desktop-bridge-allowlist.test.js
git commit -m "feat(history): history:scope.set and history:links.get/set"
```

---

## Task 8: The scope policy, and attach after reading other chats (R-H4-1, R-H4-2, R-H4-7)

After Task 7.

**Files:**
- Create: `src/history/bridge-origin.js` (`bridgeOriginFor(chat)` and `LEGACY_BRIDGE_TITLE_PREFIXES`, moved from `src/ipc/case-handlers.js`; it requires the two bridge modules for their title prefixes exactly as `case-handlers.js` does today; if `tests/electron-boundary.test.js` or a `src/history/` boundary objects to that require, put the file at `src/channels/bridge-origin.js` instead and say so in the report)
- Create: `src/history/scope-policy.js`
- Modify: `src/core/create-core.js` (`historyScopePolicy = createScopePolicy({ bridgeOriginFor })`)
- Modify: `src/cases/chat-attach.js` (`recalledOtherChats`, `ChatRecalledOtherChatsError`, `ImportedChatError`)
- Modify: `src/ipc/case-handlers.js` (`assertAttachable`; import `bridgeOriginFor` from its new home)
- Test: `tests/history-scope-policy.test.js` (new), `tests/case-chat-attach.test.js`, `tests/history-cross-chat-recall.test.js`, `tests/history-ipc-scope.test.js`

**Interfaces:**
- `createScopePolicy({ bridgeOriginFor }) → { pinnedTo(readerRef), canRead(readerRef, sourceRef, { explicit }) }` over the refs of `store.chatRefs()`:

| Rule | `pinnedTo(reader)` | `canRead(reader, source, { explicit })` |
|---|---|---|
| R-H4-1: a chat with a `caseId` | `{ scope: 'chat', reason: 'case-chat' }` | source with a `caseId`: `'case-chat'`, linked or not |
| R-H4-2 (5c): `importedFromCase` | `{ scope: 'chat', reason: 'imported-case-chat' }` (New question N3) | source with `importedFromCase`: `'imported-case-chat'`, linked or not |
| R-H4-7: a bridge chat (`bridgeOriginFor(ref)` is set) | `{ scope: 'chat', reason: 'bridge-chat' }` | bridge source: `'bridge-chat'` unless `explicit` (the owner may link it) |
| anything else | `null` | `true` |

  The first matching row wins, in the order shown. An imported chat that did not come from a case (`source` set, no `importedFromCase`) is an ordinary chat for scope: it may read and be read.
- `chat-attach.js`:
  - `recalledOtherChats(messages, chatId) → { seq, toolName } | null`: the first of (a) an assistant row whose `context.recalledChats` is a non-empty array; (b) a `SearchHistory` `toolResult` whose result has an excerpt with a `chatId` (the result's own shape from Task 6; a result that is `ok: true` and not that shape blocks, in the file's existing "what it cannot tell it refuses" manner); (c) a `ReadHistory` `toolResult` whose `chatId` is set and is not `chatId`. A bare failure (`isBareFailure`) never blocks.
  - `class ChatRecalledOtherChatsError` with `code: 'CHAT_RECALLED_OTHER_CHATS'`, message `RECALLED_OTHER_CHATS_MESSAGE = 'This chat has read other chats, so it cannot be attached to a case. Start a new chat for the case.'`, and `at: { seq, toolName }`.
  - `class ImportedChatError` with `code: 'IMPORTED_CHAT'`, message `'An imported chat cannot be attached to a case; its messages are not verified as the owner\'s.'`.
  - `assertChatAttachable(chat, caseId)` gains, before the existing Q29 check: `if (chat && chat.source) throw new ImportedChatError()`, then `recalledOtherChats(chat.messages, chat.id)` → `ChatRecalledOtherChatsError`. Both run for `case:attach` and for `case:create` with a chat, at the same two points the Q29 check already runs (before anything is fetched or created, and again inside `attach`). `force` lifts neither.
- `case-handlers.js`: the `case:create` handler's catch that turns `CHAT_SAW_OTHER_CASES`, `CHAT_BUSY` and `BRIDGE_CHAT` into "The case was created, but this chat was not attached to it." gains the two new codes.
- Nothing is written to a chat's stored scope on attach: the pin makes the stored value irrelevant while the chat has a case.

What this does not do is listed under "What the rulings cost" above (pasted text, truncation, a detached chat).

- [ ] **Step 1: Write the failing tests.**
  `tests/history-scope-policy.test.js` (through `resolveScope` with the shipped policy on `openTempStore`, and through the Task 7 handlers):
  - `R-H4-1: a case chat stored as "all" reads only itself` (`pinned.reason === 'case-chat'`; `history:scope.set` to `linked` → `SCOPE_PINNED`);
  - `R-H4-1: a case chat is in no other chat's scope, by link or by "all"` (`history:links.set` → `LINK_REFUSED`; `links.get` shows it `allowed: false`, `reason: 'case-chat'`; a link stored before the chat got its case is dropped from `chatIds` with an `excluded` entry);
  - `R-H4-1: a chat given a case after its scope was widened reads only itself on its next turn` (real `ContextBuilder`, `crossChat: true`);
  - `R-H4-2: an imported case-chat export is in no other chat's scope`, and reads only itself (N3);
  - `R-H4-7: a bridge chat reads only itself` (by origin tag and by legacy title prefix);
  - `R-H4-7: a bridge chat is left out of "all" and can be linked`;
  - an imported chat with no case mark reads and is read like any chat.
  `tests/case-chat-attach.test.js` (the real `case:attach` and `case:create` handlers on a temp cases root, as the file already does; `force: true` on `case:create` where a similar case exists):
  - `R-H4-1: a reply that recalled from another chat blocks attach`;
  - `R-H4-1: a SearchHistory or ReadHistory result from another chat blocks attach` (and a `SearchHistory` result with only this chat's excerpts, a `ReadHistory` of this chat, and bare failures of both, do not);
  - `R-H4-1: force does not lift CHAT_RECALLED_OTHER_CHATS`; no case is created by a refused `case:create`;
  - `R-H4-7: an imported chat is refused IMPORTED_CHAT by case:attach and case:create`;
  - every existing case in the file unchanged.
- [ ] **Step 2: Run** `node --test tests/history-scope-policy.test.js tests/case-chat-attach.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-scope-policy.test.js tests/case-chat-attach.test.js tests/history-cross-chat-recall.test.js tests/history-ipc-scope.test.js tests/history-tools-scope.test.js tests/history-core.test.js tests/electron-boundary.test.js`, and every other test file that names `CASE_ATTACH`, `case:attach` or `bridgeOriginFor` (search `tests/`) — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/bridge-origin.js src/history/scope-policy.js src/core/create-core.js src/cases/chat-attach.js src/ipc/case-handlers.js tests/history-scope-policy.test.js tests/case-chat-attach.test.js tests/history-cross-chat-recall.test.js tests/history-ipc-scope.test.js
git commit -m "feat(history): case, bridge and imported chats keep to themselves; a chat that read other chats cannot be attached to a case"
```

---

## Task 9: Importing a chat into the history store

After Task 8 (stream i). Needs Tasks 1 and 3.

**Files:**
- Create: `src/history/import-chats.js`
- Modify: `src/history/history-store.js` (`appendMessages`)
- Modify: `src/history/index.js` (export), `src/core/create-core.js` (call `sweepUnfinishedImports` in `start()` after the store opens and before the chunk backfill starts; expose `getHistoryStore` users nothing new)
- Create: `tests/fixtures/history/claude-code-session.jsonl` (ten synthetic records, written once with `tests/helpers/claude-code-fixture.js` and committed; spec §13)
- Test: `tests/history-import-chats.test.js`, `tests/history-store-messages.test.js`

**Interfaces:**
- `HistoryStore#appendMessages(chatId, messages, { updatedAt } = {}) → { count, lastSeq }`: several messages in one transaction through the same insert path as `appendMessage` (chunks and FTS rows with each message), one `_emitAppend` with the last seq.
- `hashFile(filePath) → Promise<string>`: streamed SHA-256, hex.
- `parseImport(filePath, { pattern } = {}) → Promise<{ kind, importerVersion, sourceHash, chat, messages, stats }>`: `detectImporter`, then `parse`; a file no importer claims throws `code: 'IMPORT_UNKNOWN_FORMAT'`; a Claude Code subagent file keeps the importer's `SUBAGENT_FILE`. `chat.importedFromCase` is set to `true` here when the importer is `king-louie-json` and the file's chat object has a non-empty string `caseId` (read from the parsed file; the id itself is not kept).
- `previewImport(filePath, { pattern } = {}) → { kind, importerVersion, sourceHash, ...importer.preview() }`.
- `beginChatImport({ store, kind, importerVersion, sourceHash, sourcePath = null, chat, now }) → { importId, chatId } | { existingChatId }`:
  1. validates `kind` (one of the `IMPORTERS` kinds), `sourceHash` (64 hex characters) and `chat.title` (a string, cut to 200 characters; empty becomes "Imported chat"); anything else throws `code: 'IMPORT_INVALID'`;
  2. `store.findImport(sourceHash)`: a `done` row returns `{ existingChatId }` (idempotent, spec §10.2); a `running` row is aborted first (its chat deleted), then the import proceeds;
  3. builds the chat from a **fixed list**: `title`, `source: kind`, `createdAt`, `updatedAt` (each only when a valid time string) and `importedFromCase: true` (only when the input has exactly `true`). Nothing else from the input: no `caseId`, `origin`, `historyScope`, `agentMode`, `workingDirectory`, `llmTotals`, `disabledMcpServers`;
  4. the chat id is the input's `chat.id` when it is a string of 1 to 200 characters matching `^[A-Za-z0-9._-]+$` and no chat has it; otherwise `<id or 'import'>-<first 8 of the hash>`, then `-2`, `-3`, … until free. **Never** `createChat` with an id that exists (R-H4-8);
  5. one transaction: `createChat({ id, …, messages: [] }, { position: 'front' })` and `recordImport({ id: importId, state: 'running', … })` (`importId` is `crypto.randomUUID()`).
- `appendChatImport({ store, importId, messages }) → { done }`: the import must be `running`, else `code: 'IMPORT_NOT_OPEN'`. Each message is reduced to a fixed list of keys: `id`, `timestamp`, `sender` (one of `user`, `assistant`, `toolUse`, `toolResult`, `status`; anything else throws `IMPORT_INVALID`), `text`, `toolName`, `parameters`, `result`, `toolCalls`, `documents`, `images`, `runId`, `stopped`, `meta`. Dropped whatever arrives: `seq` (the store's), `context`, `llm`, `question`, and `meta.action` (so an imported nudge or question card never renders as live). Attachment entries keep only `name`, `mimeType`, `type`, `size`, `textContent` (no bytes). A Vault call or result is reduced as `king-louie-json` reduces it (`isUnindexedTool`, `visibleToolParams`), so the rule also holds for a chat that arrives parsed over the bridge. Then `store.appendMessages`.
- `finishChatImport({ store, importId }) → { chatId, messages }`: `finishImport(importId, { messageCount })`.
- `abortChatImport({ store, importId })`: deletes the import's chat (the cascade removes the row). Safe to call twice.
- `importChat({ store, filePath, pattern, batchSize = 500, schedule = setImmediate, now, onProgress }) → Promise<{ chatId, imported: boolean, messages, kind, stats }>`: `parseImport`, `beginChatImport` (`sourcePath: filePath`), `appendChatImport` in batches of `batchSize` yielding through `schedule` and calling `onProgress({ done, total })`, `finishChatImport`. Any failure after `begin` calls `abortChatImport` and rethrows.
- `sweepUnfinishedImports(store) → number`: deletes the chat of every `running` import (a crash mid-import); logged once with the count, no titles.

- [ ] **Step 1: Write the failing test** (`openTempStore`; the three fixtures; `schedule: (fn) => fn()`):
  - each kind imports: the chat exists with `source`, message count, dense `seq`, and `searchText` finds a word from it;
  - the same file twice → the second returns `imported: false` and the same `chatId`; one chat, one import row;
  - the chat deleted, then the same file again → imported afresh;
  - **`R-H4-8: a chat with the importer's id survives the import untouched`**: a native chat created with id `cc-<the fixture's session id>` and one message is unchanged, and the import gets a suffixed id;
  - **`R-H4-8: a grown copy of an imported session becomes a second chat`**: append two records to a copy (new hash, same session id) → two chats, the first unchanged;
  - a King Louie export whose chat object has `caseId`, `historyScope: 'all'`, `origin: 'telegram'`, `agentMode: true` → the stored chat has none of them, `getHistoryScope` is `'chat'`, `chatRef(id).importedFromCase` is true; the same export without `caseId` → no mark;
  - `beginChatImport` given `importedFromCase: 'yes'`, a 300-character id, an id with a slash, a bad hash and an unknown kind → the mark is not set, the id is replaced, and the last two throw `IMPORT_INVALID`;
  - a message carrying `question`, `context`, `llm`, `seq: 999`, attachment `base64` and `meta.action` is stored without them; an unknown sender throws and the import is aborted;
  - a Vault call given to `appendChatImport` with its full parameters and result is stored with action and key only and makes no chunks;
  - a batch that throws (stub `appendMessages` to throw on the second call) → no chat, no import row, the error rethrown;
  - `appendChatImport` and `finishChatImport` on a finished or unknown import → `IMPORT_NOT_OPEN`;
  - `sweepUnfinishedImports` removes a `running` import's chat and leaves a `done` one;
  - 1,200 synthetic messages with `batchSize: 500` → `onProgress` called with 500, 1,000, 1,200 and one `onAppend` emission per batch;
  - an unknown format → `IMPORT_UNKNOWN_FORMAT`, nothing written.
  In `tests/history-store-messages.test.js`: `appendMessages` gives dense seqs after existing messages, chunks each message, and emits once.
- [ ] **Step 2: Run** `node --test tests/history-import-chats.test.js tests/history-store-messages.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-import-chats.test.js tests/history-store-messages.test.js tests/history-embed-indexer.test.js tests/history-core.test.js tests/history-vault.test.js tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/import-chats.js src/history/history-store.js src/history/index.js src/core/create-core.js tests/fixtures/history/claude-code-session.jsonl tests/history-import-chats.test.js tests/history-store-messages.test.js
git commit -m "feat(history): import a transcript into the history store, in batches, never over an existing chat"
```

---

## Task 10: Imported chats stay local (R-H4-2)

After Task 9.

**Files:**
- Modify: `src/history/embedding-index.js` (`pendingEmbeddings`, `countPending`)
- Modify: `src/history/history-store.js` (pass the option through)
- Modify: `src/history/embed-indexer.js` (sets the option from the embedder's key)
- Modify: `src/history/reranker.js` (`keepLocalReason`, the Jev dispatch)
- Modify: `src/history/retriever.js` (`retrieve({ keepLocal })` reaches the reranker's options)
- Modify: `src/history/context-builder.js`, `src/history/search.js` (pass `keepLocal`)
- Test: `tests/history-imports-local.test.js` (new), `tests/history-embeddings-store.test.js`, `tests/history-embed-indexer.test.js`, `tests/history-jev-reranker.test.js`

**Interfaces:**
- `pendingEmbeddings(db, model, { …, localOnly = false })` and `countPending(db, model, { …, localOnly = false })`: with `localOnly` false (a hosted key), chunks whose chat has `source IS NOT NULL` are left out (`AND NOT EXISTS (SELECT 1 FROM chats ch WHERE ch.id = c.chat_id AND ch.source IS NOT NULL)`). With `localOnly` true (the local key) every chunk is eligible, as today. The default is `false`: a caller that does not say is treated as hosted.
- `embed-indexer.js`: passes `localOnly: key.startsWith('local:')` on every `pendingEmbeddings` and `countPending` call. Every other kind (`openai:`, `ollama:`) counts as hosted (New question N1). Progress therefore reaches 100% under a hosted key although imported chats have no vectors; they are searched by BM25 alone, and `VectorIndex` finds no rows for them.
- `keepLocalReason(store, chatIds) → 'imported-chat' | null`: `'imported-chat'` when any chat in `chatIds` has `source` set (`store.chatRef`).
- `Retriever#retrieve({ …, keepLocal = null })`: passed to the reranker callback as `options.keepLocal`, beside the existing `options.caseId`.
- `createRecallReranker`: `if (kind === 'jev' && options.caseId) throw new EmbedError('RERANK_SKIPPED', 'case-chat')` (existing), then `if (kind === 'jev' && options.keepLocal) throw new EmbedError('RERANK_SKIPPED', options.keepLocal)`. The local cross-encoder is not affected.
- `ContextBuilder#build` and `searchHistoryExcerpts` pass `keepLocal: keepLocalReason(store, chatIds)`.
- Provenance: `rerankSkipped: 'imported-chat'` through the existing path; no new field.

What this does not do is under "What the rulings cost": the chat model still sees recalled imported text, and the query is still embedded by the active embedder.

- [ ] **Step 1: Write the failing tests** (`tests/history-imports-local.test.js`; a temp store with one native chat and one chat imported through `importChat` from the Markdown fixture):
  - **`R-H4-2: a hosted embedder is never given a chunk of an imported chat`**: `startEmbedIndexer` with a recording embedder whose key is `openai:text-embedding-3-small` (the pattern of `tests/history-embed-indexer.test.js`) embeds every chunk of the native chat and none of the imported one, and its progress reports nothing pending afterwards; with key `ollama:nomic-embed-text` the same (N1); with key `local:Xenova/all-MiniLM-L6-v2` both chats are embedded;
  - a message appended later to the imported chat is not given to the hosted embedder either;
  - **`R-H4-2: Jev is not called when an imported chat is in scope`**: `createRecallReranker` with a recording fake `jev` and settings `rerank.kind: 'jev'`, `rerank.enabled: true`; a build in the imported chat, and a build in a native chat scoped `linked` to it, leave `jev.rerank` uncalled and give `stats.rerankSkipped === 'imported-chat'` with no warning logged (`addSink` from `src/logging`); a native chat with no imported chat in scope is reranked; with `rerank.kind: 'local'` the cross-encoder fake is called in all three;
  - `searchHistoryExcerpts` in the imported chat with `rerank.search` true and kind `jev` → not called.
  In `tests/history-embeddings-store.test.js`: `pendingEmbeddings` and `countPending` with and without `localOnly`.
- [ ] **Step 2: Run** `node --test tests/history-imports-local.test.js tests/history-embeddings-store.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-imports-local.test.js tests/history-embeddings-store.test.js tests/history-embed-indexer.test.js tests/history-jev-reranker.test.js tests/history-core-jev.test.js tests/history-core-embeddings.test.js tests/history-rerank-provenance.test.js tests/history-retriever.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/embedding-index.js src/history/history-store.js src/history/embed-indexer.js src/history/reranker.js src/history/retriever.js src/history/context-builder.js src/history/search.js tests/history-imports-local.test.js tests/history-embeddings-store.test.js tests/history-embed-indexer.test.js tests/history-jev-reranker.test.js
git commit -m "feat(history): an imported chat's chunks never go to a hosted embedder or to Jev"
```

---

## Task 11: Import IPC: pick, preview, commit, and the batch channels

After Task 10.

**Files:**
- Modify: `src/ipc/constants.js` (`HISTORY_IMPORT_PICK: 'history:import.pick'`, `HISTORY_IMPORT_PREVIEW: 'history:import.preview'`, `HISTORY_IMPORT_COMMIT: 'history:import.commit'`, `HISTORY_IMPORT_LOOKUP: 'history:import.lookup'`, `HISTORY_IMPORT_BEGIN: 'history:import.begin'`, `HISTORY_IMPORT_APPEND: 'history:import.append'`, `HISTORY_IMPORT_FINISH: 'history:import.finish'`)
- Create: `src/ipc/import-picks.js` (the token map and the desktop-side steps, shared by the standalone handlers and Task 12's attached ones)
- Modify: `src/ipc/history-handlers.js`, `preload.js`
- Modify: `src/desktop-bridge/allowlist.js` (`'history:import.pick'`, `'history:import.preview'`, `'history:import.commit'` join `DENY_CHANNELS` **in this task**; Task 12 moves them to the local list)
- Modify: `main.js` (pass `pickImportFile` into the handlers' context, built on `dialog.showOpenDialog` beside the existing working-directory dialog)
- Test: `tests/history-ipc-import.test.js` (new), `tests/desktop-bridge-allowlist.test.js`

**Interfaces:**
- `import-picks.js` exports `createImportPicks({ pickFile, now = Date.now })`:
  - `pick() → { ok: true, token, name } | { ok: false, canceled: true }`: `pickFile()` (the dialog; filters `jsonl`, `json`, `md`, `markdown`) returns a path or null; the path is stored under `crypto.randomBytes(16).toString('hex')` in a map private to the instance (at most 8 entries, each dropped after 15 minutes or when spent); `name` is the base name.
  - `pathFor(token) → string | null`, `spend(token)`.
- **No renderer-facing channel takes a path** (R-H4-3). The handlers read only `token` and `pattern` from the payload.
- `history:import.pick` → `picks.pick()`.
- `history:import.preview { token, pattern? }` → `{ ok: true, untrustedText: true, kind, title, turns, sample, roles?, patterns?, pattern?, existingChatId }` from `previewImport`, `existingChatId` from `store.findImport(sourceHash)` (a `done` row whose chat exists); an unknown token → `{ ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' }`; importer errors become `{ ok: false, error, code }`.
- `history:import.commit { token, pattern? }` → runs `importChat`, spends the token, emits `chat:updated`, returns `{ ok: true, chatId, imported, messages }`. One import at a time per core: a second commit while one runs → `{ ok: false, error: 'Another import is running.', code: 'IMPORT_BUSY' }`.
- The batch channels, served by every host with a store (the standalone desktop and the service). They take an already parsed chat, never a path:
  - `history:import.lookup { sourceHash }` → `{ ok: true, existingChatId: <id|null> }`.
  - `history:import.begin { kind, importerVersion, sourceHash, sourceName?, chat, total }` → `beginChatImport` with `sourcePath` set to the base name of `sourceName` (at most 255 characters, control characters removed; never a directory); replies `{ ok: true, importId, chatId }` or `{ ok: true, existingChatId }`. Refuses `IMPORT_BUSY` while another import is open on this core. `total` must be an integer from 1 to 2,000,000.
  - `history:import.append { importId, messages }` → at most 500 messages and 8 MB (the JSON length of `messages`) a call, else `{ ok: false, code: 'IMPORT_BATCH_TOO_LARGE' }`; a batch that would take the import past its `total` is refused and the import aborted; a failure aborts the import.
  - `history:import.finish { importId }` → `finishChatImport`, emits `chat:updated`, replies `{ ok: true, chatId, messages }`.
  - An import open for more than 30 minutes without a call is aborted (a timer the handler unrefs and clears on finish; `core.shutdown()` aborts any open one).
- `preload.js`: `window.electron.history.{ pickImport, previewImport, commitImport }` only; `token` validated as a non-empty string; `pattern` as an optional string. The batch channels are not exposed to the renderer.
- Attached, in this task: pick, preview and commit are denied; lookup, begin, append and finish are proxied by the domain rule. Task 12 makes the first three local.

- [ ] **Step 1: Write the failing test** (`tests/history-ipc-import.test.js`, fake `ipcMain`, a temp store, the three fixtures):
  - `pick` with a fake `pickFile` (a path, then `null`); the ninth pick drops the oldest token; a token is gone after 15 minutes (inject `now`);
  - `preview` and `commit` with a good token; a made-up token refused;
  - **`R-H4-3: no import channel takes a path`**: `preview` and `commit` given `path`, `filePath` and `sourcePath` in the payload, pointing at a different fixture, preview the picked file (assert the title) and never open the other (a spy on `fs`'s open functions for that path); `begin` given `chat.sourcePath` or a `sourceName` of `../../etc/x.jsonl` stores only `x.jsonl`;
  - `commit` twice at once → `IMPORT_BUSY`; the token is spent after a commit;
  - the batch channels end to end: `lookup` (null), `begin`, two `append`s, `finish`, then `lookup` returns the chat; `begin` again with the same hash → `existingChatId`;
  - hostile input to `begin`/`append`: a `chat` with `caseId`, `historyScope`, `origin` (none stored); an id that names an existing chat (a new id is used, the existing chat untouched); 501 messages; a 9 MB batch; more messages than `total`; an unknown `importId`; a message with an unknown sender (the import is aborted and its chat gone);
  - an import left open is aborted after 30 minutes (inject the timer);
  - `untrustedText: true` on the preview.
  Allowlist: pick, preview and commit are `'deny'`; lookup, begin, append, finish and `history:links.get` are `'proxy'`.
- [ ] **Step 2: Run** `node --test tests/history-ipc-import.test.js tests/desktop-bridge-allowlist.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-ipc-import.test.js tests/history-ipc.test.js tests/history-ipc-scope.test.js tests/desktop-bridge-allowlist.test.js tests/electron-boundary.test.js` — expected: `# fail 0`. If a test lists every IPC channel or every bridge-served channel (search `tests/` for `history:embedder.status`), add the seven there.
- [ ] **Step 5: Commit.**

```bash
git add src/ipc/constants.js src/ipc/import-picks.js src/ipc/history-handlers.js src/desktop-bridge/allowlist.js preload.js main.js tests/history-ipc-import.test.js tests/desktop-bridge-allowlist.test.js
git commit -m "feat(history): import IPC: the file is picked in the main process, and a parsed chat is stored in batches"
```

---

## Task 12: Import while attached: the desktop parses, the service stores (R-H4-3)

After Task 11.

**Files:**
- Modify: `src/desktop-bridge/allowlist.js` (the three channels leave `DENY_CHANNELS` and join `LOCAL_CHANNELS`)
- Modify: `src/ipc/attached-host.js` (three entries in the `LOCAL` table)
- Test: `tests/attached-host-import.test.js` (new), `tests/desktop-bridge-allowlist.test.js`, `tests/e2e/history-import-attached.test.js` (new)

**Interfaces:**
- `classifyChannel`: `history:import.pick`, `.preview`, `.commit` → `'local'`; `.lookup`, `.begin`, `.append`, `.finish` → `'proxy'` (unchanged).
- `attached-host.js`: one `createImportPicks({ pickFile })` for the host, `pickFile` built on the file's existing `dialog` and `getWindow()`. The `LOCAL` entries:
  - `history:import.pick` → `picks.pick()`.
  - `history:import.preview { token, pattern? }` → `previewImport` on the desktop (the importers are required from `src/history/`), then `proxyInvoke('history:import.lookup', [{ sourceHash }])` for `existingChatId`. When the service is not reachable the preview is still returned, with `existingChatId: null` and `serviceUnreachable: true`.
  - `history:import.commit { token, pattern? }` → `parseImport` on the desktop; `proxyInvoke('history:import.begin', [{ kind, importerVersion, sourceHash, sourceName: <base name>, chat, total }])`; when the reply has `existingChatId`, return `{ ok: true, chatId, imported: false }`; otherwise send the messages with `history:import.append` in batches of at most 200 messages and 4 MB of JSON each (half the service's caps; a single message over 4 MB goes alone; one over 8 MB ends the import with `{ ok: false, code: 'IMPORT_MESSAGE_TOO_LARGE', error: 'One message of this conversation is too large to send to the service.' }`); then `history:import.finish`. Any failed call ends the commit with that reply; the service aborts the open import on its own (a failed `append` aborts at once; a lost connection after 30 minutes, or at the next `begin` for the same hash, which removes a `running` import first). One commit at a time per desktop (`IMPORT_BUSY`). The token is spent on success.
  - Every proxied call goes through the existing `proxyInvoke`, so a service older than these channels answers `SERVICE_TOO_OLD` with the existing message.
- The desktop never sends its path: `sourceName` is the base name.
- Nothing is written on the desktop; the chat exists only in the service's store, and the service's `chat:updated` event reaches the renderer as today.

- [ ] **Step 1: Write the failing tests.**
  `tests/attached-host-import.test.js` (the way the existing attached-host tests build the host with a fake client, fake `ipcMain` and fake `dialog`; search `tests/` for `attached-host` and copy that setup):
  - **`R-H4-3: a commit while attached sends the parsed chat in batches`**: a 450-message Markdown transcript written to a temp dir → one `begin`, three `append`s (200, 200, 50), one `finish`, in that order; no call's arguments contain the temp dir's path; `begin.sourceName` is the base name;
  - `begin` answering `existingChatId` → no `append`, `imported: false`;
  - a 5 MB message goes in an `append` of its own; a 9 MB one ends the commit with `IMPORT_MESSAGE_TOO_LARGE` before `begin` is called;
  - a failed `append` ends the commit with its error and sends no `finish`;
  - the service unreachable: `preview` still returns the local preview with `serviceUnreachable: true`; `commit` returns the host's existing unreachable reply;
  - a served-channel list without `history:import.begin` → `SERVICE_TOO_OLD`;
  - a made-up token → `IMPORT_NO_FILE`; two commits at once → `IMPORT_BUSY`.
  Allowlist: **`R-H4-3: pick, preview and commit are local; begin, append, finish and lookup are proxied`**.
  `tests/e2e/history-import-attached.test.js`: `launchAttached()` (`tests/e2e/helpers.js`); the test cannot drive a native dialog, so the app reads `KL_TEST_IMPORT_FILE` as the picked path **only when `KL_TEST_MODE` is set** (one line in the `pickFile` of both hosts, with a comment; the unit tests above pin that the variable is ignored without `KL_TEST_MODE`). The test points it at `tests/fixtures/history/markdown-transcript.md`, calls `window.electron.history.pickImport`, `previewImport`, `commitImport` through `page.evaluate`, and asserts the new chat is in the chat list with the fixture's title and that `history:search` on it finds a word of the fixture.
- [ ] **Step 2: Run** `node --test tests/attached-host-import.test.js tests/desktop-bridge-allowlist.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/attached-host-import.test.js tests/desktop-bridge-allowlist.test.js tests/history-ipc-import.test.js tests/electron-boundary.test.js`, every other test file that names `attached-host` (search `tests/`), and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-import-attached.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/desktop-bridge/allowlist.js src/ipc/attached-host.js src/ipc/import-picks.js main.js tests/attached-host-import.test.js tests/desktop-bridge-allowlist.test.js tests/e2e/history-import-attached.test.js
git commit -m "feat(history): import while attached: the desktop parses the file and the service stores the chat"
```

---

## Task 13: `king-louie-service history import <file>` (R-H4-4)

Stream ii: may run in parallel with Tasks 10 to 12 and 14, once Task 9 is in its base.

**Files:**
- Create: `src/service/commands/history.js`
- Modify: `src/service/cli.js` (a `case 'history'` beside `case 'models'`; the `HELP` text)
- Modify: `docs/install-guide.md` (one short section; invented paths only, it is scanned by `tests/examples.test.js`)
- Test: `tests/service-cli-history.test.js` (new, with the `io` and `deps` fakes of `tests/service-cli-models.test.js`), `tests/service-cli.test.js` if it pins the help text

**Interfaces:**
- `runHistoryCommand({ sub, arg, flags, dataDir, io, deps }) → Promise<number>`, `deps = { runningServicePid, isAdmin = require('./admin-check').isAdmin, platform = process.platform, getuid, statDataDir = fs.statSync }`.
- Usage: `king-louie-service history import <file> [--pattern <id>] [--data-dir DIR]`. Any other `sub`, or no file → the usage on stderr, exit 2. `--yes` stays a usage error here as everywhere but `desktop pair`.
- Refusals, each one sentence on stderr, exit 1, nothing opened or written:
  1. `deps.isAdmin()` is true → "Run this as the account that owns <dataDir>, not as root or Administrator: an import written by an administrator would leave files the service cannot use." On POSIX the sentence ends with the owner's uid.
  2. POSIX only: `getuid() !== statDataDir(dataDir).uid` → "<dataDir> belongs to uid <n>; run this as that account."
  3. `runningServicePid(dataDir)` → the wording `models.js` uses in `refuseWhileRunning` (stop it first).
  4. the data dir or the file does not exist.
- Otherwise: `HistoryStore.open(path.join(dataDir, 'history.sqlite'))` directly (no core, so no migration out of `chat-data.json` and no embedder), `sweepUnfinishedImports`, `importChat({ store, filePath, pattern })`, then `store.close()` in a `finally`. Output on stdout, every string from the file passed through `printable` (`import-channel.js`): the kind, the title, the message count and the chat id; for an already imported file "Already imported as <chat id>."; for a Markdown transcript without `--pattern`, the pattern used and the others that matched. Exit 0.
- An importer error (`IMPORT_UNKNOWN_FORMAT`, `NOT_A_TRANSCRIPT`, `UNKNOWN_PATTERN`, `TRANSCRIPT_TOO_LARGE`, `SUBAGENT_FILE`) → its message on stderr, exit 1.
- A data dir that has never been started has no `history.sqlite`: the command creates it at the current schema, which is what the service would do; chats still in `chat-data.json` move on the service's next start as before.
- Windows residual (stated under "What the rulings cost"): no owner check; refusal 1 only.

- [ ] **Step 1: Write the failing test**: **`R-H4-4: refused as root`** (`isAdmin: () => true`, POSIX), **`R-H4-4: refused as Administrator`** (`platform: 'win32'`), **`R-H4-4: refused when the data dir belongs to another account`**, **`R-H4-4: refused while the service runs`**; in each the temp data dir has no `history.sqlite` afterwards; a successful import of each fixture into a temp data dir (open the store afterwards and find the chat; `closeOpenHistoryStores()` before cleanup); the same file twice → "Already imported"; `--pattern` used and reported; a control character in a transcript title is printed as `?`; usage errors exit 2; a missing file exits 1.
- [ ] **Step 2: Run** `node --test tests/service-cli-history.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/service-cli-history.test.js tests/service-cli.test.js tests/service-cli-models.test.js tests/examples.test.js tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/service/commands/history.js src/service/cli.js docs/install-guide.md tests/service-cli-history.test.js
git commit -m "feat(service): history import, as the data dir's owner with the service stopped"
```

---

## Task 14: The chat menu: "Recall from" and "Link chats…", and the recall line

Stream iii: after Task 8; may run in parallel with Tasks 9 to 13.

**Files:**
- Modify: `index.html` (`#chat-context-menu`: three "Recall from" items and "Link chats…" above "Delete chat"; a `#link-chats-dialog`)
- Modify: `renderer.js` (the `dom.chatContextMenu` click handler and `openContextMenu`; `openLinkChatsDialog`; `recallLineText`)
- Modify: `styles.css`
- Test: `tests/renderer-history-scope.test.js` (new; the static approach of `tests/renderer-history-settings.test.js`: read the sources, extract functions with `block(start, end)`, assert on text and on the absence of `innerHTML`)

**Behaviour:**
- Opening the chat context menu calls `window.electron.history.getLinks({ chatId })` and marks the current choice: "Recall from: this chat", "Recall from: linked chats (N)", "Recall from: all chats". When `pinned` is set the two wider items are disabled and one line under them says why, from a fixed table in the renderer keyed by the reason (`recallPinText(reason)`): `case-chat` "A case chat recalls only from itself."; `bridge-chat` "A Telegram or Discord chat recalls only from itself."; `imported-case-chat` "A chat imported from a case recalls only from itself."; anything else "This chat recalls only from itself." The reason string itself is never shown.
- Choosing an item calls `setScope`; a refusal shows the reply's `error` with the existing error notice (text only).
- "Link chats…" opens a dialog listing `candidates` with a checkbox each (title by `textContent`; a candidate with `allowed: false` is disabled, with `recallLinkRefusedText(reason)`: `case-chat` "A case chat cannot be linked."; `imported-case-chat` "A chat imported from a case cannot be linked."; anything else "This chat cannot be linked."). The dialog's first line: "Links go one way: this chat can read the chats you tick. They cannot read this chat." A second line, always shown: "A chat that reads other chats cannot be attached to a case later." (R-H4-1). Save calls `setLinks`, then `setScope('linked')` if the stored scope was `chat` and at least one link was saved, and says so ("This chat now recalls from its linked chats.").
- `recallScopeWord(context)` returns `''` (scope `chat` or missing), `'linked chats'` or `'all chats'`; `recallLineText(context)` is unchanged when the word is empty, otherwise the word is added after the history size (`… from 412K tokens of history · linked chats · <via>`).
- The excerpt drawer already prints each excerpt's `header` and `text` with `textContent`; an excerpt whose header starts with `[chat "` gets the class `recall-excerpt-other-chat`.

- [ ] **Step 1: Write the failing test**: `recallScopeWord` and `recallLineText` for the three scopes and for a context with no `scope` (byte-identical to today's string for `chat`); the two text tables; the menu markup has the four items; the dialog has both fixed lines; `preload.js` exposes `setScope`, `getLinks`, `setLinks`; the source of `openLinkChatsDialog` and of the menu handler contains no `innerHTML`, `insertAdjacentHTML` or `outerHTML`.
- [ ] **Step 2: Run** `node --test tests/renderer-history-scope.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/renderer-history-scope.test.js tests/renderer-history-text.test.js tests/renderer-history-settings.test.js tests/renderer-history-rerank.test.js tests/renderer-history-lazy.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add index.html renderer.js styles.css tests/renderer-history-scope.test.js
git commit -m "feat(history): the chat menu sets what a chat recalls from and links chats; the recall line names the scope"
```

---

## Task 15: The import dialog

After Tasks 12 and 14.

**Files:**
- Modify: `index.html` (an "Import a conversation…" button beside `#export-chat-btn`; an `#import-chat-dialog`)
- Modify: `renderer.js` (the dialog; an entry beside "Export as JSON" in the command list), `styles.css`
- Test: `tests/renderer-history-import.test.js` (new, static like Task 14's)

**Behaviour:**
- The item calls `pickImport`, then `previewImport`, and shows: the file's name; the detected kind in words (`importKindText(kind)`: `claude-code-jsonl` "Claude Code session", `markdown-transcript` "Markdown transcript", `king-louie-json` "King Louie export", anything else "Conversation"); the title; the turn count; the first five sample lines; and for a Markdown transcript the first five heading-to-role assignments with a select of the patterns that matched (changing it calls `previewImport` again with that pattern). Every one of these strings is set with `textContent`.
- **The warning (R-H4-2), always shown above the Import button, exactly:** "This conversation becomes a chat that recall can search. If it contains passwords or keys, they become searchable too, and can be shown to the chat model. Its text is never sent to an embedding service or to typesafe.ai." (`IMPORT_WARNING_TEXT`.)
- A second fixed line: "An imported chat cannot be attached to a case." (R-H4-7.)
- When `existingChatId` is set: "This file was already imported." and a button that selects that chat; no Import button. When `serviceUnreachable` is set: "The service is not reachable; the preview is shown, but the chat cannot be imported now." and the Import button disabled.
- "Import" calls `commitImport`, shows a busy state (no progress bar: the commit is one call), then selects the new chat. A refusal shows its `error` as text. The item works standalone and attached alike (Task 12); nothing in the renderer differs between them.

- [ ] **Step 1: Write the failing test**: `importKindText`; **`R-H4-2: the dialog's warning`** (`IMPORT_WARNING_TEXT` equals the sentence above, and the dialog's render function sets it); the R-H4-7 line; the markup has the dialog and the button; `preload.js` exposes `pickImport`, `previewImport`, `commitImport` and none of `begin`, `append`, `finish`, `lookup`; the dialog's render function contains no `innerHTML`, `insertAdjacentHTML` or `outerHTML`.
- [ ] **Step 2: Run** `node --test tests/renderer-history-import.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/renderer-history-import.test.js tests/renderer-history-scope.test.js tests/renderer-history-settings.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add index.html renderer.js styles.css tests/renderer-history-import.test.js
git commit -m "feat(history): the import dialog: a preview and a warning the owner confirms before a transcript becomes a chat"
```

---

## Task 16: The case nudge (R-H4-5)

After Task 15.

**Files:**
- Modify: `src/history/settings.js` (`caseNudgeAfterUserTurns`)
- Modify: `src/history/history-store.js` (`userMessageCount`)
- Create: `src/cases/case-nudge.js`
- Modify: `src/ipc/chat-handlers.js` (the send path, after the reply is stored)
- Modify: `renderer.js` (the `message.sender === 'status'` branch of the chat render, and the live path that draws a newly arrived status message), `styles.css`
- Test: `tests/history-case-nudge.test.js` (new), `tests/history-settings.test.js`, `tests/renderer-history-scope.test.js` (one added block) or a new `tests/renderer-case-nudge.test.js`

**Interfaces:**
- `HISTORY_DEFAULTS.caseNudgeAfterUserTurns = 40` (spec §14); `mergeHistorySettings` accepts an integer from 0 to 100,000 (0 turns the nudge off) and keeps the default for anything else. `history.version` stays 3: a new key with a default needs no mapping. It is not a `recall` key and is not in the settings pane (Decision 15).
- `store.userMessageCount(chatId) → number` (`SELECT COUNT(*) FROM messages WHERE chat_id = ? AND sender = 'user'`).
- `src/cases/case-nudge.js`:
  - `NUDGE_TEXT = 'This chat is getting long. If it is about a task with decisions worth keeping, you can turn it into a case.'`, `NUDGE_ACTION = 'convertToCase'`.
  - `nudgeDue({ chat, userMessageCount, threshold }) → boolean`: the chat has no `caseId` and no `caseNudgedAt`, `threshold > 0`, `userMessageCount >= threshold`.
  - `canOfferCase({ chat, messages, bridgeOriginFor, attachBlock, recalledOtherChats }) → boolean`: false for a bridge chat, for a chat with `source` set, when `attachBlock(messages, null)` finds a row, or when `recalledOtherChats(messages, chat.id)` does. These are the checks `case:create` with a chat would make, except `CHAT_BUSY` (the turn is over by the time the owner can press the button).
- Send path (`chat-handlers.js`): after the turn's assistant reply has been appended (the send path's final `appendMessageToChat(chatId, 'assistant', …)`, on the success path only; not after a stopped or failed turn, and never in a case turn), and only when the host has a history store:
  1. `nudgeDue` with `store.userMessageCount(chatId)` and the merged setting; when false, nothing.
  2. `updateChat(chatId, { caseNudgedAt: <now, ISO> })`, **whatever step 3 finds** (R-H4-5), so the check runs once per chat.
  3. `getChat(chatId, { messages: true })` once, `canOfferCase`; when true, `appendMessageToChat(chatId, 'status', NUDGE_TEXT, { meta: { action: NUDGE_ACTION } })` and the renderer is told the way the send path already tells it about a stored message (`chat:updated`).
  A failure in any of the three steps is logged at `warn` and never fails the turn.
- **Nothing is added to the model's prompt** (R-H4-5): the row is a `status` message, which the tail never includes (`isContent`) and the chunker never indexes, and no sentence goes into `systemPromptDynamic`.
- Renderer: a `status` message with `meta.action === 'convertToCase'` is drawn by `renderCaseNudge(message, chat)`: its text by `textContent`, and a button "Make this a case" shown only while the chat has no `caseId` and no `source`. The button scrolls the chat's case section into view and opens its "New case" flow (the existing `select` in `renderChatCaseSection` set to `__new__` and its `change` handler run), where every refusal (`CHAT_BUSY`, `SIMILAR_CASES`, `CHAT_SAW_OTHER_CASES`, `CHAT_RECALLED_OTHER_CHATS`) already has its message. Any other `status` message is drawn as today.
- Task 9 strips `meta.action` from imported messages, so an imported or re-imported chat never shows a button from a file.

- [ ] **Step 1: Write the failing tests.**
  `tests/history-case-nudge.test.js`:
  - `nudgeDue` and `canOfferCase` as pure functions (each false case);
  - through the send path, with a core from `tests/helpers/history-context.js`, `tests/helpers/fake-llm-server.js` and `tests/helpers/profile-settings.js`, the threshold pinned to 3 in settings: **`R-H4-5: one status row at the threshold, never a second`** (two turns: none; the third: exactly one `status` row with `meta.action === 'convertToCase'` and `caseNudgedAt` set; a fourth and fifth: still one);
  - **`R-H4-5: the turn's prompt is the same with and without the nudge`**: the request the fake server received on the third turn, and on the fourth, holds no word of `NUDGE_TEXT` and nothing about a case; with the threshold at 0 the third turn's request is byte-identical;
  - **`R-H4-5: a chat that could not be attached is marked and gets no row`**: a chat holding a stored `list_cases` result naming a case, a bridge chat (`origin: 'telegram'`), an imported chat (`source` set) and a chat whose reply has `context.recalledChats: ['b']` each get `caseNudgedAt` and no `status` row, and get none on later turns;
  - a chat with a `caseId` is never marked; a stopped turn and a failed turn do not nudge; threshold 0 does nothing.
  `tests/history-settings.test.js`: the default 40; 0 accepted; a negative number, a fraction and a string keep 40.
  Renderer (static): `renderCaseNudge` uses no `innerHTML`; the button's label; it is absent for a chat with a `caseId` or a `source`.
- [ ] **Step 2: Run** `node --test tests/history-case-nudge.test.js tests/history-settings.test.js` — expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/history-case-nudge.test.js tests/history-settings.test.js tests/history-core.test.js tests/case-chat-attach.test.js tests/renderer-history-scope.test.js tests/renderer-history-text.test.js` and the renderer test this task added — expected: `# fail 0`. `closeOpenHistoryStores()` and `await core.shutdown()` in the new file's cleanup.
- [ ] **Step 5: Commit.**

```bash
git add src/history/settings.js src/history/history-store.js src/cases/case-nudge.js src/ipc/chat-handlers.js renderer.js styles.css tests/history-case-nudge.test.js tests/history-settings.test.js
git commit -m "feat(cases): a long chat with no case is offered a case once, when it could be attached"
```

(Add the renderer test file this task created to the `git add`.)

---

## Task 17: The end-to-end check, the spec, CLAUDE.md, and the one full test run

After Task 16.

**Files:**
- Modify: `tests/e2e/history-recall.test.js` (one new test)
- Modify: `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`
- Modify: `CLAUDE.md` (History; Management surfaces; Attached mode)

- [ ] **Step 1: The e2e test.** In `tests/e2e/history-recall.test.js`, with `launchApp({ seed })` seeding two chats (the second holding "the gate code for the Lakeside lot is 4417"): through `page.evaluate`, call `window.electron.history.setLinks` and `setScope({ chatId, scope: 'linked' })` on the first chat, send "what is the gate code for the Lakeside lot", and assert the reply's `context.scope === 'linked'`, `context.recalledChats` names the second chat, and the recall line's text contains "linked chats". Run only this file: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-recall.test.js` — expected: `# fail 0`.
- [ ] **Step 2: The spec.** Status line: H4 implemented, with the date. §2: D3 and D4 as built. §3.2: the store's methods as named in Task 1; `Importer.parse(path, { pattern })`. §4.1: `chat_links` and `imports` as built. §5.2: imported chats and hosted embedders (R-H4-2, N1). §6.3: the per-chat `upToSeq`; the scope policy (R-H4-1, R-H4-2, R-H4-7); Jev skipped for a case chat or an imported chat in scope. §6.4: the cross-chat preamble and the title rule. §6.7: "Recall across chats (`linked`, `all`) is not measured: LongHaul asks inside one session. No default changed for it (owner ruling 2026-10-13)." §7: `scopeChats`, `recalledChats`, `scopePinned`, `rerankSkipped: 'imported-chat'`. §8: both tools as built, and that only the chat's own turn gets the wider scope (N2). §9: the nudge as built (R-H4-5), replacing the paragraph's sentence to the model. §10.1: the menu, the picker, the pins. §10.2: the three importers; import through pick, preview and commit; the batch channels; attached mode (R-H4-3); the CLI (R-H4-4); a second import is a second chat (R-H4-8); the warning's text. **§12 (R-H4-9):** the `src/ipc/history-handlers.js` row lists the channels that exist (`history:search`, `history:excerpts`, `history:embedder.status/save/rebuild/retry`, `history:jev.saveKey/clearKey`, `history:scope.set`, `history:links.get/set`, `history:import.pick/preview/commit/lookup/begin/append/finish`), without `history:index.status` and `history:reindex`; the service row lists `history import` only, without `history reindex` and `history status`, and names `src/service/commands/history.js`. §13: the test files as built. §14: `caseNudgeAfterUserTurns` (0 is off). §15: `ReadHistory` outside scope; the import refusals. §16: this plan's Decisions. Add a short "H4 rulings (2026-10-13)" list with R-H4-1 to R-H4-9, the residuals from "What the rulings cost", and the three new questions as open.
- [ ] **Step 3: CLAUDE.md.** Under "History", one bullet group for H4: where scope is decided (`resolveScope` and `scope-policy.js`; never read `history_scope` elsewhere); only the owner's IPC widens a scope, and only the chat's own turn uses it (`crossChat`, `historyCrossChat`); the per-chat `upToSeq`; an import goes through `import-chats.js`, never reuses a chat id and never takes chat fields from the file; no import channel takes a path; an imported chat's chunks go to the local embedder only and never to Jev; each ruling with its date and code (`CHAT_RECALLED_OTHER_CHATS`, `IMPORTED_CHAT`, `SCOPE_PINNED`, `LINK_REFUSED`); the residuals in one sentence each. Under "Management surfaces", beside Q29: the two attach refusals Task 8 added. Under "Attached mode": pick, preview and commit are local, the batch channels proxied. Under "Cases": the nudge in one bullet.
- [ ] **Step 4: The full suite, once.** `npm test` — expected: `# fail 0`. A failure in a file this plan did not touch is reported with the file's name and its first failing assertion, not fixed here.
- [ ] **Step 5: Commit.**

```bash
git add tests/e2e/history-recall.test.js docs/superpowers/specs/2026-09-25-chat-history-recall-design.md CLAUDE.md
git commit -m "docs(history): H4 as built: scope, links, importers, the case nudge; the spec and CLAUDE.md"
```

---

## Decisions

Rulings this plan makes where the spec is silent on a mechanism (policy is the owner's: the rulings table). The owner can overturn any of them.

1. **`chat_links` and `imports` have foreign keys with `ON DELETE CASCADE`** and `chat_links` a `CHECK` against a self-link (spec §4.1 gives bare columns). A deleted chat leaves no link and no import row, so a link can never name a missing chat and a deleted import can be imported again.
2. **`imports` gains `state`, `importer_version` and `message_count`.** A 12,000-record session is written in batches; `state` is what lets the next start, or the next import of the same file, remove a half-written chat.
3. **A chat's scope is not a field of the chat object.** `historyScope` is ignored by `chatToRow` and not emitted by `rowToChat`; only `setHistoryScope` writes the column. So no import, export round trip, desktop-to-service copy or `updateChat` patch can widen a scope, and every existing test that compares chat objects is unaffected.
4. **Scope is resolved on every turn and every tool call**, never stored as a list on the chat or cached.
5. **`upToSeq` gets a companion `upToSeqChatId`** rather than changing meaning, so LongHaul and every single-chat caller are untouched.
6. **The recalled block's preamble changes only when an excerpt from another chat is in it.**
7. **A chat title in an excerpt header is made one plain line**, without `"`, `[` or `]`, at most 60 characters.
8. **The excerpt drawer shows another chat's chunk only when the reply's provenance names that chat** and the chunk is not newer than the reply: chunk ids can be reused after a truncate, so an id alone proves nothing.
9. **Jev is skipped when any chat in the turn's scope has a `caseId`**, not only the asking chat. Under R-H4-1 that cannot happen; the check stays as a second line.
10. **The renderer never names an import path**, standalone or attached: the file is chosen in the main process's dialog and referred to by a short-lived token. (Spec §12 lists `history:import.preview/commit` without saying who supplies the path; `history:import.pick` is added.)
11. **An imported chat is built from a fixed list of chat keys and message keys**, in the store-level functions, so the rule is the same for a local file and for a chat that arrives over the bridge.
12. **Over the bridge an import's `source_path` is the file's base name**; locally it is the path as given (spec §4.1).
13. **A Markdown transcript is capped at 32 MB and gets synthetic timestamps** (the file's mtime plus one second per message).
14. **Desktop-to-service copies (`import --from`, the desktop's Import) do not carry scope or links in H4.** A copied chat arrives with the private default, `chat`. Its `context` provenance is copied as before, so the R-H4-1 attach rule still sees what it recalled.
15. **`history.caseNudgeAfterUserTurns` stays out of the settings pane** (H3's Decision 15: a minimal pane).
16. **`KL_TEST_IMPORT_FILE` stands in for the open-file dialog, only under `KL_TEST_MODE`** (Task 12): Playwright cannot drive a native dialog.
17. **The CLI opens the store directly, with no core** (Task 13): a core would move chats out of `chat-data.json` and start background work the command does not need.

## Not in this plan

- Subagent transcripts of Claude Code sessions (spec §16: not imported).
- `history:index.status`, `history:reindex`, `history reindex`, `history status` (R-H4-9).
- A LongHaul stage for cross-session questions (R-H4-6).
- Paginated rendering of a long imported chat (spec §1.2).
- Scanning an import for secrets (R-H4-2: the warning only).
- Any change to `UNINDEXED_TOOLS`, or to what a hosted embedder is sent for native chats.
