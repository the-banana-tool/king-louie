# Cases Stage 4: Channels, presence and the contact ladder — Implementation Plan (Part 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire contact into the hosts: settings and the admin `contact` block, the contact host inside `createCore`, the relay push route, IPC, the Questions section in the desktop app, and the F2-late regression.
**Architecture:** `src/cases/contact-host.js` builds everything from Parts 1–2 and `createCore` calls it from `start()` in a few additive hunks (program §5 exception for C4). Service mode takes the owner identity only from the admin `service.json` (`ADMIN_ONLY_KEYS`), passed by `run.js` as `deps.contactConfig`. The renderer gets one `renderQuestionsSection` block. Starts after Part 2 (`…-part2.md`) has merged.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`; Electron preload/renderer for the UI; the e2e HTTP bridge harness.
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

### Task 12: Settings, the admin `contact` block and the Vault refusal

**Files:**
- Create: `src/cases/contact-settings.js`
- Modify: `src/core/settings.js` (one hunk at the end of `mergeSettings`), `src/service/config.js` (one hunk before `function validatePorts(ports, file) {`, one in the object `loadServiceConfig` returns), `src/tools/builtin/vault-tool.js` (three hunks), `tests/service-config.test.js` (the default-config expectation gains `contact: null`)
- Test: `tests/contact-service-config.test.js`

**Interfaces:**
- Consumes: Part 1 `effectivePolicy`, `assertRelayBaseUrl` (from `contact-format.js`; this module must not require `src/channels/`, because `src/service/config.js` loads it and the runbook profile's module-graph test forbids channel code).
- Produces: `CHANNEL_DEFAULTS`; `mergeContactSettings(source, baseChannels) → { contactPolicy, contact, channels }`; `validateContactConfig(value, file) → block | null` (unknown keys rejected with the path named); `resolveContactConfig({ settings, contactConfig, isService, logger }) → contact block`. `loadServiceConfig(…)` also returns `contact`; `ADMIN_ONLY_KEYS` includes `contact`; the `Vault` tool refuses and hides `contact.*`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-service-config.test.js`:

```js
// tests/contact-service-config.test.js — cases stage 4 §6, §8: in service
// mode the owner identity and contact addresses come only from the admin
// service.json; the Vault tool refuses and hides contact.* credentials.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig } = require('../src/service/config');
const { validateContactConfig, resolveContactConfig, mergeContactSettings } = require('../src/cases/contact-settings');
const { mergeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');
const vaultTool = require('../src/tools/builtin/vault-tool');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-contact-cfg-')); dirs.push(d); return d; };
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const writeCfg = (dir, cfg) => {
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
};
const opts = (dir) => ({ adminConfigDir: dir, geteuid: () => -1, adminUid: selfUid });

const CONTACT = {
  telegram: { ownerUserId: '123456789' },
  discord: { ownerUserId: '234567890123456789' },
  ntfy: { baseUrl: 'https://ntfy.sh', topic: '' },
  email: { owner: 'Owner@Example.com', from: 'kl@example.com', relay: 'main', imap: { host: 'imap.example.com', port: 993, user: 'kl@example.com', trustedAuthServId: 'mx.example.com', pollSec: 60 } },
  sms: { owner: '+1 555 010 0', from: '+15550199', relay: 'main' },
  voice: { owner: '+15550100', from: '+15550199', relay: 'main' },
  relays: { main: { baseUrl: 'https://relay.example.com', pollSec: 30 } }
};

function recordingLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(m), info() {}, debug() {}, error() {} };
}

describe('the admin service.json contact block', () => {
  it('is read from the admin dir only; the data-dir copy is ignored', () => {
    const admin = tmp();
    const data = tmp();
    writeCfg(admin, { contact: CONTACT });
    writeCfg(data, { contact: { telegram: { ownerUserId: '999' } } });
    const cfg = loadServiceConfig(data, {}, opts(admin));
    assert.strictEqual(cfg.contact.telegram.ownerUserId, '123456789');
    assert.strictEqual(cfg.contact.email.owner, 'owner@example.com');
    assert.strictEqual(cfg.contact.sms.owner, '+15550100');

    const onlyData = tmp();
    writeCfg(onlyData, { contact: { telegram: { ownerUserId: '999' } } });
    assert.strictEqual(loadServiceConfig(onlyData, {}, opts(tmp())).contact, null);
  });

  it('rejects unknown keys and bad values with the key path named (R55)', () => {
    assert.throws(() => validateContactConfig({ telegram: { ownerUserId: '1', chatId: '2' } }, 'service.json'), /contact\.telegram\.chatId is not a known key/);
    assert.throws(() => validateContactConfig({ pager: {} }, 'service.json'), /contact\.pager is not a known key/);
    assert.throws(() => validateContactConfig({ telegram: { ownerUserId: 123 } }, 'service.json'), /contact\.telegram\.ownerUserId must be a numeric user id/);
    assert.throws(() => validateContactConfig({ sms: { owner: '555-0100' } }, 'service.json'), /contact\.sms\.owner must be an E\.164 number/);
    assert.throws(() => validateContactConfig({ relays: { main: { baseUrl: 'http://relay.example.com' } } }, 'service.json'), /contact\.relays\.main\.baseUrl must be https:, or http: to loopback/);
    assert.throws(() => validateContactConfig({ sms: { owner: '+15550100', relay: 'other' } }, 'service.json'), /contact\.sms\.relay names "other"/);
    assert.deepStrictEqual(validateContactConfig({ relays: { local: { baseUrl: 'http://127.0.0.1:8080' } } }, 'service.json'), { relays: { local: { baseUrl: 'http://127.0.0.1:8080' } } });
    assert.strictEqual(validateContactConfig(undefined, 'service.json'), null);
  });
});

describe('resolveContactConfig', () => {
  const settings = { contact: { sms: { owner: '+15550177' } }, channels: { telegram: { contactOwnerUserId: '999' } } };

  it('service mode: data-dir settings.contact and contactOwnerUserId are ignored with a warning', () => {
    const logger = recordingLogger();
    const out = resolveContactConfig({ settings, contactConfig: validateContactConfig(CONTACT, 'service.json'), isService: true, logger });
    assert.strictEqual(out.telegram.ownerUserId, '123456789');
    assert.strictEqual(out.sms.owner, '+15550100');
    assert.strictEqual(logger.lines.length, 2);
    assert.match(logger.lines.join('\n'), /ignoring settings\.contact/);
    assert.match(logger.lines.join('\n'), /ignoring channels\.telegram\.contactOwnerUserId/);
    resolveContactConfig({ settings, contactConfig: null, isService: true, logger });
    assert.strictEqual(logger.lines.length, 2, 'warned once');
    assert.deepStrictEqual(resolveContactConfig({ settings, contactConfig: null, isService: true, logger: recordingLogger() }), {});
  });

  it('desktop: settings.contact plus channels.<ch>.contactOwnerUserId', () => {
    const out = resolveContactConfig({ settings, isService: false });
    assert.deepStrictEqual(out, { sms: { owner: '+15550177' }, telegram: { ownerUserId: '999' } });
  });
});

describe('settings merge', () => {
  it('fills contactPolicy, contact and the channel contact keys, keeping existing channel settings', () => {
    const merged = mergeSettings({ channels: { telegram: { requireMention: true, contactEnabled: true } }, contactPolicy: { batchDelaySec: 10 } });
    assert.strictEqual(merged.contactPolicy.batchDelaySec, 10);
    assert.strictEqual(merged.contactPolicy.digest.at, '08:00');
    assert.deepStrictEqual(merged.channels.telegram, { contactEnabled: true, contactOwnerUserId: '', requireMention: true });
    assert.deepStrictEqual(merged.channels.email, { enabled: false, transport: 'relay' });
    assert.deepStrictEqual(merged.channels.ntfy, { enabled: false, includeText: false });
    assert.deepStrictEqual(merged.channels.slack, DEFAULT_SETTINGS.channels.slack);
    assert.deepStrictEqual(merged.contact, {});
    assert.deepStrictEqual(mergeContactSettings({}, DEFAULT_SETTINGS.channels).channels.discord.allowedGuilds, []);
  });
});

describe('Vault tool', () => {
  function fakeVault() {
    const data = new Map([['api_key', 'x'], ['contact', '{nested}'], ['contact.relay.main.token', 'secret']]);
    return {
      set: (k, v) => data.set(k, v), get: (k) => data.get(k) || null, delete: (k) => data.delete(k), list: () => [...data.keys()]
    };
  }

  it('refuses keys starting contact. and hides them from list', async () => {
    const vault = fakeVault();
    for (const action of ['retrieve', 'store', 'delete']) {
      const r = await vaultTool.execute({ action, key: 'contact.relay.main.token', value: 'x' }, { vault });
      assert.deepStrictEqual(r, { ok: false, error: 'contact credentials are managed in settings, not by the model' });
    }
    assert.strictEqual(vault.get('contact.relay.main.token'), 'secret');
    const listed = await vaultTool.execute({ action: 'list' }, { vault });
    assert.deepStrictEqual(listed, { ok: true, keys: ['api_key'], count: 1 });
    assert.strictEqual((await vaultTool.execute({ action: 'retrieve', key: 'api_key' }, { vault })).value, 'x');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-service-config.test.js`
Expected: FAIL with `Cannot find module '../src/cases/contact-settings'`

- [ ] **Step 3: Implement**

Create `src/cases/contact-settings.js`:

```js
// src/cases/contact-settings.js
// Settings for contact (cases stage 4 spec §6): the `contactPolicy`,
// `contact` and `channels.*` defaults and merge, the admin service.json
// `contact` block and its validation (R55), and where the owner identity
// comes from in each host.
// No src/channels import here: src/service/config.js loads this module and
// the runbook profile must not pull in channel code.
const { effectivePolicy, assertRelayBaseUrl } = require('./contact-format');
const { createLogger } = require('../logging');

const log = createLogger('contact/settings');

const CHANNEL_DEFAULTS = Object.freeze({
  telegram: { contactEnabled: false, contactOwnerUserId: '' },
  discord: { contactEnabled: false, contactOwnerUserId: '' },
  email: { enabled: false, transport: 'relay' },
  sms: { enabled: false, maxChars: 1200, language: 'en-US' },
  voice: { enabled: false, maxChars: 1200, language: 'en-US' },
  ntfy: { enabled: false, includeText: false },
  mobile: { enabled: false }
});

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Spread at the end of mergeSettings (src/core/settings.js):
// `...mergeContactSettings(source, DEFAULT_SETTINGS.channels)`.
function mergeContactSettings(source = {}, baseChannels = {}) {
  const src = obj(source);
  const channels = { ...obj(baseChannels), ...obj(src.channels) };
  for (const [id, defaults] of Object.entries(CHANNEL_DEFAULTS)) {
    channels[id] = { ...defaults, ...obj(baseChannels[id]), ...obj(obj(src.channels)[id]) };
  }
  channels.slack = { ...obj(baseChannels.slack), ...obj(obj(src.channels).slack) };
  return {
    contactPolicy: effectivePolicy(src.contactPolicy),
    contact: { ...obj(src.contact) },
    channels
  };
}

// ---- The admin service.json `contact` block ----

const SHAPE = {
  telegram: { ownerUserId: 'id' },
  discord: { ownerUserId: 'id' },
  ntfy: { baseUrl: 'url', topic: 'string' },
  email: {
    owner: 'email', from: 'email', relay: 'string',
    smtp: { host: 'string', port: 'port', secure: 'boolean', user: 'string' },
    imap: { host: 'string', port: 'port', user: 'string', trustedAuthServId: 'string', pollSec: 'seconds', secure: 'boolean' }
  },
  sms: { owner: 'phone', from: 'phone', relay: 'string' },
  voice: { owner: 'phone', from: 'phone', relay: 'string' }
};
const RELAY_SHAPE = { baseUrl: 'relayUrl', pollSec: 'seconds' };

function checkValue(kind, value, where) {
  const bad = (what) => new Error(`${where} ${what}`);
  switch (kind) {
    case 'id':
      if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw bad('must be a numeric user id in quotes');
      return value;
    case 'string':
      if (typeof value !== 'string') throw bad('must be text');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('must be true or false');
      return value;
    case 'port':
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw bad('must be an integer from 1 to 65535');
      return value;
    case 'seconds':
      if (!Number.isInteger(value) || value < 5 || value > 86400) throw bad('must be an integer from 5 to 86400');
      return value;
    case 'email':
      if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw bad('must be an email address');
      return value.toLowerCase();
    case 'phone': {
      const s = String(value ?? '').replace(/[\s\-.()]/g, '');
      if (!/^\+\d{8,15}$/.test(s)) throw bad('must be an E.164 number such as +15550100');
      return s;
    }
    case 'url': {
      let u;
      try {
        u = new URL(String(value));
      } catch {
        throw bad('must be a URL');
      }
      if (u.protocol !== 'https:') throw bad('must be an https: URL');
      return String(value);
    }
    case 'relayUrl':
      try {
        return assertRelayBaseUrl(value);
      } catch (err) {
        throw bad(err.message.replace(/^relay baseUrl /, ''));
      }
    default:
      throw bad('has an unknown type');
  }
}

function checkObject(shape, value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      throw new Error(`${where}.${key} is not a known key (expected ${Object.keys(shape).join(', ')})`);
    }
    out[key] = typeof shape[key] === 'object' ? checkObject(shape[key], v, `${where}.${key}`) : checkValue(shape[key], v, `${where}.${key}`);
  }
  return out;
}

// Returns the normalized block, or null when service.json has none.
function validateContactConfig(value, file) {
  if (value === undefined || value === null) return null;
  const prefix = `Invalid ${file}: contact`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${prefix} must be an object`);
  const { relays, ...rest } = value;
  const out = checkObject(SHAPE, rest, prefix);
  if (relays !== undefined) {
    if (!relays || typeof relays !== 'object' || Array.isArray(relays)) throw new Error(`${prefix}.relays must be an object`);
    out.relays = {};
    for (const [name, relay] of Object.entries(relays)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`${prefix}.relays.${name} is not a lowercase relay name`);
      out.relays[name] = checkObject(RELAY_SHAPE, relay, `${prefix}.relays.${name}`);
      if (!out.relays[name].baseUrl) throw new Error(`${prefix}.relays.${name}.baseUrl is required`);
    }
  }
  for (const ch of ['email', 'sms', 'voice']) {
    const relay = out[ch]?.relay;
    if (relay && !out.relays?.[relay]) throw new Error(`${prefix}.${ch}.relay names "${relay}", which is not under contact.relays`);
  }
  return out;
}

