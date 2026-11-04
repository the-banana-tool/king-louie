import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// A seal refused; `reason` is the node's word (src/approvals/seal.js):
/// `malformed`, `not_recipient`, `open_failed`, `content_malformed`.
public struct SealError: Error, Equatable {
    public let reason: String
    public let detail: String

    public init(_ reason: String, _ detail: String = "") {
        self.reason = reason
        self.detail = detail
    }
}

/// The phone's box key will not act now (a locked phone). It is not a wrap that
/// does not open: an `agree` that throws this passes through `Seal.open`, and a
/// reader says `Seal.keyLocked` (`key_locked`), for the app's row to say so.
public struct SealKeyUnavailable: Error, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

/// What opens a sealed message for this phone. A reader calls it only after the
/// node's signature held against the pin: a successful open proves nothing about
/// who sealed it. A wrapper over `Seal.opener` sees only verified messages.
public typealias Opener = (_ type: String, _ message: JSONValue) throws -> JSONValue

/// Telling a box key that stopped working from a phone that is locked, or was just
/// unlocked (sealed phones, Task 10's review; BoxKeyHealth in Seal.kt). Only failures
/// on an unlocked phone count, and only when there are several and they last. A fresh
/// open, or a phone seen locked, starts the count again.
public struct BoxKeyHealth {
    private let strikesToBreak: Int
    private let afterMs: Int64
    private var strikes = 0
    private var failingSinceMs: Int64 = 0

    public private(set) var broken = false

    public init(strikesToBreak: Int = 3, afterMs: Int64 = 30_000) {
        self.strikesToBreak = strikesToBreak
        self.afterMs = afterMs
    }

    public mutating func failedUnlocked(nowMs: Int64) {
        if strikes == 0 { failingSinceMs = nowMs }
        strikes += 1
        if strikes >= strikesToBreak && nowMs - failingSinceMs >= afterMs { broken = true }
    }

    public mutating func opened() { reset() }

    public mutating func locked() { reset() }

    public mutating func reset() {
        strikes = 0
        broken = false
    }
}

/// How a message reached a reader: never sealed, sealed and opened, or sealed and not this phone's to open.
public enum SealState: Equatable {
    case clear
    case opened
    case unread
}

/// The seal (sealed phones plan, R-SP-1, R-SP-2, R-SP-4), written to match
/// src/approvals/seal.js, proven by the `seal-*` vectors.
///
///   sealed = { v: 1, epk, iv, ct, keys }
///   ct     = AES-256-GCM(cek, iv, JCS(content), aad = JCS(clear part)) ‖ tag
///   keys   = { [recipient id]: AES-256-GCM(kek, 12 zero bytes, cek) ‖ tag }
///   kek    = HKDF-SHA256(ECDH(epk, recipient box key), salt = empty,
///                        info = "kl-seal-v1\n<type>\n<sender id>\n<recipient id>")
///
/// The message a validator checks is clear ∪ content; nothing here reads a clear
/// value but the sender id.
public enum Seal {
    private struct Row {
        let content: [String]
        let clear: [String]
    }

