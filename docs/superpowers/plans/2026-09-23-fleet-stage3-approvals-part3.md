# Fleet Stage 3: Signed approvals, relay and mobile app — Implementation Plan (Part 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the relay (`king-louie-service relay`) with its phone API, node hub, mailbox and pluggable push; start phone approvals in both service profiles; and give administrators the `pair`, `enroll-device`, `device` and `relay` commands, proven end to end with real processes.
**Architecture:** Builds on Parts 1–2 (merged). New `src/frontdoor/` modules (`device-registry`, `approval-cache`, `invites`, `mailbox`, `push/*`, `phone-api`, `node-hub`, `node-methods`, `routes`, `relay`, `net`, `tls`, `extensions`) make up the relay subset of the stage 4 front door, loading no agent code. `src/approvals/service-wiring.js` (`startApprovals`, `startMcpApprovals`) is called from `src/service/run.js` for both profiles and from the `mcp` command; `src/service/commands/{io,pair,devices,relay}.js` hold the new CLI. `createCore` now runs with `remoteApprovals: 'phone'` in the agent profile.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `http`/`https`/`http2`/`crypto` for the phone API and push, `ws` through `MeshTransport`. New dependency: `qrcode` (pure JS, CLI only, spec §14).
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

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
  never decides policy. `service.json` and `node.yaml` reject unknown keys with the key
  path named (R11, R55).
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

Fleet stage 3 spec constraints:

- Envelopes are exactly `{ alg, kid, payload, sig }`; `payload` and `sig` are base64url without padding; signatures cover the JCS bytes as sent; verifiers never re-canonicalize to verify, and nodes additionally require the bytes to be canonical (`malformed` otherwise).
- Node keys: Ed25519, DER SPKI hex. Device keys: P-256 JWK with exactly `kty: 'EC'`, `crv: 'P-256'`, `x`, `y`; ES256 signatures are raw `r||s` (IEEE P1363). Device id = `d-` + base32(sha256(0x04‖x‖y))[0..16] (lowercase RFC 4648, no padding); desktops use prefix `kld-` over the 32-byte Ed25519 key.
- Request TTL default 300 s, clamped to 30–300 s (`approvers.request_ttl_s`); in phone mode `approvalTimeoutMs` = TTL + 15000. Expiry is judged on the node clock only; `signed_at` is recorded, never judged.
- An action's JCS form is at most 262144 bytes (`action_too_large`); `summary` is at most 300 characters, cut with `…`.
- Requesters return `true | false | 'timeout' | 'unavailable'`; `mapApprovalResult` runs a tool only for `=== true`. `'timeout'` and `'unavailable'` never approve.
- The service only READS `<configDir>/approvers/`; only `src/approvals/approver-admin.js`, loaded by the admin CLI, writes it. Relayed enrollments are staged in `<dataDir>/approvals/staged/` and applied by `device apply`; a verified revoke acts at once through the in-memory overlay.
- The relay's mesh listener binds only a loopback or private IP literal (`relay.mesh_listen.host must be a loopback or private IP address until the stage 4 mesh hardening lands`). Relay ports default to 8443 (phone API) and 18795 (mesh).
- Phone API: body cap 262144 bytes; device timestamps within 120 s of the relay clock (`401 clock_skew` with `server_time`); replay window 5 minutes keyed on SHA-256 of the signed string plus the device id; 10 requests/min per IP unauthenticated, 120/min per device.
- Push is a pluggable `PushSender`; `none` is the default and the fallback. Push payloads carry only `{ kind, id }` (and the node name in the alert text).
- Audit ledger: monthly segments `<dataDir>/audit/ledger-YYYY-MM.jsonl`, `hash` = hex SHA-256 over JCS(entry without `hash`), retention default 365 days (`audit.retention_days` ≥ 30). `src/events/event-ledger.js` is unchanged.
- The one new npm dependency is `qrcode` (pure JS, CLI only); a test asserts its lockfile tree has no install scripts or native builds. No new environment variables.
- F3 makes no edits to `src/ipc/*`, `preload.js`, `renderer.js`, `styles.css`, `src/core/settings.js` or `src/tools/index.js`.
- Tests that create approver sets or config dirs use temp dirs and play the administrator through injected `geteuid`/`adminUid` (and `platform: 'linux'` for the POSIX checks); fixtures use invented data and the fixed test keys in `tests/vectors/approval-v1/keys.json`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Test runs report through the spec reporter in a terminal (`ℹ fail 0`) and TAP when piped (`# fail 0`); either counts as passing.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and the test that pins each:

1. **Phone clock wrong by minutes.** Vector `response-accept-phone-clock-ahead` (Part 2, Task 10, `tests/approvals-protocol.test.js`) and "401 clock_skew then offset retry succeeds" (Part 3, Task 19, `tests/frontdoor-phone-api.test.js`).
2. **Two enrolled phones, one approves and one denies.** "first valid response decides; second gets already_decided; both audited" (Part 1, Task 9, `tests/approvals-phone-approver.test.js`).
3. **Approval arrives after the tool call was cancelled.** "abort → withdrawn; later approve → unknown_request; tool never runs" (Part 1, Task 9) and "cancel_job while awaiting withdraws the request and nothing runs" (Part 2, Task 16, `tests/mcp-stdio-approvals.test.js`).
4. **Relay down when the request is created.** "queued while down, submitted on connect, expires on node clock if the link never returns" (Part 1, Task 9).
5. **`mcp` asks for an unsafe runbook while the service is stopped.** "unavailable immediately with the service-not-running reason" (Part 2, Task 16).

## Interfaces from other stages

| Contract | What this plan uses | Until it merges |
|---|---|---|
| Program §4.21, F7 `src/core/origin.js` | `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn)`, `isLocalRequester(fn)` | Task 11 creates the module with exactly these five exports **only if the file does not exist**. If F7 merged first, Task 11 checks the five exports exist and creates nothing. |
| F6 R11 strict `node.yaml` loader (`NODE_YAML_KEYS`), `tests/examples.test.js` | `approvers` joins the allowed top-level keys | Task 20 adds `'approvers'` to `NODE_YAML_KEYS` and to `tests/examples.test.js` **only if** those exist on the branch; on `main` today neither exists and `loadNodeConfig` accepts any top-level key. |
| F6 R55 unknown-key rejection in `service.json` | the `relay` and `audit` blocks | Task 20's parsers reject unknown keys inside `relay` and `audit` themselves, naming the key path. |
| F6 `tests/helpers/stdio-mcp-client.js` (`connectStdioMcp`) | — | Not used: Task 16 drives `StdioMcpServer.executeToolCall`, the entry point the stdio transport calls, and the e2e test (Task 23) drives the real `mcp` process over stdio. |
| F4 `<configDir>/front-door.json` and `MeshTransport.connectPinned` (E7) | `RelayClient` dials through `connectPinned(frontDoor)` when both exist | Feature-detected: without either, the client dials the relay pinned by `pair`. Task 14's test supplies a transport with `connectPinned`. |
| F4 peer source for `NodeHub` (E3) | `peerSource = { list(), on('change') }` | Optional constructor argument; `null` means the registry file. |

From Parts 1–2 (merged): the hand-off tables of both parts — in particular `PhoneApprover`, `ApproverStore`/`ApproverAdmin`/`checkApproverDir`, `AuditLedger`/`verifyAuditSlice`, `verifyDeviceEnvelope`/`verifyConsoleEnrollment`, `messages.js`, `envelope.js`, `createLinkRpc`, `RelayClient`, `FileCourier`/`CourierPump`, `MeshPairing.addCode`, `MeshTransport({ listen: false })`, `StdioMcpServer({ approver, auditLedger })`, and the test helpers.

## Deviations and resolved gaps (read before starting)

Names and shapes here extend the spec's §5.2 without changing any of them.

- **Demo and test keys.** `ApproverStore.get(id)` returns any well-formed record, including `platform: 'demo'` and published test keys, so `verifyDeviceEnvelope` can report `demo_device` / `test_key` (spec steps 3–4) instead of `unknown_device`. `list()` leaves test keys out and `isActive()` is false for both unless `allowTestKeys`. The store exposes `allowTestKeys`, `refresh()`, `addToOverlay(id)`, `overlay`, `problem`; `checkApproverDir()` is the sync trust probe `doctor` shares.
- **Vectors run with `given.allow_test_keys`.** Devices A, B, C in `keys.json` are the published test keys, so every node vector says whether they are allowed (`true` except `response-reject-test-key`). Stage vectors take `input` as an array of envelopes and `expect: { results, active }`.
- **PhoneApprover additions:** `unavailableReason()` (used by `isAvailable()` and by the stdio server's `denied_by_policy: <reason>`), `ttlMs`, `nonces`, and constructor options `setTimer`/`clearTimer` and `buildRequest` (the vectors inject a fixed request). `stop()` ends pending requests as `unavailable` with a `withdrawn` status.
- **Refusal plumbing.** The phone-mode requester sets `metadata.origin` on the metadata object it is given instead of passing `{ ...m, origin }`, so the `metadata.refusal` the approver writes reaches `mapApprovalResult`. At the hook `confirm` site the result is mapped the same way but, as today, never touches the denial tracker; only the gate site records a plain `false`.
- **Children of desktop runs** inherit the mark through the requester (spec §3.7); their audit `origin.deviceId` is `null`, since the requester carries no device id.
- **Pairing record.** `store.get('approvals.relay')` also keeps the relay's mesh `peerId`, which the transport needs to recognise it. `RelayClient` takes `dataDir` (for `link.json`) instead of `store`.
- **Relay API extras.** `POST /v1/approvals/{id}/response` answers `202 { delivered: true, accepted, reason }` so the app can show `refused: <reason>`. `GET /v1/approvals?wait=` long-polls against a per-device cursor: it returns at once when anything changed since that device's last call. `Invites.claimCode(codeId, envelope)` records the phone's claim. The relay replays its device log on `relay.hello`; the mailbox is relay memory and has nothing to replay to a node.
- **Message helpers** in `src/approvals/messages.js` beyond §5.2: `phoneAuthString`, `encodeQr`/`decodeQr`, `enrollMac`/`inviteMac` (HMAC keyed with the raw 32 bytes of the base64url `code`/`secret`), `buildEnrollOpen`/`buildEnrollDone`, `validateMessage`, `parseMessage`, `registerMessageValidator(type, fn)` for F5/C4 types. `verifyConsoleEnrollment` lives in `verify-device.js`.
- **Audit.** `entriesAfter(hash)` with a hash no longer retained starts from the oldest retained entry (the slice's `anchor` tells the mirror there was a gap). `verifyAuditSlice(envelope, spkiHex)` is exported for the relay, F4's mirror and tests.
- **`mcp` process.** `startMcpApprovals()` in `service-wiring.js` builds the `mcp` side: a `FileCourier` link, a PhoneApprover and an `AuditLedger` with writer `mcp`.
- **Device state to the relay.** The service polls the admin-applied set every 5 s (`trackDeviceStates`) and sends `device.state` when an admin applies or revokes a device; `device apply` itself never talks to the relay.
- **Runbooks.** `JobManager.transition(jobId, 'awaiting_approval', 'queued')` is the one new transition and enforces `max_concurrent_jobs`; `awaiting_approval` jobs get their `AbortController` at creation.
- **Relay configuration** is normalized to `{ phoneListen, tls: { certFile, keyFile }, meshListen, publicUrl, push: { apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } } }`; `startRelay` takes that shape.
- **Windows e2e.** The service trusts `approvers/` only if it cannot write it. The e2e test runs as the same account as the service, so after enrolling the phone it denies itself write access to that directory with `icacls` (and lifts the deny before cleanup), as an installer's ACL would.
- **Plan size.** The stage is split into four plans (Node protocol core; approvals and the node link; relay, service and CLI; mobile apps), each ~4500 lines or less; each depends on the previous part's merged code.

---

### Task 17: Relay stores — devices, approval cache, invites, mailbox

**Files:**
- Create: `src/frontdoor/device-registry.js`, `src/frontdoor/approval-cache.js`, `src/frontdoor/invites.js`, `src/frontdoor/mailbox.js`
- Test: `tests/frontdoor-stores.test.js`

**Interfaces:**
- Consumes: `open`, `deviceIdFromJwk` (Part 1, Task 3); `writeFileAtomic` (Part 1, Task 7).
- Produces (program P17, P19): `new DeviceRegistry({ file, now })` → `<relayData>/relay/devices.json` and `device-log.jsonl` beside it: `get(id)`, `list()`, `register({ device_id, jwk, name, platform })` (throws `code: 'bad_device'`), `setPush(id, { platform, token } | null)`, `setNodeState(id, nodeId, state)`, `devicesForNode(nodeId)` (state `active`), `nodesForDevice(id) → [{ node_id, state }]`, `remove(id)`, `appendLog(envelope)`, `log()`. `new ApprovalCache({ now })` (an `EventEmitter`, `'change'`): `put(nodeId, envelope)`, `get(requestId) → { node_id, envelope, expires_at, status, seq } | null`, `setStatus(requestId, statusEnvelope)`, `list(nodeIds)` (kept a minute past expiry), `waitForChange(afterSeq, timeoutMs)`, `sweep()`, `seq`. `new Invites({ now })`: `openCode(codeId, nodeId, expiresAtMs)`, `getCode(codeId) → { code_id, node_id, expires_at, state: waiting|done|refused|expired, claim, enroll } | null`, `claimCode(codeId, envelope)` (throws `unknown_code`), `closeCode(codeId, state, enroll)`, `createInvite(deviceId) → { invite_id, expires_at }`, `getInvite(id)`, `claim(id, { device, mac })` (throws `unknown_invite`, `already_claimed`), `getClaim(id, deviceId)` (throws `forbidden`), `sweep()`; `TTL_MS` (10 min). `new Mailbox({ now })` (`'change'`): `registerType(prefix, { ttlMs, maxBytes = 262144 })`, `put(nodeId, envelope, { to_device }) → { seq }` (throws `type_not_routed`, `too_large`; ≤ 1000 per node), `list({ nodeIds, typePrefix, toDevice, afterSeq })`, `wait(filter, { timeoutMs ≤ 25000 })`, `sweep()`; `MAX_WAIT_MS`.

The registry is used only to authenticate API calls, address push and replay enrollments; nodes never trust it.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-stores.test.js`:

```js
// tests/frontdoor-stores.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { ApprovalCache } = require('../src/frontdoor/approval-cache');
const { Invites } = require('../src/frontdoor/invites');
const { Mailbox } = require('../src/frontdoor/mailbox');
const { seal } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function registryFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-stores-'));
  dirs.push(d);
  return path.join(d, 'relay', 'devices.json');
}

describe('DeviceRegistry', () => {
  it('registers, persists, addresses push and tracks per-node state', () => {
    const file = registryFile();
    const phone = createFakePhone({ name: 'Pixel 9' });
    const reg = new DeviceRegistry({ file });
    reg.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'Pixel 9', platform: 'android' });
    reg.setPush(phone.deviceId, { platform: 'fcm', token: 'tok-1' });
    reg.setNodeState(phone.deviceId, 'kl-aaaaaaaaaaaaaaaa', 'active');
    reg.setNodeState(phone.deviceId, 'kl-bbbbbbbbbbbbbbbb', 'staged');
    const reloaded = new DeviceRegistry({ file });
    assert.deepEqual(reloaded.get(phone.deviceId).push, { platform: 'fcm', token: 'tok-1' });
    assert.deepEqual(reloaded.devicesForNode('kl-aaaaaaaaaaaaaaaa').map((d) => d.device_id), [phone.deviceId]);
    assert.deepEqual(reloaded.devicesForNode('kl-bbbbbbbbbbbbbbbb'), []);
    assert.deepEqual(reloaded.nodesForDevice(phone.deviceId), [{ node_id: 'kl-aaaaaaaaaaaaaaaa', state: 'active' }, { node_id: 'kl-bbbbbbbbbbbbbbbb', state: 'staged' }]);
    assert.throws(() => reg.register({ device_id: createFakePhone().deviceId, jwk: phone.jwk, name: 'x', platform: 'ios' }), (e) => e.code === 'bad_device');
  });

  it('keeps an append-only device log', () => {
    const reg = new DeviceRegistry({ file: registryFile() });
    const a = createFakePhone();
    const b = createFakePhone();
    reg.appendLog(a.enroll({ device: b.device() }));
    reg.appendLog(a.revoke(b.deviceId));
    assert.equal(reg.log().length, 2);
  });
});

describe('ApprovalCache', () => {
  it('holds requests per node, attaches statuses and signals change', async () => {
    let now = Date.parse('2026-09-23T18:00:00.000Z');
    const cache = new ApprovalCache({ now: () => now });
    const node = testNodeIdentity();
    const { envelope, message } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null), now });
    const waiting = cache.waitForChange(0, 1000);
    cache.put(node.nodeId, envelope);
    assert.equal(await waiting, 1);
    assert.deepEqual(cache.list([node.nodeId]).map((e) => e.request_id), [message.request_id]);
    assert.deepEqual(cache.list(['kl-other']), []);
    const status = m.buildStatus({ identity: node, requestId: message.request_id, state: 'approved', now });
    assert.equal(cache.setStatus(message.request_id, status), true);
    assert.equal(cache.get(message.request_id).status, status);
    now += 300000 + 61000;
    cache.sweep();
    assert.equal(cache.get(message.request_id), null);
  });
});

describe('Invites', () => {
  it('codes: open, claim, close; expire after ten minutes', () => {
    let now = 0;
    const inv = new Invites({ now: () => now });
    const codeId = crypto.randomBytes(16).toString('base64url');
    inv.openCode(codeId, 'kl-aaaaaaaaaaaaaaaa', 600000);
    assert.equal(inv.getCode(codeId).state, 'waiting');
    inv.claimCode(codeId, { alg: 'ES256' });
    inv.closeCode(codeId, 'done', { alg: 'Ed25519' });
    assert.equal(inv.getCode(codeId).state, 'done');
    const other = crypto.randomBytes(16).toString('base64url');
    inv.openCode(other, 'kl-aaaaaaaaaaaaaaaa', 600000);
    now = 600001;
    assert.equal(inv.getCode(other).state, 'expired');
    assert.throws(() => inv.claimCode(other, {}), (e) => e.code === 'unknown_code');
  });

  it('invites are single-use and readable only by the inviter', () => {
    const inv = new Invites();
    const a = createFakePhone();
    const b = createFakePhone();
    const { invite_id: inviteId } = inv.createInvite(a.deviceId);
    assert.equal(inv.getClaim(inviteId, a.deviceId), null);
    inv.claim(inviteId, { device: b.device(), mac: 'm' });
    assert.throws(() => inv.claim(inviteId, { device: b.device(), mac: 'm' }), (e) => e.code === 'already_claimed');
    assert.deepEqual(inv.getClaim(inviteId, a.deviceId).device, b.device());
    assert.throws(() => inv.getClaim(inviteId, b.deviceId), (e) => e.code === 'forbidden');
    assert.throws(() => inv.claim('nope', { device: b.device(), mac: 'm' }), (e) => e.code === 'unknown_invite');
  });
});