// Who the owner is and where to reach them. Desktop: settings `contact` and
// channels.<ch>.contactOwnerUserId. Service: only the admin block; data-dir
// values are ignored with a warning (the service account can write them).
const warnedBy = new WeakMap();
function resolveContactConfig({ settings = {}, contactConfig = null, isService = false, logger = log } = {}) {
  const s = obj(settings);
  if (isService) {
    const stray = [];
    if (Object.keys(obj(s.contact)).length) stray.push('settings.contact');
    for (const ch of ['telegram', 'discord']) if (obj(obj(s.channels)[ch]).contactOwnerUserId) stray.push(`channels.${ch}.contactOwnerUserId`);
    const warned = warnedBy.get(logger) || new Set();
    warnedBy.set(logger, warned);
    for (const key of stray) {
      if (!warned.has(key)) {
        warned.add(key);
        logger.warn(`ignoring ${key} from the data dir: in service mode the owner and contact addresses come only from the admin service.json "contact" block`);
      }
    }
    return JSON.parse(JSON.stringify(obj(contactConfig)));
  }
  const out = JSON.parse(JSON.stringify(obj(s.contact)));
  for (const ch of ['telegram', 'discord']) {
    const owner = String(obj(obj(s.channels)[ch]).contactOwnerUserId || '').trim();
    if (owner) out[ch] = { ...obj(out[ch]), ownerUserId: owner };
  }
  return out;
}

