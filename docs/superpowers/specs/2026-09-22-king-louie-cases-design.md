# King Louie Cases — Design Spec

- **Status:** Draft — architecture agreed, stages to be detailed one at a time
- **Date:** 2026-09-22
- **Relates to:** `2026-09-21-king-louie-fleet-design.md` (the fleet spec). Cases
  run on the headless core that fleet stage 1 delivered, and fleet stage 7's
  MCP surface gains a case view in cases stage 7 (§12).

## 1. Goal

Let King Louie take a real-world task that spans days or weeks — sell a
property, get contractor quotes, book medical appointments, run a software
project — and drive it to completion with less of the owner's time than any
hosted assistant needs, without inventing facts, without assigning the owner
labor they did not agree to, and without losing the thread when the context
window is compacted.

King Louie is open source. **Nothing in the code, defaults or docs may be
specific to one person's setup.** Case types, playbooks, executors, channels
and contact policies are configuration. Reference playbooks and executor
adapters ship as examples under `examples/`; an owner's real cases live outside
the repo in their data directory.

### 1.1 Evidence

The design is grounded in four multi-day sessions run on a hosted agent
product in September 2026, each using an external phone-calling agent for
outreach. Two failed outright, two produced partial results, and one ended
with the owner asking for a refund. The failures recur across all four and are
independent of the domain:

| # | Pattern | Example | Root cause |
|---|---|---|---|
| F1 | Guesses promoted to facts, silently | A parcel assumed to be a house; an address read as a herd of livestock; a sales channel called "untried" that three agents had worked for three years | Sourced, inferred and unknown facts are indistinguishable in the agent's working state |
| F2 | Load-bearing question never asked; cosmetic ones asked instead | The owner's real constraints surfaced on day 6 of 6; meanwhile the agent asked the owner to pick form-field values | No structured brief; questions generated per turn from local context |
| F3 | Plans assign labor to the owner | Nine web forms and 68 printed letters, after "the assistant does the heavy lifting" | Planning is channel-first, not executor-first; no capability check |
| F4 | Bad news answered with a new plan; detours accepted one "want me to?" at a time | Five plans in two days; a quotes task spent most of a session fixing the phone agent's code | "No path" treated as unacceptable output; no drift or budget guard |
| F5 | Existing state not checked before asserting absence | An inbound errand, a payoff letter and a set of project threads all existed and were declared missing | No check-before-assert reflex; weak cross-session retrieval |
| F6 | Compaction and stale copies | Six compactions; a stale local script nearly deleted five live guardrails; a sub-agent overwrote the working log | State lives in the context window and ad-hoc files |
| F7 | Invented constraints leaked outbound | A bid deadline the agent made up was read to a real buyer, twice | F1 with no gate on what leaves the system |
| F8 | Serial confident wrong diagnoses | Three theories for dropped calls before instrumentation was added | Hypothesis stated as conclusion |
| F9 | Detail past materiality | Owner: "you're nit-picking, I want to sell the house" | No notion of materiality relative to the objective |
| F10 | Ops friction re-solved | The same TLS quirk diagnosed in three sessions | No shared operational memory |
| F11 | Approval round-trips | Three approvals for one payload trim | Exact-payload approval only |
| F12 | Cost | Credits exhausted; ~250k tokens between compactions | No budget |

What worked, and is preserved: facts cited to live sources, explicit
correction sections, exact-payload approval with the payload shown,
verifiable outputs (a plat acreage read by a clerk, a utility cost from the
district engineer), and the owner's own convergence on "one thread per
property plus a shared playbook".

### 1.2 Non-goals

- Replacing the chat. The chat stays; a case is what a chat can be *about*.
- A general workflow language. Playbooks are procedures with gating
  questions, not a DSL.
- Multi-user cases. One owner, as in the fleet spec.
- Re-implementing external agents. A phone agent, an email service or a
  fleet runbook is an executor behind an adapter; its internals are out of scope.
- Fixing the hosted products the evidence came from.

## 2. Decisions

