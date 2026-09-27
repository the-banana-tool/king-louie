# Fleet Stage 5: Session helper — Implementation Plan (Part 6 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The header — Goal, Architecture, Owner questions, **Global Constraints**, **Review Focus**, Interfaces from other stages and **Deviations** — is in Part 1 (`2026-09-23-fleet-stage5-session-helper-part1.md`) and applies to every task here. Part 6 builds on Parts 1–5 (Tasks 1–21) on `feat/fleet-stage5`.

**This part:** the phone side of leases (spec §3.10). Task 22 `lease-v1` in the iOS protocol core; Task 23 the same in the Android protocol core; Task 24 the iOS app (lease requests, the live lease, the kill switch, the banner, push, demo); Task 25 the Android app (the same screens, fetch-on-tap per Owner question 1).

Deviation 29 (listed in Part 1; restated for this part): **History needs no new store.** The node's audit slice (F3's `/v1/nodes/{id}/history`, served from F4's mirror on a front door) already carries every `lease.*` and `gui.*` entry, so History shows leases with no app-side log; the apps only label those kinds "Computer use".

Swift and Kotlin run only where their toolchains are (macOS for Swift; any OS with a JDK 17 and Gradle for Kotlin). Steps name the command; on a machine without the toolchain the implementer runs the Node suite and leaves the mobile run to a machine that has it, saying so in the task report.

---

### Task 22: `lease-v1` in the iOS protocol core

**Files:**
- Create: `mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift`
- Modify: `mobile/ios/KLProtocol/Sources/KLProtocol/AppCore.swift` (`DemoFleet.leaseRequest(on:apps:minutes:)`, `DemoFleet.leaseView(...)`)
- Test: `mobile/ios/KLProtocol/Tests/KLProtocolTests/LeaseVectorTests.swift`

**Interfaces:**
- Consumes: `JSONValue`, `JSONParser`, `JCS`, `Envelope`, `Digest`, `Base64URL`, `NodePin`, `ProtocolError` (existing KLProtocol).
- Produces (Swift, `KLProtocol`):
  - `struct LeaseApp { id, name, path, processes }`.
  - `struct LeaseRequest: Identifiable { requestId, leaseId, nodeId, nodeName, jobId, apps, maxMinutes, reason, resumes, limits, originClient, leaseHash, nonce, createdAt, expiresAt; isResume; init?(message:) }` (nil unless a complete `kl.lease.request` whose `lease_hash` is the hash of its `lease`).
  - `struct LeaseStatus { leaseId, nodeId, seq, state, locked, reason, expiresAt; init?(message:) }`.
  - `struct LeaseAction: Identifiable { seq, at, tool, summary, result }`; `struct LeaseView { leaseId, nodeId, seq, state, locked, remainingS, foregroundAppId, foregroundMatches, frame: Data?, frameDropped, actions }`.
  - `enum Leases { viewMaxBytes; grant(to:apps:minutes:deviceId:signedAt:) throws -> JSONValue; deny(_:deviceId:signedAt:) -> JSONValue; revoke(nodeId:leaseId:reason:deviceId:nonce:signedAt:) -> JSONValue; watch(nodeId:leaseId:deviceId:nonce:signedAt:) -> JSONValue; verifyView(_:pin:) -> (accepted: Bool, reason: String?, view: LeaseView?); verifiedMessage(_:pin:) -> JSONValue? }`.

- [ ] **Step 1: Write the failing test**

Create `mobile/ios/KLProtocol/Tests/KLProtocolTests/LeaseVectorTests.swift`:

```swift
import XCTest
@testable import KLProtocol

/// Runs every lease-v1 vector whose consumers include "ios"
/// (tests/vectors/lease-v1, shared with the node and Android).
final class LeaseVectorTests: XCTestCase {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }()
    static let vectorsDir = root.appendingPathComponent("tests/vectors/lease-v1")

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("\(name).json")))
    }

    func allVectors() throws -> [JSONValue] {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.vectorsDir.path).filter { $0.hasSuffix(".json") }
        return try files.map { try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent($0))) }
    }

    func pin(_ v: JSONValue) -> NodePin {
        let n = v["given"]!["node"]!
        return NodePin(id: n["id"]!.stringValue!, name: n["name"]!.stringValue!, key: n["key"]!.stringValue!)
    }

    func request(_ v: JSONValue) throws -> LeaseRequest {
        let envelope = try Envelope(json: v["given"]!["request"]!)
        let message = try XCTUnwrap(Leases.verifiedMessage(envelope, pin: pin(v)), "the request verifies against the node pin")
        return try XCTUnwrap(LeaseRequest(message: message))
    }

    func assertBuilds(_ name: String, _ build: (JSONValue, JSONValue) throws -> JSONValue) throws {
        let v = try vector(name)
        let expect = v["expect"]!["message"]!
        let built = try build(v, expect)
        XCTAssertEqual(built, expect, name)
        XCTAssertEqual(JCS.data(built), try Envelope(json: v["input"]!).payloadData(), name)
    }

    func testEveryIosVectorIsCovered() throws {
        let names = Set(try allVectors().filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }.compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, ["grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "view-node-sig-valid", "view-tampered-frame"])
    }

    func testGrants() throws {
        for name in ["grant-valid", "grant-narrowed", "resume-capped"] {
            try assertBuilds(name) { v, expect in
                let req = try request(v)
                let apps = expect["grant"]!["apps"]!.arrayValue!.compactMap { $0.stringValue }
                return try Leases.grant(to: req, apps: apps, minutes: expect["grant"]!["minutes"]!.intValue!,
                                        deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
            }
        }
        let resume = try request(try vector("resume-capped"))
        XCTAssertTrue(resume.isResume)
    }

    func testDeny() throws {
        try assertBuilds("deny-valid") { v, expect in
            Leases.deny(try request(v), deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
        }
    }

    func testRevokeAndWatch() throws {
        try assertBuilds("revoke-valid") { _, e in
            Leases.revoke(nodeId: e["node_id"]!.stringValue!, leaseId: e["lease_id"]!.stringValue!, reason: e["reason"]!.stringValue!,
                          deviceId: e["device_id"]!.stringValue!, nonce: e["nonce"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
        }
        try assertBuilds("watch-valid") { _, e in
            Leases.watch(nodeId: e["node_id"]!.stringValue!, leaseId: e["lease_id"]!.stringValue!, deviceId: e["device_id"]!.stringValue!,
                         nonce: e["nonce"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
        }
    }

    func testViews() throws {
        for name in ["view-node-sig-valid", "view-tampered-frame"] {
            let v = try vector(name)
            let result = Leases.verifyView(try Envelope(json: v["input"]!), pin: pin(v))
            XCTAssertEqual(result.accepted, v["expect"]!["accepted"]!.boolValue!, name)
            XCTAssertEqual(result.reason, v["expect"]!["reason"]!.stringValue, name)
        }
        let ok = Leases.verifyView(try Envelope(json: try vector("view-node-sig-valid")["input"]!), pin: pin(try vector("view-node-sig-valid")))
        XCTAssertEqual(ok.view?.actions.first?.tool, "Type")
        XCTAssertNotNil(ok.view?.frame)
    }

    func testRefusesWhatTheNodeWouldRefuse() throws {
        let req = try request(try vector("grant-valid"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: [], minutes: 5, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: ["calculator"], minutes: req.maxMinutes + 1, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: ["terminal"], minutes: 5, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        // A request whose lease was changed after signing does not parse (lease_hash).
        guard case .object(var m) = try Leases.verifiedMessage(try Envelope(json: try vector("grant-valid")["given"]!["request"]!), pin: pin(try vector("grant-valid")))!,
              case .object(var lease) = m["lease"]! else { return XCTFail("fixture") }
        lease["max_minutes"] = .number("60")
        m["lease"] = .object(lease)
        XCTAssertNil(LeaseRequest(message: .object(m)))
    }

    func testDemoLeaseRequestParses() throws {
        let fleet = DemoFleet()
        let envelope = try fleet.leaseRequest(on: 0, apps: ["calculator"], minutes: 15)
        let message = try XCTUnwrap(Leases.verifiedMessage(envelope, pin: fleet.pins[0]))
        XCTAssertEqual(LeaseRequest(message: message)?.apps.first?.id, "calculator")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run (macOS, from `mobile/ios/KLProtocol`): `swift test --filter LeaseVectorTests`
Expected: FAIL to compile — `cannot find 'Leases' in scope`.

- [ ] **Step 3: Write `mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift`**

```swift
import Foundation

/// Fleet stage 5 (docs/protocol/lease-v1.md): computer-use leases. The node
/// signs requests, statuses and views; the phone signs grants, denies,
/// revokes and watches. Everything shown comes from a message whose node
/// signature verified against the node key pinned at enrollment.
public struct LeaseApp: Equatable, Identifiable {
    public let id: String
    public let name: String
    public let path: String
    public let processes: [String]
}

public struct LeaseRequest: Equatable, Identifiable {
    public static let messageType = "kl.lease.request"
    public var id: String { requestId }
    public let requestId: String
    public let leaseId: String
    public let nodeId: String
    public let nodeName: String
    public let jobId: String
    public let apps: [LeaseApp]
    public let maxMinutes: Int
    public let reason: String
    public let resumes: String?
    public let limits: [String]
    public let originClient: String
    public let leaseHash: String
    public let nonce: String
    public let createdAt: String
    public let expiresAt: String

    public var isResume: Bool { resumes != nil }

