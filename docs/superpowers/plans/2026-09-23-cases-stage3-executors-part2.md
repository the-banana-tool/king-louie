# Cases Stage 3: Executors — Implementation Plan (Part 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give King Louie an executor registry with pinned external-agent packages, the reference `phone-agent` adapter for a generic HTTP errands API, the job lifecycle (commit, poll, charge, snapshot, cancel) and the envelope, plan and turn-start flows.
**Architecture:** `ExecutorRegistry` (`src/cases/executors/registry.js`) resolves built-ins, configured entries, per-case overrides and the R42 floors, loads adapters through `package-loader.js` (six load checks), keeps the global daily cap and the jobs index under an `AsyncMutex`, and exposes the lifecycle in `jobs.js` and the flows in `envelope-ops.js`, `plan-ops.js` and `turn-hook.js`. Part 3 adds submit, results, the tools and the wiring.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Node's global `fetch`, `node:http` (test server only). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage3-executors.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.
**Depends on:** Part 1 (`docs/superpowers/plans/2026-09-23-cases-stage3-executors-part1.md`) merged; its exports are listed in its hand-off. C2 merged.

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

### Task 6: Built-in executors and the package loader

**Files:**
- Create: `src/cases/executors/builtins.js`
- Create: `src/cases/executors/package-loader.js`
- Modify: `src/skills/skill-loader.js` (the `discoverSkills` loop body and the last line)
- Test: `tests/cases-executor-package.test.js`

**Interfaces:**
- Consumes: `sha256hex` (Task 1); `assertAdminOwned(file, geteuid, adminUid)` (`src/service/config.js`, a no-op on win32); `createLogger` (`src/logging.js`).
- Produces:
  - `builtins.js`: `OUTBOUND_CAPABILITIES`, `CAPABILITIES`, `KINDS`, `LATENCIES`, `AUTHORITIES`, `OUTBOUND_MODES`, `STATE_MODES`, `ID_PATTERN`, `BUILTIN_IDS` (`bash, files, web, browser, workflow, runbook, owner`), `DIRECT_TOOLS` (`bash → 'Bash'`, `files → 'Read, Write'`, `web → 'WebSearch, WebFetch'`), `builtinEntry(id) → Entry | null` (a fresh copy each call).
  - `package-loader.js`: `ExecutorUnavailableError(id, reason)` (`code: 'EXECUTOR_UNAVAILABLE'`, `executorId`, `reason`); `computePackageSha256(dir) → hex`; `readManifest(dir)`; `checkPackage({ id, entry, dir, roots, isService, assertRoot, vault }) → { ok, error, dir, manifest, pkg, computed, mainPath?, config? }` (load checks 1–5); `resolveConfig(schema, config, vault)`; `makeHostFetch({ origins, config, requestTimeoutMs, fetchImpl })`; `loadAdapter(checked, { id, entry, requestTimeoutMs, fetchImpl, now }) → Promise<{ adapter, capabilities }>` (load check 6); `ADAPTER_FUNCTIONS`.
  - `skill-loader.js`: `SkillLoader.prototype.discoverSkills` skips executor packages; `module.exports.isExecutorPackage(dir)`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-executor-package.test.js`:

```js
// tests/cases-executor-package.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ExecutorUnavailableError, computePackageSha256, checkPackage, loadAdapter, makeHostFetch
} = require('../src/cases/executors/package-loader');
const { builtinEntry, BUILTIN_IDS, OUTBOUND_CAPABILITIES, DIRECT_TOOLS } = require('../src/cases/executors/builtins');
const SkillLoader = require('../src/skills/skill-loader');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-exec-pkg-'));
  dirs.push(d);
  return d;
}

const ADAPTER = `module.exports.createAdapter = (config, host) => ({
  capabilities: () => ({ capabilities: ['call'], cannot: [], constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' }),
  submit: async () => ({ jobId: 'x' }),
  status: async () => ({ state: 'running', contacts: [] }),
  results: async () => ({ records: [] }),
  cancel: async () => ({ state: 'cancelled' }),
  briefRules: () => ['Say who you are calling for.'],
  config,
  host
});
`;

function writePackage(root, name, { manifest = {}, pkg = {}, adapter = ADAPTER } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `kl-executor-${name}`, version: '1.0.0', main: 'adapter.js',
    kingLouie: {
      executor: {
        apiVersion: 1, id: name, kind: 'external-agent', capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'],
        configSchema: { baseUrl: { type: 'string', required: true }, token: { type: 'string', secret: true, required: true } },
        payloadSchema: { venue: { type: 'string' } }, origins: ['config:baseUrl'], ...manifest
      }
    },
    ...pkg
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'adapter.js'), adapter);
  return dir;
}
const vault = { get: (k) => (k === 'errands-token' ? 'tok-test' : null) };
const entryFor = (dir, over = {}) => ({
  packageSha256: computePackageSha256(dir),
  config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' },
  ...over
});

describe('built-in executors', () => {
  it('matches the spec table', () => {
    assert.deepStrictEqual([...BUILTIN_IDS], ['bash', 'files', 'web', 'browser', 'workflow', 'runbook', 'owner']);
    const pick = (id) => {
      const e = builtinEntry(id);
      return [e.kind, e.direct, e.outbound, e.authority, e.latency];
    };
    assert.deepStrictEqual(pick('bash'), ['tool', true, 'none', 'none', 'interactive']);
    assert.deepStrictEqual(pick('web'), ['tool', true, 'query', 'none', 'interactive']);
    assert.deepStrictEqual(pick('browser'), ['tool', false, 'message', 'envelope', 'interactive']);
    assert.deepStrictEqual(pick('workflow'), ['tool', false, 'query', 'none', 'async-minutes']);
    assert.deepStrictEqual(pick('runbook'), ['runbook', false, 'none', 'none', 'async-minutes']);
    assert.deepStrictEqual(pick('owner'), ['owner', false, 'none', 'none', 'async-days']);
  });

  it('lists the outbound capabilities each non-owner built-in lacks', () => {
    assert.deepStrictEqual(builtinEntry('bash').cannot, [...OUTBOUND_CAPABILITIES]);
    assert.deepStrictEqual(builtinEntry('browser').cannot, ['call', 'sms', 'email', 'postal-mail', 'pay', 'sign']);
    assert.deepStrictEqual(builtinEntry('owner').cannot, []);
    assert.strictEqual(builtinEntry('phone-agent'), null);
    assert.notStrictEqual(builtinEntry('bash'), builtinEntry('bash'), 'a fresh copy each call');
    assert.strictEqual(DIRECT_TOOLS.web, 'WebSearch, WebFetch');
  });
});

describe('package pin', () => {
  it('hashes every file outside node_modules and changes with any file', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const a = computePackageSha256(dir);
    assert.match(a, /^[0-9a-f]{64}$/);
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    assert.strictEqual(computePackageSha256(dir), a);
    fs.appendFileSync(path.join(dir, 'adapter.js'), '\n// changed\n');
    assert.notStrictEqual(computePackageSha256(dir), a);
  });
});

describe('checkPackage', () => {
  it('passes a well-formed pinned package and resolves secrets from the vault', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const r = checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault });
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.config, { baseUrl: 'https://errands.example.com', token: 'tok-test' });
  });

  it('check 1: apiVersion and id', () => {
    const root = tmp();
    const v2 = writePackage(root, 'phone-x', { manifest: { apiVersion: 2 } });
    assert.match(checkPackage({ id: 'phone-x', entry: entryFor(v2), dir: v2, roots: [root], vault }).error, /apiVersion must be 1/);
    const other = writePackage(root, 'phone-y', { manifest: { id: 'phone-z' } });
    assert.strictEqual(checkPackage({ id: 'phone-y', entry: entryFor(other), dir: other, roots: [root], vault }).error, 'manifest id "phone-z" does not match entry id "phone-y"');
  });

  it('check 2: main must stay inside the package', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'outside.js'), ADAPTER);
    const dir = writePackage(root, 'phone-x', { pkg: { main: '../outside.js' } });
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault }).error, 'main resolves outside the package');
  });

  it('check 3: the package must sit under a root, admin-owned in service mode', () => {
    const root = tmp();
    const elsewhere = tmp();
    const dir = writePackage(elsewhere, 'phone-x');
    assert.match(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault }).error, /outside the executor roots/);
    const inRoot = writePackage(root, 'phone-x');
    const refused = checkPackage({
      id: 'phone-x', entry: entryFor(inRoot), dir: inRoot, roots: [root], vault, isService: true,
      assertRoot: () => { throw new Error('Refusing to read the executor root: it is owned by the service account'); }
    });
    assert.strictEqual(refused.error, 'Refusing to read the executor root: it is owned by the service account');
  });

  it('check 4: the pin is required and must match', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const computed = computePackageSha256(dir);
    const missing = checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: null }), dir, roots: [root], vault });
    assert.strictEqual(missing.error, `pin required: set packageSha256 to ${computed}`);
    assert.strictEqual(missing.computed, computed);
    const wrong = checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: 'a'.repeat(64) }), dir, roots: [root], vault });
    assert.strictEqual(wrong.error, `package changed: expected ${'a'.repeat(64)}, found ${computed}`);
  });

  it('check 5: secrets are vault references to existing keys; config matches the schema', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const run = (config) => checkPackage({ id: 'phone-x', entry: entryFor(dir, { config }), dir, roots: [root], vault }).error;
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: 'tok-plain' }), 'store token in the vault and reference it as ${vault:<key>}');
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: '${vault:missing}' }), 'vault key "missing" for token does not exist');
    assert.strictEqual(run({ token: '${vault:errands-token}' }), 'config field "baseUrl" is required');
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: '${vault:errands-token}', extra: 1 }), 'config field "extra" is not in the package\'s configSchema');
  });
});

describe('loadAdapter', () => {
  it('check 6: returns the adapter with a host that has no vault and fetches only its origins', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const checked = checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault });
    const { adapter, capabilities } = await loadAdapter(checked, { id: 'phone-x', entry: { capabilities: ['call', 'voicemail'] } });
    assert.deepStrictEqual(capabilities.capabilities, ['call']);
    assert.deepStrictEqual(Object.keys(adapter.host).sort(), ['fetch', 'id', 'log', 'now']);
    assert.strictEqual(adapter.config.token, 'tok-test');
    await assert.rejects(adapter.host.fetch('https://elsewhere.example.com/x'), /outside this executor's origins/);
  });

  it('refuses an adapter missing a function or claiming extra capabilities', async () => {
    const root = tmp();
    const partial = writePackage(root, 'phone-x', { adapter: 'module.exports.createAdapter = () => ({ capabilities: () => ({ capabilities: [] }) });' });
    const checked = checkPackage({ id: 'phone-x', entry: entryFor(partial), dir: partial, roots: [root], vault });
    await assert.rejects(loadAdapter(checked, { id: 'phone-x', entry: {} }), (err) => (
      err instanceof ExecutorUnavailableError && err.code === 'EXECUTOR_UNAVAILABLE' && /missing submit, status, results, cancel, briefRules/.test(err.message)
    ));
    const greedy = writePackage(root, 'phone-y', { adapter: ADAPTER.replace("capabilities: ['call']", "capabilities: ['call', 'pay']") });
    const checkedGreedy = checkPackage({ id: 'phone-y', entry: entryFor(greedy), dir: greedy, roots: [root], vault });
    await assert.rejects(loadAdapter(checkedGreedy, { id: 'phone-y', entry: {} }), /outside its manifest or entry: pay/);
  });
});

