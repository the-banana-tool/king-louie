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

    func keys() throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("keys.json")))
    }

    func testEveryIosVectorIsCovered() throws {
        // The vector set has no fixed size (approval-v1 §9); the iOS set is exact.
        let vectors = try allVectors()
        let names = Set(vectors.filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }.compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, ["jcs", "device-id-p256", "device-id-ed25519", "request-valid", "request-bad-node-signature",
                               "request-unpinned-node", "request-malformed", "request-display", "request-display-edge",
                               "enroll-console", "audit-slice", "phone-api-auth"])
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
        for name in ["request-valid", "request-bad-node-signature", "request-unpinned-node", "request-malformed",
                     "request-display", "request-display-edge"] {
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
        XCTAssertEqual(Display.escape("\u{E0041}"), "\u{2039}U+E0041\u{203A}")
        XCTAssertEqual(Display.joinArgv(["run.sh", "", "has space", "a\"b"]), "run.sh \"\" \"has space\" \"a\\\"b\"")
        XCTAssertEqual(Display.pathSegment("params", "a.b"), "params[\"a.b\"]")
        XCTAssertEqual(Display.pathSegment("params", "a"), "params.a")
    }

    /// Shape first: a payload that is not exactly its own JCS bytes (here a
    /// non-canonical number, a duplicate key, whitespace) is malformed even
    /// from a pinned node, before the signature is looked at.
    func testNonCanonicalRequestIsMalformed() throws {
        let v = try vector("request-valid")
        let envelope = try Envelope(json: v["input"]!)
        let text = String(decoding: try envelope.payloadData(), as: UTF8.self)
        let pins = [NodePin(id: "kl-c2ubd6jjqumalzt5", name: "web-01", key: v["given"]!["pinned_nodes"]![0]!["key"]!.stringValue!)]
        let variants = [
            text.replacingOccurrences(of: "\"v\":1}", with: "\"v\":1.0}"),
            text.replacingOccurrences(of: "\"v\":1}", with: "\"v\":1,\"v\":1}"),
            text.replacingOccurrences(of: "{\"action\"", with: "{ \"action\"")
        ]
        for variant in variants {
            XCTAssertNotEqual(variant, text)
            let forged = Envelope(alg: envelope.alg, kid: envelope.kid, payload: Base64URL.encode(Data(variant.utf8)), sig: envelope.sig)
            XCTAssertEqual(Display.view(forged.json, pinned: pins).reason, "malformed", variant)
        }
    }

    func testEcmaScriptNumbers() {
        XCTAssertEqual(JCS.esNumber("0.5"), "0.5")
        XCTAssertEqual(JCS.esNumber("200"), "200")
        XCTAssertEqual(JCS.esNumber("-1"), "-1")
        XCTAssertEqual(JCS.esNumber("-0"), "0")
        XCTAssertEqual(JCS.esNumber("1.0"), "1")
        XCTAssertEqual(JCS.esNumber("1e21"), "1e+21")
        XCTAssertEqual(JCS.esNumber("1e-7"), "1e-7")
        XCTAssertEqual(JCS.esNumber("0.000001"), "0.000001")
        XCTAssertEqual(JCS.esNumber("123456789012345678901"), "123456789012345680000")
        XCTAssertNil(JCS.esNumber("1e400"))
    }

    func testAuditSlice() throws {
        let v = try vector("audit-slice")
        let result = AuditSlice.verify(v["input"]!, nodeKeyHex: v["given"]!["node"]!["key"]!.stringValue!)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.entries.count, v["expect"]?["entries"]?.intValue)
        let wrongKey = AuditSlice.verify(v["input"]!, nodeKeyHex: Identifiers.ed25519SpkiPrefix + String(repeating: "00", count: 32))
        XCTAssertFalse(wrongKey.ok)
        XCTAssertEqual(wrongKey.reason, "bad_signature")
    }

    /// The audit-slice vector's message, edited, then signed again with the
    /// web-01 test seed from keys.json (published test keys, tests only).
    func resealedSlice(_ edit: (inout [String: JSONValue]) -> Void) throws -> JSONValue {
        var m = try Envelope(json: try vector("audit-slice")["input"]!).message().objectValue!
        edit(&m)
        let seed = try Hex.decode(try keys()["nodes"]!["web-01"]!["seed"]!.stringValue!)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return try Envelope.seal(.object(m), alg: "Ed25519", kid: m["node_id"]!.stringValue!) { try key.signature(for: $0) }.json
    }

    /// Rewrites entry `index` (without recomputing its hash).
    func editEntry(_ m: inout [String: JSONValue], _ index: Int, _ edit: (inout [String: JSONValue]) -> Void) {
        var entries = m["entries"]!.arrayValue!
        var entry = entries[index].objectValue!
        edit(&entry)
        entries[index] = .object(entry)
        m["entries"] = .array(entries)
    }

    /// One tampered slice per failure branch of approval-v1 §3.6.
    func testAuditSliceFailureBranches() throws {
        let key = try vector("audit-slice")["given"]!["node"]!["key"]!.stringValue!
        func reason(_ slice: JSONValue) -> String? { AuditSlice.verify(slice, nodeKeyHex: key).reason }
        let entries = try Envelope(json: try vector("audit-slice")["input"]!).message()["entries"]!.arrayValue!
        let gpuBox = try keys()["nodes"]!["gpu-box"]!["id"]!.stringValue!

        // The helper itself: an unedited re-seal verifies.
        XCTAssertTrue(AuditSlice.verify(try resealedSlice { _ in }, nodeKeyHex: key).ok)
        XCTAssertEqual(reason(try resealedSlice { m in self.editEntry(&m, 0) { $0["node_id"] = .string(gpuBox) } }), "foreign_entry")
        XCTAssertEqual(reason(try resealedSlice { m in self.editEntry(&m, 1) { $0["kind"] = .string("approval.tampered") } }), "hash_mismatch")
        XCTAssertEqual(reason(try resealedSlice { m in m["entries"] = .array([entries[0], entries[2]]) }), "broken_chain")
        XCTAssertEqual(reason(try resealedSlice { m in m["head"] = .object(["seq": .number("2"), "hash": entries[1]["hash"]!]) }), "exceeds_head")
        XCTAssertEqual(reason(try resealedSlice { m in m["head"] = .object(["seq": .number("3"), "hash": entries[1]["hash"]!]) }), "head_mismatch")
        XCTAssertEqual(reason(try resealedSlice { m in m["anchor"] = .object(["seq": .number("2"), "prev": entries[0]["hash"]!]) }), "before_anchor")

        // Signed correctly but misshapen: malformed, as the JS verifier says.
        var extra = try vector("audit-slice")["input"]!.objectValue!
        extra["note"] = .string("x")
        XCTAssertEqual(reason(.object(extra)), "malformed")
        var otherKid = try vector("audit-slice")["input"]!.objectValue!
        otherKid["kid"] = .string(gpuBox)
        XCTAssertEqual(reason(.object(otherKid)), "malformed")
        XCTAssertEqual(reason(.string("not an envelope")), "bad_signature")
    }

    func testPhoneApiAuth() throws {
        let v = try vector("phone-api-auth")
        let g = v["given"]!
        let s = Messages.phoneAuthString(method: g["method"]!.stringValue!, pathWithQuery: g["path"]!.stringValue!,
                                         timestamp: g["timestamp"]!.stringValue!, body: Data(g["body"]!.stringValue!.utf8))
        XCTAssertEqual(s, v["expect"]?["signing_string"]?.stringValue)
        XCTAssertEqual(Digest.sha256B64url(Data(g["body"]!.stringValue!.utf8)), v["expect"]?["body_sha256"]?.stringValue)
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
        let a = try keys()["devices"]!["A"]!
        let key = try P256.Signing.PrivateKey(rawRepresentation: try Base64URL.decode(a["d"]!.stringValue!))
        let request = try Envelope(json: try vector("request-valid")["input"]!).message()
        let response = try Messages.response(to: request, decision: "approve", deviceId: a["id"]!.stringValue!, signedAt: "2026-09-23T18:04:31.201Z")
        let envelope = try Envelope.seal(response, kid: a["id"]!.stringValue!) { try key.signature(for: $0).rawRepresentation }
        XCTAssertTrue(envelope.verifyES256(x: a["jwk"]!["x"]!.stringValue!, y: a["jwk"]!["y"]!.stringValue!))
        let committed = try Envelope(json: try vector("response-approve")["input"]!)
        XCTAssertEqual(JCS.serialize(try committed.message()), String(decoding: try committed.payloadData(), as: UTF8.self))
        XCTAssertEqual(envelope.payload, committed.payload)
        XCTAssertThrowsError(try Messages.response(to: request, decision: "maybe", deviceId: a["id"]!.stringValue!, signedAt: "2026-09-23T18:04:31.201Z"))
    }

    /// The field limits a node enforces on what a phone writes (approval-v1 §3).
    func testPhoneWrittenFieldLimits() throws {
        let a = try keys()["devices"]!["A"]!
        let id = a["id"]!.stringValue!, x = a["jwk"]!["x"]!.stringValue!, y = a["jwk"]!["y"]!.stringValue!
        func device(_ name: String) throws -> JSONValue { try Messages.device(deviceId: id, name: name, platform: "ios", x: x, y: y) }
        XCTAssertNoThrow(try device(String(repeating: "n", count: 64)))
        XCTAssertThrowsError(try device(String(repeating: "n", count: 65)))
        XCTAssertThrowsError(try device(""))
        // UTF-16 units, not code points: 32 astral characters fill the 64.
        XCTAssertNoThrow(try device(String(repeating: "\u{1F600}", count: 32)))
        XCTAssertThrowsError(try device(String(repeating: "\u{1F600}", count: 33)))
        XCTAssertThrowsError(try Messages.device(deviceId: "d-aaaaaaaaaaaaaaaa", name: "phone", platform: "ios", x: x, y: y))
        XCTAssertThrowsError(try Messages.device(deviceId: id, name: "phone", platform: "desktop", x: x, y: y))

        let nonce = Messages.randomNonce()
        XCTAssertEqual(nonce.utf8.count, 43)
        let b = try keys()["devices"]!["B"]!["id"]!.stringValue!
        func revoke(_ reason: String, by: String? = nil, expires: String = "2026-09-24T18:04:11.201Z") throws -> JSONValue {
            try Messages.revoke(deviceId: b, revokedBy: by ?? id, reason: reason, createdAt: "2026-09-23T18:04:11.201Z", expiresAt: expires, nonce: nonce)
        }
        // Code points, not UTF-16 units: 200 astral characters are allowed.
        XCTAssertNoThrow(try revoke(String(repeating: "\u{1F600}", count: 200)))
        XCTAssertThrowsError(try revoke(String(repeating: "r", count: 201)))
        XCTAssertThrowsError(try revoke("lost", by: b))
        XCTAssertThrowsError(try revoke("lost", expires: "2026-10-01T18:04:11.201Z"))
        XCTAssertThrowsError(try revoke("lost", expires: "2026-02-30T00:00:00Z"))
    }

    func testTimestamps() {
        XCTAssertTrue(Timestamps.isValid("2026-09-23T18:04:11.201Z"))
        XCTAssertTrue(Timestamps.isValid("2024-02-29T00:00:00.5Z"))
        XCTAssertTrue(Timestamps.isValid("2026-09-23T18:04:11Z"))
        XCTAssertFalse(Timestamps.isValid("2026-02-30T00:00:00Z"))
        XCTAssertFalse(Timestamps.isValid("2026-01-01T24:00:00Z"))
        XCTAssertFalse(Timestamps.isValid("2026-09-23T18:04:11.2012Z"))
        XCTAssertFalse(Timestamps.isValid("2026-09-23T18:04:11.Z"))
        XCTAssertFalse(Timestamps.isValid("0099-01-01T00:00:00Z"))
        XCTAssertEqual(Timestamps.epochMillis("1970-01-01T00:00:01.5Z"), 1500)
        XCTAssertEqual(Timestamps.epochMillis("2026-09-23T18:04:11.201Z"), 1790186651201)
        // Fractions of 1–3 digits parse, as isValid accepts them.
        XCTAssertEqual(Timestamps.date("1970-01-01T00:00:01.5Z")?.timeIntervalSince1970, 1.5)
        XCTAssertEqual(Timestamps.date("1970-01-01T00:00:01.50Z")?.timeIntervalSince1970, 1.5)
        XCTAssertEqual(Timestamps.epochMillis("1970-01-01T00:00:01.501Z"), 1501)
        XCTAssertEqual(Timestamps.date("1970-01-01T00:00:01.501Z")?.timeIntervalSince1970 ?? 0, 1.501, accuracy: 1e-6)
        XCTAssertEqual(Timestamps.date("1970-01-01T00:00:01Z")?.timeIntervalSince1970, 1)
        XCTAssertNil(Timestamps.date("2026-02-30T00:00:00Z"))
        XCTAssertTrue(Timestamps.isValid(Timestamps.string(Date())))
    }

    /// Only accepted: true is approved; null is forwarded or not delivered.
    func testResponseOutcome() throws {
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":true,"accepted":true,"reason":null}"#)), .accepted)
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":true,"accepted":false,"reason":"expired"}"#)), .refused("expired"))
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":true,"accepted":null,"reason":null}"#)), .forwarded)
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":false,"accepted":null,"reason":null}"#)), .notDelivered)
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":false,"accepted":true,"reason":null}"#)), .notDelivered)
        XCTAssertEqual(ResponseOutcome(reply: try JSONParser.parse(#"{"delivered":true,"accepted":"true","reason":null}"#)), .notDelivered)
    }

    func testApprovalStatus() throws {
        let nodeKey = Curve25519.Signing.PrivateKey()
        let raw = nodeKey.publicKey.rawRepresentation
        let pin = NodePin(id: Identifiers.nodeId(ed25519Raw: raw), name: "web-01", key: Identifiers.ed25519SpkiPrefix + Hex.encode(raw))
        let requestId = "0f8e7c2a-5b1d-4c3e-9a7f-2d6b8e1c4a90"
        func status(kid: String? = nil, _ edit: (inout [String: JSONValue]) -> Void = { _ in }) throws -> JSONValue {
            var fields: [String: JSONValue] = [
                "v": .number("1"), "type": .string("kl.approval.status"), "request_id": .string(requestId),
                "node_id": .string(pin.id), "state": .string("approved"), "device_id": .null, "reason": .null,
                "at": .string("2026-09-23T18:04:31.201Z")
            ]
            edit(&fields)
            return try Envelope.seal(.object(fields), alg: "Ed25519", kid: kid ?? pin.id) { try nodeKey.signature(for: $0) }.json
        }
        XCTAssertEqual(ApprovalStatus.verify(try status(), requestId: requestId, pin: pin), ApprovalStatus(state: "approved", deviceId: nil, reason: nil))
        XCTAssertNotNil(ApprovalStatus.verify(try status { $0["reason"] = .string(String(repeating: "x", count: 300)) }, requestId: requestId, pin: pin))
        XCTAssertNil(ApprovalStatus.verify(try status { $0["reason"] = .string(String(repeating: "x", count: 301)) }, requestId: requestId, pin: pin))
        XCTAssertNil(ApprovalStatus.verify(try status { $0["state"] = .string("maybe") }, requestId: requestId, pin: pin))
        XCTAssertNil(ApprovalStatus.verify(try status { $0["extra"] = .null }, requestId: requestId, pin: pin))
        XCTAssertNil(ApprovalStatus.verify(try status { $0["device_id"] = .string("not-a-device") }, requestId: requestId, pin: pin))
        XCTAssertNil(ApprovalStatus.verify(try status(), requestId: "1f8e7c2a-5b1d-4c3e-9a7f-2d6b8e1c4a90", pin: pin))
        // Signed by the pinned key, but kid names another node.
        XCTAssertNil(ApprovalStatus.verify(try status(kid: "kl-aaaaaaaaaaaaaaaa"), requestId: requestId, pin: pin))
        // A valid status about another node (kid still the pin).
        XCTAssertNil(ApprovalStatus.verify(try status { $0["node_id"] = .string("kl-aaaaaaaaaaaaaaaa") }, requestId: requestId, pin: pin))
        // `at` must be a real calendar moment.
        XCTAssertNil(ApprovalStatus.verify(try status { $0["at"] = .string("2026-02-30T00:00:00Z") }, requestId: requestId, pin: pin))
        let other = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        XCTAssertNil(ApprovalStatus.verify(try status(), requestId: requestId, pin: NodePin(id: pin.id, name: "web-01", key: Identifiers.ed25519SpkiPrefix + Hex.encode(other))))
    }

    func testP1363Conversion() throws {
        let key = P256.Signing.PrivateKey()
        let signature = try key.signature(for: Data("x".utf8))
        let raw = signature.rawRepresentation
        XCTAssertEqual(raw.count, 64)
        XCTAssertEqual(try P1363.toDER(raw), signature.derRepresentation)
        XCTAssertEqual(try P1363.fromDER(signature.derRepresentation), raw)
        XCTAssertThrowsError(try P1363.fromDER(Data([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x05, 0x01])))
    }

    func testStrictParsing() {
        XCTAssertThrowsError(try JSONParser.parse(#"{"a":1,"a":2}"#))
        XCTAssertThrowsError(try JSONParser.parse(#""\ud800""#))
        XCTAssertThrowsError(try JSONParser.parse(#""\u+041""#))
        XCTAssertThrowsError(try JSONParser.parse(Data([0x22, 0xED, 0xA0, 0x80, 0x22])))
        XCTAssertThrowsError(try JSONParser.parse("{} x"))
        XCTAssertThrowsError(try Base64URL.decode("ab=="))
        XCTAssertThrowsError(try Base64URL.decode("abd"))
        XCTAssertThrowsError(try Hex.decode("+f"))
        XCTAssertEqual(try JSONParser.parse(#""é😀""#), .string("\u{E9}\u{1F600}"))
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
        XCTAssertThrowsError(try Messages.decodeQR("kl1:!!"))
    }
}
