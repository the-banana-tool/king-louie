# Cases Stage 8: Verified progress — Design Spec

- **Status:** Draft. Section 2 holds the choices that are the owner's; nothing in it is decided.
- **Date:** 2026-10-13
- **Parent:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` §3.1 (principles), §4.3
  (`brief.md`), §4.5 (`.kl/`), §5.2 (orientation), §5.3 (triggers), §5.5 (turn lifecycle), §5.6 (case
  tools), §7.1 (recommendation gate), §9 (budgets, roles).
- **Builds on:** stage 2 (`2026-09-23-cases-stage2-unattended.md`: status, questions, budgets, wake-ups,
  roles), stage 3 (`…-stage3-executors.md`: jobs, envelopes, `external-agent` facts), stage 5
  (`…-stage5-detours.md`: case types, `software-repo`), stage 7 (`…-stage7-ingest.md`: the verify
  verdict), management surfaces (`2026-09-30-management-surfaces.md`: spoken and pressed, the chat card,
  the case tools over MCP), models (`2026-09-27-model-catalog-profiles-roles-design.md`: roles, usage).
- **Depends on:** C1 to C7 and the management surfaces, all on `main` (a6189a7).
- **Agreed in outline with the owner on 2026-10-12.** The outline is the five parts of §1. Every detail
  below is a proposal.

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

## 2. Open questions for the owner

Each question says what the code and the earlier specs say today, the options with their cost, and a
recommendation. The rest of the spec is written to stand whichever way each is answered; sections that
change with an answer are marked **[depends on Q-x]**.

### Q-a. May the model propose `done` while a confirmed criterion is not `met`?

**Today.** There is no proposal. `done` is reached only by the owner: the case panel's Done button
(`CASE_STATUS_ACTIONS` in `renderer.js`, IPC `case:setStatus`, `setStatus(…, { kind: 'owner', by: 'owner'
})`); `TRANSITIONS` in `src/cases/status.js` has no `runtime` row into `done`. Management surfaces §3.1
lists "a case's status (pause, resume, close)" as pressed.

| Option | What it means | Cost |
|---|---|---|
| 1. Only when all are `met` | `Progress.proposeDone` is refused (`NOT_READY`) while any confirmed criterion is `unmet`, `stale` or `failing`. The owner's own Done button still works, with the list shown | A criterion nothing in the record can show (taste, "I'm happy with it") blocks the proposal until the owner says so in words (a `user` fact is evidence) or presses Done themselves |
| 2. `met` or `stale` | As 1, but `stale` does not block | A case can be proposed as done on evidence that was corrected since |
| 3. Always, with the list shown | The proposal is always allowed; the card shows what is open | The model can ask to close early and often; `questionsPerDay` and the decline memory (§6.4) are the only brake |
| 4. Nobody closes while not ready | As 1, and the Done button is refused too until the owner drops or confirms what is open | The owner cannot close a case they are finished with without first editing its criteria |

**Recommendation: 1.** The proposal is the model's claim, so it has to rest on the record. The owner is
never blocked: their Done button always works and shows the list first (the unmet items are written into
the close record).

### Q-b. How does the owner confirm a proposed criterion, and is gating incomplete while one is only proposed?

**Today.** `brief.successCriteria` is a list of strings; `USER_ONLY_FIELDS` in `src/cases/brief.js` does
not include it or `objective`, and the `Brief` tool checks a quote only for owner-only fields, so
`provenance: "user"` on a criterion is accepted with no quote at all. `GATING_REQUIRED` is `objective`,
`why`, `successCriteria`: a criterion the model wrote itself satisfies gating. There is no IPC that edits
the brief; the panel has no brief editor.

Confirmation paths:

| Option | What it means | Cost |
|---|---|---|
| 1. Panel only (pressed) | A Confirm and a Drop button per criterion in the case panel and on the scope card; `answer_question` refuses the scope question on every channel | The owner must be at the app or the phone; "yes, those are right" typed in the chat confirms nothing |
| 2. Spoken with a quote | The scope question is spoken: `answer_question` with the owner's quote naming "Confirm all" or "Drop all"; no buttons | Over MCP (`mcp-stdio`, the front door under `cases:answer`) a quote is recorded, not checked, so a client holding that scope can confirm scope the model proposed |
| 3. Both | Buttons in the panel and on the card, and the spoken answer | Option 2's cost; the most natural for the owner |

A criterion is also `confirmed` at birth, on every option, when the `Brief` tool adds it with a quote that
`requireOwnerQuote` finds in the owner's messages and the criterion's text is words from that quote, or
when a playbook gating answer writes it (`applyToBrief`, already `provenance: 'user'` from an answered
question).

Gating:

| Option | What it means | Cost |
|---|---|---|
| A. Unchanged | Any non-empty `successCriteria` satisfies gating | A case can leave `draft`, plan and send with no criterion the owner ever saw |
| B. At least one confirmed | `missingForGating` reports `successCriteria` until one criterion is `confirmed` | One more owner step before a new case goes `active` |
| C. None proposed | As B, and gating stays incomplete while any criterion is still `proposed` | The model cannot leave a suggestion standing while work starts |

**Recommendation: 3 and B.** Success criteria are what the owner alone knows, which is what the gating
pass exists to ask. A case already past gating is never sent back to `draft` (§10).

### Q-c. The check command of a `software-repo` case

**Today.** `software-repo.refresh` runs fixed, read-only `git` and `gh` argv through `execFile` with no
shell, 5 s each, inside `cases.softwareRepo.refreshBudgetMs` (6 s), at turn start. No case code runs a
command the owner or the model names. A wake-up turn has no `Bash`, `Write` or `Edit`
(`allowedToolNames` is the case tools plus `WAKEUP_BASE_TOOLS`), so today nothing in an unattended turn
executes code. The command named here would be the first host-run program whose behaviour the repository
decides: `npm test` runs whatever `package.json` says, and the model can edit `package.json` in an owner
turn. **Read-only cannot be enforced on an arbitrary command, and neither can "no network".** §6.6 says
what can be held.

| Question | Options | Cost |
|---|---|---|
| In stage 8 at all? | 1. Deferred to its own stage. 2. Built last, off by default (`cases.softwareRepo.check.enabled`). 3. Built, on by default | 1: `software-repo` cases get `stale` from the head moving but never `failing`, and no check evidence. 3: a new case type field that runs code as soon as the owner names one |
| Approval | 1. Every run asks. 2. Once per exact command and repository, by a pressed card that shows the argv. 3. None beyond the owner naming it with a quote | 1: two prompts a turn; nobody keeps it on. 2: the approved words can come to mean something else when the repo changes. 3: the quote proves the owner wrote the words, not that they meant "run this every turn" |
| Unattended | 1. Never in a wake-up turn. 2. In a wake-up only when head and tree are what the last owner turn left. 3. Always | 1: a criterion backed by the check goes `stale` when the repo moves while the owner is away, and stays so until an owner turn. 2 and 3 put code execution into turns with no one watching |
| Service mode | 1. Off unless the admin `service.json` enables it. 2. As on the desktop | 1: one more admin key. 2: the service account runs a command named in data-dir files it can write |
| When it runs | 1. At turn close, only when head or tree changed in the turn, waiting up to a cap. 2. After the turn, in the background, the result landing in the next turn. 3. At both turn start and close, always | 1: the turn's last step can take minutes. 2: "pass to fail across this turn" is reported one turn late. 3: every turn pays the suite's run time twice |

**Recommendation:** build it **last and off by default**; **approved once** per exact command and
repository on a pressed card; **owner turns only, never in a wake-up**; **off in service mode** until the
admin enables it; **at close only when the tree changed**, capped at 120 s, with the turn-start state taken
from the last recorded run rather than a fresh one. Parts 1 to 5 are complete without it.

### Q-d. The verify pass: when it runs, what it costs, which role

**Today.** `orient` and `classify` are one-shot calls charged to the case's `usd` budget through
`recordOneShotUsage` and `usageHook`. `verify` is already a case role (`src/cases/roles.js`): `main`, on a
provider family other than `judge`'s when one is usable. Ingest uses it per proposal. `CATEGORIES` in
`budget.js` is `usd`, `deadline`, `turnsPerDay`, `contactsPerDay`, `questionsPerDay`; a new category
touches grants, thresholds, triggers and the panel.

| Option | What it means | Cost |
|---|---|---|
| 1. Every changed turn | One call at the close of every turn that wrote a fact, a decision or an executor result | One `main`-class call per working turn: roughly the criteria plus up to 12,000 characters of records in, at most 1,024 tokens out. Not measured |
| 2. On request only | The pass runs when the model calls `Progress.verify` or proposes `done`, and when the owner presses "Check now" | A turn that met a criterion shows `unmet` until someone asks; the model decides when it is judged |
| 3. Once a day | With the `daily-orientation` wake-up, plus on request | Up to a day late |
| Budget | (i) charged to `usd` like orient; (ii) a category of its own; (iii) `usd` plus a per-day call cap in settings | (ii) is a schema change in five places for one caller |
| Role | (i) `verify` (main, other family); (ii) `utility` | (ii) is cheaper and reads the record less well, and it loses the "not the model that did the work" property |

**Recommendation: 1, (iii), (i):** every changed turn, on `verify`, charged to `usd`, with
`cases.verify.maxPassesPerDay` (default 24) and skipped when the `usd` budget has passed 80 %. The owner
can set `cases.verify.when` to `request`.

### Q-e. May `external-agent` facts alone make a criterion `met`?

**Today.** `external-agent` never counts as the owner. The recommendation gate accepts it (it refuses only
`inferred` and `unknown`). The outbound gate's rule 3 does not (`BACKING` is `user`, `sourced`). An
executor's value never supersedes a `user` or `sourced` fact (`assertExternal`). `external-agent` facts are
written by host code from a pinned adapter's record; `sourced` facts are declared by the model.

| Option | What it means | Cost |
|---|---|---|
| 1. Yes | `user`, `sourced` and `external-agent` are equal as evidence | "Three written quotes received" can be `met` on what a phone agent reported and nobody checked |
| 2. Only beside a `user` or `sourced` fact | At least one cited fact must be `user` or `sourced` | The model can supply that fact itself by declaring a `sourced` one, which is weaker than the executor's record |
| 3. Never | `external-agent` ids are rejected as evidence | A criterion about what an executor did can only be met by the owner saying so |

**Recommendation: 1,** with the provenance of every evidence fact shown on the criterion's row and on the
close card ("reported by phone-agent"). Option 2 looks stricter and is not.

### Q-f. Existing cases: are their criteria `confirmed` or `proposed`?

**Today.** Nothing on disk says who wrote a criterion. The journal has `Brief successCriteria appended
(model)` lines, but `(user)` there was never checked for this field, and a detour-created case's first
criterion is the detour's summary (`DetourRouter`, `provenance: 'model'`).

| Option | What it means | Cost |
|---|---|---|
| 1. Grandfathered | Every existing criterion reads `confirmed` (origin `legacy`) | Authorship nobody knows is recorded as the owner's |
| 2. Proposed until confirmed | Every existing criterion of an open case reads `proposed` (origin `legacy`); the panel offers "Confirm all" | Each open case needs one press before anything counts; until then its summary reads "0 confirmed criteria" |
| 3. Asked once | As 2, and each open case gets one scope question on its first turn after the upgrade | A burst of questions on the first day |

**Recommendation: 2.** A `done` or `abandoned` case is never migrated and reads as it does today (§10).
The same answer applies to an existing case's objective.

### Q-g. What does `stale` do to a case that is already `done`?

**Today.** `done` is read-only (`ALLOWED.done` is the read ops and `Playbook.propose`), its wake-ups are
cancelled, and there is no transition out of `done`. A `software-repo` case's repository keeps moving
after the case closes, so "the tree changed" would make every closed repo case `stale` within days.

| Option | What it means | Cost |
|---|---|---|
| 1. Frozen at close | The states and the list are recorded when the case closes and never recomputed | A fact corrected later through another path is not reflected here |
| 2. Recomputed, shown only | The panel and `open_case` show current states; nothing notifies | Closed repo cases all read `stale`; the word stops meaning anything |
| 3. Briefing | As 2, and a low briefing when a closed case's criterion goes `stale` from a fact (never from the tree) | Needs a writer into a `done` case, which nothing has today |
| 4. Reopen | A `done → active` transition | A new status transition and its rules; out of proportion here |

**Recommendation: 1.**

### Q-h. A change to `brief.md` made outside the case tools

**Today.** The owner may edit a case's files in an editor; `beginTurn` commits them as `owner edits`. The
same bytes can be written by a `Bash` command the model runs (the stage 1 write-guard gap), and code
cannot tell which it was.

| Option | What it means | Cost |
|---|---|---|
| 1. Not the owner's | A criterion or an objective that appears or changes in the file with no tool behind it is `proposed` (origin `file`), with "changed outside the app" beside it | An owner who edits the file confirms the edit with one press |
| 2. The owner's | A file edit confirms | One `Bash` line confirms any scope the model likes |

**Recommendation: 1.**

### Q-i. Which tool results the verify pass sees

**Today.** `CaseRuntime` never sees a turn's tool results; `endTurn` receives a summary and the assistant's
final text (which becomes the journal entry). Tool results live in the send path
(`src/ipc/chat-handlers.js`) and in `AgentLoop`'s return for a wake-up.

| Option | What it means | Cost |
|---|---|---|
| 1. Case-tool results only | Results of `Ledger`, `Decide`, `Executor`, `Ingest` and `Progress` calls of this turn | The judge does not see a `Bash` or `WebFetch` result the turn relied on; it sees the facts recorded from them |
| 2. Every tool result, capped | All of the turn's results, 1,000 characters each, 6,000 in total, framed as untrusted | Third-party text (a web page, command output) reaches the judge; it can argue, though it can never be evidence |
| 3. None | Only the record | The outline named tool results |

**Recommendation: 1.** Evidence has to be a fact id either way, so a result that was not recorded as a
fact cannot make anything `met`; option 2 adds an injection surface for no acceptance it can cause.

### Q-j. Does `Fail` add to the abandoned-approaches record?

**Today.** `recordFailure` writes `journal/…-failure.md` and moves the case to `needs-direction`. The
orientation shows that report only while the case is `needs-direction`; after the owner's direction the
failed approach is in no orientation section except, by chance, the last journal entry.

| Option | What it means | Cost |
|---|---|---|
| 1. No | Only `Progress.abandon` writes the record | After a direction answer the model has to record the dead approach itself or it is forgotten |
| 2. Yes, on the direction answer | When a `direction` answer resumes the case, code appends one record naming the failure report (`origin: 'failure'`) | The owner's direction may have been "try that again"; the record then says abandoned when it was not, until a `withdraw` line is added |

**Recommendation: 1** for this stage; the orientation line for a resumed case names the last failure
report so the model can record it.

## 3. Scope

### 3.1 In

- `src/cases/scope.js`: `ScopeStore`, `.kl/scope.json`, criterion ids, `proposed`/`confirmed`, the
  objective's mark, reconciliation with `brief.md`.
- `Brief` tool changes: quote rules for `successCriteria` and `objective`; refusals for changing confirmed
  scope.
- `src/cases/abandoned.js`: `.kl/abandoned.jsonl`.
- `src/cases/verify/`: `store.js` (`.kl/verification.json`), `status.js` (pure state computation),
  `evidence.js` (the turn's evidence and the id resolvers), `judge.js` (the verify pass), `readiness.js`
  (ready to close), `check.js` (the `software-repo` check command, behind Q-c).
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
| A way out of `done` (reopen) | not planned; Q-g |
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
| `owner-create` | objective only: `createCase` called by IPC `case:create` or by `create_case` (which has already held the objective to the owner's quote) | `confirmed` |
| `legacy` | Found in `brief.md` when the case first meets stage 8 | **[depends on Q-f]** |
| `file` | Found in `brief.md` later with no tool write behind it | **[depends on Q-h]**; `proposed` as recommended |

`createCase` learns who gave the objective from a new option, `objectiveBy: 'owner'`, passed only by the
two host callers above. Like `force`, no case tool accepts it; the detour router passes nothing, so a
detour's objective is `proposed`.

**Confirming** (`ScopeStore.confirm(ids, { by, channel, factId, quote })`):

- the panel or the scope card's buttons (IPC `case:confirmScope`, §8.1), recorded as `by: 'owner-action'`;
- an answer to a `scope-confirm` question (§6.7), recorded with the answer's `factId` **[class depends on
  Q-b]**;
- at birth, by `owner-quote` or `gating-answer`.

Every confirmation names the entry's `hash` as the caller saw it. A hash that no longer matches is refused
(`SCOPE_STALE`): the owner confirms the words that were shown, as a budget grant is checked against
current numbers and not the ones the question captured.

**The `Brief` tool** (`src/tools/builtin/case-tools.js`), `successCriteria` and `objective`:

- `provenance: "user"` on either field now requires a quote, as the owner-only fields do. The quote must
  be in `ctx.ownerMessages`, and the item (or the objective) must be words from the quote
  (`wordsInText`). A miss is refused (`SCOPE_NOT_IN_QUOTE`): `Quote the owner's words that state this
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