    /// R-SP-4, one row per type, so a type cannot have one column and not the other.
    private static let table: [String: Row] = [
        "kl.approval.request": Row(
            content: ["action", "origin", "salt"],
            clear: ["v", "type", "request_id", "node_id", "node_name", "action_hash", "created_at", "expires_at", "nonce", "node_box"]
        ),
        "kl.lease.request": Row(
            content: ["lease", "origin", "salt"],
            clear: ["v", "type", "request_id", "lease_id", "node_id", "node_name", "lease_hash", "created_at", "expires_at", "nonce", "node_box"]
        ),
        "kl.lease.status": Row(
            content: ["name"],
            clear: ["v", "type", "node_id", "lease_id", "seq", "at", "state", "locked", "reason", "expires_at", "contact_token", "granted_by", "kind", "unattended"]
        ),
        "kl.lease.view": Row(
            content: ["foreground", "frame", "frame_dropped", "actions"],
            clear: ["v", "type", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s", "contact_token"]
        ),
        "kl.question.ask": Row(
            content: ["case_id", "question_id", "case_title", "text", "options"],
            clear: ["v", "type", "node_id", "token", "kind", "urgency", "expires_at", "node_box"]
        ),
        "kl.question.answer": Row(
            content: ["case_id", "question_id", "answer"],
            clear: ["v", "type", "node_id", "token", "device_id", "nonce", "signed_at"]
        )
    ]

    /// R-SP-15: a relay can replay an old clear ask or request, signed by the
    /// node, to draw a clear answer. Once this phone has opened a sealed message
    /// from a node, such a message from that node is unreadable with this reason
    /// and offers no decision. Checked after the signature.
    public static let clearAfterSealed = "clear_after_sealed"

    /// What a reader says when the box key would not act (`SealKeyUnavailable`).
    /// The readers do not throw, so this is how a locked phone reaches the row. It
    /// is transient, offers no decision and marks nothing in `sealedSeen`.
    public static let keyLocked = "key_locked"

    private static let heldToSealing = ["kl.question.ask", "kl.approval.request", "kl.lease.request"]

    /// Whether R-SP-15 refuses this message. `sealedSeen`: the nodes this phone has
    /// opened a sealed message from, tested against the message's own `node_id`.
    public static func clearRefused(type: String, message: JSONValue, sealedSeen: Set<String>) -> Bool {
        guard heldToSealing.contains(where: { ExactText.same($0, type) }), message["sealed"] == nil,
              let nodeId = message["node_id"]?.stringValue else { return false }
        return sealedSeen.contains(nodeId)
    }

    /// The nodes seen sealing, after a verified message from `nodeId` was read: only an open adds one, and nothing takes one away.
    public static func noteSealedSeen(_ seen: Set<String>, nodeId: String, state: SealState) -> Set<String> {
        state == .opened ? seen.union([nodeId]) : seen
    }

    private static let keyBytes = 32
    private static let ivBytes = 12
    private static let tagBytes = 16
    private static let wrapBytes = keyBytes + tagBytes
    private static let zeroIv = Data(repeating: 0, count: ivBytes)

    /// Which clear key names the sender, the third line of the info. A phone sends only the answer; a node sends the rest.
    private static func senderKey(_ type: String) -> String {
        ExactText.same(type, "kl.question.answer") ? "device_id" : "node_id"
    }

    private static func byteLength(_ v: JSONValue?) -> Int {
        guard let text = v?.stringValue, let bytes = try? Base64URL.decode(text) else { return -1 }
        return bytes.count
    }

    /// (d|kl)-[a-z2-7]{16}
    private static func isRecipientId(_ id: String) -> Bool {
        let value = JSONValue.string(id)
        return Rules.isDeviceId(value) || Rules.isNodeId(value)
    }

    private static func isSealedObject(_ v: JSONValue?) -> Bool {
        guard let sealed = v?.objectValue, Rules.hasExactKeys(sealed, ["ct", "epk", "iv", "keys", "v"]) else { return false }
        guard sealed["v"] == JSONValue.number("1"), Rules.isDeviceJwk(sealed["epk"]) else { return false }
        guard byteLength(sealed["iv"]) == ivBytes, byteLength(sealed["ct"]) >= tagBytes else { return false }
        guard let keys = sealed["keys"]?.objectValue, !keys.isEmpty else { return false }
        return keys.allSatisfy { isRecipientId($0.key) && byteLength($0.value) == wrapBytes }
    }

    /// Exactly the type's clear keys plus `sealed`, and `sealed` well formed: its epk a point on P-256, checked before any key agreement.
    public static func isSealedShape(type: String, message: JSONValue) -> Bool {
        guard let row = table[type], let m = message.objectValue, let named = m["type"]?.stringValue, ExactText.same(named, type) else { return false }
        return Rules.hasExactKeys(m, row.clear + ["sealed"]) && isSealedObject(m["sealed"])
    }

    /// HKDF-SHA256 for 32 bytes, with an empty salt.
    private static func kekFor(secret: Data, type: String, senderId: String, recipientId: String) -> SymmetricKey {
        let info = Data("kl-seal-v1\n\(type)\n\(senderId)\n\(recipientId)".utf8)
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(), info: info, outputByteCount: keyBytes)
    }

