# Management surfaces: MCP-first case and fleet management — Design Spec

- **Status:** Draft (grilled 2026-09-30; owner confirmed the settled design)
- **Date:** 2026-09-30
- **Parents:** `2026-09-22-king-louie-cases-design.md` (cases), `2026-09-21-king-louie-fleet-design.md`
  (fleet). Amends `2026-09-23-cases-stage2-unattended.md` (question records, M22),
  `2026-09-23-cases-stage4-channels.md` (the in-app rung, presence, away, the Questions section),
  `2026-09-23-cases-stage7-ingest.md` §3.7–3.8 (MCP case tools, the T16-Q2 read-only front door),
  `2026-09-23-fleet-stage4-front-door.md` (scopes), `2026-09-23-fleet-stage7-desktop-ui.md`
  (`PROXIED_DOMAINS`).
- **Decision record:** `docs/adr/0002-management-surfaces-mcp-first.md`.
- **Glossary:** `CONTEXT.md` — fleet, case, owner, question, spoken answer, pressed answer, management
  surface. This spec uses those words with those meanings.

## 1. Outcome

The owner manages cases and the fleet from wherever they already are: King Louie's own chat, a paired
phone, or any MCP client with a grant — Claude Desktop, ChatGPT, a script. There is one tool surface, defined
once and served three ways (the front door, `king-louie-service mcp`, and King Louie's chat tools), so the
app's chat is a client of the same tools ChatGPT gets and the app is never the only place something can be
done. A case's question arrives in the case's chat as a message and can be answered there in words; the
things that must not go through a model — approvals, money, direction, a case's status — are buttons in
that message or a signature from the phone, and nothing else. The Questions section of the sidebar is gone.

## 2. Scope

### 2.1 In

- The management tool surface (§3.1): definitions, three registrations, per-channel refusals.
- Owner identity and the `quote` (§3.2): host-verified in the app, recorded over MCP, `user` provenance
  with the channel recorded.
- Front-door scopes `cases:answer` and `cases:manage` (§3.3); a per-grant call-rate limit.
- Questions delivered into the case's chat (§3.4): the `in-app` rung posts a message with a `question`
  payload; the renderer draws it as a card; spoken answers go through `answer_question`; pressed answers
  through the card's buttons or the phone.
- Removal of the Questions sidebar section and the per-chat panel's questions bar and detours block; new
  homes for presence, away mode and the contact-policy editor (§3.5).
- Fleet tools in the desktop chat, proxied to the service in attached mode (§3.6).
- CLAUDE.md, the stage specs' "as built" notes and the tests that describe the old surface.

### 2.2 Out

| Item | Why |
|---|---|
| Ingest over MCP (`add_source`, review) | `NEVER_OVER_MCP` stands; a 47 MB PDF is not a tool call, and review is accepting facts (stage 7 §3.7) |
| Budget grants over MCP or in prose | pressed class (§3.1); the case panel's Grant button and the phone stay |
| Playbook attach, update, propose over MCP | app-side; only `list_playbooks` is served |
| `add_relation` | no owner need named; `CaseRuntime.addRelation` stays IPC-only |
| Retiring or shrinking the desktop bridge | it stays as a value-add; MCP is an additional surface |
| Anything new for mobile on a standalone desktop | ntfy and Telegram/Discord are the rung; pressed answers on a phone need the service and the paired app |
| Settings (profiles, permission rules, channels, contact policy) over MCP | configuration, not management; several are admin-only on a service |
| A transition flag for the sidebar section | removed outright, tests rewritten |

## 3. Design

### 3.1 One tool surface

The management tools are defined in one dependency-free module, the way `src/cases/mcp-tool-definitions.js`
and `src/fleet/tool-definitions.js` are today (frozen; no `require`s, because the front door loads it
without the agent core). Three registrations read the same definitions:

1. **Front door** (`src/frontdoor/tool-extensions.js`): each tool behind the scope in §3.3, served by the
   agent node as a `cases.<tool>` link method on the `mcp-frontdoor` channel.
2. **`king-louie-service mcp`** (`src/mcp/stdio-server.js` through `FleetToolHandler`): channel
   `mcp-stdio`, as the four case tools are today.
3. **King Louie's chat** (`src/tools/builtin/`): the same names and schemas, always loaded like
   `SearchHistory`, in every chat, acting on any case (an owner act is not confined to the chat's own
   case), channel `in-app`. **Never loaded in an unattended turn**: a wake-up's judge loop stays confined to
   the case tools plus Read, Glob and Grep, so a case can never answer its own question, and with no owner
   message there is no quote to verify anyway.

The tools and their classes:

| Tool | Class | Notes |
|---|---|---|
| `list_cases`, `open_case`, `get_orientation` | read | exist |
| `list_questions` | read | every open question across the caller's cases, with kind, options, urgency, ladder state and whether it is spoken or pressed |
| `list_envelopes`, `list_playbooks`, `get_presence` | read | the first two mirror IPC the renderer never called |
| `answer_question` | spoken | exists; gains `quote` (§3.2). A detour's routing question is a question: `resolve_detour` is not a separate tool. A briefing a model asked (`Ask`) is acknowledged through it too |
| `create_case` | spoken | the quote is the owner's objective. Honours the similar-case refusal; `force` never comes from a client, so a `SIMILAR_CASES` refusal from ChatGPT means "open the app" |
| `revoke_envelope`, `cancel_case_job` | spoken | both only reduce what the case may do. Not `cancel_job`: that name is the fleet tool's, and a tool belongs to one scope |
| `set_away` | spoken | `email-only` / `in-app-only` until a time, as the sidebar's away controls did |
| — | pressed | envelope and plan approvals (and deltas), budget grants, `budget-daily`, `direction`, `commit-failed`, `wakeups-failing`, `gating-pending`, owner tasks, conflict follow-ups, ingest reviews, and **a case's status** (pause, resume, close). No tool; refused over every `mcp-*` channel; answered by a button in the chat card or a phone signature |

Fleet tools (`list_machines`, `describe_machine`, `get_state`, `run_runbook`, `delegate`, `send_to_job`,
`get_job`, `get_job_logs`, `cancel_job`) already exist with their scopes and are unchanged. An unsafe
runbook or tool call started from any client still waits for the phone (M19 stands); the push that asks
for the signature is the mobile half of this design.

The front door's existing line (ruling T16-Q2) stays as the pressed class: `STATUS_CHANGING`
(`direction`, `budget-grant`, `commit-failed`), `failure` payloads, approvals, briefings of those kinds and
`ingest:review` are refused there, and on `mcp-stdio`, and — because the in-app tool is the same code —
`answer_question` from the chat refuses them too, pointing at the card's buttons. What changes is that the
front door now serves the spoken class at all.

### 3.2 The owner and the quote

A grant is the owner. Every spoken tool takes a required `quote`: the owner's own words, verbatim.

- **In the app** the host verifies the quote against the owner's turn text (`ownerTurnText`, set only by
  the local chat send path, case chat or not). The check is the browser `ownerQuote` gate's: the quote must
  appear on word boundaries after folding — stricter than the Ledger's substring `requireOwnerQuote`, which
  is left as it is. A quote that does not appear refuses the call. `ownerTurnText` is not in a tool's
  execute context today; it has to be. `denyAutoApproval` turns never
  carry owner text, so the tools cannot succeed there.
