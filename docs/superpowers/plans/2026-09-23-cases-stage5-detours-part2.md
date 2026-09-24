# Cases Stage 5: Detours, the cross-case index and case types — Implementation Plan (Part 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A case notices work that drifts off its objective, answers in one line, and routes it to an existing case, a new case or nowhere by the owner's choice, in the case panel or any question channel.
**Architecture:** Part 2 builds on Part 1's index, gates and case types. `src/cases/detours/` holds the append-only `.kl/detours.jsonl` log, the `classify`-role classifier, the router (candidates, routing questions, attach / new / decline, reconcile) and the two turn hooks C2's runtime runs (turn start: reconcile, held proposals, the `software-repo` refresh and trigger; owner message: classify, propose, check-before-write). The runtime exposes `detours`, `classifier` and `detourGate`; the `Detour` tool, the `Ask` duplicate check, IPC `case:detours` / `case:resolveDetour` / `case:reindex` and a case-panel section complete it.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Electron IPC (`src/ipc/` only). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage5-detours.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.
**Depends on:** Part 1 (`docs/superpowers/plans/2026-09-23-cases-stage5-detours-part1.md`) merged; its exports are listed in its hand-off section. Cases stage 2 merged.

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

Stage 5 spec constraints:

- No new npm dependency. BM25 and the tokenizer are pure JS in `src/cases/index-store.js` and `src/cases/tokenize.js`; `git` and `gh` are optional system binaries run with `execFile`, no shell.
- Settings (all in `settings.cases`, none security-relevant; no env, `node.yaml` or `service.json` keys): `detours.classifyOwnerMessages: true`, `detours.minConfidence: 0.7`, `detours.classifyTimeoutMs: 4000`, `detours.recentDays: 30`, `detours.maxCandidates: 2`, `duplicates.createSimilarity: 0.6`, `softwareRepo.refreshBudgetMs: 6000`.
- The index lives at `<casesRoot>/.index/` (`.index/.gitignore` is `*`); `meta.json` is `{ version: 1, tokenizer: 'kl-bm25-v1', builtAt }`; case files `.index/cases/<caseId>.json`; only ids matching `^[A-Za-z0-9-]{1,64}$` are indexed.
- Index documents: text capped at 2,000 characters, at most 5,000 documents per case (newest first); BM25 `k1 = 1.2`, `b = 0.75`; same `(subject, attr)` `+5`, same subject `+2`; `searchCases` score = max + 0.3 × the next two.
- Cross-case hit text only for a `fact` with `disclosable: true` or a `brief` `title`/`objective`; every other cross-case hit is `text: null, redacted: true`. No file under `src/` except `index-store.js` contains `includePrivate`.
- Duplicate thresholds: `findDuplicates` and `findDuplicateQuestion` Jaccard ≥ 0.5; detour duplicate Jaccard ≥ 0.8 on the summary; declined detours block re-proposal for 30 days; check-before-write Jaccard ≥ 0.25 or ≥ 2 shared tokens.
- Classifier: owner messages under 12 characters, drafts and `classifyOwnerMessages: false` are skipped; same input cached 10 minutes; `temperature: 0`, `maxTokens: 200`; reason ≤ 200 characters; any failure is on-case with at most one `detour` journal line per turn.
- Routing questions: `kind: 'question'`, `urgency: 'low'` (`'high'` when `blocks`), `defaultOnSilence: 'hold'`, `expiresAt: null`, `payload: { type: 'detour', detourId, blocks, targets, about: { subject: 'detour', attr: <detourId> }, disclosable: false, key: 'detour:<detourId>' }`. Option ids `attach-1`, `attach-2`, `new`, `decline`.
- `software-repo` git calls: env `GIT_OPTIONAL_LOCKS=0`, args `--no-optional-locks -c core.fsmonitor=false -C <repo>`; `gh pr list --repo <host/owner/name>` with no `cwd`; 5 s timeout each; `safe.directory` never overridden. Orientation extras ≤ 2,500 characters, PR titles quoted and cut to 80 characters.
- Journal kind `detour`; wake-up kind `detours:incoming`; case-changed payload `what: 'detours'`.
- Tests that create several cases sharing a title or an objective pass `force: true` to `createCase`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five silent conditions of spec §10, and the test that pins each:

1. **Near-identical titles** ("Sell the lakeside lot" / "Sell lakeside lot"): Task 5 (`tests/cases-runtime-index.test.js`, "refuses an open case with the same title or objective, and a close title, unless forced") and Task 7 (`tests/cases-detour-router.test.js`, "near-identical titles: both cases are distinct attach options with their status").
2. **A case deleted while indexed**: Task 3 (`tests/cases-index.test.js`, "deleted case: no hit, and its index file is gone") and Task 5 ("orientation and open-items show titles, statuses, vanished cases and done blockers").
3. **A repo path that moved**: Task 2 (`tests/cases-case-types.test.js`, "moved repo: the note asks the owner, and the last remote key survives").
4. **An owner message both on-case and a detour**: Task 8 (`tests/cases-detour-hooks.test.js`, "mixed message: one proposal, a note that says continue, and the status unchanged").
5. **The classifier returns malformed JSON**: Task 6 (`tests/cases-detour-classifier.test.js`, "malformed replies (\"onCase: no\", a truncated object, an array) are on-case with one journal line"); Task 8's hooks never propose on a failed classification.

Each cross-case leak path of spec §10 is a named test in `tests/cases-leaks.test.js` or `tests/cases-index.test.js`: "a private fact from case B never appears in any hit text returned to case A" (Task 5), "owner-only brief fields of B are redacted", "questions and journal titles of B are redacted", "no caller outside index-store passes includePrivate" (Task 3), "incoming row copies only the shown text", "routing answer fact is non-disclosable", "proposal rows store no candidate titles" (Task 7), "Ask similar across cases returns title only" (Task 9).

## Interfaces from other stages

C5 builds on cases stage 2 (C2), planned in `docs/superpowers/plans/2026-09-23-cases-stage2-unattended-part1.md` and `-part2.md`. This plan requires C2 merged; the anchors it quotes are C2's code. C3 and C7 are optional.

| Contract | Exact shape consumed | In tests |
|---|---|---|
| C2 turn hooks (program §4.20, R33) | `CaseRuntime.addTurnStartHook(name, fn, { phase: 'turn-start' \| 'owner-message' })`; `fn({ runtime, caseId, dir, meta, ownerMessage, turnId, source, now }) → { notes?, triggers? }`; `runOwnerMessageHooks(turn) → { notes, triggers, orientation }`, called by C2's chat send path after `UserPromptSubmit` passes | the real runtime; Task 8 drives C2's `registerChatHandlers` with a fake agent loop |
| C2 questions (program §4.3) | `CaseRuntime.createQuestion(id, record, { charge = record.kind === 'question' }) → record \| { held: true }` (C2 ships it, Task 10 of its part 2), `answerQuestion(caseId, qid, { channel, text, optionId }) → { question, fact, effect }`, `questions(id)` → `QuestionStore` with `open()`, `get(id)`, `list()`; `QuestionStore.answer` writes `disclosable: false` when `payload.disclosable === false` | real |
| C2 lock helper (R37) | `systemAction(id, label, fn, { commitMessage })` runs inline while this process holds the case lock, else takes it and commits; `CaseBusyError` (`code: 'CASE_BUSY'`) when another process holds it | a lock file whose `pid` is `process.ppid` stands in for another live process |
| C2 roles and usage (program §4.5) | `roleModel(id, 'classify') → { provider, model, tier }`, `routedProvider(turn, { role: 'classify' }).sendMessage(messages, { systemPrompt, temperature, maxTokens, abortSignal })`, `usageHook(turn)(event)`; `host.inferenceRouter.routeWithFallback(tier, messages, opts)`, `host.hasProviderToken(provider)`, `host.getUsageTracker().record(e)` | `host.inferenceRouter` stub returning canned replies |
| C2 trigger baseline | `.kl/triggers.json` `caseTypeMaterial` written from `runtime.caseTypeMaterial(id)` by `Reorient` and clean `endTurn`; hook triggers `{ kind, detail, blocking, key }` are dropped while their `key` is in `acknowledgedKeys` | real |
| C2 wake-ups (program §4.6) | `wakeups(id).register({ kind, at, payload, createdBy })` | real |
| C3 executor registry (program §4.8) | `host.getExecutorRegistry?.()?.liveState?.() → [{ jobId, executorId, signature, state, caseId, intent, recipients }]`; C3's `src/cases/executors/duplicates.js` calls `gates.jobSignature` / `gates.findDuplicateJob` when exported, and C3's `Plan`/`Executor` call `runtime.detourGate?.(id, { source, serves, text, turnId })` | Task 7: `host.getExecutorRegistry = () => ({ liveState: () => rows })` |
| C6 gating sources (program §4.11, R27) | calls `registerGatingSource(fn, { origin })` | Task 2 registers a test source |
| C7 entity index (program §4.10, R46) | `CrossCaseIndex.attachEntities(entityIndex)`; `entities.rebuild()`, `entities.upsertCase(id)`, `entities.removeCase(id)` are called when present | Task 3 attaches a recording stub |

## Deviations and resolved gaps (read before starting)

1. **Settings merge lives in `src/cases/defaults.js`.** C2 moved the `settings.cases` merge into `mergeCaseSettings` / `resolveCaseSettings`; `src/core/settings.js` calls it. The stage-5 keys are added there (Task 5), and `src/core/settings.js` is not edited.
2. **`createQuestion` is C2's.** C2's plan ships `CaseRuntime.createQuestion(id, record, { charge })` with the `questionsPerDay` hold; C5 uses it unchanged (spec §3.9: "If C2 already ships an equivalent, C5 uses C2's").
3. **Hits carry `coverage`** (the share of the query's distinct tokens a document holds). A redacted hit has no text, so `findDuplicates` and `findDuplicateQuestion` judge a redacted hit by its key or by `coverage ≥ 0.5` instead of Jaccard on text. Question documents carry `attr: 'open' | 'answered' | 'closed'` so only open questions elsewhere are named.
4. **`findSimilarCases`** scores the higher of Jaccard on the titles alone and Jaccard on title + objective, so "Redesign the website" still matches "Website redesign" whose objective adds words. Tokens use `kl-bm25-v1`.
5. **`searchCases` rows carry no text**, so it does not read `forCaseId`; the option is accepted and ignored.
6. **The detours and case-type sections are built by `CaseRuntime.orientation()`** (from `router.orientationLines`, `case.yaml.related` and the type's `orientationExtras`), not passed as phase-1 hook notes, so IPC `case:orientation` shows them too. The phase-1 hook returns triggers only.
7. **Case-type trigger keys carry the new value** (`case-type:<field>:<8 hex of sha256(value)>`). With a fixed `case-type:<field>` key, C2's `acknowledgedKeys` would swallow a second change of the same field after a `Reorient`.
8. **Live jobs come from `host.getExecutorRegistry().liveState()`** (C2's host seam), not `runtime.executors`.
9. **A `released` row** joins `.kl/detours.jsonl`: a held proposal gets its question later and records it there. Proposal rows store candidates as `{ caseId, score, optionId }` and never a question text or option label; the routing question is rebuilt from the candidates and the cases' current titles.
10. **`resolve` also takes `force`** (IPC's retry after the owner confirms a similar case). A `failed` or `awaiting-mapping` detour can be resolved again; `attached`, `created` and `declined` are final and return `existing: true`. A closed routing question reconciles as `decline`.
11. **New-case links:** the original gets `spawned` (and `blocked-by` when it blocks); the new case gets `related` (and `blocks`). Attach: `related`/`related`, or `blocked-by`/`blocks`.
12. **The `+1 per summary token equal to a fact subject`** candidate bonus counts, per candidate case, each distinct fact subject whose tokens all appear in the summary (subjects are slugs like `status-polling`).
13. **Classifier skips** (no call, no row) return `{ onCase: true, confidence: 0, reason: '', detour: false, failed: null, skipped }` with `skipped` ∈ `short | draft | disabled | no-router`; a host with no inference router cannot classify, so it skips instead of failing. C2's routed provider takes `abortSignal`, not `signal`.
14. **`refresh(ctx)`** also receives `previous` (the last snapshot, so a moved repo keeps its remote key); tests inject git/gh through `host.exec(file, args, opts)`. An unchanged snapshot is not rewritten, so a quiet turn leaves the case's git tree clean.
15. **No `status.js` edit:** `paused`, `done` and `abandoned` allow only listed read ops, so every `Detour.*` op is refused there already; `draft`, `active` and `needs-direction` deny lists do not name `Detour`.
16. **Existing tests that change:** `tests/cases-gates.test.js` (two cross-case `findDuplicates` tests move to index hits), `tests/cases-runtime.test.js` (the `otherCaseFacts` test is replaced), `tests/cases-ipc.test.js` and `tests/cases-runtime-unattended.test.js` (their `activeCase` helpers pass `force: true`: several cases share an objective), `tests/cases-tools.test.js` (`CASE_TOOL_NAMES` gains `Detour`), `tests/cases-regressions.test.js` (F5 asserts the redacted row), `tests/e2e/cases.test.js` (the first test ignores `.index`).
17. **Setting `repo` from IPC:** there is no brief-editing IPC in C2; the owner sets `repo` through the Brief tool with a quote, or by editing `brief.md` (an owner edit, committed at the next turn).

---

### Task 6: Detour log and classifier

**Files:**
- Create: `src/cases/detours/log.js`, `src/cases/detours/classifier.js`
- Test: `tests/cases-detour-classifier.test.js`

**Interfaces:**
- Consumes: `appendJsonl`, `readJsonl` (`src/cases/jsonl.js`); `CaseRuntime.getCase`, `brief(id)`, `settings()`, `roleModel(id, 'classify')`, `routedProvider(turn, { role: 'classify' })`, `usageHook(turn)`, `records(id).writeJournal`, `turns`, `host.inferenceRouter`, `host.hasProviderToken`, `host.getUsageTracker` (C2).
- Produces:
  - `DetourLog(dir)`: `rows()`, `append(row)` (types `classification | proposal | released | resolution | incoming`; resolution `status` ∈ `attached | created | declined | failed | awaiting-mapping`), `nextId(rows?) → 'd-0001'…`, `detours(rows?) → Map<id, { id, proposal, questionId, resolutions, last, status }>` (status: last resolution's, else `held` / `proposed`), `incoming(rows?)` (deduped on `(fromCaseId, id)`); `FINAL_STATUSES = ['attached', 'created', 'declined']`, `ROW_TYPES`, `RESOLUTION_STATUSES`.
  - `DetourClassifier({ runtime, getSettings?, log?, now? })`, `classify(caseId, { source, text, serves = null, turn }) → Promise<{ onCase, confidence, reason, detour, failed: null | 'timeout' | 'error' | 'malformed' | 'no-role' }>` (skips add `skipped`; cache hits add `cached: true`); `CLASSIFY_SYSTEM`, `parseClassification(raw) → { onCase, confidence, reason } | null`, `SOURCES = ['owner-message', 'plan', 'executor', 'detour-tool']`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-detour-classifier.test.js`:

````js
// tests/cases-detour-classifier.test.js
// The detour classifier (cases stage 5 spec §3.3): strict parsing, the
// decision threshold, skips, the cache, failures that fail open, and usage
// charged to the case.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { DetourClassifier, CLASSIFY_SYSTEM, parseClassification } = require('../src/cases/detours/classifier');
const { DetourLog } = require('../src/cases/detours/log');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-classify-')); dirs.push(d); return d; };

const DETOUR = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes"}';

// A host whose router answers with `reply(messages, opts)`.
function host(reply, { token = true } = {}) {
  const calls = [];
  const recorded = [];
  return {
    calls,
    recorded,
    inferenceRouter: {
      async routeWithFallback(tier, messages, opts) {
        calls.push({ tier, messages, opts });
        return reply(messages, opts, calls.length);
      }
    },
    hasProviderToken: () => token,
    getUsageTracker: () => ({ record: (e) => { recorded.push(e); return { ...e, cost: e.costUsd }; } })
  };
}

async function activeCase(h, settings = {}) {
  const rt = new CaseRuntime({ root: tmp(), host: h, getSettings: () => ({ cases: settings }) });
  const info = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
  rt.brief(info.id).update('why', 'The door lets rain in', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Three written quotes', { provenance: 'model' });
  rt.brief(info.id).update('hardConstraints', ['Under 2,000 dollars'], { provenance: 'user' });
  rt.completeGating(info.id);
  const turn = await rt.beginTurn(info.id, { turnId: 'turn-41', source: 'owner', ownerMessage: 'x' });
  return { rt, info, turn, classifier: new DetourClassifier({ runtime: rt }) };
}

const journalLines = (dir) => fs.readdirSync(path.join(dir, 'journal')).filter((n) => n.endsWith('-detour.md') || /-detour-\d+\.md$/.test(n));

describe('parseClassification', () => {
  it('accepts a bare object, one code fence, trailing prose and extra keys', () => {
    const want = { onCase: false, confidence: 0.9, reason: "Fixing the phone agent's code does not collect quotes" };
    assert.deepStrictEqual(parseClassification(DETOUR), want);
    assert.deepStrictEqual(parseClassification(`\`\`\`json\n${DETOUR}\n\`\`\``), want);
    assert.deepStrictEqual(parseClassification(`${DETOUR}\nHope that helps.`), want);
    assert.deepStrictEqual(parseClassification('{"onCase":true,"confidence":1,"reason":"On case","extra":[1,2]}'), { onCase: true, confidence: 1, reason: 'On case' });
    assert.strictEqual(parseClassification(`{"onCase":true,"confidence":0.5,"reason":"${'r'.repeat(300)}"}`).reason.length, 200);
  });

  it('rejects anything else as malformed', () => {
    for (const bad of [
      `Sure! ${DETOUR}`,
      '{"confidence":0.9,"reason":"x"}',
      '{"onCase":false,"confidence":"0.9","reason":"x"}',
      '{"onCase":false,"confidence":1.5,"reason":"x"}',
      '{"onCase":false,"confidence":0.9,"reason":"  "}',
      '[{"onCase":false,"confidence":0.9,"reason":"x"}]',
      'onCase: no',
      '{"onCase": false, "confidence": 0.9',
      ''
    ]) {
      assert.strictEqual(parseClassification(bad), null, bad);
    }
  });
});

