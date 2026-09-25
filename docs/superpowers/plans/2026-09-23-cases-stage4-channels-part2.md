# Cases Stage 4: Channels, presence and the contact ladder — Implementation Plan (Part 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the contact router real channels: the relay client and SMS/voice, email (relay or IMAP/SMTP), ntfy, and contact on the Telegram and Discord bridges with owner proof.
**Architecture:** New adapters in `src/channels/` implement Part 1's contact extension and speak only through `onContactReply` handlers and their own owner target; the router stays the only place that answers questions. The Telegram and Discord bridges get additive hunks and a shared helper, `src/channels/bridge-contact.js`. Starts after Part 1 (`…-part1.md`) has merged; Part 3 wires everything into the hosts.
**Tech Stack:** `fetch`, `crypto`; new pure-JS dependencies `nodemailer` (SMTP send), `imapflow` (IMAP polling) and `mailparser` (MIME parsing of replies and DSNs), all with their loggers off.
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

### Task 7: The relay client, SMS and voice

**Files:**
- Create: `src/channels/relay-client.js`, `src/channels/telephony-channel.js`, `tests/helpers/fake-contact-relay.js`
- Test: `tests/contact-relay.test.js`, `tests/contact-sms.test.js`, and a new `describe` appended to `tests/contact-adapter-contract.test.js`

**Interfaces:**
- Consumes: Part 1 `ChannelPlugin`, `ContactDeliveryError`, `GATE_PASSED`, `assertRelayBaseUrl`, `normalizeAddress`, `ContactState` (`readCursor`, `writeCursor`), `ContactRouter.ingestRelayEvents`.
- Produces: `ContactRelayClient({ name, baseUrl, getToken, fetchImpl, log })` with `send(body, { idempotencyKey }) → { id, status }`, `status(id)`, `lookup(idempotencyKey)`, `events(cursor) → { events, cursor }`; `RelayPoller({ client, state, onEvents, pollSec, log, setTimer, clearTimer })` with `start()`, `stop()`, `pollOnce()`, `nextDelay()`; `errorForStatus(status, detail)`; `verifyRelayPush({ secret, timestamp, signature, rawBody, now }) → { ok, reason? }`; `createRelayPushHandler({ getSecret, hasRelay, onEvents, clock }) → (name, rawBody, headers) → { status, body }`; `BACKOFF_MIN_MS`, `BACKOFF_MAX_MS`; re-exports `assertRelayBaseUrl`. `TelephonyChannel({ kind: 'sms' | 'voice', relay, getConfig, log })` (ids `sms`, `voice`) with `ingestRelayEvent(ev)`; test helper `startFakeRelay({ token })`.

- [ ] **Step 1: Write the failing tests**

Create `tests/helpers/fake-contact-relay.js`:

```js
// tests/helpers/fake-contact-relay.js
// A local HTTP server speaking the contact relay contract (cases stage 4 §4.5)
// on port 0. Tests queue events, force an error status and read requests.
const http = require('http');

async function startFakeRelay({ token = 'relay-token' } = {}) {
  const requests = [];
  const messages = new Map();
  const byKey = new Map();
  const events = [];
  let forceStatus = null;
  let counter = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://relay.local');
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: parsed });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      if (forceStatus) {
        const s = forceStatus;
        forceStatus = null;
        return send(s, { error: `forced ${s}` });
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const key = req.headers['idempotency-key'];
        if (key && byKey.has(key)) return send(202, { id: byKey.get(key), status: 'queued' });
        counter += 1;
        const id = `msg-${counter}`;
        messages.set(id, { id, status: 'queued', body: parsed });
        if (key) byKey.set(key, id);
        return send(202, { id, status: 'queued' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/messages') {
        const id = byKey.get(url.searchParams.get('idempotencyKey'));
        return id ? send(200, { id, status: messages.get(id).status, at: new Date().toISOString() }) : send(404, { error: 'not found' });
      }
      const m = /^\/v1\/messages\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const msg = messages.get(decodeURIComponent(m[1]));
        return msg ? send(200, { id: msg.id, status: msg.status, at: new Date().toISOString() }) : send(404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        const after = Number(url.searchParams.get('after') || 0);
        const page = events.slice(after, after + 100);
        return send(200, { events: page, cursor: String(after + page.length) });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    token,
    requests,
    messages,
    sent: () => requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages'),
    pushEvent: (ev) => events.push(ev),
    failNext: (status) => { forceStatus = status; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startFakeRelay };
```

Create `tests/contact-relay.test.js`:

```js
// tests/contact-relay.test.js — cases stage 4 §4.5 (relay client, poller, signed push).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ContactRelayClient, RelayPoller, assertRelayBaseUrl, errorForStatus, verifyRelayPush, createRelayPushHandler
} = require('../src/channels/relay-client');
const { ContactState } = require('../src/cases/contact-state');
const { startFakeRelay } = require('./helpers/fake-contact-relay');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-')); dirs.push(d); return path.join(d, 'contact'); };
const sign = (secret, ts, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

describe('relay baseUrl', () => {
  it('allows https and loopback http only', () => {
    assert.strictEqual(assertRelayBaseUrl('https://relay.example.com/'), 'https://relay.example.com');
    assert.strictEqual(assertRelayBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.throws(() => assertRelayBaseUrl('http://relay.example.com'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('http://10.0.0.5'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('file:///etc/passwd'), /https:, or http: to loopback/);
  });
});

describe('ContactRelayClient', () => {
  it('sends with the Idempotency-Key and gets the original message back for the same key', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const a = await client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-1' });
      const b = await client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-1' });
      assert.strictEqual(a.id, b.id);
      assert.strictEqual(relay.sent()[0].headers['idempotency-key'], 'd-1');
      assert.strictEqual(relay.sent()[0].headers.authorization, `Bearer ${relay.token}`);
      assert.strictEqual((await client.lookup('d-1')).id, a.id);
      assert.strictEqual((await client.status(a.id)).status, 'queued');
    } finally {
      await relay.close();
    }
  });

  it('maps HTTP status to ContactDeliveryError codes', async () => {
    const expect = { 400: 'rejected', 422: 'rejected', 401: 'not-configured', 403: 'not-configured', 413: 'too-large', 429: 'rate-limited', 500: 'unreachable', 503: 'unreachable' };
    for (const [status, code] of Object.entries(expect)) assert.strictEqual(errorForStatus(Number(status)).code, code);
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      relay.failNext(429);
      await assert.rejects(client.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'rate-limited');
      const noToken = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => null });
      await assert.rejects(noToken.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'not-configured');
      const down = new ContactRelayClient({ name: 'main', baseUrl: 'http://127.0.0.1:9', getToken: () => 't' });
      await assert.rejects(down.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'unreachable');
    } finally {
      await relay.close();
    }
  });
});

describe('RelayPoller', () => {
  it('persists the cursor and backs off 30 s → 10 min on failure', async () => {
    const relay = await startFakeRelay();
    try {
      const state = new ContactState({ dir: tmp() });
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const seen = [];
      const poller = new RelayPoller({ client, state, onEvents: async (evs) => { seen.push(...evs.map((e) => e.id)); } });
      relay.pushEvent({ id: 'ev-1', type: 'status', messageId: 'msg-1', status: 'delivered' });
      relay.pushEvent({ id: 'ev-2', type: 'status', messageId: 'msg-1', status: 'delivered' });
      assert.deepStrictEqual(await poller.pollOnce(), { ok: true, count: 2 });
      assert.strictEqual(state.readCursor('main'), '2');
      relay.pushEvent({ id: 'ev-3', type: 'status', messageId: 'msg-2', status: 'failed' });
      const again = new RelayPoller({ client, state: new ContactState({ dir: state.dir }), onEvents: async (evs) => { seen.push(...evs.map((e) => e.id)); } });
      await again.pollOnce();
      assert.deepStrictEqual(seen, ['ev-1', 'ev-2', 'ev-3'], 'a new poller resumes after the saved cursor');
      assert.strictEqual(relay.requests.filter((r) => r.path === '/v1/events').pop().query.after, '2');

      assert.strictEqual(again.nextDelay(), 30000);
      relay.failNext(503);
      assert.strictEqual((await again.pollOnce()).ok, false);
      assert.strictEqual(again.nextDelay(), 30000);
      again.failures = 5;
      assert.strictEqual(again.nextDelay(), 480000);
      again.failures = 9;
      assert.strictEqual(again.nextDelay(), 600000);
    } finally {
      await relay.close();
    }
  });
});

describe('signed relay push', () => {
  const secret = 'push-secret';
  const now = Date.parse('2026-09-25T14:00:00Z');
  const ts = '2026-09-25T14:00:00Z';
  const body = JSON.stringify({ id: 'ev-9', type: 'status', messageId: 'msg-1', status: 'delivered' });

  it('accepts a good HMAC and refuses a bad one or a stale timestamp', () => {
    assert.deepStrictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now }), { ok: true });
    assert.strictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign('other', ts, body), rawBody: body, now }).reason, 'bad signature');
    assert.strictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: `${body} `, now }).reason, 'bad signature');
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now: now + 301000 }).reason, /stale/);
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: 'md5=abc', rawBody: body, now }).reason, /malformed/);
    assert.match(verifyRelayPush({ secret: null, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now }).reason, /no webhook secret/);
  });

  it('the push handler hands verified events to the router and drops duplicate ids there', async () => {
    const got = [];
    const handler = createRelayPushHandler({
      getSecret: () => secret,
      hasRelay: (name) => name === 'main',
      onEvents: async (name, events) => { got.push([name, events.map((e) => e.id)]); return { applied: events.length, skipped: 0 }; },
      clock: () => new Date(now)
    });
    const headers = { 'x-kl-timestamp': ts, 'x-kl-signature': sign(secret, ts, body) };
    assert.deepStrictEqual(await handler('main', body, headers), { status: 200, body: { ok: true, applied: 1, skipped: 0 } });
    assert.strictEqual((await handler('main', body, { ...headers, 'x-kl-signature': sign('x', ts, body) })).status, 401);
    assert.strictEqual((await handler('other', body, headers)).status, 404);
    assert.deepStrictEqual(got, [['main', ['ev-9']]]);

    const { ContactRouter } = require('../src/cases/contact');
    const state = new ContactState({ dir: tmp() });
    const router = new ContactRouter({ state, runtime: null, adapters: new Map() });
    state.recordDelivery('d-1', { channel: 'sms', at: new Date(now).toISOString(), relayId: 'msg-1', batchToken: 'K7QD4M', status: 'sent', items: [] });
    const ev = { id: 'ev-9', type: 'status', messageId: 'msg-1', status: 'delivered' };
    assert.deepStrictEqual(await router.ingestRelayEvents('main', [ev, ev]), { applied: 1, skipped: 1 });
    assert.strictEqual(state.deliveries()['d-1'].status, 'delivered');
  });
});
```

Create `tests/contact-sms.test.js`:

```js
// tests/contact-sms.test.js — cases stage 4 §3.3 (SMS and voice through the relay).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { TelephonyChannel } = require('../src/channels/telephony-channel');
const { ContactRelayClient } = require('../src/channels/relay-client');
const { GATE_PASSED } = require('../src/channels/channel-plugin');
const { startFakeRelay } = require('./helpers/fake-contact-relay');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function world() {
  const relay = await startFakeRelay();
  const clock = () => new Date('2026-09-25T14:00:00Z');
  const runtime = new CaseRuntime({ root: tmp('kl-sms-cases-'), now: clock });
  const state = new ContactState({ dir: path.join(tmp('kl-sms-data-'), 'contact'), clock });
  const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
  const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+1 555 010 0', from: '+15550199', maxChars: 1200 }) });
  const voice = new TelephonyChannel({ kind: 'voice', relay: client, getConfig: () => ({ owner: '+15550100', from: '+15550199', language: 'en-US' }) });
  const adapters = new Map([['sms', sms], ['voice', voice]]);
  const router = new ContactRouter({ state, runtime, adapters, clock });
  sms.onContactReply((cid, answer, meta) => router.handleReply('sms', cid, answer, meta));
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const q = runtime.questions(lot.id).create({ kind: 'question', urgency: 'high', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
  const entry = { caseId: lot.id, caseTitle: lot.title, token: state.newToken(), record: q };
  return { relay, runtime, state, router, sms, voice, lot, q, entry };
}

const inbound = (from, text, id) => ({ id, type: 'inbound', channel: 'sms', from, to: '+15550199', text, at: '2026-09-25T14:05:00Z' });

describe('SMS', () => {
  it('sends the batch text to the owner number with the delivery id as Idempotency-Key', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      const req = w.relay.sent()[0];
      assert.strictEqual(req.headers['idempotency-key'], out.deliveryId);
      assert.strictEqual(req.body.channel, 'sms');
      assert.strictEqual(req.body.to, '+15550100');
      assert.strictEqual(req.body.from, '+15550199');
      assert.match(req.body.text, new RegExp(`Reply "#${out.batchToken} a"`));
      assert.deepStrictEqual(req.body.correlation, { deliveryId: out.deliveryId, tokens: [w.entry.token], batchToken: out.batchToken });
      assert.strictEqual(w.state.deliveries()[out.deliveryId].relayId, 'msg-1');
    } finally {
      await w.relay.close();
    }
  });

  it('SMS token required: a tokenless reply is not applied and the hint goes to the owner number only', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      await w.router.ingestRelayEvents('main', [inbound('(555) 010-0', 'a', 'ev-1')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null, 'a bare number without country code is not the owner');
      await w.router.ingestRelayEvents('main', [inbound('+1 (555) 010-0', 'a', 'ev-2')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null);
      const acks = w.relay.sent().slice(1);
      assert.strictEqual(acks.length, 1);
      assert.strictEqual(acks[0].body.to, '+15550100');
      assert.strictEqual(acks[0].body.text, `Add the code from the message, e.g. "#${out.batchToken} 1 a".`);

      await w.router.ingestRelayEvents('main', [inbound('+15550100', `#${out.batchToken} a`, 'ev-3')]);
      const rec = w.runtime.questions(w.lot.id).get(w.q.id);
      assert.strictEqual(rec.answer.optionId, 'a');
      assert.strictEqual(rec.answer.channel, 'sms');
      assert.strictEqual(w.relay.sent().pop().body.text, 'Recorded for Lakeside lot.');
    } finally {
      await w.relay.close();
    }
  });

  it('a spoofed number with a token is refused and nobody gets an ack', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      const before = w.relay.sent().length;
      await w.router.ingestRelayEvents('main', [inbound('+15550177', `#${out.batchToken} a`, 'ev-1')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null);
      assert.strictEqual(w.relay.sent().length, before);
    } finally {
      await w.relay.close();
    }
  });

  it('refuses a plain send to anyone but the owner without the gate symbol', async () => {
    const w = await world();
    try {
      await assert.rejects(w.sms.send('+15550177', 'hello'), /not the owner and not through the outbound gate/);
      await w.sms.send('+15550177', 'hello', { [GATE_PASSED]: true });
      assert.strictEqual(w.relay.sent().pop().body.to, '+15550177');
    } finally {
      await w.relay.close();
    }
  });
});

