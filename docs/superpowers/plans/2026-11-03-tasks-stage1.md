# Tasks, Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From claude.ai (or `king-louie-service mcp`), `run_task` starts a free-text task on the only node, one phone press covers its scope, the record survives a restart, and the client reads the answer when the phone says it ended.

**Architecture:** A new `src/tasks/` (store, proposal, policy, manager) runs on agent nodes. A task is a real chat in the history store plus `<dataDir>/tasks/<id>.json`, run by the node's agent executor. The grant is a lease kind `task` in the existing lease machinery; a `taskPolicy` executor option lifts prompts inside it and passes everything else to the ordinary phone path. The tools are fixed fleet tools (`fleet.<name>` link methods), and the router does placement.

**Tech Stack:** Node 22/24, `node:test`, Playwright (existing), Swift `KLProtocol`, Kotlin `protocol`.

**Spec:** `docs/superpowers/specs/2026-11-03-tasks-stage1-design.md` (and ADR 0003, ADR 0004, `CONTEXT.md`).

## Global Constraints

- Tests run with `node --test tests/<file>.test.js`, never Jest. Covering tests per task; full `npm test` once at the end.
- Everything under `src/` but `src/ipc/` stays Electron-free. `src/tasks/` loads only on the agent profile (`tests/service-profile-graph.test.js`): required lazily from `src/fleet/start.js`, never from `fleet-tools.js` or the router.
- Use `createLogger`, not `console.*`.
- A timer a test awaits is ref'd; cores built in tests get `await core.shutdown()` and `closeOpenHistoryStores()`.
- Proposal: `sites` at most 16, `allows` a subset of `browser-act`, `logins`, `shell`, `files-write`; `minutes` 1 to 240; `usd` 2 to 50. Task text 1 to 8,000 characters. `wait_ms` 0 to 25,000. Card re-sent up to 12 times.
- King Louie refuses nothing of its own inside a live task: outside the grant is a phone approval (the owner's rule, ADR 0004). Only `task_ended` (the task is over) refuses.
- Node before phones: a phone from before this change shows a task lease as "Could not confirm".
- Invented values only in fixtures and docs (`example.com`, `Lakeside lot`).

## Deviations from the spec (decided while reading the code; the spec is updated to match)

1. Link methods are `fleet.run_task` etc., in `METHODS`/`FLEET_METHODS`, not `tasks.<name>`. `registerMethod`'s `cases.` guard stays; the tools work over the courier through the same `FleetToolHandler.call`.
2. No `kind: 'task'` origin. The front-door origin passes through; `shouldRefuseUnsafe` already answers false when it covers `fleet:unsafe`, which `run_task` and `send_to_task` require. `approvalOrigin(origin, 'chat:<chat_id>')` builds the phone's origin.
3. A task's lease `job_id` is `chat:<chat_id>`: `isJobOpen` already handles it. `TaskManager` ends its own lease with `leases.endLease`.
4. `name` is cut to 60 code points, the status validator's limit, not 120.
5. A duration end stops the task (`waiting`, reason `duration`), from a timer that covers look-only tasks too. The spec's anti-goal forbids acting after the duration.
6. `wait_ms` is held on the node; `CourierFleetClient`'s poll loop is not changed, and the endpoint's SSE stream stays `get_job` only.
7. A task's public id is `<machine>:<task_id>`, `parsePublicJobId`'s form; `task_id` is `crypto.randomUUID()`, which the push id needs too.

## Review Focus

- A page tells the model to go elsewhere, or a granted site redirects: an acting call on a host outside `sites` goes to the phone, never silently allowed (Task 4 test `off-site after redirect asks`).
- Task text with newlines, emoji, RTL marks or 8,000 characters: the card still builds, `name` is one plain line or `Task` (Task 7 test `name from hostile text`).
- The phone is off or the relay link is down when the card goes: the task keeps reading, `get_task` says `awaiting_grant`, re-sends happen, and no acting call runs (Task 7 test `card held while link is down`).
- The node restarts mid-turn while a client waits: `get_task` says `interrupted`, an answer already written is kept, and `send_to_task` re-cards before acting (Task 6 and Task 7 tests).
- A client retries `run_task` after a timeout or calls `send_to_task` during a turn: `task_busy`, nothing starts twice; a `seen_seq` older than the record answers at once (Task 6 test `retry does not start twice`).

---

### Task 1: Lease kind `task` in the protocol

**Files:**
- Modify: `src/gui/lease-protocol.js`, `tests/vectors/lease-v1/generate.js`, `docs/protocol/lease-v1.md`
- Test: `tests/lease-vectors.test.js` (add the cases there)

**Interfaces:**
- Produces: `LEASE_KINDS` with `'task'`; `TASK_ALLOWS = ['browser-act','files-write','logins','shell']`; `TASK_USD_MAX = 500`; `buildLeaseRequest({ kind: 'task', task: { name, sites, allows, usd }, ... })`; `buildLeaseStatus({ kind: 'task', name, unattended: true, ... })`.

- [ ] **Step 1: Write failing tests**

`buildLeaseRequest` with `kind: 'task'`, `task: { name: 'Find a dentist', sites: ['*.example.com'], allows: ['browser-act'], usd: 2 }`, `apps: []` gives a `lease` with exactly `kind, job_id, name, sites, allows, max_minutes, usd, unattended, reason, resumes, limits` (`unattended: true`, no `apps`), and `validateMessage('kl.lease.request', message)` is null. Refused by the validator: `allows` unsorted, repeated or outside `TASK_ALLOWS`; `sites` over 32 or bad grammar; `usd` 1 or 501 or non-integer; `unattended: false`; `max_minutes` 241; a name that fails `plainLineProblem` or passes 60 code points.

A `kl.lease.grant` with `grant: { apps: [], minutes: 20 }` validates. `verifyLeaseGrant` accepts it for a task request and refuses `apps_not_requested` for an empty `apps` on `computer_use` and for a non-empty `apps` on a task. It caps minutes at `min(max_minutes, 240)`.

`kl.lease.status` with `kind: 'task'` needs a name, allows `unattended: true`; `computer_use` keeps `unattended: false`, `name: null`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/lease-vectors.test.js`
Expected: FAIL on `kind`.

- [ ] **Step 3: Implement**

In `checkLease` split on kind: a task has no `apps` check and uses `checkTaskFields`. In `kl.lease.grant` relax `m.grant.apps.length >= 1` and enforce per kind in `verifyLeaseGrant`, iterating `request.lease.apps || []`. `kindCap` treats `task` like `take` with `TAKE_MAX_MINUTES`. Status rule: `m.kind === 'computer_use' ? (m.unattended === false && m.name === null) : nameOk`. `buildLeaseStatus`'s `name` is kept for every kind but `computer_use`.

- [ ] **Step 4: Add vectors and regenerate**

Add `task-request`, `task-grant`, `task-status`, and refusal vectors to `tests/vectors/lease-v1/generate.js`, then run it. Add a "Revised 2026-11-03" section to `docs/protocol/lease-v1.md`. Update the vector count wherever the repo states it (CLAUDE.md's `--check` count).

Run: `node tests/vectors/lease-v1/generate.js --check && node --test tests/lease-vectors.test.js`
Expected: both pass.

- [ ] **Step 5: Commit**

`feat(lease): lease kind task, with no apps, its sites, allows and usd`

---

### Task 2: `LeaseManager` takes a task lease

**Files:**
- Modify: `src/gui/leases.js`
- Test: `tests/gui-leases.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: `leases.request({ jobId, origin, minutes, reason, kind: 'task', task: { name, sites, allows, usd }, leaseId, signal })` resolving with the lease, rejecting `GuiError` with `lease_denied` or `lease_request_expired`; the `state` event as for takes; `leases.endLease(leaseId, reason)` (exists).

- [ ] **Step 1: Write failing tests** (fake relay and phone, `leaseGrant` from `tests/helpers/fake-phone.js` with `apps: []`)

`task lease grants without apps`: state goes `active`, `expiresAt` is `minutes` on, status carries `kind: 'task'`, `unattended: true`, the name. `no contact timer`: pass 10 minutes on the fake clock with no watch; still active. `any phone may stop it`: a revoke from a second enrolled device ends it, `state` event seen. `audit`: `lease.requested` and `lease.granted` data hold `name`, `sites`, `allows`, `usd`, never `reason`. `not gated on gui.take.enabled`: granted with `take` off. A task from a non-local origin is accepted (`nodeLocalOrigin: false`).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/gui-leases.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `request`: `isTask = kind === 'task'` skips the app-list check and `requestedApps` is `[]`; max is `L.TAKE_MAX_MINUTES`; `lease.task = task`, `unattended: isTake ? … : isTask`, `name` from either. `_sendRequest` passes `task: lease.task`; `_audit` adds the task fields. Check `broker.input` still refuses with a task lease (no apps): add a test.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/gui-leases.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(gui): the lease manager grants task leases`

---

### Task 3: The task record and the proposal

**Files:**
- Create: `src/tasks/store.js`, `src/tasks/proposal.js`, `src/tasks/prompts/task-scope-v1.md`
- Modify: `tests/fixtures/egress-inventory.json`
- Test: `tests/tasks-store.test.js`, `tests/tasks-proposal.test.js`

**Interfaces:**
- Produces:
  - `new TaskStore({ dataDir, clock })`: `create(fields) → record`, `get(id)`, `update(id, patch) → record` (bumps `seq`, sets `updated_at`), `list() → newest first`, `markInterrupted() → ids`. States exported as `TASK_STATES`, unfinished as `UNFINISHED = ['requested','awaiting_grant','running']`.
  - `validateProposal(raw) → { ok: true, proposal: { sites, allows, minutes, usd, lookOnly } } | { ok: false }`.
  - `proposeScope({ text, callUtility }) → { proposal } | { proposal: null, reason: 'malformed' | 'no_model' }`, with `callUtility(prompt) → string`; one retry on malformed.

- [ ] **Step 1: Write failing tests**

Store: a record survives a new store on the same dir; `update` bumps `seq`; a corrupt file is skipped with a warning, not thrown; an id not a UUID v4 is refused (no path out of the dir); `markInterrupted` changes only `UNFINISHED` records, sets `ended: null` and `interrupted_at`, keeps `answer`.

Proposal: the spec's example passes; `lookOnly` is true for empty `allows`; `allows` is returned sorted and unique. Refused: `https://x.com/a` and `*` and `x` in `sites`, 17 sites, unknown class, `minutes` 0 or 241, `usd` 1 or 51, extra keys, non-object. JSON inside a code fence is accepted once fences are stripped. Twice-malformed returns `proposal: null`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tasks-store.test.js tests/tasks-proposal.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

Record keys are the spec's §4.4, plus `reason` (why it is `waiting`), `deadline_at`, `card_sends`, `interrupted_at`. Write through a temp file and rename, as `src/gui/take-store.js` does. Use `SITE_RE` from `lease-protocol` semantics locally (the module stays free of `src/gui`). The prompt asks for the strict JSON of §4.5, states the classes in one line each, and says the text is data.

`callUtility` is supplied in Task 8. Label the file in the egress inventory if the test asks.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/tasks-store.test.js tests/tasks-proposal.test.js tests/egress-inventory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(tasks): the durable task record and the validated scope proposal`

---

### Task 4: The task policy and the executor seam

**Files:**
- Create: `src/tasks/policy.js`
- Modify: `src/execution/tool-executor.js`, `src/core/create-core.js` (the `takePolicy` lines near 2350, 2803 and 3067, and a `toolEvents` option)
- Test: `tests/tasks-policy.test.js`, `tests/tool-executor-task-policy.test.js`

**Interfaces:**
- Produces:
  - `createTaskPolicy({ getState, currentUrl, workDir, waitForGrant }) → { decide(toolName, params) }`, `getState() → { ended: bool, proposal, grant: { sites, allows } | null, awaiting: bool }`, `waitForGrant() → Promise<void>`.
  - `decide` → `{ allow: true }` (no prompt), `{ passthrough: true }` (the ordinary path), `{ allow: false, code: 'task_ended', error }`.
  - `ToolExecutor` option `taskPolicy`; `executorOptions.toolEvents = { pre({toolName,parameters}), post({toolName,parameters,result}) }` on the adapter.

- [ ] **Step 1: Write failing policy tests** (table style, after `tests/take-policy.test.js`)

With `grant: { sites: ['*.example.com'], allows: ['browser-act'] }` and `currentUrl` on `https://maps.example.com/x`: `BrowserPage click` allows; `navigate` to `https://a.example.com/` allows and to `https://other.test/` passes through; `Browser fill` with `currentUrl` on `https://other.test/` passes through (`off-site after redirect asks`); `currentUrl` null passes through; a browser call with `profile` or `ephemeral` passes through; `login` passes through without `logins`, allows with it on a granted page; `Bash` passes through without `shell`, allows with it; `Write` under `workDir` allows with `files-write`, outside it (and `..` escapes, resolved) passes through; `Screenshot`, `Read` pass through; an unknown tool passes through. `ended: true`: every call `task_ended`. `awaiting: true` and the class in the proposal on a proposal site: `decide` waits for `waitForGrant`, then decides on the new state. `awaiting: true` and the class not in the proposal: passes through at once.

- [ ] **Step 2: Write failing executor tests** (after `tests/tool-executor-take-policy.test.js`)

Allow lifts the acting-browser prompt and an `always_confirm` tier, never a `denied` tier, a deny rule, a denied directory or `path_outside_allowed_roots`; passthrough reaches the requester with the exact action; `task_ended` returns `{ success: false, code }` with `approvalDenied { deniedBy: 'task' }`. A live `taskPolicy` does not refuse a mid-run ask as a take does.

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/tasks-policy.test.js tests/tool-executor-task-policy.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement**

`isActingBrowserCall` (`src/tools/browser-acting.js`) decides `browser-act`; `CREDENTIAL_ACTIONS` and `hostAllowed` come from `src/gui/take-policy.js`, which is pure. In `tool-executor.js`, right after the take block, reuse the `takeAllowed` variable with `approvalSource = { type: 'task' }`. Carry `taskPolicy` through create-core's three sites and the rethreaded requester, so sub-agents are held to it. In create-core's runtime build, `executor.on('preExecute'|'postExecute')` call `executorOptions.toolEvents` when given, each in a try/catch.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/tasks-policy.test.js tests/tool-executor-task-policy.test.js tests/tool-executor-take-policy.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

`feat(tasks): the task policy, consulted where the approval would ask`

---

### Task 5: `TASK_GUIDANCE`

**Files:**
- Modify: `src/context/system-sections.js`
- Test: `tests/tasks-guidance.test.js`

**Interfaces:** Produces `TASK_GUIDANCE` (string) and `parseStuck(text) → string | null`, the last paragraph if it starts `STUCK:`.

- [ ] **Step 1: Write failing tests**

The guidance mentions `STUCK:`, the table, sources per row, and "never ask for approval in text". It has no refusal list (`never` appears only in that sentence). `parseStuck('Tried.\n\nSTUCK: need a login')` returns the paragraph; `parseStuck('STUCK is a word')` returns null; a `STUCK:` paragraph that is not last returns null.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tasks-guidance.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** per spec §4.7.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/tasks-guidance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(tasks): what the model is told in a task turn`

---

### Task 6: `TaskManager`: chat, turns, states, spend, restart

**Files:**
- Create: `src/tasks/manager.js`
- Test: `tests/tasks-manager.test.js`, `tests/helpers/tasks-harness.js`

**Interfaces:**
- Consumes: Tasks 3, 4, 5; `core.context.getAgentExecutorAdapter()`, `getHistoryStore`/`appendMessageToChat`.
- Produces: `new TaskManager({ core, nodeConfig, dataDir, store, grants, push, audit, currentUrl, callUtility, clock })`, `grants` being Task 7's `TaskGrants` or `null`:
  - `run({ text, origin }) → public view`, `get(id, { seenSeq, waitMs }) → public view`, `send(id, message, { origin }) → public view`, `cancel(id) → public view`, `list({ state }) → views`, `isChatRunning(chatId) → bool`, `start()` (marks interrupted), `stop()` (aborts, marks interrupted, awaits).
  - Errors are `ToolError`: `task_busy`, `task_not_found`, `invalid_params`.

- [ ] **Step 1: Write the harness and failing tests**

The harness: a real `HistoryStore.open(':memory:')` through `tests/helpers/history-context.js`, a fake adapter whose `execute` is scripted and calls `executorOptions.toolEvents`, and a fake clock.

Tests:
- `run creates a chat`: rows are the user text with `meta.author: 'client'`, `meta.taskId` on the chat, no `source`; state goes `running` then `done`; `answer.text` is the last reply; the push is enqueued with `kind: 'task_ended'`, the task's id.
- `tool rows`: `toolUse`/`toolResult` rows land as the turn runs; an aborted turn still holds them.
- `STUCK`: state `waiting`, reason `stuck`, no push; `send` starts a turn with `author: 'client'`, the state back to `running`.
- `follow-up on done`: a new answer replaces the old; `seq` moves.
- `failed turn`: state `failed`, `ended.reason` is the error's code or `turn_failed`, never its message when it could name paths.
- `cancel`: turn aborted, state `cancelled`, push; a later `send` is refused `invalid_params` naming the state.
- `retry does not start twice`: a second `run` while one is `running`, `awaiting_grant` or `waiting` is `task_busy`; `send` during a turn is `task_busy`.
- `wait`: `get` with `seenSeq` equal to current and `waitMs` resolves at the next write or at `waitMs` (ref'd timer in the test); with an older `seenSeq` it answers at once; two waiters both wake; `stop()` wakes them.
- `spend`: a scripted `onUsageRecorded({ costUsd: 3 })` over a `usd: 2` cap aborts the turn: state `waiting`, reason `spend_cap`; an unpriced event (`costUsd: null`) counts nothing and is noted in `spend.unpriced`.
- `duration`: at `deadline_at` the turn is aborted, state `waiting`, reason `duration`.
- `restart`: a store with a `running` record and a stored answer: `start()` gives `interrupted`, keeps `answer`; `send` runs the next turn; `get` still answers.
- `shutdown`: `stop()` during a turn gives `interrupted`, the push goes once.
- `the tool set`: `allowedToolNames` has `Bash`, `ListApps`, `Screenshot`, `list_cases`; lacks `run_task`, `delegate`, `Click`-style acting GUI tools, `RequestLease`, `Take`, `sessions_spawn`.
- `no owner text`: `executorOptions.ownerTurnText` is absent; `refuseUnsafe` follows `shouldRefuseUnsafe(origin)`.
- `work directory`: `<dataDir>/tasks/<id>/work` exists, is `workingDirectory` and `allowedRoots[0]`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tasks-manager.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

The turn call mirrors `delegate-sessions.js` `_runTurn`, with `chatId` the real chat id, `taskPolicy`, `toolEvents`, `onUsageRecorded`, `systemPromptDynamic` or the adapter's equivalent carrying `TASK_GUIDANCE`, `origin: approvalOrigin(origin, 'chat:<chat_id>')`. Prior messages come from `ContextBuilder.build` for the chat with no `crossChat`, as the tail. Tool names: every registered tool minus `sessions_*`, `message`, `MCP_TOOLS` names, and `GUI_TOOL_NAMES` other than `ListApps` and `Screenshot`; case tools stay (owner decision).

The title is the first 60 characters of the text, one plain line; no auto-title call. The audit writes `task.requested` and `task.ended` as spec §4.8.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/tasks-manager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(tasks): the task manager runs a task as a chat on this node`

---

### Task 7: The grant flow

**Files:**
- Create: `src/tasks/grants.js`
- Modify: `src/tasks/manager.js`
- Test: `tests/tasks-grants.test.js` (a real `LeaseManager`, fake relay and phone, as `tests/gui-takes.test.js`)

**Interfaces:**
- Consumes: Task 2's `request`, `endLease`, `state` event.
- Produces: `new TaskGrants({ leases, clock, resendLimit = 12 })`: `open({ task, proposal, origin, onChange }) → handle`, with `handle.state() → { awaiting, grant }`, `handle.wait() → Promise<void>`, `handle.close(reason)`, and `onChange({ kind: 'granted' | 'denied' | 'pending_exhausted' | 'stopped' | 'expired' })`.
- Also: `taskName(text) → string`, one plain line, at most 60 code points, `'Task'` when nothing is left.

- [ ] **Step 1: Write failing tests**

- `press allows`: `awaiting_grant` → press → acting call goes through with no phone prompt; the record holds `grant { lease_id, granted_at, by_device, expires_at }`.
- `look-only needs no card`: `allows: []` sends no request; the record has `grant: null`, `proposal.lookOnly: true`.
- `bad proposal`: `proposal: null` sends no request, every acting call reaches the phone path.
- `deny ends`: state `cancelled` → `ended.reason: 'grant_denied'`, a waiting `decide` gets `task_ended`.
- `expiry re-sends`: pass 5 minutes: a new `kl.lease.request` with a new lease id; after 12, state `waiting`, reason `grant_pending`; a press on the live card before that resumes; `send` on `grant_pending` sends one more card.
- `card held while link is down`: relay disconnected; the task reads; `get` says `awaiting_grant`; a link-up delivers the live card; no acting call ran.
- `Stop ends the task`: a revoke → turn aborted, state `cancelled`, `ended.reason: 'stopped'`, push; the next call `task_ended`. `device_revoked` does the same.
- `lease ends at task end`: `done`, `cancelled` and `interrupted` each call `endLease`, and no `session_ended` loop back into the task.
- `spend raise`: at the cap the lease ends with reason `spend_cap` and a fresh request has `usd` doubled (at most 500). A press leaves the state `waiting`, reason `spend_cap`, with the new cap on the record, and the client's `send` starts the next turn. A deny gives `ended.reason: 'spend_cap'`.
- `restart re-cards`: an `interrupted` task's `send` re-proposes and sends a card before the turn's first acting call.
- `no lease manager`: `grants: null` runs every acting call down the phone path; `describe` of the task says `grant: null`.
- `name from hostile text`: `"Find\na‮dentist​" + 'x'.repeat(8000)` builds a valid request, and `‮​` alone gives `Task`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tasks-grants.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

The card's `reason` is host-built: `Task from <client name>`, one plain line through the same cut. Each request gets `newLeaseId()`. The `state` listener compares the lease id with the current one before acting. `run` starts the first turn right after `open`, not after the press. The turn's `getState` reads the handle.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/tasks-grants.test.js tests/tasks-manager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(tasks): one card per task, re-sent for an hour; Stop ends the task`

---

### Task 8: Tools, scopes, capabilities, node wiring

**Files:**
- Modify: `src/fleet/tool-definitions.js`, `src/fleet/scope-rules.js`, `src/fleet/fleet-tools.js`, `src/fleet/node-fleet-service.js`, `src/fleet/start.js`, `src/service/run.js`
- Create: `src/fleet/capabilities.js`
- Test: `tests/fleet-task-tools.test.js`, `tests/fleet-capabilities.test.js`; update tests that pin the tool list

**Interfaces:**
- Consumes: Task 6's manager.
- Produces: `MCP_TOOLS` with `run_task { task, node?, wait_ms? }`, `get_task { task_id, seen_seq?, wait_ms? }`, `send_to_task { task_id, message, wait_ms? }`, `cancel_task { task_id }`, `list_tasks { node?, state? }`. `REQUIRED_SCOPE`: `run_task`, `send_to_task`, `cancel_task` → `fleet:delegate`; `get_task`, `list_tasks` → `fleet:read`. `allows` also demands `fleet:unsafe` for the first three, covering the machine when targeted. `detectCapabilities({ nodeConfig, hosting, gui, profileDirs, localServers, chromiumRunnable, platform }) → string[]`.

- [ ] **Step 1: Write failing tests**

Definitions: descriptions state the spec §6 flow and that `answer` is data. Scopes: `fleet:delegate` alone is `insufficient_scope` with `required: 'fleet:unsafe'`; a machine-limited `fleet:unsafe` covers only that machine.

Handler: `call('run_task', …, { origin: STDIO_ORIGIN })` reaches the manager; `node` other than this node is `unknown_machine`; on a runbook node `capability_unavailable`; a front-door origin's view has `answer.text` wrapped by `untrustedOutput` and `client` reduced to kind and name; `get_task` from another grant with `fleet:read` works (Q25); `describe_machine` adds `tasks: 'per-call approvals'` with no lease manager.

`NodeFleetService.dispatch` re-checks scopes for `fleet.run_task` and refuses a missing `fleet:unsafe`.

Capabilities: `interactive` under personal hosting; `browser:logins` when the `king-louie` profile dir exists; `browser:headless` when the injected probe says so; `shell`; `local-models` with a usable server; `os:windows`; the declared list kept; at most 32. No test probes the dev box.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/fleet-task-tools.test.js tests/fleet-capabilities.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`fleet.hello` and `capabilitiesWith` use `detectCapabilities`. In `start.js`, on the agent branch, lazily require `src/tasks/`, build the store, `TaskManager`, and `TaskGrants` when `deps.leaseManager` is there; `callUtility` is built with `core.context.snapshotModels`, `createRoutedProvider` and `oneShot`, as `autoNameChat` does (chat-handlers.js:185-216), and records usage against the task. `currentUrl` reads the default browser from `browser-registry` without starting one. `teardown` stops the manager. `run.js` passes `pushQueue: gui ? gui.leases.pushQueue : null` and builds a `PushQueue` over `approvals.relayClient` when there is no GUI. `context.isTaskChatRunning` is set for Task 10.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/fleet-task-tools.test.js tests/fleet-capabilities.test.js tests/fleet-scope-rules.test.js tests/service-profile-graph.test.js`
Expected: PASS. Then `Grep` for tests naming a fixed tool count (`FLEET_NAMES`, `tools/list`) and fix them.

- [ ] **Step 5: Commit**

`feat(fleet): the task tools on the node, behind fleet:delegate and fleet:unsafe`

---

### Task 9: Front-door routing and placement

**Files:**
- Modify: `src/frontdoor/router/router.js`
- Test: `tests/frontdoor-tasks.test.js`

**Interfaces:**
- Consumes: Task 8's definitions, link methods `fleet.run_task`, etc.
- Produces: `run_task` replies with `task_id` public, or `{ needs_placement: true, nodes: [{ name, capabilities, online }] }`.

- [ ] **Step 1: Write failing tests** (`tests/helpers/frontdoor-harness.js`, `tests/helpers/fake-node.js`)

- `one node`: no `node` → forwarded; reply `task_id` is `<machine>:<uuid>`, `placement.by: 'only-node'`.
- `named`: `node: 'b'` → that node, `placement.by: 'named'`; unknown is `unknown_machine`, offline is `machine_offline`, a runbook node is `capability_unavailable`.
- `several`: two agent nodes → `needs_placement`, listing both, nothing forwarded.
- `none`: `needs_placement` with `nodes: []`.
- `grant limits`: a node the grant may not reach is neither counted nor listed; with one reachable of two, it is the only node. A `fleet:unsafe` limited to another machine excludes the node.
- `offline excluded`: one online and one offline → the online one, `placement.by: 'only-node'`.
- `get_task` from a second grant with `fleet:read` works; without read on that machine `task_not_found`; a bad id `task_not_found`; offline `machine_offline`.
- `list_tasks`: fans out over reachable agent nodes, rows carry `machine`, offline ones in `unreachable`, sorted newest first, at most 50.
- `arguments copied field by field`: a client `origin` in the args is ignored; `wait_ms` over 25,000 is `invalid_params`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/frontdoor-tasks.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`METHODS` and `FLEET_METHODS` gain the five. `TASK_TOOLS` parse `a.task_id` with `parsePublicJobId`. A `_place(grant, scopes)` private method returns the eligible nodes: `_reaches` for `run_task`, `node.profile === 'agent'`, online. Tasks skip `visibleTo`, `_recordStart` and the cache: no offline answer in stage 1. The router's timeout stays above `wait_ms` (30 s against 25 s).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/frontdoor-tasks.test.js tests/frontdoor-router.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(frontdoor): run_task places a task; several nodes ask the client`

---

### Task 10: A task chat and a case

**Files:**
- Modify: `src/ipc/chat-handlers.js:129,651`, `src/cases/chat-attach.js`, the send path's busy check
- Test: `tests/tasks-case-attach.test.js`

**Interfaces:** Consumes `meta.author: 'client'`, `context.isTaskChatRunning(chatId)`.

- [ ] **Step 1: Write failing tests**

- A task chat with no other-case results attaches (`assertChatAttachable` passes; it has no `source`).
- `ownerMessages` for a case turn leaves out `author: 'client'` rows, so a `Ledger` assert quoting the client's words is refused and one quoting the owner's later message passes.
- A task chat whose stored rows show `list_cases` results about another case is refused `CHAT_SAW_OTHER_CASES`.
- `context.isChatRunning(id)` is true during a task turn: attach refuses `CHAT_BUSY`, `chat:markPrivate` refuses `PRIVATE_CHAT_BUSY`, and an owner send into that chat is refused as a chat that is busy.
- Marked private between turns, a task's next turn runs under that chat's policy (`PRIVATE_NO_LOCAL_MODEL` with no local model).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tasks-case-attach.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `&& m.author !== 'client'` beside `!m.channel` at `chat-handlers.js:651`, and check the row key survives `rows.js`' meta handling. `context.isChatRunning = (id) => activeRuns.has(id) || context.isTaskChatRunning?.(id) === true`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/tasks-case-attach.test.js tests/case-chat-attach.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(cases): a task chat can become a case; a client's words never count as the owner's`

---

### Task 11: The `task_ended` push

**Files:**
- Modify: `src/frontdoor/push/text.js`, `src/frontdoor/node-methods.js` (through `SESSION_KINDS`), `docs/protocol/approval-v1.md` §8
- Test: `tests/frontdoor-push-notify.test.js`, `tests/frontdoor-push.test.js`, `tests/gui-push-queue.test.js`, `tests/mobile-android-push.test.js`

**Interfaces:** Produces kind `task_ended`, title `Task ended`; `enqueue({ kind: 'task_ended', id: task_id })`, every fcm device.

- [ ] **Step 1: Write failing tests**

Queue accepts it; the relay sends `{ k: 'task_ended', rid: <id>, n: <node> }` to every fcm device and none to apns; no other field; the gate's coalescing and hourly cap apply as to the session kinds.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/frontdoor-push.test.js tests/gui-push-queue.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `SESSION_KINDS` and `TITLES`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/frontdoor-push.test.js tests/gui-push-queue.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(push): task_ended, content-free, fcm only`

---

### Task 12: The phones

**Files:**
- Modify: `mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift`, `mobile/ios/App/LeaseViews.swift`, `mobile/ios/App/AppModel.swift`; `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt`, `.../ApprovalList.kt`, the Android detail screen and FCM service
- Test: the vector tests in both cores; `tests/mobile-lease-apps.test.js`, `tests/mobile-android-slim.test.js`

**Interfaces:** Consumes Task 1's fields and vectors, Task 11's kind. Produces `LeaseRequest.isTask`, `.allows`, `.usd`, `Leases.taskLines(request) → [String]`, the same on both.

- [ ] **Step 1: Write failing tests**

Vector tests accept `task-request` and `task-status`, refuse the refusal vectors. `taskLines` gives, in order: `Task: <name>`, `Sites: <a, b>` (left out when none), `May: click and type in your signed-in browser` etc. joined by `, ` (`logins`: `sign in with saved logins`; `shell`: `run shell commands`; `files-write`: `write files`), `For: N minutes`, `Spend up to $N`, `Node: <name>`. `ApprovalList` shows a running task as `Task on <node>: <name>` with Stop. In `tests/mobile-*.test.js`, pin the literal `"task"` in both `leaseKinds`, that a task grant signs `apps: []`, that minutes are fixed to `max_minutes`, and that `task_ended` is handled with no live view.

- [ ] **Step 2: Run to verify they fail**

Run: `cd mobile/android && ./gradlew :protocol:test` (JDK 17) and `node --test tests/mobile-lease-apps.test.js tests/mobile-android-slim.test.js`
Expected: FAIL. `swift test` needs macOS; note it as not run on this machine.

- [ ] **Step 3: Implement both**

A task card has no app checkboxes and no duration stepper; Allow signs what the card shows. Android's tapped `task_ended` opens the Approvals list. The status check treats `task` as `take`: name required, `unattended` allowed.

- [ ] **Step 4: Run to verify they pass**

Same commands. Expected: PASS for what can run here.

- [ ] **Step 5: Commit**

`feat(mobile): the task card, a running task's Stop, and the task_ended push`

---

### Task 13: End to end, docs, the whole suite

**Files:**
- Create: `tests/tasks-e2e.test.js`
- Modify: `CLAUDE.md` (a Tasks section), `docs/driving-king-louie.md`, `docs/install-guide.md` ("Your first task"), `mobile/PRIVACY.md`, `tests/docs-driving.test.js` if it asks

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Write the e2e test** (front-door harness, a fake node running a real `TaskManager` and `LeaseManager`, a scripted adapter, the fake phone)

The dentist run: `run_task` with no node → card at the phone with the spec's lines → press → the turn clicks on a granted site with no prompt → an off-list click reaches the phone as a tool approval, approved → the reply is a table → `get_task` with `wait_ms` returns `done` and the table wrapped as untrusted → `task_ended` queued → a second grant reads it. Then the look-only path, `cancel_task`, and restart → `interrupted` → `send_to_task` → card → `done`.

- [ ] **Step 2: Run it and fix what it finds**

Run: `node --test tests/tasks-e2e.test.js`
Expected: PASS.

- [ ] **Step 3: Write the docs**

CLAUDE.md: what a task is, the seams, codes, test helpers, residuals (the task acts in the signed-in browser; `fleet:delegate` with `fleet:unsafe` reads non-private cases; one task per node; no offline `get_task`). PRIVACY: the card's clear fields.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`. Report any failure with its output.

- [ ] **Step 5: Commit**

`test(tasks): the dentist task end to end; docs`

---

## After the plan (the owner's decisions, not tasks)

Deploying the front door, updating the owner's node, installing the phone build, and running the real dentist task are each the owner's yes.
