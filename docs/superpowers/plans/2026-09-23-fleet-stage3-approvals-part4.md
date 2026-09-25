# Fleet Stage 3: Signed approvals, relay and mobile app — Implementation Plan (Part 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the iOS and Android approval apps from `docs/protocol/approval-v1.md`: a protocol core per platform that passes the shared approval-v1 vectors, and apps that pair with a relay, show only what pinned nodes signed, and sign approvals, enrollments and revocations with a biometric-gated hardware key.
**Architecture:** Each platform splits into a protocol core with no UI and no network (`mobile/ios/KLProtocol`, a Swift package; `mobile/android/protocol`, a standalone JVM Gradle build included by the app) and the app itself (`mobile/ios/App` + `project.yml` for XcodeGen; `mobile/android/app` with `fcm` and `nopush` flavors). The cores read `tests/vectors/approval-v1/*.json` directly, so the node, iOS and Android are pinned to the same bytes. Builds on Parts 1–3 (merged): the vectors, the protocol document and a relay to talk to.
**Tech Stack:** iOS 17+, Swift 5.9, SwiftUI, CryptoKit (Secure Enclave, Curve25519, P256, HMAC), AVFoundation, LocalAuthentication, XcodeGen (build tool, not a runtime dependency). Android minSdk 33, Kotlin 2.0.20, Jetpack Compose (BOM 2024.09.02), AndroidX Biometric, CameraX + ZXing core, kotlinx.serialization JSON, Firebase Messaging (`fcm` flavor only), AGP 8.5.2, Gradle 8.10.2, JDK 17.
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md (§3.14, §4, §8, §10 "Mobile"). **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

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

Mobile constraints (spec §3.14, §14):

- iOS uses system frameworks only. Android's only third-party libraries are Firebase Messaging (`fcm` flavor), CameraX, ZXing core, AndroidX Biometric and kotlinx.serialization (plus Compose/AndroidX UI libraries).
- A request whose node signature fails against the pinned key, or whose `node_id` is not pinned, is **not shown**. Node keys are pinned only from a pairing or invite QR code, never from `GET /v1/nodes`.
- Time left counts from receipt (`expires_in_ms`) on a monotonic clock; the app refuses to sign at zero. The wall clock is used only for `signed_at` and API timestamps.
- Demo mode never constructs the network client (`RelayClientFactory` returns nothing outside live mode; unit-tested on both platforms).
- Bundle id, APNs topic/environment and signing live in `mobile/ios/Config/App.xcconfig`; the Android application id in `mobile/android/local.properties` (`kl.applicationId`) and FCM's `google-services.json` at `mobile/android/app/src/fcm/`, which is git-ignored. Placeholders use `example.com` / `com.example.kinglouie`.
- Protocol-core tests: `swift test` in `mobile/ios/KLProtocol` (macOS with Xcode 15+) and `../gradlew test` in `mobile/android/protocol` (JDK 17; no Android SDK needed).

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

From Parts 1–3 (merged): `docs/protocol/approval-v1.md`; `tests/vectors/approval-v1/*.json` and `keys.json` (the mobile tests read them at `../../../tests/vectors/approval-v1` relative to each protocol core); for manual device testing, a relay (`king-louie-service relay run`) and a node (`pair`, `enroll-device`).

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

- **Biometric per API call (spec contradiction, reported).** The spec gives Android's key `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` (a prompt per signature) and also requires every device-authenticated API call to be signed with that key. Polling would prompt every 25 s. Resolved without changing the wire protocol: iOS signs API calls with an `LAContext` unlocked once per foreground session (allowed by `.biometryCurrentSet`; approvals, enrollments and revocations still get a fresh prompt); Android keeps the spec's per-use key, so the app checks for requests when the owner taps "Check for requests" (one prompt per check, a long-poll of up to 25 s) and relies on FCM in the `fcm` flavor, instead of polling continuously in the `nopush` flavor. A separate non-biometric API key registered at enrollment would remove the prompt; that is a protocol change for the spec owner.
- **Relay pinning on iOS.** `SecKeyCopyExternalRepresentation` returns the raw key, not DER SPKI, so the app prefixes the standard SPKI header for P-256, P-384 and RSA 2048/3072/4096 keys before hashing; a certificate with any other key type is refused.
- **"Show all"** is built from the same message with collapsing off (`Display.build(message, collapse: false)`), so the full text shown is exactly the escaped value the vector's head and tail came from.

---

### Task 24: iOS protocol core (`KLProtocol`) against the shared vectors

**Files:**
- Create: `mobile/ios/KLProtocol/Package.swift`, `mobile/ios/KLProtocol/Sources/KLProtocol/{JSONValue,JCS,Encoding,Envelope,Messages,Display,AppCore}.swift`
- Test: `mobile/ios/KLProtocol/Tests/KLProtocolTests/ProtocolVectorTests.swift`

**Interfaces:**
- Consumes: `tests/vectors/approval-v1/*.json` and `keys.json` (Part 2, Task 10); `docs/protocol/approval-v1.md`.
- Produces (used by Task 25): `JSONValue` (numbers kept as text) and `JSONParser.parse(Data | String)`; `JCS.serialize`, `JCS.data`, `JCS.utf16Less`, `JCS.escape`; `Base64URL.encode/decode` (strict), `Hex`, `Digest.sha256/sha256B64url/sha256Hex/hmacB64url`, `Identifiers.base32/deviceId(raw:prefix:)/deviceId(x:y:)/nodeId(ed25519Raw:)/fingerprintGroups`, `Identifiers.ed25519SpkiPrefix`, `Timestamps.string/date`; `Envelope(json:)`, `.json`, `.payloadData()`, `.message()`, `.verifyEd25519(spkiHex:)`, `.verifyES256(x:y:)`, `Envelope.seal(_:alg:kid:sign:)`; `P1363.toDER/fromDER`; `Messages.device/response(to:decision:deviceId:signedAt:)/consoleEnroll/signedEnroll/revoke/inviteMac/phoneAuthString/encodeQR/decodeQR/randomNonce`; `NodePin`, `PhoneView`, `Display.view(_:pinned:)`, `Display.build(_:collapse:)`, `Display.escape`, `Display.isHidden`; `AuditSlice.verify(_:nodeKeyHex:)`; `AppMode`, `RelayClientFactory<Client>` (`client(for:)`, `built`), `DemoFleet` (`pins`, `deviceId`, `request(on:command:now:)`, `sign(_:)`); `ProtocolError` (`.malformed`, `.keyInvalidated`).

The sources import `CryptoKit` where it exists and `Crypto` otherwise (`#if canImport(CryptoKit)`), so the same files also build against swift-crypto on Linux; the package itself depends on nothing.

- [ ] **Step 1: Write the failing test**

Create `mobile/ios/KLProtocol/Package.swift`:

```swift
// swift-tools-version:5.9
// The approval-v1 protocol core shared by the iOS app. System frameworks only
// (Foundation, CryptoKit); the tests read ../../../tests/vectors/approval-v1.
import PackageDescription

let package = Package(
    name: "KLProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "KLProtocol", targets: ["KLProtocol"])
    ],
    targets: [
        .target(name: "KLProtocol"),
        .testTarget(name: "KLProtocolTests", dependencies: ["KLProtocol"])
    ]
)
```

Create `mobile/ios/KLProtocol/Tests/KLProtocolTests/ProtocolVectorTests.swift`:

```swift
import XCTest
@testable import KLProtocol
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Runs every approval-v1 vector whose consumers include "ios"
/// (tests/vectors/approval-v1, shared with the node and Android).
final class ProtocolVectorTests: XCTestCase {
    static let vectorsDir: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("tests/vectors/approval-v1")
    }()

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("\(name).json")))
    }

    func allVectors() throws -> [JSONValue] {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.vectorsDir.path)
            .filter { $0.hasSuffix(".json") && $0 != "keys.json" }
        return try files.map { try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent($0))) }
    }

    func testEveryIosVectorIsCovered() throws {
        let names = Set(try allVectors().filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }.compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, ["jcs", "device-id-p256", "device-id-ed25519", "request-valid", "request-bad-node-signature",
                               "request-unpinned-node", "request-display", "enroll-console", "audit-slice", "phone-api-auth"])
    }

    func testJcs() throws {
        let v = try vector("jcs")
        let cases = v["input"]?["cases"]?.arrayValue ?? []
        let expected = v["expect"]?["canonical"]?.arrayValue ?? []
        XCTAssertEqual(cases.count, expected.count)
        for (c, e) in zip(cases, expected) {
            XCTAssertEqual(JCS.serialize(c), e.stringValue)
        }
    }

    func testDeviceIds() throws {
        let p = try vector("device-id-p256")
        let jwks = p["input"]?["jwks"]?.arrayValue ?? []
        let ids = try jwks.map { try Identifiers.deviceId(x: $0["x"]!.stringValue!, y: $0["y"]!.stringValue!) }
        XCTAssertEqual(ids.map { JSONValue.string($0) }, p["expect"]?["device_ids"]?.arrayValue)
        XCTAssertEqual(ids.map { JSONValue.string(Identifiers.fingerprintGroups($0)) }, p["expect"]?["grouped"]?.arrayValue)
        let e = try vector("device-id-ed25519")
        let raw = try Base64URL.decode(e["input"]!["raw"]!.stringValue!)
        XCTAssertEqual(Identifiers.deviceId(raw: raw, prefix: e["input"]!["prefix"]!.stringValue!), e["expect"]?["device_id"]?.stringValue)
    }

    func testRequestVectors() throws {
        for name in ["request-valid", "request-bad-node-signature", "request-unpinned-node", "request-display"] {
            let v = try vector(name)
            let pins = (v["given"]?["pinned_nodes"]?.arrayValue ?? []).map { NodePin(id: $0["id"]!.stringValue!, name: "", key: $0["key"]!.stringValue!) }
            let view = Display.view(v["input"]!, pinned: pins)
            XCTAssertEqual(view.json, v["expect"], name)
        }
    }

    func testShowAllKeepsEveryCharacter() throws {
        let v = try vector("request-display")
        let message = try Envelope(json: v["input"]!).message()
        let collapsed = Display.build(message)["items"]!.arrayValue!
        let full = Display.build(message, collapse: false)["items"]!.arrayValue!
        XCTAssertEqual(collapsed.map { $0["path"] }, full.map { $0["path"] })
        let script = full.first { $0["path"]?.stringValue == "params.script" }!
        XCTAssertEqual(script["hidden"], .number("0"))
        XCTAssertEqual(script["text"]?.stringValue, message["action"]!["params"]!["script"]!.stringValue)
    }

    func testDisplayEscapesHiddenCharacters() {
        XCTAssertEqual(Display.escape("a\u{202E}b\u{200B}\n"), "a\u{2039}U+202E\u{203A}b\u{2039}U+200B\u{203A}\u{2039}U+000A\u{203A}")
        XCTAssertEqual(Display.escape("plain"), "plain")
    }

    func testAuditSlice() throws {
        let v = try vector("audit-slice")
        let result = AuditSlice.verify(v["input"]!, nodeKeyHex: v["given"]!["node"]!["key"]!.stringValue!)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.entries.count, v["expect"]?["entries"]?.intValue)
        XCTAssertFalse(AuditSlice.verify(v["input"]!, nodeKeyHex: Identifiers.ed25519SpkiPrefix + String(repeating: "00", count: 32)).ok)
    }

    func testPhoneApiAuth() throws {
        let v = try vector("phone-api-auth")
        let g = v["given"]!
        let s = Messages.phoneAuthString(method: g["method"]!.stringValue!, pathWithQuery: g["path"]!.stringValue!,
                                         timestamp: g["timestamp"]!.stringValue!, body: Data(g["body"]!.stringValue!.utf8))
        XCTAssertEqual(s, v["expect"]?["signing_string"]?.stringValue)
        let env = Envelope(alg: "ES256", kid: g["device"]!["device_id"]!.stringValue!, payload: Base64URL.encode(Data(s.utf8)),
                           sig: v["input"]!["signature"]!.stringValue!)
        let jwk = g["device"]!["jwk"]!
        XCTAssertTrue(env.verifyES256(x: jwk["x"]!.stringValue!, y: jwk["y"]!.stringValue!))
    }

    /// Phone-side JCS: the console enrollment the phone builds is byte for
    /// byte the one in the vector, code_mac included.
    func testConsoleEnrollBytes() throws {
        let v = try vector("enroll-console")
        let sent = try Envelope(json: v["input"]!).message()
        let rebuilt = try Messages.consoleEnroll(device: sent["device"]!, codeId: v["given"]!["code_id"]!.stringValue!,
                                                 code: v["given"]!["code"]!.stringValue!, createdAt: sent["created_at"]!.stringValue!,
                                                 expiresAt: sent["expires_at"]!.stringValue!, nonce: sent["nonce"]!.stringValue!)
        XCTAssertEqual(Base64URL.encode(JCS.data(rebuilt)), v["input"]!["payload"]!.stringValue)
    }

    /// Sign → verify with the fixed device A key, and the response the phone
    /// builds from a request re-serializes to the same canonical bytes.
    func testSignVerifyAndResponseBytes() throws {
        let keys = try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("keys.json")))
        let a = keys["devices"]!["A"]!
        let key = try P256.Signing.PrivateKey(rawRepresentation: try Base64URL.decode(a["d"]!.stringValue!))
        let request = try Envelope(json: try vector("request-valid")["input"]!).message()
        let response = try Messages.response(to: request, decision: "approve", deviceId: a["id"]!.stringValue!, signedAt: "2026-09-23T18:04:31.201Z")
        let envelope = try Envelope.seal(response, kid: a["id"]!.stringValue!) { try key.signature(for: $0).rawRepresentation }
        XCTAssertTrue(envelope.verifyES256(x: a["jwk"]!["x"]!.stringValue!, y: a["jwk"]!["y"]!.stringValue!))
        let committed = try Envelope(json: try vector("response-approve")["input"]!)
        XCTAssertEqual(JCS.serialize(try committed.message()), String(decoding: try committed.payloadData(), as: UTF8.self))
        XCTAssertEqual(envelope.payload, committed.payload)
    }

    func testP1363Conversion() throws {
        let key = P256.Signing.PrivateKey()
        let signature = try key.signature(for: Data("x".utf8))
        let raw = signature.rawRepresentation
        XCTAssertEqual(raw.count, 64)
        XCTAssertEqual(try P1363.toDER(raw), signature.derRepresentation)
        XCTAssertEqual(try P1363.fromDER(signature.derRepresentation), raw)
    }

    func testDemoModeNeverBuildsTheNetworkClient() throws {
        var constructed = 0
        let factory = RelayClientFactory<String> { constructed += 1; return "client" }
        XCTAssertNil(factory.client(for: .demo))
        XCTAssertNil(factory.client(for: .welcome))
        XCTAssertEqual(factory.built, 0)
        XCTAssertEqual(constructed, 0)
        XCTAssertEqual(factory.client(for: .live), "client")
        XCTAssertEqual(constructed, 1)

        let fleet = DemoFleet()
        XCTAssertEqual(fleet.pins.map { $0.name }, ["gpu-box", "laptop", "web-01"])
        let request = try fleet.request(on: 2, command: "systemctl restart site")
        let view = Display.view(request.json, pinned: fleet.pins)
        XCTAssertTrue(view.shown)
        XCTAssertEqual(view.display?["node"]?["name"], .string("web-01"))
    }

    func testQrRoundTrip() throws {
        let payload: JSONValue = .object(["t": .string("kl.relay"), "relay": .string("https://kl.example.com:8443"), "relay_spki": .string("sha256/abc")])
        XCTAssertEqual(try Messages.decodeQR(Messages.encodeQR(payload)), payload)
        XCTAssertThrowsError(try Messages.decodeQR("kl2:xx"))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile/ios/KLProtocol && swift test`
Expected: FAIL — SwiftPM cannot build the `KLProtocol` target, which has no sources yet (the wording varies by Swift version, e.g. `Source files for target KLProtocol should be located under 'Sources/KLProtocol'`).

- [ ] **Step 3: Implement**

Create `mobile/ios/KLProtocol/Sources/KLProtocol/JSONValue.swift`:

```swift
import Foundation

/// A JSON value that keeps every number exactly as it was written. Signed
/// payloads are JCS text, so the lexeme a phone received is the canonical
/// one; the approval screen shows it and re-serialization reproduces it.
public indirect enum JSONValue: Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(String)
    case bool(Bool)
    case null

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var intValue: Int? {
        if case .number(let n) = self { return Int(n) }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

public enum JSONError: Error, Equatable {
    case invalid(String)
}

/// A strict RFC 8259 parser over UTF-8 bytes: no trailing data, no lone
/// surrogates, numbers kept as their text.
public struct JSONParser {
    private let bytes: [UInt8]
    private var i = 0

    public static func parse(_ data: Data) throws -> JSONValue {
        var parser = JSONParser(bytes: [UInt8](data))
        parser.skipWhitespace()
        let value = try parser.parseValue()
        parser.skipWhitespace()
        guard parser.i == parser.bytes.count else { throw JSONError.invalid("trailing data") }
        return value
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    private init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    private mutating func skipWhitespace() {
        while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
    }

    private mutating func expect(_ literal: String) throws {
        for b in literal.utf8 {
            guard i < bytes.count, bytes[i] == b else { throw JSONError.invalid("expected \(literal)") }
            i += 1
        }
    }

    private mutating func parseValue() throws -> JSONValue {
        guard i < bytes.count else { throw JSONError.invalid("unexpected end") }
        switch bytes[i] {
        case UInt8(ascii: "{"): return try parseObject()
        case UInt8(ascii: "["): return try parseArray()
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expect("true"); return .bool(true)
        case UInt8(ascii: "f"): try expect("false"); return .bool(false)
        case UInt8(ascii: "n"): try expect("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    private mutating func parseObject() throws -> JSONValue {
        i += 1
        var out: [String: JSONValue] = [:]
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
        while true {
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw JSONError.invalid("expected a key") }
            let key = try parseString()
            skipWhitespace()
            try expect(":")
            skipWhitespace()
            out[key] = try parseValue()
            skipWhitespace()
            guard i < bytes.count else { throw JSONError.invalid("unterminated object") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
            throw JSONError.invalid("expected , or }")
        }
    }

    private mutating func parseArray() throws -> JSONValue {
        i += 1
        var out: [JSONValue] = []
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
        while true {
            skipWhitespace()
            out.append(try parseValue())
            skipWhitespace()
            guard i < bytes.count else { throw JSONError.invalid("unterminated array") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
            throw JSONError.invalid("expected , or ]")
        }
    }

    private mutating func hex4() throws -> UInt32 {
        guard i + 4 <= bytes.count, let s = String(bytes: bytes[i..<(i + 4)], encoding: .ascii), let v = UInt32(s, radix: 16) else {
            throw JSONError.invalid("bad \\u escape")
        }
        i += 4
        return v
    }

    private mutating func parseString() throws -> String {
        i += 1
        var scalars = String.UnicodeScalarView()
        var run: [UInt8] = []
        func flush() throws {
            if run.isEmpty { return }
            guard let s = String(bytes: run, encoding: .utf8) else { throw JSONError.invalid("invalid UTF-8") }
            scalars.append(contentsOf: s.unicodeScalars)
            run.removeAll()
        }
        while true {
            guard i < bytes.count else { throw JSONError.invalid("unterminated string") }
            let b = bytes[i]
            if b == UInt8(ascii: "\"") { i += 1; try flush(); return String(scalars) }
            if b < 0x20 { throw JSONError.invalid("control character in string") }
            if b != UInt8(ascii: "\\") { run.append(b); i += 1; continue }
            try flush()
            i += 1
            guard i < bytes.count else { throw JSONError.invalid("bad escape") }
            let e = bytes[i]
            i += 1
            switch e {
            case UInt8(ascii: "\""): scalars.append("\"")
            case UInt8(ascii: "\\"): scalars.append("\\")
            case UInt8(ascii: "/"): scalars.append("/")
            case UInt8(ascii: "b"): scalars.append(Unicode.Scalar(0x08))
            case UInt8(ascii: "f"): scalars.append(Unicode.Scalar(0x0C))
            case UInt8(ascii: "n"): scalars.append(Unicode.Scalar(0x0A))
            case UInt8(ascii: "r"): scalars.append(Unicode.Scalar(0x0D))
            case UInt8(ascii: "t"): scalars.append(Unicode.Scalar(0x09))
            case UInt8(ascii: "u"):
                let high = try hex4()
                if (0xD800...0xDBFF).contains(high) {
                    guard i + 2 <= bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") else {
                        throw JSONError.invalid("lone surrogate")
                    }
                    i += 2
                    let low = try hex4()
                    guard (0xDC00...0xDFFF).contains(low) else { throw JSONError.invalid("lone surrogate") }
                    scalars.append(Unicode.Scalar(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))!)
                } else if (0xDC00...0xDFFF).contains(high) {
                    throw JSONError.invalid("lone surrogate")
                } else {
                    scalars.append(Unicode.Scalar(high)!)
                }
            default: throw JSONError.invalid("bad escape")
            }
        }
    }

    private mutating func parseNumber() throws -> String {
        let start = i
        if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
        guard i < bytes.count, (0x30...0x39).contains(bytes[i]) else { throw JSONError.invalid("bad number") }
        if bytes[i] == 0x30 { i += 1 } else { while i < bytes.count, (0x30...0x39).contains(bytes[i]) { i += 1 } }
        if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
            i += 1
            guard i < bytes.count, (0x30...0x39).contains(bytes[i]) else { throw JSONError.invalid("bad fraction") }
            while i < bytes.count, (0x30...0x39).contains(bytes[i]) { i += 1 }
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
            i += 1
            if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
            guard i < bytes.count, (0x30...0x39).contains(bytes[i]) else { throw JSONError.invalid("bad exponent") }
            while i < bytes.count, (0x30...0x39).contains(bytes[i]) { i += 1 }
        }
        return String(decoding: bytes[start..<i], as: UTF8.self)
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/JCS.swift`:

