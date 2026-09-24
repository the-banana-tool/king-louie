# Cases Stage 3: Executors — Implementation Plan (Part 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure foundations of case executors: time and file helpers with the JCS module, recipient normalization, the outbound gate, envelopes with signed-grant verification, and executor-first plan checks.
**Architecture:** Part 1 adds self-contained modules under `src/cases/executors/` (`util.js`, `defaults.js`, `normalize.js`, `envelope.js`, `signed.js`, `plan.js`), the English detectors in `src/cases/outbound.js`, and the outbound gate in `src/cases/gates.js`. Nothing in Part 1 runs during a turn. Part 2 (`…-part2.md`) builds the registry, the reference `phone-agent` package, the job lifecycle and the envelope/plan flows on top; Part 3 (`…-part3.md`) adds `Executor.submit`, results, the `Plan`/`Executor` tools, the case-turn guard, isolated research children and the core wiring.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `Intl.DateTimeFormat` for calendar days, `src/platform/jcs.js` (RFC 8785). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage3-executors.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.
**Depends on:** C2 (cases stage 2, both parts) merged. Task 1, Step 0 checks it.

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
  never decides policy. `node.yaml` rejects unknown keys and `service.json` rejects unknown `features.*` and
  `ports.*` keys, each with the key path named (R11, R55). Stages that add a feature
  also add it to the four example `service.json` files under `examples/`.
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

Stage 3 spec constraints:

- **C2 must be merged first** (both parts of `docs/superpowers/plans/2026-09-23-cases-stage2-unattended-part1.md` / `-part2.md`). Task 1 checks it. F3, C5, C6, C7 and F4 are optional: each is reached through an option or a soft lookup with the stub named under "Interfaces from other stages".
- No new npm dependency (spec §14). JCS is `src/platform/jcs.js`; HTTP is Node's global `fetch`; time zones are `Intl`; YAML is the existing `js-yaml`.
- Executor ids match `^[a-z][a-z0-9-]{1,39}$`. Outbound capabilities are exactly `call, sms, email, web-form, postal-mail, pay, sign`; only exact capability slugs match (`any` matches every capability).
- Job states: open `submitting | submitted | running | waiting`; terminal `done | failed | cancelled | unreachable`. Job ids `job-` + 4 digits, envelope ids `env-` + at least 2 digits, plan ids `plan-` + 3 digits, all by replay.
- `settings.executors` defaults: `entries: {}`, `defaultCountryCode: ''`, `pollEveryMs: 900000`, `submitTimeoutMs: 30000`, `requestTimeoutMs: 20000`, `refreshBudgetMs: 5000`, `maxPollErrors: 5`, `auditScanEntries: 5000`, `attemptsDefault: 2`, `opsMemory.maxEntries: 20`, `outbound.categoryKeywords` for `personal`, `financial`, `legal`, `health`. Merged key by key. No env vars.
- Poll backoff is `pollEveryMs × 2^pollErrors`, capped at 6 hours; a job is `unreachable` at `maxPollErrors` failures. Polling never charges `turnsPerDay`.
- Envelope `hash = 'sha256:' + sha256hex(canonicalize(core))`, `core = { intent, executor, recipients: { allow }, facts, rules, caps, window }`. `Idempotency-Key = sha256hex(canonicalize({ caseId, envelopeId, n }))`. `externalRef = '<caseId>/<jobId>'`.
- Question option ids are at most 16 characters (C2 `QuestionStore`): plans `approve`, `approve-no-owner`, `reject`; envelopes and deltas `approve`, `reject`.
- `external-agent` provenance is written only by `Executor.results`; the Ledger tool refuses it (R40). `brief.resources.ownerLabor` is written only by `syncPlan` (R41). Floors (R42): an outbound capability forces `outbound: 'message'` and `authority ≥ 'envelope'`.
- Every string leaf of an outbound payload passes `gateLeaves`; senders send `rendered`, never the input (R38).
- Examples and fixtures use `https://errands.example.com`, `records.example.org`, `permits.example.com`, `Lakeside lot`, `+15550100`–`+15550199`. Tests talk to an in-process server on `127.0.0.1`.
- Shared files take one additive hunk per insertion point at the quoted anchor. Anchors in files C2 edits are quoted as they read after C2 merges.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five silent conditions of spec §10 and where each is pinned:

1. **The executor contradicts the owner.** Task 12, `tests/cases-executor-tool.test.js`, "results conflicting with a user fact create an unknown and never supersede" (the user fact stays active, a load-bearing conflict unknown is recorded, `recommendationGate` refuses a claim citing the user fact).
2. **Window across DST.** Task 1 (`windowInstants`, `notAfter = 2026-11-02T05:59:59Z`) and Task 4, `tests/cases-envelope.test.js`, "window is local calendar days across DST".
3. **The adapter throws mid-poll.** Task 9, `tests/cases-executor-jobs.test.js`, "poll failure goes stale, then unreachable"; Task 12, "results are refused while the executor is stale".
4. **The adapter normalizes a recipient differently.** Task 11, `tests/cases-executor-tool.test.js`, "normalization mismatch cancels".
5. **Two cases share a daily cap.** Task 7, `tests/cases-executor-registry.test.js`, "global cap is shared across cases under the mutex".

## Interfaces from other stages

| Contract | Exact shape consumed | Stub until it merges |
|---|---|---|
| C2 (required, merged) | `new CaseRuntime({ root, getSettings, now, host })`; `getCase`, `ledger(id)`, `brief(id)`, `records(id)`, `budget(id)` (`charge(category, amount, meta) → { crossedNow }`, `remaining(category)`, `limitFor(category)`), `wakeups(id)` (`register({ kind, every, payload }) → id`, `cancel(id)`), `questions(id)` (`get`, `list`, `close(id, { reason, by })`), `createQuestion(id, record, { charge })`, `answerQuestion(caseId, questionId, { channel, text, optionId })`, `onCrossings(id, category, crossedNow)`, `systemAction(id, label, fn)`, `addTurnStartHook(name, fn)`, `assertWritable`, `requireReoriented`, `autonomyAllows`, `routedProvider(turn, { role })`, `usageHook(turn)`, `turns`, `caseContext(turn, { ownerMessages })`, `CaseBusyError`; `status.js` `READ_OPS`; `chat-integration.js` `CASE_TOOL_NAMES`, `WAKEUP_BASE_TOOLS`; `case-tools.js` `withCase(options, op, fn, { params, reoriented })` | none: real code |
| F3 P1 (R17) | `src/platform/jcs.js`: `canonicalize(value)`, `sha256b64url(input)`, `JcsError` | Task 1 creates the file with exactly F3's content when it is absent |
| F3 P8 | `src/approvals/messages.js`: `envelopeAction({ executorId, caseId, envelopeHash, summary }) → { kind: 'envelope', name, params: { case_id, envelope_hash }, summary }`, `actionHash(action)` | `signed.js` requires it softly; otherwise an identical local `envelopeAction` (summary cut at 300 characters) and `actionHash = sha256b64url(canonicalize(action))` |
| F3 §4.12 | `context.getPhoneApprover() → approver \| null`; `approver.requestAction(action, { origin, signal, currentAction }) → Promise<{ decision, request_id, device_id, action_hash, reason }>` | registry option `getPhoneApprover`; tests pass `{ requestAction: async () => outcome }` |
| F3 §4.16 | `auditLedger.verify() → { ok }`, `auditLedger.tail(n) → [{ kind, data }]`; `approval.request.data.envelope` is a sealed `{ alg, kid, payload, sig }` whose base64url `payload` decodes to `{ request_id, action_hash, … }`; `approval.response.data = { request_id, decision, … }` | registry option `getAuditLedger`; tests pass a two-method stub |
| C5 §3.2 | `gates.jobSignature(executorId, job)`, `gates.findDuplicateJob({ executorId, job, liveJobs })`, `runtime.detourGate?.(id, { source, serves, text, turnId }) → { ok, note? }` | `src/cases/executors/duplicates.js` (Task 11) uses the gates functions when exported, else a local copy of C5's algorithm; `detourGate` is optional |
| C6 | `runtime.playbookSteps?.(id) → step[]`; calls `registry.registerExtraBriefRules(fn)` | optional; `[]` |
| C7 | `runtime.entityIndex?.()?.nonDisclosableSpans(text, { caseId }) → [{ span, entity, reason }]` | optional; `[]` |
| F2/F4 | RunbookEngine `getRunbook(name)`, `validateParameters(name, params)`, `checkRateLimit(name) → { allowed, retryAfterSeconds }`, `recordExecution(name) → stamp`, `releaseExecution(name, stamp)`, `executeRunbook(name, params, { admitted, signal })`; runbook `tier ∈ read \| routine \| unsafe` | registry option `getRunbookEngine` (null on the desktop); tests pass a stub |

## Deviations and resolved gaps (read before starting)

1. **Plan option id.** The spec's `approve-except-owner` is 20 characters; C2's `QuestionStore` allows 16. The option is `approve-no-owner` (label "Approve, except the owner's steps").
2. **`pollWakeup` registers no `retry` wake-up.** C2's sweep already queues the due `poll-executor` wake-up for a turn when `pollWakeup` returns `material: true` (C2 plan Task 13); registering a `retry` as well would run two turns.
3. **`phone-agent` is not built in.** Program §4.8 lists it among the built-ins; spec §3.1's table and §3.2 make it the reference package the owner copies into the executor root. The built-ins are the seven in the spec's table.
4. **`reserveContacts` and `releaseContacts` return promises**: they run under the registry's `AsyncMutex`.
5. **Adapter interface gains optional `findByExternalRef(ref) → { jobId, contacts } | null`**, used to reconcile a `submitting` job (spec §3.12 names the `GET /jobs?externalRef=` call but no adapter method). Adapters without it get `failed: interrupted`.
6. **`settings.executors.attemptsDefault: 2`** is added: spec §3.4's estimate uses `attemptsDefault` without naming a setting.
7. **The conflict unknown is always `loadBearing: true`**, so `Recommend` citing the owner's fact on that key is refused (condition 1).
8. **`new FactLedger(dir, { executorIds })`.** With the option, an `external-agent` `source.ref` must be under `sources/<a known id>/`; without it, under `sources/<slug>/`.
9. **Ops memory revalidates on read.** `entriesFor` drops an entry whose origin fact is no longer active and disclosable, so the owner's `case:setDisclosable` (C1's IPC) takes effect without editing C1's handler. The Ledger tool still calls `mirror`, `retract` and `supersede`.
10. **Contact reservations** are released when a job fails or is cancelled while still `submitting`; a committed job keeps its reservation (contacts may already have been reached).
11. **`refreshCase` skips a job whose `nextPollAt` is more than one minute ahead** unless `force` is set; after a success `nextPollAt = now + pollEveryMs`, after a failure the backoff.
12. **Case-turn guard host.** A child's `guardContext` is `{ caseId }` (it must survive workflow metadata), so `createCore` calls `configureCaseGuard({ getCaseRuntime })` once; the guard reads the case facts through it.
13. **`src/service/run.js`** takes two small hunks (thread `config.executors` into `loadProfile(...).start` and pass `adminExecutors`), not one line.
14. **`isService`** is true when `createCore` receives `deps.adminExecutors` (only `run.js` passes it).
15. **Reads in a paused case.** `Plan.status`, `Executor.status` and `Executor.results` join C2's `READ_OPS` (spec §3.5: "reads, allowed wherever `Ledger.query` is").
16. **`exhausted` means the usd cap is reached.** The contacts and attempts caps are enforced per submit by `envelopeFit` (as deltas), so a retry to contacts already reached stays possible inside the envelope; spec §3.6's "a cap reached" is read as the money cap.
17. **Test file names.** Besides the spec's list, envelope and plan flows get `tests/cases-envelope-ops.test.js` and `tests/cases-plan-ops.test.js`, the job lifecycle `tests/cases-executor-jobs.test.js`, the loader `tests/cases-executor-package.test.js`, the tools `tests/cases-plan-executor-tools.test.js` and the wiring `tests/cases-executor-core.test.js`.

---

### Task 1: Foundations — C2 check, JCS, time and file helpers, executor settings

**Files:**
- Create: `src/cases/executors/util.js`
- Create: `src/cases/executors/defaults.js`
- Create (only when absent): `src/platform/jcs.js`
- Test: `tests/cases-executor-util.test.js`

**Interfaces:**
- Consumes: C2 merged (`src/cases/status.js`, `questions.js`, `budget.js`, `wakeups.js`); F3's `src/platform/jcs.js` when present.
- Produces:
  - `util.js`: `sha256hex(input) → hex`, `validTimeZone(tz)`, `hostTimeZone()`, `pickTimeZone(...candidates) → tz`, `localDate(date, tz) → 'YYYY-MM-DD'`, `addDays(day, n)`, `weekdayOf(day) → 1..7` (Monday 1), `countDays(from, to, weekdays = [1..7])`, `windowInstants(start, end, tz) → { notBefore, notAfter }` (RFC3339, seconds precision), `isoSeconds(ms)`, `writeJsonAtomic(file, value)`, `readJsonSafe(file, fallback)`, `parseJsonObject(value, name) → { ok, value } | { ok: false, error }`, `valueText(value)`, `roundUsd(n)`, `DAY_PATTERN`.
  - `defaults.js`: `EXECUTOR_SETTINGS_DEFAULTS`, `mergeExecutorSettings(base, source)`, `resolveExecutorSettings(raw)`.
  - `src/platform/jcs.js`: `canonicalize`, `sha256b64url`, `JcsError` (F3 P1, verbatim).

- [ ] **Step 0: Confirm C2 is merged**

Run: `node -e "for (const m of ['status','questions','budget','wakeups','roles','defaults']) require('./src/cases/' + m); const { CASE_TOOL_NAMES, WAKEUP_BASE_TOOLS } = require('./src/cases/chat-integration'); if (!CASE_TOOL_NAMES.includes('Fail') || !WAKEUP_BASE_TOOLS) throw new Error('C2 missing'); console.log('C2 present')"`
Expected: `C2 present`. Any `Cannot find module` or `C2 missing` means C2 has not merged: stop and report; this plan cannot start.

Run: `node -e "try { require('./src/platform/jcs'); console.log('jcs present') } catch { console.log('jcs absent') }"`
Expected: `jcs present` (F3 merged: skip the jcs file in Step 3) or `jcs absent` (create it in Step 3).

- [ ] **Step 1: Write the failing test**

Create `tests/cases-executor-util.test.js`:

```js
// tests/cases-executor-util.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../src/cases/executors/util');
const { EXECUTOR_SETTINGS_DEFAULTS, mergeExecutorSettings, resolveExecutorSettings } = require('../src/cases/executors/defaults');
const { canonicalize, sha256b64url } = require('../src/platform/jcs');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('executor util', () => {
  it('sha256hex hashes text and buffers alike', () => {
    assert.strictEqual(util.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(util.sha256hex(Buffer.from('abc')), util.sha256hex('abc'));
  });

  it('localDate reads the calendar day in a zone', () => {
    assert.strictEqual(util.localDate(new Date('2026-11-02T05:30:00Z'), 'America/Chicago'), '2026-11-01');
    assert.strictEqual(util.localDate(new Date('2026-11-02T06:30:00Z'), 'America/Chicago'), '2026-11-02');
    assert.strictEqual(util.localDate('2026-11-02T06:30:00Z', 'UTC'), '2026-11-02');
  });

  it('pickTimeZone takes the first valid zone, else the host zone', () => {
    assert.strictEqual(util.pickTimeZone('', 'Not/AZone', 'Asia/Tokyo'), 'Asia/Tokyo');
    assert.strictEqual(util.pickTimeZone(undefined, null), util.hostTimeZone());
    assert.strictEqual(util.validTimeZone('UTC'), true);
    assert.strictEqual(util.validTimeZone('Mars/Base'), false);
  });

  it('counts allowed weekdays between two days', () => {
    // 2026-10-26 is a Monday.
    assert.strictEqual(util.weekdayOf('2026-10-26'), 1);
    assert.strictEqual(util.weekdayOf('2026-11-01'), 7);
    assert.strictEqual(util.countDays('2026-10-26', '2026-11-01'), 7);
    assert.strictEqual(util.countDays('2026-10-26', '2026-11-01', [1, 2, 3, 4, 5]), 5);
    assert.strictEqual(util.countDays('2026-11-01', '2026-10-26'), 0);
    assert.strictEqual(util.addDays('2026-10-31', 1), '2026-11-01');
    assert.strictEqual(util.addDays('2026-11-01', -1), '2026-10-31');
  });

  it('window instants follow local calendar days across DST', () => {
    assert.deepStrictEqual(util.windowInstants('2026-10-30', '2026-11-01', 'America/Chicago'), {
      notBefore: '2026-10-30T05:00:00Z',
      notAfter: '2026-11-02T05:59:59Z'
    });
    assert.deepStrictEqual(util.windowInstants('2026-10-30', '2026-10-30', 'Asia/Tokyo'), {
      notBefore: '2026-10-29T15:00:00Z',
      notAfter: '2026-10-30T14:59:59Z'
    });
  });

  it('writes JSON atomically and reads it back, with a fallback for missing or broken files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-exec-util-'));
    dirs.push(dir);
    const file = path.join(dir, 'a', 'b.json');
    util.writeJsonAtomic(file, { n: 1 });
    assert.deepStrictEqual(util.readJsonSafe(file, null), { n: 1 });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['b.json'], 'no temp file is left behind');
    fs.writeFileSync(file, '{ broken');
    assert.strictEqual(util.readJsonSafe(file, 'fallback'), 'fallback');
    assert.strictEqual(util.readJsonSafe(path.join(dir, 'missing.json'), 7), 7);
  });

  it('parseJsonObject accepts only JSON text of an object', () => {
    assert.deepStrictEqual(util.parseJsonObject('{"a":1}', 'payload'), { ok: true, value: { a: 1 } });
    assert.match(util.parseJsonObject('[1]', 'payload').error, /"payload" must be JSON text of an object/);
    assert.match(util.parseJsonObject('{nope', 'payload').error, /"payload" is not valid JSON/);
    assert.match(util.parseJsonObject(undefined, 'payload').error, /"payload" is required/);
    assert.match(util.parseJsonObject(5, 'payload').error, /"payload" must be JSON text of an object/);
  });

  it('valueText and roundUsd render values the way cards and the gate show them', () => {
    assert.strictEqual(util.valueText(['a', 'b']), 'a, b');
    assert.strictEqual(util.valueText(12.5), '12.5');
    assert.strictEqual(util.valueText(null), '');
    assert.strictEqual(util.valueText({ a: 1 }), '{"a":1}');
    assert.strictEqual(util.roundUsd(0.1 + 0.2), 0.3);
  });
});

describe('executor settings', () => {
  it('defaults match the spec', () => {
    const s = resolveExecutorSettings(undefined);
    assert.deepStrictEqual(
      [s.defaultCountryCode, s.pollEveryMs, s.submitTimeoutMs, s.requestTimeoutMs, s.refreshBudgetMs, s.maxPollErrors, s.auditScanEntries, s.attemptsDefault, s.opsMemory.maxEntries],
      ['', 900000, 30000, 20000, 5000, 5, 5000, 2, 20]
    );
    assert.deepStrictEqual(Object.keys(s.outbound.categoryKeywords).sort(), ['financial', 'health', 'legal', 'personal']);
    assert.deepStrictEqual(s.entries, {});
  });

  it('merges key by key and replaces one category keyword list', () => {
    const s = mergeExecutorSettings(EXECUTOR_SETTINGS_DEFAULTS, {
      pollEveryMs: 60000,
      opsMemory: {},
      outbound: { categoryKeywords: { health: ['clinic'] } }
    });
    assert.strictEqual(s.pollEveryMs, 60000);
    assert.strictEqual(s.submitTimeoutMs, 30000);
    assert.strictEqual(s.opsMemory.maxEntries, 20);
    assert.deepStrictEqual(s.outbound.categoryKeywords.health, ['clinic']);
    assert.ok(s.outbound.categoryKeywords.financial.includes('floor price'));
    assert.strictEqual(EXECUTOR_SETTINGS_DEFAULTS.outbound.categoryKeywords.health.includes('clinic'), false, 'defaults are not mutated');
  });

  it('keeps entries from the source only when they are an object', () => {
    assert.deepStrictEqual(resolveExecutorSettings({ entries: { 'phone-agent': { kind: 'external-agent' } } }).entries, { 'phone-agent': { kind: 'external-agent' } });
    assert.deepStrictEqual(resolveExecutorSettings({ entries: ['nope'] }).entries, {});
  });
});

describe('JCS', () => {
  it('canonicalizes keys in code-unit order and hashes to base64url', () => {
    assert.strictEqual(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
    assert.strictEqual(sha256b64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-executor-util.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/util'`

- [ ] **Step 3: Implement**

If Step 0 printed `jcs absent`, create `src/platform/jcs.js` with exactly F3's content (P1; F3 rebases onto it):

```js
// RFC 8785 JSON Canonicalization Scheme. Every signed King Louie message is
// the JCS form of a JSON object, so this is the one place that decides which
// values can be signed at all.
const crypto = require('crypto');

class JcsError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'JcsError';
    this.code = code;
  }
}

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one. Such a string has no UTF-8 encoding, so two implementations would
// sign different bytes for it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s) {
  if (LONE_SURROGATE.test(s)) throw new JcsError('non_canonical_value', 'lone surrogate');
  return JSON.stringify(s);
}

function serialize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non_canonical_value', 'non-finite number');
      // ECMAScript number serialization is exactly what RFC 8785 §3.2.2.3 specifies.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      // Array.from visits holes as undefined, which is refused below.
      if (Array.isArray(value)) return `[${Array.from(value, serialize).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new JcsError('non_canonical_value', 'not a plain object');
      }
      // Default sort compares UTF-16 code units, which is the RFC 8785 order.
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${serializeString(k)}:${serialize(value[k])}`).join(',')}}`;
    }
    default:
      throw new JcsError('non_canonical_value', `unsupported type ${typeof value}`);
  }
}

function canonicalize(value) {
  return serialize(value);
}