module.exports = { CHANNEL_DEFAULTS, mergeContactSettings, validateContactConfig, resolveContactConfig };
```

In `src/core/settings.js`, at the end of `mergeSettings`, replace

```js
      slack: {
        ...(DEFAULT_SETTINGS.channels?.slack || {}),
        ...(source.channels?.slack || {})
      }
    }
  };
};
```

with

```js
      slack: {
        ...(DEFAULT_SETTINGS.channels?.slack || {}),
        ...(source.channels?.slack || {})
      }
    },
    // Cases stage 4: contactPolicy, contact, and channels.* with the contact keys
    // (src/cases/contact-settings.js). Replaces `channels` with a superset.
    ...require('../cases/contact-settings').mergeContactSettings(source, DEFAULT_SETTINGS.channels)
  };
};
```

In `src/service/config.js`, replace

```js
function validatePorts(ports, file) {
```

with

```js
// Cases stage 4 (R55): who the owner is and where to reach them comes only
// from the admin service.json, never from the service-writable data dir.
ADMIN_ONLY_KEYS.push('contact');
const { validateContactConfig } = require('../cases/contact-settings');

function validatePorts(ports, file) {
```

and, in the object `loadServiceConfig` returns, replace

```js
    profile,
    features,
```

with

```js
    profile,
    features,
    contact: validateContactConfig(adminCfg.contact, adminFile),
```

In `src/tools/builtin/vault-tool.js`, replace

```js
const { Tool } = require('../tool-schema');
```

with

```js
const { Tool } = require('../tool-schema');

// Cases stage 4: relay tokens, webhook secrets and mailbox passwords live
// under `contact.`; the model can neither read nor list them.
const isContactKey = (key) => key === 'contact' || String(key || '').startsWith('contact.');
```

then replace

```js
    if (action !== 'list' && !key) {
      return { ok: false, error: `"key" parameter is required for ${action} action.` };
    }
```

with

```js
    if (action !== 'list' && !key) {
      return { ok: false, error: `"key" parameter is required for ${action} action.` };
    }

    if (action !== 'list' && isContactKey(key)) {
      return { ok: false, error: 'contact credentials are managed in settings, not by the model' };
    }
```

then replace

```js
          const keys = vault.list();
```

with

```js
          const keys = vault.list().filter((k) => !isContactKey(k));
```

In `tests/service-config.test.js`, in the first test (`defaults to agent profile with listeners and chat channels off, on the service ports`), replace

```js
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
```

with

```js
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      contact: null,
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-service-config.test.js tests/service-config.test.js tests/core-settings.test.js tests/service-profile-graph.test.js tests/runbooks.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/contact-settings.js src/core/settings.js src/service/config.js src/tools/builtin/vault-tool.js tests/service-config.test.js tests/contact-service-config.test.js
git commit -m "feat(contact): contact settings, admin-only contact block, Vault refuses contact.*

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The contact host, `createCore` wiring and the relay push route

**Files:**
- Create: `src/cases/contact-host.js`
- Modify: `src/webhooks/webhook-server.js` (a `setContactRelayHandler` method before `  async stop() {`, a route before `      // Route webhook requests: POST /webhooks/{webhookId}`), `src/core/create-core.js` (four additive hunks: the `require` after `const WebhookServer = require('../webhooks/webhook-server');`; `let contactHost` and the host start at the top of `const start = async () => {`; `contactHost.stop()` before `    // A turn cut off by quit must not leave its case locked.`; the `getContact` getter after `    getCaseRuntime: () => caseRuntime,`), `src/service/run.js` (one line after `          workingDirectory: workspace,`)
- Test: `tests/contact-host.test.js`

**Interfaces:**
- Consumes: Parts 1–2; Task 12 `resolveContactConfig`; C2 `caseRuntime.host` (`notify`, `uiToast`, `interactive()`, `getExecutorRegistry()`), `caseRuntime.root`; existing `createCore` locals `getSettings`, `setSettings`, `channelRegistry`, `vault`, `userDataPath`, `features`, `telegramBridge`, `discordBridge`, `webhookServer`, `deps`.
- Produces: `createContactHost({ getSettings, setSettings, contactConfig, isService, caseRuntime, channelRegistry, vault, dataDir, features, getBridges, getWebhookServer, approvals, clock, tickMs, getGate, fetchImpl, extraAdapters, log })` → `{ state, router, presence, ladder, adapters, relays, start(), stop(), channelStatuses(), getPolicy(), setPolicy(policy), presenceStatus(), context() }`; `defaultGetGate()`. `core.context.getContact() → context() | null`. `WebhookServer#setContactRelayHandler(handler)` and `POST /contact/relay/<name>`. `createCore` dep `contactConfig` (its presence means service mode) and `approvals` (Part 4).

- [ ] **Step 1: Write the failing test**

Create `tests/contact-host.test.js`:

```js
// tests/contact-host.test.js — cases stage 4 §7 (wiring) and the relay push route.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { createContactHost } = require('../src/cases/contact-host');
const { ChannelRegistry } = require('../src/channels/channel-plugin');
const { mergeSettings } = require('../src/core/settings');
const WebhookServer = require('../src/webhooks/webhook-server');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const CONTACT = {
  telegram: { ownerUserId: '123456789' },
  sms: { owner: '+15550100', from: '+15550199', relay: 'main' },
  voice: { owner: '+15550100', from: '+15550199', relay: 'main' },
  email: { owner: 'owner@example.com', from: 'kl@example.com', relay: 'main' },
  ntfy: { baseUrl: 'https://ntfy.example.com', topic: 'kl-topic' },
  relays: { main: { baseUrl: 'https://relay.example.com', pollSec: 30 } }
};

class FakeBridge extends LoopbackChannel {
  setContactHost(host) {
    this.host = host;
  }

  contactCapabilities() {
    return this.ownerTarget() ? { ...this.caps } : null;
  }

  ownerTarget() {
    return this.host && this.host.isEnabled() ? this.host.getOwnerUserId() || null : null;
  }
}

function makeHost({ interactive = true, isService = false, contactConfig = null, settings = {}, features = { channels: true }, webhook = null } = {}) {
  let stored = mergeSettings(settings);
  const events = [];
  const runtime = new CaseRuntime({ root: path.join(tmp('kl-host-cases-'), 'cases'), host: { interactive: () => interactive, notify: (e, p) => events.push([e, p]) } });
  const registry = new ChannelRegistry();
  const telegram = new FakeBridge({ id: 'telegram' });
  const vault = new Map([['contact.relay.main.token', 'relay-token'], ['contact.relay.main.webhookSecret', 'push-secret']]);
  const hostOpts = {
    getSettings: () => stored,
    setSettings: (s) => { stored = mergeSettings(s); },
    contactConfig,
    isService,
    caseRuntime: runtime,
    channelRegistry: registry,
    vault: { get: (k) => vault.get(k) || null },
    dataDir: tmp('kl-host-data-'),
    features,
    getBridges: () => ({ telegram, discord: null }),
    getWebhookServer: () => webhook,
    tickMs: 60000,
    fetchImpl: async () => { throw new Error('offline in tests'); }
  };
  if (!isService) delete hostOpts.contactConfig;
  const host = createContactHost(hostOpts);
  return { host, runtime, registry, telegram, events, settings: () => stored };
}

const desktopSettings = {
  contact: { ...CONTACT, telegram: undefined },
  channels: {
    telegram: { contactEnabled: true, contactOwnerUserId: '111' },
    sms: { enabled: true }, voice: { enabled: true }, email: { enabled: true, transport: 'relay' }, ntfy: { enabled: true }
  }
};

describe('createContactHost', () => {
  it('builds the enabled adapters, registers them, attaches the bridges and serves getContact()', async () => {
    const t = makeHost({ settings: desktopSettings });
    try {
      await t.host.start();
      assert.deepStrictEqual(t.registry.list().map((c) => c.id).sort(), ['email', 'ntfy', 'sms', 'voice']);
      assert.strictEqual(t.host.adapters.get('telegram'), t.telegram);
      assert.strictEqual(t.telegram.ownerTarget(), '111', 'desktop: the owner id comes from channels.telegram.contactOwnerUserId');
      assert.ok(t.host.adapters.get('in-app'), 'in-app exists with an interactive host');
      const ctx = t.host.context();
      assert.ok(ctx.ladder && ctx.presence && ctx.router);
      const statuses = ctx.getPolicy().channels;
      assert.deepStrictEqual(statuses.telegram, { enabled: true, configured: true });
      assert.deepStrictEqual(statuses.sms, { enabled: true, configured: true });
      assert.deepStrictEqual(statuses.discord, { enabled: false, configured: false, reason: 'not enabled in this host' });
      assert.strictEqual(statuses.slack, undefined);
      assert.deepStrictEqual(ctx.heartbeat({ focused: true, lastInputAt: new Date().toISOString() }), { ok: true });
      assert.strictEqual(ctx.presenceStatus().presentChannel, 'in-app');
      assert.deepStrictEqual(ctx.presenceStatus().ladder, { runsHere: false, message: 'no cases yet' });
      assert.deepStrictEqual(ctx.ladderState(), {});
    } finally {
      await t.host.stop();
    }
  });

  it('setPolicy validates and saves settings.contactPolicy', async () => {
    const t = makeHost({ settings: desktopSettings });
    const ctx = t.host.context();
    assert.deepStrictEqual(ctx.setPolicy({ ladders: { normal: [{ channel: 'slack' }] } }), { ok: false, error: 'slack is not a contact channel: it has no sender allowlist' });
    const r = ctx.setPolicy({ batchDelaySec: 30 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(t.settings().contactPolicy.batchDelaySec, 30);
    assert.strictEqual(ctx.getPolicy().policy.batchDelaySec, 30);
  });

  it('service mode: the owner comes from the admin contactConfig only; no in-app without an interactive host', async () => {
    const t = makeHost({
      isService: true,
      interactive: false,
      contactConfig: { telegram: { ownerUserId: '123456789' } },
      settings: { contact: { telegram: { ownerUserId: '999' } }, channels: { telegram: { contactEnabled: true, contactOwnerUserId: '999' } } }
    });
    try {
      await t.host.start();
      assert.strictEqual(t.telegram.ownerTarget(), '123456789');
      assert.strictEqual(t.host.adapters.get('in-app'), null);
      assert.deepStrictEqual(t.registry.list(), [], 'nothing else is configured');
    } finally {
      await t.host.stop();
    }
  });

  it('with features.channels off no channel adapter is built', async () => {
    const t = makeHost({ settings: desktopSettings, features: { channels: false } });
    try {
      await t.host.start();
      assert.deepStrictEqual(t.registry.list(), []);
    } finally {
      await t.host.stop();
    }
  });

  it('mounts POST /contact/relay/<name> on the loopback webhook server, HMAC-checked', async () => {
    const webhook = new WebhookServer({ port: 0 }, { handle: async () => ({}) }, { port: 0 });
    await webhook.start();
    const t = makeHost({ settings: desktopSettings, webhook });
    try {
      await t.host.start();
      const body = JSON.stringify({ id: 'ev-1', type: 'status', messageId: 'msg-404', status: 'delivered' });
      const ts = new Date().toISOString();
      const sig = `sha256=${crypto.createHmac('sha256', 'push-secret').update(`${ts}.${body}`).digest('hex')}`;
      const post = (headers) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: webhook.port, path: '/contact/relay/main', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.deepStrictEqual(await post({ 'x-kl-timestamp': ts, 'x-kl-signature': sig }), { status: 200, body: { ok: true, applied: 0, skipped: 1 } });
      assert.strictEqual((await post({ 'x-kl-timestamp': ts, 'x-kl-signature': 'sha256=' + '0'.repeat(64) })).status, 401);
    } finally {
      await t.host.stop();
      await webhook.stop();
    }
  });

  it('takes the cases-root lease once a case exists and releases it on stop', async () => {
    const t = makeHost({ settings: desktopSettings });
    await t.runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    await t.host.start();
    const lock = path.join(t.runtime.root, '.contact.lock');
    assert.strictEqual(fs.existsSync(lock), true);
    assert.deepStrictEqual(t.host.presenceStatus().ladder, { runsHere: true });
    await t.host.stop();
    assert.strictEqual(fs.existsSync(lock), false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-host.test.js`
Expected: FAIL with `Cannot find module '../src/cases/contact-host'`

- [ ] **Step 3: Implement**

Create `src/cases/contact-host.js`:

```js
// src/cases/contact-host.js
// Wires contact into a host (cases stage 4 spec §7): builds the adapters,
// Presence, ContactRouter and LadderEngine, attaches the Telegram and Discord
// bridges, polls the relays, mounts the relay push route and exposes what
// IPC needs. Electron-free; createCore calls it from start().
const path = require('path');
const { DesktopChannelPlugin } = require('../channels/channel-plugin');
const { EmailChannel } = require('../channels/email-channel');
const { createRelayEmailTransport, createImapSmtpTransport } = require('../channels/email-transports');
const { TelephonyChannel } = require('../channels/telephony-channel');
const { NtfyContact } = require('../channels/ntfy-contact');
const { ContactRelayClient, RelayPoller, createRelayPushHandler } = require('../channels/relay-client');
const { ContactState } = require('./contact-state');
const { ContactRouter } = require('./contact');
const { Presence } = require('./presence');
const { LadderEngine } = require('./ladder');
const { CONTACT_CHANNELS, validatePolicy, effectivePolicy } = require('./contact-format');
const { resolveContactConfig } = require('./contact-settings');
const { createLogger } = require('../logging');

const ATTACH_MS = 2000;

// C3's gateLeaves when it has merged, else null (every non-owner send refuses).
function defaultGetGate() {
  try {
    const gates = require('./gates');
    return typeof gates.gateLeaves === 'function' ? gates : null;
  } catch {
    return null;
  }
}

function createContactHost({
  getSettings, setSettings = null, contactConfig = null, isService = false, caseRuntime, channelRegistry = null, vault = null,
  dataDir, features = {}, getBridges = () => ({}), getWebhookServer = () => null, approvals = null,
  clock = () => new Date(), tickMs = Number(process.env.KING_LOUIE_CONTACT_TICK_MS) || 30000, getGate = defaultGetGate,
  fetchImpl = globalThis.fetch, extraAdapters = {}, log = createLogger('contact/host')
} = {}) {
  const host = caseRuntime.host || {};
  const settings = () => {
    try {
      return getSettings() || {};
    } catch {
      return {};
    }
  };
  const channelSettings = (id) => (settings().channels && settings().channels[id]) || {};
  const contact = () => resolveContactConfig({ settings: settings(), contactConfig, isService, logger: log });
  const interactive = () => {
    try {
      return typeof host.interactive === 'function' && host.interactive() === true;
    } catch {
      return false;
    }
  };
  const secret = (key) => (vault && typeof vault.get === 'function' ? vault.get(key) : null);
  const contactDir = path.join(dataDir, 'contact');
  const state = new ContactState({ dir: contactDir, clock });

  const built = new Map();
  const attached = {};
  let inApp = null;
  let presence = null;

  const adapters = {
    get(id) {
      if (id === 'in-app') return inApp;
      if (id === 'telegram' || id === 'discord') {
        attachBridges();
        const b = getBridges()[id];
        return b && attached[id] === b ? b : null;
      }
      return built.get(id) || null;
    }
  };

  presence = new Presence({
    file: path.join(contactDir, 'presence.json'),
    getPolicy: () => settings().contactPolicy,
    clock,
    interactive,
    isEnabled: (id) => Boolean(adapters.get(id)?.contactConfigured()),
    getTimeZone: () => settings().cases?.timeZone || ''
  });
  const router = new ContactRouter({ state, runtime: caseRuntime, adapters, presence, getGate, clock, getTimeZone: () => presence.timeZone() });
  const ladder = new LadderEngine({
    state, casesRoot: caseRuntime.root, runtime: caseRuntime, router, presence, getPolicy: () => settings().contactPolicy, clock, tickMs, dataDir
  });

  function wire(id, adapter) {
    adapter.onContactReply((correlationId, answer, meta) => router.handleReply(id, correlationId, answer, meta));
    adapter.onContactStatus((s) => router.recordStatus(id, s));
  }

  function attachBridges() {
    for (const id of ['telegram', 'discord']) {
      const bridge = getBridges()[id];
      if (!bridge || attached[id] === bridge || typeof bridge.setContactHost !== 'function') continue;
      bridge.setContactHost({
        router,
        getOwnerUserId: () => contact()[id]?.ownerUserId || '',
        isEnabled: () => channelSettings(id).contactEnabled === true
      });
      wire(id, bridge);
      attached[id] = bridge;
    }
  }

  // Relays and the channels built on them, only with features.channels on.
  const relays = new Map();
  const pollers = [];
  function buildAdapters() {
    const cfg = contact();
    for (const [name, r] of Object.entries(cfg.relays || {})) {
      try {
        relays.set(name, {
          client: new ContactRelayClient({ name, baseUrl: r.baseUrl, getToken: () => secret(`contact.relay.${name}.token`), fetchImpl }),
          pollSec: r.pollSec || 30
        });
      } catch (err) {
        log.warn(`contact relay ${name} is not usable: ${err.message}`);
      }
    }
    const email = channelSettings('email');
    if (email.enabled && cfg.email) {
      let transport = null;
      if (email.transport === 'imap-smtp' && cfg.email.smtp && cfg.email.imap) {
        transport = createImapSmtpTransport({ smtp: cfg.email.smtp, imap: cfg.email.imap, getPassword: (which) => secret(`contact.email.${which}Password`) });
      } else if (relays.has(cfg.email.relay)) {
        transport = createRelayEmailTransport({ relay: relays.get(cfg.email.relay).client });
      }
      if (transport) {
        built.set('email', new EmailChannel({
          transport,
          getConfig: () => ({ owner: contact().email?.owner, from: contact().email?.from, trustedAuthServId: contact().email?.imap?.trustedAuthServId || '' }),
          pollSec: cfg.email.imap?.pollSec || 60
        }));
      }
    }
    for (const kind of ['sms', 'voice']) {
      const s = channelSettings(kind);
      const c = cfg[kind];
      if (s.enabled && c && relays.has(c.relay)) {
        built.set(kind, new TelephonyChannel({
          kind,
          relay: relays.get(c.relay).client,
          getConfig: () => ({ owner: contact()[kind]?.owner, from: contact()[kind]?.from, maxChars: channelSettings(kind).maxChars, language: channelSettings(kind).language })
        }));
      }
    }
    if (channelSettings('ntfy').enabled && cfg.ntfy) {
      built.set('ntfy', new NtfyContact({
        getConfig: () => ({ baseUrl: contact().ntfy?.baseUrl, topic: contact().ntfy?.topic, includeText: channelSettings('ntfy').includeText === true })
      }));
    }
    for (const [id, adapter] of Object.entries(extraAdapters)) {
      if (adapter) built.set(id, adapter);
    }
    for (const [id, adapter] of built) {
      wire(id, adapter);
      if (channelRegistry) channelRegistry.register(adapter);
    }
  }

  let attachTimer = null;
  const api = {
    state, router, presence, ladder, adapters, relays,

    async start() {
      if (interactive()) {
        inApp = new DesktopChannelPlugin({
          sendToUi: (event, payload) => (typeof host.notify === 'function' ? host.notify(event, payload) : undefined),
          uiToast: host.uiToast || null,
          isFocused: () => presence.status().signals.desktop?.focused === true
        });
      }
      if (features.channels !== false) buildAdapters();
      for (const adapter of built.values()) {
        try {
          await adapter.initialize();
        } catch (err) {
          log.warn(`contact channel ${adapter.id} did not start: ${err.message}`);
        }
      }
      for (const [name, r] of relays) {
        const poller = new RelayPoller({
          client: r.client, state, pollSec: r.pollSec,
          onEvents: async (events) => (ladder.active ? router.ingestRelayEvents(name, events) : null)
        });
        poller.start();
        pollers.push(poller);
      }
      const webhook = getWebhookServer();
      if (webhook && typeof webhook.setContactRelayHandler === 'function') {
        webhook.setContactRelayHandler(createRelayPushHandler({
          getSecret: (name) => secret(`contact.relay.${name}.webhookSecret`),
          hasRelay: (name) => relays.has(name),
          onEvents: (name, events) => router.ingestRelayEvents(name, events),
          clock
        }));
      }
      attachBridges();
      attachTimer = setInterval(attachBridges, ATTACH_MS);
      if (typeof attachTimer.unref === 'function') attachTimer.unref();
      ladder.start();
      if (approvals && typeof api.startMobile === 'function') await api.startMobile(approvals);
    },

    async stop() {
      if (attachTimer) clearInterval(attachTimer);
      attachTimer = null;
      for (const p of pollers) p.stop();
      await ladder.stop();
      for (const adapter of built.values()) {
        try {
          await adapter.shutdown();
        } catch (err) {
          log.warn(`contact channel ${adapter.id} did not stop cleanly: ${err.message}`);
        }
      }
    },

    channelStatuses() {
      const out = {};
      for (const id of CONTACT_CHANNELS) out[id] = router.channelStatus(id);
      return out;
    },

    getPolicy() {
      return { policy: effectivePolicy(settings().contactPolicy), channels: api.channelStatuses() };
    },

    setPolicy(policy) {
      const r = validatePolicy(policy, { now: clock() });
      if (!r.ok) return r;
      if (typeof setSettings !== 'function') return { ok: false, error: 'this host cannot save settings' };
      setSettings({ ...settings(), contactPolicy: r.policy });
      return { ok: true, policy: r.policy };
    },

    presenceStatus() {
      const status = presence.status();
      const s = ladder.status();
      return { ...status, ladder: s.runsHere ? { runsHere: true } : { runsHere: false, message: s.holder ? `contact ladder runs in ${s.holder.host}:${s.holder.pid}` : 'no cases yet' } };
    },

    // core.context.getContact()
    context() {
      return {
        ladder, presence, router,
        ladderState: () => ladder.list(),
        getPolicy: () => api.getPolicy(),
        setPolicy: (p) => api.setPolicy(p),
        heartbeat: (p) => presence.heartbeat(p || {}),
        presenceStatus: () => api.presenceStatus()
      };
    }
  };
  return api;
}

module.exports = { createContactHost, defaultGetGate };
```

In `src/webhooks/webhook-server.js`, replace

```js
  async stop() {
```

with

```js
  // Cases stage 4: a co-located contact relay pushes its events to
  // POST /contact/relay/<name>. handler(name, rawBody, headers) → { status, body };
  // it checks the HMAC (src/channels/relay-client.js createRelayPushHandler).
  setContactRelayHandler(handler) {
    this.contactRelayHandler = typeof handler === 'function' ? handler : null;
  }

  async stop() {
```

and replace

```js
      // Route webhook requests: POST /webhooks/{webhookId}
```

with

```js
      // Cases stage 4: signed contact relay push.
      const contactMatch = url.pathname.match(/^\/contact\/relay\/([a-z][a-z0-9-]{0,31})$/);
      if (contactMatch && req.method === 'POST' && this.contactRelayHandler) {
        const body = await this.readRequestBody(req);
        const result = await this.contactRelayHandler(contactMatch[1], body, req.headers);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }

      // Route webhook requests: POST /webhooks/{webhookId}
```

In `src/core/create-core.js`, replace

```js
const WebhookServer = require('../webhooks/webhook-server');
```

with

```js
const WebhookServer = require('../webhooks/webhook-server');
const { createContactHost } = require('../cases/contact-host');
```

then replace

```js
  const start = async () => {
    initializeTools();
    await initializeAgentInfrastructure();
```

with

```js
  // Cases stage 4: contact channels, presence and the ladder
  // (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §7).
  let contactHost = null;

  const start = async () => {
    initializeTools();
    await initializeAgentInfrastructure();
    contactHost = createContactHost({
      getSettings,
      setSettings,
      contactConfig: deps.contactConfig ?? null,
      isService: Object.prototype.hasOwnProperty.call(deps, 'contactConfig'),
      caseRuntime,
      channelRegistry,
      vault,
      dataDir: userDataPath,
      features,
      getBridges: () => ({ telegram: telegramBridge, discord: discordBridge }),
      getWebhookServer: () => webhookServer,
      approvals: deps.approvals || null
    });
    await contactHost.start();
```

then replace

```js
    // A turn cut off by quit must not leave its case locked.
```

with

```js
    if (contactHost) await contactHost.stop().catch((err) => log.warn(`Contact shutdown failed: ${err.message}`));
    // A turn cut off by quit must not leave its case locked.
```

then replace

```js
    getCaseRuntime: () => caseRuntime,
```

with

```js
    getCaseRuntime: () => caseRuntime,
    getContact: () => (contactHost ? contactHost.context() : null),
```

In `src/service/run.js`, inside the agent profile's `createCore({ … })` call, replace

```js
          workingDirectory: workspace,
```

with

```js
          workingDirectory: workspace,
          // Cases stage 4: the owner identity and contact addresses, admin service.json only.
          contactConfig: loadServiceConfig(dataDir).contact,
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-host.test.js tests/webhook-server.test.js tests/core-create.test.js tests/service-run.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/cases/contact-host.js src/webhooks/webhook-server.js src/core/create-core.js src/service/run.js tests/contact-host.test.js
git commit -m "feat(contact): contact host in createCore, relay push route, service contact config

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: IPC, the preload bridge and the attached-desktop proxy

**Files:**
- Create: `src/ipc/contact-handlers.js`
- Modify: `src/ipc/constants.js` (after `  CASE_SET_DISCLOSABLE: 'case:setDisclosable',`), `src/ipc/register.js` (after `  registerCaseHandlers(ipcMain, context);`), `preload.js` (a `contact` block before `    usage: {`); only if F7 has merged: `src/desktop-bridge/allowlist.js` and `tests/desktop-bridge-allowlist.test.js`
- Test: `tests/contact-ipc.test.js`

**Interfaces:**
- Consumes: Task 13 `core.context.getContact()`; the Electron host's `context.getMainWindow()` (main.js passes it to `registerHandlers`); F7 `isLocalDesktopEvent(event)` when `src/core/origin.js` exists.
- Produces: IPC `contact:ladderState → { ok: true, state }`, `contactPolicy:get → { ok: true, policy, channels }`, `contactPolicy:set (policy) → { ok, policy } | { ok: false, error }`, `presence:heartbeat ({ focused, lastInputAt }) → { ok: true }` (main window or attached desktop only), `presence:status → { ok: true, …status, ladder }`; constants `CONTACT_LADDER_STATE`, `CONTACT_POLICY_GET`, `CONTACT_POLICY_SET`, `PRESENCE_HEARTBEAT`, `PRESENCE_STATUS`; preload `window.electron.contact.{ ladderState, getPolicy, setPolicy, heartbeat, presenceStatus }`; `registerContactHandlers(ipcMain, context)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-ipc.test.js`:

```js
// tests/contact-ipc.test.js — cases stage 4 §5.2 (the five IPC handlers).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { registerContactHandlers } = require('../src/ipc/contact-handlers');
const { CaseRuntime } = require('../src/cases');
const { createContactHost } = require('../src/cases/contact-host');
const { mergeSettings } = require('../src/core/settings');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function setup() {
  let stored = mergeSettings({});
  const runtime = new CaseRuntime({ root: path.join(tmp('kl-contact-ipc-'), 'cases'), host: { interactive: () => true, notify: () => {} } });
  const host = createContactHost({
    getSettings: () => stored, setSettings: (s) => { stored = mergeSettings(s); }, caseRuntime: runtime, dataDir: tmp('kl-contact-ipc-data-'), features: { channels: false }
  });
  const webContents = { id: 1 };
  const handlers = new Map();
  registerContactHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, {
    getContact: () => host.context(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents })
  });
  const main = { sender: webContents };
  return { host, handlers, runtime, settings: () => stored, call: (channel, payload, event = main) => handlers.get(channel)(event, payload) };
}

describe('contact IPC', () => {
  it('registers the five channels', () => {
    const { handlers } = setup();
    const channels = [IPC.CONTACT_LADDER_STATE, IPC.CONTACT_POLICY_GET, IPC.CONTACT_POLICY_SET, IPC.PRESENCE_HEARTBEAT, IPC.PRESENCE_STATUS];
    assert.deepStrictEqual(channels, ['contact:ladderState', 'contactPolicy:get', 'contactPolicy:set', 'presence:heartbeat', 'presence:status']);
    for (const ch of channels) assert.ok(handlers.has(ch), ch);
  });

  it('contactPolicy:get returns the policy and per-channel status; :set validates and saves', async () => {
    const t = setup();
    const got = await t.call(IPC.CONTACT_POLICY_GET);
    assert.strictEqual(got.ok, true);
    assert.strictEqual(got.policy.batchDelaySec, 60);
    assert.deepStrictEqual(Object.keys(got.channels), ['in-app', 'telegram', 'discord', 'email', 'sms', 'voice', 'ntfy', 'mobile']);
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, { ladders: { high: [{ channel: 'slack' }] } }), { ok: false, error: 'slack is not a contact channel: it has no sender allowlist' });
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, { quietHours: { start: '22:00', end: '25:00' } }), { ok: false, error: 'quietHours.start and end must be HH:MM' });
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, 'nope'), { ok: false, error: 'the contact policy must be an object' });
    const saved = await t.call(IPC.CONTACT_POLICY_SET, { quietHours: { start: '22:00', end: '07:00' } });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(t.settings().contactPolicy.quietHours, { start: '22:00', end: '07:00', breakthrough: ['high'] });
  });

  it('presence:heartbeat is accepted only from the main window, with a checked payload', async () => {
    const t = setup();
    const refused = await t.call(IPC.PRESENCE_HEARTBEAT, { focused: true }, { sender: { id: 99 } });
    assert.deepStrictEqual(refused, { ok: false, error: 'presence:heartbeat is accepted only from the main window or an attached desktop.' });
    assert.deepStrictEqual(await t.call(IPC.PRESENCE_HEARTBEAT, { focused: 'yes' }), { ok: false, error: 'focused must be true or false.' });
    assert.deepStrictEqual(await t.call(IPC.PRESENCE_HEARTBEAT, { focused: true, lastInputAt: new Date().toISOString() }), { ok: true });
    const status = await t.call(IPC.PRESENCE_STATUS);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.presentChannel, 'in-app');
    assert.strictEqual(status.signals.desktop.focused, true);
  });

  it('contact:ladderState returns the ladder entries', async () => {
    const t = setup();
    const state = await t.call(IPC.CONTACT_LADDER_STATE);
    assert.deepStrictEqual(state, { ok: true, state: {} });
  });

  it('without contact in the host every call fails cleanly', async () => {
    const handlers = new Map();
    registerContactHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getContact: () => null });
    assert.deepStrictEqual(await handlers.get(IPC.PRESENCE_STATUS)({}, {}), { ok: false, error: 'Contact is not available in this host.' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/contact-ipc.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/contact-handlers'`

- [ ] **Step 3: Implement**

Create `src/ipc/contact-handlers.js`:

```js
// src/ipc/contact-handlers.js
// Cases stage 4 IPC (spec §5.2): the ladder state, the contact policy and
// presence. Everything goes through core.context.getContact().
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

// F7's origin marks events proxied from an attached desktop. Absent before F7.
let origin = null;
try {
  origin = require('../core/origin');
} catch {
  origin = null;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function registerContactHandlers(ipcMain, context = {}) {
  const contact = () => {
    const c = typeof context.getContact === 'function' ? context.getContact() : null;
    if (!c) throw new Error('Contact is not available in this host.');
    return c;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, fn));

  const fromMainWindow = (event) => {
    const win = typeof context.getMainWindow === 'function' ? context.getMainWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    return Boolean(event && event.sender && event.sender === win.webContents);
  };
  const fromAttachedDesktop = (event) => Boolean(origin && typeof origin.isLocalDesktopEvent === 'function' && origin.isLocalDesktopEvent(event));

  handle(IPC.CONTACT_LADDER_STATE, async () => ({ ok: true, state: contact().ladderState() }));

  handle(IPC.CONTACT_POLICY_GET, async () => ({ ok: true, ...contact().getPolicy() }));

  handle(IPC.CONTACT_POLICY_SET, async (_event, policy) => contact().setPolicy(policy));

  handle(IPC.PRESENCE_HEARTBEAT, async (event, payload) => {
    if (!fromMainWindow(event) && !fromAttachedDesktop(event)) {
      return { ok: false, error: 'presence:heartbeat is accepted only from the main window or an attached desktop.' };
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    if (p.focused !== undefined && typeof p.focused !== 'boolean') return { ok: false, error: 'focused must be true or false.' };
    if (p.lastInputAt !== undefined && p.lastInputAt !== null && (typeof p.lastInputAt !== 'string' || !RFC3339.test(p.lastInputAt))) {
      return { ok: false, error: 'lastInputAt must be an RFC3339 date-time.' };
    }
    return contact().heartbeat({ focused: p.focused === true, lastInputAt: p.lastInputAt || null });
  });

  handle(IPC.PRESENCE_STATUS, async () => ({ ok: true, ...contact().presenceStatus() }));
}

module.exports = { registerContactHandlers };
```

In `src/ipc/constants.js`, replace

```js
  CASE_SET_DISCLOSABLE: 'case:setDisclosable',
```

with

```js
  CASE_SET_DISCLOSABLE: 'case:setDisclosable',
  // Cases stage 4 (contact channels).
  CONTACT_LADDER_STATE: 'contact:ladderState',
  CONTACT_POLICY_GET: 'contactPolicy:get',
  CONTACT_POLICY_SET: 'contactPolicy:set',
  PRESENCE_HEARTBEAT: 'presence:heartbeat',
  PRESENCE_STATUS: 'presence:status',
```

In `src/ipc/register.js`, replace

```js
  registerCaseHandlers(ipcMain, context);
```

with

```js
  registerCaseHandlers(ipcMain, context);
  require('./contact-handlers').registerContactHandlers(ipcMain, context);
```

In `preload.js`, replace

```js
    usage: {
```

with

```js
    contact: {
      ladderState: () => ipcRenderer.invoke('contact:ladderState'),
      getPolicy: () => ipcRenderer.invoke('contactPolicy:get'),
      setPolicy: (policy) => {
        validateObject(policy, 'policy');
        return ipcRenderer.invoke('contactPolicy:set', policy);
      },
      heartbeat: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('presence:heartbeat', payload);
      },
      presenceStatus: () => ipcRenderer.invoke('presence:status')
    },
    usage: {
```

Attached desktop (F7). Run `test -f src/desktop-bridge/allowlist.js && echo present || echo absent`. If it prints `absent`, skip to Step 4. If `present`, in `src/desktop-bridge/allowlist.js` replace

```js
  'checkpoint',
  'canvas'
]);
```

with

```js
  'checkpoint',
  'canvas',
  // Cases stage 4: the ladder state, the contact policy editor and heartbeats.
  'contact',
  'contactPolicy',
  'presence'
]);
```

and in `tests/desktop-bridge-allowlist.test.js` replace

```js
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas']);
```

with

```js
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas', 'contact', 'contactPolicy', 'presence']);
```

(If an earlier stage already appended domains after `'canvas'`, add the three names after the last entry in both files instead.)

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contact-ipc.test.js tests/ipc-contract.test.js tests/preload-validation.test.js`
Expected: PASS, `# fail 0`. If F7 is present, also run `node --test tests/desktop-bridge-allowlist.test.js` — PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/contact-handlers.js src/ipc/constants.js src/ipc/register.js preload.js tests/contact-ipc.test.js
git add src/desktop-bridge/allowlist.js tests/desktop-bridge-allowlist.test.js 2>/dev/null || true
git commit -m "feat(contact): contact IPC, preload bridge and attached-desktop proxying

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The Questions section in the desktop app

**Files:**
- Modify: `index.html` (one line before `      <div class="chat-list" id="chat-list">`), `renderer.js` (one block after `initMeshHandlers();`, before `/* --- Onboarding Wizard ------------------------------------- */`), `styles.css` (append at the end)
- Test: `tests/e2e/questions.test.js`

**Interfaces:**
- Consumes: preload `window.electron.cases.questions`, `.answerQuestion`, `.acknowledgeBriefing`, `.onChanged` (C2); `window.electron.contact.*` (Task 14); the renderer's `createLogger`.
- Produces: `renderQuestionsSection()`, `initQuestionsSection()`, `sendPresenceHeartbeat(force)`, `ladderToText(steps)`, `textToLadder(text)`, `formatLadderState(state)`. DOM: `#questions-section`, `#questions-presence-dot` (`.is-here` / `.is-elsewhere` / `.is-away`), `#questions-list`; each card `.questions-card[data-question-id][data-case-id]` with `.questions-text`, `.questions-option[data-option-id]`, `.questions-input`, `.questions-answer` (or `.questions-ack` for a briefing), `.questions-ladder`; `#questions-away-set` / `#questions-away-clear`; `#contact-policy-editor` with `#contact-ladder-<urgency>`, `#contact-quiet-start`, `#contact-quiet-end`, `#contact-breakthrough-<urgency>`, `#contact-digest-channel`, `#contact-digest-at`, `#contact-policy-save`. All text is set with `textContent`.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/questions.test.js`:

```js
// tests/e2e/questions.test.js — cases stage 4 §3.8: a seeded question appears
// in #questions-section, is answered inline, and disappears.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { CaseStore } = require('../../src/cases/case-store');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: questions section', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  let caseDir;
  const savedRoot = process.env.KL_CASES_ROOT;
  const record = {
    id: 'q-0001', kind: 'question', caseId: null, text: 'Is the well on the lakeside lot shared with the neighbour?',
    options: [], urgency: 'high', createdAt: new Date().toISOString(), expiresAt: null, defaultOnSilence: 'hold',
    deliveries: [], payload: { type: 'ask', mcpAnswerable: true }, answer: null, closed: null, notes: []
  };

  before(async () => {
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-questions-'));
    process.env.KL_CASES_ROOT = casesRoot;
    const info = await new CaseStore({ root: casesRoot }).create({ title: 'E2E questions lot', objective: 'Sell the lot' });
    caseDir = info.dir;
    fs.mkdirSync(path.join(caseDir, '.kl', 'questions'), { recursive: true });
    fs.writeFileSync(path.join(caseDir, '.kl', 'questions', 'q-0001.json'), JSON.stringify({ ...record, caseId: info.id }));
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('shows the seeded question, answers it inline, and the answer becomes an owner fact', async () => {
    await evaluate(ctx, `renderQuestionsSection(); true`);
    await waitFor(ctx, `!!document.querySelector('#questions-section [data-question-id="q-0001"]')`, 20000);
    const shown = await evaluate(ctx, `document.querySelector('#questions-section [data-question-id="q-0001"] .questions-text').textContent`);
    assert.strictEqual(shown, record.text);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('questions-presence-dot')`), true);

    await evaluate(ctx, `(() => {
      const card = document.querySelector('#questions-section [data-question-id="q-0001"]');
      card.querySelector('.questions-input').value = 'Yes, with the north lot';
      card.querySelector('.questions-answer').click();
      return true;
    })()`);

    let fact = null;
    for (let i = 0; i < 100 && !fact; i += 1) {
      const lines = fs.readFileSync(path.join(caseDir, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fact = lines.find((f) => f.source?.kind === 'question' && f.source.ref === 'q-0001') || null;
      if (!fact) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fact, 'the answer became a fact');
    assert.strictEqual(fact.provenance, 'user');
    await waitFor(ctx, `!document.querySelector('#questions-section [data-question-id="q-0001"]')`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js`
Expected: FAIL — `renderQuestionsSection is not defined` (the evaluate call rejects), then the `waitFor` on `#questions-section` times out.

- [ ] **Step 3: Implement**

In `index.html`, replace

```html
      <div class="chat-list" id="chat-list">
```

with

```html
      <div class="questions-section" id="questions-section" aria-label="Questions"></div>
      <div class="chat-list" id="chat-list">
```

In `renderer.js`, replace

```js
initMeshHandlers();

/* --- Onboarding Wizard ------------------------------------- */
```

with

```js
initMeshHandlers();
/* --- Cases stage 4: questions across cases, presence and the contact policy
   (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.8) --- */
const questionsLog = createLogger('questions');
const QUESTION_URGENCY_RANK = { high: 0, normal: 1, low: 2 };
const CONTACT_LADDER_URGENCIES = ['low', 'normal', 'high'];
let questionsLastInputAt = Date.now();
let questionsLastHeartbeatAt = 0;
let questionsRendering = null;

function questionsEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function questionsButton(text, className = 'btn questions-btn') {
  const b = questionsEl('button', className, text);
  b.type = 'button';
  return b;
}

function formatLadderState(state) {
  if (!state) return '';
  if (state.exhausted) return 'exhausted';
  if (state.expired) return 'expired';
  if (state.nextChannel && state.nextAt) {
    const at = new Date(state.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `next: ${state.nextChannel} at ${at}`;
  }
  const last = (state.attempts || [])[state.attempts.length - 1];
  return last ? `${last.channel} ${last.outcome}` : '';
}

// "present, telegram@30, email@240, email@0+digest" ⇄ ladder steps.
function ladderToText(steps) {
  return (steps || []).map((s) => `${s.channel}${s.afterMin ? `@${s.afterMin}` : ''}${s.digest ? '+digest' : ''}`).join(', ');
}

function textToLadder(text) {
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z-]+)(?:@(\d+))?(\+digest)?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a step (use channel or channel@minutes)`);
    return { channel: m[1], ...(m[2] ? { afterMin: Number(m[2]) } : {}), ...(m[3] ? { digest: true } : {}) };
  });
}

function renderQuestionCard(q, ladderState, { refresh, showError }) {
  const card = questionsEl('div', `questions-card questions-urgency-${q.urgency}`);
  card.dataset.questionId = q.id;
  card.dataset.caseId = q.caseId;
  card.appendChild(questionsEl('div', 'questions-case', q.caseTitle || q.caseId));
  card.appendChild(questionsEl('div', 'questions-text', q.text));
  const answer = async (payload) => {
    try {
      const r = q.kind === 'briefing'
        ? await window.electron.cases.acknowledgeBriefing({ caseId: q.caseId, questionId: q.id })
        : await window.electron.cases.answerQuestion({ caseId: q.caseId, questionId: q.id, ...payload });
      if (!r || r.ok === false) throw new Error(r?.error || 'The answer was not recorded.');
      await refresh();
    } catch (err) {
      showError(err.message);
    }
  };
  const actions = questionsEl('div', 'questions-actions');
  if (q.kind === 'briefing') {
    const ack = questionsButton('Got it');
    ack.classList.add('questions-ack');
    ack.addEventListener('click', () => answer({}));
    actions.appendChild(ack);
  } else {
    for (const option of q.options || []) {
      const b = questionsButton(option.label);
      b.classList.add('questions-option');
      b.dataset.optionId = option.id;
      b.addEventListener('click', () => answer({ optionId: option.id }));
      actions.appendChild(b);
    }
    const input = questionsEl('input', 'questions-input');
    input.type = 'text';
    input.placeholder = 'Answer…';
    const send = questionsButton('Answer');
    send.classList.add('questions-answer');
    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (text) answer({ text });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send.click(); });
    actions.append(input, send);
  }
  card.appendChild(actions);
  const ladderText = formatLadderState(ladderState);
  if (ladderText) card.appendChild(questionsEl('div', 'questions-ladder', ladderText));
  return card;
}