- **Over the front door and `mcp-stdio`** there is no owner text; the quote is a recorded claim. It is
  still required: a client that cannot produce the owner's words is not relaying an owner.
- **The fact** an answer writes is `provenance: 'user'` on every channel, and counts wherever a `user`
  fact counts — including the outbound gate's rule 3 — with `channel` recorded (`in-app`,
  `mcp-frontdoor`, `mcp-stdio`, or a contact channel) so an audit can tell a host-checked quote from a
  claimed one. This is the same standing a Telegram DM from the owner's id already has; an OAuth grant is
  stronger.
- **Options.** For a question with options, the quote proves the words and the model picks the option, so
  the host also requires the quote to name the chosen option (owner decision, 2026-09-30). An option is
  named by its label, on word boundaries after the same fold, or by its 1-based number only when the number
  stands alone (the whole quote, trailing punctuation ignored: "2", "2.") or is marked ("option 2",
  "number 2", "no. 2", "#2"); "wait 1 week", "12", "1.5" and "2,1" name nothing. The option's id never
  counts. A label found only inside another named option's label does not count on its own. A quote that
  names more than one option is refused (`option_ambiguous`), and one that names none or another option is
  refused (`option_not_in_quote`); both list the options as wrapped data so the model asks the owner which
  one they meant. A free-text answer records the quote itself as the answer.

### 3.3 Scopes and rate

`cases:write` is retired without ever having been registered. Two scopes replace it, mirroring the fleet's
`read`/`run`/`delegate`/`unsafe` split so the OAuth consent screen — the only place an owner sees the
difference — shows what a connector may do:

| Scope | Tools | Requires |
|---|---|---|
| `cases:read` | `list_cases`, `open_case`, `get_orientation`, `list_questions`, `list_envelopes`, `list_playbooks`, `get_presence` | — |
| `cases:answer` | `answer_question`, `set_away` | `cases:read` |
| `cases:manage` | `create_case`, `revoke_envelope`, `cancel_case_job` | `cases:read` |