// base64url (no padding) of SHA-256 over the UTF-8 bytes of a string, or over a Buffer.
function sha256b64url(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

module.exports = { canonicalize, sha256b64url, JcsError };
```

Create `src/cases/executors/util.js`:

```js
// src/cases/executors/util.js
// Small pure helpers shared by the executor modules (cases stage 3).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// The widest UTC offsets are -12 h and +14 h, so a local day starts and ends
// within 14 h of UTC midnight.
const SCAN_MS = 14 * 60 * MINUTE_MS;

function sha256hex(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function hostTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function pickTimeZone(...candidates) {
  for (const tz of candidates) if (validTimeZone(tz)) return tz;
  return hostTimeZone();
}

const formatters = new Map();
function dayFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

// The calendar day of `date` in `tz`, as YYYY-MM-DD. No offsets are
// computed, so a DST change cannot move a day boundary.
function localDate(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = {};
  for (const p of dayFormatter(tz).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayToUtcMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(day, n) {
  return new Date(dayToUtcMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

// ISO weekday of a calendar date: Monday 1 … Sunday 7.
function weekdayOf(day) {
  const w = new Date(dayToUtcMs(day)).getUTCDay();
  return w === 0 ? 7 : w;
}

function countDays(from, to, weekdays = [1, 2, 3, 4, 5, 6, 7]) {
  if (!DAY_PATTERN.test(String(from)) || !DAY_PATTERN.test(String(to)) || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (weekdays.includes(weekdayOf(d))) n += 1;
  return n;
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The first instant whose local date is `start` and the last whose local
// date is `end` (spec §3.3), found by scanning minutes around UTC midnight.
function windowInstants(start, end, tz) {
  const first = dayToUtcMs(start);
  let notBefore = null;
  for (let t = first - SCAN_MS; t <= first + SCAN_MS; t += MINUTE_MS) {
    if (localDate(new Date(t), tz) === start) {
      notBefore = isoSeconds(t);
      break;
    }
  }
  const next = dayToUtcMs(addDays(end, 1));
  let notAfter = null;
  for (let t = next + SCAN_MS; t >= next - SCAN_MS; t -= MINUTE_MS) {
    if (localDate(new Date(t), tz) === end) {
      notAfter = isoSeconds(t + 59 * 1000);
      break;
    }
  }
  return { notBefore, notAfter };
}

// temp + rename, so a reader never sees half a file.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Tool parameters that carry JSON declare type "string" so every provider
// accepts the schema; they must parse to a plain object.
function parseJsonObject(value, name) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: `"${name}" is required: JSON text of an object.` };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
  if (typeof value !== 'string') return { ok: false, error: `"${name}" must be JSON text of an object.` };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    return { ok: false, error: `"${name}" is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `"${name}" must be JSON text of an object.` };
  }
  return { ok: true, value: parsed };
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function roundUsd(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

module.exports = {
  DAY_PATTERN,
  sha256hex,
  validTimeZone,
  hostTimeZone,
  pickTimeZone,
  localDate,
  addDays,
  weekdayOf,
  countDays,
  isoSeconds,
  windowInstants,
  writeJsonAtomic,
  readJsonSafe,
  parseJsonObject,
  valueText,
  roundUsd
};
```

Create `src/cases/executors/defaults.js`:

```js
// src/cases/executors/defaults.js
// settings.executors (cases stage 3 spec §6), merged key by key.

const EXECUTOR_SETTINGS_DEFAULTS = Object.freeze({
  // Desktop only; in service mode entries come from the admin service.json (R42).
  entries: {},
  // '' means a number without a country code is refused.
  defaultCountryCode: '',
  pollEveryMs: 900000,
  submitTimeoutMs: 30000,
  requestTimeoutMs: 20000,
  refreshBudgetMs: 5000,
  maxPollErrors: 5,
  auditScanEntries: 5000,
  // Attempts per contact assumed by plan estimates when no payload says.
  attemptsDefault: 2,
  opsMemory: { maxEntries: 20 },
  outbound: {
    categoryKeywords: {
      personal: ['divorce', 'social security', 'ssn', 'date of birth', 'home address', 'maiden name', 'passport number'],
      financial: ['bank account', 'routing number', 'credit card', 'salary', 'income', 'debt', 'mortgage', 'payoff', 'floor price', 'lowest price', 'minimum price', 'reserve price', 'net worth'],
      legal: ['lawsuit', 'litigation', 'attorney', 'lawyer', 'court', 'lien', 'bankruptcy', 'settlement', 'probate'],
      health: ['diagnosis', 'illness', 'medical', 'hospital', 'medication', 'disability', 'pregnant', 'therapy']
    }
  }
});

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function mergeExecutorSettings(base, source) {
  const b = isObject(base) ? base : EXECUTOR_SETTINGS_DEFAULTS;
  const s = isObject(source) ? source : {};
  const keywords = {};
  for (const [k, v] of Object.entries(b.outbound?.categoryKeywords || {})) keywords[k] = [...v];
  const sourceKeywords = s.outbound?.categoryKeywords;
  if (isObject(sourceKeywords)) {
    for (const [k, v] of Object.entries(sourceKeywords)) if (Array.isArray(v)) keywords[k] = v.map(String);
  }
  return {
    ...b,
    ...s,
    entries: isObject(s.entries) ? { ...s.entries } : { ...(b.entries || {}) },
    opsMemory: { ...(b.opsMemory || {}), ...(isObject(s.opsMemory) ? s.opsMemory : {}) },
    outbound: { ...(b.outbound || {}), ...(isObject(s.outbound) ? s.outbound : {}), categoryKeywords: keywords }
  };
}

function resolveExecutorSettings(raw) {
  return mergeExecutorSettings(EXECUTOR_SETTINGS_DEFAULTS, raw);
}

module.exports = { EXECUTOR_SETTINGS_DEFAULTS, mergeExecutorSettings, resolveExecutorSettings };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-executor-util.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/util.js src/cases/executors/defaults.js tests/cases-executor-util.test.js
git add src/platform/jcs.js   # only if Step 3 created it
git commit -m "feat(cases): executor helpers, settings defaults and the JCS module

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Recipient normalization and value forms

**Files:**
- Create: `src/cases/executors/normalize.js`
- Test: `tests/cases-executor-normalize.test.js`

**Interfaces:**
- Consumes: `DAY_PATTERN` (Task 1).
- Produces: `normalizeRecipient(address, { channel, defaultCountryCode }) → { ok: true, value } | { ok: false, error }` (spec §3.8; channels `call | sms | voicemail | phone` → E.164, `email`, `url | web-form | web-browse` → origin, anything else → folded text); `recipientChannel(capabilities) → 'call' | 'email' | 'url' | 'text'`; `valueMatchers(value, unit) → [{ kind, form, re }]` (rule 1's normalized value forms); `matchSpans(text, matchers) → [{ start, end, text }]` (outermost spans only); `isRecipient(text, recipients) → boolean`; `valueKey(value) → string` (normalized comparison key); `foldText(s)`; `escapeRe(s)`; `MONTH_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-executor-normalize.test.js`:

```js
// tests/cases-executor-normalize.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  normalizeRecipient, recipientChannel, valueMatchers, matchSpans, isRecipient, valueKey, foldText
} = require('../src/cases/executors/normalize');

const spans = (value, unit, text) => matchSpans(text, valueMatchers(value, unit)).map((s) => s.text);

describe('normalizeRecipient', () => {
  it('normalizes phone numbers to E.164', () => {
    assert.deepStrictEqual(normalizeRecipient('+1 (555) 0100', { channel: 'call' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('0015550100', { channel: 'sms' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('555.0100', { channel: 'call', defaultCountryCode: '1' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('555-0100', { channel: 'call' }), {
      ok: false,
      error: 'cannot normalize "555-0100" to E.164; give the country code'
    });
    assert.strictEqual(normalizeRecipient('+12', { channel: 'call' }).ok, false);
  });

  it('lowercases the email domain and refuses non-addresses', () => {
    assert.deepStrictEqual(normalizeRecipient(' Clerk@Records.Example.org ', { channel: 'email' }), { ok: true, value: 'Clerk@records.example.org' });
    assert.deepStrictEqual(normalizeRecipient('nobody', { channel: 'email' }), { ok: false, error: '"nobody" is not an email address' });
  });

  it('reduces a URL to its origin', () => {
    assert.deepStrictEqual(normalizeRecipient('HTTPS://Permits.Example.com:443/apply?x=1', { channel: 'web-form' }), { ok: true, value: 'https://permits.example.com' });
    assert.deepStrictEqual(normalizeRecipient('http://permits.example.com:8080/a', { channel: 'url' }), { ok: true, value: 'http://permits.example.com:8080' });
    assert.deepStrictEqual(normalizeRecipient('ftp://permits.example.com', { channel: 'url' }), { ok: false, error: '"ftp://permits.example.com" is not an http(s) URL' });
  });

  it('picks the channel from an executor\'s capabilities', () => {
    assert.strictEqual(recipientChannel(['call', 'voicemail']), 'call');
    assert.strictEqual(recipientChannel(['email']), 'email');
    assert.strictEqual(recipientChannel(['web-browse', 'web-form']), 'url');
    assert.strictEqual(recipientChannel(['postal-mail']), 'text');
  });
});

describe('value forms', () => {
  it('finds a phone with and without the country code, across separators', () => {
    assert.deepStrictEqual(spans('+15550100', null, 'Call 555-0100 or +1 555 0100 today'), ['555-0100', '+1 555 0100']);
    assert.deepStrictEqual(spans('+15550100', null, 'Ref 155501009'), []);
  });

  it('finds money and grouped numbers but not inside longer numbers', () => {
    assert.deepStrictEqual(spans(1250000, 'USD', 'Floor is $1,250,000 or 1250000.00'), ['1,250,000', '1250000.00']);
    assert.deepStrictEqual(spans(1250000, null, 'Lot 12500001'), []);
    assert.deepStrictEqual(spans('$1,250', null, 'Offer 1,250 now'), ['1,250']);
  });

  it('skips unitless numbers under three digits, keeps them with a unit', () => {
    assert.deepStrictEqual(valueMatchers(42, null), []);
    assert.deepStrictEqual(spans(42, 'acres', 'About 42 acres'), ['42']);
    assert.deepStrictEqual(spans(2.12, 'acres', 'The lot is 2.12 acres'), ['2.12']);
  });

  it('finds ISO and written dates', () => {
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due 2026-11-14.'), ['2026-11-14']);
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due November 14, 2026 at noon'), ['November 14, 2026']);
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due Friday November 14'), ['November 14']);
  });

  it('finds folded text of four or more characters, not stop words or fragments', () => {
    assert.deepStrictEqual(spans('Lakeside Lot', null, 'the lakeside   lot is for sale'), ['lakeside   lot']);
    assert.deepStrictEqual(valueMatchers('lot', null), []);
    assert.deepStrictEqual(valueMatchers('none', null), []);
    assert.deepStrictEqual(spans('Harbor', null, 'Harborview Road'), []);
  });

  it('finds an email case-insensitively and walks array values', () => {
    assert.deepStrictEqual(spans('clerk@records.example.org', null, 'Write to Clerk@Records.Example.org.'), ['Clerk@Records.Example.org']);
    assert.deepStrictEqual(spans(['Lakeside Lot', 1250000], 'USD', 'Lakeside lot at $1,250,000'), ['Lakeside lot', '1,250,000']);
  });
});

describe('comparison helpers', () => {
  it('treats a recipient address as the recipient in any format', () => {
    assert.strictEqual(isRecipient('555-0100', ['+15550100']), true);
    assert.strictEqual(isRecipient('+1 555 0100', ['+15550100']), true);
    assert.strictEqual(isRecipient('555-0199', ['+15550100']), false);
    assert.strictEqual(isRecipient('Clerk@Records.example.org', ['clerk@records.example.org']), true);
  });

  it('valueKey compares values after normalization', () => {
    assert.strictEqual(valueKey('2.12'), valueKey(2.12));
    assert.strictEqual(valueKey('$1,250'), valueKey(1250));
    assert.notStrictEqual(valueKey(2.5), valueKey(2.12));
    assert.strictEqual(valueKey(['b', 'a']), valueKey(['a', 'b']));
    assert.strictEqual(foldText('  Lakeside  LOT '), 'lakeside lot');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-executor-normalize.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/normalize'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/normalize.js`:

```js
// src/cases/executors/normalize.js
// Recipient normalization (cases stage 3 spec §3.8) and the value forms the
// outbound gate's rule 1 searches for. The same functions produce both, so a
// recipient and a fact value compare equal whenever they are the same.
const { DAY_PATTERN } = require('./util');

const PHONE_CHANNELS = new Set(['call', 'sms', 'voicemail', 'phone']);
const URL_CHANNELS = new Set(['url', 'web-form', 'web-browse']);
const PHONE_SEPARATORS = /[\s\-.()]/g;
const PHONE_LIKE = /^\+?[\d\s\-.()]+$/;
const NUMERIC_TEXT = /^\$?\s?-?\d[\d,]*(\.\d+)?$/;
const MONEY_UNITS = /^(usd|\$|dollars?)$/i;
const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
// Folded text values this short or this common match too much to mean anything.
const STOP_WORDS = new Set(['none', 'null', 'true', 'false', 'unknown', 'with', 'from', 'that', 'this', 'have', 'will', 'your', 'owner', 'case', 'item', 'items', 'other', 'about', 'there', 'their']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(address, defaultCountryCode) {
  const raw = String(address ?? '').trim();
  let s = raw.replace(PHONE_SEPARATORS, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^\+\d{8,15}$/.test(s)) return { ok: true, value: s };
  const cc = String(defaultCountryCode || '').replace(/^\+/, '');
  if (/^\d+$/.test(s) && /^\d{1,3}$/.test(cc)) {
    const full = `+${cc}${s}`;
    if (/^\+\d{8,15}$/.test(full)) return { ok: true, value: full };
  }
  return { ok: false, error: `cannot normalize "${raw}" to E.164; give the country code` };
}

function normalizeEmail(address) {
  const raw = String(address ?? '').trim();
  const at = raw.lastIndexOf('@');
  const domain = at > 0 ? raw.slice(at + 1) : '';
  if (at < 1 || !domain || /\s/.test(raw) || !domain.includes('.')) {
    return { ok: false, error: `"${raw}" is not an email address` };
  }
  return { ok: true, value: `${raw.slice(0, at)}@${domain.toLowerCase()}` };
}

function normalizeUrl(address) {
  const raw = String(address ?? '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not an http(s) URL` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `"${raw}" is not an http(s) URL` };
  // URL lowercases the host and drops a default port.
  return { ok: true, value: u.origin };
}

function normalizeRecipient(address, { channel = 'call', defaultCountryCode = '' } = {}) {
  if (PHONE_CHANNELS.has(channel)) return normalizePhone(address, defaultCountryCode);
  if (channel === 'email') return normalizeEmail(address);
  if (URL_CHANNELS.has(channel)) return normalizeUrl(address);
  const text = foldText(address);
  return text ? { ok: true, value: text } : { ok: false, error: 'a recipient address is required' };
}

function recipientChannel(capabilities = []) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (caps.includes('call') || caps.includes('sms') || caps.includes('voicemail')) return 'call';
  if (caps.includes('email')) return 'email';
  if (caps.includes('web-form') || caps.includes('web-browse')) return 'url';
  return 'text';
}

// ---- Rule 1 value forms ----

function digitMatcher(digits) {
  const body = digits.split('').join('[\\s\\-.()]*');
  return { kind: 'phone', form: digits, re: new RegExp(`(?<!\\d)\\+?${body}(?!\\d)`, 'g') };
}

// With and without a country code of one to three digits.
function phoneMatchers(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return [];
  const forms = new Set([digits]);
  for (let cc = 1; cc <= 3; cc += 1) if (digits.length - cc >= 7) forms.add(digits.slice(cc));
  return [...forms].map(digitMatcher);
}

function numberMatchers(n, unit) {
  if (!Number.isFinite(n)) return [];
  if (!unit && Number.isInteger(n) && Math.abs(n) < 100) return [];
  const forms = new Set([String(n), n.toLocaleString('en-US', { maximumFractionDigits: 20 })]);
  if (MONEY_UNITS.test(String(unit || '')) || !Number.isInteger(n)) {
    forms.add(n.toFixed(2));
    forms.add(n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  return [...forms].map((form) => ({
    kind: 'number',
    form,
    re: new RegExp(`(?<![\\d.,])${escapeRe(form)}(?![\\d]|[.,]\\d)`, 'g')
  }));
}

function wordMatcher(kind, form) {
  const pattern = escapeRe(form).replace(/ /g, '\\s+');
  return { kind, form, re: new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu') };
}

function dateMatchers(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTH_NAMES[m - 1];
  if (!month) return [];
  return [
    { kind: 'date', form: iso, re: new RegExp(`(?<![\\d-])${escapeRe(iso)}(?![\\d])`, 'g') },
    wordMatcher('date', `${month} ${d}, ${y}`),
    wordMatcher('date', `${month} ${d} ${y}`),
    wordMatcher('date', `${month} ${d}`)
  ];
}

function emailMatchers(value) {
  const lower = value.trim().toLowerCase();
  return [{ kind: 'email', form: lower, re: new RegExp(`(?<![\\w.+-])${escapeRe(lower)}(?![\\w-])`, 'gi') }];
}

function textMatchers(value) {
  const folded = foldText(value);
  if (folded.length < 4 || STOP_WORDS.has(folded)) return [];
  return [wordMatcher('text', folded)];
}

function valueMatchers(value, unit = null) {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((v) => valueMatchers(v, unit));
  if (typeof value === 'number') return numberMatchers(value, unit);
  if (typeof value === 'object') return [];
  const s = String(value).trim();
  if (!s) return [];
  if (DAY_PATTERN.test(s)) return dateMatchers(s);
  if (s.includes('@') && !/\s/.test(s)) return emailMatchers(s);
  if (PHONE_LIKE.test(s) && /\d/.test(s)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && (s.startsWith('+') || /[\s\-.()]/.test(s))) return phoneMatchers(s);
  }
  if (NUMERIC_TEXT.test(s)) {
    const n = Number(s.replace(/[$,\s]/g, ''));
    return numberMatchers(n, unit || (s.startsWith('$') ? 'usd' : null));
  }
  return textMatchers(s);
}

// Every match of every matcher; where one span contains another only the
// outer one is kept.
function matchSpans(text, matchers) {
  const s = String(text ?? '');
  const found = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    let hit;
    while ((hit = m.re.exec(s)) !== null) {
      if (hit[0].length === 0) {
        m.re.lastIndex += 1;
        continue;
      }
      found.push({ start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const sp of found) {
    if (out.some((o) => o.start <= sp.start && o.end >= sp.end)) continue;
    out.push(sp);
  }
  return out;
}

// True when `text` names one of this send's recipients, in any format.
function isRecipient(text, recipients = []) {
  const t = foldText(text);
  const d = String(text ?? '').replace(/\D/g, '');
  return (recipients || []).some((r) => {
    if (foldText(r) === t) return true;
    const rd = String(r ?? '').replace(/\D/g, '');
    return d.length >= 7 && rd.length >= 7 && (rd === d || rd.endsWith(d));
  });
}

function valueKey(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueKey).sort().join('|');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value).trim();
  if (NUMERIC_TEXT.test(s)) {
    const n = Number(s.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) return String(n);
  }
  return foldText(s);
}

module.exports = {
  MONTH_NAMES,
  escapeRe,
  foldText,
  normalizeRecipient,
  recipientChannel,
  valueMatchers,
  matchSpans,
  isRecipient,
  valueKey
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-executor-normalize.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/normalize.js tests/cases-executor-normalize.test.js
git commit -m "feat(cases): recipient normalization and outbound value forms

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The outbound gate

**Files:**
- Create: `src/cases/outbound.js`
- Modify: `src/cases/gates.js` (the `require` line at the top and the `module.exports` line at the end)
- Test: `tests/cases-outbound-gate.test.js`

**Interfaces:**
- Consumes: `valueMatchers`, `matchSpans`, `isRecipient`, `foldText`, `escapeRe` (Task 2); `valueText`, `DAY_PATTERN` (Task 1); `EXECUTOR_SETTINGS_DEFAULTS` (Task 1).
- Produces:
  - `outbound.js`: `detect(text) → [{ kind: 'date'|'price'|'deadline'|'commitment', start, end, text, value, sentence }]`, `sentenceRanges(text)`, `sentenceOf(ranges, pos)`.
  - `gates.js` (program §4.9, R38): `outboundGate({ payloadText, recipients = [], envelope = null, facts: Map, mode = 'message', entitySpans = [], categoryKeywords = null }) → { ok, blocked: [{ span: { start, end, text }, reason, factId?, detail }], rendered }`; `gateLeaves(payload, { recipients, envelope, facts, mode, caseId, entityIndex, categoryKeywords }) → { ok, blocked: [{ path, span, reason, factId?, detail }], rendered }`; `renderFactRefs(text, facts, { envelope }) → { rendered, blocked, refs }`; `GATE_REASONS`.
  - Block reasons: `bad-reference`, `superseded`, `inferred`, `unknown`, `non-disclosable`, `not-in-envelope`, `category-keyword`, `unsourced-constraint`, `non-disclosable-entity`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-outbound-gate.test.js`:

```js
// tests/cases-outbound-gate.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { outboundGate, gateLeaves, renderFactRefs } = require('../src/cases/gates');
const { detect } = require('../src/cases/outbound');

function fact(id, over = {}) {
  return {
    id, stmt: over.stmt || `Fact ${id}`, subject: 'lot', attr: id, value: null, unit: null,
    provenance: 'sourced', category: null, disclosable: true, status: 'active', supersededBy: null, ...over
  };
}
const facts = (...list) => new Map(list.map((f) => [f.id, f]));
const reasons = (r) => r.blocked.map((b) => b.reason);
const active = (over = {}) => ({ status: 'active', intent: 'Ask for a listing quote', rules: [], facts: [], ...over });

const ACRES = fact('f-0001', { value: 2.12, unit: 'acres', stmt: 'Lot size is 2.12 acres' });
const INFERRED = fact('f-0002', { value: 'Harbor Road access', provenance: 'inferred', disclosable: false });
const OLD = fact('f-0003', { value: 3.1, unit: 'acres', status: 'superseded', supersededBy: 'f-0004' });
const FLOOR = fact('f-0005', { value: 1250000, unit: 'USD', provenance: 'user', category: 'financial', disclosable: false, stmt: 'Floor price' });
const REPORTED = fact('f-0006', { value: 'north corner', provenance: 'external-agent' });
const OFFICE = fact('f-0007', { value: '+15550100', stmt: 'County office phone' });
const DUE = fact('f-0009', { value: '2026-11-14', stmt: 'Offers are due 2026-11-14' });

describe('fact references', () => {
  it('renders an active disclosable fact with its unit', () => {
    const r = outboundGate({ payloadText: 'The lot is {{f-0001}}.', facts: facts(ACRES) });
    assert.deepStrictEqual([r.ok, r.rendered], [true, 'The lot is 2.12 acres.']);
  });

  it('refuses bad, superseded, inferred, private and out-of-envelope references', () => {
    const all = facts(ACRES, INFERRED, OLD, FLOOR, REPORTED);
    const r = outboundGate({ payloadText: '{{f-0099}} {{f-0002}} {{f-0003}} {{f-0005}}', facts: all, mode: 'query' });
    assert.deepStrictEqual(reasons(r), ['bad-reference', 'inferred', 'superseded', 'non-disclosable']);
    assert.deepStrictEqual(r.blocked.map((b) => b.factId), ['f-0099', 'f-0002', 'f-0003', 'f-0005']);
    const env = outboundGate({ payloadText: 'Seen at {{f-0006}}', facts: all, mode: 'query', envelope: active({ facts: ['f-0001'] }) });
    assert.deepStrictEqual(reasons(env), ['not-in-envelope']);
    const ok = outboundGate({ payloadText: 'Seen at {{f-0006}}', facts: all, mode: 'query' });
    assert.deepStrictEqual([ok.ok, ok.rendered], [true, 'Seen at north corner']);
  });

  it('renderFactRefs reports each reference', () => {
    const r = renderFactRefs('{{ f-0001 }} and {{f-0002}}', facts(ACRES, INFERRED));
    assert.strictEqual(r.rendered, '2.12 acres and {{f-0002}}');
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['inferred', '{{f-0002}}']]);
  });
});

describe('rule 1: value match', () => {
  it('blocks a pasted private, inferred or superseded value', () => {
    const all = facts(INFERRED, OLD, FLOOR);
    const r = outboundGate({ payloadText: 'Floor 1,250,000; access via Harbor Road access; 3.1 acres', facts: all, mode: 'query' });
    assert.deepStrictEqual(reasons(r).sort(), ['inferred', 'non-disclosable', 'superseded']);
    assert.ok(r.blocked.every((b) => b.factId));
  });

  it('lets a superseded value through when an active fact has the same value', () => {
    const r = outboundGate({ payloadText: 'About 3.1 acres', facts: facts(OLD, fact('f-0004', { value: 3.1, unit: 'acres' })), mode: 'query' });
    assert.strictEqual(r.ok, true);
  });

  it('turns a disclosable value outside the envelope into not-in-envelope', () => {
    const r = outboundGate({ payloadText: 'It is 2.12 acres', facts: facts(ACRES), mode: 'query', envelope: active() });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.factId, b.span.text]), [['not-in-envelope', 'f-0001', '2.12']]);
  });

  it('never counts the recipient address as a disclosure', () => {
    const r = outboundGate({ payloadText: 'Calling 555-0100 now', facts: facts(OFFICE), recipients: ['+15550100'], envelope: active() });
    assert.strictEqual(r.ok, true);
  });
});

describe('rule 2: category keywords', () => {
  it('blocks a category keyword while the case holds a private fact of that category', () => {
    const r = outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR) });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['category-keyword', 'floor price']]);
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(ACRES) }).ok, true);
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR), mode: 'query' }).ok, true);
  });

  it('passes a keyword that is verbatim in the approved intent', () => {
    const env = active({ intent: 'Ask each broker for their floor price estimate' });
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR), envelope: env }).ok, true);
  });

  it('uses the configured keyword lists', () => {
    const r = outboundGate({ payloadText: 'Ask about the clinic', facts: facts(fact('f-0020', { value: 'x', category: 'health', disclosable: false })), categoryKeywords: { health: ['clinic'] } });
    assert.deepStrictEqual(reasons(r), ['category-keyword']);
  });
});