function renderAwayControls(policy, { save, showError }) {
  const row = questionsEl('div', 'questions-away');
  const awayActive = policy.away && Date.parse(policy.away.until) > Date.now();
  if (awayActive) {
    row.appendChild(questionsEl('span', 'questions-away-note', `Away (${policy.away.mode}) until ${new Date(policy.away.until).toLocaleString()}`));
    const back = questionsButton("I'm back");
    back.id = 'questions-away-clear';
    back.addEventListener('click', () => save({ ...policy, away: null }).catch((err) => showError(err.message)));
    row.appendChild(back);
    return row;
  }
  const mode = questionsEl('select', 'questions-away-mode');
  for (const m of ['email-only', 'in-app-only']) {
    const o = questionsEl('option', '', m);
    o.value = m;
    mode.appendChild(o);
  }
  const until = questionsEl('input', 'questions-away-until');
  until.type = 'datetime-local';
  const go = questionsButton('Away');
  go.id = 'questions-away-set';
  go.addEventListener('click', () => {
    const t = Date.parse(until.value);
    if (!Number.isFinite(t) || t <= Date.now()) {
      showError('Pick a time in the future.');
      return;
    }
    save({ ...policy, away: { mode: mode.value, until: new Date(t).toISOString() } }).catch((err) => showError(err.message));
  });
  row.append(mode, until, go);
  return row;
}

