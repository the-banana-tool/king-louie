import XCTest
@testable import KLProtocol
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// ECDH in software from a vector's `d`, standing in for the phone's Secure Enclave key.
func softwareAgree(_ d: Data) -> (String, String) throws -> Data {
    return { x, y in
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: d)
        let xb = try Base64URL.decode(x)
        let yb = try Base64URL.decode(y)
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + xb + yb)
        return try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
    }
}

func softwareAgree(text d: String) throws -> (String, String) throws -> Data {
    softwareAgree(try Base64URL.decode(d))
}

/// What opens a vector's sealed message: the phone's box from `given.box`.
func openerOf(_ box: JSONValue) throws -> Opener {
    Seal.opener(recipientId: box["device_id"]!.stringValue!, agree: try softwareAgree(text: box["d"]!.stringValue!))
}

/// An opener whose box key will not act: a locked phone.
func lockedOpener(_ recipientId: String) -> Opener {
    Seal.opener(recipientId: recipientId, agree: { _, _ in throw SealKeyUnavailable("locked") })
}

/// An opener for a wrap that opened to content that is no such content.
let contentMalformedOpener: Opener = { _, _ in throw SealError("content_malformed") }

/// Sealed by hand, as a sender that does not follow the format: the plaintext is whatever it is given.
func handSealed(type: String, clear: JSONValue, senderId: String, plaintext: Data, recipient: (id: String, key: JSONValue)) throws -> JSONValue {
    let eph = freshBox()
    let secret = try eph.agree(recipient.key["x"]!.stringValue!, recipient.key["y"]!.stringValue!)
    let info = Data("kl-seal-v1\n\(type)\n\(senderId)\n\(recipient.id)".utf8)
    let kek = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(), info: info, outputByteCount: 32)
    let cekBytes = Data(repeating: 7, count: 32)
    let iv = Data(repeating: 9, count: 12)
    let body = try AES.GCM.seal(plaintext, using: SymmetricKey(data: cekBytes), nonce: try AES.GCM.Nonce(data: iv), authenticating: JCS.data(clear))
    let wrap = try AES.GCM.seal(cekBytes, using: kek, nonce: try AES.GCM.Nonce(data: Data(repeating: 0, count: 12)))
    var fields = clear.objectValue!
    fields["sealed"] = JSONValue.object([
        "v": .number("1"), "epk": eph.jwk, "iv": .string(Base64URL.encode(iv)), "ct": .string(Base64URL.encode(body.ciphertext + body.tag)),
        "keys": .object([recipient.id: .string(Base64URL.encode(wrap.ciphertext + wrap.tag))])
    ])
    return .object(fields)
}

/// A P-256 key for a node's box, made here.
func freshBox() -> (jwk: JSONValue, agree: (String, String) throws -> Data) {
    let key = P256.KeyAgreement.PrivateKey()
    let point = [UInt8](key.publicKey.x963Representation)
    let jwk = Messages.jwk(x: Base64URL.encode(Data(point[1..<33])), y: Base64URL.encode(Data(point[33..<65])))
    return (jwk: jwk, agree: softwareAgree(key.rawRepresentation))
}

/// What signs as a node, from a published test seed in keys.json.
func ed25519Signer(seedHex: String) throws -> (Data) throws -> Data {
    let seed = try Hex.decode(seedHex)
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    return { bytes in try key.signature(for: bytes) }
}

/// The same coordinate with its low bit flipped: not on the curve with its x.
func offCurve(_ y: String) throws -> String {
    var bytes = [UInt8](try Base64URL.decode(y))
    bytes[bytes.count - 1] ^= 1
    return Base64URL.encode(Data(bytes))
}

/// `value` with `key` set, or removed when nil.
func withField(_ value: JSONValue, _ key: String, _ field: JSONValue?) -> JSONValue {
    var o = value.objectValue!
    o[key] = field
    return .object(o)
}

