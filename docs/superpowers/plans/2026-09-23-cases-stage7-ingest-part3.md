# Cases Stage 7: Document Ingest, Part 3 (front-door case tools) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the four MCP case tools on the front door under `cases:read` / `cases:write` through F4's registration hooks.
**Architecture:** Two functions in `src/mcp/case-tools.js` register scopes and routed tools on the front door and `cases.<tool>` RPCs on agent nodes; F4's startup calls them, one line each. No routing state of C7's own.
**Tech Stack:** Node `node:test`; Part 2's `createCaseToolHandler`; F4 `ScopeRegistry`, `FleetRouter`, `NodeFleetService`.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage7-ingest.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

Wave 4: run only after F4 has merged and Parts 1–2 are merged. F4's plan is not written; the names below come from the F4 spec (§3.4, §3.6, §3.7, §5.2) and program §4.19. Check them against F4's merged code before starting.

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

Cases stage 7 spec:

- New dependencies: `unpdf` 1.8.1 and `pdf-lib` 1.17.1, exact versions, pure JS; `@napi-rs/canvas` and `canvas` never installed (unpdf lists `@napi-rs/canvas` only as an optional peer). No local OCR (ruling 5): OCR goes through vision models of the existing providers.
- Vision-eligible = `inferenceRouter.getCapabilities(provider, model).vision === true` **and** provider ∈ `IMAGE_FORWARDING_PROVIDERS = ['anthropic', 'openai', 'gemini']`. OCR model: `cases.ingest.vision`, else the first eligible of `draft`, `judge`; else `NO_VISION_MODEL`. `extract` uses `draft`, `verify` uses `verify`.
- `settings.cases.ingest` defaults: `maxBytes` 52428800, `maxPages` 500, `maxVisionPagesPerDoc` 20 (per tool or automatic call), `ocrUsdPerPageEstimate` 0.02, `textQualityThreshold` 0.6, `chunkChars` 12000, `maxExtractChars` 400000, `maxProposalsPerDoc` 200, `vision` `{ provider: '', model: '' }`, `entities.spanNames` false. No env vars.
- Limits: image ≤ 5 MB (`ImageHandler.MAX_SIZE_BYTES`), one-page PDF ≤ 10 MB (`MAX_DOCUMENT_SIZE_BYTES`); a PDF page with < 20 non-space characters or `textQuality` < threshold goes to vision; quotes 8–300 characters; verify context ±1,500 characters; `Ingest text` ≤ 20,000 characters; IPC ≤ 10 files and ≤ 100 MB decoded per call; `answer_question` ≤ 30 per minute per server; publish retry every 60 s.
- `docId` = `doc-` + first 12 hex of sha256. Files: `sources/<yyyy-mm>/<slug>.<ext>` + `<file>.meta.json`; `.kl/ingest/<docId>.json` and `.kl/ingest/<docId>.text.json` (committed); `.kl/ingest/cache/<docId>/<n>.json` and `publish.json` (gitignored); `<casesRoot>/.index/entities.json` (derived).
- Every `Budget.charge` is followed by `CaseRuntime.onCrossings(caseId, 'usd', crossedNow)`; the page cache is written (with `usd`) before the charge and marked `charged: true` after; 100 % stops the pipeline after the current call.
- All case writes go through `CaseRuntime.systemAction(caseId, label, fn, { commitMessage })` (R37); model calls run outside it. Commit messages start `ingest-<docId>: `. Journal kind `ingest`.
- Ingest-accepted facts are `provenance: 'sourced'`, `disclosable: false` whatever the category, with source `{ kind: 'document', ref, at, page, quote, docId, proposalId, verified: 'anchor' | 'anchor+image', ocr, origin }`; the Ledger tool refuses a model-written source carrying `verified`, `docId`, `proposalId` or `origin`. Only the owner accepts (panel or a question answer); tool-origin files never get accept-all or option `a`. The host never writes a `user` fact in the owner's name: a panel outcome closes the question (`QuestionStore.close`, R47).
- Cross-case results (entity hits, `alsoInCases`, `alsoKnownElsewhere`) carry case title and ids only — never a file name or another case's text.
- Nothing under `src/cases/ingest/` imports a provider: `callModel` is injected by `createCore`. `king-louie-service mcp` passes `ingest: 'none'`.
- Test fixtures are generated in memory with `pdf-lib`; no real documents, names or scans are checked in.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and where each is pinned:

