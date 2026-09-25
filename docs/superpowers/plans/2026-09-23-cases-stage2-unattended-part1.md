# Cases Stage 2: Unattended cases — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, Electron-free building blocks a case needs to run while the owner is away: the status machine, budgets, the wake-up store and cron system jobs, question records, re-orientation triggers, model roles, the new orientation sections and executor confinement.
**Architecture:** Part 1 adds self-contained modules under `src/cases/` (`status.js`, `clock.js`, `jsonfile.js`, `budget.js`, `wakeups.js`, `questions.js`, `triggers.js`, `roles.js`) and small additive changes to `src/cron/`, `src/providers/inference-router.js`, `src/cases/{ledger,brief,case-store,orientation,chat-integration}.js` and `src/execution/tool-executor.js`. Nothing in Part 1 changes what a running turn does. Part 2 (`docs/superpowers/plans/2026-09-23-cases-stage2-unattended-part2.md`) wires these modules into `CaseRuntime`, the case tools, the wake-up turn runner, `createCore`, the chat send path, IPC and the renderer, and starts only after Part 1 has merged.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `Intl.DateTimeFormat` for time-zone day math, `js-yaml` (already a dependency). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

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

- No new npm dependency (spec §14). Time-zone day math uses `Intl.DateTimeFormat` only.
- Wake-up confinement: the case tools plus exactly `Read`, `Glob`, `Grep` (`WAKEUP_BASE_TOOLS`). No `WebFetch`/`WebSearch` until C3's outbound gate merges.
- `CASE_BLOCKED_TOOL_NAMES` = `SpawnAgent`, `BackgroundTask`, `sessions_spawn`, `RemoteDispatch`, `Cron`, `message`, `sessions_list`, `sessions_history`, `RequestTools`, `ToolSearch`, `Canvas`.
- Wake-up `every` is in milliseconds, an integer ≥ 60000. Retry backoff default `[5, 15, 60]` minutes.
- Budget thresholds are exactly `[50, 80, 100]`. A `null` or `0` limit means unlimited: spend is tracked, no threshold fires.
- Budget categories: `usd`, `deadline`, `turnsPerDay`, `contactsPerDay`, `questionsPerDay`. Only `usd` and `deadline` pause a case; a per-day category at 100 % refuses its action until the local day rolls over.
- Question ids are `q-` + 4-digit counter, wake-up ids `w-` + 4-digit counter. Question `text` is 1–2000 characters; at most 6 options; option id `^[a-z0-9-]{1,16}$`; option label 1–200 characters; `expiresAt` at most 30 days out.
- Host-reserved ledger source kinds `user-message`, `question`, `owner-action` are accepted only with `provenance: 'user'`, and `provenance: 'user'` only with one of them.
- Owner-only brief fields: `why`, `hardConstraints`, `alreadyTried`, `materiality`, `deadline`, `safeDefaults`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and where each is pinned:

1. **A wake-up fires while the owner is mid-turn.** Part 2, Task 13 (`tests/cases-turn-runner.test.js`, "skips a case whose owner is mid-turn, then runs it after endTurn").
2. **The clock jumps.** Forward 3 days gives one coalesced run, and back 2 hours triggers `reanchor`: Task 3 (`tests/cases-wakeups.test.js`). No backwards day reset: Task 2 (`tests/cases-budget.test.js`). No gap for a future `lastOwnerTurnAt`: Task 6 (`tests/cases-triggers.test.js`).
3. **The budget limit is lowered below spend.** Task 2 ("reconcile raises and lowers a limit") and Part 2, Task 18 (F12 variant).
4. **A question is answered twice from two surfaces.** Task 5 (`tests/cases-questions.test.js`, "two stores answering the same question write exactly one fact").
5. **The `orient` provider is down.** Part 2, Task 13 ("orient provider down: failed, backoff, one briefing on the third failure, no judge call").

## Interfaces from other stages

Part 1 consumes nothing unmerged. It reads two optional inputs that C3 will write, and one C6 list, all passed into the pure `detectTriggers` (Task 6):

| Contract | Shape | Stub in tests |
|---|---|---|
| Program §4.7 `.kl/executors.json` (C3) | `{ [executorId]: { stale: boolean, material: object } }` | a literal object, or `null` (trigger inert) |
| Program §4.7 `.kl/plan.json` (C3, R35) | `{ steps: [{ id, state: 'pending'\|'in-flight'\|'done'\|'failed'\|'cancelled' }] }` | a literal, or `null` (trigger inert) |
| Spec §5.1 C6 `playbookChanges(id)` | `[{ name, from, to, key?, detail? }]` | a literal array, or `[]` (trigger inert) |

## Deviations and resolved gaps (read before starting)

- `canTransition(from, to, by, kind?)` takes an optional fourth `kind` so `setStatus` (Part 2) can check the `statusReason.kind` column of the spec's transition table. `check(status, op, { autonomyAllows, reason })` also takes the current `statusReason`, so refusals can name `<ref>` and `<kind>`.
- `WakeupStore` also takes `dailyAt` and `backoffMinutes` options: the spec reads them from settings, and the store needs them to compute `nextAt`. `.kl/wakeups.json` carries a `counter` next to `items` so ids never repeat after removals.
- `QuestionStore` adds `list()`, `findDuplicate(record)`, `note(id, text)` and `static answerHandler(type)`. Deduplication also matches an open record of the same `kind` with the same `payload.key` (the spec calls `key` the "deduplication key"), so budget questions whose text changes with the spend still dedupe.
- `QuestionStore.answer` honours `payload.gating.category` by setting the fact's `category` (spec §5.3 names the key but not its effect), and `payload.disclosable: false` by asserting the fact with `disclosable: false`.
- The inference router is `src/providers/inference-router.js` (the program's §5 table says `src/inference/`).
- `ToolExecutor`'s `allowedToolNames` check runs first in `execute()`, before PreToolUse hooks and the registry lookup. A tool the model names that is not registered in this process (for example `message` in the service host) is then refused with the same `{ success: false }` result instead of throwing "Tool not found".

---

### Task 1: Status machine

**Files:**
- Create: `src/cases/status.js`
- Test: `tests/cases-status.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `STATUSES`, `REASON_KINDS`, `TRANSITIONS`, `ALLOWED`, `DENIED`, `READ_OPS`, `AUTONOMY_KEY`, `FAILURE_CLASSES`, `class StatusError(code, message)` (`code` ∈ `BAD_TRANSITION`, `BUDGET_EXHAUSTED`), `canTransition(from, to, by = 'runtime', kind = null) → boolean`, `check(status, op, { autonomyAllows = false, reason = null } = {}) → null | { ok: false, error }`. Part 2's `CaseRuntime.setStatus` and `assertWritable` call these.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-status.test.js`:

```js
// tests/cases-status.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  STATUSES, TRANSITIONS, ALLOWED, DENIED, READ_OPS, AUTONOMY_KEY, FAILURE_CLASSES,
  StatusError, canTransition, check
} = require('../src/cases/status');

const OPS = [
  'Ledger.assert', 'Ledger.infer', 'Ledger.unknown', 'Ledger.retract', 'Ledger.query',
  'Brief.read', 'Brief.update', 'Brief.append', 'Brief.completeGating',
  'Decide', 'Recommend', 'Reorient', 'Fail', 'Ask',
  'Plan', 'Executor.submit', 'Playbook.list', 'Playbook.read', 'Playbook.propose'
];

describe('status transitions', () => {
  it('names the six statuses and freezes the table', () => {
    assert.deepStrictEqual([...STATUSES], ['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);
    assert.ok(Object.isFrozen(TRANSITIONS));
    assert.ok(TRANSITIONS.every((t) => Object.isFrozen(t)));
  });

  it('allows every row of the spec table, with its by and kind', () => {
    const allowed = [
      ['draft', 'active', 'runtime', 'gating'],
      ['draft', 'abandoned', 'owner', 'owner'],
      ['active', 'needs-direction', 'runtime', 'failure'],
      ['active', 'paused', 'runtime', 'budget'],
      ['needs-direction', 'paused', 'runtime', 'budget'],
      ['active', 'paused', 'runtime', 'commit'],
      ['active', 'paused', 'owner', 'owner'],
      ['needs-direction', 'active', 'runtime', 'direction'],
      ['needs-direction', 'active', 'owner', 'direction'],
      ['paused', 'active', 'runtime', 'budget-grant'],
      ['paused', 'active', 'owner', 'owner'],
      ...['active', 'needs-direction', 'paused'].flatMap((from) => [
        [from, 'done', 'owner', 'owner'],
        [from, 'abandoned', 'owner', 'owner']
      ])
    ];
    for (const [from, to, by, kind] of allowed) {
      assert.strictEqual(canTransition(from, to, by, kind), true, `${from} -> ${to} (${by}, ${kind})`);
    }
  });

  it('refuses every other transition', () => {
    const refused = [
      ['draft', 'active', 'owner', 'owner'],
      ['draft', 'paused', 'runtime', 'budget'],
      ['draft', 'done', 'owner', 'owner'],
      ['draft', 'needs-direction', 'runtime', 'failure'],
      ['active', 'draft', 'owner', 'owner'],
      ['active', 'done', 'runtime', 'owner'],
      ['active', 'abandoned', 'runtime', 'owner'],
      ['active', 'paused', 'owner', 'budget'],
      ['needs-direction', 'active', 'owner', 'owner'],
      ['needs-direction', 'paused', 'owner', 'owner'],
      ['paused', 'active', 'runtime', 'direction'],
      ['paused', 'needs-direction', 'runtime', 'failure'],
      ['done', 'active', 'owner', 'owner'],
      ['done', 'abandoned', 'owner', 'owner'],
      ['abandoned', 'active', 'owner', 'owner']
    ];
    for (const [from, to, by, kind] of refused) {
      assert.strictEqual(canTransition(from, to, by, kind), false, `${from} -> ${to} (${by}, ${kind})`);
    }
  });

  it('checks only from/to/by when no kind is given', () => {
    assert.strictEqual(canTransition('active', 'paused', 'owner'), true);
    assert.strictEqual(canTransition('active', 'paused', 'someone-else'), false);
    assert.strictEqual(canTransition('paused', 'active'), true);
  });
});

describe('per-status rules', () => {
  it('active allows every op', () => {
    for (const op of OPS) assert.strictEqual(check('active', op), null, op);
  });

  it('draft refuses Recommend, Plan, Executor.submit and Fail only', () => {
    const refused = ['Recommend', 'Plan', 'Executor.submit', 'Fail'];
    for (const op of OPS) {
      const r = check('draft', op);
      if (refused.includes(op)) {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is a draft: finish the gating pass (Brief completeGating) first.' }, op);
      } else {
        assert.strictEqual(r, null, op);
      }
    }
  });

  it('needs-direction refuses Plan, Recommend, Fail and Executor.submit, and names the failure report', () => {
    const reason = { kind: 'failure', ref: 'journal/2026-09-23-1405-failure.md' };
    for (const op of ['Plan', 'Recommend', 'Fail', 'Executor.submit']) {
      assert.deepStrictEqual(check('needs-direction', op, { reason }), {
        ok: false,
        error: "Case is waiting for the owner's direction on journal/2026-09-23-1405-failure.md. Report status or ask; do not plan or recommend."
      }, op);
    }
    for (const op of ['Ledger.assert', 'Ledger.query', 'Brief.update', 'Decide', 'Reorient', 'Ask']) {
      assert.strictEqual(check('needs-direction', op, { reason }), null, op);
    }
  });

  it('needs-direction allows Executor.submit only when the case autonomy grants it', () => {
    assert.strictEqual(check('needs-direction', 'Executor.submit', { autonomyAllows: true }), null);
    assert.strictEqual(check('needs-direction', 'Plan', { autonomyAllows: true }).ok, false);
  });

  it('paused allows only the read ops, including the C6 playbook reads', () => {
    for (const op of OPS) {
      const r = check('paused', op, { reason: { kind: 'budget', ref: 'usd' } });
      if (['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read'].includes(op)) {
        assert.strictEqual(r, null, op);
      } else {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (budget). Only reading is available.' }, op);
      }
    }
  });

  it('done allows the reads and Playbook.propose', () => {
    for (const op of OPS) {
      const r = check('done', op);
      if (['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read', 'Playbook.propose'].includes(op)) {
        assert.strictEqual(r, null, op);
      } else {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is done. It is read-only.' }, op);
      }
    }
  });

  it('abandoned allows only the reads', () => {
    assert.strictEqual(check('abandoned', 'Playbook.read'), null);
    assert.deepStrictEqual(check('abandoned', 'Playbook.propose'), { ok: false, error: 'Case is abandoned. It is read-only.' });
    assert.deepStrictEqual(check('abandoned', 'Ledger.assert'), { ok: false, error: 'Case is abandoned. It is read-only.' });
  });

  it('refuses everything for an unknown status', () => {
    const r = check('archived', 'Ledger.query');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /archived/);
  });

  it('exposes the allowlists and denylists the spec names', () => {
    assert.deepStrictEqual([...READ_OPS], ['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read']);
    assert.deepStrictEqual([...ALLOWED.done], [...READ_OPS, 'Playbook.propose']);
    assert.deepStrictEqual([...ALLOWED.abandoned], [...READ_OPS]);
    assert.deepStrictEqual([...DENIED.draft], ['Recommend', 'Plan', 'Executor.submit', 'Fail']);
  });
});

describe('autonomy keys and errors', () => {
  it('maps each failure class to its case.yaml autonomy key', () => {
    assert.deepStrictEqual({ ...AUTONOMY_KEY }, {
      'executor-no-answer': 'onExecutorNoAnswer',
      'dead-end': 'onDeadEnd',
      blocked: 'onBlocked',
      other: 'onOther'
    });
    assert.deepStrictEqual([...FAILURE_CLASSES], ['executor-no-answer', 'dead-end', 'blocked', 'other']);
  });

  it('StatusError carries its code', () => {
    const err = new StatusError('BUDGET_EXHAUSTED', 'Raise the usd budget first.');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'StatusError');
    assert.strictEqual(err.code, 'BUDGET_EXHAUSTED');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-status.test.js`
Expected: FAIL with `Cannot find module '../src/cases/status'`

- [ ] **Step 3: Implement**

Create `src/cases/status.js`:

```js
// src/cases/status.js
// Case status machine and per-status tool rules (cases stage 2 spec §3.1).
// Pure: no I/O. CaseRuntime.setStatus and assertWritable apply it.

const STATUSES = Object.freeze(['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);
const REASON_KINDS = Object.freeze(['gating', 'failure', 'budget', 'budget-grant', 'commit', 'owner', 'direction']);

const row = (from, to, by, kinds) => Object.freeze({
  from: Object.freeze(from), to, by: Object.freeze(by), kinds: Object.freeze(kinds)
});

const TRANSITIONS = Object.freeze([
  row(['draft'], 'active', ['runtime'], ['gating']),
  row(['draft'], 'abandoned', ['owner'], ['owner']),
  row(['active'], 'needs-direction', ['runtime'], ['failure']),
  row(['active', 'needs-direction'], 'paused', ['runtime'], ['budget']),
  row(['active'], 'paused', ['runtime'], ['commit']),
  row(['active'], 'paused', ['owner'], ['owner']),
  row(['needs-direction'], 'active', ['runtime', 'owner'], ['direction']),
  row(['paused'], 'active', ['runtime', 'owner'], ['budget-grant', 'owner']),
  row(['active', 'needs-direction', 'paused'], 'done', ['owner'], ['owner']),
  row(['active', 'needs-direction', 'paused'], 'abandoned', ['owner'], ['owner'])
]);

const READ_OPS = Object.freeze(['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read']);

// Narrow statuses use an allowlist; the others a denylist (spec §3.1).
const ALLOWED = Object.freeze({
  paused: READ_OPS,
  done: Object.freeze([...READ_OPS, 'Playbook.propose']),
  abandoned: READ_OPS
});

const DENIED = Object.freeze({
  draft: Object.freeze(['Recommend', 'Plan', 'Executor.submit', 'Fail']),
  active: Object.freeze([]),
  'needs-direction': Object.freeze(['Plan', 'Recommend', 'Fail', 'Executor.submit'])
});

const AUTONOMY_KEY = Object.freeze({
  'executor-no-answer': 'onExecutorNoAnswer',
  'dead-end': 'onDeadEnd',
  blocked: 'onBlocked',
  other: 'onOther'
});
const FAILURE_CLASSES = Object.freeze(Object.keys(AUTONOMY_KEY));

class StatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
  }
}

function canTransition(from, to, by = 'runtime', kind = null) {
  return TRANSITIONS.some((t) => (
    t.from.includes(from)
    && t.to === to
    && t.by.includes(by)
    && (kind === null || kind === undefined || t.kinds.includes(kind))
  ));
}

function refusal(status, reason) {
  switch (status) {
    case 'draft':
      return 'Case is a draft: finish the gating pass (Brief completeGating) first.';
    case 'needs-direction':
      return `Case is waiting for the owner's direction on ${reason?.ref || 'its failure report'}. Report status or ask; do not plan or recommend.`;
    case 'paused':
      return `Case is paused (${reason?.kind || 'owner'}). Only reading is available.`;
    case 'done':
      return 'Case is done. It is read-only.';
    case 'abandoned':
      return 'Case is abandoned. It is read-only.';
    default:
      return `Case status "${status}" is not recognised, so nothing can run. Fix case.yaml.`;
  }
}

// null when `op` may proceed in `status`, else a refusal result.
function check(status, op, { autonomyAllows = false, reason = null } = {}) {
  const allowed = ALLOWED[status];
  if (allowed) return allowed.includes(op) ? null : { ok: false, error: refusal(status, reason) };
  const denied = DENIED[status];
  if (!denied) return { ok: false, error: refusal(status, reason) };
  if (!denied.includes(op)) return null;
  if (status === 'needs-direction' && op === 'Executor.submit' && autonomyAllows === true) return null;
  return { ok: false, error: refusal(status, reason) };
}

