# Cases Stage 2: Unattended cases — Design Spec

- **Status:** Draft (fix round 1)
- **Date:** 2026-09-23
- **Parent:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` §4.5, §5.3–5.6, §8.3, §9, §12 row 2, §13, §14
- **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. Owns §4.1 status machine, §4.2 journal kinds, §4.3 question records, §4.4 budgets, §4.5 model roles, §4.6 wake-ups. Reads §4.7 (executor snapshot). Rulings 1 and 6. §5: sole editor of the case-turn block of `src/ipc/chat-handlers.js`; settings namespace `cases.*`.
- **Depends on:** C1 (merged, PR #30)

## 1. Outcome

A case keeps working while the owner is away. The cron engine wakes it on a schedule.
A cheap `orient` model call checks whether anything changed. If something did, the
case escalates to the `judge` role and acts, confined to the case tools and three
read-only file tools, within its budget. The case notices when its own ground has
shifted: a time gap since the owner last spoke, a corrected fact under a decision, an
executor change, or a budget threshold. It then re-orients before it recommends
anything. It asks the owner questions and sends briefings through question records.
The owner answers them in the desktop app, and each answer becomes a host-verified
`user` fact. A dead end produces one failure report with at most one recommendation,
and the case stops in `needs-direction`. Spending past the budget pauses the case
until the owner grants more; the model itself can never raise a limit. The owner can
pause, resume, finish or abandon a case from the case panel.

## 2. Scope

### 2.1 In

- Status machine, transitions, per-status tool allowlists (`setStatus`, `assertWritable`).
- Re-orientation triggers and the `Reorient` tool. Executor, mid-plan and playbook triggers are inert until C3/C6.
- Turn-start hooks for later stages.
- `Fail` tool, failure reports, `needs-direction`, the `case.yaml.autonomy` grant check.
- Wake-ups: `.kl/wakeups.json`, the `cases:wakeups` cron system job, the confined headless wake-up turn.
- Budgets: `.kl/budget.json`, per-case LLM usage roll-up, 50/80/100 % behaviour, owner-only grants.
- Model roles, including fixes for the two defects in parent §9.2.
- Question records with typed answer handlers, the `Ask` tool, in-app delivery, answering and acknowledging over IPC. `AskUser` is removed from case mode.
- Journal kinds `reorient`, `failure`, `wakeup`, `question`.
- Renderer: status controls, budget line, questions list, and a questions bar.

### 2.2 Out

| Item | Owner |
|---|---|
| Presence, ladder, batching, non-UI channels, delivery-side `recordDelivery` extensions | C4 |
| `Plan`/`Executor` tools, `.kl/executors.json`, `.kl/plan.json`, `poll-executor`, `contactsPerDay` charging, envelopes, outbound gate (and with it `WebFetch`/`WebSearch` on wake-ups) | C3 |
| Material fields per case type; owner-message classification (through the turn-start hook) | C5 |
| Playbook files, `playbookChanges`/`acknowledgePlaybooks`, playbook safe defaults, `Playbook.*` ops | C6 |
| Answering over MCP (`payload.mcpAnswerable`) | C7 |

### 2.3 Constraints

Program §3 applies verbatim. The ones this stage touches most: Electron-free `src/`
outside `src/ipc/`; no new native dependencies; `node --test` only; `createLogger`
only; tool results are `{ ok, … }`; gate refusals are results, not throws;
`facts.jsonl` is written only by `FactLedger`.

## 3. Design

### 3.1 Status machine — `src/cases/status.js`

Pure module. It exports `TRANSITIONS`, `ALLOWED`, `DENIED`, `canTransition(from, to, by)`
and `check(status, op, { autonomyAllows }) → null | { ok: false, error }`.

| From | To | `by` | `statusReason.kind` |
|---|---|---|---|
| `draft` | `active` | runtime | `gating` |
| `draft` | `abandoned` | owner | `owner` |
| `active` | `needs-direction` | runtime | `failure` |
| `active`, `needs-direction` | `paused` | runtime | `budget` (a 100 % crossing on `usd`/`deadline`) |
| `active` | `paused` | runtime | `commit` (two consecutive commit failures) |
| `active` | `paused` | owner | `owner` |
| `needs-direction` | `active` | runtime, owner | `direction` |
| `paused` | `active` | runtime, owner | `budget-grant` (only from `budget`), `owner` (IPC resume) |
| `active`, `needs-direction`, `paused` | `done`, `abandoned` | owner | `owner` |

**Invariant.** Every transition *to* `active` is refused with `BUDGET_EXHAUSTED`
(`Raise the <category> budget first.`) while `usd` or `deadline` is at 100 %. This
applies to `completeGating`, direction, owner resume and grants alike, so a
direction answer can never resume an over-budget case.

`setStatus(id, status, { kind, by = 'runtime', ref = null, note = '', failureClass = null })
→ meta`. It throws `StatusError` with code `BAD_TRANSITION` or `BUDGET_EXHAUSTED`.

| Caller | Call |
|---|---|
| `completeGating` (C1, edited) | `setStatus(id,'active',{ kind:'gating' })` |
| `Fail` | `setStatus(id,'needs-direction',{ kind:'failure', ref: journalPath, failureClass })` |
| `onCrossings` 100 % | `setStatus(id,'paused',{ kind:'budget', ref: category })` when the case is `active` or `needs-direction`. When it is already `paused`, the status is kept and the question is still created. For `draft`, `done` and `abandoned`, only the question is created (not for `done`/`abandoned`) |
| commit failure ×2 | `setStatus(id,'paused',{ kind:'commit', note: err.message })` |
| direction fact | `setStatus(id,'active',{ kind:'direction', ref: factId })` |
| grant | `setStatus(id,'active',{ kind:'budget-grant', ref: factId })` |
| IPC `case:setStatus` | `{ kind:'owner', by:'owner', note }` |

Effects of `setStatus`:

- Writes `status` and `statusReason: { kind, by, ref, note, failureClass, at }` to `case.yaml`.
- Emits `case:changed { what:'status' }`.
- On `paused`, `done` or `abandoned`: aborts a running unattended turn, and calls `host.getExecutorRegistry?.()?.cancelOpenJobs?.(caseId, reason)` when a registry is present (C3); errors are logged.
- On `done` or `abandoned`: `WakeupStore.cancelAll()`.
- On `active`: `ensureDefaultWakeups(id)`.

**Per-status rules.** Statuses with narrow permissions use an allowlist; the others
use a denylist. Op names: `Ledger.<action>`, `Brief.<action>`, `Decide`, `Recommend`,
`Reorient`, `Fail`, `Ask`, and for later stages `Plan`, `Executor.submit`,
`Playbook.list`, `Playbook.read`, `Playbook.propose`.

| Status | Rule | Error text |
|---|---|---|
| `draft` | deny `Recommend`, `Plan`, `Executor.submit`, `Fail` | `Case is a draft: finish the gating pass (Brief completeGating) first.` |
| `active` | allow all | — |
| `needs-direction` | deny `Plan`, `Recommend`, `Fail`; deny `Executor.submit` unless `autonomyAllows` | `Case is waiting for the owner's direction on <ref>. Report status or ask; do not plan or recommend.` |
| `paused` | allow only `Ledger.query`, `Brief.read`, `Playbook.list`, `Playbook.read` | `Case is paused (<kind>). Only reading is available.` |
| `done` | allow only `Ledger.query`, `Brief.read`, `Playbook.list`, `Playbook.read`, `Playbook.propose` | `Case is done. It is read-only.` |
| `abandoned` | allow only `Ledger.query`, `Brief.read`, `Playbook.list`, `Playbook.read` | `Case is abandoned. It is read-only.` |

`CaseRuntime` gains the following. Both check methods return `null` when the op may
proceed:

```js
setStatus(id, status, opts) → meta
assertWritable(id, op) → null | { ok: false, error }     // reads case.yaml fresh each call
requireReoriented(id)   → null | { ok: false, error }     // refuses when no turn is registered
autonomyAllows(id, action) → boolean
systemAction(id, label, fn) → Promise<result>            // public; §3.10
addTurnStartHook(name, fn, { phase? })                                      // §3.3
```