```swift
import Foundation

/// RFC 8785 serialization of a JSONValue: keys sorted by UTF-16 code units,
/// no whitespace, strings escaped exactly as ECMAScript's JSON.stringify does.
/// Numbers are written as received (a phone only ever canonicalizes messages
/// whose numbers are integers, and signed payloads are already canonical).
public enum JCS {
    public static func serialize(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    public static func data(_ value: JSONValue) -> Data {
        Data(serialize(value).utf8)
    }

    public static func utf16Less(_ a: String, _ b: String) -> Bool {
        Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16))
    }

    public static func escape(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x00..<0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += n
        case .string(let s): out += escape(s)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                write(v, into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            for (i, k) in o.keys.sorted(by: utf16Less).enumerated() {
                if i > 0 { out += "," }
                out += escape(k)
                out += ":"
                write(o[k]!, into: &out)
            }
            out += "}"
        }
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/Encoding.swift`:

```swift
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum ProtocolError: Error, Equatable {
    case malformed(String)
    case keyInvalidated
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict: the base64url alphabet, no padding, and the one canonical
    /// encoding of the bytes.
    public static func decode(_ text: String) throws -> Data {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }), text.count % 4 != 1 else {
            throw ProtocolError.malformed("not base64url")
        }
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), encode(data) == text else { throw ProtocolError.malformed("non-canonical base64url") }
        return data
    }
}

public enum Hex {
    public static func encode(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func decode(_ text: String) throws -> Data {
        guard text.count % 2 == 0 else { throw ProtocolError.malformed("odd hex") }
        var out = Data(capacity: text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { throw ProtocolError.malformed("bad hex") }
            out.append(byte)
            index = next
        }
        return out
    }
}

public enum Digest {
    public static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    public static func sha256B64url(_ data: Data) -> String {
        Base64URL.encode(sha256(data))
    }

    public static func sha256Hex(_ data: Data) -> String {
        Hex.encode(sha256(data))
    }

    public static func hmacB64url(keyB64url: String, message: Data) throws -> String {
        let key = SymmetricKey(data: try Base64URL.decode(keyB64url))
        return Base64URL.encode(Data(HMAC<SHA256>.authenticationCode(for: message, using: key)))
    }
}

/// Ids and the four-letter groups people compare on two screens.
public enum Identifiers {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")

    public static func base32(_ data: Data) -> String {
        var bits = 0
        var value = 0
        var out = ""
        for byte in data {
            value = (value << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
            value &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(value << (5 - bits)) & 31]) }
        return out
    }

    public static func deviceId(raw: Data, prefix: String = "d-") -> String {
        prefix + String(base32(Digest.sha256(raw)).prefix(16))
    }

    /// d- + base32(sha256(0x04 || x || y))[0..16]
    public static func deviceId(x: String, y: String) throws -> String {
        let xb = try Base64URL.decode(x)
        let yb = try Base64URL.decode(y)
        guard xb.count == 32, yb.count == 32 else { throw ProtocolError.malformed("P-256 coordinates are 32 bytes") }
        return deviceId(raw: Data([0x04]) + xb + yb)
    }

    public static func nodeId(ed25519Raw raw: Data) -> String {
        deviceId(raw: raw, prefix: "kl-")
    }

    public static func fingerprintGroups(_ id: String) -> String {
        let body = id.split(separator: "-", maxSplits: 1).last.map(String.init) ?? id
        var groups: [String] = []
        var current = ""
        for ch in body {
            current.append(ch)
            if current.count == 4 { groups.append(current); current = "" }
        }
        if !current.isEmpty { groups.append(current) }
        return groups.joined(separator: " ")
    }

    public static let ed25519SpkiPrefix = "302a300506032b6570032100"
}

public enum Timestamps {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    public static func string(_ date: Date) -> String {
        formatter.string(from: date)
    }

    public static func date(_ text: String) -> Date? {
        if let d = formatter.date(from: text) { return d }
        let plain = ISO8601DateFormatter()
        plain.timeZone = TimeZone(identifier: "UTC")
        return plain.date(from: text)
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/Envelope.swift`:

```swift
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// A signed envelope: { alg, kid, payload, sig }. Signatures cover the
/// payload bytes as received; the phone never re-serializes to verify.
public struct Envelope: Equatable {
    public let alg: String
    public let kid: String
    public let payload: String
    public let sig: String

    public init(alg: String, kid: String, payload: String, sig: String) {
        self.alg = alg
        self.kid = kid
        self.payload = payload
        self.sig = sig
    }

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, o.count == 4,
              let alg = o["alg"]?.stringValue, let kid = o["kid"]?.stringValue,
              let payload = o["payload"]?.stringValue, let sig = o["sig"]?.stringValue else {
            throw ProtocolError.malformed("not an envelope")
        }
        self.init(alg: alg, kid: kid, payload: payload, sig: sig)
    }

    public var json: JSONValue {
        .object(["alg": .string(alg), "kid": .string(kid), "payload": .string(payload), "sig": .string(sig)])
    }

    public func payloadData() throws -> Data {
        try Base64URL.decode(payload)
    }

    public func message() throws -> JSONValue {
        try JSONParser.parse(try payloadData())
    }

    /// Node signature over the received bytes, against a pinned DER SPKI key.
    public func verifyEd25519(spkiHex: String) -> Bool {
        guard alg == "Ed25519", let spki = try? Hex.decode(spkiHex), spki.count == 44,
              Hex.encode(spki.prefix(12)) == Identifiers.ed25519SpkiPrefix,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: spki.suffix(32)),
              let bytes = try? payloadData(), let signature = try? Base64URL.decode(sig), signature.count == 64 else {
            return false
        }
        return key.isValidSignature(signature, for: bytes)
    }

    /// Phone signature (P-256, raw r||s) against a device JWK's x and y.
    public func verifyES256(x: String, y: String) -> Bool {
        guard alg == "ES256", let xb = try? Base64URL.decode(x), let yb = try? Base64URL.decode(y),
              let key = try? P256.Signing.PublicKey(x963Representation: Data([0x04]) + xb + yb),
              let bytes = try? payloadData(), let raw = try? Base64URL.decode(sig),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else {
            return false
        }
        return key.isValidSignature(signature, for: bytes)
    }

    /// Canonical bytes of `message`, signed by `sign` (raw r||s for ES256).
    public static func seal(_ message: JSONValue, alg: String = "ES256", kid: String, sign: (Data) throws -> Data) rethrows -> Envelope {
        let bytes = JCS.data(message)
        let signature = try sign(bytes)
        return Envelope(alg: alg, kid: kid, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
    }
}

/// IEEE P1363 (raw r||s) ⇄ DER conversions, for keys and platforms that
/// only speak one of them.
public enum P1363 {
    public static func toDER(_ raw: Data) throws -> Data {
        guard raw.count == 64 else { throw ProtocolError.malformed("P-256 signatures are 64 bytes") }
        func integer(_ part: Data) -> Data {
            var bytes = [UInt8](part)
            while bytes.count > 1 && bytes[0] == 0 && bytes[1] < 0x80 { bytes.removeFirst() }
            if bytes[0] >= 0x80 { bytes.insert(0, at: 0) }
            return Data([0x02, UInt8(bytes.count)] + bytes)
        }
        let body = integer(raw.prefix(32)) + integer(raw.suffix(32))
        return Data([0x30, UInt8(body.count)]) + body
    }

    public static func fromDER(_ der: Data) throws -> Data {
        let bytes = [UInt8](der)
        guard bytes.count > 8, bytes[0] == 0x30, bytes[2] == 0x02 else { throw ProtocolError.malformed("not a DER signature") }
        var i = 2
        func read() throws -> Data {
            guard bytes[i] == 0x02 else { throw ProtocolError.malformed("expected INTEGER") }
            let len = Int(bytes[i + 1])
            var value = Array(bytes[(i + 2)..<(i + 2 + len)])
            i += 2 + len
            while value.count > 32 && value[0] == 0 { value.removeFirst() }
            guard value.count <= 32 else { throw ProtocolError.malformed("integer too long") }
            return Data(repeating: 0, count: 32 - value.count) + Data(value)
        }
        return try read() + read()
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/Messages.swift`:

```swift
import Foundation

/// The messages a phone builds (docs/protocol/approval-v1.md §3). Every one
/// is strings, the integer `v`, and nested objects.
public enum Messages {
    public static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return Base64URL.encode(Data(bytes))
    }

    public static func device(deviceId: String, name: String, platform: String, x: String, y: String) -> JSONValue {
        .object([
            "device_id": .string(deviceId),
            "name": .string(name),
            "platform": .string(platform),
            "public_key": .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(x), "y": .string(y)])
        ])
    }

    /// kl.approval.response for a node-signed request message.
    public static func response(to request: JSONValue, decision: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard let requestId = request["request_id"]?.stringValue, let nodeId = request["node_id"]?.stringValue,
              let actionHash = request["action_hash"]?.stringValue, let nonce = request["nonce"]?.stringValue,
              let expiresAt = request["expires_at"]?.stringValue, decision == "approve" || decision == "deny" else {
            throw ProtocolError.malformed("not a request")
        }
        return .object([
            "v": .number("1"),
            "type": .string("kl.approval.response"),
            "request_id": .string(requestId),
            "node_id": .string(nodeId),
            "action_hash": .string(actionHash),
            "nonce": .string(nonce),
            "decision": .string(decision),
            "expires_at": .string(expiresAt),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ])
    }

    /// Console enrollment: self-signed, with code_mac = HMAC-SHA256(code bytes, JCS(message without code_mac)).
    public static func consoleEnroll(device: JSONValue, codeId: String, code: String, createdAt: String, expiresAt: String, nonce: String) throws -> JSONValue {
        var fields: [String: JSONValue] = [
            "v": .number("1"),
            "type": .string("kl.device.enroll"),
            "device": device,
            "enrolled_by": .null,
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce),
            "code_id": .string(codeId)
        ]
        fields["code_mac"] = .string(try Digest.hmacB64url(keyB64url: code, message: JCS.data(.object(fields))))
        return .object(fields)
    }

    /// Enrollment of another phone by this one (the invite flow).
    public static func signedEnroll(device: JSONValue, enrolledBy: String, createdAt: String, expiresAt: String, nonce: String) -> JSONValue {
        .object([
            "v": .number("1"),
            "type": .string("kl.device.enroll"),
            "device": device,
            "enrolled_by": .string(enrolledBy),
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce)
        ])
    }

    public static func revoke(deviceId: String, revokedBy: String, reason: String, createdAt: String, expiresAt: String, nonce: String) -> JSONValue {
        .object([
            "v": .number("1"),
            "type": .string("kl.device.revoke"),
            "device_id": .string(deviceId),
            "revoked_by": .string(revokedBy),
            "reason": .string(reason),
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce)
        ])
    }

    public static func inviteMac(secret: String, device: JSONValue) throws -> String {
        try Digest.hmacB64url(keyB64url: secret, message: JCS.data(device))
    }

    /// S for X-KL-Signature: "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body)).
    public static func phoneAuthString(method: String, pathWithQuery: String, timestamp: String, body: Data) -> String {
        ["KL-PHONE-V1", method.uppercased(), pathWithQuery, timestamp, Digest.sha256B64url(body)].joined(separator: "\n")
    }

    public static func encodeQR(_ object: JSONValue) -> String {
        "kl1:" + Base64URL.encode(JCS.data(object))
    }

    public static func decodeQR(_ text: String) throws -> JSONValue {
        guard text.hasPrefix("kl1:") else { throw ProtocolError.malformed("not a kl1: code") }
        let value = try JSONParser.parse(try Base64URL.decode(String(text.dropFirst(4))))
        guard value["t"]?.stringValue != nil else { throw ProtocolError.malformed("QR payload has no type") }
        return value
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/Display.swift`:

```swift
import Foundation

public struct NodePin: Equatable, Codable {
    public let id: String
    public let name: String
    public let key: String

    public init(id: String, name: String, key: String) {
        self.id = id
        self.name = name
        self.key = key
    }
}

/// Whether a request may be shown, and exactly what the approval screen
/// displays (docs/protocol/approval-v1.md §5, vector `request-display`).
public struct PhoneView: Equatable {
    public let shown: Bool
    public let reason: String?
    public let display: JSONValue?

    public var json: JSONValue {
        .object(["shown": .bool(shown), "reason": reason.map { .string($0) } ?? .null, "display": display ?? .null])
    }
}

public enum Display {
    public static let collapseOver = 2000
    public static let head = 1200
    public static let tail = 400
    static let commandKeys: Set<String> = ["command", "script", "argv"]

    /// C0, DEL and C1 controls, zero-width and directional marks, bidi
    /// embeddings and isolates, and the BOM.
    public static func isHidden(_ v: UInt32) -> Bool {
        v <= 0x1F || (0x7F...0x9F).contains(v) || (0x200B...0x200F).contains(v)
            || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0xFEFF
    }

    public static func escape(_ text: String) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            if isHidden(scalar.value) {
                out += "\u{2039}U+" + String(format: "%04X", scalar.value) + "\u{203A}"
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    static func item(_ path: String, text: String, tail: String?, hidden: Int) -> JSONValue {
        .object(["path": .string(path), "text": .string(text), "tail": tail.map { .string($0) } ?? .null, "hidden": .number(String(hidden))])
    }

    static func stringItem(_ path: String, _ value: String, commandLike: Bool, collapse: Bool = true) -> JSONValue {
        let scalars = Array(value.unicodeScalars)
        if collapse && commandLike && scalars.count > collapseOver {
            var headText = String.UnicodeScalarView()
            headText.append(contentsOf: scalars[0..<head])
            var tailText = String.UnicodeScalarView()
            tailText.append(contentsOf: scalars[(scalars.count - tail)...])
            return item(path, text: escape(String(headText)), tail: escape(String(tailText)), hidden: scalars.count - head - tail)
        }
        return item(path, text: escape(value), tail: nil, hidden: 0)
    }

    static func flatten(_ value: JSONValue, _ path: String, _ commandLike: Bool, collapse: Bool = true, into out: inout [JSONValue]) {
        switch value {
        case .string(let s):
            out.append(stringItem(path, s, commandLike: commandLike, collapse: collapse))
        case .number(let n):
            out.append(item(path, text: n, tail: nil, hidden: 0))
        case .bool(let b):
            out.append(item(path, text: b ? "true" : "false", tail: nil, hidden: 0))
        case .null:
            out.append(item(path, text: "null", tail: nil, hidden: 0))
        case .array(let a):
            if a.isEmpty {
                out.append(item(path, text: "[]", tail: nil, hidden: 0))
            } else if commandLike, a.allSatisfy({ $0.stringValue != nil }) {
                out.append(stringItem(path, a.compactMap { $0.stringValue }.joined(separator: " "), commandLike: true, collapse: collapse))
            } else {
                for (i, v) in a.enumerated() { flatten(v, "\(path)[\(i)]", commandLike, collapse: collapse, into: &out) }
            }
        case .object(let o):
            if o.isEmpty { out.append(item(path, text: "{}", tail: nil, hidden: 0)) }
            for k in o.keys.sorted(by: JCS.utf16Less) {
                flatten(o[k]!, "\(path).\(k)", commandLike || commandKeys.contains(k), collapse: collapse, into: &out)
            }
        }
    }

    /// With collapse: false every value is shown whole (the "Show all" view).
    public static func build(_ message: JSONValue, collapse: Bool = true) -> JSONValue {
        let action = message["action"] ?? .null
        var items: [JSONValue] = []
        flatten(action["params"] ?? .object([:]), "params", false, collapse: collapse, into: &items)
        if let steps = action["steps"]?.arrayValue {
            for (i, step) in steps.enumerated() {
                if let argv = step.arrayValue {
                    items.append(stringItem("steps[\(i)]", argv.compactMap { $0.stringValue }.joined(separator: " "), commandLike: true, collapse: collapse))
                } else {
                    items.append(item("steps[\(i)]", text: escape(JCS.serialize(step)), tail: nil, hidden: 0))
                }
            }
        }
        var origin: [String: JSONValue] = [:]
        for (k, v) in message["origin"]?.objectValue ?? [:] {
            origin[k] = v.stringValue.map { .string(escape($0)) } ?? .null
        }
        let cwd: JSONValue = action["cwd"]?.stringValue.map { .string(escape($0)) } ?? .null
        return .object([
            "node": .object(["id": message["node_id"] ?? .null, "name": .string(escape(message["node_name"]?.stringValue ?? ""))]),
            "kind": action["kind"] ?? .null,
            "name": .string(escape(action["name"]?.stringValue ?? "")),
            "summary": .string(escape(action["summary"]?.stringValue ?? "")),
            "cwd": cwd,
            "origin": .object(origin),
            "items": .array(items)
        ])
    }

    static func isWellFormedRequest(_ m: JSONValue) -> Bool {
        guard m["v"] == .number("1"), m["type"]?.stringValue == "kl.approval.request",
              m["request_id"]?.stringValue != nil, m["node_id"]?.stringValue != nil, m["node_name"]?.stringValue != nil,
              m["action_hash"]?.stringValue != nil, m["nonce"]?.stringValue != nil,
              m["created_at"]?.stringValue != nil, m["expires_at"]?.stringValue != nil,
              let action = m["action"], action["kind"]?.stringValue != nil, action["summary"]?.stringValue != nil,
              action["params"]?.objectValue != nil, m["origin"]?.objectValue != nil else { return false }
        return true
    }

    /// Hidden unless the node is pinned (from a pairing or invite QR only)
    /// and its signature over the received bytes verifies.
    public static func view(_ envelopeJSON: JSONValue, pinned: [NodePin]) -> PhoneView {
        guard let envelope = try? Envelope(json: envelopeJSON), let message = try? envelope.message(), isWellFormedRequest(message) else {
            return PhoneView(shown: false, reason: "malformed", display: nil)
        }
        guard let pin = pinned.first(where: { $0.id == message["node_id"]?.stringValue }), envelope.kid == pin.id else {
            return PhoneView(shown: false, reason: "unpinned_node", display: nil)
        }
        guard envelope.verifyEd25519(spkiHex: pin.key) else {
            return PhoneView(shown: false, reason: "bad_node_signature", display: nil)
        }
        return PhoneView(shown: true, reason: nil, display: build(message))
    }
}

/// History comes as node-signed kl.audit.slice envelopes; the phone checks
/// the signature and that each entry's hash is right and chains.
public enum AuditSlice {
    public static func verify(_ envelopeJSON: JSONValue, nodeKeyHex: String) -> (ok: Bool, reason: String?, entries: [JSONValue]) {
        guard let envelope = try? Envelope(json: envelopeJSON) else { return (false, "malformed", []) }
        guard envelope.verifyEd25519(spkiHex: nodeKeyHex) else { return (false, "bad_signature", []) }
        guard let message = try? envelope.message(), message["type"]?.stringValue == "kl.audit.slice",
              message["node_id"]?.stringValue == envelope.kid, let entries = message["entries"]?.arrayValue else {
            return (false, "malformed", [])
        }
        var previous: JSONValue? = nil
        for entry in entries {
            guard var fields = entry.objectValue, let hash = fields.removeValue(forKey: "hash")?.stringValue else {
                return (false, "malformed", [])
            }
            guard Digest.sha256Hex(JCS.data(.object(fields))) == hash else { return (false, "hash_mismatch", []) }
            if let p = previous, let prevSeq = p["seq"]?.intValue {
                guard entry["seq"]?.intValue == prevSeq + 1, entry["prev"]?.stringValue == p["hash"]?.stringValue else {
                    return (false, "broken_chain", [])
                }
            }
            previous = entry
        }
        return (true, nil, entries)
    }
}
```

Create `mobile/ios/KLProtocol/Sources/KLProtocol/AppCore.swift`:

```swift
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum AppMode: String, Codable, Equatable {
    case welcome
    case demo
    case live
}

/// The only way the app obtains a network client. Demo mode never gets one:
/// the factory refuses, and `built` proves it in tests.
public final class RelayClientFactory<Client> {
    public private(set) var built = 0
    private let make: () -> Client

    public init(make: @escaping () -> Client) {
        self.make = make
    }

    public func client(for mode: AppMode) -> Client? {
        guard mode == .live else { return nil }
        built += 1
        return make()
    }
}

/// Three pretend nodes with in-app keys and a software phone key, shown
/// under a "Demo" banner. Nothing here touches the network.
public final class DemoFleet {
    public struct Node {
        public let pin: NodePin
        fileprivate let key: Curve25519.Signing.PrivateKey
    }

    public let nodes: [Node]
    private let deviceKey = P256.Signing.PrivateKey()

    public init(names: [String] = ["gpu-box", "laptop", "web-01"]) {
        nodes = names.map { name in
            let key = Curve25519.Signing.PrivateKey()
            let raw = key.publicKey.rawRepresentation
            return Node(pin: NodePin(id: Identifiers.nodeId(ed25519Raw: raw), name: name, key: Identifiers.ed25519SpkiPrefix + Hex.encode(raw)), key: key)
        }
    }

    public var pins: [NodePin] { nodes.map { $0.pin } }

    public var deviceId: String {
        let raw = deviceKey.publicKey.x963Representation
        return Identifiers.deviceId(raw: raw)
    }

    /// A node-signed request, as a real node would send it.
    public func request(on index: Int, command: String, now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let action: JSONValue = .object([
            "kind": .string("tool"),
            "name": .string("Bash"),
            "params": .object(["command": .string(command)]),
            "cwd": .string("/srv/site"),
            "summary": .string("Bash(\(command))")
        ])
        let message: JSONValue = .object([
            "v": .number("1"),
            "type": .string("kl.approval.request"),
            "request_id": .string(UUID().uuidString.lowercased()),
            "node_id": .string(node.pin.id),
            "node_name": .string(node.pin.name),
            "action": action,
            "action_hash": .string(Digest.sha256B64url(JCS.data(action))),
            "origin": .object(["client": .string("demo"), "session": .null, "job_id": .null]),
            "created_at": .string(Timestamps.string(now)),
            "expires_at": .string(Timestamps.string(now.addingTimeInterval(300))),
            "nonce": .string(Messages.randomNonce())
        ])
        return try Envelope.seal(message, alg: "Ed25519", kid: node.pin.id) { bytes in
            try node.key.signature(for: bytes)
        }
    }

    /// The software key signs demo answers; it is deleted when the owner leaves demo.
    public func sign(_ data: Data) throws -> Data {
        try deviceKey.signature(for: data).rawRepresentation
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd mobile/ios/KLProtocol && swift test`
Expected: `Executed 13 tests, with 0 failures` — every vector whose consumers include `ios` (`jcs`, `device-id-p256`, `device-id-ed25519`, `request-valid`, `request-bad-node-signature`, `request-unpinned-node`, `request-display`, `enroll-console`, `audit-slice`, `phone-api-auth`), phone-side JCS (the console enrollment and the approval response rebuild the vectors' exact bytes), sign → verify, P1363 ⇄ DER, display escapes and "Show all", QR round trip, and demo mode never building the network client.

- [ ] **Step 5: Commit**

```bash
git add mobile/ios/KLProtocol
git commit -m "feat(ios): approval-v1 protocol core passing the shared vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: iOS app

**Files:**
- Create: `mobile/ios/project.yml`, `mobile/ios/Config/App.xcconfig`, `mobile/ios/App/Push.entitlements`, `mobile/ios/App/NoPush.entitlements`, `mobile/ios/App/KingLouieApp.swift`, `mobile/ios/App/DeviceKey.swift`, `mobile/ios/App/RelayAPI.swift`, `mobile/ios/App/AppModel.swift`, `mobile/ios/App/QRScannerView.swift`, `mobile/ios/App/Views.swift`
- Test: the build itself (the logic lives in `KLProtocol`, tested in Task 24) and the manual device checks below

**Interfaces:**
- Consumes: everything `KLProtocol` produces (Task 24); the relay's phone API (`docs/protocol/approval-v1.md` §7).
- Produces: the KingLouie app target (XcodeGen). `DeviceKey` (Secure Enclave P-256, `[.privateKeyUsage, .biometryCurrentSet]`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `dataRepresentation` in the Keychain; `sign(_:reason:)` with a fresh prompt, `signForSession(_:)` for API calls); `RelayAPI` (URLSession pinning the leaf's SPKI hash, device-signed requests, one clock-skew retry, every §4.5 route); `AppModel` (pairing, invites, polling, approve/deny with node-offline retries, history, nodes, devices, push token, demo, reset); screens Welcome, Pending approvals, Approval detail, History, Nodes, Devices, Settings.

- [ ] **Step 1: Write the failing check**

Create `mobile/ios/project.yml`:

```yaml
# XcodeGen project for the King Louie approvals app (iOS 17+).
# Generate the Xcode project with `xcodegen generate` in mobile/ios.
# Bundle id, APNs topic/environment and signing are build-time settings in
# Config/App.xcconfig; nothing here names a person, team or domain.
name: KingLouie
options:
  deploymentTarget:
    iOS: "17.0"
  createIntermediateGroups: true
configFiles:
  Debug: Config/App.xcconfig
  Release: Config/App.xcconfig
packages:
  KLProtocol:
    path: KLProtocol
targets:
  KingLouie:
    type: application
    platform: iOS
    sources:
      - path: App
        excludes:
          - "*.entitlements"
    info:
      path: App/Info.plist
      properties:
        CFBundleDisplayName: King Louie
        CFBundleShortVersionString: "1.0"
        CFBundleVersion: "1"
        UILaunchScreen: {}
        NSCameraUsageDescription: Scans pairing, invite and relay codes.
        NSFaceIDUsageDescription: Every approval and device change is signed with your face or fingerprint.
        KLApnsTopic: $(KL_APNS_TOPIC)
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait]
    dependencies:
      - package: KLProtocol
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: $(KL_BUNDLE_ID)
        CODE_SIGN_ENTITLEMENTS: $(KL_ENTITLEMENTS)
        DEVELOPMENT_TEAM: $(KL_DEVELOPMENT_TEAM)
        SWIFT_VERSION: "5.9"
        TARGETED_DEVICE_FAMILY: "1"
```

Create `mobile/ios/Config/App.xcconfig`:

```text
// Build-time configuration for the King Louie approvals app.
// Copy this file's values into your own build settings or edit them here
// before building; the defaults build an app without push.

// Your bundle identifier.
KL_BUNDLE_ID = com.example.kinglouie

// Your Apple developer team id (leave empty to sign manually).
KL_DEVELOPMENT_TEAM =

// Push (optional, program Q-A). Leave KL_APNS_TOPIC empty for no push: the app
// then long-polls the relay while it is open. To use APNs, set the topic to
// your bundle id, KL_ENTITLEMENTS to App/Push.entitlements, and
// KL_APNS_ENVIRONMENT to development or production.
KL_APNS_TOPIC =
KL_APNS_ENVIRONMENT = development
KL_ENTITLEMENTS = App/NoPush.entitlements
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile/ios && xcodegen generate && xcodebuild -project KingLouie.xcodeproj -scheme KingLouie -destination 'generic/platform=iOS Simulator' build`
Expected: FAIL — XcodeGen reports the `App` source path missing (or, once the directory exists, the build fails with `cannot find 'RootView' in scope`).

- [ ] **Step 3: Implement**

Create `mobile/ios/App/Push.entitlements`:

```text
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>$(KL_APNS_ENVIRONMENT)</string>
</dict>
</plist>
```

Create `mobile/ios/App/NoPush.entitlements`:

```text
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
```

Create `mobile/ios/App/DeviceKey.swift`:

```swift
import CryptoKit
import Foundation
import KLProtocol
import LocalAuthentication
import Security

/// This phone's approval key: a Secure Enclave P-256 key that signs only
/// after Face ID / Touch ID, and stops working when the enrolled biometrics
/// change (.biometryCurrentSet). Its opaque dataRepresentation lives in the
/// Keychain, readable only while this device is unlocked.
final class DeviceKey {
    static let account = "kl.device-key"
    static let invalidatedMessage = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

    private let dataRepresentation: Data
    let publicKey: P256.Signing.PublicKey
    /// One unlock for API requests while the app is in use; every approval,
    /// enrollment and revocation still asks again (see sign(_:reason:)).
    private var sessionContext: LAContext?

    private init(dataRepresentation: Data, publicKey: P256.Signing.PublicKey) {
        self.dataRepresentation = dataRepresentation
        self.publicKey = publicKey
    }

    var deviceId: String { Identifiers.deviceId(raw: publicKey.x963Representation) }
    var jwkX: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 1..<33)) }
    var jwkY: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 33..<65)) }

    static func load() -> DeviceKey? {
        guard let data = keychainRead(), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) else { return nil }
        return DeviceKey(dataRepresentation: data, publicKey: key.publicKey)
    }

    /// Made at the first real pairing (never in demo mode).
    static func create() throws -> DeviceKey {
        guard SecureEnclave.isAvailable else { throw ProtocolError.malformed("This phone has no Secure Enclave.") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryCurrentSet], &error) else {
            throw error!.takeRetainedValue() as Error
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try keychainWrite(key.dataRepresentation)
        return DeviceKey(dataRepresentation: key.dataRepresentation, publicKey: key.publicKey)
    }

    static func delete() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }

    /// A fresh biometric prompt, then one signature (raw r||s).
    func sign(_ data: Data, reason: String) async throws -> Data {
        let context = LAContext()
        _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        return try signature(data, context: context)
    }

    /// Signs API requests with a context unlocked once per session.
    func signForSession(_ data: Data) async throws -> Data {
        if sessionContext == nil {
            let context = LAContext()
            context.touchIDAuthenticationAllowableReuseDuration = LATouchIDAuthenticationMaximumAllowableReuseDuration
            _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock King Louie to check for approvals.")
            sessionContext = context
        }
        do {
            return try signature(data, context: sessionContext!)
        } catch {
            sessionContext = nil
            throw error
        }
    }

    func endSession() {
        sessionContext?.invalidate()
        sessionContext = nil
    }

    private func signature(_ data: Data, context: LAContext) throws -> Data {
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: context)
            return try key.signature(for: data).rawRepresentation
        } catch {
            // A changed biometric set invalidates the key for good.
            throw ProtocolError.keyInvalidated
        }
    }

    private static func keychainRead() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func keychainWrite(_ data: Data) throws {
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ProtocolError.malformed("Keychain error \(status)") }
    }
}
```

Create `mobile/ios/App/RelayAPI.swift`:

```swift
import CryptoKit
import Foundation
import KLProtocol
import Security

struct RelayError: Error, LocalizedError {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message.isEmpty ? code : message }
}

/// The relay's phone API over HTTPS. The TLS leaf certificate's public key
/// must match the pinned SPKI hash; certificate authorities are ignored.
final class RelayAPI: NSObject, URLSessionDelegate {
    let base: URL
    let spkiPin: String
    private let deviceId: String?
    private let signer: ((Data) async throws -> Data)?
    private var clockOffset: TimeInterval = 0
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    init(base: URL, spkiPin: String, deviceId: String?, signer: ((Data) async throws -> Data)?) {
        self.base = base
        self.spkiPin = spkiPin
        self.deviceId = deviceId
        self.signer = signer
    }

    // MARK: Pinning

    // DER SubjectPublicKeyInfo headers for the key types a relay certificate may use.
    private static let spkiHeaders: [String: [UInt8]] = [
        "ec256": [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00],
        "ec384": [0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00],
        "rsa2048": [0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00],
        "rsa3072": [0x30, 0x82, 0x01, 0xa2, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x8f, 0x00],
        "rsa4096": [0x30, 0x82, 0x02, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x02, 0x0f, 0x00]
    ]

    static func spkiPin(of certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }
        let type = attributes[kSecAttrKeyType as String] as? String
        let bits = attributes[kSecAttrKeySizeInBits as String] as? Int ?? 0
        let name: String
        if type == (kSecAttrKeyTypeECSECPrimeRandom as String) { name = "ec\(bits)" } else { name = "rsa\(bits)" }
        guard let header = spkiHeaders[name] else { return nil }
        return "sha256/" + Digest.sha256B64url(Data(header) + raw)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first, Self.spkiPin(of: leaf) == spkiPin else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    // MARK: Requests

