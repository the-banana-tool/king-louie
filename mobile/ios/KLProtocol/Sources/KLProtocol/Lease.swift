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
    /// The phone whose grant made the lease (owner ruling R-F5-18): its
    /// device id, and the name the node knows it by when it gave one. Both
    /// nil while nobody has granted the lease.
    public let grantedByDevice: String?
    public let grantedByName: String?

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
        self.grantedByDevice = message["granted_by"]?["device_id"]?.stringValue
        self.grantedByName = message["granted_by"]?["name"]?.stringValue
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

/// What a phone made of one node's answer to "what is running" (owner
/// ruling R-F5-20). `accepted` means the pinned node signed, for this very
/// request and this phone, that the leases named are all it has to list;
/// `statuses` are then the signed statuses it names, in its order (none:
/// the node says nothing is running). Anything else is no answer at all,
/// and `reason` says what failed (`no_listing`: none came).
public struct ListingCheck: Equatable {
    public let accepted: Bool
    public let reason: String?
    public let statuses: [Envelope]

    public init(accepted: Bool, reason: String?, statuses: [Envelope]) {
        self.accepted = accepted
        self.reason = reason
        self.statuses = statuses
    }
}

public enum Leases {
    /// The reason a node gives when it suspended a lease because the phone
    /// that granted it had not been in touch (owner ruling R-F5-15). The
    /// node resumes it on that phone's next watch that echoes a recent
    /// contact token; nothing is extended.
    public static let noContact = "no_contact"

    /// Whether a signed state and reason say input is paused for want of contact.
    public static func isPausedForContact(state: String, reason: String?) -> Bool { state == "suspended" && reason == noContact }

    /// A lease that is running: it holds, or can get back, the right to
    /// click and type. Such a lease has a banner and a Stop (R-F5-18).
    public static func isLive(state: String) -> Bool { state == "active" || state == "suspended" }

    /// A lease that may still start (fourth security review, finding 3).
    /// Its node signed that it is waiting for a phone's answer, and this
    /// phone signed a grant for it that the node never confirmed. A relay
    /// can hold such a grant back (answering 503) and deliver it later, so
    /// the lease is not running and is not over either. It gets a row with
    /// a Stop, like a running one.
    public static func mayStillStart(state: String, signedGrant: Bool) -> Bool { state == "pending" && signedGrant }

    public static func mayStillStartTitle(nodeName: String) -> String { "May still start on \(Display.escape(nodeName))" }

    /// Under that row.
    public static let mayStillStartDetail = "This phone signed an Allow for it that the computer did not confirm. The relay could still deliver it. Stop cancels it."

    /// A lease its node says is waiting for a phone's answer, named in a
    /// listing this phone accepted, for which this phone remembers signing
    /// no grant (fifth security review, finding 1). The memory of what was
    /// signed is the app's own: it is gone after a restart, and another
    /// phone never had it. So such a phone cannot say the lease "may still
    /// start"; it says what it knows, and gives the same Stop (any enrolled
    /// phone's revoke ends a pending lease).
    public static func requestWaitingTitle(nodeName: String) -> String { "A request is waiting on \(Display.escape(nodeName))" }

    /// Under that row.
    public static let requestWaitingDetail = "Its computer says a request for computer use is waiting for a phone's answer. This phone does not remember allowing it. An Allow signed before this app was restarted, or on another phone, could still reach it. Stop cancels the request."

    /// What the row of a pending lease is called, and what is said under it.
    public static func pendingTitle(nodeName: String, signedGrant: Bool) -> String {
        signedGrant ? mayStillStartTitle(nodeName: nodeName) : requestWaitingTitle(nodeName: nodeName)
    }

    public static func pendingDetail(signedGrant: Bool) -> String { signedGrant ? mayStillStartDetail : requestWaitingDetail }

    /// Whether a lease that an accepted listing names gets a banner row
    /// for being pending. Nothing this phone remembers decides it: a
    /// pending lease gets one, unless the request itself is on screen with
    /// its Allow and Deny (`shownAsRequest`) and this phone signed no grant
    /// for it, which is a request nobody has answered yet.
    public static func listedPendingGetsRow(state: String, shownAsRequest: Bool, signedGrant: Bool) -> Bool {
        state == "pending" && (signedGrant || !shownAsRequest)
    }

