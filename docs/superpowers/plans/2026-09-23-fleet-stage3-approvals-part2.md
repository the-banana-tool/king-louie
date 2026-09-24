# Fleet Stage 3: Signed approvals, relay and mobile app — Implementation Plan (Part 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the protocol with the approval-v1 vectors, route unsafe tool calls through node-policy tiers and the phone (with the desktop seam), and give a node its link to the relay: the RPC layer, the `RelayClient`, the file courier for out-of-process producers and unsafe runbooks through `mcp`.
**Architecture:** Builds on Part 1's merged modules (`src/platform/jcs.js`, `src/approvals/{envelope,messages,test-keys,approver-store,approver-admin,verify-device,pending-store,phone-approver}.js`, `src/audit/audit-ledger.js`). Adds `docs/protocol/approval-v1.md` and the vectors, additive changes to `src/execution/tool-executor.js` and `src/core/create-core.js` (the §4.21 seam through `src/approvals/executor-options.js`), `listen: false` in `MeshTransport`, pairing additions in `MeshPairing`, `src/approvals/{link-rpc,relay-client,courier}.js` and the unsafe-runbook path in `src/mcp/stdio-server.js` / `src/runbooks/runbook-engine.js`. Nothing starts a relay link yet: Part 3 wires `startApprovals` into the service and adds the relay and CLI.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `ws` (already a dependency, through `MeshTransport`). No new npm dependency in this part.
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

From Part 1 (merged): everything in Part 1's hand-off table — in particular `PhoneApprover`, `ApproverStore`, `AuditLedger`, `verifyDeviceEnvelope`, `messages.js`, `envelope.js`, and the test helpers `createFakePhone`, `testNodeIdentity`, `approverStoreWith`.

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

### Task 10: approval-v1 protocol document and vectors

**Files:**
- Create: `docs/protocol/approval-v1.md`, `tests/vectors/approval-v1/phone-reference.js`, `tests/vectors/approval-v1/generate.js`, the 38 generated `tests/vectors/approval-v1/<name>.json` files
- Test: `tests/approvals-protocol.test.js`

**Interfaces:**
- Consumes: Part 1's `canonicalize`; `seal`, `open`, `fromB64url`, `verifyEs256`, `verifyEd25519`, `nodeSigner`, `deviceIdFromJwk`, `deriveDeviceId`, `fingerprintGroups`; `enrollMac`, `phoneAuthString`, `validateMessage`; `AuditLedger`, `entryHash`, `verifyAuditSlice`; `PhoneApprover` (its `buildRequest`, `setTimer`, `now` options and `nonces`); `ApproverStore.stage`; `verifyConsoleEnrollment`; `testNodeIdentity`, `createFakePhone`, `approverStoreWith`, `KEYS`.
- Produces (program §4.15, P21): the protocol document the apps are built from; `tests/vectors/approval-v1/*.json` (`{ name, consumers, check?, given, input, expect }`); `buildVectors({ sigCache }) → vector[]`, `serialize(vector)`, `loadSigCache()`, `NOW` (`generate.js`); `phoneView(envelope, pinned) → { shown, reason, display }`, `buildDisplay(message)`, `escapeText(text)`, `isHidden(codePoint)`, `COLLAPSE_OVER` (2000), `HEAD` (1200), `TAIL` (400) (`phone-reference.js`). Part 4's `ProtocolVectorTests.swift` and `ProtocolVectorTest.kt` read the same files.

Vector names (38): `jcs`, `device-id-p256`, `device-id-ed25519`, `request-valid`, `request-bad-node-signature`, `request-unpinned-node`, `request-display`, `response-approve`, `response-deny`, `response-reject-{malformed-noncanonical, unsupported-version, wrong-alg, kid-mismatch, unknown-device, demo-device, test-key, revoked-device, revoked-via-overlay, bad-signature, wrong-node, replay, already-decided, unknown-request, nonce-mismatch, action-hash-mismatch, expires-mismatch, expired, changed-parameter}`, `response-accept-phone-clock-ahead`, `enroll-console`, `enroll-console-bad-mac`, `enroll-signed`, `enroll-signed-by-overlay-revoked`, `revoke-valid`, `revoke-self-rejected`, `revoke-mutual`, `audit-slice`, `phone-api-auth`.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-protocol.test.js`:

```js
// tests/approvals-protocol.test.js
//
// Runs every approval-v1 vector whose consumers include `node` through the
// production code, checks the phone vectors against the reference rules, and
// checks the committed files are exactly what generate.js produces.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { canonicalize } = require('../src/platform/jcs');
const { open, deviceIdFromJwk, deriveDeviceId, fingerprintGroups, fromB64url, verifyEs256 } = require('../src/approvals/envelope');
const { phoneAuthString } = require('../src/approvals/messages');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { verifyAuditSlice } = require('../src/audit/audit-ledger');
const { testNodeIdentity, createFakePhone, KEYS } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/approval-v1/generate');
const { phoneView } = require('./vectors/approval-v1/phone-reference');

const DIR = path.join(__dirname, 'vectors', 'approval-v1');
const EXPECTED = [
  'jcs', 'device-id-p256', 'device-id-ed25519', 'request-valid', 'request-bad-node-signature', 'request-unpinned-node', 'request-display',
  'response-approve', 'response-deny',
  ...['malformed-noncanonical', 'unsupported-version', 'wrong-alg', 'kid-mismatch', 'unknown-device', 'demo-device', 'test-key', 'revoked-device',
    'revoked-via-overlay', 'bad-signature', 'wrong-node', 'replay', 'already-decided', 'unknown-request', 'nonce-mismatch', 'action-hash-mismatch',
    'expires-mismatch', 'expired', 'changed-parameter'].map((n) => `response-reject-${n}`),
  'response-accept-phone-clock-ahead', 'enroll-console', 'enroll-console-bad-mac', 'enroll-signed', 'enroll-signed-by-overlay-revoked',
  'revoke-valid', 'revoke-self-rejected', 'revoke-mutual', 'audit-slice', 'phone-api-auth'
];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'keys.json')
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const nodeKeyName = (id) => Object.keys(KEYS.nodes).find((k) => KEYS.nodes[k].id === id);
const quietLink = () => Object.assign(new EventEmitter(), { isConnected: () => true, canDeliver: () => ({ ok: true }), submit: async () => {}, status: async () => {} });
const quietLedger = () => ({ append: async (e) => e });

async function runResponseVector(v) {
  const now = () => Date.parse(v.given.now);
  const store = await approverStoreWith(v.given.approvers, { overlay: v.given.overlay, allowTestKeys: v.given.allow_test_keys, now });
  stores.push(store);
  const queue = [...v.given.pending];
  const approver = new PhoneApprover({
    identity: testNodeIdentity({ key: nodeKeyName(v.given.node.id) }),
    approverStore: store,
    link: quietLink(),
    auditLedger: quietLedger(),
    now,
    setTimer: () => null,
    clearTimer: () => {},
    buildRequest: () => {
      const envelope = queue.shift();
      const { message, bytes } = open(envelope);
      return { message, envelope, bytes };
    }
  });
  for (const env of v.given.pending) {
    const { message } = open(env);
    approver.requestAction(message.action, { origin: message.origin, currentAction: () => v.given.current_action });
  }
  for (let i = 0; i < 50 && approver.pending().length < v.given.pending.length; i += 1) await new Promise((r) => setImmediate(r));
  for (const used of v.given.used) approver.nonces.add(used.nonce, used.sha256);
  const result = await approver.handleResponse(v.input);
  approver.stop();
  return result;
}

