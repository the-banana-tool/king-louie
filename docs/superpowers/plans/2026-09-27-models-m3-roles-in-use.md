# Models M3: Roles in Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the roles M2 built to work: cheap work (file reading and searching through a read-only explorer on worker, chat titles on utility) moves off main, every model call records the role it ran under and the reply shows cost by role, and the owner gets the King Louie profile's proposals, a custom-roles editor and the `models`/`profiles` service commands.

**Architecture:** No new subsystem. The resolver's `TurnModels` (M2) already serves every call; M3 changes who asks it for which role. `SpawnAgent`, `BackgroundTask`, workflow tasks and the agent IPC runs name a role instead of a model, and a model the LLM names must already be in the profile. The router stamps each call's metrics with `role`, `profileId`, `borrowedFrom` and `failover` (`InferenceRouter#newRouteState(tags)`), `UsageTracker` totals by role and model, and the chat send path rolls sub-agent calls into the reply (`summarizeTurnLlm`). The King Louie profile is a pure picker (`src/models/suggester.js`) under a small stateful service (`src/models/king-louie.js`) that proposes; the owner accepts. Custom roles get create/update/remove on `Profiles`. The service CLI gains `src/service/commands/models.js`.

**Tech Stack:** Node 22, `node:test`, Electron renderer (plain DOM), Playwright `_electron` for e2e.

**Spec:** `docs/superpowers/specs/2026-09-27-model-catalog-profiles-roles-design.md`, stage M3 (§18): §7 (the King Louie profile), §8 and §8.1 (call sites, the explorer and delegation), SpawnAgent roles, §10 (cost records), §6.2 custom roles (the M2 data model plus its UI), §11's M3 parts (King Louie profile, Advanced: custom roles, the per-role cost line), §12 (service commands), and the §15/§16 rows for these. Stages M1 and M2 have landed on `feat/model-roles` (HEAD 6500bfa); this plan builds on the code as it is. The carried items in `.superpowers/sdd/m3-planning/m3-carry.md` are placed in Task 3 (item 8), Task 5 (item 4), Task 6 (items 1 and 2), Task 8 (item 3), Task 1 and Task 4 (item 9) and Tasks 9–11 (item 6); items 5 and 7 stay as they are (Interpretations 12 and 20).

**Not in this plan:** whole-turn routing and cheap tool rounds (spec §19, a later spec); sending `effort` to provider APIs (Interpretation 12); keyword, regex or prefix routing rules (removed for good, M-D11).

## Global Constraints