1. **A 300-page PDF.** With a text layer: Task 8, `tests/cases-ingest-service.test.js` "300-page text" (`truncated.fromPage` recorded and journaled). As a scan: Task 8, `tests/cases-ingest-vision.test.js` "300-page scan" (one tool call reads exactly 20 pages with 20 charges, 280 stay `pending-ocr`; a second call with `pages` reads only those).
2. **A rotated scan whose `/Rotate 90` is inherited from the page tree.** Task 3 (`openPdf` reads it; the one-page copy keeps it) and Task 8 "rotated scan" (recorded on the page, in the OCR prompt, and in the attached one-page PDF).
3. **A document contradicting a `user` fact.** Task 9, `tests/cases-ingest-review.test.js` "conflict with a user fact" (listed, skipped by accept-all, plain accept and `keepBoth` refused, accept with `supersedes` creates the chain).
4. **The same document dropped twice.** Task 2 "duplicate" (one file, one sidecar) and Task 8 "duplicate and cross-case" (no model calls, one record; another case gets `alsoInCases` with title and id only).
5. **A garbage text layer.** Task 3 "garbage layer" (only page 2 goes to vision, `method: 'ocr'`, `quality` < 0.6).

## Interfaces from other stages

| Contract | Exact shape consumed | Stub in tests until it merges |
|---|---|---|
| C2 (required, merged) | `new CaseRuntime({ root, getSettings, now, host })`; `getCase` (`CaseNotFoundError.code === 'CASE_NOT_FOUND'`), `listCases`, `store` (`CaseStore`, `updateMeta`), `getSettings`, `ledger(id)`, `brief(id)`, `records(id).writeJournal(kind, text, now)` / `.lastJournal()`, `orientation(id)`, `budget(id)` (`charge('usd', amount, meta) → { crossedNow }` with `meta.unpricedTokens`, `remaining('usd')` → `null` without a limit, `status().usd`), `onCrossings(id, 'usd', crossedNow)`, `roleModel(id, role) → { provider, model, tier }`, `systemAction(id, label, fn, { commitMessage })` (`CaseBusyError`, `code: 'CASE_BUSY'`), `createQuestion(id, record, { charge }) → record \| { held: true }`, `questions(id)` (`get`, `open`, `close(id, { reason, by })`), `answerQuestion(caseId, qid, { channel, text, optionId }) → { question, fact, effect }`, `_notify(event, payload)`; `QuestionStore.registerAnswerHandler(type, { onAnswered })`; `FactLedger.assert` honouring `disclosable: false`; `src/cases/defaults.js` `mergeCaseSettings`; `chat-integration.js` `CASE_TOOL_NAMES`; `case-tools.js` Ledger with `withCase(options, op, fn, { params })`; `tests/cases-tools.test.js` asserting `CASE_TOOL_NAMES` | none: real code (C7 is wave 2, after C2) |
| C5 (optional) `CrossCaseIndex.attachEntities(entityIndex)`, `.entities`, `CaseRuntime.index` (program §4.10, R46) | `entityIndex()` attaches C7's `EntityIndex` when `this.index?.attachEntities` exists; C5 then calls `entities.rebuild()`, `upsertCase(id)`, `removeCase(id)` synchronously | Task 7 defines an `index` property on one runtime with `{ entities: null, attachEntities(e) }` |
| C3 (optional) `gateLeaves(payload, { facts, mode, caseId, entityIndex })` consuming `nonDisclosableSpans` (program §4.9, R38) | C3 calls `runtime.entityIndex?.()?.nonDisclosableSpans(text, { caseId })` | Task 15 asserts the block only when `gates.gateLeaves` exists; the span itself is asserted either way |
| F3 (optional) `AuditLedger.append({ kind, data })` (program §4.16) | the MCP handler's `audit` option | Task 12 passes `{ append }` |
| F4 (Part 3 only; wave 4) `ScopeRegistry.register`, `FleetRouter.registerTool(def, { scope, route })`, `NodeFleetService.registerMethod(name, handler)` (program §4.19, R53) | as named in F4 spec §3.4, §3.6, §3.7, §5.2 | Task 16 passes recorders |

## Deviations and resolved gaps (read before starting)