describe('approval-v1 vectors', () => {
  it('every vector the spec names is committed, and nothing else', () => {
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
  });

  it('the committed files are exactly what generate.js produces', () => {
    for (const v of buildVectors()) {
      assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), v.name);
    }
  });

  for (const v of vectors.filter((x) => x.name.startsWith('response-'))) {
    it(`${v.name} (check ${v.check})`, async () => {
      assert.deepEqual(await runResponseVector(v), v.expect);
    });
  }

  for (const v of vectors.filter((x) => /^(enroll-signed|revoke-)/.test(x.name))) {
    it(v.name, async () => {
      const store = await approverStoreWith(v.given.approvers, { overlay: v.given.overlay, allowTestKeys: v.given.allow_test_keys, now: () => Date.parse(v.given.now) });
      stores.push(store);
      const results = v.input.map((env) => store.stage(env));
      assert.deepEqual(results, v.expect.results);
      const active = v.given.approvers.map((r) => r.device_id).filter((id) => store.isActive(id));
      assert.deepEqual(active.sort(), [...v.expect.active].sort());
    });
  }

  for (const v of vectors.filter((x) => x.name.startsWith('enroll-console'))) {
    it(v.name, () => {
      const r = verifyConsoleEnrollment(v.input, { codeId: v.given.code_id, code: v.given.code, now: Date.parse(v.given.now), allowTestKeys: v.given.allow_test_keys });
      assert.deepEqual({ accepted: r.ok, reason: r.ok ? null : r.reason, device_id: r.ok ? r.deviceId : null }, v.expect);
    });
  }

  it('jcs', () => {
    const v = byName.get('jcs');
    assert.deepEqual(v.input.cases.map((c) => canonicalize(c)), v.expect.canonical);
  });

  it('device-id-p256 and device-id-ed25519', () => {
    const p = byName.get('device-id-p256');
    assert.deepEqual(p.input.jwks.map(deviceIdFromJwk), p.expect.device_ids);
    assert.deepEqual(p.expect.device_ids.map(fingerprintGroups), p.expect.grouped);
    const e = byName.get('device-id-ed25519');
    assert.equal(deriveDeviceId(fromB64url(e.input.raw), e.input.prefix), e.expect.device_id);
  });

  it('audit-slice', () => {
    const v = byName.get('audit-slice');
    const r = verifyAuditSlice(v.input, v.given.node.key);
    assert.deepEqual({ accepted: r.ok, reason: r.reason, entries: r.message.entries.length }, v.expect);
  });

  it('phone-api-auth', () => {
    const v = byName.get('phone-api-auth');
    const s = phoneAuthString(v.given.method, v.given.path, v.given.timestamp, v.given.body);
    assert.equal(s, v.expect.signing_string);
    assert.equal(s.split('\n')[4], v.expect.body_sha256);
    const env = { alg: 'ES256', kid: v.given.device.device_id, payload: Buffer.from(s).toString('base64url'), sig: v.input.signature };
    assert.equal(verifyEs256(env, v.given.device.jwk), v.expect.accepted);
  });

  for (const v of vectors.filter((x) => x.consumers.includes('ios') && x.name.startsWith('request-'))) {
    it(`${v.name} (phone reference)`, () => {
      assert.deepEqual(phoneView(v.input, v.given.pinned_nodes), v.expect);
    });
  }

  it('a device revoked while its approval is in flight is refused', async () => {
    const identity = testNodeIdentity();
    const owner = createFakePhone();
    const thief = createFakePhone();
    const store = await approverStoreWith([owner.approverRecord(), thief.approverRecord()]);
    stores.push(store);
    const link = quietLink();
    const sent = [];
    link.submit = async (env) => { sent.push(env); };
    const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: quietLedger(), setTimer: () => null, clearTimer: () => {} });
    const action = { kind: 'tool', name: 'Bash', params: { command: 'ls' }, cwd: null, summary: 'Bash(ls)' };
    const pending = approver.requestAction(action, { currentAction: () => action });
    for (let i = 0; i < 50 && sent.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(store.stage(owner.revoke(thief.deviceId)).state, 'revoked-pending-apply');
    assert.deepEqual(await approver.handleResponse(thief.respond(sent[0], 'approve')), { accepted: false, reason: 'revoked_device' });
    assert.equal((await approver.handleResponse(owner.respond(sent[0], 'deny'))).accepted, true);
    assert.equal((await pending).decision, 'deny');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-protocol.test.js`
Expected: FAIL with `Cannot find module './vectors/approval-v1/generate'`.

- [ ] **Step 3: Implement**

Create `docs/protocol/approval-v1.md`:

````markdown
# approval-v1 — signed phone approvals

This is the wire protocol between a King Louie node, the relay, and the phone
apps. The iOS and Android apps are built from this document alone and must pass
every vector in `tests/vectors/approval-v1/` whose `consumers` name them. The
Node implementation lives in `src/approvals/`, `src/audit/` and `src/frontdoor/`.

## 1. Canonical form and envelopes

Every signed message is a JSON object serialized with RFC 8785 (JCS): object
keys sorted by UTF-16 code units, no whitespace, strings escaped as
`JSON.stringify` does (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other controls
below U+0020 as lowercase `\u00xx`, everything else literal UTF-8), numbers in
ECMAScript form. Phones only ever canonicalize messages made of strings,
integers and nested objects (`response`, `enroll`, `revoke`), so they need no
number formatting.

A signed message travels as an envelope:

```json
{ "alg": "Ed25519", "kid": "kl-3v7q2m4k8d1x9c0a", "payload": "<b64url(JCS bytes)>", "sig": "<b64url>" }
```

- `alg` is `Ed25519` (nodes) or `ES256` (phones). `kid` is the signer's
  `node_id` or `device_id` and equals the id inside the payload.
- `payload` is base64url without padding of the JCS bytes; `sig` is base64url
  of the 64-byte signature over exactly those bytes. ES256 signatures are raw
  `r || s` (IEEE P1363), not DER.
- Verifiers check the signature over the bytes they received and never
  re-serialize to verify. Nodes additionally require the bytes to be canonical
  (`malformed` otherwise), which rules out duplicate keys.

## 2. Keys and identifiers

- Node keys are Ed25519, carried as DER SubjectPublicKeyInfo hex. A node id is
  `kl-` + the first 16 characters of lowercase, unpadded RFC 4648 base32 of
  SHA-256 over the raw 32-byte key.
- Phone keys are P-256, carried as a JWK with exactly `kty: "EC"`,
  `crv: "P-256"`, `x`, `y` (32-byte base64url each). A device id is `d-` + the
  first 16 base32 characters of SHA-256 over the 65-byte uncompressed point
  `0x04 || x || y`. Desktop devices use the 32-byte Ed25519 key with prefix
  `kld-` (vector `device-id-ed25519`).
- Fingerprints are shown to people in groups of four: `d-abcdefghijklmnop` →
  `abcd efgh ijkl mnop`.

## 3. Messages

Timestamps are RFC 3339 UTC: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`.
Nonces are 32 random bytes in base64url (43 characters). Request ids are UUID v4.

### 3.1 `kl.approval.request` (node-signed)

```json
{ "v": 1, "type": "kl.approval.request", "request_id": "<uuid v4>", "node_id": "kl-…", "node_name": "web-01",
  "action": { "kind": "runbook", "name": "site.pull_and_restart", "params": { "ref": "main" },
              "steps": [["git","-C","/srv/site","fetch","--prune","origin"], {"check":{"http_get":"https://www.example.com/healthz","expect_status":200,"retries":5}}],
              "summary": "Run runbook site.pull_and_restart on web-01" },
  "action_hash": "<b64url sha256 of JCS(action)>", "origin": { "client": "stdio-mcp", "session": null, "job_id": "job-…" },
  "created_at": "…", "expires_at": "…", "nonce": "<b64url 32 bytes>" }
```

| `action.kind` | Fields |
|---|---|
| `tool` | `name`, `params`, `cwd` (string or null), `summary` |
| `runbook` | `name`, `params` (validated), `steps` (each `run` argv substituted, each `check` as written), `summary` |
| `envelope` | `name` (executor id), `params: { case_id, envelope_hash }`, `summary` |

`origin` is `{ client, session, job_id }`, plus `deviceId` when `client` is `desktop`.
The request lives at most 300 seconds (`expires_at − created_at`, 30–300 s).

### 3.2 `kl.approval.response` (phone-signed)

`{ v, type, request_id, node_id, action_hash, nonce, decision, expires_at, device_id, signed_at }` —
`request_id`, `node_id`, `action_hash`, `nonce` and `expires_at` are copied from
the request; `decision` is `approve` or `deny`; `signed_at` is the phone's clock
and is recorded, never judged. No other members are allowed.

### 3.3 `kl.approval.status` (node-signed)

`{ v, type, request_id, node_id, state, device_id, reason, at }` with `state` one
of `approved`, `denied`, `expired`, `withdrawn`, `refused`.

### 3.4 Enrollment and revocation (phone-signed)

`kl.device.enroll`: `{ v, type, device: { device_id, name, platform, public_key }, enrolled_by, created_at, expires_at, nonce }`.

- Console enrollment: `enrolled_by: null`, signed by the new device itself
  (`kid = device.device_id`), plus `code_id` and
  `code_mac = b64url(HMAC-SHA256(key = the 32 raw bytes of code, JCS(message without code_mac)))`.
- Signed enrollment of another phone: `enrolled_by` is the signing device's id
  (`kid = enrolled_by`) and there is no `code_id`/`code_mac`.
- `expires_at − created_at` is at most 10 minutes. `platform` is `ios`,
  `android` or `demo` (nodes never accept `demo`).

`kl.device.revoke`: `{ v, type, device_id, revoked_by, reason, created_at, expires_at, nonce }`,
`kid = revoked_by ≠ device_id`, at most 7 days between `created_at` and `expires_at`.

### 3.5 Node control messages (node-signed)

- `kl.enroll.open { v, type, node_id, code_id, expires_at, nonce }`
- `kl.enroll.done { v, type, node_id, code_id, enroll: <envelope> | null, refused, nonce }`
- `kl.audit.slice { v, type, node_id, entries, head: { seq, hash }, anchor: { seq, prev }, created_at }` —
  each entry's `hash` is hex SHA-256 over JCS of the entry without `hash`, and
  `prev` links to the previous entry. `anchor` is the oldest retained entry.
- `kl.audit.slice.head { v, type, node_id, seq, hash, at }`

## 4. What the node checks on a response

In this order; the first failure decides the reason (vectors `response-*`).

| # | Check | Reason |
|---|---|---|
| 1 | Envelope opens, bytes canonical, `v === 1`, right type, fields well formed | `malformed`, `unsupported_version` |
| 2 | `alg === 'ES256'`, `kid === device_id` | `malformed` |
| 3 | Device is in the node's approver set | `unknown_device` |
| 4 | Not a demo device; not a published test key | `demo_device`, `test_key` |
| 5 | Not revoked (admin-applied or pending revocation) | `revoked_device` |
| 6 | Signature | `bad_signature` |
| 7 | `node_id` is this node | `wrong_node` |
| 8 | Nonce not already used: same bytes → `replay`, other bytes → `already_decided` | `replay`, `already_decided` |
| 9 | Request pending | `unknown_request` |
| 10 | `nonce`, `action_hash`, `expires_at` match the request | `nonce_mismatch`, `action_hash_mismatch`, `expires_mismatch` |
| 11 | Node clock ≤ `expires_at` | `expired` |
| 12 | The action rebuilt from live state hashes to `action_hash` | `action_changed` |
| 13 | Audited | `audit_unavailable` |

## 5. What the phone checks and shows

- A request is shown only if its `node_id` is pinned (from a pairing or invite
  QR code, never from the relay's node list) and `kid === node_id`
  (`unpinned_node` otherwise), and its signature verifies against the pinned
  key (`bad_node_signature`). A node whose key changed shows "Node key changed —
  pair again".
- Time left counts from receipt: the relay sends `expires_in_ms`; the phone
  counts it down on a monotonic clock and refuses to sign at zero.
- The approval screen (vector `request-display`) shows:
  - `node.name` and `node.id`, `kind`, `name`, `summary`, `cwd`, `origin`;
  - `items`: every parameter, flattened in JCS key order with paths such as
    `params.a.b` and `params.list[0]`, then every runbook step as `steps[i]`.
    Strings are shown in full; numbers, booleans and null as their JSON text
    (the payload is canonical, so this is the text received); empty objects and
    arrays as `{}` and `[]`.
  - Command-like values (a key named `command`, `script` or `argv` anywhere on
    the path, and every `run` step, whose argv is joined with single spaces)
    longer than 2000 code points are collapsed to the first 1200 and the last
    400 code points, with the count hidden between them ("N characters hidden —
    Show all"). `check` steps are shown as their JCS text.
  - In every displayed string, code points U+0000–U+001F, U+007F–U+009F,
    U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and U+FEFF are replaced by
    `‹U+XXXX›` (uppercase hex, at least four digits).
- Each item in the vector is `{ path, text, tail, hidden }`: `tail` is null and
  `hidden` 0 unless the value was collapsed.

## 6. QR codes

`kl1:` + base64url(JCS(object)). Node keys are DER SPKI hex.

| `t` | Printed by | Fields |
|---|---|---|
| `kl.pair` | `king-louie-service enroll-device` | `relay`, `relay_spki` (`sha256/<b64url of SHA-256 over the leaf certificate's SPKI DER>`), `code_id`, `code`, `node: { id, name, key }` |
| `kl.invite` | an enrolled phone | `relay`, `relay_spki`, `invite_id`, `secret` (b64url 32 bytes), `nodes: [{ id, name, key }]` |
| `kl.relay` | `king-louie-service relay qr` | `relay`, `relay_spki` |

Phones pin the relay's leaf SPKI and ignore certificate authorities.

## 7. Phone API (relay, HTTPS, JSON, prefix `/v1`)

Device authentication: headers `X-KL-Device`, `X-KL-Timestamp` (RFC 3339 UTC)
and `X-KL-Signature = b64url(ES256-P1363(UTF-8 of S))` where

```
S = "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body))
```

The relay requires `|timestamp − relay clock| ≤ 120 s` (else `401
{"error":"clock_skew","server_time":"…"}`; the app applies the offset and
retries once), a registered device, a valid signature, and that
`SHA-256(S) || device_id` was not seen in the last 5 minutes. Code and invite
routes need no signature: the unguessable `code_id` / `invite_id` in the path is
the credential. Errors are `{ "error": "<code>", "message": "…" }`; `429`
carries `retry_after`. Rate limits: 10/min per IP unauthenticated, 120/min per
device.

| Method, path | Auth | Body → reply |
|---|---|---|
| `GET /v1/time` | none | → `{ server_time }` |
| `POST /v1/enroll/{code_id}` | code | enroll envelope → `202 { state: 'waiting' }` |
| `GET /v1/enroll/{code_id}` | code | → `{ state: 'waiting'\|'done'\|'refused'\|'expired', node }` |
| `GET /v1/approvals?wait=0..25` | device | → `[{ envelope, expires_in_ms, status }]`; waits up to `wait` s for something new since this device's last call |
| `GET /v1/approvals/{request_id}` | device | → `{ envelope, expires_in_ms, status }` / `404` |
| `POST /v1/approvals/{request_id}/response` | device | response envelope → `202 { delivered: true, accepted, reason }` / `503 node_offline` / `410 gone` |
| `GET /v1/nodes` | device | → `[{ node_id, node_name, online }]` (no keys) |
| `GET /v1/nodes/{node_id}/history?limit&before_seq` | device | → `kl.audit.slice` envelope |
| `POST /v1/pairing-codes` | device | `{ node_name }` → `{ code, expires_at }` |
| `POST /v1/devices/invites` | device | → `{ invite_id, expires_at }` |
| `POST /v1/devices/invites/{id}/claim` | invite | `{ device, mac }` → `202` |
| `GET /v1/devices/invites/{id}` | device | → `{ claim }` (inviting device only) |
| `POST /v1/devices/enroll` | device | enroll envelope → `{ nodes: [{ node_id, state }] }` |
| `POST /v1/devices/revoke` | device | revoke envelope → `{ nodes: [{ node_id, state }] }` |
| `GET /v1/devices` | device | → `[{ device_id, name, platform, nodes: [{ node_id, state }] }]` |
| `PUT /v1/push-token` | device | `{ platform: 'apns'\|'fcm', token }` → `204` |

An invite claim's `mac` is `b64url(HMAC-SHA256(key = the 32 raw bytes of secret, JCS(device)))`;
the inviting phone, not the relay, checks it.

## 8. Push

Push carries only `{ kind, id }` (and the node name in the alert text): APNs
`{"aps":{"alert":…},"kl":{"rid":id,"k":kind}}`, FCM data `{ rid, n, k }`. Kinds:
`approval`, `grant`, `pairing`, `alert`, `question`, `lease`; a missing `k` means
`approval`. On a tap the app fetches the envelope and verifies it. Without push
the app long-polls `GET /v1/approvals?wait=25` while in the foreground.

## 9. Vectors

`tests/vectors/approval-v1/<name>.json`: `{ name, consumers, check?, given, input, expect }`.
`keys.json` holds the fixed test keys (Ed25519 seeds for nodes, P-256 `d` for
devices A, B, C); nodes refuse these device keys unless built with
`allowTestKeys`. `generate.js` rebuilds every file; `phone-reference.js` is the
phone rules above in JavaScript.

| Vectors | Consumers | Run as |
|---|---|---|
| `jcs` | all | `canonicalize(input.cases[i]) === expect.canonical[i]` |
| `device-id-p256`, `device-id-ed25519` | all | derive ids from `input` |
| `request-*` | ios, android | show / hide with `given.pinned_nodes`; compare `display` |
| `response-*` | node | pending request, approvers, overlay, used nonces from `given`; `{ accepted, reason }` |
| `enroll-console*` | node (and phones build `enroll-console` payloads the same way) | console check with `given.code_id`, `given.code` |
| `enroll-signed*`, `revoke-*` | node | stage each `input[i]`; `expect.results`, `expect.active` |
| `audit-slice` | all | signature, shape and chain of a history slice |
| `phone-api-auth` | all | `S` and body hash equal `expect`; the signature verifies |
````

Create `tests/vectors/approval-v1/phone-reference.js`:

```js
// tests/vectors/approval-v1/phone-reference.js
//
// The phone-side rules of docs/protocol/approval-v1.md written in JavaScript:
// whether a request may be shown (node pin and signature) and exactly what the
// approval screen displays. generate.js uses it to write the expectations of
// the phone vectors; the iOS and Android apps implement the same rules and
// must produce the same `display`.
const { open, verifyEd25519, EnvelopeError } = require('../../../src/approvals/envelope');
const { validateMessage } = require('../../../src/approvals/messages');
const { canonicalize } = require('../../../src/platform/jcs');

const COMMAND_KEYS = new Set(['command', 'script', 'argv']);
const COLLAPSE_OVER = 2000;
const HEAD = 1200;
const TAIL = 400;
const OPEN_MARK = String.fromCodePoint(0x2039);
const CLOSE_MARK = String.fromCodePoint(0x203a);

// C0, DEL and C1 controls, zero-width and directional marks, bidi embeddings
// and isolates, and the BOM are shown as ‹U+XXXX› so nothing can hide or
// reorder text on the approval screen.
function isHidden(cp) {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
}

function escapeText(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    out += isHidden(cp) ? `${OPEN_MARK}U+${cp.toString(16).toUpperCase().padStart(4, '0')}${CLOSE_MARK}` : ch;
  }
  return out;
}

function stringItem(path, value, commandLike) {
  const chars = Array.from(value);
  if (commandLike && chars.length > COLLAPSE_OVER) {
    return {
      path,
      text: escapeText(chars.slice(0, HEAD).join('')),
      tail: escapeText(chars.slice(chars.length - TAIL).join('')),
      hidden: chars.length - HEAD - TAIL
    };
  }
  return { path, text: escapeText(value), tail: null, hidden: 0 };
}

function flatten(value, path, commandLike, out) {
  if (typeof value === 'string') {
    out.push(stringItem(path, value, commandLike));
  } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    // Numbers as their JSON text: the payload is JCS, so this is the lexeme sent.
    out.push({ path, text: JSON.stringify(value), tail: null, hidden: 0 });
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push({ path, text: '[]', tail: null, hidden: 0 });
    else if (commandLike && value.every((v) => typeof v === 'string')) out.push(stringItem(path, value.join(' '), true));
    else value.forEach((v, i) => flatten(v, `${path}[${i}]`, commandLike, out));
  } else {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) out.push({ path, text: '{}', tail: null, hidden: 0 });
    for (const k of keys) flatten(value[k], `${path}.${k}`, commandLike || COMMAND_KEYS.has(k), out);
  }
}

function buildDisplay(message) {
  const { action } = message;
  const items = [];
  flatten(action.params, 'params', false, items);
  if (Array.isArray(action.steps)) {
    action.steps.forEach((step, i) => {
      if (Array.isArray(step)) items.push(stringItem(`steps[${i}]`, step.join(' '), true));
      else items.push({ path: `steps[${i}]`, text: escapeText(canonicalize(step)), tail: null, hidden: 0 });
    });
  }
  const origin = {};
  for (const k of Object.keys(message.origin).sort()) origin[k] = message.origin[k] === null ? null : escapeText(message.origin[k]);
  return {
    node: { id: message.node_id, name: escapeText(message.node_name) },
    kind: action.kind,
    name: escapeText(action.name),
    summary: escapeText(action.summary),
    cwd: action.cwd === undefined || action.cwd === null ? null : escapeText(action.cwd),
    origin,
    items
  };
}

// pinned: [{ id, key }] from pairing and invite QR codes only.
function phoneView(envelope, pinned) {
  const hide = (reason) => ({ shown: false, reason, display: null });
  let message;
  try {
    ({ message } = open(envelope));
  } catch (err) {
    if (err instanceof EnvelopeError) return hide('malformed');
    throw err;
  }
  if (validateMessage('kl.approval.request', message)) return hide('malformed');
  const pin = pinned.find((n) => n.id === message.node_id);
  if (!pin || envelope.kid !== message.node_id) return hide('unpinned_node');
  if (!verifyEd25519(envelope, pin.key)) return hide('bad_node_signature');
  return { shown: true, reason: null, display: buildDisplay(message) };
}

module.exports = { phoneView, buildDisplay, escapeText, isHidden, COLLAPSE_OVER, HEAD, TAIL };
```

Create `tests/vectors/approval-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/approval-v1/generate.js
//
// Rebuilds every approval-v1 vector from keys.json.
//   node tests/vectors/approval-v1/generate.js          write the files
//   node tests/vectors/approval-v1/generate.js --check  exit 1 if any differ
//
// Everything is deterministic except ECDSA: P-256 signatures are randomized,
// so a signature already committed for the same payload (and valid for it) is
// reused. That keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalize } = require('../../../src/platform/jcs');
const { seal, fromB64url, verifyEs256, nodeSigner, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { enrollMac, phoneAuthString } = require('../../../src/approvals/messages');
const { deriveNodeId, base32Encode } = require('../../../src/mesh/node-identity');
const { AuditLedger, entryHash } = require('../../../src/audit/audit-ledger');
const { phoneView } = require('./phone-reference');

const DIR = __dirname;
const KEYS = require('./keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const nonceOf = (label) => sha(`nonce ${label}`).toString('base64url');
const codeIdOf = (label) => sha(`code-id ${label}`).subarray(0, 16).toString('base64url');
function uuidOf(label) {
  const b = sha(`uuid ${label}`).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, publicKey: spki, key: spki.toString('hex'), sign: (b) => crypto.sign(null, b, key) };
}

// kid + payload → sig for every ES256 envelope in the committed files, plus
// 'api:' + signing string → signature for the phone API vector.
function loadSigCache() {
  const cache = new Map();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.alg === 'ES256' && typeof v.payload === 'string' && typeof v.sig === 'string') cache.set(`${v.kid}:${v.payload}`, v.sig);
    if (typeof v.signing_string === 'string' && typeof v.signature === 'string') cache.set(`api:${v.signing_string}`, v.signature);
    for (const child of Object.values(v)) walk(child);
  };
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && n !== 'keys.json')) {
    walk(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  }
  return cache;
}

function deviceSigner(name, cache) {
  const d = KEYS.devices[name];
  const key = crypto.createPrivateKey({ key: { ...d.jwk, d: d.d }, format: 'jwk' });
  const id = deviceIdFromJwk(d.jwk);
  const signBytes = (bytes) => crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
  return {
    id,
    jwk: d.jwk,
    alg: 'ES256',
    kid: id,
    sign(bytes) {
      const payload = Buffer.from(bytes).toString('base64url');
      const cached = cache.get(`${id}:${payload}`);
      if (cached && verifyEs256({ alg: 'ES256', kid: id, payload, sig: cached }, d.jwk)) return fromB64url(cached);
      const sig = signBytes(bytes);
      cache.set(`${id}:${payload}`, sig.toString('base64url'));
      return sig;
    },
    signText(text) {
      const cached = cache.get(`api:${text}`);
      const env = { alg: 'ES256', kid: id, payload: Buffer.from(text).toString('base64url'), sig: cached || '' };
      if (cached && verifyEs256(env, d.jwk)) return cached;
      const sig = signBytes(Buffer.from(text)).toString('base64url');
      cache.set(`api:${text}`, sig);
      return sig;
    }
  };
}

function approver(dev, extra = {}) {
  return {
    v: 1, device_id: dev.id, name: `Test phone ${dev.id.slice(2, 6)}`, platform: 'android', public_key: dev.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: null, revoked_by: null, enrollment: null, ...extra
  };
}

function buildVectors({ sigCache = loadSigCache() } = {}) {
  const web = nodeIdentity('web-01');
  const gpu = nodeIdentity('gpu-box');
  const A = deviceSigner('A', sigCache);
  const B = deviceSigner('B', sigCache);
  const C = deviceSigner('C', sigCache);
  const nodeRef = { id: web.nodeId, name: web.nodeName, key: web.key };
  const vectors = [];
  const add = (v) => vectors.push(v);

  // ── Canonical form and identifiers ────────────────────────────────────────
  const jcsCases = [
    { device: { platform: 'ios', name: 'Owner phone', device_id: A.id }, v: 1, type: 'kl.test' },
    { quote: '"', backslash: String.fromCodePoint(0x5c), newline: '\n', tab: '\t', nul: String.fromCodePoint(0), del: String.fromCodePoint(0x7f) },
    { euro: String.fromCodePoint(0x20ac), emoji: String.fromCodePoint(0x1f600), ls: String.fromCodePoint(0x2028), rtl: String.fromCodePoint(0x202e) },
    { [String.fromCodePoint(0x20ac)]: 1, '\r': 2, [String.fromCodePoint(0xfb33)]: 3, 1: 4, [String.fromCodePoint(0x1f600)]: 5, [String.fromCodePoint(0x80)]: 6, [String.fromCodePoint(0xf6)]: 7 },
    { a: { c: { e: 0, d: -1 }, b: [] }, z: 42 }
  ].map((value) => ({ value, canonical: canonicalize(value) }));
  add({ name: 'jcs', consumers: ['node', 'ios', 'android'], given: {}, input: { cases: jcsCases.map((c) => c.value) }, expect: { canonical: jcsCases.map((c) => c.canonical) } });

  add({
    name: 'device-id-p256',
    consumers: ['node', 'ios', 'android'],
    given: {},
    input: { jwks: [A.jwk, B.jwk, C.jwk] },
    expect: { device_ids: [A.id, B.id, C.id], grouped: [A.id, B.id, C.id].map((id) => id.slice(2).match(/.{4}/g).join(' ')) }
  });
  const rawWeb = web.publicKey.subarray(12);
  const kld = `kld-${base32Encode(crypto.createHash('sha256').update(rawWeb).digest()).slice(0, 16)}`;
  add({ name: 'device-id-ed25519', consumers: ['node', 'ios', 'android'], given: {}, input: { raw: rawWeb.toString('base64url'), prefix: 'kld-' }, expect: { device_id: kld } });

  // ── Requests (phone side) ─────────────────────────────────────────────────
  const toolActionLit = { kind: 'tool', name: 'Bash', params: { command: 'git push origin main' }, cwd: '/srv/site', summary: 'Bash(git push origin main)' };
  const request = (identity, label, action, { origin = { client: 'gateway', session: 'chat-1', job_id: null }, created = NOW_MS } = {}) => {
    const actionHash = crypto.createHash('sha256').update(canonicalize(action)).digest('base64url');
    return seal({
      v: 1, type: 'kl.approval.request', request_id: uuidOf(label), node_id: identity.nodeId, node_name: identity.nodeName,
      action, action_hash: actionHash, origin, created_at: iso(created), expires_at: iso(created + 300000), nonce: nonceOf(label)
    }, nodeSigner(identity));
  };
  const pinnedWeb = [{ id: web.nodeId, key: web.key }];
  const phoneVector = (name, env, pinned) => add({ name, consumers: ['ios', 'android'], given: { now: NOW, pinned_nodes: pinned }, input: env, expect: phoneView(env, pinned) });

  const req = request(web, 'main', toolActionLit);
  phoneVector('request-valid', req, pinnedWeb);
  const forged = { ...req, sig: request(web, 'other', toolActionLit).sig };
  phoneVector('request-bad-node-signature', forged, pinnedWeb);
  phoneVector('request-unpinned-node', request(gpu, 'gpu', toolActionLit), pinnedWeb);

  const rtl = String.fromCodePoint(0x202e);
  const zw = String.fromCodePoint(0x200b);
  const longCommand = `echo start && ${'x'.repeat(2400)} && echo end`;
  const runbookAction = {
    kind: 'runbook',
    name: 'site.pull_and_restart',
    params: { ref: `main${rtl}gnp.exe`, retries: 5, ratio: 0.5, dry_run: false, note: `line1\nline2${zw}`, script: longCommand },
    steps: [['git', '-C', '/srv/site', 'fetch', '--prune', 'origin'], { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }],
    summary: 'Run runbook site.pull_and_restart on web-01'
  };
  phoneVector('request-display', request(web, 'display', runbookAction, { origin: { client: 'stdio-mcp', session: null, job_id: 'job-1' } }), pinnedWeb);

  // ── Responses (node side) ─────────────────────────────────────────────────
  const reqMsg = JSON.parse(fromB64url(req.payload));
  const respond = (dev, overrides = {}) => seal({
    v: 1, type: 'kl.approval.response', request_id: reqMsg.request_id, node_id: reqMsg.node_id, action_hash: reqMsg.action_hash,
    nonce: reqMsg.nonce, decision: 'approve', expires_at: reqMsg.expires_at, device_id: dev.id, signed_at: iso(NOW_MS + 20000), ...overrides
  }, dev);
  const baseGiven = { now: iso(NOW_MS + 30000), node: nodeRef, approvers: [approver(A), approver(B)], overlay: [], allow_test_keys: true, pending: [req], used: [], current_action: toolActionLit };
  const nodeVector = (name, check, input, expect, given = {}) => add({ name, consumers: ['node'], check, given: { ...baseGiven, ...given }, input, expect });
  const bytesSha = (env) => crypto.createHash('sha256').update(fromB64url(env.payload)).digest('base64url');

  nodeVector('response-approve', null, respond(A), { accepted: true, reason: null });
  nodeVector('response-deny', null, respond(A, { decision: 'deny' }), { accepted: true, reason: null });
  const good = respond(A);
  const spaced = Buffer.from(fromB64url(good.payload).toString('utf8').replace('{', '{ '));
  nodeVector('response-reject-malformed-noncanonical', 1, { alg: 'ES256', kid: A.id, payload: spaced.toString('base64url'), sig: A.sign(spaced).toString('base64url') }, { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-unsupported-version', 1, respond(A, { v: 2 }), { accepted: false, reason: 'unsupported_version' });
  nodeVector('response-reject-wrong-alg', 2, { ...good, alg: 'Ed25519' }, { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-kid-mismatch', 2, seal(JSON.parse(fromB64url(good.payload)), B), { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-unknown-device', 3, respond(C), { accepted: false, reason: 'unknown_device' });
  nodeVector('response-reject-demo-device', 4, respond(C), { accepted: false, reason: 'demo_device' }, { approvers: [approver(A), approver(C, { platform: 'demo' })] });
  nodeVector('response-reject-test-key', 4, respond(A), { accepted: false, reason: 'test_key' }, { allow_test_keys: false });
  nodeVector('response-reject-revoked-device', 5, respond(A), { accepted: false, reason: 'revoked_device' }, { approvers: [approver(A, { revoked_at: '2026-09-20T00:00:00.000Z', revoked_by: 'console' })] });
  nodeVector('response-reject-revoked-via-overlay', 5, respond(A), { accepted: false, reason: 'revoked_device' }, { overlay: [A.id] });
  nodeVector('response-reject-bad-signature', 6, { ...good, sig: respond(A, { decision: 'deny' }).sig }, { accepted: false, reason: 'bad_signature' });
  nodeVector('response-reject-wrong-node', 7, respond(A, { node_id: gpu.nodeId }), { accepted: false, reason: 'wrong_node' });
  nodeVector('response-reject-replay', 8, good, { accepted: false, reason: 'replay' }, { used: [{ nonce: reqMsg.nonce, sha256: bytesSha(good) }] });
  nodeVector('response-reject-already-decided', 8, good, { accepted: false, reason: 'already_decided' }, { used: [{ nonce: reqMsg.nonce, sha256: bytesSha(respond(B, { decision: 'deny' })) }] });
  nodeVector('response-reject-unknown-request', 9, good, { accepted: false, reason: 'unknown_request' }, { pending: [] });
  nodeVector('response-reject-nonce-mismatch', 10, respond(A, { nonce: nonceOf('someone else') }), { accepted: false, reason: 'nonce_mismatch' });
  nodeVector('response-reject-action-hash-mismatch', 10, respond(A, { action_hash: crypto.createHash('sha256').update('{}').digest('base64url') }), { accepted: false, reason: 'action_hash_mismatch' });
  nodeVector('response-reject-expires-mismatch', 10, respond(A, { expires_at: iso(NOW_MS + 600000) }), { accepted: false, reason: 'expires_mismatch' });
  nodeVector('response-reject-expired', 11, good, { accepted: false, reason: 'expired' }, { now: iso(NOW_MS + 301000) });
  nodeVector('response-reject-changed-parameter', 12, good, { accepted: false, reason: 'action_changed' }, { current_action: { ...toolActionLit, params: { command: 'git push --force origin main' }, summary: 'Bash(git push --force origin main)' } });
  nodeVector('response-accept-phone-clock-ahead', null, respond(A, { signed_at: iso(NOW_MS + 10 * 60 * 1000) }), { accepted: true, reason: null });

  // ── Enrollment and revocation ─────────────────────────────────────────────
  const code = sha('console code').toString('base64url');
  const codeId = codeIdOf('console');
  const deviceOf = (dev, platform = 'android') => ({ device_id: dev.id, name: `Phone ${dev.id.slice(2, 6)}`, platform, public_key: dev.jwk });
  const consoleEnroll = (dev, macCode) => {
    const base = { v: 1, type: 'kl.device.enroll', device: deviceOf(dev), enrolled_by: null, created_at: NOW, expires_at: iso(NOW_MS + 600000), nonce: nonceOf(`enroll ${dev.id}`), code_id: codeId };
    return seal({ ...base, code_mac: enrollMac(macCode, base) }, dev);
  };
  const consoleGiven = { now: iso(NOW_MS + 60000), code_id: codeId, code, allow_test_keys: true };
  add({ name: 'enroll-console', consumers: ['node', 'ios', 'android'], given: consoleGiven, input: consoleEnroll(C, code), expect: { accepted: true, reason: null, device_id: C.id } });
  add({ name: 'enroll-console-bad-mac', consumers: ['node'], given: consoleGiven, input: consoleEnroll(C, sha('wrong code').toString('base64url')), expect: { accepted: false, reason: 'bad_mac', device_id: null } });

  const signedEnroll = (by, dev) => seal({ v: 1, type: 'kl.device.enroll', device: deviceOf(dev, 'ios'), enrolled_by: by.id, created_at: NOW, expires_at: iso(NOW_MS + 600000), nonce: nonceOf(`signed ${by.id} ${dev.id}`) }, by);
  const revoke = (by, target) => seal({ v: 1, type: 'kl.device.revoke', device_id: target.id, revoked_by: by.id, reason: 'lost phone', created_at: NOW, expires_at: iso(NOW_MS + 3600000), nonce: nonceOf(`revoke ${by.id} ${target.id}`) }, by);
  const stageGiven = { now: iso(NOW_MS + 60000), approvers: [approver(A), approver(B)], overlay: [], allow_test_keys: true };
  const stageVector = (name, inputs, results, active, given = {}) => add({ name, consumers: ['node'], given: { ...stageGiven, ...given }, input: inputs, expect: { results, active } });
  stageVector('enroll-signed', [signedEnroll(A, C)], [{ state: 'staged' }], [A.id, B.id]);
  stageVector('enroll-signed-by-overlay-revoked', [signedEnroll(A, C)], [{ state: 'rejected', reason: 'signer_not_active' }], [B.id], { overlay: [A.id] });
  stageVector('revoke-valid', [revoke(A, B)], [{ state: 'revoked-pending-apply' }], [A.id]);
  stageVector('revoke-self-rejected', [revoke(A, A)], [{ state: 'rejected', reason: 'self_revoke' }], [A.id, B.id]);
  stageVector('revoke-mutual', [revoke(B, A), revoke(A, B)], [{ state: 'revoked-pending-apply' }, { state: 'revoked-pending-apply' }], []);

  // ── History slice ─────────────────────────────────────────────────────────
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vector-audit-'));
  try {
    const ledger = new AuditLedger({ dir: auditDir, identity: web, nodeId: web.nodeId, now: () => NOW_MS });
    const lines = [
      { kind: 'approval.request', data: { job_id: null, envelope: req } },
      { kind: 'approval.response', data: { request_id: reqMsg.request_id, device_id: A.id, decision: 'approve', envelope: good, job_id: null } },
      { kind: 'approval.outcome', data: { request_id: reqMsg.request_id, state: 'approved', reason: null, job_id: null } }
    ];
    // Written directly (append() is async for its lock) with the same hashing.
    const entries = [];
    let prev = null;
    for (const [i, line] of lines.entries()) {
      const entry = { v: 1, seq: i + 1, at: NOW, node_id: web.nodeId, writer: 'service', kind: line.kind, data: line.data, prev };
      entry.hash = entryHash(entry);
      entries.push(entry);
      prev = entry.hash;
    }
    fs.writeFileSync(path.join(auditDir, 'ledger-2026-09.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
    add({ name: 'audit-slice', consumers: ['node', 'ios', 'android'], given: { node: { id: web.nodeId, key: web.key } }, input: ledger.slice({ limit: 200 }), expect: { accepted: true, reason: null, entries: 3 } });
  } finally {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }

  // ── Phone API authentication ──────────────────────────────────────────────
  const apiPath = `/v1/approvals/${reqMsg.request_id}/response`;
  const body = JSON.stringify(good);
  const timestamp = iso(NOW_MS + 21000);
  const signing = phoneAuthString('POST', apiPath, timestamp, body);
  add({
    name: 'phone-api-auth',
    consumers: ['node', 'ios', 'android'],
    given: { device: { device_id: A.id, jwk: A.jwk }, method: 'POST', path: apiPath, timestamp, body },
    input: { signing_string: signing, signature: A.signText(signing) },
    expect: { signing_string: signing, body_sha256: crypto.createHash('sha256').update(body).digest('base64url'), accepted: true }
  });

  return vectors;
}

function serialize(v) {
  return `${JSON.stringify(v, null, 2)}\n`;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== text) {
        differ += 1;
        process.stderr.write(`differs: ${v.name}.json\n`);
      }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, loadSigCache, NOW };
```

Generate the vector files, then check that a second run changes nothing (P-256 signatures are randomized; the generator reuses a committed signature for the same signer and payload):

Run: `node tests/vectors/approval-v1/generate.js`
Expected: `38 vectors written`

Run: `node tests/vectors/approval-v1/generate.js --check`
Expected: `38 vectors match`

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-protocol.test.js`
Expected: PASS, `fail 0` (40 tests), including `response-accept-phone-clock-ahead (check null)` (Review Focus 1) and "a device revoked while its approval is in flight is refused".

- [ ] **Step 5: Commit**

```bash
git add docs/protocol/approval-v1.md tests/vectors/approval-v1 tests/approvals-protocol.test.js
git commit -m "docs(protocol): approval-v1 with node and phone test vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: ToolExecutor remote tiers, `localOrigin` and `mapApprovalResult`

**Files:**
- Create: `src/core/origin.js` (only if it does not exist — see below)
- Modify: `src/execution/tool-executor.js` — requires (`:6`), before `class ToolExecutor` (`:31`), end of the constructor (`:94-96`), the hook `confirm` block (`:181-196`), after the deny-rule block (`:259`), `ruleSaysAllow`/`needsApprovalGate` (`:270-272`), the auto-approve lines (`:289-295`), the gate block (`:321-341`), the re-threaded requester (`:402-403`), before `async requestApproval` (`:439`), `module.exports` (`:465`)
- Test: `tests/tool-executor-remote-tier.test.js`

**Interfaces:**
- Consumes: `markLocalRequester` (`src/core/origin.js`, program §4.21); `classifyToolCall(t, p, policy, { cwd })` (Part 1, Task 2) in the test.
- Produces (program P23): ToolExecutor options `classifyCall(toolName, params, { cwd }) → { tier, reason } | null` and `localOrigin` (boolean); event `tierDecision { toolName, parameters, tier, reason }`; refusal `{ success: false, error: 'Denied by node policy.', deniedBy: 'policy' }`; requester metadata `signal` and `workingDirectory` at both call sites; `mapApprovalResult(result, metadata, { timeoutMs }) → { approved, penalize, refusal: { error, deniedBy } | null }` exported as `require('../execution/tool-executor').mapApprovalResult`.

**`src/core/origin.js`.** F7 owns this module (program §4.21). Run `ls src/core/origin.js`. If it exists, open it and confirm it exports `markLocalDesktopEvent`, `isLocalDesktopEvent`, `localDesktopDeviceId`, `markLocalRequester`, `isLocalRequester`; do not change it. If it does not exist, create it with exactly the content in Step 3 — F7 replaces it when it merges.

- [ ] **Step 1: Write the failing test**

Create `tests/tool-executor-remote-tier.test.js`:

```js
// tests/tool-executor-remote-tier.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const ToolExecutor = require('../src/execution/tool-executor');
const { mapApprovalResult } = require('../src/execution/tool-executor');
const { classifyToolCall } = require('../src/execution/safety-policy');
const { isLocalRequester } = require('../src/core/origin');

const runs = { routine: 0, bash: 0, file: 0 };
let captured = null;
let realBash = null;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-tier-'));
const root = path.join(base, 'root');
fs.mkdirSync(root);

before(() => {
  realBash = toolRegistry.get('Bash');
  toolRegistry.register(new Tool({
    name: 'KlTierRoutine', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    execute: async () => { runs.routine += 1; return { ok: true }; }
  }));
  toolRegistry.register(new Tool({
    name: 'KlTierFile', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, edits: { type: 'array' } } },
    execute: async () => { runs.file += 1; return { ok: true }; }
  }));
  toolRegistry.register(new Tool({
    name: 'KlTierCapture', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: {} },
    execute: async (_p, options) => { captured = options.approvalRequester; return { ok: true }; }
  }));
  // A stand-in for the shell so no real command runs; it gates like Bash.
  toolRegistry.register(new Tool({
    name: 'Bash', description: 'test stand-in', requiresApproval: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async () => { runs.bash += 1; return { ok: true }; }
  }));
});

after(() => {
  if (realBash) toolRegistry.register(realBash);
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = { allowed_roots: [root], remote_sessions: { always_confirm: ['Bash(git push*)'], deny: ['Bash(rm -rf /*)'] } };
const classifyCall = (t, p, { cwd }) => classifyToolCall(t, p, policy, { cwd });

function executor(extra = {}) {
  return new ToolExecutor({ workingDirectory: root, runtimeEnvironment: {}, useSandbox: false, ...extra });
}

describe('ToolExecutor classifyCall', () => {
  it('denied: refuses with deniedBy policy and emits tierDecision', async () => {
    const decisions = [];
    const ex = executor({ classifyCall, approvalRequester: async () => true });
    ex.on('tierDecision', (d) => decisions.push(d));
    const before = runs.bash;
    const result = await ex.execute('Bash', { command: 'rm -rf /srv' });
    assert.deepEqual(result, { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
    assert.equal(runs.bash, before);
    assert.deepEqual(decisions.map((d) => [d.toolName, d.tier, d.reason]), [['Bash', 'denied', 'matched_deny_policy']]);
  });

  it('unsafe forces the gate for a tool that would not ask', async () => {
    const asked = [];
    const ex = executor({ classifyCall: () => ({ tier: 'unsafe', reason: 'test' }), approvalRequester: async (t) => { asked.push(t); return false; } });
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' });
    assert.equal(result.deniedBy, 'user');
    assert.deepEqual(asked, ['KlTierRoutine']);
    assert.equal(runs.routine, before);
  });

  it('unsafe beats allow Bash(git *) for always_confirm Bash(git push*)', async () => {
    const rules = [{ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'test' }];
    const asked = [];
    const requester = async (t, p) => { asked.push(p.command); return false; };
    const without = executor({ permissionRules: rules, approvalRequester: requester });
    const before = runs.bash;
    await without.execute('Bash', { command: 'git push origin main' });
    assert.equal(runs.bash, before + 1, 'baseline: the allow rule skips the gate');
    assert.deepEqual(asked, []);
    const withTier = executor({ permissionRules: rules, approvalRequester: requester, classifyCall });
    const result = await withTier.execute('Bash', { command: 'cd repo && git push origin main' });
    assert.equal(result.success, false);
    assert.deepEqual(asked, ['cd repo && git push origin main']);
    assert.equal(runs.bash, before + 1);
  });

  it('relative file_path and edits[].file_path outside the roots are unsafe, resolved against the working directory', async () => {
    const asked = [];
    const ex = executor({ classifyCall, approvalRequester: async (t, p) => { asked.push(p); return false; } });
    const before = runs.file;
    await ex.execute('KlTierFile', { file_path: 'inside.txt' });
    assert.equal(runs.file, before + 1);
    await ex.execute('KlTierFile', { file_path: '../outside.txt' });
    await ex.execute('KlTierFile', { edits: [{ file_path: 'ok.txt' }, { file_path: path.join(base, 'x.txt') }] });
    assert.equal(asked.length, 2);
    assert.equal(runs.file, before + 1);
  });
});

describe('ToolExecutor approval results', () => {
  const confirmHook = { run: async (event) => (event === 'PreToolUse' ? { action: 'confirm', message: 'check this' } : {}) };

  it("hook confirm: 'timeout' and 'unavailable' run nothing", async () => {
    for (const answer of ['timeout', 'unavailable']) {
      const ex = executor({ hookExecutor: confirmHook, approvalRequester: async () => answer });
      const before = runs.routine;
      const result = await ex.execute('KlTierRoutine', { x: 'y' });
      assert.equal(result.success, false, answer);
      assert.equal(result.blockedByHook, true);
      assert.equal(result.deniedBy, answer);
      assert.equal(runs.routine, before, answer);
    }
  });

  it('gate: a truthy value that is not true runs nothing', async () => {
    for (const answer of ['yes', 'timeout-ish', 1, { approved: true }]) {
      const ex = executor({ approvalRequester: async () => answer });
      const before = runs.bash;
      const result = await ex.execute('Bash', { command: 'ls' });
      assert.deepEqual(result, { success: false, error: 'Approval failed: unexpected requester result.', deniedBy: 'requester' });
      assert.equal(runs.bash, before);
    }
  });

  it('withdrawn: no denial penalty; a plain false is recorded', async () => {
    const denials = [];
    const tracker = { check: () => ({ tripped: false }), recordDenial: (t) => denials.push(t), recordGrant: () => {} };
    const controller = new AbortController();
    const ex = executor({ denialTracker: tracker, approvalRequester: async () => { controller.abort(); return false; } });
    const result = await ex.execute('Bash', { command: 'ls' }, { signal: controller.signal });
    assert.deepEqual(result, { success: false, error: 'Approval withdrawn: the call was cancelled.', deniedBy: 'withdrawn' });
    assert.deepEqual(denials, []);
    const plain = executor({ denialTracker: tracker, approvalRequester: async () => false });
    assert.equal((await plain.execute('Bash', { command: 'ls' })).deniedBy, 'user');
    assert.deepEqual(denials, ['Bash']);
  });

  it("'unavailable' reports the requester's refusal, else the default", async () => {
    const ex = executor({ approvalRequester: async (t, p, m) => { m.refusal = { deniedBy: 'audit', error: 'Audit ledger unavailable; nothing ran.' }; return 'unavailable'; } });
    assert.deepEqual(await ex.execute('Bash', { command: 'ls' }), { success: false, error: 'Audit ledger unavailable; nothing ran.', deniedBy: 'audit' });
    const bare = executor({ approvalRequester: async () => 'unavailable' });
    assert.deepEqual(await bare.execute('Bash', { command: 'ls' }), {
      success: false, error: 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.', deniedBy: 'unavailable'
    });
  });

  it('metadata carries workingDirectory and signal at both call sites', async () => {
    const seen = [];
    const controller = new AbortController();
    const requester = async (t, p, m) => { seen.push({ wd: m.workingDirectory, signal: m.signal }); return true; };
    await executor({ approvalRequester: requester }).execute('Bash', { command: 'ls' }, { workingDirectory: base, signal: controller.signal });
    await executor({ approvalRequester: requester, hookExecutor: confirmHook }).execute('KlTierRoutine', { x: 'y' });
    assert.equal(seen[0].wd, base);
    assert.equal(seen[0].signal, controller.signal);
    assert.equal(seen[1].wd, root);
    assert.equal(seen[1].signal, null);
  });
});

describe('ToolExecutor localOrigin', () => {
  it('marks the requester handed to tools only for a local run', async () => {
    await executor({ localOrigin: true }).execute('KlTierCapture', {});
    assert.equal(isLocalRequester(captured), true);
    await executor({}).execute('KlTierCapture', {});
    assert.equal(isLocalRequester(captured), false);
  });
});

describe('mapApprovalResult', () => {
  it('maps only true to approved', () => {
    assert.deepEqual(mapApprovalResult(true, {}), { approved: true, penalize: false, refusal: null });
    assert.equal(mapApprovalResult(false, {}).penalize, true);
    assert.equal(mapApprovalResult('timeout', {}, { timeoutMs: 315000 }).refusal.error.startsWith('Approval timed out after 315s'), true);
    assert.equal(mapApprovalResult('unavailable', {}).refusal.deniedBy, 'unavailable');
    assert.equal(mapApprovalResult('true', {}).refusal.deniedBy, 'requester');
    assert.equal(mapApprovalResult(undefined, {}).approved, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tool-executor-remote-tier.test.js`
Expected: FAIL — `Cannot find module '../src/core/origin'` (or, if F7 has merged, failures such as `mapApprovalResult is not a function` and the `denied` test returning `success: true`).

- [ ] **Step 3: Implement**

If `src/core/origin.js` does not exist, create it:

```js
// Desktop origin marks (program §4.21). F7 owns this module; F3 creates it
// with exactly this API when F7 has not merged yet, and F7 replaces it.
//
// An IPC event from the local desktop window is marked, and so is the
// approval requester a ToolExecutor built for such a run hands to its tools,
// so child agents (built with event = null) inherit "local" through the
// requester. WeakSets: a mark cannot be forged by copying fields, and nothing
// is kept alive by being marked.
const localEvents = new WeakSet();
const localRequesters = new WeakSet();
const desktopDeviceIds = new WeakMap();

function markLocalDesktopEvent(event, { deviceId = null } = {}) {
  if (event && typeof event === 'object') {
    localEvents.add(event);
    if (deviceId) desktopDeviceIds.set(event, deviceId);
  }
  return event;
}

function isLocalDesktopEvent(event) {
  return Boolean(event) && typeof event === 'object' && localEvents.has(event);
}

function localDesktopDeviceId(event) {
  return (event && typeof event === 'object' && desktopDeviceIds.get(event)) || null;
}

function markLocalRequester(fn) {
  if (typeof fn === 'function') localRequesters.add(fn);
  return fn;
}

function isLocalRequester(fn) {
  return typeof fn === 'function' && localRequesters.has(fn);
}

module.exports = {
  markLocalDesktopEvent,
  isLocalDesktopEvent,
  localDesktopDeviceId,
  markLocalRequester,
  isLocalRequester
};
```

In `src/execution/tool-executor.js`, add after the line `const { isProtectedCasePath, CASE_BLOCKED_TOOL_NAMES, CASE_BLOCKED_TOOL_ERROR } = require('../cases/chat-integration');`:

```js
const { markLocalRequester } = require('../core/origin');
```

Insert immediately before `class ToolExecutor extends EventEmitter {`:

```js
const DEFAULT_UNAVAILABLE_REFUSAL = 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.';

// The one place a requester's answer becomes "run" or a refusal. Requesters
// return true | false | 'timeout' | 'unavailable' (program §3) and only
// `true` runs; a truthy string never does. `penalize` says whether the
// denial tracker should count it (only a person's plain "no").
function mapApprovalResult(result, metadata = {}, { timeoutMs = 0 } = {}) {
  if (result === true) return { approved: true, penalize: false, refusal: null };
  if (result === false) {
    if (metadata.signal && metadata.signal.aborted) {
      return { approved: false, penalize: false, refusal: { error: 'Approval withdrawn: the call was cancelled.', deniedBy: 'withdrawn' } };
    }
    return { approved: false, penalize: true, refusal: { error: 'User denied permission', deniedBy: 'user' } };
  }
  if (result === 'timeout') {
    // Inattention, not denial: a distinct error so the agent can recover or
    // explain instead of treating it as a hard "no".
    return {
      approved: false,
      penalize: false,
      refusal: {
        error: `Approval timed out after ${Math.round(timeoutMs / 1000)}s — no user response. Try again when someone is watching, or ask the user to pre-approve this tool.`,
        deniedBy: 'timeout'
      }
    };
  }
  if (result === 'unavailable') {
    const r = metadata.refusal;
    return {
      approved: false,
      penalize: false,
      refusal: r && typeof r.error === 'string'
        ? { error: r.error, deniedBy: r.deniedBy || 'unavailable' }
        : { error: DEFAULT_UNAVAILABLE_REFUSAL, deniedBy: 'unavailable' }
    };
  }
  return { approved: false, penalize: false, refusal: { error: 'Approval failed: unexpected requester result.', deniedBy: 'requester' } };
}

```

At the end of the constructor, replace

```js
    this.approvalTimeoutMs =
      typeof options.approvalTimeoutMs === 'number' ? options.approvalTimeoutMs : 5 * 60 * 1000;
  }
```

with

```js
    this.approvalTimeoutMs =
      typeof options.approvalTimeoutMs === 'number' ? options.approvalTimeoutMs : 5 * 60 * 1000;

    // Node policy tiers (fleet parent §5.3), wired by the phone approval mode:
    // (toolName, params, { cwd }) → { tier, reason } | null. `denied` refuses,
    // `unsafe` forces the approval gate even past an `allow` rule.
    this.classifyCall = typeof options.classifyCall === 'function' ? options.classifyCall : null;
    // A run that started at the local desktop: the approval requester handed
    // to tools (and so to child agents) is marked local, so children keep the
    // on-screen dialog instead of going to the phone (program §4.21).
    this.localOrigin = options.localOrigin === true;
  }
```

Replace the hook `confirm` block

```js
      if (action === 'confirm') {
        const approved = await this.requestApproval(toolName, effectiveParameters, {
          reason: preHookResult?.message || 'Hook policy requires explicit confirmation.'
        });

        if (!approved) {
          const denied = {
            success: false,
            error: 'User denied permission',
            blockedByHook: true,
            hookResults: preHookResult?.results || []
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
      }
```

with

```js
      if (action === 'confirm') {
        const hookMetadata = {
          reason: preHookResult?.message || 'Hook policy requires explicit confirmation.',
          signal: options.signal || null,
          workingDirectory: options.workingDirectory || this.workingDirectory
        };
        const approved = await this.requestApproval(toolName, effectiveParameters, hookMetadata);
        const mapped = mapApprovalResult(approved, hookMetadata, { timeoutMs: this.approvalTimeoutMs });

        if (!mapped.approved) {
          const denied = {
            success: false,
            error: mapped.refusal.error,
            deniedBy: mapped.refusal.deniedBy,
            blockedByHook: true,
            hookResults: preHookResult?.results || []
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
      }
```

Immediately before the line `const ruleSaysAsk = ruleMatch.matched && ruleMatch.action === 'ask';`, insert:

```js
    // Node policy tier, after the permission rules and before the gate.
    let tierUnsafe = false;
    if (this.classifyCall) {
      const decision = this.classifyCall(toolName, effectiveParameters, {
        cwd: options.workingDirectory || this.workingDirectory
      }) || null;
      if (decision) {
        this.emit('tierDecision', {
          toolName,
          parameters: effectiveParameters,
          tier: decision.tier,
          reason: decision.reason || null
        });
        if (decision.tier === 'denied') {
          const denied = { success: false, error: 'Denied by node policy.', deniedBy: 'policy' };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
        tierUnsafe = decision.tier === 'unsafe';
      }
    }

```

Replace

```js
    const ruleSaysAllow = ruleMatch.matched && ruleMatch.action === 'allow' && !allowRuleDemoted;
    const needsApprovalGate = ruleSaysAsk || allowRuleDemoted
      || (!ruleMatch.matched && toolWouldGate);
```

with

```js
    // An `unsafe` tier cancels an `allow` rule: `allow Bash(git *)` must not
    // skip the gate for `always_confirm Bash(git push*)`.
    const ruleSaysAllow = ruleMatch.matched && ruleMatch.action === 'allow' && !allowRuleDemoted && !tierUnsafe;
    const needsApprovalGate = tierUnsafe || ruleSaysAsk || allowRuleDemoted
      || (!ruleMatch.matched && toolWouldGate);
```

Replace

```js
      const autoApproved = this.denyAutoApproval || ruleSaysAsk
        ? false
        : await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = !this.denyAutoApproval
        && !ruleSaysAsk
        && Array.isArray(options.autoApproveTools)
```

with

```js
      const autoApproved = this.denyAutoApproval || ruleSaysAsk || tierUnsafe
        ? false
        : await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = !this.denyAutoApproval
        && !ruleSaysAsk
        && !tierUnsafe
        && Array.isArray(options.autoApproveTools)
```

Replace the gate block, from `const approved = await this.requestApproval(toolName, effectiveParameters, {` down to and including the `if (!approved) { … return denied; }` that records the denial:

```js
        const approved = await this.requestApproval(toolName, effectiveParameters, {
          ruleHint: ruleSaysAsk || allowRuleDemoted ? describeRule(ruleMatch.rule) : null
        });
        if (approved === 'timeout') {
          // Inattention, not denial — don't penalize via denialTracker, and
          // surface a distinct error so the agent can recover or explain
          // instead of treating it as a hard "no".
          const timedOut = {
            success: false,
            error: `Approval timed out after ${Math.round(this.approvalTimeoutMs / 1000)}s — no user response. Try again when someone is watching, or ask the user to pre-approve this tool.`,
            deniedBy: 'timeout'
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: timedOut });
          return timedOut;
        }
        if (!approved) {
          if (this.denialTracker) this.denialTracker.recordDenial(toolName, effectiveParameters);
          const denied = { success: false, error: 'User denied permission', deniedBy: 'user' };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
```

with

```js
        const gateMetadata = {
          ruleHint: ruleSaysAsk || allowRuleDemoted ? describeRule(ruleMatch.rule) : null,
          signal: options.signal || null,
          workingDirectory: options.workingDirectory || this.workingDirectory
        };
        const approved = await this.requestApproval(toolName, effectiveParameters, gateMetadata);
        // Only `true` runs. A timeout, a withdrawal, an unavailable phone or
        // anything unexpected is not a user's "no", so only a plain `false`
        // counts against the denial tracker.
        const mapped = mapApprovalResult(approved, gateMetadata, { timeoutMs: this.approvalTimeoutMs });
        if (!mapped.approved) {
          if (mapped.penalize && this.denialTracker) this.denialTracker.recordDenial(toolName, effectiveParameters);
          const denied = { success: false, error: mapped.refusal.error, deniedBy: mapped.refusal.deniedBy };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
```

(The following `if (this.denialTracker) this.denialTracker.recordGrant(…)` and `approvalSource = { type: 'user' };` lines stay.)

In the `tool.execute(…)` options, replace

```js
        approvalRequester: (toolName, parameters, metadata) =>
          this.requestApproval(toolName, parameters, metadata)
      });
```

with

```js
        approvalRequester: this._rethreadedRequester()
      });
```

Insert immediately before `async requestApproval(toolName, parameters, metadata = {}) {`:

```js
  // The approval channel handed to tools (BackgroundTask, SpawnAgent,
  // workflow runners) so their children ask the same place this executor
  // asks. For a local-desktop run it is marked local (program §4.21).
  _rethreadedRequester() {
    const requester = (toolName, parameters, metadata) => this.requestApproval(toolName, parameters, metadata);
    return this.localOrigin ? markLocalRequester(requester) : requester;
  }

```

Replace the last line `module.exports = ToolExecutor;` with:

```js
module.exports = ToolExecutor;
module.exports.mapApprovalResult = mapApprovalResult;
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/tool-executor-remote-tier.test.js tests/tool-executor.test.js tests/hook-modify-gate.test.js tests/approval-rule-precedence.test.js tests/denial-tracker.test.js tests/checkpoint-integration.test.js`
Expected: PASS, `fail 0` (the new file has 11 tests; the existing files are unchanged in behaviour for `true`/`false`/`'timeout'`).

- [ ] **Step 5: Commit**

```bash
git add src/execution/tool-executor.js tests/tool-executor-remote-tier.test.js
git add src/core/origin.js   # only if this task created it
git commit -m "feat(execution): node-policy tiers in ToolExecutor; only === true approves

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `remoteApprovals: 'phone'` and the desktop seam in `createCore`

**Files:**
- Create: `src/approvals/executor-options.js`
- Modify: `src/core/create-core.js` — the `ToolExecutor` require (`:9`), the `remoteApprovals` validation (`:145-148`), `createToolExecutorWithApprovals` (`:1906-1924` and the `if (event?.sender) {` line after the constructor), the `context` object (after `getCaseRuntime: () => caseRuntime,`, `:2641`)
- Modify: `tests/core-remote-approvals.test.js` — `buildCore` (`:61-75`), and a new block appended at the end
- Test: `tests/core-remote-approvals.test.js`

**Interfaces:**
- Consumes: `isLocalDesktopEvent`, `isLocalRequester`, `localDesktopDeviceId` (`src/core/origin.js`, Task 11); ToolExecutor `classifyCall`/`localOrigin`/`tierDecision` (Task 11); `classifyToolCall` (Part 1, Task 2); `canonicalize`, `sha256b64url` (Part 1); a PhoneApprover (`isAvailable()`, `ttlMs`, `requestApproval(t, p, m)`) and an audit ledger (`append`).
- Produces (program P5, P22, §4.21): `createCore` deps `remoteApprovals: 'allow' | 'deny' | 'phone'`, `phoneApprover` (required in phone mode: `createCore: remoteApprovals 'phone' needs deps.phoneApprover`), `auditLedger`, `nodePolicy`; `core.context.getPhoneApprover() → PhoneApprover | null` (null outside phone mode and while `!isAvailable()`). `approvalSeam({ remoteApprovals, event, approvalRequester, executorOptions, phoneApprover, auditLedger, nodePolicy, helpers }) → { toolExecutorOptions, attach(executor), local, origin }`, `phoneExecutorOptions({ phoneApprover, auditLedger, nodePolicy, origin, local, approvalRequester }) → { options, attach }`, `paramsSha256(params)`, `PHONE_GRACE_MS` (15000).

The seam (program §4.21, spec §3.7): `local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester)`; `'allow'` keeps the caller's requester; a local run keeps only a marked requester (else `null`, so the on-screen dialog answers); a remote run in `'phone'` mode always asks the phone, and in `'deny'` mode gets `null`. `denyAutoApproval = (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true`. In phone mode `classifyCall` applies to local runs too, and the audit listeners write `tier.decision`, `exec.start`, `exec.result` with the run's `origin` (`{ client: 'desktop', deviceId, session, job_id: null }` for a local run).

- [ ] **Step 1: Write the failing test**

In `tests/core-remote-approvals.test.js`, change the `buildCore` helper so tests can pass extra deps. Replace

```js
function buildCore(remoteApprovals) {
```

with

```js
function buildCore(remoteApprovals, extraDeps = {}) {
```

and replace

```js
  if (remoteApprovals !== undefined) deps.remoteApprovals = remoteApprovals;
  return createCore(deps);
```

with

```js
  if (remoteApprovals !== undefined) deps.remoteApprovals = remoteApprovals;
  Object.assign(deps, extraDeps);
  return createCore(deps);
```

Append to the end of the file:

```js

// ── Fleet stage 3: remoteApprovals 'phone' and the desktop seam (R49) ───────
const { markLocalDesktopEvent } = require('../src/core/origin');

const DENIED_TOOL = 'KlTestNodePolicyDenied';
const CAPTURE_TOOL = 'KlTestCaptureRequester';
let capturedRequester = null;

function phoneDeps({ available = true, answer = true } = {}) {
  const calls = [];
  const audit = [];
  const phoneApprover = {
    ttlMs: 300000,
    isAvailable: () => available,
    requestApproval: async (toolName, parameters, metadata) => { calls.push({ toolName, origin: metadata.origin }); return answer; }
  };
  const auditLedger = { append: async (entry) => { audit.push(entry); return entry; } };
  const nodePolicy = { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [], deny: [`${DENIED_TOOL}*`] } };
  return { calls, audit, deps: { phoneApprover, auditLedger, nodePolicy } };
}

function desktopEvent() {
  const sent = [];
  const event = markLocalDesktopEvent({ sender: { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false } }, { deviceId: 'kld-testdesktop00001' });
  return { event, sent };
}

async function answerDialog(core, sent, approved) {
  for (let i = 0; i < 200 && !sent.some((s) => s.channel === 'tool:approvalRequired'); i += 1) await new Promise((r) => setTimeout(r, 5));
  const request = sent.find((s) => s.channel === 'tool:approvalRequired');
  assert.ok(request, 'the on-screen dialog was asked');
  core.context.pendingApprovalResolvers.get(request.payload.approvalId).resolve(approved);
}

async function startedPhoneCore(options) {
  const phone = phoneDeps(options);
  const core = buildCore('phone', phone.deps);
  await core.start();
  for (const [name, execute] of [
    [PROBE_TOOL, async () => { probeRuns += 1; return { ok: true }; }],
    [DENIED_TOOL, async () => ({ ok: true })],
    [CAPTURE_TOOL, async (_p, opts) => { capturedRequester = opts.approvalRequester; return { ok: true }; }]
  ]) {
    toolRegistry.register(new Tool({
      name, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: name === PROBE_TOOL, execute
    }));
  }
  return { core, ...phone };
}

describe("createCore remoteApprovals: 'phone'", () => {
  it("needs deps.phoneApprover", () => {
    assert.throws(() => buildCore('phone'), /remoteApprovals 'phone' needs deps.phoneApprover/);
  });

  it('getPhoneApprover is the approver only in phone mode and only while it is available', () => {
    const on = phoneDeps();
    assert.equal(buildCore('phone', on.deps).context.getPhoneApprover(), on.deps.phoneApprover);
    assert.equal(buildCore('phone', phoneDeps({ available: false }).deps).context.getPhoneApprover(), null);
    assert.equal(buildCore('allow', phoneDeps().deps).context.getPhoneApprover(), null);
    assert.equal(buildCore('deny', phoneDeps().deps).context.getPhoneApprover(), null);
  });

  it('a remote run asks the phone, never the remote approvalHandler', async () => {
    const phone = phoneDeps({ answer: true });
    const before = probeRuns;
    const { res, handlerCalls } = await driveGatewayMessage(buildCore('phone', phone.deps));
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.deepEqual(handlerCalls, []);
    assert.deepEqual(phone.calls.map((c) => c.toolName), [PROBE_TOOL]);
    assert.equal(probeRuns, before + 1);
  });

  it("'unavailable' from the phone runs nothing", async () => {
    const phone = phoneDeps({ answer: 'unavailable' });
    const before = probeRuns;
    await driveGatewayMessage(buildCore('phone', phone.deps));
    assert.equal(phone.calls.length, 1);
    assert.equal(probeRuns, before);
  });

  it('denyAutoApproval for every mode, local and remote', async () => {
    const { core } = await startedPhoneCore();
    try {
      const remote = await core.context.createToolExecutorWithApprovals(null, null, null, {});
      const local = await core.context.createToolExecutorWithApprovals(desktopEvent().event, null, null, {});
      assert.equal(remote.denyAutoApproval, true);
      assert.equal(local.denyAutoApproval, false);
      assert.equal(remote.approvalTimeoutMs, 315000);
      assert.equal(typeof remote.classifyCall, 'function');
      assert.equal(typeof local.classifyCall, 'function');
    } finally {
      await core.shutdown();
    }
    for (const [mode, expected] of [['allow', false], ['deny', true]]) {
      const other = buildCore(mode);
      await other.start();
      try {
        assert.equal((await other.context.createToolExecutorWithApprovals(null, null, null, {})).denyAutoApproval, expected, mode);
      } finally {
        await other.shutdown();
      }
    }
  });

  it('R49: a marked desktop event never reaches the phone, is answered on screen, still honours denied, and audits origin desktop', async () => {
    const { core, calls, audit } = await startedPhoneCore();
    try {
      const { event, sent } = desktopEvent();
      const executor = await core.context.createToolExecutorWithApprovals(event, null, null, { chatId: 'chat-1' });
      const before = probeRuns;
      const running = executor.execute(PROBE_TOOL, {});
      await answerDialog(core, sent, true);
      assert.equal((await running).ok, true);
      assert.equal(probeRuns, before + 1);
      assert.deepEqual(calls, [], 'the phone is never asked for a desktop run');
      assert.deepEqual(await executor.execute(DENIED_TOOL, {}), { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
      await new Promise((r) => setImmediate(r));
      const start = audit.find((e) => e.kind === 'exec.start');
      assert.deepEqual(start.data.origin, { client: 'desktop', deviceId: 'kld-testdesktop00001', session: 'chat-1', job_id: null });
      assert.ok(audit.some((e) => e.kind === 'tier.decision' && e.data.tier === 'denied'));
    } finally {
      await core.shutdown();
    }
  });

  it("R49: a child of a desktop run inherits the mark and is answered by the parent's dialog", async () => {
    const { core, calls } = await startedPhoneCore();
    try {
      const { event, sent } = desktopEvent();
      const parent = await core.context.createToolExecutorWithApprovals(event, null, null, {});
      await parent.execute(CAPTURE_TOOL, {});
      const child = await core.context.createToolExecutorWithApprovals(null, null, capturedRequester, {});
      const before = probeRuns;
      const running = child.execute(PROBE_TOOL, {});
      await answerDialog(core, sent, true);
      assert.equal((await running).ok, true);
      assert.equal(probeRuns, before + 1);
      assert.deepEqual(calls, []);
    } finally {
      await core.shutdown();
    }
  });

  it('an unmarked child in phone mode gets the phone, not the requester it was handed', async () => {
    const { core, calls } = await startedPhoneCore();
    try {
      let remoteAsked = 0;
      const child = await core.context.createToolExecutorWithApprovals(null, null, async () => { remoteAsked += 1; return true; }, {});
      await child.execute(PROBE_TOOL, {});
      assert.equal(remoteAsked, 0);
      assert.deepEqual(calls.map((c) => c.toolName), [PROBE_TOOL]);
      assert.equal(calls[0].origin.client, 'king-louie');
    } finally {
      await core.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core-remote-approvals.test.js`
Expected: FAIL — the phone-mode tests throw `createCore: remoteApprovals must be 'allow' or 'deny', got "phone"` (the existing five tests still pass).

- [ ] **Step 3: Implement**

Create `src/approvals/executor-options.js`:

```js
// The approval seam createCore applies to every ToolExecutor it builds
// (program §4.21, spec §3.7): which requester answers, whether pre-gate
// auto-approval is shut, and — in phone mode — node-policy tiers and audit.
//
// A run is local when its IPC event is marked (the desktop window) or when
// the requester it was handed is marked (a child of a local run). Local runs
// keep the on-screen dialog and never reach the phone; remote runs in phone
// mode only ever get the phone.
const { createLogger } = require('../logging');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const originHelpers = require('../core/origin');

const log = createLogger('approvals/executor-options');
const PHONE_GRACE_MS = 15000;

function paramsSha256(params) {
  try {
    return sha256b64url(canonicalize(params === undefined || params === null ? {} : params));
  } catch {
    return null;
  }
}

function runOrigin({ executorOptions, event, local, helpers }) {
  if (executorOptions.origin) return executorOptions.origin;
  const session = executorOptions.chatId || null;
  if (local) return { client: 'desktop', deviceId: helpers.localDesktopDeviceId(event), session, job_id: null };
  return { client: 'king-louie', session, job_id: null };
}

// Phone-mode options merged into the ToolExecutor, plus the audit listeners.
function phoneExecutorOptions({ phoneApprover, auditLedger = null, nodePolicy = null, origin, local, approvalRequester = null }) {
  const options = { localOrigin: local };
  if (local) {
    options.approvalRequester = approvalRequester;
  } else {
    // The same metadata object goes on to the phone approver, so the refusal
    // it writes there reaches ToolExecutor's mapApprovalResult.
    options.approvalRequester = (toolName, parameters, metadata = {}) => {
      if (!metadata.origin) metadata.origin = origin;
      return phoneApprover.requestApproval(toolName, parameters, metadata);
    };
    // The phone's own expiry answers first ('timeout' from the approver).
    options.approvalTimeoutMs = phoneApprover.ttlMs + PHONE_GRACE_MS;
  }
  if (nodePolicy) {
    // Required here, not at the top: only the agent profile loads the tool registry.
    const { classifyToolCall } = require('../execution/safety-policy');
    options.classifyCall = (toolName, params, { cwd } = {}) => classifyToolCall(toolName, params, nodePolicy, { cwd });
  }

  const attach = (executor) => {
    if (!auditLedger) return;
    const append = (kind, data) => {
      Promise.resolve()
        .then(() => auditLedger.append({ kind, data }))
        .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
    };
    executor.on('tierDecision', ({ toolName, parameters, tier, reason }) => {
      append('tier.decision', { tool: toolName, tier, reason, params_sha256: paramsSha256(parameters), origin });
    });
    executor.on('preExecute', ({ toolName }) => {
      append('exec.start', { kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin });
    });
    executor.on('postExecute', ({ toolName, result }) => {
      const ok = Boolean(result) && result.success !== false && result.ok !== false;
      append('exec.result', {
        kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin,
        ok, exit_status: null, error: ok ? null : String((result && result.error) || 'failed')
      });
    });
  };
  return { options, attach };
}

// → { toolExecutorOptions, attach(executor), local, origin }
function approvalSeam({ remoteApprovals, event = null, approvalRequester = null, executorOptions = {}, phoneApprover = null,
  auditLedger = null, nodePolicy = null, helpers = originHelpers }) {
  const local = helpers.isLocalDesktopEvent(event) || helpers.isLocalRequester(approvalRequester);
  const origin = runOrigin({ executorOptions, event, local, helpers });
  const denyAutoApproval = (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true;

  if (remoteApprovals === 'phone') {
    // A marked (local) requester is kept; an unmarked one from a local event
    // is dropped so the on-screen dialog answers (requester null).
    const localRequester = helpers.isLocalRequester(approvalRequester) ? approvalRequester : null;
    const phone = phoneExecutorOptions({ phoneApprover, auditLedger, nodePolicy, origin, local, approvalRequester: localRequester });
    return { toolExecutorOptions: { ...phone.options, denyAutoApproval }, attach: phone.attach, local, origin };
  }

  let requester;
  if (remoteApprovals === 'allow') requester = approvalRequester;
  else requester = local && helpers.isLocalRequester(approvalRequester) ? approvalRequester : null;
  return {
    toolExecutorOptions: { approvalRequester: requester, denyAutoApproval, localOrigin: local },
    attach: () => {},
    local,
    origin
  };
}

module.exports = { approvalSeam, phoneExecutorOptions, paramsSha256, PHONE_GRACE_MS };
```

In `src/core/create-core.js`, add after `const ToolExecutor = require('../execution/tool-executor');`:

```js
const { approvalSeam } = require('../approvals/executor-options');
```

Replace the validation

```js
  const remoteApprovals = deps.remoteApprovals ?? 'allow';
  if (remoteApprovals !== 'allow' && remoteApprovals !== 'deny') {
    throw new Error(`createCore: remoteApprovals must be 'allow' or 'deny', got ${JSON.stringify(remoteApprovals)}`);
  }
```

with

```js
  const remoteApprovals = deps.remoteApprovals ?? 'allow';
  if (!['allow', 'deny', 'phone'].includes(remoteApprovals)) {
    throw new Error(`createCore: remoteApprovals must be 'allow', 'deny' or 'phone', got ${JSON.stringify(remoteApprovals)}`);
  }
  // 'phone' (fleet stage 3): remote-origin unsafe tools go to a signed phone
  // approval and nothing else; local-desktop runs keep the on-screen dialog.
  if (remoteApprovals === 'phone' && !deps.phoneApprover) {
    throw new Error("createCore: remoteApprovals 'phone' needs deps.phoneApprover");
  }
```

In `createToolExecutorWithApprovals`, replace

```js
    // Every approval requester — gateway/channel approvalHandler, cron,
    // webhook, mesh, and meta-tools re-threading a parent's requester — reaches
    // a ToolExecutor through here, so this is the single place that enforces
    // remoteApprovals: 'deny'.
    const effectiveApprovalRequester = remoteApprovals === 'deny' ? null : approvalRequester;
    if (approvalRequester && !effectiveApprovalRequester) {
      log.debug('remoteApprovals is "deny": ignoring a remote approval requester');
    }
```

with

```js
    // Every approval requester — gateway/channel approvalHandler, cron,
    // webhook, mesh, and meta-tools re-threading a parent's requester — reaches
    // a ToolExecutor through here, so this is the single place that enforces
    // remoteApprovals (program §4.21): 'deny' ignores remote requesters,
    // 'phone' replaces them with the phone approver, and a local-desktop run
    // (marked event or marked requester) keeps the on-screen dialog.
    const seam = approvalSeam({
      remoteApprovals,
      event,
      approvalRequester,
      executorOptions,
      phoneApprover: deps.phoneApprover || null,
      auditLedger: deps.auditLedger || null,
      nodePolicy: deps.nodePolicy || null
    });
    if (approvalRequester && seam.toolExecutorOptions.approvalRequester !== approvalRequester) {
      log.debug(`remoteApprovals is "${remoteApprovals}": not using the caller's approval requester`);
    }
```

In the `new ToolExecutor({ … })` options just below, replace

```js
      approvalRequester: effectiveApprovalRequester,
      // Nulling the requester only denies at the gate; this also closes the
      // paths that grant approval before the gate is reached (the persisted
      // "always approve" list below, an agent config's autoApproveTools, and
      // `allow` permission rules).
      denyAutoApproval: remoteApprovals === 'deny',
```

with

```js
      // approvalRequester, denyAutoApproval and localOrigin, plus in phone
      // mode approvalTimeoutMs and classifyCall. denyAutoApproval closes the
      // paths that grant approval before the gate is reached (the persisted
      // "always approve" list below, an agent config's autoApproveTools, and
      // `allow` permission rules) for every non-local run outside 'allow'.
      ...seam.toolExecutorOptions,
```

Directly after the `new ToolExecutor({ … });` statement, replace the line

```js
    if (event?.sender) {
```

(the one that attaches the `approvalRequired` listener) with

```js
    // Phone mode: tier decisions and executions go to the audit ledger.
    seam.attach(executor);

    if (event?.sender) {
```

In the `const context = {` object, after the line `    getCaseRuntime: () => caseRuntime,`, add:

```js
    // The signed-approval requester (program §4.12), or null: always null in
    // 'allow' and 'deny' modes (the Electron host), and null while no device
    // is enrolled or no relay link can deliver.
    getPhoneApprover: () => (remoteApprovals === 'phone' && deps.phoneApprover && deps.phoneApprover.isAvailable() ? deps.phoneApprover : null),
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/core-remote-approvals.test.js tests/core-create.test.js tests/tool-executor-remote-tier.test.js`
Expected: PASS, `fail 0` (13 tests in `core-remote-approvals.test.js`), including the R49 cases "a marked desktop event never reaches the phone, is answered on screen, still honours denied, and audits origin desktop", "a child of a desktop run inherits the mark and is answered by the parent's dialog" and "an unmarked child in phone mode gets the phone, not the requester it was handed".

- [ ] **Step 5: Commit**

```bash
git add src/approvals/executor-options.js src/core/create-core.js tests/core-remote-approvals.test.js
git commit -m "feat(core): remoteApprovals 'phone' with the desktop seam and getPhoneApprover

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Dial-out transports, pairing codes with a node name, and link RPC

**Files:**
- Create: `src/approvals/link-rpc.js`
- Modify: `src/mesh/mesh-transport.js` — constructor (`:28`) and `start()` (`:41-42`)
- Modify: `src/mesh/mesh-pairing.js` — constructor and `generateCode` (`:43-72`), `acceptCode`'s timeout (`:82`), `peerInfo` in `_initiatePairingHandshake` (`:157-165`), `handlePairingRequest` (`:227` and its `return peerInfo;` at `:265`)
- Test: `tests/approvals-link-rpc.test.js`

**Interfaces:**
- Consumes: `MeshTransport` (`send(peerId, payload)`, events `peerMessage { from, payload }`, `peerConnected`, `peerDisconnected { peerId }`), `MeshPairing`, `NodeIdentity`.
- Produces: `new MeshTransport({ …, listen: false })` (program §4.13: `start()` binds nothing); `new MeshPairing(identity, transport, { timeoutMs = 120000 })`, `pairing.addCode(code, meta = {}) → { pairingId, code, expiresAt }`, `pairing.generateCode(meta = {})`, `pairing.timeoutMs`; a code whose `meta.nodeName` differs from the pairing node's `nodeName` is rejected `name_mismatch`; `handlePairingRequest` returns `{ …peerInfo, nodeId, nodeName, meta }` and `acceptCode` resolves with `nodeId`, `nodeName` too. `createLinkRpc(transport, { defaultTimeoutMs = 10000 }) → { call(peerId, method, params, { timeoutMs }), notify(peerId, method, params), handle(method, fn(params, { peerId })), unhandle(method), onUnhandled(fn(method, params, { peerId })), close() }`; `class LinkRpcError` with `code` ∈ `timeout`, `offline`, `peer_disconnected`, `closed`, `unknown_method`, or a handler's own `code`.

Wire format (payload of a signed mesh envelope): call `{ rpc: 1, id, method, params }`, answer `{ rpc: 1, id, result }` or `{ rpc: 1, id, error: { code, message } }`, notification `{ rpc: 1, method, params }`.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-link-rpc.test.js`:

```js
// tests/approvals-link-rpc.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');

let relayId;
let nodeId;
before(() => {
  relayId = new NodeIdentity({ nodeName: 'relay' });
  nodeId = new NodeIdentity({ nodeName: 'web-01' });
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

// A listening "relay" transport and a dial-out-only "node" transport that
// trust each other, connected.
async function linked() {
  const relay = new MeshTransport({ identity: relayId, host: '127.0.0.1', port: 0, useTls: false });
  await relay.start();
  const node = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
  await node.start();
  cleanups.push(() => node.stop(), () => relay.stop());
  relay.addTrustedPeer(nodeId.peerId, nodeId.publicKey);
  node.addTrustedPeer(relayId.peerId, relayId.publicKey, { address: '127.0.0.1', port: relay.port });
  const relayConnected = new Promise((resolve) => relay.once('peerConnected', resolve));
  await node.connectToPeer('127.0.0.1', relay.port);
  await relayConnected;
  return { relay, node, relayRpc: createLinkRpc(relay), nodeRpc: createLinkRpc(node, { defaultTimeoutMs: 300 }) };
}

describe('MeshTransport listen: false', () => {
  it('starts without binding a port', async () => {
    const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false, port: 0 });
    await t.start();
    cleanups.push(() => t.stop());
    assert.equal(t.server, null);
    assert.equal(t.running, true);
  });
});

describe('createLinkRpc', () => {
  it('calls a handler on the other side and returns its result', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('relay.hello', async (params, { peerId }) => ({ echo: params.node_id, peerId }));
    assert.deepEqual(await nodeRpc.call(relayId.peerId, 'relay.hello', { node_id: nodeId.nodeId }), { echo: nodeId.nodeId, peerId: nodeId.peerId });
  });

  it('carries a handler error code back, and unknown methods', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('message.submit', async () => { throw Object.assign(new Error('no such type'), { code: 'type_not_routed' }); });
    await assert.rejects(nodeRpc.call(relayId.peerId, 'message.submit', {}), (err) => err.code === 'type_not_routed');
    await assert.rejects(nodeRpc.call(relayId.peerId, 'nothing.here', {}), (err) => err.code === 'unknown_method');
  });

  it('times out, and delivers notifications and unhandled methods to the fallback', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('slow', () => new Promise(() => {}));
    await assert.rejects(nodeRpc.call(relayId.peerId, 'slow', {}, { timeoutMs: 50 }), (err) => err.code === 'timeout');
    const got = [];
    relayRpc.onUnhandled((method, params) => { got.push([method, params]); return { ok: true }; });
    nodeRpc.notify(relayId.peerId, 'device.state', { device_id: 'd-x', state: 'active' });
    assert.deepEqual(await nodeRpc.call(relayId.peerId, 'lease.open', { a: 1 }), { ok: true });
    assert.deepEqual(got, [['device.state', { device_id: 'd-x', state: 'active' }], ['lease.open', { a: 1 }]]);
  });

  it('rejects a call to a peer that is not connected', async () => {
    const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
    const rpc = createLinkRpc(t);
    await assert.rejects(rpc.call('mesh-nobody', 'x', {}), (err) => err.code === 'offline');
  });
});

describe('MeshPairing additions', () => {
  it('addCode pairs a node whose name matches, returns meta, and refuses another name', async () => {
    const relay = new MeshTransport({ identity: relayId, host: '127.0.0.1', port: 0, useTls: false });
    await relay.start();
    cleanups.push(() => relay.stop());
    const relayPairing = new MeshPairing(relayId, relay, { timeoutMs: 5000 });
    let paired = null;
    relay.onPairingRequest = (ws, msg) => { paired = relayPairing.handlePairingRequest(ws, msg); };

    const node = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
    const nodePairing = new MeshPairing(nodeId, node, { timeoutMs: 5000 });
    const { code, expiresAt } = relayPairing.addCode('Abandon Ability Able About Above Absent', { nodeName: 'web-01' });
    assert.equal(code, 'abandon ability able about above absent');
    assert.ok(expiresAt > Date.now());
    const info = await nodePairing.acceptCode(code, '127.0.0.1', relay.port);
    assert.equal(info.nodeId, relayId.nodeId);
    assert.equal(paired.nodeName, 'web-01');
    assert.deepEqual(paired.meta, { nodeName: 'web-01' });

    const other = new NodeIdentity({ nodeName: 'gpu-box' });
    const otherPairing = new MeshPairing(other, new MeshTransport({ identity: other, listen: false, useTls: false }), { timeoutMs: 5000 });
    relayPairing.addCode('bacon badge balance bamboo banana banner', { nodeName: 'web-01' });
    await assert.rejects(otherPairing.acceptCode('bacon badge balance bamboo banana banner', '127.0.0.1', relay.port), /name_mismatch/);
    relayPairing.cleanup();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-link-rpc.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/link-rpc'`.

- [ ] **Step 3: Implement**

In `src/mesh/mesh-transport.js`, after the line `    this.useTls = config.useTls !== false; // TLS on by default`, add:

```js
    // listen: false — a fleet node only ever dials out (principle 4): start()
    // binds nothing, and the transport is used for connectToPeer alone.
    this.listen = config.listen !== false;
```

and replace the first two lines of `start()`

```js
  async start() {
    if (this.server) return;
```

with

```js
  async start() {
    if (this.server) return;
    if (!this.listen) {
      if (this.running) return;
      this.running = true;
      this._startHeartbeat();
      log.info('transport started without a listener (dial-out only)');
      return;
    }
```

In `src/mesh/mesh-pairing.js`, replace the constructor and `generateCode` (from `class MeshPairing {` through the end of `generateCode`) with:

```js
class MeshPairing {
  // options.timeoutMs: how long a code stays valid and how long acceptCode
  // waits (default two minutes).
  constructor(identity, transport, { timeoutMs = PAIRING_TIMEOUT_MS } = {}) {
    this.identity = identity;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.pendingPairings = new Map();
  }

  generateCode(meta = {}) {
    const bytes = crypto.randomBytes(PAIRING_CODE_WORDS);
    const words = [];
    for (let i = 0; i < PAIRING_CODE_WORDS; i++) {
      words.push(WORDLIST[bytes[i]]);
    }
    const { pairingId, code } = this.addCode(words.join(' '), meta);
    return { pairingId, code };
  }

  // Registers a code made elsewhere (the relay's `relay code` CLI). `meta`
  // travels with the code and comes back on success; `meta.nodeName`, when
  // set, must equal the pairing node's name or the pairing is refused
  // (`name_mismatch`).
  addCode(code, meta = {}) {
    const normalized = String(code).trim().toLowerCase();
    const secret = crypto.createHash('sha256').update(normalized).digest();
    const pairingId = crypto.randomBytes(8).toString('hex');
    this.pendingPairings.set(pairingId, {
      code: normalized,
      secret,
      meta,
      createdAt: Date.now(),
      direction: 'initiator',
      timeout: setTimeout(() => {
        this.pendingPairings.delete(pairingId);
      }, this.timeoutMs)
    });
    return { pairingId, code: normalized, expiresAt: Date.now() + this.timeoutMs };
  }
```

In `acceptCode`, change `}, PAIRING_TIMEOUT_MS);` to `}, this.timeoutMs);`.

In `_initiatePairingHandshake`, replace the `peerInfo` literal with:

```js
            const peerInfo = {
              peerId: msg.identity.peerId,
              publicKey: msg.identity.publicKey,
              displayName: msg.identity.displayName,
              capabilities: msg.identity.capabilities,
              tlsFingerprint: msg.identity.tlsFingerprint || null,
              nodeId: msg.identity.nodeId || null,
              nodeName: msg.identity.nodeName || null,
              address,
              port
            };
```

In `handlePairingRequest`, replace

```js
    const { id: pairingId, pairing } = matchedPairing;

    // Send back our proof
```

with

```js
    const { id: pairingId, pairing } = matchedPairing;
    const meta = pairing.meta || {};

    // A code issued for one node name cannot pair a node with another.
    if (meta.nodeName && remoteIdentity.nodeName !== meta.nodeName) {
      clearTimeout(pairing.timeout);
      this.pendingPairings.delete(pairingId);
      ws.send(JSON.stringify({ type: 'pair:reject', reason: 'name_mismatch' }));
      ws.close();
      return null;
    }

    // Send back our proof
```

and its final `return peerInfo;` with:

```js
    return { ...peerInfo, nodeId: remoteIdentity.nodeId || null, nodeName: remoteIdentity.nodeName || null, meta };
```

Create `src/approvals/link-rpc.js`:

```js
// Request/response and notifications over an authenticated MeshTransport
// link (node ↔ relay, spec §4.6). Every frame is a signed mesh envelope; the
// payload is { rpc: 1, id, method, params } for a call, { rpc: 1, id, result }
// or { rpc: 1, id, error: { code, message } } for its answer, and
// { rpc: 1, method, params } (no id) for a notification.
const crypto = require('crypto');
const { createLogger } = require('../logging');

const log = createLogger('approvals/link-rpc');

class LinkRpcError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LinkRpcError';
    this.code = code;
  }
}

function createLinkRpc(transport, { defaultTimeoutMs = 10000 } = {}) {
  const handlers = new Map();
  const pending = new Map();
  let fallback = null;

  const send = (peerId, payload) => {
    try {
      transport.send(peerId, payload);
      return true;
    } catch (err) {
      log.debug(`link send to ${peerId} failed: ${err.message}`);
      return false;
    }
  };

  const onMessage = ({ from, payload }) => {
    if (!payload || payload.rpc !== 1) return;
    if (payload.id && !payload.method) {
      const waiter = pending.get(payload.id);
      if (!waiter || waiter.peerId !== from) return;
      pending.delete(payload.id);
      clearTimeout(waiter.timer);
      if (payload.error) waiter.reject(new LinkRpcError(payload.error.code || 'error', payload.error.message));
      else waiter.resolve(payload.result === undefined ? null : payload.result);
      return;
    }
    if (typeof payload.method !== 'string') return;
    const own = handlers.get(payload.method);
    const handler = own || (fallback ? (params, ctx) => fallback(payload.method, params, ctx) : null);
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    if (!payload.id) {
      if (handler) {
        Promise.resolve()
          .then(() => handler(params, { peerId: from }))
          .catch((err) => log.warn(`notification ${payload.method} failed: ${err.message}`));
      }
      return;
    }
    if (!handler) {
      send(from, { rpc: 1, id: payload.id, error: { code: 'unknown_method', message: `no handler for ${payload.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(params, { peerId: from }))
      .then(
        (result) => send(from, { rpc: 1, id: payload.id, result: result === undefined ? null : result }),
        (err) => send(from, { rpc: 1, id: payload.id, error: { code: err.code || 'error', message: err.message } })
      );
  };

  const onDisconnect = ({ peerId }) => {
    for (const [id, waiter] of pending) {
      if (waiter.peerId !== peerId) continue;
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new LinkRpcError('peer_disconnected', `${peerId} disconnected`));
    }
  };

  transport.on('peerMessage', onMessage);
  transport.on('peerDisconnected', onDisconnect);

  return {
    call(peerId, method, params = {}, { timeoutMs = defaultTimeoutMs } = {}) {
      const id = crypto.randomBytes(12).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new LinkRpcError('timeout', `${method} to ${peerId} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { peerId, resolve, reject, timer });
        if (!send(peerId, { rpc: 1, id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new LinkRpcError('offline', `${peerId} is not connected`));
        }
      });
    },
    notify(peerId, method, params = {}) {
      send(peerId, { rpc: 1, method, params });
    },
    handle(method, fn) {
      handlers.set(method, fn);
    },
    unhandle(method) {
      handlers.delete(method);
    },
    // Called as fn(method, params, ctx) for any method without its own handler.
    onUnhandled(fn) {
      fallback = fn;
    },
    close() {
      transport.removeListener('peerMessage', onMessage);
      transport.removeListener('peerDisconnected', onDisconnect);
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new LinkRpcError('closed', 'link closed'));
        pending.delete(id);
      }
    }
  };
}

module.exports = { createLinkRpc, LinkRpcError };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-link-rpc.test.js tests/mesh-pairing.test.js tests/mesh-transport.test.js`
Expected: PASS, `fail 0` (6 new tests; the existing mesh tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/link-rpc.js src/mesh/mesh-transport.js src/mesh/mesh-pairing.js tests/approvals-link-rpc.test.js
git commit -m "feat(mesh): dial-out-only transports, named pairing codes, and link RPC

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: RelayClient — the node's link

**Files:**
- Create: `src/approvals/relay-client.js`
- Test: `tests/approvals-relay-client.test.js`

**Interfaces:**
- Consumes: `MeshTransport` (`listen: false`, Task 13), `createLinkRpc`, `LinkRpcError` (Task 13), `writeFileAtomic` (Part 1, Task 7).
- Produces (program P10, P11/E5, P13/E7): `new RelayClient({ identity, nodeName, relayPin, configDir, dataDir, transportFactory, useTls = true, reconnectDelays = [1000, 5000, 15000, 30000], callTimeoutMs = 10000, now })`, an `EventEmitter` (`'connected'`, `'disconnected'`) with `start()`, `stop()`, and the link interface: `submit(env)`, `status(env)`, `send(env, { push, to_device }) → { ok, seq }`, `call(method, params, { timeoutMs })` (rejects `relay_offline` while down), `notify(method, params)`, `onMessage(handler(method, params))` for `approval.response`, `enroll.claim`, `device.enroll`, `device.revoke`, `audit.slice`, `audit.head`, `registerMethod(name, handler(params, { peer }))` (throws `code: 'method_reserved'` for F3's names and `mesh.task.*` / `mesh.channel.*`), `isConnected()`, `canDeliver() → { ok } | { ok: false, reason }` (ok once paired, even while down — R16), `relayInfo`. Also `isReservedMethod(name)`, `F3_METHODS`, `NODE_INBOUND`, `readFrontDoor(configDir)`.

`relayPin` is the record `pair` stores (`approvals.relay`): `{ relay_id, peerId, publicKey, tlsFingerprint, address, port, pairedAt }`. On connect the client calls `relay.hello { node_id, node_name, versions: [1] }`, refuses a relay answering with another `relay_id`, and keeps `<dataDir>/approvals/link.json` = `{ connected, since, relay_id, relay_public_url, relay_spki }` current. It adds the relay as a trusted peer *without* an address so it, not the transport, decides when to redial. When `<configDir>/front-door.json` exists and the transport has `connectPinned` (F4), it dials through `connectPinned(frontDoor)` (E7).

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-relay-client.test.js`:

```js
// tests/approvals-relay-client.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { RelayClient, isReservedMethod } = require('../src/approvals/relay-client');

let relayIdentity;
let nodeIdentity;
before(() => {
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
  nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-client-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Just enough relay to answer the link: hello plus recorders.
async function fakeRelay({ port = 0, relayId = null } = {}) {
  const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port, useTls: false });
  transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
  await transport.start();
  const rpc = createLinkRpc(transport);
  const seen = [];
  rpc.handle('relay.hello', (params) => { seen.push(['relay.hello', params]); return { relay_id: relayId || relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/test' }; });
  rpc.handle('approval.submit', (params) => { seen.push(['approval.submit', params]); return { ok: true }; });
  rpc.handle('message.submit', (params) => { seen.push(['message.submit', params]); return { ok: true, seq: 1 }; });
  rpc.onUnhandled((method, params) => { seen.push([method, params]); return { ok: true }; });
  return { transport, rpc, seen, stop: () => transport.stop() };
}

function pinFor(relay) {
  return {
    relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
    tlsFingerprint: null, address: '127.0.0.1', port: relay.transport.port, pairedAt: new Date().toISOString()
  };
}

function client(relay, extra = {}) {
  const dataDir = tempDir();
  const c = new RelayClient({ identity: nodeIdentity, relayPin: pinFor(relay), dataDir, useTls: false, reconnectDelays: [50, 100], ...extra });
  cleanups.push(() => c.stop());
  return { c, dataDir };
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const readLink = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));

describe('RelayClient', () => {
  it('dials, says hello, writes link.json and emits connected', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(c.isConnected(), true);
    assert.deepEqual(relay.seen[0], ['relay.hello', { node_id: nodeIdentity.nodeId, node_name: 'web-01', versions: [1] }]);
    const link = readLink(dataDir);
    assert.equal(link.connected, true);
    assert.equal(link.relay_id, relayIdentity.nodeId);
    assert.equal(link.relay_public_url, 'https://kl.example.com:8443');
    assert.equal(link.relay_spki, 'sha256/test');
  });

  it('submit and send reach the relay; relay calls reach onMessage and registered methods', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    await c.submit({ alg: 'Ed25519', kid: 'k', payload: 'p', sig: 's' });
    assert.deepEqual(await c.send({ a: 1 }, { push: { kind: 'lease', id: 'l-1' } }), { ok: true, seq: 1 });
    assert.deepEqual(relay.seen.slice(1).map((s) => s[0]), ['approval.submit', 'message.submit']);
    assert.deepEqual(relay.seen[2][1], { envelope: { a: 1 }, push: { kind: 'lease', id: 'l-1' }, to_device: null });

    c.onMessage(async (method, params) => ({ delivered: true, method, params }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: 'x' }), { delivered: true, method: 'approval.response', params: { envelope: 'x' } });
    c.registerMethod('question.answer', async (params, { peer }) => ({ got: params.q, peer }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'question.answer', { q: 1 }), { got: 1, peer: relayIdentity.peerId });
    c.notify('presence.foreground', { device_id: 'd-x' });
  });

  it('registerMethod refuses F3 names and mesh.task.* / mesh.channel.*', () => {
    const c = new RelayClient({ identity: nodeIdentity, relayPin: null });
    for (const name of ['approval.response', 'relay.hello', 'mesh.task.run', 'mesh.channel.open']) {
      assert.throws(() => c.registerMethod(name, () => {}), (err) => err.code === 'method_reserved', name);
      assert.equal(isReservedMethod(name), true);
    }
    assert.doesNotThrow(() => c.registerMethod('lease.grant', () => {}));
  });

  it('marks the link down when the relay goes, reconnects when it returns, and can still deliver', async () => {
    const relay = await fakeRelay();
    const port = relay.transport.port;
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    const disconnected = once(c, 'disconnected');
    await relay.stop();
    await disconnected;
    assert.equal(c.isConnected(), false);
    assert.equal(readLink(dataDir).connected, false);
    assert.deepEqual(c.canDeliver(), { ok: true });
    await assert.rejects(c.submit({}), (err) => err.code === 'relay_offline');
    const back = once(c, 'connected');
    const again = await fakeRelay({ port });
    cleanups.push(again.stop);
    await back;
    assert.equal(c.isConnected(), true);
  });

  it('refuses a relay that answers with another relay id', async () => {
    const relay = await fakeRelay({ relayId: 'kl-aaaaaaaaaaaaaaaa' });
    cleanups.push(relay.stop);
    const { c } = client(relay);
    await c.start();
    for (let i = 0; i < 50 && relay.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.isConnected(), false);
  });

  it('dials front-door.json through connectPinned when the transport has it (E7)', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const configDir = tempDir();
    fs.writeFileSync(path.join(configDir, 'front-door.json'), JSON.stringify({ url: 'https://kl.example.com' }));
    const pinned = [];
    const transportFactory = (options) => {
      const t = new MeshTransport(options);
      t.connectPinned = (fd) => { pinned.push(fd); return t.connectToPeer('127.0.0.1', relay.transport.port); };
      return t;
    };
    const { c } = client(relay, { configDir, transportFactory });
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.deepEqual(pinned, [{ url: 'https://kl.example.com' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-relay-client.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/relay-client'`.

- [ ] **Step 3: Implement**

Create `src/approvals/relay-client.js`:

```js
// The node's one link to its relay (spec §3.11): a dial-out-only
// MeshTransport to the relay pinned by `pair`, or to the front door named in
// <configDir>/front-door.json when F4's transport can dial it (E7). It
// implements the link interface the PhoneApprover, F5 and C4 use.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { MeshTransport } = require('../mesh/mesh-transport');
const { createLinkRpc, LinkRpcError } = require('./link-rpc');
const { writeFileAtomic } = require('./approver-store');

const log = createLogger('approvals/relay-client');

// F3's own link methods (§4.6); nobody else may register these names.
const F3_METHODS = new Set([
  'relay.hello', 'approval.submit', 'approval.status', 'approval.response', 'message.submit',
  'enroll.open', 'enroll.done', 'enroll.claim', 'device.enroll', 'device.revoke', 'device.state',
  'audit.slice', 'audit.head'
]);
const RESERVED_PREFIXES = ['mesh.task.', 'mesh.channel.'];
// relay → node methods answered by the onMessage handler (service-wiring).
const NODE_INBOUND = ['approval.response', 'enroll.claim', 'device.enroll', 'device.revoke', 'audit.slice', 'audit.head'];

function isReservedMethod(name) {
  return F3_METHODS.has(name) || RESERVED_PREFIXES.some((p) => String(name).startsWith(p));
}

function readFrontDoor(configDir) {
  if (!configDir) return null;
  const file = path.join(configDir, 'front-door.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class RelayClient extends EventEmitter {
  constructor({ identity, nodeName = null, relayPin = null, configDir = null, dataDir = null,
    transportFactory = (options) => new MeshTransport(options), useTls = true,
    reconnectDelays = [1000, 5000, 15000, 30000], callTimeoutMs = 10000, now = Date.now } = {}) {
    super();
    this.identity = identity;
    this.nodeName = nodeName || identity.nodeName;
    this.pin = relayPin;
    this.configDir = configDir;
    this.linkFile = dataDir ? path.join(dataDir, 'approvals', 'link.json') : null;
    this.transportFactory = transportFactory;
    this.useTls = useTls;
    this.reconnectDelays = reconnectDelays;
    this.callTimeoutMs = callTimeoutMs;
    this.now = now;
    this.connected = false;
    this.relayInfo = null;
    this.relayPeerId = relayPin ? relayPin.peerId : null;
    this.handler = null;
    this.methods = new Map();
    this.stopped = false;
    this.retryTimer = null;
    this.transport = null;
    this.rpc = null;
  }

  async start() {
    if (!this.pin) throw new Error('RelayClient needs a relay pin (run `king-louie-service pair wss://…` first)');
    this.stopped = false;
    this.transport = this.transportFactory({ identity: this.identity, listen: false, useTls: this.useTls, port: 0 });
    this.rpc = createLinkRpc(this.transport, { defaultTimeoutMs: this.callTimeoutMs });
    for (const method of NODE_INBOUND) {
      this.rpc.handle(method, (params) => {
        if (!this.handler) throw new LinkRpcError('not_ready', 'the node is not ready for relay messages');
        return this.handler(method, params);
      });
    }
    this.rpc.onUnhandled((method, params, { peerId }) => {
      const handler = this.methods.get(method);
      if (!handler) throw new LinkRpcError('unknown_method', `no handler for ${method}`);
      return handler(params, { peer: peerId });
    });
    this.transport.on('peerConnected', (peer) => {
      if (peer.peerId !== this.relayPeerId) return;
      this._onConnected().catch((err) => log.warn(`relay hello failed: ${err.message}`));
    });
    this.transport.on('peerDisconnected', ({ peerId }) => {
      if (peerId === this.relayPeerId) this._onDisconnected();
    });
    // No address on the trusted peer: this client, not the transport, decides
    // when to dial again.
    this.transport.addTrustedPeer(this.pin.peerId, this.pin.publicKey, { displayName: 'relay', tlsFingerprint: this.pin.tlsFingerprint || null });
    await this.transport.start();
    this._writeLink();
    this._dial(0);
  }

  _dial(attempt) {
    if (this.stopped || this.connected) return;
    const frontDoor = readFrontDoor(this.configDir);
    const attemptConnect = frontDoor && typeof this.transport.connectPinned === 'function'
      ? this.transport.connectPinned(frontDoor)
      : this.transport.connectToPeer(this.pin.address, this.pin.port);
    Promise.resolve(attemptConnect).catch((err) => {
      if (this.stopped) return;
      const delay = this.reconnectDelays[Math.min(attempt, this.reconnectDelays.length - 1)];
      log.info(`relay not reachable (${err.message}); retrying in ${delay} ms`);
      this.retryTimer = setTimeout(() => this._dial(attempt + 1), delay);
      if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
    });
  }

  async _onConnected() {
    const hello = await this.rpc.call(this.relayPeerId, 'relay.hello', { node_id: this.identity.nodeId, node_name: this.nodeName, versions: [1] });
    if (!hello || hello.relay_id !== this.pin.relay_id) {
      log.error(`relay answered as ${hello && hello.relay_id}, but this node paired with ${this.pin.relay_id}; not using the link`);
      return;
    }
    this.connected = true;
    this.relayInfo = hello;
    this.since = new Date(this.now()).toISOString();
    this._writeLink();
    log.info(`linked to relay ${hello.relay_id}`);
    this.emit('connected');
  }

  _onDisconnected() {
    const was = this.connected;
    this.connected = false;
    this._writeLink();
    if (was) this.emit('disconnected');
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => this._dial(0), this.reconnectDelays[0]);
      if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
    }
  }

  _writeLink() {
    if (!this.linkFile) return;
    try {
      fs.mkdirSync(path.dirname(this.linkFile), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.linkFile, `${JSON.stringify({
        connected: this.connected,
        since: this.connected ? this.since : null,
        relay_id: this.pin.relay_id,
        relay_public_url: this.relayInfo ? this.relayInfo.public_url : null,
        relay_spki: this.relayInfo ? this.relayInfo.phone_spki : null
      })}\n`);
    } catch (err) {
      log.warn(`could not write ${this.linkFile}: ${err.message}`);
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const was = this.connected;
    this.connected = false;
    if (this.rpc) this.rpc.close();
    if (this.transport) await this.transport.stop();
    this._writeLink();
    if (was) this.emit('disconnected');
  }

  // ── Link interface ────────────────────────────────────────────────────────

  isConnected() {
    return this.connected;
  }

  // ok once paired, even while disconnected: requests wait for the link (R16).
  canDeliver() {
    return this.pin ? { ok: true } : { ok: false, reason: 'no relay is paired with this node' };
  }

  call(method, params = {}, { timeoutMs = this.callTimeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new LinkRpcError('relay_offline', 'the relay link is down'));
    return this.rpc.call(this.relayPeerId, method, params, { timeoutMs });
  }

  notify(method, params = {}) {
    if (this.connected) this.rpc.notify(this.relayPeerId, method, params);
  }

  submit(envelope) {
    return this.call('approval.submit', { envelope });
  }

  status(envelope) {
    return this.call('approval.status', { envelope });
  }

  send(envelope, { push = null, to_device = null } = {}) {
    return this.call('message.submit', { envelope, push, to_device });
  }

  // F3's relay → node methods: handler(method, params) → result.
  onMessage(handler) {
    this.handler = handler;
  }

  // Extension methods (E5): F4, F5 and C4 mount their own relay → node methods.
  registerMethod(name, handler) {
    if (isReservedMethod(name)) {
      throw Object.assign(new Error(`method_reserved: ${name} belongs to the approval link or the mesh`), { code: 'method_reserved' });
    }
    this.methods.set(name, handler);
  }
}

module.exports = { RelayClient, isReservedMethod, F3_METHODS, NODE_INBOUND, readFrontDoor };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-relay-client.test.js`
Expected: PASS, `fail 0` (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/relay-client.js tests/approvals-relay-client.test.js
git commit -m "feat(approvals): RelayClient link with hello, link.json, reconnect and extension methods

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: File courier for `mcp` and the admin CLI

**Files:**
- Create: `src/approvals/courier.js`
- Test: `tests/approvals-courier.test.js`

**Interfaces:**
- Consumes: `readPidfile`, `isRunning` (`src/service/pidfile.js`); `open`, `verifyEd25519` (Part 1, Task 3); `writeFileAtomic` (Part 1, Task 7); a relay client's `call(method, params)` (Task 14).
- Produces (program P12/E6): `new FileCourier({ dataDir, identity, pollMs = 250, isAlive, onPathWritten })` — an `EventEmitter` implementing the link interface except `registerMethod`: `start()`, `stop()`, `canDeliver()` (`{ ok: false, reason: 'the King Louie service is not running on this node' }` when the pidfile's process is dead; `'no relay is paired with this node'` without `link.json`), `isConnected()`, `call(method, params, { timeoutMs = 10000 })` (rejects `code: 'unavailable' | 'timeout'` or the service's error code), `notify`, `submit`, `status`, `send`, `onMessage(handler)` (only `approval.response` and `enroll.claim` are delivered), events `connected`/`disconnected` (from `link.json`), `inboxName`, `inbox`. `new CourierPump({ dataDir, relayClient, identity, rpcHandler = null, pollMs = 250, now, isAlive })` with `start()`, `stop()`, `pollOnce()`, `routeFor(method, params) → inboxName | null`, `deliver(inboxName, method, params) → boolean`. `class CourierError`, `NOT_RUNNING`.

Files: outbox `<dataDir>/approvals/outbox/<ms>-<8 hex>.json` = `{ method, params, reply_to: { inbox, key } | null }` (temp + rename); inbox `<dataDir>/approvals/inbox/p-<pid>-<8 hex>/` holding `<16 hex key>.json` replies (`{ result }` / `{ error: { code, message } }`) and `m-<ms>-<8 hex>.json` messages (`{ method, params }`). The pump forwards `approval.submit` (`kl.approval.request`), `approval.status`, `message.submit` (any type), `enroll.open`, `enroll.done` only when the envelope is signed by this node's key and names this node; `enroll.done` only for a `code_id` whose `enroll.open` it forwarded and that has not expired; other methods go to `rpcHandler` (F4, R24) or are dropped with an `unknown_method` reply. Inboxes of dead producers are removed.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-courier.test.js`:

```js
// tests/approvals-courier.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileCourier, CourierPump } = require('../src/approvals/courier');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

// A data dir whose service.pid names this (live) test process, so the
// courier believes the service runs; `running: false` leaves it absent.
function dataDir({ running = true, linked = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-courier-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  if (running) fs.writeFileSync(path.join(d, 'service.pid'), String(process.pid));
  if (linked) {
    fs.mkdirSync(path.join(d, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(d, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: null, relay_id: 'kl-x', relay_public_url: null, relay_spki: null }));
  }
  return d;
}

function fakeRelayClient() {
  const calls = [];
  return { calls, call: async (method, params) => { calls.push([method, params]); return { ok: true }; } };
}

function pair({ dir = dataDir(), identity = testNodeIdentity(), rpcHandler = null } = {}) {
  const relayClient = fakeRelayClient();
  const pump = new CourierPump({ dataDir: dir, relayClient, identity, rpcHandler, pollMs: 10 }).start();
  const courier = new FileCourier({ dataDir: dir, identity, pollMs: 10 }).start();
  cleanups.push(() => { courier.stop(); pump.stop(); });
  return { dir, identity, relayClient, pump, courier };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('FileCourier and CourierPump', () => {
  it('forwards a node-signed request and brings the reply back', async () => {
    const { courier, relayClient, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    assert.deepEqual(await courier.submit(envelope), { ok: true });
    assert.deepEqual(relayClient.calls, [['approval.submit', { envelope }]]);
  });

  it('routes a phone response back to the producer that submitted the request', async () => {
    const { courier, pump, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    await courier.submit(envelope);
    const got = [];
    courier.onMessage(async (method, params) => { got.push([method, params]); });
    const response = createFakePhone().respond(envelope, 'approve');
    const inbox = pump.routeFor('approval.response', { envelope: response });
    assert.equal(inbox, courier.inboxName);
    assert.equal(pump.deliver(inbox, 'approval.response', { envelope: response }), true);
    for (let i = 0; i < 50 && got.length === 0; i += 1) await tick(10);
    assert.deepEqual(got, [['approval.response', { envelope: response }]]);
  });

  it('non-relay methods go to the rpcHandler (R24)', async () => {
    const { courier } = pair({ rpcHandler: async (method, params) => ({ handled: method, params }) });
    assert.deepEqual(await courier.call('jobs.get', { job_id: 'job-1' }), { handled: 'jobs.get', params: { job_id: 'job-1' } });
  });

  it('is unavailable at once when the service is not running', async () => {
    const courier = new FileCourier({ dataDir: dataDir({ running: false }) });
    assert.deepEqual(courier.canDeliver(), { ok: false, reason: 'the King Louie service is not running on this node' });
    await assert.rejects(courier.call('approval.submit', {}), (err) => err.code === 'unavailable');
    assert.deepEqual(new FileCourier({ dataDir: dataDir({ linked: false }) }).canDeliver(), { ok: false, reason: 'no relay is paired with this node' });
  });

  it('drops an outbox entry not signed by this node', async () => {
    const { courier, relayClient } = pair();
    const stranger = testNodeIdentity();
    const { envelope } = m.buildRequest({ identity: stranger, action: m.toolAction('Bash', { command: 'ls' }, null) });
    await assert.rejects(courier.submit(envelope), (err) => err.code === 'rejected');
    assert.deepEqual(relayClient.calls, []);
  });

  it('drops enroll.done for a code_id it never saw opened, forwards it after enroll.open', async () => {
    const { courier, relayClient, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    const done = m.buildEnrollDone({ identity, codeId, refused: true });
    await assert.rejects(courier.call('enroll.done', { envelope: done }), (err) => err.code === 'rejected');
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() + 600000 }) });
    await courier.call('enroll.done', { envelope: done });
    assert.deepEqual(relayClient.calls.map((c) => c[0]), ['enroll.open', 'enroll.done']);
  });

  it('ignores forged inbox files: an unknown reply and a method a producer never accepts', async () => {
    const { courier } = pair();
    const got = [];
    courier.onMessage(async (method) => { got.push(method); });
    fs.writeFileSync(path.join(courier.inbox, `${'a'.repeat(16)}.json`), JSON.stringify({ result: { ok: true } }));
    fs.writeFileSync(path.join(courier.inbox, 'm-1-deadbeef.json'), JSON.stringify({ method: 'device.enroll', params: {} }));
    await tick(80);
    assert.deepEqual(got, []);
    assert.deepEqual(fs.readdirSync(courier.inbox), []);
  });

  it('emits connected when link.json turns connected, and removes dead producers’ inboxes', async () => {
    const dir = dataDir();
    const linkFile = path.join(dir, 'approvals', 'link.json');
    fs.writeFileSync(linkFile, JSON.stringify({ connected: false }));
    const { courier, pump } = pair({ dir });
    const connected = new Promise((resolve) => courier.once('connected', resolve));
    fs.writeFileSync(linkFile, JSON.stringify({ connected: true }));
    await connected;
    const dead = path.join(dir, 'approvals', 'inbox', 'p-999999999-deadbeef');
    fs.mkdirSync(dead);
    await pump.pollOnce();
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(courier.inbox), true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-courier.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/courier'`.

- [ ] **Step 3: Implement**

Create `src/approvals/courier.js`:

```js
// File courier (spec §3.9): `mcp` and the admin CLI cannot open a second link
// with the node's key, so they hand node-signed messages to the running
// service through <dataDir>/approvals/outbox/ and read replies from their own
// inbox. The protection is the signatures, not the directory ACL: the pump
// forwards only envelopes signed by this node's key (and enroll.done only for
// a code it saw opened), and producers verify whatever they read back.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { readPidfile, isRunning } = require('../service/pidfile');
const { open, verifyEd25519 } = require('./envelope');
const { writeFileAtomic } = require('./approver-store');

const log = createLogger('approvals/courier');

const INBOX_RE = /^p-(\d+)-[a-f0-9]{8}$/;
const KEY_RE = /^[a-f0-9]{16}$/;
const NOT_RUNNING = 'the King Louie service is not running on this node';
// Methods the pump forwards only with an envelope signed by this node, and
// the message type each must carry (message.submit: any node-signed type).
const SIGNED_METHODS = {
  'approval.submit': 'kl.approval.request',
  'approval.status': 'kl.approval.status',
  'message.submit': null,
  'enroll.open': 'kl.enroll.open',
  'enroll.done': 'kl.enroll.done'
};
// What a producer accepts from its inbox besides replies.
const INBOX_METHODS = new Set(['approval.response', 'enroll.claim']);

function approvalsDir(dataDir) {
  return path.join(dataDir, 'approvals');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class CourierError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CourierError';
    this.code = code;
  }
}

// ── Producer side (mcp, admin CLI) ──────────────────────────────────────────
class FileCourier extends EventEmitter {
  constructor({ dataDir, identity = null, pollMs = 250, isAlive = isRunning, onPathWritten = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.identity = identity;
    this.pollMs = pollMs;
    this.isAlive = isAlive;
    this.onPathWritten = onPathWritten || (() => {});
    this.inboxName = `p-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.inbox = path.join(approvalsDir(dataDir), 'inbox', this.inboxName);
    this.outbox = path.join(approvalsDir(dataDir), 'outbox');
    this.waiting = new Map();
    this.handler = null;
    this.timer = null;
    this.lastConnected = false;
  }

  start() {
    for (const dir of [this.outbox, this.inbox]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.onPathWritten(dir);
    }
    this.lastConnected = this.isConnected();
    this.timer = setInterval(() => this._poll(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new CourierError('closed', 'courier stopped'));
    }
    this.waiting.clear();
    fs.rmSync(this.inbox, { recursive: true, force: true });
  }

  _link() {
    return readJson(path.join(approvalsDir(this.dataDir), 'link.json'));
  }

  canDeliver() {
    const pid = readPidfile(this.dataDir);
    if (!pid || !this.isAlive(pid)) return { ok: false, reason: NOT_RUNNING };
    if (!this._link()) return { ok: false, reason: 'no relay is paired with this node' };
    return { ok: true };
  }

  isConnected() {
    if (!this.canDeliver().ok) return false;
    const link = this._link();
    return Boolean(link && link.connected === true);
  }

  _post(method, params, replyTo) {
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const file = path.join(this.outbox, name);
    writeFileAtomic(file, `${JSON.stringify({ method, params, reply_to: replyTo })}\n`);
    this.onPathWritten(file);
  }

  call(method, params = {}, { timeoutMs = 10000 } = {}) {
    const delivery = this.canDeliver();
    if (!delivery.ok) return Promise.reject(new CourierError('unavailable', delivery.reason));
    const key = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        reject(new CourierError('timeout', `${method} got no reply from the service within ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiting.set(key, { resolve, reject, timer });
      this._post(method, params, { inbox: this.inboxName, key });
    });
  }

  notify(method, params = {}) {
    if (this.canDeliver().ok) this._post(method, params, null);
  }

  submit(envelope) {
    return this.call('approval.submit', { envelope });
  }

  status(envelope) {
    return this.call('approval.status', { envelope });
  }

  send(envelope, { push = null, to_device = null } = {}) {
    return this.call('message.submit', { envelope, push, to_device });
  }

  onMessage(handler) {
    this.handler = handler;
  }

  _poll() {
    const connected = this.isConnected();
    if (connected && !this.lastConnected) this.emit('connected');
    if (!connected && this.lastConnected) this.emit('disconnected');
    this.lastConnected = connected;
    let names;
    try {
      names = fs.readdirSync(this.inbox);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.inbox, name);
      if (name.endsWith('.tmp') || name.includes('.tmp-')) continue;
      const body = readJson(file);
      try { fs.unlinkSync(file); } catch { /* gone */ }
      const key = name.replace(/\.json$/, '');
      if (KEY_RE.test(key)) {
        const waiter = this.waiting.get(key);
        if (!waiter) {
          log.warn(`dropping a reply nobody asked for: ${name}`);
          continue;
        }
        this.waiting.delete(key);
        clearTimeout(waiter.timer);
        if (body && body.error) waiter.reject(new CourierError(body.error.code || 'error', body.error.message));
        else waiter.resolve(body ? body.result : null);
        continue;
      }
      if (!body || !INBOX_METHODS.has(body.method) || !this.handler) {
        log.warn(`dropping inbox file ${name}`);
        continue;
      }
      Promise.resolve()
        .then(() => this.handler(body.method, body.params || {}))
        .catch((err) => log.warn(`inbox ${body.method} failed: ${err.message}`));
    }
  }
}

// ── Service side ────────────────────────────────────────────────────────────
class CourierPump {
  constructor({ dataDir, relayClient, identity, rpcHandler = null, pollMs = 250, now = Date.now, isAlive = isRunning } = {}) {
    this.dataDir = dataDir;
    this.relayClient = relayClient;
    this.identity = identity;
    this.nodeKey = Buffer.from(identity.publicKey).toString('hex');
    this.rpcHandler = rpcHandler;
    this.pollMs = pollMs;
    this.now = now;
    this.isAlive = isAlive;
    this.outbox = path.join(approvalsDir(dataDir), 'outbox');
    this.inboxRoot = path.join(approvalsDir(dataDir), 'inbox');
    this.routes = new Map();
    this.codes = new Map();
    this.timer = null;
    this.busy = false;
  }

  start() {
    fs.mkdirSync(this.outbox, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.inboxRoot, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => { this.pollOnce().catch((err) => log.warn(`courier poll failed: ${err.message}`)); }, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _nodeSigned(envelope, type) {
    if (!envelope || envelope.alg !== 'Ed25519' || envelope.kid !== this.identity.nodeId) return null;
    if (!verifyEd25519(envelope, this.nodeKey)) return null;
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      return null;
    }
    if (message.node_id !== this.identity.nodeId) return null;
    if (type && message.type !== type) return null;
    return message;
  }

  _writeTo(inboxName, fileName, body) {
    if (!INBOX_RE.test(inboxName)) return false;
    const dir = path.join(this.inboxRoot, inboxName);
    if (!fs.existsSync(dir)) return false;
    writeFileAtomic(path.join(dir, fileName), `${JSON.stringify(body)}\n`);
    return true;
  }

  _reply(replyTo, body) {
    if (!replyTo || !INBOX_RE.test(String(replyTo.inbox)) || !KEY_RE.test(String(replyTo.key))) return;
    this._writeTo(replyTo.inbox, `${replyTo.key}.json`, body);
  }

  // Which producer's inbox a relay → node message belongs to, or null.
  routeFor(method, params = {}) {
    if (method === 'approval.response') {
      try {
        const { message } = open(params.envelope);
        const route = this.routes.get(message.request_id);
        return route ? route.inbox : null;
      } catch {
        return null;
      }
    }
    if (method === 'enroll.claim') {
      const route = this.codes.get(params.code_id);
      return route ? route.inbox : null;
    }
    return null;
  }

  deliver(inboxName, method, params) {
    return this._writeTo(inboxName, `m-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`, { method, params });
  }

  async _handle(entry) {
    const { method, params = {}, reply_to: replyTo = null } = entry || {};
    if (Object.prototype.hasOwnProperty.call(SIGNED_METHODS, method)) {
      const message = this._nodeSigned(params.envelope, SIGNED_METHODS[method]);
      if (!message) {
        log.warn(`dropping ${method} from the outbox: not signed by this node`);
        this._reply(replyTo, { error: { code: 'rejected', message: 'not signed by this node' } });
        return;
      }
      if (method === 'enroll.done') {
        const code = this.codes.get(message.code_id);
        if (!code || this.now() > code.expiresAt) {
          log.warn(`dropping enroll.done for a code this service never opened (${message.code_id})`);
          this._reply(replyTo, { error: { code: 'rejected', message: 'unknown code_id' } });
          return;
        }
      }
      const inbox = replyTo && INBOX_RE.test(String(replyTo.inbox)) ? replyTo.inbox : null;
      if (method === 'approval.submit' && inbox) this.routes.set(message.request_id, { inbox, expiresAt: Date.parse(message.expires_at) });
      if (method === 'enroll.open' && inbox) this.codes.set(message.code_id, { inbox, expiresAt: Date.parse(message.expires_at) });
      try {
        this._reply(replyTo, { result: await this.relayClient.call(method, params) });
      } catch (err) {
        this._reply(replyTo, { error: { code: err.code || 'error', message: err.message } });
      }
      return;
    }
    if (this.rpcHandler) {
      try {
        this._reply(replyTo, { result: await this.rpcHandler(method, params) });
      } catch (err) {
        this._reply(replyTo, { error: { code: err.code || 'error', message: err.message } });
      }
      return;
    }
    log.warn(`dropping ${method} from the outbox: not a courier method`);
    this._reply(replyTo, { error: { code: 'unknown_method', message: `${method} is not forwarded` } });
  }

  _sweep() {
    const cutoff = this.now() - 60000;
    for (const map of [this.routes, this.codes]) {
      for (const [k, v] of map) if (v.expiresAt < cutoff) map.delete(k);
    }
    let names = [];
    try {
      names = fs.readdirSync(this.inboxRoot);
    } catch {
      return;
    }
    for (const name of names) {
      const m = INBOX_RE.exec(name);
      if (m && !this.isAlive(Number(m[1]))) fs.rmSync(path.join(this.inboxRoot, name), { recursive: true, force: true });
    }
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      let names = [];
      try {
        names = fs.readdirSync(this.outbox).filter((n) => /^\d+-[a-f0-9]{8}\.json$/.test(n)).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const file = path.join(this.outbox, name);
        const entry = readJson(file);
        try { fs.unlinkSync(file); } catch { continue; }
        await this._handle(entry);
      }
      this._sweep();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { FileCourier, CourierPump, CourierError, NOT_RUNNING };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-courier.test.js`
Expected: PASS, `fail 0` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/courier.js tests/approvals-courier.test.js
git commit -m "feat(approvals): file courier that forwards only node-signed envelopes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Unsafe runbooks through the phone

**Files:**
- Modify: `src/runbooks/runbook-engine.js` — `executeRunbook`'s validation line (`:588`), `JobManager.createJob`'s controller line (`:780`) and a new `transition` method after `createJob`
- Modify: `src/mcp/stdio-server.js` — requires (`:6-7`), the `run_runbook` description (`:35`), the constructor (`:155-156`), and everything from `  // Everything that can be refused is checked before a job exists, so a` (`:413`) to the end of the file
- Modify: `tests/mcp-stdio.test.js:225-230` (the stage 2 denial message)
- Test: `tests/mcp-stdio-approvals.test.js`

**Interfaces:**
- Consumes: `runbookAction`, `actionHash` (Part 1, Task 4); `canonicalize`, `sha256b64url` (Part 1, Task 1); a PhoneApprover-like approver (`unavailableReason()`, `requestAction(action, { origin, signal, currentAction })`) and an audit ledger (`append`); `PhoneApprover`, `FileCourier` (Task 15) and `approverStoreWith` in the test.
- Produces (spec §3.8): `new StdioMcpServer({ …, approver = null, auditLedger = null })`; `executeRunbook(name, rawParams, { signal, admitted, validatedParams })` runs `validatedParams` without validating again; `JobManager.transition(jobId, 'awaiting_approval', 'queued')` (throws `code: 'max_concurrent_jobs'` or `'bad_transition'`); `awaiting_approval` jobs get an `AbortController` at creation. Audit (writer is the ledger's, `mcp` in Part 3): `request.inbound { client: 'stdio-mcp', method: 'tools/call', name, params_sha256, job_id: null, origin }` for every `run_runbook` call, `exec.start` (awaited — failure fails the job `Audit ledger unavailable; nothing ran.`) and `exec.result` for every executed runbook.

Unsafe path: validate params (`invalid_params`); no approver → job `denied` with `denied_by_policy: unsafe runbooks need a phone approval and no device is enrolled on this node`; approver unavailable → `denied_by_policy: <unavailableReason()>`; else the job is created `awaiting_approval` and `{ job_id, status: 'awaiting_approval' }` returned at once. In the background the server asks with `origin { client: 'stdio-mcp', session: null, job_id }`, the job's signal, and a `currentAction` that re-validates the raw params (so a moved realpath changes the action) and keeps the result. Outcomes: `approve` → rate limit (`rate_limited` → `failed`), `transition` to `queued` (else `failed`), pre-run re-check of `actionHash(currentAction())` against `outcome.action_hash` (`action_changed` → `failed`), run exactly the last validated values; `deny` → `denied`; `expired` → `expired`; `withdrawn` → `cancelled`; `unavailable`/`error` → `denied` with the reason.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-stdio-approvals.test.js`:

```js
// tests/mcp-stdio-approvals.test.js
//
// Unsafe runbooks through the phone (spec §3.8). The server is driven through
// executeToolCall, the same entry point the stdio transport uses.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const StdioMcpServer = require('../src/mcp/stdio-server');
const { RunbookEngine } = require('../src/runbooks/runbook-engine');
const { actionHash } = require('../src/approvals/messages');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { FileCourier } = require('../src/approvals/courier');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mcp-approvals-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  for (const d of ['a', 'b']) fs.mkdirSync(path.join(root, d), { recursive: true });
  // A junction on Windows needs no privilege; elsewhere it is a plain symlink.
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  return { base, root };
}

// A real engine with runbooks set in memory (loading from disk needs a
// root-owned directory on POSIX). The step writes a marker into the target.
function engineFor(root, extra = {}) {
  const engine = new RunbookEngine({ runbooksDir: null, allowedRoots: [root] });
  const step = { run: [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1], 'ran')", '{{target}}/marker.txt'] };
  engine.runbooks.set('site.touch', { name: 'site.touch', description: '', tier: 'unsafe', params: { target: { type: 'path' } }, steps: [step], timeout_s: 30, rate_limit: null, ...extra });
  engine.runbooks.set('site.status', { name: 'site.status', description: '', tier: 'read', params: {}, steps: [{ run: [process.execPath, '-e', '0'] }], timeout_s: 30, rate_limit: null });
  return engine;
}

function recordingLedger() {
  const ledger = { entries: [], failKinds: new Set() };
  ledger.append = async (entry) => {
    if (ledger.failKinds.has(entry.kind)) throw new Error('audit_unavailable: disk full');
    ledger.entries.push(entry);
    return entry;
  };
  return ledger;
}

// An approver whose answer the test decides.
function scriptedApprover(decide) {
  const approver = {
    calls: [],
    unavailableReason: () => null,
    async requestAction(action, options) {
      approver.calls.push({ action, origin: options.origin });
      return decide({ action, ...options });
    }
  };
  return approver;
}

const approve = ({ action }) => ({ decision: 'approve', request_id: 'r-1', device_id: 'd-aaaaaaaaaaaaaaaa', action_hash: actionHash(action), reason: null });
const NODE = { name: 'web-01', profile: 'runbook', capabilities: [], policy: { max_concurrent_jobs: 2 } };

async function settle(server, jobId) {
  await (server.jobRuns.get(jobId) || Promise.resolve());
  return server.jobManager.getJob(jobId);
}

function server({ root, approver, auditLedger = recordingLedger(), engine = engineFor(root), nodeConfig = NODE }) {
  return new StdioMcpServer({ nodeConfig, runbookEngine: engine, approver, auditLedger });
}

describe('run_runbook with a phone approver', () => {
  it('waits in awaiting_approval, runs after approval with the job id in origin, and audits it', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    const approver = scriptedApprover(approve);
    const s = server({ root, approver, auditLedger: ledger });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.deepEqual(res, { job_id: res.job_id, status: 'awaiting_approval' });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(root, 'a', 'marker.txt'), 'utf8'), 'ran');
    assert.deepEqual(approver.calls[0].origin, { client: 'stdio-mcp', session: null, job_id: res.job_id });
    assert.deepEqual(approver.calls[0].action.steps[0].slice(-1), [`${path.join(root, 'a')}/marker.txt`]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ledger.entries.map((e) => e.kind), ['request.inbound', 'exec.start', 'exec.result']);
    assert.equal(ledger.entries[2].data.ok, true);
  });

  it('deny, expire and unavailable never run', async () => {
    for (const [decision, status] of [['deny', 'denied'], ['expired', 'expired'], ['unavailable', 'denied'], ['error', 'denied']]) {
      const { root } = sandbox();
      const s = server({ root, approver: scriptedApprover(() => ({ decision, request_id: null, device_id: null, action_hash: null, reason: 'test' })) });
      const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
      assert.equal((await settle(s, res.job_id)).status, status, decision);
      assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false, decision);
    }
  });

  it('cancel_job while awaiting withdraws the request and nothing runs', async () => {
    const { root } = sandbox();
    const approver = scriptedApprover(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ decision: 'withdrawn', request_id: 'r-1', device_id: null, action_hash: null, reason: null }));
    }));
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const cancelled = await s.executeToolCall('cancel_job', { job_id: res.job_id });
    assert.equal(cancelled.success, true);
    assert.equal((await settle(s, res.job_id)).status, 'cancelled');
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('a realpath swapped after approval is refused at the pre-run re-check', async () => {
    const { root } = sandbox();
    const link = path.join(root, 'link');
    const approver = scriptedApprover((opts) => {
      const outcome = approve(opts);
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(path.join(root, 'b'), link, process.platform === 'win32' ? 'junction' : 'dir');
      return outcome;
    });
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: link } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^action_changed/);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'b', 'marker.txt')), false);
  });

  it('runs the validated values without validating again', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    let executing = false;
    let validationsWhileExecuting = 0;
    const validate = engine.validateParameters.bind(engine);
    engine.validateParameters = (...args) => { if (executing) validationsWhileExecuting += 1; return validate(...args); };
    const execute = engine.executeRunbook.bind(engine);
    engine.executeRunbook = async (...args) => { executing = true; try { return await execute(...args); } finally { executing = false; } };
    const s = server({ root, approver: scriptedApprover(approve), engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.equal((await settle(s, res.job_id)).status, 'succeeded');
    assert.equal(validationsWhileExecuting, 0);
  });

  it('an approved job that finds no free slot at the transition fails', async () => {
    const { root } = sandbox();
    const s = server({ root, approver: scriptedApprover(approve), nodeConfig: { ...NODE, policy: { max_concurrent_jobs: 1 } } });
    s.jobManager.createJob({ machine: 'web-01', runbook: 'site.status', tier: 'read' });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^max_concurrent_jobs/);
  });

  it('fails closed when exec.start cannot be audited', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    ledger.failKinds.add('exec.start');
    const s = server({ root, approver: scriptedApprover(approve), auditLedger: ledger });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.deepEqual([job.status, job.result], ['failed', 'Audit ledger unavailable; nothing ran.']);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('audits request.inbound for every tier, including refusals', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    const s = server({ root, approver: scriptedApprover(approve), auditLedger: ledger });
    const read = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.status' });
    await settle(s, read.job_id);
    await assert.rejects(s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'nope' }));
    const unsafe = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    await settle(s, unsafe.job_id);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ledger.entries.filter((e) => e.kind === 'request.inbound').map((e) => e.data.name), ['site.status', 'nope', 'site.touch']);
    assert.ok(ledger.entries.every((e) => e.kind !== 'request.inbound' || e.data.client === 'stdio-mcp'));
  });

  it('unavailable immediately with the service-not-running reason', async () => {
    const { root, base } = sandbox();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir);
    const phone = createFakePhone();
    const store = await approverStoreWith([phone.approverRecord()]);
    cleanups.push(() => store.cleanup());
    const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link: new FileCourier({ dataDir }), auditLedger: recordingLedger() });
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.equal(res.status, 'denied');
    assert.equal(res.reason, 'denied_by_policy: the King Louie service is not running on this node');
  });
});
```

In `tests/mcp-stdio.test.js`, replace

```js
  it('denies an unsafe runbook by policy and runs nothing', async () => {
    const engine = fakeEngine({ 'server.reboot': { tier: 'unsafe' } });
    const server = new StdioMcpServer({ nodeConfig: NODE, runbookEngine: engine });
    const res = await server.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'server.reboot' });
    assert.equal(res.status, 'denied');
    assert.equal(res.reason, 'denied_by_policy: unsafe runbooks need phone approval, which is not available until stage 3');
```

with

```js
  it('denies an unsafe runbook by policy and runs nothing when no phone approver is configured', async () => {
    const engine = fakeEngine({ 'server.reboot': { tier: 'unsafe' } });
    const server = new StdioMcpServer({ nodeConfig: NODE, runbookEngine: engine });
    const res = await server.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'server.reboot' });
    assert.equal(res.status, 'denied');
    assert.equal(res.reason, 'denied_by_policy: unsafe runbooks need a phone approval and no device is enrolled on this node');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/mcp-stdio-approvals.test.js tests/mcp-stdio.test.js`
Expected: FAIL — `mcp-stdio-approvals` jobs come back `denied` with the stage 2 reason (`expected 'awaiting_approval'`), and the updated `mcp-stdio` test sees the old message.

- [ ] **Step 3: Implement**

In `src/runbooks/runbook-engine.js`, in `executeRunbook`, replace

```js
    const validatedParams = this.validateParameters(runbookName, rawParams);
```

with

```js
    // `validatedParams`: the caller already validated (and a phone approved)
    // exactly these values, paths realpath'd; running them as given means
    // nothing is re-resolved after the last check.
    const validatedParams = options.validatedParams || this.validateParameters(runbookName, rawParams);
```

In `JobManager.createJob`, replace

```js
    this.jobs.set(jobId, job);
    if (initialStatus === 'queued') this.controllers.set(jobId, new AbortController());
    return job;
  }
```

with

```js
    this.jobs.set(jobId, job);
    // A job waiting for a phone approval gets its controller now, so
    // cancel_job can withdraw the request.
    if (initialStatus === 'queued' || initialStatus === 'awaiting_approval') this.controllers.set(jobId, new AbortController());
    return job;
  }

  // The one non-terminal transition besides running: an approved job leaves
  // awaiting_approval for queued, and only if a slot is free.
  transition(jobId, from, to) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== from) {
      throw Object.assign(new Error(`job ${jobId} is not ${from}`), { code: 'bad_transition' });
    }
    if (!(from === 'awaiting_approval' && to === 'queued')) {
      throw Object.assign(new Error(`a job cannot move from ${from} to ${to}`), { code: 'bad_transition' });
    }
    if (this.activeJobCount() >= this.maxConcurrentJobs) {
      throw Object.assign(new Error(`max_concurrent_jobs: this node already has ${this.maxConcurrentJobs} job(s) running`), { code: 'max_concurrent_jobs' });
    }
    return this.updateJob(jobId, { status: 'queued' });
  }
```

In `src/mcp/stdio-server.js`, replace

```js
const { JobManager } = require('../runbooks/runbook-engine');
const { version: SERVER_VERSION } = require('../../package.json');
```

with

```js
const { JobManager } = require('../runbooks/runbook-engine');
const { runbookAction, actionHash } = require('../approvals/messages');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { version: SERVER_VERSION } = require('../../package.json');

function paramsSha256(params) {
  try {
    return sha256b64url(canonicalize(params === undefined || params === null ? {} : params));
  } catch {
    return null;
  }
}
```

Replace the `run_runbook` description line with:

```js
    description: 'Start a named runbook on a machine. Returns job_id right away; poll get_job for the outcome. An unsafe runbook waits in awaiting_approval until the owner approves it on an enrolled phone, and is denied when no phone can be asked.',
```

In the constructor, after

```js
    this.stdin = options.stdin || process.stdin;
    this.stdout = options.stdout || process.stdout;
```

add

```js
    // Fleet stage 3: a PhoneApprover (or null) for unsafe runbooks, and the
    // node's audit ledger (writer 'mcp').
    this.approver = options.approver || null;
    this.auditLedger = options.auditLedger || null;
```

Replace everything from the line `  // Everything that can be refused is checked before a job exists, so a` to the end of the file (the old `runRunbook`, `executeJob`, the class's closing brace and `module.exports`) with:

```js
  // Audit is best effort for the inbound record; exec.start is not (below).
  auditBestEffort(kind, data) {
    if (!this.auditLedger) return;
    Promise.resolve()
      .then(() => this.auditLedger.append({ kind, data }))
      .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
  }

  // Everything that can be refused is checked before a job exists, so a
  // refusal leaves nothing behind (§9); then the job starts in the
  // background and its id goes back at once (§8.2). An unsafe runbook waits
  // in awaiting_approval for a signed phone approval (fleet stage 3, §3.8).
  runRunbook(args) {
    const name = args.runbook;
    const params = args.params || {};
    const origin = { client: 'stdio-mcp', session: null, job_id: null };
    this.auditBestEffort('request.inbound', {
      client: 'stdio-mcp', method: 'tools/call', name: typeof name === 'string' ? name : null,
      params_sha256: paramsSha256(params), job_id: null, origin
    });
    this.assertThisMachine(args.machine, { required: true });
    const engine = this.runbookEngine;
    if (!engine) {
      throw new Error('Runbook engine not configured on this node');
    }
    const runbook = engine.getRunbook(name);
    if (!runbook) {
      throw new ToolError('runbook_not_found', `runbook_not_found: no runbook "${name}" on node ${this.nodeConfig.name}`);
    }

    let validated;
    try {
      validated = engine.validateParameters(name, params);
    } catch (err) {
      if (err.code === 'invalid_params') {
        throw new ToolError('invalid_params', `invalid_params: ${err.message}`);
      }
      throw err;
    }

    if (runbook.tier === 'unsafe') return this.startUnsafe(runbook, params, validated);

    // From the rate-limit check to recording this run there is no await, so
    // two requests read from one stdin chunk cannot both pass the check: the
    // second sees the first's entry and is refused here, rather than
    // becoming a job that fails later with rate_limited. The entry is taken
    // only once the job exists, so a max_concurrent_jobs refusal uses none.
    const rate = engine.checkRateLimit(name);
    if (rate && rate.allowed === false) {
      const retryAfter = rate.retryAfterSeconds;
      throw new ToolError(
        'rate_limited',
        `rate_limited: runbook "${name}" has reached its rate limit; retry after ${retryAfter}s`,
        { retry_after: retryAfter }
      );
    }

    let job;
    try {
      job = this.jobManager.createJob({ machine: this.nodeConfig.name, runbook: name, params, tier: runbook.tier });
    } catch (err) {
      if (err.code) throw new ToolError(err.code, err.message);
      throw err;
    }
    const reservation = engine.recordExecution(name);

    this.track(job.job_id, this.executeJob(job.job_id, name, params, reservation, { validatedParams: validated }));
    return { job_id: job.job_id, status: job.status };
  }

  track(jobId, promise) {
    const run = promise
      .catch((err) => log.error(`Job ${jobId} execution threw past its handler: ${err.message}`))
      .finally(() => this.jobRuns.delete(jobId));
    this.jobRuns.set(jobId, run);
  }

  startUnsafe(runbook, params, validated) {
    const approver = this.approver;
    const unavailable = !approver
      ? 'unsafe runbooks need a phone approval and no device is enrolled on this node'
      : approver.unavailableReason();
    if (unavailable) {
      const job = this.jobManager.createJob({
        machine: this.nodeConfig.name, runbook: runbook.name, params, tier: runbook.tier,
        status: 'denied', reason: `denied_by_policy: ${unavailable}`
      });
      return { job_id: job.job_id, status: job.status, reason: job.reason };
    }
    const job = this.jobManager.createJob({ machine: this.nodeConfig.name, runbook: runbook.name, params, tier: runbook.tier, status: 'awaiting_approval' });
    this.track(job.job_id, this.awaitApproval(job.job_id, runbook, params, validated));
    return { job_id: job.job_id, status: job.status };
  }

  // Never rejects: every path ends the job in a terminal status.
  async awaitApproval(jobId, runbook, params, validated) {
    const jobs = this.jobManager;
    const engine = this.runbookEngine;
    const name = runbook.name;
    const nodeName = this.nodeConfig.name;
    let lastValidated = validated;
    // Rebuilt from live state: validation re-runs (so a realpath that moved
    // changes the action) and the result is kept for the run.
    const currentAction = () => {
      lastValidated = engine.validateParameters(name, params);
      return runbookAction(engine.getRunbook(name), lastValidated, nodeName);
    };
    let outcome;
    try {
      outcome = await this.approver.requestAction(runbookAction(runbook, validated, nodeName), {
        origin: { client: 'stdio-mcp', session: null, job_id: jobId },
        signal: jobs.getSignal(jobId),
        currentAction
      });
    } catch (err) {
      outcome = { decision: 'error', reason: err.message };
    }

    if (jobs.isTerminal(jobId)) return; // cancel_job already decided it
    if (outcome.decision === 'deny') {
      jobs.updateJob(jobId, { status: 'denied', reason: `denied: ${outcome.reason || 'the phone denied it'}` });
      return;
    }
    if (outcome.decision === 'expired') {
      jobs.updateJob(jobId, { status: 'expired', reason: 'expired: no phone answered in time' });
      return;
    }
    if (outcome.decision === 'withdrawn') {
      jobs.updateJob(jobId, { status: 'cancelled' });
      return;
    }
    if (outcome.decision !== 'approve') {
      jobs.updateJob(jobId, { status: 'denied', reason: `denied_by_policy: ${outcome.reason || outcome.decision}` });
      return;
    }

    const rate = engine.checkRateLimit(name);
    if (rate && rate.allowed === false) {
      jobs.updateJob(jobId, { status: 'failed', result: `rate_limited: retry after ${rate.retryAfterSeconds}s` });
      return;
    }
    try {
      jobs.transition(jobId, 'awaiting_approval', 'queued');
    } catch (err) {
      jobs.updateJob(jobId, { status: 'failed', result: err.message });
      return;
    }
    const reservation = engine.recordExecution(name);
    // The pre-run re-check: the action about to run is still the approved one.
    let liveHash = null;
    try {
      liveHash = actionHash(currentAction());
    } catch {
      liveHash = null;
    }
    if (liveHash !== outcome.action_hash) {
      engine.releaseExecution(name, reservation);
      jobs.updateJob(jobId, { status: 'failed', result: 'action_changed: the runbook or its parameters changed after approval; nothing ran' });
      return;
    }
    await this.executeJob(jobId, name, params, reservation, { validatedParams: lastValidated, requestId: outcome.request_id });
  }

  // Never rejects: whatever the engine does, the job ends in a terminal
  // status, and a failure becomes that job's result instead of an unhandled
  // rejection that would take the process down.
  //
  // `reservation` is the rate-limit entry recorded for this job. The engine
  // is told the run was admitted so it does not count it again, and runs
  // exactly `validatedParams`.
  async executeJob(jobId, name, params, reservation, { validatedParams = null, requestId = null } = {}) {
    const jobs = this.jobManager;
    const engine = this.runbookEngine;
    const signal = jobs.getSignal(jobId);
    const origin = { client: 'stdio-mcp', session: null, job_id: jobId };
    // Yield first, so the caller has its job_id before any work starts.
    await Promise.resolve();
    if (jobs.isTerminal(jobId) || signal?.aborted) {
      // Cancelled while queued: nothing ran, so the run it was counted as
      // goes back to the rate limit.
      engine.releaseExecution(name, reservation);
      return;
    }
    if (this.auditLedger) {
      try {
        await this.auditLedger.append({ kind: 'exec.start', data: { kind: 'runbook', name, request_id: requestId, job_id: jobId, origin } });
      } catch (err) {
        engine.releaseExecution(name, reservation);
        jobs.updateJob(jobId, { status: 'failed', result: 'Audit ledger unavailable; nothing ran.' });
        return;
      }
    }
    jobs.updateJob(jobId, { status: 'running' });
    // The slot is held until the execution settles, not until the status
    // turns terminal: after cancel_job the step may still be exiting.
    jobs.markExecuting(jobId);
    let ok = false;
    let error = null;
    try {
      const res = await engine.executeRunbook(name, params, { signal, admitted: true, validatedParams });
      const logs = Array.isArray(res?.logs) ? res.logs : [];
      ok = Boolean(res?.success);
      error = ok ? null : (res?.error || 'runbook failed');
      // cancel_job already marked it cancelled; keep that, add what ran.
      if (jobs.isTerminal(jobId)) {
        jobs.updateJob(jobId, { logs });
      } else if (res?.success) {
        jobs.updateJob(jobId, { status: 'succeeded', logs });
      } else if (res?.error === 'cancelled') {
        jobs.updateJob(jobId, { status: 'cancelled', logs });
      } else {
        jobs.updateJob(jobId, { status: 'failed', logs, result: res?.error || 'runbook failed' });
      }
    } catch (err) {
      const result = err.code === 'rate_limited' && err.retryAfterSeconds !== undefined
        ? `rate_limited: retry after ${err.retryAfterSeconds}s`
        : err.message;
      error = result;
      log.warn(`Job ${jobId} (${name}) failed: ${err.message}`);
      if (!jobs.isTerminal(jobId)) jobs.updateJob(jobId, { status: 'failed', result });
    } finally {
      jobs.markSettled(jobId);
      this.auditBestEffort('exec.result', { kind: 'runbook', name, request_id: requestId, job_id: jobId, origin, ok, exit_status: null, error });
    }
  }
}

module.exports = StdioMcpServer;
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/mcp-stdio-approvals.test.js tests/mcp-stdio.test.js tests/runbooks.test.js tests/job-manager.test.js tests/service-cli-mcp-pair.test.js`
Expected: PASS, `fail 0` (9 tests in `mcp-stdio-approvals.test.js`), including the Review Focus cases "cancel_job while awaiting withdraws the request and nothing runs" and "unavailable immediately with the service-not-running reason".

- [ ] **Step 5: Commit**

```bash
git add src/runbooks/runbook-engine.js src/mcp/stdio-server.js tests/mcp-stdio.test.js tests/mcp-stdio-approvals.test.js
git commit -m "feat(mcp): unsafe runbooks wait for a phone approval and re-check before running

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 3

Before Part 3 starts, run `npm test` on the merged Part 2 and confirm `fail 0`. Part 3 relies on these exports, in addition to Part 1's:

| Module | Exports / behaviour |
|---|---|
| `tests/vectors/approval-v1/` | 38 committed vectors; `generate.js` (`buildVectors`, `serialize`, `loadSigCache`, `NOW`); `phone-reference.js` (`phoneView`, `buildDisplay`, `escapeText`, `isHidden`, `COLLAPSE_OVER`, `HEAD`, `TAIL`) |
| `docs/protocol/approval-v1.md` | the wire protocol (Part 4 builds the apps from it) |
| `src/core/origin.js` | `markLocalDesktopEvent`, `isLocalDesktopEvent`, `localDesktopDeviceId`, `markLocalRequester`, `isLocalRequester` |
| `src/execution/tool-executor.js` | options `classifyCall`, `localOrigin`; event `tierDecision`; `module.exports.mapApprovalResult` |
| `src/approvals/executor-options.js` | `approvalSeam`, `phoneExecutorOptions`, `paramsSha256`, `PHONE_GRACE_MS` |
| `src/core/create-core.js` | `remoteApprovals: 'phone'` with deps `phoneApprover`, `auditLedger`, `nodePolicy`; `context.getPhoneApprover()` |
| `src/mesh/mesh-transport.js` | option `listen: false` |
| `src/mesh/mesh-pairing.js` | `new MeshPairing(identity, transport, { timeoutMs })`, `addCode(code, meta)`, `generateCode(meta)`, `timeoutMs`; `name_mismatch`; `nodeId`/`nodeName`/`meta` on success |
| `src/approvals/link-rpc.js` | `createLinkRpc`, `LinkRpcError` |
| `src/approvals/relay-client.js` | `RelayClient`, `isReservedMethod`, `F3_METHODS`, `NODE_INBOUND`, `readFrontDoor` |
| `src/approvals/courier.js` | `FileCourier`, `CourierPump`, `CourierError`, `NOT_RUNNING` |
| `src/runbooks/runbook-engine.js` | `executeRunbook(…, { validatedParams })`; `JobManager.transition` |
| `src/mcp/stdio-server.js` | options `approver`, `auditLedger`; methods `startUnsafe`, `awaitApproval`, `executeJob(jobId, name, params, reservation, { validatedParams, requestId })`, `track`, `auditBestEffort` |
