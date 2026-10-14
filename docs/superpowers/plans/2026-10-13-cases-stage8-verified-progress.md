# Cases Stage 8: Verified Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One implementer per task.

**Goal:** A case says how far along it is from its record, not from the model's prose. Success criteria the model added are `proposed` and count for nothing until the owner confirms them; the objective carries the same mark. Approaches the case dropped are kept and shown. Each confirmed criterion has a state only code computes (`unmet`, `met`, `stale`, `failing`). A code-computed "ready to close" list says what is open and whose it is. A `verify`-role pass at the close of a changed turn reads the turn's records and names evidence; code accepts `met` only when every cited id holds. The model proposes `done` with a pressed question; only the owner closes. Last, behind a setting that is off, a `software-repo` case can run one owner-named check command at the close of an owner turn.

**Architecture:** `brief.md` keeps `successCriteria` as a list of strings; who wrote each one lives beside it in `.kl/scope.json`, keyed by a criterion id (`sc-NNN`) and a hash of the text (`ScopeStore`). `.kl/abandoned.jsonl` is append-only. `.kl/verification.json` holds verification records, the newest opinion per criterion and a cache; a criterion's state is **recomputed on every read** by a pure function from the records, the ledger and the case-type snapshot, through evidence resolvers keyed by id prefix (`f-` facts, `chk-` check runs). `CaseRuntime` gains marks at `beginTurn`, a `verification` turn-start hook, and three guarded steps in `endTurn` (the close check, the verify pass, the cache) before the existing render, journal and commit. One new case tool, `Progress`, carries `status`, `abandoned`, `abandon`, `askScope`, `proposeDone` (and `verify` in `request` mode). Three question types (`scope-confirm` spoken; `close-proposal` and `check-approve` pressed) ride the existing question machinery. No `case.yaml` key, no MCP tool, no scope and no npm dependency is added.

**Tech Stack:** Node 24 (`node:test`, `node:crypto`, `node:child_process`), Electron 41 (renderer, the case panel and the chat cards). No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-13-cases-stage8-verified-progress.md` (a84ad14), all sections. Section 2 of the spec is the owner's rulings; they are repeated below with the tasks that carry them. Terms follow `CONTEXT.md`; this plan does not change `CONTEXT.md`.

## Owner rulings (2026-10-13)

Each row names the tasks that carry the ruling and the tests that pin it (file › test name; the tests are written by the task named).

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-C8-1 | The model may propose `done` only when every confirmed criterion is `met` (`stale` and `failing` refuse). The owner's Done button always works and shows the list first | 6, 10, 13 | `cases-progress-tool.test.js` › "proposeDone refuses for an unmet, a stale and a failing criterion", "the owner's press closes a case that is not ready"; `cases-progress-ipc.test.js` › "case:setStatus done is never refused for an open item" |
| R-C8-2 | A proposed criterion is confirmed by buttons (panel, card) and by a spoken answer with a quote. Gating needs at least one confirmed criterion; a case past gating is never sent back to `draft` | 4, 5, 10, 12, 13, 14 | `cases-brief.test.js` › "gating waits for one confirmed criterion", "a brief already gating.complete stays complete"; `cases-progress-tool.test.js` › "scope-confirm is a spoken question"; `management-tools.test.js` › "answer_question confirms scope with the owner's quote" |
| R-C8-3 | The check command: built last, off by default, approved once per exact command and repository on a pressed card, owner turns only and never in a wake-up, off in service mode until the admin enables it, at turn close only when the tree changed, capped at 120 s | 15, 16 | `cases-check.test.js` › "nothing runs while the setting is off", "a wake-up turn never runs the check", "service mode needs the admin key", "an approval covers one command and one repository", "the close run happens only when head or dirty changed", "the time limit kills the child and its grandchild" |
| R-C8-4 | The verify pass runs on every changed turn, on the `verify` role, charged to `usd`; `cases.verify.maxPassesPerDay` 24; skipped past 80 % of the `usd` budget; `cases.verify.when` may be `request` | 8, 10 | `cases-verify-judge.test.js` › "skipped when nothing was written", "skipped over the daily cap", "skipped past 80 % of usd", "charged to the case and filed under the verify role", "request mode runs only when asked" |
| R-C8-5 | `external-agent` facts alone may make a criterion `met`; provenance is shown on the row and the close card | 3, 13 | `cases-verify-status.test.js` › "an external-agent fact alone holds"; `renderer-progress-text.test.js` › "each evidence id is drawn with its provenance" |
| R-C8-6 | An open case's existing criteria and objective read `proposed` (origin `legacy`) with "Confirm all"; closed cases are untouched | 1, 4, 13 | `cases-scope.test.js` › "first contact marks every string legacy and proposed", "a done case never gets the file" |
| R-C8-7 | Frozen at close | 9 | `cases-runtime.test.js` › "progress is frozen at done and not recomputed" |
| R-C8-8 | A `brief.md` change outside the case tools is not confirmed (origin `file`, "changed outside the app") | 1, 4 | `cases-scope.test.js` › "a string with no entry after migration is file and proposed"; `cases-runtime.test.js` › "an owner edit to brief.md is proposed until pressed" |
| R-C8-9 | The verify pass sees case-tool results only | 7, 8 | `cases-verify-evidence.test.js` › "only case-tool results are kept"; `cases-verify-judge.test.js` › "prose never reaches the pass" |
| R-C8-10 | `Fail` does not write the abandoned record | 2, 11 | `cases-abandoned.test.js` › "recordFailure appends nothing"; `cases-orientation.test.js` › "a resumed case names its last failure report" |

## Task order: what is sequential and what may run in parallel

"In parallel" means in separate worktrees with **no file in common**; the groups were made from each task's file list.

| Step | Tasks | Why |
|---|---|---|
| A | **1, 2 and 3 in parallel** | Each creates new files only. 1: `src/cases/scope.js`. 2: `src/cases/abandoned.js`. 3: `src/cases/verify/store.js`, `status.js`, `evidence.js`. They agree through the shapes written in this plan, not through each other's code |
| B | **4 → 5 → 6 → 7 → 8 → 9 → 10 → 11, one after another** | 4, 6, 7, 8, 9 and 11 all edit `src/cases/case-runtime.js`; 5 and 10 need what 4 and 6 to 9 add; 10 and 11 both edit `src/cases/chat-integration.js` or read its prompt |
| C | After 11, **two streams in parallel**: (i) **12 → 13**; (ii) **14** | (i) edits `src/ipc/`, `preload.js`, then `renderer.js`, `index.html`, `styles.css`. (ii) edits only `src/mcp/case-tools.js` and its tests |
| D | **15 → 16, one after another**, after C | Both edit `src/cases/verify/check.js`; 15 also `software-repo.js`, `defaults.js`, `src/service/config.js`, the `Brief` tool and the progress IPC; 16 `case-runtime.js`, `readiness.js`, `evidence.js` |
| E | **17 → 18** | The e2e check, then the documents and the one full test run |

Nothing in steps A to C runs a program the owner did not run before. Step D adds the only code that does, and it is inert until a setting that defaults to off is turned on.

## Deviations

Where the code as built differs from a task's text. Added by each task's implementer in the task's own commit.

**Task 1 (`ScopeStore`).**

- *The hash test.* `normalizeForQuote` folds a curly quote to a straight one; it does not remove it. So "the same words with curly quotes around a word" is tested as curly against straight quotes around the word (`The "signed" contract`), not as quoted against unquoted, which are different hashes.
- *`reconcile` options.* It also takes `removedTexts` (named in the task's text but not in its signature; either the view read before the change, or a plain object of texts keyed by criterion id or by hash) and `removedBy` (who is recorded as `by` on a `removed` entry; `addedBy` when not given).
- *A new refusal code, `SCOPE_INVALID`* (fail closed, a caller's mistake and never shown to the model): an `origins` entry whose origin is not in `ORIGINS`; a `confirmed` passed with an origin that is born proposed (`model`, `detour`, `legacy`, `file`; the confirming ones are exported as `CONFIRMING_ORIGINS`); a confirmation with no `by`, at birth or in `confirm`. Nothing is written in any of the three.
- *A stored entry is not believed on its `state` alone.* An entry that says `confirmed` with no `confirmed.by` reads `proposed`; an entry with a bad id, hash, state or origin is left out, so its string reads `file` and `proposed` with a new id. `.kl/` is not guarded against `Bash`, as for the other case files.
- *`origins` apply to new strings only*, the objective included: a string that already has an entry (even a `legacy` one written at first contact) is changed only by `confirm`.
- *The objective has no `removed` history.* A reworded objective replaces the stored entry; `removed` holds criteria only (the shape of spec §7.1).
- *`limitsProblem`.* `adding` counts every criterion about to be added and `addingProposed` how many of those are born proposed (so one proposal is `{ adding: 1, addingProposed: 1 }`; `{ addingProposed: 1 }` alone reads the same). The proposed limit is checked only when a proposal is being added.
- *Shapes, a little wider than written.* The view's objective row also has `at` and `provisional`; a `duplicates` entry is `{ text, hash }`; `confirm` returns the file as written.

**Task 2 (`AbandonedStore`).**

- *"Different case and spacing"* is tested as different case and spaces around the text. Two spaces in a row inside an `approach` are not one plain line (`plainLineProblem`), so that text is refused `ABANDON_INVALID` before the duplicate check, not folded.
- *Step 2's "the leak test passes already"* does not hold as written: the new leak test writes case B's record through `AbandonedStore`, so it failed on the missing module until Step 3, and passed with no change to `index-store.js`.
- *`decisions`* may be a list of records or ids, a `Set`, a `Map`, or what `CaseRecords.decisions()` really returns (`{ entries, errors }`, not a list). Ids that cannot be checked (no `facts`, no `decisions` passed) are refused `ABANDON_INVALID`.
- *`withdraw` needs a `why`* (one plain line, 5 to 300 characters) and returns the record as it now reads.
- *A line counts as malformed* when it is not JSON, has an unknown `kind`, is an `abandon` with a bad id, no `approach` or no `why`, repeats an id, or is a `withdraw` of an id that is not there or is already withdrawn. Lengths are not re-checked on read. A new id is one past the highest id any line used, malformed or not.
- *`abandonedLines`* lists newest first; it takes the store's records (oldest first) and leaves withdrawn ones out itself. A line shows at most 110 characters of the approach, 130 of the reason and the first three fact ids; the 1,500 characters include the count line. Stored text that is not one plain line shows as `(text hidden: not one plain line)`.

**Task 3 (verification records, resolvers, state).**

- *A record that cites no evidence is `stale`, never `met`* (reason `the record cites no evidence`); the task's rule 4 would read "all hold" as true for an empty list. `addRecord` also refuses to write one (it throws, as it does with no criterion or hash). A `resolve` that is missing, throws, or answers anything but `holds === true` does not hold.
- *The newest record* for a criterion and hash is the one with the highest `v-` number, not the last in the list.
- *Reasons and labels are ids and fixed words only.* The `f-` resolver gives a label for every id that does not hold (`f-0099 is not in the ledger`, `f-0042 is inferred`, `f-0043 is an open unknown`, `f-0042 is under the open load-bearing unknown f-0050`); the subject and attribute of a fact are never in one. An id with no resolver gets exactly `{ exists: false, holds: false, reason: 'evidence-missing' }` and reads `<id> is not in the record`. A resolver that throws is logged and treated the same.
- *Shapes, a little wider than written.* A resolved `f-` id also carries `source` and `sourceKind`. An evidence row in `computeCriterionState` and `progressView` is `{ id, holds, reason, provenance, sourceKind, label }`. A `progressView` row also has `hash` (what a Confirm button must send), `recordId` (the regression trigger's key needs it) and `note` (the record's). An opinion is shown only on a confirmed row.
- *`registerEvidenceResolver` and `registerEvidenceSource`* replace an earlier registration of the same prefix or name and return a function that puts the earlier one back (for tests). A prefix is letters and one dash.
- *`summaryLine`* lists `failing` before `stale` (their precedence), leaves out every zero count but the first part, and counts as open every readiness item that is neither `ok` nor `n/a` (so `unknown` counts), which is the same rule as `ready`.
- *`VerificationStore`*: `markDisagreed` returns the record or `null` and never overwrites an earlier mark; `setCache` returns whether it wrote, and compares states whatever their key order; a part of the file that is missing or of the wrong kind reads as empty, and a new id is one past the highest in the file.

**Task 4 (the runtime keeps the scope record).**

- *`objectiveBy` has a third value, `'detour'`.* `createCase` writes the objective's entry itself, and an entry that exists is never given another origin (Task 1), so the router cannot record `detour` afterwards "in the same block". The router passes `objectiveBy: 'detour'` and `createCase` records origin `detour`, proposed. Only `'owner'` confirms; any other value is origin `model`, proposed. No tool passes the option.
- *`writeScope` returns `{ view, added, removed }`* (the rows this call added and removed), and also takes `removedBy` and `alsoConfirm` (hashes of strings that are already there, which `confirmed` confirms too). It does not check that the lock is held: playbook gating's `syncGating` may run without one today, as its `brief.append` did. It refuses before `brief.md` is touched: a field other than the two, a list that is not non-empty strings (`SCOPE_INVALID`), the same words twice in one list (`CRITERION_DUPLICATE`), an origin that may not be born confirmed, and the limits. It does not validate a criterion's text as one plain line: the `Brief` tool (Task 5) and `applyScopeAction` do, and a detour summary or a gating answer is written as it was before.
- *A new refusal code, `CASE_CLOSED`.* `writeScope` and `applyScopeAction` refuse a `done` or `abandoned` case and write nothing (R-C8-6: closed cases are untouched).
- *An objective the owner states in the words that are already there* is confirmed in place (`ScopeStore.confirm`); its origin stays what it was.
- *A gating answer that repeats a criterion already in the list* confirms that row (`alsoConfirm`) and adds no second string; before, the brief got the string twice.
- *`applyScopeAction`.*
  - `all-proposed` covers every proposed criterion, each of which must be in `hash` with the hash shown (`SCOPE_STALE` otherwise, and nothing is confirmed). The objective is confirmed with them only when `hash.objective` is given: a caller that did not show it does not confirm it.
  - `drop` of `'objective'` is refused (`SCOPE_INVALID`): an objective is rewritten, never dropped. `drop` of `all-proposed` drops the proposed criteria only.
  - `edit` takes `hash` as optional and checks it when given. An edited criterion is a new entry with a new id (the old one moves to `removed`), confirmed, origin `owner-action`; an edit that leaves the folded words the same confirms the entry in place. `add` ignores `target`.
  - `by` is required (`SCOPE_INVALID` without it), as is an `action` among the four.
  - The journal entry is written inside the same `systemAction`, only when something changed, and holds ids only (`Scope: confirmed sc-001, objective (by owner-action, in-app).`).
- *`Brief.completeGating` on a brief that is already complete* does not apply the scope rule and rewrites nothing (so `completedAt` stays); `missingForGating({ scopeView })` still reports `successCriteria` there until one criterion is confirmed. A scope view that could not be read (`{ error }`) has no confirmed criterion.
- *`scopeView` and the `beginTurn` reconcile read `brief.md` with a plain `Brief`*, not `runtime.brief(id)`: the latter loads the playbook packages for the case type's fields, outside the turn start's one shared load.
- *The `Brief` tool between this task and Task 5* still writes through `Brief.append`, so a criterion it adds has no entry and reads `file`, proposed, until Task 5 routes it through `writeScope`.
- *Existing tests changed.* The model's criterion no longer satisfies gating (R-C8-2), so every fixture that set `successCriteria` with `provenance: 'model'` and then called `completeGating` now calls `confirmAll(runtime, id)` (`tests/helpers/case-scope.js`: the owner's "Confirm all", written through `ScopeStore`) first: `tests/helpers/executor-fixtures.js`, `tests/cases-abandoned.test.js`, `cases-detour-classifier`, `cases-detour-hooks`, `cases-detour-ipc`, `cases-detour-router`, `cases-detour-tool`, `cases-ipc`, `cases-questions`, `cases-regressions`, `cases-runtime-index`, `cases-runtime-unattended`, `cases-turn-runner`, `management-tools`, `playbooks-gating`, `playbooks-ipc`, `playbooks-manager`, `playbooks-runtime`, `playbooks-tool`. Three tests asserted the old rule and now assert the new one before confirming: `cases-runtime.test.js` › "completes gating and moves the case from draft to active", `cases-runtime-index.test.js` › "completeGating waits for repo on a software-repo case" (the message now names `successCriteria` too), `cases-tools.test.js` › "Brief reads, refuses owner-only fields from the model, journals updates and completes gating".

**Task 5 (the `Brief` tool's scope rules).**

- *Results, a little wider than written.* A list `update` returns `{ ok, brief, criteria: [{ id, state }] (the rows it added), removed: [ids] }`, with the proposal note when a row it added is proposed. An objective `update` returns `{ ok, brief, objective: { state } }` and, when proposed, `note: 'Proposed. The owner has not confirmed this objective.'`. Its journal line is `Brief objective updated (proposed)` or `(confirmed, quote: "…")`; a list update's is `Brief successCriteria updated (proposed, sc-003; removed sc-002)`.
- *A string that is already in the list keeps its stored words.* A list `update` compares by hash, so `SIGNED contract…` for a row stored as `Signed contract…` is that row and the brief keeps the stored text; the model cannot re-case a confirmed criterion.
- *A quote confirms only what the call adds.* `append` of words that are already a criterion is `CRITERION_DUPLICATE` with or without a quote, and a list `update` with a quote leaves a proposal that was already there proposed. The owner's words confirm an existing proposal through the scope question or the panel. The objective is the one exception (Task 4): the owner's quote of the words that are already there confirms it in place.
- *`CRITERION_CONFIRMED` names every confirmed row the new list leaves out* (`sc-001, sc-002 were confirmed by the owner. Only the owner changes or drops them; ask.`).
- *A model `update` of a confirmed objective with the same folded words* is answered `ok` and writes nothing; any other text is `OBJECTIVE_CONFIRMED`. `append` on `objective` is refused as before (`"objective" is not a list field.`).
- *`Brief` `read`* passes the scope view, so its `missingForGating` lists `successCriteria` until a criterion is confirmed.
- *The confirmation's `channel` is always `in-app-chat`*, as the task says; only a chat with owner messages can pass the quote check.
- *An existing test changed* (R-C8-2 and spec §10): `cases-tools.test.js` › "Brief reads, refuses owner-only fields from the model, journals updates and completes gating" appended a criterion with no quote and completed gating; it now asserts that this is refused and completes gating with a criterion appended from the owner's quoted words.

**Task 6 (ready to close).**

- *`pendingProposals` was not moved.* `src/cases/` may not require `src/mcp/`, so `readiness.js` reads the same records the same way (`listRecords` from `src/cases/ingest/files.js`, a proposal with no `review` object counts), and `src/mcp/case-tools.js` is unchanged.
- *An item also has `note`* (`null`, or fixed words and a count): `branch-merged` uses it for `2 other open PRs are not counted.`, on an `ok` item too. `ITEM_IDS` (the twelve ids, in the spec's order) is exported.
- *`criteria-met` is `n/a` when no criterion is confirmed* (the spec's "every confirmed criterion is met" would read as `ok` for none); `criteria-confirmed` is the open item then.
- *Ids in a `fix` come from file names and the stores' own patterns*, never from what a file says of itself: a job's and an envelope's id is its file name; a criterion, fact, question, detour and plan id is shown only when it matches its pattern, and a PR number only when it is a positive integer. When one cannot be shown the line gives the count instead (`2 PRs from this branch are still open.`).
- *Fail closed on what cannot be read.* A job file that is not an object, or whose `state` is not a terminal one, is open. An envelope is closed only in a status the store knows other than `requested` and `active`; anything else counts as active. A `plan.json` that is not an object is `unknown`; a plan that is not settled with no unfinished step reads `Case: the plan is not settled.` Jobs are read with `JobStore` from the case's files, with or without an executor registry.
- *More fixed wordings than the spec's table*: no objective at all (`Owner: give the case an objective in the case panel.`), no criterion at all (`Owner: add or confirm a success criterion in the case panel.`), a requested envelope (`env-07 waits for your approval. Approve or reject it.`), a detour with no routing question yet (`Owner: 1 detour waits to be routed (d-0002).`), an unknown repository state (`The repository state is not known yet. It is read at the start of a turn.`), and an item whose read threw (`King Louie could not read this; the log says why.`).
- *`detours-settled`* counts detours in `proposed`, `held` and `awaiting-mapping`, and a `pending:` blocker in `related` that no such detour accounts for; a detour list that reports an error is `unknown`.
- *`tree-clean` and `branch-merged`* are also `unknown` when `dirty` is not a number, and when the snapshot has no branch (nothing to match a PR's head against).
- *`CaseRuntime.progressView(id, { scope, file })`* is the computed view on its own (what `closeReadiness` reads when no view is handed in). `progress` of a closed case with a frozen record returns `{ scope: null, view: null, readiness: null, summary: <the frozen one>, abandoned, closed: { …, frozen: true } }`; a closed case with no frozen record (closed before this stage) has `closed: null` and the view computed from what is there.

**Task 7 (what a turn wrote).**

- *`turn.marks` is a little wider than written.* It also has `jobs` (`{ <job id>: <recorded results> }`; the sum alone cannot say which job grew) and `states` (each confirmed criterion's computed state when the turn began, `null` when it could not be computed or the case is closed), which Task 8's block reads to name a criterion that left `met` during the turn. `turnMarks(runtime, caseId)` and `statesOf(view)` are exported from `evidence.js`. Marks that cannot be taken are `null` and never fail `beginTurn`; a turn with no marks finds only the facts that carry its id, and no decision.
- *Jobs are read with `JobStore` from the case's files*, with or without an executor registry (as Task 6 reads them), so `jobRecords` is not forced to 0 when the host has no registry.
- *`CaseRecords.decisions()` returns a list* (the note under Task 2 says `{ entries, errors }`; that is `readJsonl` in `jsonl.js`, which `records.js` unwraps). `marks.decisions` is its length, as this task says.
- *`postExecute` already carries the call's `parameters`*, so the row's `action` is read there and no `preExecute` is matched.
- *`toolResultRow`.* `ok` is `result.ok === true`; `action` is `parameters.action` on one line, at most 40 characters, else `null`; a result that cannot be made JSON reads `(result could not be read)`. The 4,000 characters are kept by cutting the row that crosses the limit and dropping the rows after it.
- *An evidence source is called `fn(runtime, turn, { facts, decisions })`*: the third argument is what the collector already found this turn (the executor-results source needs the facts). Every row is reduced to `{ kind, id, text, refs }` (40, 40 and 200 characters, `refs` strings only); a row with no `kind` or `id` is dropped; a source that throws is logged and skipped. A job row's `refs` are the facts found this turn whose source is under `sources/<executor>/<job id>/`.
- *`changed` is exactly the three lists.* A turn that only retracted a fact, or whose only new rows came from an extra source, is not `changed`, so no pass runs for it; the states are recomputed on read all the same.
- *The close steps run only when `verify` is passed*; `endTurn` ignores a `block` that is not a non-empty string.
- *Tests.* The harness of `tests/cases-chat.test.js` gained `toolEvents` (what the executor emits while the loop runs) and keeps the executor's listeners; no assertion of an existing test changed.

**Task 8 (the verify pass).**

- *The call offers one tool, `Read`, and runs none.* The task and spec §6.5 say "the tool-taking path, with no tools". The router (`InferenceRouter#executeTarget`) calls a provider's `sendMessageWithTools` only when the tool list is not empty; with `[]` it calls `sendMessage`, which reports no usage, so the pass would never be charged. The pass does what orient and classify already do (`turn-runner.js`, `detours/classifier.js`): one fixed tool definition from `host.toolRegistry` (`VERIFY_TOOLS`), no executor. A reply that calls it has no text and is "no usable verdict". With no tool registry (some tests) the list is empty.
- *An id that holds but was not shown to the model is not evidence* (new reason `evidence-not-shown`, label `f-0007 was not among the records shown`). The prompt says never to cite an id that is not listed; code now holds it to that, so a fact cut from the input by `maxInputChars` cannot be cited. `composeVerifyInput` returns `{ text, shown }`; `buildVerifyInput` is its `text`. The reasons of the spec's table come first: an id that does not hold keeps its own reason.
- *What the input looks like.* One row per line inside one `<untrusted-case-records id="…">` fence (a fresh id per call). Every text of the case (a criterion, a statement, a subject, a source ref, a decision, a tool result) is put on one line, cut (300 characters; a tool result 1,000) and written as a JSON string, so it cannot end its row or start another; a fence line inside it is defused by `fence`. Facts are rows only for provenance `user`, `sourced` and `external-agent`; this turn's are listed first with their status, then the other active ones newest first. Rows that do not fit are left out from the end and counted in one last line; `maxChars` under 600 reads as 600.
- *The reply.* Besides the task's list, the whole reply is dropped for a top-level key other than `criteria`, an evidence entry that is not an id (a short prefix, a dash and digits, nothing after), or a `note` that is not text. A row may leave out `evidence` (read as none) and `note`; other keys of a row are ignored; an evidence id given twice counts once. A note that is not one plain line is dropped, not the reply.
- *`acceptVerdict`.* A rejected entry is `{ id, reason, label }` (the label is ids and fixed words, for the journal line; the stored opinion keeps `{ id, reason }`). A row that is not the confirmed row of the verdict is refused (`criterion-not-confirmed`). A resolver that throws or answers anything but `holds === true` does not hold.
- *`runVerifyPass`.*
  - Skip reasons by name: `off`, `on-request`, `stopped`, `shutdown` (the runtime is closing, any turn), `nothing-written`, `case-not-open`, `no-confirmed-criterion`, `daily-cap`, `usd-budget`, checked in that order.
  - The pass is counted before the call, so a provider that fails every time is bounded by `maxPassesPerDay` too.
  - After the call nothing is written when the turn no longer owns the case (shutdown released it), its signal is aborted, or the runtime is closing: the result is `error: 'the turn was stopped'`. Usage the reply reported is charged all the same, before that check is applied, so a budget pause caused by this call does not discard its verdicts (spec §13). A call that settles after the time limit is not charged.
  - Every check is made against the record as it is after the call (an answer can be applied inline while the model thinks). A criterion whose hash changed meanwhile is skipped (`criterion-changed`).
  - A `met` that code accepts for a criterion that is already `met` on the same evidence writes no new record. Only a `met` that was not accepted is returned in `opinions`; an `unmet` opinion is stored and not returned.
  - The result also has `note`: the one line said for a skip over the daily cap or the budget, set the first time that reason is met on a day. `VerificationStore` gained `noteSkip(day, reason)` for it; the file has a `skipNoted` key only after one was noted.
  - The record's `model` is `<provider>:<model>` from the reply's metrics, else the routed target.