    /// nil unless `message` is a complete kl.lease.request whose lease_hash is the hash of its lease.
    public init?(message: JSONValue) {
        guard message["type"]?.stringValue == Self.messageType, message["v"]?.intValue == 1,
              let requestId = message["request_id"]?.stringValue, let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let nodeName = message["node_name"]?.stringValue,
              let lease = message["lease"], let leaseHash = message["lease_hash"]?.stringValue,
              let nonce = message["nonce"]?.stringValue, let createdAt = message["created_at"]?.stringValue,
              let expiresAt = message["expires_at"]?.stringValue,
              lease["kind"]?.stringValue == "computer_use", let jobId = lease["job_id"]?.stringValue,
              let maxMinutes = lease["max_minutes"]?.intValue, (1...60).contains(maxMinutes),
              let reason = lease["reason"]?.stringValue, let appList = lease["apps"]?.arrayValue, !appList.isEmpty,
              Digest.sha256B64url(JCS.data(lease)) == leaseHash else { return nil }
        var apps: [LeaseApp] = []
        for a in appList {
            guard let id = a["id"]?.stringValue, let name = a["name"]?.stringValue, let path = a["path"]?.stringValue,
                  let procs = a["processes"]?.arrayValue else { return nil }
            apps.append(LeaseApp(id: id, name: name, path: path, processes: procs.compactMap { $0.stringValue }))
        }
        self.requestId = requestId
        self.leaseId = leaseId
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.jobId = jobId
        self.apps = apps
        self.maxMinutes = maxMinutes
        self.reason = reason
        self.resumes = lease["resumes"]?.stringValue
        self.limits = (lease["limits"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.originClient = message["origin"]?["client"]?.stringValue ?? ""
        self.leaseHash = leaseHash
        self.nonce = nonce
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct LeaseStatus: Equatable {
    public static let messageType = "kl.lease.status"
    public let leaseId: String
    public let nodeId: String
    public let seq: Int
    public let state: String
    public let locked: Bool
    public let reason: String?
    public let expiresAt: String?

    public init?(message: JSONValue) {
        guard message["type"]?.stringValue == Self.messageType, let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let seq = message["seq"]?.intValue,
              let state = message["state"]?.stringValue, let locked = message["locked"]?.boolValue else { return nil }
        self.leaseId = leaseId
        self.nodeId = nodeId
        self.seq = seq
        self.state = state
        self.locked = locked
        self.reason = message["reason"]?.stringValue
        self.expiresAt = message["expires_at"]?.stringValue
    }
}

public struct LeaseAction: Equatable, Identifiable {
    public var id: Int { seq }
    public let seq: Int
    public let at: String
    public let tool: String
    public let summary: String
    public let result: String
}

public struct LeaseView: Equatable {
    public let leaseId: String
    public let nodeId: String
    public let seq: Int
    public let state: String
    public let locked: Bool
    public let remainingS: Int
    public let foregroundAppId: String?
    public let foregroundMatches: Bool
    public let frame: Data?
    public let frameDropped: Bool
    public let actions: [LeaseAction]
}

public enum Leases {
    /// A view larger than this is dropped unread (§4.1).
    public static let viewMaxBytes = 262144

    /// The request's own apps, in its order, kept only if the owner left them on.
    public static func grant(to request: LeaseRequest, apps: [String], minutes: Int, deviceId: String, signedAt: String) throws -> JSONValue {
        let chosen = Set(apps)
        guard !chosen.isEmpty, chosen.isSubset(of: Set(request.apps.map { $0.id })) else { throw ProtocolError.malformed("pick at least one of the requested apps") }
        guard (1...request.maxMinutes).contains(minutes) else { throw ProtocolError.malformed("minutes must be 1–\(request.maxMinutes)") }
        let ordered = request.apps.map { $0.id }.filter { chosen.contains($0) }
        return decision(request, decision: "grant",
                        grant: .object(["apps": .array(ordered.map { .string($0) }), "minutes": .number(String(minutes))]),
                        deviceId: deviceId, signedAt: signedAt)
    }

    public static func deny(_ request: LeaseRequest, deviceId: String, signedAt: String) -> JSONValue {
        decision(request, decision: "deny", grant: .null, deviceId: deviceId, signedAt: signedAt)
    }

    private static func decision(_ request: LeaseRequest, decision: String, grant: JSONValue, deviceId: String, signedAt: String) -> JSONValue {
        .object([
            "v": .number("1"),
            "type": .string("kl.lease.grant"),
            "request_id": .string(request.requestId),
            "lease_id": .string(request.leaseId),
            "node_id": .string(request.nodeId),
            "lease_hash": .string(request.leaseHash),
            "nonce": .string(request.nonce),
            "decision": .string(decision),
            "grant": grant,
            "expires_at": .string(request.expiresAt),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ])
    }

    public static func revoke(nodeId: String, leaseId: String, reason: String = "kill_switch", deviceId: String, nonce: String, signedAt: String) -> JSONValue {
        .object([
            "v": .number("1"), "type": .string("kl.lease.revoke"), "node_id": .string(nodeId), "lease_id": .string(leaseId),
            "reason": .string(reason), "device_id": .string(deviceId), "nonce": .string(nonce), "signed_at": .string(signedAt)
        ])
    }

    public static func watch(nodeId: String, leaseId: String, deviceId: String, nonce: String, signedAt: String) -> JSONValue {
        .object([
            "v": .number("1"), "type": .string("kl.lease.watch"), "node_id": .string(nodeId), "lease_id": .string(leaseId),
            "device_id": .string(deviceId), "nonce": .string(nonce), "signed_at": .string(signedAt)
        ])
    }

    /// A node-signed message (request, status or view) whose signature, kid
    /// and node_id are all the pinned node's; nil otherwise.
    public static func verifiedMessage(_ envelope: Envelope, pin: NodePin) -> JSONValue? {
        guard envelope.alg == "Ed25519", envelope.kid == pin.id, envelope.verifyEd25519(spkiHex: pin.key),
              let message = try? envelope.message(), message["node_id"]?.stringValue == pin.id else { return nil }
        return message
    }

    public static func verifyView(_ envelope: Envelope, pin: NodePin) -> (accepted: Bool, reason: String?, view: LeaseView?) {
        guard let bytes = try? envelope.payloadData() else { return (false, "malformed", nil) }
        guard bytes.count <= viewMaxBytes else { return (false, "too_large", nil) }
        guard envelope.alg == "Ed25519", envelope.kid == pin.id else { return (false, "malformed", nil) }
        guard envelope.verifyEd25519(spkiHex: pin.key) else { return (false, "bad_signature", nil) }
        guard let m = try? envelope.message(), m["type"]?.stringValue == "kl.lease.view" else { return (false, "malformed", nil) }
        guard m["node_id"]?.stringValue == pin.id else { return (false, "wrong_node", nil) }
        var frame: Data?
        if let f = m["frame"], !f.isNull {
            guard let data = f["data"]?.stringValue.flatMap({ Data(base64Encoded: $0) }), let hash = f["sha256"]?.stringValue else { return (false, "malformed", nil) }
            guard Digest.sha256B64url(data) == hash else { return (false, "frame_hash_mismatch", nil) }
            frame = data
        }
        guard let leaseId = m["lease_id"]?.stringValue, let seq = m["seq"]?.intValue, let state = m["state"]?.stringValue else { return (false, "malformed", nil) }
        let actions: [LeaseAction] = (m["actions"]?.arrayValue ?? []).compactMap { a in
            guard let s = a["seq"]?.intValue, let at = a["at"]?.stringValue, let tool = a["tool"]?.stringValue,
                  let summary = a["summary"]?.stringValue, let result = a["result"]?.stringValue else { return nil }
            return LeaseAction(seq: s, at: at, tool: tool, summary: summary, result: result)
        }
        let view = LeaseView(leaseId: leaseId, nodeId: pin.id, seq: seq, state: state, locked: m["locked"]?.boolValue ?? false,
                             remainingS: m["remaining_s"]?.intValue ?? 0, foregroundAppId: m["foreground"]?["app_id"]?.stringValue,
                             foregroundMatches: m["foreground"]?["matches"]?.boolValue ?? false, frame: frame,
                             frameDropped: m["frame_dropped"]?.boolValue ?? false, actions: actions)
        return (true, nil, view)
    }
}
```

- [ ] **Step 4: Demo requests and frames in `AppCore.swift`**

In `DemoFleet` (after `request(on:command:now:)`), add:

```swift
    /// A node-signed lease request, as a real node would send it (demo mode, §3.10).
    public func leaseRequest(on index: Int, apps: [String], minutes: Int, now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let lease: JSONValue = .object([
            "kind": .string("computer_use"),
            "job_id": .string("job-demo"),
            "apps": .array(apps.map { id in
                .object(["id": .string(id), "name": .string(id.capitalized), "path": .string("/Applications/\(id.capitalized).app"), "processes": .array([])])
            }),
            "max_minutes": .number(String(minutes)),
            "reason": .string("Enter the monthly totals"),
            "resumes": .null,
            "limits": .array([])
        ])
        let message: JSONValue = .object([
            "v": .number("1"),
            "type": .string("kl.lease.request"),
            "request_id": .string(UUID().uuidString.lowercased()),
            "lease_id": .string(UUID().uuidString.lowercased()),
            "node_id": .string(node.pin.id),
            "node_name": .string(node.pin.name),
            "lease": lease,
            "lease_hash": .string(Digest.sha256B64url(JCS.data(lease))),
            "origin": .object(["client": .string("demo"), "session": .null, "job_id": .string("job-demo")]),
            "created_at": .string(Timestamps.string(now)),
            "expires_at": .string(Timestamps.string(now.addingTimeInterval(300))),
            "nonce": .string(Messages.randomNonce())
        ])
        return try Envelope.seal(message, alg: "Ed25519", kid: node.pin.id) { try node.key.signature(for: $0) }
    }

    /// A node-signed view carrying a canned frame (the app draws it).
    public func leaseView(on index: Int, leaseId: String, seq: Int, toDevice: String, frame: Data, remaining: Int, actions: [LeaseAction], now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let message: JSONValue = .object([
            "v": .number("1"), "type": .string("kl.lease.view"), "node_id": .string(node.pin.id), "lease_id": .string(leaseId),
            "seq": .number(String(seq)), "at": .string(Timestamps.string(now)), "to_device": .string(toDevice),
            "state": .string("active"), "locked": .bool(false), "remaining_s": .number(String(remaining)),
            "foreground": .object(["app_id": .string("calculator"), "matches": .bool(true)]),
            "frame": .object(["mime": .string("image/jpeg"), "width": .number("960"), "height": .number("640"),
                              "sha256": .string(Digest.sha256B64url(frame)), "data": .string(frame.base64EncodedString())]),
            "frame_dropped": .bool(false),
            "actions": .array(actions.map { a in
                .object(["seq": .number(String(a.seq)), "at": .string(a.at), "tool": .string(a.tool), "summary": .string(a.summary), "result": .string(a.result)])
            })
        ])
        return try Envelope.seal(message, alg: "Ed25519", kid: node.pin.id) { try node.key.signature(for: $0) }
    }
```

- [ ] **Step 5: Run it to verify it passes**

Run (macOS, from `mobile/ios/KLProtocol`): `swift test`
Expected: every test passes, `ProtocolVectorTests`, `FrontDoorVectorTests` and `QuestionTests` included.

- [ ] **Step 6: Commit**

```bash
git add mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift mobile/ios/KLProtocol/Sources/KLProtocol/AppCore.swift mobile/ios/KLProtocol/Tests/KLProtocolTests/LeaseVectorTests.swift
git commit -m "feat(ios): lease-v1 in the protocol core, with the vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: `lease-v1` in the Android protocol core

**Files:**
- Create: `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt`
- Modify: `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/AppCore.kt` (`DemoFleet.leaseRequest`, `DemoFleet.leaseView`)
- Modify: `mobile/android/protocol/build.gradle.kts` (the `kl.leaseVectors` system property)
- Test: `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/LeaseVectorTest.kt`

**Interfaces:**
- Consumes: `JsonText`, `Jcs`, `Envelope`, `Digest`, `NodePin`, `ProtocolException`, the `str()/int()/bool()/arr()/get` helpers, `jsonString` (existing protocol module).
- Produces (Kotlin, package `com.example.kinglouie.protocol`): `LeaseApp`, `LeaseRequest` (`companion from(message): LeaseRequest?`), `LeaseStatus` (`from`), `LeaseAction`, `LeaseView`, `ViewCheck(accepted, reason, view)`, `object Leases { VIEW_MAX_BYTES; grant(request, apps, minutes, deviceId, signedAt): JsonObject; deny(...); revoke(...); watch(...); verifyView(envelope, pin): ViewCheck; verifiedMessage(envelope, pin): JsonObject? }` — the same names and rules as Task 22.

- [ ] **Step 1: Point the tests at the lease vectors**

In `mobile/android/protocol/build.gradle.kts`, after the `grantVectorsDir` value add:

```kotlin
val leaseVectorsDir: String = providers.systemProperty("kl.leaseVectors")
    .orElse(projectDir.resolve("../../../tests/vectors/lease-v1").canonicalPath)
    .get()
```

and inside `tasks.test { … }` add `inputs.dir(leaseVectorsDir)` and `systemProperty("kl.leaseVectors", leaseVectorsDir)` beside the two existing pairs.

- [ ] **Step 2: Write the failing test**

Create `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/LeaseVectorTest.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** Every lease-v1 vector whose consumers include "android" (shared with the node and iOS). */
class LeaseVectorTest {
    private val dir = File(System.getProperty("kl.leaseVectors") ?: error("run through Gradle: kl.leaseVectors is not set"))
    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())
    private fun allVectors(): List<JsonElement> = dir.listFiles { f -> f.name.endsWith(".json") }!!.map { JsonText.parse(it.readBytes()) }
    private fun s(v: JsonElement?, key: String): String = v[key].str()!!
    private fun pin(v: JsonElement): NodePin = v["given"]["node"].let { NodePin(s(it, "id"), s(it, "name"), s(it, "key")) }
    private fun request(v: JsonElement): LeaseRequest {
        val message = Leases.verifiedMessage(Envelope.fromJson(v["given"]["request"]!!), pin(v)) ?: error("the request verifies against the node pin")
        return LeaseRequest.from(message) ?: error("the request parses")
    }

    private fun assertBuilds(name: String, build: (JsonElement, JsonElement) -> JsonObject) {
        val v = vector(name)
        val expect = v["expect"]["message"]!!
        val built = build(v, expect)
        assertEquals(name, expect, built)
        assertArrayEquals(name, Envelope.fromJson(v["input"]!!).payloadBytes(), Jcs.bytes(built))
    }

    @Test
    fun everyAndroidVectorIsCovered() {
        val names = allVectors().filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }.map { it["name"].str() }.toSet()
        assertEquals(setOf("grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "view-node-sig-valid", "view-tampered-frame"), names)
    }

    @Test
    fun grants() {
        for (name in listOf("grant-valid", "grant-narrowed", "resume-capped")) {
            assertBuilds(name) { v, e ->
                Leases.grant(request(v), e["grant"]["apps"].arr()!!.map { it.str()!! }, e["grant"]["minutes"].int()!!, s(e, "device_id"), s(e, "signed_at"))
            }
        }
        assertTrue(request(vector("resume-capped")).isResume)
    }

    @Test
    fun deny() {
        assertBuilds("deny-valid") { v, e -> Leases.deny(request(v), s(e, "device_id"), s(e, "signed_at")) }
    }

    @Test
    fun revokeAndWatch() {
        assertBuilds("revoke-valid") { _, e -> Leases.revoke(s(e, "node_id"), s(e, "lease_id"), s(e, "reason"), s(e, "device_id"), s(e, "nonce"), s(e, "signed_at")) }
        assertBuilds("watch-valid") { _, e -> Leases.watch(s(e, "node_id"), s(e, "lease_id"), s(e, "device_id"), s(e, "nonce"), s(e, "signed_at")) }
    }

    @Test
    fun views() {
        for (name in listOf("view-node-sig-valid", "view-tampered-frame")) {
            val v = vector(name)
            val r = Leases.verifyView(Envelope.fromJson(v["input"]!!), pin(v))
            assertEquals(name, v["expect"]["accepted"].bool(), r.accepted)
            assertEquals(name, v["expect"]["reason"].str(), r.reason)
        }
        val ok = vector("view-node-sig-valid")
        val view = Leases.verifyView(Envelope.fromJson(ok["input"]!!), pin(ok)).view
        assertEquals("Type", view?.actions?.first()?.tool)
        assertNotNull(view?.frame)
    }

    @Test
    fun refusesWhatTheNodeWouldRefuse() {
        val req = request(vector("grant-valid"))
        for (bad in listOf<() -> Unit>(
            { Leases.grant(req, emptyList(), 5, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") },
            { Leases.grant(req, listOf("calculator"), req.maxMinutes + 1, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") },
            { Leases.grant(req, listOf("terminal"), 5, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") }
        )) {
            try { bad(); fail("expected a ProtocolException") } catch (e: ProtocolException) { }
        }
        val message = Leases.verifiedMessage(Envelope.fromJson(vector("grant-valid")["given"]["request"]!!), pin(vector("grant-valid")))!!
        val lease = message["lease"].obj()!!
        val changed = JsonObject(message + ("lease" to JsonObject(lease + ("max_minutes" to JsonPrimitive(60)))))
        assertNull(LeaseRequest.from(changed))
    }

    @Test
    fun demoLeaseRequestParses() {
        val fleet = DemoFleet()
        val envelope = fleet.leaseRequest(0, listOf("calculator"), 15)
        val message = Leases.verifiedMessage(envelope, fleet.pins[0])!!
        assertEquals("calculator", LeaseRequest.from(message)?.apps?.first()?.id)
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run (from `mobile/android/protocol`): `./gradlew test --tests '*LeaseVectorTest*'` (or `gradle test --tests '*LeaseVectorTest*'` where the wrapper is the parent's).
Expected: FAIL to compile — `Unresolved reference: Leases`.

- [ ] **Step 4: Write `Lease.kt`**

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * Fleet stage 5 (docs/protocol/lease-v1.md): computer-use leases. The node
 * signs requests, statuses and views; the phone signs grants, denies,
 * revokes and watches. Everything shown comes from a message whose node
 * signature verified against the pinned node key.
 */
data class LeaseApp(val id: String, val name: String, val path: String, val processes: List<String>)

data class LeaseRequest(
    val requestId: String, val leaseId: String, val nodeId: String, val nodeName: String, val jobId: String,
    val apps: List<LeaseApp>, val maxMinutes: Int, val reason: String, val resumes: String?, val limits: List<String>,
    val originClient: String, val leaseHash: String, val nonce: String, val createdAt: String, val expiresAt: String
) {
    val isResume: Boolean get() = resumes != null

    companion object {
        const val TYPE = "kl.lease.request"

        /** null unless [message] is a complete kl.lease.request whose lease_hash is the hash of its lease. */
        fun from(message: JsonElement): LeaseRequest? {
            if (message["type"].str() != TYPE || message["v"].int() != 1) return null
            val lease = message["lease"].obj() ?: return null
            val leaseHash = message["lease_hash"].str() ?: return null
            if (lease["kind"].str() != "computer_use") return null
            if (Digest.sha256B64url(Jcs.bytes(lease)) != leaseHash) return null
            val maxMinutes = lease["max_minutes"].int()?.takeIf { it in 1..60 } ?: return null
            val apps = (lease["apps"].arr() ?: return null).map { a ->
                LeaseApp(a["id"].str() ?: return null, a["name"].str() ?: return null, a["path"].str() ?: return null,
                    (a["processes"].arr() ?: return null).mapNotNull { it.str() })
            }
            if (apps.isEmpty()) return null
            return LeaseRequest(
                message["request_id"].str() ?: return null, message["lease_id"].str() ?: return null,
                message["node_id"].str() ?: return null, message["node_name"].str() ?: return null,
                lease["job_id"].str() ?: return null, apps, maxMinutes, lease["reason"].str() ?: return null,
                lease["resumes"].str(), (lease["limits"].arr() ?: JsonArray(emptyList())).mapNotNull { it.str() },
                message["origin"]["client"].str() ?: "", leaseHash, message["nonce"].str() ?: return null,
                message["created_at"].str() ?: return null, message["expires_at"].str() ?: return null
            )
        }
    }
}

data class LeaseStatus(val leaseId: String, val nodeId: String, val seq: Int, val state: String, val locked: Boolean, val reason: String?, val expiresAt: String?) {
    companion object {
        const val TYPE = "kl.lease.status"
        fun from(m: JsonElement): LeaseStatus? {
            if (m["type"].str() != TYPE) return null
            return LeaseStatus(
                m["lease_id"].str() ?: return null, m["node_id"].str() ?: return null, m["seq"].int() ?: return null,
                m["state"].str() ?: return null, m["locked"].bool() ?: return null, m["reason"].str(), m["expires_at"].str()
            )
        }
    }
}

data class LeaseAction(val seq: Int, val at: String, val tool: String, val summary: String, val result: String)

class LeaseView(
    val leaseId: String, val nodeId: String, val seq: Int, val state: String, val locked: Boolean, val remainingS: Int,
    val foregroundAppId: String?, val foregroundMatches: Boolean, val frame: ByteArray?, val frameDropped: Boolean, val actions: List<LeaseAction>
)

data class ViewCheck(val accepted: Boolean, val reason: String?, val view: LeaseView?)

object Leases {
    /** A view larger than this is dropped unread (§4.1). */
    const val VIEW_MAX_BYTES = 262144

    /** The request's own apps, in its order, kept only if the owner left them on. */
    fun grant(request: LeaseRequest, apps: List<String>, minutes: Int, deviceId: String, signedAt: String): JsonObject {
        val chosen = apps.toSet()
        if (chosen.isEmpty() || !request.apps.map { it.id }.containsAll(chosen)) throw ProtocolException("pick at least one of the requested apps")
        if (minutes !in 1..request.maxMinutes) throw ProtocolException("minutes must be 1–${request.maxMinutes}")
        val ordered = request.apps.map { it.id }.filter { it in chosen }
        val grant = JsonObject(mapOf("apps" to JsonArray(ordered.map { jsonString(it) }), "minutes" to JsonPrimitive(minutes)))
        return decision(request, "grant", grant, deviceId, signedAt)
    }

    fun deny(request: LeaseRequest, deviceId: String, signedAt: String): JsonObject = decision(request, "deny", JsonNull, deviceId, signedAt)

    private fun decision(r: LeaseRequest, decision: String, grant: JsonElement, deviceId: String, signedAt: String) = JsonObject(
        mapOf(
            "v" to JsonPrimitive(1), "type" to jsonString("kl.lease.grant"), "request_id" to jsonString(r.requestId),
            "lease_id" to jsonString(r.leaseId), "node_id" to jsonString(r.nodeId), "lease_hash" to jsonString(r.leaseHash),
            "nonce" to jsonString(r.nonce), "decision" to jsonString(decision), "grant" to grant,
            "expires_at" to jsonString(r.expiresAt), "device_id" to jsonString(deviceId), "signed_at" to jsonString(signedAt)
        )
    )

    fun revoke(nodeId: String, leaseId: String, reason: String = "kill_switch", deviceId: String, nonce: String, signedAt: String) = JsonObject(
        mapOf(
            "v" to JsonPrimitive(1), "type" to jsonString("kl.lease.revoke"), "node_id" to jsonString(nodeId), "lease_id" to jsonString(leaseId),
            "reason" to jsonString(reason), "device_id" to jsonString(deviceId), "nonce" to jsonString(nonce), "signed_at" to jsonString(signedAt)
        )
    )

    fun watch(nodeId: String, leaseId: String, deviceId: String, nonce: String, signedAt: String) = JsonObject(
        mapOf(
            "v" to JsonPrimitive(1), "type" to jsonString("kl.lease.watch"), "node_id" to jsonString(nodeId), "lease_id" to jsonString(leaseId),
            "device_id" to jsonString(deviceId), "nonce" to jsonString(nonce), "signed_at" to jsonString(signedAt)
        )
    )

    /** A node-signed message whose signature, kid and node_id are all the pinned node's; null otherwise. */
    fun verifiedMessage(envelope: Envelope, pin: NodePin): JsonObject? {
        if (envelope.alg != "Ed25519" || envelope.kid != pin.id || !envelope.verifyEd25519(pin.key)) return null
        val m = try { envelope.message() } catch (e: ProtocolException) { return null }
        return m.takeIf { it["node_id"].str() == pin.id }
    }

    fun verifyView(envelope: Envelope, pin: NodePin): ViewCheck {
        val bytes = try { envelope.payloadBytes() } catch (e: ProtocolException) { return ViewCheck(false, "malformed", null) }
        if (bytes.size > VIEW_MAX_BYTES) return ViewCheck(false, "too_large", null)
        if (envelope.alg != "Ed25519" || envelope.kid != pin.id) return ViewCheck(false, "malformed", null)
        if (!envelope.verifyEd25519(pin.key)) return ViewCheck(false, "bad_signature", null)
        val m = try { envelope.message() } catch (e: ProtocolException) { return ViewCheck(false, "malformed", null) }
        if (m["type"].str() != "kl.lease.view") return ViewCheck(false, "malformed", null)
        if (m["node_id"].str() != pin.id) return ViewCheck(false, "wrong_node", null)
        var frame: ByteArray? = null
        val f = m["frame"]
        if (f != null && f !is JsonNull) {
            val data = f["data"].str()?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return ViewCheck(false, "malformed", null)
            if (Digest.sha256B64url(data) != f["sha256"].str()) return ViewCheck(false, "frame_hash_mismatch", null)
            frame = data
        }
        val actions = (m["actions"].arr() ?: JsonArray(emptyList())).mapNotNull { a ->
            LeaseAction(a["seq"].int() ?: return@mapNotNull null, a["at"].str() ?: return@mapNotNull null, a["tool"].str() ?: return@mapNotNull null,
                a["summary"].str() ?: return@mapNotNull null, a["result"].str() ?: return@mapNotNull null)
        }
        val view = LeaseView(
            m["lease_id"].str() ?: return ViewCheck(false, "malformed", null), pin.id, m["seq"].int() ?: return ViewCheck(false, "malformed", null),
            m["state"].str() ?: return ViewCheck(false, "malformed", null), m["locked"].bool() ?: false, m["remaining_s"].int() ?: 0,
            m["foreground"]["app_id"].str(), m["foreground"]["matches"].bool() ?: false, frame, m["frame_dropped"].bool() ?: false, actions
        )
        return ViewCheck(true, null, view)
    }
}
```

- [ ] **Step 5: Demo requests and frames in `AppCore.kt`**

In `class DemoFleet`, after `request(...)`, add:

```kotlin
    /** A node-signed lease request, as a real node would send it (demo mode, §3.10). */
    fun leaseRequest(index: Int, apps: List<String>, minutes: Int, now: Instant = Instant.now()): Envelope {
        val node = nodes[index]
        val lease = JsonObject(
            mapOf(
                "kind" to jsonString("computer_use"), "job_id" to jsonString("job-demo"),
                "apps" to JsonArray(apps.map { id ->
                    JsonObject(mapOf("id" to jsonString(id), "name" to jsonString(id.replaceFirstChar { it.uppercase() }),
                        "path" to jsonString("C:\\Program Files\\${id.replaceFirstChar { it.uppercase() }}\\$id.exe"), "processes" to JsonArray(emptyList())))
                }),
                "max_minutes" to jsonNumber(minutes.toString()), "reason" to jsonString("Enter the monthly totals"),
                "resumes" to JsonNull, "limits" to JsonArray(emptyList())
            )
        )
        val message = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "type" to jsonString("kl.lease.request"),
                "request_id" to jsonString(UUID.randomUUID().toString()), "lease_id" to jsonString(UUID.randomUUID().toString()),
                "node_id" to jsonString(node.pin.id), "node_name" to jsonString(node.pin.name), "lease" to lease,
                "lease_hash" to jsonString(Digest.sha256B64url(Jcs.bytes(lease))),
                "origin" to JsonObject(mapOf("client" to jsonString("demo"), "session" to JsonNull, "job_id" to jsonString("job-demo"))),
                "created_at" to jsonString(Timestamps.string(now)), "expires_at" to jsonString(Timestamps.string(now.plusSeconds(300))),
                "nonce" to jsonString(Messages.randomNonce())
            )
        )
        return Envelope.seal(message, node.pin.id, "Ed25519") { bytes -> Signature.getInstance("Ed25519").run { initSign(node.keys.private); update(bytes); sign() } }
    }

    /** A node-signed view carrying a canned frame (the app draws it). */
    fun leaseView(index: Int, leaseId: String, seq: Int, toDevice: String, frame: ByteArray, remaining: Int, actions: List<LeaseAction>, now: Instant = Instant.now()): Envelope {
        val node = nodes[index]
        val message = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "type" to jsonString("kl.lease.view"), "node_id" to jsonString(node.pin.id), "lease_id" to jsonString(leaseId),
                "seq" to jsonNumber(seq.toString()), "at" to jsonString(Timestamps.string(now)), "to_device" to jsonString(toDevice),
                "state" to jsonString("active"), "locked" to kotlinx.serialization.json.JsonPrimitive(false), "remaining_s" to jsonNumber(remaining.toString()),
                "foreground" to JsonObject(mapOf("app_id" to jsonString("calculator"), "matches" to kotlinx.serialization.json.JsonPrimitive(true))),
                "frame" to JsonObject(mapOf("mime" to jsonString("image/jpeg"), "width" to jsonNumber("960"), "height" to jsonNumber("640"),
                    "sha256" to jsonString(Digest.sha256B64url(frame)), "data" to jsonString(java.util.Base64.getEncoder().encodeToString(frame)))),
                "frame_dropped" to kotlinx.serialization.json.JsonPrimitive(false),
                "actions" to JsonArray(actions.map { a ->
                    JsonObject(mapOf("seq" to jsonNumber(a.seq.toString()), "at" to jsonString(a.at), "tool" to jsonString(a.tool),
                        "summary" to jsonString(a.summary), "result" to jsonString(a.result)))
                })
            )
        )
        return Envelope.seal(message, node.pin.id, "Ed25519") { bytes -> Signature.getInstance("Ed25519").run { initSign(node.keys.private); update(bytes); sign() } }
    }
```

Add `import kotlinx.serialization.json.JsonArray` to `AppCore.kt` if it is not there yet (the other imports it uses — `JsonObject`, `JsonNull`, `UUID`, `Signature`, `Instant` — already are).

- [ ] **Step 6: Run it to verify it passes**

Run (from `mobile/android/protocol`): `./gradlew test`
Expected: every test passes, `ProtocolVectorTest`, `FrontDoorVectorTest` and `QuestionTest` included.

- [ ] **Step 7: Commit**

```bash
git add mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/AppCore.kt mobile/android/protocol/build.gradle.kts mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/LeaseVectorTest.kt
git commit -m "feat(android): lease-v1 in the protocol core, with the vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: The iOS app — lease requests, the live lease and the kill switch

**Files:**
- Modify: `mobile/ios/App/RelayAPI.swift` (lease calls, after `answerQuestion`)
- Modify: `mobile/ios/App/DeviceKey.swift` (`signWatchEnvelope`, Deviation 21)
- Modify: `mobile/ios/App/AppModel.swift` (a `// MARK: Leases (fleet stage 5)` section; `openPushed` kind `lease`; `reset`; demo)
- Create: `mobile/ios/App/LeaseViews.swift`
- Modify: `mobile/ios/App/Views.swift` (`MainView` banner; `PendingListView` "Computer use" section; `HistoryView` label)
- Modify: `mobile/ios/App/KingLouieApp.swift` (push kind `lease`)

**Interfaces:**
- Consumes: Task 22's `LeaseRequest`, `LeaseStatus`, `LeaseView`, `Leases`; the relay routes of Task 11 (`GET /v1/leases`, `POST /v1/leases/{id}/grant|revoke|watch`, `GET /v1/leases/{id}/views`).
- Produces (app-internal): `AppModel.leaseRequests: [LeaseRequestItem]`, `AppModel.liveLease: LiveLease?`, `refreshLeases(onlyIfUnlocked:)`, `decideLease(_:apps:minutes:grant:)`, `openLiveLease(nodeId:leaseId:)`, `closeLiveLease()`, `killSwitch()`; views `LeaseRequestView`, `LiveLeaseView`, `LeaseBanner`, `LeaseRequestsSection`.

- [ ] **Step 1: `RelayAPI` — the lease calls**

After `answerQuestion(_:envelope:)`:

```swift
    // Fleet stage 5 (§4.7): lease requests with their latest status, the
    // phone's decisions, and the live view.
    func leases(wait: Int = 0, signWith: Signer? = nil) async throws -> [JSONValue] {
        try await request("GET", "/v1/leases?wait=\(wait)", signWith: signWith).1?.arrayValue ?? []
    }

    /// `202 { state, reason? }` from the node, passed through by the relay.
    func leaseDecision(_ action: String, leaseId: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/leases/\(Self.segment(leaseId))/\(action)", body: envelope.json).1
    }

    func leaseViews(_ leaseId: String, afterSeq: Int, wait: Int, signWith: Signer? = nil) async throws -> [JSONValue] {
        try await request("GET", "/v1/leases/\(Self.segment(leaseId))/views?after_seq=\(afterSeq)&wait=\(wait)", signWith: signWith).1?.arrayValue ?? []
    }
```

- [ ] **Step 2: `DeviceKey` — the watch signature (Deviation 21)**

After `signRefusalEnvelope`:

```swift
    /// A kl.lease.watch signed with the session's unlock: a watch grants
    /// nothing (it asks for frames of a lease the owner already granted), so
    /// it does not need a fresh Face ID every 20 s. Anything else is refused.
    func signWatchEnvelope(_ message: JSONValue) async throws -> Envelope {
        guard message["type"]?.stringValue == "kl.lease.watch" else {
            throw ProtocolError.malformed("Only a lease watch is signed with the session.")
        }
        let bytes = JCS.data(message)
        let signature = try await signForSession(bytes)
        return Envelope(alg: "ES256", kid: deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
    }
```

- [ ] **Step 3: `AppModel` — the leases section**

Add, after the Questions section:

```swift
    // MARK: Leases (fleet stage 5)

    struct LeaseRequestItem: Identifiable, Equatable {
        var id: String { request.requestId }
        let request: LeaseRequest
        let nodeName: String
        var status: LeaseStatus?
    }

    struct LiveLease: Equatable {
        let nodeId: String
        let nodeName: String
        let leaseId: String
        var state: String = "pending"
        var locked = false
        var reason: String?
        var expiresAt: Date?
        var frame: Data?
        var frameAt: Date?
        var frameDropped = false
        var actions: [LeaseAction] = []
        var lastSeq = 0
        var revoking = false
    }

    @Published var leaseRequests: [LeaseRequestItem] = []
    @Published var liveLease: LiveLease?
    @Published private(set) var decidingLease: Set<String> = []
    private var decidedLeaseRequests = Set<String>()
    private var liveTask: Task<Void, Never>?
    private var demoLeaseTimer: Task<Void, Never>?

    /// Pending lease requests: node-signed by a pinned node, the lease hash
    /// intact, not expired, and not already ended by a status.
    func refreshLeases(onlyIfUnlocked: Bool = false) async {
        guard mode == .live, !pairing, let client, let key else { return }
        if onlyIfUnlocked, !key.isSessionUnlocked { return }
        do {
            var items: [LeaseRequestItem] = []
            for entry in try await client.leases(signWith: onlyIfUnlocked ? Self.sessionOnlySigner(key) : nil) {
                guard let json = entry["envelope"], let envelope = try? Envelope(json: json),
                      let pin = state.nodes.first(where: { $0.id == envelope.kid }),
                      let message = Leases.verifiedMessage(envelope, pin: pin), let request = LeaseRequest(message: message),
                      !decidedLeaseRequests.contains(request.requestId),
                      let expires = Timestamps.date(request.expiresAt), expires > client.now() else { continue }
                if let listed = entry["node_id"]?.stringValue, listed != pin.id { continue }
                let status = entry["status"].flatMap { try? Envelope(json: $0) }.flatMap { Leases.verifiedMessage($0, pin: pin) }.flatMap { LeaseStatus(message: $0) }
                if status?.state == "ended" { continue }
                if !items.contains(where: { $0.id == request.requestId }) { items.append(LeaseRequestItem(request: request, nodeName: pin.name, status: status)) }
            }
            leaseRequests = items
        } catch is SessionLocked {
            // The session lapsed: quiet; the owner can pull to refresh.
        } catch {
            fail(error)
        }
    }

    /// Grant (a fresh Face ID over exactly these apps and minutes) or deny.
    func decideLease(_ item: LeaseRequestItem, apps: Set<String>, minutes: Int, grant: Bool) async {
        if mode == .demo { demoDecide(item, grant: grant); return }
        guard mode == .live, let key, let client, !decidingLease.contains(item.id) else { return }
        decidingLease.insert(item.id)
        defer { decidingLease.remove(item.id) }
        do {
            let signedAt = Timestamps.string(client.now())
            let envelope: Envelope
            if grant {
                let message = try Leases.grant(to: item.request, apps: Array(apps), minutes: minutes, deviceId: key.deviceId, signedAt: signedAt)
                let names = item.request.apps.filter { apps.contains($0.id) }.map { Self.promptText($0.name, 30) }.joined(separator: ", ")
                envelope = try await key.signEnvelope(message, reason: "Allow computer use of \(names) on \(Self.promptText(item.nodeName, 30)) for \(minutes) min")
            } else {
                envelope = try await key.signEnvelope(Leases.deny(item.request, deviceId: key.deviceId, signedAt: signedAt), reason: "Deny computer use on \(Self.promptText(item.nodeName, 30))")
            }
            let result = try await client.leaseDecision("grant", leaseId: item.request.leaseId, envelope: envelope)
            let state = result?["state"]?.stringValue
            if state == "rejected" {
                banner = "Node rejected: \(friendlyReason(result?["reason"]?.stringValue))"
                return
            }
            decidedLeaseRequests.insert(item.id)
            leaseRequests.removeAll { $0.id == item.id }
            if grant, state == "active" { openLiveLease(nodeId: item.request.nodeId, leaseId: item.request.leaseId) }
        } catch {
            fail(error)
        }
    }

    /// The live screen: a watch every 20 s (signed with the session, never a
    /// fresh prompt) and a long poll for views and statuses, until it closes
    /// or the lease ends.
    func openLiveLease(nodeId: String, leaseId: String) {
        guard let pin = state.nodes.first(where: { $0.id == nodeId }) else { return }
        liveTask?.cancel()
        liveLease = LiveLease(nodeId: nodeId, nodeName: pin.name, leaseId: leaseId)
        if mode == .demo { startDemoFrames(); return }
        guard let client, let key else { return }
        liveTask = Task { [weak self] in
            var lastWatch = Date.distantPast
            while !Task.isCancelled {
                guard let self, var live = self.liveLease, live.leaseId == leaseId else { return }
                if Date().timeIntervalSince(lastWatch) >= 20, live.state != "ended" {
                    lastWatch = Date()
                    let watch = Leases.watch(nodeId: nodeId, leaseId: leaseId, deviceId: key.deviceId, nonce: Messages.randomNonce(), signedAt: Timestamps.string(client.now()))
                    if let envelope = try? await key.signWatchEnvelope(watch) { _ = try? await client.leaseDecision("watch", leaseId: leaseId, envelope: envelope) }
                }
                do {
                    for entry in try await client.leaseViews(leaseId, afterSeq: live.lastSeq, wait: 20) {
                        live.lastSeq = max(live.lastSeq, entry["seq"]?.intValue ?? live.lastSeq)
                        guard let json = entry["envelope"], let envelope = try? Envelope(json: json) else { continue }
                        self.apply(envelope, pin: pin, to: &live)
                    }
                    self.liveLease = live
                    if live.state == "ended" && !live.revoking { return }
                } catch {
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }

    private func apply(_ envelope: Envelope, pin: NodePin, to live: inout LiveLease) {
        if let message = Leases.verifiedMessage(envelope, pin: pin), let status = LeaseStatus(message: message), status.leaseId == live.leaseId {
            live.state = status.state
            live.locked = status.locked
            live.reason = status.reason
            live.expiresAt = status.expiresAt.flatMap { Timestamps.date($0) }
            if status.state == "ended" { live.revoking = false }
            return
        }
        let check = Leases.verifyView(envelope, pin: pin)
        guard check.accepted, let view = check.view, view.leaseId == live.leaseId else { return }
        live.state = view.state
        live.locked = view.locked
        live.expiresAt = Date().addingTimeInterval(TimeInterval(view.remainingS))
        live.frameDropped = view.frameDropped
        if let frame = view.frame { live.frame = frame; live.frameAt = Date() }
        live.actions = Array((view.actions.reversed() + live.actions).prefix(200))
    }

    func closeLiveLease() {
        liveTask?.cancel()
        demoLeaseTimer?.cancel()
        liveLease = nil
    }

    /// One Face ID, then a signed revoke, re-sent every 3 s until the node says ended.
    func killSwitch() async {
        guard var live = liveLease, !live.revoking else { return }
        if mode == .demo { live.state = "ended"; live.reason = "revoked"; liveLease = live; demoLeaseTimer?.cancel(); return }
        guard let key, let client else { return }
        do {
            let message = Leases.revoke(nodeId: live.nodeId, leaseId: live.leaseId, deviceId: key.deviceId, nonce: Messages.randomNonce(), signedAt: Timestamps.string(client.now()))
            let envelope = try await key.signEnvelope(message, reason: "Stop computer use on \(Self.promptText(live.nodeName, 30)) now")
            live.revoking = true
            liveLease = live
            Task { [weak self] in
                while let self, let current = self.liveLease, current.leaseId == live.leaseId, current.state != "ended" {
                    _ = try? await client.leaseDecision("revoke", leaseId: live.leaseId, envelope: envelope)
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        } catch {
            fail(error)
        }
    }

    // Demo: a fake lease with canned frames (store review).
    private func demoDecide(_ item: LeaseRequestItem, grant: Bool) {
        leaseRequests.removeAll { $0.id == item.id }
        if grant { openLiveLease(nodeId: item.request.nodeId, leaseId: item.request.leaseId) }
    }

    private func startDemoFrames() {
        demoLeaseTimer?.cancel()
        demoLeaseTimer = Task { [weak self] in
            var seq = 1
            while !Task.isCancelled {
                guard let self, let demo = self.demo, var live = self.liveLease, live.state != "ended" else { return }
                let frame = Self.demoFrame(seq)
                let action = LeaseAction(seq: seq, at: Timestamps.string(Date()), tool: seq % 2 == 0 ? "Type" : "Click", summary: seq % 2 == 0 ? "Type \"12+30=\" (6 chars)" : "Click left at (120, 88) on ss-\(seq)", result: "ok")
                if let index = demo.pins.firstIndex(where: { $0.id == live.nodeId }),
                   let envelope = try? demo.leaseView(on: index, leaseId: live.leaseId, seq: seq, toDevice: demo.deviceId, frame: frame, remaining: max(0, 900 - seq * 3), actions: [action]) {
                    self.apply(envelope, pin: demo.pins[index], to: &live)
                    self.liveLease = live
                }
                seq += 1
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private static func demoFrame(_ seq: Int) -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 480, height: 320))
        let image = renderer.image { ctx in
            UIColor.systemGray6.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 480, height: 320))
            ("Demo frame \(seq)" as NSString).draw(at: CGPoint(x: 24, y: 140), withAttributes: [.font: UIFont.systemFont(ofSize: 28)])
        }
        return image.jpegData(compressionQuality: 0.6) ?? Data()
    }
```

In `startDemo()`, after the approval requests, add a demo lease request:

```swift
        if let env = try? fleet.leaseRequest(on: 0, apps: ["calculator", "textedit"], minutes: 15),
           let message = Leases.verifiedMessage(env, pin: fleet.pins[0]), let request = LeaseRequest(message: message) {
            leaseRequests = [LeaseRequestItem(request: request, nodeName: fleet.pins[0].name, status: nil)]
        }
```

In `openPushed(kind:id:)`, add `case "lease": await refreshLeases()` before `default`. In `reset()` and `leaveDemo()`, add `closeLiveLease(); leaseRequests = []; decidedLeaseRequests = []`.

`Self.sessionOnlySigner`, `SessionLocked`, `promptText`, `friendlyReason` and `fail` are the existing Questions/approval helpers in the same file. `AppModel.swift` must `import UIKit` for the demo frame (add it beside `import SwiftUI` if absent).

- [ ] **Step 4: `LeaseViews.swift`**

```swift
import KLProtocol
import SwiftUI

/// Fleet stage 5 §3.10: a lease request (exactly what the node signed, the
/// agent's reason labelled unverified), and the live lease with the kill switch.
struct LeaseRequestsSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if !model.leaseRequests.isEmpty {
            Section("Computer use") {
                ForEach(model.leaseRequests) { item in
                    NavigationLink { LeaseRequestView(item: item) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Display.escape(item.nodeName)).font(.headline)
                            Text(item.request.isResume ? "Resume computer use" : "Computer use: \(item.request.apps.map { Display.escape($0.name) }.joined(separator: ", "))")
                            Text("Job \(Display.escape(item.request.jobId)) · \(Display.escape(item.request.originClient))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}

struct LeaseRequestView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let item: AppModel.LeaseRequestItem
    @State private var chosen: Set<String> = []
    @State private var minutes = 1

    private static let limitText = ["no_lock_detect": "This computer cannot detect a locked screen.",
                                    "no_human_yield": "This computer cannot detect your own typing, so it will not pause for you."]

    var body: some View {
        Form {
            Section("Node") {
                Text(Display.escape(item.nodeName)).font(.headline)
                LabeledContent("Job", value: Display.escape(item.request.jobId))
                LabeledContent("Asked by", value: Display.escape(item.request.originClient))
            }
            Section("Agent's reason (unverified)") { Text(Display.escape(item.request.reason)) }
            Section("Apps it may control") {
                ForEach(item.request.apps) { app in
                    Toggle(isOn: Binding(get: { chosen.contains(app.id) }, set: { on in if on { chosen.insert(app.id) } else { chosen.remove(app.id) } })) {
                        VStack(alignment: .leading) {
                            Text(Display.escape(app.name))
                            Text(Display.escape(app.path)).font(.caption.monospaced())
                            if !app.processes.isEmpty { Text(app.processes.map { Display.escape($0) }.joined(separator: ", ")).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                        }
                    }
                    .disabled(item.request.isResume)
                }
            }
            Section("For how long") {
                if item.request.isResume {
                    Text("The \(item.request.maxMinutes) min that were left; a resume never extends the lease.")
                } else {
                    Stepper("\(minutes) min", value: $minutes, in: 1...item.request.maxMinutes)
                }
            }
            if !item.request.limits.isEmpty {
                Section("Warnings") { ForEach(item.request.limits, id: \.self) { Text(Self.limitText[$0] ?? Display.escape($0)).foregroundStyle(.orange) } }
            }
            Section {
                Button("Allow") {
                    Task { await model.decideLease(item, apps: chosen, minutes: minutes, grant: true); dismiss() }
                }
                .disabled(chosen.isEmpty || model.decidingLease.contains(item.id))
                Button("Deny", role: .destructive) {
                    Task { await model.decideLease(item, apps: [], minutes: 1, grant: false); dismiss() }
                }
                .disabled(model.decidingLease.contains(item.id))
            }
        }
        .navigationTitle("Computer use")
        .onAppear {
            chosen = Set(item.request.apps.map { $0.id })
            minutes = item.request.maxMinutes
        }
    }
}

struct LiveLeaseView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let live = model.liveLease {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(live.locked ? "locked" : live.state).padding(6).background(chipColor(live).opacity(0.2)).clipShape(Capsule())
                            Spacer()
                            if let expires = live.expiresAt, live.state != "ended" {
                                Text(formatLeft(.seconds(max(0, Int(expires.timeIntervalSince(context.date)))))).monospacedDigit()
                            }
                        }
                        if let frame = live.frame, let image = UIImage(data: frame) {
                            Image(uiImage: image).resizable().scaledToFit()
                        } else {
                            Text("No frame yet").foregroundStyle(.secondary)
                        }
                        if live.frameDropped { Text("Frame dropped (too large)").font(.caption).foregroundStyle(.orange) }
                        if let at = live.frameAt, context.date.timeIntervalSince(at) > 10, live.state == "active" {
                            Text("No frame for more than 10 s").font(.caption).foregroundStyle(.orange)
                        }
                        if let reason = live.reason, live.state != "active" { Text("Reason: \(Display.escape(reason))").font(.caption) }
                        Button(role: .destructive) { Task { await model.killSwitch() } } label: {
                            Text(live.revoking ? "Revoking…" : "Stop now").frame(maxWidth: .infinity).padding()
                        }
                        .buttonStyle(.borderedProminent).tint(.red)
                        .disabled(live.revoking || live.state == "ended")
                        Text("Actions").font(.headline)
                        ForEach(live.actions) { a in
                            VStack(alignment: .leading) {
                                Text(Display.escape(a.summary))
                                Text("\(Display.escape(a.result)) · \(Display.escape(a.at))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding()
                }
                .navigationTitle(Display.escape(live.nodeName))
            }
        }
        .onDisappear { model.closeLiveLease() }
    }

    private func chipColor(_ live: AppModel.LiveLease) -> Color {
        if live.locked { return .gray }
        switch live.state {
        case "active": return .green
        case "suspended": return .orange
        case "ended": return .red
        default: return .blue
        }
    }
}

/// "Lease active on <node>" with the kill switch, on every tab.
struct LeaseBanner: View {
    @EnvironmentObject var model: AppModel
    @State private var showing = false

    var body: some View {
        if let live = model.liveLease, live.state != "ended" {
            HStack {
                Button("Lease active on \(Display.escape(live.nodeName))") { showing = true }
                Spacer()
                Button("Stop", role: .destructive) { Task { await model.killSwitch() } }.buttonStyle(.borderedProminent).tint(.red)
            }
            .padding(8).background(Color.red.opacity(0.1))
            .sheet(isPresented: $showing) { NavigationStack { LiveLeaseView() } }
        }
    }
}
```

`formatLeft` is the existing helper in `Views.swift`.

- [ ] **Step 5: Wire the screens, the push kind and the history label**

- `Views.swift`, `MainView`: add `LeaseBanner()` right below the demo banner `Text(…)` block.
- `Views.swift`, `PendingListView`: add `LeaseRequestsSection()` as the first child of the `List`, and `.task { await model.refreshLeases(onlyIfUnlocked: true) }` plus, in the existing refresh action, `await model.refreshLeases()`.
- `Views.swift`, `HistoryView`: replace `Text(Display.escape(entry["kind"]?.stringValue ?? "")).font(.headline)` with

```swift
                                let kind = entry["kind"]?.stringValue ?? ""
                                Text(kind.hasPrefix("lease.") || kind.hasPrefix("gui.") ? "Computer use · \(Display.escape(kind))" : Display.escape(kind)).font(.headline)
```

- `KingLouieApp.swift`: `guard ["approval", "pairing", "alert", "question", "lease"].contains(kind) else { return }` and update the doc comment to name lease pushes.

- [ ] **Step 6: Build and check by hand**

Run (macOS, in `mobile/ios`): `xcodegen generate && xcodebuild -scheme KingLouie -destination 'generic/platform=iOS Simulator' build`
Expected: `** BUILD SUCCEEDED **`.

Then, in demo mode: Pending shows a "Computer use" request; opening it shows both apps with paths, the reason labelled unverified and a 1–15 min stepper; Allow opens the live lease with a frame every 3 s and the action log; "Stop now" ends it. Against a real node running Part 5's service with a helper (`KL_E2E_GUI` not needed): a `RequestLease` from a chat shows up after pull-to-refresh or a `lease` push; Allow asks for Face ID once; the live view updates without further prompts; the kill switch asks once and the node's next input fails `lease_revoked`.

Run (from `mobile/ios/KLProtocol`): `swift test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add mobile/ios/App/RelayAPI.swift mobile/ios/App/DeviceKey.swift mobile/ios/App/AppModel.swift mobile/ios/App/LeaseViews.swift mobile/ios/App/Views.swift mobile/ios/App/KingLouieApp.swift
git commit -m "feat(ios): lease requests, the live lease and the kill switch

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: The Android app — the same screens, fetched on tap

**Files:**
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt` (lease calls, after `answerQuestion`)
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt` (a `// ---- Leases (fleet stage 5) ----` section; `openPushed` kind `lease`; `reset`; demo)
- Create: `mobile/android/app/src/main/kotlin/com/example/kinglouie/LeaseScreens.kt`
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt` (`Main` banner and live-lease route; `Pending` section; `History` label)
- Modify: `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt` (kind `lease` and its text)

**Interfaces:**
- Consumes: Task 23's `LeaseRequest`, `LeaseStatus`, `LeaseView`, `Leases`; the relay routes of Task 11.
- Produces (app-internal): `AppModel.leaseRequests`, `AppModel.liveLease`, `refreshLeases()`, `decideLease(item, apps, minutes, grant)`, `openLiveLease(nodeId, leaseId)`, `refreshLiveLease()`, `closeLiveLease()`, `killSwitch()`; composables `LeaseRequests`, `LeaseRequestScreen`, `LiveLeaseScreen`, `LeaseBanner`.

Owner question 1's default: Android fetches on tap. "Refresh" on the live screen signs one watch and one view fetch (`wait=0`), each a fingerprint prompt as Android requires; nothing polls; the kill switch is one prompt.

- [ ] **Step 1: `RelayApi` — the lease calls**

After `answerQuestion(...)`:

```kotlin
    // Fleet stage 5 (§4.7): lease requests, decisions and views.
    suspend fun leases(): List<JsonElement> = request("GET", "/v1/leases?wait=0").second.arr() ?: emptyList()

    /** `202 { state, reason? }` from the node, passed through by the relay. */
    suspend fun leaseDecision(action: String, leaseId: String, envelope: Envelope): JsonElement? =
        request("POST", "/v1/leases/${segment(leaseId)}/$action", envelope.json).second

    suspend fun leaseViews(leaseId: String, afterSeq: Int): List<JsonElement> =
        request("GET", "/v1/leases/${segment(leaseId)}/views?after_seq=$afterSeq&wait=0").second.arr() ?: emptyList()
```

- [ ] **Step 2: `AppModel` — the leases section**

Add after the Questions section:

```kotlin
    // ---- Leases (fleet stage 5) ----
    // Fetched on tap (Owner question 1): every relay request is a biometric
    // prompt on this phone, so nothing here polls.

    data class LeaseRequestItem(val request: LeaseRequest, val nodeName: String, val status: LeaseStatus?)

    data class LiveLease(
        val nodeId: String, val nodeName: String, val leaseId: String, val state: String = "pending", val locked: Boolean = false,
        val reason: String? = null, val expiresAtMs: Long? = null, val frame: ByteArray? = null, val frameAtMs: Long? = null,
        val frameDropped: Boolean = false, val actions: List<LeaseAction> = emptyList(), val lastSeq: Int = 0, val revoking: Boolean = false
    )

    val leaseRequests = mutableStateListOf<LeaseRequestItem>()
    var liveLease by mutableStateOf<LiveLease?>(null)
        private set
    var isLoadingLeases by mutableStateOf(false)
        private set
    private val decidedLeaseRequests = HashSet<String>()
    private var demoLeaseJob: kotlinx.coroutines.Job? = null

    fun refreshLeases() {
        if (pairing || mode != AppMode.LIVE || isLoadingLeases) return
        val api = client ?: return
        isLoadingLeases = true
        scope.launch {
            try {
                val pins = storage.nodes
                val items = api.leases().mapNotNull { entry -> verifiedLeaseRequest(entry, pins, api) }.distinctBy { it.request.requestId }
                leaseRequests.clear()
                leaseRequests.addAll(items)
            } catch (e: Exception) {
                fail(e)
            } finally {
                isLoadingLeases = false
            }
        }
    }

    private fun verifiedLeaseRequest(entry: JsonElement, pins: List<NodePin>, api: RelayApi): LeaseRequestItem? {
        val envelope = try { Envelope.fromJson(entry["envelope"] ?: return null) } catch (e: ProtocolException) { return null }
        val pin = pins.firstOrNull { it.id == envelope.kid } ?: return null
        val request = Leases.verifiedMessage(envelope, pin)?.let { LeaseRequest.from(it) } ?: return null
        if (request.requestId in decidedLeaseRequests) return null
        if ((Timestamps.epochMillis(request.expiresAt) ?: 0) <= api.now().toEpochMilli()) return null
        entry["node_id"].str()?.let { if (it != pin.id) return null }
        val status = entry["status"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() }
            ?.let { Leases.verifiedMessage(it, pin) }?.let { LeaseStatus.from(it) }
        if (status?.state == "ended") return null
        return LeaseRequestItem(request, pin.name, status)
    }

    fun decideLease(item: LeaseRequestItem, apps: Set<String>, minutes: Int, grant: Boolean) {
        if (mode == AppMode.DEMO) {
            leaseRequests.removeAll { it.request.requestId == item.request.requestId }
            if (grant) openLiveLease(item.request.nodeId, item.request.leaseId)
            return
        }
        val k = key ?: return
        val api = client ?: return
        scope.launch {
            try {
                val signedAt = Timestamps.string(api.now())
                val envelope = if (grant) {
                    val names = item.request.apps.filter { it.id in apps }.joinToString(", ") { promptText(it.name, 30) }
                    signEnvelope(k, Leases.grant(item.request, apps.toList(), minutes, k.deviceId, signedAt), "Allow computer use",
                        "$names on ${promptText(item.nodeName, 30)} for $minutes min")
                } else {
                    signEnvelope(k, Leases.deny(item.request, k.deviceId, signedAt), "Deny computer use", promptText(item.nodeName, 30))
                }
                val result = api.leaseDecision("grant", item.request.leaseId, envelope)
                if (result["state"].str() == "rejected") {
                    banner = "Node rejected: ${friendlyReason(result["reason"].str())}"
                    return@launch
                }
                decidedLeaseRequests.add(item.request.requestId)
                leaseRequests.removeAll { it.request.requestId == item.request.requestId }
                if (grant && result["state"].str() == "active") openLiveLease(item.request.nodeId, item.request.leaseId)
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun openLiveLease(nodeId: String, leaseId: String) {
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: demo?.pins?.firstOrNull { it.id == nodeId } ?: return
        liveLease = LiveLease(nodeId, pin.name, leaseId)
        if (mode == AppMode.DEMO) startDemoFrames(pin)
    }

    /** One watch and one fetch of what is new: the prompts Android requires, on the owner's tap. */
    fun refreshLiveLease() {
        val live = liveLease ?: return
        val k = key ?: return
        val api = client ?: return
        val pin = storage.nodes.firstOrNull { it.id == live.nodeId } ?: return
        scope.launch {
            try {
                if (live.state != "ended") {
                    val watch = Leases.watch(live.nodeId, live.leaseId, k.deviceId, Messages.randomNonce(), Timestamps.string(api.now()))
                    api.leaseDecision("watch", live.leaseId, signEnvelope(k, watch, "Watch computer use", promptText(live.nodeName, 30)))
                }
                var next = live
                for (entry in api.leaseViews(live.leaseId, live.lastSeq)) {
                    next = next.copy(lastSeq = maxOf(next.lastSeq, entry["seq"].int() ?: next.lastSeq))
                    val raw = entry["envelope"] ?: continue
                    val envelope = try { Envelope.fromJson(raw) } catch (e: ProtocolException) { continue }
                    next = applyLease(envelope, pin, next)
                }
                liveLease = next
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    private fun applyLease(envelope: Envelope, pin: NodePin, live: LiveLease): LiveLease {
        Leases.verifiedMessage(envelope, pin)?.let { LeaseStatus.from(it) }?.takeIf { it.leaseId == live.leaseId }?.let { s ->
            return live.copy(state = s.state, locked = s.locked, reason = s.reason, expiresAtMs = s.expiresAt?.let { Timestamps.epochMillis(it) },
                revoking = live.revoking && s.state != "ended")
        }
        val check = Leases.verifyView(envelope, pin)
        val view = check.view?.takeIf { check.accepted && it.leaseId == live.leaseId } ?: return live
        return live.copy(
            state = view.state, locked = view.locked, expiresAtMs = System.currentTimeMillis() + view.remainingS * 1000L,
            frameDropped = view.frameDropped, frame = view.frame ?: live.frame, frameAtMs = if (view.frame != null) System.currentTimeMillis() else live.frameAtMs,
            actions = (view.actions.reversed() + live.actions).take(200)
        )
    }

    fun closeLiveLease() {
        demoLeaseJob?.cancel()
        liveLease = null
    }

    /** One prompt, then a signed revoke re-sent every 3 s until the node answers ended. */
    fun killSwitch() {
        val live = liveLease ?: return
        if (live.revoking) return
        if (mode == AppMode.DEMO) {
            demoLeaseJob?.cancel()
            liveLease = live.copy(state = "ended", reason = "revoked")
            return
        }
        val k = key ?: return
        val api = client ?: return
        scope.launch {
            try {
                val message = Leases.revoke(live.nodeId, live.leaseId, "kill_switch", k.deviceId, Messages.randomNonce(), Timestamps.string(api.now()))
                val envelope = signEnvelope(k, message, "Stop computer use now", promptText(live.nodeName, 30))
                liveLease = live.copy(revoking = true)
                while (liveLease?.let { it.leaseId == live.leaseId && it.state != "ended" } == true) {
                    val result = runCatching { api.leaseDecision("revoke", live.leaseId, envelope) }.getOrNull()
                    if (result["state"].str() == "ended") liveLease = liveLease?.copy(state = "ended", reason = "revoked", revoking = false)
                    else kotlinx.coroutines.delay(3000)
                }
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    private fun startDemoFrames(pin: NodePin) {
        val fleet = demo ?: return
        demoLeaseJob?.cancel()
        demoLeaseJob = scope.launch {
            var seq = 1
            while (true) {
                val live = liveLease ?: break
                if (live.state == "ended") break
                val index = fleet.pins.indexOfFirst { it.id == pin.id }.takeIf { it >= 0 } ?: break
                val action = LeaseAction(seq, Timestamps.string(java.time.Instant.now()), if (seq % 2 == 0) "Type" else "Click",
                    if (seq % 2 == 0) "Type \"12+30=\" (6 chars)" else "Click left at (120, 88) on ss-$seq", "ok")
                val envelope = fleet.leaseView(index, live.leaseId, seq, fleet.deviceId, demoFrame(seq), maxOf(0, 900 - seq * 3), listOf(action))
                liveLease = applyLease(envelope, pin, live)
                seq += 1
                kotlinx.coroutines.delay(3000)
            }
        }
    }

    private fun demoFrame(seq: Int): ByteArray {
        val bitmap = android.graphics.Bitmap.createBitmap(480, 320, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        canvas.drawColor(android.graphics.Color.LTGRAY)
        canvas.drawText("Demo frame $seq", 24f, 160f, android.graphics.Paint().apply { textSize = 32f })
        return java.io.ByteArrayOutputStream().also { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    }
```

In the demo start (`val fleet = DemoFleet()` at ~454), after the approval requests:

```kotlin
            runCatching { fleet.leaseRequest(0, listOf("calculator", "notepad"), 15) }.getOrNull()?.let { env ->
                Leases.verifiedMessage(env, fleet.pins[0])?.let { LeaseRequest.from(it) }?.let { leaseRequests.add(LeaseRequestItem(it, fleet.pins[0].name, null)) }
            }
```

In `openPushed(kind, id)`, add `"lease" -> refreshLeases()`. In `reset()` (and where the demo is left), add `closeLiveLease(); leaseRequests.clear(); decidedLeaseRequests.clear()`.

`promptText`, `friendlyReason`, `fail`, `signEnvelope`, `scope`, `storage`, `demo` are the existing members this file already uses for questions and approvals; add imports for `LeaseRequest`, `LeaseStatus`, `LeaseAction`, `Leases`, `NodePin`, `ProtocolException` from `com.example.kinglouie.protocol` if they are not imported yet.

- [ ] **Step 3: `LeaseScreens.kt`**

```kotlin
package com.example.kinglouie

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import com.example.kinglouie.protocol.Display

private val LIMIT_TEXT = mapOf(
    "no_lock_detect" to "This computer cannot detect a locked screen.",
    "no_human_yield" to "This computer cannot detect your own typing, so it will not pause for you."
)

/** Fleet stage 5 §3.10: lease requests in the Pending tab, fetched on tap. */
@Composable
fun LeaseRequests(model: AppModel, open: (AppModel.LeaseRequestItem) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (model.mode == AppMode.LIVE) {
            OutlinedButton({ model.refreshLeases() }, enabled = !model.isLoadingLeases) { Text(if (model.isLoadingLeases) "Checking…" else "Check for computer-use requests") }
        }
        for (item in model.leaseRequests) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
                Text(if (item.request.isResume) "Resume computer use" else "Computer use: ${item.request.apps.joinToString(", ") { Display.escape(it.name) }}")
                Text("Job ${Display.escape(item.request.jobId)} · ${Display.escape(item.request.originClient)}")
                OutlinedButton({ open(item) }) { Text("Review") }
            }
        }
    }
}

@Composable
fun LeaseRequestScreen(model: AppModel, item: AppModel.LeaseRequestItem, done: () -> Unit) {
    var chosen by remember { mutableStateOf(item.request.apps.map { it.id }.toSet()) }
    var minutes by remember { mutableStateOf(item.request.maxMinutes) }
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
            Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
            Text("Agent's reason (unverified)", fontWeight = FontWeight.Bold)
            Text(Display.escape(item.request.reason))
            Text("Apps it may control", fontWeight = FontWeight.Bold)
        }
        items(item.request.apps) { app ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(Display.escape(app.name))
                    Text(Display.escape(app.path), fontFamily = FontFamily.Monospace)
                    if (app.processes.isNotEmpty()) Text(app.processes.joinToString(", ") { Display.escape(it) }, fontFamily = FontFamily.Monospace)
                }
                Switch(checked = app.id in chosen, enabled = !item.request.isResume, onCheckedChange = { on -> chosen = if (on) chosen + app.id else chosen - app.id })
            }
        }
        item {
            if (item.request.isResume) {
                Text("The ${item.request.maxMinutes} min that were left; a resume never extends the lease.")
            } else {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    OutlinedButton({ if (minutes > 1) minutes -= 1 }) { Text("−") }
                    Text("  $minutes min  ")
                    OutlinedButton({ if (minutes < item.request.maxMinutes) minutes += 1 }) { Text("+") }
                }
            }
            for (limit in item.request.limits) Text(LIMIT_TEXT[limit] ?: Display.escape(limit), color = Color(0xFFB26A00))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ model.decideLease(item, chosen, minutes, grant = true); done() }, enabled = chosen.isNotEmpty()) { Text("Allow") }
                OutlinedButton({ model.decideLease(item, emptySet(), 1, grant = false); done() }) { Text("Deny") }
            }
        }
    }
}

@Composable
fun LiveLeaseScreen(model: AppModel, close: () -> Unit) {
    val live = model.liveLease ?: return
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text(Display.escape(live.nodeName), fontWeight = FontWeight.Bold)
            Text(if (live.locked) "locked" else live.state)
            live.expiresAtMs?.takeIf { live.state != "ended" }?.let { Text(formatLeft(maxOf(0L, it - System.currentTimeMillis()))) }
            val bitmap = live.frame?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "The leased app's window", modifier = Modifier.fillMaxWidth())
            else Text("No frame yet")
            if (live.frameDropped) Text("Frame dropped (too large)", color = Color(0xFFB26A00))
            live.frameAtMs?.takeIf { System.currentTimeMillis() - it > 10_000 && live.state == "active" }?.let { Text("No frame for more than 10 s", color = Color(0xFFB26A00)) }
            live.reason?.takeIf { live.state != "active" }?.let { Text("Reason: ${Display.escape(it)}") }
            Button({ model.killSwitch() }, Modifier.fillMaxWidth(), enabled = !live.revoking && live.state != "ended",
                colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text(if (live.revoking) "Revoking…" else "Stop now") }
            if (model.mode == AppMode.LIVE) OutlinedButton({ model.refreshLiveLease() }) { Text("Refresh") }
            OutlinedButton({ model.closeLiveLease(); close() }) { Text("Close") }
            Text("Actions", fontWeight = FontWeight.Bold)
        }
        items(live.actions) { a -> Text("${Display.escape(a.summary)} · ${Display.escape(a.result)}") }
    }
}

/** "Lease active on <node>" with the kill switch, above every tab. */
@Composable
fun LeaseBanner(model: AppModel, open: () -> Unit) {
    val live = model.liveLease ?: return
    if (live.state == "ended") return
    Row(Modifier.fillMaxWidth().background(Color(0x22FF0000)).padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        OutlinedButton(open) { Text("Lease active on ${Display.escape(live.nodeName)}") }
        Button({ model.killSwitch() }, colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text("Stop") }
    }
}
```

- [ ] **Step 4: Wire the screens, the push kind and the history label**

- `Screens.kt`, `Main`: hold two pieces of state, `var leaseItem by remember { mutableStateOf<AppModel.LeaseRequestItem?>(null) }` and `var showLive by remember { mutableStateOf(false) }`. Below the demo banner, add `LeaseBanner(model) { showLive = true }`. Before the `when (tab)`, route:

```kotlin
            val item = leaseItem
            when {
                item != null -> LeaseRequestScreen(model, item) { leaseItem = null; showLive = model.liveLease != null }
                showLive && model.liveLease != null -> LiveLeaseScreen(model) { showLive = false }
                else -> when (tab) {
                    0 -> Pending(model) { leaseItem = it }
                    1 -> Questions(model)
                    2 -> History(model)
                    3 -> Nodes(model)
                    4 -> FrontDoor(model)
                    5 -> Devices(model)
                    else -> Settings(model)
                }
            }
```

- `Screens.kt`, `Pending`: add a parameter `openLease: (AppModel.LeaseRequestItem) -> Unit = {}` and render `LeaseRequests(model, openLease)` at the top of its column.
- `Screens.kt`, `History`: where an entry's `kind` is shown, prefix `"Computer use · "` when it starts with `lease.` or `gui.`.
- `push/Push.kt` (fcm): `if (kind !in setOf("approval", "pairing", "alert", "question", "lease")) return` and, in the content text, `"lease" -> "Computer use requested"`.

- [ ] **Step 5: Build and check by hand**

Run (from `mobile/android`): `./gradlew :app:assembleNopushDebug :app:assembleFcmDebug`
Expected: `BUILD SUCCESSFUL`.

Run (from `mobile/android/protocol`): `./gradlew test`
Expected: all tests pass.

Then, in demo mode: Pending shows the computer-use request; Review shows the apps with paths, the reason labelled unverified and the minutes control; Allow opens the live lease with canned frames every 3 s; Stop ends it. Against a real node: "Check for computer-use requests" (a fingerprint prompt) lists a `RequestLease`; Allow asks once; on the live screen each Refresh asks and shows the latest frame and actions; Stop asks once and the node's next input fails `lease_revoked`.

- [ ] **Step 6: Commit**

```bash
git add mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/LeaseScreens.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt
git commit -m "feat(android): lease requests, the live lease and the kill switch, fetched on tap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 6

The stage is complete: `npm test` shows `# fail 0`; `swift test` (macOS) and `./gradlew test` pass the lease-v1 vectors; both apps build. The spec's §10 table maps to: `gui-helper-protocol` (Task 7), `session-vectors` (Task 4), `gui-session-secret` (Task 5), `gui-broker` (Task 8), `gui-apps` (Task 2), `gui-tools` (Task 13), `gui-leases` (Task 9), `lease-vectors` (Task 6), `gui-text-guard`/`gui-keys` (Task 3), `gui-live-view` (Task 10), `gui-relay-extension` (Task 11), `agent-loop-images` (Task 12), `session-autostart` (Task 19), `session-backend-{windows,macos,linux}` (Tasks 16–18), and the e2e (Task 21).