`autonomyAllows(id, action)`: when the status is `needs-direction`, it returns
`case.yaml.autonomy[AUTONOMY_KEY[statusReason.failureClass]] === action`.
`AUTONOMY_KEY = { 'executor-no-answer':'onExecutorNoAnswer', 'dead-end':'onDeadEnd',
'blocked':'onBlocked', 'other':'onOther' }`. The only action defined here is
`retry-within-envelope`, which C3 checks. A missing key means `stop`.

### 3.2 Enforcement in the tools and the executor

**Case tools** (`src/tools/builtin/case-tools.js`). `withCase(options, op, fn)` takes
`op` as a string or a function of `params`. It returns
`ctx.runtime.assertWritable(ctx.caseId, op)` when that returns non-null. `Decide`,
`Recommend` and `Fail` also return `requireReoriented` when it returns non-null. The
Ledger tool refuses `source.kind` outside `SOURCE_KINDS` with `Source kind "<k>" is
reserved for the host.` The host-only kinds are `user-message`, `question` and
`owner-action`.

**Owner-only brief fields.** `USER_ONLY_FIELDS` becomes `why`, `hardConstraints`,
`alreadyTried`, `materiality`, `deadline`, `safeDefaults`. Each needs a verified owner
quote, so a wake-up (with `ownerMessages: []`) can never write them. `safeDefaults`
is a new `BRIEF_FIELDS` array field: option ids or labels the owner declared safe to
apply on silence (§3.9).