- *`_closeProgress`.* "Before" is the states taken when the turn began (`turn.marks.states`, Task 7), not the states just before the pass, so a criterion whose fact the turn itself superseded or retracted is named in the block. Nothing is computed for a case that is closed, or that closed during the pass.
- *The block's wording* (ids, counts and fixed words only; never a criterion's text or the verify model's note): `- Now stale: sc-001 (f-0001 was superseded by f-0002).` first, then `- Now met: sc-002 (f-0003).`, then one of `- Verify pass: 1 accepted, 1 not accepted (sc-002: f-0999 is not in the ledger).`, `- Verify pass: 1 accepted.`, `- Verify pass: no usable verdict (timed out after 20 s).`, `- Verify pass: not run (the limit of 24 passes a day is used).`, and `- Verify pass: no longer agrees that sc-001 is met.` A pass that ran and changed nothing says nothing. The `check` parameter is taken and not used until Task 16.
- *Settings.* `skipAboveUsdPercent` is a number above 0 and at most 100; `maxPassesPerDay`, `timeoutMs` and `maxInputChars` are positive integers; anything else reads as the default. To turn the pass off, set `when: 'off'`.
- *What the owner waits for.* The send path awaits `endTurn` before it stores the reply and sends `chat:messageComplete`, as it did for the commit; the pass adds up to `timeoutMs` (20 s) to that on a turn that wrote to the record. The case lock is held across the call, as it is across every model call of the turn.
- *Tests.* `tests/cases-verify-store.test.js` gained the `noteSkip` test and `tests/cases-turn-runner.test.js` three wake-up tests (verified and charged; a failing verify call; shutdown during the call). No existing test changed.

**Task 9 (regressions and the freeze).**

- *The hook reads `runtime.progressView(caseId, { file })`*, not `runtime.progress(caseId).view`: the ready-to-close list is not needed to compare states, and it reads many more files. It does nothing for a closed case. A case with no confirmed criterion and no cache gets no file from it (equal states write nothing).
- *The note and the trigger give every reason of the row*, joined with `; ` (`sc-002 was met and is now stale: f-0033 was superseded by f-0060; f-0041 was retracted.`). A criterion's text in the trigger's `detail` is at most 80 characters in quotes; text that is not one plain line reads `(text hidden: not one plain line)`.
- *The trigger is raised in one turn.* As the task and spec §6.3 say, the hook writes the new cache in the turn that raised the trigger. A turn that ends without `Reorient` therefore does not meet the trigger again at the next turn start; the criterion still reads `stale` everywhere it is shown. Raising it until it is acknowledged would be a change to the spec and is left for the owner.
- *The cache is written at a close only when the close is verified* (the normal exit of an owner turn, a wake-up that acted), after the block that says what changed. The task says `_closeProgress` ends with `setCache`, and spec §6.9 lists it as a step of every close. A stopped, blocked or failed turn gets no block, so writing the cache there would hide a criterion that left `met` during that turn from both the journal and the next turn's hook; left alone, the next turn start raises the trigger. A turn that no longer owns the case, or a case that closed during the pass, writes no cache either.
- *The freeze.* `setStatus` reads `progress(id)` while the case is still open (the list a close is judged by is the list before the close) and writes the frozen record after `updateMeta`. `freezeProgress(runtime, id, { status, progress })` takes that reading. A read or a write that fails is logged and nothing is frozen: the case then reads as one closed before progress was tracked (`closed: null`, the view computed). Moving between `done` and `abandoned` (no transition allows it today) would not freeze again. A reopened case keeps its old `closed` record in the file, unread while it is open, and is frozen anew at its next close.
- *Tests.* No existing test changed; the hand-made freeze of `tests/cases-verify-readiness.test.js` is replaced by the real one at `setStatus` and its assertions hold.

**Task 10 (the `Progress` tool and its questions).**

- *Status rules.* `Progress.abandon`, `askScope` and `verify` are in no list: the allowlists of `paused`, `done` and `abandoned` refuse them, and the denylists of `draft`, `active` and `needs-direction` let them through, which is the spec's table. `verify` has no row there; it runs wherever writing does and the pass's own skips (`case-not-open`, `no-confirmed-criterion`) do the rest. An `action` outside the six is refused by result.
- *The model's note.* A plain note over 300 characters is refused `QUESTION_TOO_LONG` (it is never cut and never hidden for its length); a note that is not one plain line is shown as `(text hidden: not one plain line)`. The task's "at most 300 characters, else hidden" and its test "a note of 3,000 characters refuses" cannot both hold; this is the reading that fails closed.
- *The cards' wording.* Both start `Case: <title>` (the title through the plain-line rule), as the task says, not last as on an envelope card. The scope card's second line is `Confirm these success criteria? They count for nothing until you confirm them.` (or `… and the objective? …`, or `Confirm the objective? You have not confirmed it yet.`): it does not say who proposed them, because a `legacy` or `file` row was not proposed by the case. With a proposed objective a host line says `"Drop all" leaves the objective as it is; edit it in the case panel.` Then `1. sc-002: <text>` per proposed row and `Objective: <text>`. The close card is the title, `The case proposes to close as done.`, the summary line, one `fix` line per open item, and the note.
- *`askScope` writes nothing but the question.* It reads `scopeView` (no reconcile); the entries are bound by hash, and the answer's `applyScopeAction` reconciles under the lock (Decision 3). A scope that cannot be read is refused with no code.
- *The scope answer is applied entry by entry.* `applyScopeAction`'s `all-proposed` refuses unless every proposed row is in the hash map, so a row proposed after the question was asked would stop the whole answer. The handler calls `confirm` (or `drop`) once per payload entry whose hash still matches; each writes its own one-line `scope` journal entry. An entry whose words changed, or that is gone, is skipped and named in one note on the question (`Not applied to sc-003: the words changed after this was asked. Confirm or drop what is there now in the case panel.`). A row the owner confirmed meanwhile is never dropped by a later "Drop all" (noted). "Drop all" never drops the objective (noted). The handler's effect is `{ applied: 'scope', confirmed, dropped, skipped }`.
- *The answers' facts name the question by id and kind*, not by its text (`Owner answered q-0003 (scope): Confirm all`, subject `scope`; `… (close proposal): Mark done`, subject `close-proposal`): the default wording quotes the first 80 characters of the question, which here holds the title and, for a scope question, criteria the model wrote.
- *The close answer.* `keep` records the fingerprint from any channel (declining grants nothing). `done` from a channel that is not a press leaves the question answered and the case open, with a note; the model may propose again. A free-text answer, or a `setStatus` that refuses (the case was closed meanwhile), is noted and applies nothing. The status note's open items are the list's item ids and refs (`criteria-met (sc-001)`), `none`, or `not known` when the list could not be read.
- *`abandon`.* The write runs in `systemAction` (inline in a turn), so the record and its journal entry are written under the case lock even when no turn is registered. The journal entry's first line holds ids only (`Abandoned approach ab-0001 recorded (facts f-0017; decisions D-002).`, `… ab-0001 withdrawn.`): the cross-case index reads the first line of every journal entry, and a redacted hit still answers a two-word probe. The approach, the reason and what was tried follow below it. `abandoned` returns `{ records, unreadableLines? }` as untrusted output.
- *`status`* returns rows of `{ id, text, scope, origin, state, evidence: [{ id, holds, provenance, label }], reasons, opinion }` and `readiness: { ready, items }`. For a closed case with a frozen record it returns that record (`frozen: true`, `at`, `status`, `objective: null`).
- *`verify` and the request-mode pass in `proposeDone`* need this turn (`runtime.turns` holds a turn with the context's id); without one `verify` is refused and `proposeDone` goes on without the pass (it has already been refused by `requireReoriented` when no turn is registered at all). `verify` returns counts only: `{ ran, skipped, accepted, notAccepted, disagreed, problem?, note?, summary }`.
- *`NOT_READY`'s `open`* is every item of the list that is neither `ok` nor `n/a` (so `unknown` too), in the item shape of `status`.
- *The `failing` case of "proposeDone refuses…"* stubs `runtime.progressView` to give the row the state: no check run exists before Task 16, which should replace the stub with a real failing run.
- *Tests.* Existing tests changed, each for a list this task extends: `tests/cases-tools.test.js` › "registers Reorient, Ask and Fail with the other case tools, none needing approval" (the exact `CASE_TOOL_NAMES` list gains `Progress`); `tests/cases-status.test.js` › "exposes the allowlists and denylists the spec names" (`READ_OPS` gains the two read ops, `DENIED.draft` gains `Progress.proposeDone`, and `DENIED['needs-direction']` is now asserted too). No assertion was loosened.

**Task 11 (the orientation).**

- *`progress` is what `CaseRuntime.progress` returns* (`{ view, readiness, summary, closed }`), not the view alone: the section needs the summary line, the list and, for a closed case, the frozen record. `abandoned` is the store's records or what `AbandonedStore.list()` returns (`{ records, errors }`); `lastFailure` is `{ file }`. With none of the three the output is byte for byte what it was (pinned by a snapshot taken before the change).
- *A third objective mark.* A proposed objective of origin `legacy` reads ` (from before progress was tracked; the owner has not confirmed it)`: "proposed by the model" would be a guess for a case that predates the record. `file` and every other origin read as the task says.
- *The brief's criteria line* is the counts (`3 confirmed, 2 proposed; see Progress`) whenever there is a view, `—` when the view has no criterion, and the list as before when there is no view (no `progress`, or one that could not be computed).
- *The `Ready to close:` line.* `Ready to close: yes.` or `Ready to close: no. Owner: … Case: … Either: …`: the spec's example has no item whose `by` is `either` (`unknowns-resolved`, `tree-clean`, `branch-merged`), so those get a third group. An item shows at most five refs, then `… N more`; an `unknown` item with no refs reads `tree-clean (not known)`. Item ids, criterion ids, evidence ids and refs are shown only when they match their patterns (a criterion id that does not reads `sc-???`).
- *A row's detail.* `met` gives the cited ids (`(evidence f-0042, f-0051)`); `stale` and `failing` the first reason, one line of at most 160 characters; `unmet` and a proposed row nothing.
- *A criterion's text is folded to one line, not hidden for a line break* (the task's test asks for one cut line): white space runs become one space and the text is cut at 160 characters with `…`. What is still not one plain line after that (a hidden or bidi character) reads `(text hidden: not one plain line)`.
- *Costs one line.* A `progress` read that throws gives the heading and `- Progress could not be computed; the log says why.`; an abandoned read that throws gives the section with `- The abandoned approaches could not be read; the log says why.`; malformed lines of `abandoned.jsonl` give `- 2 lines of the abandoned record could not be read and are not shown.` (spec §13).
- *The cap.* The 2,500 characters hold the heading, the summary line and the `Ready to close:` line; criteria rows fill what is left, in order. The 1,500 characters of the abandoned section are `abandonedLines`' own (Task 2); the host lines after them (the skipped-lines warning, the failure report) are on top.
- *A frozen case with no date in its record* reads `— as of its close`.
- *`lastFailure` is given only when it can be checked.* The runtime derives it while `statusReason.kind` is `direction`, from the direction fact `statusReason.ref` names: its `attr` must have the shape of a failure report's journal name (`2026-10-08-1405-failure`) and `journal/<attr>.md` must be in the case. A direction recorded from chat through the `Ledger` tool has an `attr` the model chose, so it usually names no report and the line is left out; the builder checks the shape again.
- *The prompt.* The orientation, and so both new sections, are in the dynamic part of the system prompt (`buildCaseSystemPrompt` → `systemPromptDynamic`) in owner turns and wake-ups, as before; nothing was added to the cached part. `get_orientation` returns the same text inside its untrusted wrapper.
- *Tests.* No existing test changed.