describe('voice', () => {
  it('reads each item with its options and applies a gathered digit', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('voice', [w.entry]);
      const body = w.relay.sent()[0].body;
      assert.strictEqual(body.channel, 'voice');
      assert.strictEqual(body.voice.language, 'en-US');
      assert.deepStrictEqual(body.voice.prompts, [{ n: 1, say: 'Question 1 from Lakeside lot. Accept the 41k offer? Press 1 for Yes, Press 2 for No.', gather: { digits: { 1: 'a', 2: 'b' } } }]);
      await w.router.ingestRelayEvents('main', [{ id: 'ev-g', type: 'gathered', messageId: w.state.deliveries()[out.deliveryId].relayId, results: [{ n: 1, digits: '2' }], at: '2026-09-25T14:06:00Z' }]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer.optionId, 'b');
    } finally {
      await w.relay.close();
    }
  });

  it('an item without options asks for an answer in King Louie or by text', async () => {
    const w = await world();
    try {
      const q = w.runtime.questions(w.lot.id).create({ kind: 'question', urgency: 'high', text: 'What is the lowest price?' });
      await w.router.deliver('voice', [{ caseId: w.lot.id, caseTitle: 'Lakeside lot', token: w.state.newToken(), record: q }]);
      assert.deepStrictEqual(w.relay.sent()[0].body.voice.prompts, [{ n: 1, say: 'Question 1 from Lakeside lot. What is the lowest price? Answer this one in King Louie or by text.' }]);
    } finally {
      await w.relay.close();
    }
  });
});
```

Append to the end of `tests/contact-adapter-contract.test.js`:

```js
describe('contact adapter: sms and voice (fake relay)', () => {
  const { TelephonyChannel } = require('../src/channels/telephony-channel');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');

  it('meets the contract', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+15550100' }) });
      const voice = new TelephonyChannel({ kind: 'voice', relay: client, getConfig: () => ({ owner: '+15550100' }) });
      assert.strictEqual(sms.contactCapabilities().authenticatedReplies, false);
      assert.strictEqual(sms.contactCapabilities().requiresToken, true);
      assert.strictEqual(voice.contactCapabilities().voice, true);
      assert.strictEqual((await sms.sendContact(MESSAGE, META)).deliveryId, 'd-test-1');
      assert.strictEqual((await voice.sendContact(MESSAGE, { ...META, deliveryId: 'd-test-2' })).deliveryId, 'd-test-2');

      const calls = [];
      sms.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: null }; });
      await sms.ingestRelayEvent({ id: 'e1', type: 'inbound', channel: 'sms', from: '+15550100', text: '#K7QD4M a' });
      assert.strictEqual(calls[0].correlationId, 'K7QD4M');
      assert.strictEqual(calls[0].meta.ownerProven, true);
      await sms.ingestRelayEvent({ id: 'e2', type: 'inbound', channel: 'sms', from: '+15550177', text: '#K7QD4M a' });
      assert.strictEqual(calls[1].meta.ownerProven, false);

      relay.failNext(413);
      await assert.rejects(sms.sendContact(MESSAGE, { ...META, deliveryId: 'd-test-3' }), (err) => err instanceof ContactDeliveryError && err.code === 'too-large');
      const unset = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({}) });
      assert.strictEqual(unset.contactConfigured(), false);
      await assert.rejects(unset.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
    } finally {
      await relay.close();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/contact-relay.test.js tests/contact-sms.test.js tests/contact-adapter-contract.test.js`
Expected: FAIL with `Cannot find module '../src/channels/relay-client'` (and `../src/channels/telephony-channel`)

- [ ] **Step 3: Implement**

Create `src/channels/relay-client.js`:

```js
// src/channels/relay-client.js
// The contact relay contract (cases stage 4 spec §4.5): email via relay, SMS
// and voice. Send with an Idempotency-Key, poll /v1/events with a persisted
// cursor, and accept a co-located relay's signed push. fetch and crypto only.
const crypto = require('crypto');
const { ContactDeliveryError } = require('./channel-plugin');
const { assertRelayBaseUrl } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const PUSH_SKEW_MS = 300 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

function errorForStatus(status, detail = '') {
  const suffix = detail ? `: ${String(detail).slice(0, 200)}` : '';
  if (status === 400 || status === 422) return new ContactDeliveryError('rejected', `relay rejected the message (${status})${suffix}`);
  if (status === 401 || status === 403) return new ContactDeliveryError('not-configured', `relay refused the credentials (${status})${suffix}`);
  if (status === 413) return new ContactDeliveryError('too-large', `relay says the message is too large (${status})${suffix}`);
  if (status === 429) return new ContactDeliveryError('rate-limited', `relay rate limit (${status})${suffix}`);
  return new ContactDeliveryError('unreachable', `relay error (${status})${suffix}`);
}

class ContactRelayClient {
  constructor({ name, baseUrl, getToken, fetchImpl = globalThis.fetch, log = createLogger('contact/relay') } = {}) {
    this.name = name;
    this.baseUrl = assertRelayBaseUrl(baseUrl);
    this.getToken = typeof getToken === 'function' ? getToken : () => null;
    this.fetch = fetchImpl;
    this.log = log;
  }

  async _request(method, pathname, { body = null, headers = {} } = {}) {
    const token = this.getToken();
    if (!token) throw new ContactDeliveryError('not-configured', `vault contact.relay.${this.name}.token is not set`);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new ContactDeliveryError('unreachable', `relay ${this.name} is unreachable: ${err.message}`);
    }
    const text = await res.text();
    if (res.status < 200 || res.status > 299) throw errorForStatus(res.status, text);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ContactDeliveryError('unreachable', `relay ${this.name} answered with something that is not JSON`);
    }
  }

  // POST /v1/messages; the same key returns the original message.
  async send(body, { idempotencyKey }) {
    const out = await this._request('POST', '/v1/messages', { body, headers: { 'idempotency-key': String(idempotencyKey) } });
    if (!out || !out.id) throw new ContactDeliveryError('unreachable', `relay ${this.name} returned no message id`);
    return { id: String(out.id), status: out.status || 'queued' };
  }

  async status(id) {
    return this._request('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  async lookup(idempotencyKey) {
    return this._request('GET', `/v1/messages?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
  }

  async events(cursor) {
    const q = cursor ? `after=${encodeURIComponent(cursor)}&limit=100` : 'limit=100';
    const out = await this._request('GET', `/v1/events?${q}`);
    return { events: Array.isArray(out.events) ? out.events : [], cursor: out.cursor ?? cursor ?? null };
  }
}

// Polls /v1/events every pollSec, cursor persisted per relay, backing off
// 30 s → 10 min on failure. onEvents(events) is router.ingestRelayEvents.
class RelayPoller {
  constructor({ client, state, onEvents, pollSec = 30, log = createLogger('contact/relay-poll'), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.client = client;
    this.state = state;
    this.onEvents = onEvents;
    this.pollMs = Math.max(1, pollSec) * 1000;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.failures = 0;
    this.timer = null;
    this.running = false;
  }

  nextDelay() {
    if (!this.failures) return this.pollMs;
    return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.failures - 1));
  }

  async pollOnce() {
    try {
      const cursor = this.state.readCursor(this.client.name);
      const { events, cursor: next } = await this.client.events(cursor);
      if (events.length) await this.onEvents(events);
      this.state.writeCursor(this.client.name, next);
      this.failures = 0;
      return { ok: true, count: events.length };
    } catch (err) {
      this.failures += 1;
      this.log.warn(`polling relay ${this.client.name} failed (${err.message}); next try in ${Math.round(this.nextDelay() / 1000)} s`);
      return { ok: false, error: err.message };
    }
  }

  start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce();
      if (!this.running) return;
      this.timer = this.setTimer(loop, this.nextDelay());
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    };
    this.timer = this.setTimer(loop, 0);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

// X-KL-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>, ± 300 s.
function verifyRelayPush({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no webhook secret is configured' };
  const t = Date.parse(timestamp);
  const ts = Number.isFinite(t) ? t : Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > PUSH_SKEW_MS) return { ok: false, reason: 'stale or missing X-KL-Timestamp' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(signature || ''));
  if (!m) return { ok: false, reason: 'missing or malformed X-KL-Signature' };
  const want = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const got = Buffer.from(m[1], 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

// The handler behind POST /contact/relay/<name> on the loopback webhook server.
function createRelayPushHandler({ getSecret, hasRelay = () => true, onEvents, clock = () => new Date() }) {
  return async (name, rawBody, headers = {}) => {
    if (!hasRelay(name)) return { status: 404, body: { error: 'unknown relay' } };
    const v = verifyRelayPush({ secret: getSecret(name), timestamp: headers['x-kl-timestamp'], signature: headers['x-kl-signature'], rawBody, now: clock().getTime() });
    if (!v.ok) return { status: 401, body: { error: v.reason } };
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } };
    }
    const events = Array.isArray(payload?.events) ? payload.events : [payload];
    const r = await onEvents(name, events);
    return { status: 200, body: { ok: true, ...r } };
  };
}

module.exports = {
  ContactRelayClient, RelayPoller, assertRelayBaseUrl, errorForStatus, verifyRelayPush, createRelayPushHandler,
  BACKOFF_MIN_MS, BACKOFF_MAX_MS
};
```

Create `src/channels/telephony-channel.js`:

```js
// src/channels/telephony-channel.js
// SMS and voice through a telephony relay (cases stage 4 spec §3.3). Two
// instances, ids `sms` and `voice`. Neither answers an approval. Every SMS
// reply must carry a token; the router enforces that (requiresToken).
const crypto = require('crypto');
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');
const { normalizeAddress } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const TOKEN_IN_TEXT = /#([0-9A-Za-z]{6})\b/;

class TelephonyChannel extends ChannelPlugin {
  // getConfig() → { owner, from, maxChars, language }
  constructor({ kind, relay, getConfig = () => ({}), log = null } = {}) {
    if (kind !== 'sms' && kind !== 'voice') throw new Error('TelephonyChannel kind must be sms or voice');
    super({ id: kind, label: kind === 'sms' ? 'SMS' : 'Voice call', capabilities: ['send'] });
    this.kind = kind;
    this.relay = relay;
    this.getConfig = getConfig;
    this.log = log || createLogger(`contact/${kind}`);
    this.replyHandler = null;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return normalizeAddress(this.kind, raw) || '';
  }

  config() {
    const c = this.getConfig() || {};
    return {
      owner: normalizeAddress(this.kind, c.owner),
      from: c.from ? normalizeAddress(this.kind, c.from) : null,
      maxChars: Number.isInteger(c.maxChars) && c.maxChars > 0 ? c.maxChars : 1200,
      language: typeof c.language === 'string' && c.language ? c.language : 'en-US'
    };
  }

  contactCapabilities() {
    if (!this.relay) return null;
    const c = this.config();
    if (this.kind === 'sms') {
      return {
        buttons: false, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: false,
        interrupts: true, maxOptions: 6, maxChars: c.maxChars, idempotentSend: true, requiresToken: true
      };
    }
    return {
      buttons: true, richText: false, attachments: false, voice: true, expectsReplies: true, authenticatedReplies: false,
      interrupts: true, maxOptions: 9, maxChars: 8000, idempotentSend: true
    };
  }

  ownerTarget() {
    return this.relay ? this.config().owner : null;
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  _prompts(items) {
    return items.map((it) => {
      if (!it.answerable) return { n: it.n, say: it.text };
      let say = `Question ${it.n} from ${it.caseTitle}. ${it.text}`;
      const options = (it.options || []).slice(0, 9);
      if (options.length) {
        say += ` ${options.map((o, i) => `Press ${i + 1} for ${o.label}`).join(', ')}.`;
        const digits = {};
        options.forEach((o, i) => { digits[String(i + 1)] = o.id; });
        return { n: it.n, say, gather: { digits } };
      }
      return { n: it.n, say: `${say} Answer this one in King Louie or by text.` };
    });
  }

  async sendContact(message, meta = {}) {
    const c = this.config();
    if (!this.relay || !c.owner) throw new ContactDeliveryError('not-configured', `${this.kind} has no owner number`);
    const correlation = { deliveryId: meta.deliveryId, tokens: (message.items || []).map((i) => i.token), batchToken: meta.batchToken };
    const body = this.kind === 'sms'
      ? { channel: 'sms', to: c.owner, from: c.from, subject: null, text: String(message.text).slice(0, c.maxChars), correlation, expiresAt: meta.expiresAt || null }
      : {
        channel: 'voice', to: c.owner, from: c.from, subject: null, text: message.subject,
        voice: { language: c.language, prompts: this._prompts(message.items || []) }, correlation, expiresAt: meta.expiresAt || null
      };
    const sent = await this.relay.send(body, { idempotencyKey: meta.deliveryId });
    return { deliveryId: meta.deliveryId, externalRef: sent.id, relayId: sent.id };
  }

  // A plain send: the owner number, or a target the outbound gate passed.
  async send(target, text, options = {}) {
    const c = this.config();
    const to = normalizeAddress(this.kind, target);
    if (!to) throw new Error(`${this.kind}: "${target}" is not an E.164 number`);
    if (to !== c.owner && options[GATE_PASSED] !== true) throw new Error(`${this.kind}: refusing to send to ${to}: not the owner and not through the outbound gate`);
    const idempotencyKey = options.deliveryId || `ack-${crypto.randomBytes(8).toString('hex')}`;
    const body = this.kind === 'sms'
      ? { channel: 'sms', to, from: c.from, subject: null, text: String(text).slice(0, c.maxChars), correlation: null }
      : { channel: 'voice', to, from: c.from, subject: null, text: String(text), voice: { language: c.language, prompts: [{ n: 1, say: String(text) }] }, correlation: null };
    const sent = await this.relay.send(body, { idempotencyKey });
    return { ok: true, id: sent.id };
  }

  // A relay `inbound` event (poll or push). Owner proof is the owner number;
  // the router also requires the token for SMS.
  async ingestRelayEvent(ev) {
    if (this.kind !== 'sms' || !this.replyHandler) return null;
    const c = this.config();
    const from = normalizeAddress('sms', ev.from);
    const ownerProven = Boolean(from && c.owner && from === c.owner);
    const text = String(ev.text || '');
    const token = TOKEN_IN_TEXT.exec(text);
    const result = await this.replyHandler(token ? token[1].toUpperCase() : null, { text }, {
      channel: 'sms', senderId: from || String(ev.from || ''), chatId: null, at: ev.at || null, ownerProven
    });
    if (result && result.ackText && ownerProven) {
      try {
        await this.send(c.owner, result.ackText);
      } catch (err) {
        this.log.warn(`sms ack failed: ${err.message}`);
      }
    }
    return result;
  }
}

module.exports = { TelephonyChannel };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-relay.test.js tests/contact-sms.test.js tests/contact-adapter-contract.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/relay-client.js src/channels/telephony-channel.js tests/helpers/fake-contact-relay.js tests/contact-relay.test.js tests/contact-sms.test.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): relay client with polling and signed push, SMS and voice adapters

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Email over the relay or IMAP/SMTP, and the three dependencies

**Files:**
- Modify: `package.json`, `package-lock.json` (through `npm install`)
- Create: `src/channels/email-channel.js`, `src/channels/email-transports.js`, `tests/helpers/fake-smtp.js`
- Test: `tests/contact-email.test.js`, `tests/contact-deps.test.js`, and a new `describe` appended to `tests/contact-adapter-contract.test.js`

**Interfaces:**
- Consumes: Part 1 `ChannelPlugin`, `ContactDeliveryError`, `GATE_PASSED`, `normalizeAddress`, `stripQuoted`; Task 7 `ContactRelayClient`, `startFakeRelay`.
- Produces: `EmailChannel({ transport, getConfig, pollSec, log, setTimer, clearTimer })` (id `email`) with `handleInbound(reply)`, `handleBounce(b)`, `ingestRelayEvent(ev)`, `pollOnce() → { replies, bounces }`; `authResultsPass(value, { trustedAuthServId, fromDomain })`, `topAuthResults(headerLines)`, `domainOf(address)`. `createRelayEmailTransport({ relay })`, `createImapSmtpTransport({ smtp, imap, getPassword, nodemailer, ImapFlow, simpleParser, log })` (both `{ idempotent, send, poll, close }`), `classifyParsed(parsed)`, `smtpError(err)`; test helper `startFakeSmtp()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/contact-deps.test.js`:

```js
// tests/contact-deps.test.js — cases stage 4 §14 and program §3: the three
// new dependencies and everything they pull in are pure JS: no install
// scripts, no node-gyp, no platform-specific binary packages.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NEW_DEPS = ['nodemailer', 'imapflow', 'mailparser'];

// npm lockfile v2/v3: a dependency of the package at `from` resolves to the
// nearest <ancestor>/node_modules/<name> entry.
function resolve(name, from) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
}

function closure(roots) {
  const seen = new Set();
  const queue = roots.map((n) => resolve(n, ''));
  while (queue.length) {
    const key = queue.shift();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = lock.packages[key];
    for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
      const found = resolve(dep, key);
      assert.ok(found, `${dep} (needed by ${key}) is missing from package-lock.json`);
      queue.push(found);
    }
  }
  return [...seen];
}

describe('contact dependencies', () => {
  it('package.json names nodemailer, imapflow and mailparser', () => {
    for (const name of NEW_DEPS) assert.ok(pkg.dependencies[name], `${name} is a dependency`);
  });

  it('lockfile: no install scripts, node-gyp or platform binaries anywhere in their closure', () => {
    const keys = closure(NEW_DEPS);
    assert.ok(keys.length >= NEW_DEPS.length);
    for (const key of keys) {
      const entry = lock.packages[key];
      assert.notStrictEqual(entry.hasInstallScript, true, `${key} has an install script`);
      assert.notStrictEqual(entry.gypfile, true, `${key} builds with node-gyp`);
      assert.strictEqual(entry.os, undefined, `${key} is platform-specific (os)`);
      assert.strictEqual(entry.cpu, undefined, `${key} is platform-specific (cpu)`);
      assert.doesNotMatch(key, /(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm)/, `${key} looks like a prebuilt binary package`);
    }
  });

  it('installed packages ship no .node binaries', () => {
    for (const key of closure(NEW_DEPS)) {
      const dir = path.join(ROOT, key);
      if (!fs.existsSync(dir)) continue;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (e.name !== 'node_modules') stack.push(path.join(d, e.name));
          } else {
            assert.ok(!e.name.endsWith('.node'), `${path.join(d, e.name)} is a native binary`);
          }
        }
      }
    }
  });
});
```

Create `tests/helpers/fake-smtp.js`:

```js
// tests/helpers/fake-smtp.js
// A plain-text SMTP server over net on port 0 (no TLS, no auth) that keeps
// every message it accepts. Enough for nodemailer's send path.
const net = require('net');

