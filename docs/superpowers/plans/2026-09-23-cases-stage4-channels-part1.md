# Cases Stage 4: Channels, presence and the contact ladder — Implementation Plan (Part 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Electron-free core of contact: the channel contact extension, the policy and batch format, presence, the contact state files, the contact router (answers, owner proof, conflicts, `sendExternal`) and the ladder engine.
**Architecture:** Part 1 adds pure or file-backed modules under `src/cases/` (`contact-format.js`, `presence.js`, `contact-state.js`, `contact.js`, `ladder.js`) and the contact defaults to `src/channels/channel-plugin.js`, all tested against C2's real `CaseRuntime` with a loopback channel. Nothing is wired into a host yet. Part 2 (`…-part2.md`) adds the real adapters, Part 3 (`…-part3.md`) settings, host wiring, IPC and UI, Part 4 (`…-part4.md`, wave 3, after F3) the phone app.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `Intl.DateTimeFormat` for wall-clock math, `crypto.randomBytes` for tokens. No new dependency in Part 1.
**Spec:** docs/superpowers/specs/2026-09-23-cases-stage4-channels.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

## Global Constraints

Program §3, verbatim:

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
  never decides policy. `node.yaml` rejects unknown keys and `service.json` rejects unknown `features.*` and
  `ports.*` keys, each with the key path named (R11, R55). Stages that add a feature
  also add it to the four example `service.json` files under `examples/`.
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

Stage 4 spec constraints:

- New npm dependencies, all pure JS, exactly three: `nodemailer`, `imapflow`, `mailparser` (spec §14). `imapflow` is constructed with `logger: false`; nodemailer's transport with `logger: false, debug: false`. `tests/contact-deps.test.js` checks the lockfile closure for install scripts, node-gyp, `os`/`cpu` binaries and `.node` files.
- Relay, telephony, ntfy and presence code use only `fetch`, `crypto` and `Intl`. No date library.
- Contact channel ids: `in-app`, `telegram`, `discord`, `email`, `sms`, `voice`, `ntfy`, `mobile`; ladder steps may also be `present` and `journal`. Naming `slack` fails with `slack is not a contact channel: it has no sender allowlist`; any other unknown name with `unknown contact channel "<x>"`.
- Default policy: `batchDelaySec: 60`; `low: in-app, journal, email (digest)`; `normal: present, telegram@30, email@240`; `high: present, sms@15, voice@30`; `quietHours: null` (breakthrough default `["high"]`); `away: null`; `digest: { channel: 'email', at: '08:00' }`; `presence: { desktopIdleMin: 5, recentInboundMin: 10 }`.
- Presence: desktop heartbeat stale after 90 s, mobile ping after 120 s; `lastInputAt` clamped to now; only per-channel last-seen times persist (`<dataDir>/contact/presence.json`).
- Tokens: 6 Crockford base32 characters from `crypto.randomBytes`, unique across `ladder.json` and `deliveries.json`; Telegram/Discord button data `kl_q_<token>_<optionIndex>` (≤ 17 bytes), checked before `kl_a_`.
- Owner proof (R43): Telegram/Discord only when the chat is the private chat/DM with the contact owner **and** the sender is the contact owner; email only from `contact.email.owner`, naming a live batch, and authenticated (topmost `Authentication-Results`) or carrying `[KL-<batchToken>]`; SMS from the owner number **and** with a `#TOKEN`; mobile only with a device-signed envelope verified on the node. Approvals (and their conflicts) only on in-app, Telegram, Discord, mobile.
- `sendExternal` sends `rendered.text`, never `text`; owner exemption only for the adapter's private owner target; ntfy never qualifies; before C3 merges every non-owner send refuses. New adapters' plain `send` refuses a non-owner target without `GATE_PASSED`.
- Ladder: own tick every `tickMs` (30000; `KING_LOUIE_CONTACT_TICK_MS` in tests), lease `<casesRoot>/.contact.lock` stale after `3 × tickMs`; every step persisted before acting; after downtime only the latest overdue step fires; relay `Idempotency-Key` = `deliveryId`; `ladder.json` written tmp + rename, an unreadable one renamed `ladder.json.corrupt-<ts>`.
- Relay contract (§4.5): `POST /v1/messages` (202), `GET /v1/messages/{id}` and `?idempotencyKey=`, `GET /v1/events?after=&limit=100`; `400/422 → rejected`, `401/403 → not-configured`, `413 → too-large`, `429 → rate-limited`, else `unreachable`; poll every `pollSec` (30), backoff 30 s → 10 min; push `POST /contact/relay/<name>` on the loopback webhook server with `X-KL-Timestamp` ± 300 s and `X-KL-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`, compared with `crypto.timingSafeEqual`; `baseUrl` `https:` or `http:` to loopback only.
- Service mode: `contact` joins `ADMIN_ONLY_KEYS`, unknown keys rejected with the key path named; data-dir `settings.contact` and `channels.<ch>.contactOwnerUserId` ignored with a `warn`. The `Vault` tool refuses keys starting `contact.` (`contact credentials are managed in settings, not by the model`) and hides them from `list`.
- No edits to `src/tools/index.js`, `src/service/cli.js` or `src/ipc/chat-handlers.js`. C4 charges no budget.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and where each is pinned:

1. **The owner answers on two channels differently.** Part 1, Task 5 (`tests/contact-router.test.js`, "conflicting answers": first stands, follow-up pinned to the second channel, default wording, envelope `change` → `revokeEnvelope`).
2. **Quiet hours 22:00–07:00 in a DST week (America/Chicago).** Part 1, Task 3 (`tests/contact-presence.test.js`, "DST quiet hours": 07:00 CST after fall-back, first occurrence in the repeated hour, 03:00 after spring-forward) and Task 6 (`tests/contact-ladder.test.js`, "quiet hours across fall-back", "not deferred again on the repeated hour").
3. **An email bounce.** Part 2, Task 8 (`tests/contact-email.test.js`, "DSN → bounce") and Part 1, Task 6 (`tests/contact-ladder.test.js`, "an async failure advances on the next tick").
4. **Phone app and desktop both present.** Part 1, Task 3 (`tests/contact-presence.test.js`, "both present: the one touched last wins").
5. **A question expires while a delivery is in flight.** Part 1, Task 6 (`tests/contact-ladder.test.js`, "expiry in flight"); the post-default follow-up is Task 5's "after a default".

## Interfaces from other stages

C2 is merged before this plan starts (spec "Depends on"); C4 calls it directly. C3, F7 and F3 may not have merged; C4 takes them through an option or a guarded `require` and the tests stub them.

| Contract | Exact names used | Until it merges |
|---|---|---|
| C2 program §4.3 (`src/cases/questions.js`) | `QuestionStore` `open()`, `get(id)`, `create(record)`, `recordDelivery(id, { channel, at, deliveryId })` (already idempotent on `deliveryId`, written tmp + rename), `static registerAnswerHandler(type, { toFact, onAnswered })` with `onAnswered(record, fact, { runtime, caseId })`, `expire(now)`; `QuestionError` codes `ALREADY_ANSWERED` (carries `.record`), `INVALID`, `NOT_FOUND` | merged |
| C2 program §4.20 (`src/cases/case-runtime.js`) | `CaseRuntime` `answerQuestion(caseId, qid, { channel, text, optionId })`, `acknowledgeBriefing(caseId, qid, { channel })`, `systemAction(id, label, fn)`, `createQuestion(id, record, { charge })`, `questions(id)`, `records(id).writeJournal('question', text, now)`, `ledger(id).view().facts` (a `Map`), `applyOwnerFact(id, fact)`, `listCases()`, `getCase(id)`, `root`, `host.notify`, `host.uiToast`, `host.interactive()`, `host.getExecutorRegistry()`; `CaseBusyError` (`code: 'CASE_BUSY'`) | merged |
| C2 settings, IPC, preload | `settings.cases.timeZone`; `src/cases/clock.js` `validTimeZone`, `localDay`; IPC `case:questions`, `case:answerQuestion`, `case:acknowledgeBriefing`; preload `window.electron.cases.questions`, `.answerQuestion`, `.acknowledgeBriefing`, `.onChanged` | merged |
| C3 program §4.9 (`src/cases/gates.js`) | `gateLeaves(payload, { recipients, envelope, facts, mode, caseId, entityIndex }) → { ok, blocked, rendered }`; `registry.revokeEnvelope(caseId, envelopeId, reason)` through `runtime.host.getExecutorRegistry()`; envelope approvals use options `approve` / `reject` and `payload.type` `envelope` / `envelope-delta` with `payload.envelopeId` | `ContactRouter` takes `getGate()`; `contact-host` passes `require('./gates').gateLeaves` only when it is a function, else `null` (every non-owner send refuses). Tests pass a stub `{ gateLeaves }` and a stub registry. |
| C7 | `runtime.entityIndex?.()` | called only when it is a function |
| F7 program §4.21 | `isLocalDesktopEvent(event)` in `src/core/origin.js`; `PROXIED_DOMAINS` in `src/desktop-bridge/allowlist.js` | `src/ipc/contact-handlers.js` requires `../core/origin` inside `try`; Part 3, Task 14 edits `allowlist.js` only if it exists |
| F3 program §4.13 (Part 4 only, wave 3) | `startApprovals(…) → { relayClient, approverStore, identity, … }`; `relayClient.send(envelope, { push, to_device })`, `.registerMethod(name, handler(params, { peer }))`, `.canDeliver()`; `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces })`, `NonceCache`, `bytesSha256`; `registerMessageValidator(type, fn)`, `NODE_ID_RE`, `DEVICE_ID_RE`, `NONCE_RE`, `TIMESTAMP_RE`, `randomNonce`; `seal`, `open`, `nodeSigner`, `verifyEd25519`; `src/frontdoor/extensions.js` entries `(relay) => void` receiving `{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }`; `phoneApi.registerRoute(method, pattern, { auth, rate, handler(req, ctx) })` with `ctx = { deviceId, device, params, query, body }`; `nodeHub.rpc(nodeId, method, params, { timeoutMs })`; `Mailbox.registerType(prefix, { ttlMs })`, `.put`, `.list({ nodeIds, typePrefix, toDevice })`; `devices.nodesForDevice(id) → [{ node_id, state }]`; test helpers `createFakePhone`, `testNodeIdentity`, `approverStoreWith` | Part 4 starts only after F3 merges |

## Deviations and resolved gaps (read before starting)

- **New helper modules** the spec does not name: `src/cases/contact-format.js` (policy, steps, tokens, batch text, `parseReply`, address normalization, relay `baseUrl` check), `src/cases/contact-state.js` (the `<dataDir>/contact/` files), `src/cases/contact-settings.js` (settings merge, the admin `contact` block, where the owner identity comes from), `src/channels/bridge-contact.js` (owner proof and buttons for Telegram/Discord), `src/channels/email-transports.js`.
- `LadderEngine` takes `state` (a shared `ContactState`) instead of `file`, plus `dataDir` and `hostName`. `ContactRouter` takes `state` and `getTimeZone` and adds `adapter(id)`, `knows(channelId, ref)`, `channelStatus(id)`, `firstAuthenticated()`, `recordStatus(channelId, { externalRef, relayId, status, error })`. `adapters` is any object with `get(id)` (a `Map` in tests).
- `ChannelPlugin` also gains `onContactStatus(handler)` (email DSNs) and `contactConfigured()`. Capability objects may add `idempotentSend` (relay adapters; re-sent after a restart), `requiresToken` (SMS) and `deliveryOnly` (ntfy). `message.items[]` also carry `caseId`, `questionId` and `expiresAt`; a reply `answer` may be `{ optionIndex }` (buttons, DTMF); `sendContact` may also return `relayId`.
- `Presence` also takes `interactive`, `isEnabled(channelId)`, `getTimeZone` and `log`, and exposes `timeZone()`.
- `core.context.getContact()` returns `{ ladder, presence, router }` plus the IPC helpers `ladderState()`, `getPolicy()`, `setPolicy(policy)`, `heartbeat(p)`, `presenceStatus()`. IPC results follow `wrapHandler`: `contact:ladderState → { ok: true, state }`, `contactPolicy:get → { ok: true, policy, channels }`, `presence:status → { ok: true, …Presence.status(), ladder }`.
- `QuestionStore.recordDelivery` already exists in C2 with the §4.3 contract; C4 calls it and does not edit `src/cases/questions.js`.
- A `keep` answer to a conflict follow-up still writes one `user` fact about the follow-up itself (`QuestionStore.answer` always does); it changes nothing about the original. A `change` to `approve` on a rejected envelope only records the fact (C3 has no un-reject).
- Telegram and Discord intercept a message as a contact reply when it starts with `#<token>` of a known delivery or replies to a known contact message, in **any** chat, and then refuse it unless it is owner-proven. Such messages never reach `routeAgentMessage`. Everything else takes the normal path.
- Voice `gathered` digits are applied by the router with `ownerProven: true` (the call went to the owner number); approvals are still refused there.
- A question token is the same on every channel; `ContactState.resolve(token, { channel })` prefers the delivery on that channel.
- A step deferred by quiet hours is not collapsed as "overdue" when it comes due; the ladder takes the cases-root lease only once the root exists (nothing is created on disk before the first case).
- The relay email body carries `headers` (`Message-ID`, `X-KL-Delivery`) so replies thread; §4.5 lists no headers field.
- Local `normalizeAddress` mirrors C3's `normalizeRecipient` rules (E.164 with `00` → `+`) and lowercases the whole email address.
- `src/service/run.js` reads the block with one line, `contactConfig: loadServiceConfig(dataDir).contact` (the feature log lines print twice at start). Part 4 adds a second line, `approvals,` (the F3 result), for the phone channel.
- `imapflow` 2.x no longer depends on `nodemailer` (spec §14 says it pulls it in); both are listed anyway.
- The relay `POST /v1/questions/{token}/answer` body is the envelope itself (as F3's approval response route), not `{ envelope }`; the relay forwards `{ envelope }` to the node. `GET /v1/questions` lists the mailbox for the device's active nodes (F3's `Mailbox.list` needs `nodeIds`).

---

### Task 1: The contact extension to `ChannelPlugin`, the in-app channel and the loopback test channel

**Files:**
- Modify: `src/channels/channel-plugin.js` (replace the whole file; C4 owns it, program §5)
- Create: `tests/helpers/loopback-channel.js`
- Test: `tests/contact-adapter-contract.test.js` (created here; later tasks append one `describe` per adapter)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ChannelPlugin#contactCapabilities() → caps | null`, `#sendContact(message, meta) → { deliveryId, externalRef, relayId? }` (default throws `ContactUnsupportedError`), `#onContactReply(handler)`, `#onContactStatus(handler)`, `#presence() → null`, `#ownerTarget() → string | null`, `#contactConfigured() → boolean`; `ContactDeliveryError(code, message)` with `code ∈ CONTACT_ERROR_CODES`; `ContactUnsupportedError`; `GATE_PASSED` (a `Symbol`); `DesktopChannelPlugin({ sendToUi, uiToast, isFocused })` with contact methods (owner target `'window'`); `tests/helpers/loopback-channel.js` `LoopbackChannel({ id, owner, caps, configured })` with `sent`, `plain`, `failNext(code)`, `holdNext() → release`, `reply(correlationId, answer, meta)`, `last()`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-adapter-contract.test.js`:

```js
// tests/contact-adapter-contract.test.js
// The contact adapter contract (cases stage 4 §3.1, §10): send → deliveryId;
// an owner reply → the handler with the correlation; a stranger →
// ownerProven: false; a failed send → ContactDeliveryError. Later tasks append
// one describe block per adapter.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  ChannelPlugin, DesktopChannelPlugin, ContactDeliveryError, ContactUnsupportedError, CONTACT_ERROR_CODES, GATE_PASSED
} = require('../src/channels/channel-plugin');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const ITEM = { n: 1, token: '7QD4KM', caseId: 'c-1', questionId: 'q-0001', caseTitle: 'Lakeside lot', kind: 'question', text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }], urgency: 'high', answerable: true };
const MESSAGE = { subject: 'King Louie: 1 question (1 high)', text: '1. [HIGH] Lakeside lot — Is seller financing ever acceptable?', items: [ITEM] };
const META = { expectsReply: true, options: ITEM.options, deliveryId: 'd-test-1', batchToken: 'K7QD4M', expiresAt: null, urgency: 'high' };

describe('ChannelPlugin contact defaults', () => {
  it('is inert: no capabilities, no owner target, not configured, sendContact refuses', async () => {
    const plugin = new ChannelPlugin({ id: 'plain' });
    assert.strictEqual(plugin.contactCapabilities(), null);
    assert.strictEqual(plugin.ownerTarget(), null);
    assert.strictEqual(plugin.presence(), null);
    assert.strictEqual(plugin.contactConfigured(), false);
    assert.doesNotThrow(() => plugin.onContactReply(() => {}));
    assert.doesNotThrow(() => plugin.onContactStatus(() => {}));
    await assert.rejects(plugin.sendContact(MESSAGE, META), (err) => err instanceof ContactUnsupportedError
      && err instanceof ContactDeliveryError && err.code === 'not-configured');
  });

  it('ContactDeliveryError keeps the five codes and maps anything else to unreachable', () => {
    assert.deepStrictEqual([...CONTACT_ERROR_CODES], ['not-configured', 'rejected', 'unreachable', 'too-large', 'rate-limited']);
    for (const code of CONTACT_ERROR_CODES) assert.strictEqual(new ContactDeliveryError(code, 'x').code, code);
    assert.strictEqual(new ContactDeliveryError('socket hang up').code, 'unreachable');
    assert.strictEqual(typeof GATE_PASSED, 'symbol');
  });
});

describe('contact adapter: in-app (DesktopChannelPlugin)', () => {
  it('re-surfaces each item as a banner and toasts only when the window is unfocused', async () => {
    const events = [];
    const toasts = [];
    let focused = false;
    const plugin = new DesktopChannelPlugin({
      sendToUi: (event, payload) => events.push([event, payload]),
      uiToast: { send: async (t) => { toasts.push(t); return { ok: true }; } },
      isFocused: () => focused
    });
    assert.strictEqual(plugin.contactCapabilities().authenticatedReplies, true);
    assert.strictEqual(plugin.contactCapabilities().interrupts, false);
    assert.strictEqual(plugin.ownerTarget(), 'window');
    const sent = await plugin.sendContact(MESSAGE, META);
    assert.deepStrictEqual(sent, { deliveryId: 'd-test-1', externalRef: null });
    assert.deepStrictEqual(events, [['case:changed', { caseId: 'c-1', what: 'questions', questionId: 'q-0001', attention: 'banner' }]]);
    assert.deepStrictEqual(toasts, [{ title: MESSAGE.subject, body: 'Open King Louie to answer' }]);
    focused = true;
    await plugin.sendContact(MESSAGE, META);
    assert.strictEqual(toasts.length, 1, 'no toast while the window has focus');
  });

  it('without an interactive window it is not a contact channel and refuses with not-configured', async () => {
    const plugin = new DesktopChannelPlugin({});
    assert.strictEqual(plugin.contactCapabilities(), null);
    assert.strictEqual(plugin.contactConfigured(), false);
    await assert.rejects(plugin.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'not-configured');
  });
});

describe('contact adapter: loopback (tests/helpers/loopback-channel.js)', () => {
  it('meets the contract', async () => {
    const ch = new LoopbackChannel({ id: 'telegram', owner: '111' });
    const sent = await ch.sendContact(MESSAGE, META);
    assert.strictEqual(sent.deliveryId, 'd-test-1');
    assert.strictEqual(ch.last().message.subject, MESSAGE.subject);

    const calls = [];
    ch.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' }; });
    await ch.reply('7QD4KM', { optionId: 'a' });
    assert.strictEqual(calls[0].correlationId, '7QD4KM');
    assert.strictEqual(calls[0].meta.ownerProven, true);
    assert.deepStrictEqual(ch.plain, [{ target: '111', text: 'Recorded for Lakeside lot.' }]);

    await ch.reply('7QD4KM', { text: 'no' }, { senderId: '999', ownerProven: false });
    assert.strictEqual(calls[1].meta.ownerProven, false);
    assert.strictEqual(ch.plain.length, 1, 'no ack for a stranger');

    ch.failNext('rate-limited');
    await assert.rejects(ch.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
    await assert.rejects(ch.send('999', 'hello'), /refused/);
    await ch.send('999', 'hello', { [GATE_PASSED]: true });
  });
});
```

Create `tests/helpers/loopback-channel.js`:

```js
// tests/helpers/loopback-channel.js
// A contact channel that talks to nobody (cases stage 4 §10). Tests register
// it under any contact id ('telegram', 'email', …), read what was sent, make
// the next send fail or hang, and play replies back through the handler the
// host registered with onContactReply.
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('../../src/channels/channel-plugin');

const DEFAULT_CAPS = Object.freeze({
  buttons: true,
  richText: false,
  attachments: false,
  voice: false,
  expectsReplies: true,
  authenticatedReplies: true,
  interrupts: true,
  maxOptions: 6,
  maxChars: 4000
});

class LoopbackChannel extends ChannelPlugin {
  constructor({ id = 'loopback', owner = 'owner-1', caps = {}, configured = true } = {}) {
    super({ id, label: `Loopback ${id}` });
    this.owner = owner;
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this.configured = configured;
    this.sent = [];
    this.plain = [];
    this.handler = null;
    this.failures = [];
    this.gate = null;
    this.counter = 0;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  contactCapabilities() {
    return this.configured ? { ...this.caps } : null;
  }

  ownerTarget() {
    return this.configured ? this.owner : null;
  }

  onContactReply(handler) {
    this.handler = handler;
  }

  failNext(code, message = `loopback ${code}`) {
    this.failures.push(new ContactDeliveryError(code, message));
  }

  // The next sendContact waits until the returned function is called.
  holdNext() {
    let release;
    this.gate = new Promise((resolve) => { release = resolve; });
    return () => release();
  }

  async sendContact(message, meta = {}) {
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    if (this.failures.length) throw this.failures.shift();
    this.counter += 1;
    const externalRef = `${this.id}-msg-${this.counter}`;
    this.sent.push({ message, meta, externalRef });
    return { deliveryId: meta.deliveryId, externalRef };
  }

  async send(target, text, options = {}) {
    if (target !== this.owner && options[GATE_PASSED] !== true) throw new Error('refused: not the owner and not gated');
    this.plain.push({ target, text });
    return { ok: true };
  }

  // Plays a reply. Like a real adapter, it acks only its owner target and
  // only when the router returns ack text for an owner-proven reply.
  async reply(correlationId, answer, meta = {}) {
    if (!this.handler) throw new Error('no reply handler registered');
    const full = { channel: this.id, senderId: this.owner, chatId: this.owner, at: new Date().toISOString(), ownerProven: true, ...meta };
    const result = await this.handler(correlationId, answer, full);
    if (result && result.ackText && full.ownerProven) await this.send(this.owner, result.ackText);
    return result;
  }

  last() {
    return this.sent[this.sent.length - 1] || null;
  }
}

module.exports = { LoopbackChannel, DEFAULT_CAPS };
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: FAIL — the new exports do not exist yet, e.g. `TypeError: ContactDeliveryError is not a constructor` and `plugin.contactCapabilities is not a function`.

- [ ] **Step 3: Implement**

Replace the whole of `src/channels/channel-plugin.js` with:

```js
const { createLogger } = require('../logging');
const log = createLogger('channel');

// Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.1).
// A contact send fails with exactly one of these codes, never a partial result.
const CONTACT_ERROR_CODES = Object.freeze(['not-configured', 'rejected', 'unreachable', 'too-large', 'rate-limited']);

class ContactDeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ContactDeliveryError';
    this.code = CONTACT_ERROR_CODES.includes(code) ? code : 'unreachable';
  }
}

