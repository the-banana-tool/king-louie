# Cases Stage 2: Unattended cases — Implementation Plan (Part 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A case keeps working while the owner is away: cron wakes it, a cheap `orient` call decides whether anything changed, a confined `judge` loop acts within budget, and the owner answers questions, grants budget and pauses, resumes, finishes or abandons the case from the desktop app.
**Architecture:** Part 2 wires Part 1's modules together. `CaseRuntime` gains status, re-orientation, hooks, budgets, questions, roles and routed providers; the case tools gain `Reorient`, `Ask` and `Fail` and per-status refusals; `src/cases/turn-runner.js` runs the sweep and the headless wake-up turn; `createCore` registers the `cases:wakeups` system job and gives the runtime its host; the chat send path routes owner case turns through the runtime; a new IPC module and a renderer section expose status, budget and questions.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Electron IPC (`src/ipc/` only). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.
**Depends on:** Part 1 (`docs/superpowers/plans/2026-09-23-cases-stage2-unattended-part1.md`), merged. Its exports are listed in Part 1's hand-off section.

## Global Constraints

Program §3, verbatim:

- Open source: nothing specific to one person, machine, domain, path, app or
  provider account in code, defaults, fixtures or docs. Examples use `example.com`,
  `kl.example.com`, `gpu-box`, `web-01`, `Lakeside lot`, `+15550100`.
- `src/` outside `src/ipc/` and the Electron host is Electron-free
  (`tests/electron-boundary.test.js`). New code under `src/` runs under
  `king-louie-service`.
- **No new native npm dependencies.** Pure-JS or WASM only, and each new dependency is
  named in the child spec with the reason. (Stage 1 ruled out native deps for the
  secrets backends; the rule holds for every stage.) A test in each stage that adds a
  dependency asserts the lockfile has no install scripts or native binaries for it.
- Tests: `node --test`, never Jest. Pass = `# fail 0`. E2E needs
  `unset ELECTRON_RUN_AS_NODE`.
- Logging through `createLogger` (`src/logging.js`); no bare `console.*`. Third-party
  libraries with their own loggers (pino via imapflow) are constructed with
  `logger: false`.
- Tool results are `{ ok: true, … }` / `{ ok: false, error }`. ToolExecutor-level
  refusals are `{ success: false, error }`. Gate refusals are results, never throws.
- Security-relevant configuration is read only from the root/admin-owned config dir
  (`<configDir>/node.yaml`, `service.json`); the data dir is service-writable and
  never decides policy. `service.json` and `node.yaml` reject unknown keys with the key
  path named (R11, R55).
- Trust principle 3 (fleet §3.1): remote-origin unsafe actions run only with a fresh,
  single-use phone signature over the exact action. No setting, token or "remember
  this" stands in for it. The one exception is the computer-use lease (F5).
- Approval requesters return `true | false | 'timeout' | 'unavailable'`; only `=== true`
  approves. Truthy strings never do.
- Cases principle 5: nothing inferred leaves. Every outbound payload passes the
  outbound gate (§4.9). Cross-case reads never return the text of a non-disclosable fact.
- Case facts are append-only; `facts.jsonl` is written only by `FactLedger`. Only
  `user` provenance is host-verified; `external-agent` provenance is written only by
  the executor results path (R40); `sourced` is model-declared.
- Journal files are `YYYY-MM-DD-HHMM-<kind>.md` (`src/cases/records.js` `stamp()`).
- Commit trailer for every commit in this program: whatever the executing session's
  attribution reminder says. Never substitute another model's line.

Stage 2 spec constraints:

- No new npm dependency. `settings.cases.*` is the only settings namespace this stage adds; no env vars, no `node.yaml` or `service.json` keys.
- Defaults (`settings.cases`): `reorientAfterHours: 8`, `timeZone: ''`, `budgets: { usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null }`, `roles: { orient: fast, classify: fast, draft: standard, judge: smart, verify: smart }` (as `{ tier }`), `wakeups: { enabled: true, dailyAt: '09:00', maxIterations: 20, maxCasesPerTick: 3, retryBackoffMinutes: [5, 15, 60] }`.
- Wake-up turns: `denyAutoApproval: true`, no approval requester, `allowedToolNames = CASE_TOOL_NAMES ∪ ['Read', 'Glob', 'Grep']`, `ownerMessages: []`, `prompter: casePrompter(null)`, `failoverPolicy: NO_RETRY`. No `WebFetch`/`WebSearch`.
- `CASE_TOOL_NAMES = ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']`. New tools declare `requiresApproval: false`.
- Budget effects come only from `question` or `owner-action` facts. A `user-message` budget fact is recorded but changes no limit.
- Every transition to `active` is refused with `BUDGET_EXHAUSTED` (`Raise the <category> budget first.`) while `usd` or `deadline` is at 100 %.
- `case:changed` payload: `{ caseId, what: 'questions'|'status'|'budget', questionId?, attention? }`; `attention` is `panel` for `low`, `banner` for `normal` and `high`, and `high` also sends a UI toast.
- Shared files: one additive hunk per insertion point, at the anchor text quoted in each task. Only this stage edits the case-turn block of `src/ipc/chat-handlers.js`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and where each is pinned:

1. **A wake-up fires while the owner is mid-turn.** Task 13 (`tests/cases-turn-runner.test.js`, "skips a case whose owner is mid-turn, then runs it after endTurn"): no turn, no write, no commit; the next tick after `endTurn` runs it.
2. **The clock jumps.** Part 1, Tasks 2, 3 and 6; here, Task 10 ("a future lastOwnerTurnAt raises no gap") through the runtime.
3. **The budget limit is lowered below spend.** Task 18 (F12 variant, "a limit lowered below spend pauses the case on the next turn").
4. **A question is answered twice from two surfaces.** Part 1, Task 5; here, Task 11 ("answerQuestion twice returns ALREADY_ANSWERED and writes one fact") and Task 16 (IPC).
5. **The `orient` provider is down.** Task 13 ("orient provider down: failed, backoff, one briefing on the third failure, no judge call").

## Interfaces from other stages

| Contract | Exact shape consumed | Stub in tests until it merges |
|---|---|---|
| C3 `ExecutorRegistry.cancelOpenJobs(caseId, reason)` (spec §3.1) | `host.getExecutorRegistry?.()?.cancelOpenJobs?.(caseId, reason)`, may return a promise; errors are logged | Task 10: `host.getExecutorRegistry = () => ({ cancelOpenJobs: (id, reason) => calls.push([id, reason]) })` |
| C3 `registry.pollWakeup(caseId, wakeup)` (R48, spec §5.3) | `→ Promise<{ material: boolean }>`; a turn runs only on `material: true` | Task 13: `{ pollWakeup: async () => ({ material: true }) }` and `({ material: false })` |
| C3 `.kl/executors.json`, `.kl/plan.json` (program §4.7) | read with `readJson`, absent → `null` (triggers inert) | Task 10 writes a literal `.kl/executors.json` |
| C5 `CaseRuntime.prototype.caseTypeMaterial(id)` (spec §5.3) | optional; `→ { [field]: value }`, stored as `.kl/triggers.json` `caseTypeMaterial` | Task 10: `runtime.caseTypeMaterial = () => ({ branch: 'main' })` |
| C5 owner-message hooks (R33) | `addTurnStartHook(name, fn, { phase: 'owner-message' })`, run by `runOwnerMessageHooks(turn)` | Task 10 registers a test hook |
| C6 `playbookChanges(id)`, `acknowledgePlaybooks(id)`, `playbookSafeDefaults(id)` | optional methods on the runtime instance | Tasks 10 and 12 assign them on the instance |
| F7 `host.interactive` (R50) | a function `() => boolean` | Tasks 10, 14: `interactive: () => true` / `() => false` |

## Deviations and resolved gaps (read before starting)

1. **Unpriced usage.** `UsageTracker.record` returns `cost: null` when no price table covers the provider (not `0`, as spec §3.5 writes). `usageHook` treats `cost === null` as unpriced and adds `totalTokens` to `usd.unpricedTokens`.
2. **The orient call's cost.** Providers' `sendMessage` returns plain text with no `llmMetrics`, so the one-shot orient call is charged only when the provider returns an object with `llmMetrics`. The judge loop, which is where the cost is, is always charged.
3. **Baseline refresh at a clean `endTurn`** uses the executor material and budget crossings captured at `beginTurn`, not the state at `endTurn`, so a threshold crossed during the turn still fires on the next one.
4. **Hook-trigger acknowledgement.** `Reorient` adds the turn's hook-trigger keys to `acknowledgedKeys`; a clean `endTurn` prunes `acknowledgedKeys` to the keys hooks still raised this turn, so a key that stops and later starts again fires again.
5. **`caseTypeMaterial`** is written to the baseline from `runtime.caseTypeMaterial?.(id)`; C5's own hook compares it (C5 spec §3.7), so `detectTriggers` does not.
6. **Deadline grant.** A `budget-grant` question for `deadline` asks for a new date; an answer counts as a grant only when it contains a `YYYY-MM-DD` later than the current deadline.
7. **`Ask` refuses `about.subject` `budget` or `direction`.** Otherwise a model-written question could route the owner's answer into a budget grant or a direction.
8. **`createQuestion(id, record, { charge })`** (C5 §3.9) returns `{ held: true }` without creating the record when `charge` is true and `questionsPerDay` is at 100 %. `Ask` turns that into a refusal.
9. **Existing stage-1 tests change in three places:** `Decide`, `Recommend` and `Fail` need a registered turn (`requireReoriented` refuses without one), so the test helpers `setup` (`tests/cases-tools.test.js`) and `openCase` (`tests/cases-regressions.test.js`) begin a turn; `Recommend` on a draft is refused by the status rule, whose text names the gating pass; `mergeSettings({}).cases` now carries the stage-2 defaults.
10. **Commit failures** are counted in `.kl/triggers.json` `commitFailures`. A non-zero count is reset to 0 just before `commitAll`, so a successful commit includes the reset and leaves a clean tree.
11. **`case:budget`** returns `{ ok, budget, case: { id, title, status, statusReason } }` so the panel needs one call for the status line and the budget line.
12. **`answerQuestion`** returns `{ question, fact, effect }`; the spec does not pin a return value.
13. New `CaseRuntime` helpers beyond spec §5.2: `settings()`, `budget(id)`, `wakeups(id)`, `questions(id)`, `ensureDefaultWakeups(id)`, `recordReorientation(id, turn, entry)`, `recordFailure(id, report)`, `grantBudget(id, category, limit)`, `sweep(id, now)`.
14. **Renderer hunks.** `renderer.js` gets one block of new functions plus three one-line call sites (Chat Info case section, chat switch, first load); the bar needs a refresh on chat switch and there is no event to hang it on.

---

### Task 10: The runtime core — status, turns, triggers, hooks, budgets and question creation

**Files:**
- Create: `src/cases/defaults.js`
- Modify: `src/cases/case-runtime.js` (replace the whole file; C2 owns it, program §5)
- Test: `tests/cases-runtime-unattended.test.js`

**Interfaces:**
- Consumes (Part 1): `canTransition`, `check`, `StatusError`, `AUTONOMY_KEY` (`status.js`); `Budget`, `CATEGORIES` (`budget.js`); `WakeupStore` (`wakeups.js`); `QuestionStore` (`questions.js`); `detectTriggers`, `emptyBaseline`, `underminedKeys` (`triggers.js`); `readJson`, `writeJsonIfChanged` (`jsonfile.js`); `buildOrientation` with its stage-2 inputs.
- Produces:
  - `defaults.js`: `CASE_SETTINGS_DEFAULTS`, `mergeCaseSettings(base, source)`, `resolveCaseSettings(source)`.
  - `CaseRuntime` constructor `{ root, staleLockMs, orientationMaxChars, getSettings, now, host }`; `now()`, `settings()`, `budget(id)`, `wakeups(id)`, `questions(id)`, `orientation(id, { triggers, hookNotes })`, `completeGating(id)` (now through `setStatus`), `setStatus(id, status, { kind, by, ref, note, failureClass }) → meta`, `assertWritable(id, op)`, `autonomyAllows(id, action)`, `requireReoriented(id)`, `ensureDefaultWakeups(id)`, `addTurnStartHook(name, fn, { phase })`, `runOwnerMessageHooks(turn) → { notes, triggers, orientation }`, `recordReorientation(id, turn, { changed, affects, action, note }) → journalPath`, `beginTurn(id, { turnId, source, ownerMessage }) → turn`, `caseContext(turn, { ownerMessages, ownerMessageTimes })`, `endTurn(turn, { summary, journal, journalKind })`, `systemAction(id, label, fn, { commitMessage })`, `onCrossings(id, category, crossedNow)`, `usageHook(turn) → (usageEvent) => void`, `createQuestion(id, record, { charge }) → record | { held: true }`, `abortUnattended()`; `this.turns: Map<caseId, turn>`.
  - A `turn` is `{ caseId, dir, turnId, title, orientation, source, ownerMessage, triggers, reorientPending, hookTriggers, hookNotes, snapshot, dailyTurnsSpent, signal, abort(reason) }`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-runtime-unattended.test.js`:

```js
// tests/cases-runtime-unattended.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { addSink } = require('../src/logging');
const { CaseRuntime, CaseBusyError } = require('../src/cases');
const { StatusError } = require('../src/cases/status');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-unattended-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const HOUR = 3600000;
const commitCount = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();
const readBaseline = (c) => JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'triggers.json'), 'utf8'));
const advance = (clock, ms) => { clock.now = new Date(clock.now.getTime() + ms); };

function makeRuntime({ settings = {}, host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T12:00:00.000Z') };
  const events = [];
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases: { timeZone: 'UTC', ...settings } }),
    host: { notify: (e, p) => events.push([e, p]), interactive: () => true, ...host }
  });
  return { rt, clock, events };
}

async function activeCase(rt, title = 'Lakeside lot') {
  const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
  rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

describe('setStatus', () => {
  it('records the reason, notifies, and runs the status side effects', async () => {
    const { rt, events } = makeRuntime();
    const c = await activeCase(rt);
    assert.strictEqual(c.status, 'active');
    assert.deepStrictEqual(c.statusReason, { kind: 'gating', by: 'runtime', ref: null, note: '', failureClass: null, at: '2026-09-23T12:00:00.000Z' });
    assert.deepStrictEqual(rt.wakeups(c.id).list().map((w) => w.kind), ['daily-orientation'], 'active registers the daily wake-up');
    const paused = rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner', note: 'on holiday' });
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.statusReason.note, 'on holiday');
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.caseId === c.id && p.what === 'status'));
    rt.setStatus(c.id, 'active', { kind: 'owner', by: 'owner' });
    rt.setStatus(c.id, 'done', { kind: 'owner', by: 'owner' });
    assert.deepStrictEqual(rt.wakeups(c.id).list(), [], 'done cancels every wake-up');
    assert.throws(() => rt.setStatus(c.id, 'active', { kind: 'owner', by: 'owner' }), (err) => err instanceof StatusError && err.code === 'BAD_TRANSITION');
  });

  it('lifts only a budget pause with a grant', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.throws(() => rt.setStatus(c.id, 'active', { kind: 'budget-grant' }), /budget pause/);
  });

  it('refuses every path to active while usd is at 100 %', async () => {
    const { rt } = makeRuntime();
    const exhausted = (err) => err instanceof StatusError && err.code === 'BUDGET_EXHAUSTED' && err.message === 'Raise the usd budget first.';

    const draft = await rt.createCase({ title: 'Draft lot', objective: 'Sell' });
    rt.store.updateMeta(draft.id, { budget: { usd: 1 } });
    rt.budget(draft.id).charge('usd', 1);
    rt.brief(draft.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(draft.id).append('successCriteria', 'Sold', { provenance: 'model' });
    assert.throws(() => rt.completeGating(draft.id), exhausted);
    assert.strictEqual(rt.getCase(draft.id).status, 'draft');

    const waiting = await activeCase(rt, 'Direction lot');
    rt.setStatus(waiting.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    rt.store.updateMeta(waiting.id, { budget: { usd: 1 } });
    rt.budget(waiting.id).charge('usd', 1);
    assert.throws(() => rt.setStatus(waiting.id, 'active', { kind: 'direction', ref: 'f-0001' }), exhausted);

    const spent = await activeCase(rt, 'Paused lot');
    rt.store.updateMeta(spent.id, { budget: { usd: 1 } });
    rt.onCrossings(spent.id, 'usd', rt.budget(spent.id).charge('usd', 1).crossedNow);
    assert.strictEqual(rt.getCase(spent.id).status, 'paused');
    assert.throws(() => rt.setStatus(spent.id, 'active', { kind: 'owner', by: 'owner' }), exhausted);
    assert.throws(() => rt.setStatus(spent.id, 'active', { kind: 'budget-grant' }), exhausted);
  });

  it('aborts a running wake-up turn and cancels open executor jobs (C3 stub) on pause', async () => {
    const calls = [];
    const { rt } = makeRuntime({ host: { getExecutorRegistry: () => ({ cancelOpenJobs: (id, reason) => { calls.push([id, reason]); } }) } });
    const c = await activeCase(rt);
    const turn = await rt.beginTurn(c.id, { turnId: 'wakeup-1', source: 'wakeup' });
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual(turn.signal.aborted, true);
    assert.deepStrictEqual(calls, [[c.id, 'case paused']]);
    await rt.endTurn(turn, {});
  });
});

describe('assertWritable, requireReoriented and autonomyAllows', () => {
  it('reads case.yaml fresh, needs a registered turn, and honours the autonomy grant', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    assert.strictEqual(rt.assertWritable(c.id, 'Recommend'), null);
    rt.store.updateMeta(c.id, { status: 'done' });
    assert.deepStrictEqual(rt.assertWritable(c.id, 'Ledger.assert'), { ok: false, error: 'Case is done. It is read-only.' });
    rt.store.updateMeta(c.id, { status: 'active' });
    assert.match(rt.requireReoriented(c.id).error, /No case turn is running/);
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(rt.requireReoriented(c.id), null);
    await rt.endTurn(turn, {});

    rt.setStatus(c.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'executor-no-answer' });
    assert.strictEqual(rt.autonomyAllows(c.id, 'retry-within-envelope'), false);
    assert.strictEqual(rt.assertWritable(c.id, 'Executor.submit').ok, false);
    rt.store.updateMeta(c.id, { autonomy: { onExecutorNoAnswer: 'retry-within-envelope' } });
    assert.strictEqual(rt.autonomyAllows(c.id, 'retry-within-envelope'), true);
    assert.strictEqual(rt.assertWritable(c.id, 'Executor.submit'), null);
    assert.strictEqual(rt.assertWritable(c.id, 'Plan').ok, false);
  });
});

describe('turn-start and owner-message hooks', () => {
  it('runs hooks in order, notes them in the orientation, survives a throwing hook, and replaces a re-registered name', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const order = [];
    rt.addTurnStartHook('first', async () => { order.push('first'); return { notes: ['First note'] }; });
    rt.addTurnStartHook('broken', async () => { throw new Error('boom'); });
    rt.addTurnStartHook('first', async (ctx) => {
      order.push(`again:${ctx.source}:${ctx.turnId}:${ctx.ownerMessage}:${ctx.caseId === c.id}`);
      return { notes: ['Replaced note'] };
    });
    rt.addTurnStartHook('classify', async () => { order.push('classify'); return { notes: ['Classified'] }; }, { phase: 'owner-message' });
    const turn = await rt.beginTurn(c.id, { turnId: 't1', source: 'owner', ownerMessage: 'Any news?' });
    assert.deepStrictEqual(order, ['again:owner:t1:Any news?:true']);
    assert.match(turn.orientation, /## Since last turn\n- Turn-start hook broken failed: boom\n- Replaced note/);
    assert.doesNotMatch(turn.orientation, /First note/);
    const out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(order, ['again:owner:t1:Any news?:true', 'classify']);
    assert.match(out.orientation, /- Classified/);
    assert.strictEqual(turn.orientation, out.orientation);
    await rt.endTurn(turn, {});
    assert.throws(() => rt.addTurnStartHook('x', () => {}, { phase: 'later' }), /phase/);
  });

  it('a hook trigger blocks until Reorient, stays quiet while still raised, and fires again after it stops', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    let raise = true;
    rt.addTurnStartHook('detours', async () => (raise ? { triggers: [{ kind: 'detour', key: 'detour:msg-7', detail: 'The owner changed the subject.' }] } : {}));
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(t1.reorientPending, true);
    assert.match(rt.requireReoriented(c.id).error, /The owner changed the subject/);
    rt.recordReorientation(c.id, t1, { changed: 'Owner changed the subject', affects: [], action: 'continue', note: 'Nothing to adjust.' });
    assert.strictEqual(rt.requireReoriented(c.id), null);
    await rt.endTurn(t1, {});
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.strictEqual(t2.reorientPending, false, 'acknowledged while still raised');
    await rt.endTurn(t2, {});
    raise = false;
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't3' }), {});
    raise = true;
    const t4 = await rt.beginTurn(c.id, { turnId: 't4' });
    assert.strictEqual(t4.reorientPending, true, 'raised again after it stopped');
    await rt.endTurn(t4, {});
  });
});

describe('re-orientation through the runtime', () => {
  it('a time gap survives a turn without Reorient, and Reorient clears it', async () => {
    const { rt, clock } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-23T02:00:00.000Z' });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.kind), ['time-gap']);
    assert.match(t1.orientation, /## Re-orientation required/);
    await rt.endTurn(t1, {});
    assert.strictEqual(rt.getCase(c.id).lastOwnerTurnAt, '2026-09-23T02:00:00.000Z', 'not advanced');
    assert.strictEqual(rt.getCase(c.id).lastTurnAt, '2026-09-23T12:00:00.000Z');
    advance(clock, 60000);
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.kind), ['time-gap']);
    const journal = rt.recordReorientation(c.id, t2, { changed: 'Ten hours passed', affects: [], action: 'continue', note: 'Nothing changed.' });
    assert.strictEqual(journal, 'journal/2026-09-23-1201-reorient.md');
    assert.match(fs.readFileSync(path.join(c.dir, journal), 'utf8'), /# Re-orientation[\s\S]*Changed: Ten hours passed[\s\S]*Affects: none[\s\S]*Action: continue/);
    await rt.endTurn(t2, {});
    assert.strictEqual(rt.getCase(c.id).lastOwnerTurnAt, '2026-09-23T12:01:00.000Z');
    const t3 = await rt.beginTurn(c.id, { turnId: 't3' });
    assert.deepStrictEqual(t3.triggers, []);
    await rt.endTurn(t3, {});
  });

  it('wake-up turns never raise or reset the gap', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-22T00:00:00.000Z' });
    const w = await rt.beginTurn(c.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.deepStrictEqual(w.triggers, []);
    await rt.endTurn(w, { journal: 'quiet: nothing new', journalKind: 'wakeup' });
    const meta = rt.getCase(c.id);
    assert.strictEqual(meta.lastOwnerTurnAt, '2026-09-22T00:00:00.000Z');
    assert.strictEqual(meta.lastTurnAt, '2026-09-23T12:00:00.000Z');
    assert.match(rt.records(c.id).lastJournal().file, /-wakeup\.md$/);
  });

  it('a future lastOwnerTurnAt raises no gap', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-24T12:00:00.000Z' });
    const t = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t.triggers, []);
    await rt.endTurn(t, {});
  });

  it('a corrected fact under a decision triggers once, until Reorient baselines it', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const gis = rt.ledger(c.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    rt.records(c.id).recordDecision({ decision: 'Price off the GIS acreage', factIds: [gis.id] });
    rt.ledger(c.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => [t.kind, t.decisionIds]), [['decision-undermined', ['D-001']]]);
    rt.recordReorientation(c.id, t1, { changed: 'Acreage corrected', affects: ['D-001'], action: 'adjust', note: 'Reprice off the plat.' });
    await rt.endTurn(t1, {});
    assert.deepStrictEqual(readBaseline(c).undermined, [`D-001:${gis.id}`]);
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers, []);
    await rt.endTurn(t2, {});
  });

  it('baseline pruning lets 80 % fire again after a grant and on a new day', async () => {
    const { rt, clock } = makeRuntime({ settings: { budgets: { turnsPerDay: 5 }, reorientAfterHours: 48 } });
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 10 } });
    rt.budget(c.id).charge('usd', 8.5);
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.key), ['budget:usd:80']);
    rt.recordReorientation(c.id, t1, { changed: 'Spent 85 %', affects: [], action: 'continue', note: 'About 1.50 is left, enough to finish the listing.' });
    await rt.endTurn(t1, {});
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers, []);
    await rt.endTurn(t2, {});
    rt.store.updateMeta(c.id, { budget: { usd: 20 } });
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't3' }), {});
    assert.deepStrictEqual(readBaseline(c).budgetCrossed.usd, []);
    rt.budget(c.id).charge('usd', 8);
    const t4 = await rt.beginTurn(c.id, { turnId: 't4' });
    assert.deepStrictEqual(t4.triggers.map((t) => t.key), ['budget:usd:80', 'budget:turnsPerDay:80']);
    rt.recordReorientation(c.id, t4, { changed: 'Both budgets near their limits', affects: [], action: 'continue', note: 'About 3.50 and one turn are left today; worth finishing.' });
    await rt.endTurn(t4, {});

    advance(clock, 24 * HOUR);
    const t5 = await rt.beginTurn(c.id, { turnId: 't5' });
    assert.deepStrictEqual(t5.triggers, [], 'a new day prunes turnsPerDay');
    await rt.endTurn(t5, {});
    assert.deepStrictEqual(readBaseline(c).budgetCrossed.turnsPerDay, []);
    rt.budget(c.id).charge('turnsPerDay', 3);
    const t6 = await rt.beginTurn(c.id, { turnId: 't6' });
    assert.deepStrictEqual(t6.triggers.map((t) => t.key), ['budget:turnsPerDay:80', 'budget:turnsPerDay:100']);
    await rt.endTurn(t6, {});
  });

  it('executor-change and playbook-update come from the C3 file and the C6 method stubs', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const exe = path.join(c.dir, '.kl', 'executors.json');
    fs.writeFileSync(exe, JSON.stringify({ 'phone-agent': { stale: false, material: { openJobs: 1 } } }));
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't1' }), {});
    assert.deepStrictEqual(readBaseline(c).executorsMaterial, { 'phone-agent': { openJobs: 1 } }, 'a new executor joins silently');
    fs.writeFileSync(exe, JSON.stringify({ 'phone-agent': { stale: false, material: { openJobs: 2 } } }));
    let acknowledged = 0;
    rt.playbookChanges = () => [{ name: 'land-sale', from: 'v1', to: 'v2' }];
    rt.acknowledgePlaybooks = () => { acknowledged += 1; };
    rt.caseTypeMaterial = () => ({ branch: 'main' });
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.kind).sort(), ['executor-change', 'playbook-update']);
    rt.recordReorientation(c.id, t2, { changed: 'A job opened; the playbook moved on', affects: [], action: 'continue', note: 'Nothing to change.' });
    assert.strictEqual(acknowledged, 1);
    const baseline = readBaseline(c);
    assert.deepStrictEqual(baseline.executorsMaterial, { 'phone-agent': { openJobs: 2 } });
    assert.deepStrictEqual(baseline.caseTypeMaterial, { branch: 'main' });
    await rt.endTurn(t2, {});
  });
});

