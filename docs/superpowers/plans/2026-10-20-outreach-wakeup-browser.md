# Outreach wake-up browser tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `outreach` case's wake-up turns can navigate, read, extract and screenshot with the browser tools (look only), so the case can read a messaging inbox between owner turns.

**Architecture:** A case type gains an optional `wakeupTools()` hook; `wakeupToolsFor(type)` in the case-type registry reads it. The wake-up turn runner adds those names to both the orient call's tool definitions and the judge loop's `allowedToolNames`. The case-turn guard and `denyAutoApproval` already confine what those tools may do in a case run; nothing there changes.

**Tech Stack:** Node (CommonJS), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md`

## Global Constraints

- Tests use `node --test tests/<file>.test.js`, never Jest (CLAUDE.md, Testing).
- `src/` stays Electron-free; `src/cases/` stays free of personal values (`tests/examples.test.js` denylist applies to docs and fixtures).
- `WAKEUP_BASE_TOOLS` itself does not change; `general` and `software-repo` wake-ups get exactly what they get today.
- The four names are exactly `Browser`, `BrowserSession`, `BrowserPage`, `BrowserExtract` (the registered tool names in `src/tools/builtin/browser-*.js`).

## Review Focus

- A wake-up of an `outreach` case whose judge model calls `Browser` with `action: 'fill'` must be refused with the guard's `BROWSER_REFUSAL`, not typed (Task 2 test).
- The same wake-up calling `Browser` with `action: 'click'` must be refused: an acting action under `denyAutoApproval` with no approval requester is denied, never run (Task 2 test).
- A `general` case's wake-up must offer and allow exactly the tool set it offers today (Task 2 keeps the existing exact-set assertion for a general case).
- A case whose `case.yaml` type is unknown on disk resolves to `general` (`resolveCaseType`), so `wakeupToolsFor('no-such-type')` is `[]` (Task 1 test).
- The orient call and the judge loop must see the same list: a wake-up where orient sees browser tools but judge may not call them (or the reverse) is a bug (Task 2 asserts both `calls.judgeTools[0]` and `opts.allowedToolNames`).

---

### Task 1: `wakeupToolsFor(type)` in the case-type registry

**Files:**
- Modify: `src/cases/case-types/outreach.js`
- Modify: `src/cases/case-types/index.js` (add the function, export it)
- Test: `tests/cases-case-types.test.js`

**Interfaces:**
- Produces: `wakeupToolsFor(type: string) → string[]` exported from `src/cases/case-types/index.js`. Reads the resolved type's optional `wakeupTools()`; returns a fresh array (`[]` when the hook is missing or the type is unknown). `outreach.wakeupTools()` returns `['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']`.

- [ ] **Step 1: Write the failing test** in `tests/cases-case-types.test.js`, inside the existing registry `describe`:

```js
it('wakeupToolsFor: outreach declares the four browser tools, the other types and an unknown type declare none', () => {
  assert.deepStrictEqual(types.wakeupToolsFor('outreach'), ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']);
  assert.deepStrictEqual(types.wakeupToolsFor('general'), []);
  assert.deepStrictEqual(types.wakeupToolsFor('software-repo'), []);
  assert.deepStrictEqual(types.wakeupToolsFor('no-such-type'), []);
  // A fresh array each call: a caller that pushes into it changes nothing for the next.
  types.wakeupToolsFor('outreach').push('Bash');
  assert.deepStrictEqual(types.wakeupToolsFor('outreach'), ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/cases-case-types.test.js`
Expected: FAIL with `types.wakeupToolsFor is not a function`.

- [ ] **Step 3: Implement.** In `outreach.js` add `wakeupTools: () => ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']` with a two-line comment citing the spec and the owner ruling of 2026-10-20 (look only; the case guard refuses typing and a wake-up's `denyAutoApproval` refuses `click`). In `index.js` add `function wakeupToolsFor(type)` next to `briefFieldsFor`, built on `resolveCaseType`, and export it.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test tests/cases-case-types.test.js`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/case-types/outreach.js src/cases/case-types/index.js tests/cases-case-types.test.js docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md docs/superpowers/plans/2026-10-20-outreach-wakeup-browser.md
git commit -m "feat(cases): a case type may declare wake-up tools; outreach declares the browser tools"
```

---

### Task 2: the wake-up turn offers and allows the type's tools

> Review note (2026-10-20): this task's click assertion was too weak. It
> checked only that the click failed for some reason other than the guard,
> which "User denied permission" satisfied, while every look-only call was
> denied the same way. Task 2b fixes it.

**Files:**
- Modify: `src/cases/turn-runner.js:234-235` (orient `baseDefs`) and `:275` (`allowedToolNames`)
- Modify: `CLAUDE.md`, section "Cases: unattended (stage 2)", the wake-ups bullet
- Test: `tests/cases-turn-runner.test.js`

**Interfaces:**
- Consumes: `wakeupToolsFor(type)` from Task 1 (`require('./case-types')` in `turn-runner.js`).
- Produces: nothing new; the wake-up's `allowedToolNames` is `new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS, ...wakeupToolsFor(type)])` and the orient/judge `toolDefs` are built from `[...WAKEUP_BASE_TOOLS, ...wakeupToolsFor(type)]`, where `type` is `runtime.getCase(caseId).type`.

- [ ] **Step 1: Write the failing tests** in `tests/cases-turn-runner.test.js`. Add a helper beside `activeCase` that creates an outreach case: same body with `type: 'outreach'` in the `createCase` options. Then, in the `describe` that holds the existing "allowedToolNames" assertions (the test at about line 146 keeps its exact-set assertion for the general case):

```js
it('an outreach case wake-up offers and allows the browser tools, look only (spec 2026-10-20)', async () => {
  const { BROWSER_REFUSAL } = require('../src/cases/executors/case-guard');
  const { runtime, clock, calls } = harness({
    judge: [
      { type: 'tool_use', toolCalls: [
        { toolName: 'Browser', toolUseId: 't1', parameters: { action: 'fill', selector: '#msg', text: 'hello' } },
        { toolName: 'Browser', toolUseId: 't2', parameters: { action: 'click', selector: '#send' } }
      ] },
      { type: 'text', content: 'Done.' }
    ]
  });
  const c = await activeOutreachCase(runtime);
  dueWakeup(runtime, c, clock);
  await runtime.runDueWakeups(clock.now);
  const opts = calls.executorOptions;
  const browserTools = ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract'];
  assert.deepStrictEqual([...opts.allowedToolNames].sort(), [...CASE_TOOL_NAMES, 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', ...browserTools].sort());
  for (const name of browserTools) assert.ok(calls.judgeTools[0].includes(name), name);
  assert.strictEqual(opts.denyAutoApproval, true);
  // Typing is refused by the case guard; an acting click is refused because nothing can approve it in a wake-up.
  const [fill, click] = calls.results.filter(([name]) => name === 'Browser').map(([, r]) => r);
  assert.deepStrictEqual([fill.ok, fill.error], [false, BROWSER_REFUSAL]);
  assert.strictEqual(click.ok, false);
  assert.notStrictEqual(click.error, BROWSER_REFUSAL);
});

it('a general case wake-up still offers no browser tool', async () => {
  const { runtime, clock, calls } = harness({ judge: [{ type: 'text', content: 'Done.' }] });
  const c = await activeCase(runtime);
  dueWakeup(runtime, c, clock);
  await runtime.runDueWakeups(clock.now);
  for (const name of ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']) {
    assert.ok(!calls.judgeTools[0].includes(name), name);
    assert.ok(!calls.executorOptions.allowedToolNames.has(name), name);
  }
});
```

If the harness's `postExecute` rows carry the result under another key than `ok`/`error` (see how line ~158 reads them), match that shape; the assertions are the point.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/cases-turn-runner.test.js`
Expected: the outreach test FAILS on the `allowedToolNames` set (no browser names); the general test passes already.

- [ ] **Step 3: Implement** in `turn-runner.js`: require `wakeupToolsFor` from `./case-types`; in `runWakeup`, read `const extra = wakeupToolsFor(runtime.getCase(caseId).type)` once, before `baseDefs`, and use `[...WAKEUP_BASE_TOOLS, ...extra]` at line 234 and `new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS, ...extra])` at line 275. Update the comment above `baseDefs` ("The same confined tool list the judge loop below gets") to say the list is the base tools plus the type's wake-up tools.

- [ ] **Step 4: Run the test file and the guard tests to verify they pass**

Run: `node --test tests/cases-turn-runner.test.js tests/cases-case-guard.test.js tests/cases-case-types.test.js`
Expected: `# fail 0`.

- [ ] **Step 5: Document.** In `CLAUDE.md`, "Cases: unattended (stage 2)", after the sentence ending "(`allowedToolNames`, `denyAutoApproval`, no owner messages)", add: "A case type may add wake-up tools (`wakeupToolsFor` in `src/cases/case-types/index.js`); `outreach` adds the four browser tools, look only: the case guard refuses typing and `denyAutoApproval` refuses `click`, so a wake-up reads an inbox and sends only through Executor jobs (spec `docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md`)."

- [ ] **Step 6: Commit**

```bash
git add src/cases/turn-runner.js tests/cases-turn-runner.test.js CLAUDE.md
git commit -m "feat(cases): outreach wake-ups get the look-only browser tools"
```

---

### Task 2b: the wake-up browser gate (review fix, 2026-10-20)

The defect: all four browser tools declare `requiresApproval: true` and a
wake-up runs under `denyAutoApproval`, so every browser call in a wake-up,
`status`, `content` and `navigate` included, reached `requestApproval`. On the
desktop nothing answers it ("User denied permission", counted by the denial
tracker); on a service node with phone approvals the phone was asked for each
call, and an approved `click` would have run.

The fix, in `ToolExecutor` after the case guard and the profile guard: for a
wake-up (`caseContext.source === 'wakeup'`) and one of `BROWSER_TOOLS`, an
acting call (`isActingBrowserCall`) is refused `{ success: false, error:
WAKEUP_BROWSER_ACTING_REFUSAL, deniedBy: 'policy', code: 'wakeup_browser_acting' }`
before any approver; any other (look-only) call is left out of
`toolWouldGate`, so it runs without a prompt. A `deny` rule and an `unsafe`
tier still apply. Tests: the outreach wake-up test in
`tests/cases-turn-runner.test.js` (status runs, click refused by policy) and
"ToolExecutor wake-up browser gate" in `tests/tool-executor.test.js`.

---

### Task 3: whole-change review and the covering suites

- [ ] **Step 1: Run the suites a reviewer would ask for**

Run: `node --test tests/cases-turn-runner.test.js tests/cases-case-types.test.js tests/cases-case-guard.test.js tests/cases-service-wakeups.test.js tests/management-tools.test.js tests/fleet-chat-tools.test.js tests/examples.test.js`
Expected: `# fail 0` for each.

- [ ] **Step 2: One fresh reviewer** (superpowers:requesting-code-review) reads the diff against `main` with the spec; fix what it finds; rerun Step 1.