class ContactUnsupportedError extends ContactDeliveryError {
  constructor(channelId) {
    super('not-configured', `${channelId || 'this channel'} is not a contact channel`);
    this.name = 'ContactUnsupportedError';
  }
}

// Set in a plain send()'s options only by src/cases/contact.js after the
// outbound gate passed (sendExternal). The contact adapters refuse a
// non-owner target without it.
const GATE_PASSED = Symbol('kl.contact.gatePassed');

class ChannelPlugin {
  constructor(config = {}) {
    this.id = config.id;
    this.label = config.label || config.id || 'Channel';
    this.capabilities = Array.isArray(config.capabilities)
      ? config.capabilities
      : ['send', 'receive'];
  }

  async initialize(_gateway) {
    throw new Error('initialize must be implemented by channel plugin');
  }

  async shutdown() {
    throw new Error('shutdown must be implemented by channel plugin');
  }

  normalizeTarget(rawTarget) {
    throw new Error('normalizeTarget must be implemented by channel plugin');
  }

  async send(_target, _message, _options = {}) {
    throw new Error('send must be implemented by channel plugin');
  }

  async onMessage(_handler) {}

  async listTargets() {
    return [];
  }

  getStatus() {
    return { connected: false };
  }

  supportsGroups() {
    return false;
  }

  async listGroups() {
    return [];
  }

  getMentionPattern() {
    return null;
  }

  // ---- Contact extension (stage 4 §3.1). The defaults make a plugin inert. ----

  // null: not a contact channel. Otherwise { buttons, richText, attachments,
  // voice, expectsReplies, authenticatedReplies, interrupts, maxOptions,
  // maxChars } plus the optional idempotentSend, requiresToken, deliveryOnly.
  contactCapabilities() {
    return null;
  }

  async sendContact(_message, _meta) {
    throw new ContactUnsupportedError(this.id);
  }

  // handler(correlationId, answer, meta) → Promise<{ ok, outcome, ackText }>
  onContactReply(_handler) {}

  // Delivery status learned later (an email DSN): handler({ externalRef, status, error }).
  onContactStatus(_handler) {}

  presence() {
    return null;
  }

  // The private chat, DM or address of the owner; null when not configured.
  ownerTarget() {
    return null;
  }

  // Whether the ladder may use this channel right now.
  contactConfigured() {
    const caps = this.contactCapabilities();
    if (!caps) return false;
    return caps.deliveryOnly === true || Boolean(this.ownerTarget());
  }
}

class ChannelRegistry {
  constructor() {
    this.channels = new Map();
  }

  register(channelPlugin) {
    if (!channelPlugin || !channelPlugin.id) {
      throw new Error('channelPlugin with a valid id is required');
    }
    this.channels.set(channelPlugin.id, channelPlugin);
  }

  get(id) {
    return this.channels.get(id);
  }

  unregister(id) {
    return this.channels.delete(id);
  }

  list() {
    return Array.from(this.channels.values());
  }

  async initializeAll(gateway) {
    for (const channel of this.channels.values()) {
      try {
        await channel.initialize(gateway);
      } catch (err) {
        log.child(channel.id).error(`init failed: ${err.message}`);
      }
    }
  }

  async shutdownAll() {
    for (const channel of this.channels.values()) {
      try {
        await channel.shutdown();
      } catch (err) {
        log.child(channel.id).error(`shutdown failed: ${err.message}`);
      }
    }
  }
}

const IN_APP_CAPABILITIES = Object.freeze({
  buttons: true,
  richText: false,
  attachments: false,
  voice: false,
  expectsReplies: true,
  authenticatedReplies: true,
  interrupts: false,
  maxOptions: 6,
  maxChars: 20000
});

// Also the in-app contact channel (contact id `in-app`). Stage 2 already shows
// a new question in the window; sendContact only re-surfaces items after the
// owner comes back to the desktop (§3.1). Answers arrive through
// case:answerQuestion, never through this plugin.
class DesktopChannelPlugin extends ChannelPlugin {
  constructor({ sendToUi, uiToast = null, isFocused = null } = {}) {
    super({
      id: 'desktop',
      label: 'Desktop App',
      capabilities: ['send', 'receive']
    });
    this.sendToUi = typeof sendToUi === 'function' ? sendToUi : null;
    this.uiToast = uiToast && typeof uiToast.send === 'function' ? uiToast : null;
    this.isFocused = typeof isFocused === 'function' ? isFocused : () => false;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(rawTarget = '') {
    return String(rawTarget || '').trim();
  }

  async send(target, message, options = {}) {
    if (this.sendToUi) {
      this.sendToUi('channel:message', {
        channel: 'desktop',
        target,
        message,
        media: options.media,
        buttons: options.buttons
      });
    }

    return { status: 'sent' };
  }

  contactCapabilities() {
    return this.sendToUi ? { ...IN_APP_CAPABILITIES } : null;
  }

  ownerTarget() {
    return this.sendToUi ? 'window' : null;
  }

  async sendContact(message, meta = {}) {
    if (!this.sendToUi) throw new ContactDeliveryError('not-configured', 'no interactive window');
    for (const item of message.items || []) {
      this.sendToUi('case:changed', { caseId: item.caseId, what: 'questions', questionId: item.questionId, attention: 'banner' });
    }
    if (this.uiToast && !this.isFocused()) {
      try {
        await this.uiToast.send({ title: message.subject, body: 'Open King Louie to answer' });
      } catch (err) {
        log.child('desktop').warn(`contact toast failed: ${err.message}`);
      }
    }
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }
}

module.exports = {
  ChannelPlugin,
  ChannelRegistry,
  DesktopChannelPlugin,
  ContactDeliveryError,
  ContactUnsupportedError,
  CONTACT_ERROR_CODES,
  GATE_PASSED
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-adapter-contract.test.js tests/channel-plugin.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/channel-plugin.js tests/helpers/loopback-channel.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): contact extension to ChannelPlugin, in-app channel, loopback test channel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Contact policy, ladder steps, tokens, the batch message and reply parsing

**Files:**
- Create: `src/cases/contact-format.js`
- Test: `tests/contact-format.test.js`

**Interfaces:**
- Consumes: C2 `src/cases/clock.js` `validTimeZone`.
- Produces: `CONTACT_CHANNELS`, `STEP_CHANNELS`, `URGENCIES`, `SLACK_ERROR`, `TOKEN_RE`, `DEFAULT_CONTACT_POLICY`, `defaultPolicy()`, `effectivePolicy(raw)`, `validatePolicy(input, { now }) → { ok: true, policy } | { ok: false, error }`, `resolveSteps(policy, urgency, caseChannels) → [{ channel, afterMin, digest }]`, `newToken(randomBytes?)`, `normalizeAddress(channelId, value) → string | null`, `assertRelayBaseUrl(url) → origin+path`, `formatShort(date, timeZone) → 'Sep 25 18:00'`, `renderBatch(entries, { batchToken, maxChars, maxOptions, authenticated, firstAuthenticated, timeZone }) → { subject, text, items, tooLarge }` (entries `[{ caseId, caseTitle, token, record }]`), `optionOrText(options, rest)`, `parseReply(batch, text, { threaded }) → { answers: [{ item, answer }], ack }`, `stripQuoted(text)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-format.test.js`:

```js
// tests/contact-format.test.js — cases stage 4 §3.5, §4.1, §4.4 (pure parts).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  validatePolicy, resolveSteps, defaultPolicy, effectivePolicy, newToken, TOKEN_RE, normalizeAddress,
  renderBatch, parseReply, optionOrText, stripQuoted, formatShort, SLACK_ERROR, assertRelayBaseUrl
} = require('../src/cases/contact-format');

const NOW = new Date('2026-09-25T14:00:00Z');

describe('validatePolicy', () => {
  it('accepts the default policy unchanged', () => {
    const r = validatePolicy(defaultPolicy(), { now: NOW });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.policy.ladders.high.map((s) => [s.channel, s.afterMin]), [['present', 0], ['sms', 15], ['voice', 30]]);
    assert.deepStrictEqual(r.policy.ladders.low[2], { channel: 'email', afterMin: 0, digest: true });
  });

  it('names slack and unknown channels', () => {
    const p = defaultPolicy();
    p.ladders.normal = [{ channel: 'slack' }];
    assert.deepStrictEqual(validatePolicy(p), { ok: false, error: SLACK_ERROR });
    p.ladders.normal = [{ channel: 'pager' }];
    assert.deepStrictEqual(validatePolicy(p), { ok: false, error: 'unknown contact channel "pager"' });
  });

  it('refuses decreasing afterMin, a digest before the last step, equal quiet hours and bad away', () => {
    const p = defaultPolicy();
    p.ladders.normal = [{ channel: 'present' }, { channel: 'telegram', afterMin: 30 }, { channel: 'email', afterMin: 10 }];
    assert.match(validatePolicy(p).error, /must not be smaller/);
    const q = defaultPolicy();
    q.ladders.low = [{ channel: 'email', digest: true }, { channel: 'journal' }];
    assert.match(validatePolicy(q).error, /only the last step/);
    assert.match(validatePolicy({ quietHours: { start: '22:00', end: '22:00' } }).error, /must differ/);
    assert.match(validatePolicy({ away: { mode: 'email-only' } }).error, /RFC3339/);
    assert.match(validatePolicy({ away: { mode: 'sms-only', until: '2026-09-26T00:00:00Z' } }).error, /away.mode/);
    assert.match(validatePolicy({ surprise: 1 }).error, /contactPolicy.surprise is not a known key/);
  });

  it('defaults breakthrough to high and clears a past away', () => {
    const r = validatePolicy({ quietHours: { start: '22:00', end: '07:00' }, away: { mode: 'email-only', until: '2026-09-24T00:00:00Z' } }, { now: NOW });
    assert.deepStrictEqual(r.policy.quietHours, { start: '22:00', end: '07:00', breakthrough: ['high'] });
    assert.strictEqual(r.policy.away, null);
    const future = validatePolicy({ away: { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' } }, { now: NOW });
    assert.deepStrictEqual(future.policy.away, { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' });
  });

  it('effectivePolicy fills what a stored policy leaves out', () => {
    const p = effectivePolicy({ batchDelaySec: 5 });
    assert.strictEqual(p.batchDelaySec, 5);
    assert.strictEqual(p.digest.channel, 'email');
    assert.strictEqual(p.presence.desktopIdleMin, 5);
  });
});

describe('resolveSteps and case.yaml overrides (§4.4)', () => {
  const policy = validatePolicy(defaultPolicy()).policy;

  it('uses the owner ladder by urgency', () => {
    assert.deepStrictEqual(resolveSteps(policy, 'normal').map((s) => `${s.channel}@${s.afterMin}`), ['present@0', 'telegram@30', 'email@240']);
  });

  it('a bare name takes the owner afterMin at its position, past the end last + 30; call means voice', () => {
    const steps = resolveSteps(policy, 'high', { high: ['present', 'sms', { channel: 'call', afterMin: 20 }, 'email'] });
    assert.deepStrictEqual(steps.map((s) => `${s.channel}@${s.afterMin}`), ['present@0', 'sms@15', 'voice@20', 'email@60']);
  });

  it('accepts the dotted urgency.<u> alias and drops channels the host cannot use', () => {
    const steps = resolveSteps(policy, 'normal', { 'urgency.normal': ['present', 'slack', 'email'] });
    assert.deepStrictEqual(steps.map((s) => s.channel), ['present', 'email']);
  });
});

describe('tokens and addresses', () => {
  it('makes 6-character Crockford tokens', () => {
    for (let i = 0; i < 200; i += 1) assert.match(newToken(), TOKEN_RE);
    assert.strictEqual(newToken(() => Buffer.from([0, 0, 0, 0])), '000000');
    assert.strictEqual(newToken(() => Buffer.from([255, 255, 255, 255])), 'ZZZZZZ');
  });

  it('normalizes phone numbers to E.164 and email to lowercase', () => {
    assert.strictEqual(normalizeAddress('sms', '+1 (555) 010-0'), '+15550100');
    assert.strictEqual(normalizeAddress('voice', '0015550100'), '+15550100');
    assert.strictEqual(normalizeAddress('sms', '5550100'), null);
    assert.strictEqual(normalizeAddress('email', 'Owner <Owner@Example.COM>'), 'owner@example.com');
    assert.strictEqual(normalizeAddress('email', 'not an address'), null);
    assert.strictEqual(normalizeAddress('telegram', ' 123 '), '123');
  });

  it('a relay baseUrl is https:, or http: to loopback only', () => {
    assert.strictEqual(assertRelayBaseUrl('https://relay.example.com/'), 'https://relay.example.com');
    assert.strictEqual(assertRelayBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
    assert.throws(() => assertRelayBaseUrl('http://relay.example.com'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('not a url'), /is not a URL/);
  });
});

describe('renderBatch', () => {
  const lot = { caseId: 'c-1', caseTitle: 'Sell the lakeside lot', token: '7QD4KM', record: { id: 'q-0012', kind: 'question', urgency: 'high', createdAt: '2026-09-25T13:00:00Z', expiresAt: '2026-09-25T23:00:00Z', text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] } };
  const kitchen = { caseId: 'c-2', caseTitle: 'Kitchen quotes', token: 'M2P8RT', record: { id: 'q-0003', kind: 'question', urgency: 'normal', createdAt: '2026-09-25T12:00:00Z', expiresAt: null, text: 'Which week suits the site visit?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] } };

  it('renders the spec example: high first, numbered, one batch token, expiries in the owner zone', () => {
    const m = renderBatch([kitchen, lot], { batchToken: 'K7QD4M', timeZone: 'UTC' });
    assert.strictEqual(m.subject, 'King Louie: 2 questions (1 high)');
    assert.strictEqual(m.text, [
      'King Louie: 2 questions (1 high)',
      '',
      '1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?',
      '   a) No   b) Yes, up to 20 %',
      '2. Kitchen quotes — Which week suits the site visit?',
      '   a) Oct 5   b) Oct 12',
      '',
      'Reply "#K7QD4M 1 a" / "#K7QD4M 2 a". Expires: 1) Sep 25 23:00.'
    ].join('\n'));
    assert.deepStrictEqual(m.items.map((i) => [i.n, i.token, i.questionId, i.caseId]), [[1, '7QD4KM', 'q-0012', 'c-1'], [2, 'M2P8RT', 'q-0003', 'c-2']]);
  });

  it('announces an approval without options on an unauthenticated channel', () => {
    const approval = { caseId: 'c-3', caseTitle: 'Lakeside lot', token: 'A1B2C3', record: { id: 'q-0020', kind: 'approval', urgency: 'normal', createdAt: '2026-09-25T13:00:00Z', text: 'Send the offer letter to the buyer?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] } };
    const m = renderBatch([approval], { batchToken: 'K7QD4M', authenticated: false, firstAuthenticated: 'telegram' });
    assert.strictEqual(m.items[0].answerable, false);
    assert.deepStrictEqual(m.items[0].options, []);
    assert.match(m.text, /Approval needed in Lakeside lot: Send the offer letter to the buyer\? Answer in King Louie or telegram\./);
    assert.doesNotMatch(m.text, /Reply "#/);
  });

  it('cuts long items to 280 characters when the message is over maxChars', () => {
    const long = { ...kitchen, record: { ...kitchen.record, text: 'x'.repeat(900) } };
    const m = renderBatch([long], { batchToken: 'K7QD4M', maxChars: 600 });
    assert.match(m.text, /x{280} \(open King Louie for the full text\)/);
    assert.strictEqual(m.tooLarge, false);
  });

  it('formatShort uses the zone', () => {
    assert.strictEqual(formatShort('2026-09-25T23:00:00Z', 'America/Chicago'), 'Sep 25 18:00');
  });
});

describe('parseReply', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };

  it('reads "#<batch> <n> <rest>" lines, one answer per line', () => {
    const r = parseReply(batch, '#K7QD4M 1 a\n#k7qd4m 2 Oct 12.');
    assert.deepStrictEqual(r.answers.map((a) => [a.item.n, a.answer]), [[1, { optionId: 'a' }], [2, { optionId: 'b' }]]);
    assert.strictEqual(r.ack, null);
  });

  it('reads "#<questionToken> <answer>" and free text', () => {
    const r = parseReply(batch, '#M2P8RT the week after, please');
    assert.deepStrictEqual(r.answers.map((a) => [a.item.n, a.answer]), [[2, { text: 'the week after, please' }]]);
  });

  it('a single-item batch takes "#<batch> <rest>"; a threaded reply may omit the token', () => {
    const one = { batchToken: 'K7QD4M', items: [batch.items[0]] };
    assert.deepStrictEqual(parseReply(one, '#K7QD4M no!').answers[0].answer, { optionId: 'a' });
    assert.deepStrictEqual(parseReply(one, 'yes, up to 20 %', { threaded: true }).answers[0].answer, { optionId: 'b' });
    assert.deepStrictEqual(parseReply(batch, '2 b', { threaded: true }).answers[0].item.n, 2);
  });

  it('anything else is not parsed and asks which question', () => {
    const r = parseReply(batch, 'sounds good');
    assert.deepStrictEqual(r.answers, []);
    assert.strictEqual(r.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
    assert.strictEqual(parseReply(batch, '#K7QD4M maybe').answers.length, 0, 'a two-item batch needs the number');
  });

  it('optionOrText matches id or label case-insensitively', () => {
    assert.deepStrictEqual(optionOrText([{ id: 'keep', label: 'Keep "No"' }], ' KEEP. '), { optionId: 'keep' });
    assert.deepStrictEqual(optionOrText([{ id: 'a', label: 'No' }], 'not sure'), { text: 'not sure' });
  });
});

describe('stripQuoted', () => {
  it('drops quoted lines and the history after "On … wrote:"', () => {
    const body = '#K7QD4M 1 a\nthanks\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n> King Louie: 1 question\n> 1. Lakeside lot';
    assert.strictEqual(stripQuoted(body), '#K7QD4M 1 a\nthanks');
    assert.strictEqual(stripQuoted('> quoted only\nreal line'), 'real line');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-format.test.js`
Expected: FAIL with `Cannot find module '../src/cases/contact-format'`

- [ ] **Step 3: Implement**

Create `src/cases/contact-format.js`:

```js
// src/cases/contact-format.js
// Pure pieces of the contact ladder (cases stage 4 spec §3.5, §4.1, §4.4):
// the policy and its validation, ladder steps, tokens, the batch message,
// reply parsing and address normalization. No I/O.
const crypto = require('crypto');
const { validTimeZone } = require('./clock');

const CONTACT_CHANNELS = Object.freeze(['in-app', 'telegram', 'discord', 'email', 'sms', 'voice', 'ntfy', 'mobile']);
const STEP_CHANNELS = Object.freeze(['present', 'journal', ...CONTACT_CHANNELS]);
const URGENCIES = Object.freeze(['low', 'normal', 'high']);
const SLACK_ERROR = 'slack is not a contact channel: it has no sender allowlist';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TRUNCATE_AT = 280;
const TRUNCATED = ' (open King Louie for the full text)';

const DEFAULT_CONTACT_POLICY = Object.freeze({
  batchDelaySec: 60,
  ladders: {
    low: [{ channel: 'in-app' }, { channel: 'journal' }, { channel: 'email', digest: true }],
    normal: [{ channel: 'present' }, { channel: 'telegram', afterMin: 30 }, { channel: 'email', afterMin: 240 }],
    high: [{ channel: 'present' }, { channel: 'sms', afterMin: 15 }, { channel: 'voice', afterMin: 30 }]
  },
  quietHours: null,
  away: null,
  digest: { channel: 'email', at: '08:00' },
  presence: { desktopIdleMin: 5, recentInboundMin: 10 }
});

const clone = (v) => JSON.parse(JSON.stringify(v));

function defaultPolicy() {
  return clone(DEFAULT_CONTACT_POLICY);
}

// Fills missing top-level fields from the default; used when reading settings.
function effectivePolicy(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = defaultPolicy();
  return {
    batchDelaySec: Number.isInteger(p.batchDelaySec) && p.batchDelaySec >= 0 ? p.batchDelaySec : d.batchDelaySec,
    ladders: { ...d.ladders, ...(p.ladders && typeof p.ladders === 'object' ? p.ladders : {}) },
    quietHours: p.quietHours === undefined ? d.quietHours : p.quietHours,
    away: p.away === undefined ? d.away : p.away,
    digest: p.digest === undefined ? d.digest : p.digest,
    presence: { ...d.presence, ...(p.presence && typeof p.presence === 'object' ? p.presence : {}) }
  };
}

function channelError(name) {
  if (name === 'slack') return SLACK_ERROR;
  if (!STEP_CHANNELS.includes(name)) return `unknown contact channel "${name}"`;
  return null;
}

// §4.1. Returns { ok: true, policy } (normalized; a past away is cleared) or
// { ok: false, error }.
function validatePolicy(input, { now = new Date() } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('the contact policy must be an object');
  const known = ['batchDelaySec', 'ladders', 'quietHours', 'away', 'digest', 'presence'];
  for (const key of Object.keys(input)) if (!known.includes(key)) return fail(`contactPolicy.${key} is not a known key`);
  const p = effectivePolicy(input);
  if (input.batchDelaySec !== undefined && (!Number.isInteger(input.batchDelaySec) || input.batchDelaySec < 0)) {
    return fail('batchDelaySec must be an integer ≥ 0');
  }
  const ladders = {};
  for (const u of Object.keys(p.ladders)) {
    if (!URGENCIES.includes(u)) return fail(`ladders.${u} is not an urgency (low, normal, high)`);
    const steps = p.ladders[u];
    if (!Array.isArray(steps) || steps.length === 0) return fail(`ladders.${u} must be a non-empty list of steps`);
    let last = 0;
    ladders[u] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      if (!s || typeof s !== 'object' || typeof s.channel !== 'string') return fail(`ladders.${u}[${i}] needs a channel`);
      const err = channelError(s.channel);
      if (err) return fail(err);
      const afterMin = s.afterMin === undefined ? (i === 0 ? 0 : last) : s.afterMin;
      if (!Number.isInteger(afterMin) || afterMin < 0) return fail(`ladders.${u}[${i}].afterMin must be an integer ≥ 0`);
      if (afterMin < last) return fail(`ladders.${u}[${i}].afterMin must not be smaller than the step before it`);
      if (s.digest !== undefined && typeof s.digest !== 'boolean') return fail(`ladders.${u}[${i}].digest must be true or false`);
      if (s.digest === true && i !== steps.length - 1) return fail(`ladders.${u}[${i}]: only the last step can be a digest step`);
      last = afterMin;
      ladders[u].push({ channel: s.channel, afterMin, ...(s.digest === true ? { digest: true } : {}) });
    }
  }
  let quietHours = null;
  if (p.quietHours !== null) {
    const q = p.quietHours;
    if (!q || typeof q !== 'object') return fail('quietHours must be null or { start, end, breakthrough }');
    if (!HHMM.test(String(q.start)) || !HHMM.test(String(q.end))) return fail('quietHours.start and end must be HH:MM');
    if (q.start === q.end) return fail('quietHours.start and end must differ');
    const breakthrough = q.breakthrough === undefined ? ['high'] : q.breakthrough;
    if (!Array.isArray(breakthrough) || !breakthrough.every((u) => URGENCIES.includes(u))) return fail('quietHours.breakthrough must list urgencies');
    quietHours = { start: q.start, end: q.end, breakthrough: [...breakthrough] };
  }
  let away = null;
  if (p.away !== null) {
    const a = p.away;
    if (!a || typeof a !== 'object') return fail('away must be null or { mode, until }');
    if (!['email-only', 'in-app-only'].includes(a.mode)) return fail('away.mode must be email-only or in-app-only');
    if (typeof a.until !== 'string' || !RFC3339.test(a.until) || !Number.isFinite(Date.parse(a.until))) return fail('away.until must be an RFC3339 date-time');
    away = Date.parse(a.until) > now.getTime() ? { mode: a.mode, until: a.until } : null;
  }
  let digest = null;
  if (p.digest !== null) {
    const d = p.digest;
    if (!d || typeof d !== 'object') return fail('digest must be null or { channel, at }');
    const err = channelError(d.channel);
    if (err) return fail(err);
    if (['present', 'journal'].includes(d.channel)) return fail('digest.channel must be a contact channel');
    if (!HHMM.test(String(d.at))) return fail('digest.at must be HH:MM');
    digest = { channel: d.channel, at: d.at };
  }
  const presence = {};
  for (const key of ['desktopIdleMin', 'recentInboundMin']) {
    const v = p.presence[key];
    if (!Number.isInteger(v) || v < 1) return fail(`presence.${key} must be an integer ≥ 1`);
    presence[key] = v;
  }
  return { ok: true, policy: { batchDelaySec: p.batchDelaySec, ladders, quietHours, away, digest, presence } };
}

// The steps for one question: the owner ladder, replaced by case.yaml
// `channels[urgency]` (or the dotted `urgency.<u>` alias) when present (§4.4).
// Names the host cannot use are dropped; `call` means `voice`.
function resolveSteps(policy, urgency, caseChannels = null) {
  const base = (policy.ladders && policy.ladders[urgency]) || policy.ladders?.normal || [];
  let prev = 0;
  const owner = base.map((s) => {
    prev = Number.isInteger(s.afterMin) ? s.afterMin : prev;
    return { channel: s.channel, afterMin: prev, digest: s.digest === true };
  });
  let override = null;
  if (caseChannels && typeof caseChannels === 'object') {
    override = caseChannels[urgency] ?? caseChannels[`urgency.${urgency}`] ?? null;
  }
  let steps = owner;
  if (Array.isArray(override) && override.length) {
    steps = override.map((raw, i) => {
      const s = typeof raw === 'string' ? { channel: raw } : (raw && typeof raw === 'object' ? raw : {});
      const channel = s.channel === 'call' ? 'voice' : s.channel;
      let afterMin = s.afterMin;
      if (!Number.isInteger(afterMin) || afterMin < 0) {
        afterMin = i < owner.length ? owner[i].afterMin : (owner.length ? owner[owner.length - 1].afterMin : 0) + 30 * (i - owner.length + 1);
      }
      return { channel, afterMin, digest: s.digest === true };
    });
  }
  let last = 0;
  return steps
    .filter((s) => STEP_CHANNELS.includes(s.channel))
    .map((s) => {
      last = Math.max(last, s.afterMin);
      return { channel: s.channel, afterMin: last, digest: s.digest };
    });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

// A contact relay's baseUrl: `https:`, or `http:` to loopback only (SSRF, §8).
function assertRelayBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    throw new Error(`relay baseUrl "${baseUrl}" is not a URL`);
  }
  if (u.protocol === 'https:') return u.origin + u.pathname.replace(/\/$/, '');
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u.origin + u.pathname.replace(/\/$/, '');
  throw new Error(`relay baseUrl must be https:, or http: to loopback (got ${u.protocol}//${u.hostname})`);
}

// Six Crockford base32 characters (30 bits) from crypto.randomBytes.
function newToken(randomBytes = crypto.randomBytes) {
  const n = randomBytes(4).readUInt32BE(0) >>> 2;
  let out = '';
  for (let i = 5; i >= 0; i -= 1) out += CROCKFORD[(n >>> (i * 5)) & 31];
  return out;
}

function normalizeAddress(channelId, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (channelId === 'sms' || channelId === 'voice') {
    let s = raw.replace(/[\s\-.()]/g, '');
    if (s.startsWith('00')) s = `+${s.slice(2)}`;
    return /^\+\d{8,15}$/.test(s) ? s : null;
  }
  if (channelId === 'email') {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
    const addr = (m ? m[1] : raw).toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
  }
  return raw;
}

const FORMATTERS = new Map();
function formatter(timeZone) {
  const tz = validTimeZone(timeZone) || '';
  if (!FORMATTERS.has(tz)) {
    FORMATTERS.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }));
  }
  return FORMATTERS.get(tz);
}