**Gating [depends on Q-b].** `Brief.missingForGating` takes the scope view. Under option B it reports
`successCriteria` until one entry is `confirmed`; under C, until none is `proposed`. `completeGating`'s
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
| `f-` | the ledger | the fact exists, is `active`, and its provenance is `user`, `sourced` or `external-agent` **[depends on Q-e]**; never `inferred` or `unknown`; and no active load-bearing unknown sits on the same `subject.attr` (the recommendation gate's `blockers` rule) |
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

**A `done` or `abandoned` case [depends on Q-g].** As recommended, `setStatus` to either status calls
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
- **[depends on Q-a]** refused with `NOT_READY` and the open items when the chosen rule is not satisfied
  (as recommended: any confirmed criterion not `met`);
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
  now; **[depends on Q-a]** under option 4 a list that is not ready refuses, with a note on the question;
  otherwise it calls `setStatus(id, 'done', { kind: 'owner', by: 'owner', ref: <answer fact id>, note:
  'close proposal q-0021; open at close: criteria-met (sc-003)' })`. The handler runs inside
  `answerQuestion`'s `systemAction`, as the direction handler does.

The panel's own Done button stays. Its confirm dialog shows the summary line and the open items first
(**[depends on Q-a]**: refused when not ready under option 4).

### 6.5 The verify pass at turn close — `src/cases/verify/judge.js`

**When.** In `endTurn`, before `renderOpenItems` and the commit, when all of these hold:

- the turn wrote something: a fact with `addedBy` this turn or a ledger line count above the mark taken
  at `beginTurn`; a decision count above its mark; or a job whose results were recorded this turn;
- the case is `active` or `needs-direction` after the turn, and at least one criterion is `confirmed`;
- the turn was not stopped, blocked or failed (`turn.signal` not aborted; the caller passed
  `verify: true`, which the stopped, blocked and failed exits of the send path do not);
- `cases.verify.when` is `changed-turn` **[depends on Q-d]**, the day's pass count is under
  `maxPassesPerDay`, and the `usd` budget has not passed `skipAboveUsdPercent`.

Otherwise it is skipped; a skip for budget or the daily cap writes one journal line a day.

**The call.** One call: `runtime.ensureRoleTested(caseId, 'verify', { turn })`, then
`runtime.routedProvider(turn, { role: 'verify' }).sendMessageWithTools(messages, [], { systemPrompt,
abortSignal })` (the tool-taking path, with no tools, because it is the path that returns `llmMetrics`),
then `recordOneShotUsage(runtime, turn, reply)` so the call is charged to the case's `usd` budget and
filed by role like orient. The helper moves from `turn-runner.js` to a shared module. A ref'd timer
bounds the call at `cases.verify.timeoutMs` (20 s) and aborts it.

**What it is given** (built by `collectTurnEvidence(runtime, turn, evidence)`, §6.10), in this order,
inside one data fence, at most `cases.verify.maxInputChars` (12,000):

1. The confirmed criteria: id and text. Never a proposed one.
2. For each, its current state and the evidence its newest record cites.
3. Facts written this turn: id, provenance, `subject.attr`, value, statement, source kind and ref, status.
4. Decisions written this turn: id, text, fact ids.
5. Executor results recorded this turn: job id, executor, state, the fact ids they produced.
6. **[depends on Q-c]** The newest check run: id, pass or fail, head, whether the tree was clean. Never
   its output.
7. **[depends on Q-i]** Tool results of this turn, capped, labelled as not evidence.
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

**After the pass**, `endTurn` writes the turn's journal entry with a host-written block ahead of the
model's text:

```
## Verification (written by King Louie)
- Check: pass → FAIL during this turn (chk-0012 at 3f2a91c → chk-0013 at 3f2a91c, uncommitted changes).
- Now failing: sc-002. Now met: sc-001 (f-0042, f-0051).
- Verify pass: 1 accepted, 1 not accepted (sc-003: f-0099 is inferred).
```

A regression (a check that went from pass to fail, a criterion that left `met`) is always the first line.
The block is written even when the model's text is empty.

**Failure is quiet and safe.** A timeout, a provider error, no usable model, or an unusable reply changes
no state, adds `Verify pass: no usable verdict (<reason>)` to the block, and never fails `endTurn`: the
turn commits as it does today.

### 6.6 The check command of a `software-repo` case — `src/cases/verify/check.js` **[all of §6.6 depends on Q-c]**

This is the dangerous part of the stage. What follows is the recommended form; Q-c can remove it.

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
- On Windows a program that resolves to a `.cmd` or `.bat` file (`npm`, `gradlew`) cannot be spawned
  without a shell on current Node. It is run as `cmd.exe /d /s /c` with the already validated tokens; the
  token alphabet above excludes everything `cmd.exe` interprets. This path needs its own tests on Windows
  before it ships (§14).
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

There is no action that sets a state, writes a verification record or runs the check. **[depends on Q-d]**
under "on request", a sixth action `verify` runs the pass of §6.5 on the whole record.

**`askScope`** creates one question through `createQuestion` (charged to `questionsPerDay`; refused with
`SCOPE_NOTHING_PROPOSED` when nothing is proposed and `SCOPE_QUESTION_OPEN` when one is open): `payload:
{ type: 'scope-confirm', key: 'scope-confirm', disclosable: false, entries: [{ id, hash }] }`, options
`[{ id: 'all', label: 'Confirm all' }, { id: 'none', label: 'Drop all' }]`. Its text is host-built: one
numbered line per proposed criterion (`shown` through `plainLineProblem`; text that is not one plain line
shows as `(text hidden: not one plain line)`), then the proposed objective if any. The answer handler
confirms, or drops, exactly the entries whose hash still equals the one in the payload; a free-text
answer confirms nothing and leaves a note (`Answer with "Confirm all" or "Drop all", or use the buttons
beside each criterion in the case panel.`). One at a time is done in the panel or on the card.

**[depends on Q-b]** Under "panel only", `scope-confirm` joins `PRESSED_TYPES` and its handler applies
only from `in-app` or `mobile`. Under "spoken" or "both" it stays spoken: `answer_question` takes it with
the owner's quote naming the option, on every channel that serves spoken answers.

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
- A `done` or `abandoned` case shows the frozen record with `as of <date>` **[depends on Q-g]**.

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
2. **new, when `verify` is true:** the verify pass of §6.5;
3. **new:** write the verification cache;
4. `renderOpenItems`, the journal entry (now with the host block first), `_closeTurnMeta`, commit,
   reindex, release (unchanged).

Steps 1 to 3 are wrapped so that nothing in them can keep the turn from committing and releasing.

Callers: the owner send path (`src/ipc/chat-handlers.js`) passes `verify: true` and `evidence` only on
its normal exit (the one that journals `answerText`); its stopped, blocked and failed exits pass
neither. `runWakeupTurn`'s `close` passes `verify: true` only for the `acted` outcome. `evidence` is `{
toolResults: [{ tool, action, ok, text }] }` **[contents depend on Q-i]**; the runtime caps it again and
never trusts its ids.

`CaseRuntime` gains `scope(id)`, `abandoned(id)`, `verification(id)`, `progress(id)` (the joined view the
panel, the tool and MCP all read) and `closeReadiness(id)`.

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

### 7.4 `.kl/checks.json` **[depends on Q-c]**

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
| `scope-confirm` | `Progress.askScope` | **[Q-b]** | `all`, `none` | yes |
| `close-proposal` | `Progress.proposeDone` | pressed | `done`, `keep` | yes |
| `check-approve` | setting or changing `check` | pressed | `approve`, `refuse` | no |

All three carry `disclosable: false`, so the `user` fact an answer writes is private at birth.

### 7.6 Journal kinds

`abandon` (one per abandoned record or withdrawal), `scope` (a confirmation or a drop made outside a
turn). The verification block is part of the turn's own entry, not a kind.

## 8. Interfaces

### 8.1 IPC — `src/ipc/case-progress-handlers.js`

All are in the `case` domain, which `PROXIED_DOMAINS` already proxies, so they work attached with no
allowlist change; attached, they run on the service.

| Channel | Payload | Reply | Notes |
|---|---|---|---|
| `case:progress` | `{ caseId }` | `{ ok, untrustedText: true, objective, criteria, summary, readiness, abandoned, check }` | Read only; no lock; no write |
| `case:confirmScope` | `{ caseId, action: 'confirm' \| 'drop' \| 'edit' \| 'add', target: 'objective' \| <sc-id> \| 'all-proposed', hash?, text? }` | `{ ok, progress }` | Inside `systemAction`. `confirm` and `drop` need the `hash` the panel showed (`SCOPE_STALE` otherwise). `edit` and `add` take the owner's typed `text`, write it to `brief.md` and record it `confirmed` (`by: 'owner-action'`). The only path that changes a confirmed entry |
| `case:setCheck` **[Q-c]** | `{ caseId, command?, approved? }` | `{ ok, check, questionId? }` | Sets `brief.check` (validated) and opens the approval question; `approved: false` withdraws every approval |
| `case:setStatus` (existing) | unchanged | adds `progress` | The Done confirm dialog reads `case:progress` first |

Each is an owner action, like `case:grantBudget`: the model has no path to them.

### 8.2 MCP and the chat's management tools

No new tool, no new scope, nothing added to `CASE_SCOPES`. Three read tools return more, all under
`cases:read` (whose grant text already says "including private facts"):

| Tool | Added |
|---|---|
| `list_cases` | per row, bare: `criteria: { confirmed, met, proposed }`, `ready: true \| false` |
| `open_case` | inside `data` (the `untrusted()` wrapper): `progress: { summary, objective: { state }, criteria: [{ id, text, state, verification, evidence, reason }], readiness: { ready, items: [{ id, state, by, fix, refs }] }, abandoned: { count, newest: [{ id, approach, why }] } }` |
| `get_orientation` | the text now holds the `Progress` and `Abandoned approaches` sections |

Answers:

- `close-proposal` and `check-approve` are pressed: `answer_question` refuses them on every channel, the
  chat's own (`in-app-chat`) included, with the existing pressed message; the card's buttons
  (`case:answerQuestion`) or the phone answer them.
- `scope-confirm` **[depends on Q-b]**: when spoken, `answer_question` takes it under `cases:answer` (the
  front door), over `mcp-stdio`, and in King Louie's chat (where the quote is checked against the owner's
  message). When pressed, it is refused like the other two.
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
  which the runtime sends after a confirmation, a verify pass and a close). The close card disables "Mark
  done" with the reason when the live list refuses it **[depends on Q-a]**.
- Buttons act through the IPC of §8.1; a second click while one is in flight is ignored.

### 8.4 The phone

A pressed question reaches the paired phone as it does today (`kl.question.ask`, the text and options).
The close proposal's host-built text carries the summary and the open items, so the phone shows the list
with no app change. No new message type; `tests/vectors/approval-v1` is untouched.

## 9. Configuration

`settings.cases` (`src/cases/defaults.js`), merged key by key like the rest:

```js
verify: {
  when: 'changed-turn',          // 'changed-turn' | 'request' | 'off'   [Q-d]
  timeoutMs: 20000,
  maxInputChars: 12000,
  maxPassesPerDay: 24,
  skipAboveUsdPercent: 80,
  toolResults: 'case-tools'      // 'case-tools' | 'all' | 'none'        [Q-i]
},
softwareRepo: {
  refreshBudgetMs: 6000,         // existing
  check: { enabled: false, timeoutMs: 120000, envAllow: [] }            // [Q-c]
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
  `systemAction` of a panel action) writes the file with `migratedAt`. `legacy` entries are `proposed` or
  `confirmed` by Q-f.