describe('makeHostFetch', () => {
  it('passes allowed origins through with a timeout and no redirects', async () => {
    const calls = [];
    const fetch = makeHostFetch({
      origins: ['config:baseUrl', 'https://status.example.com'],
      config: { baseUrl: 'https://errands.example.com/api' },
      requestTimeoutMs: 1000,
      fetchImpl: async (url, init) => { calls.push([url, init.redirect, init.signal instanceof AbortSignal]); return { ok: true }; }
    });
    await fetch('https://errands.example.com/jobs');
    await fetch('https://status.example.com/ping');
    assert.deepStrictEqual(calls, [['https://errands.example.com/jobs', 'error', true], ['https://status.example.com/ping', 'error', true]]);
    await assert.rejects(fetch('http://errands.example.com/jobs'), /outside this executor's origins/);
  });
});

describe('skill loader', () => {
  it('does not treat an executor package as a skill', () => {
    const root = tmp();
    writePackage(root, 'phone-x');
    fs.mkdirSync(path.join(root, 'notes-skill'));
    fs.writeFileSync(path.join(root, 'notes-skill', 'package.json'), JSON.stringify({ name: 'notes-skill', main: 'index.js' }));
    const loader = new SkillLoader({ skillsDirectory: root, userDataPath: root });
    assert.deepStrictEqual(loader.discoverSkills().map((d) => path.basename(d)), ['notes-skill']);
    assert.strictEqual(SkillLoader.isExecutorPackage(path.join(root, 'phone-x')), true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-executor-package.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/package-loader'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/builtins.js`:

```js
// src/cases/executors/builtins.js
// The built-in executors (cases stage 3 spec §3.1). phone-agent is not
// built in: it is the reference package the owner installs.

const OUTBOUND_CAPABILITIES = Object.freeze(['call', 'sms', 'email', 'web-form', 'postal-mail', 'pay', 'sign']);
const CAPABILITIES = Object.freeze([
  'shell', 'read-files', 'write-files', 'search', 'fetch', 'web-browse', 'web-form', 'web-login', 'fan-out-research',
  'runbook', 'call', 'voicemail', 'sms', 'email', 'postal-mail', 'in-person', 'sign', 'pay', 'any'
]);
const KINDS = Object.freeze(['tool', 'external-agent', 'runbook', 'owner']);
const LATENCIES = Object.freeze(['interactive', 'async-minutes', 'async-hours', 'async-days']);
const AUTHORITIES = Object.freeze(['none', 'envelope', 'signed']);
const OUTBOUND_MODES = Object.freeze(['none', 'query', 'message']);
const STATE_MODES = Object.freeze(['poll', 'webhook', 'none']);
const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
// What a direct executor's work is done with (Executor.submit refuses them).
const DIRECT_TOOLS = Object.freeze({ bash: 'Bash', files: 'Read, Write', web: 'WebSearch, WebFetch' });

const row = (id, kind, capabilities, { direct, outbound, authority, latency, state }) => Object.freeze({
  id, kind, capabilities: Object.freeze(capabilities), direct, outbound, authority, latency, state
});

const TABLE = Object.freeze([
  row('bash', 'tool', ['shell', 'read-files', 'write-files'], { direct: true, outbound: 'none', authority: 'none', latency: 'interactive', state: 'none' }),
  row('files', 'tool', ['read-files', 'write-files'], { direct: true, outbound: 'none', authority: 'none', latency: 'interactive', state: 'none' }),
  row('web', 'tool', ['search', 'fetch'], { direct: true, outbound: 'query', authority: 'none', latency: 'interactive', state: 'none' }),
  row('browser', 'tool', ['web-browse', 'web-form', 'web-login'], { direct: false, outbound: 'message', authority: 'envelope', latency: 'interactive', state: 'none' }),
  row('workflow', 'tool', ['fan-out-research'], { direct: false, outbound: 'query', authority: 'none', latency: 'async-minutes', state: 'poll' }),
  row('runbook', 'runbook', ['runbook'], { direct: false, outbound: 'none', authority: 'none', latency: 'async-minutes', state: 'poll' }),
  row('owner', 'owner', ['any'], { direct: false, outbound: 'none', authority: 'none', latency: 'async-days', state: 'poll' })
]);

const BUILTIN_IDS = Object.freeze(TABLE.map((r) => r.id));

function builtinEntry(id) {
  const r = TABLE.find((x) => x.id === id);
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    builtin: true,
    package: null,
    capabilities: [...r.capabilities],
    cannot: r.kind === 'owner' ? [] : OUTBOUND_CAPABILITIES.filter((c) => !r.capabilities.includes(c)),
    constraints: {},
    cost: {},
    latency: r.latency,
    state: r.state,
    authority: r.authority,
    direct: r.direct,
    outbound: r.outbound,
    pollEveryMs: null,
    packageSha256: null
  };
}

module.exports = {
  OUTBOUND_CAPABILITIES,
  CAPABILITIES,
  KINDS,
  LATENCIES,
  AUTHORITIES,
  OUTBOUND_MODES,
  STATE_MODES,
  ID_PATTERN,
  DIRECT_TOOLS,
  BUILTIN_IDS,
  builtinEntry
};
```

Create `src/cases/executors/package-loader.js`:

```js
// src/cases/executors/package-loader.js
// Executor packages (cases stage 3 spec §3.2): the skill-package layout plus
// a kingLouie.executor block. Load checks 1–6 decide availability. There is
// no sandbox: the protections are the load root, the required pin and no
// Skill exposure (the adapter runs with full privileges once loaded).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
// Requiring the skill loader installs the king-louie/* aliases packages use.
require('../../skills/skill-loader');
const { assertAdminOwned } = require('../../service/config');
const { sha256hex } = require('./util');

const VAULT_REF = /^\$\{vault:([A-Za-z0-9._-]+)\}$/;
const ADAPTER_FUNCTIONS = Object.freeze(['capabilities', 'submit', 'status', 'results', 'cancel', 'briefRules']);

class ExecutorUnavailableError extends Error {
  constructor(id, reason) {
    super(`${id} is unavailable: ${reason}`);
    this.name = 'ExecutorUnavailableError';
    this.code = 'EXECUTOR_UNAVAILABLE';
    this.executorId = id;
    this.reason = reason;
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) out.push({ rel, digest: sha256hex(`link:${fs.readlinkSync(full)}`) });
    else if (st.isDirectory()) out.push(...listFiles(full, base));
    else if (st.isFile()) out.push({ rel, digest: sha256hex(fs.readFileSync(full)) });
  }
  return out;
}

// SHA-256 over the sorted `relative-path\0sha256(file)\n` lines of every
// file outside node_modules/ (spec §3.2, check 4).
function computePackageSha256(dir) {
  const lines = listFiles(dir)
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => `${f.rel}\0${f.digest}\n`);
  return sha256hex(lines.join(''));
}

function readManifest(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'no package.json in the package' : `package.json is not valid JSON: ${err.message}` };
  }
  const manifest = pkg?.kingLouie?.executor;
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'package.json has no kingLouie.executor block', pkg };
  return { ok: true, pkg, manifest };
}

function realOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveConfig(schema = {}, config = {}, vault = null) {
  const out = {};
  for (const key of Object.keys(config || {})) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) return { ok: false, error: `config field "${key}" is not in the package's configSchema` };
  }
  for (const [field, spec] of Object.entries(schema)) {
    const raw = config ? config[field] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (spec && spec.required) return { ok: false, error: `config field "${field}" is required` };
      continue;
    }
    if (spec && spec.secret) {
      const ref = typeof raw === 'string' ? VAULT_REF.exec(raw) : null;
      if (!ref) return { ok: false, error: `store ${field} in the vault and reference it as \${vault:<key>}` };
      const value = vault && typeof vault.get === 'function' ? vault.get(ref[1]) : null;
      if (value === null || value === undefined || value === '') return { ok: false, error: `vault key "${ref[1]}" for ${field} does not exist` };
      out[field] = value;
      continue;
    }
    const type = (spec && spec.type) || 'string';
    if (typeof raw !== type) return { ok: false, error: `config field "${field}" must be a ${type}` };
    out[field] = raw;
  }
  return { ok: true, config: out };
}

const defaultAssertRoot = (root) => assertAdminOwned(root, () => (typeof process.geteuid === 'function' ? process.geteuid() : -1));

// Checks 1–5. The resolved config is a copy and is never written anywhere.
function checkPackage({ id, entry = {}, dir, roots = [], isService = false, assertRoot = null, vault = null }) {
  const base = { ok: false, error: null, dir, manifest: null, pkg: null, computed: null };
  const m = readManifest(dir);
  if (!m.ok) return { ...base, error: m.error };
  const result = { ...base, manifest: m.manifest, pkg: m.pkg };
  const fail = (error) => ({ ...result, ok: false, error });

  if (m.manifest.apiVersion !== 1) return fail(`manifest apiVersion must be 1 (found ${JSON.stringify(m.manifest.apiVersion)})`);
  if (m.manifest.id !== id) return fail(`manifest id "${m.manifest.id}" does not match entry id "${id}"`);

  const realDir = realOrNull(dir);
  const main = m.pkg.main || 'index.js';
  const realMain = realOrNull(path.resolve(dir, main));
  if (!realDir || !realMain) return fail(`main ${main} was not found`);
  if (!inside(realMain, realDir)) return fail('main resolves outside the package');

  const root = roots.map(realOrNull).filter(Boolean).find((r) => inside(realDir, r));
  if (!root) {
    return fail(`the package is outside the executor roots (${isService ? 'service.json executors.packageRoots' : 'the executors folder of the data directory'})`);
  }
  if (isService) {
    try {
      (assertRoot || defaultAssertRoot)(root);
    } catch (err) {
      return fail(err.message);
    }
  }

  result.computed = computePackageSha256(realDir);
  if (!entry.packageSha256) return fail(`pin required: set packageSha256 to ${result.computed}`);
  if (entry.packageSha256 !== result.computed) return fail(`package changed: expected ${entry.packageSha256}, found ${result.computed}`);

  const cfg = resolveConfig(m.manifest.configSchema || {}, entry.config || {}, vault);
  if (!cfg.ok) return fail(cfg.error);
  return { ...result, ok: true, error: null, mainPath: realMain, config: cfg.config };
}

function originOf(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// The adapter's only network path: its manifest origins, a timeout, no
// redirects. (It can still reach the network directly; see Trust, §3.2.)
function makeHostFetch({ origins = [], config = {}, requestTimeoutMs = 20000, fetchImpl = null } = {}) {
  const allowed = new Set(origins
    .map((o) => (String(o).startsWith('config:') ? originOf(config[String(o).slice(7)]) : originOf(o)))
    .filter(Boolean));
  const doFetch = fetchImpl || globalThis.fetch;
  return async (url, init = {}) => {
    const target = originOf(url);
    if (!target || !allowed.has(target)) throw new Error(`${url} is outside this executor's origins`);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return doFetch(String(url), { ...init, signal, redirect: 'error' });
  };
}

// Check 6: createAdapter returns all six functions and its capabilities are
// within the manifest's and the entry's.
async function loadAdapter(checked, { id, entry = {}, requestTimeoutMs = 20000, fetchImpl = null, now = () => new Date() }) {
  let mod;
  try {
    // A re-pinned package must load its new code, not the cached module.
    delete require.cache[checked.mainPath];
    mod = require(checked.mainPath);
  } catch (err) {
    throw new ExecutorUnavailableError(id, `main failed to load: ${err.message}`);
  }
  if (typeof mod?.createAdapter !== 'function') throw new ExecutorUnavailableError(id, 'main does not export createAdapter');
  const host = Object.freeze({
    id,
    log: createLogger('executor').child(id),
    fetch: makeHostFetch({ origins: checked.manifest.origins || [], config: checked.config, requestTimeoutMs, fetchImpl }),
    now
  });
  let adapter;
  try {
    adapter = await mod.createAdapter({ ...checked.config }, host);
  } catch (err) {
    throw new ExecutorUnavailableError(id, `createAdapter failed: ${err.message}`);
  }
  const missing = ADAPTER_FUNCTIONS.filter((fn) => typeof adapter?.[fn] !== 'function');
  if (missing.length) throw new ExecutorUnavailableError(id, `the adapter is missing ${missing.join(', ')}`);
  const capabilities = await adapter.capabilities();
  const manifestCaps = checked.manifest.capabilities || [];
  const entryCaps = Array.isArray(entry.capabilities) && entry.capabilities.length ? entry.capabilities : manifestCaps;
  const extra = (capabilities?.capabilities || []).filter((c) => !manifestCaps.includes(c) || !entryCaps.includes(c));
  if (extra.length) throw new ExecutorUnavailableError(id, `the adapter claims capabilities outside its manifest or entry: ${extra.join(', ')}`);
  return { adapter, capabilities };
}

module.exports = {
  ADAPTER_FUNCTIONS,
  ExecutorUnavailableError,
  computePackageSha256,
  readManifest,
  resolveConfig,
  checkPackage,
  makeHostFetch,
  loadAdapter
};
```

In `src/skills/skill-loader.js`, replace

```js
      for (const entry of entries) {
        if ((entry.isDirectory() || entry.isSymbolicLink()) && !seen.has(entry.name)) {
          seen.add(entry.name);
          skillDirs.push(path.join(dir, entry.name));
        }
      }
```

with

```js
      for (const entry of entries) {
        if ((entry.isDirectory() || entry.isSymbolicLink()) && !seen.has(entry.name)) {
          // Executor packages use the skill layout but are not skills: the
          // Skill tool must not reach them (cases stage 3, ruling 16).
          if (isExecutorPackage(path.join(dir, entry.name))) {
            log.info(`Skipping executor package ${entry.name}: executors are not skills`);
            continue;
          }
          seen.add(entry.name);
          skillDirs.push(path.join(dir, entry.name));
        }
      }
```

In `src/skills/skill-loader.js`, replace

```js
const isPlainObject = (value) => {
```

with

```js
function isExecutorPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Boolean(pkg && pkg.kingLouie && pkg.kingLouie.executor);
  } catch {
    return false;
  }
}

const isPlainObject = (value) => {
```

In `src/skills/skill-loader.js`, replace

```js
module.exports = SkillLoader;
```

with

```js
module.exports = SkillLoader;
module.exports.isExecutorPackage = isExecutorPackage;
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-executor-package.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

Run: `node --test tests/*skill*.test.js`
Expected: PASS, `# fail 0` (the existing skill tests are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/builtins.js src/cases/executors/package-loader.js src/skills/skill-loader.js tests/cases-executor-package.test.js
git commit -m "feat(cases): built-in executors and the pinned executor package loader

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The executor registry, job store and global daily cap

**Files:**
- Create: `src/cases/executors/job-store.js`
- Create: `src/cases/executors/registry.js`
- Create: `src/cases/executors/index.js`
- Create: `tests/helpers/executor-fixtures.js`
- Test: `tests/cases-executor-registry.test.js`

**Interfaces:**
- Consumes: `builtinEntry`, `BUILTIN_IDS`, `OUTBOUND_CAPABILITIES`, `ID_PATTERN`, `LATENCIES`, `STATE_MODES`, `checkPackage`, `loadAdapter`, `ExecutorUnavailableError`, `computePackageSha256` (Task 6); `resolveExecutorSettings` (Task 1); `readJsonSafe`, `writeJsonAtomic`, `localDate`, `pickTimeZone`, `addDays` (Task 1); `EnvelopeStore` (Task 4); `PlanStore` (Task 5); `normalizeRecipient` (Task 2); `AsyncMutex` (`src/workflows/async-mutex.js`, `run(key, fn)`); C2 `CaseRuntime({ root, getSettings, now, host })`, `createCase`, `getCase`, `brief(id).update`, `completeGating`, `beginTurn`, `caseContext`.
- Produces:
  - `job-store.js`: `OPEN_STATES`, `TERMINAL_STATES`, `isOpen(state)`, `class JobStore(caseDir)` (`ids`, `list`, `get`, `nextId` → `job-0001`, `create(fields)`, `write(job)`, `update(id, patch)`), `readSnapshot(caseDir) → object`, `writeSnapshot(caseDir, snapshot) → changed`.
  - `registry.js`: `class ExecutorRegistry({ dataDir, getSettings, adminExecutors, isService, vault, caseRuntime, getWorkflowEngine, getRunbookEngine, getPhoneApprover, getAuditLedger, usageTracker, now, packageRoot, assertRoot, fetchImpl, browserActions })` with `settings()`, `casesTimeZone()`, `getUsageTracker()`, `ids()`, `list({ caseId })` (never throws), `get(id, { caseId })`, `adapter(id) → Promise<adapter>` (cached; `ExecutorUnavailableError`), `briefRules(id, { caseId })`, `registerExtraBriefRules(fn)`, `reserveContacts(id, n, { caseId }) → Promise<{ ok, used, limit, day, error? }>`, `releaseContacts(id, n, { caseId }) → Promise<{ ok, released }>`, `globalRemaining(id) → number | null`, `caseDir(caseId)`, `jobs(caseId) → JobStore`, `indexJob(caseId, job) → Promise`, `liveState({ caseId }) → [{ jobId, executorId, signature, state, caseId, intent, recipients }]`, and the instance maps `signedOutcomes`, `pendingSignedGrants`, `running`, `inFlight`. Internal `_resolve(id, caseId)` returns the full entry (non-enumerable `_checked` for external agents). Entries carry `available`, `reason`, `warnings`, `computedSha256`, `payloadSchema`, `overrideBriefRules`.
  - `index.js`: `ExecutorRegistry`, `ExecutorUnavailableError`, `JobStore`, `OPEN_STATES`, `TERMINAL_STATES`, `EnvelopeStore`, `PlanStore`, `normalizeRecipient`.
  - `tests/helpers/executor-fixtures.js`: `tempDir`, `cleanup`, `fakeVault`, `writeFakePackage`, `externalEntry`, `installFakeAdapter`, `setupExecutors`, `withFakeAgent`, `activeCase`, `openTurn`.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/executor-fixtures.js`:

```js
// tests/helpers/executor-fixtures.js
// Shared fixtures for the cases stage 3 tests: a data dir with a case
// runtime and an executor registry, and a scriptable fake external agent
// installed as a real pinned package.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../../src/cases');
const { ExecutorRegistry } = require('../../src/cases/executors');
const { computePackageSha256 } = require('../../src/cases/executors/package-loader');

const made = [];
function tempDir(prefix = 'kl-exec-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
function cleanup() {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
}

function fakeVault(values = { 'errands-token': 'tok-test' }) {
  const m = new Map(Object.entries(values));
  return { get: (k) => (m.has(k) ? m.get(k) : null), has: (k) => m.has(k), set: (k, v) => m.set(k, v) };
}

// The adapter defers to globalThis.__klFakeExecutors[id], set by installFakeAdapter.
const FAKE_ADAPTER_SOURCE = 'module.exports.createAdapter = (config, host) => globalThis.__klFakeExecutors[host.id](config, host);\n';

function writeFakePackage(root, id, { capabilities = ['call', 'voicemail'], cannot = ['web-form', 'email', 'sms'], payloadSchema = { venue: { type: 'string' } } } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `kl-executor-${id}`, version: '1.0.0', main: 'adapter.js',
    kingLouie: {
      executor: {
        apiVersion: 1, id, kind: 'external-agent', capabilities, cannot,
        configSchema: { baseUrl: { type: 'string', required: true }, token: { type: 'string', secret: true, required: true } },
        payloadSchema, origins: ['config:baseUrl']
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'adapter.js'), FAKE_ADAPTER_SOURCE);
  return { dir, sha: computePackageSha256(dir) };
}

function externalEntry(sha, over = {}) {
  return {
    kind: 'external-agent',
    package: 'fake-agent',
    packageSha256: sha,
    config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' },
    constraints: { contactsPerDay: 5 },
    cost: { perJob: 1, perContact: 0.5, perAttempt: 0.25 },
    latency: 'async-hours',
    outbound: 'message',
    authority: 'envelope',
    pollEveryMs: 60000,
    ...over
  };
}

function installFakeAdapter(id, {
  capabilities = ['call', 'voicemail'], cannot = ['web-form', 'email', 'sms'], briefRules = ['Say who you are calling for.'],
  recordToFacts = null, findByExternalRef = false
} = {}) {
  globalThis.__klFakeExecutors = globalThis.__klFakeExecutors || {};
  const ctl = {
    calls: [], jobs: new Map(), records: new Map(), statusThrows: 0, normalizeAs: {}, submitError: null,
    submitDelayMs: 0, cancelThrows: false, rules: briefRules, seq: 0, config: null
  };
  globalThis.__klFakeExecutors[id] = (config) => {
    ctl.config = config;
    const adapter = {
      capabilities: () => ({ capabilities, cannot, constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' }),
      async submit(job, envelope) {
        ctl.calls.push(['submit', job, envelope]);
        if (ctl.submitDelayMs) await new Promise((r) => setTimeout(r, ctl.submitDelayMs));
        if (ctl.submitError) throw ctl.submitError;
        ctl.seq += 1;
        const externalId = `ext-${ctl.seq}`;
        const contacts = (job.recipients || []).map((r, i) => ({ id: `c${i + 1}`, address: r, normalizedAddress: ctl.normalizeAs[r] || r }));
        ctl.jobs.set(externalId, {
          state: 'running', externalRef: job.externalRef, lastChange: null, costUsd: null,
          contacts: contacts.map((c) => ({ id: c.id, state: 'pending', attempts: 0, lastAttemptAt: null }))
        });
        return { jobId: externalId, contacts };
      },
      async status(jobId) {
        ctl.calls.push(['status', jobId]);
        if (ctl.statusThrows > 0) {
          ctl.statusThrows -= 1;
          throw new Error('errands API unavailable');
        }
        const j = ctl.jobs.get(jobId);
        if (!j) throw new Error(`no job ${jobId}`);
        const { externalRef, ...status } = j;
        return JSON.parse(JSON.stringify(status));
      },
      async results(jobId, { after } = {}) {
        ctl.calls.push(['results', jobId, after || null]);
        const all = ctl.records.get(jobId) || [];
        const i = after ? all.findIndex((r) => r.id === after) + 1 : 0;
        return { records: all.slice(i) };
      },
      async cancel(jobId) {
        ctl.calls.push(['cancel', jobId]);
        if (ctl.cancelThrows) throw new Error('cancel failed');
        const j = ctl.jobs.get(jobId);
        if (j) j.state = 'cancelled';
        return { state: 'cancelled' };
      },
      briefRules: () => ctl.rules
    };
    if (recordToFacts) adapter.recordToFacts = recordToFacts;
    if (findByExternalRef) {
      adapter.findByExternalRef = async (ref) => {
        ctl.calls.push(['find', ref]);
        for (const [externalId, j] of ctl.jobs) if (j.externalRef === ref) return { jobId: externalId, contacts: [] };
        return null;
      };
    }
    return adapter;
  };
  return ctl;
}

function setupExecutors({ executors = {}, cases = { timeZone: 'UTC' }, now = '2026-10-26T15:00:00Z', registryOptions = {}, host = {} } = {}) {
  const dataDir = tempDir('kl-exec-data-');
  const clock = { now: new Date(now) };
  const settings = { cases: { ...cases }, executors: { ...executors } };
  let registry = null;
  const runtime = new CaseRuntime({
    root: path.join(dataDir, 'cases'),
    getSettings: () => settings,
    now: () => clock.now,
    host: { getExecutorRegistry: () => registry, ...host }
  });
  registry = new ExecutorRegistry({
    dataDir, getSettings: () => settings, caseRuntime: runtime, now: () => clock.now, vault: fakeVault(), ...registryOptions
  });
  return { dataDir, runtime, registry, settings, clock, packageRoot: path.join(dataDir, 'executors') };
}

function withFakeAgent(env, id = 'fake-agent', opts = {}) {
  const { sha } = writeFakePackage(env.packageRoot, id, opts);
  env.settings.executors.entries = {
    ...(env.settings.executors.entries || {}),
    [id]: externalEntry(sha, { package: id, ...(opts.entry || {}) })
  };
  return installFakeAdapter(id, opts);
}

async function activeCase(runtime, { title = 'Lakeside lot', brief = {} } = {}) {
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  const b = runtime.brief(info.id);
  b.update('why', 'Paying for a move', { provenance: 'user' });
  b.update('successCriteria', ['Sold within the year'], { provenance: 'model' });
  for (const [field, value] of Object.entries(brief)) b.update(field, value, { provenance: 'user' });
  runtime.completeGating(info.id);
  return runtime.getCase(info.id);
}

async function openTurn(runtime, caseId, { turnId = 'turn-1', ownerMessages = [] } = {}) {
  const turn = await runtime.beginTurn(caseId, { turnId });
  // These tests exercise executor rules, not re-orientation.
  turn.reorientPending = false;
  return { turn, caseContext: runtime.caseContext(turn, { ownerMessages }) };
}

module.exports = {
  tempDir, cleanup, fakeVault, writeFakePackage, externalEntry, installFakeAdapter,
  setupExecutors, withFakeAgent, activeCase, openTurn
};
```

Create `tests/cases-executor-registry.test.js`:

```js
// tests/cases-executor-registry.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { ExecutorUnavailableError, JobStore } = require('../src/cases/executors');
const { writeJsonAtomic, readJsonSafe } = require('../src/cases/executors/util');

after(fx.cleanup);

describe('resolution', () => {
  it('lists the built-ins with their availability on this node', () => {
    const env = fx.setupExecutors();
    const list = env.registry.list();
    assert.deepStrictEqual(list.map((e) => e.id), ['bash', 'files', 'web', 'browser', 'workflow', 'runbook', 'owner']);
    assert.deepStrictEqual(['runbook', 'workflow'].map((id) => list.find((e) => e.id === id).reason), [
      'no runbook engine on this node', 'no workflow engine on this node'
    ]);
    const hosted = fx.setupExecutors({ registryOptions: { getWorkflowEngine: () => ({}), getRunbookEngine: () => ({}) } });
    assert.ok(hosted.registry.list().every((e) => e.available));
  });

  it('lets settings change a built-in\'s constraints, never its kind or authority', () => {
    const env = fx.setupExecutors({ executors: { entries: { browser: { constraints: { contactsPerDay: 5 }, authority: 'none', kind: 'owner' } } } });
    const b = env.registry.get('browser');
    assert.deepStrictEqual([b.kind, b.authority, b.outbound, b.constraints.contactsPerDay], ['tool', 'envelope', 'message', 5]);
    assert.deepStrictEqual(b.warnings, [
      'browser: "authority" cannot be changed on a built-in executor; ignored',
      'browser: "kind" cannot be changed on a built-in executor; ignored'
    ]);
  });

  it('adds a pinned external agent and applies the floors (R42)', () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { entry: { authority: 'none', outbound: 'query' } });
    const e = env.registry.get('fake-agent');
    assert.strictEqual(e.available, true, e.reason);
    assert.deepStrictEqual([e.kind, e.capabilities, e.cannot, e.outbound, e.authority], [
      'external-agent', ['call', 'voicemail'], ['web-form', 'email', 'sms'], 'message', 'envelope'
    ]);
    assert.deepStrictEqual(e.warnings, [
      'fake-agent: outbound capabilities (call) keep outbound at "message"',
      'fake-agent: outbound capabilities (call) keep authority at "envelope" or above'
    ]);
    assert.deepStrictEqual(e.payloadSchema, { venue: { type: 'string' } });
    assert.strictEqual(e.config, undefined, 'config is not listed');
  });

  it('marks an unpinned package unavailable and shows the computed pin', () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { entry: { packageSha256: null } });
    const e = env.registry.get('fake-agent');
    assert.strictEqual(e.available, false);
    assert.strictEqual(e.reason, `pin required: set packageSha256 to ${e.computedSha256}`);
    assert.match(e.computedSha256, /^[0-9a-f]{64}$/);
  });

  it('refuses a configured id that is not a slug, and never throws from list', () => {
    const env = fx.setupExecutors({ executors: { entries: { 'Bad Id': { kind: 'external-agent', package: 'x' } } } });
    const bad = env.registry.list().find((e) => e.id === 'Bad Id');
    assert.deepStrictEqual([bad.available, bad.reason], [false, 'executor ids are lowercase slugs of 2 to 40 characters']);
  });

  it('narrows with a per-case override and ignores anything that widens', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), {
      'fake-agent': {
        override: {
          capabilities: ['call', 'sms'], constraints: { contactsPerDay: 10 }, authority: 'none',
          briefRules: ["Say the owner's first name only"], cost: { perJob: 0 }
        }
      }
    });
    const e = env.registry.get('fake-agent', { caseId: c.id });
    assert.deepStrictEqual([e.capabilities, e.constraints.contactsPerDay, e.authority], [['call'], 5, 'envelope']);
    assert.deepStrictEqual(e.overrideBriefRules, ["Say the owner's first name only"]);
    assert.deepStrictEqual(e.warnings.sort(), [
      'fake-agent: override "cost" would widen the executor; ignored',
      'fake-agent: override authority would widen the executor; ignored',
      'fake-agent: override capabilities sms would widen the executor; ignored',
      'fake-agent: override contactsPerDay would widen the executor; ignored'
    ]);
    assert.deepStrictEqual(env.registry.get('fake-agent').capabilities, ['call', 'voicemail'], 'other cases are unchanged');
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), { browser: { override: { disabled: true, constraints: { callingWindow: { tz: 'UTC', start: '10:00', end: '12:00', weekdays: [1, 2] } } } } });
    const b = env.registry.get('browser', { caseId: c.id });
    assert.deepStrictEqual([b.available, b.reason, b.constraints.callingWindow], [false, 'disabled for this case', { tz: 'UTC', start: '10:00', end: '12:00', weekdays: [1, 2] }]);
  });

  it('in service mode takes entries only from the admin config and admin roots', () => {
    const env = fx.setupExecutors({ registryOptions: { isService: true, adminExecutors: { entries: {}, packageRoots: [] } } });
    fx.withFakeAgent(env);
    assert.strictEqual(env.registry.get('fake-agent'), null, 'a data-dir entry is ignored');
    const admin = { entries: { ...env.settings.executors.entries }, packageRoots: [env.packageRoot] };
    const svc = fx.setupExecutors({ registryOptions: { isService: true, adminExecutors: admin, packageRoot: env.packageRoot, assertRoot: () => {} } });
    assert.strictEqual(svc.registry.get('fake-agent').available, true, svc.registry.get('fake-agent').reason);
  });
});

describe('adapters and brief rules', () => {
  it('loads an adapter once and refuses an unavailable executor', async () => {
    const env = fx.setupExecutors();
    const ctl = fx.withFakeAgent(env);
    const a = await env.registry.adapter('fake-agent');
    assert.strictEqual(await env.registry.adapter('fake-agent'), a);
    assert.strictEqual(ctl.config.token, 'tok-test');
    await assert.rejects(env.registry.adapter('runbook'), (err) => err instanceof ExecutorUnavailableError && err.code === 'EXECUTOR_UNAVAILABLE');
    await assert.rejects(env.registry.adapter('nope'), /nope is unavailable: not a known executor/);
  });

  it('orders brief rules adapter, override, extra sources, without duplicates', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { briefRules: ['Say who you are calling for.', 'Shared rule'] });
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), { 'fake-agent': { override: { briefRules: ["Say the owner's first name only", 'Shared rule'] } } });
    env.registry.registerExtraBriefRules((id, caseId) => (id === 'fake-agent' && caseId === c.id ? ['From a playbook'] : []));
    assert.deepStrictEqual(env.registry.briefRules('fake-agent', { caseId: c.id }), ["Say the owner's first name only", 'Shared rule', 'From a playbook']);
    await env.registry.adapter('fake-agent');
    assert.deepStrictEqual(env.registry.briefRules('fake-agent', { caseId: c.id }), [
      'Say who you are calling for.', 'Shared rule', "Say the owner's first name only", 'From a playbook'
    ]);
  });
});

describe('jobs', () => {
  it('numbers jobs by replay in the case', async () => {
    const env = fx.setupExecutors();
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    const store = new JobStore(c.dir);
    const a = store.create({ executor: 'fake-agent', state: 'submitting' });
    const b = store.create({ executor: 'fake-agent', state: 'submitting' });
    assert.deepStrictEqual([a.id, b.id], ['job-0001', 'job-0002']);
    assert.strictEqual(store.update('job-0001', { state: 'running' }).state, 'running');
    assert.deepStrictEqual(env.registry.jobs(c.id).list().map((j) => j.id), ['job-0001', 'job-0002']);
  });

  it('liveState lists open jobs across cases in the C5 shape', async () => {
    const env = fx.setupExecutors();
    await env.registry.indexJob('case-a', { id: 'job-0001', executor: 'fake-agent', state: 'running', signature: 's1', intent: 'Ask for a quote', recipients: ['+15550100'] });
    await env.registry.indexJob('case-a', { id: 'job-0002', executor: 'fake-agent', state: 'done', signature: 's2', intent: 'x', recipients: [] });
    await env.registry.indexJob('case-b', { id: 'job-0001', executor: 'browser', state: 'submitting', signature: 's3', intent: 'File', recipients: ['https://permits.example.com'] });
    assert.deepStrictEqual(env.registry.liveState({ caseId: 'case-a' }), [{
      jobId: 'job-0001', executorId: 'fake-agent', signature: 's1', state: 'running', caseId: 'case-a', intent: 'Ask for a quote', recipients: ['+15550100']
    }]);
    assert.deepStrictEqual(env.registry.liveState().map((r) => `${r.caseId}/${r.jobId}`), ['case-a/job-0001', 'case-b/job-0001']);
  });
});

