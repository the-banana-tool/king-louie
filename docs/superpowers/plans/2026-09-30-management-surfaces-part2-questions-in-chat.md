# Management Surfaces, Part 2: Questions in the Chat, and the Sidebar Goes

> **For agentic workers:** implement task by task with `/tdd` at the seams named below. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** a case's question arrives as a message in the case's chat, drawn as a card — buttons for
pressed answers, "reply below" for spoken ones — and the Questions sidebar section, the case panel's
questions bar and its detours block are gone.

**Spec:** `docs/superpowers/specs/2026-09-30-management-surfaces.md` §3.4–3.5. Global Constraints and
Seams from part 1 apply.

## Seams (verified 2026-09-30 on main ccc46a7)

| Item | Where |
|---|---|
| Question creation `CaseRuntime.createQuestion`; in-app delivery `_deliver` (notifies `case:changed {what:'questions', attention}`, toast when high, `recordDelivery` channel `in-app` when `host.interactive()`) | `src/cases/case-runtime.js:1303-1322` |
| Ladder in-app adapter: `DesktopChannelPlugin` via `contact-host.js` `inAppAdapter()`; `sendContact` emits `case:changed` + toast | `src/cases/contact-host.js:79-93`, `src/channels/channel-plugin.js:175-231` |
| Messages: any extra key in `appendMessageToChat(chatId, sender, text, metadata)` lands in `meta_json` and comes back merged on read — **no schema step needed** | `src/history/chat-facade.js:29-45`, `src/history/rows.js` |
| `listChats` has no caseId filter; callers filter in JS; each chat carries `lastMessageAt`, `updatedAt` | `src/history/history-store.js:167`, e.g. `src/core/model-choices.js:170` |
| Renderer replay loop and `addMessage(sender, text, metadata)` (no generic metadata branch) | `renderer.js:3256-3300`, `renderer.js:8251+` |
| Inline prompt pattern: `showToolApprovalDialog` adds a `message assistant prompt-message` div | `renderer.js:1434` |
| Existing card code to reuse: `renderCaseQuestionCard` (2439), `caseButton` (2411), `cases.answerQuestion` / `acknowledgeBriefing` (`preload.js:858-864`, `src/ipc/case-unattended-handlers.js`) | |
| To delete: `#questions-section` (`index.html:27`), `renderQuestionsSection` (11577), `initQuestionsSection` (11654); `ensureCaseQuestionsBar` (2651), `refreshCaseQuestionsBar` (2664), `renderCaseDetourCard` (2693), `renderCaseDetoursSection` (2744) | `renderer.js` |
| Contact-policy editor (inside the Questions section, `renderer.js:11501`), away controls (`:11468`), IPC `contactPolicy:*`, `presence:*` | `src/ipc/contact-handlers.js` |
| E2E to rewrite: `tests/e2e/questions.test.js`, the `#case-questions-bar` cases in `tests/e2e/cases.test.js` (139-160) | |

---

## Task 4: A question is a message in the case's chat

**What to build:** when a case asks a question, a message appears in the case's most recently active chat
(one is created if the case has none). The renderer draws it as a card. Pressed kinds carry working
buttons; spoken kinds show their options and "Reply below". When the question is answered anywhere — the
card, the phone, a model's `answer_question`, Telegram — the card redraws as answered.

**Blocked by:** none (part 1's classifier is shared; if part 1 Task 1 has not landed, add the classifier to
`src/cases/mcp-tool-definitions.js` here and part 1 reuses it).

Design:
- Post at **creation**, once per question (`CaseRuntime.createQuestion` or the one place every question
  record is created), independent of the ladder: the chat is the first rung for everyone. The ladder's
  `in-app` rung keeps notifying (`case:changed`, toast) and recording deliveries exactly as today; it never
  posts a second message.
- The message: `sender: 'assistant'`, text a plain rendering of the question (case title, question text,
  numbered options — the model sees it in the tail and recall can find it), metadata
  `question: { caseId, questionId }`. Nothing else: state is always read from the store, never from the
  message. An `Ask` from inside a turn still posts (the turn's own reply follows it).
- Which chat: chats whose `caseId` matches, newest by `lastMessageAt ?? updatedAt`; none → create one with
  the case's title and `caseId`, through the core's chat-creation path (the same one `case:create` uses).
  No history store (tests, a host without one) → log a warning and skip; delivery must never fail
  question creation.
- Renderer: the replay loop and live `addMessage` path recognise `metadata.question` and render a card
  from the store (`case:questions` for that case), reusing `renderCaseQuestionCard`'s pieces. Pressed:
  buttons (Approve/Reject for approvals, Grant for a budget grant, Got it for a briefing, the options for
  direction/owner-task) call `cases.answerQuestion` / `acknowledgeBriefing` with `channel: 'in-app'`, no
  model involved. Spoken: options shown, "Reply below". Answered: "Answered <when> via <channel>: <answer>".
  All question strings through `textContent`, never `innerHTML`.
- On `case:changed {what:'questions'}` for a case whose question cards are on screen, re-render those cards.
- Presence: `presence:heartbeat` is sent on window focus/blur and the existing interval from a module that
  does not depend on the sidebar (it currently lives in `initQuestionsSection`).

- [ ] Runtime test: creating a question appends exactly one message with `question.questionId` to the
      newest case chat; a second delivery (resurface) appends nothing; a case with no chat gets one
      created; no history store → question still created, warning logged.
- [ ] Unit test for chat selection (newest by `lastMessageAt`, fallback `updatedAt`).
- [ ] E2E (`tests/e2e/`): a seeded case asks a pressed question → the card shows Approve/Reject → click →
      answered state; a spoken question answered through `case:answerQuestion` from outside redraws the
      card as answered.
- [ ] Covering tests pass; commit `feat(cases): questions arrive as cards in the case's chat`.

## Task 5: The sidebar goes; `set_away`; contact policy moves to Settings

**What to build:** the Questions sidebar section, the case panel's questions bar and detours block are
deleted outright (no flag). Away mode is a spoken tool, `set_away`, on every management surface. The
contact-policy editor lives at Settings > Contact.

**Blocked by:** Task 2 (part 1), Task 4.

Design:
- Delete the sidebar section and its render/init code, CSS and the panel's questions bar and detours
  block. Keep the case panel's sources/ingest, budget Grant, status and playbooks.
- `set_away({ mode: 'email-only' | 'in-app-only' | 'off', until?, quote })`: spoken (quote rules from part 1
  Task 2), writes the same policy field the away controls wrote, through the same validation
  (`validatePolicy`). Add it to the definitions module, the chat registration, stdio, and to `cases:answer`
  on the front door. Check whether service mode keeps policy in the data dir or the admin `service.json`
  `contact` block: if admin-only there, `set_away` refuses in service mode with a message saying so (and a
  test).
- Settings > Contact: move the policy editor (ladders per urgency, quiet hours, breakthrough, digest,
  channel readiness) into a Settings pane, same IPC (`contactPolicy:get/set`).
- Rewrite `tests/e2e/questions.test.js` against the chat card and Settings > Contact; drop the
  questions-bar cases from `tests/e2e/cases.test.js` or point them at the card.

- [ ] `set_away` handler tests on `in-app` (quote checked), stdio, front door (`cases:answer`).
- [ ] E2E: no `#questions-section` in the DOM; the contact-policy editor saves from Settings > Contact.
- [ ] Covering tests pass; commit `feat(app): remove the questions sidebar; set_away; contact policy in Settings`.