// 'Sep 25 18:00' in the owner's zone.
function formatShort(date, timeZone) {
  const p = {};
  for (const part of formatter(timeZone).formatToParts(new Date(date))) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.month} ${p.day} ${p.hour}:${p.minute}`;
}

const URGENCY_RANK = { high: 0, normal: 1, low: 2 };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function subjectFor(items) {
  const kinds = new Set(items.map((i) => i.kind));
  const noun = kinds.size === 1 ? [...kinds][0] : 'item';
  const high = items.filter((i) => i.urgency === 'high').length;
  return `King Louie: ${plural(items.length, noun)}${high ? ` (${high} high)` : ''}`;
}

// entries: [{ caseId, caseTitle, token, record }] across cases. Returns the
// §3.1 message { subject, text, items }. On a channel without authenticated
// replies an approval is only announced (answerable: false).
function renderBatch(entries, {
  batchToken, maxChars = 4000, maxOptions = 6, authenticated = true,
  firstAuthenticated = 'the King Louie app', timeZone = '', truncate = false
} = {}) {
  const sorted = [...entries].sort((a, b) => (URGENCY_RANK[a.record.urgency] ?? 1) - (URGENCY_RANK[b.record.urgency] ?? 1)
    || String(a.record.createdAt).localeCompare(String(b.record.createdAt)));
  const items = sorted.map((e, i) => {
    const r = e.record;
    const answerable = !(r.kind === 'approval' && !authenticated);
    let text = r.text;
    if (truncate && text.length > TRUNCATE_AT) text = `${text.slice(0, TRUNCATE_AT)}${TRUNCATED}`;
    if (!answerable) text = `Approval needed in ${e.caseTitle}: ${text} Answer in King Louie or ${firstAuthenticated}.`;
    const options = answerable ? (r.options || []).slice(0, maxOptions) : [];
    return {
      n: i + 1, token: e.token, caseId: e.caseId, questionId: r.id, caseTitle: e.caseTitle,
      kind: r.kind, text, options, urgency: r.urgency, answerable, expiresAt: r.expiresAt || null
    };
  });
  const lines = [subjectFor(items), ''];
  for (const it of items) {
    const tag = it.urgency === 'high' ? '[HIGH] ' : '';
    lines.push(it.answerable ? `${it.n}. ${tag}${it.caseTitle} — ${it.text}` : `${it.n}. ${tag}${it.text}`);
    if (it.options.length) lines.push(`   ${it.options.map((o) => `${o.id}) ${o.label}`).join('   ')}`);
  }
  const replyable = items.filter((it) => it.answerable && it.kind !== 'briefing');
  if (replyable.length) {
    const hint = (it) => {
      const answer = it.options.length ? it.options[0].id : '<answer>';
      return items.length === 1 ? `"#${batchToken} ${answer}"` : `"#${batchToken} ${it.n} ${answer}"`;
    };
    let footer = `Reply ${replyable.slice(0, 2).map(hint).join(' / ')}.`;
    const expiring = items.filter((it) => it.expiresAt);
    if (expiring.length) footer += ` Expires: ${expiring.map((it) => `${it.n}) ${formatShort(it.expiresAt, timeZone)}`).join(', ')}.`;
    lines.push('', footer);
  }
  let text = lines.join('\n');
  if (text.length > maxChars && !truncate) {
    return renderBatch(entries, { batchToken, maxChars, maxOptions, authenticated, firstAuthenticated, timeZone, truncate: true });
  }
  return { subject: subjectFor(items), text, items, tooLarge: text.length > maxChars };
}

const TRAILING = /[\s.!?,;:]+$/;

// `<rest>` names an option when it equals an option id or label
// (case-insensitive, trimmed, trailing punctuation dropped), else it is text.
function optionOrText(options, rest) {
  const raw = String(rest ?? '').trim();
  const key = raw.replace(TRAILING, '').toLowerCase();
  const hit = (options || []).find((o) => o.id.toLowerCase() === key || String(o.label).trim().toLowerCase() === key);
  return hit ? { optionId: hit.id } : { text: raw };
}

const WHICH = (batchToken) => `Which question? Reply "#${batchToken} <n> <answer>".`;

// batch: { batchToken, items: [{ n, token, options }] }. `threaded`: the reply
// is already tied to this batch (a Telegram/Discord reply, an email in the
// thread), so the #TOKEN may be left out. Returns { answers: [{ item, answer }],
// ack } where ack is set only when nothing parsed.
function parseReply(batch, text, { threaded = false } = {}) {
  const items = batch.items || [];
  const byN = (n) => items.find((it) => it.n === n) || null;
  const answers = [];
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = /^#([0-9A-Za-z]{6})\b\s*(.*)$/.exec(line);
    let rest = line;
    if (m) {
      const token = m[1].toUpperCase();
      rest = m[2];
      const q = items.find((it) => it.token === token);
      if (q) {
        if (rest) answers.push({ item: q, answer: optionOrText(q.options, rest) });
        continue;
      }
      if (token !== batch.batchToken) continue;
    } else if (!threaded) {
      continue;
    }
    const numbered = /^(\d{1,2})[.)]?\s+(.+)$/.exec(rest);
    if (numbered && byN(Number(numbered[1]))) {
      const it = byN(Number(numbered[1]));
      answers.push({ item: it, answer: optionOrText(it.options, numbered[2]) });
    } else if (items.length === 1 && rest) {
      answers.push({ item: items[0], answer: optionOrText(items[0].options, rest) });
    }
  }
  return answers.length ? { answers, ack: null } : { answers: [], ack: WHICH(batch.batchToken) };
}

// Email bodies: drop `>` lines and everything from an "On … wrote:" line.
function stripQuoted(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*On\b.*\bwrote:\s*$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

module.exports = {
  CONTACT_CHANNELS,
  STEP_CHANNELS,
  URGENCIES,
  SLACK_ERROR,
  TOKEN_RE,
  DEFAULT_CONTACT_POLICY,
  defaultPolicy,
  effectivePolicy,
  validatePolicy,
  resolveSteps,
  newToken,
  normalizeAddress,
  assertRelayBaseUrl,
  formatShort,
  renderBatch,
  optionOrText,
  parseReply,
  stripQuoted
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-format.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/contact-format.js tests/contact-format.test.js
git commit -m "feat(contact): policy, ladder steps, tokens, batch text and reply parsing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Presence

**Files:**
- Create: `src/cases/presence.js`
- Test: `tests/contact-presence.test.js`

**Interfaces:**
- Consumes: `effectivePolicy`, `CONTACT_CHANNELS` (Task 2); C2 `validTimeZone`.
- Produces: `Presence({ file, getPolicy, clock, interactive, isEnabled, getTimeZone, log })` with `heartbeat({ focused, lastInputAt }) → { ok: true }`, `mobileForeground({ deviceId, foreground })`, `noteInbound(channelId, at?)`, `presentChannel(now) → channelId | null`, `desktopPresentSince() → Date | null`, `inQuietHours(now)`, `nextQuietEnd(now) → Date`, `timeZone() → string`, `status(now) → { presentChannel, away, quiet, timeZoneSource, signals: { desktop, mobile, channels } }`; `wallHhmm(date, tz)`, `HEARTBEAT_STALE_MS`, `MOBILE_STALE_MS`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-presence.test.js`:

```js
// tests/contact-presence.test.js — cases stage 4 §3.4.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Presence } = require('../src/cases/presence');
const { defaultPolicy } = require('../src/cases/contact-format');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-presence-')); dirs.push(d); return path.join(d, 'contact', 'presence.json'); };

function make({ policy = defaultPolicy(), interactive = true, enabled = ['telegram', 'email', 'sms', 'mobile'], tz = 'UTC', start = '2026-09-25T14:00:00Z' } = {}) {
  let now = new Date(start);
  const presence = new Presence({
    file: tmpFile(),
    getPolicy: () => policy,
    clock: () => now,
    interactive: () => interactive,
    isEnabled: (c) => enabled.includes(c),
    getTimeZone: () => tz
  });
  return { presence, advance: (ms) => { now = new Date(now.getTime() + ms); return now; }, at: (iso) => { now = new Date(iso); return now; }, now: () => now };
}

describe('presentChannel (§3.4 table)', () => {
  it('no candidates → null', () => {
    const { presence } = make();
    assert.strictEqual(presence.presentChannel(), null);
  });

  it('desktop is present only while the heartbeat is fresh, focused and recently used', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
    t.advance(91 * 1000);
    assert.strictEqual(t.presence.presentChannel(), null, 'heartbeat older than 90 s');
    t.presence.heartbeat({ focused: false, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), null, 'unfocused');
    t.presence.heartbeat({ focused: true, lastInputAt: new Date(t.now().getTime() - 6 * 60000).toISOString() });
    assert.strictEqual(t.presence.presentChannel(), null, 'idle longer than desktopIdleMin');
  });

  it('clamps a lastInputAt in the future to now', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: '2027-01-01T00:00:00Z' });
    assert.strictEqual(t.presence.status().signals.desktop.lastInputAt, t.now().toISOString());
  });

  it('a channel counts when enabled and owner-proven inbound is recent', () => {
    const t = make();
    t.presence.noteInbound('telegram');
    assert.strictEqual(t.presence.presentChannel(), 'telegram');
    t.advance(11 * 60000);
    assert.strictEqual(t.presence.presentChannel(), null);
    t.presence.noteInbound('discord');
    assert.strictEqual(t.presence.presentChannel(), null, 'discord is not enabled');
  });

  it('persists only channel last-seen times', () => {
    const t = make();
    t.presence.noteInbound('telegram');
    t.presence.heartbeat({ focused: true });
    const again = new Presence({ file: t.presence.file, getPolicy: () => defaultPolicy(), clock: t.now, interactive: () => true, isEnabled: () => true });
    assert.deepStrictEqual(Object.keys(again.status().signals.channels), ['telegram']);
    assert.strictEqual(again.status().signals.desktop, null);
  });

  it('both present: the one touched last wins (desktop and phone app)', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: new Date(t.now().getTime() - 30000).toISOString() });
    t.presence.mobileForeground({ deviceId: 'd-aaaaaaaaaaaaaaaa', foreground: true });
    assert.strictEqual(t.presence.presentChannel(), 'mobile');
    t.advance(10000);
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
    t.advance(121 * 1000);
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app', 'the mobile ping is stale after 120 s');
  });

  it('ties go to the desktop, then mobile, then ladder order', () => {
    const t = make();
    const at = t.now().toISOString();
    t.presence.heartbeat({ focused: true, lastInputAt: at });
    t.presence.mobileForeground({ deviceId: 'd-aaaaaaaaaaaaaaaa' });
    t.presence.noteInbound('telegram', t.now());
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
  });

  it('away overrides everything', () => {
    const policy = { ...defaultPolicy(), away: { mode: 'email-only', until: '2026-09-26T00:00:00Z' } };
    const t = make({ policy });
    t.presence.heartbeat({ focused: true });
    assert.strictEqual(t.presence.presentChannel(), 'email');
    assert.strictEqual(t.presence.status().away, true);
    const noEmail = make({ policy, enabled: [] });
    assert.strictEqual(noEmail.presence.presentChannel(), null);
    const inApp = make({ policy: { ...defaultPolicy(), away: { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' } }, interactive: false });
    assert.strictEqual(inApp.presence.presentChannel(), null, 'in-app-only without an interactive host');
  });

  it('desktopPresentSince is the latest absent → present transition', () => {
    const t = make();
    assert.strictEqual(t.presence.desktopPresentSince(), null);
    t.presence.heartbeat({ focused: true });
    const first = t.now().toISOString();
    assert.strictEqual(t.presence.desktopPresentSince().toISOString(), first);
    t.advance(100 * 1000);
    assert.strictEqual(t.presence.presentChannel(), null);
    t.presence.heartbeat({ focused: true });
    assert.strictEqual(t.presence.desktopPresentSince().toISOString(), t.now().toISOString());
  });

  it('reports the time zone source', () => {
    assert.strictEqual(make({ tz: 'America/Chicago' }).presence.status().timeZoneSource, 'settings');
    assert.strictEqual(make({ tz: '' }).presence.status().timeZoneSource, 'host');
  });
});

describe('quiet hours', () => {
  const quiet = (start, end) => ({ ...defaultPolicy(), quietHours: { start, end, breakthrough: ['high'] } });

  it('a window across midnight', () => {
    const t = make({ policy: quiet('22:00', '07:00') });
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T23:10:00Z')), true);
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T06:59:00Z')), true);
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T07:00:00Z')), false);
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2026-09-25T23:10:30Z')).toISOString(), '2026-09-26T07:00:00.000Z');
  });

  it('DST quiet hours: fall-back (America/Chicago, 2026-11-01) ends at 07:00 CST', () => {
    const t = make({ policy: quiet('22:00', '07:00'), tz: 'America/Chicago' });
    // 23:30 CDT on Oct 31 is 04:30Z; 07:00 CST on Nov 1 is 13:00Z.
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-11-01T04:30:00Z')), true);
    assert.strictEqual(t.presence.nextQuietEnd(t.now()).toISOString(), '2026-11-01T13:00:00.000Z');
  });

  it('DST quiet hours: an end in the repeated hour resolves to its first occurrence', () => {
    const t = make({ policy: quiet('22:00', '01:30'), tz: 'America/Chicago' });
    // 01:30 CDT (first occurrence) is 06:30Z; 01:30 CST would be 07:30Z.
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2026-11-01T04:30:00Z')).toISOString(), '2026-11-01T06:30:00.000Z');
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-11-01T07:10:00Z')), true, 'the repeated 01:10 is inside the window again');
  });

  it('DST quiet hours: an end in the spring-forward gap resolves to 03:00 (America/Chicago, 2027-03-14)', () => {
    const t = make({ policy: quiet('22:00', '02:30'), tz: 'America/Chicago' });
    // 23:00 CST on Mar 13 is 05:00Z; 02:30 does not exist; 03:00 CDT is 08:00Z.
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2027-03-14T05:00:00Z')).toISOString(), '2027-03-14T08:00:00.000Z');
  });

  it('no quiet hours: never quiet', () => {
    const t = make();
    assert.strictEqual(t.presence.inQuietHours(), false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-presence.test.js`
Expected: FAIL with `Cannot find module '../src/cases/presence'`

- [ ] **Step 3: Implement**

Create `src/cases/presence.js`:

```js
// src/cases/presence.js
// Where the owner is right now (cases stage 4 spec §3.4): the desktop
// heartbeat, the phone app's foreground pings and owner-proven inbound on
// each channel. Only the per-channel last-seen times persist.
const fs = require('fs');
const path = require('path');
const { validTimeZone } = require('./clock');
const { effectivePolicy, CONTACT_CHANNELS } = require('./contact-format');
const { createLogger } = require('../logging');

const HEARTBEAT_STALE_MS = 90 * 1000;
const MOBILE_STALE_MS = 120 * 1000;
const MINUTE = 60 * 1000;
const STEP_LIMIT = 26 * 60;

const WALL = new Map();
function wallFormatter(tz) {
  const key = tz || '';
  if (!WALL.has(key)) {
    WALL.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }));
  }
  return WALL.get(key);
}

// 'HH:MM' on the wall clock of `tz` at instant `date`.
function wallHhmm(date, tz) {
  const p = {};
  for (const part of wallFormatter(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.hour}:${p.minute}`;
}

function inWindow(hhmm, start, end) {
  return start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
}

class Presence {
  constructor({
    file, getPolicy = () => ({}), clock = () => new Date(), interactive = () => false, isEnabled = () => false,
    getTimeZone = () => '', log = createLogger('contact/presence')
  } = {}) {
    this.file = file;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.interactive = interactive;
    this.isEnabled = isEnabled;
    this.getTimeZone = getTimeZone;
    this.log = log;
    this.desktop = null;
    this.mobile = new Map();
    this.channels = this._load();
    this._desktopWasPresent = false;
    this._presentSince = null;
    this._hostZoneLogged = false;
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data.channels === 'object' && data.channels ? { ...data.channels } : {};
    } catch {
      return {};
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, channels: this.channels }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  policy() {
    return effectivePolicy(this.getPolicy());
  }

  timeZone() {
    const tz = validTimeZone(this.getTimeZone());
    if (!tz && !this._hostZoneLogged) {
      this._hostZoneLogged = true;
      this.log.info('settings.cases.timeZone is empty; contact times use the host time zone');
    }
    return tz || '';
  }

  // Desktop IPC. lastInputAt is clamped to now; memory only.
  heartbeat({ focused = false, lastInputAt = null } = {}) {
    const now = this.clock();
    const input = Date.parse(lastInputAt);
    const clamped = Number.isFinite(input) ? Math.min(input, now.getTime()) : now.getTime();
    this.desktop = { at: now.getTime(), focused: focused === true, lastInputAt: clamped };
    this._track(now);
    return { ok: true };
  }

  mobileForeground({ deviceId, foreground = true } = {}) {
    if (!deviceId) return { ok: false };
    this.mobile.set(String(deviceId), { at: this.clock().getTime(), foreground: foreground === true });
    return { ok: true };
  }

  // Owner-proven inbound only.
  noteInbound(channelId, at = this.clock()) {
    const t = new Date(at).toISOString();
    if (!this.channels[channelId] || this.channels[channelId] < t) {
      this.channels[channelId] = t;
      this._save();
    }
  }

  _desktopPresent(nowMs) {
    const d = this.desktop;
    if (!d || !this.interactive()) return false;
    const idleMs = this.policy().presence.desktopIdleMin * MINUTE;
    return nowMs - d.at <= HEARTBEAT_STALE_MS && d.focused && nowMs - d.lastInputAt <= idleMs;
  }

  _track(now) {
    const present = this._desktopPresent(now.getTime());
    if (present && !this._desktopWasPresent) this._presentSince = new Date(now.getTime());
    this._desktopWasPresent = present;
    return present;
  }

  // The latest absent → present transition of the desktop.
  desktopPresentSince() {
    this._track(this.clock());
    return this._presentSince;
  }

  _mobileLatest(nowMs) {
    let best = null;
    for (const m of this.mobile.values()) {
      if (m.foreground && nowMs - m.at <= MOBILE_STALE_MS && (!best || m.at > best)) best = m.at;
    }
    return best;
  }

  _ladderOrder(policy) {
    const order = [];
    for (const u of ['high', 'normal', 'low']) {
      for (const s of policy.ladders[u] || []) if (CONTACT_CHANNELS.includes(s.channel) && !order.includes(s.channel)) order.push(s.channel);
    }
    for (const c of CONTACT_CHANNELS) if (!order.includes(c)) order.push(c);
    return order;
  }

  _awayActive(policy, nowMs) {
    return Boolean(policy.away && Date.parse(policy.away.until) > nowMs);
  }

  presentChannel(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    if (this._awayActive(policy, nowMs)) {
      if (policy.away.mode === 'email-only') return this.isEnabled('email') ? 'email' : null;
      return this.interactive() ? 'in-app' : null;
    }
    const candidates = [];
    if (this._track(now)) candidates.push({ channel: 'in-app', at: this.desktop.lastInputAt, rank: 0 });
    const mobileAt = this.isEnabled('mobile') ? this._mobileLatest(nowMs) : null;
    if (mobileAt !== null) candidates.push({ channel: 'mobile', at: mobileAt, rank: 1 });
    const recentMs = policy.presence.recentInboundMin * MINUTE;
    const order = this._ladderOrder(policy);
    for (const [channel, iso] of Object.entries(this.channels)) {
      const at = Date.parse(iso);
      if (channel === 'in-app' || channel === 'mobile') continue;
      if (!this.isEnabled(channel) || !Number.isFinite(at) || nowMs - at > recentMs) continue;
      candidates.push({ channel, at, rank: 2 + order.indexOf(channel) });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.at - a.at || a.rank - b.rank);
    return candidates[0].channel;
  }

  inQuietHours(now = this.clock()) {
    const q = this.policy().quietHours;
    if (!q) return false;
    return inWindow(wallHhmm(now, this.timeZone()), q.start, q.end);
  }

  // The first whole minute at or after `now` outside the quiet window. An end
  // inside a spring-forward gap lands on the first minute that exists after
  // it; in a fall-back repeat, on the first occurrence.
  nextQuietEnd(now = this.clock()) {
    const q = this.policy().quietHours;
    if (!q) return new Date(now.getTime());
    const tz = this.timeZone();
    let t = Math.ceil(now.getTime() / MINUTE) * MINUTE;
    for (let i = 0; i <= STEP_LIMIT; i += 1, t += MINUTE) {
      if (!inWindow(wallHhmm(new Date(t), tz), q.start, q.end)) return new Date(t);
    }
    return new Date(t);
  }

  status(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    const desktop = this.desktop
      ? { present: this._desktopPresent(nowMs), heartbeatAt: new Date(this.desktop.at).toISOString(), focused: this.desktop.focused, lastInputAt: new Date(this.desktop.lastInputAt).toISOString() }
      : null;
    const mobileAt = this._mobileLatest(nowMs);
    return {
      presentChannel: this.presentChannel(now),
      away: this._awayActive(policy, nowMs),
      quiet: this.inQuietHours(now),
      timeZoneSource: validTimeZone(this.getTimeZone()) ? 'settings' : 'host',
      signals: {
        desktop,
        mobile: mobileAt === null ? null : { present: true, lastPingAt: new Date(mobileAt).toISOString() },
        channels: { ...this.channels }
      }
    };
  }
}

