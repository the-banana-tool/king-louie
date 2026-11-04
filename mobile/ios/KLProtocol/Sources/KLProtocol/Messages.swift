import Foundation

/// The messages a phone builds (docs/protocol/approval-v1.md §3). Every one
/// is strings, the integer `v`, and nested objects. Each builder checks its
/// result against the same rules a node applies (`validate`), so the phone
/// never signs something a node would refuse as `malformed`.
public enum Messages {
    public static func randomNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255, using: &generator) }
        return Base64URL.encode(Data(bytes))
    }

    /// A P-256 public key as a JWK.
    public static func jwk(x: String, y: String) -> JSONValue {
        .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(x), "y": .string(y)])
    }

    /// The `device` object of an enrollment. `name` is 1–64 UTF-16 units. With
    /// `boxKey` (sealed phones, R-SP-10) it has a fifth member, `box_key`: a P-256
    /// JWK on the curve whose point is not the device key's. The device id still
    /// derives from the device key (`x`, `y`) alone.
    public static func device(deviceId: String, name: String, platform: String, x: String, y: String, boxKey: JSONValue? = nil) throws -> JSONValue {
        var fields: [String: JSONValue] = [
            "device_id": .string(deviceId),
            "name": .string(name),
            "platform": .string(platform),
            "public_key": jwk(x: x, y: y)
        ]
        if let boxKey { fields["box_key"] = boxKey }
        let device: JSONValue = .object(fields)
        guard Rules.isDevice(device) else { throw ProtocolError.malformed("not a valid device (name is 1–64 UTF-16 units; a box key is a P-256 key other than the device key)") }
        return device
    }

    /// kl.device.box_key (R-SP-10): the device key's statement of its box key, for
    /// a phone enrolled before it. `expiresAt` is after `createdAt` by at most 7 days.
    public static func boxKeyStatement(deviceId: String, boxKey: JSONValue, createdAt: String, expiresAt: String, nonce: String) throws -> JSONValue {
        try checked("kl.device.box_key", .object([
            "v": .number("1"),
            "type": .string("kl.device.box_key"),
            "device_id": .string(deviceId),
            "box_key": boxKey,
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce)
        ]))
    }

    /// What people compare for a box key (R-SP-10): `b-` and the device id's rule,
    /// in groups of four. `boxKeyFingerprint` in src/approvals/seal.js.
    public static func boxKeyFingerprint(x: String, y: String) throws -> String {
        // Checks the coordinates and the curve.
        _ = try Identifiers.deviceId(x: x, y: y)
        let xb = try Base64URL.decode(x)
        let yb = try Base64URL.decode(y)
        let id = Identifiers.deviceId(raw: Data([0x04]) + xb + yb, prefix: "b-")
        return "b-" + Identifiers.fingerprintGroups(id)
    }

    public static func boxKeyFingerprint(_ key: JSONValue) throws -> String {
        guard Rules.isDeviceJwk(key), let x = key["x"]?.stringValue, let y = key["y"]?.stringValue else {
            throw ProtocolError.malformed("not a P-256 JWK")
        }
        return try boxKeyFingerprint(x: x, y: y)
    }

    /// kl.approval.response for a node-signed clear request message. A message
    /// holding `sealed` is refused: a phone answers only what it opened and checked.
    public static func response(to request: JSONValue, decision: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard request["sealed"] == nil else { throw ProtocolError.malformed("a sealed request is answered from its opened message") }
        return try buildResponse(request, decision: decision, deviceId: deviceId, signedAt: signedAt)
    }

    /// kl.approval.response for a sealed request, from what it opened to
    /// (`PhoneView.opened`), which must pass `validateOpenedRequest`. It signs the salted hash as received (R-SP-2).
    public static func responseToOpened(_ opened: JSONValue, decision: String, deviceId: String, signedAt: String) throws -> JSONValue {
        if let problem = validateOpenedRequest(opened) { throw ProtocolError.malformed("not an opened request: \(problem)") }
        return try buildResponse(opened, decision: decision, deviceId: deviceId, signedAt: signedAt)
    }

    private static func buildResponse(_ request: JSONValue, decision: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard let requestId = request["request_id"]?.stringValue, let nodeId = request["node_id"]?.stringValue,
              let actionHash = request["action_hash"]?.stringValue, let nonce = request["nonce"]?.stringValue,
              let expiresAt = request["expires_at"]?.stringValue else {
            throw ProtocolError.malformed("not a request")
        }
        return try checked("kl.approval.response", .object([
            "v": .number("1"),
            "type": .string("kl.approval.response"),
            "request_id": .string(requestId),
            "node_id": .string(nodeId),
            "action_hash": .string(actionHash),
            "nonce": .string(nonce),
            "decision": .string(decision),
            "expires_at": .string(expiresAt),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// Console enrollment: self-signed, with code_mac = HMAC-SHA256(code bytes, JCS(message without code_mac)).
    public static func consoleEnroll(device: JSONValue, codeId: String, code: String, createdAt: String, expiresAt: String, nonce: String) throws -> JSONValue {
        var fields: [String: JSONValue] = [
            "v": .number("1"),
            "type": .string("kl.device.enroll"),
            "device": device,
            "enrolled_by": .null,
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce),
            "code_id": .string(codeId)
        ]
        fields["code_mac"] = .string(try Digest.hmacB64url(keyB64url: code, message: JCS.data(.object(fields))))
        return try checked("kl.device.enroll", .object(fields))
    }

    /// Enrollment of another phone by this one (the invite flow).
    public static func signedEnroll(device: JSONValue, enrolledBy: String, createdAt: String, expiresAt: String, nonce: String) throws -> JSONValue {
        try checked("kl.device.enroll", .object([
            "v": .number("1"),
            "type": .string("kl.device.enroll"),
            "device": device,
            "enrolled_by": .string(enrolledBy),
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce)
        ]))
    }

    /// `reason` is at most 200 code points; a phone never revokes itself
    /// (kid = revoked_by ≠ device_id).
    public static func revoke(deviceId: String, revokedBy: String, reason: String, createdAt: String, expiresAt: String, nonce: String) throws -> JSONValue {
        guard !ExactText.same(deviceId, revokedBy) else { throw ProtocolError.malformed("a device cannot revoke itself") }
        return try checked("kl.device.revoke", .object([
            "v": .number("1"),
            "type": .string("kl.device.revoke"),
            "device_id": .string(deviceId),
            "revoked_by": .string(revokedBy),
            "reason": .string(reason),
            "created_at": .string(createdAt),
            "expires_at": .string(expiresAt),
            "nonce": .string(nonce)
        ]))
    }

    public static func inviteMac(secret: String, device: JSONValue) throws -> String {
        try Digest.hmacB64url(keyB64url: secret, message: JCS.data(device))
    }

    /// S for X-KL-Signature: "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body)).
    public static func phoneAuthString(method: String, pathWithQuery: String, timestamp: String, body: Data) -> String {
        ["KL-PHONE-V1", method.uppercased(), pathWithQuery, timestamp, Digest.sha256B64url(body)].joined(separator: "\n")
    }

    public static func encodeQR(_ object: JSONValue) -> String {
        "kl1:" + Base64URL.encode(JCS.data(object))
    }

    public static func decodeQR(_ text: String) throws -> JSONValue {
        guard text.hasPrefix("kl1:") else { throw ProtocolError.malformed("not a kl1: code") }
        let value: JSONValue
        do {
            value = try JSONParser.parse(try Base64URL.decode(String(text.dropFirst(4))))
        } catch {
            throw ProtocolError.malformed("not a kl1: code")
        }
        guard value["t"]?.stringValue != nil else { throw ProtocolError.malformed("QR payload has no type") }
        return value
    }

    /// nil when `message` is a well-formed `type`, else the reason a node
    /// gives (`malformed` or `unsupported_version`); `validateMessage` in
    /// src/approvals/messages.js. A type without rules here is `malformed`:
    /// there is no generic fallback.
    public static func validate(_ type: String, _ message: JSONValue) -> String? {
        guard let m = message.objectValue, let t = m["type"]?.stringValue, ExactText.same(t, type),
              let v = m["v"], Rules.isInteger(v) else { return "malformed" }
        guard v == .number("1") else { return "unsupported_version" }
        guard let rule = Rules.byType[type] else { return "malformed" }
        return rule(m) ? nil : "malformed"
    }

    /// A sealed kl.approval.request after opening (clear part and content
    /// together): nil, or the reason a phone refuses it (`malformed`,
    /// `action_hash_mismatch`). The hash is held to the content here, before
    /// anything is shown (R-SP-2). `validateOpenedRequest` in src/approvals/messages.js.
    public static func validateOpenedRequest(_ message: JSONValue) -> String? {
        guard var m = message.objectValue, let type = m["type"]?.stringValue, ExactText.same(type, "kl.approval.request"),
              m["v"] == JSONValue.number("1") else { return "malformed" }
        let salt = m.removeValue(forKey: "salt")
        let nodeBox = m.removeValue(forKey: "node_box")
        guard Rules.isClearRequest(m), Rules.isDeviceJwk(nodeBox), Rules.isHash(salt),
              let saltText = salt?.stringValue, let action = m["action"], let hash = m["action_hash"]?.stringValue,
              let recomputed = try? Seal.saltedHash(salt: saltText, value: action) else { return "malformed" }
        return ExactText.same(recomputed, hash) ? nil : "action_hash_mismatch"
    }

    private static func checked(_ type: String, _ message: JSONValue) throws -> JSONValue {
        if let reason = validate(type, message) { throw ProtocolError.malformed("not a valid \(type): \(reason)") }
        return message
    }
}

/// What the app shows for the relay's answer to
/// `POST /v1/approvals/{id}/response`, `{ delivered, accepted, reason }`
/// (approval-v1 §4, §7). Only `accepted: true` is approved; `accepted: null`
/// means the relay forwarded it to a local requester and does not know the
/// verdict, and is never shown as approved.
public enum ResponseOutcome: Equatable {
    /// The node accepted the response.
    case accepted
    /// The node judged the response and refused it (`refused: <reason>`).
    case refused(String?)
    /// Forwarded to a local requester on the node; the verdict comes later ("sent to <node>").
    case forwarded
    /// Nothing on the node saw the response ("not delivered").
    case notDelivered

    public init(reply: JSONValue) {
        let delivered = reply["delivered"]?.boolValue
        switch reply["accepted"] {
        case .bool(true)? where delivered == true:
            self = .accepted
        case .bool(false)? where delivered == true:
            self = .refused(reply["reason"]?.stringValue)
        case .null? where delivered == true:
            self = .forwarded
        default:
            self = .notDelivered
        }
    }
}

/// The node's message validators (src/approvals/messages.js), for the types
/// a phone reads or writes.
enum Rules {
    typealias Fields = [String: JSONValue]

    static let byType: [String: (Fields) -> Bool] = [
        "kl.approval.request": request,
        "kl.approval.response": response,
        "kl.approval.status": status,
        "kl.device.enroll": enroll,
        "kl.device.revoke": revoke,
        "kl.device.box_key": boxKey,
        "kl.audit.slice": auditSlice
    ]

    static let summaryMax = 300
    static let nodeNameMax = 64
    static let originStringMax = 200
    static let revokeReasonMax = 200
    static let statusReasonMax = 300
    static let statusStates = ["approved", "denied", "expired", "withdrawn", "refused"]
    static let enrollMaxMs: Int64 = 10 * 60 * 1000
    static let revokeMaxMs: Int64 = 7 * 24 * 60 * 60 * 1000
    static let boxKeyMaxMs: Int64 = 7 * 24 * 60 * 60 * 1000
    static let platforms = ["ios", "android", "demo"]

    // MARK: shapes

    static func hasExactKeys(_ o: Fields, _ keys: [String]) -> Bool {
        let have = o.keys.map { Array($0.utf16) }.sorted { $0.lexicographicallyPrecedes($1) }
        let want = keys.map { Array($0.utf16) }.sorted { $0.lexicographicallyPrecedes($1) }
        return have == want
    }

    static func isString(_ v: JSONValue?) -> Bool { v?.stringValue != nil }

    static func isNullOrString(_ v: JSONValue?) -> Bool { v?.isNull == true || v?.stringValue != nil }

    static func isObject(_ v: JSONValue?) -> Bool { v?.objectValue != nil }

    static func isOneOf(_ v: JSONValue?, _ values: [String]) -> Bool {
        guard let s = v?.stringValue else { return false }
        return values.contains { ExactText.same($0, s) }
    }

    /// A string of at most `max` code points (not UTF-16 units).
    static func withinLength(_ v: JSONValue?, _ max: Int) -> Bool {
        guard let s = v?.stringValue else { return false }
        return s.unicodeScalars.count <= max
    }

    /// Number.isInteger over the received number.
    static func isInteger(_ v: JSONValue) -> Bool {
        guard case .number(let n) = v, let d = Double(n), d.isFinite else { return false }
        return d.rounded(.towardZero) == d
    }

    static func isTimestamp(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return Timestamps.isValid(s)
    }

    // MARK: ids and tokens, as ASCII byte patterns

    static func ascii(_ v: JSONValue?) -> [UInt8]? {
        v?.stringValue.map { Array($0.utf8) }
    }

    static func isB64urlToken(_ v: JSONValue?, length: Int) -> Bool {
        guard let b = ascii(v) else { return false }
        return b.count == length && b.allSatisfy(Base64URL.isAlphabet)
    }

    static func isNonce(_ v: JSONValue?) -> Bool { isB64urlToken(v, length: 43) }
    static func isHash(_ v: JSONValue?) -> Bool { isB64urlToken(v, length: 43) }
    static func isCodeId(_ v: JSONValue?) -> Bool { isB64urlToken(v, length: 22) }

    static func isBase32Id(_ v: JSONValue?, prefix: String) -> Bool {
        guard let b = ascii(v) else { return false }
        let p = Array(prefix.utf8)
        guard b.count == p.count + 16, Array(b[0..<p.count]) == p else { return false }
        return b[p.count...].allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x32 && $0 <= 0x37) }
    }

    static func isDeviceId(_ v: JSONValue?) -> Bool { isBase32Id(v, prefix: "d-") }
    static func isNodeId(_ v: JSONValue?) -> Bool { isBase32Id(v, prefix: "kl-") }

    /// Lowercase UUID v4: 8-4-4-4-12 hex, version 4, variant 8/9/a/b.
    static func isUuidV4(_ v: JSONValue?) -> Bool {
        guard let b = ascii(v), b.count == 36 else { return false }
        for (k, c) in b.enumerated() {
            if [8, 13, 18, 23].contains(k) {
                guard c == UInt8(ascii: "-") else { return false }
            } else {
                guard (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) else { return false }
            }
        }
        return b[14] == UInt8(ascii: "4") && [UInt8(ascii: "8"), UInt8(ascii: "9"), UInt8(ascii: "a"), UInt8(ascii: "b")].contains(b[19])
    }

    // MARK: device keys

    static func isDeviceJwk(_ v: JSONValue?) -> Bool {
        guard let jwk = v?.objectValue, hasExactKeys(jwk, ["crv", "kty", "x", "y"]),
              isOneOf(jwk["kty"], ["EC"]), isOneOf(jwk["crv"], ["P-256"]),
              let x = jwk["x"]?.stringValue, let y = jwk["y"]?.stringValue else { return false }
        return (try? Identifiers.deviceId(x: x, y: y)) != nil
    }

    /// Whether two P-256 JWKs name one point. A coordinate is canonical base64url, so the text decides.
    static func samePoint(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        guard let ax = a?["x"]?.stringValue, let ay = a?["y"]?.stringValue,
              let bx = b?["x"]?.stringValue, let by = b?["y"]?.stringValue else { return false }
        return ExactText.same(ax, bx) && ExactText.same(ay, by)
    }

    /// The four keys of today, or exactly those and `box_key` (R-SP-10): a P-256 JWK whose point is not `public_key`'s.
    static func isDevice(_ v: JSONValue?) -> Bool {
        guard let d = v?.objectValue else { return false }
        let withBoxKey = d["box_key"] != nil
        let deviceKeys = ["device_id", "name", "platform", "public_key"]
        if withBoxKey && (!isDeviceJwk(d["box_key"]) || samePoint(d["box_key"], d["public_key"])) { return false }
        guard hasExactKeys(d, withBoxKey ? deviceKeys + ["box_key"] : deviceKeys),
              let name = d["name"]?.stringValue, (1...64).contains(name.utf16.count),
              isOneOf(d["platform"], platforms), isDeviceJwk(d["public_key"]), isDeviceId(d["device_id"]),
              let jwk = d["public_key"], let id = d["device_id"]?.stringValue,
              let derived = try? Identifiers.deviceId(x: jwk["x"]!.stringValue!, y: jwk["y"]!.stringValue!) else { return false }
        return ExactText.same(derived, id)
    }

    /// expires_at − created_at in (0, max] milliseconds.
    static func spanWithin(_ m: Fields, _ max: Int64) -> Bool {
        guard let created = m["created_at"]?.stringValue.flatMap(Timestamps.epochMillis),
              let expires = m["expires_at"]?.stringValue.flatMap(Timestamps.epochMillis) else { return false }
        let span = expires - created
        return span > 0 && span <= max
    }

    // MARK: per type

    static func action(_ v: JSONValue?) -> Bool {
        guard let a = v?.objectValue, withinLength(a["summary"], summaryMax), isString(a["name"]) else { return false }
        switch a["kind"]?.stringValue {
        case "tool"?:
            return hasExactKeys(a, ["kind", "name", "params", "cwd", "summary"]) && isObject(a["params"]) && isNullOrString(a["cwd"])
        case "runbook"?:
            return hasExactKeys(a, ["kind", "name", "params", "steps", "cwd", "summary"]) && isObject(a["params"])
                && a["steps"]?.arrayValue != nil && isNullOrString(a["cwd"])
        case "envelope"?:
            guard hasExactKeys(a, ["kind", "name", "params", "summary"]), let p = a["params"]?.objectValue else { return false }
            return hasExactKeys(p, ["case_id", "envelope_hash"]) && isString(p["case_id"]) && isString(p["envelope_hash"])
        default:
            return false
        }
    }

    static func origin(_ v: JSONValue?) -> Bool {
        guard let o = v?.objectValue, let client = o["client"]?.stringValue else { return false }
        let keys = ExactText.same(client, "desktop") ? ["client", "session", "job_id", "deviceId"] : ["client", "session", "job_id"]
        return hasExactKeys(o, keys) && o.values.allSatisfy { $0.isNull || withinLength($0, originStringMax) }
    }

    /// What both shapes of a request hold in clear.
    static func requestClearFields(_ m: Fields) -> Bool {
        isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && withinLength(m["node_name"], nodeNameMax)
            && isHash(m["action_hash"]) && isTimestamp(m["created_at"]) && isTimestamp(m["expires_at"]) && isNonce(m["nonce"])
    }

    static func isClearRequest(_ m: Fields) -> Bool {
        hasExactKeys(m, ["v", "type", "request_id", "node_id", "node_name", "action", "action_hash", "origin", "created_at", "expires_at", "nonce"])
            && requestClearFields(m) && action(m["action"]) && origin(m["origin"])
    }

    /// A sealed one (R-SP-4): whoever opens it checks its action and origin (`Messages.validateOpenedRequest`).
    static func request(_ m: Fields) -> Bool {
        isClearRequest(m)
            || (Seal.isSealedShape(type: "kl.approval.request", message: .object(m)) && requestClearFields(m) && isDeviceJwk(m["node_box"]))
    }

    static func response(_ m: Fields) -> Bool {
        hasExactKeys(m, ["v", "type", "request_id", "node_id", "action_hash", "nonce", "decision", "expires_at", "device_id", "signed_at"])
            && isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && isHash(m["action_hash"]) && isNonce(m["nonce"])
            && isOneOf(m["decision"], ["approve", "deny"]) && isTimestamp(m["expires_at"]) && isDeviceId(m["device_id"]) && isTimestamp(m["signed_at"])
    }

    /// kl.approval.status (node-signed): `device_id` null or a device id,
    /// `reason` null or at most 300 code points (the node's REASON_MAX).
    static func status(_ m: Fields) -> Bool {
        hasExactKeys(m, ["v", "type", "request_id", "node_id", "state", "device_id", "reason", "at"])
            && isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && isOneOf(m["state"], statusStates)
            && (m["device_id"]?.isNull == true || isDeviceId(m["device_id"]))
            && (m["reason"]?.isNull == true || withinLength(m["reason"], statusReasonMax))
            && isTimestamp(m["at"])
    }

    static func enroll(_ m: Fields) -> Bool {
        let base = ["v", "type", "device", "enrolled_by", "created_at", "expires_at", "nonce"]
        let console = m["enrolled_by"]?.isNull == true
        guard hasExactKeys(m, console ? base + ["code_id", "code_mac"] : base) else { return false }
        if !console && !isDeviceId(m["enrolled_by"]) { return false }
        if console && !(isCodeId(m["code_id"]) && isHash(m["code_mac"])) { return false }
        guard isDevice(m["device"]), isTimestamp(m["created_at"]), isTimestamp(m["expires_at"]), isNonce(m["nonce"]) else { return false }
        return spanWithin(m, enrollMaxMs)
    }

    static func revoke(_ m: Fields) -> Bool {
        guard hasExactKeys(m, ["v", "type", "device_id", "revoked_by", "reason", "created_at", "expires_at", "nonce"]),
              isDeviceId(m["device_id"]), isDeviceId(m["revoked_by"]), withinLength(m["reason"], revokeReasonMax),
              isTimestamp(m["created_at"]), isTimestamp(m["expires_at"]), isNonce(m["nonce"]) else { return false }
        return spanWithin(m, revokeMaxMs)
    }

    /// kl.device.box_key, the device key's statement of its box key.
    static func boxKey(_ m: Fields) -> Bool {
        guard hasExactKeys(m, ["v", "type", "device_id", "box_key", "created_at", "expires_at", "nonce"]),
              isDeviceId(m["device_id"]), isDeviceJwk(m["box_key"]),
              isTimestamp(m["created_at"]), isTimestamp(m["expires_at"]), isNonce(m["nonce"]) else { return false }
        return spanWithin(m, boxKeyMaxMs)
    }

    static func auditSlice(_ m: Fields) -> Bool {
        guard hasExactKeys(m, ["v", "type", "node_id", "entries", "head", "anchor", "created_at"]),
              isNodeId(m["node_id"]), m["entries"]?.arrayValue != nil,
              let head = m["head"]?.objectValue, let anchor = m["anchor"]?.objectValue,
              let headSeq = head["seq"], isInteger(headSeq), isNullOrString(head["hash"]),
              let anchorSeq = anchor["seq"], isInteger(anchorSeq), isNullOrString(anchor["prev"]) else { return false }
        return isTimestamp(m["created_at"])
    }
}
