import XCTest
@testable import KLProtocol

/// Runs every lease-v1 vector whose consumers include "ios"
/// (tests/vectors/lease-v1, shared with the node and Android).
final class LeaseVectorTests: XCTestCase {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }()
    static let vectorsDir = root.appendingPathComponent("tests/vectors/lease-v1")

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("\(name).json")))
    }

    func allVectors() throws -> [JSONValue] {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.vectorsDir.path).filter { $0.hasSuffix(".json") }
        return try files.map { try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent($0))) }
    }

    func pin(_ v: JSONValue) -> NodePin {
        let n = v["given"]!["node"]!
        return NodePin(id: n["id"]!.stringValue!, name: n["name"]!.stringValue!, key: n["key"]!.stringValue!)
    }

    func request(_ v: JSONValue) throws -> LeaseRequest {
        let envelope = try Envelope(json: v["given"]!["request"]!)
        let message = try XCTUnwrap(Leases.verifiedMessage(envelope, pin: pin(v)), "the request verifies against the node pin")
        return try XCTUnwrap(LeaseRequest(message: message, sealedSeen: []))
    }

    func assertBuilds(_ name: String, _ build: (JSONValue, JSONValue) throws -> JSONValue) throws {
        let v = try vector(name)
        let expect = v["expect"]!["message"]!
        let built = try build(v, expect)
        XCTAssertEqual(built, expect, name)
        XCTAssertEqual(JCS.data(built), try Envelope(json: v["input"]!).payloadData(), name)
    }

    func testEveryIosVectorIsCovered() throws {
        let names = Set(try allVectors().filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }.compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, Set<String>(["grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "watch-no-token",
                               "status-valid", "status-no-contact", "status-pending", "status-granted-unnamed",
                               "view-node-sig-valid", "view-tampered-frame",
                               "listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
                               "listing-other-device", "listing-bad-signature",
                               "listing-other-node", "listing-wrong-node", "listing-extra-status", "listing-duplicate-lease",
                               "listing-too-many", "listing-extra-key", "listing-bad-at",
                               // Revised 2026-10-24: the take lease.
                               "take-grant", "take-grant-minutes-over-cap", "take-request-missing-name", "computer-use-with-unattended",
                               "status-take", "listing-with-sealed-status",
                               // Revised 2026-11-04: sealed (sealed phones, R-SP-2, R-SP-4, R-SP-9).
                               "request-sealed", "grant-to-sealed", "status-sealed", "view-sealed"]
                               + Self.taskRequestsAccepted + Self.taskRequestsRefused + Self.taskGrantsBuilt + Self.taskGrantsRefused + Self.taskStatuses))
    }

    // Revised 2026-11-03: the task lease (tasks stage 1 spec §4.6, §4.9).
    static let taskRequestsAccepted = ["task-request", "task-request-read-only"]
    static let taskRequestsRefused = ["task-request-allows-unsorted", "task-request-allows-repeated", "task-request-allows-unknown", "task-request-resumes",
                                      "task-request-sites-over-32", "task-request-bad-site", "task-request-usd-under", "task-request-usd-over", "task-request-usd-fraction",
                                      "task-request-attended", "task-request-minutes-over-240", "task-request-with-apps", "task-request-name-hidden", "task-request-name-too-long"]
    static let taskGrantsBuilt = ["task-grant", "task-grant-ignores-take-cap"]
    static let taskGrantsRefused = ["task-grant-with-apps", "task-grant-minutes-over-requested", "task-grant-minutes-over-240", "computer-use-grant-no-apps", "take-grant-no-apps"]
    static let taskStatuses = ["task-status", "task-status-no-name"]

    static let listingVectors = ["listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
                                 "listing-other-device", "listing-bad-signature",
                                 // Fourth security review: another pinned node's listing, an extra status beside one, and the shape.
                                 "listing-other-node", "listing-wrong-node", "listing-extra-status", "listing-duplicate-lease",
                                 "listing-too-many", "listing-extra-key", "listing-bad-at",
                                 // Revised 2026-11-04: a sealed status is listed without being opened (R-SP-9).
                                 "listing-with-sealed-status"]

    /// R-F5-20: a node's listing is taken whole or not at all.
    func testListings() throws {
        for name in Self.listingVectors {
            let v = try vector(name)
            let given = v["given"]!
            let statuses = try (given["statuses"]!.arrayValue!).map { try Envelope(json: $0) }
            let check = Leases.verifyListing(try Envelope(json: v["input"]!), pin: pin(v), nonce: given["nonce"]!.stringValue!,
                                             deviceId: given["device_id"]!.stringValue!, statuses: statuses)
            XCTAssertEqual(check.accepted, v["expect"]!["accepted"]!.boolValue!, name)
            XCTAssertEqual(check.reason, v["expect"]!["reason"]!.stringValue, name)
            if !check.accepted { XCTAssertTrue(check.statuses.isEmpty, name) }
            guard let expected = v["expect"]!["leases"]?.arrayValue else { continue }
            let got = try check.statuses.map { try XCTUnwrap(LeaseStatus(message: try XCTUnwrap(Leases.verifiedMessage($0, pin: pin(v))))) }
            XCTAssertEqual(got.map { $0.leaseId }, expected.map { $0["lease_id"]!.stringValue! }, name)
            XCTAssertEqual(got.map { $0.seq }, expected.map { $0["seq"]!.intValue! }, name)
            XCTAssertEqual(got.map { $0.state }, expected.map { $0["state"]!.stringValue! }, name)
        }
        XCTAssertEqual(try vector("listing-none")["expect"]!["leases"]!.arrayValue!.count, 0)
        XCTAssertEqual(try vector("listing-live")["expect"]!["leases"]!.arrayValue!.count, 2)
        // An extra signed status beside the listing is not part of it.
        XCTAssertEqual(try vector("listing-extra-status")["given"]!["statuses"]!.arrayValue!.count, 2)
        XCTAssertEqual(try vector("listing-extra-status")["expect"]!["leases"]!.arrayValue!.count, 1)
    }

    /// Fourth security review: the shape of a listing, as the node's
    /// validator has it. The four vectors are signed by the node, so it is
    /// the shape alone that refuses them; and each rule is tried by hand.
    func testListingShape() throws {
        for name in ["listing-duplicate-lease", "listing-too-many", "listing-extra-key", "listing-bad-at"] {
            let v = try vector(name)
            let envelope = try Envelope(json: v["input"]!)
            XCTAssertTrue(envelope.verifyEd25519(spkiHex: pin(v).key), name)
            XCTAssertFalse(Leases.isListing(try envelope.message()), name)
        }
        let good = try Envelope(json: try vector("listing-live")["input"]!).message()
        XCTAssertTrue(Leases.isListing(good))
        XCTAssertTrue(Leases.isListing(try Envelope(json: try vector("listing-none")["input"]!).message()))
        XCTAssertEqual(Leases.listingMax, 8)
        func with(_ key: String, _ value: JSONValue?) -> JSONValue {
            var o = good.objectValue!
            o[key] = value
            return .object(o)
        }
        let entry = good["leases"]![0]!
        func leases(_ entries: [JSONValue]) -> JSONValue { with("leases", .array(entries)) }
        func entryWith(_ key: String, _ value: JSONValue?) -> JSONValue {
            var o = entry.objectValue!
            o[key] = value
            return .object(o)
        }
        let bad: [(String, JSONValue)] = [
            ("a key missing", with("at", nil)), ("a key too many", with("note", .string("x"))),
            ("v 2", with("v", .number("2"))), ("another type", with("type", .string("kl.lease.status"))),
            ("node id", with("node_id", .string("gpu-box"))), ("device id", with("to_device", .string("phone"))),
            ("nonce", with("nonce", .string("short"))), ("at: not a time", with("at", .string("now"))),
            ("at: no such day", with("at", .string("2026-02-30T18:04:11.201Z"))), ("at: a number", with("at", .number("1"))),
            ("leases: not a list", with("leases", .object([:]))),
            ("the same lease twice", leases([entry, entry])),
            ("nine leases", leases((0..<9).map { _ in entry })),
            ("an entry that is not an object", leases([.string("x")])),
            ("an entry with a key too many", leases([entryWith("state", .string("active"))])),
            ("an entry with no seq", leases([entryWith("seq", nil)])),
            ("seq 0", leases([entryWith("seq", .number("0"))])), ("seq 1.5", leases([entryWith("seq", .number("1.5"))])),
            ("seq as text", leases([entryWith("seq", .string("7"))])),
            ("lease id", leases([entryWith("lease_id", .string("lease-1"))])),
            ("not an object", .array([]))
        ]
        for (why, message) in bad { XCTAssertFalse(Leases.isListing(message), why) }
    }

    /// R-F5-20: the relay's reply, node by node. No listing for a node is no answer from it.
    func testCheckListingReadsTheRelayReply() throws {
        func entries(_ v: JSONValue, nodeId: String? = nil, withListing: Bool = true) -> [JSONValue] {
            let node = JSONValue.string(nodeId ?? v["given"]!["node"]!["id"]!.stringValue!)
            var out: [JSONValue] = []
            if withListing { out.append(.object(["node_id": node, "envelope": .null, "status": .null, "listing": v["input"]!])) }
            for status in v["given"]!["statuses"]!.arrayValue! { out.append(.object(["node_id": node, "envelope": .null, "status": status])) }
            return out
        }
        for name in Self.listingVectors {
            let v = try vector(name)
            let check = Leases.checkListing(entries(v), pin: pin(v), nonce: v["given"]!["nonce"]!.stringValue!, deviceId: v["given"]!["device_id"]!.stringValue!)
            XCTAssertEqual(check.accepted, v["expect"]!["accepted"]!.boolValue!, name)
            XCTAssertEqual(check.reason, v["expect"]!["reason"]!.stringValue, name)
        }
        let live = try vector("listing-live")
        let nonce = live["given"]!["nonce"]!.stringValue!
        let device = live["given"]!["device_id"]!.stringValue!
        // The listing left out (an offline, slow or older node looks the same): no answer, whatever statuses came.
        let bare = Leases.checkListing(entries(live, withListing: false), pin: pin(live), nonce: nonce, deviceId: device)
        XCTAssertEqual(bare, ListingCheck(accepted: false, reason: "no_listing", statuses: []))
        XCTAssertEqual(Leases.checkListing([], pin: pin(live), nonce: nonce, deviceId: device).reason, "no_listing")
        // Entries listed under another node are not this node's answer.
        XCTAssertEqual(Leases.checkListing(entries(live, nodeId: "kl-aaaaaaaaaaaaaaaa"), pin: pin(live), nonce: nonce, deviceId: device).reason, "no_listing")
        // An entry that carries a request is not part of a listing.
        let withRequest: [JSONValue] = [.object(["node_id": .string(pin(live).id), "envelope": live["input"]!, "status": .null, "listing": live["input"]!])]
        XCTAssertEqual(Leases.checkListing(withRequest, pin: pin(live), nonce: nonce, deviceId: device).reason, "no_listing")
        // A nonce this phone did not choose, and no nonce at all.
        XCTAssertEqual(Leases.checkListing(entries(live), pin: pin(live), nonce: String(nonce.reversed()), deviceId: device).reason, "nonce_mismatch")
        XCTAssertEqual(Leases.checkListing(entries(live), pin: pin(live), nonce: "", deviceId: device).reason, "nonce_mismatch")
        // What the owner is told never says nothing is running, and the node's name is escaped.
        XCTAssertEqual(Leases.couldNotConfirm(nodeName: "gpu-box"), "Could not confirm with gpu-box")
        XCTAssertEqual(Leases.couldNotConfirm(nodeName: "gpu\u{202E}box").unicodeScalars.contains("\u{202E}"), false)
        XCTAssertTrue(Leases.couldNotConfirmDetail.contains("A lease could be running"))
    }

    func testGrants() throws {
        // A take is built like any grant; the admin's take cap (120 in the second) is the node's to refuse.
        for name in ["grant-valid", "grant-narrowed", "resume-capped", "take-grant", "take-grant-minutes-over-cap"] {
            try assertBuilds(name) { v, expect in
                let req = try request(v)
                let apps = expect["grant"]!["apps"]!.arrayValue!.compactMap { $0.stringValue }
                return try Leases.grant(to: req, apps: apps, minutes: expect["grant"]!["minutes"]!.intValue!,
                                        deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
            }
        }
        let resume = try request(try vector("resume-capped"))
        XCTAssertTrue(resume.isResume)
        XCTAssertFalse(resume.isTake)
        let take = try request(try vector("take-grant"))
        XCTAssertTrue(take.isTake)
        XCTAssertEqual(take.name, "BSEOA in ChatGPT")
        XCTAssertEqual(take.sites, ["chatgpt.com", "*.chatgpt.com"])
        XCTAssertNil(take.browserActions)
        XCTAssertFalse(take.credentials)
        XCTAssertTrue(take.unattended)
        XCTAssertEqual(take.maxMinutes, 180)
        // The phone's cap is the request's, and never past 240 for a take.
        XCTAssertThrowsError(try Leases.grant(to: take, apps: ["notepad"], minutes: 181, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        XCTAssertEqual(Leases.takeMaxMinutes, 240)
        XCTAssertEqual(Leases.maxMinutes, 60)
    }

    /// Revised 2026-10-24: a node-signed request whose lease has the wrong
    /// keys for its kind is not read (a take with no name; a computer_use
    /// lease that says unattended).
    func testRequestsWithTheWrongKeysForTheirKind() throws {
        for name in ["take-request-missing-name", "computer-use-with-unattended"] {
            let v = try vector(name)
            let message = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v)), name)
            XCTAssertNil(LeaseRequest(message: message, sealedSeen: []), name)
            XCTAssertFalse(Leases.isLease(message["lease"]), name)
            XCTAssertEqual(v["expect"]!["reason"]!.stringValue, "malformed", name)
        }
        let given = try vector("take-grant")
        let lease = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: given["given"]!["request"]!), pin: pin(given))?["lease"])
        XCTAssertTrue(Leases.isLease(lease))
        func with(_ key: String, _ value: JSONValue?) -> JSONValue {
            var o = lease.objectValue!
            o[key] = value
            return .object(o)
        }
        let bad: [(String, JSONValue)] = [
            ("an unknown kind", with("kind", .string("screen"))), ("no name", with("name", nil)),
            ("an empty name", with("name", .string(""))), ("a name of 61", with("name", .string(String(repeating: "a", count: 61)))),
            ("a line break", with("name", .string("a\nb"))), ("two spaces", with("name", .string("a  b"))),
            ("a no-break space", with("name", .string("a\u{00A0}b"))), ("a bidi override", with("name", .string("a\u{202E}b"))),
            ("an object replacement", with("name", .string("a\u{FFFC}b"))),
            ("four combining marks", with("name", .string("a\u{0301}\u{0301}\u{0301}\u{0301}"))),
            ("no sites", with("sites", .array([]))), ("an upper-case host", with("sites", .array([.string("Example.com")]))),
            ("a bare label", with("sites", .array([.string("localhost")]))), ("a path", with("sites", .array([.string("example.com/x")]))),
            ("browser false", with("browser", .bool(false))), ("browser empty", with("browser", .array([]))),
            ("an empty browser action", with("browser", .array([.string("")]))),
            ("credentials not a boolean", with("credentials", .string("no"))), ("unattended not a boolean", with("unattended", .null)),
            ("241 minutes", with("max_minutes", .number("241")))
        ]
        for (why, value) in bad { XCTAssertFalse(Leases.isLease(value), why) }
        XCTAssertTrue(Leases.isLease(with("name", .string("a\u{0301}\u{0301}\u{0301}"))))
        XCTAssertTrue(Leases.isLease(with("browser", .array([.string("navigate"), .string("click")]))))
        XCTAssertTrue(Leases.isLease(with("max_minutes", .number("240"))))
    }

    func taskCard(_ name: String) throws -> LeaseRequest {
        let v = try vector(name)
        return try XCTUnwrap(LeaseRequest(message: try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v))), sealedSeen: []), name)
    }

    /// task-request's message with some of its lease changed and hashed again.
    func taskCard(changing changes: [String: JSONValue]) throws -> LeaseRequest {
        let v = try vector("task-request")
        guard case .object(var m) = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v))),
              case .object(var lease)? = m["lease"] else { throw ProtocolError.malformed("fixture") }
        for (k, value) in changes { lease[k] = value }
        m["lease"] = .object(lease)
        m["lease_hash"] = .string(Digest.sha256B64url(JCS.data(.object(lease))))
        return try XCTUnwrap(LeaseRequest(message: .object(m), sealedSeen: []))
    }

    /// A task's request: no apps, its own sites, allows and usd; empty allows is the card that raises a look-only task's spend.
    func testTaskRequests() throws {
        for name in Self.taskRequestsAccepted {
            let r = try taskCard(name)
            XCTAssertTrue(r.isTask, name)
            XCTAssertFalse(r.isTake, name)
            XCTAssertFalse(r.isResume, name)
            XCTAssertTrue(r.apps.isEmpty, name)
            XCTAssertEqual(r.name, "Find a dentist", name)
            XCTAssertEqual(r.sites, ["*.example.com"], name)
            XCTAssertEqual(r.usd, 2, name)
            XCTAssertEqual(r.maxMinutes, 20, name)
            XCTAssertTrue(r.unattended, name)
        }
        XCTAssertEqual(try taskCard("task-request").allows, ["browser-act"])
        XCTAssertTrue(try taskCard("task-request-read-only").allows.isEmpty)
        for name in Self.taskRequestsRefused {
            let v = try vector(name)
            let message = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v)), name)
            XCTAssertNil(LeaseRequest(message: message, sealedSeen: []), name)
            XCTAssertFalse(Leases.isLease(message["lease"]), name)
            XCTAssertEqual(v["expect"]!["reason"]!.stringValue, "malformed", name)
        }
        XCTAssertEqual(Leases.taskUsdMax, 500)
        XCTAssertEqual(Leases.taskUsdMin, 2)
        XCTAssertEqual(Leases.taskAllows, ["browser-act", "files-write", "logins", "shell"])
    }

    /// The card, in the spec's order, host-built from the signed fields. Nothing is cut: the owner approves what it shows.
    func testTaskCard() throws {
        XCTAssertEqual(Leases.taskLines(try taskCard("task-request")),
                       ["Task: Find a dentist", "Sites: *.example.com", "May: click and type in your signed-in browser",
                        "For: 20 minutes", "Spend up to $2", "Node: gpu-box"])
        XCTAssertEqual(Leases.taskLines(try taskCard("task-request-read-only"))[2], "May: read only")
        let sites = (0..<16).map { "s\($0).example.com" }
        let all = try taskCard(changing: ["sites": .array(sites.map { .string($0) }),
                                          "allows": .array(["browser-act", "files-write", "logins", "shell"].map { .string($0) }),
                                          "usd": .number("500"), "max_minutes": .number("240")])
        XCTAssertEqual(Leases.taskLines(all),
                       ["Task: Find a dentist", "Sites: " + sites.joined(separator: ", "),
                        "May: click and type in your signed-in browser, sign in with saved logins, run shell commands, write files",
                        "For: 240 minutes", "Spend up to $500", "Node: gpu-box"])
        // No sites (a shell-only grant): the line is left out.
        XCTAssertEqual(Leases.taskLines(try taskCard(changing: ["sites": .array([]), "allows": .array([.string("shell")])])),
                       ["Task: Find a dentist", "May: run shell commands", "For: 20 minutes", "Spend up to $2", "Node: gpu-box"])
        // The name the phone pinned, when the screen has it; escaped whichever it is.
        let base = try taskCard("task-request")
        XCTAssertEqual(Leases.taskLines(base, nodeName: "pinned-name").last, "Node: pinned-name")
        XCTAssertEqual(Leases.taskLines(base, nodeName: "gpu\u{202E}box").last?.unicodeScalars.contains("\u{202E}"), false)
        XCTAssertEqual(Leases.taskTitle(nodeName: "gpu-box", name: "Find a dentist"), "Task on gpu-box: Find a dentist")
        XCTAssertFalse(Leases.taskTitle(nodeName: "gpu\u{202E}box", name: "Find a dentist").unicodeScalars.contains("\u{202E}"))
    }

    /// Fix round 1: one minute is reachable, every class has its words, a class with none is not read, and a pending task says task.
    func testTaskWords() throws {
        XCTAssertEqual(Leases.taskLines(try taskCard(changing: ["max_minutes": .number("1")]))[3], "For: 1 minute")
        XCTAssertEqual(Leases.taskLines(try taskCard(changing: ["max_minutes": .number("2")]))[3], "For: 2 minutes")
        for allow in Leases.taskAllows { XCTAssertNotNil(Leases.taskMayWords(allow), allow) }
        XCTAssertNil(Leases.taskMayWords("desktop-input"))
        guard case .object(var lease)? = try Envelope(json: try vector("task-request")["input"]!).message()["lease"] else { return XCTFail("fixture") }
        lease["allows"] = .array([.string("desktop-input")])
        XCTAssertFalse(Leases.isLease(.object(lease)))
        XCTAssertEqual(Leases.pendingDetail(signedGrant: false, task: true), Leases.taskRequestWaitingDetail)
        XCTAssertTrue(Leases.taskRequestWaitingDetail.contains("a request for a task"))
        XCTAssertFalse(Leases.taskRequestWaitingDetail.contains("computer use"))
        XCTAssertEqual(Leases.pendingDetail(signedGrant: true, task: true), Leases.mayStillStartDetail)
        XCTAssertEqual(Leases.pendingDetail(signedGrant: false), Leases.requestWaitingDetail)
    }

    /// Fix round 1: what Stop's prompt may read of a status its pinned node signed. The name only when it is one plain line.
    func testTaskStopPrompt() throws {
        func signed(_ name: String) throws -> JSONValue {
            let v = try vector(name)
            return try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v)), name)
        }
        func with(_ message: JSONValue, name: String) -> JSONValue {
            var o = message.objectValue!
            o["name"] = .string(name)
            return .object(o)
        }
        let task = try signed("task-status")
        XCTAssertTrue(Leases.isTaskStatus(task))
        XCTAssertEqual(Leases.taskStopName(task), "Find a dentist")
        // A task with no readable name is still a task: its prompt names the node alone.
        let noName = try signed("task-status-no-name")
        XCTAssertTrue(Leases.isTaskStatus(noName))
        XCTAssertNil(Leases.taskStopName(noName))
        XCTAssertNil(Leases.taskStopName(with(task, name: "Find\u{200B}a dentist")))
        XCTAssertNil(Leases.taskStopName(with(task, name: String(repeating: "x", count: 61))))
        XCTAssertFalse(Leases.isTaskStatus(try signed("status-take")))
        XCTAssertFalse(Leases.isTaskStatus(try signed("status-valid")))
        XCTAssertFalse(Leases.isTaskStatus(nil))
        XCTAssertNil(Leases.taskStopName(nil))
    }

    /// A task's grant names no apps and the minutes the card shows; anything else is refused before it is signed.
    func testTaskGrants() throws {
        for name in Self.taskGrantsBuilt {
            try assertBuilds(name) { v, expect in
                XCTAssertEqual(expect["grant"]!["apps"]!.arrayValue!.count, 0, name)
                let req = try request(v)
                return try Leases.grant(to: req, apps: [], minutes: req.maxMinutes,
                                        deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
            }
        }
        for name in Self.taskGrantsRefused {
            let v = try vector(name)
            let expect = v["expect"]!["message"]!
            XCTAssertThrowsError(try Leases.grant(to: try request(v), apps: expect["grant"]!["apps"]!.arrayValue!.compactMap { $0.stringValue },
                                                  minutes: expect["grant"]!["minutes"]!.intValue!,
                                                  deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!), name)
        }
        // Fewer minutes than the card shows is no grant of a task either.
        let task = try request(try vector("task-grant"))
        XCTAssertThrowsError(try Leases.grant(to: task, apps: [], minutes: task.maxMinutes - 1, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
    }

    func testDeny() throws {
        try assertBuilds("deny-valid") { v, expect in
            Leases.deny(try request(v), deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
        }
    }

    func testRevokeAndWatch() throws {
        try assertBuilds("revoke-valid") { _, e in
            Leases.revoke(nodeId: e["node_id"]!.stringValue!, leaseId: e["lease_id"]!.stringValue!, reason: e["reason"]!.stringValue!,
                          deviceId: e["device_id"]!.stringValue!, nonce: e["nonce"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
        }
        // With the token of the newest status or view applied, and with none (null in the message).
        for name in ["watch-valid", "watch-no-token"] {
            try assertBuilds(name) { _, e in
                Leases.watch(nodeId: e["node_id"]!.stringValue!, leaseId: e["lease_id"]!.stringValue!, deviceId: e["device_id"]!.stringValue!,
                             contactToken: e["contact_token"]?.stringValue, nonce: e["nonce"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
            }
        }
        XCTAssertNotNil(try vector("watch-valid")["expect"]!["message"]!["contact_token"]?.stringValue)
        XCTAssertEqual(try vector("watch-no-token")["expect"]!["message"]!["contact_token"], JSONValue.null)
    }

    /// R-F5-15: a status the pinned node signed gives the token the next watch echoes.
    func testStatuses() throws {
        for name in ["status-valid", "status-no-contact", "status-pending", "status-granted-unnamed", "status-take", "task-status"] {
            let v = try vector(name)
            let message = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v)), name)
            let status = try XCTUnwrap(LeaseStatus(message: message), name)
            let expect = v["expect"]!["status"]!
            XCTAssertEqual(status.leaseId, expect["lease_id"]!.stringValue, name)
            XCTAssertEqual(status.seq, expect["seq"]!.intValue, name)
            XCTAssertEqual(status.state, expect["state"]!.stringValue, name)
            XCTAssertEqual(status.reason, expect["reason"]?.stringValue, name)
            XCTAssertEqual(status.contactToken, expect["contact_token"]!.stringValue, name)
            XCTAssertEqual(Leases.isPausedForContact(state: status.state, reason: status.reason), name == "status-no-contact", name)
            // R-F5-18: who granted it (nobody, a named phone, a phone the node gave no name for).
            XCTAssertEqual(status.grantedByDevice, expect["granted_by"]?["device_id"]?.stringValue, name)
            XCTAssertEqual(status.grantedByName, expect["granted_by"]?["name"]?.stringValue, name)
            XCTAssertEqual(Leases.isLive(state: status.state), name != "status-pending", name)
            // Revised 2026-10-24: every status says its kind, whether it runs unattended, and a take's name.
            XCTAssertEqual(status.kind, expect["kind"]?.stringValue ?? "computer_use", name)
            XCTAssertEqual(status.unattended, expect["unattended"]?.boolValue ?? false, name)
            XCTAssertEqual(status.name, expect["name"]?.stringValue, name)
        }
        // The three must agree: computer_use is never unattended and has no name; a take has a name.
        let plainVector = try vector("status-valid")
        let plain = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: plainVector["input"]!), pin: pin(plainVector)))
        func status(_ changes: [String: JSONValue?]) -> LeaseStatus? {
            var o = plain.objectValue!
            for (k, v) in changes { o[k] = v }
            return LeaseStatus(message: .object(o))
        }
        XCTAssertNotNil(status([:]))
        XCTAssertNil(status(["unattended": .bool(true)]))
        XCTAssertNil(status(["name": .string("A take")]))
        XCTAssertNil(status(["kind": .string("take")]))
        XCTAssertNotNil(status(["kind": .string("take"), "name": .string("A take"), "unattended": .bool(true)]))
        XCTAssertNotNil(status(["kind": .string("take"), "name": .string("A take"), "unattended": .bool(false)]))
        XCTAssertNil(status(["kind": .string("take"), "name": .string("A  take"), "unattended": .bool(true)]))
        XCTAssertNil(status(["kind": .string("screen")]))
        // Revised 2026-11-03: a task as a take: a name, and unattended allowed.
        XCTAssertNil(status(["kind": .string("task")]))
        XCTAssertNotNil(status(["kind": .string("task"), "name": .string("A task"), "unattended": .bool(true)]))
        let noName = try vector("task-status-no-name")
        XCTAssertNil(LeaseStatus(message: try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: noName["input"]!), pin: pin(noName)))))
        XCTAssertNil(status(["kind": nil]))
        XCTAssertEqual(Leases.noContact, "no_contact")
        XCTAssertFalse(Leases.isPausedForContact(state: "suspended", reason: "foreground_changed"))
        XCTAssertFalse(Leases.isPausedForContact(state: "suspended", reason: nil))
        XCTAssertFalse(Leases.isPausedForContact(state: "active", reason: "no_contact"))
        // Signed by another node's key: not a status of this pin.
        let v = try vector("status-valid")
        let other = NodePin(id: pin(v).id, name: pin(v).name, key: String(pin(v).key.reversed()))
        XCTAssertNil(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: other))
    }

    func testViews() throws {
        for name in ["view-node-sig-valid", "view-tampered-frame"] {
            let v = try vector(name)
            let result = Leases.verifyView(try Envelope(json: v["input"]!), pin: pin(v))
            XCTAssertEqual(result.accepted, v["expect"]!["accepted"]!.boolValue!, name)
            XCTAssertEqual(result.reason, v["expect"]!["reason"]!.stringValue, name)
        }
        let ok = Leases.verifyView(try Envelope(json: try vector("view-node-sig-valid")["input"]!), pin: pin(try vector("view-node-sig-valid")))
        XCTAssertEqual(ok.view?.actions.first?.tool, "Type")
        XCTAssertNotNil(ok.view?.frame)
        XCTAssertEqual(ok.view?.contactToken, try vector("view-node-sig-valid")["expect"]!["contact_token"]!.stringValue)
    }

    func testRefusesWhatTheNodeWouldRefuse() throws {
        let req = try request(try vector("grant-valid"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: [], minutes: 5, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: ["calculator"], minutes: req.maxMinutes + 1, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        XCTAssertThrowsError(try Leases.grant(to: req, apps: ["terminal"], minutes: 5, deviceId: "d-aaaaaaaaaaaaaaaa", signedAt: "2026-09-23T18:04:16.201Z"))
        // A request whose lease was changed after signing does not parse (lease_hash).
        let v = try vector("grant-valid")
        let signed = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["given"]!["request"]!), pin: pin(v)))
        guard case .object(var m) = signed, case .object(var lease)? = m["lease"] else { return XCTFail("fixture") }
        lease["max_minutes"] = .number("60")
        m["lease"] = .object(lease)
        XCTAssertNil(LeaseRequest(message: .object(m), sealedSeen: []))
    }

    // MARK: sealed (R-SP-2, R-SP-4, R-SP-9, R-SP-15)

    func boxKeys() throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.root.appendingPathComponent("tests/vectors/approval-v1/keys.json")))
    }

    func signed(_ v: JSONValue) throws -> JSONValue {
        try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["input"]!), pin: pin(v)), "verifies against the node pin")
    }

    func opener(_ v: JSONValue) throws -> Opener {
        try openerOf(v["given"]!["box"]!)
    }

    /// Another phone's box under this one's id: a wrap that does not open.
    func wrongBox(_ v: JSONValue) throws -> Opener {
        let d = try boxKeys()["devices"]!["B_box"]!["d"]!.stringValue!
        return Seal.opener(recipientId: v["given"]!["box"]!["device_id"]!.stringValue!, agree: try softwareAgree(text: d))
    }

    func locked(_ v: JSONValue) -> Opener {
        lockedOpener(v["given"]!["box"]!["device_id"]!.stringValue!)
    }

    /// full sealed afresh to phone A, as a node would: for what no vector holds.
    func sealedToA(_ type: String, _ full: JSONValue) throws -> JSONValue {
        let parts = try Seal.split(type: type, full: full)
        let devices = try boxKeys()["devices"]!
        return try Seal.seal(type: type, senderId: full["node_id"]!.stringValue!, clear: parts.clear, content: parts.content,
                             recipient: (id: devices["A"]!["id"]!.stringValue!, key: devices["A_box"]!["jwk"]!))
    }

    /// The vector's sealed message, opened with its own box.
    func opened(_ v: JSONValue, _ type: String) throws -> JSONValue {
        let box = v["given"]!["box"]!
        return try Seal.open(type: type, message: try signed(v), recipientId: box["device_id"]!.stringValue!, agree: try softwareAgree(text: box["d"]!.stringValue!))
    }

    func testASealedRequest() throws {
        let v = try vector("request-sealed")
        let message = try signed(v)
        for key in ["lease", "origin", "salt"] { XCTAssertNil(message[key], key) }
        let check = LeaseRequest.check(message, open: try opener(v), sealedSeen: [])
        XCTAssertNil(check.reason)
        XCTAssertEqual(check.seal, .opened)
        let request = try XCTUnwrap(check.request)
        XCTAssertEqual(LeaseRequest(message: message, open: try opener(v), sealedSeen: []), request)
        let expect = v["expect"]!["status"]!
        XCTAssertEqual(request.leaseHash, expect["lease_hash"]!.stringValue)
        XCTAssertEqual(request.apps.map { $0.id }, ["calculator", "notepad"])
        XCTAssertEqual(request.maxMinutes, 15)
        XCTAssertEqual(request.reason, expect["lease"]!["reason"]!.stringValue)
        XCTAssertEqual(request.originClient, expect["origin"]!["client"]!.stringValue)
        // The hash is the salted one, not the rule of a clear request.
        XCTAssertEqual(try Seal.saltedHash(salt: expect["salt"]!.stringValue!, value: expect["lease"]!), expect["lease_hash"]!.stringValue)

        // Not this phone's to open: no request to answer, and the reason says why.
        let noOpener = LeaseRequest.check(message, sealedSeen: [])
        XCTAssertEqual(noOpener.reason, "not_recipient")
        XCTAssertEqual(noOpener.seal, .unread)
        XCTAssertNil(noOpener.request)
        XCTAssertNil(LeaseRequest(message: message, sealedSeen: []))
        XCTAssertEqual(LeaseRequest.check(message, open: try wrongBox(v), sealedSeen: []).reason, "open_failed")
        // A locked key: its own reason, no decision, and it does not mark the node.
        let lockedCheck = LeaseRequest.check(message, open: locked(v), sealedSeen: [])
        XCTAssertEqual(lockedCheck.reason, "key_locked")
        XCTAssertEqual(lockedCheck.seal, .unread)
        XCTAssertNil(lockedCheck.request)
        // Content that is no such content.
        let malformed = LeaseRequest.check(message, open: contentMalformedOpener, sealedSeen: [])
        XCTAssertEqual(malformed.reason, "malformed")
        XCTAssertEqual(malformed.seal, .unread)
        XCTAssertNil(malformed.request)
        // A sealed request whose clear part is short is not one.
        XCTAssertEqual(LeaseRequest.check(withField(message, "node_box", nil), open: try opener(v), sealedSeen: []).reason, "malformed")
    }

    /// R-SP-2: what is opened is held to the signed hash before anything is shown.
    func testASealedRequestWhoseHashDoesNotHold() throws {
        let v = try vector("request-sealed")
        let type = LeaseRequest.messageType
        let full = try opened(v, type)
        let lease = full["lease"]!
        let box = try opener(v)
        func reason(_ edited: JSONValue) throws -> String? {
            LeaseRequest.check(try sealedToA(type, edited), open: box, sealedSeen: []).reason
        }
        let changed = LeaseRequest.check(try sealedToA(type, withField(full, "lease", withField(lease, "max_minutes", .number("60")))), open: box, sealedSeen: [])
        XCTAssertEqual(changed.reason, "lease_hash_mismatch")
        XCTAssertNil(changed.request)
        XCTAssertEqual(changed.seal, .opened)
        // The unsalted hash of the same lease does not stand in for the salted one.
        XCTAssertEqual(try reason(withField(full, "lease_hash", .string(Digest.sha256B64url(JCS.data(lease))))), "lease_hash_mismatch")
        // Opened and not what a request holds.
        XCTAssertEqual(try reason(withField(full, "origin", .string("x"))), "malformed")
        XCTAssertEqual(try reason(withField(full, "salt", nil)), "malformed")
        XCTAssertEqual(try reason(withField(full, "lease", withField(lease, "kind", .string("screen")))), "malformed")
        XCTAssertEqual(try reason(withField(full, "salt", .string("short"))), "malformed")
    }

    /// The grant is built over the salted hash as received, byte for byte, and its shape does not change.
    func testAGrantToASealedRequest() throws {
        let v = try vector("grant-to-sealed")
        let e = v["expect"]!["message"]!
        let message = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: v["given"]!["request"]!), pin: pin(v)))
        let request = try XCTUnwrap(LeaseRequest(message: message, open: try opener(v), sealedSeen: []))
        let built = try Leases.grant(to: request, apps: e["grant"]!["apps"]!.arrayValue!.compactMap { $0.stringValue }, minutes: e["grant"]!["minutes"]!.intValue!,
                                     deviceId: e["device_id"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
        XCTAssertEqual(built, e)
        XCTAssertEqual(JCS.data(built), try Envelope(json: v["input"]!).payloadData())
        XCTAssertEqual(built["lease_hash"], message["lease_hash"])
    }

    func testASealedStatus() throws {
        let v = try vector("status-sealed")
        let message = try signed(v)
        XCTAssertNil(message["name"])
        let expect = v["expect"]!["status"]!
        let status = try XCTUnwrap(LeaseStatus(message: message, open: try opener(v)))
        XCTAssertEqual(status.name, expect["name"]!.stringValue)
        XCTAssertEqual(status.seal, .opened)
        XCTAssertEqual(status.leaseId, expect["lease_id"]!.stringValue)
        XCTAssertEqual(status.seq, expect["seq"]!.intValue)
        XCTAssertEqual(status.state, expect["state"]!.stringValue)
        XCTAssertEqual(status.contactToken, expect["contact_token"]!.stringValue)
        XCTAssertEqual(status.grantedByDevice, expect["granted_by"]!["device_id"]!.stringValue)
        XCTAssertEqual(status.grantedByName, expect["granted_by"]!["name"]!.stringValue)
        XCTAssertEqual(status.kind, expect["kind"]!.stringValue)
        XCTAssertTrue(status.unattended)

        // R-SP-9: a reader that cannot open it still takes everything but the name.
        let readers: [(Opener?, String)] = [(nil, "not_recipient"), (try wrongBox(v), "open_failed"), (locked(v), "key_locked"), (contentMalformedOpener, "content_malformed")]
        for (open, reason) in readers {
            let unread = try XCTUnwrap(LeaseStatus(message: message, open: open), reason)
            XCTAssertNil(unread.name, reason)
            XCTAssertEqual(unread.seal, .unread, reason)
            XCTAssertEqual(unread.state, expect["state"]!.stringValue, reason)
            XCTAssertEqual(unread.contactToken, expect["contact_token"]!.stringValue, reason)
            XCTAssertEqual(unread.kind, expect["kind"]!.stringValue, reason)
            XCTAssertTrue(Leases.isLive(state: unread.state), reason)
        }
        XCTAssertTrue(Leases.isTaskStatus(message))
        XCTAssertNil(Leases.taskStopName(message))
        // Sealed in another shape: not read.
        XCTAssertNil(LeaseStatus(message: withField(message, "seq", nil), open: try opener(v)))
        XCTAssertNil(LeaseStatus(message: withField(message, "name", .string("x")), open: try opener(v)))
        // Opened to no name or a bad one: kept unread, never dropped, so a live lease keeps its row.
        let full = try opened(v, LeaseStatus.messageType)
        for edited in [withField(full, "name", nil), withField(full, "name", .string("a  b")), withField(full, "name", .null)] {
            let kept = try XCTUnwrap(LeaseStatus(message: try sealedToA(LeaseStatus.messageType, edited), open: try opener(v)))
            XCTAssertNil(kept.name)
            XCTAssertEqual(kept.seal, .unread)
            XCTAssertEqual(kept.state, expect["state"]!.stringValue)
        }
        // A clear status is as it was.
        let clear = try XCTUnwrap(LeaseStatus(message: try signed(try vector("status-valid"))))
        XCTAssertEqual(clear.seal, .clear)
    }

    func testAListingNeedsNothingOpened() throws {
        let v = try vector("listing-with-sealed-status")
        let g = v["given"]!
        let statuses = try g["statuses"]!.arrayValue!.map { try Envelope(json: $0) }
        let check = Leases.verifyListing(try Envelope(json: v["input"]!), pin: pin(v), nonce: g["nonce"]!.stringValue!, deviceId: g["device_id"]!.stringValue!, statuses: statuses)
        XCTAssertTrue(check.accepted, check.reason ?? "")
        let listed = Leases.listedStatuses(check, pin: pin(v))
        XCTAssertEqual(listed.map { $0.state }, ["active"])
        XCTAssertNil(listed[0].name)
        // With the box, the same listing gives the name.
        let d = try boxKeys()["devices"]!["A_box"]!["d"]!.stringValue!
        let named = Leases.listedStatuses(check, pin: pin(v), open: Seal.opener(recipientId: g["device_id"]!.stringValue!, agree: try softwareAgree(text: d)))
        XCTAssertEqual(named.map { $0.name }, ["Find a dentist"])
        // An opener that fails still lists the lease.
        XCTAssertEqual(Leases.listedStatuses(check, pin: pin(v), open: contentMalformedOpener).map { $0.state }, ["active"])
    }

    func testASealedView() throws {
        let v = try vector("view-sealed")
        let envelope = try Envelope(json: v["input"]!)
        let expect = v["expect"]!["status"]!
        let check = Leases.verifyView(envelope, pin: pin(v), open: try opener(v))
        XCTAssertEqual(check.accepted, v["expect"]!["accepted"]!.boolValue!)
        XCTAssertNil(check.reason)
        let view = try XCTUnwrap(check.view)
        XCTAssertEqual(view.seal, .opened)
        XCTAssertEqual(view.leaseId, expect["lease_id"]!.stringValue)
        XCTAssertEqual(view.toDevice, expect["to_device"]!.stringValue)
        XCTAssertEqual(view.foregroundAppId, expect["foreground"]!["app_id"]!.stringValue)
        XCTAssertEqual(view.foregroundMatches, expect["foreground"]!["matches"]!.boolValue)
        XCTAssertEqual(view.frame, Data(base64Encoded: expect["frame"]!["data"]!.stringValue!))
        XCTAssertFalse(view.frameDropped)
        XCTAssertEqual(view.actions.map { $0.tool }, ["Type"])

        // Not this phone's to open: the clear part alone, a reason, and still a contact token to echo.
        let readers: [(Opener?, String)] = [(nil, "not_recipient"), (try wrongBox(v), "open_failed"), (locked(v), "key_locked")]
        for (open, reason) in readers {
            let unread = Leases.verifyView(envelope, pin: pin(v), open: open)
            XCTAssertTrue(unread.accepted, reason)
            XCTAssertEqual(unread.reason, reason)
            let u = try XCTUnwrap(unread.view, reason)
            XCTAssertEqual(u.seal, .unread, reason)
            XCTAssertNil(u.frame, reason)
            XCTAssertTrue(u.actions.isEmpty, reason)
            XCTAssertEqual(u.toDevice, expect["to_device"]!.stringValue, reason)
            XCTAssertNotNil(u.contactToken, reason)
        }
        // Content that is no such content.
        let malformed = Leases.verifyView(envelope, pin: pin(v), open: contentMalformedOpener)
        XCTAssertFalse(malformed.accepted)
        XCTAssertEqual(malformed.reason, "malformed")
        XCTAssertNil(malformed.view)
    }

    func testWhatAViewChecksInside() throws {
        let v = try vector("view-sealed")
        let p = pin(v)
        let box = try opener(v)
        let full = try opened(v, "kl.lease.view")
        let sign = try ed25519Signer(seedHex: try boxKeys()["nodes"]!["web-01"]!["seed"]!.stringValue!)
        func viewOf(_ m: JSONValue) throws -> (accepted: Bool, reason: String?, view: LeaseView?) {
            let envelope = try Envelope.seal(try sealedToA("kl.lease.view", m), alg: "Ed25519", kid: p.id, sign: sign)
            return Leases.verifyView(envelope, pin: p, open: box)
        }
        XCTAssertTrue(try viewOf(full).accepted)
        let other = withField(full["frame"]!, "sha256", .string(Digest.sha256B64url(Data("other".utf8))))
        XCTAssertEqual(try viewOf(withField(full, "frame", other)).reason, "frame_hash_mismatch")
        XCTAssertEqual(try viewOf(withField(full, "actions", nil)).reason, "malformed")
        XCTAssertEqual(try viewOf(withField(full, "foreground", .string("x"))).reason, "malformed")
    }

    /// Verify first: a view signed by another key is not opened.
    func testTheViewsSignatureComesBeforeTheOpen() throws {
        let v = try vector("view-sealed")
        let real = try opener(v)
        var calls = 0
        let spy: Opener = { type, message in
            calls += 1
            return try real(type, message)
        }
        let other = NodePin(id: pin(v).id, name: pin(v).name, key: try boxKeys()["nodes"]!["gpu-box"]!["spki"]!.stringValue!)
        XCTAssertEqual(Leases.verifyView(try Envelope(json: v["input"]!), pin: other, open: spy).reason, "bad_signature")
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(Leases.verifyView(try Envelope(json: v["input"]!), pin: pin(v), open: spy).accepted)
        XCTAssertEqual(calls, 1)
    }

    /// R-SP-15: a clear request from a node seen sealing offers no decision; a status or a view is not held to it.
    func testAClearRequestAfterSealed() throws {
        let granting = try vector("grant-valid")
        let clear = try XCTUnwrap(Leases.verifiedMessage(try Envelope(json: granting["given"]!["request"]!), pin: pin(granting)))
        let nodeId = pin(granting).id
        let refused = LeaseRequest.check(clear, sealedSeen: [nodeId])
        XCTAssertEqual(refused.reason, "clear_after_sealed")
        XCTAssertNil(refused.request)
        XCTAssertNil(LeaseRequest(message: clear, sealedSeen: [nodeId]))
        XCTAssertEqual(LeaseRequest.check(clear, sealedSeen: []).seal, .clear)
        XCTAssertNotNil(LeaseRequest(message: clear, sealedSeen: []))
        // Another node seen sealing is not this one.
        XCTAssertNotNil(LeaseRequest(message: clear, sealedSeen: ["kl-aaaaaaaaaaaaaaaa"]))
        let sealed = try vector("request-sealed")
        XCTAssertNotNil(LeaseRequest(message: try signed(sealed), open: try opener(sealed), sealedSeen: [pin(sealed).id]))
        XCTAssertNotNil(LeaseStatus(message: try signed(try vector("status-valid"))))
        let view = try vector("view-node-sig-valid")
        let viewed = Leases.verifyView(try Envelope(json: view["input"]!), pin: pin(view))
        XCTAssertTrue(viewed.accepted)
        XCTAssertNil(viewed.reason)
        XCTAssertEqual(viewed.view?.seal, .clear)
    }

    func testDemoLeaseRequestParses() throws {
        let fleet = DemoFleet()
        let envelope = try fleet.leaseRequest(on: 0, apps: ["calculator"], minutes: 15)
        let message = try XCTUnwrap(Leases.verifiedMessage(envelope, pin: fleet.pins[0]))
        XCTAssertEqual(LeaseRequest(message: message, sealedSeen: [])?.apps.first?.id, "calculator")
    }

    /// R-F5-18: which leases get a banner, and what a phone says of one it did not grant.
    /// Fourth security review, finding 3: a pending lease this phone signed
    /// a grant for may still start; when its row stays.
    func testMayStillStart() {
        XCTAssertTrue(Leases.mayStillStart(state: "pending", signedGrant: true))
        XCTAssertFalse(Leases.mayStillStart(state: "pending", signedGrant: false))
        for state in ["active", "suspended", "ended", ""] { XCTAssertFalse(Leases.mayStillStart(state: state, signedGrant: true), state) }
        // Named by an accepted listing: kept only while still pending.
        XCTAssertTrue(Leases.keepsMayStart(listedState: "pending", requestExpired: false))
        XCTAssertTrue(Leases.keepsMayStart(listedState: "pending", requestExpired: true))
        for state in ["active", "suspended", "ended"] { XCTAssertFalse(Leases.keepsMayStart(listedState: state, requestExpired: false), state) }
        // Not named: kept until the request has expired.
        XCTAssertTrue(Leases.keepsMayStart(listedState: nil, requestExpired: false))
        XCTAssertFalse(Leases.keepsMayStart(listedState: nil, requestExpired: true))
        XCTAssertEqual(Leases.mayStillStartTitle(nodeName: "gpu-box"), "May still start on gpu-box")
        XCTAssertFalse(Leases.mayStillStartTitle(nodeName: "gpu\u{202E}box").unicodeScalars.contains("\u{202E}"))
    }

    /// Fifth security review, finding 1: a pending lease an accepted
    /// listing names gets a row whatever this phone remembers; what it
    /// remembers only chooses the words.
    func testListedPendingGetsRow() {
        // No memory of a grant (a restarted app, or another phone), no request on screen: a row.
        XCTAssertTrue(Leases.listedPendingGetsRow(state: "pending", shownAsRequest: false, signedGrant: false))
        XCTAssertTrue(Leases.listedPendingGetsRow(state: "pending", shownAsRequest: false, signedGrant: true))
        XCTAssertTrue(Leases.listedPendingGetsRow(state: "pending", shownAsRequest: true, signedGrant: true))
        // The request is on screen, unanswered by this phone: that card is its row.
        XCTAssertFalse(Leases.listedPendingGetsRow(state: "pending", shownAsRequest: true, signedGrant: false))
        for state in ["active", "suspended", "ended", ""] {
            XCTAssertFalse(Leases.listedPendingGetsRow(state: state, shownAsRequest: false, signedGrant: true), state)
        }
        XCTAssertEqual(Leases.pendingTitle(nodeName: "gpu-box", signedGrant: true), "May still start on gpu-box")
        XCTAssertEqual(Leases.pendingTitle(nodeName: "gpu-box", signedGrant: false), "A request is waiting on gpu-box")
        XCTAssertFalse(Leases.requestWaitingTitle(nodeName: "gpu\u{202E}box").unicodeScalars.contains("\u{202E}"))
        XCTAssertEqual(Leases.pendingDetail(signedGrant: true), Leases.mayStillStartDetail)
        XCTAssertEqual(Leases.pendingDetail(signedGrant: false), Leases.requestWaitingDetail)
        XCTAssertTrue(Leases.requestWaitingDetail.contains("does not remember allowing it"))
        XCTAssertFalse(Leases.requestWaitingDetail.contains("This phone signed"))
    }

    /// Fourth security review, finding 2: the words for a node not asked
    /// yet and for one whose listing was accepted.
    func testCheckedWords() {
        XCTAssertEqual(Leases.notCheckedYet(nodeName: "gpu-box"), "Not checked yet: gpu-box")
        XCTAssertEqual(Leases.checked(nodeName: "gpu-box", at: "14:02", running: 0, waiting: 0), "Checked gpu-box at 14:02: no computer-use session")
        XCTAssertEqual(Leases.checked(nodeName: "gpu-box", at: "14:02", running: 1, waiting: 0), "Checked gpu-box at 14:02: 1 computer-use session running")
        XCTAssertEqual(Leases.checked(nodeName: "gpu-box", at: "14:02", running: 2, waiting: 1), "Checked gpu-box at 14:02: 2 computer-use sessions running; 1 request waiting for an answer")
        XCTAssertEqual(Leases.checked(nodeName: "gpu-box", at: "14:02", running: 0, waiting: 2), "Checked gpu-box at 14:02: no computer-use session; 2 requests waiting for an answer")
        XCTAssertEqual(Leases.listedStatuses(ListingCheck(accepted: false, reason: "no_listing", statuses: []), pin: NodePin(id: "kl-x", name: "x", key: "")), [])
    }

    func testLiveAndGrantedBy() {
        XCTAssertTrue(Leases.isLive(state: "active"))
        XCTAssertTrue(Leases.isLive(state: "suspended"))
        XCTAssertFalse(Leases.isLive(state: "pending"))
        XCTAssertFalse(Leases.isLive(state: "ended"))
        XCTAssertFalse(Leases.isLive(state: ""))
        XCTAssertNil(Leases.grantedByOther(device: "d-me", name: "My phone", thisDevice: "d-me"))
        XCTAssertNil(Leases.grantedByOther(device: nil, name: nil, thisDevice: "d-me"))
        XCTAssertEqual(Leases.grantedByOther(device: "d-other", name: "Owner phone", thisDevice: "d-me"), "Granted by Owner phone")
        XCTAssertEqual(Leases.grantedByOther(device: "d-other", name: nil, thisDevice: "d-me"), "Granted by another phone (d-other)")
        XCTAssertEqual(Leases.grantedByOther(device: "d-other", name: "", thisDevice: "d-me"), "Granted by another phone (d-other)")
        // A phone with no key of its own (it cannot be the granting one) still names the granter.
        XCTAssertEqual(Leases.grantedByOther(device: "d-other", name: "Owner phone", thisDevice: nil), "Granted by Owner phone")
        // The name is the node's word for a device: shown escaped.
        let odd = Leases.grantedByOther(device: "d-other", name: "Owner\u{202E}phone", thisDevice: "d-me")
        XCTAssertEqual(odd?.unicodeScalars.contains("\u{202E}"), false)
    }

    /// R-F5-16: nothing older than what is on screen, and no view made for another device.
    func testOrderAndAddressee() throws {
        func status(_ seq: Int) throws -> LeaseStatus {
            try XCTUnwrap(LeaseStatus(message: .object([
                "type": .string("kl.lease.status"), "lease_id": .string("lease-1"), "node_id": .string("kl-node"),
                "seq": .number(String(seq)), "state": .string("active"), "locked": .bool(false),
                "kind": .string("computer_use"), "unattended": .bool(false), "name": .null
            ])))
        }
        func view(_ seq: Int, _ toDevice: String) -> LeaseView {
            LeaseView(leaseId: "lease-1", nodeId: "kl-node", seq: seq, toDevice: toDevice, state: "active", locked: false, remainingS: 60,
                      foregroundAppId: nil, foregroundMatches: false, frame: nil, frameDropped: false, actions: [], contactToken: nil)
        }
        XCTAssertTrue(try Leases.acceptsStatus(status(1), appliedSeq: 0))
        XCTAssertTrue(try Leases.acceptsStatus(status(8), appliedSeq: 7))
        // The same seq again (a replay) and an older one (held back, then delivered) are dropped.
        XCTAssertFalse(try Leases.acceptsStatus(status(7), appliedSeq: 7))
        XCTAssertFalse(try Leases.acceptsStatus(status(3), appliedSeq: 7))
        XCTAssertTrue(Leases.acceptsView(view(8, "d-me"), appliedSeq: 7, deviceId: "d-me"))
        XCTAssertFalse(Leases.acceptsView(view(7, "d-me"), appliedSeq: 7, deviceId: "d-me"))
        XCTAssertFalse(Leases.acceptsView(view(2, "d-me"), appliedSeq: 7, deviceId: "d-me"))
        // Newer, but addressed to another phone.
        XCTAssertFalse(Leases.acceptsView(view(9, "d-other"), appliedSeq: 7, deviceId: "d-me"))
        XCTAssertFalse(Leases.acceptsView(view(9, ""), appliedSeq: 7, deviceId: "d-me"))
    }

    /// The live screen's action log: a node sends an action again when a
    /// watch starts over, and the log must hold each one once, newest first.
    func testMergedActionsHoldEachSeqOnce() {
        func action(_ seq: Int, _ summary: String = "") -> LeaseAction {
            LeaseAction(seq: seq, at: "2026-09-23T18:04:11.201Z", tool: "Click", summary: summary, result: "ok")
        }
        let merged = Leases.mergedActions([action(3), action(2), action(1)], adding: [action(2, "again"), action(4)])
        XCTAssertEqual(merged.map { $0.seq }, [4, 3, 2, 1])
        XCTAssertEqual(merged.first(where: { $0.seq == 2 })?.summary, "again")
        let many = Leases.mergedActions([], adding: (1...250).map { action($0) })
        XCTAssertEqual(many.count, Leases.actionsKept)
        XCTAssertEqual(many.first?.seq, 250)
    }
}