describe('commits and systemAction', () => {
  it('pauses with a high question after two consecutive commit failures, and one success resets the count', async (t) => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const real = git.commitAll;
    let fail = false;
    t.mock.method(git, 'commitAll', async (...args) => {
      if (fail) throw new Error('index.lock exists');
      return real(...args);
    });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    fail = true;
    await assert.rejects(rt.endTurn(t1, {}), /index\.lock exists/);
    assert.strictEqual(rt.getCase(c.id).status, 'active', 'one failure does not pause');
    assert.strictEqual(readBaseline(c).commitFailures, 1);
    fail = false;
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't2' }), {});
    assert.strictEqual(readBaseline(c).commitFailures, 0);
    assert.strictEqual(await git.isDirty(c.dir), false);

    const t3 = await rt.beginTurn(c.id, { turnId: 't3' });
    fail = true;
    await assert.rejects(rt.endTurn(t3, {}), /index\.lock exists/);
    assert.strictEqual(await rt.systemAction(c.id, 'sweep', async () => 'swept'), 'swept');
    const meta = rt.getCase(c.id);
    assert.strictEqual(meta.status, 'paused');
    assert.strictEqual(meta.statusReason.kind, 'commit');
    const [q] = rt.questions(c.id).open();
    assert.strictEqual(q.urgency, 'high');
    assert.deepStrictEqual([q.payload.type, q.payload.mcpAnswerable], ['commit-failed', false]);
    assert.strictEqual(q.text, 'Lakeside lot: the case repository could not be committed twice (index.lock exists). Fix the repository, then resume.');
  });

  it('commits its writes, runs inline under this process\'s turn, and refuses another process\'s lock', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    await rt.systemAction(c.id, 'warm-up', async () => {});
    const before = await commitCount(c.dir);
    const out = await rt.systemAction(c.id, 'note', async (meta) => {
      fs.writeFileSync(path.join(meta.dir, 'artifacts', 'note.txt'), 'x');
      return 42;
    });
    assert.strictEqual(out, 42);
    assert.strictEqual(await commitCount(c.dir), before + 1);
    assert.strictEqual(await lastSubject(c.dir), 'system: note');
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(await rt.systemAction(c.id, 'inline', async () => 'inline'), 'inline');
    assert.strictEqual(await lastSubject(c.dir), 'system: note', 'the turn commits inline writes, not systemAction');
    await rt.endTurn(turn, {});
    fs.writeFileSync(path.join(c.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    await assert.rejects(rt.systemAction(c.id, 'blocked', async () => {}), (err) => err instanceof CaseBusyError);
    fs.rmSync(path.join(c.dir, '.kl', 'lock'));
  });
});

describe('budgets and question creation', () => {
  it('pauses at 100 % of usd and asks for a grant once', async () => {
    const { rt, events } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    const hook = rt.usageHook(turn);
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 900, cost: 0.6 });
    assert.strictEqual(rt.getCase(c.id).status, 'active');
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 900, cost: 0.6 });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['paused', 'budget', 'usd']);
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 10, cost: 0.1 });
    const open = rt.questions(c.id).open();
    assert.strictEqual(open.length, 1);
    assert.deepStrictEqual([open[0].payload.type, open[0].payload.budget, open[0].payload.mcpAnswerable, open[0].urgency], ['budget-grant', 'usd', false, 'normal']);
    assert.strictEqual(open[0].text, 'Lakeside lot spent 1.2 of its 1 usd budget and is paused. Reply with a new limit to continue.');
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'questions' && p.attention === 'banner'));
    await rt.endTurn(turn, {});
  });

  it('counts unpriced usage as tokens, not dollars, and says so in the orientation', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    rt.usageHook(turn)({ provider: 'local', model: 'tiny', totalTokens: 1500, cost: null });
    const usd = rt.budget(c.id).status().usd;
    assert.deepStrictEqual([usd.spent, usd.unpricedTokens], [0, 1500]);
    assert.match(rt.orientation(c.id), /1500 tokens on providers with no price table are not counted against the \$ budget\./);
    await rt.endTurn(turn, {});
  });

  it('createQuestion charges questionsPerDay, holds at the cap, returns duplicates, and delivers in-app', async () => {
    const { rt, events } = makeRuntime({ settings: { budgets: { questionsPerDay: 1 } } });
    const c = await activeCase(rt);
    const toasts = [];
    rt.host.uiToast = { send: async (p) => { toasts.push(p); } };
    const q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'high' });
    assert.deepStrictEqual(q.deliveries, [{ channel: 'in-app', at: '2026-09-23T12:00:00.000Z', deliveryId: `in-app-${q.id}` }]);
    assert.ok(events.some(([, p]) => p.questionId === q.id && p.attention === 'banner'));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(toasts, [{ title: 'Lakeside lot', body: 'Is the well shared?' }]);
    assert.deepStrictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Who holds the easement?', urgency: 'normal' }), { held: true });
    const daily = rt.questions(c.id).open().find((r) => r.payload.type === 'budget-daily');
    assert.strictEqual(daily.urgency, 'low');
    assert.strictEqual(daily.kind, 'briefing');
    assert.ok(events.some(([, p]) => p.questionId === daily.id && p.attention === 'panel'));
    assert.strictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'high' }).id, q.id);
    assert.strictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Who holds the easement?', urgency: 'normal' }, { charge: false }).kind, 'question');
  });

  it('does not deliver without an interactive host, and logs the service-mode line', async () => {
    const { rt } = makeRuntime({ host: { interactive: () => false } });
    const c = await activeCase(rt);
    const lines = [];
    const remove = addSink((r) => lines.push(r.line));
    let q;
    try {
      q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    } finally {
      remove();
    }
    assert.deepStrictEqual(q.deliveries, []);
    assert.ok(lines.some((l) => l.includes(`Case lakeside-lot asks ${q.id} (normal): Is the well shared?. No channel can deliver it until stage 4; it waits.`)), lines.join('\n'));
  });
});

describe('turn registry', () => {
  it('caseContext carries the source and owner message times; abortUnattended aborts wake-ups only', async () => {
    const { rt } = makeRuntime();
    const a = await activeCase(rt, 'Lot A');
    const b = await activeCase(rt, 'Lot B');
    const owner = await rt.beginTurn(a.id, { turnId: 't-owner', ownerMessage: 'hi' });
    const ctx = rt.caseContext(owner, { ownerMessages: ['hi'], ownerMessageTimes: ['2026-09-23T11:59:00.000Z'] });
    assert.deepStrictEqual(
      [ctx.runtime === rt, ctx.caseId, ctx.dir, ctx.turnId, ctx.source, ctx.ownerMessages, ctx.ownerMessageTimes],
      [true, a.id, a.dir, 't-owner', 'owner', ['hi'], ['2026-09-23T11:59:00.000Z']]
    );
    const wake = await rt.beginTurn(b.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.strictEqual(rt.turns.size, 2);
    rt.abortUnattended();
    assert.strictEqual(wake.signal.aborted, true);
    assert.strictEqual(owner.signal.aborted, false);
    await rt.endTurn(owner, {});
    await rt.endTurn(wake, {});
    assert.strictEqual(rt.turns.size, 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-runtime-unattended.test.js`
Expected: FAIL — `records the reason, notifies…` fails because `c.statusReason` is `undefined`, and the other tests fail with `rt.setStatus is not a function` / `rt.budget is not a function`.

- [ ] **Step 3: Implement**

Create `src/cases/defaults.js`:

```js
// src/cases/defaults.js
// Stage 2 defaults for settings.cases (cases stage 2 spec §6), merged key by
// key so a partial override keeps the other defaults. None of these keys is
// security policy.
const CASE_SETTINGS_DEFAULTS = Object.freeze({
  root: '',
  reorientAfterHours: 8,
  timeZone: '',
  budgets: Object.freeze({ usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null }),
  roles: Object.freeze({
    orient: Object.freeze({ tier: 'fast' }),
    classify: Object.freeze({ tier: 'fast' }),
    draft: Object.freeze({ tier: 'standard' }),
    judge: Object.freeze({ tier: 'smart' }),
    verify: Object.freeze({ tier: 'smart' })
  }),
  wakeups: Object.freeze({
    enabled: true,
    dailyAt: '09:00',
    maxIterations: 20,
    maxCasesPerTick: 3,
    retryBackoffMinutes: Object.freeze([5, 15, 60])
  })
});

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Plain, unfrozen copies: settings objects are edited by the settings UI.
const fresh = () => JSON.parse(JSON.stringify(CASE_SETTINGS_DEFAULTS));

function mergeCaseSettings(base = {}, source = {}) {
  const d = fresh();
  const b = obj(base);
  const s = obj(source);
  return {
    ...d,
    ...b,
    ...s,
    budgets: { ...d.budgets, ...obj(b.budgets), ...obj(s.budgets) },
    roles: { ...d.roles, ...obj(b.roles), ...obj(s.roles) },
    wakeups: { ...d.wakeups, ...obj(b.wakeups), ...obj(s.wakeups) }
  };
}

const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const positiveInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// The merged settings with every value the runtime relies on made valid.
function resolveCaseSettings(source = {}) {
  const m = mergeCaseSettings({}, source);
  const d = CASE_SETTINGS_DEFAULTS;
  return {
    ...m,
    reorientAfterHours: positive(m.reorientAfterHours, d.reorientAfterHours),
    timeZone: typeof m.timeZone === 'string' ? m.timeZone : '',
    wakeups: {
      ...m.wakeups,
      enabled: m.wakeups.enabled !== false,
      dailyAt: typeof m.wakeups.dailyAt === 'string' ? m.wakeups.dailyAt : d.wakeups.dailyAt,
      maxIterations: positiveInt(m.wakeups.maxIterations, d.wakeups.maxIterations),
      maxCasesPerTick: positiveInt(m.wakeups.maxCasesPerTick, d.wakeups.maxCasesPerTick),
      retryBackoffMinutes: Array.isArray(m.wakeups.retryBackoffMinutes) ? m.wakeups.retryBackoffMinutes : [...d.wakeups.retryBackoffMinutes]
    }
  };
}

module.exports = { CASE_SETTINGS_DEFAULTS, mergeCaseSettings, resolveCaseSettings };
```

Replace the whole of `src/cases/case-runtime.js` with:

```js
// src/cases/case-runtime.js
// The one object core holds for cases: turn lifecycle, lock and commits
// (stage 1), plus the stage-2 machinery for unattended work: status,
// re-orientation triggers, turn hooks, budgets, questions and wake-ups
// (docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md §3.10).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');
const { CaseStore } = require('./case-store');
const { FactLedger } = require('./ledger');
const { Brief } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation, DEFAULT_MAX_CHARS } = require('./orientation');
const { canTransition, check: checkStatus, StatusError, AUTONOMY_KEY } = require('./status');
const { Budget, CATEGORIES } = require('./budget');
const { WakeupStore } = require('./wakeups');
const { QuestionStore } = require('./questions');
const { detectTriggers, emptyBaseline, underminedKeys } = require('./triggers');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { resolveCaseSettings } = require('./defaults');
const { createLogger } = require('../logging');

const log = createLogger('cases/runtime');

class CaseBusyError extends Error {
  constructor(title, { pid, lockPath } = {}) {
    const holder = pid ? ` in process ${pid}` : '';
    const recover = lockPath
      ? ` If that process is stuck or is not King Louie, quit it or delete ${lockPath}.`
      : '';
    super(`Case "${title}" is busy with another turn${holder}. Try again when it finishes.${recover}`);
    this.name = 'CaseBusyError';
    this.code = 'CASE_BUSY';
  }
}

class CaseNotFoundError extends Error {
  constructor(id) {
    super(`Case not found: ${id}`);
    this.name = 'CaseNotFoundError';
    this.code = 'CASE_NOT_FOUND';
  }
}

const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// settings.cases.root: `~` is the home dir and a relative path is under the
// data dir. KL_CASES_ROOT: `~` expanded; a relative path is left for the
// process cwd to resolve, as before.
function resolveCasesRoot({ settings, env = process.env, dataDir }) {
  const configured = settings?.cases?.root;
  if (typeof configured === 'string' && configured.trim()) {
    const root = expandHome(configured.trim());
    return path.isAbsolute(root) ? root : path.resolve(dataDir, root);
  }
  if (env && env.KL_CASES_ROOT) return expandHome(env.KL_CASES_ROOT);
  return path.join(dataDir, 'cases');
}

const oneLine = (s, max = 72) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(lock) {
  try {
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return held && typeof held === 'object' ? held : null;
  } catch {
    return null;
  }
}

const HOOK_PHASES = Object.freeze(['turn-start', 'owner-message']);
const STOPS_WORK = new Set(['paused', 'done', 'abandoned']);

class CaseRuntime {
  constructor({
    root, staleLockMs = 30 * 60 * 1000, orientationMaxChars = DEFAULT_MAX_CHARS, getSettings = null, now = null, host = null
  } = {}) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    this.orientationMaxChars = orientationMaxChars;
    // turnId -> { dir, timer }: the locks this runtime holds right now.
    this.held = new Map();
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._clock = typeof now === 'function' ? now : () => new Date();
    // Host services, all optional (spec §3.10): inferenceRouter,
    // resolveInference, createToolExecutor, toolRegistry, AgentLoop,
    // getUsageTracker, hasProviderToken, notify, uiToast, interactive,
    // getExecutorRegistry. Without them wake-ups and routed providers are off.
    this.host = host || null;
    // caseId -> the turn this process is running on that case.
    this.turns = new Map();
    this.hooks = [];
  }

  get root() {
    return this.store.root;
  }

  now() {
    return this._clock();
  }

  settings() {
    let raw = {};
    try {
      raw = this.getSettings()?.cases || {};
    } catch (err) {
      log.warn(`Reading case settings failed: ${err.message}`);
    }
    return resolveCaseSettings(raw);
  }

  // The wake-up sweep lists cases; a case still being created has no first commit yet,
  // so a sweep that commits it would make `create` fail with "nothing to commit".
  // `runDueWakeups` skips the whole tick while any creation is in flight.
  async createCase(opts) {
    this.creating = (this.creating || 0) + 1;
    try {
      return await this.store.create(opts);
    } finally {
      this.creating -= 1;
    }
  }

  listCases() {
    return this.store.list();
  }

  getCase(idOrSlug) {
    const c = this.store.get(idOrSlug);
    if (!c) throw new CaseNotFoundError(idOrSlug);
    return c;
  }

  ledger(id) { return new FactLedger(this.getCase(id).dir); }

  brief(id) { return new Brief(this.getCase(id).dir); }

  records(id) { return new CaseRecords(this.getCase(id).dir); }

  budget(id) {
    const meta = this.getCase(id);
    const cfg = this.settings();
    return new Budget(meta.dir, {
      defaults: cfg.budgets,
      overrides: meta.budget && typeof meta.budget === 'object' ? meta.budget : {},
      createdAt: meta.created,
      now: () => this.now(),
      timeZone: cfg.timeZone
    });
  }

  wakeups(id) {
    const meta = this.getCase(id);
    const cfg = this.settings();
    return new WakeupStore(meta.dir, {
      now: () => this.now(),
      timeZone: cfg.timeZone,
      dailyAt: cfg.wakeups.dailyAt,
      backoffMinutes: cfg.wakeups.retryBackoffMinutes
    });
  }

  questions(id) {
    const meta = this.getCase(id);
    return new QuestionStore(meta.dir, { now: () => this.now(), caseId: meta.id });
  }

  orientation(id, { triggers = [], hookNotes = [] } = {}) {
    const meta = this.getCase(id);
    const { facts, errors } = new FactLedger(meta.dir).view();
    let brief;
    try {
      brief = { data: new Brief(meta.dir).read().data };
    } catch (err) {
      brief = { error: err.message };
    }
    const records = new CaseRecords(meta.dir);
    const safely = (label, fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        log.warn(`Orientation for ${meta.slug}: ${label} unavailable: ${err.message}`);
        return fallback;
      }
    };
    const budget = safely('budget', () => this.budget(meta.id).status(), null);
    const questions = safely('questions', () => this.questions(meta.id).open(), []);
    const nextWakeup = safely('wake-ups', () => this.wakeups(meta.id).list()
      .slice()
      .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))[0] || null, null);
    return buildOrientation({
      meta,
      brief,
      facts,
      decisions: records.decisions(),
      lastJournal: records.lastJournal(),
      ledgerErrors: errors,
      maxChars: this.orientationMaxChars,
      triggers,
      hookNotes,
      statusReason: meta.statusReason || null,
      failure: this._failureReport(meta),
      questions,
      budget,
      nextWakeup,
      now: this.now()
    });
  }

  _failureReport(meta) {
    const ref = meta.status === 'needs-direction' ? meta.statusReason?.ref : null;
    if (typeof ref !== 'string' || !ref) return null;
    const base = path.resolve(meta.dir);
    const file = path.resolve(base, ref);
    if (!file.startsWith(base + path.sep)) return null;
    try {
      return { file: ref, text: fs.readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  otherCaseFacts(id) {
    const self = this.getCase(id);
    return this.listCases()
      .filter((c) => c.id !== self.id)
      .map((c) => ({ caseId: c.id, title: c.title, facts: new FactLedger(c.dir).view().facts }));
  }

  completeGating(id) {
    const meta = this.getCase(id);
    new Brief(meta.dir).completeGating();
    if (meta.status === 'draft') this.setStatus(meta.id, 'active', { kind: 'gating' });
    return this.getCase(meta.id);
  }

  // ---- Status (spec §3.1) ----

  setStatus(id, status, { kind, by = 'runtime', ref = null, note = '', failureClass = null } = {}) {
    const meta = this.getCase(id);
    if (!canTransition(meta.status, status, by, kind)) {
      throw new StatusError('BAD_TRANSITION', `A case cannot go from ${meta.status} to ${status} (${by}, ${kind || 'no reason'}).`);
    }
    if (status === 'active' && kind === 'budget-grant' && meta.statusReason?.kind !== 'budget') {
      throw new StatusError('BAD_TRANSITION', 'A budget grant lifts only a budget pause.');
    }
    if (status === 'active') {
      const exhausted = this.budget(meta.id).exhausted();
      if (exhausted.length) throw new StatusError('BUDGET_EXHAUSTED', `Raise the ${exhausted[0]} budget first.`);
    }
    const statusReason = {
      kind,
      by,
      ref: ref ?? null,
      note: String(note || ''),
      failureClass: failureClass ?? null,
      at: this.now().toISOString()
    };
    const updated = this.store.updateMeta(meta.id, { status, statusReason });
    this._notify('case:changed', { caseId: meta.id, what: 'status' });
    if (STOPS_WORK.has(status)) {
      this._abortTurn(meta.id, `case ${status}`);
      this._cancelExecutorJobs(meta.id, `case ${status}`);
    }
    if (status === 'done' || status === 'abandoned') this.wakeups(meta.id).cancelAll();
    if (status === 'active') this.ensureDefaultWakeups(meta.id);
    return updated;
  }

  assertWritable(id, op) {
    const meta = this.getCase(id);
    return checkStatus(meta.status, op, {
      autonomyAllows: this.autonomyAllows(meta.id, 'retry-within-envelope'),
      reason: meta.statusReason || null
    });
  }

  autonomyAllows(id, action) {
    const meta = this.getCase(id);
    if (meta.status !== 'needs-direction') return false;
    const key = AUTONOMY_KEY[meta.statusReason?.failureClass];
    return Boolean(key) && meta.autonomy?.[key] === action;
  }

  requireReoriented(id) {
    const meta = this.getCase(id);
    const turn = this.turns.get(meta.id);
    if (!turn) {
      return { ok: false, error: 'No case turn is running for this case, so re-orientation cannot be checked. Run this inside a case turn.' };
    }
    if (turn.reorientPending) {
      const pending = (turn.triggers || []).filter((t) => t.blocking).map((t) => t.detail).join(' ');
      return { ok: false, error: `Re-orientation is required first: ${pending} Call Reorient before Recommend, Decide or Fail.` };
    }
    return null;
  }

  ensureDefaultWakeups(id) {
    const meta = this.getCase(id);
    const store = this.wakeups(meta.id);
    store.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } });
    if (this.budget(meta.id).limitFor('deadline')) {
      store.ensure('deadline-check', { every: 86400000, payload: { key: 'deadline' } });
    }
  }

  _notify(event, payload) {
    try {
      if (typeof this.host?.notify === 'function') this.host.notify(event, payload);
    } catch (err) {
      log.warn(`Notifying ${event} failed: ${err.message}`);
    }
  }

  _abortTurn(caseId, reason) {
    const turn = this.turns.get(caseId);
    if (turn && turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
  }

  _cancelExecutorJobs(caseId, reason) {
    try {
      const registry = typeof this.host?.getExecutorRegistry === 'function' ? this.host.getExecutorRegistry() : null;
      if (registry && typeof registry.cancelOpenJobs === 'function') {
        Promise.resolve(registry.cancelOpenJobs(caseId, reason))
          .catch((err) => log.warn(`Cancelling executor jobs for ${caseId} failed: ${err.message}`));
      }
    } catch (err) {
      log.warn(`Cancelling executor jobs for ${caseId} failed: ${err.message}`);
    }
  }

  // ---- Lock ----

  _lockPath(dir) {
    return path.join(dir, '.kl', 'lock');
  }

  _acquire(meta, turnId) {
    const lock = this._lockPath(meta.dir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ turnId, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        this._hold(meta.dir, turnId);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = readLock(lock);
        const stale = this._staleReason(lock, holder);
        if (attempt === 0 && stale) {
          log.warn(`Reclaiming stale lock on case ${meta.slug} (${stale})`);
          fs.rmSync(lock, { force: true });
          continue;
        }
        throw new CaseBusyError(meta.title, { pid: holder?.pid, lockPath: lock });
      }
    }
  }

  // Why an existing lock can be taken over, or null while its holder is live.
  _staleReason(lock, holder) {
    if (holder && Number.isInteger(holder.pid)) {
      if (holder.pid === process.pid) {
        if (!this.held.has(holder.turnId)) return 'left by an earlier turn in this process';
      } else if (!pidAlive(holder.pid)) {
        return `process ${holder.pid} is gone`;
      }
    }
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > this.staleLockMs) return `${Math.round(age / 60000)} min old`;
    return null;
  }

  // Keep the held lock's mtime fresh so a long turn never looks stale.
  _hold(dir, turnId) {
    const lock = this._lockPath(dir);
    const timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(lock, now, now);
      } catch (err) {
        log.warn(`Could not refresh lock in ${dir}: ${err.message}`);
      }
    }, Math.max(10, Math.floor(this.staleLockMs / 3)));
    timer.unref?.();
    this.held.set(turnId, { dir, timer });
  }

  _holdsLock(dir) {
    for (const h of this.held.values()) if (h.dir === dir) return true;
    return false;
  }

  releaseAll() {
    for (const [turnId, { dir }] of [...this.held]) this._release(dir, turnId);
    this.turns.clear();
  }

  _release(dir, turnId) {
    const entry = this.held.get(turnId);
    if (entry && entry.dir === dir) {
      clearInterval(entry.timer);
      this.held.delete(turnId);
    }
    const lock = this._lockPath(dir);
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (held.turnId === turnId) fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not release lock in ${dir}: ${err.message}`);
    }
  }

  // ---- Turn hooks (spec §3.3, program §4.20) ----

  addTurnStartHook(name, fn, { phase = 'turn-start' } = {}) {
    if (typeof name !== 'string' || !name) throw new Error('addTurnStartHook needs a name.');
    if (typeof fn !== 'function') throw new Error('addTurnStartHook needs a function.');
    if (!HOOK_PHASES.includes(phase)) throw new Error(`Unknown hook phase "${phase}". Phases: ${HOOK_PHASES.join(', ')}.`);
    this.hooks = this.hooks.filter((h) => h.name !== name);
    this.hooks.push({ name, fn, phase });
  }

  async _runHooks(phase, { caseId, dir, turnId, source, ownerMessage }) {
    const notes = [];
    const triggers = [];
    for (const hook of this.hooks.filter((h) => h.phase === phase)) {
      try {
        const out = await hook.fn({
          runtime: this, caseId, dir, meta: this.getCase(caseId), turnId, source, ownerMessage, now: this.now()
        });
        if (Array.isArray(out?.notes)) notes.push(...out.notes.map(String));
        if (Array.isArray(out?.triggers)) {
          triggers.push(...out.triggers.filter((t) => t && typeof t.kind === 'string' && typeof t.key === 'string'));
        }
      } catch (err) {
        log.warn(`Turn-start hook ${hook.name} failed on case ${caseId}: ${err.message}`);
        notes.push(`Turn-start hook ${hook.name} failed: ${err.message}`);
      }
    }
    return { notes, triggers };
  }

  async runOwnerMessageHooks(turn) {
    const hook = await this._runHooks('owner-message', {
      caseId: turn.caseId, dir: turn.dir, turnId: turn.turnId, source: turn.source, ownerMessage: turn.ownerMessage
    });
    if (!hook.notes.length && !hook.triggers.length) return { notes: [], triggers: [], orientation: turn.orientation };
    const baseline = this._baseline(turn.dir);
    const fresh = hook.triggers
      .filter((t) => !baseline.acknowledgedKeys.includes(t.key))
      .map((t) => ({ ...t, blocking: t.blocking !== false, detail: String(t.detail || t.kind) }));
    turn.hookTriggers = [...(turn.hookTriggers || []), ...hook.triggers];
    turn.hookNotes = [...(turn.hookNotes || []), ...hook.notes];
    turn.triggers = [...(turn.triggers || []), ...fresh];
    if (fresh.some((t) => t.blocking)) turn.reorientPending = true;
    turn.orientation = this.orientation(turn.caseId, { triggers: turn.triggers, hookNotes: turn.hookNotes });
    return { notes: hook.notes, triggers: fresh, orientation: turn.orientation };
  }

  // ---- Triggers and the baseline (.kl/triggers.json) ----

  _baselinePath(dir) {
    return path.join(dir, '.kl', 'triggers.json');
  }

  _baseline(dir) {
    const stored = readJson(this._baselinePath(dir), null);
    return { ...emptyBaseline(), ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  _materialSnapshot(meta) {
    const executors = readJson(path.join(meta.dir, '.kl', 'executors.json'), null);
    const executorsMaterial = {};
    if (executors && typeof executors === 'object') {
      for (const [eid, entry] of Object.entries(executors)) {
        if (entry && !entry.stale) executorsMaterial[eid] = entry.material ?? null;
      }
    }
    const budget = this.budget(meta.id).status();
    const budgetCrossed = {};
    for (const c of CATEGORIES) budgetCrossed[c] = [...(budget[c]?.crossed || [])];
    let caseTypeMaterial = null;
    if (typeof this.caseTypeMaterial === 'function') {
      try {
        caseTypeMaterial = this.caseTypeMaterial(meta.id) || null;
      } catch (err) {
        log.warn(`caseTypeMaterial failed for ${meta.slug}: ${err.message}`);
      }
    }
    return { executors, executorsMaterial, budget, budgetCrossed, caseTypeMaterial };
  }

  _detect(meta, { source, hookTriggers = [] }) {
    const baseline = this._baseline(meta.dir);
    const snap = this._materialSnapshot(meta);
    // A threshold that a grant, a raised limit or a new day removed can fire
    // again later: prune it from the baseline (spec §3.3).
    let pruned = false;
    for (const c of Object.keys(baseline.budgetCrossed || {})) {
      const was = Array.isArray(baseline.budgetCrossed[c]) ? baseline.budgetCrossed[c] : [];
      const keep = was.filter((t) => (snap.budgetCrossed[c] || []).includes(t));
      if (keep.length !== was.length) {
        baseline.budgetCrossed[c] = keep;
        pruned = true;
      }
    }
    if (pruned) writeJsonIfChanged(this._baselinePath(meta.dir), baseline);
    let playbookChanges = [];
    if (typeof this.playbookChanges === 'function') {
      try {
        playbookChanges = this.playbookChanges(meta.id) || [];
      } catch (err) {
        log.warn(`playbookChanges failed for ${meta.slug}: ${err.message}`);
      }
    }
    const triggers = detectTriggers({
      source,
      now: this.now(),
      meta,
      facts: new FactLedger(meta.dir).view().facts,
      decisions: new CaseRecords(meta.dir).decisions(),
      budget: snap.budget,
      executors: snap.executors,
      plan: readJson(path.join(meta.dir, '.kl', 'plan.json'), null),
      playbookChanges,
      hookTriggers,
      baseline,
      reorientAfterHours: this.settings().reorientAfterHours
    });
    return {
      triggers,
      snapshot: { executorsMaterial: snap.executorsMaterial, budgetCrossed: snap.budgetCrossed, caseTypeMaterial: snap.caseTypeMaterial }
    };
  }

  // What the Reorient tool records: a journal entry, and a baseline that
  // acknowledges everything pending now.
  recordReorientation(id, turn, { changed, affects = [], action, note }) {
    const meta = this.getCase(id);
    const pending = (turn.triggers || []).filter((t) => t.blocking);
    const body = [
      '# Re-orientation',
      '',
      'Triggers:',
      ...(pending.length ? pending.map((t) => `- ${t.detail}`) : ['- none']),
      '',
      `Changed: ${changed}`,
      `Affects: ${affects.length ? affects.join(', ') : 'none'}`,
      `Action: ${action}`,
      `Note: ${note}`
    ].join('\n');
    const journal = new CaseRecords(meta.dir).writeJournal('reorient', body, this.now());
    const snap = this._materialSnapshot(meta);
    const b = this._baseline(meta.dir);
    b.acknowledgedAt = this.now().toISOString();
    b.undermined = underminedKeys(new CaseRecords(meta.dir).decisions(), new FactLedger(meta.dir).view().facts).map((u) => u.key);
    b.executorsMaterial = snap.executorsMaterial;
    b.budgetCrossed = snap.budgetCrossed;
    b.acknowledgedKeys = [...new Set([...(b.acknowledgedKeys || []), ...(turn.hookTriggers || []).map((t) => t.key)])];
    if (snap.caseTypeMaterial) b.caseTypeMaterial = snap.caseTypeMaterial;
    writeJsonIfChanged(this._baselinePath(meta.dir), b);
    if (typeof this.acknowledgePlaybooks === 'function') {
      try {
        this.acknowledgePlaybooks(meta.id);
      } catch (err) {
        log.warn(`acknowledgePlaybooks failed for ${meta.slug}: ${err.message}`);
      }
    }
    turn.reorientPending = false;
    return journal;
  }

  // ---- Turns (spec §3.10) ----

  async beginTurn(id, { turnId, source = 'owner', ownerMessage = null } = {}) {
    const meta = this.getCase(id);
    this._acquire(meta, turnId);
    try {
      if (await git.isDirty(meta.dir)) await this._commit(meta.dir, 'owner edits', meta.id);
      const budget = this.budget(meta.id);
      for (const [category, crossed] of Object.entries(budget.reconcile())) this.onCrossings(meta.id, category, crossed);
      // A wake-up is refused before charging once the day's turns are spent;
      // owner turns are always charged and never refused.
      let dailyTurnsSpent = false;
      if (source === 'wakeup' && budget.atLimit('turnsPerDay')) {
        dailyTurnsSpent = true;
      } else {
        const r = budget.charge('turnsPerDay', 1, { turnId });
        if (r.crossedNow.length) this.onCrossings(meta.id, 'turnsPerDay', r.crossedNow);
      }
      const hook = await this._runHooks('turn-start', { caseId: meta.id, dir: meta.dir, turnId, source, ownerMessage });
      const fresh = this.getCase(meta.id);
      const { triggers, snapshot } = this._detect(fresh, { source, hookTriggers: hook.triggers });
      const controller = new AbortController();
      const turn = {
        caseId: fresh.id,
        dir: fresh.dir,
        turnId,
        title: fresh.title,
        orientation: '',
        source,
        ownerMessage,
        triggers,
        reorientPending: triggers.some((t) => t.blocking),
        hookTriggers: hook.triggers,
        hookNotes: hook.notes,
        snapshot,
        dailyTurnsSpent,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason)
      };
      turn.orientation = this.orientation(fresh.id, { triggers, hookNotes: hook.notes });
      this.turns.set(fresh.id, turn);
      return turn;
    } catch (err) {
      this._release(meta.dir, turnId);
      throw err;
    }
  }

  caseContext(turn, { ownerMessages = [], ownerMessageTimes = [] } = {}) {
    return {
      caseId: turn.caseId,
      dir: turn.dir,
      turnId: turn.turnId,
      title: turn.title,
      orientation: turn.orientation,
      source: turn.source || 'owner',
      runtime: this,
      ownerMessages,
      ownerMessageTimes
    };
  }

  async endTurn(turn, { summary = '', journal = null, journalKind = 'turn' } = {}) {
    try {
      const records = new CaseRecords(turn.dir);
      records.renderOpenItems(new FactLedger(turn.dir).view().facts);
      if (journal && String(journal).trim()) records.writeJournal(journalKind, journal, this.now());
      this._closeTurnMeta(turn);
      return await this._commit(turn.dir, `${turn.turnId}: ${oneLine(summary) || 'turn'}`, turn.caseId);
    } finally {
      if (this.turns.get(turn.caseId) === turn) this.turns.delete(turn.caseId);
      this._release(turn.dir, turn.turnId);
    }
  }

  _closeTurnMeta(turn) {
    let meta;
    try {
      meta = this.getCase(turn.caseId);
    } catch {
      return;
    }
    const at = this.now().toISOString();
    const gapPending = Boolean(turn.reorientPending) && (turn.triggers || []).some((t) => t.kind === 'time-gap');
    const patch = { lastTurnAt: at };
    if ((turn.source || 'owner') === 'owner' && !gapPending) patch.lastOwnerTurnAt = at;
    this.store.updateMeta(meta.id, patch);
    // A turn that ended with nothing pending acknowledges the state it
    // started from (spec §3.3); what changed during the turn fires next time.
    if (!turn.reorientPending && turn.snapshot) {
      const b = this._baseline(meta.dir);
      b.executorsMaterial = { ...(b.executorsMaterial || {}), ...turn.snapshot.executorsMaterial };
      b.budgetCrossed = turn.snapshot.budgetCrossed;
      const raised = new Set((turn.hookTriggers || []).map((t) => t.key));
      b.acknowledgedKeys = (b.acknowledgedKeys || []).filter((k) => raised.has(k));
      if (turn.snapshot.caseTypeMaterial) b.caseTypeMaterial = turn.snapshot.caseTypeMaterial;
      writeJsonIfChanged(this._baselinePath(meta.dir), b);
    }
  }

  // commitAll with the consecutive-failure count of spec §3.4. A non-zero
  // count is reset before committing so a success commits the reset too.
  async _commit(dir, message, caseId) {
    const file = this._baselinePath(dir);
    const before = this._baseline(dir);
    const prior = Number(before.commitFailures) || 0;
    if (prior) {
      before.commitFailures = 0;
      writeJsonIfChanged(file, before);
    }
    try {
      return await git.commitAll(dir, message);
    } catch (err) {
      const b = this._baseline(dir);
      b.commitFailures = prior + 1;
      writeJsonIfChanged(file, b);
      if (b.commitFailures >= 2) this._onCommitFailures(caseId, err);
      throw err;
    }
  }

  _onCommitFailures(caseId, err) {
    let meta;
    try {
      meta = this.getCase(caseId);
    } catch {
      return;
    }
    if (meta.status === 'active') {
      try {
        this.setStatus(meta.id, 'paused', { kind: 'commit', note: err.message });
      } catch (e) {
        log.warn(`Case ${meta.slug}: could not pause after commit failures: ${e.message}`);
      }
    }
    try {
      this.createQuestion(meta.id, {
        kind: 'question',
        urgency: 'high',
        text: `${meta.title}: the case repository could not be committed twice (${oneLine(err.message, 200)}). Fix the repository, then resume.`,
        payload: { type: 'commit-failed', mcpAnswerable: false, key: 'commit-failed' }
      }, { charge: false });
    } catch (e) {
      log.warn(`Case ${meta.slug}: could not ask about commit failures: ${e.message}`);
    }
  }

  // The only case-lock helper outside turns (R37). Inside a turn this
  // process holds, it runs inline and the turn commits the writes.
  async systemAction(id, label, fn, { commitMessage = null } = {}) {
    const meta = this.getCase(id);
    if (this._holdsLock(meta.dir)) return fn(meta);
    const turnId = `system-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    this._acquire(meta, turnId);
    try {
      const result = await fn(meta);
      await this._commit(meta.dir, commitMessage || `system: ${label}`, meta.id)
        .catch((err) => log.warn(`Case ${meta.slug}: commit after "${label}" failed: ${err.message}`));
      return result;
    } finally {
      this._release(meta.dir, turnId);
    }
  }

  // ---- Budgets and questions (spec §3.5, §3.9) ----

  onCrossings(id, category, crossedNow = []) {
    if (!Array.isArray(crossedNow) || !crossedNow.includes(100)) return null;
    const meta = this.getCase(id);
    if (meta.status === 'done' || meta.status === 'abandoned') return null;
    const entry = this.budget(meta.id).status()[category] || {};
    if (category === 'usd' || category === 'deadline') {
      if (meta.status === 'active' || meta.status === 'needs-direction') {
        try {
          this.setStatus(meta.id, 'paused', { kind: 'budget', ref: category });
        } catch (err) {
          log.warn(`Case ${meta.slug}: could not pause at the ${category} limit: ${err.message}`);
        }
      }
      const text = category === 'deadline'
        ? `${meta.title} reached its deadline (${entry.at}) and is paused. Reply with a new deadline (YYYY-MM-DD) to continue.`
        : `${meta.title} spent ${entry.spent} of its ${entry.limit} ${category} budget and is paused. Reply with a new limit to continue.`;
      return this.createQuestion(meta.id, {
        kind: 'question',
        urgency: 'normal',
        text,
        payload: {
          type: 'budget-grant',
          budget: category,
          spent: category === 'deadline' ? null : entry.spent,
          limit: category === 'deadline' ? entry.at : entry.limit,
          mcpAnswerable: false,
          key: `budget-grant:${category}`
        }
      }, { charge: false });
    }
    return this.createQuestion(meta.id, {
      kind: 'briefing',
      urgency: 'low',
      text: `${meta.title} used its ${category} allowance for ${entry.day} (${entry.spent} of ${entry.limit}). It resumes when the day rolls over.`,
      payload: { type: 'budget-daily', budget: category, key: `budget-daily:${category}:${entry.day}`, mcpAnswerable: false }
    }, { charge: false });
  }

  usageHook(turn) {
    return (ev) => {
      if (!ev || typeof ev !== 'object') return;
      try {
        const unpriced = ev.cost === null || ev.cost === undefined;
        const cost = unpriced ? 0 : Number(ev.cost) || 0;
        const r = this.budget(turn.caseId).charge('usd', cost, {
          turnId: turn.turnId,
          provider: ev.provider,
          model: ev.model,
          unpricedTokens: unpriced ? Number(ev.totalTokens) || 0 : 0
        });
        if (r.crossedNow.length) this.onCrossings(turn.caseId, 'usd', r.crossedNow);
      } catch (err) {
        log.warn(`Charging usage to case ${turn.caseId} failed: ${err.message}`);
      }
    };
  }

  // The charged, delivered creation path every stage uses (C5 §3.9).
  createQuestion(id, record, { charge = record?.kind === 'question' } = {}) {
    const meta = this.getCase(id);
    const store = this.questions(meta.id);
    const existing = store.findDuplicate(record);
    if (existing) return existing;
    const budget = charge ? this.budget(meta.id) : null;
    if (budget && budget.atLimit('questionsPerDay')) return { held: true };
    const rec = store.create(record);
    if (budget) {
      const r = budget.charge('questionsPerDay', 1, { questionId: rec.id });
      if (r.crossedNow.length) this.onCrossings(meta.id, 'questionsPerDay', r.crossedNow);
    }
    this._deliver(meta, store, rec);
    return store.get(rec.id) || rec;
  }

  _deliver(meta, store, rec) {
    const attention = rec.urgency === 'low' ? 'panel' : 'banner';
    this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId: rec.id, attention });
    if (rec.urgency === 'high' && typeof this.host?.uiToast?.send === 'function') {
      Promise.resolve()
        .then(() => this.host.uiToast.send({ title: meta.title, body: rec.text }))
        .catch((err) => log.warn(`Toast for ${rec.id} failed: ${err.message}`));
    }
    let interactive = false;
    try {
      interactive = typeof this.host?.interactive === 'function' && this.host.interactive() === true;
    } catch {
      interactive = false;
    }
    if (interactive) {
      store.recordDelivery(rec.id, { channel: 'in-app', at: this.now().toISOString(), deliveryId: `in-app-${rec.id}` });
    } else {
      log.warn(`Case ${meta.slug} asks ${rec.id} (${rec.urgency}): ${rec.text}. No channel can deliver it until stage 4; it waits.`);
    }
  }

  abortUnattended(reason = 'shutdown') {
    for (const turn of this.turns.values()) {
      if (turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    }
  }
}

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-runtime-unattended.test.js tests/cases-runtime.test.js tests/cases-core.test.js tests/cases-ipc.test.js tests/cases-orientation.test.js`
Expected: PASS, `# fail 0`