describe('DetourClassifier', () => {
  it('sends the frozen prompt and the case JSON on the classify role, and flags a detour at 0.7', async () => {
    const h = host(() => '{"onCase":false,"confidence":0.7,"reason":"A different project"}');
    const { classifier, info, turn } = await activeCase(h);
    const r = await classifier.classify(info.id, { source: 'owner-message', text: 'Also fix the phone agent status polling', turn });
    assert.deepStrictEqual(r, { onCase: false, confidence: 0.7, reason: 'A different project', detour: true, failed: null });
    const [call] = h.calls;
    assert.strictEqual(call.tier, 'fast');
    assert.strictEqual(call.opts.systemPrompt, CLASSIFY_SYSTEM);
    assert.deepStrictEqual([call.opts.temperature, call.opts.maxTokens], [0, 200]);
    assert.ok(call.opts.abortSignal instanceof AbortSignal);
    assert.deepStrictEqual(JSON.parse(call.messages[0].text), {
      case: { title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door', successCriteria: ['Three written quotes'], hardConstraints: ['Under 2,000 dollars'] },
      work: { source: 'owner-message', serves: null, text: 'Also fix the phone agent status polling' }
    });
    const [row] = new DetourLog(info.dir).rows();
    assert.deepStrictEqual([row.type, row.turnId, row.source, row.onCase, row.confidence, row.failed], ['classification', 'turn-41', 'owner-message', false, 0.7, null]);
  });

  it('treats 0.69 as on-case', async () => {
    const h = host(() => '{"onCase":false,"confidence":0.69,"reason":"Maybe a different project"}');
    const { classifier, info, turn } = await activeCase(h);
    const r = await classifier.classify(info.id, { source: 'plan', text: 'Patch the phone agent', turn });
    assert.deepStrictEqual([r.onCase, r.detour], [false, false]);
  });

  it('skips drafts, short owner messages and the setting, without a call', async () => {
    const h = host(() => DETOUR);
    const { rt, classifier, info, turn } = await activeCase(h);
    assert.strictEqual((await classifier.classify(info.id, { source: 'owner-message', text: 'ok thanks', turn })).skipped, 'short');
    const draft = await rt.createCase({ title: 'Garage sale', objective: 'Clear the garage' });
    assert.strictEqual((await classifier.classify(draft.id, { source: 'owner-message', text: 'Fix the phone agent code now please' })).skipped, 'draft');
    const off = new DetourClassifier({ runtime: rt, getSettings: () => ({ detours: { ...rt.settings().detours, classifyOwnerMessages: false } }) });
    assert.strictEqual((await off.classify(info.id, { source: 'owner-message', text: 'Fix the phone agent code now please', turn })).skipped, 'disabled');
    assert.strictEqual(h.calls.length, 0);
    const plan = await classifier.classify(info.id, { source: 'plan', text: 'ok', turn });
    assert.strictEqual(plan.detour, true, 'plans are classified whatever their length');
  });

  it('caches the same input for ten minutes', async () => {
    const h = host(() => DETOUR);
    const { rt, info, turn } = await activeCase(h);
    let now = new Date('2026-09-23T15:00:00Z');
    const classifier = new DetourClassifier({ runtime: rt, now: () => now });
    const args = { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turn };
    await classifier.classify(info.id, args);
    const again = await classifier.classify(info.id, args);
    assert.strictEqual(again.cached, true);
    assert.strictEqual(h.calls.length, 1);
    await classifier.classify(info.id, { ...args, text: 'Patch the webhook retry in the phone agent' });
    assert.strictEqual(h.calls.length, 2);
    now = new Date('2026-09-23T15:11:00Z');
    await classifier.classify(info.id, args);
    assert.strictEqual(h.calls.length, 3);
  });

  it('times out through its AbortController and fails open with one journal line per turn', async () => {
    const h = host((messages, opts) => new Promise((resolve, reject) => {
      opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { classifier, info, turn } = await activeCase(h, { detours: { classifyTimeoutMs: 30 } });
    const r = await classifier.classify(info.id, { source: 'owner-message', text: 'Fix the phone agent status polling', turn });
    assert.deepStrictEqual(r, { onCase: true, confidence: 0, reason: '', detour: false, failed: 'timeout' });
    assert.strictEqual(h.calls[0].opts.abortSignal.aborted, true);
    await classifier.classify(info.id, { source: 'plan', text: 'Rewrite the phone agent webhook', turn });
    const lines = journalLines(info.dir);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(info.dir, 'journal', lines[0]), 'utf8'), 'Detour classifier failed (timeout) on owner-message; treated as on-case.\n');
    assert.deepStrictEqual(new DetourLog(info.dir).rows().map((r2) => r2.failed), ['timeout', 'timeout']);
  });

  it('malformed replies ("onCase: no", a truncated object, an array) are on-case with one journal line', async () => {
    const replies = ['onCase: no', '{"onCase": false, "confidence": 0.9', '[{"onCase":false,"confidence":0.9,"reason":"x"}]'];
    const h = host((m, o, n) => replies[n - 1]);
    const { classifier, info, turn } = await activeCase(h);
    for (const text of ['Fix the phone agent code', 'Rewrite the webhook handler', 'Move the phone agent to a new host']) {
      const r = await classifier.classify(info.id, { source: 'owner-message', text, turn });
      assert.deepStrictEqual([r.onCase, r.detour, r.failed], [true, false, 'malformed']);
    }
    assert.strictEqual(journalLines(info.dir).length, 1);
  });

  it('skips without a row when the host has no inference router', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Rear door quotes', objective: 'Three written quotes' });
    const r = await new DetourClassifier({ runtime: rt }).classify(info.id, { source: 'plan', text: 'Patch the phone agent' });
    assert.deepStrictEqual([r.onCase, r.detour, r.failed, r.skipped], [true, false, null, 'no-router']);
    assert.deepStrictEqual(new DetourLog(info.dir).rows(), []);
  });

  it('reports an error and a missing provider token without a detour', async () => {
    const failing = host(() => { throw new Error('provider down'); });
    const a = await activeCase(failing);
    assert.strictEqual((await a.classifier.classify(a.info.id, { source: 'plan', text: 'Patch it', turn: a.turn })).failed, 'error');
    const noToken = host(() => DETOUR, { token: false });
    const b = await activeCase(noToken);
    assert.strictEqual((await b.classifier.classify(b.info.id, { source: 'plan', text: 'Patch it', turn: b.turn })).failed, 'no-role');
    assert.strictEqual(noToken.calls.length, 0);
  });

  it('charges the call to the case through usageHook when the reply reports metrics', async () => {
    const h = host(() => ({ content: DETOUR, llmMetrics: { provider: 'openai', model: 'small', inputTokens: 300, outputTokens: 40, totalTokens: 340, costUsd: 0.25 } }));
    const { rt, classifier, info, turn } = await activeCase(h);
    const before = rt.budget(info.id).status().usd.spent;
    const r = await classifier.classify(info.id, { source: 'plan', text: 'Patch the phone agent', turn });
    assert.strictEqual(r.detour, true);
    assert.strictEqual(h.recorded.length, 1);
    assert.strictEqual(rt.budget(info.id).status().usd.spent, before + 0.25);
  });
});
````


- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-detour-classifier.test.js`
Expected: FAIL with `Cannot find module '../src/cases/detours/classifier'`.

- [ ] **Step 3: Implement**

Create `src/cases/detours/log.js`:

````js
// src/cases/detours/log.js
// .kl/detours.jsonl (cases stage 5 spec §4.2): classification, proposal,
// released, resolution and incoming rows, append-only and committed with
// the case. A detour's status is its last resolution's, else held or
// proposed.
const path = require('path');
const { appendJsonl, readJsonl } = require('../jsonl');
const { createLogger } = require('../../logging');

const log = createLogger('cases/detours');

const ROW_TYPES = Object.freeze(['classification', 'proposal', 'released', 'resolution', 'incoming']);
const RESOLUTION_STATUSES = Object.freeze(['attached', 'created', 'declined', 'failed', 'awaiting-mapping']);
// A detour with one of these is settled; resolve returns it as existing.
const FINAL_STATUSES = Object.freeze(['attached', 'created', 'declined']);

class DetourLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'detours.jsonl');
  }

  rows() {
    const { entries, errors } = readJsonl(this.file, (row) => {
      if (!row || typeof row !== 'object' || !ROW_TYPES.includes(row.type)) throw new Error('unknown row type');
    });
    if (errors.length) log.warn(`${this.file}: skipped ${errors.length} malformed line(s)`);
    return entries;
  }

  append(row) {
    if (!ROW_TYPES.includes(row?.type)) throw new Error(`Unknown detour row type "${row?.type}".`);
    if (row.type === 'resolution' && !RESOLUTION_STATUSES.includes(row.status)) {
      throw new Error(`Unknown resolution status "${row.status}".`);
    }
    appendJsonl(this.file, row);
    return row;
  }

  // d- + 4 digits, one past the highest proposal id.
  nextId(rows = this.rows()) {
    let max = 0;
    for (const r of rows) {
      if (r.type !== 'proposal') continue;
      const n = Number(String(r.id).replace(/^d-/, ''));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `d-${String(max + 1).padStart(4, '0')}`;
  }

  // id → { id, proposal, questionId, resolutions, last, status } in proposal order.
  detours(rows = this.rows()) {
    const out = new Map();
    for (const r of rows) {
      if (r.type === 'proposal' && !out.has(r.id)) {
        out.set(r.id, { id: r.id, proposal: r, questionId: r.questionId || null, resolutions: [], last: null, status: r.held ? 'held' : 'proposed' });
      } else if (r.type === 'released' && out.has(r.id)) {
        const d = out.get(r.id);
        d.questionId = r.questionId;
        if (!d.last) d.status = 'proposed';
      } else if (r.type === 'resolution' && out.has(r.id)) {
        const d = out.get(r.id);
        d.resolutions.push(r);
        d.last = r;
        d.status = r.status;
      }
    }
    return out;
  }

  incoming(rows = this.rows()) {
    const seen = new Set();
    return rows.filter((r) => {
      if (r.type !== 'incoming') return false;
      const key = `${r.fromCaseId}\u0000${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = { DetourLog, ROW_TYPES, RESOLUTION_STATUSES, FINAL_STATUSES };
````


Create `src/cases/detours/classifier.js`:

````js
// src/cases/detours/classifier.js
// Does this work serve the case's objective? One `classify` role call per
// owner message, plan or new job (cases stage 5 spec §3.3). Strict parsing;
// every failure is treated as on-case, so the work proceeds exactly as it
// would have without the classifier.
const crypto = require('crypto');
const { DetourLog } = require('./log');
const { createLogger } = require('../../logging');

const SOURCES = Object.freeze(['owner-message', 'plan', 'executor', 'detour-tool']);
const MIN_OWNER_MESSAGE = 12;
const CACHE_MS = 10 * 60 * 1000;
const FIELD_MAX = 2000;

const CLASSIFY_SYSTEM = [
  "You decide whether a piece of work serves a case's objective.",
  'A detour is work that does not advance the objective, success criteria or hard constraints,',
  'even if it is useful elsewhere (fixing a tool, a different errand, a different project).',
  'Work that the objective cannot proceed without is still a detour if it belongs to a different',
  'system or project; say so in the reason.',
  'If the text contains several requests and ANY of them is a detour, answer onCase: false and',
  'quote the off-case part in the reason.',
  'Reply with one JSON object and nothing else:',
  '{"onCase": true|false, "confidence": 0.0-1.0, "reason": "<one sentence, max 200 characters>"}'
].join('\n');

const clip = (s) => String(s ?? '').slice(0, FIELD_MAX);
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(clip) : []);

function textOf(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply.content === 'string') return reply.content;
  return '';
}