    /// Device-signed unless `auth` is false (code and invite routes). A 401
    /// clock_skew is answered once with the relay's time as the offset.
    func request(_ method: String, _ pathWithQuery: String, body: JSONValue? = nil, auth: Bool = true, retried: Bool = false) async throws -> (Int, JSONValue?) {
        let bodyData = body.map { JCS.data($0) } ?? Data()
        var request = URLRequest(url: URL(string: pathWithQuery, relativeTo: base)!)
        request.httpMethod = method
        request.timeoutInterval = 40
        if body != nil {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth, let deviceId, let signer {
            let timestamp = Timestamps.string(Date().addingTimeInterval(clockOffset))
            let s = Messages.phoneAuthString(method: method, pathWithQuery: pathWithQuery, timestamp: timestamp, body: bodyData)
            request.setValue(deviceId, forHTTPHeaderField: "X-KL-Device")
            request.setValue(timestamp, forHTTPHeaderField: "X-KL-Timestamp")
            request.setValue(Base64URL.encode(try await signer(Data(s.utf8))), forHTTPHeaderField: "X-KL-Signature")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = data.isEmpty ? nil : try? JSONParser.parse(data)
        if status == 401, json?["error"]?.stringValue == "clock_skew", !retried,
           let serverTime = json?["server_time"]?.stringValue, let server = Timestamps.date(serverTime) {
            clockOffset = server.timeIntervalSinceNow
            return try await self.request(method, pathWithQuery, body: body, auth: auth, retried: true)
        }
        if status >= 400 {
            throw RelayError(status: status, code: json?["error"]?.stringValue ?? "http_\(status)", message: json?["message"]?.stringValue ?? "")
        }
        return (status, json)
    }

    func approvals(wait: Int) async throws -> [JSONValue] {
        try await request("GET", "/v1/approvals?wait=\(wait)").1?.arrayValue ?? []
    }

    func approval(_ requestId: String) async throws -> JSONValue? {
        try await request("GET", "/v1/approvals/\(requestId)").1
    }

    func respond(_ requestId: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/approvals/\(requestId)/response", body: envelope.json).1
    }

    func nodes() async throws -> [JSONValue] {
        try await request("GET", "/v1/nodes").1?.arrayValue ?? []
    }

    func history(nodeId: String, limit: Int, beforeSeq: Int?) async throws -> JSONValue? {
        let before = beforeSeq.map { "&before_seq=\($0)" } ?? ""
        return try await request("GET", "/v1/nodes/\(nodeId)/history?limit=\(limit)\(before)").1
    }

    func pairingCode(nodeName: String) async throws -> JSONValue? {
        try await request("POST", "/v1/pairing-codes", body: .object(["node_name": .string(nodeName)])).1
    }

    func createInvite() async throws -> JSONValue? {
        try await request("POST", "/v1/devices/invites").1
    }

    func inviteClaim(_ inviteId: String) async throws -> JSONValue? {
        try await request("GET", "/v1/devices/invites/\(inviteId)").1?["claim"]
    }

    func claimInvite(_ inviteId: String, device: JSONValue, mac: String) async throws {
        _ = try await request("POST", "/v1/devices/invites/\(inviteId)/claim", body: .object(["device": device, "mac": .string(mac)]), auth: false)
    }

    func enrollDevice(_ envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/devices/enroll", body: envelope.json).1
    }

    func revokeDevice(_ envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/devices/revoke", body: envelope.json).1
    }

    func devices() async throws -> [JSONValue] {
        try await request("GET", "/v1/devices").1?.arrayValue ?? []
    }

    func pushToken(_ token: String) async throws {
        _ = try await request("PUT", "/v1/push-token", body: .object(["platform": .string("apns"), "token": .string(token)]))
    }

    func consoleEnroll(codeId: String, envelope: Envelope) async throws {
        _ = try await request("POST", "/v1/enroll/\(codeId)", body: envelope.json, auth: false)
    }

    func consoleEnrollState(codeId: String) async throws -> String {
        try await request("GET", "/v1/enroll/\(codeId)", auth: false).1?["state"]?.stringValue ?? "waiting"
    }
}
```

Create `mobile/ios/App/AppModel.swift`:

```swift
import Foundation
import KLProtocol
import SwiftUI
import UIKit

/// What the app keeps (mobile/PRIVACY.md): the relay pin, node pins, its key
/// reference (in the Keychain), the push token and cached history. Nothing
/// else, and no analytics.
struct StoredState: Codable {
    var mode: AppMode = .welcome
    var relayURL: String?
    var relaySpki: String?
    var nodes: [NodePin] = []
    var pushToken: String?

    static let key = "kl.state"

    static func load() -> StoredState {
        guard let data = UserDefaults.standard.data(forKey: key), let state = try? JSONDecoder().decode(StoredState.self, from: data) else { return StoredState() }
        return state
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}

struct PendingItem: Identifiable {
    let id: String
    let envelope: Envelope
    let message: JSONValue
    let display: JSONValue
    /// Every value whole, for "Show all" (Display.build(collapse: false)).
    let fullText: [String: String]
    let receivedAt: ContinuousClock.Instant
    let expiresInMs: Int
    var status: String?

    /// Counted from receipt on the monotonic clock, never from wall time.
    var timeLeft: Duration {
        let left = Duration.milliseconds(expiresInMs) - (ContinuousClock.now - receivedAt)
        return left < .zero ? .zero : left
    }
}

struct HistoryPage {
    let nodeId: String
    let entries: [JSONValue]
    let asOf: String
}

@MainActor
final class AppModel: ObservableObject {
    @Published var state = StoredState.load()
    @Published var pending: [PendingItem] = []
    @Published var banner: String?
    @Published var onlineNodes: [String: Bool] = [:]
    @Published var devices: [JSONValue] = []
    @Published var history: HistoryPage?
    @Published var fingerprintToCompare: String?
    @Published var inviteQR: String?
    @Published var inviteClaimToConfirm: JSONValue?

    private(set) var key: DeviceKey? = DeviceKey.load()
    private var demo: DemoFleet?
    private lazy var factory = RelayClientFactory<RelayAPI> { [unowned self] in self.makeClient() }
    private var client: RelayAPI?
    private var pollTask: Task<Void, Never>?
    private var pendingInvite: (id: String, secret: String)?

    var mode: AppMode { state.mode }
    var deviceId: String? { mode == .demo ? demo?.deviceId : key?.deviceId }

    init() {
        if state.mode == .demo { startDemo() }
        if state.mode == .live { client = factory.client(for: .live) }
    }

    private func makeClient() -> RelayAPI {
        RelayAPI(base: URL(string: state.relayURL ?? "https://invalid.example.com")!, spkiPin: state.relaySpki ?? "",
                 deviceId: key?.deviceId, signer: key.map { k in { data in try await k.signForSession(data) } })
    }

    private func fail(_ error: Error) {
        if let e = error as? ProtocolError, e == .keyInvalidated {
            banner = DeviceKey.invalidatedMessage
        } else if let e = error as? RelayError, e.code == "clock_skew" {
            banner = "Check the phone's clock."
        } else if (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled {
            banner = "Relay certificate changed — scan a new relay code."
        } else {
            banner = error.localizedDescription
        }
    }

    // MARK: Demo

    func startDemo() {
        let fleet = DemoFleet()
        demo = fleet
        state.mode = .demo
        state.save()
        pending = []
        for (i, command) in ["nvidia-smi --gpu-reset", "rm -rf ~/Downloads/old", "systemctl restart site"].enumerated() {
            if let env = try? fleet.request(on: i, command: command) { receive(.object(["envelope": env.json, "expires_in_ms": .number("300000"), "status": .null]), pins: fleet.pins) }
        }
    }

    /// Leaving demo drops the demo fleet and its software key; the hardware
    /// key is made at the first real pairing.
    func leaveDemo() {
        demo = nil
        pending = []
        state = StoredState()
        state.save()
    }

    // MARK: Scanning

    func scanned(_ text: String) async {
        do {
            let payload = try Messages.decodeQR(text.trimmingCharacters(in: .whitespacesAndNewlines))
            switch payload["t"]?.stringValue {
            case "kl.pair": try await pairAtConsole(payload)
            case "kl.invite": try await claimInvite(payload)
            case "kl.relay": repin(payload)
            default: banner = "That is not a King Louie code."
            }
        } catch {
            fail(error)
        }
    }

    private func pinRelay(_ payload: JSONValue) {
        state.relayURL = payload["relay"]?.stringValue
        state.relaySpki = payload["relay_spki"]?.stringValue
    }

    private func pinNode(_ node: JSONValue) {
        guard let id = node["id"]?.stringValue, let name = node["name"]?.stringValue, let key = node["key"]?.stringValue else { return }
        state.nodes.removeAll { $0.id == id }
        state.nodes.append(NodePin(id: id, name: name, key: key))
    }

    private func ensureKey() throws -> DeviceKey {
        if let key { return key }
        let created = try DeviceKey.create()
        key = created
        return created
    }

    private func device(_ key: DeviceKey) -> JSONValue {
        Messages.device(deviceId: key.deviceId, name: UIDevice.current.name, platform: "ios", x: key.jwkX, y: key.jwkY)
    }

    /// Console enrollment (spec §3.10): the phone signs its own enrollment with
    /// the key it enrolls and proves it scanned the code with code_mac.
    private func pairAtConsole(_ payload: JSONValue) async throws {
        guard let codeId = payload["code_id"]?.stringValue, let code = payload["code"]?.stringValue, let node = payload["node"] else {
            throw ProtocolError.malformed("incomplete pairing code")
        }
        if mode == .demo { leaveDemo() }
        pinRelay(payload)
        pinNode(node)
        let key = try ensureKey()
        let now = Date()
        let message = try Messages.consoleEnroll(device: device(key), codeId: codeId, code: code, createdAt: Timestamps.string(now),
                                                 expiresAt: Timestamps.string(now.addingTimeInterval(600)), nonce: Messages.randomNonce())
        let bytes = JCS.data(message)
        let signature = try await key.sign(bytes, reason: "Enroll this phone as an approver.")
        let envelope = Envelope(alg: "ES256", kid: key.deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
        state.mode = .live
        state.save()
        client = factory.client(for: .live)
        fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(key.deviceId)
        try await client!.consoleEnroll(codeId: codeId, envelope: envelope)
        for _ in 0..<300 {
            let s = try await client!.consoleEnrollState(codeId: codeId)
            if s == "done" { fingerprintToCompare = nil; banner = "Enrolled."; startPolling(); return }
            if s == "refused" || s == "expired" { fingerprintToCompare = nil; banner = "The node did not enroll this phone (\(s))."; return }
            try await Task.sleep(for: .seconds(2))
        }
    }

    private func repin(_ payload: JSONValue) {
        pinRelay(payload)
        state.save()
        client = factory.client(for: .live)
        banner = "Relay pinned again."
    }

    // MARK: Approvals

    private func receive(_ item: JSONValue, pins: [NodePin]) {
        guard let envJSON = item["envelope"], let env = try? Envelope(json: envJSON) else { return }
        let view = Display.view(envJSON, pinned: pins)
        if !view.shown {
            if view.reason == "bad_node_signature" { banner = "Node key changed — pair again." }
            return
        }
        guard let message = try? env.message(), let requestId = message["request_id"]?.stringValue, let display = view.display else { return }
        var status: String? = nil
        if let statusJSON = item["status"], let statusEnv = try? Envelope(json: statusJSON),
           let pin = pins.first(where: { $0.id == statusEnv.kid }), statusEnv.verifyEd25519(spkiHex: pin.key),
           let statusMessage = try? statusEnv.message() {
            status = statusMessage["state"]?.stringValue
        }
        if let i = pending.firstIndex(where: { $0.id == requestId }) {
            pending[i].status = status ?? pending[i].status
            return
        }
        var fullText: [String: String] = [:]
        for entry in Display.build(message, collapse: false)["items"]?.arrayValue ?? [] {
            if let path = entry["path"]?.stringValue { fullText[path] = entry["text"]?.stringValue ?? "" }
        }
        pending.append(PendingItem(id: requestId, envelope: env, message: message, display: display, fullText: fullText,
                                   receivedAt: .now, expiresInMs: item["expires_in_ms"]?.intValue ?? 0, status: status))
    }

    /// Foreground long-poll (the no-push mode, and the fetch after a tap).
    func startPolling() {
        guard mode == .live, pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled, self.mode == .live, let client = self.client {
                do {
                    for item in try await client.approvals(wait: 25) { self.receive(item, pins: self.state.nodes) }
                    self.pending.removeAll { $0.timeLeft == .zero && $0.status == nil }
                } catch {
                    self.fail(error)
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        key?.endSession()
    }

    /// Approve or deny: a fresh biometric signature over the response.
    func decide(_ item: PendingItem, approve: Bool) async {
        guard item.timeLeft > .zero else { banner = "This request has expired."; return }
        do {
            if mode == .demo, let demo {
                let response = try Messages.response(to: item.message, decision: approve ? "approve" : "deny", deviceId: demo.deviceId, signedAt: Timestamps.string(Date()))
                _ = try Envelope.seal(response, kid: demo.deviceId) { try demo.sign($0) }
                setStatus(item.id, approve ? "approved (demo)" : "denied (demo)")
                return
            }
            guard let key, let client else { return }
            let response = try Messages.response(to: item.message, decision: approve ? "approve" : "deny", deviceId: key.deviceId, signedAt: Timestamps.string(Date()))
            let bytes = JCS.data(response)
            let signature = try await key.sign(bytes, reason: approve ? "Approve \(item.display["summary"]?.stringValue ?? "this action")" : "Deny this request")
            let envelope = Envelope(alg: "ES256", kid: key.deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
            while true {
                do {
                    let result = try await client.respond(item.id, envelope: envelope)
                    if result?["accepted"]?.boolValue == false {
                        setStatus(item.id, "refused: \(result?["reason"]?.stringValue ?? "unknown")")
                    }
                    break
                } catch let e as RelayError where e.code == "node_offline" {
                    setStatus(item.id, "Node offline — retrying")
                    guard item.timeLeft > .zero else { setStatus(item.id, "expired"); return }
                    try await Task.sleep(for: .seconds(3))
                }
            }
            if let fresh = try await client.approval(item.id) { receive(fresh, pins: state.nodes) }
        } catch {
            fail(error)
        }
    }

    private func setStatus(_ id: String, _ status: String) {
        if let i = pending.firstIndex(where: { $0.id == id }) { pending[i].status = status }
    }

    // MARK: History, nodes, devices

    func loadHistory(nodeId: String, beforeSeq: Int? = nil) async {
        guard let client, let pin = state.nodes.first(where: { $0.id == nodeId }) else { return }
        do {
            guard let envelope = try await client.history(nodeId: nodeId, limit: 50, beforeSeq: beforeSeq) else { return }
            let result = AuditSlice.verify(envelope, nodeKeyHex: pin.key)
            guard result.ok else { banner = "History from \(pin.name) did not verify (\(result.reason ?? "unknown"))."; return }
            let asOf = (try? Envelope(json: envelope).message())?["created_at"]?.stringValue ?? ""
            history = HistoryPage(nodeId: nodeId, entries: result.entries.reversed(), asOf: asOf)
        } catch {
            fail(error)
        }
    }

    func refreshNodes() async {
        guard let client else { return }
        do {
            for node in try await client.nodes() {
                if let id = node["node_id"]?.stringValue { onlineNodes[id] = node["online"]?.boolValue ?? false }
            }
        } catch {
            fail(error)
        }
    }

    func pairingCode(forNode name: String) async -> String? {
        guard let client else { return nil }
        do {
            return try await client.pairingCode(nodeName: name)?["code"]?.stringValue
        } catch {
            fail(error)
            return nil
        }
    }

    func refreshDevices() async {
        guard let client else { return }
        do { devices = try await client.devices() } catch { fail(error) }
    }

    /// Phone A: create an invite and show it with the relay and node pins.
    func startInvite() async {
        guard let client else { return }
        do {
            guard let invite = try await client.createInvite(), let inviteId = invite["invite_id"]?.stringValue else { return }
            let secret = Messages.randomNonce()
            pendingInvite = (inviteId, secret)
            inviteQR = Messages.encodeQR(.object([
                "t": .string("kl.invite"),
                "relay": .string(state.relayURL ?? ""),
                "relay_spki": .string(state.relaySpki ?? ""),
                "invite_id": .string(inviteId),
                "secret": .string(secret),
                "nodes": .array(state.nodes.map { .object(["id": .string($0.id), "name": .string($0.name), "key": .string($0.key)]) })
            ]))
            for _ in 0..<300 {
                if let claim = try await client.inviteClaim(inviteId), !claim.isNull {
                    guard let device = claim["device"], let mac = claim["mac"]?.stringValue,
                          try Messages.inviteMac(secret: secret, device: device) == mac,
                          let x = device["public_key"]?["x"]?.stringValue, let y = device["public_key"]?["y"]?.stringValue,
                          try Identifiers.deviceId(x: x, y: y) == device["device_id"]?.stringValue else {
                        banner = "The invite was claimed by something that did not scan it. Nothing was enrolled."
                        inviteQR = nil
                        return
                    }
                    inviteQR = nil
                    inviteClaimToConfirm = device
                    return
                }
                try await Task.sleep(for: .seconds(2))
            }
        } catch {
            fail(error)
        }
    }

    /// Phone A, after both screens show the same id: sign B's enrollment.
    func confirmInvitedDevice() async {
        guard let device = inviteClaimToConfirm, let key, let client else { return }
        inviteClaimToConfirm = nil
        do {
            let now = Date()
            let message = Messages.signedEnroll(device: device, enrolledBy: key.deviceId, createdAt: Timestamps.string(now),
                                                expiresAt: Timestamps.string(now.addingTimeInterval(600)), nonce: Messages.randomNonce())
            let bytes = JCS.data(message)
            let signature = try await key.sign(bytes, reason: "Add \(device["name"]?.stringValue ?? "the new phone") as an approver.")
            let result = try await client.enrollDevice(Envelope(alg: "ES256", kid: key.deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature)))
            let states = (result?["nodes"]?.arrayValue ?? []).compactMap { $0["state"]?.stringValue }
            banner = "Sent to \(states.count) node(s). An administrator applies it on each node with `device apply`."
        } catch {
            fail(error)
        }
    }

    /// Phone B: claim an invite from phone A.
    private func claimInvite(_ payload: JSONValue) async throws {
        guard let inviteId = payload["invite_id"]?.stringValue, let secret = payload["secret"]?.stringValue else {
            throw ProtocolError.malformed("incomplete invite")
        }
        if mode == .demo { leaveDemo() }
        pinRelay(payload)
        for node in payload["nodes"]?.arrayValue ?? [] { pinNode(node) }
        let key = try ensureKey()
        state.mode = .live
        state.save()
        client = factory.client(for: .live)
        let device = device(key)
        try await client!.claimInvite(inviteId, device: device, mac: try Messages.inviteMac(secret: secret, device: device))
        fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(key.deviceId)
        banner = "Confirm on the other phone that it shows the same id."
    }

    func revoke(deviceId target: String) async {
        guard let key, let client else { return }
        do {
            let now = Date()
            let message = Messages.revoke(deviceId: target, revokedBy: key.deviceId, reason: "revoked from a phone",
                                          createdAt: Timestamps.string(now), expiresAt: Timestamps.string(now.addingTimeInterval(3600)), nonce: Messages.randomNonce())
            let bytes = JCS.data(message)
            let signature = try await key.sign(bytes, reason: "Revoke this device on every node.")
            _ = try await client.revokeDevice(Envelope(alg: "ES256", kid: key.deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature)))
            await refreshDevices()
        } catch {
            fail(error)
        }
    }

    func registerPushToken(_ token: String) async {
        state.pushToken = token
        state.save()
        guard mode == .live, let client else { return }
        do { try await client.pushToken(token) } catch { fail(error) }
    }

    /// A push carries only { kind, id }: fetch the envelope and verify it.
    func openPushed(requestId: String) async {
        guard let client else { return }
        do {
            if let item = try await client.approval(requestId) { receive(item, pins: state.nodes) }
        } catch {
            fail(error)
        }
    }

    func reset() {
        stopPolling()
        DeviceKey.delete()
        key = nil
        client = nil
        demo = nil
        pending = []
        state = StoredState()
        state.save()
    }
}
```

Create `mobile/ios/App/KingLouieApp.swift`:

```swift
import SwiftUI
import UIKit
import UserNotifications

/// APNs is registered only when the build names a topic (Config/App.xcconfig);
/// without it the app long-polls while it is open.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var onToken: ((String) -> Void)?
    var onOpen: ((String) -> Void)?

    static var pushConfigured: Bool {
        !((Bundle.main.object(forInfoDictionaryKey: "KLApnsTopic") as? String) ?? "").isEmpty
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        guard Self.pushConfigured else { return true }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if granted { DispatchQueue.main.async { application.registerForRemoteNotifications() } }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        onToken?(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    /// The push is { kl: { rid, k } }; only approvals are handled here.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let kl = response.notification.request.content.userInfo["kl"] as? [String: Any]
        if let rid = kl?["rid"] as? String, ((kl?["k"] as? String) ?? "approval") == "approval" {
            await MainActor.run { onOpen?(rid) }
        }
    }
}

@main
struct KingLouieApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onAppear {
                    delegate.onToken = { token in Task { await model.registerPushToken(token) } }
                    delegate.onOpen = { rid in Task { await model.openPushed(requestId: rid) } }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.startPolling() } else { model.stopPolling() }
        }
    }
}
```

Create `mobile/ios/App/QRScannerView.swift`:

```swift
import AVFoundation
import SwiftUI
import UIKit

/// Camera QR scanning with AVFoundation (.qr metadata only).
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.layer.bounds
            view.layer.addSublayer(preview)
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session.stopRunning()
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !delivered, let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            delivered = true
            session.stopRunning()
            onCode?(code)
        }
    }
}
```

Create `mobile/ios/App/Views.swift`:

```swift
import CoreImage.CIFilterBuiltins
import KLProtocol
import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.mode == .welcome {
                WelcomeView()
            } else {
                MainView()
            }
        }
        .alert(model.banner ?? "", isPresented: Binding(get: { model.banner != nil }, set: { if !$0 { model.banner = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }
}

struct ScanSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            VStack {
                QRScannerView { code in
                    dismiss()
                    Task { await model.scanned(code) }
                }
                .frame(maxHeight: 360)
                TextField("Or paste a kl1: code", text: $pasted)
                    .textFieldStyle(.roundedBorder)
                    .padding()
                Button("Use pasted code") {
                    dismiss()
                    let text = pasted
                    Task { await model.scanned(text) }
                }
                .disabled(pasted.isEmpty)
            }
            .navigationTitle("Scan a code")
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 24) {
            Text("King Louie").font(.largeTitle.bold())
            Text("Approve what your machines want to do, with your face or fingerprint.")
                .multilineTextAlignment(.center)
            Button("Scan pairing code") { scanning = true }.buttonStyle(.borderedProminent)
            Button("Try demo") { model.startDemo() }
        }
        .padding()
        .sheet(isPresented: $scanning) { ScanSheet() }
    }
}

struct MainView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if model.mode == .demo {
                Text("Demo — nothing here reaches a real machine").font(.footnote.bold())
                    .frame(maxWidth: .infinity).padding(6).background(.yellow)
            }
            if let fingerprint = model.fingerprintToCompare {
                Text("This phone: \(fingerprint)\nCheck the other screen shows the same.")
                    .font(.footnote.monospaced()).padding(6)
            }
            TabView {
                PendingListView().tabItem { Label("Pending", systemImage: "checkmark.shield") }
                HistoryView().tabItem { Label("History", systemImage: "clock") }
                NodesView().tabItem { Label("Nodes", systemImage: "server.rack") }
                DevicesView().tabItem { Label("Devices", systemImage: "iphone") }
                SettingsView().tabItem { Label("Settings", systemImage: "gear") }
            }
        }
    }
}

func formatLeft(_ d: Duration) -> String {
    let s = Int(d.components.seconds)
    return String(format: "%d:%02d", s / 60, s % 60)
}

struct PendingListView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                List(model.pending) { item in
                    NavigationLink(value: item.id) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.display["node"]?["name"]?.stringValue ?? "").font(.headline)
                            Text(item.display["summary"]?.stringValue ?? "").lineLimit(2)
                            HStack {
                                Text(item.display["origin"]?["client"]?.stringValue ?? "")
                                Spacer()
                                Text(item.status ?? formatLeft(item.timeLeft)).monospacedDigit()
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .overlay { if model.pending.isEmpty { Text("Nothing is waiting for you.").foregroundStyle(.secondary) } }
            }
            .navigationTitle("Pending approvals")
            .navigationDestination(for: String.self) { id in
                if let item = model.pending.first(where: { $0.id == id }) { ApprovalDetailView(itemId: item.id) }
            }
        }
    }
}

/// Every parameter, command-like values in full or head + tail, hidden
/// characters as ‹U+XXXX›, numbers as their JSON text (spec §3.14).
struct ApprovalDetailView: View {
    @EnvironmentObject var model: AppModel
    let itemId: String
    @State private var expanded: Set<String> = []
    @State private var busy = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            if let item = model.pending.first(where: { $0.id == itemId }) {
                Form {
                    Section("Node") {
                        Text(item.display["node"]?["name"]?.stringValue ?? "").font(.headline)
                        Text(item.display["node"]?["id"]?.stringValue ?? "").font(.caption.monospaced())
                    }
                    Section("Action") {
                        Text(item.display["summary"]?.stringValue ?? "")
                        LabeledContent("Kind", value: item.display["kind"]?.stringValue ?? "")
                        LabeledContent("Name", value: item.display["name"]?.stringValue ?? "")
                        if let cwd = item.display["cwd"]?.stringValue { LabeledContent("Directory", value: cwd) }
                        LabeledContent("Asked by", value: originText(item.display["origin"]))
                        LabeledContent("Time left", value: formatLeft(item.timeLeft))
                    }
                    Section("Everything it will do") {
                        ForEach(Array((item.display["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, entry in
                            ItemRow(entry: entry, full: item.fullText[entry["path"]?.stringValue ?? ""] ?? "", expanded: $expanded)
                        }
                    }
                    if let status = item.status {
                        Section("Status") { Text(status) }
                    } else {
                        Section {
                            Button("Approve") { act(item, true) }.disabled(busy || item.timeLeft == .zero)
                            Button("Deny", role: .destructive) { act(item, false) }.disabled(busy || item.timeLeft == .zero)
                        }
                    }
                }
                .navigationTitle("Approval")
            }
        }
    }

    private func originText(_ origin: JSONValue?) -> String {
        guard let o = origin?.objectValue else { return "" }
        return ["client", "session", "job_id", "deviceId"].compactMap { o[$0]?.stringValue }.joined(separator: " · ")
    }

    private func act(_ item: PendingItem, _ approve: Bool) {
        busy = true
        Task {
            await model.decide(item, approve: approve)
            busy = false
        }
    }
}

struct ItemRow: View {
    let entry: JSONValue
    let full: String
    @Binding var expanded: Set<String>