**Stale direction quotes.** For a Ledger `assert` with `provenance:'user'` and
`subject:'direction'`, the matched `messageIndex` must be the last element of
`ownerMessages` (this turn's message), or its `ownerMessageTimes[messageIndex]` must
be later than `statusReason.at`. Otherwise the call is refused with `Direction must
come from something the owner said after the failure report.`
`caseContext.ownerMessageTimes` is new: each owner message's `timestamp`, in step with
`ownerMessages`, with the current message as `now`.

**Executor confinement** (`src/execution/tool-executor.js`). `ToolExecutor` gains
`allowedToolNames` (a `Set` or `null`), passed in `executorOptions.allowedToolNames`
through `createToolExecutorWithApprovals`. The case guard runs step 3 of the pipeline,
before approval. When the set is non-null and the name is not in it, the executor
returns `{ success: false, error: 'Tool "<name>" is not available in this turn.' }`.
Wake-ups pass `new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS])`. Owner case turns
pass `null`.

**Blocked in every case turn.** `CASE_BLOCKED_TOOL_NAMES` becomes: `SpawnAgent`,
`BackgroundTask`, `sessions_spawn`, `RemoteDispatch`, `Cron`, `message`,
`sessions_list`, `sessions_history`, `RequestTools`, `ToolSearch`, `Canvas`. Among
these, `message` sends text into a gateway session that has no `caseContext`;
`RequestTools` and `ToolSearch` inject tools; the `sessions_*` tools read other
sessions. `shapeToolDefinitions` strips them all, and the executor's existing
`CASE_BLOCKED_TOOL_NAMES` check refuses them.

### 3.3 Re-orientation triggers — `src/cases/triggers.js`

Pure: `detectTriggers(input) → Trigger[]`, where
`Trigger = { kind, key, detail, blocking: true, decisionIds? }`.

Input: `{ source, now, meta, facts, decisions, budget, executors, plan,
playbookChanges, hookTriggers, baseline, reorientAfterHours }`.

| Kind | Detected how | Inert until |
|---|---|---|
| `time-gap` | Owner turns only: `now − meta.lastOwnerTurnAt > reorientAfterHours·3600 s`. Not raised when the value is absent or in the future (logged). Wake-ups never raise it; the orient step decides for them | — |
| `decision-undermined` | Key `D:f`, for a decision `D` citing fact `f` whose status is not `active`, when the key is not in `baseline.undermined` | — |
| `executor-change` | `.kl/executors.json`: a non-stale entry already in `baseline.executorsMaterial` whose `material` is not deep-equal to the baseline. New ids join the baseline silently | C3 |
| `budget-threshold` | Some category's `crossed` holds 80 or 100 not in `baseline.budgetCrossed[category]` | — |
| `message-mid-plan` | `source === 'owner'` and a `.kl/plan.json` step has `state: 'in-flight'`. Never baselined | C3 |
| `playbook-update` | One per entry of `playbookChanges` (`[{ name, from, to }]`), obtained from `runtime.playbookChanges?.(id) ?? []` | C6 adds the method |
| hook triggers | Triggers returned by turn-start hooks whose `key` is not in `baseline.acknowledgedKeys` | C3, C5 |

**Turn-start hooks.** `CaseRuntime.addTurnStartHook(name, fn, { phase: 'turn-start' | 'owner-message' = 'turn-start' })` registers
`fn({ runtime, caseId, dir, meta, turnId, source, ownerMessage, now })
→ Promise<{ notes?: string[], triggers?: Trigger[] } | void>`. `beginTurn` awaits
every hook in registration order, after the owner-edits commit and before
`detectTriggers`. Notes go into the orientation section `## Since last turn`. A hook
that throws is logged, and the note `Turn-start hook <fn.name> failed: <message>` is
added. The turn continues.

**Baseline** `.kl/triggers.json` (§4.6). A successful `Reorient` writes the current
undermined keys, executor material, budget crossings and hook-trigger keys, and calls
`runtime.acknowledgePlaybooks?.(id)`. The `endTurn` of a turn with no pending blocking
trigger refreshes the executor material and `budgetCrossed`. An unacknowledged trigger
therefore fires again on the next turn. `budgetCrossed[c]` is pruned to the current
`crossed[c]` whenever `reconcile` or a day rollover removes a threshold. After a grant
or a new day, 80 % can fire again.

**`lastOwnerTurnAt`.** An owner turn's `endTurn` advances it, unless a `time-gap`
trigger was pending and `Reorient` did not run. Wake-ups never touch it.
`lastTurnAt` (all turns) is informational only.

**Orientation** gains a first section `## Re-orientation required` listing each
trigger's `detail`, then `Call Reorient before Recommend, Decide or Fail.`

**`Reorient` tool** (`src/tools/builtin/case-unattended-tools.js`, op `Reorient`):

| Param | Type | Rules |
|---|---|---|
| `changed` | string | required |
| `affects` | string[] | existing decision ids. Must include every `decisionIds` of a pending `decision-undermined` trigger |
| `action` | `continue`\|`adjust`\|`ask` | required |
| `note` | string | required. With a pending `budget-threshold` trigger it must be at least 40 characters, and the prompt asks it to say what is left and whether finishing is worth it |

It is refused with `No re-orientation is pending in this turn.` when nothing is
pending. On success it writes a `reorient` journal entry, clears
`turn.reorientPending`, writes the baseline, and returns
`{ ok: true, journal, next }`.

### 3.4 Owner facts and failure reports

`CaseRuntime.applyOwnerFact(id, fact)` runs after every successful `user` fact:

| Fact | Required source kind | Effect |
|---|---|---|
| `subject:'direction'`, status `needs-direction` | any `user` source (quote-checked per §3.2 when it is `user-message`) | `setStatus(active, { kind:'direction' })`. On `BUDGET_EXHAUSTED` the case goes to `paused` (`budget`), and the refusal is added as a note to the direction question |
| `subject:'budget'`, `attr` ∈ categories | **`question` or `owner-action` only** | `case.yaml.budget[attr] = value`, `grantedBy = fact.id`, `reconcile()`. Then `setStatus(active, { kind:'budget-grant' })` if `statusReason.kind === 'budget'` and nothing is at 100 % |

A budget fact written through the Ledger tool (source `user-message`) is recorded but
changes no limit. The tool result says so: `Budget limits change only through the
owner's answer or the Grant button.` A quote proves the owner said the words; it does
not prove they said this limit.

**`Fail` tool** (op `Fail`; calls `requireReoriented`):

| Param | Type | Rules |
|---|---|---|
| `failureClass` | `executor-no-answer`\|`dead-end`\|`blocked`\|`other` | required |
| `what` | string | required |
| `tried` | string[] | at least 1 |
| `why` | string | required |
| `unknowns` | string[] | fact ids |
| `recommendation` | `{ claims: [{ text, factIds[] }] }` | optional, **one**. It must pass `recommendationGate`, or the whole call is refused with `failures` |

On success, in order:

1. Write the `failure` journal entry and record any recommendation with `failure: <path>`.
2. `setStatus(needs-direction)`.
3. Create a question: `kind: question`, urgency `high`, `payload: { type:'direction', failure: path, about: { subject:'direction', attr: <basename> }, mcpAnswerable: false }`.
4. Return `{ ok: true, rendered, instruction: 'Present this as written and stop. Do not start another approach.' }`.

**Commit failures** (parent §14). `endTurn` and `systemAction` count consecutive
`git.commitAll` failures in `.kl/triggers.json` (`commitFailures`); a success resets
the count. At 2, the case moves to `paused` (`commit`), and a question is created:
urgency `high`, `payload: { type: 'commit-failed', mcpAnswerable: false }`, text
`<title>: the case repository could not be committed twice (<error>). Fix the
repository, then resume.` The runtime never force-writes. Resume goes through
`case:setStatus`.

### 3.5 Budgets — `src/cases/budget.js`

`new Budget(dir, { defaults, overrides, createdAt, now = () => new Date(), timeZone })`.
The limit for a category is `overrides[c] ?? defaults[c] ?? null`. `null` or `0` means
unlimited: spend is tracked but no thresholds fire.

| Method | Behaviour |
|---|---|
| `charge(category, amount, meta)` | Per-day categories roll over when `localDay(now) > entry.day` (string compare, never backwards); a rollover empties `crossed`. For `usd`, adds `meta.unpricedTokens` to `usd.unpricedTokens`. `deadline`: `amount = 0`. The ratio is `(now − createdAt)/(end of deadline day − createdAt)`, computed and never stored; a deadline on or before `createdAt` counts as 100 %. Returns `{ spent, limit, crossedNow }` for newly reached thresholds in `[50, 80, 100]` |
| `reconcile()` | Recomputes limits. Drops thresholds the ratio no longer reaches and returns `{ [c]: crossedNow[] }` for newly reached ones |
| `status()` | File contents with limits and the current ratios filled in |
| `remaining(category)` | `limit − spent`, or `null` |
| `exhausted()` | `['usd','deadline']` filtered to those at 100 % |

The file is written only when a value changes (temp file, then rename). Since the
ratio is not stored, a quiet sweep produces a clean tree and `commitAll` does nothing.

**Usage attribution.** `UsageTracker` stays case-blind. `AgentLoop` calls
`onUsageRecorded(usageEvent)` **only when a `usageTracker` is passed**, so every case
loop (owner and wake-up) passes `usageTracker: host.getUsageTracker()` together with
`onUsageRecorded: runtime.usageHook(turn)`. The hook runs
`charge('usd', ev.cost, { turnId, provider, model, unpricedTokens: ev.cost === 0 ? ev.totalTokens : 0 })`
and then `onCrossings`. The one-shot orient call records through `usageTracker.record`
and calls the same hook.

**Unpriced usage.** When `usd.unpricedTokens > 0`, the orientation's budget section
and the panel's budget line both show: `<n> tokens on providers with no price table
are not counted against the $ budget.`

**`onCrossings(id, category, crossedNow)`:**

| Threshold | `usd`, `deadline` | per-day categories |
|---|---|---|
| 50 | Orientation line | same |
| 80 | `budget-threshold` trigger | same |
| 100 | Pause per §3.1, abort a running unattended turn, and create a question (below) | The category's action is refused until the local day rolls over. One `low` briefing per day (`payload.type:'budget-daily'`) |

The budget question has `kind: question`, urgency `normal` and
`payload: { type:'budget-grant', budget: category, spent, limit, mcpAnswerable: false }`,
with text `<title> spent <spent> of its <limit> <category> budget and is paused. Reply
with a new limit to continue.` It is deduplicated while open.

**Per-day rules.** `turnsPerDay` is charged in `beginTurn` for every turn. A wake-up is
refused before charging when `spent ≥ limit`, so the limit counts owner turns and
wake-ups together. Owner turns are never refused. `questionsPerDay` is charged by
`Ask` only when it creates a `kind: question` record. Questions and briefings created
by the runtime (`direction`, `budget-grant`, `budget-daily`, `commit-failed`,
`wakeups-failing`) are neither charged nor refused. C4 does not charge again at
delivery.

### 3.6 Wake-ups — `src/cases/wakeups.js`

`new WakeupStore(dir, { now, timeZone })` over `.kl/wakeups.json`:

| Method | Behaviour |
|---|---|
| `register({ kind, at \| every, payload, createdBy })` → id | `at`: RFC3339. `every`: **milliseconds**, an integer ≥ 60000. Ids are `w-` plus a 4-digit counter. `ensure(kind, spec)` returns the existing id when `kind` and `payload.key` match |
| `list()`, `cancel(id)`, `cancelAll()` | — |
| `due(now)` | Entries with `nextAt ≤ now` |
| `markRan(id, { outcome, error, now })` | `quiet`/`acted`: `attempts = 0`. For `every`: `nextAt = now + everyMs`; `daily-orientation` recomputes the next `dailyAt` in `timeZone` (no drift, DST-safe). `at`: removed. `skipped`: same as `quiet`, but `at` entries are kept and moved to `now + everyMs`, or to the next local midnight for `at`. `failed`: `attempts += 1`, `nextAt = now + backoff[min(attempts,3) − 1]` |
| `reanchor(now)` | An `every` entry with `nextAt − now > 2·everyMs` moves to `now + everyMs`, or to the next `dailyAt` |

Writes happen only on change. Kinds: `daily-orientation`, `deadline-check`, `retry`,
`poll-executor` (C3), and later `<module>:<kind>`. `ensureDefaultWakeups(id)`
registers `daily-orientation` (`every: 86400000`, anchored to
`settings.cases.wakeups.dailyAt`), plus `deadline-check` (`every: 86400000`) when a
deadline exists. After an answer, `answerQuestion` registers a `retry` wake-up with
`at: now` and `payload: { key: 'answered:<qid>', questionId }`.

**The system job.** `src/cron/cron-executor.js` gains
`registerSystemJob(name, handler)`. `execute(job)` checks `job.payload.system` before
the `message` check:

- A handler result is returned as `{ ok: true, ...result }`.
- A throw returns `{ ok: false, error }`.
- An unknown name returns `{ ok: false, error: 'No handler for system job <name>' }`.

`CronScheduler.runNow` counts `!result.ok` as an error, and the five-error auto-disable
skips `system: true` jobs. `updateJob`/`removeJob` throw `"<id>" is a system job
managed by King Louie.` for system jobs. `addJob` deletes `system` from the job it is
given, so the Cron tool and IPC cannot create one.

```js
async function ensureWakeupJob(cronStore) // idempotent; writes through the store, not addJob
// missing → add { id:'cases:wakeups', system:true, enabled:true,
//   schedule:{ kind:'every', everyMs:60000 }, payload:{ system:'cases:wakeups' } }
// present → reset schedule/payload/system, enabled:true, state.consecutiveErrors:0
```

In `createCore().start()`, after the `CronScheduler` is constructed and before
`cronScheduler.start()`:
`cronExecutor.registerSystemJob('cases:wakeups', () => caseRuntime.runDueWakeups(caseRuntime.now()))`
and `await ensureWakeupJob(cronStore)`. Both hosts run through this code, and each
data dir has its own `cron/jobs.json`.

**`CaseRuntime.runDueWakeups(now)`** → `{ ran, quiet, skipped, busy, failed }`. It
never throws for a single case:

1. If wake-ups are disabled or no host is attached, return zeros.
2. For each case, **skip it if `this.turns` holds a turn for it** (an owner is mid-turn in this process). Otherwise run `systemAction('sweep')`: `reanchor`, `QuestionStore.expire(now)`, `charge('deadline', 0)`, `reconcile()`, `onCrossings`. If another process holds the lock, count it as `busy` and skip.
3. By status: `done`/`abandoned` → `cancelAll`. `draft`/`paused` → skip. `needs-direction` → only `poll-executor` and `deadline-check`. `poll-executor` wake-ups call `registry.pollWakeup(caseId, wakeup)` with no model (C3); a turn is registered only when it reports a material change (R48).
4. `deadline-check` needs no model. It is marked `quiet`, or becomes part of a turn when step 2 produced a new 80 % or 100 % crossing.
5. The remaining due wake-ups of a case are coalesced into one turn (§3.7). At most `maxCasesPerTick` cases run per tick, one at a time.
6. `CaseBusyError` from `beginTurn`: nothing is written, and the wake-up stays due.

### 3.7 The wake-up turn — `src/cases/turn-runner.js`

What both paths share lives on `CaseRuntime`: `beginTurn`, `caseContext`,
`routedProvider`, `usageHook` and `endTurn`. The owner path keeps its UI loop in
`chat-handlers.js`. `turn-runner.js` exports `runWakeupTurn(runtime, caseId, dueIds,
now)`:

1. `turn = await runtime.beginTurn(id, { turnId: 'wakeup-<ts>-<rand>', source: 'wakeup' })`.
2. Re-read `WakeupStore.due(now)` inside the lock, keeping `dueIds` that are still due. A second process may have run them; if none remain, close quietly without a journal entry.
3. If `turnsPerDay` is spent: `markRan(skipped)`, write a `wakeup` entry `skipped: daily turn budget spent`, and close.
4. If there is a blocking trigger, or any due wake-up is a `retry` with `payload.questionId`: go to step 6.
5. **Orient.** `runtime.routedProvider(turn, { role:'orient' }).sendMessage(...)` with `ORIENT_PROMPT`, the orientation and the due wake-ups. It must return JSON `{ changed, why }`.
   - `changed: false` → one-line `wakeup` entry, `markRan(quiet)`, close.
   - Unparseable output → escalate.
   - Provider failure after fallback → step 8.
6. **Act.** Run `new AgentLoop(routedProvider({ role:'judge' }), executor, { maxIterations, usageTracker: host.getUsageTracker(), onUsageRecorded: runtime.usageHook(turn), failoverPolicy: NO_RETRY, abortSignal: turn.signal, prompter: casePrompter(null) })`.
   - The executor is `host.createToolExecutor(null, null, null, { workingDirectory: turn.dir, allowedDirectories: [], caseContext: runtime.caseContext(turn, { ownerMessages: [], ownerMessageTimes: [] }), denyAutoApproval: true, allowedToolNames: new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS]) })`.
   - `WAKEUP_BASE_TOOLS = ['Read', 'Glob', 'Grep']`.
   - The tools offered are `shapeToolDefinitions(<definitions of WAKEUP_BASE_TOOLS>, true, registry)`.
   - The prompt is `buildCaseSystemPrompt(orientation, WAKEUP_PROMPT)`, with one user message listing the wake-ups and the orient step's `why`.
7. On completion: a `wakeup` entry (`# Wake-up <ids>` plus content), `markRan(acted)`, close.
8. On failure: a `wakeup` entry `failed: <message>`, `markRan(failed)`, and one `wakeups-failing` briefing (urgency `normal`, deduplicated) on the third consecutive failure. On abort (owner or budget pause): `markRan(skipped)` with no failure count.