describe('Mailbox', () => {
  const node = testNodeIdentity();
  const msg = (type, extra = {}) => seal({ v: 1, type, node_id: node.nodeId, nonce: m.randomNonce(), ...extra }, node.signer);

  it('routes only registered types, filters by node, type, device and seq', () => {
    const box = new Mailbox();
    assert.throws(() => box.put(node.nodeId, msg('kl.lease.offer')), (e) => e.code === 'type_not_routed');
    box.registerType('kl.lease.', { ttlMs: 60000 });
    box.registerType('kl.question.', { ttlMs: 60000 });
    const { seq } = box.put(node.nodeId, msg('kl.lease.offer'));
    box.put(node.nodeId, msg('kl.question.ask'), { to_device: 'd-aaaaaaaaaaaaaaaa' });
    assert.equal(box.list({ nodeIds: [node.nodeId], typePrefix: 'kl.lease.' }).length, 1);
    assert.equal(box.list({ nodeIds: [node.nodeId], toDevice: 'd-bbbbbbbbbbbbbbbb' }).length, 1);
    assert.equal(box.list({ nodeIds: [node.nodeId], toDevice: 'd-aaaaaaaaaaaaaaaa' }).length, 2);
    assert.equal(box.list({ nodeIds: [node.nodeId], afterSeq: seq, toDevice: 'd-aaaaaaaaaaaaaaaa' }).length, 1);
    assert.equal(box.list({ nodeIds: ['kl-other'] }).length, 0);
  });

  it('wait resolves on a new message and caps the wait at 25 s', async () => {
    const box = new Mailbox();
    box.registerType('kl.lease.', { ttlMs: 60000 });
    const pending = box.wait({ nodeIds: [node.nodeId] }, { timeoutMs: 1000 });
    box.put(node.nodeId, msg('kl.lease.offer'));
    assert.equal((await pending).length, 1);
    assert.deepEqual(await box.wait({ nodeIds: ['kl-other'] }, { timeoutMs: 10 }), []);
  });

  it('drops messages past their ttl and refuses oversize ones', () => {
    let now = 0;
    const box = new Mailbox({ now: () => now });
    box.registerType('kl.lease.', { ttlMs: 1000, maxBytes: 200 });
    box.put(node.nodeId, msg('kl.lease.offer'));
    assert.throws(() => box.put(node.nodeId, msg('kl.lease.offer', { pad: 'x'.repeat(300) })), (e) => e.code === 'too_large');
    now = 1001;
    assert.equal(box.list({ nodeIds: [node.nodeId] }).length, 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/frontdoor-stores.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/device-registry'`.

- [ ] **Step 3: Implement**

Create `src/frontdoor/device-registry.js`:

```js
// The relay's view of phones: who may call the phone API, where to push, and
// the log of every enrollment and revocation it relayed (replayed to nodes on
// each relay.hello). Nodes never trust any of it; they verify signatures.
const fs = require('fs');
const path = require('path');
const { deviceIdFromJwk } = require('../approvals/envelope');
const { writeFileAtomic } = require('../approvals/approver-store');

const PLATFORMS = ['ios', 'android', 'demo'];

class DeviceRegistry {
  constructor({ file, now = Date.now } = {}) {
    if (!file) throw new TypeError('DeviceRegistry needs a file');
    this.file = file;
    this.logFile = path.join(path.dirname(file), 'device-log.jsonl');
    this.now = now;
    this.devices = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const record of Object.values(parsed.devices || {})) this.devices.set(record.device_id, record);
    } catch {
      // No registry yet.
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ devices: Object.fromEntries(this.devices) }, null, 2)}\n`);
  }

  get(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  list() {
    return [...this.devices.values()];
  }

  register({ device_id: deviceId, jwk, name, platform }) {
    if (deviceIdFromJwk(jwk) !== deviceId) throw Object.assign(new Error('device_id does not derive from the key'), { code: 'bad_device' });
    if (!PLATFORMS.includes(platform)) throw Object.assign(new Error('unknown platform'), { code: 'bad_device' });
    const existing = this.devices.get(deviceId);
    const record = {
      device_id: deviceId,
      jwk,
      name: String(name).slice(0, 64),
      platform,
      push: existing ? existing.push : null,
      nodes: existing ? existing.nodes : {},
      registered_at: existing ? existing.registered_at : new Date(this.now()).toISOString()
    };
    this.devices.set(deviceId, record);
    this._save();
    return record;
  }

  setPush(deviceId, push) {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    record.push = push ? { platform: push.platform, token: push.token } : null;
    this._save();
    return record;
  }

  setNodeState(deviceId, nodeId, state) {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    record.nodes = { ...record.nodes, [nodeId]: state };
    this._save();
    return record;
  }

  // Devices a node's approval requests are pushed to and shown to.
  devicesForNode(nodeId) {
    return this.list().filter((d) => d.nodes && d.nodes[nodeId] === 'active');
  }

  nodesForDevice(deviceId) {
    const record = this.devices.get(deviceId);
    return record ? Object.entries(record.nodes || {}).map(([node_id, state]) => ({ node_id, state })) : [];
  }

  remove(deviceId) {
    const had = this.devices.delete(deviceId);
    if (had) this._save();
    return had;
  }

  appendLog(envelope) {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.logFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  }

  log() {
    try {
      return fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

module.exports = { DeviceRegistry };
```

Create `src/frontdoor/approval-cache.js`:

```js
// Signed approval requests the relay holds until they expire, with their last
// node-signed status. Memory only: after a relay restart the nodes resubmit.
const { EventEmitter } = require('events');
const { open } = require('../approvals/envelope');

const GRACE_MS = 60000;

class ApprovalCache extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.items = new Map();
    this.seq = 0;
  }

  put(nodeId, envelope) {
    const { message } = open(envelope);
    const existing = this.items.get(message.request_id);
    this.seq += 1;
    const entry = {
      request_id: message.request_id,
      node_id: nodeId,
      envelope,
      expires_at: Date.parse(message.expires_at),
      status: existing ? existing.status : null,
      seq: this.seq
    };
    this.items.set(message.request_id, entry);
    this.emit('change', this.seq);
    return entry;
  }

  get(requestId) {
    const entry = this.items.get(requestId);
    return entry ? { node_id: entry.node_id, envelope: entry.envelope, expires_at: entry.expires_at, status: entry.status, seq: entry.seq } : null;
  }

  setStatus(requestId, statusEnvelope) {
    const entry = this.items.get(requestId);
    if (!entry) return false;
    this.seq += 1;
    entry.status = statusEnvelope;
    entry.seq = this.seq;
    this.emit('change', this.seq);
    return true;
  }

  // Unexpired requests of these nodes (and, for a minute after expiry, the
  // expired ones with their status, so a phone sees how they ended).
  list(nodeIds) {
    const wanted = new Set(nodeIds);
    const now = this.now();
    return [...this.items.values()]
      .filter((e) => wanted.has(e.node_id) && now <= e.expires_at + GRACE_MS)
      .sort((a, b) => a.seq - b.seq);
  }

  // Resolves once anything newer than afterSeq exists, or after timeoutMs.
  waitForChange(afterSeq, timeoutMs) {
    if (this.seq > afterSeq || timeoutMs <= 0) return Promise.resolve(this.seq);
    return new Promise((resolve) => {
      const onChange = (seq) => { clearTimeout(timer); resolve(seq); };
      const timer = setTimeout(() => { this.removeListener('change', onChange); resolve(this.seq); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.once('change', onChange);
    });
  }

  sweep() {
    const now = this.now();
    for (const [id, e] of this.items) if (now > e.expires_at + GRACE_MS) this.items.delete(id);
  }
}

module.exports = { ApprovalCache };
```

Create `src/frontdoor/invites.js`:

```js
// Console enrollment codes (opened by a node with a signed kl.enroll.open)
// and single-use invites from one phone to the next, ten minutes each. The
// ids are 16 random bytes: knowing one is the credential for its routes.
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const KEEP_MS = 10 * 60 * 1000;

const err = (code, message) => Object.assign(new Error(message || code), { code });

class Invites {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.codes = new Map();
    this.invites = new Map();
  }

  openCode(codeId, nodeId, expiresAt) {
    this.codes.set(codeId, { code_id: codeId, node_id: nodeId, expires_at: expiresAt, state: 'waiting', claim: null, enroll: null });
  }

  // { code_id, node_id, expires_at, state: waiting|done|refused|expired, claim, enroll } or null.
  getCode(codeId) {
    const code = this.codes.get(codeId);
    if (!code || this.now() > code.expires_at + KEEP_MS) return null;
    const expired = code.state === 'waiting' && this.now() > code.expires_at;
    return { ...code, state: expired ? 'expired' : code.state };
  }

  // The phone's self-signed enrollment for an open code.
  claimCode(codeId, envelope) {
    const code = this.getCode(codeId);
    if (!code || code.state !== 'waiting') throw err('unknown_code', 'no open enrollment code with that id');
    this.codes.get(codeId).claim = envelope;
    return code;
  }

  closeCode(codeId, state, enroll = null) {
    const code = this.codes.get(codeId);
    if (!code) return false;
    code.state = state;
    code.enroll = enroll;
    return true;
  }

  createInvite(deviceId) {
    const inviteId = crypto.randomBytes(16).toString('base64url');
    const expiresAt = this.now() + TTL_MS;
    this.invites.set(inviteId, { invite_id: inviteId, inviter: deviceId, expires_at: expiresAt, claim: null });
    return { invite_id: inviteId, expires_at: new Date(expiresAt).toISOString() };
  }

  getInvite(inviteId) {
    const invite = this.invites.get(inviteId);
    if (!invite || this.now() > invite.expires_at) return null;
    return invite;
  }

  // Single use. The relay does not check `mac`; the inviting phone does.
  claim(inviteId, { device, mac }) {
    const invite = this.getInvite(inviteId);
    if (!invite) throw err('unknown_invite', 'no open invite with that id');
    if (invite.claim) throw err('already_claimed', 'this invite was already claimed');
    invite.claim = { device, mac, claimed_at: new Date(this.now()).toISOString() };
    return invite.claim;
  }

  getClaim(inviteId, deviceId) {
    const invite = this.getInvite(inviteId);
    if (!invite) throw err('unknown_invite', 'no open invite with that id');
    if (invite.inviter !== deviceId) throw err('forbidden', 'only the inviting device can read the claim');
    return invite.claim;
  }

  sweep() {
    const now = this.now();
    for (const [id, c] of this.codes) if (now > c.expires_at + KEEP_MS) this.codes.delete(id);
    for (const [id, i] of this.invites) if (now > i.expires_at) this.invites.delete(id);
  }
}

module.exports = { Invites, TTL_MS };
```

Create `src/frontdoor/mailbox.js`:

```js
// Node-signed messages sent with link.send (F5 leases, C4 questions), held in
// memory for phones to fetch. A type is routed only once a consumer has
// registered its prefix (src/frontdoor/extensions.js).
const { EventEmitter } = require('events');
const { open } = require('../approvals/envelope');

const PER_NODE = 1000;
const MAX_WAIT_MS = 25000;

class Mailbox extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.types = new Map();
    this.items = [];
    this.seq = 0;
  }

  registerType(prefix, { ttlMs, maxBytes = 262144 } = {}) {
    if (!prefix || !Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError('registerType(prefix, { ttlMs }) needs a prefix and a positive ttlMs');
    this.types.set(prefix, { ttlMs, maxBytes });
  }

  _typeConfig(type) {
    for (const [prefix, config] of this.types) if (String(type).startsWith(prefix)) return config;
    return null;
  }

  put(nodeId, envelope, { to_device: toDevice = null } = {}) {
    const { message, bytes } = open(envelope);
    const config = this._typeConfig(message.type);
    if (!config) throw Object.assign(new Error(`no consumer routes ${message.type}`), { code: 'type_not_routed' });
    if (bytes.length > config.maxBytes) throw Object.assign(new Error(`${message.type} is over ${config.maxBytes} bytes`), { code: 'too_large' });
    this.seq += 1;
    this.items.push({ seq: this.seq, node_id: nodeId, type: message.type, envelope, to_device: toDevice, expires_at: this.now() + config.ttlMs });
    const mine = this.items.filter((i) => i.node_id === nodeId);
    if (mine.length > PER_NODE) {
      const drop = new Set(mine.slice(0, mine.length - PER_NODE).map((i) => i.seq));
      this.items = this.items.filter((i) => !drop.has(i.seq));
    }
    this.emit('change', this.seq);
    return { seq: this.seq };
  }

  // A message for a specific device (`to_device`) is listed only for it.
  list({ nodeIds, typePrefix = null, toDevice = null, afterSeq = 0 } = {}) {
    const wanted = new Set(nodeIds || []);
    const now = this.now();
    return this.items
      .filter((i) => wanted.has(i.node_id) && i.seq > afterSeq && now <= i.expires_at)
      .filter((i) => !typePrefix || i.type.startsWith(typePrefix))
      .filter((i) => i.to_device === null || i.to_device === toDevice)
      .map(({ seq, node_id, envelope, to_device, expires_at }) => ({ seq, node_id, envelope, to_device, expires_at: new Date(expires_at).toISOString() }));
  }

  // Long poll: resolves with the list as soon as it is non-empty, else [] at timeout.
  wait(filter, { timeoutMs = MAX_WAIT_MS } = {}) {
    const first = this.list(filter);
    const limit = Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS);
    if (first.length || limit === 0) return Promise.resolve(first);
    return new Promise((resolve) => {
      const onChange = () => {
        const items = this.list(filter);
        if (!items.length) return;
        this.removeListener('change', onChange);
        clearTimeout(timer);
        resolve(items);
      };
      const timer = setTimeout(() => { this.removeListener('change', onChange); resolve([]); }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      this.on('change', onChange);
    });
  }

  sweep() {
    const now = this.now();
    this.items = this.items.filter((i) => now <= i.expires_at);
  }
}

module.exports = { Mailbox, MAX_WAIT_MS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/frontdoor-stores.test.js`
Expected: PASS, `fail 0` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/device-registry.js src/frontdoor/approval-cache.js src/frontdoor/invites.js src/frontdoor/mailbox.js tests/frontdoor-stores.test.js
git commit -m "feat(frontdoor): relay stores for devices, approvals, invites and the mailbox

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Pluggable push — none, APNs, FCM

**Files:**
- Create: `src/frontdoor/push/index.js`, `src/frontdoor/push/none.js`, `src/frontdoor/push/apns.js`, `src/frontdoor/push/fcm.js`, `src/frontdoor/push/jwt.js`, `src/frontdoor/push/text.js`
- Test: `tests/frontdoor-push.test.js`

**Interfaces:**
- Consumes: Node `http`, `https`, `http2`, `crypto`; `createLogger`.
- Produces (program P18/E4): `createPusher(config, { senders = defaultSenders(config), onDropToken }) → { notify(device, { kind = 'approval', id, node_name, expires_at }) → Promise<void>, senders: string[] }` (never throws; an unknown kind becomes `approval`; a device without push or without a matching sender gets `none`); `defaultSenders(config, { readFile })` (config `{ apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } }`); `PushSender = { id, platforms, notify(device, payload) → Promise<{ ok, dropToken?, status? }> }`: `noneSender`, `createApnsSender({ teamId, keyId, keyPem, topic, environment = 'production', origin, now })`, `createFcmSender({ serviceAccount, tokenUrl, fcmOrigin, now })`; `signJwt(header, claims, pem)`, `requestText(url, { method, headers, body })`; `alertText(payload)`, `KINDS`, `TITLES`.

APNs: `POST /3/device/<token>` over HTTP/2 with an ES256 JWT (`{ alg, kid }` / `{ iss: team_id, iat }`, P1363, cached 50 min), headers `apns-topic`, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration`, `apns-collapse-id: <id>`, body `{"aps":{"alert":{"title":"King Louie","body":…},"sound":"default"},"kl":{"rid":id,"k":kind}}`; 410 → drop the token. FCM: RS256 assertion for the OAuth token (scope `firebase.messaging`, cached to `expires_in − 60 s`), data-only `{ rid, n, k }`, `android.priority: HIGH`, `ttl` = seconds left; 404 `UNREGISTERED` → drop the token.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-push.test.js` (local HTTP/2 and HTTP servers stand in for Apple and Google):

```js
// tests/frontdoor-push.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const http2 = require('http2');
const { createPusher } = require('../src/frontdoor/push');
const { createApnsSender } = require('../src/frontdoor/push/apns');
const { createFcmSender } = require('../src/frontdoor/push/fcm');
const { alertText } = require('../src/frontdoor/push/text');

const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function verifyJwt(jwt, publicKey, alg) {
  const [h, c, s] = jwt.split('.');
  const data = Buffer.from(`${h}.${c}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = alg === 'ES256'
    ? crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)
    : crypto.verify('sha256', data, publicKey, sig);
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

const device = (platform, token = 'tok-1') => ({ device_id: 'd-aaaaaaaaaaaaaaaa', push: { platform, token } });

describe('createPusher', () => {
  it("defaults to the 'none' sender and never throws", async () => {
    const pusher = createPusher({});
    assert.deepEqual(pusher.senders, ['none']);
    await pusher.notify(device('apns'), { id: 'r-1' });
    await pusher.notify({ device_id: 'd-x', push: null }, { id: 'r-1' });
  });

  it('picks the sender for the device platform, falls back to none, and drops rejected tokens', async () => {
    const seen = [];
    const dropped = [];
    const fake = { id: 'fake', platforms: ['fcm'], notify: async (d, p) => { seen.push(p); return { ok: false, dropToken: true, status: 404 }; } };
    const broken = { id: 'broken', platforms: ['apns'], notify: async () => { throw new Error('boom'); } };
    const pusher = createPusher({}, { senders: [fake, broken], onDropToken: (d) => dropped.push(d.device_id) });
    await pusher.notify(device('fcm'), { kind: 'lease', id: 'l-1', node_name: 'gpu-box' });
    await pusher.notify(device('apns'), { id: 'r-2' });
    assert.deepEqual(seen, [{ kind: 'lease', id: 'l-1', node_name: 'gpu-box', expires_at: null }]);
    assert.deepEqual(dropped, ['d-aaaaaaaaaaaaaaaa']);
  });

  it('alert text names the node and nothing about the action', () => {
    assert.equal(alertText({ kind: 'approval', node_name: 'web-01' }), 'Approval needed on web-01');
    assert.equal(alertText({ kind: 'question' }), 'Question waiting');
    assert.equal(alertText({ kind: 'nonsense' }), 'Approval needed');
  });
});

describe('APNs sender', () => {
  it('posts an ES256-authenticated alert with k and rid, caches the token, and drops a 410 token', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests = [];
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => {
        requests.push({ headers, body: JSON.parse(body) });
        stream.respond({ ':status': headers[':path'].endsWith('/gone') ? 410 : 200 });
        stream.end();
      });
    });
    const port = await listen(server);
    const sender = createApnsSender({
      teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      topic: 'com.example.kinglouie', origin: `http://127.0.0.1:${port}`
    });
    const expires = new Date(Date.now() + 120000).toISOString();
    assert.deepEqual(await sender.notify(device('apns', 'abc'), { kind: 'approval', id: 'r-1', node_name: 'web-01', expires_at: expires }), { ok: true, dropToken: false, status: 200 });
    assert.equal((await sender.notify(device('apns', 'gone'), { kind: 'question', id: 'q-1' })).dropToken, true);
    const [first, second] = requests;
    assert.equal(first.headers[':path'], '/3/device/abc');
    assert.equal(first.headers['apns-topic'], 'com.example.kinglouie');
    assert.equal(first.headers['apns-push-type'], 'alert');
    assert.equal(first.headers['apns-priority'], '10');
    assert.equal(first.headers['apns-collapse-id'], 'r-1');
    assert.equal(first.headers['apns-expiration'], String(Math.floor(Date.parse(expires) / 1000)));
    assert.deepEqual(first.body, { aps: { alert: { title: 'King Louie', body: 'Approval needed on web-01' }, sound: 'default' }, kl: { rid: 'r-1', k: 'approval' } });
    assert.equal(second.body.kl.k, 'question');
    const jwt = first.headers.authorization.replace(/^bearer /, '');
    const decoded = verifyJwt(jwt, publicKey, 'ES256');
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.header, { alg: 'ES256', kid: 'KEY1234567' });
    assert.equal(decoded.claims.iss, 'TEAM123456');
    assert.equal(second.headers.authorization, first.headers.authorization, 'the token is reused');
  });
});

describe('FCM sender', () => {
  it('exchanges an RS256 assertion once, sends a data-only high-priority message, and drops UNREGISTERED', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const sends = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/token') {
          tokenRequests += 1;
          const assertion = new URLSearchParams(body).get('assertion');
          const decoded = verifyJwt(assertion, publicKey, 'RS256');
          assert.equal(decoded.ok, true);
          assert.equal(decoded.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
          return;
        }
        const parsed = JSON.parse(body);
        sends.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        if (parsed.message.token === 'dead') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
          return;
        }
        res.writeHead(200);
        res.end('{}');
      });
    });
    const port = await listen(server);
    const sender = createFcmSender({
      serviceAccount: { client_email: 'relay@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'kl-example' },
      tokenUrl: `http://127.0.0.1:${port}/token`,
      fcmOrigin: `http://127.0.0.1:${port}`
    });
    const expires = new Date(Date.now() + 90000).toISOString();
    assert.equal((await sender.notify(device('fcm', 'live'), { kind: 'approval', id: 'r-1', node_name: 'web-01', expires_at: expires })).ok, true);
    assert.equal((await sender.notify(device('fcm', 'dead'), { kind: 'lease', id: 'l-1' })).dropToken, true);
    assert.equal(tokenRequests, 1);
    assert.equal(sends[0].url, '/v1/projects/kl-example/messages:send');
    assert.equal(sends[0].auth, 'Bearer ya29.test');
    assert.deepEqual(sends[0].body.message.data, { rid: 'r-1', n: 'web-01', k: 'approval' });
    assert.equal(sends[0].body.message.android.priority, 'HIGH');
    assert.match(sends[0].body.message.android.ttl, /^(89|90)s$/);
    assert.equal(sends[0].body.message.notification, undefined, 'data-only');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/frontdoor-push.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/push'`.

- [ ] **Step 3: Implement**

Create `src/frontdoor/push/text.js`:

```js
// Push kinds and the generic alert text: the node name and nothing about the
// action itself (spec §6.5 leak rule).
const KINDS = ['approval', 'grant', 'pairing', 'alert', 'question', 'lease'];
const TITLES = {
  approval: 'Approval needed',
  grant: 'Access request',
  pairing: 'Pairing request',
  alert: 'Alert',
  question: 'Question waiting',
  lease: 'Session request'
};

function alertText({ kind = 'approval', node_name: nodeName = null } = {}) {
  const title = TITLES[kind] || TITLES.approval;
  return nodeName ? `${title} on ${nodeName}` : title;
}

module.exports = { KINDS, TITLES, alertText };
```

Create `src/frontdoor/push/jwt.js`:

```js
// Minimal JWT signing for the push providers: ES256 (APNs, raw r||s) and
// RS256 (Google OAuth service-account assertion). Node's crypto only.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt(header, claims, privateKeyPem) {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = header.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}

// A small HTTP(S) request helper: → { status, text }.
function requestText(url, { method = 'POST', headers = {}, body = '' } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, { method, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('push request timed out')));
    req.end(body);
  });
}

module.exports = { signJwt, requestText };
```

Create `src/frontdoor/push/none.js`:

```js
// The default PushSender: sends nothing. Without push, phones see requests
// only while the app is open (it long-polls), and unseen requests expire
// closed (open question Q-A, program §8).
const noneSender = {
  id: 'none',
  platforms: [],
  async notify() {
    return { ok: true, dropToken: false };
  }
};

module.exports = { noneSender };
```

Create `src/frontdoor/push/apns.js`:

```js
// APNs over HTTP/2 with a token (.p8) key. The payload carries only
// { rid, k }; the app fetches and verifies the request itself.
const http2 = require('http2');
const { signJwt } = require('./jwt');
const { alertText } = require('./text');

const TOKEN_TTL_MS = 50 * 60 * 1000;

// `origin` overrides the Apple endpoint (tests use a local HTTP/2 server).
function createApnsSender({ teamId, keyId, keyPem, topic, environment = 'production', origin = null, now = Date.now }) {
  const base = origin || (environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  let token = null;
  let tokenAt = 0;
  const bearer = () => {
    const t = now();
    if (!token || t - tokenAt >= TOKEN_TTL_MS) {
      token = signJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(t / 1000) }, keyPem);
      tokenAt = t;
    }
    return token;
  };

  return {
    id: 'apns',
    platforms: ['apns'],
    notify(device, payload) {
      const body = JSON.stringify({
        aps: { alert: { title: 'King Louie', body: alertText(payload) }, sound: 'default' },
        kl: { rid: payload.id, k: payload.kind }
      });
      return new Promise((resolve, reject) => {
        const client = http2.connect(base);
        client.on('error', reject);
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${device.push.token}`,
          authorization: `bearer ${bearer()}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(payload.expires_at ? Math.floor(Date.parse(payload.expires_at) / 1000) : 0),
          'apns-collapse-id': String(payload.id).slice(0, 64),
          'content-type': 'application/json'
        });
        let status = 0;
        req.on('response', (headers) => { status = headers[':status']; });
        req.on('data', () => {});
        req.on('end', () => {
          client.close();
          resolve({ ok: status === 200, dropToken: status === 410, status });
        });
        req.on('error', (err) => { client.close(); reject(err); });
        req.end(body);
      });
    }
  };
}

module.exports = { createApnsSender };
```

Create `src/frontdoor/push/fcm.js`:

```js
// FCM HTTP v1 with a service account: a data-only, high-priority message
// carrying { rid, n, k }. The OAuth token is cached until a minute before it
// expires.
const { signJwt, requestText } = require('./jwt');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function createFcmSender({ serviceAccount, tokenUrl = 'https://oauth2.googleapis.com/token', fcmOrigin = 'https://fcm.googleapis.com', now = Date.now }) {
  let access = null;
  let accessUntil = 0;

  async function accessToken() {
    if (access && now() < accessUntil) return access;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: serviceAccount.client_email, scope: SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, serviceAccount.private_key);
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    const res = await requestText(tokenUrl, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    if (res.status !== 200) throw new Error(`FCM token exchange failed with ${res.status}`);
    const parsed = JSON.parse(res.text);
    access = parsed.access_token;
    accessUntil = now() + Math.max(0, (Number(parsed.expires_in) || 3600) - 60) * 1000;
    return access;
  }

  return {
    id: 'fcm',
    platforms: ['fcm'],
    async notify(device, payload) {
      const token = await accessToken();
      const secondsLeft = payload.expires_at ? Math.max(0, Math.ceil((Date.parse(payload.expires_at) - now()) / 1000)) : 300;
      const body = JSON.stringify({
        message: {
          token: device.push.token,
          data: { rid: String(payload.id), n: payload.node_name || '', k: payload.kind },
          android: { priority: 'HIGH', ttl: `${secondsLeft}s` }
        }
      });
      const res = await requestText(`${fcmOrigin}/v1/projects/${serviceAccount.project_id}/messages:send`, {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body
      });
      const unregistered = res.status === 404 && /UNREGISTERED/.test(res.text);
      return { ok: res.status === 200, dropToken: unregistered, status: res.status };
    }
  };
}

module.exports = { createFcmSender };
```

Create `src/frontdoor/push/index.js`:

```js
// Pluggable push (program §4.12, E4). A PushSender is
// { id, platforms: string[], notify(device, payload) → Promise<{ ok, dropToken? }> }.
// The `none` sender is the default and the fallback for any device without a
// matching sender. Push failures are logged and never block anything.
const fs = require('fs');
const { createLogger } = require('../../logging');
const { noneSender } = require('./none');
const { createApnsSender } = require('./apns');
const { createFcmSender } = require('./fcm');
const { KINDS, alertText } = require('./text');

const log = createLogger('frontdoor/push');

// config: { apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } }
function defaultSenders(config = {}, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const senders = [];
  if (config && config.apns) {
    const a = config.apns;
    senders.push(createApnsSender({ teamId: a.teamId, keyId: a.keyId, keyPem: readFile(a.keyFile), topic: a.topic, environment: a.environment }));
  }
  if (config && config.fcm) {
    senders.push(createFcmSender({ serviceAccount: JSON.parse(readFile(config.fcm.serviceAccountFile)) }));
  }
  return senders;
}

function createPusher(config = {}, { senders = defaultSenders(config), onDropToken = null } = {}) {
  return {
    senders: [...senders.map((s) => s.id), noneSender.id],
    async notify(device, { kind = 'approval', id, node_name: nodeName = null, expires_at: expiresAt = null } = {}) {
      const payload = { kind: KINDS.includes(kind) ? kind : 'approval', id, node_name: nodeName, expires_at: expiresAt };
      const platform = device && device.push && device.push.platform;
      const sender = (platform && senders.find((s) => s.platforms.includes(platform))) || noneSender;
      try {
        const result = await sender.notify(device, payload);
        if (result && result.dropToken) {
          log.info(`push token of ${device.device_id} was rejected by ${sender.id}; dropping it`);
          if (onDropToken) onDropToken(device);
        } else if (result && result.ok === false) {
          log.warn(`push via ${sender.id} to ${device.device_id} failed (${result.status})`);
        }
      } catch (err) {
        log.warn(`push via ${sender.id} failed: ${err.message}`);
      }
    }
  };
}

module.exports = { createPusher, defaultSenders, alertText, KINDS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/frontdoor-push.test.js`
Expected: PASS, `fail 0` (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/push tests/frontdoor-push.test.js
git commit -m "feat(frontdoor): pluggable push with a no-op default, APNs and FCM senders

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Phone API route registry and device authentication

**Files:**
- Create: `src/frontdoor/phone-api.js`
- Test: `tests/frontdoor-phone-api.test.js`

**Interfaces:**
- Consumes: `verifyEs256` (Part 1, Task 3); `phoneAuthString`, `TIMESTAMP_RE` (Part 1, Task 4); `DeviceRegistry`, `Invites` (Task 17).
- Produces (program P15/E2, E8): `createPhoneApi({ devices, rateLimits = { unauthPerMin: 10, devicePerMin: 120 }, now, relay, bodyLimit = 262144 }) → { registerRoute(method, pathPattern, { auth: 'device' | 'none' | 'code' | 'invite', rate?: { perMin }, handler(req, ctx) → { status = 200, body, headers } }), handler(req, res), relay, routes() }`. `pathPattern` lives under `/v1/` with `{name}` segments; a later registration of the same method and pattern replaces the earlier one. `ctx = { deviceId, device, params, query, body, relay }`. `class ApiError(status, code, message, extra)`; errors answer `{ error, message, …extra }` (`not_found` 404, `method_not_allowed` 405, `body_too_large` 413, `bad_json` 400, `unauthorized` / `bad_timestamp` / `clock_skew` (with `server_time`) / `unknown_device` / `bad_signature` / `replay` 401, `unknown_code` / `unknown_invite` 404, `rate_limited` 429 with `retry_after`, `internal` 500); a handler error carrying numeric `status` and `code` is answered with them. `BODY_LIMIT`, `SKEW_MS`.

Device auth: `X-KL-Device`, `X-KL-Timestamp` (RFC 3339 UTC, within 120 s), `X-KL-Signature = b64url(ES256-P1363(S))`, `S = phoneAuthString(method, pathWithQuery, timestamp, body)`; the replay key is SHA-256(S) plus the device id, kept 5 minutes, so a re-encoded (malleated) signature is still a replay. `code` routes need `ctx.params.code_id` known to `relay.invites.getCode`; `invite` routes an open, unclaimed `ctx.params.id`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-phone-api.test.js`:

```js
// tests/frontdoor-phone-api.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createPhoneApi } = require('../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { Invites } = require('../src/frontdoor/invites');
const { createFakePhone } = require('./helpers/fake-phone');

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

async function start({ rateLimits, clockOffsetMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-phone-api-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const devices = new DeviceRegistry({ file: path.join(dir, 'devices.json') });
  const relay = { invites: new Invites() };
  const api = createPhoneApi({ devices, rateLimits, relay, now: () => Date.now() + clockOffsetMs });
  api.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { server_time: new Date().toISOString() } }) });
  api.registerRoute('POST', '/v1/echo/{thing}', { auth: 'device', handler: async (req, ctx) => ({ status: 202, body: { device: ctx.deviceId, thing: ctx.params.thing, query: ctx.query, body: ctx.body } }) });
  api.registerRoute('GET', '/v1/enroll/{code_id}', { auth: 'code', handler: async (req, ctx) => ({ body: { code: ctx.params.code_id } }) });
  api.registerRoute('POST', '/v1/devices/invites/{id}/claim', { auth: 'invite', handler: async () => ({ status: 202, body: {} }) });
  const server = http.createServer(api.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const phone = createFakePhone();
  devices.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'Pixel 9', platform: 'android' });
  const call = async (method, p, { body = '', headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers, body: method === 'GET' ? undefined : body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const signed = (method, p, body = '', options = {}) => call(method, p, { body, headers: phone.signApi(method, p, body, options) });
  return { api, relay, phone, call, signed, devices };
}

describe('phone API device auth', () => {
  it('accepts a signed request and hands the handler the device, params, query and body', async () => {
    const { signed, phone } = await start();
    const body = JSON.stringify({ hello: 'world' });
    const res = await signed('POST', '/v1/echo/abc?x=1', body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { device: phone.deviceId, thing: 'abc', query: { x: '1' }, body: { hello: 'world' } });
  });

  it('refuses a missing, forged or unregistered signature', async () => {
    const { call, signed, phone } = await start();
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    const headers = phone.signApi('POST', '/v1/echo/a', '{"a":1}');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{"a":2}', headers })).body.error, 'bad_signature');
    const other = createFakePhone();
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers: other.signApi('POST', '/v1/echo/a', '{}') })).body.error, 'unknown_device');
    assert.equal((await signed('POST', '/v1/echo/a?b=1', '{}')).status, 202, 'the query is part of what is signed');
  });

  it('401 clock_skew then offset retry succeeds', async () => {
    const { signed } = await start({ clockOffsetMs: 10 * 60 * 1000 });
    const first = await signed('POST', '/v1/echo/a', '{}');
    assert.equal(first.status, 401);
    assert.equal(first.body.error, 'clock_skew');
    const offset = Date.parse(first.body.server_time) - Date.now();
    const retry = await signed('POST', '/v1/echo/a', '{}', { timestamp: new Date(Date.now() + offset).toISOString() });
    assert.equal(retry.status, 202);
  });

  it('keys replay on the signed string: a re-encoded (malleated) signature is still a replay', async () => {
    const { call, phone } = await start();
    const headers = phone.signApi('POST', '/v1/echo/a', '{}');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers })).status, 202);
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers })).body.error, 'replay');
    const sig = Buffer.from(headers['X-KL-Signature'], 'base64url');
    const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
    const malleated = Buffer.concat([sig.subarray(0, 32), Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex')]);
    const res = await call('POST', '/v1/echo/a', { body: '{}', headers: { ...headers, 'X-KL-Signature': malleated.toString('base64url') } });
    assert.equal(res.body.error, 'replay');
  });
});