    var body: some View {
        let path = entry["path"]?.stringValue ?? ""
        let hidden = entry["hidden"]?.intValue ?? 0
        VStack(alignment: .leading, spacing: 4) {
            Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
            if hidden > 0 && expanded.contains(path) {
                Text(full).font(.body.monospaced()).textSelection(.enabled)
            } else {
                Text(entry["text"]?.stringValue ?? "").font(.body.monospaced()).textSelection(.enabled)
                if hidden > 0 {
                    Button("\(hidden) characters hidden — Show all") { expanded.insert(path) }.font(.caption)
                    Text(entry["tail"]?.stringValue ?? "").font(.body.monospaced())
                }
            }
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject var model: AppModel
    @State private var nodeId: String = ""

    var body: some View {
        NavigationStack {
            List {
                Picker("Node", selection: $nodeId) {
                    ForEach(model.state.nodes, id: \.id) { Text($0.name).tag($0.id) }
                }
                if let page = model.history, page.nodeId == nodeId {
                    Section("As of \(page.asOf)") {
                        ForEach(Array(page.entries.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading) {
                                Text(entry["kind"]?.stringValue ?? "").font(.headline)
                                Text("#\(entry["seq"]?.intValue ?? 0) · \(entry["at"]?.stringValue ?? "") · \(entry["writer"]?.stringValue ?? "")").font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .onChange(of: nodeId) { _, id in Task { await model.loadHistory(nodeId: id) } }
            .onAppear { if nodeId.isEmpty, let first = model.state.nodes.first { nodeId = first.id } }
        }
    }
}

struct NodesView: View {
    @EnvironmentObject var model: AppModel
    @State private var newNodeName = ""
    @State private var code: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.state.nodes, id: \.id) { node in
                    VStack(alignment: .leading) {
                        HStack {
                            Text(node.name).font(.headline)
                            Spacer()
                            Circle().fill(model.onlineNodes[node.id] == true ? .green : .gray).frame(width: 10, height: 10)
                        }
                        Text(Identifiers.fingerprintGroups(node.id)).font(.caption.monospaced())
                    }
                }
                Section("Pairing code for a new node") {
                    TextField("Node name, e.g. gpu-box", text: $newNodeName)
                    Button("Get code") { Task { code = await model.pairingCode(forNode: newNodeName) } }.disabled(newNodeName.isEmpty || model.mode != .live)
                    if let code { Text(code).font(.body.monospaced()).textSelection(.enabled) }
                }
            }
            .navigationTitle("Nodes")
            .refreshable { await model.refreshNodes() }
        }
    }
}

struct QRImage: View {
    let text: String

    var body: some View {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        let context = CIContext()
        if let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
           let cg = context.createCGImage(image, from: image.extent) {
            return AnyView(Image(decorative: cg, scale: 1).interpolation(.none).resizable().scaledToFit())
        }
        return AnyView(Text(text).font(.caption.monospaced()))
    }
}

struct DevicesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                if let id = model.deviceId {
                    Section("This phone") { Text("d-" + Identifiers.fingerprintGroups(id)).font(.body.monospaced()) }
                }
                Section("Devices") {
                    ForEach(Array(model.devices.enumerated()), id: \.offset) { _, device in
                        let id = device["device_id"]?.stringValue ?? ""
                        VStack(alignment: .leading) {
                            Text("\(device["name"]?.stringValue ?? "") (\(device["platform"]?.stringValue ?? ""))")
                            Text("d-" + Identifiers.fingerprintGroups(id)).font(.caption.monospaced())
                            ForEach(Array((device["nodes"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, n in
                                Text("\(n["node_id"]?.stringValue ?? ""): \(n["state"]?.stringValue ?? "")").font(.caption)
                            }
                            if id != model.deviceId {
                                Button("Revoke", role: .destructive) { Task { await model.revoke(deviceId: id) } }
                            }
                        }
                    }
                }
                Section {
                    Button("Add a device") { Task { await model.startInvite() } }.disabled(model.mode != .live)
                    if let qr = model.inviteQR {
                        QRImage(text: qr).frame(height: 240)
                        Text("Scan this with the new phone.").font(.caption)
                    }
                    if let device = model.inviteClaimToConfirm {
                        Text("New phone \(device["name"]?.stringValue ?? ""): d-\(Identifiers.fingerprintGroups(device["device_id"]?.stringValue ?? ""))")
                            .font(.body.monospaced())
                        Button("It shows the same — add it") { Task { await model.confirmInvitedDevice() } }
                        Button("Cancel", role: .cancel) { model.inviteClaimToConfirm = nil }
                    }
                }
            }
            .navigationTitle("Devices")
            .refreshable { await model.refreshDevices() }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    Text(model.state.relayURL ?? "not paired")
                    Text(model.state.relaySpki ?? "").font(.caption.monospaced())
                    Button("Re-pin the relay (scan a relay code)") { scanning = true }
                }
                if model.mode == .demo {
                    Button("Leave demo") { model.leaveDemo() }
                }
                Section {
                    Button("Reset this phone", role: .destructive) { model.reset() }
                }
                Section("Privacy") {
                    Text("No analytics. The relay sees every action you are asked to approve; see PRIVACY.md.").font(.caption)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $scanning) { ScanSheet() }
        }
    }
}
```

- [ ] **Step 4: Build and check on a device**

Run: `cd mobile/ios && xcodegen generate && xcodebuild -project KingLouie.xcodeproj -scheme KingLouie -destination 'generic/platform=iOS Simulator' build`
Expected: `** BUILD SUCCEEDED **`

Run: `cd mobile/ios/KLProtocol && swift test`
Expected: `Executed 13 tests, with 0 failures` (unchanged).

Manual checks on a phone with Face ID or Touch ID (spec §10 "Manual on devices"), against a test relay and a node from Part 3:

1. Try demo: the yellow Demo banner shows; three requests from `gpu-box`, `laptop`, `web-01` appear; approving one marks it `approved (demo)`; no network traffic (Settings → Leave demo returns to Welcome).
2. Console enrollment: `king-louie-service enroll-device` on the node → scan the QR → Face ID → the id shown on the phone (`d-abcd efgh ijkl mnop`) matches the console prompt → answer `y` → "Enrolled."
3. An unsafe runbook via `mcp` appears within 25 s (no push) with every parameter; a command longer than 2000 characters shows head, tail and "N characters hidden — Show all"; approving runs it once.
4. Change the enrolled biometrics (add a fingerprint/face) → the next approval shows "This phone's key is no longer usable. Enroll it again from a node console or another phone."
5. Replace the relay's certificate with a new key → requests fail with "Relay certificate changed — scan a new relay code"; scanning `relay qr` output re-pins.
6. With `KL_APNS_TOPIC` and `KL_ENTITLEMENTS = App/Push.entitlements` set and an APNs key on the relay: a request produces "Approval needed on web-01"; tapping it opens the request.

- [ ] **Step 5: Commit**

```bash
git add mobile/ios/project.yml mobile/ios/Config mobile/ios/App
git commit -m "feat(ios): approvals app — Secure Enclave key, pinned relay, approval screens

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: Android protocol core against the shared vectors

**Files:**
- Create: `mobile/android/protocol/settings.gradle.kts`, `mobile/android/protocol/build.gradle.kts`, `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/{Encoding,Envelope,Messages,Display,AppCore}.kt`, the Gradle wrapper in `mobile/android/` (`gradlew`, `gradlew.bat`, `gradle/wrapper/`)
- Test: `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/ProtocolVectorTest.kt`

**Interfaces:**
- Consumes: `tests/vectors/approval-v1/*.json` and `keys.json` (passed to the tests as the system property `kl.vectors`).
- Produces (used by Task 27, as `com.example.kinglouie:protocol:1.0` through the composite build): `JsonText.parse`, `Jcs.serialize/bytes/escape`, `B64Url.encode/decode` (strict), `Hex`, `Digest.sha256/sha256B64url/sha256Hex/hmacB64url`, `Identifiers.base32/deviceId(raw, prefix)/deviceId(x, y)/nodeId/fingerprintGroups`, `Identifiers.ED25519_SPKI_PREFIX`, `Timestamps.string/parse`, JSON helpers `str()`, `obj()`, `arr()`, `int()`, `get(key)`, `jsonString(s)`; `Envelope(alg, kid, payload, sig)` with `json`, `payloadBytes()`, `message()`, `verifyEd25519(spkiHex)`, `verifyEs256(x, y)`, `Envelope.fromJson`, `Envelope.seal`; `P256.params/publicKey(x, y)/coordinate`; `P1363.toDer/fromDer`; `Messages.device/response/consoleEnroll/signedEnroll/revoke/inviteMac/phoneAuthString/encodeQr/decodeQr/randomNonce`; `NodePin`, `PhoneView`, `Display.view/build(collapse)/escape/isHidden`; `AuditSlice.verify`; `AppMode`, `RelayClientFactory`, `DemoFleet`; `ProtocolException`.

kotlinx.serialization keeps each JSON number's text in `JsonPrimitive.content`, which is what the display and the JCS re-serialization use. Ed25519 comes from `java.security` (JDK 15+, Android API 33+).

- [ ] **Step 1: Write the failing test**

Generate the Gradle wrapper (needs a local Gradle ≥ 8.7 once):

Run: `cd mobile/android && gradle wrapper --gradle-version 8.10.2 --distribution-type bin`
Expected: `gradlew`, `gradlew.bat` and `gradle/wrapper/gradle-wrapper.{jar,properties}` exist.

Create `mobile/android/protocol/settings.gradle.kts`:

```kotlin
// The approval-v1 protocol core, a plain JVM library so its tests run without
// the Android SDK: `../gradlew test` in this directory. The app includes it as
// a composite build (../settings.gradle.kts).
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "protocol"
```

Create `mobile/android/protocol/build.gradle.kts`:

```kotlin
plugins {
    kotlin("jvm") version "2.0.20"
}

group = "com.example.kinglouie"
version = "1.0"

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    // The vectors the node and iOS use too.
    systemProperty("kl.vectors", projectDir.resolve("../../../tests/vectors/approval-v1").canonicalPath)
    testLogging {
        events("passed", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
```

Create `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/ProtocolVectorTest.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec

/** Every approval-v1 vector whose consumers include "android". */
class ProtocolVectorTest {
    private val dir = File(System.getProperty("kl.vectors") ?: error("run through Gradle: kl.vectors is not set"))

    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())

    @Test
    fun everyAndroidVectorIsCovered() {
        val names = dir.listFiles { f -> f.name.endsWith(".json") && f.name != "keys.json" }!!
            .map { JsonText.parse(it.readBytes()) }
            .filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }
            .map { it["name"].str() }
            .toSet()
        assertEquals(
            setOf("jcs", "device-id-p256", "device-id-ed25519", "request-valid", "request-bad-node-signature",
                "request-unpinned-node", "request-display", "enroll-console", "audit-slice", "phone-api-auth"),
            names
        )
    }

    @Test
    fun jcs() {
        val v = vector("jcs")
        val cases = v["input"]["cases"].arr()!!
        val expected = v["expect"]["canonical"].arr()!!
        cases.zip(expected).forEach { (c, e) -> assertEquals(e.str(), Jcs.serialize(c)) }
    }

    @Test
    fun deviceIds() {
        val p = vector("device-id-p256")
        val ids = p["input"]["jwks"].arr()!!.map { Identifiers.deviceId(it["x"].str()!!, it["y"].str()!!) }
        assertEquals(p["expect"]["device_ids"].arr()!!.map { it.str() }, ids)
        assertEquals(p["expect"]["grouped"].arr()!!.map { it.str() }, ids.map { Identifiers.fingerprintGroups(it) })
        val e = vector("device-id-ed25519")
        assertEquals(e["expect"]["device_id"].str(), Identifiers.deviceId(B64Url.decode(e["input"]["raw"].str()!!), e["input"]["prefix"].str()!!))
    }

    @Test
    fun requestVectors() {
        for (name in listOf("request-valid", "request-bad-node-signature", "request-unpinned-node", "request-display")) {
            val v = vector(name)
            val pins = v["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
            assertEquals(name, v["expect"], Display.view(v["input"]!!, pins).json)
        }
    }

    @Test
    fun showAllKeepsEveryCharacter() {
        val message = Envelope.fromJson(vector("request-display")["input"]!!).message()
        val collapsed = Display.build(message)["items"].arr()!!
        val full = Display.build(message, collapse = false)["items"].arr()!!
        assertEquals(collapsed.map { it["path"] }, full.map { it["path"] })
        val script = full.first { it["path"].str() == "params.script" }
        assertEquals(0, script["hidden"].int())
        assertEquals(message["action"]["params"]["script"].str(), script["text"].str())
    }

    @Test
    fun displayEscapesHiddenCharacters() {
        val input = StringBuilder("a").appendCodePoint(0x202E).append("b").appendCodePoint(0x200B).append("\n").toString()
        val expected = StringBuilder("a").appendCodePoint(0x2039).append("U+202E").appendCodePoint(0x203A).append("b")
            .appendCodePoint(0x2039).append("U+200B").appendCodePoint(0x203A)
            .appendCodePoint(0x2039).append("U+000A").appendCodePoint(0x203A).toString()
        assertEquals(expected, Display.escape(input))
    }

    @Test
    fun auditSlice() {
        val v = vector("audit-slice")
        val result = AuditSlice.verify(v["input"]!!, v["given"]["node"]["key"].str()!!)
        assertTrue(result.ok)
        assertEquals(v["expect"]["entries"].int(), result.entries.size)
        assertFalse(AuditSlice.verify(v["input"]!!, Identifiers.ED25519_SPKI_PREFIX + "00".repeat(32)).ok)
    }

    @Test
    fun phoneApiAuth() {
        val v = vector("phone-api-auth")
        val g = v["given"]!!
        val s = Messages.phoneAuthString(g["method"].str()!!, g["path"].str()!!, g["timestamp"].str()!!, g["body"].str()!!.toByteArray())
        assertEquals(v["expect"]["signing_string"].str(), s)
        val env = Envelope("ES256", g["device"]["device_id"].str()!!, B64Url.encode(s.toByteArray()), v["input"]["signature"].str()!!)
        assertTrue(env.verifyEs256(g["device"]["jwk"]["x"].str()!!, g["device"]["jwk"]["y"].str()!!))
    }

    @Test
    fun consoleEnrollBytes() {
        val v = vector("enroll-console")
        val sent = Envelope.fromJson(v["input"]!!).message()
        val rebuilt = Messages.consoleEnroll(sent["device"]!!, v["given"]["code_id"].str()!!, v["given"]["code"].str()!!,
            sent["created_at"].str()!!, sent["expires_at"].str()!!, sent["nonce"].str()!!)
        assertEquals(v["input"]["payload"].str(), B64Url.encode(Jcs.bytes(rebuilt)))
    }

    @Test
    fun signVerifyAndResponseBytes() {
        val a = JsonText.parse(File(dir, "keys.json").readBytes())["devices"]["A"]!!
        val private = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, B64Url.decode(a["d"].str()!!)), P256.params))
        val request = Envelope.fromJson(vector("request-valid")["input"]!!).message()
        val response = Messages.response(request, "approve", a["id"].str()!!, "2026-09-23T18:04:31.201Z")
        val envelope = Envelope.seal(response, a["id"].str()!!) { bytes ->
            Signature.getInstance("SHA256withECDSA").run { initSign(private); update(bytes); P1363.fromDer(sign()) }
        }
        assertTrue(envelope.verifyEs256(a["jwk"]["x"].str()!!, a["jwk"]["y"].str()!!))
        val committed = Envelope.fromJson(vector("response-approve")["input"]!!)
        assertEquals(String(committed.payloadBytes()), Jcs.serialize(committed.message()))
        assertEquals(committed.payload, envelope.payload)
    }

    @Test
    fun p1363Conversion() {
        val keys = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update("x".toByteArray()); sign() }
        val raw = P1363.fromDer(der)
        assertEquals(64, raw.size)
        assertTrue(Signature.getInstance("SHA256withECDSA").run { initVerify(keys.public); update("x".toByteArray()); verify(P1363.toDer(raw)) })
    }

    @Test
    fun demoModeNeverBuildsTheNetworkClient() {
        var constructed = 0
        val factory = RelayClientFactory { constructed += 1; "client" }
        assertNull(factory.client(AppMode.DEMO))
        assertNull(factory.client(AppMode.WELCOME))
        assertEquals(0, factory.built)
        assertEquals(0, constructed)
        assertEquals("client", factory.client(AppMode.LIVE))
        assertEquals(1, constructed)

        val fleet = DemoFleet()
        assertEquals(listOf("gpu-box", "laptop", "web-01"), fleet.pins.map { it.name })
        val view = Display.view(fleet.request(2, "systemctl restart site").json, fleet.pins)
        assertTrue(view.shown)
        assertEquals("web-01", view.display["node"]["name"].str())
    }

    @Test
    fun qrRoundTrip() {
        val payload = JsonObject(mapOf("t" to JsonPrimitive("kl.relay"), "relay" to JsonPrimitive("https://kl.example.com:8443"), "relay_spki" to JsonPrimitive("sha256/abc")))
        assertEquals(payload, Messages.decodeQr(Messages.encodeQr(payload)))
        try {
            Messages.decodeQr("kl2:xx")
            fail("expected a refusal")
        } catch (e: ProtocolException) {
            assertTrue(e.message!!.contains("kl1"))
        }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: FAIL — `compileTestKotlin` reports `Unresolved reference 'JsonText'` (and the other protocol names).

- [ ] **Step 3: Implement**

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Encoding.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class ProtocolException(message: String) : Exception(message)

/** Parsing keeps every number as the text received (JsonPrimitive.content). */
object JsonText {
    fun parse(text: String): JsonElement = Json.parseToJsonElement(text)
    fun parse(bytes: ByteArray): JsonElement = parse(String(bytes, Charsets.UTF_8))
}

/**
 * RFC 8785 serialization: keys sorted by UTF-16 code units (Kotlin's String
 * order), no whitespace, strings escaped as ECMAScript's JSON.stringify does,
 * numbers written as received.
 */
object Jcs {
    fun serialize(value: JsonElement): String = StringBuilder().also { write(value, it) }.toString()

    fun bytes(value: JsonElement): ByteArray = serialize(value).toByteArray(Charsets.UTF_8)

    fun escape(s: String): String {
        val out = StringBuilder("\"")
        for (ch in s) {
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\b' -> out.append("\\b")
                ch.code == 0x0C -> out.append("\\f")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch.code < 0x20 -> out.append(String.format("\\u%04x", ch.code))
                else -> out.append(ch)
            }
        }
        return out.append('"').toString()
    }

    private fun write(value: JsonElement, out: StringBuilder) {
        when (value) {
            is JsonNull -> out.append("null")
            is JsonPrimitive -> if (value.isString) out.append(escape(value.content)) else out.append(value.content)
            is JsonArray -> {
                out.append('[')
                value.forEachIndexed { i, v -> if (i > 0) out.append(','); write(v, out) }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                value.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    out.append(escape(k)).append(':')
                    write(value.getValue(k), out)
                }
                out.append('}')
            }
        }
    }
}

object B64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    /** Strict: alphabet, no padding, and the one canonical encoding. */
    fun decode(text: String): ByteArray {
        if (!Regex("^[A-Za-z0-9_-]*$").matches(text) || text.length % 4 == 1) throw ProtocolException("not base64url")
        val bytes = Base64.getUrlDecoder().decode(text)
        if (encode(bytes) != text) throw ProtocolException("non-canonical base64url")
        return bytes
    }
}

object Hex {
    fun encode(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun decode(text: String): ByteArray {
        if (text.length % 2 != 0) throw ProtocolException("odd hex")
        return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}

object Digest {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun sha256B64url(bytes: ByteArray): String = B64Url.encode(sha256(bytes))
    fun sha256Hex(bytes: ByteArray): String = Hex.encode(sha256(bytes))
    fun hmacB64url(keyB64url: String, message: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(B64Url.decode(keyB64url), "HmacSHA256"))
        return B64Url.encode(mac.doFinal(message))
    }
}

object Identifiers {
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
    const val ED25519_SPKI_PREFIX = "302a300506032b6570032100"

    fun base32(bytes: ByteArray): String {
        var bits = 0
        var value = 0
        val out = StringBuilder()
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(value shr (bits - 5)) and 31])
                bits -= 5
            }
            value = value and ((1 shl bits) - 1)
        }
        if (bits > 0) out.append(ALPHABET[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    fun deviceId(raw: ByteArray, prefix: String = "d-"): String = prefix + base32(Digest.sha256(raw)).take(16)

    /** d- + base32(sha256(0x04 || x || y))[0..16] */
    fun deviceId(x: String, y: String): String {
        val xb = B64Url.decode(x)
        val yb = B64Url.decode(y)
        if (xb.size != 32 || yb.size != 32) throw ProtocolException("P-256 coordinates are 32 bytes")
        return deviceId(byteArrayOf(0x04) + xb + yb)
    }

    fun nodeId(ed25519Raw: ByteArray): String = deviceId(ed25519Raw, "kl-")

    fun fingerprintGroups(id: String): String = id.substringAfter('-').chunked(4).joinToString(" ")
}

object Timestamps {
    private val format = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
    fun string(instant: Instant): String = format.format(instant)
    fun parse(text: String): Instant = Instant.parse(text)
}

fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonElement?.obj(): JsonObject? = this as? JsonObject
fun JsonElement?.arr(): JsonArray? = this as? JsonArray
fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
fun jsonString(s: String): JsonPrimitive = JsonPrimitive(s)
fun jsonNumberText(text: String): JsonElement = JsonText.parse(text).jsonPrimitive
```

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Envelope.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.X509EncodedKeySpec

/** A signed envelope: signatures cover the payload bytes as received. */
data class Envelope(val alg: String, val kid: String, val payload: String, val sig: String) {
    val json: JsonObject
        get() = JsonObject(mapOf("alg" to jsonString(alg), "kid" to jsonString(kid), "payload" to jsonString(payload), "sig" to jsonString(sig)))

    fun payloadBytes(): ByteArray = B64Url.decode(payload)

    fun message(): JsonElement = JsonText.parse(payloadBytes())

    /** Node signature against a pinned DER SPKI key. */
    fun verifyEd25519(spkiHex: String): Boolean = runCatching {
        if (alg != "Ed25519") return false
        val spki = Hex.decode(spkiHex)
        if (spki.size != 44 || !Hex.encode(spki.copyOfRange(0, 12)).equals(Identifiers.ED25519_SPKI_PREFIX)) return false
        val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(spki))
        val signature = B64Url.decode(sig)
        if (signature.size != 64) return false
        Signature.getInstance("Ed25519").run {
            initVerify(key)
            update(payloadBytes())
            verify(signature)
        }
    }.getOrDefault(false)

    /** Phone signature (P-256, raw r||s) against a device JWK's x and y. */
    fun verifyEs256(x: String, y: String): Boolean = runCatching {
        if (alg != "ES256") return false
        val raw = B64Url.decode(sig)
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(P256.publicKey(x, y))
            update(payloadBytes())
            verify(P1363.toDer(raw))
        }
    }.getOrDefault(false)

    companion object {
        fun fromJson(json: JsonElement): Envelope {
            val o = json.obj() ?: throw ProtocolException("not an envelope")
            if (o.size != 4) throw ProtocolException("not an envelope")
            return Envelope(
                o["alg"].str() ?: throw ProtocolException("alg"),
                o["kid"].str() ?: throw ProtocolException("kid"),
                o["payload"].str() ?: throw ProtocolException("payload"),
                o["sig"].str() ?: throw ProtocolException("sig")
            )
        }

        /** Canonical bytes of `message`, signed by `sign` (raw r||s for ES256). */
        fun seal(message: JsonElement, kid: String, alg: String = "ES256", sign: (ByteArray) -> ByteArray): Envelope {
            val bytes = Jcs.bytes(message)
            return Envelope(alg, kid, B64Url.encode(bytes), B64Url.encode(sign(bytes)))
        }
    }
}

