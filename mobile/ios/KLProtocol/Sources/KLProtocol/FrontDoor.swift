import Foundation

/// A scope the owner grants to a client, with an optional machine limit
/// (client-grant-v1 §3.1).
public struct ScopeChoice: Equatable {
    public let scope: String
    public let machines: [String]?

    public init(scope: String, machines: [String]? = nil) {
        self.scope = scope
        self.machines = machines
    }
}

/// The result of checking a `kl.relay.repin` (client-grant-v1 §4.7). Only
/// `ok == true` moves the pin.
public struct RepinCheck: Equatable {
    public let ok: Bool
    public let reason: String?
    public let newSpki: String?
}

/// The relay a re-pin probe was made for (FrontDoor.repinStillApplies).
public struct RepinTarget: Equatable {
    public let relayURL: String
    public let relaySpki: String
    public let frontdoorId: String

    public init(relayURL: String, relaySpki: String, frontdoorId: String) {
        self.relayURL = relayURL
        self.relaySpki = relaySpki
        self.frontdoorId = frontdoorId
    }
}

/// client-grant-v1 (docs/protocol/client-grant-v1.md): what a phone builds
/// for a front door and what it checks from one. Each builder applies the
/// front door's own rules first, so the phone never signs something the
/// front door would refuse as `malformed`.
public enum FrontDoor {
    static let userCodeAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

    /// Longer typed input is refused outright (§6), as the front door does.
    static let userCodeInputMax = 64

    /// The challenge purposes (ruling T2-purpose, §4.6): `revoke` for
    /// kl.client.revoke, `remove` for kl.node.remove.
    public static let purposeRevoke = "revoke"
    public static let purposeRemove = "remove"

