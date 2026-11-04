# Sealed Phones (Stage 3, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every approval, question, lease message and lease view a node sends a phone, and every answer a phone sends back, is readable only by the phone and the node; the relay (and the front door that hosts it) routes by ids and expiry alone.

**Architecture:** A third phone key, the **box key** (P-256, key agreement, Keystore / Secure Enclave, no biometric, unlocked phone only), enrolls like Android's read key. The node gets a static P-256 **node box key** beside its Ed25519 identity. Each content message keeps its type and its routing fields in clear and moves its content into one `sealed` object: the content is encrypted once under a fresh content key (AES-256-GCM, with the clear part as associated data), and that key is wrapped once per recipient (ECDH with a fresh ephemeral P-256 key, HKDF-SHA256). The node signs the whole message as before. Hashes the phone signs over (`action_hash`, `lease_hash`) become salted, the salt travelling inside the box, so a decision stays bound to the exact action and the relay cannot guess a short value from the hash. Sealing turns on per node the moment one active approver record holds a box key, and only the node's admin-applied records decide that.

**Tech Stack:** `node:crypto` only (ECDH P-256, `hkdfSync`, AES-256-GCM); Swift CryptoKit (`SecureEnclave.P256.KeyAgreement`, `HKDF`, `AES.GCM`); Android Keystore (`PURPOSE_AGREE_KEY`, `KeyAgreement("ECDH")`), `javax.crypto` AES/GCM, HKDF by hand over `HmacSHA256`. Node's built-in test runner. Vectors in `tests/vectors/approval-v1` and `tests/vectors/lease-v1`.

**Spec:** `docs/superpowers/specs/2026-11-04-attach-stage3-design.md` §14 (binding: §2 decisions 2, 5, 6; §3 anti-goals). Protocols: `docs/protocol/approval-v1.md`, `lease-v1.md`. What must be sealed: `mobile/PRIVACY.md`, "What the relay operator can see".

## Global Constraints

- Node side: `node:crypto` only, no new dependency. Tests with `node --test`, never jest; covering tests per task, one full `npm test` in the last task.
- Vectors: a change to approval-v1 or lease-v1 is complete only after `node tests/vectors/approval-v1/generate.js` / `node tests/vectors/lease-v1/generate.js` and `--check` pass; `tests/approvals-protocol.test.js` and `tests/lease-vectors.test.js` list every name. The published test keys (`keys.json`) are never pinned or shipped; new ones join `src/approvals/test-keys.js`.
- The clear path stays byte-identical until a device has a box key: every vector and test that exists today keeps passing unchanged through every task.
- Nothing in the relay parses a sealed field. The relay reads: envelope `alg`/`kid`/`sig`, `type`, `node_id`, `request_id` or `lease_id`, `expires_at`, `to_device` (a link parameter), `seq`. A relay check that reads anything else today is changed in the task that seals that field.
- Push stays content-free and unchanged (approval-v1 §8).
- Invented values only (`web-01`, `d-…` from `keys.json`, `example.com`); no machine names, towns, domains or the owner's name.
- Plain, terse words in anything an owner reads (doctor rows, `device apply` lines, phone rows, the guide).
- Every string a node or a phone shows from the other side goes through the existing escapes (`shown`, `Display.escape`).
- `tests/mobile-*.test.js` pin app rules by reading sources; `../gradlew test` compiles and runs the Android protocol module; `swift test` needs a Mac and is not run here. Nothing in this plan claims Swift compiled.

## Review Focus

1. A device revoked between building and opening a message: its wrap must not be in `keys` (the policy reads `isActive` at build time), and a revoke staged after sending leaves a wrap behind that opens a message the device may no longer act on; the node's response checks (`revoked_device`) are what stop it. Test in Task 4 (recipients) and Task 5 (response from a device revoked after the request).
2. An updated phone that is in `keys` but whose wrap does not open (the phone was Reset and re-enrolled with a new box key the node has not applied): the row says the key is not on the node and offers no Allow or Deny, and nothing crashes. Test in Tasks 8 and 10/11 (source pin).
3. The relay moving a `sealed` blob from one request onto another request's clear part: the associated data differs, the open fails, the phone shows the row as unreadable, and the node accepts no response for it (its own salt and hash never matched). Vector `seal-tampered-clear`, Task 1; response path, Task 5.
4. Sealing turning on while a clear request is pending: the first `device apply` of a box key between a request and its response. The pending entry keeps its own hash rule (unsalted), and the response still verifies; the next request is sealed. Test in Task 5.
5. A live-view frame that fits the raw cap but not the sealed 256 KiB: the view goes with `frame: null, frame_dropped: true`, never as a malformed or oversize view, and the phone's size check still holds. Test in Task 7.

---

## Rulings (what the spec left open, decided here)

The spec's open points, each a ruling the owner may overrule; the plan builds on them as written.