**Task 12 (IPC for progress and scope).**

- *The reply, a little wider than written.* `case:progress` also has `caseStatus` (the panel must tell a `done` case with no frozen record from an open one), `at` (when a frozen record was written, else `null`) and, when `brief.md` could not be read, `warning`. A criterion row is `{ id, text, hash, scope, origin, state, evidence, reasons, note, opinion }`: `hash` is what a button sends back. The objective is `{ text, hash, state, origin }`. An abandoned record is `{ id, approach, why, tried, factIds, decisionIds, at }`.
- *`case:confirmScope` checks that the event is a local desktop event* (`isLocalDesktopEvent`, refused `NOT_LOCAL_DESKTOP`). The standalone host and the bridge dispatcher mark every event, so this changes nothing a window can do; the older pressed handlers (`case:answerQuestion`, `case:setStatus`, `case:grantBudget`) rely on that marking alone and have no check of their own. Tests of the new handlers pass a marked event.
- *More is refused before the runtime is called* than the task lists: `drop` of the objective, `edit` of `all-proposed`, a `hash` that is not text (for `all-proposed`: not an object of `sc-` ids or `objective` to text), a missing `text` for `edit` and `add`. These have no code. `by`, `channel`, `quote`, `factId` and anything else in the payload are never read; the preload sends the five named fields only.
- *An objective the owner rewrites* is trimmed and held to 2,000 characters (the limit `create_case` gives one), refused `CRITERION_INVALID`. It is not held to one plain line: no path that sets an objective has that rule, and the cards already hide a text that is not one.
- *Refusal codes.* `CASE_BUSY` is returned as a `code` beside the existing busy message; `CASE_CLOSED` and `SCOPE_INVALID` come back with their codes too.
- *`case:setStatus`'s `progress`* is `null` when the progress could not be read; the status is set all the same.
- *Tests.* `tests/cases-ipc.test.js` gained one test (the two channels are named and registered); no existing test changed.

## New questions

Found while writing the tasks out. None is decided here; each step named is written the conservative way and stays so until the owner rules.

| # | Question | What the plan does meanwhile (fail closed) |
|---|---|---|
| N1 | On Windows, may the check be a program that exists only as a `.cmd` or `.bat` shim (`pnpm`, `yarn`, `gradlew.bat`)? Starting one needs `cmd.exe`, and the project's own rule for runbooks is never to (`doctor`: "call the .exe"). | Task 15 refuses every shim (`CHECK_SHIM`) except `npm`, which Task 16 runs as `node.exe` with `npm-cli.js` and no shell. Nothing goes through `cmd.exe` |
| N2 | With `cases.verify.when: 'request'`, should the owner have a "Check now" button in the panel? R-C8-4 allows the setting and does not say who may ask. | Task 10 gives the model `Progress.verify` in that mode, and `proposeDone` runs the pass first. No owner button is built |
| N3 | Should the case-create form gain an objective field? Today the renderer sends none, so a desktop case's first objective is the model's and reads `proposed`. | Nothing is added to the create form. Task 13 gives the panel Confirm and Edit for the objective, which is the owner's path |

## Global Constraints