function renderContactPolicyEditor(policy, channels, { save, showError }) {
  const details = questionsEl('details', 'questions-policy');
  details.id = 'contact-policy-editor';
  details.appendChild(questionsEl('summary', '', 'Contact policy'));
  const inputs = {};
  for (const u of CONTACT_LADDER_URGENCIES) {
    const label = questionsEl('label', 'questions-policy-row', `${u} `);
    const input = questionsEl('input', 'questions-policy-ladder');
    input.type = 'text';
    input.id = `contact-ladder-${u}`;
    input.value = ladderToText(policy.ladders[u]);
    label.appendChild(input);
    details.appendChild(label);
    inputs[u] = input;
  }
  const quiet = questionsEl('label', 'questions-policy-row', 'Quiet hours ');
  const qStart = questionsEl('input', 'questions-policy-time');
  qStart.type = 'time';
  qStart.id = 'contact-quiet-start';
  qStart.value = policy.quietHours ? policy.quietHours.start : '';
  const qEnd = questionsEl('input', 'questions-policy-time');
  qEnd.type = 'time';
  qEnd.id = 'contact-quiet-end';
  qEnd.value = policy.quietHours ? policy.quietHours.end : '';
  quiet.append(qStart, document.createTextNode(' – '), qEnd);
  details.appendChild(quiet);
  const breakthrough = questionsEl('div', 'questions-policy-row', 'Break through quiet hours: ');
  const through = {};
  for (const u of CONTACT_LADDER_URGENCIES) {
    const box = questionsEl('input');
    box.type = 'checkbox';
    box.id = `contact-breakthrough-${u}`;
    box.checked = (policy.quietHours?.breakthrough || ['high']).includes(u);
    const l = questionsEl('label', 'questions-policy-check', ` ${u} `);
    l.prepend(box);
    breakthrough.appendChild(l);
    through[u] = box;
  }
  details.appendChild(breakthrough);
  const digest = questionsEl('label', 'questions-policy-row', 'Daily digest ');
  const dChannel = questionsEl('input', 'questions-policy-digest');
  dChannel.type = 'text';
  dChannel.id = 'contact-digest-channel';
  dChannel.placeholder = 'off';
  dChannel.value = policy.digest ? policy.digest.channel : '';
  const dAt = questionsEl('input', 'questions-policy-time');
  dAt.type = 'time';
  dAt.id = 'contact-digest-at';
  dAt.value = policy.digest ? policy.digest.at : '08:00';
  digest.append(dChannel, document.createTextNode(' at '), dAt);
  details.appendChild(digest);
  const status = questionsEl('ul', 'questions-policy-channels');
  for (const [id, s] of Object.entries(channels || {})) {
    const text = s.configured ? `${id}: ready` : `${id}: ${s.enabled ? 'not configured' : 'off'}${s.reason ? ` (${s.reason})` : ''}`;
    status.appendChild(questionsEl('li', s.configured ? 'is-ready' : 'is-off', text));
  }
  details.appendChild(status);
  const saveBtn = questionsButton('Save contact policy');
  saveBtn.id = 'contact-policy-save';
  saveBtn.addEventListener('click', async () => {
    try {
      const next = { ...policy, ladders: {} };
      for (const u of CONTACT_LADDER_URGENCIES) next.ladders[u] = textToLadder(inputs[u].value);
      next.quietHours = qStart.value && qEnd.value
        ? { start: qStart.value, end: qEnd.value, breakthrough: CONTACT_LADDER_URGENCIES.filter((u) => through[u].checked) }
        : null;
      next.digest = dChannel.value.trim() ? { channel: dChannel.value.trim(), at: dAt.value || '08:00' } : null;
      await save(next);
    } catch (err) {
      showError(err.message);
    }
  });
  details.appendChild(saveBtn);
  return details;
}