object P256 {
    val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    fun publicKey(x: String, y: String): PublicKey {
        val point = ECPoint(BigInteger(1, B64Url.decode(x)), BigInteger(1, B64Url.decode(y)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
    }

    /** The 32-byte big-endian coordinate of a key component. */
    fun coordinate(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }
}

/** IEEE P1363 (raw r||s) ⇄ DER; Android's Signature speaks DER. */
object P1363 {
    fun toDer(raw: ByteArray): ByteArray {
        if (raw.size != 64) throw ProtocolException("P-256 signatures are 64 bytes")
        fun integer(part: ByteArray): ByteArray {
            var bytes = part.toList()
            while (bytes.size > 1 && bytes[0] == 0.toByte() && (bytes[1].toInt() and 0xff) < 0x80) bytes = bytes.drop(1)
            if ((bytes[0].toInt() and 0xff) >= 0x80) bytes = listOf(0.toByte()) + bytes
            return byteArrayOf(0x02, bytes.size.toByte()) + bytes.toByteArray()
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    fun fromDer(der: ByteArray): ByteArray {
        if (der.size < 8 || der[0] != 0x30.toByte()) throw ProtocolException("not a DER signature")
        var i = 2
        fun read(): ByteArray {
            if (der[i] != 0x02.toByte()) throw ProtocolException("expected INTEGER")
            val len = der[i + 1].toInt()
            var value = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            while (value.size > 32 && value[0] == 0.toByte()) value = value.copyOfRange(1, value.size)
            if (value.size > 32) throw ProtocolException("integer too long")
            return ByteArray(32 - value.size) + value
        }
        return read() + read()
    }
}
```

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Messages.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom

/** The messages a phone builds (docs/protocol/approval-v1.md §3). */
object Messages {
    private val random = SecureRandom()

    fun randomNonce(): String = ByteArray(32).also { random.nextBytes(it) }.let { B64Url.encode(it) }

    fun device(deviceId: String, name: String, platform: String, x: String, y: String): JsonObject = JsonObject(
        mapOf(
            "device_id" to jsonString(deviceId),
            "name" to jsonString(name),
            "platform" to jsonString(platform),
            "public_key" to JsonObject(mapOf("kty" to jsonString("EC"), "crv" to jsonString("P-256"), "x" to jsonString(x), "y" to jsonString(y)))
        )
    )

    fun response(request: JsonElement, decision: String, deviceId: String, signedAt: String): JsonObject {
        require(decision == "approve" || decision == "deny")
        fun field(k: String) = request[k].str() ?: throw ProtocolException("not a request: $k")
        return JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "type" to jsonString("kl.approval.response"),
                "request_id" to jsonString(field("request_id")),
                "node_id" to jsonString(field("node_id")),
                "action_hash" to jsonString(field("action_hash")),
                "nonce" to jsonString(field("nonce")),
                "decision" to jsonString(decision),
                "expires_at" to jsonString(field("expires_at")),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    }

    /** Self-signed console enrollment with code_mac = HMAC-SHA256(code bytes, JCS(message without code_mac)). */
    fun consoleEnroll(device: JsonElement, codeId: String, code: String, createdAt: String, expiresAt: String, nonce: String): JsonObject {
        val fields = linkedMapOf<String, JsonElement>(
            "v" to JsonPrimitive(1),
            "type" to jsonString("kl.device.enroll"),
            "device" to device,
            "enrolled_by" to JsonNull,
            "created_at" to jsonString(createdAt),
            "expires_at" to jsonString(expiresAt),
            "nonce" to jsonString(nonce),
            "code_id" to jsonString(codeId)
        )
        fields["code_mac"] = jsonString(Digest.hmacB64url(code, Jcs.bytes(JsonObject(fields))))
        return JsonObject(fields)
    }

    fun signedEnroll(device: JsonElement, enrolledBy: String, createdAt: String, expiresAt: String, nonce: String): JsonObject = JsonObject(
        mapOf(
            "v" to JsonPrimitive(1),
            "type" to jsonString("kl.device.enroll"),
            "device" to device,
            "enrolled_by" to jsonString(enrolledBy),
            "created_at" to jsonString(createdAt),
            "expires_at" to jsonString(expiresAt),
            "nonce" to jsonString(nonce)
        )
    )

    fun revoke(deviceId: String, revokedBy: String, reason: String, createdAt: String, expiresAt: String, nonce: String): JsonObject = JsonObject(
        mapOf(
            "v" to JsonPrimitive(1),
            "type" to jsonString("kl.device.revoke"),
            "device_id" to jsonString(deviceId),
            "revoked_by" to jsonString(revokedBy),
            "reason" to jsonString(reason),
            "created_at" to jsonString(createdAt),
            "expires_at" to jsonString(expiresAt),
            "nonce" to jsonString(nonce)
        )
    )

    fun inviteMac(secret: String, device: JsonElement): String = Digest.hmacB64url(secret, Jcs.bytes(device))

    fun phoneAuthString(method: String, pathWithQuery: String, timestamp: String, body: ByteArray): String =
        listOf("KL-PHONE-V1", method.uppercase(), pathWithQuery, timestamp, Digest.sha256B64url(body)).joinToString("\n")

    fun encodeQr(obj: JsonElement): String = "kl1:" + B64Url.encode(Jcs.bytes(obj))

    fun decodeQr(text: String): JsonElement {
        if (!text.startsWith("kl1:")) throw ProtocolException("not a kl1: code")
        val value = JsonText.parse(B64Url.decode(text.removePrefix("kl1:")))
        value["t"].str() ?: throw ProtocolException("QR payload has no type")
        return value
    }
}
```

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Display.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class NodePin(val id: String, val name: String, val key: String)

data class PhoneView(val shown: Boolean, val reason: String?, val display: JsonElement?) {
    val json: JsonObject
        get() = JsonObject(mapOf("shown" to JsonPrimitive(shown), "reason" to (reason?.let { jsonString(it) } ?: JsonNull), "display" to (display ?: JsonNull)))
}

/** What the approval screen shows (docs/protocol/approval-v1.md §5). */
object Display {
    const val COLLAPSE_OVER = 2000
    const val HEAD = 1200
    const val TAIL = 400
    private val commandKeys = setOf("command", "script", "argv")

    /** C0, DEL and C1 controls, zero-width and directional marks, bidi embeddings and isolates, BOM. */
    fun isHidden(cp: Int): Boolean = cp <= 0x1F || cp in 0x7F..0x9F || cp in 0x200B..0x200F ||
        cp in 0x202A..0x202E || cp in 0x2066..0x2069 || cp == 0xFEFF

    fun escape(text: String): String {
        val out = StringBuilder()
        text.codePoints().forEach { cp ->
            if (isHidden(cp)) out.appendCodePoint(0x2039).append("U+").append(String.format("%04X", cp)).appendCodePoint(0x203A)
            else out.appendCodePoint(cp)
        }
        return out.toString()
    }

    private fun item(path: String, text: String, tail: String?, hidden: Int): JsonObject = JsonObject(
        mapOf("path" to jsonString(path), "text" to jsonString(text), "tail" to (tail?.let { jsonString(it) } ?: JsonNull), "hidden" to JsonPrimitive(hidden))
    )

    private fun stringItem(path: String, value: String, commandLike: Boolean, collapse: Boolean): JsonObject {
        val cps = value.codePoints().toArray()
        if (collapse && commandLike && cps.size > COLLAPSE_OVER) {
            val head = String(cps, 0, HEAD)
            val tail = String(cps, cps.size - TAIL, TAIL)
            return item(path, escape(head), escape(tail), cps.size - HEAD - TAIL)
        }
        return item(path, escape(value), null, 0)
    }

    private fun flatten(value: JsonElement, path: String, commandLike: Boolean, collapse: Boolean, out: MutableList<JsonElement>) {
        when (value) {
            is JsonNull -> out.add(item(path, "null", null, 0))
            is JsonPrimitive -> if (value.isString) out.add(stringItem(path, value.content, commandLike, collapse)) else out.add(item(path, value.content, null, 0))
            is JsonArray -> when {
                value.isEmpty() -> out.add(item(path, "[]", null, 0))
                commandLike && value.all { it.str() != null } -> out.add(stringItem(path, value.joinToString(" ") { it.str()!! }, true, collapse))
                else -> value.forEachIndexed { i, v -> flatten(v, "$path[$i]", commandLike, collapse, out) }
            }
            is JsonObject -> {
                if (value.isEmpty()) out.add(item(path, "{}", null, 0))
                value.keys.sorted().forEach { k -> flatten(value.getValue(k), "$path.$k", commandLike || k in commandKeys, collapse, out) }
            }
        }
    }

    /** With collapse = false every value is shown whole (the "Show all" view). */
    fun build(message: JsonElement, collapse: Boolean = true): JsonObject {
        val action = message["action"]
        val items = mutableListOf<JsonElement>()
        flatten(action["params"] ?: JsonObject(emptyMap()), "params", false, collapse, items)
        action["steps"].arr()?.forEachIndexed { i, step ->
            val argv = step.arr()
            if (argv != null) items.add(stringItem("steps[$i]", argv.joinToString(" ") { it.str() ?: "" }, true, collapse))
            else items.add(item("steps[$i]", escape(Jcs.serialize(step)), null, 0))
        }
        val origin = (message["origin"].obj() ?: JsonObject(emptyMap())).mapValues { (_, v) -> v.str()?.let { jsonString(escape(it)) } ?: JsonNull }
        return JsonObject(
            mapOf(
                "node" to JsonObject(mapOf("id" to (message["node_id"] ?: JsonNull), "name" to jsonString(escape(message["node_name"].str() ?: "")))),
                "kind" to (action["kind"] ?: JsonNull),
                "name" to jsonString(escape(action["name"].str() ?: "")),
                "summary" to jsonString(escape(action["summary"].str() ?: "")),
                "cwd" to (action["cwd"].str()?.let { jsonString(escape(it)) } ?: JsonNull),
                "origin" to JsonObject(origin),
                "items" to JsonArray(items)
            )
        )
    }

    private fun wellFormedRequest(m: JsonElement): Boolean =
        m["v"].int() == 1 && m["type"].str() == "kl.approval.request" && m["request_id"].str() != null &&
            m["node_id"].str() != null && m["node_name"].str() != null && m["action_hash"].str() != null &&
            m["nonce"].str() != null && m["created_at"].str() != null && m["expires_at"].str() != null &&
            m["action"]["kind"].str() != null && m["action"]["summary"].str() != null && m["action"]["params"].obj() != null &&
            m["origin"].obj() != null

    /** Hidden unless the node is pinned (from a QR code only) and its signature verifies. */
    fun view(envelopeJson: JsonElement, pinned: List<NodePin>): PhoneView {
        val envelope = runCatching { Envelope.fromJson(envelopeJson) }.getOrNull()
        val message = envelope?.let { runCatching { it.message() }.getOrNull() }
        if (envelope == null || message == null || !wellFormedRequest(message)) return PhoneView(false, "malformed", null)
        val pin = pinned.firstOrNull { it.id == message["node_id"].str() }
        if (pin == null || envelope.kid != pin.id) return PhoneView(false, "unpinned_node", null)
        if (!envelope.verifyEd25519(pin.key)) return PhoneView(false, "bad_node_signature", null)
        return PhoneView(true, null, build(message))
    }
}

/** History slices: signature, then each entry's hash and the chain. */
object AuditSlice {
    data class Result(val ok: Boolean, val reason: String?, val entries: List<JsonElement>)

    fun verify(envelopeJson: JsonElement, nodeKeyHex: String): Result {
        val envelope = runCatching { Envelope.fromJson(envelopeJson) }.getOrNull() ?: return Result(false, "malformed", emptyList())
        if (!envelope.verifyEd25519(nodeKeyHex)) return Result(false, "bad_signature", emptyList())
        val message = runCatching { envelope.message() }.getOrNull()
        val entries = message["entries"].arr()
        if (message["type"].str() != "kl.audit.slice" || message["node_id"].str() != envelope.kid || entries == null) {
            return Result(false, "malformed", emptyList())
        }
        var previous: JsonElement? = null
        for (entry in entries) {
            val fields = entry.obj() ?: return Result(false, "malformed", emptyList())
            val hash = fields["hash"].str() ?: return Result(false, "malformed", emptyList())
            if (Digest.sha256Hex(Jcs.bytes(JsonObject(fields - "hash"))) != hash) return Result(false, "hash_mismatch", emptyList())
            val prevSeq = previous["seq"].int()
            if (previous != null && (entry["seq"].int() != (prevSeq ?: -1) + 1 || entry["prev"].str() != previous["hash"].str())) {
                return Result(false, "broken_chain", emptyList())
            }
            previous = entry
        }
        return Result(true, null, entries)
    }
}
```

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/AppCore.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.UUID

enum class AppMode { WELCOME, DEMO, LIVE }

/** The only way the app obtains a network client; demo mode never gets one. */
class RelayClientFactory<C>(private val make: () -> C) {
    var built = 0
        private set

    fun client(mode: AppMode): C? {
        if (mode != AppMode.LIVE) return null
        built += 1
        return make()
    }
}

/** Three pretend nodes with in-app keys and a software phone key. No network. */
class DemoFleet(names: List<String> = listOf("gpu-box", "laptop", "web-01")) {
    private class Node(val pin: NodePin, val keys: KeyPair)

    private val nodes: List<Node> = names.map { name ->
        val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val spki = keys.public.encoded
        val raw = spki.copyOfRange(spki.size - 32, spki.size)
        Node(NodePin(Identifiers.nodeId(raw), name, Hex.encode(spki)), keys)
    }

    private val deviceKeys: KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    val pins: List<NodePin> get() = nodes.map { it.pin }

    val deviceId: String
        get() {
            val pub = deviceKeys.public as ECPublicKey
            return Identifiers.deviceId(byteArrayOf(0x04) + P256.coordinate(pub.w.affineX) + P256.coordinate(pub.w.affineY))
        }

    fun request(index: Int, command: String, now: Instant = Instant.now()): Envelope {
        val node = nodes[index]
        val action = JsonObject(
            mapOf(
                "kind" to jsonString("tool"),
                "name" to jsonString("Bash"),
                "params" to JsonObject(mapOf("command" to jsonString(command))),
                "cwd" to jsonString("/srv/site"),
                "summary" to jsonString("Bash($command)")
            )
        )
        val message = JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "type" to jsonString("kl.approval.request"),
                "request_id" to jsonString(UUID.randomUUID().toString()),
                "node_id" to jsonString(node.pin.id),
                "node_name" to jsonString(node.pin.name),
                "action" to action,
                "action_hash" to jsonString(Digest.sha256B64url(Jcs.bytes(action))),
                "origin" to JsonObject(mapOf("client" to jsonString("demo"), "session" to JsonNull, "job_id" to JsonNull)),
                "created_at" to jsonString(Timestamps.string(now)),
                "expires_at" to jsonString(Timestamps.string(now.plusSeconds(300))),
                "nonce" to jsonString(Messages.randomNonce())
            )
        )
        return Envelope.seal(message, node.pin.id, "Ed25519") { bytes ->
            Signature.getInstance("Ed25519").run { initSign(node.keys.private); update(bytes); sign() }
        }
    }

    /** The demo software key; dropped with the fleet when the owner leaves demo. */
    fun sign(bytes: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(deviceKeys.private)
        update(bytes)
        P1363.fromDer(sign())
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: `BUILD SUCCESSFUL`, 13 tests passed (`build/test-results/test/TEST-com.example.kinglouie.protocol.ProtocolVectorTest.xml` shows `tests="13" failures="0" errors="0"`) — the `android` vectors, phone-side JCS, sign → verify, P1363 ⇄ DER, display escapes and "Show all", QR round trip, and demo mode never building the network client.

- [ ] **Step 5: Commit**

```bash
git add mobile/android/gradlew mobile/android/gradlew.bat mobile/android/gradle mobile/android/protocol
git commit -m "feat(android): approval-v1 protocol core passing the shared vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: Android app (`fcm` and `nopush` flavors)

**Files:**
- Create: `mobile/android/settings.gradle.kts`, `mobile/android/build.gradle.kts`, `mobile/android/gradle.properties`, `mobile/android/local.properties.example`, `mobile/android/app/build.gradle.kts`, `mobile/android/app/src/main/AndroidManifest.xml`, `mobile/android/app/src/main/kotlin/com/example/kinglouie/{KingLouieApplication,MainActivity,AppModel,DeviceKey,RelayApi,QrScanner,Screens}.kt`, `mobile/android/app/src/fcm/AndroidManifest.xml`, `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt`, `mobile/android/app/src/nopush/kotlin/com/example/kinglouie/push/Push.kt`
- Test: compiling both flavors, and the manual device checks below

**Interfaces:**
- Consumes: the protocol core (Task 26) via `includeBuild("protocol")`; the relay's phone API.
- Produces: the app. `DeviceKey` (Android Keystore EC `secp256r1`, `setUserAuthenticationRequired(true)`, `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`, `setInvalidatedByBiometricEnrollment(true)`, `setIsStrongBoxBacked(true)` with TEE fallback; signs through `BiometricPrompt` + `CryptoObject`, DER → P1363; `KeyInvalidatedException`); `PinningTrustManager` (leaf SPKI SHA-256 pin, CAs ignored) and `RelayApi` (device-signed requests, one clock-skew retry, every §4.5 route); `AppModel` (pairing, invites, "Check for requests", approve/deny with node-offline retries, history, nodes, devices, push token, demo, reset) held by `KingLouieApplication`; Compose screens Welcome, Pending, Approval detail, History, Nodes, Devices, Settings; `Push` per flavor (`fcm`: FCM token registration and a data-message service raising a generic local notification; `nopush`: nothing).

- [ ] **Step 1: Write the failing check**

Create `mobile/android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "KingLouie"
// The protocol core is its own build so its tests run without the Android SDK.
includeBuild("protocol")
include(":app")
```

Create `mobile/android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}
```

Create `mobile/android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
```

Create `mobile/android/local.properties.example`:

```text
# Copy to local.properties (never committed) and fill in.

# Where the Android SDK is installed on this machine.
sdk.dir=/path/to/Android/sdk

# Your application id (the package users install).
kl.applicationId=com.example.kinglouie

# Push (optional, program Q-A). The `nopush` flavor needs nothing. For the
# `fcm` flavor, download google-services.json from your own Firebase project
# and put it at app/src/fcm/google-services.json; the build applies the
# google-services plugin only when that file exists.
```

Create `mobile/android/app/build.gradle.kts`:

```kotlin
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.example.kinglouie"
    compileSdk = 34

    defaultConfig {
        applicationId = localProperties.getProperty("kl.applicationId", "com.example.kinglouie")
        // Ed25519 in java.security from API 33 (spec §12).
        minSdk = 33
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    flavorDimensions += "push"
    productFlavors {
        create("fcm") { dimension = "push" }
        create("nopush") { dimension = "push" }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.example.kinglouie:protocol:1.0")
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.fragment:fragment-ktx:1.8.3")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    "fcmImplementation"("com.google.firebase:firebase-messaging:24.0.1")
}

// Only an owner who configured their own Firebase project gets the plugin.
if (file("src/fcm/google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
```

Copy `local.properties.example` to `local.properties` and set `sdk.dir` to the Android SDK (platform 34 and build-tools 34 installed).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile/android && ./gradlew :app:compileNopushDebugKotlin`
Expected: FAIL — the manifest and sources do not exist yet (`processNopushDebugMainManifest` cannot find `AndroidManifest.xml`).

- [ ] **Step 3: Implement**

Create `mobile/android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />

    <application
        android:name=".KingLouieApplication"
        android:allowBackup="false"
        android:label="King Louie"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/KingLouieApplication.kt`:

```kotlin
package com.example.kinglouie

import android.app.Application

/** Holds the one AppModel, so it outlives activity recreation. */
class KingLouieApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        model = AppModel(this)
    }
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/DeviceKey.kt`:

```kotlin
package com.example.kinglouie

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.P1363
import com.example.kinglouie.protocol.P256
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class KeyInvalidatedException : Exception(DeviceKey.INVALIDATED_MESSAGE)

/**
 * This phone's approval key: Android Keystore P-256, StrongBox when the phone
 * has it (TEE otherwise), usable only through a strong-biometric prompt for
 * each signature, and invalidated when the enrolled biometrics change.
 */
class DeviceKey private constructor(private val publicKey: ECPublicKey) {
    val x: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineX))
    val y: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineY))
    val deviceId: String get() = Identifiers.deviceId(x, y)

    /** One biometric prompt, one signature (raw r||s). */
    suspend fun sign(activity: FragmentActivity, data: ByteArray, title: String): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        try {
            signature.initSign(privateKey())
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw KeyInvalidatedException()
        }
        val authorized = suspendCancellableCoroutine<Signature> { cont ->
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    cont.resume(result.cryptoObject!!.signature!!)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    cont.resumeWithException(IllegalStateException(errString.toString()))
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
        }
        authorized.update(data)
        return P1363.fromDer(authorized.sign())
    }

    companion object {
        const val ALIAS = "kl.device-key"
        const val INVALIDATED_MESSAGE = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

        private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        private fun privateKey(): PrivateKey = keyStore().getKey(ALIAS, null) as PrivateKey

        fun load(): DeviceKey? {
            val cert = keyStore().getCertificate(ALIAS) ?: return null
            return DeviceKey(cert.publicKey as ECPublicKey)
        }

        /** Made at the first real pairing (never in demo mode). */
        fun create(): DeviceKey {
            fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .setIsStrongBoxBacked(strongBox)
                .build()
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val pair = try {
                generator.initialize(spec(true))
                generator.generateKeyPair()
            } catch (e: StrongBoxUnavailableException) {
                generator.initialize(spec(false))
                generator.generateKeyPair()
            }
            return DeviceKey(pair.public as ECPublicKey)
        }

        fun delete() {
            keyStore().deleteEntry(ALIAS)
        }
    }
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt`:

```kotlin
package com.example.kinglouie