describe('global daily cap', () => {
  it('global cap is shared across cases under the mutex', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const [a, b] = await Promise.all([
      env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-a' }),
      env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-b' })
    ]);
    assert.deepStrictEqual([a.ok, b.ok], [true, false]);
    assert.strictEqual(b.error, 'fake-agent daily cap 5 reached (used by 1 case); resets 2026-10-27 00:00 UTC');
    const usage = readJsonSafe(path.join(env.dataDir, 'executors', 'usage.json'), null);
    assert.deepStrictEqual(usage['fake-agent'], { day: '2026-10-26', tz: 'UTC', limit: 5, used: 3, byCase: { 'case-a': 3 } });
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 2);
    assert.deepStrictEqual(await env.registry.releaseContacts('fake-agent', 1, { caseId: 'case-a' }), { ok: true, released: 1 });
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 3);
    env.clock.now = new Date('2026-10-27T00:30:00Z');
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 5, 'the next local day starts fresh');
    assert.deepStrictEqual(await env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-b' }), { ok: true, used: 3, limit: 5, day: '2026-10-27' });
    assert.strictEqual(fs.existsSync(path.join(env.dataDir, 'executors', 'usage.json')), true);
  });

  it('an executor without contactsPerDay has no global cap', async () => {
    const env = fx.setupExecutors();
    assert.strictEqual((await env.registry.reserveContacts('browser', 50, { caseId: 'case-a' })).ok, true);
    assert.strictEqual(env.registry.globalRemaining('browser'), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-executor-registry.test.js`
Expected: FAIL with `Cannot find module '../../src/cases/executors'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/job-store.js`:

```js
// src/cases/executors/job-store.js
// .kl/jobs/<id>.json and the .kl/executors.json snapshot (cases stage 3
// spec §4, program §4.7).
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./util');

const OPEN_STATES = Object.freeze(['submitting', 'submitted', 'running', 'waiting']);
const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled', 'unreachable']);
const JOB_ID = /^job-(\d{4,})$/;
const isOpen = (state) => OPEN_STATES.includes(state);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const JOB_DEFAULTS = Object.freeze({
  caseId: null, executor: null, kind: null, externalId: null, envelopeId: null, planStepId: null, retryOf: null,
  n: null, signature: null, payloadHash: null, idempotencyKey: null, intent: '', state: 'submitting', recipients: [],
  payload: null, originalPayload: null, facts: [], createdAt: null, submittedAt: null, lastPolledAt: null, nextPollAt: null,
  lastChange: null, pollErrors: 0, stale: false, error: null, resultsCursor: null, recordsSaved: [], estimateUsd: 0,
  chargedUsd: 0, costReported: false, wakeupId: null, contacts: [], reason: null, reservedContacts: 0, newContacts: 0,
  questionId: null, copied: false, window: null, maxCostUsd: null
});

class JobStore {
  constructor(caseDir) {
    this.dir = path.join(caseDir, '.kl', 'jobs');
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
      .filter((id) => JOB_ID.test(id))
      .sort((a, b) => Number(JOB_ID.exec(a)[1]) - Number(JOB_ID.exec(b)[1]));
  }

  list() {
    return this.ids().map((id) => this.get(id)).filter(Boolean);
  }

  get(id) {
    if (!JOB_ID.test(String(id))) return null;
    return readJsonSafe(this._file(id), null);
  }

  nextId() {
    const max = this.ids().reduce((m, id) => Math.max(m, Number(JOB_ID.exec(id)[1])), 0);
    return `job-${String(max + 1).padStart(4, '0')}`;
  }

  create(fields = {}) {
    const id = this.nextId();
    const job = JSON.parse(JSON.stringify({ ...JOB_DEFAULTS, ...fields, id }));
    return this.write(job);
  }

  write(job) {
    writeJsonAtomic(this._file(job.id), job);
    return job;
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw new Error(`Job ${id} was not found in this case.`);
    return this.write({ ...current, ...patch, id });
  }
}

function snapshotPath(caseDir) {
  return path.join(caseDir, '.kl', 'executors.json');
}

function readSnapshot(caseDir) {
  const s = readJsonSafe(snapshotPath(caseDir), {});
  return isObject(s) ? s : {};
}

function writeSnapshot(caseDir, snapshot) {
  const before = readJsonSafe(snapshotPath(caseDir), null);
  if (before && JSON.stringify(before) === JSON.stringify(snapshot)) return false;
  writeJsonAtomic(snapshotPath(caseDir), snapshot);
  return true;
}

module.exports = { OPEN_STATES, TERMINAL_STATES, JOB_DEFAULTS, isOpen, JobStore, readSnapshot, writeSnapshot };
```

Create `src/cases/executors/registry.js`:

```js
// src/cases/executors/registry.js
// ExecutorRegistry (cases stage 3 spec §3.1, program §4.8): who can do the
// work. Resolution is built-in → configured entries → per-case override
// (narrowing only) → floors (R42). Job lifecycle, envelopes and plans live in
// their own modules and are attached below as operations.
const path = require('path');
const AsyncMutex = require('../../workflows/async-mutex');
const { createLogger } = require('../../logging');
const { builtinEntry, BUILTIN_IDS, OUTBOUND_CAPABILITIES, ID_PATTERN, LATENCIES, STATE_MODES, OUTBOUND_MODES } = require('./builtins');
const { checkPackage, loadAdapter, ExecutorUnavailableError } = require('./package-loader');
const { resolveExecutorSettings } = require('./defaults');
const { readJsonSafe, writeJsonAtomic, localDate, pickTimeZone, addDays } = require('./util');
const { JobStore, readSnapshot, OPEN_STATES } = require('./job-store');

const log = createLogger('executors');
const AUTHORITY_RANK = Object.freeze({ none: 0, envelope: 1, signed: 2 });
// What settings may change on a built-in (spec §3.1).
const BUILTIN_SETTABLE = new Set(['constraints', 'cost', 'latency', 'pollEveryMs']);
const OVERRIDE_KEYS = new Set(['disabled', 'capabilities', 'constraints', 'briefRules', 'authority']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const publicEntry = (e) => JSON.parse(JSON.stringify(e));

// The intersection of two calling windows, or null when it would be empty,
// cross zones, or the override is malformed.
function intersectWindow(base, narrow) {
  if (!isObject(narrow)) return null;
  if (!base) {
    if (!HHMM.test(String(narrow.start)) || !HHMM.test(String(narrow.end)) || !(narrow.start < narrow.end)) return null;
    return { tz: narrow.tz || '', start: narrow.start, end: narrow.end, weekdays: Array.isArray(narrow.weekdays) ? [...narrow.weekdays] : [...ALL_WEEKDAYS] };
  }
  if (narrow.tz && base.tz && narrow.tz !== base.tz) return null;
  const start = HHMM.test(String(narrow.start)) && narrow.start > base.start ? narrow.start : base.start;
  const end = HHMM.test(String(narrow.end)) && narrow.end < base.end ? narrow.end : base.end;
  const baseDays = Array.isArray(base.weekdays) ? base.weekdays : ALL_WEEKDAYS;
  const weekdays = Array.isArray(narrow.weekdays) ? baseDays.filter((d) => narrow.weekdays.includes(d)) : [...baseDays];
  if (!(start < end) || !weekdays.length) return null;
  return { tz: base.tz || narrow.tz || '', start, end, weekdays };
}

class ExecutorRegistry {
  constructor({
    dataDir, getSettings = () => ({}), adminExecutors = null, isService = false, vault = null, caseRuntime = null,
    getWorkflowEngine = () => null, getRunbookEngine = () => null, getPhoneApprover = () => null, getAuditLedger = () => null,
    usageTracker = null, now = () => new Date(), packageRoot = null, assertRoot = null, fetchImpl = null, browserActions = null
  } = {}) {
    if (!dataDir) throw new Error('ExecutorRegistry needs a dataDir.');
    const fn = (f) => (typeof f === 'function' ? f : () => null);
    this.dataDir = dataDir;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.adminExecutors = isObject(adminExecutors) ? adminExecutors : null;
    this.isService = isService === true;
    this.vault = vault;
    this.caseRuntime = caseRuntime;
    this.getWorkflowEngine = fn(getWorkflowEngine);
    this.getRunbookEngine = fn(getRunbookEngine);
    this.getPhoneApprover = fn(getPhoneApprover);
    this.getAuditLedger = fn(getAuditLedger);
    this._usageTracker = usageTracker;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.dir = path.join(dataDir, 'executors');
    this.packageRoot = packageRoot || this.dir;
    this.assertRoot = assertRoot;
    this.fetchImpl = fetchImpl;
    this.browserActions = browserActions;
    this.usagePath = path.join(this.dir, 'usage.json');
    this.jobsPath = path.join(this.dir, 'jobs.json');
    this.runsDir = path.join(this.dir, 'runs');
    this.mutex = new AsyncMutex();
    this.extraBriefRules = [];
    // `${caseId}/${envelopeId}` → approve Outcomes from the phone (never from a file).
    this.signedOutcomes = new Map();
    // `${caseId}/${envelopeId}` → an approve Outcome waiting for the case lock.
    this.pendingSignedGrants = new Map();
    // `${caseId}/${jobId}` → { controller, started, name, stamp } for background runs.
    this.running = new Map();
    // `${caseId}/${jobId}` while this process is inside adapter.submit.
    this.inFlight = new Set();
    this._adapters = new Map();
    this._loaded = new Map();
    this._warned = new Set();
  }

  getUsageTracker() {
    return typeof this._usageTracker === 'function' ? this._usageTracker() : this._usageTracker;
  }

  settings() {
    let raw;
    try {
      raw = this.getSettings()?.executors;
    } catch (err) {
      log.warn(`Reading executor settings failed: ${err.message}`);
    }
    return resolveExecutorSettings(raw);
  }

  casesTimeZone() {
    try {
      return this.getSettings()?.cases?.timeZone || '';
    } catch {
      return '';
    }
  }

  _warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    log.warn(message);
  }

  // Desktop: settings.executors.entries. Service: the admin service.json
  // only (R42); a data-dir value is ignored with a warning per id.
  _configured() {
    const s = this.settings();
    if (this.isService) {
      for (const id of Object.keys(s.entries || {})) {
        this._warnOnce(`data-entry:${id}`, `Ignoring executors.entries.${id} from the data dir: in service mode executors come only from the admin service.json.`);
      }
      return isObject(this.adminExecutors?.entries) ? this.adminExecutors.entries : {};
    }
    return isObject(s.entries) ? s.entries : {};
  }

  _roots() {
    if (!this.isService) return [this.packageRoot];
    return Array.isArray(this.adminExecutors?.packageRoots) ? this.adminExecutors.packageRoots.map(String) : [];
  }

  ids() {
    const configured = Object.keys(this._configured()).filter((id) => !BUILTIN_IDS.includes(id)).sort();
    return [...BUILTIN_IDS, ...configured];
  }

  _base(id) {
    const warnings = [];
    const conf = this._configured()[id];
    const builtin = builtinEntry(id);
    if (builtin) {
      if (isObject(conf)) {
        for (const [k, v] of Object.entries(conf)) {
          if (BUILTIN_SETTABLE.has(k)) builtin[k] = clone(v);
          else warnings.push(`${id}: "${k}" cannot be changed on a built-in executor; ignored`);
        }
      }
      return { entry: builtin, conf: null, warnings };
    }
    if (!isObject(conf)) return null;
    const entry = {
      id,
      kind: conf.kind || 'external-agent',
      builtin: false,
      package: typeof conf.package === 'string' ? conf.package : null,
      capabilities: [],
      cannot: [],
      constraints: isObject(conf.constraints) ? clone(conf.constraints) : {},
      cost: isObject(conf.cost) ? clone(conf.cost) : {},
      latency: LATENCIES.includes(conf.latency) ? conf.latency : 'async-hours',
      state: STATE_MODES.includes(conf.state) ? conf.state : 'poll',
      authority: AUTHORITY_RANK[conf.authority] !== undefined ? conf.authority : 'envelope',
      direct: false,
      outbound: OUTBOUND_MODES.includes(conf.outbound) ? conf.outbound : 'none',
      pollEveryMs: Number.isInteger(conf.pollEveryMs) ? conf.pollEveryMs : null,
      packageSha256: typeof conf.packageSha256 === 'string' ? conf.packageSha256 : null,
      computedSha256: null,
      payloadSchema: {}
    };
    return { entry, conf, warnings };
  }

  _checkExternal(entry, conf) {
    const unavailable = (reason) => {
      entry.available = false;
      entry.reason = reason;
    };
    if (!ID_PATTERN.test(entry.id)) return unavailable('executor ids are lowercase slugs of 2 to 40 characters');
    if (entry.kind !== 'external-agent') return unavailable(`only external-agent executors can be configured; "${entry.kind}" executors are built in`);
    if (!entry.package) return unavailable('no package is configured');
    const roots = this._roots();
    const dir = path.isAbsolute(entry.package) ? entry.package : path.resolve(roots[0] || this.packageRoot, entry.package);
    const checked = checkPackage({
      id: entry.id,
      entry: { packageSha256: entry.packageSha256, config: isObject(conf.config) ? conf.config : {} },
      dir, roots, isService: this.isService, assertRoot: this.assertRoot, vault: this.vault
    });
    entry.computedSha256 = checked.computed || null;
    if (checked.manifest) {
      const manifestCaps = Array.isArray(checked.manifest.capabilities) ? checked.manifest.capabilities.map(String) : [];
      entry.capabilities = Array.isArray(conf.capabilities) ? conf.capabilities.map(String).filter((c) => manifestCaps.includes(c)) : manifestCaps;
      entry.cannot = Array.isArray(checked.manifest.cannot) ? checked.manifest.cannot.map(String) : [];
      entry.payloadSchema = isObject(checked.manifest.payloadSchema) ? clone(checked.manifest.payloadSchema) : {};
    }
    if (!checked.ok) return unavailable(checked.error);
    const clash = entry.capabilities.filter((c) => entry.cannot.includes(c));
    if (clash.length) return unavailable(`capabilities and cannot overlap: ${clash.join(', ')}`);
    Object.defineProperty(entry, '_checked', { value: checked, enumerable: false });
    return undefined;
  }

  _override(id, caseId) {
    if (!caseId || !this.caseRuntime) return null;
    const snap = readSnapshot(this.caseDir(caseId));
    return isObject(snap[id]?.override) ? snap[id].override : null;
  }

  // An override only narrows; a widening part is ignored with a warning.
  _narrow(entry, o, warnings) {
    const widen = (what) => warnings.push(`${entry.id}: override ${what} would widen the executor; ignored`);
    for (const key of Object.keys(o)) if (!OVERRIDE_KEYS.has(key)) widen(`"${key}"`);
    if (o.disabled === true) {
      entry.available = false;
      entry.reason = 'disabled for this case';
    }
    if (Array.isArray(o.capabilities)) {
      const extra = o.capabilities.filter((c) => !entry.capabilities.includes(c));
      if (extra.length) widen(`capabilities ${extra.join(', ')}`);
      entry.capabilities = entry.capabilities.filter((c) => o.capabilities.includes(c));
    }
    const oc = isObject(o.constraints) ? o.constraints : {};
    for (const key of Object.keys(oc)) if (key !== 'contactsPerDay' && key !== 'callingWindow') widen(`constraints.${key}`);
    if (oc.contactsPerDay !== undefined) {
      const n = oc.contactsPerDay;
      const current = entry.constraints.contactsPerDay;
      if (!Number.isInteger(n) || n < 0 || (Number.isInteger(current) && n > current)) widen('contactsPerDay');
      else entry.constraints.contactsPerDay = n;
    }
    if (oc.callingWindow !== undefined) {
      const merged = intersectWindow(entry.constraints.callingWindow || null, oc.callingWindow);
      if (!merged) widen('callingWindow');
      else entry.constraints.callingWindow = merged;
    }
    if (Array.isArray(o.briefRules)) entry.overrideBriefRules = o.briefRules.map((r) => String(r).trim()).filter(Boolean);
    if (o.authority !== undefined) {
      if (AUTHORITY_RANK[o.authority] === undefined || AUTHORITY_RANK[o.authority] < AUTHORITY_RANK[entry.authority]) widen('authority');
      else entry.authority = o.authority;
    }
  }

  // R42: an outbound capability forces outbound "message" and authority ≥ envelope.
  _floors(entry, warnings) {
    const outbound = entry.capabilities.filter((c) => OUTBOUND_CAPABILITIES.includes(c));
    if (!outbound.length) return;
    if (entry.outbound !== 'message') {
      warnings.push(`${entry.id}: outbound capabilities (${outbound.join(', ')}) keep outbound at "message"`);
      entry.outbound = 'message';
    }
    if ((AUTHORITY_RANK[entry.authority] ?? 0) < AUTHORITY_RANK.envelope) {
      warnings.push(`${entry.id}: outbound capabilities (${outbound.join(', ')}) keep authority at "envelope" or above`);
      entry.authority = 'envelope';
    }
  }

  _resolve(id, caseId = null) {
    const base = this._base(id);
    if (!base) return null;
    const { entry, conf } = base;
    const warnings = [...base.warnings];
    entry.available = true;
    entry.reason = null;
    entry.overrideBriefRules = [];
    if (!entry.builtin) this._checkExternal(entry, conf);
    else if (id === 'runbook' && !this.getRunbookEngine()) {
      entry.available = false;
      entry.reason = 'no runbook engine on this node';
    } else if (id === 'workflow' && !this.getWorkflowEngine()) {
      entry.available = false;
      entry.reason = 'no workflow engine on this node';
    }
    if (caseId) {
      const override = this._override(id, caseId);
      if (override) this._narrow(entry, override, warnings);
    }
    this._floors(entry, warnings);
    entry.warnings = warnings;
    return entry;
  }

  list({ caseId = null } = {}) {
    return this.ids().map((id) => {
      try {
        return publicEntry(this._resolve(id, caseId));
      } catch (err) {
        return { id, available: false, reason: err.message, warnings: [] };
      }
    });
  }

  get(id, { caseId = null } = {}) {
    try {
      const e = this._resolve(id, caseId);
      return e ? publicEntry(e) : null;
    } catch (err) {
      return { id, available: false, reason: err.message, warnings: [] };
    }
  }

  async adapter(id) {
    const entry = this._resolve(id, null);
    if (!entry) throw new ExecutorUnavailableError(id, 'not a known executor');
    if (entry.kind !== 'external-agent') throw new ExecutorUnavailableError(id, 'only external-agent executors have an adapter');
    if (!entry.available) throw new ExecutorUnavailableError(id, entry.reason);
    const key = entry._checked.computed;
    const cached = this._adapters.get(id);
    if (cached && cached.key === key) return cached.promise;
    const promise = loadAdapter(entry._checked, {
      id, entry, requestTimeoutMs: this.settings().requestTimeoutMs, fetchImpl: this.fetchImpl, now: this.now
    }).then(({ adapter }) => {
      this._loaded.set(id, adapter);
      return adapter;
    }).catch((err) => {
      if (this._adapters.get(id)?.promise === promise) this._adapters.delete(id);
      throw err instanceof ExecutorUnavailableError ? err : new ExecutorUnavailableError(id, err.message);
    });
    this._adapters.set(id, { key, promise });
    return promise;
  }

  // Adapter rules (once loaded), then the case override, then extra sources (C6, R18).
  briefRules(id, { caseId = null } = {}) {
    const out = [];
    const push = (r) => {
      const t = String(r ?? '').trim();
      if (t && !out.includes(t)) out.push(t);
    };
    const adapter = this._loaded.get(id);
    if (adapter) {
      try {
        const rules = adapter.briefRules();
        if (Array.isArray(rules)) rules.forEach(push);
      } catch (err) {
        log.warn(`${id} briefRules failed: ${err.message}`);
      }
    }
    let entry = null;
    try {
      entry = this._resolve(id, caseId);
    } catch {
      entry = null;
    }
    (entry?.overrideBriefRules || []).forEach(push);
    for (const fn of this.extraBriefRules) {
      try {
        const rules = fn(id, caseId);
        if (Array.isArray(rules)) rules.forEach(push);
      } catch (err) {
        log.warn(`Extra brief rules for ${id} failed: ${err.message}`);
      }
    }
    return out;
  }

  registerExtraBriefRules(fn) {
    if (typeof fn !== 'function') throw new TypeError('registerExtraBriefRules needs a function (executorId, caseId) → string[].');
    this.extraBriefRules.push(fn);
  }

  // ---- The global daily cap: <dataDir>/executors/usage.json ----

  _capTimeZone(entry) {
    return pickTimeZone(entry?.constraints?.callingWindow?.tz, this.casesTimeZone());
  }

  _capLimit(entry) {
    return Number.isInteger(entry?.constraints?.contactsPerDay) ? entry.constraints.contactsPerDay : null;
  }

  async reserveContacts(id, n, { caseId = null } = {}) {
    const entry = this._resolve(id, null);
    const limit = this._capLimit(entry);
    const tz = this._capTimeZone(entry);
    const add = Math.max(0, Math.floor(Number(n) || 0));
    return this.mutex.run('usage', async () => {
      const data = readJsonSafe(this.usagePath, {});
      const day = localDate(this.now(), tz);
      const rec = isObject(data[id]) && data[id].day === day ? data[id] : { day, tz, limit, used: 0, byCase: {} };
      rec.limit = limit;
      rec.tz = tz;
      if (limit !== null && rec.used + add > limit) {
        const cases = Object.values(rec.byCase || {}).filter((v) => v > 0).length;
        return {
          ok: false, used: rec.used, limit, day,
          error: `${id} daily cap ${limit} reached (used by ${cases} case${cases === 1 ? '' : 's'}); resets ${addDays(day, 1)} 00:00 ${tz}`
        };
      }
      const key = caseId || 'none';
      rec.used += add;
      rec.byCase = { ...(rec.byCase || {}), [key]: ((rec.byCase || {})[key] || 0) + add };
      data[id] = rec;
      writeJsonAtomic(this.usagePath, data);
      return { ok: true, used: rec.used, limit, day };
    });
  }

  async releaseContacts(id, n, { caseId = null } = {}) {
    const entry = this._resolve(id, null);
    const tz = this._capTimeZone(entry);
    const sub = Math.max(0, Math.floor(Number(n) || 0));
    return this.mutex.run('usage', async () => {
      const data = readJsonSafe(this.usagePath, {});
      const rec = data[id];
      if (!isObject(rec) || rec.day !== localDate(this.now(), tz) || !sub) return { ok: true, released: 0 };
      const key = caseId || 'none';
      const take = Math.min(sub, (rec.byCase || {})[key] || 0, rec.used);
      rec.used -= take;
      rec.byCase = { ...(rec.byCase || {}), [key]: ((rec.byCase || {})[key] || 0) - take };
      writeJsonAtomic(this.usagePath, data);
      return { ok: true, released: take };
    });
  }

  globalRemaining(id) {
    const entry = this._resolve(id, null);
    const limit = this._capLimit(entry);
    if (limit === null) return null;
    const rec = readJsonSafe(this.usagePath, {})[id];
    if (!isObject(rec) || rec.day !== localDate(this.now(), this._capTimeZone(entry))) return limit;
    return Math.max(0, limit - (Number(rec.used) || 0));
  }

  // ---- Jobs ----

  caseDir(caseId) {
    return this.caseRuntime.getCase(caseId).dir;
  }

  jobs(caseId) {
    return new JobStore(this.caseDir(caseId));
  }

  // <dataDir>/executors/jobs.json: "<caseId>/<jobId>" → the live row (spec §4).
  async indexJob(caseId, job) {
    return this.mutex.run('jobs', async () => {
      const data = readJsonSafe(this.jobsPath, {});
      data[`${caseId}/${job.id}`] = {
        executor: job.executor,
        externalId: job.externalId || null,
        state: job.state,
        signature: job.signature || null,
        intent: job.intent || '',
        recipients: Array.isArray(job.recipients) ? job.recipients : [],
        lastChange: job.lastChange || null
      };
      writeJsonAtomic(this.jobsPath, data);
    });
  }

  liveState({ caseId = null } = {}) {
    const data = readJsonSafe(this.jobsPath, {});
    return Object.entries(isObject(data) ? data : {})
      .map(([key, row]) => {
        const i = key.lastIndexOf('/');
        return {
          jobId: key.slice(i + 1),
          executorId: row.executor,
          signature: row.signature || null,
          state: row.state,
          caseId: key.slice(0, i),
          intent: row.intent || '',
          recipients: Array.isArray(row.recipients) ? row.recipients : []
        };
      })
      .filter((r) => OPEN_STATES.includes(r.state) && (!caseId || r.caseId === caseId));
  }

  // ---- operations (Tasks 9–12) ----
}

module.exports = { ExecutorRegistry, intersectWindow, AUTHORITY_RANK };
```

Create `src/cases/executors/index.js`:

```js
// src/cases/executors/index.js
const { ExecutorRegistry } = require('./registry');
const { ExecutorUnavailableError } = require('./package-loader');
const { JobStore, OPEN_STATES, TERMINAL_STATES } = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const { PlanStore } = require('./plan');
const { normalizeRecipient } = require('./normalize');

module.exports = {
  ExecutorRegistry,
  ExecutorUnavailableError,
  JobStore,
  OPEN_STATES,
  TERMINAL_STATES,
  EnvelopeStore,
  PlanStore,
  normalizeRecipient
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-executor-registry.test.js tests/cases-executor-package.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/job-store.js src/cases/executors/registry.js src/cases/executors/index.js tests/helpers/executor-fixtures.js tests/cases-executor-registry.test.js
git commit -m "feat(cases): executor registry with overrides, floors, jobs index and the global daily cap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The reference `phone-agent` package and the errands API contract

**Files:**
- Create: `examples/executors/phone-agent/package.json`
- Create: `examples/executors/phone-agent/adapter.js`
- Create: `examples/executors/phone-agent/openapi.yaml`
- Create: `examples/executors/phone-agent/README.md`
- Create: `tests/helpers/fake-errands-server.js`
- Test: `tests/executor-phone-agent.test.js`

**Interfaces:**
- Consumes: the adapter interface (program §4.8) and `host = { id, log, fetch, now }` (Task 6); `checkPackage`, `loadAdapter`, `makeHostFetch`, `computePackageSha256` (Task 6).
- Produces:
  - `adapter.js`: `createAdapter(config, host)` → `{ capabilities, submit, status, results, cancel, briefRules, recordToFacts, findByExternalRef }`; `ErrandsError` (`code ∈ auth | not-found | conflict | invalid | rate-limited | unavailable | error`, `status`, `retryAfterSeconds`). The job the node passes to `submit(job, envelope)` is `{ id, caseId, externalRef, idempotencyKey, intent, recipients: [E.164], payload: <rendered payload>, facts: [{ id, stmt, value }], maxCostUsd, window: { notBefore, notAfter, tz } }`. Errands job states map `queued → submitted`, `running`, `waiting`, `done`, `failed`, `cancelled`.
  - `tests/helpers/fake-errands-server.js`: `startFakeErrandsServer({ token, pageSize }) → { url, state, knobs, setJob(id, patch), addRecord(id, record), close() }` with knobs `failNextStatus`, `normalizeAs`, `latencyMs`, `status429` (seconds for `Retry-After`), `status404`, `status422`, `status5xx`; a reused `Idempotency-Key` with a different body answers `409`.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/fake-errands-server.js`:

```js
// tests/helpers/fake-errands-server.js
// An in-process errands API (examples/executors/phone-agent/openapi.yaml)
// for the cases stage 3 tests. Listens on 127.0.0.1 only.
const http = require('http');
const crypto = require('crypto');

async function startFakeErrandsServer({ token = 'tok-test', pageSize = 2 } = {}) {
  const state = { jobs: new Map(), records: new Map(), idempotency: new Map(), requests: [], seq: 0 };
  const knobs = { failNextStatus: null, normalizeAs: {}, latencyMs: 0, status429: null, status404: false, status422: false, status5xx: false };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const fail = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);
  const view = (j) => JSON.parse(JSON.stringify(j));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (knobs.latencyMs) await new Promise((r) => setTimeout(r, knobs.latencyMs));
      if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'auth', 'bad token');
      if (knobs.failNextStatus) {
        const status = knobs.failNextStatus;
        knobs.failNextStatus = null;
        return fail(res, status, 'forced', `forced ${status}`);
      }
      if (knobs.status429) return fail(res, 429, 'rate-limited', 'slow down', { 'retry-after': String(knobs.status429) });
      if (knobs.status5xx) return fail(res, 503, 'unavailable', 'maintenance');
      if (knobs.status404) return fail(res, 404, 'not-found', 'no such job');
      if (knobs.status422) return fail(res, 422, 'invalid', 'bad request body');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && url.pathname === '/jobs') {
        const key = req.headers['idempotency-key'];
        if (!key) return fail(res, 422, 'invalid', 'Idempotency-Key is required');
        if (!body || !body.externalRef || !Array.isArray(body.recipients) || !body.recipients.length) {
          return fail(res, 422, 'invalid', 'externalRef and recipients are required');
        }
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const seen = state.idempotency.get(key);
        if (seen) {
          if (seen.hash !== hash) return fail(res, 409, 'conflict', 'Idempotency-Key reused with a different body');
          return send(res, 200, view(state.jobs.get(seen.id)));
        }
        state.seq += 1;
        const id = `job_${state.seq}`;
        const at = new Date().toISOString();
        const job = {
          id, state: 'queued', externalRef: body.externalRef, createdAt: at, updatedAt: at, costUsd: 0,
          contacts: body.recipients.map((r, i) => ({
            id: `c${i + 1}`, address: r.address, normalizedAddress: knobs.normalizeAs[r.address] || r.address,
            state: 'pending', attempts: 0, lastAttemptAt: null
          }))
        };
        state.jobs.set(id, job);
        state.idempotency.set(key, { hash, id });
        return send(res, 201, view(job));
      }
      if (req.method === 'GET' && url.pathname === '/jobs') {
        const ref = url.searchParams.get('externalRef');
        return send(res, 200, { jobs: [...state.jobs.values()].filter((j) => j.externalRef === ref).map(view) });
      }
      if (parts[0] === 'jobs' && parts[1]) {
        const job = state.jobs.get(parts[1]);
        if (!job) return fail(res, 404, 'not-found', `no job ${parts[1]}`);
        if (req.method === 'GET' && parts.length === 2) return send(res, 200, view(job));
        if (req.method === 'DELETE' && parts.length === 2) {
          job.state = 'cancelled';
          job.updatedAt = new Date().toISOString();
          return send(res, 200, view(job));
        }
        if (req.method === 'GET' && parts[2] === 'results') {
          const all = state.records.get(job.id) || [];
          const after = url.searchParams.get('after');
          const start = after ? all.findIndex((r) => r.id === after) + 1 : 0;
          const page = all.slice(start, start + pageSize);
          const next = start + pageSize < all.length ? page[page.length - 1].id : null;
          return send(res, 200, { records: page, next });
        }
      }
      return fail(res, 404, 'not-found', 'no such route');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    knobs,
    setJob(id, patch) {
      Object.assign(state.jobs.get(id), patch, { updatedAt: new Date().toISOString() });
    },
    addRecord(id, record) {
      const list = state.records.get(id) || [];
      list.push(record);
      state.records.set(id, list);
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startFakeErrandsServer };
```

Create `tests/executor-phone-agent.test.js`:

```js
// tests/executor-phone-agent.test.js
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startFakeErrandsServer } = require('./helpers/fake-errands-server');
const { createAdapter } = require('../examples/executors/phone-agent/adapter');
const { makeHostFetch, checkPackage, loadAdapter, computePackageSha256 } = require('../src/cases/executors/package-loader');

let server;
before(async () => { server = await startFakeErrandsServer(); });
after(() => server.close());
afterEach(() => {
  Object.assign(server.knobs, { failNextStatus: null, normalizeAs: {}, latencyMs: 0, status429: null, status404: false, status422: false, status5xx: false });
});

const silent = { info() {}, warn() {}, error() {}, debug() {} };
function adapter(token = 'tok-test') {
  return createAdapter({ baseUrl: server.url, token }, {
    id: 'phone-agent', log: silent, now: () => new Date(),
    fetch: makeHostFetch({ origins: ['config:baseUrl'], config: { baseUrl: server.url }, requestTimeoutMs: 5000 })
  });
}
const job = (over = {}) => ({
  id: 'job-0001', caseId: 'case-7', externalRef: 'case-7/job-0001', idempotencyKey: 'k-1', intent: 'Ask for a listing quote',
  recipients: ['+15550100'],
  payload: {
    recipients: [{ address: '+1 555 0100', name: 'Harbor Realty' }], text: 'Hello, calling about the lot.', attemptsPerContact: 2,
    expect: [{ subject: 'lot', attr: 'acreage', question: 'What acreage does the listing show?' }], venue: 'phone'
  },
  facts: [{ id: 'f-0001', stmt: 'Lot size is 2.12 acres', value: 2.12 }],
  maxCostUsd: 12.5,
  window: { notBefore: '2026-10-26T14:00:00Z', notAfter: '2026-10-31T04:59:59Z', tz: 'America/Chicago' },
  ...over
});
const code = (c) => (err) => err.name === 'ErrandsError' && err.code === c;

describe('the reference package', () => {
  it('passes the loader checks with its pin', async () => {
    const root = path.join(__dirname, '..', 'examples', 'executors');
    const dir = path.join(root, 'phone-agent');
    const checked = checkPackage({
      id: 'phone-agent', dir, roots: [root],
      entry: { packageSha256: computePackageSha256(dir), config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' } },
      vault: { get: () => 'tok-test' }
    });
    assert.strictEqual(checked.ok, true, checked.error);
    assert.deepStrictEqual(checked.manifest.origins, ['config:baseUrl']);
    const { capabilities } = await loadAdapter(checked, { id: 'phone-agent', entry: {} });
    assert.deepStrictEqual([capabilities.capabilities, capabilities.state], [['call', 'voicemail'], 'poll']);
  });
});

describe('errands API contract', () => {
  it('submits with the idempotency key and the case id in externalRef', async () => {
    const r = await adapter().submit(job(), { intent: 'Ask for a listing quote' });
    assert.strictEqual(r.jobId, 'job_1');
    assert.deepStrictEqual(r.contacts, [{ id: 'c1', address: '+15550100', normalizedAddress: '+15550100' }]);
    const req = server.state.requests.at(-1);
    assert.deepStrictEqual([req.method, req.path, req.headers['idempotency-key'], req.headers.authorization], ['POST', '/jobs', 'k-1', 'Bearer tok-test']);
    assert.deepStrictEqual(req.body, {
      externalRef: 'case-7/job-0001',
      intent: 'Ask for a listing quote',
      text: 'Hello, calling about the lot.',
      recipients: [{ address: '+15550100', name: 'Harbor Realty' }],
      facts: [{ id: 'f-0001', statement: 'Lot size is 2.12 acres', value: 2.12 }],
      expect: [{ key: 'q1', question: 'What acreage does the listing show?' }],
      maxCostUsd: 12.5,
      maxAttemptsPerContact: 2,
      window: { notBefore: '2026-10-26T14:00:00Z', notAfter: '2026-10-31T04:59:59Z', tz: 'America/Chicago' },
      extra: { venue: 'phone' }
    });
  });

  it('a retry reuses the job; the same key with another body is a conflict', async () => {
    const a = adapter();
    const first = await a.submit(job({ idempotencyKey: 'k-2' }), null);
    const again = await a.submit(job({ idempotencyKey: 'k-2' }), null);
    assert.strictEqual(again.jobId, first.jobId);
    await assert.rejects(a.submit(job({ idempotencyKey: 'k-2', intent: 'Something else' }), null), (err) => code('conflict')(err) && err.status === 409);
  });

  it('maps HTTP failures to error codes', async () => {
    const a = adapter();
    await assert.rejects(a.status('job_404'), code('not-found'));
    server.knobs.status422 = true;
    await assert.rejects(a.submit(job({ idempotencyKey: 'k-3' }), null), code('invalid'));
    server.knobs.status422 = false;
    server.knobs.status5xx = true;
    await assert.rejects(a.status('job_1'), code('unavailable'));
    server.knobs.status5xx = false;
    server.knobs.status429 = 30;
    await assert.rejects(a.status('job_1'), (err) => code('rate-limited')(err) && err.retryAfterSeconds === 30);
    server.knobs.status429 = null;
    await assert.rejects(adapter('wrong').status('job_1'), code('auth'));
  });

  it('reports job status in node states', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-4' }), null);
    assert.deepStrictEqual((await a.status(jobId)).state, 'submitted');
    server.setJob(jobId, { state: 'running', costUsd: 1.75 });
    const s = await a.status(jobId);
    assert.deepStrictEqual([s.state, s.costUsd, s.contacts[0].id, s.contacts[0].state], ['running', 1.75, 'c1', 'pending']);
    assert.match(s.lastChange, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('pages results after a cursor', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-5' }), null);
    for (const id of ['r1', 'r2', 'r3']) server.addRecord(jobId, { id, contactId: 'c1', kind: 'call', at: '2026-10-26T16:00:00Z', summary: `Call ${id}`, outcome: 'answered', fields: {} });
    const page1 = await a.results(jobId);
    assert.deepStrictEqual([page1.records.map((r) => r.id), page1.next], [['r1', 'r2'], 'r2']);
    const page2 = await a.results(jobId, { after: page1.next });
    assert.deepStrictEqual([page2.records.map((r) => r.id), page2.next], [['r3'], undefined]);
  });

  it('cancels and finds a job by externalRef', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-6', externalRef: 'case-7/job-0006' }), null);
    assert.deepStrictEqual(await a.findByExternalRef('case-7/job-0006'), { jobId, contacts: [{ id: 'c1', address: '+15550100', normalizedAddress: '+15550100' }] });
    assert.strictEqual(await a.findByExternalRef('case-7/job-9999'), null);
    assert.deepStrictEqual(await a.cancel(jobId), { state: 'cancelled' });
    assert.strictEqual(server.state.requests.at(-1).method, 'DELETE');
  });

  it('turns a record into facts: the summary and each expected answer', () => {
    const facts = adapter().recordToFacts({
      id: 'r9', contactId: 'c1', kind: 'call', at: '2026-10-26T16:00:00Z', summary: 'Broker says the listing shows 2.5 acres',
      outcome: 'answered', fields: { q1: { value: 2.5, type: 'number', unit: 'acres' }, q7: { value: 'ignored' } }
    }, { ...job(), contacts: [{ id: 'c1', normalizedAddress: '+15550100' }] });
    assert.deepStrictEqual(facts.map((f) => [f.subject, f.attr, f.value, f.unit ?? null]), [
      ['contact:c1', 'call-outcome', 'answered', null],
      ['lot', 'acreage', 2.5, 'acres']
    ]);
    const money = adapter().recordToFacts({ id: 'r10', contactId: 'c1', kind: 'call', summary: 'Quote', outcome: 'answered', fields: { q1: { value: 1200, type: 'money', unit: 'USD' } } }, job());
    assert.strictEqual(money[1].category, 'financial');
  });

  it('carries brief rules for the calling agent', () => {
    assert.ok(adapter().briefRules().length >= 3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/executor-phone-agent.test.js`
Expected: FAIL with `Cannot find module '../examples/executors/phone-agent/adapter'`

- [ ] **Step 3: Implement**

Create `examples/executors/phone-agent/package.json`:

```json
{
  "name": "kl-executor-phone-agent",
  "version": "1.0.0",
  "private": true,
  "description": "King Louie executor for a phone agent behind a generic HTTP errands API",
  "main": "adapter.js",
  "license": "MIT",
  "kingLouie": {
    "executor": {
      "apiVersion": 1,
      "id": "phone-agent",
      "kind": "external-agent",
      "capabilities": ["call", "voicemail"],
      "cannot": ["web-form", "email", "sms"],
      "configSchema": {
        "baseUrl": { "type": "string", "required": true },
        "token": { "type": "string", "secret": true, "required": true },
        "defaultCountryCode": { "type": "string" }
      },
      "payloadSchema": { "venue": { "type": "string" } },
      "origins": ["config:baseUrl"]
    }
  }
}
```

Create `examples/executors/phone-agent/adapter.js`:

```js
'use strict';
// Reference King Louie executor adapter for a phone agent behind a generic
// HTTP errands API (openapi.yaml in this folder). It reaches the network only
// through host.fetch, which King Louie limits to this package's origins.

const JOB_STATES = Object.freeze({
  queued: 'submitted', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', cancelled: 'cancelled'
});
const STATUS_CODES = Object.freeze({ 401: 'auth', 403: 'auth', 404: 'not-found', 409: 'conflict', 422: 'invalid', 429: 'rate-limited' });
// Payload keys the node defines; anything else is a payloadSchema field.
const BASE_KEYS = new Set(['recipients', 'text', 'facts', 'attemptsPerContact', 'expect']);

class ErrandsError extends Error {
  constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ErrandsError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function codeFor(status) {
  if (STATUS_CODES[status]) return STATUS_CODES[status];
  return status >= 500 ? 'unavailable' : 'error';
}

function createAdapter(config, host) {
  const base = String(config.baseUrl).replace(/\/+$/, '');

  async function call(method, pathname, { body, headers = {}, query = {} } = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await host.fetch(url.toString(), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (err) {
      throw new ErrandsError('unavailable', `errands API unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const retryAfterSeconds = res.status === 429 ? Number(res.headers.get('retry-after')) || null : null;
      throw new ErrandsError(codeFor(res.status), json?.error?.message || `errands API answered ${res.status}`, { status: res.status, retryAfterSeconds });
    }
    return json;
  }

  const contactsOf = (j) => (j?.contacts || []).map((c) => ({ id: c.id, address: c.address, normalizedAddress: c.normalizedAddress }));

  return {
    capabilities() {
      return { capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'], constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' };
    },

    // job.recipients are the node's normalized addresses, in payload order.
    async submit(job, envelope) {
      const p = job.payload || {};
      const extra = {};
      for (const k of Object.keys(p)) if (!BASE_KEYS.has(k)) extra[k] = p[k];
      const body = {
        externalRef: job.externalRef,
        intent: job.intent || envelope?.intent || '',
        text: p.text,
        recipients: (p.recipients || []).map((r, i) => ({ address: job.recipients[i], ...(r.name ? { name: r.name } : {}) })),
        facts: (job.facts || []).map((f) => ({ id: f.id, statement: f.stmt, value: f.value })),
        expect: (Array.isArray(p.expect) ? p.expect : []).map((e, i) => ({ key: `q${i + 1}`, question: e.question })),
        ...(job.maxCostUsd === null || job.maxCostUsd === undefined ? {} : { maxCostUsd: job.maxCostUsd }),
        maxAttemptsPerContact: p.attemptsPerContact || 1,
        window: job.window,
        ...(Object.keys(extra).length ? { extra } : {})
      };
      const j = await call('POST', '/jobs', { body, headers: { 'idempotency-key': job.idempotencyKey } });
      return { jobId: j.id, contacts: contactsOf(j) };
    },

    async findByExternalRef(ref) {
      const r = await call('GET', '/jobs', { query: { externalRef: ref } });
      const j = (r?.jobs || [])[0];
      return j ? { jobId: j.id, contacts: contactsOf(j) } : null;
    },

    async status(jobId) {
      const j = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
      return {
        state: JOB_STATES[j.state] || 'running',
        contacts: (j.contacts || []).map((c) => ({
          id: c.id, address: c.address, normalizedAddress: c.normalizedAddress, state: c.state,
          attempts: c.attempts || 0, lastAttemptAt: c.lastAttemptAt || null
        })),
        lastChange: j.updatedAt || null,
        ...(Number.isFinite(j.costUsd) ? { costUsd: j.costUsd } : {})
      };
    },

    async results(jobId, { after } = {}) {
      const r = await call('GET', `/jobs/${encodeURIComponent(jobId)}/results`, { query: { after } });
      return { records: r?.records || [], ...(r?.next ? { next: r.next } : {}) };
    },

    async cancel(jobId) {
      const j = await call('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
      return { state: JOB_STATES[j?.state] || 'cancelled' };
    },

    briefRules() {
      return [
        'Say in the first sentence who you are calling for and why.',
        'Never agree to a price, date or commitment; say the owner will confirm.',
        'If asked for anything you were not given, say you will pass the question on.'
      ];
    },

    // The summary becomes one fact on the contact; each expected answer
    // becomes a fact on the subject and attribute the node asked about.
    recordToFacts(record, job) {
      const contact = (job.contacts || []).find((c) => c.id === record.contactId);
      const who = contact?.normalizedAddress || contact?.address || record.contactId;
      const facts = [{
        stmt: `${record.kind} ${who}: ${record.summary}`,
        subject: `contact:${record.contactId}`,
        attr: `${record.kind}-outcome`,
        value: record.outcome || record.summary
      }];
      const expect = Array.isArray(job.payload?.expect) ? job.payload.expect : [];
      for (const [key, field] of Object.entries(record.fields || {})) {
        const m = /^q(\d+)$/.exec(key);
        const e = m ? expect[Number(m[1]) - 1] : null;
        if (!e) continue;
        const f = field && typeof field === 'object' ? field : { value: field };
        facts.push({
          stmt: `${e.question} ${who} answered: ${f.value}${f.unit ? ` ${f.unit}` : ''}`,
          subject: e.subject,
          attr: e.attr,
          value: f.value,
          unit: f.unit || null,
          ...(f.type === 'money' ? { category: 'financial' } : {})
        });
      }
      return facts;
    }
  };
}

module.exports = { createAdapter, ErrandsError };
```

Create `examples/executors/phone-agent/openapi.yaml`:

```yaml
openapi: 3.1.0
info:
  title: Errands API
  version: 1.0.0
  description: >
    The generic HTTP errands API the King Louie phone-agent executor speaks.
    A provider runs a phone agent that places calls on the node's behalf and
    reports what happened. King Louie polls; the webhook only hints to poll.
servers:
  - url: https://errands.example.com
security:
  - bearer: []
paths:
  /jobs:
    post:
      summary: Create a job
      description: >
        A retry with the same Idempotency-Key and the same body returns the
        existing job (200). The same key with a different body is 409.
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string, description: "sha256hex(JCS({caseId, envelopeId, n}))" }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/JobRequest' }
      responses:
        '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '200': { description: Idempotent replay, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '409': { $ref: '#/components/responses/Error' }
        '422': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
        '5XX': { $ref: '#/components/responses/Error' }
    get:
      summary: Find jobs by external reference
      parameters:
        - name: externalRef
          in: query
          required: true
          schema: { type: string, description: "<caseId>/<jobId>, never a slug" }
      responses:
        '200':
          description: Matching jobs
          content:
            application/json:
              schema:
                type: object
                required: [jobs]
                properties:
                  jobs: { type: array, items: { $ref: '#/components/schemas/Job' } }
  /jobs/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      summary: Job status
      responses:
        '200': { description: The job, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '404': { $ref: '#/components/responses/Error' }
    delete:
      summary: Cancel a job
      responses:
        '200': { description: The cancelled job, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '404': { $ref: '#/components/responses/Error' }
  /jobs/{id}/results:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
      - { name: after, in: query, required: false, schema: { type: string, description: Id of the last record already seen } }
    get:
      summary: Results after a cursor, oldest first
      responses:
        '200':
          description: A page of records
          content:
            application/json:
              schema:
                type: object
                required: [records]
                properties:
                  records: { type: array, items: { $ref: '#/components/schemas/Record' } }
                  next: { type: [string, 'null'], description: Pass as `after` to get the next page }
        '404': { $ref: '#/components/responses/Error' }
webhooks:
  jobChanged:
    post:
      summary: Optional hint that a job changed; King Louie stage 3 ignores the body and polls
      parameters:
        - { name: X-Errands-Signature, in: header, required: true, schema: { type: string, description: HMAC-SHA256 of the body with a shared secret } }
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { jobId: { type: string }, externalRef: { type: string } } }
      responses:
        '204': { description: Accepted }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  responses:
    Error:
      description: "Error. Status mapping: 401/403 auth, 404 not-found, 409 conflict, 422 invalid, 5xx unavailable."
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
    RateLimited:
      description: Too many requests
      headers:
        Retry-After: { schema: { type: integer, description: Seconds to wait } }
      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
  schemas:
    Error:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code: { type: string, enum: [auth, not-found, conflict, invalid, rate-limited, unavailable, forced] }
            message: { type: string }
    JobRequest:
      type: object
      required: [externalRef, text, recipients, maxAttemptsPerContact, window]
      properties:
        externalRef: { type: string, description: "<caseId>/<jobId>" }
        intent: { type: string }
        text: { type: string, description: What the agent says; already passed King Louie's outbound gate }
        recipients:
          type: array
          minItems: 1
          items:
            type: object
            required: [address]
            properties:
              address: { type: string, description: E.164 phone number }
              name: { type: string }
        facts:
          type: array
          items:
            type: object
            properties: { id: { type: string }, statement: { type: string }, value: {} }
        expect:
          type: array
          description: Questions whose answers come back in Record.fields under the same key
          items:
            type: object
            required: [key, question]
            properties: { key: { type: string, pattern: '^q[0-9]+$' }, question: { type: string } }
        maxCostUsd: { type: number, minimum: 0 }
        maxAttemptsPerContact: { type: integer, minimum: 1 }
        window:
          type: object
          required: [notBefore, notAfter, tz]
          properties:
            notBefore: { type: string, format: date-time }
            notAfter: { type: string, format: date-time }
            tz: { type: string, description: IANA zone the window days were computed in }
        extra: { type: object, description: Package payloadSchema fields (strings, numbers, booleans) }
    Job:
      type: object
      required: [id, state, externalRef, contacts]
      properties:
        id: { type: string }
        state: { type: string, enum: [queued, running, waiting, done, failed, cancelled] }
        externalRef: { type: string }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
        costUsd: { type: number, description: Total cost so far }
        contacts:
          type: array
          items:
            type: object
            required: [id, address, normalizedAddress, state]
            properties:
              id: { type: string }
              address: { type: string }
              normalizedAddress: { type: string, description: The number the provider will dial; must equal the node's }
              state: { type: string, enum: [pending, in-progress, answered, no-answer, voicemail, failed, refused] }
              attempts: { type: integer }
              lastAttemptAt: { type: [string, 'null'], format: date-time }
    Record:
      type: object
      required: [id, contactId, kind, at, summary]
      properties:
        id: { type: string }
        contactId: { type: string }
        kind: { type: string, enum: [call, voicemail, sms] }
        at: { type: string, format: date-time }
        summary: { type: string }
        outcome: { type: string, enum: [answered, no-answer, voicemail, refused, failed] }
        fields:
          type: object
          additionalProperties:
            type: object
            required: [value]
            properties:
              value: {}
              type: { type: string, enum: [text, number, money, date] }
              unit: { type: string }
```

Create `examples/executors/phone-agent/README.md`:

````markdown
# phone-agent executor

A King Louie executor for a phone agent behind a generic HTTP errands API
(`openapi.yaml`). King Louie hands it approved call jobs, polls their status
and saves each call record under the case's `sources/phone-agent/`.

## Install (desktop)

1. Copy this folder to `<data directory>/executors/phone-agent/`. The packaged
   app does not load executors from anywhere else.
2. Store the provider token in the vault under a key of your choice, for
   example `errands-token`.
3. Add the entry to `settings.executors.entries`:

   ```json
   {
     "phone-agent": {
       "kind": "external-agent",
       "package": "phone-agent",
       "packageSha256": "",
       "config": { "baseUrl": "https://errands.example.com", "token": "${vault:errands-token}" },
       "constraints": { "contactsPerDay": 20, "callingWindow": { "tz": "America/Chicago", "start": "09:00", "end": "17:00", "weekdays": [1, 2, 3, 4, 5] } },
       "cost": { "perJob": 0.5, "perContact": 0.25, "perAttempt": 0.4 },
       "latency": "async-hours"
     }
   }
   ```

4. Open the executor list (`executors:list`). It shows
   `pin required: set packageSha256 to <hash>`; copy that hash into
   `packageSha256`. Any later change to a file in this folder makes the
   executor unavailable until you pin the new hash.

## Install (service)

Put the folder under a directory listed in the admin `service.json`
`executors.packageRoots` (root-owned), and the entry under the admin
`service.json` `executors.entries`. Entries in the data directory are ignored.

## Trust

The adapter runs inside King Louie with full privileges; there is no sandbox.
It is given only its config (with the token resolved from the vault) and a
`fetch` limited to `baseUrl`'s origin, but code in this folder could still
reach the network or disk directly. The protections are the load root, the
required pin and that the `Skill` tool cannot reach executor packages. Read
the code before you pin it.
````

- [ ] **Step 4: Run the tests**

Run: `node --test tests/executor-phone-agent.test.js tests/cases-executor-package.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add examples/executors/phone-agent tests/helpers/fake-errands-server.js tests/executor-phone-agent.test.js
git commit -m "feat(cases): reference phone-agent executor for a generic errands API, with its OpenAPI contract

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Job lifecycle — commit, polling, charging, the snapshot, cancel

**Files:**
- Create: `src/cases/executors/jobs.js`
- Modify: `src/cases/executors/registry.js` (the `job-store` require line and the `// ---- operations (Tasks 9–12) ----` marker)
- Test: `tests/cases-executor-jobs.test.js`

**Interfaces:**
- Consumes: `JobStore`, `readSnapshot`, `writeSnapshot`, `OPEN_STATES`, `TERMINAL_STATES`, `isOpen` (Task 7); `EnvelopeStore` (Task 4); `PlanStore.updateStep` (Task 5); `readJsonSafe`, `writeJsonAtomic`, `roundUsd` (Task 1); registry `get`, `adapter`, `settings`, `now`, `caseDir`, `indexJob`, `releaseContacts`, `runsDir`, `running`, `inFlight`, `getWorkflowEngine`, `getRunbookEngine` (Task 7); C2 `systemAction`, `budget(id).charge`, `onCrossings`, `wakeups(id).register/cancel`, `questions(id).get/close`, `records(id).writeJournal`, `CaseBusyError` (by `name`).
- Produces (`jobs.js`, every function takes the registry first):
  - `kindOf(entry) → 'external' | 'browser' | 'workflow' | 'runbook' | 'owner' | 'direct'`; `runDir(reg, caseId, jobId)`; `readRunStatus`, `writeRunStatus(reg, caseId, jobId, status)` (`status.json`: `{ state, startedAt?, finishedAt?, error? }`); `mergeContacts(current, incoming)`; `updateEnvelope(caseDir, envelopeId, fn)`.
  - `commitSubmit(reg, caseId, job, submitted) → job` (spec §3.5 step 13).
  - `refreshCase(reg, caseId, { force, budgetMs, jobIds }) → { material, snapshot }` (under `systemAction`; the one charging point for executor cost; writes `.kl/executors.json`).
  - `pollWakeup(reg, caseId, wakeup) → { material }` (R48).
  - `cancelJob(reg, caseId, jobId, reason) → { ok, job, note? } | { ok: false, error }`; `cancelOpenJobs(reg, caseId, reason) → { cancelled }`; `cancelJobAsOwner(reg, caseId, jobId, reason)` (in `systemAction`, `CaseBusyError` → the busy message).
  - `reconcileSubmitting(reg, caseId) → [{ jobId, state }]`; `copyBackgroundOutput(reg, caseId) → jobIds`.
  - Registry methods: `refreshCase(caseId, opts)`, `pollWakeup(caseId, wakeup)`, `cancelOpenJobs(caseId, reason)`, `cancelJob(caseId, jobId, reason)`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-executor-jobs.test.js`:

```js
// tests/cases-executor-jobs.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { JobStore, EnvelopeStore, PlanStore } = require('../src/cases/executors');
const jobs = require('../src/cases/executors/jobs');
const { readJsonSafe, writeJsonAtomic } = require('../src/cases/executors/util');

after(fx.cleanup);

async function setup(agentOpts = {}) {
  const env = fx.setupExecutors();
  const ctl = fx.withFakeAgent(env, 'fake-agent', agentOpts);
  const meta = await fx.activeCase(env.runtime);
  return { env, ctl, meta, reg: env.registry, dir: meta.dir };
}

function seed(dir) {
  new PlanStore(dir).write({ id: 'plan-001', status: 'approved', steps: [{ id: 's1', title: 'Call brokers', executor: 'fake-agent', capability: 'call', state: 'pending', jobIds: [] }] });
  new EnvelopeStore(dir).write({
    id: 'env-01', version: 1, status: 'active', executor: 'fake-agent', intent: 'Ask for a listing quote',
    recipients: { allow: ['+15550100'] }, facts: [], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
    window: { start: '2026-10-26', end: '2026-10-30', tz: 'UTC' }, usage: { usd: 0, contacts: [], attempts: {} }, payloads: [], deltas: []
  });
}

async function submitted({ reg, meta, dir }, over = {}) {
  seed(dir);
  const payload = { recipients: [{ address: '+15550100' }], text: 'Hello about the lot', attemptsPerContact: 1 };
  const job = new JobStore(dir).create({
    caseId: meta.id, executor: 'fake-agent', kind: 'external', envelopeId: 'env-01', planStepId: 's1', n: 1,
    signature: 'sig-1', payloadHash: 'hash-1', intent: 'Ask for a listing quote', recipients: ['+15550100'],
    payload, originalPayload: payload, estimateUsd: 2, newContacts: 1, reservedContacts: 1, createdAt: reg.now().toISOString(), ...over
  });
  const adapter = await reg.adapter('fake-agent');
  const res = await adapter.submit({ ...job, externalRef: `${meta.id}/${job.id}` }, null);
  return jobs.commitSubmit(reg, meta.id, job, res);
}

const budgetSpent = (env, id, category) => env.runtime.budget(id).status()[category].spent;

describe('commitSubmit', () => {
  it('records the payload, charges contacts, registers the poll and moves the step', async () => {
    const s = await setup();
    const job = await submitted(s);
    assert.deepStrictEqual([job.state, job.externalId], ['submitted', 'ext-1']);
    const wakeup = s.env.runtime.wakeups(s.meta.id).list().find((w) => w.id === job.wakeupId);
    assert.deepStrictEqual([wakeup.kind, wakeup.everyMs, wakeup.payload], ['poll-executor', 60000, { key: `poll:${job.id}`, executor: 'fake-agent', jobId: job.id }]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'contactsPerDay'), 1);
    const envelope = new EnvelopeStore(s.dir).get('env-01');
    assert.deepStrictEqual([envelope.payloads.length, envelope.payloads[0].n, envelope.usage.contacts, envelope.usage.attempts], [1, 1, ['+15550100'], { '+15550100': 1 }]);
    const step = new PlanStore(s.dir).read().steps[0];
    assert.deepStrictEqual([step.state, step.jobIds], ['in-flight', [job.id]]);
    const journal = fs.readdirSync(path.join(s.dir, 'journal')).filter((n) => n.endsWith('-envelope.md'));
    assert.strictEqual(journal.length, 1);
    assert.match(fs.readFileSync(path.join(s.dir, 'journal', journal[0]), 'utf8'), /Payload as sent:[\s\S]*Hello about the lot/);
    assert.deepStrictEqual(s.reg.liveState({ caseId: s.meta.id }).map((r) => [r.jobId, r.state]), [[job.id, 'submitted']]);
  });
});

describe('refreshCase', () => {
  it('charges reported cost once, settles the job and reports a material change', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'done';
    s.ctl.jobs.get('ext-1').costUsd = 1.25;
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:10:00Z';
    const r = await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(r.material, true);
    const done = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([done.state, done.chargedUsd, done.wakeupId], ['done', 1.25, null]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 1.25);
    assert.strictEqual(s.env.runtime.wakeups(s.meta.id).list().some((w) => w.kind === 'poll-executor'), false);
    const plan = new PlanStore(s.dir).read();
    assert.deepStrictEqual([plan.steps[0].state, plan.status], ['done', 'done']);
    const snap = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null);
    assert.deepStrictEqual(snap['fake-agent'].material, { openJobs: 0, lastChange: '2026-10-26T15:10:00Z', failedJobs: 0, unreachableJobs: 0 });
    assert.deepStrictEqual(snap['fake-agent'].state.jobs[job.id], { externalId: 'ext-1', state: 'done' });
    assert.strictEqual((await s.reg.refreshCase(s.meta.id, { force: true })).material, false);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25, 'charged once');
  });

  it('charges the estimate when a finished job never reported a cost', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'done';
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(new JobStore(s.dir).get(job.id).chargedUsd, 2);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 2);
  });

  it('poll failure goes stale, then unreachable', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:01:00Z';
    await s.reg.refreshCase(s.meta.id, { force: true });
    const good = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'].fetchedAt;
    s.ctl.statusThrows = 5;
    const t0 = s.env.clock.now.getTime();
    const first = await s.reg.refreshCase(s.meta.id, { force: true });
    let j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.stale, j.pollErrors, j.error], ['running', true, 1, 'errands API unavailable'], 'the last good state is kept');
    assert.strictEqual(Date.parse(j.nextPollAt) - t0, 120000, 'backoff is pollEveryMs × 2');
    const snap = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'];
    assert.deepStrictEqual([snap.stale, snap.error, snap.fetchedAt], [true, 'errands API unavailable', good]);
    assert.strictEqual(first.material, false, 'stale is never material');
    const polls = s.ctl.calls.filter((c) => c[0] === 'status').length;
    await s.reg.refreshCase(s.meta.id);
    assert.strictEqual(s.ctl.calls.filter((c) => c[0] === 'status').length, polls, 'the backoff is respected without force');
    await s.reg.refreshCase(s.meta.id, { force: true });
    j = new JobStore(s.dir).get(job.id);
    assert.strictEqual(Date.parse(j.nextPollAt) - t0, 240000, 'backoff doubles');
    await s.reg.refreshCase(s.meta.id, { force: true });
    await s.reg.refreshCase(s.meta.id, { force: true });
    const last = await s.reg.refreshCase(s.meta.id, { force: true });
    j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.stale, j.pollErrors], ['unreachable', false, 5]);
    assert.strictEqual(last.material, true);
    const after5 = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'];
    assert.deepStrictEqual([after5.stale, after5.material.unreachableJobs], [false, 1]);
    const lines = fs.readdirSync(path.join(s.dir, 'journal')).filter((n) => n.includes('-envelope'))
      .map((n) => fs.readFileSync(path.join(s.dir, 'journal', n), 'utf8'));
    assert.ok(lines.some((t) => /unreachable after 5 failed polls/.test(t)));
    assert.strictEqual(new PlanStore(s.dir).read().steps[0].state, 'failed');
  });
});

describe('pollWakeup', () => {
  it('reports material on a change and quiet otherwise', async () => {
    const s = await setup();
    const job = await submitted(s);
    const wakeup = { id: job.wakeupId, kind: 'poll-executor', payload: { key: `poll:${job.id}`, executor: 'fake-agent', jobId: job.id } };
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: true }, 'first snapshot');
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: false });
    s.ctl.jobs.get('ext-1').state = 'waiting';
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:20:00Z';
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: true });
  });
});