    /// JavaScript's `\s` (what the front door strips), every one a single
    /// UTF-16 unit.
    static func isJSWhitespace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return (0x2000...0x200A).contains(u)
        }
    }

    static func isASCIIAlnum(_ u: UInt16) -> Bool {
        (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A)
    }

    /// What the owner typed, as the grant carries it (the front door's
    /// normalizeUserCode): at most 64 UTF-16 units; `-` and whitespace
    /// dropped; then exactly six ASCII letters and digits (checked before
    /// upper-casing, so no look-alike such as `ß` or a dotless i becomes the
    /// alphabet); upper case, O→0 and I/L→1; nil unless that is six alphabet
    /// characters.
    public static func normalizeUserCode(_ text: String) -> String? {
        let units = Array(text.utf16)
        guard units.count <= userCodeInputMax else { return nil }
        let compact = units.filter { $0 != 0x2D && !isJSWhitespace($0) }
        guard compact.count == 6, compact.allSatisfy(isASCIIAlnum) else { return nil }
        let bytes: [UInt8] = compact.map { unit in
            var c = UInt8(unit)
            if c >= 0x61 && c <= 0x7A { c -= 0x20 }
            switch c {
            case 0x4F: return 0x30
            case 0x49, 0x4C: return 0x31
            default: return c
            }
        }
        guard bytes.allSatisfy({ userCodeAlphabet.contains($0) }) else { return nil }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// `Q7KM2X` → `Q7K-M2X`, as the browser shows it.
    public static func formatUserCode(_ code: String) -> String {
        String(code.prefix(3)) + "-" + String(code.dropFirst(3))
    }

    /// `kl-3v7q2m4k8d1x9c0a` → `kl-3v7q 2m4k 8d1x 9c0a`.
    public static func nodeFingerprint(_ nodeId: String) -> String {
        "kl-" + Identifiers.fingerprintGroups(nodeId)
    }

    /// A node name a grant can limit to (`machines=`): `^[a-z0-9][a-z0-9._-]{0,62}$`.
    /// Other names can only be granted without a limit (Deviation 18).
    public static func isMachineName(_ name: String) -> Bool {
        FrontDoorRules.isMachineName(name)
    }

    /// Sorted by scope (UTF-16 order, as the front door compares); each
    /// machine list sorted and de-duplicated.
    public static func scopesJSON(_ choices: [ScopeChoice]) -> JSONValue {
        let sorted = choices.sorted { JCS.utf16Less($0.scope, $1.scope) }
        return .array(sorted.map { choice in
            let machines: JSONValue = choice.machines.map { list -> JSONValue in
                var seen: [String] = []
                for name in list where !seen.contains(where: { ExactText.same($0, name) }) { seen.append(name) }
                return .array(seen.sorted(by: JCS.utf16Less).map { .string($0) })
            } ?? .null
            return .object(["scope": .string(choice.scope), "machines": machines])
        })
    }

    /// The body of `POST /v1/challenges`: the purpose of the message the
    /// challenge will be spent on.
    public static func challengeRequest(purpose: String) throws -> JSONValue {
        guard ExactText.same(purpose, purposeRevoke) || ExactText.same(purpose, purposeRemove) else {
            throw ProtocolError.malformed("a challenge purpose is revoke or remove")
        }
        return .object(["purpose": .string(purpose)])
    }

    private static func field(_ v: JSONValue, _ key: String) throws -> String {
        guard let s = v[key]?.stringValue else { throw ProtocolError.malformed("missing \(key)") }
        return s
    }

    /// kl.client.grant for a pending authorization (the `GET /v1/grants/pending`
    /// reply) and the code the owner typed. `deny` carries no scopes.
    public static func clientGrant(frontdoorId: String, pending: JSONValue, userCode: String, scopes: [ScopeChoice], decision: String,
                                   nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard let code = normalizeUserCode(userCode) else { throw ProtocolError.malformed("the code is six letters and digits") }
        return try checked("kl.client.grant", .object([
            "v": .number("1"),
            "type": .string("kl.client.grant"),
            "frontdoor_id": .string(frontdoorId),
            "grant_id": .string(try field(pending, "grant_id")),
            "client_id": .string(try field(pending, "client_id")),
            "client_name": .string(try field(pending, "client_name")),
            "redirect_uri": .string(try field(pending, "redirect_uri")),
            "resource": .string(try field(pending, "resource")),
            "code_challenge": .string(try field(pending, "code_challenge")),
            "user_code": .string(code),
            "scopes": ExactText.same(decision, "deny") ? .array([]) : scopesJSON(scopes),
            "decision": .string(decision),
            "nonce": .string(nonce),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// `challenge` comes from `POST /v1/challenges` with purpose `revoke`.
    public static func clientRevoke(frontdoorId: String, grantId: String, challenge: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try checked("kl.client.revoke", .object([
            "v": .number("1"),
            "type": .string("kl.client.revoke"),
            "frontdoor_id": .string(frontdoorId),
            "grant_id": .string(grantId),
            "challenge": .string(challenge),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// kl.node.enroll for one pending pairing (a `GET /v1/pairings/pending`
    /// entry). `replaces` is signed exactly as given: null or a node id;
    /// missing or any other value is refused rather than signed as null.
    public static func nodeEnroll(frontdoorId: String, pairing: JSONValue, decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard let replaces = pairing["replaces"], replaces.isNull || replaces.stringValue != nil else {
            throw ProtocolError.malformed("replaces is null or a node id")
        }
        return try checked("kl.node.enroll", .object([
            "v": .number("1"),
            "type": .string("kl.node.enroll"),
            "frontdoor_id": .string(frontdoorId),
            "pairing_id": .string(try field(pairing, "pairing_id")),
            "node_id": .string(try field(pairing, "node_id")),
            "node_name": .string(try field(pairing, "node_name")),
            "profile": .string(try field(pairing, "profile")),
            "public_key": .string(try field(pairing, "public_key")),
            "tls_fingerprint": .string(try field(pairing, "tls_fingerprint")),
            "replaces": replaces,
            "decision": .string(decision),
            "nonce": .string(nonce),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// `challenge` comes from `POST /v1/challenges` with purpose `remove`.
    public static func nodeRemove(frontdoorId: String, nodeId: String, challenge: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try checked("kl.node.remove", .object([
            "v": .number("1"),
            "type": .string("kl.node.remove"),
            "frontdoor_id": .string(frontdoorId),
            "node_id": .string(nodeId),
            "challenge": .string(challenge),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// nil when well formed, else `malformed` or `unsupported_version` (the
    /// front door's validateMessage).
    public static func validate(_ type: String, _ message: JSONValue) -> String? {
        guard let m = message.objectValue, let t = m["type"]?.stringValue, ExactText.same(t, type),
              let v = m["v"], Rules.isInteger(v) else { return "malformed" }
        guard v == .number("1") else { return "unsupported_version" }
        guard let rule = FrontDoorRules.byType[type] else { return "malformed" }
        return rule(m) ? nil : "malformed"
    }

    private static func checked(_ type: String, _ message: JSONValue) throws -> JSONValue {
        if let reason = validate(type, message) { throw ProtocolError.malformed("not a valid \(type): \(reason)") }
        return message
    }

    /// The pinned key is a DER SPKI Ed25519 key: the 12-byte prefix and 32 key bytes.
    static func isEd25519SpkiHex(_ hex: String) -> Bool {
        guard let der = try? Hex.decode(hex), der.count == 44 else { return false }
        return Hex.encode(der.prefix(12)) == Identifiers.ed25519SpkiPrefix
    }

    /// The re-pin rule (client-grant-v1 §4.7, the front door's `verifyRepin`
    /// order and reasons): the pinned front-door key parses; the envelope
    /// opens canonically and matches its shape; `alg` is Ed25519; `kid` and
    /// `frontdoor_id` are the pinned front door; the signature verifies
    /// against the pinned key; `new_spki` is the key just received; `old_spki`
    /// is the current pin. Any failure leaves the pin unchanged.
    public static func verifyRepin(_ envelopeJSON: JSONValue, frontdoorId: String, frontdoorKeyHex: String, receivedSpki: String, currentPin: String) -> RepinCheck {
        func fail(_ reason: String) -> RepinCheck { RepinCheck(ok: false, reason: reason, newSpki: nil) }
        guard isEd25519SpkiHex(frontdoorKeyHex) else { return fail("malformed") }
        guard let envelope = try? Envelope(json: envelopeJSON), let message = try? envelope.message() else { return fail("malformed") }
        if let reason = validate("kl.relay.repin", message) { return fail(reason) }
        guard ExactText.same(envelope.alg, "Ed25519") else { return fail("malformed") }
        guard ExactText.same(envelope.kid, frontdoorId), let fd = message["frontdoor_id"]?.stringValue, ExactText.same(fd, frontdoorId) else { return fail("wrong_frontdoor") }
        guard envelope.verifyEd25519(spkiHex: frontdoorKeyHex) == true else { return fail("bad_signature") }
        guard let newSpki = message["new_spki"]?.stringValue, ExactText.same(newSpki, receivedSpki) else { return fail("spki_mismatch") }
        guard let oldSpki = message["old_spki"]?.stringValue, ExactText.same(oldSpki, currentPin) else { return fail("old_pin_mismatch") }
        return RepinCheck(ok: true, reason: nil, newSpki: newSpki)
    }

    /// A verified re-pin is applied only when the phone still has the relay
    /// it probed: the same URL, the same pin, the same front door. A reset,
    /// a new pairing or another re-pin while the probe was out wins (`now`
    /// is nil when the phone has no relay or front door any more).
    public static func repinStillApplies(probed: RepinTarget, now: RepinTarget?) -> Bool {
        guard let now else { return false }
        return ExactText.same(now.relayURL, probed.relayURL) && ExactText.same(now.relaySpki, probed.relaySpki)
            && ExactText.same(now.frontdoorId, probed.frontdoorId)
    }

    /// The front door a `GET /v1/frontdoor` reply names, only when it is a
    /// node this phone pinned from a code (never from the relay's word) and
    /// the reply's key is that pin's key. Nothing else in the reply is
    /// trusted; nil for anything else.
    public static func identify(_ info: JSONValue?, pins: [NodePin]) -> String? {
        guard let id = info?["frontdoor_id"]?.stringValue, Rules.isNodeId(info?["frontdoor_id"]),
              FrontDoorRules.isRawEd25519(info?["public_key"]), let text = info?["public_key"]?.stringValue,
              let raw = try? Base64URL.decode(text), raw.count == 32,
              let pin = pins.first(where: { ExactText.same($0.id, id) }),
              let der = try? Hex.decode(pin.key), der.count == 44, Hex.encode(der.prefix(12)) == Identifiers.ed25519SpkiPrefix,
              Data(der.suffix(32)) == raw else { return nil }
        return id
    }

    /// Text from a client or the front door (names, hosts, codes, reasons,
    /// alert details) as the app shows it: at most `max` code points, with
    /// "…" when cut, then escaped (hidden and bidi characters as ‹U+XXXX›).
    /// The app shows the result as plain text, never as markup or a link.
    public static let shownTextMax = 200

    public static func shownText(_ text: String?, max: Int = shownTextMax) -> String {
        guard let text else { return "" }
        let scalars = text.unicodeScalars
        guard scalars.count > max else { return Display.escape(text) }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: scalars.prefix(Swift.max(0, max)))
        return Display.escape(String(cut)) + "\u{2026}"
    }
}

/// One `GET /v1/grants/pending` reply (client-grant-v1 §7): exactly its ten
/// fields. Everything in it is the front door's (and the client's) word; the
/// app shows `clientName` as self-declared.
public struct GrantRequest: Equatable {
    static let fields = ["grant_id", "client_id", "client_name", "client_host", "redirect_uri", "resource", "code_challenge",
                         "requested_scopes", "preselected", "expires_in_ms"]

    public let json: JSONValue
    public let grantId: String
    public let clientId: String
    public let clientName: String
    public let clientHost: String
    public let redirectUri: String
    public let resource: String
    public let requestedScopes: [String]
    public let preselected: [String]
    public let expiresInMs: Int

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, Rules.hasExactKeys(o, Self.fields),
              FrontDoorRules.isGrantId(o["grant_id"]), FrontDoorRules.isClientId(o["client_id"]),
              Rules.withinLength(o["client_name"], FrontDoorRules.clientNameMax), FrontDoorRules.isUri(o["client_host"]),
              FrontDoorRules.isUri(o["redirect_uri"]), FrontDoorRules.isUri(o["resource"]),
              FrontDoorRules.isCodeChallenge(o["code_challenge"]),
              let requested = o["requested_scopes"]?.arrayValue, let preselected = o["preselected"]?.arrayValue,
              requested.count <= FrontDoorRules.maxScopes, preselected.count <= FrontDoorRules.maxScopes,
              let expires = o["expires_in_ms"]?.intValue, expires >= 0 else {
            throw ProtocolError.malformed("the front door sent a connection request this app cannot read")
        }
        let names = requested.compactMap { $0.stringValue }.filter(FrontDoorRules.isScopeName)
        // Scope names are ASCII, so Set's String equality is exact here.
        guard names.count == requested.count, Set(names).count == names.count else {
            throw ProtocolError.malformed("unknown or repeated scope names in the request")
        }
        let preNames = preselected.compactMap { $0.stringValue }
        guard preNames.count == preselected.count else { throw ProtocolError.malformed("the preselected scopes are not names") }
        self.json = json
        grantId = o["grant_id"]!.stringValue!
        clientId = o["client_id"]!.stringValue!
        clientName = o["client_name"]!.stringValue!
        clientHost = o["client_host"]!.stringValue!
        redirectUri = o["redirect_uri"]!.stringValue!
        resource = o["resource"]!.stringValue!
        requestedScopes = names
        // Only what was requested can be preselected.
        self.preselected = preNames.filter { p in names.contains { ExactText.same($0, p) } }
        expiresInMs = expires
    }

    /// The host the browser returns to (the redirect URI's); the whole URI
    /// when it has none this parser can read.
    public var redirectHost: String {
        URLComponents(string: redirectUri)?.host ?? redirectUri
    }

    /// The grant for this request. An approval may only narrow what the
    /// client asked for: a scope outside `requestedScopes` is refused here,
    /// before it is signed (the front door would refuse it as
    /// `invalid_scope`). Which scopes need another (`fleet:unsafe`) stays the
    /// front door's rule.
    public func message(frontdoorId: String, userCode: String, scopes: [ScopeChoice], decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        if !ExactText.same(decision, "deny") {
            for choice in scopes where !requestedScopes.contains(where: { ExactText.same($0, choice.scope) }) {
                throw ProtocolError.malformed("\"\(choice.scope)\" was not requested by this client")
            }
        }
        return try FrontDoor.clientGrant(frontdoorId: frontdoorId, pending: json, userCode: userCode, scopes: scopes, decision: decision,
                                         nonce: nonce, deviceId: deviceId, signedAt: signedAt)
    }
}

/// One `GET /v1/pairings/pending` entry (client-grant-v1 §7): exactly its
/// eight fields. Its id must derive from its key, so the fingerprint shown is
/// the key's.
public struct PairingRequest: Equatable {
    static let fields = ["pairing_id", "node_name", "node_id", "profile", "public_key", "tls_fingerprint", "replaces", "expires_in_ms"]

    public let json: JSONValue
    public let pairingId: String
    public let nodeId: String
    public let nodeName: String
    public let profile: String
    public let replaces: String?
    public let expiresInMs: Int

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, Rules.hasExactKeys(o, Self.fields),
              FrontDoorRules.isPairingId(o["pairing_id"]), Rules.isNodeId(o["node_id"]),
              let name = o["node_name"]?.stringValue, FrontDoorRules.isNodeName(name),
              Rules.isOneOf(o["profile"], ["agent", "runbook"]), FrontDoorRules.isRawEd25519(o["public_key"]),
              FrontDoorRules.isHex64(o["tls_fingerprint"]),
              o["replaces"]?.isNull == true || Rules.isNodeId(o["replaces"]),
              let expires = o["expires_in_ms"]?.intValue, expires >= 0,
              let raw = try? Base64URL.decode(o["public_key"]!.stringValue!), raw.count == 32,
              ExactText.same(Identifiers.nodeId(ed25519Raw: raw), o["node_id"]!.stringValue!) else {
            throw ProtocolError.malformed("the front door sent a pairing this app cannot verify")
        }
        self.json = json
        pairingId = o["pairing_id"]!.stringValue!
        nodeId = o["node_id"]!.stringValue!
        nodeName = name
        profile = o["profile"]!.stringValue!
        replaces = o["replaces"]?.stringValue
        expiresInMs = expires
    }

    public var fingerprint: String { FrontDoor.nodeFingerprint(nodeId) }

    public func message(frontdoorId: String, decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try FrontDoor.nodeEnroll(frontdoorId: frontdoorId, pairing: json, decision: decision, nonce: nonce, deviceId: deviceId, signedAt: signedAt)
    }
}

/// A `POST /v1/challenges` reply: `{ challenge, expires_in_ms }` exactly.
public struct Challenge: Equatable {
    public let challenge: String
    public let expiresInMs: Int

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, Rules.hasExactKeys(o, ["challenge", "expires_in_ms"]), Rules.isNonce(o["challenge"]),
              let expires = o["expires_in_ms"]?.intValue, expires >= 0 else {
            throw ProtocolError.malformed("the front door sent a challenge this app cannot read")
        }
        challenge = o["challenge"]!.stringValue!
        expiresInMs = expires
    }
}

/// The front door's answer to a decision, revoke or remove (`POST
/// /v1/grants/{id}/decision`, `/v1/pairings/{id}/decision`,
/// `/v1/clients/{id}/revoke`, `/v1/nodes/{id}/remove`). Refusal codes are
/// data for the app to word (`replaces_changed`, `key_enrolled_as_other_name`,
/// `save_failed`, and codes a later front door adds); anything that is not
/// code-shaped is dropped, never shown or acted on.
public enum FrontDoorReply: Equatable {
    /// A 2xx. `state` is the reply's `state` when it is code-shaped (a 204 has none).
    case done(state: String?)
    /// Anything else: the HTTP status, the `error` code, and `retry_after` seconds when given.
    case refused(status: Int, code: String?, retryAfter: Int?)

    public init(status: Int, body: JSONValue?) {
        if (200...299).contains(status) {
            self = .done(state: FrontDoorRules.code(body?["state"]))
        } else {
            let retry = body?["retry_after"]?.intValue
            self = .refused(status: status, code: FrontDoorRules.code(body?["error"]), retryAfter: retry.flatMap { $0 >= 0 ? $0 : nil })
        }
    }

    /// The call went through (for revoke and remove, which answer 204).
    public var succeeded: Bool {
        if case .done = self { return true }
        return false
    }

    /// Only a 2xx whose `state` is exactly `expected` (`approved`, `denied`,
    /// `enrolled`) confirms a decision.
    public func confirms(_ expected: String) -> Bool {
        if case .done(let state?) = self { return ExactText.same(state, expected) }
        return false
    }

    /// `save_failed`: the front door asks for the same envelope again.
    public var isRetryable: Bool {
        if case .refused(_, let code?, _) = self { return ExactText.same(code, "save_failed") }
        return false
    }
}

/// One mirror break: `reason` is the recorded code (known or not), nil when
/// it is not code-shaped.
public struct AuditBreak: Equatable {
    public let seq: Int?
    public let reason: String?

    public init(seq: Int?, reason: String?) {
        self.seq = seq
        self.reason = reason
    }
}

/// `GET /v1/nodes/{node_id}/audit-status`: `{ head_seq, anchor, gaps, breaks }`.
/// Break reasons pass through as codes for the app to word (fork,
/// withheld_entries, oversize_entry, ... and any a later front door adds).
public struct AuditStatus: Equatable {
    static let maxRecords = 1000

    public let headSeq: Int
    public let anchorSeq: Int?
    public let gapCount: Int
    public let breaks: [AuditBreak]

    /// Any recorded break means the node's history can no longer be trusted as whole.
    public var broken: Bool { !breaks.isEmpty }

    public init(json: JSONValue) throws {
        guard let o = json.objectValue, let head = o["head_seq"]?.intValue, head >= 0,
              let anchor = o["anchor"], anchor.isNull || anchor["seq"]?.intValue != nil,
              let gaps = o["gaps"]?.arrayValue, let list = o["breaks"]?.arrayValue,
              gaps.count <= Self.maxRecords, list.count <= Self.maxRecords else {
            throw ProtocolError.malformed("the front door sent an audit status this app cannot read")
        }
        headSeq = head
        anchorSeq = anchor["seq"]?.intValue
        gapCount = gaps.count
        breaks = try list.map { entry in
            guard entry.objectValue != nil else { throw ProtocolError.malformed("an audit break is not an object") }
            return AuditBreak(seq: entry["seq"]?.intValue, reason: FrontDoorRules.code(entry["reason"]))
        }
    }
}

/// The front door's validators (src/frontdoor/protocol/messages.js) for the
/// types a phone writes or reads.
enum FrontDoorRules {
    typealias Fields = [String: JSONValue]

    static let byType: [String: (Fields) -> Bool] = [
        "kl.client.grant": grant,
        "kl.client.revoke": revoke,
        "kl.node.enroll": enroll,
        "kl.node.remove": remove,
        "kl.relay.repin": repin
    ]

    static let clientNameMax = 200
    static let uriMax = 2048
    static let clientIdMax = 512
    static let maxScopes = 32
    static let maxMachines = 64

    static func isLower(_ c: UInt8) -> Bool { c >= 0x61 && c <= 0x7A }
    static func isUpper(_ c: UInt8) -> Bool { c >= 0x41 && c <= 0x5A }
    static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }
    static func isOneOfBytes(_ c: UInt8, _ set: String) -> Bool { set.utf8.contains(c) }
    static func lowerASCII(_ c: UInt8) -> UInt8 { isUpper(c) ? c + 0x20 : c }

    /// A reply's reason or state code: lower-case ASCII, digits and `_`, at
    /// most 64; anything else is nil.
    static func code(_ v: JSONValue?) -> String? {
        guard let b = Rules.ascii(v), (1...64).contains(b.count), b.allSatisfy({ isLower($0) || isDigit($0) || $0 == 0x5F }) else { return nil }
        return v?.stringValue
    }

    static func prefixedToken(_ v: JSONValue?, _ prefix: String, _ length: Int) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        let p = Array(prefix.utf8)
        return b.count == p.count + length && Array(b[0..<p.count]) == p && b[p.count...].allSatisfy(Base64URL.isAlphabet)
    }

    static func isGrantId(_ v: JSONValue?) -> Bool { prefixedToken(v, "gr_", 22) }
    static func isPairingId(_ v: JSONValue?) -> Bool { prefixedToken(v, "pr_", 22) }
    static func isRawEd25519(_ v: JSONValue?) -> Bool { prefixedToken(v, "", 43) }
    static func isSpkiPin(_ v: JSONValue?) -> Bool { prefixedToken(v, "sha256/", 43) }

    static func isHex64(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return b.count == 64 && b.allSatisfy { isDigit($0) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    static func isHexDigit(_ c: UInt8) -> Bool { isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66) }

    /// One decimal IPv4 part: 0–255 without leading zeros (which WHATWG
    /// would read differently).
    static func isOctet(_ s: ArraySlice<UInt8>) -> Bool {
        guard (1...3).contains(s.count), s.allSatisfy(isDigit), !(s.count > 1 && s.first == 0x30) else { return false }
        return s.reduce(0) { $0 * 10 + Int($1 - 0x30) } <= 255
    }

    /// Exactly four decimal parts, each an octet.
    static func isIPv4(_ s: ArraySlice<UInt8>) -> Bool {
        let parts = s.split(separator: 0x2E, omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy(isOctet)
    }

    /// The front door's NUMERIC_LABEL_RE, `^([0-9]+|0x[0-9a-f]*)$` ignoring
    /// case: WHATWG reads a host whose last label is this as IPv4.
    static func isNumericLabel(_ s: ArraySlice<UInt8>) -> Bool {
        if !s.isEmpty && s.allSatisfy(isDigit) { return true }
        let b = Array(s)
        return b.count >= 2 && b[0] == 0x30 && (b[1] == 0x78 || b[1] == 0x58) && b.dropFirst(2).allSatisfy(isHexDigit)
    }

    /// An IPv6 address (the bytes between the brackets): groups of 1–4 hex
    /// digits, at most one `::`, eight groups (fewer only with `::`), and an
    /// optional dotted-quad tail that counts as two groups.
    static func isIPv6(_ inner: [UInt8]) -> Bool {
        guard let lastColon = inner.lastIndex(of: 0x3A) else { return false }
        var body = inner
        let tail = inner[(lastColon + 1)...]
        if tail.contains(0x2E) {
            guard isIPv4(tail) else { return false }
            body = Array(inner[...lastColon]) + Array("0:0".utf8)
        }
        guard !body.contains(0x2E) else { return false }
        /// The number of groups, or nil when one is not 1–4 hex digits.
        func groups(_ s: ArraySlice<UInt8>) -> Int? {
            if s.isEmpty { return 0 }
            let g = s.split(separator: 0x3A, omittingEmptySubsequences: false)
            return g.allSatisfy({ (1...4).contains($0.count) && $0.allSatisfy(FrontDoorRules.isHexDigit) }) ? g.count : nil
        }
        // The first `::`; a second one leaves an empty group on one side,
        // which groups() refuses.
        var gap: Int?
        for i in 0..<max(0, body.count - 1) where body[i] == 0x3A && body[i + 1] == 0x3A {
            gap = i
            break
        }
        guard let g = gap else { return groups(body[...]) == 8 }
        guard let left = groups(body[..<g]), let right = groups(body[(g + 2)...]) else { return false }
        return left + right <= 7
    }

    /// `host[:port]` with no userinfo: the host is ASCII letters, digits and
    /// `-` in non-empty dot-separated labels (a numeric last label only as a
    /// whole dotted-quad IPv4 address), or a bracketed IPv6 literal of valid
    /// structure; the port is 1–5 digits and at most 65535 (WHATWG refuses
    /// more).
    ///
    /// Ruling T35-punycode: a label that starts `xn--` but is not valid
    /// punycode passes here. The front door refuses it (WHATWG's IDNA step
    /// fails), so the phone at worst signs something the front door refuses;
    /// refusing every `xn--` label would refuse real IDN client_ids.
    static func isAuthority(_ a: [UInt8]) -> Bool {
        let host: ArraySlice<UInt8>
        let rest: ArraySlice<UInt8>
        if a.first == 0x5B {
            // [ … ] then an optional :port
            guard let close = a.firstIndex(of: 0x5D) else { return false }
            let inner = a[1..<close]
            guard inner.contains(0x3A), inner.allSatisfy({ isHexDigit($0) || $0 == 0x3A || $0 == 0x2E }), isIPv6(Array(inner)) else { return false }
            host = a[...close]
            rest = a[(close + 1)...]
        } else {
            let colon = a.firstIndex(of: 0x3A) ?? a.count
            host = a[..<colon]
            rest = a[colon...]
            guard !host.isEmpty, host.allSatisfy({ isLower($0) || isUpper($0) || isDigit($0) || $0 == 0x2D || $0 == 0x2E }),
                  !host.split(separator: 0x2E, omittingEmptySubsequences: false).contains(where: { $0.isEmpty }) else { return false }
            let lastLabel = host.split(separator: 0x2E, omittingEmptySubsequences: false).last ?? host
            guard !isNumericLabel(lastLabel) || isIPv4(host) else { return false }
        }
        guard !host.isEmpty else { return false }
        if rest.isEmpty { return true }
        let port = rest.dropFirst()
        guard rest.first == 0x3A, (1...5).contains(port.count), port.allSatisfy(isDigit) else { return false }
        return port.reduce(0) { $0 * 10 + Int($1 - 0x30) } <= 65535
    }

    /// An `https:` URL with a host, no userinfo and no fragment (the front
    /// door's isHttpsUrl). Stricter where parsers differ: the text must start
    /// `https://`, the authority must pass `isAuthority`, and URLComponents
    /// must read a host from it.
    static func isHttpsUrl(_ s: String, max: Int) -> Bool {
        let b = Array(s.utf8)
        guard !b.isEmpty, s.utf16.count <= max, !b.contains(0x23) else { return false }
        let scheme = Array("https://".utf8)
        guard b.count > scheme.count, zip(b.prefix(scheme.count), scheme).allSatisfy({ lowerASCII($0) == $1 }) else { return false }
        let authority = Array(b.dropFirst(scheme.count).prefix { $0 != 0x2F && $0 != 0x3F && $0 != 0x5C })
        guard isAuthority(authority) else { return false }
        guard let c = URLComponents(string: s), c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.fragment == nil else { return false }
        return true
    }

    static func isClientId(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return prefixedToken(v, "dcr_", 22) || isHttpsUrl(s, max: clientIdMax)
    }

    static func isUri(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return !s.isEmpty && s.utf16.count <= uriMax
    }

    static func isCodeChallenge(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return (43...128).contains(b.count) && b.allSatisfy(Base64URL.isAlphabet)
    }

    static func isUserCode(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return b.count == 6 && b.allSatisfy { FrontDoor.userCodeAlphabet.contains($0) }
    }

    /// `^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$`
    static func isScopeName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let colon = b.firstIndex(of: UInt8(ascii: ":")) else { return false }
        func part(_ p: ArraySlice<UInt8>, _ extra: String) -> Bool {
            guard let first = p.first, isLower(first), (1...32).contains(p.count) else { return false }
            return p.dropFirst().allSatisfy { isLower($0) || isDigit($0) || isOneOfBytes($0, extra) }
        }
        return part(b[..<colon], "-") && part(b[(colon + 1)...], "_-")
    }

    /// `^[a-z0-9][a-z0-9._-]{0,62}$`
    static func isMachineName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let first = b.first, isLower(first) || isDigit(first), b.count <= 63 else { return false }
        return b.dropFirst().allSatisfy { isLower($0) || isDigit($0) || isOneOfBytes($0, "._-") }
    }

    /// `^[A-Za-z0-9._-]{1,64}$`
    static func isNodeName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        return (1...64).contains(b.count) && b.allSatisfy { isLower($0) || isUpper($0) || isDigit($0) || isOneOfBytes($0, "._-") }
    }

    /// Strictly increasing (so sorted and unique), each passing `test`.
    static func sortedUnique(_ list: [JSONValue], minCount: Int, maxCount: Int, _ test: (String) -> Bool) -> Bool {
        guard (minCount...maxCount).contains(list.count) else { return false }
        var previous: String?
        for value in list {
            guard let s = value.stringValue, test(s) else { return false }
            if let p = previous, !JCS.utf16Less(p, s) { return false }
            previous = s
        }
        return true
    }

    static func isScopeList(_ v: JSONValue?) -> Bool {
        guard let list = v?.arrayValue, list.count <= maxScopes else { return false }
        var previous: String?
        for entry in list {
            guard let o = entry.objectValue, Rules.hasExactKeys(o, ["scope", "machines"]),
                  let scope = o["scope"]?.stringValue, isScopeName(scope) else { return false }
            if let p = previous, !JCS.utf16Less(p, scope) { return false }
            previous = scope
            if o["machines"]?.isNull != true {
                guard let machines = o["machines"]?.arrayValue, sortedUnique(machines, minCount: 1, maxCount: maxMachines, isMachineName) else { return false }
            }
        }
        return true
    }

    static func grant(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "grant_id", "client_id", "client_name", "redirect_uri", "resource",
                                     "code_challenge", "user_code", "scopes", "decision", "nonce", "device_id", "signed_at"]),
              Rules.isNodeId(m["frontdoor_id"]), isGrantId(m["grant_id"]), isClientId(m["client_id"]),
              Rules.withinLength(m["client_name"], clientNameMax), isUri(m["redirect_uri"]), isUri(m["resource"]),
              isCodeChallenge(m["code_challenge"]), isUserCode(m["user_code"]), isScopeList(m["scopes"]),
              let scopes = m["scopes"]?.arrayValue, let decision = m["decision"]?.stringValue,
              Rules.isNonce(m["nonce"]), Rules.isDeviceId(m["device_id"]), Rules.isTimestamp(m["signed_at"]) else { return false }
        return (ExactText.same(decision, "approve") && !scopes.isEmpty) || (ExactText.same(decision, "deny") && scopes.isEmpty)
    }

    static func revoke(_ m: Fields) -> Bool {
        Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "grant_id", "challenge", "device_id", "signed_at"])
            && Rules.isNodeId(m["frontdoor_id"]) && isGrantId(m["grant_id"]) && Rules.isNonce(m["challenge"])
            && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    static func enroll(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "pairing_id", "node_id", "node_name", "profile", "public_key",
                                     "tls_fingerprint", "replaces", "decision", "nonce", "device_id", "signed_at"]),
              let name = m["node_name"]?.stringValue else { return false }
        return Rules.isNodeId(m["frontdoor_id"]) && isPairingId(m["pairing_id"]) && Rules.isNodeId(m["node_id"]) && isNodeName(name)
            && Rules.isOneOf(m["profile"], ["agent", "runbook"]) && isRawEd25519(m["public_key"]) && isHex64(m["tls_fingerprint"])
            && (m["replaces"]?.isNull == true || Rules.isNodeId(m["replaces"])) && Rules.isOneOf(m["decision"], ["approve", "deny"])
            && Rules.isNonce(m["nonce"]) && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    static func remove(_ m: Fields) -> Bool {
        Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "node_id", "challenge", "device_id", "signed_at"])
            && Rules.isNodeId(m["frontdoor_id"]) && Rules.isNodeId(m["node_id"]) && Rules.isNonce(m["challenge"])
            && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    /// `old_spki ≠ new_spki` (§3.7): a re-pin to the same key is malformed.
    static func repin(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "relay", "old_spki", "new_spki", "created_at"]),
              let relay = m["relay"]?.stringValue, let oldSpki = m["old_spki"]?.stringValue, let newSpki = m["new_spki"]?.stringValue else { return false }
        return Rules.isNodeId(m["frontdoor_id"]) && isHttpsUrl(relay, max: uriMax) && isSpkiPin(m["old_spki"])
            && isSpkiPin(m["new_spki"]) && !ExactText.same(oldSpki, newSpki) && Rules.isTimestamp(m["created_at"])
    }
}