1. **`callModel` takes the model.** Spec §3.4 has `callModel` choose by purpose; the service resolves `{ provider, model }` and passes it, because it must know the OCR model before the call (attachment choice by `pdfInput`) and check the verify model's eligibility (Task 4).
2. **Empty `tools`.** OpenAI's Chat Completions rejects `tools: []` and `tool_choice` without tools, and `routeWithFallback` never sends an empty list; OpenAI and Anthropic `sendMessageWithTools` now omit the key when empty (Task 4). This touches `src/providers/openai-provider.js` and `anthropic-provider.js` (one hunk each in the non-streaming path), which program §5 does not list for C7.
3. **Automatic reads are capped.** The read that starts after an owner drop is capped like a tool read (`maxVisionPagesPerDoc`); only the owner's Extract / Read-remaining button reads without a cap (Task 8).
4. **Commit messages per stage boundary** (`stored`, `extracting`, `read`, `checking N proposals`, `N proposals`, `failed`, `waiting`, `reviewed <pid>`), so a crash resumes from the last committed stage (Task 8).
5. **`store`/`adopt` on a busy case throw** `CaseBusyError` to the caller; pipeline publishes are kept in `publish.json` and retried (Task 8).
6. **`list`/`get` are async** (they retry pending publishes first).
7. **`nonDisclosableSpans` also scans indexed surface forms** (≥ 5 characters), so `0042-7781` without a label is caught (F5-doc); unindexed entities are still never reported (Task 7).
8. **Ingest tool status rules** are checked in the tool, not through C2's `assertWritable`/`READ_OPS` (which would allow `Ingest.status` in a paused case); `src/cases/status.js` is not edited (Task 10).
9. **Option `a` of the review question** is offered only for non-owner, non-tool origins, of which this stage has none; the handler implements it and a test answers a hand-made question (Task 9).
10. **Fixtures** are generated in memory (`tests/helpers/ingest-fixtures.js`) instead of the binary `tests/fixtures/ingest/*.jpg|png` of spec §10.
11. **`parseValue`** is repeated in `src/cases/ingest/review.js` rather than importing the Ledger tool module into `src/cases/`.
12. **Tool schemas** describe the `pages`/`docId` grammars in text and check them in code instead of JSON-schema `pattern` (provider subsets); the MCP `inputSchema`s keep `pattern` (MCP clients read JSON Schema).
13. **Anchors on post-C2 text.** Tasks that edit C2-owned files quote C2's code (C7 runs after C2 merges). Where C3, C5 or C6 have already appended to the same line (`CASE_TOOL_NAMES`, its test), keep their entries and add C7's.

---

### Task 16: Front-door case tools through F4's hooks

**Files:**
- Modify: `src/mcp/case-tools.js` (`module.exports`)
- Modify: `src/fleet/start.js` (F4; after the statement that constructs the `NodeFleetService`)
- Modify: the F4 front-door startup module that constructs `ScopeRegistry` and `FleetRouter` (F4 §3.1 profile startup; before `frontdoor.oauth.scopes_enabled` is checked against registered scopes)
- Test: `tests/frontdoor-case-tools.test.js`

**Interfaces:**
- Consumes (F4, program §4.19, F4 spec §3.4, §3.6, §3.7, §5.2): `ScopeRegistry.register(name, { tools, description, requires? })`, `FleetRouter.registerTool(def, { scope, route })` with `route(args, ctx) → { fanout: true } | { machine }`, `NodeFleetService.registerMethod(name, handler(params))` where params carry `origin` and `max_bytes` (and `request_id` for some tools); Part 2's `CASE_MCP_TOOLS` and `createCaseToolHandler`.
- Produces: `CASE_SCOPES`, `frontDoorDef(tool)`, `registerFrontDoorCaseTools({ scopes, router })`, `registerNodeCaseMethods(nodeFleetService, { getRuntime, audit?, log? }) → handler` (methods `cases.list_cases`, `cases.open_case`, `cases.get_orientation`, `cases.answer_question`).

On the front door the case-keyed tools take a required `machine` (the `machine` tag F4 adds to each fanned-out `list_cases` row), so the route is `{ machine: args.machine }` and F4's `machines=` grant check applies; `list_cases` fans out. The node strips `machine`, `origin`, `max_bytes` and `request_id` and accepts the tool arguments either flat or under `arguments`, because F4's plan (not written yet) fixes the RPC params shape; once it is, drop the form it does not use. The node handler uses the `mcp-frontdoor` channel, so it repeats every refusal after the router's scope check, including failure and status-changing questions. `cases:read`'s description, which the grant screen shows, says it includes private facts. An admin enables the scopes by adding `cases:read` and `cases:write` to `frontdoor.oauth.scopes_enabled` in the front door's `node.yaml`; F4 advertises a scope only when it is both registered and listed, and rejects a listed scope that is not registered, so `registerFrontDoorCaseTools` must run before that check.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-case-tools.test.js`:

