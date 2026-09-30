# Management Surfaces, Part 1: One Tool Surface, the Quote, and `cases:answer`

> **For agentic workers:** implement task by task with `/tdd` at the seams named below. Each task is one
> tracer-bullet slice: definitions → handler → every surface → tests, demoable on its own. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** the owner can see and answer case questions from King Louie's own chat and from any MCP client —
`king-louie-service mcp` or a front-door client such as ChatGPT — through one tool surface, with the owner's
verbatim words recorded on every answer.

**Spec:** `docs/superpowers/specs/2026-09-30-management-surfaces.md` §3.1–3.3. ADR:
`docs/adr/0002-management-surfaces-mcp-first.md`. Terms follow `CONTEXT.md` (owner, question, spoken
answer, pressed answer, management surface).

**Parts:** part 1 (this) → part 2 (questions in the chat, sidebar removal) → part 3 (`cases:manage`, fleet
tools in chat, docs). Part 2's Task 4 does not depend on this part and may run beside it.

## Global Constraints

- Tests: `node --test tests/<file>.test.js` per task (covering files only); the full `npm test` runs once,
  in part 3's final task. Never `jest`. Look for `# fail 0`.
- Everything under `src/` stays Electron-free except `src/ipc/` (`tests/electron-boundary.test.js`).
- Log through `createLogger`; no bare `console.*` in `src/`.
- Invented fixture values only (`Lakeside lot`, `example.com`, `+15550100`).
- The tool definitions module has **no requires** (the front door loads it without the agent core) and is
  deep-frozen, like `src/cases/mcp-tool-definitions.js` today.
- **Classes.** Read tools need nothing. Spoken tools take a required `quote`. The pressed class — envelope
  and plan approvals and deltas, `budget-grant`, `budget-daily`, `direction`, `commit-failed`,
  `wakeups-failing`, `gating-pending`, owner tasks, conflict follow-ups, `ingest:review`, `failure`
  payloads, and anything with `mcpAnswerable: false` — is refused by the tool on **every** channel,
  `in-app` included, with a message naming where it is answered: "Answer this with the buttons on the
  question in the case's chat, or on your phone."
- **Never in an unattended turn.** Wake-up turns restrict tools with `allowedToolNames`
  (`src/cases/turn-runner.js`, `WAKEUP_BASE_TOOLS` in `src/cases/chat-integration.js`); the management tools
  must not be in that set, and a test pins it.

## Seams (verified 2026-09-30 on main ccc46a7)

| Item | Where |
|---|---|
| Case MCP tool definitions, `CASE_SCOPES`, `CASE_TOOL_SCOPE`, `STATUS_CHANGING`, `NEVER_OVER_MCP` | `src/cases/mcp-tool-definitions.js` |
| Handler factory `createCaseToolHandler({ getRuntime, channel, audit, log, now, rateLimit = 30 })`; `channel` must be `mcp-stdio`/`mcp-frontdoor`; `notAnswerable(q, channel)`; `answerQuestion(rt, args)` takes one of `text`/`option_id`, 60 s sliding window | `src/mcp/case-tools.js` |
| Stdio handler built with `channel: 'mcp-stdio'` | `src/fleet/start.js:106` |
| `FleetToolHandler.listTools()` / `call()`: case tool names require `options.origin.kind === 'stdio'` | `src/fleet/fleet-tools.js` |
| Front-door registration; node side `registerNodeCaseMethods` (`cases.<tool>` on `mcp-frontdoor`) | `src/frontdoor/tool-extensions.js`, `src/mcp/case-tools.js` |
| `ScopeRegistry.register(name, { tools, description, requires })`; a tool belongs to one scope | `src/frontdoor/oauth/scopes.js` |
| Per-grant limits today: `maxSessionsPerGrant` only | `src/frontdoor/mcp/http-endpoint.js` |
| `CaseRuntime.answerQuestion(caseId, questionId, { channel = 'in-app', text, optionId })`, `acknowledgeBriefing(caseId, questionId, { channel })` | `src/cases/case-runtime.js:1515`, `:1536` |
| Builtin tool registry; `registerHistoryTools(toolRegistry)` is the always-loaded pattern | `src/tools/index.js`, `src/tools/builtin/history-tools.js` |
| Always-loaded list `CORE_TOOLS` | `src/context/context-assembler.js:24-42` (also check `src/context/api-compaction.js:32`, `src/execution/safety-policy.js:14` READ_TOOLS for read tools) |
| Case tools stripped from normal chats: `shapeToolDefinitions` | `src/cases/chat-integration.js:46-58` |
| `ownerTurnText` captured raw at `src/ipc/chat-handlers.js:350`, passed to `ToolExecutor` (`create-core.js:2117`, stored `tool-executor.js:104`); **not** in a tool's execute ctx (`tool-executor.js:589-602`) | |
| Word-boundary quote check `ownerQuoteInTurn(quote, ownerTurnText)` (fold, `(^|\W)q(?=\W|$)`) | `src/tools/browser-acting.js:37-42` |