- **`done` and `abandoned` cases** are never opened for writing, so they never get the files. Their
  panel shows the brief as today and one line: `Closed before progress was tracked.`
- **Gating.** `gating.complete: true` is never cleared, whatever Q-b's answer; the new rule applies to
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
| A spoken scope answer over MCP | A client with `cases:answer` confirms scope | The existing trust in that scope (quotes are recorded, not checked, off the app); the options are only "all" and "none" of exactly the hashed entries; closing stays pressed. Q-b option 1 removes it |
| `met` | The model declares success | No tool sets a state. A record is written only by code after a second model's verdict whose every id code resolved; the state is recomputed on each read |
| The verify pass reads model-written facts | A `sourced` fact with an invented source is cited | Not prevented: `sourced` is model-declared (parent, stage 1). The row shows each evidence fact's provenance and source; an ingest-verified source is labelled as such; the owner sees the evidence on the close card |
| The verify prompt carries case text | Injection steers the verdict | A verdict can only name ids; a `met` that code cannot resolve is an opinion. The worst a steered pass does is mark a met criterion `stale` |
| Tool results in the verify input **[Q-i]** | Third-party text argues for `met` | Option 1 sends case-tool results only; any option frames them as not evidence, and evidence must be a fact id |
| The close proposal | The model closes the case | It cannot: `done` is applied only from a press on `in-app` or `mobile`, by `setStatus` with `by: 'owner'`; `TRANSITIONS` gains no `runtime` row into `done` |
| The close card's text | Model text dressed as the list | Host lines first (summary, items, ids), the model's one-line note last and labelled; never cut; refused over 2,000 characters |
| Abandoned records | Another case reads them; they leak outbound | Never indexed across cases; no outbound reference syntax; shown only where private facts already are |
| The check command **[Q-c]** | Code runs on the owner's machine | Off by default; owner-named with an exact quote or typed in the panel; approved once on a pressed card that shows the argv; no shell; a narrow token alphabet; owner turns only; scrubbed environment; time limit; tree kill; output never committed or shown to a model or a remote client; admin-only in service mode |
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
| `NOT_READY` **[Q-a]** | `Progress.proposeDone`; `case:setStatus` and the close answer under option 4 | The rule for proposing or closing is not satisfied; lists the open items |
| `CLOSE_PROPOSAL_OPEN` | `Progress.proposeDone` | One is already open (names it) |
| `CLOSE_DECLINED_UNCHANGED` | `Progress.proposeDone` | The owner said keep working and the list has not changed |
| `QUESTION_TOO_LONG` | `Progress.askScope`, `Progress.proposeDone` | The host-built card would pass 2,000 characters (existing code, new callers) |
| `CHECK_INVALID` **[Q-c]** | `Brief`, `case:setCheck` | The command fails `validateCheck`; says which rule |
| `CHECK_NOT_IN_QUOTE` | `Brief` | The whole command is not in the owner's message |
| `CHECK_NO_LOCAL_REPO` | `Brief`, `case:setCheck`, the run | `repo` is a clone URL or a path that is not there |
| `CHECK_DISABLED` | `case:setCheck`, the run | `cases.softwareRepo.check.enabled` is false |
| `CHECK_SERVICE_OFF` | the same, in service mode | The admin file does not enable it |
| `CHECK_NOT_APPROVED` | the run | No approval matches the command and repository |
| `CHECK_BUSY` | the run | Another check is running in that repository |

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
| The verify call times out, errors, or replies with the wrong shape | No state changes; usage that was reported is still charged | `Verify pass: no usable verdict (…)` in the journal |
| The reply names a criterion twice or an unknown id | The whole reply is dropped | The same |
| The `usd` budget reaches 100 % during the pass | `usageHook` pauses the case through `onCrossings` as for any call; the verdicts already parsed are applied | The existing budget pause |
| The owner presses Stop | The turn's abort signal ends the check and the pass; the stopped exit passes no `verify` | Nothing new |
| Shutdown during a close | `abortUnattended` and the turn signal abort both; the check's process tree is killed and awaited | Nothing new |
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
  reads unchanged byte for byte until the first locked write, then gets `legacy` entries (both Q-f
  answers, by setting); a `done` case never gets the file.