- **R-SP-1, one sealed format for every direction.** `sealed = { v: 1, epk, iv, ct, keys }`. `epk` is a fresh P-256 JWK per message (`kty`, `crv`, `x`, `y`). `cek` is 32 random bytes. `ct` is base64url of AES-256-GCM(`cek`, `iv` 12 random bytes, plaintext = JCS bytes of the **content object**, AAD = JCS bytes of the **clear part**: the message object without `sealed`) with the 16-byte tag appended. `keys` maps each recipient id (a device id, or the node id) to base64url of AES-256-GCM(`kek_r`, iv = 12 zero bytes, `cek`) with its tag (48 bytes); the zero iv is safe because `kek_r` is fresh per message and recipient. `kek_r = HKDF-SHA256(ikm = the 32-byte x-coordinate from ECDH(epk, box_r), salt = empty, info = UTF-8("kl-seal-v1\n" + type + "\n" + sender_id + "\n" + recipient_id), 32 bytes)`. The full message a validator checks is clear ∪ content. Per-recipient wrapping of one content key, not per-recipient encryption of the content, is what "seals to each enrolled device separately" means here: it keeps an 8-phone broadcast of a 256 KiB action under the 1 MiB link frame (16 wraps are 768 bytes).
- **R-SP-2, salted hashes.** When a message is sealed, `action_hash = b64url(SHA-256(raw(salt) ‖ JCS(action)))` and `lease_hash = b64url(SHA-256(raw(salt) ‖ JCS(lease)))`, where `salt` is 32 random bytes carried as base64url inside the content. The clear shape keeps today's unsalted rule. The phone recomputes from the opened content and refuses `action_hash_mismatch` / `lease_hash_mismatch` before showing anything. The node's re-check (approval-v1 §4 step 12, lease-v1 check 12) recomputes with the salt it kept on the pending entry. The response and grant shapes do not change: the phone signs what it signs today, over a hash only it and the node can tie to the action.
- **R-SP-3, the node box key.** The node's identity key is Ed25519 and cannot do ECDH, and the phones' enclaves speak only P-256. So each node generates one P-256 key-agreement key, stored encrypted in the identity record beside the Ed25519 private key (`encryptedBoxKey`, same cipher), and puts its JWK in the clear part of every sealed message it sends as `node_box`. A phone seals a reply to the `node_box` of the node-signed message it answers (verified against the pin, and covered by the AAD), so it pins nothing new and nothing reaches anyone but the holder of that private key. Rotation is not in this plan.
- **R-SP-4, what is sealed, per type** (the clear part is everything else):

  | Type | Content (inside `sealed`) | Clear (the relay may read; the AAD) |
  |---|---|---|
  | `kl.approval.request` | `action`, `origin`, `salt` | `v`, `type`, `request_id`, `node_id`, `node_name`, `action_hash`, `created_at`, `expires_at`, `nonce`, `node_box` |
  | `kl.lease.request` | `lease`, `origin`, `salt` | `v`, `type`, `request_id`, `lease_id`, `node_id`, `node_name`, `lease_hash`, `created_at`, `expires_at`, `nonce`, `node_box` |
  | `kl.lease.status` | `name` | the other thirteen keys |
  | `kl.lease.view` | `foreground`, `frame`, `frame_dropped`, `actions` | `v`, `type`, `node_id`, `lease_id`, `seq`, `at`, `to_device`, `state`, `locked`, `remaining_s`, `contact_token` |
  | `kl.question.ask` | `case_id`, `question_id`, `case_title`, `text`, `options` | `v`, `type`, `node_id`, `token`, `kind`, `urgency`, `expires_at`, `node_box` |
  | `kl.question.answer` (phone → node) | `case_id`, `question_id`, `answer` | `v`, `type`, `node_id`, `token`, `device_id`, `nonce`, `signed_at` |

  Not sealed: `kl.approval.response`, `kl.approval.status` (reason codes), `kl.lease.grant`, `kl.lease.revoke`, `kl.lease.watch`, `kl.lease.listing`, `kl.device.*`, `kl.enroll.*`, `kl.audit.*`, the front door's client-grant-v1 messages (the front door is that OAuth server and already knows the client), push. `node_name` and `granted_by.name` stay clear: the relay holds node and device names in its registries. Residual, said in PRIVACY.md: a lease grant's `apps` ids, a decision (`approve`/`deny`/`grant`), and a question's `kind` and `urgency` are in clear.
- **R-SP-5, recipients and the switch.** `SealPolicy.recipients()` is every active approver record (`isActive`, overlay included) that holds `box_key`, plus the node itself (its own `node_box`, so the node can open its own audit entries and tests can read what was sent). `SealPolicy.sealing()` is true iff that set holds at least one device. It is read at every build. A device without a box key gets the same sealed message and cannot open it. Nothing the relay sends changes the set: only the admin-applied records do.
- **R-SP-6, phones that cannot open.** An app from before this change refuses a sealed message as `malformed` (approval-v1 §3: an unknown shape is malformed) and shows nothing; it cannot show the spec's "Update the app to read this". The guide carries that sentence instead, and the upgrade order puts phones first so it never happens to an owner who follows it. An updated app that is not in `keys`, or whose wrap does not open, shows the row with the clear facts it has (node, kind, time left) and one line, `Sealed for this node's other phones. Run device apply on <node> for this phone.`, with no Allow, Deny or answer.
- **R-SP-7, audit entries.** `approval.request` keeps `envelope`, which is now the sealed envelope: the ledger and the mirror hold ciphertext where they held parameters. `lease.requested` and `lease.granted` drop `name` and `sites` and keep `lease_id`, `kind`, `request_id`, `apps`, `minutes`, `credentials`, `allows`, `usd`, `resumes`. Entries stay plain JSON hashed over JCS, so the mirror's chain check (approval-v1 §3.6) is untouched. `tier.decision`'s and `src/fleet/fleet-tools.js`'s `params_sha256` (an unsalted hash of a call's parameters, PRIVACY.md) becomes `params_hmac` in new entries: HMAC-SHA256 under a key only the node holds, derived from its box key's private scalar by HKDF (info `kl-audit-params-v1`), so a relay cannot guess a short parameter from it (controller's ruling). Old entries keep their field; the chain is unaffected.
- **R-SP-8, frame budget.** A sealed view carries the JPEG base64 inside JSON inside base64url: 16/9 of the raw size. Under sealing the live view caps the raw frame at `SEALED_FRAME_MAX_BYTES = 138240` (135 KiB), under the configured `max_frame_bytes`, so the view stays ≤ 256 KiB (`VIEW_MAX_BYTES`, the mailbox cap and the phones' check). PRIVACY.md says 135 KB.
- **R-SP-9, listings.** `kl.lease.listing` stays fully clear (`lease_id`, `seq`, `nonce`, `to_device`); a status's clear part keeps `lease_id`, `seq`, `state`, `contact_token`, `granted_by`, `kind`, `unattended`, so `verifyLeaseListing` and the "could not confirm" rule work without opening anything, and a relay can neither hide a lease nor read a name.
- **R-SP-10, box key enrollment** mirrors the read key exactly: `device.box_key` in `kl.device.enroll` (a P-256 JWK, not `public_key`'s point, not `read_key`'s); `kl.device.box_key` `{ v, type, device_id, box_key, created_at, expires_at (≤ 7 days), nonce }`, device-key signed; `POST /v1/devices/box-key` (auth `read`); node method `device.box_key`; states `box-key-pending-apply`, `applied`, `duplicate`, `rejected`, `offline`, `stale`; records keep `box_key`, `box_key_at`; fingerprint `b-` + the device id's rule. The relay stores nothing of a box key (it never seals); phones re-send a statement to nodes that answered `offline` until it expires, as the Android read key does. Both apps get the statement flow (iOS has none today).
- **R-SP-11, doctor.** Two rows: `sealing to phones` (`on (N phones)` or `off: no phone has a box key yet`) and `phones without a box key` (fingerprints, or `none`).
- **R-SP-12, CI.** `test.yml` gets two jobs: `swift test` in `mobile/ios/KLProtocol` on `macos-latest`, and `./gradlew :protocol:test` under JDK 17 on `ubuntu-24.04`. They are the only compile check of the phone cores against the vectors. The Swift job cannot be run from this machine; its first green run is the proof.
- **R-SP-13, upgrade order** (the guide): phone apps first; then the relay or front door (it adds the route; an older one answers `404` and the app retries later); then each node; then `device apply` on each node, which is when that node starts sealing. A node upgraded before its `device apply` stays clear.
- **R-SP-14, part B and C interfaces.** `SEAL_SPLIT` in `src/approvals/seal.js` is the one table of which keys of a type are content; `tests/sealed-types.test.js` fails for any type registered with `registerMessageValidator` that is node→phone or phone→node content and has no entry, so `kl.window.enroll` (part B) and the chat grant card (part C, a lease kind, sealed by Task 7 with no new work) are born sealed.

### What the spec does not cover, or gets wrong

- §14 says the node "seals content to each enrolled device separately". Sealing the content once per device would put a 256 KiB action times eight over the 1 MiB link frame; R-SP-1 wraps one content key per device instead, which is the same guarantee.
- §14 names only `lease.requested`/`lease.granted` as the audit mirror's leak. Today's `approval.request` entry holds the whole request envelope, parameters included; a seal on the wire alone would leave every parameter in the mirror. R-SP-7 closes it because the audited envelope is the sealed one.
- §14's "Update the app to read this" cannot be shown by an app that needs updating (R-SP-6).
- §14 says the node's identity key signs over the ciphertext but not what the phone replies to; R-SP-3 adds the node box key, which the spec's Ed25519 identity cannot replace.
- `tier.decision.params_sha256` (an unsalted hash over a call's parameters, in the mirrored ledger) is guessable for a short parameter and is in PRIVACY.md's list, though §14 does not name it. R-SP-7 makes it keyed. `Tool#auditParameters` and the `Type`/`Key` reduced forms keep deciding what goes in.