    /// The wire keeps the iv apart and the tag on the ciphertext: `combined` is nonce, ciphertext, tag, in that order.
    private static func gcmOpen(key: SymmetricKey, iv: Data, input: Data, aad: Data?) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: iv + input)
        if let aad {
            return try AES.GCM.open(box, using: key, authenticating: aad)
        }
        return try AES.GCM.open(box, using: key)
    }

    /// Ciphertext and tag, as the wire has them.
    private static func gcmSeal(key: SymmetricKey, iv: Data, input: Data, aad: Data?) throws -> Data {
        let nonce = try AES.GCM.Nonce(data: iv)
        if let aad {
            let box = try AES.GCM.seal(input, using: key, nonce: nonce, authenticating: aad)
            return box.ciphertext + box.tag
        }
        let box = try AES.GCM.seal(input, using: key, nonce: nonce)
        return box.ciphertext + box.tag
    }

    /// Whether every key of `fields` is in the type's content column.
    private static func onlyContentKeys(_ fields: [String: JSONValue], _ row: Row) -> Bool {
        fields.keys.allSatisfy { key in row.content.contains { ExactText.same($0, key) } }
    }

    private static func parseContent(_ row: Row, _ plaintext: Data) throws -> [String: JSONValue] {
        let parsed: JSONValue
        do {
            parsed = try JSONParser.parse(plaintext)
        } catch {
            throw SealError("content_malformed", "not JSON")
        }
        guard let content = parsed.objectValue else { throw SealError("content_malformed", "not an object") }
        // The table's keys and no other: a clear key here could overrule what the relay and the AAD saw.
        guard onlyContentKeys(content, row) else { throw SealError("content_malformed", "holds a key the type does not seal") }
        // The bytes are the JCS of the object, as Envelope.open holds a payload to.
        guard JCS.numbersAreCanonical(parsed), JCS.data(parsed) == plaintext else { throw SealError("content_malformed", "not canonical") }
        return content
    }

    /// The whole message (clear ∪ content) of one sealed to `recipientId`.
    /// `agree` gives the raw x-coordinate of ECDH(epk, this box key), from the
    /// epk's x and y. A successful open is not authentication: anyone can seal to
    /// a public box key and name any sender, so the caller verifies the signed
    /// envelope and its signer first.
    public static func open(type: String, message: JSONValue, recipientId: String, agree: (String, String) throws -> Data) throws -> JSONValue {
        guard isSealedShape(type: type, message: message), let row = table[type], var clear = message.objectValue,
              let sealed = clear.removeValue(forKey: "sealed") else {
            throw SealError("malformed", "not a sealed message of this type")
        }
        guard let wrap = sealed["keys"]?[recipientId]?.stringValue else { throw SealError("not_recipient") }
        let aad = JCS.data(.object(clear))
        guard let senderId = clear[senderKey(type)]?.stringValue else { throw SealError("malformed", "no sender id") }
        let plaintext: Data
        do {
            guard let x = sealed["epk"]?["x"]?.stringValue, let y = sealed["epk"]?["y"]?.stringValue,
                  let ivText = sealed["iv"]?.stringValue, let ctText = sealed["ct"]?.stringValue else {
                throw SealError("open_failed")
            }
            let secret = try agree(x, y)
            guard secret.count == keyBytes else { throw SealError("open_failed") }
            let kek = kekFor(secret: secret, type: type, senderId: senderId, recipientId: recipientId)
            let cek = try gcmOpen(key: kek, iv: zeroIv, input: try Base64URL.decode(wrap), aad: nil)
            plaintext = try gcmOpen(key: SymmetricKey(data: cek), iv: try Base64URL.decode(ivText), input: try Base64URL.decode(ctText), aad: aad)
        } catch let unavailable as SealKeyUnavailable {
            throw unavailable
        } catch {
            // One answer whichever step failed, and no bytes from a step that did.
            throw SealError("open_failed")
        }
        let content = try parseContent(row, plaintext)
        return .object(clear.merging(content) { _, sealedValue in sealedValue })
    }

    /// `open` for one phone's box key.
    public static func opener(recipientId: String, agree: @escaping (String, String) throws -> Data) -> Opener {
        return { type, message in
            try Seal.open(type: type, message: message, recipientId: recipientId, agree: agree)
        }
    }

    /// A fresh key for the epk: its JWK, and ECDH with a recipient's point.
    struct Ephemeral {
        let jwk: JSONValue
        let agree: (String, String) throws -> Data
    }

    private static func newEphemeral() -> Ephemeral {
        let key = P256.KeyAgreement.PrivateKey()
        let point = [UInt8](key.publicKey.x963Representation)
        let jwk = Messages.jwk(x: Base64URL.encode(Data(point[1..<33])), y: Base64URL.encode(Data(point[33..<65])))
        return Ephemeral(jwk: jwk, agree: { x, y in
            let xb = try Base64URL.decode(x)
            let yb = try Base64URL.decode(y)
            let peer = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + xb + yb)
            return try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        })
    }

    private static func randomBytes(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        var bytes = [UInt8](repeating: 0, count: count)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255, using: &generator) }
        return Data(bytes)
    }

    /// What a phone sends sealed, to one recipient: `recipient` is its id and its
    /// box key, a P-256 JWK checked on the curve before use. The result is `clear`
    /// and `sealed`.
    public static func seal(type: String, senderId: String, clear: JSONValue, content: JSONValue, recipient: (id: String, key: JSONValue)) throws -> JSONValue {
        try sealWith(type: type, senderId: senderId, clear: clear, content: content, recipient: recipient, ephemeral: newEphemeral(), random: randomBytes)
    }

    /// `seal` with its key and random bytes given: for vectors only.
    static func sealWith(type: String, senderId: String, clear: JSONValue, content: JSONValue, recipient: (id: String, key: JSONValue),
                         ephemeral: Ephemeral, random: (Int) -> Data) throws -> JSONValue {
        guard let row = table[type] else { throw SealError("malformed", "this type is not sealed") }
        guard let clearFields = clear.objectValue, let contentFields = content.objectValue else { throw SealError("malformed", "clear and content are objects") }
        // The new message would overwrite it, and the AAD would cover what no opener sees.
        guard clearFields["sealed"] == nil else { throw SealError("malformed", "the clear part holds sealed") }
        guard let named = clearFields[senderKey(type)]?.stringValue, ExactText.same(named, senderId) else {
            throw SealError("malformed", "senderId is not the sender the clear part names")
        }
        guard onlyContentKeys(contentFields, row) else { throw SealError("malformed", "content holds a key the type does not seal") }
        guard isRecipientId(recipient.id) else { throw SealError("malformed", "a recipient id is not a device or node id") }
        guard Rules.isDeviceJwk(recipient.key), let x = recipient.key["x"]?.stringValue, let y = recipient.key["y"]?.stringValue else {
            throw SealError("malformed", "a recipient key is not a P-256 point")
        }
        let cek = random(keyBytes)
        let iv = random(ivBytes)
        guard cek.count == keyBytes, iv.count == ivBytes else { throw SealError("malformed", "the random source gave the wrong size") }
        let ct = try gcmSeal(key: SymmetricKey(data: cek), iv: iv, input: JCS.data(content), aad: JCS.data(clear))
        let secret = try ephemeral.agree(x, y)
        guard secret.count == keyBytes else { throw SealError("malformed", "the key agreement gave the wrong size") }
        let kek = kekFor(secret: secret, type: type, senderId: senderId, recipientId: recipient.id)
        let wrap = try gcmSeal(key: kek, iv: zeroIv, input: cek, aad: nil)
        var fields = clearFields
        fields["sealed"] = JSONValue.object([
            "v": .number("1"),
            "epk": ephemeral.jwk,
            "iv": .string(Base64URL.encode(iv)),
            "ct": .string(Base64URL.encode(ct)),
            "keys": .object([recipient.id: .string(Base64URL.encode(wrap))])
        ])
        let message = JSONValue.object(fields)
        // What is built here must be what an opener takes: a clear key missing or extra is refused now.
        guard isSealedShape(type: type, message: message) else { throw SealError("malformed", "the clear part does not fit the type") }
        return message
    }

    /// A whole message split by the table: what stays clear, what is sealed.
    static func split(type: String, full: JSONValue) throws -> (clear: JSONValue, content: JSONValue) {
        guard let row = table[type] else { throw SealError("malformed", "this type is not sealed") }
        guard let fields = full.objectValue, fields["sealed"] == nil else { throw SealError("malformed", "not a full message") }
        var clear: [String: JSONValue] = [:]
        var content: [String: JSONValue] = [:]
        for (key, value) in fields {
            if row.content.contains(where: { ExactText.same($0, key) }) {
                content[key] = value
            } else {
                clear[key] = value
            }
        }
        return (clear: .object(clear), content: .object(content))
    }

    /// R-SP-2: b64url(SHA-256(raw(salt) ‖ JCS(value))).
    public static func saltedHash(salt: String, value: JSONValue) throws -> String {
        guard let raw = try? Base64URL.decode(salt), raw.count == keyBytes else { throw SealError("malformed", "a salt is 32 bytes") }
        return Digest.sha256B64url(raw + JCS.data(value))
    }

    /// How a verified message reads. `reason` when not opened: `not_recipient` (no
    /// opener, or no wrap for this phone), `open_failed` or `key_locked`.
    /// `message` is then the clear part alone.
    struct Read {
        let message: JSONValue
        let state: SealState
        let reason: String?

        var opened: Bool { state != .unread }
    }

    /// nil: sealed in no shape of this type, or it opened to something that is no
    /// such content; a screen says `malformed`. A sealed message with no opener is
    /// never read as if clear. An opener that throws anything else is `open_failed`:
    /// the readers do not throw, and nothing opened.
    static func read(type: String, message: JSONValue, open: Opener?) -> Read? {
        guard var clear = message.objectValue else { return nil }
        guard clear["sealed"] != nil else { return Read(message: message, state: .clear, reason: nil) }
        guard isSealedShape(type: type, message: message) else { return nil }
        clear.removeValue(forKey: "sealed")
        let clearPart = JSONValue.object(clear)
        guard let open else { return Read(message: clearPart, state: .unread, reason: "not_recipient") }
        do {
            let opened = try open(type, message)
            return Read(message: opened, state: .opened, reason: nil)
        } catch let refused as SealError {
            guard refused.reason == "not_recipient" || refused.reason == "open_failed" else { return nil }
            return Read(message: clearPart, state: .unread, reason: refused.reason)
        } catch is SealKeyUnavailable {
            return Read(message: clearPart, state: .unread, reason: keyLocked)
        } catch {
            return Read(message: clearPart, state: .unread, reason: "open_failed")
        }
    }
}