Run: `node --test tests/cases-tools.test.js tests/cases-regressions.test.js tests/cases-chat.test.js`
Expected: PASS, `# fail 0` (the case tools start calling `assertWritable` and `requireReoriented` only in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src/cases/defaults.js src/cases/case-runtime.js tests/cases-runtime-unattended.test.js
git commit -m "feat(cases): runtime status machine, re-orientation, hooks, budgets and question creation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Answers, owner facts, failure reports, grants and routed providers

**Files:**
- Create: `src/cases/answer-handlers.js`
- Modify: `src/cases/case-runtime.js` (the `require('./defaults')` line; insert methods after `abortUnattended`)
- Test: `tests/cases-questions.test.js` (append a `describe` block)
- Test: `tests/cases-roles.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: Task 10's runtime (`systemAction`, `setStatus`, `createQuestion`, `onCrossings`, `budget`, `wakeups`, `questions`, `_notify`), `QuestionStore.registerAnswerHandler`/`answerHandler` and `note` (Part 1), `resolveRole` (Part 1), `InferenceRouter.routeWithFallback(tier, messages, { …, tools, onChunk, target })` (Part 1).
- Produces:
  - `answer-handlers.js` registers `direction` and `budget-grant` handlers at require time; exports `firstNumber(text)`.
  - `CaseRuntime.applyOwnerFact(id, fact, { questionId }) → { applied: false | 'direction' | 'budget', resumed?, note?, error?, reason? }`
  - `CaseRuntime.answerQuestion(caseId, questionId, { channel, text, optionId }) → Promise<{ question, fact, effect }>`
  - `CaseRuntime.acknowledgeBriefing(caseId, questionId, { channel }) → Promise<record>`
  - `CaseRuntime.recordFailure(id, { failureClass, what, tried, why, unknowns, recommendation, turnId }) → { journal, rendered, questionId }`
  - `CaseRuntime.grantBudget(id, category, limit, { channel }) → Promise<{ fact, effect, case }>`
  - `CaseRuntime.roleModel(id, role) → { provider, model, tier }`
  - `CaseRuntime.routedProvider(turn, { role } | { target: { provider, model }, tier }) → { getProviderName, getDefaultModel, sendMessage, sendMessageWithTools, streamMessageWithTools }`
  - `BUDGET_FACT_NOTE = "Budget limits change only through the owner's answer or the Grant button."` (exported from `case-runtime.js`)

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/cases-questions.test.js`:

```js
describe('answers through the runtime', () => {
  const { CaseRuntime } = require('../src/cases');
  const git = require('../src/cases/git');

  function runtime() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-answers-'));
    dirs.push(root);
    const events = [];
    const rt = new CaseRuntime({
      root,
      now: () => T0,
      getSettings: () => ({ cases: { timeZone: 'UTC' } }),
      host: { notify: (e, p) => events.push([e, p]), interactive: () => true }
    });
    return { rt, events };
  }

  async function activeCase(rt, title = 'Lakeside lot') {
    const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    rt.completeGating(info.id);
    return rt.getCase(info.id);
  }

  const report = { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No buyers replied in 60 days', unknowns: [] };

  it('answerQuestion writes the fact, registers a retry wake-up, notifies, commits, and refuses a second answer', async () => {
    const { rt, events } = runtime();
    const c = await activeCase(rt);
    const q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    const out = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Yes, with the north lot' });
    assert.strictEqual(out.fact.source.kind, 'question');
    assert.strictEqual(out.question.answer.factId, out.fact.id);
    assert.deepStrictEqual(out.effect, { applied: false });
    const retry = rt.wakeups(c.id).list().find((w) => w.kind === 'retry');
    assert.deepStrictEqual(retry.payload, { key: `answered:${q.id}`, questionId: q.id });
    assert.strictEqual(retry.nextAt, T0.toISOString());
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'questions' && p.questionId === q.id));
    assert.strictEqual(await git.isDirty(c.dir), false, 'systemAction committed the answer');
    await assert.rejects(rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'No' }), (err) => err.code === 'ALREADY_ANSWERED');
    assert.strictEqual(rt.ledger(c.id).query({ subject: 'question' }).length, 1);
  });

  it('recordFailure writes the report, waits for direction, and asks a high direction question', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const f = rt.ledger(c.id).assert({ stmt: 'An auction house takes rural lots', subject: 'market', attr: 'auction', value: 'yes', source: { kind: 'url', ref: 'https://auctions.example.com/rural' } });
    const failure = rt.recordFailure(c.id, { ...report, recommendation: { claims: [{ text: 'Try an auction house', factIds: [f.id] }] }, turnId: 't1' });
    assert.strictEqual(failure.journal, 'journal/2026-09-23-1200-failure.md');
    assert.match(failure.rendered, /^# Failure report — County listing\n\nClass: dead-end\n\nTried:\n- Listed on the county site\n\nWhy: No buyers replied in 60 days\n\nUnknowns:\n- none\n\nRecommendation:\n- Try an auction house \[f-0001\]\n\nWaiting for the owner's direction\.$/);
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref, meta.statusReason.failureClass], ['needs-direction', 'failure', failure.journal, 'dead-end']);
    const q = rt.questions(c.id).get(failure.questionId);
    assert.deepStrictEqual([q.urgency, q.payload.type, q.payload.mcpAnswerable, q.payload.failure], ['high', 'direction', false, failure.journal]);
    const recs = fs.readFileSync(path.join(c.dir, '.kl', 'recommendations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(recs.at(-1).failure, failure.journal);
    assert.strictEqual(rt.ledger(c.id).view().facts.get(f.id).loadBearing, true);
  });

  it('a direction answer resumes the case', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    const out = await rt.answerQuestion(c.id, failure.questionId, { channel: 'in-app', text: 'Try a land auction instead' });
    assert.deepStrictEqual([out.fact.subject, out.fact.attr], ['direction', '2026-09-23-1200-failure']);
    assert.deepStrictEqual(out.effect, { applied: 'direction' });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['active', 'direction', out.fact.id]);
  });

  it('a direction answer while usd is spent leaves the case paused and notes why on the question', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.budget(c.id).charge('usd', 1);
    const out = await rt.answerQuestion(c.id, failure.questionId, { channel: 'in-app', text: 'Go ahead with the auction' });
    assert.strictEqual(out.effect.applied, false);
    assert.deepStrictEqual([rt.getCase(c.id).status, rt.getCase(c.id).statusReason.kind], ['paused', 'budget']);
    assert.strictEqual(rt.questions(c.id).get(failure.questionId).notes[0].text, 'Raise the usd budget first.');
    assert.ok(rt.questions(c.id).open().some((q) => q.payload.type === 'budget-grant'));
  });

  it('a budget-grant answer with a number above spend resumes; a reply without one keeps the case paused', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1.2).crossedNow);
    const first = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    const reply = await rt.answerQuestion(c.id, first.id, { channel: 'in-app', text: 'sure, go on' });
    assert.deepStrictEqual([reply.fact.attr, reply.fact.value], ['usd-reply', 'sure, go on']);
    assert.deepStrictEqual(reply.effect, { applied: false, reason: 'no-limit' });
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
    assert.ok(fs.readdirSync(path.join(c.dir, 'journal')).some((n) => /-question(-\d+)?\.md$/.test(n)
      && /no usable usd limit, so the case stays paused/.test(fs.readFileSync(path.join(c.dir, 'journal', n), 'utf8'))));

    const again = rt.onCrossings(c.id, 'usd', [100]);
    const grant = await rt.answerQuestion(c.id, again.id, { channel: 'in-app', text: 'Make it 2 dollars' });
    assert.deepStrictEqual([grant.fact.subject, grant.fact.attr, grant.fact.value], ['budget', 'usd', 2]);
    assert.deepStrictEqual(grant.effect, { applied: 'budget', resumed: true });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.budget.usd], ['active', 'budget-grant', 2]);
    assert.deepStrictEqual(rt.budget(c.id).status().usd.grantedBy, [grant.fact.id]);
  });

  it('a budget fact quoted from chat changes no limit', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const fact = rt.ledger(c.id).assert({ stmt: 'Owner said ok', subject: 'budget', attr: 'usd', value: 500, provenance: 'user', source: { kind: 'user-message', ref: 't1', quote: 'ok' } });
    assert.deepStrictEqual(rt.applyOwnerFact(c.id, fact), { applied: false, note: "Budget limits change only through the owner's answer or the Grant button." });
    assert.strictEqual(rt.getCase(c.id).budget, undefined);
  });

  it('grantBudget writes an owner-action fact and resumes a budget pause', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1).crossedNow);
    const out = await rt.grantBudget(c.id, 'usd', 5);
    assert.deepStrictEqual([out.fact.provenance, out.fact.source.kind, out.fact.value], ['user', 'owner-action', 5]);
    assert.deepStrictEqual([out.case.status, out.case.budget.usd], ['active', 5]);
    const deadline = await rt.grantBudget(c.id, 'deadline', '2099-12-31');
    assert.strictEqual(deadline.case.budget.deadline, '2099-12-31');
    assert.ok(rt.wakeups(c.id).list().some((w) => w.kind === 'deadline-check'));
  });

  it('acknowledgeBriefing dismisses a briefing without a fact or a wake-up', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const b = rt.createQuestion(c.id, { kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const acked = await rt.acknowledgeBriefing(c.id, b.id);
    assert.strictEqual(acked.answer.channel, 'in-app');
    assert.strictEqual(rt.ledger(c.id).query({}).length, 0);
    assert.ok(!rt.wakeups(c.id).list().some((w) => w.kind === 'retry'));
  });
});
```

Append to the end of `tests/cases-roles.test.js`:

```js
describe('roleModel and routedProvider', () => {
  const { after } = require('node:test');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { CaseRuntime } = require('../src/cases');
  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
  const root = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-roles-')); roots.push(d); return d; };

  it('roleModel prefers case.yaml roles over settings', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => ({ ...settings(), cases: { roles: { judge: { tier: 'standard' } } } }) });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    assert.deepStrictEqual(rt.roleModel(info.id, 'judge'), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    rt.store.updateMeta(info.id, { roles: { judge: { provider: 'gemini', model: 'gemini-2.0-pro' } } });
    assert.deepStrictEqual(rt.roleModel(info.id, 'judge'), { provider: 'gemini', model: 'gemini-2.0-pro', tier: 'standard' });
  });

  it('routedProvider sends every call through routeWithFallback with the target, refreshing the token once', async () => {
    const calls = [];
    const router = { routeWithFallback: async (tier, messages, opts) => { calls.push({ tier, opts }); return { type: 'text', content: 'ok' }; } };
    const host = { inferenceRouter: router, resolveInference: async (sel) => { calls.push({ resolve: sel }); } };
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const controller = new AbortController();
    const turn = { caseId: info.id, turnId: 't1', signal: controller.signal };
    const orient = rt.routedProvider(turn, { role: 'orient' });
    assert.deepStrictEqual([orient.getProviderName(), orient.getDefaultModel()], ['groq', 'llama-3.3-70b-versatile']);
    await orient.sendMessage([{ role: 'user', content: 'x' }], { systemPrompt: 'S' });
    await orient.streamMessageWithTools([], [{ name: 'Read' }], {}, () => {});
    assert.strictEqual(calls.filter((c) => c.resolve).length, 1);
    assert.deepStrictEqual(calls[0], { resolve: { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' } });
    assert.strictEqual(calls[1].tier, 'fast');
    assert.deepStrictEqual(calls[1].opts.target, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    assert.strictEqual(calls[1].opts.systemPrompt, 'S');
    assert.strictEqual(calls[1].opts.abortSignal, controller.signal);
    assert.deepStrictEqual(calls[2].opts.tools, [{ name: 'Read' }]);
    assert.strictEqual(typeof calls[2].opts.onChunk, 'function');
    const owner = rt.routedProvider(turn, { target: { provider: 'OpenAI', model: 'gpt-4o' }, tier: 'smart' });
    await owner.sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual([calls.at(-1).tier, calls.at(-1).opts.target], ['smart', { provider: 'openai', model: 'gpt-4o' }]);
    assert.throws(() => new CaseRuntime({ root: root() }).routedProvider(turn, { role: 'judge' }), /inference router/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-questions.test.js tests/cases-roles.test.js`
Expected: FAIL with `rt.answerQuestion is not a function`, `rt.recordFailure is not a function` and `rt.roleModel is not a function`; the Part 1 tests in both files still pass.

- [ ] **Step 3: Implement**

Create `src/cases/answer-handlers.js`:

```js
// src/cases/answer-handlers.js
// The typed answer handlers stage 2 registers (spec §3.9). Required by
// case-runtime.js for its side effect; `commit-failed` uses the default fact.
const path = require('path');
const { QuestionStore } = require('./questions');

const DAY = /\d{4}-\d{2}-\d{2}/;

function optionOrText(record, answer) {
  const option = answer.optionId ? (record.options || []).find((o) => o.id === answer.optionId) : null;
  return option ? option.label : answer.text;
}

// "1,500.50 dollars" -> 1500.5; null when the text holds no number.
function firstNumber(text) {
  const m = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

QuestionStore.registerAnswerHandler('direction', {
  toFact: (record, answer) => {
    const value = optionOrText(record, answer);
    const attr = path.basename(String(record.payload?.failure || 'failure'), '.md');
    return { stmt: `Owner's direction after ${attr}: ${value}`, subject: 'direction', attr, value };
  },
  onAnswered: (record, fact, { runtime, caseId }) => runtime.applyOwnerFact(caseId, fact, { questionId: record.id })
});