- **`tests/cases-tools.test.js` (extended):** `Brief` append without a quote is `proposed`; with a quote
  in `ownerMessages` and the text in the quote, `confirmed`; a quote that is in the messages but does not
  contain the text refuses `SCOPE_NOT_IN_QUOTE`; `provenance: "user"` with no quote refuses (it passed
  before); a list `update` that drops a confirmed entry refuses and one that drops a proposed entry works;
  `objective` rules; limits. Tests supply `ownerMessages`.
- **`tests/cases-brief.test.js` (extended):** `missingForGating` under each Q-b option; a brief already
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
- **`tests/cases-progress-tool.test.js`:** each action in each status; `proposeDone` refusals under each
  Q-a option; the decline memory; the close answer applies from `in-app` and `mobile` and from nothing
  else (`in-app-chat`, `mcp-stdio`, `mcp-frontdoor`, a contact channel); `setStatus` is called with `by:
  'owner'`; `askScope` confirms only entries whose hash matches; a free-text answer confirms nothing; the
  card text is host lines first and refuses over 2,000 characters. Tests begin a turn before calling
  actions that need one.
- **`tests/cases-runtime.test.js`, `tests/cases-triggers.test.js` (extended):** marks at `beginTurn`; the
  verification hook raises `criterion-regressed` once and `Reorient` acknowledges it; the journal block is
  first in the entry; `freezeProgress` at `done` (Q-g).
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
  `answer_question` refuses `close-proposal` and `check-approve` on every channel, and treats
  `scope-confirm` by Q-b. Through `tests/helpers/stdio-mcp-client.js` and
  `tests/helpers/frontdoor-harness.js` for the two remote surfaces.
