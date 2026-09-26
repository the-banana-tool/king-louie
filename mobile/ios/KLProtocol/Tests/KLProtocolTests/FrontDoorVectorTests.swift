import XCTest
@testable import KLProtocol
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Runs every client-grant-v1 vector whose consumers include "ios"
/// (tests/vectors/client-grant-v1, shared with the front door and Android).
final class FrontDoorVectorTests: XCTestCase {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }()
    static let vectorsDir = root.appendingPathComponent("tests/vectors/client-grant-v1")

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("\(name).json")))
    }

    func allVectors() throws -> [JSONValue] {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.vectorsDir.path).filter { $0.hasSuffix(".json") }
        return try files.map { try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent($0))) }
    }

    func keys() throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.root.appendingPathComponent("tests/vectors/approval-v1/keys.json")))
    }

    func deviceA() throws -> (id: String, x: String, y: String) {
        let a = try keys()["devices"]!["A"]!
        return (a["id"]!.stringValue!, a["jwk"]!["x"]!.stringValue!, a["jwk"]!["y"]!.stringValue!)
    }

    /// The published front-door test key ("relay" in keys.json; tests only).
    func sealRepin(_ message: JSONValue, kid: String) throws -> JSONValue {
        let seed = try Hex.decode(try keys()["nodes"]!["relay"]!["seed"]!.stringValue!)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return try Envelope.seal(message, alg: "Ed25519", kid: kid) { try key.signature(for: $0) }.json
    }

    func payload(_ v: JSONValue) throws -> Data {
        try Envelope(json: v["input"]!).payloadData()
    }

    func string(_ v: JSONValue?, _ key: String) -> String {
        v![key]!.stringValue!
    }

    func repinKeyHex(_ g: JSONValue) throws -> String {
        Identifiers.ed25519SpkiPrefix + Hex.encode(try Base64URL.decode(string(g["frontdoor"], "key")))
    }

    func testEveryIosVectorIsCovered() throws {
        let names = Set(try allVectors()
            .filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }
            .compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, ["grant-approve", "grant-deny", "client-revoke-valid", "enroll-valid", "remove-valid", "repin-valid",
                               "repin-reject-bad-signature", "repin-reject-spki-mismatch", "repin-reject-old-pin-mismatch",
                               "fingerprint-grouping"])
    }

    /// The phone builds exactly the committed bytes, sorting what the owner chose.
    func testGrantApproveBytes() throws {
        let v = try vector("grant-approve")
        let expect = v["expect"]!["message"]!
        let choices = [ScopeChoice(scope: "fleet:run", machines: ["web-01", "gpu-box", "web-01"]), ScopeChoice(scope: "fleet:read")]
        let built = try FrontDoor.clientGrant(frontdoorId: string(v["given"]!["frontdoor"], "id"), pending: v["given"]!["pending"]!, userCode: "q7k-m2x",
                                              scopes: choices, decision: "approve", nonce: string(expect, "nonce"),
                                              deviceId: string(expect, "device_id"), signedAt: string(expect, "signed_at"))
        XCTAssertEqual(built, expect)
        XCTAssertEqual(JCS.data(built), try payload(v))
        let a = try deviceA()
        XCTAssertTrue(try Envelope(json: v["input"]!).verifyES256(x: a.x, y: a.y))
        XCTAssertNil(FrontDoor.validate("kl.client.grant", built))
    }

    func testGrantDenyBytes() throws {
        let v = try vector("grant-deny")
        let expect = v["expect"]!["message"]!
        let built = try FrontDoor.clientGrant(frontdoorId: string(v["given"]!["frontdoor"], "id"), pending: v["given"]!["pending"]!, userCode: "Q7KM2X",
                                              scopes: [ScopeChoice(scope: "fleet:read")], decision: "deny", nonce: string(expect, "nonce"),
                                              deviceId: string(expect, "device_id"), signedAt: string(expect, "signed_at"))
        XCTAssertEqual(JCS.data(built), try payload(v))
    }

    func testRevokeEnrollRemoveBytes() throws {
        let revoke = try vector("client-revoke-valid")
        let r = revoke["expect"]!["message"]!
        XCTAssertEqual(string(revoke["given"]!["challenges"]![0], "purpose"), "revoke")
        XCTAssertEqual(JCS.data(try FrontDoor.clientRevoke(frontdoorId: string(r, "frontdoor_id"), grantId: string(r, "grant_id"),
                                                            challenge: string(revoke["given"]!["challenges"]![0], "challenge"),
                                                            deviceId: string(r, "device_id"), signedAt: string(r, "signed_at"))), try payload(revoke))

        let enroll = try vector("enroll-valid")
        let e = enroll["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try FrontDoor.nodeEnroll(frontdoorId: string(e, "frontdoor_id"), pairing: enroll["given"]!["pairing"]!, decision: "approve",
                                                          nonce: string(e, "nonce"), deviceId: string(e, "device_id"), signedAt: string(e, "signed_at"))), try payload(enroll))

        let remove = try vector("remove-valid")
        let m = remove["expect"]!["message"]!
        XCTAssertEqual(string(remove["given"]!["challenges"]![0], "purpose"), "remove")
        XCTAssertEqual(JCS.data(try FrontDoor.nodeRemove(frontdoorId: string(m, "frontdoor_id"), nodeId: string(m, "node_id"),
                                                          challenge: string(remove["given"]!["challenges"]![0], "challenge"),
                                                          deviceId: string(m, "device_id"), signedAt: string(m, "signed_at"))), try payload(remove))
    }

    func testRepin() throws {
        for name in ["repin-valid", "repin-reject-bad-signature", "repin-reject-spki-mismatch", "repin-reject-old-pin-mismatch"] {
            let v = try vector(name)
            let g = v["given"]!
            let check = FrontDoor.verifyRepin(v["input"]!, frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: try repinKeyHex(g),
                                              receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin"))
            XCTAssertEqual(check.ok, v["expect"]!["accepted"]!.boolValue, name)
            XCTAssertEqual(check.reason.map { JSONValue.string($0) } ?? .null, v["expect"]!["reason"]!, name)
            if check.ok { XCTAssertEqual(check.newSpki, string(g, "received_spki")) } else { XCTAssertNil(check.newSpki, name) }
        }
        let v = try vector("repin-valid")
        let g = v["given"]!
        let keyHex = try repinKeyHex(g)
        let fd = string(g["frontdoor"], "id")
        let other = "sha256/" + String(repeating: "A", count: 43)
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: other, currentPin: string(g, "current_pin")).reason, "spki_mismatch")
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: other).reason, "old_pin_mismatch")
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: "kl-aaaaaaaaaaaaaaaa", frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin")).reason, "wrong_frontdoor")
        XCTAssertEqual(FrontDoor.verifyRepin(.string("x"), frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: other, currentPin: other).reason, "malformed")
    }

    /// §4.7 step 1: a pinned key that is not an Ed25519 key is `malformed`,
    /// before the envelope is looked at.
    func testRepinRefusesABadPinnedKey() throws {
        let v = try vector("repin-valid")
        let g = v["given"]!
        let good = try repinKeyHex(g)
        for bad in ["", "00", Identifiers.ed25519SpkiPrefix, "302a300506032b6571032100" + String(repeating: "00", count: 32), good + "00"] {
            let check = FrontDoor.verifyRepin(v["input"]!, frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: bad,
                                              receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin"))
            XCTAssertEqual(check.reason, "malformed", bad)
            XCTAssertFalse(check.ok)
        }
    }

    /// Fail closed on what the front door signs: unknown fields, old = new, a
    /// later version, a non-canonical payload, the wrong alg.
    func testRepinRefusesMalformedMessages() throws {
        let v = try vector("repin-valid")
        let g = v["given"]!
        let fd = string(g["frontdoor"], "id")
        let keyHex = try repinKeyHex(g)
        let message = try Envelope(json: v["input"]!).message().objectValue!
        func check(_ m: [String: JSONValue], received: String? = nil, current: String? = nil) throws -> RepinCheck {
            FrontDoor.verifyRepin(try sealRepin(.object(m), kid: fd), frontdoorId: fd, frontdoorKeyHex: keyHex,
                                  receivedSpki: received ?? string(g, "received_spki"), currentPin: current ?? string(g, "current_pin"))
        }
        func with(_ key: String, _ value: JSONValue?) -> [String: JSONValue] {
            var m = message
            m[key] = value
            return m
        }

        // The same message re-signed passes: the refusals below are the changes.
        XCTAssertTrue(try check(message).ok)
        XCTAssertEqual(try check(with("extra", .string("x"))).reason, "malformed")
        XCTAssertEqual(try check(with("created_at", nil)).reason, "malformed")
        let old = message["old_spki"]!.stringValue!
        XCTAssertEqual(try check(with("new_spki", .string(old)), received: old, current: old).reason, "malformed")
        XCTAssertEqual(try check(with("relay", .string("http://mcp.kl.example.com"))).reason, "malformed")
        XCTAssertEqual(try check(with("relay", .string("https://user@mcp.kl.example.com"))).reason, "malformed")
        XCTAssertEqual(try check(with("relay", .string("https://mcp.kl.example.com/#x"))).reason, "malformed")
        XCTAssertEqual(try check(with("new_spki", .number("1"))).reason, "malformed")
        XCTAssertEqual(try check(with("v", .number("2"))).reason, "unsupported_version")

        let env = try Envelope(json: v["input"]!)
        let asES256 = Envelope(alg: "ES256", kid: env.kid, payload: env.payload, sig: env.sig)
        XCTAssertEqual(FrontDoor.verifyRepin(asES256.json, frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin")).reason, "malformed")
        // Whitespace in the payload: not its own canonical bytes.
        let spaced = Envelope(alg: env.alg, kid: env.kid, payload: Base64URL.encode(Data(" ".utf8) + (try env.payloadData())), sig: env.sig)
        XCTAssertEqual(FrontDoor.verifyRepin(spaced.json, frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin")).reason, "malformed")
        // A fifth envelope member.
        var five = env.json.objectValue!
        five["x"] = .string("y")
        XCTAssertEqual(FrontDoor.verifyRepin(.object(five), frontdoorId: fd, frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin")).reason, "malformed")
    }

    func testFingerprintsAndUserCodes() throws {
        let v = try vector("fingerprint-grouping")
        let ids = v["input"]!["node_ids"]!.arrayValue!.map { $0.stringValue! }
        XCTAssertEqual(ids.map { JSONValue.string(FrontDoor.nodeFingerprint($0)) }, v["expect"]!["node_fingerprints"]!.arrayValue)
        let typed = v["input"]!["typed_codes"]!.arrayValue!.map { $0.stringValue! }
        let normalized = typed.map { FrontDoor.normalizeUserCode($0) }
        XCTAssertEqual(normalized.map { $0.map { JSONValue.string($0) } ?? .null }, v["expect"]!["user_codes"]!.arrayValue)
        XCTAssertEqual(normalized.map { $0.map { JSONValue.string(FrontDoor.formatUserCode($0)) } ?? .null }, v["expect"]!["displayed"]!.arrayValue)
        XCTAssertTrue(FrontDoor.isMachineName("gpu-box"))
        XCTAssertFalse(FrontDoor.isMachineName("GPU-box"))
    }

    /// The front door's normalizeUserCode, character for character (client-grant-v1 §6).
    func testUserCodesFollowTheFrontDoor() {
        XCTAssertEqual(FrontDoor.normalizeUserCode("Q7K\u{3000}M2X"), "Q7KM2X")
        XCTAssertEqual(FrontDoor.normalizeUserCode("\u{FEFF}q7k\u{00A0}m2x\n"), "Q7KM2X")
        XCTAssertEqual(FrontDoor.normalizeUserCode("Q7K" + String(repeating: " ", count: 58) + "M2X"), "Q7KM2X")
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7K" + String(repeating: " ", count: 59) + "M2X"))
        // Checked as ASCII before upper-casing: no look-alike becomes the alphabet.
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7KM\u{00DF}"))
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7KM2\u{0131}"))
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7KM2\u{FB00}"))
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7KM2\u{FF38}"))
        XCTAssertNil(FrontDoor.normalizeUserCode("Q7K_M2X"))
        XCTAssertNil(FrontDoor.normalizeUserCode(""))
    }

    /// What the front door refuses as malformed, the phone never signs.
    func testBuildersRefuse() throws {
        let v = try vector("grant-approve")
        let fd = string(v["given"]!["frontdoor"], "id")
        let pending = v["given"]!["pending"]!.objectValue!
        let a = try deviceA()
        func grant(_ p: [String: JSONValue], code: String = "Q7KM2X", decision: String = "approve", _ scopes: [ScopeChoice]) throws -> JSONValue {
            try FrontDoor.clientGrant(frontdoorId: fd, pending: .object(p), userCode: code, scopes: scopes, decision: decision,
                                      nonce: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z")
        }
        func with(_ key: String, _ value: JSONValue?) -> [String: JSONValue] {
            var p = pending
            p[key] = value
            return p
        }
        XCTAssertThrowsError(try grant(pending, []))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:run", machines: ["Web-01"])]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:run", machines: [])]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:read"), ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "Fleet:read")]))
        XCTAssertThrowsError(try grant(pending, code: "Q7KM2", [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(pending, decision: "Approve", [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(pending, decision: "maybe", [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(with("client_id", .number("7")), [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(with("code_challenge", nil), [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(with("client_name", .string(String(repeating: "\u{1F600}", count: 201))), [ScopeChoice(scope: "fleet:read")]))
        XCTAssertNoThrow(try grant(with("client_name", .string(String(repeating: "\u{1F600}", count: 200))), [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try FrontDoor.clientRevoke(frontdoorId: fd, grantId: "gr_short", challenge: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z"))
        XCTAssertThrowsError(try FrontDoor.nodeRemove(frontdoorId: fd, nodeId: "kl-short", challenge: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z"))

        // kl.node.enroll signs `replaces` exactly as given: a missing or
        // non-string value is refused, never turned into null.
        let pairing = try vector("enroll-valid")["given"]!["pairing"]!.objectValue!
        func enroll(_ key: String, _ value: JSONValue?) throws -> JSONValue {
            var p = pairing
            p[key] = value
            return try FrontDoor.nodeEnroll(frontdoorId: fd, pairing: .object(p), decision: "approve", nonce: Messages.randomNonce(),
                                            deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z")
        }
        XCTAssertNoThrow(try enroll("replaces", .null))
        XCTAssertThrowsError(try enroll("replaces", nil))
        XCTAssertThrowsError(try enroll("replaces", .number("1")))
        XCTAssertThrowsError(try enroll("replaces", .string("gpu-box")))
        XCTAssertThrowsError(try enroll("profile", .string("frontdoor")))
    }

    /// Every phone-signed vector (the node-only T3 additions included) is
    /// well formed by the phone's rules exactly when the front door does not
    /// refuse it as malformed: what the front door refuses for its own state
    /// (unknown_challenge, demo_device, unknown_request, ...) the phone signs,
    /// and the front door decides.
    func testPhoneRulesAgreeWithEveryPhoneSignedVector() throws {
        let phoneTypes = ["kl.client.grant", "kl.client.revoke", "kl.node.enroll", "kl.node.remove"]
        var seen: Set<String> = []
        for v in try allVectors() {
            guard let input = v["input"], input.objectValue != nil, input["alg"]?.stringValue == "ES256" else { continue }
            let name = v["name"]!.stringValue!
            let reason = v["expect"]!["reason"]?.stringValue
            seen.insert(name)
            guard let message = try? Envelope(json: input).message() else {
                XCTAssertEqual(reason, "malformed", name)
                continue
            }
            let type = message["type"]!.stringValue!
            XCTAssertTrue(phoneTypes.contains(type), name)
            let phoneReason = FrontDoor.validate(type, message)
            if reason == "malformed" || reason == "unsupported_version" {
                XCTAssertEqual(phoneReason, reason, name)
            } else {
                XCTAssertNil(phoneReason, name)
            }
        }
        XCTAssertTrue(seen.isSuperset(of: ["client-revoke-reject-challenge-unknown", "grant-reject-demo-device", "grant-reject-unknown-request",
                                           "grant-reject-noncanonical", "grant-reject-machines-unsorted"]))
    }

    func testGrantAndPairingRequests() throws {
        let v = try vector("grant-approve")
        var reply = v["given"]!["pending"]!.objectValue!
        for k in ["user_code", "expires_at", "claimed_by", "used_nonces"] { reply.removeValue(forKey: k) }
        reply["preselected"] = .array([.string("fleet:read")])
        reply["expires_in_ms"] = .number("280000")
        let request = try GrantRequest(json: .object(reply))
        XCTAssertEqual(request.clientName, "Example Client")
        XCTAssertEqual(request.redirectHost, "client.example.com")
        XCTAssertEqual(request.requestedScopes, ["fleet:read", "fleet:run"])
        XCTAssertEqual(request.preselected, ["fleet:read"])
        XCTAssertEqual(request.expiresInMs, 280000)
        func badReply(_ key: String, _ value: JSONValue?) -> JSONValue {
            var r = reply
            r[key] = value
            return .object(r)
        }
        XCTAssertThrowsError(try GrantRequest(json: badReply("grant_id", .string("gr_x"))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("extra", .string("x"))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("client_host", nil)))
        XCTAssertThrowsError(try GrantRequest(json: badReply("requested_scopes", .array([.string("fleet:read"), .string("fleet:read")]))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("requested_scopes", .array([.string("Fleet:read")]))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("preselected", .array([.number("1")]))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("expires_in_ms", .string("280000"))))
        XCTAssertThrowsError(try GrantRequest(json: badReply("expires_in_ms", .number("-1"))))
        XCTAssertThrowsError(try GrantRequest(json: .string("x")))
        let m = v["expect"]!["message"]!
        let signed = try request.message(frontdoorId: string(v["given"]!["frontdoor"], "id"), userCode: "Q7KM2X",
                                         scopes: [ScopeChoice(scope: "fleet:run", machines: ["web-01", "gpu-box"]), ScopeChoice(scope: "fleet:read")],
                                         decision: "approve", nonce: string(m, "nonce"), deviceId: string(m, "device_id"), signedAt: string(m, "signed_at"))
        XCTAssertEqual(JCS.data(signed), try payload(v))

        let e = try vector("enroll-valid")
        var entry = e["given"]!["pairing"]!.objectValue!
        entry.removeValue(forKey: "expires_at")
        entry.removeValue(forKey: "used_nonces")
        entry["expires_in_ms"] = .number("500000")
        let pairing = try PairingRequest(json: .object(entry))
        XCTAssertEqual(pairing.fingerprint, FrontDoor.nodeFingerprint(string(e["given"]!["pairing"], "node_id")))
        XCTAssertNil(pairing.replaces)
        let em = e["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try pairing.message(frontdoorId: string(em, "frontdoor_id"), decision: "approve", nonce: string(em, "nonce"),
                                                    deviceId: string(em, "device_id"), signedAt: string(em, "signed_at"))), try Envelope(json: e["input"]!).payloadData())
        func badEntry(_ key: String, _ value: JSONValue?) -> JSONValue {
            var r = entry
            r[key] = value
            return .object(r)
        }
        XCTAssertThrowsError(try PairingRequest(json: badEntry("node_id", .string("kl-aaaaaaaaaaaaaaaa"))))
        XCTAssertThrowsError(try PairingRequest(json: badEntry("extra", .string("x"))))
        XCTAssertThrowsError(try PairingRequest(json: badEntry("replaces", nil)))
        XCTAssertThrowsError(try PairingRequest(json: badEntry("public_key", .string(String(repeating: "A", count: 43)))))
        XCTAssertThrowsError(try PairingRequest(json: badEntry("node_name", .string("gpu box"))))
    }

    /// Ruling T2-purpose: a challenge is asked for with the purpose of the
    /// message it will be spent on.
    func testChallengesCarryAPurpose() throws {
        XCTAssertEqual(try FrontDoor.challengeRequest(purpose: FrontDoor.purposeRevoke), .object(["purpose": .string("revoke")]))
        XCTAssertEqual(try FrontDoor.challengeRequest(purpose: FrontDoor.purposeRemove), .object(["purpose": .string("remove")]))
        XCTAssertThrowsError(try FrontDoor.challengeRequest(purpose: "pair"))
        XCTAssertThrowsError(try FrontDoor.challengeRequest(purpose: "Revoke"))

        let nonce = Messages.randomNonce()
        let c = try Challenge(json: .object(["challenge": .string(nonce), "expires_in_ms": .number("120000")]))
        XCTAssertEqual(c.challenge, nonce)
        XCTAssertEqual(c.expiresInMs, 120000)
        XCTAssertThrowsError(try Challenge(json: .object(["challenge": .string("short"), "expires_in_ms": .number("120000")])))
        XCTAssertThrowsError(try Challenge(json: .object(["challenge": .string(nonce), "expires_in_ms": .number("120000"), "x": .null])))
        XCTAssertThrowsError(try Challenge(json: .object(["challenge": .string(nonce)])))
    }

    /// The front door's decision and removal replies: only a 2xx whose
    /// `state` is exactly the one asked for confirms anything; refusal codes
    /// (replaces_changed, key_enrolled_as_other_name, save_failed, and codes
    /// this app does not know yet) come through as data for the app to word.
    func testRepliesPassCodesThrough() {
        let approved = FrontDoorReply(status: 200, body: .object(["state": .string("approved")]))
        XCTAssertTrue(approved.confirms("approved"))
        XCTAssertFalse(approved.confirms("enrolled"))
        XCTAssertTrue(FrontDoorReply(status: 200, body: .object(["state": .string("enrolled")])).confirms("enrolled"))
        XCTAssertFalse(FrontDoorReply(status: 200, body: .object(["state": .string("Approved")])).confirms("approved"))
        XCTAssertFalse(FrontDoorReply(status: 200, body: .object(["state": .bool(true)])).confirms("approved"))
        XCTAssertFalse(FrontDoorReply(status: 200, body: .string("approved")).confirms("approved"))
        XCTAssertFalse(FrontDoorReply(status: 409, body: .object(["state": .string("approved")])).confirms("approved"))
        XCTAssertEqual(FrontDoorReply(status: 204, body: nil), .done(state: nil))
        XCTAssertTrue(FrontDoorReply(status: 204, body: nil).succeeded)

        for code in ["replaces_changed", "key_enrolled_as_other_name", "no_such_request", "a_code_from_a_later_front_door"] {
            let r = FrontDoorReply(status: 409, body: .object(["error": .string(code), "message": .string("text")]))
            XCTAssertEqual(r, .refused(status: 409, code: code, retryAfter: nil))
            XCTAssertFalse(r.succeeded)
            XCTAssertFalse(r.isRetryable)
        }
        let saveFailed = FrontDoorReply(status: 503, body: .object(["error": .string("save_failed"), "message": .string("try again"), "retry_after": .number("1")]))
        XCTAssertEqual(saveFailed, .refused(status: 503, code: "save_failed", retryAfter: 1))
        XCTAssertTrue(saveFailed.isRetryable)
        // Not a code: kept out, never crashes.
        XCTAssertEqual(FrontDoorReply(status: 400, body: .object(["error": .string("<b>x</b>")])), .refused(status: 400, code: nil, retryAfter: nil))
        XCTAssertEqual(FrontDoorReply(status: 400, body: .object(["error": .string(String(repeating: "x", count: 65))])), .refused(status: 400, code: nil, retryAfter: nil))
        XCTAssertEqual(FrontDoorReply(status: 400, body: .object(["error": .number("3")])), .refused(status: 400, code: nil, retryAfter: nil))
        XCTAssertEqual(FrontDoorReply(status: 500, body: nil), .refused(status: 500, code: nil, retryAfter: nil))
        XCTAssertEqual(FrontDoorReply(status: 503, body: .object(["error": .string("save_failed"), "retry_after": .string("1")])), .refused(status: 503, code: "save_failed", retryAfter: nil))
    }

    /// Mirror break reasons are data: known or not, they come through as
    /// codes, and nothing else in the reply is trusted blindly.
    func testAuditStatusPassesBreakReasonsThrough() throws {
        let status = try AuditStatus(json: JSONParser.parse("""
            {"head_seq":12,"anchor":{"seq":3,"prev":null},"gaps":[{"kind":"gap","from_seq":5,"to_seq":6,"at":"2026-09-23T18:04:11.201Z"}],
             "breaks":[{"seq":9,"reason":"fork","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"},{"seq":null,"reason":"a_reason_from_later","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"},
             {"seq":10,"reason":"<script>","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"}]}
            """))
        XCTAssertEqual(status.headSeq, 12)
        XCTAssertEqual(status.anchorSeq, 3)
        XCTAssertEqual(status.gapCount, 1)
        XCTAssertEqual(status.breaks, [AuditBreak(seq: 9, reason: "fork"), AuditBreak(seq: nil, reason: "a_reason_from_later"), AuditBreak(seq: 10, reason: nil)])
        XCTAssertTrue(status.broken)
        let clean = try AuditStatus(json: JSONParser.parse(#"{"head_seq":0,"anchor":null,"gaps":[],"breaks":[]}"#))
        XCTAssertFalse(clean.broken)
        XCTAssertNil(clean.anchorSeq)
        XCTAssertThrowsError(try AuditStatus(json: JSONParser.parse(#"{"head_seq":"0","anchor":null,"gaps":[],"breaks":[]}"#)))
        XCTAssertThrowsError(try AuditStatus(json: JSONParser.parse(#"{"head_seq":0,"anchor":null,"gaps":[],"breaks":{}}"#)))
        XCTAssertThrowsError(try AuditStatus(json: JSONParser.parse(#"{"head_seq":0,"anchor":null,"gaps":[],"breaks":[7]}"#)))
        XCTAssertThrowsError(try AuditStatus(json: JSONParser.parse("[]")))
        XCTAssertNoThrow(try AuditStatus(json: JSONParser.parse(#"{"head_seq":0,"anchor":null,"gaps":[],"breaks":[],"later_field":1}"#)))
    }
    /// The front door's isHttpsUrl, never looser: ports 1-65535, hosts of
    /// ASCII labels or a bracketed IPv6 literal, no userinfo or fragment.
    func testHttpsUrlsFollowTheFrontDoor() {
        for ok in ["https://client.example.com/meta.json", "https://client.example.com:443/meta.json", "HTTPS://client.example.com",
                   "https://client.example.com:1/", "https://client.example.com:65535/", "https://[2001:db8::1]:8443/m", "https://10.0.0.1/m"] {
            XCTAssertTrue(FrontDoorRules.isHttpsUrl(ok, max: FrontDoorRules.clientIdMax), ok)
        }
        for bad in ["https://client.example.com:65536/", "https://client.example.com:99999/", "https://client.example.com:0443x/",
                    "https://client.example.com:/", "https://client.example.com:123456/", "https://exa mple.com/", "https://exa_mple.com/",
                    "https://client..example.com/", "https://.example.com/", "https://[::1/", "https://[zz::1]/", "https://user@client.example.com/m",
                    "https://@client.example.com/m", "https://client.example.com/m#x", "https://client.example.com/m#", "http://client.example.com/m",
                    "https:client.example.com/m", "https:///m", "https://"] {
            XCTAssertFalse(FrontDoorRules.isHttpsUrl(bad, max: FrontDoorRules.clientIdMax), bad)
        }
    }

    func pendingReply(_ name: String) throws -> [String: JSONValue] {
        var reply = try vector(name)["given"]!["pending"]!.objectValue!
        for k in ["user_code", "expires_at", "claimed_by", "used_nonces"] { reply.removeValue(forKey: k) }
        reply["preselected"] = .array([])
        reply["expires_in_ms"] = .number("280000")
        return reply
    }

    /// URL-form client_id (a client ID metadata document): accepted in a
    /// request and signed as is; the refused forms never are.
    func testUrlClientIds() throws {
        let v = try vector("grant-approve")
        let fd = string(v["given"]!["frontdoor"], "id")
        let a = try deviceA()
        let pending = v["given"]!["pending"]!.objectValue!
        let reply = try pendingReply("grant-approve")
        func withId(_ base: [String: JSONValue], _ id: String) -> JSONValue {
            var r = base
            r["client_id"] = .string(id)
            return .object(r)
        }
        for ok in ["https://client.example.com/meta.json", "https://client.example.com:443/.well-known/client"] {
            let r = try GrantRequest(json: withId(reply, ok))
            XCTAssertEqual(r.clientId, ok)
            let m = try r.message(frontdoorId: fd, userCode: "Q7KM2X", scopes: [ScopeChoice(scope: "fleet:read")], decision: "approve",
                                  nonce: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z")
            XCTAssertEqual(m["client_id"]?.stringValue, ok)
        }
        for bad in ["https://user@client.example.com/meta.json", "https://client.example.com/meta.json#x", "https://client.example.com:65536/meta.json",
                    "https://exa mple.com/meta.json", "http://client.example.com/meta.json", "https://client.example.com/" + String(repeating: "a", count: 512)] {
            XCTAssertThrowsError(try GrantRequest(json: withId(reply, bad)), bad)
            XCTAssertThrowsError(try FrontDoor.clientGrant(frontdoorId: fd, pending: withId(pending, bad), userCode: "Q7KM2X",
                                                           scopes: [ScopeChoice(scope: "fleet:read")], decision: "approve", nonce: Messages.randomNonce(),
                                                           deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z"), bad)
        }
    }

    /// Modelled on grant-reject-scope-widened: the phone never signs a scope
    /// the client did not request.
    func testGrantRequestRefusesUnrequestedScopes() throws {
        let v = try vector("grant-reject-scope-widened")
        let fd = string(v["given"]!["frontdoor"], "id")
        let a = try deviceA()
        let request = try GrantRequest(json: .object(try pendingReply("grant-reject-scope-widened")))
        func sign(_ scopes: [ScopeChoice], _ decision: String = "approve") throws -> JSONValue {
            try request.message(frontdoorId: fd, userCode: "Q7KM2X", scopes: scopes, decision: decision, nonce: Messages.randomNonce(),
                                deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z")
        }
        // The vector's widened set: fleet:delegate was never requested.
        let widened = try Envelope(json: v["input"]!).message()["scopes"]!.arrayValue!.map { ScopeChoice(scope: $0["scope"]!.stringValue!) }
        XCTAssertThrowsError(try sign(widened))
        XCTAssertThrowsError(try sign([ScopeChoice(scope: "fleet:read"), ScopeChoice(scope: "fleet:unsafe")]))
        XCTAssertNoThrow(try sign([ScopeChoice(scope: "fleet:read")]))
        XCTAssertNoThrow(try sign([ScopeChoice(scope: "fleet:read"), ScopeChoice(scope: "fleet:run", machines: ["gpu-box"])]))
        // A denial carries no scopes, so what was chosen does not matter.
        XCTAssertEqual(try sign(widened, "deny")["scopes"], .array([]))
    }
}