    /// Whether such a row stays after a listing its node signed was
    /// accepted. `listedState`: the state the listing gives the lease, nil
    /// when it does not name it. Named: it stays while still pending (a
    /// live lease has its ordinary row, an ended one none). Not named: it
    /// stays until the request the grant answered has expired, and goes
    /// only then. Without an accepted listing nothing is dropped.
    public static func keepsMayStart(listedState: String?, requestExpired: Bool) -> Bool {
        guard let listedState else { return !requestExpired }
        return listedState == "pending"
    }

    /// What to say beside Stop for a lease another phone granted (R-F5-18):
    /// nil when this phone granted it or the node has not said who did.
    /// The text is escaped for display.
    public static func grantedByOther(device: String?, name: String?, thisDevice: String?) -> String? {
        guard let device, device != thisDevice else { return nil }
        if let name, !name.isEmpty { return "Granted by \(Display.escape(name))" }
        return "Granted by another phone (\(Display.escape(device)))"
    }

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

    /// The most leases a listing names (the node lists the live one and the
    /// four that ended last; LISTING_MAX in src/gui/lease-protocol.js).
    public static let listingMax = 8

    /// The shape of a kl.lease.listing, exactly as the node's own validator
    /// has it (VALIDATORS['kl.lease.listing'] in src/gui/lease-protocol.js;
    /// fourth security review): these seven keys and no other; v 1; a node
    /// id, a device id, a nonce of 32 bytes, a real time in `at`; at most
    /// `listingMax` leases, each `{ lease_id, seq }` and nothing else, a
    /// lowercase UUID v4 and an integer of at least 1, and no lease twice.
    static func isListing(_ message: JSONValue) -> Bool {
        guard let m = message.objectValue, Rules.hasExactKeys(m, ["v", "type", "node_id", "to_device", "nonce", "at", "leases"]),
              m["v"]?.intValue == 1, m["type"]?.stringValue == "kl.lease.listing",
              Rules.isNodeId(m["node_id"]), Rules.isDeviceId(m["to_device"]), Rules.isNonce(m["nonce"]), Rules.isTimestamp(m["at"]),
              let leases = m["leases"]?.arrayValue, leases.count <= listingMax else { return false }
        var seen = Set<String>()
        for entry in leases {
            guard let e = entry.objectValue, Rules.hasExactKeys(e, ["lease_id", "seq"]), Rules.isUuidV4(e["lease_id"]),
                  let leaseId = e["lease_id"]?.stringValue, let seq = e["seq"], Rules.isInteger(seq), let n = seq.intValue, n >= 1,
                  seen.insert(leaseId).inserted else { return false }
        }
        return true
    }

    /// One node's listing (R-F5-20), checked the way
    /// `verifyLeaseListing` in src/gui/lease-protocol.js does: the pinned
    /// node's signature over the received bytes; a kl.lease.listing of that
    /// node; the nonce this phone chose for this very request (so an answer
    /// to an earlier request cannot be played again); made for this phone;
    /// and, for every lease it names, a status of that lease with that seq
    /// which the same node signed, among `statuses` (so no entry can be
    /// left out or swapped for an older one). Statuses it does not name are
    /// not returned. The message's shape is checked in full first
    /// (`isListing`), after the signature and before anything is read from it.
    public static func verifyListing(_ envelope: Envelope, pin: NodePin, nonce: String, deviceId: String, statuses: [Envelope]) -> ListingCheck {
        func refused(_ reason: String) -> ListingCheck { ListingCheck(accepted: false, reason: reason, statuses: []) }
        guard envelope.alg == "Ed25519", envelope.kid == pin.id else { return refused("malformed") }
        guard envelope.verifyEd25519(spkiHex: pin.key) else { return refused("bad_signature") }
        guard let m = try? envelope.message(), isListing(m),
              let named = m["leases"]?.arrayValue, let signedNonce = m["nonce"]?.stringValue,
              let toDevice = m["to_device"]?.stringValue else { return refused("malformed") }
        guard m["node_id"]?.stringValue == pin.id else { return refused("wrong_node") }
        guard !nonce.isEmpty, signedNonce == nonce else { return refused("nonce_mismatch") }
        guard toDevice == deviceId else { return refused("wrong_device") }
        var signed: [(status: LeaseStatus, envelope: Envelope)] = []
        for candidate in statuses {
            if let message = verifiedMessage(candidate, pin: pin), let status = LeaseStatus(message: message) {
                signed.append((status: status, envelope: candidate))
            }
        }
        var listed: [Envelope] = []
        for entry in named {
            guard let leaseId = entry["lease_id"]?.stringValue, let seq = entry["seq"]?.intValue else { return refused("malformed") }
            guard let match = signed.first(where: { $0.status.leaseId == leaseId && $0.status.seq == seq }) else { return refused("status_missing") }
            listed.append(match.envelope)
        }
        return ListingCheck(accepted: true, reason: nil, statuses: listed)
    }