- **`tests/cases-check.test.js` [Q-c]:** `validateCheck` accept and refuse tables; `checkInQuote` (whole
  command, exact case, never assembled from tokens); approval binds to the argv and the repository;
  refused when off, unapproved, in a wake-up turn, in service mode without the admin key, for a clone URL;
  the environment the child sees (a fixture script that prints the names of its variables: no provider
  key, no other `KL_*`, no `ELECTRON_RUN_AS_NODE`); the time limit kills a child and its grandchild; Stop
  kills it; the output tail is under `.kl/runs/` and in no tracked file; pass to fail writes the journal
  line first. The child is a `node` fixture script in a temp git repository; on Windows a `.cmd` fixture
  covers the `cmd.exe` path. The file awaits every child, so nothing holds the loop open.
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
| The owner hand-edits `brief.md` | scope "file edit is proposed" (Q-h) |

## 15. Build order

Each task ends with its own tests green; the full suite runs once at the end of the stage.

1. **`ScopeStore` and `.kl/scope.json`:** ids, hashes, `view`, `reconcile`, `confirm`, `drop`, the
   migration read.
2. **`Brief` tool scope rules:** quote and word rules for criteria and the objective; confirmed entries
   refuse; limits; journal wording.
3. **Runtime wiring for scope:** `reconcile` in `beginTurn`; `createCase`'s `objectiveBy`; the detour
   router and playbook gating origins; gating by Q-b.
