# Cases Stage 4: Channels, presence and the contact ladder — Implementation Plan (Part 4 of 4, wave 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone app a contact channel (R44): node-signed `kl.question` envelopes out through F3's relay Mailbox, device-signed `kl.question.answer` envelopes back, verified on the node, and a Questions screen in the iOS and Android apps.
**Architecture:** `src/channels/mobile-app-channel.js` rides F3's `RelayClient` link (`link.send`, `registerMethod`) and `verifyDeviceEnvelope`; `src/frontdoor/question-routes.js` mounts three phone routes on the relay through `src/frontdoor/extensions.js`; the contact host builds the channel when the service passes F3's `startApprovals` result as `deps.approvals`. The apps get a small protocol type in `KLProtocol` / `mobile/android/protocol` and a Questions tab. **Starts only after fleet stage 3 (F3) and Parts 1–3 have merged.**
**Tech Stack:** Node (F3 `src/approvals/*`, `src/frontdoor/*`); Swift/SwiftUI (`KLProtocol`, XcodeGen app); Kotlin/Compose (`protocol` JVM module, `app`). No new npm dependency.
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

### Task 17: The phone app channel on the node

**Files:**
- Create: `src/channels/mobile-app-channel.js`
- Modify: `src/cases/contact-host.js` (a `startMobile` method before `    // core.context.getContact()`), `src/service/run.js` (one line after `          auditLedger: approvals.auditLedger,` in the agent profile's `createCore({ … })`, which F3 added)
- Test: `tests/contact-mobile.test.js`

**Interfaces:**
- Consumes: F3 `seal`, `open`, `nodeSigner`, `verifyEd25519` (`src/approvals/envelope.js`), `verifyDeviceEnvelope`, `NonceCache`, `bytesSha256` (`src/approvals/verify-device.js`), `registerMessageValidator`, `NODE_ID_RE`, `DEVICE_ID_RE`, `NONCE_RE`, `TIMESTAMP_RE`, `randomNonce` (`src/approvals/messages.js`); `RelayClient#send(envelope, { push, to_device })`, `#registerMethod(name, handler)`, `#canDeliver()`; `approverStore.list()`, `.isActive(id)`; test helpers `createFakePhone`, `testNodeIdentity` (`tests/helpers/fake-phone.js`), `approverStoreWith` (`tests/helpers/approver-set.js`). Parts 1–3 `ContactRouter`, `ContactState#resolve(token, { channel })`, `Presence#mobileForeground`, `TOKEN_RE`.
- Produces: `MobileAppChannel({ link, approverStore, identity, nonces, getRouter, presence, isEnabled, clock, log })` (id `mobile`) with `devices()`, `registerMethods()` (link methods `question.answer`, `presence.foreground`), `sendContact` (one node-signed `kl.question` per item and active device, push `{ kind: 'question', id: token }`), `handleAnswer({ envelope }) → { ok, outcome, ack } | { ok: false, error }` (errors: F3's reasons, plus `stale`, `unknown_question`, `not_ready`), `handleForeground({ deviceId, foreground })`; `validateAnswerMessage(m)` registered for `kl.question.answer`; `SIGNED_AT_SKEW_MS` (300 000). `createContactHost` API `startMobile(approvals)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-mobile.test.js`:

```js
// tests/contact-mobile.test.js — cases stage 4 §3.9 (wave 3, R44): the phone
// app as a contact channel. Node side: kl.question out, device-signed
// kl.question.answer in. Relay side (appended in Task 18): the phone routes.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { Presence } = require('../src/cases/presence');
const { defaultPolicy } = require('../src/cases/contact-format');
const { MobileAppChannel, validateAnswerMessage } = require('../src/channels/mobile-app-channel');
const { open, seal, verifyEd25519 } = require('../src/approvals/envelope');
const { randomNonce } = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const dirs = [];
const stores = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const s of stores) s.cleanup();
});
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function world() {
  const phone = createFakePhone({ name: 'Owner phone' });
  const stranger = createFakePhone({ name: 'Other phone' });
  const store = await approverStoreWith([phone.approverRecord()]);
  stores.push(store);
  const node = testNodeIdentity({ key: 'web-01' });
  const now = new Date('2026-09-25T14:00:00Z');
  const clock = () => now;
  const runtime = new CaseRuntime({ root: tmp('kl-mobile-cases-'), now: clock });
  const data = tmp('kl-mobile-data-');
  const state = new ContactState({ dir: path.join(data, 'contact'), clock });
  const policy = defaultPolicy();
  const link = {
    sent: [],
    methods: {},
    send: async (envelope, opts) => { link.sent.push({ envelope, opts }); return { ok: true, seq: link.sent.length }; },
    registerMethod: (name, fn) => { link.methods[name] = fn; },
    canDeliver: () => ({ ok: true })
  };
  const adapters = new Map();
  const presence = new Presence({ file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, isEnabled: (c) => adapters.has(c) });
  const router = new ContactRouter({ state, runtime, adapters, presence, clock });
  const mobile = new MobileAppChannel({ link, approverStore: store, identity: node, getRouter: () => router, presence, clock });
  adapters.set('mobile', mobile);
  mobile.registerMethods();
  mobile.onContactReply((cid, answer, meta) => router.handleReply('mobile', cid, answer, meta));
  const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const q = runtime.questions(info.id).create({ kind: 'question', urgency: 'high', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
  const token = state.newToken();
  await router.deliver('mobile', [{ caseId: info.id, caseTitle: info.title, token, record: q }]);
  const answer = (overrides = {}, signer = phone) => signer.sign({
    v: 1, type: 'kl.question.answer', node_id: node.nodeId, case_id: info.id, question_id: q.id, token,
    answer: { option_id: 'a' }, nonce: randomNonce(), signed_at: now.toISOString(), device_id: signer.deviceId, ...overrides
  });
  const call = (envelope) => link.methods['question.answer']({ envelope }, { peer: 'relay' });
  return { phone, stranger, store, node, runtime, router, mobile, link, info, q, token, answer, call, presence, now };
}

describe('mobile contact channel (node side)', () => {
  it('sends one node-signed kl.question per item and active device, pushing only the token', async () => {
    const w = await world();
    assert.strictEqual(w.link.sent.length, 1);
    const { envelope, opts } = w.link.sent[0];
    assert.deepStrictEqual(opts, { push: { kind: 'question', id: w.token }, to_device: w.phone.deviceId });
    assert.strictEqual(verifyEd25519(envelope, w.node.publicKey.toString('hex')), true);
    const { message } = open(envelope);
    assert.deepStrictEqual(message, {
      v: 1, type: 'kl.question', node_id: w.node.nodeId, case_id: w.info.id, question_id: w.q.id, token: w.token, kind: 'question',
      urgency: 'high', case_title: 'Lakeside lot', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }], expires_at: null
    });
  });

  it('applies a valid device-signed answer as a user fact', async () => {
    const w = await world();
    const r = await w.call(w.answer());
    assert.deepStrictEqual(r, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    const rec = w.runtime.questions(w.info.id).get(w.q.id);
    assert.strictEqual(rec.answer.channel, 'mobile');
    assert.strictEqual(rec.answer.optionId, 'a');
  });

  it('refuses a bad signature, an unknown device, a reused nonce, a stale signed_at, the wrong node and the wrong token', async () => {
    const w = await world();
    const good = w.answer();
    // Change the first base64url character: still canonical, no longer the signature.
    const tampered = { ...good, sig: `${good.sig[0] === 'A' ? 'B' : 'A'}${good.sig.slice(1)}` };
    assert.deepStrictEqual(await w.call(tampered), { ok: false, error: 'bad_signature' });
    assert.deepStrictEqual(await w.call(w.answer({}, w.stranger)), { ok: false, error: 'unknown_device' });
    assert.deepStrictEqual(await w.call(w.answer({ signed_at: '2026-09-25T13:50:00.000Z' })), { ok: false, error: 'stale' });
    assert.deepStrictEqual(await w.call(w.answer({ node_id: testNodeIdentity({ key: 'gpu-box' }).nodeId })), { ok: false, error: 'wrong_node' });
    assert.deepStrictEqual(await w.call(w.answer({ token: 'ZZZZZZ' })), { ok: false, error: 'unknown_question' });
    assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer, null, 'nothing was applied');
    assert.strictEqual((await w.call(good)).ok, true);
    assert.deepStrictEqual(await w.call(good), { ok: false, error: 'replay' }, 'the same bytes again');
  });

  it('a relay-forwarded answer without a device signature is never owner proof', async () => {
    const w = await world();
    const relay = testNodeIdentity({ key: 'relay' });
    const forged = seal({
      v: 1, type: 'kl.question.answer', node_id: w.node.nodeId, case_id: w.info.id, question_id: w.q.id, token: w.token,
      answer: { option_id: 'b' }, nonce: randomNonce(), signed_at: w.now.toISOString(), device_id: w.phone.deviceId
    }, relay.signer);
    assert.deepStrictEqual(await w.call(forged), { ok: false, error: 'malformed' });
    assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer, null);
  });

  it('presence.foreground makes the phone the present channel', async () => {
    const w = await world();
    assert.deepStrictEqual(await w.link.methods['presence.foreground']({ deviceId: w.phone.deviceId, foreground: true }, { peer: 'relay' }), { ok: true });
    assert.strictEqual(w.presence.presentChannel(), 'mobile');
  });

  it('the answer shape the apps build (KLProtocol / protocol Questions) passes the node validator', () => {
    const fromApps = JSON.parse('{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}');
    assert.strictEqual(validateAnswerMessage(fromApps), true);
    assert.strictEqual(validateAnswerMessage({ ...fromApps, answer: { option_id: 'a', text: 'both' } }), false);
    assert.strictEqual(validateAnswerMessage({ ...fromApps, extra: 1 }), false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-mobile.test.js`
Expected: FAIL with `Cannot find module '../src/channels/mobile-app-channel'`

- [ ] **Step 3: Implement**

Create `src/channels/mobile-app-channel.js`:

```js
// src/channels/mobile-app-channel.js
// The phone app as a contact channel (cases stage 4 spec §3.9, R44). Wave 3:
// needs fleet stage 3 (F3). Questions go out as node-signed `kl.question`
// envelopes through the relay Mailbox, one per active enrolled device, with a
// push that carries only the token. An answer counts only as a device-signed
// `kl.question.answer` envelope verified here, on the node, against the
// admin-owned approver set; a relay-forwarded answer is never proof by itself.
const { ChannelPlugin, ContactDeliveryError } = require('./channel-plugin');
const { seal, nodeSigner } = require('../approvals/envelope');
const { verifyDeviceEnvelope, NonceCache, bytesSha256 } = require('../approvals/verify-device');
const messages = require('../approvals/messages');
const { TOKEN_RE } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const SIGNED_AT_SKEW_MS = 300 * 1000;
const QUESTION_ID = /^q-\d{4,}$/;
const CASE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const OPTION_ID = /^[a-z0-9-]{1,16}$/;
const ANSWER_KEYS = ['answer', 'case_id', 'device_id', 'node_id', 'nonce', 'question_id', 'signed_at', 'token', 'type', 'v'];

function validAnswer(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== 1) return false;
  if (keys[0] === 'option_id') return typeof a.option_id === 'string' && OPTION_ID.test(a.option_id);
  if (keys[0] === 'text') return typeof a.text === 'string' && a.text.trim().length > 0 && a.text.length <= 2000;
  return false;
}

// The kl.question.answer shape (§3.9), checked by verifyDeviceEnvelope.
function validateAnswerMessage(m) {
  return JSON.stringify(Object.keys(m).sort()) === JSON.stringify(ANSWER_KEYS)
    && messages.NODE_ID_RE.test(m.node_id) && CASE_ID.test(String(m.case_id)) && QUESTION_ID.test(String(m.question_id))
    && TOKEN_RE.test(String(m.token)) && validAnswer(m.answer) && messages.NONCE_RE.test(m.nonce)
    && messages.TIMESTAMP_RE.test(m.signed_at) && messages.DEVICE_ID_RE.test(m.device_id);
}

try {
  messages.registerMessageValidator('kl.question.answer', validateAnswerMessage);
} catch (err) {
  if (!/already has a validator/.test(err.message)) throw err;
}

function linkError(err) {
  const code = err && err.code;
  if (code === 'too_large') return new ContactDeliveryError('too-large', err.message);
  if (code === 'type_not_routed') return new ContactDeliveryError('rejected', err.message);
  return new ContactDeliveryError('unreachable', err && err.message ? err.message : String(err));
}

class MobileAppChannel extends ChannelPlugin {
  // link: F3's RelayClient; approverStore: the admin <configDir>/approvers/ set;
  // identity: this node's identity; getRouter(): the ContactRouter.
  constructor({
    link, approverStore, identity, nonces = new NonceCache({}), getRouter = () => null, presence = null,
    isEnabled = () => true, clock = () => new Date(), log = createLogger('contact/mobile')
  } = {}) {
    super({ id: 'mobile', label: 'King Louie app', capabilities: ['send'] });
    this.link = link;
    this.approverStore = approverStore;
    this.identity = identity;
    this.nonces = nonces;
    this.getRouter = getRouter;
    this.presenceTracker = presence;
    this.isEnabled = isEnabled;
    this.clock = clock;
    this.log = log;
    this.replyHandler = null;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  devices() {
    return (this.approverStore.list() || [])
      .filter((r) => r && r.platform !== 'demo' && this.approverStore.isActive(r.device_id))
      .map((r) => r.device_id);
  }

  contactCapabilities() {
    if (!this.link || !this.isEnabled() || !this.devices().length) return null;
    return {
      buttons: true, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: true,
      interrupts: true, maxOptions: 6, maxChars: 4000
    };
  }

  ownerTarget() {
    return this.contactCapabilities() ? 'enrolled-devices' : null;
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  registerMethods() {
    this.link.registerMethod('question.answer', (params) => this.handleAnswer(params));
    this.link.registerMethod('presence.foreground', (params) => this.handleForeground(params));
  }

  // question.submit: one node-signed kl.question per item and active device.
  async sendContact(message, meta = {}) {
    const devices = this.devices();
    if (!this.link || !devices.length) throw new ContactDeliveryError('not-configured', 'no active enrolled phone');
    const can = typeof this.link.canDeliver === 'function' ? this.link.canDeliver() : { ok: true };
    if (can && can.ok === false) throw new ContactDeliveryError('unreachable', can.reason || 'the relay link is down');
    const signer = nodeSigner(this.identity);
    for (const item of message.items || []) {
      const envelope = seal({
        v: 1,
        type: 'kl.question',
        node_id: this.identity.nodeId,
        case_id: item.caseId,
        question_id: item.questionId,
        token: item.token,
        kind: item.kind,
        urgency: item.urgency,
        case_title: item.caseTitle,
        text: item.text,
        options: (item.options || []).map((o) => ({ id: o.id, label: o.label })),
        expires_at: item.expiresAt || null
      }, signer);
      for (const device of devices) {
        try {
          await this.link.send(envelope, { push: { kind: 'question', id: item.token }, to_device: device });
        } catch (err) {
          throw linkError(err);
        }
      }
    }
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }

  // Presence may stay relay-trusted (§3.9).
  async handleForeground(params = {}) {
    if (this.presenceTracker && params.deviceId) {
      this.presenceTracker.mobileForeground({ deviceId: String(params.deviceId), foreground: params.foreground === true });
    }
    return { ok: true };
  }

  // The link method question.answer: { envelope } forwarded by the relay.
  async handleAnswer(params = {}) {
    const refuse = (reason) => {
      this.log.warn(`phone answer refused: ${reason}`);
      return { ok: false, error: reason };
    };
    const v = verifyDeviceEnvelope(params.envelope, {
      approverStore: this.approverStore, type: 'kl.question.answer', nodeId: this.identity.nodeId, nonces: this.nonces
    });
    if (!v.ok) return refuse(v.reason);
    const m = v.message;
    if (Math.abs(this.clock().getTime() - Date.parse(m.signed_at)) > SIGNED_AT_SKEW_MS) return refuse('stale');
    const router = this.getRouter();
    const found = router ? router.state.resolve(m.token, { channel: 'mobile' }) : null;
    if (!found || !found.item || found.delivery.channel !== 'mobile'
      || found.item.caseId !== m.case_id || found.item.questionId !== m.question_id) {
      return refuse('unknown_question');
    }
    this.nonces.add(m.nonce, bytesSha256(v.bytes));
    if (!this.replyHandler) return refuse('not_ready');
    const answer = m.answer.option_id ? { optionId: m.answer.option_id } : { text: m.answer.text };
    const result = await this.replyHandler(found.item.token, answer, {
      channel: 'mobile', senderId: v.deviceId, chatId: null, at: m.signed_at, ownerProven: true
    });
    return { ok: Boolean(result && result.ok), outcome: result ? result.outcome : 'unknown', ack: result ? result.ackText : null };
  }
}

module.exports = { MobileAppChannel, validateAnswerMessage, SIGNED_AT_SKEW_MS };
```

In `src/cases/contact-host.js`, replace

```js
    // core.context.getContact()
    context() {
```

with

```js
    // Wave 3 (R44): the phone app, when the service runs F3 approvals.
    async startMobile(approvals) {
      if (!approvals || !approvals.relayClient || !approvals.approverStore || !approvals.identity) return;
      const { MobileAppChannel } = require('../channels/mobile-app-channel');
      const { NonceCache } = require('../approvals/verify-device');
      const mobile = new MobileAppChannel({
        link: approvals.relayClient,
        approverStore: approvals.approverStore,
        identity: approvals.identity,
        nonces: new NonceCache({}),
        getRouter: () => router,
        presence,
        isEnabled: () => channelSettings('mobile').enabled === true,
        clock
      });
      mobile.registerMethods();
      wire('mobile', mobile);
      built.set('mobile', mobile);
    },

    // core.context.getContact()
    context() {
```

In `src/service/run.js`, in the agent profile's `createCore({ … })` call, replace

```js
          auditLedger: approvals.auditLedger,
```

with

```js
          auditLedger: approvals.auditLedger,
          // Cases stage 4 (wave 3): the phone app contact channel uses the relay link and the approvers.
          approvals,
```

(`createCore` already forwards `deps.approvals` to the contact host, Part 3 Task 13; the desktop host passes no `approvals`, so it has no phone channel.)

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-mobile.test.js tests/contact-host.test.js tests/service-run.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/mobile-app-channel.js src/cases/contact-host.js src/service/run.js tests/contact-mobile.test.js
git commit -m "feat(contact): phone app contact channel with device-signed answers verified on the node

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: The relay's question routes

**Files:**
- Create: `src/frontdoor/question-routes.js`
- Modify: `src/frontdoor/extensions.js` (append one line at the end)
- Test: a new `describe` appended to `tests/contact-mobile.test.js`

**Interfaces:**
- Consumes: F3 extension contract (`{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }`), `phoneApi.registerRoute`, `nodeHub.rpc`, `Mailbox` (`src/frontdoor/mailbox.js`) `registerType`, `put`, `list`, `devices.nodesForDevice`, `open`.
- Produces: `registerQuestionRoutes(relay)`: mailbox type `kl.question` (TTL 7 days), `GET /v1/questions` (device auth; the device's mailbox entries on its active nodes), `POST /v1/questions/{token}/answer` (device auth, 30/min; body = the signed envelope; checks device, token and node, then `nodeHub.rpc(nodeId, 'question.answer', { envelope }, { timeoutMs: 10000 })`; `502 node_offline` when the node does not answer), `POST /v1/presence` (device auth, 6/min; `presence.foreground` to each active node); `WEEK_MS`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/contact-mobile.test.js`:

```js
describe('question routes (relay side)', () => {
  const { registerQuestionRoutes, WEEK_MS } = require('../src/frontdoor/question-routes');
  const { Mailbox } = require('../src/frontdoor/mailbox');

  function relay() {
    const routes = new Map();
    const rpcs = [];
    const phoneApi = { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) };
    const nodeHub = { rpc: async (nodeId, method, params, opts) => { rpcs.push({ nodeId, method, params, opts }); return method === 'question.answer' ? { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' } : { ok: true }; } };
    const mailbox = new Mailbox({ now: () => Date.parse('2026-09-25T14:00:00Z') });
    const devices = { nodesForDevice: (id) => [{ node_id: 'kl-aaaaaaaaaaaaaaaa', state: id === 'd-revokedrevokedre' ? 'revoked' : 'active' }] };
    const log = { warn() {}, debug() {}, info() {} };
    registerQuestionRoutes({ phoneApi, nodeHub, mailbox, devices, log });
    return { routes, rpcs, mailbox };
  }

  it('registers the three device-authenticated routes with their rate limits and the kl.question mailbox type', () => {
    const r = relay();
    assert.deepStrictEqual([...r.routes.keys()], ['GET /v1/questions', 'POST /v1/questions/{token}/answer', 'POST /v1/presence']);
    for (const spec of r.routes.values()) assert.strictEqual(spec.auth, 'device');
    assert.deepStrictEqual(r.routes.get('POST /v1/questions/{token}/answer').rate, { perMin: 30 });
    assert.deepStrictEqual(r.routes.get('POST /v1/presence').rate, { perMin: 6 });
    assert.strictEqual(WEEK_MS, 7 * 24 * 3600 * 1000);
  });

  it('lists the mailbox for this device and forwards an answer envelope unchanged to its node', async () => {
    const r = relay();
    const node = testNodeIdentity({ key: 'web-01' });
    const phone = createFakePhone();
    const nodeId = 'kl-aaaaaaaaaaaaaaaa';
    const question = seal({ v: 1, type: 'kl.question', node_id: node.nodeId, token: '7QD4KM' }, node.signer);
    r.mailbox.put(nodeId, question, { to_device: phone.deviceId });
    const listed = await r.routes.get('GET /v1/questions').handler({}, { deviceId: phone.deviceId, params: {}, query: {}, body: null });
    assert.strictEqual(listed.body.length, 1);
    assert.deepStrictEqual(listed.body[0].envelope, question);

    const envelope = phone.sign({ v: 1, type: 'kl.question.answer', node_id: nodeId, case_id: 'mfz1k2-0a1b2c3d', question_id: 'q-0012', token: '7QD4KM', answer: { option_id: 'a' }, nonce: randomNonce(), signed_at: '2026-09-25T14:00:00.000Z', device_id: phone.deviceId });
    const answerRoute = r.routes.get('POST /v1/questions/{token}/answer');
    const out = await answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, query: {}, body: envelope });
    assert.deepStrictEqual(out.body, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    assert.deepStrictEqual(r.rpcs[0], { nodeId, method: 'question.answer', params: { envelope }, opts: { timeoutMs: 10000 } });

    await assert.rejects(answerRoute.handler({}, { deviceId: 'd-otherotherother', params: { token: '7QD4KM' }, body: envelope }), (err) => err.status === 403);
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: 'K7QD4M' }, body: envelope }), (err) => err.status === 400);
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: { not: 'an envelope' } }), (err) => err.status === 400);
  });

  it('forwards foreground pings as presence.foreground to each active node', async () => {
    const r = relay();
    const out = await r.routes.get('POST /v1/presence').handler({}, { deviceId: 'd-bbbbbbbbbbbbbbbb', params: {}, body: { foreground: true } });
    assert.deepStrictEqual(out.body, { ok: true, nodes: 1 });
    assert.deepStrictEqual(r.rpcs[0], { nodeId: 'kl-aaaaaaaaaaaaaaaa', method: 'presence.foreground', params: { deviceId: 'd-bbbbbbbbbbbbbbbb', foreground: true }, opts: { timeoutMs: 5000 } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-mobile.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/question-routes'` (the node-side suite still passes)

- [ ] **Step 3: Implement**

Create `src/frontdoor/question-routes.js`:

```js
// src/frontdoor/question-routes.js
// The relay side of the phone app's Questions screen (cases stage 4 spec
// §3.9, R44), mounted through src/frontdoor/extensions.js. The relay stores
// and forwards; it never decides an answer. The node verifies the device
// signature. Loads no agent code.
const { open } = require('../approvals/envelope');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{6}$/;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// (relay) => void, receiving { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }.
function registerQuestionRoutes({ phoneApi, nodeHub, mailbox, devices, log }) {
  mailbox.registerType('kl.question', { ttlMs: WEEK_MS });

  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);

  phoneApi.registerRoute('GET', '/v1/questions', {
    auth: 'device',
    handler: async (req, ctx) => ({ body: mailbox.list({ nodeIds: activeNodes(ctx.deviceId), typePrefix: 'kl.question', toDevice: ctx.deviceId }) })
  });

  // The body is the device-signed kl.question.answer envelope, forwarded unchanged.
  phoneApi.registerRoute('POST', '/v1/questions/{token}/answer', {
    auth: 'device',
    rate: { perMin: 30 },
    handler: async (req, ctx) => {
      if (!TOKEN.test(String(ctx.params.token))) throw httpError(400, 'bad_token', 'not a question token');
      let message;
      try {
        ({ message } = open(ctx.body));
      } catch {
        throw httpError(400, 'malformed', 'the body is not an envelope');
      }
      if (message.type !== 'kl.question.answer') throw httpError(400, 'malformed', 'not a kl.question.answer');
      if (message.device_id !== ctx.deviceId) throw httpError(403, 'forbidden', 'the answer is signed for another device');
      if (message.token !== ctx.params.token) throw httpError(400, 'bad_token', 'the token does not match the path');
      if (!activeNodes(ctx.deviceId).includes(message.node_id)) throw httpError(404, 'not_found', 'no such node for this device');
      let result;
      try {
        result = await nodeHub.rpc(message.node_id, 'question.answer', { envelope: ctx.body }, { timeoutMs: 10000 });
      } catch (err) {
        log.warn(`question.answer to ${message.node_id} failed: ${err.message}`);
        throw httpError(502, 'node_offline', 'the node did not answer; try again');
      }
      return { body: result };
    }
  });

  // Foreground pings: presence may stay relay-trusted.
  phoneApi.registerRoute('POST', '/v1/presence', {
    auth: 'device',
    rate: { perMin: 6 },
    handler: async (req, ctx) => {
      const foreground = ctx.body && ctx.body.foreground === true;
      let delivered = 0;
      for (const nodeId of activeNodes(ctx.deviceId)) {
        try {
          await nodeHub.rpc(nodeId, 'presence.foreground', { deviceId: ctx.deviceId, foreground }, { timeoutMs: 5000 });
          delivered += 1;
        } catch (err) {
          log.debug(`presence.foreground to ${nodeId} failed: ${err.message}`);
        }
      }
      return { body: { ok: true, nodes: delivered } };
    }
  });
}

module.exports = { registerQuestionRoutes, WEEK_MS };
```

Append to the end of `src/frontdoor/extensions.js`:

```js
// Cases stage 4 (R44): the phone app's Questions screen.
module.exports.push(require('./question-routes').registerQuestionRoutes);
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-mobile.test.js tests/frontdoor-relay.test.js`
Expected: PASS, `# fail 0` (`frontdoor-relay` starts a relay with the real extension list, so a registration error would show there)

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/question-routes.js src/frontdoor/extensions.js tests/contact-mobile.test.js
git commit -m "feat(contact): relay routes for phone questions, answers and foreground presence

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: The Questions screen in the iOS and Android apps, and final verification

**Files:**
- Create: `mobile/ios/KLProtocol/Sources/KLProtocol/Questions.swift`, `mobile/ios/KLProtocol/Tests/KLProtocolTests/QuestionTests.swift`, `mobile/ios/App/Questions.swift`, `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Questions.kt`, `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/QuestionTest.kt`, `mobile/android/app/src/main/kotlin/com/example/kinglouie/Questions.kt`
- Modify: `mobile/ios/App/RelayAPI.swift` (before `    func nodes() async throws -> [JSONValue] {`), `mobile/ios/App/AppModel.swift` (after `    var deviceId: String? { … }`), `mobile/ios/App/Views.swift` (the `TabView` in `MainView`), `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt` (an import; before `    suspend fun nodes()`), `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt` (two imports; after `envelopeOf`), `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt` (`Main`'s tabs), `CLAUDE.md` (one bullet appended to the stage 4 section)
- Test: `mobile/ios/KLProtocol/Tests/KLProtocolTests/QuestionTests.swift`, `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/QuestionTest.kt`

**Interfaces:**
- Consumes: F3 app code — iOS `RelayAPI.request`, `AppModel` (`client`, `key`, `state.nodes`, `fail`, `banner`, `mode`), `DeviceKey.sign(_:reason:)`, `Envelope`, `JCS`, `Base64URL`, `Messages.randomNonce()`, `Timestamps.string`; Android `RelayApi.request`, `AppModel` (`client`, `key`, `storage`, `scope`, `activity`, `fail`, `banner`, `mode`, `envelopeOf`), `DeviceKey.sign(activity, bytes, reason)`, `Envelope.fromJson`, `Jcs`, `Messages.randomNonce()`, `Timestamps.string`.
- Produces: `KLProtocol` `QuestionOption`, `QuestionItem(message:nodeName:)`, `Questions.answer(to:optionId:text:deviceId:nonce:signedAt:)`; Kotlin `QuestionOption`, `QuestionItem.from(message, nodeName)`, `Questions.answer(item, optionId, text, deviceId, nonce, signedAt)`; iOS `RelayAPI.questions()`, `.answerQuestion(_:envelope:)`, `.presence(foreground:)`, `AppModel.questions`, `.refreshQuestions()`, `.answer(_:optionId:text:)`, `.pingPresence(foreground:)`, `QuestionsView`, `PresencePinger`; Android `RelayApi.questions()`, `.answerQuestion(token, envelope)`, `.presence(foreground)`, `AppModel.questions`, `.refreshQuestions()`, `.answer(item, optionId, text)`, `.pingPresence(foreground)`, `@Composable Questions(model)`.

- [ ] **Step 1: Write the failing tests**

Create `mobile/ios/KLProtocol/Tests/KLProtocolTests/QuestionTests.swift`:

```swift
import XCTest
@testable import KLProtocol

/// Cases stage 4 §3.9. The expected bytes are the same string the node test
/// (tests/contact-mobile.test.js) feeds to its kl.question.answer validator.
final class QuestionTests: XCTestCase {
    let question: JSONValue = .object([
        "v": .number("1"),
        "type": .string("kl.question"),
        "node_id": .string("kl-aaaaaaaaaaaaaaaa"),
        "case_id": .string("mfz1k2-0a1b2c3d"),
        "question_id": .string("q-0012"),
        "token": .string("7QD4KM"),
        "kind": .string("question"),
        "urgency": .string("high"),
        "case_title": .string("Lakeside lot"),
        "text": .string("Accept the 41k offer?"),
        "options": .array([.object(["id": .string("a"), "label": .string("Yes")]), .object(["id": .string("b"), "label": .string("No")])]),
        "expires_at": .null
    ])

    func testParsesAQuestion() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01"))
        XCTAssertEqual(item.token, "7QD4KM")
        XCTAssertEqual(item.caseTitle, "Lakeside lot")
        XCTAssertEqual(item.urgency, "high")
        XCTAssertEqual(item.options, [QuestionOption(id: "a", label: "Yes"), QuestionOption(id: "b", label: "No")])
    }

    func testRefusesAnythingElse() {
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.approval.request")]), nodeName: "web-01"))
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.question"), "token": .string("7QD4KM")]), nodeName: "web-01"))
    }

    func testBuildsTheAnswerTheNodeVerifies() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01"))
        let message = Questions.answer(to: item, optionId: "a", text: nil, deviceId: "d-bbbbbbbbbbbbbbbb",
                                       nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertEqual(JCS.serialize(message), #"{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}"#)
        let textAnswer = Questions.answer(to: item, optionId: nil, text: "Only after the survey", deviceId: "d-bbbbbbbbbbbbbbbb",
                                          nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertTrue(JCS.serialize(textAnswer).hasPrefix(#"{"answer":{"text":"Only after the survey"},"#))
    }
}
```

Create `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/QuestionTest.kt`:

```kotlin
package com.example.kinglouie.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cases stage 4 §3.9. The expected bytes are the same string the node test
 * (tests/contact-mobile.test.js) feeds to its kl.question.answer validator.
 */
class QuestionTest {
    private val question = JsonText.parse(
        """{"v":1,"type":"kl.question","node_id":"kl-aaaaaaaaaaaaaaaa","case_id":"mfz1k2-0a1b2c3d","question_id":"q-0012","token":"7QD4KM","kind":"question","urgency":"high","case_title":"Lakeside lot","text":"Accept the 41k offer?","options":[{"id":"a","label":"Yes"},{"id":"b","label":"No"}],"expires_at":null}"""
    )

    @Test
    fun parsesAQuestion() {
        val item = QuestionItem.from(question, "web-01")
        assertNotNull(item)
        assertEquals("7QD4KM", item!!.token)
        assertEquals("Lakeside lot", item.caseTitle)
        assertEquals(listOf(QuestionOption("a", "Yes"), QuestionOption("b", "No")), item.options)
    }

    @Test
    fun refusesAnythingElse() {
        assertNull(QuestionItem.from(JsonText.parse("""{"type":"kl.approval.request"}"""), "web-01"))
        assertNull(QuestionItem.from(JsonText.parse("""{"type":"kl.question","token":"7QD4KM"}"""), "web-01"))
    }

    @Test
    fun buildsTheAnswerTheNodeVerifies() {
        val item = QuestionItem.from(question, "web-01")!!
        val message = Questions.answer(item, "a", null, "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
        assertEquals(
            """{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}""",
            Jcs.serialize(message)
        )
        val text = Questions.answer(item, null, "Only after the survey", "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
        assertTrue(Jcs.serialize(text).startsWith("""{"answer":{"text":"Only after the survey"},"""))
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mobile/ios/KLProtocol && swift test`
Expected: FAIL — `cannot find 'QuestionItem' in scope`

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: FAIL — `compileTestKotlin` reports `Unresolved reference 'QuestionItem'`

- [ ] **Step 3: Implement**

Create `mobile/ios/KLProtocol/Sources/KLProtocol/Questions.swift`:

```swift
import Foundation

/// Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.9):
/// the node-signed `kl.question` a phone shows, and the device-signed
/// `kl.question.answer` it sends back.
public struct QuestionOption: Equatable, Identifiable {
    public let id: String
    public let label: String
}

public struct QuestionItem: Equatable, Identifiable {
    public var id: String { token }
    public let token: String
    public let nodeId: String
    public let nodeName: String
    public let caseId: String
    public let questionId: String
    public let caseTitle: String
    public let kind: String
    public let urgency: String
    public let text: String
    public let options: [QuestionOption]

    /// nil unless `message` is a complete `kl.question`.
    public init?(message: JSONValue, nodeName: String) {
        guard message["type"]?.stringValue == "kl.question",
              let token = message["token"]?.stringValue, let nodeId = message["node_id"]?.stringValue,
              let caseId = message["case_id"]?.stringValue, let questionId = message["question_id"]?.stringValue,
              let text = message["text"]?.stringValue else { return nil }
        self.token = token
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.caseId = caseId
        self.questionId = questionId
        self.caseTitle = message["case_title"]?.stringValue ?? ""
        self.kind = message["kind"]?.stringValue ?? "question"
        self.urgency = message["urgency"]?.stringValue ?? "normal"
        self.text = text
        self.options = (message["options"]?.arrayValue ?? []).compactMap { option in
            guard let id = option["id"]?.stringValue, let label = option["label"]?.stringValue else { return nil }
            return QuestionOption(id: id, label: label)
        }
    }
}

public enum Questions {
    /// The message the phone signs; the node checks every field (R44).
    public static func answer(to item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String) -> JSONValue {
        let answer: JSONValue = optionId.map { .object(["option_id": .string($0)]) } ?? .object(["text": .string(text ?? "")])
        return .object([
            "v": .number("1"),
            "type": .string("kl.question.answer"),
            "node_id": .string(item.nodeId),
            "case_id": .string(item.caseId),
            "question_id": .string(item.questionId),
            "token": .string(item.token),
            "answer": answer,
            "nonce": .string(nonce),
            "signed_at": .string(signedAt),
            "device_id": .string(deviceId)
        ])
    }
}
```

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Questions.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.9):
 * the node-signed `kl.question` a phone shows and the device-signed
 * `kl.question.answer` it sends back.
 */
data class QuestionOption(val id: String, val label: String)

data class QuestionItem(
    val token: String,
    val nodeId: String,
    val nodeName: String,
    val caseId: String,
    val questionId: String,
    val caseTitle: String,
    val kind: String,
    val urgency: String,
    val text: String,
    val options: List<QuestionOption>
) {
    companion object {
        /** null unless [message] is a complete `kl.question`. */
        fun from(message: JsonElement, nodeName: String): QuestionItem? {
            if (message["type"].str() != "kl.question") return null
            val token = message["token"].str() ?: return null
            val nodeId = message["node_id"].str() ?: return null
            val caseId = message["case_id"].str() ?: return null
            val questionId = message["question_id"].str() ?: return null
            val text = message["text"].str() ?: return null
            val options = (message["options"].arr() ?: emptyList()).mapNotNull { o ->
                val id = o["id"].str() ?: return@mapNotNull null
                val label = o["label"].str() ?: return@mapNotNull null
                QuestionOption(id, label)
            }
            return QuestionItem(
                token, nodeId, nodeName, caseId, questionId, message["case_title"].str() ?: "",
                message["kind"].str() ?: "question", message["urgency"].str() ?: "normal", text, options
            )
        }
    }
}

object Questions {
    /** The message the phone signs; the node checks every field (R44). */
    fun answer(item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String): JsonObject {
        val answer = if (optionId != null) JsonObject(mapOf("option_id" to jsonString(optionId)))
        else JsonObject(mapOf("text" to jsonString(text ?: "")))
        return JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "type" to jsonString("kl.question.answer"),
                "node_id" to jsonString(item.nodeId),
                "case_id" to jsonString(item.caseId),
                "question_id" to jsonString(item.questionId),
                "token" to jsonString(item.token),
                "answer" to answer,
                "nonce" to jsonString(nonce),
                "signed_at" to jsonString(signedAt),
                "device_id" to jsonString(deviceId)
            )
        )
    }
}
```

Create `mobile/ios/App/Questions.swift`:

```swift
import KLProtocol
import SwiftUI

/// Cases stage 4: questions from the nodes, answered with a fresh biometric
/// signature (the node verifies it; the relay only forwards).
struct QuestionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var drafts: [String: String] = [:]

    var body: some View {
        NavigationStack {
            List(model.questions) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(item.caseTitle) · \(item.nodeName)").font(.caption).foregroundStyle(.secondary)
                    Text(item.text).fontWeight(item.urgency == "high" ? .bold : .regular)
                    if item.kind == "briefing" {
                        Button("Got it") { Task { await model.answer(item, optionId: nil, text: "ok") } }
                            .buttonStyle(.bordered)
                    } else {
                        ForEach(item.options) { option in
                            Button(option.label) { Task { await model.answer(item, optionId: option.id, text: nil) } }
                                .buttonStyle(.bordered)
                        }
                        HStack {
                            TextField("Answer…", text: Binding(get: { drafts[item.token] ?? "" }, set: { drafts[item.token] = $0 }))
                                .textFieldStyle(.roundedBorder)
                            Button("Send") {
                                let text = (drafts[item.token] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                                Task { await model.answer(item, optionId: nil, text: text) }
                            }
                            .disabled((drafts[item.token] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .overlay { if model.questions.isEmpty { Text("No open questions").foregroundStyle(.secondary) } }
            .refreshable { await model.refreshQuestions() }
            .task { await model.refreshQuestions() }
            .navigationTitle("Questions")
        }
    }
}

/// Foreground pings every 60 s while the app is active (§3.4: a ping is
/// fresh for 120 s); one "not in the foreground" when it leaves.
struct PresencePinger: ViewModifier {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase

    func body(content: Content) -> some View {
        content.task(id: phase) {
            guard phase == .active else {
                await model.pingPresence(foreground: false)
                return
            }
            while !Task.isCancelled {
                await model.pingPresence(foreground: true)
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
}
```

In `mobile/ios/App/RelayAPI.swift`, replace

```swift
    func nodes() async throws -> [JSONValue] {
```

with

```swift
    // Cases stage 4: node-signed kl.question envelopes, and answers back.
    func questions() async throws -> [JSONValue] {
        try await request("GET", "/v1/questions").1?.arrayValue ?? []
    }

    func answerQuestion(_ token: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/questions/\(token)/answer", body: envelope.json).1
    }

    func presence(foreground: Bool) async throws {
        _ = try await request("POST", "/v1/presence", body: .object(["foreground": .bool(foreground)]))
    }

    func nodes() async throws -> [JSONValue] {
```

In `mobile/ios/App/AppModel.swift`, replace

```swift
    var deviceId: String? { mode == .demo ? demo?.deviceId : key?.deviceId }
```

with

```swift
    var deviceId: String? { mode == .demo ? demo?.deviceId : key?.deviceId }

    // MARK: Questions (cases stage 4)

    @Published var questions: [QuestionItem] = []
    private var answeredTokens = Set<String>()

    /// Only questions whose envelope verifies against a pinned node are shown.
    func refreshQuestions() async {
        guard mode == .live, let client else { questions = []; return }
        do {
            var items: [QuestionItem] = []
            for entry in try await client.questions() {
                guard let envJSON = entry["envelope"], let env = try? Envelope(json: envJSON),
                      let pin = state.nodes.first(where: { $0.id == env.kid }), env.verifyEd25519(spkiHex: pin.key),
                      let message = try? env.message(), let item = QuestionItem(message: message, nodeName: pin.name),
                      !answeredTokens.contains(item.token), !items.contains(where: { $0.token == item.token }) else { continue }
                items.append(item)
            }
            questions = items
        } catch {
            fail(error)
        }
    }

    /// A fresh biometric signature over the answer; the node verifies it (R44).
    func answer(_ item: QuestionItem, optionId: String?, text: String?) async {
        guard mode == .live, let key, let client else { return }
        do {
            let message = Questions.answer(to: item, optionId: optionId, text: text, deviceId: key.deviceId,
                                           nonce: Messages.randomNonce(), signedAt: Timestamps.string(Date()))
            let bytes = JCS.data(message)
            let signature = try await key.sign(bytes, reason: "Answer: \(item.text.prefix(60))")
            let envelope = Envelope(alg: "ES256", kid: key.deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
            let result = try await client.answerQuestion(item.token, envelope: envelope)
            if result?["ok"]?.boolValue == false {
                banner = "Not recorded: \(result?["error"]?.stringValue ?? "refused")"
            } else {
                answeredTokens.insert(item.token)
                questions.removeAll { $0.token == item.token }
                if let ack = result?["ack"]?.stringValue { banner = ack }
            }
        } catch {
            fail(error)
        }
    }

    func pingPresence(foreground: Bool) async {
        guard mode == .live, let client else { return }
        try? await client.presence(foreground: foreground)
    }
```

In `mobile/ios/App/Views.swift`, replace

```swift
                PendingListView().tabItem { Label("Pending", systemImage: "checkmark.shield") }
```

with

```swift
                PendingListView().tabItem { Label("Pending", systemImage: "checkmark.shield") }
                QuestionsView().tabItem { Label("Questions", systemImage: "questionmark.bubble") }
```

and replace

```swift
                SettingsView().tabItem { Label("Settings", systemImage: "gear") }
            }
```

with

```swift
                SettingsView().tabItem { Label("Settings", systemImage: "gear") }
            }
            .modifier(PresencePinger())
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/Questions.kt`:

```kotlin
package com.example.kinglouie

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Cases stage 4: questions from the nodes, answered with a fresh biometric signature. */
@Composable
fun Questions(model: AppModel) {
    LaunchedEffect(Unit) { model.refreshQuestions() }
    val drafts = remember { mutableStateMapOf<String, String>() }
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton({ model.refreshQuestions() }) { Text("Refresh") }
        if (model.questions.isEmpty()) Text("No open questions")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(model.questions, key = { it.token }) { item ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${item.caseTitle} · ${item.nodeName}", style = MaterialTheme.typography.labelSmall)
                    Text(item.text, fontWeight = if (item.urgency == "high") FontWeight.Bold else FontWeight.Normal)
                    if (item.kind == "briefing") {
                        OutlinedButton({ model.answer(item, null, "ok") }) { Text("Got it") }
                    } else {
                        item.options.forEach { option ->
                            OutlinedButton({ model.answer(item, option.id, null) }) { Text(option.label) }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(drafts[item.token] ?: "", { drafts[item.token] = it }, label = { Text("Answer…") }, modifier = Modifier.weight(1f))
                            Button({ model.answer(item, null, (drafts[item.token] ?: "").trim()) }, enabled = (drafts[item.token] ?: "").isNotBlank()) { Text("Send") }
                        }
                    }
                }
            }
        }
    }
}
```

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt`, replace

```kotlin
import kotlinx.serialization.json.JsonObject
```

with

```kotlin
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
```

and replace

```kotlin
    suspend fun nodes(): List<JsonElement> = request("GET", "/v1/nodes").second.arr() ?: emptyList()
```

with

```kotlin
    // Cases stage 4: node-signed kl.question envelopes, and answers back.
    suspend fun questions(): List<JsonElement> = request("GET", "/v1/questions").second.arr() ?: emptyList()
    suspend fun answerQuestion(token: String, envelope: Envelope): JsonElement? = request("POST", "/v1/questions/$token/answer", envelope.json).second
    suspend fun presence(foreground: Boolean) {
        request("POST", "/v1/presence", JsonObject(mapOf("foreground" to JsonPrimitive(foreground))))
    }
    suspend fun nodes(): List<JsonElement> = request("GET", "/v1/nodes").second.arr() ?: emptyList()
```

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt`, replace

```kotlin
import com.example.kinglouie.protocol.NodePin
```

with

```kotlin
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.QuestionItem
import com.example.kinglouie.protocol.Questions
```

and replace

```kotlin
    private fun envelopeOf(message: JsonElement, kid: String, signature: ByteArray) =
        Envelope("ES256", kid, B64Url.encode(Jcs.bytes(message)), B64Url.encode(signature))
```

with

```kotlin
    private fun envelopeOf(message: JsonElement, kid: String, signature: ByteArray) =
        Envelope("ES256", kid, B64Url.encode(Jcs.bytes(message)), B64Url.encode(signature))

    // ---- Questions (cases stage 4) ----
    val questions = mutableStateListOf<QuestionItem>()
    private val answeredTokens = mutableSetOf<String>()

    /** Only questions whose envelope verifies against a pinned node are shown. */
    fun refreshQuestions() = scope.launch {
        val api = client
        if (mode != AppMode.LIVE || api == null) { questions.clear(); return@launch }
        try {
            val pins = storage.nodes
            val items = api.questions().mapNotNull { entry ->
                val env = runCatching { Envelope.fromJson(entry["envelope"]!!) }.getOrNull() ?: return@mapNotNull null
                val pin = pins.firstOrNull { it.id == env.kid } ?: return@mapNotNull null
                if (!env.verifyEd25519(pin.key)) return@mapNotNull null
                QuestionItem.from(env.message(), pin.name)
            }.distinctBy { it.token }.filter { it.token !in answeredTokens }
            questions.clear()
            questions.addAll(items)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** A fresh biometric signature over the answer; the node verifies it (R44). */
    fun answer(item: QuestionItem, optionId: String?, text: String?) = scope.launch {
        if (mode != AppMode.LIVE) return@launch
        val k = key ?: return@launch
        val api = client ?: return@launch
        try {
            val message = Questions.answer(item, optionId, text, k.deviceId, Messages.randomNonce(), Timestamps.string(Instant.now()))
            val signature = k.sign(activity!!, Jcs.bytes(message), "Answer: ${item.text.take(60)}")
            val result = api.answerQuestion(item.token, envelopeOf(message, k.deviceId, signature))
            if (result["ok"]?.let { (it as? JsonPrimitive)?.content } == "false") {
                banner = "Not recorded: ${result["error"].str() ?: "refused"}"
            } else {
                answeredTokens.add(item.token)
                questions.removeAll { it.token == item.token }
                result["ack"].str()?.let { banner = it }
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun pingPresence(foreground: Boolean) = scope.launch {
        val api = client ?: return@launch
        if (mode != AppMode.LIVE) return@launch
        runCatching { api.presence(foreground) }
    }
```

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt`, replace

```kotlin
    var tab by remember { mutableStateOf(0) }
    val tabs = listOf("Pending", "History", "Nodes", "Devices", "Settings")
```

with

```kotlin
    var tab by remember { mutableStateOf(0) }
    val tabs = listOf("Pending", "Questions", "History", "Nodes", "Devices", "Settings")
    // Cases stage 4: foreground presence pings every 60 s while the app is shown.
    LaunchedEffect(Unit) { while (true) { model.pingPresence(true); delay(60000) } }
```

and replace

```kotlin
                0 -> Pending(model)
                1 -> History(model)
                2 -> Nodes(model)
                3 -> Devices(model)
```

with

```kotlin
                0 -> Pending(model)
                1 -> Questions(model)
                2 -> History(model)
                3 -> Nodes(model)
                4 -> Devices(model)
```

In `CLAUDE.md`, at the end of the `## Cases: contact channels (stage 4)` section, append:

```markdown
- The phone app channel (`src/channels/mobile-app-channel.js`) exists only
  in the service with F3 approvals running: questions go out as node-signed
  `kl.question` envelopes; an answer counts only as a device-signed
  `kl.question.answer` verified on the node (nonce, `signed_at` ± 300 s, live
  token). The relay routes are `src/frontdoor/question-routes.js`.
```

- [ ] **Step 4: Run the tests and the builds**

Run: `cd mobile/ios/KLProtocol && swift test`
Expected: `Executed 16 tests, with 0 failures` (F3's 13 plus 3)

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: `BUILD SUCCESSFUL`, 16 tests (F3's 13 plus 3)

Run: `cd mobile/ios && xcodegen generate && xcodebuild -project KingLouie.xcodeproj -scheme KingLouie -destination 'generic/platform=iOS Simulator' build`
Expected: `** BUILD SUCCEEDED **` (macOS with Xcode only)

Run: `cd mobile/android && ./gradlew :app:compileNopushDebugKotlin :app:compileFcmDebugKotlin :app:assembleNopushDebug`
Expected: `BUILD SUCCESSFUL`

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests mobile CLAUDE.md | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/)"`
Expected: no output (identifiers stay `com.example.kinglouie`, hosts `example.com`).

- [ ] **Step 5: Commit**

```bash
git add mobile/ios/KLProtocol/Sources/KLProtocol/Questions.swift mobile/ios/KLProtocol/Tests/KLProtocolTests/QuestionTests.swift mobile/ios/App/Questions.swift mobile/ios/App/RelayAPI.swift mobile/ios/App/AppModel.swift mobile/ios/App/Views.swift mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Questions.kt mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/QuestionTest.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/Questions.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt CLAUDE.md
git commit -m "feat(contact): Questions screen in the iOS and Android apps with foreground presence

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Stage hand-off

When Tasks 17–19 are merged, cases stage 4 is complete. Later stages consume exactly these names (spec §5.2):

| Consumer | Names |
|---|---|
| Future channel senders (no stage-3 consumer, R39) | `core.context.getContact().router.sendExternal({ caseId, channelId, target, text, envelope }) → { ok, deliveryId } \| { ok: false, error, blocked? }` |
| C2 / every stage that asks | `CaseRuntime.createQuestion` as before; the ladder picks up every open record on its next tick |
| F7 (attached desktop) | IPC `contact:ladderState`, `contactPolicy:get`, `contactPolicy:set`, `presence:heartbeat`, `presence:status`; domains `contact`, `contactPolicy`, `presence` in `PROXIED_DOMAINS` |
| Relay operators | the contact relay contract (spec §4.5) and `POST http://127.0.0.1:<webhookPort>/contact/relay/<name>` |
| Mobile apps | `GET /v1/questions`, `POST /v1/questions/{token}/answer`, `POST /v1/presence`; `kl.question`, `kl.question.answer`; push kind `question` |
| Modules | `src/channels/mobile-app-channel.js` (`MobileAppChannel`, `validateAnswerMessage`, `SIGNED_AT_SKEW_MS`), `src/frontdoor/question-routes.js` (`registerQuestionRoutes`, `WEEK_MS`), plus every Part 1–3 export listed in those hand-offs |