---

## Task 1: `list_questions` and `get_presence` on all three surfaces (the tracer)

**What to build:** "What's waiting on me?" is answerable in King Louie's chat, over `king-louie-service
mcp`, and from a front-door client with `cases:read`. This task sets the pattern the rest of the work
copies: one definition, three registrations.

**Blocked by:** none.

Design:
- Add `list_questions` (every open question across the caller's cases, or one case with an optional
  `case` argument: case id and title, question id, kind/type, urgency, text, options, created time, ladder
  state where known, and `answer: 'spoken' | 'pressed'` from one shared classifier) and `get_presence`
  (the presence status the ladder uses) to the definitions module, both `tier: 'read'`. Put the
  spoken/pressed classifier in the definitions module (pure) so every surface and part 2's card agree.
  Question text is case content: wrap results with the existing `untrusted(...)` envelope.
- The handler: `createCaseToolHandler` accepts `channel: 'in-app'` as a third channel.
- King Louie's chat: a builtin registration (`registerManagementTools(toolRegistry, …)` beside
  `registerHistoryTools`) that exposes every management tool under the same name and input schema, calls
  the same handler built with `channel: 'in-app'`, and is in `CORE_TOOLS` so it loads in every chat (case
  chat or not). It is **not** stripped by `shapeToolDefinitions` and **not** in the wake-up
  `allowedToolNames`. Absent a `CaseRuntime` (tests, a host without cases) the tools report "Cases are not
  available here." rather than throwing.
- Stdio: `FleetToolHandler` lists and dispatches the new tools like the existing case tools.
- Front door: `cases:read` gains `list_questions` and `get_presence`. `list_questions` fans out across
  machines the way `list_cases` does; `get_presence` takes `machine` like `open_case`.

- [x] Definitions-module test: the new tools exist, are deep-frozen, the module has no requires, and the
      classifier returns `pressed` for every kind in the Global Constraints list and `spoken` for a plain
      `Ask` question, a detour routing question and an `Ask` briefing.
- [x] Handler test (`tests/mcp-case-tools*.test.js` or its neighbour): `list_questions` on `in-app`,
      `mcp-stdio`, `mcp-frontdoor` returns the same shape; `case` narrows it.
- [x] Chat test: a normal chat's tool list contains `list_questions`; a case chat's does too; a wake-up
      turn's `allowedToolNames` does not.
- [x] Front-door test (`tests/frontdoor-*.test.js` pattern): a `cases:read` grant sees and calls both.
- [x] Covering tests pass; commit `feat(cases): list_questions and get_presence on every management surface`.

## Task 2: The quote rule, and `answer_question` from the chat

**What to build:** the owner types "go with option 2" in any chat; King Louie's model calls
`answer_question` with the owner's words as `quote`; the host checks the words are the owner's, the option
is named in them, and records a `user` fact with `channel: 'in-app'`. Pressed kinds are refused on every
channel, pointing at the card or the phone. A model-asked briefing is acknowledged through the same tool.

**Blocked by:** Task 1.

Design:
- **Prefactor:** `ownerTurnText` reaches a tool's execute context (`tool-executor.js` ctx build). It stays
  `undefined` wherever it is today (wake-ups, channels, `denyAutoApproval` turns never carry it).
- `answer_question` gains a required `quote` (string, 1–2000 chars) on every channel.
  - `in-app`: refused unless `ownerQuoteInTurn(quote, ctx.ownerTurnText)`; no owner text → refused with
    "Only the owner's own message can answer a question."
  - `mcp-stdio` / `mcp-frontdoor`: the quote is recorded, not checked.
  - With `option_id`: the chosen option's label, its id, or its 1-based position must appear in the quote
    on word boundaries (same fold as `ownerQuoteInTurn`); else refused with the options listed.
  - With `text`: the answer text recorded is the quote when `text` is omitted; when both are given, `text`
    must be contained in the quote.
- `CaseRuntime.answerQuestion` / `acknowledgeBriefing` accept `quote` and store it on the answer and the
  resulting fact; the fact stays `provenance: 'user'` with the channel recorded (check what C2/C4 already
  write and extend, do not fork).
- `notAnswerable` is replaced by the shared classifier: pressed → refused on all channels, including
  `in-app`. The existing front-door-only extra refusals are subsumed (keep a test that
  `direction`/`budget-grant`/`commit-failed`/`failure` are refused on `mcp-frontdoor`).
- A spoken briefing (an `Ask` briefing) passed to `answer_question` is acknowledged
  (`acknowledgeBriefing`) instead of refused `IS_BRIEFING`.
- A detour routing question answered here is applied the way a contact-channel answer is today (at the
  next turn start / `case:detours`); `resolve_detour` is not a tool.
- Rate limit: the in-app handler shares the 30/min window design (its own instance).

- [ ] Tool-executor test: a builtin tool's ctx carries `ownerTurnText` from the executor.
- [ ] Handler tests: missing `quote` refused on each channel; in-app quote not in owner text refused;
      in-app quote on a word boundary accepted and the fact is `user` with `channel: 'in-app'` and the
      quote; `option_id` whose label/id/position is absent from the quote refused; stdio records the quote
      unchecked; every pressed kind refused on `in-app`, `mcp-stdio`, `mcp-frontdoor` with the card/phone
      message; an `Ask` briefing is acknowledged; a detour routing question answered is applied at the
      next turn start.
- [ ] Chat test: in a non-case chat, the owner's message "the lakeside one, go with Weekly" lets the model
      (scripted via `tests/helpers/fake-llm-server.js`) answer a question in another case.
- [ ] Covering tests pass; commit `feat(cases): answer_question takes the owner's quote on every surface`.