Confinement has three layers. `allowedToolNames` refuses any tool outside the set,
even one the model names without being offered it. `denyAutoApproval` with no
requester denies every gated tool. `ownerMessages: []` blocks `user` facts and every
owner-only brief field.

**`WAKEUP_PROMPT`** says: nobody is watching; contact the owner only through `Ask`;
the brief's materiality decides whether to brief; if blocked, `Fail`.

### 3.8 Model roles — `src/cases/roles.js`

```js
resolveRole(role, { settings, caseMeta, hasToken = () => true }) → { provider, model, tier }
providerFamily(provider, model) → string   // provider id; openrouter → model prefix before '/'
```

Precedence: `caseMeta.roles[role]`, then `settings.cases.roles[role]`, then
`DEFAULT_ROLES` (`orient` fast, `classify` fast, `draft` standard, `judge` smart,
`verify` smart). An entry is `{ tier }` or `{ provider, model?, tier? }`. A tier
resolves through `settings.inference.tierMap` with `getTierConfig`'s fallbacks.

**`verify`.** An explicit `case.yaml.roles.verify` is honoured as written, with a
`warn` if its family equals `judge`'s. Otherwise, when its family equals `judge`'s, it
takes the first `smart`/`standard`/`fast` entry with a different family whose provider
`hasToken`. If none qualifies, it uses `judge`'s target and logs `verify falls back to
the judge's provider family (<family>)`. `CaseRuntime.roleModel(id, role)` wraps it.

**Defect 1** (`src/core/create-core.js`, `agentExecutorAdapter.execute`): call
`createAgentRuntime({ tier: requestedTier, ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) }, …)`.
`InferenceRouter.resolve` already honours both.

**Defect 2.** `InferenceRouter.routeWithFallback(tier, messages, options)` gains
`options.target = { provider, model }`. When present it replaces `getTierConfig(tier)`,
and it is stripped before `execute`. `execute` streams when `options.onChunk` is set
and the provider has `streamMessageWithTools`. `CaseRuntime.routedProvider(turn,
{ role } | { target, tier })` returns `{ getProviderName, getDefaultModel,
sendMessage, sendMessageWithTools, streamMessageWithTools }`; each one calls
`routeWithFallback(tier, messages, { ...opts, tools, onChunk, target })`. Before the
first call it runs `host.resolveInference({ provider, model, tier })` once, to refresh
an OAuth token. Case loops use
`NO_RETRY = { plan: () => ({ action:'abort', reason:'routed', waitMs: 0 }) }`. Owner
turns route to the owner's chat selection; wake-ups use `orient`, then `judge`.

### 3.9 Questions — `src/cases/questions.js`

`new QuestionStore(dir, { now })` over `.kl/questions/<id>.json` (shape in §4.3).
IDs are `q-` plus a 4-digit counter, found by replaying the directory.

| Method | Behaviour |
|---|---|
| `create(record)` | Validates per the table below and fills `id`, `caseId`, `createdAt`, `deliveries: []`, `answer: null`. An open record with the same normalised `text` and `kind` is returned instead of a new one |
| `open()` | Records with `answer === null` |
| `get(id)` | — |
| `answer(id, { channel, text, optionId })` | Claim `fs.openSync('<id>.claim','wx')`. On `EEXIST`, or if `answer` is set: `QuestionError` `ALREADY_ANSWERED` carrying the stored record. `briefing` → `QuestionError` `IS_BRIEFING` (use `acknowledge`). Otherwise build the fact input (below), write **exactly one** fact through `new FactLedger(dir).assert(...)` with `provenance:'user'` and `source: { kind:'question', ref:id, channel, at }`, write `answer` with `factId`, write a `question` journal entry, and return the record |
| `acknowledge(id, { channel })` | Briefings only; takes the claim. `answer = { channel, at, text: null, optionId: null, factId: null }`; no fact |
| `recordDelivery(id, { channel, at, deliveryId })` | Appends to `deliveries` (atomic rewrite). C2's in-app delivery uses it; C4's channels call the same method |
| `expire(now)` | Takes the claim. `briefing` past `expiresAt`: auto-acknowledge (`channel:'expired'`). `defaultOnSilence:'hold'`: no change, and orientation marks it overdue. `<optionId>`: `answer = { channel:'default', at, text:null, optionId, factId:null }` plus a journal entry; no fact |
| `close(id, { reason, by })` | Closes a record without an answer and without a fact (R47): `closed = { at, reason, by }`, `by` in `panel | expiry | system`. Used by C7's review panel and by hosts that resolve a question out of band; the outcome is journaled, never written as a `user` fact |
| `static registerAnswerHandler(type, { toFact?, onAnswered? })` | Module-level registry keyed by `payload.type`. `toFact(record, answer) → factInput` replaces the default fact input. `onAnswered(record, fact, { runtime, caseId })` runs after the write, inside `answerQuestion` |

**Create validation** (`QuestionError` code `INVALID`):

| Field | Rule |
|---|---|
| `kind` | `question`\|`approval`\|`briefing`. `approval` only from host code (C3), never from the `Ask` tool |
| `text` | 1–2000 characters after trimming |
| `options` | optional; ≤ 6; `id` matches `^[a-z0-9-]{1,16}$` and is unique; `label` is 1–200 characters. Briefings take none |
| `urgency` | `low`\|`normal`\|`high`, required |
| `expiresAt` | `null`, or RFC3339 after `now` and ≤ 30 days out |
| `defaultOnSilence` | `hold` (default), or an option id. Briefings: `hold` only |
| `payload.type` | string; default `ask` |
| `payload.mcpAnswerable` | boolean; default `true` |