    /// The same check on the relay's reply to `GET /v1/leases?nonce=…` for
    /// one pinned node: its entries without a request are its listing
    /// (`listing`) and the statuses beside it (`status`). No listing among
    /// them is `no_listing`: the node is offline, slow or older, or the relay
    /// kept its answer back; this phone cannot tell which.
    public static func checkListing(_ entries: [JSONValue], pin: NodePin, nonce: String, deviceId: String) -> ListingCheck {
        var listing: Envelope?
        var statuses: [Envelope] = []
        for entry in entries where entry["node_id"]?.stringValue == pin.id && (entry["envelope"]?.isNull ?? true) {
            if listing == nil, let json = entry["listing"], let envelope = try? Envelope(json: json) { listing = envelope }
            if let json = entry["status"], let envelope = try? Envelope(json: json) { statuses.append(envelope) }
        }
        guard let listing else { return ListingCheck(accepted: false, reason: "no_listing", statuses: []) }
        return verifyListing(listing, pin: pin, nonce: nonce, deviceId: deviceId, statuses: statuses)
    }

    /// What a phone says of a pinned node it has no accepted listing from
    /// (R-F5-20). Never "nothing is running": this phone does not know.
    public static func couldNotConfirm(nodeName: String) -> String { "Could not confirm with \(Display.escape(nodeName))" }

    /// Under those rows: what it means and what it does not.
    public static let couldNotConfirmDetail = "No signed answer about computer use came from there. It may be off or out of reach, or the relay may be keeping its answer back. A lease could be running."

    /// What a phone says of a pinned node it has not asked yet (fourth
    /// security review, finding 2). Not "nothing is running": nothing has
    /// been checked.
    public static func notCheckedYet(nodeName: String) -> String { "Not checked yet: \(Display.escape(nodeName))" }

    /// Under those rows.
    public static let notCheckedYetDetail = "This phone has not asked there about computer use yet, so it does not know whether a session is running."

    /// What a phone says of a pinned node whose listing it accepted
    /// (`checkListing`), and only of such a node: `time` is when this phone
    /// accepted it, by its own clock, so an old answer never reads as a
    /// current one. `running` counts the leases it listed that are live,
    /// `waiting` those still waiting for a phone's answer.
    public static func checked(nodeName: String, at time: String, running: Int, waiting: Int) -> String {
        let sessions = running == 0 ? "no computer-use session" : (running == 1 ? "1 computer-use session running" : "\(running) computer-use sessions running")
        let requests = waiting == 0 ? "" : (waiting == 1 ? "; 1 request waiting for an answer" : "; \(waiting) requests waiting for an answer")
        return "Checked \(Display.escape(nodeName)) at \(time): \(sessions)\(requests)"
    }

    /// The statuses an accepted listing names, read. None for a listing
    /// that was not accepted: such a listing says nothing.
    public static func listedStatuses(_ check: ListingCheck, pin: NodePin) -> [LeaseStatus] {
        guard check.accepted else { return [] }
        return check.statuses.compactMap { envelope in verifiedMessage(envelope, pin: pin).flatMap { LeaseStatus(message: $0) } }
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