- Tests run with node's built-in runner, never `jest`: `node --test tests/<file>.test.js`; look for `# fail 0`. Each task runs only the test files its steps list. **The full `npm test` runs once, in Task 18, by the controller.**
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` covers every new file.
- Log through `createLogger` from `src/logging.js`; no bare `console.*` in `src/`.
- No network and no model in unit tests. A runtime is `new CaseRuntime({ root: <temp dir>, now })` (`git` must be on PATH; follow the temp-dir pattern at the top of `tests/cases-tools.test.js`). A scripted provider is a `host.inferenceRouter` stub as in `tests/cases-turn-runner.test.js` (`harness()`), with models from `tests/helpers/profile-settings.js`. A test that builds a core calls `closeOpenHistoryStores()` (`tests/helpers/close-history-stores.js`) before removing its data dir and `await core.shutdown()`.
- A test that awaits a timeout keeps a ref'd `setTimeout` alive across the await (see `CLAUDE.md`, Testing). Every child process a test starts is awaited before the test ends.
- Open source: invented values only (`Lakeside lot`, `example.com`, `+15550100`, `f-0042`); no personal names, paths or domains in fixtures, tests or docs.
- **`brief.md` and `case.yaml` keep their shapes.** `successCriteria` stays a list of strings; no front-matter key and no `case.yaml` key is added. `CASE_YAML_KEYS` and `tests/cases-store-yaml.test.js` do not change. If a task finds it needs a `case.yaml` key, it stops and reports.
- **No tool sets a state.** A verification record is written only by `acceptVerdict` (Task 8). No `Progress` action, IPC or MCP tool writes one, and `TRANSITIONS` in `src/cases/status.js` gains no `runtime` row into `done`.
- **A press is `in-app` or `mobile`.** `in-app-chat` and every `mcp-*` channel are never proof of a press.
- New `.kl/` files are written only by code, inside a turn or a `systemAction`. Reads outside the lock never write.
- Renderer: every string that comes from a case (criterion text, objective, an abandoned record, a verify note, a fix line) is set with `textContent`, never `innerHTML` or markdown. IPC replies that carry such text have `untrustedText: true`.
- Host-built question text puts host lines first and model text last and labelled; text that is not one plain line (`plainLineProblem`, `src/cases/hidden-chars.js`) is shown as `(text hidden: not one plain line)`; a card over 2,000 characters is refused (`QUESTION_TOO_LONG`), never cut.
- The cached part of the system prompt does not change per case: `Progress`'s description and the three prompt lines are static strings.
- Anchors in this plan are quoted names, not line numbers; find them with a search.
- Commit after each task with the message its last step gives, ending with the attribution line the session's instructions give.

## Review Focus

1. **The model marks its own work done.** A `Brief` append with `provenance: "user"` and no quote; a quote of "yes" for a criterion it wrote; a list `update` that drops an unmet confirmed criterion; a `Progress` call with extra parameters (`state`, `status`, `force`). Expected: proposed, refused (`SCOPE_NOT_IN_QUOTE`), refused (`CRITERION_CONFIRMED`), ignored. Pinned: Tasks 5, 10.
2. **`met` rests on something real.** The verify reply cites an id that does not exist, is superseded, is `inferred`, is an open unknown, sits under a load-bearing unknown, or is a check at another head. Expected: an opinion, never a state. Pinned: Tasks 3, 8.
3. **The assistant's prose never reaches the pass.** Expected: the input is built from the record and the turn's case-tool results; the journal text and the reply are not in it. Pinned: Tasks 7, 8.
4. **A stored status is never believed.** Expected: `cache.states` written as `met` by hand changes nothing a reader sees. Pinned: Task 3.
5. **Closing is the owner's.** `close-proposal` answered `done` over `in-app-chat`, `mcp-stdio`, `mcp-frontdoor` or a contact channel. Expected: not applied. Pinned: Tasks 10, 14.
6. **Existing cases read as before.** A case fixture written before this stage is byte-identical after a read; its first locked write adds only `.kl/scope.json`. A `done` case gets no file. Pinned: Tasks 1, 4.
7. **A failing pass never fails a turn.** A timeout, a provider error, a malformed reply, a throw inside the pass or the close check. Expected: the turn commits and releases its lock. Pinned: Tasks 7, 8, 16.
8. **The check command** (Tasks 15, 16): off by default; never in a wake-up; never through a shell or `cmd.exe`; the argv that runs is the argv that was approved; the child sees no provider key; a timeout kills the tree; the output is in no tracked file.
9. **Nothing private crosses cases.** An abandoned record or a criterion of case B in any hit returned to case A. Pinned: Task 2 (and the existing `tests/cases-leaks.test.js`).

---

## What exists on `main` (a6189a7), read from the code

Nothing below is rebuilt by a task.

- **Brief:** `src/cases/brief.js`: `Brief` (`read`, `update`, `append`, `missingForGating`, `completeGating`, `isUserOnly`, `writeBody`), `USER_ONLY_FIELDS` (not `successCriteria`, not `objective`), `GATING_REQUIRED = ['objective', 'why', 'successCriteria']`. `CaseRuntime.brief(id)` builds one with the case type's `extraFields`.
- **Brief tool:** `BriefTool` in `src/tools/builtin/case-tools.js`. It checks a quote only when `brief.isUserOnly(field) && provenance === 'user'`, so `provenance: "user"` on `successCriteria` passes today with no quote. `withCase(options, op, fn, { params, reoriented })` is exported there.
- **Quotes:** `requireOwnerQuote({ quote, ownerMessages })` → `{ ok, quote, messageIndex }` and `normalizeForQuote` (`src/cases/chat-integration.js`); `wordsInText(words, text)` (`src/tools/owner-quote.js`): the whole of `words`, folded, as one contiguous run in `text` on word boundaries.
- **Other writers of criteria:** `DetourRouter` (`src/cases/detours/router.js`) prefills a new case with `successCriteria: [summary]` through `rt.brief(created.id).update('successCriteria', …, { provenance: 'model' })`; playbook gating's `applyToBrief` (`src/cases/playbooks/gating.js`) appends an answered gating record with `provenance: 'user'`.
- **Create:** `CaseRuntime.createCase({ title, type, objective, force })`; IPC `case:create` (`src/ipc/case-handlers.js`) passes `objective || ''`; the renderer's form sends no objective; `create_case` (`src/mcp/case-tools.js`, `createCase`) checks `wordsInText(args.objective, args.quote)` and then calls `rt.recordOwnerObjective`.
- **Turns:** `beginTurn` (lock, `owner edits` commit, budgets, `_runHooks('turn-start')`, `_detect`, orientation, `turn.models`); `endTurn(turn, { summary, journal, journalKind })` (`renderOpenItems`, journal, `_closeTurnMeta`, `_commit`, `_reindex`, release); `systemAction(id, label, fn)`; hook phases are `turn-start` and `owner-message` only (`addTurnStartHook`). Callers of `endTurn`: `endCaseTurn` in `src/ipc/chat-handlers.js` (four exits: stopped, blocked, normal, failed) and `close` in `runWakeupTurn` (`src/cases/turn-runner.js`).
- **Tool results in the send path:** `executor.on('postExecute', ({ toolName, result }) => …)` in `chat-handlers.js`; a wake-up's `AgentLoop` gets its executor from `host.createToolExecutor`.
- **Ledger:** `FactLedger.view()` → `{ facts: Map, errors }`; a fact has `id`, `provenance`, `status` (`active`, `superseded`, `retracted`), `supersededBy`, `subject`, `attr`, `value`, `stmt`, `source`, `addedBy`, `loadBearing`. `CaseRuntime.ledger(id)`.
- **Records:** `CaseRecords` (`decisions()` → `[{ id: 'D-001', decision, factIds, alternatives, at }]`, `writeJournal(kind, text, now)`, `lastJournal()`).
- **Status:** `src/cases/status.js`: `READ_OPS`, `ALLOWED` (`paused`, `done`, `abandoned`), `DENIED` (`draft`, `active`, `needs-direction`), `check`. `CaseRuntime.setStatus(id, status, { kind, by, ref, note })`, `assertWritable`, `requireReoriented`.
- **Questions:** `CaseRuntime.createQuestion(id, record, { charge })` (dedupes by text or `payload.key`, returns `{ held: true }` at the daily cap), `answerQuestion` (inside `systemAction`, runs the type's `onAnswered`), `QuestionStore.registerAnswerHandler(type, { toFact, onAnswered })` (`src/cases/answer-handlers.js` holds the existing ones), `questions(id).open()`. `answerClass` and `PRESSED_TYPES` in `src/cases/mcp-tool-definitions.js`. A recorded answer is `question.answer = { channel, at, text, optionId, factId, quote? }`.
- **Triggers:** a turn-start hook returns `{ notes: [string], triggers: [{ kind, key, detail, blocking }] }`; `Reorient` acknowledges hook triggers by `key` (`acknowledgedKeys`).
- **Roles and usage:** `CaseRuntime.ensureRoleTested(id, 'verify', { turn })`, `routedProvider(turn, { role: 'verify' })` → `{ sendMessageWithTools(messages, tools, opts) }`, `usageHook(turn)`, `recordOneShotUsage(runtime, turn, reply)` and `textOf(reply)` in `src/cases/turn-runner.js`. `resolveCaseRole('verify', …)` (`src/cases/roles.js`) picks a provider family other than `judge`'s when one is usable.
- **A strict reply parser:** `parseReplyObject(text)` in `src/cases/ingest/propose.js`.
- **Case types:** `src/cases/case-types/software-repo.js`: `briefFields()`, `validateRepo`, `repoInQuote`, `defaultExec`, `refresh`, `pathKey`, `isCloneUrl`; `refreshCaseType(runtime, meta)` in `src/cases/detours/hooks.js` writes `.kl/case-type.json`; `CaseRuntime.caseTypeSnapshot(id)` → `{ fetchedAt, stale, state: { repo, branch, head, dirty, openPrs, … }, notes }`.
- **Executors:** `runtime.host.getExecutorRegistry()` → registry with `jobs(caseId).list()`; `TERMINAL_STATES` in `src/cases/executors/job-store.js`; envelopes under `.kl/envelopes/` with `ENVELOPE_STATUSES` (`src/cases/executors/envelope.js`); `.kl/plan.json` (`status` in `PLAN_STATUSES`).
- **Ingest:** `pendingProposals(dir)` in `src/mcp/case-tools.js`.
- **Write guard:** `caseWriteRefusal` (`src/cases/chat-integration.js`) already refuses `Write`, `Edit` and `MultiEdit` anywhere under a case's `.kl/` (`PROTECTED_ROOT_DIRS`) and on `brief.md`. No guard code changes in this stage; tests name the new files.
- **MCP:** `createCaseToolHandler` (`openCase`, `listCases`) and `untrusted()`; `CASE_SCOPES`; `tests/mcp-case-tools.test.js`, `tests/management-tools.test.js`, `tests/frontdoor-case-tools.test.js`.
- **Panel and cards:** `renderCaseUnattendedSection`, `CASE_STATUS_ACTIONS`, the question card (`chat-question-card`, drawn from `case:questions` records by `answerClass`) in `renderer.js`; `window.electron.cases.*` in `preload.js`; `tests/renderer-playbooks-text.test.js` is the model for a renderer text test.
- **Program lookup without a shell:** `resolveCommand(argv0, { platform, env, cwd, fsCheck })` in `src/service/doctor-runbooks.js` → `{ path, via, cmdShim? }`.
- **Admin-only service keys:** `ADMIN_ONLY_KEYS` in `src/service/config.js`.

## File Structure

| File | Task | What it is |
|---|---|---|
| `src/cases/scope.js` | 1 | `ScopeStore`, `textHash`, `validateCriterionText`, `ScopeError` |
| `src/cases/abandoned.js` | 2 | `AbandonedStore`, `abandonedLines`, `AbandonedError` |
| `src/cases/verify/store.js` | 3 | `VerificationStore` (`.kl/verification.json`) |
| `src/cases/verify/status.js` | 3 | `computeCriterionState`, `progressView`, `summaryLine` (pure) |
| `src/cases/verify/evidence.js` | 3, 7, 16 | resolvers, sources, `collectTurnEvidence` |
| `src/cases/verify/readiness.js` | 6, 16 | `closeReadiness`, `readinessFingerprint` |
| `src/cases/one-shot-usage.js` | 8 | `recordOneShotUsage`, `textOf` (moved from `turn-runner.js`) |
| `src/cases/verify/judge.js` | 8 | the verify pass |
| `src/cases/verify/hook.js` | 9 | the `verification` turn-start hook, `freezeProgress` |
| `src/tools/builtin/case-progress-tool.js` | 10 | the `Progress` tool |
| `src/cases/verify/questions.js` | 10 | host-built card text and the two answer handlers |
| `src/ipc/case-progress-handlers.js` | 12, 15 | `case:progress`, `case:confirmScope`, `case:setCheck` |
| `src/cases/verify/check.js` | 15, 16 | `validateCheck`, `checkInQuote`, `CheckStore`, `runCheck` |

---

## Task 1: `ScopeStore` — who wrote each criterion

Parallel with Tasks 2 and 3.

**Files:**
- Create: `src/cases/scope.js`
- Test: `tests/cases-scope.test.js` (new)

**Interfaces:**
- Consumes: `normalizeForQuote` (`src/cases/chat-integration.js`), `plainLineProblem` (`src/cases/hidden-chars.js`), `readJson`, `writeJsonIfChanged` (`src/cases/jsonfile.js`), `createLogger`.
- Produces:
  - `textHash(text) → 'sha256:<hex>'` of `normalizeForQuote(text)`.
  - `validateCriterionText(text)` → the trimmed text, or throws `ScopeError('CRITERION_INVALID', …)` unless it is one plain line of 3 to 300 characters.
  - `MAX_CRITERIA = 12`, `MAX_PROPOSED = 6`, `ORIGINS = ['model', 'owner-quote', 'gating-answer', 'detour', 'owner-create', 'owner-action', 'legacy', 'file']`.
  - `class ScopeError extends Error { code }`.
  - `class ScopeStore { constructor(dir, { now = () => new Date() } = {}) }`, file `<dir>/.kl/scope.json` (spec §7.1).
  - `store.read()` → the file object, or `null` when it is absent, unreadable or not an object (one warning for the last two).
  - `store.view(briefData)` → `{ migrated, objective, criteria, removed, duplicates }`, **never writes**. `objective` is `null` when `briefData.objective` is empty, else `{ text, hash, state, origin, confirmed }`. `criteria` is one row per distinct string of `briefData.successCriteria`, in list order: `{ id, text, hash, state: 'proposed' | 'confirmed', origin, addedBy, at, confirmed, provisional }`. A string whose hash has an entry takes the entry; a string with none is `state: 'proposed'`, `origin: 'legacy'` when the file has no `migratedAt` and `'file'` when it has, with a provisional id (the next free `sc-NNN`, in order) and `provisional: true`. The objective follows the same rule by hash. A second string with the same hash is left out and listed in `duplicates`.
  - `store.reconcile(briefData, { origins = {}, addedBy = null } = {})` → the view, **written**. New strings take `origins[hash] = { origin, confirmed }` when given (`confirmed` is `null` or `{ by, channel, at, quote, factId }`, and makes the entry `confirmed`), else `legacy` or `file` as in `view`. `origins.objective` does the same for the objective. Entries whose string is gone move to `removed` (with `text` from the last view the caller passes in `removedTexts`, or `''`). Sets `migratedAt` on the first write. `nextCriterion` only grows.
  - `store.confirm(targets, { hashes, by, channel = null, quote = null, factId = null })` where `targets` is a list of `sc-` ids and/or `'objective'` and `hashes[target]` is the hash the caller saw: throws `ScopeError('CRITERION_NOT_FOUND')` or `ScopeError('SCOPE_STALE')`; sets `state: 'confirmed'` and `confirmed`. Confirming a confirmed entry is a no-op.
  - `store.limitsProblem(view, { addingProposed = 0, adding = 0 })` → `null` or a `ScopeError('CRITERION_LIMIT')`.

- [ ] **Step 1: Write the failing tests.** `tests/cases-scope.test.js`, on a temp dir with a `.kl/` folder and brief data passed as plain objects:
  - `textHash` is equal for `"Signed  contract"`, `"signed contract"` and the same words with curly quotes around a word; different for one changed letter;
  - "first contact marks every string legacy and proposed": no file, `view({ objective: 'Sell the Lakeside lot', successCriteria: ['A', 'B'] })` gives two rows `proposed`/`legacy`/`provisional: true` with ids `sc-001`, `sc-002` and an objective row `proposed`/`legacy`; **no file exists afterwards**;
  - `reconcile` writes the same rows, sets `migratedAt`, and a second `reconcile` with the same data changes no byte;
  - "a string with no entry after migration is file and proposed": after one reconcile, a third string appears → `origin: 'file'`;
  - `reconcile` with `origins[hash] = { origin: 'owner-quote', confirmed: {…} }` gives `confirmed`; with `{ origin: 'model', confirmed: null }` gives `proposed`/`model`;
  - a reworded string is a new entry with a new id and the old one is in `removed`; ids are never reused after a removal;
  - the same string twice is one row and one `duplicates` entry;
  - `confirm(['sc-001'], { hashes: { 'sc-001': <stale> } })` throws `SCOPE_STALE` and changes nothing; with the right hash it confirms; an unknown id throws `CRITERION_NOT_FOUND`; `confirm(['objective'], …)` confirms the objective;
  - a file holding `"not json"` or `[]` reads as absent with one warning, and the next `reconcile` replaces it with entries of origin `file` (`legacy` is used only when there was no file at all);
  - `validateCriterionText`: 2 characters, 301 characters, a newline, a tab and a zero-width character each throw `CRITERION_INVALID`;
  - `limitsProblem` at 12 criteria and at 6 proposed.
- [ ] **Step 2: Run them and see them fail.** `node --test tests/cases-scope.test.js` — expected: cannot find module `../src/cases/scope`.
- [ ] **Step 3: Implement** `src/cases/scope.js` as specified. Keep it free of `Brief` and `CaseRuntime` (it takes brief data as an argument). A corrupt file is treated as "migrated" (so its strings read `file`, the conservative origin).
- [ ] **Step 4: Run** `node --test tests/cases-scope.test.js tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/scope.js tests/cases-scope.test.js
git commit -m "feat(cases): a scope record beside the brief says who wrote each criterion and the objective"
```

---

## Task 2: Abandoned approaches

Parallel with Tasks 1 and 3.

**Files:**
- Create: `src/cases/abandoned.js`
- Test: `tests/cases-abandoned.test.js` (new), `tests/cases-leaks.test.js` (extend)

**Interfaces:**
- Consumes: `appendJsonl`, `readJsonl` (`src/cases/jsonl.js`), `plainLineProblem`, `normalizeForQuote`.
- Produces:
  - `class AbandonedError extends Error { code }` with codes `ALREADY_ABANDONED`, `ABANDON_INVALID`.
  - `class AbandonedStore { constructor(dir, { now } = {}) }`, file `<dir>/.kl/abandoned.jsonl` (spec §7.2).
  - `store.list()` → `{ records, errors }`; a record is `{ id: 'ab-0001', at, turnId, approach, why, tried, factIds, decisionIds, withdrawn: null | { at, why, turnId } }`; a malformed line is skipped into `errors`.
  - `store.active()` → records with `withdrawn === null`, oldest first.
  - `store.abandon({ approach, why, tried = [], factIds = [], decisionIds = [], turnId = null }, { facts, decisions })` → the record. `approach` one plain line of 5 to 200 characters, `why` 5 to 300, `tried` at most 6 plain lines of at most 200; every `factIds` entry must be a key of `facts` (a `Map`, any status) and every `decisionIds` entry an id in `decisions` (else `ABANDON_INVALID`, naming the id); an active record whose folded `approach` is equal throws `ALREADY_ABANDONED` naming it.
  - `store.withdraw(id, { why, turnId = null })` → appends `{ kind: 'withdraw', target, at, turnId, why }`; unknown or already withdrawn id → `ABANDON_INVALID`.
  - `abandonedLines(records, { max = 8, maxChars = 1500 } = {})` → `string[]`: the newest `max` active records, one line each (`- ab-0002 2026-10-09 <approach>: <why> [f-0017]`, each field cut with an ellipsis so a line is at most 300 characters), then `- … N earlier; Progress abandoned lists them` when some were left out by either cap.

- [ ] **Step 1: Write the failing tests.** `tests/cases-abandoned.test.js`: append and read back; ids count up; `tried` over 6 and a two-line `approach` refuse; an unknown fact id and an unknown decision id refuse; a superseded fact id is accepted; the same approach with different case and spacing refuses `ALREADY_ABANDONED`; after `withdraw` the same approach is accepted again and the first record is still in `list()` with `withdrawn` set; a bad line in the file is skipped and reported; `abandonedLines` caps at 8 records and at 1,500 characters and adds the count line; "recordFailure appends nothing": build a `CaseRuntime` on a temp root, make a case `active`, call `runtime.recordFailure(…)` and assert `.kl/abandoned.jsonl` does not exist. In `tests/cases-leaks.test.js` add: with an abandoned record in case B naming an invented phrase, `runtime.index.search({ text: <phrase>, forCaseId: A })` and `searchCases` return no hit whose text or key holds it, and the index's stored documents for B hold no document built from the file (follow the file's existing style for reading the index).
- [ ] **Step 2: Run** `node --test tests/cases-abandoned.test.js tests/cases-leaks.test.js` — expected: the new file fails on the missing module; the leak test passes already (it pins that nobody adds the file to the index later).
- [ ] **Step 3: Implement** `src/cases/abandoned.js`. Do not touch `src/cases/index-store.js`.
- [ ] **Step 4: Run** the two files again and `node --test tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/abandoned.js tests/cases-abandoned.test.js tests/cases-leaks.test.js
git commit -m "feat(cases): an append-only record of the approaches a case dropped, never indexed across cases"
```

---

## Task 3: Verification records, evidence resolvers, and the state computed on read

Parallel with Tasks 1 and 2.

**Files:**
- Create: `src/cases/verify/store.js`, `src/cases/verify/status.js`, `src/cases/verify/evidence.js`
- Test: `tests/cases-verify-status.test.js` (new), `tests/cases-verify-store.test.js` (new)

**Interfaces:**
- Produces, `store.js`: `class VerificationStore { constructor(dir, { now } = {}) }`, file `<dir>/.kl/verification.json` (spec §7.3).
  - `read()` → the file, or the empty shape `{ version: 1, nextRecord: 1, records: [], opinions: {}, cache: null, passes: null, declinedClose: null, closed: null }` when absent or unreadable (one warning when unreadable).
  - `addRecord({ criterion, criterionHash, evidence, note, turnId, model })` → `{ id: 'v-0001', kind: 'verify', …, at, disagreed: null }`; keeps the newest 5 records per criterion.
  - `markDisagreed(recordId, { turnId })`, `setOpinion(criterionId, opinion)`, `clearOpinion(criterionId)`, `setCache(states)` (writes only when the states differ), `countPass(day)` → the new count, `passesOn(day)`, `setDeclinedClose(fingerprint)`, `freeze(closed)`.
- Produces, `evidence.js`:
  - `ELIGIBLE_PROVENANCE = ['user', 'sourced', 'external-agent']`.
  - `registerEvidenceResolver(prefix, fn)` where `fn(id, ctx) → { exists, holds, reason, provenance?, label? }` and `ctx` is whatever the caller passes; `resolveEvidence(id, ctx)` picks by the id's prefix up to and including the first `-`, and returns `{ exists: false, holds: false, reason: 'evidence-missing' }` for an id with no resolver.
  - The `f-` resolver, registered on load, reads `ctx.facts` (the ledger view's `Map`): missing → `evidence-missing`; `status !== 'active'` → `evidence-inactive` (with `label` `f-0033 was superseded by f-0060` or `f-0041 was retracted`); provenance outside `ELIGIBLE_PROVENANCE` → `evidence-provenance`; an active load-bearing unknown on the same `subject.attr` (compare trimmed, lower-cased) → `evidence-blocked`; else `holds: true` with `provenance` and `source`.
  - `registerEvidenceSource(name, fn)` and `evidenceSources()` (used from Task 7).
- Produces, `status.js` (pure, no I/O):
  - `computeCriterionState({ entry, records, resolve, newestCheck = null })` → `{ state, record, evidence, reasons }`. `entry` is a confirmed scope row (`{ id, hash }`); `records` the file's `records`; `resolve(id)` a function. Rules, in order: no record with `criterion === entry.id && criterionHash === entry.hash` → `unmet`; take the newest such record; if it cites any `chk-` id and `newestCheck` is `{ result: 'fail' | 'timeout' }` → `failing`; if `record.disagreed` → `stale` with reason `the verify pass of <turnId> no longer agrees`; resolve every evidence id: all hold → `met`, else `stale` with one reason per id that does not.
  - `progressView({ scopeView, file, resolve, newestCheck })` → `{ objective, criteria: [{ id, text, scope, origin, provisional, state, evidence: [{ id, holds, provenance, label }], reasons, opinion }], counts: { confirmed, met, stale, failing, unmet, proposed } }`. A proposed row has `state: null`.
  - `summaryLine(view, readiness = null)` → the one line of spec §6.3; without `readiness` it ends before the "ready" part.

- [ ] **Step 1: Write the failing tests.** `tests/cases-verify-status.test.js`, with facts built as plain `Map`s: every rule above; precedence `failing` over `stale` over `met`; a reworded entry (same id never happens; a different hash) is `unmet`; "an external-agent fact alone holds"; an `inferred` and an `unknown` fact do not; an eligible fact under an active load-bearing unknown on the same `subject.attr` does not; a superseded fact gives `stale` with the label naming the superseding id; an id with an unregistered prefix is `evidence-missing`; proposed rows have `state: null` and are counted only in `proposed`; `summaryLine` for the spec's example; "a cached status is never believed": a file whose `cache.states` says `met` for a criterion with no record gives `unmet`. `tests/cases-verify-store.test.js`: the empty shape; ids count up; 5 kept per criterion; an unreadable file reads empty and is replaced by the next write; `setCache` with equal states writes nothing (compare mtime or bytes).
- [ ] **Step 2: Run** `node --test tests/cases-verify-status.test.js tests/cases-verify-store.test.js` — expected: missing modules.
- [ ] **Step 3: Implement** the three files. `status.js` requires nothing but `evidence.js`'s constants (or nothing).
- [ ] **Step 4: Run** the two files and `node --test tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify tests/cases-verify-status.test.js tests/cases-verify-store.test.js
git commit -m "feat(cases): verification records, evidence resolvers, and a criterion state computed on every read"
```

---

## Task 4: The runtime keeps the scope record: reconcile, origins, gating

After Tasks 1 to 3. First task of the sequential run.

**Files:**
- Modify: `src/cases/case-runtime.js` (`scope(id)`, `scopeView(id)`, `applyScopeAction`, `beginTurn`, `createCase`, `completeGating`)
- Modify: `src/cases/brief.js` (`missingForGating`, `completeGating` take a scope view)
- Modify: `src/cases/detours/router.js` (the new case's criteria and objective are recorded as origin `detour`)
- Modify: `src/cases/playbooks/gating.js` (`applyToBrief` records origin `gating-answer`)
- Modify: `src/ipc/case-handlers.js` (`case:create` passes `objectiveBy: 'owner'` when the form sent an objective), `src/mcp/case-tools.js` (`createCase` passes `objectiveBy: 'owner'`)
- Test: `tests/cases-runtime.test.js`, `tests/cases-brief.test.js`, `tests/cases-detour-router.test.js`, `tests/cases-ipc.test.js`, `tests/management-tools.test.js` (extend each)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `CaseRuntime.scope(id) → ScopeStore`; `CaseRuntime.scopeView(id)` → `scope.view(brief.read().data)` (no write; a `BriefError` gives `{ error }`).
  - `CaseRuntime.writeScope(id, { field, value, origin, confirmed = null, addedBy = null })`: the one path that writes a criterion or the objective **and** its origin. Must be called with the case lock held (inside a turn or a `systemAction`). `field` is `'successCriteria'` with `value` the new full list, or `'objective'` with the new text. It reads the view, applies `ScopeStore.limitsProblem`, writes `brief.md` through `Brief.update` (provenance passed through as `'user'` when `confirmed`, else `'model'`), then `scope.reconcile(briefData, { origins, addedBy, removedTexts })` with `origins` set for every hash that was not in the old view.
  - `CaseRuntime.applyScopeAction(id, { action, target, hash, text, by, channel, quote, factId })` → the new view; `action` is `confirm`, `drop`, `edit` or `add`; `target` is `'objective'`, an `sc-` id, or `'all-proposed'`. `confirm` and `drop` require `hash` (for `all-proposed`, `hash` is an object `{ [id]: hash }`) and throw `SCOPE_STALE` on a mismatch; `drop` removes the string from `brief.md`; `edit` and `add` validate `text` and record it `confirmed` with origin `owner-action`. Runs inside `systemAction` when no turn holds the lock; writes one `scope` journal entry; sends `case:changed` with `what: 'progress'`.
  - `beginTurn`: after the `owner edits` commit and before the turn-start hooks, `this.scope(meta.id).reconcile(briefData)` inside a guard (a `BriefError` logs and skips). Never for a case whose status is `done` or `abandoned` (a turn cannot begin there today; keep the guard anyway).
  - `createCase(opts)`: after `store.create`, when `opts.objective` is non-empty, `systemAction` writes the scope file with `origins.objective = opts.objectiveBy === 'owner' ? { origin: 'owner-create', confirmed: { by: 'owner-create', … } } : { origin: 'model', confirmed: null }`. `objectiveBy` is read only here; no tool passes it.
  - `Brief.missingForGating({ scopeView = null } = {})`: with a view, `successCriteria` is missing until one row is `confirmed`; without one (callers that have none), unchanged. `CaseRuntime.completeGating` passes the view. `gating.complete: true` in a brief is never cleared.
  - Router: after its `rt.brief(created.id).update('successCriteria', …)` call, replace that call with `rt.writeScope(created.id, { field: 'successCriteria', value: p.newCase.successCriteria, origin: 'detour' })` (it already runs inside `systemAction`), and record the objective as `detour` in the same block.
  - Gating: `applyToBrief(brief, field, record)` gains an optional fourth argument `{ runtime, caseId }`; for `successCriteria` it calls `runtime.writeScope(caseId, { field, value: [...current, answer], origin: 'gating-answer', confirmed: { by: 'gating-answer', factId: record.answer.factId, … } })` when given, and keeps its present `brief.append` otherwise. Pass the argument from its caller in the same file.

- [ ] **Step 1: Write the failing tests.**
  - `tests/cases-runtime.test.js`: "a case created before this stage reads unchanged": build a case, delete `.kl/scope.json` if present, hash every tracked file, call `runtime.scopeView`, `runtime.orientation` — no file changed and none added; the first `beginTurn` adds exactly `.kl/scope.json` with every criterion `legacy`/`proposed`; "an owner edit to brief.md is proposed until pressed": append a criterion to `brief.md` on disk between turns → after `beginTurn` it is `file`/`proposed`; `applyScopeAction` confirm with a stale hash throws `SCOPE_STALE`; `drop` removes the string from `brief.md`; `edit` of a confirmed criterion keeps it `confirmed` with origin `owner-action`; `all-proposed` confirms every proposed row and leaves confirmed ones alone; a `scope` journal entry is written; `createCase({ objective, objectiveBy: 'owner' })` gives a confirmed objective and `createCase({ objective })` a proposed one.
  - `tests/cases-brief.test.js`: "gating waits for one confirmed criterion"; "a proposed criterion beside a confirmed one does not hold gating back"; "a brief already gating.complete stays complete".
  - `tests/cases-detour-router.test.js`: a detour resolved as "new" creates a case whose one criterion and objective are `detour`/`proposed`.
  - `tests/cases-ipc.test.js`: `case:create` with an objective → confirmed; without → no objective row.
  - `tests/management-tools.test.js` (in "create_case"): the created case's objective is `confirmed`, origin `owner-create`.
- [ ] **Step 2: Run** `node --test tests/cases-runtime.test.js tests/cases-brief.test.js tests/cases-detour-router.test.js tests/cases-ipc.test.js tests/management-tools.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Existing tests that call `completeGating` after the model set `successCriteria` will now fail: give each such test a confirmed criterion through `runtime.applyScopeAction(id, { action: 'add', target: 'all-proposed', text: …, by: 'owner-action' })` or a small helper `tests/helpers/case-scope.js` (`confirmAll(runtime, id)`), and list every test file you touched in this task's Deviations entry.
- [ ] **Step 4: Run** the five files again, then `node --test tests/cases-tools.test.js tests/cases-core.test.js tests/cases-regressions.test.js tests/cases-turn-runner.test.js tests/cases-runtime-unattended.test.js tests/cases-plan-executor-tools.test.js tests/cases-chat.test.js` — expected: `# fail 0` (fix gating fall-out with the helper).
- [ ] **Step 5: Commit.**