// { onCase, confidence, reason } or null (malformed). One surrounding code
// fence is stripped; the reply must then start with `{`; everything after
// the last `}` is ignored.
function parseClassification(raw) {
  let s = String(raw ?? '').trim();
  const fence = /^```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) return null;
  const end = s.lastIndexOf('}');
  if (end === -1) return null;
  let v;
  try {
    v = JSON.parse(s.slice(0, end + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.onCase !== 'boolean') return null;
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null;
  if (typeof v.reason !== 'string' || !v.reason.trim()) return null;
  return { onCase: v.onCase, confidence: v.confidence, reason: v.reason.trim().slice(0, 200) };
}

class DetourClassifier {
  constructor({ runtime, getSettings = null, log = null, now = null } = {}) {
    if (!runtime) throw new Error('DetourClassifier needs the case runtime.');
    this.runtime = runtime;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => runtime.settings();
    this.log = log || createLogger('cases/detours/classifier');
    this.now = typeof now === 'function' ? now : () => runtime.now();
    this.cache = new Map();
    this.failedTurns = new Set();
  }

  _skip(reason) {
    return { onCase: true, confidence: 0, reason: '', detour: false, failed: null, skipped: reason };
  }

  _cacheKey(meta, objective, { source, serves, text }) {
    return crypto.createHash('sha256').update(JSON.stringify([meta.id, objective, source, serves, text])).digest('hex');
  }

  async classify(caseId, { source, text, serves = null, turn = null } = {}) {
    if (!SOURCES.includes(source)) throw new Error(`Unknown classification source "${source}". Sources: ${SOURCES.join(', ')}.`);
    const meta = this.runtime.getCase(caseId);
    const cfg = this.getSettings().detours;
    const body = String(text ?? '');
    if (source === 'owner-message') {
      if (cfg.classifyOwnerMessages === false) return this._skip('disabled');
      if (meta.status === 'draft') return this._skip('draft');
      if (body.trim().length < MIN_OWNER_MESSAGE) return this._skip('short');
    }
    let brief = {};
    try {
      brief = this.runtime.brief(meta.id).read().data || {};
    } catch {
      brief = {};
    }
    const objective = typeof brief.objective === 'string' ? brief.objective : '';
    const key = this._cacheKey(meta, objective, { source, serves, text: body });
    const nowMs = this.now().getTime();
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.at < CACHE_MS) return { ...hit.result, cached: true };

    // A host without an inference router (some tests, tools-only hosts)
    // cannot classify: skip without a row or a journal line.
    if (typeof this.runtime.host?.inferenceRouter?.routeWithFallback !== 'function') return this._skip('no-router');
    const effectiveTurn = turn || this.runtime.turns?.get(meta.id) || { caseId: meta.id, turnId: null, signal: null };
    const started = Date.now();
    const outcome = await this._call(meta, effectiveTurn, cfg, {
      case: {
        title: clip(meta.title),
        type: clip(meta.type || 'general'),
        objective: clip(objective),
        successCriteria: listOf(brief.successCriteria),
        hardConstraints: listOf(brief.hardConstraints)
      },
      work: { source, serves: serves === null || serves === undefined ? null : clip(serves), text: clip(body) }
    });
    const ms = Date.now() - started;
    let result;
    if (outcome.failed) {
      result = { onCase: true, confidence: 0, reason: '', detour: false, failed: outcome.failed };
    } else {
      const detour = outcome.parsed.onCase === false && outcome.parsed.confidence >= cfg.minConfidence;
      if (outcome.parsed.onCase === false && !detour) {
        this.log.info(`low-confidence detour on case ${meta.slug} (${outcome.parsed.confidence}); treated as on-case`);
      }
      result = { ...outcome.parsed, detour, failed: null };
      this.cache.set(key, { at: nowMs, result });
    }
    this._record(meta, effectiveTurn, { source, result, model: outcome.model, ms });
    return result;
  }

  async _call(meta, turn, cfg, payload) {
    let resolved;
    try {
      resolved = this.runtime.roleModel(meta.id, 'classify');
    } catch {
      return { failed: 'no-role', model: null };
    }
    const hasToken = this.runtime.host?.hasProviderToken;
    if (!resolved?.provider || (typeof hasToken === 'function' && hasToken(resolved.provider) === false)) {
      return { failed: 'no-role', model: null };
    }
    const model = `${resolved.provider}/${resolved.model || resolved.tier}`;
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('classify timeout'));
        resolve({ timedOut: true });
      }, cfg.classifyTimeoutMs);
      timer.unref?.();
    });
    let reply;
    try {
      const provider = this.runtime.routedProvider(turn, { role: 'classify' });
      const call = provider.sendMessage(
        [{ sender: 'user', text: JSON.stringify(payload) }],
        { systemPrompt: CLASSIFY_SYSTEM, temperature: 0, maxTokens: 200, abortSignal: controller.signal }
      ).then((value) => ({ value }), (error) => ({ error }));
      const settled = await Promise.race([call, timeout]);
      if (settled.timedOut || controller.signal.aborted) return { failed: 'timeout', model };
      if (settled.error) {
        this.log.warn(`Detour classifier call failed on case ${meta.slug}: ${settled.error.message}`);
        return { failed: 'error', model };
      }
      reply = settled.value;
    } catch (err) {
      this.log.warn(`Detour classifier call failed on case ${meta.slug}: ${err.message}`);
      return { failed: 'error', model };
    } finally {
      clearTimeout(timer);
    }
    this._charge(turn, reply);
    const parsed = parseClassification(textOf(reply));
    return parsed ? { parsed, model } : { failed: 'malformed', model };
  }

  // Providers' sendMessage usually returns bare text; charge the call when
  // it reports metrics, like the orient step.
  _charge(turn, reply) {
    const m = reply && typeof reply === 'object' ? reply.llmMetrics : null;
    if (!m || !turn?.caseId) return;
    const tracker = typeof this.runtime.host?.getUsageTracker === 'function' ? this.runtime.host.getUsageTracker() : null;
    if (!tracker || typeof tracker.record !== 'function') return;
    try {
      this.runtime.usageHook(turn)(tracker.record({
        provider: m.provider, model: m.model, inputTokens: m.inputTokens, outputTokens: m.outputTokens, totalTokens: m.totalTokens, costUsd: m.costUsd
      }));
    } catch (err) {
      this.log.warn(`Charging the classify call failed: ${err.message}`);
    }
  }

  _record(meta, turn, { source, result, model, ms }) {
    try {
      new DetourLog(meta.dir).append({
        type: 'classification',
        at: this.now().toISOString(),
        turnId: turn?.turnId || null,
        source,
        onCase: result.onCase,
        confidence: result.confidence,
        reason: result.reason,
        model,
        ms,
        failed: result.failed
      });
      const turnKey = `${meta.id}:${turn?.turnId || 'no-turn'}`;
      if (result.failed && !this.failedTurns.has(turnKey)) {
        this.failedTurns.add(turnKey);
        this.runtime.records(meta.id).writeJournal('detour', `Detour classifier failed (${result.failed}) on ${source}; treated as on-case.`, this.now());
      }
    } catch (err) {
      this.log.warn(`Recording a classification on case ${meta.slug} failed: ${err.message}`);
    }
  }
}

module.exports = { DetourClassifier, CLASSIFY_SYSTEM, parseClassification, SOURCES };
````


- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-detour-classifier.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/detours/log.js src/cases/detours/classifier.js tests/cases-detour-classifier.test.js
git commit -m "feat(cases): detour log and the classify-role detour classifier

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Detour router

**Files:**
- Create: `src/cases/detours/router.js`
- Test: `tests/cases-detour-router.test.js`; `tests/cases-leaks.test.js` (append one `describe`)

**Interfaces:**
- Consumes: `DetourLog`, `FINAL_STATUSES` (Task 6); `findSimilarCases`, `jaccard`, `OPEN_CASE_STATUSES` (Part 1 gates); `tokenSet`, `tokenize`; `resolveCaseType(type).indexKeys`; `runtime.index` (`searchCases`, `search`, `casesWithKey`, `openCaseHeads`), `store.get`, `assertWritable(id, 'Detour.propose')`, `systemAction`, `createQuestion`, `questions(id)`, `createCase({ …, force })`, `brief(id).update/writeBody`, `addRelation`, `removeRelation`, `records(id).writeJournal`, `wakeups(id).register`, `caseTypeSnapshot`, `_reindex`, `_notify`, `turns`, `settings()`, `host.getExecutorRegistry?.()?.liveState?.()`.
- Produces: `DetourRouter({ runtime, index?, classifier?, getSettings?, log?, now? })` with
  - `propose(caseId, { summary, source = 'detour-tool', serves, blocks, reason, turn, extraAttach = [] }) → Promise<{ ok: true, detour: DetourView & { seeAlso }, questionId, existing?, held? } | { ok: false, error }>`
  - `resolve(caseId, detourId, { optionId, by = 'in-app', title, objective, force }) → Promise<{ ok: true, detour, linkedCaseId, existing? } | { ok: false, error, retry? }>`
  - `reconcile(caseId) → Promise<{ applied: string[], busy?: true }>`
  - `releaseHeld(caseId) → string[]`
  - `list(caseId) → { detours: DetourView[], related: RelatedView[] }`, `orientationLines(caseId) → string[]`
  - `DetourView = { id, summary, reason, blocks, status, questionId, options: [{ optionId, label }], at }`, `RelatedView = { caseId, title, status, relation, detour?, gone? }`; module export `cutTitle(summary)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cases-detour-router.test.js`:

````js
// tests/cases-detour-router.test.js
// The detour router (cases stage 5 spec §3.4): proposals, candidates,
// attach / new / decline, blockers, locks, reconcile and held proposals.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { DetourRouter } = require('../src/cases/detours/router');
const { DetourLog } = require('../src/cases/detours/log');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-router-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://records.example.org/phone' };

async function world({ cases = {}, host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T15:00:00.000Z') };
  const events = [];
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases }),
    host: { notify: (event, payload) => events.push([event, payload]), interactive: () => true, ...host }
  });
  const router = new DetourRouter({ runtime: rt });
  return { rt, router, clock, events };
}

async function activeCase(rt, title, objective, type = 'general') {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (type === 'software-repo') rt.brief(info.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// "Rear door quotes" (outreach) and "Phone agent maintenance", both active.
async function doorAndPhone(opts) {
  const w = await world(opts);
  const door = await activeCase(w.rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
  const phone = await activeCase(w.rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
  w.rt.ledger(phone.id).assert({ stmt: 'Status polling reports dropped calls as completed', subject: 'status-polling', attr: 'bug', value: 'open', source: web });
  return { ...w, door, phone };
}

const PHONE_FIX = { summary: 'Fix the phone agent status polling that drops calls', reason: 'Fixing the phone agent does not collect door quotes', source: 'detour-tool' };

describe('DetourRouter.propose', () => {
  it('offers the case that covers the work, asks a low-urgency routing question and records ids only', async () => {
    const { rt, router, door, phone, events } = await doorAndPhone();
    const r = await router.propose(door.id, PHONE_FIX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.detour.id, 'd-0001');
    assert.deepStrictEqual(r.detour.options.map((o) => [o.optionId, o.label]), [
      ['attach-1', 'Attach to "Phone agent maintenance" (active)'],
      ['new', 'Start a new case: "Fix the phone agent status polling that drops calls"'],
      ['decline', 'Drop it']
    ]);
    const q = rt.questions(door.id).get(r.questionId);
    assert.strictEqual(q.urgency, 'low');
    assert.strictEqual(q.defaultOnSilence, 'hold');
    assert.strictEqual(q.text, 'Detour from "Rear door quotes" (d-0001): Fix the phone agent status polling that drops calls. It does not serve "Three written quotes for the rear door" (Fixing the phone agent does not collect door quotes). Where should it go?');
    assert.deepStrictEqual(q.payload, {
      type: 'detour', detourId: 'd-0001', blocks: false,
      targets: { 'attach-1': phone.id, new: null, decline: null },
      about: { subject: 'detour', attr: 'd-0001' }, disclosable: false, key: 'detour:d-0001', mcpAnswerable: true
    });
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual(Object.keys(row), ['type', 'id', 'at', 'turnId', 'summary', 'source', 'serves', 'blocks', 'reason', 'questionId', 'held', 'candidates', 'newCase']);
    assert.deepStrictEqual(row.candidates.map((c) => [c.caseId, c.optionId]), [[phone.id, 'attach-1']]);
    assert.strictEqual(row.newCase.title, 'Fix the phone agent status polling that drops calls');
    assert.ok(!JSON.stringify(row).includes('Phone agent maintenance'), 'no candidate title in the row');
    assert.ok(fs.readdirSync(path.join(door.dir, 'journal')).some((n) => /-detour\.md$/.test(n)));
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'detours' && p.caseId === door.id));
  });

  it('returns the open proposal for the same work instead of asking again', async () => {
    const { router, door } = await doorAndPhone();
    const first = await router.propose(door.id, PHONE_FIX);
    const again = await router.propose(door.id, { ...PHONE_FIX, summary: 'Fix the phone agent status polling that drops the calls' });
    assert.deepStrictEqual([again.existing, again.questionId, again.detour.id], [true, first.questionId, 'd-0001']);
  });

  it('refuses in paused, done and abandoned cases', async () => {
    const { rt, router, door } = await doorAndPhone();
    rt.setStatus(door.id, 'paused', { kind: 'owner', by: 'owner' });
    const r = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (owner). Only reading is available.' });
  });

  it('near-identical titles: both cases are distinct attach options with their status', async () => {
    const w = await world();
    const well = await activeCase(w.rt, 'Well water test', 'Test the well water');
    const a = await activeCase(w.rt, 'Sell the lakeside lot', 'Convert the lot to cash');
    await assert.rejects(w.rt.createCase({ title: 'Sell lakeside lot' }), (err) => err.code === 'SIMILAR_CASES');
    const b = await w.rt.createCase({ title: 'Sell lakeside lot', force: true });
    const r = await w.router.propose(well.id, { summary: 'Sell the lakeside lot to the neighbour', reason: 'A sale is not a water test' });
    const labels = r.detour.options.map((o) => o.label);
    assert.ok(labels.includes('Attach to "Sell the lakeside lot" (active)'));
    assert.ok(labels.includes('Attach to "Sell lakeside lot" (draft)'));
    const targets = Object.values(w.rt.questions(well.id).get(r.questionId).payload.targets).filter(Boolean);
    assert.deepStrictEqual(targets.sort(), [a.id, b.id].sort());
  });

  it('adds cases on the same repository (+3) and cases with a live matching job (+2)', async () => {
    const liveRows = [];
    const w = await world({ host: { getExecutorRegistry: () => ({ liveState: () => liveRows }) } });
    const repoA = await activeCase(w.rt, 'Phone agent maintenance', 'Keep calls flowing', 'software-repo');
    const repoB = await activeCase(w.rt, 'Webhook cleanup', 'Tidy the handlers', 'software-repo');
    const courier = await activeCase(w.rt, 'Courier pickup', 'Get the parcel collected');
    liveRows.push({ jobId: 'job-0001', executorId: 'phone-agent', signature: 'x', state: 'running', caseId: courier.id, intent: 'Call the courier about the parcel', recipients: ['+15550100'] });
    const r = await w.router.propose(repoA.id, { summary: 'Call the courier about a parcel', reason: 'Not code' });
    const q = w.rt.questions(repoA.id).get(r.questionId);
    assert.strictEqual(q.payload.targets['attach-1'], courier.id);
    assert.strictEqual(q.payload.targets['attach-2'], repoB.id);
    const [row] = new DetourLog(repoA.dir).rows();
    assert.ok(row.candidates.find((c) => c.caseId === repoB.id).score >= 3);
  });

  it('prefills a new case and lists recently closed cases as "See also" only', async () => {
    const { rt, router, door, clock } = await doorAndPhone();
    const piano = await activeCase(rt, 'Piano tuning 2025', 'Tune the piano in the living room');
    rt.setStatus(piano.id, 'done', { kind: 'owner', by: 'owner' });
    clock.now = new Date('2026-10-01T10:00:00.000Z');
    const r = await router.propose(door.id, { summary: 'Book a piano tuner for the living room piano before the party', reason: 'Unrelated errand' });
    assert.deepStrictEqual(r.detour.options.map((o) => o.optionId), ['new', 'decline']);
    assert.strictEqual(r.detour.options[0].label, 'Start a new case: "Book a piano tuner for the living room piano before the party"');
    assert.deepStrictEqual(r.detour.seeAlso, [{ title: 'Piano tuning 2025', status: 'done' }]);
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual(row.newCase, {
      title: 'Book a piano tuner for the living room piano before the party',
      type: 'general',
      objective: 'Book a piano tuner for the living room piano before the party',
      successCriteria: ['Book a piano tuner for the living room piano before the party'],
      body: 'Spawned from case "Rear door quotes": Unrelated errand'
    });
  });
});

describe('DetourRouter.resolve', () => {
  it('attach: links both cases, copies only the shown text, wakes an active target, and is idempotent', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const r = await router.resolve(door.id, 'd-0001', { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, phone.id, 'attached']);
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation, x.detour]), [[phone.id, 'related', 'd-0001']]);
    assert.deepStrictEqual(rt.getCase(phone.id).related.map((x) => [x.id, x.relation, x.detour]), [[door.id, 'related', 'd-0001']]);
    const [incoming] = new DetourLog(phone.dir).incoming();
    assert.deepStrictEqual(incoming, {
      type: 'incoming', id: 'd-0001', at: '2026-09-23T15:00:00.000Z', fromCaseId: door.id, fromTitle: 'Rear door quotes',
      summary: PHONE_FIX.summary, reason: PHONE_FIX.reason, blocks: false
    });
    const wake = rt.wakeups(phone.id).list().find((x) => x.kind === 'detours:incoming');
    assert.deepStrictEqual([wake.payload, wake.createdBy], [{ key: 'incoming:d-0001', detourId: 'd-0001', fromCaseId: door.id }, 'detours']);
    const again = await router.resolve(door.id, 'd-0001', { optionId: 'decline', by: 'in-app' });
    assert.deepStrictEqual([again.ok, again.existing, again.linkedCaseId], [true, true, phone.id]);
    assert.strictEqual(new DetourLog(door.dir).rows().filter((x) => x.type === 'resolution').length, 1);
  });

  it('attach to a draft target registers no wake-up', async () => {
    const { rt, router, door } = await doorAndPhone();
    const draft = await rt.createCase({ title: 'Phone agent status polling rewrite', objective: 'Rewrite the status polling of the phone agent' });
    const p = await router.propose(door.id, { summary: 'Rewrite the phone agent status polling', reason: 'Different project' });
    const option = p.detour.options.find((o) => o.label.includes('Phone agent status polling rewrite'));
    await router.resolve(door.id, p.detour.id, { optionId: option.optionId, by: 'in-app' });
    assert.strictEqual(rt.wakeups(draft.id).list().some((x) => x.kind === 'detours:incoming'), false);
    assert.strictEqual(new DetourLog(draft.dir).incoming().length, 1);
  });

  it('a blocker is high urgency, pending until resolved, then a blocked-by / blocks pair', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, { ...PHONE_FIX, blocks: true });
    const q = rt.questions(door.id).get(p.questionId);
    assert.strictEqual(q.urgency, 'high');
    assert.match(q.text, /^Blocker: Detour from "Rear door quotes"/);
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [['pending:d-0001', 'blocked-by']]);
    await router.resolve(door.id, 'd-0001', { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [[phone.id, 'blocked-by']]);
    assert.deepStrictEqual(rt.getCase(phone.id).related.map((x) => [x.id, x.relation]), [[door.id, 'blocks']]);
    const items = rt.records(door.id).renderOpenItems(new Map(), { blockers: rt._blockers(door.id) });
    assert.match(items, /## Blocked by\n\n- \*\*Phone agent maintenance\*\* \(active\) — Fix the phone agent status polling that drops calls/);
  });

  it('new: creates a draft with the prefill and links spawned / related', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app', title: 'Piano tuner' });
    assert.strictEqual(r.ok, true);
    const created = rt.getCase(r.linkedCaseId);
    assert.deepStrictEqual([created.title, created.status, created.type], ['Piano tuner', 'draft', 'general']);
    const brief = rt.brief(created.id).read();
    assert.deepStrictEqual(brief.data.successCriteria, ['Book a piano tuner for the living room']);
    assert.strictEqual(brief.data.objective, 'Book a piano tuner for the living room');
    assert.strictEqual(brief.body, 'Spawned from case "Rear door quotes": Unrelated errand\n');
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [[created.id, 'spawned']]);
    assert.deepStrictEqual(rt.getCase(created.id).related.map((x) => [x.id, x.relation]), [[door.id, 'related']]);
    const git = require('../src/cases/git');
    assert.strictEqual(await git.isDirty(created.dir), false, 'the new case is committed');
  });

  it('new: SIMILAR_CASES fails the resolution and re-proposes with that case to attach', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' });
    const tuner = await rt.createCase({ title: 'Book a piano tuner' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /A similar case exists: "Book a piano tuner" \(draft\)/);
    assert.strictEqual(r.retry.ok, true);
    const retryQ = rt.questions(door.id).get(r.retry.questionId);
    assert.strictEqual(retryQ.payload.targets['attach-1'], tuner.id);
    assert.ok(!retryQ.options.some((o) => o.id === 'new'));
    const statuses = [...new DetourLog(door.dir).detours().values()].map((d) => [d.id, d.status]);
    assert.deepStrictEqual(statuses, [['d-0001', 'failed'], ['d-0002', 'proposed']]);
    const forced = await router.resolve(door.id, 'd-0001', { optionId: 'new', by: 'in-app', force: true });
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(rt.getCase(forced.linkedCaseId).title, 'Book a piano tuner for the living room');
  });

  it('decline drops a pending blocker and blocks the same proposal for 30 days', async () => {
    const { rt, router, door, clock } = await doorAndPhone();
    const p = await router.propose(door.id, { ...PHONE_FIX, blocks: true });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'decline', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, null, 'declined']);
    assert.deepStrictEqual(rt.getCase(door.id).related, []);
    const again = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual(again, { ok: false, error: `The owner declined this on 2026-09-23 (${p.questionId}). Do not do it in this case and do not propose it again.` });
    clock.now = new Date('2026-10-24T15:00:00.000Z');
    assert.strictEqual((await router.propose(door.id, PHONE_FIX)).ok, true);
  });

  it('a closed target fails the resolution and re-proposes without it', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    rt.setStatus(phone.id, 'done', { kind: 'owner', by: 'owner' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.error], [false, 'Case "Phone agent maintenance" is done; pick another option.']);
    const retryQ = rt.questions(door.id).get(r.retry.questionId);
    assert.ok(!Object.values(retryQ.payload.targets).includes(phone.id));
    assert.deepStrictEqual(rt.getCase(phone.id).related, []);
  });

  it('a busy target writes nothing in either case', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    // Another live process holds the target's turn lock.
    fs.writeFileSync(path.join(phone.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual(r, { ok: false, error: 'Case "Phone agent maintenance" is busy with another turn. Try again when it finishes.' });
    assert.deepStrictEqual([rt.getCase(door.id).related, rt.getCase(phone.id).related], [[], []]);
    assert.strictEqual(new DetourLog(door.dir).rows().some((x) => x.type === 'resolution'), false);
    assert.strictEqual(new DetourLog(phone.dir).incoming().length, 0);
    fs.rmSync(path.join(phone.dir, '.kl', 'lock'));
  });
});

describe('DetourRouter.reconcile, held proposals and views', () => {
  it('resolves option answers, and turns word answers into awaiting-mapping', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const a = await router.propose(door.id, PHONE_FIX);
    const b = await router.propose(door.id, { summary: 'Order a new doorbell for the side gate', reason: 'Not the rear door' });
    await rt.answerQuestion(door.id, a.questionId, { channel: 'telegram', optionId: 'attach-1' });
    await rt.answerQuestion(door.id, b.questionId, { channel: 'in-app', text: 'put it with the house stuff' });
    const out = await router.reconcile(door.id);
    assert.deepStrictEqual(out, { applied: ['d-0001', 'd-0002'] });
    const log = new DetourLog(door.dir).detours();
    assert.deepStrictEqual([log.get('d-0001').status, log.get('d-0001').last.by], ['attached', 'telegram']);
    assert.strictEqual(log.get('d-0002').status, 'awaiting-mapping');
    assert.ok(rt.getCase(phone.id).related.some((x) => x.id === door.id));
    assert.ok(router.orientationLines(door.id).includes(`The owner answered routing question ${b.questionId} in words: "put it with the house stuff". Call Detour "resolve" with the option that matches, or ask.`));
    assert.deepStrictEqual(await router.reconcile(door.id), { applied: [] });
  });

  it('returns busy without reconciling while another process holds the case', async () => {
    const { router, door } = await doorAndPhone();
    fs.writeFileSync(path.join(door.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));
    assert.deepStrictEqual(await router.reconcile(door.id), { applied: [], busy: true });
    fs.rmSync(path.join(door.dir, '.kl', 'lock'));
  });

  it('holds a non-blocking proposal at the daily question cap and asks after the day rolls over', async () => {
    const { rt, router, door, clock } = await doorAndPhone({ cases: { budgets: { questionsPerDay: 1 } } });
    rt.createQuestion(door.id, { kind: 'question', text: 'Which door color?', urgency: 'low' });
    const held = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual([held.ok, held.held, held.questionId, held.detour.status], [true, true, null, 'held']);
    assert.deepStrictEqual(held.detour.options.map((o) => o.optionId), ['attach-1', 'new', 'decline']);
    assert.deepStrictEqual(router.releaseHeld(door.id), []);
    const blocker = await router.propose(door.id, { summary: 'Get the gate code from the landlord', reason: 'The quote visits need it', blocks: true });
    assert.ok(blocker.questionId, 'a blocking proposal overrides the cap');
    assert.strictEqual(rt.questions(door.id).get(blocker.questionId).urgency, 'high');
    clock.now = new Date('2026-09-24T15:00:00.000Z');
    assert.deepStrictEqual(router.releaseHeld(door.id), ['d-0001']);
    const d = new DetourLog(door.dir).detours().get('d-0001');
    assert.strictEqual(d.status, 'proposed');
    assert.match(rt.questions(door.id).get(d.questionId).text, /^Detour from "Rear door quotes" \(d-0001\)/);
  });

  it('list gives titles and statuses only, and marks vanished cases', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    const gone = await rt.createCase({ title: 'Old errand' });
    rt.addRelation(door.id, { id: gone.id, relation: 'related' });
    fs.rmSync(gone.dir, { recursive: true, force: true });
    const view = router.list(door.id);
    assert.deepStrictEqual(view.detours.map((x) => [x.id, x.status, x.questionId]), [['d-0001', 'attached', p.questionId]]);
    assert.deepStrictEqual(view.related, [
      { caseId: phone.id, title: 'Phone agent maintenance', status: 'active', relation: 'related', detour: 'd-0001' },
      { caseId: gone.id, title: null, status: null, relation: 'related', gone: true }
    ]);
  });
});
````


Append to the end of `tests/cases-leaks.test.js`:

````js

describe('cross-case leak paths through detours', () => {
  const { DetourRouter } = require('../src/cases/detours/router');
  const { DetourLog } = require('../src/cases/detours/log');

  async function routed() {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({}), host: { interactive: () => true } });
    const door = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    rt.brief(door.id).update('why', 'The landlord threatened to keep the deposit', { provenance: 'user' });
    rt.ledger(door.id).assert({ stmt: 'Door budget is capped by the savings account balance of 1834', subject: 'door', attr: 'budget', value: 1834, category: 'financial', source: { kind: 'document', ref: 'sources/bank.pdf' } });
    const phone = await rt.createCase({ title: 'Phone agent maintenance', objective: 'Keep the phone agent answering calls and reporting status' });
    const router = new DetourRouter({ runtime: rt });
    const p = await router.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    return { rt, router, door, phone, p };
  }

  it('incoming row copies only the shown text', async () => {
    const { rt, router, door, phone, p } = await routed();
    await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    const [incoming] = new DetourLog(phone.dir).incoming();
    assert.deepStrictEqual(Object.keys(incoming), ['type', 'id', 'at', 'fromCaseId', 'fromTitle', 'summary', 'reason', 'blocks']);
    const shown = rt.questions(door.id).get(p.questionId).text;
    assert.ok(shown.includes(incoming.summary) && shown.includes(incoming.reason) && shown.includes(incoming.fromTitle));
    const targetFiles = JSON.stringify([
      fs.readFileSync(path.join(phone.dir, '.kl', 'detours.jsonl'), 'utf8'),
      fs.readdirSync(path.join(phone.dir, 'journal')).map((n) => fs.readFileSync(path.join(phone.dir, 'journal', n), 'utf8')),
      fs.readFileSync(path.join(phone.dir, 'case.yaml'), 'utf8')
    ]);
    for (const secret of ['landlord', 'deposit', '1834', 'savings account']) assert.ok(!targetFiles.includes(secret), secret);
  });

  it('routing answer fact is non-disclosable', async () => {
    const { rt, door, p } = await routed();
    const out = await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    assert.deepStrictEqual([out.fact.provenance, out.fact.disclosable, out.fact.subject, out.fact.attr], ['user', false, 'detour', 'd-0001']);
    assert.strictEqual(out.fact.value, 'Attach to "Phone agent maintenance" (draft)');
    const hits = rt.index.search({ text: 'attach phone agent maintenance', kinds: ['fact'] });
    assert.ok(hits.filter((h) => h.caseId === door.id).every((h) => h.text === null));
  });

  it('proposal rows store no candidate titles', async () => {
    const { door, phone } = await routed();
    const [row] = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal');
    assert.deepStrictEqual(row.candidates.map((c) => Object.keys(c)), [['caseId', 'score', 'optionId']]);
    assert.strictEqual(row.candidates[0].caseId, phone.id);
    assert.ok(!JSON.stringify(row).includes('Phone agent maintenance'));
  });
});
````


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/cases-detour-router.test.js tests/cases-leaks.test.js`
Expected: FAIL with `Cannot find module '../src/cases/detours/router'`; Part 1's leak tests pass.

- [ ] **Step 3: Implement**

Create `src/cases/detours/router.js`:

````js
// src/cases/detours/router.js
// Routes off-objective work instead of doing it inline (cases stage 5 spec
// §3.4): candidates from the cross-case index, a routing question to the
// owner, and on the answer a link to an existing case, a new case, or
// nothing. Case-file writes run under the case lock through systemAction;
// views carry titles and statuses, never another case's text.
const { DetourLog, FINAL_STATUSES } = require('./log');
const { findSimilarCases, jaccard, OPEN_CASE_STATUSES } = require('../gates');
const { tokenSet, tokenize } = require('../tokenize');
const { resolveCaseType } = require('../case-types');
const { createLogger } = require('../../logging');

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_SIMILARITY = 0.8;
const CLOSED = Object.freeze(['done', 'abandoned']);

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const label = (s) => oneLine(s, 150);

// The summary cut to 72 characters at a word boundary.
function cutTitle(summary) {
  const s = oneLine(summary, 300);
  if (s.length <= 72) return s;
  const cut = s.slice(0, 72);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '');
}

