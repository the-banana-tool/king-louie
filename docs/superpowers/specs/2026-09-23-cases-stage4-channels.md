# Cases Stage 4: Channels, presence and the contact ladder — Design Spec

- **Status:** Draft (fix round 1)
- **Date:** 2026-09-23
- **Parent:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` §8 (this stage), §5.4, §4.3
  `materiality`, §9.1, §12 row 4, §13, §14, §15
- **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. Owns §4.22 (contact channels, owner
  proof R43, mobile adapter R44) and `QuestionStore.recordDelivery` (§4.3). Consumes §4.3, §4.9 (outbound
  gate, `rendered`), §4.13 (F3 E2/E4/E5, Mailbox), §4.20 (`systemAction`, `host.interactive()` R50). C4
  charges no budget (§4.4). Ruling 1; R38, R39, R43, R44, R50.
- **Depends on:** C2 (merged). C3 for `outboundGate` (until C3 merges, `sendExternal` refuses every
  non-owner target). F3 only for the mobile adapter (§3.9, wave 3).

## 1. Outcome

When a case asks a question, needs an approval or has a briefing, the owner is reached where they are, once.
At the desktop, it shows there. Away, it goes to Telegram, then email, or, for `high` urgency, SMS and then
a voice call, each after a delay the owner set. Items due together arrive as one message per channel. A
reply on a configured channel answers the question as a `user` fact, but only when the channel proves the
reply came from the owner; everyone else is ignored. Quiet hours, an away mode and a daily digest keep the
owner from being pestered. If every channel fails, the case journals that and keeps the question open. It
does not guess.

## 2. Scope

### 2.1 In

- Contact extension to `ChannelPlugin` (§3.1): Telegram, Discord and the in-app (desktop) plugin implement
  it; ntfy is delivery-only.
- New adapters: email (HTTP relay or IMAP/SMTP), SMS and voice through a telephony relay, and the mobile app
  (wave 3, R44).
- `src/cases/presence.js`, `src/cases/ladder.js`, `src/cases/contact.js` (batching, correlation, owner
  proof, reply handling, the outbound chokepoint `sendExternal`), `src/cases/contact-host.js` (wiring).
- `QuestionStore.recordDelivery` (C4-owned, program §4.3).
- Settings `contactPolicy`, `contact.*`, `channels.{email,sms,voice,ntfy,mobile}`, `contactEnabled` and
  `contactOwnerUserId` on `channels.telegram|discord`; the admin `service.json` `contact` block.
- IPC `contact:ladderState`, `contactPolicy:get`, `contactPolicy:set`, `presence:heartbeat`,
  `presence:status`; renderer `renderQuestionsSection`. The cross-case list reuses C2's `case:questions`.
- Regression fixture F2-late.

### 2.2 Out

| Item | Owner |
|---|---|
| Question store, `Ask`, `case:answerQuestion`, `expire()` / `defaultOnSilence` | C2 |
| Whether a wake-up contacts the owner (materiality, parent §5.4) | C2; the ladder delivers every open record |
| Envelope approvals as `kind: approval` records; `outboundGate`; `revokeEnvelope` | C3 |
| Phone API, relay, push, Mailbox, device enrollment, `verifyDeviceEnvelope` | F3 |
| `answer_question` over MCP | C7 |
| Slack as a contact channel; in-app voice | Deferred (§13) |

## 3. Design

```
 case repos (.kl/questions/*.json, C2)          <dataDir>/contact/  (C4, owner-global)
          │  scan every tick                      ladder.json  deliveries.json  presence.json  inbox.jsonl
          ▼
   LadderEngine ──due items──▶ ContactRouter.deliver(channel, items) ──▶ adapter.sendContact()
        ▲  ▲                         │ batching, tokens                        │
        │  └──── Presence ◀──────────┤ owner-proven inbound, heartbeats        │
        │                            ▼                                         ▼
        └── outcome ◀── ContactRouter.handleReply() ◀── adapter.onContactReply()   owner
                              ▼
                 CaseRuntime.answerQuestion()  (C2)  → QuestionStore.answer → `user` fact
```

### 3.1 Contact extension to `ChannelPlugin`

The parent's `send`/`capabilities()` collide with `ChannelPlugin.send(target, message, options)` and the
constructor's `capabilities` array, so the contact methods get distinct names (D1). Defaults in
`src/channels/channel-plugin.js` make a plugin inert:

```js
contactCapabilities()            // default null → not a contact channel
  → { buttons, richText, attachments, voice, expectsReplies,
      authenticatedReplies,      // a reply proves the owner (may answer kind: approval)
      interrupts,                // subject to quiet hours
      maxOptions, maxChars }
async sendContact(message, meta) → { deliveryId, externalRef }   // default throws ContactUnsupportedError
onContactReply(handler)          // handler(correlationId, answer, meta); default no-op
presence() → { lastSeen, active } | null                         // default null
ownerTarget() → string | null    // a private chat/DM or address of the owner; null = not configured
```

| Field | Rules |
|---|---|
| `message.subject` | one line, e.g. `King Louie: 2 questions (1 high)` |
| `message.text` | plain-text rendering of the batch (§3.5), already `rendered` |
| `message.items[]` | `{ n, token, caseTitle, kind, text, options[], urgency, answerable }`; `answerable` is false where this channel may not answer the item (approvals on unauthenticated channels) |
| `meta` | `{ expectsReply, options (single-item batches), deliveryId, batchToken, expiresAt, urgency }` |

`answer` is `{ optionId }` or `{ text }`; reply `meta` is `{ channel, senderId, chatId, at, ownerProven,
deliveryRef?, itemNumber? }`. The adapter passes the question token when it knows it (button, `#TOKEN`),
else the batch token or `deliveryId` with the raw text, which the router parses (§3.5). `sendContact`
failure throws `ContactDeliveryError(code, message)`, `code ∈ not-configured | rejected | unreachable |
too-large | rate-limited`; never a partial result.

| Contact id | Module | Buttons | Replies | `authenticatedReplies` | Interrupts | Owner target |
|---|---|---|---|---|---|---|
| `in-app` | `DesktopChannelPlugin` (plugin id `desktop`) | yes | yes | yes | no | the window |
| `telegram` | `telegram-bridge.js` | inline keyboard | yes | yes | yes | private chat with the contact owner |
| `discord` | `discord-bridge.js` | `ButtonBuilder` | yes | yes | yes | DM with the contact owner |
| `email` | `src/channels/email-channel.js` | no | yes | no | no | `contact.email.owner` |
| `sms` | `src/channels/telephony-channel.js` | no | yes | no | yes | `contact.sms.owner` |
| `voice` | `src/channels/telephony-channel.js` | DTMF | options only | no | yes | `contact.voice.owner` |
| `ntfy` | `src/channels/ntfy-contact.js` | no | no | — | yes | none (delivery only; never an owner target) |
| `mobile` | `src/channels/mobile-app-channel.js` (wave 3) | yes | yes | yes (device-signed) | yes | enrolled devices |

**Owner proof (R43), Telegram and Discord.** The contact target is a private chat (Telegram `chat.type ===
'private'`, chat id = the owner's user id) or a DM channel (Discord, opened with
`users.fetch(ownerUserId).createDM()`) with the contact owner id: desktop
`channels.<ch>.contactOwnerUserId`; service mode admin `service.json` `contact.<ch>.ownerUserId` (data-dir
values ignored with a `warn`). Every contact inbound (button press, reply to a contact message, `#TOKEN`
message) is owner-proven only when **`chat === contact target` AND sender `=== contactOwnerUserId`**; the
allowlist alone never suffices, so a group member or a second allowlisted user is refused. `approvalChatId`
is not used for contact.

**Telegram.** `sendContact` sends `message.text` to the contact target, one inline-keyboard row per
answerable item with ≤ 8 options, `callback_data = kl_q_<token>_<optionIndex>` (≤ 17 bytes).
`handleCallbackQuery` checks `kl_q_` before `kl_a_`. `handleMessage`, before the allowlist check and
`shouldRespond`, hands a message to the router when it is in the contact target and is a `reply_to_message`
to a contact delivery or starts with `#<token>`; those never reach `routeAgentMessage`. Owner-proven inbound
calls `presence.noteInbound('telegram')`. `externalRef` = the sent `message_id`. `TelegramBridge` takes
`apiBase` as a constructor option (tests point it at a fake Bot API).

**Discord.** The same flow in the DM, `customId = kl_q_<token>_<i>`, reply reference
`message.reference.messageId`.

**Slack: excluded.** `SlackChannel` has no allowlist and calls a nonexistent `gateway.routeInbound`. Naming
`slack` in a ladder fails validation: `slack is not a contact channel: it has no sender allowlist`.

**In-app.** `contact-host` constructs `new DesktopChannelPlugin({ sendToUi: host.notify })` only when
`host.interactive()` is true at start (R50), and maps contact id `in-app` to it. C2's `QuestionStore.create`
already notifies in-app and records `{ channel: 'in-app', deliveryId: 'in-app-<qid>' }` when interactive, so
an `in-app` step on such a record is `sent` without sending. `sendContact` is used only to **re-surface**:
when the record's in-app delivery `at` precedes the latest desktop-present transition (§3.4), it calls
`host.notify('case:changed', { caseId, what: 'questions', questionId, attention: 'banner' })` per item and,
when the window is unfocused, `host.uiToast.send({ title: subject, body: 'Open King Louie to answer' })`.
Answers arrive through C2's `case:answerQuestion`. With no interactive host it throws `not-configured`.

**ntfy.** Delivery only, wrapping `NtfyChannel` (its SSRF guard kept). It sends `message.subject` and `Open
King Louie to answer.`; question text only when `channels.ntfy.includeText` is true (a topic is readable by
anyone who knows its name). ntfy is never an owner target for `sendExternal`.

### 3.2 Email adapter — `src/channels/email-channel.js`

`class EmailChannel extends ChannelPlugin` (id `email`), pluggable transport:

```js
transport.send({ to, from, subject, text, headers }) → { messageId }
transport.poll() → [{ kind: 'reply', from, subject, text, inReplyTo, references[], authResultsTop? }
                  | { kind: 'bounce', originalMessageId, status, diagnostic }]
transport.close()
```

- **`relay`** (default): the relay contract (§4.5), `channel: 'email'`; the relay reports `auth: { verified,
  method }`.
- **`imap-smtp`**: `nodemailer` sends; `imapflow` + `mailparser` poll the King Louie mailbox's INBOX every
  `contact.email.imap.pollSec` (60) for UNSEEN messages, marked seen after handling. `imapflow` is
  constructed with `logger: false`. A `multipart/report; report-type=delivery-status` referencing a sent
  `Message-ID` becomes `bounce`. Only the **topmost** `Authentication-Results` header counts
  (`authResultsTop`); it passes when its `authserv-id` equals `contact.email.imap.trustedAuthServId` and it
  shows `dmarc=pass`, or `spf=pass` aligned with the From domain.

On send the subject is `<subject> [KL-<batchToken>]`, `Message-ID` `<kl-<deliveryId>@<from-domain>>`,
`externalRef` = that Message-ID. A reply is accepted only when (1) `From` (address, lowercased) equals
`contact.email.owner`; (2) it names a live batch: `In-Reply-To`/`References` or the subject carries
`[KL-<batchToken>]`; and (3) it is authenticated (relay `auth.verified` or the topmost-header rule) **or**
the `[KL-<batchToken>]` token is present in the subject or the unquoted body. There is no switch that turns
this off. Quoted history (`>` lines, everything after `On … wrote:`) is stripped first. A failing reply is
logged and dropped; nothing goes back to a spoofed sender. Email never answers `kind: approval`.

### 3.3 SMS and voice — `src/channels/telephony-channel.js`

Two instances, ids `sms` and `voice`, over `src/channels/relay-client.js` (shared with email). Inbound
`from` is normalized to E.164 (`normalizeRecipient`, C3) before comparing with the owner number.

- **SMS** sends `message.text` capped at `maxChars` (1200; the relay segments). **Every reply must carry a
  token** (R43): `#<batchToken> 2 a`, `#<batchToken> a` (single-item batch), or `#<questionToken> <answer>`.
  A reply from the owner number without a token is not applied; the router acks to the owner number `Add the
  code from the message, e.g. "#K7QD4M 1 a".` Tokens are unguessable (§4.2), so a spoofed sender id alone
  cannot answer.
- **Voice** asks the relay to call the owner number; per item it says `Question n from <caseTitle>. <text>`
  and, for 1–9 options, `Press 1 for <label>, …`, gathering one digit (`gathered` event). Items without
  options end `Answer this one in King Louie or by text.` Busy and no-answer are failures.

Neither answers `kind: approval`; approvals go out as `Approval needed in <case>: <intent>. Answer in King
Louie or <first authenticated channel>.`

### 3.4 Presence — `src/cases/presence.js`

```js
class Presence({ file, getPolicy, clock = () => new Date() })
heartbeat({ focused, lastInputAt })        // desktop IPC; lastInputAt clamped to ≤ now; in memory only
mobileForeground({ deviceId, foreground }) // wave 3, from the `presence.foreground` link method
noteInbound(channelId, at = now)           // owner-proven inbound only; persisted
status(now) → { presentChannel, away, quiet, timeZoneSource, signals: { desktop, mobile, channels } }
presentChannel(now) → channelId | null
desktopPresentSince() → Date | null        // latest absent→present transition of the desktop
inQuietHours(now) → boolean;  nextQuietEnd(now) → Date
```

Only per-channel last-seen times persist (`<dataDir>/contact/presence.json`); desktop and mobile signals are
volatile.

| # | Condition | Result |
|---|---|---|
| 1 | `away.until > now`, mode `email-only` | `email` if enabled, else `null` |
| 2 | `away.until > now`, mode `in-app-only` | `in-app` if interactive, else `null` |
| 3 | Candidates: **desktop** if the last heartbeat is ≤ 90 s old, `focused`, `lastInputAt` ≤ `desktopIdleMin` (5) ago; **mobile** if a foreground ping is ≤ 120 s old; **channel X** if enabled with owner-proven inbound ≤ `recentInboundMin` (10) ago | — |
| 4 | No candidates | `null` |
| 5 | Otherwise | the most recent activity (desktop `lastInputAt`, mobile ping, channel last-seen); ties: desktop, mobile, ladder order |

One present channel, never two. **Time zone:** C2's `settings.cases.timeZone`; empty → the host zone, logged
once, `timeZoneSource: 'host'`. All wall-clock math uses `Intl.DateTimeFormat(…, { timeZone })`. **Quiet
hours** `{ start, end }` wall time; `start > end` spans midnight (`t >= start || t < end`).
`nextQuietEnd(now)` steps whole minutes (≤ 26 h) to the first instant whose wall time is ≥ `end` and outside
the window: an `end` in a spring-forward gap resolves to the first existing minute after it; in a fall-back
repeat, the first occurrence, and a deferred item is not deferred again on the repeat.

### 3.5 Contact router — `src/cases/contact.js`

```js
class ContactRouter({ dir, runtime, adapters, presence, getGate, clock, log })
async deliver(channelId, entries) → { deliveryId, externalRef }         // throws ContactDeliveryError
async handleReply(channelId, correlationId, answer, meta) → { ok, outcome, ackText | null }
async ingestRelayEvents(relayName, events) → { applied, skipped }       // poll and webhook push
async sendExternal({ caseId, channelId, target, text, envelope }) → { ok, deliveryId } | { ok: false, error, blocked? }
async drainInbox()                                                      // answers queued behind a busy case
isOwnerTarget(channelId, target) → boolean
```

**Batching.** `deliver` takes every entry due on one channel in one tick, across cases, sorted high first
then by `createdAt`, numbered 1..n, into one message with one `batchToken`:

```
King Louie: 2 questions (1 high)

1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?
   a) No   b) Yes, up to 20 %
2. Kitchen quotes — Which week suits the site visit?
   a) Oct 5   b) Oct 12

Reply "#K7QD4M 1 a" / "#K7QD4M 2 b". Expires: 1) Sep 25 18:00.
```

Items over `maxChars` are cut to 280 characters plus `(open King Louie for the full text)`. One
`deliveries.json` entry per batch (§4.3).

**Correlation.** Every token (question and batch) resolves through `deliveries.json`, so a late reply after
the ladder entry retired still finds its question. Tokens are unique across `ladder.json` and
`deliveries.json`, and are not reused until the delivery entry is pruned.

**`parseReply(batch, text)`** (pure): a button, DTMF or callback with token and option index → that item;
`#<questionToken> <rest>` → that item; `#<batchToken> <n> <rest>` lines → one answer per item;
`#<batchToken> <rest>` on a single-item batch → item 1; anything else → not parsed, ack `Which question?
Reply "#<batch> <n> <answer>".` `<rest>` is an option when it equals an option `id` or `label`
(case-insensitive, trimmed, trailing punctuation dropped), else `{ text }`. Telegram, Discord and email may
omit the token when the reply threads to the delivery (the thread is the correlation); SMS may not.

**Handling an answer** for `(caseId, qid)`:

1. `meta.ownerProven` must be true (set by the adapter only after §3.1–3.3 checks), else `refused:
   not-owner`, logged at `warn` with channel and sender id, no ack.
2. `kind === 'approval'` on a channel without `authenticatedReplies` → ack `Approvals can't be answered by
   <channel>. Use King Louie or <channel>.`
3. `presence.noteInbound(channel)`.
4. **Open record** (`answer === null`, including an expired `hold` question) → `runtime.answerQuestion(
   caseId, qid, { channel, text, optionId })`. `ALREADY_ANSWERED` goes to 5/6 with the stored record.
   `CaseBusyError` → append to `inbox.jsonl`, ack `Received — recording it after the current step`. Success
   → ack `Recorded for <caseTitle>.`, ladder entry retired.
5. **Answered, same answer** → ack `Already recorded.`
6. **Answered, different answer** → never overwrite. Inside `runtime.systemAction(caseId, 'contact: conflict
   <qid>', …)` create through `QuestionStore.create` a follow-up with the original `kind` and urgency,
   `payload: { type: 'conflict', conflictOf: qid, originalType, about, first, second, channel,
   mcpAnswerable: false }` and options `[{ id: 'keep', label: 'Keep "<first>"' }, { id: 'change', label:
   'Change to "<second>"' }]`. Text: `You answered <qid> "<first>" on <channel1> at <time>, and now
   "<second>". Which stands?`; when `answer.channel === 'default'`: `<qid> was settled by its default
   "<first>" at <time>; you now answered "<second>". Which stands?`. The ladder entry for it is pinned to
   the channel the second answer came from (`pinnedChannel`). Not charged. C4 registers
   `QuestionStore.registerAnswerHandler('conflict', { onAnswered })`: `keep` → journal only; `change` → the
   answer becomes a `user` fact on the original `about` superseding the first; and when the original is an
   envelope approval (`originalType ∈ envelope | envelope-delta`) changed to `reject`,
   `getExecutorRegistry()?.revokeEnvelope(caseId, envelopeId, 'owner changed the answer')` (C3). A conflict
   on an approval is itself `kind: approval`, so only authenticated channels can settle it.

**Acks.** `handleReply` returns `ackText`; the receiving adapter sends it with its plain `send` to its
**owner target** only (never to the sender id), and only when step 1 passed or the refusal is the SMS token
hint to the configured owner number. Voice and ntfy send no acks; email acks as a reply in the thread.

**Outbound chokepoint (R38, R39).** `sendExternal` is C4's single gate-enforced path for any
channel-targeted send by case code; it has no stage-3 consumer. The target is normalized (E.164, lowercase
email) first. **Owner exemption:** only when `isOwnerTarget(channelId, target)` — the adapter's
`ownerTarget()` exists, is a private chat/DM or owner address per §3.1, and equals the normalized target;
ntfy never qualifies. Otherwise it runs `gateLeaves({ text }, { recipients: [target], envelope, facts, mode:
'message', caseId, entityIndex: runtime.entityIndex?.() })` (C3) and sends **`rendered.text`**, never
`text`; a block returns `{ ok: false, error: 'outbound gate blocked the message', blocked }`. The new
adapters' plain `send(target, …)` refuses a non-owner target unless `options[GATE_PASSED]` is set, a
`Symbol` only `contact.js` holds. Before C3 merges `getGate()` is `null` and every non-owner send refuses.

### 3.6 Ladder — `src/cases/ladder.js`

```js
class LadderEngine({ file, casesRoot, runtime, router, presence, getPolicy, clock, tickMs = 30000 })
start() / stop()                 // takes the cases-root lease; stop() awaits an in-flight tick
async tick(now = clock()) → { delivered, failed, exhausted }
resolveSteps(urgency, caseMeta) → [{ channel, afterMin, digest }]
list() → entries                 // contact:ladderState
```

Own tick (no model turn, no case lock for delivery, batches across cases). Every step is persisted before
acting.

**One process per cases root.** `start()` takes `<casesRoot>/.contact.lock` (`{ pid, host, dataDir,
heartbeatAt }`, `open(..., 'wx')`), refreshed each tick; a lock whose `heartbeatAt` is older than `3 ×
tickMs` is stale and may be taken over. A process that cannot take it runs no ladder, logs `contact ladder
runs in <host>:<pid>`, and serves `contact:ladderState` read-only from the holder's `dataDir`.

**Tick:**

1. **Scan.** For every case not `done`/`abandoned`, `QuestionStore.open()`. A record with no entry (and no
   entry marked `expired`) is **enqueued**: steps resolved, question token assigned, `startedAt =
   createdAt`, step 0 `nextAt = createdAt + batchDelaySec` (60), so one turn's questions batch together. No
   budget charge.
2. **Retire.** Drop entries whose record is answered or closed or whose case is `done`/`abandoned`. An entry
   whose `expiresAt ≤ now` stops laddering but is **kept with `expired: true`** until the record closes, so
   a `hold` record is never re-enqueued.
3. **Collapse overdue.** On every tick, an entry with several steps past due fires only its latest due step;
   earlier ones are recorded `skipped: overdue`.
4. **Resolve the due step:** `present` → `presence.presentChannel(now)`; `null` → outcome `absent`, next
   step on schedule. `journal` → a `question` journal line via `systemAction` (`<qid> waiting: <text>`),
   outcome `sent`. `in-app` on a record with C2's `in-app-<qid>` delivery → `sent` with that id, unless
   re-surfacing applies (§3.1). Not enabled or no owner target → `skipped`, next step due now. A channel the
   entry already delivered to → `skipped: duplicate`, next step due now (in-app re-surfacing is not a
   duplicate). `away` → replaced per the away mode. Quiet hours on an `interrupts` channel with urgency
   outside `quietHours.breakthrough` → `nextAt = presence.nextQuietEnd(now)`, no advance. `digest: true` →
   wait for the digest (§3.7). `pinnedChannel` → only that channel.
5. **Deliver.** Group by resolved channel, one `router.deliver` per channel; the attempt is saved `inFlight`
   with the relay `Idempotency-Key` (= `deliveryId`) before sending.
6. **Outcome.** `sent` → `step + 1`, `nextAt = startedAt + steps[step].afterMin`. `ContactDeliveryError` →
   `failed`, `step + 1`, `nextAt = now` (parent §14). A later async failure (relay `failed | bounced |
   no-answer | busy`, email DSN) matched through `deliveries.json` advances the same way on the next tick
   when that attempt is still the entry's latest.
7. **Exhaust.** When `step === steps.length`, the entry is open and not digest-only: `exhausted: true` and a
   `question` journal line inside `systemAction`: `Ladder exhausted for <qid>: tried <channels with
   outcomes>. The question stays open.` On `CaseBusyError` the journal is retried next tick
   (`exhaustJournaled: false`). The question stays listed in-app and joins the digest.
8. **Briefings** without options stop after their first `sent` on a step that was not `absent`.
9. **Mirror.** Attempts with `mirrored: false` go into the record's `deliveries` through
   `QuestionStore.recordDelivery` inside `runtime.systemAction(caseId, 'contact: delivered q-0012, q-0013
   via telegram', fn)`: one commit per case per tick; `CaseBusyError` leaves them for the next tick.

**Restarts.** An `inFlight` relay attempt is re-sent with the **same `Idempotency-Key`** (the relay returns
the original message) or looked up with `GET /v1/messages?idempotencyKey=`; any other `inFlight` attempt
becomes `unknown` and advances. Delivery is at most once per channel.

**Step resolution.** `contactPolicy.ladders[urgency]`, replaced by `case.yaml.channels[urgency]` when
present (§4.4); non-contact channels dropped.

### 3.7 Daily digest

`contactPolicy.digest = { channel: 'email', at: '08:00' }`. At the first tick at or after `at` (owner zone)
on a day with `digest.lastSentDay < today`, entries whose current step is `digest: true`, exhausted open
entries and briefings from the last 24 h go out as one delivery; if the process was down at `at`, the next
tick sends it. It is sent inside quiet hours when its channel does not interrupt, and skipped when empty.

### 3.8 Settings and UI

`contactPolicy:set` validates against §4.1 and writes `settings.contactPolicy`. `renderQuestionsSection()`
(new `#questions-section` above the chat list):

- Header: presence dot (green `in-app`, amber another channel, grey none), away toggle with mode and until.
- Pending questions across cases from C2's `case:questions` (no `caseId`; every status except
  `done`/`abandoned`) joined with `contact:ladderState`, high first then newest: case title, text
  (`textContent`), option buttons, a text box, ladder state (`next: telegram at 14:30`, `exhausted`).
  Answers go through `case:answerQuestion`. Refresh on `cases.onChanged` and every 60 s.
- A collapsible "Contact policy" editor: ladders, quiet hours, breakthrough, digest, per-channel status.

**Heartbeat.** `presence:heartbeat { focused, lastInputAt }` on focus/blur, keydown/pointerdown (≤ once per
30 s) and every 60 s while focused. The handler accepts only events from the main window's `webContents`, or
proxied events from an attached desktop (F7's `isLocalDesktopEvent`), and clamps `lastInputAt` to `now`.

### 3.9 Mobile app adapter (wave 3, R44)

Mounted through F3's hooks (F3 spec §5.2 P10, P11, P15, P17, P18, P3); C4 adds no F3 message shapes.

- **Relay side** (`src/frontdoor/question-routes.js`, one line in `src/frontdoor/extensions.js`):
  `mailbox.registerType('kl.question', { ttlMs: 7 d })`; `phoneApi.registerRoute('GET', '/v1/questions', {
  auth: 'device', handler })` returns `mailbox.list({ typePrefix: 'kl.question', toDevice: ctx.deviceId })`;
  `phoneApi.registerRoute('POST', '/v1/questions/{token}/answer', { auth: 'device', rate: { perMin: 30 },
  handler })` forwards the body envelope unchanged with `nodeHub.rpc(nodeId, 'question.answer', { envelope
  }, { timeoutMs: 10000 })`; `phoneApi.registerRoute('POST', '/v1/presence', { auth: 'device', rate: {
  perMin: 6 }, handler })` → `nodeHub.rpc(nodeId, 'presence.foreground', { deviceId, foreground })`
  (presence may stay relay-trusted).
- **Node side** (`mobile-app-channel.js`): `sendContact` sends each item as a node-signed `kl.question`
  envelope `{ v, type: 'kl.question', node_id, case_id, question_id, token, kind, urgency, case_title, text,
  options, expires_at }` with `link.send(envelope, { push: { kind: 'question', id: token }, to_device })`
  per active device (this is `question.submit`); the push carries only the id (`Question from King Louie`).
  `relayClient.registerMethod('question.answer', handler(params, { peer }))` verifies with
  `verifyDeviceEnvelope(params.envelope, { approverStore, type: 'kl.question.answer', nodeId, nonces })`
  against admin `<configDir>/approvers/`; nonce reuse is refused; `signed_at` must be within 300 s of the
  node clock; `node_id`, `case_id`, `question_id` and `token` must match a live delivery. Only then does it
  call `router.handleReply('mobile', token, answer, { ownerProven: true, senderId: device_id })`. A
  relay-verified-then-forwarded answer without a valid device signature is never owner proof.
  `relayClient.registerMethod('presence.foreground', …)` calls `presence.mobileForeground`.
- `kl.question.answer` payload: `{ v, type, node_id, case_id, question_id, token, answer: { option_id } | {
  text }, nonce, signed_at, device_id }`.
- Apps: a Questions screen in `mobile/ios` and `mobile/android` using these routes. Until F3 merges the
  `mobile` channel is absent and its steps are `skipped`.

## 4. Data formats

### 4.1 `settings.contactPolicy`

```jsonc
{
  "batchDelaySec": 60,
  "ladders": {
    "low":    [{ "channel": "in-app" }, { "channel": "journal" }, { "channel": "email", "digest": true }],
    "normal": [{ "channel": "present" }, { "channel": "telegram", "afterMin": 30 }, { "channel": "email", "afterMin": 240 }],
    "high":   [{ "channel": "present" }, { "channel": "sms", "afterMin": 15 }, { "channel": "voice", "afterMin": 30 }]
  },
  "quietHours": null,                   // or { "start": "22:00", "end": "07:00", "breakthrough": ["high"] }
  "away": null,                         // or { "mode": "email-only" | "in-app-only", "until": "RFC3339" }
  "digest": { "channel": "email", "at": "08:00" },
  "presence": { "desktopIdleMin": 5, "recentInboundMin": 10 }
}
```

| Field | Rules |
|---|---|
| `ladders.<u>[].channel` | `present`, `in-app`, `journal`, `telegram`, `discord`, `email`, `sms`, `voice`, `ntfy`, `mobile`; unknown → `unknown contact channel "<x>"`; `slack` → the §3.1 error |
| `ladders.<u>[].afterMin` | int ≥ 0, from ladder start, non-decreasing |
| `ladders.<u>[].digest` | last step only |
| `quietHours.start/end` | `HH:MM`, `start !== end`; `breakthrough` default `["high"]` |
| `away.until` | RFC3339, required; a past value is ignored and cleared on the next `set` |

### 4.2 `<dataDir>/contact/ladder.json`

```jsonc
{ "version": 1,
  "entries": {
    "3f9c…/q-0012": {
      "caseId": "3f9c…", "questionId": "q-0012", "kind": "question", "urgency": "high",
      "token": "7QD4KM", "startedAt": "…", "step": 1, "nextAt": "…", "pinnedChannel": null,
      "steps": [{ "channel": "present", "afterMin": 0 }, { "channel": "sms", "afterMin": 15 }, { "channel": "voice", "afterMin": 30 }],
      "expired": false, "exhausted": false, "exhaustJournaled": false,
      "attempts": [{ "step": 0, "channel": "in-app", "at": "…", "deliveryId": "d-01J…", "outcome": "absent", "mirrored": true }]
    } },
  "digest": { "lastSentDay": null } }
```

Tokens (question and batch) are 6 Crockford base32 characters from `crypto.randomBytes`, unique across
`ladder.json` and `deliveries.json`, the same question token on every channel. `attempts[].outcome` ∈
`inFlight | sent | absent | failed | skipped | unknown`; `failed` carries `error: { code, message }`;
`skipped` carries `reason` (`not-configured | duplicate | overdue`). Written atomically (tmp + rename); an
unreadable file is renamed `ladder.json.corrupt-<ts>` and rebuilt from the scan.

### 4.3 `<dataDir>/contact/deliveries.json` and `inbox.jsonl`

```jsonc
{ "d-01J…": { "channel": "telegram", "at": "…", "externalRef": "4812", "batchToken": "K7QD4M",
              "idempotencyKey": "d-01J…", "status": "sent",
              "items": [{ "n": 1, "caseId": "3f9c…", "questionId": "q-0012", "token": "7QD4KM" }] } }
```

`status` ∈ `sent | delivered | failed | bounced | no-answer | busy`. Pruned 30 days after all items close.
`inbox.jsonl`: `{ at, channel, caseId, questionId, text, optionId, meta }`, a line removed once applied.

### 4.4 `case.yaml.channels`

```yaml
channels:
  high: [present, sms, { channel: voice, afterMin: 20 }]
  urgency.normal: [present, email]     # parent's dotted form, accepted as an alias
```

A bare name at position *i* takes the owner ladder's `afterMin` at *i* (past its end: last + 30). `call` is
an alias for `voice`. Overrides name channels; they cannot enable them.

### 4.5 Relay contract (email via relay, SMS, voice)

Every request carries `Authorization: Bearer <vault contact.relay.<name>.token>`.

| Call | Request | Response |
|---|---|---|
| Send | `POST {baseUrl}/v1/messages`, `Idempotency-Key: <deliveryId>` (same key → the original message) | `202 { "id", "status": "queued" }` |
| Status | `GET {baseUrl}/v1/messages/{id}` or `?idempotencyKey=<key>` | `200 { "id", "status", "at", "error"? }` |
| Events | `GET {baseUrl}/v1/events?after=<cursor>&limit=100` | `200 { "events": [ … ], "cursor" }` |

```jsonc
// Send body
{ "channel": "sms" | "voice" | "email", "to": "+15550100", "from": "+15550199", "subject": null, "text": "…",
  "voice": { "language": "en-US", "prompts": [{ "n": 1, "say": "Question 1 from …", "gather": { "digits": { "1": "a", "2": "b" } } }] },
  "correlation": { "deliveryId": "d-01J…", "tokens": ["7QD4KM"], "batchToken": "K7QD4M" }, "expiresAt": "…" }
// Events
{ "id": "ev-…", "type": "status", "messageId": "…", "status": "delivered" | "failed" | "bounced" | "no-answer" | "busy", "at": "…", "error": "…" }
{ "id": "ev-…", "type": "inbound", "channel": "sms" | "email", "from": "…", "to": "…", "text": "…", "at": "…",
  "inReplyTo": "…", "subject": "…", "auth": { "verified": true, "method": "dmarc" } }
{ "id": "ev-…", "type": "gathered", "messageId": "…", "results": [{ "n": 1, "digits": "2" }], "at": "…" }
```

HTTP status → `ContactDeliveryError`: `400/422 → rejected`, `401/403 → not-configured`, `413 → too-large`,
`429 → rate-limited`, `5xx`/network → `unreachable`. King Louie polls `/v1/events` every
`contact.relays.<name>.pollSec` (30), cursor in `<dataDir>/contact/relay-<name>.cursor`, backing off 30 s →
10 min on failure. Polling is required; a co-located relay may also **push** the same body to `POST
http://127.0.0.1:<webhookPort>/contact/relay/<name>` (`features.webhooks`) with `X-KL-Timestamp` (± 300 s)
and `X-KL-Signature: sha256=<hex HMAC-SHA256(vault contact.relay.<name>.webhookSecret, timestamp + "." +
rawBody)>`, compared with `crypto.timingSafeEqual`. Both paths call `router.ingestRelayEvents`; events are
deduplicated by `id`; inbound events whose normalized `from` is not the owner are dropped.

## 5. Interfaces

### 5.1 Consumed

| From | Interface |
|---|---|
| C2 §4.3 | `QuestionStore` `open`, `get`, `create`, `static registerAnswerHandler(type, { toFact?, onAnswered? })`; `QuestionError` `ALREADY_ANSWERED` carries the record; `CaseRuntime.answerQuestion(caseId, qid, { channel, text, optionId })` |
| C2 §4.20 | `CaseRuntime.systemAction(id, label, fn, { commitMessage? })`, `CaseBusyError`; `host.notify`, `host.uiToast`, `host.interactive()` (a function, R50) |
| C2 | `settings.cases.timeZone`; IPC `case:questions`, `case:answerQuestion`; preload `cases.onChanged`; journal kind `question` |
| C1 | `CaseRuntime.listCases()`, `getCase()`, `ledger(id).view()` |
| C3 §4.9 | `gateLeaves(payload, opts) → { ok, blocked, rendered }`, `normalizeRecipient`, `registry.revokeEnvelope(caseId, envelopeId, reason)`; C7 `runtime.entityIndex?.()` |
| F3 §5.2 | P3 `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces })`, `NonceCache`; P10 `link.send(envelope, { push, to_device })`; P11 `relayClient.registerMethod(name, handler(params, { peer }))`; P15 `phoneApi.registerRoute(method, pathPattern, { auth, rate?, handler(req, ctx) })`; P16 `nodeHub.rpc`; P17 `Mailbox.registerType/list`, `src/frontdoor/extensions.js`; P18 `pusher.notify(device, { kind: 'question', id })`; P4 `approverStore` |
| F7 | `isLocalDesktopEvent(event)` (`src/core/origin.js`) |
| Existing | `ChannelRegistry`, `NtfyChannel`, `UiToastChannel`, `vault.get`, `WebhookServer` |

### 5.2 Produced

| Name | Signature | Consumers |
|---|---|---|
| `ChannelPlugin` contact methods | `contactCapabilities()`, `sendContact(message, meta)`, `onContactReply(handler)`, `presence()`, `ownerTarget()` (§3.1) | channels |
| `core.context.getContact()` | `→ { ladder, presence, router } \| null` | IPC, F7 |
| `ContactRouter.sendExternal({ caseId, channelId, target, text, envelope })` | `→ { ok, deliveryId } \| { ok: false, error, blocked? }`; no stage-3 consumer (R39) | future channel senders |
| `QuestionStore.recordDelivery(id, { channel, at, deliveryId })` | appends to `deliveries` atomically, idempotent on `deliveryId`, no claim file (C4-owned, §4.3) | C2 in-app delivery, C4 |
| `Presence.mobileForeground({ deviceId, foreground })` | via the `presence.foreground` link method | F3 relay route (C4-mounted) |
| Phone routes (R44) | `GET /v1/questions`, `POST /v1/questions/{token}/answer`, `POST /v1/presence` | mobile apps |
| Link methods / types | `question.answer`, `presence.foreground` (node-side); `kl.question` envelopes (`question.submit`); push kind `question` | relay, apps |
| `kl.question.answer` envelope | §3.9 | mobile apps |
| IPC `contact:ladderState` | `→ { "<caseId>/<qid>": { step, nextAt, nextChannel, expired, exhausted, attempts: [{ channel, at, outcome }] } }` | renderer, F7 |
| IPC `contactPolicy:get` / `:set` | `→ { policy, channels: { <id>: { enabled, configured, reason? } } }` / `(policy) → { ok, policy } \| { ok: false, error }` | renderer, F7 |
| IPC `presence:heartbeat`, `presence:status` | `({ focused, lastInputAt }) → { ok: true }`; `→ Presence.status()` | renderer, F7 |
| Relay contract | §4.5 | relay operators |

## 6. Configuration

| Key | Where | Default | Notes |
|---|---|---|---|
| `contactPolicy` | settings | §4.1 | Decides when, not who |
| `channels.telegram\|discord.contactEnabled`, `.contactOwnerUserId` | settings (desktop) | `false`, `''` | Service mode: `contact.<ch>.ownerUserId` in admin `service.json` |
| `channels.email` `{ enabled, transport: 'relay' \| 'imap-smtp' }` | settings | `{ enabled: false, transport: 'relay' }` | |
| `channels.sms\|voice` `{ enabled, maxChars, language }` | settings | `false`, `1200`, `'en-US'` | |
| `channels.ntfy` `{ enabled, includeText }` | settings | `false`, `false` | Separate from `notifications.ntfy` |
| `channels.mobile.enabled` | settings | `false` | Wave 3 |
| `contact` (below) | desktop: settings `contact`; **service: admin `service.json` only** | none | Who the owner is and where to reach them; security-relevant |
| Vault `contact.email.imapPassword`, `contact.email.smtpPassword`, `contact.relay.<name>.token`, `contact.relay.<name>.webhookSecret` | vault | none | Set with `king-louie-service vault set …` or the UI |
| `KING_LOUIE_CONTACT_TICK_MS` | env | `30000` | Tests only |

```jsonc
"contact": {
  "telegram": { "ownerUserId": "123456789" }, "discord": { "ownerUserId": "234567890123456789" },
  "ntfy": { "baseUrl": "https://ntfy.sh", "topic": "" },
  "email": { "owner": "owner@example.com", "from": "kl@example.com", "relay": "main",
             "smtp": { "host", "port", "secure", "user" }, "imap": { "host", "port", "user", "trustedAuthServId", "pollSec": 60 } },
  "sms": { "owner": "+15550100", "from": "+15550199", "relay": "main" }, "voice": { "owner": "+15550100", "from": "+15550199", "relay": "main" },
  "relays": { "main": { "baseUrl": "https://relay.example.com", "pollSec": 30 } } }
```

`relays.<name>.baseUrl` must be `https:`, or `http:` to loopback. In service mode `contact` joins
`ADMIN_ONLY_KEYS` (`src/service/config.js` validates it; unknown keys rejected, R55); `loadServiceConfig`
returns it and `run.js` passes it to `createCore` as `deps.contactConfig` (one line; the program's §5
`run.js` row must add C4). Data-dir `settings.contact` and `channels.<ch>.contactOwnerUserId` are ignored
there with a `warn`, because the service account (and so an agent's `Bash`) can write the data dir. The
`Vault` tool refuses keys starting `contact.` (`contact credentials are managed in settings, not by the
model`) and omits them from `list`.

**Service mode.** Channels are off by default (`features.channels: false`). To reach the owner the admin
sets `features.channels: true` and a `contact` block per channel; the vault holds credentials; settings hold
`channels.<id>.enabled`. There is no `in-app`, so `present` resolves to mobile or a recently active channel.
An unconfigured channel accepts no one.

**Attached desktop (F7).** With F7's desktop bridge, the service's `host.interactive()` returns true while a
desktop is connected (`() => bridgeServer?.connected != null`), so C2's in-app delivery and the `in-app`
adapter work through the bridge. `presence:heartbeat` from that desktop is proxied to the service's handler,
so presence reflects the attached desktop, and the Contact policy editor edits the service's policy. C4 adds
`contact`, `contactPolicy` and `presence` to `PROXIED_DOMAINS` in `src/desktop-bridge/allowlist.js` (one
line).

## 7. Host wiring

`src/core/create-core.js` has several additive hunks (the program's §5 exception for C4): (1)
`require('../cases/contact-host')`; (2) in `start()`, `contactHost = createContactHost({ settings,
contactConfig: deps.contactConfig, isService, host, channelRegistry, vault, caseRuntime, casesRoot, dataDir,
getExecutorRegistry, bridges: { telegram, discord } })`, which builds the adapters, `Presence`,
`ContactRouter` and `LadderEngine`, calls `bridge.setContactHost({ presence, router })` on each bridge,
registers the email/SMS/voice/ntfy adapters in `channelRegistry` only when `features.channels` is on, and
calls `ladder.start()`; (3) `contactHost.stop()` in shutdown before `releaseAll()`; (4) the `getContact`
context getter.

Other files: `src/core/settings.js` (defaults and merge for `contactPolicy`, `contact`, `channels.*`);
`src/cases/questions.js` (`recordDelivery`); `src/cases/{presence,ladder,contact,contact-host}.js`;
`src/channels/channel-plugin.js` (defaults, `DesktopChannelPlugin` contact methods), `telegram-bridge.js`
(contact methods, `apiBase` option, `kl_q_`, reply interception, owner proof), `discord-bridge.js`, new
`email-channel.js`, `telephony-channel.js`, `relay-client.js`, `ntfy-contact.js`, `mobile-app-channel.js`;
`src/webhooks/webhook-server.js` (`POST /contact/relay/<name>`); `src/tools/ builtin/vault-tool.js`;
`src/service/config.js`; `src/service/run.js` (one line); `src/frontdoor/ question-routes.js` and one line
in `src/frontdoor/extensions.js` (wave 3); `src/desktop-bridge/ allowlist.js` (one line);
`src/ipc/contact-handlers.js` (new), `constants.js` (five constants), `register.js` (one call), `preload.js`
(`contact: { ladderState, getPolicy, setPolicy, heartbeat, presenceStatus }`); `renderer.js`, `index.html`
(`#questions-section`), `styles.css` (`.questions-*`); `tests/helpers/loopback-channel.js` (C4 creates it);
`package.json` (three dependencies); `CLAUDE.md` ("Contact ladder" section). No edits to
`src/tools/index.js`, `src/service/cli.js` or `chat-handlers.js`.

## 8. Security and trust

| New attacker capability | What stops it |
|---|---|
| Answer a question as the owner (a `user` fact) | Owner proof per channel (R43): Telegram/Discord need the private chat/DM with the contact owner id **and** that sender; email needs the owner address, a live batch and authentication or the batch token; SMS needs the owner number and a token; mobile needs a device-signed envelope verified on the node (R44). Others are dropped silently |
| A group member or second allowlisted user answers | The allowlist is not proof; `chat === target && sender === contactOwnerUserId` is |
| Approve an envelope by spoofing email or SMS | `kind: approval` (and its conflicts) only on in-app, Telegram, Discord, mobile |
| A compromised relay forges a phone answer | The node verifies the device signature against admin `<configDir>/approvers/`, refuses nonce reuse and stale `signed_at` |
| Redirect the owner identity (the agent rewrites settings with `Bash`) | In service mode `contact.*` comes only from admin `service.json` |
| Read relay or mailbox credentials via the `Vault` tool | `contact.` prefix refused and hidden from `list` |
| Leak case facts to a third party (principle 5) | `sendExternal` gates every string and sends `rendered`; owner exemption only for a private owner target; ntfy never exempt; new adapters' `send` needs `GATE_PASSED` |
| Leak question text through a public ntfy topic | `includeText: false` by default |
| Forge relay push events | HMAC with `timingSafeEqual`, ± 300 s, loopback listener, `id` dedupe; the owner check still applies |
| SSRF through `relays.<name>.baseUrl` | `https:`, or `http:` to loopback only |
| Silence the owner (the agent edits `contactPolicy` on the desktop) | Denies contact, grants nothing; the in-app list always shows everything |
| Two processes ladder the same questions | The cases-root lease; the other process stays passive |

Maps to parent principles 3 and 5 and program §3 (security config only from the admin dir).

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| `sendContact` throws | `failed`, next step due now | Ladder state `telegram failed: unreachable` |
| Async bounce / `no-answer` / `busy` | Same advance on the next tick | Same |
| All steps failed or skipped | `exhausted`, `question` journal (retried if busy), question open | `exhausted` badge; in the digest |
| Step channel not configured | `skipped`, next step now; logged once per channel per day | `configured: false, reason` |
| Case busy when answering | Queued in `inbox.jsonl`, drained each tick | `Received — recording it after the current step` |
| Reply from a non-owner | Dropped, `warn` with channel and sender id | Nothing |
| SMS reply without a token | Not applied | Hint to the owner number |
| Unparseable batch reply | Not applied | `Which question? Reply "#<batch> <n> <answer>".` |
| Approval on an unauthenticated channel | Refused | `Approvals can't be answered by sms. Use King Louie or telegram.` |
| Conflicting or post-default answer | Follow-up on that channel only | `… Which stands?` |
| `ladder.json` corrupt | Renamed, rebuilt | Questions may be re-sent once |
| Lease held by another process | No ladder here | `contact ladder runs in <host>:<pid>` in `presence:status` |

## 10. Testing

`node --test`; every clock injected; fakes are local `http`/`net` servers on port 0.

| File | Covers |
|---|---|
| `tests/contact-presence.test.js` | §3.4 table; away; heartbeat staleness and clamping; `nextQuietEnd` spring-forward and fall-back ("DST quiet hours") |
| `tests/contact-ladder.test.js` | Timing from `startedAt`; batching at `createdAt + batchDelaySec`; failure advance; exhaustion journal and busy retry; restart `inFlight` re-sent with the same key; latest-overdue on every tick; duplicate channel skipped; in-app re-surfacing after a present transition; "expired hold is not re-enqueued"; briefing stop; digest incl. "down at digest time"; `journal` step; override aliases; the lease (second process passive, stale takeover) |
| `tests/contact-router.test.js` | `parseReply`; loopback round trip → `answerQuestion` → a `user` fact with `source.kind: 'question'`; non-owner refusal; approval on an unauthenticated channel; inbox behind `CaseBusyError`; "conflicting answers" (follow-up pinned, option labels carry both, default wording, envelope `change` to reject calls `revokeEnvelope`); "token reuse after retirement" (late reply resolves through `deliveries.json`, a new token never collides); `sendExternal`: owner DM exempt, group chat not exempt, ntfy never exempt, block returns `blocked`, the adapter receives `rendered` |
| `tests/contact-adapter-contract.test.js` | One suite (send → `deliveryId`; owner reply → handler with correlation; stranger → `ownerProven: false`; failure → `ContactDeliveryError`) over Telegram (fake Bot API via `apiBase`), Discord (fake client), in-app, email/relay and SMS/voice (fake relay), email/imap-smtp (fake SMTP over `net`, IMAP double), ntfy. Telegram and Discord add **a group member and a second allowlisted user**, both refused |
| `tests/contact-email.test.js` | Topmost-header rule (a forged lower header ignored); token fallback; quoted-history stripping; DSN → bounce |
| `tests/contact-sms.test.js` | "SMS token required" (tokenless reply not applied, hint sent to the owner number only); spoofed number without a token refused; E.164 normalization of `from` |
| `tests/contact-relay.test.js` | Cursor persistence; HMAC accept/reject, stale timestamp, duplicate ids; status → error codes |
| `tests/contact-mobile.test.js` (wave 3) | Valid signed answer applied; bad signature, unknown device, reused nonce, stale `signed_at`, wrong `node_id` or token refused; relay-forwarded unsigned answer refused |
| `tests/contact-ipc.test.js` | Five handlers; `contactPolicy:set` errors; heartbeat from a non-main sender refused |
| `tests/contact-service-config.test.js` | Service mode reads `contact` only from admin `service.json`; data-dir values ignored with a warning; `Vault` refuses and hides `contact.*` |
| `tests/cases-regressions.test.js` | F2-late (below) |
| `tests/e2e/questions.test.js` | A seeded question (`KL_CASES_ROOT`) appears in `#questions-section`, is answered inline, disappears |

A dependency test asserts `package-lock.json` has no install scripts or native binaries for `nodemailer`,
`imapflow`, `mailparser` and their transitive packages.

**F2-late.** A load-bearing owner-answerable unknown is asked as a `high` question at T0 (day 1, 09:00 owner
time); the owner is absent and `sms` is wired to the fake relay. Asserted: `in-app` `absent` at T0+60 s; an
SMS at T0+15 min; a relay `inbound` `#<batch> a` at T0+2 h resolves the record and the ledger holds a `user`
fact on day 1. A `normal` variant does the same through the loopback adapter registered as `telegram` at
T0+30 min. A control with no reachable channel ends `exhausted` and journaled on day 1. No run stays silent
until day 6.

**Five conditions the parent is silent on:**

| # | Condition | Behaviour | Test |
|---|---|---|---|
| 1 | The owner answers on two channels differently | First stands; the follow-up goes to the second channel only | `contact-router`, "conflicting answers" |
| 2 | Quiet hours 22:00–07:00 in a DST week (America/Chicago, 2026-11-01 fall-back, 2027-03-14 spring-forward) | A 23:30 `normal` Telegram step defers to 07:00 local at the right UTC instant; an end in the gap resolves to 03:00; no second deferral on the repeated hour | `contact-presence`, "DST quiet hours"; `contact-ladder`, "quiet hours across fall-back" |
| 3 | An email bounce | DSN or relay `bounced` fails the attempt; the next step fires next tick | `contact-email`, "DSN → bounce"; `contact-ladder`, "async failure" |
| 4 | Phone app and desktop both present | One delivery, to the one touched last | `contact-presence`, "both present" |
| 5 | A question expires while a delivery is in flight | The attempt is recorded, no later step fires, the entry is kept `expired`; a later reply to a `hold` question is accepted; after a default it becomes the follow-up | `contact-ladder`, "expiry in flight" |

## 11. Deviations from the parent

| # | Parent | Instead | Why |
|---|---|---|---|
| D1 | §8.1 `send(message, …)`, `capabilities()` | `sendContact`, `contactCapabilities`, `onContactReply` | Name clash with `ChannelPlugin` |
| D2 | §8.1 lists Slack | Excluded | No allowlist; its inbound calls a nonexistent `routeInbound` |
| D3 | §8.3 a reply on any channel resolves the record | Owner proof per channel; approvals only on authenticated channels; a different second answer never overwrites | Senders can be spoofed; overwrites hide conflicts |
| D4 | §4.5 machine state in `.kl/` | Ladder state owner-wide in `<dataDir>/contact/`; the record's `deliveries` is a mirror | Batching crosses cases |
| D5 | §4.2 `channels: urgency.high: [present, sms, call]` | `{ high: [...] }` with aliases | Steps need delays |
| D6 | §8.2 voice has no delay | `afterMin: 30` | Total order |
| D7 | §8.1 relay webhook | Polling required; push only from a co-located relay | `WebhookServer` binds loopback; public ingress is F4's |
| D8 | Telegram/Discord contact in the approval chat | A private chat/DM with a configured contact owner id | R43; approval chats are often groups |
| D9 | Code: `DesktopChannelPlugin` is never instantiated | `contact-host` constructs it | Needed for in-app re-surfacing |

## 12. Assumptions made without asking

- No default quiet hours; when set, `high` breaks through. Alternative: nothing breaks through.
- The digest goes to `email` at 08:00 owner time. Alternative: no digest until configured.
- Presence thresholds: desktop idle 5 min, heartbeat stale 90 s, mobile ping 120 s, recent inbound 10 min,
  batch delay 60 s; all configurable.
- After downtime only the latest overdue step fires. Alternative: replay every missed step.
- Email offers relay (default) and IMAP/SMTP. Alternative: IMAP/SMTP only.
- Tokens are 6 Crockford base32 characters (30 bits). Alternative: 8 characters.
- SMS replies always need a token. Alternative: accept bare replies when one batch is open.

## 13. Deferred

- Slack as a contact channel (needs an allowlist and a working inbound path; no stage).
- Editing delivered messages to show "answered" (unowned polish).
- Relay push over the public front door: F4. `answer_question` over MCP: C7.
- In-app voice and spoken free-text answers (parent "later"; no stage).

## 14. Dependencies (npm)

| Package | Why | Rejected alternative |
|---|---|---|
| `nodemailer` | SMTP send for `imap-smtp`; pure JS, no dependencies | A hand-rolled SMTP client (auth, STARTTLS, encoding) |
| `imapflow` | IMAP polling; pure JS. Pulls `nodemailer`, `libmime`, `iconv-lite`, `@zone-eu/mailsplit`, `encoding-japanese`, `libbase64`, `libqp`, `socks`, and `pino` with `thread-stream`/`sonic-boom`, all pure JS. Constructed with `logger: false` | `node-imap` (unmaintained); relay-only email |
| `mailparser` | MIME parsing of replies and DSNs; pure JS | A regex MIME split |

No native dependencies. Relay, telephony, ntfy and presence code use only `fetch`, `crypto` and `Intl`.
