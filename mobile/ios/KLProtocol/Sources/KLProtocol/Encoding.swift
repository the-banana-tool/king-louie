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

    static func isAlphabet(_ b: UInt8) -> Bool {
        (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b == 0x2D || b == 0x5F
    }

    /// Strict: the base64url alphabet, no padding, and the one canonical
    /// encoding of the bytes.
    public static func decode(_ text: String) throws -> Data {
        let bytes = Array(text.utf8)
        guard bytes.allSatisfy(isAlphabet), bytes.count % 4 != 1 else {
            throw ProtocolError.malformed("not base64url")
        }
        var b64 = String(decoding: bytes.map { $0 == 0x2D ? 0x2B : ($0 == 0x5F ? 0x2F : $0) }, as: UTF8.self)
        while b64.utf8.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), encode(data) == text else { throw ProtocolError.malformed("non-canonical base64url") }
        return data
    }
}

public enum Hex {
    public static func encode(_ data: Data) -> String {
        var out = ""
        for byte in data {
            let h = String(byte, radix: 16)
            out += h.count == 1 ? "0" + h : h
        }
        return out
    }

    private static func nibble(_ b: UInt8) -> UInt8? {
        switch b {
        case 0x30...0x39: return b - 0x30
        case 0x41...0x46: return b - 0x41 + 10
        case 0x61...0x66: return b - 0x61 + 10
        default: return nil
        }
    }

    /// Strict: an even number of hex digits and nothing else.
    public static func decode(_ text: String) throws -> Data {
        let bytes = Array(text.utf8)
        guard bytes.count % 2 == 0 else { throw ProtocolError.malformed("odd hex") }
        var out = Data(capacity: bytes.count / 2)
        var index = 0
        while index < bytes.count {
            guard let hi = nibble(bytes[index]), let lo = nibble(bytes[index + 1]) else { throw ProtocolError.malformed("bad hex") }
            out.append(hi << 4 | lo)
            index += 2
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

    /// HMAC-SHA256 keyed with the raw bytes of a base64url secret (a console
    /// `code` or an invite `secret`).
    public static func hmacB64url(keyB64url: String, message: Data) throws -> String {
        let key = SymmetricKey(data: try Base64URL.decode(keyB64url))
        return Base64URL.encode(Data(HMAC<SHA256>.authenticationCode(for: message, using: key)))
    }
}

/// Ids and the four-letter groups people compare on two screens.
public enum Identifiers {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")

    /// Lowercase RFC 4648 base32 without padding.
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

    /// prefix + base32(sha256(raw))[0..16]
    public static func deviceId(raw: Data, prefix: String = "d-") -> String {
        prefix + String(base32(Digest.sha256(raw)).prefix(16))
    }

    /// d- + base32(sha256(0x04 || x || y))[0..16]. The coordinates must be
    /// 32 bytes each and a point on P-256 (approval-v1 §2).
    public static func deviceId(x: String, y: String) throws -> String {
        let xb = try Base64URL.decode(x)
        let yb = try Base64URL.decode(y)
        guard xb.count == 32, yb.count == 32 else { throw ProtocolError.malformed("P-256 coordinates are 32 bytes") }
        let point = Data([0x04]) + xb + yb
        guard (try? P256.Signing.PublicKey(x963Representation: point)) != nil else {
            throw ProtocolError.malformed("not a point on P-256")
        }
        return deviceId(raw: point)
    }

    public static func nodeId(ed25519Raw raw: Data) -> String {
        deviceId(raw: raw, prefix: "kl-")
    }

    /// 'd-abcdefghijklmnop' → 'abcd efgh ijkl mnop': everything after the
    /// first '-' (the whole id when there is none), in groups of four.
    public static func fingerprintGroups(_ id: String) -> String {
        let scalars = Array(id.unicodeScalars)
        let start = scalars.firstIndex(of: "-").map { $0 + 1 } ?? 0
        var groups: [String] = []
        var index = start
        while index < scalars.count {
            var group = String.UnicodeScalarView()
            group.append(contentsOf: scalars[index..<min(index + 4, scalars.count)])
            groups.append(String(group))
            index += 4
        }
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

    /// RFC 3339 UTC with milliseconds, e.g. 2026-09-23T18:04:31.201Z.
    public static func string(_ date: Date) -> String {
        formatter.string(from: date)
    }

    /// The moment of a valid approval-v1 timestamp, fractions of 1–3
    /// digits included (".5Z" is 500 ms); nil for anything `isValid` refuses.
    public static func date(_ text: String) -> Date? {
        epochMillis(text).map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }

    /// Milliseconds since 1970 of a valid approval-v1 timestamp (the node's Date.parse).
    public static func epochMillis(_ text: String) -> Int64? {
        guard isValid(text) else { return nil }
        let b = Array(text.utf8)
        func num(_ from: Int, _ count: Int) -> Int64 {
            var v: Int64 = 0
            for k in from..<(from + count) { v = v * 10 + Int64(b[k] - 0x30) }
            return v
        }
        var y = num(0, 4)
        let mo = num(5, 2), d = num(8, 2)
        // Days from civil (proleptic Gregorian), H. Hinnant's algorithm.
        y -= mo <= 2 ? 1 : 0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146097 + doe - 719468
        var ms = ((days * 24 + num(11, 2)) * 60 + num(14, 2)) * 60 + num(17, 2)
        ms *= 1000
        if b.count > 20 {
            let digits = b.count - 21
            var frac = num(20, digits)
            for _ in digits..<3 { frac *= 10 }
            ms += frac
        }
        return ms
    }

    /// The approval-v1 timestamp rule: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`
    /// and a real calendar moment, judged the way the node does (a round
    /// trip through Date.UTC). Date.UTC maps years 0–99 to 1900–1999, so the
    /// node refuses them, and so does this.
    public static func isValid(_ text: String) -> Bool {
        let b = Array(text.utf8)
        func digits(_ from: Int, _ count: Int) -> Int? {
            guard from + count <= b.count else { return nil }
            var v = 0
            for k in from..<(from + count) {
                guard b[k] >= 0x30, b[k] <= 0x39 else { return nil }
                v = v * 10 + Int(b[k] - 0x30)
            }
            return v
        }
        guard b.count >= 20, b.count <= 24,
              let year = digits(0, 4), b[4] == UInt8(ascii: "-"), let month = digits(5, 2), b[7] == UInt8(ascii: "-"),
              let day = digits(8, 2), b[10] == UInt8(ascii: "T"), let hour = digits(11, 2), b[13] == UInt8(ascii: ":"),
              let minute = digits(14, 2), b[16] == UInt8(ascii: ":"), let second = digits(17, 2),
              b[b.count - 1] == UInt8(ascii: "Z") else { return false }
        if b.count > 20 {
            // ".d", ".dd" or ".ddd" between the seconds and the Z.
            guard b.count >= 22, b[19] == UInt8(ascii: "."), digits(20, b.count - 21) != nil else { return false }
        }
        guard year >= 100, (1...12).contains(month), hour <= 23, minute <= 59, second <= 59 else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        return day >= 1 && day <= days
    }
}