4. **Abandoned approaches:** the store, the cross-case exclusion, the leak test.
5. **Verification store and pure state computation:** records, resolvers for `f-`, the summary line.
6. **Ready to close:** `closeReadiness` with every item, the fingerprint.
7. **Turn marks and `collectTurnEvidence`:** the marks, the evidence registry and its seam, `endTurn`'s
   new fields, the two callers.
8. **The verify pass:** prompt, strict parse, `acceptVerdict`, charging, skips, the journal block.
9. **The verification hook and trigger:** `criterion-regressed`, `Since last turn`, the cache, freezing at
   close (Q-g).
10. **The `Progress` tool:** five actions, status ops, `scope-confirm` and `close-proposal` with their
    handlers, `PRESSED_TYPES`, the prompt lines.
11. **Orientation:** the two sections and their caps.
12. **IPC and the panel:** `case:progress`, `case:confirmScope`, the Progress block, the two cards, the
    Done dialog.
13. **MCP:** `open_case`, `list_cases`, `get_orientation`; the pressed refusals; the front-door and stdio
    tests.
14. **The check command, part 1 [Q-c]:** the `check` field, `validateCheck`, the quote rule,
    `check-approve`, `.kl/checks.json`, the settings and the admin key. Nothing runs yet.
15. **The check command, part 2 [Q-c]:** `runCheck`, the close run, `chk-` evidence, `failing`, pass to
    fail, the Windows path.
