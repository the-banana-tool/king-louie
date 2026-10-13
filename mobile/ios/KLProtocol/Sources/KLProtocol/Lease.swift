import Foundation

/// Fleet stage 5 (docs/protocol/lease-v1.md): computer-use leases. The node
/// signs requests, statuses and views; the phone signs grants, denies,
/// revokes and watches. Everything shown comes from a message whose node
/// signature verified against the node key pinned at enrollment.
public struct LeaseApp: Equatable, Identifiable {
    public let id: String
    public let name: String
    public let path: String
    public let processes: [String]

    public init(id: String, name: String, path: String, processes: [String]) {
        self.id = id
        self.name = name
        self.path = path
        self.processes = processes
    }
}

public struct LeaseRequest: Equatable, Identifiable {
    public static let messageType = "kl.lease.request"
    public var id: String { requestId }
    public let requestId: String
    public let leaseId: String
    public let nodeId: String
    public let nodeName: String
    public let jobId: String
    public let apps: [LeaseApp]
    public let maxMinutes: Int
    public let reason: String
    public let resumes: String?
    public let limits: [String]
    public let originClient: String
    public let leaseHash: String
    public let nonce: String
    public let createdAt: String
    public let expiresAt: String

    public var isResume: Bool { resumes != nil }

    /// nil unless `message` is a complete kl.lease.request whose lease_hash is the hash of its lease.
    public init?(message: JSONValue) {
        guard message["type"]?.stringValue == Self.messageType, message["v"]?.intValue == 1,
              let requestId = message["request_id"]?.stringValue, let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let nodeName = message["node_name"]?.stringValue,
              let lease = message["lease"], let leaseHash = message["lease_hash"]?.stringValue,
              let nonce = message["nonce"]?.stringValue, let createdAt = message["created_at"]?.stringValue,
              let expiresAt = message["expires_at"]?.stringValue,
              lease["kind"]?.stringValue == "computer_use", let jobId = lease["job_id"]?.stringValue,
              let maxMinutes = lease["max_minutes"]?.intValue, (1...60).contains(maxMinutes),
              let reason = lease["reason"]?.stringValue, let appList = lease["apps"]?.arrayValue, !appList.isEmpty,
              Digest.sha256B64url(JCS.data(lease)) == leaseHash else { return nil }
        var apps: [LeaseApp] = []
        for a in appList {
            guard let id = a["id"]?.stringValue, let name = a["name"]?.stringValue, let path = a["path"]?.stringValue,
                  let procs = a["processes"]?.arrayValue else { return nil }
            apps.append(LeaseApp(id: id, name: name, path: path, processes: procs.compactMap { $0.stringValue }))
        }
        self.requestId = requestId
        self.leaseId = leaseId
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.jobId = jobId
        self.apps = apps
        self.maxMinutes = maxMinutes
        self.reason = reason
        self.resumes = lease["resumes"]?.stringValue
        self.limits = (lease["limits"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.originClient = message["origin"]?["client"]?.stringValue ?? ""
        self.leaseHash = leaseHash
        self.nonce = nonce
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct LeaseStatus: Equatable {
    public static let messageType = "kl.lease.status"
    public let leaseId: String
    public let nodeId: String
    public let seq: Int
    public let state: String
    public let locked: Bool
    public let reason: String?
    public let expiresAt: String?
    /// The token this status carries for the phone's next watch to echo
    /// (owner ruling R-F5-15); nil when the message holds none.
    public let contactToken: String?

    public init?(message: JSONValue) {
        guard message["type"]?.stringValue == Self.messageType, let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let seq = message["seq"]?.intValue,
              let state = message["state"]?.stringValue, let locked = message["locked"]?.boolValue else { return nil }
        self.leaseId = leaseId
        self.nodeId = nodeId
        self.seq = seq
        self.state = state
        self.locked = locked
        self.reason = message["reason"]?.stringValue
        self.expiresAt = message["expires_at"]?.stringValue
        self.contactToken = message["contact_token"]?.stringValue
    }
}

public struct LeaseAction: Equatable, Identifiable {
    public var id: Int { seq }
    public let seq: Int
    public let at: String
    public let tool: String
    public let summary: String
    public let result: String

    public init(seq: Int, at: String, tool: String, summary: String, result: String) {
        self.seq = seq
        self.at = at
        self.tool = tool
        self.summary = summary
        self.result = result
    }
}

public struct LeaseView: Equatable {
    public let leaseId: String
    public let nodeId: String
    public let seq: Int
    public let toDevice: String
    public let state: String
    public let locked: Bool
    public let remainingS: Int
    public let foregroundAppId: String?
    public let foregroundMatches: Bool
    public let frame: Data?
    public let frameDropped: Bool
    public let actions: [LeaseAction]
    /// The token this view carries for the phone's next watch to echo (R-F5-15).
    public let contactToken: String?
}

public enum Leases {
    /// The reason a node gives when it suspended a lease because the phone
    /// that granted it had not been in touch (owner ruling R-F5-15). The
    /// node resumes it on that phone's next watch that echoes a recent
    /// contact token; nothing is extended.
    public static let noContact = "no_contact"

    /// Whether a signed state and reason say input is paused for want of contact.
    public static func isPausedForContact(state: String, reason: String?) -> Bool { state == "suspended" && reason == noContact }

    /// Order and addressee (owner ruling R-F5-16). A node numbers the
    /// statuses and views of one lease with one rising `seq`. A relay can
    /// hold a message back and deliver it later, or hand one phone a view
    /// made for another; so a status or view is applied only if its seq is
    /// newer than the newest one already applied for that lease, and a view
    /// only if it is addressed to this device. Anything else is dropped.
    public static func acceptsStatus(_ status: LeaseStatus, appliedSeq: Int) -> Bool { status.seq > appliedSeq }

    public static func acceptsView(_ view: LeaseView, appliedSeq: Int, deviceId: String) -> Bool { view.seq > appliedSeq && view.toDevice == deviceId }

    /// A view larger than this is dropped unread (§4.1).
    public static let viewMaxBytes = 262144

    /// The live screen keeps this many actions, newest first (§3.10).
    public static let actionsKept = 200

    /// The request's own apps, in its order, kept only if the owner left them on.
    public static func grant(to request: LeaseRequest, apps: [String], minutes: Int, deviceId: String, signedAt: String) throws -> JSONValue {
        let chosen = Set(apps)
        guard !chosen.isEmpty, chosen.isSubset(of: Set(request.apps.map { $0.id })) else { throw ProtocolError.malformed("pick at least one of the requested apps") }
        guard (1...request.maxMinutes).contains(minutes) else { throw ProtocolError.malformed("minutes must be 1–\(request.maxMinutes)") }
        let ordered = request.apps.map { $0.id }.filter { chosen.contains($0) }
        return decision(request, decision: "grant",
                        grant: .object(["apps": .array(ordered.map { JSONValue.string($0) }), "minutes": .number(String(minutes))]),
                        deviceId: deviceId, signedAt: signedAt)
    }

    public static func deny(_ request: LeaseRequest, deviceId: String, signedAt: String) -> JSONValue {
        decision(request, decision: "deny", grant: .null, deviceId: deviceId, signedAt: signedAt)
    }

    private static func decision(_ request: LeaseRequest, decision: String, grant: JSONValue, deviceId: String, signedAt: String) -> JSONValue {
        .object([
            "v": .number("1"),
            "type": .string("kl.lease.grant"),
            "request_id": .string(request.requestId),
            "lease_id": .string(request.leaseId),
            "node_id": .string(request.nodeId),
            "lease_hash": .string(request.leaseHash),
            "nonce": .string(request.nonce),
            "decision": .string(decision),
            "grant": grant,
            "expires_at": .string(request.expiresAt),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ])
    }

    public static func revoke(nodeId: String, leaseId: String, reason: String = "kill_switch", deviceId: String, nonce: String, signedAt: String) -> JSONValue {
        .object([
            "v": .number("1"), "type": .string("kl.lease.revoke"), "node_id": .string(nodeId), "lease_id": .string(leaseId),
            "reason": .string(reason), "device_id": .string(deviceId), "nonce": .string(nonce), "signed_at": .string(signedAt)
        ])
    }

    /// `contactToken`: the token of the newest status or view of this lease
    /// that this phone has applied, or nil when it has applied none (the
    /// message then carries null). The node counts a watch as contact only
    /// when it echoes a token it issued recently (R-F5-15): that shows the
    /// watch was signed after the node sent that message.
    public static func watch(nodeId: String, leaseId: String, deviceId: String, contactToken: String?, nonce: String, signedAt: String) -> JSONValue {
        let token: JSONValue = contactToken.map { JSONValue.string($0) } ?? JSONValue.null
        return .object([
            "v": .number("1"), "type": .string("kl.lease.watch"), "node_id": .string(nodeId), "lease_id": .string(leaseId),
            "device_id": .string(deviceId), "contact_token": token, "nonce": .string(nonce), "signed_at": .string(signedAt)
        ])
    }

    /// A node-signed message (request, status or view) whose signature, kid
    /// and node_id are all the pinned node's; nil otherwise.
    public static func verifiedMessage(_ envelope: Envelope, pin: NodePin) -> JSONValue? {
        guard envelope.alg == "Ed25519", envelope.kid == pin.id, envelope.verifyEd25519(spkiHex: pin.key),
              let message = try? envelope.message(), message["node_id"]?.stringValue == pin.id else { return nil }
        return message
    }

    public static func verifyView(_ envelope: Envelope, pin: NodePin) -> (accepted: Bool, reason: String?, view: LeaseView?) {
        guard let bytes = try? envelope.payloadData() else { return (false, "malformed", nil) }
        guard bytes.count <= viewMaxBytes else { return (false, "too_large", nil) }
        guard envelope.alg == "Ed25519", envelope.kid == pin.id else { return (false, "malformed", nil) }
        guard envelope.verifyEd25519(spkiHex: pin.key) else { return (false, "bad_signature", nil) }
        guard let m = try? envelope.message(), m["type"]?.stringValue == "kl.lease.view" else { return (false, "malformed", nil) }
        guard m["node_id"]?.stringValue == pin.id else { return (false, "wrong_node", nil) }
        var frame: Data?
        if let f = m["frame"], !f.isNull {
            guard let text = f["data"]?.stringValue, let data = Data(base64Encoded: text), let hash = f["sha256"]?.stringValue else { return (false, "malformed", nil) }
            guard Digest.sha256B64url(data) == hash else { return (false, "frame_hash_mismatch", nil) }
            frame = data
        }
        guard let leaseId = m["lease_id"]?.stringValue, let seq = m["seq"]?.intValue, let state = m["state"]?.stringValue,
              let toDevice = m["to_device"]?.stringValue else { return (false, "malformed", nil) }
        let actions: [LeaseAction] = (m["actions"]?.arrayValue ?? []).compactMap { a -> LeaseAction? in
            guard let s = a["seq"]?.intValue, let at = a["at"]?.stringValue, let tool = a["tool"]?.stringValue,
                  let summary = a["summary"]?.stringValue, let result = a["result"]?.stringValue else { return nil }
            return LeaseAction(seq: s, at: at, tool: tool, summary: summary, result: result)
        }
        let view = LeaseView(leaseId: leaseId, nodeId: pin.id, seq: seq, toDevice: toDevice, state: state, locked: m["locked"]?.boolValue ?? false,
                             remainingS: m["remaining_s"]?.intValue ?? 0, foregroundAppId: m["foreground"]?["app_id"]?.stringValue,
                             foregroundMatches: m["foreground"]?["matches"]?.boolValue ?? false, frame: frame,
                             frameDropped: m["frame_dropped"]?.boolValue ?? false, actions: actions,
                             contactToken: m["contact_token"]?.stringValue)
        return (true, nil, view)
    }

    /// The live screen's action log after a view: each action once (by its
    /// `seq`; a view's copy replaces an older one), newest first, at most
    /// `actionsKept`. A node sends actions again when a watch starts over
    /// (after it lapsed), so two views can carry the same action.
    public static func mergedActions(_ shown: [LeaseAction], adding fresh: [LeaseAction]) -> [LeaseAction] {
        var bySeq: [Int: LeaseAction] = [:]
        for action in shown { bySeq[action.seq] = action }
        for action in fresh { bySeq[action.seq] = action }
        return Array(bySeq.values.sorted { $0.seq > $1.seq }.prefix(actionsKept))
    }
}
