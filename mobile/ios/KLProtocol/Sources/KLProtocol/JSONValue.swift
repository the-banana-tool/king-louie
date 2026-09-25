import Foundation

/// A JSON value that keeps every number exactly as it was written. Signed
/// payloads are JCS text, so the lexeme a phone received is the canonical
/// one; the approval screen shows it and re-serialization reproduces it.
///
/// Equality compares strings (and object keys) by their exact Unicode scalars,
/// not by Swift's canonical equivalence: "e" + U+0301 never equals "é" here,
/// because the two are different bytes on the wire.
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

    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.number(let a), .number(let b)): return ExactText.same(a, b)
        case (.string(let a), .string(let b)): return ExactText.same(a, b)
        case (.array(let a), .array(let b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0 == $1 }
        case (.object(let a), .object(let b)):
            guard a.count == b.count else { return false }
            let ak = a.keys.sorted(by: JCS.utf16Less)
            let bk = b.keys.sorted(by: JCS.utf16Less)
            guard zip(ak, bk).allSatisfy({ ExactText.same($0, $1) }) else { return false }
            return ak.allSatisfy { a[$0]! == b[$0]! }
        default: return false
        }
    }
}

/// Exact string comparison by Unicode scalars. Swift's `==` on String uses
/// canonical equivalence, which is the wrong question for ids, keys and
/// anything signed.
enum ExactText {
    static func same(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }
}

public enum JSONError: Error, Equatable {
    case invalid(String)
}

/// A strict RFC 8259 parser over UTF-8 bytes: no trailing data, no invalid
/// UTF-8, no lone surrogates, no duplicate keys, numbers kept as their text.
public struct JSONParser {
    /// Deeper nesting is refused rather than risking the stack on input from
    /// the network.
    public static let maxDepth = 512

    private let bytes: [UInt8]
    private var i = 0