function busyError(title) {
  return { ok: false, error: `Case "${title}" is busy with another turn. Try again when it finishes.` };
}

class DetourRouter {
  constructor({ runtime, index = null, classifier = null, getSettings = null, log = null, now = null } = {}) {
    if (!runtime) throw new Error('DetourRouter needs the case runtime.');
    this.runtime = runtime;
    this._index = index;
    this.classifier = classifier;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => runtime.settings();
    this.log = log || createLogger('cases/detours/router');
    this.now = typeof now === 'function' ? now : () => runtime.now();
  }

  get index() {
    return this._index || this.runtime.index;
  }

  // ---- Propose ----

  async propose(caseId, { summary, source = 'detour-tool', serves = null, blocks = false, reason = '', turn = null, extraAttach = [] } = {}) {
    const rt = this.runtime;
    const text = oneLine(summary, 300);
    if (!text) return { ok: false, error: 'A detour needs a summary of the off-objective work.' };
    const meta = rt.getCase(caseId);
    const refused = rt.assertWritable(meta.id, 'Detour.propose');
    if (refused) return refused;
    try {
      return await rt.systemAction(meta.id, 'detour propose', () => this._propose(meta.id, {
        summary: text, source, serves: serves ? oneLine(serves, 200) : null, blocks: blocks === true, reason: oneLine(reason, 200), turn, extraAttach
      }));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return busyError(meta.title);
      throw err;
    }
  }

  _duplicate(log, rows, summary) {
    const words = tokenSet(summary);
    const nowMs = this.now().getTime();
    for (const d of log.detours(rows).values()) {
      if (jaccard(words, tokenSet(d.proposal.summary)) < DUPLICATE_SIMILARITY) continue;
      if (['proposed', 'held', 'awaiting-mapping'].includes(d.status)) return { existing: d };
      if (d.status === 'declined' && nowMs - Date.parse(d.last.at) <= 30 * DAY_MS) {
        return {
          refusal: {
            ok: false,
            error: `The owner declined this on ${String(d.last.at).slice(0, 10)} (${d.questionId || d.id}). Do not do it in this case and do not propose it again.`
          }
        };
      }
    }
    return {};
  }

  // Open cases ranked for attach options, and recently closed ones as "See also".
  _candidates(meta, summary, reason) {
    const rt = this.runtime;
    const index = this.index;
    const cfg = this.getSettings().detours;
    const scores = new Map();
    const bump = (caseId, n) => {
      if (caseId === meta.id) return;
      scores.set(caseId, (scores.get(caseId) || 0) + n);
    };
    const rows = index.searchCases({ text: `${summary} ${reason}`, forCaseId: meta.id, excludeCaseId: meta.id, limit: 20 });
    const seeAlso = [];
    const recentMs = cfg.recentDays * DAY_MS;
    for (const r of rows) {
      if (OPEN_CASE_STATUSES.includes(r.status)) {
        bump(r.caseId, r.score);
      } else if (CLOSED.includes(r.status)) {
        const at = Date.parse(rt.store.get(r.caseId)?.statusReason?.at || '');
        if (Number.isFinite(at) && this.now().getTime() - at <= recentMs) seeAlso.push({ caseId: r.caseId, title: r.title, status: r.status });
      }
    }
    const words = new Set(tokenize(summary));
    const subjects = new Map();
    for (const hit of index.search({ text: summary, kinds: ['fact'], forCaseId: meta.id, excludeCaseId: meta.id, statuses: OPEN_CASE_STATUSES, limit: 50 })) {
      const toks = tokenize(hit.subject);
      if (!toks.length || !toks.every((t) => words.has(t))) continue;
      if (!subjects.has(hit.caseId)) subjects.set(hit.caseId, new Set());
      subjects.get(hit.caseId).add(String(hit.subject).toLowerCase());
    }
    for (const [caseId, set] of subjects) bump(caseId, set.size);
    if (meta.type === 'software-repo') {
      const type = resolveCaseType(meta.type);
      let brief = {};
      try {
        brief = rt.brief(meta.id).read().data || {};
      } catch {
        brief = {};
      }
      const keys = type.indexKeys({ brief, snapshot: rt.caseTypeSnapshot(meta.id) });
      const onRepo = new Set();
      for (const k of keys) for (const c of index.casesWithKey(k)) if (OPEN_CASE_STATUSES.includes(c.status)) onRepo.add(c.caseId);
      for (const caseId of onRepo) bump(caseId, 3);
    }
    let live = [];
    try {
      const registry = typeof rt.host?.getExecutorRegistry === 'function' ? rt.host.getExecutorRegistry() : null;
      live = registry && typeof registry.liveState === 'function' ? registry.liveState() || [] : [];
    } catch (err) {
      this.log.warn(`Reading live executor jobs failed: ${err.message}`);
    }
    const jobCases = new Set();
    for (const job of live) {
      if (!job || jobCases.has(job.caseId)) continue;
      const jobWords = new Set(tokenize(`${job.executorId || ''} ${job.intent || ''}`));
      if (![...words].some((t) => jobWords.has(t))) continue;
      const other = rt.store.get(job.caseId);
      if (!other || !OPEN_CASE_STATUSES.includes(other.status)) continue;
      jobCases.add(job.caseId);
      bump(job.caseId, 2);
    }
    const ranked = [...scores.entries()]
      .map(([caseId, score]) => ({ caseId, score: Math.round(score * 1000) / 1000, meta: rt.store.get(caseId) }))
      .filter((c) => c.meta && OPEN_CASE_STATUSES.includes(c.meta.status))
      .sort((a, b) => b.score - a.score || String(a.meta.created).localeCompare(String(b.meta.created)));
    return { ranked, seeAlso };
  }

  async _propose(caseId, { summary, source, serves, blocks, reason, turn, extraAttach }) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const rows = log.rows();
    const dup = this._duplicate(log, rows, summary);
    if (dup.refusal) return dup.refusal;
    if (dup.existing) return { ok: true, detour: this._view(meta, dup.existing), questionId: dup.existing.questionId, existing: true };

    const cfg = this.getSettings();
    const { ranked, seeAlso } = this._candidates(meta, summary, reason);
    let brief = {};
    try {
      brief = rt.brief(meta.id).read().data || {};
    } catch {
      brief = {};
    }
    const prefill = {
      title: cutTitle(summary),
      type: meta.type === 'software-repo' && brief.repo ? 'software-repo' : 'general',
      objective: summary,
      successCriteria: [summary],
      body: `Spawned from case "${meta.title}": ${reason || summary}`
    };
    const similar = findSimilarCases({
      title: prefill.title,
      objective: prefill.objective,
      candidates: this.index.openCaseHeads().filter((h) => h.caseId !== meta.id),
      threshold: cfg.duplicates.createSimilarity
    });
    const first = [...(Array.isArray(extraAttach) ? extraAttach : []), ...[...similar.exact, ...similar.similar].map((s) => s.caseId)];
    const attach = [];
    for (const caseId of first) {
      const m = rt.store.get(caseId);
      if (m && m.id !== meta.id && OPEN_CASE_STATUSES.includes(m.status) && !attach.some((a) => a.caseId === m.id)) {
        attach.push({ caseId: m.id, score: ranked.find((r) => r.caseId === m.id)?.score || 0, meta: m });
      }
    }
    const offerNew = attach.length === 0;
    for (const c of ranked) {
      if (attach.length >= cfg.detours.maxCandidates) break;
      if (!attach.some((a) => a.caseId === c.caseId)) attach.push(c);
    }
    const detourId = log.nextId(rows);
    const candidates = attach.map((c, i) => ({ caseId: c.caseId, score: c.score, optionId: `attach-${i + 1}` }));
    const newCase = offerNew ? prefill : null;
    const record = this._question(meta, detourId, { summary, reason, blocks, candidates, newCase });
    const created = rt.createQuestion(meta.id, record, { charge: !blocks });
    const held = Boolean(created && created.held);
    const questionId = held ? null : created.id;
    // Candidates are stored by case id and score only: no other case's title.
    const proposal = log.append({
      type: 'proposal',
      id: detourId,
      at: this.now().toISOString(),
      turnId: turn?.turnId || rt.turns?.get(meta.id)?.turnId || null,
      summary,
      source,
      serves,
      blocks,
      reason,
      questionId,
      held,
      candidates,
      newCase
    });
    rt.records(meta.id).writeJournal('detour', [
      `# Detour ${detourId}`,
      '',
      `Summary: ${summary}`,
      `Reason: ${reason || '—'}`,
      `Source: ${source}${serves ? ` (serves: ${serves})` : ''}`,
      `Blocks this case: ${blocks ? 'yes' : 'no'}`,
      `Options: ${record.options.map((o) => o.id).join(', ')}`,
      held ? 'Question held: the daily question allowance is spent.' : `Question: ${questionId}`
    ].join('\n'), this.now());
    if (blocks) rt.addRelation(meta.id, { id: `pending:${detourId}`, relation: 'blocked-by', note: summary, detour: detourId });
    rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
    const view = this._view(meta, { id: detourId, proposal, questionId, status: held ? 'held' : 'proposed', last: null });
    return { ok: true, detour: { ...view, seeAlso: seeAlso.map((s) => ({ title: s.title, status: s.status })) }, questionId, ...(held ? { held: true } : {}) };
  }

  // The routing question, built from the stored candidates and the current
  // titles and statuses of the cases they name.
  _question(meta, detourId, { summary, reason, blocks, candidates = [], newCase = null }) {
    const rt = this.runtime;
    const options = [];
    const targets = {};
    for (const c of candidates) {
      const m = rt.store.get(c.caseId);
      options.push({ id: c.optionId, label: `Attach to "${label(m ? m.title : c.caseId)}" (${m ? m.status : 'gone'})` });
      targets[c.optionId] = c.caseId;
    }
    if (newCase) {
      options.push({ id: 'new', label: `Start a new case: "${label(newCase.title)}"` });
      targets.new = null;
    }
    options.push({ id: 'decline', label: 'Drop it' });
    targets.decline = null;
    let objective = '';
    try {
      objective = rt.brief(meta.id).read().data?.objective || '';
    } catch {
      objective = '';
    }
    const text = `${blocks ? 'Blocker: ' : ''}Detour from "${meta.title}" (${detourId}): ${summary}. It does not serve "${oneLine(objective, 200) || meta.title}"${reason ? ` (${reason})` : ''}. Where should it go?`;
    return {
      kind: 'question',
      urgency: blocks ? 'high' : 'low',
      defaultOnSilence: 'hold',
      expiresAt: null,
      options,
      text,
      payload: {
        type: 'detour',
        detourId,
        blocks: Boolean(blocks),
        targets,
        about: { subject: 'detour', attr: detourId },
        disclosable: false,
        key: `detour:${detourId}`
      }
    };
  }

  // Held proposals get their question once the daily allowance allows.
  releaseHeld(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const released = [];
    for (const d of log.detours().values()) {
      if (d.status !== 'held') continue;
      const created = rt.createQuestion(meta.id, this._question(meta, d.id, d.proposal), { charge: true });
      if (created.held) break;
      log.append({ type: 'released', id: d.id, at: this.now().toISOString(), questionId: created.id });
      released.push(d.id);
    }
    if (released.length) rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
    return released;
  }

  // ---- Resolve ----

  async resolve(caseId, detourId, { optionId, by = 'in-app', title = null, objective = null, force = false } = {}) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    try {
      return await rt.systemAction(meta.id, `detour ${detourId}: ${optionId}`, () => this._resolve(meta.id, detourId, { optionId, by, title, objective, force }));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return busyError(meta.title);
      throw err;
    }
  }

  async _resolve(caseId, detourId, { optionId, by, title, objective, force }) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const d = log.detours().get(detourId);
    if (!d) return { ok: false, error: `There is no detour ${detourId} in this case.` };
    if (d.last && FINAL_STATUSES.includes(d.last.status)) {
      return { ok: true, detour: this._view(meta, d), linkedCaseId: d.last.targetCaseId || null, existing: true };
    }
    const p = d.proposal;
    // An answer in words that the model mapped: both cases journal the words.
    const words = d.status === 'awaiting-mapping' && d.last?.text ? `\nOwner's words (mapped by the model): "${oneLine(d.last.text, 500)}"` : '';
    const at = () => this.now().toISOString();
    const resolution = (status, extra = {}) => log.append({
      type: 'resolution', id: detourId, at: at(), optionId, by: String(by), status, targetCaseId: null, error: null, ...extra
    });
    const finish = (status, targetCaseId, extra = {}) => {
      rt.removeRelation(meta.id, { id: `pending:${detourId}` });
      resolution(status, { targetCaseId, ...extra });
      rt.records(meta.id).writeJournal('detour', `# Detour ${detourId} resolved\n\nOption: ${optionId} (${by})\nOutcome: ${status}${targetCaseId ? `\nCase: ${targetCaseId}` : ''}${words}`, this.now());
      rt._reindex(meta.id);
      rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
      return { ok: true, detour: this._view(meta, log.detours().get(detourId)), linkedCaseId: targetCaseId };
    };
    const retry = async (error, extraAttach = []) => {
      resolution('failed', { error });
      const again = await this._propose(meta.id, {
        summary: p.summary, source: p.source, serves: p.serves, blocks: p.blocks, reason: p.reason, turn: null, extraAttach
      });
      return { ok: false, error, retry: again };
    };

    if (optionId === 'decline') return finish('declined', null);

    if (/^attach-\d+$/.test(String(optionId))) {
      const cand = (p.candidates || []).find((c) => c.optionId === optionId);
      if (!cand) return { ok: false, error: `Option "${optionId}" is not one of ${detourId}'s options.` };
      const target = rt.store.get(cand.caseId);
      if (!target || !OPEN_CASE_STATUSES.includes(target.status)) {
        return retry(`Case "${target ? target.title : cand.caseId}" is ${target ? target.status : 'gone'}; pick another option.`);
      }
      try {
        await rt.systemAction(target.id, `detour ${detourId} from ${meta.slug}`, async () => {
          rt.addRelation(target.id, { id: meta.id, relation: p.blocks ? 'blocks' : 'related', note: p.summary, detour: detourId });
          new DetourLog(target.dir).append({
            type: 'incoming', id: detourId, at: at(), fromCaseId: meta.id, fromTitle: meta.title, summary: p.summary, reason: p.reason, blocks: p.blocks
          });
          rt.records(target.id).writeJournal('detour', `# Incoming detour ${detourId} from "${meta.title}"\n\nSummary: ${p.summary}\nReason: ${p.reason || '—'}\nBlocks "${meta.title}": ${p.blocks ? 'yes' : 'no'}${words}`, this.now());
          if (target.status === 'active') {
            rt.wakeups(target.id).register({
              kind: 'detours:incoming', at: at(), payload: { key: `incoming:${detourId}`, detourId, fromCaseId: meta.id }, createdBy: 'detours'
            });
          }
          rt._notify('case:changed', { caseId: target.id, what: 'detours' });
        });
      } catch (err) {
        if (err && err.code === 'CASE_BUSY') return busyError(target.title);
        throw err;
      }
      rt.addRelation(meta.id, { id: target.id, relation: p.blocks ? 'blocked-by' : 'related', note: p.summary, detour: detourId });
      return finish('attached', target.id);
    }

    if (optionId === 'new') {
      if (!p.newCase) return { ok: false, error: `Option "new" is not one of ${detourId}'s options.` };
      let created;
      try {
        created = await rt.createCase({
          title: title && String(title).trim() ? String(title).trim() : p.newCase.title,
          type: p.newCase.type,
          objective: objective && String(objective).trim() ? String(objective).trim() : p.newCase.objective,
          force: force === true
        });
      } catch (err) {
        if (err && err.code === 'SIMILAR_CASES') return retry(err.message, err.similar.map((s) => s.caseId));
        throw err;
      }
      await rt.systemAction(created.id, `detour ${detourId} from ${meta.slug}`, async () => {
        rt.brief(created.id).update('successCriteria', p.newCase.successCriteria, { provenance: 'model' });
        rt.brief(created.id).writeBody(p.newCase.body);
        rt.records(created.id).writeJournal('detour', `# Spawned by detour ${detourId} from "${meta.title}"\n\nSummary: ${p.summary}\nReason: ${p.reason || '—'}${words}`, this.now());
        rt.addRelation(created.id, { id: meta.id, relation: 'related', note: p.summary, detour: detourId });
        if (p.blocks) rt.addRelation(created.id, { id: meta.id, relation: 'blocks', note: p.summary, detour: detourId });
      }, { commitMessage: `spawned from ${meta.slug} (${detourId})` });
      rt.addRelation(meta.id, { id: created.id, relation: 'spawned', note: p.summary, detour: detourId });
      if (p.blocks) rt.addRelation(meta.id, { id: created.id, relation: 'blocked-by', note: p.summary, detour: detourId });
      rt._reindex(created.id);
      return finish('created', created.id);
    }

    return { ok: false, error: `Option "${optionId}" is not one of ${detourId}'s options.` };
  }

  // ---- Reconcile ----

  // Answered routing questions with no resolution: an option resolves; a
  // text-only answer waits for the model to map it (awaiting-mapping).
  async reconcile(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    try {
      return await rt.systemAction(meta.id, 'detour reconcile', async () => {
        const applied = [];
        const log = new DetourLog(meta.dir);
        const questions = rt.questions(meta.id);
        for (const d of log.detours().values()) {
          if (d.status !== 'proposed' || !d.questionId) continue;
          const q = questions.get(d.questionId);
          if (!q) continue;
          if (q.closed) {
            const r = await this._resolve(meta.id, d.id, { optionId: 'decline', by: q.closed.by });
            if (r.ok) applied.push(d.id);
            continue;
          }
          if (!q.answer) continue;
          if (q.answer.optionId) {
            const r = await this._resolve(meta.id, d.id, { optionId: q.answer.optionId, by: q.answer.channel });
            if (r.ok || r.retry) applied.push(d.id);
          } else {
            log.append({
              type: 'resolution', id: d.id, at: this.now().toISOString(), optionId: null, by: q.answer.channel,
              status: 'awaiting-mapping', targetCaseId: null, error: null, text: oneLine(q.answer.text, 500)
            });
            applied.push(d.id);
          }
        }
        if (applied.length) rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
        return { applied };
      });
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { applied: [], busy: true };
      throw err;
    }
  }

  // ---- Views ----

  _view(meta, d) {
    let options = [];
    if (d.questionId) {
      const q = this.runtime.questions(meta.id).get(d.questionId);
      if (q) options = q.options.map((o) => ({ optionId: o.id, label: o.label }));
    } else {
      options = this._question(meta, d.id, d.proposal).options.map((o) => ({ optionId: o.id, label: o.label }));
    }
    return {
      id: d.id,
      summary: d.proposal.summary,
      reason: d.proposal.reason,
      blocks: Boolean(d.proposal.blocks),
      status: d.status,
      questionId: d.questionId || null,
      options,
      at: d.proposal.at
    };
  }

  list(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const detours = [...new DetourLog(meta.dir).detours().values()].map((d) => this._view(meta, d));
    const related = (Array.isArray(meta.related) ? meta.related : [])
      .filter((r) => r && typeof r.id === 'string' && !r.id.startsWith('pending:'))
      .map((r) => {
        const other = rt.store.get(r.id);
        return {
          caseId: r.id,
          title: other ? other.title : null,
          status: other ? other.status : null,
          relation: r.relation,
          ...(r.detour ? { detour: r.detour } : {}),
          ...(other ? {} : { gone: true })
        };
      });
    return { detours, related };
  }

  // Orientation lines: open proposals, answers awaiting mapping, incoming detours.
  orientationLines(caseId) {
    const meta = this.runtime.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const rows = log.rows();
    const lines = [];
    for (const d of log.detours(rows).values()) {
      if (d.status === 'proposed') lines.push(`${d.id} proposed${d.proposal.blocks ? ' (blocks this case)' : ''}: ${oneLine(d.proposal.summary, 160)} — routing question ${d.questionId} is waiting for the owner. Do not do this work here.`);
      if (d.status === 'held') lines.push(`${d.id} held: ${oneLine(d.proposal.summary, 160)} — the routing question goes out when the daily question allowance allows.`);
      if (d.status === 'awaiting-mapping') lines.push(`The owner answered routing question ${d.questionId} in words: "${oneLine(d.last.text, 300)}". Call Detour "resolve" with the option that matches, or ask.`);
    }
    for (const r of log.incoming(rows)) {
      lines.push(`Incoming detour ${r.id} from "${oneLine(r.fromTitle, 120)}": ${oneLine(r.summary, 160)}${r.reason ? ` (${oneLine(r.reason, 160)})` : ''}${r.blocks ? ' — it blocks that case' : ''}`);
    }
    return lines;
  }
}