```js
// tests/frontdoor-case-tools.test.js
// Cases stage 7, wave 4 (spec §3.8; program §4.19, R53): the case tools
// through F4's ScopeRegistry, FleetRouter and NodeFleetService. F4's classes
// are stood in by recorders with the program's exact method signatures.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { registerFrontDoorCaseTools, registerNodeCaseMethods, CASE_SCOPES } = require('../src/mcp/case-tools');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('front-door case tools', () => {
  it('registers cases:read and cases:write and four routed tools', () => {
    const scopes = [];
    const tools = [];
    registerFrontDoorCaseTools({
      scopes: { register: (name, spec) => scopes.push([name, spec]) },
      router: { registerTool: (def, opts) => tools.push([def, opts]) }
    });
    assert.deepStrictEqual(scopes, [
      ['cases:read', { tools: ['list_cases', 'open_case', 'get_orientation'], description: 'Read case lists, briefs, questions and orientation, including private facts.' }],
      ['cases:write', { tools: ['answer_question'], description: 'Answer open case questions that are marked answerable remotely.', requires: ['cases:read'] }]
    ]);
    assert.deepStrictEqual(tools.map(([d, o]) => [d.name, o.scope]), [
      ['list_cases', 'cases:read'], ['open_case', 'cases:read'], ['get_orientation', 'cases:read'], ['answer_question', 'cases:write']
    ]);
    const [listDef, listOpts] = tools[0];
    assert.deepStrictEqual(listOpts.route({}), { fanout: true });
    assert.deepStrictEqual(listDef.inputSchema.required || [], []);
    const [answerDef, answerOpts] = tools[3];
    assert.deepStrictEqual(answerDef.inputSchema.required, ['machine', 'case', 'question_id']);
    assert.deepStrictEqual(answerOpts.route({ machine: 'web-01', case: 'lakeside-lot' }), { machine: 'web-01' });
    assert.ok(Object.isFrozen(CASE_SCOPES));
  });

  it('agent nodes answer cases.<tool> with the front-door refusals', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-cases-'));
    dirs.push(root);
    const rt = new CaseRuntime({ root });
    const meta = await rt.createCase({ title: 'Lakeside lot' });
    rt.store.updateMeta(meta.id, { status: 'active' });
    const plain = rt.createQuestion(meta.id, { kind: 'question', urgency: 'low', text: 'Which listing photo should lead?' }, { charge: false });
    const failure = rt.createQuestion(meta.id, { kind: 'question', urgency: 'high', text: 'Upload failed; how to proceed?', payload: { type: 'direction', failure: 'journal/x-failure.md' } }, { charge: false });
    const methods = new Map();
    registerNodeCaseMethods({ registerMethod: (name, fn) => methods.set(name, fn) }, { getRuntime: () => rt });
    assert.deepStrictEqual([...methods.keys()], ['cases.list_cases', 'cases.open_case', 'cases.get_orientation', 'cases.answer_question']);
    const origin = { client: 'front-door', scopes: ['cases:read', 'cases:write'] };
    const rows = await methods.get('cases.list_cases')({ origin, max_bytes: 524288 });
    assert.deepStrictEqual(rows.map((r) => r.title), ['Lakeside lot']);
    await assert.rejects(
      methods.get('cases.answer_question')({ origin, arguments: { machine: 'web-01', case: meta.id, question_id: failure.id, text: 'retry' } }),
      (e) => e.code === 'not_answerable_here'
    );
    const ok = await methods.get('cases.answer_question')({ origin, machine: 'web-01', case: meta.id, question_id: plain.id, text: 'The lake view' });
    assert.strictEqual(ok.question_id, plain.id);
    assert.strictEqual(rt.questions(meta.id).get(plain.id).answer.channel, 'mcp-frontdoor');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/frontdoor-case-tools.test.js`
Expected: FAIL with `registerFrontDoorCaseTools is not a function`

- [ ] **Step 3: Implement**

In `src/mcp/case-tools.js`, replace

```js
module.exports = { CASE_MCP_TOOLS, STATUS_CHANGING, CaseToolError, createCaseToolHandler, untrusted };
```

with

