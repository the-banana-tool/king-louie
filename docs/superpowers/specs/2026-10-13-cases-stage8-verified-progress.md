# Cases Stage 8: Verified progress — Design Spec

- **Status:** Built (plan 2026-10-13-cases-stage8-verified-progress.md). Approved in outline by the
  owner's rulings of 2026-10-13 (§2) and 2026-10-14 (§2.2); what the build changed is §16.1.
- **Date:** 2026-10-13
- **Parent:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` §3.1 (principles), §4.3
  (`brief.md`), §4.5 (`.kl/`), §5.2 (orientation), §5.3 (triggers), §5.5 (turn lifecycle), §5.6 (case
  tools), §7.1 (recommendation gate), §9 (budgets, roles).
- **Builds on:** stage 2 (`2026-09-23-cases-stage2-unattended.md`: status, questions, budgets, wake-ups,
  roles), stage 3 (`…-stage3-executors.md` §3.5, §3.6, §3.14: jobs, envelopes, `external-agent` facts), stage 5
  (`…-stage5-detours.md`: case types, `software-repo`), stage 7 (`…-stage7-ingest.md` §3.3: the verify
  verdict; §3.7, §3.8: the case tools over MCP), management surfaces (`2026-09-30-management-surfaces.md`: spoken and pressed, the chat card,
  the case tools over MCP), models (`2026-09-27-model-catalog-profiles-roles-design.md`: roles, usage).
- **Depends on:** C1 to C7 and the management surfaces, all on `main` (a6189a7).
- **Agreed in outline with the owner on 2026-10-12.** The outline is the five parts of §1. The ten
  questions of the first draft were ruled on 2026-10-13 (§2). An eleventh ruling of the same day
  (R-C8-11, "the verify pass runs after the reply") was made while the stage was being built; §6.5,
  §6.9, §11, §13 and §18 are written to it.

## 1. Outcome

A case can say how far along it is, and the answer comes from the record, not from what the model wrote.

1. **Scope the model proposed is marked.** A success criterion the model added without the owner's words
   is `proposed` and counts for nothing until the owner confirms it. The objective carries the same mark
   until the owner confirms it.
2. **What the case gave up on is kept.** An approach the case tried and dropped is one line in an
   append-only record that every later orientation shows, so the case does not walk the same road twice.
3. **Each confirmed criterion has a state only code sets:** `unmet`, `met`, `stale` or `failing`. `met`
   needs a verification record whose evidence is active facts of the right provenance (or, in a
   `software-repo` case, a check that passed at the current commit). A corrected fact or a moved tree
   makes it `stale` by itself.
4. **"Ready to close" is a list code computes:** criteria met, load-bearing unknowns resolved, questions
   answered, jobs settled, envelopes closed, tree clean, and so on, each with who has to do what.
5. **A verify pass at turn close reads the record.** When a turn wrote facts, decisions or executor
   results, one `verify`-role call sees the confirmed criteria and those records, never the assistant's
   prose, and names evidence per criterion. Code accepts `met` only when every cited id checks out.

The model proposes closing a case with a pressed question whose card shows the list. Only the owner
closes it.

## 2. Owner rulings (2026-10-13)

The first draft of this spec (84b1868) put ten questions to the owner. All ten were answered on
2026-10-13. Each row gives what was decided and what the chosen option costs or leaves open; the rest
of the spec is written the decided way and names a ruling by its id.

| Id | Question | Decided | Cost or residual of the choice |
|---|---|---|---|
| R-C8-1 | May the model propose `done` while a confirmed criterion is not `met`? | Only when every confirmed criterion is `met` (`stale` and `failing` refuse too). The owner's own Done button always works, and shows the list first | A criterion nothing in the record can show ("I'm happy with it") blocks the model's proposal until the owner says so in words (a `user` fact is evidence) or presses Done themselves |
| R-C8-2 | How is a proposed criterion confirmed, and what does gating need? | Both ways: buttons in the panel and on the scope card, and a spoken answer with a quote. Gating needs at least one `confirmed` criterion; a case already past gating is never sent back to `draft` | Over MCP (`mcp-stdio`, the front door under `cases:answer`) a quote is recorded, not checked, so a client holding that scope can confirm scope the model proposed. A new case needs one more owner step before it goes `active` |
| R-C8-3 | The check command of a `software-repo` case | Built last and off by default; approved once per exact command and repository on a pressed card; owner turns only, never in a wake-up; off in service mode until the admin enables it; at turn close only, when the tree changed in the turn; capped at 120 s | The approved words can come to mean something else when the repository changes. A criterion backed by the check goes `stale` when the repository moves while the owner is away, and stays so until an owner turn. The turn's last step can take up to the cap. Read-only and offline cannot be enforced (§6.6, §18) |
| R-C8-4 | The verify pass: when, what it costs, which role | On every changed turn, on the `verify` role, charged to `usd`; `cases.verify.maxPassesPerDay` 24; skipped once the `usd` budget has passed 80 %; `cases.verify.when` may be set to `request` | One `main`-class call per working turn: the criteria plus up to 12,000 characters of records in, at most 1,024 tokens out. The cost is estimated, not measured |
| R-C8-5 | May `external-agent` facts alone make a criterion `met`? | Yes, with each evidence fact's provenance shown on the criterion's row and on the close card | "Three written quotes received" can be `met` on what a phone agent reported and nobody checked |
| R-C8-6 | Existing cases | An open case's criteria and objective read `proposed` (origin `legacy`), with "Confirm all" in the panel. Closed cases are untouched | Each open case needs one press before anything counts; until then its summary reads "0 confirmed criteria" |
| R-C8-7 | `stale` on a case that is already `done` | Frozen at close: the states and the list are recorded when the case closes and never recomputed | A fact corrected later through another path is not reflected in a closed case. There is still no way out of `done` |
| R-C8-8 | A change to `brief.md` made outside the case tools | Not confirmed: origin `file`, shown as "changed outside the app" | The owner's own edit in an editor needs one press to count, because code cannot tell it from a `Bash` write |
| R-C8-9 | Which tool results the verify pass sees | Case-tool results only (`Ledger`, `Decide`, `Executor`, `Ingest`, `Progress`) | The pass does not see a `Bash` or `WebFetch` result the turn relied on; it sees the facts recorded from them |
| R-C8-10 | Does `Fail` add to the abandoned-approaches record? | No. Only `Progress.abandon` writes it | After a direction answer the model has to record the dead approach itself; §6.2 gives it one host line that names the failure report |
| R-C8-11 | Does the owner wait for the verify pass? (asked after the pass was built inside the turn's close, where a reply waited up to 20 s for it) | No: **the verify pass runs after the reply.** The turn commits and releases the case at once; the pass makes its call with no lock held and writes its result when it lands (§6.5, §6.9) | A criterion reads its old state for the seconds the pass is out. A turn that starts in that time drops the pass's result; the case's next verified close runs the pass again. What the pass found is a journal entry of its own, not the first lines of the turn's entry |

### 2.2 Owner rulings (2026-10-14)

Asked by the plan (its "New questions") after the build; each is written into this spec where it applies.

| Id | Question | Decided | Cost or residual of the choice |
|---|---|---|---|
| R-C8-N3 | `create_case` over MCP holds the objective to the quote, but the quote is recorded there, not checked (management surfaces, Q28). Is the objective confirmed? | No. Over `mcp-stdio` and `mcp-frontdoor` the case is created with its objective `proposed` (origin `mcp-create`); the owner confirms it in the app (the panel's Confirm, or a scope question answered there or on the phone). In King Louie's chat, where the quote is checked in the owner's turn, and from the app's own create form, it is `confirmed` (§6.1) | A case made over MCP needs one more owner step before its objective counts. The fact `create_case` records still carries the unchecked quote with `provenance: 'user'`, as before this stage |
| R-C8-N4 | Does the panel's **Check now** also run the check command? | No (as built). Check now runs the verify pass only; the check command runs only at the close of an owner turn in which the repository changed (§6.6) | A check result is only as new as the last owner turn that changed the tree |
| R-C8-N5 | "npm only": must the check's program be npm? | Yes (as built): the program is `npm`, and the command is `npm test` or `npm run <script>` (§6.6) | `node --test`, `make`, `cargo` and `./gradlew` cannot be a case's check. Widening is one list in `src/cases/verify/check.js` |
| R-C8-N6 | May the check pass npm options of its own or use other npm commands? | No (as built): no word that starts with `-` before the script (only after `--`), and no npm command but `test` and `run` (§6.6) | `npm test --silent` and `npm run --if-present x` are refused |

### 2.1 Checked in the code after the first draft

The first draft listed things it had not verified. Read on `main` (a6189a7):

| Point | What the code says | Effect on this spec |
|---|---|---|
| `wordsInText` (`src/tools/owner-quote.js`) | `wordsInText(words, text)` folds both sides (curly quotes, runs of white space, case) and tests the whole of `words` as one contiguous run in `text`, on word boundaries. It is not a bag-of-words test | A criterion confirmed at birth by a quote is the owner's own phrase, verbatim after folding; a paraphrase is refused and becomes a proposal (§6.1) |
| The objective at `case:create` | The renderer's create form sends a title, the chat and the playbook fields and **no objective** (`window.electron.cases.create({ title, chatId, … })`); `preload.js` and the IPC accept one. `create_case` holds its objective to the owner's quote | A desktop-created case starts with an empty objective, so its first objective is normally the model's (`Brief.update`) and is `proposed`. `objectiveBy: 'owner'` (§6.1) is passed by the IPC only when the form sent one |
| `.cmd` and `.bat` programs | The project already holds that a program started without a shell cannot be a `.cmd` or `.bat` file: `resolveCommand` in `src/service/doctor-runbooks.js` mirrors libuv's lookup (`.com`, `.exe`), reports a shim as `cmdShim`, and `doctor` tells the admin to call the `.exe` ("npm: node.exe npm-cli.js"). Whether the bundled Node would start one was not tried | The check never goes through `cmd.exe` (§6.6). `npm` is run as `node.exe` with `npm-cli.js`; any other shim is refused (`CHECK_SHIM`). Whether other shims may run is a new owner question, in the plan |
| The phone and a new question type | `QuestionItem` (`mobile/ios/KLProtocol/Sources/KLProtocol/Questions.swift`) and the Android `Questions.kt` read `kind`, `urgency`, `text` and `options` from `kl.question.ask`; no payload type is sent or read | A new pressed type shows on the phone as its text and its options with no app change. A batch over the channel's `maxChars` shows "Answer this in the app" in place of options (`renderBatch`, `src/cases/contact-format.js`), which a long close card can meet |
| Section references | Stage 2 §3.1 is the status machine, §3.9 questions, §3.10 turn close; stage 3 §3.5 is the `Executor` tool, §3.6 envelopes, §3.14 the ledger change for `external-agent`; stage 7 §3.3 is proposals and the verify check, §3.7 and §3.8 the case tools over MCP; management surfaces §3.1 lists a case's status as pressed | The header's references now carry the section numbers |

Still assumptions, each with what breaks if it is wrong: §17.

## 3. Scope

### 3.1 In

- `src/cases/scope.js`: `ScopeStore`, `.kl/scope.json`, criterion ids, `proposed`/`confirmed`, the
  objective's mark, reconciliation with `brief.md`.
- `Brief` tool changes: quote rules for `successCriteria` and `objective`; refusals for changing confirmed
  scope.
- `src/cases/abandoned.js`: `.kl/abandoned.jsonl`.
- `src/cases/verify/`: `store.js` (`.kl/verification.json`), `status.js` (pure state computation),
  `evidence.js` (the turn's evidence and the id resolvers), `judge.js` (the verify pass), `readiness.js`
  (ready to close), `check.js` (the `software-repo` check command, behind its setting).
- The `Progress` case tool (`src/tools/builtin/case-progress-tool.js`): `status`, `abandon`, `abandoned`,
  `askScope`, `proposeDone`.
- Turn lifecycle: marks at `beginTurn`, a verification turn-start hook, the verify pass and the
  host-written journal block in `endTurn`.
- Three question types: `scope-confirm`, `close-proposal`, `check-approve`, with answer handlers.
- IPC `case:progress`, `case:confirmScope`, `case:setCheck`; the panel's Progress block; the card bodies.
- `open_case`, `get_orientation` and `list_cases` carry the summary; no new MCP tool and no new scope.
- Orientation sections `Progress` and `Abandoned approaches`.
- Migration of existing cases (§10).

### 3.2 Out

| Item | Where |
|---|---|
| Structured child hand-off whose evidence feeds the verify pass | a later stage; the seam is §6.10 |
| A way out of `done` (reopen) | not planned (R-C8-7) |
| Checks for case types other than `software-repo` | not planned |
| Blocking a plan that repeats an abandoned approach | deferred (§19); the record is advice in the orientation |
| Closing the `Bash` write-guard gap | the stage 1 residual, unchanged (§18) |
| Any change to `CONTEXT.md` | a separate change once the owner has ruled on §2 |

## 4. What exists (so nothing is rebuilt)

| Piece | Where | Used for |
|---|---|---|
| Brief read/write, owner-only fields, gating | `src/cases/brief.js` (`Brief`, `USER_ONLY_FIELDS`, `GATING_REQUIRED`, `missingForGating`, `completeGating`) | Part 1 keeps `successCriteria` a list of strings and adds no front-matter key |
| Owner-quote check | `requireOwnerQuote`, `normalizeForQuote` (`src/cases/chat-integration.js`); `wordsInText`, `ownerQuoteInTurn` (`src/tools/owner-quote.js`) | Confirming at birth; the same word rule `create_case` applies to its objective |
| The `repo` field's whole-token rule | `repoInQuote`, `validateRepo` (`src/cases/case-types/software-repo.js`); the `Brief` tool's `repo` branch | The model for the check command's quote rule |
| Case-type brief fields | `briefFields()` → `Brief`'s `extraFields` (`userOnly`, `validate`) | The `check` field |
| Case-type refresh, snapshot, material | `refreshCaseType` (`src/cases/detours/hooks.js`), `.kl/case-type.json`, `caseTypeMaterial` | Head, branch, dirty count, open PRs for the list and for `stale` |
| Ledger view | `FactLedger.view()` (`status`, `supersededBy`, `provenance`, `addedBy`, `loadBearing`) | Evidence checks; "written this turn" |
| Decisions, journal | `CaseRecords` (`decisions()`, `writeJournal`, `lastJournal`) | The turn's decisions; the host-written journal block |
| Status rules | `src/cases/status.js` (`READ_OPS`, `ALLOWED`, `DENIED`, `check`), `CaseRuntime.assertWritable`, `requireReoriented` | The `Progress` ops |
| Questions | `QuestionStore` (`create`, `answer`, `findDuplicate` by `payload.key`, `registerAnswerHandler`), `CaseRuntime.createQuestion` / `answerQuestion` / `systemAction` | The three new question types |
| Spoken and pressed | `answerClass`, `PRESSED_TYPES` (`src/cases/mcp-tool-definitions.js`); `APP_ANSWER_CHANNELS` (`contact.js`), `PRESS_CHANNELS` (detour router) | The new pressed types; proof of a press |
| The chat card | `postQuestionToChat`, `questionMessageText` (`src/cases/question-chat.js`); the renderer draws from the question store | The scope and close cards |
| Triggers | `detectTriggers` hook triggers, `acknowledgedKeys`, `addTurnStartHook` | `criterion-regressed` |
| Roles, routed calls, usage | `resolveCaseRole('verify')`, `CaseRuntime.routedProvider(turn, { role })`, `ensureRoleTested`, `recordOneShotUsage` (`turn-runner.js`), `usageHook`, `UsageTracker.eventFromMetrics` | The verify pass |
| A strict verdict parser | `parseReplyObject` (`src/cases/ingest/propose.js`), `parseVerify` (`review.js`) | The shape the verify reply is held to |
| Jobs, envelopes, plan | `JobStore.list()` and `TERMINAL_STATES` (`executors/job-store.js`), `ENVELOPE_STATUSES` (`envelope.js`), `.kl/plan.json` | Ready-to-close items |
| Pending ingest proposals | `pendingProposals(dir)` (`src/mcp/case-tools.js`) | A ready-to-close item |
| Write guard | `caseWriteRefusal` (`chat-integration.js`): `PROTECTED_ROOT_DIRS` holds `.kl`, `PROTECTED_ROOT_FILES` holds `brief.md` | Every new `.kl/` file is already refused to `Write`, `Edit` and `MultiEdit`; §11 pins each by test |
| Management tools | `createCaseToolHandler` (`openCase`, `listCases`), `untrusted()`, `CASE_SCOPED_TOOLS` | The MCP surface changes |

Two things the outline assumes that the code does not have, and that this stage therefore adds:

- **No close hook and no record of what a turn wrote.** Hook phases are `turn-start` and `owner-message`
  only. Facts carry `addedBy: <turnId>`; decisions carry no turn id; `endTurn` gets a summary and the
  assistant's text. §6.9 adds marks at `beginTurn` and an `evidence` field on `endTurn`.
- **No owner path that edits the brief.** The panel cannot confirm, edit or drop anything in `brief.md`
  today. §8.1 adds it.

## 5. Decisions

These are the designer's, not the owner's; each can be overturned in review.

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| V1 | Where "who wrote it" lives | **A sidecar, `.kl/scope.json`**, keyed by criterion id and a hash of the text. `brief.md` keeps `successCriteria` as a list of strings and gains no key | Objects in the front matter (`- text: …, state: …`): `validate` in `brief.js` requires strings, `orientation.js` joins them, `index-store.js`, the detour classifier and playbook gating read strings, and a file written by a newer version would break an older one |
| V2 | What a criterion is called | **`sc-NNN`**, assigned once, never reused; the judge, the records and the cards use the id | Index in the list (moves when one is dropped) |
| V3 | Where a state lives | **Computed on every read** from the records, the ledger and the snapshot (`verify/status.js`). The `status` stored in `.kl/verification.json` is a cache for the panel and for diffs | A stored status that code flips: a trigger that fails to run leaves a wrong `met` on disk, and a `Bash` edit of the word would be believed |
| V4 | The new tool | **One tool, `Progress`**, with five actions | A `Decide` action for abandoning (`decision` and `factIds` are required parameters); four tools (prompt cost) |
| V5 | Who may change confirmed scope | **The owner only.** The model adds (proposed), and rewords or drops only what is still proposed | Letting the model drop a confirmed criterion: the shortest way to "ready" would be to delete what is unmet |
| V6 | Evidence with a dirty tree | **A check run is evidence only when the tree was clean at that run** and head is unchanged | Fingerprinting uncommitted content (`git stash create` writes objects; hashing a diff misses untracked files) |
| V7 | A verify verdict of `unmet` on a `met` criterion | **Marks it `stale`** (reason `verify-disagreed`); a fresh accepted `met` restores it | Ignoring it (a wrong `met` survives); deleting the record (loses what was believed) |
| V8 | Where the pass runs | **Inside `endTurn`, under the case lock, bounded by `cases.verify.timeoutMs`** | After the lock is released (an owner turn that follows at once would meet `CASE_BUSY`, or the pass would write over a newer turn) |

## 6. Design

### 6.1 Scope: proposed and confirmed — `src/cases/scope.js`

**The record.** `.kl/scope.json` (§7.1) holds one entry per criterion that is or was in
`brief.successCriteria`, and one for the objective. An entry's `hash` is the SHA-256 of the text after
`normalizeForQuote` (case, white space, curly quotes and dashes folded), so a re-saved file with the same
words keeps its entry.

**States.** `proposed` or `confirmed`. Nothing else. A proposed criterion has no verification state, is
never sent to the verify pass, and is never counted in a summary except as "N proposed (not counted)".

**Origins** (`origin`, recorded once, shown in the panel):

| Origin | Written when | Born |
|---|---|---|
| `model` | `Brief` append or update of `successCriteria` with no verified quote | `proposed` |
| `owner-quote` | `Brief` append with `provenance: "user"`, a quote `requireOwnerQuote` finds, and the item's text passing `wordsInText(item, quote)` | `confirmed` |
| `gating-answer` | Playbook gating's `applyToBrief` (an answered gating record; carries the answer's `factId`) | `confirmed` |
| `detour` | `DetourRouter` prefill of a new case (`successCriteria: [summary]`) | `proposed` |
| `owner-create` | objective only: `createCase` called by IPC `case:create` with an objective in the form (an event of the app's own window), or by `create_case` in King Louie's chat (`in-app-chat`, which has held the objective to the quote and found the quote in the owner's message of this turn) | `confirmed` |
| `mcp-create` | objective only: `createCase` called by `create_case` over `mcp-stdio` or `mcp-frontdoor`, which holds the objective to the quote but cannot check the quote is the owner's (R-C8-N3) | `proposed`, shown as "set over MCP" |
| `legacy` | Found in `brief.md` when the case first meets stage 8 | `proposed` (R-C8-6) |
| `file` | Found in `brief.md` later with no tool write behind it | `proposed` (R-C8-8), shown as "changed outside the app" |

`createCase` learns who gave the objective from a new option, `objectiveBy`: `'owner'` is passed only by
the two confirming host callers above, `'mcp'` by `create_case` over MCP, and `'detour'` by the detour
router; any other value or none is the model's. Like `force`, no case tool accepts it; the detour router passes nothing, so a detour's objective is `proposed`. The renderer's create form sends no objective today (§2.1), so the
usual first objective of a desktop case is the model's, and is `proposed` until the owner confirms it.

**Confirming** (`ScopeStore.confirm(ids, { by, channel, factId, quote })`):

- the panel or the scope card's buttons (IPC `case:confirmScope`, §8.1), recorded as `by: 'owner-action'`;
- an answer to a `scope-confirm` question (§6.7), recorded with the answer's `factId` (the
  question is spoken, R-C8-2);
- at birth, by `owner-quote` or `gating-answer`.

Every confirmation names the entry's `hash` as the caller saw it. A hash that no longer matches is refused
(`SCOPE_STALE`): the owner confirms the words that were shown, as a budget grant is checked against
current numbers and not the ones the question captured.

**The `Brief` tool** (`src/tools/builtin/case-tools.js`), `successCriteria` and `objective`:

- `provenance: "user"` on either field now requires a quote, as the owner-only fields do. The quote must
  be in `ctx.ownerMessages`, and the item (or the objective) must be words from the quote
  (`wordsInText`: the whole text as one contiguous run, folded for case, spacing and curly quotes, on word
  boundaries; so it is the owner's own phrase, not a paraphrase). A miss is refused (`SCOPE_NOT_IN_QUOTE`): `Quote the owner's words that state this
  criterion, or add it without provenance "user" as a proposal.`
- `append` without `provenance: "user"` adds a `proposed` entry and returns `{ ok: true, criterion: { id,
  state: 'proposed' }, note: 'Proposed. It counts for nothing until the owner confirms it. Ask with
  Progress askScope.' }`.
- `update` of the whole list is compared entry by entry. Removing or rewording a `confirmed` entry is
  refused (`CRITERION_CONFIRMED`): `sc-002 was confirmed by the owner. Only the owner changes or drops
  it; ask.` Removing or rewording a `proposed` one is allowed (the old entry moves to `removed`).
- `update` of `objective` without a verified quote is refused when the objective is `confirmed`
  (`OBJECTIVE_CONFIRMED`); when it is `proposed` it is allowed and stays `proposed`.
- At most 12 criteria, of which at most 6 `proposed` (`CRITERION_LIMIT`); a criterion is one line of 3 to
  300 characters (`plainLineProblem` from `src/cases/hidden-chars.js`, because it is shown on a card);
  an entry whose hash is already present is refused (`CRITERION_DUPLICATE`).
- The journal line the tool already writes says `proposed` or `confirmed` and the id, never `(user)` for
  an unchecked claim.

**Reconciliation.** `brief.md` holds the words; `scope.json` holds the states. `ScopeStore.view(brief)`
joins them in memory and never writes: an entry for each string by hash; a string with no entry is shown
as origin `legacy` (no `migratedAt` in the file yet) or `file` (after it). `ScopeStore.reconcile(brief)`
writes that view; it runs only where the case lock is held: in `beginTurn` after the `owner edits`
commit, after each `Brief` tool write, and inside the `systemAction` of every IPC in §8.1. Reads outside
the lock (the panel, `open_case`) use `view`.

**Gating (R-C8-2).** `Brief.missingForGating` takes the scope view and reports `successCriteria` until one
entry is `confirmed`. A proposed entry beside a confirmed one does not hold gating back. `completeGating`'s
message names what is missing: `Gating pass incomplete; still missing: successCriteria (no criterion is
confirmed by the owner; ask with Progress askScope).` `gating.complete: true` already in a brief is never
cleared.

**What the mark on the objective does.** A `proposed` objective is shown as such in the orientation, the
panel and `open_case`; it is an item in the ready-to-close list; it blocks nothing else. The detour
classifier keeps reading the objective as it does.

### 6.2 Abandoned approaches — `src/cases/abandoned.js`

What the case itself tried and dropped while it kept working. Not `brief.alreadyTried` (the owner's
history, owner-only) and not a `Fail` report (the case stops and waits).

**Write path.** `Progress` action `abandon`:

```
{ action: 'abandon', approach: 'Cold-calling listing agents from the county directory',
  why: 'All three declined a lot under two acres', tried: ['Called three agents on 2026-10-08'],
  factIds: ['f-0017'], decisionIds: ['D-002'] }
```

- `approach` and `why` are required, one plain line each (5 to 200 and 5 to 300 characters); `tried` is up
  to 6 lines of up to 200 characters; `factIds` must exist in the ledger (any status: the fact that killed
  the approach may itself be superseded later); `decisionIds` must exist.
- An active record with the same folded `approach` is refused (`ALREADY_ABANDONED`, naming it).
- The append and a `journal/…-abandon.md` entry are written in the turn; the turn's commit carries both.
- `withdraw` (`{ action: 'abandon', withdraw: 'ab-0002', why: '…' }`) appends a `withdraw` line; the
  record stays in the file and leaves the orientation. Nothing is ever edited or removed.
- Status rules: `Progress.abandon` is allowed in `draft`, `active` and `needs-direction`; `paused`, `done`
  and `abandoned` cases are read-only as for every write.

**`Fail` writes nothing here (R-C8-10).** While a case's `statusReason.kind` is `direction` (it was resumed
by the owner's direction after a failure report), the section ends with one host line naming that
report, taken from the direction fact's `attr`: `The last failure report is journal/<name>.md. If the
approach it describes is dropped, record it with Progress abandon.`

**Shown.** The orientation's `## Abandoned approaches` section (§6.8): the newest 8 active records, one
line each, at most 1,500 characters, then `… N earlier; Progress abandoned lists them`. `Progress`
action `abandoned` returns all of them (a read op, allowed in every status).

**Private.** The record is case data like a non-disclosable fact:

- it is never added to the cross-case index (`CrossCaseIndex` builds no document from it), so no other
  case can find it or run a duplicate check against it;
- it has no reference syntax in outbound text and is never rendered into a payload;
- it leaves the node only where private facts already do: `get_orientation` and `open_case` under
  `cases:read`, inside the `untrusted()` wrapper.

Its text is free text the model wrote, not a fact value, so the outbound gate's rule 1 does not know it.
A model that paraphrases an abandoned approach into outbound text is in the same position as with a
journal entry (§18).

### 6.3 Verification state — `src/cases/verify/store.js`, `status.js`

**The states** of a `confirmed` criterion:

| State | Meaning | Set by |
|---|---|---|
| `unmet` | No accepted verification record | default |
| `met` | The newest accepted record's evidence all still holds | computed |
| `stale` | It was `met`; a cited fact is now superseded or retracted, or the cited check is no longer at the current commit, or a later verify pass disagreed | computed |
| `failing` | The record cites a check, and the newest check run failed | computed |

Precedence when more than one applies: `failing`, then `stale`, then `met`.

**A verification record** (`v-NNNN`, §7.3) is written only by `verify/judge.js` (`kind: 'verify'`) after
code accepted a verdict, or by a later stage through the seam of §6.10. No tool action writes one. It
holds the criterion id and hash, the evidence ids, the turn, the model that gave the verdict, and a
one-line note.

**Evidence ids and their resolvers** (`verify/evidence.js`). An id is accepted through the resolver for
its prefix; an id with no resolver is rejected.

| Prefix | Resolver | Holds when |
|---|---|---|
| `f-` | the ledger | the fact exists, is `active`, and its provenance is `user`, `sourced` or `external-agent`, any of them alone (R-C8-5); never `inferred` or `unknown`; and no active load-bearing unknown sits on the same `subject.attr` (the recommendation gate's `blockers` rule) |
| `chk-` | the check store (§6.6) | the run exists, exited 0, was made with a clean tree, and its `head` equals the snapshot's `head` now |

**Computation** (`computeCriterionState({ entry, records, facts, checks, snapshot })`, pure):

1. No record whose `criterionHash` equals the entry's current hash → `unmet`. (A reworded criterion
   starts over.)
2. Take the newest such record. If it cites a `chk-` id and the newest check run for this case failed or
   timed out → `failing`.
3. If a later `verify-disagreed` mark names this record → `stale`.
4. Resolve every evidence id now. All hold → `met`. Otherwise → `stale`, with a reason per id that does
   not: `f-0033 was superseded by f-0060`, `f-0041 was retracted`, `chk-0012 ran at 3f2a91c; the
   repository is now at 77c0de4`, `the tree has uncommitted changes`.

Because the state is computed, a fact corrected by any path (the `Ledger` tool, an answered question, an
executor result, an ingest review) makes the criterion `stale` on the next read with no extra write.

**The one-line summary** (`summaryLine(view)`), used by the orientation, the panel, `open_case` and the
close card:

```
1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not counted) · not ready to close (4 open)
```

**Regressions.** The `verification` turn-start hook (`addTurnStartHook('verification', …)`) compares the
computed states with the cached ones in `.kl/verification.json`. A criterion that was `met` and is now
`stale` or `failing` raises a blocking trigger, `kind: 'criterion-regressed'`, `key:
'criterion:<id>:<recordId>:<state>'`, `detail: 'sc-002 ("Closed within the deadline") was met and is now
stale: f-0033 was superseded by f-0060.'`, and a `Since last turn` note. `Reorient` acknowledges it by key
like any hook trigger. The hook then writes the new cache (under the turn's lock).

**A `done` or `abandoned` case (R-C8-7).** `setStatus` to either status calls
`freezeProgress(id)`: the computed states and the ready-to-close list are written to
`.kl/verification.json` as `closed: { at, status, summary, criteria, readiness }`, and every later read of
that case returns `closed` as it is, labelled `as of <date>`. `setStatus` already runs under the lock on
every path that reaches it.

### 6.4 Ready to close — `src/cases/verify/readiness.js`

`closeReadiness(runtime, id)` → `{ ready, items, computedAt }`. Pure reads; no model call. `ready` is true
when every item is `ok` or `n/a`.

Each item: `{ id, state: 'ok' | 'open' | 'unknown' | 'n/a', by: 'owner' | 'case' | 'either', count,
refs: [ids], fix }`. `fix` is fixed wording filled with ids and counts only, never with a criterion's or a
question's text, so it can be shown anywhere a status line can.

| Item id | `ok` when | `by` | `fix` when open |
|---|---|---|---|
| `objective-confirmed` | the objective is `confirmed` | owner | `Owner: confirm the objective in the case panel.` |
| `criteria-confirmed` | at least one criterion is `confirmed` and none is `proposed` | owner | `Owner: confirm or drop 2 proposed criteria (sc-004, sc-005).` |
| `criteria-met` | every confirmed criterion is `met` | case | `Case: sc-002 is stale, sc-003 is unmet. Record the evidence as facts; the verify pass reads them.` |
| `unknowns-resolved` | no active load-bearing unknown | either | `Resolve or retract 1 load-bearing unknown (f-0044). The owner can answer it; the case can source it.` |
| `questions-answered` | no open question except the close proposal itself | owner | `Owner: answer 2 open questions (q-0012, q-0013).` |
| `jobs-settled` | no job outside `TERMINAL_STATES` | case | `Case: job-0003 is still open. Wait for it or cancel it.` |
| `plan-settled` | no plan, or its status is `done`, `rejected` or `superseded` | case | `Case: the plan has 2 steps not finished.` |
| `envelopes-closed` | no envelope `requested` or `active` | owner | `Owner: env-02 is still active. Revoke it or let it expire.` |
| `detours-settled` | no open routing proposal and no `pending:` blocker in `related` | owner | `Owner: answer the routing question q-0015.` |
| `documents-reviewed` | no ingest proposal waiting for review | owner | `Owner: 3 document proposals wait for review.` |
| `tree-clean` (`software-repo`) | the snapshot's `dirty` is 0; `unknown` when the snapshot is missing or stale | either | `The repository has 4 uncommitted changes. Commit or discard them.` |
| `branch-merged` (`software-repo`) | no open PR whose head is the current branch; `unknown` when `gh` could not list PRs | either | `PR #12 from this branch is still open. Merge or close it.` |
| `check-passing` (`software-repo`, a check approved) | the newest run passed at the current head with a clean tree | case | `Case: the check last failed (chk-0013). Fix it and it runs again at the end of the turn.` |

`branch-merged` is narrower than "PRs merged": nothing records which pull requests a case opened, and the
snapshot lists the repository's open PRs, not the case's. Only a PR from the branch the repository is on
is counted; the item's note says how many other PRs are open and not counted.

**Where it is shown:** the panel's Progress block, the orientation's last Progress line (ids and counts),
`open_case`, and the close card.

**Proposing `done`.** `Progress` action `proposeDone` (`{ action: 'proposeDone', note: '…' }`):

- allowed only in `active`; refused in `draft` and `needs-direction` (added to `DENIED`); refused while a
  re-orientation is pending (`reoriented: true`, as `Recommend` is);
- refused with `NO_CONFIRMED_CRITERIA` when nothing is confirmed;
- refused with `NOT_READY` and the open items while any confirmed criterion is not `met` (R-C8-1; `stale`
  and `failing` refuse too);
- refused with `CLOSE_PROPOSAL_OPEN` while one is open, and with `CLOSE_DECLINED_UNCHANGED` when the owner
  answered "Keep working" to a proposal whose list fingerprint (a hash of item ids and states) equals the
  current one;
- otherwise creates one question through `CaseRuntime.createQuestion`: `kind: 'question'`, `urgency:
  'normal'`, `options: [{ id: 'done', label: 'Mark done' }, { id: 'keep', label: 'Keep working' }]`,
  `defaultOnSilence: 'hold'`, `payload: { type: 'close-proposal', key: 'close-proposal', mcpAnswerable:
  false, disclosable: false, fingerprint, turnId }`, charged to `questionsPerDay` (the model asked).

Its text is host-built: the case title, the summary line, then one line per open item (`fix`), then the
model's `note` last, labelled `Note from the case:` and held to one plain line of 300 characters. It is
never cut: a text that would pass 2,000 characters is refused (`QUESTION_TOO_LONG`), as an envelope card
is.

`close-proposal` joins `PRESSED_TYPES`. Its answer handler (`registerAnswerHandler('close-proposal', …)`):

- `keep`: records the fingerprint as declined; nothing else.
- `done`: applies only when the recorded answer's channel is `in-app` or `mobile` (the detour router's
  `PRESS_CHANNELS` rule: `in-app-chat` and every `mcp-*` channel are not a press). It recomputes the list
  now, for the close record only (the owner's press is never refused for an open item, R-C8-1), and calls `setStatus(id, 'done', { kind: 'owner', by: 'owner', ref: <answer fact id>, note:
  'close proposal q-0021; open at close: criteria-met (sc-003)' })`. The handler runs inside
  `answerQuestion`'s `systemAction`, as the direction handler does.

The panel's own Done button stays. Its confirm dialog shows the summary line and the open items first
and is never refused for an open item (R-C8-1).

### 6.5 The verify pass after a turn's close — `src/cases/verify/judge.js`

**When (R-C8-11).** The pass is decided and counted in `endTurn`, and runs after it. Three parts:

1. **Prepared in the turn** (`prepareVerifyPass`, no model, under the turn's lock and in its commit):
   whether the pass runs, what the model will be shown, and the count of the pass against the day's
   limit. The pass is counted here, once, before any call.
2. **Called after the turn** (`callVerifyModel`): `endTurn` commits, releases the case and returns, so
   the owner's reply completes at once. The model call is made with no lock held and nobody waiting.
3. **Landed in a system action** (`applyVerifyReply`, synchronous, inside
   `CaseRuntime.verifySystemAction`): the verdicts, a journal entry, the cache and one commit
   (`<turn id>: verify pass`), then `case:changed` with `what: 'progress'`, which is what the panel and
   every other reader of the states refresh on.

It is prepared when all of these hold:

- the turn wrote something: a fact with `addedBy` this turn or a ledger line count above the mark taken
  at `beginTurn`; a decision count above its mark; or a job whose results were recorded this turn;
- the case is `active` or `needs-direction` after the turn, and at least one criterion is `confirmed`;
- the turn was not stopped, blocked or failed (`turn.signal` not aborted; the caller passed
  `verify: true`, which the stopped, blocked and failed exits of the send path do not);
- `cases.verify.when` is `changed-turn` (the default, R-C8-4), the day's pass count is under
  `maxPassesPerDay`, and the `usd` budget has not passed `skipAboveUsdPercent`.

Otherwise it is skipped; a skip for budget or the daily cap writes one journal line a day (in the turn's
own entry: a skip needs no model).

**A result lands only while it is the newest thing known about the case.**

- *A turn starts while the pass is out.* An owner turn takes the case at once (no "busy", no wait): the
  pass is marked dropped in the same synchronous step that takes the lock, its call is stopped, and
  nothing of its result is written, whenever the reply arrives. The case is then **owed** a pass: its
  next verified close prepares one even when that turn wrote nothing (the facts of the dropped turn are
  among the active facts it is shown). "Owed" is this process's memory; after a restart the next
  changed turn verifies.
- *A wake-up* does not start on a case whose pass is out (`CASE_BUSY`; the sweep counts it `busy` and
  comes back within the minute). A wake-up that acted waits for its own pass before it returns, so the
  sweep stays one case at a time and nothing of a wake-up outlives the sweep that shutdown awaits. Its
  pass still runs with the case released, so an owner turn that arrives takes the case as above.
- *The record changed while the model was thinking* (an answer, a panel action: system actions, not
  turns). The result is still applied, against the record as it is at landing: a criterion whose words
  changed is skipped (`criterion-changed`), and every cited id is resolved then.
- *The case closed meanwhile.* Nothing is written; the case keeps the progress it closed with (R-C8-7).
- *Another system action of this process holds the case.* The landing waits for it (at most 5 s), then
  writes; if the case stays busy, or another process holds it, the result is dropped and the pass owed.
- *An owner turn arrives during the landing's commit.* It waits for the commit instead of being
  refused.

**The call.** One call: `runtime.ensureRoleTested(caseId, 'verify', { turn })`, then
`runtime.routedProvider(turn, { role: 'verify' }).sendMessageWithTools(messages, [], { systemPrompt,
abortSignal })` (the tool-taking path, with no tools, because it is the path that returns `llmMetrics`),
then `recordOneShotUsage(runtime, turn, reply)` so the call is charged to the case's `usd` budget and
filed by role like orient. The helper moves from `turn-runner.js` to a shared module. A ref'd timer
bounds the call at `cases.verify.timeoutMs` (20 s) and aborts it. The pass has an abort signal of its
own (the turn's is spent once the reply is over): a newer turn, shutdown and the time limit all stop
the call through it.

**Charging (R-C8-11).** Whatever the call reports is charged to the case, exactly once, **when the call
settles**, whether or not the pass was still waiting for it: a reply in time; a reply that arrives after
the time limit, or after the pass was dropped; and the partial usage a provider attaches to a call it
was told to stop (`partialLlmMetrics`, recorded as `usagePartial`, never as $0). The call is also
aborted for real at the time limit, so a provider that honours the abort stops generating; one that
does not is charged for what it reports. A charge that arrives late is written in a system action of
its own (`system: verify pass usage`) so it is committed; while a turn of this process holds the case
it is written inside that turn; during shutdown it is written directly and committed by the next
commit. The daily count is taken once, at prepare, and a dropped pass is not counted again.

**What it is given** (built by `collectTurnEvidence(runtime, turn, evidence)`, §6.10), in this order,
inside one data fence, at most `cases.verify.maxInputChars` (12,000):

1. The confirmed criteria: id and text. Never a proposed one.
2. For each, its current state and the evidence its newest record cites.
3. Facts written this turn: id, provenance, `subject.attr`, value, statement, source kind and ref, status.
4. Decisions written this turn: id, text, fact ids.
5. Executor results recorded this turn: job id, executor, state, the fact ids they produced.
6. When a check is approved (§6.6), the newest check run: id, pass or fail, head, whether the tree was clean. Never
   its output.
7. Results of this turn's case-tool calls only (`Ledger`, `Decide`, `Executor`, `Ingest`, `Progress`;
   R-C8-9), 1,000 characters each and 4,000 in all, labelled as not evidence. No other tool's result is
   sent.
8. Other active `user`, `sourced` and `external-agent` facts as one-line rows, newest first, until the
   budget is used, then a count of what was left out.

It is **not** given: the assistant's reply, the journal, the conversation, the brief's prose, the
abandoned record, proposed criteria, or inferred and unknown facts (their ids would be rejected anyway).

**What it returns.** Exactly:

```json
{ "criteria": [
  { "id": "sc-001", "status": "met", "evidence": ["f-0042", "f-0051"], "note": "Contract signed at 81,000; floor is 75,000." },
  { "id": "sc-003", "status": "unmet", "evidence": [], "note": "Only one owner's signature is recorded." }
] }
```

`status` is `met` or `unmet`; `evidence` is a list of at most 8 ids; `note` is cut to one line of 200
characters. The reply is parsed with `parseReplyObject`; a reply that is not this shape, names an id that
is not a confirmed criterion, or names one twice, is dropped whole and counted as "no usable verdict".
Criteria the reply leaves out are untouched.

**What code does with each verdict** (`acceptVerdict`):

| Verdict | Code check | Result |
|---|---|---|
| `met`, every id resolves and holds (§6.3) | pass | a `v-NNNN` record is written; the state computes to `met` |
| `met`, no evidence | fail (`evidence-empty`) | recorded as an opinion; the state does not change |
| `met`, an id does not exist, is not active, has the wrong provenance, is blocked by a load-bearing unknown, or is a check not at the current commit | fail (`evidence-missing`, `evidence-inactive`, `evidence-provenance`, `evidence-blocked`, `check-not-current`) | recorded as an opinion with the reason per id; the state does not change |
| `unmet`, the criterion is `unmet`, `stale` or `failing` | none | recorded as an opinion |
| `unmet`, the criterion is `met` | none | a `verify-disagreed` mark on the current record; the state computes to `stale` (V7) |

An opinion is kept in `.kl/verification.json` (the newest per criterion) and shown as such: `the verify
pass thought sc-003 was met but cited f-0099, which is inferred`. It is never a state.

**The journal (R-C8-11).** The host-written block is now in two places, each written by whoever knows
it:

- *The turn's own entry* still starts with the block for what needs no model: a criterion that left
  `met` because of what the turn itself wrote (it superseded or retracted a cited fact), the check's
  result (§6.6), and the one line a day for a pass that was skipped for the limit or the budget. The
  cache is written with it.
- *The pass's entry*, kind `verification`, written when the pass lands: `Now met`, `Now stale` (a
  verdict that no longer agrees), and the `Verify pass:` line. It is compared with the states the turn's
  close left, so nothing is said twice. A pass with nothing to say writes no entry.

A criterion that **the pass** took out of `met` cannot be the first lines of the turn's entry any more.
It is told to the next turn instead: the landing leaves that criterion `met` in the cache, so the next
turn's `verification` hook (§6.3) finds the difference and raises a "since last turn" note and a
blocking `criterion-regressed` trigger in that turn's orientation, where the model must re-orient. The
orientation's "last journal entry" skips `verification` entries: it stays the turn's own entry, and
what the pass found is in the Progress section.

The block as a whole, when both parts are read together:

```
## Verification (written by King Louie)
- Check: pass → FAIL during this turn (chk-0012 at 3f2a91c → chk-0013 at 3f2a91c, uncommitted changes).
- Now failing: sc-002. Now met: sc-001 (f-0042, f-0051).
- Verify pass: 1 accepted, 1 not accepted (sc-003: f-0099 is inferred).
```

A regression (a check that went from pass to fail, a criterion that left `met`) is always the first line
of the entry it is in. The turn's block is written even when the model's text is empty.

**Failure is quiet and safe.** A timeout, a provider error, no usable model, or an unusable reply changes
no state and writes `Verify pass: no usable verdict (<reason>)` as the pass's entry. Nothing in the pass
can fail `endTurn`: the turn has committed and released the case before the call is made.

### 6.6 The check command of a `software-repo` case — `src/cases/verify/check.js`

This is the dangerous part of the stage. It is built last and ships behind
`cases.softwareRepo.check.enabled`, default off (R-C8-3).

**What it is.** One command per case that says whether the repository is in a good state, such as `npm
test`. King Louie runs it in the repository and records exit code 0 as a pass.

**What cannot be promised.** The program is the owner's choice and what it does is the repository's:
`npm test` runs the script in `package.json`, and a model with `Bash` in an owner turn can change that
script. So the command can write files, use the network, and read anything the account can read. Nothing
below makes it read-only or offline. What the design holds is: who named it, exactly what is launched,
when, for how long, with what environment, and what is kept of its output.

**Naming it.** A new `software-repo` brief field, `check` (`briefFields()`: `{ name: 'check', kind:
'text', userOnly: true, validate: validateCheck }`), set two ways:

- the `Brief` tool with `provenance: "user"` and a quote: after `requireOwnerQuote`, the whole command
  must appear in the owner's own message as one contiguous run, compared exactly (case kept), bounded by
  white space, quote marks or backticks on both sides (`checkInQuote`, the `repo` rule made stricter: a
  whole command, never tokens gathered from across the message). Else `CHECK_NOT_IN_QUOTE`;
- the panel (IPC `case:setCheck`), typed by the owner.

**What may be named** (`validateCheck`, `CHECK_INVALID` with the reason):

- 1 to 200 characters, split on single spaces into 1 to 12 tokens;
- every token matches `^[A-Za-z0-9_./:=@,+-]+$`. That admits `npm run test:unit`, `node --test
  tests/unit`, `./gradlew test`, `cargo test --locked`, `make check`; it refuses every character a POSIX
  shell or `cmd.exe` gives meaning to (quotes, `;`, `&`, `|`, `<`, `>`, `$`, a backtick, `(`, `)`, `*`,
  `?`, `~`, `!`, `%`, `^`, a backslash, a newline);
- the first token is a program name or a path that stays inside the repository (`./gradlew`); it is not
  an assignment (`FOO=1`), does not start with `-`, and is not a shell or a download-and-run tool
  (`sh`, `bash`, `zsh`, `cmd`, `powershell`, `pwsh`, `env`, `sudo`, `curl`, `wget`, `ssh`, `npx`, `bunx`,
  `pnpx`, `eval`, `exec`);
- no token is `-c`, `-e`, `--eval`, `-p`, `--print` or `--exec`, the flags that hand a program code on its
  command line.

The list is a filter against the obvious, not a sandbox: `node scripts/anything.js` passes.

**Narrowed by the owner (R-C8-N5, R-C8-N6; built so in Task 15).** On top of the rules above, the program
is exactly `npm` and the command is `npm test` or `npm run <script>`; no word that starts with `-` comes
before the script (npm's own options are refused; words after `--` go to the script), and no other npm
command is accepted. So of the examples above only `npm run test:unit` is a valid check, and
`node scripts/anything.js` is refused.

**Approving it.** Setting or changing `check` runs nothing. It creates a pressed question (`type:
'check-approve'`, `key: 'check-approve'`, `mcpAnswerable: false`, never charged), whose host-built text is:

```
Lakeside lot site: run a check command in the repository?
Program: npm
Arguments: test
Runs in: <the repository's path>
When: at the end of a turn you started, when the repository changed in that turn. Never while you are away.
It runs with your account's access. It can do whatever the repository's own scripts do, including
writing files and using the network. King Louie cannot make it read-only.
```

Options `Approve` and `Do not run`. The approval is recorded in `.kl/checks.json` as the hash of
`{ argv, repo real path }`. A run is refused (`CHECK_NOT_APPROVED`) unless the hash of what is about to
run equals an approved one; changing the command or the repository asks again. The approval applies only
from `in-app` or `mobile`, like the close proposal. The panel shows the approved command and a "Stop
running it" button (IPC `case:setCheck` with `approved: false`).

**When it runs.**

- Only in a turn whose `source` is `owner`. Never in a wake-up, a sweep or any `systemAction`.
- Only when `cases.softwareRepo.check.enabled` is true (default **false**). In service mode that setting
  is read only from the admin `service.json` (a new admin-only key, `caseChecks: { enabled }`, added to
  `ADMIN_ONLY_KEYS`); the data-dir setting is ignored there with one warning (`CHECK_SERVICE_OFF` when a
  run is asked for).
- Only when `repo` is a local path that exists (`CHECK_NO_LOCAL_REPO` for a clone URL).
- **At turn start nothing is run.** The turn's starting state is the newest recorded run whose `head` and
  `dirty` equal the snapshot's (`baseline`), or "not known".
- **At turn close** it runs once, after a second `refreshCaseType`, when the snapshot's `head` or `dirty`
  differs from the turn-start snapshot, or when no run exists for the current head. It runs before the
  verify pass, so the pass can cite it.
- One run at a time per repository path in a process (`CHECK_BUSY` skips the second; two cases can share a
  repository).

**How it runs** (`runCheck`):

- `child_process.spawn(file, args, { cwd: <repo real path>, shell: false, windowsHide: true, stdio:
  ['ignore', 'pipe', 'pipe'] })`. The repository path goes in as `cwd` only, never as an argument.
- The program is found with `resolveCommand` (`src/service/doctor-runbooks.js`), the lookup `doctor`
  already uses for runbook steps: on Windows only a `.com` or `.exe` is started. **Nothing is ever run
  through `cmd.exe`.** A name that resolves only to a `.cmd` or `.bat` shim is refused (`CHECK_SHIM`),
  with one exception that needs no shell: `npm` is run as the `node.exe` found on `PATH` with
  `node_modules/npm/bin/npm-cli.js` beside it, then the approved arguments, which is what the shim itself
  does. When that file is not there, `npm` is refused like any other shim. `pnpm`, `yarn` and
  `gradlew.bat` therefore cannot be the check on Windows in this stage (plan, New questions).
- Environment: built from nothing, then `PATH`, `HOME` or `USERPROFILE`, `SystemRoot`, `TEMP`/`TMP`,
  `LANG`, the names in `cases.softwareRepo.check.envAllow` (default empty), `CI=1` and `KL_CASE_CHECK=1`.
  No provider key, no other `KL_*` variable, and never `ELECTRON_RUN_AS_NODE`, reaches it.
- Time limit `cases.softwareRepo.check.timeoutMs` (default 120,000; at most 900,000). On the limit, on
  the owner's Stop (`turn.signal`) and on shutdown, the whole process tree is killed (`taskkill /T /F` on
  Windows; a process group and `SIGKILL` elsewhere), and the child is awaited so no handle outlives the
  turn.
- Output: read and discarded past the last 2,000 characters of each stream. The tail is written to
  `.kl/runs/checks/<id>.txt` (`.kl/runs/` is already in the case's `.gitignore`), never committed, never
  put in the orientation, a question or an MCP reply: it is third-party text and may hold secrets. The
  model can run the command itself with `Bash` when it needs the output.
- Recorded in `.kl/checks.json` (committed): id, argv hash, `head`, `dirty`, exit code, `timedOut`,
  duration, time, turn id (§7.4). `result` is `pass` (exit 0), `fail`, `timeout` or `spawn-failed`.

**What a run means.**

- A pass with a clean tree at the current head is evidence (`chk-NNNN`) the verify pass may cite.
- A pass with uncommitted changes is recorded and shown, and is not evidence (V6).
- A `fail` or `timeout` as the newest run makes every criterion whose record cites a check `failing`.
- **Pass to fail across a turn:** when `baseline` was a pass and the close run is not, the journal block's
  first line says so (§6.5), and a `Since last turn` note and a `criterion-regressed` trigger carry it
  into the next turn.
- `spawn-failed` (the program is not installed) changes no state and is shown as `not run`.

### 6.7 The `Progress` tool — `src/tools/builtin/case-progress-tool.js`

Added to `CASE_TOOL_NAMES`, so it is in owner turns and wake-up turns. Every action goes through
`withCase`, with these status ops:

| Action | Op | Allowed in | Does |
|---|---|---|---|
| `status` | `Progress.status` (a read op) | every status | The scope view, each confirmed criterion's state with evidence and the newest opinion, the summary line, the ready-to-close list |
| `abandoned` | `Progress.abandoned` (a read op) | every status | Every abandoned record, withdrawn ones marked |
| `abandon` | `Progress.abandon` | `draft`, `active`, `needs-direction` | §6.2 |
| `askScope` | `Progress.askScope` | `draft`, `active`, `needs-direction` | Asks the owner to confirm the proposed criteria and, when it is proposed, the objective |
| `proposeDone` | `Progress.proposeDone` | `active` only; refused while a re-orientation is pending | §6.4 |

There is no action that sets a state, writes a verification record or runs the check. With
`cases.verify.when: 'request'` (R-C8-4) a sixth action, `verify`, runs the pass of §6.5 over the whole
record, under the same daily cap and budget rule, and `proposeDone` runs it first; with the default the
action is refused (`VERIFY_NOT_ON_REQUEST`), because the pass already runs at the close of every changed
turn.

**`askScope`** creates one question through `createQuestion` (charged to `questionsPerDay`; refused with
`SCOPE_NOTHING_PROPOSED` when nothing is proposed and `SCOPE_QUESTION_OPEN` when one is open): `payload:
{ type: 'scope-confirm', key: 'scope-confirm', disclosable: false, entries: [{ id, hash }] }`, options
`[{ id: 'all', label: 'Confirm all' }, { id: 'none', label: 'Drop all' }]`. Its text is host-built: one
numbered line per proposed criterion (`shown` through `plainLineProblem`; text that is not one plain line
shows as `(text hidden: not one plain line)`), then the proposed objective if any. The answer handler
confirms, or drops, exactly the entries whose hash still equals the one in the payload; a free-text
answer confirms nothing and leaves a note (`Answer with "Confirm all" or "Drop all", or use the buttons
beside each criterion in the case panel.`). One at a time is done in the panel or on the card.

`scope-confirm` is a spoken question (R-C8-2): `answer_question` takes it with the owner's quote naming
the option, on every channel that serves spoken answers, and the card and the panel carry buttons as
well. It is not added to `PRESSED_TYPES`.

`CASE_MODE_PROMPT` gains three lines: criteria you add are proposals until the owner confirms them; you
cannot mark a criterion met, so record the evidence as facts; record an approach you drop with `Progress
abandon` and do not retry one the orientation lists without a new fact.

### 6.8 Orientation — `src/cases/orientation.js`

`buildOrientation` takes three new inputs (`scope`, `progress`, `abandoned`), each read by
`CaseRuntime.orientation` through its `safely` wrapper, so a broken file costs one line, not the
orientation.

```
## Brief
- Objective: Sell the Lakeside lot (proposed by the model; the owner has not confirmed it)
- Why: …
- Success criteria: 3 confirmed, 2 proposed; see Progress
…
## Progress (computed by King Louie; you cannot set these)
- 1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not counted) · not ready to close (4 open)
- sc-001 [met] Signed contract at or above the floor (evidence f-0042, f-0051)
- sc-002 [stale] Closed within the deadline (f-0033 was superseded by f-0060)
- sc-003 [unmet] Both owners of record have signed
- sc-004 [proposed, not counted] Buyer financing is confirmed in writing
- sc-005 [proposed, not counted] Title search is clean
- Ready to close: no. Owner: criteria-confirmed (sc-004, sc-005), questions-answered (q-0012). Case: criteria-met (sc-002, sc-003), jobs-settled (job-0003).