- Tests run with node's built-in runner: `node --test tests/<file>.test.js`. Never `jest`. Look for `# fail 0` in the TAP summary. The implementer runs only the test files a task names; the controller runs `npm test` and `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` once, at stage end.
- A task that changes a shared contract updates every existing test that exercises it, in the same task; each such file is listed under the task's **Files**.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` enforces it.
- Log through `createLogger` from `src/logging.js`; never bare `console.*` in `src/`.
- Open source: invented values only in code, tests, fixtures and docs (no personal names, machine names, domains or home paths). Shipped names are generic: the King Louie profile is named "King Louie selected".
- Unit tests never touch the network: inject `fetch`, use fake providers, `tests/helpers/fake-llm-server.js` and the fixture catalog.
- The owner assigns models to roles; King Louie only suggests (M-D2, M-D4). Nothing picks a model outside the resolved list. A model an LLM names (SpawnAgent `model`, a planned workflow task's `preferredModel`) must already be in the turn's profile. The King Louie profile changes only when the owner accepts a proposal, or `autoAccept` is on.
- Case roles (M-D6): orient and classify on utility; draft on worker; judge and verify on main (done in M2; M3 keeps it). Built-in agents: `main`, `planner`, `code-writer` on main; `code-explorer`, `case-researcher` on worker.
- Headless runs (service, channels, cron, gateway, remote control, mesh) use the default profile (M-D12). A running turn keeps its frozen models (spec §6.6); a switch applies between turns.
- Settings keys and defaults, verbatim from spec §14 (M3 subset): `models.kingLouie: { autoAccept: false, bandPoints: 3, workerAgenticRatio: 0.8, utilityIntelligenceRatio: 0.5, preferLocalUtility: false, blend: { input: 3, output: 1 } }`, `models.explorer: { summaryMaxTokens: 2000 }`. This plan adds one key, `models.kingLouie.dismissedProposalId: null`. Every key merges through `mergeSettings` in `src/core/settings.js`.
- Picking rules (spec §7.1), verbatim: main needs tool calling, ranked by agentic score then intelligence, and among candidates within `bandPoints` of the best the cheaper wins; worker needs tool calling and at least 128K context (128000 tokens), the cheapest whose agentic score is at least `workerAgenticRatio` of main's first pick; utility has no tool requirement, the cheapest whose intelligence score is at least `utilityIntelligenceRatio` of main's first pick, a usable local model with tool support first when `preferLocalUtility` is on; vision as utility with image input and without the local preference; imageGeneration the usable image-output models, cheapest priced first; price compares a blended rate of three parts input to one part output per million tokens; lists hold two or three targets, spread across providers where possible; utility at the lowest effort offered, others at the model's default; unpriced models, and unscored models except local ones under `preferLocalUtility`, are never picked; custom roles are never filled.
- Cost records (spec §10): each `llm.calls[]` entry carries `role`, `profileId`, `failover` (true when not the first target) and `borrowedFrom`. Sub-agent runs roll up into the parent reply as `llm.subagents`. The reply's metrics line reads like `$0.12 · main $0.09 · worker $0.02 · utility $0.01`.
- A new IPC channel goes through `src/ipc/constants.js`, a handler in `src/ipc/models-handlers.js`, `preload.js` (`window.electron.models`) and `tests/ipc-contract.test.js`; `models` stays in `PROXIED_DOMAINS` (`src/desktop-bridge/allowlist.js`); a new renderer event joins `RENDERER_EVENTS` there.
- The renderer sets every model, profile and role string with `textContent`, never `innerHTML`, and uses no native dialogs (`confirm`, `alert`, `prompt`).
- Anchor every edit by content, not by line number: line numbers below are hints and drift.

## Review Focus

1. A sub-agent is stopped or fails mid-run: its finished and partial calls still count in the parent reply's cost, never as $0 and never twice (Task 4 test `a stopped turn keeps the sub-agent calls that ran`).
2. The owner accepts a King Louie proposal that changed after it was shown (a second window accepted it, a key test finished, the catalog refreshed): the accept is refused and nothing is written, never a different set of models applied (Task 10 test `accepting a proposal that changed since it was shown is refused and writes nothing`).
3. The picker meets candidates with a missing score or price, or a main pick with no intelligence score: utility and vision stay empty with a reason and borrow; nothing throws or divides by null (Task 9 test `a main pick with no intelligence score leaves utility and vision empty, with a reason`).
4. A custom role is removed while a profile or a case role still names it: the removal is refused and the references are listed; a role a profile or case names that is no longer defined fails the call naming the role (Task 12 tests `removing a custom role that is still used is refused, naming each use` and `a deleted custom role fails the call naming it`).
5. Every utility model is unusable (keys removed, tests failing) when a new chat's first reply lands: the title is skipped quietly, the reply is unaffected and nothing is recorded (Task 5 test `no usable utility model skips the title and records nothing`).

## Interpretations and deviations

Choices this plan makes where the spec is silent or leaves room; each is a line a reviewer can overturn.

1. SpawnAgent's role: the `role` parameter when given; else the named agent's own role when `agentId` is given; else `worker` (the spec's default). A bare `SpawnAgent({ task })` therefore runs on worker, not main.
2. SpawnAgent keeps an optional `model`, accepted only when it names a model already in the turn's profile (any role's list or the main override), as `provider/model`, `provider:model` or a bare id; anything else is refused with the profile's models listed. The `provider` parameter is removed.
3. A planned workflow task's `preferredModel` gets the same rule (the planner LLM writes it, so it is not the owner's choice); tasks gain an optional `role`, and the planner template suggests a role, not a model. Spec §6.3's "explicit target, still checked for usability" stays for owner-written targets (case.yaml roles, a delegate session's config).
4. BackgroundTask gets the same `role` parameter and default rule as SpawnAgent (no `model`).
5. `code-explorer` keeps its id (tests, workflows and templates name it) and becomes the general explorer: name "Explorer", read-only (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`), role worker. SpawnAgent enforces the summary cap: it tells the child its budget and cuts a longer answer at `summaryMaxTokens × 4` characters with a note.
6. The delegation guidance is prepended to the system prompt of agent-mode chat turns that are not case turns (SpawnAgent is refused in case turns and absent from plain chat). `SpawnAgent` joins the context assembler's core tools so the model can call it without a `ToolSearch` round.
7. The King Louie profile is created by the owner's first Accept, not as an empty profile at first start; before that it exists only as the proposal ("On first run the King Louie profile starts as a proposal"). Its roles change only through Accept (the editor refuses it: "Duplicate it to make your own"); it can be duplicated, made the default or deleted, and the next Accept recreates it.
8. A proposal's id is a hash of the proposed role lists. Dismissing hides it until the proposed lists change; an input change that leaves the picks the same keeps it hidden. `autoAccept` never accepts a dismissed proposal.
9. The cost effect reprices the last 30 days of each changed role's recorded usage on the proposed first target (an empty proposed worker or utility is priced on the role it borrows from) and subtracts what those calls were recorded as costing; a role whose recorded calls include unpriced ones says the recorded cost is incomplete; a role with no recorded calls shows no estimate.
10. Lists hold up to three targets: main's first pick then the next by ranking; worker, utility and vision the next cheapest that qualify; each list prefers a provider not yet in it, then fills from the rest.
11. Scores gate each pick: main and worker need an agentic score, utility and vision an intelligence score. When main's first pick has no intelligence score, utility and vision stay empty (they borrow) with a reason.
12. `effort` stays stored but unsent (spec §18 does not list sending it in M3). The King Louie profile still sets utility at the lowest effort offered, ready for the stage that sends it.
13. Titles use `resolve('utility')`, so an empty utility borrows from worker, then main, like any utility call; nothing usable means no title. Titles and the advisor call through `streamMessage` (a one-shot helper), since plain `sendMessage` returns no usage. The advisor stays on main.
14. A reply's `llm.calls` stays the parent's own calls; `llm.subagents` lists each SpawnAgent run (`{ agentId, role, calls, totals }`); `llm.totals` and `llm.byRole` cover both. BackgroundTask runs are not rolled into the reply (they outlive it); their usage is still recorded.
15. `UsageTracker` keys calls with no role as `other`, and model totals as `provider:model`. It counts `unpricedCalls` instead of adding $0 for them silently.
16. Custom-role references are profiles holding a non-empty list for the role, `settings.cases.roles`, and each case's `case.yaml` `roles`. No agent editor exists in the app (agents are built-in only), so spec §6.4's "the agent editor warns when the agent loads" has nothing to attach to; an unknown role fails the call naming it (M2's `UnknownRoleError`).
17. `models refresh` and `profiles set-default` refuse while the service runs on that data dir (it holds its own copy of the stores, as `token set` already refuses); `models status` and `profiles list|show` work either way. `profiles show` and `set-default` take an id or a name.
18. The image tool: when the profile's imageGeneration role lists models, only its usable targets whose provider King Louie can generate images with (OpenAI today) are used, and asking for `fal` or another model is refused; with the role empty, today's image settings apply.
19. Agent IPC runs (`agent:executeParallel`, `agent:executeSerial`, `agent:executeWithDeps`) give each agent, and each dependency task, its own runtime and routed provider on that agent's own role (not main).
20. Built-in agents lose their hardcoded `model` and `inferenceTier`; `Agent` defaults both to `null`. A desktop import still does not carry profiles (carry item 7): §12 does not ask for it.
21. Case ingest OCR tests the vision role's providers once per document, before its first page (`CaseRuntime#ensureVisionTested`).
22. The King Louie proposal is recomputed on catalog and availability changes, debounced 200 ms, and pushed to the renderer as `models:proposalChanged`.

---

## File Structure

New, Electron-free:

| File | Responsibility |
|---|---|
| `src/models/suggester.js` | The §7.1 picking rules as pure functions: `KING_LOUIE_DEFAULTS`, `mergeKingLouieSettings`, `candidateFromEntry`, `blendedRate`, `lowestEffort`, `pickRoles`, `buildProposal`, `proposalId` |
| `src/models/king-louie.js` | `KingLouieProfile`: the proposal over live candidates, accept, dismiss, auto-accept, its settings, "Duplicate as my profile", the debounced recompute |
| `src/providers/one-shot.js` | `oneShot(provider, messages, options)`: one tool-less call through `streamMessage`, returning `{ text, llmMetrics }` |
| `src/service/commands/models.js` | `runModelsCommand`, `runProfilesCommand` (spec §12) |

Modified: `src/tools/builtin/spawn-agent-tool.js`, `src/tools/builtin/background-task-tool.js`, `src/tools/builtin/image-generate-tool.js`, `src/agents/agent-schema.js`, `src/agents/agent-executor.js`, `src/agents/builtin/*.js`, `templates/code-explorer.md.template`, `templates/code-writer.md.template`, `templates/main-assistant.md.template`, `templates/planner.md.template`, `src/context/system-sections.js`, `src/context/context-assembler.js`, `src/core/settings.js`, `src/core/create-core.js`, `src/core/model-choices.js`, `src/providers/inference-router.js`, `src/providers/base-provider.js`, `src/tracking/usage-tracker.js`, `src/tracking/llm-totals.js`, `src/execution/agent-loop.js`, `src/execution/tool-executor.js`, `src/execution/advisor.js`, `src/ipc/chat-handlers.js`, `src/ipc/agent-handlers.js`, `src/ipc/models-handlers.js`, `src/ipc/constants.js`, `src/cases/case-runtime.js`, `src/cases/ingest/index.js`, `src/models/profiles.js`, `src/models/index.js`, `src/workflows/workflow-engine.js`, `src/desktop-bridge/allowlist.js`, `src/service/cli.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`, `CLAUDE.md`.

New tests: `tests/background-task-role.test.js`, `tests/explorer-delegation.test.js`, `tests/llm-totals.test.js`, `tests/chat-roles.test.js`, `tests/advisor.test.js`, `tests/image-generate-tool.test.js`, `tests/models-suggester.test.js`, `tests/models-king-louie.test.js`, `tests/models-custom-roles.test.js`, `tests/renderer-models-m3.test.js`, `tests/service-cli-models.test.js`, `tests/e2e/models-roles.test.js`.

Task order follows the §1.1 saving: delegation to a cheap explorer first (Tasks 1–2), then the cost records that show it (3–4), titles on utility (5), the remaining call sites (6–8), then the King Louie profile (9–11), custom roles (12) and the service commands (13).

---

## Task 1: SpawnAgent and BackgroundTask run on a role; a model they name must be in the profile

**Files:**
- Modify: `src/tools/builtin/spawn-agent-tool.js` (parameters and `execute`), `src/tools/builtin/background-task-tool.js` (parameters and the `agentExecutorAdapter.execute` call), `src/core/create-core.js` (the `../models/roles` require near line 75; a new `profileTargetFor` after `explicitTargetFor`; `createAgentRuntime`; `agentExecutorAdapter.execute`)
- Test: `tests/spawn-agent-tool.test.js` (two tests changed, one removed, one describe added), `tests/background-task-role.test.js` (new), `tests/models-headless.test.js` (two tests added), `tests/chat-profiles.test.js` (run only: its SpawnAgent children name `agentId`, so they keep their agents' roles)

**Interfaces:**
- Consumes: `createAgentRuntime(selection, event, approvalRequester, runtimeOptions)` and `explicitTargetFor` (M2, `src/core/create-core.js`); `TurnModels#candidatesFor(role)`, `#configuredFor(role)`, `.mainOverride`, `.profileName` (`src/models/resolver.js`); `Profiles#customRoles()`; `BUILTIN_ROLES`, `targetKey`, `targetLabel` (`src/models/roles.js`); `roleForAgent(agent)`.
- Produces:
  - SpawnAgent parameters: `task`, `agentId`, `role`, `model`, `maxIterations`, `systemPromptAppend`, `tools` (no `provider`). Its result gains `role` (the role it asked for, or `null` when the agent's own role applied) and `model` becomes the model of the child's last call (or `null`).
  - BackgroundTask parameters gain `role`.
  - Both pass `options.role` to `agentExecutorAdapter.execute` by one rule: the `role` parameter; else nothing when `agentId` was given (the agent's own role applies); else `'worker'`.
  - SpawnAgent passes `options.model` with `options.requireInProfile: true`.
  - `agentExecutorAdapter.execute(agent, message, { requireInProfile: true, model })` → `createAgentRuntime({ role, model, requireInProfile: true })` → `profileTargetFor(selection, turnModels, role)`: returns a target from the turn's profile (the role's candidates, the main override, then every role's configured list) matching `model` as a bare id, `provider/model` or `provider:model`; otherwise throws `Error` with `code: 'MODEL_NOT_IN_PROFILE'` and the message `<model> is not in the profile "<name>". A sub-agent may use only models placed in a role: <provider/model, …>. Name a role instead.`

- [ ] **Step 1: Write the failing tests**

In `tests/spawn-agent-tool.test.js`, in `it('has all expected parameters', …)`, replace

```js
      assert.ok(props.model);
      assert.ok(props.provider);
```

with

```js
      assert.ok(props.model);
      assert.ok(props.role);
      // A sub-agent names a role, never a provider (models spec 2026-09-27 §8).
      assert.strictEqual(props.provider, undefined);
```

In `it('passes model override', …)`, replace

```js
      assert.strictEqual(result.success, true);
      assert.strictEqual(capturedOptions.model, 'gpt-4o');
```

with

```js
      assert.strictEqual(result.success, true);
      assert.strictEqual(capturedOptions.model, 'gpt-4o');
      // The core checks the model against the turn's profile (M-D2).
      assert.strictEqual(capturedOptions.requireInProfile, true);
```

Delete the whole `it('passes provider override through options', …)` test (the parameter is gone). Then add this describe after the `describe('execute()', …)` block, inside `describe('SpawnAgentTool', …)`:

```js
  describe('roles (models spec 2026-09-27 §8)', () => {
    const capture = () => {
      const seen = [];
      const options = makeOptions({
        adapter: {
          execute: async (agent, msg, opts) => {
            seen.push({ agentId: agent.id, opts });
            return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { calls: [{ model: 'worker-model' }], totals: {} } };
          }
        }
      });
      return { seen, options };
    };

    it('runs a bare SpawnAgent on worker', async () => {
      const { seen, options } = capture();
      const result = await SpawnAgentTool.execute({ task: 'Find the config loader' }, options);
      assert.strictEqual(seen[0].opts.role, 'worker');
      assert.strictEqual(result.role, 'worker');
      assert.strictEqual(result.model, 'worker-model');
    });

    it('leaves a named agent on its own role unless a role is given', async () => {
      const { seen, options } = capture();
      await SpawnAgentTool.execute({ task: 'Plan it', agentId: 'planner' }, options);
      await SpawnAgentTool.execute({ task: 'Plan it', agentId: 'planner', role: 'utility' }, options);
      assert.strictEqual('role' in seen[0].opts, false);
      assert.strictEqual(seen[1].opts.role, 'utility');
    });

    it('asks the core to check a named model against the profile', async () => {
      const { seen, options } = capture();
      await SpawnAgentTool.execute({ task: 'x', model: 'openai/gpt-5.4-mini' }, options);
      assert.deepStrictEqual([seen[0].opts.model, seen[0].opts.requireInProfile], ['openai/gpt-5.4-mini', true]);
    });

    it('reports a refused model as a failed spawn', async () => {
      const refused = Object.assign(new Error('gpt-9 is not in the profile "Work". A sub-agent may use only models placed in a role: openai/gpt-5.5. Name a role instead.'), { code: 'MODEL_NOT_IN_PROFILE' });
      const result = await SpawnAgentTool.execute(
        { task: 'x', model: 'gpt-9' },
        makeOptions({ adapter: { execute: async () => { throw refused; } } })
      );
      assert.strictEqual(result.success, false);
      assert.match(result.error, /not in the profile "Work"/);
    });
  });
```

Create `tests/background-task-role.test.js`:

```js
// tests/background-task-role.test.js
// BackgroundTask names a role the way SpawnAgent does (models spec
// 2026-09-27 §8): the role parameter, else the named agent's own role, else
// worker.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { BackgroundTaskTool } = require('../src/tools/builtin/background-task-tool');

// Runs the task at once instead of in the background, so the test can await it.
function fakeManager() {
  const runs = [];
  return {
    runs,
    appendOutput: () => {},
    spawn: async (_config, executor) => {
      const task = { id: 'bg-1', signal: new AbortController().signal };
      runs.push(executor(task));
      return task;
    }
  };
}

async function run(params) {
  const seen = [];
  const manager = fakeManager();
  const result = await BackgroundTaskTool.execute(params, {
    backgroundTaskManager: manager,
    agentExecutorAdapter: { execute: async (agent, _msg, opts) => { seen.push({ agentId: agent.id, opts }); return { content: 'done' }; } },
    getAgent: (id) => ({ id, name: id }),
    approvalRequester: async () => true,
    workingDirectory: process.cwd()
  });
  await Promise.all(manager.runs);
  return { result, seen };
}

describe('BackgroundTask roles', () => {
  it('runs a bare task on worker', async () => {
    const { result, seen } = await run({ task: 'Summarize the changelog' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(seen[0].opts.role, 'worker');
  });

  it('keeps a named agent on its own role unless a role is given', async () => {
    assert.strictEqual('role' in (await run({ task: 'x', agentId: 'code-writer' })).seen[0].opts, false);
    assert.strictEqual((await run({ task: 'x', agentId: 'code-writer', role: 'main' })).seen[0].opts.role, 'main');
  });

  it('declares the role parameter', () => {
    assert.ok(BackgroundTaskTool.parameters.properties.role);
  });
});
```

In `tests/models-headless.test.js`, add inside `describe('headless agent runs', …)`, after the test `'a named model is an explicit target; a provider with no model takes the profile\'s model of it'`:

```js
  it('a model a sub-agent names must already be in the profile (M-D2)', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')], utility: [t(FAKE, 'utility-model')] });
    try {
      // In the profile, by bare id or provider/model: it runs, whichever role holds it.
      await adapter.execute(agent('code-explorer'), 'hello', { model: 'utility-model', requireInProfile: true });
      await adapter.execute(agent('code-explorer'), 'hello', { model: `${FAKE}/main-model`, requireInProfile: true });
      assert.deepStrictEqual(used, ['utility-model', 'main-model']);
      await assert.rejects(
        adapter.execute(agent('code-explorer'), 'hello', { model: 'named-model', requireInProfile: true }),
        (err) => err.code === 'MODEL_NOT_IN_PROFILE'
          && /named-model is not in the profile "Test profile"/.test(err.message)
          && err.message.includes(`${FAKE}/worker-model`)
      );
      assert.deepStrictEqual(used, ['utility-model', 'main-model'], 'a refused model is never called');
    } finally {
      await core.shutdown();
    }
  });

  it('a role the profile does not define fails naming the role', async () => {
    const { core, adapter } = await startCore({ main: [t(FAKE, 'main-model')] });
    try {
      await assert.rejects(adapter.execute(agent('main'), 'hello', { role: 'legal-drafting' }), /Unknown model role "legal-drafting"/);
    } finally {
      await core.shutdown();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/models-headless.test.js`
Expected: FAIL — `props.role` is undefined, `seen[0].opts.role` is undefined, `requireInProfile` is undefined, and the headless test runs `named-model` instead of refusing it.

- [ ] **Step 3: SpawnAgent names a role**

In `src/tools/builtin/spawn-agent-tool.js`, replace the `model` and `provider` properties in `parameters.properties`:

```js
      model: {
        type: 'string',
        description: 'Override the model for this sub-agent (e.g., "gemini-2.5-flash", "gpt-4o", "claude-sonnet-5"). Uses the agent default if not specified.'
      },
      provider: {
        type: 'string',
        description: 'Override the provider for this sub-agent (e.g., "openai", "anthropic", "gemini", "groq"). Uses default routing if not specified.'
      },
```

with

```js
      role: {
        type: 'string',
        description: 'Which model role runs the sub-agent: "worker" (the default for a plain task: cheaper, good at tool use), "utility" for small mechanical jobs, "main" for hard reasoning, or a custom role from Settings → Models. With agentId and no role, the agent\'s own role applies.'
      },
      model: {
        type: 'string',
        description: 'Rarely needed: one model already in this chat\'s profile, as "provider/model" or its id. Any other model is refused. Prefer role.'
      },
```

In `execute`, replace

```js
    if (params.model) {
      executeOptions.model = params.model;
    }
```

with

```js
    // The role (models spec 2026-09-27 §8): the parameter, else the named
    // agent's own role, else worker.
    const role = typeof params.role === 'string' && params.role.trim()
      ? params.role.trim()
      : (params.agentId ? null : 'worker');
    if (role) executeOptions.role = role;

    // A model the LLM names must already be in the turn's profile (M-D2);
    // the core checks it and refuses anything else.
    if (typeof params.model === 'string' && params.model.trim()) {
      executeOptions.model = params.model.trim();
      executeOptions.requireInProfile = true;
    }
```

Delete

```js
    // If a provider override is specified, pass it through
    if (params.provider) {
      executeOptions.provider = params.provider;
    }
```

and in the success return replace

```js
        model: params.model || agent.model,
```

with

```js
        role,
        model: lastCallModel(result),
```

Above `const SpawnAgentTool = new Tool({`, add:

```js
// The model that answered the child's last call, from its cost record.
function lastCallModel(result) {
  const calls = Array.isArray(result?.llm?.calls) ? result.llm.calls : [];
  return calls.length ? calls[calls.length - 1]?.model || null : null;
}
```

- [ ] **Step 4: BackgroundTask names a role**

In `src/tools/builtin/background-task-tool.js`, in `BackgroundTaskTool`'s `parameters.properties`, after `agentId`, add:

```js
      role: {
        type: 'string',
        description: 'Which model role runs the task: "worker" (the default for a plain task), "utility", "main", or a custom role from Settings → Models. With agentId and no role, the agent\'s own role applies.'
      },
```

In `execute`, after `const workingDirectory = options.workingDirectory || process.cwd();`, add:

```js
    // The role (models spec 2026-09-27 §8), by SpawnAgent's rule.
    const role = typeof params.role === 'string' && params.role.trim()
      ? params.role.trim()
      : (params.agentId ? null : 'worker');
```

and in the `agentExecutorAdapter.execute(agent, params.task, { … })` options object, after `maxIterations: 20,`, add:

```js
                ...(role ? { role } : {}),
```

- [ ] **Step 5: The core refuses a named model outside the profile**

In `src/core/create-core.js`, replace

```js
const { roleForAgent, CORE_ROLES } = require('../models/roles');
```

with

```js
const { roleForAgent, CORE_ROLES, BUILTIN_ROLES, targetKey, targetLabel } = require('../models/roles');
```

After the whole `const explicitTargetFor = (selection, turnModels, role) => { … };` block, add:

```js
  // A model an LLM names for a sub-agent (SpawnAgent, a planned workflow
  // task) must already be in the turn's profile (M-D2): the role's own
  // candidates, the main override, then any role's list. It may be named as
  // "provider/model", "provider:model" or a bare id. Owner-written targets
  // (case.yaml roles, a delegate's config) keep explicitTargetFor above.
  const profileTargetFor = (selection, turnModels, role) => {
    const provider = normalizeProvider(selection.provider || '');
    const wanted = String(selection.model || '').trim();
    if (!provider && !wanted) return null;
    const pool = [];
    const seen = new Set();
    const add = (x) => {
      const key = targetKey(x);
      if (seen.has(key)) return;
      seen.add(key);
      pool.push({ ...x });
    };
    turnModels.candidatesFor(role).forEach(add);
    if (turnModels.mainOverride) add(turnModels.mainOverride);
    [...BUILTIN_ROLES, ...profiles.customRoles().map((r) => r.id)]
      .forEach((r) => turnModels.configuredFor(r).forEach(add));
    const named = (x) => !wanted || x.model === wanted || `${x.provider}/${x.model}` === wanted || `${x.provider}:${x.model}` === wanted;
    const match = pool.find((x) => (!provider || x.provider === provider) && named(x));
    if (match) return match;
    const asked = provider ? `${provider}/${wanted || '(any model)'}` : wanted;
    const err = new Error(`${asked} is not in the profile "${turnModels.profileName}". A sub-agent may use only models placed in a role: ${pool.map(targetLabel).join(', ') || '(none)'}. Name a role instead.`);
    err.code = 'MODEL_NOT_IN_PROFILE';
    throw err;
  };
```

In `createAgentRuntime`, replace

```js
    const explicit = explicitTargetFor(sel, turnModels, role);
```

with

```js
    const explicit = sel.requireInProfile === true
      ? profileTargetFor(sel, turnModels, role)
      : explicitTargetFor(sel, turnModels, role);
```

In `agentExecutorAdapter.execute`, in the selection object passed to `createAgentRuntime`, after `...(options.model ? { model: options.model } : {})`, add:

```js
            ...(options.requireInProfile === true ? { requireInProfile: true } : {}),
```

(`normalizeProvider` is already required in `create-core.js`; `explainTarget` uses it.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/models-headless.test.js tests/chat-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/builtin/spawn-agent-tool.js src/tools/builtin/background-task-tool.js src/core/create-core.js tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/models-headless.test.js
git commit -m "feat(models): SpawnAgent and BackgroundTask run on a role; a named model must be in the profile"
```

---

## Task 2: The explorer, its summary cap, and main's delegation guidance

**Files:**
- Modify: `src/agents/builtin/code-explorer.js` (whole file), `templates/code-explorer.md.template` (whole file), `src/agents/agent-schema.js` (constructor), `src/tools/builtin/spawn-agent-tool.js` (`execute`), `src/core/settings.js` (`DEFAULT_SETTINGS.models` and the `models` merge), `src/context/system-sections.js` (export), `src/context/context-assembler.js` (`CORE_TOOLS`), `src/ipc/chat-handlers.js` (require; the system prompt, just before the `if (caseTurn) { options.systemPrompt = buildCaseSystemPrompt(…` block)
- Test: `tests/explorer-delegation.test.js` (new); run `tests/spawn-agent-tool.test.js`, `tests/chat-profiles.test.js`, `tests/models-headless.test.js`, `tests/core-settings.test.js`, `tests/planner-agent.test.js`

**Interfaces:**
- Consumes: SpawnAgent's `execute` (Task 1); `options.getSettings` in every tool's execution options (`extraToolOptions.getSettings`, `src/core/create-core.js`); `chatHarness` (`tests/helpers/chat-harness.js`).
- Produces:
  - `Agent#returnsSummary: boolean` (`src/agents/agent-schema.js`; default `false`).
  - `code-explorer`: name `'Explorer'`, `role: 'worker'`, `allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']`, `readOnly: true`, `returnsSummary: true`, no `model` or `inferenceTier`.
  - Settings `models.explorer: { summaryMaxTokens: 2000 }`, merged key by key.
  - SpawnAgent, for an agent with `returnsSummary`: adds `Answer with a summary of at most about <n> tokens. …` to the child's `systemPrompt`, and cuts `content` longer than `n × 4` characters, ending it with `\n\n[Summary cut at about <n> tokens.]`.
  - `DELEGATION_GUIDANCE` (string) exported by `src/context/system-sections.js`; prepended to `options.systemPrompt` in agent-mode, non-case chat turns.
  - `SpawnAgent` is in the context assembler's `CORE_TOOLS`.

- [ ] **Step 1: Write the failing tests**

Create `tests/explorer-delegation.test.js`:

```js
// tests/explorer-delegation.test.js
// The explorer and delegation (models spec 2026-09-27 §8.1): code-explorer
// is a read-only worker agent that returns a capped summary, and main's
// system prompt tells it to delegate reading and searching.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAgent } = require('../src/agents');
const { DELEGATION_GUIDANCE } = require('../src/context/system-sections');
const ContextAssembler = require('../src/context/context-assembler');
const SpawnAgentTool = require('../src/tools/builtin/spawn-agent-tool');
const { mergeSettings } = require('../src/core/settings');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

describe('the explorer', () => {
  it('is a read-only worker agent that returns a summary', () => {
    const explorer = getAgent('code-explorer');
    assert.strictEqual(explorer.name, 'Explorer');
    assert.strictEqual(explorer.role, 'worker');
    assert.deepStrictEqual(explorer.allowedTools, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    assert.strictEqual(explorer.readOnly, true);
    assert.strictEqual(explorer.returnsSummary, true);
    assert.strictEqual(explorer.canUseTool('Bash'), false);
    const template = fs.readFileSync(path.join(__dirname, '..', explorer.systemPromptTemplate), 'utf8');
    assert.doesNotMatch(template, /command-line|Bash/);
    assert.match(template, /paths or URLs/);
  });

  it('models.explorer.summaryMaxTokens defaults to 2000 and merges key by key', () => {
    assert.deepStrictEqual(mergeSettings({}).models.explorer, { summaryMaxTokens: 2000 });
    assert.deepStrictEqual(mergeSettings({ models: { explorer: { summaryMaxTokens: 500 } } }).models.explorer, { summaryMaxTokens: 500 });
  });
});

describe('SpawnAgent caps a summary', () => {
  const run = async (content, settings = {}) => {
    let seen = null;
    const result = await SpawnAgentTool.execute({ task: 'Find every caller of loadConfig', agentId: 'code-explorer' }, {
      agentExecutorAdapter: {
        execute: async (_agent, _msg, opts) => {
          seen = opts;
          return { type: 'complete', content, iterations: 1, tools: [], llm: { calls: [], totals: {} } };
        }
      },
      getAgent: (id) => getAgent(id),
      getSettings: () => settings
    });
    return { result, seen };
  };

  it('tells the explorer its budget and keeps a short answer whole', async () => {
    const { result, seen } = await run('src/config.js calls it twice.');
    assert.match(seen.systemPrompt, /at most about 2000 tokens/);
    assert.strictEqual(result.content, 'src/config.js calls it twice.');
  });

  it('cuts an answer over the cap, saying so', async () => {
    const { result } = await run('x'.repeat(1000), { models: { explorer: { summaryMaxTokens: 100 } } });
    assert.strictEqual(result.content.startsWith('x'.repeat(400)), true);
    assert.strictEqual(result.content.includes('x'.repeat(401)), false);
    assert.match(result.content, /\[Summary cut at about 100 tokens\.\]$/);
  });

  it('leaves an agent that returns no summary uncapped', async () => {
    let seen = null;
    const result = await SpawnAgentTool.execute({ task: 'Write it', agentId: 'code-writer' }, {
      agentExecutorAdapter: {
        execute: async (_a, _m, opts) => {
          seen = opts;
          return { type: 'complete', content: 'y'.repeat(20000), iterations: 1, tools: [] };
        }
      },
      getAgent: (id) => getAgent(id),
      getSettings: () => ({ models: { explorer: { summaryMaxTokens: 100 } } })
    });
    assert.strictEqual(result.content.length, 20000);
    assert.strictEqual(seen.systemPrompt, undefined);
  });
});

describe('main is told to delegate', () => {
  const capture = () => {
    const prompts = [];
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => { prompts.push(opts.systemPrompt); return { type: 'text', content: 'done' }; },
      streamMessage: async (_m, opts, onChunk) => { prompts.push(opts.systemPrompt); onChunk('done'); return {}; }
    };
    return { prompts, h: chatHarness({ provider }) };
  };

  it('puts the delegation guidance first in an agent-mode turn, before everything that changes', async () => {
    const { prompts, h } = capture();
    await h.send({ agentMode: true });
    assert.ok(prompts[0].startsWith(DELEGATION_GUIDANCE), prompts[0]);
    assert.ok(prompts[0].includes('BASE-PROMPT'));
    assert.match(DELEGATION_GUIDANCE, /SpawnAgent/);
    assert.match(DELEGATION_GUIDANCE, /code-explorer/);
  });

  it('leaves a plain chat turn without it', async () => {
    const { prompts, h } = capture();
    await h.send({ agentMode: false });
    assert.strictEqual(prompts[0].includes(DELEGATION_GUIDANCE), false);
  });

  it('keeps SpawnAgent among the always-loaded tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-'));
    try {
      const assembler = new ContextAssembler({ vectorStorePath: path.join(dir, 'vectors.json') });
      const def = (name) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } });
      await assembler.index([def('Read'), def('SpawnAgent'), def('CronCreate')], []);
      const assembled = await assembler.assemble('hi');
      assert.ok(assembled.tools.some((t) => t.name === 'SpawnAgent'));
      assert.ok(!assembled.availableToolNames.includes('SpawnAgent'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/explorer-delegation.test.js`
Expected: FAIL — the explorer is named "Code Explorer" with `Bash`, `DELEGATION_GUIDANCE` is undefined, `models.explorer` is undefined.

- [ ] **Step 3: The explorer agent and its template**

Replace the whole of `src/agents/builtin/code-explorer.js` with:

```js
const Agent = require('../agent-schema');

// The explorer (models spec 2026-09-27 §8.1): reads and searches files and
// web pages on the worker role and returns a short summary naming the paths
// or URLs it used, so main never pays for the raw text. Read-only. The id
// stays code-explorer: workflows, templates and tests name it.
const CodeExplorerAgent = new Agent({
  id: 'code-explorer',
  name: 'Explorer',
  description: 'Reads and searches files and web pages, then returns a short summary naming the paths or URLs it used',
  role: 'worker',
  voice: {
    enabled: false,
    engine: 'system',
    mode: 'summary',
    speed: 1.05
  },
  systemPromptTemplate: 'templates/code-explorer.md.template',
  allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  readOnly: true,
  returnsSummary: true,
  maxIterations: 20,
  systemPrompt: `You are an explorer. You read and search files and web pages for another agent and report what you found.
Use only Read, Glob, Grep, WebFetch and WebSearch. Never modify anything.
Answer with a short summary: the facts asked for, each with the file paths or URLs it came from.`
});

module.exports = CodeExplorerAgent;
```

Replace the whole of `templates/code-explorer.md.template` with:

```
You are {{agent.name}}, an explorer working for another agent.

Your job:
1. Read and search files (Read, Glob, Grep) and web pages (WebFetch, WebSearch) to answer the question you were given.
2. Report only what the sources say.
3. Answer with a short summary: each finding with the file paths or URLs it came from (with line numbers where they help), so the caller can read the exact text itself.

Constraints:
- You are read-only: never modify files.
- Keep the summary short; the caller pays for every word of it.

Agent metadata:
- Agent ID: {{agent.id}}
- Allowed tools: {{agent.allowedTools}}

{{> operating-principles}}
```

In `src/agents/agent-schema.js`, after

```js
    this.readOnly = config.readOnly === true;
```

add

```js
    // An agent whose answer is a summary for another agent (the explorer,
    // models spec 2026-09-27 §8.1): SpawnAgent caps it at
    // models.explorer.summaryMaxTokens.
    this.returnsSummary = config.returnsSummary === true;
```

- [ ] **Step 4: The summary cap in SpawnAgent**

In `src/tools/builtin/spawn-agent-tool.js`, above `const SpawnAgentTool = new Tool({`, add:

```js
const DEFAULT_SUMMARY_MAX_TOKENS = 2000;

// models.explorer.summaryMaxTokens (spec 2026-09-27 §14), else 2000.
function summaryMaxTokens(options) {
  let settings = {};
  try {
    settings = typeof options.getSettings === 'function' ? options.getSettings() || {} : {};
  } catch {
    settings = {};
  }
  const n = Number(settings.models?.explorer?.summaryMaxTokens);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SUMMARY_MAX_TOKENS;
}

// About four characters to a token; a longer summary is cut and says so.
function capSummary(text, maxTokens) {
  const s = String(text || '');
  const limit = maxTokens * 4;
  return s.length > limit ? `${s.slice(0, limit)}\n\n[Summary cut at about ${maxTokens} tokens.]` : s;
}
```

In `execute`, replace

```js
    if (params.systemPromptAppend) {
      executeOptions.systemPrompt = params.systemPromptAppend;
    }
```

with

```js
    // An agent that returns a summary (the explorer, spec §8.1) is told its
    // budget; a longer answer is cut below.
    const summaryCap = agent.returnsSummary ? summaryMaxTokens(options) : null;
    const promptParts = [];
    if (params.systemPromptAppend) promptParts.push(params.systemPromptAppend);
    if (summaryCap) {
      promptParts.push(`Answer with a summary of at most about ${summaryCap} tokens. Name the file paths or URLs you relied on (with line numbers where they help), so the caller can read the exact text itself.`);
    }
    if (promptParts.length) executeOptions.systemPrompt = promptParts.join('\n\n');
```

and in the success return replace

```js
        content: result.content || '',
```

with

```js
        content: summaryCap ? capSummary(result.content, summaryCap) : (result.content || ''),
```

- [ ] **Step 5: The `models.explorer` setting**

In `src/core/settings.js`, in `DEFAULT_SETTINGS.models`, replace

```js
    roleTimeoutsMs: { ...DEFAULT_ROLE_TIMEOUTS_MS }
  },
```

with

```js
    roleTimeoutsMs: { ...DEFAULT_ROLE_TIMEOUTS_MS },
    // The explorer's summary cap (spec §8.1).
    explorer: { summaryMaxTokens: 2000 }
  },
```

In `mergeSettings`, in the `models` merge, replace

```js
      roleTimeoutsMs: {
        ...DEFAULT_SETTINGS.models.roleTimeoutsMs,
        ...(source.models?.roleTimeoutsMs && typeof source.models.roleTimeoutsMs === 'object' && !Array.isArray(source.models.roleTimeoutsMs)
          ? source.models.roleTimeoutsMs
          : {})
      }
    },
```

with

```js
      roleTimeoutsMs: {
        ...DEFAULT_SETTINGS.models.roleTimeoutsMs,
        ...(source.models?.roleTimeoutsMs && typeof source.models.roleTimeoutsMs === 'object' && !Array.isArray(source.models.roleTimeoutsMs)
          ? source.models.roleTimeoutsMs
          : {})
      },
      explorer: {
        ...DEFAULT_SETTINGS.models.explorer,
        ...(source.models?.explorer && typeof source.models.explorer === 'object' && !Array.isArray(source.models.explorer)
          ? source.models.explorer
          : {})
      }
    },
```

- [ ] **Step 6: The delegation guidance**

In `src/context/system-sections.js`, replace

```js
module.exports = { buildSystemSections };
```

with

```js
// Main's delegation guidance (models spec 2026-09-27 §8.1). Stable text: the
// chat send path puts it first in an agent-mode turn's system prompt, so it
// stays in the cached prefix. Delegation is prompted, not forced.
const DELEGATION_GUIDANCE = [
  'Delegating reading and searching:',
  '- To read or search many files, or several web pages, call SpawnAgent with agentId "code-explorer" and one precise question. The explorer runs on a cheaper model with read-only tools (Read, Glob, Grep, WebFetch, WebSearch) and returns a short summary naming the file paths or URLs it used.',
  '- Read a file yourself only when you need its exact text, such as a passage to quote or the lines you are about to edit.'
].join('\n');

module.exports = { buildSystemSections, DELEGATION_GUIDANCE };
```

In `src/context/context-assembler.js`, in `CORE_TOOLS`, replace

```js
  'AskUser',
  'ToolSearch',
]);
```

with

```js
  'AskUser',
  'ToolSearch',
  // Delegation (models spec 2026-09-27 §8.1): main's prompt tells it to
  // hand reading and searching to the explorer, so SpawnAgent is always
  // loaded rather than one ToolSearch round away.
  'SpawnAgent',
]);
```

In `src/ipc/chat-handlers.js`, after

```js
const { sumLlmCalls } = require('../tracking/llm-totals');
```

add

```js
const { DELEGATION_GUIDANCE } = require('../context/system-sections');
```

and replace

```js
      if (caseTurn) {
        options.systemPrompt = buildCaseSystemPrompt(caseTurn.orientation, options.systemPrompt);
      }
```

with

```js
      // Main's delegation guidance (spec §8.1), first so it sits in the
      // stable, cached part of the prompt. Only where SpawnAgent can run:
      // agent mode, and never a case turn (SpawnAgent is refused there).
      if (agentMode && !caseTurn) {
        options.systemPrompt = `${DELEGATION_GUIDANCE}\n\n${options.systemPrompt}`;
      }

      if (caseTurn) {
        options.systemPrompt = buildCaseSystemPrompt(caseTurn.orientation, options.systemPrompt);
      }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/explorer-delegation.test.js tests/spawn-agent-tool.test.js tests/chat-profiles.test.js tests/models-headless.test.js tests/core-settings.test.js tests/planner-agent.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/agents/builtin/code-explorer.js templates/code-explorer.md.template src/agents/agent-schema.js src/tools/builtin/spawn-agent-tool.js src/core/settings.js src/context/system-sections.js src/context/context-assembler.js src/ipc/chat-handlers.js tests/explorer-delegation.test.js
git commit -m "feat(models): a read-only explorer on worker with a capped summary; main is told to delegate to it"
```

---

## Task 3: Every call records its role; usage totals by role and model

**Files:**
- Modify: `src/providers/inference-router.js` (`newRouteState`, a new `callTags`/`_stamp`, `routeTargets`, `routedProvider`), `src/providers/base-provider.js` (`buildLlmCallMetrics`), `src/tracking/usage-tracker.js` (whole file), `src/execution/agent-loop.js` (require; the stopped-call record; `_recordCall`), `src/cases/case-runtime.js` (`routedProvider`), `src/core/create-core.js` (`createUsageRecordFromMetrics`; `resolveRole`'s `routed`; `context.routedProvider`), `src/ipc/chat-handlers.js` (require; the turn's routed provider; the non-agent stopped call; the non-agent usage record), `tests/helpers/chat-harness.js` (`routedProvider`, `createUsageRecordFromMetrics`)
- Test: `tests/inference-router-targets.test.js` (describe added), `tests/usage-tracker.test.js` (describe added), `tests/models-provider-pricing.test.js` (one assertion added), `tests/agent-loop.test.js` (one test added), `tests/cases-roles.test.js` (one test added), `tests/chat-roles.test.js` (new); run `tests/chat-profiles.test.js`, `tests/chat-stop.test.js`, `tests/cases-chat.test.js`, `tests/cases-turn-runner.test.js`, `tests/cases-detour-classifier.test.js`, `tests/models-headless.test.js`

**Interfaces:**
- Consumes: `InferenceRouter#routeTargets(targets, messages, options, state)`, `#routedProvider({ targets, signal })` (M2); `BaseLLMProvider#usageForPricing(normalized)` (M1); `resolveCaseRole` picks (`{ caseRole, modelRole, targets, borrowedFrom }`, `src/cases/roles.js`); `TurnModels.profileId`.
- Produces:
  - `InferenceRouter#newRouteState(tags = null)`; `tags = { role, profileId, borrowedFrom, caseRole? }`. `InferenceRouter#callTags(state) → { role, profileId, borrowedFrom, failover, caseRole? }` (`{}` for an untagged state). A tagged route stamps these onto every answered call's `llmMetrics` and onto a stopped call's `err.partialLlmMetrics`; `failover` is `state.index > 0`.
  - `InferenceRouter#routedProvider({ targets, signal = null, meta = null })`; the returned object gains `callTags()`.
  - `context.routedProvider({ targets, signal, meta })` (`src/core/create-core.js`) forwards `meta`. `resolveRole(role, …)`'s `routed` carries `{ role, profileId, borrowedFrom }`.
  - `CaseRuntime#routedProvider(turn, { role })` tags `{ role: <model role>, caseRole: <case role>, borrowedFrom, profileId }`; `(turn, { targets, meta })` tags `{ role: 'main', borrowedFrom: null, ...meta, profileId }`; the returned object gains `callTags()`.
  - `llmMetrics.pricingUsage = { input, cachedInput, cacheWrite, output, reasoning }` on every provider call (`BaseLLMProvider#buildLlmCallMetrics`).
  - `UsageTracker(store, { now = () => new Date() })`; `UsageTracker.eventFromMetrics(metrics, durationMs = 0) → { provider, model, inputTokens, outputTokens, totalTokens, cacheReadTokens, costUsd, role?, pricingUsage?, usagePartial?, durationMs }`; session and daily usage gain `roles: { [role]: totals & { usage } }` (a call with no role counts under `'other'`) and `models: { 'provider:model': totals }`; every totals object gains `unpricedCalls`; `record()`'s return gains `role`; `UsageTracker#recentRoleUsage({ days = 30 }) → { [role]: { calls, unpricedCalls, cost, usage: { input, cachedInput, cacheWrite, output, reasoning } } }`.

- [ ] **Step 1: Write the failing tests**

In `tests/inference-router-targets.test.js`, add at the end of the file:

```js
describe('cost tags on routed calls (spec 2026-09-27 §10)', () => {
  it('stamps role, profile, borrow and failover on each call it answers', async () => {
    const { router } = harness({ 'groq/llama': [unknownFailure()] });
    const routed = router.routedProvider({ targets: [t('groq', 'llama'), t('openai', 'gpt-5.5')], meta: { role: 'utility', profileId: 'p-1', borrowedFrom: 'worker' } });
    const res = await routed.sendMessageWithTools([{ role: 'user', content: 'hi' }], [{ name: 'Read' }], {});
    assert.deepStrictEqual(
      [res.llmMetrics.role, res.llmMetrics.profileId, res.llmMetrics.borrowedFrom, res.llmMetrics.failover, res.llmMetrics.model],
      ['utility', 'p-1', 'worker', true, 'gpt-5.5']
    );
    assert.deepStrictEqual(routed.callTags(), { role: 'utility', profileId: 'p-1', borrowedFrom: 'worker', failover: true });
  });

  it('marks the first target\'s answer as no failover', async () => {
    const { router } = harness();
    const routed = router.routedProvider({ targets: [t('openai', 'gpt-5.5')], meta: { role: 'main', profileId: 'p-1' } });
    const res = await routed.sendMessage([{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(res.llmMetrics.failover, false);
    assert.strictEqual(res.llmMetrics.borrowedFrom, null);
  });

  it('stamps a stopped call\'s partial usage too', async () => {
    const controller = new AbortController();
    const stopped = () => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      err.partialLlmMetrics = { provider: 'openai', model: 'gpt-5.5', inputTokens: 40, usagePartial: true };
      throw err;
    };
    const { router } = harness({ 'openai/gpt-5.5': [stopped] });
    const routed = router.routedProvider({ targets: [t('openai', 'gpt-5.5')], signal: controller.signal, meta: { role: 'main', profileId: 'p-1' } });
    await assert.rejects(routed.sendMessage([{ role: 'user', content: 'hi' }], {}), (err) => err.partialLlmMetrics.role === 'main' && err.partialLlmMetrics.usagePartial === true);
  });

  it('leaves a route built without tags as it was', async () => {
    const { router } = harness();
    const res = await router.routeTargets([t('openai', 'gpt-5.5')], [{ role: 'user', content: 'hi' }]);
    assert.deepStrictEqual(res.llmMetrics, { provider: 'openai', model: 'gpt-5.5' });
  });
});
```

In `tests/usage-tracker.test.js`, add at the end of the file:

```js
describe('UsageTracker by role and model (spec 2026-09-27 §10)', () => {
  const memoryStore = () => ({
    data: {},
    get(key, fallbackValue = null) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallbackValue; },
    set(key, value) { this.data[key] = value; }
  });

  it('totals by role and by model, counting unpriced calls instead of adding $0', () => {
    const tracker = new UsageTracker(memoryStore());
    tracker.record({ provider: 'openai', model: 'gpt-5.5', role: 'main', inputTokens: 100, outputTokens: 10, costUsd: 0.02 });
    tracker.record({ provider: 'openai', model: 'gpt-5.4-mini', role: 'worker', inputTokens: 50, outputTokens: 5, costUsd: null });
    tracker.record({ provider: 'openai', model: 'gpt-5.4-mini', inputTokens: 5, outputTokens: 1, costUsd: 0.001 });
    const s = tracker.getSessionUsage();
    assert.deepStrictEqual([s.roles.main.totalCost, s.roles.main.turns, s.roles.main.unpricedCalls], [0.02, 1, 0]);
    assert.deepStrictEqual([s.roles.worker.totalCost, s.roles.worker.unpricedCalls], [0, 1]);
    assert.strictEqual(s.roles.other.turns, 1);
    assert.deepStrictEqual([s.models['openai:gpt-5.4-mini'].turns, s.models['openai:gpt-5.4-mini'].unpricedCalls], [2, 1]);
    assert.strictEqual(s.unpricedCalls, 1);
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(tracker.getDailyUsage(today).roles.worker.unpricedCalls, 1);
  });

  it('builds the event from a call\'s metrics, role and priceable usage included', () => {
    const e = UsageTracker.eventFromMetrics({
      provider: 'openai', model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 60,
      costUsd: 0.01, role: 'main', profileId: 'p-1',
      pricingUsage: { input: 40, cachedInput: 60, cacheWrite: 0, output: 10, reasoning: 0 }
    }, 25);
    assert.deepStrictEqual(e, {
      provider: 'openai', model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60,
      costUsd: 0.01, role: 'main', pricingUsage: { input: 40, cachedInput: 60, cacheWrite: 0, output: 10, reasoning: 0 }, durationMs: 25
    });
    assert.strictEqual(UsageTracker.eventFromMetrics({ costUsd: null }).costUsd, null);
  });

  it('sums the last 30 days by role, with the priceable parts', () => {
    let now = new Date('2026-09-27T12:00:00Z');
    const tracker = new UsageTracker(memoryStore(), { now: () => now });
    const call = (role, costUsd, input) => tracker.record({
      provider: 'openai', model: 'm', role, inputTokens: input, outputTokens: 1, costUsd,
      pricingUsage: { input, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 }
    });
    call('utility', 0.01, 1000);
    now = new Date('2026-09-10T12:00:00Z');
    call('utility', 0.02, 2000);
    now = new Date('2026-08-01T12:00:00Z'); // outside the window
    call('utility', 5, 99999);
    now = new Date('2026-09-27T12:00:00Z');
    call('main', null, 10);
    const recent = tracker.recentRoleUsage({ days: 30 });
    assert.deepStrictEqual(recent.utility, { calls: 2, unpricedCalls: 0, cost: 0.03, usage: { input: 3000, cachedInput: 0, cacheWrite: 0, output: 2, reasoning: 0 } });
    assert.deepStrictEqual([recent.main.calls, recent.main.unpricedCalls, recent.main.cost], [1, 1, 0]);
  });
});
```

In `tests/models-provider-pricing.test.js`, in `it('prices an OpenAI chat call with cached input at the catalog rates', …)`, after `assert.strictEqual(m.cachedInputTokens, 39552);` add:

```js
    // The priceable parts travel with the call, for repricing (spec §7.2).
    assert.deepStrictEqual(m.pricingUsage, { input: 3641, cachedInput: 39552, cacheWrite: 0, output: 185, reasoning: 0 });
```

In `tests/agent-loop.test.js`, inside the outermost `describe('AgentLoop', …)`, add:

```js
  it('records each call with its role and priceable usage (models spec §10)', async () => {
    const recorded = [];
    const provider = {
      sendMessageWithTools: async () => ({
        type: 'text',
        content: 'done',
        llmMetrics: { provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.001, role: 'worker', pricingUsage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 2, reasoning: 0 } }
      })
    };
    const loop = new AgentLoop(provider, okExecutor(), { usageTracker: { record: (e) => { recorded.push(e); return e; } } });
    await loop.run([{ role: 'user', content: 'hi' }], []);
    assert.deepStrictEqual([recorded[0].role, recorded[0].pricingUsage.input, recorded[0].costUsd], ['worker', 10, 0.001]);
  });
```

In `tests/cases-roles.test.js`, inside `describe('CaseRuntime model roles', …)`, add:

```js
  it('tags a case role call with its model role, case role and profile (models spec §10)', async () => {
    const InferenceRouter = require('../src/providers/inference-router');
    const router = new InferenceRouter({
      getProviderToken: () => 'test-token',
      createProvider: (p) => ({ sendMessageWithTools: async (_m, _t, opts) => ({ type: 'text', content: 'ok', llmMetrics: { provider: p, model: opts.model } }) })
    });
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { inferenceRouter: router } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const turn = { caseId: info.id, signal: null, models: rt.modelsFor(info.id) };
    const reply = await rt.routedProvider(turn, { role: 'orient' }).sendMessageWithTools([{ role: 'user', content: 'hi' }], [{ name: 'Read' }], {});
    assert.deepStrictEqual(
      [reply.llmMetrics.role, reply.llmMetrics.caseRole, reply.llmMetrics.profileId, reply.llmMetrics.model, reply.llmMetrics.failover],
      ['utility', 'orient', 'p-test', 'llama-3.3-70b', false]
    );
  });
```

Create `tests/chat-roles.test.js`:

```js
// tests/chat-roles.test.js
// Roles on the chat send path (models spec 2026-09-27 §8, §10): each call
// of a reply records its role; later tasks add the sub-agent roll-up,
// titles on utility and the advisor's usage.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const metricsFor = (model, costUsd = 0.001) => ({ provider: 'openai', model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd });

describe('cost tags on a chat turn', () => {
  it('each call of the reply carries its role and profile, and the usage record its role', async () => {
    const provider = {
      streamMessage: async (_m, opts, onChunk) => { onChunk('Hello'); return { llmMetrics: metricsFor(opts.model) }; }
    };
    const h = chatHarness({ provider });
    await h.send({ agentMode: false });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual([reply.llm.calls[0].role, reply.llm.calls[0].profileId, reply.llm.calls[0].failover], ['main', 'p-test', false]);
    assert.strictEqual(h.usage[0].role, 'main');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/inference-router-targets.test.js tests/usage-tracker.test.js tests/models-provider-pricing.test.js tests/agent-loop.test.js tests/cases-roles.test.js tests/chat-roles.test.js`
Expected: FAIL — `routed.callTags` is not a function, `res.llmMetrics.role` is undefined, `s.roles` is undefined, `UsageTracker.eventFromMetrics` is not a function, `m.pricingUsage` is undefined.

- [ ] **Step 3: The router stamps its tags**

In `src/providers/inference-router.js`, replace

```js
  newRouteState() {
    return { index: 0, answered: false, instances: new Map(), lastInstance: null };
  }
```

with

```js
  newRouteState(tags = null) {
    return {
      index: 0,
      answered: false,
      instances: new Map(),
      lastInstance: null,
      tags: tags && typeof tags === 'object' ? { ...tags } : null
    };
  }

  // Cost records (spec 2026-09-27 §10): the role, profile and borrow a call
  // ran under, and whether a failover target (not the list's first)
  // answered. Only a route built with tags has them.
  callTags(state) {
    if (!state || !state.tags) return {};
    const { role = null, profileId = null, borrowedFrom = null, caseRole = null } = state.tags;
    return { role, profileId, borrowedFrom, failover: state.index > 0, ...(caseRole ? { caseRole } : {}) };
  }

  _stamp(metrics, state) {
    if (!state?.tags || !metrics || typeof metrics !== 'object') return metrics;
    return { ...metrics, ...this.callTags(state) };
  }
```

In `routeTargets`, replace

```js
        const response = await this.executeTarget(instance, target, payload, attemptOptions);
        state.answered = true;
        state.lastInstance = instance;
        return response;
      } catch (err) {
        if (options.abortSignal?.aborted) throw err;
```

with

```js
        const response = await this.executeTarget(instance, target, payload, attemptOptions);
        state.answered = true;
        state.lastInstance = instance;
        if (response && typeof response === 'object' && response.llmMetrics) {
          response.llmMetrics = this._stamp(response.llmMetrics, state);
        }
        return response;
      } catch (err) {
        if (options.abortSignal?.aborted) {
          // A stopped call's partial usage is recorded too (spec §9), tagged.
          if (err && typeof err === 'object' && err.partialLlmMetrics) err.partialLlmMetrics = this._stamp(err.partialLlmMetrics, state);
          throw err;
        }
```

In `routedProvider`, replace

```js
  routedProvider({ targets, signal = null } = {}) {
```

with

```js
  routedProvider({ targets, signal = null, meta = null } = {}) {
```

replace

```js
    const state = this.newRouteState();
```

with

```js
    const state = this.newRouteState(meta);
```

and in the `provider` object, after `getDefaultModel: () => current().model,`, add:

```js
      callTags: () => this.callTags(state),
```

- [ ] **Step 4: Each call carries its priceable usage**

In `src/providers/base-provider.js`, in `buildLlmCallMetrics`, replace

```js
    return {
      provider,
      model: normalizedModel,
      ...normalizedUsage,
      costUsd,
```

with

```js
    return {
      provider,
      model: normalizedModel,
      ...normalizedUsage,
      // The catalog's usage shape, so a call can be repriced on another
      // model (the King Louie profile's cost effect, spec §7.2).
      pricingUsage: this.usageForPricing(normalizedUsage),
      costUsd,
```

- [ ] **Step 5: UsageTracker by role and model**

Replace the whole of `src/tracking/usage-tracker.js` with:

```js
// UsageTracker totals what each call recorded. It never prices a call: the
// cost comes from the provider's catalog-priced metrics (spec 2026-09-27
// §4.4). A call without a known cost counts its tokens and no dollars, and
// counts as unpriced (§10). Totals are kept by provider, by role and by
// model ("provider:model"); role totals also keep the priceable usage, so
// the King Louie profile can reprice recent calls (§7.2).
const USAGE_PARTS = Object.freeze(['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning']);
const OTHER_ROLE = 'other';

const createTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  turns: 0,
  unpricedCalls: 0
});
const createUsage = () => Object.fromEntries(USAGE_PARTS.map((k) => [k, 0]));
const createRoleTotals = () => ({ ...createTotals(), usage: createUsage() });

const recordedCost = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

class UsageTracker {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.sessionUsage = UsageTracker.emptyUsage();
  }

  static emptyUsage() {
    return { ...createTotals(), providers: {}, roles: {}, models: {} };
  }

  // One call's metrics (llmMetrics, as providers and the router build them)
  // as the event record() takes.
  static eventFromMetrics(metrics = {}, durationMs = 0) {
    const m = metrics && typeof metrics === 'object' ? metrics : {};
    const pricing = m.pricingUsage && typeof m.pricingUsage === 'object' ? m.pricingUsage : null;
    return {
      provider: m.provider,
      model: m.model,
      inputTokens: Number(m.inputTokens) || 0,
      outputTokens: Number(m.outputTokens) || 0,
      totalTokens: Number(m.totalTokens) || 0,
      cacheReadTokens: Number(m.cachedInputTokens) || 0,
      costUsd: recordedCost(m.costUsd),
      ...(typeof m.role === 'string' && m.role ? { role: m.role } : {}),
      ...(pricing ? { pricingUsage: Object.fromEntries(USAGE_PARTS.map((k) => [k, positive(pricing[k])])) } : {}),
      ...(m.usagePartial ? { usagePartial: true } : {}),
      durationMs: Number(durationMs) || 0
    };
  }

  static normalizeDate(date = null) {
    if (!date) {
      return new Date().toISOString().slice(0, 10);
    }

    if (date instanceof Date) {
      return date.toISOString().slice(0, 10);
    }

    const normalized = String(date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return normalized;
    }

    return new Date(normalized).toISOString().slice(0, 10);
  }

  ensureProviderTotals(collection, provider) {
    const providerKey = String(provider || 'unknown').trim().toLowerCase() || 'unknown';
    if (!collection[providerKey]) {
      collection[providerKey] = createTotals();
    }

    return { key: providerKey, totals: collection[providerKey] };
  }

  applyToTotals(totals, event, resolvedCost = null) {
    const inputTokens = Number(event?.inputTokens) || 0;
    const outputTokens = Number(event?.outputTokens) || 0;
    const cacheReadTokens = Number(event?.cacheReadTokens) || 0;
    const totalTokens = Number(event?.totalTokens) || (inputTokens + outputTokens + cacheReadTokens);
    const cost = resolvedCost === null ? 0 : Number(resolvedCost) || 0;

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.totalTokens += totalTokens;
    totals.totalCost = Number((totals.totalCost + cost).toFixed(8));
    totals.turns += 1;
    if (resolvedCost === null) totals.unpricedCalls = (Number(totals.unpricedCalls) || 0) + 1;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      cost: resolvedCost
    };
  }

  // The provider, role and model breakdowns of one usage record.
  _applyBreakdowns(target, { provider, role, modelKey }, event, cost) {
    this.applyToTotals(this.ensureProviderTotals(target.providers, provider || 'unknown').totals, event, cost);
    const prevRole = target.roles[role];
    const roleTotals = prevRole
      ? { ...createRoleTotals(), ...prevRole, usage: { ...createUsage(), ...(prevRole.usage || {}) } }
      : createRoleTotals();
    this.applyToTotals(roleTotals, event, cost);
    if (event.pricingUsage) {
      for (const k of USAGE_PARTS) roleTotals.usage[k] += positive(event.pricingUsage[k]);
    }
    target.roles[role] = roleTotals;
    const modelTotals = target.models[modelKey] ? { ...createTotals(), ...target.models[modelKey] } : createTotals();
    this.applyToTotals(modelTotals, event, cost);
    target.models[modelKey] = modelTotals;
  }

  record(event = {}) {
    const provider = String(event.provider || '').trim().toLowerCase();
    const model = String(event.model || '').trim();
    const role = typeof event.role === 'string' && event.role.trim() ? event.role.trim() : OTHER_ROLE;
    const modelKey = `${provider || 'unknown'}:${model || 'unknown'}`;
    const resolvedCost = recordedCost(event.costUsd);

    const applied = this.applyToTotals(this.sessionUsage, event, resolvedCost);
    this._applyBreakdowns(this.sessionUsage, { provider, role, modelKey }, event, resolvedCost);

    const dailyKey = `usage.daily.${UsageTracker.normalizeDate(this.now())}`;
    const existingDaily = this.store.get(dailyKey, UsageTracker.emptyUsage());
    const daily = {
      ...UsageTracker.emptyUsage(),
      ...existingDaily,
      providers: { ...(existingDaily?.providers || {}) },
      roles: { ...(existingDaily?.roles || {}) },
      models: { ...(existingDaily?.models || {}) }
    };

    this.applyToTotals(daily, event, resolvedCost);
    this._applyBreakdowns(daily, { provider, role, modelKey }, event, resolvedCost);
    this.store.set(dailyKey, daily);

    return {
      provider,
      model,
      role,
      ...applied,
      ...(event.usagePartial ? { usagePartial: true } : {}),
      durationMs: Number(event.durationMs) || 0
    };
  }

  // The last `days` days of recorded usage by role, today included (the King
  // Louie profile's cost effect, spec §7.2).
  recentRoleUsage({ days = 30 } = {}) {
    const out = {};
    const nowMs = this.now().getTime();
    for (let i = 0; i < days; i += 1) {
      const daily = this.store.get(`usage.daily.${UsageTracker.normalizeDate(new Date(nowMs - i * 86400000))}`, null);
      for (const [role, t] of Object.entries(daily?.roles || {})) {
        const acc = out[role] || (out[role] = { calls: 0, unpricedCalls: 0, cost: 0, usage: createUsage() });
        acc.calls += Number(t.turns) || 0;
        acc.unpricedCalls += Number(t.unpricedCalls) || 0;
        acc.cost = Number((acc.cost + (Number(t.totalCost) || 0)).toFixed(8));
        for (const k of USAGE_PARTS) acc.usage[k] += positive(t.usage?.[k]);
      }
    }
    return out;
  }

  getSessionUsage() {
    return {
      ...this.sessionUsage,
      providers: { ...(this.sessionUsage.providers || {}) },
      roles: { ...(this.sessionUsage.roles || {}) },
      models: { ...(this.sessionUsage.models || {}) }
    };
  }

  getDailyUsage(date = null) {
    const key = `usage.daily.${UsageTracker.normalizeDate(date)}`;
    const daily = this.store.get(key, null);
    if (!daily) return null;
    return {
      ...daily,
      providers: { ...(daily.providers || {}) },
      roles: { ...(daily.roles || {}) },
      models: { ...(daily.models || {}) }
    };
  }

  reset() {
    this.sessionUsage = UsageTracker.emptyUsage();
  }
}

module.exports = UsageTracker;
```

- [ ] **Step 6: The agent loop records role and usage**

In `src/execution/agent-loop.js`, after

```js
const { sumLlmCalls } = require('../tracking/llm-totals');
```

add

```js
const UsageTracker = require('../tracking/usage-tracker');
```

Replace

```js
          if (this.abortSignal?.aborted) {
            this._recordCall(partialMetricsOf(err, {
              provider: this.provider?.getProviderName?.() || null,
              model: effectiveOptions.model || null
            }), llmCalls);
            return this._stoppedResult(iterations, executedTools, llmCalls);
          }
```

with

```js
          if (this.abortSignal?.aborted) {
            // A routed provider already tagged a partial it attached; one
            // cut off before any response gets the route's tags here.
            const tags = !err?.partialLlmMetrics && typeof this.provider?.callTags === 'function' ? this.provider.callTags() : {};
            this._recordCall({
              ...partialMetricsOf(err, {
                provider: this.provider?.getProviderName?.() || null,
                model: effectiveOptions.model || null
              }),
              ...tags
            }, llmCalls);
            return this._stoppedResult(iterations, executedTools, llmCalls);
          }
```

In `_recordCall`, replace

```js
      const usageEvent = this.usageTracker.record({
        provider: metrics.provider,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        totalTokens: metrics.totalTokens,
        costUsd: metrics.costUsd,
        ...(metrics.usagePartial ? { usagePartial: true } : {})
      });
```

with

```js
      const usageEvent = this.usageTracker.record(UsageTracker.eventFromMetrics(metrics));
```

- [ ] **Step 7: Case calls are tagged**

In `src/cases/case-runtime.js`, in `routedProvider(turn, spec = {})`, replace

```js
    let targets;
    if (Array.isArray(spec.targets) && spec.targets.length) targets = spec.targets;
    else if (spec.target && spec.target.provider) targets = [spec.target];
    else if (spec.role) targets = this.roleModel(turn.caseId, spec.role, { turn }).targets;
    else throw new Error('A routed provider needs a role or targets.');
    const list = targets.map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model || ''), effort: x.effort || null }));
    const state = typeof router.newRouteState === 'function' ? router.newRouteState() : undefined;
```

with

```js
    // Cost records (models spec §10): a case role's calls carry its model
    // role and case role; the owner turn's main list carries main.
    let targets;
    let tags = null;
    if (Array.isArray(spec.targets) && spec.targets.length) {
      targets = spec.targets;
      tags = { role: 'main', borrowedFrom: null, ...(spec.meta && typeof spec.meta === 'object' ? spec.meta : {}) };
    } else if (spec.target && spec.target.provider) {
      targets = [spec.target];
    } else if (spec.role) {
      const pick = this.roleModel(turn.caseId, spec.role, { turn });
      targets = pick.targets;
      tags = { role: pick.modelRole, caseRole: spec.role, borrowedFrom: pick.borrowedFrom || null };
    } else {
      throw new Error('A routed provider needs a role or targets.');
    }
    if (tags) tags.profileId = turn.models?.profileId || null;
    const list = targets.map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model || ''), effort: x.effort || null }));
    const state = typeof router.newRouteState === 'function' ? router.newRouteState(tags) : undefined;
```

and in the returned object, after `current,`, add:

```js
      callTags: () => (typeof router.callTags === 'function' ? router.callTags(state) : {}),
```

- [ ] **Step 8: The core and the chat send path pass their tags**

In `src/core/create-core.js`, replace

```js
  const createUsageRecordFromMetrics = (metrics = {}, durationMs = 0) => ({
    provider: metrics.provider,
    model: metrics.model,
    inputTokens: Number(metrics.inputTokens) || 0,
    outputTokens: Number(metrics.outputTokens) || 0,
    totalTokens: Number(metrics.totalTokens) || 0,
    costUsd: typeof metrics.costUsd === 'number' && Number.isFinite(metrics.costUsd) ? metrics.costUsd : null,
    ...(metrics.usagePartial ? { usagePartial: true } : {}),
    durationMs: Number(durationMs) || 0
  });
```

with

```js
  // One call's metrics as a usage record, its role included (spec §10).
  const createUsageRecordFromMetrics = (metrics = {}, durationMs = 0) => UsageTracker.eventFromMetrics(metrics, durationMs);
```

In `resolveRole`, replace

```js
      routed: inferenceRouter.routedProvider({ targets: resolved.targets }),
```

with

```js
      routed: inferenceRouter.routedProvider({
        targets: resolved.targets,
        meta: { role, profileId: models.profileId || null, borrowedFrom: resolved.borrowedFrom || null }
      }),
```

In `context`, replace

```js
    routedProvider: ({ targets, signal = null } = {}) => inferenceRouter.routedProvider({ targets, signal }),
```

with

```js
    routedProvider: ({ targets, signal = null, meta = null } = {}) => inferenceRouter.routedProvider({ targets, signal, meta }),
```

In `src/ipc/chat-handlers.js`, after

```js
const { sumLlmCalls } = require('../tracking/llm-totals');
```

add

```js
const UsageTracker = require('../tracking/usage-tracker');
```

Replace

```js
      const provider = caseTurn
        ? caseRuntime.routedProvider(caseTurn, { targets: main.targets })
        : createRoutedProvider({ targets: main.targets, signal: abortController.signal });
```

with

```js
      const provider = caseTurn
        ? caseRuntime.routedProvider(caseTurn, { targets: main.targets, meta: { role: 'main', borrowedFrom: null } })
        : createRoutedProvider({
          targets: main.targets,
          signal: abortController.signal,
          meta: { role: 'main', profileId: turnModels.profileId || null, borrowedFrom: null }
        });
```

Replace

```js
            const at = typeof provider.current === 'function' ? provider.current() : mainTarget;
            streamResult = { llmMetrics: partialMetricsOf(err, { provider: at.provider, model: at.model }) };
```

with

```js
            const at = typeof provider.current === 'function' ? provider.current() : mainTarget;
            const tags = !err?.partialLlmMetrics && typeof provider.callTags === 'function' ? provider.callTags() : {};
            streamResult = { llmMetrics: { ...partialMetricsOf(err, { provider: at.provider, model: at.model }), ...tags } };
```

Replace

```js
              typeof createUsageRecordFromMetrics === 'function'
                ? createUsageRecordFromMetrics(singleCall, 0)
                : {
                    provider: singleCall.provider,
                    model: singleCall.model,
                    inputTokens: singleCall.inputTokens,
                    outputTokens: singleCall.outputTokens,
                    totalTokens: singleCall.totalTokens,
                    costUsd: singleCall.costUsd
                  }
```

with

```js
              typeof createUsageRecordFromMetrics === 'function'
                ? createUsageRecordFromMetrics(singleCall, 0)
                : UsageTracker.eventFromMetrics(singleCall)
```

In `tests/helpers/chat-harness.js`, after

```js
const { createTurnModels } = require('../../src/models/resolver');
```

add

```js
const UsageTracker = require('../../src/tracking/usage-tracker');
```

replace

```js
    routedProvider: ({ targets, signal }) => new InferenceRouter({
      getProviderToken: () => 'test-token-123456',
      createProvider: (p) => (providers && providers[p]) || provider,
      sleep: async () => {},
      onProviderError: (p, err) => ctx.reportProviderError(p, err)
    }).routedProvider({ targets, signal }),
```

with

```js
    routedProvider: ({ targets, signal, meta }) => new InferenceRouter({
      getProviderToken: () => 'test-token-123456',
      createProvider: (p) => (providers && providers[p]) || provider,
      sleep: async () => {},
      onProviderError: (p, err) => ctx.reportProviderError(p, err)
    }).routedProvider({ targets, signal, meta }),
```

and replace

```js
    createUsageRecordFromMetrics: (m) => ({
      provider: m.provider,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : null,
      ...(m.usagePartial ? { usagePartial: true } : {})
    }),
```

with

```js
    createUsageRecordFromMetrics: (m) => UsageTracker.eventFromMetrics(m),
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/inference-router-targets.test.js tests/usage-tracker.test.js tests/models-provider-pricing.test.js tests/agent-loop.test.js tests/cases-roles.test.js tests/chat-roles.test.js tests/chat-profiles.test.js tests/chat-stop.test.js tests/cases-chat.test.js tests/cases-turn-runner.test.js tests/cases-detour-classifier.test.js tests/models-headless.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/providers/inference-router.js src/providers/base-provider.js src/tracking/usage-tracker.js src/execution/agent-loop.js src/cases/case-runtime.js src/core/create-core.js src/ipc/chat-handlers.js tests/helpers/chat-harness.js tests/inference-router-targets.test.js tests/usage-tracker.test.js tests/models-provider-pricing.test.js tests/agent-loop.test.js tests/cases-roles.test.js tests/chat-roles.test.js
git commit -m "feat(models): every call records its role, profile and failover; usage totals by role and model"
```

---

## Task 4: Sub-agent calls roll up into the reply; the per-role cost line

**Files:**
- Modify: `src/tracking/llm-totals.js` (add `costByRole`, `summarizeTurnLlm`), `src/execution/tool-executor.js` (constructor; `_rethreadedRequester`), `src/tools/builtin/spawn-agent-tool.js` (report the child's calls), `src/tools/builtin/background-task-tool.js` (`detached: true`), `src/core/create-core.js` (`createToolExecutorWithApprovals`'s `ToolExecutor` options; `createAgentRuntime`'s executor options; `agentExecutorAdapter.execute`'s runtime options), `src/ipc/chat-handlers.js` (require; the turn's llm record; the executor options), `renderer.js` (a new `formatRoleCosts` after `formatCompactUsd`; `addMessage`'s metrics line)
- Test: `tests/llm-totals.test.js` (new), `tests/tool-executor.test.js` (describe added), `tests/spawn-agent-tool.test.js` (test added), `tests/background-task-role.test.js` (assertion added), `tests/chat-roles.test.js` (describe added), `tests/chat-profiles.test.js` (the fake child reports usage; one test added), `tests/renderer-models-m3.test.js` (new); run `tests/chat-stop.test.js`, `tests/explorer-delegation.test.js`

**Interfaces:**
- Consumes: tagged `llmMetrics` (`role`, `profileId`, `failover`, `borrowedFrom`, Task 3); `sumLlmCalls(calls)` (`src/tracking/llm-totals.js`); `ToolExecutor#_rethreadedRequester()`; SpawnAgent's `role` (Task 1).
- Produces:
  - `costByRole(calls) → { [role]: { calls, totalTokens, costUsd, unpriced?, partial? } }` (a call with no role counts as `'other'`).
  - `summarizeTurnLlm({ calls, subagents }) → { calls, totals, subagents?, byRole? }`: `calls` is the parent's own; `subagents` is `[{ agentId, role, calls, totals }]` (omitted when there were none); `totals` and `byRole` cover both (`byRole` omitted when there are no calls).
  - `ToolExecutor({ onSubagentLlm })`; the rethreaded requester carries `onSubagentLlm`. `createToolExecutorWithApprovals(…, { onSubagentLlm })`, `createAgentRuntime(…, …, …, { onSubagentLlm })`.
  - SpawnAgent calls `options.approvalRequester.onSubagentLlm({ agentId, role, calls, totals })` once per child run that made calls. BackgroundTask passes `detached: true`, and `agentExecutorAdapter.execute` hands a detached run no `onSubagentLlm` (its calls outlive the turn).
  - Renderer: `formatRoleCosts(byRole) → ' · main $0.09 · worker $0.02 · utility $0.01'` (core roles first, then others sorted; an unpriced role's cost gets a trailing `+`).

- [ ] **Step 1: Write the failing tests**

Create `tests/llm-totals.test.js`:

```js
// tests/llm-totals.test.js
// A reply's llm record (models spec 2026-09-27 §10): the parent's own calls,
// each sub-agent run, and totals by role over both.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { summarizeTurnLlm, costByRole } = require('../src/tracking/llm-totals');

const call = (role, costUsd, extra = {}) => ({ provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd, ...(role ? { role } : {}), ...extra });

describe('summarizeTurnLlm', () => {
  it('keeps the parent\'s calls and totals them with the sub-agents\' by role', () => {
    const out = summarizeTurnLlm({
      calls: [call('main', 0.09), call('utility', 0.01)],
      subagents: [{ agentId: 'code-explorer', role: 'worker', calls: [call('worker', 0.02)] }]
    });
    assert.strictEqual(out.calls.length, 2);
    assert.deepStrictEqual(out.subagents, [{ agentId: 'code-explorer', role: 'worker', calls: [call('worker', 0.02)], totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.02 } }]);
    assert.strictEqual(out.totals.costUsd, 0.12);
    assert.deepStrictEqual(Object.keys(out.byRole), ['main', 'utility', 'worker']);
    assert.deepStrictEqual(out.byRole.worker, { calls: 1, totalTokens: 2, costUsd: 0.02 });
  });

  it('marks an unpriced or partial role, and files an untagged call under other', () => {
    const byRole = costByRole([call('main', null), call('main', 0.01, { usagePartial: true }), call(null, 0.5)]);
    assert.deepStrictEqual(byRole.main, { calls: 2, totalTokens: 4, costUsd: 0.01, unpriced: true, partial: true });
    assert.deepStrictEqual(byRole.other, { calls: 1, totalTokens: 2, costUsd: 0.5 });
  });

  it('has no subagents or byRole when there is nothing to show', () => {
    assert.deepStrictEqual(summarizeTurnLlm({ calls: [] }), { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } });
    assert.strictEqual('subagents' in summarizeTurnLlm({ calls: [call('main', 0.1)], subagents: [] }), false);
  });
});
```

At the end of `tests/tool-executor.test.js`, add:

```js
describe('ToolExecutor sub-agent cost sink (models spec 2026-09-27 §10)', () => {
  it('hands the sink on to its children through the requester', () => {
    const sink = () => {};
    const requester = new ToolExecutor({ requireApproval: false, onSubagentLlm: sink })._rethreadedRequester();
    assert.strictEqual(requester.onSubagentLlm, sink);
    assert.strictEqual(new ToolExecutor({ requireApproval: false })._rethreadedRequester().onSubagentLlm, undefined);
  });
});
```

In `tests/spawn-agent-tool.test.js`, inside `describe('roles (models spec 2026-09-27 §8)', …)` (Task 1), add:

```js
    it('reports the child\'s calls to the parent turn, never an empty run (spec §10)', async () => {
      const reports = [];
      const requester = Object.assign(async () => true, { onSubagentLlm: (run) => reports.push(run) });
      const calls = [{ model: 'worker-model', role: 'worker', costUsd: 0.002 }];
      await SpawnAgentTool.execute({ task: 'look' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => ({ type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { calls, totals: { costUsd: 0.002 } } }) }
      }));
      await SpawnAgentTool.execute({ task: 'look again' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => ({ type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { calls: [], totals: {} } }) }
      }));
      assert.deepStrictEqual(reports, [{ agentId: 'main', role: 'worker', calls, totals: { costUsd: 0.002 } }]);
    });
```

In `tests/background-task-role.test.js`, in `it('runs a bare task on worker', …)`, after `assert.strictEqual(seen[0].opts.role, 'worker');` add:

```js
    // A background run outlives the turn: its cost is never rolled into the reply.
    assert.strictEqual(seen[0].opts.detached, true);
```

In `tests/chat-roles.test.js`, add after the first describe:

```js
describe('sub-agent calls roll up into the reply (spec §10)', () => {
  // The parent calls one tool, then answers. The "tool" reports a sub-agent
  // run the way SpawnAgent does, through onSubagentLlm.
  function rollupHarness({ stopAfterTool = false } = {}) {
    let parentCalls = 0;
    let h = null;
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => {
        parentCalls += 1;
        if (parentCalls === 1) return { type: 'tool_use', toolName: 'SpawnAgent', toolUseId: 't1', parameters: { task: 'look' }, llmMetrics: metricsFor(opts.model, 0.01) };
        return { type: 'text', content: 'done', llmMetrics: metricsFor(opts.model, 0.02) };
      },
      buildToolMessages: (response, toolResult, id) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(toolResult) }
      ]
    };
    h = chatHarness({
      provider,
      overrides: {
        createToolExecutorWithApprovals: async (_event, _env, _requester, opts) => {
          const EventEmitter = require('events');
          const executor = new EventEmitter();
          executor.allowedDirectories = [];
          executor.execute = async () => {
            opts.onSubagentLlm({
              agentId: 'code-explorer',
              role: 'worker',
              calls: [{ ...metricsFor('worker-model', 0.003), role: 'worker' }, { ...metricsFor('worker-model', null), role: 'worker' }],
              totals: null
            });
            if (stopAfterTool) await h.stop();
            return { success: true, content: 'summary' };
          };
          return executor;
        }
      }
    });
    return h;
  }

  it('keeps the parent\'s calls, lists each sub-agent run, and totals both by role', async () => {
    const h = rollupHarness();
    await h.send({ agentMode: true });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.llm.calls.length, 2);
    assert.deepStrictEqual(reply.llm.subagents.map((s) => [s.agentId, s.role, s.calls.length]), [['code-explorer', 'worker', 2]]);
    assert.strictEqual(reply.llm.totals.costUsd, 0.033);
    assert.strictEqual(reply.llm.totals.unpriced, true);
    assert.deepStrictEqual(reply.llm.byRole.main, { calls: 2, totalTokens: 4, costUsd: 0.03 });
    assert.deepStrictEqual(reply.llm.byRole.worker, { calls: 2, totalTokens: 4, costUsd: 0.003, unpriced: true });
  });

  it('a stopped turn keeps the sub-agent calls that ran', async () => {
    const h = rollupHarness({ stopAfterTool: true });
    await h.send({ agentMode: true });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.stopped, true);
    assert.strictEqual(reply.llm.subagents[0].calls.length, 2);
    assert.strictEqual(reply.llm.byRole.worker.costUsd, 0.003);
    assert.strictEqual(reply.llm.totals.costUsd, 0.013);
  });
});
```

In `tests/chat-profiles.test.js`, in `fakeProvider(calls, spawns, onSpawn)`, replace

```js
        if (who !== 'parent') return { type: 'text', content: `answered by ${options.model}` };
```

with

```js
        if (who !== 'parent') {
          return { type: 'text', content: `answered by ${options.model}`, llmMetrics: { provider: FAKE, model: options.model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 } };
        }
```

and add at the end of `describe('sub-agents of a chat turn', …)`:

```js
  it('a sub-agent\'s calls roll up into the reply, by role (spec §10)', async () => {
    const { core, send } = await startChatCore({ chat: { profileId: 'p-b' }, spawns: ['code-explorer'] });
    try {
      const result = await send();
      assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
      const reply = core.context.getChats().find((c) => c.id === 'chat-1').messages.filter((m) => m.sender === 'assistant').pop();
      assert.deepStrictEqual(
        reply.llm.subagents.map((s) => [s.agentId, s.role, s.calls.map((c) => [c.model, c.role, c.profileId])]),
        [['code-explorer', 'worker', [['b-worker', 'worker', 'p-b']]]]
      );
      assert.strictEqual(reply.llm.byRole.worker.costUsd, 0.001);
    } finally {
      await core.shutdown();
    }
  });
```

Create `tests/renderer-models-m3.test.js`:

```js
// tests/renderer-models-m3.test.js
// Static checks on the renderer for models M3 (spec 2026-09-27 §10, §11):
// the per-role cost line; later tasks add the King Louie profile and custom
// roles. Model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: the per-role cost line', () => {
  const formatRoleCosts = new Function(`${block('function formatCompactUsd(value = 0)')}\n${block('function formatRoleCosts(byRole)')}\nreturn formatRoleCosts;`)();

  it('splits a reply\'s cost by role, core roles first', () => {
    assert.strictEqual(formatRoleCosts({ utility: { costUsd: 0.01 }, main: { costUsd: 0.09 }, worker: { costUsd: 0.02 } }), ' · main $0.09 · worker $0.02 · utility $0.01');
    assert.strictEqual(formatRoleCosts({ 'legal-drafting': { costUsd: 0.5 }, main: { costUsd: 0.1, unpriced: true } }), ' · main $0.10+ · legal-drafting $0.50');
    assert.strictEqual(formatRoleCosts(undefined), '');
  });

  it('the reply\'s metrics line uses it', () => {
    assert.match(block('function addMessage(sender, text, metadata = {})'), /formatRoleCosts\(metadata\.llm\.byRole\)/);
    assert.ok(html.length > 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/llm-totals.test.js tests/tool-executor.test.js tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/chat-roles.test.js tests/chat-profiles.test.js tests/renderer-models-m3.test.js`
Expected: FAIL — `summarizeTurnLlm` is not a function, `requester.onSubagentLlm` is undefined, no report is made, `reply.llm.subagents` is undefined, `formatRoleCosts` is not found.

- [ ] **Step 3: The reply's llm record**

In `src/tracking/llm-totals.js`, replace

```js
module.exports = { sumLlmCalls };
```

with

```js
// Cost by role over a reply's calls (models spec 2026-09-27 §10). A call
// with no role (an untagged caller) counts as "other".
function costByRole(calls = []) {
  const out = {};
  for (const call of (Array.isArray(calls) ? calls : []).filter(Boolean)) {
    const role = typeof call.role === 'string' && call.role ? call.role : 'other';
    const entry = out[role] || (out[role] = { calls: 0, totalTokens: 0, costUsd: 0 });
    entry.calls += 1;
    entry.totalTokens += Number(call.totalTokens) || 0;
    entry.costUsd = Number((entry.costUsd + (Number(call.costUsd) || 0)).toFixed(8));
    if (call.costUsd === null || call.unpriced === true) entry.unpriced = true;
    if (call.usagePartial) entry.partial = true;
  }
  return out;
}

// A reply's llm record: the parent's own calls, each sub-agent run kept
// apart, and totals and cost by role over both (spec §10).
function summarizeTurnLlm({ calls = [], subagents = [] } = {}) {
  const own = (Array.isArray(calls) ? calls : []).filter(Boolean);
  const runs = (Array.isArray(subagents) ? subagents : [])
    .filter((r) => r && Array.isArray(r.calls) && r.calls.length)
    .map((r) => {
      const runCalls = r.calls.filter(Boolean);
      return { agentId: r.agentId || null, role: r.role || null, calls: runCalls, totals: sumLlmCalls(runCalls) };
    });
  const all = [...own, ...runs.flatMap((r) => r.calls)];
  const out = { calls: own, totals: sumLlmCalls(all) };
  if (runs.length) out.subagents = runs;
  if (all.length) out.byRole = costByRole(all);
  return out;
}

module.exports = { sumLlmCalls, costByRole, summarizeTurnLlm };
```

- [ ] **Step 4: The sink reaches every child**

In `src/execution/tool-executor.js`, after

```js
    this.turnModels = options.turnModels || null;
```

add

```js
    // Where a sub-agent run's model calls go (models spec §10): the chat
    // turn that owns this run rolls them into its reply. Carried on the
    // rethreaded requester like turnModels, so grandchildren report too.
    this.onSubagentLlm = typeof options.onSubagentLlm === 'function' ? options.onSubagentLlm : null;
```

and in `_rethreadedRequester`, after

```js
    if (this.turnModels) requester.turnModels = this.turnModels;
```

add

```js
    if (this.onSubagentLlm) requester.onSubagentLlm = this.onSubagentLlm;
```

In `src/core/create-core.js`, in `createToolExecutorWithApprovals`'s `new ToolExecutor({ … })`, after

```js
      turnModels: executorOptions.turnModels || null,
```

add

```js
      // A sub-agent's calls roll up into the turn's reply (spec §10).
      onSubagentLlm: executorOptions.onSubagentLlm || null,
```

In `createAgentRuntime`, replace

```js
        // The run's models reach its own children in turn (§6.6).
        turnModels
      }
    );
```

with

```js
        // The run's models reach its own children in turn (§6.6).
        turnModels,
        // So does the top-level reply's sub-agent cost sink (§10).
        onSubagentLlm: runtimeOptions.onSubagentLlm || null
      }
    );
```

In `agentExecutorAdapter.execute`, replace

```js
            turnModels: (options.approvalRequester && options.approvalRequester.turnModels) || null
          }
        );
```

with

```js
            turnModels: (options.approvalRequester && options.approvalRequester.turnModels) || null,
            // A sub-agent's calls roll up into the turn's reply (spec §10);
            // a detached run (BackgroundTask) outlives the turn, so it never does.
            onSubagentLlm: options.detached === true ? null : ((options.approvalRequester && options.approvalRequester.onSubagentLlm) || null)
          }
        );
```

In `src/tools/builtin/background-task-tool.js`, in the `agentExecutorAdapter.execute(agent, params.task, { … })` options, after `...(role ? { role } : {}),` (Task 1) add:

```js
                // Outlives the turn: its cost is recorded, never rolled into the reply.
                detached: true,
```

- [ ] **Step 5: SpawnAgent reports its child's calls**

In `src/tools/builtin/spawn-agent-tool.js`, above `const SpawnAgentTool = new Tool({`, add:

```js
// The child's calls roll up into the parent reply (models spec §10). A
// grandchild reports to the same place, through the same requester; a run
// that made no calls reports nothing. Reporting never fails the spawn.
function reportSubagentLlm(options, { agentId, role, result }) {
  const sink = options?.approvalRequester?.onSubagentLlm;
  const calls = Array.isArray(result?.llm?.calls) ? result.llm.calls.filter(Boolean) : [];
  if (typeof sink !== 'function' || !calls.length) return;
  try {
    sink({ agentId, role, calls, totals: result.llm.totals || null });
  } catch {
    // a broken sink only loses the roll-up; the usage is already recorded
  }
}
```

In `execute`, replace

```js
      const result = await agentExecutorAdapter.execute(
        agent,
        params.task,
        executeOptions
      );
```

with

```js
      const result = await agentExecutorAdapter.execute(
        agent,
        params.task,
        executeOptions
      );
      reportSubagentLlm(options, { agentId, role: role || agent.role || null, result });
```

- [ ] **Step 6: The chat turn builds its record from both**

In `src/ipc/chat-handlers.js`, replace

```js
const { sumLlmCalls } = require('../tracking/llm-totals');
```

with

```js
const { summarizeTurnLlm } = require('../tracking/llm-totals');
```

Replace

```js
    let llmSummary = {
      calls: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    };
```

with

```js
    // This turn's own model calls, and each sub-agent run's (spec §10): the
    // reply's llm record is built from both, stopped or not.
    let ownCalls = [];
    const subagentRuns = [];
    const summarize = () => summarizeTurnLlm({ calls: ownCalls, subagents: subagentRuns });
    let llmSummary = summarize();
```

In the `createToolExecutorWithApprovals(event, runtimeEnvironment, null, { … })` options, after `turnModels,` add:

```js
        // SpawnAgent children report their calls here (spec §10).
        onSubagentLlm: (run) => { subagentRuns.push(run); },
```

Replace

```js
            const stoppedCalls = result?.llm?.calls || [];
            llmSummary = { calls: stoppedCalls, totals: result?.llm?.totals || sumLlmCalls(stoppedCalls) };
            return;
```

with

```js
            ownCalls = result?.llm?.calls || [];
            llmSummary = summarize();
            return;
```

Replace

```js
          llmSummary = {
            calls: result?.llm?.calls || [],
            totals: result?.llm?.totals || sumLlmCalls(result?.llm?.calls || [])
          };
```

with

```js
          ownCalls = result?.llm?.calls || [];
          llmSummary = summarize();
```

Replace

```js
          const singleCall = streamResult?.llmMetrics || null;
          const calls = singleCall ? [singleCall] : [];
          llmSummary = { calls, totals: sumLlmCalls(calls) };
```

with

```js
          const singleCall = streamResult?.llmMetrics || null;
          ownCalls = singleCall ? [singleCall] : [];
          llmSummary = summarize();
```

- [ ] **Step 7: The per-role cost line**

In `renderer.js`, after the whole `function formatCompactUsd(value = 0) { … }`, add:

```js
// A reply's cost by role (models spec 2026-09-27 §10): " · main $0.09 ·
// worker $0.02 · utility $0.01". Core roles first; an unpriced role's cost
// is a lower bound, so it gets a "+".
function formatRoleCosts(byRole) {
  if (!byRole || typeof byRole !== 'object') return '';
  const order = ['main', 'worker', 'utility', 'vision', 'imageGeneration'];
  const roles = Object.keys(byRole);
  const ordered = [...order.filter((r) => roles.includes(r)), ...roles.filter((r) => !order.includes(r)).sort()];
  return ordered.map((r) => ` · ${r} ${formatCompactUsd(byRole[r]?.costUsd)}${byRole[r]?.unpriced ? '+' : ''}`).join('');
}
```

In `addMessage`, replace

```js
    callSpan.textContent = `${formatTokenCount(callTotals.totalTokens)} tokens · ${formatCompactUsd(callTotals.costUsd)}`;
```

with

```js
    callSpan.textContent = `${formatTokenCount(callTotals.totalTokens)} tokens · ${formatCompactUsd(callTotals.costUsd)}${formatRoleCosts(metadata.llm.byRole)}`;
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/llm-totals.test.js tests/tool-executor.test.js tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/chat-roles.test.js tests/chat-profiles.test.js tests/renderer-models-m3.test.js tests/chat-stop.test.js tests/explorer-delegation.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/tracking/llm-totals.js src/execution/tool-executor.js src/tools/builtin/spawn-agent-tool.js src/tools/builtin/background-task-tool.js src/core/create-core.js src/ipc/chat-handlers.js renderer.js tests/llm-totals.test.js tests/tool-executor.test.js tests/spawn-agent-tool.test.js tests/background-task-role.test.js tests/chat-roles.test.js tests/chat-profiles.test.js tests/renderer-models-m3.test.js
git commit -m "feat(models): sub-agent calls roll up into the reply; the metrics line splits cost by role"
```

---

## Task 5: Chat titles on utility; the advisor records its usage

**Files:**
- Create: `src/providers/one-shot.js`
- Modify: `src/execution/advisor.js` (header comment, requires, `review`), `src/ipc/chat-handlers.js` (requires; `autoNameChat`, whole function; its call site; the advisor block)
- Test: `tests/advisor.test.js` (new), `tests/chat-roles.test.js` (describe added); run `tests/chat-profiles.test.js`, `tests/chat-stop.test.js`

**Interfaces:**
- Consumes: `TurnModels#resolve('utility')`, `#candidatesFor('utility')`, `.profileId`; `routedProvider({ targets, signal, meta })` (Task 3, `context.routedProvider`); `UsageTracker.eventFromMetrics` (Task 3); `ownCalls`, `summarize()` in the send handler (Task 4); `refreshProvider(availability, provider)` (`src/ipc/chat-handlers.js`); `targetLabel` (`src/models/roles.js`).
- Produces:
  - `oneShot(provider, messages, options) → Promise<{ text, llmMetrics | null }>` (`src/providers/one-shot.js`): one call through `provider.streamMessage`, collecting chunks; a whole-string answer also works.
  - `autoNameChat({ chatId, userMessage, assistantResponse, sender, turnModels })`: tests utility's providers, resolves `utility` from the turn's frozen models (borrowing from worker, then main, when utility is empty), calls it with `meta: { role: 'utility', profileId, borrowedFrom }`, records the usage, and does nothing when no utility model is usable.
  - `Advisor#review` calls through `oneShot`, records its usage on the tracker, and returns the real `llmMetrics`; the chat turn appends that call to `llm.calls` (it is a main-role call of the turn).

- [ ] **Step 1: Write the failing tests**

Create `tests/advisor.test.js`:

```js
// tests/advisor.test.js
// The advisor stays on main and records its usage (models spec 2026-09-27
// §8, §17.1); one-shot calls report usage through streamMessage.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const Advisor = require('../src/execution/advisor');
const { oneShot } = require('../src/providers/one-shot');

describe('oneShot', () => {
  it('collects the streamed text and returns the call\'s metrics', async () => {
    const provider = { streamMessage: async (_m, _o, onChunk) => { onChunk('Road '); onChunk('trip'); return { llmMetrics: { costUsd: 0.001 } }; } };
    assert.deepStrictEqual(await oneShot(provider, [{ role: 'user', content: 'hi' }]), { text: 'Road trip', llmMetrics: { costUsd: 0.001 } });
  });

  it('takes a whole-string answer, with no metrics', async () => {
    const provider = { streamMessage: async () => 'Whole answer' };
    assert.deepStrictEqual(await oneShot(provider, []), { text: 'Whole answer', llmMetrics: null });
  });
});

describe('Advisor', () => {
  it('reviews through one streamed call and records its usage', async () => {
    const recorded = [];
    const provider = {
      streamMessage: async (_m, _opts, onChunk) => {
        onChunk('LGTM\nClean change.');
        return { llmMetrics: { provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 3, totalTokens: 13, costUsd: 0.002, role: 'main' } };
      }
    };
    const advisor = new Advisor({ provider, usageTracker: { record: (e) => { recorded.push(e); return e; } } });
    const out = await advisor.review({ content: 'done', tools: [] }, { userMessage: 'fix it' });
    assert.deepStrictEqual([out.verdict, out.review, out.llmMetrics.costUsd], ['LGTM', 'LGTM\nClean change.', 0.002]);
    assert.deepStrictEqual(recorded.map((e) => [e.role, e.costUsd]), [['main', 0.002]]);
  });

  it('says so when the provider cannot stream', async () => {
    const out = await new Advisor({ provider: { sendMessage: async () => 'x' } }).review({ content: '' });
    assert.strictEqual(out.error, 'No provider configured');
  });

  it('reports a failed call as an error, never as a review', async () => {
    const out = await new Advisor({ provider: { streamMessage: async () => { throw new Error('boom'); } } }).review({ content: '' });
    assert.match(out.error, /Advisor review failed: boom/);
    assert.strictEqual(out.llmMetrics, null);
  });
});
```

In `tests/chat-roles.test.js`, add after the last describe:

```js
describe('chat titles on utility; the advisor on main (spec §8)', () => {
  const newChat = () => ({ id: 'chat-1', title: 'New Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] });
  const until = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const t = (provider, model) => ({ provider, model, effort: null });

  it('titles a new chat on utility and records the call as utility', async () => {
    const seen = [];
    const provider = {
      streamMessage: async (_m, opts, onChunk) => {
        seen.push(opts.model);
        onChunk(opts.model === 'title-model' ? 'Greeting chat' : 'Hello');
        return { llmMetrics: metricsFor(opts.model, 0.0001) };
      }
    };
    const h = chatHarness({ provider, chat: newChat(), roles: { main: [t('openai', 'main-model')], utility: [t('openai', 'title-model')] } });
    await h.send({ agentMode: false });
    await until(() => h.usage.some((u) => u.model === 'title-model'));
    assert.deepStrictEqual(seen, ['main-model', 'title-model']);
    const title = h.usage.find((u) => u.model === 'title-model');
    assert.deepStrictEqual([title.role, title.costUsd], ['utility', 0.0001]);
  });

  it('no usable utility model skips the title and records nothing', async () => {
    const seen = [];
    const provider = { streamMessage: async (_m, opts, onChunk) => { seen.push(opts.model); onChunk('Hello'); return { llmMetrics: metricsFor(opts.model) }; } };
    const availability = {
      ensureTested: async () => ({ ok: true }),
      explain: (p) => (p === 'groq' ? { usable: false, reasons: ['No token saved for Groq.'], notes: [] } : { usable: true, reasons: [], notes: [] })
    };
    const h = chatHarness({
      provider,
      chat: newChat(),
      roles: { main: [t('openai', 'main-model')], utility: [t('groq', 'title-model')] },
      overrides: { getAvailability: () => availability }
    });
    const result = await h.send({ agentMode: false });
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.notStrictEqual(result?.ok, false);
    assert.deepStrictEqual(seen, ['main-model']);
    assert.deepStrictEqual(h.usage.map((u) => u.model), ['main-model']);
  });

  it('the advisor reviews on main and its call joins the reply', async () => {
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => ({ type: 'text', content: 'done', llmMetrics: metricsFor(opts.model, 0.02) }),
      streamMessage: async (_m, opts, onChunk) => { onChunk('LGTM'); return { llmMetrics: metricsFor(opts.model, 0.005) }; }
    };
    const h = chatHarness({ provider, overrides: { getSettings: () => ({ advisor: { enabled: true } }) } });
    await h.send({ agentMode: true });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual(reply.llm.calls.map((c) => [c.role, c.costUsd]), [['main', 0.02], ['main', 0.005]]);
    assert.strictEqual(reply.llm.totals.costUsd, 0.025);
    assert.match(reply.text, /Advisor Review/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/advisor.test.js tests/chat-roles.test.js`
Expected: FAIL — `src/providers/one-shot.js` does not exist; the title runs on `main-model`; the advisor call is not in `llm.calls`.

- [ ] **Step 3: The one-shot helper**

Create `src/providers/one-shot.js`:

```js
// src/providers/one-shot.js
// One tool-less model call that reports its usage (models spec 2026-09-27
// §8): a chat title, an advisor review. Plain sendMessage returns bare text
// and no usage, so the call goes through streamMessage, collecting the
// chunks; a provider that answers with a whole string still works.
async function oneShot(provider, messages, options = {}) {
  if (!provider || typeof provider.streamMessage !== 'function') {
    throw new Error('oneShot needs a provider with streamMessage.');
  }
  let streamed = '';
  const result = await provider.streamMessage(messages, options, (chunk) => { streamed += String(chunk ?? ''); });
  const text = streamed || (typeof result === 'string' ? result : String(result?.content ?? ''));
  const llmMetrics = result && typeof result === 'object' && result.llmMetrics ? result.llmMetrics : null;
  return { text, llmMetrics };
}

module.exports = { oneShot };
```

- [ ] **Step 4: The advisor records its usage**

In `src/execution/advisor.js`, replace the header comment's configuration part

```js
 * Configuration:
 *   settings.advisor = {
 *     enabled: true,
 *     model: 'claude-sonnet-5',  // or any available model
 *     provider: 'anthropic'               // optional provider override
 *   }
 */
```

with

```js
 * Configuration: settings.advisor = { enabled: true }. It reviews on the
 * turn's main role (models spec 2026-09-27 §8) and records its usage.
 */

const { oneShot } = require('../providers/one-shot');
const UsageTracker = require('../tracking/usage-tracker');
```

In `review`, replace

```js
    if (!this.provider || typeof this.provider.sendMessage !== 'function') {
```

with

```js
    if (!this.provider || typeof this.provider.streamMessage !== 'function') {
```

and replace

```js
      // Use sendMessage (no tools needed for review)
      const reviewText = await this.provider.sendMessage(messages, options);

      // Extract verdict from first line
      const firstLine = (reviewText || '').split('\n')[0].trim().toUpperCase();
      const verdict = firstLine.includes('LGTM') ? 'LGTM' : 'ISSUES_FOUND';

      // Track cost separately
      let llmMetrics = null;
      if (this.usageTracker && typeof this.provider.buildLlmCallMetrics === 'function') {
        // Note: sendMessage doesn't return metrics directly in most providers
        // This is a best-effort cost annotation
        llmMetrics = { provider: this.provider.getProviderName?.() || 'unknown', model: this.model, advisor: true };
      }
```

with

```js
      // One tool-less call through streamMessage, which reports its usage.
      const { text: reviewText, llmMetrics } = await oneShot(this.provider, messages, options);

      // Extract verdict from first line
      const firstLine = (reviewText || '').split('\n')[0].trim().toUpperCase();
      const verdict = firstLine.includes('LGTM') ? 'LGTM' : 'ISSUES_FOUND';

      // The review is recorded like any other call (spec §10).
      if (llmMetrics && this.usageTracker && typeof this.usageTracker.record === 'function') {
        try {
          this.usageTracker.record(UsageTracker.eventFromMetrics(llmMetrics));
        } catch {
          // recording never fails a review
        }
      }
```

- [ ] **Step 5: Titles on utility, and the advisor's call in the reply**

In `src/ipc/chat-handlers.js`, after

```js
const UsageTracker = require('../tracking/usage-tracker');
```

add

```js
const { oneShot } = require('../providers/one-shot');
const { targetLabel } = require('../models/roles');
```

Replace the whole `autoNameChat` function, from its doc comment

```js
  /**
   * Generate a contextual title for a chat with the turn's main models (the
   * utility role takes this over in stage M3), then persist it and notify
   * the renderer.
   */
  async function autoNameChat(chatId, userMessage, assistantResponse, sender, provider) {
```

through its closing

```js
    } catch (err) {
      log.warn(`Failed to generate chat title: ${err.message}`);
    }
  }
```

with

```js
  /**
   * Title a new chat on the turn's utility role (spec 2026-09-27 §8): a
   * small job on a cheap model, its usage recorded like any other call. An
   * empty utility borrows from worker, then main; nothing usable means no
   * title, never a call on a model outside the role.
   */
  async function autoNameChat({ chatId, userMessage, assistantResponse, sender, turnModels }) {
    try {
      const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
      if (availability) {
        const providers = [...new Set(turnModels.candidatesFor('utility').map((x) => x.provider))].filter((p) => KL_PROVIDERS.includes(p));
        await Promise.all(providers.map((p) => refreshProvider(availability, p)));
      }
      const utility = turnModels.resolve('utility');
      if (!utility.targets.length) {
        const why = utility.skipped.map((s) => `${targetLabel(s.target)} (${s.reasons.join(' ')})`).join('; ');
        log.info(`No usable utility model for a chat title${why ? `: ${why}` : ''}.`);
        return;
      }
      const provider = createRoutedProvider({
        targets: utility.targets,
        meta: { role: 'utility', profileId: turnModels.profileId || null, borrowedFrom: utility.borrowedFrom || null }
      });

      const titlePrompt = [
        {
          sender: 'user',
          text: `Generate a short, descriptive title (max 6 words) for a chat that starts with this exchange. Reply with ONLY the title text, no quotes or punctuation at the end.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantResponse.slice(0, 300)}`
        }
      ];

      const settings = typeof context.getSettings === 'function' ? context.getSettings() : {};
      const { text, llmMetrics } = await oneShot(provider, titlePrompt, { temperature: 0.3, max_tokens: 30, timeoutMs: roleTimeoutMs(settings, 'utility') });

      const tracker = typeof getUsageTracker === 'function' ? getUsageTracker() : null;
      if (tracker && llmMetrics && typeof tracker.record === 'function') tracker.record(UsageTracker.eventFromMetrics(llmMetrics));

      const cleaned = String(text || '').replace(/^["']|["'.!]$/g, '').trim();
      if (!cleaned) return;

      const chats = getChats();
      const updated = chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, title: cleaned, updatedAt: new Date().toISOString() }
          : chat
      );
      setChats(updated);

      // Notify the renderer so the sidebar updates
      if (sender && !sender.isDestroyed()) {
        sender.send('chat:updated', { chats: updated });
      }
    } catch (err) {
      log.warn(`Failed to generate chat title: ${err.message}`);
    }
  }
```

Replace the call site

```js
      // Auto-name chats that still have the default title
      if (chat.title === 'New Chat' && fullResponse) {
        autoNameChat(chatId, safeMessage, fullResponse, event.sender, createRoutedProvider({ targets: main.targets })).catch(() => {});
      }
```

with

```js
      // Auto-name chats that still have the default title, on the turn's
      // utility role (spec §8).
      if (chat.title === 'New Chat' && fullResponse) {
        autoNameChat({ chatId, userMessage: safeMessage, assistantResponse: fullResponse, sender: event.sender, turnModels }).catch(() => {});
      }
```

In the advisor block, replace

```js
              const reviewResult = await advisor.review(result, {
                userMessage: safeMessage
              });
```

with

```js
              const reviewResult = await advisor.review(result, {
                userMessage: safeMessage
              });
              // The review is one more main-role call of this turn (spec §8, §10).
              if (reviewResult.llmMetrics) {
                ownCalls = [...ownCalls, reviewResult.llmMetrics];
                llmSummary = summarize();
              }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/advisor.test.js tests/chat-roles.test.js tests/chat-profiles.test.js tests/chat-stop.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/one-shot.js src/execution/advisor.js src/ipc/chat-handlers.js tests/advisor.test.js tests/chat-roles.test.js
git commit -m "feat(models): chat titles run on utility and record their usage; the advisor's review joins the reply's cost"
```

---

## Task 6: Agent runs: each agent on its own role and route; built-in agents without models; compaction per call

**Files:**
- Modify: `src/ipc/agent-handlers.js` (helpers; `AGENT_LIST`; the `AGENT_EXECUTE_PARALLEL`, `AGENT_EXECUTE_WITH_DEPS` and `AGENT_EXECUTE_SERIAL` handlers), `src/execution/agent-loop.js` (constructor; two call sites; two new methods), `src/agents/agent-schema.js` (`model`, `inferenceTier`), `src/agents/agent-executor.js` (`resolveTemplateContext`), `src/agents/builtin/main-assistant.js`, `src/agents/builtin/code-writer.js`, `src/agents/builtin/planner.js`, `src/agents/builtin/case-researcher.js` (drop `model` and `inferenceTier`), `templates/main-assistant.md.template`, `templates/code-writer.md.template`, `templates/planner.md.template` (agent metadata lines)
- Test: `tests/agent-handlers.test.js` (fake orchestrator runs its executor; roles test updated; one test added), `tests/agent-loop.test.js` (one test added), `tests/planner-agent.test.js` (one test changed), `tests/cases-executor-child.test.js` (one assertion changed), `tests/models-headless.test.js` (one test extended); run `tests/agent-executor.test.js`, `tests/chat-profiles.test.js`

**Interfaces:**
- Consumes: `createAgentRuntime({ role }, event)` (M2) returning `{ role, model, timeoutMs, provider, toolExecutor, toolDefinitions, runtimeEnvironment }`; `roleForAgent(agent)`; `AgentOrchestrator#executeParallel/executeSerial/executeWithDependencies(…, options)` calling `agentExecutor.execute(agent, message, options)`; a routed provider's `current()` (M2).
- Produces:
  - `agent:executeParallel`, `agent:executeSerial` and `agent:executeWithDeps` build one runtime (and so one routed provider) per agent run, on `roleForAgent(agent)`; `agent:executeWithDeps` still resolves the agent's role once up front (so a role with no usable model fails before any task is created) and reuses that runtime for the first task.
  - `agent:list` returns `{ id, name, description, role, allowedTools }`.
  - `AgentLoop` decides API compaction per call: an explicit `options.useAPICompaction` boolean fixes it; otherwise it is on when the provider answering (the routed provider's `current().provider`, or the call's `metrics.provider`) is `anthropic`.
  - `Agent#model` and `Agent#inferenceTier` default to `null`; the five built-in agents set neither. Templates show `- Model role: {{agent.role}}`.

- [ ] **Step 1: Write the failing tests**

In `tests/agent-handlers.test.js`, in `createContext`, replace the whole `class FakeAgentOrchestrator { … }` with:

```js
  // Runs each agent (each task) through the executor it was given, as the
  // real AgentOrchestrator does.
  class FakeAgentOrchestrator {
    constructor(agentExecutor) {
      this.agentExecutor = agentExecutor;
    }
    async executeParallel(agents, message, options) {
      return Promise.all(agents.map((agent) => this.agentExecutor.execute(agent, message, options)));
    }
    async executeSerial(agents, message, options) {
      const out = [];
      for (const agent of agents) out.push(await this.agentExecutor.execute(agent, message, options));
      return out;
    }
    async executeWithDependencies(taskManager, agents, options) {
      const results = new Map();
      for (const task of taskManager.list()) {
        results.set(task.id, await this.agentExecutor.execute(agents[0], task.description || task.subject || '', options));
      }
      return results;
    }
  }
```

In `describe('agent-handlers roles', …)`, replace

```js
    assert.deepStrictEqual(selections, [{ role: 'worker' }, { role: 'utility' }, { role: 'main' }, { role: 'main' }, { role: 'main' }, { role: 'worker' }]);
```

with

```js
    // Parallel and serial runs now use each agent's own role (a role-less
    // agent is worker), not main; with-deps resolves once and reuses it.
    assert.deepStrictEqual(selections, [{ role: 'worker' }, { role: 'utility' }, { role: 'main' }, { role: 'worker' }, { role: 'worker' }, { role: 'worker' }]);
```

and add, inside the same describe:

```js
  it('gives each agent of a parallel run its own runtime on its own role (one route per run)', async () => {
    const selections = [];
    const writer = { id: 'writer', name: 'Writer', canUseTool: () => true, role: 'main' };
    const explorer = { id: 'explorer', name: 'Explorer', canUseTool: () => true, role: 'worker' };
    const ipcMain = createIpcMainMock();
    const context = createContext({
      getAgent: (id) => ({ writer, explorer })[id],
      createAgentRuntime: async (selection) => {
        selections.push(selection.role);
        return { provider: { route: selections.length }, toolExecutor: {}, role: selection.role, model: 'm', timeoutMs: 1000, toolDefinitions: [], runtimeEnvironment: { workingDirectory: process.cwd() } };
      }
    });
    registerAgentHandlers(ipcMain, context);
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['writer', 'explorer'], message: 'hi' });
    assert.deepStrictEqual([...selections].sort(), ['main', 'worker']);
    assert.strictEqual(context.executorCalls.length, 2);
  });

  it('lists agents by role, with no model or tier', async () => {
    const ipcMain = createIpcMainMock();
    registerAgentHandlers(ipcMain, createContext());
    const list = await ipcMain.handlers.get(IPC.AGENT_LIST)({});
    const agents = list.data || list;
    assert.deepStrictEqual(Object.keys(agents[0]).sort(), ['allowedTools', 'description', 'id', 'name', 'role']);
    assert.strictEqual(agents[0].role, 'worker');
  });
```

In `tests/agent-loop.test.js`, inside `describe('AgentLoop', …)`, add:

```js
  it('chooses API compaction per call from the provider that answered (models M2 carry)', async () => {
    const updates = [];
    let compacted = 0;
    const apiCompaction = {
      updateTokenCount: (m) => updates.push(m.provider),
      shouldCompact: () => updates.length > 0,
      compact: () => { compacted += 1; return { cleared: 1, freedEstimate: 10 }; },
      compactOpenAIFormat: () => ({ cleared: 0, freedEstimate: 0 })
    };
    let current = 'openai';
    let n = 0;
    // A routed provider whose first call is answered by openai, after which
    // the turn fails over to anthropic for the rest of it.
    const provider = {
      current: () => ({ provider: current, model: 'm' }),
      getProviderName: () => current,
      sendMessageWithTools: async () => {
        n += 1;
        const who = current;
        if (n === 1) current = 'anthropic';
        if (n < 3) return { type: 'tool_use', toolName: 'Read', parameters: { file_path: 'a.txt' }, llmMetrics: { provider: who, model: 'm', inputTokens: 200000 } };
        return { type: 'text', content: 'done', llmMetrics: { provider: who, model: 'm', inputTokens: 10 } };
      },
      buildToolMessages: sequenceProvider([]).buildToolMessages
    };
    const loop = new AgentLoop(provider, okExecutor(), { apiCompaction, maxIterations: 5 });
    await loop.run([{ role: 'user', content: 'hi' }], []);
    assert.deepStrictEqual(updates, ['anthropic', 'anthropic']);
    assert.ok(compacted >= 1, 'compacted once the answering provider was anthropic');
  });
```

In `tests/planner-agent.test.js`, replace

```js
  it('uses smart inference tier', () => {
    assert.strictEqual(PlannerAgent.inferenceTier, 'smart');
  });
```

with

```js
  it('runs on the main role, with no fixed model or tier', () => {
    assert.strictEqual(PlannerAgent.role, 'main');
    assert.strictEqual(PlannerAgent.model, null);
    assert.strictEqual(PlannerAgent.inferenceTier, null);
  });
```

In `tests/cases-executor-child.test.js`, replace

```js
    assert.deepStrictEqual([agent.readOnly, agent.inferenceTier, agent.maxIterations], [true, 'standard', 20]);
```

with

```js
    assert.deepStrictEqual([agent.readOnly, agent.role, agent.maxIterations], [true, 'worker', 20]);
```

In `tests/models-headless.test.js`, replace

```js
    assert.deepStrictEqual(roles, { main: 'main', planner: 'main', 'code-writer': 'main', 'code-explorer': 'worker', 'case-researcher': 'worker' });
  });
```

with

```js
    assert.deepStrictEqual(roles, { main: 'main', planner: 'main', 'code-writer': 'main', 'code-explorer': 'worker', 'case-researcher': 'worker' });
    // No built-in agent names a model or a tier any more (spec §8).
    for (const id of Object.keys(roles)) {
      assert.strictEqual(agent(id).model, null, id);
      assert.strictEqual(agent(id).inferenceTier, null, id);
    }
    const templates = path.join(__dirname, '..', 'templates');
    for (const file of fs.readdirSync(templates).filter((f) => f.endsWith('.md.template'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(templates, file), 'utf8'), /agent\.inferenceTier|agent\.model\b/, file);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/agent-handlers.test.js tests/agent-loop.test.js tests/planner-agent.test.js tests/cases-executor-child.test.js tests/models-headless.test.js`
Expected: FAIL — parallel and serial ask for `main`, one executor serves two agents, `agent:list` returns `model`, the loop never compacts after the failover, the planner still has `inferenceTier: 'smart'`.

- [ ] **Step 3: One runtime per agent run**

In `src/ipc/agent-handlers.js`, after the `const { … } = context;` destructuring at the top of `registerAgentHandlers`, add:

```js
  const usageTracker = () => (typeof getUsageTracker === 'function' ? getUsageTracker() : null);

  const fullSystemPrompt = (runtime, memorySection) => [
    buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
    memorySection,
    formatUserContextSection(),
    formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
  ].filter((part) => typeof part === 'string').join('\n\n');

  // One runtime per agent run (models spec 2026-09-27 §8; M2 carry): each
  // agent, and each dependency task, resolves its own role and gets its own
  // routed provider, so concurrent agents never share a route's failover
  // state. `first` is a runtime the handler already built to fail fast; the
  // first run of that agent uses it.
  const perAgentExecutor = (event, systemPromptFor, first = null) => {
    let spare = first;
    return {
      execute: async (agent, message, options = {}) => {
        let runtime;
        if (spare && spare.agentId === agent.id) {
          runtime = spare.runtime;
          spare = null;
        } else {
          runtime = await createAgentRuntime({ role: roleForAgent(agent) }, event);
        }
        const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
          usageTracker: usageTracker(),
          prompter,
          failoverPolicy: NO_RETRY
        });
        return agentExecutor.execute(agent, message, {
          ...options,
          role: runtime.role,
          model: runtime.model,
          timeoutMs: runtime.timeoutMs,
          tools: runtime.toolDefinitions,
          systemPrompt: systemPromptFor(runtime)
        });
      }
    };
  };
```

In the `AGENT_LIST` handler, replace

```js
      model: agent.model,
      inferenceTier: agent.inferenceTier,
```

with

```js
      role: roleForAgent(agent),
```

Replace the whole `ipcMain.handle(IPC.AGENT_EXECUTE_PARALLEL, …)` registration (from `ipcMain.handle(IPC.AGENT_EXECUTE_PARALLEL` to its closing `}));`) with:

```js
  ipcMain.handle(IPC.AGENT_EXECUTE_PARALLEL, wrapHandler(IPC.AGENT_EXECUTE_PARALLEL, async (event, { agentIds = [], message }) => {
    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);
    const memorySection = await buildMemoryContextSection(message);
    const orchestrator = new AgentOrchestrator(perAgentExecutor(event, (runtime) => fullSystemPrompt(runtime, memorySection)));
    return withNotificationTiming('Parallel agent run', async () => {
      const results = await orchestrator.executeParallel(agents, message, {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });

      await Promise.all(
        (results || []).map(async (result, index) => {
          const agent = agents[index];
          if (!agent) return;
          const voiceOptions = buildAgentVoiceOptions(agent);
          if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
            return;
          }

          await speakSummaryText(buildAgentCompletionSummary(agent, result?.content || ''), voiceOptions);
        })
      );

      return results;
    });
  }));
```

In the `AGENT_EXECUTE_WITH_DEPS` handler, replace

```js
    const runtime = await createAgentRuntime({ role: roleForAgent(agent) }, event);
```

with

```js
    // Resolved once up front, so a role with no usable model fails before
    // any task exists; the first task reuses this runtime.
    const runtime = await createAgentRuntime({ role: roleForAgent(agent) }, event);
```

and replace

```js
    const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
      usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
      prompter,
      failoverPolicy: NO_RETRY
    });
    const orchestrator = new AgentOrchestrator(agentExecutor);

    return withNotificationTiming('Dependency-based agent run', async () => {
      const results = await orchestrator.executeWithDependencies(taskManager, [agent], {
        role: runtime.role,
        model: runtime.model,
        timeoutMs: runtime.timeoutMs,
        tools: runtime.toolDefinitions,
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings(),
        systemPrompt: [
          buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
          formatUserContextSection(),
          formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
        ].join('\n\n')
      });
```

with

```js
    const orchestrator = new AgentOrchestrator(perAgentExecutor(
      event,
      (rt) => fullSystemPrompt(rt, null),
      { agentId: agent.id, runtime }
    ));

    return withNotificationTiming('Dependency-based agent run', async () => {
      const results = await orchestrator.executeWithDependencies(taskManager, [agent], {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });
```

Replace the whole `ipcMain.handle(IPC.AGENT_EXECUTE_SERIAL, …)` registration (from `ipcMain.handle(IPC.AGENT_EXECUTE_SERIAL` to its closing `}));`) with:

```js
  ipcMain.handle(IPC.AGENT_EXECUTE_SERIAL, wrapHandler(IPC.AGENT_EXECUTE_SERIAL, async (event, { agentIds = [], message }) => {
    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);
    const memorySection = await buildMemoryContextSection(message);
    const orchestrator = new AgentOrchestrator(perAgentExecutor(event, (runtime) => fullSystemPrompt(runtime, memorySection)));
    return withNotificationTiming('Serial agent run', async () => {
      const results = await orchestrator.executeSerial(agents, message, {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });

      for (let index = 0; index < (results || []).length; index += 1) {
        const agent = agents[index];
        if (!agent) continue;
        const voiceOptions = buildAgentVoiceOptions(agent);
        if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
          continue;
        }

        await speakSummaryText(buildAgentCompletionSummary(agent, results[index]?.content || ''), voiceOptions);
      }

      return results;
    });
  }));
```

- [ ] **Step 4: Compaction follows the provider that answers**

In `src/execution/agent-loop.js`, in the constructor, replace

```js
    // Enable API compaction for Anthropic provider by default
    this.useAPICompaction = options.useAPICompaction
      ?? (provider?.getProviderName?.() === 'anthropic');
```

with

```js
    // API compaction is Anthropic's. An explicit option fixes it; otherwise
    // it follows the provider actually answering, call by call, so a routed
    // turn that failed over to another provider compacts that provider's
    // way (models M2 carry; spec 2026-09-27 §6.7).
    this._useAPICompaction = typeof options.useAPICompaction === 'boolean' ? options.useAPICompaction : null;
```

Replace

```js
      if (this.useAPICompaction && this.apiCompaction && this.apiCompaction.shouldCompact()) {
```

with

```js
      if (this._apiCompactionFor(this._currentProviderName()) && this.apiCompaction && this.apiCompaction.shouldCompact()) {
```

In `_recordCall`, replace

```js
    if (this.useAPICompaction && this.apiCompaction && !metrics.usagePartial) {
```

with

```js
    if (this._apiCompactionFor(metrics.provider || this._currentProviderName()) && this.apiCompaction && !metrics.usagePartial) {
```

and add these two methods just above `_recordCall`:

```js
  // The provider the next call goes to: a routed provider's current target,
  // else the provider's own name.
  _currentProviderName() {
    const current = typeof this.provider?.current === 'function' ? this.provider.current() : null;
    return current?.provider || this.provider?.getProviderName?.() || null;
  }

  _apiCompactionFor(providerName) {
    if (this._useAPICompaction !== null) return this._useAPICompaction;
    return providerName === 'anthropic';
  }
```

- [ ] **Step 5: Built-in agents without models or tiers**

In `src/agents/agent-schema.js`, replace

```js
    this.model = config.model || 'sonnet';
    this.inferenceTier = config.inferenceTier || 'standard';
```

with

```js
    // An agent never fixes a model: the profile's role decides (models spec
    // 2026-09-27 §8). A pre-M2 tier on a user-defined agent is read as the
    // mapped role when it names no role (§13 step 5).
    this.model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null;
    this.inferenceTier = typeof config.inferenceTier === 'string' && config.inferenceTier.trim() ? config.inferenceTier.trim() : null;
```

In `src/agents/agent-executor.js`, in `resolveTemplateContext`, replace

```js
        model: agent?.model,
        inferenceTier: agent?.inferenceTier,
```

with

```js
        role: agent?.role || null,
```

In each of `src/agents/builtin/main-assistant.js`, `src/agents/builtin/code-writer.js` and `src/agents/builtin/planner.js`, delete the line `  model: 'claude-sonnet-5',` and the line `  inferenceTier: '…',` (`'standard'` in main-assistant, `'smart'` in code-writer and planner). In `src/agents/builtin/case-researcher.js`, delete the line `  inferenceTier: 'standard',`.

In `templates/main-assistant.md.template` and `templates/code-writer.md.template`, replace

```
- Inference tier: {{agent.inferenceTier}}
- Model: {{agent.model}}
```

with

```
- Model role: {{agent.role}}
```

In `templates/planner.md.template`, replace

```
- Model: {{agent.model}}
```

with

```
- Model role: {{agent.role}}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/agent-handlers.test.js tests/agent-loop.test.js tests/planner-agent.test.js tests/cases-executor-child.test.js tests/models-headless.test.js tests/agent-executor.test.js tests/chat-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/agent-handlers.js src/execution/agent-loop.js src/agents/agent-schema.js src/agents/agent-executor.js src/agents/builtin/main-assistant.js src/agents/builtin/code-writer.js src/agents/builtin/planner.js src/agents/builtin/case-researcher.js templates/main-assistant.md.template templates/code-writer.md.template templates/planner.md.template tests/agent-handlers.test.js tests/agent-loop.test.js tests/planner-agent.test.js tests/cases-executor-child.test.js tests/models-headless.test.js
git commit -m "feat(models): each agent run gets its own role and route; built-in agents name no model; compaction follows the answering provider"
```

---

## Task 7: Workflow tasks name a role; a planned model must be in the profile

**Files:**
- Modify: `src/workflows/workflow-engine.js` (`create`'s task map; the `task.preferredModel` block in the task runner), `templates/planner.md.template` (the task JSON example; planning rule 6)
- Test: `tests/workflow-engine.test.js` (describe added); run `tests/workflow-handlers.test.js`, `tests/planner-agent.test.js`

**Interfaces:**
- Consumes: `agentExecutorAdapter.execute(agent, message, { role, model, requireInProfile })` (Task 1: `requireInProfile` makes the core match `model` against the turn's profile as `provider:model`, `provider/model` or a bare id, and refuse anything else).
- Produces: a workflow task carries `role` (a trimmed string or `null`); running it passes `options.role` when set, and a `preferredModel` as `options.model` with `options.requireInProfile: true` (never split into a provider). The planner template suggests a `role`, never a model.

- [ ] **Step 1: Write the failing test**

In `tests/workflow-engine.test.js`, inside `describe('WorkflowEngine', …)`, add:

```js
  describe('model roles (models spec 2026-09-27 §8)', () => {
    it('passes a task\'s role, and a planned model only for checking against the profile', async () => {
      const seen = [];
      engine.agentExecutorAdapter = {
        execute: async (_agent, _msg, opts) => {
          seen.push(opts);
          return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };
      const wf = await engine.create({
        tasks: [
          { id: 'a', title: 'A', description: 'Do A', role: ' utility ' },
          { id: 'b', title: 'B', description: 'Do B', preferredModel: 'ollama:gpt-oss:120b', dependsOn: ['a'] }
        ]
      });
      assert.strictEqual(wf.tasks[0].role, 'utility');
      assert.strictEqual(wf.tasks[1].role, null);
      await engine.run(wf.id);
      assert.strictEqual(seen[0].role, 'utility');
      assert.strictEqual('requireInProfile' in seen[0], false);
      assert.deepStrictEqual([seen[1].model, seen[1].requireInProfile, seen[1].provider], ['ollama:gpt-oss:120b', true, undefined]);
    });

    it('the planner suggests a role, never a model', () => {
      const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'planner.md.template'), 'utf8');
      assert.match(template, /"role":/);
      assert.doesNotMatch(template, /"preferredModel"/);
      assert.doesNotMatch(template, /vision tasks → gemini/);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/workflow-engine.test.js`
Expected: FAIL — `wf.tasks[0].role` is undefined, and `ollama:gpt-oss:120b` is split into provider `ollama` and model `gpt-oss`.

- [ ] **Step 3: Tasks carry a role; a planned model is checked**

In `src/workflows/workflow-engine.js`, in `create`'s `tasks: taskGraph.tasks.map((t) => ({ … }))`, after

```js
        agentId: t.agentId || 'main',
```

add

```js
        // The model role for this task (models spec 2026-09-27 §8), else the agent's.
        role: typeof t.role === 'string' && t.role.trim() ? t.role.trim() : null,
```

Replace

```js
    if (task.preferredModel) {
      // Parse "provider:model" format
      const parts = task.preferredModel.split(':');
      if (parts.length === 2) {
        executeOptions.provider = parts[0];
        executeOptions.model = parts[1];
      } else {
        executeOptions.model = task.preferredModel;
      }
    }
```

with

```js
    // The task's model role (models spec 2026-09-27 §8), else its agent's.
    if (task.role) executeOptions.role = task.role;
    // A planned preferredModel was written by the planner LLM, so it must
    // already be in the profile (M-D2): the core matches it as
    // "provider:model", "provider/model" or a bare id and refuses the rest.
    // It is never split here: an Ollama id has a colon of its own.
    if (task.preferredModel) {
      executeOptions.model = String(task.preferredModel).trim();
      executeOptions.requireInProfile = true;
    }
```

- [ ] **Step 4: The planner suggests a role**

In `templates/planner.md.template`, replace

```
      "preferredModel": "optional — suggest a specific provider:model if the task benefits from a particular model's strengths",
```

with

```
      "role": "optional — the model role for this task: utility for small mechanical jobs, main for hard reasoning; leave it out to use the agent's own role",
```

and replace

```
6. Suggest preferredModel when task characteristics strongly favor a specific model (e.g., vision tasks → gemini, fast simple tasks → groq, deep reasoning → anthropic opus).
```

with

```
6. Set role only when a task clearly needs more (main) or less (utility) than its agent's usual role. Never name a model: the owner assigns models to roles.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/workflow-engine.test.js tests/workflow-handlers.test.js tests/planner-agent.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/workflow-engine.js templates/planner.md.template tests/workflow-engine.test.js
git commit -m "feat(models): workflow tasks name a role; a planned model must already be in the profile"
```

---

## Task 8: The image tool uses the imageGeneration role; OCR tests the vision role first

**Files:**
- Modify: `src/tools/builtin/image-generate-tool.js` (a new `roleTarget`; `execute`; the `model` parameter's description), `src/core/create-core.js` (`extraToolOptions` in `createToolExecutorWithApprovals`), `src/cases/case-runtime.js` (a new `ensureVisionTested` after `ensureRoleTested`), `src/cases/ingest/index.js` (`_readPage`, before the OCR model pick)
- Test: `tests/image-generate-tool.test.js` (new), `tests/cases-roles.test.js` (one test added), `tests/cases-ingest-vision.test.js` (one test added); run `tests/cases-ingest-service.test.js`

**Interfaces:**
- Consumes: `TurnModels#resolve('imageGeneration')` → `{ targets, skipped, useSettings }` (M2: `useSettings: true` when the role is empty); `ensureTargetsTested(targets)`, `snapshotModels(options)` (`src/core/create-core.js`); `CaseRuntime#modelsFor(id)`, `host.ensureTargetsTested` (M2 final fix I2).
- Produces:
  - Every tool's execution options gain `turnModels` (the turn's frozen models, or `null`), `snapshotModels(options)` and `ensureTargetsTested(targets)`.
  - `ImageGenerate`: with a non-empty imageGeneration role it uses the first usable target whose provider it can generate through (`openai`), or the one `provider`/`model` names when that is a usable target of the role; anything else returns `{ ok: false, error }` naming the role's models or each skipped target's reasons. `context.createImageClient(provider, apiKey)` overrides the client (tests). With the role empty, today's `imageGeneration` settings apply unchanged.
  - `CaseRuntime#ensureVisionTested(id) → Promise<void>`: tests the vision role's candidate providers through `host.ensureTargetsTested`; never throws. `IngestService` calls it once per document, before the first page's OCR pick.

- [ ] **Step 1: Write the failing tests**

Create `tests/image-generate-tool.test.js`:

```js
// tests/image-generate-tool.test.js
// The image tool uses only models in the profile's imageGeneration role
// (models spec 2026-09-27 §8); with the role empty, the image settings apply.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const ImageGenerateTool = require('../src/tools/builtin/image-generate-tool');
const { createTurnModels } = require('../src/models/resolver');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const models = (imageGeneration, explain = usable) => createTurnModels({
  profile: { id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...(imageGeneration ? { imageGeneration } : {}) } },
  explain
});

function toolContext(turnModels, extra = {}) {
  const generated = [];
  return {
    generated,
    ctx: {
      turnModels,
      getSettings: () => ({}),
      getProviderToken: (p) => `${p}-key-123456`,
      createImageClient: (provider, apiKey) => ({
        getName: () => provider,
        getDefaultModel: () => 'default-image',
        generate: async (req) => {
          generated.push({ provider, apiKey, model: req.model });
          return [{ base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', fileName: 'a.png' }];
        }
      }),
      ...extra
    }
  };
}

describe('ImageGenerate on the imageGeneration role', () => {
  it('uses the role\'s first usable model', async () => {
    const { ctx, generated } = toolContext(models([t('openai', 'gpt-image-1')]));
    const out = await ImageGenerateTool.execute({ prompt: 'a lighthouse' }, ctx);
    assert.strictEqual(out.ok, true, out.error);
    assert.deepStrictEqual(generated, [{ provider: 'openai', apiKey: 'openai-key-123456', model: 'gpt-image-1' }]);
    assert.strictEqual(out.model, 'gpt-image-1');
  });

  it('refuses a model or provider outside the role', async () => {
    const { ctx, generated } = toolContext(models([t('openai', 'gpt-image-1')]));
    const other = await ImageGenerateTool.execute({ prompt: 'x', model: 'dall-e-3' }, ctx);
    const fal = await ImageGenerateTool.execute({ prompt: 'x', provider: 'fal' }, ctx);
    assert.match(other.error, /dall-e-3 is not a usable model in this profile's image generation role \(openai\/gpt-image-1\)/);
    assert.match(fal.error, /fal is not a usable model/);
    assert.deepStrictEqual(generated, []);
  });

  it('names why no model in the role can be used', async () => {
    const explain = () => ({ usable: false, reasons: ['No token saved for OpenAI.'], notes: [] });
    const { ctx } = toolContext(models([t('openai', 'gpt-image-1')], explain));
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.match(out.error, /No usable image generation model in the profile "Work": openai\/gpt-image-1 \(No token saved for OpenAI\.\)/);
  });

  it('skips a provider it cannot generate through, with the reason', async () => {
    const { ctx } = toolContext(models([t('google', 'imagen-4')]));
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.match(out.error, /google\/imagen-4 \(King Louie cannot generate images through google yet\.\)/);
  });

  it('keeps today\'s image settings when the role is empty', async () => {
    const { ctx } = toolContext(models(null), { getProviderToken: () => null });
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /OpenAI API key not configured/);
  });
});
```

In `tests/cases-roles.test.js`, inside `describe('CaseRuntime model roles', …)`, add:

```js
  it('ensureVisionTested tests the vision role\'s providers and never throws (models M2 carry)', async () => {
    const tested = [];
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { ensureTargetsTested: async (targets) => { tested.push(...targets.map((x) => `${x.provider}/${x.model}`)); } } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    await rt.ensureVisionTested(info.id);
    assert.deepStrictEqual(tested, ['openai/gpt-5.5']);
    const failing = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { ensureTargetsTested: async () => { throw new Error('offline'); } } });
    const other = await failing.createCase({ title: 'Lakeside lot' });
    await failing.ensureVisionTested(other.id);
  });
```

In `tests/cases-ingest-vision.test.js`, inside `describe('vision pages in IngestService', …)`, add:

```js
  it('tests the vision role\'s providers once per document, before its first page (models M2 carry)', async () => {
    const h = await ingestHarness();
    const seen = [];
    h.runtime.ensureVisionTested = async (id) => { seen.push([id, h.calls.filter((c) => c.purpose === 'ocr').length]); };
    await h.svc.store(h.caseId, { name: 'plat.pdf', bytes: await scan(2), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    assert.deepStrictEqual(seen, [[h.caseId, 0]]);
    assert.strictEqual(h.calls.filter((c) => c.purpose === 'ocr').length, 2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/image-generate-tool.test.js tests/cases-roles.test.js tests/cases-ingest-vision.test.js`
Expected: FAIL — the image tool ignores the role (it asks for the OpenAI settings key), `rt.ensureVisionTested` is not a function, `seen` stays empty.

- [ ] **Step 3: The image tool on its role**

In `src/tools/builtin/image-generate-tool.js`, after the whole `async function resolveProvider(settings, providerOverride, context) { … }`, add:

```js
// Image clients King Louie can generate through for a profile target
// (models spec 2026-09-27 §8). context.createImageClient overrides (tests).
const IMAGE_CLIENTS = Object.freeze({
  openai: (apiKey) => {
    const OpenAIImageProvider = require('../../media/image-generation/openai-provider');
    return new OpenAIImageProvider(apiKey);
  }
});

const targetName = (t) => `${t.provider}/${t.model}`;

// The profile's imageGeneration role (spec §8): when it lists models, the
// tool may use only those; empty, today's image settings apply. Returns
// { useSettings: true }, { target } or { error }.
async function roleTarget(params, context) {
  const models = context.turnModels
    || (typeof context.snapshotModels === 'function' ? context.snapshotModels({}) : null);
  if (!models) return { useSettings: true };
  if (typeof context.ensureTargetsTested === 'function') {
    try {
      await context.ensureTargetsTested(models.candidatesFor('imageGeneration'));
    } catch (err) {
      log.warn(`Testing the image generation providers failed: ${err.message}`);
    }
  }
  const resolved = models.resolve('imageGeneration');
  if (resolved.useSettings) return { useSettings: true };
  const listed = [...resolved.targets, ...resolved.skipped.map((s) => s.target)].map(targetName).join(', ');
  const skipped = [...resolved.skipped];
  const usable = [];
  for (const t of resolved.targets) {
    if (IMAGE_CLIENTS[t.provider]) usable.push(t);
    else skipped.push({ target: t, reasons: [`King Louie cannot generate images through ${t.provider} yet.`] });
  }
  const wantProvider = params.provider ? String(params.provider).trim().toLowerCase() : null;
  const wantModel = params.model ? String(params.model).trim() : null;
  if (wantProvider || wantModel) {
    const match = usable.find((t) => (!wantProvider || t.provider === wantProvider) && (!wantModel || t.model === wantModel));
    if (match) return { target: match };
    const asked = [wantProvider, wantModel].filter(Boolean).join('/');
    return { error: `${asked} is not a usable model in this profile's image generation role (${listed}). Use one of those, or leave provider and model out.` };
  }
  if (!usable.length) {
    const why = skipped.map((s) => `${targetName(s.target)} (${s.reasons.join(' ')})`).join('; ');
    return { error: `No usable image generation model in the profile "${models.profileName}": ${why}. Fix them in Settings → Models.` };
  }
  return { target: usable[0] };
}
```

In the `model` parameter, replace

```js
        description: 'Model to use. OpenAI: gpt-image-1 (default). Fal: fal-ai/flux/dev (default).'
```

with

```js
        description: 'Model to use. When the profile\'s image generation role lists models, only those may be used; leave it out to use the first. Otherwise OpenAI: gpt-image-1 (default), Fal: fal-ai/flux/dev (default).'
```

In `execute`, replace

```js
    let imageProvider;
    try {
      imageProvider = await resolveProvider(settings, providerOverride, context);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    try {
      const results = await imageProvider.generate({ prompt, model, size, quality, count });
```

with

```js
    let imageProvider;
    let modelToUse = model;
    try {
      const chosen = await roleTarget(params, context || {});
      if (chosen.error) return { ok: false, error: chosen.error };
      if (chosen.target) {
        let apiKey = null;
        try {
          apiKey = context?.getProviderToken?.(chosen.target.provider) || null;
        } catch (_) {
          apiKey = null;
        }
        if (!apiKey) return { ok: false, error: `No ${chosen.target.provider} key is saved. Add it under API keys.` };
        const create = typeof context?.createImageClient === 'function'
          ? context.createImageClient
          : (p, key) => IMAGE_CLIENTS[p](key);
        imageProvider = create(chosen.target.provider, apiKey);
        modelToUse = chosen.target.model;
      } else {
        imageProvider = await resolveProvider(settings, providerOverride, context);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }

    try {
      const results = await imageProvider.generate({ prompt, model: modelToUse, size, quality, count });
```

and replace

```js
      const modelName = model || imageProvider.getDefaultModel();
```

with

```js
      const modelName = modelToUse || imageProvider.getDefaultModel();
```

In `src/core/create-core.js`, in `createToolExecutorWithApprovals`'s `extraToolOptions`, after

```js
        getProviderToken: getDecryptedProviderToken,
```

add

```js
        // The turn's frozen models, for a tool limited to a role (the image
        // tool's imageGeneration, spec §8); a run with no parent turn uses
        // the default profile through snapshotModels.
        turnModels: executorOptions.turnModels || null,
        snapshotModels: (options) => snapshotModels(options),
        ensureTargetsTested: (targets) => ensureTargetsTested(targets),
```

- [ ] **Step 4: OCR tests the vision role first**

In `src/cases/case-runtime.js`, after the whole `async ensureRoleTested(id, role, { turn = null } = {}) { … }` method, add:

```js
  // Before case ingest reads a page on the vision role (models spec §8): the
  // role's providers are tested now if they never were, or retested once
  // after a stale non-auth failure, as ensureRoleTested does for the case
  // roles (M2 final-fix ruling). Never throws: the pick reports what is
  // still unusable.
  async ensureVisionTested(id) {
    const ensure = this.host?.ensureTargetsTested;
    if (typeof ensure !== 'function') return;
    try {
      await ensure(this.modelsFor(id).candidatesFor('vision'));
    } catch (err) {
      log.warn(`Testing the vision providers for case ${id} failed: ${err.message}`);
    }
  }
```

In `src/cases/ingest/index.js`, in `_readPage`, replace

```js
    let sel;
    try {
      sel = ctx.ocrModel || (ctx.ocrModel = this._ocrModel(meta.id, ctx.cfg));
```

with

```js
    // The vision role's providers are tested once per document, before its
    // first page (models spec §8; M2 final-fix ruling): a stale failed
    // status must not refuse OCR until something else retests the provider.
    if (!ctx.ocrModel && !ctx.visionTested && typeof this.runtime.ensureVisionTested === 'function') {
      ctx.visionTested = true;
      await this.runtime.ensureVisionTested(meta.id);
    }
    let sel;
    try {
      sel = ctx.ocrModel || (ctx.ocrModel = this._ocrModel(meta.id, ctx.cfg));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/image-generate-tool.test.js tests/cases-roles.test.js tests/cases-ingest-vision.test.js tests/cases-ingest-service.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/builtin/image-generate-tool.js src/core/create-core.js src/cases/case-runtime.js src/cases/ingest/index.js tests/image-generate-tool.test.js tests/cases-roles.test.js tests/cases-ingest-vision.test.js
git commit -m "feat(models): the image tool uses only the imageGeneration role's models; OCR tests the vision role's providers first"
```

---

## Task 9: The King Louie picking rules

**Files:**
- Create: `src/models/suggester.js`
- Modify: `src/models/index.js` (exports)
- Test: `tests/models-suggester.test.js` (new); run `tests/electron-boundary.test.js`

**Interfaces:**
- Consumes: `Availability#usable()` candidates `{ provider, model, name }` and catalog `Entry` fields `{ name, cost: { input, output }, scores: { intelligence, agentic }, toolCall, input[], output[], limits: { context }, local, reasoning: { efforts[] } }` (spec §4.2) — only through `candidateFromEntry`; nothing here calls either.
- Produces (all pure, in `src/models/suggester.js`):
  - `KING_LOUIE_DEFAULTS = { autoAccept: false, bandPoints: 3, workerAgenticRatio: 0.8, utilityIntelligenceRatio: 0.5, preferLocalUtility: false, blend: { input: 3, output: 1 }, dismissedProposalId: null }`; `mergeKingLouieSettings(raw) → same shape` (every field defaulted, `blend` merged key by key).
  - `candidateFromEntry(candidate, entry) → Candidate = { provider, model, name, cost, scores: { intelligence, agentic }, toolCall, imageInput, textOutput, imageOutput, context, local, efforts }` (an unknown model: `cost: null`, never picked).
  - `blendedRate(cost, blend) → number | null`; `lowestEffort(efforts) → string | null` (order `none, minimal, low, medium, high, xhigh, max`).
  - `pickRoles(candidates, settings) → { roles: { main, worker, utility, vision, imageGeneration }: Target[], reasons: { [role]: string[] } } | { unavailable: string }`.
  - `proposalId(roles) → 16 hex characters` (sha256 of the five role lists).
  - `buildProposal({ picks, current, usage, price, nameOf }) → { id | null, roles, reasons, changes: [{ role, from: NamedTarget[], to: NamedTarget[], reasons: string[], costEffect: { usd | null, note } }], costEffect: { usd | null, note }, upToDate }`; `price(target, usage) → usd | null`; `usage` is `UsageTracker#recentRoleUsage()`'s shape (Task 3); `NamedTarget = { provider, model, effort, name }`.

- [ ] **Step 1: Write the failing test**

Create `tests/models-suggester.test.js`:

```js
// tests/models-suggester.test.js
// The King Louie profile's picking rules (spec 2026-09-27 §7.1) and its
// proposals (§7.2): fixed candidates give fixed picks.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const S = require('../src/models/suggester');

const c = (provider, model, {
  input, output, intelligence = null, agentic = null, toolCall = true, context = 400000,
  imageInput = false, imageOutput = false, textOutput = true, local = false, efforts = []
} = {}) => ({
  provider, model, name: model,
  cost: input === undefined ? null : { input, output },
  scores: { intelligence, agentic },
  toolCall, imageInput, imageOutput, textOutput, context, local, efforts
});

// Blended rates (3 parts input to 1 output): big 11.25, sonnet 6, pro
// 3.4375, mini 0.6875, fast 0.0625, nano 0.1375, image 13.75, local 0.
const CANDIDATES = [
  c('openai', 'big', { input: 5, output: 30, intelligence: 60, agentic: 50, imageInput: true, efforts: ['none', 'low', 'medium', 'high'] }),
  c('anthropic', 'sonnet', { input: 3, output: 15, intelligence: 55, agentic: 48, imageInput: true }),
  c('google', 'pro', { input: 1.25, output: 10, intelligence: 58, agentic: 44, imageInput: true }),
  c('openai', 'mini', { input: 0.25, output: 2, intelligence: 40, agentic: 42, efforts: ['minimal', 'low', 'medium', 'high'] }),
  c('groq', 'fast', { input: 0.05, output: 0.1, intelligence: 32, toolCall: false, context: 128000 }),
  c('openai', 'nano', { input: 0.05, output: 0.4, intelligence: 25, agentic: 20 }),
  c('openai', 'image', { input: 5, output: 40, textOutput: false, imageOutput: true, toolCall: false }),
  c('xai', 'unpriced', { intelligence: 90, agentic: 90 }),
  c('mistral', 'unscored', { input: 0.01, output: 0.01 }),
  c('ollama', 'local', { input: 0, output: 0, local: true })
];

const ids = (list) => list.map((t) => `${t.provider}/${t.model}${t.effort ? `@${t.effort}` : ''}`);

describe('King Louie settings', () => {
  it('default to the spec\'s values and merge key by key', () => {
    assert.deepStrictEqual(S.mergeKingLouieSettings(undefined), { ...S.KING_LOUIE_DEFAULTS, blend: { input: 3, output: 1 } });
    const merged = S.mergeKingLouieSettings({ bandPoints: 5, blend: { output: 2 }, autoAccept: 'yes' });
    assert.deepStrictEqual([merged.bandPoints, merged.blend, merged.autoAccept, merged.workerAgenticRatio], [5, { input: 3, output: 2 }, false, 0.8]);
  });

  it('price by a blended rate, and pick the lowest effort offered', () => {
    assert.strictEqual(S.blendedRate({ input: 5, output: 30 }, { input: 3, output: 1 }), 11.25);
    assert.strictEqual(S.blendedRate(null), null);
    assert.strictEqual(S.lowestEffort(['high', 'low', 'minimal']), 'minimal');
    assert.strictEqual(S.lowestEffort([]), null);
  });

  it('read a candidate from its catalog entry; an unknown model has no price', () => {
    const entry = { name: 'Big', cost: { input: 5, output: 30 }, scores: { intelligence: 60, agentic: 50, source: 'artificial-analysis' }, toolCall: true, input: ['text', 'image'], output: ['text'], limits: { context: 400000 }, local: false, reasoning: { efforts: ['low'] } };
    assert.deepStrictEqual(S.candidateFromEntry({ provider: 'openai', model: 'big', name: 'big' }, entry), {
      provider: 'openai', model: 'big', name: 'Big', cost: { input: 5, output: 30 }, scores: { intelligence: 60, agentic: 50 },
      toolCall: true, imageInput: true, textOutput: true, imageOutput: false, context: 400000, local: false, efforts: ['low']
    });
    assert.strictEqual(S.candidateFromEntry({ provider: 'openai', model: 'x', name: 'x' }, null).cost, null);
  });
});

describe('pickRoles', () => {
  it('fixed candidates give fixed picks', () => {
    const { roles, reasons } = S.pickRoles(CANDIDATES, {});
    // main: big (50) and sonnet (48) are within 3 points; the cheaper wins.
    assert.deepStrictEqual(ids(roles.main), ['anthropic/sonnet', 'openai/big', 'google/pro']);
    // worker: agentic at least 0.8 × 48 and 128K context, cheapest first, spread.
    assert.deepStrictEqual(ids(roles.worker), ['openai/mini', 'google/pro', 'anthropic/sonnet']);
    // utility: intelligence at least 0.5 × 55, no tool need, lowest effort.
    assert.deepStrictEqual(ids(roles.utility), ['groq/fast', 'openai/mini@minimal', 'google/pro']);
    assert.deepStrictEqual(ids(roles.vision), ['google/pro', 'anthropic/sonnet', 'openai/big']);
    assert.deepStrictEqual(ids(roles.imageGeneration), ['openai/image']);
    assert.match(reasons.main[0], /sonnet: the cheapest of the 2 models within 3 points of the best agentic score \(50\)/);
    assert.match(reasons.worker[0], /at least 80% of main's \(48\)/);
    assert.match(reasons.utility[1], /at minimal effort/);
    for (const role of Object.keys(roles)) assert.strictEqual(reasons[role].length, roles[role].length, role);
  });

  it('never picks an unpriced or unscored model, nor a local one unless asked', () => {
    const all = Object.values(S.pickRoles(CANDIDATES, {}).roles).flat().map((t) => t.model);
    for (const never of ['unpriced', 'unscored', 'local']) assert.ok(!all.includes(never), never);
  });

  it('puts a local model with tool support first in utility when preferLocalUtility is on', () => {
    const { roles, reasons } = S.pickRoles(CANDIDATES, { preferLocalUtility: true });
    assert.deepStrictEqual(ids(roles.utility), ['ollama/local', 'groq/fast', 'openai/mini@minimal']);
    assert.match(reasons.utility[0], /local model with tool support/);
    // vision never takes the local preference.
    assert.ok(!roles.vision.some((t) => t.provider === 'ollama'));
  });

  it('follows its thresholds', () => {
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { workerAgenticRatio: 0.95 }).roles.worker), ['anthropic/sonnet', 'openai/big']);
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { bandPoints: 0 }).roles.main), ['openai/big', 'anthropic/sonnet', 'google/pro']);
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { utilityIntelligenceRatio: 1 }).roles.utility), ['google/pro', 'anthropic/sonnet', 'openai/big@none']);
  });

  it('says why when nothing can be main', () => {
    const out = S.pickRoles(CANDIDATES.filter((x) => ['unpriced', 'unscored', 'local', 'fast'].includes(x.model)), {});
    assert.match(out.unavailable, /No usable model that calls tools has both a price and an agentic score/);
    assert.deepStrictEqual(S.pickRoles([], {}).unavailable, out.unavailable);
  });

  it('a main pick with no intelligence score leaves utility and vision empty, with a reason', () => {
    const { roles, reasons } = S.pickRoles([c('openai', 'agent-only', { input: 1, output: 2, agentic: 50, imageInput: true })], {});
    assert.deepStrictEqual(ids(roles.main), ['openai/agent-only']);
    assert.deepStrictEqual(ids(roles.worker), ['openai/agent-only']);
    assert.deepStrictEqual([roles.utility, roles.vision], [[], []]);
    assert.match(reasons.utility[0], /no intelligence score/);
    assert.match(reasons.vision[0], /No usable image-reading model qualifies/);
  });
});

describe('buildProposal', () => {
  const picks = S.pickRoles(CANDIDATES, {});
  const price = (t) => ({ fast: 0.15, sonnet: 2, 'agent-only': 0.4 })[t.model] ?? null;

  it('proposes every picked role on first run, with a stable id', () => {
    const p = S.buildProposal({ picks, current: null, price, nameOf: (t) => t.model.toUpperCase() });
    assert.deepStrictEqual(p.changes.map((x) => x.role), ['main', 'worker', 'utility', 'vision', 'imageGeneration']);
    assert.match(p.id, /^[0-9a-f]{16}$/);
    assert.strictEqual(p.id, S.proposalId(picks.roles));
    assert.strictEqual(p.upToDate, false);
    assert.deepStrictEqual(p.changes[0].to[0], { provider: 'anthropic', model: 'sonnet', effort: null, name: 'SONNET' });
  });

  it('lists only the roles that change, and nothing once accepted', () => {
    const current = { ...picks.roles, utility: [{ provider: 'openai', model: 'mini', effort: null }] };
    assert.deepStrictEqual(S.buildProposal({ picks, current, price }).changes.map((x) => x.role), ['utility']);
    const same = S.buildProposal({ picks, current: picks.roles, price });
    assert.deepStrictEqual([same.upToDate, same.id, same.changes], [true, null, []]);
  });

  it('estimates the monthly cost effect from recent usage, repriced', () => {
    const usage = {
      utility: { calls: 10, unpricedCalls: 0, cost: 0.5, usage: { input: 1e6, cachedInput: 0, cacheWrite: 0, output: 1e6, reasoning: 0 } },
      main: { calls: 4, unpricedCalls: 1, cost: 1, usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0 } }
    };
    const p = S.buildProposal({ picks, current: null, usage, price });
    const effect = (role) => p.changes.find((x) => x.role === role).costEffect;
    assert.deepStrictEqual(effect('utility'), { usd: -0.35, note: '10 calls in the last 30 days, repriced.' });
    assert.strictEqual(effect('main').usd, 1);
    assert.match(effect('main').note, /1 were unpriced, so their recorded cost is incomplete/);
    assert.deepStrictEqual(effect('worker'), { usd: null, note: 'No recorded calls in the last 30 days.' });
    assert.strictEqual(p.costEffect.usd, 0.65);
  });

  it('prices an empty proposed role on the role it borrows from', () => {
    const lean = S.pickRoles([c('openai', 'agent-only', { input: 1, output: 2, agentic: 50 })], {});
    const usage = { utility: { calls: 2, unpricedCalls: 0, cost: 0.1, usage: { input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 } } };
    const p = S.buildProposal({ picks: lean, current: { main: [], worker: [], utility: [{ provider: 'groq', model: 'fast', effort: null }] }, usage, price });
    assert.deepStrictEqual(p.changes.find((x) => x.role === 'utility').costEffect.usd, 0.3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/models-suggester.test.js`
Expected: FAIL — `Cannot find module '../src/models/suggester'`.

- [ ] **Step 3: The picking rules**

Create `src/models/suggester.js`:

```js
// src/models/suggester.js
// The King Louie profile's picking rules (spec 2026-09-27 §7.1) and its
// proposals (§7.2), as pure functions over candidates: usable models with
// their catalog prices, scores and capabilities. Deterministic; every pick
// carries a one-line reason. Nothing here writes: the owner accepts.
const crypto = require('crypto');

const KING_LOUIE_DEFAULTS = Object.freeze({
  autoAccept: false,
  bandPoints: 3,
  workerAgenticRatio: 0.8,
  utilityIntelligenceRatio: 0.5,
  preferLocalUtility: false,
  blend: Object.freeze({ input: 3, output: 1 }),
  dismissedProposalId: null
});
const WORKER_MIN_CONTEXT = 128000;
const MAX_LIST = 3;
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PICKED_ROLES = Object.freeze(['main', 'worker', 'utility', 'vision', 'imageGeneration']);
const BORROW = Object.freeze({ utility: ['utility', 'worker', 'main'], worker: ['worker', 'main'] });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d) => (isNum(v) ? v : d);
const keyOf = (c) => `${c.provider}:${c.model}`;
const money = (rate) => `$${rate.toFixed(2)} per million tokens blended`;
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

function mergeKingLouieSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const blend = src.blend && typeof src.blend === 'object' && !Array.isArray(src.blend) ? src.blend : {};
  return {
    autoAccept: src.autoAccept === true,
    bandPoints: numOr(src.bandPoints, KING_LOUIE_DEFAULTS.bandPoints),
    workerAgenticRatio: numOr(src.workerAgenticRatio, KING_LOUIE_DEFAULTS.workerAgenticRatio),
    utilityIntelligenceRatio: numOr(src.utilityIntelligenceRatio, KING_LOUIE_DEFAULTS.utilityIntelligenceRatio),
    preferLocalUtility: src.preferLocalUtility === true,
    blend: {
      input: numOr(blend.input, KING_LOUIE_DEFAULTS.blend.input),
      output: numOr(blend.output, KING_LOUIE_DEFAULTS.blend.output)
    },
    dismissedProposalId: typeof src.dismissedProposalId === 'string' && src.dismissedProposalId ? src.dismissedProposalId : null
  };
}

// A usable model with what the catalog says about it. An unknown model has
// no price, so it is never picked (spec §5.1).
function candidateFromEntry(candidate, entry) {
  const e = entry && typeof entry === 'object' ? entry : null;
  const inputs = Array.isArray(e?.input) ? e.input : [];
  const outputs = Array.isArray(e?.output) ? e.output : [];
  return {
    provider: candidate.provider,
    model: candidate.model,
    name: e?.name || candidate.name || candidate.model,
    cost: e?.cost || null,
    scores: {
      intelligence: isNum(e?.scores?.intelligence) ? e.scores.intelligence : null,
      agentic: isNum(e?.scores?.agentic) ? e.scores.agentic : null
    },
    toolCall: e ? e.toolCall === true : false,
    imageInput: inputs.includes('image'),
    textOutput: outputs.includes('text'),
    imageOutput: outputs.includes('image'),
    context: isNum(e?.limits?.context) ? e.limits.context : null,
    local: Boolean(e?.local),
    efforts: Array.isArray(e?.reasoning?.efforts) ? [...e.reasoning.efforts] : []
  };
}

// Three parts input to one part output per million tokens (spec §7.1).
function blendedRate(cost, blend = KING_LOUIE_DEFAULTS.blend) {
  if (!cost || !isNum(cost.input) || !isNum(cost.output)) return null;
  const inPart = numOr(blend?.input, KING_LOUIE_DEFAULTS.blend.input);
  const outPart = numOr(blend?.output, KING_LOUIE_DEFAULTS.blend.output);
  if (!(inPart + outPart > 0)) return null;
  return (inPart * cost.input + outPart * cost.output) / (inPart + outPart);
}

function lowestEffort(efforts) {
  const list = Array.isArray(efforts) ? efforts : [];
  return EFFORT_ORDER.find((e) => list.includes(e)) || list[0] || null;
}

// Up to MAX_LIST, in order, first preferring a provider not yet listed
// (spec §7.1: spread across providers, which also gives verify a family).
function spread(ordered) {
  const out = [];
  const seen = new Set();
  for (const newProviderOnly of [true, false]) {
    for (const c of ordered) {
      if (out.length >= MAX_LIST) return out;
      if (seen.has(keyOf(c))) continue;
      if (newProviderOnly && out.some((x) => x.provider === c.provider)) continue;
      out.push(c);
      seen.add(keyOf(c));
    }
  }
  return out;
}

function pickRoles(candidates, rawSettings = {}) {
  const s = mergeKingLouieSettings(rawSettings);
  const all = (Array.isArray(candidates) ? candidates : []).filter(Boolean).map((c) => ({ ...c, rate: blendedRate(c.cost, s.blend) }));
  const priced = all.filter((c) => c.rate !== null);
  const byCost = (a, b) => a.rate - b.rate || keyOf(a).localeCompare(keyOf(b));
  const intel = (c) => (isNum(c.scores?.intelligence) ? c.scores.intelligence : null);
  const agentic = (c) => (isNum(c.scores?.agentic) ? c.scores.agentic : null);
  const target = (c, effort = null) => ({ provider: c.provider, model: c.model, effort });
  const failover = (c) => `${c.name}: failover, the next cheapest that qualifies.`;

  // main: tool calling, ranked by agentic then intelligence; within the
  // band of the best, the cheaper wins.
  const mainPool = priced.filter((c) => c.textOutput && c.toolCall && agentic(c) !== null);
  if (!mainPool.length) {
    return { unavailable: 'No usable model that calls tools has both a price and an agentic score, so King Louie cannot propose a main model. Add a key for a provider whose models are scored, or fill a profile by hand.' };
  }
  const ranked = [...mainPool].sort((a, b) => (agentic(b) - agentic(a))
    || ((intel(b) ?? -1) - (intel(a) ?? -1))
    || byCost(a, b));
  const best = agentic(ranked[0]);
  const band = ranked.filter((c) => agentic(c) >= best - s.bandPoints);
  const first = [...band].sort(byCost)[0];
  const mainA = agentic(first);
  const mainI = intel(first);
  const roles = {};
  const reasons = {};

  const mainList = spread([first, ...ranked.filter((c) => c !== first)]);
  roles.main = mainList.map((c) => target(c));
  reasons.main = mainList.map((c, i) => {
    if (i > 0) return `${c.name}: failover, agentic ${agentic(c)}${c.provider !== first.provider ? ', another provider' : ''}.`;
    return band.length > 1
      ? `${c.name}: the cheapest of the ${band.length} models within ${s.bandPoints} points of the best agentic score (${best}); agentic ${mainA}, ${money(c.rate)}.`
      : `${c.name}: the best agentic score among usable tool-calling models (${mainA}), ${money(c.rate)}.`;
  });

  // worker: tool calling, 128K context, agentic at least the ratio of main's.
  const workerList = spread(priced
    .filter((c) => c.textOutput && c.toolCall && isNum(c.context) && c.context >= WORKER_MIN_CONTEXT
      && agentic(c) !== null && agentic(c) >= s.workerAgenticRatio * mainA)
    .sort(byCost));
  roles.worker = workerList.map((c) => target(c));
  reasons.worker = workerList.length
    ? workerList.map((c, i) => (i === 0
      ? `${c.name}: the cheapest tool-calling model with at least 128K context whose agentic score (${agentic(c)}) is at least ${pct(s.workerAgenticRatio)} of main's (${mainA}), ${money(c.rate)}.`
      : failover(c)))
    : [`No usable model qualifies (tool calling, 128K context, an agentic score at least ${pct(s.workerAgenticRatio)} of main's ${mainA}); worker borrows from main.`];

  // utility: no tool need, intelligence at least the ratio of main's, at
  // the lowest effort; a local model with tools first when asked.
  const localFirst = s.preferLocalUtility
    ? all.filter((c) => c.local && c.toolCall && c.textOutput).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
    : [];
  const utilityPool = mainI === null
    ? []
    : priced.filter((c) => c.textOutput && intel(c) !== null && intel(c) >= s.utilityIntelligenceRatio * mainI).sort(byCost);
  const utilityList = spread([...localFirst, ...utilityPool]);
  roles.utility = utilityList.map((c) => target(c, lowestEffort(c.efforts)));
  let firstPriced = true;
  reasons.utility = utilityList.length
    ? utilityList.map((c) => {
      const effort = lowestEffort(c.efforts);
      const at = effort ? `, at ${effort} effort` : '';
      if (localFirst.includes(c)) return `${c.name}: a local model with tool support, preferred for utility${at}.`;
      if (!firstPriced) return `${c.name}: failover, the next cheapest that qualifies${at}.`;
      firstPriced = false;
      return `${c.name}: the cheapest model whose intelligence score (${intel(c)}) is at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}), ${money(c.rate)}${at}.`;
    })
    : [mainI === null
      ? 'Main\'s pick has no intelligence score to compare against, so no model qualifies; utility borrows from worker, then main.'
      : `No usable model has an intelligence score at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}); utility borrows from worker, then main.`];

  // vision: as utility, with image input, without the local preference.
  const visionList = mainI === null
    ? []
    : spread(priced
      .filter((c) => c.textOutput && c.imageInput && intel(c) !== null && intel(c) >= s.utilityIntelligenceRatio * mainI)
      .sort(byCost));
  roles.vision = visionList.map((c) => target(c));
  reasons.vision = visionList.length
    ? visionList.map((c, i) => (i === 0
      ? `${c.name}: the cheapest image-reading model whose intelligence score (${intel(c)}) is at least ${pct(s.utilityIntelligenceRatio)} of main's (${mainI}), ${money(c.rate)}.`
      : failover(c)))
    : ['No usable image-reading model qualifies; vision uses the first image-capable model in utility, worker or main.'];

  // imageGeneration: priced image-output models, cheapest first.
  const imageList = spread(priced.filter((c) => c.imageOutput).sort(byCost));
  roles.imageGeneration = imageList.map((c) => target(c));
  reasons.imageGeneration = imageList.length
    ? imageList.map((c, i) => (i === 0 ? `${c.name}: the cheapest priced image model, ${money(c.rate)}.` : failover(c)))
    : ['No priced image model is usable; the image generation settings keep applying.'];

  return { roles, reasons };
}

const normTarget = (t) => ({ provider: t.provider, model: t.model, effort: t.effort || null });
const sameTargets = (a = [], b = []) => JSON.stringify(a.map(normTarget)) === JSON.stringify(b.map(normTarget));

function proposalId(roles) {
  const body = JSON.stringify(PICKED_ROLES.map((r) => [r, (roles?.[r] || []).map(normTarget)]));
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

// The first model a role would call under the proposal, borrowing as the
// resolver does (spec §6.4) when the role itself is empty.
function firstTarget(roles, role) {
  for (const r of BORROW[role] || [role]) {
    if (Array.isArray(roles?.[r]) && roles[r].length) return roles[r][0];
  }
  return null;
}

// A changed role's recent recorded calls, repriced on its proposed first
// model, minus what they were recorded as costing (spec §7.2).
function costEffectFor(role, roles, usage, price) {
  const u = usage?.[role];
  if (!u || !u.calls) return { usd: null, note: 'No recorded calls in the last 30 days.' };
  const to = firstTarget(roles, role);
  if (!to) return { usd: null, note: 'Nothing to price: this role would have no model.' };
  const next = price(to, u.usage || {});
  if (!isNum(next)) return { usd: null, note: `${to.model} is unpriced.` };
  const usd = Number((next - (Number(u.cost) || 0)).toFixed(8));
  const note = u.unpricedCalls
    ? `${u.calls} calls in the last 30 days, repriced; ${u.unpricedCalls} were unpriced, so their recorded cost is incomplete.`
    : `${u.calls} calls in the last 30 days, repriced.`;
  return { usd, note };
}

function buildProposal({ picks, current = null, usage = {}, price = () => null, nameOf = (t) => t.model } = {}) {
  const named = (t) => ({ ...normTarget(t), name: nameOf(t) });
  const changes = PICKED_ROLES
    .filter((role) => !sameTargets(current?.[role] || [], picks.roles[role] || []))
    .map((role) => ({
      role,
      from: (current?.[role] || []).map(named),
      to: (picks.roles[role] || []).map(named),
      reasons: picks.reasons[role] || [],
      costEffect: costEffectFor(role, picks.roles, usage, price)
    }));
  const estimates = changes.map((x) => x.costEffect.usd).filter(isNum);
  const costEffect = estimates.length
    ? {
      usd: Number(estimates.reduce((a, b) => a + b, 0).toFixed(8)),
      note: `Estimated from the last 30 days of recorded calls${estimates.length < changes.length ? '; some changed roles have no estimate' : ''}.`
    }
    : { usd: null, note: 'No estimate: no recorded calls to reprice for the changed roles.' };
  return {
    id: changes.length ? proposalId(picks.roles) : null,
    roles: picks.roles,
    reasons: picks.reasons,
    changes,
    costEffect,
    upToDate: changes.length === 0
  };
}

module.exports = {
  KING_LOUIE_DEFAULTS,
  WORKER_MIN_CONTEXT,
  PICKED_ROLES,
  mergeKingLouieSettings,
  candidateFromEntry,
  blendedRate,
  lowestEffort,
  pickRoles,
  proposalId,
  buildProposal
};
```

In `src/models/index.js`, after

```js
const { runTierMigration, needsMigration } = require('./migrate-tiers');
```

add

```js
const suggester = require('./suggester');
```

and in `module.exports`, after `needsMigration,` add:

```js
  suggester,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/models-suggester.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/models/suggester.js src/models/index.js tests/models-suggester.test.js
git commit -m "feat(models): the King Louie picking rules and proposals, as pure functions"
```

---

## Task 10: The King Louie profile: proposals the owner accepts

**Files:**
- Create: `src/models/king-louie.js`
- Modify: `src/models/index.js` (export), `src/core/settings.js` (require; `DEFAULT_SETTINGS.models.kingLouie`; the `models` merge), `src/core/create-core.js` (require; build `kingLouie` after `profiles`; `createModelChoices`'s arguments; `shutdown`; `models` on the returned core; `context.getKingLouie`), `src/core/model-choices.js` (requires; `kingLouie` dependency; `saveProfile` refuses the King Louie profile; five new functions), `src/ipc/constants.js` (five constants), `src/ipc/models-handlers.js` (five handlers), `preload.js` (`window.electron.models`), `src/desktop-bridge/allowlist.js` (`RENDERER_EVENTS`)
- Test: `tests/models-king-louie.test.js` (new), `tests/models-profiles-ipc.test.js` (setup and one test extended, one describe added); run `tests/ipc-contract.test.js`, `tests/ipc-constants.test.js`, `tests/desktop-bridge-allowlist.test.js`, `tests/model-choices.test.js`, `tests/core-settings.test.js`, `tests/electron-boundary.test.js`, `tests/models-core-profiles.test.js`

**Interfaces:**
- Consumes: `pickRoles`, `buildProposal`, `candidateFromEntry`, `mergeKingLouieSettings` (Task 9); `Profiles#list/create/update` and `ProfileError` (`src/models/profiles.js`; `create` accepts `kind: 'king-louie'`); `Availability#usable({ needs })`, its `changed` event; `Catalog#get`, `#price(provider, model, usage) → { usd } | null`, its `updated` event; `UsageTracker#recentRoleUsage({ days })` (Task 3); `profileView` (`src/models/profile-view.js`).
- Produces:
  - `class KingLouieProfile extends EventEmitter` (`src/models/king-louie.js`), `new KingLouieProfile({ profiles, availability, catalog, getSettings, setSettings, getRecentUsage, debounceMs = 200 })`, with `settings()`, `profile() → Profile | null` (the one of `kind: 'king-louie'`), `candidates()`, `propose() → buildProposal(…) & { dismissed } | { unavailable }`, `view() → KingLouieView`, `accept(proposalId) → Profile`, `dismiss(proposalId) → { dismissed }`, `saveSettings(patch) → settings`, `duplicateAsProfile({ name }) → Profile`, `refresh()`, `inputsChanged()` (debounced `refresh`), `stop()`; emits `'proposal'` with a `KingLouieView`. Errors are `ProfileError` with `code` `NO_PROPOSAL`, `STALE_PROPOSAL` or `BAD_SETTING`. `KING_LOUIE_NAME = 'King Louie selected'`.
  - `KingLouieView = { profile: { id, name } | null, current: { [role]: NamedTarget[] } | null, proposal: { id, changes, costEffect, dismissed } | null, upToDate, unavailable: string | null, settings: { autoAccept, bandPoints, workerAgenticRatio, utilityIntelligenceRatio, preferLocalUtility } }`.
  - Settings `models.kingLouie` (Task 9's `KING_LOUIE_DEFAULTS`), merged through `mergeKingLouieSettings`.
  - The core builds one `KingLouieProfile` (`core.models.kingLouie`, `context.getKingLouie()`), recomputes it on `catalog` `updated` and `availability` `changed`, and sends `models:proposalChanged` with the view.
  - `createModelChoices({ …, kingLouie })` gains `kingLouieView()`, `acceptProposal(id) → ProfileView`, `dismissProposal(id)`, `saveKingLouieSettings(patch) → KingLouieView`, `duplicateKingLouie({ name }) → ProfileView`; `saveProfile` refuses a `king-louie` profile with `ProfileError('KING_LOUIE_READ_ONLY', …)`.
  - IPC: `MODELS_KING_LOUIE 'models:kingLouie'`, `MODELS_ACCEPT_PROPOSAL 'models:acceptProposal'`, `MODELS_DISMISS_PROPOSAL 'models:dismissProposal'`, `MODELS_SAVE_KING_LOUIE_SETTINGS 'models:saveKingLouieSettings'`, `MODELS_DUPLICATE_KING_LOUIE 'models:duplicateKingLouie'`; `window.electron.models.{ kingLouie(), acceptProposal(proposalId), dismissProposal(proposalId), saveKingLouieSettings(payload), duplicateKingLouie(payload), onProposalChanged(callback) }`; `models:proposalChanged` is a renderer event.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-king-louie.test.js`:

```js
// tests/models-king-louie.test.js
// The King Louie profile (spec 2026-09-27 §7.2): proposals from the usable
// models, accepted only by the owner (or auto-accept), dismissed until the
// picks change, and recomputed when an input changes.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Profiles } = require('../src/models/profiles');
const { KingLouieProfile } = require('../src/models/king-louie');
const { createModelChoices } = require('../src/core/model-choices');
const { mergeSettings } = require('../src/core/settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const entry = (name, { input, output, intelligence = null, agentic = null, toolCall = true, context = 400000, efforts = [] }) => ({
  name,
  cost: input === undefined ? null : { input, output },
  scores: { intelligence, agentic },
  toolCall,
  input: ['text'],
  output: ['text'],
  limits: { context },
  local: false,
  reasoning: { efforts }
});

// Picks: main sonnet, big, mini; worker mini, sonnet, big; utility fast,
// mini (minimal effort), sonnet.
const ENTRIES = {
  'openai:big': entry('Big', { input: 5, output: 30, intelligence: 60, agentic: 50 }),
  'anthropic:sonnet': entry('Sonnet', { input: 3, output: 15, intelligence: 55, agentic: 48 }),
  'openai:mini': entry('Mini', { input: 0.25, output: 2, intelligence: 40, agentic: 42, efforts: ['minimal', 'low'] }),
  'groq:fast': entry('Fast', { input: 0.05, output: 0.1, intelligence: 32, toolCall: false, context: 128000 })
};

function memorySettings(initial = {}) {
  let settings = mergeSettings(initial);
  return { getSettings: () => settings, setSettings: (next) => { settings = mergeSettings(next); } };
}

function setup({ usable = Object.keys(ENTRIES), models = {}, usage = {} } = {}) {
  const mem = memorySettings({
    models: {
      profiles: [{ id: 'p-mine', name: 'Mine', kind: 'user', roles: { main: [{ provider: 'openai', model: 'big', effort: null }], worker: [], utility: [] } }],
      defaultProfileId: 'p-mine',
      ...models
    }
  });
  const state = { usable };
  const catalog = {
    get: (p, m) => (ENTRIES[`${p}:${m}`] ? structuredClone(ENTRIES[`${p}:${m}`]) : null),
    price: (p, m, u) => {
      const e = ENTRIES[`${p}:${m}`];
      return e?.cost ? { usd: ((u.input || 0) * e.cost.input + (u.output || 0) * e.cost.output) / 1e6 } : null;
    }
  };
  const availability = {
    usable: () => state.usable.map((key) => {
      const [provider, model] = key.split(':');
      return { provider, model, name: model };
    })
  };
  let n = 0;
  const profiles = new Profiles({ getSettings: mem.getSettings, setSettings: mem.setSettings, createId: () => `id${++n}` });
  const kl = new KingLouieProfile({ profiles, availability, catalog, getSettings: mem.getSettings, setSettings: mem.setSettings, getRecentUsage: () => usage, debounceMs: 5 });
  return { kl, profiles, mem, state, catalog };
}

describe('the King Louie profile', () => {
  it('defaults its settings through mergeSettings', () => {
    assert.deepStrictEqual(mergeSettings({}).models.kingLouie, {
      autoAccept: false, bandPoints: 3, workerAgenticRatio: 0.8, utilityIntelligenceRatio: 0.5,
      preferLocalUtility: false, blend: { input: 3, output: 1 }, dismissedProposalId: null
    });
    assert.deepStrictEqual(mergeSettings({ models: { kingLouie: { blend: { output: 2 } } } }).models.kingLouie.blend, { input: 3, output: 2 });
  });

  it('starts as a proposal; accepting creates it and leaves the default alone', () => {
    const { kl, profiles } = setup();
    assert.strictEqual(kl.profile(), null);
    const p = kl.propose();
    assert.deepStrictEqual(p.changes.map((c) => c.role), ['main', 'worker', 'utility']);
    assert.deepStrictEqual(p.roles.main.map((t) => t.model), ['sonnet', 'big', 'mini']);
    assert.deepStrictEqual(p.changes[0].to.map((t) => t.name), ['Sonnet', 'Big', 'Mini']);
    const saved = kl.accept(p.id);
    assert.deepStrictEqual([saved.kind, saved.name], ['king-louie', 'King Louie selected']);
    assert.deepStrictEqual(saved.roles.utility, [
      { provider: 'groq', model: 'fast', effort: null },
      { provider: 'openai', model: 'mini', effort: 'minimal' },
      { provider: 'anthropic', model: 'sonnet', effort: null }
    ]);
    assert.strictEqual(profiles.defaultId(), 'p-mine');
    assert.strictEqual(kl.propose().upToDate, true);
    assert.strictEqual(kl.view().upToDate, true);
  });

  it('accepting a proposal that changed since it was shown is refused and writes nothing', () => {
    const { kl, state, mem } = setup();
    const shown = kl.propose();
    state.usable = ['openai:big', 'openai:mini']; // a key was removed meanwhile
    const before = JSON.stringify(mem.getSettings().models.profiles);
    assert.throws(() => kl.accept(shown.id), (err) => err.code === 'STALE_PROPOSAL');
    assert.strictEqual(JSON.stringify(mem.getSettings().models.profiles), before);
  });

  it('a dismissed proposal stays hidden until the proposed models change', () => {
    const { kl, state } = setup();
    const first = kl.propose();
    kl.dismiss(first.id);
    assert.strictEqual(kl.propose().dismissed, true);
    assert.strictEqual(kl.view().proposal.dismissed, true);
    state.usable = ['openai:big', 'openai:mini', 'groq:fast'];
    const next = kl.propose();
    assert.notStrictEqual(next.id, first.id);
    assert.strictEqual(next.dismissed, false);
  });

  it('auto-accept takes a new proposal but never a dismissed one', () => {
    const { kl } = setup();
    kl.dismiss(kl.propose().id);
    kl.saveSettings({ autoAccept: true });
    assert.strictEqual(kl.profile(), null, 'a dismissed proposal is not auto-accepted');
    const { kl: fresh } = setup({ models: { kingLouie: { autoAccept: true } } });
    fresh.refresh();
    assert.strictEqual(fresh.profile().kind, 'king-louie');
  });

  it('recomputes once per burst of input changes and tells its listeners', async () => {
    const { kl } = setup();
    const views = [];
    kl.on('proposal', (v) => views.push(v));
    kl.inputsChanged();
    kl.inputsChanged();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(views.length, 1);
    assert.match(views[0].proposal.id, /^[0-9a-f]{16}$/);
  });

  it('says why when it cannot propose, and changes nothing', () => {
    const { kl } = setup({ usable: ['groq:fast'] });
    assert.match(kl.view().unavailable, /No usable model that calls tools has both a price and an agentic score/);
    assert.throws(() => kl.accept('anything'), (err) => err.code === 'NO_PROPOSAL');
    assert.strictEqual(kl.profile(), null);
  });

  it('estimates each change\'s monthly cost effect from recent usage', () => {
    const { kl } = setup({ usage: { utility: { calls: 10, unpricedCalls: 0, cost: 0.5, usage: { input: 1e6, cachedInput: 0, cacheWrite: 0, output: 1e6, reasoning: 0 } } } });
    const utility = kl.propose().changes.find((c) => c.role === 'utility');
    assert.deepStrictEqual(utility.costEffect, { usd: -0.35, note: '10 calls in the last 30 days, repriced.' });
  });

  it('"Duplicate as my profile" copies the picks into an ordinary profile', () => {
    const { kl } = setup();
    const copy = kl.duplicateAsProfile();
    assert.deepStrictEqual([copy.kind, copy.name], ['user', 'King Louie selected copy']);
    assert.deepStrictEqual(copy.roles.main.map((t) => t.model), ['sonnet', 'big', 'mini']);
  });

  it('checks its settings', () => {
    const { kl } = setup();
    assert.throws(() => kl.saveSettings({ bandPoints: -1 }), /The band is a number from 0 to 50/);
    assert.throws(() => kl.saveSettings({ workerAgenticRatio: 2 }), /The worker ratio is a number from 0 to 1/);
    assert.strictEqual(kl.saveSettings({ workerAgenticRatio: 0.95 }).workerAgenticRatio, 0.95);
  });
});

describe('the King Louie profile in the model choices', () => {
  const choicesFor = (kl, profiles) => createModelChoices({
    profiles,
    kingLouie: kl,
    explainTarget: () => ({ usable: true, reasons: [], notes: [] }),
    snapshotModels: () => null,
    getChats: () => [],
    setChats: () => {},
    appendMessageToChat: () => null
  });

  it('accepts, dismisses and duplicates through the choices, and keeps the profile out of the editor', () => {
    const { kl, profiles } = setup();
    const choices = choicesFor(kl, profiles);
    const view = choices.kingLouieView();
    const accepted = choices.acceptProposal(view.proposal.id);
    assert.strictEqual(accepted.kind, 'king-louie');
    assert.throws(
      () => choices.saveProfile({ id: accepted.id, name: 'Mine now', roles: { main: [] } }),
      (err) => err.code === 'KING_LOUIE_READ_ONLY' && /Duplicate it to make your own/.test(err.message)
    );
    assert.strictEqual(choices.duplicateKingLouie({}).kind, 'user');
    assert.strictEqual(choices.saveKingLouieSettings({ preferLocalUtility: true }).settings.preferLocalUtility, true);
  });
});

describe('the King Louie profile in the core', () => {
  const tempDirs = [];
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  afterEach(() => {
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('is built with the core and pushes its view when a provider\'s status changes', async () => {
    const { createCore } = require('../src/core');
    const { JsonFileStore } = require('../src/platform/json-file-store');
    const { createAesGcmCipher } = require('../src/platform/cipher');
    const { createHeadlessPrompter } = require('../src/platform/prompter');
    delete process.env.KL_CASES_ROOT;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-king-louie-'));
    tempDirs.push(dataDir);
    const sent = [];
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      ui: { send: (channel, payload) => sent.push({ channel, payload }) }
    });
    try {
      await core.start();
      assert.strictEqual(core.models.kingLouie, core.context.getKingLouie());
      // A fresh install has no tested keys, so nothing can be proposed yet.
      assert.match(core.context.getModelChoices().kingLouieView().unavailable, /No usable model/);
      core.models.availability.emit('changed', { provider: 'openai', status: null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(sent.some((e) => e.channel === 'models:proposalChanged' && e.payload.unavailable), JSON.stringify(sent.map((e) => e.channel)));
    } finally {
      await core.shutdown();
    }
  });
});
```

In `tests/models-profiles-ipc.test.js`, in `setup()`'s `choices` object, after `setMainOverride: …,` add:

```js
    kingLouieView: () => ({ proposal: { id: 'abc' } }),
    acceptProposal: (id) => { calls.push(['accept', id]); return { id: 'p-kl', kind: 'king-louie' }; },
    dismissProposal: (id) => { calls.push(['dismiss', id]); return { dismissed: id }; },
    saveKingLouieSettings: (patch) => { calls.push(['klSettings', patch]); return { settings: patch }; },
    duplicateKingLouie: ({ name }) => { calls.push(['klDuplicate', name]); return { id: 'p-copy', kind: 'user' }; },
```

In `it('are exposed on window.electron.models in the preload bridge', …)`, replace

```js
    for (const ch of ['profiles', 'saveProfile', 'duplicateProfile', 'removeProfile', 'setDefaultProfile', 'picker', 'chatView', 'setChatProfile', 'setMainOverride', 'saveCatalogSettings']) {
```

with

```js
    for (const ch of ['profiles', 'saveProfile', 'duplicateProfile', 'removeProfile', 'setDefaultProfile', 'picker', 'chatView', 'setChatProfile', 'setMainOverride', 'saveCatalogSettings', 'kingLouie', 'acceptProposal', 'dismissProposal', 'saveKingLouieSettings', 'duplicateKingLouie']) {
```

and add at the end of the file:

```js
describe('King Louie profile channels (spec §7, §11)', () => {
  it('pass through to the model choices, keeping only the known settings', async () => {
    const { call, calls } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_KING_LOUIE), { ok: true, view: { proposal: { id: 'abc' } } });
    assert.strictEqual((await call(IPC.MODELS_ACCEPT_PROPOSAL, { proposalId: 'abc' })).profile.kind, 'king-louie');
    assert.strictEqual((await call(IPC.MODELS_DISMISS_PROPOSAL, { proposalId: 'abc' })).ok, true);
    await call(IPC.MODELS_SAVE_KING_LOUIE_SETTINGS, { autoAccept: true, bandPoints: 4, junk: 1 });
    assert.strictEqual((await call(IPC.MODELS_DUPLICATE_KING_LOUIE, {})).profile.kind, 'user');
    assert.deepStrictEqual(calls.slice(-4), [['accept', 'abc'], ['dismiss', 'abc'], ['klSettings', { autoAccept: true, bandPoints: 4 }], ['klDuplicate', undefined]]);
  });

  it('models:proposalChanged reaches an attached desktop', () => {
    const { isRendererEvent } = require('../src/desktop-bridge/allowlist');
    assert.strictEqual(isRendererEvent('models:proposalChanged'), true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-king-louie.test.js tests/models-profiles-ipc.test.js`
Expected: FAIL — `Cannot find module '../src/models/king-louie'`; `IPC.MODELS_KING_LOUIE` is undefined.

- [ ] **Step 3: KingLouieProfile**

Create `src/models/king-louie.js`:

```js
// src/models/king-louie.js
// The King Louie profile (spec 2026-09-27 §7): proposes models for each
// role from the usable models, their prices and their scores
// (./suggester.js); nothing changes until the owner accepts, or
// models.kingLouie.autoAccept is on. A dismissed proposal stays hidden until
// the proposed models change. The profile itself (kind 'king-louie') is
// created by the first accept.
const EventEmitter = require('events');
const { createLogger } = require('../logging');
const { ProfileError } = require('./profiles');
const S = require('./suggester');

const log = createLogger('models/king-louie');
const KING_LOUIE_NAME = 'King Louie selected';

class KingLouieProfile extends EventEmitter {
  constructor({ profiles, availability, catalog = null, getSettings, setSettings, getRecentUsage = () => ({}), debounceMs = 200 } = {}) {
    super();
    for (const [name, value] of Object.entries({ profiles, availability, getSettings, setSettings })) {
      if (!value) throw new Error(`KingLouieProfile needs ${name}.`);
    }
    this.profiles = profiles;
    this.availability = availability;
    this.catalog = catalog;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.getRecentUsage = getRecentUsage;
    this.debounceMs = debounceMs;
    this._timer = null;
  }

  settings() {
    return S.mergeKingLouieSettings((this.getSettings() || {}).models?.kingLouie);
  }

  profile() {
    return this.profiles.list().find((p) => p.kind === 'king-louie') || null;
  }

  _nameOf(target) {
    const entry = this.catalog ? this.catalog.get(target.provider, target.model) : null;
    return entry?.name || target.model;
  }

  candidates() {
    const usable = typeof this.availability.usable === 'function' ? this.availability.usable({ needs: {} }) : [];
    return usable.map((c) => S.candidateFromEntry(c, this.catalog ? this.catalog.get(c.provider, c.model) : null));
  }

  propose() {
    const settings = this.settings();
    const picks = S.pickRoles(this.candidates(), settings);
    if (picks.unavailable) return { unavailable: picks.unavailable };
    let usage = {};
    try {
      usage = this.getRecentUsage() || {};
    } catch (err) {
      log.warn(`Reading recent usage for the King Louie proposal failed: ${err.message}`);
    }
    const current = this.profile();
    const proposal = S.buildProposal({
      picks,
      current: current ? current.roles : null,
      usage,
      price: (t, u) => {
        const priced = this.catalog ? this.catalog.price(t.provider, t.model, u) : null;
        return priced ? priced.usd : null;
      },
      nameOf: (t) => this._nameOf(t)
    });
    return { ...proposal, dismissed: Boolean(proposal.id) && proposal.id === settings.dismissedProposalId };
  }

  view() {
    const settings = this.settings();
    const current = this.profile();
    const named = (t) => ({ provider: t.provider, model: t.model, effort: t.effort || null, name: this._nameOf(t) });
    const out = {
      profile: current ? { id: current.id, name: current.name } : null,
      current: current ? Object.fromEntries(Object.entries(current.roles).map(([role, list]) => [role, list.map(named)])) : null,
      proposal: null,
      upToDate: false,
      unavailable: null,
      settings: {
        autoAccept: settings.autoAccept,
        bandPoints: settings.bandPoints,
        workerAgenticRatio: settings.workerAgenticRatio,
        utilityIntelligenceRatio: settings.utilityIntelligenceRatio,
        preferLocalUtility: settings.preferLocalUtility
      }
    };
    const p = this.propose();
    if (p.unavailable) out.unavailable = p.unavailable;
    else if (p.upToDate) out.upToDate = true;
    else out.proposal = { id: p.id, changes: p.changes, costEffect: p.costEffect, dismissed: p.dismissed };
    return out;
  }

  // The owner accepts the proposal they saw: refused when it has changed
  // since, so a different set of models is never applied.
  accept(proposalId) {
    const now = this.propose();
    if (now.unavailable) throw new ProfileError('NO_PROPOSAL', now.unavailable);
    if (!now.id) throw new ProfileError('NO_PROPOSAL', 'The King Louie profile is up to date; there is nothing to accept.');
    if (now.id !== proposalId) throw new ProfileError('STALE_PROPOSAL', 'The proposal changed since it was shown. Review the new one, then accept it.');
    const current = this.profile();
    const saved = current
      ? this.profiles.update(current.id, { roles: now.roles })
      : this.profiles.create({ name: this._freeName(KING_LOUIE_NAME), kind: 'king-louie', roles: now.roles });
    if (this.settings().dismissedProposalId) this._writeSettings({ dismissedProposalId: null });
    log.info(`Accepted King Louie proposal ${now.id}.`);
    this._emit();
    return saved;
  }

  dismiss(proposalId) {
    const now = this.propose();
    if (now.unavailable || !now.id) throw new ProfileError('NO_PROPOSAL', now.unavailable || 'There is no proposal to dismiss.');
    if (now.id !== proposalId) throw new ProfileError('STALE_PROPOSAL', 'The proposal changed since it was shown. Review the new one.');
    this._writeSettings({ dismissedProposalId: now.id });
    this._emit();
    return { dismissed: now.id };
  }

  saveSettings(patch = {}) {
    const next = {};
    if (patch.autoAccept !== undefined) next.autoAccept = patch.autoAccept === true;
    if (patch.preferLocalUtility !== undefined) next.preferLocalUtility = patch.preferLocalUtility === true;
    const ranged = (key, min, max, label) => {
      if (patch[key] === undefined) return;
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw new ProfileError('BAD_SETTING', `${label} is a number from ${min} to ${max}.`);
      next[key] = n;
    };
    ranged('bandPoints', 0, 50, 'The band');
    ranged('workerAgenticRatio', 0, 1, 'The worker ratio');
    ranged('utilityIntelligenceRatio', 0, 1, 'The utility ratio');
    this._writeSettings(next);
    this.refresh();
    return this.settings();
  }

  // "Duplicate as my profile" (spec §7.2): the accepted picks, or the
  // pending proposal's before anything was accepted, as an ordinary profile.
  duplicateAsProfile({ name } = {}) {
    let roles = this.profile()?.roles || null;
    if (!roles) {
      const p = this.propose();
      if (p.unavailable) throw new ProfileError('NO_PROPOSAL', p.unavailable);
      roles = p.roles;
    }
    const base = String(name || `${KING_LOUIE_NAME} copy`).trim();
    return this.profiles.create({ name: this._freeName(base), kind: 'user', roles });
  }

  // Recompute now: accept a new proposal when autoAccept is on (never a
  // dismissed one), then tell listeners.
  refresh() {
    try {
      if (this.settings().autoAccept) {
        const p = this.propose();
        if (p.id && !p.dismissed) this.accept(p.id);
      }
    } catch (err) {
      log.warn(`Refreshing the King Louie proposal failed: ${err.message}`);
    }
    this._emit();
  }

  // An input changed (a catalog refresh, a key test): recompute once the
  // burst settles.
  inputsChanged() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refresh();
    }, this.debounceMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _freeName(base) {
    const taken = new Set(this.profiles.list().map((p) => p.name.toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} ${n}`;
    return candidate;
  }

  _writeSettings(patch) {
    const settings = this.getSettings() || {};
    const models = settings.models || {};
    this.setSettings({ ...settings, models: { ...models, kingLouie: { ...(models.kingLouie || {}), ...patch } } });
  }

  _emit() {
    if (!this.listenerCount('proposal')) return;
    try {
      this.emit('proposal', this.view());
    } catch (err) {
      log.warn(`Building the King Louie view failed: ${err.message}`);
    }
  }
}

module.exports = { KingLouieProfile, KING_LOUIE_NAME };
```

In `src/models/index.js`, after `const suggester = require('./suggester');` (Task 9) add:

```js
const { KingLouieProfile, KING_LOUIE_NAME } = require('./king-louie');
```

and in `module.exports`, after `suggester,` add:

```js
  KingLouieProfile,
  KING_LOUIE_NAME,
```

- [ ] **Step 4: The `models.kingLouie` setting**

In `src/core/settings.js`, after

```js
const { DEFAULT_ROLE_TIMEOUTS_MS } = require('../models/roles');
```

add

```js
const { mergeKingLouieSettings } = require('../models/suggester');
```

In `DEFAULT_SETTINGS.models`, replace

```js
    // The explorer's summary cap (spec §8.1).
    explorer: { summaryMaxTokens: 2000 }
  },
```

with

```js
    // The explorer's summary cap (spec §8.1).
    explorer: { summaryMaxTokens: 2000 },
    // The King Louie profile's picking thresholds and state (spec §7, §14).
    kingLouie: mergeKingLouieSettings({})
  },
```

In `mergeSettings`'s `models` merge, replace

```js
      explorer: {
        ...DEFAULT_SETTINGS.models.explorer,
        ...(source.models?.explorer && typeof source.models.explorer === 'object' && !Array.isArray(source.models.explorer)
          ? source.models.explorer
          : {})
      }
    },
```

with

```js
      explorer: {
        ...DEFAULT_SETTINGS.models.explorer,
        ...(source.models?.explorer && typeof source.models.explorer === 'object' && !Array.isArray(source.models.explorer)
          ? source.models.explorer
          : {})
      },
      kingLouie: mergeKingLouieSettings(source.models?.kingLouie)
    },
```

- [ ] **Step 5: The core builds it**

In `src/core/create-core.js`, after

```js
const { Profiles } = require('../models/profiles');
```

add

```js
const { KingLouieProfile } = require('../models/king-louie');
```

After

```js
  const profiles = new Profiles({ getSettings, setSettings, catalog });
```

add

```js
  // The King Louie profile (spec §7): proposals from the usable models,
  // their prices and scores; the owner accepts. Recomputed when the catalog
  // or a provider's status changes, and pushed to the renderer.
  const kingLouie = new KingLouieProfile({
    profiles,
    availability,
    catalog,
    getSettings,
    setSettings,
    getRecentUsage: () => (usageTracker && typeof usageTracker.recentRoleUsage === 'function' ? usageTracker.recentRoleUsage({ days: 30 }) : {})
  });
  catalog.on('updated', () => kingLouie.inputsChanged());
  availability.on('changed', () => kingLouie.inputsChanged());
  kingLouie.on('proposal', (view) => ui.send('models:proposalChanged', view));
```

In the `createModelChoices({ … })` call, replace

```js
    getCaseRuntime: () => caseRuntime
  });
```

with

```js
    getCaseRuntime: () => caseRuntime,
    kingLouie
  });
```

At the start of `shutdown`'s body, before `// Stop cron first so no job fires while the slower stops below drain.`, add:

```js
    kingLouie.stop();
```

In the returned core, replace

```js
    models: { catalog, availability, profiles, startBackgroundChecks: startModelsBackgroundChecks },
```

with

```js
    models: { catalog, availability, profiles, kingLouie, startBackgroundChecks: startModelsBackgroundChecks },
```

and in `context`, after `getProfiles: () => profiles,` add:

```js
    getKingLouie: () => kingLouie,
```

- [ ] **Step 6: The model choices**

In `src/core/model-choices.js`, replace

```js
const { checkEffort } = require('../models/profiles');
```

with

```js
const { checkEffort, ProfileError } = require('../models/profiles');
```

In `createModelChoices`'s parameters, replace

```js
  appendMessageToChat,
  getCaseRuntime = () => null
} = {}) {
```

with

```js
  appendMessageToChat,
  getCaseRuntime = () => null,
  kingLouie = null
} = {}) {
```

Replace

```js
  function saveProfile({ id = null, name, roles } = {}) {
    const saved = id ? profiles.update(id, { name, roles }) : profiles.create({ name, roles });
```

with

```js
  function saveProfile({ id = null, name, roles } = {}) {
    // The King Louie profile changes only by accepting a proposal (spec §7).
    if (id && profiles.get(id)?.kind === 'king-louie') {
      throw new ProfileError('KING_LOUIE_READ_ONLY', 'The King Louie profile changes only when you accept a proposal. Duplicate it to make your own.');
    }
    const saved = id ? profiles.update(id, { name, roles }) : profiles.create({ name, roles });
```

Before the final `return { chatView, … };`, add:

```js
  // The King Louie profile (spec §7, §11).
  const kl = () => {
    if (!kingLouie) throw new Error('The King Louie profile is not available in this host.');
    return kingLouie;
  };

  function kingLouieView() {
    return kl().view();
  }

  function acceptProposal(proposalId) {
    return profileView(kl().accept(proposalId), { explain: explainTarget, catalog });
  }

  function dismissProposal(proposalId) {
    return kl().dismiss(proposalId);
  }

  function saveKingLouieSettings(patch = {}) {
    kl().saveSettings(patch);
    return kl().view();
  }

  function duplicateKingLouie({ name } = {}) {
    return profileView(kl().duplicateAsProfile({ name }), { explain: explainTarget, catalog });
  }
```

and replace the return with:

```js
  return {
    chatView,
    setChatProfile,
    setMainOverride,
    removeProfile,
    profilesView,
    saveProfile,
    duplicateProfile,
    setDefaultProfile,
    pickerView,
    kingLouieView,
    acceptProposal,
    dismissProposal,
    saveKingLouieSettings,
    duplicateKingLouie
  };
```

- [ ] **Step 7: The channels**

In `src/ipc/constants.js`, after

```js
  MODELS_SAVE_CATALOG_SETTINGS: 'models:saveCatalogSettings',
```

add

```js
  // Models M3: the King Louie profile (spec 2026-09-27 §7, §11).
  MODELS_KING_LOUIE: 'models:kingLouie',
  MODELS_ACCEPT_PROPOSAL: 'models:acceptProposal',
  MODELS_DISMISS_PROPOSAL: 'models:dismissProposal',
  MODELS_SAVE_KING_LOUIE_SETTINGS: 'models:saveKingLouieSettings',
  MODELS_DUPLICATE_KING_LOUIE: 'models:duplicateKingLouie',
```

In `src/ipc/models-handlers.js`, before the final `}` of `registerModelsHandlers` (after the `MODELS_SAVE_CATALOG_SETTINGS` handler), add:

```js
  // ---- The King Louie profile (stage M3, spec §7, §11) ----

  const KING_LOUIE_SETTING_KEYS = ['autoAccept', 'preferLocalUtility', 'bandPoints', 'workerAgenticRatio', 'utilityIntelligenceRatio'];

  handle(IPC.MODELS_KING_LOUIE, async () => ({ ok: true, view: choices().kingLouieView() }));

  handle(IPC.MODELS_ACCEPT_PROPOSAL, async ({ proposalId }) => ({ ok: true, profile: choices().acceptProposal(text(proposalId)) }));

  handle(IPC.MODELS_DISMISS_PROPOSAL, async ({ proposalId }) => ({ ok: true, ...choices().dismissProposal(text(proposalId)) }));

  handle(IPC.MODELS_SAVE_KING_LOUIE_SETTINGS, async (payload) => {
    const patch = Object.fromEntries(KING_LOUIE_SETTING_KEYS.filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]));
    return { ok: true, view: choices().saveKingLouieSettings(patch) };
  });

  handle(IPC.MODELS_DUPLICATE_KING_LOUIE, async ({ name }) => ({ ok: true, profile: choices().duplicateKingLouie({ name: text(name) || undefined }) }));
```

In `preload.js`, in `models: { … }`, replace

```js
      onCatalogUpdated: (callback) => registerAdditive('models:catalogUpdated', callback)
```

with

```js
      onCatalogUpdated: (callback) => registerAdditive('models:catalogUpdated', callback),
      kingLouie: () => ipcRenderer.invoke('models:kingLouie'),
      acceptProposal: (proposalId) => {
        validateString(proposalId, 'proposalId', { minLength: 1 });
        return ipcRenderer.invoke('models:acceptProposal', { proposalId });
      },
      dismissProposal: (proposalId) => {
        validateString(proposalId, 'proposalId', { minLength: 1 });
        return ipcRenderer.invoke('models:dismissProposal', { proposalId });
      },
      saveKingLouieSettings: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:saveKingLouieSettings', payload);
      },
      duplicateKingLouie: (payload = {}) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:duplicateKingLouie', payload);
      },
      onProposalChanged: (callback) => registerAdditive('models:proposalChanged', callback)
```

In `src/desktop-bridge/allowlist.js`, in `RENDERER_EVENTS`, replace

```js
  'models:statusChanged', 'models:catalogUpdated'
```

with

```js
  'models:statusChanged', 'models:catalogUpdated',
  // Models M3: the King Louie proposal, recomputed on the service.
  'models:proposalChanged'
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/models-king-louie.test.js tests/models-profiles-ipc.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js tests/desktop-bridge-allowlist.test.js tests/model-choices.test.js tests/core-settings.test.js tests/electron-boundary.test.js tests/models-core-profiles.test.js tests/models-suggester.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/models/king-louie.js src/models/index.js src/core/settings.js src/core/create-core.js src/core/model-choices.js src/ipc/constants.js src/ipc/models-handlers.js preload.js src/desktop-bridge/allowlist.js tests/models-king-louie.test.js tests/models-profiles-ipc.test.js
git commit -m "feat(models): the King Louie profile proposes; the owner accepts, dismisses or duplicates"
```

---

## Task 11: The King Louie profile in the Models tab

**Files:**
- Modify: `index.html` (a new card before `models-catalog-card`), `renderer.js` (`dom` entries after `modelsSaveCatalogBtn`; the settings-tab loader; `renderModelProfileList`'s Edit button; new functions after `renderCatalogSettings`; listeners), `styles.css` (three rules)
- Test: `tests/renderer-models-m3.test.js` (describe added), `tests/e2e/models-roles.test.js` (new); run `tests/renderer-models-m2.test.js`, `tests/renderer-models-text.test.js`

**Interfaces:**
- Consumes: `window.electron.models.{ kingLouie(), acceptProposal(proposalId), dismissProposal(proposalId), saveKingLouieSettings(payload), duplicateKingLouie(payload), onProposalChanged(callback) }` and `KingLouieView` (Task 10); `unwrapIpcResult`, `MODEL_ROLE_LABELS`, `loadModelProfiles`, `appState` (`renderer.js`); `formatRoleCosts` (Task 4).
- Produces: renderer functions `loadKingLouie()`, `renderKingLouie(view)`, `formatCostEffect(effect) → string`, `targetsText(list) → string`; DOM ids `models-king-louie-card`, `models-kl-status`, `models-kl-picks`, `models-kl-proposal`, `models-kl-accept-btn`, `models-kl-dismiss-btn`, `models-kl-auto-accept`, `models-kl-prefer-local`, `models-kl-band`, `models-kl-worker-ratio`, `models-kl-utility-ratio`, `models-kl-save-btn`, `models-kl-duplicate-btn`; each proposed change is a `.models-kl-change` with `data-role`. The King Louie profile's card in the profile list has no Edit button.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer-models-m3.test.js`, add at the end:

```js
describe('renderer: the King Louie profile (spec §7, §11)', () => {
  it('has its card and controls in the Models tab', () => {
    for (const id of ['models-king-louie-card', 'models-kl-status', 'models-kl-picks', 'models-kl-proposal', 'models-kl-auto-accept', 'models-kl-prefer-local', 'models-kl-band', 'models-kl-worker-ratio', 'models-kl-utility-ratio', 'models-kl-save-btn', 'models-kl-duplicate-btn']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('draws the view from the channels, as text, with no native dialogs', () => {
    assert.match(block('async function loadKingLouie()'), /window\.electron\.models\.kingLouie\(\)/);
    const render = block('function renderKingLouie(view)');
    assert.match(render, /window\.electron\.models\.acceptProposal\(/);
    assert.match(render, /window\.electron\.models\.dismissProposal\(/);
    assert.match(render, /models-kl-change/);
    assert.doesNotMatch(render, /innerHTML\s*=\s*(?!'')/);
    assert.doesNotMatch(render, /\bconfirm\(|\balert\(|\bprompt\(/);
    assert.match(src, /window\.electron\.models\.onProposalChanged\(/);
    assert.match(src, /window\.electron\.models\.saveKingLouieSettings\(/);
    assert.match(src, /window\.electron\.models\.duplicateKingLouie\(/);
  });

  it('offers no Edit for the King Louie profile', () => {
    assert.match(block('function renderModelProfileList()'), /profile\.kind !== 'king-louie'/);
  });

  it('formats the cost effect and a role\'s models', () => {
    const f = new Function(`${block('function formatCostEffect(effect)')}\nreturn formatCostEffect;`)();
    assert.strictEqual(f({ usd: -0.35, note: '10 calls in the last 30 days, repriced.' }), '−$0.35 a month (10 calls in the last 30 days, repriced.)');
    assert.strictEqual(f({ usd: 1.2, note: 'n' }), '+$1.20 a month (n)');
    assert.strictEqual(f({ usd: null, note: 'No recorded calls in the last 30 days.' }), 'No recorded calls in the last 30 days.');
    const t = new Function(`${block('function targetsText(list)')}\nreturn targetsText;`)();
    assert.strictEqual(t([{ model: 'mini', name: 'Mini', effort: 'minimal' }, { model: 'big', name: 'Big' }]), 'Mini (minimal effort), Big');
    assert.strictEqual(t([]), '(none)');
  });
});
```

Create `tests/e2e/models-roles.test.js`:

```js
// tests/e2e/models-roles.test.js
// Models M3 end to end (spec 2026-09-27 §7, §10, §11): a reply's metrics
// line splits its cost by role, and the King Louie proposal is accepted in
// the Models tab. The provider is Ollama pointed at a local fake server; the
// catalog overrides give its model the scores, tool calling and context the
// picking rules need. KL_TEST_MODE keeps fetches off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const readData = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));

// Polls the profile's data file from the test process.
async function waitUntil(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fn()) return;
    } catch {
      // the file is being rewritten; read it again
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('E2E: roles in use (models M3)', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    const now = new Date().toISOString();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-1',
          chats: [{ id: 'chat-1', title: 'Test chat', createdAt: now, updatedAt: now, messages: [] }],
          apiStatus: { ollama: { ok: true, message: 'Connected: 1 model.', checkedAt: now, models: ['test-model'] } },
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              overrides: { 'ollama:test-model': { toolCall: true, limits: { context: 200000 }, scores: { intelligence: 50, agentic: 50 } } },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('a reply\'s metrics line splits its cost by role', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitUntil(() => readData(ctx).chats[0].messages.some((m) => m.sender === 'assistant' && m.llm && m.llm.byRole && m.llm.byRole.main));
    const text = await waitFor(ctx, `(() => {
      const els = [...document.querySelectorAll('.message-metrics-call')];
      const t = els.length ? els[els.length - 1].textContent : '';
      return t.includes(' · main $') ? t : null;
    })()`, 30000);
    assert.match(text, / · main \$/);
  });

  it('accepts the King Louie proposal in the Models tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `(() => { const s = document.getElementById('settings-nav-select'); s.value = 'models'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(ctx, `!!document.getElementById('models-kl-accept-btn')`, 15000);
    const roles = await evaluate(ctx, `[...document.querySelectorAll('.models-kl-change')].map((el) => el.dataset.role)`);
    assert.deepStrictEqual(roles, ['main', 'worker', 'utility']);
    await evaluate(ctx, `document.getElementById('models-kl-accept-btn').click(); true`);
    await waitUntil(() => readData(ctx).settings.models.profiles.some((p) => p.kind === 'king-louie'));
    const data = readData(ctx);
    const kl = data.settings.models.profiles.find((p) => p.kind === 'king-louie');
    assert.strictEqual(kl.name, 'King Louie selected');
    assert.deepStrictEqual(kl.roles.main, [{ provider: 'ollama', model: 'test-model', effort: null }]);
    assert.strictEqual(data.settings.models.defaultProfileId, 'p-local', 'accepting never changes the default');
    await waitFor(ctx, `document.getElementById('models-kl-status').textContent.includes('up to date')`, 15000);
    await waitFor(ctx, `[...document.querySelectorAll('#models-profile-list .models-profile-card')].some((c) => c.textContent.includes('King Louie selected'))`, 15000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/renderer-models-m3.test.js`
Expected: FAIL — `id="models-king-louie-card"` is not in `index.html`; `loadKingLouie` is not found.

- [ ] **Step 3: The card**

In `index.html`, immediately before

```html
          <section class="template-variables-card" id="models-catalog-card">
```

add

```html
          <section class="template-variables-card" id="models-king-louie-card">
            <h3>King Louie selected</h3>
            <p>King Louie proposes models for each role from the models you can use, their prices and their scores. Nothing changes until you accept a proposal.</p>
            <div class="provider-message" id="models-kl-status">Reading the proposal…</div>
            <div class="models-kl-picks" id="models-kl-picks"></div>
            <div class="models-kl-proposal" id="models-kl-proposal"></div>
            <div class="template-variables-grid">
              <label class="inline-toggle" for="models-kl-auto-accept">
                <input id="models-kl-auto-accept" type="checkbox">
                <span>Accept new proposals automatically</span>
              </label>
              <label class="inline-toggle" for="models-kl-prefer-local">
                <input id="models-kl-prefer-local" type="checkbox">
                <span>Prefer a local model for utility</span>
              </label>
              <label for="models-kl-band">Main: the cheaper model wins within this many agentic points of the best</label>
              <input id="models-kl-band" class="provider-input" type="number" min="0" max="50" step="0.5">
              <label for="models-kl-worker-ratio">Worker: at least this share of main's agentic score</label>
              <input id="models-kl-worker-ratio" class="provider-input" type="number" min="0" max="1" step="0.05">
              <label for="models-kl-utility-ratio">Utility and vision: at least this share of main's intelligence score</label>
              <input id="models-kl-utility-ratio" class="provider-input" type="number" min="0" max="1" step="0.05">
            </div>
            <div class="provider-actions">
              <button type="button" class="btn" id="models-kl-save-btn">Save these settings</button>
              <button type="button" class="btn" id="models-kl-duplicate-btn">Duplicate as my profile</button>
            </div>
          </section>

```

In `styles.css`, at the end of the file, add:

```css
/* Models M3: the King Louie profile's proposal (spec 2026-09-27 §7, §11). */
.models-kl-change {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 0.5em 0.75em;
  margin: 0.5em 0;
}

.models-kl-change ul {
  margin: 0.25em 0 0.25em 1.25em;
  padding: 0;
}

.models-kl-picks .provider-message {
  margin: 0.15em 0;
}
```

- [ ] **Step 4: The renderer**

In `renderer.js`, in the `dom` object, after

```js
  modelsSaveCatalogBtn: document.getElementById('models-save-catalog-btn'),
```

add

```js
  modelsKlStatus: document.getElementById('models-kl-status'),
  modelsKlPicks: document.getElementById('models-kl-picks'),
  modelsKlProposal: document.getElementById('models-kl-proposal'),
  modelsKlAutoAccept: document.getElementById('models-kl-auto-accept'),
  modelsKlPreferLocal: document.getElementById('models-kl-prefer-local'),
  modelsKlBand: document.getElementById('models-kl-band'),
  modelsKlWorkerRatio: document.getElementById('models-kl-worker-ratio'),
  modelsKlUtilityRatio: document.getElementById('models-kl-utility-ratio'),
  modelsKlSaveBtn: document.getElementById('models-kl-save-btn'),
  modelsKlDuplicateBtn: document.getElementById('models-kl-duplicate-btn'),
```

In the settings-tab loader, replace

```js
  if (tabName === 'models' && typeof loadModelProfiles === 'function') {
    loadModelProfiles().catch((err) => settingsLog.warn(`loading model profiles failed: ${err.message}`));
  }
```

with

```js
  if (tabName === 'models' && typeof loadModelProfiles === 'function') {
    loadModelProfiles().catch((err) => settingsLog.warn(`loading model profiles failed: ${err.message}`));
    loadKingLouie().catch((err) => settingsLog.warn(`loading the King Louie profile failed: ${err.message}`));
  }
```

In `renderModelProfileList`, replace

```js
    actions.appendChild(button('Edit', 'edit', 'btn btn-primary'));
```

with

```js
    // The King Louie profile changes only by accepting a proposal (spec §7).
    if (profile.kind !== 'king-louie') actions.appendChild(button('Edit', 'edit', 'btn btn-primary'));
```

After the whole `function renderCatalogSettings() { … }`, add:

```js
/* --- Models tab: the King Louie profile (spec 2026-09-27 §7, §11) --- */

function roleShortName(role) {
  return (MODEL_ROLE_LABELS[role] || role).split(':')[0];
}

function targetsText(list) {
  return (list || []).map((t) => `${t.name || t.model}${t.effort ? ` (${t.effort} effort)` : ''}`).join(', ') || '(none)';
}

function formatCostEffect(effect) {
  if (!effect || typeof effect.usd !== 'number') return effect?.note || 'No estimate.';
  const sign = effect.usd > 0 ? '+' : (effect.usd < 0 ? '−' : '');
  return `${sign}$${Math.abs(effect.usd).toFixed(2)} a month (${effect.note})`;
}

function setKingLouieStatus(text, isError = false) {
  if (!dom.modelsKlStatus) return;
  dom.modelsKlStatus.textContent = text;
  dom.modelsKlStatus.classList.toggle('error', Boolean(isError));
}

async function loadKingLouie() {
  if (!dom.modelsKlStatus || !window.electron?.models?.kingLouie) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.kingLouie(), 'Unable to read the King Louie profile.');
    renderKingLouie(result.view);
  } catch (err) {
    setKingLouieStatus(err.message, true);
  }
}

function renderKingLouie(view) {
  if (!view || !dom.modelsKlStatus) return;
  appState.kingLouie = view;
  const s = view.settings || {};
  if (dom.modelsKlAutoAccept) dom.modelsKlAutoAccept.checked = Boolean(s.autoAccept);
  if (dom.modelsKlPreferLocal) dom.modelsKlPreferLocal.checked = Boolean(s.preferLocalUtility);
  if (dom.modelsKlBand) dom.modelsKlBand.value = String(s.bandPoints ?? 3);
  if (dom.modelsKlWorkerRatio) dom.modelsKlWorkerRatio.value = String(s.workerAgenticRatio ?? 0.8);
  if (dom.modelsKlUtilityRatio) dom.modelsKlUtilityRatio.value = String(s.utilityIntelligenceRatio ?? 0.5);

  const p = view.proposal;
  if (view.unavailable) setKingLouieStatus(view.unavailable, true);
  else if (view.upToDate) setKingLouieStatus('The King Louie profile is up to date.');
  else if (p && p.dismissed) setKingLouieStatus('You dismissed the current proposal. It comes back when the proposed models change.');
  else if (p) setKingLouieStatus(view.profile ? 'King Louie proposes changes to its profile.' : 'King Louie has a first proposal. Accept it to create the King Louie profile; your default profile stays as it is.');

  if (dom.modelsKlPicks) {
    dom.modelsKlPicks.textContent = '';
    for (const [role, list] of Object.entries(view.current || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      const line = document.createElement('div');
      line.className = 'provider-message';
      line.textContent = `${roleShortName(role)}: ${targetsText(list)}`;
      dom.modelsKlPicks.appendChild(line);
    }
  }

  const box = dom.modelsKlProposal;
  if (!box) return;
  box.textContent = '';
  if (!p || p.dismissed) return;
  for (const change of p.changes || []) {
    const card = document.createElement('div');
    card.className = 'models-kl-change';
    card.dataset.role = change.role;
    const title = document.createElement('div');
    title.className = 'chat-info-section-title';
    title.textContent = roleShortName(change.role);
    card.appendChild(title);
    const from = document.createElement('div');
    from.textContent = `Now: ${targetsText(change.from)}`;
    card.appendChild(from);
    const to = document.createElement('div');
    to.textContent = `Proposed: ${targetsText(change.to)}`;
    card.appendChild(to);
    const reasons = document.createElement('ul');
    for (const reason of change.reasons || []) {
      const li = document.createElement('li');
      li.textContent = reason;
      reasons.appendChild(li);
    }
    card.appendChild(reasons);
    const cost = document.createElement('div');
    cost.className = 'provider-message';
    cost.textContent = `Cost effect: ${formatCostEffect(change.costEffect)}`;
    card.appendChild(cost);
    box.appendChild(card);
  }
  const total = document.createElement('div');
  total.className = 'provider-message';
  total.textContent = `Estimated total: ${formatCostEffect(p.costEffect)}`;
  box.appendChild(total);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'btn btn-primary';
  accept.id = 'models-kl-accept-btn';
  accept.textContent = 'Accept';
  accept.addEventListener('click', async () => {
    try {
      unwrapIpcResult(await window.electron.models.acceptProposal(p.id), 'Unable to accept the proposal.');
      setKingLouieStatus('Accepted. The King Louie profile uses these models now.');
      await loadKingLouie();
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
      await loadKingLouie();
    }
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn';
  dismiss.id = 'models-kl-dismiss-btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    try {
      unwrapIpcResult(await window.electron.models.dismissProposal(p.id), 'Unable to dismiss the proposal.');
      await loadKingLouie();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
  actions.appendChild(accept);
  actions.appendChild(dismiss);
  box.appendChild(actions);
}

if (dom.modelsKlSaveBtn) {
  dom.modelsKlSaveBtn.addEventListener('click', async () => {
    try {
      const result = unwrapIpcResult(await window.electron.models.saveKingLouieSettings({
        autoAccept: Boolean(dom.modelsKlAutoAccept?.checked),
        preferLocalUtility: Boolean(dom.modelsKlPreferLocal?.checked),
        bandPoints: Number(dom.modelsKlBand?.value),
        workerAgenticRatio: Number(dom.modelsKlWorkerRatio?.value),
        utilityIntelligenceRatio: Number(dom.modelsKlUtilityRatio?.value)
      }), 'Unable to save the King Louie settings.');
      renderKingLouie(result.view);
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
}

if (dom.modelsKlDuplicateBtn) {
  dom.modelsKlDuplicateBtn.addEventListener('click', async () => {
    try {
      const result = unwrapIpcResult(await window.electron.models.duplicateKingLouie({}), 'Unable to duplicate the King Louie profile.');
      setKingLouieStatus(`Created ${result.profile.name}. Edit it under Profiles.`);
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
}

if (window.electron?.models?.onProposalChanged) {
  window.electron.models.onProposalChanged((view) => renderKingLouie(view));
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `node --test tests/renderer-models-m3.test.js tests/renderer-models-m2.test.js tests/renderer-models-text.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Run the e2e test**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/models-roles.test.js`
Expected: PASS, `# fail 0`. (The implementer runs this one file; the controller runs the full e2e suite at stage end.)

- [ ] **Step 7: Commit**

```bash
git add index.html renderer.js styles.css tests/renderer-models-m3.test.js tests/e2e/models-roles.test.js
git commit -m "feat(ui): the King Louie profile in the Models tab: proposals with reasons and cost effect, Accept and Dismiss"
```

---

## Task 12: Custom roles: create, edit and remove, under Models → Advanced

**Files:**
- Modify: `src/models/profiles.js` (`validateCustomRole`; `Profiles#saveCustomRole`, `#customRoleReferences`, `#removeCustomRole`; exports), `src/core/model-choices.js` (`getSettings` dependency; three functions; return), `src/core/create-core.js` (`createModelChoices` gets `getSettings`), `src/ipc/constants.js`, `src/ipc/models-handlers.js`, `preload.js`, `index.html` (a card after `models-catalog-card`), `renderer.js` (`dom`; `loadModelProfiles`; the profile editor's role list, role title, empty text and picker needs; `saveProfileDraft`; new functions and listeners), `styles.css` (one rule), `tests/e2e/models-roles.test.js` (one test added)
- Test: `tests/models-custom-roles.test.js` (new), `tests/renderer-models-m3.test.js` (describe added), `tests/e2e/models-roles.test.js`; run `tests/models-profiles.test.js`, `tests/models-resolver.test.js`, `tests/model-choices.test.js`, `tests/models-profiles-ipc.test.js`, `tests/ipc-contract.test.js`, `tests/ipc-constants.test.js`, `tests/renderer-models-m2.test.js`

**Interfaces:**
- Consumes: `normalizeCustomRole`, `Profiles#customRoles()` (M2); `isCustomRoleId`, `isCoreRole`, `BUILTIN_ROLES` (`src/models/roles.js`); `CaseRuntime#listCases()` metas with `roles` (`src/cases/case-store.js`); `createTurnModels`'s `UnknownRoleError` (M2).
- Produces:
  - `validateCustomRole(raw) → CustomRole` (throws `ProfileError('BAD_CUSTOM_ROLE', …)`); `Profiles#saveCustomRole(raw) → CustomRole` (creates, or replaces the one with that id; at most 20; a stored entry that fails to parse is kept verbatim); `Profiles#customRoleReferences(id) → string[]` (profiles holding a non-empty list for the role); `Profiles#removeCustomRole(id, { references = [] }) → { removed }` (throws `NOT_FOUND`, or `ROLE_IN_USE` with `err.references`).
  - `createModelChoices({ …, getSettings })` gains `saveCustomRole(raw)`, `removeCustomRole(id)` (adds `settings.cases.roles` and every case's `case.yaml` roles naming the role to the references).
  - IPC `MODELS_SAVE_CUSTOM_ROLE 'models:saveCustomRole'`, `MODELS_REMOVE_CUSTOM_ROLE 'models:removeCustomRole'`; `window.electron.models.{ saveCustomRole(payload), removeCustomRole(id) }`.
  - Renderer: `renderCustomRoles()`, `customRoleOf(role)`; DOM ids `models-custom-roles-card`, `models-custom-roles-warning`, `models-custom-role-list`, `models-custom-role-id`, `models-custom-role-description`, `models-custom-role-fallback`, `models-custom-role-tools`, `models-custom-role-images`, `models-custom-role-min-context`, `models-save-custom-role-btn`, `models-custom-roles-status`. The profile editor shows a block for every defined custom role, and saves no empty custom list.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-custom-roles.test.js`:

```js
// tests/models-custom-roles.test.js
// Custom roles (spec 2026-09-27 §6.2, §11 "Advanced: custom roles"): saved
// with a fallback core role, refused when invalid, and never removed while a
// profile or a case role still names them.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { Profiles } = require('../src/models/profiles');
const { createModelChoices } = require('../src/core/model-choices');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { mergeSettings } = require('../src/core/settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const LEGAL = { id: 'legal-drafting', description: '', fallback: 'main', needs: {} };

function setup({ models = {}, caseRoles = {}, cases = [] } = {}) {
  let settings = mergeSettings({
    models: { profiles: [{ id: 'p-a', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } }], defaultProfileId: 'p-a', ...models },
    cases: { roles: caseRoles }
  });
  const getSettings = () => settings;
  const setSettings = (next) => { settings = mergeSettings(next); };
  let n = 0;
  const profiles = new Profiles({ getSettings, setSettings, createId: () => `id${++n}` });
  const choices = createModelChoices({
    profiles,
    getSettings,
    explainTarget: usable,
    snapshotModels: () => null,
    getChats: () => [],
    setChats: () => {},
    appendMessageToChat: () => null,
    getCaseRuntime: () => ({ listCases: () => cases })
  });
  return { profiles, choices, settings: () => settings, getSettings, setSettings };
}

describe('custom roles', () => {
  it('saves a custom role, refusing a bad id, a built-in name, a missing fallback or a bad context', () => {
    const { choices, settings } = setup();
    const saved = choices.saveCustomRole({ id: 'legal-drafting', description: 'Contracts and letters', fallback: 'main', needs: { toolCall: true, minContext: 64000 } });
    assert.deepStrictEqual(saved, { id: 'legal-drafting', description: 'Contracts and letters', needs: { toolCall: true, minContext: 64000 }, fallback: 'main' });
    assert.deepStrictEqual(settings().models.customRoles, [saved]);
    assert.throws(() => choices.saveCustomRole({ id: 'Legal Drafting', fallback: 'main' }), (e) => e.code === 'BAD_CUSTOM_ROLE' && /lowercase letters/.test(e.message));
    assert.throws(() => choices.saveCustomRole({ id: 'vision', fallback: 'main' }), /"vision" is a built-in role/);
    assert.throws(() => choices.saveCustomRole({ id: 'summaries', fallback: 'vision' }), /needs a fallback: main, worker or utility/);
    assert.throws(() => choices.saveCustomRole({ id: 'summaries', fallback: 'worker', needs: { minContext: -5 } }), /whole number of tokens/);
    // Saving the same id again edits it.
    choices.saveCustomRole({ id: 'legal-drafting', description: 'Contracts', fallback: 'worker' });
    assert.deepStrictEqual(settings().models.customRoles.map((r) => [r.id, r.fallback, r.description]), [['legal-drafting', 'worker', 'Contracts']]);
  });

  it('keeps a stored custom role it cannot read', () => {
    const { choices, settings } = setup({ models: { customRoles: [{ id: 'Bad Id', fallback: 'main' }, LEGAL] } });
    choices.saveCustomRole({ id: 'summaries', fallback: 'utility' });
    assert.deepStrictEqual(settings().models.customRoles.map((r) => r.id), ['Bad Id', 'legal-drafting', 'summaries']);
  });

  it('removing a custom role that is still used is refused, naming each use', () => {
    const { choices, profiles, settings } = setup({
      models: { customRoles: [LEGAL] },
      caseRoles: { draft: { role: 'legal-drafting' } },
      cases: [{ id: 'c-1', title: 'Lakeside lot', roles: { judge: { role: 'legal-drafting' } } }]
    });
    profiles.update('p-a', { roles: { ...profiles.get('p-a').roles, 'legal-drafting': [t('openai', 'gpt-5.5')] } });
    assert.throws(() => choices.removeCustomRole('legal-drafting'), (err) => err.code === 'ROLE_IN_USE'
      && err.message.includes('profile "Work"')
      && err.message.includes('case role draft in the case settings')
      && err.message.includes('case role judge in case "Lakeside lot"')
      && err.references.length === 3);
    assert.strictEqual(settings().models.customRoles.length, 1);
  });

  it('removes an unused custom role; an empty list in a profile is not a use', () => {
    const { choices, profiles, settings } = setup({ models: { customRoles: [LEGAL] } });
    profiles.update('p-a', { roles: { ...profiles.get('p-a').roles, 'legal-drafting': [] } });
    assert.deepStrictEqual(choices.removeCustomRole('legal-drafting'), { removed: 'legal-drafting' });
    assert.deepStrictEqual(settings().models.customRoles, []);
    assert.throws(() => choices.removeCustomRole('legal-drafting'), (e) => e.code === 'NOT_FOUND');
  });

  it('a deleted custom role fails the call naming it', () => {
    const { profiles } = setup({ models: { customRoles: [] } });
    const models = profiles.snapshot({ explain: usable });
    assert.throws(() => models.resolve('legal-drafting'), /Unknown model role "legal-drafting"/);
  });

  it('are saved and removed through their channels, errors as { ok: false, error }', async () => {
    const { choices, getSettings, setSettings } = setup();
    const handlers = new Map();
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, { getModelChoices: () => choices, getSettings, setSettings });
    const call = (ch, payload) => handlers.get(ch)({}, payload);
    const saved = await call(IPC.MODELS_SAVE_CUSTOM_ROLE, { id: 'summaries', description: 'Short digests', fallback: 'utility', needs: { imageInput: true, junk: 1 } });
    assert.deepStrictEqual(saved, { ok: true, role: { id: 'summaries', description: 'Short digests', needs: { imageInput: true }, fallback: 'utility' } });
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_CUSTOM_ROLE, { id: 'main', fallback: 'main' }), { ok: false, error: '"main" is a built-in role; pick another id.' });
    assert.deepStrictEqual(await call(IPC.MODELS_REMOVE_CUSTOM_ROLE, { id: 'summaries' }), { ok: true, removed: 'summaries' });
  });
});
```

In `tests/renderer-models-m3.test.js`, add at the end:

```js
describe('renderer: custom roles (spec §6.2, §11)', () => {
  it('has the Advanced card with its warning and form', () => {
    for (const id of ['models-custom-roles-card', 'models-custom-roles-warning', 'models-custom-role-list', 'models-custom-role-id', 'models-custom-role-description', 'models-custom-role-fallback', 'models-custom-role-tools', 'models-custom-role-images', 'models-custom-role-min-context', 'models-save-custom-role-btn', 'models-custom-roles-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /Use only if you know what you're doing/);
  });

  it('lists and edits them as text through their channels', () => {
    const list = block('function renderCustomRoles()');
    assert.doesNotMatch(list, /innerHTML\s*=\s*(?!'')/);
    assert.doesNotMatch(list, /\bconfirm\(|\balert\(|\bprompt\(/);
    assert.match(src, /window\.electron\.models\.saveCustomRole\(/);
    assert.match(src, /window\.electron\.models\.removeCustomRole\(/);
  });

  it('shows every custom role in the profile editor and saves no empty custom list', () => {
    assert.match(block('function renderProfileEditor()'), /customRoles/);
    assert.match(block('async function saveProfileDraft()'), /!MODEL_ROLE_ORDER\.includes\(role\) && !\(entries \|\| \[\]\)\.length/);
    assert.match(block('async function openModelPicker(role, block)'), /customRoleOf\(role\)/);
  });
});
```

In `tests/e2e/models-roles.test.js`, add inside the describe, after the King Louie test (the settings drawer is still open on the Models tab):

```js
  it('creates a custom role under Advanced and offers it in the profile editor', async () => {
    await evaluate(ctx, `(() => {
      const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input')); };
      set('models-custom-role-id', 'legal-drafting');
      set('models-custom-role-description', 'Contracts and letters');
      document.getElementById('models-custom-role-fallback').value = 'main';
      document.getElementById('models-custom-role-tools').checked = true;
      document.getElementById('models-save-custom-role-btn').click();
      return true;
    })()`);
    await waitUntil(() => (readData(ctx).settings.models.customRoles || []).some((r) => r.id === 'legal-drafting'));
    const role = readData(ctx).settings.models.customRoles.find((r) => r.id === 'legal-drafting');
    assert.deepStrictEqual(role, { id: 'legal-drafting', description: 'Contracts and letters', needs: { toolCall: true }, fallback: 'main' });
    await waitFor(ctx, `document.getElementById('models-custom-role-list').textContent.includes('legal-drafting')`);
    await evaluate(ctx, `document.getElementById('models-new-profile-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-role-block[data-role="legal-drafting"]')`);
    await evaluate(ctx, `[...document.querySelectorAll('#models-profile-editor button')].find((b) => b.textContent === 'Cancel').click(); true`);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-custom-roles.test.js tests/renderer-models-m3.test.js`
Expected: FAIL — `choices.saveCustomRole` is not a function; the card is not in `index.html`.

- [ ] **Step 3: Custom roles on Profiles**

In `src/models/profiles.js`, after

```js
const MAX_TARGETS = 20;
```

add

```js
const MAX_CUSTOM_ROLES = 20;
const MAX_DESCRIPTION = 200;
const BUILTIN_LOWER = R.BUILTIN_ROLES.map((r) => r.toLowerCase());
```

After the whole `function normalizeCustomRole(raw) { … }`, add:

```js
// A custom role as the owner saves it (spec §6.2, stage M3): refused with
// the reason, where normalizeCustomRole (reading stored data) drops a bad
// entry quietly.
function validateCustomRole(raw) {
  if (!isPlainObject(raw)) throw new ProfileError('BAD_CUSTOM_ROLE', 'A custom role must be an object.');
  const id = String(raw.id || '').trim();
  if (BUILTIN_LOWER.includes(id.toLowerCase())) throw new ProfileError('BAD_CUSTOM_ROLE', `"${id}" is a built-in role; pick another id.`);
  if (!R.isCustomRoleId(id)) throw new ProfileError('BAD_CUSTOM_ROLE', 'A custom role id is 2 to 40 lowercase letters, digits and dashes, starting with a letter.');
  if (!R.isCoreRole(raw.fallback)) throw new ProfileError('BAD_CUSTOM_ROLE', 'A custom role needs a fallback: main, worker or utility.');
  const description = String(raw.description || '').trim();
  if (description.length > MAX_DESCRIPTION) throw new ProfileError('BAD_CUSTOM_ROLE', `A description is at most ${MAX_DESCRIPTION} characters.`);
  const n = isPlainObject(raw.needs) ? raw.needs : {};
  let minContext = null;
  if (n.minContext !== undefined && n.minContext !== null && n.minContext !== '') {
    minContext = Number(n.minContext);
    if (!Number.isInteger(minContext) || minContext <= 0) throw new ProfileError('BAD_CUSTOM_ROLE', 'The minimum context is a whole number of tokens.');
  }
  return normalizeCustomRole({
    id,
    description,
    fallback: raw.fallback,
    needs: { toolCall: n.toolCall === true, imageInput: n.imageInput === true, ...(minContext ? { minContext } : {}) }
  });
}
```

In `class Profiles`, after the `customRoles()` method, add:

```js
  _storedCustomRoles() {
    const raw = this._models().customRoles;
    return Array.isArray(raw) ? raw : [];
  }

  _writeCustomRoles(list) {
    const settings = this.getSettings() || {};
    this.setSettings({ ...settings, models: { ...(settings.models || {}), customRoles: list } });
  }

  // Creates a custom role, or replaces the one with its id (spec §6.2). A
  // stored entry that fails to parse is kept verbatim, as for profiles.
  saveCustomRole(raw) {
    const role = validateCustomRole(raw);
    const stored = this._storedCustomRoles();
    const index = stored.findIndex((r) => isPlainObject(r) && r.id === role.id);
    if (index === -1 && this.customRoles().length >= MAX_CUSTOM_ROLES) {
      throw new ProfileError('BAD_CUSTOM_ROLE', `At most ${MAX_CUSTOM_ROLES} custom roles.`);
    }
    this._writeCustomRoles(index === -1 ? [...stored, role] : stored.map((r, i) => (i === index ? role : r)));
    return role;
  }

  // Profiles holding a non-empty list for the role: an empty list is only
  // the editor's leftover, not a use.
  customRoleReferences(id) {
    return this.list()
      .filter((p) => Array.isArray(p.roles[id]) && p.roles[id].length)
      .map((p) => `profile "${p.name}"`);
  }

  // Refused while anything still names the role (spec §3.1: "remove refuses
  // while referenced, returns references"); the caller adds uses outside
  // the profiles (case roles).
  removeCustomRole(id, { references = [] } = {}) {
    if (!this.customRoles().some((r) => r.id === id)) throw new ProfileError('NOT_FOUND', `No custom role "${id}".`);
    const refs = [...this.customRoleReferences(id), ...references];
    if (refs.length) {
      const err = new ProfileError('ROLE_IN_USE', `The custom role "${id}" is still used by ${refs.join('; ')}. Remove it there first.`);
      err.references = refs;
      throw err;
    }
    this._writeCustomRoles(this._storedCustomRoles().filter((r) => !(isPlainObject(r) && r.id === id)));
    return { removed: id };
  }
```

Replace

```js
module.exports = { Profiles, ProfileError, PROFILE_KINDS, normalizeProfile, normalizeCustomRole, snapshotFromSettings, checkEffort };
```

with

```js
module.exports = { Profiles, ProfileError, PROFILE_KINDS, normalizeProfile, normalizeCustomRole, validateCustomRole, snapshotFromSettings, checkEffort };
```

- [ ] **Step 4: The model choices and the core**

In `src/core/model-choices.js`, replace (Task 10's parameters)

```js
  getCaseRuntime = () => null,
  kingLouie = null
} = {}) {
```

with

```js
  getCaseRuntime = () => null,
  kingLouie = null,
  getSettings = () => ({})
} = {}) {
```

Before `// The King Louie profile (spec §7, §11).` (Task 10), add:

```js
  // Custom roles (spec §6.2, §11 "Advanced: custom roles"). A role still
  // named by a case role — the case settings or any case's case.yaml — is
  // not removed; nor is one a profile still lists models for.
  function customRoleReferences(id) {
    const refs = [];
    const settings = getSettings() || {};
    for (const [caseRole, entry] of Object.entries(settings.cases?.roles || {})) {
      if (entry && entry.role === id) refs.push(`case role ${caseRole} in the case settings`);
    }
    let cases = [];
    try {
      const runtime = getCaseRuntime();
      cases = runtime && typeof runtime.listCases === 'function' ? runtime.listCases() : [];
    } catch (err) {
      log.warn(`Listing cases to check custom role ${id} failed: ${err.message}`);
    }
    for (const meta of cases) {
      for (const [caseRole, entry] of Object.entries(meta.roles || {})) {
        if (entry && entry.role === id) refs.push(`case role ${caseRole} in case "${meta.title || meta.id}"`);
      }
    }
    return refs;
  }

  function saveCustomRole(raw) {
    return profiles.saveCustomRole(raw);
  }

  function removeCustomRole(id) {
    return profiles.removeCustomRole(id, { references: customRoleReferences(id) });
  }

```

and in the returned object (Task 10), replace

```js
    duplicateKingLouie
  };
```

with

```js
    duplicateKingLouie,
    saveCustomRole,
    removeCustomRole
  };
```

In `src/core/create-core.js`, replace (Task 10)

```js
    getCaseRuntime: () => caseRuntime,
    kingLouie
  });
```

with

```js
    getCaseRuntime: () => caseRuntime,
    kingLouie,
    getSettings
  });
```

- [ ] **Step 5: The channels**

In `src/ipc/constants.js`, after `MODELS_DUPLICATE_KING_LOUIE: 'models:duplicateKingLouie',` add:

```js
  // Models M3: custom roles (spec 2026-09-27 §6.2, §11).
  MODELS_SAVE_CUSTOM_ROLE: 'models:saveCustomRole',
  MODELS_REMOVE_CUSTOM_ROLE: 'models:removeCustomRole',
```

In `src/ipc/models-handlers.js`, after the `MODELS_DUPLICATE_KING_LOUIE` handler (Task 10), add:

```js
  // ---- Custom roles (stage M3, spec §6.2, §11) ----

  handle(IPC.MODELS_SAVE_CUSTOM_ROLE, async ({ id, description, fallback, needs }) => {
    const n = needs && typeof needs === 'object' ? needs : {};
    return {
      ok: true,
      role: choices().saveCustomRole({
        id: text(id),
        description: text(description),
        fallback: text(fallback),
        needs: {
          toolCall: n.toolCall === true,
          imageInput: n.imageInput === true,
          ...(n.minContext !== undefined && n.minContext !== null && n.minContext !== '' ? { minContext: n.minContext } : {})
        }
      })
    };
  });

  handle(IPC.MODELS_REMOVE_CUSTOM_ROLE, async ({ id }) => ({ ok: true, ...choices().removeCustomRole(text(id)) }));
```

In `preload.js`, in `models: { … }`, replace (Task 10)

```js
      onProposalChanged: (callback) => registerAdditive('models:proposalChanged', callback)
```

with

```js
      onProposalChanged: (callback) => registerAdditive('models:proposalChanged', callback),
      saveCustomRole: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:saveCustomRole', payload);
      },
      removeCustomRole: (id) => {
        validateString(id, 'id', { minLength: 1 });
        return ipcRenderer.invoke('models:removeCustomRole', { id });
      }
```

- [ ] **Step 6: The Advanced card**

In `index.html`, replace

```html
              <button type="button" class="btn btn-primary" id="models-save-catalog-btn">Save catalog settings</button>
            </div>
          </section>
```

with

```html
              <button type="button" class="btn btn-primary" id="models-save-catalog-btn">Save catalog settings</button>
            </div>
          </section>

          <section class="template-variables-card" id="models-custom-roles-card">
            <h3>Advanced: custom roles</h3>
            <p class="provider-message error" id="models-custom-roles-warning">Use only if you know what you're doing. A custom role is a named job with its own list of models in each profile. A case role, a workflow task or SpawnAgent that names it runs on those models; a profile with none for it uses the fallback role. A role nothing names does nothing.</p>
            <div class="provider-list" id="models-custom-role-list"></div>
            <div class="template-variables-grid">
              <label for="models-custom-role-id">Role id (lowercase letters, digits and dashes)</label>
              <input id="models-custom-role-id" class="provider-input" maxlength="40" placeholder="legal-drafting">
              <label for="models-custom-role-description">Description</label>
              <input id="models-custom-role-description" class="provider-input" maxlength="200">
              <label for="models-custom-role-fallback">Fallback role</label>
              <select id="models-custom-role-fallback" class="provider-input">
                <option value="worker">worker</option>
                <option value="utility">utility</option>
                <option value="main">main</option>
              </select>
              <label class="inline-toggle" for="models-custom-role-tools">
                <input id="models-custom-role-tools" type="checkbox">
                <span>Needs tool calling</span>
              </label>
              <label class="inline-toggle" for="models-custom-role-images">
                <input id="models-custom-role-images" type="checkbox">
                <span>Needs image input</span>
              </label>
              <label for="models-custom-role-min-context">Minimum context in tokens (optional)</label>
              <input id="models-custom-role-min-context" class="provider-input" type="number" min="1" step="1">
            </div>
            <div class="provider-actions">
              <button type="button" class="btn btn-primary" id="models-save-custom-role-btn">Save custom role</button>
              <span class="provider-message" id="models-custom-roles-status"></span>
            </div>
          </section>
```

In `styles.css`, at the end, add:

```css
/* Models M3: custom roles (spec 2026-09-27 §6.2, §11). */
.models-custom-role {
  display: flex;
  gap: 0.5em;
  align-items: center;
  margin: 0.25em 0;
}
```

- [ ] **Step 7: The renderer**

In `renderer.js`, in the `dom` object, after `modelsKlDuplicateBtn: …,` (Task 11) add:

```js
  modelsCustomRoleList: document.getElementById('models-custom-role-list'),
  modelsCustomRoleId: document.getElementById('models-custom-role-id'),
  modelsCustomRoleDescription: document.getElementById('models-custom-role-description'),
  modelsCustomRoleFallback: document.getElementById('models-custom-role-fallback'),
  modelsCustomRoleTools: document.getElementById('models-custom-role-tools'),
  modelsCustomRoleImages: document.getElementById('models-custom-role-images'),
  modelsCustomRoleMinContext: document.getElementById('models-custom-role-min-context'),
  modelsSaveCustomRoleBtn: document.getElementById('models-save-custom-role-btn'),
  modelsCustomRolesStatus: document.getElementById('models-custom-roles-status'),
```

In `loadModelProfiles`, replace

```js
    appState.modelProfiles = { profiles: result.profiles || [], broken: result.broken || [], defaultProfileId: result.defaultProfileId || null };
    renderModelProfileList();
```

with

```js
    appState.modelProfiles = { profiles: result.profiles || [], broken: result.broken || [], defaultProfileId: result.defaultProfileId || null, customRoles: result.customRoles || [] };
    renderModelProfileList();
    renderCustomRoles();
```

In `renderProfileEditor`, replace

```js
  const roles = [...MODEL_ROLE_ORDER, ...Object.keys(profileDraft.roles).filter((r) => !MODEL_ROLE_ORDER.includes(r))];
```

with

```js
  // Every defined custom role gets a block (spec §6.2), then any other role
  // the stored profile already lists.
  const customIds = (appState.modelProfiles?.customRoles || []).map((r) => r.id);
  const roles = [...new Set([...MODEL_ROLE_ORDER, ...customIds, ...Object.keys(profileDraft.roles)])];
```

In `renderRoleBlock`, replace

```js
  title.textContent = MODEL_ROLE_LABELS[role] || `Custom role: ${role}`;
```

with

```js
  title.textContent = MODEL_ROLE_LABELS[role] || customRoleLabel(role);
```

and replace

```js
      : (role === 'worker' || role === 'utility' ? 'Empty: borrows from the next stronger role.' : 'Empty.');
```

with

```js
      : (role === 'worker' || role === 'utility'
        ? 'Empty: borrows from the next stronger role.'
        : (customRoleOf(role) ? `Empty: uses its fallback role, ${customRoleOf(role).fallback}.` : 'Empty.'));
```

In `openModelPicker`, replace

```js
    const result = unwrapIpcResult(await window.electron.models.picker({ needs: MODEL_ROLE_NEEDS[role] || {} }), 'Unable to list models.');
```

with

```js
    const result = unwrapIpcResult(await window.electron.models.picker({ needs: MODEL_ROLE_NEEDS[role] || customRoleOf(role)?.needs || {} }), 'Unable to list models.');
```

In `saveProfileDraft`, replace

```js
  for (const [role, entries] of Object.entries(profileDraft.roles)) {
    roles[role] = (entries || []).map((e) => ({ provider: e.provider, model: e.model, effort: e.effort || null }));
  }
```

with

```js
  for (const [role, entries] of Object.entries(profileDraft.roles)) {
    // An empty custom role list is the editor's leftover, not a choice: it
    // would only block removing the role later.
    if (!MODEL_ROLE_ORDER.includes(role) && !(entries || []).length) continue;
    roles[role] = (entries || []).map((e) => ({ provider: e.provider, model: e.model, effort: e.effort || null }));
  }
```

After the King Louie functions and listeners (Task 11), add:

```js
/* --- Models tab: custom roles (spec 2026-09-27 §6.2, §11) --- */

function customRoleOf(role) {
  return (appState.modelProfiles?.customRoles || []).find((r) => r.id === role) || null;
}

function customRoleLabel(role) {
  const r = customRoleOf(role);
  return `Custom role: ${role}${r?.description ? ` (${r.description})` : ''}`;
}

function describeCustomRole(r) {
  const needs = [
    r.needs?.toolCall ? 'tool calling' : null,
    r.needs?.imageInput ? 'image input' : null,
    r.needs?.minContext ? formatContext(r.needs.minContext) : null
  ].filter(Boolean);
  return `${r.id}: ${r.description || 'no description'} · falls back to ${r.fallback}${needs.length ? ` · needs ${needs.join(', ')}` : ''}`;
}

function setCustomRolesStatus(text, isError = false) {
  if (!dom.modelsCustomRolesStatus) return;
  dom.modelsCustomRolesStatus.textContent = text;
  dom.modelsCustomRolesStatus.classList.toggle('error', Boolean(isError));
}

function renderCustomRoles() {
  const list = dom.modelsCustomRoleList;
  if (!list) return;
  list.textContent = '';
  const roles = appState.modelProfiles?.customRoles || [];
  if (!roles.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No custom roles.';
    list.appendChild(empty);
    return;
  }
  for (const r of roles) {
    const row = document.createElement('div');
    row.className = 'models-custom-role';
    row.dataset.roleId = r.id;
    const label = document.createElement('span');
    label.textContent = describeCustomRole(r);
    row.appendChild(label);
    for (const [action, text, cls] of [['edit', 'Edit', 'btn'], ['delete', 'Delete', 'btn btn-danger']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.dataset.customRoleAction = action;
      b.dataset.roleId = r.id;
      row.appendChild(b);
    }
    list.appendChild(row);
  }
}

function fillCustomRoleForm(r) {
  if (dom.modelsCustomRoleId) dom.modelsCustomRoleId.value = r?.id || '';
  if (dom.modelsCustomRoleDescription) dom.modelsCustomRoleDescription.value = r?.description || '';
  if (dom.modelsCustomRoleFallback) dom.modelsCustomRoleFallback.value = r?.fallback || 'worker';
  if (dom.modelsCustomRoleTools) dom.modelsCustomRoleTools.checked = Boolean(r?.needs?.toolCall);
  if (dom.modelsCustomRoleImages) dom.modelsCustomRoleImages.checked = Boolean(r?.needs?.imageInput);
  if (dom.modelsCustomRoleMinContext) dom.modelsCustomRoleMinContext.value = r?.needs?.minContext ? String(r.needs.minContext) : '';
}

if (dom.modelsSaveCustomRoleBtn) {
  dom.modelsSaveCustomRoleBtn.addEventListener('click', async () => {
    const minContext = String(dom.modelsCustomRoleMinContext?.value || '').trim();
    try {
      const result = unwrapIpcResult(await window.electron.models.saveCustomRole({
        id: String(dom.modelsCustomRoleId?.value || '').trim(),
        description: String(dom.modelsCustomRoleDescription?.value || '').trim(),
        fallback: dom.modelsCustomRoleFallback?.value || 'worker',
        needs: {
          toolCall: Boolean(dom.modelsCustomRoleTools?.checked),
          imageInput: Boolean(dom.modelsCustomRoleImages?.checked),
          ...(minContext ? { minContext: Number(minContext) } : {})
        }
      }), 'Unable to save the custom role.');
      setCustomRolesStatus(`Saved ${result.role.id}.`);
      fillCustomRoleForm(null);
      await loadModelProfiles();
    } catch (err) {
      setCustomRolesStatus(err.message, true);
    }
  });
}

if (dom.modelsCustomRoleList) {
  dom.modelsCustomRoleList.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-custom-role-action]');
    if (!btn) return;
    const id = btn.dataset.roleId;
    if (btn.dataset.customRoleAction === 'edit') {
      fillCustomRoleForm(customRoleOf(id));
      return;
    }
    // No native dialogs: a second click confirms.
    if (btn.dataset.confirming !== 'true') {
      btn.dataset.confirming = 'true';
      btn.textContent = 'Click again to delete';
      return;
    }
    try {
      unwrapIpcResult(await window.electron.models.removeCustomRole(id), 'Unable to delete the custom role.');
      setCustomRolesStatus(`Deleted ${id}.`);
      await loadModelProfiles();
    } catch (err) {
      setCustomRolesStatus(err.message, true);
      await loadModelProfiles();
    }
  });
}
```

- [ ] **Step 8: Run the unit tests to verify they pass**

Run: `node --test tests/models-custom-roles.test.js tests/renderer-models-m3.test.js tests/models-profiles.test.js tests/models-resolver.test.js tests/model-choices.test.js tests/models-profiles-ipc.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js tests/renderer-models-m2.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Run the e2e test**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/models-roles.test.js tests/e2e/models-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/models/profiles.js src/core/model-choices.js src/core/create-core.js src/ipc/constants.js src/ipc/models-handlers.js preload.js index.html renderer.js styles.css tests/models-custom-roles.test.js tests/renderer-models-m3.test.js tests/e2e/models-roles.test.js
git commit -m "feat(models): custom roles under Models → Advanced, refused while a profile or case role uses them"
```

---

## Task 13: The `models` and `profiles` service commands; CLAUDE.md

**Files:**
- Create: `src/service/commands/models.js`
- Modify: `src/service/cli.js` (`HELP`; `withServiceCore` handles an async `fn`; two `case`s), `CLAUDE.md` (the `## Models` section)
- Test: `tests/service-cli-models.test.js` (new); run `tests/service-cli.test.js`, `tests/service-cli-channel.test.js`

**Interfaces:**
- Consumes: `withServiceCore(dataDir, io, fn)` and `runningServicePid(dataDir)` (`src/service/cli.js`); `core.models.{ catalog, availability, profiles }` (`catalog.status()`, `catalog.refresh({ force })`, `availability.statusAll()`, `availability.testAll()`, `profiles.list()`, `profiles.defaultId()`, `profiles.setDefault(id)`); `core.context.explainTarget(provider, model, { needs })`.
- Produces:
  - `king-louie-service models status` prints `Catalog: <source>, <date> (<n> models)` and one line per provider (`ok`, `failed` with its error, or `not tested`); `models refresh` refreshes the catalog and scores and retests every credentialed provider, then prints the same (refused, exit 1, while the service runs on the data dir).
  - `king-louie-service profiles list` prints each profile (`*` marks the default) with its main models; `profiles show <id-or-name>` prints every role's models with usability; `profiles set-default <id-or-name>` makes it the default (refused, exit 1, while the service runs). A missing argument or unknown subcommand exits 2; an unknown profile exits 1.
  - `withServiceCore` restores data-dir ownership after an async `fn` settles, not before.

- [ ] **Step 1: Write the failing test**

Create `tests/service-cli-models.test.js`:

```js
// tests/service-cli-models.test.js
// `king-louie-service models` and `profiles` (models spec 2026-09-27 §12):
// the catalog and provider statuses, a refresh, and the profiles headless
// runs resolve through. The catalog fetch is off, so nothing touches the network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main } = require('../src/service/cli');

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdin: Readable.from(['']),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });

const t = (provider, model, effort = null) => ({ provider, model, effort });
const SETTINGS = {
  models: {
    catalog: { fetch: false },
    profiles: [
      { id: 'p-a', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } },
      { id: 'p-b', name: 'Cheap', kind: 'user', roles: { main: [t('openai', 'gpt-5.4-mini', 'low')], worker: [], utility: [] } }
    ],
    defaultProfileId: 'p-a'
  }
};

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-models-'));
  createdTempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'chat-data.json'), JSON.stringify({ settings: SETTINGS }));
  return dir;
}
const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')).settings;
const running = (dir) => fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));

describe('service CLI — models', () => {
  it('status prints the catalog and each provider', async () => {
    const t1 = io();
    assert.strictEqual(await main(['models', 'status', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /^Catalog: (snapshot|cache|live), \d{4}-\d{2}-\d{2} \(\d+ models\)/m);
    assert.match(text, /Providers:/);
    assert.match(text, /openai\s+not tested/);
  });

  it('refresh refreshes and retests, and refuses while the service runs', async () => {
    const dir = dataDir();
    const ok = io();
    assert.strictEqual(await main(['models', 'refresh', '--data-dir', dir], ok), 0);
    assert.match(ok.out.join(''), /Tested 0 providers\./);
    assert.match(ok.out.join(''), /Catalog:/);
    running(dir);
    const refused = io();
    assert.strictEqual(await main(['models', 'refresh', '--data-dir', dir], refused), 1);
    assert.match(refused.err.join(''), /The service is running/);
  });

  it('refuses an unknown subcommand', async () => {
    const t1 = io();
    assert.strictEqual(await main(['models', 'nope', '--data-dir', dataDir()], t1), 2);
    assert.match(t1.err.join(''), /Usage: king-louie-service models status\|refresh/);
  });
});

describe('service CLI — profiles', () => {
  it('list marks the default and names each main', async () => {
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'list', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /^\* p-a {2}Work {2}\(user\) {2}main: openai\/gpt-5\.5$/m);
    assert.match(text, /^ {2}p-b {2}Cheap {2}\(user\) {2}main: openai\/gpt-5\.4-mini$/m);
  });

  it('show prints each role\'s models with whether they can be used, by id or name', async () => {
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'show', 'cheap', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /Cheap \(p-b, user\)/);
    assert.match(text, /openai\/gpt-5\.4-mini @low {2}not usable: No token saved for OpenAI/);
    assert.match(text, /worker: \(none\)/);
  });

  it('set-default writes the default, and refuses while the service runs', async () => {
    const dir = dataDir();
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'p-b', '--data-dir', dir], t1), 0);
    assert.match(t1.out.join(''), /Cheap is now the default profile/);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-b');
    running(dir);
    const refused = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'p-a', '--data-dir', dir], refused), 1);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-b');
  });

  it('says so for a missing argument or an unknown profile', async () => {
    const usage = io();
    assert.strictEqual(await main(['profiles', 'show', '--data-dir', dataDir()], usage), 2);
    assert.match(usage.err.join(''), /Usage: king-louie-service profiles/);
    const unknown = io();
    assert.strictEqual(await main(['profiles', 'show', 'Nope', '--data-dir', dataDir()], unknown), 1);
    assert.match(unknown.err.join(''), /No profile "Nope"/);
  });

  it('is in the help', async () => {
    const t1 = io();
    await main(['help'], t1);
    assert.match(t1.out.join(''), /king-louie-service models status\|refresh/);
    assert.match(t1.out.join(''), /king-louie-service profiles list\|show <id-or-name>\|set-default <id-or-name>/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/service-cli-models.test.js`
Expected: FAIL — `Unknown command "models"` (exit 2), and the help lacks the lines.

- [ ] **Step 3: The commands**

Create `src/service/commands/models.js`:

```js
// src/service/commands/models.js
// `king-louie-service models` and `profiles` (models spec 2026-09-27 §12):
// the catalog and provider statuses, a refresh, and the profiles headless
// runs resolve through (the default one, M-D12). CLI output goes to
// io.stdout and io.stderr on purpose.

const MODELS_USAGE = 'Usage: king-louie-service models status|refresh [--data-dir DIR]\n';
const PROFILES_USAGE = 'Usage: king-louie-service profiles list|show <id-or-name>|set-default <id-or-name> [--data-dir DIR]\n';

// A running service holds its own copy of the stores and would overwrite a
// change made underneath it.
function refuseWhileRunning(dataDir, io, runningServicePid) {
  const pid = runningServicePid(dataDir);
  if (!pid) return false;
  io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
  return true;
}

function formatCatalog(status) {
  const date = String(status.fetchedAt || status.snapshotDate || 'unknown date').slice(0, 10);
  return `Catalog: ${status.source}, ${date} (${status.models} models)${status.stale ? ' — old: run "models refresh"' : ''}\n`;
}

function formatProviders(statuses) {
  const lines = ['Providers:'];
  for (const [provider, s] of Object.entries(statuses || {})) {
    let state;
    if (!s) state = 'not tested';
    else if (s.ok) state = `ok      ${s.checkedAt || ''}  ${Array.isArray(s.models) ? s.models.length : 0} models`;
    else state = `failed  ${s.checkedAt || ''}  ${s.error || s.message || 'unknown error'}`;
    lines.push(`  ${provider.padEnd(11)}${state}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runModelsCommand({ sub, dataDir, io, deps }) {
  if (sub !== 'status' && sub !== 'refresh') {
    io.stderr.write(MODELS_USAGE);
    return 2;
  }
  if (sub === 'refresh' && refuseWhileRunning(dataDir, io, deps.runningServicePid)) return 1;
  return deps.withServiceCore(dataDir, io, async (core) => {
    const { catalog, availability } = core.models;
    if (sub === 'refresh') {
      await catalog.refresh({ force: true });
      const tested = Object.keys(await availability.testAll());
      io.stdout.write(`Tested ${tested.length} provider${tested.length === 1 ? '' : 's'}.\n`);
    }
    io.stdout.write(formatCatalog(catalog.status()));
    io.stdout.write(formatProviders(availability.statusAll()));
    return 0;
  });
}

// By id, else by name, ignoring case.
function findProfile(profiles, ref) {
  const want = String(ref || '').trim();
  if (!want) return null;
  const list = profiles.list();
  return list.find((p) => p.id === want) || list.find((p) => p.name.toLowerCase() === want.toLowerCase()) || null;
}

const label = (t) => `${t.provider}/${t.model}`;

function formatProfile(profile, { defaultId, explainTarget }) {
  const lines = [`${profile.id === defaultId ? '* ' : '  '}${profile.name} (${profile.id}, ${profile.kind})`];
  for (const [role, list] of Object.entries(profile.roles)) {
    if (!list.length) {
      lines.push(`    ${role}: (none)`);
      continue;
    }
    lines.push(`    ${role}:`);
    for (const t of list) {
      const verdict = explainTarget(t.provider, t.model, {}) || {};
      const state = verdict.usable ? 'usable' : `not usable: ${(verdict.reasons || []).join(' ')}`;
      lines.push(`      ${label(t)}${t.effort ? ` @${t.effort}` : ''}  ${state}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function runProfilesCommand({ sub, arg, dataDir, io, deps }) {
  if (!['list', 'show', 'set-default'].includes(sub) || (sub !== 'list' && !arg)) {
    io.stderr.write(PROFILES_USAGE);
    return 2;
  }
  if (sub === 'set-default' && refuseWhileRunning(dataDir, io, deps.runningServicePid)) return 1;
  return deps.withServiceCore(dataDir, io, (core) => {
    const profiles = core.models.profiles;
    const defaultId = profiles.defaultId();
    if (sub === 'list') {
      const list = profiles.list();
      if (!list.length) io.stdout.write('No profiles.\n');
      for (const p of list) {
        io.stdout.write(`${p.id === defaultId ? '* ' : '  '}${p.id}  ${p.name}  (${p.kind})  main: ${p.roles.main.map(label).join(', ') || '(none)'}\n`);
      }
      return 0;
    }
    const profile = findProfile(profiles, arg);
    if (!profile) {
      io.stderr.write(`No profile "${arg}". Run "king-louie-service profiles list".\n`);
      return 1;
    }
    if (sub === 'show') {
      io.stdout.write(formatProfile(profile, { defaultId, explainTarget: core.context.explainTarget }));
      return 0;
    }
    profiles.setDefault(profile.id);
    io.stdout.write(`${profile.name} is now the default profile. Headless runs use it from the next start.\n`);
    return 0;
  });
}

module.exports = { runModelsCommand, runProfilesCommand };
```

- [ ] **Step 4: Wire them into the CLI**

In `src/service/cli.js`, in `HELP`, after

```
  king-louie-service desktop list [--data-dir DIR]
```

add

```
  king-louie-service models status|refresh [--data-dir DIR]
  king-louie-service profiles list|show <id-or-name>|set-default <id-or-name> [--data-dir DIR]
```

Replace the whole `function withServiceCore(dataDir, io, fn) { … }` with:

```js
function withServiceCore(dataDir, io, fn) {
  const { createCore } = require('../core');
  const { CHAT_DATA_DEFAULTS } = require('../core/settings');
  const { buildServicePorts } = require('./ports');
  const { restoreDataDirOwnership } = require('./ownership');
  const writtenPaths = [];
  const restore = () => restoreDataDirOwnership(dataDir, writtenPaths, io.ownership);
  let result;
  try {
    const ports = buildServicePorts({
      dataDir,
      chatDataDefaults: CHAT_DATA_DEFAULTS,
      onPathWritten: (p) => writtenPaths.push(p)
    });
    const core = createCore({ ...ports, adminExecutors: NO_ADMIN_EXECUTORS });
    result = fn(core, ports);
  } catch (err) {
    restore();
    throw err;
  }
  // An async fn (models refresh) writes until it settles: ownership is
  // restored after that, not before.
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}
```

Before `      case 'desktop': {`, add:

```js
      case 'models': {
        const { runModelsCommand } = require('./commands/models');
        return await runModelsCommand({ sub, dataDir, io, deps: { runningServicePid, withServiceCore } });
      }

      case 'profiles': {
        const { runProfilesCommand } = require('./commands/models');
        return await runProfilesCommand({ sub, arg, dataDir, io, deps: { runningServicePid, withServiceCore } });
      }

```

- [ ] **Step 5: CLAUDE.md**

In `CLAUDE.md`, in `## Models`, replace `stages M1 and M2). It is Electron-free.` with `stages M1 to M3). It is Electron-free.`, and append to the section's list:

```markdown
- Roles in use (stage M3): chat titles run on utility; SpawnAgent and
  BackgroundTask take a `role` (a bare call runs on worker), and a `model`
  an LLM names (SpawnAgent, a planned workflow task's `preferredModel`) must
  already be in the turn's profile (`requireInProfile`). The explorer is the
  read-only `code-explorer` agent on worker; main's agent-mode prompt starts
  with `DELEGATION_GUIDANCE` (`src/context/system-sections.js`).
- Every call's `llmMetrics` carries `role`, `profileId`, `failover` and
  `borrowedFrom` (stamped by the router from `routedProvider({ meta })`) and
  `pricingUsage`; a reply's `llm` has `subagents` and `byRole`
  (`summarizeTurnLlm`); `UsageTracker` totals by role and model.
- The King Louie profile (`src/models/suggester.js`, `src/models/king-louie.js`)
  only proposes; the first Accept creates it, and only Accept (or
  `models.kingLouie.autoAccept`) changes it. Custom roles are saved through
  `Profiles#saveCustomRole` and never removed while a profile or case role
  names them.
- `king-louie-service models status|refresh` and `profiles list|show|set-default`
  work on the data dir; the writing ones refuse while the service runs.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/service-cli-models.test.js tests/service-cli.test.js tests/service-cli-channel.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/service/commands/models.js src/service/cli.js CLAUDE.md tests/service-cli-models.test.js
git commit -m "feat(service): models status|refresh and profiles list|show|set-default"
```

---

## Stage end (controller)

- [ ] Run `npm test` and confirm `# fail 0`, and that no suite failed to build (a file that throws while loading reports as a failed suite, not as a failed test).
- [ ] Run `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` and confirm `# fail 0`.
- [ ] Run `git grep -nE "inferenceTier: '|model: 'claude-sonnet|executeOptions\.provider = |settings\.advisor\.model" -- src templates` and confirm no match (built-in agents name no model; workflows never split a planned model into a provider).
- [ ] Start the app on a copy of an M2 profile (`--user-data-dir=<temp copy>`) with at least one tested key: Settings → Models shows a King Louie proposal with reasons and a cost effect; Accept creates "King Louie selected" and leaves the default profile alone; an agent-mode reply's metrics line splits cost by role; a new chat's title is recorded under utility (`usage:getSession` shows `roles.utility`).