16. **Regression fixture, e2e, `CLAUDE.md` section, full suite.**

Tasks 1 to 13 and 16 are the stage without the check. Tasks 14 and 15 are dropped if Q-c defers it.

## 16. Deviations from the parent

1. **§4.3** shows `successCriteria` as plain strings the owner or the model wrote. Stage 8 keeps the
   shape and adds authorship beside it; a proposed criterion no longer satisfies anything.
2. **§5.5** closes a turn by rendering, journaling and committing. Stage 8 adds a model call (the verify
   pass) and, behind Q-c, a host-run command to the close.
3. **§5.6** has seven case tools and the code has twelve; `Progress` is the thirteenth.
4. **§9.2** gives `verify` to "ledger consistency review; second reading of blocked outbound spans".
   Stage 8 adds the criteria pass to that role.
5. **Stage 2 §3.1** has no runtime path to `done`. That stands: the model's proposal is a question, and
   the transition is still the owner's.
6. **Stage 5 §3.7** says `refresh` runs read-only commands with 5 s timeouts. Behind Q-c, the case type
   also runs one owner-named command, not read-only, with a longer limit, at close only.

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
- **The check command runs the repository's code** with the account's access, and the model can change
  that code in an owner turn. Read-only and offline are not enforced and cannot be. The token rules stop
  shell tricks, not a hostile `package.json`. An approval covers words whose meaning can change.