    public static func parse(_ data: Data) throws -> JSONValue {
        let bytes = [UInt8](data)
        guard isValidUTF8(bytes) else { throw JSONError.invalid("invalid UTF-8") }
        var parser = JSONParser(bytes: bytes)
        parser.skipWhitespace()
        let value = try parser.parseValue(depth: 0)
        parser.skipWhitespace()
        guard parser.i == parser.bytes.count else { throw JSONError.invalid("trailing data") }
        return value
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    /// Well-formed UTF-8 as Unicode defines it: no overlong forms, no encoded
    /// surrogates, nothing above U+10FFFF.
    static func isValidUTF8(_ bytes: [UInt8]) -> Bool {
        var iterator = bytes.makeIterator()
        var codec = UTF8()
        while true {
            switch codec.decode(&iterator) {
            case .scalarValue: continue
            case .emptyInput: return true
            case .error: return false
            }
        }
    }

    private init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    private mutating func skipWhitespace() {
        while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x09 || bytes[i] == 0x0A || bytes[i] == 0x0D { i += 1 }
    }

    private mutating func expect(_ literal: String) throws {
        for b in literal.utf8 {
            guard i < bytes.count, bytes[i] == b else { throw JSONError.invalid("expected \(literal)") }
            i += 1
        }
    }

    private mutating func parseValue(depth: Int) throws -> JSONValue {
        guard i < bytes.count else { throw JSONError.invalid("unexpected end") }
        switch bytes[i] {
        case UInt8(ascii: "{"): return try parseObject(depth: depth + 1)
        case UInt8(ascii: "["): return try parseArray(depth: depth + 1)
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expect("true"); return .bool(true)
        case UInt8(ascii: "f"): try expect("false"); return .bool(false)
        case UInt8(ascii: "n"): try expect("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    private mutating func parseObject(depth: Int) throws -> JSONValue {
        guard depth <= Self.maxDepth else { throw JSONError.invalid("nested too deeply") }
        i += 1
        var out: [String: JSONValue] = [:]
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
        while true {
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw JSONError.invalid("expected a key") }
            let key = try parseString()
            // A repeated key (or two keys Swift's String treats as equal) is
            // refused: a dictionary would silently keep only one of them.
            guard out[key] == nil else { throw JSONError.invalid("duplicate key") }
            skipWhitespace()
            try expect(":")
            skipWhitespace()
            out[key] = try parseValue(depth: depth)
            skipWhitespace()
            guard i < bytes.count else { throw JSONError.invalid("unterminated object") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(out) }
            throw JSONError.invalid("expected , or }")
        }
    }

    private mutating func parseArray(depth: Int) throws -> JSONValue {
        guard depth <= Self.maxDepth else { throw JSONError.invalid("nested too deeply") }
        i += 1
        var out: [JSONValue] = []
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
        while true {
            skipWhitespace()
            out.append(try parseValue(depth: depth))
            skipWhitespace()
            guard i < bytes.count else { throw JSONError.invalid("unterminated array") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(out) }
            throw JSONError.invalid("expected , or ]")
        }
    }

    private static func hexDigit(_ b: UInt8) -> UInt32? {
        switch b {
        case 0x30...0x39: return UInt32(b - 0x30)
        case 0x41...0x46: return UInt32(b - 0x41 + 10)
        case 0x61...0x66: return UInt32(b - 0x61 + 10)
        default: return nil
        }
    }

    /// Exactly four hex digits (no sign, unlike `UInt32(_:radix:)`).
    private mutating func hex4() throws -> UInt32 {
        guard i + 4 <= bytes.count else { throw JSONError.invalid("bad \\u escape") }
        var v: UInt32 = 0
        for k in 0..<4 {
            guard let d = Self.hexDigit(bytes[i + k]) else { throw JSONError.invalid("bad \\u escape") }
            v = v << 4 | d
        }
        i += 4
        return v
    }

    private mutating func parseString() throws -> String {
        i += 1
        let source = bytes
        var scalars = String.UnicodeScalarView()
        var runStart = i
        func flush(_ end: Int) {
            // The whole input was validated as UTF-8 up front, and a run never
            // splits a multi-byte sequence (it ends only at an ASCII byte).
            if end > runStart { scalars.append(contentsOf: String(decoding: source[runStart..<end], as: UTF8.self).unicodeScalars) }
        }
        while true {
            guard i < bytes.count else { throw JSONError.invalid("unterminated string") }
            let b = bytes[i]
            if b == UInt8(ascii: "\"") { flush(i); i += 1; return String(scalars) }
            if b < 0x20 { throw JSONError.invalid("control character in string") }
            if b != UInt8(ascii: "\\") { i += 1; continue }
            flush(i)
            i += 1
            guard i < bytes.count else { throw JSONError.invalid("bad escape") }
            let e = bytes[i]
            i += 1
            switch e {
            case UInt8(ascii: "\""): scalars.append("\"")
            case UInt8(ascii: "\\"): scalars.append("\\")
            case UInt8(ascii: "/"): scalars.append("/")
            case UInt8(ascii: "b"): scalars.append(Unicode.Scalar(UInt8(0x08)))
            case UInt8(ascii: "f"): scalars.append(Unicode.Scalar(UInt8(0x0C)))
            case UInt8(ascii: "n"): scalars.append(Unicode.Scalar(UInt8(0x0A)))
            case UInt8(ascii: "r"): scalars.append(Unicode.Scalar(UInt8(0x0D)))
            case UInt8(ascii: "t"): scalars.append(Unicode.Scalar(UInt8(0x09)))
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
            runStart = i
        }
    }

    private func isDigit(_ k: Int) -> Bool {
        k < bytes.count && bytes[k] >= 0x30 && bytes[k] <= 0x39
    }

    private mutating func parseNumber() throws -> String {
        let start = i
        if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
        guard isDigit(i) else { throw JSONError.invalid("bad number") }
        if bytes[i] == 0x30 { i += 1 } else { while isDigit(i) { i += 1 } }
        if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
            i += 1
            guard isDigit(i) else { throw JSONError.invalid("bad fraction") }
            while isDigit(i) { i += 1 }
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
            i += 1
            if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
            guard isDigit(i) else { throw JSONError.invalid("bad exponent") }
            while isDigit(i) { i += 1 }
        }
        return String(decoding: bytes[start..<i], as: UTF8.self)
    }
}