describe('cancel', () => {
  it('cancels at the executor, stops polling and fails the step', async () => {
    const s = await setup();
    const job = await submitted(s);
    const r = await jobs.cancelJob(s.reg, s.meta.id, job.id, 'cancelled');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(s.ctl.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'ext-1']]);
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.wakeupId], ['cancelled', null]);
    const step = new PlanStore(s.dir).read().steps[0];
    assert.deepStrictEqual([step.state, step.reason], ['failed', 'cancelled']);
    assert.deepStrictEqual(await jobs.cancelJob(s.reg, s.meta.id, job.id, 'again'), { ok: false, error: `${job.id} is already cancelled.` });
  });

  it('releases the reservation of a job cancelled while submitting', async () => {
    const s = await setup();
    await s.reg.reserveContacts('fake-agent', 2, { caseId: s.meta.id });
    const job = new JobStore(s.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', reservedContacts: 2 });
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 3);
    await jobs.cancelJob(s.reg, s.meta.id, job.id, 'case paused');
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 5);
  });

  it('cancelOpenJobs cancels every open job of the case', async () => {
    const s = await setup();
    const job = await submitted(s);
    assert.deepStrictEqual(await s.reg.cancelOpenJobs(s.meta.id, 'case abandoned'), { cancelled: [job.id] });
    assert.deepStrictEqual(await s.reg.cancelOpenJobs(s.meta.id, 'again'), { cancelled: [] });
  });
});