**Default fact input:** subject and attr from `payload.about` (default `question` /
`<id>`), `supersedes: payload.resolves`, `value` = the option label or the text,
`stmt: Owner answered <id> ("<text ≤ 80>"): <value>`. The stage-1 quote rule governs
facts the *model* declares as `user`. An answer is host-verified, so it bypasses the
quote check on purpose. `FactLedger.assert` accepts the kinds `user-message`,
`question` and `owner-action` only with `provenance:'user'`, and accepts `user` only
with one of those kinds.

**Handlers C2 registers:**

| `payload.type` | `toFact` | `onAnswered` |
|---|---|---|
| `direction` | subject `direction`, attr = failure basename | `applyOwnerFact` |
| `budget-grant` | First number in the text (`YYYY-MM-DD` for `deadline`), when greater than `spent`: subject `budget`, attr `<category>`, numeric value. Otherwise subject `budget`, attr `<category>-reply`, value = text | `applyOwnerFact`. For `-reply`, a journal note says the case stays paused |
| `commit-failed` | default | none; resume goes through IPC |

`CaseRuntime.answerQuestion(caseId, qid, { channel, text, optionId })` runs inside
`systemAction('answer <qid>')`: `store.answer`, the handler's `onAnswered` (or
`applyOwnerFact` for the default type), the `retry` wake-up for question kinds, and
`case:changed`. `acknowledgeBriefing(caseId, qid)` works the same way, with no fact
and no wake-up.

**`Ask` tool** (op `Ask`) takes `question`, `kind` (`question`\|`briefing`),
`options`, `urgency`, `expiresAt`, `defaultOnSilence`, `resolves` (an active unknown),
`about`, and `materiality` (briefings). It maps them onto `create`, plus these rules:

- **Safe defaults.** A non-`hold` `defaultOnSilence` must name an option whose `id` or `label` (normalised) appears in `brief.safeDefaults` (owner-only) or in `runtime.playbookSafeDefaults?.(id) ?? []` (C6). Otherwise: `Only "hold" is allowed: the brief declares no safe default matching this option.`
- **Materiality (parent §5.4, F9).** For a briefing: `materiality` ∈ `brief.materiality.ignore` → refused with `The brief says not to contact the owner about "<tag>". Journal it instead.` Urgency above `low` requires `materiality` ∈ `brief.materiality.tell`; otherwise it is clamped to `low` with a note. The default urgency is `normal` for a question and `low` for a briefing.
- **Charge.** `questionsPerDay` at 100 % refuses `kind: question`.
- **Result.** `{ ok: true, questionId, urgency, delivered, note: 'Not answered yet. Do not assume the answer.' }`.

**Briefings** never block anything and need no answer. The owner dismisses one from
the panel (`case:acknowledgeBriefing`), or it lapses at `expiresAt`.

**`AskUser` in case mode.** `shapeToolDefinitions` strips `AskUser` when attached, and
`CASE_TOOL_NAMES = ['Ledger','Brief','Decide','Recommend','Reorient','Ask','Fail']`.
`AgentLoop` intercepts `AskUser` before the executor, and it calls
`prompter.requestDirectoryAccess` unconditionally. Case loops therefore use
`casePrompter(base)`, exported from `chat-integration.js`: `askUser` returns
`{ ok:false, error:'In a case, ask the owner with the Ask tool.' }`, and
`requestDirectoryAccess` delegates to `base` on owner turns. On wake-ups `base` is
`null`, and it returns `false`.

**In-app delivery.** `create` calls `host.notify('case:changed', { caseId,
what:'questions', questionId, attention })`, where `attention` is `panel` for `low`,
`banner` for `normal`, and `banner` plus `host.uiToast.send` for `high`. When
`host.interactive()` is true, `recordDelivery(id, { channel:'in-app', at,
deliveryId:'in-app-<qid>' })` runs.

**In service mode** nothing can deliver the question. It is logged at `warn` (`Case
<slug> asks <qid> (<urgency>): <text>. No channel can deliver it until stage 4; it
waits.`), `deliveries` stays empty, and the case holds. The question can be answered
only through a desktop app sharing the same cases root, or through C4 and C7 once they
land.

### 3.10 Runtime additions and turn close — `src/cases/case-runtime.js`

- **Constructor:** `new CaseRuntime({ root, staleLockMs, orientationMaxChars, getSettings, now, host })`. `host = { inferenceRouter, resolveInference, createToolExecutor, toolRegistry, AgentLoop, getUsageTracker, hasProviderToken, notify, uiToast, interactive (a function `() => boolean`, R50), getExecutorRegistry }`, all optional. Without a host, wake-ups and routed providers are unavailable.
- **`this.turns: Map<caseId, { turnId, source, triggers, reorientPending, signal, abort }>`**, plus `abortUnattended()`, which shutdown calls before `releaseAll()`.
- **`systemAction(id, label, fn)`** takes the lock with `turnId: 'system-<ts>'`, runs `fn`, calls `commitAll('system: <label>')` (a no-op on a clean tree) and releases. When this process holds the lock for a turn, it runs `fn` directly, and the turn commits the synchronous writes. When another process holds it, it throws `CaseBusyError`.
- **`beginTurn(id, { turnId, source = 'owner', ownerMessage = null })`**, in order: lock; owner-edits commit; `reconcile` + `onCrossings`; `charge('turnsPerDay', 1)`; turn-start hooks; `detectTriggers`; orientation (triggers, hook notes, budget including unpriced, open questions, status reason and failure report, next wake-up); register in `this.turns`. It returns the C1 fields plus `source`, `triggers` and `reorientPending`.
- **`caseContext(turn, { ownerMessages, ownerMessageTimes })`** returns the C1 shape plus `source` and `ownerMessageTimes`.
- **`endTurn(turn, { summary, journal, journalKind = 'turn' })`**, deltas on C1: `lastTurnAt`, and `lastOwnerTurnAt` per §3.3; the baseline refresh; journal under `journalKind`; the commit-failure count (§3.4); remove the turn from `this.turns`.

### 3.11 Chat send path — `src/ipc/chat-handlers.js` (case-turn block only)

| Place | Change |
|---|---|
| `beginTurn(caseId, { turnId })` | add `source:'owner'`, `ownerMessage: safeMessage` |
| `ownerMessages` builder | also build `ownerMessageTimes` from each message's `timestamp`; the current message gets `now` |
| `caseContext:` | `caseRuntime.caseContext(caseTurn, { ownerMessages, ownerMessageTimes })` |
| RequestTools hint line | skipped when `caseTurn` (the tool is blocked) |
| `new AgentLoop(provider, …)` | when `caseTurn`: provider `caseRuntime.routedProvider(caseTurn, { target:{ provider: inference.providerType, model: inference.model }, tier: inference.tier })`, `onUsageRecorded: caseRuntime.usageHook(caseTurn)` (`usageTracker` is already passed), `failoverPolicy: NO_RETRY`, `prompter: casePrompter(prompter)` |
| non-agent `streamMessage` branch | when `caseTurn`, feed the recorded usage event to `usageHook` |

## 4. Data formats

### 4.1 `case.yaml` additions

```yaml
lastTurnAt: 2026-09-23T14:05:00Z
lastOwnerTurnAt: 2026-09-23T14:05:00Z
statusReason: { kind: failure, by: runtime, ref: journal/2026-09-23-1405-failure.md,
                note: '', failureClass: dead-end, at: 2026-09-23T14:05:00Z }
budget: { usd: 40, deadline: 2026-11-30, turnsPerDay: 48, questionsPerDay: 6 }
roles: { judge: { provider: openai, model: gpt-4o } }
autonomy: { onExecutorNoAnswer: retry-within-envelope }
```

| Field | Rules |
|---|---|
| `lastTurnAt`, `lastOwnerTurnAt` | written by `endTurn` only |
| `statusReason.kind` | `gating`\|`failure`\|`budget`\|`budget-grant`\|`commit`\|`owner`\|`direction` |
| `budget.<c>` | written by owner edits and by grants (`question`/`owner-action` facts) |
| `roles.<role>` | `{tier}` or `{provider, model?, tier?}`; owner-edited |
| `autonomy.*` | `stop` (default) or `retry-within-envelope` |