| # | Decision | Chosen | Rejected alternatives |
|---|---|---|---|
| D1 | Who owns the reasoning | **King Louie's own agent loop** owns the case, brief, ledger and loop. Remote LLM clients get a case view over MCP (stage 7) | King Louie as a passive store that a remote client thinks on top of |
| D2 | Where a case lives | **A git repository on disk**, human-readable files, committed every turn | Internal JSON store; database |
| D3 | How rules are enforced | **Gates in code** over data the model writes through tools | Prompt rules only (already shown not to hold) |
| D4 | Approval shape for outbound work | **Envelopes**: intent, recipients, allowed facts, rules, caps. Exact payload still logged and shown | Exact-payload approval for every send |
| D5 | What happens on a dead end | **Report, at most one recommendation, then `needs-direction`** | Generate the next plan |
| D6 | Where a detour goes | **Routed to an existing case if one fits, else a new case; original continues** | Executed inline; refused |
| D7 | How the owner is reached | **Presence-driven channel ladder** with question records that any channel can answer | One fixed channel |
| D8 | Model selection | **By role** (`orient`, `classify`, `draft`, `judge`, `verify`) | By chat-wide tier only |
| D9 | External agents | **Skill packages** implementing the executor adapter interface | Built-in integrations |
| D10 | Relationship to the workflow engine | **Reused inside a case** for parallel sub-work; not extended into the case model | Extend the task graph into a case |

## 3. Architecture

```
                 owner ──── in-app chat / mobile / Telegram / email / SMS / voice ────┐
                                                                                     │ channel adapters (§8)
                                                                                     ▼
 ┌──────────────────────────── King Louie core (src/core, src/cases) ──────────────────────────────┐
 │                                                                                                │
 │   CaseRuntime ── orientation ── agent loop (case mode) ── tools: Ledger Brief Decide Recommend │
 │        │              ▲                 │                          Plan  Executor  Ask         │
 │        │              │                 ▼                                                      │
 │   gates: recommendation · outbound · duplicate            wake-ups (cron) · budget · lock      │
 │        │                                                                                       │
 │        ▼                                                                                       │
 │   <case repo>/  brief.md  facts.jsonl  decisions.md  open-items.md  journal/  sources/ ...     │
 │                                                                                                │
 └───────────────┬────────────────────────────┬──────────────────────────────┬────────────────────┘
                 │ executors (§6)             │ workflow engine (fan-out)    │ playbooks (§10)
                 ▼                            ▼                              ▼
   Bash · Browser · WebFetch · external agents (phone, email) · fleet runbooks · the owner
```

### 3.1 Principles

1. **The case is the memory.** Every turn and every wake-up begins by reading
   the case from disk. The conversation is secondary context and may be
   trimmed freely.
2. **Provenance is data.** Every fact records where it came from. Inferred and
   unknown are first-class states, not omissions.
3. **Rules are gates.** If the model must not do something, a gate refuses it.
   The prompt explains the rule; the gate enforces it.
4. **Executors are named.** No plan step exists without an executor, and the
   owner is an executor who must consent.
5. **Nothing inferred leaves.** An outbound payload may carry only disclosable,
   non-inferred facts inside an approved envelope.
6. **Stop beats guess.** On a dead end or a load-bearing unknown, the correct
   output is the unknown, one recommendation at most, and a pause.
7. **Check before assert.** Existing cases, facts and live executor state are
   searched before anything is declared missing or created.
8. **Host-agnostic.** Everything under `src/cases/` is Electron-free and runs
   under `king-louie-service`.

## 4. The case repository

### 4.1 Layout

Default root: `<dataDir>/cases/`. Configurable as `cases.root`. A case is a
git repository and may be cloned, moved or opened elsewhere.

```
<case>/
  case.yaml            identity, status, playbooks, related cases, budget, overrides
  brief.md             YAML front matter (structured fields) + prose
  facts.jsonl          append-only fact ledger, one JSON object per line
  decisions.md         dated decisions, each citing fact ids
  open-items.md        unknowns and blocked items, rendered from the ledger + manual notes
  journal/             YYYY-MM-DD-HHMM-<kind>.md  briefings, re-orientations, failure reports
  sources/             raw evidence: documents, OCR text, call records, API responses
  artifacts/           deliverables
  playbooks/           versioned playbook packages (vendored, or git submodules)
  .kl/                 machine state (see 4.5); .kl/index/ and .kl/runs/ are gitignored
```