describe('reconcile and background output', () => {
  it('commits a submitting job the executor has, fails one it does not', async () => {
    const s = await setup({ findByExternalRef: true });
    seed(s.dir);
    const store = new JobStore(s.dir);
    const known = store.create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', recipients: ['+15550100'], envelopeId: 'env-01' });
    const lost = store.create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', recipients: ['+15550101'] });
    const adapter = await s.reg.adapter('fake-agent');
    await adapter.submit({ ...known, externalRef: `${s.meta.id}/${known.id}` }, null);
    const out = await jobs.reconcileSubmitting(s.reg, s.meta.id);
    assert.deepStrictEqual(out, [{ jobId: known.id, state: 'submitted' }, { jobId: lost.id, state: 'failed' }]);
    assert.deepStrictEqual([store.get(lost.id).state, store.get(lost.id).reason], ['failed', 'interrupted']);
    assert.strictEqual(store.get(known.id).externalId, 'ext-1');
  });

  it('copies finished background output into sources/', async () => {
    const s = await setup();
    const job = new JobStore(s.dir).create({ caseId: s.meta.id, executor: 'runbook', kind: 'runbook', state: 'running' });
    const run = jobs.runDir(s.reg, s.meta.id, job.id);
    writeJsonAtomic(path.join(run, 'output.json'), { success: true });
    assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [], 'nothing until the run finishes');
    jobs.writeRunStatus(s.reg, s.meta.id, job.id, { state: 'done', finishedAt: '2026-10-26T15:30:00Z' });
    assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [job.id]);
    assert.deepStrictEqual(readJsonSafe(path.join(s.dir, 'sources', 'runbook', job.id, 'output.json'), null), { success: true });
    assert.deepStrictEqual([new JobStore(s.dir).get(job.id).state, new JobStore(s.dir).get(job.id).copied], ['done', true]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-executor-jobs.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/jobs'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/jobs.js`:

```js
// src/cases/executors/jobs.js
// Job lifecycle (cases stage 3 spec §3.5 step 13, §3.12, §3.13): commit a
// submitted job, poll open jobs, charge reported cost, settle terminal jobs,
// write the .kl/executors.json snapshot, cancel, reconcile, and copy
// background output into the case. Every function takes the registry first.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { JobStore, readSnapshot, writeSnapshot, TERMINAL_STATES, isOpen } = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const { PlanStore } = require('./plan');
const { readJsonSafe, writeJsonAtomic, roundUsd } = require('./util');

const log = createLogger('executors/jobs');
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const MIN_POLL_MS = 60 * 1000;
const BUSY = 'Case is busy with a wake-up; try again in a minute.';

const runKey = (caseId, jobId) => `${caseId}/${jobId}`;
const isTerminal = (state) => TERMINAL_STATES.includes(state);

function kindOf(entry) {
  if (!entry) return 'external';
  if (entry.kind === 'external-agent') return 'external';
  if (entry.direct) return 'direct';
  return entry.id;
}

function runDir(reg, caseId, jobId) {
  return path.join(reg.runsDir, caseId, jobId);
}

function readRunStatus(reg, caseId, jobId) {
  return readJsonSafe(path.join(runDir(reg, caseId, jobId), 'status.json'), null);
}

function writeRunStatus(reg, caseId, jobId, status) {
  writeJsonAtomic(path.join(runDir(reg, caseId, jobId), 'status.json'), status);
}

function mergeContacts(current = [], incoming = []) {
  const byId = new Map((current || []).map((c) => [c.id, { ...c }]));
  for (const c of incoming || []) {
    if (!c || c.id === undefined) continue;
    const defined = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
    byId.set(c.id, { ...(byId.get(c.id) || {}), ...defined });
  }
  return [...byId.values()];
}

function updateEnvelope(caseDir, envelopeId, fn) {
  if (!envelopeId) return null;
  const store = new EnvelopeStore(caseDir);
  const env = store.get(envelopeId);
  if (!env) return null;
  env.usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  fn(env);
  return store.write(env);
}

function chargeUsd(reg, caseId, amount, meta) {
  if (!amount) return;
  const rt = reg.caseRuntime;
  const r = rt.budget(caseId).charge('usd', amount, meta);
  if (r && Array.isArray(r.crossedNow) && r.crossedNow.length) rt.onCrossings(caseId, 'usd', r.crossedNow);
}

// The one charging point for executor cost: charge the difference from what
// was already charged, and count it against the envelope.
function chargeTo(reg, caseId, caseDir, job, costUsd) {
  const delta = roundUsd(Number(costUsd) - (Number(job.chargedUsd) || 0));
  if (!delta) return;
  chargeUsd(reg, caseId, delta, { executor: job.executor, jobId: job.id });
  job.chargedUsd = roundUsd(costUsd);
  updateEnvelope(caseDir, job.envelopeId, (env) => {
    env.usage.usd = roundUsd((Number(env.usage.usd) || 0) + delta);
  });
}

function finishJob(reg, caseId, caseDir, job) {
  if (job.submittedAt && !job.costReported && (Number(job.estimateUsd) || 0) > (Number(job.chargedUsd) || 0)) {
    chargeTo(reg, caseId, caseDir, job, job.estimateUsd);
  }
  if (job.wakeupId) {
    try {
      reg.caseRuntime.wakeups(caseId).cancel(job.wakeupId);
    } catch (err) {
      log.warn(`Cancelling the poll for ${job.id} failed: ${err.message}`);
    }
    job.wakeupId = null;
  }
  if (job.planStepId) {
    const done = job.state === 'done';
    new PlanStore(caseDir).updateStep(job.planStepId, done
      ? { state: 'done' }
      : { state: 'failed', reason: job.state === 'cancelled' ? 'cancelled' : (job.reason || job.state) });
  }
}

function applyStatus(reg, caseId, caseDir, job, status, now) {
  const before = job.state;
  if (status.state && status.state !== before && !isTerminal(before)) {
    job.state = status.state;
    job.lastChange = status.lastChange || now.toISOString();
  } else if (status.lastChange && String(status.lastChange) > String(job.lastChange || '')) {
    job.lastChange = status.lastChange;
  }
  if (Array.isArray(status.contacts)) job.contacts = mergeContacts(job.contacts, status.contacts);
  if (typeof status.costUsd === 'number' && Number.isFinite(status.costUsd)) {
    job.costReported = true;
    chargeTo(reg, caseId, caseDir, job, status.costUsd);
  }
  if (isTerminal(job.state) && !isTerminal(before)) finishJob(reg, caseId, caseDir, job);
}

async function statusFromSource(reg, caseId, job) {
  if (job.kind === 'external') {
    if (!job.externalId) return null;
    const adapter = await reg.adapter(job.executor);
    return adapter.status(job.externalId);
  }
  if (job.kind === 'workflow' || job.kind === 'runbook') {
    const st = readRunStatus(reg, caseId, job.id);
    return st ? { state: st.state, lastChange: st.finishedAt || st.startedAt || null } : null;
  }
  if (job.kind === 'owner') {
    const q = job.questionId ? reg.caseRuntime.questions(caseId).get(job.questionId) : null;
    if (!q) return null;
    if (q.answer) {
      job.resultFactId = q.answer.factId || null;
      return { state: 'done', lastChange: q.answer.at };
    }
    if (q.closed) return { state: 'cancelled', lastChange: q.closed.at };
  }
  return null;
}

async function pollJob(reg, caseId, caseDir, job, settings, now) {
  const entry = reg.get(job.executor, { caseId });
  const every = Math.max(MIN_POLL_MS, Number(entry?.pollEveryMs) || settings.pollEveryMs);
  try {
    const status = await statusFromSource(reg, caseId, job);
    job.lastPolledAt = now.toISOString();
    job.pollErrors = 0;
    job.stale = false;
    job.error = null;
    job.nextPollAt = new Date(now.getTime() + every).toISOString();
    if (status) applyStatus(reg, caseId, caseDir, job, status, now);
  } catch (err) {
    job.pollErrors = (Number(job.pollErrors) || 0) + 1;
    job.error = err.message;
    if (job.pollErrors >= settings.maxPollErrors) {
      // Unreachable is material; stale is cleared so C2's trigger compares it.
      job.state = 'unreachable';
      job.stale = false;
      job.nextPollAt = null;
      job.lastChange = now.toISOString();
      job.reason = `unreachable after ${job.pollErrors} failed polls: ${err.message}`;
      finishJob(reg, caseId, caseDir, job);
      reg.caseRuntime.records(caseId).writeJournal('envelope', `Job ${job.id} on ${job.executor} is unreachable after ${job.pollErrors} failed polls: ${err.message}`, now);
    } else {
      job.stale = true;
      job.nextPollAt = new Date(now.getTime() + Math.min(every * 2 ** job.pollErrors, SIX_HOURS_MS)).toISOString();
    }
  }
}

// Program §4.7. stale, fetchedAt, error and state are never material.
function buildSnapshot(reg, caseId, allJobs, before) {
  const next = {};
  for (const [id, e] of Object.entries(before || {})) if (e && e.override) next[id] = { override: e.override };
  const byExecutor = new Map();
  for (const j of allJobs) {
    if (!byExecutor.has(j.executor)) byExecutor.set(j.executor, []);
    byExecutor.get(j.executor).push(j);
  }
  for (const [id, list] of byExecutor) {
    if (list.every((j) => j.kind === 'direct')) continue;
    const open = list.filter((j) => isOpen(j.state));
    const lastChange = list.map((j) => j.lastChange).filter(Boolean).sort().pop() || null;
    const kind = list[0].kind;
    const material = kind === 'owner'
      ? { openTasks: open.length, lastChange }
      : {
        openJobs: open.length,
        lastChange,
        failedJobs: list.filter((j) => j.state === 'failed').length,
        unreachableJobs: list.filter((j) => j.state === 'unreachable').length
      };
    const staleJob = open.find((j) => j.stale);
    next[id] = {
      ...(next[id] || {}),
      fetchedAt: list.map((j) => j.lastPolledAt).filter(Boolean).sort().pop() || null,
      stale: Boolean(staleJob),
      error: staleJob ? staleJob.error : null,
      state: { jobs: Object.fromEntries(list.map((j) => [j.id, { externalId: j.externalId || null, state: j.state }])) },
      material
    };
  }
  return next;
}

function materialChanged(before, next) {
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(next || {})]);
  for (const id of ids) {
    if (JSON.stringify(before?.[id]?.material ?? {}) !== JSON.stringify(next?.[id]?.material ?? {})) return true;
  }
  return false;
}

async function refreshCase(reg, caseId, { force = false, budgetMs = null, jobIds = null } = {}) {
  return reg.caseRuntime.systemAction(caseId, 'executor refresh', async (meta) => {
    const caseDir = meta.dir;
    const store = new JobStore(caseDir);
    const settings = reg.settings();
    const now = reg.now();
    const limit = Number.isFinite(budgetMs) ? budgetMs : settings.refreshBudgetMs;
    const started = Date.now();
    const open = store.list()
      .filter((j) => isOpen(j.state) && j.state !== 'submitting' && (!jobIds || jobIds.includes(j.id)))
      .sort((a, b) => String(a.lastPolledAt || '').localeCompare(String(b.lastPolledAt || '')));
    for (const job of open) {
      if (Date.now() - started > limit) break;
      if (!force && job.nextPollAt && Date.parse(job.nextPollAt) - now.getTime() > GRACE_MS) continue;
      await pollJob(reg, caseId, caseDir, job, settings, now);
      store.write(job);
      await reg.indexJob(caseId, job);
    }
    const before = readSnapshot(caseDir);
    const next = buildSnapshot(reg, caseId, store.list(), before);
    const material = materialChanged(before, next);
    writeSnapshot(caseDir, next);
    return { material, snapshot: next };
  });
}

// R48: C2's sweep calls this for a due poll-executor wake-up, with no model.
async function pollWakeup(reg, caseId, wakeup) {
  const jobId = wakeup?.payload?.jobId || null;
  const r = await refreshCase(reg, caseId, { jobIds: jobId ? [jobId] : null });
  return { material: Boolean(r.material) };
}

async function commitSubmit(reg, caseId, job, submitted = {}) {
  const rt = reg.caseRuntime;
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const now = reg.now();
  const entry = reg.get(job.executor, { caseId });
  job.state = submitted.state || 'submitted';
  job.externalId = submitted.jobId ?? job.externalId ?? null;
  if (Array.isArray(submitted.contacts)) job.contacts = mergeContacts(job.contacts, submitted.contacts);
  job.submittedAt = now.toISOString();
  job.lastChange = job.submittedAt;
  updateEnvelope(caseDir, job.envelopeId, (env) => {
    env.payloads = [...(env.payloads || []), {
      n: job.n, at: job.submittedAt, jobId: job.id, payload: job.originalPayload, rendered: job.payload, hash: job.payloadHash, estimateUsd: job.estimateUsd
    }];
    const attempts = Number(job.originalPayload?.attemptsPerContact) || 1;
    for (const r of job.recipients || []) {
      if (!env.usage.contacts.includes(r)) env.usage.contacts.push(r);
      env.usage.attempts = { ...(env.usage.attempts || {}), [r]: (Number(env.usage.attempts?.[r]) || 0) + attempts };
    }
  });
  if (job.newContacts > 0) {
    const r = rt.budget(caseId).charge('contactsPerDay', job.newContacts, { executor: job.executor, jobId: job.id });
    if (r && Array.isArray(r.crossedNow) && r.crossedNow.length) rt.onCrossings(caseId, 'contactsPerDay', r.crossedNow);
  }
  if (entry && entry.latency !== 'interactive' && isOpen(job.state)) {
    const every = Math.max(MIN_POLL_MS, Number(entry.pollEveryMs) || reg.settings().pollEveryMs);
    job.wakeupId = rt.wakeups(caseId).register({ kind: 'poll-executor', every, payload: { key: `poll:${job.id}`, executor: job.executor, jobId: job.id } });
    job.nextPollAt = new Date(now.getTime() + every).toISOString();
  }
  if (job.planStepId) new PlanStore(caseDir).updateStep(job.planStepId, { state: 'in-flight', addJob: job.id });
  if (isTerminal(job.state)) finishJob(reg, caseId, caseDir, job);
  store.write(job);
  await reg.indexJob(caseId, job);
  rt.records(caseId).writeJournal('envelope', [
    `Job ${job.id} submitted to ${job.executor}${job.envelopeId ? ` under ${job.envelopeId}` : ''}${job.externalId ? ` (external id ${job.externalId})` : ''}.`,
    '',
    'Payload as sent:',
    '',
    '```json',
    JSON.stringify(job.payload, null, 2),
    '```'
  ].join('\n'), now);
  return job;
}