The stage 7 spec made a per-grant call-rate limit on the front door the precondition for serving
`answer_question` there; the endpoint has `maxSessionsPerGrant` only. This spec keeps the precondition: a
per-grant limit on write calls (the stdio handler's 30 per minute is the reference) lands with, not after,
`cases:answer`.

### 3.4 Questions live in the chat

The `in-app` rung of the contact ladder stops rendering a sidebar card and posts a message instead.

- **Which chat.** The case's most recently active chat (the chats carrying its `caseId`, by last message);
  if the case has none — a wake-up turn on a case created elsewhere, or over MCP — one is created for it.
- **What message.** An assistant message with a `question` payload: the question id, case id, kind,
  urgency, options, whether it is spoken or pressed, and its state. It is an ordinary history row: it has a
  `seq`, sits in the tail, and recall can find it later ("what did I decide about the lot last week" is a
  recall question now). The private text a question carries is the owner's own chat, as the sidebar card's
  was.
- **How it renders.** A card. A spoken question shows its options and "reply below"; a pressed one shows
  its buttons (Approve/Reject, Grant, Got it — the inline tool-approval pattern the chat already uses, no
  model between the click and `CaseRuntime.answerQuestion`, channel `in-app`). The card redraws as
  answered when the store says so, whichever surface answered it, so an answer from the phone shows in the
  chat. The renderer reads the payload's state from the store, never from the message text.
- **How a spoken reply is applied.** The owner types under the card; the next model turn sees the card in
  its tail and the reply, and calls `answer_question` with the quote. The host does not parse replies. If a
  turn is already running the reply waits for it: one turn late at worst, and pressed kinds have buttons
  that do not wait.
- **Ladder and presence unchanged.** `in-app` keeps its place in every ladder, its resurfacing rule, and
  `APP_ANSWER_CHANNELS`; delivery records are written as today. Presence is reported silently from window
  focus; the heartbeat no longer needs the sidebar.

### 3.5 What leaves the app, and where the rest goes

- **Removed:** the Questions sidebar section (`#questions-section`, `renderQuestionsSection`,
  `initQuestionsSection`, the per-card answer box), and in the per-chat case panel the questions bar and
  the detours block — both now duplicate the chat card. Their e2e tests are rewritten against the chat.
- **Kept in the case panel:** sources and ingest, the budget Grant button, status, playbook attach and
  propose — the file-and-money acts that have no chat equivalent by design.
- **Moved:** the contact-policy editor (ladders per urgency, quiet hours, breakthrough, digest, channel
  readiness) to Settings > Contact. Away mode becomes `set_away`.
- **IPC:** `case:questions`, `case:answerQuestion` and `case:acknowledgeBriefing` stay for the cards'
  buttons and state; `contactPolicy:*` moves with the editor; `presence:heartbeat` is sent from focus
  changes. `case:envelopes`, `case:cancelJob` and `case:revokeEnvelope` get tools (§3.1) instead of a UI.

### 3.6 Fleet from the desktop chat

Standalone there is no fleet and the fleet tools are absent. Attached, the service runs the whole turn
(the desktop builds no core and forwards `chat:sendMessage` over the bridge), so the chat's fleet tools run
where the turn runs — in the service, against its own `FleetToolHandler` — and the bridge needs no new
proxied domain. The same holds for a service chat reached through Telegram or Discord. An unsafe runbook
still needs the phone.

### 3.7 Rulings this spec changes

| Ruling | Before | Now |
|---|---|---|
| T16-Q2 (stage 7 §3.8) | front door read-only; `cases:write` withheld | spoken class served under `cases:answer` / `cases:manage`; the pressed line kept |
| M22 (stage 4) | app-only questions answered in the sidebar or on the phone | answered by the chat card's buttons or on the phone; the sidebar is gone |
| Stage 4 §in-app rung | a sidebar card | a chat message with a `question` payload |
| Stage 7 §3.7 | `answer_question` records text or option only | requires `quote`; option must appear in it |

## 4. Tests

- The tool definitions module has no requires and is deep-frozen (the existing `mcp-tool-definitions`
  tests extend).
- Each spoken tool: refused without `quote`; in-app refused when the quote is not in `ownerTurnText`;
  option answers refused when the option is not in the quote; the written fact is `user` with the channel.
- Pressed kinds refused on `in-app`, `mcp-stdio` and `mcp-frontdoor` with the "use the card / the phone"
  message; the card's button path still answers them.
- Unattended turns: the management tools are not in the tool list.
- Front door: `cases:answer` and `cases:manage` register; listing `cases:write` stops startup as before;
  the per-grant write-rate limit refuses the 31st call.
- Chat delivery: a question posts one message in the case's newest chat, creates a chat when none exists,
  and the card's state follows an answer from another channel (`tests/e2e/`, replacing the sidebar tests).
- Attached: fleet tools reach the service through the bridge; an unsafe runbook waits for the phone.

## 5. Open questions

None from the grilling. Things an implementer must check rather than assume: the exact history-row shape a
`question` payload takes (an attachment or message metadata — whichever `src/history/` already supports
without a schema step, else a new `SCHEMA_STEPS` entry); whether `DesktopChannelPlugin`'s `send` is the
right seam for posting into a chat or the in-app adapter needs its own; and how `ownerTurnText` reaches a
tool call made from a non-case chat.