```bash
git add src/cases/case-runtime.js src/cases/brief.js src/cases/detours/router.js src/cases/playbooks/gating.js src/ipc/case-handlers.js src/mcp/case-tools.js tests
git commit -m "feat(cases): the runtime records who wrote each criterion; gating waits for one the owner confirmed"
```

---

## Task 5: The `Brief` tool's scope rules

**Files:**
- Modify: `src/tools/builtin/case-tools.js` (`BriefTool`)
- Test: `tests/cases-tools.test.js` (extend)

**Interfaces:**
- Consumes: `runtime.scopeView`, `runtime.writeScope` (Task 4), `requireOwnerQuote`, `wordsInText`, `validateCriterionText`, `textHash`.
- Produces, for `field` `successCriteria` and `objective` only (every other field is untouched):
  - `provenance: 'user'` requires `quote`: `requireOwnerQuote`, then `wordsInText(<item or objective>, check.quote)`. A miss returns `{ ok: false, code: 'SCOPE_NOT_IN_QUOTE', error: 'Quote the owner\'s words that state this criterion, or add it without provenance "user" as a proposal.' }`.
  - `append successCriteria`: validates the item (`CRITERION_INVALID`), refuses an existing hash (`CRITERION_DUPLICATE`) and the limits (`CRITERION_LIMIT`), then `runtime.writeScope` with origin `owner-quote` and `confirmed: { by: 'owner-quote', channel: 'in-app-chat', quote, at }` or origin `model`. Returns `{ ok: true, brief, criterion: { id, state } }` and, when proposed, `note: 'Proposed. It counts for nothing until the owner confirms it. Ask with Progress askScope.'`.
  - `update successCriteria` (a whole list): compare with the view by hash. A confirmed row missing from the new list → `{ ok: false, code: 'CRITERION_CONFIRMED', error: 'sc-002 was confirmed by the owner. Only the owner changes or drops it; ask.' }`. New strings are added as above (all with the one quote when `provenance: 'user'`, each must pass `wordsInText`); proposed rows missing from the list are removed.
  - `update objective`: with a verified quote → confirmed, origin `owner-quote`; without, refused `OBJECTIVE_CONFIRMED` when the current objective is confirmed, else written as origin `model`.
  - The journal line reads `Brief successCriteria appended (proposed, sc-004)` or `(confirmed, sc-004, quote: "…")`; never `(user)` for these two fields.

- [ ] **Step 1: Write the failing tests** in `tests/cases-tools.test.js` (a new `describe('Brief scope rules')`, each test supplying `ownerMessages` in the case context): append without a quote → `proposed`; with a quote found in `ownerMessages` and containing the item → `confirmed`; "a quote of yes does not confirm": `ownerMessages: ['yes do that']`, quote `'yes do that'`, item `'Three written quotes'` → `SCOPE_NOT_IN_QUOTE`; `provenance: 'user'` with no quote → refused (it passed before this task); a quote not in `ownerMessages` → the existing quote error; list `update` dropping a confirmed row → `CRITERION_CONFIRMED` and the file unchanged; dropping a proposed row works; the 13th criterion and the 7th proposed → `CRITERION_LIMIT`; a duplicate → `CRITERION_DUPLICATE`; a two-line item → `CRITERION_INVALID`; objective: model rewrite of a confirmed objective → `OBJECTIVE_CONFIRMED`; of a proposed one → allowed and still proposed; with a quote → confirmed; extra parameters (`state: 'confirmed'`, `force: true`) are ignored.
- [ ] **Step 2: Run** `node --test tests/cases-tools.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Keep the tool's schema as it is (no new parameter); update only the description sentence to say that criteria added without the owner's quoted words are proposals.
- [ ] **Step 4: Run** `node --test tests/cases-tools.test.js tests/cases-regressions.test.js tests/cases-chat.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/tools/builtin/case-tools.js tests/cases-tools.test.js
git commit -m "feat(cases): the Brief tool adds criteria as proposals unless the owner's own words state them"
```

---

## Task 6: Ready to close

**Files:**
- Create: `src/cases/verify/readiness.js`
- Modify: `src/cases/case-runtime.js` (`abandoned(id)`, `verification(id)`, `progress(id)`, `closeReadiness(id)`)
- Test: `tests/cases-verify-readiness.test.js` (new)

**Interfaces:**
- Consumes: Tasks 1 to 4; `JobStore`/`TERMINAL_STATES`, the envelope files, `.kl/plan.json`, `runtime.detours.list(id)`, `pendingProposals` (move it from `src/mcp/case-tools.js` to `src/cases/ingest/store.js` only if importing it from `src/mcp/` would make `src/cases/` depend on `src/mcp/`; otherwise read the same files the same way and say so in Deviations).
- Produces:
  - `CaseRuntime.abandoned(id) → AbandonedStore`, `CaseRuntime.verification(id) → VerificationStore`.
  - `CaseRuntime.progress(id)` → `{ scope, view, readiness, summary, abandoned, closed }`: for a `done` or `abandoned` case with `file.closed` set, returns `closed` as stored (`{ frozen: true, … }`) and computes nothing; otherwise `view = progressView({ scopeView, file, resolve: (evidenceId) => resolveEvidence(evidenceId, { facts, checks: null, snapshot }), newestCheck: null })`. Reads only; never writes.
  - `closeReadiness(runtime, id, { view })` → `{ ready, items, computedAt }`, items as in spec §6.4 **without** `check-passing` (Task 16 adds it). Each item `{ id, state: 'ok' | 'open' | 'unknown' | 'n/a', by, count, refs, fix }`; `fix` is built from fixed wording, ids and counts only. `tree-clean` and `branch-merged` are `n/a` unless the case type is `software-repo`; `unknown` when the snapshot is missing or `stale`, or (`branch-merged`) when `state.openPrs` is `null`.
  - `readinessFingerprint(readiness)` → `'sha256:…'` over the sorted `[id, state]` pairs.

- [ ] **Step 1: Write the failing tests.** `tests/cases-verify-readiness.test.js` on a real runtime in a temp root, with jobs, envelopes and a plan written through `tests/helpers/executor-fixtures.js` where it offers them and as plain files under `.kl/` where it does not: each item in each of its states; "fix never carries case text": give a criterion, a question and a job a canary string and assert no `fix` holds it; `ready` is true only when all are `ok` or `n/a`; an open `close-proposal` question does not count against `questions-answered`; an `expired` envelope does not count and an `active` one does; `branch-merged` counts only a PR whose `headRefName` equals the snapshot's `branch`, and its `count` of other open PRs is in the item; the fingerprint changes when one state changes and not when only `computedAt` does; `runtime.progress` of a case with no stage files writes nothing.
- [ ] **Step 2: Run** `node --test tests/cases-verify-readiness.test.js` — expected: missing module.
- [ ] **Step 3: Implement.** Wrap each item's read in a guard: a read that throws makes that item `unknown`, never the whole list.
- [ ] **Step 4: Run** the file and `node --test tests/cases-runtime.test.js tests/electron-boundary.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify/readiness.js src/cases/case-runtime.js tests/cases-verify-readiness.test.js
git commit -m "feat(cases): a ready-to-close list computed from the record, each item with whose it is to fix"
```

---

## Task 7: What a turn wrote: marks, evidence, and `endTurn`'s new fields

**Files:**
- Modify: `src/cases/verify/evidence.js` (`collectTurnEvidence`, the executor-results source)
- Modify: `src/cases/case-runtime.js` (`turn.marks` in `beginTurn`; `endTurn` accepts `evidence`, `verify`; `_closeProgress` stub)
- Modify: `src/ipc/chat-handlers.js` (collect case-tool results; pass them on the normal exit only)
- Modify: `src/cases/turn-runner.js` (collect them in the wake-up; pass on the `acted` outcome only)
- Test: `tests/cases-verify-evidence.test.js` (new), `tests/cases-runtime.test.js`, `tests/cases-turn-runner.test.js`, `tests/cases-chat.test.js` (extend)

**Interfaces:**
- Produces:
  - `turn.marks = { ledgerLines, decisions, jobRecords, head, dirty }`: the line count of `facts.jsonl`, `records.decisions().length`, the sum of `recordsSaved.length` over the case's jobs (0 with no registry), and the snapshot's `state.head` and `state.dirty` (or `null`). Set last in `beginTurn`.
  - `CASE_EVIDENCE_TOOLS = ['Ledger', 'Decide', 'Executor', 'Ingest', 'Progress']` (exported from `evidence.js`).
  - `toolResultRow(toolName, parameters, result)` → `null` for a tool outside `CASE_EVIDENCE_TOOLS`, else `{ tool, action, ok, text }` with `text` the JSON of the result cut to 1,000 characters.
  - `collectTurnEvidence(runtime, turn, evidence = {})` → `{ changed, facts, decisions, executorResults, toolResults, extra }`: `facts` are the view's facts whose `addedBy === turn.turnId` or that lie past `marks.ledgerLines` (read the file's lines past the mark and take their ids); `decisions` are those past `marks.decisions`; `executorResults` come from the registered source `executor-results` (jobs whose `recordsSaved` grew: `{ kind: 'executor-result', id: job.id, text: '<executor> <state>', refs: <fact ids with addedBy this turn and a source under sources/<executor>/> }`); `toolResults` is `evidence.toolResults` filtered again through `CASE_EVIDENCE_TOOLS` and capped at 4,000 characters in all; `extra` is every other registered source's rows. `changed` is true when `facts`, `decisions` or `executorResults` is non-empty.
  - `endTurn(turn, { summary, journal, journalKind, evidence = null, verify = false })`: before `renderOpenItems`, `await this._closeProgress(turn, { evidence, verify })` inside `try/catch` (a throw logs and continues); it returns `{ block: string | null }` and the journal entry is written as `block + '\n\n' + journal` when `block` is set (and as `block` alone when `journal` is empty). In this task `_closeProgress` only collects the evidence and returns `{ block: null }`.
  - `chat-handlers.js`: an array `caseToolResults` filled in the existing `executor.on('postExecute', …)` listener through `toolResultRow` (parameters come from the matching `preExecute`); the normal exit calls `endCaseTurn({ summary: safeMessage, journal, evidence: { toolResults: caseToolResults }, verify: true })`; the stopped, blocked and failed exits are unchanged.
  - `turn-runner.js`: the same collection on the wake-up's executor (`executor.on('postExecute', …)` after `createToolExecutor`); `close('acted', …)` passes `evidence` and `verify: true`; every other outcome passes neither.

- [ ] **Step 1: Write the failing tests.** `tests/cases-verify-evidence.test.js`: "only case-tool results are kept" (`Bash`, `WebFetch`, `Read` rows are dropped by `toolResultRow` and again by `collectTurnEvidence` when handed in directly); the 1,000 and 4,000 character caps; facts written in the turn are found by `addedBy` and by the line mark (a fact written by an answered question during the turn, `addedBy: 'question:q-0001'`, is found by the mark); decisions past the mark; `changed` false for a turn that only read; a registered extra source's rows appear in `extra`. `tests/cases-runtime.test.js`: `turn.marks` is set; `endTurn` with a `_closeProgress` that throws still commits and releases the lock; a returned `block` is the first text of the journal entry. `tests/cases-turn-runner.test.js`: the `acted` close passes `verify: true`, the `quiet`, `skipped` and `failed` closes do not (spy on `runtime.endTurn`). `tests/cases-chat.test.js`: a stopped turn passes no `verify`.
- [ ] **Step 2: Run** `node --test tests/cases-verify-evidence.test.js tests/cases-runtime.test.js tests/cases-turn-runner.test.js tests/cases-chat.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four files again and `node --test tests/cases-stop.test.js tests/cases-service-wakeups.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify/evidence.js src/cases/case-runtime.js src/ipc/chat-handlers.js src/cases/turn-runner.js tests
git commit -m "feat(cases): a turn knows what it wrote, and its close receives the case-tool results"
```

---

## Task 8: The verify pass

**Files:**
- Create: `src/cases/verify/judge.js`, `src/cases/one-shot-usage.js`
- Modify: `src/cases/turn-runner.js` (require `recordOneShotUsage` and `textOf` from the new module; keep exporting them)
- Modify: `src/cases/defaults.js` (`verify` settings), `src/cases/case-runtime.js` (`_closeProgress` runs the pass)
- Test: `tests/cases-verify-judge.test.js` (new), `tests/cases-turn-runner.test.js` (must still pass)