async function cancelJob(reg, caseId, jobId, reason = 'cancelled') {
  const rt = reg.caseRuntime;
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const job = store.get(jobId);
  if (!job) return { ok: false, error: `${jobId} was not found in this case.` };
  if (!isOpen(job.state)) return { ok: false, error: `${jobId} is already ${job.state}.` };
  const wasSubmitting = job.state === 'submitting';
  let note = null;
  try {
    if (job.kind === 'external' && job.externalId) {
      await (await reg.adapter(job.executor)).cancel(job.externalId);
    } else if (job.kind === 'workflow' && job.externalId) {
      const engine = reg.getWorkflowEngine();
      if (engine) engine.cancel(job.externalId);
    } else if (job.kind === 'runbook') {
      const run = reg.running.get(runKey(caseId, jobId));
      if (run) {
        if (!run.started) {
          const engine = reg.getRunbookEngine();
          if (engine && run.stamp !== undefined) engine.releaseExecution(run.name, run.stamp);
        }
        run.controller.abort();
        reg.running.delete(runKey(caseId, jobId));
      }
    } else if (job.kind === 'owner' && job.questionId) {
      rt.questions(caseId).close(job.questionId, { reason, by: 'system' });
    }
  } catch (err) {
    note = `the executor did not confirm the cancel: ${err.message}`;
  }
  job.state = 'cancelled';
  job.reason = reason;
  job.lastChange = reg.now().toISOString();
  if (wasSubmitting && job.reservedContacts) await reg.releaseContacts(job.executor, job.reservedContacts, { caseId });
  finishJob(reg, caseId, caseDir, job);
  store.write(job);
  await reg.indexJob(caseId, job);
  rt.records(caseId).writeJournal('envelope', `Job ${job.id} on ${job.executor} cancelled: ${reason}${note ? ` (${note})` : ''}.`, reg.now());
  return { ok: true, job, ...(note ? { note } : {}) };
}

// C2's setStatus calls this inside the case lock.
async function cancelOpenJobs(reg, caseId, reason) {
  const cancelled = [];
  for (const job of reg.jobs(caseId).list().filter((j) => isOpen(j.state))) {
    const r = await cancelJob(reg, caseId, job.id, reason || 'cancelled');
    if (r.ok) cancelled.push(job.id);
  }
  return { cancelled };
}

async function cancelJobAsOwner(reg, caseId, jobId, reason = 'cancelled by the owner') {
  try {
    return await reg.caseRuntime.systemAction(caseId, `cancel ${jobId}`, () => cancelJob(reg, caseId, jobId, reason));
  } catch (err) {
    if (err && err.name === 'CaseBusyError') return { ok: false, error: BUSY };
    throw err;
  }
}

// A job still `submitting` at a turn start was interrupted: ask the executor
// whether it has it (GET /jobs?externalRef=), else fail it.
async function reconcileSubmitting(reg, caseId) {
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const out = [];
  for (const job of store.list().filter((j) => j.state === 'submitting')) {
    if (reg.inFlight.has(runKey(caseId, job.id))) continue;
    let found = null;
    if (job.kind === 'external') {
      try {
        const adapter = await reg.adapter(job.executor);
        if (typeof adapter.findByExternalRef === 'function') found = await adapter.findByExternalRef(`${caseId}/${job.id}`);
      } catch (err) {
        log.warn(`Reconciling ${job.id} failed; trying again next turn: ${err.message}`);
        continue;
      }
    }
    if (found) {
      await commitSubmit(reg, caseId, job, found);
      out.push({ jobId: job.id, state: 'submitted' });
      continue;
    }
    job.state = 'failed';
    job.reason = 'interrupted';
    job.lastChange = reg.now().toISOString();
    if (job.reservedContacts) await reg.releaseContacts(job.executor, job.reservedContacts, { caseId });
    finishJob(reg, caseId, caseDir, job);
    store.write(job);
    await reg.indexJob(caseId, job);
    out.push({ jobId: job.id, state: 'failed' });
  }
  return out;
}

// Background runs write only under <dataDir>/executors/runs/; the case copy
// happens here, under the case lock (R37).
async function copyBackgroundOutput(reg, caseId) {
  const caseDir = reg.caseDir(caseId);
  const store = new JobStore(caseDir);
  const copied = [];
  for (const job of store.list()) {
    if ((job.kind !== 'workflow' && job.kind !== 'runbook') || job.copied) continue;
    const st = readRunStatus(reg, caseId, job.id);
    if (!st || !isTerminal(st.state)) continue;
    const from = runDir(reg, caseId, job.id);
    const to = path.join(caseDir, 'sources', job.executor, job.id);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (name === 'status.json') continue;
      fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
    }
    job.copied = true;
    if (isOpen(job.state)) applyStatus(reg, caseId, caseDir, job, { state: st.state, lastChange: st.finishedAt || null }, reg.now());
    store.write(job);
    await reg.indexJob(caseId, job);
    copied.push(job.id);
  }
  return copied;
}

module.exports = {
  BUSY,
  kindOf,
  runDir,
  readRunStatus,
  writeRunStatus,
  mergeContacts,
  updateEnvelope,
  applyStatus,
  finishJob,
  commitSubmit,
  refreshCase,
  pollWakeup,
  cancelJob,
  cancelOpenJobs,
  cancelJobAsOwner,
  reconcileSubmitting,
  copyBackgroundOutput
};
```

In `src/cases/executors/registry.js`, replace

```js
const { JobStore, readSnapshot, OPEN_STATES } = require('./job-store');
```

with

```js
const { JobStore, readSnapshot, OPEN_STATES } = require('./job-store');
const jobs = require('./jobs');
```

In `src/cases/executors/registry.js`, replace

```js
  // ---- operations (Tasks 9–12) ----
```

with

```js
  // ---- Job lifecycle (Task 9) ----

  refreshCase(caseId, opts = {}) {
    return jobs.refreshCase(this, caseId, opts);
  }

  pollWakeup(caseId, wakeup) {
    return jobs.pollWakeup(this, caseId, wakeup);
  }

  cancelOpenJobs(caseId, reason) {
    return jobs.cancelOpenJobs(this, caseId, reason);
  }

  // The owner's cancel (IPC): runs in systemAction.
  cancelJob(caseId, jobId, reason) {
    return jobs.cancelJobAsOwner(this, caseId, jobId, reason);
  }

  // ---- operations (Tasks 10–12) ----
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-executor-jobs.test.js tests/cases-executor-registry.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/jobs.js src/cases/executors/registry.js tests/cases-executor-jobs.test.js
git commit -m "feat(cases): executor job lifecycle — commit, poll with backoff, charge, snapshot, cancel, reconcile

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Envelope and plan operations, owner labor, and the turn-start hook

**Files:**
- Create: `src/cases/executors/envelope-ops.js`
- Create: `src/cases/executors/plan-ops.js`
- Create: `src/cases/executors/turn-hook.js`
- Modify: `src/cases/executors/registry.js` (the `jobs` require line and the `// ---- operations (Tasks 10–12) ----` marker)
- Modify: `src/cases/brief.js` (before `  missingForGating() {`)
- Modify: `src/tools/builtin/case-tools.js` (the Brief tool, before `    const provenance = params.provenance || 'model';`)
- Test: `tests/cases-envelope-ops.test.js`
- Test: `tests/cases-plan-ops.test.js`

**Interfaces:**
- Consumes: `EnvelopeStore`, `envelopeCore`, `envelopeHash`, `validateEnvelopeRequest`, `renderEnvelopeQuestion`, `applyDeltas`, `renderDeltaQuestion`, `deltasEqual` (Task 4); `approvalHelpers`, `signedAction` (Task 4); `parseSteps`, `stepsToTaskGraph`, `checkPlan`, `renderPlanCard`, `PlanStore` (Task 5); `JobStore`, `readSnapshot`, `isOpen` (Task 7); `jobs.cancelJob`, `jobs.copyBackgroundOutput`, `jobs.reconcileSubmitting`, `jobs.refreshCase`, `jobs.BUSY` (Task 9); `validateTaskGraph`, `TaskGraphValidationError` (`src/workflows/task-graph-validator.js`); C2 `createQuestion(id, record, { charge: false })`, `answerQuestion`, `questions(id).get/list/close`, `systemAction`, `ledger`, `brief`, `budget(id).remaining/limitFor`, `records(id).writeJournal`; optional C5 `runtime.detourGate`, C6 `runtime.playbookSteps`, C7 `runtime.entityIndex`; F3 `approver.requestAction`.
- Produces:
  - `envelope-ops.js`: `requestEnvelope(reg, { caseId, turnId, signal }, body) → { ok, envelopeId, status, hash, questionId, notBacked, note }`; `syncEnvelopes(reg, caseId) → transitions`; `requestDelta(reg, caseId, env, deltas) → questionId`; `applySignedOutcome(reg, caseId, envelopeId, outcome) → { applied, pending? }`; `applyPendingSignedGrants(reg, caseId)`; `revokeEnvelope(reg, caseId, envelopeId, reason) → { ok, cancelled }`; `signedOutcomesFor(reg, caseId, envelopeId)`; `reg.lastSignedRequest` (the promise of the latest phone request, for tests).
  - `plan-ops.js`: `proposePlan(reg, { caseId, turnId }, { goal, summary, steps }) → { ok, planId, approvable, card, steps, questionId?, suggestions, note? }`; `syncPlan(reg, caseId) → status | null`; `completeStep(reg, { caseId }, { stepId, note })`; `planStatus(reg, { caseId })`.
  - `turn-hook.js`: `renderExecutorSection(reg, caseId, { maxChars })`; `turnStartHook(reg, { caseId }) → { notes } | {}`.
  - Registry methods: `revokeEnvelope(caseId, envelopeId, reason)`, `turnStartHook(ctx)`.
  - `Brief.prototype.recordOwnerLabor({ planId, stepId, capability, title, factId, at })` (host-only); the Brief tool refuses a `resources` update whose `ownerLabor` differs from the stored one and keeps the stored list when the update omits it.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-envelope-ops.test.js`:

```js
// tests/cases-envelope-ops.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const ops = require('../src/cases/executors/envelope-ops');
const { EnvelopeStore, JobStore } = require('../src/cases/executors');
const { approvalHelpers } = require('../src/cases/executors/signed');

after(fx.cleanup);

async function setup({ authority = 'envelope', approver = null } = {}) {
  const env = fx.setupExecutors({ registryOptions: { getPhoneApprover: () => approver } });
  const ctl = fx.withFakeAgent(env, 'fake-agent', { entry: { authority } });
  const meta = await fx.activeCase(env.runtime);
  const fact = env.runtime.ledger(meta.id).assert({
    stmt: 'Lot size is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acres',
    provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/lot' }
  });
  return { env, ctl, meta, reg: env.registry, rt: env.runtime, factId: fact.id };
}
const body = (factId, over = {}) => ({
  executor: 'fake-agent', intent: 'Ask three brokers for a listing quote', recipients: { allow: ['+15550100', '+15550101'] },
  facts: [factId], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }, ...over
});
const envelopeOf = (s, id = 'env-01') => new EnvelopeStore(s.meta.dir).get(id);

describe('requesting and approving', () => {
  it('writes a requested envelope and an approval question; an owner approve activates it', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id, turnId: 'turn-1' }, body(s.factId));
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.envelopeId, r.status], ['env-01', 'requested']);
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.kind, q.payload.type, q.payload.envelopeId, q.payload.hash, q.options.map((o) => o.id)], ['approval', 'envelope', 'env-01', r.hash, ['approve', 'reject']]);
    assert.match(q.text, /^Approve envelope env-01 for fake-agent in case "Lakeside lot"\?/);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [], 'nothing changes before the answer');
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'active' }]);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.grantedBy.channel, e.grantedBy.questionId, e.grantedBy.evidence], ['active', 'in-app', r.questionId, null]);
    assert.match(e.grantedBy.factId, /^f-\d{4}$/);
  });

  it('a reject rejects it', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'reject' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    assert.strictEqual(envelopeOf(s).status, 'rejected');
  });

  it('an edited envelope turns tampered', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    e.caps.usd = 500;
    new EnvelopeStore(s.meta.dir).write(e);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'tampered' }]);
  });

  it('expires after the window and is exhausted at the usd cap', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    e.usage.usd = 20;
    new EnvelopeStore(s.meta.dir).write(e);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'exhausted' }]);
    const s2 = await setup();
    const r2 = await ops.requestEnvelope(s2.reg, { caseId: s2.meta.id }, body(s2.factId));
    await s2.rt.answerQuestion(s2.meta.id, r2.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s2.reg, s2.meta.id);
    s2.env.clock.now = new Date('2026-10-31T12:00:00Z');
    assert.deepStrictEqual(ops.syncEnvelopes(s2.reg, s2.meta.id), [{ envelopeId: 'env-01', status: 'expired' }]);
  });
});