module.exports = { DetourRouter, cutTitle };
````


- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-detour-router.test.js tests/cases-leaks.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/detours/router.js tests/cases-detour-router.test.js tests/cases-leaks.test.js
git commit -m "feat(cases): detour router with candidates, routing questions, attach/new/decline and reconcile

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Turn hooks, `detourGate` and the runtime's detour getters

**Files:**
- Create: `src/cases/detours/hooks.js`
- Modify: `src/cases/case-runtime.js` (the `require('./case-types')` line from Part 1; the end of the constructor, `    this.turns = new Map();` / `    this.hooks = [];`; the `_detourLines(meta)` method from Part 1)
- Test: `tests/cases-detour-hooks.test.js`

**Interfaces:**
- Consumes: `DetourClassifier` (Task 6), `DetourRouter` (Task 7); `resolveCaseType(type).refresh`, `.checkBeforeWriteFor` (Part 1); C2's `addTurnStartHook`, `runOwnerMessageHooks`, `.kl/triggers.json` `caseTypeMaterial`; `readJson`, `writeJsonIfChanged`; `host.exec` (optional, tests).
- Produces:
  - `registerDetourHooks(runtime)` (hooks `detours`, phase `turn-start`, and `detours:classify`, phase `owner-message`), `refreshCaseType(runtime, meta)`, `caseTypeTriggers(runtime, meta) → Trigger[]` (`{ kind: 'case-type-change', detail: '<field> changed: <old> → <new>', blocking: true, key: 'case-type:<field>:<hash8>' }`).
  - `CaseRuntime`: `classifier` and `detours` (lazy getters), `detourGate(id, { source: 'plan' | 'executor', serves, text, turnId }) → Promise<{ ok: true, note? } | { ok: false, error, classification }>`; the constructor registers the two hooks; `_detourLines(meta)` = router lines, then related lines.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-detour-hooks.test.js`:

````js
// tests/cases-detour-hooks.test.js
// The two detour hooks (cases stage 5 spec §3.6) through the real runtime
// and C2's chat send path, the case-type refresh and trigger, and
// CaseRuntime.detourGate (spec §3.5).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseRuntime } = require('../src/cases');
const { DetourLog } = require('../src/cases/detours/log');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hooks-')); dirs.push(d); return d; };

const DETOUR = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes."}';

function makeRuntime({ reply = () => DETOUR, cases = {}, exec } = {}) {
  const calls = [];
  const rt = new CaseRuntime({
    root: tmp(),
    getSettings: () => ({ cases }),
    host: {
      inferenceRouter: { async routeWithFallback(tier, messages, opts) { calls.push({ tier, messages, opts }); return reply(messages, opts); } },
      interactive: () => true,
      ...(exec ? { exec } : {})
    }
  });
  return { rt, calls };
}

async function activeCase(rt, title, objective, type = 'general', repo = null) {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (repo) rt.brief(info.id).update('repo', repo, { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// C2's chat send path with the real runtime; the agent loop only records.
function chatHarness(rt, caseId, { hookResult = null } = {}) {
  const seen = { prompts: [] };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [] };
  class FakeLoop {
    async run(messages, tools, options) {
      seen.prompts.push(options.systemPrompt);
      return { content: 'Noted.', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } };
    }
  }
  const overrides = {
    getChats: () => [chat],
    setChats: () => {},
    appendMessageToChat: (_id, sender, text) => { chat.messages.push({ id: `m${chat.messages.length}`, sender, text, timestamp: new Date().toISOString() }); return chat; },
    runHookEvent: async () => hookResult || {},
    resolveInference: async () => ({ providerType: 'openai', provider: { sendMessageWithTools: async () => ({}) }, model: 'test-model', tier: 'standard', timeoutMs: 1000 }),
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async () => ({ on() {}, execute: async () => ({ ok: true }) }),
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop: FakeLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    getCaseRuntime: () => rt,
    createId: () => `id-${Math.random().toString(16).slice(2)}`
  };
  const context = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const event = { sender: { send() {}, isDestroyed: () => false } };
  const send = (message) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message, agentMode: true });
  return { send, seen };
}

describe('owner-message phase', () => {
  it('does not run when UserPromptSubmit blocks the message', async () => {
    const { rt, calls } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const { send } = chatHarness(rt, door.id, { hookResult: { action: 'deny', message: 'not now' } });
    const result = await send('Please fix the phone agent code that drops calls');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls.length, 0, 'no classify call');
    assert.deepStrictEqual(new DetourLog(door.dir).rows(), []);
    assert.deepStrictEqual(rt.questions(door.id).open(), []);
  });

  it('mixed message: one proposal, a note that says continue, and the status unchanged', async () => {
    const { rt, calls } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const phone = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const { send, seen } = chatHarness(rt, door.id);
    const message = 'Get the third quote from the glazier, and also fix the phone agent code that drops calls';
    const result = await send(message);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    const proposals = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal');
    assert.strictEqual(proposals.length, 1);
    assert.strictEqual(proposals[0].source, 'owner-message');
    assert.strictEqual(proposals[0].summary, message);
    const q = rt.questions(door.id).get(proposals[0].questionId);
    assert.strictEqual(q.payload.targets['attach-1'], phone.id);
    const prompt = seen.prompts[0];
    assert.ok(prompt.includes(`Detour check: the owner's message asks for work outside this case's objective (Fixing the phone agent's code does not collect quotes). Do that part in this case only if the owner insists. Routing proposal ${q.id} (attach to "Phone agent maintenance" (active) / new case / drop) is waiting. Say so in one line, then continue with the on-case part.`));
    assert.strictEqual(rt.getCase(door.id).status, 'active');
    await send(message);
    assert.strictEqual(new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal').length, 1, 'the same message proposes once');
  });

  it('adds the check-before-write note on a software-repo case', async () => {
    const snapshot = { stdout: '[{"number":12,"title":"Fix status polling","headRefName":"fix/status-poll","url":"https://github.com/example/phone-agent/pull/12","isDraft":false}]', stderr: '', code: 0 };
    const exec = async (file) => (file === 'gh' ? snapshot : { stdout: '', stderr: '', code: 1 });
    const { rt } = makeRuntime({ reply: () => '{"onCase":true,"confidence":0.95,"reason":"Fixing the agent is the objective"}', exec });
    const repo = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', 'https://github.com/example/phone-agent.git');
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Please fix the status polling bug' });
    const out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(out.notes, ['Before writing code: this may already be in flight — PR #12 "Fix status polling" (fix/status-poll). Check them first and say which you are building on.']);
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('turn-start phase', () => {
  it('reconciles an answered routing question before the orientation is built', async () => {
    const { rt } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await rt.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'Different project' });
    assert.match(rt.orientation(door.id), /d-0001 proposed: Fix the phone agent status polling — routing question q-0001 is waiting for the owner/);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-2', source: 'wakeup' });
    assert.match(turn.orientation, /## Detours and related cases\n- related: "Phone agent maintenance" \(active\) — Fix the phone agent status polling/);
    assert.doesNotMatch(turn.orientation, /d-0001 proposed/);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('refreshes the software-repo snapshot and raises a blocking case-type trigger against the baseline', async () => {
    let head = 'aaaaaaa1111111';
    const exec = async (file, args) => {
      const cmd = args.slice(5).join(' ');
      if (file === 'gh') return { stdout: '[]', stderr: '', code: 0 };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '', code: 0 };
      if (cmd === 'rev-parse HEAD') return { stdout: `${head}\n`, stderr: '', code: 0 };
      if (cmd.startsWith('remote')) return { stdout: 'https://github.com/example/phone-agent.git\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { rt } = makeRuntime({ exec });
    const repoDir = tmp();
    const c = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', repoDir);
    let turn = await rt.beginTurn(c.id, { turnId: 'turn-1', source: 'wakeup' });
    assert.deepStrictEqual(turn.triggers.filter((t) => t.kind === 'case-type-change'), [], 'no baseline yet');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8')).state.head, 'aaaaaaa1111111');
    await rt.endTurn(turn, { summary: 'first look' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'triggers.json'), 'utf8')).caseTypeMaterial, { head: 'aaaaaaa1111111', branch: 'main', openPrs: [] });
    head = 'bbbbbbb2222222';
    turn = await rt.beginTurn(c.id, { turnId: 'turn-2', source: 'wakeup' });
    const [t] = turn.triggers.filter((x) => x.kind === 'case-type-change');
    assert.deepStrictEqual([t.detail, t.blocking], ['head changed: aaaaaaa1111111 → bbbbbbb2222222', true]);
    assert.match(t.key, /^case-type:head:[0-9a-f]{8}$/);
    assert.strictEqual(turn.reorientPending, true);
    assert.match(turn.orientation, /## Re-orientation required\n- head changed: aaaaaaa1111111 → bbbbbbb2222222/);
    await rt.endTurn(turn, { summary: 'second look' });
  });

  it('uses the stale snapshot when git and gh overrun the budget, and writes the late result next turn', async () => {
    let gate = null;
    let release;
    let branch = 'main';
    const exec = async (file, args) => {
      if (gate) await gate;
      if (file === 'gh') return { stdout: '[]', stderr: '', code: 0 };
      const cmd = args.slice(5).join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: `${branch}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { rt } = makeRuntime({ exec, cases: { softwareRepo: { refreshBudgetMs: 30 } } });
    const c = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', tmp());
    let turn = await rt.beginTurn(c.id, { turnId: 'turn-1', source: 'wakeup' });
    await rt.endTurn(turn, { summary: 'first' });
    const fetched = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8')).fetchedAt;
    branch = 'fix/status-poll';
    gate = new Promise((resolve) => { release = resolve; });
    turn = await rt.beginTurn(c.id, { turnId: 'turn-2', source: 'wakeup' });
    assert.ok(turn.orientation.includes(`(stale, fetched ${fetched})`));
    await rt.endTurn(turn, { summary: 'second' });
    gate = null;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(rt.caseTypeSnapshot(c.id).state.branch, 'fix/status-poll', 'the late result lands in memory');
    turn = await rt.beginTurn(c.id, { turnId: 'turn-3', source: 'wakeup' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8'));
    assert.deepStrictEqual([onDisk.stale, onDisk.state.branch], [false, 'fix/status-poll']);
    await rt.endTurn(turn, { summary: 'third' });
  });
});

describe('CaseRuntime.detourGate', () => {
  it('refuses a detour with the Detour instruction, passes unsure work with a note, and fails open', async () => {
    let reply = DETOUR;
    const { rt } = makeRuntime({ reply: () => reply });
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'go' });
    const refused = await rt.detourGate(door.id, { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turnId: 'turn-1' });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, 'This work looks like a detour from the case objective ("Three written quotes for the rear door"): Fixing the phone agent\'s code does not collect quotes. Do not do it in this case. Call Detour with action "propose" (blocks: true if this case cannot proceed without it), then continue with on-case work.');
    assert.strictEqual(refused.classification.detour, true);
    reply = '{"onCase":false,"confidence":0.5,"reason":"Might be for another project"}';
    assert.deepStrictEqual(await rt.detourGate(door.id, { source: 'plan', text: 'Call three glaziers and the phone vendor', turnId: 'turn-1' }), { ok: true, note: 'The classifier was unsure this serves the objective: Might be for another project.' });
    reply = 'not json';
    assert.deepStrictEqual(await rt.detourGate(door.id, { source: 'plan', text: 'Call the glazier back', turnId: 'turn-1' }), { ok: true });
    await assert.rejects(rt.detourGate(door.id, { source: 'owner-message', text: 'x' }), /plan or executor/);
    await rt.endTurn(turn, { summary: 'x' });
  });
});
````


- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-detour-hooks.test.js`
Expected: FAIL — `rt.detours` is `undefined` (`Cannot read properties of undefined (reading 'propose')`), no classify call is made for the owner's message, and `rt.detourGate is not a function`.

- [ ] **Step 3: Implement**

Create `src/cases/detours/hooks.js`:

````js
// src/cases/detours/hooks.js
// The two turn hooks cases stage 5 registers with the runtime (spec §3.6,
// program §4.20, R33). Phase 1 runs inside beginTurn before triggers and
// orientation: reconcile routing answers, release held proposals, refresh
// the case type's live state and raise the case-type trigger. Phase 2 runs
// after UserPromptSubmit passes: classify the owner's message, propose a
// detour, and for software-repo check the work already in flight.
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJsonIfChanged } = require('../jsonfile');
const { resolveCaseType } = require('../case-types');
const { createLogger } = require('../../logging');

const log = createLogger('cases/detours/hooks');

const snapshotFile = (meta) => path.join(meta.dir, '.kl', 'case-type.json');
const show = (v) => (v === null || v === undefined ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v));
const shortHash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 8);
const sameState = (a, b) => JSON.stringify([a?.state || null, a?.notes || []]) === JSON.stringify([b?.state || null, b?.notes || []]);

function snapshots(runtime) {
  if (!(runtime._typeSnapshots instanceof Map)) runtime._typeSnapshots = new Map();
  return runtime._typeSnapshots;
}

// Refresh within cases.softwareRepo.refreshBudgetMs. On overrun the cached
// snapshot is used, marked stale, and the refresh finishes into memory; the
// next turn writes it under its lock.
async function refreshCaseType(runtime, meta) {
  const type = resolveCaseType(meta.type);
  if (typeof type.refresh !== 'function') return;
  const memory = snapshots(runtime);
  const pending = memory.get(meta.id);
  const disk = readJson(snapshotFile(meta), null);
  if (pending && !pending.stale && (!disk || String(pending.fetchedAt) > String(disk.fetchedAt))) {
    writeJsonIfChanged(snapshotFile(meta), pending);
  }
  const previous = runtime.caseTypeSnapshot(meta.id);
  let brief = {};
  try {
    brief = runtime.brief(meta.id).read().data || {};
  } catch {
    brief = {};
  }
  const budgetMs = runtime.settings().softwareRepo.refreshBudgetMs;
  const job = Promise.resolve()
    .then(() => type.refresh({ runtime, id: meta.id, brief, exec: runtime.host?.exec, now: runtime.now(), previous }))
    .then((snap) => ({ snap }), (err) => ({ err }));
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), budgetMs);
    timer.unref?.();
  });
  const first = await Promise.race([job, late]);
  clearTimeout(timer);
  if (first.late) {
    if (previous) memory.set(meta.id, { ...previous, stale: true });
    job.then((r) => { if (r.snap) memory.set(meta.id, r.snap); });
    return;
  }
  if (first.err) {
    log.warn(`Refreshing the ${type.type} state of ${meta.slug} failed: ${first.err.message}`);
    return;
  }
  const snap = first.snap;
  memory.set(meta.id, snap);
  // Unchanged state keeps the file (and the case's git tree) as it was.
  if (disk && !disk.stale && sameState(disk, snap)) return;
  writeJsonIfChanged(snapshotFile(meta), snap);
}

// A material field that differs from C2's baseline (.kl/triggers.json
// caseTypeMaterial). The key carries the new value, so a later change fires
// again even after this one was acknowledged.
function caseTypeTriggers(runtime, meta) {
  const material = runtime.caseTypeMaterial(meta.id);
  if (!material) return [];
  const baseline = readJson(path.join(meta.dir, '.kl', 'triggers.json'), null)?.caseTypeMaterial;
  if (!baseline || typeof baseline !== 'object') return [];
  const out = [];
  for (const [field, value] of Object.entries(material)) {
    if (value === null || value === undefined) continue;
    const old = baseline[field] ?? null;
    if (old === null || JSON.stringify(old) === JSON.stringify(value)) continue;
    out.push({
      kind: 'case-type-change',
      detail: `${field} changed: ${show(old)} → ${show(value)}`,
      blocking: true,
      key: `case-type:${field}:${shortHash(value)}`
    });
  }
  return out;
}

async function turnStart(runtime, { caseId }) {
  const meta = runtime.getCase(caseId);
  const out = await runtime.detours.reconcile(meta.id);
  if (out.busy) log.warn(`Detour reconcile skipped on ${meta.slug}: busy`);
  runtime.detours.releaseHeld(meta.id);
  await refreshCaseType(runtime, meta);
  return { triggers: caseTypeTriggers(runtime, runtime.getCase(meta.id)) };
}

function optionsText(detour) {
  const parts = detour.options
    .filter((o) => o.optionId !== 'decline')
    .map((o) => (o.optionId === 'new' ? 'new case' : o.label.replace(/^Attach to /, 'attach to ')));
  return [...parts, 'drop'].join(' / ');
}

async function ownerMessage(runtime, { caseId, ownerMessage: message, source }) {
  if (source !== 'owner' || typeof message !== 'string' || !message.trim()) return {};
  const meta = runtime.getCase(caseId);
  const turn = runtime.turns.get(meta.id) || null;
  const notes = [];
  const verdict = await runtime.classifier.classify(meta.id, { source: 'owner-message', text: message, turn });
  if (verdict.detour) {
    const reason = verdict.reason.replace(/[.\s]+$/, '');
    const proposed = await runtime.detours.propose(meta.id, {
      summary: message.slice(0, 300), reason, source: 'owner-message', turn
    });
    if (proposed.ok) {
      notes.push(`Detour check: the owner's message asks for work outside this case's objective (${reason}). Do that part in this case only if the owner insists. Routing proposal ${proposed.questionId || proposed.detour.id} (${optionsText(proposed.detour)}) is waiting. Say so in one line, then continue with the on-case part.`);
    } else {
      notes.push(`Detour check: the owner's message asks for work outside this case's objective (${reason}), and routing it failed: ${proposed.error}`);
    }
  }
  const type = resolveCaseType(meta.type);
  if (typeof type.checkBeforeWriteFor === 'function') {
    const note = type.checkBeforeWriteFor(runtime, meta.id, message);
    if (note) notes.push(note);
  }
  return { notes };
}

function registerDetourHooks(runtime) {
  runtime.addTurnStartHook('detours', (ctx) => turnStart(runtime, ctx));
  runtime.addTurnStartHook('detours:classify', (ctx) => ownerMessage(runtime, ctx), { phase: 'owner-message' });
}

module.exports = { registerDetourHooks, refreshCaseType, caseTypeTriggers };
````


In `src/cases/case-runtime.js`, replace

````js
const { assertKnownType, resolveCaseType, briefFieldsFor, gatingQuestionsFor } = require('./case-types');
````

with

````js
const { assertKnownType, resolveCaseType, briefFieldsFor, gatingQuestionsFor } = require('./case-types');
const { DetourClassifier } = require('./detours/classifier');
const { DetourRouter } = require('./detours/router');
const { registerDetourHooks } = require('./detours/hooks');
````

In `src/cases/case-runtime.js`, replace

````js
    this.turns = new Map();
    this.hooks = [];
  }