- **Environment scrubbing is partial.** A program can read files in the home directory (tokens, keys)
  whatever its environment holds.
- **On Windows the `.cmd` path goes through `cmd.exe`.** The token alphabet is the only thing between a
  token and `cmd.exe`'s parser.
- **A spoken scope answer off the app is unchecked** (Q-b options 2 and 3): over MCP the quote is
  recorded, not verified, as for every spoken answer.
- **Abandoned records are free text.** The outbound gate does not know them; a model that restates one in
  an outbound payload is stopped only if the text also trips rules 1 to 4 for other reasons.
- **A hand edit by the owner looks like a `Bash` write** (Q-h), so the owner's own edit to `brief.md`
  needs a press to count.
- **`branch-merged` does not know which PRs are the case's.** A PR the case opened from another branch is
  not counted.
- **A check passing on a dirty tree proves nothing that is recorded.** The case must commit to get check
  evidence; work that is never committed can never be `met` by a check.
- **An older version that opens a newer case** lets the model rewrite the criteria list unmarked; the
  newer version shows the result as `proposed`, so nothing is trusted, but the owner's confirmations of
  reworded entries are lost.
- **Imported cases are not re-checked,** as with `facts.jsonl`.
- **The verify pass's cost is estimated, not measured.**

## 19. Deferred

| Item | Stage |
|---|---|
| Structured child hand-off as an evidence source and id resolver (§6.10) | the next cases stage |
| Refusing or flagging a `Plan` step that repeats an abandoned approach | unassigned |
| Recording which PRs and branches a `software-repo` case created | unassigned; would make "PRs merged" exact |
| A way out of `done` | unassigned; Q-g |
| Checks for other case types; more than one check per case | unassigned |
| Running the check in a sandbox or container | unassigned; the only real answer to §18's fourth item |
| Per-criterion confirmation from the phone or by spoken answer | unassigned; the panel does it today |
| Measuring the verify pass (cost per turn, false `met` rate) on real cases | after the stage ships |

## 20. Dependencies (npm)

None. Hashing is `node:crypto`; the check uses `node:child_process`; YAML and JSON readers are the ones
the stores already use.