describe('deltas', () => {
  it('asks once per set of differences and applies them on approve', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const deltas = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];
    const q1 = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), deltas);
    assert.strictEqual(ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), deltas), q1, 'reused while pending');
    const q = s.rt.questions(s.meta.id).get(q1);
    assert.deepStrictEqual([q.payload.type, q.payload.fromHash, q.payload.deltas], ['envelope-delta', r.hash, deltas]);
    await s.rt.answerQuestion(s.meta.id, q1, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.version, e.recipients.allow, e.pendingDelta], ['active', 2, ['+15550100', '+15550101', '+15550102'], null]);
    assert.notStrictEqual(e.hash, r.hash);
  });
});

describe('signed envelopes', () => {
  const helpers = approvalHelpers();
  const approverSaying = (decision) => ({
    calls: [],
    async requestAction(action, opts) {
      this.calls.push([action, opts]);
      return { decision, request_id: 'r-1', device_id: 'd-1', action_hash: helpers.actionHash(action), reason: null };
    }
  });

  it('refuses when no phone approver is enrolled, writing nothing', async () => {
    const s = await setup({ authority: 'signed' });
    assert.deepStrictEqual(await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId)), { ok: false, error: 'signed approval unavailable' });
    assert.deepStrictEqual(new EnvelopeStore(s.meta.dir).list(), []);
  });

  it('activates only from the phone Outcome; an in-app approve does not', async () => {
    const approver = approverSaying('approve');
    const s = await setup({ authority: 'signed', approver });
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.reg.lastSignedRequest;
    const [action, opts] = approver.calls[0];
    assert.deepStrictEqual([action.kind, action.name, action.params.case_id, opts.origin], ['envelope', 'fake-agent', s.meta.id, 'case']);
    assert.deepStrictEqual(opts.currentAction(), action);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.grantedBy.channel, e.grantedBy.evidence], ['active', 'phone', { request_id: 'r-1', action_hash: helpers.actionHash(action) }]);
    assert.strictEqual(s.rt.questions(s.meta.id).get(r.questionId).answer.channel, 'phone');
    assert.strictEqual(ops.signedOutcomesFor(s.reg, s.meta.id, 'env-01').length, 1);

    const denying = approverSaying('deny');
    const d = await setup({ authority: 'signed', approver: denying });
    const rd = await ops.requestEnvelope(d.reg, { caseId: d.meta.id }, body(d.factId));
    await d.reg.lastSignedRequest;
    await d.rt.answerQuestion(d.meta.id, rd.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(d.reg, d.meta.id);
    assert.strictEqual(envelopeOf(d).status, 'requested');
  });

  it('keeps a late grant in memory while the case is busy, then applies it', async () => {
    const approver = { requestAction: () => new Promise(() => {}) };
    const s = await setup({ authority: 'signed', approver });
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const real = s.rt.systemAction.bind(s.rt);
    s.rt.systemAction = async () => {
      const err = new Error('Case "Lakeside lot" is busy');
      err.name = 'CaseBusyError';
      throw err;
    };
    const outcome = { decision: 'approve', request_id: 'r-2', action_hash: 'h', device_id: 'd-1' };
    assert.deepStrictEqual(await ops.applySignedOutcome(s.reg, s.meta.id, 'env-01', outcome), { applied: false, pending: true });
    s.rt.systemAction = real;
    await ops.applyPendingSignedGrants(s.reg, s.meta.id);
    assert.deepStrictEqual([envelopeOf(s).status, s.reg.pendingSignedGrants.size], ['active', 0]);
  });
});

describe('revoke', () => {
  it('revokes the envelope and cancels its open jobs', async () => {
    const s = await setup();
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const job = new JobStore(s.meta.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', envelopeId: 'env-01', state: 'submitted', externalId: 'ext-9' });
    s.ctl.jobs.set('ext-9', { state: 'running', contacts: [] });
    assert.deepStrictEqual(await s.reg.revokeEnvelope(s.meta.id, 'env-01', 'the owner changed their mind'), { ok: true, cancelled: [job.id] });
    assert.strictEqual(envelopeOf(s).status, 'revoked');
    assert.strictEqual(new JobStore(s.meta.dir).get(job.id).state, 'cancelled');
    const journal = fs.readdirSync(path.join(s.meta.dir, 'journal')).filter((n) => n.includes('-envelope'));
    assert.ok(journal.length >= 2);
  });
});
```

Create `tests/cases-plan-ops.test.js`:

```js
// tests/cases-plan-ops.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const planOps = require('../src/cases/executors/plan-ops');
const { turnStartHook } = require('../src/cases/executors/turn-hook');
const { PlanStore, JobStore } = require('../src/cases/executors');
const { writeJsonAtomic } = require('../src/cases/executors/util');
const { BriefTool } = require('../src/tools/builtin/case-tools');

after(fx.cleanup);

const FORMS = { id: 's1', title: 'File nine permit forms', executor: 'owner', capability: 'web-form', serves: 'permit filings', quantity: 9, unit: 'forms' };
const NOTES = { id: 's2', title: 'Write up the zoning notes', executor: 'files', capability: 'write-files', dependsOn: ['s1'] };

async function setup({ browserDisabled = false } = {}) {
  const env = fx.setupExecutors();
  const meta = await fx.activeCase(env.runtime);
  if (browserDisabled) writeJsonAtomic(path.join(meta.dir, '.kl', 'executors.json'), { browser: { override: { disabled: true } } });
  return { env, meta, reg: env.registry, rt: env.runtime, ctx: { caseId: meta.id, turnId: 'turn-1' } };
}
const propose = (s, steps, over = {}) => planOps.proposePlan(s.reg, s.ctx, { goal: 'Get the permits', summary: 'File the county permits', steps: JSON.stringify(steps), ...over });

describe('Plan propose', () => {
  it('writes the plan, rewrites the owner step and asks the owner to approve', async () => {
    const s = await setup();
    const r = await propose(s, [FORMS, NOTES]);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.planId, r.approvable], ['plan-001', true]);
    assert.deepStrictEqual(r.steps.map((x) => [x.id, x.executor, x.check.status]), [['s1', 'browser', 'rewritten'], ['s2', 'files', 'ok']]);
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.kind, q.payload.type, q.payload.planId, q.payload.consentCapabilities, q.options.map((o) => o.id)], ['approval', 'plan', 'plan-001', [], ['approve', 'reject']]);
    assert.ok(q.text.startsWith('Plan plan-001: Get the permits'));
    const plan = new PlanStore(s.meta.dir).read();
    assert.deepStrictEqual([plan.status, plan.questionId], ['proposed', r.questionId]);
    assert.ok(fs.readdirSync(path.join(s.meta.dir, 'journal')).some((n) => n.endsWith('-plan.md')));
    assert.deepStrictEqual(r.suggestions, []);
  });

  it('offers approve-no-owner when a step needs the owner', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS]);
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.options.map((o) => o.id), q.payload.consentCapabilities], [['approve', 'approve-no-owner', 'reject'], ['web-form']]);
  });

  it('records owner labor from the approval, and the next plan honours it', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual(planOps.syncPlan(s.reg, s.meta.id), 'approved');
    const plan = new PlanStore(s.meta.dir).read();
    const factId = s.rt.questions(s.meta.id).get(r.questionId).answer.factId;
    assert.deepStrictEqual([plan.status, plan.steps[0].check.status, plan.steps[0].check.consent], ['approved', 'ok', `recorded:${factId}`]);
    const labor = s.rt.brief(s.meta.id).read().data.resources.ownerLabor;
    assert.deepStrictEqual(labor.map((e) => [e.planId, e.stepId, e.capability, e.factId]), [['plan-001', 's1', 'web-form', factId]]);
    const again = await propose(s, [FORMS]);
    assert.deepStrictEqual([again.steps[0].executor, again.steps[0].check.status], ['owner', 'ok']);
  });

  it('approve-no-owner cancels the owner steps; reject rejects', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS, { ...NOTES, dependsOn: [] }]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve-no-owner' });
    planOps.syncPlan(s.reg, s.meta.id);
    const plan = new PlanStore(s.meta.dir).read();
    assert.deepStrictEqual([plan.status, plan.steps[0].state, plan.steps[1].state], ['approved', 'cancelled', 'pending']);
    const t = await setup();
    const rt = await propose(t, [FORMS]);
    await t.rt.answerQuestion(t.meta.id, rt.questionId, { channel: 'in-app', optionId: 'reject' });
    assert.strictEqual(planOps.syncPlan(t.reg, t.meta.id), 'rejected');
  });

  it('refuses a new plan while steps are in flight, and a cyclic graph', async () => {
    const s = await setup();
    await propose(s, [FORMS]);
    const store = new PlanStore(s.meta.dir);
    const plan = store.read();
    plan.steps[0].state = 'in-flight';
    store.write(plan);
    assert.deepStrictEqual(await propose(s, [FORMS]), { ok: false, error: 'plan-001 has steps in flight (s1); cancel their jobs or wait before proposing a new plan' });
    const t = await setup();
    const cyc = await propose(t, [{ ...FORMS, dependsOn: ['s2'] }, NOTES]);
    assert.deepStrictEqual([cyc.ok, cyc.code], [false, 'CYCLE']);
  });

  it('supersedes the previous plan and closes its question', async () => {
    const s = await setup();
    const first = await propose(s, [FORMS]);
    const second = await propose(s, [NOTES].map((x) => ({ ...x, dependsOn: [] })));
    assert.strictEqual(second.planId, 'plan-002');
    assert.strictEqual(new PlanStore(s.meta.dir).read().supersedes, 'plan-001');
    assert.ok(s.rt.questions(s.meta.id).get(first.questionId).closed);
    assert.ok(fs.existsSync(path.join(s.meta.dir, '.kl', 'plans', 'plan-001.json')));
  });

  it('passes the detour gate once and keeps its note; a refusal is returned', async () => {
    const s = await setup();
    const calls = [];
    s.rt.detourGate = async (id, args) => { calls.push(args); return { ok: true, note: 'Related to the zoning detour.' }; };
    s.rt.playbookSteps = () => [{ title: 'Check the county fee schedule' }];
    const r = await propose(s, [FORMS]);
    assert.deepStrictEqual([calls.length, calls[0].source, calls[0].serves, r.note], [1, 'plan', 'File the county permits\npermit filings', 'Related to the zoning detour.']);
    assert.deepStrictEqual(r.suggestions, [{ title: 'Check the county fee schedule' }]);
    s.rt.detourGate = async () => ({ ok: false, error: 'This serves the other case.' });
    assert.deepStrictEqual(await propose(s, [FORMS]), { ok: false, error: 'This serves the other case.' });
  });

  it('asks nothing for a plan with a flagged step', async () => {
    const s = await setup();
    const r = await propose(s, [{ ...FORMS, executor: 'files', capability: 'postal-mail' }]);
    assert.deepStrictEqual([r.approvable, r.questionId, r.steps[0].check.status], [false, undefined, 'flagged']);
  });
});