module.exports = { Presence, wallHhmm, HEARTBEAT_STALE_MS, MOBILE_STALE_MS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-presence.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/presence.js tests/contact-presence.test.js
git commit -m "feat(contact): presence, quiet hours and the DST rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The contact state files

**Files:**
- Create: `src/cases/contact-state.js`
- Test: `tests/contact-state.test.js`

**Interfaces:**
- Consumes: `newToken` (Task 2).
- Produces: `ContactState({ dir, clock, log, readOnly })` over `<dataDir>/contact/` with `ladder()` / `saveLadder()` (`{ version: 1, entries, digest: { lastSentDay }, pins }`), `deliveries()` / `saveDeliveries()`, `recordDelivery(id, delivery)`, `newToken()`, `newDeliveryId()`, `resolve(correlationId, { channel }) → { deliveryId, delivery, item } | null`, `isKnownToken(token)`, `setDeliveryStatus(match, status, error)`, `pruneDeliveries(isOpen(caseId, qid))`, `pin(key, channel)`, `takePin(key)`, `appendInbox(line)`, `readInbox()`, `writeInbox(lines)`, `readCursor(name)`, `writeCursor(name, cursor)`, `markEventSeen(id) → boolean`; `emptyLadder()`, `writeAtomic(file, text)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-state.test.js`:

```js
// tests/contact-state.test.js — cases stage 4 §4.2, §4.3 (files under <dataDir>/contact/).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactState } = require('../src/cases/contact-state');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-contact-state-')); dirs.push(d); return path.join(d, 'contact'); };
const NOW = new Date('2026-09-25T14:00:00Z');

function delivery(overrides = {}) {
  return {
    channel: 'telegram', at: NOW.toISOString(), externalRef: '4812', batchToken: 'K7QD4M', idempotencyKey: 'd-1', status: 'sent',
    items: [{ n: 1, caseId: 'c-1', questionId: 'q-0012', token: '7QD4KM', kind: 'question' }],
    ...overrides
  };
}

describe('ContactState', () => {
  it('starts empty and writes ladder.json atomically', () => {
    const dir = tmp();
    const s = new ContactState({ dir, clock: () => NOW });
    assert.deepStrictEqual(s.ladder(), { version: 1, entries: {}, digest: { lastSentDay: null }, pins: {} });
    s.ladder().entries['c-1/q-0001'] = { token: 'AAAAAA' };
    s.saveLadder();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ladder.json'), 'utf8')).entries, { 'c-1/q-0001': { token: 'AAAAAA' } });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  it('renames an unreadable ladder.json and rebuilds', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ladder.json'), '{ not json');
    const s = new ContactState({ dir, clock: () => NOW });
    assert.deepStrictEqual(s.ladder().entries, {});
    assert.ok(fs.existsSync(path.join(dir, `ladder.json.corrupt-${NOW.getTime()}`)));
  });

  it('a read-only view never renames or writes', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ladder.json'), '{ not json');
    const s = new ContactState({ dir, clock: () => NOW, readOnly: true });
    assert.deepStrictEqual(s.ladder().entries, {});
    s.saveLadder();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ladder.json'), 'utf8'), '{ not json');
  });

  it('never hands out a token still in use by a ladder entry or a delivery', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.ladder().entries.x = { token: '000000' };
    s.recordDelivery('d-1', delivery({ batchToken: '000001', items: [{ n: 1, caseId: 'c', questionId: 'q-0001', token: '000002' }] }));
    const seq = [0, 1, 2, 3].map((n) => Buffer.from([0, 0, 0, n << 2]));
    let i = 0;
    assert.strictEqual(s.newToken(() => seq[i++]), '000003');
  });

  it('resolves a question token, a batch token, a delivery id and a channel message reference', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-1', delivery());
    assert.strictEqual(s.resolve('7qd4km').item.questionId, 'q-0012');
    assert.strictEqual(s.resolve('K7QD4M').deliveryId, 'd-1');
    assert.strictEqual(s.resolve('d-1').item, null);
    assert.strictEqual(s.resolve('4812', { channel: 'telegram' }).deliveryId, 'd-1');
    assert.strictEqual(s.resolve('4812', { channel: 'discord' }), null);
    assert.strictEqual(s.resolve('ZZZZZZ'), null);
    assert.strictEqual(new ContactState({ dir: s.dir }).resolve('K7QD4M').deliveryId, 'd-1', 'read back from deliveries.json');
  });

  it('sets a delivery status by relay id or external reference', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-1', delivery({ relayId: 'msg-9' }));
    assert.strictEqual(s.setDeliveryStatus('msg-9', 'bounced', '550 no such user'), 'd-1');
    assert.strictEqual(s.deliveries()['d-1'].status, 'bounced');
    assert.strictEqual(s.setDeliveryStatus('msg-unknown', 'failed'), null);
  });

  it('prunes deliveries 30 days old whose items are all closed', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-old', delivery({ at: '2026-08-01T00:00:00Z' }));
    s.recordDelivery('d-open', delivery({ at: '2026-08-01T00:00:00Z', items: [{ n: 1, caseId: 'c-2', questionId: 'q-0001', token: 'AAAAAB' }] }));
    s.recordDelivery('d-new', delivery());
    assert.strictEqual(s.pruneDeliveries((caseId) => caseId === 'c-2'), 1);
    assert.deepStrictEqual(Object.keys(s.deliveries()).sort(), ['d-new', 'd-open']);
  });

  it('keeps pins until taken, the inbox as lines, relay cursors and seen event ids', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.pin('c-1/q-0002', 'telegram');
    assert.strictEqual(s.takePin('c-1/q-0002'), 'telegram');
    assert.strictEqual(s.takePin('c-1/q-0002'), null);
    s.appendInbox({ caseId: 'c-1', questionId: 'q-0001', text: 'yes' });
    s.appendInbox({ caseId: 'c-1', questionId: 'q-0002', optionId: 'a' });
    assert.strictEqual(s.readInbox().length, 2);
    s.writeInbox(s.readInbox().slice(1));
    assert.deepStrictEqual(s.readInbox().map((l) => l.questionId), ['q-0002']);
    s.writeInbox([]);
    assert.deepStrictEqual(s.readInbox(), []);
    assert.strictEqual(s.readCursor('main'), null);
    s.writeCursor('main', 'c-42');
    assert.strictEqual(new ContactState({ dir: s.dir }).readCursor('main'), 'c-42');
    assert.strictEqual(s.markEventSeen('ev-1'), true);
    assert.strictEqual(new ContactState({ dir: s.dir }).markEventSeen('ev-1'), false);
    assert.match(s.newDeliveryId(), /^d-[0-9A-Z]+$/);
  });
});

describe('ContactState.resolve across channels', () => {
  it('a question token prefers the delivery on the asking channel', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-mobile', delivery({ channel: 'mobile', at: '2026-09-25T13:00:00Z', externalRef: null }));
    s.recordDelivery('d-telegram', delivery({ channel: 'telegram', at: '2026-09-25T13:30:00Z', batchToken: 'B2B2B2' }));
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'mobile' }).deliveryId, 'd-mobile');
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'telegram' }).deliveryId, 'd-telegram');
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'sms' }).deliveryId, 'd-telegram', 'else the newest');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-state.test.js`
Expected: FAIL with `Cannot find module '../src/cases/contact-state'`

- [ ] **Step 3: Implement**

Create `src/cases/contact-state.js`:

```js
// src/cases/contact-state.js
// The owner-wide contact files under <dataDir>/contact/ (cases stage 4 spec
// §4.2, §4.3): ladder.json, deliveries.json, inbox.jsonl and the relay
// cursors. Loaded once, changed in memory with synchronous read-modify-write
// steps, written atomically (tmp + rename) after every change.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { newToken } = require('./contact-format');
const { createLogger } = require('../logging');

const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;
const SEEN_EVENTS = 2000;

function emptyLadder() {
  return { version: 1, entries: {}, digest: { lastSentDay: null }, pins: {} };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class ContactState {
  constructor({ dir, clock = () => new Date(), log = createLogger('contact/state'), readOnly = false } = {}) {
    this.dir = dir;
    this.clock = clock;
    this.log = log;
    this.readOnly = readOnly;
    this._ladder = null;
    this._deliveries = null;
    this._seen = null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  // An unreadable file is renamed <name>.corrupt-<ts> and rebuilt.
  _read(name, fallback) {
    const file = this.file(name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback();
      throw err;
    }
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      throw new Error('not an object');
    } catch (err) {
      if (!this.readOnly) {
        const moved = `${file}.corrupt-${this.clock().getTime()}`;
        fs.renameSync(file, moved);
        this.log.warn(`${name} was unreadable (${err.message}); moved it to ${path.basename(moved)} and started over`);
      }
      return fallback();
    }
  }

  ladder() {
    if (!this._ladder) {
      const l = this._read('ladder.json', emptyLadder);
      this._ladder = { ...emptyLadder(), ...l, entries: l.entries || {}, digest: l.digest || { lastSentDay: null }, pins: l.pins || {} };
    }
    return this._ladder;
  }

  saveLadder() {
    if (this.readOnly) return;
    writeAtomic(this.file('ladder.json'), `${JSON.stringify(this.ladder(), null, 2)}\n`);
  }

  deliveries() {
    if (!this._deliveries) this._deliveries = this._read('deliveries.json', () => ({}));
    return this._deliveries;
  }

  saveDeliveries() {
    if (this.readOnly) return;
    writeAtomic(this.file('deliveries.json'), `${JSON.stringify(this.deliveries(), null, 2)}\n`);
  }

  // Unique across ladder.json and deliveries.json (question and batch tokens)
  // until the delivery that used it is pruned.
  newToken(randomBytes) {
    const used = new Set();
    for (const e of Object.values(this.ladder().entries)) used.add(e.token);
    for (const d of Object.values(this.deliveries())) {
      used.add(d.batchToken);
      for (const it of d.items || []) used.add(it.token);
    }
    for (let i = 0; i < 1000; i += 1) {
      const t = newToken(randomBytes);
      if (!used.has(t)) return t;
    }
    throw new Error('could not find an unused contact token');
  }

  newDeliveryId() {
    return `d-${this.clock().getTime().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  }

  recordDelivery(id, delivery) {
    this.deliveries()[id] = delivery;
    this.saveDeliveries();
  }

  // Resolves a question token, batch token, delivery id or channel message
  // reference to { delivery, deliveryId, item? }.
  resolve(correlationId, { channel = null } = {}) {
    const key = String(correlationId ?? '').trim();
    if (!key) return null;
    const upper = key.toUpperCase();
    const all = Object.entries(this.deliveries()).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    // A question token is the same on every channel: prefer a delivery on
    // `channel`, else the newest delivery that carried it.
    const withToken = all.filter(([, d]) => (d.items || []).some((it) => it.token === upper));
    const hit = withToken.find(([, d]) => !channel || d.channel === channel) || withToken[0];
    if (hit) return { deliveryId: hit[0], delivery: hit[1], item: hit[1].items.find((it) => it.token === upper) };
    for (const [id, d] of all) {
      if (id === key || d.batchToken === upper) return { deliveryId: id, delivery: d, item: null };
      if ((!channel || d.channel === channel) && (d.externalRef === key || d.relayId === key)) return { deliveryId: id, delivery: d, item: null };
    }
    return null;
  }

  isKnownToken(token) {
    return Boolean(this.resolve(token));
  }

  setDeliveryStatus(match, status, error = null) {
    for (const [id, d] of Object.entries(this.deliveries())) {
      if (id === match || (match && (d.externalRef === match || d.relayId === match))) {
        d.status = status;
        if (error) d.error = String(error);
        d.statusAt = this.clock().toISOString();
        this.saveDeliveries();
        return id;
      }
    }
    return null;
  }

  // Drops deliveries older than 30 days whose every item is closed.
  pruneDeliveries(isOpen) {
    const cutoff = this.clock().getTime() - PRUNE_AFTER_MS;
    let pruned = 0;
    for (const [id, d] of Object.entries(this.deliveries())) {
      if (Date.parse(d.at) < cutoff && !(d.items || []).some((it) => isOpen(it.caseId, it.questionId))) {
        delete this.deliveries()[id];
        pruned += 1;
      }
    }
    if (pruned) this.saveDeliveries();
    return pruned;
  }

  pin(key, channel) {
    this.ladder().pins[key] = channel;
    this.saveLadder();
  }

  takePin(key) {
    const pins = this.ladder().pins;
    const channel = pins[key] || null;
    if (channel) delete pins[key];
    return channel;
  }

  // ---- inbox.jsonl: answers that waited behind a busy case ----

  appendInbox(line) {
    if (this.readOnly) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file('inbox.jsonl'), `${JSON.stringify(line)}\n`);
  }

  readInbox() {
    let text = '';
    try {
      text = fs.readFileSync(this.file('inbox.jsonl'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return text.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  writeInbox(lines) {
    if (!lines.length) {
      fs.rmSync(this.file('inbox.jsonl'), { force: true });
      return;
    }
    writeAtomic(this.file('inbox.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }

  // ---- relay cursors and event ids ----

  readCursor(name) {
    try {
      return fs.readFileSync(this.file(`relay-${name}.cursor`), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  writeCursor(name, cursor) {
    if (cursor === null || cursor === undefined) return;
    writeAtomic(this.file(`relay-${name}.cursor`), `${cursor}\n`);
  }

  _seenIds() {
    if (!this._seen) {
      const data = this._read('relay-events.json', () => ({ ids: [] }));
      this._seen = Array.isArray(data.ids) ? data.ids : [];
    }
    return this._seen;
  }

  // true the first time an event id is seen; the last 2000 ids are kept.
  markEventSeen(id) {
    const ids = this._seenIds();
    if (ids.includes(id)) return false;
    ids.push(id);
    if (ids.length > SEEN_EVENTS) ids.splice(0, ids.length - SEEN_EVENTS);
    writeAtomic(this.file('relay-events.json'), `${JSON.stringify({ ids })}\n`);
    return true;
  }
}

module.exports = { ContactState, emptyLadder, writeAtomic };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-state.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/contact-state.js tests/contact-state.test.js
git commit -m "feat(contact): ladder, deliveries, inbox and relay cursor files

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The contact router

**Files:**
- Create: `src/cases/contact.js`
- Test: `tests/contact-router.test.js`

**Interfaces:**
- Consumes: Tasks 1, 2, 4; C2 `QuestionStore.registerAnswerHandler`, `CaseRuntime.answerQuestion`, `acknowledgeBriefing`, `systemAction`, `questions(id)`, `ledger(id).view().facts`, `applyOwnerFact`, `records(id).writeJournal`, `host.getExecutorRegistry()`; C3 `gateLeaves` (through `getGate`, stubbed).
- Produces: `ContactRouter({ dir, state, runtime, adapters, presence, getGate, clock, getTimeZone, log })` with `deliver(channelId, entries, { deliveryId, batchToken }) → { deliveryId, externalRef, batchToken }` (throws `ContactDeliveryError`), `handleReply(channelId, correlationId, answer, meta) → { ok, outcome, ackText }`, `drainInbox() → { applied, kept }`, `ingestRelayEvents(relayName, events) → { applied, skipped }`, `recordStatus(channelId, { externalRef, relayId, status, error })`, `isOwnerTarget(channelId, target)`, `sendExternal({ caseId, channelId, target, text, envelope }) → { ok, deliveryId } | { ok: false, error, blocked? }`, `knows(channelId, ref)`, `channelStatus(id) → { enabled, configured, reason? }`, `firstAuthenticated()`, `adapter(id)`. Registers the `conflict` answer handler (`conflictFact`, `conflictAnswered` exported) when loaded.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-router.test.js`:

```js
// tests/contact-router.test.js — cases stage 4 §3.5 (ContactRouter).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function world({ getGate = () => null, host = null } = {}) {
  let now = new Date('2026-09-25T14:00:00Z');
  const clock = () => now;
  const runtime = new CaseRuntime({ root: tmp('kl-contact-cases-'), now: clock, host });
  const state = new ContactState({ dir: path.join(tmp('kl-contact-data-'), 'contact'), clock });
  const noted = [];
  const presence = { noteInbound: (c) => noted.push(c) };
  const adapters = new Map([
    ['telegram', new LoopbackChannel({ id: 'telegram', owner: '111' })],
    ['discord', new LoopbackChannel({ id: 'discord', owner: '222' })],
    ['email', new LoopbackChannel({ id: 'email', owner: 'owner@example.com', caps: { authenticatedReplies: false, interrupts: false } })],
    ['sms', new LoopbackChannel({ id: 'sms', owner: '+15550100', caps: { authenticatedReplies: false, requiresToken: true, maxChars: 1200 } })],
    ['ntfy', new LoopbackChannel({ id: 'ntfy', owner: 'kl-topic', caps: { expectsReplies: false, authenticatedReplies: false, deliveryOnly: true } })]
  ]);
  const router = new ContactRouter({ state, runtime, adapters, presence, getGate, clock, getTimeZone: () => 'UTC' });
  for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const kitchen = await runtime.createCase({ title: 'Kitchen quotes', objective: 'Pick a builder' });
  const ask = (caseId, record) => runtime.questions(caseId).create({ kind: 'question', urgency: 'normal', options: [], ...record });
  const entry = (caseInfo, record) => ({ caseId: caseInfo.id, caseTitle: caseInfo.title, token: state.newToken(), record });
  return { runtime, state, router, adapters, noted, lot, kitchen, ask, entry, clock, advance: (ms) => { now = new Date(now.getTime() + ms); } };
}

const facts = (runtime, caseId) => [...runtime.ledger(caseId).view().facts.values()];

describe('ContactRouter.deliver', () => {
  it('sends one message per channel for items from several cases, and records the delivery', async () => {
    const w = await world();
    const q1 = w.ask(w.lot.id, { text: 'Is seller financing ever acceptable?', urgency: 'high', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] });
    const q2 = w.ask(w.kitchen.id, { text: 'Which week suits the site visit?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] });
    const out = await w.router.deliver('telegram', [w.entry(w.kitchen, q2), w.entry(w.lot, q1)]);
    const tg = w.adapters.get('telegram');
    assert.strictEqual(tg.sent.length, 1);
    assert.strictEqual(tg.last().message.subject, 'King Louie: 2 questions (1 high)');
    assert.strictEqual(tg.last().meta.deliveryId, out.deliveryId);
    assert.strictEqual(tg.last().meta.urgency, 'high');
    const d = w.state.deliveries()[out.deliveryId];
    assert.strictEqual(d.channel, 'telegram');
    assert.strictEqual(d.externalRef, 'telegram-msg-1');
    assert.deepStrictEqual(d.items.map((i) => [i.n, i.questionId]), [[1, q1.id], [2, q2.id]]);
  });

  it('a channel without an owner target is not-configured', async () => {
    const w = await world();
    w.adapters.get('telegram').configured = false;
    const q = w.ask(w.lot.id, { text: 'Any update?' });
    await assert.rejects(w.router.deliver('telegram', [w.entry(w.lot, q)]), (err) => err.code === 'not-configured');
  });
});

describe('ContactRouter.handleReply', () => {
  it('loopback round trip: a button answer becomes a user fact with source.kind question', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const tg = w.adapters.get('telegram');
    assert.strictEqual(w.router.knows('telegram', e.token), true);
    assert.strictEqual(w.router.knows('telegram', 'telegram-msg-1'), true, 'the channel message reference');
    assert.strictEqual(w.router.knows('telegram', 'ZZZZZZ'), false);
    const r = await tg.reply(e.token, { optionIndex: 1 });
    assert.deepStrictEqual(r, { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' });
    const answered = w.runtime.questions(w.lot.id).get(q.id);
    assert.strictEqual(answered.answer.channel, 'telegram');
    assert.strictEqual(answered.answer.optionId, 'b');
    const fact = facts(w.runtime, w.lot.id).find((f) => f.id === answered.answer.factId);
    assert.strictEqual(fact.provenance, 'user');
    assert.strictEqual(fact.source.kind, 'question');
    assert.strictEqual(fact.source.ref, q.id);
    assert.deepStrictEqual(tg.plain, [{ target: '111', text: 'Recorded for Lakeside lot.' }]);
    assert.deepStrictEqual(w.noted, ['telegram']);
  });

  it('a batch reply answers several items; unparsed text asks which question', async () => {
    const w = await world();
    const q1 = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const q2 = w.ask(w.kitchen.id, { text: 'Which week?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] });
    const out = await w.router.deliver('telegram', [w.entry(w.lot, q1), w.entry(w.kitchen, q2)]);
    const which = await w.router.handleReply('telegram', out.deliveryId, { text: 'sure' }, { ownerProven: true, senderId: '111' });
    assert.strictEqual(which.outcome, 'unparsed');
    assert.strictEqual(which.ackText, `Which question? Reply "#${out.batchToken} <n> <answer>".`);
    const r = await w.router.handleReply('telegram', out.deliveryId, { text: `#${out.batchToken} 1 a\n#${out.batchToken} 2 Oct 12` }, { ownerProven: true, senderId: '111' });
    assert.strictEqual(r.outcome, 'recorded, recorded');
    assert.strictEqual(w.runtime.questions(w.kitchen.id).get(q2.id).answer.optionId, 'b');
  });

  it('refuses a reply that is not owner-proven: no answer, no ack', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?' });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const r = await w.adapters.get('telegram').reply(e.token, { text: 'yes' }, { senderId: '999', ownerProven: false });
    assert.deepStrictEqual(r, { ok: false, outcome: 'refused: not-owner', ackText: null });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, []);
    assert.deepStrictEqual(w.noted, []);
  });

  it('an approval cannot be answered on a channel without authenticated replies', async () => {
    const w = await world();
    const q = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('sms', [e]);
    assert.strictEqual(w.adapters.get('sms').last().message.items[0].answerable, false);
    const r = await w.router.handleReply('sms', null, { text: `#${e.token} approve` }, { ownerProven: true, senderId: '+15550100' });
    assert.strictEqual(r.outcome, 'refused: approval');
    assert.strictEqual(r.ackText, "Approvals can't be answered by sms. Use King Louie or telegram.");
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('SMS without a token is not applied and gets the hint', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const out = await w.router.deliver('sms', [w.entry(w.lot, q)]);
    const r = await w.router.handleReply('sms', null, { text: 'a' }, { ownerProven: true, senderId: '+15550100' });
    assert.strictEqual(r.outcome, 'refused: no-token');
    assert.strictEqual(r.ackText, `Add the code from the message, e.g. "#${out.batchToken} 1 a".`);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('an answer behind a busy case is queued in inbox.jsonl and applied by drainInbox', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const lock = path.join(w.runtime.getCase(w.lot.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other-process', pid: process.ppid, at: new Date().toISOString() }));
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    assert.deepStrictEqual(r, { ok: true, outcome: 'queued', ackText: 'Received — recording it after the current step' });
    assert.strictEqual(w.state.readInbox().length, 1);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 1 });
    fs.rmSync(lock);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 1, kept: 0 });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'a');
    assert.deepStrictEqual(w.state.readInbox(), []);
  });

  it('token reuse after retirement: a late reply still resolves through deliveries.json', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    const out = await w.router.deliver('email', [e]);
    w.state.ladder().entries = {};
    w.state.saveLadder();
    const again = new ContactRouter({ state: new ContactState({ dir: w.state.dir, clock: w.clock }), runtime: w.runtime, adapters: w.adapters, clock: w.clock });
    const r = await again.handleReply('email', out.externalRef, { text: 'No.' }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(r.outcome, 'recorded');
    assert.notStrictEqual(again.state.newToken(), e.token);
  });

  it('the same answer twice is acknowledged, not duplicated', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    const r = await w.adapters.get('telegram').reply(e.token, { text: 'no' });
    assert.deepStrictEqual(r, { ok: true, outcome: 'already', ackText: 'Already recorded.' });
    assert.strictEqual(facts(w.runtime, w.lot.id).filter((f) => f.source?.ref === q.id).length, 1);
  });
});

describe('conflicting answers', () => {
  it('the first stands; a follow-up pinned to the second channel carries both answers', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.router.deliver('email', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    const r = await w.adapters.get('email').reply(e.token, { optionId: 'b' });
    assert.strictEqual(r.outcome, 'conflict');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'a', 'never overwritten');
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.kind, 'question');
    assert.strictEqual(follow.text, `You answered ${q.id} "No" on telegram at Sep 25 14:00, and now "Yes, up to 20 %". Which stands?`);
    assert.deepStrictEqual(follow.options, [{ id: 'keep', label: 'Keep "No"' }, { id: 'change', label: 'Change to "Yes, up to 20 %"' }]);
    assert.strictEqual(follow.payload.mcpAnswerable, false);
    assert.strictEqual(w.state.ladder().pins[`${w.lot.id}/${follow.id}`], 'email');

    await w.runtime.answerQuestion(w.lot.id, follow.id, { channel: 'email', optionId: 'change' });
    const first = w.runtime.questions(w.lot.id).get(q.id).answer.factId;
    const changed = facts(w.runtime, w.lot.id).find((f) => f.supersedes === first);
    assert.ok(changed, 'the second answer supersedes the first');
    assert.strictEqual(changed.value, 'Yes, up to 20 %');
    assert.strictEqual(changed.provenance, 'user');
  });

  it('after a default the follow-up says the default settled it', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }], defaultOnSilence: 'a', expiresAt: '2026-09-25T15:00:00Z' });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    w.advance(2 * 3600 * 1000);
    w.runtime.questions(w.lot.id).expire(w.clock());
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'b' });
    assert.strictEqual(r.outcome, 'conflict');
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.text, `${q.id} was settled by its default "No" at Sep 25 16:00; you now answered "Yes". Which stands?`);
  });

  it('an envelope approval changed to reject revokes the envelope', async () => {
    const revoked = [];
    const registry = { revokeEnvelope: async (caseId, envelopeId, reason) => { revoked.push({ caseId, envelopeId, reason }); return { ok: true, cancelled: [] }; } };
    const w = await world({ host: { getExecutorRegistry: () => registry } });
    const q = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Approve envelope env-0001?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], payload: { type: 'envelope', envelopeId: 'env-0001' } });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.router.deliver('discord', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'approve' });
    await w.adapters.get('discord').reply(e.token, { optionId: 'reject' });
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.kind, 'approval', 'a conflict on an approval is itself an approval');
    await w.runtime.answerQuestion(w.lot.id, follow.id, { channel: 'discord', optionId: 'change' });
    assert.deepStrictEqual(revoked, [{ caseId: w.lot.id, envelopeId: 'env-0001', reason: 'owner changed the answer' }]);
  });
});

describe('ContactRouter.sendExternal', () => {
  const gateStub = (calls) => () => ({
    gateLeaves: (payload, opts) => {
      calls.push({ payload, opts });
      if (/12 Birch/.test(payload.text)) return { ok: false, blocked: [{ path: 'text', reason: 'not-disclosable' }], rendered: payload };
      return { ok: true, blocked: [], rendered: { text: payload.text.replace('{{f-0001}}', 'the lakeside lot') } };
    }
  });

  it('the owner DM is exempt and needs no gate', async () => {
    const w = await world();
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '111', text: 'Status: {{f-0001}}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.deliveryId, /^d-/);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, [{ target: '111', text: 'Status: {{f-0001}}' }]);
  });

  it('a group chat is not exempt: refused before stage 3, gated and rendered after', async () => {
    const before = await world();
    const refused = await before.router.sendExternal({ caseId: before.lot.id, channelId: 'telegram', target: '-100222', text: 'hello' });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /only the owner can be messaged/);

    const calls = [];
    const w = await world({ getGate: gateStub(calls) });
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '-100222', text: 'About {{f-0001}}' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, [{ target: '-100222', text: 'About the lakeside lot' }], 'the adapter receives rendered text');
    assert.deepStrictEqual(calls[0].opts.recipients, ['-100222']);
    assert.strictEqual(calls[0].opts.mode, 'message');
    assert.strictEqual(calls[0].opts.caseId, w.lot.id);
    assert.ok(calls[0].opts.facts instanceof Map);
  });

  it('a block returns blocked and sends nothing; ntfy is never exempt', async () => {
    const calls = [];
    const w = await world({ getGate: gateStub(calls) });
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '-100222', text: 'The lot next to 12 Birch' });
    assert.deepStrictEqual(r, { ok: false, error: 'outbound gate blocked the message', blocked: [{ path: 'text', reason: 'not-disclosable' }] });
    assert.deepStrictEqual(w.adapters.get('telegram').plain, []);
    assert.strictEqual(w.router.isOwnerTarget('ntfy', 'kl-topic'), false);
    await w.router.sendExternal({ caseId: w.lot.id, channelId: 'ntfy', target: 'kl-topic', text: 'ping' });
    assert.strictEqual(calls.length, 2, 'ntfy went through the gate');
  });

  it('normalizes the target before the owner check', async () => {
    const w = await world();
    assert.strictEqual(w.router.isOwnerTarget('sms', '+1 555 010 0'), true);
    assert.strictEqual(w.router.isOwnerTarget('email', 'Owner@Example.com'), true);
    assert.strictEqual(w.router.isOwnerTarget('email', 'someone@example.com'), false);
  });
});