````

with

````js
    this.turns = new Map();
    this.hooks = [];
    // Cases stage 5: detour routing and the case-type refresh (spec §3.6).
    registerDetourHooks(this);
  }
````

In `src/cases/case-runtime.js`, replace

````js
  // `## Detours and related cases`. Stage 5 Part 2 adds the proposals.
  _detourLines(meta) {
    return this._relatedLines(meta);
  }
````

with

````js
  // `## Detours and related cases`: open proposals, answers waiting to be
  // mapped, incoming detours, then related cases.
  _detourLines(meta) {
    return [...this.detours.orientationLines(meta.id), ...this._relatedLines(meta)];
  }

  // ---- Detours (cases stage 5 spec §3.3–§3.5) ----

  get classifier() {
    if (!this._classifier) this._classifier = new DetourClassifier({ runtime: this });
    return this._classifier;
  }

  get detours() {
    if (!this._detours) this._detours = new DetourRouter({ runtime: this, classifier: this.classifier });
    return this._detours;
  }

  // C3 calls this once per plan and once per new job. A detour is refused
  // with the instruction to propose it; an unsure or failed classification
  // lets the work through.
  async detourGate(id, { source, serves = null, text, turnId = null } = {}) {
    if (!['plan', 'executor'].includes(source)) throw new Error(`detourGate source must be plan or executor, not "${source}".`);
    const meta = this.getCase(id);
    const turn = this.turns.get(meta.id) || { caseId: meta.id, turnId, signal: null };
    const classification = await this.classifier.classify(meta.id, { source, serves, text, turn });
    if (classification.detour) {
      let objective = '';
      try {
        objective = this.brief(meta.id).read().data?.objective || '';
      } catch {
        objective = '';
      }
      const reason = classification.reason.replace(/[.\s]+$/, '');
      return {
        ok: false,
        error: `This work looks like a detour from the case objective ("${objective || meta.title}"): ${reason}. Do not do it in this case. Call Detour with action "propose" (blocks: true if this case cannot proceed without it), then continue with on-case work.`,
        classification
      };
    }
    if (!classification.failed && classification.onCase === false) {
      return { ok: true, note: `The classifier was unsure this serves the objective: ${classification.reason.replace(/[.\s]+$/, '')}.` };
    }
    return { ok: true };
  }
````


- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-*.test.js`
Expected: PASS, `# fail 0`. Every `CaseRuntime` now runs the two hooks; runtimes without an inference router skip classification, so the stage-2 tests are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/cases/detours/hooks.js src/cases/case-runtime.js tests/cases-detour-hooks.test.js
git commit -m "feat(cases): detour turn hooks, software-repo refresh and trigger, and detourGate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The `Detour` tool, the `Ask` duplicate check and the Brief tool's type fields

**Files:**
- Create: `src/tools/builtin/detour-tool.js`
- Modify: `src/tools/builtin/case-tools.js` (`const { USER_ONLY_FIELDS } = require('../../cases/brief');`; `const BRIEF_TEXT_FIELDS = …`; the `BriefTool` description, `field` enum and `quote` description; `if (!params.field) return …`; `if (USER_ONLY_FIELDS.has(params.field) && provenance === 'user') {`)
- Modify: `src/tools/builtin/case-unattended-tools.js` (`const { recommendationGate } = require('../../cases/gates');`; `const payload = { type: 'ask', turnId: ctx.turnId };` in `AskTool`; `AskTool`'s success `return`)
- Modify: `src/cases/chat-integration.js` (`const CASE_TOOL_NAMES = …`; the last line of `CASE_MODE_PROMPT`)
- Modify: `src/tools/index.js` (anchor: `  require('./builtin/case-unattended-tools').registerCaseUnattendedTools(toolRegistry);`)
- Modify: `tests/cases-tools.test.js` (`assert.deepStrictEqual([...CASE_TOOL_NAMES], [...])`)
- Test: `tests/cases-detour-tool.test.js`; `tests/cases-leaks.test.js` (append one `describe`)

**Interfaces:**
- Consumes: `withCase` (`case-tools.js`), `runtime.detours` (Task 8), `findDuplicateQuestion`, `OPEN_CASE_STATUSES` (Part 1), `caseTypeForField`, `resolveCaseType` (Part 1), `brief.isUserOnly` (Part 1).
- Produces: tool `Detour` (`requiresApproval: false`; actions `propose` → `{ ok, detourId, questionId, status, options, existing?, held?, instruction }`, `resolve` (only for `awaiting-mapping`, `by: 'model-mapped'`) → `{ ok, detourId, status, linkedCaseId }`, `list` → `{ ok, detours, related }`; status ops `Detour.propose | Detour.resolve | Detour.list`), `registerDetourTools(registry)`; `CASE_TOOL_NAMES` ends with `'Detour'`; `Ask` refuses an exact open duplicate, returns `similar` for close ones here and names other cases by title; `Brief` accepts `field: 'repo'` only on `software-repo` cases (`Field "repo" is only for software-repo cases.`).

- [ ] **Step 1: Write the failing tests**

Create `tests/cases-detour-tool.test.js`:

````js
// tests/cases-detour-tool.test.js
// The Detour tool, the Ask duplicate check and the Brief tool's type
// fields (cases stage 5 spec §3.2, §3.5, §3.7).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseRuntime } = require('../src/cases');
const { DetourTool } = require('../src/tools/builtin/detour-tool');
const { AskTool } = require('../src/tools/builtin/case-unattended-tools');
const { BriefTool } = require('../src/tools/builtin/case-tools');
const { CASE_TOOL_NAMES, CASE_MODE_PROMPT } = require('../src/cases/chat-integration');
const { DetourLog } = require('../src/cases/detours/log');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-detour-tool-')); dirs.push(d); return d; };

async function activeCase(rt, title, objective, type = 'general') {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (type === 'software-repo') rt.brief(info.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

async function setup(ownerMessages = []) {
  const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
  const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
  const phone = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
  const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'x' });
  return { rt, door, phone, turn, opts: { caseContext: rt.caseContext(turn, { ownerMessages }) } };
}

describe('Detour tool', () => {
  it('is a case tool that needs no approval, and the case prompt tells the model to use it', async () => {
    assert.ok(CASE_TOOL_NAMES.includes('Detour'));
    assert.strictEqual(toolRegistry.get('Detour').requiresApproval, false);
    assert.match(CASE_MODE_PROMPT, /- Work that does not serve the objective is a detour: propose it with the Detour tool and continue; never do it inline\./);
    const r = await DetourTool.execute({ action: 'list' }, {});
    assert.match(r.error, /not attached to a case/);
  });

  it('propose validates its input and returns the routing proposal with an instruction', async () => {
    const { rt, door, turn, opts } = await setup();
    assert.match((await DetourTool.execute({ action: 'propose', summary: '' }, opts)).error, /"summary" must be 1 to 300 characters/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'x'.repeat(301) }, opts)).error, /"summary"/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'Fix it', reason: 'r'.repeat(201) }, opts)).error, /"reason"/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'Fix it', blocks: 'yes' }, opts)).error, /"blocks" must be true or false/);
    const r = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', reason: 'A different project', blocks: true }, opts);
    assert.deepStrictEqual([r.ok, r.detourId, r.status], [true, 'd-0001', 'proposed']);
    assert.strictEqual(rt.questions(door.id).get(r.questionId).urgency, 'high');
    assert.ok(r.options.some((o) => o.label === 'Attach to "Phone agent maintenance" (active)'));
    assert.match(r.instruction, /continue with on-case work/);
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual([row.source, row.turnId], ['detour-tool', 'turn-1']);
    const list = await DetourTool.execute({ action: 'list' }, opts);
    assert.deepStrictEqual(list.detours.map((d) => [d.id, d.blocks]), [['d-0001', true]]);
    assert.deepStrictEqual(list.related, []);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('resolve maps an answer in words only, and journals the owner\'s words in both cases', async () => {
    const { rt, door, phone, turn, opts } = await setup();
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', reason: 'A different project' }, opts);
    const early = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.match(early.error, /Detour d-0001 is proposed\. resolve is only for an owner's answer given in words\./);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: 'give it to the phone agent case' });
    await rt.detours.reconcile(door.id);
    const r = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.deepStrictEqual([r.ok, r.status, r.linkedCaseId], [true, 'attached', phone.id]);
    const words = 'Owner\'s words (mapped by the model): "give it to the phone agent case"';
    const journals = (dir) => fs.readdirSync(path.join(dir, 'journal')).map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8')).join('\n');
    assert.ok(journals(door.dir).includes(words));
    assert.ok(journals(phone.dir).includes(words));
    assert.match((await DetourTool.execute({ action: 'resolve', questionId: 'q-0099', optionId: 'attach-1' }, opts)).error, /not a routing question/);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('is refused while the case is paused, like every non-read op', async () => {
    const { rt, door, turn, opts } = await setup();
    rt.setStatus(door.id, 'paused', { kind: 'owner', by: 'owner' });
    for (const action of ['propose', 'resolve', 'list']) {
      const r = await DetourTool.execute({ action, summary: 'Fix it', questionId: 'q-0001', optionId: 'decline' }, opts);
      assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (owner). Only reading is available.' }, action);
    }
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('Ask duplicate check', () => {
  it('refuses the same open question, shows a close one here, and names another case by title only', async () => {
    const { rt, door, phone, turn, opts } = await setup();
    const first = await AskTool.execute({ question: 'Is the side gate code still 4471?' }, opts);
    assert.strictEqual(first.ok, true);
    const same = await AskTool.execute({ question: '  is the side gate code still 4471 ' }, opts);
    const asked = rt.questions(door.id).get(first.questionId).createdAt.slice(0, 10);
    assert.deepStrictEqual(same, { ok: false, error: `This question is already open as ${first.questionId} (asked ${asked}). Wait for its answer instead of asking again.` });
    const close = await AskTool.execute({ question: 'Is the side gate code still the same?' }, opts);
    assert.deepStrictEqual(close.similar, [{ questionId: first.questionId, text: 'Is the side gate code still 4471?' }]);
    rt.createQuestion(phone.id, { kind: 'question', text: 'Which phone number should the agent forward dropped calls to?', urgency: 'low' });
    const elsewhere = await AskTool.execute({ question: 'Which number should dropped calls be forwarded to?' }, opts);
    assert.strictEqual(elsewhere.ok, true);
    assert.match(elsewhere.note, /A similar question is open in case "Phone agent maintenance"\./);
    assert.ok(!JSON.stringify(elsewhere).includes('forward dropped calls to'));
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('Brief tool type fields', () => {
  it('refuses repo on a general case, needs the owner\'s quote on software-repo, and validates it', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const general = await rt.createCase({ title: 'Garage sale', objective: 'Clear the garage' });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const opts = async (id, ownerMessages) => ({ caseContext: rt.caseContext(await rt.beginTurn(id, { turnId: `turn-${id}` }), { ownerMessages }) });
    const g = await opts(general.id, []);
    assert.deepStrictEqual(await BriefTool.execute({ action: 'update', field: 'repo', value: '/work/x', provenance: 'user', quote: 'x' }, g), { ok: false, error: 'Field "repo" is only for software-repo cases.' });
    const said = 'The code lives at https://github.com/example/phone-agent.git on our account';
    const r = await opts(repo.id, [said]);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git' }, r)).error, /"repo" can only be set from something the owner said/);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'somewhere else' }, r)).error, /does not appear/);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'phone-agent', provenance: 'user', quote: 'The code lives at' }, r)).error, /repo must be an absolute path or a clone URL\./);
    const ok = await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'The code lives at https://github.com/example/phone-agent.git' }, r);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.brief.repo, 'https://github.com/example/phone-agent.git');
    const read = await BriefTool.execute({ action: 'read' }, r);
    assert.deepStrictEqual(read.missingForGating, ['why', 'successCriteria']);
    rt.releaseAll();
  });
});
````


Append to the end of `tests/cases-leaks.test.js`:

````js

describe('cross-case leak paths through Ask', () => {
  const { AskTool } = require('../src/tools/builtin/case-unattended-tools');

  it('Ask similar across cases returns title only', async () => {
    const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const site = await rt.createCase({ title: 'Website redesign', objective: 'Refresh the public website' });
    rt.createQuestion(site.id, { kind: 'question', text: 'Which hosting plan should the new booking site use, the 12 dollar one?', urgency: 'low', options: [{ id: 'a', label: 'Static hosting at 12 dollars' }] });
    const shop = await rt.createCase({ title: 'Shop opening', objective: 'Open the pop-up shop' });
    const turn = await rt.beginTurn(shop.id, { turnId: 'turn-1' });
    const out = await AskTool.execute({ question: 'Which hosting plan should the shop booking site use?' }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.match(out.note, /A similar question is open in case "Website redesign"\./);
    assert.strictEqual(out.similar, undefined);
    const blob = JSON.stringify(out);
    for (const secret of ['12 dollar', 'Static hosting', 'new booking site']) assert.ok(!blob.includes(secret), secret);
    await rt.endTurn(turn, { summary: 'x' });
  });
});
````


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/cases-detour-tool.test.js tests/cases-leaks.test.js`
Expected: FAIL with `Cannot find module '../src/tools/builtin/detour-tool'`; the leak test "Ask similar across cases returns title only" fails (no note).

- [ ] **Step 3: Implement**

Create `src/tools/builtin/detour-tool.js`:

````js
// src/tools/builtin/detour-tool.js
// The Detour case tool (cases stage 5 spec §3.5): propose routing for work
// that does not serve the case's objective, map an owner's answer given in
// words to a routing option, or list the case's detours and related cases.
const { Tool } = require('../tool-schema');
const { withCase } = require('./case-tools');

const ACTIONS = Object.freeze(['propose', 'resolve', 'list']);

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function checkPropose(params) {
  const summary = text(params.summary);
  if (summary.length < 1 || summary.length > 300) return '"summary" must be 1 to 300 characters: the off-objective work in one sentence.';
  if (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.length > 200)) return '"reason" must be text of at most 200 characters.';
  if (params.serves !== undefined && (typeof params.serves !== 'string' || params.serves.length > 200)) return '"serves" must be text of at most 200 characters.';
  if (params.blocks !== undefined && typeof params.blocks !== 'boolean') return '"blocks" must be true or false.';
  return null;
}

const DetourTool = new Tool({
  name: 'Detour',
  description: 'Route work that does not serve this case\'s objective instead of doing it here. propose: describe the off-objective work ("summary"), why it is off-objective ("reason"), and "blocks": true if this case cannot proceed without it; the owner then picks an existing case, a new case, or dropping it. resolve: only when the owner answered a routing question in words (the orientation says so); give that questionId and the optionId that matches their words. list: this case\'s detours and related cases.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      summary: { type: 'string', description: 'For propose: the off-objective work in one sentence (1 to 300 characters)' },
      reason: { type: 'string', description: 'For propose: why it does not serve the objective (at most 200 characters)' },
      blocks: { type: 'boolean', description: 'For propose: true if this case cannot proceed without it' },
      serves: { type: 'string', description: 'For propose: what the work would serve (at most 200 characters)' },
      questionId: { type: 'string', description: 'For resolve: the routing question the owner answered in words' },
      optionId: { type: 'string', description: 'For resolve: the option that matches the owner\'s words' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => `Detour.${p.action}`, async (ctx) => {
    const router = ctx.runtime.detours;
    switch (params.action) {
      case 'propose': {
        const bad = checkPropose(params);
        if (bad) return { ok: false, error: bad };
        const r = await router.propose(ctx.caseId, {
          summary: text(params.summary),
          reason: text(params.reason),
          serves: text(params.serves) || null,
          blocks: params.blocks === true,
          source: 'detour-tool',
          turn: ctx.runtime.turns.get(ctx.caseId) || null
        });
        if (!r.ok) return r;
        return {
          ok: true,
          detourId: r.detour.id,
          questionId: r.questionId,
          status: r.detour.status,
          options: r.detour.options,
          ...(r.existing ? { existing: true } : {}),
          ...(r.held ? { held: true } : {}),
          instruction: 'Tell the owner in one line that the side request is noted and a routing proposal is waiting, then continue with on-case work. Do not do the detour in this case.'
        };
      }
      case 'resolve': {
        if (!text(params.questionId) || !text(params.optionId)) return { ok: false, error: 'resolve needs "questionId" and "optionId".' };
        const detour = router.list(ctx.caseId).detours.find((d) => d.questionId === text(params.questionId));
        if (!detour) return { ok: false, error: `${params.questionId} is not a routing question in this case.` };
        if (detour.status !== 'awaiting-mapping') {
          return { ok: false, error: `Detour ${detour.id} is ${detour.status}. resolve is only for an owner's answer given in words.` };
        }
        const r = await router.resolve(ctx.caseId, detour.id, { optionId: text(params.optionId), by: 'model-mapped' });
        if (!r.ok) return r;
        return { ok: true, detourId: detour.id, status: r.detour.status, linkedCaseId: r.linkedCaseId };
      }
      case 'list':
        return { ok: true, ...router.list(ctx.caseId) };
      default:
        return { ok: false, error: `Unknown action: ${params.action}. Actions: ${ACTIONS.join(', ')}.` };
    }
  }, { params })
});

function registerDetourTools(registry) {
  registry.register(DetourTool);
}

module.exports = { DetourTool, registerDetourTools };
````


In `src/tools/builtin/case-tools.js`, replace

````js
const { USER_ONLY_FIELDS } = require('../../cases/brief');
````

with

````js
const { caseTypeForField, resolveCaseType } = require('../../cases/case-types');
````

In `src/tools/builtin/case-tools.js`, replace

````js
const BRIEF_TEXT_FIELDS = new Set(['objective', 'why', 'deadline']);
````

with

````js
const BRIEF_TEXT_FIELDS = new Set(['objective', 'why', 'deadline', 'repo']);
````

In `src/tools/builtin/case-tools.js`, replace

````js
  description: 'Read or update the case brief. "why", "hardConstraints", "alreadyTried", "materiality", "deadline" and "safeDefaults" can only be set from what the owner said (provenance "user"), which also requires a "quote" of the owner\'s own words matching this chat\'s owner messages. completeGating marks the brief ready; recommendations are refused until then.',
````

with

````js
  description: 'Read or update the case brief. "why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults" and a software-repo case\'s "repo" can only be set from what the owner said (provenance "user"), which also requires a "quote" of the owner\'s own words matching this chat\'s owner messages. completeGating marks the brief ready; recommendations are refused until then.',
````

In `src/tools/builtin/case-tools.js`, replace

````js
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality', 'safeDefaults'] },
````

with

````js
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality', 'safeDefaults', 'repo'] },
````

In `src/tools/builtin/case-tools.js`, replace