## Task 3: `cases:answer` on the front door, with a per-grant write-rate limit

**What to build:** a ChatGPT-style client with a `cases:answer` grant answers a spoken question through
the front door; the quote is required and recorded; a flood from one grant is refused.

**Blocked by:** Task 2.

Design:
- Register `cases:answer` with tools `answer_question` (and `set_away` once part 2 Task 5 adds it — add the
  scope entry there, not here), `requires: ['cases:read']`, description "Answer open case questions in the
  owner's words. Approvals, money, direction and a case's status are never answered here."
- `answer_question` joins `CASE_TOOL_SCOPE`, so agent nodes serve `cases.answer_question` on
  `mcp-frontdoor`.
- A per-grant write-rate limit on the front door for every tool in `cases:answer` and (later)
  `cases:manage`: 30 calls per 60 s sliding window per grant id, refused with the same `rate_limited` /
  `retry_after` shape the node handler uses. It lives on the front door (it knows the grant), not the node.
- Listing `cases:write` in `frontdoor.oauth.scopes_enabled` still stops startup (nothing registers it).
- Remove the "withheld pending an owner decision (ruling T16-Q2)" comments; replace with a pointer to the
  spec §3.3.

- [ ] Scope test: `cases:answer` registers, requires `cases:read`, owns `answer_question`; `cases:write`
      still stops startup.
- [ ] Front-door harness test (`tests/helpers/frontdoor-harness.js`): a grant with `cases:read` +
      `cases:answer` answers a spoken question with a quote; the node records `channel: 'mcp-frontdoor'`;
      a pressed kind is refused; the 31st call inside a minute from one grant is refused, a second grant is
      not.
- [ ] Covering tests pass; commit `feat(frontdoor): cases:answer scope and a per-grant write-rate limit`.
