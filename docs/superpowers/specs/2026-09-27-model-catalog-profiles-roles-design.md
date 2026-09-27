# King Louie Model Catalog, Profiles and Roles — Design Spec

- **Status:** Draft — design agreed with the owner 2026-09-27, awaiting spec review
- **Date:** 2026-09-27
- **Relates to:** `2026-09-25-chat-history-recall-design.md` (the recall spec;
  sequencing in §18, two small cross-spec changes in §17.2),
  `2026-09-25-session-memory-benchmark-design.md` (evaluates step 4, §19),
  `2026-09-23-cases-stage2-unattended.md` §3.8 (the case roles this spec
  re-points).

## 1. Goal

Let King Louie use the right model for each job, from any provider the owner
has a key for, including local models, without ever picking a model the owner
has not chosen. Concretely:

1. Know every model's price and capabilities from a maintained open catalog,
   fully offline when needed, instead of hand-kept tables.
2. Separate credentials from model choice. The API keys page holds keys; a
   Models page holds model choice.
3. Show only usable models anywhere a model can be chosen.
4. Replace the single global tier with **profiles**: named sets of models
   assigned to **roles** (main, worker, utility, plus specialists and custom
   roles). A chat or case picks a profile; the owner can switch the main model
   between turns.
5. Send cheap work to cheap models: utility calls, and exploration delegated
   to a read-only worker subagent.
6. Make Stop actually stop, and make "switch model and retry" one click.

King Louie is open source. Nothing in code, defaults or docs may be specific to
one person's setup. Shipped profile names are generic; model names, thresholds
and URLs are settings.

### 1.1 Evidence

One agent-mode chat in the owner's profile, 2026-09-27: five model calls in one
turn, all on `gpt-5.5`. King Louie recorded $0.5178. Priced at list
(models.dev: $5 per million input, $0.50 cached input, $30 output):

| Call | Input | Cached | Output | What it did | Cost at list |
|---|---|---|---|---|---|
| 1 | 39,888 | 0 | 559 | read a large attached transcript, called Glob | $0.2162 |
| 2 | 43,193 | 39,552 | 185 | tool call | $0.0435 |
| 3 | 45,211 | 42,624 | 274 | tool call | $0.0425 |
| 4 | 45,676 | 44,672 | 264 | tool call | $0.0353 |
| 5 | 60,765 | 44,672 | 3,446 | answer, after reading four spec files | $0.2062 |
| | | | | **total** | **$0.5437** |

What this shows:

- The first and last calls are 78% of the cost: fresh input and output on the
  strongest model. The middle tool rounds were cheap because 90% of their input
  was a cache hit. Moving them to a cheaper model would have saved about $0.03,
  since a switched model starts with a cold cache.
- Delegating the four file reads to a cheap subagent that returns a summary
  would have removed most of the 16K fresh tokens from the last call.
- Two rounds were spent on path errors (the chat's working directory was
  another project). That is a separate bug; fixing it saves money whatever the
  routing.
- King Louie's own price table prices `gpt-5.5` as `gpt-5` (prefix match) and
  assumes cached input is half price. The recorded total was close to list only
  by coincidence.
- The chat shows six model responses but only five recorded calls. Which call
  is missing was not established.

The code review behind this spec (Appendix A.1) found five overlapping model
controls, most of which have no effect; a chat model picker that silently
changes every chat; a send path that rejects 11 of the 14 providers although
all 14 implement streaming and tool calls; a dead LLM router whose settings
toggle is on in the owner's profile; two price tables that disagree; and a
Stop button whose abort never reaches the model request.

### 1.2 Non-goals

- **Whole-turn routing and cheap tool rounds (step 4).** Outlined in §19; they
  get their own spec after recall lands.
- **Switching model inside a running turn.** Every choice is frozen when a turn
  launches (§6.6). A neutral agent-loop history format, needed for
  cross-provider switching mid-turn, belongs to step 4.
- **Role-fitness measurements** (King Louie scoring how well each model does
  each role). A later stage adds them as an input to §7.
- **Embeddings and speech in profiles.** Recall's embedder settings and the
  voice settings keep owning them.
- **A Stop control for unattended case turns** (no chat open).
- **Routing through a proxy** such as OpenRouter or LiteLLM. It would give up
  direct keys and local models.
- **Fixing the working-directory path errors** seen in §1.1. Tracked
  separately.

## 2. Decisions

Settled with the owner on 2026-09-27:

| # | Decision | Consequence |
|---|---|---|
| M-D1 | The catalog is models.dev, implemented first | Bundled snapshot plus daily refresh plus overlays (§4); no hand-kept price tables; no scraping job |
| M-D2 | The owner assigns models to roles; King Louie only uses models placed in a role | The resolver never picks outside the active profile (§6) |
| M-D3 | Profiles are named sets of role assignments; a chat or case picks one | Power users build profiles; a global default applies to new chats (§6.1) |
| M-D4 | A built-in "King Louie selected" profile proposes; the owner accepts | Changes are shown with reasons and cost effect; optional auto-accept, off by default (§7) |
| M-D5 | Roles replace the fast, standard and smart tiers | One-time migration; tiers, smart routing and the LLM router are removed (§13) |
| M-D6 | Case roles map onto the new roles | orient, classify → utility; draft → worker; judge, verify → main (§8) |
| M-D7 | Remove the send path's three-provider restriction | Usable means a passing connection test; agent mode needs tool calling (§5) |
| M-D8 | The main model can be switched per chat or case, between turns only | Header switcher; a turn's choices freeze at launch (§6.5, §6.6) |
| M-D9 | Stop must cancel the model request; a stopped reply offers "Retry with…" | §9 |
| M-D10 | Core roles, two specialist roles, and custom roles for power users | vision and image generation; custom roles behind an Advanced section (§6.2) |
| M-D11 | Keyword, regex and prefix routing rules are removed | Step 4's whole-turn routing replaces them |
| M-D12 | Headless runs use the default profile | Service, channels, cron, gateway, unless a job names a profile (§12) |
| M-D13 | The catalog fetch is on by default with a bundled snapshot for full offline use | §4.1 |
| M-D14 | A new Electron-free `src/models/` subsystem | Not an extension of `inference-router.js` (§3) |