describe('ContactRouter.ingestRelayEvents', () => {
  it('applies status and gathered events once and skips duplicates', async () => {
    const w = await world();
    w.adapters.set('voice', new (require('./helpers/loopback-channel').LoopbackChannel)({ id: 'voice', owner: '+15550100', caps: { authenticatedReplies: false, voice: true } }));
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    const sms = await w.router.deliver('sms', [e]);
    w.state.deliveries()[sms.deliveryId].relayId = 'relay-1';
    const voice = await w.router.deliver('voice', [e]);
    const r = await w.router.ingestRelayEvents('main', [
      { id: 'ev-1', type: 'status', messageId: 'relay-1', status: 'failed', error: 'unreachable', at: '2026-09-25T14:01:00Z' },
      { id: 'ev-1', type: 'status', messageId: 'relay-1', status: 'delivered' },
      { id: 'ev-2', type: 'gathered', messageId: w.state.deliveries()[voice.deliveryId].externalRef, results: [{ n: 1, digits: '2' }] }
    ]);
    assert.deepStrictEqual(r, { applied: 2, skipped: 1 });
    assert.strictEqual(w.state.deliveries()[sms.deliveryId].status, 'failed');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'b');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.channel, 'voice');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-router.test.js`
Expected: FAIL with `Cannot find module '../src/cases/contact'`

- [ ] **Step 3: Implement**

Create `src/cases/contact.js`:

```js
// src/cases/contact.js
// The contact router (cases stage 4 spec §3.5): batching one message per
// channel, correlating replies through deliveries.json, owner proof, the
// answer path into CaseRuntime.answerQuestion, conflicting answers, the
// inbox behind a busy case, relay events, and sendExternal, the one
// gate-enforced path for any channel-targeted send by case code (R38, R39).
const { QuestionStore } = require('./questions');
const {
  renderBatch, parseReply, optionOrText, normalizeAddress, formatShort
} = require('./contact-format');
const { ContactDeliveryError, GATE_PASSED } = require('../channels/channel-plugin');
const { createLogger } = require('../logging');

const AUTHENTICATED_ORDER = ['telegram', 'discord', 'mobile'];
const TOKEN_IN_TEXT = /#([0-9A-Za-z]{6})\b/;
const ENVELOPE_TYPES = new Set(['envelope', 'envelope-delta']);
const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function answerLabel(record, answer) {
  if (!answer) return '';
  if (answer.optionId) {
    const o = (record.options || []).find((x) => x.id === answer.optionId);
    return o ? o.label : answer.optionId;
  }
  return answer.text || '';
}

function sameAnswer(record, answer) {
  const a = record.answer;
  if (!a) return false;
  if (answer.optionId) return a.optionId === answer.optionId;
  const text = String(answer.text || '').trim();
  if (a.optionId) return optionOrText(record.options, text).optionId === a.optionId;
  return String(a.text || '').trim().toLowerCase() === text.toLowerCase();
}

// `conflict` follow-ups (§3.5 step 6): keep → the first answer stands (the
// fact only records the choice); change → the second answer becomes a
// `user` fact on the original `about`, superseding the first; an envelope
// approval changed to reject is revoked (C3).
function conflictFact(record, answer) {
  const p = record.payload || {};
  if (answer.optionId === 'change') {
    const about = p.about && typeof p.about === 'object' ? p.about : {};
    return {
      stmt: `Owner changed the answer to ${p.conflictOf} to "${p.second}" (was "${p.first}").`,
      subject: typeof about.subject === 'string' && about.subject ? about.subject : 'question',
      attr: typeof about.attr === 'string' && about.attr ? about.attr : p.conflictOf,
      value: p.second,
      ...(p.firstFactId ? { supersedes: p.firstFactId } : {})
    };
  }
  return {
    stmt: `Owner kept the first answer to ${p.conflictOf}: "${p.first}".${answer.text ? ` (${answer.text})` : ''}`,
    subject: 'question',
    attr: record.id,
    value: 'keep'
  };
}

async function conflictAnswered(record, fact, { runtime, caseId }) {
  const p = record.payload || {};
  if (record.answer?.optionId !== 'change') {
    runtime.records(caseId).writeJournal('question', `${record.id}: the first answer to ${p.conflictOf} stands ("${p.first}").`, runtime.now());
    return { applied: 'keep' };
  }
  runtime.records(caseId).writeJournal('question', `${record.id}: the answer to ${p.conflictOf} is now "${p.second}" (was "${p.first}").`, runtime.now());
  let revoked = null;
  if (ENVELOPE_TYPES.has(p.originalType) && p.secondAnswer?.optionId === 'reject' && p.envelopeId) {
    const registry = typeof runtime.host?.getExecutorRegistry === 'function' ? runtime.host.getExecutorRegistry() : null;
    if (registry && typeof registry.revokeEnvelope === 'function') {
      revoked = await registry.revokeEnvelope(caseId, p.envelopeId, 'owner changed the answer');
    }
  }
  const effect = fact ? runtime.applyOwnerFact(caseId, fact) : null;
  return { applied: 'change', revoked, effect };
}

QuestionStore.registerAnswerHandler('conflict', { toFact: conflictFact, onAnswered: conflictAnswered });

class ContactRouter {
  constructor({
    dir = null, state, runtime, adapters, presence = null, getGate = () => null, clock = () => new Date(),
    getTimeZone = () => '', log = createLogger('contact/router')
  } = {}) {
    if (!state) throw new Error('ContactRouter needs a ContactState');
    this.dir = dir || state.dir;
    this.state = state;
    this.runtime = runtime;
    this.adapters = adapters;
    this.presence = presence;
    this.getGate = getGate;
    this.clock = clock;
    this.getTimeZone = getTimeZone;
    this.log = log;
  }

  adapter(channelId) {
    try {
      return this.adapters?.get(channelId) || null;
    } catch {
      return null;
    }
  }

  // Whether a token, delivery id or channel message reference belongs to a
  // contact delivery (the bridges use it to intercept replies).
  knows(channelId, correlationId) {
    return Boolean(correlationId && this.state.resolve(correlationId, { channel: channelId }));
  }

  channelStatus(channelId) {
    const a = this.adapter(channelId);
    if (!a) return { enabled: false, configured: false, reason: 'not enabled in this host' };
    if (!a.contactConfigured()) return { enabled: true, configured: false, reason: 'no owner target is configured' };
    return { enabled: true, configured: true };
  }

  firstAuthenticated() {
    for (const id of AUTHENTICATED_ORDER) {
      const a = this.adapter(id);
      if (a && a.contactConfigured() && a.contactCapabilities()?.authenticatedReplies) return id;
    }
    return 'the King Louie app';
  }

  // entries: [{ caseId, caseTitle, token, record }], all due on this channel.
  async deliver(channelId, entries, { deliveryId = null, batchToken = null } = {}) {
    const adapter = this.adapter(channelId);
    if (!adapter || !adapter.contactConfigured()) throw new ContactDeliveryError('not-configured', `${channelId} is not configured`);
    const caps = adapter.contactCapabilities();
    const id = deliveryId || this.state.newDeliveryId();
    const token = batchToken || this.state.newToken();
    const message = renderBatch(entries, {
      batchToken: token,
      maxChars: caps.maxChars || 4000,
      maxOptions: caps.maxOptions ?? 6,
      authenticated: caps.authenticatedReplies === true,
      firstAuthenticated: this.firstAuthenticated(),
      timeZone: this.getTimeZone()
    });
    if (message.tooLarge) throw new ContactDeliveryError('too-large', `the batch is over ${caps.maxChars} characters even with items cut`);
    const expiries = message.items.map((i) => i.expiresAt).filter(Boolean).sort();
    const meta = {
      expectsReply: caps.expectsReplies === true,
      options: message.items.length === 1 ? message.items[0].options : null,
      deliveryId: id,
      batchToken: token,
      expiresAt: expiries[0] || null,
      urgency: message.items.some((i) => i.urgency === 'high') ? 'high' : (message.items.some((i) => i.urgency === 'normal') ? 'normal' : 'low')
    };
    const sent = await adapter.sendContact({ subject: message.subject, text: message.text, items: message.items }, meta);
    this.state.recordDelivery(id, {
      channel: channelId,
      at: this.clock().toISOString(),
      externalRef: sent?.externalRef ?? null,
      relayId: sent?.relayId ?? null,
      batchToken: token,
      idempotencyKey: id,
      status: 'sent',
      items: message.items.map((i) => ({ n: i.n, caseId: i.caseId, questionId: i.questionId, token: i.token, kind: i.kind }))
    });
    return { deliveryId: id, externalRef: sent?.externalRef ?? null, batchToken: token };
  }

  _record(caseId, questionId) {
    try {
      const meta = this.runtime.getCase(caseId);
      return { meta, record: this.runtime.questions(meta.id).get(questionId) };
    } catch {
      return { meta: null, record: null };
    }
  }

  _batch(resolved) {
    const items = (resolved.delivery.items || []).map((it) => ({ ...it, options: this._record(it.caseId, it.questionId).record?.options || [] }));
    return { batchToken: resolved.delivery.batchToken, items };
  }

  _hint() {
    const latest = Object.values(this.state.deliveries()).filter((d) => d.channel === 'sms').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    return `Add the code from the message, e.g. "#${latest ? latest.batchToken : 'K7QD4M'} 1 a".`;
  }

  // §3.5. correlationId: a question token, batch token, delivery id or the
  // channel's message reference. answer: { optionId } | { optionIndex } | { text }.
  async handleReply(channelId, correlationId, answer = {}, meta = {}) {
    if (meta.ownerProven !== true) {
      this.log.warn(`contact reply refused: not-owner (channel ${channelId}, sender ${meta.senderId ?? 'unknown'})`);
      return { ok: false, outcome: 'refused: not-owner', ackText: null };
    }
    const caps = this.adapter(channelId)?.contactCapabilities() || {};
    const text = typeof answer.text === 'string' ? answer.text : null;
    const textToken = text ? TOKEN_IN_TEXT.exec(text) : null;
    if (caps.requiresToken && !textToken && !(correlationId && answer.optionIndex !== undefined)) {
      return { ok: false, outcome: 'refused: no-token', ackText: this._hint() };
    }
    let resolved = correlationId ? this.state.resolve(correlationId, { channel: channelId }) : null;
    if (!resolved && textToken) resolved = this.state.resolve(textToken[1]);
    if (!resolved) return { ok: false, outcome: 'unknown', ackText: "I couldn't match that reply to a question. Answer it in King Louie." };

    let pairs;
    if (resolved.item && (answer.optionId || answer.optionIndex !== undefined)) {
      pairs = [{ item: resolved.item, answer }];
    } else if (resolved.item && text && !textToken) {
      pairs = [{ item: resolved.item, answer: optionOrText(this._record(resolved.item.caseId, resolved.item.questionId).record?.options, text) }];
    } else if (text) {
      const parsed = parseReply(this._batch(resolved), text, { threaded: !caps.requiresToken });
      if (!parsed.answers.length) return { ok: false, outcome: 'unparsed', ackText: parsed.ack };
      pairs = parsed.answers;
    } else {
      return { ok: false, outcome: 'unparsed', ackText: `Which question? Reply "#${resolved.delivery.batchToken} <n> <answer>".` };
    }

    if (this.presence) this.presence.noteInbound(channelId);
    const results = [];
    for (const p of pairs) results.push(await this._apply(channelId, caps, p.item, p.answer, meta));
    const acks = results.map((r) => r.ack).filter(Boolean);
    return {
      ok: results.every((r) => r.ok),
      outcome: results.map((r) => r.outcome).join(', '),
      ackText: acks.length ? acks.join('\n') : null
    };
  }

  async _apply(channelId, caps, item, answer, meta, { fromInbox = false } = {}) {
    const { meta: caseMeta, record: found } = this._record(item.caseId, item.questionId);
    if (!caseMeta || !found) return { ok: false, outcome: 'unknown', ack: `${item.questionId} no longer exists.` };
    let record = found;
    if (record.kind === 'approval' && caps.authenticatedReplies !== true) {
      return { ok: false, outcome: 'refused: approval', ack: `Approvals can't be answered by ${channelId}. Use King Louie or ${this.firstAuthenticated()}.` };
    }
    let clean = answer;
    if (answer.optionIndex !== undefined) {
      const option = (record.options || [])[Number(answer.optionIndex)];
      if (!option) return { ok: false, outcome: 'invalid', ack: `${record.id} has no option ${Number(answer.optionIndex) + 1}.` };
      clean = { optionId: option.id };
    }
    if (record.kind === 'briefing') {
      if (!record.answer && !record.closed) {
        try {
          await this.runtime.acknowledgeBriefing(caseMeta.id, record.id, { channel: channelId });
        } catch (err) {
          if (err.code !== 'ALREADY_ANSWERED' && err.code !== 'CASE_BUSY') throw err;
        }
      }
      return { ok: true, outcome: 'acknowledged', ack: 'Noted.' };
    }
    if (record.answer === null && !record.closed) {
      try {
        await this.runtime.answerQuestion(caseMeta.id, record.id, { channel: channelId, text: clean.text ?? null, optionId: clean.optionId ?? null });
        return { ok: true, outcome: 'recorded', ack: `Recorded for ${caseMeta.title}.` };
      } catch (err) {
        if (err && err.code === 'CASE_BUSY') {
          if (!fromInbox) {
            this.state.appendInbox({ at: this.clock().toISOString(), channel: channelId, caseId: caseMeta.id, questionId: record.id, text: clean.text ?? null, optionId: clean.optionId ?? null, meta: { senderId: meta.senderId ?? null, ownerProven: true } });
          }
          return { ok: true, outcome: 'queued', ack: 'Received — recording it after the current step' };
        }
        if (err && err.code === 'ALREADY_ANSWERED' && err.record) {
          record = err.record;
        } else if (err && err.name === 'QuestionError') {
          return { ok: false, outcome: 'invalid', ack: `Couldn't record that: ${err.message}` };
        } else {
          throw err;
        }
      }
    }
    if (!record.answer) return { ok: false, outcome: 'closed', ack: `${record.id} is already closed.` };
    if (sameAnswer(record, clean)) return { ok: true, outcome: 'already', ack: 'Already recorded.' };
    try {
      await this._conflict(channelId, caseMeta, record, clean);
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') {
        if (!fromInbox) {
          this.state.appendInbox({ at: this.clock().toISOString(), channel: channelId, caseId: caseMeta.id, questionId: record.id, text: clean.text ?? null, optionId: clean.optionId ?? null, meta: { senderId: meta.senderId ?? null, ownerProven: true } });
        }
        return { ok: true, outcome: 'queued', ack: 'Received — recording it after the current step' };
      }
      throw err;
    }
    return { ok: true, outcome: 'conflict', ack: 'That differs from your earlier answer, so I sent a follow-up: which one stands?' };
  }

  // §3.5 step 6: never overwrite; ask which answer stands, on this channel only.
  async _conflict(channelId, caseMeta, record, answer) {
    const first = cut(answerLabel(record, record.answer), 80);
    const second = cut(answerLabel(record, answer), 80);
    const when = formatShort(record.answer.at, this.getTimeZone());
    const text = record.answer.channel === 'default'
      ? `${record.id} was settled by its default "${first}" at ${when}; you now answered "${second}". Which stands?`
      : `You answered ${record.id} "${first}" on ${record.answer.channel} at ${when}, and now "${second}". Which stands?`;
    const created = await this.runtime.systemAction(caseMeta.id, `contact: conflict ${record.id}`, () => this.runtime.questions(caseMeta.id).create({
      kind: record.kind,
      urgency: record.urgency,
      text,
      options: [{ id: 'keep', label: `Keep "${first}"` }, { id: 'change', label: `Change to "${second}"` }],
      defaultOnSilence: 'hold',
      payload: {
        type: 'conflict',
        conflictOf: record.id,
        originalType: record.payload?.type || 'ask',
        about: record.payload?.about || null,
        first,
        second,
        channel: channelId,
        secondAnswer: { optionId: answer.optionId ?? null, text: answer.text ?? null },
        firstFactId: record.answer.factId || null,
        envelopeId: record.payload?.envelopeId || null,
        mcpAnswerable: false,
        key: `conflict:${record.id}`
      }
    }));
    this.state.pin(`${caseMeta.id}/${created.id}`, channelId);
    return created;
  }

  // Answers queued behind a busy case, retried every tick.
  async drainInbox() {
    const lines = this.state.readInbox();
    if (!lines.length) return { applied: 0, kept: 0 };
    const keep = [];
    let applied = 0;
    for (const line of lines) {
      const caps = this.adapter(line.channel)?.contactCapabilities() || { authenticatedReplies: true };
      const answer = line.optionId ? { optionId: line.optionId } : { text: line.text };
      const r = await this._apply(line.channel, caps, { caseId: line.caseId, questionId: line.questionId }, answer, line.meta || {}, { fromInbox: true });
      if (r.outcome === 'queued') keep.push(line);
      else applied += 1;
    }
    this.state.writeInbox(keep);
    return { applied, kept: keep.length };
  }

  recordStatus(channelId, { externalRef = null, relayId = null, status, error = null } = {}) {
    return this.state.setDeliveryStatus(relayId || externalRef, status, error);
  }

  // Relay events from polling or a signed push (§4.5); deduplicated by id.
  async ingestRelayEvents(relayName, events = []) {
    let applied = 0;
    let skipped = 0;
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !ev.id || !this.state.markEventSeen(`${relayName}:${ev.id}`)) {
        skipped += 1;
        continue;
      }
      if (ev.type === 'status') {
        if (this.state.setDeliveryStatus(ev.messageId, ev.status, ev.error || null)) applied += 1;
        else skipped += 1;
      } else if (ev.type === 'inbound') {
        const adapter = this.adapter(ev.channel);
        if (adapter && typeof adapter.ingestRelayEvent === 'function') {
          await adapter.ingestRelayEvent(ev);
          applied += 1;
        } else {
          skipped += 1;
        }
      } else if (ev.type === 'gathered') {
        const found = this.state.resolve(ev.messageId, { channel: 'voice' });
        if (!found) {
          skipped += 1;
          continue;
        }
        for (const r of ev.results || []) {
          const item = (found.delivery.items || []).find((it) => it.n === Number(r.n));
          const digit = Number.parseInt(String(r.digits || ''), 10);
          if (!item || !Number.isInteger(digit) || digit < 1) continue;
          await this.handleReply('voice', item.token, { optionIndex: digit - 1 }, { channel: 'voice', senderId: 'call', at: ev.at || null, ownerProven: true });
        }
        applied += 1;
      } else {
        skipped += 1;
      }
    }
    return { applied, skipped };
  }

  // The owner exemption: the adapter's configured private owner target, never ntfy.
  isOwnerTarget(channelId, target) {
    if (channelId === 'ntfy') return false;
    const owner = this.adapter(channelId)?.ownerTarget?.();
    if (!owner) return false;
    const a = normalizeAddress(channelId, owner);
    const b = normalizeAddress(channelId, target);
    return Boolean(a && b && a === b);
  }

  // R38/R39: the one gate-enforced channel send for case code.
  async sendExternal({ caseId, channelId, target, text, envelope = null } = {}) {
    const adapter = this.adapter(channelId);
    if (!adapter) return { ok: false, error: `${channelId} is not configured` };
    const to = normalizeAddress(channelId, target);
    if (!to) return { ok: false, error: `"${target}" is not a valid ${channelId} target` };
    const deliveryId = this.state.newDeliveryId();
    let body = String(text ?? '');
    if (!this.isOwnerTarget(channelId, to)) {
      const gate = this.getGate();
      if (!gate || typeof gate.gateLeaves !== 'function') {
        return { ok: false, error: 'the outbound gate is not available (cases stage 3), so only the owner can be messaged' };
      }
      const facts = this.runtime.ledger(caseId).view().facts;
      const entityIndex = typeof this.runtime.entityIndex === 'function' ? this.runtime.entityIndex() : null;
      const r = gate.gateLeaves({ text: body }, { recipients: [to], envelope, facts, mode: 'message', caseId, entityIndex });
      if (!r.ok) return { ok: false, error: 'outbound gate blocked the message', blocked: r.blocked };
      body = r.rendered.text;
    }
    try {
      await adapter.send(to, body, { [GATE_PASSED]: true, deliveryId });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, deliveryId };
  }
}

module.exports = { ContactRouter, conflictFact, conflictAnswered, sameAnswer, answerLabel };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-router.test.js`
Expected: PASS, `# fail 0` (the file makes git commits in temp case repos; `git` must be on PATH)

- [ ] **Step 5: Commit**

```bash
git add src/cases/contact.js tests/contact-router.test.js
git commit -m "feat(contact): router with owner proof, conflicts, inbox, relay events and sendExternal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The ladder engine

**Files:**
- Create: `src/cases/ladder.js`
- Test: `tests/contact-ladder.test.js`

**Interfaces:**
- Consumes: Tasks 2–5; C2 `CaseRuntime` (`listCases`, `questions(id).open()`, `createQuestion`, `systemAction`, `records(id)`, `store.updateMeta` in the test), `localDay`.
- Produces: `LadderEngine({ state, casesRoot, runtime, router, presence, getPolicy, clock, tickMs, dataDir, hostName, log })` with `start()`, `stop()`, `tryAcquire() → boolean`, `status() → { runsHere, holder? }`, `tick(now) → { delivered, failed, exhausted }`, `resolveSteps(urgency, caseMeta)`, `list() → { "<caseId>/<qid>": { step, nextAt, nextChannel, expired, exhausted, attempts: [{ channel, at, outcome }] } }`; `LOCK_FILE` (`.contact.lock`). Ladder entries follow spec §4.2 plus `stopped` and `quietDeferred`; attempts carry `batchToken` for a restart re-send.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-ladder.test.js`:

```js
// tests/contact-ladder.test.js — cases stage 4 §3.6, §3.7 (LadderEngine).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { Presence } = require('../src/cases/presence');
const { LadderEngine } = require('../src/cases/ladder');
const { defaultPolicy } = require('../src/cases/contact-format');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function quietPolicy() {
  const p = defaultPolicy();
  p.digest = null;
  return p;
}

async function world({ start = '2026-09-25T09:00:00Z', interactive = false, tz = 'UTC', policy = quietPolicy(), channels = ['telegram', 'email', 'sms', 'voice'], casesRoot = null, dataDir = null } = {}) {
  let now = new Date(start);
  const clock = () => now;
  const root = casesRoot || tmp('kl-ladder-cases-');
  const data = dataDir || tmp('kl-ladder-data-');
  const runtime = new CaseRuntime({ root, now: clock, host: { interactive: () => interactive } });
  const state = new ContactState({ dir: path.join(data, 'contact'), clock });
  const adapters = new Map();
  const caps = {
    telegram: {},
    discord: {},
    email: { authenticatedReplies: false, interrupts: false, idempotentSend: true },
    sms: { authenticatedReplies: false, requiresToken: true, idempotentSend: true },
    voice: { authenticatedReplies: false, voice: true, idempotentSend: true },
    'in-app': { interrupts: false }
  };
  for (const id of channels) adapters.set(id, new LoopbackChannel({ id, owner: id === 'email' ? 'owner@example.com' : `${id}-owner`, caps: caps[id] || {} }));
  const presence = new Presence({
    file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, interactive: () => interactive,
    isEnabled: (c) => adapters.has(c), getTimeZone: () => tz
  });
  const router = new ContactRouter({ state, runtime, adapters, presence, clock, getTimeZone: () => tz });
  for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
  const ladder = new LadderEngine({ state, casesRoot: root, runtime, router, presence, getPolicy: () => policy, clock, tickMs: 30000, dataDir: data });
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  return {
    runtime, state, router, adapters, presence, ladder, lot, policy, root, data,
    now: () => now,
    at: (iso) => { now = new Date(iso); return now; },
    advance: (ms) => { now = new Date(now.getTime() + ms); return now; },
    ask: (record, caseId = lot.id) => runtime.createQuestion(caseId, { kind: 'question', urgency: 'normal', options: [], ...record }, { charge: false }),
    entry: (q, caseId = lot.id) => state.ladder().entries[`${caseId}/${q.id}`],
    tickAt: async (iso) => { now = new Date(iso); return ladder.tick(now); }
  };
}

const outcomes = (e) => e.attempts.map((a) => `${a.channel}:${a.outcome}${a.reason ? `:${a.reason}` : ''}`);
const journals = (w, caseId = w.lot.id) => {
  const dir = path.join(w.runtime.getCase(caseId).dir, 'journal');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
};

describe('LadderEngine timing', () => {
  it('batches one turn\'s questions at createdAt + batchDelaySec and times later steps from startedAt', async () => {
    const w = await world();
    const kitchen = await w.runtime.createCase({ title: 'Kitchen quotes', objective: 'Pick a builder' });
    const q1 = w.ask({ text: 'Seller financing?' });
    w.advance(20 * 1000);
    const q2 = w.ask({ text: 'Which week?' }, kitchen.id);
    await w.tickAt('2026-09-25T09:00:30Z');
    assert.deepStrictEqual(w.entry(q1).attempts, [], 'nothing before the batch delay');
    await w.tickAt('2026-09-25T09:01:25Z');
    assert.deepStrictEqual(outcomes(w.entry(q1)), ['present:absent']);
    assert.strictEqual(w.entry(q1).nextAt, '2026-09-25T09:30:00.000Z');
    await w.tickAt('2026-09-25T09:30:30Z');
    const tg = w.adapters.get('telegram');
    assert.strictEqual(tg.sent.length, 1, 'both cases in one Telegram message');
    assert.strictEqual(tg.last().message.items.length, 2);
    assert.deepStrictEqual(outcomes(w.entry(q2, kitchen.id)), ['present:absent', 'telegram:sent']);
    assert.strictEqual(w.entry(q1).nextAt, '2026-09-25T13:00:00.000Z', 'email 240 min after startedAt');
  });

  it('a failed send advances to the next step at once; an async failure advances on the next tick', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    w.adapters.get('telegram').failNext('unreachable');
    const r = await w.tickAt('2026-09-25T09:30:00Z');
    assert.strictEqual(r.failed, 1);
    const e = w.entry(q);
    assert.deepStrictEqual(outcomes(e), ['present:absent', 'telegram:failed']);
    assert.deepStrictEqual(e.attempts[1].error, { code: 'unreachable', message: 'loopback unreachable' });
    assert.strictEqual(e.nextAt, '2026-09-25T09:30:00.000Z');
    await w.tickAt('2026-09-25T09:30:30Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:failed', 'email:sent']);

    // async failure: the relay later reports the email bounced.
    const last = w.entry(q).attempts[2];
    w.state.setDeliveryStatus(last.deliveryId, 'bounced', '550 mailbox unavailable');
    await w.tickAt('2026-09-25T09:31:00Z');
    assert.deepStrictEqual(w.entry(q).attempts[2].error, { code: 'bounced', message: '550 mailbox unavailable' });
    assert.strictEqual(w.entry(q).exhausted, true);
  });

  it('after downtime only the latest overdue step fires, on every tick', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T14:00:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:skipped:overdue', 'telegram:skipped:overdue', 'email:sent']);
    assert.strictEqual(w.adapters.get('telegram').sent.length, 0);
  });

  it('a channel already delivered to is skipped as a duplicate', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'telegram' }, { channel: 'present', afterMin: 5 }, { channel: 'email', afterMin: 10 }];
    const w = await world({ policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    w.presence.noteInbound('telegram');
    await w.tickAt('2026-09-25T09:05:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['telegram:sent', 'telegram:skipped:duplicate', 'email:sent'], 'present resolved to telegram: skipped, and the next step is due at once');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('the journal step writes a question journal line', async () => {
    const w = await world();
    const q = w.ask({ text: 'Is the well shared?', urgency: 'low' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:01:30Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['in-app:skipped:not-configured', 'journal:sent']);
    assert.match(journals(w), new RegExp(`${q.id} waiting: Is the well shared\\?`));
  });

  it('case.yaml channels override the ladder, with aliases', async () => {
    const w = await world();
    w.runtime.store.updateMeta(w.lot.id, { channels: { 'urgency.normal': ['sms', { channel: 'call', afterMin: 5 }] } });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:05:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['sms:sent', 'voice:sent']);
  });
});

describe('LadderEngine exhaustion, briefings and expiry', () => {
  it('exhausts, journals it, and retries the journal while the case is busy', async () => {
    const w = await world({ channels: [] });
    const q = w.ask({ text: 'Seller financing?' });
    const lock = path.join(w.runtime.getCase(w.lot.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    await w.tickAt('2026-09-25T09:01:00Z');
    const r = await w.tickAt('2026-09-25T09:30:00Z');
    assert.strictEqual(r.exhausted, 1);
    assert.strictEqual(w.entry(q).exhausted, true);
    assert.strictEqual(w.entry(q).exhaustJournaled, false);
    fs.rmSync(lock);
    await w.tickAt('2026-09-25T09:30:30Z');
    assert.strictEqual(w.entry(q).exhaustJournaled, true);
    assert.match(journals(w), new RegExp(`Ladder exhausted for ${q.id}: tried present absent, telegram skipped \\(not-configured\\), email skipped \\(not-configured\\)\\. The question stays open\\.`));
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('a briefing stops after its first sent step', async () => {
    const w = await world();
    const b = w.runtime.createQuestion(w.lot.id, { kind: 'briefing', urgency: 'normal', text: 'The appraisal came back at 41k.' }, { charge: false });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:30:00Z');
    await w.tickAt('2026-09-25T13:00:00Z');
    assert.deepStrictEqual(outcomes(w.entry(b)), ['present:absent', 'telegram:sent']);
    assert.strictEqual(w.entry(b).stopped, true);
    assert.strictEqual(w.adapters.get('email').sent.length, 0);
  });

  it('expired hold is not re-enqueued', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?', expiresAt: '2026-09-25T09:10:00Z' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:11:00Z');
    assert.strictEqual(w.entry(q).expired, true);
    await w.tickAt('2026-09-25T13:30:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent'], 'no later step after expiry');
    assert.strictEqual(Object.keys(w.state.ladder().entries).length, 1);
  });

  it('expiry in flight: the attempt is recorded, no later step fires, a later hold reply is accepted', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?', options: [{ id: 'a', label: 'No' }], expiresAt: '2026-09-25T09:31:00Z' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const release = w.adapters.get('telegram').holdNext();
    const ticking = w.tickAt('2026-09-25T09:30:30Z');
    w.at('2026-09-25T09:32:00Z');
    release();
    await ticking;
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:sent']);
    await w.tickAt('2026-09-25T13:10:00Z');
    assert.strictEqual(w.entry(q).expired, true);
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:sent']);
    w.runtime.questions(w.lot.id).expire(w.now());
    const token = w.entry(q).token;
    const r = await w.adapters.get('telegram').reply(token, { optionId: 'a' }, { senderId: 'telegram-owner' });
    assert.strictEqual(r.outcome, 'recorded');
  });
});

describe('LadderEngine in-app and quiet hours', () => {
  it('in-app re-surfaces after the owner comes back to the desktop', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'present' }, { channel: 'present', afterMin: 30 }];
    const w = await world({ interactive: true, policy, channels: [] });
    const events = [];
    const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
    w.adapters.set('in-app', new DesktopChannelPlugin({ sendToUi: (ev, p) => events.push([ev, p]) }));
    const q = w.ask({ text: 'Seller financing?' });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).deliveries[0].deliveryId, `in-app-${q.id}`);
    await w.tickAt('2026-09-25T09:01:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent']);
    w.at('2026-09-25T09:29:30Z');
    w.presence.heartbeat({ focused: true, lastInputAt: w.now().toISOString() });
    await w.tickAt('2026-09-25T09:30:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'in-app:sent']);
    assert.deepStrictEqual(events, [['case:changed', { caseId: w.lot.id, what: 'questions', questionId: q.id, attention: 'banner' }]]);
  });

  it('in-app on a record stage 2 delivered is sent without sending', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'in-app' }];
    const w = await world({ interactive: true, policy, channels: [] });
    const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
    const events = [];
    w.adapters.set('in-app', new DesktopChannelPlugin({ sendToUi: (ev, p) => events.push([ev, p]) }));
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    assert.deepStrictEqual(w.entry(q).attempts.map((a) => [a.channel, a.outcome, a.deliveryId]), [['in-app', 'sent', `in-app-${q.id}`]]);
    assert.deepStrictEqual(events, []);
  });

  it('quiet hours across fall-back: a 23:30 normal Telegram step waits until 07:00 local, once', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '22:00', end: '07:00', breakthrough: ['high'] };
    policy.digest = null;
    // 23:00 CDT Oct 31 = 04:00Z Nov 1; the Telegram step is due at 04:30Z (23:30 local).
    const w = await world({ start: '2026-11-01T04:00:00Z', tz: 'America/Chicago', policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-11-01T04:01:00Z');
    await w.tickAt('2026-11-01T04:30:00Z');
    assert.strictEqual(w.entry(q).nextAt, '2026-11-01T13:00:00.000Z', '07:00 CST');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 0);
    await w.tickAt('2026-11-01T13:00:00Z');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('a deferred step is not deferred again on the repeated hour', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '22:00', end: '01:30', breakthrough: ['high'] };
    policy.digest = null;
    const w = await world({ start: '2026-11-01T04:00:00Z', tz: 'America/Chicago', policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-11-01T04:01:00Z');
    await w.tickAt('2026-11-01T04:30:00Z');
    assert.strictEqual(w.entry(q).nextAt, '2026-11-01T06:30:00.000Z', 'the first 01:30');
    // Down until 01:10 CST (07:10Z), which is inside the window again.
    await w.tickAt('2026-11-01T07:10:00Z');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('high urgency breaks through quiet hours', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '00:00', end: '23:59', breakthrough: ['high'] };
    const w = await world({ policy });
    w.ask({ text: 'Accept the offer by noon?', urgency: 'high' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:15:00Z');
    assert.strictEqual(w.adapters.get('sms').sent.length, 1);
  });
});

describe('LadderEngine digest', () => {
  it('sends digest-step entries and exhausted ones once a day at digest.at, late if the process was down', async () => {
    const w = await world({ start: '2026-09-25T06:00:00Z', policy: defaultPolicy() });
    const low = w.ask({ text: 'Any preference on the realtor?', urgency: 'low' });
    await w.tickAt('2026-09-25T06:01:00Z');
    await w.tickAt('2026-09-25T06:01:30Z');
    await w.tickAt('2026-09-25T06:02:00Z');
    assert.strictEqual(w.entry(low).steps[w.entry(low).step].digest, true);
    assert.strictEqual(w.adapters.get('email').sent.length, 0, 'waits for the digest');
    // Down at 08:00; the first tick after sends it.
    await w.tickAt('2026-09-25T10:45:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 1);
    assert.match(w.adapters.get('email').last().message.text, /Any preference on the realtor\?/);
    assert.strictEqual(w.state.ladder().digest.lastSentDay, '2026-09-25');
    await w.tickAt('2026-09-25T11:00:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 1, 'once a day');
    await w.tickAt('2026-09-26T08:00:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 2, 'the next day again, while it stays open');
  });

  it('skips an empty digest', async () => {
    const w = await world({ policy: defaultPolicy() });
    await w.tickAt('2026-09-25T09:00:00Z');
    assert.strictEqual(w.state.ladder().digest.lastSentDay, '2026-09-25');
    assert.strictEqual(w.adapters.get('email').sent.length, 0);
  });
});

describe('LadderEngine mirror and restarts', () => {
  it('mirrors sent attempts into the record\'s deliveries', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:30:00Z');
    const rec = w.runtime.questions(w.lot.id).get(q.id);
    assert.deepStrictEqual(rec.deliveries.map((d) => d.channel), ['telegram']);
    assert.strictEqual(rec.deliveries[0].deliveryId, w.entry(q).attempts[1].deliveryId);
    assert.strictEqual(w.entry(q).attempts[1].mirrored, true);
  });

  it('restart: an inFlight relay attempt is re-sent with the same key; others become unknown', async () => {
    const w = await world();
    const q1 = w.ask({ text: 'Accept the offer by noon?', urgency: 'high' });
    const q2 = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const e1 = w.entry(q1);
    const e2 = w.entry(q2);
    e1.step = 1;
    e1.attempts.push({ step: 1, channel: 'sms', at: '2026-09-25T09:15:00Z', outcome: 'inFlight', deliveryId: 'd-SMS1', batchToken: 'ABCDEF', idempotencyKey: 'd-SMS1', mirrored: false });
    e2.step = 1;
    e2.attempts.push({ step: 1, channel: 'telegram', at: '2026-09-25T09:30:00Z', outcome: 'inFlight', deliveryId: 'd-TG1', batchToken: 'GHJKMN', idempotencyKey: 'd-TG1', mirrored: false });
    w.state.saveLadder();

    const fresh = new LadderEngine({ state: new ContactState({ dir: w.state.dir, clock: w.now }), casesRoot: w.root, runtime: w.runtime, router: new ContactRouter({ state: w.state, runtime: w.runtime, adapters: w.adapters, presence: w.presence, clock: w.now }), presence: w.presence, getPolicy: () => w.policy, clock: w.now, dataDir: w.data });
    await fresh.tick(w.at('2026-09-25T09:31:00Z'));
    const sms = w.adapters.get('sms').sent;
    assert.strictEqual(sms.length, 1);
    assert.strictEqual(sms[0].meta.deliveryId, 'd-SMS1', 'same Idempotency-Key');
    assert.strictEqual(sms[0].meta.batchToken, 'ABCDEF');
    const after2 = fresh.state.ladder().entries[`${w.lot.id}/${q2.id}`];
    assert.strictEqual(after2.attempts[after2.attempts.length - 2].outcome, 'unknown');
  });
});

describe('LadderEngine lease', () => {
  it('a second process stays passive and serves the holder\'s state; a stale lease is taken over', async () => {
    const w = await world();
    w.ask({ text: 'Seller financing?' });
    assert.strictEqual(w.ladder.tryAcquire(), true);
    await w.tickAt('2026-09-25T09:01:00Z');

    const otherData = tmp('kl-ladder-other-');
    const other = new LadderEngine({
      state: new ContactState({ dir: path.join(otherData, 'contact'), clock: w.now }), casesRoot: w.root, runtime: w.runtime,
      router: w.router, presence: w.presence, getPolicy: () => w.policy, clock: w.now, tickMs: 30000, dataDir: otherData, hostName: 'web-01'
    });
    assert.strictEqual(other.tryAcquire(), false);
    assert.deepStrictEqual(other.status(), { runsHere: false, holder: JSON.parse(fs.readFileSync(path.join(w.root, '.contact.lock'), 'utf8')) });
    assert.deepStrictEqual(Object.keys(other.list()), Object.keys(w.ladder.list()), 'read-only view of the holder\'s ladder');

    w.advance(91 * 1000);
    assert.strictEqual(other.tryAcquire(), true, 'older than 3 × tickMs');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.root, '.contact.lock'), 'utf8')).host, 'web-01');
    await other.stop();
    assert.strictEqual(fs.existsSync(path.join(w.root, '.contact.lock')), false);
  });

  it('list() reports the ladder state per question', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const s = w.ladder.list()[`${w.lot.id}/${q.id}`];
    assert.deepStrictEqual({ ...s, attempts: s.attempts.map((a) => [a.channel, a.outcome]) }, {
      step: 1, nextAt: '2026-09-25T09:30:00.000Z', nextChannel: 'telegram', expired: false, exhausted: false, attempts: [['present', 'absent']]
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-ladder.test.js`
Expected: FAIL with `Cannot find module '../src/cases/ladder'`

- [ ] **Step 3: Implement**

Create `src/cases/ladder.js`:

```js
// src/cases/ladder.js
// The contact ladder (cases stage 4 spec §3.6, §3.7): its own tick, no model
// turn, no case lock for delivery, batching across cases. Every step is
// persisted before it acts. One process per cases root runs it (the lease
// <casesRoot>/.contact.lock); any other process stays passive.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactState } = require('./contact-state');
const { effectivePolicy, resolveSteps } = require('./contact-format');
const { localDay } = require('./clock');
const { wallHhmm } = require('./presence');
const { ContactDeliveryError } = require('../channels/channel-plugin');
const { createLogger } = require('../logging');

const MINUTE = 60 * 1000;
const DAY = 24 * 3600 * 1000;
const ASYNC_FAILURES = new Set(['failed', 'bounced', 'no-answer', 'busy']);
const CLOSED_CASE = new Set(['done', 'abandoned']);
const LOCK_FILE = '.contact.lock';

const iso = (ms) => new Date(ms).toISOString();

class LadderEngine {
  constructor({
    state, casesRoot, runtime, router, presence, getPolicy = () => ({}), clock = () => new Date(), tickMs = 30000,
    dataDir = null, hostName = os.hostname(), log = createLogger('contact/ladder')
  } = {}) {
    this.state = state;
    this.casesRoot = casesRoot;
    this.runtime = runtime;
    this.router = router;
    this.presence = presence;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.tickMs = tickMs;
    this.dataDir = dataDir || path.dirname(state.dir);
    this.hostName = hostName;
    this.log = log;
    this.active = false;
    this.holder = null;
    this.timer = null;
    this.inflight = null;
    this.recovered = false;
    this.notConfiguredLogged = new Set();
  }

  // ---- The cases-root lease ----

  lockPath() {
    return path.join(this.casesRoot, LOCK_FILE);
  }

  _lease() {
    return { pid: process.pid, host: this.hostName, dataDir: this.dataDir, heartbeatAt: this.clock().toISOString() };
  }

  _readLock() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath(), 'utf8'));
    } catch {
      return null;
    }
  }

  _mine(lock) {
    return Boolean(lock && lock.pid === process.pid && lock.host === this.hostName && lock.dataDir === this.dataDir);
  }

  // true when this process holds (or just took) the lease.
  tryAcquire() {
    // No cases root yet means no cases: nothing to ladder, and nothing is
    // created on disk until the first case is (CaseRuntime's rule).
    if (!fs.existsSync(this.casesRoot)) {
      this.active = false;
      this.holder = null;
      return false;
    }
    try {
      const fd = fs.openSync(this.lockPath(), 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(this._lease()));
      } finally {
        fs.closeSync(fd);
      }
      return this._becomeActive();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = this._readLock();
    if (this._mine(held)) return this._becomeActive();
    const beat = Date.parse(held?.heartbeatAt);
    if (!held || !Number.isFinite(beat) || this.clock().getTime() - beat > 3 * this.tickMs) {
      this.log.warn(`taking over a stale contact ladder lease${held ? ` from ${held.host}:${held.pid}` : ''}`);
      fs.writeFileSync(this.lockPath(), JSON.stringify(this._lease()));
      return this._becomeActive();
    }
    if (!this.holder || this.holder.pid !== held.pid || this.holder.host !== held.host) {
      this.log.info(`contact ladder runs in ${held.host}:${held.pid}`);
    }
    this.active = false;
    this.holder = held;
    return false;
  }

  _becomeActive() {
    this.active = true;
    this.holder = null;
    return true;
  }

  _heartbeat() {
    const held = this._readLock();
    if (!this._mine(held)) {
      this.active = false;
      this.holder = held;
      return false;
    }
    fs.writeFileSync(this.lockPath(), JSON.stringify(this._lease()));
    return true;
  }

  start() {
    this.tryAcquire();
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      const ok = this.active ? this._heartbeat() : this.tryAcquire();
      if (!ok) return;
      this.inflight = this.tick()
        .catch((err) => this.log.warn(`contact ladder tick failed: ${err.message}`))
        .finally(() => { this.inflight = null; });
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    if (this.active && this._mine(this._readLock())) fs.rmSync(this.lockPath(), { force: true });
    this.active = false;
  }

  status() {
    return this.active ? { runsHere: true } : { runsHere: false, holder: this.holder };
  }

  // ---- Helpers ----

  policy() {
    return effectivePolicy(this.getPolicy());
  }

  resolveSteps(urgency, caseMeta) {
    return resolveSteps(this.policy(), urgency, caseMeta?.channels || null);
  }

  _nominal(entry, i, policy) {
    const step = entry.steps[i];
    if (!step) return Infinity;
    return Date.parse(entry.startedAt) + Math.max(step.afterMin * MINUTE, policy.batchDelaySec * 1000);
  }

  _advance(entry, policy, { now = null } = {}) {
    entry.step += 1;
    entry.nextAt = now !== null ? iso(now) : (entry.step < entry.steps.length ? iso(this._nominal(entry, entry.step, policy)) : null);
    entry.quietDeferred = false;
  }

  // 8. A briefing (never has options) stops after its first sent step.
  _afterSent(entry) {
    if (entry.kind === 'briefing') entry.stopped = true;
  }

  _attempt(entry, fields) {
    const a = { step: entry.step, at: this.clock().toISOString(), mirrored: true, ...fields };
    entry.attempts.push(a);
    return a;
  }

  _record(caseId, questionId) {
    try {
      return this.runtime.questions(caseId).get(questionId);
    } catch {
      return null;
    }
  }

  async _journal(caseId, label, text, now) {
    await this.runtime.systemAction(caseId, label, () => this.runtime.records(caseId).writeJournal('question', text, now));
  }

  // ---- The tick ----

  async tick(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    const ladder = this.state.ladder();
    const result = { delivered: 0, failed: 0, exhausted: 0 };
    if (!this.recovered) {
      this.recovered = true;
      await this._recover(policy, nowMs);
    }
    await this.router.drainInbox();

    const cases = new Map();
    for (const c of this.runtime.listCases()) cases.set(c.id, c);

    // 1. Scan: enqueue every open record without an entry.
    for (const c of cases.values()) {
      if (CLOSED_CASE.has(c.status)) continue;
      for (const rec of this.runtime.questions(c.id).open()) {
        const key = `${c.id}/${rec.id}`;
        if (ladder.entries[key]) continue;
        const pinned = this.state.takePin(key);
        const steps = pinned ? [{ channel: pinned, afterMin: 0, digest: false }] : this.resolveSteps(rec.urgency, c);
        const startedAt = rec.createdAt;
        ladder.entries[key] = {
          caseId: c.id, questionId: rec.id, kind: rec.kind, urgency: rec.urgency, token: this.state.newToken(),
          startedAt, step: 0, nextAt: iso(Date.parse(startedAt) + policy.batchDelaySec * 1000), pinnedChannel: pinned,
          steps, expired: false, exhausted: false, exhaustJournaled: false, stopped: false, quietDeferred: false, attempts: []
        };
      }
    }
    this.state.saveLadder();

    // 2. Retire and expire.
    const retiring = [];
    for (const [key, e] of Object.entries(ladder.entries)) {
      const c = cases.get(e.caseId);
      const rec = c ? this._record(e.caseId, e.questionId) : null;
      if (!c || CLOSED_CASE.has(c.status) || !rec || rec.answer || rec.closed) {
        retiring.push(key);
        continue;
      }
      if (!e.expired && rec.expiresAt && Date.parse(rec.expiresAt) <= nowMs) e.expired = true;
    }

    // 6 (async). A later relay failure or DSN on the entry's latest attempt.
    const deliveries = this.state.deliveries();
    for (const e of Object.values(ladder.entries)) {
      const last = e.attempts[e.attempts.length - 1];
      const d = last && last.outcome === 'sent' && last.deliveryId ? deliveries[last.deliveryId] : null;
      if (d && ASYNC_FAILURES.has(d.status)) {
        last.outcome = 'failed';
        last.error = { code: d.status, message: d.error || d.status };
        if (!e.expired && !e.stopped) e.nextAt = iso(nowMs);
        result.failed += 1;
      }
    }

    // 3–5. Resolve due steps and group deliveries by channel.
    const groups = new Map();
    const journals = [];
    for (const e of Object.values(ladder.entries)) {
      if (retiring.includes(`${e.caseId}/${e.questionId}`) || e.expired || e.exhausted || e.stopped) continue;
      this._collapse(e, policy, nowMs);
      for (let guard = 0; guard <= e.steps.length && e.step < e.steps.length && Date.parse(e.nextAt) <= nowMs; guard += 1) {
        const r = this._resolve(e, policy, nowMs);
        if (r.kind === 'next') continue;
        if (r.kind === 'deliver') {
          if (!groups.has(r.channel)) groups.set(r.channel, []);
          groups.get(r.channel).push(e);
        } else if (r.kind === 'journal') {
          journals.push(e);
        }
        break;
      }
    }

    for (const e of journals) {
      const rec = this._record(e.caseId, e.questionId);
      try {
        await this._journal(e.caseId, `contact: ${e.questionId} waiting`, `${e.questionId} waiting: ${rec ? rec.text : ''}`, now);
        this._attempt(e, { channel: 'journal', outcome: 'sent' });
        this._advance(e, policy);
        this._afterSent(e);
      } catch (err) {
        if (err.code !== 'CASE_BUSY') throw err;
      }
    }

    for (const [channel, entries] of groups) {
      const r = await this._deliver(channel, entries, policy, now);
      result.delivered += r.delivered;
      result.failed += r.failed;
    }

    // 7. Exhaust.
    for (const e of Object.values(ladder.entries)) {
      if (retiring.includes(`${e.caseId}/${e.questionId}`) || e.expired || e.stopped || e.step < e.steps.length) continue;
      if (!e.exhausted) {
        e.exhausted = true;
        result.exhausted += 1;
      }
      if (!e.exhaustJournaled) {
        const tried = e.attempts.map((a) => `${a.channel} ${a.outcome}${a.error ? ` (${a.error.code})` : ''}${a.reason ? ` (${a.reason})` : ''}`).join(', ') || 'no channel';
        try {
          await this._journal(e.caseId, `contact: ladder exhausted for ${e.questionId}`, `Ladder exhausted for ${e.questionId}: tried ${tried}. The question stays open.`, now);
          e.exhaustJournaled = true;
        } catch (err) {
          if (err.code !== 'CASE_BUSY') throw err;
        }
      }
    }
    this.state.saveLadder();

    await this._digest(policy, now, retiring);
    await this._mirror();

    for (const key of retiring) delete ladder.entries[key];
    this.state.saveLadder();
    this.state.pruneDeliveries((caseId, questionId) => {
      const rec = cases.has(caseId) ? this._record(caseId, questionId) : null;
      return Boolean(rec && !rec.answer && !rec.closed);
    });
    return result;
  }

  // 3. After downtime only the latest due step fires; earlier ones are
  // skipped. A step held back by quiet hours is not downtime: it fires.
  _collapse(e, policy, nowMs) {
    if (e.quietDeferred || Date.parse(e.nextAt) > nowMs) return;
    let latest = e.step;
    for (let j = e.step + 1; j < e.steps.length; j += 1) {
      const t = this._nominal(e, j, policy);
      if (t <= nowMs && t > this._nominal(e, e.step, policy)) latest = j;
    }
    while (e.step < latest) {
      this._attempt(e, { channel: e.steps[e.step].channel, outcome: 'skipped', reason: 'overdue' });
      e.step += 1;
    }
  }

  // 4. What the due step does now: { kind: 'next' | 'deliver' | 'journal' | 'wait', channel }.
  _resolve(e, policy, nowMs) {
    const step = e.steps[e.step];
    let channel = step.channel;
    const awayActive = policy.away && Date.parse(policy.away.until) > nowMs;
    if (awayActive && channel !== 'journal' && channel !== 'present') channel = policy.away.mode === 'email-only' ? 'email' : 'in-app';
    if (channel === 'present') {
      const present = this.presence.presentChannel(new Date(nowMs));
      if (!present) {
        this._attempt(e, { channel: 'present', outcome: 'absent' });
        this._advance(e, policy);
        return { kind: 'next' };
      }
      channel = present;
    }
    if (channel === 'journal') return { kind: 'journal' };
    if (step.digest) return { kind: 'wait' };

    const status = this.router.channelStatus(channel);
    if (!status.configured) {
      const day = localDay(new Date(nowMs), this.presence.timeZone());
      if (!this.notConfiguredLogged.has(`${channel}|${day}`)) {
        this.notConfiguredLogged.add(`${channel}|${day}`);
        this.log.info(`contact channel ${channel} is not configured; skipping it (${status.reason})`);
      }
      this._attempt(e, { channel, outcome: 'skipped', reason: 'not-configured' });
      this._advance(e, policy, { now: nowMs });
      return { kind: 'next' };
    }

    const rec = this._record(e.caseId, e.questionId);
    let resurface = false;
    if (channel === 'in-app' && rec) {
      const inApp = (rec.deliveries || []).filter((d) => d.channel === 'in-app').map((d) => Date.parse(d.at)).filter(Number.isFinite);
      const since = this.presence.desktopPresentSince();
      if (inApp.length) {
        resurface = Boolean(since && Math.max(...inApp) < since.getTime());
        if (!resurface) {
          if (e.attempts.some((a) => a.channel === 'in-app' && a.outcome === 'sent')) {
            this._attempt(e, { channel, outcome: 'skipped', reason: 'duplicate' });
            this._advance(e, policy, { now: nowMs });
          } else {
            // Stage 2 already showed it in the window: sent without sending.
            this._attempt(e, { channel, outcome: 'sent', deliveryId: `in-app-${e.questionId}` });
            this._advance(e, policy);
            this._afterSent(e);
          }
          return { kind: 'next' };
        }
      }
    }
    if (!resurface && e.attempts.some((a) => a.channel === channel && a.outcome === 'sent')) {
      this._attempt(e, { channel, outcome: 'skipped', reason: 'duplicate' });
      this._advance(e, policy, { now: nowMs });
      return { kind: 'next' };
    }

    const caps = this.router.adapter(channel)?.contactCapabilities() || {};
    const quiet = policy.quietHours;
    if (caps.interrupts && quiet && !quiet.breakthrough.includes(e.urgency) && this.presence.inQuietHours(new Date(nowMs))) {
      if (!e.quietDeferred) {
        e.nextAt = this.presence.nextQuietEnd(new Date(nowMs)).toISOString();
        e.quietDeferred = true;
        return { kind: 'wait' };
      }
    }
    e.resolvedChannel = channel;
    return { kind: 'deliver', channel };
  }

  _item(e) {
    const rec = this._record(e.caseId, e.questionId);
    let caseTitle = e.caseId;
    try {
      caseTitle = this.runtime.getCase(e.caseId).title;
    } catch {
      // A case removed mid-tick keeps its id as the title.
    }
    return rec ? { caseId: e.caseId, caseTitle, token: e.token, record: rec } : null;
  }

  // 5–6. One router.deliver per channel; every attempt is saved inFlight first.
  async _deliver(channel, entries, policy, now) {
    const out = { delivered: 0, failed: 0 };
    const items = entries.map((e) => this._item(e)).filter(Boolean);
    if (!items.length) return out;
    const deliveryId = this.state.newDeliveryId();
    const batchToken = this.state.newToken();
    for (const e of entries) this._attempt(e, { channel, outcome: 'inFlight', deliveryId, batchToken, idempotencyKey: deliveryId, mirrored: false });
    this.state.saveLadder();
    try {
      await this.router.deliver(channel, items, { deliveryId, batchToken });
      for (const e of entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'sent';
        this._advance(e, policy);
        this._afterSent(e);
      }
      out.delivered += entries.length;
    } catch (err) {
      const error = err instanceof ContactDeliveryError ? { code: err.code, message: err.message } : { code: 'unreachable', message: err.message };
      for (const e of entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'failed';
        a.error = error;
        a.mirrored = true;
        this._advance(e, policy, { now: now.getTime() });
      }
      out.failed += entries.length;
      this.log.warn(`contact delivery on ${channel} failed: ${error.code}: ${error.message}`);
    }
    this.state.saveLadder();
    return out;
  }

  // Restarts: an inFlight relay attempt is re-sent with the same key; any
  // other inFlight attempt becomes unknown and the entry advances.
  async _recover(policy, nowMs) {
    const byDelivery = new Map();
    for (const e of Object.values(this.state.ladder().entries)) {
      const a = e.attempts[e.attempts.length - 1];
      if (!a || a.outcome !== 'inFlight') continue;
      if (!byDelivery.has(a.deliveryId)) byDelivery.set(a.deliveryId, { channel: a.channel, batchToken: a.batchToken, entries: [] });
      byDelivery.get(a.deliveryId).entries.push(e);
    }
    for (const [deliveryId, g] of byDelivery) {
      const caps = this.router.adapter(g.channel)?.contactCapabilities() || {};
      if (caps.idempotentSend) {
        const items = g.entries.map((e) => this._item(e)).filter(Boolean);
        try {
          await this.router.deliver(g.channel, items, { deliveryId, batchToken: g.batchToken });
          for (const e of g.entries) {
            e.attempts[e.attempts.length - 1].outcome = 'sent';
            e.step += 1;
            e.nextAt = e.step < e.steps.length ? iso(this._nominal(e, e.step, policy)) : null;
          }
          continue;
        } catch (err) {
          this.log.warn(`re-sending ${deliveryId} on ${g.channel} failed: ${err.message}`);
        }
      }
      for (const e of g.entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'unknown';
        a.mirrored = true;
        e.step += 1;
        e.nextAt = iso(nowMs);
      }
    }
    this.state.saveLadder();
  }

  // 3.7. One delivery a day at digest.at (owner zone), late if the process was down.
  async _digest(policy, now, retiring) {
    const d = policy.digest;
    if (!d) return;
    const ladder = this.state.ladder();
    const tz = this.presence.timeZone();
    const today = localDay(now, tz);
    if (ladder.digest.lastSentDay && ladder.digest.lastSentDay >= today) return;
    if (wallHhmm(now, tz) < d.at) return;
    const caps = this.router.adapter(d.channel)?.contactCapabilities() || {};
    if (caps.interrupts && this.presence.inQuietHours(now)) return;
    const nowMs = now.getTime();
    const entries = Object.values(ladder.entries).filter((e) => !retiring.includes(`${e.caseId}/${e.questionId}`) && !e.expired && (
      (e.steps[e.step]?.digest && Date.parse(e.nextAt) <= nowMs)
      || e.exhausted
      || (e.kind === 'briefing' && nowMs - Date.parse(e.startedAt) <= DAY)
    ));
    ladder.digest.lastSentDay = today;
    this.state.saveLadder();
    if (!entries.length) return;
    if (!this.router.channelStatus(d.channel).configured) {
      this.log.info(`the daily digest channel ${d.channel} is not configured; no digest today`);
      return;
    }
    const items = entries.map((e) => this._item(e)).filter(Boolean);
    const deliveryId = this.state.newDeliveryId();
    try {
      await this.router.deliver(d.channel, items, { deliveryId });
      for (const e of entries) this._attempt(e, { channel: d.channel, outcome: 'sent', deliveryId, digest: true, mirrored: false });
    } catch (err) {
      this.log.warn(`the daily digest on ${d.channel} failed: ${err.message}`);
    }
    this.state.saveLadder();
  }

  // 9. Sent attempts go into the record's deliveries, one commit per case per tick.
  async _mirror() {
    const byCase = new Map();
    for (const e of Object.values(this.state.ladder().entries)) {
      for (const a of e.attempts) {
        if (a.mirrored || a.outcome !== 'sent' || !a.deliveryId) continue;
        if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
        byCase.get(e.caseId).push({ e, a });
      }
    }
    for (const [caseId, list] of byCase) {
      const qids = [...new Set(list.map((x) => x.e.questionId))].join(', ');
      const channels = [...new Set(list.map((x) => x.a.channel))].join(', ');
      try {
        await this.runtime.systemAction(caseId, `contact: delivered ${qids} via ${channels}`, () => {
          const store = this.runtime.questions(caseId);
          for (const { e, a } of list) {
            try {
              store.recordDelivery(e.questionId, { channel: a.channel, at: a.at, deliveryId: a.deliveryId });
            } catch (err) {
              if (err.code !== 'NOT_FOUND') throw err;
            }
          }
        });
        for (const { a } of list) a.mirrored = true;
      } catch (err) {
        if (err.code !== 'CASE_BUSY' && err.code !== 'CASE_NOT_FOUND') throw err;
      }
    }
    this.state.saveLadder();
  }

  // contact:ladderState. A passive process reads the holder's files.
  list() {
    let ladder = this.state.ladder();
    if (!this.active && this.holder && this.holder.dataDir && this.holder.dataDir !== this.dataDir) {
      ladder = new ContactState({ dir: path.join(this.holder.dataDir, 'contact'), readOnly: true }).ladder();
    }
    const out = {};
    for (const [key, e] of Object.entries(ladder.entries)) {
      out[key] = {
        step: e.step,
        nextAt: e.nextAt,
        nextChannel: e.steps[e.step]?.channel || null,
        expired: e.expired,
        exhausted: e.exhausted,
        attempts: e.attempts.map((a) => ({ channel: a.channel, at: a.at, outcome: a.outcome }))
      };
    }
    return out;
  }
}

module.exports = { LadderEngine, LOCK_FILE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-ladder.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/ladder.js tests/contact-ladder.test.js
git commit -m "feat(contact): ladder engine with batching, quiet hours, digest, mirror and the cases-root lease

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 1 hand-off

When Tasks 1–6 are merged, run:

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/)"`
Expected: no output. Fixtures use only `example.com` addresses, `+15550100`/`+15550199`, `Lakeside lot` and IANA zone names.

Part 2 (`docs/superpowers/plans/2026-09-23-cases-stage4-channels-part2.md`) depends on these exports existing exactly as named:

| Module | Exports |
|---|---|
| `src/channels/channel-plugin.js` | `ChannelPlugin` (contact methods `contactCapabilities`, `sendContact`, `onContactReply`, `onContactStatus`, `presence`, `ownerTarget`, `contactConfigured`), `ChannelRegistry`, `DesktopChannelPlugin`, `ContactDeliveryError`, `ContactUnsupportedError`, `CONTACT_ERROR_CODES`, `GATE_PASSED` |
| `src/cases/contact-format.js` | `CONTACT_CHANNELS`, `STEP_CHANNELS`, `URGENCIES`, `SLACK_ERROR`, `TOKEN_RE`, `DEFAULT_CONTACT_POLICY`, `defaultPolicy`, `effectivePolicy`, `validatePolicy`, `resolveSteps`, `newToken`, `normalizeAddress`, `assertRelayBaseUrl`, `formatShort`, `renderBatch`, `optionOrText`, `parseReply`, `stripQuoted` |
| `src/cases/presence.js` | `Presence`, `wallHhmm`, `HEARTBEAT_STALE_MS`, `MOBILE_STALE_MS` |
| `src/cases/contact-state.js` | `ContactState`, `emptyLadder`, `writeAtomic` |
| `src/cases/contact.js` | `ContactRouter` (with `knows`, `channelStatus`, `recordStatus`, `ingestRelayEvents`, `sendExternal`), `conflictFact`, `conflictAnswered`, `sameAnswer`, `answerLabel` |
| `src/cases/ladder.js` | `LadderEngine`, `LOCK_FILE` |
| `tests/helpers/loopback-channel.js` | `LoopbackChannel`, `DEFAULT_CAPS` |

