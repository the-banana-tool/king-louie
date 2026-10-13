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
                               "listing-other-device", "listing-bad-signature"])
    }

    static let listingVectors = ["listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
                                 "listing-other-device", "listing-bad-signature"]

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
        for name in ["grant-valid", "grant-narrowed", "resume-capped"] {
            try assertBuilds(name) { v, expect in
                let req = try request(v)
                let apps = expect["grant"]!["apps"]!.arrayValue!.compactMap { $0.stringValue }
                return try Leases.grant(to: req, apps: apps, minutes: expect["grant"]!["minutes"]!.intValue!,
                                        deviceId: expect["device_id"]!.stringValue!, signedAt: expect["signed_at"]!.stringValue!)
            }
        }
        let resume = try request(try vector("resume-capped"))
        XCTAssertTrue(resume.isResume)
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
        for name in ["status-valid", "status-no-contact", "status-pending", "status-granted-unnamed"] {
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
        }
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
                "seq": .number(String(seq)), "state": .string("active"), "locked": .bool(false)
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