describe('Plan complete', () => {
  it('marks a direct step done and closes the plan; job-backed steps are refused', async () => {
    const s = await setup();
    const r = await propose(s, [FORMS, NOTES]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    planOps.syncPlan(s.reg, s.meta.id);
    assert.match(planOps.completeStep(s.reg, s.ctx, { stepId: 's1', note: 'done' }).error, /runs on browser; it moves with its jobs/);
    const done = planOps.completeStep(s.reg, s.ctx, { stepId: 's2', note: 'Notes written to notes.md' });
    assert.deepStrictEqual([done.ok, done.step.state, done.planStatus], [true, 'done', 'approved']);
    new PlanStore(s.meta.dir).updateStep('s1', { state: 'done' });
    assert.strictEqual(planOps.planStatus(s.reg, s.ctx).plan.status, 'done');
  });
});

describe('owner labor is host-only (R41)', () => {
  it('forged ownerLabor entry is refused', async () => {
    const s = await setup({ browserDisabled: true });
    const forged = s.rt.ledger(s.meta.id).assert({
      stmt: 'Owner will file the forms', subject: 'owner', attr: 'labor', value: 'web-form', provenance: 'user',
      source: { kind: 'user-message', ref: 'turn-1', quote: 'file the forms' }
    });
    s.rt.brief(s.meta.id).update('resources', { executors: [], ownerLabor: [{ capability: 'web-form', factId: forged.id }] }, { provenance: 'model' });
    const r = await propose(s, [FORMS]);
    assert.deepStrictEqual([r.steps[0].check.status, r.steps[0].executor], ['needs-consent', 'owner']);
    assert.match(r.card, /Warning: ownerLabor entry 1 is not backed by an owner answer; ignored/);

    const { turn, caseContext } = await fx.openTurn(s.rt, s.meta.id);
    const refused = await BriefTool.execute({
      action: 'update', field: 'resources', value: JSON.stringify({ executors: ['browser'], ownerLabor: [{ capability: 'web-form', factId: 'f-0099' }] })
    }, { caseContext });
    assert.deepStrictEqual(refused, { ok: false, error: "ownerLabor is recorded only from the owner's answer to a plan or owner task." });
    const kept = await BriefTool.execute({ action: 'update', field: 'resources', value: JSON.stringify({ executors: ['browser'] }) }, { caseContext });
    assert.strictEqual(kept.ok, true, kept.error);
    assert.deepStrictEqual(s.rt.brief(s.meta.id).read().data.resources.ownerLabor, [{ capability: 'web-form', factId: forged.id }]);
    await s.rt.endTurn(turn, {});
  });
});

describe('turn-start hook', () => {
  it('returns the executor section only when the case uses executors', async () => {
    const s = await setup();
    assert.deepStrictEqual(await turnStartHook(s.reg, { caseId: s.meta.id }), {});
    fx.withFakeAgent(s.env);
    s.rt.brief(s.meta.id).update('resources', { executors: ['fake-agent'], ownerLabor: [] }, { provenance: 'model' });
    await s.reg.adapter('fake-agent');
    const out = await s.reg.turnStartHook({ caseId: s.meta.id });
    assert.strictEqual(out.notes.length, 1);
    assert.match(out.notes[0], /^## Executors\n\n- fake-agent \(external-agent, authority envelope\)/);
    assert.match(out.notes[0], /- fake-agent: Say who you are calling for\./);
    const job = new JobStore(s.meta.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting' });
    await s.reg.turnStartHook({ caseId: s.meta.id });
    assert.deepStrictEqual([new JobStore(s.meta.dir).get(job.id).state, new JobStore(s.meta.dir).get(job.id).reason], ['failed', 'interrupted']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-envelope-ops.test.js tests/cases-plan-ops.test.js`
Expected: FAIL with `Cannot find module '../src/cases/executors/envelope-ops'` and `Cannot find module '../src/cases/executors/plan-ops'`

- [ ] **Step 3: Implement**

Create `src/cases/executors/envelope-ops.js`:

```js
// src/cases/executors/envelope-ops.js
// Envelope flows (cases stage 3 spec §3.6): request, owner approval, deltas,
// the signed path through the phone approver (F3), and revocation.
const { createLogger } = require('../../logging');
const {
  EnvelopeStore, envelopeCore, envelopeHash, validateEnvelopeRequest, renderEnvelopeQuestion, applyDeltas, renderDeltaQuestion, deltasEqual
} = require('./envelope');
const { approvalHelpers, signedAction } = require('./signed');
const { JobStore, isOpen } = require('./job-store');
const jobs = require('./jobs');
const { localDate } = require('./util');

const log = createLogger('executors/envelopes');
const APPROVE_REJECT = Object.freeze([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
const grantKey = (caseId, envelopeId) => `${caseId}/${envelopeId}`;

function journal(reg, caseId, text) {
  reg.caseRuntime.records(caseId).writeJournal('envelope', text, reg.now());
}

function caseDeadline(rt, caseId) {
  let d = null;
  try {
    d = rt.brief(caseId).read().data?.deadline || null;
  } catch {
    d = null;
  }
  return d || rt.budget(caseId).limitFor('deadline') || null;
}

function signedOutcomesFor(reg, caseId, envelopeId) {
  return reg.signedOutcomes.get(grantKey(caseId, envelopeId)) || [];
}

async function requestEnvelope(reg, { caseId, turnId = null, signal = null } = {}, body = {}) {
  const rt = reg.caseRuntime;
  const meta = rt.getCase(caseId);
  const entry = reg.get(body?.executor, { caseId });
  if (!entry) return { ok: false, error: `unknown executor "${body?.executor}"` };
  if (!entry.available) return { ok: false, error: `${entry.id} is unavailable: ${entry.reason}` };
  const settings = reg.settings();
  const facts = rt.ledger(caseId).view().facts;
  const v = validateEnvelopeRequest(body, {
    entry, facts, deadline: caseDeadline(rt, caseId), casesTimeZone: reg.casesTimeZone(), defaultCountryCode: settings.defaultCountryCode,
    categoryKeywords: settings.outbound.categoryKeywords, entityIndex: typeof rt.entityIndex === 'function' ? rt.entityIndex() : null, caseId
  });
  if (!v.ok) return { ok: false, error: v.error, ...(v.blocked ? { blocked: v.blocked } : {}) };
  let approver = null;
  if (entry.authority === 'signed') {
    approver = reg.getPhoneApprover();
    if (!approver) return { ok: false, error: 'signed approval unavailable' };
  }
  const store = new EnvelopeStore(meta.dir);
  const env = {
    id: store.nextId(),
    version: 1,
    status: 'requested',
    ...v.core,
    recipients: { ...v.core.recipients, addRequiresApproval: true },
    hash: envelopeHash(v.core),
    questionId: null,
    grantedBy: null,
    deltas: [],
    pendingDelta: null,
    usage: { usd: 0, contacts: [], attempts: {} },
    payloads: [],
    nextN: 0,
    createdAt: reg.now().toISOString(),
    turnId
  };
  const text = renderEnvelopeQuestion(env, { facts, caseTitle: meta.title, notBacked: v.notBacked });
  const q = rt.createQuestion(caseId, {
    kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text, options: APPROVE_REJECT,
    payload: { type: 'envelope', envelopeId: env.id, hash: env.hash, envelope: v.core, mcpAnswerable: true }
  }, { charge: false });
  env.questionId = q && q.id ? q.id : null;
  store.write(env);
  journal(reg, caseId, `Envelope ${env.id} requested for ${env.executor} (${env.hash}).\n\n${text}`);
  if (approver) startSignedRequest(reg, caseId, env, approver, signal);
  return {
    ok: true, envelopeId: env.id, status: 'requested', hash: env.hash, questionId: env.questionId, notBacked: v.notBacked,
    note: approver ? "Sent to the owner's phone for a signed approval." : 'The owner approves it; nothing is sent until then.'
  };
}

// The phone decides; the envelope turns active only from an approve Outcome.
function startSignedRequest(reg, caseId, env, approver, signal) {
  const helpers = approvalHelpers();
  const current = () => signedAction(new EnvelopeStore(reg.caseDir(caseId)).get(env.id) || env, caseId, helpers);
  let request;
  try {
    request = Promise.resolve(approver.requestAction(signedAction(env, caseId, helpers), {
      origin: 'case', signal: signal || undefined, currentAction: current
    }));
  } catch (err) {
    request = Promise.reject(err);
  }
  const done = request
    .then((outcome) => applySignedOutcome(reg, caseId, env.id, outcome))
    .catch((err) => {
      log.warn(`Signed approval for ${env.id} failed: ${err.message}`);
      return { applied: false, error: err.message };
    });
  reg.lastSignedRequest = done;
  return done;
}

async function activateSigned(reg, caseId, envelopeId, outcome) {
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const env = store.get(envelopeId);
  if (!env || env.status !== 'requested') return false;
  if (envelopeHash(envelopeCore(env)) !== env.hash) {
    env.status = 'tampered';
    store.write(env);
    journal(reg, caseId, `Envelope ${envelopeId} is tampered: it changed since it was sent to the phone.`);
    return false;
  }
  env.status = 'active';
  env.grantedBy = {
    channel: 'phone', at: reg.now().toISOString(), questionId: env.questionId, factId: null,
    evidence: { request_id: outcome.request_id, action_hash: outcome.action_hash }
  };
  store.write(env);
  if (env.questionId) {
    try {
      const answered = await reg.caseRuntime.answerQuestion(caseId, env.questionId, { channel: 'phone', optionId: 'approve', text: 'approved on phone' });
      env.grantedBy.factId = answered?.fact?.id || null;
      store.write(env);
    } catch (err) {
      log.warn(`Recording the phone approval of ${envelopeId} as an answer failed: ${err.message}`);
    }
  }
  journal(reg, caseId, `Envelope ${envelopeId} approved on the phone (request ${outcome.request_id}).`);
  return true;
}

async function applySignedOutcome(reg, caseId, envelopeId, outcome) {
  if (!outcome || outcome.decision !== 'approve') {
    log.info(`Signed approval for ${envelopeId} ended ${outcome?.decision || 'without an outcome'}; it stays requested.`);
    return { applied: false, decision: outcome?.decision || null };
  }
  const key = grantKey(caseId, envelopeId);
  reg.signedOutcomes.set(key, [...signedOutcomesFor(reg, caseId, envelopeId), outcome]);
  try {
    await reg.caseRuntime.systemAction(caseId, `envelope signed ${envelopeId}`, () => activateSigned(reg, caseId, envelopeId, outcome));
    reg.pendingSignedGrants.delete(key);
    return { applied: true };
  } catch (err) {
    if (err && err.name === 'CaseBusyError') {
      reg.pendingSignedGrants.set(key, outcome);
      return { applied: false, pending: true };
    }
    throw err;
  }
}

// Turn-start hook: the lock is already held.
async function applyPendingSignedGrants(reg, caseId) {
  for (const [key, outcome] of [...reg.pendingSignedGrants]) {
    if (!key.startsWith(`${caseId}/`)) continue;
    await activateSigned(reg, caseId, key.slice(caseId.length + 1), outcome);
    reg.pendingSignedGrants.delete(key);
  }
}

function requestDelta(reg, caseId, env, deltas) {
  const rt = reg.caseRuntime;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  if (env.pendingDelta && deltasEqual(env.pendingDelta.deltas, deltas)) {
    const pending = rt.questions(caseId).get(env.pendingDelta.questionId);
    if (pending && !pending.answer && !pending.closed) return pending.id;
  }
  const q = rt.createQuestion(caseId, {
    kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text: renderDeltaQuestion(env, deltas), options: APPROVE_REJECT,
    payload: { type: 'envelope-delta', envelopeId: env.id, fromHash: env.hash, deltas, mcpAnswerable: true }
  }, { charge: false });
  const current = store.get(env.id) || env;
  current.pendingDelta = { questionId: q.id, deltas, fromHash: env.hash };
  store.write(current);
  journal(reg, caseId, `Envelope ${env.id} needs the owner's approval for: ${deltas.map((d) => d.text).join('; ')} (${q.id}).`);
  return q.id;
}

// Turn-start hook and every Plan/Executor call.
function syncEnvelopes(reg, caseId) {
  const rt = reg.caseRuntime;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const questions = rt.questions(caseId);
  const now = reg.now();
  const transitions = [];
  const move = (env, status, why) => {
    env.status = status;
    store.write(env);
    transitions.push({ envelopeId: env.id, status });
    journal(reg, caseId, `Envelope ${env.id} is ${status}: ${why}.`);
  };
  for (const env of store.list()) {
    if (['rejected', 'revoked', 'tampered'].includes(env.status)) continue;
    if (envelopeHash(envelopeCore(env)) !== env.hash) {
      move(env, 'tampered', 'envelope changed since approval; request it again');
      continue;
    }
    const signed = reg.get(env.executor, { caseId })?.authority === 'signed';
    if (env.status === 'requested' && !signed && env.questionId) {
      const q = questions.get(env.questionId);
      if (q && q.answer && q.answer.optionId === 'approve' && q.payload?.hash === env.hash) {
        env.grantedBy = { channel: q.answer.channel, at: q.answer.at, questionId: q.id, factId: q.answer.factId || null, evidence: null };
        move(env, 'active', `approved via ${q.answer.channel}`);
      } else if (q && q.answer && q.answer.optionId === 'reject') {
        move(env, 'rejected', 'the owner rejected it');
        continue;
      }
    }
    if (env.pendingDelta) {
      const q = questions.get(env.pendingDelta.questionId);
      if (q && q.answer && q.answer.optionId === 'approve' && q.payload?.fromHash === env.hash) {
        const next = applyDeltas(env, env.pendingDelta.deltas, { questionId: q.id, factId: q.answer.factId || null, at: q.answer.at });
        next.pendingDelta = null;
        if (signed) {
          next.status = 'requested';
          next.grantedBy = null;
        }
        store.write(next);
        transitions.push({ envelopeId: env.id, status: next.status });
        journal(reg, caseId, `Envelope ${env.id} is version ${next.version} (${next.hash}): ${env.pendingDelta.deltas.map((d) => d.text).join('; ')}.`);
        if (signed) {
          const approver = reg.getPhoneApprover();
          if (approver) startSignedRequest(reg, caseId, next, approver, null);
        }
        continue;
      }
      if (q && (q.closed || (q.answer && q.answer.optionId !== 'approve'))) {
        env.pendingDelta = null;
        store.write(env);
      }
    }
    if (env.status === 'active') {
      if (localDate(now, env.window.tz) > env.window.end) move(env, 'expired', `the window ended ${env.window.end}`);
      else if ((Number(env.usage?.usd) || 0) >= Number(env.caps.usd)) move(env, 'exhausted', 'the usd cap is reached');
    }
  }
  return transitions;
}

async function revokeEnvelope(reg, caseId, envelopeId, reason = 'revoked by the owner') {
  try {
    return await reg.caseRuntime.systemAction(caseId, `revoke ${envelopeId}`, async () => {
      const store = new EnvelopeStore(reg.caseDir(caseId));
      const env = store.get(envelopeId);
      if (!env) return { ok: false, error: `${envelopeId} was not found in this case.` };
      if (env.status === 'revoked') return { ok: true, cancelled: [] };
      env.status = 'revoked';
      env.revoked = { at: reg.now().toISOString(), reason };
      store.write(env);
      const cancelled = [];
      for (const job of new JobStore(reg.caseDir(caseId)).list().filter((j) => j.envelopeId === envelopeId && isOpen(j.state))) {
        const r = await jobs.cancelJob(reg, caseId, job.id, `envelope ${envelopeId} revoked`);
        if (r.ok) cancelled.push(job.id);
      }
      journal(reg, caseId, `Envelope ${envelopeId} revoked: ${reason}.${cancelled.length ? ` Cancelled ${cancelled.join(', ')}.` : ''}`);
      return { ok: true, cancelled };
    });
  } catch (err) {
    if (err && err.name === 'CaseBusyError') return { ok: false, error: jobs.BUSY };
    throw err;
  }
}

module.exports = {
  requestEnvelope,
  syncEnvelopes,
  requestDelta,
  applySignedOutcome,
  applyPendingSignedGrants,
  revokeEnvelope,
  signedOutcomesFor
};
```

Create `src/cases/executors/plan-ops.js`:

```js
// src/cases/executors/plan-ops.js
// Plan flows (cases stage 3 spec §3.4): propose (checks, card, approval
// question), sync the owner's answer (owner labor, R41), complete a direct
// step, and read the plan.
const { validateTaskGraph, TaskGraphValidationError } = require('../../workflows/task-graph-validator');
const { parseSteps, stepsToTaskGraph, checkPlan, renderPlanCard, PlanStore } = require('./plan');
const { pickTimeZone } = require('./util');

const cut = (text, max = 2000) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function planInputs(reg, caseId) {
  const rt = reg.caseRuntime;
  let brief = {};
  try {
    brief = rt.brief(caseId).read().data || {};
  } catch {
    brief = {};
  }
  const budget = rt.budget(caseId);
  return {
    brief,
    facts: rt.ledger(caseId).view().facts,
    questions: rt.questions(caseId).list(),
    budget: { remainingUsd: budget.remaining('usd'), contactsPerDayLimit: budget.limitFor('contactsPerDay'), deadline: budget.limitFor('deadline') }
  };
}

async function proposePlan(reg, { caseId, turnId = null } = {}, params = {}) {
  const rt = reg.caseRuntime;
  const now = reg.now();
  const store = new PlanStore(reg.caseDir(caseId));
  const current = store.read();
  const live = current && ['proposed', 'approved'].includes(current.status);
  if (live) {
    const inFlight = (current.steps || []).filter((s) => s.state === 'in-flight').map((s) => s.id);
    if (inFlight.length) {
      return { ok: false, error: `${current.id} has steps in flight (${inFlight.join(', ')}); cancel their jobs or wait before proposing a new plan` };
    }
  }
  const parsed = parseSteps(params.steps);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    validateTaskGraph(stepsToTaskGraph(parsed.steps));
  } catch (err) {
    if (err instanceof TaskGraphValidationError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
  const summary = String(params.summary || '').trim();
  const goal = String(params.goal || '').trim();
  let note = null;
  if (typeof rt.detourGate === 'function') {
    const serves = [summary, ...parsed.steps.map((s) => s.serves)].filter(Boolean).join('\n');
    const gate = await rt.detourGate(caseId, { source: 'plan', serves, text: summary, turnId });
    if (gate && gate.ok === false) return gate;
    if (gate && gate.note) note = gate.note;
  }
  const inputs = planInputs(reg, caseId);
  const checked = checkPlan({
    steps: parsed.steps, entries: reg.list({ caseId }), brief: inputs.brief, facts: inputs.facts, questions: inputs.questions,
    budget: inputs.budget, globalRemaining: (id) => reg.globalRemaining(id), now, tz: pickTimeZone(reg.casesTimeZone()),
    attemptsDefault: reg.settings().attemptsDefault
  });
  const plan = {
    id: store.nextId(), status: 'proposed', supersedes: live ? current.id : null, questionId: null, goal, summary,
    estimateUsd: checked.estimateUsd, warnings: checked.warnings, consentCapabilities: checked.consentCapabilities,
    createdAt: now.toISOString(), turnId, steps: checked.steps
  };
  if (current) {
    if (live) {
      current.status = 'superseded';
      if (current.questionId) {
        try {
          rt.questions(caseId).close(current.questionId, { reason: `superseded by ${plan.id}`, by: 'system' });
        } catch {
          // already answered or closed
        }
      }
    }
    store.archive(current);
  }
  const card = renderPlanCard(plan);
  const approvable = !plan.steps.some((s) => s.check.status === 'flagged');
  if (approvable) {
    const needsConsent = plan.steps.some((s) => s.check.status === 'needs-consent');
    const q = rt.createQuestion(caseId, {
      kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text: cut(card),
      options: [
        { id: 'approve', label: 'Approve' },
        ...(needsConsent ? [{ id: 'approve-no-owner', label: "Approve, except the owner's steps" }] : []),
        { id: 'reject', label: 'Reject' }
      ],
      payload: { type: 'plan', planId: plan.id, consentCapabilities: plan.consentCapabilities, mcpAnswerable: true }
    }, { charge: false });
    plan.questionId = q && q.id ? q.id : null;
  }
  store.write(plan);
  rt.records(caseId).writeJournal('plan', `${card}\n\nSteps as proposed:\n\n\`\`\`json\n${JSON.stringify(parsed.steps, null, 2)}\n\`\`\``, now);
  const suggestions = typeof rt.playbookSteps === 'function' ? (rt.playbookSteps(caseId) || []) : [];
  return {
    ok: true, planId: plan.id, approvable, card, steps: plan.steps,
    ...(plan.questionId ? { questionId: plan.questionId } : {}), suggestions, ...(note ? { note } : {})
  };
}

function syncPlan(reg, caseId) {
  const rt = reg.caseRuntime;
  const store = new PlanStore(reg.caseDir(caseId));
  const plan = store.read();
  if (!plan || plan.status !== 'proposed' || !plan.questionId) return null;
  const q = rt.questions(caseId).get(plan.questionId);
  if (!q || !q.answer) return null;
  const { optionId, factId, at, channel } = q.answer;
  if (optionId === 'approve') {
    plan.status = 'approved';
    for (const s of plan.steps) {
      if (s.check?.status !== 'needs-consent') continue;
      rt.brief(caseId).recordOwnerLabor({ planId: plan.id, stepId: s.id, capability: s.capability, title: s.title, factId, at });
      s.check = { ...s.check, status: 'ok', consent: `recorded:${factId}` };
    }
  } else if (optionId === 'approve-no-owner') {
    plan.status = 'approved';
    for (const s of plan.steps) {
      if (s.check?.status !== 'needs-consent') continue;
      s.state = 'cancelled';
      s.reason = 'the owner did not agree to do this step';
    }
  } else if (optionId === 'reject') {
    plan.status = 'rejected';
  } else {
    return null;
  }
  if (plan.status === 'approved' && plan.steps.every((s) => s.state === 'done' || s.state === 'cancelled')) plan.status = 'done';
  store.write(plan);
  rt.records(caseId).writeJournal('plan', `Plan ${plan.id} ${plan.status} by the owner (${channel}, ${q.id}).`, reg.now());
  return plan.status;
}

// Direct executors (bash, files, web) do their work with ordinary tools;
// the model marks those steps done. Job-backed steps move with their jobs.
function completeStep(reg, { caseId } = {}, { stepId, note = '' } = {}) {
  const store = new PlanStore(reg.caseDir(caseId));
  const plan = store.read();
  if (!plan || plan.status !== 'approved') return { ok: false, error: 'There is no approved plan to complete a step of.' };
  const step = (plan.steps || []).find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `Step ${stepId} is not in ${plan.id}.` };
  const entry = reg.get(step.executor, { caseId });
  if (!entry || !entry.direct) return { ok: false, error: `Step ${stepId} runs on ${step.executor}; it moves with its jobs, not by hand.` };
  if (step.state === 'done' || step.state === 'cancelled') return { ok: false, error: `Step ${stepId} is already ${step.state}.` };
  const next = store.updateStep(stepId, { state: 'done', note: String(note || '') });
  reg.caseRuntime.records(caseId).writeJournal('plan', `Step ${stepId} of ${plan.id} done: ${note || 'no note'}.`, reg.now());
  return { ok: true, planId: next.id, planStatus: next.status, step: next.steps.find((s) => s.id === stepId) };
}

function planStatus(reg, { caseId } = {}) {
  const plan = new PlanStore(reg.caseDir(caseId)).read();
  if (!plan) return { ok: true, plan: null, note: 'No plan yet. Propose one with action "propose".' };
  return { ok: true, plan, card: renderPlanCard(plan) };
}

module.exports = { proposePlan, syncPlan, completeStep, planStatus };
```

Create `src/cases/executors/turn-hook.js`:

```js
// src/cases/executors/turn-hook.js
// The `executors` turn-start hook (cases stage 3 spec §3.12) and the
// orientation section it returns.
const { createLogger } = require('../../logging');
const { JobStore, readSnapshot, isOpen } = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const jobs = require('./jobs');
const envelopeOps = require('./envelope-ops');
const planOps = require('./plan-ops');

const log = createLogger('executors/hook');
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function renderExecutorSection(reg, caseId, { maxChars = 3000 } = {}) {
  const rt = reg.caseRuntime;
  const dir = reg.caseDir(caseId);
  let brief = {};
  try {
    brief = rt.brief(caseId).read().data || {};
  } catch {
    brief = {};
  }
  const jobList = new JobStore(dir).list();
  const envelopes = new EnvelopeStore(dir).list();
  const ids = [...new Set([
    ...(Array.isArray(brief.resources?.executors) ? brief.resources.executors : []),
    ...jobList.map((j) => j.executor),
    ...envelopes.map((e) => e.executor)
  ])];
  if (!ids.length) return '';
  const snapshot = readSnapshot(dir);
  const lines = ['## Executors', ''];
  for (const id of ids) {
    const e = reg.get(id, { caseId });
    if (!e) lines.push(`- ${id}: not a known executor`);
    else lines.push(`- ${id} (${e.kind}, authority ${e.authority}${e.available ? '' : `, unavailable: ${e.reason}`})`);
  }
  const open = jobList.filter((j) => isOpen(j.state));
  if (open.length) {
    lines.push('', 'Open jobs:');
    for (const j of open) {
      const stale = j.stale ? ` — STALE since ${snapshot[j.executor]?.fetchedAt || 'the first poll'}: ${j.error}` : '';
      lines.push(`- ${j.id} ${j.executor} ${j.state}${j.lastChange ? ` (last change ${j.lastChange})` : ''}${stale}`);
    }
  }
  const active = envelopes.filter((e) => e.status === 'active');
  if (active.length) {
    lines.push('', 'Active envelopes:');
    for (const e of active) {
      const usedContacts = (e.usage?.contacts || []).length;
      lines.push(`- ${e.id} ${e.executor}: ${money(e.caps.usd - (Number(e.usage?.usd) || 0))} of ${money(e.caps.usd)} left, ${e.caps.contacts - usedContacts} of ${e.caps.contacts} contacts left, window ${e.window.start} to ${e.window.end} (${e.window.tz})`);
    }
  }
  const rules = ids.map((id) => [id, reg.briefRules(id, { caseId })]).filter(([, r]) => r.length);
  if (rules.length) {
    lines.push('', 'Brief rules for executors:');
    for (const [id, list] of rules) for (const rule of list) lines.push(`- ${id}: ${rule}`);
  }
  const notes = typeof reg.opsNotes === 'function' ? reg.opsNotes(caseId, ids) : '';
  if (notes) lines.push('', notes);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// Runs inside beginTurn with the case lock held (C2 §4.20). Never throws:
// C2 turns a hook failure into a note, but a partial refresh is better.
async function turnStartHook(reg, { caseId } = {}) {
  const steps = [
    ['signed grants', () => envelopeOps.applyPendingSignedGrants(reg, caseId)],
    ['background output', () => jobs.copyBackgroundOutput(reg, caseId)],
    ['reconcile', () => jobs.reconcileSubmitting(reg, caseId)],
    ['plan', () => planOps.syncPlan(reg, caseId)],
    ['envelopes', () => envelopeOps.syncEnvelopes(reg, caseId)],
    ['refresh', () => jobs.refreshCase(reg, caseId, { budgetMs: reg.settings().refreshBudgetMs })]
  ];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (err) {
      log.warn(`Executor turn start (${label}) failed for ${caseId}: ${err.message}`);
    }
  }
  const section = renderExecutorSection(reg, caseId, { maxChars: 3000 });
  return section ? { notes: [section] } : {};
}

module.exports = { renderExecutorSection, turnStartHook };
```

In `src/cases/executors/registry.js`, replace

```js
const jobs = require('./jobs');
```

with

```js
const jobs = require('./jobs');
const envelopeOps = require('./envelope-ops');
const turnHook = require('./turn-hook');
```

In `src/cases/executors/registry.js`, replace

```js
  // ---- operations (Tasks 10–12) ----
```

with

```js
  // ---- Envelopes and the turn-start hook (Task 10) ----

  // IPC case:revokeEnvelope and C4's conflict follow-up; runs in systemAction.
  revokeEnvelope(caseId, envelopeId, reason) {
    return envelopeOps.revokeEnvelope(this, caseId, envelopeId, reason);
  }

  // Registered as caseRuntime.addTurnStartHook('executors', …) by createCore.
  turnStartHook(ctx) {
    return turnHook.turnStartHook(this, ctx);
  }

  // ---- operations (Tasks 11–12) ----
```

In `src/cases/brief.js`, replace

```js
  missingForGating() {
```

with

```js
  // Host-only (cases stage 3, R41): syncPlan records the owner's consent from
  // their answer to a plan question. No tool reaches this.
  recordOwnerLabor(entry) {
    const { data, body } = this.read();
    const resources = data.resources && typeof data.resources === 'object' && !Array.isArray(data.resources) ? { ...data.resources } : {};
    const labor = Array.isArray(resources.ownerLabor) ? [...resources.ownerLabor] : [];
    labor.push({
      planId: entry.planId, stepId: entry.stepId, capability: entry.capability, title: entry.title, factId: entry.factId, at: entry.at
    });
    resources.ownerLabor = labor;
    data.resources = resources;
    this._write(data, body);
    return labor;
  }

  missingForGating() {
```

In `src/tools/builtin/case-tools.js`, replace

```js
    const provenance = params.provenance || 'model';
```

with

```js
    // brief.resources.ownerLabor is host-only (R41): only syncPlan writes it.
    if (params.field === 'resources' && params.value && typeof params.value === 'object' && !Array.isArray(params.value)) {
      const stored = brief.read().data?.resources?.ownerLabor ?? [];
      if (params.value.ownerLabor === undefined) {
        params = { ...params, value: { ...params.value, ownerLabor: stored } };
      } else if (JSON.stringify(params.value.ownerLabor) !== JSON.stringify(stored)) {
        return { ok: false, error: "ownerLabor is recorded only from the owner's answer to a plan or owner task." };
      }
    }
    const provenance = params.provenance || 'model';
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-envelope-ops.test.js tests/cases-plan-ops.test.js tests/cases-executor-jobs.test.js tests/cases-brief.test.js tests/cases-tools.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/executors/envelope-ops.js src/cases/executors/plan-ops.js src/cases/executors/turn-hook.js src/cases/executors/registry.js src/cases/brief.js src/tools/builtin/case-tools.js tests/cases-envelope-ops.test.js tests/cases-plan-ops.test.js
git commit -m "feat(cases): envelope and plan flows, signed grants, host-only owner labor, executor turn-start hook

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 2 hand-off

When Tasks 6–10 are merged, run:

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests examples | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})" | grep -vE "example\.(com|org)"`
Expected: no output.

Part 3 (`docs/superpowers/plans/2026-09-23-cases-stage3-executors-part3.md`) depends on these exports existing exactly as named:

| Module | Exports |
|---|---|
| `src/cases/executors/builtins.js` | `OUTBOUND_CAPABILITIES`, `CAPABILITIES`, `KINDS`, `LATENCIES`, `AUTHORITIES`, `OUTBOUND_MODES`, `STATE_MODES`, `ID_PATTERN`, `DIRECT_TOOLS`, `BUILTIN_IDS`, `builtinEntry` |
| `src/cases/executors/package-loader.js` | `ADAPTER_FUNCTIONS`, `ExecutorUnavailableError`, `computePackageSha256`, `readManifest`, `resolveConfig`, `checkPackage`, `makeHostFetch`, `loadAdapter` |
| `src/skills/skill-loader.js` | `SkillLoader` (default), `isExecutorPackage` |
| `src/cases/executors/job-store.js` | `OPEN_STATES`, `TERMINAL_STATES`, `JOB_DEFAULTS`, `isOpen`, `JobStore`, `readSnapshot`, `writeSnapshot` |
| `src/cases/executors/registry.js` | `ExecutorRegistry` (with `settings`, `casesTimeZone`, `getUsageTracker`, `ids`, `list`, `get`, `_resolve`, `_configured`, `adapter`, `briefRules`, `registerExtraBriefRules`, `reserveContacts`, `releaseContacts`, `globalRemaining`, `caseDir`, `jobs`, `indexJob`, `liveState`, `refreshCase`, `pollWakeup`, `cancelOpenJobs`, `cancelJob`, `revokeEnvelope`, `turnStartHook`; maps `signedOutcomes`, `pendingSignedGrants`, `running`, `inFlight`; the marker `// ---- operations (Tasks 11–12) ----`), `intersectWindow`, `AUTHORITY_RANK` |
| `src/cases/executors/index.js` | `ExecutorRegistry`, `ExecutorUnavailableError`, `JobStore`, `OPEN_STATES`, `TERMINAL_STATES`, `EnvelopeStore`, `PlanStore`, `normalizeRecipient` |
| `src/cases/executors/jobs.js` | `BUSY`, `kindOf`, `runDir`, `readRunStatus`, `writeRunStatus`, `mergeContacts`, `updateEnvelope`, `applyStatus`, `finishJob`, `commitSubmit`, `refreshCase`, `pollWakeup`, `cancelJob`, `cancelOpenJobs`, `cancelJobAsOwner`, `reconcileSubmitting`, `copyBackgroundOutput` |
| `src/cases/executors/envelope-ops.js` | `requestEnvelope`, `syncEnvelopes`, `requestDelta`, `applySignedOutcome`, `applyPendingSignedGrants`, `revokeEnvelope`, `signedOutcomesFor` |
| `src/cases/executors/plan-ops.js` | `proposePlan`, `syncPlan`, `completeStep`, `planStatus` |
| `src/cases/executors/turn-hook.js` | `renderExecutorSection`, `turnStartHook` |
| `src/cases/brief.js` | `Brief.prototype.recordOwnerLabor` |
| `examples/executors/phone-agent/adapter.js` | `createAdapter`, `ErrandsError` |
| `tests/helpers/executor-fixtures.js` | `tempDir`, `cleanup`, `fakeVault`, `writeFakePackage`, `externalEntry`, `installFakeAdapter`, `setupExecutors`, `withFakeAgent`, `activeCase`, `openTurn` |
| `tests/helpers/fake-errands-server.js` | `startFakeErrandsServer` |