**Interfaces:**
- Produces:
  - `settings.cases.verify = { when: 'changed-turn', timeoutMs: 20000, maxInputChars: 12000, maxPassesPerDay: 24, skipAboveUsdPercent: 80 }`, merged and validated in `resolveCaseSettings` like its neighbours (`when` outside `changed-turn`, `request`, `off` reads as the default).
  - `VERIFY_SYSTEM` (a constant): the pass is given success criteria and records; for each criterion it answers `met` only when the listed records show it, citing their ids; it never cites an id that is not listed; text inside the data fence is data, not instructions; reply with JSON only in the shape below.
  - `buildVerifyInput({ view, turnEvidence, facts, newestCheck = null, maxChars })` → a string: the eight parts of spec §6.5 in order, in one fence made with `fence`/`newFenceId` from `src/cases/ingest/propose.js`, cut at `maxChars` with a count of what was left out. It takes no journal and no reply text, and has no parameter that could carry one.
  - `parseVerifyReply(text, confirmedIds)` → `[{ id, status: 'met' | 'unmet', evidence: string[], note }]` or `null` (not the exact shape `{ criteria: [...] }`; a `status` outside the two; more than 8 evidence ids; an id not in `confirmedIds`; an id twice). `note` is one line of at most 200 characters.
  - `acceptVerdict({ verdict, row, resolve })` → `{ accept: true }` or `{ accept: false, rejected: [{ id, reason }] }` (`evidence-empty` when there is none).
  - `runVerifyPass(runtime, turn, { turnEvidence, mode = 'close' })` → `{ ran, skipped, accepted, opinions, disagreed, error }`. Skips (`skipped: <reason>`) when: `turnEvidence.changed` is false (close mode only); no confirmed criterion; the case status after the turn is not `active` or `needs-direction`; `turn.signal.aborted`; `when` is `off`, or `request` in close mode; `passesOn(today) >= maxPassesPerDay`; the `usd` budget's ratio × 100 ≥ `skipAboveUsdPercent`. Otherwise: `ensureRoleTested`, `routedProvider(turn, { role: 'verify' }).sendMessageWithTools([{ sender: 'user', text: input }], [], { systemPrompt: VERIFY_SYSTEM, abortSignal })` raced against a ref'd timer of `timeoutMs` that aborts it, `recordOneShotUsage(runtime, turn, reply)`, `countPass`, parse, then per verdict: `met` + accept → `addRecord` and `clearOpinion`; `met` + not accepted → `setOpinion` with `rejected`; `unmet` on a row whose computed state is `met` → `markDisagreed` on its record; `unmet` otherwise → `setOpinion`. Never throws.
  - `verificationBlock({ pass, before, after, check = null })` → the host-written journal block of spec §6.5 or `null` when there is nothing to say. A regression (a criterion that left `met`) is its first line.
  - `_closeProgress(turn, { evidence, verify })`: when `verify`, `collectTurnEvidence`, compute the view before, `runVerifyPass`, compute the view after, return `{ block }`.

- [ ] **Step 1: Write the failing tests.** `tests/cases-verify-judge.test.js`, with a runtime whose `host.inferenceRouter` is a stub returning a scripted reply with `llmMetrics` (copy the shape `tests/cases-turn-runner.test.js` uses) and a `host.getUsageTracker` stub:
  - each skip reason, by name: "skipped when nothing was written", "skipped with no confirmed criterion", "skipped when stopped", "skipped over the daily cap", "skipped past 80 % of usd", "request mode runs only when asked";
  - "prose never reaches the pass": the assistant's reply and the journal text both hold a canary; the message the stub received does not, and `buildVerifyInput.length` (its parameter list) has no slot for either;
  - the input holds each confirmed criterion's id and text, no proposed criterion, this turn's facts with provenance and source, and no `inferred` or `unknown` fact; it is at most `maxInputChars`;
  - every row of the spec's acceptance table: accepted `met` writes one record and the state reads `met`; `met` with no evidence, a missing id, a superseded id, an `inferred` id, an id under a load-bearing unknown → an opinion with that reason and no record; `unmet` on a `met` criterion → `stale` with the "no longer agrees" reason, and a later accepted `met` restores it;
  - a fenced reply and a prose-wrapped reply parse; a malformed reply, an unknown criterion id and a duplicate id drop the whole reply ("no usable verdict") and change nothing;
  - a stub that never settles: the pass returns after `timeoutMs` (set to 50 in the test, with a ref'd timer held by the test) with `error` set, and `endTurn` commits;
  - "charged to the case and filed under the verify role": `.kl/budget.json`'s `usd.spent` grew by the stub's cost and the tracker stub received an event whose `role` is the verify model role;
  - the journal entry of the turn starts with `## Verification (written by King Louie)` when a criterion changed state, and has no block when the pass was skipped for "nothing written".
- [ ] **Step 2: Run** `node --test tests/cases-verify-judge.test.js` — expected: missing module.
- [ ] **Step 3: Implement.** Move `recordOneShotUsage` and `textOf` to `src/cases/one-shot-usage.js` without changing them.
- [ ] **Step 4: Run** `node --test tests/cases-verify-judge.test.js tests/cases-turn-runner.test.js tests/cases-runtime.test.js tests/cases-roles.test.js tests/cases-budget.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify/judge.js src/cases/one-shot-usage.js src/cases/turn-runner.js src/cases/defaults.js src/cases/case-runtime.js tests/cases-verify-judge.test.js
git commit -m "feat(cases): a verify pass at the close of a changed turn reads the record; code accepts met only on ids that hold"
```

---

## Task 9: Regressions are noticed, and a closed case is frozen

**Files:**
- Create: `src/cases/verify/hook.js`
- Modify: `src/cases/case-runtime.js` (register the hook in the constructor after `registerDetourHooks`; write the cache in `_closeProgress`; `setStatus` freezes)
- Test: `tests/cases-runtime.test.js`, `tests/cases-triggers.test.js` (extend)

**Interfaces:**
- Produces:
  - `registerVerificationHook(runtime)`: `runtime.addTurnStartHook('verification', fn)`. `fn` computes `runtime.progress(caseId).view`, compares each confirmed row's state with `file.cache.states[id]`; for a row that was `met` and is now `stale` or `failing` it returns a note (`sc-002 was met and is now stale: f-0033 was superseded by f-0060.`) and a trigger `{ kind: 'criterion-regressed', key: 'criterion:<id>:<recordId>:<state>', blocking: true, detail }` (the criterion's text in `detail` is cut to 80 characters and quoted). It then `setCache(states)`. It is registered after the detour hooks, so it runs after the case-type refresh. A throw is caught by `_runHooks` as for any hook.
  - `_closeProgress` ends with `setCache(states)`.
  - `freezeProgress(runtime, id)`: `verification(id).freeze({ at, status, summary, criteria: view.criteria, readiness })`. Called from `CaseRuntime.setStatus` when the new status is `done` or `abandoned`, after `updateMeta`, inside a guard (a failure logs; the status change stands). `runtime.progress` returns the frozen record for such a case (Task 6 already reads `file.closed`).

