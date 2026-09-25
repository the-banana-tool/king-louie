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
/// displays (docs/protocol/approval-v1.md §5, vectors `request-*`).
public struct PhoneView: Equatable {
    public let shown: Bool
    public let reason: String?
    public let display: JSONValue?

    public var json: JSONValue {
        .object(["shown": .bool(shown), "reason": reason.map { .string($0) } ?? .null, "display": display ?? .null])
    }
}

/// The phone rules of approval-v1 §5, written to match
/// tests/vectors/approval-v1/phone-reference.js line for line.
public enum Display {
    public static let collapseOver = 2000
    public static let head = 1200
    public static let tail = 400
    static let commandKeys = ["command", "script", "argv"]

    /// The EXACT code-point list of approval-v1 §5 (not a Unicode-property
    /// lookup, which drifts between platform Unicode versions): Cc, Zl/Zp,
    /// Bidi_Control, and Default_Ignorable_Code_Point as of Unicode 15.1.
    public static func isHidden(_ v: UInt32) -> Bool {
        // Cc
        if v <= 0x1F || v == 0x7F || (0x80...0x9F).contains(v) { return true }
        // Zl, Zp
        if v == 0x2028 || v == 0x2029 { return true }
        // Bidi_Control
        if v == 0x061C || (0x200E...0x200F).contains(v) || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) { return true }
        // Default_Ignorable_Code_Point (Unicode 15.1)
        return v == 0x00AD || v == 0x034F || (0x115F...0x1160).contains(v) || (0x17B4...0x17B5).contains(v)
            || (0x180B...0x180F).contains(v) || (0x200B...0x200F).contains(v) || (0x2060...0x206F).contains(v)
            || v == 0x3164 || (0xFE00...0xFE0F).contains(v) || v == 0xFEFF || v == 0xFFA0
            || (0xFFF0...0xFFF8).contains(v) || (0x1BCA0...0x1BCA3).contains(v) || (0x1D173...0x1D17A).contains(v)
            || (0xE0000...0xE0FFF).contains(v)
    }

    /// Every hidden code point becomes ‹U+XXXX› (uppercase hex, at least four digits).
    public static func escape(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if isHidden(scalar.value) {
                let hex = String(scalar.value, radix: 16, uppercase: true)
                out.append(contentsOf: ("\u{2039}U+" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex + "\u{203A}").unicodeScalars)
            } else {
                out.append(scalar)
            }
        }
        return String(out)
    }

    // MARK: paths

    /// A key containing '.', '[', ']', '"' or a hidden code point is shown
    /// bracket-quoted so two structures never produce the same path.
    static func keyNeedsQuoting(_ key: String) -> Bool {
        key.unicodeScalars.contains { $0 == "." || $0 == "[" || $0 == "]" || $0 == "\"" || isHidden($0.value) }
    }

    /// The escaped key with '\' and '"' backslash-escaped.
    static func quotedKey(_ key: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in escape(key).unicodeScalars {
            if scalar == "\\" || scalar == "\"" { out.append("\\") }
            out.append(scalar)
        }
        return String(out)
    }

    static func pathSegment(_ parent: String, _ key: String) -> String {
        keyNeedsQuoting(key) ? parent + "[\"" + quotedKey(key) + "\"]" : parent + "." + escape(key)
    }

    // MARK: argv

    /// The EXACT argv whitespace list of approval-v1 §5 (JavaScript's `\s`).
    static func isArgvSpace(_ v: UInt32) -> Bool {
        (0x09...0x0D).contains(v) || v == 0x20 || v == 0xA0 || v == 0x1680 || (0x2000...0x200A).contains(v)
            || v == 0x2028 || v == 0x2029 || v == 0x202F || v == 0x205F || v == 0x3000 || v == 0xFEFF
    }

    static func quoteArgvItem(_ item: String) -> String {
        let needsQuoting = item.unicodeScalars.isEmpty || item.unicodeScalars.contains { $0 == "\"" || isArgvSpace($0.value) }
        guard needsQuoting else { return item }
        var out = String.UnicodeScalarView()
        out.append("\"")
        for scalar in item.unicodeScalars {
            if scalar == "\"" { out.append("\\") }
            out.append(scalar)
        }
        out.append("\"")
        return String(out)
    }

    /// Items joined with spaces; an empty item or one with whitespace or a
    /// quote is quoted, so item boundaries stay visible.
    public static func joinArgv(_ items: [String]) -> String {
        items.map(quoteArgvItem).joined(separator: " ")
    }

    // MARK: items

    static func item(_ path: String, text: String, tail: String?, hidden: Int) -> JSONValue {
        .object(["path": .string(path), "text": .string(text), "tail": tail.map { .string($0) } ?? .null, "hidden": .number(String(hidden))])
    }

    /// Collapse counts Unicode code points, not UTF-16 units.
    static func stringItem(_ path: String, _ value: String, commandLike: Bool, collapse: Bool) -> JSONValue {
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

    /// Every element a string: the array as argv items.
    static func argv(_ values: [JSONValue]) -> [String]? {
        var out: [String] = []
        for v in values {
            guard let s = v.stringValue else { return nil }
            out.append(s)
        }
        return out
    }

    static func flatten(_ value: JSONValue, _ path: String, _ commandLike: Bool, collapse: Bool, into out: inout [JSONValue]) {
        switch value {
        case .string(let s):
            out.append(stringItem(path, s, commandLike: commandLike, collapse: collapse))
        case .number(let n):
            // The payload is JCS, so this is the lexeme the node sent.
            out.append(item(path, text: n, tail: nil, hidden: 0))
        case .bool(let b):
            out.append(item(path, text: b ? "true" : "false", tail: nil, hidden: 0))
        case .null:
            out.append(item(path, text: "null", tail: nil, hidden: 0))
        case .array(let a):
            if a.isEmpty {
                out.append(item(path, text: "[]", tail: nil, hidden: 0))
            } else if commandLike, let items = argv(a) {
                out.append(stringItem(path, joinArgv(items), commandLike: true, collapse: collapse))
            } else {
                for (i, v) in a.enumerated() { flatten(v, "\(path)[\(i)]", commandLike, collapse: collapse, into: &out) }
            }
        case .object(let o):
            if o.isEmpty { out.append(item(path, text: "{}", tail: nil, hidden: 0)) }
            // UTF-16 code-unit order, the same order JCS uses.
            for k in o.keys.sorted(by: JCS.utf16Less) {
                let isCommandKey = commandKeys.contains { ExactText.same($0, k) }
                flatten(o[k]!, pathSegment(path, k), commandLike || isCommandKey, collapse: collapse, into: &out)
            }
        }
    }

    /// What the approval screen shows for a request message. With
    /// `collapse: false` every value is shown whole (the "Show all" view).
    public static func build(_ message: JSONValue, collapse: Bool = true) -> JSONValue {
        let action = message["action"] ?? .null
        var items: [JSONValue] = []
        flatten(action["params"] ?? .object([:]), "params", false, collapse: collapse, into: &items)
        if let steps = action["steps"]?.arrayValue {
            for (i, step) in steps.enumerated() {
                if let stepArray = step.arrayValue, let words = argv(stepArray) {
                    items.append(stringItem("steps[\(i)]", joinArgv(words), commandLike: true, collapse: collapse))
                } else {
                    // `check` steps (and anything that is not an argv of
                    // strings) are shown as their JCS text, never collapsed.
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

    /// Shape first (`malformed`, even from a pinned node), then the pin
    /// (`unpinned_node`: node_id not pinned or kid ≠ node_id), then the
    /// node's signature over the received bytes (`bad_node_signature`).
    /// Pins come from a pairing or invite QR only.
    public static func view(_ envelopeJSON: JSONValue, pinned: [NodePin]) -> PhoneView {
        func hide(_ reason: String) -> PhoneView { PhoneView(shown: false, reason: reason, display: nil) }
        guard let envelope = try? Envelope(json: envelopeJSON), let message = try? envelope.message() else {
            return hide("malformed")
        }
        guard Messages.validate("kl.approval.request", message) == nil, let nodeId = message["node_id"]?.stringValue else {
            return hide("malformed")
        }
        guard let pin = pinned.first(where: { ExactText.same($0.id, nodeId) }), ExactText.same(envelope.kid, nodeId) else {
            return hide("unpinned_node")
        }
        guard envelope.verifyEd25519(spkiHex: pin.key) else {
            return hide("bad_node_signature")
        }
        return PhoneView(shown: true, reason: nil, display: build(message))
    }
}

/// A node-signed kl.approval.status (approval-v1 §3.3) for one request.
public struct ApprovalStatus: Equatable {
    public let state: String
    public let deviceId: String?
    public let reason: String?

    /// The status, or nil unless: the envelope opens strictly, `kid` is the
    /// pinned node, its signature verifies against the pinned key, the
    /// message is a valid kl.approval.status, and it names this request and
    /// this node.
    public static func verify(_ envelopeJSON: JSONValue, requestId: String, pin: NodePin) -> ApprovalStatus? {
        guard let envelope = try? Envelope(json: envelopeJSON), ExactText.same(envelope.kid, pin.id),
              envelope.verifyEd25519(spkiHex: pin.key), let message = try? envelope.message(),
              Messages.validate("kl.approval.status", message) == nil,
              let rid = message["request_id"]?.stringValue, ExactText.same(rid, requestId),
              let nodeId = message["node_id"]?.stringValue, ExactText.same(nodeId, pin.id),
              let state = message["state"]?.stringValue else { return nil }
        return ApprovalStatus(state: state, deviceId: message["device_id"]?.stringValue, reason: message["reason"]?.stringValue)
    }
}

/// History comes as node-signed kl.audit.slice envelopes; the phone checks
/// them in the order of approval-v1 §3.6 (`verifyAuditSlice` in
/// src/audit/audit-ledger.js). The first failure decides the reason.
public enum AuditSlice {
    public static func verify(_ envelopeJSON: JSONValue, nodeKeyHex: String) -> (ok: Bool, reason: String?, entries: [JSONValue]) {
        func fail(_ reason: String) -> (ok: Bool, reason: String?, entries: [JSONValue]) { (false, reason, []) }
        // 1. Signature against the pinned node key. Like the JS verifier,
        // this looks only at alg, payload and sig; the envelope's full shape
        // is step 2, so a correctly signed but misshapen envelope is
        // `malformed`, not `bad_signature`.
        guard let alg = envelopeJSON["alg"]?.stringValue, let payload = envelopeJSON["payload"]?.stringValue,
              let sig = envelopeJSON["sig"]?.stringValue,
              Envelope(alg: alg, kid: "", payload: payload, sig: sig).verifyEd25519(spkiHex: nodeKeyHex) else {
            return fail("bad_signature")
        }
        // 2. Opens (exactly alg, kid, payload, sig; canonical bytes), and is a kl.audit.slice.
        guard let envelope = try? Envelope(json: envelopeJSON), let message = try? envelope.message() else { return fail("malformed") }
        if let reason = Messages.validate("kl.audit.slice", message) { return fail(reason) }
        // 3. kid is the node inside.
        guard let nodeId = message["node_id"]?.stringValue, ExactText.same(envelope.kid, nodeId),
              let entries = message["entries"]?.arrayValue, let head = message["head"], let anchor = message["anchor"],
              let headSeq = head["seq"].flatMap(seqValue), let anchorSeq = anchor["seq"].flatMap(seqValue) else {
            return fail("malformed")
        }
        var previous: (seq: Double, hash: String)? = nil
        for entry in entries {
            // An array has no node_id (foreign_entry); any other non-object is malformed.
            if entry.arrayValue != nil { return fail("foreign_entry") }
            guard var fields = entry.objectValue else { return fail("malformed") }
            // 4. Every entry belongs to this node.
            guard let entryNode = fields["node_id"]?.stringValue, ExactText.same(entryNode, nodeId) else { return fail("foreign_entry") }
            // 5. hash = hex SHA-256 over JCS(entry without hash).
            let hash = fields.removeValue(forKey: "hash")
            guard let hashText = hash?.stringValue, ExactText.same(Digest.sha256Hex(JCS.data(.object(fields))), hashText) else {
                return fail("hash_mismatch")
            }
            guard let seq = entry["seq"].flatMap(seqValue) else { return fail("malformed") }
            // 6. seq increments by one and prev links to the previous hash.
            if let p = previous {
                guard seq == p.seq + 1, entry["prev"] == .string(p.hash) else { return fail("broken_chain") }
            }
            previous = (seq, hashText)
        }
        // 7. The last entry does not read past the slice's own signed head.
        if let last = previous {
            if last.seq > headSeq { return fail("exceeds_head") }
            if last.seq == headSeq && head["hash"] != .string(last.hash) { return fail("head_mismatch") }
        }
        // 8. The first entry does not read before the slice's own signed anchor.
        if let first = entries.first, let firstSeq = first["seq"].flatMap(seqValue), firstSeq < anchorSeq {
            return fail("before_anchor")
        }
        return (true, nil, entries)
    }

    static func seqValue(_ v: JSONValue) -> Double? {
        guard case .number(let n) = v, let d = Double(n), d.isFinite else { return nil }
        return d
    }
}