describe('rule 3: detectors', () => {
  it('date: finds written, ISO and numeric dates with a year, not fractions', () => {
    assert.deepStrictEqual(detect('Offers are due by Friday November 14.').map((d) => [d.kind, d.text, d.value]), [
      ['deadline', 'due by', null], ['date', 'Friday November 14', '--11-14']
    ]);
    assert.deepStrictEqual(detect('Closing 11/14/2026 or 2026-11-15').map((d) => d.value), ['2026-11-14', '2026-11-15']);
    assert.deepStrictEqual(detect('A 1/2 acre lot on two roads'), []);
  });

  it('price: finds dollar amounts, not bare counts', () => {
    assert.deepStrictEqual(detect('We ask $1,250 or 2k dollars').map((d) => [d.kind, d.value]), [['price', 1250], ['price', 2000]]);
    assert.deepStrictEqual(detect('Lot 12 of 40'), []);
  });

  it('deadline: finds deadline phrases, not ordinary verbs', () => {
    assert.deepStrictEqual(detect('Submit no later than 2026-11-14.').map((d) => d.kind), ['deadline', 'date']);
    assert.deepStrictEqual(detect('Submit it when you can'), []);
  });

  it('commitment: finds promises, not requests', () => {
    assert.deepStrictEqual(detect('We will accept 1,200 dollars').map((d) => d.kind), ['commitment', 'price']);
    assert.deepStrictEqual(detect('We would like a quote'), []);
  });

  it('keeps sentence numbers so a deadline sees its own sentence only', () => {
    const spans = detect('Call on Monday. Offers are due soon. The date is 2026-11-14.');
    assert.deepStrictEqual(spans.map((s) => [s.kind, s.sentence]), [['deadline', 1], ['date', 2]]);
  });
});

describe('rule 3: unsourced constraints', () => {
  it('blocks an invented deadline and passes one backed by a sourced fact', () => {
    const bad = outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts() });
    assert.deepStrictEqual(reasons(bad), ['unsourced-constraint', 'unsourced-constraint']);
    const good = outboundGate({ payloadText: 'Offers are due by {{f-0009}}.', facts: facts(DUE), envelope: active({ facts: ['f-0009'] }) });
    assert.deepStrictEqual([good.ok, good.rendered], [true, 'Offers are due by 2026-11-14.']);
    const matched = outboundGate({ payloadText: 'Offers are due by November 14, 2026', facts: facts(fact('f-0010', { value: '2026-11-14', provenance: 'user' })) });
    assert.strictEqual(matched.ok, true);
  });

  it('never lets an external-agent fact back a constraint', () => {
    const reported = fact('f-0011', { value: '2026-11-14', provenance: 'external-agent' });
    const r = outboundGate({ payloadText: 'Offers are due by {{f-0011}}.', facts: facts(reported) });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['unsourced-constraint', 'due by']]);
  });

  it('passes wording that is verbatim in the approved envelope', () => {
    const env = active({ intent: 'Tell brokers offers are due by Friday November 14' });
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), envelope: env }).ok, true);
    const requested = { ...env, status: 'requested' };
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), envelope: requested }).ok, false, 'only an approved envelope counts');
  });

  it('a promise needs a backed value in its sentence', () => {
    assert.deepStrictEqual(reasons(outboundGate({ payloadText: 'We will accept $1,200.', facts: facts() })), ['unsourced-constraint', 'unsourced-constraint']);
    assert.strictEqual(outboundGate({ payloadText: 'We will accept $1,200.', facts: facts(fact('f-0012', { value: 1200, unit: 'USD' })) }).ok, true);
  });
});

describe('rule 4 and modes', () => {
  it('blocks an entity span unless it is this send\'s recipient', () => {
    const text = 'Call back on 555-0199';
    const start = text.indexOf('555-0199');
    const entitySpans = [{ span: { start, end: start + 8, text: '555-0199' }, entity: 'phone', reason: 'private phone' }];
    assert.deepStrictEqual(reasons(outboundGate({ payloadText: text, facts: facts(), entitySpans })), ['non-disclosable-entity']);
    assert.strictEqual(outboundGate({ payloadText: text, facts: facts(), entitySpans, recipients: ['+15550199'] }).ok, true);
  });

  it('query mode runs the value rules only', () => {
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), mode: 'query' }).ok, true);
    assert.strictEqual(outboundGate({ payloadText: 'lakeside 1,250,000', facts: facts(FLOOR), mode: 'query' }).ok, false);
  });
});

describe('gateLeaves', () => {
  it('payload name leaf is gated', () => {
    const payload = {
      recipients: [{ address: '+15550100', name: 'Harbor Road access' }],
      text: 'Hello about {{f-0001}}',
      expect: [{ subject: 'lot', attr: 'price', question: 'Is 1,250,000 fair?' }],
      attemptsPerContact: 2
    };
    const r = gateLeaves(payload, { recipients: ['+15550100'], facts: facts(ACRES, INFERRED, FLOOR), mode: 'query' });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [
      ['recipients[0].name', 'inferred'],
      ['expect[0].question', 'non-disclosable']
    ]);
    assert.strictEqual(r.rendered.text, 'Hello about 2.12 acres');
    assert.strictEqual(r.rendered.attemptsPerContact, 2);
  });

  it('gates values, never keys, and asks the entity index per leaf', () => {
    const calls = [];
    const entityIndex = {
      nonDisclosableSpans(text, { caseId }) {
        calls.push([text, caseId]);
        const i = text.indexOf('Pat Doe');
        return i === -1 ? [] : [{ span: { start: i, end: i + 7, text: 'Pat Doe' }, entity: 'person', reason: 'private name' }];
      }
    };
    const r = gateLeaves({ 'Harbor Road access': 'ok', note: 'Ask for Pat Doe' }, { facts: facts(INFERRED), mode: 'query', caseId: 'case-1', entityIndex });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['note', 'non-disclosable-entity']]);
    assert.deepStrictEqual(calls, [['ok', 'case-1'], ['Ask for Pat Doe', 'case-1']]);
  });

  it('fails closed when the entity index throws', () => {
    const entityIndex = { nonDisclosableSpans() { throw new Error('index offline'); } };
    const r = gateLeaves({ text: 'hello' }, { facts: facts(), mode: 'query', entityIndex });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['text', 'non-disclosable-entity']]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-outbound-gate.test.js`
Expected: FAIL with `Cannot find module '../src/cases/outbound'`

- [ ] **Step 3: Implement**

Create `src/cases/outbound.js`:

```js
// src/cases/outbound.js
// English detectors for the outbound gate's rule 3 (cases stage 3 spec
// §3.7): dates, prices, deadlines and commitments in text about to leave.
// Pure; the gate decides which spans a fact or approved wording backs.

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?';
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');

// YYYY-MM-DD with a year, --MM-DD without one.
function dateValue(year, month, day) {
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  return year ? `${year}-${pad(month)}-${pad(day)}` : `--${pad(month)}-${pad(day)}`;
}

const monthOf = (name) => MONTH_INDEX[String(name).slice(0, 3).toLowerCase()];

const DATE_PATTERNS = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, value: (m) => dateValue(Number(m[1]), Number(m[2]), Number(m[3])) },
  {
    re: new RegExp(`\\b${WEEKDAY_RE}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    value: (m) => dateValue(m[3] ? Number(m[3]) : null, monthOf(m[1]), Number(m[2]))
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    value: (m) => dateValue(m[3] ? Number(m[3]) : null, monthOf(m[2]), Number(m[1]))
  },
  // US numeric dates only with a year, so "1/2 acre" is not a date.
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g,
    value: (m) => (Number(m[1]) <= 12
      ? dateValue(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]))
      : null)
  }
];

function scale(num, suffix) {
  const n = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const s = String(suffix || '').toLowerCase();
  if (s === 'k' || s === 'thousand') return n * 1e3;
  if (s === 'm' || s === 'million') return n * 1e6;
  return n;
}

const PRICE_PATTERNS = [
  { re: /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m|thousand|million)\b)?/gi, value: (m) => scale(m[1], m[2]) },
  { re: /\b(\d[\d,]*(?:\.\d+)?)\s?(k|m|thousand|million)?\s?(?:dollars|usd)\b/gi, value: (m) => scale(m[1], m[2]) }
];

const DEADLINE_RE = /\b(?:due(?:\s+(?:by|on|before))?|deadlines?|no later than|expires?(?:\s+on)?|must be (?:received|submitted|filed) by|closes? on)\b/gi;
const COMMITMENT_RE = /\b(?:(?:will|can|shall) (?:pay|accept|offer|sell|buy|close|sign|deliver|refund)|agree(?:s|d)? to|guarantee[sd]?|promise[sd]?|commit(?:s|ted)? to|firm offer)\b/gi;

// A sentence ends at . ! ? before a capital letter or the end, or at a
// newline, so "Nov. 14" and "$1,250.00" stay inside their sentence.
function sentenceRanges(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /[.!?]+(?=\s+[A-Z]|\s*$)|\n+/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const end = m.index + m[0].length;
    if (end > start) out.push({ start, end });
    start = end;
  }
  if (start < s.length) out.push({ start, end: s.length });
  return out.length ? out : [{ start: 0, end: s.length }];
}

function sentenceOf(ranges, pos) {
  const i = ranges.findIndex((r) => pos >= r.start && pos < r.end);
  return i === -1 ? ranges.length - 1 : i;
}

function collect(text, patterns, kind) {
  const out = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      out.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0], value: p.value(m) });
    }
  }
  return out;
}

// Overlapping matches of one kind: keep the earliest, longest.
function dedupe(spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const sp of sorted) {
    if (out.some((o) => sp.start < o.end && sp.end > o.start)) continue;
    out.push(sp);
  }
  return out;
}

function detect(text) {
  const s = String(text ?? '');
  const sentences = sentenceRanges(s);
  const dates = dedupe(collect(s, DATE_PATTERNS, 'date')).filter((sp) => sp.value);
  const prices = dedupe(collect(s, PRICE_PATTERNS, 'price')).filter((sp) => sp.value !== null);
  const deadlines = dedupe(collect(s, [{ re: DEADLINE_RE, value: () => null }], 'deadline'));
  const commitments = dedupe(collect(s, [{ re: COMMITMENT_RE, value: () => null }], 'commitment'));
  return [...dates, ...prices, ...deadlines, ...commitments]
    .map((sp) => ({ ...sp, sentence: sentenceOf(sentences, sp.start) }))
    .sort((a, b) => a.start - b.start);
}

module.exports = { detect, sentenceRanges, sentenceOf };
```

In `src/cases/gates.js`, replace

```js
const { norm } = require('./jsonl');
```

with

```js
const { norm } = require('./jsonl');
const { valueMatchers, matchSpans, isRecipient, foldText, escapeRe } = require('./executors/normalize');
const { detect, sentenceRanges, sentenceOf } = require('./outbound');
const { EXECUTOR_SETTINGS_DEFAULTS } = require('./executors/defaults');
const { valueText, DAY_PATTERN } = require('./executors/util');
```

In `src/cases/gates.js`, replace

```js
module.exports = { recommendationGate, findDuplicates };
```

with the following. (If C5 has already merged and this line lists more names, keep them and add the four new ones.)

```js
// ---- Outbound gate (cases stage 3 spec §3.7, program §4.9, R38) ----

const GATE_REASONS = Object.freeze([
  'bad-reference', 'superseded', 'inferred', 'unknown', 'non-disclosable', 'not-in-envelope',
  'category-keyword', 'unsourced-constraint', 'non-disclosable-entity'
]);
const REF_RE = /\{\{\s*(f-\d{4,})\s*\}\}/g;
const RENDERABLE = new Set(['user', 'sourced', 'external-agent']);
// external-agent facts never back a constraint (parent §7.2, R40).
const BACKING = new Set(['user', 'sourced']);
const SENSITIVE = ['personal', 'financial', 'legal', 'health'];
// An envelope's intent and rules count as approved wording only once the
// owner approved them.
const APPROVED_STATUSES = new Set(['active', 'expired', 'exhausted']);

function refProblem(fact, envelope) {
  if (!fact) return { reason: 'bad-reference', detail: 'no such fact' };
  if (fact.status === 'superseded') return { reason: 'superseded', detail: `superseded by ${fact.supersededBy}` };
  if (fact.status !== 'active') return { reason: 'bad-reference', detail: `the fact is ${fact.status}` };
  if (fact.provenance === 'inferred') return { reason: 'inferred', detail: 'inferred facts never leave' };
  if (fact.provenance === 'unknown') return { reason: 'unknown', detail: 'an open unknown has no value to send' };
  if (!RENDERABLE.has(fact.provenance)) return { reason: 'bad-reference', detail: `provenance ${fact.provenance}` };
  if (!fact.disclosable) return { reason: 'non-disclosable', detail: 'the owner has not made it disclosable' };
  if (envelope && !(envelope.facts || []).includes(fact.id)) return { reason: 'not-in-envelope', detail: 'not in the approved envelope' };
  return null;
}

function renderFactRefs(text, facts, { envelope = null } = {}) {
  const s = String(text ?? '');
  const map = facts instanceof Map ? facts : new Map();
  const blocked = [];
  const refs = [];
  const rendered = s.replace(REF_RE, (whole, id, offset) => {
    const fact = map.get(id) || null;
    const problem = refProblem(fact, envelope);
    refs.push({ start: offset, end: offset + whole.length, id, fact, ok: !problem });
    if (problem) {
      blocked.push({ span: { start: offset, end: offset + whole.length, text: whole }, reason: problem.reason, factId: id, detail: problem.detail });
      return whole;
    }
    const v = valueText(fact.value);
    return fact.unit ? `${v} ${fact.unit}` : v;
  });
  return { rendered, blocked, refs };
}

function spanMatchesValue(sp, value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((v) => {
    if (sp.kind === 'price') {
      const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, ''));
      return Number.isFinite(n) && n === sp.value;
    }
    if (sp.kind === 'date') {
      const s = String(v ?? '');
      if (!DAY_PATTERN.test(s)) return false;
      return sp.value.startsWith('--') ? s.slice(5) === sp.value.slice(2) : s === sp.value;
    }
    return false;
  });
}

function keywordSpans(text, keyword) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(keyword).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

function outboundGate({
  payloadText, recipients = [], envelope = null, facts = new Map(), mode = 'message', entitySpans = [], categoryKeywords = null
} = {}) {
  const text = String(payloadText ?? '');
  const factMap = facts instanceof Map ? facts : new Map();
  const all = [...factMap.values()];
  const refs = renderFactRefs(text, factMap, { envelope });
  const blocked = [...refs.blocked];
  const add = (span, reason, detail, factId = null) => blocked.push({
    span: { start: span.start, end: span.end, text: span.text }, reason, ...(factId ? { factId } : {}), detail
  });

  // Rules 1–4 read the text with reference spans blanked (offsets unchanged).
  let masked = text;
  for (const r of refs.refs) masked = masked.slice(0, r.start) + ' '.repeat(r.end - r.start) + masked.slice(r.end);
  const approved = envelope && APPROVED_STATUSES.has(envelope.status)
    ? foldText([envelope.intent, ...(envelope.rules || [])].join('\n'))
    : '';
  const isApproved = (spanText) => Boolean(approved) && approved.includes(foldText(spanText));

  // Rule 1: fact values, both modes.
  const hits = new Map();
  for (const f of all) {
    if (f.provenance === 'unknown' || f.status === 'retracted') continue;
    for (const sp of matchSpans(masked, valueMatchers(f.value, f.unit))) {
      const key = `${sp.start}:${sp.end}`;
      if (!hits.has(key)) hits.set(key, { span: sp, facts: [] });
      hits.get(key).facts.push(f);
    }
  }
  for (const { span, facts: matched } of hits.values()) {
    if (isRecipient(span.text, recipients)) continue;
    const live = matched.filter((f) => f.status === 'active');
    const open = live.filter((f) => RENDERABLE.has(f.provenance) && f.disclosable);
    if (open.length) {
      if (envelope && !open.some((f) => (envelope.facts || []).includes(f.id))) {
        add(span, 'not-in-envelope', `the value of ${open[0].id} is not in the approved envelope`, open[0].id);
      }
      continue;
    }
    const priv = live.find((f) => !f.disclosable && f.provenance !== 'inferred');
    if (priv) {
      add(span, 'non-disclosable', `the value of ${priv.id}, which is not disclosable`, priv.id);
      continue;
    }
    const inf = live.find((f) => f.provenance === 'inferred');
    if (inf) {
      add(span, 'inferred', `the value of ${inf.id}, which is inferred`, inf.id);
      continue;
    }
    const old = matched.find((f) => f.status === 'superseded');
    if (old) add(span, 'superseded', `the value of ${old.id}, superseded by ${old.supersededBy}`, old.id);
  }

  if (mode === 'message') {
    // Rule 2: category keywords while the case holds a private fact of that category.
    const keywords = categoryKeywords || EXECUTOR_SETTINGS_DEFAULTS.outbound.categoryKeywords;
    const categories = new Set(all
      .filter((f) => f.status === 'active' && !f.disclosable && SENSITIVE.includes(f.category))
      .map((f) => f.category));
    for (const cat of categories) {
      for (const kw of keywords[cat] || []) {
        const k = foldText(kw);
        if (!k || isApproved(k)) continue;
        for (const sp of keywordSpans(masked, k)) add(sp, 'category-keyword', `${cat} keyword "${kw}"`);
      }
    }

    // Rule 3: dates and prices need a backing fact or approved wording;
    // deadlines and commitments need a backed value in their own sentence.
    const backing = all.filter((f) => f.status === 'active' && f.disclosable && BACKING.has(f.provenance));
    const sentences = sentenceRanges(masked);
    const backedSentences = new Set();
    for (const r of refs.refs) {
      if (r.ok && BACKING.has(r.fact.provenance)) backedSentences.add(sentenceOf(sentences, r.start));
    }
    const spans = detect(masked);
    for (const sp of spans.filter((s) => s.kind === 'date' || s.kind === 'price')) {
      if (backing.some((f) => spanMatchesValue(sp, f.value)) || isApproved(sp.text)) {
        backedSentences.add(sp.sentence);
        continue;
      }
      add(sp, 'unsourced-constraint', `${sp.kind} "${sp.text}" is not backed by a user or sourced fact`);
    }
    for (const sp of spans.filter((s) => s.kind === 'deadline' || s.kind === 'commitment')) {
      if (backedSentences.has(sp.sentence) || isApproved(sp.text)) continue;
      add(sp, 'unsourced-constraint', `${sp.kind} "${sp.text}" has no backed value in its sentence`);
    }
  }

  // Rule 4: entity spans (C7), exempt when they name this send's recipient.
  for (const e of entitySpans || []) {
    const sp = e && e.span;
    if (!sp || !Number.isInteger(sp.start) || !Number.isInteger(sp.end)) continue;
    if (isRecipient(sp.text, recipients)) continue;
    add(sp, 'non-disclosable-entity', `${e.entity || 'entity'}: ${e.reason || 'not disclosable'}`);
  }

  blocked.sort((a, b) => a.span.start - b.span.start);
  return { ok: blocked.length === 0, blocked, rendered: refs.rendered };
}

// Every string leaf (never a key) of a payload through outboundGate.
// Senders send `rendered`, never the input.
function gateLeaves(payload, {
  recipients = [], envelope = null, facts = new Map(), mode = 'message', caseId = null, entityIndex = null, categoryKeywords = null
} = {}) {
  const blocked = [];
  const walk = (value, at) => {
    if (typeof value === 'string') {
      let entitySpans = [];
      if (entityIndex && typeof entityIndex.nonDisclosableSpans === 'function') {
        try {
          entitySpans = entityIndex.nonDisclosableSpans(value, { caseId }) || [];
        } catch (err) {
          blocked.push({
            path: at, span: { start: 0, end: value.length, text: value }, reason: 'non-disclosable-entity', detail: `the entity index failed: ${err.message}`
          });
        }
      }
      const r = outboundGate({ payloadText: value, recipients, envelope, facts, mode, entitySpans, categoryKeywords });
      for (const b of r.blocked) blocked.push({ path: at, ...b });
      return r.rendered;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${at}[${i}]`));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, at ? `${at}.${k}` : k);
      return out;
    }
    return value;
  };
  const rendered = walk(payload, '');
  return { ok: blocked.length === 0, blocked, rendered };
}