module.exports = {
  STATUSES,
  REASON_KINDS,
  TRANSITIONS,
  ALLOWED,
  DENIED,
  READ_OPS,
  AUTONOMY_KEY,
  FAILURE_CLASSES,
  StatusError,
  canTransition,
  check
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-status.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/status.js tests/cases-status.test.js
git commit -m "feat(cases): status machine and per-status tool rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Clock helpers, JSON files and budgets

**Files:**
- Create: `src/cases/clock.js`
- Create: `src/cases/jsonfile.js`
- Create: `src/cases/budget.js`
- Test: `tests/cases-budget.test.js`

**Interfaces:**
- Consumes: `createLogger` (`src/logging.js`).
- Produces:
  - `clock.js`: `validTimeZone(tz) → string | undefined`, `localDay(date, tz) → 'YYYY-MM-DD'`, `addDays(day, n) → 'YYYY-MM-DD'`, `zonedTime(day, hour, minute, tz) → Date`, `parseHhmm(text) → [hour, minute]`, `nextLocalTime(now, 'HH:MM', tz) → Date`, `nextLocalMidnight(now, tz) → Date`, `toMs(value) → number` (accepts a `Date` or a string; `NaN` otherwise).
  - `jsonfile.js`: `readJson(file, fallback)`, `writeJson(file, value)` (temp file then rename), `writeJsonIfChanged(file, value) → boolean`.
  - `budget.js`: `CATEGORIES`, `PER_DAY`, `THRESHOLDS`, `class Budget(dir, { defaults, overrides, createdAt, now, timeZone })` with `limitFor(c)`, `charge(c, amount, meta) → { spent, limit, crossedNow }`, `reconcile() → { [c]: number[] }`, `status() → { [c]: entry & { ratio } }`, `remaining(c) → number | null`, `exhausted() → string[]`, `atLimit(c) → boolean`, `recordGrant(c, factId)`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-budget.test.js`:

```js
// tests/cases-budget.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Budget, CATEGORIES, THRESHOLDS } = require('../src/cases/budget');
const { localDay, addDays, zonedTime, nextLocalTime, nextLocalMidnight, parseHhmm, toMs } = require('../src/cases/clock');
const { readJson, writeJsonIfChanged } = require('../src/cases/jsonfile');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const caseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-budget-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('clock helpers', () => {
  it('computes local days, local times and midnights in a time zone', () => {
    const at = new Date('2026-09-23T23:30:00Z');
    assert.strictEqual(localDay(at, 'UTC'), '2026-09-23');
    assert.strictEqual(localDay(at, 'Asia/Tokyo'), '2026-09-24');
    assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(zonedTime('2026-09-24', 9, 0, 'Asia/Tokyo').toISOString(), '2026-09-24T00:00:00.000Z');
    assert.strictEqual(nextLocalTime(at, '09:00', 'UTC').toISOString(), '2026-09-24T09:00:00.000Z');
    assert.strictEqual(nextLocalMidnight(at, 'UTC').toISOString(), '2026-09-24T00:00:00.000Z');
  });

  it('keeps 09:00 local across a daylight-saving change', () => {
    const before = new Date('2026-10-31T13:00:30Z'); // 09:00:30 EDT
    assert.strictEqual(nextLocalTime(before, '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  });

  it('falls back to 09:00 for a malformed time and parses dates and strings', () => {
    assert.deepStrictEqual(parseHhmm('25:99'), [9, 0]);
    assert.deepStrictEqual(parseHhmm('7:05'), [7, 5]);
    assert.strictEqual(toMs('2026-09-23T00:00:00Z'), Date.parse('2026-09-23T00:00:00Z'));
    assert.strictEqual(toMs(new Date(5)), 5);
    assert.ok(Number.isNaN(toMs(null)));
  });

  it('writes a JSON file only when its content changes', async () => {
    const file = path.join(caseDir(), '.kl', 'x.json');
    assert.deepStrictEqual(readJson(file, { none: true }), { none: true });
    assert.strictEqual(writeJsonIfChanged(file, { a: 1 }), true);
    assert.strictEqual(writeJsonIfChanged(file, { a: 1 }), false);
    assert.deepStrictEqual(readJson(file, null), { a: 1 });
  });
});

describe('Budget', () => {
  it('lists the five categories and three thresholds', () => {
    assert.deepStrictEqual([...CATEGORIES], ['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
    assert.deepStrictEqual([...THRESHOLDS], [50, 80, 100]);
  });

  it('reports each threshold once, as it is crossed', () => {
    const b = new Budget(caseDir(), { defaults: { usd: 10 }, timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('usd', 4).crossedNow, []);
    assert.deepStrictEqual(b.charge('usd', 1).crossedNow, [50]);
    assert.deepStrictEqual(b.charge('usd', 3.5).crossedNow, [80]);
    const last = b.charge('usd', 2);
    assert.deepStrictEqual(last, { spent: 10.5, limit: 10, crossedNow: [100] });
    assert.deepStrictEqual(b.charge('usd', 1).crossedNow, []);
    assert.deepStrictEqual(b.exhausted(), ['usd']);
    assert.strictEqual(b.remaining('usd'), -1.5);
  });

  it('prefers the case override over the default, and treats null or 0 as unlimited', () => {
    const d = caseDir();
    assert.strictEqual(new Budget(d, { defaults: { usd: 20 }, overrides: { usd: 40 } }).limitFor('usd'), 40);
    const none = new Budget(d, { defaults: { usd: null } });
    assert.deepStrictEqual(none.charge('usd', 1000).crossedNow, []);
    assert.strictEqual(none.remaining('usd'), null);
    const zero = new Budget(d, { defaults: { usd: 20 }, overrides: { usd: 0 } });
    assert.strictEqual(zero.limitFor('usd'), null);
    assert.deepStrictEqual(zero.exhausted(), []);
  });

  it('rolls a per-day category over at local midnight in the time zone, never backwards', () => {
    const d = caseDir();
    let clock = new Date('2026-09-23T23:30:00Z'); // Tokyo: 2026-09-24 08:30
    const b = new Budget(d, { defaults: { turnsPerDay: 2 }, now: () => clock, timeZone: 'Asia/Tokyo' });
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 1, limit: 2, crossedNow: [50] });
    clock = new Date('2026-09-24T14:59:00Z'); // Tokyo 23:59, same day
    assert.deepStrictEqual(b.charge('turnsPerDay', 1).crossedNow, [80, 100]);
    assert.strictEqual(b.atLimit('turnsPerDay'), true);
    clock = new Date('2026-09-24T15:01:00Z'); // Tokyo 00:01 on the 25th
    assert.strictEqual(b.atLimit('turnsPerDay'), false);
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 1, limit: 2, crossedNow: [50] });
    clock = new Date('2026-09-24T10:00:00Z'); // the clock jumps back to the 24th
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 2, limit: 2, crossedNow: [80, 100] });
    assert.strictEqual(b.status().turnsPerDay.day, '2026-09-25');
  });

  it('measures the deadline as elapsed time between creation and the end of the deadline day', () => {
    const d = caseDir();
    let clock = new Date('2026-09-06T00:00:00Z');
    const b = new Budget(d, { overrides: { deadline: '2026-09-10' }, createdAt: '2026-09-01T00:00:00Z', now: () => clock, timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('deadline', 0), { spent: null, limit: '2026-09-10', crossedNow: [50] });
    clock = new Date('2026-09-09T00:00:00Z');
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [80]);
    clock = new Date('2026-09-11T00:00:00Z');
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [100]);
    assert.deepStrictEqual(b.exhausted(), ['deadline']);
    assert.strictEqual(b.status().deadline.ratio, 1);
    assert.strictEqual(readJson(path.join(d, '.kl', 'budget.json'), null).deadline.ratio, undefined, 'the ratio is never stored');
  });

  it('counts a deadline on or before creation as 100 %', () => {
    const b = new Budget(caseDir(), { overrides: { deadline: '2026-09-10' }, createdAt: '2026-09-20T00:00:00Z', now: () => new Date('2026-09-21T00:00:00Z'), timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [50, 80, 100]);
  });

  it('reads a deadline that YAML parsed into a Date', () => {
    const b = new Budget(caseDir(), { overrides: { deadline: new Date('2026-11-30T00:00:00Z') } });
    assert.strictEqual(b.limitFor('deadline'), '2026-11-30');
  });

  it('does not rewrite budget.json on a quiet deadline charge', async () => {
    const d = caseDir();
    const b = new Budget(d, { overrides: { deadline: '2026-12-31' }, createdAt: '2026-09-01T00:00:00Z', now: () => new Date('2026-09-02T00:00:00Z'), timeZone: 'UTC' });
    b.charge('deadline', 0);
    const file = path.join(d, '.kl', 'budget.json');
    const before = { text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
    await sleep(30);
    b.charge('deadline', 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before.text);
    assert.strictEqual(fs.statSync(file).mtimeMs, before.mtime);
  });

  it('reconcile raises and lowers a limit, dropping and re-reporting thresholds', () => {
    const d = caseDir();
    const at10 = new Budget(d, { overrides: { usd: 10 } });
    at10.charge('usd', 9);
    assert.deepStrictEqual(at10.status().usd.crossed, [50, 80]);
    const at20 = new Budget(d, { overrides: { usd: 20 } });
    assert.deepStrictEqual(at20.reconcile(), {});
    assert.deepStrictEqual(at20.status().usd.crossed, []);
    const at5 = new Budget(d, { overrides: { usd: 5 } });
    assert.deepStrictEqual(at5.reconcile(), { usd: [50, 80, 100] });
    assert.deepStrictEqual(at5.exhausted(), ['usd']);
  });

  it('adds unpriced tokens to the usd entry and records grants', () => {
    const d = caseDir();
    const b = new Budget(d, { defaults: { usd: 20 } });
    b.charge('usd', 0, { unpricedTokens: 1200 });
    b.charge('usd', 0.5, { unpricedTokens: 0 });
    const usd = b.status().usd;
    assert.strictEqual(usd.unpricedTokens, 1200);
    assert.strictEqual(usd.spent, 0.5);
    b.recordGrant('usd', 'f-0007');
    b.recordGrant('usd', 'f-0007');
    assert.deepStrictEqual(b.status().usd.grantedBy, ['f-0007']);
  });

  it('refuses an unknown category', () => {
    assert.throws(() => new Budget(caseDir()).charge('tokens', 1), /Unknown budget category "tokens"/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-budget.test.js`
Expected: FAIL with `Cannot find module '../src/cases/budget'`

- [ ] **Step 3: Implement**

Create `src/cases/clock.js`:

```js
// src/cases/clock.js
// Local-day and local-time arithmetic in an IANA time zone, with Intl only
// (cases stage 2 spec §14: no date library). An empty or unknown zone means
// the host's own zone.
const { createLogger } = require('../logging');

const log = createLogger('cases/clock');
const warned = new Set();

function validTimeZone(tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    if (!warned.has(tz)) {
      warned.add(tz);
      log.warn(`Unknown time zone "${tz}"; using the host time zone.`);
    }
    return undefined;
  }
}

const pad = (n) => String(n).padStart(2, '0');

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function localDay(date, timeZone) {
  const p = parts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Milliseconds the zone is ahead of UTC at instant `ts`.
function offsetMs(ts, timeZone) {
  const p = parts(new Date(ts), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// The instant at `hour:minute` local time on local `day`.
function zonedTime(day, hour, minute, timeZone) {
  const [y, m, d] = String(day).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let ts = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(ts, timeZone);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

function parseHhmm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    if (text) log.warn(`"${text}" is not an HH:MM time; using 09:00.`);
    return [9, 0];
  }
  return [Number(m[1]), Number(m[2])];
}

// The next instant strictly after `now` that reads `hhmm` on the local clock.
function nextLocalTime(now, hhmm, timeZone) {
  const [h, mi] = parseHhmm(hhmm);
  const today = localDay(now, timeZone);
  let t = zonedTime(today, h, mi, timeZone);
  if (t.getTime() <= now.getTime()) t = zonedTime(addDays(today, 1), h, mi, timeZone);
  return t;
}

function nextLocalMidnight(now, timeZone) {
  return zonedTime(addDays(localDay(now, timeZone), 1), 0, 0, timeZone);
}

// YAML turns an unquoted timestamp into a Date; accept both forms.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

module.exports = {
  validTimeZone,
  localDay,
  addDays,
  zonedTime,
  parseHhmm,
  nextLocalTime,
  nextLocalMidnight,
  toMs
};
```

Create `src/cases/jsonfile.js`:

```js
// src/cases/jsonfile.js
// Small JSON files under a case's .kl/: read with a fallback, write through
// a temp file and a rename, and skip the write when nothing changed so a
// quiet sweep leaves a clean git tree.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('cases/jsonfile');

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    log.warn(`${file} is not valid JSON (${err.message}); using defaults.`);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeJsonIfChanged(file, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (current === next) return false;
  writeJson(file, value);
  return true;
}

module.exports = { readJson, writeJson, writeJsonIfChanged };
```

Create `src/cases/budget.js`:

```js
// src/cases/budget.js
// Per-case budgets in .kl/budget.json (cases stage 2 spec §3.5, program §4.4).
// The limit of a category is the case override, then the settings default;
// null or 0 means unlimited. The deadline ratio is computed, never stored.
const path = require('path');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { localDay, zonedTime, addDays } = require('./clock');

const CATEGORIES = Object.freeze(['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
const PER_DAY = Object.freeze(['turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
const THRESHOLDS = Object.freeze([50, 80, 100]);

const round = (n) => Number(Number(n).toFixed(8));
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class Budget {
  constructor(dir, { defaults = {}, overrides = {}, createdAt = null, now = () => new Date(), timeZone = '' } = {}) {
    this.dir = dir;
    this.path = path.join(dir, '.kl', 'budget.json');
    this.defaults = defaults && typeof defaults === 'object' ? defaults : {};
    this.overrides = overrides && typeof overrides === 'object' ? overrides : {};
    const created = createdAt instanceof Date ? createdAt : (createdAt ? new Date(createdAt) : null);
    this.createdAt = created && Number.isFinite(created.getTime()) ? created : null;
    this.now = now;
    this.timeZone = timeZone || '';
  }

  limitFor(category) {
    const raw = this.overrides[category] ?? this.defaults[category] ?? null;
    if (category === 'deadline') {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      return typeof raw === 'string' && DAY_PATTERN.test(raw) ? raw : null;
    }
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  _load() {
    const data = readJson(this.path, null);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  _entry(data, category) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown budget category "${category}". Categories: ${CATEGORIES.join(', ')}.`);
    }
    let e = data[category];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      e = category === 'deadline'
        ? { at: null, crossed: [], grantedBy: [] }
        : { spent: 0, limit: null, crossed: [], grantedBy: [] };
      if (category === 'usd') e.unpricedTokens = 0;
      if (PER_DAY.includes(category)) e.day = null;
      data[category] = e;
    }
    if (!Array.isArray(e.crossed)) e.crossed = [];
    if (!Array.isArray(e.grantedBy)) e.grantedBy = [];
    if (category === 'deadline') {
      e.at = this.limitFor('deadline');
    } else {
      e.limit = this.limitFor(category);
      if (!Number.isFinite(Number(e.spent))) e.spent = 0;
    }
    if (PER_DAY.includes(category)) {
      const today = localDay(this.now(), this.timeZone);
      // String compare on YYYY-MM-DD: a clock that jumps back never resets.
      if (!e.day || today > e.day) {
        e.day = today;
        e.spent = 0;
        e.crossed = [];
      }
    }
    return e;
  }

  _ratio(category, e) {
    if (category === 'deadline') {
      if (!e.at) return null;
      const end = zonedTime(addDays(e.at, 1), 0, 0, this.timeZone).getTime();
      const now = this.now().getTime();
      if (!this.createdAt) return now >= end ? 1 : 0;
      const start = this.createdAt.getTime();
      if (end <= start) return 1;
      return (now - start) / (end - start);
    }
    if (!e.limit) return null;
    return Number(e.spent) / e.limit;
  }

  // Sets e.crossed to exactly the thresholds the ratio reaches now and
  // returns the ones that were not reached before.
  _settle(category, e) {
    const r = this._ratio(category, e);
    const reached = r === null ? [] : THRESHOLDS.filter((t) => r * 100 >= t - 1e-9);
    const crossedNow = reached.filter((t) => !e.crossed.includes(t));
    e.crossed = reached;
    return crossedNow;
  }

  charge(category, amount = 0, meta = {}) {
    const data = this._load();
    const e = this._entry(data, category);
    if (category !== 'deadline') {
      const add = Number(amount);
      if (Number.isFinite(add) && add !== 0) e.spent = round(Number(e.spent) + add);
      if (category === 'usd') {
        const unpriced = Number(meta?.unpricedTokens);
        if (Number.isFinite(unpriced) && unpriced > 0) e.unpricedTokens = (Number(e.unpricedTokens) || 0) + unpriced;
      }
    }
    const crossedNow = this._settle(category, e);
    writeJsonIfChanged(this.path, data);
    return {
      spent: category === 'deadline' ? null : e.spent,
      limit: category === 'deadline' ? e.at : e.limit,
      crossedNow
    };
  }

  reconcile() {
    const data = this._load();
    const out = {};
    for (const c of CATEGORIES) {
      const crossedNow = this._settle(c, this._entry(data, c));
      if (crossedNow.length) out[c] = crossedNow;
    }
    writeJsonIfChanged(this.path, data);
    return out;
  }

  status() {
    const data = this._load();
    const out = {};
    for (const c of CATEGORIES) {
      const e = this._entry(data, c);
      this._settle(c, e);
      out[c] = { ...e, ratio: this._ratio(c, e) };
    }
    return out;
  }

  remaining(category) {
    const s = this.status()[category];
    if (category === 'deadline' || !s.limit) return null;
    return round(s.limit - s.spent);
  }

  exhausted() {
    const s = this.status();
    return ['usd', 'deadline'].filter((c) => s[c].ratio !== null && s[c].ratio >= 1);
  }

  atLimit(category) {
    const s = this.status()[category];
    return s.ratio !== null && s.ratio >= 1;
  }

  recordGrant(category, factId) {
    const data = this._load();
    const e = this._entry(data, category);
    if (factId && !e.grantedBy.includes(factId)) e.grantedBy.push(factId);
    writeJsonIfChanged(this.path, data);
  }
}

module.exports = { Budget, CATEGORIES, PER_DAY, THRESHOLDS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-budget.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/clock.js src/cases/jsonfile.js src/cases/budget.js tests/cases-budget.test.js
git commit -m "feat(cases): per-case budgets with local-day rollover and a computed deadline ratio

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wake-up store

**Files:**
- Create: `src/cases/wakeups.js`
- Test: `tests/cases-wakeups.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJsonIfChanged` (Task 2), `nextLocalTime`, `nextLocalMidnight` (Task 2).
- Produces: `class WakeupStore(dir, { now, timeZone, dailyAt = '09:00', backoffMinutes = [5, 15, 60] })` with `register({ kind, at | every, payload, createdBy }) → id`, `ensure(kind, spec) → id`, `list()`, `cancel(id) → boolean`, `cancelAll() → number`, `due(now) → entry[]`, `markRan(id, { outcome, error, now }) → entry | null`, `reanchor(now) → number`; constants `MIN_EVERY_MS`, `OUTCOMES`. Task 4 adds `ensureWakeupJob` and `WAKEUP_JOB_ID` to this module.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-wakeups.test.js`:

```js
// tests/cases-wakeups.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WakeupStore } = require('../src/cases/wakeups');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const caseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wakeups-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
};
const T0 = new Date('2026-09-23T12:00:00.000Z');
const plus = (d, ms) => new Date(d.getTime() + ms);
const HOUR = 3600000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function store({ clock = { now: T0 }, timeZone = 'UTC', dailyAt = '09:00' } = {}) {
  const d = caseDir();
  return { d, clock, s: new WakeupStore(d, { now: () => clock.now, timeZone, dailyAt }) };
}

describe('WakeupStore', () => {
  it('registers, lists, cancels and never reuses an id', () => {
    const { s } = store();
    const a = s.register({ kind: 'deadline-check', every: 86400000, payload: { key: 'deadline' } });
    const b = s.register({ kind: 'retry', at: '2026-09-23T13:00:00Z', payload: { key: 'r' }, createdBy: 'model' });
    assert.deepStrictEqual([a, b], ['w-0001', 'w-0002']);
    const [first, second] = s.list();
    assert.strictEqual(first.nextAt, '2026-09-24T12:00:00.000Z');
    assert.strictEqual(first.everyMs, 86400000);
    assert.strictEqual(first.at, null);
    assert.strictEqual(second.nextAt, '2026-09-23T13:00:00.000Z');
    assert.strictEqual(second.createdBy, 'model');
    assert.strictEqual(s.cancel(b), true);
    assert.strictEqual(s.cancel(b), false);
    assert.strictEqual(s.register({ kind: 'retry', at: '2026-09-23T14:00:00Z' }), 'w-0003');
    assert.strictEqual(s.cancelAll(), 2);
    assert.deepStrictEqual(s.list(), []);
  });

  it('validates at, every and kind', () => {
    const { s } = store();
    assert.throws(() => s.register({ kind: 'retry', every: 59999 }), /at least 60000/);
    assert.throws(() => s.register({ kind: 'retry', every: 90000.5 }), /integer/);
    assert.throws(() => s.register({ kind: 'retry', at: '2026-09-23T13:00:00Z', every: 60000 }), /exactly one/);
    assert.throws(() => s.register({ kind: 'retry' }), /exactly one/);
    assert.throws(() => s.register({ kind: 'retry', at: 'tomorrow' }), /RFC3339/);
    assert.throws(() => s.register({ kind: 'Retry Now', every: 60000 }), /kind/);
    assert.ok(s.register({ kind: 'detours:incoming', every: 60000 }));
  });

  it('ensure returns the existing id for the same kind and payload key', () => {
    const { s } = store();
    const a = s.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } }), a);
    assert.notStrictEqual(s.ensure('daily-orientation', { every: 86400000, payload: { key: 'other' } }), a);
    assert.strictEqual(s.list().length, 2);
  });

  it('anchors daily-orientation to dailyAt in the time zone', () => {
    const { s } = store({ dailyAt: '09:00' });
    s.register({ kind: 'daily-orientation', every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.list()[0].nextAt, '2026-09-24T09:00:00.000Z');
  });

  it('keeps daily-orientation at 09:00 local across a daylight-saving change', () => {
    const clock = { now: new Date('2026-10-30T13:00:00Z') }; // 09:00 EDT
    const { s } = store({ clock, timeZone: 'America/New_York' });
    const id = s.register({ kind: 'daily-orientation', every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.list()[0].nextAt, '2026-10-31T13:00:00.000Z');
    const ran = s.markRan(id, { outcome: 'quiet', now: new Date('2026-10-31T13:00:30Z') });
    assert.strictEqual(ran.nextAt, '2026-11-01T14:00:00.000Z', '09:00 EST, not 08:00');
  });

  it('marks runs: quiet and acted move every-entries on and remove at-entries', () => {
    const { s } = store();
    const every = s.register({ kind: 'deadline-check', every: HOUR });
    const once = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const at = plus(T0, 5 * 60000);
    assert.deepStrictEqual(s.due(at).map((w) => w.id), [once]);
    const moved = s.markRan(every, { outcome: 'quiet', now: at });
    assert.strictEqual(moved.nextAt, plus(at, HOUR).toISOString());
    assert.strictEqual(moved.lastOutcome, 'quiet');
    assert.strictEqual(s.markRan(once, { outcome: 'acted', now: at }), null);
    assert.deepStrictEqual(s.list().map((w) => w.id), [every]);
  });

  it('skipped keeps an at-entry and moves it to the next local midnight', () => {
    const { s } = store();
    const once = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const kept = s.markRan(once, { outcome: 'skipped', now: T0 });
    assert.strictEqual(kept.nextAt, '2026-09-24T00:00:00.000Z');
    assert.strictEqual(kept.attempts, 0);
  });

  it('failed backs off 5, 15, 60, then 60 minutes and records the error', () => {
    const { s } = store();
    const id = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const steps = [5, 15, 60, 60];
    steps.forEach((minutes, i) => {
      const w = s.markRan(id, { outcome: 'failed', error: 'provider down', now: T0 });
      assert.strictEqual(w.attempts, i + 1);
      assert.strictEqual(w.nextAt, plus(T0, minutes * 60000).toISOString());
      assert.strictEqual(w.lastError, 'provider down');
    });
    const ok = s.markRan(id, { outcome: 'skipped', now: T0 });
    assert.strictEqual(ok.attempts, 0);
    assert.throws(() => s.markRan(id, { outcome: 'maybe', now: T0 }), /outcome/);
  });

  it('a clock three days forward yields one due entry, rescheduled from now', () => {
    const { s } = store();
    const id = s.register({ kind: 'deadline-check', every: HOUR });
    const later = plus(T0, 3 * 24 * HOUR);
    assert.deepStrictEqual(s.due(later).map((w) => w.id), [id]);
    const w = s.markRan(id, { outcome: 'acted', now: later });
    assert.strictEqual(w.nextAt, plus(later, HOUR).toISOString());
    assert.deepStrictEqual(s.due(later), []);
  });

  it('a clock two hours back reanchors an every-entry that is now too far out', () => {
    const { s } = store();
    const id = s.register({ kind: 'deadline-check', every: HOUR });
    const earlier = plus(T0, -2 * HOUR);
    assert.strictEqual(s.reanchor(earlier), 1);
    assert.strictEqual(s.list().find((w) => w.id === id).nextAt, plus(earlier, HOUR).toISOString());
    assert.strictEqual(s.reanchor(earlier), 0);
  });

  it('writes only when something changes', async () => {
    const { d, s } = store();
    s.register({ kind: 'deadline-check', every: HOUR });
    const file = path.join(d, '.kl', 'wakeups.json');
    const mtime = fs.statSync(file).mtimeMs;
    await sleep(30);
    assert.strictEqual(s.markRan('w-0404', { outcome: 'quiet', now: T0 }), null);
    assert.strictEqual(s.reanchor(T0), 0);
    assert.strictEqual(s.cancel('w-0404'), false);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-wakeups.test.js`
Expected: FAIL with `Cannot find module '../src/cases/wakeups'`

- [ ] **Step 3: Implement**

Create `src/cases/wakeups.js`:

```js
// src/cases/wakeups.js
// Per-case wake-ups in .kl/wakeups.json (cases stage 2 spec §3.6, program
// §4.6). `every` is in milliseconds; daily-orientation is anchored to the
// owner's local dailyAt so it neither drifts nor jumps an hour at DST.
const path = require('path');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { nextLocalTime, nextLocalMidnight } = require('./clock');

const MIN_EVERY_MS = 60000;
const DEFAULT_BACKOFF_MINUTES = Object.freeze([5, 15, 60]);
const OUTCOMES = Object.freeze(['quiet', 'acted', 'skipped', 'failed']);
// Built-in kinds are bare words; later stages prefix theirs (`detours:incoming`).
const KIND_PATTERN = /^[a-z0-9-]+(?::[a-z0-9-]+)?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

class WakeupStore {
  constructor(dir, { now = () => new Date(), timeZone = '', dailyAt = '09:00', backoffMinutes = DEFAULT_BACKOFF_MINUTES } = {}) {
    this.dir = dir;
    this.path = path.join(dir, '.kl', 'wakeups.json');
    this.now = now;
    this.timeZone = timeZone || '';
    this.dailyAt = dailyAt || '09:00';
    const backoff = Array.isArray(backoffMinutes) ? backoffMinutes.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    this.backoffMinutes = backoff.length ? backoff : [...DEFAULT_BACKOFF_MINUTES];
  }

  _load() {
    const data = readJson(this.path, null);
    const items = Array.isArray(data?.items) ? data.items : [];
    const counter = Number.isInteger(data?.counter)
      ? data.counter
      : items.reduce((max, w) => Math.max(max, Number(String(w.id).replace(/^w-/, '')) || 0), 0);
    return { counter, items };
  }

  _save(data) {
    return writeJsonIfChanged(this.path, data);
  }

  _nextFor(entry, now) {
    if (entry.kind === 'daily-orientation') return nextLocalTime(now, this.dailyAt, this.timeZone).toISOString();
    return new Date(now.getTime() + entry.everyMs).toISOString();
  }

  list() {
    return this._load().items;
  }

  register({ kind, at = null, every = null, payload = {}, createdBy = 'runtime' } = {}) {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
      throw new Error(`Invalid wake-up kind "${kind}": use lower-case words, optionally "<module>:<kind>".`);
    }
    const hasAt = at !== null && at !== undefined;
    const hasEvery = every !== null && every !== undefined;
    if (hasAt === hasEvery) throw new Error('A wake-up needs exactly one of "at" or "every".');
    let atIso = null;
    let everyMs = null;
    if (hasAt) {
      if (typeof at !== 'string' || !RFC3339.test(at) || !Number.isFinite(Date.parse(at))) {
        throw new Error('"at" must be an RFC3339 date-time.');
      }
      atIso = new Date(Date.parse(at)).toISOString();
    } else {
      if (!Number.isInteger(every)) throw new Error(`"every" is in milliseconds and must be an integer of at least ${MIN_EVERY_MS}.`);
      if (every < MIN_EVERY_MS) throw new Error(`"every" is in milliseconds and must be at least ${MIN_EVERY_MS}.`);
      everyMs = every;
    }
    const data = this._load();
    data.counter += 1;
    const now = this.now();
    const entry = {
      id: `w-${String(data.counter).padStart(4, '0')}`,
      kind,
      at: atIso,
      everyMs,
      nextAt: null,
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
      createdBy: String(createdBy || 'runtime'),
      createdAt: now.toISOString(),
      lastRunAt: null,
      lastOutcome: null,
      attempts: 0,
      lastError: null
    };
    entry.nextAt = atIso || this._nextFor(entry, now);
    data.items.push(entry);
    this._save(data);
    return entry.id;
  }

  ensure(kind, spec = {}) {
    const key = spec.payload?.key ?? null;
    const existing = this.list().find((w) => w.kind === kind && (w.payload?.key ?? null) === key);
    return existing ? existing.id : this.register({ ...spec, kind });
  }

  cancel(id) {
    const data = this._load();
    const before = data.items.length;
    data.items = data.items.filter((w) => w.id !== id);
    if (data.items.length === before) return false;
    this._save(data);
    return true;
  }

  cancelAll() {
    const data = this._load();
    const n = data.items.length;
    if (!n) return 0;
    data.items = [];
    this._save(data);
    return n;
  }

  due(now = this.now()) {
    const t = now.getTime();
    return this.list().filter((w) => Date.parse(w.nextAt) <= t);
  }

  markRan(id, { outcome, error = null, now = this.now() } = {}) {
    if (!OUTCOMES.includes(outcome)) throw new Error(`Unknown wake-up outcome "${outcome}". Outcomes: ${OUTCOMES.join(', ')}.`);
    const data = this._load();
    const entry = data.items.find((w) => w.id === id);
    if (!entry) return null;
    entry.lastRunAt = now.toISOString();
    entry.lastOutcome = outcome;
    if (outcome === 'failed') {
      entry.attempts = (Number(entry.attempts) || 0) + 1;
      entry.lastError = error ? String(error) : null;
      const minutes = this.backoffMinutes[Math.min(entry.attempts, this.backoffMinutes.length) - 1];
      entry.nextAt = new Date(now.getTime() + minutes * 60000).toISOString();
    } else {
      entry.attempts = 0;
      entry.lastError = null;
      if (entry.everyMs) {
        entry.nextAt = this._nextFor(entry, now);
      } else if (outcome === 'skipped') {
        entry.nextAt = nextLocalMidnight(now, this.timeZone).toISOString();
      } else {
        data.items = data.items.filter((w) => w.id !== id);
      }
    }
    this._save(data);
    return data.items.find((w) => w.id === id) || null;
  }

  // After the clock jumps back, an every-entry can sit far in the future.
  reanchor(now = this.now()) {
    const data = this._load();
    let moved = 0;
    for (const w of data.items) {
      if (!w.everyMs) continue;
      if (Date.parse(w.nextAt) - now.getTime() > 2 * w.everyMs) {
        w.nextAt = this._nextFor(w, now);
        moved += 1;
      }
    }
    if (moved) this._save(data);
    return moved;
  }
}

module.exports = { WakeupStore, MIN_EVERY_MS, OUTCOMES, DEFAULT_BACKOFF_MINUTES };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-wakeups.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/wakeups.js tests/cases-wakeups.test.js
git commit -m "feat(cases): wake-up store with DST-safe daily anchor, backoff and reanchor

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Cron system jobs and the `cases:wakeups` job

**Files:**
- Modify: `src/cron/cron-executor.js` (constructor at `this.gateway = gateway;`, and the top of `execute(job)`)
- Modify: `src/cron/cron-scheduler.js` (`runNow` auto-disable branch; `addJob`, `updateJob`, `removeJob`)
- Modify: `src/cases/wakeups.js` (append `WAKEUP_JOB_ID` and `ensureWakeupJob`)
- Test: `tests/cases-wakeups.test.js` (append a `describe('cron system jobs')` block)

**Interfaces:**
- Consumes: `CronStore` (`src/cron/cron-store.js`: `load`, `get`, `add`, `update`, `list`), `CronScheduler`, `CronExecutor`.
- Produces: `CronExecutor.prototype.registerSystemJob(name, handler)`; `execute(job)` dispatches `job.system === true && job.payload.system` to the handler and returns `{ ok: true, ...result }`, `{ ok: false, error }` on a throw, or `{ ok: false, error: 'No handler for system job <name>' }`. `CronScheduler.addJob` strips `system` and `payload.system`; `updateJob`/`removeJob` throw `"<id>" is a system job managed by King Louie.`; `runNow` never auto-disables a system job. `wakeups.js` exports `WAKEUP_JOB_ID = 'cases:wakeups'` and `async ensureWakeupJob(cronStore) → job`. Part 2, Task 14 calls both from `createCore`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/cases-wakeups.test.js`:

```js
describe('cron system jobs', () => {
  const CronStore = require('../src/cron/cron-store');
  const CronExecutor = require('../src/cron/cron-executor');
  const CronScheduler = require('../src/cron/cron-scheduler');
  const { ensureWakeupJob, WAKEUP_JOB_ID } = require('../src/cases/wakeups');

  async function cron({ tickIntervalMs = 20 } = {}) {
    const d = caseDir();
    const cronStore = new CronStore(path.join(d, 'cron', 'jobs.json'));
    await cronStore.load();
    const executor = new CronExecutor(null, null, null);
    const scheduler = new CronScheduler(cronStore, executor, { tickIntervalMs });
    return { d, cronStore, executor, scheduler };
  }

  it('ensureWakeupJob creates the job once and repairs it on every start', async () => {
    const { cronStore, d } = await cron();
    const job = await ensureWakeupJob(cronStore);
    assert.strictEqual(job.id, WAKEUP_JOB_ID);
    assert.strictEqual(job.system, true);
    assert.strictEqual(job.enabled, true);
    assert.deepStrictEqual(job.schedule, { kind: 'every', everyMs: 60000 });
    assert.deepStrictEqual(job.payload, { system: 'cases:wakeups' });
    await ensureWakeupJob(cronStore);
    assert.strictEqual(cronStore.list().length, 1);

    await cronStore.update(WAKEUP_JOB_ID, { enabled: false, schedule: { kind: 'every', everyMs: 999999 }, state: { lastRunAtMs: 5, consecutiveErrors: 4 } });
    const again = new CronStore(path.join(d, 'cron', 'jobs.json'));
    await again.load();
    const repaired = await ensureWakeupJob(again);
    assert.strictEqual(repaired.enabled, true);
    assert.deepStrictEqual(repaired.schedule, { kind: 'every', everyMs: 60000 });
    assert.strictEqual(repaired.state.consecutiveErrors, 0);
    assert.strictEqual(repaired.state.lastRunAtMs, 5);
  });

  it('the real scheduler dispatches the system job and wraps the handler result', async () => {
    const { cronStore, executor, scheduler } = await cron();
    let calls = 0;
    executor.registerSystemJob('cases:wakeups', async () => { calls += 1; return { ran: 1, quiet: 0 }; });
    await ensureWakeupJob(cronStore);
    scheduler.start();
    try {
      for (let i = 0; i < 100 && calls === 0; i += 1) await sleep(20);
    } finally {
      scheduler.stop();
    }
    assert.ok(calls >= 1, 'handler ran');
    for (let i = 0; i < 50 && !cronStore.get(WAKEUP_JOB_ID).state?.lastResult; i += 1) await sleep(10);
    assert.deepStrictEqual(cronStore.get(WAKEUP_JOB_ID).state.lastResult, { ok: true, ran: 1, quiet: 0 });
  });

  it('counts a throwing handler as an error without ever disabling the job', async () => {
    const { cronStore, executor, scheduler } = await cron();
    executor.registerSystemJob('cases:wakeups', async () => { throw new Error('boom'); });
    await ensureWakeupJob(cronStore);
    for (let i = 0; i < 6; i += 1) {
      assert.deepStrictEqual(await scheduler.runNow(WAKEUP_JOB_ID), { ok: false, error: 'boom' });
    }
    const job = cronStore.get(WAKEUP_JOB_ID);
    assert.strictEqual(job.state.consecutiveErrors, 6);
    assert.strictEqual(job.enabled, true);
  });

  it('reports a system job with no handler', async () => {
    const { executor } = await cron();
    assert.deepStrictEqual(
      await executor.execute({ id: 'x', system: true, payload: { system: 'nope' } }),
      { ok: false, error: 'No handler for system job nope' }
    );
    assert.throws(() => executor.registerSystemJob('', () => {}), /name/);
    assert.throws(() => executor.registerSystemJob('a', null), /function/);
  });

  it('refuses to update or remove a system job and strips system from new jobs', async () => {
    const { cronStore, scheduler } = await cron();
    await ensureWakeupJob(cronStore);
    await assert.rejects(scheduler.updateJob(WAKEUP_JOB_ID, { enabled: false }), /"cases:wakeups" is a system job managed by King Louie\./);
    await assert.rejects(scheduler.removeJob(WAKEUP_JOB_ID), /"cases:wakeups" is a system job managed by King Louie\./);
    await assert.rejects(scheduler.addJob({ id: WAKEUP_JOB_ID, schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'hi' } }), /system job/);
    const mine = await scheduler.addJob({ id: 'mine', system: true, schedule: { kind: 'every', everyMs: 60000 }, payload: { system: 'cases:wakeups', message: 'hi' } });
    assert.strictEqual(mine.system, undefined);
    assert.deepStrictEqual(mine.payload, { message: 'hi' });
    const patched = await scheduler.updateJob('mine', { system: true, payload: { system: 'cases:wakeups', message: 'bye' } });
    assert.strictEqual(patched.system, undefined);
    assert.deepStrictEqual(patched.payload, { message: 'bye' });
    assert.strictEqual(await scheduler.removeJob('mine'), true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-wakeups.test.js`
Expected: FAIL with `ensureWakeupJob is not a function` (the new describe block), and the Task 3 tests still pass.

- [ ] **Step 3: Implement**

In `src/cron/cron-executor.js`, replace

```js
    this.gateway = gateway;
  }

  async execute(job) {
    if (!job || !job.payload) {
      throw new Error('Invalid job payload');
    }

```

with

```js
    this.gateway = gateway;
    // Jobs King Louie itself owns (cases stage 2 spec §3.6). Dispatched by
    // payload.system, never through the agent.
    this.systemHandlers = new Map();
  }

  registerSystemJob(name, handler) {
    if (typeof name !== 'string' || !name) throw new Error('registerSystemJob needs a job name');
    if (typeof handler !== 'function') throw new Error('registerSystemJob needs a handler function');
    this.systemHandlers.set(name, handler);
  }

  async execute(job) {
    if (!job || !job.payload) {
      throw new Error('Invalid job payload');
    }

    if (job.system === true && typeof job.payload.system === 'string') {
      const name = job.payload.system;
      const handler = this.systemHandlers.get(name);
      if (!handler) return { ok: false, error: `No handler for system job ${name}` };
      try {
        const result = await handler(job);
        return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
      } catch (err) {
        log.error(`system job ${name} failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    }

```

In `src/cron/cron-scheduler.js`, replace

```js
    } else if (newState.consecutiveErrors >= 5) {
```

with

```js
    } else if (newState.consecutiveErrors >= 5 && job.system !== true) {
```

and replace

```js
  async addJob(job) {
    return this.store.add(job);
  }

  async updateJob(id, patch) {
    return this.store.update(id, patch);
  }

  async removeJob(id) {
    return this.store.remove(id);
  }
```

with

```js
  // System jobs (payload.system) are created by King Louie through the
  // store, never through the Cron tool or IPC, and cannot be changed there.
  _refuseSystem(id) {
    if (this.store.get(id)?.system === true) {
      throw new Error(`"${id}" is a system job managed by King Louie.`);
    }
  }

  _stripSystem(fields) {
    const copy = { ...(fields || {}) };
    delete copy.system;
    if (copy.payload && typeof copy.payload === 'object') {
      copy.payload = { ...copy.payload };
      delete copy.payload.system;
    }
    return copy;
  }

  async addJob(job) {
    const clean = this._stripSystem(job);
    if (clean.id) this._refuseSystem(clean.id);
    return this.store.add(clean);
  }

  async updateJob(id, patch) {
    this._refuseSystem(id);
    return this.store.update(id, this._stripSystem(patch));
  }

  async removeJob(id) {
    this._refuseSystem(id);
    return this.store.remove(id);
  }
```

Append to `src/cases/wakeups.js`, replacing its last line

```js
module.exports = { WakeupStore, MIN_EVERY_MS, OUTCOMES, DEFAULT_BACKOFF_MINUTES };
```

with

```js
const WAKEUP_JOB_ID = 'cases:wakeups';
const WAKEUP_JOB_SPEC = Object.freeze({
  system: true,
  enabled: true,
  schedule: Object.freeze({ kind: 'every', everyMs: 60000 }),
  payload: Object.freeze({ system: WAKEUP_JOB_ID })
});

// One system job per data dir, written through the store (not addJob, which
// strips `system`). Idempotent: a job the owner disabled or that a bad run
// left erroring is put back as specified on every start.
async function ensureWakeupJob(cronStore) {
  const spec = {
    system: true,
    enabled: true,
    schedule: { ...WAKEUP_JOB_SPEC.schedule },
    payload: { ...WAKEUP_JOB_SPEC.payload }
  };
  const existing = cronStore.get(WAKEUP_JOB_ID);
  if (!existing) {
    return cronStore.add({ id: WAKEUP_JOB_ID, name: 'Case wake-ups', ...spec });
  }
  const same = existing.system === true
    && existing.enabled === true
    && JSON.stringify(existing.schedule) === JSON.stringify(spec.schedule)
    && JSON.stringify(existing.payload) === JSON.stringify(spec.payload)
    && (existing.state?.consecutiveErrors || 0) === 0;
  if (same) return existing;
  return cronStore.update(WAKEUP_JOB_ID, {
    ...spec,
    state: { ...(existing.state || {}), consecutiveErrors: 0 }
  });
}

module.exports = {
  WakeupStore,
  MIN_EVERY_MS,
  OUTCOMES,
  DEFAULT_BACKOFF_MINUTES,
  WAKEUP_JOB_ID,
  ensureWakeupJob
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-wakeups.test.js tests/cron-scheduler.test.js tests/cron-store.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cron/cron-executor.js src/cron/cron-scheduler.js src/cases/wakeups.js tests/cases-wakeups.test.js
git commit -m "feat(cron): protected system jobs and the cases:wakeups job

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Host-reserved source kinds and question records

**Files:**
- Modify: `src/cases/ledger.js` (the `user-message` check in `assert`, the `disclosable:` field in `_write`, and `module.exports`)
- Create: `src/cases/questions.js`
- Test: `tests/cases-questions.test.js`

**Interfaces:**
- Consumes: `FactLedger` (`src/cases/ledger.js`), `CaseRecords.writeJournal` (`src/cases/records.js`), `readJson`, `writeJson` (Task 2).
- Produces:
  - `ledger.js`: `HOST_SOURCE_KINDS` (`user-message`, `question`, `owner-action`). `FactLedger.assert` refuses a host kind without `provenance: 'user'` and `provenance: 'user'` without a host kind. `_write` keeps `disclosable: false` when the input asks for it.
  - `questions.js`: `class QuestionError(code, message, record)` (`INVALID`, `NOT_FOUND`, `ALREADY_ANSWERED`, `IS_BRIEFING`, `NOT_BRIEFING`); `class QuestionStore(dir, { now, caseId })` with `create(record) → record`, `findDuplicate(record) → record | null`, `list()`, `open()`, `get(id)`, `answer(id, { channel, text, optionId }) → record`, `acknowledge(id, { channel }) → record`, `recordDelivery(id, { channel, at, deliveryId }) → record`, `note(id, text) → record`, `expire(now) → { expired, overdue }`, `close(id, { reason, by }) → record`, `static registerAnswerHandler(type, { toFact, onAnswered })`, `static answerHandler(type) → { toFact, onAnswered } | null`; constants `KINDS`, `URGENCIES`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-questions.test.js`:

```js
// tests/cases-questions.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FactLedger, LedgerError } = require('../src/cases/ledger');
const { QuestionStore, QuestionError } = require('../src/cases/questions');
const { CaseRecords } = require('../src/cases/records');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function caseDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-questions-'));
  dirs.push(d);
  for (const sub of ['.kl', 'journal']) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, 'case.yaml'), 'id: case-lakeside\nslug: lakeside-lot\ntitle: Lakeside lot\nstatus: active\n');
  fs.writeFileSync(path.join(d, 'facts.jsonl'), '');
  return d;
}
const T0 = new Date('2026-09-23T12:00:00.000Z');
const ask = (over = {}) => ({ kind: 'question', text: 'Is the well on the lot shared with the neighbour?', urgency: 'normal', ...over });
const code = (c) => (err) => err instanceof QuestionError && err.code === c;

describe('host-reserved ledger source kinds', () => {
  it('ties question and owner-action sources to provenance user, and user to a host kind', () => {
    const l = new FactLedger(caseDir());
    const base = { stmt: 'Owner said so', subject: 'lot', attr: 'x', value: 1 };
    assert.throws(() => l.assert({ ...base, provenance: 'sourced', source: { kind: 'question', ref: 'q-0001' } }), LedgerError);
    assert.throws(() => l.assert({ ...base, provenance: 'external-agent', source: { kind: 'owner-action', ref: 'grant' } }), LedgerError);
    assert.throws(() => l.assert({ ...base, provenance: 'user', source: { kind: 'url', ref: 'https://records.example.org/1' } }), /host-verified owner source/);
    assert.strictEqual(l.assert({ ...base, provenance: 'user', source: { kind: 'owner-action', ref: 'grant' } }).provenance, 'user');
    assert.strictEqual(l.assert({ ...base, provenance: 'user', source: { kind: 'question', ref: 'q-0001' } }).provenance, 'user');
  });

  it('keeps a requested disclosable: false', () => {
    const l = new FactLedger(caseDir());
    const f = l.assert({ stmt: 's', subject: 'a', attr: 'b', value: 1, source: { kind: 'url', ref: 'https://records.example.org/1' }, disclosable: false });
    assert.strictEqual(f.disclosable, false);
  });
});

describe('QuestionStore.create', () => {
  it('fills the record and numbers ids by replaying the directory', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask());
    assert.strictEqual(q.id, 'q-0001');
    assert.strictEqual(q.caseId, 'case-lakeside');
    assert.strictEqual(q.createdAt, T0.toISOString());
    assert.deepStrictEqual(q.deliveries, []);
    assert.strictEqual(q.answer, null);
    assert.strictEqual(q.closed, null);
    assert.strictEqual(q.defaultOnSilence, 'hold');
    assert.deepStrictEqual(q.payload, { type: 'ask', mcpAnswerable: true });
    assert.deepStrictEqual(q.options, []);
    assert.strictEqual(new QuestionStore(d, { now: () => T0 }).create(ask({ text: 'Who holds the easement?' })).id, 'q-0002');
  });

  it('applies every validation rule', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const bad = [
      ask({ kind: 'poll' }),
      ask({ text: '   ' }),
      ask({ text: 'x'.repeat(2001) }),
      ask({ options: 'a,b' }),
      ask({ options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) }),
      ask({ options: [{ id: 'Bad Id', label: 'x' }] }),
      ask({ options: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }),
      ask({ options: [{ id: 'a', label: '' }] }),
      ask({ options: [{ id: 'a', label: 'x'.repeat(201) }] }),
      ask({ kind: 'briefing', options: [{ id: 'a', label: 'x' }] }),
      ask({ urgency: undefined }),
      ask({ urgency: 'urgent' }),
      ask({ expiresAt: 'next week' }),
      ask({ expiresAt: '2026-09-22T12:00:00Z' }),
      ask({ expiresAt: '2026-10-24T12:00:01Z' }),
      ask({ options: [{ id: 'a', label: 'Yes' }], defaultOnSilence: 'b' }),
      ask({ kind: 'briefing', defaultOnSilence: 'a' }),
      ask({ payload: { type: 7 } }),
      ask({ payload: { mcpAnswerable: 'no' } })
    ];
    for (const record of bad) assert.throws(() => s.create(record), code('INVALID'), JSON.stringify(record).slice(0, 80));
    const ok = s.create(ask({ options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], defaultOnSilence: 'no', expiresAt: '2026-10-23T12:00:00Z', payload: { type: 'direction', mcpAnswerable: false } }));
    assert.strictEqual(ok.defaultOnSilence, 'no');
    assert.strictEqual(ok.expiresAt, '2026-10-23T12:00:00.000Z');
    assert.deepStrictEqual(ok.payload, { type: 'direction', mcpAnswerable: false });
    assert.strictEqual(s.create({ kind: 'approval', text: 'Approve the envelope?', urgency: 'high' }).kind, 'approval');
  });

  it('returns the open duplicate instead of a new record, by text or by payload key', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const a = s.create(ask());
    assert.strictEqual(s.create(ask({ text: '  is the WELL on the lot shared with the neighbour? ' })).id, a.id);
    assert.notStrictEqual(s.create(ask({ kind: 'briefing', urgency: 'low' })).id, a.id);
    const b = s.create(ask({ text: 'Spent 20.1 of 20', payload: { type: 'budget-grant', key: 'budget-grant:usd' } }));
    assert.strictEqual(s.create(ask({ text: 'Spent 20.4 of 20', payload: { type: 'budget-grant', key: 'budget-grant:usd' } })).id, b.id);
    assert.strictEqual(s.findDuplicate(ask()).id, a.id);
  });

  it('refuses ids that are not question ids', () => {
    const s = new QuestionStore(caseDir());
    assert.strictEqual(s.get('../../case'), null);
    assert.throws(() => s.answer('../../case', { text: 'x' }), code('NOT_FOUND'));
  });
});

describe('QuestionStore.answer', () => {
  it('writes exactly one user fact with a question source, the answer, and a journal entry', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ options: [{ id: 'yes', label: 'Shared' }, { id: 'no', label: 'Not shared' }] }));
    const answered = s.answer(q.id, { channel: 'in-app', optionId: 'no' });
    const facts = [...new FactLedger(d).view().facts.values()];
    assert.strictEqual(facts.length, 1);
    const [fact] = facts;
    assert.strictEqual(fact.provenance, 'user');
    assert.deepStrictEqual(fact.source, { kind: 'question', ref: q.id, channel: 'in-app', at: T0.toISOString() });
    assert.strictEqual(fact.subject, 'question');
    assert.strictEqual(fact.attr, q.id);
    assert.strictEqual(fact.value, 'Not shared');
    assert.strictEqual(fact.stmt, 'Owner answered q-0001 ("Is the well on the lot shared with the neighbour?"): Not shared');
    assert.deepStrictEqual(answered.answer, { channel: 'in-app', at: T0.toISOString(), text: null, optionId: 'no', factId: fact.id });
    assert.match(new CaseRecords(d).lastJournal().text, /q-0001 answered via in-app: Not shared \(fact f-0001\)/);
    assert.deepStrictEqual(s.open(), []);
  });

  it('lands the fact on payload.about, supersedes payload.resolves, and honours disclosable and gating.category', () => {
    const d = caseDir();
    const l = new FactLedger(d);
    const u = l.unknown({ stmt: 'Is the well shared?', subject: 'lot', attr: 'well', changes: 'Buyer cost', answerable: 'owner', how: 'Ask' });
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ payload: { about: { subject: 'lot', attr: 'well' }, resolves: u.id, disclosable: false, gating: { category: 'property' } } }));
    s.answer(q.id, { channel: 'in-app', text: 'Shared with the north neighbour' });
    const view = l.view().facts;
    assert.strictEqual(view.get(u.id).status, 'superseded');
    const fact = view.get(view.get(u.id).supersededBy);
    assert.strictEqual(fact.subject, 'lot');
    assert.strictEqual(fact.attr, 'well');
    assert.strictEqual(fact.value, 'Shared with the north neighbour');
    assert.strictEqual(fact.disclosable, false);
    assert.strictEqual(fact.category, 'property');
  });

  it('uses a registered handler to build the fact', () => {
    QuestionStore.registerAnswerHandler('test-color', {
      toFact: (record, answer) => ({ stmt: `Owner picked ${answer.text}`, subject: 'paint', attr: 'color', value: answer.text.toUpperCase() })
    });
    assert.strictEqual(typeof QuestionStore.answerHandler('test-color').toFact, 'function');
    assert.strictEqual(QuestionStore.answerHandler('nope'), null);
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ text: 'Which color?', payload: { type: 'test-color' } }));
    s.answer(q.id, { channel: 'in-app', text: 'green' });
    const [fact] = new FactLedger(d).view().facts.values();
    assert.strictEqual(fact.value, 'GREEN');
    assert.strictEqual(fact.subject, 'paint');
  });

  it('two stores answering the same question write exactly one fact', () => {
    const d = caseDir();
    const q = new QuestionStore(d, { now: () => T0 }).create(ask());
    const desk = new QuestionStore(d, { now: () => T0 });
    const phone = new QuestionStore(d, { now: () => T0 });
    desk.answer(q.id, { channel: 'in-app', text: 'Yes, shared' });
    assert.throws(() => phone.answer(q.id, { channel: 'telegram', text: 'No' }), (err) => (
      err.code === 'ALREADY_ANSWERED'
      && err.message === `q-0001 was already answered via in-app at ${T0.toISOString()}.`
      && err.record.answer.text === 'Yes, shared'
    ));
    assert.strictEqual(new FactLedger(d).view().facts.size, 1);
  });

  it('refuses an empty answer, an unknown option, and answering a briefing', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const q = s.create(ask({ options: [{ id: 'yes', label: 'Yes' }] }));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: '  ' }), code('INVALID'));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', optionId: 'maybe' }), code('INVALID'));
    const b = s.create({ kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    assert.throws(() => s.answer(b.id, { channel: 'in-app', text: 'ok' }), code('IS_BRIEFING'));
    assert.strictEqual(s.get(q.id).answer, null, 'a refused answer leaves the question open');
  });

  it('releases the claim when the fact cannot be written', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ payload: { resolves: 'f-0404' } }));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: 'Yes' }), /f-0404/);
    assert.strictEqual(fs.existsSync(path.join(d, '.kl', 'questions', `${q.id}.claim`)), false);
  });
});

