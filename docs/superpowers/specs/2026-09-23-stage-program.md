# King Louie — Stage Program (fleet 3–7, cases 2–7)

- **Status:** Draft, amended 2026-09-24 after the child-spec reviews
- **Date:** 2026-09-23
- **Parents:** `2026-09-21-king-louie-fleet-design.md` (fleet), `2026-09-22-king-louie-cases-design.md` (cases)
- **Purpose:** the shared contracts, dependency order and file ownership that let the
  remaining eleven stages be built by parallel agents without colliding. Every child
  spec and plan below is bound by this document. Where a child spec and this document
  disagree, this document wins until it is amended here.

## 1. What is done

| Track | Stage | Landed | Where |
|---|---|---|---|
| Fleet | 1 headless core, service | PR #28 | `src/core/`, `src/service/`, `bin/king-louie-service.js` |
| Fleet | 2 identity, node config, tiers, runbooks, stdio MCP | PR #29 | `src/mesh/node-identity.js`, `src/service/node-config.js`, `src/execution/safety-policy.js`, `src/runbooks/`, `src/mcp/stdio-server.js` |
| Cases | 1 case repo, ledger, brief, gates, orientation, case mode, panel | PR #30 | `src/cases/`, `src/tools/builtin/case-tools.js`, `src/ipc/case-handlers.js` |

## 2. Child specs and plans

One spec and one plan per stage, all dated 2026-09-23:

| Id | Spec | Plan | Depends on |
|---|---|---|---|
| F3 | `specs/2026-09-23-fleet-stage3-approvals.md` | `plans/2026-09-23-fleet-stage3-approvals.md` | F2 |
| F4 | `specs/2026-09-23-fleet-stage4-front-door.md` | `plans/2026-09-23-fleet-stage4-front-door.md` | F3 |
| F5 | `specs/2026-09-23-fleet-stage5-session-helper.md` | `plans/2026-09-23-fleet-stage5-session-helper.md` | F3; `delegate` (F4) for job-scoped leases |
| F6 | `specs/2026-09-23-fleet-stage6-examples.md` | `plans/2026-09-23-fleet-stage6-examples.md` | F2 (content), F4/F5 (for the guide's §10–12) |
| F7 | `specs/2026-09-23-fleet-stage7-desktop-ui.md` | `plans/2026-09-23-fleet-stage7-desktop-ui.md` | F2; shares the approval seam with F3 (§4.21) |
| C2 | `specs/2026-09-23-cases-stage2-unattended.md` | `plans/2026-09-23-cases-stage2-unattended.md` | C1 |
| C3 | `specs/2026-09-23-cases-stage3-executors.md` | `plans/2026-09-23-cases-stage3-executors.md` | C2 |
| C4 | `specs/2026-09-23-cases-stage4-channels.md` | `plans/2026-09-23-cases-stage4-channels.md` | C2; F3 only for the mobile-app adapter |
| C5 | `specs/2026-09-23-cases-stage5-detours.md` | `plans/2026-09-23-cases-stage5-detours.md` | C2 |
| C6 | `specs/2026-09-23-cases-stage6-playbooks.md` | `plans/2026-09-23-cases-stage6-playbooks.md` | C2 |
| C7 | `specs/2026-09-23-cases-stage7-ingest.md` | `plans/2026-09-23-cases-stage7-ingest.md` | C2; F4 only for the front-door tools |

**Dependency edges are on merged code, not on specs.** A stage may be implemented on a
branch before its dependency merges only if its plan says which interfaces it consumes
and stubs them behind the contracts in §4.

### 2.1 Waves

Agents can start these together without touching each other's files:

- **Wave 1 (now):** F3, F7, C2, F6-content (the `examples/` runbooks and configs; the
  install guide's §10–12 come later). F3 and F7 both touch the approval seam in
  `create-core.js` (§4.21): whichever merges second rebases.
- **Wave 2 (after C2 merges):** C3, C4, C5, C6, C7-ingest (the front-door tools wait for F4).
  C5 merges before C7 or C7 keeps its standalone entity index until C5 lands (§4.10).
- **Wave 3 (after F3 merges):** F4, F5, C4's mobile-app adapter.
- **Wave 4 (after F4 merges):** C7's front-door case tools, F6's guide §10–12, F5's
  job-scoped leases (`origin.job_id`, `LeaseManager.endForJob`).

Merge order inside a wave is by PR readiness. Every PR rebases on main before merge and
reruns `npm test`. No PR merges with a red suite.

## 3. Program-wide constraints

Copied from the parents; every child spec and plan carries these verbatim in its
Global Constraints.

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

## 4. Shared contracts

These are interfaces more than one stage touches. The **owning** stage implements the
module; the others consume it exactly as written here, and stub it in tests when it has
not merged. Exact signatures live in the owning spec's §5.2; this section pins names
and shapes.

### 4.1 Case status machine — owner C2

`case.yaml` `status` ∈ `draft | active | needs-direction | paused | done | abandoned`.
Transitions (anything else is refused by `CaseRuntime.setStatus(id, status, { reason })`):

```
draft → active                    completeGating (C1, exists)
draft → abandoned                 owner only (IPC)
active → needs-direction          failure report written (C2)
active → paused                   usd or deadline budget 100 % (C2), owner pause (IPC)
needs-direction | paused → active owner direction / grant (a `user` fact or IPC)
active | needs-direction | paused → done | abandoned   owner only (IPC)
```

Refusals by status, enforced through `CaseRuntime.assertWritable(id, op)` (C2; op names
are listed in the C2 spec and extended by C3 `Executor.*`, C5 `Detour.*`, C6 `Playbook.*`,
C7 `Ingest.*`):

| Status | Refused |
|---|---|
| `draft` | `Recommend`, `Plan`, `Executor.submit` |
| `needs-direction` | `Plan`, `Recommend`, `Fail`, new `Executor.submit` unless `case.yaml.autonomy` grants the failure class |
| `paused` | every case tool except `Ledger.query`, `Brief.read`, `Playbook.list`, `Playbook.read` |
| `done`, `abandoned` | every write tool except `Playbook.propose` in `done` |

Per-day budget categories at 100 % refuse the charged action until the day rolls over;
only `usd` and `deadline` pause the case (R14). `requireReoriented(id)` returns `null`
when clear, else `{ ok: false, error }` (R34). `autonomyAllows(id, action)` reads
`case.yaml.autonomy`. `case.yaml` gains `lastTurnAt`, `statusReason`, `roles`,
`autonomy.onQuestionSilence`, `budget`.

### 4.2 Journal kinds — owner C2

`CaseRecords.writeJournal(kind, text)` kinds: `turn` (C1), `brief` (C1), `reorient`,
`failure`, `wakeup`, `briefing`, `question` (C2), `plan`, `envelope` (C3), `detour` (C5),
`playbook` (C6), `ingest` (C7). Each stage adds the kinds it writes; the file name
stays `YYYY-MM-DD-HHMM-<kind>.md`.

### 4.3 Question records — owner C2 (store + in-app delivery), extended by C4 (ladder)

The parent puts question records in stage 4. They move to **C2** because a case that
runs unattended must be able to ask and brief the owner from day one; C4 adds presence,
the ladder, batching and the non-UI channels. This is a deliberate change to the parent's
stage table.

Module: `src/cases/questions.js`, class `QuestionStore(dir)` over `.kl/questions/<id>.json`.

```jsonc
{
  "id": "q-0012",
  "kind": "question" | "approval" | "briefing",
  "caseId": "…",
  "text": "…",
  "options": [{ "id": "a", "label": "…" }],      // optional
  "urgency": "low" | "normal" | "high",
  "createdAt": "RFC3339",
  "expiresAt": "RFC3339" | null,
  "defaultOnSilence": "hold" | "<optionId>",
  "deliveries": [{ "channel": "in-app", "at": "RFC3339", "deliveryId": "…" }],
  "payload": { "type": "plan" | "envelope" | "envelope-delta" | "owner-task" | "budget" | "failure" | "gating" | "ingest" | "detour",
               "mcpAnswerable": true, … },        // kind-specific: envelope id, budget category, about, resolves, key, materiality
  "answer": null | { "channel": "in-app", "at": "RFC3339", "text": "…", "optionId": "a" | null, "factId": "f-0042" },
  "closed": null | { "at": "RFC3339", "reason": "…", "by": "panel" | "expiry" | "system" }
}
```

API (C2): `create(record) → record` (dedupes on normalized text — callers include the
`ref`/`docId` in the text), `open() → record[]`, `get(id)`, `answer(id, { channel, text,
optionId })` (writes the answer, asserts a `user` fact with `source { kind: 'question',
ref: id }`, returns the record), `close(id, { reason, by })` (no fact; R47), `expire(now)`,
`registerAnswerHandler(type, fn)`, `recordDelivery(id, { channel, at, deliveryId })`
(C2 implements it for in-app delivery; C4's ladder calls the same method). IDs are `q-`
+ zero-padded counter derived by replay. Stages create questions through
`CaseRuntime.createQuestion(id, record, { charge })` (C5), which applies the
`questionsPerDay` cap (`held` status, blocker override) rather than calling `create`
directly. `QuestionStore.answer` honours `payload.disclosable` and
`payload.gating.category`.
Ledger source kinds `question` and `owner-action` are host-reserved: `FactLedger` accepts
them only with `provenance: user`. Answering through the desktop uses IPC
`case:answerQuestion { caseId, questionId, text?, optionId? }`; every host path that
answers goes through `CaseRuntime.answerQuestion(caseId, questionId, { channel, text,
optionId })`. `case:questions` lists every status except `done`/`abandoned`. Budget
grant questions are `mcpAnswerable: false`.

Approvals (`kind: approval`) are answerable only on sender-proving channels (in-app,
Telegram, Discord, the phone app); email, SMS and voice notify only. A conflicting second
answer becomes a follow-up question and never overwrites. The host never writes a `user`
fact in the owner's name: a panel outcome is journaled and the record closed.

The `Ask` tool (parent §5.6) is delivered by **C2** with in-app delivery only; C4 gives it
the ladder. `AskUser` is intercepted in the agent loop before the executor and refused in
case mode by C2's case prompter.

### 4.4 Budgets — owner C2

Module: `src/cases/budget.js`, class `Budget(dir, { defaults, overrides })` over
`.kl/budget.json`:

```jsonc
{ "usd": { "spent": 3.21, "limit": 40, "crossed": [50], "unpricedTokens": 0, "grantedBy": [] },
  "turnsPerDay": { "spent": 4, "limit": 40, "day": "2026-09-23", "crossed": [] },
  "contactsPerDay": { … }, "questionsPerDay": { … },
  "deadline": { "at": "2026-11-30", "crossed": [] } }
```

API: `charge(category, amount, meta) → { spent, limit, crossedNow: number[] }`
(`meta.unpricedTokens` for calls with `costUsd: null`), `status()`, `remaining(category)`
(`null` when no limit), `reconcile()` when a limit changes. **Every `charge` is followed
by `CaseRuntime.onCrossings(id, category, crossedNow)`**, which pauses the case at 100 %
of `usd`/`deadline` and creates the budget question. Categories: `usd`, `deadline`,
`turnsPerDay`, `contactsPerDay`, `questionsPerDay`. Who charges: C2 charges `turnsPerDay`
per turn (wake-ups included) and `questionsPerDay` at question creation; C3 charges `usd`
(executor-reported cost, `draft` calls) and `contactsPerDay`; C7 charges `usd` for every
ingest model call, vision or text; C4 charges nothing. The model can never raise its own
limit; grants come only from the owner (`grantedBy`). Defaults in `settings.cases.budgets`,
overrides in `case.yaml.budget`. `usageTracker.record` returns `cost`.

### 4.5 Model roles — owner C2

Module: `src/cases/roles.js`. `resolveRole(role, { settings, caseMeta, hasToken }) →
{ provider, model, tier }` for `orient | classify | draft | judge | verify`. Roles map onto
the router's fixed tiers (fast/standard/smart) through `settings.cases.roles` and
`case.yaml.roles`; the tier map itself gains no roles. `CaseRuntime.roleModel(id, role)`
wraps it; `CaseRuntime.routedProvider(id, role)` returns a provider whose calls go through
`routeWithFallback` (with the new `target` option, `NO_RETRY` where stated) and the usage
hook, so all role calls are charged. Owner chat turns keep the chat's chosen model;
wake-ups use `orient → judge`. C3 uses `draft` for payloads, C5 uses `classify`, C7 uses
`draft` for proposals and `verify` for the second reading. `verify` must resolve to a
different provider family from `judge` when one is configured; otherwise it falls back
to `judge`'s with a logged warning. OCR adds no role: it uses `cases.ingest.vision` if
set, else the first vision-capable of `draft`/`judge` (R45).

### 4.6 Wake-ups — owner C2

Module: `src/cases/wakeups.js`, `WakeupStore` over `.kl/wakeups.json`:
`register({ kind, at | every, payload }) → id` (`every` in milliseconds), `list()`,
`cancel(id)`, `due(now)`. Kinds: `poll-executor`, `deadline-check`, `daily-orientation`,
`retry`, plus stage-prefixed kinds (`detours:incoming` C5, `ingest:review` C7).
`ensureWakeupJob()` registers one cron system job per data dir, `cases:wakeups`, every
minute, through `CronExecutor.registerSystemJob`; jobs with `system: true` are protected
from the Cron tool. It calls `CaseRuntime.runDueWakeups(now)`. A wake-up **turn** runs
with `denyAutoApproval`, only the case tools plus Read/Glob/Grep (WebFetch/WebSearch
join once C3's outbound gate has merged: a GET URL is an outbound channel), no
`RequestTools`/`ToolSearch`, and is charged like any turn. `poll-executor` polling runs
inside the sweep with no model through `registry.pollWakeup(caseId, wakeup)` (C3); a
turn is registered only on a `material` change (R48). Background job output lands in
`<dataDir>/executors/runs/` and is copied into the case under the lock.

### 4.7 Executor snapshot — owner C3, read by C2

`.kl/executors.json`:

```jsonc
{ "phone-agent": { "fetchedAt": "RFC3339", "stale": false,
                   "state": { … adapter-defined … },
                   "override": { … per-case settings override … },
                   "material": { "openJobs": 2, "lastChange": "RFC3339" } } }
```

C2's "executor change" trigger compares the `material` object of each entry against
the copy it kept at the last turn; C3 defines which fields are material per executor
kind and writes the file. Until C3 merges the file is absent and the trigger is inert.
`.kl/plan.json` (C3 §4.3) has `steps[].state ∈ pending | in-flight | done | failed |
cancelled` (R35); C2's mid-plan trigger reads it.

### 4.8 Executor registry and adapter interface — owner C3

`src/cases/executors/registry.js` (`ExecutorRegistry`) and the adapter interface from
parent §6.4: `capabilities()`, `submit(job, envelope)`, `status(jobId)`,
`results(jobId, { after })`, `cancel(jobId)`, `briefRules()`. Registry additions:
`liveState() → [{ jobId, executorId, signature, state, caseId, intent, recipients }]`
(non-terminal states `submitting | submitted | running | waiting`),
`registerExtraBriefRules(fn)` (R18; C6 uses it), `cancelOpenJobs(caseId, reason)` (C2
calls it on done/abandoned/pause). Executor ids are lowercase slugs. Built-ins: `bash`,
`browser`, `web`, `files`, `workflow`, `runbook`, `owner`, `phone-agent` (generic HTTP
errands API). `bash`/`files`/`web` are plan targets only. The `runbook` executor exists
only where the runbook engine is hosted (service `runbook` profile until F4). In service
mode, non-built-in executors come only from admin `service.json` `executors.entries`
and `executors.packageRoots`.

Authority floors (R42): any executor with an outbound capability (`call, sms, email,
web-form, postal-mail, pay, sign`) has `outbound: 'message'` and authority ≥ `envelope`;
settings cannot lower these. `authority: signed` executors call the phone approver with
`envelopeAction({ executorId, caseId, envelopeHash, summary })` (§4.12).

Duplicate-job gate (R36): `findDuplicateJob({ executorId, job, liveJobs })` and
`jobSignature(executorId, job)` live in `src/cases/gates.js`, **owned by C5**; C3 calls
them and stores `jobSignature` at submit. `external-agent` provenance is written only by
`Executor.results`, with `source.ref` under `sources/<executor>/`; the Ledger tool refuses
it (R40). Owner consent for owner labor (R41): `brief.resources.ownerLabor` is host-only;
consent is a `user` fact with `source.kind === 'question'` whose `payload.type ∈ plan |
owner-task` names the capability.

### 4.9 Outbound gate — owner C3, extended by C7

`src/cases/gates.js`: `outboundGate({ payloadText, recipients, envelope, facts: Map, mode,
entitySpans? }) → { ok, blocked: [{ span: { start, end, text }, reason, factId?, detail }],
rendered }` (R38). Every string leaf of a payload is gated; facts enter payloads only by
`{{f-0042}}` reference or envelope-approved wording. Consumers send `rendered`, never
`text`. `EntityIndex.nonDisclosableSpans(text, { caseId }) → [{ span, entity, reason }]`
(C7) supplies `entitySpans`; default entity kinds `email, phone, id, address`
(`person`/`org` only under an owner setting); phones indexed with and without country
code; recipients normalized (E.164, lowercase email) before exemption.
`ContactRouter.sendExternal(...)` (C4) is the one gate-enforced path for any
channel-targeted send; it has no stage-3 consumer (R39). The owner exemption requires a
private chat/DM with the configured owner id; ntfy is never an owner target.

### 4.10 Cross-case and entity index — owner C5, extended by C7

`src/cases/index-store.js`: `CrossCaseIndex(root)` at `<casesRoot>/.index/` (R19) with
`rebuild()`, `upsertCase(id)`, `removeCase(id)`, `search({ text, subject?, attr? }) →
[{ caseId, title, kind: 'fact'|'brief'|'question'|'journal'|'document', id, score, text,
subject, attr, provenance, disclosable, caseStatus }]`, `searchCases`, `casesWithKey`.
Keyword/BM25 in pure JS; embeddings optional and only through existing providers.
**Cross-case hits hide the text of non-disclosable facts** — redaction happens inside
the index (`forCaseId` option; hits carry `text: null, redacted: true`; `includePrivate`
is internal only). C1's `otherCaseFacts` is
replaced by this once it merges. The entity index (C7) is `CrossCaseIndex.entities`
stored at `<casesRoot>/.index/entities.json`, with `searchEntities(entity)`,
`casesWithDocument(hash)`, `nonDisclosableSpans` (§4.9); `rebuild`/`upsertCase`/
`removeCase` delegate to it (R46). `CaseRuntime.entityIndex()` returns
`index.entities` once C5 has merged, C7's standalone instance before. Other cases'
file names never leak through `alsoInCases`: title and id only. Case creation with a
near-duplicate title/objective is refused unless `force`.

### 4.11 Case-type extras and playbooks — owner C5 (types), C6 (playbooks)

`src/cases/case-types/<type>.js` exports `{ type, orientationExtras(runtime, id) → string,
gatingQuestions() → [...], materialFields() → [...], briefFields?, refresh?, indexKeys? }`.
C5 ships `software-repo` (uses `gh`'s own login; no vault token). Gating questions become
question records by code, keyed and deduped by `subject.attr` (`gatingQuestionsFor`,
`syncGating`, `pendingGating`); `completeGating` is refused while required ones are
unanswered. Playbooks (C6) are data, loaded through one validating loader (never
`require` of a case-derived path), vendored as plain copies with `commit` + `contentHash`;
they contribute gating questions and brief rules through `registerExtraBriefRules`. A
`sourced` fact never satisfies owner gating. `case.yaml` moves to the strict parser
(`src/platform/yaml.js`; C6 does it). The write guard covers `playbooks/`.

### 4.12 Fleet approval requester — owner F3

`PhoneApprover.requestAction(action, { origin, signal, currentAction }) → Outcome`; action
kinds `tool | runbook | envelope`; runbook actions carry `steps`. It is exposed as
`core.context.getPhoneApprover()` and is `null` when no device is enrolled; C3's
`authority: signed` executors refuse with `signed approval unavailable` when it is `null`.
ToolExecutor passes `signal` in requester metadata and gains a `classifyCall` option that
wires `classifyToolCall` (the tier rules were unused). `createCore` deps: `phoneApprover`,
`auditLedger`, `nodePolicy`. `remoteApprovals` ∈ `allow | deny | phone`.

Signed envelopes are `{ alg, kid, payload, sig }` with `seal`/`open`; signatures cover the
JCS bytes as sent (`src/platform/jcs.js`, R17); the node recomputes `action_hash`; phones
never re-canonicalize. `verifyDeviceEnvelope(envelope, { approverStore, type }) → { ok,
reason }` performs the shared checks (malformed, unknown device, `alg`, `kid ===
device_id`, demo platform, test key, replay before pending lookup, wrong node) and is
consumed by F5 (leases) and C4 (question answers). Expiry is computed on the node clock
only. `approverStore.get(kid).public_key`; `startApprovals` returns `approverStore` and
`identity`. Device enrollment over the relay is staged in the data dir and applied by an
admin per node (`device apply`); revocation takes effect at once (R15). The first valid
phone response decides a request; a request created while the relay is down is
delivered when the link returns if unexpired (R16). Push is a pluggable `PushSender`
with `none` as the default (open question Q-A, §8).

### 4.13 Front-door relay — owner F3 (relay), extended by F4

F3 delivers `src/frontdoor/` with only what approvals need: the phone API (`/v1/*`,
`X-KL-*` device auth), the node relay over the mesh transport, push, and device
enrollment/revocation relay, run as `king-louie-service relay` with operator TLS files.
Until F4 the node listener is loopback/private only (ruling 8) and phones pin the relay
cert's public key. `MeshTransport` gains `listen: false` (nodes never listen). F4 adds the
SNI listener with ACME (stable `mcp.` key, R21), OAuth (owner types the browser code on
the phone, R23), the MCP endpoint, router, registry and audit mirror in new modules, and
makes `relay` a subset of `profile: frontdoor`. F3 must not add OAuth or MCP code; F4
must not change F3's message shapes. F3 exposes these extension points, which F4 (and
C4, F5) consume — exact signatures in the F3 spec §5.2:

| | |
|---|---|
| E1 | `startRelay({ dataDir, config, identity, listeners: 'own' \| 'external', registry? }) → { stop, address(), phoneApiHandler, nodeHub }` |
| E2 | `phoneApi.registerRoute(method, pathPattern, { auth: 'device' \| 'none' \| 'code', rate?, handler(req, ctx) })` |
| E3 | `NodeHub({ peerSource })`; `nodeHub.rpc(nodeId, method, params, { timeoutMs })`, `onNodeMessage`, `onConnection` |
| E4 | `pusher.notify(device, { kind: 'approval' \| 'grant' \| 'pairing' \| 'alert' \| 'question' \| 'lease', id, … })` |
| E5 | `relayClient.registerMethod(name, handler(params, { peer }))`, `relayClient.notify(method, params)`; refuses `mesh.task.*`, `mesh.channel.*` |
| E6 | `FileCourier.call(method, params, { timeoutMs })`, `CourierPump({ rpcHandler })` |
| E7 | `RelayClient` reads `<configDir>/front-door.json` and dials `MeshTransport.connectPinned` |
| E8 | `POST /v1/pairing-codes` re-bindable through `registerRoute` |
| E9 | `audit.slice` accepts `max_bytes`; `audit.head` and node-signed `kl.audit.slice.head` anchors |
| Mailbox | `src/frontdoor/extensions.js` is how F5 and C4 mount routes and link methods; `link.send(envelope, { push, to_device })` feeds the relay `Mailbox`, replayed on `relay.hello` |

Two pins per node (§4.17): the mesh TLS certificate is P-256, the node key Ed25519; both
fingerprints are pinned and tied through the auth challenge. Pairing picks F3's or F4's
flow by URL scheme (`wss://` or `https://`, R22); F3's unsigned relay node records are not
migrated. The front door's approver set is admin-owned `<configDir>/approvers/` (R25).
Mirror retention defaults to unlimited (R26). With a running service, the `mcp` process
routes job RPCs to it through the local courier (R24); F6's per-runner `mcp` instances
stay standalone until the guide's §10–12 point them at the service (R52).

### 4.14 MCP case tools — owner C7

`list_cases()`, `open_case(case)`, `get_orientation(case)`, `answer_question(case,
question_id, text | option_id)` — `CASE_MCP_TOOLS` with typed `inputSchema` and
`createCaseToolHandler` — on the stdio server (F2) and, when F4 has merged, on the front
door under scopes `cases:read` / `cases:write` through §4.19 (R53). `answer_question`
refuses `approval`, `briefing`, `payload.mcpAnswerable: false`, `payload.failure` and
status-changing questions from `mcp-frontdoor`, and calls `CaseRuntime.answerQuestion`
(`CaseBusyError` → `case_busy`). `get_orientation` returns non-disclosable facts to a
granted client; the grant screen says so. Tool names are fixed here.

### 4.15 Protocol test vectors — owner F3

`docs/protocol/approval-v1.md` and `tests/vectors/approval-v1/*.json` (shape
`given/input/expect{accepted, reason}`). The Node verifier and both mobile apps must pass
them. F5 adds `lease-v1` and `session-v1` (pipe framing); F4 adds `client-grant-v1`, which also covers `kl.client.revoke`,
`kl.node.enroll`, `kl.node.remove`, `kl.node.pair` and the fingerprint display.

### 4.16 Audit ledger — owner F3, mirrored by F4

The parent assumes `src/events/event-ledger.js` is hash-chained. It is not. F3 adds
`src/audit/audit-ledger.js`: append-only, each entry carrying `prev` and `hash` (SHA-256
over the JCS form of the entry without `hash`), with `append({ kind, data })` (`job_id`
inside `data`), `verify() → { ok, brokenAt? }`, `tail(n)`, `entriesAfter(hash, limit)`,
`slice({ after, limit, max_bytes })`. Every node writes approval requests, responses, tier
decisions and executions; kinds `gui.*` and `lease.*` are F5's; desktop-origin runs carry
`origin: { client: 'desktop', deviceId }` (F7). F4's mirror pulls node-signed envelopes
with `audit.slice`, paging backwards, and tells a prune gap from a fork. The front door's
own ledger is not mirrored (deferred, §7). The event ledger stays what it is.

### 4.17 Identifiers — all fleet stages

`NodeIdentity.nodeId` (`kl-<base32(sha256(pubkey))[0..16]>`) is the node id in every
protocol message. `MeshIdentity.peerId` (hex sha256) is transport-level and never appears
in approval, enrollment or front-door messages. Node keys travel as DER SPKI hex;
device keys as base64url raw 32 bytes, converted to SPKI for verification;
`deriveDeviceId(raw)` (F3) with vectors. `desktop-devices.json` device ids use the same
derivation (F7).

### 4.18 Delegate sessions — owner F4 (R10)

Node-side `delegate` / `send_to_job` on agent-profile nodes: the F2 stdio server stubs
them; F4 builds them through the core's agent executor under `remoteApprovals: 'phone'`,
multi-turn, origin `remote`, idle close 2 h, no job slot while idle, `node_busy` instead
of queueing, unsafe calls refused without the `fleet:unsafe` scope. Needs three small
core edits (executor getter in `create-core.js`, provider/origin pass-through in the
adapter, abort signal into the agent loop). `run --profile runbook` always hosts the
runbook engine and mesh link headless; `get_job` gains `evidence.checks` on stdio and
the front door; the `mcp` command never loads the agent core on a runbook node.

### 4.19 Scopes and fleet tools — owner F4, consumed by C7

`ScopeRegistry.register(scope, { tools, description, requires? })`,
`FleetRouter.registerTool(def, { scope, route })` where `route: args => ({ machine })`
picks the node (C7's front-door case tools take an explicit `machine` argument, so the
route needs no router state), `NodeFleetService.registerMethod('cases.<tool>', handler)`;
`frontdoor.oauth.scopes_enabled` lists the cases scopes. F4 spec §3.4 (scopes), §3.6
(`registerTool`), §3.7 (`NodeFleetService`); C7 registers through
`registerFrontDoorCaseTools` / `registerNodeCaseMethods`.

### 4.20 Turn hooks and the lock helper — owner C2

`CaseRuntime.addTurnStartHook(name, fn, { phase? })`, `fn({ runtime, caseId, dir, meta,
ownerMessage, turnId, source, now }) → Promise<{ notes?, triggers? } | void>`, awaited
inside `beginTurn(id, { turnId, ownerMessage, source })` before `detectTriggers` and
`buildOrientation` (R33); `phase: 'owner-message'` hooks run through
`runOwnerMessageHooks(turn)` after `UserPromptSubmit` (C5's classification). `Trigger = { kind,
detail, blocking, decisionIds?, key }`; baselines live in `.kl/triggers.json`
(`caseTypeMaterial` for C6). `detectTriggers` takes `playbookChanges`; `Reorient` success
calls `acknowledgePlaybooks`. `CaseRuntime.systemAction(id, label, fn, { commitMessage? })`
is the **only** case-lock helper (R37): in-process while this process holds the turn lock
it runs without re-locking; another process's lock raises `CaseBusyError`. Case-file
writes from phone, channel or IPC paths use `answerQuestion` or `systemAction`.
`host.interactive` is a function `() => boolean` (R50); `host.presence` may be proxied.

### 4.21 Desktop origin and the approval seam — owners F7 (origin), F3 (phone branch)

`src/core/origin.js`: `markLocalDesktopEvent(event, { deviceId })` / `isLocalDesktopEvent(event)` /
`localDesktopDeviceId(event)` (WeakMap); `markLocalRequester(fn, { deviceId? })` / `isLocalRequester(fn)`. In `create-core.js` the one merged rule for every `remoteApprovals` mode is

```js
const local = isLocalDesktopEvent(event);
denyAutoApproval: (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true
// 'phone' && !local → phone requester; 'phone' && local → requester null (on-screen dialog)
```

F3's phone branch is skipped for marked events; `classifyCall` still applies (`denied`
refuses, `unsafe` forces the gate); audit listeners still attach with `origin.client:
'desktop'` (R49). **Sub-agents inherit through the requester, not the event:** the core
builds children with `event = null` and the parent's re-threaded requester, so F7 adds
`markLocalRequester` / `isLocalRequester` to `origin.js`, F3 adds a ToolExecutor
`localOrigin` option, and the seam treats a marked requester as local — for a local
child the marked parent requester is kept rather than replaced by `null`. Desktop-added
allowed directories are scoped to marked runs; the desktop cannot remove permission
rules it did not add.

### 4.22 Contact channels — owner C4

`ChannelPlugin` gains `contactCapabilities()`, `sendContact(...)`, `onContactReply(handler)`,
`presence()`, `ownerTarget()`; `core.context.getContact()`; ladder state owner-wide at
`<dataDir>/contact/ladder.json`, one process runs it (cases-root lease). Owner proof
(R43): every contact inbound on Telegram/Discord requires `chat === contact target` and
sender `=== channels.<ch>.contactOwnerUserId`; SMS replies carry the batch `#TOKEN`; email
counts only the topmost `Authentication-Results` header or requires the `[KL-…]` token.
In service mode owner identities and targets come only from admin `service.json`
`contact.*` (`ADMIN_ONLY_KEYS`); the `Vault` tool refuses keys starting `contact.`. Slack
is not a contact channel. Mobile adapter (R44): device-signed `kl.question.answer`
envelopes verified on the node through `verifyDeviceEnvelope`; C4 owns `GET /v1/questions`,
`POST /v1/questions/{token}/answer`, `POST /v1/presence`, link methods `question.*`,
`presence.foreground`, push kind `question`, mounted through E2/E4/E5. IPC:
`contact:ladderState`, `contactPolicy:get/set`, `presence:heartbeat`, `presence:status`.

### 4.23 Session helper — owner F5

Protocol `kl-session-v1`: mutual HMAC handshake, then per-direction HKDF keys and
AES-256-GCM per-frame sealing; service secret in admin-owned
`<configDir>/session/helper-secret.json`, per-user copies in admin-owned
`<configDir>/session/users/<user|SID>.json`. Leases are request/grant pairs signed by the
phone, expiry on the node clock, in memory only; message types
`kl.lease.{request,grant,revoke,watch,view,status}` over F3's link (`link.send(envelope,
{ push })`, push kind `lease`); `lease-v1` vectors. Screenshots are window-only with
hit-testing at the point. Produced: `core.context.getGuiBroker()`, `readGuiStatus({
dataDir })`, `createGuiSubsystem(...) → { broker, leases, registerTools, start, stop }`;
`_images` lift in `agent-loop.js` only for tools flagged `emitsImages: true`.

### 4.24 Ingest — owner C7

Extracted text and page caches live in `.kl/ingest/`, which the model cannot write (Bash
excepted, stated as a limit). PDF text via `unpdf`, page split via `pdf-lib` (pure JS).
OCR honesty (R45): `verify` sees the same page image and must be vision-capable (
`getCapabilities().vision` and provider ∈ `anthropic, openai, gemini`), else `{ agrees:
null }`; `acceptVerified` skips OCR proposals unless `verify` saw the image and agreed;
files with `origin.kind: 'tool'` are never auto-accepted and the question says "a file
King Louie added"; ingest-accepted facts are `disclosable: false` regardless of category.
Document fact source fields: `page`, `quote`, `docId`, `proposalId`, `verified`, `ocr`,
`origin`. IPC `case:ingest*`; settings `cases.ingest.*`; `InferenceRouter.getCapabilities`
vision fix and `pdfInput` flag.

## 5. Shared-file ownership

These files are touched by several stages. Each stage keeps its edits additive and
minimal, and the plan names the exact insertion point. Where a row lists an order,
the later stage rebases onto the earlier one.

| File | Stages | Rule |
|---|---|---|
| `src/core/create-core.js` | all | one `require` + one `context` getter per stage. Exceptions (several additive hunks, listed in the owning spec): C2 (provider forwarding, `CaseRuntime` args, wake-up job, `denyAutoApproval` pass-through), C3 (registry, `adminExecutors`, agent-executor adapter options), C4 (adapter registration, ladder start/stop, contact config), F3/F7 (the §4.21 seam), F4 (executor getter) |
| `src/service/run.js` deps | F3 → F4 → F5 → F7; C3 `adminExecutors`, C4 `contactConfig`, C6 `examplesDir`, C7 `ingest` | each stage adds one dep read from admin config |
| `src/workflows/workflow-engine.js`, `src/skills/skill-loader.js` | C3 | `WorkflowEngine.create` gains `executeExtras`; executor packages load through a validating loader, never registered as skills |
| `src/cases/case-store.js` | C6 | `case.yaml` moves to the strict parser |
| `src/frontdoor/extensions.js`, `src/desktop-bridge/allowlist.js` | F3/F7 create; C4, F5, C7 add one line each | route and domain registration only |
| `src/core/settings.js` | C2, C3, C4, C5, C6, C7, F7 | one namespace per stage: `cases.*` (C2; C5/C7 add `cases.<sub>` keys), `executors` (C3), `contactPolicy`/`channels.*`/`contact.*` (C4), `playbooks` (C6) |
| `src/ipc/constants.js`, `register.js`, `preload.js` | C2, C3, C4, C5, C7, F7 | one handler module per stage (`src/ipc/<stage>-handlers.js`); F3 makes no IPC edits |
| `src/ipc/chat-handlers.js`, `src/cases/chat-integration.js` | C2, C5 | only C2 edits the case-turn block; C5 adds the classification phase through the hook |
| `src/cases/case-runtime.js` | C2, C5, C6, C7 | C2 owns; others add methods listed in §4.20, §4.10, §4.11 |
| `src/cases/gates.js` | C3, C5 | C3 `outboundGate`; C5 duplicate-job gate |
| `src/tools/builtin/case-tools.js`, `src/tools/index.js` | C2, C3, C5, C6, C7 | one `register<Stage>Tools` call per stage; new tools declare `requiresApproval: false` and appear in `assertWritable` |
| `src/inference/inference-router.js` | C2, C7 | C2 `target`/`NO_RETRY`; C7 `getCapabilities` vision, `pdfInput` |
| `src/execution/agent-loop.js` | C2 → F5 | C2 `AskUser` intercept; F5 `_images` lift |
| `src/execution/safety-policy.js` | F3, F5 | additive tiers only |
| `src/mcp/stdio-server.js` | F3 → F4 → F5; C7 (`mcp` case tools) | one registration block per stage |
| `src/service/run.js` | F3 → F4 → F5 → F7 | one `start<Thing>` call per stage |
| `src/service/cli.js`, `src/service/commands/` | F3, F4, F5, F7, C7 | one subcommand module per stage; `pair.js` shared by F3 → F4 |
| `src/service/config.js` | F3, F6, F7, C3, C4 | additive keys; unknown keys rejected (R55); `contact`, `executors` join `ADMIN_ONLY_KEYS` |
| `src/service/node-config.js` (`NODE_YAML_KEYS`) | F6 (strict loader, R11), F3 `approvers`, F4 `frontdoor`, `delegate`, F5 `gui` | additive keys only; F7's bridge config lives in `service.json` (`ports.desktopBridge`, `features.desktopBridge`), not `node.yaml` |
| `src/service/installers.js`, `src/service/windows-paths.js` | F5, F7 | exports `sanitizeWindowsPath`, `assertAbsolutePosixPath`, `WINDOWS_INSPECT_CSHARP`; `windowsSchtasksExe` reused, never bare `schtasks` |
| `src/execution/tool-patterns.js` | F3 (creates), F5 | dependency-free pattern helpers re-exported from `safety-policy.js` |
| `src/providers/anthropic-provider.js` | F5 | image blocks inside `tool_result` only |
| `src/mesh/mesh-transport.js` | F3 → F4 | F3 `listen: false`; F4 `connectPinned`, auth-before-parse |
| `src/channels/channel-plugin.js`, `telegram-bridge.js`, `discord-bridge.js`, `webhook-server.js` | C4 | `TelegramBridge.apiBase` becomes a constructor option |
| `src/memory/memory-manager.js` | F7 | `importEntry(entry) → { imported }` |
| `renderer.js`, `styles.css`, `index.html` | C2, C4, C5, C7, F7 | one `render<Thing>Section` per stage; F7 rebases last |
| `tests/e2e/helpers.js` | F7 (owner) | others add tests, not harness changes |
| `tests/helpers/` | F6 `stdio-mcp-client.js`, `example-fixture.js`, `example-denylist.js`; C4 `loopback-channel.js` | shared fixtures, created by the named stage |
| `tests/examples.test.js` | F6 (owner); F3/F4/F5/F7 append keys | |
| `package.json` | F6 (`!examples/**`), C4, C7 (pure-JS deps), C6 (bundled playbook examples carve-out, R32) | |
| `CLAUDE.md` | all | append one short section per stage |

## 6. Rulings that change the parents

Recorded here so the parents can be amended in one pass later:

1. Question records and the `Ask` tool move from cases stage 4 to stage 2 (§4.3).
2. Fleet stage 3's relay is a subset of the stage 4 front door, built as
   `src/frontdoor/` from the start (§4.13), rather than a throwaway.
3. Mobile apps live in this repository under `mobile/ios` and `mobile/android`
   (owner decision, 2026-09-23).
4. The cases stage 3 phone-agent adapter targets a generic HTTP errands API
   (owner decision, 2026-09-23).
5. Cases stage 7 OCR uses vision-capable models through `src/providers`; no local OCR
   dependency (owner decision, 2026-09-23).
6. `provenance: 'user'` requires a verified owner quote (cases stage 1 ruling, merged);
   `sourced` is model-declared. C7's ingest path is the first that verifies `sourced`
   facts against a document in `sources/`.
7. The hash-chained audit ledger the fleet parent (§10) assumes does not exist yet; F3
   builds it (§4.16). The existing event ledger is left alone.
8. The mesh transport parses the first inbound frame before authenticating the peer.
   F4's hardening fixes this before the mesh faces the internet; F3's relay may only be
   exposed on a LAN or behind operator-provided TLS until then.
9. The e2e harness (`tests/e2e/helpers.js`) is an HTTP bridge against a shared real
   profile, not Playwright's `_electron` as CLAUDE.md describes. F7 replaces it with an
   isolated `--user-data-dir` harness; until then, e2e tests set `KL_CASES_ROOT` (cases)
   and must not depend on profile state.
10. Per-day budget categories refuse the action rather than pausing the case (R14;
    parent cases §9.1).
11. Relayed device enrollment is staged and applied by an admin per node; revocation is
    immediate (R15; parent fleet §6.4). The first valid phone response decides a request
    (R16; parent §9).
12. `MeshPairing` codes last 2 minutes, not 10; the LAN pairing wordlist has 256/288
    words; `seenNonces` is one global set; there is no MCP SDK in the repo (the stdio
    server is hand-written).
13. APNs/FCM credentials must belong to the app's signer, so the parent's "owner's own
    push keys and a public store app" cannot both hold (Q-A, §8).
14. Node-side `delegate`/`send_to_job` belong to F4 (R10, §4.18); the parent left them
    to the stdio stub.
15. Unsafe runbooks requested over MCP on an F2 node go straight to `denied`; there is
    no `awaiting_approval` until F3. `doctor` did not check sudoers; F6 adds it.
16. The `Skill` tool cannot reach executor packages: they use the skill-package layout
    but are not registered as skills (C3). Bash network use inside cases stays
    unguarded (C3 deferral).
17. Foreground mismatch in a lease **suspends** it (parent fleet §4.6); the helper's
    per-user secret copy is plaintext, protected by file ownership (F5 deviation).

## 7. Controller rulings (R10–R56) and deferrals

Full text in the child specs and the review record; one line each here so a later reader
can find the decision.

- R10 delegate → F4. R11 strict `node.yaml`. R12 `site.status` runbook. R13 narrow `ref`
  pattern. R14 per-day refusals. R15/R16 enrollment and first-response. R17 JCS module
  `src/platform/jcs.js` (F3). R18 `registerExtraBriefRules`. R19 index at `.index/`.
  R20 F6 review accepted in full. R21 stable `mcp.` key. R22 pairing by URL scheme,
  console bootstrap. R23 grant code typed on the phone. R24 `mcp` routes through the
  courier when a service runs. R25 front-door approvers admin-owned. R26 mirror
  retention unlimited.
- R33 turn-start hook. R34 `requireReoriented` shape. R35 plan states. R36 duplicate-job
  gate in C5. R37 `systemAction` only. R38 `outboundGate` signature. R39 `sendExternal`
  has no stage-3 consumer. R40 `external-agent` host-only. R41 owner consent. R42
  authority floors. R43 owner proof. R44 mobile adapter envelopes. R45 OCR honesty. R46
  entity index location. R47 `QuestionStore.close`. R48 polling without turns.
- R49 desktop seam. R50 `host.interactive()`. R51 root-import walker (`lstat`, no
  links, `nlink === 1`, owner check, `O_NOFOLLOW`). R52 F6 `mcp` instances stay
  standalone. R53 C7 uses F4's route contract. R54 front-door ledger unmirrored
  (deferred). R55 unknown `service.json` keys rejected. R56 Windows bridge-file ACE.
- Deferred with owners: front-door ledger mirror (F4 follow-up); TLS error reasons in
  `check` results (F6, engine change); Bash network use in cases (C3); Wayland portals
  (F5); `RequestTools`/`ToolSearch` in owner case turns (C2 trade-off, blocked for now).

## 8. Open questions for the owner

- **Q-A push credentials (F3).** The parent wants the owner's own APNs/FCM keys and a
  public store app; APNs/FCM credentials must belong to the app's signer, so both cannot
  hold. Options: (1) the owner builds/sideloads the apps (TestFlight / own Play track)
  with their own keys; (2) a project-run push relay that only ever carries request ids
  (needs project infrastructure; weakens "no hardcoded endpoints"); (3) no push:
  foreground WebSocket plus local notifications, background delivery lost. F3 ships
  `PushSender` pluggable with (3) as the always-available default until this is decided.
