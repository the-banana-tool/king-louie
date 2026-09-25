# Fleet Stage 3: Signed approvals, relay and mobile app — Design Spec

- **Status:** Draft (review fixes applied)
- **Date:** 2026-09-23
- **Parent:** docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md §6 (and §3.1, §4.2, §5.1, §9, §10, §11, §13)
- **Program:** docs/superpowers/specs/2026-09-23-stage-program.md (owns §4.12, §4.13, §4.15, §4.16, the phone branch of §4.21, `src/platform/jcs.js` (R17), `deriveDeviceId` (§4.17); bound by §3, §5, rulings 2, 3, 7, 8, R15, R16, R44, R49)
- **Depends on:** F2 (merged, PR #29)

## 1. Outcome

An unsafe action on a node (a tool call that would ask, matches `always_confirm` or leaves
`allowed_roots`, or an `unsafe` stdio runbook) no longer just fails. The node signs a request over the
exact action, a relay delivers it to the owner's phone, the owner approves or denies with biometrics,
and the node checks the signature before running it exactly once. Owners enroll, add and revoke
phones, see per-node history, and every node keeps a hash-chained audit ledger. The relay is the first
slice of the stage 4 front door and carries the hooks F4, F5 and C4 mount on.

## 2. Scope

### 2.1 In

- `src/platform/jcs.js`; `src/approvals/` (envelopes, messages, device-envelope verification,
  checks, `PhoneApprover`, read-only approver store, file courier); `src/audit/audit-ledger.js`.
- `remoteApprovals: 'phone'`, `core.context.getPhoneApprover()`, remote tiers (parent §5.3) in
  `ToolExecutor`, the phone side of the desktop seam (R49); unsafe stdio runbooks go to the phone.
- `src/frontdoor/` relay subset (§4.13): phone API with a route registry, node hub, mailbox,
  pluggable push, enrollment/revocation relay, extension list; `king-louie-service relay`.
- CLI modules `src/service/commands/pair.js`, `devices.js`, `relay.js`.
- `docs/protocol/approval-v1.md`, `tests/vectors/approval-v1/*.json`, fake-phone signer.
- `mobile/ios`, `mobile/android`, `mobile/PRIVACY.md`.

### 2.2 Out

| Item | Owner |
|---|---|
| 443/SNI, ACME, OAuth AS, MCP endpoint, router, audit mirror, mesh hardening (auth before parse, one connection per node key), `delegate` sessions, fleet-status and connected-clients screens, `profile: frontdoor` and its installer | F4 |
| Computer-use leases, `lease-v1`, lease routes and screens (mounted on F3's hooks) | F5 |
| Desktop approvals / relay status (read-only, Local service pane) | F7 |
| Mobile question channel: routes, link methods, push kind `question` (on F3's hooks) | C4 (R44) |

## 3. Design

Fixed here (not owner choices): TTL default 300 s; relay ports 8443 (phone) and 18795 (mesh);
monthly audit segments; no desktop UI in F3 (F7 shows approvals and relay status read-only).

### 3.1 Canonical form and signed envelopes — `src/platform/jcs.js`, `src/approvals/envelope.js`

`src/platform/jcs.js` implements RFC 8785 in pure JS (about 40 lines, no requires):
`canonicalize(value) → string` sorts object keys by UTF-16 code units, emits strings and numbers with
`JSON.stringify` (ECMAScript number serialization, which JCS specifies), and throws
`JcsError('non_canonical_value')` on `undefined`, functions, symbols, `BigInt`, non-finite numbers
and lone surrogates. `sha256b64url(string) → string`. C3, F4 and F5 import it from here (R17).

Every signed message travels as a **signed envelope**:

```json
{ "alg": "Ed25519", "kid": "kl-3v7q2m4k8d1x9c0a", "payload": "<b64url(JCS bytes)>", "sig": "<b64url>" }
```

The signer signs the JCS bytes and ships them base64url-encoded. **Verifiers check the signature
over the received bytes and never re-canonicalize to verify.** Node-side verifiers also require
`Buffer.from(canonicalize(JSON.parse(text))).equals(bytes)`, else `malformed` (kills duplicate keys
and parser differentials).

`envelope.js` exports: `seal(message, signer) → envelope` (`signer` = `{ alg, kid, sign(bytes) }`);
`open(envelope) → { message, bytes }` (parse + canonical check, throws `EnvelopeError(reason)`);
`verifyEd25519(envelope, spkiDerHex) → boolean`; `verifyEs256(envelope, jwk) → boolean`
(`crypto.verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, sig)`); `nodeSigner(identity)`;
`deriveDeviceId(rawPublicKey, prefix = 'd-') → prefix + base32(sha256(raw))[0..16]` (lowercase
RFC 4648, no padding; `raw` is the 65-byte uncompressed P-256 point for phones and the 32-byte
Ed25519 key for F7's desktops with prefix `kld-`); `deviceIdFromJwk(jwk) = deriveDeviceId(0x04‖x‖y)`;
`ed25519RawToSpki(raw32) → DER`; `fingerprintGroups(id) → 'abcd efgh ijkl mnop'`.
Nodes sign with their Ed25519 `NodeIdentity` key (keys travel as DER SPKI hex, §4.17); phones with
ECDSA P-256 / SHA-256, raw `r||s` (IEEE P1363). A device JWK has exactly `kty: 'EC'`, `crv: 'P-256'`,
`x`, `y` (32-byte b64url each); any other member (a `d`, say) is `malformed`.

### 3.2 Messages — `src/approvals/messages.js`, `src/execution/tool-patterns.js`

Builders and validators for every type in §4.3: `toolAction(toolName, params, cwd)`,
`runbookAction(runbook, validatedParams, nodeName)`, `envelopeAction({ executorId, caseId, envelopeHash, summary })`,
`actionHash(action) → b64url(SHA-256(JCS(action)))`, `buildRequest({ identity, action, origin, ttlMs, now })`,
`parseResponse(envelope)`, `buildStatus(...)`, `parseEnroll`, `parseRevoke`. `toolAction` clones
`params` through JCS (a non-JSON value fails `non_canonical` before anything is sent) and sets
`summary` to `formatToolPattern(toolName, params)` cut to 300 characters with `…`. An action whose
JCS form exceeds 256 KiB fails `action_too_large` (the phone must be able to show all of it).

`formatToolPattern`, `patternMatch`, `splitShellSegments`, `normalizeWhitespace`, `SHELL_SEPARATORS`
move into a dependency-free `src/execution/tool-patterns.js`, re-exported from `safety-policy.js`,
which requires `../tools` and so cannot load under the runbook profile (`service-profile-graph.test.js`).

### 3.3 Approver key store — `src/approvals/approver-store.js`, `approver-admin.js`

**The service only reads the approver set; only an admin-run CLI writes it**: fixed dir
`<configDir>/approvers/`, one `<device_id>.json` per device (§4.1), owned as the installers own
`<configDir>` (root `0755`/`0644` on POSIX; Administrators-full / `LOCAL SERVICE`-read on Windows).

`new ApproverStore({ dir, stagedDir, geteuid, adminUid = 0, platform, now, allowTestKeys = false })`:

| Method | Behaviour |
|---|---|
| `ready() → Promise<{ ok, problem? }>` | Startup probe. POSIX: `assertAdminOwned` on the dir. **Windows** (`assertAdminOwned` is a no-op on win32, R51): `open(<dir>/.probe-<rand>, 'wx')`; if that succeeds the file is deleted, the set is treated as **empty**, `log.error` names the ACL problem and `doctor` reports FAIL |
| `list() → record[]` | Re-stats the dir (1 s cache), re-reads changed files, `assertAdminOwned` per file on POSIX. A malformed or misnamed file, one whose `device_id` does not derive from its key, or (unless `allowTestKeys`) one whose key is in `src/approvals/test-keys.js` is **ignored and logged** |
| `get(deviceId) → record \| null` | The §4.1 record; the key is `record.public_key` |
| `isActive(deviceId, { overlay = true } = {}) → boolean` | Present, `platform !== 'demo'`, `revoked_at === null`, and (when `overlay`) not in the revocation overlay |
| `isAdminApplied(deviceId) → boolean` | `isActive(deviceId, { overlay: false })` |
| `activeCount() → number` | Active devices |
| `stage(envelope) → { state: 'staged' \| 'revoked-pending-apply' \| 'duplicate' \| 'rejected', reason? }` | Verifies a relayed `kl.device.enroll` / `kl.device.revoke` (§3.10), refuses one past its `expires_at`, validates `nonce` against `^[A-Za-z0-9_-]{43}$` before using it as a file name, writes `<dataDir>/approvals/staged/<nonce>.json`. A nonce already in `staged/` or `staged/done/` → `duplicate`. A verified revoke also joins the **revocation overlay** at once |

The overlay is rebuilt at startup from staged revokes and only removes trust. **Revoker rule:** a
revoke is valid when its signer `isAdminApplied` (overlay ignored) and `revoked_by ≠ device_id`, so
mutual revokes (thief and owner) remove both keys and the owner recovers at a console. Enrolls are
checked against the admin set **and** the overlay.

`approver-admin.js` (CLI only): `writeApprover(record)`, `markRevoked(deviceId, by)`,
`applyStaged({ now, confirm }) → [{ file, result }]`; each exits `Run this as root/Administrator: <dir> is not writable.`
when it cannot write. `applyStaged` lists the staged items (type, device, signer, age), asks
`Apply these? [y/N]` (`--yes` skips), re-verifies each against the admin set **as it stood before the
batch** (revokes first), refuses items older than 7 days, never re-activates a revoked `device_id`,
and moves each file to `staged/done/`.

The service cannot write the set because whoever adds a key approves anything; the price is one
admin `device apply` per node for a remote enrollment (R15).

### 3.4 Device-envelope verification — `src/approvals/verify-device.js`

One function checks every phone-signed envelope on a node (approval responses here, `kl.lease.*` in
F5, `kl.question.answer` in C4):

```js
verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces = null, overlay = true })
  → { ok: true, message, bytes, deviceId } | { ok: false, reason }
```

`nonces` is a `NonceCache` (`new NonceCache({ max = 10000, ttlMs = 600000 })`; `get(nonce) →
{ sha256 } | null`; `add(nonce, sha256)`), in memory. Steps run in this order; the first failure
decides `reason`, and the vectors pin it:

| # | Parent check | Check | `reason` |
|---|---|---|---|
| 1 | — | Envelope opens, bytes canonical, `v === 1`, `type` as expected, every field well formed | `malformed` / `unsupported_version` |
| 2 | — | `alg === 'ES256'`, `kid === message.device_id` | `malformed` |
| 3 | 1 | `approverStore.get(kid)` exists | `unknown_device` |
| 4 | 1 | `platform !== 'demo'`; key not a test key (unless `allowTestKeys`) | `demo_device` / `test_key` |
| 5 | 1 | `approverStore.isActive(kid, { overlay })` | `revoked_device` |
| 6 | 1 | `verifyEs256(envelope, approverStore.get(kid).public_key)` | `bad_signature` |
| 7 | 2 | `message.node_id === nodeId` | `wrong_node` |
| 8 | 5 | `nonces?.get(message.nonce)`: same `sha256(bytes)` → `replay`, else `already_decided` | `replay` / `already_decided` |

Callers `nonces.add` only after acting. Timestamps are not judged here; callers judge expiry on the node clock.

### 3.5 Pending requests and the approval checks — `src/approvals/pending-store.js`

`PendingRequests({ now })`: `add({ request, bytes, currentAction, resolve })`, `get`, `take`,
`expire(now) → removed[]`, plus one `NonceCache`. Pending requests die with the process (a restart
fails the job, parent §9), so a response replayed after a restart gets `unknown_request`.

`PhoneApprover.handleResponse(envelope)` runs `verifyDeviceEnvelope(envelope, { type: 'kl.approval.response', … })`
(steps 1–8), then:

| # | Parent check | Check | `reason` |
|---|---|---|---|
| 9 | 2 | Request is pending | `unknown_request` |
| 10 | 2 | `nonce`, `action_hash`, `expires_at` equal the pending request's | `nonce_mismatch` / `action_hash_mismatch` / `expires_mismatch` |
| 11 | 4 | Node clock `now <= expires_at` | `expired` |
| 12 | 3 | `actionHash(currentAction())` equals `action_hash` | `action_changed` |
| 13 | — | `await auditLedger.append({ kind: 'approval.response', … })` | `audit_unavailable` |

A pass takes the request, marks the nonce, sends a signed `kl.approval.status` and resolves the
waiter. Step 12 failing consumes the request and marks the nonce (`deny`, `action_changed`); step 13
failing leaves both untouched so the phone may retry. Other rejections are audited (`approval.rejected`,
best effort) and leave the request pending. `signed_at` is recorded, never judged.

### 3.6 `PhoneApprover` — `src/approvals/phone-approver.js` (program §4.12)

```js
new PhoneApprover({ identity, nodeName, approverStore, link, auditLedger, ttlMs = 300000, now = Date.now })
isAvailable() → boolean      // link.canDeliver().ok && approverStore.activeCount() > 0
requestAction(action, { origin, signal, currentAction }) → Promise<Outcome>
requestApproval(toolName, parameters, metadata) → Promise<true | false | 'timeout' | 'unavailable'>
handleResponse(envelope) → Promise<{ accepted: boolean, reason: string | null }>
pending() → [{ request_id, expires_at, summary }]
stop()
// Outcome = { decision: 'approve'|'deny'|'expired'|'withdrawn'|'unavailable'|'error',
//             request_id, device_id, action_hash, reason }   (strings or null)
```

- `currentAction` is **required** (`TypeError('currentAction required')`) and must rebuild the action
  from live state, not return the object it was given.
- `requestAction` returns `unavailable` at once when `!isAvailable()` (`reason` = `canDeliver().reason`),
  and `{ decision: 'error', reason: 'non_canonical' | 'action_too_large' | 'audit_unavailable' }` when
  building or auditing the request fails. Otherwise it signs the request (TTL clamped to 30–300 s),
  audits `approval.request`, adds it to pending and calls `link.submit`. While the link is **down** the
  request stays pending and is resubmitted on `connected` if unexpired (R16). At `expires_at`: audit
  `approval.outcome{expired}`, status, `expired`. On `signal` abort: `withdrawn` (status `withdrawn`).
- **Callers that run later re-check** `actionHash(currentAction()) === outcome.action_hash` right
  before execution, else `action_changed` (runbooks §3.8; C3 rebuilds `envelopeAction(...)` from the live envelope).
- `requestApproval` is the ToolExecutor requester: action = `toolAction(toolName, parameters,
  metadata.workingDirectory)`, `currentAction` = the same call on the live `parameters`. It returns
  only program §3 values: `approve → true`, `deny`/`withdrawn → false` (§3.7 reads `signal.aborted`),
  `expired → 'timeout'`, `unavailable`/`error → 'unavailable'` after setting `metadata.refusal = { deniedBy, error }`.
- `core.context.getPhoneApprover()` returns this object when `remoteApprovals === 'phone'` and
  `isAvailable()`, else `null`. **In the Electron host (`remoteApprovals: 'allow'`) it is always
  `null`.** C3 calls `requestAction(envelopeAction({ executorId, caseId, envelopeHash, summary }), { origin, signal, currentAction })`
  and refuses `signed approval unavailable` on `null`.

### 3.7 Core and ToolExecutor wiring — `src/approvals/executor-options.js`

`'phone'` requires `deps.phoneApprover` (`createCore: remoteApprovals 'phone' needs deps.phoneApprover`)
and takes `deps.auditLedger`, `deps.nodePolicy`. `createToolExecutorWithApprovals(event, …, executorOptions)`
applies the program §4.21 seam (F7 owns `src/core/origin.js`; whichever merges second rebases):

```js
const local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester);
const requester = remoteApprovals === 'allow' ? approvalRequester
                : local ? (isLocalRequester(approvalRequester) ? approvalRequester : null)  // null → on-screen dialog
                : remoteApprovals === 'phone' ? phoneRequester : null;
denyAutoApproval: (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true
```

**Children inherit the mark (F3's decision under R49).** Sub-agents are built with
`event = null` and the parent's re-threaded requester (`agentExecutorAdapter.execute` →
`createAgentRuntime(…, null, options.approvalRequester)`, `create-core.js:2296`). So the
executor built for a local run gets `localOrigin: true`, and `ToolExecutor` marks the
per-call requester closure it hands to tools with `markLocalRequester(fn)` (F7's
`src/core/origin.js`). A child whose requester is marked is local: it keeps that requester,
so its prompts reach the parent's on-screen dialog, and never the phone.

In phone mode it also merges `phoneExecutorOptions({ phoneApprover, auditLedger, nodePolicy, origin, local })`:

| Option | Value |
|---|---|
| `approvalRequester` | not local: `(t, p, m) => phoneApprover.requestApproval(t, p, { ...m, origin })` when available, else a requester returning `'unavailable'`. Local: as the seam above (R49) |
| `localOrigin` | `local` (ToolExecutor marks its re-threaded requesters) |
| `approvalTimeoutMs` | not local: `ttlMs + 15000`, so the phone's own expiry resolves first. Local: the default |
| `classifyCall` | `(t, p, { cwd }) => classifyToolCall(t, p, nodePolicy, { cwd })`, for local runs too |
| listeners | `tierDecision` → `tier.decision`; `preExecute` → `exec.start`; `postExecute` → `exec.result` |

`origin` = `executorOptions.origin || { client: 'king-louie', session: executorOptions.chatId || null, job_id: null }`;
for a local run `{ client: 'desktop', deviceId: localDesktopDeviceId(event), session, job_id: null }` (F7; a child reuses its parent's).

Additive `ToolExecutor` changes (`src/execution/tool-executor.js`):

1. `classifyCall(toolName, params, { cwd }) → { tier, reason } | null`, called after permission rules
   and before the gate. `denied` → `{ success: false, error: 'Denied by node policy.', deniedBy: 'policy' }`.
   `unsafe` sets `needsApprovalGate = true` **and cancels `ruleSaysAllow`** (so `allow Bash(git *)`
   cannot skip the gate for `always_confirm Bash(git push*)`) and skips auto-approval as an `ask`
   rule does. The result is emitted as `tierDecision`.
2. Option `localOrigin` (default `false`): when true, the re-threaded `approvalRequester` closure
   (`:402`) is passed through `markLocalRequester` before tools receive it.
3. Both `requestApproval` call sites (hook `confirm` at `:182`, gate at `:321`) pass metadata
   `signal: options.signal || null` and `workingDirectory: options.workingDirectory || this.workingDirectory`.
4. Both call sites map the result through one `mapApprovalResult(result, metadata)`. **Only
   `result === true` runs.** Today the hook site tests `!approved` and the gate reaches `recordGrant`
   for any truthy value but `'timeout'`, so `'timeout'` and `'unavailable'` would run the tool.

| Result | Returned | Denial tracker |
|---|---|---|
| `true` | runs | `recordGrant` |
| `false`, `signal.aborted` | `Approval withdrawn: the call was cancelled.`, `deniedBy: 'withdrawn'` | none |
| `false` | `User denied permission`, `deniedBy: 'user'` | `recordDenial` |
| `'timeout'` | existing timeout error, `deniedBy: 'timeout'` | none |
| `'unavailable'` | `metadata.refusal` when set (`Audit ledger unavailable; nothing ran.` / `Action cannot be shown on the phone (<reason>); nothing ran.`), else `Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.`; `deniedBy` from the refusal or `'unavailable'` | none |
| anything else | `Approval failed: unexpected requester result.`, `deniedBy: 'requester'` | none |

`classifyToolCall` gains an optional 4th argument `{ cwd }`, and `extractPathsFromParameters` also
reads `file_path` and every `edits[].file_path`, resolving relative paths against `cwd` (§11.13).
A hook `confirm` rule on an `unsafe` call makes two phone requests, each with its reason (§12).

### 3.8 Runbooks through the phone — `src/mcp/stdio-server.js`, `src/runbooks/runbook-engine.js`

`StdioMcpServer` gains the options `approver` (a `PhoneApprover` or `null`) and `auditLedger`. Every
`run_runbook` call, whatever its tier, is audited `request.inbound`; the process that runs a runbook
(the `mcp` process here, `writer: 'mcp'`) writes its `exec.start` and `exec.result`. For `tier: unsafe`:

1. Validate params (`invalid_params` as today). `approver` null or `!isAvailable()` → the job is
   created `denied` with reason `denied_by_policy: unsafe runbooks need a phone approval and no device is enrolled on this node`.
2. Create the job `awaiting_approval` and return `{ job_id, status: 'awaiting_approval' }`.
3. In the background: `requestAction(runbookAction(name, validated, nodeName), { origin: { client: 'stdio-mcp', session: null, job_id }, signal: <job controller signal>, currentAction })`,
   where `currentAction` re-runs `validateParameters(name, rawParams)`, keeps the result in
   `lastValidated`, and rebuilds the action. A realpath that moved after the request fails check 12.
4. `approve` → admit the rate limit (`rate_limited` → `failed`), then at `awaiting_approval → queued → running`
   re-run `currentAction()` and compare with `outcome.action_hash` (`action_changed` → `failed`), and
   run `executeRunbook(name, rawParams, { signal, admitted: true, validatedParams: lastValidated })`.
   `deny` → `denied`; `expired` → `expired`; `unavailable`/`error` → `denied` with the reason;
   `withdrawn` (from `cancel_job`) → `cancelled`.

`executeRunbook` option `validatedParams` skips `validateParameters` and runs exactly those values
(already realpath'd), so nothing is re-resolved after the last check. `JobManager`: `awaiting_approval`
jobs get an `AbortController`; `awaiting_approval → queued` is allowed and enforces
`max_concurrent_jobs` (else `failed`). `action.steps` holds every `run` argv and `check`, substituted
(parent §8.4).

### 3.9 Courier for out-of-process producers — `src/approvals/courier.js`

`mcp` and the admin CLI cannot open a second link with the node's key (`MeshTransport` keys
connections by peer id), so they use a **file courier** through the running service. The producer
still builds, signs and verifies its own messages.

- `FileCourier({ dataDir, identity })` (producer) implements the link interface (§3.11) except
  `registerMethod`. `canDeliver()` is `{ ok: false, reason: 'the King Louie service is not running on this node' }`
  when the pidfile's process is dead. Calls write `<dataDir>/approvals/outbox/<ts>-<rand>.json` (temp +
  rename, `{ method, params, reply_to }`); replies arrive in `<dataDir>/approvals/inbox/p-<pid>-<rand>/`
  (250 ms poll); `call(..., { timeoutMs = 10000 })` waits for one (E6). CLI files are chowned back.
- `CourierPump({ dataDir, relayClient, identity, rpcHandler = null })` (service) polls the outbox
  every 250 ms and **verifies before forwarding**: `approval.submit|status`, `message.submit`,
  `enroll.open|done` must carry an envelope signed by this node's key, and `enroll.done` only for an
  unexpired `code_id` whose `enroll.open` it forwarded; anything else is dropped and logged. Replies
  for recorded `request_id | code_id` go to that inbox; non-relay methods go to `rpcHandler` (F4, R24);
  dead-pid inboxes are removed.
- `<dataDir>/approvals/link.json` (written by the service) is
  `{ connected, since, relay_id, relay_public_url, relay_spki }`. `enroll-device` reads it.

The protection is the signatures each acting process checks, **not** the data-dir ACL (on Windows
every `LOCAL SERVICE` process can write the data dir).

### 3.10 Enrollment and revocation

**Console enrollment (any device, any time)** — `king-louie-service enroll-device [--data-dir DIR]`, as admin:

1. It refuses unless `<configDir>/approvers/` is writable, the service runs, `approvers.relay` is set
   and `link.json` says `connected`.
2. It makes `code_id` (16 random bytes) and `code` (32), sends a node-signed `kl.enroll.open` (10 min)
   through the courier, and prints the pairing QR (§4.4), its text form and the relay fingerprint from `pair`.
3. The phone scans it, pins the relay SPKI and node key, makes its key if needed, shows the relay
   fingerprint for comparison, and posts a self-signed `kl.device.enroll` (`enrolled_by: null`,
   `code_id`, `code_mac = HMAC-SHA256(code, JCS(message without code_mac))`). The relay never sees `code`.
4. The CLI verifies signature, `code_mac`, expiry and `device_id` derivation, then asks
   `Device "Pixel 9" (android) d-abcd efgh ijkl mnop — does the phone show the same? [y/N]`.
5. `y` writes `<device_id>.json` (`enrolled_by: "console"`), audits `device.enrolled` and sends
   `kl.enroll.done { code_id, enroll }`; anything else (or 10 minutes) sends `refused: true`.

**Signed enrollment of a later device (parent §6.4):** phone A creates an invite and shows the
invite QR (§4.4) with the relay pin and A's node pins. Phone B scans it, makes its key and claims the
invite with `mac = HMAC-SHA256(secret, JCS(device))`. A verifies the claim, both screens show B's
grouped `device_id`, the owner confirms on A, and A signs `kl.device.enroll { device: B, enrolled_by: A }`.
The relay registers B, **appends the envelope to its device log** and sends it to every node, which
`stage()`s it. After an admin `device apply` the node sends `device.state { device_id, state: 'active' }`.

**Revocation:** `kl.device.revoke` signed by a *different* device that `isAdminApplied` (§3.3) is
relayed, logged, staged and acts at once through the overlay; `device apply` makes it permanent;
`device revoke <device_id>` (admin) writes `revoked_at` directly. Pending requests are covered (step 5).

**Offline nodes.** The relay keeps every enroll/revoke it relayed in `<relayData>/relay/device-log.jsonl`
and replays the log after each `relay.hello`; nodes answer `duplicate` for known nonces (withholding: §8).

### 3.11 Node → relay link — `src/approvals/relay-client.js`, `service-wiring.js`

`RelayClient({ identity, nodeName, relayPin, configDir, store, transportFactory })` wraps a
`MeshTransport` with the new option `listen: false` (nodes never listen, principle 4) and dials the
relay pinned by `pair`, or `<configDir>/front-door.json` via `connectPinned` when both exist (F4, E7).
On `peerConnected`: `relay.hello`, `relay.welcome`, `link.json`, `connected`. **Link interface**
(`FileCourier` implements it too):

```js
submit(requestEnvelope) → Promise<void>                    // approval.submit
status(statusEnvelope) → Promise<void>                     // approval.status
send(envelope, { push?: { kind, id, expires_at? }, to_device?: string }) → Promise<{ ok }>   // message.submit (F5, C4)
call(method, params, { timeoutMs = 10000 }) → Promise<result>
notify(method, params) → void                              // fire and forget (E5)
onMessage(handler(method, params) → result)                // F3's relay → node methods
registerMethod(name, handler(params, { peer }) → result)   // RelayClient only (E5)
isConnected() → boolean
canDeliver() → { ok: true } | { ok: false, reason }
on('connected' | 'disconnected', fn)
```

`registerMethod` refuses `mesh.task.*`, `mesh.channel.*` and F3's own names (§4.6): `method_reserved`.
`canDeliver` is `ok` once configured and paired, even while disconnected (R16). F3 answers
`approval.response`, `device.enroll|revoke` (`approverStore.stage`), `audit.slice|head` (§3.13).

`startApprovals({ dataDir, configDir, nodeConfig, ports, profile })` builds the audit ledger,
`ApproverStore` (awaiting `ready()`), `RelayClient` (when `approvers.relay` or `front-door.json` is set
and the relay is paired), `CourierPump` and `PhoneApprover`, and returns
`{ phoneApprover, auditLedger, relayClient, approverStore, identity, stop }`. It runs under both the
`agent` and `runbook` profiles and requires nothing from the agent stack.

`pair wss://host:port` (`commands/pair.js`; `https://` is F4's flow, R22) reads the one-time code
from stdin, runs `MeshPairing.acceptCode`, stores `approvals.relay` `{ relay_id (the relay's nodeId),
publicKey, tlsFingerprint, address, port, pairedAt }` and prints the relay fingerprint, which the
owner compares with the one `relay run` logs and `relay qr` prints. It still refuses while the service runs.

### 3.12 Relay — `src/frontdoor/` (program §4.13)

`relay run [--data-dir DIR]` calls `startRelay({ dataDir, config, identity, listeners = 'own',
registry = null, extensions = RELAY_EXTENSIONS })` (`src/frontdoor/relay.js`; `config` normalized, §6;
no core, providers, tools or agent code; its own `NodeIdentity`). It returns `{ stop, address(),
phoneApi, phoneApiHandler, nodeHub, mailbox, pusher, devices }` (E1); `'external'` binds nothing.

| Module | API | Responsibility |
|---|---|---|
| `node-hub.js` | `new NodeHub({ identity, transport, pairing, registryFile, peerSource = null })`; `nodes() → [{ node_id, node_name, public_key, online }]`; `addCode(nodeName) → { code, expires_at }`; `remove(nodeName)`; `rpc(nodeId, method, params, { timeoutMs = 10000 }) → result`; `onNodeMessage(method, handler(params, { nodeId }) → result)`; `onConnection(fn({ nodeId, connected }))` | `MeshTransport` on `relay.mesh_listen` plus `MeshPairing` (new additive options `timeoutMs`, `addCode(code, { nodeName })`). Registry `<relayData>/relay/nodes.json` (`node_id`, `node_name`, `public_key`, `paired_at`), unique by name (`name_taken`); refuses a pairing whose `nodeName` differs from the code's (`name_mismatch`). `peerSource` (F4, E3) replaces the file |
| `phone-api.js` | `createPhoneApi({ devices, rateLimits, now }) → { registerRoute(method, pathPattern, { auth, rate?, handler }), handler(req, res) }` | The route registry (E2). `pathPattern` uses `{name}` segments under `/v1/`. A later registration of the same method + pattern replaces the earlier (E8). `handler(req, ctx) → { status, body }` with `ctx = { deviceId, params, query, body, relay }`. 256 KiB body cap, auth (§4.5), rate limits. F3's own routes register through it |
| `mailbox.js` | `new Mailbox({ now })`; `registerType(prefix, { ttlMs, maxBytes = 262144 })`; `put(nodeId, envelope, { to_device })` → `{ seq }`; `list({ nodeIds, typePrefix, toDevice, afterSeq = 0 })`; `wait(filter, { timeoutMs ≤ 25000 })` | In-memory store for node-signed messages sent with `link.send` (F5 leases, C4 questions); ≤ 1000 per node, dropped at `ttlMs` |
| `device-registry.js` | `new DeviceRegistry({ file })`; `get(id)`, `list()`, `register({ device_id, jwk, name, platform })`, `setPush(id, { platform, token })`, `setNodeState(id, nodeId, state)`, `devicesForNode(nodeId)`, `remove(id)`, `appendLog(envelope)`, `log() → envelope[]` | `<relayData>/relay/devices.json` and `device-log.jsonl`. Used **only** to authenticate API calls, address push and replay enroll/revoke; nodes never trust it |
| `approval-cache.js` | `new ApprovalCache({ now })`; `put(nodeId, envelope)`, `get(requestId) → { node_id, envelope, expires_at, status } \| null`, `setStatus(requestId, statusEnvelope)`, `list(nodeIds)`, `sweep()` | Signed requests until `expires_at` plus their last status; empty after a restart (nodes resubmit) |
| `invites.js` | `new Invites({ now })`; `openCode(codeId, nodeId, expiresAt)`, `getCode(codeId)`, `closeCode(codeId, state)`, `createInvite(deviceId) → { invite_id, expires_at }`, `claim(inviteId, { device, mac })`, `getClaim(inviteId, deviceId)` | Console codes and single-use invites, 10 min each |
| `push/index.js` | `createPusher(config, { senders = defaultSenders(config) }) → { notify(device, { kind = 'approval', id, node_name?, expires_at? }) → Promise<void>, senders: string[] }` | Picks the `PushSender` whose `platforms` include `device.push.platform`; a device with no push, or no matching sender, gets the `none` sender. Failures are logged and never block anything |
| `push/none.js`, `apns.js`, `fcm.js` | `PushSender = { id, platforms: string[], notify(device, payload) → Promise<{ ok, dropToken? }> }` | `none` (default, no-op). `apns`: `http2` to `api.push.apple.com` (or sandbox), ES256 JWT `{alg,kid}`/`{iss: team_id, iat}` signed with the `.p8` key (P1363), cached 50 min; headers `apns-topic`, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration`, `apns-collapse-id: <id>`; 410 → drop token. `fcm`: RS256 JWT for `https://oauth2.googleapis.com/token` (scope `firebase.messaging`), token cached to `exp − 60 s`; data-only message, `android.priority: HIGH`, `ttl` = seconds left; 404 `UNREGISTERED` → drop token |
| `extensions.js` | `module.exports = [ /* (relay) => void */ ]` | One line per consumer (F5 lease routes, C4 question routes). Each gets `{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }` and must not require agent code |

Push carries only `{ kind, id }` (node name in the alert text): APNs `{"aps":{"alert":…},"kl":{"rid":id,"k":kind}}`,
FCM `{ rid, n, k }`; kinds `approval` (F3), `grant`/`pairing`/`alert` (F4), `question` (C4), `lease` (F5); missing `k` = `approval`.

**No-push mode** (`none`, the default until Q-A): in the foreground the app long-polls
`GET /v1/approvals?wait=25` (and consumers' list routes) and raises local notifications; in the
background nothing arrives and unseen requests expire closed. Android has `fcm` and `nopush` build
flavors; iOS registers for APNs only when the build config names a topic.

**Exposure until F4 (ruling 8).** `MeshTransport` parses the first frame before authenticating, so
`relay run` refuses a `mesh_listen.host` that is not an IP literal, is a wildcard (`0.0.0.0`, `::`), or
is outside loopback, RFC 1918, CGNAT, link-local or ULA: `relay.mesh_listen.host must be a loopback or
private IP address until the stage 4 mesh hardening lands`. The phone API may bind publicly.

`relay code <node-name>` drops a one-time pairing code into `<relayData>/relay/codes/` and prints
it (first node; later, `POST /v1/pairing-codes`); `relay nodes`, `relay remove-node <name>`;
`relay qr` prints a re-pin QR (§4.4) after a certificate key change.

### 3.13 Audit ledger — `src/audit/audit-ledger.js` (program §4.16)

```js
new AuditLedger({ dir, nodeId, identity, writer, now, retentionDays = 365 })
append({ kind, data }) → Promise<entry>        // job_id, when any, goes inside data
verify() → { ok, entries, brokenAt?: seq, reason? }
tail(n) → entry[]
entriesAfter(hash | null, limit) → entry[]     // null = from the oldest retained entry
slice({ before_seq?, after?, limit = 200, max_bytes = 524288 }) → envelope   // node-signed kl.audit.slice
head() → envelope                              // node-signed kl.audit.slice.head
prune(now) → { removedSegments }
```

- Files `<dataDir>/audit/ledger-YYYY-MM.jsonl`, one entry per line (§4.7). `hash` is hex SHA-256 over
  JCS(entry without `hash`); `prev` is the previous entry's `hash` (`null` for the first ever).
- Service, `mcp` and CLI all append: `append` takes `<dir>/ledger.lock` (`open 'wx'` with the pid; a
  dead-pid or > 10 s lock is broken by `rename`, then retried; up to 2 s), re-reads the last line for
  `seq`/`prev`, appends, `fsync`s, unlocks. Failure rejects, and an approved action fails closed.
  CLI-created segments are chowned with `restoreDataDirOwnership`.
- Retention: whole segments older than `retentionDays` are pruned at startup and every 24 h.
  `verify()` trusts the oldest remaining entry's `prev` as the anchor; slices carry the anchor so
  F4's mirror can tell a prune gap from a fork.
- `slice` returns ≤ `limit` (≤ 200) entries under `max_bytes`, at least one (E9): before `before_seq`
  (phone history) or after the `after` hash (mirror); served as `audit.slice`, `head()` as `audit.head`.

Kinds are listed in §4.7; F5 reserves `gui.*` and `lease.*`. The node's chain is tamper-evident only
once F4's mirror holds a copy. `src/events/event-ledger.js` is unchanged (ruling 7).

### 3.14 Mobile apps — `mobile/ios`, `mobile/android`

Both apps are built only from `docs/protocol/approval-v1.md` and must pass `tests/vectors/approval-v1`.

| | iOS (`mobile/ios`, Swift/SwiftUI, iOS 17+) | Android (`mobile/android`, Kotlin/Compose, minSdk 33) |
|---|---|---|
| Device key | `SecureEnclave.P256.Signing.PrivateKey` with `SecAccessControl` `[.privateKeyUsage, .biometryCurrentSet]`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; `dataRepresentation` in Keychain; `signature.rawRepresentation` | Keystore EC `secp256r1`, `setUserAuthenticationRequired(true)`, `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`, `setInvalidatedByBiometricEnrollment(true)`, `setIsStrongBoxBacked(true)` with TEE fallback; sign through `BiometricPrompt` + `CryptoObject`; DER → P1363 |
| Node signature check | `Curve25519.Signing.PublicKey(rawRepresentation:)` from the SPKI's last 32 bytes | `java.security.Signature("Ed25519")` with the SPKI |
| Relay TLS | `URLSessionDelegate` pins SHA-256 of the leaf's DER SPKI; CA trust ignored | custom `X509TrustManager` doing the same |
| QR | AVFoundation `.qr` | CameraX + ZXing core |
| Delivery | APNs alert "Approval needed on \<node\>" when configured; otherwise foreground long-poll | `fcm` flavor: FCM data message, generic local notification; `nopush` flavor: foreground long-poll |

Screens: **Welcome** ("Scan pairing code" / "Try demo"; no default relay); **Pending approvals**
(node, summary, origin client, time left); **Approval detail**; **History** (per node, verified
`kl.audit.slice`, "as of" its `created_at`); **Nodes** (pins, fingerprints, online, "Pairing code for
a new node"); **Devices** (this phone as `d-abcd efgh ijkl mnop`, others per node, "Add a device",
"Revoke"); **Settings** (relay pin, re-pin via `kl.relay` QR, leave demo, reset).

**Approval detail** (UI tests plus the `request-display` vector): node name and `node_id`; every
param; `command`-like strings (`command`, `script`, `argv`, runbook `steps`) in full, or head + tail
with "N characters hidden — Show all"; control, bidi and invisible characters (C0/C1, U+200B–U+200F,
U+202A–U+202E, U+2066–U+2069, U+FEFF) shown as escapes such as `‹U+202E›`; numbers as their JSON
text; `cwd`, origin, time left; **Approve** / **Deny** (both biometric-signed); then the node-signed
status (`approved`, `denied`, `refused: <reason>`, `already decided by <device>`).

Rules the apps implement:

- A request whose node signature fails against the pinned key, or whose `node_id` is not pinned, is
  **not shown**. Node keys are pinned only from a pairing or invite QR, never from `GET /v1/nodes`;
  a changed node key shows "Node key changed — pair again".
- Time left counts from receipt (`expires_in_ms`, monotonic clock); the wall clock is used only for
  `signed_at` and API timestamps. The app refuses to sign at zero.
- Push carries only `{ kind, id }`; on a tap the app fetches and verifies the envelope.
- A changed biometric set invalidates the key: "This phone's key is no longer usable. Enroll it
  again from a node console or another phone."
- **Demo mode**: a `DemoFleet` (`gpu-box`, `laptop`, `web-01`) with in-app node keys and a software
  key under a **Demo** banner; the network client is never constructed (unit-tested). Leaving demo
  deletes the demo key; the hardware key is made at the first real pairing (parent §13).
- No analytics. The app stores the relay pin, node pins, its key reference, push token and cached
  history; `mobile/PRIVACY.md` says so and what the relay operator sees (§11.12).
- Bundle id, APNs environment and FCM `google-services.json` are build-time configuration
  (`mobile/ios/Config/*.xcconfig`, `mobile/android/local.properties`).

## 4. Data formats

Timestamps everywhere: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` (UTC, RFC 3339).

### 4.1 Approver file — `<configDir>/approvers/<device_id>.json` (admin-written)

```json
{ "v": 1, "device_id": "d-k2m4q7xa9c3d5f8h", "name": "Pixel 9", "platform": "android",
  "public_key": { "kty": "EC", "crv": "P-256", "x": "<b64url 32B>", "y": "<b64url 32B>" },
  "enrolled_at": "2026-09-23T18:00:00.000Z", "enrolled_by": "console",
  "revoked_at": null, "revoked_by": null, "enrollment": null }
```

| Field | Type | Rules |
|---|---|---|
| `device_id` | string | `deviceIdFromJwk(public_key)`; must match the file name |
| `platform` | string | `ios` \| `android` \| `demo` (demo is never accepted) |
| `public_key` | JWK | exactly `kty`, `crv`, `x`, `y`; P-256 |
| `enrolled_by` | string | `console` or a `device_id` |
| `revoked_at` / `revoked_by` | RFC 3339 \| null / `console` \| device_id \| null | set only by the admin CLI |
| `enrollment` | envelope \| null | the signed `kl.device.enroll` |

### 4.2 Signed envelope

`alg` `Ed25519` (node) | `ES256` (phone); `kid` the signer's `node_id` / `device_id`, equal to the id
inside the payload; `payload` b64url (no padding) of the JCS bytes; `sig` b64url of the 64-byte signature.

### 4.3 Protocol messages (payloads)

`kl.approval.request` (node-signed) is parent §6.2 plus `origin` and runbook `steps`:

```json
{ "v": 1, "type": "kl.approval.request", "request_id": "<uuid v4>", "node_id": "kl-3v7q2m4k8d1x9c0a",
  "node_name": "web-01",
  "action": { "kind": "runbook", "name": "site.pull_and_restart", "params": { "ref": "main" },
              "steps": [["git","-C","/srv/site","fetch","--prune","origin"], {"check":{"http_get":"https://www.example.com/healthz","expect_status":200,"retries":5}}],
              "summary": "Run runbook site.pull_and_restart on web-01" },
  "action_hash": "<b64url sha256>", "origin": { "client": "stdio-mcp", "session": null, "job_id": "job-…" },
  "created_at": "2026-09-23T18:04:11.201Z", "expires_at": "2026-09-23T18:09:11.201Z", "nonce": "<b64url 32B>" }
```

| `action.kind` | Fields |
|---|---|
| `tool` | `name` (tool name), `params`, `cwd` (the directory the tool runs in), `summary` |
| `runbook` | `name`, `params` (validated, defaults applied, paths realpath'd), `steps`, `summary` |
| `envelope` (C3) | `name` (executor id), `params: { case_id, envelope_hash }`, `summary` |

`origin` is `{ client, session, job_id }`, plus `deviceId` when `client` is `desktop`.

`kl.approval.response` (phone-signed) is parent §6.3: `v, type, request_id, node_id, action_hash,
nonce, decision ('approve'|'deny'), expires_at, device_id, signed_at`, all strings plus `v`.

`kl.approval.status` (node-signed): `{ v, type, request_id, node_id, state: 'approved'|'denied'|'expired'|'withdrawn'|'refused', device_id|null, reason|null, at }`.

`kl.device.enroll` (signed by the new device for console enrollment, by the enrolling device otherwise):

`{ v, type, device: { device_id, name, platform, public_key }, enrolled_by, code_id, code_mac, created_at, expires_at, nonce }`.
With `enrolled_by` a `device_id`, `code_id`/`code_mac` are absent and `kid = enrolled_by`; with `null`,
`kid = device.device_id` and both are required. `expires_at ≤ created_at + 10 min`.

`kl.device.revoke`: `{ v, type, device_id, revoked_by, reason, created_at, expires_at, nonce }`,
`revoked_by ≠ device_id`, `expires_at ≤ created_at + 7 days`.

Node-signed control messages: `kl.enroll.open { v, type, node_id, code_id, expires_at, nonce }`;
`kl.enroll.done { v, type, node_id, code_id, enroll: <envelope> | null, refused: boolean, nonce }`;
`kl.audit.slice { v, type, node_id, entries, head: { seq, hash }, anchor: { seq, prev }, created_at }`
(`anchor` = the oldest retained entry); `kl.audit.slice.head { v, type, node_id, seq, hash, at }`.

Apps canonicalize only `response`, `enroll`, `revoke` (strings, integer `v`, nested objects): sort
keys by UTF-16 code units, no whitespace, string escaping per RFC 8785 §3.2.2.2.

### 4.4 QR payloads

Encoding: `kl1:` + b64url(JCS(object)). Node keys are DER SPKI hex (§4.17).

| `t` | Printed by | Fields |
|---|---|---|
| `kl.pair` | `enroll-device` | `relay` (phone API URL), `relay_spki` (`sha256/<b64url>` of leaf SPKI DER), `code_id`, `code`, `node: { id, name, key }` |
| `kl.invite` | phone A | `relay`, `relay_spki`, `invite_id`, `secret` (b64url 32B), `nodes: [{ id, name, key }]` |
| `kl.relay` | `relay qr` | `relay`, `relay_spki` |

### 4.5 Phone API (relay, HTTPS, JSON, prefix `/v1`)

Auth kinds:

- **device**: headers `X-KL-Device`, `X-KL-Timestamp` (RFC 3339 UTC, §4) and
  `X-KL-Signature = b64url(ES256-P1363(UTF8(S)))` with
  `S = "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body))`.
  The relay requires `|timestamp − relay clock| ≤ 120 s` (else `401 {"error":"clock_skew","server_time":"…"}`),
  a registered device, a valid signature, and that `SHA-256(S) ‖ device_id` was not seen in the last
  5 minutes (the signed string, not the malleable signature value, is the replay key).
- **code** / **invite**: no signature; the path's `code_id` must be open / the invite unclaimed
  (16 random bytes, unguessable). Phone A, not the relay, checks an invite claim's `mac`. **none**: public.

Errors are `{ "error": "<code>", "message": "…" }`. Rate limits: 10/min per IP unauthenticated,
120/min per device authenticated; `429` includes `retry_after`.

| Method, path | Auth | Body → reply |
|---|---|---|
| `GET /v1/time` | none | → `{ server_time }` |
| `POST /v1/enroll/{code_id}` | code | enroll envelope → `202 { state: 'waiting' }` |
| `GET /v1/enroll/{code_id}` | code | → `{ state: 'waiting'\|'done'\|'refused'\|'expired', node }` |
| `GET /v1/approvals?wait=0..25` | device | → `[{ envelope, expires_in_ms, status: <kl.approval.status envelope> \| null }]` (long-polls up to `wait` s for a new item) |
| `GET /v1/approvals/{request_id}` | device | → `{ envelope, expires_in_ms, status }` / `404` |
| `POST /v1/approvals/{request_id}/response` | device | response envelope → `202 { delivered: true }` / `503 node_offline` / `410 gone` |
| `GET /v1/nodes` | device | → `[{ node_id, node_name, online }]` (no keys) |
| `GET /v1/nodes/{node_id}/history?limit&before_seq` | device | → `kl.audit.slice` envelope |
| `POST /v1/pairing-codes` | device | `{ node_name }` → `{ code, expires_at }` (re-bindable, E8) |
| `POST /v1/devices/invites` | device | → `{ invite_id, expires_at }` |
| `POST /v1/devices/invites/{id}/claim` | invite | `{ device, mac }` → `202` |
| `GET /v1/devices/invites/{id}` | device | → `{ claim \| null }` (inviting device only) |
| `POST /v1/devices/enroll` | device | enroll envelope → `{ nodes: [{ node_id, state }] }` |
| `POST /v1/devices/revoke` | device | revoke envelope → `{ nodes: [{ node_id, state }] }` |
| `GET /v1/devices` | device | → `[{ device_id, name, platform, nodes: [{ node_id, state }] }]` |
| `PUT /v1/push-token` | device | `{ platform: 'apns'\|'fcm', token }` → `204` |

### 4.6 Node ↔ relay link methods (mesh `payload`, RPC via `sendRpc`)

| Method | Direction | Params → result |
|---|---|---|
| `relay.hello` | node → relay | `{ node_id, node_name, versions: [1] }` → `{ relay_id, public_url, phone_spki }`; the relay then replays its device log |
| `approval.submit` / `approval.status` | node → relay | `{ envelope }` → `{ ok }` (relay caches, pushes kind `approval`) |
| `approval.response` | relay → node | `{ envelope }` → `{ delivered: true }` |
| `message.submit` | node → relay | `{ envelope, push?, to_device? }` → `{ ok, seq }`. The relay verifies the node signature, `kid` = the link's node, and a type registered with `mailbox.registerType` (else `type_not_routed`) |
| `enroll.open` / `enroll.done` | node → relay | `{ envelope }` (`kl.enroll.open` / `kl.enroll.done`) → `{ ok }` |
| `enroll.claim` | relay → node | `{ code_id, envelope }` → `{ delivered: true }` |
| `device.enroll` / `device.revoke` | relay → node | `{ envelope }` → `{ state, reason? }` |
| `device.state` | node → relay | `{ device_id, state: 'active'\|'revoked' }` |
| `audit.slice` | relay → node | `{ limit, before_seq?, after?, max_bytes? }` → `{ envelope }` |
| `audit.head` | relay → node | `{}` → `{ envelope }` |

Consumers' methods (F5 `lease.*`, C4 `question.*`, `presence.foreground`, F4) are theirs. The relay never alters a signed message.

### 4.7 Audit entry

```json
{ "v": 1, "seq": 42, "at": "2026-09-23T18:04:11.230Z", "node_id": "kl-3v7q2m4k8d1x9c0a", "writer": "mcp",
  "kind": "approval.response", "data": { "request_id": "…", "device_id": "d-…", "decision": "approve", "envelope": { … } },
  "prev": "<hex64>", "hash": "<hex64>" }
```

| `kind` | `data` |
|---|---|
| `request.inbound` | `{ client, method, name, params_sha256, job_id \| null, origin }` |
| `tier.decision` | `{ tool, tier, reason, params_sha256, origin }` |
| `approval.request` | `{ envelope }` |
| `approval.response` | `{ request_id, device_id, decision, envelope }` |
| `approval.rejected` | `{ request_id \| null, device_id \| null, reason, envelope_sha256 }` |
| `approval.outcome` | `{ request_id, state, reason \| null }` |
| `exec.start` / `exec.result` | `{ kind: 'tool'\|'runbook', name, request_id \| null, job_id \| null, origin }` / plus `ok, exit_status \| null, error \| null` |
| `device.enrolled` / `device.revoked` | `{ device_id, by, envelope \| null }` |
| `device.staged` / `device.rejected` | `{ type, device_id, reason \| null, envelope_sha256 }` |

`writer` ∈ `service | mcp | cli`.

### 4.8 Test vectors — `tests/vectors/approval-v1/<name>.json`

```json
{ "name": "response-reject-changed-parameter", "consumers": ["node"], "check": 12,
  "given": { "now": "…", "node": { "id": "kl-…", "key": "<DER SPKI hex>" }, "approvers": [ <approver files> ],
             "overlay": [], "pending": [ <request envelope> ], "used": [], "current_action": { … } },
  "input": <response envelope>,
  "expect": { "accepted": false, "reason": "action_changed" } }
```

Phone vectors (`consumers: ["ios", "android"]`): `given: { pinned_nodes: [{ id, key }] }`, `input`: a
request envelope, `expect: { shown, reason: null | 'bad_node_signature' | 'unpinned_node', display }`.
`keys.json` holds the fixed test keys (Ed25519 seeds, P-256 `d` for devices A, B, C). Production code
never reads `tests/`: `src/approvals/test-keys.js` lists the **public** test keys, refused (`test_key`)
unless `allowTestKeys: true`, which only tests set.

## 5. Interfaces

### 5.1 Consumed

| From | Name |
|---|---|
| F2 | `NodeIdentity`, `deriveNodeId`, `base32Encode`, `getOrGenerateNodeIdentity`, `loadIdentity` (`src/mesh/node-identity.js`); `nodeId` per §4.17 |
| F2 | `loadNodeConfig`, `assertAdminOwned` (`src/service/node-config.js`, no-op on win32); `classifyToolCall`, `formatToolPattern` (`safety-policy.js`) |
| F2 | `RunbookEngine.validateParameters`, `executeRunbook`, `checkRateLimit`, `recordExecution`, `JobManager`, `StdioMcpServer` |
| F1 | `MeshTransport`, `MeshPairing`, `createCore`, `ToolExecutor` requester `(toolName, parameters, metadata)`, `buildServicePorts`, pidfile helpers, `restoreDataDirOwnership`, `adminConfigDir` |
| F6 | `NODE_YAML_KEYS` (F3 appends `approvers`, R11); `tests/helpers/stdio-mcp-client.js` `connectStdioMcp` |
| F7 | `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn)`, `isLocalRequester(fn)` (`src/core/origin.js`, §4.21); stubbed (`false` / `null` / identity) until F7 merges |

### 5.2 Produced

Every name below is F3-owned; consumers use it exactly as written.

| Id | Signature | Consumers |
|---|---|---|
| P1 | `canonicalize(value) → string`, `sha256b64url(s)`, `JcsError` (`src/platform/jcs.js`) | C3, F4, F5 |
| P2 | `seal(message, signer)`, `open(envelope) → { message, bytes }`, `verifyEd25519(envelope, spkiDerHex)`, `verifyEs256(envelope, jwk)`, `nodeSigner(identity)`, `deriveDeviceId(raw, prefix = 'd-')`, `deviceIdFromJwk(jwk)`, `ed25519RawToSpki(raw32)`, `fingerprintGroups(id)`, `EnvelopeError` (`src/approvals/envelope.js`) | F4 (`client-grant-v1`), F5 (`lease-v1`), F7 (`kld-` ids), C4 |
| P3 | `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces = null, overlay = true }) → { ok: true, message, bytes, deviceId } \| { ok: false, reason }`; `new NonceCache({ max, ttlMs })` `get/add` (`src/approvals/verify-device.js`) | F5, C4 (R44) |
| P4 | `new ApproverStore({ dir, stagedDir, geteuid, adminUid, platform, now, allowTestKeys })`: `ready()`, `list()`, `get(kid)` (key at `.public_key`), `isActive(kid, { overlay })`, `isAdminApplied(kid)`, `activeCount()`, `stage(envelope)` | F4 (R25), F5, C4 |
| P5 | `core.context.getPhoneApprover() → PhoneApprover \| null` (always `null` in the Electron host) | C3, F4, F5 |
| P6 | `PhoneApprover.requestAction(action, { origin, signal, currentAction })` → `Promise<Outcome>` (§3.6; `currentAction` required; `Outcome.action_hash` for the pre-run re-check) | C3 (`envelope`), F4 (delegate), F5 |
| P7 | `PhoneApprover.requestApproval(t, p, m) → true \| false \| 'timeout' \| 'unavailable'`, setting `m.refusal = { deniedBy, error }` on refusals | ToolExecutor, F5 (`LaunchApp`) |
| P8 | `toolAction`, `runbookAction`, `envelopeAction({ executorId, caseId, envelopeHash, summary })`, `actionHash(action)` (`src/approvals/messages.js`) | C3, F4 |
| P9 | `startApprovals({ dataDir, configDir, nodeConfig, ports, profile }) → { phoneApprover, auditLedger, relayClient, approverStore, identity, stop }` (`src/approvals/service-wiring.js`) | F4, F5, F7 (status) |
| P10 | Link interface (§3.11): `submit`, `status`, `send(envelope, { push?: { kind, id, expires_at? }, to_device? }) → { ok }`, `call(method, params, { timeoutMs })`, `notify(method, params)`, `onMessage`, `isConnected()`, `canDeliver() → { ok, reason? }`, `on('connected'\|'disconnected')` | F5 (leases), C4 (questions, presence) |
| P11 (E5) | `relayClient.registerMethod(name, handler(params, { peer }) → result)`; refuses `mesh.task.*`, `mesh.channel.*`, F3's own names (`method_reserved`) | F4, F5, C4 |
| P12 (E6) | `FileCourier({ dataDir, identity })` with `call(method, params, { timeoutMs })`; `CourierPump({ dataDir, relayClient, identity, rpcHandler })` | F4 (R24) |
| P13 (E7) | `RelayClient` dials `<configDir>/front-door.json` with `MeshTransport.connectPinned` when both exist | F4 |
| P14 (E1) | `startRelay({ dataDir, config, identity, listeners: 'own' \| 'external', registry?, extensions? }) → { stop, address(), phoneApi, phoneApiHandler: (req, res) => void, nodeHub, mailbox, pusher, devices }` | F4 |
| P15 (E2, E8) | `phoneApi.registerRoute(method, pathPattern, { auth: 'device' \| 'none' \| 'code' \| 'invite', rate?: { perMin }, handler(req, ctx) → { status, body } })`, `ctx = { deviceId, params, query, body, relay }`; a later registration replaces an earlier one | F4, F5, C4 |
| P16 (E3) | `new NodeHub({ identity, transport, pairing, registryFile, peerSource? })`: `nodes()`, `addCode(name)`, `remove(name)`, `rpc(nodeId, method, params, { timeoutMs })`, `onNodeMessage(method, handler(params, { nodeId }))`, `onConnection(fn)`; `peerSource = { list() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }], on('change') }` | F4, F5, C4 |
| P17 | `Mailbox`: `registerType(prefix, { ttlMs, maxBytes })`, `put`, `list({ nodeIds, typePrefix, toDevice, afterSeq })`, `wait(filter, { timeoutMs })`; `src/frontdoor/extensions.js` array of `(relay) => void` | F5, C4 |
| P18 (E4) | `pusher.notify(device, { kind = 'approval', id, node_name?, expires_at? })`; kinds `approval \| grant \| pairing \| alert \| question \| lease`; `PushSender = { id, platforms, notify(device, payload) → { ok, dropToken? } }`, `createPusher(config, { senders })` | F4, F5, C4 |
| P19 | `DeviceRegistry`, `ApprovalCache`, `Invites` (§3.12 table) | F4 |
| P20 | `AuditLedger`: `append({ kind, data }) → Promise<entry>`, `verify()`, `tail(n)`, `entriesAfter(hash, limit)`, `slice({ before_seq?, after?, limit, max_bytes })` (E9), `head()`, `prune(now)`; link methods `audit.slice`, `audit.head`; kinds `gui.*`, `lease.*` reserved for F5 | F4 mirror, F5, F7 (read-only view) |
| P21 | Phone API routes (§4.5), link methods (§4.6), message types (§4.3), `approval-v1` vectors (§4.8) | F4 extends; must not change |
| P22 | `remoteApprovals: 'phone'` + `deps.phoneApprover`, `deps.auditLedger`, `deps.nodePolicy`; the §4.21 phone branch | hosts, F4, F7 |
| P23 | `ToolExecutor` options `classifyCall(t, p, { cwd })` and `localOrigin`, `tierDecision` event, `mapApprovalResult`; `classifyToolCall(t, p, policy, { cwd })` | F4, F5, F7 |
| P24 | `src/execution/tool-patterns.js`: `formatToolPattern`, `patternMatch`, `splitShellSegments`, `normalizeWhitespace`, `SHELL_SEPARATORS` | F5 (Type guard), runbook profile |

## 6. Configuration

| Key | File | Default | Notes |
|---|---|---|---|
| `approvers.relay` | `<configDir>/node.yaml` | absent (phone approvals off) | `wss://host:port` of the relay mesh listener; `front-door.json` (F4) supersedes it |
| `approvers.request_ttl_s` | node.yaml | `300` | integer 30–300 |
| `relay.phone_listen` `{ host, port }` | `<configDir>/service.json` (relay host) | `{ "host": "0.0.0.0", "port": 8443 }` | |
| `relay.tls` `{ cert_file, key_file }` | service.json | required | PEM files readable by the relay's account; SPKI pinned by phones |
| `relay.mesh_listen` `{ host, port }` | service.json | host required, port `18795` | private/loopback IP literal only (§3.12) |
| `relay.public_url` | service.json | required | phone API URL put in QR codes |
| `relay.push.apns` `{ team_id, key_id, key_file, topic, environment }` | service.json | absent | `environment`: `production` \| `sandbox` |
| `relay.push.fcm` `{ service_account_file }` | service.json | absent | JSON with `client_email`, `private_key`, `project_id` |
| `audit.retention_days` | service.json | `365` | integer ≥ 30 |

No push block → the `none` sender. `relay` and `audit` join `ADMIN_ONLY_KEYS` (data-dir copies
ignored with a warning; unknown keys rejected, R55); `approvers` joins `NODE_YAML_KEYS`. `startRelay`
takes `{ phoneListen, tls, meshListen, publicUrl, push: { apns?, fcm? } }`, which F4's `frontdoor`
profile derives from `frontdoor.*`. No new env vars; tests pass `useTls: false`, `allowTestKeys: true`.

## 7. Host wiring

| File | Touch |
|---|---|
| `src/core/create-core.js` | program §5 exception (several additive hunks): accept `'phone'`; `require('../approvals/executor-options')` and `require('./origin')` (F7's; whichever merges second rebases); the §3.7 seam in `createToolExecutorWithApprovals`; context getter `getPhoneApprover` |
| `src/execution/tool-executor.js` | `classifyCall`, `localOrigin`, `tierDecision`, metadata `signal`/`workingDirectory`, `mapApprovalResult` at both call sites |
| `src/execution/safety-policy.js`, new `tool-patterns.js` | move the pattern helpers (re-exported); `classifyToolCall` `{ cwd }`; `file_path`, `edits[].file_path` extraction |
| `src/service/run.js` | first in the F3 → F4 → F5 → F7 order: both profiles call `startApprovals(...)`; agent profile passes `remoteApprovals: 'phone'`, `phoneApprover`, `auditLedger`, `nodePolicy` to `createCore`; `stop` includes approvals |
| `src/service/cli.js` | dispatch `enroll-device`, `device` → `commands/devices.js`; `relay` → `commands/relay.js`; `pair` → `commands/pair.js` (F4 extends it); `mcp` builds a `FileCourier` producer and passes `approver`/`auditLedger` to `StdioMcpServer`; HELP lines |
| `src/service/config.js` | `relay`, `audit` parsing; `ADMIN_ONLY_KEYS` |
| `src/service/node-config.js` | `approvers` block → `nodeConfig.approvers = { relay, requestTtlS }`; `NODE_YAML_KEYS += approvers` |
| `src/service/doctor.js` | approvers dir admin-owned (POSIX) / not service-writable (Windows probe), active device count, relay paired/linked, `audit verify` |
| `src/mesh/mesh-transport.js`, `mesh-pairing.js` | `listen: false`; `timeoutMs`, `addCode(code, meta)`, `meta` on success |
| `src/runbooks/runbook-engine.js` | `executeRunbook` `validatedParams`; `JobManager` awaiting_approval controller and transition |
| `src/mcp/stdio-server.js` | first in F3 → F4 → F5: `approver`, `auditLedger` options; `request.inbound`; unsafe path (§3.8) |
| `tests/examples.test.js` | `NODE_YAML_KEYS` gains `approvers` |
| IPC, `preload.js`, `renderer.js`, `styles.css`, `settings.js`, `tools/index.js` | **none**; F7 shows approvals and relay status read-only from `startApprovals`' objects |
| `CLAUDE.md` | one short "Approvals and relay" section: commands, `device apply`, test files |

Extension consumers (§5.2 ids): F4 mounts P11–P16, P18–P20; F5 mounts lease routes through P15 and
`extensions.js` (P17), lease link methods through P10/P11/P16, push kind `lease` (P18), and verifies
grants with P3; C4 does the same for `question.*`, `presence.foreground` and push kind `question`.

## 8. Security and trust

| New capability for an attacker | What stops it | Parent |
|---|---|---|
| Compromised relay forges or edits a request | Node signature over the bytes; the phone hides anything unverified; node keys pinned only from QR codes | §3.1-1 |
| Compromised relay forges or replays an approval | Phone signature; response bound to a pending request's id, nonce, hash, expiry and node; single use; API replay keyed on the signed string | §3.1-3 |
| Relay adds its own phone key | Console enrollment needs `code` (never sent to the relay) and an on-screen match; remote enrollment needs an enrolled device's signature, then an admin `device apply` | §3.1-2, §6.4 |
| Service-account file write adds an approver | The service never trusts the data dir for keys; the config dir is admin-owned. On Windows the startup write probe empties the set if the service can write it | §3.1-2, §4.2 |
| Another local process forges courier traffic (Windows `LOCAL SERVICE` is shared) | The pump forwards only node-signed envelopes and `enroll.done` for codes it opened; producers verify what they read | §4.2 |
| Thief's phone revokes the owner's phone first | Revokers are judged against the admin-applied set, so the owner's counter-revoke still counts; both keys go; recovery from a console | §6.4 |
| Service-account write deletes a staged revoke / restart drops the overlay | **Residual:** after a restart, until `device apply`, that key is active again. The relay replays its device log on reconnect, which restages it. For a stolen phone use `device revoke` on each node | §11 |
| Compromised relay withholds a revoke, or a node is offline | **Residual:** that node keeps trusting the key until the relay delivers or an admin runs `device revoke` there | §11 |
| Action changes between approval and run | Check 12 re-hashes live state; runbooks and envelopes re-check right before execution and runbooks run the exact validated values. **Residual:** `tool` actions are not realpath'd, so a symlink swapped under a tool's path after the check is not caught | §6.3 |
| Stale approval after a long delay | TTL ≤ 300 s on the node's clock; the phone refuses at zero | §6.2 |
| A misleading approval screen | Full `command`-like fields or head + tail with a hidden count; control/bidi/invisible characters escaped; numbers as JSON text | §6.5 |
| Relay reads action contents | **Deviation** (§11.12): the relay sees every parameter, including `Vault(*)` values, and history slices | §11 |
| Pre-auth frame parsing on the relay mesh listener | Private/loopback IP literal enforced until F4 (ruling 8) | §7.3 |
| Node exposed by the link | `listen: false`; nodes only dial out | §3.1-4 |
| Push leaks | Payload is `{ kind, id }`; generic text | §6.5 |
| Stolen phone | Hardware key + biometrics per signature; revocation from another device or the console | §11 |
| Test keys shipped | Nodes refuse the keys in `src/approvals/test-keys.js` unless built with `allowTestKeys` | — |
| A desktop run reaches the phone, or a remote run reaches the dialog | Marked events never get the phone requester; unmarked ones never get `null` + dialog in phone mode (R49) | §3.1-3 |

Principle 3 as shipped: fresh (TTL, node clock), single-use, exact action (check 12 plus the pre-run
re-check), no standing approvals, only `=== true` approves; in phone mode other remote requesters are ignored.

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| No active device / no relay configured | requester `'unavailable'`; unsafe runbook job `denied` | "Phone approval unavailable…"; job reason |
| `mcp` asks while the service is stopped | `unavailable` at once | job `denied`, "the King Louie service is not running on this node" |
| Action not JSON or over 256 KiB | `'unavailable'` with `metadata.refusal` | "Action cannot be shown on the phone (…); nothing ran." |
| Relay link down at request time | pending; resubmitted on reconnect; expires on the node's clock | a late push, or `expired` |
| Relay down when the phone responds | `503 node_offline`; the app retries until time runs out | "Node offline — retrying" |
| Phone denies | `false` → `User denied permission`, denial tracker records it; job `denied` | status `denied` |
| Rejected response | audited; request stays pending unless check 12 failed | phone shows `refused: <reason>` |
| Audit append fails on a valid response | response not accepted (`audit_unavailable`), request pending | phone retries; doctor shows the ledger error |
| Audit lock unobtainable before running | fails closed: `Audit ledger unavailable; nothing ran.` | tool/job error |
| Second device responds | `already_decided` | "Already decided by \<device\>" |
| Tool call cancelled while waiting | `withdrawn`, status sent, no denial penalty | request disappears with "withdrawn" |
| Phone clock off by > 120 s | `401 clock_skew` with `server_time`; the app applies the offset and retries once | "Check the phone's clock" if the retry fails |
| Node ↔ relay clock skew > 30 s ahead | mesh envelopes rejected (`message_from_future`) | doctor: "relay link: clock skew" |
| Malformed approver file / Windows ACL lets the service write | ignored (or the whole set treated as empty), `log.error`, doctor FAIL | doctor line naming the file or dir |
| APNs/FCM error, or no push configured | logged; 410/404 drops the token; `none` sender does nothing | app re-registers on launch; foreground polling |
| `enroll-device` not admin / service stopped / relay unlinked | exit 1 with the reason | message naming the fix |
| Relay certificate key changed | phone pin fails | "Relay certificate changed — scan a new relay code" (§3.14) |

## 10. Testing

`node --test`; pass = `# fail 0`.

| File | Covers |
|---|---|
| `tests/platform-jcs.test.js` | RFC 8785 appendix cases, UTF-16 key order, number forms, lone surrogate / NaN / undefined refusals |
| `tests/approvals-protocol.test.js` | every file in `tests/vectors/approval-v1/` with `consumers` including `node`, through `verifyDeviceEnvelope`, `handleResponse` and the enroll/revoke validators; committed vectors equal `generate.js` output; a device revoked while its approval is in flight is refused |
| `tests/approvals-phone-approver.test.js` | request build and sign, TTL clamp, expiry, withdraw, resubmit on reconnect, requester mapping incl. `metadata.refusal`, `currentAction required`, audit failure at step 13, the "change the action after approval" test |
| `tests/approvals-approver-store.test.js` | POSIX ownership refusals, Windows write probe (stubbed `open`), misnamed/malformed/test-key files ignored, overlay, revoker rule, mutual revoke, `applyStaged` listing/confirm/order/age limit, `duplicate`, nonce file-name validation, no un-revoke |
| `tests/approvals-courier.test.js` | outbox/inbox round trip, `call` reply, dead-service `unavailable`, forged inbox file rejected, unsigned outbox entry dropped, `enroll.done` for an unknown `code_id` dropped |
| `tests/audit-ledger.test.js` | chain; `verify` broken at edited/deleted/reordered line; lock contention across child processes; stale-lock rename; prune + anchor; `entriesAfter`; `slice` paging both ways and `max_bytes` (at least one entry); signed `head` |
| `tests/core-remote-approvals.test.js` (extend) | `'phone'` validation, requester replacement, `denyAutoApproval` for every mode, `getPhoneApprover` null/non-null and null under `'allow'`; **R49:** phone mode + marked event → `phoneApprover.requestApproval` never called, `approvalRequired` emitted, `denied` tier still refused, audit origin `desktop`; a child built with `event = null` and a marked parent's re-threaded requester never calls the phone and is answered by the parent's dialog; an unmarked child in phone mode gets the phone |
| `tests/tool-executor-remote-tier.test.js` | `classifyCall` denied/unsafe/read; `unsafe` beats `allow Bash(git *)` for `always_confirm Bash(git push*)`; relative `file_path` and `edits[].file_path` outside roots → `unsafe`; hook `confirm` with requester `'timeout'` and `'unavailable'` → nothing runs; gate with a truthy non-`true` value → nothing runs; withdrawn → no denial penalty; metadata carries `workingDirectory` |
| `tests/mcp-stdio-approvals.test.js` | (uses `connectStdioMcp`) unsafe runbook → awaiting_approval → approve/deny/expire/cancel; realpath swap refused at the pre-run re-check; `validatedParams` used without re-validation; concurrency at transition; `request.inbound` for every tier |
| `tests/frontdoor-relay.test.js` | in-process relay + `RelayClient` + fake phone over `ws` (no TLS): request → push → response → status, console and signed enrollment, revoke, device-log replay to a late node, history slice, `message.submit` to a registered type and refusal of an unregistered one, `registerRoute` replacement, `registerMethod` refusing reserved names |
| `tests/frontdoor-phone-api.test.js` | auth string, skew window, replay keyed on the signed string (a re-encoded signature is still a replay), code/invite auth, rate limits, body cap, long-poll `wait` |
| `tests/frontdoor-push.test.js` | `none` default; APNs against a local `http2` server (JWT, headers, `k`, 410); FCM against local `https` (token exchange, data-only, 404) |
| `tests/service-cli-devices.test.js` | `enroll-device` refusals and fingerprint output, `device list|revoke|apply` incl. `--yes` |
| `tests/service-cli-relay.test.js` | `relay run` refuses wildcard, hostname and public mesh hosts; `relay code`; `pair` against a test relay |
| `tests/service-profile-graph.test.js` (extend) | runbook profile and `relay` graphs exclude providers, agent loop, tools and `safety-policy.js` |
| `tests/approvals-e2e.test.js` | spawns `relay run` and `run --profile runbook` with temp dirs, pairs them, enrolls a fake phone, runs an unsafe runbook via `mcp` end to end |

`tests/helpers/fake-phone.js`: `createFakePhone({ seed? }) → { deviceId, jwk, approverRecord(), respond(requestEnvelope, decision, { signedAt }), enroll(...), revoke(...), signApi(method, path, body, { timestamp }) }`
(P-256, P1363). `tests/vectors/approval-v1/generate.js` rebuilds the vectors from `keys.json`.

Vectors: `jcs`, `device-id-p256`, `device-id-ed25519`, `request-valid`, `request-bad-node-signature`,
`request-unpinned-node`, `request-display` (phone), `response-approve`, `response-deny`,
`response-reject-{malformed-noncanonical, unsupported-version, wrong-alg, kid-mismatch, unknown-device,
demo-device, test-key, revoked-device, revoked-via-overlay, bad-signature, wrong-node, replay,
already-decided, unknown-request, nonce-mismatch, action-hash-mismatch, expires-mismatch, expired,
changed-parameter}`, `response-accept-phone-clock-ahead`, `enroll-console`, `enroll-console-bad-mac`,
`enroll-signed`, `enroll-signed-by-overlay-revoked`, `revoke-valid`, `revoke-self-rejected`,
`revoke-mutual`, `audit-slice`, `phone-api-auth`.

Mobile: `ProtocolVectorTests.swift` and `ProtocolVectorTest.kt` load the same directory and check
their vectors, phone-side JCS, sign → verify, P1363 conversion, display escapes, and that demo mode
never builds the network client. Manual on devices: key creation, biometric invalidation, StrongBox
fallback, APNs/FCM delivery, no-push polling, pin failure.

**Five conditions the parent is silent on, and the tests that pin them:**

| Condition | Test |
|---|---|
| Phone clock wrong by minutes | `response-accept-phone-clock-ahead`; `frontdoor-phone-api` "401 clock_skew then offset retry succeeds" |
| Two enrolled phones, one approves and one denies | `approvals-phone-approver` "first valid response decides; second gets already_decided; both audited" |
| Approval arrives after the tool call was cancelled | `approvals-phone-approver` "abort → withdrawn; later approve → unknown_request; tool never runs"; `mcp-stdio-approvals` cancel while awaiting |
| Relay down when the request is created | `approvals-phone-approver` "queued while down, submitted on connect, expires on node clock if the link never returns" |
| Claude Code's `mcp` asks for an unsafe runbook while the service is stopped | `mcp-stdio-approvals` "unavailable immediately with the service-not-running reason" |

## 11. Deviations from the parent

1. **§6.4 "nodes add the key once they have checked that signature."** Relayed enrollments are
   staged; an admin `device apply` adds them (R15), because the service cannot write trust anchors.
2. **§6.2 "the phone checks that signature" over JCS.** Signatures cover the transmitted bytes; the
   node, not the phone, recomputes `action_hash` (check 12), keeping number canonicalization out of Swift and Kotlin.
3. **§10 "reuses `src/events/event-ledger.js`."** It is a new `src/audit/audit-ledger.js` (ruling 7).
4. **§6.5 history "from the audit mirror."** History comes from node-signed slices through the relay.
5. **§6.5 fleet status and connected clients screens** move to F4.
6. **§5.1 pairing.** The target is the relay's `wss://` mesh endpoint; the first node's code comes
   from `relay code`. The parent says codes last 10 minutes; the code's `MeshPairing` codes last 2, and F3 keeps 2.
7. **§4.2 `remoteApprovals`** gains `'phone'` plus a `phoneApprover` dep, not a port.
8. **§5.3 unsafe-if rules** exist in `safety-policy.js` but nothing calls them; F3 wires them (§3.7).
9. **§9 "front door down → denied at expiry."** A request made while the link is down is delivered
   when it returns, if unexpired (R16).
10. **§7.1 one port.** Until F4 the relay uses two listeners (phone API, private mesh).
11. **§6.2 action shape.** Runbook actions add `steps`; a third kind `envelope` exists for C3.
12. **§11 "the relay only relays."** The relay sees every action's full parameters (including
    `Vault(*)` values and commands) and every history slice. End-to-end encryption is deferred;
    `mobile/PRIVACY.md` and the install guide say so.
13. **§5.3 path containment.** F2's `extractPathsFromParameters` ignores `file_path` and
    `edits[].file_path`, so a remote `Read`/`Edit` outside `allowed_roots` was `read`/`routine`; F3 adds them.
14. **§6.5 push.** Push is optional (Q-A); without it requests reach the phone only while the app is open.

## 12. Assumptions made without asking

- Phones pin the relay's leaf SPKI and ignore CAs; operators reuse the key across renewals (alternative: CA validation plus a pin).
- Android minSdk 33 for native Ed25519 (listed from API 33 in the Android API reference; the vector
  test runs on an API 33 emulator) (alternative: minSdk 28 with Tink). iOS 17 (alternative: iOS 16).
- Push text includes the node name, as the parent's example does (alternative: fully generic).
- `mcp` needs the running service for approvals (alternative: `mcp` owns the link when the service is stopped).
- Children of desktop runs inherit the desktop mark (alternative: children always go to the phone).
- A hook `confirm` plus an `unsafe` tier make two requests (alternative: the first approval covers both).

### 12.1 Open question for the owner

- **Q-A push credentials** (program §8): (1) owner-built apps with their own APNs/FCM keys, (2) a
  project-run push relay carrying only ids, or (3) no push. F3 ships (3) as the default `none`
  sender with APNs/FCM senders ready for (1); nothing here blocks (2) as another `PushSender`.

## 13. Deferred

Everything in §2.2 with its owner, plus: automatic `device apply` by an admin-owned scheduled task
(after F4, if owners ask); end-to-end encryption of action contents to phones (later stage).

## 14. Dependencies (npm)

| Package | Why | Rejected |
|---|---|---|
| `qrcode` (pure JS, MIT) | terminal QR for `enroll-device` and `relay qr` (`toString(text, { type: 'terminal', small: true })`); CLI only | `qrcode-terminal` (unmaintained); a hand-rolled encoder (~600 lines of Reed–Solomon); text-only codes (too long to type) |

JCS is in-repo (the `canonicalize` package saves 40 lines at the cost of a dependency). Push uses
Node's `http2`, `https` and `crypto` (`apn` and `firebase-admin` rejected as large and unnecessary). A
test asserts the lockfile entry for `qrcode` has no install scripts or native binaries.

Mobile (not npm): iOS system frameworks only; Android Firebase Messaging (`fcm` flavor), CameraX,
ZXing core (ML Kit rejected: heavier, closed-source), AndroidX Biometric, kotlinx.serialization.