async function renderQuestionsSection() {
  const section = document.getElementById('questions-section');
  if (!section || !window.electron?.cases?.questions || !window.electron?.contact) return;
  if (questionsRendering) return questionsRendering;
  questionsRendering = (async () => {
    const [q, ladder, presence, policy] = await Promise.all([
      window.electron.cases.questions({}).catch((err) => ({ ok: false, error: err.message })),
      window.electron.contact.ladderState().catch(() => ({ ok: false })),
      window.electron.contact.presenceStatus().catch(() => ({ ok: false })),
      window.electron.contact.getPolicy().catch(() => ({ ok: false }))
    ]);
    const openPolicy = document.getElementById('contact-policy-editor')?.open === true;
    section.replaceChildren();
    const error = questionsEl('div', 'questions-error');
    error.hidden = true;
    const showError = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const refresh = () => renderQuestionsSection();
    const save = async (next) => {
      const r = await window.electron.contact.setPolicy(next);
      if (!r || r.ok === false) throw new Error(r?.error || 'The contact policy was not saved.');
      await refresh();
    };

    const header = questionsEl('div', 'questions-header');
    const dot = questionsEl('span', 'questions-presence-dot');
    dot.id = 'questions-presence-dot';
    const here = presence.ok ? presence.presentChannel : null;
    dot.classList.add(here === 'in-app' ? 'is-here' : (here ? 'is-elsewhere' : 'is-away'));
    dot.title = here ? `Reaching you on ${here}` : 'Not present on any channel';
    header.append(dot, questionsEl('span', 'questions-title', 'Questions'));
    section.appendChild(header);
    if (policy.ok) section.appendChild(renderAwayControls(policy.policy, { save, showError }));

    const list = questionsEl('div', 'questions-list');
    list.id = 'questions-list';
    const states = ladder.ok ? ladder.state : {};
    const questions = (q.ok ? q.questions : [])
      .slice()
      .sort((a, b) => (QUESTION_URGENCY_RANK[a.urgency] ?? 1) - (QUESTION_URGENCY_RANK[b.urgency] ?? 1)
        || String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const question of questions) {
      list.appendChild(renderQuestionCard(question, states[`${question.caseId}/${question.id}`], { refresh, showError }));
    }
    if (!questions.length) list.appendChild(questionsEl('div', 'questions-empty', 'No open questions.'));
    section.appendChild(list);
    if (policy.ok) {
      const editor = renderContactPolicyEditor(policy.policy, policy.channels, { save, showError });
      editor.open = openPolicy;
      section.appendChild(editor);
    }
    section.appendChild(error);
    if (!q.ok && q.error) showError(q.error);
  })().catch((err) => questionsLog.warn(`Questions section failed: ${err.message}`)).finally(() => {
    questionsRendering = null;
  });
  return questionsRendering;
}