async function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = [];
    let envelope = { from: null, to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 smtp.example.com ESMTP fake');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...envelope, raw: data.join('\r\n') });
            data = [];
            envelope = { from: null, to: [] };
            reply('250 2.0.0 queued');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') reply('250 smtp.example.com');
        else if (cmd === 'MAIL') { envelope.from = line.replace(/^MAIL FROM:\s*/i, ''); reply('250 2.1.0 ok'); }
        else if (cmd === 'RCPT') { envelope.to.push(line.replace(/^RCPT TO:\s*/i, '')); reply('250 2.1.5 ok'); }
        else if (cmd === 'DATA') { inData = true; reply('354 end with .'); }
        else if (cmd === 'RSET' || cmd === 'NOOP') reply('250 ok');
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('502 not implemented');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, messages, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { startFakeSmtp };
```

Create `tests/contact-email.test.js`:

```js
// tests/contact-email.test.js — cases stage 4 §3.2 (email channel and transports).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EmailChannel, authResultsPass, topAuthResults } = require('../src/channels/email-channel');
const { createImapSmtpTransport, createRelayEmailTransport } = require('../src/channels/email-transports');
const { ContactRelayClient } = require('../src/channels/relay-client');
const { startFakeSmtp } = require('./helpers/fake-smtp');
const { startFakeRelay } = require('./helpers/fake-contact-relay');

const CONFIG = { owner: 'Owner@Example.com', from: 'kl@example.com', trustedAuthServId: 'mx.example.com' };
const MESSAGE = { subject: 'King Louie: 1 question', text: '1. Lakeside lot — Seller financing?\n   a) No   b) Yes', items: [] };
const META = { deliveryId: 'd-ABC123', batchToken: 'K7QD4M' };

// An IMAP double with imapflow's surface: connect, getMailboxLock, search,
// fetchOne, messageFlagsAdd, logout. `mailbox` holds { uid, source, seen }.
function imapDouble(mailbox) {
  return class FakeImapFlow {
    constructor(options) {
      FakeImapFlow.options = options;
    }

    async connect() {}

    async getMailboxLock(name) {
      FakeImapFlow.locked = name;
      return { release() {} };
    }

    async search(query) {
      return mailbox.filter((m) => (query.seen === false ? !m.seen : true)).map((m) => m.uid);
    }

    async fetchOne(uid) {
      return { source: Buffer.from(mailbox.find((m) => String(m.uid) === String(uid)).source) };
    }

    async messageFlagsAdd(uid, flags) {
      if (flags.includes('\\Seen')) mailbox.find((m) => String(m.uid) === String(uid)).seen = true;
    }

    async logout() {}
  };
}

function rawReply({ subject = 'Re: King Louie: 1 question', inReplyTo = '<kl-d-ABC123@example.com>', body = 'a', auth = [], from = 'owner@example.com' } = {}) {
  return [
    ...auth.map((a) => `Authentication-Results: ${a}`),
    `From: Owner <${from}>`,
    'To: kl@example.com',
    `Subject: ${subject}`,
    'Message-ID: <reply-1@example.com>',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'Date: Fri, 25 Sep 2026 14:05:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    ''
  ].join('\r\n');
}

const DSN = [
  'From: Mail Delivery System <mailer-daemon@mx.example.com>',
  'To: kl@example.com',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <dsn-1@mx.example.com>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUNDARY"',
  '',
  '--BOUNDARY',
  'Content-Type: text/plain',
  '',
  'Your message could not be delivered.',
  '--BOUNDARY',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.com',
  '',
  'Final-Recipient: rfc822; owner@example.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 mailbox unavailable',
  '--BOUNDARY',
  'Content-Type: text/rfc822-headers',
  '',
  'Message-ID: <kl-d-ABC123@example.com>',
  'Subject: King Louie: 1 question [KL-K7QD4M]',
  '--BOUNDARY--',
  ''
].join('\r\n');

function channelWith(mailbox, { smtpPort = 1 } = {}) {
  const Imap = imapDouble(mailbox);
  const transport = createImapSmtpTransport({
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: '' },
    imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' },
    getPassword: (which) => `${which}-secret`,
    ImapFlow: Imap
  });
  const email = new EmailChannel({ transport, getConfig: () => CONFIG });
  const calls = [];
  email.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: meta.ownerProven, outcome: 'recorded', ackText: null }; });
  return { email, calls, transport, Imap };
}