describe('phone API code and invite routes', () => {
  it('a code route needs an open code_id; an invite route an unclaimed invite', async () => {
    const { call, relay, phone } = await start();
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.equal((await call('GET', `/v1/enroll/${codeId}`)).body.error, 'unknown_code');
    relay.invites.openCode(codeId, 'kl-aaaaaaaaaaaaaaaa', Date.now() + 600000);
    assert.deepEqual((await call('GET', `/v1/enroll/${codeId}`)).body, { code: codeId });
    const { invite_id: inviteId } = relay.invites.createInvite(phone.deviceId);
    assert.equal((await call('POST', `/v1/devices/invites/${inviteId}/claim`, { body: '{}' })).status, 202);
    relay.invites.claim(inviteId, { device: {}, mac: 'x' });
    assert.equal((await call('POST', `/v1/devices/invites/${inviteId}/claim`, { body: '{}' })).body.error, 'unknown_invite');
  });
});

describe('phone API limits and routing', () => {
  it('rate-limits unauthenticated calls per IP and devices per device, with retry_after', async () => {
    const { call, signed } = await start({ rateLimits: { unauthPerMin: 3, devicePerMin: 2 } });
    for (let i = 0; i < 3; i += 1) assert.equal((await call('GET', '/v1/time')).status, 200);
    const limited = await call('GET', '/v1/time');
    assert.equal(limited.status, 429);
    assert.ok(limited.body.retry_after >= 1);
    assert.equal((await signed('POST', '/v1/echo/1', '{}')).status, 202);
    assert.equal((await signed('POST', '/v1/echo/2', '{}')).status, 202);
    assert.equal((await signed('POST', '/v1/echo/3', '{}')).status, 429);
  });

  it('caps bodies at 256 KiB and refuses bad JSON', async () => {
    const { signed } = await start();
    const big = JSON.stringify({ x: 'y'.repeat(262144) });
    assert.equal((await signed('POST', '/v1/echo/a', big)).status, 413);
    assert.equal((await signed('POST', '/v1/echo/a', '{nope')).body.error, 'bad_json');
  });

  it('404 for unknown paths, 405 for a wrong method, and a later registration replaces an earlier one (E8)', async () => {
    const { call, api } = await start();
    assert.equal((await call('GET', '/v1/nothing')).status, 404);
    assert.equal((await call('POST', '/v1/time', { body: '{}' })).status, 405);
    api.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { replaced: true } }) });
    assert.deepEqual((await call('GET', '/v1/time')).body, { replaced: true });
    assert.equal(api.routes().filter((r) => r.pattern === '/v1/time').length, 1);
    assert.throws(() => api.registerRoute('GET', '/v2/x', { auth: 'none', handler: () => ({}) }));
    assert.throws(() => api.registerRoute('GET', '/v1/x', { auth: 'oauth', handler: () => ({}) }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/frontdoor-phone-api.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/phone-api'`.

- [ ] **Step 3: Implement**

Create `src/frontdoor/phone-api.js`:

```js
// The relay's phone API (spec §4.5): a route registry (E2) with device
// signatures, code/invite path credentials, rate limits and a body cap. F3's
// own routes register through it (routes.js), as do F4, F5 and C4; a later
// registration of the same method and path replaces the earlier one (E8).
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { verifyEs256 } = require('../approvals/envelope');
const { phoneAuthString, TIMESTAMP_RE } = require('../approvals/messages');

const log = createLogger('frontdoor/phone-api');

const BODY_LIMIT = 262144;
const SKEW_MS = 120000;
const REPLAY_MS = 5 * 60 * 1000;
const AUTH_KINDS = ['device', 'none', 'code', 'invite'];

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function compile(pathPattern) {
  if (typeof pathPattern !== 'string' || !pathPattern.startsWith('/v1/')) throw new TypeError(`route paths live under /v1/: ${pathPattern}`);
  const names = [];
  const source = pathPattern.split('/').map((segment) => {
    const m = /^\{([a-z_]+)\}$/.exec(segment);
    if (m) {
      names.push(m[1]);
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function createPhoneApi({ devices, rateLimits = {}, now = Date.now, relay = null, bodyLimit = BODY_LIMIT } = {}) {
  const limits = { unauthPerMin: 10, devicePerMin: 120, ...rateLimits };
  const routes = [];
  const replay = new Map();
  const buckets = new Map();

  function registerRoute(method, pathPattern, { auth = 'device', rate = null, handler } = {}) {
    if (!AUTH_KINDS.includes(auth)) throw new TypeError(`auth must be one of ${AUTH_KINDS.join(', ')}`);
    if (typeof handler !== 'function') throw new TypeError('registerRoute needs a handler');
    const route = { method: String(method).toUpperCase(), pattern: pathPattern, ...compile(pathPattern), auth, rate, handler };
    const i = routes.findIndex((r) => r.method === route.method && r.pattern === pathPattern);
    if (i >= 0) routes[i] = route;
    else routes.push(route);
  }

  function rateLimit(key, perMin) {
    const t = now();
    const hits = (buckets.get(key) || []).filter((at) => t - at < 60000);
    if (hits.length >= perMin) {
      const retryAfter = Math.max(1, Math.ceil((hits[0] + 60000 - t) / 1000));
      buckets.set(key, hits);
      throw new ApiError(429, 'rate_limited', 'too many requests', { retry_after: retryAfter });
    }
    hits.push(t);
    buckets.set(key, hits);
  }

  function authenticateDevice(req, pathWithQuery, body) {
    const deviceId = req.headers['x-kl-device'];
    const timestamp = req.headers['x-kl-timestamp'];
    const signature = req.headers['x-kl-signature'];
    if (!deviceId || !timestamp || !signature) throw new ApiError(401, 'unauthorized', 'device signature headers are missing');
    if (!TIMESTAMP_RE.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new ApiError(401, 'bad_timestamp', 'X-KL-Timestamp must be RFC 3339 UTC');
    if (Math.abs(Date.parse(timestamp) - now()) > SKEW_MS) {
      throw new ApiError(401, 'clock_skew', "the phone's clock is more than 120 s off", { server_time: new Date(now()).toISOString() });
    }
    const device = devices.get(deviceId);
    if (!device) throw new ApiError(401, 'unknown_device', 'this device is not registered with the relay');
    const s = phoneAuthString(req.method, pathWithQuery, timestamp, body);
    const envelope = { alg: 'ES256', kid: deviceId, payload: Buffer.from(s, 'utf8').toString('base64url'), sig: String(signature) };
    if (!verifyEs256(envelope, device.jwk)) throw new ApiError(401, 'bad_signature', 'the request signature does not verify');
    // Keyed on the signed string, not the (malleable) signature value.
    const key = `${crypto.createHash('sha256').update(s).digest('base64url')}|${deviceId}`;
    const t = now();
    for (const [k, until] of replay) if (until <= t) replay.delete(k);
    if (replay.has(key)) throw new ApiError(401, 'replay', 'this signed request was already used');
    replay.set(key, t + REPLAY_MS);
    return device;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > bodyLimit) {
          if (!failed) reject(new ApiError(413, 'body_too_large', `bodies are limited to ${bodyLimit} bytes`));
          failed = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  async function handler(req, res) {
    const pathWithQuery = req.url;
    const url = new URL(req.url, 'http://relay.invalid');
    try {
      const matching = routes.filter((r) => r.regex.test(url.pathname));
      if (matching.length === 0) throw new ApiError(404, 'not_found', 'no such route');
      const route = matching.find((r) => r.method === req.method);
      if (!route) throw new ApiError(405, 'method_not_allowed', `${req.method} is not allowed here`);
      const values = route.regex.exec(url.pathname).slice(1).map((v) => decodeURIComponent(v));
      const params = Object.fromEntries(route.names.map((n, i) => [n, values[i]]));
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';

      const body = await readBody(req);
      let device = null;
      if (route.auth === 'device') {
        device = authenticateDevice(req, pathWithQuery, body);
        rateLimit(`device:${device.device_id}`, (route.rate && route.rate.perMin) || limits.devicePerMin);
      } else {
        rateLimit(`ip:${ip}`, (route.rate && route.rate.perMin) || limits.unauthPerMin);
        if (route.auth === 'code' && !(relay && relay.invites && relay.invites.getCode(params.code_id))) {
          throw new ApiError(404, 'unknown_code', 'no enrollment code with that id');
        }
        if (route.auth === 'invite') {
          const invite = relay && relay.invites && relay.invites.getInvite(params.id);
          if (!invite || invite.claim) throw new ApiError(404, 'unknown_invite', 'no open invite with that id');
        }
      }

      let parsed = null;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new ApiError(400, 'bad_json', 'the body is not JSON');
        }
      }
      const ctx = { deviceId: device ? device.device_id : null, device, params, query: Object.fromEntries(url.searchParams), body: parsed, relay };
      const result = (await route.handler(req, ctx)) || {};
      send(res, result.status || 200, result.body, result.headers);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.code, message: err.message, ...err.extra });
        return;
      }
      if (err && Number.isInteger(err.status) && err.code) {
        send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      log.error(`phone API ${req.method} ${url.pathname} failed: ${err && err.message}`);
      send(res, 500, { error: 'internal', message: 'the relay could not handle this request' });
    }
  }

  return { registerRoute, handler, relay, routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.auth })) };
}

module.exports = { createPhoneApi, ApiError, BODY_LIMIT, SKEW_MS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/frontdoor-phone-api.test.js`
Expected: PASS, `fail 0` (8 tests), including the Review Focus case "401 clock_skew then offset retry succeeds". (The long-poll `wait` behaviour of `GET /v1/approvals` is a route, so its test is in Task 21's `tests/frontdoor-relay.test.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/phone-api.js tests/frontdoor-phone-api.test.js
git commit -m "feat(frontdoor): phone API route registry with device signatures and rate limits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: `startApprovals`, configuration, and both service profiles

**Files:**
- Create: `src/approvals/service-wiring.js`
- Modify: `src/service/config.js` — `ADMIN_ONLY_KEYS` (`:20-23`) and the return value / `module.exports` of `loadServiceConfig` (`:164-171`)
- Modify: `src/service/node-config.js` — `defaultNodeConfig` (`:41-56`), a new block after it, and the return value of `loadNodeConfig` (`:167-184`)
- Modify: `src/service/run.js` — the agent profile's `start` (`:41-68`), the runbook profile's `start` (`:74-80`), and the `loadProfile(profile).start(…)` call in `runService` (`:151`)
- Modify: `tests/service-config.test.js:29-35` (the defaults now include `relay` and `audit`), `tests/service-profile-graph.test.js:9` and `:30`
- Conditional (F6): `NODE_YAML_KEYS` and `tests/examples.test.js`
- Test: `tests/approvals-service-wiring.test.js`

**Interfaces:**
- Consumes: `getOrGenerateNodeIdentity` (`src/mesh/node-identity.js`), `adminConfigDir` (`src/platform/paths.js`), `AuditLedger`, `ApproverStore`, `PhoneApprover` (Part 1), `RelayClient` (Part 2, Task 14), `CourierPump`/`FileCourier` (Part 2, Task 15), `open` (Part 1), `canonicalize`/`sha256b64url`; service ports `{ store, cipher }` from `buildServicePorts`.
- Produces (program P9): `startApprovals({ dataDir, configDir = adminConfigDir({ dataDir }), nodeConfig, ports, profile, serviceConfig = { audit }, identity = null, useTls = true, allowTestKeys = false, transportFactory, reconnectDelays, approverStoreOptions }) → Promise<{ phoneApprover, auditLedger, relayClient, approverStore, identity, courierPump, stop() }>`; `startMcpApprovals({ dataDir, configDir, nodeConfig, ports, identity, approverStoreOptions, pollMs }) → Promise<{ approver, auditLedger, courier, identity, stop() }>`; `createRelayDispatcher({ phoneApprover, approverStore, auditLedger, courierPump }) → (method, params) → result`; `trackDeviceStates({ approverStore, relayClient, intervalMs = 5000 }) → stop`; `nullLink(reason)`; `RELAY_PIN_KEY` (`'approvals.relay'`). `loadServiceConfig(…)` also returns `relay` (normalized, or `null`) and `audit: { retentionDays }`; `parseRelayConfig(raw, file)`, `parseAuditConfig(raw, file)` exported; `ADMIN_ONLY_KEYS` gains `relay`, `audit`. `loadNodeConfig(…)` returns `approvers: { relay: 'wss://host:port' | null, requestTtlS: 30..300 }`. `loadProfile(p).start(…)` returns `{ stop, masterKeySource, approvals }`; the agent profile runs `createCore` with `remoteApprovals: 'phone'`, `phoneApprover`, `auditLedger`, `nodePolicy: nodeConfig.policy`.

`startApprovals` builds the audit ledger (writer `service`, pruned at start and daily), the `ApproverStore` (awaiting `ready()`), and — when `approvers.relay` or `<configDir>/front-door.json` is set **and** the store holds the `approvals.relay` pin from `pair` — a `RelayClient` plus a `CourierPump`, with the dispatcher answering the relay's `approval.response` (to the service's approver or a producer's courier inbox), `enroll.claim` (to the producer that opened the code), `device.enroll|revoke` (`approverStore.stage`, audited `device.staged` / `device.rejected`), `audit.slice` and `audit.head`. Without a relay the approver's link is a `nullLink` whose `canDeliver()` says why (`no relay is configured for this node (approvers.relay in node.yaml)` or `this node is not paired with its relay (run \`king-louie-service pair wss://…\`)`). It loads nothing from the agent stack.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-service-wiring.test.js`:

```js
// tests/approvals-service-wiring.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { startApprovals, startMcpApprovals, createRelayDispatcher, trackDeviceStates } = require('../src/approvals/service-wiring');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { toolAction } = require('../src/approvals/messages');
const { parseRelayConfig, parseAuditConfig, loadServiceConfig } = require('../src/service/config');
const { loadNodeConfig } = require('../src/service/node-config');
const { createFakePhone } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

let nodeIdentity;
let relayIdentity;
before(() => {
  nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
});

// dataDir and a sibling admin config dir with approvers/ holding `records`.
function layout(records = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wiring-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); fs.chmodSync(path.join(configDir, 'approvers'), 0o755); }
  for (const r of records) fs.writeFileSync(path.join(configDir, 'approvers', `${r.device_id}.json`), JSON.stringify(r), { mode: 0o644 });
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data' });
  return { base, dataDir, configDir, ports: { store, cipher: createAesGcmCipher(crypto.randomBytes(32)) } };
}

const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const nodeConfig = (approvers = { relay: null, requestTtlS: 300 }) => ({ name: 'web-01', approvers, policy: {} });

async function fakeRelay() {
  const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port: 0, useTls: false });
  transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
  await transport.start();
  cleanups.push(() => transport.stop());
  const rpc = createLinkRpc(transport);
  const notes = [];
  rpc.handle('relay.hello', () => ({ relay_id: relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/x' }));
  rpc.handle('approval.submit', () => ({ ok: true }));
  rpc.handle('approval.status', () => ({ ok: true }));
  rpc.onUnhandled((method, params) => { notes.push([method, params]); return { ok: true }; });
  const connected = new Promise((resolve) => transport.once('peerConnected', resolve));
  return { transport, rpc, notes, connected };
}

describe('startApprovals', () => {
  it('without a relay: everything is built and requests are refused with the reason', async () => {
    const l = layout();
    const a = await startApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig(), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    cleanups.push(() => a.stop());
    assert.equal(a.relayClient, null);
    assert.equal(a.identity, nodeIdentity);
    assert.equal(a.phoneApprover.unavailableReason(), 'no relay is configured for this node (approvers.relay in node.yaml)');
    assert.equal((await a.auditLedger.append({ kind: 'x', data: {} })).seq, 1);
    assert.ok(fs.existsSync(path.join(l.dataDir, 'audit')));
  });

  it('with approvers.relay but no pairing: says to pair', async () => {
    const l = layout();
    const a = await startApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig({ relay: 'wss://127.0.0.1:18795', requestTtlS: 120 }), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    cleanups.push(() => a.stop());
    assert.match(a.phoneApprover.unavailableReason(), /not paired with its relay/);
    assert.equal(a.phoneApprover.ttlMs, 120000);
  });

  it('paired: links to the relay, answers audit and device calls, and accepts a phone response', async () => {
    const phone = createFakePhone();
    const l = layout([phone.approverRecord()]);
    const relay = await fakeRelay();
    l.ports.store.set('approvals.relay', {
      relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
      tlsFingerprint: null, address: '127.0.0.1', port: relay.transport.port, pairedAt: new Date().toISOString()
    });
    const a = await startApprovals({
      dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig({ relay: `wss://127.0.0.1:${relay.transport.port}`, requestTtlS: 300 }),
      ports: l.ports, identity: nodeIdentity, useTls: false, approverStoreOptions: storeOptions, reconnectDelays: [50]
    });
    cleanups.push(() => a.stop());
    await relay.connected;
    for (let i = 0; i < 100 && !a.relayClient.isConnected(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(a.phoneApprover.isAvailable(), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(l.dataDir, 'approvals', 'link.json'), 'utf8')).connected, true);

    const head = await relay.rpc.call(nodeIdentity.peerId, 'audit.head', {});
    assert.equal(verifyEd25519(head.envelope, nodeIdentity.publicKey.toString('hex')), true);

    const newcomer = createFakePhone();
    const staged = await relay.rpc.call(nodeIdentity.peerId, 'device.enroll', { envelope: phone.enroll({ device: newcomer.device() }) });
    assert.deepEqual(staged, { state: 'staged' });
    await new Promise((r) => setImmediate(r));
    assert.ok(a.auditLedger.tail(5).some((e) => e.kind === 'device.staged' && e.data.device_id === newcomer.deviceId));

    const submitted = [];
    relay.rpc.handle('approval.submit', (params) => { submitted.push(params.envelope); return { ok: true }; });
    const pending = a.phoneApprover.requestApproval('Bash', { command: 'uptime' }, {});
    for (let i = 0; i < 100 && submitted.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const answer = await relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: phone.respond(submitted[0], 'approve') });
    assert.deepEqual(answer, { delivered: true, accepted: true, reason: null });
    assert.equal(await pending, true);
    const slice = await relay.rpc.call(nodeIdentity.peerId, 'audit.slice', { limit: 10 });
    assert.ok(open(slice.envelope).message.entries.some((e) => e.kind === 'approval.response'));
  });
});

describe('startMcpApprovals', () => {
  it('uses the courier: refused at once while the service is stopped, and audits as mcp', async () => {
    const phone = createFakePhone();
    const l = layout([phone.approverRecord()]);
    const m = await startMcpApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig(), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    cleanups.push(() => m.stop());
    assert.equal(m.approver.unavailableReason(), 'the King Louie service is not running on this node');
    assert.equal((await m.auditLedger.append({ kind: 'request.inbound', data: {} })).writer, 'mcp');
    fs.writeFileSync(path.join(l.dataDir, 'service.pid'), String(process.pid));
    fs.mkdirSync(path.join(l.dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(l.dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true }));
    assert.equal(m.approver.isAvailable(), true);
  });
});

describe('createRelayDispatcher', () => {
  it('routes a response for an out-of-process producer to its courier inbox', async () => {
    const delivered = [];
    const courierPump = { routeFor: (method) => (method === 'approval.response' ? 'p-1-abcdef01' : null), deliver: (inbox, method) => { delivered.push([inbox, method]); return true; } };
    const phoneApprover = { handleResponse: async () => { throw new Error('must not be called'); } };
    const dispatch = createRelayDispatcher({ phoneApprover, approverStore: null, auditLedger: null, courierPump });
    assert.deepEqual(await dispatch('approval.response', { envelope: {} }), { delivered: true, accepted: null, reason: null });
    assert.deepEqual(delivered, [['p-1-abcdef01', 'approval.response']]);
    await assert.rejects(dispatch('nothing.here', {}), (err) => err.code === 'unknown_method');
    assert.deepEqual(await dispatch('enroll.claim', { code_id: 'x' }), { delivered: false });
  });
});

describe('trackDeviceStates', () => {
  it('tells the relay when an admin applies or revokes a device', async () => {
    const a = createFakePhone();
    const b = createFakePhone();
    const store = await approverStoreWith([a.approverRecord()]);
    cleanups.push(() => store.cleanup());
    const relayClient = Object.assign(new EventEmitter(), { notes: [], notify(method, params) { this.notes.push([method, params]); } });
    const stop = trackDeviceStates({ approverStore: store, relayClient, intervalMs: 20 });
    cleanups.push(stop);
    relayClient.emit('connected');
    fs.writeFileSync(path.join(store.dir, `${b.deviceId}.json`), JSON.stringify(b.approverRecord()));
    fs.writeFileSync(path.join(store.dir, `${a.deviceId}.json`), JSON.stringify(a.approverRecord({ revokedAt: '2026-09-23T18:00:00.000Z', revokedBy: 'console' })));
    for (let i = 0; i < 100 && relayClient.notes.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(relayClient.notes, [
      ['device.state', { device_id: a.deviceId, state: 'active' }],
      ['device.state', { device_id: b.deviceId, state: 'active' }],
      ['device.state', { device_id: a.deviceId, state: 'revoked' }]
    ]);
  });
});

describe('relay and audit configuration', () => {
  const file = 'service.json';
  const minimal = { tls: { cert_file: '/etc/king-louie/relay.crt', key_file: '/etc/king-louie/relay.key' }, mesh_listen: { host: '10.0.0.5' }, public_url: 'https://kl.example.com:8443' };

  it('normalizes the relay block with its defaults', () => {
    assert.deepEqual(parseRelayConfig(minimal, file), {
      phoneListen: { host: '0.0.0.0', port: 8443 },
      tls: { certFile: '/etc/king-louie/relay.crt', keyFile: '/etc/king-louie/relay.key' },
      meshListen: { host: '10.0.0.5', port: 18795 },
      publicUrl: 'https://kl.example.com:8443',
      push: {}
    });
    const withPush = parseRelayConfig({ ...minimal, push: { apns: { team_id: 'T', key_id: 'K', key_file: '/k.p8', topic: 'com.example.kinglouie' }, fcm: { service_account_file: '/sa.json' } } }, file);
    assert.deepEqual(withPush.push, { apns: { teamId: 'T', keyId: 'K', keyFile: '/k.p8', topic: 'com.example.kinglouie', environment: 'production' }, fcm: { serviceAccountFile: '/sa.json' } });
    assert.equal(parseRelayConfig(undefined, file), null);
  });

  it('rejects unknown keys (naming the path), a missing tls block and a non-https public_url', () => {
    assert.throws(() => parseRelayConfig({ ...minimal, extra: 1 }, file), /relay\.extra is not a known key/);
    assert.throws(() => parseRelayConfig({ ...minimal, mesh_listen: { host: '10.0.0.5', bind: 1 } }, file), /relay\.mesh_listen\.bind/);
    assert.throws(() => parseRelayConfig({ ...minimal, tls: undefined }, file), /relay\.tls/);
    assert.throws(() => parseRelayConfig({ ...minimal, public_url: 'http://kl.example.com' }, file), /https/);
    assert.throws(() => parseRelayConfig({ ...minimal, push: { apns: { team_id: 'T', key_id: 'K', key_file: 'f', topic: 't', environment: 'dev' } } }, file), /environment/);
  });

  it('audit.retention_days defaults to 365 and must be at least 30', () => {
    assert.deepEqual(parseAuditConfig(undefined, file), { retentionDays: 365 });
    assert.deepEqual(parseAuditConfig({ retention_days: 30 }, file), { retentionDays: 30 });
    assert.throws(() => parseAuditConfig({ retention_days: 29 }, file), /at least 30/);
  });

  it('reads relay only from the admin config, never from the data dir', () => {
    const l = layout();
    fs.writeFileSync(path.join(l.dataDir, 'service.json'), JSON.stringify({ relay: minimal }));
    fs.writeFileSync(path.join(l.configDir, 'service.json'), JSON.stringify({ relay: { ...minimal, mesh_listen: { host: '127.0.0.1' } } }), { mode: 0o644 });
    const cfg = loadServiceConfig(l.dataDir, {}, { adminConfigDir: l.configDir, geteuid: () => UID, adminUid: UID });
    assert.equal(cfg.relay.meshListen.host, '127.0.0.1');
  });

  it('node.yaml approvers: relay URL and request TTL, validated', () => {
    const l = layout();
    const write = (text) => fs.writeFileSync(path.join(l.configDir, 'node.yaml'), text, { mode: 0o644 });
    const load = () => loadNodeConfig({ adminConfigDir: l.configDir, geteuid: () => UID, adminUid: UID });
    write('name: web-01\napprovers:\n  relay: wss://10.0.0.5:18795\n  request_ttl_s: 120\n');
    assert.deepEqual(load().approvers, { relay: 'wss://10.0.0.5:18795', requestTtlS: 120 });
    write('name: web-01\n');
    assert.deepEqual(load().approvers, { relay: null, requestTtlS: 300 });
    write('approvers:\n  relay: https://kl.example.com\n');
    assert.throws(load, /approvers\.relay must be wss:\/\/host:port/);
    write('approvers:\n  request_ttl_s: 600\n');
    assert.throws(load, /from 30 to 300/);
    write('approvers:\n  phone: yes\n');
    assert.throws(load, /approvers\.phone is not a known key/);
  });
});
```

In `tests/service-config.test.js`, the first test's expected object gains the two new keys. Replace

```js
      ports: { gateway: 18793, webhook: 18794 }
    });
  });