module.exports = { recommendationGate, findDuplicates, outboundGate, gateLeaves, renderFactRefs, GATE_REASONS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-outbound-gate.test.js tests/cases-gates.test.js tests/cases-tools.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/outbound.js src/cases/gates.js tests/cases-outbound-gate.test.js
git commit -m "feat(cases): outbound gate with fact references, value, keyword, constraint and entity rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Envelopes and signed grants (pure)

**Files:**
- Create: `src/cases/executors/envelope.js`
- Create: `src/cases/executors/signed.js`
- Test: `tests/cases-envelope.test.js`

**Interfaces:**
- Consumes: `canonicalize`, `sha256b64url` (`src/platform/jcs.js`); `sha256hex`, `writeJsonAtomic`, `readJsonSafe`, `localDate`, `countDays`, `pickTimeZone`, `DAY_PATTERN`, `valueText`, `roundUsd` (Task 1); `normalizeRecipient`, `recipientChannel` (Task 2); `gateLeaves` (Task 3).
- Produces:
  - `envelope.js`: `class EnvelopeStore(caseDir)` with `ids()`, `list()`, `get(id)`, `nextId()` (`env-01`, …, `env-123`), `write(env)`; `envelopeCore(env)`; `envelopeHash(core) → 'sha256:<hex>'`; `validateEnvelopeRequest(body, { entry, facts, deadline, casesTimeZone, defaultCountryCode, categoryKeywords, entityIndex, caseId }) → { ok: true, core, notBacked: [{ path, text, reason, detail }] } | { ok: false, error, blocked? }`; `renderEnvelopeQuestion(env, { facts, caseTitle, notBacked }) → text (≤ 2000 chars)`; `renderSignedSummary(core)`; `envelopeFit(env, payload, { facts, recipients, now, estimateUsd, gateBlocked, executorId }) → { fits, refusals: string[], deltas: [{ kind: 'recipient'|'fact'|'usd'|'contacts'|'attempts'|'window', value, text }] }`; `applyDeltas(env, deltas, { questionId, factId, at }) → env'`; `renderDeltaQuestion(env, deltas) → text`; `deltasEqual(a, b)`; `ENVELOPE_STATUSES`, `FITTABLE_STATUSES`.
  - `signed.js`: `approvalHelpers() → { envelopeAction, actionHash }` (F3's when present, else identical fallbacks); `signedAction(env, caseId, helpers?)`; `verifySignedGrant(env, { caseId, outcomes, auditLedger, auditScanEntries, helpers }) → { ok: true, via: 'memory'|'audit' } | { ok: false, error }`; `decodeSealed(sealed) → message | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-envelope.test.js`:

```js
// tests/cases-envelope.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EnvelopeStore, envelopeCore, envelopeHash, validateEnvelopeRequest, renderEnvelopeQuestion,
  envelopeFit, applyDeltas, renderDeltaQuestion, deltasEqual
} = require('../src/cases/executors/envelope');
const { verifySignedGrant, signedAction, approvalHelpers } = require('../src/cases/executors/signed');
const { windowInstants } = require('../src/cases/executors/util');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fact(id, over = {}) {
  return {
    id, stmt: over.stmt || `Fact ${id}`, subject: 'lot', attr: id, value: null, unit: null,
    provenance: 'sourced', category: null, disclosable: true, status: 'active', supersededBy: null, ...over
  };
}
const facts = (...list) => new Map(list.map((f) => [f.id, f]));
const ACRES = fact('f-0001', { value: 2.12, unit: 'acres', stmt: 'Lot size is 2.12 acres' });
const ZONING = fact('f-0003', { value: 'R-1', stmt: 'Zoned R-1' });
const GUESS = fact('f-0004', { value: 'owner may sell low', provenance: 'inferred', disclosable: false });
const FLOOR = fact('f-0005', { value: 1250000, unit: 'USD', provenance: 'user', category: 'financial', disclosable: false });
const PHONE_AGENT = {
  id: 'phone-agent', kind: 'external-agent', capabilities: ['call', 'voicemail'], authority: 'envelope',
  constraints: { contactsPerDay: 5, callingWindow: { tz: 'America/Chicago', start: '09:00', end: '17:00', weekdays: [1, 2, 3, 4, 5] } }
};
const request = (over = {}) => ({
  intent: 'Ask three brokers for a listing quote on the lot',
  recipients: { allow: ['+1 555 0100', '+15550101'] },
  facts: ['f-0001'],
  rules: ["Say the owner's first name only"],
  caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
  window: { start: '2026-10-26', end: '2026-10-30' },
  ...over
});
function activeEnvelope(over = {}) {
  const env = {
    id: 'env-01', version: 1, status: 'active', executor: 'phone-agent',
    intent: 'Ask three brokers for a listing quote on the lot',
    recipients: { allow: ['+15550100', '+15550101'], addRequiresApproval: true },
    facts: ['f-0001'], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
    window: { start: '2026-10-26', end: '2026-10-30', tz: 'America/Chicago' },
    usage: { usd: 0, contacts: [], attempts: {} }, payloads: [], deltas: [], grantedBy: null, ...over
  };
  env.hash = envelopeHash(envelopeCore(env));
  return env;
}
const MONDAY_NOON = new Date('2026-10-26T17:00:00Z');

describe('EnvelopeStore', () => {
  it('numbers envelopes by replay and lists them in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-env-'));
    dirs.push(dir);
    const store = new EnvelopeStore(dir);
    assert.strictEqual(store.nextId(), 'env-01');
    store.write(activeEnvelope({ id: 'env-09' }));
    store.write(activeEnvelope({ id: 'env-10' }));
    assert.strictEqual(store.nextId(), 'env-11');
    assert.deepStrictEqual(store.list().map((e) => e.id), ['env-09', 'env-10']);
    assert.strictEqual(store.get('../x'), null);
  });
});

describe('envelope hash', () => {
  it('covers the core only and is stable under key order', () => {
    const a = activeEnvelope();
    const b = activeEnvelope({ usage: { usd: 5, contacts: ['+15550100'], attempts: {} } });
    assert.strictEqual(a.hash, b.hash);
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
    assert.notStrictEqual(envelopeHash(envelopeCore({ ...a, caps: { ...a.caps, usd: 21 } })), a.hash);
  });
});

describe('validateEnvelopeRequest', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };

  it('normalizes recipients and takes the executor\'s zone by default', () => {
    const r = validateEnvelopeRequest(request(), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.core.recipients.allow, ['+15550100', '+15550101']);
    assert.strictEqual(r.core.window.tz, 'America/Chicago');
    assert.strictEqual(r.core.executor, 'phone-agent');
    const utc = validateEnvelopeRequest(request(), { ...ctx, entry: { ...PHONE_AGENT, constraints: {} } });
    assert.strictEqual(utc.core.window.tz, 'UTC');
  });

  it('refuses facts that may not leave, naming each', () => {
    const r = validateEnvelopeRequest(request({ facts: ['f-0001', 'f-0004', 'f-0005', 'f-0099'] }), ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /f-0004 is inferred/);
    assert.match(r.error, /f-0005 is not disclosable/);
    assert.match(r.error, /f-0099 does not exist/);
  });

  it('refuses an executor without authority, a window past the deadline, and caps over the daily limit', () => {
    assert.match(validateEnvelopeRequest(request(), { ...ctx, entry: { ...PHONE_AGENT, authority: 'none' } }).error, /does not take envelopes/);
    assert.match(validateEnvelopeRequest(request(), { ...ctx, deadline: '2026-10-28' }).error, /window ends 2026-10-30, after the deadline 2026-10-28/);
    assert.match(validateEnvelopeRequest(request({ caps: { usd: 20, contacts: 30, attemptsPerContact: 2 } }), ctx).error, /caps.contacts 30 is more than 5\/day × 5 window days/);
    assert.match(validateEnvelopeRequest(request({ recipients: { allow: ['555-0100'] } }), ctx).error, /E\.164/);
  });

  it('refuses intent text that pastes a private value', () => {
    const r = validateEnvelopeRequest(request({ intent: 'Tell them we will not go under 1,250,000' }), ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /non-disclosable f-0005/);
  });

  it('envelope intent with an invented date is flagged in the approval text', () => {
    const r = validateEnvelopeRequest(request({ intent: 'Tell brokers offers are due by Friday November 14' }), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.notBacked.map((n) => [n.path, n.text]), [['intent', 'due by'], ['intent', 'Friday November 14']]);
    const env = { id: 'env-02', ...r.core };
    const text = renderEnvelopeQuestion(env, { facts: ctx.facts, caseTitle: 'Lakeside lot', notBacked: r.notBacked });
    assert.match(text, /^Approve envelope env-02 for phone-agent in case "Lakeside lot"\?/);
    assert.match(text, /- f-0001: Lot size is 2\.12 acres = 2\.12 acres/);
    assert.match(text, /Not backed by a fact:\n- "due by" \(.*\)\n- "Friday November 14" \(.*\)/);
    assert.match(text, /Caps: \$20\.00 total, 3 contacts, 2 attempts per contact/);
  });
});

describe('envelopeFit', () => {
  const all = facts(ACRES, ZONING, GUESS);
  const fitOpts = (over = {}) => ({ facts: all, recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 2, executorId: 'phone-agent', ...over });

  it('fits a payload inside the envelope', () => {
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), { attemptsPerContact: 1 }, fitOpts()), { fits: true, refusals: [], deltas: [] });
  });

  it('names only the differences as deltas', () => {
    const r = envelopeFit(activeEnvelope(), { facts: ['f-0003'], attemptsPerContact: 1 }, fitOpts({ recipients: ['+15550100', '+15550102'] }));
    assert.deepStrictEqual(r.deltas.map((d) => d.text), ['adds recipient +15550102', 'discloses f-0003 "Zoned R-1"']);
    assert.strictEqual(r.fits, false);
  });

  it('refuses an inferred fact, a wrong executor and an envelope that is not approved', () => {
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), { facts: ['f-0004'] }, fitOpts()).refusals, ['f-0004 cannot be disclosed (inferred)']);
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), {}, fitOpts({ executorId: 'browser' })).refusals, ['envelope env-01 is for phone-agent, not browser']);
    assert.deepStrictEqual(envelopeFit(activeEnvelope({ status: 'requested' }), {}, fitOpts()).refusals, ['envelope env-01 is requested']);
  });

  it('counts the gate\'s not-in-envelope blocks as disclosures', () => {
    const r = envelopeFit(activeEnvelope(), {}, fitOpts({ gateBlocked: [{ reason: 'not-in-envelope', factId: 'f-0003' }] }));
    assert.deepStrictEqual(r.deltas.map((d) => d.kind), ['fact']);
  });

  it('raises the usd and contacts caps as deltas', () => {
    const env = activeEnvelope({ usage: { usd: 19, contacts: ['+15550100', '+15550101', '+15550103'], attempts: {} } });
    const r = envelopeFit(env, {}, fitOpts({ recipients: ['+15550101'], estimateUsd: 2 }));
    assert.deepStrictEqual(r.deltas.map((d) => [d.kind, d.value]), [['usd', 21]]);
    const more = envelopeFit(activeEnvelope({ caps: { usd: 20, contacts: 1, attemptsPerContact: 2 } }), {}, fitOpts({ recipients: ['+15550100', '+15550101'] }));
    assert.deepStrictEqual(more.deltas.map((d) => [d.kind, d.value]), [['contacts', 2]]);
  });

  it('attempts cap counts payload attempts', () => {
    const env = activeEnvelope({ usage: { usd: 0, contacts: ['+15550100'], attempts: { '+15550100': 1 } } });
    assert.deepStrictEqual(envelopeFit(env, { attemptsPerContact: 1 }, fitOpts()).deltas, []);
    const r = envelopeFit(env, { attemptsPerContact: 2 }, fitOpts());
    assert.deepStrictEqual(r.deltas.map((d) => [d.text, d.value]), [['raises attempts per contact', 3]]);
  });

  it('window is local calendar days across DST', () => {
    const env = activeEnvelope({ window: { start: '2026-10-30', end: '2026-11-01', tz: 'America/Chicago' } });
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T05:30:00Z') })).deltas, []);
    const late = envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T06:30:00Z') }));
    assert.deepStrictEqual(late.deltas.map((d) => d.text), ['extends window end to 2026-11-02']);
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ now: new Date('2026-10-30T04:30:00Z') })).refusals, ['envelope env-01 opens 2026-10-30']);
    assert.strictEqual(windowInstants('2026-10-30', '2026-11-01', 'America/Chicago').notAfter, '2026-11-02T05:59:59Z');
  });

  it('exhausted envelope takes a delta', () => {
    const env = activeEnvelope({ status: 'exhausted', caps: { usd: 20, contacts: 2, attemptsPerContact: 2 }, usage: { usd: 3, contacts: ['+15550100', '+15550101'], attempts: {} } });
    const r = envelopeFit(env, {}, fitOpts({ recipients: ['+15550100'], estimateUsd: 0 }));
    assert.deepStrictEqual(r.deltas.map((d) => [d.kind, d.value]), [['contacts', 3]]);
    const next = applyDeltas(env, r.deltas, { questionId: 'q-0003', factId: 'f-0010', at: '2026-10-26T17:05:00Z' });
    assert.deepStrictEqual([next.status, next.version, next.caps.contacts], ['active', 2, 3]);
    assert.notStrictEqual(next.hash, env.hash);
    assert.deepStrictEqual(next.deltas, [{ questionId: 'q-0003', deltas: r.deltas, at: '2026-10-26T17:05:00Z', factId: 'f-0010' }]);
    assert.strictEqual(env.status, 'exhausted', 'applyDeltas does not mutate its input');
  });

  it('renders a delta question naming only the differences and compares deltas canonically', () => {
    const deltas = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];
    const text = renderDeltaQuestion(activeEnvelope(), deltas);
    assert.match(text, /^Envelope env-01 \(phone-agent\) needs your approval for:\n- adds recipient \+15550102/);
    assert.strictEqual(deltasEqual(deltas, [{ text: 'adds recipient +15550102', value: '+15550102', kind: 'recipient' }]), true);
  });
});

describe('signed grants', () => {
  const env = activeEnvelope({
    status: 'active',
    grantedBy: { channel: 'phone', at: '2026-10-26T17:00:00Z', questionId: 'q-0002', evidence: { request_id: 'r-1', action_hash: 'forged' } }
  });
  const helpers = approvalHelpers();
  const hash = helpers.actionHash(signedAction(env, 'case-1', helpers));
  const sealed = (message) => ({ alg: 'ES256', kid: 'd-1', payload: Buffer.from(JSON.stringify(message)).toString('base64url'), sig: 'x' });
  const ledger = (entries, ok = true) => ({ verify: () => ({ ok }), tail: (n) => entries.slice(-n) });

  it('builds the F3 envelope action', () => {
    const action = signedAction(env, 'case-1', helpers);
    assert.deepStrictEqual([action.kind, action.name, action.params], ['envelope', 'phone-agent', { case_id: 'case-1', envelope_hash: env.hash }]);
  });

  it('signed grant file forgery', () => {
    const r = verifySignedGrant(env, { caseId: 'case-1', outcomes: [], auditLedger: ledger([]) });
    assert.deepStrictEqual(r, { ok: false, error: 'signed approval not found for this envelope; ask again' });
  });

  it('accepts an approve Outcome held in memory for the exact action', () => {
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }).via, 'memory');
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'deny', action_hash: hash }] }).ok, false);
  });

  it('accepts a verified audit ledger holding the request and its approval', () => {
    const entries = [
      { kind: 'approval.request', data: { job_id: null, envelope: sealed({ request_id: 'r-1', action_hash: hash }) } },
      { kind: 'approval.response', data: { request_id: 'r-1', decision: 'approve', device_id: 'd-1' } }
    ];
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries) }).via, 'audit');
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries, false) }).ok, false, 'a broken chain proves nothing');
    const otherHash = [{ ...entries[0], data: { envelope: sealed({ request_id: 'r-1', action_hash: 'other' }) } }, entries[1]];
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(otherHash) }).ok, false);
  });

  it('refuses a tampered envelope before anything else', () => {
    const tampered = { ...env, caps: { ...env.caps, usd: 500 } };
    assert.deepStrictEqual(verifySignedGrant(tampered, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }), {
      ok: false, error: 'envelope changed since approval; request it again'
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-envelope.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/envelope'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/envelope.js`:

```js
// src/cases/executors/envelope.js
// Envelopes (cases stage 3 spec §3.6): the owner approves one envelope
// (intent, recipients, facts, caps, window) instead of every message.
// Pure functions plus the file store; the flows live in envelope-ops.js.
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../../platform/jcs');
const {
  sha256hex, writeJsonAtomic, readJsonSafe, localDate, countDays, pickTimeZone, DAY_PATTERN, valueText, roundUsd
} = require('./util');
const { normalizeRecipient, recipientChannel } = require('./normalize');
const { gateLeaves } = require('../gates');

const ENVELOPE_STATUSES = Object.freeze(['requested', 'active', 'rejected', 'expired', 'exhausted', 'revoked', 'tampered']);
// Statuses a payload can be fitted against; expired and exhausted take a delta.
const FITTABLE_STATUSES = Object.freeze(['active', 'expired', 'exhausted']);
// Gate reasons that refuse an envelope request outright (spec §3.6).
const REQUEST_REFUSALS = new Set(['inferred', 'unknown', 'non-disclosable', 'non-disclosable-entity', 'superseded', 'bad-reference']);
const ID_RE = /^env-(\d{2,})$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

class EnvelopeStore {
  constructor(caseDir) {
    this.dir = path.join(caseDir, '.kl', 'envelopes');
  }

  _file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  ids() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => ID_RE.test(id))
      .sort((a, b) => Number(ID_RE.exec(a)[1]) - Number(ID_RE.exec(b)[1]));
  }

  list() {
    return this.ids().map((id) => this.get(id)).filter(Boolean);
  }

  get(id) {
    if (!ID_RE.test(String(id))) return null;
    return readJsonSafe(this._file(id), null);
  }

  nextId() {
    const max = this.ids().reduce((m, id) => Math.max(m, Number(ID_RE.exec(id)[1])), 0);
    return `env-${String(max + 1).padStart(2, '0')}`;
  }

  write(env) {
    writeJsonAtomic(this._file(env.id), env);
    return env;
  }
}

function envelopeCore(env) {
  return {
    intent: String(env.intent || ''),
    executor: String(env.executor || ''),
    recipients: { allow: [...(env.recipients?.allow || [])].map(String) },
    facts: [...(env.facts || [])].map(String),
    rules: [...(env.rules || [])].map(String),
    caps: {
      usd: Number(env.caps?.usd) || 0,
      contacts: Number(env.caps?.contacts) || 0,
      attemptsPerContact: Number(env.caps?.attemptsPerContact) || 0
    },
    window: { start: String(env.window?.start || ''), end: String(env.window?.end || ''), tz: String(env.window?.tz || '') }
  };
}

function envelopeHash(core) {
  return `sha256:${sha256hex(canonicalize(core))}`;
}

function validateEnvelopeRequest(body, {
  entry, facts = new Map(), deadline = null, casesTimeZone = '', defaultCountryCode = '', categoryKeywords = null, entityIndex = null, caseId = null
} = {}) {
  if (!entry) return { ok: false, error: 'Envelope refused: unknown executor.' };
  if (entry.authority === 'none') {
    return { ok: false, error: `Envelope refused: ${entry.id} does not take envelopes (authority none); submit its jobs directly.` };
  }
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const intent = typeof b.intent === 'string' ? b.intent.trim() : '';
  if (!intent || intent.length > 500) errors.push('"intent" must be 1 to 500 characters');
  if (b.executor !== undefined && b.executor !== entry.id) errors.push(`"executor" must be ${entry.id}`);
  const allow = Array.isArray(b.recipients?.allow) ? b.recipients.allow : null;
  if (!allow || !allow.length) errors.push('"recipients.allow" must list at least one address');
  const factIds = b.facts === undefined ? [] : (Array.isArray(b.facts) ? b.facts.map(String) : null);
  if (!factIds) errors.push('"facts" must be a list of fact ids');
  const rules = b.rules === undefined ? [] : (Array.isArray(b.rules) ? b.rules.map((r) => String(r).trim()).filter(Boolean) : null);
  if (!rules) errors.push('"rules" must be a list of strings');
  const caps = b.caps && typeof b.caps === 'object' ? b.caps : {};
  const usd = Number(caps.usd);
  const contacts = Number(caps.contacts);
  const attempts = Number(caps.attemptsPerContact);
  if (!Number.isFinite(usd) || usd < 0) errors.push('"caps.usd" must be a number ≥ 0');
  if (!Number.isInteger(contacts) || contacts < 1) errors.push('"caps.contacts" must be an integer ≥ 1');
  if (!Number.isInteger(attempts) || attempts < 1) errors.push('"caps.attemptsPerContact" must be an integer ≥ 1');
  const w = b.window && typeof b.window === 'object' ? b.window : {};
  if (!DAY_PATTERN.test(String(w.start)) || !DAY_PATTERN.test(String(w.end)) || String(w.end) < String(w.start)) {
    errors.push('"window" needs start and end dates (YYYY-MM-DD) with start ≤ end');
  }
  if (errors.length) return { ok: false, error: `Envelope refused: ${errors.join('; ')}.` };

  const channel = recipientChannel(entry.capabilities);
  const normalized = [];
  for (const address of allow) {
    const n = normalizeRecipient(address, { channel, defaultCountryCode });
    if (!n.ok) errors.push(n.error);
    else if (!normalized.includes(n.value)) normalized.push(n.value);
  }
  for (const id of factIds) {
    const f = facts.get(id);
    if (!f) errors.push(`${id} does not exist`);
    else if (f.status !== 'active') errors.push(`${id} is ${f.status}`);
    else if (f.provenance === 'inferred') errors.push(`${id} is inferred`);
    else if (f.provenance === 'unknown') errors.push(`${id} is an open unknown`);
    else if (!f.disclosable) errors.push(`${id} is not disclosable`);
  }
  const callingWindow = entry.constraints?.callingWindow || null;
  const tz = pickTimeZone(w.tz, callingWindow?.tz, casesTimeZone);
  const perDay = entry.constraints?.contactsPerDay;
  if (Number.isInteger(perDay)) {
    const days = countDays(w.start, w.end, Array.isArray(callingWindow?.weekdays) ? callingWindow.weekdays : ALL_WEEKDAYS);
    if (contacts > perDay * days) errors.push(`caps.contacts ${contacts} is more than ${perDay}/day × ${days} window days`);
  }
  if (deadline && String(w.end) > String(deadline)) errors.push(`window ends ${w.end}, after the deadline ${deadline}`);
  if (errors.length) return { ok: false, error: `Envelope refused: ${errors.join('; ')}.` };

  const core = {
    intent,
    executor: entry.id,
    recipients: { allow: normalized },
    facts: factIds,
    rules,
    caps: { usd, contacts, attemptsPerContact: attempts },
    window: { start: w.start, end: w.end, tz }
  };
  const gate = gateLeaves({ intent, rules }, {
    recipients: normalized, envelope: null, facts, mode: 'message', caseId, entityIndex, categoryKeywords
  });
  const refusals = gate.blocked.filter((x) => REQUEST_REFUSALS.has(x.reason));
  if (refusals.length) {
    return {
      ok: false,
      error: `Envelope refused by the outbound gate: ${refusals.map((x) => `${x.path} "${x.span.text}" (${x.reason}${x.factId ? ` ${x.factId}` : ''})`).join('; ')}.`,
      blocked: refusals
    };
  }
  // Model-written constraint wording becomes approved wording once the owner
  // approves, so the owner sees each span.
  const notBacked = gate.blocked
    .filter((x) => x.reason === 'unsourced-constraint' || x.reason === 'category-keyword')
    .map((x) => ({ path: x.path, text: x.span.text, reason: x.reason, detail: x.detail }));
  return { ok: true, core, notBacked };
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function cut(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderEnvelopeQuestion(env, { facts = new Map(), caseTitle = '', notBacked = [] } = {}) {
  const lines = [
    `Approve envelope ${env.id} for ${env.executor}${caseTitle ? ` in case "${caseTitle}"` : ''}?`,
    `Intent: ${env.intent}`,
    `Recipients: ${(env.recipients?.allow || []).join(', ')}`,
    'Facts it may disclose:'
  ];
  if (!(env.facts || []).length) lines.push('- none');
  for (const id of env.facts || []) {
    const f = facts.get(id);
    const value = f && f.value !== null && f.value !== undefined ? ` = ${valueText(f.value)}${f.unit ? ` ${f.unit}` : ''}` : '';
    lines.push(`- ${id}: ${f ? f.stmt : '(missing)'}${value}`);
  }
  if ((env.rules || []).length) lines.push('Rules:', ...env.rules.map((r) => `- ${r}`));
  lines.push(
    `Caps: ${money(env.caps.usd)} total, ${env.caps.contacts} contacts, ${env.caps.attemptsPerContact} attempts per contact`,
    `Window: ${env.window.start} to ${env.window.end} (${env.window.tz})`
  );
  if (notBacked.length) lines.push('Not backed by a fact:', ...notBacked.map((n) => `- "${n.text}" (${n.detail})`));
  return cut(lines.join('\n'));
}

// The phone shows this; F3 cuts it to 300 characters.
function renderSignedSummary(core) {
  return `${core.executor}: ${core.intent} (${core.recipients.allow.length} recipients, ${money(core.caps.usd)}, ${core.window.start} to ${core.window.end})`;
}

function envelopeFit(env, payload = {}, {
  facts = new Map(), recipients = [], now = new Date(), estimateUsd = 0, gateBlocked = [], executorId = null
} = {}) {
  const refusals = [];
  const deltas = [];
  const addDelta = (d) => {
    if (!deltas.some((x) => x.kind === d.kind && x.value === d.value)) deltas.push(d);
  };
  if (!env) return { fits: false, refusals: ['no envelope'], deltas };
  if (!FITTABLE_STATUSES.includes(env.status)) refusals.push(`envelope ${env.id} is ${env.status}`);
  if (executorId && env.executor !== executorId) refusals.push(`envelope ${env.id} is for ${env.executor}, not ${executorId}`);
  if (refusals.length) return { fits: false, refusals, deltas };

  const usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  for (const r of recipients) {
    if (!env.recipients.allow.includes(r)) addDelta({ kind: 'recipient', value: r, text: `adds recipient ${r}` });
  }
  const declared = [
    ...(Array.isArray(payload.facts) ? payload.facts.map(String) : []),
    ...gateBlocked.filter((x) => x.reason === 'not-in-envelope' && x.factId).map((x) => x.factId)
  ];
  for (const id of [...new Set(declared)]) {
    if (env.facts.includes(id)) continue;
    const f = facts.get(id);
    let why = null;
    if (!f) why = 'missing';
    else if (f.status !== 'active') why = f.status;
    else if (f.provenance === 'inferred') why = 'inferred';
    else if (f.provenance === 'unknown') why = 'unknown';
    else if (!f.disclosable) why = 'not disclosable';
    if (why) {
      refusals.push(`${id} cannot be disclosed (${why})`);
      continue;
    }
    addDelta({ kind: 'fact', value: id, text: `discloses ${id} "${f.stmt}"` });
  }
  const needUsd = roundUsd(Number(usage.usd || 0) + (Number(estimateUsd) || 0));
  if (needUsd > env.caps.usd) addDelta({ kind: 'usd', value: needUsd, text: 'raises usd cap' });
  const distinct = new Set([...(usage.contacts || []), ...recipients]);
  if (distinct.size > env.caps.contacts) addDelta({ kind: 'contacts', value: distinct.size, text: 'raises contacts cap' });
  const per = Number(payload.attemptsPerContact) || 1;
  const attempts = recipients.map((r) => (Number(usage.attempts?.[r]) || 0) + per);
  const maxAttempts = attempts.length ? Math.max(...attempts) : 0;
  if (maxAttempts > env.caps.attemptsPerContact) addDelta({ kind: 'attempts', value: maxAttempts, text: 'raises attempts per contact' });
  const today = localDate(now, env.window.tz);
  if (today < env.window.start) refusals.push(`envelope ${env.id} opens ${env.window.start}`);
  else if (today > env.window.end) addDelta({ kind: 'window', value: today, text: `extends window end to ${today}` });
  if (env.status === 'exhausted' && !deltas.some((d) => d.kind === 'usd' || d.kind === 'contacts' || d.kind === 'attempts')) {
    if ((usage.contacts || []).length >= env.caps.contacts) {
      addDelta({ kind: 'contacts', value: env.caps.contacts + Math.max(1, recipients.length), text: 'raises contacts cap' });
    } else {
      addDelta({ kind: 'usd', value: roundUsd(Math.max(needUsd, env.caps.usd) + 1), text: 'raises usd cap' });
    }
  }
  return { fits: refusals.length === 0 && deltas.length === 0, refusals, deltas };
}

function applyDeltas(env, deltas, { questionId = null, factId = null, at = new Date().toISOString() } = {}) {
  const next = JSON.parse(JSON.stringify(env));
  for (const d of deltas) {
    if (d.kind === 'recipient' && !next.recipients.allow.includes(d.value)) next.recipients.allow.push(d.value);
    else if (d.kind === 'fact' && !next.facts.includes(d.value)) next.facts.push(d.value);
    else if (d.kind === 'usd') next.caps.usd = Math.max(Number(next.caps.usd) || 0, Number(d.value) || 0);
    else if (d.kind === 'contacts') next.caps.contacts = Math.max(Number(next.caps.contacts) || 0, Number(d.value) || 0);
    else if (d.kind === 'attempts') next.caps.attemptsPerContact = Math.max(Number(next.caps.attemptsPerContact) || 0, Number(d.value) || 0);
    else if (d.kind === 'window' && String(d.value) > next.window.end) next.window.end = String(d.value);
  }
  next.version = (Number(next.version) || 1) + 1;
  next.hash = envelopeHash(envelopeCore(next));
  next.status = 'active';
  next.deltas = [...(next.deltas || []), { questionId, deltas, at, factId }];
  return next;
}

function renderDeltaQuestion(env, deltas) {
  return cut([
    `Envelope ${env.id} (${env.executor}) needs your approval for:`,
    ...deltas.map((d) => `- ${d.text}`),
    `Intent: ${env.intent}`
  ].join('\n'));
}

function deltasEqual(a, b) {
  return canonicalize(a || []) === canonicalize(b || []);
}

module.exports = {
  ENVELOPE_STATUSES,
  FITTABLE_STATUSES,
  EnvelopeStore,
  envelopeCore,
  envelopeHash,
  validateEnvelopeRequest,
  renderEnvelopeQuestion,
  renderSignedSummary,
  envelopeFit,
  applyDeltas,
  renderDeltaQuestion,
  deltasEqual
};
```

Create `src/cases/executors/signed.js`:

```js
// src/cases/executors/signed.js
// authority: signed (cases stage 3 spec §3.6). The envelope file is never
// trusted: a grant is proven by an approve Outcome held in memory or by the
// hash-chained audit ledger (F3 §4.16).
const { canonicalize, sha256b64url } = require('../../platform/jcs');
const { envelopeCore, envelopeHash, renderSignedSummary } = require('./envelope');

const SUMMARY_MAX = 300;

function loadApprovalMessages() {
  try {
    return require('../../approvals/messages');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('approvals')) return null;
    throw err;
  }
}

// Identical to F3's envelopeAction (program §4.12) for nodes without F3.
function fallbackEnvelopeAction({ executorId, caseId, envelopeHash: hash, summary }) {
  const chars = Array.from(String(summary || `Run ${executorId} for case ${caseId}`));
  const text = chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : chars.join('');
  return { kind: 'envelope', name: String(executorId), params: { case_id: String(caseId), envelope_hash: String(hash) }, summary: text };
}

function approvalHelpers(messages = loadApprovalMessages()) {
  return {
    envelopeAction: typeof messages?.envelopeAction === 'function' ? messages.envelopeAction : fallbackEnvelopeAction,
    actionHash: typeof messages?.actionHash === 'function' ? messages.actionHash : (action) => sha256b64url(canonicalize(action))
  };
}

// The action for the live envelope: its hash is recomputed from the core.
function signedAction(env, caseId, helpers = approvalHelpers()) {
  const core = envelopeCore(env);
  return helpers.envelopeAction({ executorId: env.executor, caseId, envelopeHash: envelopeHash(core), summary: renderSignedSummary(core) });
}

function decodeSealed(sealed) {
  try {
    return JSON.parse(Buffer.from(String(sealed?.payload || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function verifySignedGrant(env, { caseId, outcomes = [], auditLedger = null, auditScanEntries = 5000, helpers = null } = {}) {
  const h = helpers || approvalHelpers();
  if (envelopeHash(envelopeCore(env)) !== env.hash) {
    return { ok: false, error: 'envelope changed since approval; request it again' };
  }
  const hash = h.actionHash(signedAction(env, caseId, h));
  if ((outcomes || []).some((o) => o && o.decision === 'approve' && o.action_hash === hash)) return { ok: true, via: 'memory' };
  const requestId = env.grantedBy?.evidence?.request_id;
  if (auditLedger && requestId) {
    let verified = null;
    try {
      verified = auditLedger.verify();
    } catch {
      verified = null;
    }
    if (verified && verified.ok === true) {
      const entries = auditLedger.tail(auditScanEntries) || [];
      const approved = entries.some((e) => e.kind === 'approval.response' && e.data?.request_id === requestId && e.data?.decision === 'approve');
      const requested = entries.some((e) => {
        if (e.kind !== 'approval.request') return false;
        const m = decodeSealed(e.data?.envelope);
        return Boolean(m) && m.request_id === requestId && m.action_hash === hash;
      });
      if (approved && requested) return { ok: true, via: 'audit' };
    }
  }
  return { ok: false, error: 'signed approval not found for this envelope; ask again' };
}

module.exports = { approvalHelpers, signedAction, verifySignedGrant, decodeSealed, fallbackEnvelopeAction };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-envelope.test.js tests/cases-outbound-gate.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/envelope.js src/cases/executors/signed.js tests/cases-envelope.test.js
git commit -m "feat(cases): envelopes, fit and deltas, and signed-grant verification

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Plan checks, card and store (pure)

**Files:**
- Create: `src/cases/executors/plan.js`
- Test: `tests/cases-plan.test.js`

**Interfaces:**
- Consumes: `readJsonSafe`, `writeJsonAtomic`, `localDate`, `countDays`, `roundUsd`, `DAY_PATTERN` (Task 1).
- Produces: `parseSteps(text) → { ok, steps } | { ok: false, error }` (spec §3.4 `Step`; unknown fields, including `agentId`, are refused); `stepsToTaskGraph(steps) → { tasks }` (`agentId: 'main'`); `capable(entry, capability)`; `isConsentBacked(entry, facts, questions)`; `checkPlan({ steps, entries, brief, facts, questions, budget: { remainingUsd, contactsPerDayLimit, deadline }, globalRemaining(id), now, tz, attemptsDefault }) → { steps, warnings, estimateUsd, consentCapabilities }` where each step gains `state: 'pending'`, `jobIds: []`, `check: { status: 'ok'|'rewritten'|'flagged'|'needs-consent', from?, reasons, estimateUsd, days: { needed, available } | null, consent: 'none'|'required'|'recorded:<factId>' }`; `renderPlanCard(plan) → markdown`; `class PlanStore(caseDir)` with `read()`, `write(plan)`, `archive(plan)`, `nextId()` (`plan-001`), `updateStep(stepId, { state, addJob, note, reason })` (sets the plan `done` when every step is `done`/`cancelled`); `STEP_UNITS`, `STEP_STATES`, `PLAN_STATUSES`, `LATENCY_ORDER`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-plan.test.js`:

```js
// tests/cases-plan.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseSteps, stepsToTaskGraph, checkPlan, renderPlanCard, PlanStore
} = require('../src/cases/executors/plan');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const OUTBOUND = ['call', 'sms', 'email', 'web-form', 'postal-mail', 'pay', 'sign'];
const BROWSER = {
  id: 'browser', kind: 'tool', available: true, capabilities: ['web-browse', 'web-form', 'web-login'],
  cannot: OUTBOUND.filter((c) => c !== 'web-form'), constraints: {}, cost: {}, latency: 'interactive'
};
const OWNER = { id: 'owner', kind: 'owner', available: true, capabilities: ['any'], cannot: [], constraints: {}, cost: {}, latency: 'async-days' };
const PHONE = {
  id: 'phone-agent', kind: 'external-agent', available: true, capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'],
  constraints: { contactsPerDay: 5, callingWindow: { tz: 'UTC', start: '09:00', end: '17:00', weekdays: [1, 2, 3, 4, 5] } },
  cost: { perJob: 1, perContact: 0.5, perAttempt: 0.25 }, latency: 'async-hours'
};
const MONDAY = new Date('2026-10-26T15:00:00Z');
const step = (over = {}) => ({
  id: 's1', title: 'File nine permit forms', description: 'File the county permit forms', dependsOn: [], priority: 1,
  estimatedComplexity: 'medium', executor: 'owner', capability: 'web-form', serves: 'permit filings', quantity: 9, unit: 'forms', ...over
});
const answered = (id, factId, payload, optionId = 'approve') => ({ id, payload, answer: { channel: 'in-app', optionId, factId } });
const userFact = (id, questionId) => ({ id, provenance: 'user', status: 'active', source: { kind: 'question', ref: questionId } });
const check = (over = {}) => checkPlan({
  steps: [step()], entries: [BROWSER, OWNER, PHONE], brief: {}, facts: new Map(), questions: [],
  budget: {}, globalRemaining: () => null, now: MONDAY, tz: 'UTC', attemptsDefault: 2, ...over
});

describe('parseSteps', () => {
  it('parses JSON text and fills defaults', () => {
    const r = parseSteps(JSON.stringify([{ id: 's1', title: 'Call brokers', executor: 'phone-agent', capability: 'call' }]));
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.steps[0], {
      id: 's1', title: 'Call brokers', description: 'Call brokers', dependsOn: [], priority: 1, estimatedComplexity: 'medium',
      executor: 'phone-agent', capability: 'call', serves: '', quantity: 1, unit: 'items'
    });
    assert.strictEqual(parseSteps(JSON.stringify({ steps: [step()] })).ok, true);
  });

  it('refuses unknown fields, agentId included, and bad values', () => {
    const r = parseSteps(JSON.stringify([{ ...step(), agentId: 'main', unit: 'boxes', quantity: 0 }]));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /step s1 has unknown field "agentId"/);
    assert.match(r.error, /quantity must be a whole number ≥ 1/);
    assert.match(r.error, /unit must be one of items, contacts, forms, pages/);
    assert.match(parseSteps('[').error, /"steps" is not valid JSON/);
    assert.match(parseSteps('[]').error, /non-empty list/);
  });

  it('maps steps to a planner task graph with agentId main', () => {
    const { tasks } = stepsToTaskGraph([step({ dependsOn: [] })]);
    assert.deepStrictEqual([tasks[0].id, tasks[0].agentId, tasks[0].description], ['s1', 'main', 'File the county permit forms']);
  });
});

describe('checkPlan', () => {
  it('estimates a capable step', () => {
    const r = check({ steps: [step({ executor: 'phone-agent', capability: 'call', quantity: 10, unit: 'contacts' })] });
    assert.deepStrictEqual([r.steps[0].check.status, r.steps[0].check.estimateUsd, r.estimateUsd], ['ok', 11, 11]);
    assert.strictEqual(r.steps[0].state, 'pending');
    assert.deepStrictEqual(r.steps[0].jobIds, []);
  });

  it('rewrites an owner step the owner has not agreed to', () => {
    const r = check();
    assert.deepStrictEqual(r.steps[0].executor, 'browser');
    assert.deepStrictEqual(r.steps[0].check, {
      status: 'rewritten', from: 'owner', reasons: ['owner has not consented to web-form'], estimateUsd: 0, days: null, consent: 'none'
    });
    assert.deepStrictEqual(r.consentCapabilities, []);
  });

  it('leaves the owner step needing consent when nothing else can do it', () => {
    const r = check({ entries: [{ ...BROWSER, available: false, reason: 'disabled for this case' }, OWNER, PHONE] });
    assert.deepStrictEqual([r.steps[0].executor, r.steps[0].check.status, r.steps[0].check.consent], ['owner', 'needs-consent', 'required']);
    assert.deepStrictEqual(r.consentCapabilities, ['web-form']);
  });

  it('keeps an owner step backed by the owner\'s plan approval or owner-task answer', () => {
    const planQ = answered('q-0003', 'f-0007', { type: 'plan', consentCapabilities: ['web-form'] });
    const r = check({
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0007' }] } },
      facts: new Map([['f-0007', userFact('f-0007', 'q-0003')]]),
      questions: [planQ]
    });
    assert.deepStrictEqual([r.steps[0].executor, r.steps[0].check.status, r.steps[0].check.consent], ['owner', 'ok', 'recorded:f-0007']);
    const taskQ = answered('q-0004', 'f-0008', { type: 'owner-task', capability: 'web-form' }, null);
    const t = check({
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0008' }] } },
      facts: new Map([['f-0008', userFact('f-0008', 'q-0004')]]),
      questions: [taskQ]
    });
    assert.strictEqual(t.steps[0].check.consent, 'recorded:f-0008');
  });

  it('ignores an ownerLabor entry that no owner answer backs', () => {
    const r = check({
      entries: [{ ...BROWSER, available: false, reason: 'disabled for this case' }, OWNER],
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0009' }] } },
      facts: new Map([['f-0009', { id: 'f-0009', provenance: 'user', status: 'active', source: { kind: 'user-message', ref: 'turn-1' } }]])
    });
    assert.deepStrictEqual(r.warnings, ['ownerLabor entry 1 is not backed by an owner answer; ignored']);
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
  });

  it('flags contact steps that cannot finish before the deadline', () => {
    const calls = step({ executor: 'phone-agent', capability: 'call', quantity: 30, unit: 'contacts' });
    const r = check({ steps: [calls], brief: { deadline: '2026-10-29' }, budget: { contactsPerDayLimit: 20 }, globalRemaining: () => 5 });
    assert.deepStrictEqual(r.steps[0].check.status, 'flagged');
    assert.deepStrictEqual(r.steps[0].check.reasons, ['needs 6 days at 5/day; 4 available before 2026-10-29']);
    assert.deepStrictEqual(r.steps[0].check.days, { needed: 6, available: 4 });
    assert.strictEqual(check({ steps: [calls] }).steps[0].check.status, 'ok', 'no deadline, feasible');
  });

  it('warns when the estimate exceeds the remaining budget', () => {
    const r = check({ steps: [step({ executor: 'phone-agent', capability: 'call', quantity: 10, unit: 'contacts' })], budget: { remainingUsd: 5 } });
    assert.deepStrictEqual(r.warnings, ['estimate $11.00 exceeds remaining $5.00']);
  });

  it('rewrites only within brief.resources.executors, never to the owner, cheapest first', () => {
    const r = check({ brief: { resources: { executors: ['phone-agent'] } } });
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
    const pricey = { ...BROWSER, id: 'forms-pro', cost: { perJob: 3 } };
    const unknown = check({ steps: [step({ executor: 'fax-bot' })], entries: [pricey, BROWSER, OWNER] });
    assert.deepStrictEqual([unknown.steps[0].executor, unknown.steps[0].check.reasons], ['browser', ['fax-bot is not a known executor']]);
    const flagged = check({ steps: [step({ executor: 'phone-agent', capability: 'postal-mail' })] });
    assert.deepStrictEqual([flagged.steps[0].check.status, flagged.steps[0].check.reasons], ['flagged', ['phone-agent cannot do postal-mail']]);
  });
});

describe('renderPlanCard', () => {
  it('renders the table, totals and one line per rewrite and warning', () => {
    const r = check({ budget: { remainingUsd: -1 } });
    const card = renderPlanCard({ id: 'plan-002', goal: 'Get the permits', steps: r.steps, estimateUsd: r.estimateUsd, warnings: r.warnings });
    const lines = card.split('\n');
    assert.strictEqual(lines[0], 'Plan plan-002: Get the permits');
    assert.strictEqual(lines[2], '| # | Step | Executor | Capability | Qty | Est. cost | Days (need/avail) | Consent | Check |');
    assert.strictEqual(lines[4], '| s1 | File nine permit forms | browser | web-form | 9 forms | $0.00 | — | none | rewritten |');
    assert.strictEqual(lines[5], '|  | **Total** |  |  |  | $0.00 |  |  |  |');
    assert.ok(card.includes('- s1 rewritten from owner to browser: owner has not consented to web-form'));
    assert.ok(card.includes('- Warning: estimate $0.00 exceeds remaining $-1.00'));
  });
});

describe('PlanStore', () => {
  it('numbers plans, archives superseded ones and closes a finished plan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    assert.strictEqual(store.nextId(), 'plan-001');
    store.write({ id: 'plan-001', status: 'superseded', steps: [] });
    store.archive(store.read());
    store.write({
      id: 'plan-002', status: 'approved',
      steps: [{ id: 's1', state: 'pending', jobIds: [] }, { id: 's2', state: 'cancelled', jobIds: [] }]
    });
    assert.strictEqual(store.nextId(), 'plan-003');
    store.updateStep('s1', { state: 'in-flight', addJob: 'job-0001' });
    assert.deepStrictEqual(store.read().steps[0], { id: 's1', state: 'in-flight', jobIds: ['job-0001'] });
    const done = store.updateStep('s1', { state: 'done', note: 'filed' });
    assert.deepStrictEqual([done.status, done.steps[0].note], ['done', 'filed']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-plan.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/plan'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/plan.js`:

```js
// src/cases/executors/plan.js
// Executor-first planning (cases stage 3 spec §3.4): every plan step names
// an executor and code checks it. A step the executor cannot do moves to one
// that can; no step lands on the owner without the owner's answer (R41).
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic, localDate, countDays, roundUsd, DAY_PATTERN } = require('./util');

const STEP_UNITS = Object.freeze(['items', 'contacts', 'forms', 'pages']);
const STEP_STATES = Object.freeze(['pending', 'in-flight', 'done', 'failed', 'cancelled']);
const PLAN_STATUSES = Object.freeze(['proposed', 'approved', 'rejected', 'superseded', 'done']);
const LATENCY_ORDER = Object.freeze(['interactive', 'async-minutes', 'async-hours', 'async-days']);
const STEP_FIELDS = new Set(['id', 'title', 'description', 'dependsOn', 'priority', 'estimatedComplexity', 'executor', 'capability', 'serves', 'quantity', 'unit']);
const EXECUTOR_ID = /^[a-z][a-z0-9-]{1,39}$/;
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PLAN_ID = /^plan-(\d{3,})$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function parseSteps(text) {
  let raw = text;
  if (typeof text === 'string') {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `"steps" is not valid JSON: ${err.message}` };
    }
  }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.steps)) raw = raw.steps;
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: '"steps" must be JSON text of a non-empty list of steps.' };
  const steps = [];
  const errors = [];
  raw.forEach((s, i) => {
    const label = s && typeof s.id === 'string' && s.id ? s.id : `#${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`step ${label} is not an object`);
      return;
    }
    for (const k of Object.keys(s)) if (!STEP_FIELDS.has(k)) errors.push(`step ${label} has unknown field "${k}"`);
    if (typeof s.id !== 'string' || !STEP_ID.test(s.id)) errors.push(`step ${label} needs an id of 1 to 40 letters, digits, - or _`);
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) errors.push(`step ${label} needs a title`);
    if (typeof s.executor !== 'string' || !EXECUTOR_ID.test(s.executor)) errors.push(`step ${label} needs an executor id`);
    if (typeof s.capability !== 'string' || !s.capability.trim()) errors.push(`step ${label} needs a capability`);
    const quantity = s.quantity === undefined ? 1 : s.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) errors.push(`step ${label}: quantity must be a whole number ≥ 1`);
    const unit = s.unit === undefined ? 'items' : s.unit;
    if (!STEP_UNITS.includes(unit)) errors.push(`step ${label}: unit must be one of ${STEP_UNITS.join(', ')}`);
    if (s.dependsOn !== undefined && (!Array.isArray(s.dependsOn) || !s.dependsOn.every((d) => typeof d === 'string'))) {
      errors.push(`step ${label}: dependsOn must be a list of step ids`);
    }
    steps.push({
      id: s.id,
      title,
      description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : title,
      dependsOn: Array.isArray(s.dependsOn) ? [...s.dependsOn] : [],
      priority: Number.isFinite(s.priority) ? s.priority : i + 1,
      estimatedComplexity: typeof s.estimatedComplexity === 'string' ? s.estimatedComplexity : 'medium',
      executor: s.executor,
      capability: typeof s.capability === 'string' ? s.capability.trim() : '',
      serves: typeof s.serves === 'string' ? s.serves.trim() : '',
      quantity,
      unit
    });
  });
  if (errors.length) return { ok: false, error: `Plan refused: ${errors.join('; ')}.` };
  return { ok: true, steps };
}