QuestionStore.registerAnswerHandler('budget-grant', {
  toFact: (record, answer) => {
    const category = String(record.payload?.budget || 'usd');
    const text = String(optionOrText(record, answer) ?? '');
    let value = null;
    if (category === 'deadline') {
      const m = text.match(DAY);
      if (m && m[0] > String(record.payload?.limit || '')) value = m[0];
    } else {
      const n = firstNumber(text);
      if (n !== null && n > Number(record.payload?.spent || 0)) value = n;
    }
    if (value !== null) {
      return { stmt: `Owner set the ${category} budget to ${value} (answer to ${record.id}).`, subject: 'budget', attr: category, value };
    }
    return { stmt: `Owner replied to the ${category} budget question ${record.id}: ${text}`, subject: 'budget', attr: `${category}-reply`, value: text };
  },
  onAnswered: (record, fact, { runtime, caseId }) => {
    const category = String(record.payload?.budget || 'usd');
    if (!fact || fact.attr !== category) {
      runtime.records(caseId).writeJournal(
        'question',
        `${record.id}: the reply had no usable ${category} limit, so the case stays paused. Answer with a number, or use the Grant button.`,
        runtime.now()
      );
      return { applied: false, reason: 'no-limit' };
    }
    return runtime.applyOwnerFact(caseId, fact);
  }
});

module.exports = { firstNumber };
```

In `src/cases/case-runtime.js`, replace

```js
const { resolveCaseSettings } = require('./defaults');
```

with

```js
const { resolveCaseSettings } = require('./defaults');
const { resolveRole } = require('./roles');
// Registers the direction and budget-grant answer handlers.
require('./answer-handlers');

const BUDGET_FACT_NOTE = "Budget limits change only through the owner's answer or the Grant button.";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
```

In `src/cases/case-runtime.js`, replace

```js
  abortUnattended(reason = 'shutdown') {
    for (const turn of this.turns.values()) {
      if (turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    }
  }
}

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot };
```

with

```js
  abortUnattended(reason = 'shutdown') {
    for (const turn of this.turns.values()) {
      if (turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    }
  }

  // ---- Owner facts, answers and failure reports (spec §3.4, §3.9) ----

  // Runs after every successful `user` fact. Only host-written sources
  // (question, owner-action) can change a budget limit.
  applyOwnerFact(id, fact, { questionId = null } = {}) {
    if (!fact || fact.provenance !== 'user' || (fact.status && fact.status !== 'active')) return { applied: false };
    const meta = this.getCase(id);
    if (fact.subject === 'direction' && meta.status === 'needs-direction') {
      try {
        this.setStatus(meta.id, 'active', { kind: 'direction', ref: fact.id });
        return { applied: 'direction' };
      } catch (err) {
        if (err.code !== 'BUDGET_EXHAUSTED') throw err;
        const category = this.budget(meta.id).exhausted()[0];
        this.setStatus(meta.id, 'paused', { kind: 'budget', ref: category, note: err.message });
        const qid = questionId || (fact.source?.kind === 'question' ? fact.source.ref : null);
        if (qid) {
          try {
            this.questions(meta.id).note(qid, err.message);
          } catch (e) {
            log.warn(`Could not note the budget refusal on ${qid}: ${e.message}`);
          }
        }
        this.onCrossings(meta.id, category, [100]);
        return { applied: false, error: err.message };
      }
    }
    if (fact.subject === 'budget' && CATEGORIES.includes(fact.attr)) {
      if (!['question', 'owner-action'].includes(fact.source?.kind)) return { applied: false, note: BUDGET_FACT_NOTE };
      let value = null;
      if (fact.attr === 'deadline') {
        value = typeof fact.value === 'string' && DAY_PATTERN.test(fact.value) ? fact.value : null;
      } else {
        const n = Number(fact.value);
        value = Number.isFinite(n) && n > 0 ? n : null;
      }
      if (value === null) {
        return { applied: false, note: `A ${fact.attr} limit must be ${fact.attr === 'deadline' ? 'a YYYY-MM-DD date' : 'a number above 0'}.` };
      }
      const current = meta.budget && typeof meta.budget === 'object' ? meta.budget : {};
      this.store.updateMeta(meta.id, { budget: { ...current, [fact.attr]: value } });
      const budget = this.budget(meta.id);
      budget.recordGrant(fact.attr, fact.id);
      for (const [category, crossed] of Object.entries(budget.reconcile())) this.onCrossings(meta.id, category, crossed);
      if (fact.attr === 'deadline') this.wakeups(meta.id).ensure('deadline-check', { every: 86400000, payload: { key: 'deadline' } });
      this._notify('case:changed', { caseId: meta.id, what: 'budget' });
      const after = this.getCase(meta.id);
      if (after.status === 'paused' && after.statusReason?.kind === 'budget' && !budget.exhausted().length) {
        this.setStatus(meta.id, 'active', { kind: 'budget-grant', ref: fact.id });
        return { applied: 'budget', resumed: true };
      }
      return { applied: 'budget', resumed: false };
    }
    return { applied: false };
  }

  // Every host path that answers a question comes through here (program §4.3).
  async answerQuestion(caseId, questionId, { channel = 'in-app', text = null, optionId = null } = {}) {
    return this.systemAction(caseId, `answer ${questionId}`, async (meta) => {
      const store = this.questions(meta.id);
      const question = store.answer(questionId, { channel, text, optionId });
      const fact = question.answer?.factId ? new FactLedger(meta.dir).view().facts.get(question.answer.factId) || null : null;
      const handler = QuestionStore.answerHandler(question.payload?.type);
      let effect = null;
      if (handler?.onAnswered) effect = await handler.onAnswered(question, fact, { runtime: this, caseId: meta.id });
      else if (fact) effect = this.applyOwnerFact(meta.id, fact, { questionId });
      if (question.kind !== 'briefing') {
        this.wakeups(meta.id).ensure('retry', {
          at: this.now().toISOString(),
          payload: { key: `answered:${questionId}`, questionId }
        });
      }
      this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId });
      return { question: store.get(questionId) || question, fact, effect };
    });
  }

  async acknowledgeBriefing(caseId, questionId, { channel = 'in-app' } = {}) {
    return this.systemAction(caseId, `acknowledge ${questionId}`, async (meta) => {
      const question = this.questions(meta.id).acknowledge(questionId, { channel });
      this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId });
      return question;
    });
  }

  // What the Fail tool records (spec §3.4): the report, the one allowed
  // recommendation, needs-direction, and a high direction question.
  recordFailure(id, { failureClass, what, tried = [], why, unknowns = [], recommendation = null, turnId = null }) {
    const meta = this.getCase(id);
    const { facts } = new FactLedger(meta.dir).view();
    const claims = Array.isArray(recommendation?.claims) ? recommendation.claims : [];
    const body = [
      `# Failure report — ${oneLine(what, 120)}`,
      '',
      `Class: ${failureClass}`,
      '',
      'Tried:',
      ...tried.map((t) => `- ${t}`),
      '',
      `Why: ${why}`,
      '',
      'Unknowns:',
      ...(unknowns.length ? unknowns.map((fid) => `- ${fid}${facts.get(fid) ? ` ${facts.get(fid).stmt}` : ''}`) : ['- none']),
      '',
      'Recommendation:',
      ...(claims.length ? claims.map((c) => `- ${c.text}${c.factIds?.length ? ` [${c.factIds.join(', ')}]` : ''}`) : ['none']),
      '',
      "Waiting for the owner's direction."
    ].join('\n');
    const records = new CaseRecords(meta.dir);
    const journal = records.writeJournal('failure', body, this.now());
    if (claims.length) {
      new FactLedger(meta.dir).markLoadBearing([...new Set(claims.flatMap((c) => c.factIds || []))]);
      records.recordRecommendation({ turnId, claims, unknowns, failure: journal });
    }
    this.setStatus(meta.id, 'needs-direction', { kind: 'failure', ref: journal, failureClass });
    const question = this.createQuestion(meta.id, {
      kind: 'question',
      urgency: 'high',
      text: `${meta.title}: "${oneLine(what, 200)}" did not work (${journal}). How should the case proceed?`,
      payload: {
        type: 'direction',
        failure: journal,
        about: { subject: 'direction', attr: path.basename(journal, '.md') },
        mcpAnswerable: false
      }
    }, { charge: false });
    return { journal, rendered: body, questionId: question.id };
  }

  // The Grant button (IPC case:grantBudget). The caller validates the limit.
  async grantBudget(id, category, limit, { channel = 'in-app' } = {}) {
    return this.systemAction(id, `grant ${category}`, async (meta) => {
      const at = this.now().toISOString();
      const fact = new FactLedger(meta.dir).assert({
        stmt: `Owner set the ${category} budget to ${limit} from the case panel.`,
        subject: 'budget',
        attr: category,
        value: limit,
        provenance: 'user',
        source: { kind: 'owner-action', ref: 'grant-budget', channel, at },
        addedBy: 'owner-action'
      });
      const effect = this.applyOwnerFact(meta.id, fact);
      return { fact, effect, case: this.getCase(meta.id) };
    });
  }

  // ---- Model roles (spec §3.8) ----

  roleModel(id, role) {
    const meta = this.getCase(id);
    let settings = {};
    try {
      settings = this.getSettings() || {};
    } catch (err) {
      log.warn(`Reading settings for role ${role} failed: ${err.message}`);
    }
    const hasToken = (provider) => {
      if (typeof this.host?.hasProviderToken !== 'function') return true;
      try {
        return Boolean(this.host.hasProviderToken(provider));
      } catch {
        return false;
      }
    };
    return resolveRole(role, { settings: { ...settings, cases: this.settings() }, caseMeta: meta, hasToken });
  }

  // A provider-shaped object whose every call goes through
  // routeWithFallback with an explicit target, so case calls fail over and
  // are charged like any other (spec §3.8).
  routedProvider(turn, spec = {}) {
    const router = this.host?.inferenceRouter;
    if (!router || typeof router.routeWithFallback !== 'function') {
      throw new Error('Routed providers need a host with an inference router.');
    }
    const resolved = spec.role
      ? this.roleModel(turn.caseId, spec.role)
      : { provider: spec.target?.provider, model: spec.target?.model || '', tier: spec.tier || 'standard' };
    if (!resolved.provider) throw new Error('A routed provider needs a role or a target provider.');
    const tier = resolved.tier || 'standard';
    const target = { provider: String(resolved.provider).toLowerCase(), model: resolved.model || '' };
    let refreshed = null;
    // Once per provider object: resolveInference refreshes an OAuth token.
    const refresh = () => {
      if (!refreshed) {
        refreshed = Promise.resolve()
          .then(() => (typeof this.host.resolveInference === 'function'
            ? this.host.resolveInference({ provider: target.provider, model: target.model || undefined, tier })
            : null))
          .catch((err) => log.warn(`Refreshing ${target.provider} before a case call failed: ${err.message}`));
      }
      return refreshed;
    };
    const call = async (messages, opts = {}, tools = null, onChunk = null) => {
      await refresh();
      return router.routeWithFallback(tier, messages, {
        ...(opts || {}),
        ...(Array.isArray(tools) ? { tools } : {}),
        ...(typeof onChunk === 'function' ? { onChunk } : {}),
        ...(!opts?.abortSignal && turn.signal ? { abortSignal: turn.signal } : {}),
        target
      });
    };
    return {
      getProviderName: () => target.provider,
      getDefaultModel: () => target.model,
      sendMessage: (messages, opts) => call(messages, opts),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
  }
}

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot, BUDGET_FACT_NOTE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-questions.test.js tests/cases-roles.test.js tests/cases-runtime-unattended.test.js tests/cases-runtime.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/answer-handlers.js src/cases/case-runtime.js tests/cases-questions.test.js tests/cases-roles.test.js
git commit -m "feat(cases): answers become owner facts; failure reports, grants and routed role providers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Case tools — status rules, `Reorient`, `Ask`, `Fail`

**Files:**
- Modify: `src/tools/builtin/case-tools.js` (imports, `withCase`, Ledger `assert`, the four `execute:` lines and their closings, the Brief `field` enum and description, `module.exports`)
- Create: `src/tools/builtin/case-unattended-tools.js`
- Modify: `src/cases/chat-integration.js` (`CASE_TOOL_NAMES`; one line of `CASE_MODE_PROMPT`)
- Modify: `src/tools/index.js` (after `  toolRegistry.register(RecommendTool);`)
- Modify: `tests/cases-tools.test.js` (`setup` helper; the draft `Recommend` assertion; append a `describe` block)
- Modify: `tests/cases-regressions.test.js` (`openCase` helper)
- Test: `tests/cases-tools.test.js`, `tests/cases-regressions.test.js`

**Interfaces:**
- Consumes: `CaseRuntime.assertWritable`, `requireReoriented`, `applyOwnerFact`, `recordReorientation`, `recordFailure`, `createQuestion`, `turns`, `caseContext` (Tasks 10–11); `FAILURE_CLASSES` (Part 1); `toMs` (Part 1); `recommendationGate` (stage 1); optional C6 `runtime.playbookSafeDefaults(id) → string[]`.
- Produces: `withCase(options, op, fn, { params, reoriented })` (exported); `ReorientTool`, `AskTool`, `FailTool`, `registerCaseUnattendedTools(registry)`; `CASE_TOOL_NAMES = ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']`. Tool ops: `Ledger.<action>`, `Brief.<action>`, `Decide`, `Recommend`, `Reorient`, `Ask`, `Fail`.

- [ ] **Step 1: Write the failing test**

In `tests/cases-tools.test.js`, replace

```js
async function setup(title = 'Lakeside lot', ownerMessages) {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  const caseContext = { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir, ownerMessages };
  return { runtime, info, opts: { caseContext } };
}
```

with

```js
async function setup(title = 'Lakeside lot', ownerMessages) {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  // Stage 2: Decide, Recommend and Fail need a registered turn.
  const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
  const caseContext = runtime.caseContext(turn, { ownerMessages });
  return { runtime, info, turn, opts: { caseContext } };
}
```

In `tests/cases-tools.test.js`, replace

```js
    assert.strictEqual(draft.ok, false);
    assert.match(JSON.stringify(draft.failures), /gating/i);
```

with

```js
    assert.strictEqual(draft.ok, false);
    assert.match(draft.error, /gating pass/);
```

In `tests/cases-regressions.test.js`, replace

```js
    runtime.completeGating(info.id);
  }
  return { info, opts: { caseContext: { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir, ownerMessages } } };
}
```

with

```js
    runtime.completeGating(info.id);
  }
  // Stage 2: Decide and Recommend need a registered turn (requireReoriented).
  const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
  return { info, turn, opts: { caseContext: runtime.caseContext(turn, { ownerMessages }) } };
}
```

Append to the end of `tests/cases-tools.test.js`:

```js
describe('stage 2 case tools', () => {
  const { ReorientTool, AskTool, FailTool } = require('../src/tools/builtin/case-unattended-tools');

  async function turnWith({ ownerMessages = [], ownerMessageTimes = [], settings = {}, before } = {}) {
    const runtime = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: settings }) });
    const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    await activate(runtime, info.id);
    if (before) await before(runtime, info);
    const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
    return { runtime, info, turn, opts: { caseContext: runtime.caseContext(turn, { ownerMessages, ownerMessageTimes }) } };
  }
  const report = { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No replies in 60 days' };

  it('registers Reorient, Ask and Fail with the other case tools, none needing approval', () => {
    assert.deepStrictEqual([...CASE_TOOL_NAMES], ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']);
    for (const name of ['Reorient', 'Ask', 'Fail']) {
      assert.ok(toolRegistry.get(name), `${name} registered`);
      assert.strictEqual(toolRegistry.get(name).requiresApproval, false);
    }
    assert.match(CASE_MODE_PROMPT, /call Reorient first/);
    assert.match(CASE_MODE_PROMPT, /through the Ask tool/);
  });

  it('Reorient clears a pending decision trigger only when affects names the decision', async () => {
    const { runtime, info, opts } = await turnWith({
      before: async (rt, i) => {
        const gis = rt.ledger(i.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
        rt.records(i.id).recordDecision({ decision: 'Price off GIS', factIds: [gis.id] });
        rt.ledger(i.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
      }
    });
    const plat = runtime.ledger(info.id).query({ subject: 'lot' })[0];
    const decide = await DecideTool.execute({ decision: 'List at the plat acreage', factIds: [plat.id] }, opts);
    assert.strictEqual(decide.ok, false);
    assert.match(decide.error, /Call Reorient/);
    assert.match((await ReorientTool.execute({ changed: 'Acreage corrected', affects: [], action: 'adjust', note: 'Reprice.' }, opts)).error, /"affects" must include D-001/);
    assert.match((await ReorientTool.execute({ changed: 'x', affects: ['D-009'], action: 'adjust', note: 'y' }, opts)).error, /not decision ids in this case: D-009/);
    assert.match((await ReorientTool.execute({ changed: 'x', affects: ['D-001'], action: 'shrug', note: 'y' }, opts)).error, /continue, adjust or ask/);
    const ok = await ReorientTool.execute({ changed: 'Acreage corrected', affects: ['D-001'], action: 'adjust', note: 'Reprice off the plat.' }, opts);
    assert.strictEqual(ok.ok, true);
    assert.match(ok.journal, /^journal\/.*-reorient\.md$/);
    assert.strictEqual(ok.next, 'Adjust the plan to what changed, then continue.');
    assert.strictEqual((await DecideTool.execute({ decision: 'List at the plat acreage', factIds: [plat.id] }, opts)).ok, true);
    assert.deepStrictEqual(await ReorientTool.execute({ changed: 'x', action: 'continue', note: 'y' }, opts), { ok: false, error: 'No re-orientation is pending in this turn.' });
  });

  it('Reorient with a budget threshold pending needs a note of at least 40 characters', async () => {
    const { opts } = await turnWith({
      before: (rt, i) => {
        rt.store.updateMeta(i.id, { budget: { usd: 10 } });
        rt.budget(i.id).charge('usd', 8.5);
      }
    });
    assert.match((await ReorientTool.execute({ changed: 'Budget', action: 'continue', note: 'fine' }, opts)).error, /at least 40 characters/);
    assert.strictEqual((await ReorientTool.execute({ changed: 'Budget', action: 'continue', note: 'About 1.50 is left; enough to finish the listing.' }, opts)).ok, true);
  });

  it('Fail needs re-orientation, checks its one recommendation, and leaves the case waiting for direction', async () => {
    const { runtime, info, opts } = await turnWith({ before: (rt, i) => { rt.store.updateMeta(i.id, { lastOwnerTurnAt: '2000-01-01T00:00:00.000Z' }); } });
    assert.match((await FailTool.execute(report, opts)).error, /Call Reorient/);
    assert.strictEqual((await ReorientTool.execute({ changed: 'A long gap', action: 'continue', note: 'Nothing changed.' }, opts)).ok, true);
    assert.match((await FailTool.execute({ ...report, tried: [] }, opts)).error, /at least one/);
    assert.match((await FailTool.execute({ ...report, failureClass: 'meh' }, opts)).error, /failureClass/);
    assert.match((await FailTool.execute({ ...report, unknowns: ['f-0404'] }, opts)).error, /not: f-0404/);
    const refused = await FailTool.execute({ ...report, recommendation: { claims: [{ text: 'Try an auction', factIds: ['f-0404'] }] } }, opts);
    assert.strictEqual(refused.ok, false);
    assert.match(JSON.stringify(refused.failures), /f-0404/);
    assert.strictEqual(runtime.getCase(info.id).status, 'active', 'a refused report changes nothing');
    const done = await FailTool.execute(report, opts);
    assert.strictEqual(done.ok, true);
    assert.match(done.rendered, /^# Failure report — County listing/);
    assert.strictEqual(done.instruction, 'Present this as written and stop. Do not start another approach.');
    assert.strictEqual(runtime.getCase(info.id).status, 'needs-direction');
    assert.match((await RecommendTool.execute({ claims: [{ text: 'x', factIds: [] }] }, opts)).error, /waiting for the owner's direction/);
    assert.match((await FailTool.execute(report, opts)).error, /waiting for the owner's direction/);
    assert.strictEqual(runtime.assertWritable(info.id, 'Plan').ok, false);
    const [q] = runtime.questions(info.id).open();
    assert.deepStrictEqual([q.urgency, q.payload.type], ['high', 'direction']);
  });

  it('Ask charges questions, clamps and refuses briefings by materiality, and allows only safe defaults', async () => {
    const { runtime, info, opts } = await turnWith({
      before: (rt, i) => {
        rt.brief(i.id).update('materiality', { tell: ['offer'], ignore: ['voicemail'] }, { provenance: 'user' });
        rt.brief(i.id).update('safeDefaults', ['keep-price'], { provenance: 'user' });
      }
    });
    const q = await AskTool.execute({ question: 'Is the well shared with the neighbour?' }, opts);
    assert.deepStrictEqual([q.ok, q.urgency, q.delivered], [true, 'normal', false]);
    assert.strictEqual(q.note, 'Not answered yet. Do not assume the answer.');
    assert.strictEqual(runtime.budget(info.id).status().questionsPerDay.spent, 1);
    assert.deepStrictEqual(
      await AskTool.execute({ question: 'A buyer left a voicemail.', kind: 'briefing', materiality: 'voicemail' }, opts),
      { ok: false, error: 'The brief says not to contact the owner about "voicemail". Journal it instead.' }
    );
    const clamped = await AskTool.execute({ question: 'The listing went live.', kind: 'briefing', urgency: 'high', materiality: 'listing' }, opts);
    assert.strictEqual(clamped.urgency, 'low');
    assert.match(clamped.note, /Urgency lowered to low/);
    const told = await AskTool.execute({ question: 'An offer came in at 30k.', kind: 'briefing', urgency: 'high', materiality: 'offer' }, opts);
    assert.strictEqual(told.urgency, 'high');
    assert.strictEqual(runtime.budget(info.id).status().questionsPerDay.spent, 1, 'briefings are not charged');
    const unsafe = await AskTool.execute({ question: 'Relist?', options: [{ id: 'yes', label: 'Relist' }, { id: 'no', label: 'Wait' }], defaultOnSilence: 'yes' }, opts);
    assert.strictEqual(unsafe.error, 'Only "hold" is allowed: the brief declares no safe default matching this option.');
    assert.strictEqual((await AskTool.execute({ question: 'Keep the asking price?', options: [{ id: 'keep-price', label: 'Keep it' }, { id: 'cut', label: 'Cut 5 %' }], defaultOnSilence: 'keep-price' }, opts)).ok, true);
    runtime.playbookSafeDefaults = () => ['Wait'];
    assert.strictEqual((await AskTool.execute({ question: 'Relist now?', options: [{ id: 'yes', label: 'Relist' }, { id: 'no', label: 'Wait' }], defaultOnSilence: 'no' }, opts)).ok, true, 'a playbook safe default (C6 stub) matches by label');
    assert.match((await AskTool.execute({ question: 'New limit?', about: { subject: 'budget', attr: 'usd' } }, opts)).error, /recorded by the host/);
    assert.match((await AskTool.execute({ question: 'Approve?', kind: 'approval' }, opts)).error, /kind must be/);
    assert.match((await AskTool.execute({ question: 'Which one?', resolves: 'f-0404' }, opts)).error, /active unknown/);
  });

  it('Ask refuses a question once the day\'s questionsPerDay is spent', async () => {
    const { opts } = await turnWith({ settings: { budgets: { questionsPerDay: 1 } } });
    assert.strictEqual((await AskTool.execute({ question: 'First question?' }, opts)).ok, true);
    assert.match((await AskTool.execute({ question: 'Second question?' }, opts)).error, /questionsPerDay/);
    assert.strictEqual((await AskTool.execute({ question: 'Still a briefing.', kind: 'briefing' }, opts)).ok, true);
  });

  it('Ledger refuses host-reserved source kinds, and a direction quote from before the failure', async () => {
    const { runtime, info, opts } = await turnWith();
    for (const kind of ['question', 'owner-action']) {
      assert.deepStrictEqual(
        await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'lot', attr: 'x', value: '1', source: { kind, ref: 'q-0001' } }, opts),
        { ok: false, error: `Source kind "${kind}" is reserved for the host.` }
      );
    }
    runtime.setStatus(info.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    const ctx = (times) => ({ caseContext: { ...opts.caseContext, ownerMessages: ['Try the county auction.', 'What now?'], ownerMessageTimes: times } });
    const direction = (quote) => ({ action: 'assert', provenance: 'user', quote, stmt: 'Owner: try the county auction', subject: 'direction', attr: 'x-failure', value: 'county auction' });
    assert.deepStrictEqual(
      await LedgerTool.execute(direction('Try the county auction'), ctx(['2000-01-01T00:00:00.000Z', '2000-01-01T00:00:01.000Z'])),
      { ok: false, error: 'Direction must come from something the owner said after the failure report.' }
    );
    const fresh = await LedgerTool.execute(direction('Try the county auction'), ctx(['2999-01-01T00:00:00.000Z', '2999-01-01T00:00:01.000Z']));
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.effect, 'direction');
    assert.strictEqual(runtime.getCase(info.id).status, 'active');
    runtime.setStatus(info.id, 'needs-direction', { kind: 'failure', ref: 'journal/y-failure.md', failureClass: 'dead-end' });
    const latest = await LedgerTool.execute(direction('What now'), ctx(['2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z']));
    assert.strictEqual(latest.ok, true, "this turn's own message always counts");
  });

  it('a user budget fact from the chat is recorded but changes no limit', async () => {
    const { runtime, info, opts } = await turnWith({ ownerMessages: ['ok, spend more'] });
    const r = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'ok, spend more', stmt: 'Owner raised the budget', subject: 'budget', attr: 'usd', value: '500' }, opts);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.note, "Budget limits change only through the owner's answer or the Grant button.");
    assert.strictEqual(runtime.getCase(info.id).budget, undefined);
  });

  it('a paused case allows only reads through the tools', async () => {
    const { runtime, info, opts } = await turnWith();
    runtime.setStatus(info.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual((await LedgerTool.execute({ action: 'query' }, opts)).ok, true);
    assert.deepStrictEqual(
      await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'a', attr: 'b', value: '1', source: src }, opts),
      { ok: false, error: 'Case is paused (owner). Only reading is available.' }
    );
    assert.strictEqual((await BriefTool.execute({ action: 'read' }, opts)).ok, true);
    assert.strictEqual((await AskTool.execute({ question: 'Anything?' }, opts)).ok, false);
  });

  it('Brief takes safeDefaults only from the owner', async () => {
    const { opts } = await turnWith({ ownerMessages: ['If I say nothing, keep the price.'] });
    assert.strictEqual((await BriefTool.execute({ action: 'append', field: 'safeDefaults', item: 'keep-price' }, opts)).ok, false);
    assert.strictEqual((await BriefTool.execute({ action: 'append', field: 'safeDefaults', item: 'keep-price', provenance: 'user', quote: 'keep the price' }, opts)).ok, true);
  });

  it('the executor refuses the newly blocked tools in a case turn', async () => {
    const { opts } = await turnWith();
    const executor = new ToolExecutor({ requireApproval: false, extraToolOptions: { caseContext: opts.caseContext } });
    const calls = { RequestTools: { tools: ['Bash'] }, ToolSearch: { query: 'web' }, Canvas: { action: 'close' } };
    for (const [name, params] of Object.entries(calls)) {
      const r = await executor.execute(name, params);
      assert.strictEqual(r.success, false, name);
      assert.match(r.error, /not available in case turns/, name);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-tools.test.js tests/cases-regressions.test.js`