```

(the end of `'defaults to agent profile with listeners and chat channels off, on the service ports'`) with

```js
      ports: { gateway: 18793, webhook: 18794 },
      relay: null,
      audit: { retentionDays: 365 }
    });
  });
```

In `tests/service-profile-graph.test.js`, replace the `FORBIDDEN` line with

```js
const FORBIDDEN = ['src/providers/', 'src/execution/agent-loop', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core', 'src/execution/safety-policy'];
```

and after `assert.ok(loaded.includes('src/service/ports.js'), 'start() must have run (ports.js is only required inside it)');` add

```js
      assert.ok(loaded.includes('src/approvals/service-wiring.js'), 'the runbook profile starts phone approvals');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-service-wiring.test.js tests/service-config.test.js tests/service-profile-graph.test.js`
Expected: FAIL — `Cannot find module '../src/approvals/service-wiring'`, the defaults test lacks `relay`/`audit`, and the profile graph never loads `service-wiring.js`.

- [ ] **Step 3: Implement**

Create `src/approvals/service-wiring.js`:

```js
// startApprovals (program P9): everything a node needs for signed phone
// approvals, for both the agent and the runbook profile. It requires nothing
// from the agent stack, so the runbook profile's module graph stays small
// (tests/service-profile-graph.test.js).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');
const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
const { AuditLedger } = require('../audit/audit-ledger');
const { ApproverStore } = require('./approver-store');
const { PhoneApprover } = require('./phone-approver');
const { RelayClient } = require('./relay-client');
const { CourierPump } = require('./courier');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { open } = require('./envelope');

const log = createLogger('approvals/service');
const DAY_MS = 24 * 60 * 60 * 1000;
const RELAY_PIN_KEY = 'approvals.relay';

// A link for a node with no relay: nothing can be delivered, and says why.
function nullLink(reason) {
  const refuse = () => Promise.reject(Object.assign(new Error(reason), { code: 'relay_offline' }));
  return {
    isConnected: () => false,
    canDeliver: () => ({ ok: false, reason }),
    submit: refuse,
    status: refuse,
    send: refuse,
    call: refuse,
    notify: () => {},
    onMessage: () => {},
    registerMethod: () => {},
    on: () => {},
    off: () => {}
  };
}

function envelopeSha(envelope) {
  try {
    return sha256b64url(canonicalize(envelope));
  } catch {
    return null;
  }
}

// relay → node methods (spec §4.6). A response or claim for a request an
// out-of-process producer (mcp, the admin CLI) made goes to its courier inbox.
function createRelayDispatcher({ phoneApprover, approverStore, auditLedger, courierPump = null }) {
  return async (method, params = {}) => {
    if (method === 'approval.response' || method === 'enroll.claim') {
      const inbox = courierPump ? courierPump.routeFor(method, params) : null;
      if (inbox) return { delivered: courierPump.deliver(inbox, method, params), accepted: null, reason: null };
      if (method === 'enroll.claim') return { delivered: false };
      const result = await phoneApprover.handleResponse(params.envelope);
      return { delivered: true, ...result };
    }
    if (method === 'device.enroll' || method === 'device.revoke') {
      const result = approverStore.stage(params.envelope);
      let deviceId = null;
      try {
        const { message } = open(params.envelope);
        deviceId = message.type === 'kl.device.enroll' ? message.device && message.device.device_id : message.device_id;
      } catch {
        deviceId = null;
      }
      const kind = result.state === 'rejected' ? 'device.rejected' : 'device.staged';
      if (result.state !== 'duplicate') {
        auditLedger.append({ kind, data: { type: method === 'device.enroll' ? 'kl.device.enroll' : 'kl.device.revoke', device_id: deviceId, reason: result.reason || null, envelope_sha256: envelopeSha(params.envelope) } })
          .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
      }
      return result;
    }
    if (method === 'audit.slice') {
      const { limit, before_seq: beforeSeq, after, max_bytes: maxBytes } = params;
      return { envelope: auditLedger.slice({ limit, before_seq: beforeSeq, after, max_bytes: maxBytes }) };
    }
    if (method === 'audit.head') return { envelope: auditLedger.head() };
    throw Object.assign(new Error(`no handler for ${method}`), { code: 'unknown_method' });
  };
}

// Tells the relay when an admin applies or revokes a device on this node, so
// it pushes to (and lists) the right phones.
function trackDeviceStates({ approverStore, relayClient, intervalMs = 5000 }) {
  let known = new Set(approverStore.list().filter((r) => approverStore.isAdminApplied(r.device_id)).map((r) => r.device_id));
  const push = () => {
    approverStore.refresh();
    const now = new Set(approverStore.list().filter((r) => approverStore.isAdminApplied(r.device_id)).map((r) => r.device_id));
    for (const id of now) if (!known.has(id)) relayClient.notify('device.state', { device_id: id, state: 'active' });
    for (const id of known) if (!now.has(id)) relayClient.notify('device.state', { device_id: id, state: 'revoked' });
    known = now;
  };
  const onConnected = () => {
    for (const id of known) relayClient.notify('device.state', { device_id: id, state: 'active' });
  };
  relayClient.on('connected', onConnected);
  const timer = setInterval(push, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    clearInterval(timer);
    relayClient.off('connected', onConnected);
  };
}

async function startApprovals({ dataDir, configDir = adminConfigDir({ dataDir }), nodeConfig, ports, profile = 'agent',
  serviceConfig = {}, identity = null, useTls = true, allowTestKeys = false, transportFactory, reconnectDelays,
  approverStoreOptions = {} } = {}) {
  const nodeIdentity = identity || getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeConfig.name);
  const retentionDays = (serviceConfig.audit && serviceConfig.audit.retentionDays) || 365;
  const auditLedger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity: nodeIdentity, nodeId: nodeIdentity.nodeId, writer: 'service', retentionDays });
  const pruned = auditLedger.prune();
  if (pruned.removedSegments) log.info(`pruned ${pruned.removedSegments} audit segment(s) older than ${retentionDays} days`);
  const pruneTimer = setInterval(() => {
    try { auditLedger.prune(); } catch (err) { log.warn(`audit prune failed: ${err.message}`); }
  }, DAY_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  const approverStore = new ApproverStore({
    dir: path.join(configDir, 'approvers'),
    stagedDir: path.join(dataDir, 'approvals', 'staged'),
    allowTestKeys,
    // Tests only: they cannot create root-owned files (geteuid, adminUid, platform).
    ...approverStoreOptions
  });
  await approverStore.ready();

  const approvers = nodeConfig.approvers || { relay: null, requestTtlS: 300 };
  const relayPin = ports && ports.store ? ports.store.get(RELAY_PIN_KEY) || null : null;
  const frontDoor = fs.existsSync(path.join(configDir, 'front-door.json'));
  const wantsRelay = Boolean(approvers.relay) || frontDoor;
  let relayClient = null;
  let link;
  if (wantsRelay && relayPin) {
    relayClient = new RelayClient({
      identity: nodeIdentity, nodeName: nodeConfig.name, relayPin, configDir, dataDir, useTls,
      ...(transportFactory ? { transportFactory } : {}), ...(reconnectDelays ? { reconnectDelays } : {})
    });
    link = relayClient;
  } else {
    const reason = wantsRelay
      ? 'this node is not paired with its relay (run `king-louie-service pair wss://…`)'
      : 'no relay is configured for this node (approvers.relay in node.yaml)';
    if (wantsRelay) log.warn(reason);
    link = nullLink(reason);
  }

  const phoneApprover = new PhoneApprover({
    identity: nodeIdentity,
    nodeName: nodeConfig.name,
    approverStore,
    link,
    auditLedger,
    ttlMs: (approvers.requestTtlS || 300) * 1000
  });

  let courierPump = null;
  let stopTracking = () => {};
  if (relayClient) {
    courierPump = new CourierPump({ dataDir, relayClient, identity: nodeIdentity });
    relayClient.onMessage(createRelayDispatcher({ phoneApprover, approverStore, auditLedger, courierPump }));
    stopTracking = trackDeviceStates({ approverStore, relayClient });
    await relayClient.start();
    courierPump.start();
  }
  log.info('phone approvals ready', { profile, relay: relayClient ? relayPin.relay_id : null, activeDevices: approverStore.activeCount() });

  return {
    phoneApprover,
    auditLedger,
    relayClient,
    approverStore,
    identity: nodeIdentity,
    courierPump,
    async stop() {
      clearInterval(pruneTimer);
      stopTracking();
      phoneApprover.stop();
      if (courierPump) courierPump.stop();
      if (relayClient) await relayClient.stop();
    }
  };
}

// The `mcp` process (spec §3.8, §3.9): it cannot open its own relay link, so
// its PhoneApprover talks to the running service through a FileCourier, and
// its audit entries say writer 'mcp'. With the service stopped every unsafe
// runbook is refused at once with that reason.
async function startMcpApprovals({ dataDir, configDir = adminConfigDir({ dataDir }), nodeConfig, ports, identity = null,
  approverStoreOptions = {}, pollMs } = {}) {
  const { FileCourier } = require('./courier');
  const nodeIdentity = identity || getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeConfig.name);
  const auditLedger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity: nodeIdentity, nodeId: nodeIdentity.nodeId, writer: 'mcp' });
  const approverStore = new ApproverStore({
    dir: path.join(configDir, 'approvers'),
    stagedDir: path.join(dataDir, 'approvals', 'staged'),
    ...approverStoreOptions
  });
  await approverStore.ready();
  const courier = new FileCourier({ dataDir, identity: nodeIdentity, ...(pollMs ? { pollMs } : {}) }).start();
  const approvers = nodeConfig.approvers || { requestTtlS: 300 };
  const approver = new PhoneApprover({
    identity: nodeIdentity,
    nodeName: nodeConfig.name,
    approverStore,
    link: courier,
    auditLedger,
    ttlMs: (approvers.requestTtlS || 300) * 1000
  });
  courier.onMessage(async (method, params) => {
    if (method === 'approval.response') return approver.handleResponse(params.envelope);
    return null;
  });
  return {
    approver,
    auditLedger,
    courier,
    identity: nodeIdentity,
    stop() {
      approver.stop();
      courier.stop();
    }
  };
}

module.exports = { startApprovals, startMcpApprovals, createRelayDispatcher, trackDeviceStates, nullLink, RELAY_PIN_KEY };
```

In `src/service/config.js`, replace

```js
// Keys that decide whether a network listener exists and where it binds, and
// which profile — and so whether the agent stack loads at all. These may only
// come from the admin-owned config dir; see below.
const ADMIN_ONLY_KEYS = ['features', 'ports', 'profile'];
```

with

```js
// Keys that decide whether a network listener exists and where it binds, and
// which profile — and so whether the agent stack loads at all. These may only
// come from the admin-owned config dir; see below.
// `relay` (the relay's listeners, TLS files and push credentials) and `audit`
// (ledger retention) joined in fleet stage 3.
const ADMIN_ONLY_KEYS = ['features', 'ports', 'profile', 'relay', 'audit'];
const RELAY_DEFAULTS = { phoneListen: { host: '0.0.0.0', port: 8443 }, meshPort: 18795, auditRetentionDays: 365 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(obj, allowed, where, file) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${file}: ${where}.${key} is not a known key (expected ${allowed.join(', ')})`);
  }
}

function listenBlock(raw, where, file, { host = null, port }) {
  const value = raw === undefined ? {} : raw;
  if (!isPlainObject(value)) throw new Error(`Invalid ${file}: ${where} must be an object with host and port`);
  rejectUnknownKeys(value, ['host', 'port'], where, file);
  const out = { host: value.host === undefined ? host : value.host, port: value.port === undefined ? port : value.port };
  if (typeof out.host !== 'string' || !out.host) throw new Error(`Invalid ${file}: ${where}.host is required`);
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error(`Invalid ${file}: ${where}.port must be an integer from 1 to 65535`);
  return out;
}

function requiredString(value, where, file) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${file}: ${where} is required`);
  return value.trim();
}

// The relay host's block (spec §6). Returns the shape startRelay takes, or
// null when there is no relay block.
function parseRelayConfig(raw, file) {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "relay" must be an object`);
  rejectUnknownKeys(raw, ['phone_listen', 'tls', 'mesh_listen', 'public_url', 'push'], 'relay', file);
  if (!isPlainObject(raw.tls)) throw new Error(`Invalid ${file}: relay.tls with cert_file and key_file is required`);
  rejectUnknownKeys(raw.tls, ['cert_file', 'key_file'], 'relay.tls', file);
  const publicUrl = requiredString(raw.public_url, 'relay.public_url', file);
  if (!/^https:\/\//.test(publicUrl)) throw new Error(`Invalid ${file}: relay.public_url must be an https:// URL`);
  const push = {};
  if (raw.push !== undefined) {
    if (!isPlainObject(raw.push)) throw new Error(`Invalid ${file}: relay.push must be an object`);
    rejectUnknownKeys(raw.push, ['apns', 'fcm'], 'relay.push', file);
    if (raw.push.apns !== undefined) {
      const a = raw.push.apns;
      if (!isPlainObject(a)) throw new Error(`Invalid ${file}: relay.push.apns must be an object`);
      rejectUnknownKeys(a, ['team_id', 'key_id', 'key_file', 'topic', 'environment'], 'relay.push.apns', file);
      const environment = a.environment === undefined ? 'production' : a.environment;
      if (!['production', 'sandbox'].includes(environment)) throw new Error(`Invalid ${file}: relay.push.apns.environment must be production or sandbox`);
      push.apns = {
        teamId: requiredString(a.team_id, 'relay.push.apns.team_id', file),
        keyId: requiredString(a.key_id, 'relay.push.apns.key_id', file),
        keyFile: requiredString(a.key_file, 'relay.push.apns.key_file', file),
        topic: requiredString(a.topic, 'relay.push.apns.topic', file),
        environment
      };
    }
    if (raw.push.fcm !== undefined) {
      if (!isPlainObject(raw.push.fcm)) throw new Error(`Invalid ${file}: relay.push.fcm must be an object`);
      rejectUnknownKeys(raw.push.fcm, ['service_account_file'], 'relay.push.fcm', file);
      push.fcm = { serviceAccountFile: requiredString(raw.push.fcm.service_account_file, 'relay.push.fcm.service_account_file', file) };
    }
  }
  return {
    phoneListen: listenBlock(raw.phone_listen, 'relay.phone_listen', file, RELAY_DEFAULTS.phoneListen),
    tls: { certFile: requiredString(raw.tls.cert_file, 'relay.tls.cert_file', file), keyFile: requiredString(raw.tls.key_file, 'relay.tls.key_file', file) },
    meshListen: listenBlock(raw.mesh_listen, 'relay.mesh_listen', file, { host: null, port: RELAY_DEFAULTS.meshPort }),
    publicUrl,
    push
  };
}

