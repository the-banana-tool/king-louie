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
        return try XCTUnwrap(LeaseRequest(message: message))
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
        XCTAssertEqual(names, ["grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "watch-no-token",
                               "status-valid", "status-no-contact", "status-pending", "status-granted-unnamed",
                               "view-node-sig-valid", "view-tampered-frame",
                               "listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
                               "listing-other-device", "listing-bad-signature",
                               "listing-other-node", "listing-wrong-node", "listing-extra-status", "listing-duplicate-lease",
                               "listing-too-many", "listing-extra-key", "listing-bad-at",
                               // Revised 2026-10-24: the take lease.
                               "take-grant", "take-grant-minutes-over-cap", "take-request-missing-name", "computer-use-with-unattended",
                               "status-take"])
    }

    static let listingVectors = ["listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
                                 "listing-other-device", "listing-bad-signature",
                                 // Fourth security review: another pinned node's listing, an extra status beside one, and the shape.
                                 "listing-other-node", "listing-wrong-node", "listing-extra-status", "listing-duplicate-lease",
                                 "listing-too-many", "listing-extra-key", "listing-bad-at"]

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
            XCTAssertNil(LeaseRequest(message: message), name)
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
        for name in ["status-valid", "status-no-contact", "status-pending", "status-granted-unnamed", "status-take"] {
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
        XCTAssertNil(LeaseRequest(message: .object(m)))
    }

    func testDemoLeaseRequestParses() throws {
        let fleet = DemoFleet()
        let envelope = try fleet.leaseRequest(on: 0, apps: ["calculator"], minutes: 15)
        let message = try XCTUnwrap(Leases.verifiedMessage(envelope, pin: fleet.pins[0]))
        XCTAssertEqual(LeaseRequest(message: message)?.apps.first?.id, "calculator")
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