````js
      quote: { type: 'string', description: 'Required for the owner-only fields ("why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults") with provenance "user": a substring of something the owner actually said in this chat.' },
````

with

````js
      quote: { type: 'string', description: 'Required for the owner-only fields ("why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults", "repo") with provenance "user": a substring of something the owner actually said in this chat.' },
````

In `src/tools/builtin/case-tools.js`, replace

````js
    if (!params.field) return { ok: false, error: `${params.action} needs "field".` };
````

with

````js
    if (!params.field) return { ok: false, error: `${params.action} needs "field".` };
    const declaredBy = caseTypeForField(params.field);
    if (declaredBy && declaredBy !== resolveCaseType(ctx.runtime.getCase(ctx.caseId).type).type) {
      return { ok: false, error: `Field "${params.field}" is only for ${declaredBy} cases.` };
    }
````

In `src/tools/builtin/case-tools.js`, replace

````js
    if (USER_ONLY_FIELDS.has(params.field) && provenance === 'user') {
````

with

````js
    if (brief.isUserOnly(params.field) && provenance === 'user') {
````

In `src/tools/builtin/case-unattended-tools.js`, replace

````js
const { recommendationGate } = require('../../cases/gates');
````

with

````js
const { recommendationGate, findDuplicateQuestion, OPEN_CASE_STATUSES } = require('../../cases/gates');
````

In `src/tools/builtin/case-unattended-tools.js`, replace

````js
    const payload = { type: 'ask', turnId: ctx.turnId };
````

with

````js
    // Duplicates (cases stage 5 spec §3.2): the same open question here is
    // refused; a close one here is shown; one open in another case is named
    // by that case's title only.
    const dup = findDuplicateQuestion({
      text: params.question,
      openQuestions: ctx.runtime.questions(ctx.caseId).open(),
      crossCaseHits: ctx.runtime.index.search({
        text: params.question, kinds: ['question'], forCaseId: ctx.caseId, excludeCaseId: ctx.caseId, statuses: OPEN_CASE_STATUSES
      })
    });
    if (dup.exact) {
      return { ok: false, error: `This question is already open as ${dup.exact.id} (asked ${String(dup.exact.createdAt).slice(0, 10)}). Wait for its answer instead of asking again.` };
    }
    for (const title of [...new Set(dup.elsewhere.map((e) => e.caseTitle))]) notes.push(`A similar question is open in case "${title}".`);
    const payload = { type: 'ask', turnId: ctx.turnId };
````

In `src/tools/builtin/case-unattended-tools.js`, replace

````js
    return {
      ok: true,
      questionId: created.id,
      urgency: created.urgency,
      delivered: Array.isArray(created.deliveries) && created.deliveries.length > 0,
      note: notes.join(' ')
    };
````

with

````js
    return {
      ok: true,
      questionId: created.id,
      urgency: created.urgency,
      delivered: Array.isArray(created.deliveries) && created.deliveries.length > 0,
      ...(dup.similar.length ? { similar: dup.similar } : {}),
      note: notes.join(' ')
    };
````

In `src/cases/chat-integration.js`, replace

````js
const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']);
````

with

````js
const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail', 'Detour']);
````

In `src/cases/chat-integration.js`, replace

````js
  '- Never edit facts.jsonl, brief.md, case.yaml or anything under .kl/ directly. The case tools are the only write path.'
].join('\n');
````

with

````js
  '- Never edit facts.jsonl, brief.md, case.yaml or anything under .kl/ directly. The case tools are the only write path.',
  '- Work that does not serve the objective is a detour: propose it with the Detour tool and continue; never do it inline.'
].join('\n');
````

In `src/tools/index.js`, replace

````js
  require('./builtin/case-unattended-tools').registerCaseUnattendedTools(toolRegistry);
````

with

````js
  require('./builtin/case-unattended-tools').registerCaseUnattendedTools(toolRegistry);
  require('./builtin/detour-tool').registerDetourTools(toolRegistry);
````

In `tests/cases-tools.test.js`, replace

````js
    assert.deepStrictEqual([...CASE_TOOL_NAMES], ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail']);
````

with

````js
    assert.deepStrictEqual([...CASE_TOOL_NAMES], ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail', 'Detour']);
````


- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-*.test.js tests/tool-schema-shape.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/builtin/detour-tool.js src/tools/builtin/case-tools.js src/tools/builtin/case-unattended-tools.js src/cases/chat-integration.js src/tools/index.js tests/cases-detour-tool.test.js tests/cases-leaks.test.js tests/cases-tools.test.js
git commit -m "feat(cases): Detour tool, Ask duplicate check, and repo in the Brief tool

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: IPC and the preload bridge

**Files:**
- Create: `src/ipc/detour-handlers.js`
- Modify: `src/ipc/constants.js` (anchor: `  CASE_GRANT_BUDGET: 'case:grantBudget',`)
- Modify: `src/ipc/register.js` (anchor: `  require('./case-unattended-handlers').registerCaseUnattendedHandlers(ipcMain, context);`)
- Modify: `src/ipc/case-handlers.js` (the `IPC.CASE_CREATE` handler)
- Modify: `preload.js` (`cases.create`; `onChanged: (callback) => registerOnce('case:changed', callback)` in `cases`)
- Test: `tests/cases-detour-ipc.test.js`

**Interfaces:**
- Consumes: `runtime.detours` (`reconcile`, `list`, `resolve`), `runtime.answerQuestion`, `runtime.questions(id).get`, `runtime.index.rebuild()`, `runtime.createCase({ …, force })`, `wrapHandler`.
- Produces: IPC `case:detours { caseId } → { ok, detours, related, busy? }` (reconciles first), `case:resolveDetour { caseId, detourId, optionId, title?, objective?, force? } → { ok, detour, linkedCaseId, existing? } | { ok: false, error, retryQuestionId? }` (answers the routing question in-app when still open, resolves, reconciles), `case:reindex {} → { ok, cases, docs, ms }`; `case:create` accepts `force` and returns `{ ok: false, error, code: 'SIMILAR_CASES', similar }` or `{ ok: false, error, code: 'UNKNOWN_CASE_TYPE' }`; constants `CASE_DETOURS`, `CASE_RESOLVE_DETOUR`, `CASE_REINDEX`; `registerDetourHandlers(ipcMain, context)`; preload `window.electron.cases.detours`, `.resolveDetour`, `.reindex`, and `.create` validating `force`.

- [ ] **Step 1: Write the failing test**

Create `tests/cases-detour-ipc.test.js`:

````js
// tests/cases-detour-ipc.test.js
// Cases stage 5 IPC (spec §7): case:detours, case:resolveDetour,
// case:reindex, and case:create's similar-case refusal and force.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerDetourHandlers } = require('../src/ipc/detour-handlers');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-detour-ipc-'));
  dirs.push(root);
  const runtime = new CaseRuntime({ root, host: { interactive: () => true } });
  let chats = [{ id: 'chat-1', title: 'Chat', messages: [] }];
  const context = { getCaseRuntime: () => runtime, getChats: () => chats, setChats: (next) => { chats = next; } };
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  registerCaseHandlers(ipcMain, context);
  registerDetourHandlers(ipcMain, context);
  return { runtime, handlers, call: (channel, payload) => handlers.get(channel)({}, payload) };
}

async function activeCase(runtime, title, objective) {
  const info = await runtime.createCase({ title, objective, force: true });
  runtime.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  runtime.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  runtime.completeGating(info.id);
  return runtime.getCase(info.id);
}

const lockElsewhere = (dir) => fs.writeFileSync(path.join(dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));

describe('detour IPC', () => {
  it('registers the three channels', () => {
    const { handlers } = setup();
    assert.deepStrictEqual([IPC.CASE_DETOURS, IPC.CASE_RESOLVE_DETOUR, IPC.CASE_REINDEX], ['case:detours', 'case:resolveDetour', 'case:reindex']);
    for (const ch of [IPC.CASE_DETOURS, IPC.CASE_RESOLVE_DETOUR, IPC.CASE_REINDEX]) assert.ok(handlers.has(ch), ch);
  });

  it('case:resolveDetour answers the routing question in-app, resolves, and is idempotent', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const phone = await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    const listed = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual(listed.detours.map((d) => [d.id, d.status]), [['d-0001', 'proposed']]);
    const r = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, phone.id, 'attached']);
    const q = runtime.questions(door.id).get(p.questionId);
    assert.deepStrictEqual([q.answer.channel, q.answer.optionId], ['in-app', 'attach-1']);
    const again = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.deepStrictEqual([again.ok, again.existing], [true, true]);
    const after = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual(after.related, [{ caseId: phone.id, title: 'Phone agent maintenance', status: 'active', relation: 'related', detour: 'd-0001' }]);
  });

  it('case:resolveDetour validates input and reports a retry question when the target closed', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const phone = await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    assert.deepStrictEqual(await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'new', force: 'yes' }), { ok: false, error: 'force must be true or false.' });
    assert.deepStrictEqual(await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0404', optionId: 'decline' }), { ok: false, error: 'There is no detour d-0404 in this case.' });
    runtime.setStatus(phone.id, 'done', { kind: 'owner', by: 'owner' });
    const r = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Case "Phone agent maintenance" is done; pick another option.');
    assert.match(r.retryQuestionId, /^q-\d{4}$/);
  });

  it('case:detours returns busy without reconciling while another process holds the case', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    await runtime.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    lockElsewhere(door.dir);
    const r = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual([r.ok, r.busy, r.detours[0].status], [true, true, 'proposed']);
    fs.rmSync(path.join(door.dir, '.kl', 'lock'));
    const next = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual([next.busy, next.detours[0].status], [undefined, 'attached']);
  });

  it('case:reindex rebuilds the index', async () => {
    const { runtime, call } = setup();
    await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const r = await call(IPC.CASE_REINDEX, {});
    assert.deepStrictEqual([r.ok, r.cases], [true, 1]);
    assert.ok(r.docs >= 3 && Number.isFinite(r.ms));
    assert.ok(fs.existsSync(path.join(runtime.root, '.index', 'meta.json')));
  });

  it('case:create returns SIMILAR_CASES with the matches, and creates with force', async () => {
    const { call } = setup();
    const first = await call(IPC.CASE_CREATE, { title: 'Website redesign', objective: 'Refresh the public website' });
    const similar = await call(IPC.CASE_CREATE, { title: 'Redesign the website' });
    assert.deepStrictEqual([similar.ok, similar.code], [false, 'SIMILAR_CASES']);
    assert.deepStrictEqual(similar.similar, [{ caseId: first.case.id, title: 'Website redesign', status: 'draft', match: 'similar' }]);
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'Redesign the website', force: 'true' })).error, 'force must be true or false.');
    const forced = await call(IPC.CASE_CREATE, { title: 'Redesign the website', force: true });
    assert.strictEqual(forced.ok, true);
    const unknown = await call(IPC.CASE_CREATE, { title: 'Mystery', type: 'land-sale' });
    assert.deepStrictEqual([unknown.ok, unknown.code], [false, 'UNKNOWN_CASE_TYPE']);
  });
});
````


- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-detour-ipc.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/detour-handlers'`.

- [ ] **Step 3: Implement**

Create `src/ipc/detour-handlers.js`:

````js
// src/ipc/detour-handlers.js
// Cases stage 5 IPC (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §7):
// the case panel's detours and related cases, the owner's routing choice,
// and a rebuild of the cross-case index. Case-file writes go through
// CaseRuntime.answerQuestion and the router, which take the case locks.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required.`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  return value.trim() || null;
}

function registerDetourHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { ok: false, error: err.message, code: 'CASE_BUSY' };
      if (err && err.name === 'QuestionError') return { ok: false, error: err.message, code: err.code };
      throw err;
    }
  }));

  // Reconciles answered routing questions first; `busy` when another
  // process holds the case (the list is still returned).
  handle(IPC.CASE_DETOURS, async ({ caseId }) => {
    const rt = runtime();
    const id = rt.getCase(required(caseId, 'caseId')).id;
    const reconciled = await rt.detours.reconcile(id);
    return { ok: true, ...rt.detours.list(id), ...(reconciled.busy ? { busy: true } : {}) };
  });

  // The owner's pick in the panel: answers the routing question in-app if
  // it is still open, then resolves, then reconciles.
  handle(IPC.CASE_RESOLVE_DETOUR, async ({ caseId, detourId, optionId, title, objective, force }) => {
    const rt = runtime();
    const id = rt.getCase(required(caseId, 'caseId')).id;
    required(detourId, 'detourId');
    required(optionId, 'optionId');
    if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be true or false.' };
    const newTitle = optionalText(title, 'title');
    const newObjective = optionalText(objective, 'objective');
    const view = rt.detours.list(id).detours.find((d) => d.id === detourId);
    if (!view) return { ok: false, error: `There is no detour ${detourId} in this case.` };
    if (view.questionId) {
      const q = rt.questions(id).get(view.questionId);
      if (q && !q.answer && !q.closed) await rt.answerQuestion(id, view.questionId, { channel: 'in-app', optionId });
    }
    const r = await rt.detours.resolve(id, detourId, { optionId, by: 'in-app', title: newTitle, objective: newObjective, force: force === true });
    await rt.detours.reconcile(id);
    if (!r.ok) return { ok: false, error: r.error, ...(r.retry?.questionId ? { retryQuestionId: r.retry.questionId } : {}) };
    return { ok: true, detour: r.detour, linkedCaseId: r.linkedCaseId, ...(r.existing ? { existing: true } : {}) };
  });

  handle(IPC.CASE_REINDEX, async () => ({ ok: true, ...runtime().index.rebuild() }));
}

module.exports = { registerDetourHandlers };
````


In `src/ipc/constants.js`, replace

````js
  CASE_GRANT_BUDGET: 'case:grantBudget',
````

with

````js
  CASE_GRANT_BUDGET: 'case:grantBudget',
  CASE_DETOURS: 'case:detours',
  CASE_RESOLVE_DETOUR: 'case:resolveDetour',
  CASE_REINDEX: 'case:reindex',
````

In `src/ipc/register.js`, replace

````js
  require('./case-unattended-handlers').registerCaseUnattendedHandlers(ipcMain, context);
````

with

````js
  require('./case-unattended-handlers').registerCaseUnattendedHandlers(ipcMain, context);
  require('./detour-handlers').registerDetourHandlers(ipcMain, context);
````

In `src/ipc/case-handlers.js`, replace

````js
  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (_event, { title, type, objective, chatId } = {}) => {
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    if (type !== undefined && (typeof type !== 'string' || !type.trim())) return { ok: false, error: 'type must be a non-empty string.' };
    if (objective !== undefined && (typeof objective !== 'string' || !objective.trim())) return { ok: false, error: 'objective must be a non-empty string.' };
    if (chatId && !context.getChats().some((c) => c.id === chatId)) return { ok: false, error: 'Chat not found.' };
    const info = await runtime().createCase({ title: title.trim(), type: type || 'general', objective: objective || '' });
    return { ok: true, case: summarize(info), chat: chatId ? attach(chatId, info.id) : null };
  }));
````

with

````js
  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (_event, { title, type, objective, chatId, force } = {}) => {
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    if (type !== undefined && (typeof type !== 'string' || !type.trim())) return { ok: false, error: 'type must be a non-empty string.' };
    if (objective !== undefined && (typeof objective !== 'string' || !objective.trim())) return { ok: false, error: 'objective must be a non-empty string.' };
    if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be true or false.' };
    if (chatId && !context.getChats().some((c) => c.id === chatId)) return { ok: false, error: 'Chat not found.' };
    let info;
    try {
      info = await runtime().createCase({ title: title.trim(), type: type || 'general', objective: objective || '', force: force === true });
    } catch (err) {
      // Cases stage 5: a similar open case needs the owner's confirmation (force).
      if (err && err.code === 'SIMILAR_CASES') return { ok: false, error: err.message, code: 'SIMILAR_CASES', similar: err.similar };
      if (err && err.code === 'UNKNOWN_CASE_TYPE') return { ok: false, error: err.message, code: err.code };
      throw err;
    }
    return { ok: true, case: summarize(info), chat: chatId ? attach(chatId, info.id) : null };
  }));
````

In `preload.js`, replace

````js
      create: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.title, 'title', { minLength: 1 });
        return ipcRenderer.invoke('case:create', payload);
      },
````

with

````js
      create: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.title, 'title', { minLength: 1 });
        if (payload.force !== undefined && typeof payload.force !== 'boolean') throw new Error('Invalid force: expected boolean');
        return ipcRenderer.invoke('case:create', payload);
      },
````

In `preload.js`, replace

````js
      onChanged: (callback) => registerOnce('case:changed', callback)
    },
````

with

````js
      detours: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        return ipcRenderer.invoke('case:detours', payload);
      },
      resolveDetour: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.detourId, 'detourId', { minLength: 1 });
        validateString(payload.optionId, 'optionId', { minLength: 1 });
        if (payload.title !== undefined) validateString(payload.title, 'title');
        if (payload.objective !== undefined) validateString(payload.objective, 'objective');
        if (payload.force !== undefined && typeof payload.force !== 'boolean') throw new Error('Invalid force: expected boolean');
        return ipcRenderer.invoke('case:resolveDetour', payload);
      },
      reindex: () => ipcRenderer.invoke('case:reindex', {}),
      onChanged: (callback) => registerOnce('case:changed', callback)
    },
````


- [ ] **Step 4: Run the tests**

