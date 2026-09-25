import Foundation

/// RFC 8785 serialization of a JSONValue: keys sorted by UTF-16 code units,
/// no whitespace, strings escaped exactly as ECMAScript's JSON.stringify does.
/// Numbers are written as received (a phone only ever canonicalizes messages
/// whose numbers are integers, and signed payloads are already canonical);
/// `esNumber` says whether a received lexeme is the ECMAScript form, which is
/// what the canonical-bytes check on received envelopes uses.
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
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    public static func escape(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        out.append("\"")
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out.append(contentsOf: "\\\"".unicodeScalars)
            case 0x5C: out.append(contentsOf: "\\\\".unicodeScalars)
            case 0x08: out.append(contentsOf: "\\b".unicodeScalars)
            case 0x0C: out.append(contentsOf: "\\f".unicodeScalars)
            case 0x0A: out.append(contentsOf: "\\n".unicodeScalars)
            case 0x0D: out.append(contentsOf: "\\r".unicodeScalars)
            case 0x09: out.append(contentsOf: "\\t".unicodeScalars)
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out.append(contentsOf: ("\\u" + String(repeating: "0", count: 4 - hex.count) + hex).unicodeScalars)
            default: out.append(scalar)
            }
        }
        out.append("\"")
        return String(out)
    }

    /// The ECMAScript Number::toString form of a JSON number lexeme (what
    /// JSON.stringify and so RFC 8785 write), or nil when it is not finite.
    /// A received number is canonical exactly when this returns the lexeme.
    public static func esNumber(_ lexeme: String) -> String? {
        guard let d = Double(lexeme), d.isFinite else { return nil }
        if d == 0 { return "0" }
        // Swift's description is the shortest round-trip digit string, the
        // same digits ECMAScript picks; only the layout differs.
        let text = "\(d.magnitude)"
        var mantissa = Substring(text)
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = text[..<e]
            guard let x = Int(text[text.index(after: e)...]) else { return nil }
            exponent = x
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        var digits = Array(intPart + fraction)
        var n = intPart.count + exponent
        while let first = digits.first, first == "0" { digits.removeFirst(); n -= 1 }
        while let last = digits.last, last == "0" { digits.removeLast() }
        guard !digits.isEmpty else { return "0" }
        let k = digits.count
        let body: String
        if k <= n && n <= 21 {
            body = String(digits) + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            body = String(digits[0..<n]) + "." + String(digits[n...])
        } else if -6 < n && n <= 0 {
            body = "0." + String(repeating: "0", count: -n) + String(digits)
        } else {
            let e = n - 1
            body = String(digits[0]) + (k > 1 ? "." + String(digits[1...]) : "") + "e" + (e < 0 ? "-" : "+") + String(abs(e))
        }
        return (d < 0 ? "-" : "") + body
    }

    /// Every number inside `value` is written in its ECMAScript form.
    public static func numbersAreCanonical(_ value: JSONValue) -> Bool {
        switch value {
        case .number(let n): return esNumber(n).map { ExactText.same($0, n) } ?? false
        case .array(let a): return a.allSatisfy(numbersAreCanonical)
        case .object(let o): return o.values.allSatisfy(numbersAreCanonical)
        default: return true
        }
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