import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Digest
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class RelayException(val status: Int, val code: String, message: String) : Exception(message.ifEmpty { code })

/** Trusts exactly the relay whose leaf certificate's SPKI hashes to the pin; CAs are ignored. */
class PinningTrustManager(private val pin: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
        val actual = "sha256/" + Digest.sha256B64url(leaf.publicKey.encoded)
        if (actual != pin) throw CertificateException("Relay certificate changed — scan a new relay code")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = throw CertificateException("not a server")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** The relay's phone API. `signer` signs S for device-authenticated routes. */
class RelayApi(
    private val base: String,
    pin: String,
    private val deviceId: String?,
    private val signer: (suspend (ByteArray) -> ByteArray)?
) {
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(PinningTrustManager(pin)), null) }
    private var clockOffset: Duration = Duration.ZERO

    suspend fun request(method: String, pathWithQuery: String, body: JsonElement? = null, auth: Boolean = true, retried: Boolean = false): Pair<Int, JsonElement?> {
        val bytes = body?.let { Jcs.bytes(it) } ?: ByteArray(0)
        val headers = mutableMapOf<String, String>()
        if (auth && deviceId != null && signer != null) {
            val timestamp = Timestamps.string(Instant.now().plus(clockOffset))
            val s = Messages.phoneAuthString(method, pathWithQuery, timestamp, bytes)
            headers["X-KL-Device"] = deviceId
            headers["X-KL-Timestamp"] = timestamp
            headers["X-KL-Signature"] = B64Url.encode(signer.invoke(s.toByteArray()))
        }
        val (status, json) = withContext(Dispatchers.IO) {
            val conn = URL(base.trimEnd('/') + pathWithQuery).openConnection() as HttpsURLConnection
            conn.sslSocketFactory = ssl.socketFactory
            // The SPKI pin, not a hostname, is what identifies the relay.
            conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
            conn.requestMethod = method
            conn.connectTimeout = 15000
            conn.readTimeout = 40000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(bytes) }
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            val text = stream?.use { String(it.readBytes()) } ?: ""
            code to (if (text.isEmpty()) null else runCatching { JsonText.parse(text) }.getOrNull())
        }
        if (status == 401 && json["error"].str() == "clock_skew" && !retried) {
            val server = json["server_time"].str()?.let { Timestamps.parse(it) }
            if (server != null) {
                clockOffset = Duration.between(Instant.now(), server)
                return request(method, pathWithQuery, body, auth, true)
            }
        }
        if (status >= 400) throw RelayException(status, json["error"].str() ?: "http_$status", json["message"].str() ?: "")
        return status to json
    }

    suspend fun approvals(wait: Int): List<JsonElement> = request("GET", "/v1/approvals?wait=$wait").second.arr() ?: emptyList()
    suspend fun approval(id: String): JsonElement? = request("GET", "/v1/approvals/$id").second
    suspend fun respond(id: String, envelope: Envelope): JsonElement? = request("POST", "/v1/approvals/$id/response", envelope.json).second
    suspend fun nodes(): List<JsonElement> = request("GET", "/v1/nodes").second.arr() ?: emptyList()
    suspend fun history(nodeId: String, limit: Int, beforeSeq: Int?): JsonElement? =
        request("GET", "/v1/nodes/$nodeId/history?limit=$limit" + (beforeSeq?.let { "&before_seq=$it" } ?: "")).second
    suspend fun pairingCode(nodeName: String): JsonElement? =
        request("POST", "/v1/pairing-codes", JsonObject(mapOf("node_name" to jsonString(nodeName)))).second
    suspend fun createInvite(): JsonElement? = request("POST", "/v1/devices/invites").second
    suspend fun inviteClaim(id: String): JsonElement? = request("GET", "/v1/devices/invites/$id").second["claim"]
    suspend fun claimInvite(id: String, device: JsonElement, mac: String) {
        request("POST", "/v1/devices/invites/$id/claim", JsonObject(mapOf("device" to device, "mac" to jsonString(mac))), auth = false)
    }
    suspend fun enrollDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/enroll", envelope.json).second
    suspend fun revokeDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/revoke", envelope.json).second
    suspend fun devices(): List<JsonElement> = request("GET", "/v1/devices").second.arr() ?: emptyList()
    suspend fun pushToken(token: String) {
        request("PUT", "/v1/push-token", JsonObject(mapOf("platform" to jsonString("fcm"), "token" to jsonString(token))))
    }
    suspend fun consoleEnroll(codeId: String, envelope: Envelope) {
        request("POST", "/v1/enroll/$codeId", envelope.json, auth = false)
    }
    suspend fun consoleEnrollState(codeId: String): String = request("GET", "/v1/enroll/$codeId", auth = false).second["state"].str() ?: "waiting"
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt`:

```kotlin
package com.example.kinglouie

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.AuditSlice
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.DemoFleet
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.RelayClientFactory
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

/** What the app keeps (mobile/PRIVACY.md): relay pin, node pins, key alias, push token. */
class Storage(context: Context) {
    private val prefs = context.getSharedPreferences("kl.state", Context.MODE_PRIVATE)

    var mode: AppMode
        get() = AppMode.valueOf(prefs.getString("mode", AppMode.WELCOME.name)!!)
        set(v) = prefs.edit().putString("mode", v.name).apply()
    var relayUrl: String?
        get() = prefs.getString("relayUrl", null)
        set(v) = prefs.edit().putString("relayUrl", v).apply()
    var relaySpki: String?
        get() = prefs.getString("relaySpki", null)
        set(v) = prefs.edit().putString("relaySpki", v).apply()
    var pushToken: String?
        get() = prefs.getString("pushToken", null)
        set(v) = prefs.edit().putString("pushToken", v).apply()
    var nodes: List<NodePin>
        get() = prefs.getString("nodes", null)?.let { text ->
            JsonText.parse(text).arr()!!.map { NodePin(it["id"].str()!!, it["name"].str()!!, it["key"].str()!!) }
        } ?: emptyList()
        set(v) = prefs.edit().putString("nodes", Jcs.serialize(JsonArray(v.map {
            JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key)))
        }))).apply()

    fun clear() = prefs.edit().clear().apply()
}

class PendingItem(
    val id: String,
    val message: JsonElement,
    val display: JsonElement,
    val fullText: Map<String, String>,
    private val receivedAtMs: Long,
    private val expiresInMs: Long,
    initialStatus: String?
) {
    var status by mutableStateOf(initialStatus)

    /** From receipt, on the monotonic clock. */
    val timeLeftMs: Long get() = (expiresInMs - (SystemClock.elapsedRealtime() - receivedAtMs)).coerceAtLeast(0)
}