---

## File map

Create:
- `src/approvals/seal.js`: the format (R-SP-1), salted hashes, the split table, open and seal.
- `src/approvals/node-box-key.js`: the node's P-256 box key, stored with the identity.
- `src/approvals/seal-policy.js`: recipients and the on/off rule (R-SP-5).
- `tests/approvals-seal.test.js`, `tests/approvals-box-key.test.js`, `tests/approvals-node-box-key.test.js`, `tests/approvals-seal-policy.test.js`, `tests/sealed-types.test.js`, `tests/mobile-sealed-phones.test.js`.
- `mobile/ios/KLProtocol/Sources/KLProtocol/Seal.swift`, `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Seal.kt`, their tests, `mobile/ios/App/BoxKey.swift`, `mobile/android/app/src/main/kotlin/com/example/kinglouie/BoxKey.kt`, `BoxKeyNodes.kt`.

Modify: `src/approvals/{messages,verify-device,approver-store,approver-admin,phone-approver,test-keys,service-wiring,relay-client}.js`, `src/service/commands/devices.js`, `src/service/doctor.js`, `src/frontdoor/{routes,node-methods}.js`, `src/channels/mobile-app-channel.js`, `src/gui/{lease-protocol,leases,live-view}.js`, `src/mesh/mesh-identity.js`, both vector generators and `keys.json`, `tests/vectors/approval-v1/phone-reference.js`, `tests/helpers/fake-phone.js`, both phone cores and apps, the protocol docs, `mobile/PRIVACY.md`, `docs/install-guide.md`, `CLAUDE.md`, `CONTEXT.md`, `.github/workflows/test.yml`.

---

### Task 1: The seal format, with vectors

**Files:**
- Create: `src/approvals/seal.js`, `tests/approvals-seal.test.js`
- Modify: `src/approvals/test-keys.js`, `tests/vectors/approval-v1/keys.json`, `tests/vectors/approval-v1/generate.js`, `tests/approvals-protocol.test.js`
- Test: `tests/approvals-seal.test.js`, `tests/approvals-protocol.test.js`

**Interfaces:**
- Produces, in `seal.js`:
  - `SEAL_SPLIT: { [type]: readonly string[] }` — the content keys per type, exactly R-SP-4's table (both directions).
  - `sealContent({ type, senderId, clear, content, recipients, ephemeral = null, random = crypto.randomBytes }) → sealed` — `recipients` is `{ [id]: jwk }` (at least one); `ephemeral` is `{ jwk, agree(jwk) → Buffer(32) }` for deterministic tests, else a fresh `crypto.createECDH('prime256v1')`. Throws `SealError('malformed')` on an off-curve recipient or an empty set.
  - `openSealed({ type, message, recipientId, agree }) → { message: full, content }` — `agree(epkJwk) → Buffer(32)` is the recipient's ECDH; the result's `message` is clear ∪ content. Throws `SealError` with `reason` `malformed` (shape), `not_recipient` (`keys` has no entry for `recipientId`), `open_failed` (a wrap or `ct` fails to open), `content_malformed` (content is not JSON, not an object, or holds a clear key).
  - `splitMessage(type, full) → { clear, content }`, `isSealedShape(type, message) → boolean` (exactly the clear keys plus `sealed`, and `sealed` well formed: `v === 1`, `epk` a P-256 JWK, `iv` 12 bytes, `ct` ≥ 16 bytes, `keys` a non-empty object of device or node ids to 48-byte values).
  - `newSalt() → b64url(32)`, `saltedHash(saltB64url, value) → b64url(SHA-256(raw(salt) ‖ JCS(value)))`.
  - `boxKeyFingerprint(jwk) → 'b-xxxx xxxx xxxx xxxx'`.
  - `SealError`.