`brief.md` front matter gains `safeDefaults: []` (owner-only).

### 4.2 `.kl/budget.json`

This is the program §4.4 shape, with these additions: `usd.unpricedTokens`, and
`grantedBy` per category. The `deadline` entry is `{ at, crossed }`, with no stored
ratio.

### 4.3 `.kl/questions/<id>.json`

This is the program §4.3 shape, unchanged. The `payload` keys C2 uses are:

| Key | Meaning |
|---|---|
| `type` | handler key (`ask`, `direction`, `budget-grant`, `budget-daily`, `commit-failed`, `wakeups-failing`, later `approval` from C3, …) |
| `mcpAnswerable` | `false` for `direction`, `budget-grant` and `commit-failed` |
| `about` | where the answer fact lands |
| `resolves` | the unknown the answer supersedes |
| `budget` | the budget category |
| `failure` | the failure report's journal path |
| `key` | deduplication key |
| `materiality` | the briefing's materiality tag |

`<id>.claim` is an empty marker file.

### 4.4 `.kl/wakeups.json`

```json
{ "items": [ { "id": "w-0001", "kind": "daily-orientation", "at": null, "everyMs": 86400000,
  "nextAt": "2026-09-24T09:00:00-05:00", "payload": { "key": "daily" }, "createdBy": "runtime",
  "createdAt": "2026-09-23T14:05:00Z", "lastRunAt": null, "lastOutcome": null,
  "attempts": 0, "lastError": null } ] }
```

`at`/`everyMs`: exactly one is non-null. `lastOutcome` is one of
`quiet|acted|skipped|failed`.

### 4.5 `.kl/plan.json` (read only; C3 writes it)

`{ "steps": [ { "id": "s1", "state": "pending|in-flight|done|failed|cancelled" } ] }`

### 4.6 `.kl/triggers.json`

```json
{ "acknowledgedAt": "2026-09-23T14:05:00Z", "undermined": ["D-002:f-0017"],
  "executorsMaterial": { "phone-agent": { "openJobs": 2 } }, "budgetCrossed": { "usd": [50, 80] },
  "acknowledgedKeys": ["detour:msg-7"], "commitFailures": 0 }
```

### 4.7 Journal entries (program §4.2)

File names are `YYYY-MM-DD-HHMM-<kind>.md`, which is what `CaseRecords.writeJournal`
produces today (`2026-09-23-1405-failure.md`).

| Kind | Writer | Body |
|---|---|---|
| `reorient` | `Reorient` | `# Re-orientation` · triggers · changed · affects · action · note |
| `failure` | `Fail` | `# Failure report — <what>` · Class · Tried · Why · Unknowns · Recommendation (one, or "none") · `Waiting for the owner's direction.` |
| `wakeup` | turn runner | one line (quiet/skipped/failed), or `# Wake-up <ids>` plus content |
| `question` | `QuestionStore` | `<id> answered via <channel>: <value> (fact <fid>)`, `<id> expired: default <optionId> applied`, or a budget-reply note |

## 5. Interfaces

### 5.1 Consumed

| From | What |
|---|---|
| C1 (merged) | `CaseRuntime`, `CaseStore.updateMeta`, `FactLedger`, `Brief`, `CaseRecords.writeJournal`, `recommendationGate`, `shapeToolDefinitions`, `buildCaseSystemPrompt`, `requireOwnerQuote`, write guard |
| Core (merged) | `CronStore`/`CronScheduler`/`CronExecutor`, `AgentLoop` (`usageTracker`, `onUsageRecorded`, `failoverPolicy`, `prompter`), `UsageTracker.record`, `InferenceRouter`, `createToolExecutorWithApprovals` |
| C3 | `.kl/executors.json` `material` (§4.7), `.kl/plan.json` `steps[].state`, optional `ExecutorRegistry.cancelOpenJobs(caseId, reason)` |
| C6 | optional `CaseRuntime.prototype.playbookChanges(id) → [{name, from, to}]`, `acknowledgePlaybooks(id)`, `playbookSafeDefaults(id) → string[]` |

### 5.2 Produced

| Name | Contract |
|---|---|
| `setStatus`, `assertWritable`, `requireReoriented`, `autonomyAllows` | §3.1. Both checks return `null` or `{ ok:false, error }`. `requireReoriented` refuses when no turn is registered. C3's `Plan` calls `assertWritable(id,'Plan')`, then `requireReoriented(id)` |
| Status allowlists | `ALLOWED.paused`, `ALLOWED.done`, `ALLOWED.abandoned` include the C6 `Playbook.*` ops listed in §3.1 |
| `addTurnStartHook(name, fn, { phase? })` | §3.3 (R33); `name` labels failures and dedupes re-registration; `phase: 'owner-message'` hooks run through `runOwnerMessageHooks(turn)` after `UserPromptSubmit` (C5 classification); `beginTurn(id, { turnId, ownerMessage, source })` |
| `detectTriggers` `playbookChanges`, `hookTriggers` inputs | §3.3 |
| `systemAction(id, label, fn)` | public; C4's delivery writes run inside it |
| `CaseRecords.writeJournal(kind, text)` | kinds `reorient`, `failure`, `wakeup`, `question` |
| `QuestionStore` | `create` (validation table), `open`, `get`, `answer`, `acknowledge`, `close`, `recordDelivery`, `expire`, `static registerAnswerHandler(type, { toFact, onAnswered })`; `payload.type` and `payload.mcpAnswerable` |
| `CaseRuntime.answerQuestion`, `acknowledgeBriefing` | §3.9. C7 answers through `answerQuestion` and checks `mcpAnswerable` |
| `Budget` | §3.5, plus `reconcile()`, `exhausted()`, `meta.unpricedTokens` |
| `CaseRuntime.onCrossings(id, category, crossedNow)` | callers of `charge` (C3, C4, C7) pass the result here |
| `resolveRole`, `roleModel`, `routedProvider`, `NO_RETRY` | §3.8 |
| `WakeupStore` (`every` in ms), `ensureWakeupJob`, `runDueWakeups` | §3.6 |
| `CronExecutor.registerSystemJob` | §3.6 |
| `ToolExecutor` `allowedToolNames` | §3.2 |
| `casePrompter(base)` | §3.9 |
| UI event `case:changed` | `{ caseId, what:'questions'|'status'|'budget', questionId?, attention? }` |

### 5.3 Additions from the sibling fix rounds (C3–C7)

- `runOwnerMessageHooks(turn)` runs the `phase: 'owner-message'` hooks after `UserPromptSubmit` passes and before the model call; their notes and triggers are merged like turn-start ones (C5).
- `.kl/triggers.json` gains `caseTypeMaterial`, written from `runtime.caseTypeMaterial(id)` (C5/C6) and compared by `detectTriggers`.
- `QuestionStore.answer` honours `payload.disclosable` (default `true`; `false` asserts the fact with `disclosable: false`) and `payload.gating.category` (C5, C6, C7).
- `recordDelivery(id, { channel, at, deliveryId })` is implemented here; C2's in-app delivery and C4's ladder both call it (program §4.3).
- The sweep calls `registry.pollWakeup(caseId, wakeup)` for due `poll-executor` wake-ups when an executor registry is present (C3, R48).
- `CaseRuntime.createQuestion(id, record, { charge })` (C5) is the charged creation path every stage uses instead of `QuestionStore.create` directly; it applies the `questionsPerDay` cap and `held` status.
- `ALLOWED.abandoned` includes `Playbook.list`, `Playbook.read` (C6).

## 6. Configuration

`src/core/settings.js`, namespace `cases`, merged key by key. It is read from the
data-dir settings store; none of these keys is security policy.

```js
cases: {
  root: '',
  reorientAfterHours: 8,
  timeZone: '',                 // '' = host local zone
  budgets: { usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null },
  roles: { orient: { tier: 'fast' }, classify: { tier: 'fast' }, draft: { tier: 'standard' },
           judge: { tier: 'smart' }, verify: { tier: 'smart' } },
  wakeups: { enabled: true, dailyAt: '09:00', maxIterations: 20, maxCasesPerTick: 3,
             retryBackoffMinutes: [5, 15, 60] }
}
```