King Louie commits at the end of every turn that changed files, with a message
of the form `turn <n>: <one-line summary>`. Owner edits made with other tools
are picked up on the next turn; a dirty tree at turn start is committed first
as `owner edits`.

### 4.2 `case.yaml`

```yaml
id: 3f9c…                    # ulid
slug: lakeside-lot-sale
title: Sell the lakeside lot
type: outreach                # case type; picks orientation extras and defaults
status: active                # draft | active | needs-direction | paused | done | abandoned
created: 2026-09-22T14:00:00Z
playbooks:
  - name: property-sale
    version: 1.2.0
    source: git+https://example.com/playbooks/property-sale.git
related:
  - id: 7ab1…
    relation: blocked-by
    note: phone agent status bug
budget:                       # see §9; unset fields inherit settings defaults
  usd: 40
  deadline: 2026-11-30
  contactsPerDay: 20
  questionsPerDay: 6
channels:                     # overrides of the owner's contact policy, optional
  urgency.high: [present, sms, call]
autonomy:                     # what the case may do without asking, per failure class
  onExecutorNoAnswer: retry-within-envelope
  onDeadEnd: stop
```

### 4.3 `brief.md`

Front matter carries the structured fields; the body carries prose the owner
or the model wrote.

```yaml
objective: Convert the lot to cash
why: …                        # the owner's reason; drives materiality
successCriteria:
  - Signed contract at or above floor
  - Closed within deadline
hardConstraints:
  - Both owners of record sign
  - No seller financing
alreadyTried:                 # F2: asked up front, never re-derived
  - Three listing agents on the MLS over three years, one low offer
resources:
  executors: [browser, web, phone-agent, owner]
  ownerLabor: []              # steps the owner consented to do (§6.2)
deadline: 2026-11-30
materiality:                  # what warrants contacting the owner
  tell: [offers, deadline-risk, spend-over-25-usd]
  ignore: [no-answer, voicemail]
```

The brief is elicited at case creation by a **gating pass**: the model asks
only questions the owner alone can answer (history, constraints, preferences,
authorization), never questions it can resolve itself. Playbooks contribute
their own gating questions (§10). Until the gating pass is complete, the case
is `draft` and the recommendation gate refuses recommendations.

### 4.4 The fact ledger

`facts.jsonl` is append-only. One record per line:

```json
{
  "id": "f-0042",
  "stmt": "Lot is 2.120 acres per the recorded plat",
  "subject": "lot",
  "attr": "acreage",
  "value": 2.12,
  "unit": "acre",
  "provenance": "sourced",
  "source": { "kind": "call", "ref": "sources/phone-agent/call-29.json", "at": "2026-09-21T19:04:00Z" },
  "confidence": 0.95,
  "disclosable": true,
  "loadBearing": true,
  "supersedes": "f-0017",
  "basis": [],
  "status": "active",
  "addedBy": "turn-40"
}
```

| Field | Rules |
|---|---|
| `provenance` | `sourced` (document, URL, API, call record in `sources/`), `user` (the owner said it; the message is the source), `external-agent` (an executor reported it), `inferred` (derived by the model; `basis` lists the fact ids it rests on and is required), `unknown` (a question, see below) |
| `disclosable` | Defaults **false** for categories `personal`, `financial`, `legal`, `health`, and for every `inferred` and `unknown` record. The owner can flip it through `Ledger.setDisclosable`; the model cannot |
| `loadBearing` | True when a decision or recommendation depends on it. Set by the model, and set automatically when `Decide` or `Recommend` cites the fact |
| `supersedes` | A correction never edits. It appends a new record and marks the old one `superseded`. The chain is the correction history |
| `status` | `active`, `superseded`, `retracted` |

An **unknown** is a record with `provenance: unknown`, no value, and three
extra fields: `changes` (what a value would change), `answerable` (who or what
can answer: `owner`, an executor id, a source kind) and `how` (the step to
get it). Unknowns marked `loadBearing` head every orientation.