- `test-keys.js`: `TEST_DEVICE_KEYS` gains `A_box`, `B_box` (`box_key: true`, `device_id` of A / B); `hasTestKey(holder)` also checks `holder.box_key`; `TEST_NODE_BOX_KEYS` (the JWK of `web-01`'s box key) and `isTestNodeBoxKey(jwk)`.
- `keys.json`: `devices.A_box`, `devices.B_box` (`{ d, jwk, box_key_of, fingerprint }`), `nodes['web-01'].box` (`{ d, jwk }`).
- Vectors (consumers `['node']` here; Tasks 8 and 9 add `android` and `ios`): `seal-open`, `seal-not-recipient`, `seal-tampered-ct`, `seal-tampered-clear`, `seal-hash-mismatch`. Shape `{ given: { box: { device_id, d }, type }, input: <sealed message object>, expect: { reason: null | 'not_recipient' | 'open_failed' | 'action_hash_mismatch', message: <full> | null } }`.

- [ ] **Step 1: Write the failing tests** in `tests/approvals-seal.test.js`:

```js
it('seals to two phones and the node, and each opens to the same full message', ...)  // content equals, clear keys untouched
it('a wrap for a device that is not in keys is not_recipient', ...)
it('a flipped byte in ct, or a changed clear field, is open_failed', ...)       // AAD binding
it('the same clear part cannot be reused with another message's sealed object', ...)
it('saltedHash differs for the same action under two salts and matches the vector', ...)
it('isSealedShape refuses sealed plus any content key, and a keys entry that is not 48 bytes', ...)
it('boxKeyFingerprint is b- and the device-id rule over 0x04||x||y', ...)
it('SEAL_SPLIT names exactly the six types of the spec table', ...)
```

- [ ] **Step 2: Run** `node --test tests/approvals-seal.test.js`; expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/approvals/seal.js`** with the signatures above. ECDH: `crypto.createECDH('prime256v1')`, `computeSecret(Buffer.concat([0x04, x, y]))` (32 bytes); HKDF: `crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32)`; GCM: `createCipheriv('aes-256-gcm', key, iv)` with `setAAD`. Verify every tag before trusting any byte; open the wrap before `ct`.
- [ ] **Step 4: Add the keys and the five vectors** to `keys.json` and `generate.js` (deterministic: `epk` from `p256(sha('seal epk ' + label))`, `cek` and `iv` from `sha(label)`), extend `test-keys.js`, add the names to `EXPECTED` in `tests/approvals-protocol.test.js` and run them through `openSealed` with the vector's `d`. Run `node tests/vectors/approval-v1/generate.js` then `--check`; expected: `54 vectors match`.
- [ ] **Step 5: Run** `node --test tests/approvals-seal.test.js tests/approvals-protocol.test.js tests/approvals-verify-device.test.js`; expected: pass, `# fail 0`.
- [ ] **Step 6: Commit** `feat(approvals): the seal format, salted hashes and the first vectors`.

### Task 2: The box key on the node: records, enrollment, statement, staging, apply, CLI, doctor

**Files:**
- Modify: `src/approvals/messages.js` (`isDevice`, `VALIDATORS['kl.device.box_key']`, `BOX_KEY_MAX_MS`, `boxKeyFingerprint` re-export), `src/approvals/approver-store.js` (`checkApproverRecord`, `judgeBoxKey`, `STAGED_TYPES`, `stage`), `src/approvals/approver-admin.js` (apply order and words), `src/approvals/service-wiring.js` (the `device.box_key` inbound method), `src/approvals/relay-client.js` (`F3_METHODS`, `NODE_INBOUND`), `src/service/commands/devices.js` (`enroll-device`, `device list`, `device apply` lines), `src/service/doctor.js`
- Create: `tests/approvals-box-key.test.js`
- Modify tests: `tests/service-cli-devices.test.js`, `tests/frontdoor-doctor.test.js` or `tests/service-doctor-hosting.test.js` (whichever holds the approvers rows), `tests/vectors/approval-v1/generate.js`, `tests/approvals-protocol.test.js`

**Interfaces:**
- Consumes: `boxKeyFingerprint`, `hasTestKey` (Task 1).
- Produces: approver record keys `box_key` (JWK) and `box_key_at` (timestamp; `box_key_at` without `box_key` is invalid; `box_key` equal to `public_key` or `read_key` is invalid). `judgeBoxKey(record, message, { allowTestKeys }) → null | 'same_point' | 'test_key' | 'applied' | 'stale'`. `ApproverStore#stage` answers `{ state: 'box-key-pending-apply' | 'applied' | 'duplicate' | 'rejected', reason? }` for `kl.device.box_key` with the read key's rule order; `device apply` result `box key set` (audited `device.box_key_set`) or `rejected: <reason>`, applied after read keys, newest first. `enroll-device` prints ` with a box key b-…`; `device list` shows `box key b-…`. Doctor rows per R-SP-11.
- Vectors (`node`): `enroll-console-box-key`, `enroll-console-box-key-equal` (equal to `read_key`: `malformed`), `enroll-signed-box-key` (`expect.staged_box_keys`), `box-key-valid`, `box-key-wrong-signer` (signed by the read key: `bad_signature`), `box-key-stale`.

- [ ] **Step 1: Write the failing tests** in `tests/approvals-box-key.test.js`, mirroring `tests/approvals-read-key.test.js`:

```js
it('a device with box_key enrolls and the record holds box_key and box_key_at', ...)
it('a box_key equal to public_key or read_key is malformed', ...)
it('a kl.device.box_key signed by the device key stages box-key-pending-apply; by the read key bad_signature', ...)
it('a statement not newer than box_key_at is stale; one already held is applied', ...)
it('the relay cannot force a downgrade: no staged type and no apply result ever removes box_key, and a statement with box_key null is malformed', ...)
it('a published box test key is refused test_key unless allowTestKeys', ...)
```

- [ ] **Step 2: Run** `node --test tests/approvals-box-key.test.js`; expected: FAIL (`validateMessage` says `malformed` for the new type).
- [ ] **Step 3: Implement** the record fields, validator, `judgeBoxKey`, staging and apply, the CLI words and the doctor rows (`'sealing to phones'`, `'phones without a box key'`; the second lists `fingerprintGroups(device_id)` of active records with no `box_key`).
- [ ] **Step 4: Add the six vectors** to `generate.js` and `EXPECTED`; regenerate; `--check` expected `60 vectors match`.
- [ ] **Step 5: Run** `node --test tests/approvals-box-key.test.js tests/approvals-protocol.test.js tests/approvals-approver-store.test.js tests/approvals-read-key.test.js tests/service-cli-devices.test.js tests/approvals-service-wiring.test.js`; expected `# fail 0`.
- [ ] **Step 6: Commit** `feat(approvals): the box key enrolls, is stated, staged and applied like the read key`.

### Task 3: The relay forwards a box key statement

**Files:**
- Modify: `src/frontdoor/routes.js` (`POST /v1/devices/box-key`, `BOX_KEY_STATES`), `tests/frontdoor-phone-routes.test.js` (`ROUTE_AUTH` row `['POST', '/v1/devices/box-key', 'read']`), `tests/mobile-android-relay-keys.test.js` and `tests/mobile-android-slim.test.js` only if their spec table is literal (add the row there too)
- Test: `tests/frontdoor-phone-routes.test.js`, `tests/frontdoor-relay.test.js` (the box-key cases beside its `/v1/devices/read-key` cases)