Per-case overrides: `case.yaml` `budget`, `roles`, `autonomy`. No env vars. No
`node.yaml` or `service.json` keys.

## 7. Host wiring

| File | Touch |
|---|---|
| `src/core/create-core.js` | `require('../cases/wakeups')`. The `CaseRuntime` gets `getSettings` and `host`: `notify: (e,p) => ui.send(e,p)`, `uiToast: deps.uiToastChannel`, `interactive: () => Boolean(deps.ui)` (F7 replaces it with a bridge-connected check in attached mode), `getUsageTracker: () => usageTracker`, `createToolExecutor: createToolExecutorWithApprovals`, `resolveInference`, `inferenceRouter`, `toolRegistry`, `AgentLoop`, `hasProviderToken`. In `start()`: `registerSystemJob` and `ensureWakeupJob` before `cronScheduler.start()`. Shutdown: `caseRuntime.abortUnattended()` before `releaseAll()`. Defect-1 fix. `createToolExecutorWithApprovals` passes `denyAutoApproval` and `allowedToolNames` through; the merged rule with F3/F7 is program §4.21: `(remoteApprovals !== 'allow' && !isLocalDesktopEvent(event)) || executorOptions.denyAutoApproval === true` |
| `src/execution/tool-executor.js` | `allowedToolNames` in the case guard |
| `src/core/settings.js` | `cases` defaults and merge |
| `src/providers/inference-router.js` | `options.target`; streaming in `execute` |
| `src/cron/cron-executor.js`, `cron-scheduler.js` | system jobs (§3.6) |
| `src/cases/ledger.js` | host source-kind rule |
| `src/cases/brief.js` | owner-only `materiality`, `deadline`, `safeDefaults` |
| `src/cases/orientation.js` | sections: re-orientation, since last turn, status/failure, questions, budget (with unpriced warning), next wake-up |
| `src/cases/chat-integration.js` | `CASE_TOOL_NAMES`, `CASE_BLOCKED_TOOL_NAMES`, strip `AskUser`, `casePrompter`, `WAKEUP_BASE_TOOLS`, prompt lines |
| `src/tools/builtin/case-tools.js` | `withCase(options, op, fn)`, reserved kinds, direction quote rule, budget-fact note |
| `src/tools/builtin/case-unattended-tools.js` (new) | `ReorientTool`, `AskTool`, `FailTool`, `registerCaseUnattendedTools(registry)` |
| `src/tools/index.js` | one call to `registerCaseUnattendedTools(toolRegistry)` |
| `src/ipc/case-unattended-handlers.js` (new) | See the IPC table below |
| `src/ipc/constants.js`, `register.js` | six constants, one register call |
| `preload.js` | `cases.questions`, `answerQuestion`, `acknowledgeBriefing`, `setStatus`, `budget`, `grantBudget` (with `validateString` on ids), `cases.onChanged(cb)` via `registerOnce('case:changed')` |
| `src/ipc/chat-handlers.js` | §3.11 only |
| `renderer.js`, `styles.css` | See the renderer notes below. No `index.html` edit |
| `CLAUDE.md` | a short "Cases: unattended" section |

IPC channels in `src/ipc/case-unattended-handlers.js`:

| Channel | Behaviour |
|---|---|
| `case:questions {caseId?}` | open records for cases in any status except `done`/`abandoned` |
| `case:answerQuestion {caseId, questionId, text?, optionId?}` | `answerQuestion` |
| `case:acknowledgeBriefing {caseId, questionId}` | `acknowledgeBriefing` |
| `case:setStatus {caseId, status, note?}` | runs in `systemAction`, `by:'owner'` |
| `case:budget {caseId}` | `Budget.status()` |
| `case:grantBudget {caseId, category, limit}` | Validates: `category` is a known category; `limit` is a finite number > 0 (> `spent` for money), or `YYYY-MM-DD` for `deadline`. Runs in `systemAction`, writes the `owner-action` fact, then `applyOwnerFact` |

Renderer (`renderer.js`, `styles.css`): one function,
`renderCaseUnattendedSection(chat, container, { compact })`.

- **Full mode**, inside `renderChatCaseSection`: status and reason; Pause / Resume / Done / Abandon (Done and Abandon go through `showConfirmDialog`); the budget line with the unpriced warning and a Grant button; open questions with option buttons and a text box; briefings with a Dismiss button.
- **Compact mode**, in `#case-questions-bar`, created and inserted above the composer from JS: open `question`/`approval` records of urgency `normal`/`high`, plus `high` briefings.
- Both refresh on chat switch and on `cases.onChanged`. All text is set with `textContent`.

## 8. Security and trust

| New capability | Risk | What stops it |
|---|---|---|
| Model turns with no owner watching | Injected content steers the case into sending data out | `allowedToolNames` confines wake-ups to case tools plus `Read`, `Glob`, `Grep`, enforced in the executor. **No `WebFetch`/`WebSearch` on wake-ups until C3's outbound gate merges** (a GET URL is an outbound channel). `denyAutoApproval` with no requester. `ownerMessages: []`. Budgets. The service `agent` profile already sets `remoteApprovals:'deny'` |
| Tools that reach outside the case | `message`, `sessions_*`, `RequestTools`, `ToolSearch`, `Canvas` | In `CASE_BLOCKED_TOOL_NAMES` for every case turn |
| The model raising its own limit | A quoted "ok" dressed up as a budget grant | Budget effects only from `question`/`owner-action` sources, both written only by host code |
| A stale quote ending `needs-direction` | An old "go ahead" reused | The direction quote must come from this turn's message or one sent after `statusReason.at` |
| Gate inputs written by the model | The model edits `materiality`, `deadline` or `safeDefaults` to loosen gates | Owner-only brief fields |
| Host-verified `user` facts | Forgery | Reserved source kinds refused by the Ledger tool; `FactLedger` ties them to `user` |
| Question text in the UI | Markup injection | `textContent` only |
| System cron job | Disabled or spoofed through the Cron tool or IPC | Update/remove refused; `addJob` strips `system`; `ensureWakeupJob` on every start |
| `defaultOnSilence` | Acting on silence with a model-chosen option | Only options the owner (brief) or a playbook declared safe |

Maps to parent principles 3, 5, 6 and 8.

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| Tool refused by status, confinement or re-orientation | `{ ok:false, error }` / `{ success:false, error }`; the turn continues | The model explains |
| Wake-up while an owner turn runs | Case skipped by the sweep; retried next tick | Nothing |
| Orient provider down | Fallbacks, then `failed` with 5/15/60 min backoff; a briefing after 3 failures; no "nothing changed" entry | `wakeup` journal and a briefing |
| Orient output unparseable | Escalate to `judge` | Normal wake-up entry |
| Two consecutive commit failures | `paused` (`commit`) and a `high` question | Question |
| Question answered twice | `ALREADY_ANSWERED`: `{ ok:false, error:'q-0012 was already answered via in-app at <at>.', question }` | The first answer |
| Budget answer with no usable number | One `-reply` fact; the case stays paused | Journal note; Grant button |
| Limit lowered below spend | `reconcile` → 100 % → paused on the next turn or sweep | Budget question |
| Resume or direction while at 100 % | `BUDGET_EXHAUSTED`; a direction fact leaves the case `paused` (`budget`) | `Raise the <category> budget first.` |
| IPC action while another process holds the lock | `CaseBusyError` | `Case is busy with a wake-up; try again in a minute.` |
| Owner deletes the system job | Refused | `"cases:wakeups" is a system job managed by King Louie.` |
| `cases.wakeups.enabled: false` | Sweep and turns skipped | Nothing runs |

## 10. Testing

`node --test` throughout. A fake clock is injected into `CaseRuntime`, `Budget`,
`WakeupStore` and `QuestionStore`; case roots are temp dirs.