```js
// ---- Front door (wave 4; F4 route contract, program §4.19, R53) ----

const CASE_SCOPES = Object.freeze({
  'cases:read': {
    tools: ['list_cases', 'open_case', 'get_orientation'],
    description: 'Read case lists, briefs, questions and orientation, including private facts.'
  },
  'cases:write': {
    tools: ['answer_question'],
    description: 'Answer open case questions that are marked answerable remotely.',
    requires: ['cases:read']
  }
});
const MACHINE_ARG = Object.freeze({ type: 'string', minLength: 1, maxLength: 64, description: 'The machine a list_cases row names.' });

// The front-door form of a case tool: the case-keyed tools take `machine`.
function frontDoorDef(tool) {
  if (tool.name === 'list_cases') return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  return {
    name: tool.name,
    description: `${tool.description} Name the machine from list_cases.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: { machine: MACHINE_ARG, ...tool.inputSchema.properties },
      required: ['machine', ...tool.inputSchema.required]
    }
  };
}

// On the front door: two scopes and four routed tools. No router state: a
// case id is unique per node and the client names the node.
function registerFrontDoorCaseTools({ scopes, router }) {
  for (const [name, spec] of Object.entries(CASE_SCOPES)) scopes.register(name, { ...spec, tools: [...spec.tools] });
  for (const tool of CASE_MCP_TOOLS) {
    const scope = tool.name === 'answer_question' ? 'cases:write' : 'cases:read';
    const route = tool.name === 'list_cases' ? () => ({ fanout: true }) : (args) => ({ machine: args.machine });
    router.registerTool(frontDoorDef(tool), { scope, route });
  }
}

// On an agent node: the cases.<tool> RPCs behind the router's scope check.
// The node repeats every refusal with the front-door channel's rules.
function registerNodeCaseMethods(nodeFleetService, { getRuntime, audit = null, log } = {}) {
  const handler = createCaseToolHandler({ getRuntime, channel: 'mcp-frontdoor', audit, ...(log ? { log } : {}) });
  for (const name of handler.names) {
    nodeFleetService.registerMethod(`cases.${name}`, async (params = {}) => {
      const { origin, max_bytes: maxBytes, request_id: requestId, arguments: nested, ...flat } = params || {};
      const { machine, ...args } = nested && typeof nested === 'object' ? nested : flat;
      return handler.call(name, args);
    });
  }
  return handler;
}

module.exports = {
  CASE_MCP_TOOLS,
  STATUS_CHANGING,
  CaseToolError,
  createCaseToolHandler,
  untrusted,
  CASE_SCOPES,
  frontDoorDef,
  registerFrontDoorCaseTools,
  registerNodeCaseMethods
};
```

In `src/fleet/start.js`, directly after the statement that constructs F4's `NodeFleetService` (call its variable `nodeFleetService` here; use F4's name), add this one line, inside the agent-profile branch (a runbook node never loads the agent core, F4 §3.7):

```js
    require('../mcp/case-tools').registerNodeCaseMethods(nodeFleetService, { getRuntime: () => core?.context?.getCaseRuntime?.() || null, audit: approvals?.auditLedger || null });
```

In F4's front-door startup, directly after `ScopeRegistry` and `FleetRouter` are constructed (variables `scopes` and `router` here; use F4's names) and before `frontdoor.oauth.scopes_enabled` is validated, add:

```js
  require('../mcp/case-tools').registerFrontDoorCaseTools({ scopes, router });
```

(The require path is relative to `src/frontdoor/` and `src/fleet/`; both are one level under `src/`.) Add a line to the front-door example `node.yaml` under `examples/` only if F4's plan lists the cases scopes there; the default `scopes_enabled` stays the four fleet scopes.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/frontdoor-case-tools.test.js tests/mcp-case-tools.test.js`
Expected: PASS, `# fail 0`

Run: `npm test`
Expected: PASS, `# fail 0` (F4's own front-door and fleet-node tests included).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/case-tools.js src/fleet/start.js tests/frontdoor-case-tools.test.js
git add src/frontdoor
git commit -m "feat(mcp): case tools on the front door under cases:read and cases:write

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 3 hand-off

Cases stage 7 is complete. Exports added: `src/mcp/case-tools.js` `CASE_SCOPES`, `frontDoorDef(tool)`, `registerFrontDoorCaseTools({ scopes, router })`, `registerNodeCaseMethods(nodeFleetService, { getRuntime, audit, log })`. Front-door clients see `list_cases` (fan-out, rows tagged `machine`) and `open_case`, `get_orientation`, `answer_question` (each with a required `machine`) once an admin lists `cases:read` and `cases:write` in `frontdoor.oauth.scopes_enabled`. `delegate(machine, task, cwd?, case?)` targeting a case stays with the stage that implements `delegate` (spec §3.8).