- [ ] **Step 1: Write the failing tests.** `tests/cases-runtime.test.js`: a case with a `met` criterion (write a verification record through the store, citing an active sourced fact); supersede the fact through the ledger; the next `beginTurn` has a `criterion-regressed` trigger and a `Since last turn` note, and `turn.reorientPending` is true; `recordReorientation` acknowledges it and the turn after has no such trigger; the cache file now says `stale`; "progress is frozen at done and not recomputed": set the case `done`, then supersede a cited fact by appending to `facts.jsonl` directly — `runtime.progress(id)` still returns the frozen `met`, labelled frozen; a case set `abandoned` is frozen too; a `freeze` that throws does not stop `setStatus`. `tests/cases-triggers.test.js`: a hook trigger of kind `criterion-regressed` passes through `detectTriggers` and is dropped once its key is in `acknowledgedKeys`.
- [ ] **Step 2: Run** `node --test tests/cases-runtime.test.js tests/cases-triggers.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two files and `node --test tests/cases-status.test.js tests/cases-runtime-unattended.test.js tests/cases-detour-hooks.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify/hook.js src/cases/case-runtime.js tests/cases-runtime.test.js tests/cases-triggers.test.js
git commit -m "feat(cases): a criterion that leaves met asks for re-orientation; a closed case keeps the progress it closed with"
```

---

## Task 10: The `Progress` tool and its questions

**Files:**
- Create: `src/tools/builtin/case-progress-tool.js`, `src/cases/verify/questions.js`
- Modify: `src/tools/index.js` (register it beside the other case tools), `src/cases/chat-integration.js` (`CASE_TOOL_NAMES`, three lines in `CASE_MODE_PROMPT`), `src/cases/status.js` (`READ_OPS`, `DENIED`), `src/cases/mcp-tool-definitions.js` (`PRESSED_TYPES`), `src/cases/answer-handlers.js` (require the new handlers)
- Test: `tests/cases-progress-tool.test.js` (new), `tests/cases-status.test.js`, `tests/management-tools.test.js` (extend)

**Interfaces:**
- Produces:
  - `ProgressTool` (name `Progress`, `requiresApproval: false`), parameters `{ action: 'status' | 'abandoned' | 'abandon' | 'askScope' | 'proposeDone' | 'verify', approach, why, tried, factIds, decisionIds, withdraw, note }`, executed through `withCase(options, (p) => \`Progress.${p.action}\`, fn, { params, reoriented })` with `reoriented: true` only for `proposeDone`. Unknown parameters are ignored.
  - `status.js`: `READ_OPS` gains `'Progress.status'` and `'Progress.abandoned'`; `DENIED.draft` and `DENIED['needs-direction']` gain `'Progress.proposeDone'`.
  - `status` → `{ ok: true, summary, objective, criteria, readiness, untrusted_output: true }` from `runtime.progress`. `abandoned` → `{ ok: true, records }`.
  - `abandon` → `AbandonedStore.abandon` (or `withdraw` when `withdraw` is given) with the ledger's facts and the decisions, then one `abandon` journal entry; errors come back as `{ ok: false, code, error }`.
  - `askScope`: `SCOPE_NOTHING_PROPOSED` when no row and no objective is proposed; `SCOPE_QUESTION_OPEN` (naming the id) when an open question has `payload.key === 'scope-confirm'`; else `runtime.createQuestion(id, { kind: 'question', urgency: 'normal', text: scopeQuestionText(meta, view), options: [{ id: 'all', label: 'Confirm all' }, { id: 'none', label: 'Drop all' }], payload: { type: 'scope-confirm', key: 'scope-confirm', disclosable: false, entries: [{ id, hash }], objective: hash | null, turnId } }, { charge: true })`; `{ held: true }` → the same refusal text `Ask` gives for the daily allowance.
  - `proposeDone`: `NO_CONFIRMED_CRITERIA`; `NOT_READY` (with `open: readiness.items.filter(open)`) while any confirmed row's state is not `met`; `CLOSE_PROPOSAL_OPEN`; `CLOSE_DECLINED_UNCHANGED` when `file.declinedClose.fingerprint === readinessFingerprint(readiness)`; else `createQuestion` with `payload: { type: 'close-proposal', key: 'close-proposal', mcpAnswerable: false, disclosable: false, fingerprint, turnId }`, options `done` "Mark done" and `keep` "Keep working", `charge: true`. With `cases.verify.when === 'request'` it first runs `runVerifyPass(runtime, turn, { turnEvidence, mode: 'request' })`.
  - `verify`: `VERIFY_NOT_ON_REQUEST` unless `when === 'request'`; else runs the pass in `request` mode over the whole record and returns its counts.
  - `questions.js`: `scopeQuestionText(meta, view)` and `closeQuestionText(meta, progress, note)` — host lines first (title, the numbered criteria or the summary line and one `fix` line per open item), the model's `note` last as `Note from the case: …` (one plain line, at most 300 characters, else `(text hidden: not one plain line)`); each throws `QuestionError('QUESTION_TOO_LONG', …)` past 2,000 characters. `PRESS_CHANNELS = ['in-app', 'mobile']`.
  - Handler `scope-confirm` (`onAnswered`): option `all` → `runtime.applyScopeAction` confirm for exactly the payload's entries whose hash still matches (and the objective when its hash matches), with `by: 'question'`, the answer's `channel`, `quote` and `factId`; option `none` → `drop` for the same; entries that no longer match are skipped and named in a note on the question; a text answer with no option confirms nothing and notes `Answer with "Confirm all" or "Drop all", or use the buttons beside each criterion in the case panel.`
  - Handler `close-proposal` (`onAnswered`): `keep` → `setDeclinedClose(payload.fingerprint)`; `done` → only when `question.answer.channel` is in `PRESS_CHANNELS`, `runtime.setStatus(caseId, 'done', { kind: 'owner', by: 'owner', ref: fact?.id || question.id, note: 'close proposal <qid>; open at close: <item ids or none>' })`; from any other channel nothing is applied and the question gets a note. The owner's press is never refused for an open item (R-C8-1).
  - `PRESSED_TYPES` gains `'close-proposal'` and `'check-approve'`. `'scope-confirm'` is **not** added.
  - `CASE_TOOL_NAMES` gains `'Progress'`; `CASE_MODE_PROMPT` gains: `- Success criteria you add are proposals until the owner confirms them; ask with Progress askScope.`, `- You cannot mark a criterion met. Record the evidence as facts; King Louie checks them at the end of the turn.`, `- When you drop an approach, record it with Progress abandon. Do not retry an approach the orientation lists as abandoned without a new fact.`

- [ ] **Step 1: Write the failing tests.** `tests/cases-progress-tool.test.js` (begin a turn before any action that needs one; supply a `caseContext` as `tests/cases-tools.test.js` does):
  - each action against a `draft`, `active`, `needs-direction`, `paused` and `done` case, per the spec's table;
  - `abandon` writes the record and a journal entry; a duplicate returns `ALREADY_ABANDONED`; `withdraw` works;
  - `askScope`: `SCOPE_NOTHING_PROPOSED`; one question with the two options and the hashed entries; a second call returns `SCOPE_QUESTION_OPEN`; "scope-confirm is a spoken question" (`answerClass(record) === 'spoken'`); answering `all` through `runtime.answerQuestion(…, { channel: 'in-app-chat', optionId: 'all', quote: 'confirm all three please' })` confirms the entries; a criterion reworded after the question was asked is skipped and noted; a free-text answer confirms nothing; `none` removes the strings from `brief.md`;
  - "proposeDone refuses for an unmet, a stale and a failing criterion" (three cases; build `failing` by writing a record that cites `chk-0001` and passing a failing newest check through a stubbed resolver, or mark this third case `todo` until Task 16 and say so in Deviations); `NO_CONFIRMED_CRITERIA`; with all met it creates one pressed question whose text starts with the title and the summary line and ends with `Note from the case:`; a second call returns `CLOSE_PROPOSAL_OPEN`; after a `keep` answer a new call returns `CLOSE_DECLINED_UNCHANGED`, and succeeds once a state changed;
  - the close answer: `done` from `in-app` and from `mobile` sets the case `done` with `statusReason.by === 'owner'`; from `in-app-chat`, `mcp-stdio`, `mcp-frontdoor` and `telegram` the case stays `active` and the question has a note; "the owner's press closes a case that is not ready" (supersede a cited fact after the proposal, then press);
  - a note of 3,000 characters refuses with `QUESTION_TOO_LONG`; a two-line note is shown as hidden;
  - `verify` returns `VERIFY_NOT_ON_REQUEST` by default and runs with `when: 'request'`;
  - extra parameters (`state`, `status`, `force`, `evidence`) change nothing.
  - `tests/cases-status.test.js`: the two read ops in every status; `Progress.proposeDone` denied in `draft` and `needs-direction`.
  - `tests/management-tools.test.js`: `answer_question` on a `close-proposal` is refused on `in-app-chat`, `mcp-stdio` and `mcp-frontdoor` with the pressed message; "answer_question confirms scope with the owner's quote" (quote "confirm all of those" naming the option label).
- [ ] **Step 2: Run** `node --test tests/cases-progress-tool.test.js tests/cases-status.test.js tests/management-tools.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Check the wake-up path: `allowedToolNames` is built from `CASE_TOOL_NAMES`, so `Progress` is available there with no further change.
- [ ] **Step 4: Run** the three files and `node --test tests/cases-tools.test.js tests/cases-questions.test.js tests/cases-question-chat.test.js tests/cases-turn-runner.test.js tests/cases-chat.test.js tests/case-chat-attach.test.js` — expected: `# fail 0` (tests that list the case tools by name need `Progress` added).
- [ ] **Step 5: Commit.**

```bash
git add src/tools/builtin/case-progress-tool.js src/cases/verify/questions.js src/tools/index.js src/cases/chat-integration.js src/cases/status.js src/cases/mcp-tool-definitions.js src/cases/answer-handlers.js tests
git commit -m "feat(cases): the Progress tool: status, abandoned approaches, a scope question, and a pressed proposal to close"
```

---

## Task 11: The orientation shows progress and abandoned approaches

**Files:**
- Modify: `src/cases/orientation.js`, `src/cases/case-runtime.js` (`orientation` passes the new inputs)
- Test: `tests/cases-orientation.test.js`, `tests/cases-orientation-unattended.test.js` (extend)

**Interfaces:**
- Produces: `buildOrientation({ …, progress = null, abandoned = [], lastFailure = null })`.
  - `briefLines`: the objective line gains ` (proposed by the model; the owner has not confirmed it)` or, for origin `file`, ` (changed outside the app; not confirmed)` when the objective row is proposed; the success-criteria line becomes `- Success criteria: 3 confirmed, 2 proposed; see Progress` when `progress` is given, and stays as it is when it is not.
  - `## Progress (computed by King Louie; you cannot set these)` directly after `## Brief`: the summary line; one line per row (`- sc-001 [met] <text, one line, at most 160 characters> (evidence f-0042, f-0051)`, `[stale] … (<first reason>)`, `[proposed, not counted] …`); the `Ready to close:` line made of item ids and refs grouped `Owner:` / `Case:`. At most 2,500 characters; rows past the cap become `- … N more; Progress status lists them`. With no criteria: `- No success criteria yet.` For a frozen case the heading ends ` — as of <date>`.
  - `## Abandoned approaches (do not retry one without a new fact; say what changed if you do)` after the load-bearing unknowns, from `abandonedLines`; left out when there is none and no `lastFailure`. When `lastFailure` is given (the case's `statusReason.kind` is `direction`; the runtime derives `journal/<attr>.md` from the direction fact named by `statusReason.ref`), the section ends with `- The last failure report is journal/<name>.md. If the approach it describes is dropped, record it with Progress abandon.`
  - Each new input is read in `CaseRuntime.orientation` through its `safely` wrapper.

- [ ] **Step 1: Write the failing tests.** `tests/cases-orientation.test.js`: the section order (Brief, Progress, load-bearing unknowns, Abandoned approaches); the spec's example rows; a proposed objective's mark for origins `model` and `file`; both caps, with the "more" lines; a criterion text holding a newline or 400 characters is one cut line; no `progress` input gives exactly today's output (compare with a snapshot taken before the change in the same test file, built from the same inputs); a frozen case's heading; "a resumed case names its last failure report". `tests/cases-orientation-unattended.test.js`: an orientation built by the runtime for a case with no stage files has the Progress section from the in-memory view and writes no file.
- [ ] **Step 2: Run** `node --test tests/cases-orientation.test.js tests/cases-orientation-unattended.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** The new sections are part of `head`, which is never trimmed; the fact budget shrinks by their length (no other change to the budget code).
- [ ] **Step 4: Run** the two files and `node --test tests/cases-runtime.test.js tests/mcp-case-tools.test.js tests/cases-regressions.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/orientation.js src/cases/case-runtime.js tests/cases-orientation.test.js tests/cases-orientation-unattended.test.js
git commit -m "feat(cases): the orientation shows each criterion's state, the ready-to-close list and the abandoned approaches"
```

---

## Task 12: IPC for progress and scope

Stream C(i), first. Parallel with Task 14.

**Files:**
- Create: `src/ipc/case-progress-handlers.js`
- Modify: `src/ipc/constants.js` (`CASE_PROGRESS: 'case:progress'`, `CASE_CONFIRM_SCOPE: 'case:confirmScope'`), `src/ipc/register.js`, `preload.js` (`cases.progress`, `cases.confirmScope`, with the field checks its neighbours use), `src/ipc/case-unattended-handlers.js` (`case:setStatus` returns `progress`)
- Test: `tests/cases-progress-ipc.test.js` (new), `tests/cases-ipc.test.js` (extend)

**Interfaces:**
- Produces:
  - `case:progress` `{ caseId }` → `{ ok: true, untrustedText: true, frozen, objective, criteria, summary, readiness, abandoned: { count, records }, check: null }`. Each evidence entry carries `{ id, holds, provenance, sourceKind, label }` (R-C8-5). No lock, no write.
  - `case:confirmScope` `{ caseId, action, target, hash, text }` → `{ ok: true, progress }` through `runtime.applyScopeAction(…, { by: 'owner-action', channel: 'in-app' })`. Refusals `{ ok: false, code, error }` for `SCOPE_STALE`, `CRITERION_NOT_FOUND`, `CRITERION_INVALID`, `CRITERION_DUPLICATE`, `CRITERION_LIMIT`; `CASE_BUSY` gives the existing busy message. `action` outside the four, or a `target` that is not `'objective'`, `'all-proposed'` or `^sc-\d{3,}$`, is refused before the runtime is called.
  - `case:setStatus` is unchanged in what it allows (never refused for an open item); its reply gains `progress` (the frozen record after `done`).
  - Both new channels are in the `case` domain, which `PROXIED_DOMAINS` already proxies; no allowlist change.

- [ ] **Step 1: Write the failing tests.** `tests/cases-progress-ipc.test.js`, with the fake `ipcMain` pattern of `tests/cases-ipc.test.js`: the reply shape and `untrustedText: true`; a read changes no file; confirm one, confirm `all-proposed`, drop, edit, add; `SCOPE_STALE` with an old hash; a bad `action` and a bad `target` are refused and the runtime is not called; a held case lock (another turn id) gives the busy message; "case:setStatus done is never refused for an open item"; after `done` the reply's `progress.frozen` is true. In `tests/cases-ipc.test.js` assert the two constants exist and the handlers are registered.
- [ ] **Step 2: Run** `node --test tests/cases-progress-ipc.test.js tests/cases-ipc.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two files and `node --test tests/electron-boundary.test.js tests/desktop-bridge-allowlist.test.js tests/preload-bridge.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/ipc/case-progress-handlers.js src/ipc/constants.js src/ipc/register.js src/ipc/case-unattended-handlers.js preload.js tests/cases-progress-ipc.test.js tests/cases-ipc.test.js
git commit -m "feat(cases): IPC to read a case's progress and to confirm, drop, edit or add scope as the owner"
```

---

## Task 13: The panel's Progress block and the two cards

Stream C(i), second.

**Files:**
- Modify: `renderer.js` (a `renderCaseProgressSection(chat, container)` beside `renderCaseUnattendedSection`, its slot in the case panel, the `case:changed` listener, the question card for `scope-confirm` and `close-proposal`, the Done confirm), `index.html` (only if the panel's slots are declared there), `styles.css`
- Test: `tests/renderer-progress-text.test.js` (new)

**Behaviour:**
- The block: the summary line; the objective with its mark and **Confirm** and **Edit** when proposed; one row per criterion: id, a text state tag (`met`, `stale`, `failing`, `unmet`, `proposed`), the text, then for a confirmed row its evidence ids each followed by its provenance in words ("from the owner", "sourced", "reported by an executor") and the first reason when stale or failing; **Confirm** and **Drop** on a proposed row; **Confirm all** when more than one row is proposed (it sends every proposed row's hash); an **Add** field; the ready-to-close list in two groups ("Yours" and "The case's") showing each open item's `fix`; the abandoned records collapsed under a count. A legacy row shows "from before progress was tracked"; a `file` row "changed outside the app". A frozen case shows the record with "as of <date>" and no buttons; a `done` case with no record shows "Closed before progress was tracked."
- Every button calls `window.electron.cases.confirmScope` with the `hash` the row was drawn with; `SCOPE_STALE` redraws and says "This changed; check it again." A second click while a call is in flight is ignored.
- The block redraws on `case:changed` whose `what` is `progress`, `questions`, `status` or `turn` (when `running` is false).
- The card for `scope-confirm` (spoken) shows the question's options as today plus, under them, the live rows from `cases.progress` with Confirm and Drop; the card for `close-proposal` (pressed) shows the live summary and open items above its two buttons, with each met criterion's evidence and provenance. "Mark done" is never disabled for an open item.
- The panel's **Done** button: its confirm dialog shows the summary line and the open items (from `cases.progress`) before the existing wording.
- Every case string is set with `textContent`. The only `innerHTML` uses in the new code clear a container (`= ''`).

- [ ] **Step 1: Write the failing test.** `tests/renderer-progress-text.test.js`, modelled on `tests/renderer-playbooks-text.test.js`: extract the source of `renderCaseProgressSection` and of the two card branches from `renderer.js`; assert there is no `insertAdjacentHTML`, `outerHTML`, `marked` or `innerHTML +=`, and that every `.innerHTML =` assigns `''`; "each evidence id is drawn with its provenance" (the block's source reads `provenance` for every evidence entry it draws); the state tag is text (the source sets `textContent` from the state name).
- [ ] **Step 2: Run** `node --test tests/renderer-progress-text.test.js` — expected: fails (no such function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/renderer-progress-text.test.js tests/renderer-playbooks-text.test.js tests/renderer-sources-text.test.js` — expected: `# fail 0`. Then check by hand in the app (`unset ELECTRON_RUN_AS_NODE && npm start`, a throwaway case): a proposed criterion, Confirm, a `stale` row after a correction, the close card. Say in Deviations what you saw.
- [ ] **Step 5: Commit.**

```bash
git add renderer.js index.html styles.css tests/renderer-progress-text.test.js
git commit -m "feat(cases): the case panel shows progress and lets the owner confirm scope; the close card shows the list"
```

---

## Task 14: Progress over MCP and in the chat's management tools

Stream C(ii). Parallel with Tasks 12 and 13.

**Files:**
- Modify: `src/mcp/case-tools.js` (`openCase`, `listCases`)
- Test: `tests/mcp-case-tools.test.js`, `tests/management-tools.test.js`, `tests/frontdoor-case-tools.test.js` (extend)

**Interfaces:**
- Produces:
  - `list_cases` rows gain, bare: `criteria: { confirmed, met, proposed }` and `ready: boolean`.
  - `open_case`'s `data` (inside `untrusted()`) gains `progress: { frozen, summary, objective: { state, origin } | null, criteria: [{ id, text, state, verification, evidence: [{ id, provenance }], reason }], readiness: { ready, items: [{ id, state, by, fix, refs }] }, abandoned: { count, newest: [{ id, approach, why }] } }` (`newest` is at most 5; `state` is `proposed` or `confirmed`, `verification` is `null`, `unmet`, `met`, `stale` or `failing`).
  - `get_orientation` needs no change (Task 11 changed the text).
  - No tool, no scope and no entry in `CASE_SCOPES` is added; `CASE_MCP_TOOLS` is unchanged except that `open_case`'s and `list_cases`'s descriptions name the new fields. `CASE_SCOPED_TOOLS` and `NO_CASE_DATA` (`src/cases/chat-attach.js`) are unchanged.
  - A read that throws while building `progress` gives `progress: { error: 'progress could not be read' }` and the rest of the reply as today.

- [ ] **Step 1: Write the failing tests.** `tests/mcp-case-tools.test.js`: `open_case` carries `progress` inside the untrusted wrapper and nowhere outside it; `list_cases` counts are numbers outside the wrapper; a case with no stage files gives legacy/proposed rows and writes nothing. `tests/management-tools.test.js`: in a case chat (`caseScope` set) `open_case` of another case is still refused `other_case`; `answer_question` refuses `close-proposal` and `check-approve` (build a record with that payload type directly) on `in-app-chat`. `tests/frontdoor-case-tools.test.js`: `open_case` under `cases:read` returns `progress`; `answer_question` under `cases:answer` on a `scope-confirm` question confirms it and on a `close-proposal` is refused; the registered scopes are exactly the three of today.
- [ ] **Step 2: Run** `node --test tests/mcp-case-tools.test.js tests/management-tools.test.js tests/frontdoor-case-tools.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files and `node --test tests/case-chat-attach.test.js tests/mcp-stdio.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/mcp/case-tools.js src/cases/mcp-tool-definitions.js tests/mcp-case-tools.test.js tests/management-tools.test.js tests/frontdoor-case-tools.test.js
git commit -m "feat(cases): open_case and list_cases carry progress; no new tool and no new scope"
```

---

## Task 15: The check command, part 1: naming and approving it (nothing runs)

After stream C. Behind `cases.softwareRepo.check.enabled`, default **false**.

**Files:**
- Create: `src/cases/verify/check.js` (this task: `validateCheck`, `checkInQuote`, `CheckStore`, `checkPolicy`, `resolveProgram`)
- Modify: `src/cases/case-types/software-repo.js` (`briefFields` gains `check`), `src/cases/defaults.js` (`softwareRepo.check`; correct the header comment), `src/service/config.js` (`caseChecks` in `ADMIN_ONLY_KEYS`, default `{ enabled: false }`, unknown keys rejected as its neighbours do), `src/core/create-core.js` (the `CaseRuntime` host gains `caseChecks: { isService: serviceMode, enabled: <the admin file's caseChecks.enabled, true only when it is exactly true> }`, built from the `serviceMode` local that the playbooks and executors wiring already uses), `src/tools/builtin/case-tools.js` (the `Brief` tool's `check` branch, and `check` in its `field` enum and `BRIEF_TEXT_FIELDS`), `src/cases/verify/questions.js` (`checkQuestionText`, the `check-approve` handler), `src/ipc/case-progress-handlers.js` + `src/ipc/constants.js` + `preload.js` (`case:setCheck`), `renderer.js` (the check row in the Progress block)
- Test: `tests/cases-check.test.js` (new), `tests/cases-case-types.test.js`, `tests/service-config.test.js`, `tests/cases-progress-ipc.test.js` (extend)

**Interfaces:**
- Produces:
  - `validateCheck(value)` → the normalised command (single spaces) or throws with code `CHECK_INVALID` and a reason: 1 to 200 characters; 1 to 12 tokens split on single spaces; every token matches `^[A-Za-z0-9_./:=@,+-]+$`; the first token is not an assignment (holds `=`), does not start with `-`, holds no `..` segment, is not absolute, and its base name (lower-cased, `.exe` stripped) is not in `REFUSED_PROGRAMS = ['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'sudo', 'doas', 'curl', 'wget', 'ssh', 'scp', 'npx', 'bunx', 'pnpx', 'eval', 'exec', 'xargs']`; no token is one of `-c`, `-e`, `--eval`, `-p`, `--print`, `--exec`, alone or followed by `=` and a value.
  - `checkArgv(command)` → `string[]`. `checkHash(argv, repoRealPath)` → `'sha256:…'` over `JSON.stringify({ argv, repo })`.
  - `checkInQuote(command, quote, ownerMessage)` → boolean: `command` appears in both, compared **exactly** (case kept, single spaces), as one contiguous run whose neighbours on both sides are the string's edge, white space, a quote mark or a backtick.
  - `class CheckStore { constructor(dir, { now }) }`, file `.kl/checks.json` (spec §7.4): `read()`, `approve({ argv, repo, by, ref, channel })`, `withdrawAll()`, `isApproved(argv, repo)`, `addRun(run)` → `chk-NNNN` (keeps 20), `newestRun()`, `runFor({ head, dirty })`.
  - `checkPolicy(runtime)` → `{ enabled, reason }`: in service mode (`runtime.host.caseChecks?.isService === true`) `enabled` is `runtime.host.caseChecks.enabled === true` and a data-dir `cases.softwareRepo.check.enabled` is ignored with one warning (`reason: 'CHECK_SERVICE_OFF'` when off); otherwise `settings.softwareRepo.check.enabled === true` (`reason: 'CHECK_DISABLED'` when off).
  - `resolveProgram(argv, { platform, env, cwd, fsCheck })` → `{ file, args }` or throws: uses `resolveCommand` from `src/service/doctor-runbooks.js`; a path → `{ file: path, args: argv.slice(1) }`; on `win32`, a `cmdShim` for `npm` → the `node.exe` that `resolveCommand('node', …)` finds and, beside it, `node_modules/npm/bin/npm-cli.js` when that file exists → `{ file: <node.exe>, args: [<npm-cli.js>, ...argv.slice(1)] }`; any other `cmdShim` → code `CHECK_SHIM`; nothing found → code `CHECK_NOT_FOUND`. **No branch returns `cmd.exe` or sets a shell.**
  - Brief field: `{ name: 'check', kind: 'text', userOnly: true, validate: validateCheck }`. The `Brief` tool, for `field: 'check'` with `provenance: 'user'`: after `requireOwnerQuote`, `checkInQuote(value, check.quote, ctx.ownerMessages[check.messageIndex])` or `{ ok: false, code: 'CHECK_NOT_IN_QUOTE', … }`; refuses `CHECK_NO_LOCAL_REPO` when the brief's `repo` is a clone URL or missing; on success writes the field and calls `runtime.requestCheckApproval(caseId)`.
  - `CaseRuntime.requestCheckApproval(id)`: closes any open `check-approve` question (`by: 'system'`), then `createQuestion` with `kind: 'question'`, `urgency: 'normal'`, `text: checkQuestionText(meta, { argv, repo })` (the card of spec §6.6: program, arguments, where, when, and the sentence that it cannot be made read-only), options `approve` "Approve" and `refuse` "Do not run", `payload: { type: 'check-approve', key: 'check-approve', mcpAnswerable: false, disclosable: false, hash }`, `charge: false`.
  - Handler `check-approve`: `approve` from a `PRESS_CHANNELS` channel, with the brief's current command and repository still hashing to `payload.hash` → `CheckStore.approve`; a changed command → not applied, a note, and a fresh question; `refuse` → nothing recorded; any other channel → not applied.
  - `case:setCheck` `{ caseId, command, approved }`: `command` (a string) validates, writes `brief.check` with provenance `user` inside `systemAction`, and requests approval → `{ ok, check, questionId }`; `approved: false` → `withdrawAll()`; refusals `CHECK_INVALID`, `CHECK_NO_LOCAL_REPO`, `CHECK_DISABLED`, `CHECK_SERVICE_OFF`, `CHECK_SHIM`. `case:progress`'s `check` becomes `{ enabled, reason, command, approved, lastRun }` for a `software-repo` case and stays `null` otherwise.
  - Panel: for a `software-repo` case, one row: the command (or a field to type one), "approved" or "waiting for your approval", the last result, and "Stop running it". When the policy is off the row says so and offers nothing.

- [ ] **Step 1: Write the failing tests.** `tests/cases-check.test.js`:
  - `validateCheck` accepts `npm test`, `npm run test:unit`, `node --test tests/unit`, `./gradlew test`, `cargo test --locked`, `make check`; refuses, each by name: an empty string, 13 tokens, a double space, each of `;`, `&`, `|`, `<`, `>`, `$`, a backtick, `(`, `*`, `?`, `~`, `!`, `%`, `^`, a backslash, a quote, a newline; `FOO=1 npm test`; `-rf x`; `../x/run`; an absolute path; each name in `REFUSED_PROGRAMS` with and without `.exe` and in upper case; `node -e 1`, `node --eval 1`, `node --eval=1` and `node --print=1` (the flag rule covers a listed flag alone and a listed flag followed by `=`);
  - `checkInQuote`: the whole command in backticks, in quotes, at the end of a sentence followed by a space; refused when the case differs, when a word is missing, when the tokens are spread across the message, and when it is a prefix of a longer command (`npm test` inside `npm test:all`);
  - `CheckStore`: "an approval covers one command and one repository" (another argv or another repo path is not approved); `withdrawAll`; 20 runs kept; ids count up;
  - `checkPolicy`: "nothing runs while the setting is off" (the default → `CHECK_DISABLED`); "service mode needs the admin key" (a data-dir `enabled: true` with `host.caseChecks = { isService: true, enabled: false }` → `CHECK_SERVICE_OFF`, one warning; with `enabled: true` there → on);
  - `resolveProgram` with an injected `platform: 'win32'` and `fsCheck`: an `.exe` on PATH resolves; `pnpm` present only as `pnpm.cmd` → `CHECK_SHIM`; `npm` as `npm.cmd` with `node.exe` and `npm-cli.js` present → `node.exe` + the script + the arguments; `npm` without `npm-cli.js` → `CHECK_SHIM`; and on `linux` a PATH hit resolves. Assert no result's `file` ends in `cmd.exe`;
  - the `Brief` tool: `check` with a quote holding the exact command → written and one `check-approve` question whose text holds the program and arguments on their own lines; with the command reworded in the quote → `CHECK_NOT_IN_QUOTE`; without `provenance: 'user'` → the existing owner-only refusal; on a `general` case → the existing "only for software-repo cases" refusal; with a clone-URL `repo` → `CHECK_NO_LOCAL_REPO`;
  - the approval: `approve` from `in-app` records it; from `in-app-chat` and `mcp-stdio` it does not; changing the command after the question was asked and then pressing does not approve the new command.
  - `tests/cases-case-types.test.js`: `briefFields()` now has `repo` and `check`. `tests/service-config.test.js`: `caseChecks` in the service's own file is ignored with the admin-only warning; in the admin file `{ enabled: true }` is read; an unknown key under it is rejected. `tests/cases-progress-ipc.test.js`: `case:setCheck` and the `check` part of `case:progress`.
- [ ] **Step 2: Run** `node --test tests/cases-check.test.js tests/cases-case-types.test.js tests/service-config.test.js tests/cases-progress-ipc.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Nothing in this task spawns a process. If `src/cases/` requiring `src/service/doctor-runbooks.js` trips a boundary test, move `resolveCommand` (and what it needs) to `src/platform/resolve-command.js`, re-export it from `doctor-runbooks.js`, and say so in Deviations. Add `caseChecks` to the four `examples/fleet/*/service.json` files only if `tests/examples.test.js` requires every admin key to be listed (run it; say what you found).
- [ ] **Step 4: Run** the four files and `node --test tests/cases-tools.test.js tests/electron-boundary.test.js tests/examples.test.js tests/renderer-progress-text.test.js` — expected: `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify/check.js src/cases/verify/questions.js src/cases/case-types/software-repo.js src/cases/defaults.js src/service src/tools/builtin/case-tools.js src/ipc preload.js renderer.js src/cases/case-runtime.js tests examples
git commit -m "feat(cases): a software-repo case can be given a check command and the owner approves it once; nothing runs yet"
```

---

## Task 16: The check command, part 2: running it at the close of an owner turn

**Files:**
- Modify: `src/cases/verify/check.js` (`runCheck`, `closeCheck`), `src/cases/verify/evidence.js` (the `chk-` resolver), `src/cases/verify/readiness.js` (`check-passing`), `src/cases/verify/judge.js` (the newest run in the input and in the block), `src/cases/case-runtime.js` (`_closeProgress` step 1; `progress` passes `newestCheck`; `.gitignore` already covers `.kl/runs/`)
- Create: `tests/fixtures/cases/check/` (small `node` scripts: `pass.js`, `fail.js`, `sleep.js` that also starts a child, `print-env.js`)
- Test: `tests/cases-check.test.js` (extend), `tests/cases-verify-status.test.js`, `tests/cases-verify-readiness.test.js`, `tests/cases-progress-tool.test.js` (extend)

**Interfaces:**
- Produces:
  - `runCheck({ argv, cwd, timeoutMs, envAllow = [], signal = null, platform, env })` → `{ result: 'pass' | 'fail' | 'timeout' | 'spawn-failed', exitCode, timedOut, ms, tail }`. `resolveProgram`, then `child_process.spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: <built>, detached: platform !== 'win32' })`. The environment is built from nothing: `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `LANG` copied when set, each name in `envAllow` copied when set, then `CI=1` and `KL_CASE_CHECK=1`. Each stream is read to its end and only its last 2,000 characters kept. On the time limit or `signal` abort: kill the tree (`taskkill /pid <pid> /T /F` through `execFile` on `win32`; `process.kill(-pid, 'SIGKILL')` elsewhere), then await the child's `close`. Never rejects.
  - `closeCheck(runtime, turn)` → `null` or `{ run, baseline }`. Returns `null` (and runs nothing) unless **all** hold: `turn.source === 'owner'`; `checkPolicy(runtime).enabled`; the case type is `software-repo`; the brief has `repo` (a local path that exists) and `check`; `CheckStore.isApproved(argv, pathKey(repo))`. Then it refreshes the snapshot (`refreshCaseType`), and runs only when the new `head` or `dirty` differs from `turn.marks.head`/`turn.marks.dirty`, or no run exists for the current head. A missing or stale snapshot → no run. One run at a time per repository path in the process (a `Map` keyed by `pathKey`; a second caller gets `null` and logs `CHECK_BUSY`). `timeoutMs` is `settings.softwareRepo.check.timeoutMs` clamped to at most 900,000 (default 120,000). The run is recorded with `CheckStore.addRun({ hash, head, dirty, result, exitCode, timedOut, ms, turnId })`; the tail goes to `.kl/runs/checks/<id>.txt`. `baseline` is `runFor({ head: marks.head, dirty: marks.dirty })`.
  - The `chk-` resolver (`ctx.checks`, `ctx.snapshot`): missing run → `evidence-missing`; `result !== 'pass'`, `dirty !== 0`, or `run.head !== ctx.snapshot.state.head`, or a missing or stale snapshot → `check-not-current` with the label of spec §6.3; else holds, `provenance: 'check'`.
  - `runtime.progress` passes `newestCheck: CheckStore.newestRun()` and `checks`/`snapshot` in the resolver context, so a criterion whose record cites a check reads `failing` after a failed or timed-out newest run.
  - `closeReadiness` gains `check-passing` (`n/a` unless a check is approved and the policy is on).
  - `_closeProgress`: step 1 is `closeCheck` (guarded), before the verify pass; the pass's input gets item 6 (id, result, head, clean or not; never the tail); `verificationBlock` gets `check: { run, baseline }` and writes `- Check: pass → FAIL during this turn (chk-0012 at 3f2a91c → chk-0013 at 3f2a91c, uncommitted changes).` as its first line when the baseline passed and the run did not, or `- Check: failed at the end of this turn (no result for the turn's start).` when there is no baseline.
  - The verification hook (Task 9) already raises `criterion-regressed` for a row that went from `met` to `failing`.

- [ ] **Step 1: Write the failing tests.** In `tests/cases-check.test.js`, with a temp git repository as the case's `repo` (create it with `git init`, one commit) and the fixture scripts run as `node <fixture>` (copy the fixture into the repo and name it by a relative path so the command passes `validateCheck`):
  - `runCheck`: `pass.js` → `pass`, exit 0; `fail.js` → `fail`, exit 1; a program that is not there → `spawn-failed`; "the child sees no provider key": set `OPENAI_API_KEY`, `KL_CASES_ROOT` and `ELECTRON_RUN_AS_NODE` in the parent env passed in, run `print-env.js` (it prints the **names** of its variables), and assert none of the three is in the tail while `CI` and `KL_CASE_CHECK` are; a name in `envAllow` is passed;
  - "the time limit kills the child and its grandchild": `sleep.js` starts a child that writes its pid to a file and both sleep 60 s; with `timeoutMs: 500`, the result is `timeout` and, after the call returns, both pids are gone (`process.kill(pid, 0)` throws). Hold a ref'd timer across the await;
  - an aborted `signal` ends the run the same way;
  - only the last 2,000 characters of a long output are kept;
  - `closeCheck`: "nothing runs while the setting is off"; "a wake-up turn never runs the check" (`turn.source === 'wakeup'` with everything else in place → `null`, and a spy on `runCheck` was not called); not approved → `null`; a `general` case → `null`; "the close run happens only when head or dirty changed" (no change and an existing run for the head → `null`; a new commit → a run; a dirtied tree → a run); a stale snapshot → `null`; two concurrent calls on one repository → one run;
  - the tail is under `.kl/runs/checks/` and `git status --porcelain` of the case shows no such file; `.kl/checks.json` holds the run without any output;
  - "pass to fail writes the journal line first": a baseline pass at the turn's start, a failing close run → the turn's journal entry's first line under the heading is the `pass → FAIL` line.
  - `tests/cases-verify-status.test.js`: the `chk-` resolver at another head, with `dirty: 4`, with `result: 'fail'`, and holding. `tests/cases-verify-readiness.test.js`: `check-passing` in each state. `tests/cases-progress-tool.test.js`: the `failing` case of `proposeDone` (remove the `todo` from Task 10 if one was left).
- [ ] **Step 2: Run** `node --test tests/cases-check.test.js tests/cases-verify-status.test.js tests/cases-verify-readiness.test.js tests/cases-progress-tool.test.js` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Use `turn.signal` as the run's `signal`, so the owner's Stop and shutdown (`abortUnattended` does not reach owner turns; the turn's own abort does) end it. Do not add a `cmd.exe` path, whatever a test on Windows suggests: a shim is refused (N1).
- [ ] **Step 4: Run** the four files and `node --test tests/cases-verify-judge.test.js tests/cases-runtime.test.js tests/cases-turn-runner.test.js tests/cases-stop.test.js tests/cases-case-types.test.js` — expected: `# fail 0`. Run `tests/cases-check.test.js` twice in a row and confirm it exits promptly both times (no leaked child).
- [ ] **Step 5: Commit.**

```bash
git add src/cases/verify src/cases/case-runtime.js tests/cases-check.test.js tests/cases-verify-status.test.js tests/cases-verify-readiness.test.js tests/cases-progress-tool.test.js tests/fixtures/cases/check
git commit -m "feat(cases): an approved check runs at the close of an owner turn when the tree changed; a failing run marks its criteria failing"
```

---

## Task 17: The regression fixture and the end-to-end check

**Files:**
- Modify: `tests/cases-regressions.test.js` (fixture **F8-progress**), `tests/e2e/cases.test.js` (or a new `tests/e2e/case-progress.test.js` if that file's `launchApp` seed does not fit)
- Test: the same

**Behaviour:**
- **F8-progress** (unit, scripted provider): a "Lakeside lot" case; the model appends two criteria (both `proposed`); the owner confirms one by a quote through the `Brief` tool and one through `applyScopeAction`; gating completes; a turn records `f-0042` (`sourced`) and the scripted verify reply cites it → that criterion is `met` and the journal entry starts with the verification block; a later turn supersedes `f-0042` → `stale`, a `criterion-regressed` trigger, and `Progress.proposeDone` returns `NOT_READY`; a new fact and a new accepted verdict → both `met`; `proposeDone` succeeds; the answer `done` over `in-app` sets the case `done` and `runtime.progress` returns the frozen list. One `it` per step, sharing the case.
- **E2E** (`launchApp({ seed })`, `KL_CASES_ROOT` seeded with one case that has a proposed criterion, a confirmed `unmet` one, and an open `close-proposal` question; build the seed with the real stores in the test's setup): the case panel shows the summary line and a row tagged `proposed`; clicking its Confirm (through `page.evaluate(() => document.getElementById(id).click())`) changes the tag to `unmet`; the close card in the case's chat shows the summary line, an open item and the two buttons; clicking "Keep working" settles the card and the case stays `active`. Dismiss the onboarding wizard with `#wizard-skip-btn`.

- [ ] **Step 1: Write the tests** as above.
- [ ] **Step 2: Run** `node --test tests/cases-regressions.test.js` — expected: `# fail 0` (the mechanisms exist; a failure here is a real defect: fix it in the module that owns it and name the fix in Deviations). Then `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js` (or the new file) — expected: `# fail 0`.
- [ ] **Step 3: Commit.**

```bash
git add tests/cases-regressions.test.js tests/e2e
git commit -m "test(cases): the verified-progress regression fixture and its end-to-end check"
```

---

## Task 18: The documents, the guard tests, and the one full test run

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-cases-stage8-verified-progress.md` (§16 Deviations: add what the tasks' Deviations entries recorded; status line to "Built"), `CLAUDE.md` (a new section), `tests/cases-case-guard.test.js` or `tests/cases-tools.test.js` (the write-guard tests), this plan (tick the boxes)
- Do not modify: `CONTEXT.md`.

**Steps:**

- [ ] **Step 1: Write-guard tests.** In the `describe` that already covers `isProtectedCasePath` (`tests/cases-tools.test.js`, "isProtectedCasePath hardening"), add one named test per new file: `Write`, `Edit` and `MultiEdit` to `.kl/scope.json`, `.kl/abandoned.jsonl`, `.kl/verification.json`, `.kl/checks.json` and `.kl/runs/checks/chk-0001.txt` are each refused in a case turn through the `ToolExecutor` (follow "ToolExecutor ledger write guard" in the same file). They pass with no code change (the whole of `.kl/` is guarded); they are there so a later narrowing of the guard fails loudly. Run `node --test tests/cases-tools.test.js` — expected: `# fail 0`.
- [ ] **Step 2: Confirm what did not change**, each by its own test file: `node --test tests/cases-store-yaml.test.js` (`CASE_YAML_KEYS` untouched: no key was added; if a task added one, add it to `CASE_YAML_KEYS` and to this test and say why in Deviations); `node --test tests/management-tools.test.js tests/frontdoor-case-tools.test.js` (the MCP tool list and the three scopes are as before; only two descriptions changed); `node --test tests/electron-boundary.test.js tests/cases-leaks.test.js`.
- [ ] **Step 3: `CLAUDE.md`.** Add a section `## Cases: verified progress (stage 8)` after `## Cases: document ingest (stage 7)`, in the style of its neighbours, covering: the spec path; `brief.md` keeps strings and `.kl/scope.json` holds who wrote each criterion (origins; `proposed` counts for nothing; only an owner quote whose words contain the criterion, an owner action, or an answered question confirms; the model never changes a confirmed one); gating needs one confirmed criterion and tests use `tests/helpers/case-scope.js`; `.kl/abandoned.jsonl` (append-only, never indexed across cases, `Fail` does not write it); states are computed on every read and the stored cache is never trusted; a verification record is written only by `acceptVerdict`; evidence resolvers by prefix and where a later stage plugs in (`registerEvidenceSource`, `registerEvidenceResolver`); the verify pass (role, when it is skipped, what it is given, that it never sees prose, that it never fails a turn); ready to close and `Progress.proposeDone` (`NOT_READY`; the owner's Done is never refused); the three question types and their classes; a press is `in-app` or `mobile`; frozen at close; the check command (off by default, the admin key in service mode, owner turns only, approved once, no shell and no `cmd.exe`, `CHECK_SHIM`, the scrubbed environment, output never tracked); the residuals in two lines (Bash can write every new file; `sourced` is model-declared; the check runs the repository's code).
- [ ] **Step 4: The spec.** Add the tasks' recorded deviations to §16 and set the status line to `Built (plan 2026-10-13-cases-stage8-verified-progress.md)`. Keep §2 as it is.
- [ ] **Step 5: The full suite, once, by the controller.** `npm test` — expected: `# fail 0`. Then `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`. A failure is fixed in the module that owns it, with its covering test file re-run, and recorded in Deviations.
- [ ] **Step 6: Commit.**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-13-cases-stage8-verified-progress.md docs/superpowers/plans/2026-10-13-cases-stage8-verified-progress.md tests/cases-tools.test.js
git commit -m "docs(cases): stage 8 in CLAUDE.md, the spec's deviations, and guard tests for the new case files"
```

---

## Decisions

Made while writing the tasks; each can be overturned in review.

1. **One writer for scope.** Every path that changes a criterion or the objective goes through `CaseRuntime.writeScope` or `applyScopeAction`, so the brief and the scope file cannot drift inside one process. `Brief.update` and `Brief.append` stay as they are for every other field and for callers outside these paths; a string they add without the scope writer is found by the next `reconcile` and reads `file`/`proposed`, which is the safe direction.
2. **A corrupt scope file reads as "migrated".** Its strings become `file`, not `legacy`: both are `proposed`, and `file` does not claim the case was never tracked.
3. **Provisional ids.** A read before the first locked write shows ids that the write will assign in the same order; a confirm is bound to the hash as well as the id, so a wrong guess refuses (`SCOPE_STALE`) rather than confirming another criterion.
4. **`pendingProposals`** is read by `readiness.js` the way `src/mcp/case-tools.js` reads it, or moved to `src/cases/ingest/`, whichever keeps `src/cases/` from requiring `src/mcp/` (Task 6).
5. **Tool results are capped twice** (in the send path and again in `collectTurnEvidence`), because the runtime does not trust its caller for what reaches a model.
6. **The verify pass's request mode** reuses `runVerifyPass` with `mode: 'request'` and no "nothing was written" skip (Task 10).
7. **The check's admin key is `caseChecks`** at the top level of the admin `service.json`, beside `playbooks` and `executors`, so the existing admin-only mechanism covers it unchanged.
8. **`npm` on Windows** is run as `node.exe` with `npm-cli.js` (the project's own advice in `doctor`), and nothing else is special-cased (N1).

## Not in this plan

- Structured child hand-off as an evidence source; the seam is `registerEvidenceSource` and `registerEvidenceResolver` (spec §6.10).
- Refusing or flagging a `Plan` step that repeats an abandoned approach.
- Recording which PRs and branches a `software-repo` case created.
- A way out of `done`.
- A sandbox for the check; shims other than `npm` on Windows (N1); an owner "Check now" button (N2); an objective field in the create form (N3).
- Per-criterion confirmation by a spoken answer or from the phone (the scope question offers all or none).
- Measuring the verify pass on real cases.
- Any change to `CONTEXT.md`.