Expected: FAIL with `Cannot find module '../src/tools/builtin/case-unattended-tools'`, and `Recommend is refused on a draft case…` fails because `draft.error` is the gate's message without `gating pass`.

- [ ] **Step 3: Implement**

In `src/tools/builtin/case-tools.js`, replace

```js
const { USER_ONLY_FIELDS } = require('../../cases/brief');
```

with

```js
const { USER_ONLY_FIELDS } = require('../../cases/brief');
const { toMs } = require('../../cases/clock');
```

In `src/tools/builtin/case-tools.js`, replace

```js
async function withCase(options, fn) {
  const ctx = options?.caseContext;
  if (!ctx || !ctx.runtime || !ctx.caseId) return NO_CASE;
  try {
    return await fn(ctx);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
```

with

```js
// op is the status-rule op (stage 2 spec §3.1), a string or a function of
// params. reoriented: Decide, Recommend and Fail also need no pending
// re-orientation. Refusals are results, never throws.
async function withCase(options, op, fn, { params = {}, reoriented = false } = {}) {
  const ctx = options?.caseContext;
  if (!ctx || !ctx.runtime || !ctx.caseId) return NO_CASE;
  try {
    const opName = typeof op === 'function' ? op(params || {}) : op;
    const refused = ctx.runtime.assertWritable(ctx.caseId, opName);
    if (refused) return refused;
    if (reoriented) {
      const pending = ctx.runtime.requireReoriented(ctx.caseId);
      if (pending) return pending;
    }
    return await fn(ctx);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// A direction fact ends needs-direction, so its quote must be from this
// turn's message or from a message sent after the failure report.
function staleDirection(ctx, messageIndex) {
  const messages = Array.isArray(ctx.ownerMessages) ? ctx.ownerMessages : [];
  if (messageIndex === messages.length - 1) return null;
  const failedAt = toMs(ctx.runtime.getCase(ctx.caseId).statusReason?.at);
  const saidAt = toMs(Array.isArray(ctx.ownerMessageTimes) ? ctx.ownerMessageTimes[messageIndex] : null);
  if (Number.isFinite(failedAt) && Number.isFinite(saidAt) && saidAt > failedAt) return null;
  return { ok: false, error: 'Direction must come from something the owner said after the failure report.' };
}
```

In `src/tools/builtin/case-tools.js`, replace

```js
  execute: (params, options) => withCase(options, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    if (params.value !== undefined) params = { ...params, value: parseValue(params.value) };
```

with

```js
  execute: (params, options) => withCase(options, (p) => `Ledger.${p.action}`, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    if (params.value !== undefined) params = { ...params, value: parseValue(params.value) };
```

In `src/tools/builtin/case-tools.js`, replace

```js
        if (input.provenance === 'user') {
          const check = requireOwnerQuote({ quote: input.quote, ownerMessages: ctx.ownerMessages });
          if (!check.ok) return check;
          input.source = { kind: 'user-message', ref: ctx.turnId, quote: check.quote, messageIndex: check.messageIndex };
        } else if (input.source?.kind === 'user-message') {
          return { ok: false, error: 'What the owner said is recorded with provenance "user" and a "quote" of their own words, not with a "user-message" source.' };
        }
        return { ok: true, fact: ledger.assert(input) };
      }
```

with

```js
        if (input.provenance === 'user') {
          const check = requireOwnerQuote({ quote: input.quote, ownerMessages: ctx.ownerMessages });
          if (!check.ok) return check;
          if (String(input.subject || '').trim().toLowerCase() === 'direction') {
            const stale = staleDirection(ctx, check.messageIndex);
            if (stale) return stale;
          }
          input.source = { kind: 'user-message', ref: ctx.turnId, quote: check.quote, messageIndex: check.messageIndex };
        } else if (input.source?.kind === 'user-message') {
          return { ok: false, error: 'What the owner said is recorded with provenance "user" and a "quote" of their own words, not with a "user-message" source.' };
        } else if (input.source?.kind && !SOURCE_KINDS.includes(input.source.kind)) {
          return { ok: false, error: `Source kind "${input.source.kind}" is reserved for the host.` };
        }
        const fact = ledger.assert(input);
        if (fact.provenance !== 'user') return { ok: true, fact };
        const effect = ctx.runtime.applyOwnerFact(ctx.caseId, fact);
        return {
          ok: true,
          fact,
          ...(effect.applied ? { effect: effect.applied } : {}),
          ...(effect.note ? { note: effect.note } : {}),
          ...(effect.error ? { warning: effect.error } : {})
        };
      }
```

In `src/tools/builtin/case-tools.js`, replace

```js
      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  })
}));
```

with

```js
      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  }, { params })
}));
```

In `src/tools/builtin/case-tools.js`, replace

```js
  description: 'Read or update the case brief. "why", "hardConstraints" and "alreadyTried" can only be set from what the owner said (provenance "user"), which also requires a "quote" of the owner\'s own words matching this chat\'s owner messages. completeGating marks the brief ready; recommendations are refused until then.',
```

with

```js
  description: 'Read or update the case brief. "why", "hardConstraints", "alreadyTried", "materiality", "deadline" and "safeDefaults" can only be set from what the owner said (provenance "user"), which also requires a "quote" of the owner\'s own words matching this chat\'s owner messages. completeGating marks the brief ready; recommendations are refused until then.',
```

and replace

```js
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality'] },
```

with

```js
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality', 'safeDefaults'] },
```

and replace

```js
      quote: { type: 'string', description: 'Required when updating/appending "why", "hardConstraints" or "alreadyTried" with provenance "user": a substring of something the owner actually said in this chat.' },
```

with

```js
      quote: { type: 'string', description: 'Required for the owner-only fields ("why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults") with provenance "user": a substring of something the owner actually said in this chat.' },
```

In `src/tools/builtin/case-tools.js`, replace

```js
  execute: (params, options) => withCase(options, async (ctx) => {
    const brief = ctx.runtime.brief(ctx.caseId);
```

with

```js
  execute: (params, options) => withCase(options, (p) => `Brief.${p.action}`, async (ctx) => {
    const brief = ctx.runtime.brief(ctx.caseId);
```

and replace

```js
    return { ok: true, brief: data };
  })
}));
```

with

```js
    return { ok: true, brief: data };
  }, { params })
}));
```

In `src/tools/builtin/case-tools.js`, replace

```js
  execute: (params, options) => withCase(options, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const bad = params.factIds.filter((id) => facts.get(id)?.status !== 'active');
```

with

```js
  execute: (params, options) => withCase(options, 'Decide', async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const bad = params.factIds.filter((id) => facts.get(id)?.status !== 'active');
```

and replace

```js
      ...(inferred.length ? { warning: `This decision rests on inferred facts (${inferred.join(', ')}). Say so when you report it.` } : {})
    };
  })
});
```

with

```js
      ...(inferred.length ? { warning: `This decision rests on inferred facts (${inferred.join(', ')}). Say so when you report it.` } : {})
    };
  }, { reoriented: true })
});
```

In `src/tools/builtin/case-tools.js`, replace

```js
  execute: (params, options) => withCase(options, async (ctx) => {
    const meta = ctx.runtime.getCase(ctx.caseId);
```

with

```js
  execute: (params, options) => withCase(options, 'Recommend', async (ctx) => {
    const meta = ctx.runtime.getCase(ctx.caseId);
```

and replace

```js
    return { ok: true, rendered, instruction: 'Present this to the owner as written: unknowns first, then the recommendation with its fact ids.' };
  })
});

module.exports = { LedgerTool, BriefTool, DecideTool, RecommendTool };
```

with

```js
    return { ok: true, rendered, instruction: 'Present this to the owner as written: unknowns first, then the recommendation with its fact ids.' };
  }, { reoriented: true })
});

module.exports = { LedgerTool, BriefTool, DecideTool, RecommendTool, withCase, SOURCE_KINDS };
```

Create `src/tools/builtin/case-unattended-tools.js`:

```js
// src/tools/builtin/case-unattended-tools.js
// Reorient, Ask and Fail (cases stage 2 spec §3.3, §3.4, §3.9). Like the
// stage-1 case tools they read options.caseContext and refuse by result.
const { Tool } = require('../tool-schema');
const { withCase } = require('./case-tools');
const { recommendationGate } = require('../../cases/gates');
const { FAILURE_CLASSES } = require('../../cases/status');

const ACTIONS = Object.freeze(['continue', 'adjust', 'ask']);
const NEXT = Object.freeze({
  continue: 'Carry on with what the case was doing.',
  adjust: 'Adjust the plan to what changed, then continue.',
  ask: 'Ask the owner with the Ask tool before acting on it.'
});
// Answers about these subjects are written by host code only (Fail's
// direction question, the budget question and the Grant button).
const RESERVED_SUBJECTS = new Set(['budget', 'direction']);

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (v) => String(v ?? '').trim().toLowerCase();

const ReorientTool = new Tool({
  name: 'Reorient',
  description: 'Acknowledge what changed since the case last looked before you recommend, decide or fail. Required when the orientation says "Re-orientation required". "affects" must list every decision whose cited facts changed. With a budget threshold pending, "note" must say what is left and whether finishing is worth it.',
  parameters: {
    type: 'object',
    properties: {
      changed: { type: 'string', description: 'What changed, in one or two sentences' },
      affects: { type: 'array', items: { type: 'string' }, description: 'Decision ids (D-001…) the change affects' },
      action: { type: 'string', enum: [...ACTIONS] },
      note: { type: 'string', description: 'What you will do about it' }
    },
    required: ['changed', 'action', 'note']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Reorient', async (ctx) => {
    const turn = ctx.runtime.turns.get(ctx.caseId);
    if (!turn || turn.turnId !== ctx.turnId || !turn.reorientPending) {
      return { ok: false, error: 'No re-orientation is pending in this turn.' };
    }
    if (!text(params.changed)) return { ok: false, error: '"changed" is required: say what changed.' };
    if (!ACTIONS.includes(params.action)) return { ok: false, error: '"action" must be continue, adjust or ask.' };
    if (!text(params.note)) return { ok: false, error: '"note" is required.' };
    const affects = Array.isArray(params.affects) ? params.affects.map(String) : [];
    const known = new Set(ctx.runtime.records(ctx.caseId).decisions().map((d) => d.id));
    const unknownIds = affects.filter((a) => !known.has(a));
    if (unknownIds.length) return { ok: false, error: `These are not decision ids in this case: ${unknownIds.join(', ')}.` };
    const pending = (turn.triggers || []).filter((t) => t.blocking);
    const needed = [...new Set(pending.filter((t) => t.kind === 'decision-undermined').flatMap((t) => t.decisionIds || []))];
    const missing = needed.filter((d) => !affects.includes(d));
    if (missing.length) return { ok: false, error: `"affects" must include ${missing.join(', ')}: facts they cite have changed.` };
    if (pending.some((t) => t.kind === 'budget-threshold') && text(params.note).length < 40) {
      return { ok: false, error: 'A budget threshold is pending: the note must say what is left and whether finishing is worth it (at least 40 characters).' };
    }
    const journal = ctx.runtime.recordReorientation(ctx.caseId, turn, {
      changed: text(params.changed), affects, action: params.action, note: text(params.note)
    });
    return { ok: true, journal, next: NEXT[params.action] };
  })
});

const AskTool = new Tool({
  name: 'Ask',
  description: 'Ask the owner a question, or send a briefing. It is delivered to the owner and answered later; the answer arrives as an owner fact. Never assume the answer. Briefings follow the brief\'s materiality: tags in "ignore" are refused, and only tags in "tell" may be above low urgency. "defaultOnSilence" may name an option only if the brief\'s safeDefaults lists it.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The whole message to the owner, self-contained' },
      kind: { type: 'string', enum: ['question', 'briefing'] },
      options: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
        description: 'Up to 6 answer buttons; ids are lower-case words'
      },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      expiresAt: { type: 'string', description: 'RFC3339 date-time, at most 30 days out' },
      defaultOnSilence: { type: 'string', description: '"hold" (default), or an option id the brief lists in safeDefaults' },
      resolves: { type: 'string', description: 'An active unknown fact id the answer resolves' },
      about: { type: 'object', properties: { subject: { type: 'string' }, attr: { type: 'string' } }, description: 'Where the answer fact lands' },
      materiality: { type: 'string', description: 'For a briefing: the materiality tag it falls under' }
    },
    required: ['question']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Ask', async (ctx) => {
    const kind = params.kind || 'question';
    if (!['question', 'briefing'].includes(kind)) {
      return { ok: false, error: 'kind must be "question" or "briefing". Approvals are created by the host, not by Ask.' };
    }
    const about = params.about && typeof params.about === 'object' ? params.about : null;
    if (about && RESERVED_SUBJECTS.has(norm(about.subject))) {
      return { ok: false, error: `Answers about "${about.subject}" are recorded by the host. Ask without "about", or use Fail when you need the owner's direction.` };
    }
    let brief = {};
    try {
      brief = ctx.runtime.brief(ctx.caseId).read().data || {};
    } catch {
      brief = {};
    }
    const notes = ['Not answered yet. Do not assume the answer.'];
    let urgency = params.urgency || (kind === 'briefing' ? 'low' : 'normal');
    if (kind === 'briefing') {
      const tag = params.materiality ? norm(params.materiality) : '';
      const ignore = (Array.isArray(brief.materiality?.ignore) ? brief.materiality.ignore : []).map(norm);
      const tell = (Array.isArray(brief.materiality?.tell) ? brief.materiality.tell : []).map(norm);
      if (tag && ignore.includes(tag)) {
        return { ok: false, error: `The brief says not to contact the owner about "${params.materiality}". Journal it instead.` };
      }
      if (urgency !== 'low' && !(tag && tell.includes(tag))) {
        urgency = 'low';
        notes.push(`Urgency lowered to low: "${params.materiality || 'untagged'}" is not in the brief's materiality.tell list.`);
      }
    }
    const defaultOnSilence = params.defaultOnSilence || 'hold';
    if (defaultOnSilence !== 'hold') {
      const option = (Array.isArray(params.options) ? params.options : []).find((o) => o && o.id === defaultOnSilence);
      let fromPlaybooks = [];
      if (typeof ctx.runtime.playbookSafeDefaults === 'function') {
        try {
          fromPlaybooks = ctx.runtime.playbookSafeDefaults(ctx.caseId) || [];
        } catch {
          fromPlaybooks = [];
        }
      }
      const safe = new Set([...(Array.isArray(brief.safeDefaults) ? brief.safeDefaults : []), ...fromPlaybooks].map(norm));
      if (!option || !(safe.has(norm(option.id)) || safe.has(norm(option.label)))) {
        return { ok: false, error: 'Only "hold" is allowed: the brief declares no safe default matching this option.' };
      }
    }
    if (params.resolves) {
      const f = ctx.runtime.ledger(ctx.caseId).view().facts.get(params.resolves);
      if (!f || f.provenance !== 'unknown' || f.status !== 'active') {
        return { ok: false, error: `"resolves" must name an active unknown; ${params.resolves} is not one.` };
      }
    }
    const payload = { type: 'ask', turnId: ctx.turnId };
    if (params.resolves) payload.resolves = params.resolves;
    if (about) payload.about = { subject: String(about.subject || ''), attr: String(about.attr || '') };
    if (kind === 'briefing' && params.materiality) payload.materiality = String(params.materiality);
    const created = ctx.runtime.createQuestion(ctx.caseId, {
      kind,
      text: params.question,
      options: params.options,
      urgency,
      expiresAt: params.expiresAt ?? null,
      defaultOnSilence,
      payload
    }, { charge: kind === 'question' });
    if (created.held) {
      return { ok: false, error: 'The daily question allowance (questionsPerDay) is spent. Record what you need as an unknown and ask again tomorrow.' };
    }
    return {
      ok: true,
      questionId: created.id,
      urgency: created.urgency,
      delivered: Array.isArray(created.deliveries) && created.deliveries.length > 0,
      note: notes.join(' ')
    };
  })
});

const FailTool = new Tool({
  name: 'Fail',
  description: 'Report a dead end and stop. Writes a failure report (what you tried, why it failed, the open unknowns) with at most one recommendation, which must pass the recommendation gate; moves the case to needs-direction and asks the owner how to proceed. Present the returned text as written and do not start another approach.',
  parameters: {
    type: 'object',
    properties: {
      failureClass: { type: 'string', enum: [...FAILURE_CLASSES] },
      what: { type: 'string', description: 'The approach that failed' },
      tried: { type: 'array', items: { type: 'string' }, description: 'What you tried, at least one item' },
      why: { type: 'string', description: 'Why it failed' },
      unknowns: { type: 'array', items: { type: 'string' }, description: 'Unknown fact ids that matter now' },
      recommendation: {
        type: 'object',
        description: 'Optional: the one recommendation',
        properties: {
          claims: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, factIds: { type: 'array', items: { type: 'string' } } }, required: ['text', 'factIds'] }
          }
        },
        required: ['claims']
      }
    },
    required: ['failureClass', 'what', 'tried', 'why']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Fail', async (ctx) => {
    if (!FAILURE_CLASSES.includes(params.failureClass)) {
      return { ok: false, error: `failureClass must be one of ${FAILURE_CLASSES.join(', ')}.` };
    }
    if (!text(params.what) || !text(params.why)) return { ok: false, error: '"what" and "why" are required.' };
    const tried = Array.isArray(params.tried) ? params.tried.map((t) => String(t).trim()).filter(Boolean) : [];
    if (!tried.length) return { ok: false, error: '"tried" must list at least one thing you tried.' };
    const unknowns = Array.isArray(params.unknowns) ? params.unknowns.map(String) : [];
    const { facts } = ctx.runtime.ledger(ctx.caseId).view();
    const notUnknown = unknowns.filter((id) => facts.get(id)?.provenance !== 'unknown');
    if (notUnknown.length) return { ok: false, error: `"unknowns" must be unknown fact ids; these are not: ${notUnknown.join(', ')}.` };
    let recommendation = null;
    if (params.recommendation) {
      const claims = Array.isArray(params.recommendation.claims) ? params.recommendation.claims : [];
      const gate = recommendationGate({ status: ctx.runtime.getCase(ctx.caseId).status, claims, facts });
      if (!gate.ok) {
        return {
          ok: false,
          error: 'The recommendation in this failure report was refused by the recommendation gate. Fix it, or send the report without one.',
          failures: gate.failures
        };
      }
      recommendation = { claims };
    }
    const result = ctx.runtime.recordFailure(ctx.caseId, {
      failureClass: params.failureClass,
      what: text(params.what),
      tried,
      why: text(params.why),
      unknowns,
      recommendation,
      turnId: ctx.turnId
    });
    return { ok: true, rendered: result.rendered, instruction: 'Present this as written and stop. Do not start another approach.' };
  }, { params, reoriented: true })
});

function registerCaseUnattendedTools(registry) {
  registry.register(ReorientTool);
  registry.register(AskTool);
  registry.register(FailTool);
}

module.exports = { ReorientTool, AskTool, FailTool, registerCaseUnattendedTools };
```

In `src/cases/chat-integration.js`, replace

```js
const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend']);
```

with

```js
const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']);
```

and replace

```js
  '- When an approach fails, report what happened and stop, with at most one recommendation. Do not start a new plan unasked.',
```

with

```js
  '- When an approach fails, call Fail with what you tried and why, with at most one recommendation, then stop. Do not start a new plan unasked.',
  '- If the orientation says "Re-orientation required", call Reorient first; Recommend, Decide and Fail are refused until you do.',
  '- Contact the owner only through the Ask tool. The answer arrives later as an owner fact; never assume it.',
```

In `src/tools/index.js`, replace

```js
  toolRegistry.register(RecommendTool);
```

with

```js
  toolRegistry.register(RecommendTool);
  require('./builtin/case-unattended-tools').registerCaseUnattendedTools(toolRegistry);
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-tools.test.js tests/cases-regressions.test.js tests/cases-chat.test.js tests/cases-core.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/tools/builtin/case-tools.js src/tools/builtin/case-unattended-tools.js src/cases/chat-integration.js src/tools/index.js tests/cases-tools.test.js tests/cases-regressions.test.js
git commit -m "feat(cases): Reorient, Ask and Fail tools; case tools obey status rules and re-orientation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The sweep and the wake-up turn

**Files:**
- Create: `src/cases/turn-runner.js`
- Modify: `src/cases/case-runtime.js` (insert `sweep` and `runDueWakeups` after `routedProvider`)
- Test: `tests/cases-turn-runner.test.js`

**Interfaces:**
- Consumes: `CaseRuntime.beginTurn`, `endTurn`, `caseContext`, `routedProvider`, `usageHook`, `createQuestion`, `onCrossings`, `systemAction`, `settings`, `wakeups`, `questions`, `budget`, `turns` (Tasks 10–11); `CASE_TOOL_NAMES`, `WAKEUP_BASE_TOOLS`, `shapeToolDefinitions`, `buildCaseSystemPrompt`, `casePrompter` (`chat-integration.js`); `NO_RETRY` (`roles.js`); host `createToolExecutor(event, env, requester, executorOptions)`, `toolRegistry`, `AgentLoop`, `getUsageTracker`, optional C3 `getExecutorRegistry().pollWakeup(caseId, wakeup) → { material }`.
- Produces: `turn-runner.js` exports `ORIENT_PROMPT`, `WAKEUP_PROMPT`, `parseOrient(text) → { changed, why } | null`, `sweepCase(runtime, id, now) → { due: string[], quiet: number }`, `runWakeupTurn(runtime, caseId, dueIds, now) → { outcome: 'quiet'|'acted'|'skipped'|'failed'|'busy'|'none' }`, `runDueWakeups(runtime, now) → { ran, quiet, skipped, busy, failed }`. `CaseRuntime.sweep(id, now)` and `CaseRuntime.runDueWakeups(now)` delegate to them.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-turn-runner.test.js`:

```js
// tests/cases-turn-runner.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { initializeTools, toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const AgentLoop = require('../src/execution/agent-loop');
const { CaseRuntime } = require('../src/cases');
const { CASE_TOOL_NAMES } = require('../src/cases/chat-integration');
const { parseOrient } = require('../src/cases/turn-runner');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runner-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const MIN = 60000;
const metrics = (costUsd) => ({ provider: 'openai', model: 'gpt-judge', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd });
const advance = (clock, ms) => { clock.now = new Date(clock.now.getTime() + ms); };
const zero = { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0 };

function harness({ settings = {}, orient = '{"changed": true, "why": "a new answer"}', judge = [], host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T12:00:00.000Z') };
  const calls = { orient: 0, judge: 0, judgeTools: [], results: [], executorOptions: null };
  const script = [...judge];
  let runtime = null;
  const router = {
    async routeWithFallback(tier, messages, opts) {
      if (Array.isArray(opts.tools) && opts.tools.length) {
        calls.judge += 1;
        calls.judgeTools.push(opts.tools.map((t) => t.name));
        const next = script.shift() || { type: 'text', content: 'Nothing else to do.' };
        return typeof next === 'function' ? next(runtime) : next;
      }
      calls.orient += 1;
      if (orient instanceof Error) throw orient;
      return orient;
    }
  };
  const tracker = { record: (e) => ({ provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }) };
  runtime = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases: { timeZone: 'UTC', ...settings } }),
    host: {
      inferenceRouter: router,
      resolveInference: async () => null,
      toolRegistry,
      AgentLoop,
      getUsageTracker: () => tracker,
      interactive: () => true,
      notify: () => {},
      createToolExecutor: async (_event, _env, _requester, opts) => {
        calls.executorOptions = opts;
        const executor = new ToolExecutor({
          workingDirectory: opts.workingDirectory,
          allowedDirectories: opts.allowedDirectories,
          requireApproval: true,
          denyAutoApproval: opts.denyAutoApproval,
          allowedToolNames: opts.allowedToolNames,
          useSandbox: false,
          extraToolOptions: { caseContext: opts.caseContext }
        });
        executor.on('postExecute', (e) => calls.results.push([e.toolName, e.result]));
        return executor;
      },
      ...host
    }
  });
  return { runtime, clock, calls };
}