Run: `node --test tests/cases-detour-ipc.test.js tests/cases-ipc.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/detour-handlers.js src/ipc/constants.js src/ipc/register.js src/ipc/case-handlers.js preload.js tests/cases-detour-ipc.test.js
git commit -m "feat(cases): IPC for detours, routing choices and reindex; case:create force

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Case panel: detours, related cases and the similar-case confirm

**Files:**
- Modify: `renderer.js` (in `renderChatCaseSection`: `  refreshCaseQuestionsBar();` followed by `  const adopt = async (updatedChat) => {`, and the `createBtn` click handler's `window.electron.cases.create` call; C2's `window.electron.cases.onChanged` callback, then a new block after it)
- Modify: `styles.css` (anchor: `.case-questions-bar[hidden] { display: none; }`)
- Test: `tests/e2e/cases.test.js` (one new `it` at the end of the existing `describe`; the first test ignores `.index`)

**Interfaces:**
- Consumes: preload `cases.detours`, `cases.resolveDetour`, `cases.create({ force })`, `cases.attach` (Task 10); C2's `caseButton`, `refreshCaseQuestionsBar`, `getActiveChat`, `showConfirmDialog`, `chatLog`.
- Produces: `renderCaseDetoursSection(chat, container)`, `renderCaseDetourCard`, `relatedCaseLine`; DOM ids `#case-detours-section`, `#case-detour-<detourId>` (card, class `case-detour`, `case-detour-blocker` when it blocks), `#case-detour-<detourId>-<optionId>` (buttons), `#case-related-list`. All text is set with `textContent`; `index.html` is not edited.

- [ ] **Step 1: Write the failing test**

In `tests/e2e/cases.test.js`, replace

````js
    const slugs = fs.readdirSync(casesRoot);
    assert.deepStrictEqual(slugs, ['e2e-lakeside-lot']);
````

with

````js
    // The cross-case index lives in <casesRoot>/.index (cases stage 5).
    const slugs = fs.readdirSync(casesRoot).filter((n) => !n.startsWith('.'));
    assert.deepStrictEqual(slugs, ['e2e-lakeside-lot']);
````

In `tests/e2e/cases.test.js`, replace

````js
    assert.match(fact.stmt, /Yes, with the north lot/);
    await waitFor(ctx, `!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
  });
});
````

with

````js
    assert.match(fact.stmt, /Yes, with the north lot/);
    await waitFor(ctx, `!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
  });

  it('shows a seeded detour in the case panel, and "Drop it" resolves it', async () => {
    // The chat is attached to "E2E question case" by the test above. Seed a
    // second case and a routing proposal from this process, as a turn would.
    const { CaseRuntime } = require('../../src/cases');
    const { DetourLog } = require('../../src/cases/detours/log');
    const rt = new CaseRuntime({ root: casesRoot });
    const attached = rt.getCase('e2e-question-case');
    await rt.createCase({ title: 'E2E phone agent maintenance', objective: 'Keep the phone agent answering calls', force: true });
    const proposed = await rt.detours.propose(attached.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    assert.strictEqual(proposed.ok, true);

    // Close and reopen Chat Info so the panel renders again.
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('case-detour-d-0001')`);
    const shown = await evaluate(ctx, `document.querySelector('#case-detour-d-0001 .case-detour-text').textContent`);
    assert.strictEqual(shown, 'Fix the phone agent status polling — A different project');
    const labels = await evaluate(ctx, `[...document.querySelectorAll('#case-detour-d-0001 .case-detour-actions button')].map((b) => b.textContent)`);
    assert.ok(labels.includes('Attach to "E2E phone agent maintenance" (draft)'));
    assert.ok(labels.includes('Drop it'));

    await evaluate(ctx, `document.getElementById('case-detour-d-0001-decline').click(); true`);
    await waitFor(ctx, `!document.getElementById('case-detour-d-0001')`);
    const resolution = new DetourLog(attached.dir).rows().find((r) => r.type === 'resolution' && r.id === 'd-0001');
    assert.deepStrictEqual([resolution.status, resolution.by, resolution.optionId], ['declined', 'in-app', 'decline']);
  });
});
````


- [ ] **Step 2: Run it to verify it fails**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: FAIL — the new test times out in `waitFor` on `#case-detour-d-0001`.

- [ ] **Step 3: Implement**

In `renderer.js`, replace

````js
  refreshCaseQuestionsBar();

  const adopt = async (updatedChat) => {
````

with

````js
  refreshCaseQuestionsBar();

  // Cases stage 5: detour proposals and related cases.
  const detours = document.createElement('div');
  detours.id = 'case-detours-section';
  detours.className = 'case-detours-section';
  container.appendChild(detours);
  if (chat.caseId && !caseMissing) {
    renderCaseDetoursSection(chat, detours).catch((err) => chatLog.warn(`Detours panel failed: ${err.message}`));
  }

  const adopt = async (updatedChat) => {
````

In `renderer.js`, replace

````js
    const result = await window.electron.cases.create({ title, chatId: chat.id });
    if (!result?.ok) { showError(result?.error || 'Could not create the case.'); return; }
    await adopt(result.chat);
````

with

````js
    let result = await window.electron.cases.create({ title, chatId: chat.id });
    // Cases stage 5: a similar open case exists; create anyway, or attach to it.
    if (!result?.ok && result?.code === 'SIMILAR_CASES' && Array.isArray(result.similar) && result.similar.length) {
      const match = result.similar[0];
      if (await showConfirmDialog(`A similar case exists: "${match.title}" (${match.status}). Create anyway?`)) {
        result = await window.electron.cases.create({ title, chatId: chat.id, force: true });
      } else {
        result = await window.electron.cases.attach({ chatId: chat.id, caseId: match.caseId });
      }
    }
    if (!result?.ok) { showError(result?.error || 'Could not create the case.'); return; }
    await adopt(result.chat);
````

In `renderer.js`, replace

````js
    const slot = document.getElementById('case-unattended-section');
    if (slot) renderCaseUnattendedSection(chat, slot, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
  });
}
````

with

````js
    const slot = document.getElementById('case-unattended-section');
    if (slot) renderCaseUnattendedSection(chat, slot, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
    const detourSlot = document.getElementById('case-detours-section');
    if (detourSlot) renderCaseDetoursSection(chat, detourSlot).catch((err) => chatLog.warn(`Detours panel failed: ${err.message}`));
  });
}

/* --- Cases stage 5: detours and related cases (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §7) --- */

const CASE_DETOUR_OPEN = ['proposed', 'held', 'awaiting-mapping'];

function renderCaseDetourCard(chat, d, { refresh, showError }) {
  const card = document.createElement('div');
  card.id = `case-detour-${d.id}`;
  card.className = `case-detour${d.blocks ? ' case-detour-blocker' : ''}`;
  card.dataset.detourId = d.id;
  const text = document.createElement('div');
  text.className = 'case-detour-text';
  text.textContent = `${d.blocks ? 'Blocker: ' : ''}${d.summary}${d.reason ? ` — ${d.reason}` : ''}`;
  card.appendChild(text);
  if (d.status !== 'proposed') {
    const state = document.createElement('div');
    state.className = 'case-detour-state';
    state.textContent = d.status === 'held'
      ? "Waiting: today's question allowance is spent."
      : 'You answered in words; the case maps it to an option on its next turn. You can also pick one here.';
    card.appendChild(state);
  }
  const actions = document.createElement('div');
  actions.className = 'case-detour-actions';
  for (const o of d.options) {
    const button = caseButton(o.label, o.optionId === 'decline' ? 'secondary-button case-detour-drop' : 'secondary-button');
    button.id = `case-detour-${d.id}-${o.optionId}`;
    button.addEventListener('click', async () => {
      showError('');
      const payload = { caseId: chat.caseId, detourId: d.id, optionId: o.optionId };
      let result = await window.electron.cases.resolveDetour(payload);
      if (!result?.ok && o.optionId === 'new' && /similar case exists/i.test(result?.error || '')
        && await showConfirmDialog(`${result.error} Create the new case anyway?`)) {
        result = await window.electron.cases.resolveDetour({ ...payload, force: true });
      }
      if (!result?.ok) showError(result?.error || 'Could not route the detour.');
      await refresh();
    });
    actions.appendChild(button);
  }
  card.appendChild(actions);
  return card;
}

function relatedCaseLine(r) {
  const li = document.createElement('li');
  li.className = 'case-related-item';
  if (r.gone) {
    li.textContent = `${r.relation}: (case ${r.caseId} no longer exists)`;
  } else {
    const stillBlocks = r.relation === 'blocked-by' && r.status === 'done' ? ' (done — check whether it still blocks)' : '';
    li.textContent = `${r.relation}: ${r.title} (${r.status})${stillBlocks}`;
  }
  return li;
}

async function renderCaseDetoursSection(chat, container) {
  const error = document.createElement('div');
  error.className = 'chat-case-error';
  const showError = (message) => { error.textContent = message || ''; };
  const refresh = async () => {
    await renderCaseDetoursSection(chat, container);
    refreshCaseQuestionsBar();
  };
  const result = await window.electron.cases.detours({ caseId: chat.caseId });
  container.innerHTML = '';
  if (!result?.ok) {
    showError(`Could not load detours: ${result?.error || 'unknown error'}`);
    container.appendChild(error);
    return;
  }
  const open = result.detours.filter((d) => CASE_DETOUR_OPEN.includes(d.status));
  if (!open.length && !result.related.length) return;
  const heading = document.createElement('div');
  heading.className = 'case-detours-heading';
  heading.textContent = 'Detours and related cases';
  container.appendChild(heading);
  if (result.busy) {
    const busy = document.createElement('div');
    busy.className = 'case-detour-state';
    busy.textContent = 'The case is busy with a turn; routing answers are applied when it finishes.';
    container.appendChild(busy);
  }
  for (const d of open) container.appendChild(renderCaseDetourCard(chat, d, { refresh, showError }));
  if (result.related.length) {
    const list = document.createElement('ul');
    list.id = 'case-related-list';
    list.className = 'case-related-list';
    for (const r of result.related) list.appendChild(relatedCaseLine(r));
    container.appendChild(list);
  }
  container.appendChild(error);
}
````

In `styles.css`, replace

````css
.case-questions-bar[hidden] { display: none; }
````

with

````css
.case-questions-bar[hidden] { display: none; }

/* Cases stage 5: detours and related cases */
.case-detours-section { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.case-detours-heading { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.case-detour { border: 1px solid var(--border-default); border-radius: 6px; padding: 8px; background: var(--bg-secondary); }
.case-detour-blocker { border-color: var(--accent); }
.case-detour-text { white-space: pre-wrap; margin-bottom: 6px; }
.case-detour-state { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.case-detour-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.case-related-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); }
````


- [ ] **Step 4: Run the tests**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`.

Run: `node --test tests/ipc-contract.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add renderer.js styles.css tests/e2e/cases.test.js
git commit -m "feat(cases): detours and related cases in the case panel; confirm before creating a similar case

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Regression scenarios F4-detour and F5-cross-case, the CLAUDE.md section, and verification

**Files:**
- Modify: `tests/cases-regressions.test.js` (the F5 test's `assert.match(r.note, /Check them before asking the owner/);`; append two `describe`s)
- Modify: `CLAUDE.md` (append one section)

**Interfaces:**
- Consumes: everything above.
- Produces: no new code.

- [ ] **Step 1: Write the scenarios**

In `tests/cases-regressions.test.js`, replace

````js
    assert.deepStrictEqual(r.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    assert.match(r.note, /Check them before asking the owner/);
````

with

````js
    assert.deepStrictEqual(r.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    assert.match(r.note, /Check them before asking the owner/);
    // Cases stage 5: the hit comes from the index, which redacts the financial fact.
    assert.strictEqual(r.similarInOtherCases[0].stmt, '(private fact in "Household inventory" — open that case to see it)');
    assert.ok(!JSON.stringify(r).includes('good through the 7th'));
````


Append to the end of `tests/cases-regressions.test.js`:

````js

// Cases stage 5 (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §10).
describe('F4-detour: off-objective work is routed, not done inline', () => {
  const { execFileSync } = require('child_process');
  const { DetourTool } = require('../src/tools/builtin/detour-tool');
  const { registerDetourHandlers } = require('../src/ipc/detour-handlers');
  const IPC = require('../src/ipc/constants');
  const { DetourLog } = require('../src/cases/detours/log');
  const MOCK = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes"}';

  it('refuses the patch, proposes the phone agent case, links both cases, and leaves the repository alone', async () => {
    const repo = tmp();
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'status.js'), 'module.exports = { poll: () => "completed" };\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const headBefore = git('rev-parse', 'HEAD');

    const runtime = new CaseRuntime({
      root: tmp(),
      host: { inferenceRouter: { routeWithFallback: async () => MOCK }, interactive: () => true }
    });
    const door = await runtime.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    runtime.brief(door.id).update('why', 'Rain gets in under the door', { provenance: 'user' });
    runtime.brief(door.id).append('successCriteria', 'Three written quotes', { provenance: 'model' });
    runtime.completeGating(door.id);
    const phone = await runtime.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent reporting call status correctly' });
    runtime.brief(phone.id).update('why', 'Dropped calls show as completed', { provenance: 'user' });
    runtime.brief(phone.id).append('successCriteria', 'Status polling reports dropped calls', { provenance: 'model' });
    runtime.brief(phone.id).update('repo', repo, { provenance: 'user' });
    runtime.completeGating(phone.id);
    const phoneTurn = await runtime.beginTurn(phone.id, { turnId: 'wakeup-1', source: 'wakeup' });
    await runtime.endTurn(phoneTurn, { summary: 'looked at the repository' });

    const turn = await runtime.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Also fix the phone agent status polling that drops calls' });
    const gate = await runtime.detourGate(door.id, { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turnId: 'turn-1' });
    assert.strictEqual(gate.ok, false);
    assert.match(gate.error, /^This work looks like a detour from the case objective \("Three written quotes for the rear door"\): Fixing the phone agent's code does not collect quotes\. Do not do it in this case\. Call Detour with action "propose"/);

    const opts = { caseContext: runtime.caseContext(turn, { ownerMessages: ['Also fix the phone agent status polling that drops calls'] }) };
    const proposed = await DetourTool.execute({ action: 'propose', summary: 'Patch status polling in the phone agent', reason: "Fixing the phone agent's code does not collect quotes" }, opts);
    assert.strictEqual(proposed.options[0].label, 'Attach to "Phone agent maintenance" (active)');

    await runtime.runOwnerMessageHooks(turn);
    await runtime.runOwnerMessageHooks(turn);
    const fromOwner = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal' && r.source === 'owner-message');
    assert.strictEqual(fromOwner.length, 1, 'the same owner message yields one proposal');
    await runtime.endTurn(turn, { summary: 'quotes and a detour' });

    const handlers = new Map();
    registerDetourHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime });
    const resolved = await handlers.get(IPC.CASE_RESOLVE_DETOUR)({}, { caseId: door.id, detourId: proposed.detourId, optionId: 'attach-1' });
    assert.deepStrictEqual([resolved.ok, resolved.linkedCaseId], [true, phone.id]);
    assert.ok(runtime.getCase(door.id).related.some((r) => r.id === phone.id && r.relation === 'related'));
    assert.ok(runtime.getCase(phone.id).related.some((r) => r.id === door.id && r.relation === 'related'));
    assert.strictEqual(runtime.getCase(door.id).status, 'active');

    assert.strictEqual(git('rev-parse', 'HEAD'), headBefore);
    assert.strictEqual(git('status', '--porcelain'), '');
  });
});

describe('F5-cross-case: one index answers every duplicate check without leaking', () => {
  const { AskTool } = require('../src/tools/builtin/case-unattended-tools');
  const { DetourRouter } = require('../src/cases/detours/router');

  it('similar case creation, routing, Ask and unknowns all go through the index', async () => {
    const runtime = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const site = await runtime.createCase({ title: 'Website redesign', objective: 'Refresh the public website' });
    runtime.ledger(site.id).assert({ stmt: 'The hosting contract renews on 1 November for 240 dollars', subject: 'hosting', attr: 'renewal', value: 240, category: 'financial', source: { kind: 'document', ref: 'sources/hosting.pdf' } });
    runtime.records(site.id).writeJournal('plan', '# Plan\n\nMove the booking page to the static generator');
    runtime.createQuestion(site.id, { kind: 'question', text: 'Which hosting plan should the new booking site use?', urgency: 'low' });

    await assert.rejects(runtime.createCase({ title: 'Redesign the website' }), (err) => err.code === 'SIMILAR_CASES' && err.similar[0].caseId === site.id);

    const shop = await runtime.createCase({ title: 'Shop opening', objective: 'Open the pop-up shop on Saturday' });
    const routed = await new DetourRouter({ runtime }).propose(shop.id, { summary: 'redesign the website homepage', reason: 'Not the shop' });
    assert.strictEqual(routed.detour.options[0].label, 'Attach to "Website redesign" (draft)');

    const turn = await runtime.beginTurn(shop.id, { turnId: 'turn-1' });
    const asked = await AskTool.execute({ question: 'Which hosting plan should the new booking site use?' }, { caseContext: runtime.caseContext(turn) });
    assert.strictEqual(asked.ok, true);
    assert.match(asked.note, /A similar question is open in case "Website redesign"\./);
    assert.ok(!JSON.stringify(asked).includes('240'));

    const unknown = await LedgerTool.execute({ action: 'unknown', stmt: 'When does the hosting contract renew?', subject: 'hosting', attr: 'renewal', changes: 'Budget', answerable: 'owner', how: 'Ask' }, { caseContext: runtime.caseContext(turn) });
    assert.deepStrictEqual(unknown.similarInOtherCases.map((m) => [m.caseTitle, m.stmt]), [['Website redesign', '(private fact in "Website redesign" — open that case to see it)']]);
    assert.ok(!JSON.stringify(unknown).includes('240 dollars'));
    await runtime.endTurn(turn, { summary: 'x' });
  });
});
````


- [ ] **Step 2: Run them**

Run: `node --test tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`. These pin behaviour Tasks 1–11 built; if one fails, the fault is in the task that owns that code (read its test first), not in this file.

- [ ] **Step 3: Document**

Append to the end of `CLAUDE.md`:

````markdown

## Cases: detours and the cross-case index (stage 5)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage5-detours.md`.

- The cross-case index is `<casesRoot>/.index/` (`src/cases/index-store.js`,
  BM25). It is a cache: deleting `.index/` is always safe, and IPC
  `case:reindex` rebuilds it. Hits from another case carry text only for a
  disclosable fact or a brief title/objective. Never pass `includePrivate`
  outside `index-store.js`; a test greps `src/` for it.
- `CaseRuntime.createCase` refuses an open case with the same or a close
  title/objective (`SimilarCaseError`, `code: 'SIMILAR_CASES'`) unless
  `force: true`. Tests that create several cases sharing a title or an
  objective pass `force: true`.
- Detours live in `src/cases/detours/` and `.kl/detours.jsonl`. The owner's
  message is classified (`classify` role) after `UserPromptSubmit` passes; a
  host without an inference router skips it. Routing answers are applied at
  turn start, from `case:detours` and after `case:resolveDetour`.
- Case types are code in `src/cases/case-types/` (`general`, `outreach`,
  `software-repo`); `case.yaml.type` is validated at creation. A
  `software-repo` case runs read-only `git` and `gh` at turn start (tests
  inject `host.exec`); `gh` uses its own login.
- `case.yaml` `related` is written only by `CaseRuntime.addRelation` and
  `removeRelation`.
````


- [ ] **Step 4: Verify the whole stage**

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests preload.js renderer.js styles.css CLAUDE.md | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/)"`
Expected: no output.

Run: `git diff main -- src tests preload.js renderer.js styles.css CLAUDE.md | grep -nE "^\+.*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" | grep -vE "@example\.(com|org)|git@github\.com:example/|git@git\.example\.com/"`
Expected: no output (fixtures use `example.com`, `records.example.org`, `github.com/example/phone-agent`, `+15550100`, `Lakeside lot`).

Run: `git diff main --stat -- package.json package-lock.json`
Expected: no output (no new dependency).

Run: `git grep -n "includePrivate" -- src | grep -v "src/cases/index-store.js"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add tests/cases-regressions.test.js CLAUDE.md
git commit -m "test(cases): F4-detour and F5-cross-case regressions; document detours and the cross-case index

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 2 hand-off

Cases stage 5 is complete when Tasks 6–12 are merged. Later stages rely on these names:

- C3: `gates.jobSignature(executorId, job)`, `gates.findDuplicateJob({ executorId, job, liveJobs })` (C3's `duplicates.js` delegates to them), `CaseRuntime.detourGate(id, { source: 'plan' | 'executor', serves, text, turnId }) → { ok: true, note? } | { ok: false, error, classification }`; the router reads `host.getExecutorRegistry().liveState()`.
- C4: routing questions are ordinary question records (`payload.type: 'detour'`); an answer on any channel through `CaseRuntime.answerQuestion` is picked up by `runtime.detours.reconcile(caseId)` at the next turn start, `case:detours` or `case:resolveDetour`.
- C6: `registerGatingSource(fn, { origin })`, `gatingQuestionsFor(runtime, id)`, `GatingQuestion` (`{ id, text, required, field?, fact?, answerable, options?, briefField?, category?, origin }`), `resolveCaseType(type)`.
- C7: `CaseRuntime.index` (`CrossCaseIndex`), `index.attachEntities(entityIndex)` / `index.entities` (called on `rebuild`, `upsertCase`, `removeCase`), the hit shape `{ caseId, title, kind, id, score, text, redacted, subject, attr, provenance, disclosable, caseStatus, coverage }`, `CaseRuntime.addRelation(id, entry)` / `removeRelation(id, match)`, `runtime.createQuestion`.
- Modules: `src/cases/detours/log.js` (`DetourLog`, `FINAL_STATUSES`, `ROW_TYPES`, `RESOLUTION_STATUSES`), `classifier.js` (`DetourClassifier`, `CLASSIFY_SYSTEM`, `parseClassification`, `SOURCES`), `router.js` (`DetourRouter`, `cutTitle`), `hooks.js` (`registerDetourHooks`, `refreshCaseType`, `caseTypeTriggers`); `src/tools/builtin/detour-tool.js` (`DetourTool`, `registerDetourTools`); `src/ipc/detour-handlers.js` (`registerDetourHandlers`); renderer `renderCaseDetoursSection(chat, container)`.