Decisions made by the designer and labelled as such are in §20.

## 3. Architecture

`src/models/` is Electron-free (`tests/electron-boundary.test.js` applies) and
host-agnostic. Four parts, each testable alone:

1. **Catalog.** Loads the snapshot, the live sources and the overlays; answers
   "what is this model, what can it do, what does it cost".
2. **Availability.** Knows which providers are credentialed and passing, which
   models each account can reach, and which of those meet a job's needs.
3. **Profiles.** Stores profiles, custom roles and per-chat or per-case
   overrides. Its resolver answers "which usable models, in order, fill this
   role for this call".
4. **Suggester.** Builds the King Louie profile's proposals.

`InferenceRouter` becomes a thin consumer: callers ask for a role, the router
asks the resolver, and failover walks the resolved list. Provider classes get
their prices from the catalog.

### 3.1 Interfaces

```
Catalog
  load({ snapshot, cacheDir, fetch, settings })       refresh({ force? }) → { source, fetchedAt }
  get(provider, modelId) → Entry | null               list(provider?) → Entry[]
  price(provider, modelId, usage) → { usd, parts } | null   // usage: input, cachedInput, cacheWrite, output, reasoning
  status() → { source: 'live'|'cache'|'snapshot', fetchedAt, snapshotDate }
  events: updated

Availability
  test(provider) → ProviderStatus                      testAll()
  status(provider) → ProviderStatus                    markAuthFailure(provider, error)
  usable({ needs }) → Candidate[]                      explain(provider, modelId, { needs }) → { usable, reasons[] }
  events: changed

Profiles
  list()  get(id)  create(p)  update(id, patch)  remove(id)  setDefault(id)
  customRoles.list/create/update/remove(id) → remove refuses while referenced, returns references
  setOverride({ chatId | caseId }, { role: 'main', target | null })
  snapshot({ chatId?, caseId?, profileId? }) → TurnModels     // frozen at turn launch (§6.6)

TurnModels
  resolve(role, { needs, explicit? }) → { targets: Target[], skipped: [{ target, reasons }], borrowedFrom? }

Suggester
  propose() → { roles, reasons, costEffect } | { unavailable: reason }
  accept(proposalId)  dismiss(proposalId)
```

`Entry`, `Target`, `Candidate` and `ProviderStatus` are defined in §4.2, §6.1
and §5.

## 4. Catalog

### 4.1 Sources

Merged in this order; later sources win field by field:

1. **Bundled snapshot.** `src/models/snapshot/models-dev.json` (models.dev
   trimmed to King Louie's 14 providers: about 448 KB, 742 models, measured
   2026-09-27) and `src/models/snapshot/scores.json` (Artificial Analysis
   scores from OpenRouter's model list: 189 models, about 20 KB).
   `npm run models:snapshot` regenerates both; it runs before each release.
   A fresh install works fully offline.
2. **Live models.dev.** `GET https://models.dev/api.json` (MIT licensed,
   maintained by the opencode team, no key). Fetched at core start when the
   cached copy is older than `models.catalog.refreshHours` (24), and on
   "Refresh now". Cached at `<dataDir>/catalog/models-dev.json` with its ETag.
   The recall spec puts embedding model files in `<dataDir>/models/`; the
   catalog uses `catalog/` so the two never collide.
3. **Live scores.** `GET https://openrouter.ai/api/v1/models` (works without a
   key), on the same schedule, cached as `<dataDir>/catalog/scores.json`. Only
   `benchmarks.artificial_analysis` (intelligence, coding, agentic indices) is
   kept.
4. **Local Ollama models.** From Availability's Ollama discovery (§5.4):
   cost zero, context and tool support as Ollama reports them.
5. **Owner overrides.** `models.overrides["<provider>:<model>"]`, any Entry
   field, for contracted prices or models the catalog lacks.

`models.catalog.fetch` (true) turns both live fetches off; the snapshot and any
cached copy still apply. The fetches send no user data.

### 4.2 Entry

```js
{
  provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', family: 'gpt',
  releaseDate: '2026-04-23', knowledge: '2025-12-01',
  limits: { context: 1050000, input: 922000, output: 128000 },
  input: ['text', 'image', 'pdf'], output: ['text'],
  toolCall: true, structuredOutput: true,
  reasoning: { supported: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  openWeights: false, local: false,
  cost: {                                   // USD per million tokens; null = unpriced
    input: 5, output: 30, cacheRead: 0.5, cacheWrite: null, reasoning: null,
    tiers: [{ aboveContext: 272000, input: 10, output: 45, cacheRead: 1 }]
  },
  scores: { intelligence: null, coding: null, agentic: null, source: 'artificial-analysis' },
  sources: ['snapshot', 'models.dev']       // provenance, shown in the UI
}
```

### 4.3 Lookup

- **Provider ids map explicitly**: gemini → `google`, qwen → `alibaba`,
  together → `togetherai`, fireworks → `fireworks-ai`, copilot →
  `github-copilot`, ollama (cloud models) → `ollama-cloud`; the rest are
  identical. The map lives in one file.
- **Dated ids match their base.** A response id `gpt-5.5-2026-04-23` or
  `claude-haiku-4-5-20251001` is looked up exactly, then with a trailing
  `-YYYY-MM-DD` or `-YYYYMMDD` removed.
- **No loose prefix matching.** It is what misprices `gpt-5.5` and the mini
  models today.
- **Scores attach by vendor and id.** OpenRouter's `anthropic/claude-sonnet-5`
  scores Anthropic's `claude-sonnet-5` and OpenRouter's own entry of that id.
- **Unknown models are unpriced** (`cost: null`), shown as "unpriced", never as
  $0 or a guess.

### 4.4 Pricing

`Catalog.price` is the only price function. It prices uncached input, cached
reads, cache writes, output and reasoning separately, applies the long-context
tier when the request's input exceeds it, and returns the parts. It replaces
`src/tracking/pricing-tables.js` and every provider's `getModelPricingTable`
and cost calculation; `buildLlmCallMetrics` asks the injected catalog.
`UsageTracker` stops recomputing and trusts each call's recorded `costUsd`.

### 4.5 Capabilities

The catalog replaces `InferenceRouter.getCapabilities`, whose vision and tool
guesses are stale (Claude 4 counted as non-vision; Ollama tool calling guessed
from the model name).

## 5. Availability

### 5.1 Usable

A model is usable for a job when all of these hold:

1. **Credentialed.** The provider has a key, Anthropic OAuth is connected, or
   (Ollama) the server answers.
2. **Passing.** The provider's last connection test passed.
3. **Reachable.** The model is in the list the provider returned for this
   account. For a provider whose list call is unsupported or empty, the
   catalog's entries for that provider count.
4. **Fit.** It meets the job's `needs`: `toolCall` for agent mode, image
   input for image attachments and vision work, `minContext` where set.

A usable model the catalog does not know can be placed in a profile by hand
and is marked unpriced. The suggester never picks it.

### 5.2 One connection test

`Availability.test(provider)` calls the provider class's `listModels()`, which
all 14 implement. One call proves the credential and returns the account's
model list without spending tokens. It replaces both hand-written tests
(`create-core.js` `testProviderConnection`, which covers only OpenAI,
Anthropic and Copilot, and the `settings:testProvider` handler).

`ProviderStatus`: `{ ok, error, checkedAt, models: string[] }`, stored under
the existing `apiStatus` key, extended with `models`.

Tests run on key save or change, at core start for providers whose last test
is older than `models.availability.retestHours` (24), and on "Test all".

### 5.3 During use

A 401 or 403, as `error-classifier.js` classifies it, calls
`markAuthFailure`: the provider becomes unusable at once, a badge asks the
owner to fix the key, and resolved lists skip it. Rate limits and timeouts do
not change usability; `FailoverPolicy` handles them as today.

### 5.4 Ollama

`models.ollama.baseUrl` (`http://127.0.0.1:11434`) replaces the hardcoded
address in `ollama-provider.js`. Discovery reads `/api/tags` for installed
models and `/api/show` for context length and capabilities (tool calling and
image input where Ollama reports them).

### 5.5 The send path

`chat-handlers.js` checks usability instead of the fixed
`['openai', 'anthropic', 'gemini']` list. `Availability.explain` supplies the
reasons shown in pickers and errors: no key, test failed (error and time), not
in this account, no tool calling, no image input.

## 6. Profiles and roles

### 6.1 Profile

```js
{
  id: 'p-…', name: 'Anthropic only', kind: 'user' | 'king-louie' | 'migrated',
  roles: {
    main:    [{ provider: 'anthropic', model: 'claude-opus-5-5', effort: null }, …],
    worker:  [ … ],
    utility: [{ provider: 'openai', model: 'gpt-5.4-mini', effort: 'low' }, …],
    vision:  [ … ],            // optional
    imageGeneration: [ … ],    // optional
    'legal-drafting': [ … ]    // custom roles, optional
  }
}
```

A `Target` is `{ provider, model, effort }`. `effort` is optional and must be
one of the catalog's reasoning efforts for that model; thinking tokens are
billed as output, so low effort on utility is a lever that costs no cache.

Profiles live in `models.profiles`; `models.defaultProfileId` names the
default. A chat stores `profileId` (absent means the default). A case stores
`profile` in `case.yaml`.

### 6.2 Kinds of role

1. **Core:** `main`, `worker`, `utility`. Every profile has them.
2. **Specialist:** `vision` (image and document reading, including case
   ingest), `imageGeneration` (image models for the image tool). Optional.
3. **Custom:** defined under Models, Advanced, with a warning. Each has an id
   (lowercase slug, not colliding with a built-in role), a description,
   `needs` (`toolCall`, `imageInput`, `minContext`) and a required `fallback`
   core role. Agents, case file roles, SpawnAgent and workflow tasks may name
   it.

### 6.3 Precedence

For one call, the first that applies:

1. An explicit target on the call: a case file role naming a provider and
   model, or a workflow task's `preferredModel`. Still checked for usability.
2. The case's profile, with the case's main override.
3. The chat's profile, with the chat's main override.
4. The default profile.

### 6.4 Resolving a role

`resolve(role, { needs })` filters the role's list by §5.1, keeps order, and
returns the first usable target plus the rest as failover, and every skipped
entry with its reasons.

- **Empty specialist:** `vision` falls to the first image-capable model in
  utility, then worker, then main. `imageGeneration` falls to today's
  `imageGeneration` settings.
- **Empty custom role:** its declared fallback.
- **Empty core role:** utility borrows from worker, worker from main; the call
  record carries `borrowedFrom` and the UI shows a badge. An empty main fails
  the turn with the reasons; it never borrows from a weaker role.
- **Unknown role** (an agent or case file names a role that is not defined):
  the call fails with a message naming the role; the agent editor warns when
  the agent loads. It never silently runs on main.
- **verify** takes the first usable main target from a different provider
  family than judge's target (`providerFamily` in `src/cases/roles.js`, kept);
  if none exists it warns and uses judge's, as today.

### 6.5 Main override

The chat and case header shows the profile and the current main model. Picking
another usable model sets an override for `main` only, stored on the chat
(`chat.mainOverride`) or, in a case, in `case.yaml` (`mainOverride`) so
unattended case turns follow it. The override lasts until cleared or changed;
the header marks it. Each switch appends a `status` message ("Main model
switched from Fable 5.1 to GPT-5.6"). Worker, utility and the rest keep coming
from the profile.

### 6.6 Frozen at launch

At turn launch the send path calls `Profiles.snapshot(...)` once. The
resulting `TurnModels` serves every model call in that turn, subagents
included. A switch or settings change during a run applies to the next turn.

The next turn is rebuilt from stored chat messages, which belong to no
provider, so a cross-provider switch between turns needs no translation.
Provider-private reasoning (Anthropic thinking blocks, OpenAI encrypted
reasoning items) is never sent to a different provider. The first turn on the
new model reads its context uncached, once.

### 6.7 Failover within a turn

Mid-turn history is in the current provider's own message format
(`AgentLoop` builds it with the provider's `buildToolMessages`). So:

- Failover to another target **of the same provider** may happen on any call.
- Failover to **another provider** may happen only on the turn's first model
  call, before provider-specific history exists.
- Otherwise the turn fails with the reason, and the switcher plus "Retry
  with…" (§9) make trying another model one click.

This replaces the hardcoded fallbacks in `inference-router.js` (Groq to
OpenAI, Ollama to Groq). `FailoverPolicy` and the error classifier are kept.

## 7. The King Louie profile

A built-in profile (`kind: 'king-louie'`, generic name "King Louie selected")
that proposes assignments; the owner accepts.

### 7.1 Picking rules

Deterministic; every pick carries a one-line reason. Candidates are
`Availability.usable()` with catalog prices and scores.

- **main:** tool calling required. Rank by agentic score, then intelligence.
  Among candidates within `bandPoints` (3) of the best, the cheaper wins.
- **worker:** tool calling and at least 128K context required. The cheapest
  whose agentic score is at least `workerAgenticRatio` (0.8) of main's first
  pick.
- **utility:** no tool requirement. The cheapest whose intelligence score is
  at least `utilityIntelligenceRatio` (0.5) of main's first pick. With
  `preferLocalUtility` (false) on, a usable local model with tool support goes
  first.
- **vision:** as utility, with image input required and without the local
  preference.
- **imageGeneration:** usable image-output models, cheapest priced first;
  unpriced ones are left for the owner to add.
- **Price** compares a blended rate: three parts input to one part output per
  million tokens.
- **Lists** hold two or three targets, spread across providers where possible,
  which also gives verify a different family.
- **Effort:** utility at the lowest effort offered; others at the model's
  default.
- **Never picked:** unpriced models, and unscored models except local ones
  under `preferLocalUtility`. Custom roles are never filled; they resolve to
  their fallback unless the owner fills them in their own profile.

### 7.2 Proposals

A proposal is recomputed when an input changes: catalog refresh, a key added or
removed, a provider test changing state, a score change. Each changed role
shows old and new targets, the reason, and the estimated monthly cost effect
from the owner's recent recorded usage (the last 30 days of calls, repriced).
Nothing changes until the owner accepts. A dismissed proposal stays hidden
until the inputs change again. `autoAccept` (false) accepts automatically.
"Duplicate as my profile" copies it into an ordinary profile.

On first run the King Louie profile starts as a proposal; the default profile
stays the migrated one until the owner changes it.

## 8. Using the roles

| Call site | Today | Role |
|---|---|---|
| Chat turn, plain and agent mode (`chat-handlers.js`) | active tier via `resolveInference` | main |
| Chat title (`autoNameChat`, `chat-handlers.js:47`) | active tier; usage not recorded | utility; usage recorded |
| Advisor (`execution/advisor.js`) | `settings.advisor.model`, no UI | main |
| Case orient, classify (`cases/roles.js`) | fast tier | utility |
| Case draft | standard tier | worker |
| Case judge, verify | smart tier | main (verify: other family, §6.4) |
| Case ingest OCR (`ingest/vision.js` `pickOcrModel`) | `cases.ingest.vision`, else draft or judge with vision | vision |
| Image tool (`image-generate-tool.js`) | `imageGeneration.defaultProvider`; model free-form from the LLM | imageGeneration; the tool may only use models in the role |
| SpawnAgent (`spawn-agent-tool.js`) | LLM passes free-form `model` and `provider` | `role` parameter (`worker` default, `utility`, `main`, or a custom role) |
| Background task tool, cron, gateway, remote control, mesh | agent's tier on the active settings | agent's role on the default profile (§12) |
| Workflow tasks | `task.preferredModel` | explicit target (§6.3) else the agent's role |
| Planner, code writer | smart tier | main |
| Agent IPC parallel and serial runs (`agent-handlers.js:100,254`) | ignore each agent's tier | each agent's role |
| Embeddings, speech | own settings | unchanged |

Agents replace `inferenceTier` and the hardcoded `model:
'claude-sonnet-4-20250514'` with `role` (and an optional explicit target).

### 8.1 Delegation

- The built-in `code-explorer` becomes a general **explorer**: read-only tools
  (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`; today it has `Bash` and
  `Read`), role worker, returns a summary with file paths or URLs capped at
  `models.explorer.summaryMaxTokens` (2,000).
- Main's system prompt gains a short stable section: reading or searching many
  files or pages goes to the explorer, which returns a summary. It sits in the
  stable, cached part of the system prompt (recall spec §6.5), not the dynamic
  part.
- Delegation is prompted, not forced.

## 9. Stop and retry

Today the Stop button (`index.html:118`, wired in `renderer.js`) replaces Send
while a response runs and calls `chat:stopResponse`, which aborts the run's
`AbortController` (`chat-handlers.js:740-748`). `AgentLoop` checks the signal
between iterations and forwards it to tools. No provider passes the signal to
its HTTP request, so an in-flight model call runs to completion at the provider
and is billed; the loop notices only after it returns.

Changes:

- `BaseProvider` gains one request helper that attaches `options.abortSignal`
  to every `fetch`, streaming and non-streaming; all 14 providers use it.
- A stopped turn keeps what has streamed as an assistant message with
  `stopped: true` and a "stopped" marker; nothing else from that run is
  appended afterwards.
- Usage is recorded for every call that finished. A call cut off mid-stream is
  recorded with the usage the provider had reported so far (for example
  Anthropic's input tokens from `message_start`) and `usagePartial: true`;
  it is never recorded as $0.
- Stop appears in the chat and in the case view while a turn runs.
- **Retry with…** appears on the stopped reply and on the last reply. It lists
  usable models, main-role models first; choosing one sets the main override
  (§6.5), removes the stopped or last reply with the existing
  `chat:truncateFrom`, and re-sends the last user message.

## 10. Cost records

Each entry in an assistant message's `llm.calls[]` gains `role`, `profileId`,
`failover` (true when not the first target) and `borrowedFrom`. SpawnAgent
results' `llm` totals roll up into the parent message (today they stay inside
the tool result), kept separately as `llm.subagents`. The reply's metrics line
splits cost by role ("$0.12 · main $0.09 · worker $0.02 · utility $0.01").
`UsageTracker` totals by role and by model as well as by provider.

## 11. Settings UI

- **API keys** (the Providers tab renamed): credentials, Anthropic OAuth, the
  Ollama address, each provider's status with its last error, "Test all". The
  per-provider model dropdowns and "Set active" are removed.
- **Models** (replacing the Inference and Routing tabs):
  - *Profiles*: list, create, duplicate, delete, set default. The editor shows
    each role as an ordered, reorderable list. "Add model" opens a picker of
    usable models meeting the role's needs, with price, context, capabilities
    and scores; unusable models appear greyed out with their reasons. Effort
    per entry.
  - *King Louie profile*: current picks, the pending proposal as a list of
    changes with Accept and Dismiss, auto-accept, the thresholds and the
    local switch.
  - *Catalog*: source and date, Refresh now, fetch on or off, refresh
    interval, overrides.
  - *Advanced: custom roles*, with a warning.
- **Chat and case header:** a profile picker and the main model switcher with
  the override marker. They replace the tier, provider and model controls in
  the chat info popover, which keeps its cost information.
- **Replies:** Stop, Retry with…, and the per-role cost line.

## 12. Headless and service

Service mode, channels, cron, gateway and remote control resolve through the
default profile unless a job or case names one. `king-louie-service` gains:

```
models status              catalog source and date, provider statuses
models refresh             refresh catalog and scores, retest providers
profiles list | show <id>  profiles and their resolved roles
profiles set-default <id>
```

## 13. Migration

Runs once at core start when `models.profiles` is absent. It never deletes the
old keys until the new ones are written; a failure leaves the old settings
untouched and is reported.

1. Create a profile `kind: 'migrated'`, name "Migrated settings":
   - `main`: the active tier's target (what chat uses today), then the smart
     tier's target if different.
   - `worker`: the standard tier's target. `utility`: the fast tier's target.
   - Empty tier models fall back to `providerModels[provider]`, as
     `InferenceRouter.resolve` does today.
   - `vision`: `cases.ingest.vision` if set. `imageGeneration`: empty (the
     image settings keep applying).
2. Set it as the default.
3. Role timeouts from tier timeouts: utility ← fast, worker ← standard,
   main ← smart.
4. Case roles: tier names in `settings.cases.roles` and in each `case.yaml`
   `roles` are read as the mapped role when loaded; `case.yaml` is not
   rewritten until the host next writes it.
5. User-defined agents: `inferenceTier` fast, standard, smart read as utility,
   worker, main.
6. Remove `activeProvider`, `providerModels`, `inference.activeTier`,
   `inference.tierMap`, `inference.timeoutsMs`, `inference.smartRouting`,
   `inference.llmRouting`, `inference.agentLoopModel`, `advisor.model`,
   `cases.ingest.vision`.

The `/llm model <provider> <model>` command becomes `/llm profile <name>`.

## 14. Settings

```js
models: {
  catalog: {
    fetch: true, refreshHours: 24, staleWarnDays: 30,
    modelsDevUrl: 'https://models.dev/api.json',
    scoresUrl: 'https://openrouter.ai/api/v1/models'
  },
  overrides: {},                                  // "<provider>:<model>": partial Entry
  ollama: { baseUrl: 'http://127.0.0.1:11434' },
  availability: { retestHours: 24 },
  profiles: [],                                   // §6.1; the King Louie profile is added on first run
  defaultProfileId: null,
  customRoles: [],                                // §6.2
  roleTimeoutsMs: { main: 90000, worker: 30000, utility: 15000 },
  kingLouie: {
    autoAccept: false, bandPoints: 3,
    workerAgenticRatio: 0.8, utilityIntelligenceRatio: 0.5,
    preferLocalUtility: false, blend: { input: 3, output: 1 }
  },
  explorer: { summaryMaxTokens: 2000 }
}
```

Per chat: `profileId`, `mainOverride`. Per case (`case.yaml`): `profile`,
`mainOverride`, added to `CASE_YAML_KEYS` in `src/cases/case-store.js` as owned
by M2. Every key merges through `mergeSettings`.

## 15. Error handling

| Failure | Behaviour |
|---|---|
| Main has no usable model | The turn fails before any call, listing each skipped target and its reason, with a link to Models |
| The main override is unusable | The turn fails with the reason and a one-click "use the profile's main"; never a silent switch |
| A profile in use is deleted | Its chats and cases move to the default profile; a status message says so |
| An unknown role is referenced | The call fails naming the role; the agent editor warns on load |
| Catalog fetch fails | Cached copy, then snapshot; the badge shows the source and date |
| Fetched catalog is malformed | Discarded; the previous copy stays; logged |
| Catalog older than `staleWarnDays` (30) | Badge |
| A provider returns 401 or 403 | Provider marked unusable at once; badge; lists skip it |
| The suggester cannot propose (no scored, priced candidates) | The King Louie profile says why; nothing changes |
| A mid-turn cross-provider failover would be needed | The turn fails with the reason (§6.7) |
| Migration fails | Old settings untouched; error reported; retried next start |
| Stop during a model call | The request is aborted; partial reply kept and marked; partial usage recorded (§9) |

## 16. Testing

Unit tests with `node --test`, one file per module under
`tests/models-*.test.js`, on temp data directories, with injected `fetch` so no
test touches the network:

- **catalog:** merge order and field-level overrides; provider id map; dated
  ids; no prefix matching (a dated mini model never gets the full model's
  price); long-context tiers; malformed JSON keeps the previous copy; offline
  start uses the snapshot; ETag handling.
- **pricing:** with a fixture catalog carrying models.dev's 2026-09-27
  `gpt-5.5` rates, the §1.1 calls price to $0.5437; unpriced models return
  null.
- **availability:** the four rules; `listModels` as the test; auth failure
  marking; retest scheduling; Ollama discovery against a fake server.
- **resolver:** precedence; needs filtering; specialist, custom and core
  fallbacks; unknown role error; frozen snapshot; the same-provider and
  first-call failover rule; verify's family rule; overrides.
- **suggester:** fixed catalog and score fixtures give fixed picks; thresholds;
  local switch; unpriced and unscored exclusion; proposal diff and dismissal.
- **migration:** a settings fixture shaped like the owner's (standard tier on
  `gpt-5.5`, a failing Groq key) yields `gpt-5.5` first in main and Groq in
  utility shown unusable; tier timeouts; case role tier names.
- **stop:** a fake streaming server confirms the request is aborted, the
  partial reply is saved with `stopped: true`, and usage is partial, not zero.
- **providers:** streaming and one tool call for each of the 14 providers
  against a local fake server.
- **SpawnAgent:** `role` parameter; a model outside the profile is refused.
- `tests/electron-boundary.test.js` passes with `src/models/` present.
- **e2e** (`tests/e2e/`, temp profile, catalog fetch off): a fresh profile
  shows the snapshot catalog; create a profile; switch main in a chat; Stop
  during a streamed reply against a fake provider, then Retry with….

An opt-in live check, `npm run smoke:providers`, runs the provider checks with
the owner's real keys; it is not part of `npm test`.

Removed or rewritten: `tests/inference-router.test.js`,
`tests/smart-routing.test.js`, the pricing parts of
`tests/usage-tracker.test.js`, `tests/provider-config-consistency.test.js`,
and the tier parts of `tests/core-settings.test.js` and
`tests/settings-handlers.test.js`.

## 17. Relationship to existing code

### 17.1 This spec

| Path | Change |
|---|---|
| `src/models/` (new) | `catalog.js`, `provider-ids.js`, `pricing.js`, `availability.js`, `profiles.js`, `resolver.js`, `suggester.js`, `migrate-tiers.js`, `snapshot/models-dev.json`, `snapshot/scores.json`, `index.js` |
| `scripts/models-snapshot.js` (new), `package.json` | `models:snapshot`, `smoke:providers` scripts |
| `src/core/create-core.js` | builds the four parts, runs migration, `resolveInference` asks the resolver, removes `providerDefaults`, `testProviderConnection` and the LLM router |
| `src/core/settings.js` | `models` namespace; removes tier, provider-model and routing defaults |
| `src/providers/inference-router.js` | thin role consumer; drops tiers, `getCapabilities`, hardcoded fallbacks, smart and LLM routing |
| `src/providers/llm-router.js`, `smart-routing.js`, `src/tracking/pricing-tables.js` | removed |
| `src/providers/base-provider.js`, all providers | request helper with abort signal; prices from the catalog; `getModelPricingTable` removed |
| `src/providers/ollama-provider.js` | base URL from settings |
| `src/ipc/chat-handlers.js` | turn snapshot, usability check instead of the three-provider list, title on utility, stop semantics, retry, per-role cost |
| `src/execution/agent-loop.js` | failover over resolved targets (§6.7); removes the loop-model switch |
| `src/execution/advisor.js` | main role; records usage |
| `src/agents/agent-schema.js`, `src/agents/builtin/*.js` | `role` replaces `inferenceTier` and `model`; explorer becomes read-only |
| `src/tools/builtin/spawn-agent-tool.js`, `background-task-tool.js`, `image-generate-tool.js` | role parameter; image tool limited to the role |
| `src/cases/roles.js`, `src/cases/ingest/vision.js`, `src/cases/case-store.js` | case roles resolve through profiles; OCR via vision; `profile` and `mainOverride` keys |
| `src/ipc/settings-handlers.js`, `src/ipc/agent-handlers.js`, `src/ipc/constants.js`, `preload.js` | models, profiles, availability and catalog channels; removal of tier and provider-model channels; agent runs honour roles |
| `src/tracking/usage-tracker.js` | trusts recorded cost; totals by role and model |
| `src/service/cli.js`, `src/service/commands/models.js` (new) | §12 |
| `renderer.js`, `index.html`, `styles.css` | API keys and Models tabs, header switcher, Stop, Retry with…, cost line |
| `CLAUDE.md` | a short section on the catalog snapshot script and the live smoke check |

### 17.2 Changes to the recall spec

To be applied when the recall plan is written:

- The recall Ollama embedder reads `models.ollama.baseUrl` instead of its own
  `history.embedder.ollama.baseUrl`.
- The recall provenance record (`context` on assistant messages, recall spec
  §7) sits beside this spec's `llm.calls[].role` fields; the renderer shows
  both on the same line.

## 18. Stages and rollout

Each stage has its own implementation plan and ships on its own.

1. **M1: catalog and availability.** Catalog with snapshot, refresh and
   overlays; the single price function; availability and the one connection
   test; Ollama discovery and address; removing the three-provider
   restriction; the chat info popover's model list limited to usable models;
   the working Stop. No role changes yet; the tier resolver keeps working, fed
   by the catalog.
2. **M2: profiles and roles.** Profiles, the resolver, the turn snapshot, main
   overrides, migration, the API keys and Models tabs, the header switcher,
   Retry with…
3. **M3: roles in use.** Utility, worker and specialist call sites (§8), the
   explorer and delegation, SpawnAgent roles, cost by role, the King Louie
   profile, custom roles, service commands.

Sequencing with other work: M1 to M3 come before the recall stages H1 to H4.
Both edit the chat send path, `create-core.js` and `agent-loop.js`, so they run
one after the other, not in parallel. Step 4 (§19) comes after recall.

## 19. Step 4 outline (separate spec)

- **Whole-turn routing with guardrails.** Route a whole turn to a cheaper role
  model when it is simple, replacing the removed keyword and regex rules. Under
  recall, context is rebuilt every turn, so a per-turn switch costs almost no
  cache.
- **Cheap tool rounds.** A worker model picks tool calls between main's first
  and last calls. Worth it only where the price gap beats the lost intra-turn
  cache, which §1.1 shows is often not the case.
- **Neutral agent-loop history** with per-provider translation, enabling both
  of the above across providers and cross-provider failover mid-turn.
- **Evidence.** Routing policies are configurations in the session memory
  benchmark, which already reports answer correctness and tokens per
  configuration; guardrails ship on by default only when the benchmark says
  they hold.
- **Role-fitness measurements** feed the King Louie profile.

## 20. Assumptions made without asking

Labelled decisions the owner can overturn:

- An empty core role borrows from the next stronger role; an empty main
  fails.
- Effort is set per profile entry.
- The migration puts the model chat uses today first in main.
- The explorer uses the worker role, not utility, and drops Bash.
- The advisor uses main.
- Delegation is prompted, not forced.
- Custom roles require a fallback core role.
- An unknown role fails the call rather than falling back.
- The King Louie picking rules and thresholds in §7.1 (ranking by agentic
  score, 0.8 and 0.5 ratios, a three-point band, three-to-one blend, 128K
  worker context).
- "Prefer local for utility" is off by default.
- Cross-provider failover only on a turn's first call.
- A case's main override is stored in `case.yaml` so unattended case turns
  follow it.
- Catalog cache under `<dataDir>/catalog/`.
- M1 to M3 land before recall H1.

## Appendix A: Research record (2026-09-27)

### A.1 What King Louie does today

- **Five model controls.** `activeProvider` and `providerModels` (Providers
  tab), `inference.activeTier` (Inference tab), `inference.tierMap` (set from
  the chat info popover), smart routing rules, and the LLM routing toggle.
  Resolution in `InferenceRouter.resolve`: provider = request, else
  `tierMap[tier].provider`, else `activeProvider`; model = request, else
  `tierMap[tier].model`, else `providerModels[provider]`. The default
  `tierMap` fills every tier, so the Providers tab's model dropdowns and "Set
  active" rarely have any effect (`src/core/settings.js:24-78`).
- **The chat info popover** writes `tierMap[activeTier]` through
  `settings:setTierProviderModel` (`settings-handlers.js:492`): a global
  change from a per-chat place. It lists 13 hardcoded providers regardless of
  keys or test results.
- **The send path** throws for any provider but OpenAI, Anthropic and Gemini
  (`chat-handlers.js:362`), although all 14 provider classes implement
  `streamMessage` and `sendMessageWithTools`.
- **`llm-router.js` is dead.** Constructed and attached in `create-core.js`,
  but `resolveLLMRouting` has no callers.
- **`inference.agentLoopModel`** (no UI) switches every iteration after the
  first, the final answer included, to another model of the same provider
  (`agent-loop.js:219-222`).
- **Case roles** (`src/cases/roles.js:10-16`) are the only task-type routing:
  orient and classify fast, draft standard, judge and verify smart, verify on
  another family.
- **Titles** use the active tier and record no usage (`chat-handlers.js:47`).
- **SpawnAgent** passes a free-form `model` and `provider`
  (`spawn-agent-tool.js:94-110`); a model without a provider keeps the tier's
  provider. Subagent costs stay inside the tool result.
- **Built-in agents** all carry `model: 'claude-sonnet-4-20250514'`; the tier
  decides in practice. `agent-schema.js` defaults `model` to `'sonnet'`, not a
  valid id. `code-explorer` is allowed `Bash` and `Read`.
- **Prices.** Two tables: each provider's `getModelPricingTable` (feeds
  per-message `costUsd`) and `src/tracking/pricing-tables.js` (feeds
  `UsageTracker`, which recomputes). Both prefix-match, so dated ids get the
  wrong row; OpenAI cached input defaults to half price
  (`base-provider.js:115`). Neither knows `gpt-5.5`.
- **Capabilities** (`inference-router.js:38-67`): Claude vision only for
  `claude-3*`; Ollama tool calling guessed from the name.
- **Connection tests** are hand-written twice: `create-core.js:1437` (OpenAI,
  Anthropic, Copilot) and `settings-handlers.js:350`.
- **Ollama** base URL is hardcoded (`ollama-provider.js:8`).
- **Stop** is wired from the button to an `AbortController`, and the agent
  loop and tools honour it, but no provider passes the signal to `fetch`.
- **Owner profile, 2026-09-27:** active provider Groq (401), standard tier
  `openai/gpt-5.5`, smart tier `anthropic/claude-sonnet-4-20250514`, smart
  routing enabled with no rules, LLM routing enabled; tests failing for Groq,
  Gemini and Mistral.

### A.2 Catalog sources compared (fetched 2026-09-27)

| Source | Coverage | Fields | Access | Notes |
|---|---|---|---|---|
| models.dev `api.json` | 223 providers, 8,170 models; all 14 King Louie providers (Ollama as Ollama Cloud only) | input, output, cache read and write, reasoning, context tiers; limits; modalities; tool call; reasoning efforts; release and knowledge dates; open weights | keyless, 4.9 MB | MIT, anomalyco/models.dev (opencode team); entries dated the previous day. 188 image-output models, many unpriced; no fal |
| OpenRouter `/api/v1/models` | 458 models | prices incl. cache; context; modalities; supported parameters; Artificial Analysis indices on 189 | keyless in practice (documented as keyed) | Only models OpenRouter serves; the one source of quality scores |
| LiteLLM `model_prices_and_context_window.json` | 4,391 entries, 134 providers | per-token prices incl. batch, flex, priority and long-context variants; capability flags | keyless, 2.9 MB | Workable fallback; heavier and keyed by LiteLLM naming |

### A.3 How Claude Code chooses models

- Subagents set `model` in frontmatter (`sonnet`, `opus`, `haiku`, a full id,
  or `inherit`); omitted means inherit. Built-in Explore and Plan inherit the
  main model. https://code.claude.com/docs/en/sub-agents.md
- `opusplan` runs Opus in plan mode and Sonnet for execution; each toggle is a
  model switch. https://code.claude.com/docs/en/model-config.md
- Each model has its own prompt cache; switching reads the whole context
  uncached once, and Claude Code asks before switching on a warm cache.
  https://code.claude.com/docs/en/prompt-caching.md
- Effort levels; on most models each effort level has its own cache.
  https://code.claude.com/docs/en/model-config.md
- `/usage` attributes cost per model.
  https://code.claude.com/docs/en/costs.md
- Which background tasks use a small model is not documented.