**Interfaces:**
- Produces: route `POST /v1/devices/box-key`, body a device-key `kl.device.box_key`, checks in order `malformed`, `bad_box_key` (not the caller's, or not device-key signed), `from_the_future`, `expired`, `forbidden` (active nowhere), then forwards `device.box_key { envelope }` to every node the device is active on and answers `{ nodes: [{ node_id, state }] }` with `state` one of `BOX_KEY_STATES` or `offline`. The relay writes nothing to its device registry.

- [ ] **Step 1: Write the failing tests**: the route exists with auth `read`; a valid statement reaches each active node and the reply carries each node's state; an offline node is `offline`; a statement signed by the read key is `400 bad_box_key`; `GET /v1/devices` is unchanged (no box key echoed).
- [ ] **Step 2: Run** `node --test tests/frontdoor-phone-routes.test.js`; expected: FAIL on the `ROUTE_AUTH` comparison.
- [ ] **Step 3: Implement** the route next to `/v1/devices/read-key`, without `devices.set…` (nothing stored).
- [ ] **Step 4: Run** the two test files; expected `# fail 0`.
- [ ] **Step 5: Commit** `feat(relay): POST /v1/devices/box-key forwards a phone's box key to its nodes`.

### Task 4: The node box key and the seal policy

**Files:**
- Create: `src/approvals/node-box-key.js`, `src/approvals/seal-policy.js`, `tests/approvals-node-box-key.test.js`, `tests/approvals-seal-policy.test.js`
- Modify: `src/mesh/mesh-identity.js` (`serializeIdentity`/`deserializeIdentity` carry `boxKeyJwk` and `encryptedBoxKey`), `src/mesh/node-identity.js` (`getOrGenerateNodeIdentity` fills a missing box key and saves), `src/approvals/service-wiring.js` (builds the policy and hands it to the approver, the channel and the lease manager), `tests/helpers/fake-phone.js` (`testNodeIdentity({ box: true })`, `createFakePhone({ boxKey: true })` with `phone.boxJwk`, `phone.open(envelope, type)`, `phone.boxStatement()`)

**Interfaces:**
- Produces: `identity.box = { jwk, agree(epkJwk) → Buffer(32) }` on every `NodeIdentity` built through `getOrGenerateNodeIdentity` (generated once; the private scalar is stored under the host cipher as the Ed25519 key is; an identity loaded from a record without a box key gets one and the record is rewritten). `createSealPolicy({ approverStore, identity }) → { sealing(): boolean, recipients(): { [id]: jwk }, senderId: identity.nodeId, nodeBox: identity.box.jwk }`; `recipients()` is R-SP-5's set; a store that is untrusted gives `{}` and `sealing() === false`.
- Consumed later by `buildRequest`, `MobileAppChannel`, `LeaseManager`, `LiveView` as `sealPolicy`.

- [ ] **Step 1: Write the failing tests**: a fresh identity has a box key and a second load returns the same JWK; the private half is not in the stored record in clear (the record's JSON holds no `d`); `recipients()` holds exactly the active records with `box_key` plus the node; a revoked record (overlay) is left out; `sealing()` flips to true with the first such record and back to false when it is revoked; an untrusted store gives nothing.
- [ ] **Step 2: Run** the two new test files; expected: FAIL.
- [ ] **Step 3: Implement** both modules and the wiring; the fake phone's `open` uses Task 1's `openSealed` with its software box key.
- [ ] **Step 4: Run** `node --test tests/approvals-node-box-key.test.js tests/approvals-seal-policy.test.js tests/mesh-identity.test.js tests/mesh-identity-at-rest.test.js tests/mesh-identity-preservation.test.js tests/approvals-service-wiring.test.js tests/approvals-fake-phone.test.js`; expected `# fail 0`.
- [ ] **Step 5: Commit** `feat(approvals): the node box key and the seal policy`.

### Task 5: Sealed tool approvals, end to end on the node and the relay

**Files:**
- Modify: `src/approvals/messages.js` (`buildRequest({ …, sealPolicy })`, `VALIDATORS['kl.approval.request']` accepts the sealed shape through `isSealedShape`, `actionHash({ salt })`), `src/approvals/phone-approver.js` (pending entry keeps `salt`; step 12 and the second pass recompute with it; `pending()` reads the clear summary or `(sealed)`), `src/frontdoor/approval-cache.js` and `src/frontdoor/node-methods.js` (no change expected: the validator accepts both shapes; a test pins it), `tests/vectors/approval-v1/phone-reference.js` (`phoneView(envelope, { pinned, box })` opens a sealed request with the vector's box `d` before building the display), `tests/vectors/approval-v1/generate.js`, `tests/approvals-protocol.test.js`, `tests/approvals-phone-approver.test.js`, `tests/frontdoor-stores.test.js` (the approval cache) and `tests/frontdoor-relay.test.js` (`approval.submit` with a sealed request)
- Create: `tests/sealed-types.test.js`

**Interfaces:**
- Consumes: `sealContent`, `openSealed`, `saltedHash`, `SEAL_SPLIT` (Task 1); `createSealPolicy` (Task 4).
- Produces: `buildRequest` returns `{ message, envelope, bytes, salt }` where `salt` is `null` in clear mode; the sealed message's clear part carries `node_box`. `PhoneApprover` takes `sealPolicy` (optional; none means clear). The audit `approval.request` entry holds the sealed envelope. `tests/sealed-types.test.js`: every type in `SEAL_SPLIT` has a validator accepting its sealed shape, and every registered content type (the list in the test: the six of R-SP-4) is in `SEAL_SPLIT`.
- Vectors: `request-sealed-display` (`node`; phones later: `given.pinned_nodes`, `given.box`; `expect.display` equals the clear `request-display` for the same action), `response-approve-sealed` (`given.pending` carries `salt`: accepted), `response-reject-sealed-changed-parameter` (`action_changed`), `response-reject-sealed-hash-unsalted` (a response whose `action_hash` is the unsalted hash: `action_hash_mismatch`).

- [ ] **Step 1: Write the failing tests** in `tests/approvals-phone-approver.test.js`:

```js
it('with no box key anywhere the request is the clear shape and bytes match today's builder', ...)
it('with one phone holding a box key the request is sealed, both phones and the node are in keys, and only the box holder opens the action', ...)
it('a sealed request's action_hash is the salted hash and a response over it is accepted', ...)
it('a response over the unsalted hash is action_hash_mismatch', ...)
it('a changed parameter under sealing is action_changed on the salted re-check', ...)
it('a box key applied while a clear request is pending leaves that request's check unsalted and seals the next', ...)
it('a device revoked after the request is refused revoked_device even though its wrap is in keys', ...)
it('the approval.request audit entry holds the sealed envelope and no action key', ...)
it('the relay cache accepts a sealed request and lists it; its view carries no action', ...)
```

- [ ] **Step 2: Run** `node --test tests/approvals-phone-approver.test.js`; expected: FAIL.
- [ ] **Step 3: Implement**: `buildRequest` splits with `splitMessage`, computes the salted hash, seals to `sealPolicy.recipients()`, adds `node_box`; the validator accepts `isSealedShape('kl.approval.request', m)`; the approver stores `salt` on the entry and `currentAction` hashing uses it.
- [ ] **Step 4: Add the four vectors**, extend `phone-reference.js`, regenerate; `--check` expected `64 vectors match`.
- [ ] **Step 5: Run** `node --test tests/approvals-*.test.js tests/frontdoor-stores.test.js tests/frontdoor-relay.test.js tests/sealed-types.test.js tests/core-remote-approvals.test.js tests/mcp-stdio-approvals.test.js`; expected `# fail 0`.
- [ ] **Step 6: Commit** `feat(approvals): tool approvals are sealed once a phone has a box key`.

### Task 6: Sealed questions, both directions

**Files:**
- Modify: `src/channels/mobile-app-channel.js` (`sendContact` seals per R-SP-4 with `sealPolicy`; `validateAnswerMessage` accepts the sealed shape; `handleAnswer` opens with `identity.box.agree` and validates the full message; `node_box` on the ask), `src/frontdoor/question-routes.js` (no change: it reads `type`, `device_id`, `token`, `node_id`; a test pins it), `tests/contact-mobile.test.js`, `tests/vectors/approval-v1/generate.js`, `tests/approvals-protocol.test.js`
- Vectors: `question-ask-sealed` (`given.box`: opens to the clear ask; the clear part has no `text`), `question-answer-sealed` (node opens with `web-01`'s box `d`; `expect.message` is the full answer; a phone later builds it from `given.ask` and `given.answer`).

**Interfaces:**
- Consumes: `sealContent`, `openSealed`, `createSealPolicy`.
- Produces: `MobileAppChannel({ …, sealPolicy })`; the ask's clear part carries `node_box`; an answer whose `sealed` does not open is refused `open_failed` before `unknown_question`, and an answer with a clear `answer` key on a sealing node is still accepted (an older phone answering an older clear ask; the node never refuses a well-formed clear answer).

- [ ] **Step 1: Write the failing tests** in `tests/contact-mobile.test.js`: a sealing node's ask has no `text`, `case_title` or `options` in clear; the fake phone opens it; a sealed answer is accepted and `ownerProven`; a sealed answer with its `token` changed in clear is refused (AAD); the relay route forwards a sealed answer unchanged.
- [ ] **Step 2: Run** `node --test tests/contact-mobile.test.js`; expected: FAIL.
- [ ] **Step 3: Implement**; the ask's `node_box` is `sealPolicy.nodeBox`.
- [ ] **Step 4: Add the two vectors**, regenerate; `--check` expected `66 vectors match`.
- [ ] **Step 5: Run** `node --test tests/contact-mobile.test.js tests/approvals-protocol.test.js tests/frontdoor-phone-routes.test.js`; expected `# fail 0`.
- [ ] **Step 6: Commit** `feat(contact): questions and their answers are sealed`.

### Task 7: Sealed leases: request, status, view, salted lease hash, frame budget, audit entries

**Files:**
- Modify: `src/gui/lease-protocol.js` (`buildLeaseRequest/Status/View({ …, sealPolicy })`, validators accept sealed shapes, `leaseHash(lease, salt = null)`, `verifyLeaseGrant` re-checks with `pending.get(id).salt`, `openNodeStatus`/`verifyLeaseView`/`verifyLeaseListing` take an optional `open` for tests), `src/gui/leases.js` (`_sendRequest` keeps `salt` on the entry; `_signStatus` seals `name`; `_audit` drops `name` and `sites` per R-SP-7), `src/gui/live-view.js` (`SEALED_FRAME_MAX_BYTES`, the second capture targets it under sealing), `src/gui/index.js` (passes `sealPolicy`), `tests/gui-leases.test.js`, `tests/gui-live-view.test.js`, `tests/vectors/lease-v1/generate.js`, `tests/lease-vectors.test.js`
- Vectors (lease-v1): `request-sealed` (phones later build the grant over the salted hash), `grant-to-sealed` (node accepts), `grant-sealed-lease-changed` (`lease_changed`), `status-sealed` (`expect.status` holds `name` after opening), `view-sealed` (opens; frame hash checked on the opened frame), `listing-with-sealed-status` (a listing over a sealed status passes with nothing opened).

**Interfaces:**
- Consumes: Tasks 1 and 4.
- Produces: `LeaseManager({ …, sealPolicy })`; `LiveView` reads `this.leases.sealPolicy`; `SEALED_FRAME_MAX_BYTES = 138240`. Audit `lease.requested`/`lease.granted` data keys: `job_id, lease_id, kind, request_id, apps, minutes, resumes` plus for a take `credentials`, for a task `allows, usd`.

- [ ] **Step 1: Write the failing tests** in `tests/gui-leases.test.js`: a sealing node's request has no `lease` in clear and `lease_hash` is salted; the fake phone opens it and its grant is accepted; a grant over the unsalted hash is `lease_hash_mismatch`; the status's clear part has no `name` and `verifyLeaseListing` passes over it; the audit entries hold no `name` or `sites`; a take and a task request seal the same way. In the live-view test: under sealing a 170 KiB frame is re-captured and, still over, dropped with `frame_dropped: true`, and the sealed view is ≤ 262144 bytes. For R-SP-7's audit hash (`src/approvals/executor-options.js:120`, `src/fleet/fleet-tools.js:476`): a new `tier.decision` entry holds `params_hmac` and no `params_sha256`, two nodes give different values for the same parameters, and the value is not the plain SHA-256.
- [ ] **Step 2: Run** `node --test tests/gui-leases.test.js`; expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Add the six vectors**, regenerate `lease-v1`; `--check` expected `86 vectors match`; add the names to `EXPECTED` (not yet `PHONE`).
- [ ] **Step 5: Run** `node --test tests/gui-*.test.js tests/lease-vectors.test.js tests/take*.test.js tests/tasks-*.test.js tests/frontdoor-doctor.test.js`; expected `# fail 0`.
- [ ] **Step 6: Commit** `feat(gui): lease requests, statuses and views are sealed; names leave the audit`.

### Task 8: The Android protocol core

**Files:**
- Create: `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Seal.kt`, `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/SealVectorTest.kt`
- Modify: `Messages.kt` (`Rules.request` accepts the sealed shape; `device(…, boxKey)`; `boxKeyStatement`; `boxKeyFingerprint`), `Questions.kt` (`QuestionItem.from(message, open)`, `Questions.answer(…, sealTo: nodeBox)`), `Lease.kt` (`LeaseRequest.from`, `LeaseStatus.from`, `verifyView` take an opener; `grant` over the request's salted `lease_hash` as received), `Display.kt` (`view(envelope, pinned, open)`), `ProtocolVectorTest.kt`, `LeaseVectorTest.kt`, `QuestionTest.kt`; `tests/vectors/approval-v1/generate.js` and `tests/vectors/lease-v1/generate.js` (add `android` to the consumers of `seal-*`, `request-sealed-display`, `enroll-console-box-key`, `box-key-valid`, `question-ask-sealed`, `question-answer-sealed`, `request-sealed`, `status-sealed`, `view-sealed`, `listing-with-sealed-status`), `tests/lease-vectors.test.js` (`PHONE`/`ANDROID` lists)

**Interfaces:**
- Produces: `object Seal { fun open(type: String, message: JsonObject, recipientId: String, agree: (x: String, y: String) -> ByteArray): JsonObject; fun seal(type: String, senderId: String, clear: JsonObject, content: JsonObject, recipient: Pair<String, JsonObject>): JsonObject; fun saltedHash(salt: String, value: JsonElement): String; fun isSealedShape(type: String, message: JsonObject): Boolean }`. HKDF over `Mac("HmacSHA256")` (extract with a zero-length salt, one expand block); ECDH for tests over a software `KeyAgreement("ECDH")` from the vector's `d`; AES/GCM/NoPadding with `updateAAD`. Phone-side reasons `not_recipient`, `open_failed`, `action_hash_mismatch`, `lease_hash_mismatch`.

- [ ] **Step 1: Write the failing tests**: `SealVectorTest` runs every vector whose consumers include `android` and whose name starts with `seal-`, `request-sealed`, `question-`, `box-key-valid`, `enroll-console-box-key`; the lease test runs `request-sealed` (build the grant, compare `expect.message` bytes), `status-sealed`, `view-sealed`, `listing-with-sealed-status`. The consumers sets in both test files list the new names.
- [ ] **Step 2: Flip the consumers** in both generators, regenerate, `--check` both (`66`, `86`); run `node --test tests/approvals-protocol.test.js tests/lease-vectors.test.js` (expected `# fail 0`), then `cd mobile/android/protocol && ../gradlew test`; expected: the new tests FAIL to compile.
- [ ] **Step 3: Implement** the Kotlin.
- [ ] **Step 4: Run** `../gradlew test`; expected: `BUILD SUCCESSFUL`, every test passed. (Needs JDK 17; if none is on this machine, say so in the commit body and leave the CI job of Task 12 as the proof.)
- [ ] **Step 5: Commit** `feat(android): the protocol core opens sealed messages and seals answers`.

### Task 9: The iOS protocol core

**Files:**
- Create: `mobile/ios/KLProtocol/Sources/KLProtocol/Seal.swift`, `mobile/ios/KLProtocol/Tests/KLProtocolTests/SealVectorTests.swift`
- Modify: `Messages.swift`, `Questions.swift`, `Lease.swift`, `Display.swift` (the same surface as Task 8 in Swift), `ProtocolVectorTests.swift`, `LeaseVectorTests.swift`, `QuestionTests.swift`; both generators (add `ios` to the same vectors' consumers, except `box-key-valid`'s read-key sibling rules: iOS consumes `enroll-console-box-key` and `box-key-valid`, since iOS gets the statement flow), `tests/lease-vectors.test.js` (`PHONE`)

**Interfaces:**
- Produces: `public enum Seal { static func open(type:message:recipientId:agree:) throws -> JSONValue; static func seal(type:senderId:clear:content:recipient:) throws -> JSONValue; static func saltedHash(salt:value:) -> String; static func isSealedShape(type:message:) -> Bool }` over CryptoKit (`P256.KeyAgreement`, `HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount:)`, `AES.GCM.open(_:using:authenticating:)`). The test's `agree` uses `P256.KeyAgreement.PrivateKey(rawRepresentation:)` from the vector's `d`.

- [ ] **Step 1: Write the tests** (the Swift mirrors of Task 8's), flip `ios` into the consumers, regenerate, `--check` both, run `node --test tests/approvals-protocol.test.js tests/lease-vectors.test.js`; expected `# fail 0`.
- [ ] **Step 2: Implement** the Swift.
- [ ] **Step 3: Verify what can be verified here**: `node --test tests/approvals-protocol.test.js tests/lease-vectors.test.js` passes; `swift test` is not run on this machine. The commit body says so; Task 12's macOS job is the first compile.
- [ ] **Step 4: Commit** `feat(ios): the protocol core opens sealed messages and seals answers (not compiled here)`.

### Task 10: The Android app

**Files:**
- Create: `mobile/android/app/src/main/kotlin/com/example/kinglouie/BoxKey.kt`, `BoxKeyNodes.kt`, `tests/mobile-sealed-phones.test.js`
- Modify: `DeviceKey.kt` (creates the box key beside the read key), `AppModel.kt` (opens approvals, questions, lease requests, statuses and views; the unreadable row; the statement flow for an enrolled phone), `RelayApi.kt` (`postBoxKey`), `Screens.kt`/`DetailScreens.kt`/`SettingsScreen.kt` (the row and the Settings line), `OwnerText.kt`, `tests/mobile-android-relay-keys.test.js` (the new route's key)

**Interfaces:**
- Produces: `class BoxKey` with `ALIAS = "kl.box-key"`, `KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)`, `secp256r1`, `setUserAuthenticationRequired(false)`, `setUnlockedDeviceRequired(true)`, `setIsStrongBoxBacked(true)` with fallback to the TEE on `StrongBoxUnavailableException` and on a `ProviderException` from the first `KeyAgreement`; `fun agree(x: String, y: String): ByteArray` (`KeyAgreement.getInstance("ECDH", "AndroidKeyStore")`); `jwk`, `fingerprint`; `load()`, `create()`, `delete()`. Opening throws `BoxKeyUnavailableException` while locked (the row says `Unlock to read`). Minimum OS: `PURPOSE_AGREE_KEY` is API 31; the app's `minSdk` is 33, so nothing is below it; a phone whose Keystore refuses the key altogether enrolls without one and Settings says `This phone cannot hold a box key; sealed nodes will not show here.`

- [ ] **Step 1: Write `tests/mobile-sealed-phones.test.js`** (source pins, as `tests/mobile-lease-apps.test.js` does): `BoxKey.kt` uses `PURPOSE_AGREE_KEY`, `setUserAuthenticationRequired(false)`, `setUnlockedDeviceRequired(true)`; `DeviceKey.create` makes a box key; the enrollment `device` carries `box_key`; the statement is signed with `DeviceKey` (not `ReadKey`); `RelayApi` posts to `/v1/devices/box-key` as `ROUTE_AUTH` says; a sealed item that does not open has no `APPROVE`/`DENY` button (`ApprovalList` gets `sealedUnreadable`); the words `Sealed for this node's other phones` and `Run device apply on` appear once in `OwnerText.kt`.
- [ ] **Step 2: Run** `node --test tests/mobile-sealed-phones.test.js`; expected: FAIL.
- [ ] **Step 3: Implement** the Kotlin; `BoxKeyNodes.kt` mirrors `ReadKeyNodes.kt` (re-send to `offline` nodes until the statement expires).
- [ ] **Step 4: Run** `node --test tests/mobile-sealed-phones.test.js tests/mobile-android-*.test.js tests/mobile-lease-apps.test.js`; expected `# fail 0`. The app module has no test target and is not built here.
- [ ] **Step 5: Commit** `feat(android): the box key, the statement flow and sealed rows`.

### Task 11: The iOS app

**Files:**
- Create: `mobile/ios/App/BoxKey.swift`
- Modify: `DeviceKey.swift` (creates the box key at pairing), `AppModel.swift` (opens everything the phone shows; the unreadable row; the statement flow, new on iOS), `RelayAPI.swift` (`postBoxKey`), `Views.swift`/`LeaseViews.swift`/`Questions.swift` (the row and Settings line), `tests/mobile-sealed-phones.test.js` (the iOS pins)

**Interfaces:**
- Produces: `BoxKey` over `SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl:)` with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `[.privateKeyUsage]` only (no biometry flag), its `dataRepresentation` in the keychain beside the device key's; `func agree(x:y:) throws -> Data` (`sharedSecretFromKeyAgreement(with:)` raw 32 bytes); minimum iOS 13 for the API, the app is iOS 17. A phone without a Secure Enclave is already refused at pairing.

- [ ] **Step 1: Add the iOS pins** to `tests/mobile-sealed-phones.test.js`: `BoxKey.swift` uses `SecureEnclave.P256.KeyAgreement`, no `.biometryCurrentSet`; the statement is signed with `signEnvelope` (a fresh prompt); the unreadable row has no Allow/Deny.
- [ ] **Step 2: Run**; expected: FAIL. **Step 3: Implement.** **Step 4: Run** `node --test tests/mobile-sealed-phones.test.js tests/mobile-lease-apps.test.js`; expected `# fail 0`; Swift is not compiled here (say so in the commit body).
- [ ] **Step 5: Commit** `feat(ios): the box key, the statement flow and sealed rows (not compiled here)`.

### Task 12: Docs, CI, the full suite

**Files:**
- Modify: `docs/protocol/approval-v1.md` (section "Revised 2026-11-04: sealed phones": R-SP-1 to R-SP-6 and R-SP-10 as the format, the per-type table, the phone's checks and refusals, the route, the vectors table and the new count), `docs/protocol/lease-v1.md` (its revision: sealed request/status/view, salted `lease_hash`, the listing unchanged, the frame cap, vectors), `mobile/PRIVACY.md` (rewrite "What the relay operator can see": what is sealed, what stays in clear per R-SP-4's residuals, 135 KB frames, the mirrored audit; add "The box key" beside "The read key"), `docs/install-guide.md` (section 13 step 3 and a new "Sealing to your phone" note: the upgrade order of R-SP-13, `device apply` for box keys, doctor's rows, and that an app that shows nothing for a node needs updating), `CLAUDE.md` ("Approvals and relay": the box key, the seal, the switch, the vector counts `66` and `86`, the CI jobs; "Session helper": the frame cap and sealed statuses; "Tasks": the card is sealed), `CONTEXT.md` (words **Box key** and **Sealed**, with _Avoid_ lines), `.github/workflows/test.yml` (R-SP-12's two jobs)
- Test: `tests/docs-driving.test.js` and `tests/docs-front-door.test.js` (they pin parts of the guide and the protocol docs; keep them green); `npm test`.

- [ ] **Step 1: Write the docs** in the files above; every protocol statement matches `seal.js` and the vectors (a reviewer reads them side by side).
- [ ] **Step 2: Add the CI jobs**: `phone-cores-android` (`ubuntu-24.04`; `actions/setup-java` at its current major with `distribution: temurin`, `java-version: 17`; `cd mobile/android/protocol && ../gradlew test --no-daemon`) and `phone-cores-ios` (`macos-latest`; `cd mobile/ios/KLProtocol && swift test`). Both run on `pull_request` and `push` to `main` like `unit`.
- [ ] **Step 3: Run** `node tests/vectors/approval-v1/generate.js --check` (`66 vectors match`), `node tests/vectors/lease-v1/generate.js --check` (`86 vectors match`), then `npm test`; expected `# fail 0`.
- [ ] **Step 4: Commit** `docs: sealed phones in the protocols, PRIVACY, the guide and CI`.

### After the last task

1. The whole-branch code review (one reviewer, the full diff against `main`).
2. **A dedicated security review** (spec §14, "a second security review, like §6's"), on the most capable model, separately from the code review, over `src/approvals/seal.js`, `seal-policy.js`, `node-box-key.js`, the sealed builders and validators, both phone cores' `Seal`, and the relay's reads. Its brief: the AAD binding, the zero-iv wrap, the salt rule, recipient selection against revoked and untrusted stores, downgrade paths, and what the relay can still learn.

---

## Self-review

- **Spec coverage.** §14's six bullets: the box key (Tasks 2, 3, 10, 11), sealing with formats and vectors (1, 5, 6, 7, 8, 9), what gets sealed (R-SP-4; every PRIVACY.md item is in a task or named as a residual), the audit mirror (R-SP-7, Task 7), phones that have not updated and the downgrade rule with a test (R-SP-6, Task 2), doctor (Task 2), the upgrade order (Task 12), push unchanged, the security review (after the last task). §2 decision 6 and §3's anti-goal are met for everything but the named residuals.
- **The eight questions the brief asked** are answered in the Rulings: 1 (R-SP-4's clear column, Task 5's relay test), 2 (R-SP-2), 3 (R-SP-3, R-SP-4's last row), 4 (R-SP-1, R-SP-8), 5 (R-SP-9), 6 (R-SP-7), 7 (R-SP-6, R-SP-10, R-SP-11, R-SP-13, Task 2's downgrade test), 8 (Tasks 8 to 12, R-SP-12).
- **Step scan.** Each test step names its tests; each implement step names its signatures and values; the vector counts are stated after each task (54, 60, 64, 66; lease 86).
- **Type consistency.** `sealContent`/`openSealed`/`SEAL_SPLIT`/`saltedHash` (Task 1) are the names Tasks 5 to 7 consume; `createSealPolicy` and `identity.box` (Task 4) are what Tasks 5 to 7 pass as `sealPolicy`; `node_box` is the clear key in every table and builder.
- **Review Focus.** Each of the five lines names its task and test.
- **Proportion.** The plan carries decisions and signatures; bodies appear only for the format (R-SP-1), which no signature determines.