function parseAuditConfig(raw, file) {
  if (raw === undefined) return { retentionDays: RELAY_DEFAULTS.auditRetentionDays };
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "audit" must be an object`);
  rejectUnknownKeys(raw, ['retention_days'], 'audit', file);
  const days = raw.retention_days === undefined ? RELAY_DEFAULTS.auditRetentionDays : raw.retention_days;
  if (!Number.isInteger(days) || days < 30) throw new Error(`Invalid ${file}: audit.retention_days must be an integer of at least 30`);
  return { retentionDays: days };
}
```

and replace the end of `loadServiceConfig` and the exports

```js
  return {
    profile,
    features,
    ports: { ...DEFAULT_PORTS, ...validatePorts(adminCfg.ports, adminFile) }
  };
}

module.exports = { loadServiceConfig, assertAdminOwned, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE };
```

with

```js
  return {
    profile,
    features,
    ports: { ...DEFAULT_PORTS, ...validatePorts(adminCfg.ports, adminFile) },
    relay: parseRelayConfig(adminCfg.relay, adminFile),
    audit: parseAuditConfig(adminCfg.audit, adminFile)
  };
}

module.exports = { loadServiceConfig, assertAdminOwned, parseRelayConfig, parseAuditConfig, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE };
```

In `src/service/node-config.js`, in `defaultNodeConfig`, replace

```js
    runbooksDir: path.join(adminDir, 'runbooks')
  };
}
```

with

```js
    runbooksDir: path.join(adminDir, 'runbooks'),
    approvers: { ...DEFAULT_APPROVERS }
  };
}

// Phone approvals (fleet stage 3): the relay's mesh endpoint and the request
// lifetime. Absent → phone approvals off.
const DEFAULT_APPROVERS = { relay: null, requestTtlS: 300 };
const RELAY_URL = /^wss:\/\/([^\s/:[\]]+|\[[0-9a-fA-F:]+\]):\d{1,5}\/?$/;

function parseApprovers(raw, invalid) {
  if (raw === undefined) return { ...DEFAULT_APPROVERS };
  if (!isPlainObject(raw)) throw invalid('approvers must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!['relay', 'request_ttl_s'].includes(key)) throw invalid(`approvers.${key} is not a known key (expected relay, request_ttl_s)`);
  }
  const out = { ...DEFAULT_APPROVERS };
  if (raw.relay !== undefined && raw.relay !== null) {
    if (typeof raw.relay !== 'string' || !RELAY_URL.test(raw.relay.trim())) throw invalid('approvers.relay must be wss://host:port');
    out.relay = raw.relay.trim();
  }
  if (raw.request_ttl_s !== undefined) {
    if (!Number.isInteger(raw.request_ttl_s) || raw.request_ttl_s < 30 || raw.request_ttl_s > 300) {
      throw invalid('approvers.request_ttl_s must be an integer from 30 to 300');
    }
    out.requestTtlS = raw.request_ttl_s;
  }
  return out;
}
```

and at the end of `loadNodeConfig` replace

```js
    runbooksDir
  };
}
```

with

```js
    runbooksDir,
    approvers: parseApprovers(parsed.approvers, invalid)
  };
}
```

**Conditional (F6, R11).** If `src/service/node-config.js` defines `NODE_YAML_KEYS` (F6's strict loader), add `'approvers'` to it; if `tests/examples.test.js` lists the allowed `node.yaml` keys, add `'approvers'` there too. On a branch without F6 neither exists — change nothing.

In `src/service/run.js`, replace the agent profile's start, from

```js
      async start({ dataDir, features, ports, workspace }) {
```

through

```js
        await core.start();
        try {
```

with

```js
      async start({ dataDir, features, ports, workspace, audit }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const { loadNodeConfig } = require('./node-config');
        const { startApprovals } = require('../approvals/service-wiring');
        const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        const nodeConfig = loadNodeConfig({ dataDir });
        // Fleet stage 3: an unsafe tool from anything remote (chat channels,
        // gateway clients, cron, webhooks) runs only with a signed phone
        // approval; with no enrolled phone or no relay it is refused.
        const approvals = await startApprovals({ dataDir, nodeConfig, ports: servicePorts, profile: 'agent', serviceConfig: { audit } });
        const core = createCore({
          ...servicePorts,
          features,
          ports,
          workingDirectory: workspace,
          remoteApprovals: 'phone',
          phoneApprover: approvals.phoneApprover,
          auditLedger: approvals.auditLedger,
          nodePolicy: nodeConfig.policy,
          builtinSkillsDir: path.join(__dirname, '..', '..', 'skills')
        });
        try {
          await core.start();
        } catch (err) {
          await approvals.stop().catch(() => {});
          throw err;
        }
        try {
```

then replace

```js
          await core.shutdown().catch(() => {});
          throw err;
        }
        return { stop: () => core.shutdown(), masterKeySource: servicePorts.masterKeySource };
```

with

```js
          await core.shutdown().catch(() => {});
          await approvals.stop().catch(() => {});
          throw err;
        }
        return {
          stop: async () => {
            await core.shutdown();
            await approvals.stop();
          },
          masterKeySource: servicePorts.masterKeySource,
          approvals
        };
```

Replace the runbook profile's start

```js
      async start({ dataDir }) {
        const { buildServicePorts } = require('./ports');
        const servicePorts = buildServicePorts({ dataDir });
        // Stage 2 adds the runbook engine here. Stage 1 only proves the
        // profile boots with its own identity-free, agent-free module graph.
        return { stop: async () => {}, masterKeySource: servicePorts.masterKeySource };
```

with

```js
      async start({ dataDir, audit }) {
        const { buildServicePorts } = require('./ports');
        const { loadNodeConfig } = require('./node-config');
        const { startApprovals } = require('../approvals/service-wiring');
        const servicePorts = buildServicePorts({ dataDir });
        // The runbook profile runs the relay link and the courier that the
        // `mcp` process sends its approval requests through; still no agent stack.
        const nodeConfig = loadNodeConfig({ dataDir });
        const approvals = await startApprovals({ dataDir, nodeConfig, ports: servicePorts, profile: 'runbook', serviceConfig: { audit } });
        return { stop: () => approvals.stop(), masterKeySource: servicePorts.masterKeySource, approvals };
```

In `runService`, replace

```js
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports, workspace });
```

with

```js
      running = await loadProfile(profile).start({ dataDir, features: config.features, ports: config.ports, workspace, audit: config.audit });
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-service-wiring.test.js tests/service-config.test.js tests/node-config.test.js tests/service-profile-graph.test.js tests/service-run.test.js tests/service-smoke.test.js`
Expected: PASS, `fail 0` (11 tests in `approvals-service-wiring.test.js`). Run without `KING_LOUIE_LOG_LEVEL=silent`: `tests/service-config.test.js` asserts on warnings.

- [ ] **Step 5: Commit**

```bash
git add src/approvals/service-wiring.js src/service/config.js src/service/node-config.js src/service/run.js tests/approvals-service-wiring.test.js tests/service-config.test.js tests/service-profile-graph.test.js
git commit -m "feat(service): start phone approvals in both profiles; relay, audit and approvers config

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(If the conditional F6 step changed `NODE_YAML_KEYS` or `tests/examples.test.js`, add those files too.)

---

### Task 21: The relay — node hub, routes, node methods, `startRelay`

**Files:**
- Create: `src/frontdoor/net.js`, `src/frontdoor/tls.js`, `src/frontdoor/extensions.js`, `src/frontdoor/node-hub.js`, `src/frontdoor/node-methods.js`, `src/frontdoor/routes.js`, `src/frontdoor/relay.js`
- Modify: `tests/service-profile-graph.test.js` (append a relay graph test)
- Test: `tests/frontdoor-relay.test.js`

**Interfaces:**
- Consumes: Tasks 17–19 (`DeviceRegistry`, `ApprovalCache`, `Invites`, `Mailbox`, `createPusher`, `createPhoneApi`, `ApiError`); `MeshTransport`, `MeshPairing` (Part 2, Task 13), `createLinkRpc`/`LinkRpcError`; `open`, `verifyEd25519`, `verifyEs256`, `deviceIdFromJwk`, `validateMessage`, `deriveNodeId`, `writeFileAtomic`. The test also uses `startApprovals` (Task 20), `FileCourier`, `ApproverAdmin`, `verifyConsoleEnrollment`, `buildEnrollOpen`/`buildEnrollDone`, `verifyAuditSlice`, `createFakePhone`.
- Produces (program P14/E1, P16/E3, P17): `startRelay({ dataDir, config, identity, listeners = 'own' | 'external', registry = null, extensions = RELAY_EXTENSIONS, useTls = true, senders = null, now }) → Promise<{ stop, address() → { phone, mesh }, phoneApi, phoneApiHandler, nodeHub, mailbox, pusher, devices, approvals, invites, phoneSpki }>` (`'external'` binds nothing); `RELAY_EXTENSIONS` = `src/frontdoor/extensions.js` (`module.exports = []`, each entry `(relay) => void` receiving `{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }`); `new NodeHub({ identity, transport, pairing, registryFile, peerSource = null, codesDir = null, codePollMs = 1000 })` with `start({ listen })`, `stop()`, `nodes() → [{ node_id, node_name, public_key, online }]`, `nodeById`, `nodeByPeer`, `nodeByName`, `addCode(nodeName) → { code, expires_at }` (throws `code: 'name_taken', status: 409`), `remove(nodeName)`, `rpc(nodeId, method, params, { timeoutMs })`, `notify(nodeId, method, params)`, `onNodeMessage(method, handler(params, { nodeId }))`, `onConnection(fn({ nodeId, connected }))`; `registerNodeMethods(relay) → { replayDeviceLog }`; `registerPhoneRoutes(relay)`; `assertPrivateMeshHost(host)`; `relaySpkiPin(certPem) → 'sha256/<b64url>'`.

Node → relay methods (spec §4.6): `relay.hello` (answers `{ relay_id, public_url, phone_spki }`, then replays the device log), `approval.submit` (verify, cache, push kind `approval` to the node's active devices), `approval.status`, `message.submit` (node-signed, a type registered with `mailbox.registerType`, else `type_not_routed`; optional push), `enroll.open`, `enroll.done` (registers the console-enrolled device as `active` on that node), `device.state`. Every envelope must be signed by the node on that link and name it. Phone routes: the §4.5 table, with `GET /v1/approvals` long-polling against a per-device cursor and `POST /v1/approvals/{id}/response` answering `202 { delivered, accepted, reason }` (`410 gone`, `403 forbidden`, `503 node_offline`). `relay code` files dropped in `<relayData>/relay/codes/` are picked up within a second.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-relay.test.js`:

```js
// tests/frontdoor-relay.test.js
//
// An in-process relay, real nodes (startApprovals with a RelayClient) and a
// fake phone over plain HTTP and WS (no TLS).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const { startRelay } = require('../src/frontdoor/relay');
const { assertPrivateMeshHost } = require('../src/frontdoor/net');
const { startApprovals } = require('../src/approvals/service-wiring');
const { FileCourier } = require('../src/approvals/courier');
const { ApproverAdmin } = require('../src/approvals/approver-admin');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { buildEnrollOpen, buildEnrollDone } = require('../src/approvals/messages');
const { open, seal, nodeSigner } = require('../src/approvals/envelope');
const { verifyAuditSlice } = require('../src/audit/audit-ledger');
const { createFakePhone } = require('./helpers/fake-phone');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

let relay;
let relayIdentity;
const pushes = [];
const base = () => `http://127.0.0.1:${relay.address().phone.port}`;

async function phoneCall(phone, method, p, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = phone ? { ...phone.signApi(method, p, text), 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  const res = await fetch(base() + p, { method, headers, body: method === 'GET' ? undefined : text });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

// A node: its own data and admin config dirs, paired with the relay, running
// startApprovals, with a service.pid naming this process so couriers work.
async function startNode(name, approverRecords = []) {
  const baseDir = tempDir(`kl-relay-node-${name}-`);
  const dataDir = path.join(baseDir, 'data');
  const configDir = path.join(baseDir, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) for (const d of [baseDir, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
  for (const r of approverRecords) fs.writeFileSync(path.join(configDir, 'approvers', `${r.device_id}.json`), JSON.stringify(r), { mode: 0o644 });
  fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));

  const identity = new NodeIdentity({ nodeName: name });
  const { code } = relay.nodeHub.addCode(name);
  const meshPort = relay.address().mesh.port;
  const pairing = new MeshPairing(identity, new MeshTransport({ identity, listen: false, useTls: false }), { timeoutMs: 5000 });
  const info = await pairing.acceptCode(code, '127.0.0.1', meshPort);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data' });
  store.set('approvals.relay', { relay_id: deriveNodeId(info.publicKey), peerId: info.peerId, publicKey: info.publicKey, tlsFingerprint: null, address: '127.0.0.1', port: meshPort, pairedAt: new Date().toISOString() });

  const approvals = await startApprovals({
    dataDir, configDir, nodeConfig: { name, approvers: { relay: `wss://127.0.0.1:${meshPort}`, requestTtlS: 300 }, policy: {} },
    ports: { store, cipher: createAesGcmCipher(crypto.randomBytes(32)) }, identity, useTls: false, approverStoreOptions: storeOptions, reconnectDelays: [50]
  });
  cleanups.push(() => approvals.stop());
  await until(() => approvals.relayClient.isConnected(), `${name} to link`);
  return { name, identity, dataDir, configDir, approvals };
}

before(async () => {
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
  const relayData = tempDir('kl-relay-data-');
  relay = await startRelay({
    dataDir: relayData,
    identity: relayIdentity,
    useTls: false,
    config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com:8443', tls: {}, push: {} },
    senders: [{ id: 'recording', platforms: ['apns'], notify: async (device, payload) => { pushes.push({ device: device.device_id, ...payload }); return { ok: true }; } }],
    extensions: [(r) => r.mailbox.registerType('kl.test.', { ttlMs: 60000 })]
  });
  cleanups.push(() => relay.stop());
});

describe('relay end to end', () => {
  const owner = createFakePhone({ name: 'Owner phone', platform: 'ios' });
  const second = createFakePhone({ name: 'Second phone' });
  let web;

  it('console enrollment: code opened by the node, claimed by the phone, confirmed at the console', async () => {
    web = await startNode('web-01');
    const courier = new FileCourier({ dataDir: web.dataDir, identity: web.identity, pollMs: 20 }).start();
    cleanups.push(() => courier.stop());
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    await courier.call('enroll.open', { envelope: buildEnrollOpen({ identity: web.identity, codeId, expiresAt: Date.now() + 600000 }) });
    const claimed = new Promise((resolve) => courier.onMessage(async (method, params) => { if (method === 'enroll.claim') resolve(params); }));
    const posted = await phoneCall(null, 'POST', `/v1/enroll/${codeId}`, owner.enroll({ codeId, code }));
    assert.deepEqual(posted, { status: 202, body: { state: 'waiting' } });
    const claim = await claimed;
    const check = verifyConsoleEnrollment(claim.envelope, { codeId, code });
    assert.equal(check.ok, true);
    const admin = new ApproverAdmin({ dir: path.join(web.configDir, 'approvers'), stagedDir: path.join(web.dataDir, 'approvals', 'staged'), ...storeOptions });
    admin.writeApprover({ ...owner.approverRecord({ enrollment: claim.envelope }), enrolled_at: new Date().toISOString() });
    await courier.call('enroll.done', { envelope: buildEnrollDone({ identity: web.identity, codeId, enroll: claim.envelope }) });
    assert.deepEqual((await phoneCall(null, 'GET', `/v1/enroll/${codeId}`)).body, { state: 'done', node: { node_id: web.identity.nodeId, node_name: 'web-01' } });
    web.approvals.approverStore.refresh();
    assert.equal(web.approvals.approverStore.isActive(owner.deviceId), true);
  });

  it('request → push → response → status, with long-poll wait', async () => {
    assert.equal((await phoneCall(owner, 'PUT', '/v1/push-token', { platform: 'apns', token: 'tok-owner' })).status, 204);
    await phoneCall(owner, 'GET', '/v1/approvals?wait=0');
    const started = Date.now();
    const idle = await phoneCall(owner, 'GET', '/v1/approvals?wait=1');
    assert.ok(Date.now() - started >= 900, 'nothing new: the call waited');
    assert.equal(idle.status, 200);

    const polling = phoneCall(owner, 'GET', '/v1/approvals?wait=10');
    const approved = web.approvals.phoneApprover.requestApproval('Bash', { command: 'systemctl restart site' }, { workingDirectory: '/srv/site' });
    const list = await polling;
    assert.equal(list.body.length, 1);
    const { envelope } = list.body[0];
    assert.ok(list.body[0].expires_in_ms > 290000);
    assert.equal(open(envelope).message.action.params.command, 'systemctl restart site');
    await until(() => pushes.length > 0, 'the push');
    assert.deepEqual(pushes[0], { device: owner.deviceId, kind: 'approval', id: open(envelope).message.request_id, node_name: 'web-01', expires_at: open(envelope).message.expires_at });

    const requestId = open(envelope).message.request_id;
    const res = await phoneCall(owner, 'POST', `/v1/approvals/${requestId}/response`, owner.respond(envelope, 'approve'));
    assert.deepEqual(res, { status: 202, body: { delivered: true, accepted: true, reason: null } });
    assert.equal(await approved, true);
    const after = await until(async () => {
      const r = await phoneCall(owner, 'GET', `/v1/approvals/${requestId}`);
      return r.body.status ? r : null;
    }, 'the status');
    assert.equal(open(after.body.status).message.state, 'approved');
    assert.equal((await phoneCall(owner, 'POST', `/v1/approvals/${crypto.randomUUID()}/response`, owner.respond(envelope, 'approve'))).status, 410);
  });

  it('signed enrollment and revocation are relayed, logged and staged on the node', async () => {
    const enrolled = await phoneCall(owner, 'POST', '/v1/devices/enroll', owner.enroll({ device: second.device() }));
    assert.deepEqual(enrolled.body, { nodes: [{ node_id: web.identity.nodeId, state: 'staged' }] });
    const revoked = await phoneCall(owner, 'POST', '/v1/devices/revoke', owner.revoke(second.deviceId));
    assert.deepEqual(revoked.body, { nodes: [{ node_id: web.identity.nodeId, state: 'revoked-pending-apply' }] });
    assert.equal(relay.devices.log().length, 2);
    assert.equal(fs.readdirSync(path.join(web.dataDir, 'approvals', 'staged')).filter((n) => n.endsWith('.json')).length, 2);
    const devicesList = await phoneCall(owner, 'GET', '/v1/devices');
    assert.ok(devicesList.body.some((d) => d.device_id === second.deviceId));
  });

  it('replays the device log to a node that pairs later', async () => {
    const gpu = await startNode('gpu-box', [owner.approverRecord()]);
    const staged = path.join(gpu.dataDir, 'approvals', 'staged');
    await until(() => fs.existsSync(staged) && fs.readdirSync(staged).filter((n) => n.endsWith('.json')).length === 2, 'the replayed log');
  });

  it('serves node-signed history slices', async () => {
    const res = await phoneCall(owner, 'GET', `/v1/nodes/${web.identity.nodeId}/history?limit=5`);
    const check = verifyAuditSlice(res.body, web.identity.publicKey.toString('hex'));
    assert.equal(check.ok, true);
    assert.ok(check.message.entries.length > 0 && check.message.entries.length <= 5);
    const nodes = await phoneCall(owner, 'GET', '/v1/nodes');
    assert.ok(nodes.body.every((n) => n.public_key === undefined), 'no keys in the node list');
  });

  it('message.submit reaches a registered type and refuses an unregistered one', async () => {
    const signer = nodeSigner(web.identity);
    const ok = await web.approvals.relayClient.send(seal({ v: 1, type: 'kl.test.ping', node_id: web.identity.nodeId, nonce: 'n'.repeat(43) }, signer), { push: { kind: 'lease', id: 'l-1' } });
    assert.equal(ok.ok, true);
    assert.equal(relay.mailbox.list({ nodeIds: [web.identity.nodeId] }).length, 1);
    await assert.rejects(web.approvals.relayClient.send(seal({ v: 1, type: 'kl.other.ping', node_id: web.identity.nodeId }, signer)), (err) => err.code === 'type_not_routed');
  });

  it('registerRoute replaces an earlier route, and registerMethod refuses reserved names', async () => {
    relay.phoneApi.registerRoute('POST', '/v1/pairing-codes', { auth: 'device', handler: async () => ({ body: { replaced: true } }) });
    assert.deepEqual((await phoneCall(owner, 'POST', '/v1/pairing-codes', { node_name: 'x' })).body, { replaced: true });
    assert.throws(() => web.approvals.relayClient.registerMethod('device.enroll', () => {}), (err) => err.code === 'method_reserved');
  });
});

describe('relay mesh listener exposure (ruling 8)', () => {
  it('accepts loopback and private IP literals only', () => {
    for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) assert.doesNotThrow(() => assertPrivateMeshHost(ok), ok);
    for (const bad of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', 'relay.example.com', '2001:db8::1', '']) {
      assert.throws(() => assertPrivateMeshHost(bad), /must be a loopback or private IP address until the stage 4 mesh hardening lands/, bad);
    }
  });
});
```

Append to `tests/service-profile-graph.test.js`:

```js

describe('relay module graph', () => {
  it('starting and stopping the relay loads no agent code', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-graph-'));
    try {
      const script = `
        const { startRelay } = require('./src/frontdoor/relay');
        const { NodeIdentity } = require('./src/mesh/node-identity');
        (async () => {
          const relay = await startRelay({
            dataDir: process.env.KL_GRAPH_DATA_DIR,
            identity: new NodeIdentity({ nodeName: 'relay' }),
            useTls: false,
            config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} }
          });
          await relay.stop();
          process.stdout.write(JSON.stringify(Object.keys(require.cache)));
        })().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_DATA_DIR: dataDir, KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/frontdoor/relay.js'));
      const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)) || p.startsWith('src/core/'));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/frontdoor-relay.test.js tests/service-profile-graph.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/relay'` (and the relay graph test failing the same way).

- [ ] **Step 3: Implement**

Create `src/frontdoor/net.js`:

```js
// Until F4's mesh hardening (auth before parse, ruling 8), MeshTransport
// parses a frame before it authenticates, so the relay's mesh listener may
// only bind a loopback or private IP literal.
const net = require('net');

const MESSAGE = 'relay.mesh_listen.host must be a loopback or private IP address until the stage 4 mesh hardening lands';

function ipv4Parts(host) {
  return host.split('.').map(Number);
}

function isPrivateV4(host) {
  const [a, b] = ipv4Parts(host);
  return a === 127 // loopback
    || a === 10 // RFC 1918
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254); // link-local
}

function isPrivateV6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 // ULA fc00::/7
    || (first & 0xffc0) === 0xfe80; // link-local fe80::/10
}

function assertPrivateMeshHost(host) {
  const kind = net.isIP(String(host || ''));
  if (kind === 0) throw new Error(`${MESSAGE} (got "${host}", not an IP literal)`);
  if (host === '0.0.0.0' || host === '::') throw new Error(`${MESSAGE} (got the wildcard "${host}")`);
  const ok = kind === 4 ? isPrivateV4(host) : isPrivateV6(host);
  if (!ok) throw new Error(`${MESSAGE} (got "${host}")`);
}

module.exports = { assertPrivateMeshHost };
```

Create `src/frontdoor/tls.js`:

```js
// The pin phones keep for the relay: SHA-256 over the leaf certificate's
// SubjectPublicKeyInfo DER, as `sha256/<base64url>`. Renewing the certificate
// with the same key keeps the pin.
const crypto = require('crypto');

function relaySpkiPin(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
  return `sha256/${crypto.createHash('sha256').update(spki).digest('base64url')}`;
}

module.exports = { relaySpkiPin };
```

Create `src/frontdoor/extensions.js`:

```js
// Relay extensions (program §4.13 "Mailbox", §5): one line per consumer stage.
// Each entry is (relay) => void and receives
//   { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }
// to register phone API routes (phoneApi.registerRoute), node methods
// (nodeHub.onNodeMessage) and mailbox types (mailbox.registerType). An
// extension must not require agent code: the relay loads no core, providers
// or tools. F5 adds its lease routes here, C4 its question routes.
module.exports = [];
```

Create `src/frontdoor/node-hub.js`:

```js
// The relay's side of the node links (E3): a MeshTransport listening on
// relay.mesh_listen, MeshPairing for first contact, and a registry of paired
// nodes (<relayData>/relay/nodes.json, unique by name). F4 can replace the
// registry file with its own peer source.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { deriveNodeId } = require('../mesh/node-identity');
const { createLinkRpc, LinkRpcError } = require('../approvals/link-rpc');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/node-hub');

class NodeHub extends EventEmitter {
  constructor({ identity, transport, pairing, registryFile, peerSource = null, codesDir = null, codePollMs = 1000 } = {}) {
    super();
    this.identity = identity;
    this.transport = transport;
    this.pairing = pairing;
    this.registryFile = registryFile;
    this.peerSource = peerSource;
    this.codesDir = codesDir;
    this.codePollMs = codePollMs;
    this.registry = [];
    this.handlers = new Map();
    this.rpcLink = createLinkRpc(transport);
    this.codeTimer = null;
    this._onChange = () => this._loadPeers();
  }

  _loadRegistry() {
    if (this.peerSource) return;
    try {
      this.registry = JSON.parse(fs.readFileSync(this.registryFile, 'utf8')).nodes || [];
    } catch {
      this.registry = [];
    }
  }

  _saveRegistry() {
    if (this.peerSource) return;
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.registryFile, `${JSON.stringify({ nodes: this.registry }, null, 2)}\n`);
  }

  // F4's peer source: { list() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }], on('change') }.
  _loadPeers() {
    if (this.peerSource) {
      this.registry = this.peerSource.list().map((p) => ({
        node_id: p.nodeId, node_name: p.name, public_key: p.publicKeyHex, peer_id: p.peerId, tls_fingerprint: p.tlsFingerprint || null, paired_at: null
      }));
    }
    for (const n of this.registry) {
      this.transport.addTrustedPeer(n.peer_id, n.public_key, { displayName: n.node_name, tlsFingerprint: n.tls_fingerprint || null });
    }
  }

  async start({ listen = true } = {}) {
    this._loadRegistry();
    this._loadPeers();
    if (this.peerSource && typeof this.peerSource.on === 'function') this.peerSource.on('change', this._onChange);
    this.transport.onPairingRequest = (ws, msg) => this._onPairingRequest(ws, msg);
    this.transport.on('peerConnected', (peer) => {
      const node = this.nodeByPeer(peer.peerId);
      if (node) this.emit('connection', { nodeId: node.node_id, connected: true });
    });
    this.transport.on('peerDisconnected', ({ peerId }) => {
      const node = this.nodeByPeer(peerId);
      if (node) this.emit('connection', { nodeId: node.node_id, connected: false });
    });
    this.rpcLink.onUnhandled((method, params, { peerId }) => {
      const node = this.nodeByPeer(peerId);
      if (!node) throw new LinkRpcError('unknown_node', 'this peer is not a paired node');
      const handler = this.handlers.get(method);
      if (!handler) throw new LinkRpcError('unknown_method', `the relay has no handler for ${method}`);
      return handler(params, { nodeId: node.node_id });
    });
    if (listen) await this.transport.start();
    if (this.codesDir) {
      this.codeTimer = setInterval(() => this._pickUpCodes(), this.codePollMs);
      if (typeof this.codeTimer.unref === 'function') this.codeTimer.unref();
      this._pickUpCodes();
    }
  }

  async stop() {
    clearInterval(this.codeTimer);
    if (this.peerSource && typeof this.peerSource.removeListener === 'function') this.peerSource.removeListener('change', this._onChange);
    this.rpcLink.close();
    this.pairing.cleanup();
    await this.transport.stop();
  }

  // `relay code <name>` drops { code, node_name, expires_at } files here.
  _pickUpCodes() {
    let names = [];
    try {
      names = fs.readdirSync(this.codesDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.codesDir, name);
      try {
        const { code, node_name: nodeName, expires_at: expiresAt } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.parse(expiresAt) > Date.now() && !this.nodeByName(nodeName)) this.pairing.addCode(code, { nodeName });
      } catch (err) {
        log.warn(`ignoring pairing code file ${name}: ${err.message}`);
      }
      try { fs.unlinkSync(file); } catch { /* gone */ }
    }
  }

  _onPairingRequest(ws, msg) {
    const info = this.pairing.handlePairingRequest(ws, msg);
    if (!info) return;
    const nodeName = (info.meta && info.meta.nodeName) || info.nodeName;
    const nodeId = deriveNodeId(info.publicKey);
    if (this.nodeByName(nodeName)) {
      log.warn(`pairing for "${nodeName}" ignored: name_taken`);
      this.transport.removeTrustedPeer(info.peerId);
      return;
    }
    this.registry.push({ node_id: nodeId, node_name: nodeName, public_key: info.publicKey, peer_id: info.peerId, tls_fingerprint: info.tlsFingerprint || null, paired_at: new Date().toISOString() });
    this._saveRegistry();
    log.info(`paired node ${nodeName} (${nodeId})`);
    this.emit('paired', { nodeId, nodeName });
  }

  nodes() {
    const online = new Set(this.transport.getConnectedPeers().map((p) => p.peerId));
    return this.registry.map((n) => ({ node_id: n.node_id, node_name: n.node_name, public_key: n.public_key, online: online.has(n.peer_id) }));
  }

  nodeById(nodeId) {
    return this.registry.find((n) => n.node_id === nodeId) || null;
  }

  nodeByPeer(peerId) {
    return this.registry.find((n) => n.peer_id === peerId) || null;
  }

  nodeByName(nodeName) {
    return this.registry.find((n) => n.node_name === nodeName) || null;
  }

  // → { code, expires_at }; a name already paired is name_taken.
  addCode(nodeName) {
    if (this.nodeByName(nodeName)) throw Object.assign(new Error(`a node named "${nodeName}" is already paired`), { code: 'name_taken', status: 409 });
    const { code } = this.pairing.generateCode({ nodeName });
    return { code, expires_at: new Date(Date.now() + this.pairing.timeoutMs).toISOString() };
  }

  remove(nodeName) {
    const node = this.nodeByName(nodeName);
    if (!node) return false;
    this.registry = this.registry.filter((n) => n !== node);
    this._saveRegistry();
    this.transport.removeTrustedPeer(node.peer_id);
    return true;
  }

  rpc(nodeId, method, params = {}, { timeoutMs = 10000 } = {}) {
    const node = this.nodeById(nodeId);
    if (!node) return Promise.reject(new LinkRpcError('unknown_node', `no node ${nodeId}`));
    return this.rpcLink.call(node.peer_id, method, params, { timeoutMs });
  }

  notify(nodeId, method, params = {}) {
    const node = this.nodeById(nodeId);
    if (node) this.rpcLink.notify(node.peer_id, method, params);
  }

  onNodeMessage(method, handler) {
    this.handlers.set(method, handler);
  }

  onConnection(fn) {
    this.on('connection', fn);
  }
}

module.exports = { NodeHub };
```

Create `src/frontdoor/node-methods.js`:

```js
// node → relay link methods (spec §4.6). Everything a node sends is checked
// against that node's key before the relay stores or forwards it; the relay
// never alters a signed message.
const { open, verifyEd25519 } = require('../approvals/envelope');
const { LinkRpcError } = require('../approvals/link-rpc');

function registerNodeMethods(relay) {
  const { nodeHub, approvals, devices, invites, mailbox, pusher, identity, log } = relay;

  // The envelope must be signed by the node on this link, about this node.
  const fromNode = (nodeId, envelope, type = null) => {
    const node = nodeHub.nodeById(nodeId);
    if (!node || !envelope || envelope.alg !== 'Ed25519' || envelope.kid !== nodeId || !verifyEd25519(envelope, node.public_key)) {
      throw new LinkRpcError('bad_signature', 'not signed by this node');
    }
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      throw new LinkRpcError('malformed', 'the envelope does not open');
    }
    if (type && message.type !== type) throw new LinkRpcError('malformed', `expected ${type}`);
    if (message.node_id !== undefined && message.node_id !== nodeId) throw new LinkRpcError('wrong_node', 'the message names another node');
    return { message, node };
  };

  const pushTo = (targets, payload) => {
    for (const device of targets) {
      pusher.notify(device, payload).catch((err) => log.warn(`push failed: ${err.message}`));
    }
  };

  // Every enrollment and revocation the relay relayed, so a node that was
  // offline catches up (it answers `duplicate` for what it already has).
  const replayDeviceLog = async (nodeId) => {
    for (const envelope of devices.log()) {
      let message;
      try {
        ({ message } = open(envelope));
      } catch {
        continue;
      }
      const method = message.type === 'kl.device.enroll' ? 'device.enroll' : 'device.revoke';
      const target = message.type === 'kl.device.enroll' ? message.device.device_id : message.device_id;
      try {
        const result = await nodeHub.rpc(nodeId, method, { envelope });
        if (result && result.state !== 'duplicate') devices.setNodeState(target, nodeId, result.state);
      } catch (err) {
        log.warn(`device log replay to ${nodeId} stopped: ${err.message}`);
        return;
      }
    }
  };

  nodeHub.onNodeMessage('relay.hello', async (params, { nodeId }) => {
    if (params.node_id !== nodeId) throw new LinkRpcError('wrong_node', 'relay.hello names another node');
    setImmediate(() => { replayDeviceLog(nodeId).catch((err) => log.warn(`replay failed: ${err.message}`)); });
    return { relay_id: identity.nodeId, public_url: relay.publicUrl, phone_spki: relay.phoneSpki };
  });

  nodeHub.onNodeMessage('approval.submit', async ({ envelope }, { nodeId }) => {
    const { message, node } = fromNode(nodeId, envelope, 'kl.approval.request');
    approvals.put(nodeId, envelope);
    pushTo(devices.devicesForNode(nodeId), { kind: 'approval', id: message.request_id, node_name: node.node_name, expires_at: message.expires_at });
    return { ok: true };
  });

  nodeHub.onNodeMessage('approval.status', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.approval.status');
    approvals.setStatus(message.request_id, envelope);
    return { ok: true };
  });

  nodeHub.onNodeMessage('message.submit', async ({ envelope, push = null, to_device: toDevice = null }, { nodeId }) => {
    const { node } = fromNode(nodeId, envelope);
    let result;
    try {
      result = mailbox.put(nodeId, envelope, { to_device: toDevice });
    } catch (err) {
      throw new LinkRpcError(err.code || 'error', err.message);
    }
    if (push && push.kind && push.id) {
      const targets = toDevice ? [devices.get(toDevice)].filter(Boolean) : devices.devicesForNode(nodeId);
      pushTo(targets, { kind: push.kind, id: push.id, node_name: node.node_name, expires_at: push.expires_at || null });
    }
    return { ok: true, seq: result.seq };
  });

  nodeHub.onNodeMessage('enroll.open', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.enroll.open');
    invites.openCode(message.code_id, nodeId, Date.parse(message.expires_at));
    return { ok: true };
  });

  nodeHub.onNodeMessage('enroll.done', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.enroll.done');
    const code = invites.getCode(message.code_id);
    if (!code || code.node_id !== nodeId) throw new LinkRpcError('unknown_code', 'this node did not open that code');
    if (message.refused || !message.enroll) {
      invites.closeCode(message.code_id, 'refused');
      return { ok: true };
    }
    const { message: enroll } = open(message.enroll);
    const d = enroll.device;
    devices.register({ device_id: d.device_id, jwk: d.public_key, name: d.name, platform: d.platform });
    devices.setNodeState(d.device_id, nodeId, 'active');
    invites.closeCode(message.code_id, 'done', message.enroll);
    return { ok: true };
  });

  nodeHub.onNodeMessage('device.state', async ({ device_id: deviceId, state }, { nodeId }) => {
    if (!['active', 'revoked'].includes(state)) throw new LinkRpcError('malformed', 'state must be active or revoked');
    devices.setNodeState(deviceId, nodeId, state);
    return { ok: true };
  });

  return { replayDeviceLog };
}

module.exports = { registerNodeMethods };
```

Create `src/frontdoor/routes.js`:

```js
// F3's phone API routes (spec §4.5), registered through the route registry
// like any extension's. The relay authenticates callers and forwards; nodes
// verify every signature again.
const { open, verifyEs256, deviceIdFromJwk } = require('../approvals/envelope');
const { validateMessage } = require('../approvals/messages');
const { ApiError } = require('./phone-api');

const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_WAIT_S = 25;

function parseEnvelope(body, type) {
  let message;
  try {
    ({ message } = open(body));
  } catch {
    throw new ApiError(400, 'malformed', 'the body is not a signed envelope');
  }
  if (validateMessage(type, message)) throw new ApiError(400, 'malformed', `the body is not a valid ${type}`);
  return message;
}

function registerPhoneRoutes(relay) {
  const { phoneApi, nodeHub, approvals, devices, invites } = relay;
  const now = relay.now || Date.now;
  const lastSeen = new Map();

  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);
  const toNode = async (nodeId, method, params) => {
    try {
      return await nodeHub.rpc(nodeId, method, params);
    } catch (err) {
      throw new ApiError(503, 'node_offline', `the node could not be reached (${err.code || err.message})`);
    }
  };
  const view = (entry) => ({ envelope: entry.envelope, expires_in_ms: Math.max(0, entry.expires_at - now()), status: entry.status });

  phoneApi.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { server_time: new Date(now()).toISOString() } }) });

  // Console enrollment: the phone posts its self-signed enroll for a code the
  // node opened; the node (not the relay) checks code_mac.
  phoneApi.registerRoute('POST', '/v1/enroll/{code_id}', {
    auth: 'code',
    handler: async (req, ctx) => {
      const message = parseEnvelope(ctx.body, 'kl.device.enroll');
      if (message.enrolled_by !== null || message.code_id !== ctx.params.code_id || !verifyEs256(ctx.body, message.device.public_key)) {
        throw new ApiError(400, 'bad_enroll', 'not a self-signed enrollment for this code');
      }
      const code = invites.claimCode(ctx.params.code_id, ctx.body);
      await toNode(code.node_id, 'enroll.claim', { code_id: ctx.params.code_id, envelope: ctx.body });
      return { status: 202, body: { state: 'waiting' } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/enroll/{code_id}', {
    auth: 'code',
    handler: async (req, ctx) => {
      const code = invites.getCode(ctx.params.code_id);
      const node = nodeHub.nodeById(code.node_id);
      return { body: { state: code.state, node: node ? { node_id: node.node_id, node_name: node.node_name } : null } };
    }
  });

  // Long poll: returns at once when something is new since this device's
  // last call, else waits up to `wait` seconds for a change.
  phoneApi.registerRoute('GET', '/v1/approvals', {
    auth: 'device',
    handler: async (req, ctx) => {
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(ctx.query.wait || '0', 10) || 0));
      const cursor = lastSeen.get(ctx.deviceId) || 0;
      if (wait > 0 && approvals.seq <= cursor) await approvals.waitForChange(cursor, wait * 1000);
      lastSeen.set(ctx.deviceId, approvals.seq);
      return { body: approvals.list(activeNodes(ctx.deviceId)).map(view) };
    }
  });

  phoneApi.registerRoute('GET', '/v1/approvals/{request_id}', {
    auth: 'device',
    handler: async (req, ctx) => {
      const entry = approvals.get(ctx.params.request_id);
      if (!entry || !activeNodes(ctx.deviceId).includes(entry.node_id)) throw new ApiError(404, 'not_found', 'no such request');
      return { body: view(entry) };
    }
  });

  phoneApi.registerRoute('POST', '/v1/approvals/{request_id}/response', {
    auth: 'device',
    handler: async (req, ctx) => {
      const entry = approvals.get(ctx.params.request_id);
      if (!entry || now() > entry.expires_at) throw new ApiError(410, 'gone', 'the request expired or is unknown');
      if (!activeNodes(ctx.deviceId).includes(entry.node_id)) throw new ApiError(403, 'forbidden', 'this device is not an approver on that node');
      const result = await toNode(entry.node_id, 'approval.response', { envelope: ctx.body });
      return { status: 202, body: { delivered: true, accepted: result && result.accepted !== undefined ? result.accepted : null, reason: (result && result.reason) || null } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/nodes', {
    auth: 'device',
    handler: async () => ({ body: nodeHub.nodes().map(({ node_id, node_name, online }) => ({ node_id, node_name, online })) })
  });

  phoneApi.registerRoute('GET', '/v1/nodes/{node_id}/history', {
    auth: 'device',
    handler: async (req, ctx) => {
      if (!activeNodes(ctx.deviceId).includes(ctx.params.node_id)) throw new ApiError(404, 'not_found', 'no such node for this device');
      const params = { limit: Math.min(200, Math.max(1, Number.parseInt(ctx.query.limit || '50', 10) || 50)) };
      if (ctx.query.before_seq) params.before_seq = Number.parseInt(ctx.query.before_seq, 10);
      const result = await toNode(ctx.params.node_id, 'audit.slice', params);
      return { body: result.envelope };
    }
  });

  // Re-bindable (E8): F4 registers its own handler for the same route.
  phoneApi.registerRoute('POST', '/v1/pairing-codes', {
    auth: 'device',
    handler: async (req, ctx) => {
      const nodeName = ctx.body && ctx.body.node_name;
      if (typeof nodeName !== 'string' || !NODE_NAME_RE.test(nodeName)) throw new ApiError(400, 'bad_node_name', 'node_name must be 1–64 of A–Z, a–z, 0–9, . _ -');
      return { body: nodeHub.addCode(nodeName) };
    }
  });

  phoneApi.registerRoute('POST', '/v1/devices/invites', {
    auth: 'device',
    handler: async (req, ctx) => ({ body: invites.createInvite(ctx.deviceId) })
  });

  phoneApi.registerRoute('POST', '/v1/devices/invites/{id}/claim', {
    auth: 'invite',
    handler: async (req, ctx) => {
      const { device, mac } = ctx.body || {};
      const valid = device && typeof device === 'object' && typeof mac === 'string'
        && ['ios', 'android'].includes(device.platform) && typeof device.name === 'string' && device.name.length <= 64
        && (() => { try { return deviceIdFromJwk(device.public_key) === device.device_id; } catch { return false; } })();
      if (!valid) throw new ApiError(400, 'bad_device', 'claim needs { device: { device_id, name, platform, public_key }, mac }');
      invites.claim(ctx.params.id, { device, mac });
      return { status: 202, body: {} };
    }
  });

  phoneApi.registerRoute('GET', '/v1/devices/invites/{id}', {
    auth: 'device',
    handler: async (req, ctx) => {
      try {
        return { body: { claim: invites.getClaim(ctx.params.id, ctx.deviceId) } };
      } catch (err) {
        if (err.code === 'forbidden') throw new ApiError(403, 'forbidden', err.message);
        throw new ApiError(404, err.code || 'not_found', err.message);
      }
    }
  });

  // Signed enrollment of a new phone by an enrolled one: logged, then sent to
  // every node the signer approves on, which stage it for `device apply`.
  phoneApi.registerRoute('POST', '/v1/devices/enroll', {
    auth: 'device',
    handler: async (req, ctx) => {
      const message = parseEnvelope(ctx.body, 'kl.device.enroll');
      if (message.enrolled_by !== ctx.deviceId || ctx.body.kid !== ctx.deviceId || !verifyEs256(ctx.body, ctx.device.jwk)) {
        throw new ApiError(400, 'bad_enroll', 'the enrollment must be signed by the calling device');
      }
      const d = message.device;
      devices.register({ device_id: d.device_id, jwk: d.public_key, name: d.name, platform: d.platform });
      devices.appendLog(ctx.body);
      const nodes = [];
      for (const nodeId of activeNodes(ctx.deviceId)) {
        let state = 'offline';
        try {
          state = (await nodeHub.rpc(nodeId, 'device.enroll', { envelope: ctx.body })).state;
        } catch {
          state = 'offline';
        }
        if (state !== 'duplicate' && state !== 'offline') devices.setNodeState(d.device_id, nodeId, state);
        nodes.push({ node_id: nodeId, state });
      }
      return { body: { nodes } };
    }
  });

  phoneApi.registerRoute('POST', '/v1/devices/revoke', {
    auth: 'device',
    handler: async (req, ctx) => {
      const message = parseEnvelope(ctx.body, 'kl.device.revoke');
      if (message.revoked_by !== ctx.deviceId || ctx.body.kid !== ctx.deviceId || !verifyEs256(ctx.body, ctx.device.jwk)) {
        throw new ApiError(400, 'bad_revoke', 'the revocation must be signed by the calling device');
      }
      devices.appendLog(ctx.body);
      const nodes = [];
      for (const { node_id: nodeId } of devices.nodesForDevice(message.device_id)) {
        let state = 'offline';
        try {
          state = (await nodeHub.rpc(nodeId, 'device.revoke', { envelope: ctx.body })).state;
        } catch {
          state = 'offline';
        }
        if (state === 'revoked-pending-apply') devices.setNodeState(message.device_id, nodeId, state);
        nodes.push({ node_id: nodeId, state });
      }
      return { body: { nodes } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/devices', {
    auth: 'device',
    handler: async () => ({
      body: devices.list().map((d) => ({ device_id: d.device_id, name: d.name, platform: d.platform, nodes: devices.nodesForDevice(d.device_id) }))
    })
  });

  phoneApi.registerRoute('PUT', '/v1/push-token', {
    auth: 'device',
    handler: async (req, ctx) => {
      const { platform, token } = ctx.body || {};
      if (!['apns', 'fcm'].includes(platform) || typeof token !== 'string' || !token || token.length > 4096) {
        throw new ApiError(400, 'bad_push_token', 'body is { platform: apns|fcm, token }');
      }
      devices.setPush(ctx.deviceId, { platform, token });
      return { status: 204 };
    }
  });
}

module.exports = { registerPhoneRoutes };
```

Create `src/frontdoor/relay.js`:

```js
// startRelay (E1): the relay subset of the stage 4 front door. No core,
// providers, tools or agent code; its own NodeIdentity. With listeners
// 'external' it binds nothing and F4 mounts phoneApiHandler and the node hub
// on its own listeners.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { createLogger } = require('../logging');
const { MeshTransport } = require('../mesh/mesh-transport');
const { MeshPairing } = require('../mesh/mesh-pairing');
const { DeviceRegistry } = require('./device-registry');
const { ApprovalCache } = require('./approval-cache');
const { Invites } = require('./invites');
const { Mailbox } = require('./mailbox');
const { createPusher } = require('./push');
const { createPhoneApi } = require('./phone-api');
const { NodeHub } = require('./node-hub');
const { registerPhoneRoutes } = require('./routes');
const { registerNodeMethods } = require('./node-methods');
const { assertPrivateMeshHost } = require('./net');
const { relaySpkiPin } = require('./tls');
const RELAY_EXTENSIONS = require('./extensions');

const log = createLogger('frontdoor/relay');
const SWEEP_MS = 30000;

// config: { phoneListen: { host, port }, tls: { certFile, keyFile }, meshListen: { host, port }, publicUrl, push: { apns?, fcm? } }
async function startRelay({ dataDir, config, identity, listeners = 'own', registry = null, extensions = RELAY_EXTENSIONS,
  useTls = true, senders = null, now = Date.now } = {}) {
  if (!['own', 'external'].includes(listeners)) throw new TypeError("listeners must be 'own' or 'external'");
  assertPrivateMeshHost(config.meshListen.host);
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(path.join(relayDir, 'codes'), { recursive: true, mode: 0o700 });

  let cert = null;
  let key = null;
  let phoneSpki = null;
  if (useTls) {
    cert = fs.readFileSync(config.tls.certFile, 'utf8');
    key = fs.readFileSync(config.tls.keyFile, 'utf8');
    phoneSpki = relaySpkiPin(cert);
  }

  const devices = new DeviceRegistry({ file: path.join(relayDir, 'devices.json'), now });
  const approvals = new ApprovalCache({ now });
  const invites = new Invites({ now });
  const mailbox = new Mailbox({ now });
  const pusher = createPusher(config.push || {}, {
    ...(senders ? { senders } : {}),
    onDropToken: (device) => devices.setPush(device.device_id, null)
  });
  const transport = new MeshTransport({ identity, host: config.meshListen.host, port: config.meshListen.port, useTls });
  const pairing = new MeshPairing(identity, transport);
  const nodeHub = new NodeHub({ identity, transport, pairing, registryFile: path.join(relayDir, 'nodes.json'), peerSource: registry, codesDir: path.join(relayDir, 'codes') });

  const relay = { identity, config, publicUrl: config.publicUrl, phoneSpki, devices, approvals, invites, mailbox, pusher, nodeHub, log, now };
  const phoneApi = createPhoneApi({ devices, relay, now });
  relay.phoneApi = phoneApi;
  registerPhoneRoutes(relay);
  registerNodeMethods(relay);
  for (const extension of extensions) extension({ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log });

  await nodeHub.start({ listen: listeners === 'own' });
  let server = null;
  if (listeners === 'own') {
    server = useTls ? https.createServer({ cert, key }, phoneApi.handler) : http.createServer(phoneApi.handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.phoneListen.port, config.phoneListen.host, resolve);
    });
  }
  const sweeper = setInterval(() => { approvals.sweep(); mailbox.sweep(); invites.sweep(); }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
  log.info(`relay ${identity.nodeId} ready`, { phone: server ? server.address() : null, mesh: listeners === 'own' ? transport.port : null, push: pusher.senders });

  return {
    phoneApi,
    phoneApiHandler: phoneApi.handler,
    nodeHub,
    mailbox,
    pusher,
    devices,
    approvals,
    invites,
    phoneSpki,
    address() {
      return {
        phone: server ? { host: config.phoneListen.host, port: server.address().port } : null,
        mesh: listeners === 'own' ? { host: config.meshListen.host, port: transport.port } : null
      };
    },
    async stop() {
      clearInterval(sweeper);
      if (server) await new Promise((resolve) => server.close(resolve));
      await nodeHub.stop();
    }
  };
}

module.exports = { startRelay, RELAY_EXTENSIONS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/frontdoor-relay.test.js tests/service-profile-graph.test.js tests/electron-boundary.test.js`
Expected: PASS, `fail 0` (8 tests in `frontdoor-relay.test.js`: console enrollment; request → push → response → status with long-poll `wait`; signed enrollment and revocation; device-log replay to a late node; history slices; `message.submit` routed and refused; `registerRoute` replacement and `registerMethod` refusal; the mesh-host rule).

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/net.js src/frontdoor/tls.js src/frontdoor/extensions.js src/frontdoor/node-hub.js src/frontdoor/node-methods.js src/frontdoor/routes.js src/frontdoor/relay.js tests/frontdoor-relay.test.js tests/service-profile-graph.test.js
git commit -m "feat(frontdoor): phone-approval relay — node hub, phone routes, device log replay, extensions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: `pair`, `enroll-device`, `device`, `relay`, `mcp` approvals and `doctor`

**Files:**
- Create: `src/service/commands/io.js`, `src/service/commands/pair.js`, `src/service/commands/devices.js`, `src/service/commands/relay.js`
- Modify: `src/service/cli.js` — `HELP` (`:16-17`), `BOOLEAN_FLAGS` (`:32`), the `mcp` case (`:277-298`), the `pair` case (`:309-339`, replaced, plus three new cases)
- Modify: `src/service/doctor.js` — end of `runDoctor` (`:48-52`) and a new function before `module.exports`
- Modify: `package.json`, `package-lock.json` (via `npm install qrcode@1.5.4 --save`)
- Test: `tests/service-cli-devices.test.js`, `tests/service-cli-relay.test.js`, `tests/deps-qrcode.test.js`

**Interfaces:**
- Consumes: `startRelay`, `assertPrivateMeshHost`, `relaySpkiPin` (Task 21); `startMcpApprovals` (Task 20); `FileCourier`, `CourierPump` (Part 2); `ApproverAdmin`, `ApproverStore`, `checkApproverDir`, `verifyConsoleEnrollment`, `AuditLedger`, `buildEnrollOpen`, `buildEnrollDone`, `encodeQr`, `decodeQr`, `fingerprintGroups` (Part 1); `MeshTransport`, `MeshPairing`, `WORDLIST`, `getOrGenerateNodeIdentity`, `deriveNodeId`; `loadServiceConfig`, `loadNodeConfig`, `buildServicePorts`, `acquireInstanceLock`, `readPidfile`, `isRunning`, `restoreDataDirOwnership`; `qrcode` (`toString(text, { type: 'terminal', small: true })`).
- Produces: `readLine(stdin)`, `runningServicePid(dataDir)`, `renderQr(text)` (`commands/io.js`); `runPair({ url, dataDir, io, deps: { useTls, code, timeoutMs } })`, `USAGE` (`commands/pair.js`, which F4 extends for `https://`); `runEnrollDevice({ dataDir, configDir, io, deps: { now, timeoutMs, pollMs, renderQr, storeOptions, allowTestKeys } })`, `runDevice({ sub, arg, flags, dataDir, configDir, io, deps })`, `DEVICE_HELP` (`commands/devices.js`); `runRelayCommand({ sub, arg, dataDir, io, deps: { loadConfig, useTls, signal, now, renderQr } })`, `RELAY_HELP`, `CODE_TTL_MS` (`commands/relay.js`). CLI: `enroll-device`, `device list|revoke <id>|apply [--yes]`, `relay run|code <name>|nodes|remove-node <name>|qr`, `pair wss://host:port` (code on stdin), and `mcp` now passes `approver` and `auditLedger` (writer `mcp`) to `StdioMcpServer`. `doctor` adds the checks `approvers dir is writable only by an administrator`, `active phone approvers`, `relay paired and linked`, `audit ledger chain`.

`enroll-device` (spec §3.10): refuses with `Run this as root/Administrator: <dir> is not writable.`, `The King Louie service is not running on this node…`, `approvers.relay is not set in <configDir>/node.yaml.`, or `The service is not linked to its relay yet…`; opens a 10-minute code through the courier, prints the `kl.pair` QR (`relay`, `relay_spki`, `code_id`, `code`, `node: { id, name, key }`), its text form (`Or paste this into the app: kl1:…`) and the relay fingerprint; waits for the phone's claim; verifies it (`verifyConsoleEnrollment`); asks `Device "<name>" (<platform>) d-abcd efgh ijkl mnop — does the phone show the same? [y/N]`; on `y` writes the approver file (`enrolled_by: "console"`), audits `device.enrolled` (writer `cli`) and sends `enroll.done`; otherwise sends `refused: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/service-cli-devices.test.js`:

```js
// tests/service-cli-devices.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { main } = require('../src/service/cli');
const { runEnrollDevice, runDevice } = require('../src/service/commands/devices');
const { CourierPump } = require('../src/approvals/courier');
const { ApproverStore } = require('../src/approvals/approver-store');
const { decodeQr } = require('../src/approvals/messages');
const { open } = require('../src/approvals/envelope');
const { AuditLedger } = require('../src/audit/audit-ledger');
const { runDoctor } = require('../src/service/doctor');
const { buildServicePorts } = require('../src/service/ports');
const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { createFakePhone } = require('./helpers/fake-phone');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

// A node: data dir, admin config dir with node.yaml, approvers/ and (unless
// told otherwise) a running service (this process's pid) linked to its relay.
function node({ relay = true, running = true, linked = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-devices-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) for (const d of [base, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
  fs.writeFileSync(path.join(configDir, 'node.yaml'), `name: web-01\n${relay ? 'approvers:\n  relay: wss://10.0.0.5:18795\n' : ''}`, { mode: 0o644 });
  if (running) fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
  if (linked) {
    fs.mkdirSync(path.join(dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: null, relay_id: 'kl-nt4ritcfj5kepq3y', relay_public_url: 'https://kl.example.com:8443', relay_spki: 'sha256/test' }));
  }
  return { base, dataDir, configDir };
}

// The running service's side of the courier, with a relay that records calls.
function servicePump(n) {
  const ports = buildServicePorts({ dataDir: n.dataDir });
  const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'web-01');
  const calls = [];
  const pump = new CourierPump({ dataDir: n.dataDir, relayClient: { call: async (method, params) => { calls.push([method, params]); return { ok: true }; } }, identity, pollMs: 10 }).start();
  cleanups.push(() => pump.stop());
  return { pump, calls, identity };
}

const deps = { storeOptions, renderQr: async () => '[QR]', pollMs: 10, timeoutMs: 5000 };

async function waitFor(check, what) {
  for (let i = 0; i < 400; i += 1) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('enroll-device refusals', () => {
  it('needs a writable approvers dir, a running service, approvers.relay and a linked relay', async () => {
    const blocked = node();
    fs.rmSync(path.join(blocked.configDir, 'approvers'), { recursive: true });
    fs.writeFileSync(path.join(blocked.configDir, 'approvers'), 'not a dir');
    let io = streamIo();
    assert.equal(await runEnrollDevice({ ...blocked, io, deps }), 1);
    assert.match(io.text.err, /Run this as root\/Administrator: .* is not writable\./);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ running: false }), io, deps }), 1);
    assert.match(io.text.err, /The King Louie service is not running on this node/);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ relay: false }), io, deps }), 1);
    assert.match(io.text.err, /approvers\.relay is not set in .*node\.yaml/);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ linked: false }), io, deps }), 1);
    assert.match(io.text.err, /not linked to its relay yet/);
  });
});

describe('enroll-device', () => {
  async function enroll(answer) {
    const n = node();
    const { pump, calls } = servicePump(n);
    const io = streamIo();
    const phone = createFakePhone({ name: 'Pixel 9' });
    const running = runEnrollDevice({ ...n, io, deps });
    const text = await waitFor(() => /Or paste this into the app: (kl1:\S+)/.exec(io.text.out), 'the pairing code');
    const qr = decodeQr(text[1]);
    assert.equal(qr.t, 'kl.pair');
    assert.equal(qr.relay, 'https://kl.example.com:8443');
    assert.equal(qr.relay_spki, 'sha256/test');
    assert.match(io.text.out, /Relay fingerprint: nt4r itcf j5ke pq3y/);
    assert.ok(calls.some(([m]) => m === 'enroll.open'));
    const envelope = phone.enroll({ codeId: qr.code_id, code: qr.code });
    const inbox = pump.routeFor('enroll.claim', { code_id: qr.code_id });
    pump.deliver(inbox, 'enroll.claim', { code_id: qr.code_id, envelope });
    await waitFor(() => /does the phone show the same\? \[y\/N\]/.test(io.text.out), 'the prompt');
    assert.match(io.text.out, new RegExp(`Device "Pixel 9" \\(android\\) d-${phone.deviceId.slice(2, 6)} `));
    io.stdin.write(`${answer}\n`);
    const code = await running;
    await waitFor(() => calls.some(([m]) => m === 'enroll.done'), 'enroll.done');
    const done = open(calls.find(([m]) => m === 'enroll.done')[1].envelope).message;
    return { n, code, io, phone, done };
  }

  it('y writes the approver, audits it, and tells the relay', async () => {
    const { n, code, phone, done } = await enroll('y');
    assert.equal(code, 0);
    const record = JSON.parse(fs.readFileSync(path.join(n.configDir, 'approvers', `${phone.deviceId}.json`), 'utf8'));
    assert.equal(record.enrolled_by, 'console');
    assert.equal(record.name, 'Pixel 9');
    assert.equal(done.refused, false);
    assert.equal(open(done.enroll).message.device.device_id, phone.deviceId);
    const ledger = new AuditLedger({ dir: path.join(n.dataDir, 'audit'), nodeId: null });
    assert.deepEqual(ledger.tail(1).map((e) => [e.kind, e.writer, e.data.device_id]), [['device.enrolled', 'cli', phone.deviceId]]);
  });

  it('anything but y refuses and writes nothing', async () => {
    const { n, code, phone, done } = await enroll('n');
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(n.configDir, 'approvers', `${phone.deviceId}.json`)), false);
    assert.equal(done.refused, true);
  });
});

describe('device list | revoke | apply', () => {
  it('apply --yes enrolls a staged device, list shows it, revoke ends it', async () => {
    const n = node();
    const a = createFakePhone({ name: 'Owner phone' });
    const b = createFakePhone({ name: 'Second phone', platform: 'ios' });
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir: path.join(n.dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    assert.equal(store.stage(a.enroll({ device: b.device() })).state, 'staged');

    let io = streamIo();
    assert.equal(await runDevice({ sub: 'apply', flags: { yes: true }, ...n, io, deps }), 0);
    assert.match(io.text.out, new RegExp(`enroll  ${b.deviceId}  signed by ${a.deviceId}`));
    assert.match(io.text.out, new RegExp(`${b.deviceId}: enrolled`));

    io = streamIo();
    assert.equal(await runDevice({ sub: 'list', ...n, io, deps }), 0);
    assert.match(io.text.out, new RegExp(`${b.deviceId}  Second phone \\(ios\\)  active  enrolled by ${a.deviceId}`));

    io = streamIo();
    assert.equal(await runDevice({ sub: 'revoke', arg: b.deviceId, ...n, io, deps }), 0);
    const record = JSON.parse(fs.readFileSync(path.join(n.configDir, 'approvers', `${b.deviceId}.json`), 'utf8'));
    assert.equal(record.revoked_by, 'console');
    io = streamIo();
    await runDevice({ sub: 'list', ...n, io, deps });
    assert.match(io.text.out, new RegExp(`${b.deviceId}.*revoked`));
  });

  it('apply without --yes asks, and a no changes nothing', async () => {
    const n = node();
    const a = createFakePhone();
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir: path.join(n.dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    store.stage(a.enroll({ device: createFakePhone().device() }));
    const io = streamIo();
    const running = runDevice({ sub: 'apply', flags: {}, ...n, io, deps });
    await waitFor(() => /Apply these\? \[y\/N\]/.test(io.text.out), 'the question');
    io.stdin.write('n\n');
    assert.equal(await running, 0);
    assert.match(io.text.out, /Nothing applied\./);
    assert.equal(fs.readdirSync(path.join(n.dataDir, 'approvals', 'staged')).filter((f) => f.endsWith('.json')).length, 1);
  });

  it('revoke of an unknown device fails, and the CLI dispatches device and prints usage', async () => {
    const n = node();
    const io = streamIo();
    assert.equal(await runDevice({ sub: 'revoke', arg: 'd-aaaaaaaaaaaaaaaa', ...n, io, deps }), 1);
    assert.match(io.text.err, /No approver d-aaaaaaaaaaaaaaaa/);
    const usage = streamIo();
    assert.equal(await main(['device', 'frobnicate', '--data-dir', n.dataDir], usage), 2);
    assert.match(usage.text.err, /Usage: king-louie-service device list/);
  });
});

describe('doctor', () => {
  it('reports the approver dir, the relay link and the audit chain', async () => {
    const n = node();
    const ledger = new AuditLedger({ dir: path.join(n.dataDir, 'audit'), nodeId: 'kl-aaaaaaaaaaaaaaaa' });
    await ledger.append({ kind: 'x', data: { i: 1 } });
    await ledger.append({ kind: 'x', data: { i: 2 } });
    const byCheck = (results) => Object.fromEntries(results.map((r) => [r.check, r]));
    let results = byCheck(runDoctor({ dataDir: n.dataDir, platform: 'linux' }));
    assert.equal(results['audit ledger chain'].ok, true);
    // On POSIX this test's node.yaml is not root-owned, so the check fails
    // there and says why; on Windows the link.json above is what it reads.
    if (!POSIX) assert.equal(results['relay paired and linked'].ok, true);
    assert.ok(results['relay paired and linked'].detail);
    assert.ok(results['approvers dir is writable only by an administrator']);
    const seg = fs.readdirSync(path.join(n.dataDir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const file = path.join(n.dataDir, 'audit', seg);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"i":2', '"i":3'));
    results = byCheck(runDoctor({ dataDir: n.dataDir, platform: 'linux' }));
    assert.equal(results['audit ledger chain'].ok, false);
    assert.match(results['audit ledger chain'].detail, /broken at seq 2/);
  });
});
```

Create `tests/service-cli-relay.test.js`:

```js
// tests/service-cli-relay.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { runRelayCommand } = require('../src/service/commands/relay');
const { runPair } = require('../src/service/commands/pair');
const { startRelay } = require('../src/frontdoor/relay');
const { relaySpkiPin } = require('../src/frontdoor/tls');
const { decodeQr } = require('../src/approvals/messages');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { JsonFileStore } = require('../src/platform/json-file-store');

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-relay-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { base, dataDir };
}

const relayConfig = (meshHost, extra = {}) => ({
  phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: meshHost, port: 0 },
  tls: { certFile: 'unused', keyFile: 'unused' }, publicUrl: 'https://kl.example.com:8443', push: {}, ...extra
});

describe('relay run', () => {
  it('refuses a wildcard, a hostname and a public mesh host', async () => {
    for (const host of ['0.0.0.0', '::', 'relay.example.com', '8.8.8.8']) {
      const io = streamIo();
      const code = await runRelayCommand({ sub: 'run', dataDir: dirs().dataDir, io, deps: { loadConfig: () => ({ relay: relayConfig(host) }) } });
      assert.equal(code, 1, host);
      assert.match(io.text.err, /relay\.mesh_listen\.host must be a loopback or private IP address until the stage 4 mesh hardening lands/);
    }
  });

  it('says so when there is no relay block', async () => {
    const io = streamIo();
    assert.equal(await runRelayCommand({ sub: 'run', dataDir: dirs().dataDir, io, deps: { loadConfig: () => ({ relay: null }) } }), 1);
    assert.match(io.text.err, /no "relay" block/);
  });

  it('starts, prints a ready line with the fingerprint, and stops on abort', async () => {
    const { dataDir } = dirs();
    const io = streamIo();
    const controller = new AbortController();
    const running = runRelayCommand({ sub: 'run', dataDir, io, deps: { useTls: false, signal: controller.signal, loadConfig: () => ({ relay: relayConfig('127.0.0.1') }) } });
    for (let i = 0; i < 500 && !io.text.out.includes('"event":"ready"'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const ready = JSON.parse(io.text.out.trim().split('\n').pop());
    assert.match(ready.relay_id, /^kl-[a-z2-7]{16}$/);
    assert.equal(ready.fingerprint, ready.relay_id.slice(3).match(/.{4}/g).join(' '));
    assert.ok(ready.mesh.port > 0 && ready.phone.port > 0);
    controller.abort();
    assert.equal(await running, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'service.pid')), false);
  });
});

describe('relay code / nodes / remove-node / qr', () => {
  it('code drops a one-time code for the running relay and refuses a taken or bad name', async () => {
    const { dataDir } = dirs();
    const io = streamIo();
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir, io }), 0);
    const code = /Pairing code for web-01: ((?:[a-z]+ ){5}[a-z]+)/.exec(io.text.out)[1];
    const files = fs.readdirSync(path.join(dataDir, 'relay', 'codes'));
    assert.equal(files.length, 1);
    const dropped = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'codes', files[0]), 'utf8'));
    assert.equal(dropped.code, code);
    assert.equal(dropped.node_name, 'web-01');
    fs.writeFileSync(path.join(dataDir, 'relay', 'nodes.json'), JSON.stringify({ nodes: [{ node_id: 'kl-aaaaaaaaaaaaaaaa', node_name: 'web-01', public_key: 'x', peer_id: 'kl-x', paired_at: '2026-09-23T18:00:00.000Z' }] }));
    const taken = streamIo();
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir, io: taken }), 1);
    assert.match(taken.text.err, /name_taken/);
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'bad name!', dataDir, io: streamIo() }), 2);

    const nodes = streamIo();
    await runRelayCommand({ sub: 'nodes', dataDir, io: nodes });
    assert.match(nodes.text.out, /^web-01  kl-aaaaaaaaaaaaaaaa  paired 2026-09-23T18:00:00\.000Z$/m);
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    assert.equal(await runRelayCommand({ sub: 'remove-node', arg: 'web-01', dataDir, io: streamIo() }), 1, 'refused while the relay runs');
    fs.rmSync(path.join(dataDir, 'service.pid'));
    assert.equal(await runRelayCommand({ sub: 'remove-node', arg: 'web-01', dataDir, io: streamIo() }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'nodes.json'), 'utf8')).nodes, []);
  });

  it('qr prints a kl.relay code with the certificate SPKI pin', async () => {
    const { base, dataDir } = dirs();
    const { cert, key } = MeshIdentity.generateTlsCertificate('relay-test');
    const certFile = path.join(base, 'relay.crt');
    fs.writeFileSync(certFile, cert);
    fs.writeFileSync(path.join(base, 'relay.key'), key);
    const io = streamIo();
    const config = relayConfig('127.0.0.1', { tls: { certFile, keyFile: path.join(base, 'relay.key') } });
    assert.equal(await runRelayCommand({ sub: 'qr', dataDir, io, deps: { loadConfig: () => ({ relay: config }), renderQr: async () => '[QR]' } }), 0);
    const payload = decodeQr(/kl1:\S+/.exec(io.text.out)[0]);
    assert.deepEqual(payload, { t: 'kl.relay', relay: 'https://kl.example.com:8443', relay_spki: relaySpkiPin(cert) });
    assert.match(payload.relay_spki, /^sha256\/[A-Za-z0-9_-]{43}$/);
  });
});

describe('pair against a test relay', () => {
  it('pins the relay with a code from `relay code`, and prints its fingerprint', async () => {
    const relayDirs = dirs();
    const relayIdentity = new NodeIdentity({ nodeName: 'relay' });
    const relay = await startRelay({ dataDir: relayDirs.dataDir, identity: relayIdentity, useTls: false, config: relayConfig('127.0.0.1') });
    cleanups.push(() => relay.stop());
    const codeIo = streamIo();
    await runRelayCommand({ sub: 'code', arg: 'unnamed-node', dataDir: relayDirs.dataDir, io: codeIo });
    const code = /Pairing code for unnamed-node: (.+)$/m.exec(codeIo.text.out)[1];
    for (let i = 0; i < 300 && fs.readdirSync(path.join(relayDirs.dataDir, 'relay', 'codes')).length; i += 1) await new Promise((r) => setTimeout(r, 10));

    const nodeDirs = dirs();
    const io = streamIo();
    const url = `ws://127.0.0.1:${relay.address().mesh.port}`;
    const exit = await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { useTls: false, code } });
    assert.equal(exit, 0, io.text.err);
    assert.match(io.text.out, new RegExp(`Relay fingerprint: ${relayIdentity.nodeId.slice(3).match(/.{4}/g).join(' ')}`));
    const pin = new JsonFileStore({ dir: nodeDirs.dataDir, name: 'chat-data' }).get('approvals.relay');
    assert.equal(pin.relay_id, relayIdentity.nodeId);
    assert.equal(pin.port, relay.address().mesh.port);
    assert.deepEqual(relay.nodeHub.nodes().map((n) => n.node_name), ['unnamed-node']);
  });

  it('refuses an unsupported scheme and an empty code', async () => {
    const io = streamIo();
    assert.equal(await runPair({ url: 'ftp://relay.example.com:1', dataDir: dirs().dataDir, io }), 2);
    assert.match(io.text.err, /Unsupported URL scheme/);
    const empty = streamIo();
    empty.stdin.end('');
    assert.equal(await runPair({ url: 'wss://10.0.0.5:18795', dataDir: dirs().dataDir, io: empty }), 2);
    assert.match(empty.text.err, /No pairing code on stdin/);
  });
});
```

Create `tests/deps-qrcode.test.js`:

```js
// tests/deps-qrcode.test.js
//
// Program §3: no new native npm dependency. `qrcode` (spec §14) and
// everything it pulls in must be pure JS: no install scripts, no node-gyp.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));

function entryFor(name, parentPath) {
  const nested = `${parentPath}/node_modules/${name}`;
  if (lock.packages[nested]) return [nested, lock.packages[nested]];
  const flat = `node_modules/${name}`;
  return lock.packages[flat] ? [flat, lock.packages[flat]] : [null, null];
}

describe('qrcode dependency', () => {
  it('is a runtime dependency', () => {
    assert.ok(pkg.dependencies && pkg.dependencies.qrcode, 'package.json dependencies.qrcode');
  });

  it('has no install scripts or native build anywhere in its tree', () => {
    const seen = new Set();
    const queue = [['node_modules/qrcode', lock.packages['node_modules/qrcode']]];
    assert.ok(queue[0][1], 'package-lock.json has node_modules/qrcode');
    while (queue.length) {
      const [where, entry] = queue.shift();
      if (seen.has(where)) continue;
      seen.add(where);
      assert.notEqual(entry.hasInstallScript, true, `${where} has an install script`);
      assert.notEqual(entry.gypfile, true, `${where} builds native code`);
      for (const dep of Object.keys(entry.dependencies || {})) {
        const [depWhere, depEntry] = entryFor(dep, where);
        assert.ok(depEntry, `${dep} (needed by ${where}) is in the lockfile`);
        queue.push([depWhere, depEntry]);
      }
    }
    assert.ok(seen.size >= 2);
  });

  it('renders a terminal QR code for a kl1: payload', async () => {
    const QRCode = require('qrcode');
    const text = await QRCode.toString('kl1:eyJ0Ijoia2wucmVsYXkifQ', { type: 'terminal', small: true });
    assert.ok(text.split('\n').length > 10);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/service-cli-devices.test.js tests/service-cli-relay.test.js tests/deps-qrcode.test.js`
Expected: FAIL — `Cannot find module '../src/service/commands/devices'` / `'../src/service/commands/relay'`, and `package.json dependencies.qrcode`.

- [ ] **Step 3: Implement**

Add the dependency (pure JS; the test above checks its tree):

Run: `npm install qrcode@1.5.4 --save`
Expected: `package.json` gains `"qrcode": "^1.5.4"` under `dependencies`; `package-lock.json` gains `node_modules/qrcode`, `dijkstrajs`, `pngjs`, `yargs` and yargs' dependencies.

Create `src/service/commands/io.js`:

```js
// Shared CLI helpers for the approval commands. CLI output goes to
// stdout/stderr on purpose; everything else logs via createLogger.
const { readPidfile, isRunning } = require('../pidfile');

// The first line typed on stdin (without its newline); '' at end of input.
function readLine(stdin) {
  return new Promise((resolve) => {
    let buffered = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (typeof stdin.pause === 'function') stdin.pause();
    };
    const onData = (chunk) => {
      buffered += String(chunk);
      const nl = buffered.indexOf('\n');
      if (nl === -1) return;
      cleanup();
      resolve(buffered.slice(0, nl).replace(/\r$/, ''));
    };
    const onEnd = () => {
      cleanup();
      resolve(buffered.replace(/\r?\n$/, ''));
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

function runningServicePid(dataDir) {
  const pid = readPidfile(dataDir);
  return pid && isRunning(pid) ? pid : null;
}

// `qrcode` is loaded only here, by the CLI commands that print a code.
async function renderQr(text) {
  const QRCode = require('qrcode');
  return QRCode.toString(text, { type: 'terminal', small: true });
}

module.exports = { readLine, runningServicePid, renderQr };
```

Create `src/service/commands/pair.js`:

```js
// `king-louie-service pair <url>` (spec §3.11). `wss://host:port` pairs this
// node with its relay: the one-time code from `relay code <node-name>` is read
// from stdin, and the relay's key is pinned in the node's store. `https://` is
// the stage 4 front door's flow (F4 extends this module, R22).
const { buildServicePorts } = require('../ports');
const { loadNodeConfig } = require('../node-config');
const { restoreDataDirOwnership } = require('../ownership');
const { runningServicePid } = require('./io');

const USAGE = 'Usage: king-louie-service pair <front-door-url> [--data-dir DIR]\n'
  + '       pair wss://relay-host:port pairs with a phone-approval relay; the one-time code is read from stdin\n';

async function readAll(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function runPair({ url, dataDir, io, deps = {} }) {
  if (!url) {
    io.stderr.write(USAGE);
    return 2;
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    io.stderr.write(`Not a URL: ${url}\n${USAGE}`);
    return 2;
  }
  const useTls = deps.useTls !== false;
  const relayScheme = useTls ? 'wss:' : 'ws:';
  if (target.protocol !== 'https:' && target.protocol !== relayScheme) {
    io.stderr.write(`Unsupported URL scheme ${target.protocol}\n${USAGE}`);
    return 2;
  }
  // Creating the identity writes to the service's store, which a running
  // service would overwrite from its own in-memory copy.
  const pid = runningServicePid(dataDir);
  if (pid) {
    io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
    return 1;
  }

  const written = [];
  try {
    const { getOrGenerateNodeIdentity, deriveNodeId } = require('../../mesh/node-identity');
    const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
    const nodeCfg = loadNodeConfig({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);

    if (target.protocol === 'https:') {
      // What §5.1 step 1 shows the owner. The front door exchange is stage 4's.
      io.stdout.write(`Node Name: ${nodeCfg.name}\n`);
      io.stdout.write(`Node ID: ${identity.nodeId}\n`);
      io.stdout.write(`TLS Fingerprint: ${identity.tlsFingerprint}\n`);
      io.stderr.write(`Pairing with a front door is not available yet: the front door is built in stage 4. Nothing was sent to ${url}.\n`);
      return 1;
    }

    const port = Number(target.port);
    if (!target.hostname || !Number.isInteger(port) || port < 1) {
      io.stderr.write(`The relay URL needs a host and a port, like wss://10.0.0.5:18795\n`);
      return 2;
    }
    const code = (deps.code !== undefined ? deps.code : await readAll(io.stdin)).trim();
    if (!code) {
      io.stderr.write('No pairing code on stdin. Get one on the relay host with `king-louie-service relay code <node-name>`.\n');
      return 2;
    }
    const { MeshTransport } = require('../../mesh/mesh-transport');
    const { MeshPairing } = require('../../mesh/mesh-pairing');
    const { fingerprintGroups } = require('../../approvals/envelope');
    const transport = new MeshTransport({ identity, listen: false, useTls });
    const pairing = new MeshPairing(identity, transport, { timeoutMs: deps.timeoutMs || 30000 });
    let info;
    try {
      info = await pairing.acceptCode(code, target.hostname.replace(/^\[|\]$/g, ''), port);
    } catch (err) {
      io.stderr.write(`Pairing failed: ${err.message}\n`);
      return 1;
    } finally {
      pairing.cleanup();
    }
    const relayId = deriveNodeId(info.publicKey);
    ports.store.set('approvals.relay', {
      relay_id: relayId,
      peerId: info.peerId,
      publicKey: info.publicKey,
      tlsFingerprint: info.tlsFingerprint || null,
      address: target.hostname.replace(/^\[|\]$/g, ''),
      port,
      pairedAt: new Date().toISOString()
    });
    io.stdout.write(`Paired ${nodeCfg.name} (${identity.nodeId}) with relay ${relayId}.\n`);
    io.stdout.write(`Relay fingerprint: ${fingerprintGroups(relayId)}\n`);
    io.stdout.write('Compare it with the fingerprint `king-louie-service relay run` logs on the relay host.\n');
    if (nodeCfg.approvers.relay !== url) {
      io.stdout.write(`Next: set "approvers: { relay: ${url} }" in the admin node.yaml, then start the service.\n`);
    }
    return 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runPair, USAGE };
```

Create `src/service/commands/devices.js`:

```js
// `enroll-device` and `device list|revoke|apply` (spec §3.10): the only
// commands that write the approver set, run by an administrator.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { adminConfigDir } = require('../../platform/paths');
const { buildServicePorts } = require('../ports');
const { loadNodeConfig } = require('../node-config');
const { restoreDataDirOwnership } = require('../ownership');
const { readLine, runningServicePid, renderQr } = require('./io');

const ENROLL_TTL_MS = 10 * 60 * 1000;
const DEVICE_HELP = `Usage: king-louie-service device list [--data-dir DIR]
       king-louie-service device revoke <device-id> [--data-dir DIR]
       king-louie-service device apply [--yes] [--data-dir DIR]
`;

function layout(dataDir, configDir, deps) {
  const { ApproverAdmin } = require('../../approvals/approver-admin');
  const dir = path.join(configDir, 'approvers');
  const stagedDir = path.join(dataDir, 'approvals', 'staged');
  const storeOptions = deps.storeOptions || {};
  return { dir, stagedDir, storeOptions, admin: new ApproverAdmin({ dir, stagedDir, ...storeOptions, ...(deps.now ? { now: deps.now } : {}) }) };
}

function auditLedger(dataDir, identity, written) {
  const { AuditLedger } = require('../../audit/audit-ledger');
  return new AuditLedger({ dir: path.join(dataDir, 'audit'), identity, nodeId: identity.nodeId, writer: 'cli', onPathWritten: (p) => written.push(p) });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runEnrollDevice({ dataDir, configDir = adminConfigDir({ dataDir }), io, deps = {} }) {
  const { FileCourier } = require('../../approvals/courier');
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  const { verifyConsoleEnrollment } = require('../../approvals/verify-device');
  const { buildEnrollOpen, buildEnrollDone, encodeQr } = require('../../approvals/messages');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const now = deps.now || Date.now;
  const { admin } = layout(dataDir, configDir, deps);

  try {
    admin.assertWritable();
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (!runningServicePid(dataDir)) {
    io.stderr.write('The King Louie service is not running on this node. Start it, then run enroll-device again.\n');
    return 1;
  }
  const nodeCfg = loadNodeConfig({ dataDir, adminConfigDir: configDir, ...(deps.storeOptions || {}) });
  if (!nodeCfg.approvers.relay && !fs.existsSync(path.join(configDir, 'front-door.json'))) {
    io.stderr.write(`approvers.relay is not set in ${path.join(configDir, 'node.yaml')}.\n`);
    return 1;
  }
  const link = readJson(path.join(dataDir, 'approvals', 'link.json'));
  if (!link || link.connected !== true) {
    io.stderr.write(`The service is not linked to its relay yet (see ${path.join(dataDir, 'approvals', 'link.json')}). Check \`relay nodes\` on the relay host.\n`);
    return 1;
  }

  const written = [];
  const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
  const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);
  const courier = new FileCourier({ dataDir, identity, onPathWritten: (p) => written.push(p), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) }).start();
  const codeId = crypto.randomBytes(16).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');
  const finish = (claim, refused) => courier.call('enroll.done', { envelope: buildEnrollDone({ identity, codeId, enroll: refused ? null : claim, refused }) })
    .catch((err) => io.stderr.write(`Could not tell the relay: ${err.message}\n`));
  try {
    const claimed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), deps.timeoutMs || ENROLL_TTL_MS);
      if (typeof timer.unref === 'function') timer.unref();
      courier.onMessage(async (method, params) => {
        if (method === 'enroll.claim' && params.code_id === codeId) {
          clearTimeout(timer);
          resolve(params.envelope);
        }
      });
    });
    await courier.call('enroll.open', { envelope: buildEnrollOpen({ identity, codeId, expiresAt: now() + ENROLL_TTL_MS }) });
    const qr = encodeQr({
      t: 'kl.pair',
      relay: link.relay_public_url,
      relay_spki: link.relay_spki,
      code_id: codeId,
      code,
      node: { id: identity.nodeId, name: nodeCfg.name, key: Buffer.from(identity.publicKey).toString('hex') }
    });
    io.stdout.write(`${await (deps.renderQr || renderQr)(qr)}\n`);
    io.stdout.write(`Or paste this into the app: ${qr}\n`);
    io.stdout.write(`Relay fingerprint: ${fingerprintGroups(link.relay_id)}\n`);
    io.stdout.write('Scan the code with the King Louie app. Waiting up to 10 minutes...\n');

    const claim = await claimed;
    if (!claim) {
      await finish(null, true);
      io.stderr.write('No phone answered within 10 minutes. Nothing was enrolled.\n');
      return 1;
    }
    const check = verifyConsoleEnrollment(claim, { codeId, code, now: now(), allowTestKeys: deps.allowTestKeys === true });
    if (!check.ok) {
      await finish(null, true);
      io.stderr.write(`The phone's enrollment was refused (${check.reason}). Nothing was enrolled.\n`);
      return 1;
    }
    const { device } = check.message;
    io.stdout.write(`Device "${device.name}" (${device.platform}) ${device.device_id.slice(0, 2)}${fingerprintGroups(device.device_id)} — does the phone show the same? [y/N] `);
    const answer = await readLine(io.stdin);
    if (!/^y(es)?$/i.test(answer.trim())) {
      await finish(null, true);
      io.stdout.write('Not enrolled.\n');
      return 1;
    }
    admin.writeApprover({
      v: 1,
      device_id: device.device_id,
      name: device.name,
      platform: device.platform,
      public_key: device.public_key,
      enrolled_at: new Date(now()).toISOString(),
      enrolled_by: 'console',
      revoked_at: null,
      revoked_by: null,
      enrollment: claim
    });
    await auditLedger(dataDir, identity, written).append({ kind: 'device.enrolled', data: { device_id: device.device_id, by: 'console', envelope: claim } });
    await finish(claim, false);
    io.stdout.write(`Enrolled ${device.device_id}. It can approve unsafe actions on ${nodeCfg.name} now.\n`);
    return 0;
  } finally {
    courier.stop();
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

function describeState(store, record) {
  if (record.revoked_at) return `revoked ${record.revoked_at} by ${record.revoked_by}`;
  if (record.platform === 'demo') return 'demo (never accepted)';
  if (store.overlay.has(record.device_id)) return 'revoked, pending `device apply`';
  return 'active';
}

async function runDevice({ sub, arg, flags = {}, dataDir, configDir = adminConfigDir({ dataDir }), io, deps = {} }) {
  const { ApproverStore } = require('../../approvals/approver-store');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const { dir, stagedDir, storeOptions, admin } = layout(dataDir, configDir, deps);

  if (sub === 'list') {
    const store = new ApproverStore({ dir, stagedDir, ...storeOptions });
    const ready = await store.ready();
    if (!ready.ok) io.stderr.write(`Warning: ${ready.problem}\n`);
    const records = store.list();
    if (records.length === 0) io.stdout.write('No approver devices on this node.\n');
    for (const r of records) {
      io.stdout.write(`${fingerprintGroups(r.device_id)}  ${r.device_id}  ${r.name} (${r.platform})  ${describeState(store, r)}  enrolled by ${r.enrolled_by}\n`);
    }
    const staged = admin.listStaged();
    if (staged.length) io.stdout.write(`${staged.length} staged change(s) wait for \`device apply\`.\n`);
    return 0;
  }

  if (sub !== 'revoke' && sub !== 'apply') {
    io.stderr.write(DEVICE_HELP);
    return 2;
  }
  try {
    admin.assertWritable();
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  const written = [];
  try {
    const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
    const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
    const nodeCfg = loadNodeConfig({ dataDir, adminConfigDir: configDir, ...(deps.storeOptions || {}) });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);
    const ledger = auditLedger(dataDir, identity, written);

    if (sub === 'revoke') {
      if (!arg) {
        io.stderr.write(DEVICE_HELP);
        return 2;
      }
      try {
        admin.markRevoked(arg, 'console');
      } catch (err) {
        io.stderr.write(`${err.message}\n`);
        return 1;
      }
      await ledger.append({ kind: 'device.revoked', data: { device_id: arg, by: 'console', envelope: null } });
      io.stdout.write(`Revoked ${arg}. It can no longer approve anything on ${nodeCfg.name}.\n`);
      return 0;
    }

    const results = await admin.applyStaged({
      confirm: async (items) => {
        for (const i of items) {
          const age = Number.isFinite(i.ageMs) ? `${Math.round(i.ageMs / 60000)} min ago` : 'unreadable';
          io.stdout.write(`${i.type === 'kl.device.revoke' ? 'revoke' : 'enroll'}  ${i.deviceId}  signed by ${i.signer}  (${age})\n`);
        }
        if (flags.yes) return true;
        io.stdout.write('Apply these? [y/N] ');
        return /^y(es)?$/i.test((await readLine(io.stdin)).trim());
      }
    });
    if (results.length === 0) {
      io.stdout.write('Nothing applied.\n');
      return 0;
    }
    for (const r of results) {
      io.stdout.write(`${r.deviceId}: ${r.result}\n`);
      if (r.result === 'enrolled') await ledger.append({ kind: 'device.enrolled', data: { device_id: r.deviceId, by: r.signer, envelope: null } });
      if (r.result === 'revoked') await ledger.append({ kind: 'device.revoked', data: { device_id: r.deviceId, by: r.signer, envelope: null } });
    }
    return 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runEnrollDevice, runDevice, DEVICE_HELP };
```

Create `src/service/commands/relay.js`:

```js
// `king-louie-service relay run|code|nodes|remove-node|qr` (spec §3.12).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { loadServiceConfig } = require('../config');
const { runningServicePid, renderQr } = require('./io');

const log = createLogger('relay');
const CODE_TTL_MS = 120000;
const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RELAY_HELP = `Usage: king-louie-service relay run [--data-dir DIR]
       king-louie-service relay code <node-name> [--data-dir DIR]
       king-louie-service relay nodes [--data-dir DIR]
       king-louie-service relay remove-node <node-name> [--data-dir DIR]
       king-louie-service relay qr [--data-dir DIR]
`;

function registryFile(dataDir) {
  return path.join(dataDir, 'relay', 'nodes.json');
}

function readNodes(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8')).nodes || [];
  } catch {
    return [];
  }
}

function relayConfig(dataDir, io, deps) {
  const config = (deps.loadConfig || ((d) => loadServiceConfig(d)))(dataDir).relay;
  if (!config) {
    io.stderr.write('There is no "relay" block in the admin service.json. See the relay section of the install guide.\n');
    return null;
  }
  return config;
}

async function runRelayServer({ dataDir, io, deps }) {
  const { assertPrivateMeshHost } = require('../../frontdoor/net');
  const config = relayConfig(dataDir, io, deps);
  if (!config) return 1;
  try {
    assertPrivateMeshHost(config.meshListen.host);
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  const { acquireInstanceLock } = require('../pidfile');
  const { buildServicePorts } = require('../ports');
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  const { startRelay } = require('../../frontdoor/relay');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const lock = acquireInstanceLock(dataDir);
  try {
    const ports = buildServicePorts({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'relay');
    const relay = await startRelay({ dataDir, config, identity, useTls: deps.useTls !== false });
    const fingerprint = fingerprintGroups(identity.nodeId);
    log.info(`relay ${identity.nodeId} fingerprint ${fingerprint}`);
    io.stdout.write(`${JSON.stringify({ event: 'ready', relay_id: identity.nodeId, fingerprint, phone_spki: relay.phoneSpki, ...relay.address() })}\n`);
    await new Promise((resolve) => {
      const done = () => resolve();
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
      process.on('message', (m) => { if (m && m.type === 'shutdown') done(); });
      if (deps.signal) deps.signal.addEventListener('abort', done, { once: true });
    });
    await relay.stop();
    return 0;
  } finally {
    lock.release();
  }
}

function runCode({ dataDir, name, io, deps }) {
  const { WORDLIST } = require('../../mesh/mesh-pairing');
  if (!name || !NODE_NAME_RE.test(name)) {
    io.stderr.write('A node name is 1–64 of A–Z, a–z, 0–9, dot, underscore and dash.\n');
    return 2;
  }
  if (readNodes(dataDir).some((n) => n.node_name === name)) {
    io.stderr.write(`name_taken: a node named "${name}" is already paired. Remove it first with \`relay remove-node ${name}\`.\n`);
    return 1;
  }
  const words = Array.from(crypto.randomBytes(6), (b) => WORDLIST[b]);
  const code = words.join(' ');
  const expiresAt = new Date((deps.now || Date.now)() + CODE_TTL_MS).toISOString();
  const codesDir = path.join(dataDir, 'relay', 'codes');
  fs.mkdirSync(codesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codesDir, `${crypto.randomBytes(6).toString('hex')}.json`), JSON.stringify({ code, node_name: name, expires_at: expiresAt }), { mode: 0o600 });
  io.stdout.write(`Pairing code for ${name}: ${code}\n`);
  io.stdout.write(`It works once, until ${expiresAt}. On ${name}, as the administrator:\n`);
  io.stdout.write(`  echo '${code}' | king-louie-service pair wss://<relay-host>:<mesh-port>\n`);
  if (!runningServicePid(dataDir)) io.stderr.write('The relay is not running here; start `relay run` before the code expires.\n');
  return 0;
}

async function runRelayCommand({ sub, arg, dataDir, io, deps = {} }) {
  if (sub === 'run') return runRelayServer({ dataDir, io, deps });
  if (sub === 'code') return runCode({ dataDir, name: arg, io, deps });
  if (sub === 'nodes') {
    const nodes = readNodes(dataDir);
    if (nodes.length === 0) io.stdout.write('No nodes are paired with this relay.\n');
    for (const n of nodes) io.stdout.write(`${n.node_name}  ${n.node_id}  paired ${n.paired_at || 'by the front door'}\n`);
    return 0;
  }
  if (sub === 'remove-node') {
    if (!arg) {
      io.stderr.write(RELAY_HELP);
      return 2;
    }
    const pid = runningServicePid(dataDir);
    if (pid) {
      io.stderr.write(`The relay is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
      return 1;
    }
    const nodes = readNodes(dataDir);
    const kept = nodes.filter((n) => n.node_name !== arg);
    if (kept.length === nodes.length) {
      io.stderr.write(`No node named "${arg}" is paired with this relay.\n`);
      return 1;
    }
    fs.writeFileSync(registryFile(dataDir), `${JSON.stringify({ nodes: kept }, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`Removed ${arg}.\n`);
    return 0;
  }
  if (sub === 'qr') {
    const { relaySpkiPin } = require('../../frontdoor/tls');
    const { encodeQr } = require('../../approvals/messages');
    const config = relayConfig(dataDir, io, deps);
    if (!config) return 1;
    const qr = encodeQr({ t: 'kl.relay', relay: config.publicUrl, relay_spki: relaySpkiPin(fs.readFileSync(config.tls.certFile, 'utf8')) });
    io.stdout.write(`${await (deps.renderQr || renderQr)(qr)}\n${qr}\n`);
    return 0;
  }
  io.stderr.write(RELAY_HELP);
  return 2;
}

module.exports = { runRelayCommand, RELAY_HELP, CODE_TTL_MS };
```

In `src/service/cli.js`, add three lines to `HELP` after `  king-louie-service uninstall [--dry-run]`:

```text
  king-louie-service enroll-device [--data-dir DIR]              (admin: pair a phone approver)
  king-louie-service device list|revoke <device-id>|apply [--yes] [--data-dir DIR]
  king-louie-service relay run|code <node-name>|nodes|remove-node <node-name>|qr [--data-dir DIR]
```

Replace `const BOOLEAN_FLAGS = new Set(['dry-run', 'group', 'clear']);` with:

```js
const BOOLEAN_FLAGS = new Set(['dry-run', 'group', 'clear', 'yes']);
```

In the `mcp` case, replace

```js
          return withServiceCore(dataDir, io, (core) => {
            const { loadNodeConfig } = require('./node-config');
            const { RunbookEngine } = require('../runbooks/runbook-engine');
            const StdioMcpServer = require('../mcp/stdio-server');

            const nodeCfg = loadNodeConfig({ dataDir });
```

with

```js
          return await withServiceCore(dataDir, io, async (core, ports) => {
            const { loadNodeConfig } = require('./node-config');
            const { RunbookEngine } = require('../runbooks/runbook-engine');
            const StdioMcpServer = require('../mcp/stdio-server');
            const { startMcpApprovals } = require('../approvals/service-wiring');

            const nodeCfg = loadNodeConfig({ dataDir });
            // Unsafe runbooks ask a phone through the running service (§3.9).
            const approvals = await startMcpApprovals({ dataDir, nodeConfig: nodeCfg, ports });
```

(`return await` so a startup failure inside the now-async callback still reaches the `catch` that restores the console.) In the same case replace

```js
            const server = new StdioMcpServer({
              nodeConfig: nodeCfg,
              runbookEngine,
              stdin: io.stdin,
              stdout: io.stdout
            });
```

with

```js
            const server = new StdioMcpServer({
              nodeConfig: nodeCfg,
              runbookEngine,
              approver: approvals.approver,
              auditLedger: approvals.auditLedger,
              stdin: io.stdin,
              stdout: io.stdout
            });
```

Replace the whole `case 'pair': { … }` block (from `      case 'pair': {` to its closing `      }` just before `      case 'channel':`) with:

```js
      case 'pair': {
        // The URL is the first word after the command, i.e. `sub` here.
        const { runPair } = require('./commands/pair');
        return await runPair({ url: sub, dataDir, io });
      }

      case 'enroll-device': {
        const { runEnrollDevice } = require('./commands/devices');
        return await runEnrollDevice({ dataDir, io });
      }

      case 'device': {
        const { runDevice } = require('./commands/devices');
        return await runDevice({ sub, arg, flags, dataDir, io });
      }

      case 'relay': {
        const { runRelayCommand } = require('./commands/relay');
        return await runRelayCommand({ sub, arg, dataDir, io });
      }
```

In `src/service/doctor.js`, replace the end of `runDoctor`

```js
  } catch (err) {
    results.push({ check: 'node config / runbooks health', ok: false, detail: err.message });
  }

  return results;
}
```

with

```js
  } catch (err) {
    results.push({ check: 'node config / runbooks health', ok: false, detail: err.message });
  }

  results.push(...approvalChecks({ dataDir, platform }));
  return results;
}

// Fleet stage 3: the approver set must be admin-only, the relay linked when
// one is configured, and the audit chain intact.
function approvalChecks({ dataDir, platform }) {
  const out = [];
  const attempt = (check, fn) => {
    try {
      out.push({ check, ...fn() });
    } catch (err) {
      out.push({ check, ok: false, detail: err.message });
    }
  };
  const { adminConfigDir } = require('../platform/paths');
  const dir = path.join(adminConfigDir({ dataDir }), 'approvers');
  let problem = null;
  attempt('approvers dir is writable only by an administrator', () => {
    const { checkApproverDir } = require('../approvals/approver-store');
    problem = checkApproverDir({ dir, platform });
    return { ok: problem === null, detail: problem || dir };
  });
  attempt('active phone approvers', () => {
    const { ApproverStore } = require('../approvals/approver-store');
    return { ok: true, detail: problem ? '0 (the set is not trusted)' : String(new ApproverStore({ dir, platform }).activeCount()) };
  });
  attempt('relay paired and linked', () => {
    const { loadNodeConfig } = require('./node-config');
    const nodeCfg = loadNodeConfig({ dataDir });
    if (!nodeCfg.approvers.relay) return { ok: true, detail: 'no relay configured (phone approvals off)' };
    let link = null;
    try {
      link = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
    } catch {
      link = null;
    }
    if (!link) return { ok: false, detail: `not paired with ${nodeCfg.approvers.relay} (run pair)` };
    return { ok: link.connected === true, detail: `${link.relay_id} ${link.connected ? 'connected' : 'disconnected'}` };
  });
  attempt('audit ledger chain', () => {
    const { AuditLedger } = require('../audit/audit-ledger');
    const result = new AuditLedger({ dir: path.join(dataDir, 'audit'), nodeId: null }).verify();
    return { ok: result.ok, detail: result.ok ? `${result.entries} entries` : `broken at seq ${result.brokenAt} (${result.reason})` };
  });
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/service-cli-devices.test.js tests/service-cli-relay.test.js tests/deps-qrcode.test.js tests/service-cli.test.js tests/service-cli-mcp-pair.test.js`
Expected: PASS, `fail 0` (7 + 7 + 3 new tests; the existing `pair https://…` tests still see `Node Name:` / `not available yet … stage 4`).

- [ ] **Step 5: Commit**

```bash
git add src/service/commands src/service/cli.js src/service/doctor.js package.json package-lock.json tests/service-cli-devices.test.js tests/service-cli-relay.test.js tests/deps-qrcode.test.js
git commit -m "feat(service): pair, enroll-device, device and relay commands; mcp asks the phone; doctor checks approvals

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: End to end, CLAUDE.md, and final verification

**Files:**
- Create: `tests/approvals-e2e.test.js`
- Modify: `CLAUDE.md` (append one section at the end)

**Interfaces:**
- Consumes: the `king-louie-service` binary (`relay run`, `run --profile runbook`, `mcp`), `runRelayCommand`, `runPair`, `runEnrollDevice` (Task 22), `decodeQr`, `open`, `verifyEd25519`, `createFakePhone`, `MeshIdentity.generateTlsCertificate` (for the relay's TLS files).
- Produces: nothing new; proves the stage end to end with real processes and real TLS.

The test runs where admin config dirs can be admin-owned: on Windows (where `assertAdminOwned` is a no-op and the approvers dir is protected by denying the test account write access, as an installer's ACL would) or as root on POSIX; elsewhere it is skipped with the reason.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-e2e.test.js`:

```js
// tests/approvals-e2e.test.js
//
// The whole path with real processes and real TLS: `relay run`, a node's
// `run --profile runbook` paired with it, a console-enrolled fake phone, and
// an unsafe runbook asked for through `mcp` and approved on the phone.
//
// The admin config dirs must be root-owned on POSIX, which a test cannot
// arrange, so this runs on Windows or as root.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { runRelayCommand } = require('../src/service/commands/relay');
const { runPair } = require('../src/service/commands/pair');
const { runEnrollDevice } = require('../src/service/commands/devices');
const { decodeQr } = require('../src/approvals/messages');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { createFakePhone } = require('./helpers/fake-phone');

const BIN = path.join(__dirname, '..', 'bin', 'king-louie-service.js');
const CAN_RUN = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
const children = [];
const dirs = [];
after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try { child.connected ? child.send({ type: 'shutdown' }) : child.kill(); } catch { child.kill(); }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const d of dirs) {
    if (typeof d === 'object') d.unlock();
    else fs.rmSync(d, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function spawnCli(args) {
  const env = { ...process.env, KING_LOUIE_LOG_LEVEL: 'info' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(BIN, args, { silent: true, env });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return { child, output: () => out, errors: () => err };
}

// The service trusts the approver set only when it cannot write it. On
// Windows the test user is also the "service account", so once the phone is
// enrolled the test denies itself write access to approvers/, as an
// installer's ACL would; the lock is lifted again before cleanup.
function lockApproversDir(dir) {
  if (process.platform !== 'win32') return () => {};
  const { execFileSync } = require('child_process');
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  // Specific rights only: the generic W would also deny SYNCHRONIZE, and with
  // it every read.
  execFileSync('icacls', [dir, '/deny', `${who}:(OI)(CI)(WD,AD,WEA,WA,DC)`], { stdio: 'ignore' });
  return () => execFileSync('icacls', [dir, '/remove:d', who], { stdio: 'ignore' });
}

function streamIo(input = null) {
  const text = { out: '', err: '' };
  const stdin = new PassThrough();
  if (input !== null) stdin.end(input);
  return { stdin, stdout: { write: (s) => { text.out += String(s); return true; } }, stderr: { write: (s) => { text.err += String(s); return true; } }, text };
}

// The phone's HTTPS client: CA trust ignored, the leaf SPKI pinned.
function phoneHttps(baseUrl, spkiPin, phone) {
  return (method, p, body) => new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', ...(phone ? phone.signApi(method, p, text) : {}) };
    const req = https.request(`${baseUrl}${p}`, { method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    // Checked on the handshake, before the request is sent.
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const cert = socket.getPeerX509Certificate();
      const pin = `sha256/${crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')}`;
      if (pin !== spkiPin) req.destroy(new Error('Relay certificate changed — scan a new relay code'));
    }));
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : text);
  });
}

describe('phone approvals end to end', { skip: !CAN_RUN && 'needs root-owned admin config dirs on POSIX', timeout: 180000 }, () => {
  it('an unsafe runbook asked for through mcp runs after a phone approves it', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-approvals-')));
    dirs.push(base);

    // ── Relay host ────────────────────────────────────────────────────────
    const relayData = path.join(base, 'relay', 'data');
    const relayConfig = path.join(base, 'relay', 'config');
    fs.mkdirSync(relayData, { recursive: true });
    fs.mkdirSync(relayConfig, { recursive: true });
    const { cert, key } = MeshIdentity.generateTlsCertificate('relay-e2e');
    fs.writeFileSync(path.join(relayConfig, 'relay.crt'), cert);
    fs.writeFileSync(path.join(relayConfig, 'relay.key'), key);
    const phonePort = await freePort();
    const meshPort = await freePort();
    fs.writeFileSync(path.join(relayConfig, 'service.json'), JSON.stringify({
      relay: {
        phone_listen: { host: '127.0.0.1', port: phonePort },
        mesh_listen: { host: '127.0.0.1', port: meshPort },
        tls: { cert_file: path.join(relayConfig, 'relay.crt'), key_file: path.join(relayConfig, 'relay.key') },
        public_url: `https://127.0.0.1:${phonePort}`
      }
    }));
    const relay = spawnCli(['relay', 'run', '--data-dir', relayData]);
    const ready = await until(() => relay.output().split('\n').find((l) => l.includes('"event":"ready"')), `relay ready (${relay.errors()})`);
    const relayInfo = JSON.parse(ready);

    // ── Node: config, runbook, pairing ────────────────────────────────────
    const nodeData = path.join(base, 'node', 'data');
    const nodeConfig = path.join(base, 'node', 'config');
    const root = path.join(base, 'site');
    fs.mkdirSync(path.join(nodeConfig, 'runbooks'), { recursive: true });
    fs.mkdirSync(nodeData, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(nodeConfig, 'node.yaml'), [
      'name: web-01',
      'profile: runbook',
      'policy:',
      `  allowed_roots: [${JSON.stringify(root)}]`,
      'approvers:',
      `  relay: wss://127.0.0.1:${meshPort}`,
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(nodeConfig, 'runbooks', 'site-touch.yaml'), JSON.stringify({
      name: 'site.touch',
      description: 'Write a marker file',
      tier: 'unsafe',
      params: { target: { type: 'path' } },
      steps: [{ run: [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1], 'ran')", '{{target}}/marker.txt'] }]
    }));

    const codeIo = streamIo();
    await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir: relayData, io: codeIo });
    const code = /Pairing code for web-01: (.+)$/m.exec(codeIo.text.out)[1];
    await until(async () => (await runPair({ url: `wss://127.0.0.1:${meshPort}`, dataDir: nodeData, io: streamIo(`${code}\n`) })) === 0, 'pairing');

    const service = spawnCli(['run', '--profile', 'runbook', '--data-dir', nodeData]);
    await until(() => service.output().includes('"event":"ready"'), `node ready (${service.errors()})`);
    const linkFile = path.join(nodeData, 'approvals', 'link.json');
    await until(() => fs.existsSync(linkFile) && JSON.parse(fs.readFileSync(linkFile, 'utf8')).connected, 'the relay link');

    // ── Console enrollment of the phone ───────────────────────────────────
    const phone = createFakePhone({ name: 'Owner phone', platform: 'ios' });
    const enrollIo = streamIo();
    const enrolling = runEnrollDevice({ dataDir: nodeData, io: enrollIo, deps: { renderQr: async () => '[QR]' } });
    const qrText = await until(() => /Or paste this into the app: (kl1:\S+)/.exec(enrollIo.text.out), `the pairing QR (${enrollIo.text.err})`);
    const qr = decodeQr(qrText[1]);
    assert.equal(qr.relay_spki, relayInfo.phone_spki);
    const api = phoneHttps(qr.relay, qr.relay_spki, phone);
    const anonymous = phoneHttps(qr.relay, qr.relay_spki, null);
    assert.equal((await anonymous('POST', `/v1/enroll/${qr.code_id}`, phone.enroll({ codeId: qr.code_id, code: qr.code }))).status, 202);
    await until(() => /does the phone show the same\?/.test(enrollIo.text.out), 'the confirmation prompt');
    enrollIo.stdin.write('y\n');
    assert.equal(await enrolling, 0, enrollIo.text.err);
    await until(async () => (await anonymous('GET', `/v1/enroll/${qr.code_id}`)).body.state === 'done', 'enrollment done');
    const unlock = lockApproversDir(path.join(nodeConfig, 'approvers'));
    dirs.unshift({ unlock });

    // ── The unsafe runbook through mcp ────────────────────────────────────
    const mcp = spawnCli(['mcp', '--data-dir', nodeData]);
    const rpc = (id, method, params) => {
      mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return until(() => mcp.output().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), `mcp reply ${id} (${mcp.errors()})`);
    };
    await rpc(1, 'initialize', {});
    const started = await rpc(2, 'tools/call', { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.touch', params: { target: root } } });
    const job = JSON.parse(started.result.content[0].text);
    assert.equal(job.status, 'awaiting_approval', JSON.stringify(job));

    const pending = await until(async () => {
      const res = await api('GET', '/v1/approvals?wait=5');
      return res.body && res.body.length ? res.body[0] : null;
    }, 'the request on the phone');
    assert.equal(verifyEd25519(pending.envelope, qr.node.key), true, 'the phone shows only what the pinned node signed');
    const request = open(pending.envelope).message;
    assert.equal(request.action.kind, 'runbook');
    assert.equal(request.origin.job_id, job.job_id);
    const answer = await api('POST', `/v1/approvals/${request.request_id}/response`, phone.respond(pending.envelope, 'approve'));
    assert.equal(answer.status, 202);

    let finalJob = null;
    for (let id = 10; ; id += 1) {
      const res = await rpc(id, 'tools/call', { name: 'get_job', arguments: { job_id: job.job_id } });
      finalJob = JSON.parse(res.result.content[0].text);
      if (!['awaiting_approval', 'queued', 'running'].includes(finalJob.status)) break;
      await sleep(200);
    }
    assert.equal(finalJob.status, 'succeeded', JSON.stringify(finalJob));
    assert.equal(fs.readFileSync(path.join(root, 'marker.txt'), 'utf8'), 'ran');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, or passes if Tasks 1–22 are complete**

Run: `node --test tests/approvals-e2e.test.js`
Expected: with Tasks 1–22 merged, PASS (`fail 0`, one test, about 10 s) on Windows or as root; `skipped 1` on POSIX as a normal user. If it fails, the message names the step (`relay ready (…stderr…)`, `pairing`, `the relay link`, `the pairing QR`, `the request on the phone`) — fix the task that owns it before continuing.

- [ ] **Step 3: Implement — the CLAUDE.md section**

Append to `CLAUDE.md`:

```markdown

## Approvals and relay

Fleet stage 3 (spec `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`, wire protocol
`docs/protocol/approval-v1.md`). On a service node, an unsafe remote tool call or `unsafe` runbook runs
only after an enrolled phone signs an approval over the exact action; only `=== true` approves. The
service only reads the approver set in `<configDir>/approvers/`; the admin CLI writes it.

- Relay host (admin `service.json` `relay` block; the mesh listener must be a loopback or private IP):
  `king-louie-service relay run`, `relay code <node-name>`, `relay nodes`, `relay remove-node <name>`, `relay qr`.
- Node, as the administrator: `echo '<code>' | king-louie-service pair wss://<relay-host>:<port>`, set
  `approvers.relay` in `node.yaml`, start the service, then `king-louie-service enroll-device`.
  Enrollments and revocations relayed from phones are staged per node: apply them with
  `king-louie-service device apply [--yes]`; `device list`, `device revoke <device-id>`.
- `mcp` asks through the running service (file courier); with the service stopped every unsafe runbook
  is denied at once.
- Audit: `<dataDir>/audit/ledger-YYYY-MM.jsonl`, hash-chained; `doctor` verifies the chain.
- Tests: `tests/approvals-*.test.js`, `tests/frontdoor-*.test.js`, `tests/audit-ledger.test.js`,
  `tests/service-cli-devices.test.js`, `tests/service-cli-relay.test.js`. Vectors live in
  `tests/vectors/approval-v1/`; after changing a message, run `node tests/vectors/approval-v1/generate.js`
  and commit the files (`--check` must say `38 vectors match`). `tests/approvals-e2e.test.js` spawns real
  processes and runs on Windows or as root.
```

- [ ] **Step 4: Run the full verification**

Run: `npm test`
Expected: `fail 0` (every file under `tests/*.test.js`, including the new ones).

Run: `node tests/vectors/approval-v1/generate.js --check`
Expected: `38 vectors match`

Run: `git diff main --stat -- src tests docs bin package.json CLAUDE.md`
Expected: only the files named in Tasks 1–23 (plus `src/core/origin.js` if Task 11 created it). No change under `src/ipc/`, `preload.js`, `renderer.js`, `styles.css`, `src/core/settings.js`, `src/tools/index.js`.

Check the diff for personal values (program §3):

Run: `git diff main -- src tests docs CLAUDE.md | grep -nE '^\+.*(Users[\\/]|/home/|@[A-Za-z0-9-]+\.(com|net|org|io))' | grep -v 'example\.com'`
Expected: no output (every address, host and path in code, fixtures and docs is an `example.com` placeholder or relative).

Run: `node --test tests/electron-boundary.test.js tests/service-profile-graph.test.js`
Expected: PASS, `fail 0` — nothing under `src/` outside `src/ipc/` requires Electron, and neither the runbook profile nor the relay loads the agent stack.

- [ ] **Step 5: Commit**

```bash
git add tests/approvals-e2e.test.js CLAUDE.md
git commit -m "test(approvals): end to end through relay, node, mcp and a phone; document the commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 4 and to the consuming stages

Part 4 (the mobile apps) needs only what Parts 1–3 committed as data and documentation: `docs/protocol/approval-v1.md`, `tests/vectors/approval-v1/*.json` (including `keys.json`), and a relay to talk to (`king-louie-service relay run`). The Node exports below are what F4, F5, F7, C3 and C4 consume (spec §5.2):

| Module | Exports |
|---|---|
| `src/frontdoor/relay.js` | `startRelay`, `RELAY_EXTENSIONS` (E1) |
| `src/frontdoor/phone-api.js` | `createPhoneApi` (`registerRoute`, `handler`, `routes`), `ApiError`, `BODY_LIMIT`, `SKEW_MS` (E2, E8) |
| `src/frontdoor/node-hub.js` | `NodeHub` (`nodes`, `addCode`, `remove`, `rpc`, `notify`, `onNodeMessage`, `onConnection`, `peerSource`) (E3) |
| `src/frontdoor/push/index.js` | `createPusher`, `defaultSenders`, `alertText`, `KINDS` (E4); `push/none.js` `noneSender`; `push/apns.js` `createApnsSender`; `push/fcm.js` `createFcmSender` |
| `src/frontdoor/mailbox.js` | `Mailbox` (`registerType`, `put`, `list`, `wait`, `sweep`), `MAX_WAIT_MS` |
| `src/frontdoor/device-registry.js`, `approval-cache.js`, `invites.js` | `DeviceRegistry`, `ApprovalCache`, `Invites`, `TTL_MS` |
| `src/frontdoor/extensions.js` | the array F5 and C4 append one line to |
| `src/frontdoor/routes.js`, `node-methods.js`, `net.js`, `tls.js` | `registerPhoneRoutes`, `registerNodeMethods`, `assertPrivateMeshHost`, `relaySpkiPin` |
| `src/approvals/service-wiring.js` | `startApprovals` (P9), `startMcpApprovals`, `createRelayDispatcher`, `trackDeviceStates`, `nullLink`, `RELAY_PIN_KEY` |
| `src/service/config.js` | `loadServiceConfig` → `relay`, `audit`; `parseRelayConfig`, `parseAuditConfig` |
| `src/service/node-config.js` | `loadNodeConfig` → `approvers: { relay, requestTtlS }` |
| `src/service/commands/pair.js` | `runPair`, `USAGE` (F4 extends the `https://` branch) |
| `src/service/commands/devices.js`, `relay.js`, `io.js` | `runEnrollDevice`, `runDevice`, `DEVICE_HELP`; `runRelayCommand`, `RELAY_HELP`, `CODE_TTL_MS`; `readLine`, `runningServicePid`, `renderQr` |