async function activeCase(rt, title = 'Lakeside lot') {
  const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
  rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// A one-shot wake-up due one minute from now; the clock is then moved there.
function dueWakeup(rt, c, clock) {
  const id = rt.wakeups(c.id).register({ kind: 'retry', at: clock.now.toISOString(), payload: { key: 'test' } });
  advance(clock, MIN);
  return id;
}

const wakeupJournals = (c) => fs.readdirSync(path.join(c.dir, 'journal'))
  .filter((n) => /-wakeup(-\d+)?\.md$/.test(n))
  .map((n) => fs.readFileSync(path.join(c.dir, 'journal', n), 'utf8'));

describe('parseOrient', () => {
  it('reads {changed, why} from the reply and rejects anything else', () => {
    assert.deepStrictEqual(parseOrient('```json\n{"changed": false, "why": "nothing new"}\n```'), { changed: false, why: 'nothing new' });
    assert.strictEqual(parseOrient('maybe'), null);
    assert.strictEqual(parseOrient('{"changed": "no"}'), null);
  });
});

describe('runDueWakeups', () => {
  it('quiet path: one orient call, a one-line journal entry, the wake-up done, a clean tree', async () => {
    const { runtime, clock, calls } = harness({ orient: '{"changed": false, "why": "nothing new"}' });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 0]);
    assert.strictEqual(runtime.wakeups(c.id).list().some((w) => w.id === id), false);
    assert.deepStrictEqual(wakeupJournals(c), [`quiet: ${id} — nothing new\n`]);
    assert.strictEqual(await git.isDirty(c.dir), false);
  });

  it('change path: the judge acts, confined, and its usage lands in budget.json', async () => {
    const { runtime, clock, calls } = harness({
      judge: [
        { type: 'tool_use', toolCalls: [{ toolName: 'Ledger', toolUseId: 't1', parameters: { action: 'query' } }], llmMetrics: metrics(0.25) },
        { type: 'text', content: 'Checked the ledger; nothing to do.', llmMetrics: metrics(0.25) }
      ]
    });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 2]);
    assert.deepStrictEqual(wakeupJournals(c), [`# Wake-up ${id}\n\nChecked the ledger; nothing to do.\n`]);
    assert.strictEqual(runtime.budget(c.id).status().usd.spent, 0.5);
    const opts = calls.executorOptions;
    assert.strictEqual(opts.denyAutoApproval, true);
    assert.deepStrictEqual(opts.allowedDirectories, []);
    assert.deepStrictEqual([...opts.allowedToolNames].sort(), [...CASE_TOOL_NAMES, 'Read', 'Glob', 'Grep'].sort());
    assert.deepStrictEqual([opts.caseContext.ownerMessages, opts.caseContext.source], [[], 'wakeup']);
    const offered = calls.judgeTools[0];
    for (const name of ['Read', 'Glob', 'Grep', ...CASE_TOOL_NAMES]) assert.ok(offered.includes(name), name);
    for (const name of ['Bash', 'WebFetch', 'WebSearch', 'AskUser', 'Write']) assert.ok(!offered.includes(name), name);
    assert.deepStrictEqual(calls.results.map(([name, r]) => [name, r.ok]), [['Ledger', true]]);
  });

  it('a mock model calling message and Bash is refused by allowedToolNames', async () => {
    const { runtime, clock, calls } = harness({
      judge: [
        { type: 'tool_use', toolCalls: [
          { toolName: 'message', toolUseId: 't1', parameters: { text: 'Here is the case data' } },
          { toolName: 'Bash', toolUseId: 't2', parameters: { command: 'echo hi' } }
        ] },
        { type: 'text', content: 'Could not send.' }
      ]
    });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    await runtime.runDueWakeups(clock.now);
    const byName = Object.fromEntries(calls.results);
    assert.deepStrictEqual(byName.message, { success: false, error: 'Tool "message" is not available in this turn.' });
    assert.deepStrictEqual(byName.Bash, { success: false, error: 'Tool "Bash" is not available in this turn.' });
  });

  it('a pending trigger skips the orient step', async () => {
    const { runtime, clock, calls } = harness();
    const c = await activeCase(runtime);
    const gis = runtime.ledger(c.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    runtime.records(c.id).recordDecision({ decision: 'Price off GIS', factIds: [gis.id] });
    runtime.ledger(c.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
    dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 1]);
  });

  it('a retry wake-up for an answered question skips the orient step', async () => {
    const { runtime, clock, calls } = harness();
    const c = await activeCase(runtime);
    const q = runtime.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    await runtime.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Yes' });
    advance(clock, MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 1]);
  });

  it('unparseable orient output escalates to the judge', async () => {
    const { runtime, clock, calls } = harness({ orient: 'I think something may have changed' });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 1]);
  });

  it('skips a wake-up once the day\'s turns are spent, without charging or calling a model', async () => {
    const { runtime, clock, calls } = harness({ settings: { budgets: { turnsPerDay: 1 } } });
    const c = await activeCase(runtime);
    runtime.budget(c.id).charge('turnsPerDay', 1);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, skipped: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 0]);
    assert.strictEqual(runtime.budget(c.id).status().turnsPerDay.spent, 1);
    assert.deepStrictEqual(wakeupJournals(c), ['skipped: daily turn budget spent\n']);
    assert.strictEqual(runtime.wakeups(c.id).list().find((w) => w.id === id).nextAt, '2026-09-24T00:00:00.000Z');
  });

  it('an owner pause during the judge loop aborts the turn and marks it skipped, with no failure count', async () => {
    const { runtime, clock } = harness({
      judge: [
        (rt) => {
          rt.setStatus(rt.listCases()[0].id, 'paused', { kind: 'owner', by: 'owner' });
          return { type: 'tool_use', toolCalls: [{ toolName: 'Ledger', toolUseId: 't1', parameters: { action: 'query' } }] };
        }
      ]
    });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, skipped: 1 });
    const w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.deepStrictEqual([w.lastOutcome, w.attempts], ['skipped', 0]);
    assert.deepStrictEqual(wakeupJournals(c), ['skipped: case paused\n']);
    assert.strictEqual(runtime.turns.size, 0);
  });

  it('skips a case whose owner is mid-turn, then runs it after endTurn', async () => {
    const { runtime, clock, calls } = harness({ orient: '{"changed": false, "why": "nothing new"}' });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    const owner = await runtime.beginTurn(c.id, { turnId: 'turn-owner' });
    const wakeFile = path.join(c.dir, '.kl', 'wakeups.json');
    const before = { wakeups: fs.readFileSync(wakeFile, 'utf8'), commits: (await git.git(c.dir, ['rev-list', '--count', 'HEAD'])).trim() };
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, busy: 1 });
    assert.strictEqual(calls.orient, 0);
    assert.strictEqual(fs.readFileSync(wakeFile, 'utf8'), before.wakeups);
    assert.strictEqual((await git.git(c.dir, ['rev-list', '--count', 'HEAD'])).trim(), before.commits);
    await runtime.endTurn(owner, {});
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.strictEqual(calls.orient, 1);
  });

  it('orient provider down: failed, backoff, one briefing on the third failure, no judge call', async () => {
    const down = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    const { runtime, clock, calls } = harness({ orient: down });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    const failing = () => runtime.questions(c.id).open().filter((q) => q.payload.type === 'wakeups-failing');
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, failed: 1 });
    let w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.deepStrictEqual([w.attempts, w.nextAt], [1, new Date(clock.now.getTime() + 5 * MIN).toISOString()]);
    assert.deepStrictEqual(failing(), []);
    for (const minutes of [5, 15]) {
      advance(clock, minutes * MIN);
      assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, failed: 1 });
    }
    w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.strictEqual(w.attempts, 3);
    assert.strictEqual(failing().length, 1);
    assert.strictEqual(failing()[0].urgency, 'normal');
    advance(clock, 60 * MIN);
    await runtime.runDueWakeups(clock.now);
    assert.strictEqual(failing().length, 1, 'deduplicated while open');
    assert.strictEqual(calls.judge, 0);
    const entries = wakeupJournals(c);
    assert.strictEqual(entries.length, 4);
    assert.ok(entries.every((e) => e.startsWith('failed: 503 Service Unavailable')));
  });

  it('in needs-direction only poll-executor and deadline-check run; polling needs a material change (C3 stub)', async () => {
    let polls = 0;
    const registry = { pollWakeup: async () => { polls += 1; return { material: polls > 1 }; }, cancelOpenJobs: () => {} };
    const { runtime, clock, calls } = harness({ host: { getExecutorRegistry: () => registry } });
    const c = await activeCase(runtime);
    runtime.setStatus(c.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    const poll = runtime.wakeups(c.id).register({ kind: 'poll-executor', every: 5 * MIN, payload: { key: 'phone-agent' } });
    const retry = dueWakeup(runtime, c, clock);
    advance(clock, 5 * MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.strictEqual(calls.orient, 0);
    advance(clock, 5 * MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.strictEqual(polls, 2);
    const left = runtime.wakeups(c.id).list().map((w) => w.id);
    assert.ok(left.includes(retry), 'the retry waits for direction');
    assert.ok(left.includes(poll));
  });

  it('cancels every wake-up of an abandoned case, and does nothing when wake-ups are off', async () => {
    const { runtime, clock } = harness();
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    runtime.store.updateMeta(c.id, { status: 'abandoned' });
    await runtime.runDueWakeups(clock.now);
    assert.deepStrictEqual(runtime.wakeups(c.id).list(), []);

    const off = harness({ settings: { wakeups: { enabled: false } } });
    const d = await activeCase(off.runtime);
    dueWakeup(off.runtime, d, off.clock);
    assert.deepStrictEqual(await off.runtime.runDueWakeups(off.clock.now), zero);
    assert.strictEqual(off.calls.orient, 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-turn-runner.test.js`
Expected: FAIL with `Cannot find module '../src/cases/turn-runner'`

- [ ] **Step 3: Implement**

Create `src/cases/turn-runner.js`:

```js
// src/cases/turn-runner.js
// The cases:wakeups sweep and the headless wake-up turn (cases stage 2 spec
// §3.6, §3.7). A cheap orient call decides whether anything changed; only
// then does a judge loop act, confined to the case tools and Read/Glob/Grep.
const crypto = require('crypto');
const {
  CASE_TOOL_NAMES, WAKEUP_BASE_TOOLS, shapeToolDefinitions, buildCaseSystemPrompt, casePrompter
} = require('./chat-integration');
const { NO_RETRY } = require('./roles');
const { createLogger } = require('../logging');

const log = createLogger('cases/wakeups');

const ORIENT_PROMPT = [
  'You are the orient step of an unattended case wake-up. Nobody is watching.',
  'Read the orientation and the due wake-ups. Decide only whether anything changed that needs work now: a new answer or fact, a deadline or budget line, a wake-up that asks for work.',
  'Reply with JSON only: {"changed": true or false, "why": "<one sentence>"}.',
  'When unsure, answer "changed": true.'
].join('\n');

const WAKEUP_PROMPT = [
  'Wake-up mode. Nobody is watching this turn.',
  '- Contact the owner only through the Ask tool, and never assume an answer.',
  "- The brief's materiality decides whether something is worth a briefing: tags in \"tell\" may be briefed, tags in \"ignore\" are only journaled.",
  '- Only the case tools and Read, Glob and Grep are available. Other tools are refused.',
  '- If you are blocked or the approach is a dead end, call Fail with what you tried, and stop.',
  '- End with a short summary of what you did; it is journaled.'
].join('\n');

const oneLine = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function textOf(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply.content === 'string') return reply.content;
  return '';
}

function parseOrient(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    if (!v || typeof v.changed !== 'boolean') return null;
    return { changed: v.changed, why: typeof v.why === 'string' ? v.why : '' };
  } catch {
    return null;
  }
}

// Providers' sendMessage usually returns bare text; charge the orient call
// only when it reports metrics.
function recordOneShotUsage(runtime, turn, reply) {
  const m = reply && typeof reply === 'object' ? reply.llmMetrics : null;
  if (!m) return;
  const tracker = typeof runtime.host?.getUsageTracker === 'function' ? runtime.host.getUsageTracker() : null;
  if (!tracker || typeof tracker.record !== 'function') return;
  runtime.usageHook(turn)(tracker.record({
    provider: m.provider, model: m.model, inputTokens: m.inputTokens, outputTokens: m.outputTokens, totalTokens: m.totalTokens, costUsd: m.costUsd
  }));
}

const dueLines = (due) => due.map((w) => `- ${w.id} ${w.kind}${w.payload?.key ? ` (${w.payload.key})` : ''}, due ${w.nextAt}`);

// Runs inside systemAction('sweep'): housekeeping every case gets each tick,
// then the ids of the due wake-ups that need a turn.
async function sweepCase(runtime, id, now) {
  const meta = runtime.getCase(id);
  const store = runtime.wakeups(meta.id);
  store.reanchor(now);
  runtime.questions(meta.id).expire(now);
  const budget = runtime.budget(meta.id);
  const deadlineNow = budget.charge('deadline', 0).crossedNow;
  if (deadlineNow.length) runtime.onCrossings(meta.id, 'deadline', deadlineNow);
  const reconciled = budget.reconcile();
  for (const [category, crossed] of Object.entries(reconciled)) runtime.onCrossings(meta.id, category, crossed);
  const newDeadline = [...deadlineNow, ...(reconciled.deadline || [])];

  const status = runtime.getCase(meta.id).status;
  if (status === 'done' || status === 'abandoned') {
    store.cancelAll();
    return { due: [], quiet: 0 };
  }
  if (status === 'draft' || status === 'paused') return { due: [], quiet: 0 };

  const registry = typeof runtime.host?.getExecutorRegistry === 'function' ? runtime.host.getExecutorRegistry() : null;
  const due = [];
  let quiet = 0;
  for (const w of store.due(now)) {
    if (w.kind === 'deadline-check') {
      if (newDeadline.some((t) => t >= 80)) due.push(w.id);
      else {
        store.markRan(w.id, { outcome: 'quiet', now });
        quiet += 1;
      }
      continue;
    }
    if (w.kind === 'poll-executor') {
      let material = false;
      if (registry && typeof registry.pollWakeup === 'function') {
        try {
          material = Boolean((await registry.pollWakeup(meta.id, w))?.material);
        } catch (err) {
          store.markRan(w.id, { outcome: 'failed', error: err.message, now });
          continue;
        }
      }
      if (material) due.push(w.id);
      else {
        store.markRan(w.id, { outcome: 'quiet', now });
        quiet += 1;
      }
      continue;
    }
    if (status === 'needs-direction') continue;
    due.push(w.id);
  }
  return { due, quiet };
}

async function runWakeupTurn(runtime, caseId, dueIds, now = runtime.now()) {
  const host = runtime.host || {};
  const turnId = `wakeup-${now.getTime()}-${crypto.randomBytes(3).toString('hex')}`;
  let turn;
  try {
    turn = await runtime.beginTurn(caseId, { turnId, source: 'wakeup' });
  } catch (err) {
    if (err && err.code === 'CASE_BUSY') return { outcome: 'busy' };
    throw err;
  }
  let closed = false;
  const close = async (outcome, journal, summary) => {
    if (closed) return { outcome };
    closed = true;
    try {
      await runtime.endTurn(turn, { summary, journal, journalKind: 'wakeup' });
    } catch (err) {
      log.warn(`Wake-up commit for case ${caseId} failed: ${err.message}`);
    }
    return { outcome };
  };

  try {
    const store = runtime.wakeups(caseId);
    // Another process may have run them while this one waited for the lock.
    const due = store.due(now).filter((w) => dueIds.includes(w.id));
    if (!due.length) return await close('none', null, 'wake-up: nothing due');
    const ids = due.map((w) => w.id);
    const mark = (outcome, error = null) => {
      for (const id of ids) store.markRan(id, { outcome, error, now: runtime.now() });
    };
    const skipped = (why) => {
      mark('skipped');
      return close('skipped', `skipped: ${why}`, `wake-up skipped: ${why}`);
    };
    const failed = (err) => {
      if (turn.signal.aborted) return skipped(String(turn.signal.reason || 'aborted'));
      const message = err?.message || String(err);
      mark('failed', message);
      const attempts = Math.max(0, ...ids.map((id) => store.list().find((w) => w.id === id)?.attempts || 0));
      if (attempts >= 3) {
        try {
          runtime.createQuestion(caseId, {
            kind: 'briefing',
            urgency: 'normal',
            text: `${turn.title}: wake-ups have failed ${attempts} times in a row (${oneLine(message, 160)}). The case keeps retrying with backoff.`,
            payload: { type: 'wakeups-failing', key: 'wakeups-failing', mcpAnswerable: false }
          }, { charge: false });
        } catch (e) {
          log.warn(`Could not brief about failing wake-ups on ${caseId}: ${e.message}`);
        }
      }
      return close('failed', `failed: ${oneLine(message, 300)}`, 'wake-up failed');
    };

    const status = runtime.getCase(caseId).status;
    if (status !== 'active' && status !== 'needs-direction') return await skipped(`case is ${status}`);
    if (turn.dailyTurnsSpent) return await skipped('daily turn budget spent');

    let why = null;
    const answered = due.some((w) => w.kind === 'retry' && w.payload?.questionId);
    if (!turn.reorientPending && !answered) {
      let reply;
      try {
        reply = await runtime.routedProvider(turn, { role: 'orient' }).sendMessage(
          [{ sender: 'user', text: [`Now: ${now.toISOString()}`, '', 'Due wake-ups:', ...dueLines(due), '', turn.orientation].join('\n') }],
          { systemPrompt: ORIENT_PROMPT, abortSignal: turn.signal }
        );
      } catch (err) {
        return await failed(err);
      }
      recordOneShotUsage(runtime, turn, reply);
      const parsed = parseOrient(textOf(reply));
      if (parsed && parsed.changed === false) {
        mark('quiet');
        return await close('quiet', `quiet: ${ids.join(', ')} — ${oneLine(parsed.why || 'nothing changed')}`, 'wake-up quiet');
      }
      why = parsed ? parsed.why : 'The orient step gave no usable answer, so the case acts to be safe.';
    }

    try {
      const cfg = runtime.settings().wakeups;
      const executor = await host.createToolExecutor(null, null, null, {
        workingDirectory: turn.dir,
        allowedDirectories: [],
        caseContext: runtime.caseContext(turn, { ownerMessages: [], ownerMessageTimes: [] }),
        denyAutoApproval: true,
        allowedToolNames: new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS])
      });
      const registry = host.toolRegistry;
      const baseDefs = WAKEUP_BASE_TOOLS.map((n) => registry.get(n)).filter(Boolean).map((t) => t.toFunctionDefinition());
      const Loop = host.AgentLoop;
      const loop = new Loop(runtime.routedProvider(turn, { role: 'judge' }), executor, {
        maxIterations: cfg.maxIterations,
        usageTracker: typeof host.getUsageTracker === 'function' ? host.getUsageTracker() : null,
        onUsageRecorded: runtime.usageHook(turn),
        failoverPolicy: NO_RETRY,
        abortSignal: turn.signal,
        prompter: casePrompter(null)
      });
      const message = [
        'Wake-ups due:',
        ...dueLines(due),
        '',
        `Why now: ${why || 'a re-orientation trigger or an owner answer is pending.'}`,
        'Do what the case needs now, then stop.'
      ].join('\n');
      const result = await loop.run([{ sender: 'user', text: message }], shapeToolDefinitions(baseDefs, true, registry), {
        systemPrompt: buildCaseSystemPrompt(turn.orientation, WAKEUP_PROMPT)
      });
      if (turn.signal.aborted) return await skipped(String(turn.signal.reason || 'aborted'));
      mark('acted');
      return await close('acted', `# Wake-up ${ids.join(', ')}\n\n${String(result?.content || '(no summary)').trim()}`, `wake-up ${ids.join(', ')}`);
    } catch (err) {
      return await failed(err);
    }
  } catch (err) {
    log.warn(`Wake-up turn on case ${caseId} failed: ${err.message}`);
    return close('failed', `failed: ${oneLine(err.message, 300)}`, 'wake-up failed');
  }
}

async function runDueWakeups(runtime, now = runtime.now()) {
  const counts = { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0 };
  const cfg = runtime.settings().wakeups;
  if (!cfg.enabled || !runtime.host) return counts;
  // A case being created has no first commit; sweeping it now would break `createCase`.
  if (runtime.creating) return counts;
  let turns = 0;
  for (const meta of runtime.listCases()) {
    // An owner is mid-turn on this case in this process: leave it alone.
    if (runtime.turns.has(meta.id)) {
      counts.busy += 1;
      continue;
    }
    let sweep;
    try {
      sweep = await runtime.systemAction(meta.id, 'sweep', () => sweepCase(runtime, meta.id, now));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') counts.busy += 1;
      else {
        log.warn(`Wake-up sweep failed for case ${meta.slug}: ${err.message}`);
        counts.failed += 1;
      }
      continue;
    }
    counts.quiet += sweep.quiet;
    if (!sweep.due.length || turns >= cfg.maxCasesPerTick) continue;
    turns += 1;
    try {
      const { outcome } = await runWakeupTurn(runtime, meta.id, sweep.due, now);
      if (outcome === 'acted') counts.ran += 1;
      else if (Object.prototype.hasOwnProperty.call(counts, outcome)) counts[outcome] += 1;
    } catch (err) {
      log.warn(`Wake-up turn failed for case ${meta.slug}: ${err.message}`);
      counts.failed += 1;
    }
  }
  return counts;
}

module.exports = { ORIENT_PROMPT, WAKEUP_PROMPT, parseOrient, sweepCase, runWakeupTurn, runDueWakeups };
```

In `src/cases/case-runtime.js`, replace

```js
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
  }
```

with

```js
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
  }

  // ---- Wake-ups (spec §3.6); required lazily, turn-runner needs this module's exports ----

  sweep(id, now = this.now()) {
    return require('./turn-runner').sweepCase(this, id, now);
  }

  runDueWakeups(now = this.now()) {
    return require('./turn-runner').runDueWakeups(this, now);
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-turn-runner.test.js tests/cases-runtime-unattended.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/turn-runner.js src/cases/case-runtime.js tests/cases-turn-runner.test.js
git commit -m "feat(cases): wake-up sweep and the confined orient-then-judge wake-up turn

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Core wiring — settings, the runtime's host, the system job, shutdown and the provider fix

**Files:**
- Modify: `src/core/settings.js` (the `cases:` block of `mergeSettings`)
- Modify: `src/core/create-core.js` (six additive hunks, anchors quoted below; C2 is allowed several, program §5)
- Modify: `tests/cases-core.test.js` (the `defaults cases.root` settings test)
- Test: `tests/cases-service-wakeups.test.js`
- Test: `tests/executor-adapter-provider.test.js`

**Interfaces:**
- Consumes: `mergeCaseSettings` (Task 10), `ensureWakeupJob` and `CronExecutor.registerSystemJob` (Part 1), `CaseRuntime({ getSettings, host })`, `runDueWakeups`, `abortUnattended` (Tasks 10, 13).
- Produces: `mergeSettings(x).cases` carries the stage-2 defaults, merged key by key. `createToolExecutorWithApprovals(event, env, requester, { denyAutoApproval, allowedToolNames, … })` honours both options. `agentExecutorAdapter.execute(agent, message, { provider, model })` runs on that provider and model (spec §3.8 defect 1). `createCore().start()` registers `cases:wakeups` before the scheduler starts; `shutdown()` aborts wake-up turns before releasing locks.

- [ ] **Step 1: Write the failing test**

In `tests/cases-core.test.js`, replace

```js
  it('defaults cases.root to empty and merges an override', () => {
    assert.deepStrictEqual(mergeSettings({}).cases, { root: '' });
    assert.strictEqual(mergeSettings({ cases: { root: '/elsewhere' } }).cases.root, '/elsewhere');
  });
```

with

```js
  it('defaults cases.root to empty and merges an override', () => {
    assert.strictEqual(mergeSettings({}).cases.root, '');
    assert.strictEqual(mergeSettings({ cases: { root: '/elsewhere' } }).cases.root, '/elsewhere');
  });

  it('carries the stage 2 defaults and merges them key by key', () => {
    const merged = mergeSettings({}).cases;
    assert.strictEqual(merged.reorientAfterHours, 8);
    assert.strictEqual(merged.timeZone, '');
    assert.deepStrictEqual(merged.budgets, { usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null });
    assert.deepStrictEqual(merged.wakeups, { enabled: true, dailyAt: '09:00', maxIterations: 20, maxCasesPerTick: 3, retryBackoffMinutes: [5, 15, 60] });
    assert.deepStrictEqual(merged.roles.judge, { tier: 'smart' });
    const partial = mergeSettings({ cases: { budgets: { usd: 5 }, wakeups: { enabled: false } } }).cases;
    assert.deepStrictEqual([partial.budgets.usd, partial.budgets.turnsPerDay, partial.wakeups.enabled, partial.wakeups.dailyAt], [5, 48, false, '09:00']);
  });
```

Create `tests/cases-service-wakeups.test.js`:

```js
// tests/cases-service-wakeups.test.js
// createCore with service-style ports: no `ui`, so nothing is interactive.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { addSink } = require('../src/logging');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
const savedEnv = process.env.KL_CASES_ROOT;
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
});

function serviceDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-service-wakeups-'));
  tempDirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  };
}

describe('cases:wakeups in a service-style core', () => {
  it('registers the protected system job on start and dispatches it to runDueWakeups', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const scheduler = core.context.getCronScheduler();
      const job = scheduler.store.get('cases:wakeups');
      assert.deepStrictEqual([job.system, job.enabled, job.schedule.everyMs, job.payload.system], [true, true, 60000, 'cases:wakeups']);
      // Let the scheduler's first tick (100 ms after start) finish.
      await new Promise((r) => setTimeout(r, 300));
      const runtime = core.context.getCaseRuntime();
      let seen = null;
      runtime.runDueWakeups = async (now) => { seen = now; return { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0, probe: true }; };
      assert.deepStrictEqual(await scheduler.runNow('cases:wakeups'), { ok: true, ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0, probe: true });
      assert.ok(seen instanceof Date);
      await assert.rejects(scheduler.removeJob('cases:wakeups'), /system job managed by King Louie/);
    } finally {
      await core.shutdown();
    }
  });

  it('a question created there has no deliveries and logs the service-mode line', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const runtime = core.context.getCaseRuntime();
      const info = await runtime.createCase({ title: 'Lakeside lot' });
      const lines = [];
      const remove = addSink((r) => lines.push(r.line));
      let q;
      try {
        q = runtime.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
      } finally {
        remove();
      }
      assert.deepStrictEqual(q.deliveries, []);
      assert.ok(lines.some((l) => l.includes(`Case lakeside-lot asks ${q.id} (normal): Is the well shared?. No channel can deliver it until stage 4; it waits.`)), lines.join('\n'));
    } finally {
      await core.shutdown();
    }
  });

  it('passes denyAutoApproval and allowedToolNames through to the tool executor', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const env = { platform: process.platform };
      const confined = await core.context.createToolExecutorWithApprovals(null, env, null, { useSandbox: false, denyAutoApproval: true, allowedToolNames: new Set(['Ledger']) });
      assert.strictEqual(confined.denyAutoApproval, true);
      assert.deepStrictEqual(await confined.execute('Read', { file_path: __filename }), { success: false, error: 'Tool "Read" is not available in this turn.' });
      const open = await core.context.createToolExecutorWithApprovals(null, env, null, { useSandbox: false });
      assert.strictEqual(open.denyAutoApproval, false);
      assert.strictEqual(open.allowedToolNames, null);
    } finally {
      await core.shutdown();
    }
  });
});
```

Create `tests/executor-adapter-provider.test.js`:

```js
// tests/executor-adapter-provider.test.js
// Cases stage 2 spec §3.8 defect 1: a workflow-style execute with
// options.provider must run on that provider, not the active tier's.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const { listAgents } = require('../src/agents');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
after(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); });

describe('agent executor adapter', () => {
  it('runs on options.provider and options.model while the active tier maps to another provider', async () => {
    const used = [];
    const stub = (name) => class {
      constructor(apiKey) { this.apiKey = apiKey; }
      getProviderName() { return name; }
      getDefaultModel() { return `${name}-default`; }
      async sendMessage() { used.push([name, 'sendMessage']); return `from ${name}`; }
      async sendMessageWithTools(messages, tools, options) { used.push([name, options.model]); return { type: 'text', content: `from ${name}` }; }
    };
    const saved = { openai: ProviderFactory._registry.get('openai'), groq: ProviderFactory._registry.get('groq') };
    ProviderFactory.registerProvider('openai', stub('openai'));
    ProviderFactory.registerProvider('groq', stub('groq'));

    const savedEnv = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-adapter-'));
    tempDirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', { activeProvider: 'groq', inference: { activeTier: 'standard', tierMap: { standard: { provider: 'groq', model: 'groq-model' } } } });
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    });
    try {
      core.saveProviderToken('openai', 'sk-test-openai');
      core.saveProviderToken('groq', 'gsk-test-groq');
      await core.start();
      const adapter = core.context.getCronScheduler().executor.agentExecutor;
      const agent = listAgents().find((a) => a.id === 'main');
      const result = await adapter.execute(agent, 'Summarise the lot listing.', { provider: 'openai', model: 'gpt-stub' });
      assert.strictEqual(result.content, 'from openai');
      assert.deepStrictEqual(used, [['openai', 'gpt-stub']]);
    } finally {
      await core.shutdown();
      ProviderFactory.registerProvider('openai', saved.openai);
      ProviderFactory.registerProvider('groq', saved.groq);
      if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-core.test.js tests/cases-service-wakeups.test.js tests/executor-adapter-provider.test.js`
Expected: FAIL — `carries the stage 2 defaults` (`reorientAfterHours` is `undefined`), `registers the protected system job` (`job` is `undefined`), `passes denyAutoApproval…` (`Read` runs), and the adapter test with `used` equal to `[['groq', 'gpt-stub']]`.

- [ ] **Step 3: Implement**

In `src/core/settings.js`, replace

```js
    cases: {
      ...(DEFAULT_SETTINGS.cases || {}),
      ...(source.cases || {})
    },
```

with

```js
    // Cases stage 2 keys (budgets, roles, wakeups…) merge key by key over
    // their defaults (src/cases/defaults.js).
    cases: require('../cases/defaults').mergeCaseSettings(DEFAULT_SETTINGS.cases, source.cases),
```

In `src/core/create-core.js`, hunk 1 — replace

```js
const { shapeToolDefinitions } = require('../cases/chat-integration');
```

with

```js
const { shapeToolDefinitions } = require('../cases/chat-integration');
const { ensureWakeupJob } = require('../cases/wakeups');
```

Hunk 2 — replace

```js
      denyAutoApproval: remoteApprovals === 'deny',
```

with

```js
      // A caller (a case wake-up) may also ask for no auto-approval at all.
      denyAutoApproval: remoteApprovals === 'deny' || executorOptions.denyAutoApproval === true,
      // Cases stage 2: only these tools may run (wake-ups); null means no limit.
      allowedToolNames: executorOptions.allowedToolNames || null,
```

Hunk 3 (spec §3.8 defect 1) — replace

```js
        const runtime = await createAgentRuntime(
          { tier: requestedTier },
```

with

```js
        const runtime = await createAgentRuntime(
          {
            tier: requestedTier,
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {})
          },
```

Hunk 4 — replace

```js
    cronScheduler = new CronScheduler(cronStore, cronExecutor);
    cronScheduler.start();
```

with

```js
    cronScheduler = new CronScheduler(cronStore, cronExecutor);
    // Cases stage 2: one protected system job per data dir sweeps the cases.
    cronExecutor.registerSystemJob('cases:wakeups', () => caseRuntime.runDueWakeups(caseRuntime.now()));
    await ensureWakeupJob(cronStore);
    cronScheduler.start();
```

Hunk 5 — replace

```js
    // A turn cut off by quit must not leave its case locked.
    try {
      caseRuntime.releaseAll();
```

with

```js
    // A turn cut off by quit must not leave its case locked.
    try {
      caseRuntime.abortUnattended();
      caseRuntime.releaseAll();
```

Hunk 6 — replace

```js
  const caseRuntime = new CaseRuntime({
    root: resolveCasesRoot({ settings: getSettings(), env: process.env, dataDir: userDataPath })
  });
```

with

```js
  const caseRuntime = new CaseRuntime({
    root: resolveCasesRoot({ settings: getSettings(), env: process.env, dataDir: userDataPath }),
    getSettings,
    host: {
      inferenceRouter,
      resolveInference,
      createToolExecutor: createToolExecutorWithApprovals,
      toolRegistry,
      AgentLoop,
      getUsageTracker: () => usageTracker,
      hasProviderToken: (provider) => {
        try {
          getDecryptedProviderToken(provider);
          return true;
        } catch {
          return false;
        }
      },
      notify: (event, payload) => ui.send(event, payload),
      uiToast: deps.uiToastChannel || null,
      // F7 replaces this with a bridge-connected check in attached mode (R50).
      interactive: () => Boolean(deps.ui)
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-core.test.js tests/cases-service-wakeups.test.js tests/executor-adapter-provider.test.js tests/core-settings.test.js tests/core-create.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/core/settings.js src/core/create-core.js tests/cases-core.test.js tests/cases-service-wakeups.test.js tests/executor-adapter-provider.test.js
git commit -m "feat(core): case runtime host, cases:wakeups system job, confined executors, adapter honours provider

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The owner's case turn in the chat send path

**Files:**
- Modify: `src/ipc/chat-handlers.js` (case-turn block only: the `chat-integration` require, `beginTurn`, after the `UserPromptSubmit` deny branch, the `ownerMessages` builder, the RequestTools hint, `caseContext:`, `new AgentLoop(provider, …)`, the non-agent usage record)
- Modify: `tests/cases-chat.test.js` (harness: fake runtime methods, loop provider capture, a `contextAssembler` option; append a `describe` block)
- Test: `tests/cases-chat.test.js`

**Interfaces:**
- Consumes: `CaseRuntime.beginTurn(id, { turnId, source, ownerMessage })`, `runOwnerMessageHooks(turn)`, `caseContext(turn, { ownerMessages, ownerMessageTimes })`, `routedProvider(turn, { target, tier })`, `usageHook(turn)` (Tasks 10–11); `casePrompter` (Part 1); `NO_RETRY` (Part 1).
- Produces: owner case turns route through `routeWithFallback` with the owner's selection as the first target, charge usage to the case, refuse `AskUser`, get no RequestTools hint, and carry `ownerMessageTimes`. Non-case chats are unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/cases-chat.test.js`, replace

```js
function harness({ caseId = 'case-1', beginError = null, inferenceErrorOnCall = 0, loopWait = null, loopError = null, hookResult = null, loopContent = 'Answer text' } = {}) {
  const calls = { begin: [], end: [], executorOptions: null, run: null, resolveInferenceCalls: 0 };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      if (beginError) throw beginError;
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION-BLOCK' };
    },
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); return 'abc1234'; }
  };
  class FakeLoop {
    constructor(_provider, _executor, loopOptions = {}) {
      calls.loopOptions = loopOptions;
    }
```

with

```js
function harness({ caseId = 'case-1', beginError = null, inferenceErrorOnCall = 0, loopWait = null, loopError = null, hookResult = null, loopContent = 'Answer text', contextAssembler = null } = {}) {
  const calls = { begin: [], end: [], executorOptions: null, run: null, resolveInferenceCalls: 0, ownerHooks: [], routed: [], usage: [] };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      if (beginError) throw beginError;
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION-BLOCK', source: opts.source, triggers: [], reorientPending: false };
    },
    runOwnerMessageHooks: async (turn) => {
      calls.ownerHooks.push(turn.turnId);
      return { notes: [], triggers: [], orientation: turn.orientation };
    },
    caseContext: (turn, { ownerMessages, ownerMessageTimes }) => ({ ...turn, runtime, ownerMessages, ownerMessageTimes }),
    routedProvider: (turn, spec) => {
      calls.routed.push(spec);
      return { routed: true, getProviderName: () => spec.target.provider, sendMessageWithTools: async () => ({}) };
    },
    usageHook: (turn) => (ev) => { calls.usage.push([turn.turnId, ev]); },
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); return 'abc1234'; }
  };
  class FakeLoop {
    constructor(provider, _executor, loopOptions = {}) {
      calls.loopOptions = loopOptions;
      calls.loopProvider = provider;
    }
```

and replace

```js
    getContextAssembler: () => null,
```

with

```js
    getContextAssembler: () => contextAssembler,
```

Append to the end of `tests/cases-chat.test.js`:

```js
describe('chat:sendMessage case turn, stage 2', () => {
  it('begins an owner turn with the message, runs owner-message hooks, and routes the loop through the runtime', async () => {
    const { calls, send } = harness();
    await send({ message: 'Where are we on the listing?' });
    assert.deepStrictEqual([calls.begin[0].source, calls.begin[0].ownerMessage], ['owner', 'Where are we on the listing?']);
    assert.deepStrictEqual(calls.ownerHooks, [calls.begin[0].turnId]);
    assert.deepStrictEqual(calls.routed, [{ target: { provider: 'openai', model: 'test-model' }, tier: 'standard' }]);
    assert.strictEqual(calls.loopProvider.routed, true);
    assert.strictEqual(calls.loopOptions.failoverPolicy.plan(new Error('x')).action, 'abort');
    calls.loopOptions.onUsageRecorded({ cost: 0.1 });
    assert.deepStrictEqual(calls.usage, [[calls.begin[0].turnId, { cost: 0.1 }]]);
    assert.deepStrictEqual(await calls.loopOptions.prompter.askUser({ question: 'x' }), { ok: false, error: 'In a case, ask the owner with the Ask tool.' });
  });

  it('passes owner message times in step with the owner messages, the current one stamped now', async () => {
    const { calls, send, chat } = harness();
    chat.messages.push({ id: 'm-old', sender: 'user', text: 'Earlier question', timestamp: '2026-09-20T10:00:00.000Z' });
    const before = Date.now();
    await send({ message: 'New question' });
    const { ownerMessages, ownerMessageTimes } = calls.executorOptions.caseContext;
    assert.deepStrictEqual(ownerMessages, ['Earlier question', 'New question']);
    assert.strictEqual(ownerMessageTimes.length, 2);
    assert.strictEqual(ownerMessageTimes[0], '2026-09-20T10:00:00.000Z');
    assert.ok(Date.parse(ownerMessageTimes[1]) >= before);
  });

  it('does not run owner-message hooks when the prompt hook blocks the message', async () => {
    const { calls, send } = harness({ hookResult: { action: 'deny', message: 'not now' } });
    await send();
    assert.deepStrictEqual(calls.ownerHooks, []);
  });

  it('leaves chats without a case on the plain provider, failover and prompter', async () => {
    const { calls, send } = harness({ caseId: null });
    await send({ agentMode: true });
    assert.deepStrictEqual(calls.routed, []);
    assert.strictEqual(calls.loopProvider.routed, undefined);
    assert.strictEqual(calls.loopOptions.failoverPolicy, undefined);
    assert.strictEqual(calls.loopOptions.onUsageRecorded, undefined);
  });

  it('skips the RequestTools hint in a case turn only', async () => {
    const readDef = toolRegistry.get('Read').toFunctionDefinition();
    const assembler = { assemble: async () => ({ systemPrompt: 'ASSEMBLED', tools: [readDef], availableToolNames: ['Browser'] }) };
    const inCase = harness({ contextAssembler: assembler });
    await inCase.send();
    assert.doesNotMatch(inCase.calls.run.options.systemPrompt, /RequestTools/);
    const plain = harness({ caseId: null, contextAssembler: assembler });
    await plain.send({ agentMode: true });
    assert.match(plain.calls.run.options.systemPrompt, /RequestTools/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-chat.test.js`
Expected: FAIL — `begins an owner turn with the message…` (`source` is `undefined`), `passes owner message times…` (`ownerMessageTimes` is `undefined`), `skips the RequestTools hint in a case turn only`; the existing tests pass.

- [ ] **Step 3: Implement**

In `src/ipc/chat-handlers.js`, replace

```js
const { buildCaseSystemPrompt, shapeToolDefinitions } = require('../cases/chat-integration');
```

with

```js
const { buildCaseSystemPrompt, shapeToolDefinitions, casePrompter } = require('../cases/chat-integration');
const { NO_RETRY } = require('../cases/roles');
```

Replace

```js
    let caseTurn = caseRuntime ? await caseRuntime.beginTurn(caseId, { turnId: `turn-${runId}` }) : null;
```

with

```js
    let caseTurn = caseRuntime
      ? await caseRuntime.beginTurn(caseId, { turnId: `turn-${runId}`, source: 'owner', ownerMessage: safeMessage })
      : null;
```

Replace

```js
      if (hookAction === 'deny') {
        const reason = hookResult?.message || hookResult?.reason || 'Blocked by hook policy.';
        await endCaseTurn({ summary: `turn blocked: ${reason}`, journal: null });
        return { ok: false, error: reason };
      }
```

with

```js
      if (hookAction === 'deny') {
        const reason = hookResult?.message || hookResult?.reason || 'Blocked by hook policy.';
        await endCaseTurn({ summary: `turn blocked: ${reason}`, journal: null });
        return { ok: false, error: reason };
      }

      // Owner-message hooks (C5's classification) run only once the prompt
      // hook has let the message through, and before the model sees it.
      if (caseTurn) await caseRuntime.runOwnerMessageHooks(caseTurn);
```

Replace

```js
      const ownerMessages = caseTurn
        ? (() => {
            const messages = chatRaw.messages
              .filter((m) => m.sender === 'user' && typeof m.text === 'string' && m.text)
              .map((m) => m.text);
            if (!messages.includes(safeMessage)) messages.push(safeMessage);
            return messages;
          })()
        : null;
```

with

```js
      // ownerMessageTimes runs in step with ownerMessages; this turn's
      // message is stamped now (stage 2: a direction quote must be newer
      // than the failure report).
      let ownerMessageTimes = null;
      const ownerMessages = caseTurn
        ? (() => {
            const owned = chatRaw.messages.filter((m) => m.sender === 'user' && typeof m.text === 'string' && m.text);
            const messages = owned.map((m) => m.text);
            ownerMessageTimes = owned.map((m) => m.timestamp || null);
            const nowIso = new Date().toISOString();
            if (!messages.includes(safeMessage)) {
              messages.push(safeMessage);
              ownerMessageTimes.push(nowIso);
            } else {
              ownerMessageTimes[messages.lastIndexOf(safeMessage)] = nowIso;
            }
            return messages;
          })()
        : null;
```

Replace

```js
          if (availableNames.length > 0) {
```

with

```js
          // RequestTools is blocked in case turns, so do not advertise it there.
          if (availableNames.length > 0 && !caseTurn) {
```

Replace

```js
        caseContext: caseTurn ? { ...caseTurn, runtime: caseRuntime, ownerMessages } : null
```

with

```js
        caseContext: caseTurn ? caseRuntime.caseContext(caseTurn, { ownerMessages, ownerMessageTimes }) : null
```

Replace

```js
          const loop = new AgentLoop(provider, executor, {
            maxIterations: 40,
            loopModel,
            embeddingProvider,
            usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
            abortSignal: abortController.signal,
            toolResultsDir,
            prompter,
```

with

```js
          // A case turn routes through the runtime: the owner's selection is
          // the first target of routeWithFallback, usage is charged to the
          // case, and AskUser is refused in favour of the Ask tool.
          const loopProvider = caseTurn
            ? caseRuntime.routedProvider(caseTurn, { target: { provider: inference.providerType, model: inference.model }, tier: inference.tier })
            : provider;
          const loop = new AgentLoop(loopProvider, executor, {
            maxIterations: 40,
            loopModel,
            embeddingProvider,
            usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
            ...(caseTurn ? { onUsageRecorded: caseRuntime.usageHook(caseTurn), failoverPolicy: NO_RETRY } : {}),
            abortSignal: abortController.signal,
            toolResultsDir,
            prompter: caseTurn ? casePrompter(prompter) : prompter,
```

Replace

```js
          if (usageTracker && singleCall && typeof usageTracker.record === 'function') {
            usageTracker.record(
```

with

```js
          if (usageTracker && singleCall && typeof usageTracker.record === 'function') {
            const usageEvent = usageTracker.record(
```

and, directly below it, replace

```js
                    costUsd: singleCall.costUsd
                  }
            );
          }
```

with

```js
                    costUsd: singleCall.costUsd
                  }
            );
            if (caseTurn && usageEvent) caseRuntime.usageHook(caseTurn)(usageEvent);
          }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-chat.test.js tests/ipc-contract.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/ipc/chat-handlers.js tests/cases-chat.test.js
git commit -m "feat(cases): owner case turns route, charge and ask through the case runtime

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: IPC channels and the preload bridge

**Files:**
- Create: `src/ipc/case-unattended-handlers.js`
- Modify: `src/ipc/constants.js` (after `  CASE_SET_DISCLOSABLE: 'case:setDisclosable',`)
- Modify: `src/ipc/register.js` (after `  registerCaseHandlers(ipcMain, context);`)
- Modify: `preload.js` (the end of `cases.setDisclosable`)
- Test: `tests/cases-ipc.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `CaseRuntime.answerQuestion`, `acknowledgeBriefing`, `setStatus`, `systemAction`, `budget`, `grantBudget`, `questions`, `listCases`, `getCase` (Tasks 10–11); `STATUSES` (Part 1 `status.js`); `CATEGORIES` (Part 1 `budget.js`).
- Produces: channels `case:questions {caseId?}`, `case:answerQuestion {caseId, questionId, text?, optionId?}`, `case:acknowledgeBriefing {caseId, questionId}`, `case:setStatus {caseId, status, note?}`, `case:budget {caseId}`, `case:grantBudget {caseId, category, limit}`; preload `window.electron.cases.questions`, `answerQuestion`, `acknowledgeBriefing`, `setStatus`, `budget`, `grantBudget`, `onChanged(cb)`. A `CaseBusyError` becomes `{ ok: false, error: 'Case is busy with a wake-up; try again in a minute.' }`; a `QuestionError`/`StatusError` becomes `{ ok: false, error, code, question? }`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/cases-ipc.test.js`:

```js
describe('case IPC, stage 2', () => {
  const { registerCaseUnattendedHandlers } = require('../src/ipc/case-unattended-handlers');

  function setup2() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-ipc2-'));
    dirs.push(root);
    const runtime = new CaseRuntime({ root, getSettings: () => ({ cases: { timeZone: 'UTC' } }), host: { interactive: () => true, notify: () => {} } });
    const handlers = new Map();
    registerCaseUnattendedHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime });
    return { runtime, handlers, call: (channel, payload) => handlers.get(channel)({}, payload) };
  }

  async function activeCase(runtime, title = 'Lakeside lot') {
    const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
    runtime.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    runtime.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    runtime.completeGating(info.id);
    return runtime.getCase(info.id);
  }

  it('registers the six channels', () => {
    const { handlers } = setup2();
    const channels = [IPC.CASE_QUESTIONS, IPC.CASE_ANSWER_QUESTION, IPC.CASE_ACKNOWLEDGE_BRIEFING, IPC.CASE_SET_STATUS, IPC.CASE_BUDGET, IPC.CASE_GRANT_BUDGET];
    assert.deepStrictEqual(channels, ['case:questions', 'case:answerQuestion', 'case:acknowledgeBriefing', 'case:setStatus', 'case:budget', 'case:grantBudget']);
    for (const ch of channels) assert.ok(handlers.has(ch), ch);
  });

  it('lists open questions except for done and abandoned cases, answers one, and refuses a second answer', async () => {
    const { runtime, call } = setup2();
    const a = await activeCase(runtime, 'Lot A');
    const b = await activeCase(runtime, 'Lot B');
    const qa = runtime.createQuestion(a.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    runtime.createQuestion(b.id, { kind: 'question', text: 'Who mows the verge?', urgency: 'low' });
    runtime.setStatus(b.id, 'done', { kind: 'owner', by: 'owner' });
    const listed = await call(IPC.CASE_QUESTIONS, {});
    assert.deepStrictEqual(listed.questions.map((q) => [q.id, q.caseId, q.caseTitle]), [[qa.id, a.id, 'Lot A']]);
    assert.strictEqual((await call(IPC.CASE_QUESTIONS, { caseId: a.id })).questions.length, 1);
    const answered = await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 'Yes, with the north lot' });
    assert.strictEqual(answered.ok, true);
    assert.strictEqual(runtime.ledger(a.id).view().facts.get(answered.factId).source.kind, 'question');
    const again = await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 'No' });
    assert.deepStrictEqual([again.ok, again.code, again.question.id], [false, 'ALREADY_ANSWERED', qa.id]);
    assert.match(again.error, /already answered via in-app/);
    assert.deepStrictEqual((await call(IPC.CASE_QUESTIONS, {})).questions, []);
    assert.strictEqual((await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 7 })).ok, false);
  });

  it('acknowledges a briefing', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const b = runtime.createQuestion(c.id, { kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const r = await call(IPC.CASE_ACKNOWLEDGE_BRIEFING, { caseId: c.id, questionId: b.id });
    assert.deepStrictEqual([r.ok, r.question.answer.channel], [true, 'in-app']);
  });

  it('sets the status as the owner and refuses transitions the owner may not make', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const paused = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused', note: 'away this week' });
    assert.deepStrictEqual([paused.case.status, paused.case.statusReason.by, paused.case.statusReason.note], ['paused', 'owner', 'away this week']);
    assert.strictEqual((await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'active' })).case.status, 'active');
    const bad = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'draft' });
    assert.deepStrictEqual([bad.ok, bad.code], [false, 'BAD_TRANSITION']);
    assert.match((await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'sleeping' })).error, /Unknown status/);
  });

  it('reports the budget and validates grants before writing an owner-action fact', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    runtime.store.updateMeta(c.id, { budget: { usd: 1 } });
    runtime.onCrossings(c.id, 'usd', runtime.budget(c.id).charge('usd', 1.5).crossedNow);
    const b = await call(IPC.CASE_BUDGET, { caseId: c.id });
    assert.deepStrictEqual([b.ok, b.budget.usd.spent, b.budget.usd.limit, b.case.status, b.case.statusReason.kind], [true, 1.5, 1, 'paused', 'budget']);
    const refused = [
      [{ category: 'tokens', limit: 5 }, /Unknown budget category/],
      [{ category: 'usd', limit: 0 }, /above 0/],
      [{ category: 'usd', limit: '5' }, /above 0/],
      [{ category: 'usd', limit: 1.2 }, /above what the case has spent \(1\.5\)/],
      [{ category: 'deadline', limit: 'soon' }, /YYYY-MM-DD/],
      [{ category: 'turnsPerDay', limit: Infinity }, /above 0/]
    ];
    for (const [payload, re] of refused) {
      const r = await call(IPC.CASE_GRANT_BUDGET, { caseId: c.id, ...payload });
      assert.strictEqual(r.ok, false, JSON.stringify(payload));
      assert.match(r.error, re);
    }
    assert.strictEqual(runtime.ledger(c.id).query({ subject: 'budget' }).length, 0, 'refused grants write nothing');
    const granted = await call(IPC.CASE_GRANT_BUDGET, { caseId: c.id, category: 'usd', limit: 5 });
    assert.deepStrictEqual([granted.ok, granted.case.status, granted.budget.usd.limit], [true, 'active', 5]);
    assert.strictEqual(runtime.ledger(c.id).view().facts.get(granted.factId).source.kind, 'owner-action');
  });

  it('says the case is busy while another process holds its lock', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const lock = path.join(c.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    try {
      assert.deepStrictEqual(await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused' }), { ok: false, error: 'Case is busy with a wake-up; try again in a minute.' });
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-ipc.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/case-unattended-handlers'`

- [ ] **Step 3: Implement**

Create `src/ipc/case-unattended-handlers.js`:

```js
// src/ipc/case-unattended-handlers.js
// Cases stage 2 IPC (spec §7): questions, status, budget and grants. Every
// write goes through CaseRuntime.answerQuestion, acknowledgeBriefing,
// grantBudget or systemAction, never straight to the case files.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { CATEGORIES } = require('../cases/budget');
const { STATUSES } = require('../cases/status');

const BUSY = 'Case is busy with a wake-up; try again in a minute.';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const caseSummary = (c) => ({ id: c.id, title: c.title, status: c.status, statusReason: c.statusReason || null, budget: c.budget || null });

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required.`);
  return value;
}

function registerCaseUnattendedHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { ok: false, error: BUSY };
      if (err && (err.name === 'QuestionError' || err.name === 'StatusError')) {
        return { ok: false, error: err.message, code: err.code, ...(err.record ? { question: err.record } : {}) };
      }
      throw err;
    }
  }));

  handle(IPC.CASE_QUESTIONS, async ({ caseId }) => {
    const rt = runtime();
    const cases = caseId ? [rt.getCase(caseId)] : rt.listCases();
    const questions = cases
      .filter((c) => c.status !== 'done' && c.status !== 'abandoned')
      .flatMap((c) => rt.questions(c.id).open().map((q) => ({ ...q, caseId: c.id, caseTitle: c.title, caseStatus: c.status })));
    return { ok: true, questions };
  });

  handle(IPC.CASE_ANSWER_QUESTION, async ({ caseId, questionId, text, optionId }) => {
    if (text !== undefined && text !== null && typeof text !== 'string') return { ok: false, error: 'text must be text.' };
    if (optionId !== undefined && optionId !== null && typeof optionId !== 'string') return { ok: false, error: 'optionId must be text.' };
    const out = await runtime().answerQuestion(required(caseId, 'caseId'), required(questionId, 'questionId'), {
      channel: 'in-app', text: text ?? null, optionId: optionId ?? null
    });
    return { ok: true, question: out.question, factId: out.fact?.id || null, effect: out.effect };
  });

  handle(IPC.CASE_ACKNOWLEDGE_BRIEFING, async ({ caseId, questionId }) => ({
    ok: true,
    question: await runtime().acknowledgeBriefing(required(caseId, 'caseId'), required(questionId, 'questionId'), { channel: 'in-app' })
  }));

  handle(IPC.CASE_SET_STATUS, async ({ caseId, status, note }) => {
    if (!STATUSES.includes(status)) return { ok: false, error: `Unknown status "${status}". Statuses: ${STATUSES.join(', ')}.` };
    if (note !== undefined && typeof note !== 'string') return { ok: false, error: 'note must be text.' };
    const rt = runtime();
    const id = required(caseId, 'caseId');
    const meta = await rt.systemAction(id, `status ${status}`, () => rt.setStatus(id, status, { kind: 'owner', by: 'owner', note: note || '' }));
    return { ok: true, case: caseSummary(meta) };
  });

  handle(IPC.CASE_BUDGET, async ({ caseId }) => {
    const rt = runtime();
    const meta = rt.getCase(required(caseId, 'caseId'));
    return { ok: true, budget: rt.budget(meta.id).status(), case: caseSummary(meta) };
  });

  handle(IPC.CASE_GRANT_BUDGET, async ({ caseId, category, limit }) => {
    const rt = runtime();
    const meta = rt.getCase(required(caseId, 'caseId'));
    if (!CATEGORIES.includes(category)) {
      return { ok: false, error: `Unknown budget category "${category}". Categories: ${CATEGORIES.join(', ')}.` };
    }
    if (category === 'deadline') {
      if (typeof limit !== 'string' || !DAY.test(limit) || !Number.isFinite(Date.parse(`${limit}T00:00:00Z`))) {
        return { ok: false, error: 'A deadline must be a YYYY-MM-DD date.' };
      }
    } else {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        return { ok: false, error: 'A limit must be a number above 0.' };
      }
      if (category === 'usd') {
        const spent = rt.budget(meta.id).status().usd.spent;
        if (limit <= spent) return { ok: false, error: `A usd limit must be above what the case has spent (${spent}).` };
      }
    }
    const out = await rt.grantBudget(meta.id, category, limit, { channel: 'in-app' });
    return { ok: true, factId: out.fact.id, effect: out.effect, case: caseSummary(out.case), budget: rt.budget(meta.id).status() };
  });
}