function sendPresenceHeartbeat(force = false) {
  if (!window.electron?.contact?.heartbeat) return;
  const now = Date.now();
  if (!force && now - questionsLastHeartbeatAt < 30000) return;
  questionsLastHeartbeatAt = now;
  window.electron.contact.heartbeat({ focused: document.hasFocus(), lastInputAt: new Date(questionsLastInputAt).toISOString() })
    .catch((err) => questionsLog.debug(`heartbeat failed: ${err.message}`));
}

function initQuestionsSection() {
  if (!document.getElementById('questions-section')) return;
  renderQuestionsSection();
  if (window.electron?.cases?.onChanged) window.electron.cases.onChanged(() => renderQuestionsSection());
  setInterval(() => renderQuestionsSection(), 60000);
  window.addEventListener('focus', () => sendPresenceHeartbeat(true));
  window.addEventListener('blur', () => sendPresenceHeartbeat(true));
  for (const name of ['keydown', 'pointerdown']) {
    window.addEventListener(name, () => {
      questionsLastInputAt = Date.now();
      sendPresenceHeartbeat(false);
    }, { capture: true, passive: true });
  }
  setInterval(() => { if (document.hasFocus()) sendPresenceHeartbeat(true); }, 60000);
  sendPresenceHeartbeat(true);
}

initQuestionsSection();

/* --- Onboarding Wizard ------------------------------------- */
```

Append to the end of `styles.css`:

```css
/* Cases stage 4: questions across cases, presence and the contact policy */
.questions-section { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); max-height: 45vh; overflow-y: auto; }
.questions-section:empty { display: none; }
.questions-header { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-primary); }
.questions-presence-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); }
.questions-presence-dot.is-here { background: var(--success); }
.questions-presence-dot.is-elsewhere { background: #d9a400; }
.questions-away, .questions-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.questions-away-note, .questions-ladder, .questions-empty { font-size: 0.8em; color: var(--text-muted); }
.questions-card { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-elevated); }
.questions-card.questions-urgency-high { border-color: var(--error); }
.questions-case { font-size: 0.8em; color: var(--text-secondary); }
.questions-text { color: var(--text-primary); white-space: pre-wrap; }
.questions-input { flex: 1; min-width: 80px; }
.questions-btn { padding: 2px 8px; font-size: 0.85em; }
.questions-error { color: var(--error); font-size: 0.85em; }
.questions-policy summary { cursor: pointer; color: var(--text-secondary); }
.questions-policy-row { display: flex; align-items: center; gap: 4px; margin: 4px 0; font-size: 0.85em; }
.questions-policy-ladder { flex: 1; font-family: var(--font-mono); }
.questions-policy-channels { margin: 4px 0; padding-left: 16px; font-size: 0.8em; color: var(--text-muted); }
.questions-policy-channels .is-ready { color: var(--success); }
```

- [ ] **Step 4: Run the tests**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js`
Expected: PASS, `# fail 0`