## Abandoned approaches (do not retry one without a new fact; say what changed if you do)
- ab-0002 2026-10-09 Cold-calling listing agents from the county directory: all three declined a lot under two acres [f-0017]
```

- `Progress` comes directly after `Brief`; `Abandoned approaches` after `Load-bearing unknowns`. Both are
  in the head, which is never trimmed, so they are capped: `Progress` at 2,500 characters (criteria past
  the cap become `… N more; Progress status lists them`), `Abandoned approaches` at 1,500. The room for
  facts shrinks by what they use.
- A criterion's text is one line, cut at 160 characters. It is model-authorable for a proposed entry and
  is marked so by its tag.
- With no criteria at all, `Progress` is one line: `No success criteria yet.` With the stage's files
  absent (a case no turn has touched since the upgrade) the sections are built from `ScopeStore.view`
  alone, in memory.
- A `done` or `abandoned` case shows the frozen record with `as of <date>` (R-C8-7).

### 6.9 Turn lifecycle changes — `src/cases/case-runtime.js`

`beginTurn`, in order (new steps marked):

1. lock; commit owner edits; reconcile budgets; charge the turn (unchanged);
2. **new:** `scope(id).reconcile(brief)` (first run on a case is the migration of §10);
3. turn-start hooks (detours, the case-type refresh, **new:** `verification`, which runs after the
   refresh so it sees the new head);
4. triggers, orientation (unchanged);
5. **new:** `turn.marks = { ledgerLines, decisions, jobResults, snapshotHead, snapshotDirty }`.

`endTurn(turn, { summary, journal, journalKind, evidence, verify })`:

1. **new, when `verify` is true and the turn is an owner turn:** the close check of §6.6;
2. **new, when `verify` is true:** the verify pass of §6.5 is **prepared** (no model call: the skips,
   the input, the day's count);
3. **new:** write the verification cache;
4. `renderOpenItems`, the journal entry (now with the host block first), `_closeTurnMeta`, commit,
   reindex, release (unchanged);
5. **new (R-C8-11), after the release and with no `await` between:** the prepared pass is started.
   `endTurn` does not wait for it. A turn that did not commit, that no longer owned the case, or that
   closed after shutdown began starts none (the pass is owed).

Steps 1 to 3 are wrapped so that nothing in them can keep the turn from committing and releasing.

**The case lock and the pass.** The lock is never held across the verify call. The pass writes only in
its landing, a system action taken after the call, and the checks that decide whether it may land and
the taking of the lock have no `await` between them (`systemAction` takes the lock synchronously and
the landing is synchronous), so a result is applied whole or not at all. `beginTurn` drops a pass that
is out in the same synchronous step that takes the lock (`_acquireForTurn`), so a pass can never see
"not dropped" and the newer turn's lock together.

**Shutdown.** `beginShutdown` stops every pass that is out (`abortVerifyPasses`: the call is aborted
and its result will not be written) and refuses new ones; `create-core`'s `shutdown()` awaits
`verifyIdle(null, { settled: true })` within `shutdownTimeoutMs` before `releaseAll`, so a landing that
had already taken the lock finishes its commit and no lock or half-written file is left. A pass
stopped by shutdown wrote nothing but its count, which the turn committed.

Callers: the owner send path (`src/ipc/chat-handlers.js`) passes `verify: true` and `evidence` only on
its normal exit (the one that journals `answerText`); its stopped, blocked and failed exits pass
neither. `runWakeupTurn`'s `close` passes `verify: true` only for the `acted` outcome. `evidence` is `{
toolResults: [{ tool, action, ok, text }] }` (this turn's case-tool calls only, R-C8-9); the runtime caps it again and
never trusts its ids.

`CaseRuntime` gains `scope(id)`, `abandoned(id)`, `verification(id)`, `progress(id)` (the joined view the
panel, the tool and MCP all read) and `closeReadiness(id)`; and, for the pass after the reply,
`verifyRunning(id)`, `verifyIdle(id?, { settled })`, `abortVerifyPasses(reason)` and
`verifySystemAction(id, label, fn)`.

### 6.10 The seam for child hand-off

A later stage gives a case's child runs a structured hand-off. It plugs in at two points in
`src/cases/verify/evidence.js`, and nowhere else:

- `registerEvidenceSource(name, fn)`: `fn(runtime, turn)` returns rows `{ kind, id, text, refs }` that
  `collectTurnEvidence` adds to the verify pass's input (item 5 of §6.5 is the first such source,
  registered by this stage for executor results).
- `registerEvidenceResolver(prefix, fn)`: `fn(runtime, caseId, id)` returns `{ exists, holds, reason }`.
  `f-` and `chk-` are registered by this stage. A hand-off's ids (say `h-`) become citable when that
  stage registers their resolver; until then `acceptVerdict` rejects them as `evidence-missing`.

`acceptVerdict` and `computeCriterionState` know evidence only through resolvers, so a new kind of
evidence changes neither. A hand-off that produces facts needs no seam at all: its facts are `f-` ids.

## 7. Data formats

All under the case's `.kl/`, committed with the turn unless noted, written only by code.

### 7.1 `.kl/scope.json`

```json
{
  "version": 1,
  "migratedAt": "2026-10-20T14:02:11.000Z",
  "nextCriterion": 6,
  "objective": {
    "hash": "sha256:9d1c…", "state": "proposed", "origin": "detour",
    "at": "2026-10-20T14:02:11.000Z", "confirmed": null
  },
  "criteria": [
    { "id": "sc-001", "hash": "sha256:41ab…", "state": "confirmed", "origin": "owner-quote",
      "addedBy": "turn-7f3a", "at": "2026-10-20T14:05:40.000Z",
      "confirmed": { "by": "owner-quote", "channel": "in-app-chat", "at": "2026-10-20T14:05:40.000Z",
                     "quote": "signed contract at or above the floor", "factId": null } },
    { "id": "sc-004", "hash": "sha256:b07e…", "state": "proposed", "origin": "model",
      "addedBy": "turn-91c2", "at": "2026-10-21T09:12:03.000Z", "confirmed": null }
  ],
  "removed": [
    { "id": "sc-003", "hash": "sha256:c2f0…", "text": "Closing costs under 2,000 dollars",
      "state": "proposed", "at": "2026-10-21T09:30:00.000Z", "by": "owner-action" }
  ]
}
```

The words of a live criterion are only in `brief.md`; `removed` keeps the text because the brief no
longer does.

### 7.2 `.kl/abandoned.jsonl`

```json
{"kind":"abandon","id":"ab-0002","at":"2026-10-09T16:20:00.000Z","turnId":"turn-5be1","approach":"Cold-calling listing agents from the county directory","why":"All three declined a lot under two acres","tried":["Called three agents on 2026-10-08"],"factIds":["f-0017"],"decisionIds":["D-002"]}
{"kind":"withdraw","target":"ab-0002","at":"2026-10-15T10:00:00.000Z","turnId":"turn-77aa","why":"The owner agreed to list both lots together"}
```

Read with `readJsonl` (`src/cases/jsonl.js`); a malformed line is skipped with a warning, as in the
ledger.

### 7.3 `.kl/verification.json`

```json
{
  "version": 1,
  "nextRecord": 8,
  "records": [
    { "id": "v-0007", "kind": "verify", "criterion": "sc-001", "criterionHash": "sha256:41ab…",
      "evidence": ["f-0042", "f-0051"], "note": "Contract signed at 81,000; floor is 75,000.",
      "turnId": "turn-91c2", "model": "example-provider:example-model", "at": "2026-10-21T09:14:10.000Z",
      "disagreed": null }
  ],
  "opinions": {
    "sc-003": { "status": "met", "evidence": ["f-0099"], "rejected": [{ "id": "f-0099", "reason": "evidence-provenance" }],
                "turnId": "turn-91c2", "at": "2026-10-21T09:14:10.000Z" }
  },
  "cache": {
    "at": "2026-10-21T09:14:10.000Z",
    "states": { "sc-001": "met", "sc-002": "stale", "sc-003": "unmet" }
  },
  "passes": { "day": "2026-10-21", "count": 3 },
  "declinedClose": { "fingerprint": "sha256:77e1…", "at": "2026-10-20T18:00:00.000Z" },
  "closed": null
}
```

`records` keeps the newest 5 per criterion. `cache.states` is never read as truth (V3); it exists so the
turn-start hook can see a change and so a commit's diff shows it.

### 7.4 `.kl/checks.json`

```json
{
  "version": 1,
  "approved": [ { "hash": "sha256:5a90…", "argv": ["npm", "test"], "at": "2026-10-20T15:00:00.000Z",
                  "by": "question", "ref": "q-0009", "channel": "in-app" } ],
  "nextRun": 14,
  "runs": [
    { "id": "chk-0013", "hash": "sha256:5a90…", "head": "3f2a91c0e4…", "dirty": 4, "result": "fail",
      "exitCode": 1, "timedOut": false, "ms": 48211, "turnId": "turn-91c2", "at": "2026-10-21T09:13:50.000Z" }
  ]
}
```

`runs` keeps the newest 20. Output tails are in `.kl/runs/checks/chk-0013.txt` (gitignored).

### 7.5 New question payload types

| `payload.type` | Created by | Class | Options | Charged |
|---|---|---|---|---|
| `scope-confirm` | `Progress.askScope` | spoken | `all`, `none` | yes |
| `close-proposal` | `Progress.proposeDone` | pressed | `done`, `keep` | yes |
| `check-approve` | setting or changing `check` | pressed | `approve`, `refuse` | no |

All three carry `disclosable: false`, so the `user` fact an answer writes is private at birth.

### 7.6 Journal kinds

`abandon` (one per abandoned record or withdrawal), `scope` (a confirmation or a drop made outside a
turn), `verification` (what a verify pass found, written when it lands after the turn, R-C8-11; ids,
counts and fixed words only). The part of the verification block that needs no model is still the
first lines of the turn's own entry.

## 8. Interfaces

### 8.1 IPC — `src/ipc/case-progress-handlers.js`

All are in the `case` domain, which `PROXIED_DOMAINS` already proxies, so they work attached with no
allowlist change; attached, they run on the service.

| Channel | Payload | Reply | Notes |
|---|---|---|---|
| `case:progress` | `{ caseId }` | `{ ok, untrustedText: true, objective, criteria, summary, readiness, abandoned, check }` | Read only; no lock; no write |
| `case:confirmScope` | `{ caseId, action: 'confirm' \| 'drop' \| 'edit' \| 'add', target: 'objective' \| <sc-id> \| 'all-proposed', hash?, text? }` | `{ ok, progress }` | Inside `systemAction`. `confirm` and `drop` need the `hash` the panel showed (`SCOPE_STALE` otherwise). `edit` and `add` take the owner's typed `text`, write it to `brief.md` and record it `confirmed` (`by: 'owner-action'`). The only path that changes a confirmed entry |
| `case:setCheck` | `{ caseId, command?, approved? }` | `{ ok, check, questionId? }` | Sets `brief.check` (validated) and opens the approval question; `approved: false` withdraws every approval |
| `case:setStatus` (existing) | unchanged | adds `progress` | The Done confirm dialog reads `case:progress` first |

Each is an owner action, like `case:grantBudget`: the model has no path to them.

### 8.2 MCP and the chat's management tools

No new tool, no new scope, nothing added to `CASE_SCOPES`. Three read tools return more, all under
`cases:read` (whose grant text already says "including private facts"):

| Tool | Added |
|---|---|
| `list_cases` | per row, bare: `criteria: { confirmed, met, proposed }`, `ready: true \| false` |
| `open_case` | inside `data` (the `untrusted()` wrapper): `progress: { frozen, summary, objective: { state, origin } \| null, criteria: [{ id, text, state, verification, evidence: [{ id, provenance }], reason }], readiness: { ready, items: [{ id, state, by, fix, refs }] }, abandoned: { count, newest: [{ id, approach, why }] } }`; `{ error: 'progress could not be read' }` when it cannot be read. `state` is `proposed` or `confirmed`; `verification` is `null` for a proposed row |
| `get_orientation` | the text now holds the `Progress` and `Abandoned approaches` sections |

Answers:

- `close-proposal` and `check-approve` are pressed: `answer_question` refuses them on every channel, the
  chat's own (`in-app-chat`) included, with the existing pressed message; the card's buttons
  (`case:answerQuestion`) or the phone answer them.
- `scope-confirm` is spoken (R-C8-2): `answer_question` takes it under `cases:answer` (the front door),
  over `mcp-stdio`, and in King Louie's chat (where the quote is checked against the owner's message).
- `list_questions` already reports each record's class from `answerClass`; nothing changes there.

In a case chat the tools stay confined to that case (`CASE_SCOPED_TOOLS`), and the chat-attach rule
(`NO_CASE_DATA` in `src/cases/chat-attach.js`) needs no change, because no tool is added.

### 8.3 Renderer rules

- Every string from `case:progress` is set with `textContent`: criterion text, the objective, an
  abandoned record's lines, a verify note, a `fix` line. No `innerHTML`, no markdown. The reply carries
  `untrustedText: true`, as playbook replies do.
- The panel's Progress block: the summary line; the objective with Confirm and Edit when it is proposed;
  one row per criterion (`sc-id`, a state tag, the text, evidence ids with each fact's provenance, the
  reason when stale or failing, Confirm and Drop when proposed); "Confirm all" when more than one is
  proposed; an Add field; the ready-to-close list grouped by who it falls to; the abandoned records
  (collapsed); for a `software-repo` case with the feature on, the check's command, its approval and its
  last result.
- A state tag is text, not colour alone: `met`, `stale`, `failing`, `unmet`, `proposed`.
- The card for `scope-confirm` and `close-proposal` is drawn from the question store plus a live
  `case:progress` read, never from the message text; it redraws on `case:changed` (`what: 'progress'`,
  which the runtime sends after a confirmation, a verify pass and a close). The close card never
  disables "Mark done" (R-C8-1); it shows what is still open beside the button.
- Buttons act through the IPC of §8.1; a second click while one is in flight is ignored.

### 8.4 The phone

A pressed question reaches the paired phone as it does today (`kl.question.ask`). The apps read `kind`,
`urgency`, `text` and `options` and no payload type (§2.1), so the new types need nothing from them.
The close proposal's host-built text carries the summary and the open items, so the phone shows the list
with no app change. No new message type; `tests/vectors/approval-v1` is untouched.

## 9. Configuration

`settings.cases` (`src/cases/defaults.js`), merged key by key like the rest:

```js
verify: {
  when: 'changed-turn',          // 'changed-turn' | 'request' | 'off'   (R-C8-4)
  timeoutMs: 20000,
  maxInputChars: 12000,
  maxPassesPerDay: 24,
  skipAboveUsdPercent: 80
},
softwareRepo: {
  refreshBudgetMs: 6000,         // existing
  check: { enabled: false, timeoutMs: 120000, envAllow: [] }            // R-C8-3
}
```

`cases.softwareRepo.check.enabled` is the first key in `settings.cases` that is security policy; the
comment at the top of `defaults.js` ("None of these keys is security policy") is corrected, and in service
mode the key is taken only from the admin file (§6.6). `verify` uses the existing `cases.roles.verify`
and `case.yaml` `roles.verify`; there is no new role.

`case.yaml` gains **no key**, so `CASE_YAML_KEYS` and `tests/cases-store-yaml.test.js` are unchanged.

## 10. Migration and back-compat

- **Nothing existing changes shape.** `brief.md`'s front matter keeps `successCriteria` as a list of
  strings and `objective` as a string. `case.yaml` is untouched. `facts.jsonl`, questions, decisions and
  budgets are untouched. Every new file is new, under `.kl/`, and absent until first written.
- **An older version reading a newer case** sees a brief it understands and ignores the new `.kl/` files.
  It will let the model rewrite the criteria list; the newer version then finds strings with no entry and
  shows them as origin `file`, `proposed`. Nothing is trusted that should not be.
- **First contact.** A case with no `.kl/scope.json` is read through `ScopeStore.view`, which shows every
  criterion and the objective as origin `legacy`, in memory. The first locked moment (`beginTurn`, or the
  `systemAction` of a panel action) writes the file with `migratedAt`. `legacy` entries are `proposed`
  (R-C8-6); the panel offers "Confirm all".
- **`done` and `abandoned` cases** are never opened for writing, so they never get the files. Their
  panel shows the brief as today and one line: `Closed before progress was tracked.`
- **Gating.** `gating.complete: true` is never cleared (R-C8-2); the new rule applies to
  `completeGating` calls made after the upgrade.
- **Wake-ups.** A case whose criteria are all `legacy` and unconfirmed keeps running exactly as before:
  nothing in this stage stops a turn, a plan or a send because a criterion is proposed. The summary reads
  `0 of 0 confirmed criteria met · 3 proposed (not counted)`, and the verify pass is skipped (nothing to
  judge), so an unmigrated case costs nothing.
- **Imports.** `king-louie-service import --from` copies case directories as files; cases arrive in
  whichever state their files are in, with no re-check, as with facts.
- **The `Brief` tool's schema** is unchanged (the same fields and actions); two calls that worked now
  refuse: `provenance: "user"` on `successCriteria` or `objective` without a matching quote, and a list
  `update` that drops a confirmed criterion. Tests that rely on either are updated in the same task.

## 11. Security and trust

| New capability | Risk | Control |
|---|---|---|
| The model adds criteria | It defines success as what it already did | Proposed entries count for nothing; only a verified owner quote, an owner action or an answered question confirms; confirmation binds to the text's hash |
| The model rewrites the list | It drops what is unmet | V5: confirmed entries change only through `case:confirmScope` or a verified quote |
| A quote confirms a criterion | "ok" is quoted to confirm anything | The criterion's text must be words from the quote (`wordsInText`), the rule `create_case` uses for an objective |
| A spoken scope answer over MCP | A client with `cases:answer` confirms scope | The existing trust in that scope (quotes are recorded, not checked, off the app); the options are only "all" and "none" of exactly the hashed entries; closing stays pressed. Accepted by R-C8-2 |
| `met` | The model declares success | No tool sets a state. A record is written only by code after a second model's verdict whose every id code resolved; the state is recomputed on each read |
| The verify pass reads model-written facts | A `sourced` fact with an invented source is cited | Not prevented: `sourced` is model-declared (parent, stage 1). The row shows each evidence fact's provenance and source; an ingest-verified source is labelled as such; the owner sees the evidence on the close card |
| The verify prompt carries case text | Injection steers the verdict | **Bounded, not prevented.** A verdict can only name ids, and a `met` that code cannot resolve is an opinion. But a statement can steer the pass into a **false `met`** that cites facts that are real, active, shown to it and of an allowed provenance (`user`, `sourced`, `external-agent`): code checks that the cited facts hold, not that they show the criterion. It can also turn a met criterion `stale`. It cannot cite a fact that is missing, inactive, inferred, an open unknown, under a load-bearing unknown, or not shown; it cannot touch a proposed criterion; and it cannot close the case. The owner sees the cited evidence, with its provenance, on the criterion's row and on the close card, and only the owner's press closes (§18) |
| Tool results in the verify input | Third-party text argues for `met` | Only case-tool results are sent (R-C8-9), framed as not evidence; evidence must be a fact id |
| The close proposal | The model closes the case | It cannot: `done` is applied only from a press on `in-app` or `mobile`, by `setStatus` with `by: 'owner'`; `TRANSITIONS` gains no `runtime` row into `done` |
| The close card's text | Model text dressed as the list | Host lines first (summary, items, ids), the model's one-line note last and labelled; never cut; refused over 2,000 characters |
| Abandoned records | Another case reads them; they leak outbound | Never indexed across cases; no outbound reference syntax; shown only where private facts already are |
| The check command | Code runs on the owner's machine | Off by default; owner-named with an exact quote or typed in the panel; approved once on a pressed card that shows the argv; no shell; a narrow token alphabet; owner turns only; scrubbed environment; time limit; tree kill; output never committed or shown to a model or a remote client; admin-only in service mode |
| The same, honestly | The repository decides what the command does; the model can edit the repository | **Not controlled.** Stated on the approval card and in §18 |
| New `.kl/` files | The model edits them | `caseWriteRefusal` already refuses `Write`, `Edit` and `MultiEdit` anywhere under `.kl/` and on `brief.md`; a test names each new file. `Bash` is not covered (§18) |
| New settings | The model turns the check on | `chat-data.json` is in `DATA_DIR_GUARDED` for case turns; in service mode the key is admin-only. `Bash` is not covered |

Against the parent's principles: 2 (provenance is data) now covers scope as well as facts; 3 (rules are
gates) holds for `met`, for confirmed scope and for `done`; 6 (stop beats guess) is why an unusable
verdict changes nothing; 8 (host-agnostic) holds, everything new under `src/cases/` is Electron-free and
`tests/electron-boundary.test.js` covers it.

**What `met` means, in one sentence, for every surface that shows it:** the record holds active facts,
of the provenance shown, that a second model judged sufficient and code confirmed exist. It does not mean
the owner checked, and it does not mean a `sourced` fact's source was read by anyone but the model.

## 12. Refusal codes

Tool refusals are results (`{ ok: false, code, error }`), never throws; IPC refusals are `{ ok: false,
code, error }`.

| Code | Where | Meaning |
|---|---|---|
| `SCOPE_NOT_IN_QUOTE` | `Brief` | `provenance: "user"` on a criterion or the objective whose text is not words from a verified quote |
| `CRITERION_CONFIRMED` | `Brief` | The model tried to reword or drop a confirmed criterion |
| `OBJECTIVE_CONFIRMED` | `Brief` | The model tried to rewrite a confirmed objective without a verified quote |
| `CRITERION_DUPLICATE` | `Brief`, `case:confirmScope` | The same words are already a criterion |
| `CRITERION_LIMIT` | `Brief`, `case:confirmScope` | More than 12 criteria, or more than 6 proposed |
| `CRITERION_INVALID` | `Brief`, `case:confirmScope` | Not one plain line of 3 to 300 characters |
| `CRITERION_NOT_FOUND` | `case:confirmScope` | No such id |
| `SCOPE_STALE` | `case:confirmScope`, the scope answer | The words changed since they were shown |
| `SCOPE_NOTHING_PROPOSED` | `Progress.askScope` | Nothing to confirm |
| `SCOPE_QUESTION_OPEN` | `Progress.askScope` | A scope question is already open (names it) |
| `ALREADY_ABANDONED` | `Progress.abandon` | An active record has the same approach (names it) |
| `ABANDON_INVALID` | `Progress.abandon` | A missing or malformed field, or an unknown fact, decision or record id |
| `NO_CONFIRMED_CRITERIA` | `Progress.proposeDone` | Nothing is confirmed |
| `NOT_READY` | `Progress.proposeDone` | A confirmed criterion is not `met`; lists the open items. Never returned to the owner's own Done |
| `VERIFY_NOT_ON_REQUEST` | `Progress.verify` | `cases.verify.when` is not `request` |
| `CLOSE_PROPOSAL_OPEN` | `Progress.proposeDone` | One is already open (names it) |
| `CLOSE_DECLINED_UNCHANGED` | `Progress.proposeDone` | The owner said keep working and the list has not changed |
| `QUESTION_TOO_LONG` | `Progress.askScope`, `Progress.proposeDone` | The host-built card would pass 2,000 characters (existing code, new callers) |
| `CHECK_INVALID` | `Brief`, `case:setCheck` | The command fails `validateCheck`; says which rule |
| `CHECK_NOT_IN_QUOTE` | `Brief` | The whole command is not in the owner's message |
| `CHECK_NO_LOCAL_REPO` | `Brief`, `case:setCheck`, the run | `repo` is a clone URL or a path that is not there |
| `CHECK_DISABLED` | `case:setCheck`, the run | `cases.softwareRepo.check.enabled` is false |
| `CHECK_SERVICE_OFF` | the same, in service mode | The admin file does not enable it |
| `CHECK_NOT_APPROVED` | the run | No approval matches the command and repository |
| `CHECK_BUSY` | the run | Another check is running in that repository |
| `CHECK_SHIM` | `case:setCheck`, the run | On Windows the program resolves only to a `.cmd` or `.bat` file (and is not `npm` with `npm-cli.js` beside `node.exe`) |

Reasons an opinion carries (not refusals): `evidence-empty`, `evidence-missing`, `evidence-inactive`,
`evidence-provenance`, `evidence-blocked`, `check-not-current`.

## 13. Error handling

| Situation | Behaviour | The owner sees |
|---|---|---|
| `.kl/scope.json` unreadable or not an object | Treated as absent: the view is rebuilt from `brief.md`, every entry `file`/`proposed`; the next locked write replaces the file; one warning | Criteria read `proposed`, "changed outside the app" |
| `.kl/verification.json` unreadable | Treated as empty: every confirmed criterion `unmet`; replaced on the next write; one warning | States drop to `unmet` until the next pass |
| `.kl/abandoned.jsonl` has a bad line | The line is skipped, the rest shown; one warning line in the orientation, as for a bad ledger line | Nothing missing but that record |
| `brief.md` unreadable (`BriefError`) | Scope and progress are unavailable; the orientation's existing brief error line stands; no pass runs | The existing "brief.md could not be read" |
| The same criterion text twice in `brief.md` | One entry; the second string is ignored and noted | A note beside the criterion |
| No usable `verify` model (`NoUsableModelError`) | `resolveCaseRole` falls back to `judge`'s target, as today; with none at all the pass is skipped | The journal block says the pass did not run and why |
| The verify call times out, errors, or replies with the wrong shape | No state changes; usage that was reported is still charged | `Verify pass: no usable verdict (…)` in the journal, as the pass's own entry |
| The verify call settles after the time limit, or after the pass was dropped | Its verdict is not applied; its usage is charged once, when it settles (§6.5) | The spend; nothing else |
| A turn starts while the pass is out | The pass is dropped: its call is stopped and nothing of its result is written; the case's next verified close runs the pass it is owed | The criterion keeps its state until that close |
| The owner sends a message while the pass is writing its result | The turn waits for that commit (at most 5 s), then starts | Nothing |
| The reply names a criterion twice or an unknown id | The whole reply is dropped | The same |
| The `usd` budget reaches 100 % during the pass | `usageHook` pauses the case through `onCrossings` as for any call; the verdicts already parsed are applied | The existing budget pause |
| The owner presses Stop | The turn's abort signal ends the check; the stopped exit passes no `verify`, so no pass is prepared. A pass that is already out belongs to a turn that is over and is not stopped by Stop | Nothing new |
| Shutdown while a pass is out | `beginShutdown` stops its call; `shutdown()` awaits it within `shutdownTimeoutMs`; nothing of its result is written, no lock is left | Nothing new |
| Shutdown during a close | `abortUnattended` and the turn signal abort the turn; the check's process tree is killed and awaited; a turn that closes after shutdown began prepares no pass | Nothing new |
| The check's program is not installed | `spawn-failed`; no state changes | `Check: not run (npm was not found)` in the panel |
| The check passes the time limit | Killed; recorded `timeout`; check-backed criteria `failing` | `failing`, with "timed out after 120 s" |
| The snapshot is missing or stale at close | No check is run (the head it would be tied to is not known); `chk-` evidence resolves as `check-not-current` | `stale`, "repository state is stale" |
| A close proposal is answered `done` from a channel that is not a press | Not applied; a note on the question | The card still shows its buttons |
| The scope answer arrives after a criterion was reworded | Entries whose hash differs are skipped; the rest apply; a note lists what was skipped | The skipped criteria are still proposed |
| `case:confirmScope` while a turn runs in the case | `systemAction` runs inline only for the lock's holder; another process gets `CASE_BUSY` | "Case is busy with a wake-up; try again in a minute." (existing) |

## 14. Testing

`node --test`, one file per module; no network, no model. A scripted provider stands in through
`routedProvider` (as `tests/cases-turn-runner.test.js` does) or `tests/helpers/fake-llm-server.js`;
models are configured with `tests/helpers/profile-settings.js` (`withCaseProfile`); every runtime is `new
CaseRuntime({ root: <temp>, now })`; a test that builds a core calls `closeOpenHistoryStores()` before
removing its data dir and `await core.shutdown()`. Timeouts are awaited behind a ref'd timer.

- **`tests/cases-scope.test.js`:** an entry per criterion; ids never reused; hash stable under case, white
  space and curly quotes; `view` never writes; `reconcile` is idempotent; a reworded string becomes a new
  `proposed` entry and the old one moves to `removed`; a duplicate string is one entry; `confirm` with a
  stale hash refuses; origins per writer; a corrupt file is rebuilt; **migration:** a stage-7 case fixture
  reads unchanged byte for byte until the first locked write, then gets `legacy` entries, all `proposed`; a `done` case never gets the file.
- **`tests/cases-tools.test.js` (extended):** `Brief` append without a quote is `proposed`; with a quote
  in `ownerMessages` and the text in the quote, `confirmed`; a quote that is in the messages but does not
  contain the text refuses `SCOPE_NOT_IN_QUOTE`; `provenance: "user"` with no quote refuses (it passed
  before); a list `update` that drops a confirmed entry refuses and one that drops a proposed entry works;
  `objective` rules; limits. Tests supply `ownerMessages`.
- **`tests/cases-brief.test.js` (extended):** `missingForGating` reports `successCriteria` with none confirmed and
  stops with one; a brief already
  `gating.complete` stays so.
- **`tests/cases-abandoned.test.js`:** append, withdraw, duplicate refusal, unknown ids, a bad line
  skipped, the cap in the orientation, status rules per case status.
- **`tests/cases-verify-status.test.js`** (pure): every row of §6.3; precedence; a superseded, a retracted
  and a reworded case; `verify-disagreed`; `chk-` at another head, with a dirty tree, and failing; proposed
  entries have no state; the summary line.
- **`tests/cases-verify-judge.test.js`:** skipped when nothing was written, when stopped, over the daily
  cap, over the budget percent, with no confirmed criterion; the input holds the confirmed criteria and
  this turn's records and **never the journal text or the assistant's reply** (a canary string in both);
  the input cap; every row of the acceptance table; an inferred, an unknown, a missing and a superseded
  id; a load-bearing unknown on the same `subject.attr`; a malformed, a fenced and a prose-wrapped reply;
  a duplicate criterion id; timeout through the abort signal; usage charged through `usageHook` and filed
  under the `verify` role (`UsageTracker` by-role totals); `endTurn` commits when the pass throws.
- **`tests/cases-verify-readiness.test.js`:** each item `ok`, `open`, `unknown` and `n/a`; `fix` holds ids
  and counts and never a criterion's or question's text (a canary); `ready`; the fingerprint changes when
  a state does. Jobs, envelopes and plans come from `tests/helpers/executor-fixtures.js`; ingest proposals
  from `tests/helpers/ingest-harness.js`.
- **`tests/cases-progress-tool.test.js`:** each action in each status; `proposeDone` refuses for an `unmet`, a `stale` and a
  `failing` criterion; the decline memory; the close answer applies from `in-app` and `mobile` and from nothing
  else (`in-app-chat`, `mcp-stdio`, `mcp-frontdoor`, a contact channel); `setStatus` is called with `by:
  'owner'`; `askScope` confirms only entries whose hash matches; a free-text answer confirms nothing; the
  card text is host lines first and refuses over 2,000 characters. Tests begin a turn before calling
  actions that need one.
- **`tests/cases-runtime.test.js`, `tests/cases-triggers.test.js` (extended):** marks at `beginTurn`; the
  verification hook raises `criterion-regressed` once and `Reorient` acknowledges it; the journal block is
  first in the entry; `freezeProgress` at `done` (R-C8-7).
- **`tests/cases-orientation.test.js` (extended):** the two sections, their caps, a proposed objective, a
  case with no stage-8 files, a frozen case.
- **`tests/cases-case-guard.test.js` / `tests/cases-chat.test.js` (extended):** `Write`, `Edit` and
  `MultiEdit` to `.kl/scope.json`, `.kl/abandoned.jsonl`, `.kl/verification.json` and `.kl/checks.json`
  are refused in a case turn (one named test per file).
- **`tests/cases-leaks.test.js` (extended):** an abandoned record of case B never appears in any hit
  returned to case A; the index builds no document from it; the source grep for `includePrivate` still
  passes.
- **`tests/cases-ipc.test.js` (extended) and a new `tests/cases-progress-ipc.test.js`:** the three
  channels; `SCOPE_STALE`; `untrustedText: true` on the reply; `CASE_BUSY`.
- **MCP:** the tests for `src/mcp/case-tools.js` (extended): `open_case` carries `progress` inside the
  untrusted wrapper; `list_cases` counts are bare numbers; a case chat's `caseScope` still confines them;
  `answer_question` refuses `close-proposal` and `check-approve` on every channel, and takes `scope-confirm` as a spoken answer. Through `tests/helpers/stdio-mcp-client.js` and
  `tests/helpers/frontdoor-harness.js` for the two remote surfaces.
- **`tests/cases-check.test.js`:** `validateCheck` accept and refuse tables; `checkInQuote` (whole
  command, exact case, never assembled from tokens); approval binds to the argv and the repository;
  refused when off, unapproved, in a wake-up turn, in service mode without the admin key, for a clone URL;
  the environment the child sees (a fixture script that prints the names of its variables: no provider
  key, no other `KL_*`, no `ELECTRON_RUN_AS_NODE`); the time limit kills a child and its grandchild; Stop
  kills it; the output tail is under `.kl/runs/` and in no tracked file; pass to fail writes the journal
  line first. The child is a `node` fixture script in a temp git repository; on Windows (by an injected `platform` and `fsCheck`,
  so it runs anywhere) a `.cmd` shim is refused and `npm` resolves to `node.exe` with `npm-cli.js`. The file awaits every child, so nothing holds the loop open.
- **`tests/cases-regressions.test.js`:** fixture **F8-progress**: a "Lakeside lot" case where the model
  appends two criteria (proposed), the owner confirms one by quote and one from the panel, a turn records
  `f-0042` and the scripted verify reply cites it (`met`), a later turn supersedes `f-0042` (`stale`, a
  trigger, the journal line), `proposeDone` refuses then succeeds, and the press closes the case with the
  list frozen.
- **`tests/electron-boundary.test.js`** covers the new files with no change.
- **E2E (`tests/e2e/cases.test.js`):** with `KL_CASES_ROOT` seeded by `launchApp({ seed })`: the panel
  shows a proposed criterion, Confirm makes it confirmed, and a seeded close proposal's card shows the
  list and its two buttons.

**Silent conditions and their tests:**

| Condition | Pinned by |
|---|---|
| A criterion reworded by one character | scope "reworded": new entry, `proposed`, its record no longer counts |
| The model confirms its own criterion with a quote of "yes" | tools "quote does not contain the text" |
| The verify reply cites a real fact that is `inferred` | judge "inferred id": opinion, state unchanged |
| The assistant's reply says "all criteria are met" | judge "prose never reaches the pass" |
| A `done` case's repository moves | runtime "frozen at close" |
| An older version rewrote the criteria list | scope "strings with no entry after migration are `file`" |
| The owner hand-edits `brief.md` | scope "file edit is proposed" (R-C8-8) |

## 15. Build order

Each task ends with its own tests green; the full suite runs once at the end of the stage.

1. **`ScopeStore` and `.kl/scope.json`:** ids, hashes, `view`, `reconcile`, `confirm`, `drop`, the
   migration read.
2. **`Brief` tool scope rules:** quote and word rules for criteria and the objective; confirmed entries
   refuse; limits; journal wording.
3. **Runtime wiring for scope:** `reconcile` in `beginTurn`; `createCase`'s `objectiveBy`; the detour
   router and playbook gating origins; gating (R-C8-2).
4. **Abandoned approaches:** the store, the cross-case exclusion, the leak test.
5. **Verification store and pure state computation:** records, resolvers for `f-`, the summary line.
6. **Ready to close:** `closeReadiness` with every item, the fingerprint.
7. **Turn marks and `collectTurnEvidence`:** the marks, the evidence registry and its seam, `endTurn`'s
   new fields, the two callers.
8. **The verify pass:** prompt, strict parse, `acceptVerdict`, charging, skips, the journal block.
9. **The verification hook and trigger:** `criterion-regressed`, `Since last turn`, the cache, freezing at
   close (R-C8-7).
10. **The `Progress` tool:** five actions, status ops, `scope-confirm` and `close-proposal` with their
    handlers, `PRESSED_TYPES`, the prompt lines.
11. **Orientation:** the two sections and their caps.
12. **IPC and the panel:** `case:progress`, `case:confirmScope`, the Progress block, the two cards, the
    Done dialog.
13. **MCP:** `open_case`, `list_cases`, `get_orientation`; the pressed refusals; the front-door and stdio
    tests.
14. **The check command, part 1:** the `check` field, `validateCheck`, the quote rule,
    `check-approve`, `.kl/checks.json`, the settings and the admin key. Nothing runs yet.
15. **The check command, part 2:** `runCheck`, the close run, `chk-` evidence, `failing`, pass to
    fail, the Windows lookup.
16. **Regression fixture, e2e, `CLAUDE.md` section, full suite.**

Tasks 14 and 15 come last and ship behind the setting (R-C8-3); the stage is usable without them. The
plan splits some of these further.

## 16. Deviations from the parent

1. **§4.3** shows `successCriteria` as plain strings the owner or the model wrote. Stage 8 keeps the
   shape and adds authorship beside it; a proposed criterion no longer satisfies anything.
2. **§5.5** closes a turn by rendering, journaling and committing. Stage 8 adds, behind its setting, a
   host-run command to the close, and a model call (the verify pass) that the close prepares and that
   runs after the turn released the case (R-C8-11), with a commit of its own.
3. **§5.6** has seven case tools and the code has twelve; `Progress` is the thirteenth.
4. **§9.2** gives `verify` to "ledger consistency review; second reading of blocked outbound spans".
   Stage 8 adds the criteria pass to that role.
5. **Stage 2 §3.1** has no runtime path to `done`. That stands: the model's proposal is a question, and
   the transition is still the owner's.
6. **Stage 5 §3.7** says `refresh` runs read-only commands with 5 s timeouts. Behind its setting, the case type
   also runs one owner-named command, not read-only, with a longer limit, at close only.

### 16.1 Deviations from this spec, recorded while building

Each is in the plan's Deviations with its tests; the ones that change what a reader of this spec would
assume:

1. **Check now** (owner ruling 2026-10-13, the plan's N2): the case panel has a button that runs the
   verify pass outside a turn on the owner's press (`case:verifyNow`), in every `when` but `off`. It does
   not run the check command (R-C8-N4).
2. **The create form has an Objective field** (owner ruling 2026-10-13, the plan's N3): §2.1's "sends no
   objective" is no longer so. What the owner types there is confirmed (origin `owner-create`), and only
   for an event of the app's own window.
3. **`create_case` over MCP** makes the objective `proposed`, origin `mcp-create` (R-C8-N3; §6.1).
4. **npm only** (R-C8-N5, N6): §6.6's list of what may be named is narrowed to `npm test` and
   `npm run <script>`.
5. **The verify pass's result is a journal entry of its own** (kind `verification`, R-C8-11), not the first
   lines of the turn's entry; §7.6's journal kinds gain it. A check that changed something on **Check
   now** writes the same kind.
6. **A regression the turn made itself raises no trigger at the next turn start.** The turn is told at its
   own close (the block heading its journal entry) and the close writes the state cache;
   `criterion-regressed` is raised for a change between turns.
7. **The `Brief` tool does not confirm a criterion the model already proposed** (`CRITERION_DUPLICATE`
   for the same words with a quote). The owner confirms it by a press or by answering a `scope-confirm`
   question.
8. **A new refusal code, `SCOPE_INVALID`**, for a caller's malformed scope action or origin (never shown
   to the model).

## 17. Assumptions made without asking

Smaller than §2; each is the designer's choice and is easy to change.

- Criteria are capped at 12, proposed at 6; a criterion is one line of 3 to 300 characters.
- The scope question offers only "Confirm all" and "Drop all"; one at a time is done in the panel.
- A `verify` verdict of `unmet` on a `met` criterion makes it `stale` (V7). Alternative: ignore it.
- A reworded criterion starts again at `unmet`. Alternative: carry the record over when the owner made
  the edit.
- `stale` and `failing` raise a blocking re-orientation trigger. Alternative: a note only.
- The verify pass sees other active facts as one-line rows up to the input cap, newest first.
  Alternative: this turn's records only, as the outline says, at the cost of never citing an older fact.
- The close proposal is charged to `questionsPerDay`; a decline is remembered until the list changes.
- An `active` envelope counts against "ready"; an expired or exhausted one does not.
- The pass is skipped above 80 % of the `usd` budget and capped at 24 a day.
- `branch-merged` looks only at a PR from the current branch.
- Check output is kept only as an untracked 2,000-character tail.

Not verified, and what breaks if wrong:

- **The verify pass fits in 20 s and costs a few cents a turn.** Not measured. If it is slower, the
  states update late or the pass times out and nothing is judged (no turn closes late for it:
  R-C8-11); if it is dearer, the daily cap and the 80 % rule bound it.
- **`npm-cli.js` sits at `node_modules/npm/bin/npm-cli.js` beside `node.exe`.** True of the official
  Windows installer; a version manager may lay it out differently, and then `npm` is refused
  (`CHECK_SHIM`) rather than run some other way.
- **`src/cases/` may require `resolveCommand` from `src/service/doctor-runbooks.js`.** No boundary test
  was read that forbids it. If one does, the function moves to `src/platform/` unchanged.
- **A close card stays under the phone channel's `maxChars`.** If not, the phone shows "Answer this in
  the app" and the owner closes from the app.

## 18. Residuals

Stated plainly; none is fixed here.

- **`Bash` can write every new file.** `.kl/scope.json`, `.kl/abandoned.jsonl`, `.kl/verification.json`
  and `.kl/checks.json` are guarded for `Write`, `Edit` and `MultiEdit` and not for `Bash`, exactly like
  `facts.jsonl`. A shell command can mark a criterion `confirmed`, write a verification record that cites
  real active facts (the recomputed state would then read `met`), or record an approval for the check.
  Recomputing states (V3) defeats only the laziest forgery, a flipped status word. The approval-gated
  `Git` tool can likewise restore an older version of any of them.
- **`sourced` is model-declared.** A criterion can be `met` on a fact whose source the model named and
  nobody opened. The row shows the provenance; nothing checks the source.
- **The verify pass is a model.** It can be wrong in both directions. Code bounds what a wrong `met` can
  rest on (real, active, eligible facts); it cannot tell whether those facts add up to the criterion.
- **A fact's statement can steer the verify pass into a false `met`.** The pass reads statements the
  case model, a document or an external agent wrote. A statement written to argue ("this shows sc-002
  is met") can get a `met` that cites real, active, shown facts of an allowed provenance, and code
  accepts it: every cited id holds. What limits it: it cannot cite a missing, inactive, inferred,
  unknown-blocked or unshown fact; it cannot touch a proposed criterion; it cannot close the case. The
  owner sees the cited evidence and its provenance on the row and on the close card, and only the
  owner's press closes. A wrong `met` does let the model's `proposeDone` through to that card.
- **The states lag the reply by the length of the verify call** (R-C8-11), and a pass dropped by a newer
  turn is made up only at the case's next verified close in the same run of the app. A criterion can
  read `unmet` on evidence that is already recorded until then.
- **A provider that bills for a stopped call and reports nothing** is not charged to the case: the
  charge is what the call reports when it settles (a full reply, or the partial usage attached to the
  abort).
- **The check command runs the repository's code** with the account's access, and the model can change
  that code in an owner turn. Read-only and offline are not enforced and cannot be. The token rules stop
  shell tricks, not a hostile `package.json`. An approval covers words whose meaning can change.
- **Environment scrubbing is partial.** A program can read files in the home directory (tokens, keys)
  whatever its environment holds.
- **On Windows only `.exe` programs and `npm` can be the check.** A `.cmd` or `.bat` shim is never
  started, so `pnpm`, `yarn` and `gradlew.bat` cannot be used until the owner rules on it.
- **A spoken scope answer off the app is unchecked** (accepted, R-C8-2): over MCP the quote is
  recorded, not verified, as for every spoken answer.
- **Abandoned records are free text.** The outbound gate does not know them; a model that restates one in
  an outbound payload is stopped only if the text also trips rules 1 to 4 for other reasons.
- **A hand edit by the owner looks like a `Bash` write** (R-C8-8), so the owner's own edit to `brief.md`
  needs a press to count.
- **`branch-merged` does not know which PRs are the case's.** A PR the case opened from another branch is
  not counted.
- **A check passing on a dirty tree proves nothing that is recorded.** The case must commit to get check
  evidence; work that is never committed can never be `met` by a check.
- **An older version that opens a newer case** lets the model rewrite the criteria list unmarked; the
  newer version shows the result as `proposed`, so nothing is trusted, but the owner's confirmations of
  reworded entries are lost.
- **Imported cases are not re-checked,** as with `facts.jsonl`.
- **The verify pass's cost is estimated, not measured** (R-C8-4).

## 19. Deferred

| Item | Stage |
|---|---|
| Structured child hand-off as an evidence source and id resolver (§6.10) | the next cases stage |
| Refusing or flagging a `Plan` step that repeats an abandoned approach | unassigned |
| Recording which PRs and branches a `software-repo` case created | unassigned; would make "PRs merged" exact |
| A way out of `done` | unassigned (R-C8-7) |
| Checks for other case types; more than one check per case | unassigned |
| Running the check in a sandbox or container | unassigned; the only real answer to §18's fourth item |
| Per-criterion confirmation from the phone or by spoken answer | unassigned; the panel does it today |
| Measuring the verify pass (cost per turn, false `met` rate) on real cases | after the stage ships |

## 20. Dependencies (npm)

None. Hashing is `node:crypto`; the check uses `node:child_process`; YAML and JSON readers are the ones
the stores already use.