module.exports = { registerCaseUnattendedHandlers };
```

In `src/ipc/constants.js`, replace

```js
  CASE_SET_DISCLOSABLE: 'case:setDisclosable',
```

with

```js
  CASE_SET_DISCLOSABLE: 'case:setDisclosable',
  CASE_QUESTIONS: 'case:questions',
  CASE_ANSWER_QUESTION: 'case:answerQuestion',
  CASE_ACKNOWLEDGE_BRIEFING: 'case:acknowledgeBriefing',
  CASE_SET_STATUS: 'case:setStatus',
  CASE_BUDGET: 'case:budget',
  CASE_GRANT_BUDGET: 'case:grantBudget',
```

In `src/ipc/register.js`, replace

```js
  registerCaseHandlers(ipcMain, context);
}
```

with

```js
  registerCaseHandlers(ipcMain, context);
  require('./case-unattended-handlers').registerCaseUnattendedHandlers(ipcMain, context);
}
```

In `preload.js`, replace

```js
        if (typeof payload.disclosable !== 'boolean') throw new Error('Invalid disclosable: expected boolean');
        return ipcRenderer.invoke('case:setDisclosable', payload);
      }
    },
```

with

```js
        if (typeof payload.disclosable !== 'boolean') throw new Error('Invalid disclosable: expected boolean');
        return ipcRenderer.invoke('case:setDisclosable', payload);
      },
      questions: (payload = {}) => {
        validateObject(payload, 'payload');
        if (payload.caseId !== undefined) validateString(payload.caseId, 'caseId', { minLength: 1 });
        return ipcRenderer.invoke('case:questions', payload);
      },
      answerQuestion: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.questionId, 'questionId', { minLength: 1 });
        if (payload.text !== undefined) validateString(payload.text, 'text');
        if (payload.optionId !== undefined) validateString(payload.optionId, 'optionId', { minLength: 1 });
        return ipcRenderer.invoke('case:answerQuestion', payload);
      },
      acknowledgeBriefing: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.questionId, 'questionId', { minLength: 1 });
        return ipcRenderer.invoke('case:acknowledgeBriefing', payload);
      },
      setStatus: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.status, 'status', { minLength: 1 });
        if (payload.note !== undefined) validateString(payload.note, 'note');
        return ipcRenderer.invoke('case:setStatus', payload);
      },
      budget: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        return ipcRenderer.invoke('case:budget', payload);
      },
      grantBudget: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.category, 'category', { minLength: 1 });
        if (typeof payload.limit !== 'number' && typeof payload.limit !== 'string') throw new Error('Invalid limit: expected number or string');
        return ipcRenderer.invoke('case:grantBudget', payload);
      },
      onChanged: (callback) => registerOnce('case:changed', callback)
    },
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-ipc.test.js tests/ipc-contract.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/ipc/case-unattended-handlers.js src/ipc/constants.js src/ipc/register.js preload.js tests/cases-ipc.test.js
git commit -m "feat(cases): IPC and preload for questions, status, budget and grants

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Case panel and questions bar in the renderer

