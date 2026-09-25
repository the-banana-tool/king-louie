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

    /// Exactly the four members, each a non-empty string.
    public init(json: JSONValue) throws {
        guard let o = json.objectValue, o.count == 4,
              let alg = o["alg"]?.stringValue, let kid = o["kid"]?.stringValue,
              let payload = o["payload"]?.stringValue, let sig = o["sig"]?.stringValue,
              !alg.isEmpty, !kid.isEmpty, !payload.isEmpty, !sig.isEmpty else {
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

    /// Opens the envelope the way a node does (`open` in
    /// src/approvals/envelope.js): `payload` and `sig` are strict base64url,
    /// the payload is UTF-8 JSON, an object, and exactly its own canonical
    /// (JCS) bytes. Anything else is `malformed`.
    public func open() throws -> (message: JSONValue, bytes: Data) {
        let bytes = try payloadData()
        _ = try Base64URL.decode(sig)
        let message: JSONValue
        do {
            message = try JSONParser.parse(bytes)
        } catch {
            throw ProtocolError.malformed("payload is not JSON")
        }
        guard message.objectValue != nil else { throw ProtocolError.malformed("payload is not an object") }
        guard JCS.numbersAreCanonical(message), JCS.data(message) == bytes else {
            throw ProtocolError.malformed("payload is not canonical")
        }
        return (message, bytes)
    }

    /// The payload message, opened strictly (see `open()`).
    public func message() throws -> JSONValue {
        try open().message
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

    /// Phone signature (P-256, raw r||s, never DER) against a device JWK's x
    /// and y, which must be 32 bytes each and a point on the curve.
    public func verifyES256(x: String, y: String) -> Bool {
        guard alg == "ES256", let xb = try? Base64URL.decode(x), let yb = try? Base64URL.decode(y),
              xb.count == 32, yb.count == 32,
              let key = try? P256.Signing.PublicKey(x963Representation: Data([0x04]) + xb + yb),
              let bytes = try? payloadData(), let raw = try? Base64URL.decode(sig), raw.count == 64,
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
        func integer(_ part: Data) -> [UInt8] {
            var bytes = [UInt8](part)
            while bytes.count > 1 && bytes[0] == 0 && bytes[1] < 0x80 { bytes.removeFirst() }
            if bytes[0] >= 0x80 { bytes.insert(0, at: 0) }
            return [0x02, UInt8(bytes.count)] + bytes
        }
        let body = integer(raw.prefix(32)) + integer(raw.suffix(32))
        return Data([0x30, UInt8(body.count)] + body)
    }

    public static func fromDER(_ der: Data) throws -> Data {
        let bytes = [UInt8](der)
        // SEQUENCE { INTEGER r, INTEGER s } with short-form lengths (a P-256
        // signature never needs more) and nothing after it.
        guard bytes.count >= 8, bytes[0] == 0x30, Int(bytes[1]) == bytes.count - 2 else {
            throw ProtocolError.malformed("not a DER signature")
        }
        var i = 2
        func read() throws -> Data {
            guard i + 2 <= bytes.count, bytes[i] == 0x02 else { throw ProtocolError.malformed("expected INTEGER") }
            let len = Int(bytes[i + 1])
            guard len >= 1, len < 0x80, i + 2 + len <= bytes.count else { throw ProtocolError.malformed("bad INTEGER length") }
            var value = Array(bytes[(i + 2)..<(i + 2 + len)])
            i += 2 + len
            while value.count > 32 && value[0] == 0 { value.removeFirst() }
            guard value.count <= 32 else { throw ProtocolError.malformed("integer too long") }
            return Data(repeating: 0, count: 32 - value.count) + Data(value)
        }
        let r = try read()
        let s = try read()
        guard i == bytes.count else { throw ProtocolError.malformed("trailing data") }
        return r + s
    }
}