/// The seal, against src/approvals/seal.js through the vectors. Not compiled on
/// the machine that wrote it: see the commit.
final class SealVectorTests: XCTestCase {
    static let dir: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("tests/vectors/approval-v1")
    }()

    let requestType = "kl.approval.request"

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.dir.appendingPathComponent("\(name).json")))
    }

    func keys() throws -> JSONValue {
        try vector("keys")
    }

    func reasonOf<T>(_ block: () throws -> T) -> String? {
        do {
            _ = try block()
            return nil
        } catch let refused as SealError {
            return refused.reason
        } catch {
            return "another error: \(error)"
        }
    }

    func pins(_ v: JSONValue) -> [NodePin] {
        v["given"]!["pinned_nodes"]!.arrayValue!.map { NodePin(id: $0["id"]!.stringValue!, name: "", key: $0["key"]!.stringValue!) }
    }

    /// What a phone does with a sealed request: open it, then hold the clear hash to the opened content.
    func run(_ v: JSONValue) throws -> (reason: String?, message: JSONValue?) {
        let box = v["given"]!["box"]!
        let agree = try softwareAgree(text: box["d"]!.stringValue!)
        do {
            let opened = try Seal.open(type: v["given"]!["type"]!.stringValue!, message: v["input"]!, recipientId: box["device_id"]!.stringValue!, agree: agree)
            if let problem = Messages.validateOpenedRequest(opened) { return (reason: problem, message: nil) }
            return (reason: nil, message: opened)
        } catch let refused as SealError {
            return (reason: refused.reason, message: nil)
        }
    }

    func testEverySealVectorAnswersAsTheNodeDoes() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.dir.path).filter { $0.hasPrefix("seal-") && $0.hasSuffix(".json") }
        XCTAssertEqual(files.count, 8)
        for file in files {
            let v = try JSONParser.parse(try Data(contentsOf: Self.dir.appendingPathComponent(file)))
            XCTAssertTrue((v["consumers"]?.arrayValue ?? []).contains(.string("ios")), file)
            let result = try run(v)
            XCTAssertEqual(result.reason, v["expect"]!["reason"]!.stringValue, file)
            if result.reason == nil { XCTAssertEqual(result.message, v["expect"]!["message"], file) }
        }
        let good = try vector("seal-open")
        XCTAssertNil(try run(good).reason)
        XCTAssertEqual(try run(good).message, good["expect"]!["message"])
    }

    func testSaltedHashIsTheNodes() throws {
        let m = try vector("seal-open")["expect"]!["message"]!
        XCTAssertEqual(try Seal.saltedHash(salt: m["salt"]!.stringValue!, value: m["action"]!), m["action_hash"]!.stringValue)
        XCTAssertEqual(reasonOf { try Seal.saltedHash(salt: "short", value: m["action"]!) }, "malformed")
        XCTAssertEqual(reasonOf { try Seal.saltedHash(salt: Base64URL.encode(Data(repeating: 0, count: 31)), value: m["action"]!) }, "malformed")
        // Not the clear rule: the salt is in the hash.
        XCTAssertNotEqual(KLProtocol.Digest.sha256B64url(JCS.data(m["action"]!)), m["action_hash"]!.stringValue)
    }

    func testTheSealedShape() throws {
        let good = try vector("seal-open")["input"]!
        XCTAssertTrue(Seal.isSealedShape(type: requestType, message: good))
        let sealed = good["sealed"]!
        func withSealed(_ key: String, _ value: JSONValue?) -> JSONValue { withField(good, "sealed", withField(sealed, key, value)) }
        let bad = Messages.jwk(x: sealed["epk"]!["x"]!.stringValue!, y: try offCurve(sealed["epk"]!["y"]!.stringValue!))
        let wrap = sealed["keys"]!.objectValue!.values.first!
        let refused: [(String, Bool)] = [
            ("not a sealed type", Seal.isSealedShape(type: "kl.approval.response", message: withField(good, "type", .string("kl.approval.response")))),
            ("another type", Seal.isSealedShape(type: "kl.lease.request", message: good)),
            ("a key missing", Seal.isSealedShape(type: requestType, message: withField(good, "node_box", nil))),
            ("a key too many", Seal.isSealedShape(type: requestType, message: withField(good, "action", .null))),
            ("v 2", Seal.isSealedShape(type: requestType, message: withSealed("v", .number("2")))),
            ("no epk", Seal.isSealedShape(type: requestType, message: withSealed("epk", nil))),
            ("an epk off the curve", Seal.isSealedShape(type: requestType, message: withSealed("epk", bad))),
            ("an iv of 11", Seal.isSealedShape(type: requestType, message: withSealed("iv", .string(Base64URL.encode(Data(repeating: 0, count: 11)))))),
            ("a ct under the tag", Seal.isSealedShape(type: requestType, message: withSealed("ct", .string(Base64URL.encode(Data(repeating: 0, count: 15)))))),
            ("no recipients", Seal.isSealedShape(type: requestType, message: withSealed("keys", .object([:])))),
            ("a recipient that is no id", Seal.isSealedShape(type: requestType, message: withSealed("keys", .object(["phone": wrap])))),
            ("a wrap of 47", Seal.isSealedShape(type: requestType, message: withSealed("keys", .object(["d-aaaaaaaaaaaaaaaa": .string(Base64URL.encode(Data(repeating: 0, count: 47)))]))))
        ]
        for (why, accepted) in refused { XCTAssertFalse(accepted, why) }
    }

    /// The epk is checked before any key agreement, and every failure past that is one answer.
    func testOpenRefusals() throws {
        let good = try vector("seal-open")["input"]!
        let sealed = good["sealed"]!
        let k = try keys()
        let a = k["devices"]!["A"]!["id"]!.stringValue!
        let real = try softwareAgree(text: k["devices"]!["A_box"]!["d"]!.stringValue!)
        var calls = 0
        let spy: (String, String) throws -> Data = { x, y in
            calls += 1
            return try real(x, y)
        }
        let badPoint = Messages.jwk(x: sealed["epk"]!["x"]!.stringValue!, y: try offCurve(sealed["epk"]!["y"]!.stringValue!))
        let badEpk = withField(good, "sealed", withField(sealed, "epk", badPoint))
        XCTAssertEqual(reasonOf { try Seal.open(type: requestType, message: badEpk, recipientId: a, agree: spy) }, "malformed")
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(reasonOf { try Seal.open(type: requestType, message: good, recipientId: "d-aaaaaaaaaaaaaaaa", agree: spy) }, "not_recipient")
        XCTAssertEqual(calls, 0)
        XCTAssertNoThrow(try Seal.open(type: requestType, message: good, recipientId: a, agree: spy))
        XCTAssertEqual(calls, 1)

        // Another phone's box under this id; an agreement of the wrong size; one that throws.
        let other = try softwareAgree(text: k["devices"]!["B_box"]!["d"]!.stringValue!)
        XCTAssertEqual(reasonOf { try Seal.open(type: requestType, message: good, recipientId: a, agree: other) }, "open_failed")
        XCTAssertEqual(reasonOf { try Seal.open(type: requestType, message: good, recipientId: a, agree: { _, _ in Data(repeating: 1, count: 31) }) }, "open_failed")
        XCTAssertEqual(reasonOf { try Seal.open(type: requestType, message: good, recipientId: a, agree: { _, _ in throw ProtocolError.keyInvalidated }) }, "open_failed")
        // A locked key is not a wrap that does not open: it passes through open itself.
        XCTAssertThrowsError(try Seal.open(type: requestType, message: good, recipientId: a, agree: { _, _ in throw SealKeyUnavailable("locked") })) { error in
            XCTAssertEqual(error as? SealKeyUnavailable, SealKeyUnavailable("locked"))
        }
    }

    func answerClear(device: String, node: String) -> JSONValue {
        .object([
            "v": .number("1"), "type": .string("kl.question.answer"), "node_id": .string(node), "token": .string("7QD4KM"),
            "device_id": .string(device), "nonce": .string(String(repeating: "n", count: 43)), "signed_at": .string("2026-09-23T18:04:11.201Z")
        ])
    }

    let answerContent: JSONValue = .object(["case_id": .string("c-1"), "question_id": .string("q-0001"), "answer": .object(["text": .string("yes")])])

    /// The sender in the info and the AAD: the device for an answer, the node for all else.
    func testTheSenderIdIsBound() throws {
        let k = try keys()
        let device = k["devices"]!["A"]!["id"]!.stringValue!
        let other = k["devices"]!["B"]!["id"]!.stringValue!
        let node = k["nodes"]!["web-01"]!
        let nodeId = node["id"]!.stringValue!
        let nodeBox = node["box"]!["jwk"]!
        let clear = answerClear(device: device, node: nodeId)
        let type = "kl.question.answer"
        let sealed = try Seal.seal(type: type, senderId: device, clear: clear, content: answerContent, recipient: (id: nodeId, key: nodeBox))
        XCTAssertTrue(Seal.isSealedShape(type: type, message: sealed))
        let agree = try softwareAgree(text: node["box"]!["d"]!.stringValue!)
        let whole = clear.objectValue!.merging(answerContent.objectValue!) { first, _ in first }
        XCTAssertEqual(try Seal.open(type: type, message: sealed, recipientId: nodeId, agree: agree), .object(whole))
        // Another device named in the clear part: neither the kek nor the AAD holds.
        let forged = withField(sealed, "device_id", .string(other))
        XCTAssertEqual(reasonOf { try Seal.open(type: type, message: forged, recipientId: nodeId, agree: agree) }, "open_failed")
        // The sender is the clear part's: the device for an answer.
        XCTAssertEqual(reasonOf { try Seal.seal(type: type, senderId: nodeId, clear: clear, content: answerContent, recipient: (id: nodeId, key: nodeBox)) }, "malformed")
        // Sealed under another sender than the one a reader takes.
        let askClear: JSONValue = .object([
            "v": .number("1"), "type": .string("kl.question.ask"), "node_id": .string(nodeId), "token": .string("7QD4KM"),
            "kind": .string("question"), "urgency": .string("high"), "expires_at": .null, "node_box": nodeBox
        ])
        let askContent: JSONValue = .object(["case_id": .string("c-1"), "question_id": .string("q-0001"), "case_title": .string("Lakeside lot"), "text": .string("Ok?"), "options": .array([])])
        XCTAssertEqual(reasonOf { try Seal.seal(type: "kl.question.ask", senderId: device, clear: askClear, content: askContent, recipient: (id: nodeId, key: nodeBox)) }, "malformed")
        XCTAssertNoThrow(try Seal.seal(type: "kl.question.ask", senderId: nodeId, clear: askClear, content: askContent, recipient: (id: nodeId, key: nodeBox)))
    }

    func testSealRefusals() throws {
        let full = try vector("question-answer-sealed")["expect"]!["message"]!
        let type = "kl.question.answer"
        let device = full["device_id"]!.stringValue!
        let node = try keys()["nodes"]!["web-01"]!
        let nodeId = node["id"]!.stringValue!
        let nodeBox = node["box"]!["jwk"]!
        let parts = try Seal.split(type: type, full: full)
        XCTAssertEqual(Set(parts.content.objectValue!.keys), Set(["case_id", "question_id", "answer"]))
        func refusal(type t: String? = nil, clear: JSONValue? = nil, content: JSONValue? = nil, id: String? = nil, key: JSONValue? = nil) -> String? {
            reasonOf { try Seal.seal(type: t ?? type, senderId: device, clear: clear ?? parts.clear, content: content ?? parts.content, recipient: (id: id ?? nodeId, key: key ?? nodeBox)) }
        }
        XCTAssertNil(refusal())
        // A key outside the row, the clear part holding `sealed`, a clear key missing, not a sealed type.
        XCTAssertEqual(refusal(content: withField(parts.content, "token", .string("x"))), "malformed")
        XCTAssertEqual(refusal(clear: withField(parts.clear, "sealed", .null)), "malformed")
        XCTAssertEqual(refusal(clear: withField(parts.clear, "nonce", nil)), "malformed")
        XCTAssertEqual(refusal(type: "kl.approval.response"), "malformed")
        // The recipient: an id, and a P-256 JWK on the curve, checked before anything is used.
        XCTAssertEqual(refusal(id: "web-01"), "malformed")
        XCTAssertEqual(refusal(key: Messages.jwk(x: nodeBox["x"]!.stringValue!, y: try offCurve(nodeBox["y"]!.stringValue!))), "malformed")
        XCTAssertEqual(refusal(key: withField(nodeBox, "kid", .string("x"))), "malformed")
    }

    /// Byte for byte: with the vector's ephemeral key and random bytes, the phone's seal is the signed payload.
    func testTheAnswerThePhoneSealsIsTheVectorsBytes() throws {
        let v = try vector("question-answer-sealed")
        let envelope = try Envelope(json: v["input"]!)
        let sent = try envelope.message()
        func sha(_ text: String) -> Data { KLProtocol.Digest.sha256(Data(text.utf8)) }
        let ephemeral = Seal.Ephemeral(jwk: sent["sealed"]!["epk"]!, agree: softwareAgree(sha("sealed answer epk")))
        let g = v["given"]!
        let type = "kl.question.answer"
        let device = g["device"]!["device_id"]!.stringValue!
        let nodeId = g["box"]!["node_id"]!.stringValue!
        let nodeBox = g["ask"]!["node_box"]!
        let parts = try Seal.split(type: type, full: v["expect"]!["message"]!)
        let sealed = try Seal.sealWith(type: type, senderId: device, clear: parts.clear, content: parts.content, recipient: (id: nodeId, key: nodeBox), ephemeral: ephemeral, random: { n in
            n == 32 ? sha("sealed answer cek") : Data(sha("sealed answer iv").prefix(n))
        })
        XCTAssertEqual(sealed, sent)
        XCTAssertEqual(JCS.data(sealed), try envelope.payloadData())
        // And a fresh seal opens to the same message, with its own ephemeral key.
        let fresh = try Seal.seal(type: type, senderId: device, clear: parts.clear, content: parts.content, recipient: (id: nodeId, key: nodeBox))
        XCTAssertNotEqual(sent["sealed"]!["epk"], fresh["sealed"]!["epk"])
        let agree = try softwareAgree(text: g["box"]!["d"]!.stringValue!)
        XCTAssertEqual(try Seal.open(type: type, message: fresh, recipientId: nodeId, agree: agree), v["expect"]!["message"])
    }

    /// R-SP-1, R-SP-2: a sealed request shows what the clear one shows, and only to a box that opens it.
    func testASealedRequestOnTheScreen() throws {
        let v = try vector("request-sealed-display")
        let box = v["given"]!["box"]!
        let pinned = pins(v)
        let input = v["input"]!
        let shown = Display.view(input, pinned: pinned, open: try openerOf(box), sealedSeen: [])
        XCTAssertEqual(shown.json, v["expect"])
        XCTAssertEqual(shown.seal, .opened)
        XCTAssertEqual(shown.display, try vector("request-display")["expect"]!["display"])
        // The same clear form as the node validates.
        let message = try Envelope(json: input).message()
        XCTAssertNil(Messages.validate(requestType, message))
        XCTAssertNil(message["action"])

        // No opener: never shown as if clear.
        let noBox = Display.view(input, pinned: pinned, sealedSeen: [])
        XCTAssertEqual(noBox.json, .object(["shown": .bool(false), "reason": .string("not_recipient"), "display": .null]))
        XCTAssertEqual(noBox.seal, .unread)
        XCTAssertEqual(Display.view(input, pinned: [], open: try openerOf(box), sealedSeen: []).reason, "unpinned_node")
        let d = box["d"]!.stringValue!
        XCTAssertEqual(Display.view(input, pinned: pinned, open: Seal.opener(recipientId: "d-aaaaaaaaaaaaaaaa", agree: try softwareAgree(text: d)), sealedSeen: []).reason, "not_recipient")
        // A wrap that does not open: another phone's box under this one's id.
        let bBox = try keys()["devices"]!["B_box"]!["d"]!.stringValue!
        let wrong = Display.view(input, pinned: pinned, open: Seal.opener(recipientId: box["device_id"]!.stringValue!, agree: try softwareAgree(text: bBox)), sealedSeen: [])
        XCTAssertEqual(wrong.reason, "open_failed")
        XCTAssertEqual(wrong.seal, .unread)
        XCTAssertNil(wrong.display)
    }

    /// A sealed request is answered only from what was opened and checked; the hash signed is the one received.
    func testAResponseIsOnlyFromTheOpenedMessage() throws {
        let v = try vector("request-sealed-display")
        let box = v["given"]!["box"]!
        let message = try Envelope(json: v["input"]!).message()
        let device = box["device_id"]!.stringValue!
        let at = "2026-09-23T18:04:31.201Z"
        XCTAssertThrowsError(try Messages.response(to: message, decision: "approve", deviceId: device, signedAt: at))
        let shown = Display.view(v["input"]!, pinned: pins(v), open: try openerOf(box), sealedSeen: [])
        let opened = try XCTUnwrap(shown.opened)
        let response = try Messages.responseToOpened(opened, decision: "approve", deviceId: device, signedAt: at)
        XCTAssertEqual(response["action_hash"], message["action_hash"])
        // Only a sealed request that was shown carries what was opened.
        XCTAssertNil(Display.view(v["input"]!, pinned: pins(v), sealedSeen: []).opened)
        let plain = try vector("request-valid")
        XCTAssertNil(Display.view(plain["input"]!, pinned: pins(plain), sealedSeen: []).opened)
        // The opened form takes only what passes the opened-request rules.
        XCTAssertThrowsError(try Messages.responseToOpened(message, decision: "approve", deviceId: device, signedAt: at))
        let changed = withField(opened, "action", withField(opened["action"]!, "summary", .string("other")))
        XCTAssertThrowsError(try Messages.responseToOpened(changed, decision: "approve", deviceId: device, signedAt: at))
        // A clear request is as it was.
        let clear = try Envelope(json: try vector("request-valid")["input"]!).message()
        XCTAssertNoThrow(try Messages.response(to: clear, decision: "approve", deviceId: device, signedAt: at))
        XCTAssertThrowsError(try Messages.responseToOpened(clear, decision: "approve", deviceId: device, signedAt: at))
    }

    /// A failed signature, an unpinned node, a misshapen message: nothing is opened.
    func testTheSignatureComesBeforeTheOpen() throws {
        let v = try vector("request-sealed-display")
        let pin = pins(v)[0]
        let real = try openerOf(v["given"]!["box"]!)
        var calls = 0
        let opener: Opener = { type, message in
            calls += 1
            return try real(type, message)
        }
        let input = v["input"]!
        let otherKey = try keys()["nodes"]!["gpu-box"]!["spki"]!.stringValue!
        XCTAssertEqual(Display.view(input, pinned: [NodePin(id: pin.id, name: "", key: otherKey)], open: opener, sealedSeen: []).reason, "bad_node_signature")
        XCTAssertEqual(Display.view(input, pinned: [], open: opener, sealedSeen: []).reason, "unpinned_node")
        let envelope = try Envelope(json: input)
        let garbled = Envelope(alg: envelope.alg, kid: envelope.kid, payload: Base64URL.encode(Data("{\"sealed\":{}}".utf8)), sig: envelope.sig)
        XCTAssertEqual(Display.view(garbled.json, pinned: [pin], open: opener, sealedSeen: []).reason, "malformed")
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(Display.view(input, pinned: [pin], open: opener, sealedSeen: []).shown)
        XCTAssertEqual(calls, 1)
    }

    /// What content cannot be, signed by the pinned node and opened.
    func testAHashThatDoesNotHoldIsRefusedBeforeAnythingIsShown() throws {
        let v = try vector("request-sealed-display")
        let box = v["given"]!["box"]!
        let message = try Envelope(json: v["input"]!).message()
        let opened = try Seal.open(type: requestType, message: message, recipientId: box["device_id"]!.stringValue!, agree: try softwareAgree(text: box["d"]!.stringValue!))
        XCTAssertNil(Messages.validateOpenedRequest(opened))
        let changed = withField(opened, "action", withField(opened["action"]!, "summary", .string("other")))
        XCTAssertEqual(Messages.validateOpenedRequest(changed), "action_hash_mismatch")
        // What the clear shape would refuse, inside.
        XCTAssertEqual(Messages.validateOpenedRequest(withField(opened, "origin", nil)), "malformed")
        XCTAssertEqual(Messages.validateOpenedRequest(withField(opened, "salt", .string("short"))), "malformed")
        XCTAssertEqual(Messages.validateOpenedRequest(withField(opened, "node_box", nil)), "malformed")
        // A clear request is not an opened one: it has no salt and no node_box.
        XCTAssertEqual(Messages.validateOpenedRequest(try Envelope(json: try vector("request-valid")["input"]!).message()), "malformed")
    }

    /// `content_malformed` reaches the screen as `malformed`, as the reference says: the vector's
    /// bytes signed by the pinned node, and the reader offers nothing.
    func testContentMalformedOnTheScreen() throws {
        let k = try keys()
        let web = k["nodes"]!["web-01"]!
        let pin = NodePin(id: web["id"]!.stringValue!, name: "web-01", key: web["spki"]!.stringValue!)
        for name in ["seal-content-not-jcs", "seal-content-clear-key", "seal-pad-not-spaces"] {
            let v = try vector(name)
            XCTAssertEqual(v["expect"]!["reason"]?.stringValue, "content_malformed", name)
            let envelope = try Envelope.seal(v["input"]!, alg: "Ed25519", kid: pin.id, sign: try ed25519Signer(seedHex: web["seed"]!.stringValue!))
            let view = Display.view(envelope.json, pinned: [pin], open: try openerOf(v["given"]!["box"]!), sealedSeen: [])
            XCTAssertFalse(view.shown, name)
            XCTAssertEqual(view.reason, "malformed", name)
            XCTAssertEqual(view.seal, .unread, name)
            XCTAssertNil(view.display, name)
        }
    }

    /// L-3: every reader says `.unread` past the signature with no way to open, and `.clear` for what is not verified or not in shape.
    func testWhatMarksANodeThroughTheReaders() throws {
        let k = try keys()
        let web = k["nodes"]!["web-01"]!
        let pin = NodePin(id: web["id"]!.stringValue!, name: "web-01", key: web["spki"]!.stringValue!)
        func marks(_ state: SealState) -> Bool { Seal.noteSealedSeen([], nodeId: pin.id, state: state) == [pin.id] }
        var leaseDir = Self.dir
        leaseDir.deleteLastPathComponent()
        leaseDir.appendPathComponent("lease-v1")
        func leaseVector(_ name: String) throws -> JSONValue { try JSONParser.parse(try Data(contentsOf: leaseDir.appendingPathComponent("\(name).json"))) }
        let request = try vector("request-sealed-display")["input"]!

        XCTAssertEqual(Display.view(request, pinned: [pin], sealedSeen: []).seal, .unread)
        XCTAssertTrue(marks(QuestionItem(message: try Envelope(json: try vector("question-ask-sealed")["input"]!).message(), nodeName: "web-01", sealedSeen: [])!.seal))
        XCTAssertTrue(marks(LeaseRequest.check(try Envelope(json: try leaseVector("request-sealed")["input"]!).message(), sealedSeen: []).seal))
        XCTAssertTrue(marks(LeaseStatus(message: try Envelope(json: try leaseVector("status-sealed")["input"]!).message())!.seal))
        XCTAssertTrue(marks(Leases.verifyView(try Envelope(json: try leaseVector("view-sealed")["input"]!), pin: pin).view!.seal))
        let wrongBox = Seal.opener(recipientId: "d-aaaaaaaaaaaaaaaa", agree: try softwareAgree(text: k["devices"]!["A_box"]!["d"]!.stringValue!))
        XCTAssertTrue(marks(Display.view(request, pinned: [pin], open: wrongBox, sealedSeen: []).seal))

        // Unverified, unpinned, or misshapen: nothing.
        let other = NodePin(id: pin.id, name: "web-01", key: k["nodes"]!["gpu-box"]!["spki"]!.stringValue!)
        XCTAssertFalse(marks(Display.view(request, pinned: [other], sealedSeen: []).seal))
        XCTAssertFalse(marks(Display.view(request, pinned: [], sealedSeen: []).seal))
        let noBox = withField(try Envelope(json: request).message(), "node_box", nil)
        let signed = try Envelope.seal(noBox, alg: "Ed25519", kid: pin.id, sign: try ed25519Signer(seedHex: web["seed"]!.stringValue!))
        XCTAssertFalse(marks(Display.view(signed.json, pinned: [pin], sealedSeen: []).seal))
        // A clear message from a node never marks it.
        let clear = try vector("request-valid")
        XCTAssertFalse(marks(Display.view(clear["input"]!, pinned: pins(clear), sealedSeen: []).seal))
    }

    /// The pad: every sealer's length is a whole number of 256-byte blocks; an opener takes only spaces, and strips them.
    func testThePad() throws {
        let k = try keys()
        let a = (id: k["devices"]!["A"]!["id"]!.stringValue!, key: k["devices"]!["A_box"]!["jwk"]!)
        let agree = try softwareAgree(text: k["devices"]!["A_box"]!["d"]!.stringValue!)
        let v = try vector("seal-open")
        let full = v["expect"]!["message"]!
        let (clear, content) = try Seal.split(type: requestType, full: full)
        let sender = full["node_id"]!.stringValue!
        func sealedWith(_ fields: JSONValue) throws -> JSONValue {
            try handSealed(type: requestType, clear: clear, senderId: sender, plaintext: JCS.data(fields), recipient: a)
        }
        func open(_ message: JSONValue) throws -> JSONValue {
            try Seal.open(type: requestType, message: message, recipientId: a.id, agree: agree)
        }

        XCTAssertEqual(try open(try sealedWith(content)), full)
        for n in [0, 1, 255, 1000] {
            let opened = try open(try sealedWith(withField(content, "pad", .string(String(repeating: " ", count: n)))))
            XCTAssertEqual(opened, full)
            XCTAssertNil(opened["pad"])
        }
        let bad: [JSONValue] = [.string("x"), .string(" x "), .string("\t"), .string("\n"), .string("\u{a0}"), .string("\u{3000}"), .string(" \u{301}"), .number("1"), .null, .bool(true), .array([.string(" ")]), .object(["a": .string(" ")])]
        for pad in bad {
            let message = try sealedWith(withField(content, "pad", pad))
            XCTAssertEqual(reasonOf { try open(message) }, "content_malformed", "\(pad)")
        }
        // Every other key is refused as it always was, a pad or no pad beside it.
        for key in ["padding", "Pad", "PAD", "pad ", "node_name", "extra"] {
            let message = try sealedWith(withField(withField(content, "pad", .string("")), key, .string(" ")))
            XCTAssertEqual(reasonOf { try open(message) }, "content_malformed", key)
        }
        // Pad bytes outside JCS order are refused too.
        var outOfOrder = JCS.data(content)
        outOfOrder.removeLast()
        outOfOrder.append(Data(",\"pad\":\" \"}".utf8))
        let misplaced = try handSealed(type: requestType, clear: clear, senderId: sender, plaintext: outOfOrder, recipient: a)
        XCTAssertEqual(reasonOf { try open(misplaced) }, "content_malformed")

        // A sender cannot pass its own; two answers of different lengths seal to one length.
        let answerFull = try vector("question-answer-sealed")["expect"]!["message"]!
        let device = answerFull["device_id"]!.stringValue!
        let node = k["nodes"]!["web-01"]!
        let nodeTo = (id: node["id"]!.stringValue!, key: node["box"]!["jwk"]!)
        let (answerClear, answerContent) = try Seal.split(type: "kl.question.answer", full: answerFull)
        XCTAssertEqual(reasonOf { try Seal.seal(type: "kl.question.answer", senderId: device, clear: answerClear, content: withField(answerContent, "pad", .string(" ")), recipient: nodeTo) }, "malformed")
        func ctOf(_ answer: JSONValue) throws -> Int {
            let sealed = try Seal.seal(type: "kl.question.answer", senderId: device, clear: answerClear, content: withField(answerContent, "answer", answer), recipient: nodeTo)
            return try Base64URL.decode(sealed["sealed"]!["ct"]!.stringValue!).count
        }
        XCTAssertEqual(try ctOf(.object(["option_id": .string("approve")])), try ctOf(.object(["option_id": .string("refuse")])))
        XCTAssertEqual(try ctOf(.object(["option_id": .string("approve")])), 256 + 16)
        var longest = 0
        for n in 0..<520 {
            let text = String(repeating: "\u{20ac}", count: n % 3) + String(repeating: "x", count: n)
            let size = try ctOf(.object(["text": .string(text)])) - 16
            XCTAssertEqual(size % 256, 0)
            longest = max(longest, size)
        }
        XCTAssertGreaterThanOrEqual(longest, 512)
        // Every sealed vector a sealer built is padded.
        XCTAssertEqual((try Base64URL.decode(v["input"]!["sealed"]!["ct"]!.stringValue!).count - 16) % 256, 0)
    }

    /// R-SP-2 on the screen: the vector's bytes signed by the pinned node, opened, and its hash does
    /// not hold. Nothing shows, and nothing is there to answer.
    func testAHashMismatchOnTheScreen() throws {
        let web = try keys()["nodes"]!["web-01"]!
        let pin = NodePin(id: web["id"]!.stringValue!, name: "web-01", key: web["spki"]!.stringValue!)
        let v = try vector("seal-hash-mismatch")
        XCTAssertEqual(v["expect"]!["reason"]?.stringValue, "action_hash_mismatch")
        let envelope = try Envelope.seal(v["input"]!, alg: "Ed25519", kid: pin.id, sign: try ed25519Signer(seedHex: web["seed"]!.stringValue!))
        let view = Display.view(envelope.json, pinned: [pin], open: try openerOf(v["given"]!["box"]!), sealedSeen: [])
        XCTAssertFalse(view.shown)
        XCTAssertEqual(view.reason, "action_hash_mismatch")
        XCTAssertNil(view.display)
        XCTAssertNil(view.opened)
    }

    /// A locked key: its own reason and no decision. Its signature held, so it marks the node as any sealed message does.
    func testALockedKeyOnTheScreen() throws {
        let v = try vector("request-sealed-display")
        let view = Display.view(v["input"]!, pinned: pins(v), open: lockedOpener(v["given"]!["box"]!["device_id"]!.stringValue!), sealedSeen: [])
        XCTAssertFalse(view.shown)
        XCTAssertEqual(view.reason, "key_locked")
        XCTAssertEqual(Seal.keyLocked, "key_locked")
        XCTAssertNil(view.display)
        XCTAssertEqual(view.seal, .unread)
        XCTAssertEqual(Seal.noteSealedSeen([], nodeId: "kl-aaaaaaaaaaaaaaaa", state: view.seal), ["kl-aaaaaaaaaaaaaaaa"])
    }

    /// R-SP-15: once a node was seen sealing, its clear request is unreadable and offers no decision.
    func testAClearRequestAfterSealedIsUnreadable() throws {
        let clear = try vector("request-valid")
        let pinned = pins(clear)
        let nodeId = pinned[0].id
        XCTAssertEqual(Seal.clearAfterSealed, "clear_after_sealed")
        let refused = Display.view(clear["input"]!, pinned: pinned, sealedSeen: [nodeId])
        XCTAssertFalse(refused.shown)
        XCTAssertEqual(refused.reason, "clear_after_sealed")
        XCTAssertNil(refused.display)
        // Not this node, or none seen sealing: byte for byte what it was.
        XCTAssertEqual(Display.view(clear["input"]!, pinned: pinned, sealedSeen: ["kl-aaaaaaaaaaaaaaaa"]).json, clear["expect"])
        XCTAssertEqual(Display.view(clear["input"]!, pinned: pinned, sealedSeen: []).json, clear["expect"])
        XCTAssertEqual(Display.view(clear["input"]!, pinned: pinned, sealedSeen: []).seal, .clear)
        // The signature and the pin still come first: nothing unverified earns the words.
        XCTAssertEqual(Display.view(clear["input"]!, pinned: [], sealedSeen: [nodeId]).reason, "unpinned_node")
        let bad = try vector("request-bad-node-signature")
        let badPins = pins(bad)
        XCTAssertEqual(Display.view(bad["input"]!, pinned: badPins, sealedSeen: Set(badPins.map { $0.id })).reason, "bad_node_signature")
        // A sealed one goes on being shown.
        let sealed = try vector("request-sealed-display")
        let sealedPins = pins(sealed)
        XCTAssertTrue(Display.view(sealed["input"]!, pinned: sealedPins, open: try openerOf(sealed["given"]!["box"]!), sealedSeen: Set(sealedPins.map { $0.id })).shown)
    }

    /// The rule for one node: what opened sealed marks it, for good; nothing else does; types not listed are not held to it.
    func testTheSealedSeenRule() {
        let node = "kl-aaaaaaaaaaaaaaaa"
        let other = "kl-bbbbbbbbbbbbbbbb"
        var seen = Set<String>()
        seen = Seal.noteSealedSeen(seen, nodeId: node, state: .clear)
        XCTAssertEqual(seen, [])
        XCTAssertEqual(Seal.noteSealedSeen(seen, nodeId: node, state: .unread), [node])
        XCTAssertEqual(seen, [])
        seen = Seal.noteSealedSeen(seen, nodeId: node, state: .opened)
        XCTAssertEqual(seen, [node])
        seen = Seal.noteSealedSeen(seen, nodeId: node, state: .clear)
        XCTAssertEqual(seen, [node])
        XCTAssertFalse(seen.contains(other))

        let clearAsk: JSONValue = .object(["type": .string("kl.question.ask"), "node_id": .string(node)])
        for type in ["kl.question.ask", "kl.approval.request", "kl.lease.request"] {
            XCTAssertTrue(Seal.clearRefused(type: type, message: clearAsk, sealedSeen: [node]), type)
            XCTAssertFalse(Seal.clearRefused(type: type, message: clearAsk, sealedSeen: [other]), type)
            XCTAssertFalse(Seal.clearRefused(type: type, message: clearAsk, sealedSeen: []), type)
            XCTAssertFalse(Seal.clearRefused(type: type, message: withField(clearAsk, "sealed", .null), sealedSeen: [node]), type)
        }
        for type in ["kl.lease.status", "kl.lease.view", "kl.approval.status", "kl.lease.listing"] {
            XCTAssertFalse(Seal.clearRefused(type: type, message: clearAsk, sealedSeen: [node]), type)
        }
    }

    // MARK: the box key (R-SP-10)

    func testBoxKeyFingerprint() throws {
        let devices = try keys()["devices"]!
        for name in ["A_box", "B_box"] {
            let k = devices[name]!
            XCTAssertEqual(try Messages.boxKeyFingerprint(k["jwk"]!), k["fingerprint"]!.stringValue, name)
            XCTAssertEqual(try Messages.boxKeyFingerprint(x: k["jwk"]!["x"]!.stringValue!, y: k["jwk"]!["y"]!.stringValue!), k["fingerprint"]!.stringValue, name)
        }
        let jwk = devices["A_box"]!["jwk"]!
        XCTAssertThrowsError(try Messages.boxKeyFingerprint(Messages.jwk(x: jwk["x"]!.stringValue!, y: try offCurve(jwk["y"]!.stringValue!))))
    }

    func testConsoleEnrollWithBoxKey() throws {
        let v = try vector("enroll-console-box-key")
        let envelope = try Envelope(json: v["input"]!)
        let sent = try envelope.message()
        let d = sent["device"]!
        let boxKey = v["expect"]!["box_key"]!
        let device = try Messages.device(deviceId: d["device_id"]!.stringValue!, name: d["name"]!.stringValue!, platform: d["platform"]!.stringValue!,
                                         x: d["public_key"]!["x"]!.stringValue!, y: d["public_key"]!["y"]!.stringValue!, boxKey: boxKey)
        XCTAssertEqual(device, d)
        let rebuilt = try Messages.consoleEnroll(device: device, codeId: v["given"]!["code_id"]!.stringValue!, code: v["given"]!["code"]!.stringValue!,
                                                 createdAt: sent["created_at"]!.stringValue!, expiresAt: sent["expires_at"]!.stringValue!, nonce: sent["nonce"]!.stringValue!)
        XCTAssertEqual(Base64URL.encode(JCS.data(rebuilt)), v["input"]!["payload"]!.stringValue)
        let a = try keys()["devices"]!["A"]!
        let x = a["jwk"]!["x"]!.stringValue!
        let y = a["jwk"]!["y"]!.stringValue!
        XCTAssertTrue(envelope.verifyES256(x: x, y: y))

        // The device id still derives from the device key; without a box key the object is as it was.
        let id = a["id"]!.stringValue!
        XCTAssertEqual(Set(try Messages.device(deviceId: id, name: "Phone", platform: "ios", x: x, y: y).objectValue!.keys), Set(["device_id", "name", "platform", "public_key"]))
        // No key is another: the box key is not the device key, and it is on the curve.
        XCTAssertThrowsError(try Messages.device(deviceId: id, name: "Phone", platform: "ios", x: x, y: y, boxKey: Messages.jwk(x: x, y: y)))
        let bad = Messages.jwk(x: boxKey["x"]!.stringValue!, y: try offCurve(boxKey["y"]!.stringValue!))
        XCTAssertThrowsError(try Messages.device(deviceId: id, name: "Phone", platform: "ios", x: x, y: y, boxKey: bad))
    }

    func testBoxKeyStatement() throws {
        let v = try vector("box-key-valid")
        let envelope = try Envelope(json: v["input"]![0]!)
        let sent = try envelope.message()
        let boxKey = v["expect"]!["staged_box_keys"]![0]!
        let id = sent["device_id"]!.stringValue!
        let nonce = sent["nonce"]!.stringValue!
        let built = try Messages.boxKeyStatement(deviceId: id, boxKey: boxKey, createdAt: sent["created_at"]!.stringValue!, expiresAt: sent["expires_at"]!.stringValue!, nonce: nonce)
        XCTAssertEqual(built, sent)
        XCTAssertEqual(JCS.data(built), try envelope.payloadData())
        XCTAssertNil(Messages.validate("kl.device.box_key", built))
        let a = try keys()["devices"]!["A"]!
        XCTAssertEqual(envelope.kid, a["id"]!.stringValue)
        XCTAssertTrue(envelope.verifyES256(x: a["jwk"]!["x"]!.stringValue!, y: a["jwk"]!["y"]!.stringValue!))

        let created = "2026-09-23T18:04:11.201Z"
        XCTAssertNoThrow(try Messages.boxKeyStatement(deviceId: id, boxKey: boxKey, createdAt: created, expiresAt: "2026-09-30T18:04:11.201Z", nonce: nonce))
        XCTAssertThrowsError(try Messages.boxKeyStatement(deviceId: id, boxKey: boxKey, createdAt: created, expiresAt: "2026-09-30T18:04:11.202Z", nonce: nonce))
        XCTAssertThrowsError(try Messages.boxKeyStatement(deviceId: id, boxKey: boxKey, createdAt: created, expiresAt: created, nonce: nonce))
        XCTAssertThrowsError(try Messages.boxKeyStatement(deviceId: "d-not-a-device", boxKey: boxKey, createdAt: created, expiresAt: "2026-09-24T18:04:11.201Z", nonce: nonce))
        XCTAssertThrowsError(try Messages.boxKeyStatement(deviceId: id, boxKey: .object([:]), createdAt: created, expiresAt: "2026-09-24T18:04:11.201Z", nonce: nonce))
        XCTAssertEqual(Messages.validate("kl.device.box_key", withField(built, "extra", .null)), "malformed")
        XCTAssertEqual(Messages.validate("kl.device.box_key", withField(built, "v", .number("2"))), "unsupported_version")
    }

    // MARK: questions (R-SP-4)

    func testASealedAsk() throws {
        let v = try vector("question-ask-sealed")
        let envelope = try Envelope(json: v["input"]!)
        XCTAssertTrue(envelope.verifyEd25519(spkiHex: v["given"]!["node_public_key"]!.stringValue!))
        let message = try envelope.message()
        for key in ["case_id", "question_id", "case_title", "text", "options"] { XCTAssertNil(message[key], key) }
        let box = v["given"]!["box"]!
        let device = box["device_id"]!.stringValue!
        let expect = v["expect"]!["message"]!
        XCTAssertEqual(try Seal.open(type: "kl.question.ask", message: message, recipientId: device, agree: try softwareAgree(text: box["d"]!.stringValue!)), expect)

        let item = try XCTUnwrap(QuestionItem(message: message, nodeName: "web-01", open: try openerOf(box), sealedSeen: []))
        XCTAssertEqual(item.text, expect["text"]!.stringValue)
        XCTAssertEqual(item.caseId, expect["case_id"]!.stringValue)
        XCTAssertEqual(item.questionId, expect["question_id"]!.stringValue)
        XCTAssertEqual(item.caseTitle, expect["case_title"]!.stringValue)
        XCTAssertEqual(item.options, [QuestionOption(id: "a", label: "Yes"), QuestionOption(id: "b", label: "No")])
        XCTAssertEqual(item.nodeBox, expect["node_box"])
        XCTAssertEqual(item.seal, .opened)
        XCTAssertNil(item.unreadable)

        // Not this phone's to open: the clear facts and no question.
        let unread = try XCTUnwrap(QuestionItem(message: message, nodeName: "web-01", sealedSeen: []))
        XCTAssertEqual(unread.unreadable, "not_recipient")
        XCTAssertEqual(unread.seal, .unread)
        XCTAssertEqual(unread.nodeName, "web-01")
        XCTAssertEqual(unread.kind, "question")
        XCTAssertEqual(unread.urgency, "high")
        XCTAssertEqual(unread.text, "")
        XCTAssertEqual(unread.options, [])
        let bBox = try keys()["devices"]!["B_box"]!["d"]!.stringValue!
        let wrong = try XCTUnwrap(QuestionItem(message: message, nodeName: "web-01", open: Seal.opener(recipientId: device, agree: try softwareAgree(text: bBox)), sealedSeen: []))
        XCTAssertEqual(wrong.unreadable, "open_failed")
        // A locked key: its own reason, no question, and it does not mark the node.
        let locked = try XCTUnwrap(QuestionItem(message: message, nodeName: "web-01", open: lockedOpener(device), sealedSeen: []))
        XCTAssertEqual(locked.unreadable, "key_locked")
        XCTAssertEqual(locked.seal, .unread)
        XCTAssertEqual(locked.text, "")
        XCTAssertThrowsError(try Questions.answer(to: locked, optionId: "a", text: nil, deviceId: device, nonce: String(repeating: "n", count: 43), signedAt: "2026-09-23T18:04:11.201Z"))
        // Nothing can be answered from it.
        XCTAssertThrowsError(try Questions.answer(to: unread, optionId: "a", text: nil, deviceId: device, nonce: String(repeating: "n", count: 43), signedAt: "2026-09-23T18:04:11.201Z"))
        // A message claiming to be sealed in another shape is not read at all.
        XCTAssertNil(QuestionItem(message: withField(message, "node_box", nil), nodeName: "web-01", open: try openerOf(box), sealedSeen: []))
        // Content that is no such content: no question.
        XCTAssertNil(QuestionItem(message: message, nodeName: "web-01", open: contentMalformedOpener, sealedSeen: []))
    }

    /// The node's own rules for a sealed ask: the clear part before the open, the content after it.
    func testASealedAskIsHeldToTheNodesRules() throws {
        let v = try vector("question-ask-sealed")
        let box = v["given"]!["box"]!
        let full = v["expect"]!["message"]!
        let k = try keys()
        let device = k["devices"]!["A"]!["id"]!.stringValue!
        let boxKey = k["devices"]!["A_box"]!["jwk"]!
        func item(_ changed: JSONValue) throws -> QuestionItem? {
            let parts = try Seal.split(type: "kl.question.ask", full: changed)
            let sealed = try Seal.seal(type: "kl.question.ask", senderId: changed["node_id"]!.stringValue!, clear: parts.clear, content: parts.content, recipient: (id: device, key: boxKey))
            return QuestionItem(message: sealed, nodeName: "web-01", open: try openerOf(box), sealedSeen: [])
        }
        XCTAssertNotNil(try item(full))
        // The clear part.
        XCTAssertNil(try item(withField(full, "v", .number("2"))))
        for token in ["7qd4km", "7QD4K", "7QD4KMM", "7QD4KI", "7QD4KL", "7QD4KO", "7QD4KU", "7QD4K\u{0301}"] {
            XCTAssertNil(try item(withField(full, "token", .string(token))), token)
        }
        XCTAssertNil(try item(withField(full, "expires_at", .string("soon"))))
        // The content.
        for caseId in ["", "a b", "a/b", String(repeating: "a", count: 81)] {
            XCTAssertNil(try item(withField(full, "case_id", .string(caseId))), caseId)
        }
        for questionId in ["q-123", "x-0012", "q-001a", "q0012"] {
            XCTAssertNil(try item(withField(full, "question_id", .string(questionId))), questionId)
        }
        XCTAssertNil(try item(withField(full, "case_title", .null)))
        XCTAssertNil(try item(withField(full, "options", .null)))
        XCTAssertNil(try item(withField(full, "text", .number("1"))))
        XCTAssertNotNil(try item(withField(full, "question_id", .string("q-12345"))))
    }

    /// The whole answer of given.ask and given.answer, sealed to the ask's node_box without the caller asking for it.
    func testASealedAnswer() throws {
        let ask = try vector("question-ask-sealed")
        let item = try XCTUnwrap(QuestionItem(message: try Envelope(json: ask["input"]!).message(), nodeName: "web-01", open: try openerOf(ask["given"]!["box"]!), sealedSeen: []))
        let v = try vector("question-answer-sealed")
        let g = v["given"]!
        let device = g["device"]!["device_id"]!.stringValue!
        let nonce = g["nonce"]!.stringValue!
        let signedAt = g["signed_at"]!.stringValue!
        let nodeId = g["box"]!["node_id"]!.stringValue!
        let built = try Questions.answer(to: item, optionId: g["answer"]!["option_id"]?.stringValue, text: nil, deviceId: device, nonce: nonce, signedAt: signedAt)
        XCTAssertTrue(Seal.isSealedShape(type: "kl.question.answer", message: built))
        for key in ["case_id", "question_id", "answer"] { XCTAssertNil(built[key], key) }
        XCTAssertEqual(Set(built["sealed"]!["keys"]!.objectValue!.keys), Set([nodeId]))
        let sent = try Envelope(json: v["input"]!).message()
        XCTAssertEqual(withField(built, "sealed", nil), withField(sent, "sealed", nil))
        let agree = try softwareAgree(text: g["box"]!["d"]!.stringValue!)
        XCTAssertEqual(try Seal.open(type: "kl.question.answer", message: built, recipientId: nodeId, agree: agree), v["expect"]!["message"])

        // A sealed ask is never answered in clear, nor sealed to any box but its own.
        XCTAssertThrowsError(try Questions.answer(to: item, optionId: "a", text: nil, deviceId: device, nonce: nonce, signedAt: signedAt, sealTo: nil))
        XCTAssertThrowsError(try Questions.answer(to: item, optionId: "a", text: nil, deviceId: device, nonce: nonce, signedAt: signedAt, sealTo: freshBox().jwk))
        XCTAssertNoThrow(try Questions.answer(to: item, optionId: "a", text: nil, deviceId: device, nonce: nonce, signedAt: signedAt, sealTo: item.nodeBox))
    }
}