describe('Authentication-Results', () => {
  it('only the topmost header counts, with the trusted authserv-id', () => {
    const lines = [
      { key: 'authentication-results', line: 'Authentication-Results: mx.example.com;\r\n spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com' },
      { key: 'authentication-results', line: 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com' }
    ];
    const top = topAuthResults(lines);
    assert.strictEqual(top, 'mx.example.com; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com');
    assert.strictEqual(authResultsPass(top, { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false);
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=example.com', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), true);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=bounce@mail.example.com', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), true, 'aligned SPF');
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=other.example.org', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false, 'unaligned SPF');
    assert.strictEqual(authResultsPass('evil.example.org; dmarc=pass', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false, 'untrusted authserv-id');
  });

  it('a forged lower header is ignored: a reply without the token and a failing top header is not owner-proven', async () => {
    const mailbox = [{ uid: 1, seen: false, source: rawReply({ auth: ['mx.example.com; dmarc=fail header.from=example.com', 'mx.example.com; dmarc=pass header.from=example.com'] }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].correlationId, 'd-ABC123', 'the thread names the delivery');
    assert.strictEqual(calls[0].meta.ownerProven, false);
    assert.strictEqual(mailbox[0].seen, true, 'marked seen after handling');
  });

  it('a passing top header proves the owner without the token', async () => {
    const mailbox = [{ uid: 2, seen: false, source: rawReply({ auth: ['mx.example.com; dmarc=pass header.from=example.com'] }) }];
    const { email, calls, Imap } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, true);
    assert.deepStrictEqual(calls[0].answer, { text: 'a' });
    assert.strictEqual(Imap.options.logger, false, 'imapflow is constructed with logger: false');
    assert.deepStrictEqual(Imap.options.auth, { user: 'kl@example.com', pass: 'imap-secret' });
    assert.strictEqual(Imap.locked, 'INBOX');
  });
});

describe('token fallback and quoted history', () => {
  it('an unauthenticated reply from the owner counts when the [KL-…] token is in the subject', async () => {
    const mailbox = [{ uid: 3, seen: false, source: rawReply({ subject: 'Re: King Louie: 1 question [KL-K7QD4M]' }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, true);
  });

  it('a stranger with the token is not the owner', async () => {
    const mailbox = [{ uid: 4, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', from: 'someone@example.org' }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, false);
  });

  it('strips quoted history before the answer is read', async () => {
    const body = '#K7QD4M 1 a\r\n\r\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\r\n> #K7QD4M 2 b\r\n> 1. Lakeside lot';
    const mailbox = [{ uid: 5, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.deepStrictEqual(calls[0].answer, { text: '#K7QD4M 1 a' });
  });

  it('a reply naming no batch is dropped', async () => {
    const mailbox = [{ uid: 6, seen: false, source: rawReply({ subject: 'hello', inReplyTo: null }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.deepStrictEqual(calls, []);
  });
});

describe('DSN → bounce', () => {
  it('a delivery-status report fails the original delivery', async () => {
    const mailbox = [{ uid: 7, seen: false, source: DSN }];
    const { email } = channelWith(mailbox);
    const statuses = [];
    email.onContactStatus((s) => statuses.push(s));
    assert.deepStrictEqual(await email.pollOnce(), { replies: 0, bounces: 1 });
    assert.deepStrictEqual(statuses, [{ externalRef: '<kl-d-ABC123@example.com>', status: 'bounced', error: 'smtp; 550 5.1.1 mailbox unavailable' }]);
  });
});

describe('sending', () => {
  it('imap-smtp: nodemailer sends the batch with the token in the subject and a kl- Message-ID', async () => {
    const smtp = await startFakeSmtp();
    try {
      const { email } = channelWith([], { smtpPort: smtp.port });
      const sent = await email.sendContact(MESSAGE, META);
      assert.deepStrictEqual(sent, { deliveryId: 'd-ABC123', externalRef: '<kl-d-ABC123@example.com>', relayId: null });
      assert.strictEqual(smtp.messages.length, 1);
      const raw = smtp.messages[0].raw;
      assert.match(raw, /Subject: King Louie: 1 question \[KL-K7QD4M\]/);
      assert.match(raw, /Message-ID: <kl-d-ABC123@example\.com>/i);
      assert.match(smtp.messages[0].to[0], /owner@example\.com/);
      await assert.rejects(email.send('someone@example.org', 'hi'), /not the owner/);
      await email.shutdown();
    } finally {
      await smtp.close();
    }
  });

  it('relay: the email body carries the Message-ID header and the delivery id as Idempotency-Key', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: () => CONFIG });
      assert.strictEqual(email.contactCapabilities().idempotentSend, true);
      const sent = await email.sendContact(MESSAGE, META);
      assert.strictEqual(sent.relayId, 'msg-1');
      const req = relay.sent()[0];
      assert.strictEqual(req.headers['idempotency-key'], 'd-ABC123');
      assert.strictEqual(req.body.channel, 'email');
      assert.strictEqual(req.body.to, 'owner@example.com');
      assert.strictEqual(req.body.headers['Message-ID'], '<kl-d-ABC123@example.com>');
    } finally {
      await relay.close();
    }
  });
});
```

Append to the end of `tests/contact-adapter-contract.test.js`:

```js
describe('contact adapter: email over the relay and over IMAP/SMTP', () => {
  const { EmailChannel } = require('../src/channels/email-channel');
  const { createRelayEmailTransport, createImapSmtpTransport } = require('../src/channels/email-transports');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');
  const { startFakeSmtp } = require('./helpers/fake-smtp');
  const config = () => ({ owner: 'owner@example.com', from: 'kl@example.com', trustedAuthServId: 'mx.example.com' });

  async function contract(email, fail) {
    assert.strictEqual(email.contactCapabilities().authenticatedReplies, false);
    const sent = await email.sendContact(MESSAGE, META);
    assert.strictEqual(sent.deliveryId, 'd-test-1');
    assert.strictEqual(sent.externalRef, '<kl-d-test-1@example.com>');
    const calls = [];
    email.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: null }; });
    await email.ingestRelayEvent({ id: 'e1', type: 'inbound', channel: 'email', from: 'owner@example.com', subject: 'Re: [KL-K7QD4M]', text: 'a', inReplyTo: sent.externalRef });
    assert.strictEqual(calls[0].correlationId, 'd-test-1');
    assert.strictEqual(calls[0].meta.ownerProven, true);
    await email.ingestRelayEvent({ id: 'e2', type: 'inbound', channel: 'email', from: 'someone@example.org', subject: 'Re: [KL-K7QD4M]', text: 'a', inReplyTo: sent.externalRef });
    assert.strictEqual(calls[1].meta.ownerProven, false);
    await fail();
    await assert.rejects(email.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError);
  }

  it('relay transport meets the contract', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: config });
      await contract(email, async () => relay.failNext(429));
    } finally {
      await relay.close();
    }
  });

  it('imap-smtp transport meets the contract (fake SMTP over net)', async () => {
    const smtp = await startFakeSmtp();
    let port = smtp.port;
    const email = new EmailChannel({
      transport: createImapSmtpTransport({ smtp: { get host() { return '127.0.0.1'; }, get port() { return port; }, secure: false, user: '' }, imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' } }),
      getConfig: config
    });
    try {
      await contract(email, async () => {
        await smtp.close();
        await email.transport.close();
        port = 9;
      });
    } finally {
      await email.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/contact-deps.test.js tests/contact-email.test.js`
Expected: FAIL — `nodemailer is a dependency` in `contact-deps`, and `Cannot find module '../src/channels/email-channel'`

- [ ] **Step 3: Implement**

Run: `npm install nodemailer@^10.0.10 imapflow@^2.0.6 mailparser@^3.9.28`
Expected: `package.json` `dependencies` gains `imapflow`, `mailparser`, `nodemailer`; `npm` reports the packages added and no install scripts run.

Create `src/channels/email-channel.js`:

```js
// src/channels/email-channel.js
// The email contact channel (cases stage 4 spec §3.2) over a pluggable
// transport: the HTTP relay (default) or IMAP/SMTP. A reply counts only
// from the owner address, naming a live batch, and authenticated (relay
// auth.verified or the topmost Authentication-Results header) or carrying
// the [KL-<batchToken>] token. Email never answers an approval.
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');
const { normalizeAddress, stripQuoted } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const SUBJECT_TOKEN = /\[KL-([0-9A-Za-z]{6})\]/;
const THREAD_ID = /<kl-(d-[^@>\s]+)@/i;

const domainOf = (address) => {
  const at = String(address || '').lastIndexOf('@');
  return at > 0 ? String(address).slice(at + 1).toLowerCase() : '';
};

// Only the topmost Authentication-Results header counts (lower ones can be
// forged by the sender). Passes when its authserv-id is the trusted one and
// it shows dmarc=pass, or spf=pass aligned with the From domain.
function authResultsPass(value, { trustedAuthServId, fromDomain }) {
  if (!value || !trustedAuthServId || !fromDomain) return false;
  const parts = String(value).replace(/\s+/g, ' ').split(';').map((p) => p.trim()).filter(Boolean);
  const authserv = (parts[0] || '').split(' ')[0].toLowerCase();
  if (authserv !== String(trustedAuthServId).toLowerCase()) return false;
  const aligned = (d) => {
    const dom = domainOf(d.includes('@') ? d : `x@${d}`);
    return dom === fromDomain || dom.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${dom}`);
  };
  for (const part of parts.slice(1)) {
    const m = /^([a-z0-9-]+)=([a-z]+)\b(.*)$/i.exec(part);
    if (!m || m[2].toLowerCase() !== 'pass') continue;
    const method = m[1].toLowerCase();
    const props = m[3];
    if (method === 'dmarc') {
      const hf = /header\.from=([^\s;]+)/i.exec(props);
      if (!hf || aligned(hf[1])) return true;
    }
    if (method === 'spf') {
      const mf = /smtp\.mailfrom=([^\s;]+)/i.exec(props);
      if (mf && aligned(mf[1])) return true;
    }
  }
  return false;
}

// headerLines: mailparser's [{ key, line }] in the order they appear.
function topAuthResults(headerLines = []) {
  const first = (headerLines || []).find((h) => String(h.key).toLowerCase() === 'authentication-results');
  if (!first) return null;
  return String(first.line).replace(/^[^:]*:\s*/, '').replace(/\s+/g, ' ').trim();
}

class EmailChannel extends ChannelPlugin {
  // getConfig() → { owner, from, trustedAuthServId }
  constructor({ transport, getConfig = () => ({}), pollSec = 60, log = createLogger('contact/email'), setTimer = setInterval, clearTimer = clearInterval } = {}) {
    super({ id: 'email', label: 'Email', capabilities: ['send'] });
    this.transport = transport || null;
    this.getConfig = getConfig;
    this.pollMs = Math.max(1, pollSec) * 1000;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.replyHandler = null;
    this.statusHandler = null;
    this.timer = null;
    this.polling = false;
  }

  config() {
    const c = this.getConfig() || {};
    return {
      owner: normalizeAddress('email', c.owner),
      from: normalizeAddress('email', c.from),
      trustedAuthServId: typeof c.trustedAuthServId === 'string' ? c.trustedAuthServId : ''
    };
  }

  async initialize() {
    if (this.timer || !this.transport || typeof this.transport.poll !== 'function') return;
    this.timer = this.setTimer(() => { this.pollOnce().catch((err) => this.log.warn(`email poll failed: ${err.message}`)); }, this.pollMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async shutdown() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.transport && typeof this.transport.close === 'function') await this.transport.close();
  }

  normalizeTarget(raw = '') {
    return normalizeAddress('email', raw) || '';
  }

  contactCapabilities() {
    if (!this.transport) return null;
    return {
      buttons: false, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: false,
      interrupts: false, maxOptions: 6, maxChars: 20000, idempotentSend: this.transport.idempotent === true
    };
  }

  ownerTarget() {
    const c = this.config();
    return this.transport && c.from ? c.owner : null;
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  onContactStatus(handler) {
    this.statusHandler = typeof handler === 'function' ? handler : null;
  }

  async sendContact(message, meta = {}) {
    const c = this.config();
    if (!this.transport || !c.owner || !c.from) throw new ContactDeliveryError('not-configured', 'email needs contact.email.owner and contact.email.from');
    const messageId = `<kl-${meta.deliveryId}@${domainOf(c.from)}>`;
    const sent = await this.transport.send({
      to: c.owner,
      from: c.from,
      subject: `${message.subject} [KL-${meta.batchToken}]`,
      text: message.text,
      headers: { 'Message-ID': messageId, 'X-KL-Delivery': String(meta.deliveryId) },
      idempotencyKey: meta.deliveryId
    });
    return { deliveryId: meta.deliveryId, externalRef: messageId, relayId: sent?.relayId || null };
  }

  // The owner, or a target the outbound gate passed. Acks go in the thread.
  async send(target, text, options = {}) {
    const c = this.config();
    const to = normalizeAddress('email', target);
    if (!to) throw new Error(`email: "${target}" is not an address`);
    if (to !== c.owner && options[GATE_PASSED] !== true) throw new Error(`email: refusing to send to ${to}: not the owner and not through the outbound gate`);
    const headers = {};
    if (options.inReplyTo) {
      headers['In-Reply-To'] = options.inReplyTo;
      headers.References = options.inReplyTo;
    }
    const sent = await this.transport.send({
      to, from: c.from, subject: options.subject || 'King Louie', text: String(text), headers,
      idempotencyKey: options.deliveryId || `ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    });
    return { ok: true, relayId: sent?.relayId || null };
  }

  // reply: { from, subject, text, inReplyTo, references[], messageId, authResultsTop?, auth? }
  async handleInbound(reply) {
    const c = this.config();
    const from = normalizeAddress('email', reply.from);
    const subjectToken = SUBJECT_TOKEN.exec(String(reply.subject || ''));
    const body = stripQuoted(reply.text || '');
    const bodyToken = SUBJECT_TOKEN.exec(body);
    const thread = [reply.inReplyTo, ...(Array.isArray(reply.references) ? reply.references : [])]
      .map((r) => THREAD_ID.exec(String(r || ''))).find(Boolean);
    const correlation = thread ? thread[1] : (subjectToken || bodyToken)?.[1]?.toUpperCase() || null;
    if (!correlation) {
      this.log.warn(`email reply from ${from || reply.from} names no King Louie batch; dropped`);
      return null;
    }
    const authenticated = reply.auth?.verified === true
      || authResultsPass(reply.authResultsTop, { trustedAuthServId: c.trustedAuthServId, fromDomain: domainOf(from) });
    const ownerProven = Boolean(from && c.owner && from === c.owner && (authenticated || subjectToken || bodyToken));
    if (!ownerProven) this.log.warn(`email reply from ${from || reply.from} is not owner-proven; dropped`);
    if (!this.replyHandler) return null;
    const answerText = body.replace(SUBJECT_TOKEN, '').trim();
    const result = await this.replyHandler(correlation, { text: answerText }, {
      channel: 'email', senderId: from || String(reply.from || ''), chatId: null, at: reply.date || null, ownerProven, deliveryRef: reply.inReplyTo || null
    });
    if (result && result.ackText && ownerProven) {
      try {
        await this.send(c.owner, result.ackText, { subject: `Re: ${reply.subject || 'King Louie'}`, inReplyTo: reply.messageId || null });
      } catch (err) {
        this.log.warn(`email ack failed: ${err.message}`);
      }
    }
    return result;
  }

  async handleBounce(b) {
    if (this.statusHandler) await this.statusHandler({ externalRef: b.originalMessageId, status: 'bounced', error: b.diagnostic || b.status || null });
  }

  // A relay `inbound` event with channel email.
  async ingestRelayEvent(ev) {
    return this.handleInbound({
      from: ev.from, subject: ev.subject, text: ev.text, inReplyTo: ev.inReplyTo, references: ev.references || [],
      messageId: ev.messageId || null, auth: ev.auth || null, date: ev.at || null
    });
  }

  // IMAP/SMTP: read UNSEEN replies and DSNs.
  async pollOnce() {
    if (!this.transport || typeof this.transport.poll !== 'function' || this.polling) return { replies: 0, bounces: 0 };
    this.polling = true;
    try {
      let replies = 0;
      let bounces = 0;
      for (const item of await this.transport.poll()) {
        if (item.kind === 'bounce') {
          bounces += 1;
          await this.handleBounce(item);
        } else if (item.kind === 'reply') {
          replies += 1;
          await this.handleInbound(item);
        }
      }
      return { replies, bounces };
    } finally {
      this.polling = false;
    }
  }
}

module.exports = { EmailChannel, authResultsPass, topAuthResults, domainOf };
```

Create `src/channels/email-transports.js`:

```js
// src/channels/email-transports.js
// The two email transports (cases stage 4 spec §3.2):
//   transport.send({ to, from, subject, text, headers, idempotencyKey }) → { messageId, relayId? }
//   transport.poll() → [{ kind: 'reply', … } | { kind: 'bounce', originalMessageId, status, diagnostic }]
//   transport.close()
// `relay` speaks the contact relay contract; `imap-smtp` uses nodemailer,
// imapflow and mailparser (pure JS), with their own loggers turned off.
const { topAuthResults } = require('./email-channel');
const { ContactDeliveryError } = require('./channel-plugin');
const { createLogger } = require('../logging');

function createRelayEmailTransport({ relay }) {
  return {
    idempotent: true,
    async send({ to, from, subject, text, headers = {}, idempotencyKey }) {
      const out = await relay.send({ channel: 'email', to, from, subject, text, headers, correlation: { deliveryId: headers['X-KL-Delivery'] || null } }, { idempotencyKey });
      return { messageId: headers['Message-ID'] || null, relayId: out.id };
    },
    poll: null,
    async close() {}
  };
}

const MESSAGE_ID_LINE = /^Message-ID:\s*(<[^>\s]+>)/im;
const STATUS_LINE = /^Status:\s*([0-9.]+)/im;
const DIAGNOSTIC_LINE = /^Diagnostic-Code:\s*(.+)$/im;

function contentText(part) {
  if (!part || part.content === undefined || part.content === null) return '';
  return Buffer.isBuffer(part.content) ? part.content.toString('utf8') : String(part.content);
}

// mailparser's result → a reply or a bounce item.
function classifyParsed(parsed) {
  const ct = parsed.headers && typeof parsed.headers.get === 'function' ? parsed.headers.get('content-type') : null;
  const isReport = ct && String(ct.value).toLowerCase() === 'multipart/report'
    && String(ct.params?.['report-type'] || '').toLowerCase() === 'delivery-status';
  if (isReport) {
    // mailparser folds message/delivery-status into the text; the headers of
    // the original stay an attachment (text/rfc822-headers or message/rfc822).
    const parts = [String(parsed.text || ''), ...(parsed.attachments || []).map(contentText)];
    const original = parts.map((t) => MESSAGE_ID_LINE.exec(t)).find(Boolean);
    const status = parts.map((t) => STATUS_LINE.exec(t)).find(Boolean);
    const diagnostic = parts.map((t) => DIAGNOSTIC_LINE.exec(t)).find(Boolean);
    return {
      kind: 'bounce',
      originalMessageId: original ? original[1] : null,
      status: status ? status[1] : null,
      diagnostic: diagnostic ? diagnostic[1].trim() : null
    };
  }
  const refs = parsed.references;
  return {
    kind: 'reply',
    from: parsed.from?.value?.[0]?.address || '',
    subject: parsed.subject || '',
    text: parsed.text || '',
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(refs) ? refs : (refs ? String(refs).split(/\s+/) : []),
    messageId: parsed.messageId || null,
    date: parsed.date ? new Date(parsed.date).toISOString() : null,
    authResultsTop: topAuthResults(parsed.headerLines)
  };
}

// nodemailer failures → the contact error codes.
function smtpError(err) {
  const code = Number(err && err.responseCode);
  const message = `SMTP: ${err && err.message ? err.message : String(err)}`;
  if (code === 552) return new ContactDeliveryError('too-large', message);
  if (code === 530 || code === 535 || err?.code === 'EAUTH') return new ContactDeliveryError('not-configured', message);
  if (code >= 500 && code < 600) return new ContactDeliveryError('rejected', message);
  if (code === 421 || code === 450 || code === 451 || code === 452) return new ContactDeliveryError('rate-limited', message);
  return new ContactDeliveryError('unreachable', message);
}

// smtp: { host, port, secure, user }; imap: { host, port, user, secure? };
// passwords come from the vault through getPassword('smtp' | 'imap').
function createImapSmtpTransport({
  smtp, imap, getPassword = () => null, nodemailer = null, ImapFlow = null, simpleParser = null, log = createLogger('contact/email-imap')
}) {
  const mailer = nodemailer || require('nodemailer');
  const Imap = ImapFlow || require('imapflow').ImapFlow;
  const parse = simpleParser || require('mailparser').simpleParser;
  let transporter = null;
  const smtpTransport = () => {
    if (!transporter) {
      const pass = getPassword('smtp');
      transporter = mailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure === true,
        ...(smtp.user ? { auth: { user: smtp.user, pass } } : {}),
        logger: false,
        debug: false
      });
    }
    return transporter;
  };
  return {
    idempotent: false,
    async send({ to, from, subject, text, headers = {} }) {
      const { 'Message-ID': messageId, ...rest } = headers;
      let info;
      try {
        info = await smtpTransport().sendMail({ to, from, subject, text, ...(messageId ? { messageId } : {}), headers: rest });
      } catch (err) {
        throw smtpError(err);
      }
      return { messageId: info.messageId || messageId || null, relayId: null };
    },
    async poll() {
      const client = new Imap({
        host: imap.host,
        port: imap.port,
        secure: imap.secure !== false,
        auth: { user: imap.user, pass: getPassword('imap') },
        logger: false
      });
      const items = [];
      await client.connect();
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const uids = await client.search({ seen: false }, { uid: true });
          for (const uid of uids || []) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            try {
              items.push(classifyParsed(await parse(msg.source)));
            } catch (err) {
              log.warn(`could not parse message ${uid}: ${err.message}`);
            }
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
      return items;
    },
    async close() {
      if (transporter) transporter.close();
      transporter = null;
    }
  };
}

module.exports = { createRelayEmailTransport, createImapSmtpTransport, classifyParsed, smtpError };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-deps.test.js tests/contact-email.test.js tests/contact-adapter-contract.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/channels/email-channel.js src/channels/email-transports.js tests/helpers/fake-smtp.js tests/contact-email.test.js tests/contact-deps.test.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): email channel over the relay or IMAP/SMTP (nodemailer, imapflow, mailparser)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: ntfy as a delivery-only contact channel

**Files:**
- Create: `src/channels/ntfy-contact.js`
- Test: a new `describe` appended to `tests/contact-adapter-contract.test.js`

**Interfaces:**
- Consumes: existing `src/notifications/channels/ntfy-channel.js` (`NtfyChannel`, its private-network guard); Part 1 `ChannelPlugin`, `ContactDeliveryError`, `GATE_PASSED`.
- Produces: `NtfyContact({ getConfig, publisher })` (id `ntfy`, capabilities `deliveryOnly: true`, `expectsReplies: false`, `ownerTarget()` always `null`), `NO_TEXT` (`'Open King Louie to answer.'`).

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/contact-adapter-contract.test.js`:

```js
describe('contact adapter: ntfy (delivery only)', () => {
  const { NtfyContact, NO_TEXT } = require('../src/channels/ntfy-contact');

  it('meets the contract: send only, never an owner target, text only when includeText', async () => {
    const published = [];
    const publisher = { send: async (p) => { published.push(p); return { ok: true, channel: 'ntfy', topic: p.topic }; } };
    let includeText = false;
    const ntfy = new NtfyContact({ getConfig: () => ({ topic: 'kl-owner-topic', includeText }), publisher });
    const caps = ntfy.contactCapabilities();
    assert.strictEqual(caps.expectsReplies, false);
    assert.strictEqual(caps.deliveryOnly, true);
    assert.strictEqual(ntfy.ownerTarget(), null);
    assert.strictEqual(ntfy.contactConfigured(), true);
    assert.strictEqual((await ntfy.sendContact(MESSAGE, META)).deliveryId, 'd-test-1');
    assert.deepStrictEqual(published[0], { topic: 'kl-owner-topic', title: MESSAGE.subject, body: NO_TEXT });
    includeText = true;
    await ntfy.sendContact(MESSAGE, META);
    assert.strictEqual(published[1].body, MESSAGE.text);
    await assert.rejects(ntfy.send('kl-owner-topic', 'hi'), /without the outbound gate/);

    const failing = new NtfyContact({ getConfig: () => ({ topic: 't' }), publisher: { send: async () => { throw new Error('ntfy publish failed: 500'); } } });
    await assert.rejects(failing.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'unreachable');
    const privateNet = new NtfyContact({ getConfig: () => ({ baseUrl: 'http://127.0.0.1:8080', topic: 't' }) });
    await assert.rejects(privateNet.sendContact(MESSAGE, META), /private network/, 'the NtfyChannel SSRF guard is kept');
    assert.strictEqual(new NtfyContact({ getConfig: () => ({}) }).contactCapabilities(), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: FAIL with `Cannot find module '../src/channels/ntfy-contact'`

- [ ] **Step 3: Implement**

Create `src/channels/ntfy-contact.js`:

```js
// src/channels/ntfy-contact.js
// ntfy as a delivery-only contact channel (cases stage 4 spec §3.1). It wraps
// NtfyChannel, keeping its private-network guard. A topic is readable by
// anyone who knows its name, so the question text goes out only when
// channels.ntfy.includeText is true, and ntfy is never an owner target.
const NtfyChannel = require('../notifications/channels/ntfy-channel');
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');

const NO_TEXT = 'Open King Louie to answer.';

class NtfyContact extends ChannelPlugin {
  // getConfig() → { baseUrl, topic, includeText }
  constructor({ getConfig = () => ({}), publisher = null } = {}) {
    super({ id: 'ntfy', label: 'ntfy', capabilities: ['send'] });
    this.getConfig = getConfig;
    this.publisher = publisher;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  _publisher() {
    if (this.publisher) return this.publisher;
    const c = this.getConfig() || {};
    return new NtfyChannel(c.baseUrl ? { baseUrl: c.baseUrl } : {});
  }

  _topic() {
    return String((this.getConfig() || {}).topic || '').trim();
  }

  contactCapabilities() {
    if (!this._topic()) return null;
    return {
      buttons: false, richText: false, attachments: false, voice: false, expectsReplies: false, authenticatedReplies: false,
      interrupts: true, maxOptions: 0, maxChars: 4000, deliveryOnly: true
    };
  }

  ownerTarget() {
    return null;
  }

  async sendContact(message, meta = {}) {
    const topic = this._topic();
    if (!topic) throw new ContactDeliveryError('not-configured', 'contact.ntfy.topic is not set');
    const includeText = (this.getConfig() || {}).includeText === true;
    let out;
    try {
      out = await this._publisher().send({ topic, title: message.subject, body: includeText ? message.text : NO_TEXT });
    } catch (err) {
      throw new ContactDeliveryError('unreachable', err.message);
    }
    if (!out || out.ok !== true) throw new ContactDeliveryError('not-configured', out?.reason || 'ntfy did not publish');
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }

  // ntfy has no owner target: a plain send needs the outbound gate.
  async send(target, text, options = {}) {
    if (options[GATE_PASSED] !== true) throw new Error('ntfy: refusing to publish without the outbound gate');
    const topic = String(target || '').trim() || this._topic();
    return this._publisher().send({ topic, title: 'King Louie', body: String(text) });
  }
}

module.exports = { NtfyContact, NO_TEXT };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/ntfy-contact.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): ntfy delivery-only contact channel, text only on request

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Contact on the Telegram bridge

**Files:**
- Create: `src/channels/bridge-contact.js`
- Modify: `src/channels/telegram-bridge.js` — five additive hunks: the `require` of `./channel-plugin` (line 8), the `this.apiBase = …` line in the constructor (line 57), a block of contact methods before `  async pollLoop() {` (line 191), `if (!chatId) return;` in `handleMessage` (line 403), `const callbackId = …` in `handleCallbackQuery` (line 758)
- Test: a new `describe` appended to `tests/contact-adapter-contract.test.js`

**Interfaces:**
- Consumes: Part 1 `ContactDeliveryError`, `ContactRouter.knows(channelId, ref)` (through the host object), the reply handler contract.
- Produces: `bridge-contact.js` `contactOwnerProven({ isPrivate, chatId, senderId, target, ownerUserId })`, `callbackData(token, index)`, `parseCallback(data) → { token, index } | null`, `leadingToken(text)`, `buttonRows(items, maxOptions) → [[{ label, data }]]`, `telegramError(err)`, `discordError(err)`. `TelegramBridge` options gain `apiBase` (default `https://api.telegram.org`); new methods `setContactHost({ router, getOwnerUserId, isEnabled })`, `ownerTarget()`, `contactCapabilities()`, `onContactReply(handler)`, `sendContact(message, meta)`, `maybeHandleContactMessage(message, chatId, text) → boolean`, `handleContactCallback(query)`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/contact-adapter-contract.test.js`:

```js
describe('contact adapter: Telegram (fake Bot API via apiBase)', () => {
  const http = require('http');
  const TelegramBridge = require('../src/channels/telegram-bridge');

  async function fakeBotApi() {
    const calls = [];
    let failStatus = null;
    let nextId = 4811;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const method = req.url.split('/').pop();
        calls.push({ path: req.url, method, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (failStatus) {
          res.statusCode = failStatus;
          failStatus = null;
          res.end(JSON.stringify({ ok: false, description: 'forced' }));
          return;
        }
        nextId += 1;
        res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: nextId } : true }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { apiBase: `http://127.0.0.1:${server.address().port}`, calls, failNext: (s) => { failStatus = s; }, close: () => new Promise((r) => server.close(r)) };
  }

  async function bridgeWith(api, { enabled = true } = {}) {
    const bridge = new TelegramBridge({
      token: 'TEST-TOKEN',
      apiBase: api.apiBase,
      allowlistManager: { isAllowed: () => true, isAllowedUser: () => true },
      sessionManager: { buildSessionKey: () => 'agent:main:telegram:x' }
    });
    const routed = [];
    bridge.routeAgentMessage = async (chatId, text) => { routed.push({ chatId, text }); };
    bridge.handleCommand = async (chatId, text) => { routed.push({ chatId, text }); };
    bridge.getOrCreateLocalChat = () => null;
    const known = new Set(['K7QD4M', '7QD4KM']);
    bridge.setContactHost({ router: { knows: (channel, ref) => channel === 'telegram' && known.has(String(ref).toUpperCase()) }, getOwnerUserId: () => '111', isEnabled: () => enabled });
    const calls = [];
    bridge.onContactReply(async (correlationId, answer, meta) => {
      calls.push({ correlationId, answer, meta });
      return meta.ownerProven ? { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' } : { ok: false, outcome: 'refused: not-owner', ackText: null };
    });
    return { bridge, calls, routed, known };
  }

  const privateChat = (id) => ({ id, type: 'private' });

  it('meets the contract', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, known } = await bridgeWith(api);
      assert.strictEqual(bridge.apiBase, `${api.apiBase}/botTEST-TOKEN`);
      assert.strictEqual(bridge.ownerTarget(), '111');
      const sent = await bridge.sendContact(MESSAGE, META);
      assert.strictEqual(sent.deliveryId, 'd-test-1');
      assert.strictEqual(sent.externalRef, '4812');
      const req = api.calls.find((c) => c.method === 'sendMessage');
      assert.strictEqual(req.body.chat_id, 111);
      assert.deepStrictEqual(req.body.reply_markup.inline_keyboard, [[
        { text: '1. No', callback_data: 'kl_q_7QD4KM_0' }, { text: '1. Yes, up to 20 %', callback_data: 'kl_q_7QD4KM_1' }
      ]]);
      assert.ok(Buffer.byteLength('kl_q_7QD4KM_1') <= 17);

      await bridge.handleUpdate({ callback_query: { id: 'cb1', data: 'kl_q_7QD4KM_1', from: { id: 111 }, message: { chat: privateChat(111) } } });
      assert.deepStrictEqual([calls[0].correlationId, calls[0].answer, calls[0].meta.ownerProven], ['7QD4KM', { optionIndex: 1 }, true]);
      assert.strictEqual(api.calls.filter((c) => c.method === 'sendMessage').pop().body.text, 'Recorded for Lakeside lot.');

      known.add('4812');
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: 'yes', reply_to_message: { message_id: 4812 } } });
      assert.deepStrictEqual([calls[1].correlationId, calls[1].answer, calls[1].meta.ownerProven], ['4812', { text: 'yes' }, true]);

      await bridge.handleUpdate({ message: { chat: privateChat(999), from: { id: 999 }, text: '#K7QD4M a' } });
      assert.strictEqual(calls[2].meta.ownerProven, false, 'a stranger');

      api.failNext(429);
      await assert.rejects(bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
    } finally {
      await api.close();
    }
  });

  it('refuses a group member and a second allowlisted user, and never routes their #TOKEN to the agent', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, routed } = await bridgeWith(api);
      const before = api.calls.length;
      await bridge.handleUpdate({ message: { chat: { id: -100222, type: 'supergroup', title: 'Family' }, from: { id: 333 }, text: '#K7QD4M 1 a' } });
      await bridge.handleUpdate({ message: { chat: privateChat(444), from: { id: 444 }, text: '#K7QD4M 1 a' } });
      await bridge.handleUpdate({ callback_query: { id: 'cb2', data: 'kl_q_7QD4KM_0', from: { id: 111 }, message: { chat: { id: -100222, type: 'supergroup' } } } });
      assert.deepStrictEqual(calls.map((c) => c.meta.ownerProven), [false, false, false], 'the owner pressing in a group is not the private chat either');
      assert.deepStrictEqual(routed, []);
      assert.deepStrictEqual(api.calls.slice(before).filter((c) => c.method === 'sendMessage'), [], 'no acks to anyone');
      assert.strictEqual(api.calls.slice(before).find((c) => c.method === 'answerCallbackQuery').body.text, 'Not allowed');

      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: '#ZZZZZZ unrelated' } });
      assert.deepStrictEqual(routed, [{ chatId: '111', text: '#ZZZZZZ unrelated' }], 'an unknown token is an ordinary message');
    } finally {
      await api.close();
    }
  });

  it('with contact off it is not a contact channel', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge } = await bridgeWith(api, { enabled: false });
      assert.strictEqual(bridge.contactCapabilities(), null);
      assert.strictEqual(bridge.ownerTarget(), null);
      await assert.rejects(bridge.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
      assert.strictEqual(new TelegramBridge({ token: 'X' }).apiBase, 'https://api.telegram.org/botX');
    } finally {
      await api.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: FAIL — `bridge.setContactHost is not a function`

- [ ] **Step 3: Implement**

Create `src/channels/bridge-contact.js`:

```js
// src/channels/bridge-contact.js
// Pieces the Telegram and Discord bridges share for contact (cases stage 4
// spec §3.1): owner proof (R43), button callback data, error mapping.
const { ContactDeliveryError } = require('./channel-plugin');

const CALLBACK = /^kl_q_([0-9A-Za-z]{6})_(\d)$/;
const TOKEN_PREFIX = /^#([0-9A-Za-z]{6})\b/;

// Owner-proven only when the message arrived in the contact target (a
// private chat / DM with the owner) AND the sender is the contact owner. The
// allowlist alone never suffices.
function contactOwnerProven({ isPrivate, chatId, senderId, target, ownerUserId }) {
  return Boolean(isPrivate && target && ownerUserId
    && String(chatId) === String(target) && String(senderId) === String(ownerUserId));
}

function callbackData(token, index) {
  return `kl_q_${token}_${index}`;
}

function parseCallback(data) {
  const m = CALLBACK.exec(String(data || ''));
  return m ? { token: m[1].toUpperCase(), index: Number(m[2]) } : null;
}

function leadingToken(text) {
  const m = TOKEN_PREFIX.exec(String(text || '').trim());
  return m ? m[1].toUpperCase() : null;
}

const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// One row per answerable item with 1..maxOptions options.
function buttonRows(items, maxOptions) {
  return (items || [])
    .filter((it) => it.answerable && Array.isArray(it.options) && it.options.length > 0 && it.options.length <= maxOptions)
    .map((it) => it.options.map((o, i) => ({ label: cut(`${it.n}. ${o.label}`, 40), data: callbackData(it.token, i) })));
}

function httpStatusError(status, message) {
  if (status === 400) return new ContactDeliveryError('rejected', message);
  if (status === 401 || status === 403 || status === 404) return new ContactDeliveryError('not-configured', message);
  if (status === 413) return new ContactDeliveryError('too-large', message);
  if (status === 429) return new ContactDeliveryError('rate-limited', message);
  return new ContactDeliveryError('unreachable', message);
}

// callTelegram throws "Telegram <method> failed: <status> …" or
// "Telegram <method> error: …" (ok: false); fetch throws on the network.
function telegramError(err) {
  const m = /failed: (\d{3})/.exec(String(err && err.message));
  if (m) return httpStatusError(Number(m[1]), err.message);
  if (/ error: /.test(String(err && err.message))) return new ContactDeliveryError('rejected', err.message);
  return new ContactDeliveryError('unreachable', err && err.message ? err.message : String(err));
}

// discord.js DiscordAPIError / HTTPError carry a numeric `status`.
function discordError(err) {
  if (err && Number.isInteger(err.status)) return httpStatusError(err.status, err.message);
  return new ContactDeliveryError('unreachable', err && err.message ? err.message : String(err));
}

module.exports = { contactOwnerProven, callbackData, parseCallback, leadingToken, buttonRows, telegramError, discordError };
```

In `src/channels/telegram-bridge.js`, replace

```js
const { ChannelPlugin } = require('./channel-plugin');
```

with

```js
const { ChannelPlugin, ContactDeliveryError } = require('./channel-plugin');
const { contactOwnerProven, parseCallback, leadingToken, buttonRows, telegramError } = require('./bridge-contact');
```

Then replace

```js
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
```

with

```js
    // Cases stage 4: `apiBase` (default https://api.telegram.org) lets tests use a fake Bot API.
    this.apiBase = `${String(options.apiBase || 'https://api.telegram.org').replace(/\/$/, '')}/bot${this.token}`;
    this.contactHost = null;
    this.contactReplyHandler = null;
```

Then replace

```js
  async pollLoop() {
```

with

```js
  // ---- Contact (cases stage 4 §3.1). The contact target is the private chat
  // with the contact owner, whose chat id is the owner's user id. ----

  // host: { router, getOwnerUserId(), isEnabled() } from src/cases/contact-host.js
  setContactHost(host) {
    this.contactHost = host && typeof host === 'object' ? host : null;
  }

  _contactOwner() {
    if (!this.contactHost) return null;
    const enabled = typeof this.contactHost.isEnabled === 'function' && this.contactHost.isEnabled() === true;
    const owner = typeof this.contactHost.getOwnerUserId === 'function' ? String(this.contactHost.getOwnerUserId() || '').trim() : '';
    return enabled && owner ? owner : null;
  }

  ownerTarget() {
    return this._contactOwner();
  }

  contactCapabilities() {
    if (!this.ownerTarget()) return null;
    return {
      buttons: true, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: true,
      interrupts: true, maxOptions: 8, maxChars: 4000
    };
  }

  onContactReply(handler) {
    this.contactReplyHandler = typeof handler === 'function' ? handler : null;
  }

  async sendContact(message, meta = {}) {
    const target = this.ownerTarget();
    if (!target) throw new ContactDeliveryError('not-configured', 'Telegram contact is off or has no contact owner id');
    const rows = buttonRows(message.items, 8).map((row) => row.map((b) => ({ text: b.label, callback_data: b.data })));
    let sent;
    try {
      sent = await this.sendMessage(target, message.text, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
    } catch (error) {
      throw telegramError(error);
    }
    return { deliveryId: meta.deliveryId || null, externalRef: String(sent?.message_id ?? '') || null };
  }

  async _contactReply(correlationId, answer, meta) {
    const result = await this.contactReplyHandler(correlationId, answer, { channel: 'telegram', at: new Date().toISOString(), ...meta });
    if (result && result.ackText && meta.ownerProven) {
      try {
        await this.sendMessage(this.ownerTarget(), result.ackText);
      } catch (error) {
        log.warn(`contact ack failed: ${error.message}`);
      }
    }
    return result;
  }

  // A reply to a contact message or a "#<token> …" message goes to the router,
  // never to routeAgentMessage. Everyone but the owner in the private chat is
  // refused there (ownerProven: false).
  async maybeHandleContactMessage(message, chatId, text) {
    if (!this.contactHost || !this.contactReplyHandler || !this.contactHost.router) return false;
    const token = leadingToken(text);
    const replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : null;
    const byToken = Boolean(token && this.contactHost.router.knows('telegram', token));
    const byReply = Boolean(replyTo && this.contactHost.router.knows('telegram', replyTo));
    if (!byToken && !byReply) return false;
    const senderId = String(message.from?.id || '');
    const ownerProven = contactOwnerProven({
      isPrivate: String(message.chat?.type || '') === 'private', chatId, senderId, target: this.ownerTarget(), ownerUserId: this._contactOwner()
    });
    await this._contactReply(byToken ? token : replyTo, { text }, { senderId, chatId, ownerProven, deliveryRef: replyTo });
    return true;
  }

  async handleContactCallback(query = {}) {
    const callbackId = String(query.id || '');
    const parsed = parseCallback(query.data);
    if (!parsed || !this.contactReplyHandler) {
      await this.answerCallbackQuery(callbackId, 'Unknown action');
      return;
    }
    const chatId = String(query?.message?.chat?.id || '');
    const senderId = String(query?.from?.id || '');
    const ownerProven = contactOwnerProven({
      isPrivate: String(query?.message?.chat?.type || '') === 'private', chatId, senderId, target: this.ownerTarget(), ownerUserId: this._contactOwner()
    });
    await this.answerCallbackQuery(callbackId, ownerProven ? 'Received' : 'Not allowed');
    await this._contactReply(parsed.token, { optionIndex: parsed.index }, { senderId, chatId, ownerProven });
  }

  async pollLoop() {
```

Then replace

```js
    const chatId = String(message?.chat?.id || '');
    const text = inbound.text;
    if (!chatId) return;
```

with

```js
    const chatId = String(message?.chat?.id || '');
    const text = inbound.text;
    if (!chatId) return;
    // Cases stage 4: contact replies go to the router before the allowlist.
    if (await this.maybeHandleContactMessage(message, chatId, text)) return;
```

Then replace

```js
    const callbackId = String(query.id || '');

    const match = data.match(/^kl_a_([a-z0-9]+)_(y|n)$/i);
```

with

```js
    const callbackId = String(query.id || '');

    // Cases stage 4: contact buttons are checked before approval buttons.
    if (data.startsWith('kl_q_')) {
      await this.handleContactCallback(query);
      return;
    }

    const match = data.match(/^kl_a_([a-z0-9]+)_(y|n)$/i);
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/bridge-contact.js src/channels/telegram-bridge.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): Telegram contact with owner proof, kl_q_ buttons and an apiBase option

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Contact on the Discord bridge

**Files:**
- Modify: `src/channels/discord-bridge.js` — four additive hunks: the `require` of `./channel-plugin` (line 2), the end of the constructor (`this.boundAgentResponse = …`, line 68), the first lines of `handleMessageCreate` (line 203), and a block of contact methods plus a `kl_q_` branch at the start of `handleInteractionCreate` (line 711)
- Test: a new `describe` appended to `tests/contact-adapter-contract.test.js`

**Interfaces:**
- Consumes: Task 10 `bridge-contact.js`; `discord.js` `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle` (already imported by the bridge).
- Produces: `DiscordChannel` methods `setContactHost({ router, getOwnerUserId, isEnabled })`, `ownerTarget()`, `contactCapabilities()`, `onContactReply(handler)`, `sendContact(message, meta)` (to the DM from `users.fetch(ownerUserId).createDM()`), `maybeHandleContactMessage(message) → boolean`, `handleContactInteraction(interaction)`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/contact-adapter-contract.test.js`:

```js
describe('contact adapter: Discord (fake client)', () => {
  const DiscordChannel = require('../src/channels/discord-bridge');

  function fakeDiscord({ enabled = true } = {}) {
    const dms = {};
    const makeUser = (id) => ({
      id,
      createDM: async () => {
        if (!dms[id]) {
          const sends = [];
          dms[id] = { id: `dm-${id}`, sends, fail: null, send: async (p) => { if (dms[id].fail) { const e = dms[id].fail; dms[id].fail = null; throw e; } sends.push(p); return { id: `m-${sends.length}` }; } };
        }
        return dms[id];
      }
    });
    const bridge = new DiscordChannel({ token: 'mock-token', allowlistManager: { isAllowed: () => true, isAllowedUser: () => true } });
    bridge.client = { users: { fetch: async (id) => makeUser(String(id)) }, channels: { fetch: async () => null } };
    const known = new Set(['K7QD4M', '7QD4KM']);
    bridge.setContactHost({ router: { knows: (channel, ref) => channel === 'discord' && known.has(String(ref).toUpperCase()) }, getOwnerUserId: () => '222', isEnabled: () => enabled });
    const calls = [];
    bridge.onContactReply(async (correlationId, answer, meta) => {
      calls.push({ correlationId, answer, meta });
      return meta.ownerProven ? { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' } : { ok: false, outcome: 'refused: not-owner', ackText: null };
    });
    const routed = [];
    bridge.routeAgentMessage = async (chatId, text) => { routed.push({ chatId, text }); };
    const msg = (fields) => ({ author: { id: '222', bot: false }, content: '', channelId: 'dm-222', guildId: null, reference: null, mentions: { has: () => false }, ...fields });
    const press = (fields) => {
      const replies = [];
      return { interaction: { isButton: () => true, customId: 'kl_q_7QD4KM_1', user: { id: '222' }, guildId: null, channelId: 'dm-222', reply: async (p) => { replies.push(p); }, ...fields }, replies };
    };
    return { bridge, dms, calls, routed, known, msg, press };
  }

  it('meets the contract', async () => {
    const d = fakeDiscord();
    const sent = await d.bridge.sendContact(MESSAGE, META);
    assert.deepStrictEqual(sent, { deliveryId: 'd-test-1', externalRef: 'm-1' });
    const payload = d.dms['222'].sends[0];
    assert.strictEqual(payload.content, MESSAGE.text);
    assert.deepStrictEqual(payload.components[0].toJSON().components.map((c) => [c.custom_id, c.label]), [['kl_q_7QD4KM_0', '1. No'], ['kl_q_7QD4KM_1', '1. Yes, up to 20 %']]);

    const p = d.press({});
    await d.bridge.handleInteractionCreate(p.interaction);
    assert.deepStrictEqual([d.calls[0].correlationId, d.calls[0].answer, d.calls[0].meta.ownerProven], ['7QD4KM', { optionIndex: 1 }, true]);
    assert.deepStrictEqual(p.replies, [{ content: 'Received', ephemeral: true }]);
    assert.deepStrictEqual(d.dms['222'].sends.pop(), { content: 'Recorded for Lakeside lot.' });

    d.known.add('M-1');
    await d.bridge.handleMessageCreate(d.msg({ content: 'yes', reference: { messageId: 'm-1' } }));
    assert.deepStrictEqual([d.calls[1].correlationId, d.calls[1].answer.text, d.calls[1].meta.ownerProven], ['m-1', 'yes', true]);

    await d.bridge.handleMessageCreate(d.msg({ author: { id: '999', bot: false }, channelId: 'dm-999', content: '#K7QD4M a' }));
    assert.strictEqual(d.calls[2].meta.ownerProven, false, 'a stranger');

    d.dms['222'].fail = Object.assign(new Error('You are being rate limited.'), { status: 429 });
    await assert.rejects(d.bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
  });

  it('refuses a guild member and a second allowlisted user, and never routes their #TOKEN to the agent', async () => {
    const d = fakeDiscord();
    await d.bridge.handleMessageCreate(d.msg({ author: { id: '333', bot: false }, channelId: 'guild-channel-1', guildId: 'guild-1', content: '#K7QD4M 1 a' }));
    await d.bridge.handleMessageCreate(d.msg({ author: { id: '444', bot: false }, channelId: 'dm-444', content: '#K7QD4M 1 a' }));
    const inGuild = d.press({ guildId: 'guild-1', channelId: 'guild-channel-1' });
    await d.bridge.handleInteractionCreate(inGuild.interaction);
    assert.deepStrictEqual(d.calls.map((c) => c.meta.ownerProven), [false, false, false]);
    assert.deepStrictEqual(inGuild.replies, [{ content: 'Not allowed', ephemeral: true }]);
    assert.deepStrictEqual(d.routed, []);
    assert.deepStrictEqual(d.dms['222'] ? d.dms['222'].sends : [], [], 'no acks');
  });

  it('with contact off it is not a contact channel', async () => {
    const d = fakeDiscord({ enabled: false });
    assert.strictEqual(d.bridge.contactCapabilities(), null);
    await assert.rejects(d.bridge.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-adapter-contract.test.js`
Expected: FAIL — `bridge.setContactHost is not a function` (in the Discord suite)

- [ ] **Step 3: Implement**

In `src/channels/discord-bridge.js`, replace

```js
const { ChannelPlugin } = require('./channel-plugin');
```

with

```js
const { ChannelPlugin, ContactDeliveryError } = require('./channel-plugin');
const { contactOwnerProven, parseCallback, leadingToken, buttonRows, discordError } = require('./bridge-contact');
```

Then replace

```js
    this.boundAgentResponse = this.handleAgentResponse.bind(this);
```

with

```js
    this.boundAgentResponse = this.handleAgentResponse.bind(this);
    // Cases stage 4 contact state.
    this.contactHost = null;
    this.contactReplyHandler = null;
    this.contactDm = null;
```

Then replace

```js
  async handleMessageCreate(message) {
    if (message.author.bot) return;
    if (message.author.id === this.botUserId) return;
```

with

```js
  async handleMessageCreate(message) {
    if (message.author.bot) return;
    if (message.author.id === this.botUserId) return;
    // Cases stage 4: contact replies go to the router before the allowlist.
    if (await this.maybeHandleContactMessage(message)) return;
```

Then replace

```js
  async handleInteractionCreate(interaction) {
    if (!interaction.isButton()) return;
```

with

```js
  // ---- Contact (cases stage 4 §3.1). The contact target is the DM with the
  // contact owner, opened with users.fetch(ownerUserId).createDM(). ----

  // host: { router, getOwnerUserId(), isEnabled() } from src/cases/contact-host.js
  setContactHost(host) {
    this.contactHost = host && typeof host === 'object' ? host : null;
    this.contactDm = null;
  }

  _contactOwner() {
    if (!this.contactHost) return null;
    const enabled = typeof this.contactHost.isEnabled === 'function' && this.contactHost.isEnabled() === true;
    const owner = typeof this.contactHost.getOwnerUserId === 'function' ? String(this.contactHost.getOwnerUserId() || '').trim() : '';
    return enabled && owner ? owner : null;
  }

  ownerTarget() {
    return this._contactOwner();
  }

  contactCapabilities() {
    if (!this.ownerTarget()) return null;
    return {
      buttons: true, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: true,
      interrupts: true, maxOptions: 5, maxChars: 1900
    };
  }

  onContactReply(handler) {
    this.contactReplyHandler = typeof handler === 'function' ? handler : null;
  }

  async _contactChannel() {
    const owner = this._contactOwner();
    if (!owner || !this.client) return null;
    if (this.contactDm && this.contactDm.owner === owner) return this.contactDm.channel;
    const user = await this.client.users.fetch(owner);
    const channel = await user.createDM();
    this.contactDm = { owner, channel };
    return channel;
  }

  async sendContact(message, meta = {}) {
    let dm;
    try {
      dm = await this._contactChannel();
    } catch (error) {
      throw discordError(error);
    }
    if (!dm) throw new ContactDeliveryError('not-configured', 'Discord contact is off, has no contact owner id, or the bot is not connected');
    const components = buttonRows(message.items, 5).slice(0, 5).map((row) => new ActionRowBuilder().addComponents(
      ...row.map((b) => new ButtonBuilder().setCustomId(b.data).setLabel(b.label).setStyle(ButtonStyle.Secondary))
    ));
    let sent;
    try {
      sent = await dm.send({ content: message.text, components });
    } catch (error) {
      throw discordError(error);
    }
    return { deliveryId: meta.deliveryId || null, externalRef: sent?.id ? String(sent.id) : null };
  }

  async _contactReply(correlationId, answer, meta) {
    const result = await this.contactReplyHandler(correlationId, answer, { channel: 'discord', at: new Date().toISOString(), ...meta });
    if (result && result.ackText && meta.ownerProven) {
      try {
        const dm = await this._contactChannel();
        if (dm) await dm.send({ content: result.ackText });
      } catch (error) {
        log.warn(`contact ack failed: ${error.message}`);
      }
    }
    return result;
  }

  async _contactProven({ guildId, channelId, senderId }) {
    let dm = null;
    try {
      dm = await this._contactChannel();
    } catch {
      dm = null;
    }
    return contactOwnerProven({ isPrivate: !guildId, chatId: channelId, senderId, target: dm ? dm.id : null, ownerUserId: this._contactOwner() });
  }

  async maybeHandleContactMessage(message) {
    if (!this.contactHost || !this.contactReplyHandler || !this.contactHost.router) return false;
    const text = String(message.content || '').trim();
    const token = leadingToken(text);
    const replyTo = message.reference?.messageId ? String(message.reference.messageId) : null;
    const byToken = Boolean(token && this.contactHost.router.knows('discord', token));
    const byReply = Boolean(replyTo && this.contactHost.router.knows('discord', replyTo));
    if (!byToken && !byReply) return false;
    const senderId = String(message.author?.id || '');
    const ownerProven = await this._contactProven({ guildId: message.guildId || null, channelId: String(message.channelId), senderId });
    await this._contactReply(byToken ? token : replyTo, { text }, { senderId, chatId: String(message.channelId), ownerProven, deliveryRef: replyTo });
    return true;
  }

  async handleContactInteraction(interaction) {
    const parsed = parseCallback(interaction.customId);
    if (!parsed || !this.contactReplyHandler) {
      await interaction.reply({ content: 'Unknown action', ephemeral: true });
      return;
    }
    const senderId = String(interaction.user?.id || interaction.member?.user?.id || '');
    const ownerProven = await this._contactProven({ guildId: interaction.guildId || null, channelId: String(interaction.channelId), senderId });
    await interaction.reply({ content: ownerProven ? 'Received' : 'Not allowed', ephemeral: true });
    await this._contactReply(parsed.token, { optionIndex: parsed.index }, { senderId, chatId: String(interaction.channelId), ownerProven });
  }

  async handleInteractionCreate(interaction) {
    if (!interaction.isButton()) return;
    // Cases stage 4: contact buttons are checked before approval buttons.
    if (String(interaction.customId || '').startsWith('kl_q_')) {
      await this.handleContactInteraction(interaction);
      return;
    }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-adapter-contract.test.js tests/discord-channel.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord-bridge.js tests/contact-adapter-contract.test.js
git commit -m "feat(contact): Discord contact in the owner DM with owner proof and kl_q_ buttons

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 2 hand-off

When Tasks 7–11 are merged, run:

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/)"`
Expected: no output.

Part 3 (`docs/superpowers/plans/2026-09-23-cases-stage4-channels-part3.md`) depends on these exports existing exactly as named, in addition to Part 1's:

| Module | Exports |
|---|---|
| `src/channels/relay-client.js` | `ContactRelayClient`, `RelayPoller`, `assertRelayBaseUrl`, `errorForStatus`, `verifyRelayPush`, `createRelayPushHandler`, `BACKOFF_MIN_MS`, `BACKOFF_MAX_MS` |
| `src/channels/telephony-channel.js` | `TelephonyChannel` |
| `src/channels/email-channel.js` | `EmailChannel`, `authResultsPass`, `topAuthResults`, `domainOf` |
| `src/channels/email-transports.js` | `createRelayEmailTransport`, `createImapSmtpTransport`, `classifyParsed`, `smtpError` |
| `src/channels/ntfy-contact.js` | `NtfyContact`, `NO_TEXT` |
| `src/channels/bridge-contact.js` | `contactOwnerProven`, `callbackData`, `parseCallback`, `leadingToken`, `buttonRows`, `telegramError`, `discordError` |
| `src/channels/telegram-bridge.js` | `TelegramBridge` option `apiBase`; methods `setContactHost`, `ownerTarget`, `contactCapabilities`, `onContactReply`, `sendContact`, `maybeHandleContactMessage`, `handleContactCallback` |
| `src/channels/discord-bridge.js` | `DiscordChannel` methods `setContactHost`, `ownerTarget`, `contactCapabilities`, `onContactReply`, `sendContact`, `maybeHandleContactMessage`, `handleContactInteraction` |
| `tests/helpers/` | `fake-contact-relay.js` `startFakeRelay`; `fake-smtp.js` `startFakeSmtp` |

