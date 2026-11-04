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
    /// Revised 2026-10-24 (agent-driven demo takes): `computer_use` or `take`; revised 2026-11-03: or `task`.
    public let kind: String
    /// A take's or a task's name (one plain line, 1–60 characters); nil for computer_use.
    public let name: String?
    /// The hosts a take may visit, or a task may act on (a task may have none); empty for computer_use.
    public let sites: [String]
    /// A take's browser allowance: nil when it is `true` (browser actions on
    /// its sites), else the browser actions it may use. nil for computer_use.
    public let browserActions: [String]?
    /// Whether a take may fill credentials from the vault; false for computer_use.
    public let credentials: Bool
    /// Whether a take runs with no contact window (a task always does); false for computer_use.
    public let unattended: Bool
    /// Revised 2026-11-03 (tasks stage 1): what a task may do (`taskAllows`, sorted; empty on the card that raises a look-only task's spend). Empty for the other kinds.
    public let allows: [String]
    /// The most a task may spend, in whole dollars (2–500); 0 for the other kinds.
    public let usd: Int

    public var isResume: Bool { resumes != nil }
    public var isTake: Bool { kind == "take" }
    public var isTask: Bool { kind == "task" }

    /// `check`'s request: nil unless it can be answered.
    public init?(message: JSONValue, open: Opener? = nil, sealedSeen: Set<String>) {
        guard let request = Self.check(message, open: open, sealedSeen: sealedSeen).request else { return nil }
        self = request
    }

    /// A complete kl.lease.request whose lease_hash is the hash of its lease (the
    /// salted one when it came sealed, R-SP-2), and whose lease has exactly the keys
    /// of its kind (`Leases.isLease`); else the reason: `malformed`,
    /// `lease_hash_mismatch`, `not_recipient`, `open_failed`, `key_locked`,
    /// `clear_after_sealed`. `message` has passed the node's signature: only then
    /// may `open` read it.
    public static func check(_ message: JSONValue, open: Opener? = nil, sealedSeen: Set<String>) -> LeaseRequestCheck {
        func refused(_ reason: String, _ seal: SealState = .clear) -> LeaseRequestCheck { LeaseRequestCheck(request: nil, reason: reason, seal: seal) }
        guard message["type"]?.stringValue == messageType, message["v"]?.intValue == 1 else { return refused("malformed") }
        if Seal.clearRefused(type: messageType, message: message, sealedSeen: sealedSeen) { return refused(Seal.clearAfterSealed) }
        if message["sealed"] != nil && !Leases.isSealedRequest(message) { return refused("malformed") }
        guard let read = Seal.read(type: messageType, message: message, open: open) else { return refused("malformed", .unread) }
        guard read.opened else { return refused(read.reason ?? "malformed", read.state) }
        let opened = read.state == .opened
        if opened, let problem = Leases.openedRequestProblem(read.message) { return refused(problem, read.state) }
        guard let request = LeaseRequest(parsed: read.message, saltedHashHeld: opened) else {
            return refused(!opened && hashDiffers(read.message) ? "lease_hash_mismatch" : "malformed", read.state)
        }
        return LeaseRequestCheck(request: request, reason: nil, seal: read.state)
    }

    /// Whether a clear request's lease is well formed but not the one it hashed.
    private static func hashDiffers(_ message: JSONValue) -> Bool {
        guard let lease = message["lease"], Leases.isLease(lease), let hash = message["lease_hash"]?.stringValue else { return false }
        return Digest.sha256B64url(JCS.data(lease)) != hash
    }

    /// `saltedHashHeld`: a sealed request's hash, which `Leases.openedRequestProblem` has held to the lease with its salt.
    private init?(parsed message: JSONValue, saltedHashHeld: Bool) {
        guard let requestId = message["request_id"]?.stringValue, let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let nodeName = message["node_name"]?.stringValue,
              let lease = message["lease"], let leaseHash = message["lease_hash"]?.stringValue,
              let nonce = message["nonce"]?.stringValue, let createdAt = message["created_at"]?.stringValue,
              let expiresAt = message["expires_at"]?.stringValue,
              Leases.isLease(lease), let kind = lease["kind"]?.stringValue, let jobId = lease["job_id"]?.stringValue,
              let maxMinutes = lease["max_minutes"]?.intValue,
              let reason = lease["reason"]?.stringValue,
              saltedHashHeld || Digest.sha256B64url(JCS.data(lease)) == leaseHash else { return nil }
        // A task has no apps; every other kind has at least one.
        let task = kind == "task"
        var apps: [LeaseApp] = []
        if !task {
            guard let appList = lease["apps"]?.arrayValue, !appList.isEmpty else { return nil }
            for a in appList {
                guard let id = a["id"]?.stringValue, let name = a["name"]?.stringValue, let path = a["path"]?.stringValue,
                      let procs = a["processes"]?.arrayValue else { return nil }
                apps.append(LeaseApp(id: id, name: name, path: path, processes: procs.compactMap { $0.stringValue }))
            }
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
        self.kind = kind
        let take = kind == "take"
        self.name = take || task ? lease["name"]?.stringValue : nil
        self.sites = take || task ? (lease["sites"]?.arrayValue ?? []).compactMap { $0.stringValue } : []
        let browserList: [JSONValue]? = take ? lease["browser"]?.arrayValue : nil
        self.browserActions = browserList.map { list in list.compactMap { $0.stringValue } }
        self.credentials = take && lease["credentials"]?.boolValue == true
        self.unattended = (take || task) && lease["unattended"]?.boolValue == true
        self.allows = task ? (lease["allows"]?.arrayValue ?? []).compactMap { $0.stringValue } : []
        self.usd = task ? (lease["usd"]?.intValue ?? 0) : 0
    }
}