Facts about **operations** (an API's rate limit, a TLS quirk, a stale route)
are ordinary records with `subject: ops` and are also mirrored into the global
ops memory (§10.3) so the next case starts with them.

### 4.5 `.kl/` machine state

```
.kl/
  budget.json         spend so far by category, thresholds crossed
  wakeups.json        registered wake-ups (§5.4)
  executors.json      per-case executor overrides and live-state cache
  envelopes/          approved envelopes and every payload issued under each (§6.3)
  questions/          open and answered question records (§8.3)
  lock                held for the duration of a turn
  runs/<id>/          sub-agent scratch space (gitignored)
  index/              embeddings over facts, journal and sources (gitignored, rebuildable)
```

## 5. The orientation loop

### 5.1 Case mode

A chat can be attached to a case (new or existing). While attached, the agent
loop runs in **case mode**: the system prompt gains the case's operating
section, the case tools (§5.6) are core tools, and the orientation block is
injected at the start of every turn ahead of the conversation.

### 5.2 Orientation

Built by code from the repo, fixed size (default 6–8k tokens, configurable),
in this order:

1. Brief front matter and success criteria.
2. **Load-bearing unknowns**, each with `changes` and `how`.
3. Case status and, if `needs-direction`, the failure report it is waiting on.
4. Active facts grouped by provenance: user, sourced, external-agent, inferred.
   Superseded facts are summarized as a one-line correction history.
5. Decisions, each with the fact ids it cites and a flag if any is superseded.
6. Open items and pending questions to the owner.
7. Live executor snapshot (from `.kl/executors.json`, refreshed if stale).
8. Budget remaining and thresholds crossed.
9. The most recent journal entry.
10. Case-type extras (for a `software-repo` case: branches, open PRs, related
    cases touching the same repo).

Facts that do not fit are summarized by count and are reachable with
`Ledger.query`. The conversation history follows the orientation and is
compacted by the existing compactor with no special handling: the case, not
the chat, is the memory.

### 5.3 Re-orientation triggers

The runtime checks these at the start of every turn and every wake-up:

| Trigger | Detected how |
|---|---|
| Time gap | `now - lastTurn > cases.reorientAfterHours` (default 8) |
| Decision undermined | A decision cites a fact that is now `superseded` or `retracted` |
| Executor change | Live snapshot differs from the cached one in a field the case type marks material |
| Budget threshold | 50 %, 80 %, 100 % of any budget category |
| Message mid-plan | An owner message arrives while a plan step is in flight |
| Playbook update | A vendored playbook's version changed |

When any trigger fires, the turn must begin with a **re-orientation**: what
changed, which decisions it affects, and one of `continue`, `adjust`, `ask`.
The runtime refuses `Plan` and executor calls in that turn until the
re-orientation is written. It is journaled as `journal/…-reorient.md`.

### 5.4 Wake-ups

A case registers wake-ups in `.kl/wakeups.json`; the existing cron engine
(`src/cron/`) executes them. Kinds: `poll-executor`, `deadline-check`,
`daily-orientation`, `retry`. A wake-up runs a turn with no owner message,
using the `orient` role first (§9.2). If nothing changed, it writes a one-line
journal entry and stops. If something changed, it escalates to `judge`, acts
within its envelopes and autonomy settings, and contacts the owner only when
the brief's materiality says so or a question is required.

### 5.5 Turn lifecycle

1. Acquire `.kl/lock` (refuse a second concurrent turn on the same case).
2. Commit owner edits if the tree is dirty.
3. Evaluate triggers; build orientation.
4. Run the agent loop. Sub-agents get `.kl/runs/<id>/` and contribute facts
   only through `Ledger`.
5. Close: render `open-items.md` from the ledger, write the journal entry,
   update `.kl/budget.json`, commit, release the lock.

### 5.6 Case tools

| Tool | Operations | Notes |
|---|---|---|
| `Ledger` | `assert`, `infer`, `unknown`, `retract`, `query`, `setDisclosable` (owner only) | The only write path to `facts.jsonl`. `infer` requires `basis`. `assert` requires a `source` |
| `Brief` | `read`, `update(field, value, reason)` | Updates are journaled; `alreadyTried` and `hardConstraints` may only be set from `user` provenance |
| `Decide` | `record(decision, factIds, alternatives)` | Marks cited facts load-bearing |
| `Recommend` | `propose(claims[], factIds[], unknowns[])` | Passes the recommendation gate (§7.1) or is refused with the failing claims |
| `Plan` | existing planner, now emits `executor` per step | Passes the executor check (§6.2) |
| `Ask` | `owner(question, options, urgency, expiresAt, defaultOnSilence)` | Creates a question record (§8.3); replaces `AskUser` in case mode |
| `Executor` | `submit`, `status`, `results`, `cancel` | Routed through the registry (§6) and the outbound gate (§7.2) |

## 6. Executors

### 6.1 Registry

An executor entry, global in settings with per-case overrides in
`.kl/executors.json`:

```yaml
id: phone-agent
kind: external-agent          # tool | external-agent | runbook | owner
package: examples/executors/phone-agent
capabilities: [call, voicemail, inbound-line]
cannot: [web-form, email]
constraints:
  callingWindow: { tz: America/Chicago, start: "09:00", end: "17:00", weekdays: [1,2,3,4,5] }
  contactsPerDay: 50
cost: { perContact: 0.40 }
latency: async-hours
state: poll                   # how live state is fetched: poll | webhook | none
authority: envelope           # none | envelope | signed  (signed = fleet phone approval)
```

Built-in executors: `bash`, `browser`, `web` (search + fetch), `files`,
`workflow` (fan-out through the existing engine), `runbook` (fleet nodes, when
stage 2 of the fleet exists), and `owner`.

### 6.2 Executor-first planning

The planner emits `executor` on every step. Before the plan is shown, the
runtime checks each step against the registry:

- The executor exists and has the required capability; otherwise the step is
  rewritten to one that does, or flagged.
- Constraints are satisfiable within the deadline (e.g. 44 contacts at 50/day
  is fine; 9 web forms on an executor that cannot fill forms is not).
- Steps with `executor: owner` are refused unless the owner has consented.
  Consent is a `user` fact and is recorded under `brief.resources.ownerLabor`.

A plan is shown with the executor column, its cost estimate, and the consent
it needs. This is the planner's approval card, extended.

### 6.3 Envelopes

An envelope is an approval of *intent within limits*:

```json
{
  "id": "env-07",
  "intent": "Collect labor-only quotes for the rear door replacement",
  "executor": "phone-agent",
  "recipients": { "allow": ["+15550100", "+15550101"], "addRequiresApproval": true },
  "facts": ["f-0003", "f-0011", "f-0019"],
  "rules": ["no address until the business is verified", "no other bids disclosed"],
  "caps": { "usd": 12, "contacts": 20, "attemptsPerContact": 3 },
  "window": { "start": "2026-09-23", "end": "2026-09-30" },
  "grantedBy": { "channel": "in-app", "at": "2026-09-22T20:10:00Z" },
  "payloads": []
}
```

The model may issue any concrete payload that fits. For each payload the
runtime checks recipients ⊆ allow, referenced facts ⊆ `facts`, every fact
disclosable and not inferred (§7.2), caps and window; then appends the exact
payload to `payloads` and shows it in the journal. Anything outside produces a
**delta approval** naming only the difference ("adds recipient X", "discloses
f-0042"). A trim or rewording inside the envelope needs no approval.

Envelope approvals are question records (§8.3) and travel over the channel
ladder. When the fleet's phone app exists, an executor with
`authority: signed` requires the phone's signature over the envelope hash; the
payload check stays on the node.

### 6.4 External agent packages

An external agent adapter is a skill package (existing `src/skills/`
plugin format) exporting the executor interface:

```
capabilities() → { capabilities, cannot, constraints, cost, latency, state }
submit(job, envelope) → { jobId }
status(jobId) → { state, contacts[], lastChange }
results(jobId) → { records[] }       # each record saved under sources/<executor>/ and asserted with provenance external-agent
cancel(jobId)
briefRules() → string[]              # instructions for briefing this executor, e.g. "no identifiers in the opener"
```

`briefRules` is how lessons about instructing an executor stay with the
executor rather than in one chat. The reference package under
`examples/executors/phone-agent/` targets a generic HTTP errands API; an
owner's real endpoint and credentials are configuration (vault).

## 7. Gates

### 7.1 Recommendation gate

`Recommend.propose` is refused when:

- the case is `draft` (gating pass incomplete);
- a claim marked load-bearing cites no fact, or cites a fact whose provenance
  is `inferred` or `unknown`, or whose status is not `active`;
- a load-bearing unknown exists on the same subject and attribute as a claim.

The refusal names the failing claims. The model may source the fact, cite a
different one, or move the claim into `unknowns`. The rendered answer always
lists load-bearing unknowns before analysis.

### 7.2 Outbound gate

Every `Executor.submit` payload and every channel message to a non-owner is
scanned:

- Values matching any active fact must belong to a fact that is `disclosable`
  and not `inferred`.
- Values matching any non-disclosable fact (by value, or by tagged category
  keyword) block the send.
- Dates, prices, deadlines and commitments in free text that do not match a
  `user` or `sourced` fact block the send with "unsourced constraint".

The last rule is what stops an invented deadline. A blocked send is reported
to the model with the offending spans; it may assert the fact with a source,
ask the owner, or drop the span.

### 7.3 Duplicate gate

Before `Ledger.unknown`, `Executor.submit` that creates a new job, `Ask`, or
case creation, the runtime searches the case's facts and questions, all open
cases' briefs and facts (through `.kl/index/` and a cross-case index), and live
executor state. Matches are shown to the model before the call proceeds; the
call is refused only when a match is exact (same subject, attribute and
executor job). This is check-before-assert as a mechanism.

## 8. Channels and presence

### 8.1 Adapter interface

```
send(message, { expectsReply, options[], correlationId, expiresAt, urgency }) → { deliveryId }
onReply(handler)              # handler(correlationId, text | optionId, meta)
presence() → { lastSeen, active } | null
capabilities() → { richText, buttons, attachments, voice }
```

Existing adapters: in-app chat, Telegram, Discord, Slack, ntfy push. New:
email (IMAP/SMTP, or relayed through an owner-configured HTTP service), SMS
and voice call (relayed through an owner-configured telephony service), the
fleet mobile app (fleet stage 3), and in-app voice (STT/TTS) later. All
credentials come from the vault; all endpoints are configuration.

### 8.2 Presence and the ladder

Presence signals: desktop UI focused with input in the last N minutes, mobile
app foreground, per-channel last-seen, quiet hours, and an owner-set away mode
(`away: { mode: email-only, until: … }`).

The contact policy is an ordered ladder per urgency, in settings, overridable
per case:

| Urgency | Default ladder |
|---|---|
| `low` | journal + in-app; daily email digest |
| `normal` | present channel → Telegram after 30 min → email after 4 h |
| `high` | present channel → SMS after 15 min → voice call |

Urgency is set by the caller (`Ask`, envelope approvals, budget stops) with
defaults: questions `normal`, blockers and money `high`, briefings `low`.

### 8.3 Question records

A question to the owner is a record in `.kl/questions/`:

```json
{ "id": "q-12", "text": "…", "options": [{"id":"a","label":"…"}], "urgency": "normal",
  "createdAt": "…", "expiresAt": "…", "defaultOnSilence": "hold",
  "deliveries": [{"channel":"telegram","at":"…"}], "answer": null }
```

Pending questions are **batched into one message per channel** per ladder
step. A reply on any channel resolves the record by correlation id; the answer
is asserted as a `user` fact. `defaultOnSilence` is either `hold` (case waits)
or a named safe default declared in the brief or playbook. Envelope approvals
are question records with `kind: approval`.

## 9. Budgets and model roles

### 9.1 Budgets

Categories: `usd` (LLM spend from the usage tracker plus executor-reported
cost), `deadline`, `turnsPerDay`, `contactsPerDay`, `questionsPerDay`.
Defaults in settings; `case.yaml` overrides; playbooks may suggest.

- 50 %: noted in orientation.
- 80 %: re-orientation trigger; the model must state what is left and whether
  finishing is worth it.
- 100 %: case → `paused`, briefing at `normal` urgency, resumes only on an
  explicit owner grant (a `user` fact raising the budget).

**Dead ends.** When the model writes a failure report (`journal/…-failure.md`)
it may attach at most one recommendation. The case enters `needs-direction`:
`Plan` and new `Executor.submit` are refused until the owner replies, unless
`case.yaml` `autonomy` grants a specific action class for that failure kind.

### 9.2 Model roles

The tier map (`settings.inference.tierMap`) gains roles, each resolving to a
provider and model, per-case overridable:

| Role | Default tier | Used for |
|---|---|---|
| `orient` | fast | Wake-up "did anything change"; orientation summaries |
| `classify` | fast | Detour and materiality classification |
| `draft` | standard | Payload drafting inside an envelope; journal entries |
| `judge` | smart | Plans, recommendations, re-orientations |
| `verify` | smart, **different provider family from `judge`** when available | Ledger consistency review; second reading of blocked outbound spans |

Wake-ups run `orient` and escalate to `judge` only on change. Two existing
defects are fixed as part of this: per-task `provider:model` is honoured by
the executor adapter, and `routeWithFallback` is wired into case turns. Usage
tracking gains a per-case roll-up written to `.kl/budget.json`.

## 10. Detours, playbooks and ops memory

### 10.1 Detour routing

A detour is proposed work that does not serve the brief's objective. Entry
points: a `Plan` or `Executor.submit` whose `serves` tag does not match the
objective (checked by `classify`), or an owner message the classifier scores
as off-case.

Routing, in order: search open and recent cases by brief similarity and
subject overlap; search case-type live state (repo branches and PRs, executor
jobs); then propose one of **attach to case X**, **new case with prefilled
brief**, or **decline**. Links are written to both `case.yaml` files. If the
original depends on the detour, the original gets an open item `blocked-by`.

Default: one line in the reply, the original continues, the detour case
starts on the owner's nod. Exception: a detour that blocks the original is
surfaced as a `high` blocker with the routing attached.

The `software-repo` case type makes this concrete for code: its orientation
extras include branches, open PRs and every other case touching the same
repository, so "fix this bug" is checked against work in flight before
anything is written.

### 10.2 Playbooks

A playbook is a versioned package under `playbooks/` in a case, vendored or a
git submodule, updated from outside any one case:

```
property-sale/
  playbook.yaml       name, version, caseType, gatingQuestions[], materialityDefaults, budgetDefaults
  steps.md            the method, with the facts each step establishes and the executor it expects
  briefRules.md       instructions contributed to executors' briefs
  sources.md          endpoint cookbook (how to query the kinds of records this domain needs)
```

Gating questions are asked during the brief's gating pass. Steps are
suggestions to the planner, not a schedule. When a case reaches `done`, the
model may **propose** a playbook change as a diff against the vendored copy;
the owner reviews and pushes it to the playbook's own repository. Reference
playbooks ship under `examples/playbooks/`; none is specific to a person or
place.

### 10.3 Ops memory

Facts with `subject: ops` are mirrored into a global store
(`<dataDir>/ops-memory.jsonl`) keyed by executor or endpoint, and injected
into orientation when the case uses that executor. This is where "the API
dedupes on phone and undercounts silently" lives after the first time.

## 11. Relationship to existing code

| Existing | Role in cases |
|---|---|
| `src/core/create-core.js` | Wires `CaseRuntime`, the case tools, the cross-case index and the channel ladder; exposes them to both hosts |
| `src/agents/builtin/planner.js`, `src/workflows/*` | Planner emits `executor`; the workflow engine runs fan-out inside a case turn. The event ledger is connected. Tasks get an approval requester so gated tools work |
| `src/execution/agent-loop.js`, `tool-executor.js` | Case mode injects orientation; gates run in the tool executor before dispatch |
| `src/memory/*` | The keyword memory store remains for chat; cases use their own ledger and the ops mirror. The model gains a write path (through `Ledger`) for the first time |
| `src/context/*` | Compaction unchanged; orientation is prepended outside it |
| `src/cron/*` | Executes wake-ups |
| `src/channels/*`, `src/notifications/*` | Become channel adapters behind the §8.1 interface |
| `src/tracking/usage-tracker.js` | Feeds `.kl/budget.json` |
| `src/skills/*` | Hosts executor adapter packages and playbooks |
| `src/ipc/*` | New handlers for case list/open/create, orientation view, question answers, envelope approvals. Renderer gains a case panel |
| `src/service/*` | Cases run headless; questions go over non-UI channels |
| Fleet spec | Cases stage 7 adds `list_cases`, `open_case`, `get_orientation`, `answer_question` to the front-door MCP surface; `delegate` may target a case |

## 12. Stages and order

| Stage | Delivers | Usable result |
|---|---|---|
| 0 | This spec | — |
| 1 | Case repo, `case.yaml`, brief with gating pass, fact ledger, `Ledger`/`Brief`/`Decide`/`Recommend`, recommendation and duplicate gates, orientation, case mode, git commit per turn, case panel | Start a case from chat; facts and unknowns tracked; recommendations gated |
| 2 | Re-orientation triggers, wake-ups, journal, budgets, `needs-direction`, model roles, per-case usage roll-up | A case runs for days unattended and briefs the owner |
| 3 | Executor registry, executor-first planner, envelopes with delta approvals, outbound gate, external-agent package interface, reference phone-agent adapter | Outreach through an external agent under an envelope; nothing inferred leaves |
| 4 | Question records, presence, the ladder, email adapter, SMS and voice relay adapters, batching | The owner is reached where they are, once |
| 5 | Detour classifier and router, cross-case index, `software-repo` case type | Detours land in the right case |
| 6 | Playbook package format, versioning, gating questions, proposed-diff extraction, `examples/playbooks/` | A finished case's method becomes a package the next case loads |
| 7 | Document ingest (PDF text, OCR) into `sources/` with facts extracted under review, entity index across cases, case view on the fleet MCP surface | The knowledge base; remote LLM clients can open a case |

Each stage gets its own detailed section or child spec, then an implementation
plan, then PRs. Stage 1 is independent of the fleet's stages 2–7 and depends
only on the headless core.

## 13. Testing

- **Unit:** ledger append-only and supersede chains; provenance rules
  (`infer` without `basis` refused, `assert` without `source` refused);
  the three gates; envelope fit and delta detection; trigger detection
  (superseded fact cited by a decision); the ladder under a fake clock;
  budget thresholds and `needs-direction`; the lock.
- **Transcript regression fixtures:** each of the four evidence sessions is
  encoded as a brief plus an event sequence (with all personal data replaced),
  and the suite asserts: the invented deadline is blocked at the outbound gate;
  the ambiguous noun becomes an unknown record, not an inference; a document
  already in another case is surfaced by the duplicate gate; the executor
  code-fix is routed as a detour; web-form targets are planned onto `browser`,
  not `owner`. New failures are added the same way.
- **Integration:** a case turn against mock providers; a commit per turn; a
  wake-up through the cron engine in service mode; a question through a
  loopback channel adapter and back to a `user` fact.
- **Boundary:** `tests/electron-boundary.test.js` covers `src/cases/`.
- **E2E:** one scripted case through the desktop app with Playwright.

## 14. Error handling

- A gate refusal is a tool error the model can act on; it never ends the turn.
- A failed commit (e.g. a merge conflict from owner edits) pauses the case with
  a `high` question; the runtime never force-writes.
- An executor that cannot be reached leaves its snapshot marked stale in
  orientation; the model may not assert facts from a stale snapshot.
- A channel delivery failure advances the ladder; exhaustion of the ladder is
  journaled and the question stays open.
- Lock contention returns "case busy" to the second caller; wake-ups reschedule.

## 15. Assumptions made without asking

- Case data stays local and unencrypted beyond the existing vault for
  credentials; the outbound gate, not encryption, is what keeps private facts
  in. Owners who want encrypted case repos can put `cases.root` on an
  encrypted volume.
- Playbooks are authored by both the owner and the model; the model only ever
  proposes diffs.
- The chat remains the primary desktop interface; the case panel is a view,
  not a replacement.
- Time zone for windows and ladders is the owner's configured zone, not the
  machine's.