class AppModel(context: Context) {
    private val storage = Storage(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var key: DeviceKey? = DeviceKey.load()
    private var demo: DemoFleet? = null
    private var client: RelayApi? = null
    private var pollJob: Job? = null
    var activity: FragmentActivity? = null

    var mode by mutableStateOf(storage.mode)
        private set
    var banner by mutableStateOf<String?>(null)
    var fingerprintToCompare by mutableStateOf<String?>(null)
    var inviteQr by mutableStateOf<String?>(null)
    var inviteClaim by mutableStateOf<JsonElement?>(null)
    var history by mutableStateOf<Pair<String, List<JsonElement>>?>(null)
    val pending = mutableStateListOf<PendingItem>()
    val devices = mutableStateListOf<JsonElement>()
    val online = mutableStateMapOf<String, Boolean>()
    val nodes: List<NodePin> get() = storage.nodes
    val relayUrl: String? get() = storage.relayUrl
    val relaySpki: String? get() = storage.relaySpki
    val deviceId: String? get() = if (mode == AppMode.DEMO) demo?.deviceId else key?.deviceId

    private val factory = RelayClientFactory {
        val signer: (suspend (ByteArray) -> ByteArray)? = key?.let { k -> { data -> k.sign(activity!!, data, "Check your relay") } }
        RelayApi(storage.relayUrl ?: "https://invalid.example.com", storage.relaySpki ?: "", key?.deviceId, signer)
    }

    init {
        if (mode == AppMode.DEMO) startDemo()
        if (mode == AppMode.LIVE) client = factory.client(AppMode.LIVE)
    }

    private fun fail(e: Throwable) {
        banner = when (e) {
            is KeyInvalidatedException -> DeviceKey.INVALIDATED_MESSAGE
            is RelayException -> if (e.code == "clock_skew") "Check the phone's clock." else e.message
            is javax.net.ssl.SSLHandshakeException -> "Relay certificate changed — scan a new relay code."
            else -> e.message ?: e.toString()
        }
    }

    private fun changeMode(m: AppMode) {
        mode = m
        storage.mode = m
    }

    // Demo

    fun startDemo() {
        val fleet = DemoFleet()
        demo = fleet
        changeMode(AppMode.DEMO)
        pending.clear()
        listOf("nvidia-smi --gpu-reset", "rm -rf ~/Downloads/old", "systemctl restart site").forEachIndexed { i, command ->
            receive(JsonObject(mapOf("envelope" to fleet.request(i, command).json, "expires_in_ms" to JsonPrimitive(300000), "status" to JsonNull)), fleet.pins)
        }
    }

    /** Leaving demo drops the fleet and its software key. */
    fun leaveDemo() {
        demo = null
        pending.clear()
        storage.clear()
        changeMode(AppMode.WELCOME)
    }

    // Scanning

    fun scanned(text: String) = scope.launch {
        try {
            val payload = Messages.decodeQr(text.trim())
            when (payload["t"].str()) {
                "kl.pair" -> pairAtConsole(payload)
                "kl.invite" -> claimInvite(payload)
                "kl.relay" -> { pinRelay(payload); client = factory.client(AppMode.LIVE); banner = "Relay pinned again." }
                else -> banner = "That is not a King Louie code."
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    private fun pinRelay(payload: JsonElement) {
        storage.relayUrl = payload["relay"].str()
        storage.relaySpki = payload["relay_spki"].str()
    }

    private fun pinNode(node: JsonElement) {
        val id = node["id"].str() ?: return
        storage.nodes = storage.nodes.filter { it.id != id } + NodePin(id, node["name"].str() ?: id, node["key"].str() ?: return)
    }

    private fun ensureKey(): DeviceKey = key ?: DeviceKey.create().also { key = it }

    private fun deviceJson(k: DeviceKey) = Messages.device(k.deviceId, Build.MODEL, "android", k.x, k.y)

    private fun envelopeOf(message: JsonElement, kid: String, signature: ByteArray) =
        Envelope("ES256", kid, B64Url.encode(Jcs.bytes(message)), B64Url.encode(signature))

    private suspend fun pairAtConsole(payload: JsonElement) {
        val codeId = payload["code_id"].str() ?: throw IllegalArgumentException("incomplete pairing code")
        val code = payload["code"].str() ?: throw IllegalArgumentException("incomplete pairing code")
        if (mode == AppMode.DEMO) leaveDemo()
        pinRelay(payload)
        payload["node"]?.let { pinNode(it) }
        val k = ensureKey()
        val now = Instant.now()
        val message = Messages.consoleEnroll(deviceJson(k), codeId, code, Timestamps.string(now), Timestamps.string(now.plusSeconds(600)), Messages.randomNonce())
        val signature = k.sign(activity!!, Jcs.bytes(message), "Enroll this phone as an approver")
        changeMode(AppMode.LIVE)
        client = factory.client(AppMode.LIVE)
        fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(k.deviceId)
        client!!.consoleEnroll(codeId, envelopeOf(message, k.deviceId, signature))
        repeat(300) {
            when (val s = client!!.consoleEnrollState(codeId)) {
                "done" -> { fingerprintToCompare = null; banner = "Enrolled."; return }
                "refused", "expired" -> { fingerprintToCompare = null; banner = "The node did not enroll this phone ($s)."; return }
            }
            delay(2000)
        }
    }

    // Approvals

    private fun receive(item: JsonElement, pins: List<NodePin>) {
        val envJson = item["envelope"] ?: return
        val view = Display.view(envJson, pins)
        if (!view.shown) {
            if (view.reason == "bad_node_signature") banner = "Node key changed — pair again."
            return
        }
        val envelope = Envelope.fromJson(envJson)
        val message = envelope.message()
        val id = message["request_id"].str() ?: return
        val status = item["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() }
            ?.takeIf { s -> pins.any { it.id == s.kid && s.verifyEd25519(it.key) } }?.message()?.get("state").str()
        val existing = pending.indexOfFirst { it.id == id }
        if (existing >= 0) {
            if (status != null) pending[existing].status = status
            return
        }
        val full = Display.build(message, collapse = false)["items"].arr().orEmpty().associate { (it["path"].str() ?: "") to (it["text"].str() ?: "") }
        pending.add(PendingItem(id, message, view.display!!, full, SystemClock.elapsedRealtime(), (item["expires_in_ms"].int() ?: 0).toLong(), status))
    }

    /**
     * One long-poll (up to 25 s). The approval key needs a biometric prompt for
     * every signature, API requests included (spec §3.14 key parameters), so
     * the nopush flavor checks when the owner asks rather than continuously.
     */
    fun checkNow() {
        if (mode != AppMode.LIVE || pollJob?.isActive == true) return
        pollJob = scope.launch {
            try {
                client?.approvals(25)?.forEach { receive(it, storage.nodes) }
                pending.removeAll { it.timeLeftMs == 0L && it.status == null }
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun decide(item: PendingItem, approve: Boolean) = scope.launch {
        if (item.timeLeftMs == 0L) { banner = "This request has expired."; return@launch }
        try {
            val fleet = demo
            if (mode == AppMode.DEMO && fleet != null) {
                val response = Messages.response(item.message, if (approve) "approve" else "deny", fleet.deviceId, Timestamps.string(Instant.now()))
                Envelope.seal(response, fleet.deviceId) { fleet.sign(it) }
                setStatus(item.id, if (approve) "approved (demo)" else "denied (demo)")
                return@launch
            }
            val k = key ?: return@launch
            val api = client ?: return@launch
            val response = Messages.response(item.message, if (approve) "approve" else "deny", k.deviceId, Timestamps.string(Instant.now()))
            val signature = k.sign(activity!!, Jcs.bytes(response), if (approve) "Approve: ${item.display["summary"].str()}" else "Deny this request")
            val envelope = envelopeOf(response, k.deviceId, signature)
            while (true) {
                try {
                    val result = api.respond(item.id, envelope)
                    if (result["accepted"]?.let { (it as? JsonPrimitive)?.content } == "false") setStatus(item.id, "refused: ${result["reason"].str()}")
                    break
                } catch (e: RelayException) {
                    if (e.code != "node_offline") throw e
                    setStatus(item.id, "Node offline — retrying")
                    if (item.timeLeftMs == 0L) { setStatus(item.id, "expired"); return@launch }
                    delay(3000)
                }
            }
            api.approval(item.id)?.let { receive(it, storage.nodes) }
        } catch (e: Exception) {
            fail(e)
        }
    }

    private fun setStatus(id: String, status: String) {
        val i = pending.indexOfFirst { it.id == id }
        if (i >= 0) pending[i].status = status
    }

    // History, nodes, devices

    fun loadHistory(nodeId: String) = scope.launch {
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: return@launch
        try {
            val envelope = client?.history(nodeId, 50, null) ?: return@launch
            val result = AuditSlice.verify(envelope, pin.key)
            if (!result.ok) { banner = "History from ${pin.name} did not verify (${result.reason})."; return@launch }
            val asOf = Envelope.fromJson(envelope).message()["created_at"].str() ?: ""
            history = asOf to result.entries.reversed()
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshNodes() = scope.launch {
        try { client?.nodes()?.forEach { n -> n["node_id"].str()?.let { online[it] = (n["online"] as? JsonPrimitive)?.content == "true" } } } catch (e: Exception) { fail(e) }
    }

    fun pairingCode(name: String, onCode: (String) -> Unit) = scope.launch {
        try { client?.pairingCode(name)?.get("code").str()?.let(onCode) } catch (e: Exception) { fail(e) }
    }

    fun refreshDevices() = scope.launch {
        try { val list = client?.devices() ?: return@launch; devices.clear(); devices.addAll(list) } catch (e: Exception) { fail(e) }
    }

    /** Phone A: show an invite with the relay and node pins, then wait for the claim. */
    fun startInvite() = scope.launch {
        val api = client ?: return@launch
        try {
            val inviteId = api.createInvite()["invite_id"].str() ?: return@launch
            val secret = Messages.randomNonce()
            inviteQr = Messages.encodeQr(JsonObject(mapOf(
                "t" to jsonString("kl.invite"),
                "relay" to jsonString(storage.relayUrl ?: ""),
                "relay_spki" to jsonString(storage.relaySpki ?: ""),
                "invite_id" to jsonString(inviteId),
                "secret" to jsonString(secret),
                "nodes" to JsonArray(storage.nodes.map { JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key))) })
            )))
            repeat(300) {
                val claim = api.inviteClaim(inviteId)
                if (claim != null && claim !is JsonNull) {
                    inviteQr = null
                    val device = claim["device"]
                    val pk = device["public_key"]
                    val ok = device != null && claim["mac"].str() == Messages.inviteMac(secret, device) &&
                        runCatching { Identifiers.deviceId(pk["x"].str()!!, pk["y"].str()!!) }.getOrNull() == device["device_id"].str()
                    if (!ok) { banner = "The invite was claimed by something that did not scan it. Nothing was enrolled."; return@launch }
                    inviteClaim = device
                    return@launch
                }
                delay(2000)
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Phone A, after both screens show the same id: sign B's enrollment. */
    fun confirmInvited() = scope.launch {
        val device = inviteClaim ?: return@launch
        inviteClaim = null
        val k = key ?: return@launch
        try {
            val now = Instant.now()
            val message = Messages.signedEnroll(device, k.deviceId, Timestamps.string(now), Timestamps.string(now.plusSeconds(600)), Messages.randomNonce())
            val signature = k.sign(activity!!, Jcs.bytes(message), "Add ${device["name"].str()} as an approver")
            val result = client?.enrollDevice(envelopeOf(message, k.deviceId, signature))
            banner = "Sent to ${result["nodes"].arr()?.size ?: 0} node(s). An administrator applies it on each node with `device apply`."
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Phone B: claim phone A's invite. */
    private suspend fun claimInvite(payload: JsonElement) {
        val inviteId = payload["invite_id"].str() ?: throw IllegalArgumentException("incomplete invite")
        val secret = payload["secret"].str() ?: throw IllegalArgumentException("incomplete invite")
        if (mode == AppMode.DEMO) leaveDemo()
        pinRelay(payload)
        payload["nodes"].arr()?.forEach { pinNode(it) }
        val k = ensureKey()
        changeMode(AppMode.LIVE)
        client = factory.client(AppMode.LIVE)
        val device = deviceJson(k)
        client!!.claimInvite(inviteId, device, Messages.inviteMac(secret, device))
        fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(k.deviceId)
        banner = "Confirm on the other phone that it shows the same id."
    }

    fun revoke(target: String) = scope.launch {
        val k = key ?: return@launch
        try {
            val now = Instant.now()
            val message = Messages.revoke(target, k.deviceId, "revoked from a phone", Timestamps.string(now), Timestamps.string(now.plusSeconds(3600)), Messages.randomNonce())
            val signature = k.sign(activity!!, Jcs.bytes(message), "Revoke this device on every node")
            client?.revokeDevice(envelopeOf(message, k.deviceId, signature))
            refreshDevices()
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun registerPushToken(token: String) = scope.launch {
        storage.pushToken = token
        if (mode != AppMode.LIVE) return@launch
        try { client?.pushToken(token) } catch (e: Exception) { fail(e) }
    }

    /** A push carries only { kind, id }: fetch the envelope and verify it. */
    fun openPushed(requestId: String) = scope.launch {
        try { client?.approval(requestId)?.let { receive(it, storage.nodes) } } catch (e: Exception) { fail(e) }
    }

    fun reset() {
        pollJob?.cancel()
        DeviceKey.delete()
        key = null
        client = null
        demo = null
        pending.clear()
        storage.clear()
        changeMode(AppMode.WELCOME)
    }
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/QrScanner.kt`:

```kotlin
package com.example.kinglouie

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/** CameraX preview with ZXing decoding QR codes from the luminance plane. */
@Composable
fun QrScanner(modifier: Modifier = Modifier, onCode: (String) -> Unit) {
    val context = LocalContext.current
    AndroidView(modifier = modifier, factory = { ctx ->
        val view = PreviewView(ctx)
        val providerFuture = ProcessCameraProvider.getInstance(ctx)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            var delivered = false
            val reader = QRCodeReader()
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(ContextCompat.getMainExecutor(ctx)) { image ->
                try {
                    if (!delivered) {
                        val plane = image.planes[0]
                        val bytes = ByteArray(plane.buffer.remaining()).also { plane.buffer.get(it) }
                        val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                        val text = runCatching { reader.decode(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                        if (text != null) {
                            delivered = true
                            provider.unbindAll()
                            onCode(text)
                        }
                    }
                } finally {
                    image.close()
                }
            }
            provider.unbindAll()
            provider.bindToLifecycle(context as LifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(ctx))
        view
    })
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt`:

```kotlin
package com.example.kinglouie

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

@Composable
fun Root(model: AppModel) {
    MaterialTheme {
        model.banner?.let { text ->
            AlertDialog(onDismissRequest = { model.banner = null }, confirmButton = { TextButton({ model.banner = null }) { Text("OK") } }, text = { Text(text) })
        }
        if (model.mode == AppMode.WELCOME) Welcome(model) else Main(model)
    }
}

@Composable
fun ScanOrPaste(model: AppModel, onDone: () -> Unit) {
    var pasted by remember { mutableStateOf("") }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        QrScanner(Modifier.fillMaxWidth().height(320.dp)) { code -> onDone(); model.scanned(code) }
        OutlinedTextField(pasted, { pasted = it }, label = { Text("Or paste a kl1: code") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { onDone(); model.scanned(pasted) }, enabled = pasted.isNotBlank()) { Text("Use pasted code") }
    }
}

@Composable
fun Welcome(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("King Louie", style = MaterialTheme.typography.headlineLarge)
        Text("Approve what your machines want to do, with your fingerprint or face.")
        if (scanning) ScanOrPaste(model) { scanning = false } else {
            Button({ scanning = true }) { Text("Scan pairing code") }
            OutlinedButton({ model.startDemo() }) { Text("Try demo") }
        }
    }
}

@Composable
fun Main(model: AppModel) {
    var tab by remember { mutableStateOf(0) }
    val tabs = listOf("Pending", "History", "Nodes", "Devices", "Settings")
    Scaffold(bottomBar = {
        NavigationBar {
            tabs.forEachIndexed { i, label -> NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = {}, label = { Text(label) }) }
        }
    }) { padding ->
        Column(Modifier.padding(padding)) {
            if (model.mode == AppMode.DEMO) {
                Text("Demo — nothing here reaches a real machine", Modifier.fillMaxWidth().background(Color.Yellow).padding(6.dp), fontWeight = FontWeight.Bold)
            }
            model.fingerprintToCompare?.let { Text("This phone: $it — check the other screen shows the same.", Modifier.padding(6.dp), fontFamily = FontFamily.Monospace) }
            when (tab) {
                0 -> Pending(model)
                1 -> History(model)
                2 -> Nodes(model)
                3 -> Devices(model)
                else -> Settings(model)
            }
        }
    }
}

fun formatLeft(ms: Long): String = "%d:%02d".format(ms / 60000, (ms / 1000) % 60)

@Composable
fun ticker(): Long {
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now += 1 } }
    return now
}

@Composable
fun Pending(model: AppModel) {
    var open by remember { mutableStateOf<String?>(null) }
    ticker()
    val item = model.pending.firstOrNull { it.id == open }
    if (item != null) {
        Detail(model, item) { open = null }
        return
    }
    Column(Modifier.padding(12.dp)) {
        if (model.mode == AppMode.LIVE) Button({ model.checkNow() }) { Text("Check for requests") }
        if (model.pending.isEmpty()) Text("Nothing is waiting for you.", Modifier.padding(top = 12.dp))
        LazyColumn {
            items(model.pending, key = { it.id }) { p ->
                Column(Modifier.fillMaxWidth().clickable { open = p.id }.padding(vertical = 8.dp)) {
                    Text(p.display["node"]["name"].str() ?: "", fontWeight = FontWeight.Bold)
                    Text(p.display["summary"].str() ?: "", maxLines = 2)
                    Row { Text(p.display["origin"]["client"].str() ?: ""); Text("   " + (p.status ?: formatLeft(p.timeLeftMs))) }
                }
                HorizontalDivider()
            }
        }
    }
}

/** Every parameter, command-like values whole or head + tail, hidden characters as ‹U+XXXX›. */
@Composable
fun Detail(model: AppModel, item: PendingItem, onBack: () -> Unit) {
    ticker()
    var expanded by remember { mutableStateOf(setOf<String>()) }
    LazyColumn(Modifier.padding(12.dp)) {
        item {
            TextButton(onBack) { Text("Back") }
            Text(item.display["node"]["name"].str() ?: "", style = MaterialTheme.typography.titleLarge)
            Text(item.display["node"]["id"].str() ?: "", fontFamily = FontFamily.Monospace)
            Text(item.display["summary"].str() ?: "", Modifier.padding(vertical = 8.dp))
            Text("Kind: ${item.display["kind"].str()}   Name: ${item.display["name"].str()}")
            item.display["cwd"].str()?.let { Text("Directory: $it") }
            Text("Asked by: " + (item.display["origin"].obj()?.let { o -> listOf("client", "session", "job_id", "deviceId").mapNotNull { o[it].str() }.joinToString(" · ") } ?: ""))
            Text("Time left: ${formatLeft(item.timeLeftMs)}")
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
        }
        items(item.display["items"].arr().orEmpty()) { entry: JsonElement ->
            val path = entry["path"].str() ?: ""
            val hidden = entry["hidden"].int() ?: 0
            Column(Modifier.padding(vertical = 4.dp)) {
                Text(path, fontFamily = FontFamily.Monospace, color = Color.Gray)
                SelectionContainer {
                    if (hidden > 0 && path in expanded) Text(item.fullText[path] ?: "", fontFamily = FontFamily.Monospace)
                    else Text(entry["text"].str() ?: "", fontFamily = FontFamily.Monospace)
                }
                if (hidden > 0 && path !in expanded) {
                    TextButton({ expanded = expanded + path }) { Text("$hidden characters hidden — Show all") }
                    Text(entry["tail"].str() ?: "", fontFamily = FontFamily.Monospace)
                }
            }
        }
        item {
            val status = item.status
            if (status != null) Text("Status: $status", Modifier.padding(top = 12.dp))
            else Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 12.dp)) {
                Button({ model.decide(item, true) }, enabled = item.timeLeftMs > 0) { Text("Approve") }
                OutlinedButton({ model.decide(item, false) }, enabled = item.timeLeftMs > 0) { Text("Deny") }
            }
        }
    }
}

@Composable
fun History(model: AppModel) {
    Column(Modifier.padding(12.dp)) {
        model.nodes.forEach { n -> TextButton({ model.loadHistory(n.id) }) { Text(n.name) } }
        model.history?.let { (asOf, entries) ->
            Text("As of $asOf", fontWeight = FontWeight.Bold)
            LazyColumn {
                items(entries) { e ->
                    Text("#${e["seq"].int()} ${e["kind"].str()} · ${e["at"].str()} · ${e["writer"].str()}", Modifier.padding(vertical = 4.dp))
                }
            }
        }
    }
}

@Composable
fun Nodes(model: AppModel) {
    var name by remember { mutableStateOf("") }
    var code by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { if (model.mode == AppMode.LIVE) model.refreshNodes() }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        model.nodes.forEach { n ->
            Text("${n.name}  ${if (model.online[n.id] == true) "online" else "offline"}", fontWeight = FontWeight.Bold)
            Text(Identifiers.fingerprintGroups(n.id), fontFamily = FontFamily.Monospace)
        }
        Text("Pairing code for a new node", fontWeight = FontWeight.Bold)
        OutlinedTextField(name, { name = it }, label = { Text("Node name, e.g. gpu-box") })
        Button({ model.pairingCode(name) { code = it } }, enabled = name.isNotBlank() && model.mode == AppMode.LIVE) { Text("Get code") }
        code?.let { SelectionContainer { Text(it, fontFamily = FontFamily.Monospace) } }
    }
}

@Composable
fun QrImage(text: String) {
    val matrix = remember(text) { QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 600, 600) }
    val bitmap = remember(matrix) {
        Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565).also { b ->
            for (x in 0 until matrix.width) for (y in 0 until matrix.height) b.setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        }
    }
    Image(bitmap.asImageBitmap(), contentDescription = "Invite code", modifier = Modifier.fillMaxWidth().height(280.dp))
}

@Composable
fun Devices(model: AppModel) {
    LaunchedEffect(Unit) { if (model.mode == AppMode.LIVE) model.refreshDevices() }
    LazyColumn(Modifier.padding(12.dp)) {
        item { model.deviceId?.let { Text("This phone: d-" + Identifiers.fingerprintGroups(it), fontFamily = FontFamily.Monospace) } }
        items(model.devices) { d ->
            val id = d["device_id"].str() ?: ""
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${d["name"].str()} (${d["platform"].str()})")
                Text("d-" + Identifiers.fingerprintGroups(id), fontFamily = FontFamily.Monospace)
                d["nodes"].arr().orEmpty().forEach { n -> Text("${n["node_id"].str()}: ${n["state"].str()}") }
                if (id != model.deviceId) TextButton({ model.revoke(id) }) { Text("Revoke") }
            }
        }
        item {
            Button({ model.startInvite() }, enabled = model.mode == AppMode.LIVE) { Text("Add a device") }
            model.inviteQr?.let { QrImage(it); Text("Scan this with the new phone.") }
            model.inviteClaim?.let { device ->
                Text("New phone ${device["name"].str()}: d-${Identifiers.fingerprintGroups(device["device_id"].str() ?: "")}", fontFamily = FontFamily.Monospace)
                Button({ model.confirmInvited() }) { Text("It shows the same — add it") }
                TextButton({ model.inviteClaim = null }) { Text("Cancel") }
            }
        }
    }
}

@Composable
fun Settings(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Relay: ${model.relayUrl ?: "not paired"}")
        Text(model.relaySpki ?: "", fontFamily = FontFamily.Monospace)
        if (scanning) ScanOrPaste(model) { scanning = false } else OutlinedButton({ scanning = true }) { Text("Re-pin the relay (scan a relay code)") }
        if (model.mode == AppMode.DEMO) Button({ model.leaveDemo() }) { Text("Leave demo") }
        OutlinedButton({ model.reset() }) { Text("Reset this phone") }
        Text("No analytics. The relay sees every action you are asked to approve; see PRIVACY.md.")
    }
}
```

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/MainActivity.kt`:

```kotlin
package com.example.kinglouie

import android.Manifest
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.push.Push

class MainActivity : FragmentActivity() {
    private lateinit var model: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = (application as KingLouieApplication).model
        model.activity = this
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}
            .launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS))
        if (Push.ENABLED) Push.register(this) { token -> model.registerPushToken(token) }
        setContent { Root(model) }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        if (model.activity === this) model.activity = null
        super.onDestroy()
    }

    /** A tapped notification carries only the request id; the app fetches and verifies. */
    private fun handle(intent: Intent?) {
        intent?.getStringExtra(Push.EXTRA_REQUEST_ID)?.let { model.openPushed(it) }
    }
}
```

Create `mobile/android/app/src/nopush/kotlin/com/example/kinglouie/push/Push.kt`:

```kotlin
package com.example.kinglouie.push

import android.app.Activity

/** The `nopush` flavor: no push service at all; the owner checks from the app. */
object Push {
    const val ENABLED = false
    const val EXTRA_REQUEST_ID = "kl.rid"

    @Suppress("UNUSED_PARAMETER")
    fun register(activity: Activity, onToken: (String) -> Unit) = Unit
}
```

Create `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt`:

```kotlin
package com.example.kinglouie.push

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import com.example.kinglouie.KingLouieApplication
import com.example.kinglouie.MainActivity
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** The `fcm` flavor: FCM data messages { rid, n, k } become a generic local notification. */
object Push {
    const val ENABLED = true
    const val EXTRA_REQUEST_ID = "kl.rid"
    const val CHANNEL = "approvals"

    fun register(activity: Activity, onToken: (String) -> Unit) {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { onToken(it) }
    }
}

class KlMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as KingLouieApplication).model.registerPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val rid = message.data["rid"] ?: return
        val kind = message.data["k"] ?: "approval"
        if (kind != "approval") return
        val node = message.data["n"].orEmpty()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(Push.CHANNEL, "Approvals", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(
            this, rid.hashCode(),
            Intent(this, MainActivity::class.java).putExtra(Push.EXTRA_REQUEST_ID, rid).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = android.app.Notification.Builder(this, Push.CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("King Louie")
            .setContentText(if (node.isEmpty()) "Approval needed" else "Approval needed on $node")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(rid.hashCode(), notification)
    }
}
```

Create `mobile/android/app/src/fcm/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <service
            android:name=".push.KlMessagingService"
            android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
    </application>
</manifest>
```

- [ ] **Step 4: Build and check on a device**

Run: `cd mobile/android && ./gradlew :app:compileNopushDebugKotlin :app:compileFcmDebugKotlin :app:assembleNopushDebug`
Expected: `BUILD SUCCESSFUL` (the `fcm` flavor compiles without `google-services.json`; it needs one only to run).

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: `BUILD SUCCESSFUL`, 13 tests (unchanged).

Manual checks on an API 33+ phone with a strong biometric (spec §10), against a test relay and node from Part 3:

1. Try demo: the Demo banner, three requests, approve marks `approved (demo)`, no network traffic.
2. Console enrollment from `king-louie-service enroll-device`: the fingerprint prompt appears, the grouped id matches the console, `y` → "Enrolled."
3. "Check for requests" (one prompt) shows an unsafe `mcp` runbook within 25 s; head/tail + "Show all" for long commands; approve runs it once.
4. Enroll a new fingerprint → the next signature fails with "This phone's key is no longer usable…".
5. On a phone without StrongBox the key is still created (TEE fallback).
6. `fcm` flavor with your `google-services.json` and FCM credentials on the relay: a request raises "Approval needed on web-01"; tapping opens it.
7. A relay certificate with a new key → "Relay certificate changed — scan a new relay code".

- [ ] **Step 5: Commit**

```bash
git add mobile/android/settings.gradle.kts mobile/android/build.gradle.kts mobile/android/gradle.properties mobile/android/local.properties.example mobile/android/app
git commit -m "feat(android): approvals app — Keystore key with BiometricPrompt, pinned relay, fcm/nopush flavors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 28: Privacy statement, ignores, and final mobile verification

**Files:**
- Create: `mobile/PRIVACY.md`, `mobile/.gitignore`
- Modify: `CLAUDE.md` (the "Approvals and relay" section added in Part 3, Task 23: two lines at its end)

**Interfaces:**
- Consumes: Tasks 24–27.
- Produces: `mobile/PRIVACY.md` (what the apps keep, what the relay operator sees — spec §11.12 deviation — push content, demo, reset); ignores for machine-local configuration and build output.

- [ ] **Step 1: Write the failing check**

The check is that the files exist and that `mobile/.gitignore` keeps the machine-local `local.properties` out of git:

```bash
test -f mobile/PRIVACY.md && git check-ignore -q mobile/android/local.properties && echo ok
```

- [ ] **Step 2: Run it to verify it fails**

Run: `test -f mobile/PRIVACY.md && git check-ignore -q mobile/android/local.properties && echo ok || echo missing`
Expected: `missing`

- [ ] **Step 3: Implement**

Create `mobile/PRIVACY.md`:

```markdown
# King Louie approvals app — privacy

The King Louie app lets you approve or deny actions your own machines ask to
take. It is built from `docs/protocol/approval-v1.md` and talks only to the
relay you pair it with.

## What the app keeps on the phone

- The relay's address and the pin of its TLS key.
- For each paired node: its id, name and public key (the pins that decide
  which requests are shown).
- A reference to this phone's approval key. The key itself is created in the
  Secure Enclave (iOS) or the Android Keystore (StrongBox where available) and
  never leaves it; it signs only after a biometric check and stops working if
  the enrolled fingerprints or faces change.
- The push token, when push is configured.
- History you opened, as the node-signed slices the node sent.

Nothing else. There are no analytics, no crash reporters and no third-party
SDKs besides Firebase Messaging in the Android `fcm` build.

## What the relay operator can see

The relay passes messages between your phone and your nodes. Whoever runs it
can see:

- every action your nodes ask you to approve, **with all of its parameters**:
  commands, file paths, runbook steps, and values a tool was given (including
  secrets passed to the `Vault` tool). End-to-end encryption to the phone is
  not implemented yet (spec §11.12);
- your answers (signed; the relay cannot forge or change them), and the
  history slices you open;
- your devices' names, platforms and public keys, which nodes they approve
  for, and their push tokens;
- the network addresses your phone and nodes connect from.

The relay cannot approve anything: nodes check the phone's signature over the
exact action, and phones show only what a pinned node signed.

## Push

Push is optional. When configured, a push carries only a kind and a request id
(and the node's name in the alert text, such as "Approval needed on web-01");
the app fetches the request from the relay and verifies it before showing it.
Apple (APNs) or Google (FCM) deliver the push and see that it was sent. Without
push, the app checks the relay only while it is open.

## Demo mode

"Try demo" runs entirely on the phone with made-up machines and a software key.
It never contacts a relay. Leaving demo deletes the demo key.

## Reset

"Reset this phone" in Settings deletes the key and everything listed above.
Nodes keep trusting the key until it is revoked from another phone or with
`king-louie-service device revoke <device-id>` on each node.
```

Create `mobile/.gitignore`:

```text
# Machine-local configuration and build output of the mobile apps.
android/local.properties
android/.gradle/
android/.kotlin/
android/**/build/
android/app/src/fcm/google-services.json
ios/KingLouie.xcodeproj/
ios/KLProtocol/.build/
ios/KLProtocol/.swiftpm/
```

Append to the end of the "Approvals and relay" section of `CLAUDE.md`:

```markdown
- Mobile apps (`mobile/`, built from `docs/protocol/approval-v1.md`): protocol-core tests are
  `swift test` in `mobile/ios/KLProtocol` (macOS) and `../gradlew test` in `mobile/android/protocol`
  (JDK 17, no Android SDK); both read `tests/vectors/approval-v1`. `mobile/PRIVACY.md` says what the
  relay operator can see.
```

- [ ] **Step 4: Run the final verification**

Run: `test -f mobile/PRIVACY.md && git check-ignore -q mobile/android/local.properties && echo ok || echo missing`
Expected: `ok`

Run: `cd mobile/ios/KLProtocol && swift test` (macOS)
Expected: `Executed 13 tests, with 0 failures`

Run: `cd mobile/android/protocol && ../gradlew test`
Expected: `BUILD SUCCESSFUL`, 13 tests

Run: `node tests/vectors/approval-v1/generate.js --check && npm test`
Expected: `38 vectors match`, then `fail 0` — the node side is unchanged by this part.

Check the new files for personal values (program §3):

Run: `git diff main -- mobile | grep -nE '^\+.*(Users[\\/]|/home/|@[A-Za-z0-9-]+\.(com|net|org|io))' | grep -v 'example\.com'`
Expected: no output (identifiers are `com.example.kinglouie`, hosts `kl.example.com`).

- [ ] **Step 5: Commit**

```bash
git add mobile/PRIVACY.md mobile/.gitignore CLAUDE.md
git commit -m "docs(mobile): privacy statement and build ignores for the approvals apps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off: what Part 4 leaves behind

Stage 3 is done when this part finishes. Nothing in the Node code depends on `mobile/`, and the unit suite never builds it. The mobile side leaves these behind:

| Path | Exports / contract |
|---|---|
| `mobile/ios/KLProtocol` (SwiftPM library `KLProtocol`) | `JSONValue`, `JSONParser`, `JCS`, `Base64URL`, `Hex`, `Digest`, `Identifiers`, `Timestamps`, `Envelope`, `P1363`, `Messages`, `NodePin`, `PhoneView`, `Display`, `AuditSlice`, `AppMode`, `RelayClientFactory`, `DemoFleet`, `ProtocolError` |
| `mobile/ios` (XcodeGen `project.yml`, target `KingLouie`) | `DeviceKey`, `RelayAPI`, `AppModel`, SwiftUI screens; build settings `KL_BUNDLE_ID`, `KL_TEAM_ID`, `KL_APNS_TOPIC`, `KL_ENTITLEMENTS` in `Config/App.xcconfig` |
| `mobile/android/protocol` (standalone Gradle build, `com.example.kinglouie:protocol:1.0`) | `JsonText`, `Jcs`, `B64Url`, `Hex`, `Digest`, `Identifiers`, `Timestamps`, `Envelope`, `P256`, `P1363`, `Messages`, `NodePin`, `PhoneView`, `Display`, `AuditSlice`, `AppMode`, `RelayClientFactory`, `DemoFleet`, `ProtocolException` |
| `mobile/android/app` (flavors `fcm`, `nopush`) | `DeviceKey`, `PinningTrustManager`, `RelayApi`, `AppModel`, `KingLouieApplication`, `MainActivity`, Compose screens, `push.Push` per flavor, `push.KlMessagingService` (`fcm` only) |
| `mobile/PRIVACY.md` | what the apps store and what the relay operator can see |

A change to `docs/protocol/approval-v1.md` means regenerating `tests/vectors/approval-v1` (`node tests/vectors/approval-v1/generate.js`) and rerunning all three suites: `npm test`, `swift test` in `mobile/ios/KLProtocol`, and `../gradlew test` in `mobile/android/protocol`. F4 and later stages add relay routes through `src/frontdoor/extensions.js`. They leave the phone protocol unchanged unless they bump its version (`approval-v2`, with new vectors).