| File | Covers |
|---|---|
| `tests/cases-status.test.js` | Every transition, allowed and refused; `BUDGET_EXHAUSTED` on every path to `active`; allowlists and denylists per op, including the `Playbook.*` entries; `autonomyAllows` |
| `tests/cases-triggers.test.js` | Every trigger row. A time gap survives a turn without `Reorient` (`lastOwnerTurnAt` does not advance). Quiet wake-ups do not reset the gap. Baseline pruning lets 80 % fire again after a grant and on a new day. Hook triggers and notes. Inert without the C3/C6 inputs |
| `tests/cases-budget.test.js` | Thresholds; day rollover in `timeZone`; deadline ratio, including a deadline before `createdAt`; no write on a quiet `charge('deadline',0)`; `reconcile` raise and lower; unpriced tokens |
| `tests/cases-wakeups.test.js` | Store methods; `dailyAt` across a DST change; coalescing; `ensureWakeupJob` idempotent. The **real `CronScheduler`** (`tickIntervalMs: 20`) with a fake system handler: dispatch, `{ok:true}` wrapping, a throw counted without disabling, update/remove refused, `system` stripped by `addJob` |
| `tests/cases-service-wakeups.test.js` | `createCore` with service-style ports (no `ui`), then `start()`: the `cases:wakeups` job exists and dispatches to `runDueWakeups`. A question created there has no deliveries and logs the service-mode line |
| `tests/cases-turn-runner.test.js` | Mock provider. Quiet path; change path; trigger shortcut; `retry` for an answer skipping orient. **Judge-loop usage lands in `.kl/budget.json`**. turnsPerDay skip. An owner pause aborts → `skipped`. **A mock model calling `message` and `Bash` → both refused** by `allowedToolNames` |
| `tests/cases-questions.test.js` | Create validation table; dedupe; answer → exactly one `user` fact with `source.kind 'question'`; `resolves`; handlers; acknowledge; `recordDelivery`; expiry for `hold`, default and briefing; claim held by `expire`; safe-defaults rule; materiality clamp and refusal |
| `tests/cases-roles.test.js` | Precedence; `verify` fallback; explicit `verify` honoured with a warning |
| `tests/inference-router.test.js` (extend) | `options.target`; streaming |
| `tests/executor-adapter-provider.test.js` | Through `createCore`, with a stub `ProviderFactory` provider registered under `openai` and a stubbed token: a workflow-style `execute` with `provider:'openai'` reaches the `openai` stub while the active tier maps to another provider |
| `tests/tool-executor.test.js` (extend) | `allowedToolNames` refusal before approval |
| `tests/cases-tools.test.js` (extend) | `Reorient`; `Fail` requiring re-orientation; reserved source kinds; owner-only brief fields; stale direction quote refused; a Ledger `user` budget fact changes no limit; the new blocked tools stripped and refused |
| `tests/cases-ipc.test.js` (extend) | The six handlers, `grantBudget` validation, `CaseBusyError` text |
| `tests/cases-regressions.test.js` (extend) | **F4**: `Fail` with one recommendation → `needs-direction` and a `high` `direction` question; `Recommend`, `Fail` and `Plan` refused; an answer → `active`. **F9**: a briefing tagged `voicemail` (ignored) is refused; `urgency: high` with no `tell` tag is stored `low` with `attention:'panel'`. **F12**: charges past `usd` 100 % → `paused` and a `budget-grant` question; `Ledger.assert` refused, `query` allowed; the model's own `user` budget fact (quote "ok") changes nothing; a due wake-up is not run; answer `"2"` → `active` and `case.yaml.budget.usd === 2` |
| `tests/e2e/cases.test.js` (extend; `KL_CASES_ROOT`) | A seeded question appears in the panel and the bar; answering it records a fact |

**Five conditions the parent is silent on:**

| Condition | Pinned by |
|---|---|
| A wake-up fires while the owner is mid-turn | `cases-turn-runner`: with an owner turn registered, `runDueWakeups` runs no wake-up turn for that case and writes nothing, and the next tick after `endTurn` runs it |
| The clock jumps | `cases-wakeups`: forward 3 days gives one coalesced turn; back 2 hours triggers `reanchor`. `cases-budget`: no backwards day reset. `cases-triggers`: no gap for a future `lastOwnerTurnAt` |
| The budget limit is lowered below spend | `cases-budget` and an F12 variant |
| A question is answered twice from two surfaces | `cases-questions`: two `QuestionStore` instances → one fact; the second gets `ALREADY_ANSWERED` |
| The `orient` provider is down | `cases-turn-runner`: all targets throw 503 → `failed`, backoff, one briefing on the third failure, no `quiet` entry, no judge call |

## 11. Deviations from the parent

1. **Questions and `Ask` in stage 2**, not 4 (program ruling 1). IDs are `q-0012`.
2. **Per-day budgets at 100 %** refuse the category until the day rolls over instead of pausing. `usd` and `deadline` pause as in parent §9.1.
3. **The time gap is measured from the owner's last turn and applies to owner turns only.** Wake-ups rely on the orient step; a daily wake-up with an 8-hour gap would otherwise always escalate.
4. **Re-orientation also gates `Recommend`, `Decide` and `Fail`.** Parent §5.3 names only `Plan` and executor calls, which arrive in C3.
5. **Usage is charged per LLM call**, not only at close (parent §5.5).
6. **Owner grants** are `user` facts from host-verified sources only. A quoted chat message cannot raise a limit, and in `paused` the model cannot write one (program §4.1).
7. **Commit failure** (parent §14 pauses immediately): the case pauses with a `high` question after **two** consecutive failures, counted in `.kl/triggers.json`. One transient failure is recovered by the next turn's `owner edits` commit.
8. **`defaultOnSilence`** accepts an option only if the owner declared it in `brief.safeDefaults` or a playbook did (parent §8.3). A new owner-only brief field carries it.
9. **Wake-ups get no web tools** until C3. The parent expects wake-ups to act; in C2 they act only through case tools and read-only file tools.
10. **Added transitions:** `draft → abandoned` (owner) and `needs-direction → paused` (budget). Every transition to `active` is also refused at budget exhaustion.
11. **Code contradictions.**
    - There is no `lastTurn` field; C2 adds `lastTurnAt` and `lastOwnerTurnAt`.
    - `InferenceRouter` clamps tiers to `fast|standard|smart`, so roles live in `settings.cases.roles`.
    - `routeWithFallback` took only a tier; C2 adds `options.target`.
    - `FactLedger` did not tie `user` to an owner source; C2 does.
    - `AgentLoop` intercepts `AskUser` and records usage only with a `usageTracker`.
    - `ToolExecutor` runs any registered tool, whatever the model was offered; C2 adds `allowedToolNames`.
    - `CronScheduler.runNow` treats `!ok` as an error.
    - The e2e harness is an HTTP bridge (program ruling 9).

## 12. Assumptions made without asking

- Default budgets: `usd` 20, `turnsPerDay` 48, `questionsPerDay` 6, `contactsPerDay` 20. Alternative: no default limits.
- Unpriced providers are warned about, not capped. Alternative: a per-case token cap (`budgets.tokens`) for providers with no price table.
- Wake-ups are on by default, with a daily orientation at 09:00 local time. Alternative: off until enabled per case.
- Owner chat turns use the owner's selected model, routed with fallback, rather than `judge`. Alternative: `judge` for every case turn.
- One case per wake-up at a time, at most three per tick. Alternative: parallel.
- The advisor review cost on owner turns is not charged to the case. Alternative: charge it.
- Budget answers are parsed as the first number in the text. Alternative: preset option buttons.
- Blocking `RequestTools`/`ToolSearch` in owner case turns hides deferred tools from case chats. Alternative: allow them, with the executor confining injected tools.

## 13. Deferred

| Item | Stage |
|---|---|
| `WebFetch`/`WebSearch` on wake-ups, behind the outbound gate | C3 |
| Delivery beyond in-app, the ladder, batching, digest; `recordDelivery` callers | C4 |
| A model-facing tool to schedule custom wake-ups | C3, with `poll-executor` |
| Case-type material fields for `executor-change`; owner-message classification hook | C5 |
| `playbookChanges`, `acknowledgePlaybooks`, `playbookSafeDefaults`, `Playbook.*` ops | C6 |
| MCP answering, honouring `mcpAnswerable` | C7 |
| A cases list view outside the chat-info popover | F7 |

## 14. Dependencies (npm)

None. Time-zone day math uses `Intl.DateTimeFormat`. `js-yaml` and `cron-parser` are
already dependencies.
