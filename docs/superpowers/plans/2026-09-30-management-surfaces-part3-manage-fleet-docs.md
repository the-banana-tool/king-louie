# Management Surfaces, Part 3: `cases:manage`, Fleet Tools in the Chat, and Close-out

> **For agentic workers:** implement task by task with `/tdd` at the seams named below. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** cases can be created and wound down (envelopes revoked, jobs cancelled) from any management
surface; a service-run chat can drive the fleet; the docs describe what was built and the full suites pass.

**Spec:** `docs/superpowers/specs/2026-09-30-management-surfaces.md` §3.1, §3.3, §3.6, §3.7. Global
Constraints and Seams from part 1 apply.

## Seams (verified 2026-09-30 on main ccc46a7)

| Item | Where |
|---|---|
| `CaseRuntime.createCase` refuses a similar open case (`SimilarCaseError`, `code: 'SIMILAR_CASES'`) unless `force: true` | `src/cases/case-runtime.js` |
| Envelope/job IPC the renderer never calls: `case:envelopes`, `case:cancelJob`, `case:revokeEnvelope` | `src/ipc/executor-handlers.js`, `preload.js:694-711` |
| Playbook listing | `src/cases/playbooks/` |
| Fleet tool definitions and scopes; `FleetToolHandler` | `src/fleet/tool-definitions.js`, `src/fleet/scope-rules.js`, `src/fleet/fleet-tools.js` |
| Unsafe gating by origin: `shouldRefuseUnsafe` (stdio → phone; any other kind fails closed) | `src/fleet/delegate-sessions.js` |
| Attached mode: the desktop builds no core; `chat:sendMessage` runs in the service (`src/ipc/attached-host.js`) — fleet tools in a chat run where the turn runs | |

---

## Task 6: `cases:manage` — `create_case`, `revoke_envelope`, `cancel_case_job`, `list_envelopes`, `list_playbooks`

**What to build:** "start a case for selling the boat" from ChatGPT or the chat creates a case; revoking
an envelope or cancelling a case's job works from any management surface; envelopes and playbooks can be
listed.

**Blocked by:** Task 3 (part 1).

Design:
- Read (in `cases:read`): `list_envelopes({ case })`, `list_playbooks({ case })`.
- Spoken (quote rules from part 1 Task 2), in a new front-door scope `cases:manage` (requires `cases:read`,
  description "Create cases, revoke a case's envelopes and cancel its jobs, in the owner's words."):
  - `create_case({ title, objective, type?, quote })`: the quote must contain the objective (in-app:
    host-checked; MCP: recorded). The objective is written as the owner's (user provenance, quote
    recorded) the way the app's case creation writes it. `force` is not an argument; a `SIMILAR_CASES`
    refusal returns the similar cases and "Open the app to create it anyway."
  - `revoke_envelope({ case, envelope, quote })`, `cancel_case_job({ case, job, quote })`: the same
    runtime paths the IPC channels use. Not `cancel_job` — that is the fleet tool.
- Covered by the part 1 per-grant write-rate limit on the front door.
- Every tool on all three surfaces, absent from wake-up turns.

- [x] Handler tests per tool on `in-app` / stdio / front door; `create_case` similar-case refusal carries
      no way to force; a quote missing the objective is refused in-app.
- [x] Front-door test: `cases:manage` registers, requires `cases:read`; a `cases:answer`-only grant cannot
      call `create_case`.
- [x] Covering tests pass; commit `feat(cases): cases:manage — create cases, revoke envelopes, cancel case jobs`.

## Task 7: Fleet tools in the chat

**What to build:** in a chat that runs in the service (an attached desktop, or a channel chat), the model
can call the fleet tools — `list_machines`, `describe_machine`, `get_state`, `run_runbook`, `delegate`,
`send_to_job`, `get_job`, `get_job_logs`, `cancel_job`. Standalone there are none. An unsafe runbook waits
for the phone.

**Blocked by:** Task 1 (part 1).

Design:
- Register the fleet tools as chat tools when the core has a fleet handler (service mode); absent
  otherwise, and absent from wake-up turns.
- Calls go through `FleetToolHandler.call` with a new origin kind for the service's own chat. It is a local
  session the node started itself, so `shouldRefuseUnsafe` treats it like `stdio` (unsafe goes to the
  phone, never runs unsigned). Extend `shouldRefuseUnsafe` explicitly for the new kind; every other kind
  still fails closed.
- Fleet tool approvals in the chat follow the usual tool-approval rules; the phone signature is additional,
  not a replacement.

- [ ] Test: a standalone core's chat tool list has no fleet tools; a service core's does; wake-ups have
      none.
- [ ] Test: an unsafe `run_runbook` from the chat origin goes to the approval requester (fake phone) and
      runs only on `=== true`; an unknown origin kind is still refused.
- [ ] Covering tests pass; commit `feat(fleet): fleet tools in a service-run chat`.

## Task 8: Docs and the full suite

**What to build:** the docs say what was built; everything is green.

**Blocked by:** Tasks 5, 6, 7.

- [ ] CLAUDE.md: replace the "withheld pending an owner decision" / `cases:write` lines (Cases stage 7
      section) with `cases:answer` / `cases:manage`; describe the management tool surface (one definition,
      three registrations, never in wake-ups, the quote rule, pressed vs spoken); questions as chat cards;
      no Questions sidebar; `set_away`; Settings > Contact; fleet tools in service chats. Keep the file's
      terse style.
- [ ] The stage 7 spec §3.8 "As built" note and the stage program §4.14/§4.19 point at the new spec.
- [ ] Spec status: "Built" with the commit range.
- [ ] `npm test` → `# fail 0`; `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` → `# fail 0`.
- [ ] Commit `docs: management surfaces as built`.