function stepsToTaskGraph(steps) {
  return {
    tasks: steps.map((s) => ({
      id: s.id, title: s.title, description: s.description, dependsOn: s.dependsOn,
      priority: s.priority, estimatedComplexity: s.estimatedComplexity, agentId: 'main'
    }))
  };
}

function capable(entry, capability) {
  return Boolean(entry)
    && entry.available !== false
    && (entry.capabilities || []).some((c) => c === capability || c === 'any')
    && !(entry.cannot || []).includes(capability);
}

// Consent (R41): an ownerLabor entry counts only when its fact is an active
// `user` fact written by answering a plan (approve) or owner-task question
// that names the capability.
function isConsentBacked(entry, facts, questions) {
  if (!entry || typeof entry !== 'object' || typeof entry.capability !== 'string') return false;
  const f = facts.get(entry.factId);
  if (!f || f.status !== 'active' || f.provenance !== 'user' || f.source?.kind !== 'question') return false;
  const q = (questions || []).find((x) => x.id === f.source.ref);
  if (!q || !q.answer || q.answer.factId !== f.id) return false;
  const p = q.payload || {};
  if (p.type === 'plan') {
    return q.answer.optionId === 'approve' && Array.isArray(p.consentCapabilities) && p.consentCapabilities.includes(entry.capability);
  }
  if (p.type === 'owner-task') return p.capability === entry.capability;
  return false;
}