describe('briefings, deliveries, expiry and closing', () => {
  it('acknowledges a briefing without a fact', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const b = s.create({ kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const acked = s.acknowledge(b.id, { channel: 'in-app' });
    assert.deepStrictEqual(acked.answer, { channel: 'in-app', at: T0.toISOString(), text: null, optionId: null, factId: null });
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.throws(() => s.acknowledge(s.create(ask()).id, { channel: 'in-app' }), code('NOT_BRIEFING'));
    assert.throws(() => s.acknowledge(b.id, { channel: 'in-app' }), code('ALREADY_ANSWERED'));
  });

  it('records each delivery once and keeps notes', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const q = s.create(ask());
    s.recordDelivery(q.id, { channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' });
    const r = s.recordDelivery(q.id, { channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' });
    assert.deepStrictEqual(r.deliveries, [{ channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' }]);
    assert.deepStrictEqual(s.note(q.id, 'Raise the usd budget first.').notes, [{ at: T0.toISOString(), text: 'Raise the usd budget first.' }]);
  });

  it('expires: hold stays open and overdue, a default option applies without a fact, a briefing lapses', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const exp = '2026-09-24T12:00:00Z';
    const hold = s.create(ask({ expiresAt: exp }));
    const dflt = s.create(ask({ text: 'Relist at the same price?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], defaultOnSilence: 'no', expiresAt: exp }));
    const brief = s.create({ kind: 'briefing', text: 'Open house on Saturday.', urgency: 'low', expiresAt: exp });
    const later = new Date('2026-09-25T00:00:00Z');
    assert.deepStrictEqual(s.expire(new Date('2026-09-24T00:00:00Z')), { expired: [], overdue: [] });
    const r = s.expire(later);
    assert.deepStrictEqual(r, { expired: [dflt.id, brief.id], overdue: [hold.id] });
    assert.strictEqual(s.get(hold.id).answer, null);
    assert.deepStrictEqual(s.get(dflt.id).answer, { channel: 'default', at: later.toISOString(), text: null, optionId: 'no', factId: null });
    assert.strictEqual(s.get(brief.id).answer.channel, 'expired');
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.match(new CaseRecords(d).lastJournal().text, /expired: default no applied/);
    assert.throws(() => s.answer(dflt.id, { channel: 'in-app', text: 'Yes' }), code('ALREADY_ANSWERED'), 'expire holds the claim');
  });

  it('closes a record without an answer or a fact, and journals it', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask());
    const closed = s.close(q.id, { reason: 'resolved in a call', by: 'panel' });
    assert.deepStrictEqual(closed.closed, { at: T0.toISOString(), reason: 'resolved in a call', by: 'panel' });
    assert.strictEqual(closed.answer, null);
    assert.deepStrictEqual(s.open(), []);
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.match(new CaseRecords(d).lastJournal().text, /q-0001 closed by panel: resolved in a call/);
    assert.throws(() => s.close(s.create(ask({ text: 'Another?' })).id, { reason: 'x', by: 'robot' }), code('INVALID'));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: 'late' }), code('ALREADY_ANSWERED'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-questions.test.js`
Expected: FAIL with `Cannot find module '../src/cases/questions'`

- [ ] **Step 3: Implement**

In `src/cases/ledger.js`, replace

```js
    // A user-message source is what the verified owner-quote path writes; no
    // other provenance may claim the owner as its source.
    if (input.source.kind === 'user-message' && provenance !== 'user') {
      throw new LedgerError('A "user-message" source is only valid with provenance "user". Use provenance "user" with a "quote" of the owner\'s words.');
    }
    return this._write({ ...input, provenance });
```

with

```js
    // A user-message source is what the verified owner-quote path writes; no
    // other provenance may claim the owner as its source.
    if (input.source.kind === 'user-message' && provenance !== 'user') {
      throw new LedgerError('A "user-message" source is only valid with provenance "user". Use provenance "user" with a "quote" of the owner\'s words.');
    }
    // question and owner-action sources are written by host code only
    // (answers and the Grant button), and "user" needs one of the three.
    if (HOST_SOURCE_KINDS.has(input.source.kind) && provenance !== 'user') {
      throw new LedgerError(`A "${input.source.kind}" source is written only by the host, with provenance "user".`);
    }
    if (provenance === 'user' && !HOST_SOURCE_KINDS.has(input.source.kind)) {
      throw new LedgerError('provenance "user" needs a host-verified owner source (user-message, question or owner-action).');
    }
    return this._write({ ...input, provenance });
```

In `src/cases/ledger.js`, replace

```js
const ASSERT_PROVENANCE = new Set(['sourced', 'user', 'external-agent']);
```

with

```js
const ASSERT_PROVENANCE = new Set(['sourced', 'user', 'external-agent']);
const HOST_SOURCE_KINDS = new Set(['user-message', 'question', 'owner-action']);
```

In `src/cases/ledger.js`, replace

```js
      disclosable: !(
        fields.provenance === 'inferred'
        || fields.provenance === 'unknown'
        || SENSITIVE_CATEGORIES.has(fields.category)
      ),
```

with

```js
      // A caller may make a fact private at birth (a question with
      // payload.disclosable: false), never public against these rules.
      disclosable: fields.disclosable === false ? false : !(
        fields.provenance === 'inferred'
        || fields.provenance === 'unknown'
        || SENSITIVE_CATEGORIES.has(fields.category)
      ),
```

and replace

```js
module.exports = { FactLedger, LedgerError, SENSITIVE_CATEGORIES };
```

with

```js
module.exports = { FactLedger, LedgerError, SENSITIVE_CATEGORIES, HOST_SOURCE_KINDS };
```

Create `src/cases/questions.js`:

```js
// src/cases/questions.js
// Question records under .kl/questions/<id>.json (cases stage 2 spec §3.9,
// program §4.3). An answer becomes exactly one host-verified `user` fact;
// a `<id>.claim` marker made with O_EXCL decides who answered first.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { readJson, writeJson } = require('./jsonfile');
const { FactLedger } = require('./ledger');
const { CaseRecords } = require('./records');

const KINDS = Object.freeze(['question', 'approval', 'briefing']);
const URGENCIES = Object.freeze(['low', 'normal', 'high']);
const CLOSED_BY = Object.freeze(['panel', 'expiry', 'system']);
const ID_PATTERN = /^q-\d{4,}$/;
const FILE_PATTERN = /^q-\d{4,}\.json$/;
const OPTION_ID = /^[a-z0-9-]{1,16}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_EXPIRY_MS = 30 * 24 * 3600 * 1000;

const HANDLERS = new Map();

class QuestionError extends Error {
  constructor(code, message, record = null) {
    super(message);
    this.name = 'QuestionError';
    this.code = code;
    this.record = record;
  }
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const valueText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

function alreadyAnswered(rec) {
  let how = 'another surface';
  if (rec.answer) how = `${rec.answer.channel} at ${rec.answer.at}`;
  else if (rec.closed) how = `a close (${rec.closed.by}) at ${rec.closed.at}`;
  return new QuestionError('ALREADY_ANSWERED', `${rec.id} was already answered via ${how}.`, rec);
}

function defaultFactInput(rec, answer, option) {
  const about = rec.payload?.about && typeof rec.payload.about === 'object' ? rec.payload.about : {};
  const value = option ? option.label : answer.text;
  return {
    stmt: `Owner answered ${rec.id} ("${oneLine(rec.text, 80)}"): ${value}`,
    subject: typeof about.subject === 'string' && about.subject.trim() ? about.subject : 'question',
    attr: typeof about.attr === 'string' && about.attr.trim() ? about.attr : rec.id,
    value,
    ...(rec.payload?.resolves ? { supersedes: rec.payload.resolves } : {})
  };
}

class QuestionStore {
  constructor(dir, { now = () => new Date(), caseId = null } = {}) {
    this.dir = dir;
    this.qdir = path.join(dir, '.kl', 'questions');
    this.now = now;
    this._caseId = caseId;
  }

  static registerAnswerHandler(type, { toFact = null, onAnswered = null } = {}) {
    if (typeof type !== 'string' || !type) throw new Error('registerAnswerHandler needs a payload type.');
    HANDLERS.set(type, {
      toFact: typeof toFact === 'function' ? toFact : null,
      onAnswered: typeof onAnswered === 'function' ? onAnswered : null
    });
  }

  static answerHandler(type) {
    return HANDLERS.get(type) || null;
  }

  get caseId() {
    if (this._caseId) return this._caseId;
    try {
      this._caseId = yaml.load(fs.readFileSync(path.join(this.dir, 'case.yaml'), 'utf8'))?.id || null;
    } catch {
      this._caseId = null;
    }
    return this._caseId;
  }

  _path(id) {
    return path.join(this.qdir, `${id}.json`);
  }

  _write(rec) {
    writeJson(this._path(rec.id), rec);
  }

  get(id) {
    if (!ID_PATTERN.test(String(id))) return null;
    return readJson(this._path(id), null);
  }

  _require(id) {
    const rec = this.get(id);
    if (!rec) throw new QuestionError('NOT_FOUND', `Question ${id} was not found in this case.`);
    return rec;
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.qdir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return names
      .filter((n) => FILE_PATTERN.test(n))
      .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)))
      .map((n) => readJson(path.join(this.qdir, n), null))
      .filter(Boolean);
  }

  open() {
    return this.list().filter((r) => r.answer === null && !r.closed);
  }

  _nextId() {
    const max = this.list().reduce((m, r) => Math.max(m, Number(String(r.id).slice(2)) || 0), 0);
    return `q-${String(max + 1).padStart(4, '0')}`;
  }

  findDuplicate(record) {
    const text = normText(record?.text);
    const key = record?.payload?.key;
    return this.open().find((r) => r.kind === record?.kind && (
      normText(r.text) === text || (Boolean(key) && r.payload?.key === key)
    )) || null;
  }

  _validate(record) {
    const bad = (message) => { throw new QuestionError('INVALID', message); };
    if (!record || typeof record !== 'object') bad('A question record is required.');
    if (!KINDS.includes(record.kind)) bad(`kind must be one of ${KINDS.join(', ')}.`);
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text.length < 1 || text.length > 2000) bad('text must be 1 to 2000 characters.');
    let options = [];
    if (record.options !== undefined && record.options !== null) {
      if (!Array.isArray(record.options)) bad('options must be a list of { id, label }.');
      if (record.kind === 'briefing' && record.options.length) bad('A briefing takes no options.');
      if (record.options.length > 6) bad('A question takes at most 6 options.');
      const seen = new Set();
      options = record.options.map((o) => {
        const id = String(o?.id ?? '');
        const label = typeof o?.label === 'string' ? o.label.trim() : '';
        if (!OPTION_ID.test(id)) bad(`Option id "${id}" must match ^[a-z0-9-]{1,16}$.`);
        if (seen.has(id)) bad(`Option id "${id}" is used twice.`);
        seen.add(id);
        if (label.length < 1 || label.length > 200) bad(`Option "${id}" needs a label of 1 to 200 characters.`);
        return { id, label };
      });
    }
    if (!URGENCIES.includes(record.urgency)) bad(`urgency must be one of ${URGENCIES.join(', ')}.`);
    let expiresAt = null;
    if (record.expiresAt !== undefined && record.expiresAt !== null) {
      const t = Date.parse(record.expiresAt);
      if (typeof record.expiresAt !== 'string' || !RFC3339.test(record.expiresAt) || !Number.isFinite(t)) {
        bad('expiresAt must be an RFC3339 date-time or null.');
      }
      const now = this.now().getTime();
      if (t <= now) bad('expiresAt must be in the future.');
      if (t - now > MAX_EXPIRY_MS) bad('expiresAt must be at most 30 days out.');
      expiresAt = new Date(t).toISOString();
    }
    const defaultOnSilence = record.defaultOnSilence ?? 'hold';
    if (defaultOnSilence !== 'hold') {
      if (record.kind === 'briefing') bad('A briefing can only hold on silence.');
      if (!options.some((o) => o.id === defaultOnSilence)) bad(`defaultOnSilence "${defaultOnSilence}" is not one of the options.`);
    }
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? { ...record.payload }
      : {};
    if (payload.type === undefined) payload.type = 'ask';
    else if (typeof payload.type !== 'string' || !payload.type) bad('payload.type must be a non-empty string.');
    if (payload.mcpAnswerable === undefined) payload.mcpAnswerable = true;
    else if (typeof payload.mcpAnswerable !== 'boolean') bad('payload.mcpAnswerable must be true or false.');
    return { kind: record.kind, text, options, urgency: record.urgency, expiresAt, defaultOnSilence, payload };
  }

  create(record) {
    const clean = this._validate(record);
    const dup = this.findDuplicate(clean);
    if (dup) return dup;
    fs.mkdirSync(this.qdir, { recursive: true });
    const rec = {
      id: this._nextId(),
      kind: clean.kind,
      caseId: this.caseId,
      text: clean.text,
      options: clean.options,
      urgency: clean.urgency,
      createdAt: this.now().toISOString(),
      expiresAt: clean.expiresAt,
      defaultOnSilence: clean.defaultOnSilence,
      deliveries: [],
      payload: clean.payload,
      answer: null,
      closed: null,
      notes: []
    };
    this._write(rec);
    return rec;
  }

  _claim(rec) {
    fs.mkdirSync(this.qdir, { recursive: true });
    try {
      fs.closeSync(fs.openSync(path.join(this.qdir, `${rec.id}.claim`), 'wx'));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      throw alreadyAnswered(this.get(rec.id) || rec);
    }
  }

  _tryClaim(rec) {
    try {
      this._claim(rec);
      return true;
    } catch (err) {
      if (err.code === 'ALREADY_ANSWERED') return false;
      throw err;
    }
  }

  _unclaim(id) {
    fs.rmSync(path.join(this.qdir, `${id}.claim`), { force: true });
  }

  answer(id, { channel = 'in-app', text = null, optionId = null } = {}) {
    const rec = this._require(id);
    if (rec.kind === 'briefing') throw new QuestionError('IS_BRIEFING', `${id} is a briefing; acknowledge it instead of answering.`, rec);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    const wantsOption = optionId !== null && optionId !== undefined;
    const option = wantsOption ? rec.options.find((o) => o.id === optionId) : null;
    if (wantsOption && !option) throw new QuestionError('INVALID', `Option "${optionId}" is not one of ${id}'s options.`, rec);
    const answerText = typeof text === 'string' && text.trim() ? text.trim() : null;
    if (!option && !answerText) throw new QuestionError('INVALID', 'An answer needs text or an option.', rec);
    this._claim(rec);
    try {
      const at = this.now().toISOString();
      const answer = { channel: String(channel), at, text: answerText, optionId: option ? option.id : null };
      const handler = HANDLERS.get(rec.payload?.type);
      const input = handler?.toFact ? handler.toFact(rec, answer) : defaultFactInput(rec, answer, option);
      const fact = new FactLedger(this.dir).assert({
        ...input,
        ...(rec.payload?.disclosable === false ? { disclosable: false } : {}),
        ...(rec.payload?.gating?.category ? { category: rec.payload.gating.category } : {}),
        provenance: 'user',
        source: { kind: 'question', ref: rec.id, channel: answer.channel, at },
        addedBy: `question:${rec.id}`
      });
      rec.answer = { ...answer, factId: fact.id };
      this._write(rec);
      new CaseRecords(this.dir).writeJournal('question', `${rec.id} answered via ${answer.channel}: ${valueText(fact.value)} (fact ${fact.id})`, this.now());
      return rec;
    } catch (err) {
      if (!rec.answer) this._unclaim(rec.id);
      throw err;
    }
  }

  acknowledge(id, { channel = 'in-app' } = {}) {
    const rec = this._require(id);
    if (rec.kind !== 'briefing') throw new QuestionError('NOT_BRIEFING', `${id} is a ${rec.kind}; answer it instead.`, rec);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    this._claim(rec);
    rec.answer = { channel: String(channel), at: this.now().toISOString(), text: null, optionId: null, factId: null };
    this._write(rec);
    return rec;
  }

  recordDelivery(id, { channel, at = null, deliveryId }) {
    const rec = this._require(id);
    if (!rec.deliveries.some((d) => d.deliveryId === deliveryId)) {
      rec.deliveries.push({ channel: String(channel), at: at || this.now().toISOString(), deliveryId: String(deliveryId) });
      this._write(rec);
    }
    return rec;
  }

  note(id, text) {
    const rec = this._require(id);
    rec.notes = [...(Array.isArray(rec.notes) ? rec.notes : []), { at: this.now().toISOString(), text: String(text) }];
    this._write(rec);
    return rec;
  }

  expire(now = this.now()) {
    const t = now.getTime();
    const expired = [];
    const overdue = [];
    for (const rec of this.open()) {
      if (!rec.expiresAt || Date.parse(rec.expiresAt) > t) continue;
      if (rec.kind === 'briefing') {
        if (this._tryClaim(rec)) {
          rec.answer = { channel: 'expired', at: now.toISOString(), text: null, optionId: null, factId: null };
          this._write(rec);
          expired.push(rec.id);
        }
        continue;
      }
      if (rec.defaultOnSilence === 'hold') {
        overdue.push(rec.id);
        continue;
      }
      if (this._tryClaim(rec)) {
        rec.answer = { channel: 'default', at: now.toISOString(), text: null, optionId: rec.defaultOnSilence, factId: null };
        this._write(rec);
        new CaseRecords(this.dir).writeJournal('question', `${rec.id} expired: default ${rec.defaultOnSilence} applied`, now);
        expired.push(rec.id);
      }
    }
    return { expired, overdue };
  }

  close(id, { reason = '', by = 'system' } = {}) {
    if (!CLOSED_BY.includes(by)) throw new QuestionError('INVALID', `by must be one of ${CLOSED_BY.join(', ')}.`);
    const rec = this._require(id);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    this._claim(rec);
    rec.closed = { at: this.now().toISOString(), reason: String(reason), by };
    this._write(rec);
    new CaseRecords(this.dir).writeJournal('question', `${rec.id} closed by ${by}: ${reason || 'no reason given'}`, this.now());
    return rec;
  }
}

module.exports = { QuestionStore, QuestionError, KINDS, URGENCIES };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-questions.test.js tests/cases-ledger.test.js tests/cases-tools.test.js tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/ledger.js src/cases/questions.js tests/cases-questions.test.js
git commit -m "feat(cases): question records with claimed answers and host-reserved fact sources

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Re-orientation triggers

**Files:**
- Create: `src/cases/triggers.js`
- Test: `tests/cases-triggers.test.js`

**Interfaces:**
- Consumes: `toMs` (Task 2), `createLogger`.
- Produces: `detectTriggers({ source, now, meta, facts, decisions, budget, executors, plan, playbookChanges, hookTriggers, baseline, reorientAfterHours }) → Trigger[]` with `Trigger = { kind, key, detail, blocking: true, decisionIds? }`; `underminedKeys(decisions, facts) → [{ key, decision, factId, fact }]`; `emptyBaseline() → { acknowledgedAt, undermined, executorsMaterial, budgetCrossed, acknowledgedKeys, caseTypeMaterial, commitFailures }`; `deepEqual(a, b)`. Part 2's `CaseRuntime` reads and writes the baseline file (`.kl/triggers.json`) and calls `detectTriggers`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-triggers.test.js`:

```js
// tests/cases-triggers.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { detectTriggers, underminedKeys, emptyBaseline, deepEqual } = require('../src/cases/triggers');

const NOW = new Date('2026-09-23T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const fact = (id, over = {}) => [id, { id, status: 'active', supersededBy: null, ...over }];
const kinds = (ts) => ts.map((t) => t.kind);

function input(over = {}) {
  return {
    source: 'owner',
    now: NOW,
    meta: { lastOwnerTurnAt: hoursAgo(1) },
    facts: new Map(),
    decisions: [],
    budget: null,
    executors: null,
    plan: null,
    playbookChanges: [],
    hookTriggers: [],
    baseline: emptyBaseline(),
    reorientAfterHours: 8,
    ...over
  };
}

describe('detectTriggers', () => {
  it('raises nothing for a quiet case, and every trigger is inert without its input', () => {
    assert.deepStrictEqual(detectTriggers(input()), []);
    assert.deepStrictEqual(detectTriggers({}), []);
  });

  it('time-gap: owner turns only, measured from the last owner turn', () => {
    const gap = detectTriggers(input({ meta: { lastOwnerTurnAt: hoursAgo(9) } }));
    assert.deepStrictEqual(kinds(gap), ['time-gap']);
    assert.strictEqual(gap[0].key, 'time-gap');
    assert.strictEqual(gap[0].blocking, true);
    assert.match(gap[0].detail, /9 hours ago/);
    assert.deepStrictEqual(detectTriggers(input({ source: 'wakeup', meta: { lastOwnerTurnAt: hoursAgo(90) } })), []);
    assert.deepStrictEqual(detectTriggers(input({ meta: { lastOwnerTurnAt: hoursAgo(7.9) } })), []);
    assert.deepStrictEqual(detectTriggers(input({ meta: {} })), []);
    assert.deepStrictEqual(kinds(detectTriggers(input({ meta: { lastOwnerTurnAt: new Date(hoursAgo(9)) } }))), ['time-gap'], 'a YAML Date works too');
  });

  it('time-gap: a lastOwnerTurnAt in the future raises nothing and is logged', () => {
    const lines = [];
    const remove = addSink((r) => lines.push(r.line));
    try {
      assert.deepStrictEqual(detectTriggers(input({ meta: { lastOwnerTurnAt: '2026-09-24T12:00:00Z' } })), []);
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => /in the future/.test(l)), lines.join('\n'));
  });

  it('decision-undermined: once per decision and fact, until baselined', () => {
    const facts = new Map([fact('f-0001', { status: 'superseded', supersededBy: 'f-0003' }), fact('f-0002'), fact('f-0003')]);
    const decisions = [{ id: 'D-001', decision: 'Price per acre off the GIS layer', factIds: ['f-0001', 'f-0002'] }];
    const t = detectTriggers(input({ facts, decisions }));
    assert.deepStrictEqual(t, [{
      kind: 'decision-undermined',
      key: 'D-001:f-0001',
      blocking: true,
      decisionIds: ['D-001'],
      detail: 'D-001 ("Price per acre off the GIS layer") cites f-0001, which is now superseded by f-0003.'
    }]);
    assert.deepStrictEqual(underminedKeys(decisions, facts).map((u) => u.key), ['D-001:f-0001']);
    assert.deepStrictEqual(detectTriggers(input({ facts, decisions, baseline: { ...emptyBaseline(), undermined: ['D-001:f-0001'] } })), []);
  });

  it('executor-change: only for a known, non-stale executor whose material changed (C3 input)', () => {
    const baseline = { ...emptyBaseline(), executorsMaterial: { 'phone-agent': { openJobs: 1 } } };
    const changed = detectTriggers(input({ baseline, executors: { 'phone-agent': { stale: false, material: { openJobs: 2 } } } }));
    assert.deepStrictEqual(kinds(changed), ['executor-change']);
    assert.strictEqual(changed[0].key, 'executor:phone-agent');
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'phone-agent': { stale: true, material: { openJobs: 5 } } } })), []);
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'phone-agent': { material: { openJobs: 1 } } } })), []);
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'web-01': { material: { openJobs: 9 } } } })), [], 'a new executor joins silently');
  });

  it('budget-threshold: 80 and 100 not yet in the baseline', () => {
    const budget = { usd: { spent: 17, limit: 20, crossed: [50, 80] }, turnsPerDay: { spent: 48, limit: 48, crossed: [50, 80, 100] } };
    const baseline = { ...emptyBaseline(), budgetCrossed: { usd: [50], turnsPerDay: [50, 80, 100] } };
    const t = detectTriggers(input({ budget, baseline }));
    assert.deepStrictEqual(t.map((x) => x.key), ['budget:usd:80']);
    assert.match(t[0].detail, /usd budget passed 80 % \(17 of 20\)/);
    const deadline = detectTriggers(input({ budget: { deadline: { at: '2026-11-30', crossed: [50, 80] } } }));
    assert.match(deadline[0].detail, /deadline \(2026-11-30\)/);
  });

  it('message-mid-plan: owner turns while a step is in flight (C3 input), never baselined', () => {
    const plan = { steps: [{ id: 's1', state: 'done' }, { id: 's2', state: 'in-flight' }] };
    assert.deepStrictEqual(kinds(detectTriggers(input({ plan }))), ['message-mid-plan']);
    assert.deepStrictEqual(detectTriggers(input({ plan, source: 'wakeup' })), []);
    assert.deepStrictEqual(detectTriggers(input({ plan: { steps: [{ id: 's1', state: 'pending' }] } })), []);
  });

  it('playbook-update: one per change (C6 input)', () => {
    const t = detectTriggers(input({ playbookChanges: [{ name: 'land-sale', from: 'v1', to: 'v2' }] }));
    assert.deepStrictEqual(t.map((x) => [x.kind, x.key]), [['playbook-update', 'playbook:land-sale:v2']]);
  });

  it('playbook-update: uses the key and detail C6 supplies', () => {
    const t = detectTriggers(input({ playbookChanges: [{ name: 'land-sale', from: '1.2.0', to: '1.2.0', key: 'playbook:land-sale:edited:ab12', detail: 'Playbook land-sale was edited locally.' }] }));
    assert.deepStrictEqual(t.map((x) => [x.key, x.detail]), [['playbook:land-sale:edited:ab12', 'Playbook land-sale was edited locally.']]);
  });

  it('hook triggers: kept unless acknowledged, and blocking unless they say otherwise', () => {
    const hookTriggers = [
      { kind: 'detour', key: 'detour:msg-7', detail: 'The owner changed the subject.' },
      { kind: 'note', key: 'note:1', detail: 'FYI', blocking: false },
      { kind: 'broken' }
    ];
    const t = detectTriggers(input({ hookTriggers }));
    assert.deepStrictEqual(t.map((x) => [x.key, x.blocking]), [['detour:msg-7', true], ['note:1', false]]);
    const acked = detectTriggers(input({ hookTriggers, baseline: { ...emptyBaseline(), acknowledgedKeys: ['detour:msg-7'] } }));
    assert.deepStrictEqual(acked.map((x) => x.key), ['note:1']);
  });

  it('deepEqual compares nested values', () => {
    assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual([1], { 0: 1 }));
    assert.ok(deepEqual(null, null));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-triggers.test.js`
Expected: FAIL with `Cannot find module '../src/cases/triggers'`

- [ ] **Step 3: Implement**

Create `src/cases/triggers.js`:

```js
// src/cases/triggers.js
// Re-orientation triggers (cases stage 2 spec §3.3). Pure apart from a log
// line: the runtime reads the case files and the baseline and passes them in.
const { toMs } = require('./clock');
const { createLogger } = require('../logging');

const log = createLogger('cases/triggers');

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function emptyBaseline() {
  return {
    acknowledgedAt: null,
    undermined: [],
    executorsMaterial: {},
    budgetCrossed: {},
    acknowledgedKeys: [],
    caseTypeMaterial: {},
    commitFailures: 0
  };
}

// Every (decision, cited fact) pair whose fact is no longer active.
function underminedKeys(decisions = [], facts = new Map()) {
  const out = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    for (const factId of Array.isArray(decision?.factIds) ? decision.factIds : []) {
      const f = facts.get(factId);
      if (f && f.status !== 'active') out.push({ key: `${decision.id}:${factId}`, decision, factId, fact: f });
    }
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v : []);

function detectTriggers(input = {}) {
  const {
    source = 'owner',
    now = new Date(),
    meta = {},
    facts = new Map(),
    decisions = [],
    budget = null,
    executors = null,
    plan = null,
    playbookChanges = [],
    hookTriggers = [],
    reorientAfterHours = 8
  } = input;
  const baseline = { ...emptyBaseline(), ...(input.baseline || {}) };
  const out = [];

  // Owner turns only: wake-ups leave "has anything changed?" to the orient step.
  if (source === 'owner' && meta && meta.lastOwnerTurnAt) {
    const last = toMs(meta.lastOwnerTurnAt);
    if (!Number.isFinite(last)) {
      log.warn(`lastOwnerTurnAt "${meta.lastOwnerTurnAt}" is not a date; no time-gap check.`);
    } else if (last > now.getTime()) {
      log.warn(`lastOwnerTurnAt ${new Date(last).toISOString()} is in the future; no time-gap check.`);
    } else {
      const hours = (now.getTime() - last) / 3600000;
      if (hours > reorientAfterHours) {
        out.push({
          kind: 'time-gap',
          key: 'time-gap',
          blocking: true,
          detail: `The owner's last turn was ${Math.floor(hours)} hours ago (${new Date(last).toISOString()}). Re-read the case before acting on anything decided then.`
        });
      }
    }
  }

  for (const u of underminedKeys(decisions, facts)) {
    if (list(baseline.undermined).includes(u.key)) continue;
    out.push({
      kind: 'decision-undermined',
      key: u.key,
      blocking: true,
      decisionIds: [u.decision.id],
      detail: `${u.decision.id} ("${u.decision.decision}") cites ${u.factId}, which is now ${u.fact.status}${u.fact.supersededBy ? ` by ${u.fact.supersededBy}` : ''}.`
    });
  }

  if (executors && typeof executors === 'object') {
    const known = baseline.executorsMaterial || {};
    for (const [id, entry] of Object.entries(executors)) {
      if (!entry || entry.stale) continue;
      if (!Object.prototype.hasOwnProperty.call(known, id)) continue;
      const material = entry.material ?? null;
      if (!deepEqual(material, known[id])) {
        out.push({
          kind: 'executor-change',
          key: `executor:${id}`,
          blocking: true,
          detail: `Executor ${id} changed: ${JSON.stringify(known[id])} -> ${JSON.stringify(material)}.`
        });
      }
    }
  }

  if (budget && typeof budget === 'object') {
    for (const [category, e] of Object.entries(budget)) {
      const seen = list(baseline.budgetCrossed?.[category]);
      for (const t of [80, 100]) {
        if (!list(e?.crossed).includes(t) || seen.includes(t)) continue;
        out.push({
          kind: 'budget-threshold',
          key: `budget:${category}:${t}`,
          blocking: true,
          detail: category === 'deadline'
            ? `${t} % of the time to the deadline (${e.at}) has passed.`
            : `The ${category} budget passed ${t} % (${e.spent} of ${e.limit}).`
        });
      }
    }
  }

  if (source === 'owner' && list(plan?.steps).some((s) => s && s.state === 'in-flight')) {
    out.push({
      kind: 'message-mid-plan',
      key: 'mid-plan',
      blocking: true,
      detail: 'The owner wrote while a plan step is in flight. Decide whether the message changes the plan before continuing it.'
    });
  }

  for (const p of list(playbookChanges)) {
    if (!p || !p.name) continue;
    out.push({
      kind: 'playbook-update',
      // C6 supplies its own `key` and `detail` (an `edited` change keeps the same version);
      // fall back to the name/version form when they are absent.
      key: typeof p.key === 'string' && p.key ? p.key : `playbook:${p.name}:${p.to ?? 'removed'}`,
      blocking: true,
      detail: typeof p.detail === 'string' && p.detail ? p.detail : `Playbook ${p.name} changed (${p.from ?? 'none'} -> ${p.to ?? 'removed'}).`
    });
  }

  for (const t of list(hookTriggers)) {
    if (!t || typeof t.key !== 'string' || typeof t.kind !== 'string') continue;
    if (list(baseline.acknowledgedKeys).includes(t.key)) continue;
    out.push({ ...t, blocking: t.blocking !== false, detail: String(t.detail || t.kind) });
  }

  return out;
}

module.exports = { detectTriggers, underminedKeys, emptyBaseline, deepEqual };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-triggers.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/triggers.js tests/cases-triggers.test.js
git commit -m "feat(cases): re-orientation trigger detection

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Model roles and routing to an explicit target

**Files:**
- Create: `src/cases/roles.js`
- Modify: `src/providers/inference-router.js` (`execute` from `const mergedOptions = {` through the tools branch; the first two lines of `routeWithFallback`; the two uses of `options` inside its loop)
- Test: `tests/cases-roles.test.js`
- Test: `tests/inference-router.test.js` (append one `describe` block)

**Interfaces:**
- Consumes: `createLogger`.
- Produces:
  - `roles.js`: `ROLES`, `DEFAULT_ROLES`, `TIERS`, `NO_RETRY` (`{ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) }`), `tierTarget(tier, settings) → { provider, model, tier }`, `providerFamily(provider, model) → string`, `resolveRole(role, { settings, caseMeta, hasToken = () => true }) → { provider, model, tier }`.
  - `InferenceRouter.routeWithFallback(tier, messages, options)` accepts `options.target = { provider, model }`, which replaces `getTierConfig(tier)` and is stripped before `execute`. `execute` streams through `streamMessageWithTools(messages, tools, options, onChunk)` when `options.onChunk` is a function, tools are present and the provider has `streamMessageWithTools`; `onChunk` is never passed to the provider inside `options`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-roles.test.js`:

```js
// tests/cases-roles.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { resolveRole, providerFamily, tierTarget, NO_RETRY, ROLES, DEFAULT_ROLES } = require('../src/cases/roles');

const settings = (over = {}) => ({
  activeProvider: 'openai',
  inference: {
    tierMap: {
      fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      standard: { provider: 'openai', model: 'gpt-4o-mini' },
      smart: { provider: 'anthropic', model: 'claude-sonnet-4' }
    }
  },
  ...over
});

function captureWarnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('resolveRole', () => {
  it('names five roles with the spec defaults', () => {
    assert.deepStrictEqual([...ROLES], ['orient', 'classify', 'draft', 'judge', 'verify']);
    assert.deepStrictEqual(DEFAULT_ROLES.judge, { tier: 'smart' });
    assert.deepStrictEqual(DEFAULT_ROLES.orient, { tier: 'fast' });
  });

  it('resolves a tier through the tier map, falling back to the active provider', () => {
    assert.deepStrictEqual(resolveRole('orient', { settings: settings() }), { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' });
    assert.deepStrictEqual(tierTarget('smart', { activeProvider: 'Gemini' }), { provider: 'gemini', model: '', tier: 'smart' });
    assert.deepStrictEqual(tierTarget('bogus', settings()), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
  });

  it('prefers case.yaml roles over settings.cases.roles over the defaults', () => {
    const s = settings({ cases: { roles: { judge: { tier: 'standard' } } } });
    assert.deepStrictEqual(resolveRole('judge', { settings: s }), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    const caseMeta = { roles: { judge: { provider: 'OpenRouter', model: 'mistralai/mistral-large' } } };
    assert.deepStrictEqual(resolveRole('judge', { settings: s, caseMeta }), { provider: 'openrouter', model: 'mistralai/mistral-large', tier: 'standard' });
    assert.deepStrictEqual(resolveRole('draft', { settings: s, caseMeta: { roles: { draft: { provider: 'openai', tier: 'fast' } } } }), { provider: 'openai', model: '', tier: 'fast' });
    assert.throws(() => resolveRole('boss', { settings: s }), /Unknown case role "boss"/);
  });

  it('treats an openrouter model prefix as its provider family', () => {
    assert.strictEqual(providerFamily('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic');
    assert.strictEqual(providerFamily('OpenAI', 'gpt-4o'), 'openai');
    assert.strictEqual(providerFamily('openrouter', 'auto'), 'openrouter');
  });

  it('moves verify to another provider family when judge and verify would match', () => {
    const { value, lines } = captureWarnings(() => resolveRole('verify', { settings: settings() }));
    assert.deepStrictEqual(value, { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    assert.deepStrictEqual(lines, []);
  });

  it('skips a candidate whose provider has no token, and falls back to the judge with a warning', () => {
    const noOpenai = captureWarnings(() => resolveRole('verify', { settings: settings(), hasToken: (p) => p !== 'openai' }));
    assert.deepStrictEqual(noOpenai.value, { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' });
    const none = captureWarnings(() => resolveRole('verify', { settings: settings(), hasToken: () => false }));
    assert.deepStrictEqual(none.value, { provider: 'anthropic', model: 'claude-sonnet-4', tier: 'smart' });
    assert.ok(none.lines.some((l) => l.includes("verify falls back to the judge's provider family (anthropic)")), none.lines.join('\n'));
  });

  it('honours an explicit case.yaml verify with a warning when it matches the judge family', () => {
    const caseMeta = { roles: { verify: { provider: 'anthropic', model: 'claude-haiku-4' } } };
    const { value, lines } = captureWarnings(() => resolveRole('verify', { settings: settings(), caseMeta }));
    assert.deepStrictEqual(value, { provider: 'anthropic', model: 'claude-haiku-4', tier: 'standard' });
    assert.ok(lines.some((l) => /same provider family as judge/.test(l)), lines.join('\n'));
  });

  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
  });
});
```

Append to the end of `tests/inference-router.test.js`:

```js
describe('InferenceRouter explicit target and streaming', () => {
  const InferenceRouterForTarget = require('../src/providers/inference-router');

  function routerWith(providers, calls) {
    return new InferenceRouterForTarget({
      getSettings: () => ({ inference: { tierMap: { fast: { provider: 'groq', model: 'llama-3.3' } }, activeTier: 'fast' }, activeProvider: 'openai' }),
      getProviderModel: () => '',
      getProviderToken: () => 'fake-token',
      createProvider: (p) => { calls.push(p); return providers[p]; }
    });
  }

  it('options.target replaces the tier config and is not passed to the provider', async () => {
    const calls = [];
    let seen = null;
    const router = routerWith({
      openai: { getDefaultModel: () => 'gpt-default', sendMessage: async (messages, options) => { seen = options; return 'from openai'; } },
      groq: { getDefaultModel: () => 'llama', sendMessage: async () => 'from groq' }
    }, calls);
    const out = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], { target: { provider: 'OpenAI', model: 'gpt-4o' }, temperature: 0 });
    assert.strictEqual(out, 'from openai');
    assert.deepStrictEqual(calls, ['openai']);
    assert.strictEqual(seen.model, 'gpt-4o');
    assert.strictEqual(seen.temperature, 0);
    assert.strictEqual('target' in seen, false);
  });

  it('streams tool calls when onChunk is given and the provider can stream', async () => {
    const calls = [];
    const chunks = [];
    let streamedOptions = null;
    const router = routerWith({
      openai: {
        getDefaultModel: () => 'gpt-default',
        sendMessageWithTools: async () => ({ type: 'text', content: 'not streamed' }),
        streamMessageWithTools: async (messages, tools, options, onChunk) => {
          streamedOptions = options;
          onChunk('par');
          onChunk('tial');
          return { type: 'text', content: 'partial' };
        }
      }
    }, calls);
    const tools = [{ name: 'Read' }];
    const out = await router.routeWithFallback('fast', [], { target: { provider: 'openai' }, tools, onChunk: (c) => chunks.push(c) });
    assert.deepStrictEqual(out, { type: 'text', content: 'partial' });
    assert.deepStrictEqual(chunks, ['par', 'tial']);
    assert.strictEqual('onChunk' in streamedOptions, false);
    const plain = await router.routeWithFallback('fast', [], { target: { provider: 'openai' }, tools });
    assert.deepStrictEqual(plain, { type: 'text', content: 'not streamed' });
  });

  it('falls back to sendMessageWithTools when the provider cannot stream', async () => {
    const router = routerWith({
      openai: { getDefaultModel: () => 'gpt-default', sendMessageWithTools: async () => ({ type: 'text', content: 'sent' }) }
    }, []);
    const out = await router.routeWithFallback('fast', [], { target: { provider: 'openai' }, tools: [{ name: 'Read' }], onChunk: () => {} });
    assert.deepStrictEqual(out, { type: 'text', content: 'sent' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-roles.test.js tests/inference-router.test.js`
Expected: FAIL with `Cannot find module '../src/cases/roles'`; in `inference-router.test.js` the new test `options.target replaces the tier config` fails with `'from groq' !== 'from openai'` and the streaming test fails with `{ content: 'not streamed' }` where `partial` was expected. The existing router tests still pass.

- [ ] **Step 3: Implement**

Create `src/cases/roles.js`:

```js
// src/cases/roles.js
// Case model roles (cases stage 2 spec §3.8, program §4.5). A role is a
// tier or an explicit provider/model; the router's tier map gains no roles.
const { createLogger } = require('../logging');

const log = createLogger('cases/roles');

const ROLES = Object.freeze(['orient', 'classify', 'draft', 'judge', 'verify']);
const TIERS = Object.freeze(['fast', 'standard', 'smart']);
const DEFAULT_ROLES = Object.freeze({
  orient: Object.freeze({ tier: 'fast' }),
  classify: Object.freeze({ tier: 'fast' }),
  draft: Object.freeze({ tier: 'standard' }),
  judge: Object.freeze({ tier: 'smart' }),
  verify: Object.freeze({ tier: 'smart' })
});

// Case loops fail over through routeWithFallback, never by retrying the
// same target inside the agent loop.
const NO_RETRY = Object.freeze({ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) });

const lower = (s) => String(s || '').trim().toLowerCase();

function tierTarget(tier, settings = {}) {
  const t = TIERS.includes(lower(tier)) ? lower(tier) : 'standard';
  const cfg = settings?.inference?.tierMap?.[t] || {};
  return {
    provider: lower(cfg.provider || settings?.activeProvider || 'openai'),
    model: typeof cfg.model === 'string' ? cfg.model : '',
    tier: t
  };
}

function entryTarget(entry, settings) {
  if (entry && typeof entry === 'object' && entry.provider) {
    return {
      provider: lower(entry.provider),
      model: typeof entry.model === 'string' ? entry.model : '',
      tier: TIERS.includes(lower(entry.tier)) ? lower(entry.tier) : 'standard'
    };
  }
  return tierTarget(entry?.tier, settings);
}

function providerFamily(provider, model) {
  const p = lower(provider);
  if (p === 'openrouter') {
    const m = String(model || '');
    const slash = m.indexOf('/');
    return slash > 0 ? lower(m.slice(0, slash)) : 'openrouter';
  }
  return p;
}

function resolveRole(role, { settings = {}, caseMeta = null, hasToken = () => true } = {}) {
  if (!ROLES.includes(role)) throw new Error(`Unknown case role "${role}". Roles: ${ROLES.join(', ')}.`);
  const explicit = caseMeta?.roles?.[role];
  const entry = explicit || settings?.cases?.roles?.[role] || DEFAULT_ROLES[role];
  const target = entryTarget(entry, settings);
  if (role !== 'verify') return target;

  const judge = resolveRole('judge', { settings, caseMeta, hasToken });
  const judgeFamily = providerFamily(judge.provider, judge.model);
  if (providerFamily(target.provider, target.model) !== judgeFamily) return target;
  if (explicit) {
    log.warn(`case.yaml roles.verify uses the same provider family as judge (${judgeFamily}); honouring it as written.`);
    return target;
  }
  for (const tier of ['smart', 'standard', 'fast']) {
    const candidate = tierTarget(tier, settings);
    if (providerFamily(candidate.provider, candidate.model) !== judgeFamily && hasToken(candidate.provider)) return candidate;
  }
  log.warn(`verify falls back to the judge's provider family (${judgeFamily})`);
  return judge;
}

module.exports = { ROLES, TIERS, DEFAULT_ROLES, NO_RETRY, tierTarget, providerFamily, resolveRole };
```

In `src/providers/inference-router.js`, inside `execute`, replace

```js
    const mergedOptions = {
      ...options,
      model: config.model || options.model || providerInstance.getDefaultModel()
    };

    if (Array.isArray(mergedOptions.tools) && mergedOptions.tools.length > 0) {
      if (typeof providerInstance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${config.provider} does not support tool calling.`);
      }
      return providerInstance.sendMessageWithTools(messages, mergedOptions.tools, mergedOptions);
    }
```

with

```js
    const { onChunk, ...rest } = options;
    const mergedOptions = {
      ...rest,
      model: config.model || rest.model || providerInstance.getDefaultModel()
    };

    if (Array.isArray(mergedOptions.tools) && mergedOptions.tools.length > 0) {
      if (typeof onChunk === 'function' && typeof providerInstance.streamMessageWithTools === 'function') {
        return providerInstance.streamMessageWithTools(messages, mergedOptions.tools, mergedOptions, onChunk);
      }
      if (typeof providerInstance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${config.provider} does not support tool calling.`);
      }
      return providerInstance.sendMessageWithTools(messages, mergedOptions.tools, mergedOptions);
    }
```

In `src/providers/inference-router.js`, inside `routeWithFallback`, replace

```js
  async routeWithFallback(tier, messages, options = {}) {
    let config = this.getTierConfig(tier);
    let payload = messages;
```

with

```js
  async routeWithFallback(tier, messages, options = {}) {
    // options.target ({ provider, model }) pins the first target (a case
    // role, or the owner's chat selection); fallbacks still apply after it.
    const { target, ...execOptions } = options || {};
    let config = target && target.provider
      ? { provider: String(target.provider).toLowerCase(), model: target.model || '', tier: this.getTierConfig(tier).tier }
      : this.getTierConfig(tier);
    let payload = messages;
```

and, inside the same method's loop, replace

```js
        return await this.execute(config, payload, options);
```

with

```js
        return await this.execute(config, payload, execOptions);
```

and replace

```js
          aborted: options.abortSignal?.aborted
```

with

```js
          aborted: execOptions.abortSignal?.aborted
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-roles.test.js tests/inference-router.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/roles.js src/providers/inference-router.js tests/cases-roles.test.js tests/inference-router.test.js
git commit -m "feat(cases): model roles; router accepts an explicit target and streams tool calls

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Owner-only brief fields and the new orientation sections

**Files:**
- Modify: `src/cases/brief.js` (`BRIEF_FIELDS`, `USER_ONLY_FIELDS`, `ARRAY_FIELDS`)
- Modify: `src/cases/case-store.js` (`BRIEF_TEMPLATE`: the `materiality:` line)
- Modify: `src/cases/orientation.js` (`briefLines`, the `buildOrientation` signature and its `head` block; new helpers above `function buildOrientation(`)
- Modify: `tests/cases-brief.test.js:79` (a `deadline` update now needs `provenance: 'user'`)
- Test: `tests/cases-orientation-unattended.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `USER_ONLY_FIELDS` = `why`, `hardConstraints`, `alreadyTried`, `materiality`, `deadline`, `safeDefaults`; `safeDefaults` is a new array brief field. `buildOrientation({ …C1 fields, triggers = [], hookNotes = [], statusReason = null, failure = null, questions = [], budget = null, nextWakeup = null, now = new Date() })`: sections `## Re-orientation required` (blocking triggers, then `Call Reorient before Recommend, Decide or Fail.`), `## Since last turn`, `## Status` (with `### Failure report (<file>)` for `needs-direction`), `## Open questions to the owner`, `## Budget` (with the unpriced-tokens line), `## Next wake-up`. Part 2's `CaseRuntime.orientation(id, { triggers, hookNotes })` fills them.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-orientation-unattended.test.js`:

```js
// tests/cases-orientation-unattended.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrientation } = require('../src/cases/orientation');
const { Brief, BriefError, USER_ONLY_FIELDS } = require('../src/cases/brief');
const { CaseStore } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-orient2-')); dirs.push(d); return d; };

const meta = { title: 'Lakeside lot', slug: 'lakeside-lot', status: 'active' };
const brief = {
  data: {
    objective: 'Convert the lot to cash',
    materiality: { tell: ['offer'], ignore: ['voicemail'] },
    safeDefaults: ['hold-price'],
    gating: { complete: true }
  }
};
const at = (text, needle) => text.indexOf(needle);

describe('orientation sections for unattended cases', () => {
  it('puts blocking re-orientation triggers first, then notes from turn-start hooks', () => {
    const text = buildOrientation({
      meta,
      brief,
      triggers: [
        { kind: 'time-gap', key: 'time-gap', blocking: true, detail: 'The owner last spoke 9 hours ago.' },
        { kind: 'note', key: 'n', blocking: false, detail: 'Non-blocking hint' }
      ],
      hookNotes: ['Detours: none open.']
    });
    assert.ok(at(text, '## Re-orientation required') > 0);
    assert.ok(at(text, '## Re-orientation required') < at(text, '## Since last turn'));
    assert.ok(at(text, '## Since last turn') < at(text, '## Brief'));
    assert.match(text, /- The owner last spoke 9 hours ago\.\nCall Reorient before Recommend, Decide or Fail\./);
    assert.match(text, /## Since last turn\n- Detours: none open\./);
    assert.doesNotMatch(text, /Non-blocking hint/);
  });

  it('leaves the new sections out when there is nothing to say', () => {
    const text = buildOrientation({ meta, brief });
    for (const h of ['## Re-orientation required', '## Since last turn', '## Status', '## Open questions', '## Budget', '## Next wake-up']) {
      assert.strictEqual(text.includes(h), false, h);
    }
  });

  it('shows the status reason and the failure report while waiting for direction', () => {
    const text = buildOrientation({
      meta: { ...meta, status: 'needs-direction' },
      brief,
      statusReason: { kind: 'failure', by: 'runtime', ref: 'journal/2026-09-23-1405-failure.md', note: '', at: '2026-09-23T14:05:00.000Z' },
      failure: { file: 'journal/2026-09-23-1405-failure.md', text: '# Failure report — County listing\n\nClass: dead-end\n' }
    });
    assert.match(text, /## Status\n- needs-direction \(failure, by runtime, 2026-09-23T14:05:00\.000Z\)/);
    assert.match(text, /Waiting for the owner's direction/);
    assert.match(text, /### Failure report \(journal\/2026-09-23-1405-failure\.md\)\n# Failure report — County listing/);
    assert.ok(at(text, '## Status') < at(text, '## Brief'));
    const paused = buildOrientation({ meta: { ...meta, status: 'paused' }, brief, statusReason: { kind: 'budget', by: 'runtime', ref: 'usd', note: '', at: '2026-09-23T14:05:00.000Z' } });
    assert.match(paused, /- paused \(budget, by runtime, 2026-09-23T14:05:00\.000Z\)\n- Paused: only reading is available/);
  });

  it('lists open questions and marks a held question past its expiry as overdue', () => {
    const text = buildOrientation({
      meta,
      brief,
      now: new Date('2026-09-23T00:00:00Z'),
      questions: [
        { id: 'q-0001', kind: 'question', urgency: 'high', text: 'Is the well shared?', expiresAt: '2026-09-22T00:00:00Z', defaultOnSilence: 'hold' },
        { id: 'q-0002', kind: 'briefing', urgency: 'low', text: 'Open house on Saturday.', expiresAt: null, defaultOnSilence: 'hold' }
      ]
    });
    assert.match(text, /## Open questions to the owner\n- q-0001 \[question, high\] Is the well shared\? — OVERDUE, still holding\n- q-0002 \[briefing, low\] Open house on Saturday\.\nDo not assume answers to open questions\./);
  });

  it('shows budgets with their thresholds and the unpriced-tokens warning', () => {
    const text = buildOrientation({
      meta,
      brief,
      budget: {
        usd: { spent: 12.5, limit: 20, crossed: [50], unpricedTokens: 3400, grantedBy: [], ratio: 0.625 },
        deadline: { at: '2026-11-30', crossed: [], grantedBy: [], ratio: 0.4 },
        turnsPerDay: { spent: 3, limit: 48, day: '2026-09-23', crossed: [], grantedBy: [], ratio: 0.0625 },
        contactsPerDay: { spent: 0, limit: null, day: '2026-09-23', crossed: [], grantedBy: [], ratio: null },
        questionsPerDay: { spent: 0, limit: 6, day: '2026-09-23', crossed: [], grantedBy: [], ratio: 0 }
      }
    });
    assert.match(text, /## Budget\n- usd: 12\.5 of 20 \(passed 50 %\)\n- deadline 2026-11-30: 40 % of the time used\n- turnsPerDay: 3 of 48 today \(2026-09-23\)\n- questionsPerDay: 0 of 6 today \(2026-09-23\)\n- 3400 tokens on providers with no price table are not counted against the \$ budget\./);
    assert.doesNotMatch(text, /contactsPerDay/);
  });

  it('names the next wake-up', () => {
    const text = buildOrientation({ meta, brief, nextWakeup: { id: 'w-0001', kind: 'daily-orientation', nextAt: '2026-09-24T09:00:00.000Z' } });
    assert.match(text, /## Next wake-up\n- w-0001 daily-orientation at 2026-09-24T09:00:00\.000Z/);
  });

  it('shows materiality and safe defaults in the brief section', () => {
    const text = buildOrientation({ meta, brief });
    assert.match(text, /- Materiality: tell offer; ignore voicemail/);
    assert.match(text, /- Safe defaults on silence: hold-price/);
  });
});

describe('owner-only brief fields', () => {
  it('adds materiality, deadline and safeDefaults to the owner-only fields', () => {
    assert.deepStrictEqual([...USER_ONLY_FIELDS], ['why', 'hardConstraints', 'alreadyTried', 'materiality', 'deadline', 'safeDefaults']);
  });

  it('refuses them from the model and takes them from the owner', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'brief.md'), '---\nobjective: Sell\n---\n\n');
    const b = new Brief(d);
    assert.throws(() => b.update('materiality', { tell: ['offer'], ignore: [] }, { provenance: 'model' }), BriefError);
    assert.throws(() => b.update('deadline', '2027-03-01', { provenance: 'model' }), /owner/);
    assert.throws(() => b.append('safeDefaults', 'hold-price', { provenance: 'model' }), BriefError);
    b.update('safeDefaults', ['hold-price'], { provenance: 'user' });
    b.append('safeDefaults', 'no', { provenance: 'user' });
    assert.deepStrictEqual(b.read().data.safeDefaults, ['hold-price', 'no']);
    assert.throws(() => b.update('safeDefaults', 'hold-price', { provenance: 'user' }), /array of strings/);
  });

  it('new cases start with an empty safeDefaults list', async () => {
    const store = new CaseStore({ root: tmp() });
    const info = await store.create({ title: 'Lakeside lot', objective: 'Sell' });
    assert.deepStrictEqual(new Brief(info.dir).read().data.safeDefaults, []);
  });
});
```

In `tests/cases-brief.test.js`, replace

```js
    b.update('deadline', '2027-03-01', { provenance: 'model' });
```

with

```js
    b.update('deadline', '2027-03-01', { provenance: 'user' });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-orientation-unattended.test.js`
Expected: FAIL — `puts blocking re-orientation triggers first` fails because `## Re-orientation required` is not in the text, and `adds materiality, deadline and safeDefaults` fails on the `USER_ONLY_FIELDS` list.

- [ ] **Step 3: Implement**

In `src/cases/brief.js`, replace

```js
const BRIEF_FIELDS = new Set([
  'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried',
  'resources', 'deadline', 'materiality'
]);
const USER_ONLY_FIELDS = new Set(['why', 'hardConstraints', 'alreadyTried']);
const ARRAY_FIELDS = new Set(['successCriteria', 'hardConstraints', 'alreadyTried']);
```

with

```js
const BRIEF_FIELDS = new Set([
  'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried',
  'resources', 'deadline', 'materiality', 'safeDefaults'
]);
// Stage 2: materiality, deadline and safeDefaults feed gates (briefing
// urgency, the deadline budget, acting on silence), so only the owner sets them.
const USER_ONLY_FIELDS = new Set(['why', 'hardConstraints', 'alreadyTried', 'materiality', 'deadline', 'safeDefaults']);
const ARRAY_FIELDS = new Set(['successCriteria', 'hardConstraints', 'alreadyTried', 'safeDefaults']);
```

In `src/cases/case-store.js`, replace

```js
    materiality: { tell: [], ignore: [] },
    gating: { complete: false }
```

with

```js
    materiality: { tell: [], ignore: [] },
    safeDefaults: [],
    gating: { complete: false }
```

In `src/cases/orientation.js`, replace

```js
    `- Deadline: ${d.deadline || '—'}`,
```

with

```js
    `- Deadline: ${d.deadline || '—'}`,
    `- Materiality: tell ${list(d.materiality?.tell)}; ignore ${list(d.materiality?.ignore)}`,
    `- Safe defaults on silence: ${list(d.safeDefaults)}`,
```

In `src/cases/orientation.js`, replace

```js
function buildOrientation({
  meta, brief, facts = new Map(), decisions = [], lastJournal = null, ledgerErrors = [], maxChars = DEFAULT_MAX_CHARS
}) {
```

with

```js
const clip = (text, max = JOURNAL_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function reorientationSection(triggers = []) {
  const blocking = triggers.filter((t) => t && t.blocking);
  if (!blocking.length) return [];
  return ['## Re-orientation required', ...blocking.map((t) => `- ${t.detail}`), 'Call Reorient before Recommend, Decide or Fail.', ''];
}

function sinceLastTurnSection(notes = []) {
  if (!notes.length) return [];
  return ['## Since last turn', ...notes.map((n) => `- ${n}`), ''];
}

function statusSection(meta, reason, failure) {
  if (!['needs-direction', 'paused', 'done', 'abandoned'].includes(meta.status)) return [];
  const detail = reason
    ? ` (${[reason.kind, reason.by ? `by ${reason.by}` : '', reason.at || ''].filter(Boolean).join(', ')})${reason.note ? `: ${reason.note}` : ''}`
    : '';
  const lines = ['## Status', `- ${meta.status}${detail}`];
  if (meta.status === 'needs-direction') {
    lines.push("- Waiting for the owner's direction. Report status or ask; do not plan or recommend.");
    if (failure?.text) lines.push(`### Failure report (${failure.file})`, clip(String(failure.text)).trimEnd());
  }
  if (meta.status === 'paused') lines.push('- Paused: only reading is available until the owner resumes the case.');
  return [...lines, ''];
}

function questionsSection(questions = [], now = new Date()) {
  if (!questions.length) return [];
  const t = now.getTime();
  const line = (q) => {
    const overdue = q.expiresAt && Date.parse(q.expiresAt) <= t && q.defaultOnSilence === 'hold' ? ' — OVERDUE, still holding' : '';
    return `- ${q.id} [${q.kind}, ${q.urgency}] ${oneLine(q.text, 200)}${overdue}`;
  };
  return ['## Open questions to the owner', ...questions.map(line), 'Do not assume answers to open questions.', ''];
}

function budgetSection(budget) {
  if (!budget || typeof budget !== 'object') return [];
  const passed = (e) => (Array.isArray(e?.crossed) && e.crossed.length ? ` (passed ${e.crossed.join(', ')} %)` : '');
  const lines = [];
  for (const [category, e] of Object.entries(budget)) {
    if (!e) continue;
    if (category === 'deadline') {
      if (e.at) lines.push(`- deadline ${e.at}: ${Math.round(Math.min(Number(e.ratio) || 0, 9.99) * 100)} % of the time used${passed(e)}`);
      continue;
    }
    if (!e.limit) continue;
    lines.push(`- ${category}: ${e.spent} of ${e.limit}${e.day ? ` today (${e.day})` : ''}${passed(e)}`);
  }
  const unpriced = Number(budget.usd?.unpricedTokens) || 0;
  if (unpriced > 0) lines.push(`- ${unpriced} tokens on providers with no price table are not counted against the $ budget.`);
  return lines.length ? ['## Budget', ...lines, ''] : [];
}

function nextWakeupSection(w) {
  if (!w) return [];
  return ['## Next wake-up', `- ${w.id} ${w.kind} at ${w.nextAt}`, ''];
}

function buildOrientation({
  meta, brief, facts = new Map(), decisions = [], lastJournal = null, ledgerErrors = [], maxChars = DEFAULT_MAX_CHARS,
  triggers = [], hookNotes = [], statusReason = null, failure = null, questions = [], budget: budgetStatus = null, nextWakeup = null,
  now = new Date()
}) {
```

and replace

```js
  const head = [
    `# Case: ${meta.title} (${meta.slug}) — status: ${meta.status}`,
    '',
    '## Brief',
    ...briefLines(brief),
    '',
    '## Load-bearing unknowns (resolve or work around these before anything else)',
    ...(lbUnknowns.length ? lbUnknowns : ['- none recorded']),
    ''
  ].join('\n');
```

with

```js
  const head = [
    `# Case: ${meta.title} (${meta.slug}) — status: ${meta.status}`,
    '',
    ...reorientationSection(triggers),
    ...sinceLastTurnSection(hookNotes),
    ...statusSection(meta, statusReason, failure),
    '## Brief',
    ...briefLines(brief),
    '',
    '## Load-bearing unknowns (resolve or work around these before anything else)',
    ...(lbUnknowns.length ? lbUnknowns : ['- none recorded']),
    '',
    ...questionsSection(questions, now),
    ...budgetSection(budgetStatus),
    ...nextWakeupSection(nextWakeup)
  ].join('\n');
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-orientation-unattended.test.js tests/cases-orientation.test.js tests/cases-brief.test.js tests/cases-store.test.js tests/cases-tools.test.js tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/brief.js src/cases/case-store.js src/cases/orientation.js tests/cases-orientation-unattended.test.js tests/cases-brief.test.js
git commit -m "feat(cases): owner-only gate fields and orientation sections for unattended work

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Confinement — blocked tools, the case prompter and `allowedToolNames`

**Files:**
- Modify: `src/cases/chat-integration.js` (`CASE_BLOCKED_TOOL_NAMES`, `CASE_BLOCKED_TOOL_ERROR`, `shapeToolDefinitions`, new `WAKEUP_BASE_TOOLS`, new `casePrompter`, `module.exports`)
- Modify: `src/execution/tool-executor.js` (constructor after `this.denyAutoApproval = options.denyAutoApproval === true;`; top of `execute`)
- Modify: `tests/cases-tools.test.js:179` (the registered-tool check for the blocked names)
- Test: `tests/cases-tools.test.js` (append a `describe` block)
- Test: `tests/tool-executor.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `ToolExecutor` (`src/execution/tool-executor.js`), `toolRegistry`.
- Produces: `CASE_BLOCKED_TOOL_NAMES` (11 names), `WAKEUP_BASE_TOOLS = ['Read', 'Glob', 'Grep']`, `casePrompter(base) → { askUser, requestDirectoryAccess }`, `shapeToolDefinitions(definitions, attached, registry)` also strips `AskUser` when attached. `new ToolExecutor({ allowedToolNames })` (a `Set`, an array, or `null`): a tool outside the set returns `{ success: false, error: 'Tool "<name>" is not available in this turn.' }` before hooks, approval or the registry lookup. `CASE_TOOL_NAMES` does not change in this task (Part 2, Task 12 adds `Reorient`, `Ask`, `Fail` together with the tools).

- [ ] **Step 1: Write the failing test**

In `tests/cases-tools.test.js`, replace

```js
    for (const name of CASE_BLOCKED_TOOL_NAMES) assert.ok(toolRegistry.get(name) || name === 'sessions_spawn', `${name} is not a registered tool`);
```

with

```js
    // message and the sessions_* tools are registered by createCore, not initializeTools.
    const coreOnly = new Set(['sessions_spawn', 'sessions_list', 'sessions_history', 'message']);
    for (const name of CASE_BLOCKED_TOOL_NAMES) assert.ok(toolRegistry.get(name) || coreOnly.has(name), `${name} is not a registered tool`);
```

Append to the end of `tests/cases-tools.test.js`:

```js
describe('stage 2 confinement helpers', () => {
  const { WAKEUP_BASE_TOOLS, casePrompter, CASE_BLOCKED_TOOL_ERROR } = require('../src/cases/chat-integration');

  it('blocks tools that reach other sessions or change the tool list in every case turn', () => {
    assert.deepStrictEqual([...CASE_BLOCKED_TOOL_NAMES], [
      'SpawnAgent', 'BackgroundTask', 'sessions_spawn', 'RemoteDispatch', 'Cron',
      'message', 'sessions_list', 'sessions_history', 'RequestTools', 'ToolSearch', 'Canvas'
    ]);
    assert.match(CASE_BLOCKED_TOOL_ERROR, /not available in case turns/);
  });

  it('strips AskUser from a case turn and keeps it otherwise', () => {
    const base = [{ name: 'Read' }, { name: 'AskUser' }];
    assert.ok(!shapeToolDefinitions(base, true, toolRegistry).some((d) => d.name === 'AskUser'));
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), ['Read', 'AskUser']);
  });

  it('confines wake-ups to Read, Glob and Grep besides the case tools', () => {
    assert.deepStrictEqual([...WAKEUP_BASE_TOOLS], ['Read', 'Glob', 'Grep']);
    assert.ok(Object.isFrozen(WAKEUP_BASE_TOOLS));
  });

  it('casePrompter refuses AskUser and delegates directory access to the owner prompter only', async () => {
    const asked = [];
    const base = { askUser: async () => ({ ok: true, answer: 'yes' }), requestDirectoryAccess: async (req) => { asked.push(req.directory); return true; } };
    const owner = casePrompter(base);
    assert.deepStrictEqual(await owner.askUser({ question: 'Which lot?' }), { ok: false, error: 'In a case, ask the owner with the Ask tool.' });
    assert.strictEqual(await owner.requestDirectoryAccess({ directory: '/tmp/x', toolName: 'Read' }), true);
    assert.deepStrictEqual(asked, ['/tmp/x']);
    const unattended = casePrompter(null);
    assert.strictEqual(await unattended.requestDirectoryAccess({ directory: '/tmp/y', toolName: 'Read' }), false);
    assert.strictEqual((await unattended.askUser({ question: 'x' })).ok, false);
  });
});
```

Append to the end of `tests/tool-executor.test.js`:

```js
describe('ToolExecutor allowedToolNames', () => {
  it('refuses a tool outside the set before approval is ever asked', async () => {
    let approvals = 0;
    const executor = new ToolExecutor({
      requireApproval: true,
      allowedToolNames: new Set(['TestTool']),
      approvalRequester: async () => { approvals += 1; return true; }
    });
    const events = [];
    executor.on('postExecute', (e) => events.push(e));
    const refused = await executor.execute('DangerousTool', { force: false });
    assert.deepStrictEqual(refused, { success: false, error: 'Tool "DangerousTool" is not available in this turn.' });
    assert.strictEqual(approvals, 0);
    assert.deepStrictEqual(events.map((e) => [e.toolName, e.result.success]), [['DangerousTool', false]]);
    const ok = await executor.execute('TestTool', { input: 'hello' });
    assert.strictEqual(ok.ok, true);
  });

  it('refuses a name that is not registered at all instead of throwing', async () => {
    const executor = new ToolExecutor({ requireApproval: false, allowedToolNames: ['TestTool'] });
    assert.deepStrictEqual(await executor.execute('message', { text: 'hi' }), { success: false, error: 'Tool "message" is not available in this turn.' });
  });

  it('leaves every tool available when allowedToolNames is null', async () => {
    const executor = new ToolExecutor({ requireApproval: false, allowedToolNames: null });
    assert.strictEqual((await executor.execute('TestTool', { input: 'x' })).ok, true);
    assert.strictEqual(executor.allowedToolNames, null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-tools.test.js tests/tool-executor.test.js`
Expected: FAIL — `blocks tools that reach other sessions` (the list has 5 names), `strips AskUser`, `casePrompter is not a function`, and `refuses a tool outside the set` (the DangerousTool call reaches the approval requester).

- [ ] **Step 3: Implement**

In `src/cases/chat-integration.js`, replace

```js
// Tools that start another agent run (now, later, or on another machine).
// That run has no caseContext, so the case write guard would be off; stage 1
// keeps them out of case turns entirely.
const CASE_BLOCKED_TOOL_NAMES = Object.freeze(['SpawnAgent', 'BackgroundTask', 'sessions_spawn', 'RemoteDispatch', 'Cron']);
const CASE_BLOCKED_TOOL_ERROR = 'Sub-agents and background tasks are not available in case turns in stage 1. Do the work in this turn with the case tools and the other tools.';
```

with

```js
// Tools kept out of every case turn (stage 2 spec §3.2). SpawnAgent,
// BackgroundTask, sessions_spawn, RemoteDispatch and Cron start a run with
// no caseContext; message sends text into a gateway session that has none;
// sessions_list and sessions_history read other sessions; RequestTools and
// ToolSearch inject tools; Canvas drives the UI.
const CASE_BLOCKED_TOOL_NAMES = Object.freeze([
  'SpawnAgent', 'BackgroundTask', 'sessions_spawn', 'RemoteDispatch', 'Cron',
  'message', 'sessions_list', 'sessions_history', 'RequestTools', 'ToolSearch', 'Canvas'
]);
const CASE_BLOCKED_TOOL_ERROR = 'This tool is not available in case turns: it starts another run, reaches another session, or changes the tool list. Do the work in this turn with the case tools and the other tools.';

// Everything a wake-up may use besides the case tools. WebFetch and
// WebSearch join once the outbound gate (C3) exists: a GET URL is an
// outbound channel.
const WAKEUP_BASE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
```

In `src/cases/chat-integration.js`, replace

```js
  if (!attached) return base;
  const blocked = new Set(CASE_BLOCKED_TOOL_NAMES);
```

with

```js
  if (!attached) return base;
  // AskUser is intercepted by the agent loop before the executor; in a case
  // the Ask tool is the only way to ask the owner.
  const blocked = new Set([...CASE_BLOCKED_TOOL_NAMES, 'AskUser']);
```

In `src/cases/chat-integration.js`, replace

```js
function buildCaseSystemPrompt(orientation, base) {
```

with

```js
// The agent loop calls the prompter for AskUser and for directory access.
// In a case, AskUser is refused; directory access goes to the owner's own
// prompter on owner turns, and is denied on wake-ups (base = null).
function casePrompter(base) {
  return {
    async askUser() {
      return { ok: false, error: 'In a case, ask the owner with the Ask tool.' };
    },
    async requestDirectoryAccess(request) {
      if (!base || typeof base.requestDirectoryAccess !== 'function') return false;
      return base.requestDirectoryAccess(request);
    }
  };
}

function buildCaseSystemPrompt(orientation, base) {
```

In `src/cases/chat-integration.js`, replace

```js
module.exports = {
  CASE_TOOL_NAMES,
  CASE_BLOCKED_TOOL_NAMES,
  CASE_BLOCKED_TOOL_ERROR,
```

with

```js
module.exports = {
  CASE_TOOL_NAMES,
  CASE_BLOCKED_TOOL_NAMES,
  CASE_BLOCKED_TOOL_ERROR,
  WAKEUP_BASE_TOOLS,
  casePrompter,
```

In `src/execution/tool-executor.js`, replace

```js
    this.denyAutoApproval = options.denyAutoApproval === true;
```

with

```js
    this.denyAutoApproval = options.denyAutoApproval === true;
    // Cases stage 2: a wake-up turn may run only these tools, whatever the
    // model names. null means no restriction (every other caller).
    if (options.allowedToolNames instanceof Set) {
      this.allowedToolNames = new Set(options.allowedToolNames);
    } else if (Array.isArray(options.allowedToolNames)) {
      this.allowedToolNames = new Set(options.allowedToolNames);
    } else {
      this.allowedToolNames = null;
    }
```

In `src/execution/tool-executor.js`, replace

```js
  async execute(toolName, parameters = {}, options = {}) {
    const tool = toolRegistry.get(toolName);
```

with

```js
  async execute(toolName, parameters = {}, options = {}) {
    if (this.allowedToolNames && !this.allowedToolNames.has(toolName)) {
      const refused = { success: false, error: `Tool "${toolName}" is not available in this turn.` };
      this.emit('postExecute', { toolName, parameters, result: refused });
      return refused;
    }

    const tool = toolRegistry.get(toolName);
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-tools.test.js tests/tool-executor.test.js tests/tool-executor-sandbox.test.js tests/cases-chat.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/chat-integration.js src/execution/tool-executor.js tests/cases-tools.test.js tests/tool-executor.test.js
git commit -m "feat(cases): block session and tool-list tools in case turns; executor allowedToolNames; case prompter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 1 hand-off

When Tasks 1–9 are merged, run the whole suite once:

Run: `npm test`
Expected: PASS, `# fail 0`

Then check the Part 1 diff for personal values:

Run: `git diff main -- src tests | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})"`
Expected: no output. Fixtures use only invented values (`Lakeside lot`, `records.example.org`) and IANA zone names (`UTC`, `Asia/Tokyo`, `America/New_York`).

Part 2 (`docs/superpowers/plans/2026-09-23-cases-stage2-unattended-part2.md`) depends on these exports existing exactly as named: `status.js` (`canTransition`, `check`, `StatusError`, `AUTONOMY_KEY`, `FAILURE_CLASSES`), `budget.js` (`Budget`, `CATEGORIES`), `wakeups.js` (`WakeupStore`, `ensureWakeupJob`, `WAKEUP_JOB_ID`), `questions.js` (`QuestionStore`, `QuestionError`), `triggers.js` (`detectTriggers`, `emptyBaseline`, `underminedKeys`), `roles.js` (`resolveRole`, `NO_RETRY`), `jsonfile.js` (`readJson`, `writeJsonIfChanged`), `clock.js` (`toMs`), `chat-integration.js` (`WAKEUP_BASE_TOOLS`, `casePrompter`), `CronExecutor.registerSystemJob`, `ToolExecutor` `allowedToolNames`, and `buildOrientation`'s new inputs.