Run: `node --test tests/ipc-contract.test.js`
Expected: PASS, `# fail 0` (every channel the preload invokes has a handler)

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css tests/e2e/questions.test.js
git commit -m "feat(contact): Questions section with presence, away mode and the contact policy editor

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: The F2-late regression, the CLAUDE.md section and verification

**Files:**
- Modify: `tests/cases-regressions.test.js` (append one `describe` at the end), `CLAUDE.md` (append a section at the end)
- Test: `tests/cases-regressions.test.js`

**Interfaces:**
- Consumes: everything above; the file's existing `tmp`, `CaseRuntime`, `fs`, `path`, `assert`, `describe`, `it`.
- Produces: nothing new.

- [ ] **Step 1: Write the regression**

Append to the end of `tests/cases-regressions.test.js`:

```js
describe('F2-late: a load-bearing question reaches the owner on day 1, not day 6', () => {
  const { ContactState } = require('../src/cases/contact-state');
  const { ContactRouter } = require('../src/cases/contact');
  const { Presence } = require('../src/cases/presence');
  const { LadderEngine } = require('../src/cases/ladder');
  const { defaultPolicy } = require('../src/cases/contact-format');
  const { TelephonyChannel } = require('../src/channels/telephony-channel');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');
  const { LoopbackChannel } = require('./helpers/loopback-channel');

  const T0 = Date.parse('2026-09-25T09:00:00Z');
  const at = (ms) => new Date(T0 + ms);
  const MIN = 60 * 1000;

  async function contactWorld(adapterList) {
    let now = at(0);
    const clock = () => now;
    const root = tmp();
    const data = tmp();
    const policy = defaultPolicy();
    policy.digest = null;
    const runtime = new CaseRuntime({ root, now: clock, getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const state = new ContactState({ dir: path.join(data, 'contact'), clock });
    const adapters = new Map(adapterList);
    const presence = new Presence({ file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, interactive: () => false, isEnabled: (c) => adapters.has(c), getTimeZone: () => 'UTC' });
    const router = new ContactRouter({ state, runtime, adapters, presence, clock, getTimeZone: () => 'UTC' });
    for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
    const ladder = new LadderEngine({ state, casesRoot: root, runtime, router, presence, getPolicy: () => policy, clock, dataDir: data });
    const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const q = runtime.createQuestion(info.id, {
      kind: 'question', urgency: 'high', text: 'Has the lot been listed before, and how?', options: [{ id: 'a', label: 'Yes, on the MLS' }, { id: 'b', label: 'Never' }],
      payload: { type: 'ask', about: { subject: 'lot', attr: 'listing-history' } }
    }, { charge: false });
    return {
      runtime, state, router, ladder, info, q,
      tick: async (ms) => { now = at(ms); return ladder.tick(now); },
      entry: () => state.ladder().entries[`${info.id}/${q.id}`],
      ownerFact: () => [...runtime.ledger(info.id).view().facts.values()].find((f) => f.source?.kind === 'question' && f.source.ref === q.id) || null
    };
  }

  it('high: absent at T0+60 s, SMS at T0+15 min, a relay reply at T0+2 h becomes a user fact on day 1', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+15550100', from: '+15550199' }) });
      const w = await contactWorld([['sms', sms]]);
      await w.tick(60 * 1000);
      assert.deepStrictEqual(w.entry().attempts.map((a) => [a.channel, a.outcome]), [['present', 'absent']]);
      await w.tick(15 * MIN);
      assert.strictEqual(relay.sent().length, 1);
      const batchToken = w.entry().attempts[1].batchToken;
      assert.match(relay.sent()[0].body.text, new RegExp(`#${batchToken}`));
      relay.pushEvent({ id: 'ev-1', type: 'inbound', channel: 'sms', from: '+15550100', to: '+15550199', text: `#${batchToken} a`, at: at(120 * MIN).toISOString() });
      const { events } = await client.events(null);
      await w.tick(120 * MIN);
      await w.router.ingestRelayEvents('main', events);
      const fact = w.ownerFact();
      assert.ok(fact, 'the owner answer is a fact');
      assert.strictEqual(fact.provenance, 'user');
      assert.strictEqual(fact.value, 'Yes, on the MLS');
      assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer.at.slice(0, 10), '2026-09-25', 'answered on day 1');
    } finally {
      await relay.close();
    }
  });

  it('normal: through the loopback adapter registered as telegram at T0+30 min', async () => {
    const telegram = new LoopbackChannel({ id: 'telegram', owner: '111' });
    const w = await contactWorld([['telegram', telegram]]);
    const record = w.runtime.questions(w.info.id).get(w.q.id);
    record.urgency = 'normal';
    fs.writeFileSync(path.join(w.runtime.getCase(w.info.id).dir, '.kl', 'questions', `${w.q.id}.json`), JSON.stringify(record));
    await w.tick(60 * 1000);
    await w.tick(29 * MIN);
    assert.strictEqual(telegram.sent.length, 0);
    await w.tick(30 * MIN);
    assert.strictEqual(telegram.sent.length, 1);
    await telegram.reply(w.entry().token, { optionIndex: 1 });
    assert.strictEqual(w.ownerFact().value, 'Never');
  });

  it('control: with no reachable channel the ladder ends exhausted and journaled on day 1', async () => {
    const w = await contactWorld([]);
    await w.tick(60 * 1000);
    await w.tick(15 * MIN);
    await w.tick(30 * MIN);
    assert.strictEqual(w.entry().exhausted, true);
    assert.strictEqual(w.entry().exhaustJournaled, true);
    const journal = fs.readdirSync(path.join(w.runtime.getCase(w.info.id).dir, 'journal')).filter((f) => f.endsWith('-question.md'));
    assert.ok(journal.some((f) => f.startsWith('2026-09-25')), 'journaled on day 1');
    assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer, null, 'the question stays open; nothing is guessed');
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`. This scenario pins behaviour Tasks 5–7 built; if it fails, the fault is in the task that owns that code (read its test first), not in this file.

- [ ] **Step 3: Document**

Append to the end of `CLAUDE.md`:

```markdown

## Cases: contact channels (stage 4)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage4-channels.md`.

- Every open question in every case goes up a contact ladder
  (`src/cases/ladder.js`): `settings.contactPolicy.ladders[urgency]`, or
  `case.yaml` `channels` (`call` = `voice`). One process per cases root runs
  it (`<casesRoot>/.contact.lock`); its state is `<dataDir>/contact/`
  (`ladder.json`, `deliveries.json`, `inbox.jsonl`, `presence.json`).
- Answers from any channel go through `ContactRouter.handleReply`
  (`src/cases/contact.js`) and then `CaseRuntime.answerQuestion`. An adapter
  sets `ownerProven` only after its own check (Telegram/Discord: private
  chat/DM with the contact owner id and that sender; email: owner address,
  live batch, topmost Authentication-Results or the `[KL-…]` token; SMS:
  owner number plus `#TOKEN`; phone app: device-signed envelope). Approvals
  are never answered by email, SMS or voice. A different second answer never
  overwrites; it becomes a follow-up question.
- Case code that sends to a channel uses `ContactRouter.sendExternal`, which
  runs C3's outbound gate for anyone but the owner and sends `rendered`.
- Service mode: the owner identity and addresses come only from the admin
  `service.json` `contact` block; relay tokens and mailbox passwords live in
  the vault under `contact.` (the `Vault` tool refuses them). Tests use
  `tests/helpers/loopback-channel.js` and the fake relay/SMTP helpers, never a
  real network; `KING_LOUIE_CONTACT_TICK_MS` shortens the tick.
```

- [ ] **Step 4: Verify the stage so far**

Run: `npm test`
Expected: PASS, `# fail 0`

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`

Run: `git diff main -- src tests preload.js renderer.js styles.css index.html CLAUDE.md | grep -nE "^\+.*([A-Za-z]:\\\\Users|/Users/|/home/)"`
Expected: no output (fixtures use `example.com`, `+15550100`/`+15550199`, `Lakeside lot`).

Run: `git diff main -- package.json`
Expected: exactly three added lines under `dependencies`: `imapflow`, `mailparser`, `nodemailer`.

- [ ] **Step 5: Commit**

```bash
git add tests/cases-regressions.test.js CLAUDE.md
git commit -m "test(contact): F2-late regression; document contact channels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Part 3 hand-off

Parts 1–3 complete the stage for the desktop and the service without the phone app. Part 4 (`docs/superpowers/plans/2026-09-23-cases-stage4-channels-part4.md`, wave 3) starts only after fleet stage 3 (F3) has merged, and depends on these exports existing exactly as named:

| Module | Exports |
|---|---|
| `src/cases/contact-host.js` | `createContactHost` (`api.startMobile(approvals)` is called from `start()` when `approvals` is passed and the method exists; its closure has `router`, `presence`, `built`, `wire`, `channelSettings`, `clock`), `defaultGetGate` |
| `src/cases/contact-settings.js` | `CHANNEL_DEFAULTS` (includes `mobile: { enabled: false }`), `mergeContactSettings`, `validateContactConfig`, `resolveContactConfig` |
| `src/cases/contact-state.js` | `ContactState#resolve(token, { channel })` preferring the delivery on `channel` |
| `src/core/create-core.js` | `createCore` passes `approvals: deps.approvals || null` to the contact host; `context.getContact()` |
| `src/ipc/contact-handlers.js` | `registerContactHandlers` |
| `src/webhooks/webhook-server.js` | `WebhookServer#setContactRelayHandler` |