function checkPlan({
  steps, entries, brief = {}, facts = new Map(), questions = [], budget = {}, globalRemaining = () => null,
  now = new Date(), tz = 'UTC', attemptsDefault = 2
}) {
  const byId = entries instanceof Map ? entries : new Map((entries || []).map((e) => [e.id, e]));
  const warnings = [];
  const labor = Array.isArray(brief?.resources?.ownerLabor) ? brief.resources.ownerLabor : [];
  labor.forEach((e, i) => {
    if (!isConsentBacked(e, facts, questions)) warnings.push(`ownerLabor entry ${i + 1} is not backed by an owner answer; ignored`);
  });
  const consentFor = (cap) => {
    const e = labor.find((x) => x && x.capability === cap && isConsentBacked(x, facts, questions));
    return e ? e.factId : null;
  };
  const listed = Array.isArray(brief?.resources?.executors) ? brief.resources.executors : [];
  const allowed = listed.length ? new Set(listed) : null;
  const deadline = (DAY_PATTERN.test(String(brief?.deadline || '')) ? brief.deadline : null) || budget.deadline || null;
  const today = localDate(now, tz);

  const feasibility = (entry, step) => {
    if (step.unit !== 'contacts' || !entry) return { ok: true, days: null };
    const limits = [entry.constraints?.contactsPerDay, budget.contactsPerDayLimit, globalRemaining(entry.id)]
      .filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (!limits.length || !deadline) return { ok: true, days: null };
    const perDay = Math.min(...limits);
    const weekdays = Array.isArray(entry.constraints?.callingWindow?.weekdays) ? entry.constraints.callingWindow.weekdays : ALL_WEEKDAYS;
    const available = countDays(today, deadline, weekdays);
    if (perDay <= 0) {
      return { ok: false, days: { needed: null, available }, reason: `no contacts left per day (0/day); ${available} available before ${deadline}` };
    }
    const needed = Math.ceil(step.quantity / perDay);
    if (needed > available) {
      return { ok: false, days: { needed, available }, reason: `needs ${needed} days at ${perDay}/day; ${available} available before ${deadline}` };
    }
    return { ok: true, days: { needed, available } };
  };
  const estimate = (entry, step) => {
    const c = entry?.cost || {};
    return roundUsd((Number(c.perJob) || 0) + step.quantity * ((Number(c.perContact) || 0) + (Number(c.perAttempt) || 0) * attemptsDefault));
  };
  const rank = (e) => {
    const i = LATENCY_ORDER.indexOf(e.latency);
    return i === -1 ? LATENCY_ORDER.length : i;
  };

  const checked = steps.map((step) => {
    const entry = byId.get(step.executor);
    const reasons = [];
    let consent = 'none';
    let ok = true;
    if (step.executor === 'owner') {
      const factId = consentFor(step.capability);
      if (factId) consent = `recorded:${factId}`;
      else {
        ok = false;
        consent = 'required';
        reasons.push(`owner has not consented to ${step.capability}`);
      }
    } else if (!capable(entry, step.capability)) {
      ok = false;
      if (!entry) reasons.push(`${step.executor} is not a known executor`);
      else if (entry.available === false) reasons.push(`${step.executor} is unavailable: ${entry.reason}`);
      else reasons.push(`${step.executor} cannot do ${step.capability}`);
    }
    if (ok) {
      const feas = feasibility(entry, step);
      if (!feas.ok) reasons.push(feas.reason);
      return {
        ...step, state: 'pending', jobIds: [],
        check: { status: feas.ok ? 'ok' : 'flagged', reasons, estimateUsd: estimate(entry, step), days: feas.days, consent }
      };
    }
    const pick = [...byId.values()]
      .filter((e) => e.id !== 'owner' && e.id !== step.executor && (!allowed || allowed.has(e.id))
        && capable(e, step.capability) && feasibility(e, step).ok)
      .sort((a, b) => estimate(a, step) - estimate(b, step) || rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
    if (pick) {
      return {
        ...step, executor: pick.id, state: 'pending', jobIds: [],
        check: { status: 'rewritten', from: step.executor, reasons, estimateUsd: estimate(pick, step), days: feasibility(pick, step).days, consent: 'none' }
      };
    }
    return {
      ...step, state: 'pending', jobIds: [],
      check: { status: step.executor === 'owner' ? 'needs-consent' : 'flagged', reasons, estimateUsd: estimate(entry, step), days: null, consent }
    };
  });
  const estimateUsd = roundUsd(checked.reduce((sum, s) => sum + s.check.estimateUsd, 0));
  if (typeof budget.remainingUsd === 'number' && Number.isFinite(budget.remainingUsd) && estimateUsd > budget.remainingUsd) {
    warnings.push(`estimate $${estimateUsd.toFixed(2)} exceeds remaining $${budget.remainingUsd.toFixed(2)}`);
  }
  const consentCapabilities = [...new Set(checked.filter((s) => s.check.status === 'needs-consent').map((s) => s.capability))];
  return { steps: checked, warnings, estimateUsd, consentCapabilities };
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const cell = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function renderPlanCard(plan) {
  const rows = [
    `Plan ${plan.id}: ${plan.goal || plan.summary || ''}`.trim(),
    '',
    '| # | Step | Executor | Capability | Qty | Est. cost | Days (need/avail) | Consent | Check |',
    '|---|---|---|---|---|---|---|---|---|',
    ...(plan.steps || []).map((s) => {
      const days = s.check?.days ? `${s.check.days.needed ?? '—'}/${s.check.days.available}` : '—';
      return `| ${s.id} | ${cell(s.title)} | ${s.executor} | ${s.capability} | ${s.quantity} ${s.unit} | ${money(s.check?.estimateUsd)} | ${days} | ${s.check?.consent || 'none'} | ${s.check?.status || 'ok'} |`;
    }),
    `|  | **Total** |  |  |  | ${money(plan.estimateUsd)} |  |  |  |`
  ];
  const notes = [];
  for (const s of plan.steps || []) {
    const why = (s.check?.reasons || []).join('; ');
    if (s.check?.status === 'rewritten') notes.push(`- ${s.id} rewritten from ${s.check.from} to ${s.executor}: ${why}`);
    else if (s.check?.status === 'flagged') notes.push(`- ${s.id} flagged: ${why}`);
    else if (s.check?.status === 'needs-consent') notes.push(`- ${s.id} needs the owner's consent: ${why}`);
  }
  for (const w of plan.warnings || []) notes.push(`- Warning: ${w}`);
  return [...rows, ...(notes.length ? ['', ...notes] : [])].join('\n');
}

class PlanStore {
  constructor(caseDir) {
    this.file = path.join(caseDir, '.kl', 'plan.json');
    this.archiveDir = path.join(caseDir, '.kl', 'plans');
  }

  read() {
    return readJsonSafe(this.file, null);
  }

  write(plan) {
    writeJsonAtomic(this.file, plan);
    return plan;
  }

  archive(plan) {
    writeJsonAtomic(path.join(this.archiveDir, `${plan.id}.json`), plan);
  }

  nextId() {
    let max = 0;
    const current = this.read();
    const m = current && PLAN_ID.exec(String(current.id));
    if (m) max = Number(m[1]);
    let names = [];
    try {
      names = fs.readdirSync(this.archiveDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const n of names) {
      const mm = PLAN_ID.exec(n.replace(/\.json$/, ''));
      if (mm) max = Math.max(max, Number(mm[1]));
    }
    return `plan-${String(max + 1).padStart(3, '0')}`;
  }

  updateStep(stepId, { state, addJob, note, reason } = {}) {
    const plan = this.read();
    if (!plan) return null;
    const step = (plan.steps || []).find((s) => s.id === stepId);
    if (!step) return plan;
    if (!Array.isArray(step.jobIds)) step.jobIds = [];
    if (addJob && !step.jobIds.includes(addJob)) step.jobIds.push(addJob);
    if (state) step.state = state;
    if (note !== undefined) step.note = note;
    if (reason !== undefined) step.reason = reason;
    if (plan.status === 'approved' && plan.steps.every((s) => s.state === 'done' || s.state === 'cancelled')) plan.status = 'done';
    this.write(plan);
    return plan;
  }
}

module.exports = {
  STEP_UNITS,
  STEP_STATES,
  PLAN_STATUSES,
  LATENCY_ORDER,
  parseSteps,
  stepsToTaskGraph,
  capable,
  isConsentBacked,
  checkPlan,
  renderPlanCard,
  PlanStore
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-plan.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/plan.js tests/cases-plan.test.js
git commit -m "feat(cases): plan step checks, owner consent, feasibility, card and store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 1 hand-off

When Tasks 1–5 are merged, run:

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})" | grep -vE "example\.(com|org)"`
Expected: no output (fixtures use only `example.com`/`example.org` addresses, `Lakeside lot`, `+15550100`).

Part 2 (`docs/superpowers/plans/2026-09-23-cases-stage3-executors-part2.md`) depends on these exports existing exactly as named:

| Module | Exports |
|---|---|
| `src/platform/jcs.js` | `canonicalize`, `sha256b64url`, `JcsError` |
| `src/cases/executors/util.js` | `DAY_PATTERN`, `sha256hex`, `validTimeZone`, `hostTimeZone`, `pickTimeZone`, `localDate`, `addDays`, `weekdayOf`, `countDays`, `isoSeconds`, `windowInstants`, `writeJsonAtomic`, `readJsonSafe`, `parseJsonObject`, `valueText`, `roundUsd` |
| `src/cases/executors/defaults.js` | `EXECUTOR_SETTINGS_DEFAULTS`, `mergeExecutorSettings`, `resolveExecutorSettings` |
| `src/cases/executors/normalize.js` | `MONTH_NAMES`, `escapeRe`, `foldText`, `normalizeRecipient`, `recipientChannel`, `valueMatchers`, `matchSpans`, `isRecipient`, `valueKey` |
| `src/cases/outbound.js` | `detect`, `sentenceRanges`, `sentenceOf` |
| `src/cases/gates.js` | adds `outboundGate`, `gateLeaves`, `renderFactRefs`, `GATE_REASONS` (keeps `recommendationGate`, `findDuplicates`) |
| `src/cases/executors/envelope.js` | `ENVELOPE_STATUSES`, `FITTABLE_STATUSES`, `EnvelopeStore`, `envelopeCore`, `envelopeHash`, `validateEnvelopeRequest`, `renderEnvelopeQuestion`, `renderSignedSummary`, `envelopeFit`, `applyDeltas`, `renderDeltaQuestion`, `deltasEqual` |
| `src/cases/executors/signed.js` | `approvalHelpers`, `signedAction`, `verifySignedGrant`, `decodeSealed`, `fallbackEnvelopeAction` |
| `src/cases/executors/plan.js` | `STEP_UNITS`, `STEP_STATES`, `PLAN_STATUSES`, `LATENCY_ORDER`, `parseSteps`, `stepsToTaskGraph`, `capable`, `isConsentBacked`, `checkPlan`, `renderPlanCard`, `PlanStore` |