/// One read of a kl.lease.request: the request when it can be answered, else why not.
public struct LeaseRequestCheck: Equatable {
    public let request: LeaseRequest?
    public let reason: String?
    public let seal: SealState

    public init(request: LeaseRequest?, reason: String?, seal: SealState = .clear) {
        self.request = request
        self.reason = reason
        self.seal = seal
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
    /// Revised 2026-10-24: the lease's kind, whether it runs unattended
    /// (always false for computer_use), and a take's or a task's name (nil
    /// for computer_use). A status without them, or whose three do not agree, is
    /// not read (the node's VALIDATORS['kl.lease.status']).
    public let kind: String
    public let unattended: Bool
    public let name: String?
    /// `.unread`: sealed and its name not read, so `name` is nil whatever the
    /// kind; every other field is the clear part's (R-SP-9).
    public let seal: SealState

    /// `message` has passed the node's signature: only then may `open` read it.
    /// Every field but the name is read from its clear part. A status sealed in
    /// the right shape is never dropped for what is inside: content that is
    /// malformed, a bad name, a locked phone or a wrap that does not open leave the
    /// clear part, so a phone cannot say no session is running while one is.
    public init?(message: JSONValue, open: Opener? = nil) {
        guard message["type"]?.stringValue == Self.messageType,
              message["sealed"] == nil || Seal.isSealedShape(type: Self.messageType, message: message),
              let leaseId = message["lease_id"]?.stringValue,
              let nodeId = message["node_id"]?.stringValue, let seq = message["seq"]?.intValue,
              let state = message["state"]?.stringValue, let locked = message["locked"]?.boolValue,
              let kind = message["kind"]?.stringValue, Leases.leaseKinds.contains(kind),
              let unattended = message["unattended"]?.boolValue, kind != "computer_use" || !unattended else { return nil }
        var shownName: String?
        var sealState = SealState.unread
        if let read = Seal.read(type: Self.messageType, message: message, open: open), read.opened {
            let nameValue = read.message["name"]
            let fits = nameValue.map { kind == "computer_use" ? $0.isNull : Leases.isTakeName($0) } ?? false
            if fits {
                shownName = nameValue?.stringValue
                sealState = read.state
            } else if read.state == .clear {
                return nil
            }
        }
        self.kind = kind
        self.unattended = unattended
        self.name = shownName
        self.seal = sealState
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
    /// `.unread`: sealed and not this phone's to open, so no frame, foreground or actions: the clear part alone.
    public var seal: SealState = .clear
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

    /// The same, for a task's lease.
    public static let taskRequestWaitingDetail = "Its computer says a request for a task is waiting for a phone's answer. This phone does not remember allowing it. An Allow signed before this app was restarted, or on another phone, could still reach it. Stop cancels the request."

    /// What the row of a pending lease is called, and what is said under it.
    public static func pendingTitle(nodeName: String, signedGrant: Bool) -> String {
        signedGrant ? mayStillStartTitle(nodeName: nodeName) : requestWaitingTitle(nodeName: nodeName)
    }

    public static func pendingDetail(signedGrant: Bool, task: Bool = false) -> String { signedGrant ? mayStillStartDetail : (task ? taskRequestWaitingDetail : requestWaitingDetail) }

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

    // MARK: the lease, by kind (revised 2026-10-24; checkLease in src/gui/lease-protocol.js)

    /// The most minutes a computer_use lease asks for (MAX_MINUTES), and a take or a task (TAKE_MAX_MINUTES).
    public static let maxMinutes = 60
    public static let takeMaxMinutes = 240
    static let leaseKinds = ["computer_use", "take", "task"]

    /// Revised 2026-11-03 (tasks stage 1): what a task may do, and what it may spend in whole dollars.
    public static let taskAllows = ["browser-act", "files-write", "logins", "shell"]
    public static let taskUsdMin = 2
    public static let taskUsdMax = 500

    /// A lease has exactly the keys of its kind (LEASE_KEYS).
    static let leaseKeys: [String: [String]] = [
        "computer_use": ["kind", "job_id", "apps", "max_minutes", "reason", "resumes", "limits"],
        "take": ["kind", "job_id", "name", "sites", "apps", "browser", "credentials", "max_minutes", "unattended", "reason", "resumes", "limits"],
        "task": ["kind", "job_id", "name", "sites", "allows", "max_minutes", "usd", "unattended", "reason", "resumes", "limits"]
    ]
    static let leaseLimits = ["no_lock_detect", "no_human_yield"]

    /// A list of strings, at most `max`, each passing `each` (isStringList).
    static func isStringList(_ v: JSONValue?, _ max: Int, _ each: (String) -> Bool) -> Bool {
        guard let list = v?.arrayValue, list.count <= max else { return false }
        return list.allSatisfy { item in item.stringValue.map(each) ?? false }
    }

    /// APP_ID_RE: ^[a-z][a-z0-9-]{0,31}$
    static func isAppId(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...32).contains(b.count), b[0] >= 0x61 && b[0] <= 0x7A else { return false }
        return b.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == UInt8(ascii: "-") }
    }