**Files:**
- Modify: `renderer.js` (one block of new functions before `function renderChatInfoPopover() {`; three call sites: `renderChatCaseSection`'s `container.append(…)`, `handleSelectChat`, `loadChats`)
- Modify: `styles.css` (append at the end)
- Test: `tests/e2e/cases.test.js` (one new `it` at the end of the existing `describe`)

**Interfaces:**
- Consumes: preload `window.electron.cases.questions`, `answerQuestion`, `acknowledgeBriefing`, `setStatus`, `budget`, `grantBudget`, `onChanged` (Task 16); existing `getActiveChat`, `showConfirmDialog`, `chatLog`.
- Produces: `renderCaseUnattendedSection(chat, container, { compact })`, `refreshCaseQuestionsBar()`. DOM ids: `#case-unattended-section`, `#case-status-text`, `#case-status-<status>` buttons, `#case-budget-text`, `#case-grant-category`, `#case-grant-limit`, `#case-grant-btn`, `#case-question-list`, `#case-questions-bar`; each card has `data-question-id`, `.case-question-input`, `.case-question-answer`, `.case-question-dismiss`. All text is set with `textContent`; `index.html` is not edited.

- [ ] **Step 1: Write the failing test**

In `tests/e2e/cases.test.js`, replace the end of the file

```js
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });
});
```

with

```js
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('shows a seeded question in the panel and the bar, and answering it records an owner fact', async () => {
    // The chat is detached by the test above; attach a new case.
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-title').closest('[hidden]')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-title').value = 'E2E question case';
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('case-unattended-section')`);
    const dir = path.join(casesRoot, 'e2e-question-case');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'facts.jsonl')); i += 1) await new Promise((r) => setTimeout(r, 100));

    const record = {
      id: 'q-0001', kind: 'question', caseId: 'seeded', text: 'Is the well on the lot shared with the neighbour?',
      options: [], urgency: 'normal', createdAt: new Date().toISOString(), expiresAt: null, defaultOnSilence: 'hold',
      deliveries: [], payload: { type: 'ask', mcpAnswerable: true }, answer: null, closed: null, notes: []
    };
    fs.mkdirSync(path.join(dir, '.kl', 'questions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.kl', 'questions', 'q-0001.json'), JSON.stringify(record));

    // Close and reopen Chat Info so the section and the bar render again.
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('#case-question-list [data-question-id="q-0001"]')`);
    await waitFor(ctx, `!!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
    const shown = await evaluate(ctx, `document.querySelector('#case-questions-bar [data-question-id="q-0001"] .case-question-text').textContent`);
    assert.strictEqual(shown, record.text);

    await evaluate(ctx, `(() => {
      const card = document.querySelector('#case-questions-bar [data-question-id="q-0001"]');
      card.querySelector('.case-question-input').value = 'Yes, with the north lot';
      card.querySelector('.case-question-answer').click();
      return true;
    })()`);

    const factsFile = path.join(dir, 'facts.jsonl');
    let fact = null;
    for (let i = 0; i < 100 && !fact; i += 1) {
      const lines = fs.readFileSync(factsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fact = lines.find((f) => f.source?.kind === 'question' && f.source.ref === 'q-0001') || null;
      if (!fact) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fact, 'the answer became a fact');
    assert.strictEqual(fact.provenance, 'user');
    assert.match(fact.stmt, /Yes, with the north lot/);
    await waitFor(ctx, `!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: FAIL — the new test times out in `waitFor` on `#case-unattended-section`; the two existing tests pass.

- [ ] **Step 3: Implement**

In `renderer.js`, replace

```js
  container.append(row, newRow, orientationBtn, orientation, error);
```

with

```js
  container.append(row, newRow, orientationBtn, orientation, error);

  // Cases stage 2: status, budget and questions for the attached case.
  const unattended = document.createElement('div');
  unattended.id = 'case-unattended-section';
  unattended.className = 'case-unattended-section';
  container.appendChild(unattended);
  if (chat.caseId && !caseMissing) {
    renderCaseUnattendedSection(chat, unattended, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
  }
  refreshCaseQuestionsBar();
```

In `renderer.js`, replace

```js
function renderChatInfoPopover() {
```

with

```js
/* --- Cases stage 2: status, budget and questions (docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md §7) --- */

const CASE_STATUS_ACTIONS = [
  { status: 'paused', label: 'Pause', from: ['active'] },
  { status: 'active', label: 'Resume', from: ['paused'] },
  { status: 'done', label: 'Done', from: ['active', 'needs-direction', 'paused'], confirm: 'Mark this case done? It becomes read-only.' },
  { status: 'abandoned', label: 'Abandon', from: ['draft', 'active', 'needs-direction', 'paused'], confirm: 'Abandon this case? It becomes read-only and its wake-ups stop.' }
];
const CASE_BUDGET_CATEGORIES = ['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay'];

function caseButton(text, className = 'secondary-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  return button;
}

function renderCaseQuestionCard(q, { onDone, showError }) {
  const card = document.createElement('div');
  card.className = `case-question case-question-${q.urgency}`;
  card.dataset.questionId = q.id;
  const head = document.createElement('div');
  head.className = 'case-question-head';
  head.textContent = `${q.caseTitle ? `${q.caseTitle} · ` : ''}${q.kind === 'briefing' ? 'Briefing' : 'Question'} ${q.id}`;
  const text = document.createElement('div');
  text.className = 'case-question-text';
  text.textContent = q.text;
  card.append(head, text);

  if (q.kind === 'briefing') {
    const dismiss = caseButton('Dismiss', 'secondary-button case-question-dismiss');
    dismiss.addEventListener('click', async () => {
      const r = await window.electron.cases.acknowledgeBriefing({ caseId: q.caseId, questionId: q.id });
      if (!r?.ok) { showError(r?.error || 'Could not dismiss the briefing.'); return; }
      onDone();
    });
    card.appendChild(dismiss);
    return card;
  }

  const submit = async (answer) => {
    const r = await window.electron.cases.answerQuestion({ caseId: q.caseId, questionId: q.id, ...answer });
    if (!r?.ok) { showError(r?.error || 'Could not send the answer.'); return; }
    onDone();
  };
  const actions = document.createElement('div');
  actions.className = 'case-question-actions';
  (q.options || []).forEach((option) => {
    const b = caseButton(option.label);
    b.dataset.optionId = option.id;
    b.addEventListener('click', () => submit({ optionId: option.id }));
    actions.appendChild(b);
  });
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-info-input case-question-input';
  input.placeholder = 'Answer…';
  const send = caseButton('Answer', 'secondary-button case-question-answer');
  send.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    submit({ text: value });
  });
  actions.append(input, send);
  card.appendChild(actions);
  return card;
}

function renderCaseBudgetLine(caseId, budget, { showError, refresh }) {
  const row = document.createElement('div');
  row.className = 'chat-info-row case-budget-row';
  const text = document.createElement('span');
  text.id = 'case-budget-text';
  const usd = budget.usd || {};
  const parts = [usd.limit ? `$${Number(usd.spent || 0).toFixed(2)} of $${usd.limit}` : `$${Number(usd.spent || 0).toFixed(2)} (no limit)`];
  if (budget.deadline?.at) parts.push(`deadline ${budget.deadline.at}`);
  if (budget.turnsPerDay?.limit) parts.push(`${budget.turnsPerDay.spent || 0}/${budget.turnsPerDay.limit} turns today`);
  if (budget.questionsPerDay?.limit) parts.push(`${budget.questionsPerDay.spent || 0}/${budget.questionsPerDay.limit} questions today`);
  text.textContent = `Budget: ${parts.join(' · ')}`;
  row.appendChild(text);
  if (Number(usd.unpricedTokens) > 0) {
    const warning = document.createElement('div');
    warning.className = 'case-budget-warning';
    warning.textContent = `${usd.unpricedTokens} tokens on providers with no price table are not counted against the $ budget.`;
    row.appendChild(warning);
  }
  const category = document.createElement('select');
  category.className = 'chat-info-select';
  category.id = 'case-grant-category';
  CASE_BUDGET_CATEGORIES.forEach((c) => {
    const option = document.createElement('option');
    option.value = c;
    option.textContent = c;
    category.appendChild(option);
  });
  const limit = document.createElement('input');
  limit.type = 'text';
  limit.className = 'chat-info-input';
  limit.id = 'case-grant-limit';
  limit.placeholder = 'New limit';
  const grant = caseButton('Grant');
  grant.id = 'case-grant-btn';
  grant.addEventListener('click', async () => {
    const raw = limit.value.trim();
    if (!raw) { limit.focus(); return; }
    const value = category.value === 'deadline' ? raw : Number(raw);
    const r = await window.electron.cases.grantBudget({ caseId, category: category.value, limit: value });
    if (!r?.ok) { showError(r?.error || 'Could not change the budget.'); return; }
    refresh();
  });
  row.append(category, limit, grant);
  return row;
}

// Full mode fills the Chat Info case section; compact mode fills the bar
// above the composer with what needs the owner's attention.
async function renderCaseUnattendedSection(chat, container, { compact = false } = {}) {
  if (!container) return;
  if (!chat?.caseId || !window.electron?.cases?.questions) {
    container.innerHTML = '';
    if (compact) container.hidden = true;
    return;
  }
  const listed = await window.electron.cases.questions({ caseId: chat.caseId });
  const questions = listed?.ok ? listed.questions : [];
  container.innerHTML = '';
  const error = document.createElement('div');
  error.className = 'chat-case-error case-unattended-error';
  const showError = (message) => { error.textContent = message || ''; };
  if (!listed?.ok) showError(listed?.error || 'Could not load the case questions.');

  if (compact) {
    const shown = questions.filter((q) => (q.kind !== 'briefing' && q.urgency !== 'low') || (q.kind === 'briefing' && q.urgency === 'high'));
    shown.forEach((q) => container.appendChild(renderCaseQuestionCard(q, { onDone: () => refreshCaseQuestionsBar(), showError })));
    container.appendChild(error);
    container.hidden = shown.length === 0 && !error.textContent;
    return;
  }

  const refresh = () => {
    renderCaseUnattendedSection(chat, container, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
    refreshCaseQuestionsBar();
  };
  const budget = await window.electron.cases.budget({ caseId: chat.caseId });
  if (budget?.ok) {
    const info = budget.case;
    const statusRow = document.createElement('div');
    statusRow.className = 'chat-info-row case-status-row';
    const statusText = document.createElement('span');
    statusText.id = 'case-status-text';
    const reason = info.statusReason
      ? ` (${info.statusReason.kind}${info.statusReason.note ? `: ${info.statusReason.note}` : ''})`
      : '';
    statusText.textContent = `Status: ${info.status}${reason}`;
    statusRow.appendChild(statusText);
    CASE_STATUS_ACTIONS.filter((a) => a.from.includes(info.status)).forEach((action) => {
      const b = caseButton(action.label);
      b.id = `case-status-${action.status}`;
      b.addEventListener('click', async () => {
        if (action.confirm && !(await showConfirmDialog(action.confirm))) return;
        const r = await window.electron.cases.setStatus({ caseId: chat.caseId, status: action.status });
        if (!r?.ok) { showError(r?.error || 'Could not change the status.'); return; }
        refresh();
      });
      statusRow.appendChild(b);
    });
    container.append(statusRow, renderCaseBudgetLine(chat.caseId, budget.budget, { showError, refresh }));
  } else {
    showError(budget?.error || 'Could not load the case budget.');
  }

  const list = document.createElement('div');
  list.className = 'case-question-list';
  list.id = 'case-question-list';
  if (!questions.length) {
    const none = document.createElement('div');
    none.className = 'case-question-none';
    none.textContent = 'No open questions.';
    list.appendChild(none);
  }
  questions.forEach((q) => list.appendChild(renderCaseQuestionCard(q, { onDone: refresh, showError })));
  container.append(list, error);
}

function ensureCaseQuestionsBar() {
  let bar = document.getElementById('case-questions-bar');
  if (bar) return bar;
  const input = document.getElementById('input-container');
  if (!input || !input.parentNode) return null;
  bar = document.createElement('div');
  bar.id = 'case-questions-bar';
  bar.className = 'case-questions-bar';
  bar.hidden = true;
  input.parentNode.insertBefore(bar, input);
  return bar;
}

function refreshCaseQuestionsBar() {
  const bar = ensureCaseQuestionsBar();
  if (!bar) return;
  renderCaseUnattendedSection(getActiveChat(), bar, { compact: true })
    .catch((err) => chatLog.warn(`Case questions bar failed: ${err.message}`));
}

if (window.electron?.cases?.onChanged) {
  window.electron.cases.onChanged((payload) => {
    const chat = getActiveChat();
    if (!chat?.caseId || (payload?.caseId && payload.caseId !== chat.caseId)) return;
    refreshCaseQuestionsBar();
    const slot = document.getElementById('case-unattended-section');
    if (slot) renderCaseUnattendedSection(chat, slot, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
  });
}

function renderChatInfoPopover() {
```

In `renderer.js`, replace

```js
  unwrapIpcResult(await window.electron.chat.setActive(chatId), 'Unable to switch active chat.');
  refreshUI();
```

with

```js
  unwrapIpcResult(await window.electron.chat.setActive(chatId), 'Unable to switch active chat.');
  refreshUI();
  refreshCaseQuestionsBar();
```

In `renderer.js`, replace

```js
  appState.isSandboxModeEnabled = activeChat ? activeChat.sandboxMode !== false : true;
  refreshUI();
}
```

with

```js
  appState.isSandboxModeEnabled = activeChat ? activeChat.sandboxMode !== false : true;
  refreshUI();
  refreshCaseQuestionsBar();
}
```

Append to the end of `styles.css`:

```css
/* Cases stage 2: status, budget and questions */
.case-unattended-section { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.case-status-row, .case-budget-row { flex-wrap: wrap; gap: 6px; align-items: center; }
.case-budget-warning { width: 100%; font-size: 12px; color: var(--text-secondary); }
.case-question-list { display: flex; flex-direction: column; gap: 6px; }
.case-question { border: 1px solid var(--border-default); border-radius: 6px; padding: 8px; background: var(--bg-secondary); }
.case-question-high { border-color: var(--accent); }
.case-question-head { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.case-question-text { white-space: pre-wrap; margin-bottom: 6px; }
.case-question-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.case-question-input { flex: 1 1 160px; }
.case-question-none { font-size: 12px; color: var(--text-secondary); }
.case-questions-bar { display: flex; flex-direction: column; gap: 6px; padding: 6px 12px; max-height: 30vh; overflow-y: auto; border-top: 1px solid var(--border-default); }
.case-questions-bar[hidden] { display: none; }
```

- [ ] **Step 4: Run the tests**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`

Run: `node --test tests/ipc-contract.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add renderer.js styles.css tests/e2e/cases.test.js
git commit -m "feat(cases): case panel status, budget and questions, and a questions bar above the composer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Regression scenarios F4, F9, F12, the CLAUDE.md section, and verification

**Files:**
- Modify: `tests/cases-regressions.test.js` (append three `describe` blocks)
- Modify: `CLAUDE.md` (append a section after the `## Cases` section's last bullet)
- Test: `tests/cases-regressions.test.js`

**Interfaces:**
- Consumes: everything above; `openCase` (updated in Task 12) returns `{ info, turn, opts }`.
- Produces: no new code.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/cases-regressions.test.js`:

```js
const { AskTool, FailTool } = require('../src/tools/builtin/case-unattended-tools');

describe('F4: a dead end becomes one failure report and a question, not a new plan', () => {
  it('Fail with one recommendation waits for direction; Recommend, Fail and Plan are refused; an answer resumes', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, turn, opts } = await openCase(runtime, 'Lakeside lot');
    const f = (await LedgerTool.execute({ action: 'assert', stmt: 'An auction house takes rural lots', subject: 'market', attr: 'auction', value: 'yes', source: web }, opts)).fact;
    const failed = await FailTool.execute({
      failureClass: 'dead-end',
      what: 'County listing',
      tried: ['Listed on the county site for 60 days'],
      why: 'No buyer replied',
      recommendation: { claims: [{ text: 'Try a land auction', factIds: [f.id] }] }
    }, opts);
    assert.strictEqual(failed.ok, true);
    assert.match(failed.rendered, /Recommendation:\n- Try a land auction/);
    assert.strictEqual(runtime.getCase(info.id).status, 'needs-direction');
    const [q] = runtime.questions(info.id).open();
    assert.deepStrictEqual([q.urgency, q.payload.type, q.payload.mcpAnswerable], ['high', 'direction', false]);
    assert.strictEqual((await RecommendTool.execute({ claims: [{ text: 'Try a land auction', factIds: [f.id] }] }, opts)).ok, false);
    assert.strictEqual((await FailTool.execute({ failureClass: 'dead-end', what: 'Another idea', tried: ['x'], why: 'y' }, opts)).ok, false);
    assert.strictEqual(runtime.assertWritable(info.id, 'Plan').ok, false);
    await runtime.endTurn(turn, {});
    await runtime.answerQuestion(info.id, q.id, { channel: 'in-app', text: 'Go with the auction' });
    assert.strictEqual(runtime.getCase(info.id).status, 'active');
  });
});

describe('F9: the brief decides what reaches the owner', () => {
  it('an ignored briefing is refused; an urgent briefing without a tell tag is stored low and lands in the panel', async () => {
    const events = [];
    const runtime = new CaseRuntime({ root: tmp(), host: { notify: (_e, p) => events.push(p) } });
    const { info, opts } = await openCase(runtime, 'Lakeside lot');
    runtime.brief(info.id).update('materiality', { tell: ['offer'], ignore: ['voicemail'] }, { provenance: 'user' });
    const ignored = await AskTool.execute({ question: 'A buyer left a voicemail.', kind: 'briefing', materiality: 'voicemail' }, opts);
    assert.strictEqual(ignored.ok, false);
    const r = await AskTool.execute({ question: 'The listing went live.', kind: 'briefing', urgency: 'high' }, opts);
    assert.strictEqual(r.urgency, 'low');
    assert.strictEqual(runtime.questions(info.id).get(r.questionId).urgency, 'low');
    assert.ok(events.some((p) => p.questionId === r.questionId && p.attention === 'panel'));
  });
});

describe('F12: spending stops at the budget and only the owner raises it', () => {
  it('pauses at 100 % of usd, refuses writes, ignores a quoted "ok", skips wake-ups, and resumes on an answered limit', async () => {
    let routed = 0;
    const runtime = new CaseRuntime({
      root: tmp(),
      host: { inferenceRouter: { routeWithFallback: async () => { routed += 1; return '{"changed": true}'; } }, notify: () => {} }
    });
    const { info, turn, opts } = await openCase(runtime, 'Lakeside lot', { ownerMessages: ['ok, go ahead'] });
    runtime.store.updateMeta(info.id, { budget: { usd: 1 } });
    const quoted = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'ok, go ahead', stmt: 'Owner raised the budget', subject: 'budget', attr: 'usd', value: '500' }, opts);
    assert.strictEqual(quoted.ok, true);
    assert.match(quoted.note, /only through the owner's answer or the Grant button/);
    assert.strictEqual(runtime.getCase(info.id).budget.usd, 1);

    runtime.usageHook(turn)({ provider: 'openai', model: 'gpt-4o', totalTokens: 1000, cost: 1.1 });
    const meta = runtime.getCase(info.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind], ['paused', 'budget']);
    const grantQ = runtime.questions(info.id).open().find((q) => q.payload.type === 'budget-grant');
    assert.ok(grantQ);
    assert.strictEqual((await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'lot', attr: 'x', value: '1', source: web }, opts)).ok, false);
    assert.strictEqual((await LedgerTool.execute({ action: 'query' }, opts)).ok, true);
    await runtime.endTurn(turn, {});

    const wakeup = runtime.wakeups(info.id).register({ kind: 'retry', at: new Date(Date.now() - 60000).toISOString(), payload: { key: 'f12' } });
    await runtime.runDueWakeups(new Date());
    assert.strictEqual(routed, 0, 'a paused case runs no wake-up');
    assert.ok(runtime.wakeups(info.id).list().some((w) => w.id === wakeup));

    await runtime.answerQuestion(info.id, grantQ.id, { channel: 'in-app', text: '2' });
    const after = runtime.getCase(info.id);
    assert.deepStrictEqual([after.status, after.budget.usd], ['active', 2]);
  });

  it('a limit lowered below spend pauses the case on the next turn', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, turn } = await openCase(runtime, 'Lakeside lot');
    runtime.budget(info.id).charge('usd', 5);
    await runtime.endTurn(turn, {});
    runtime.store.updateMeta(info.id, { budget: { usd: 4 } });
    const next = await runtime.beginTurn(info.id, { turnId: 'turn-2' });
    const meta = runtime.getCase(info.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['paused', 'budget', 'usd']);
    assert.ok(runtime.questions(info.id).open().some((q) => q.payload.type === 'budget-grant'));
    await runtime.endTurn(next, {});
  });
});
```

- [ ] **Step 2: Run it to verify it fails, or pins behaviour already built**

Run: `node --test tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`. These scenarios pin behaviour Tasks 10–13 built; if one fails, the fault is in the task that owns that code (read its test first), not in this file.

- [ ] **Step 3: Document**

Append to `CLAUDE.md`, after the line

```
  still rewrite `facts.jsonl`.
```

this section:

```markdown

## Cases: unattended (stage 2)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md`.

- Status (`case.yaml` `status`, `statusReason`) changes only through
  `CaseRuntime.setStatus`; `src/cases/status.js` holds the transition table and
  the per-status tool rules. Every case tool checks `assertWritable`; `Decide`,
  `Recommend` and `Fail` also call `requireReoriented`, which refuses when no
  turn is registered, so tests that call them begin a turn first.
- Wake-ups: the protected cron system job `cases:wakeups` (every minute,
  `ensureWakeupJob`) calls `CaseRuntime.runDueWakeups`. A wake-up turn makes one
  `orient` call, then runs a `judge` loop confined to the case tools plus Read,
  Glob and Grep (`allowedToolNames`, `denyAutoApproval`, no owner messages).
  Settings: `settings.cases.wakeups`; off with `enabled: false`.
- Budgets live in `.kl/budget.json`. `usd` and `deadline` at 100 % pause the
  case; per-day categories refuse their action until the local day rolls over.
  Only an answered budget question or the Grant button (`question` /
  `owner-action` facts) raises a limit.
- Questions live in `.kl/questions/`. Create them with
  `CaseRuntime.createQuestion`; answer them only through
  `CaseRuntime.answerQuestion` (exactly one host-verified `user` fact).
- Case-file writes outside a turn go through `CaseRuntime.systemAction`. Tests
  inject a fake clock with `new CaseRuntime({ now })` and a temp root.
```

- [ ] **Step 4: Verify the whole stage**

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests preload.js renderer.js styles.css CLAUDE.md | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})"`
Expected: no output (fixtures use invented values such as `Lakeside lot`, `records.example.org`, `auctions.example.com`).

Run: `git diff main --stat -- package.json package-lock.json`
Expected: no output (no new dependency).

- [ ] **Step 5: Commit**

```bash
git add tests/cases-regressions.test.js CLAUDE.md
git commit -m "test(cases): F4, F9 and F12 regression scenarios; document unattended cases

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