    /// SITE_RE: ^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$ (a lower-case host, `*.` for its subdomains).
    static func isSite(_ s: String) -> Bool {
        var b = Array(s.utf8)
        if b.count >= 2, b[0] == UInt8(ascii: "*"), b[1] == UInt8(ascii: ".") { b.removeFirst(2) }
        let labels = b.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            !label.isEmpty && label.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == UInt8(ascii: "-") }
        }
    }

    /// One plain line: plainLineProblem in src/cases/hidden-chars.js, whole.
    /// Refused: every hidden code point (HIDDEN_RANGES, which lies inside
    /// approval-v1 §5's table, `Display.isHidden`), U+FFF9–U+FFFC, every
    /// space or blank that is not U+0020, two U+0020 in a row, and more than
    /// three combining marks (\p{M}) in a row.
    public static func isPlainLine(_ text: String) -> Bool {
        var spaces = 0
        var marks = 0
        for scalar in text.unicodeScalars {
            let v = scalar.value
            if Display.isHidden(v) || (0xFFF9...0xFFFC).contains(v) { return false }
            if v == 0x00A0 || v == 0x1680 || (0x2000...0x200A).contains(v) || v == 0x202F || v == 0x205F || v == 0x2800 || v == 0x3000 { return false }
            spaces = v == 0x20 ? spaces + 1 : 0
            if spaces > 1 { return false }
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: marks += 1
            default: marks = 0
            }
            if marks > 3 { return false }
        }
        return true
    }

    /// A take's or a task's name: 1–60 characters, one plain line (checkLeaseName).
    static func isTakeName(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue, !s.isEmpty, Rules.withinLength(v, 60) else { return false }
        return isPlainLine(s)
    }

    static func isApp(_ v: JSONValue) -> Bool {
        guard let a = v.objectValue, Rules.hasExactKeys(a, ["id", "name", "path", "processes"]),
              let id = a["id"]?.stringValue, isAppId(id) else { return false }
        return Rules.withinLength(a["name"], 64) && Rules.withinLength(a["path"], 1024)
            && isStringList(a["processes"], 16, { $0.unicodeScalars.count <= 1024 })
    }

    /// The most a sealed request's window may be (REQUEST_TTL_MS).
    private static let requestTtlMs: Int64 = 5 * 60 * 1000

    /// What a kl.lease.request holds in clear (requestClearFields).
    private static func requestClearFields(_ m: [String: JSONValue]) -> Bool {
        guard Rules.isUuidV4(m["request_id"]), Rules.isUuidV4(m["lease_id"]), Rules.isNodeId(m["node_id"]), Rules.withinLength(m["node_name"], 64),
              Rules.isHash(m["lease_hash"]), Rules.isNonce(m["nonce"]),
              let created = m["created_at"]?.stringValue.flatMap(Timestamps.epochMillis),
              let expires = m["expires_at"]?.stringValue.flatMap(Timestamps.epochMillis) else { return false }
        return expires > created && expires - created <= requestTtlMs
    }

    /// The sealed shape of a request (VALIDATORS['kl.lease.request']).
    static func isSealedRequest(_ message: JSONValue) -> Bool {
        guard let m = message.objectValue else { return false }
        return Seal.isSealedShape(type: LeaseRequest.messageType, message: message) && requestClearFields(m) && Rules.isDeviceJwk(m["node_box"])
    }

    /// checkOrigin.
    private static func isOrigin(_ v: JSONValue?) -> Bool {
        guard let o = v?.objectValue, Rules.hasExactKeys(o, ["client", "session", "job_id"]), o["client"]?.stringValue != nil else { return false }
        return o.values.allSatisfy { $0.isNull || Rules.withinLength($0, 200) }
    }

    /// A sealed request after opening (clear part and content together): nil, or
    /// `malformed`, or `lease_hash_mismatch` before anything is shown (R-SP-2).
    /// validateOpenedLeaseRequest in src/gui/lease-protocol.js.
    static func openedRequestProblem(_ message: JSONValue) -> String? {
        guard var m = message.objectValue else { return "malformed" }
        let salt = m.removeValue(forKey: "salt")
        let nodeBox = m.removeValue(forKey: "node_box")
        let keys = ["v", "type", "request_id", "lease_id", "node_id", "node_name", "lease", "lease_hash", "origin", "created_at", "expires_at", "nonce"]
        guard Rules.hasExactKeys(m, keys), requestClearFields(m), isLease(m["lease"]), isOrigin(m["origin"]),
              let lease = m["lease"], let leaseId = m["lease_id"]?.stringValue else { return "malformed" }
        if let resumes = lease["resumes"], !resumes.isNull {
            guard let resumed = resumes.stringValue, ExactText.same(resumed, leaseId) else { return "malformed" }
        }
        guard Rules.isDeviceJwk(nodeBox), Rules.isHash(salt), let saltText = salt?.stringValue, let hash = m["lease_hash"]?.stringValue,
              let recomputed = try? Seal.saltedHash(salt: saltText, value: lease) else { return "malformed" }
        return ExactText.same(recomputed, hash) ? nil : "lease_hash_mismatch"
    }

    /// The fields only a take has (checkTakeFields).
    static func isTakeFields(_ l: [String: JSONValue]) -> Bool {
        guard isTakeName(l["name"]),
              isStringList(l["sites"], 32, isSite), let sites = l["sites"]?.arrayValue, !sites.isEmpty,
              l["credentials"]?.boolValue != nil, l["unattended"]?.boolValue != nil else { return false }
        if l["browser"]?.boolValue == true { return true }
        guard isStringList(l["browser"], 64, { !$0.isEmpty }), let browser = l["browser"]?.arrayValue else { return false }
        return !browser.isEmpty
    }

    /// The fields only a task has beside its name (checkTaskFields): the
    /// hosts it may act on (none for a shell-only grant), what it may do,
    /// sorted, each once (empty only on the card that raises a look-only
    /// task's spend), the most it may spend. Always unattended, and it never
    /// resumes.
    static func isTaskFields(_ l: [String: JSONValue]) -> Bool {
        guard isTakeName(l["name"]), isStringList(l["sites"], 32, isSite),
              // A class with no words on the card is not read: Allow signs what the card shows.
              isStringList(l["allows"], taskAllows.count, { taskAllows.contains($0) && taskMayWords($0) != nil }),
              let allows = l["allows"]?.arrayValue?.compactMap({ $0.stringValue }),
              let usd = l["usd"], Rules.isInteger(usd), let dollars = usd.intValue, (taskUsdMin...taskUsdMax).contains(dollars),
              l["unattended"]?.boolValue == true, l["resumes"]?.isNull == true else { return false }
        for i in allows.indices.dropFirst() where !(allows[i - 1] < allows[i]) { return false }
        return true
    }

    /// 1–8 apps, each once (checkApps).
    static func isApps(_ v: JSONValue?) -> Bool {
        guard let apps = v?.arrayValue, (1...8).contains(apps.count), apps.allSatisfy(isApp) else { return false }
        return Set(apps.compactMap { $0["id"]?.stringValue }).count == apps.count
    }

    /// checkLease: exactly the keys of its kind; a job; 1–8 apps, each once
    /// (a task has none); max_minutes 1–60 (1–240 for a take or a task); a
    /// reason; resumes null or a lease id; the limits known, sorted, each
    /// once; and a take's or a task's own fields.
    public static func isLease(_ v: JSONValue?) -> Bool {
        guard let l = v?.objectValue, let kind = l["kind"]?.stringValue, let keys = leaseKeys[kind], Rules.hasExactKeys(l, keys) else { return false }
        let take = kind == "take"
        let task = kind == "task"
        guard let jobId = l["job_id"]?.stringValue, !jobId.isEmpty, Rules.withinLength(l["job_id"], 200),
              task || isApps(l["apps"]),
              let mm = l["max_minutes"], Rules.isInteger(mm), let minutes = mm.intValue,
              (1...(kind == "computer_use" ? maxMinutes : takeMaxMinutes)).contains(minutes),
              let reason = l["reason"]?.stringValue, !reason.isEmpty, Rules.withinLength(l["reason"], 280),
              l["resumes"]?.isNull == true || Rules.isUuidV4(l["resumes"]),
              isStringList(l["limits"], leaseLimits.count, { leaseLimits.contains($0) }),
              let limits = l["limits"]?.arrayValue?.compactMap({ $0.stringValue }) else { return false }
        for i in limits.indices.dropFirst() where !(limits[i - 1] < limits[i]) { return false }
        return (!take || isTakeFields(l)) && (!task || isTaskFields(l))
    }

    /// The request's own apps, in its order, kept only if the owner left them on.
    /// The minutes are at most the request's, and never past the kind's cap
    /// (60, or 240 for a take or a task); the admin's own caps are the node's
    /// to check. A task's card has no apps and no choice of minutes, and Allow
    /// signs what it shows: no apps, and exactly its max_minutes.
    public static func grant(to request: LeaseRequest, apps: [String], minutes: Int, deviceId: String, signedAt: String) throws -> JSONValue {
        let chosen = Set(apps)
        if request.isTask {
            guard chosen.isEmpty else { throw ProtocolError.malformed("a task's grant names no apps") }
            guard minutes == request.maxMinutes else { throw ProtocolError.malformed("a task's grant is for the minutes its card shows") }
        } else {
            guard !chosen.isEmpty, chosen.isSubset(of: Set(request.apps.map { $0.id })) else { throw ProtocolError.malformed("pick at least one of the requested apps") }
        }
        let cap = min(request.maxMinutes, request.kind == "computer_use" ? maxMinutes : takeMaxMinutes)
        guard cap >= 1, (1...cap).contains(minutes) else { throw ProtocolError.malformed("minutes must be 1–\(cap)") }
        let ordered = request.apps.map { $0.id }.filter { chosen.contains($0) }
        return decision(request, decision: "grant",
                        grant: .object(["apps": .array(ordered.map { JSONValue.string($0) }), "minutes": .number(String(minutes))]),
                        deviceId: deviceId, signedAt: signedAt)
    }

    /// What a task may do, in the card's words and order (tasks stage 1 spec §4.6).
    static let taskMay: [(allow: String, words: String)] = [
        (allow: "browser-act", words: "click and type in your signed-in browser"),
        (allow: "logins", words: "sign in with saved logins"),
        (allow: "shell", words: "run shell commands"),
        (allow: "files-write", words: "write files")
    ]

    /// A class's words on the card; nil for one that has none, which `isLease` refuses.
    static func taskMayWords(_ allow: String) -> String? { taskMay.first(where: { $0.allow == allow })?.words }

    /// A task's card (spec §4.6): the host's lines, in this order, from what
    /// the pinned node signed. Allow signs exactly this, so nothing is cut:
    /// every site is shown. `nodeName` is the pinned name when the screen has
    /// it; the node's own word for itself otherwise.
    public static func taskLines(_ request: LeaseRequest, nodeName: String? = nil) -> [String] {
        var lines: [String] = []
        lines.append("Task: " + Display.escape(request.name ?? ""))
        if !request.sites.isEmpty { lines.append("Sites: " + request.sites.map { Display.escape($0) }.joined(separator: ", ")) }
        let may = taskMay.filter { request.allows.contains($0.allow) }.map { $0.words }
        lines.append(may.isEmpty ? "May: read only" : "May: " + may.joined(separator: ", "))
        lines.append(request.maxMinutes == 1 ? "For: 1 minute" : "For: \(request.maxMinutes) minutes")
        lines.append("Spend up to $\(request.usd)")
        lines.append("Node: " + Display.escape(nodeName ?? request.nodeName))
        return lines
    }

    /// Whether a status message its pinned node signed says it is a task's.
    /// Read from the message, so a task whose name cannot be read is still a task.
    public static func isTaskStatus(_ message: JSONValue?) -> Bool { message?["kind"]?.stringValue == "task" }

    /// The name Stop's prompt may say: only one that passes the plain-line check, else nil.
    public static func taskStopName(_ message: JSONValue?) -> String? {
        guard let name = message?["name"], isTakeName(name) else { return nil }
        return name.stringValue
    }

    /// A running task's row, with its Stop.
    public static func taskTitle(nodeName: String, name: String) -> String { "Task on \(Display.escape(nodeName)): \(Display.escape(name))" }

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
    /// that was not accepted: such a listing says nothing. `open` reads their
    /// names; nothing else needs it (R-SP-9).
    public static func listedStatuses(_ check: ListingCheck, pin: NodePin, open: Opener? = nil) -> [LeaseStatus] {
        guard check.accepted else { return [] }
        return check.statuses.compactMap { envelope in verifiedMessage(envelope, pin: pin).flatMap { LeaseStatus(message: $0, open: open) } }
    }

    /// A node-signed message (request, status or view) whose signature, kid
    /// and node_id are all the pinned node's; nil otherwise.
    public static func verifiedMessage(_ envelope: Envelope, pin: NodePin) -> JSONValue? {
        guard envelope.alg == "Ed25519", envelope.kid == pin.id, envelope.verifyEd25519(spkiHex: pin.key),
              let message = try? envelope.message(), message["node_id"]?.stringValue == pin.id else { return nil }
        return message
    }

    /// A sealed view after opening holds what a clear one holds
    /// (VALIDATORS['kl.lease.view']); its frame is checked by `verifyView` itself.
    private static func isOpenedView(_ message: JSONValue) -> Bool {
        let keys = ["v", "type", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s", "foreground", "frame", "frame_dropped", "actions", "contact_token"]
        guard let m = message.objectValue, Rules.hasExactKeys(m, keys),
              let foreground = m["foreground"]?.objectValue, Rules.hasExactKeys(foreground, ["app_id", "matches"]),
              foreground["matches"]?.boolValue != nil, m["frame_dropped"]?.boolValue != nil,
              let actions = m["actions"]?.arrayValue, actions.count <= 50 else { return false }
        if let appId = foreground["app_id"], !appId.isNull {
            guard let text = appId.stringValue, isAppId(text) else { return false }
        }
        return actions.allSatisfy { action in
            guard let fields = action.objectValue else { return false }
            return Rules.hasExactKeys(fields, ["seq", "at", "tool", "summary", "result"])
        }
    }

    /// The checks of `verifyLeaseView`: the size, the pinned node's signature, the
    /// node, and only then `open` on a sealed one. Not this phone's to open:
    /// accepted, the clear part alone (no frame, no actions), `seal` `.unread`,
    /// and `reason` says why (`not_recipient`, `open_failed`, `key_locked`).
    public static func verifyView(_ envelope: Envelope, pin: NodePin, open: Opener? = nil) -> (accepted: Bool, reason: String?, view: LeaseView?) {
        guard let bytes = try? envelope.payloadData() else { return (false, "malformed", nil) }
        guard bytes.count <= viewMaxBytes else { return (false, "too_large", nil) }
        guard envelope.alg == "Ed25519", envelope.kid == pin.id else { return (false, "malformed", nil) }
        guard envelope.verifyEd25519(spkiHex: pin.key) else { return (false, "bad_signature", nil) }
        guard let received = try? envelope.message(), received["type"]?.stringValue == "kl.lease.view" else { return (false, "malformed", nil) }
        guard received["node_id"]?.stringValue == pin.id else { return (false, "wrong_node", nil) }
        guard let read = Seal.read(type: "kl.lease.view", message: received, open: open) else { return (false, "malformed", nil) }
        let m = read.message
        if read.state == .opened && !isOpenedView(m) { return (false, "malformed", nil) }
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
                             contactToken: m["contact_token"]?.stringValue, seal: read.state)
        return (true, read.reason, view)
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
