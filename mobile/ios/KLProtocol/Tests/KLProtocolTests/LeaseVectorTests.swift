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
        XCTAssertEqual(names, ["grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "view-node-sig-valid", "view-tampered-frame"])
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
        try assertBuilds("watch-valid") { _, e in
            Leases.watch(nodeId: e["node_id"]!.stringValue!, leaseId: e["lease_id"]!.stringValue!, deviceId: e["device_id"]!.stringValue!,
                         nonce: e["nonce"]!.stringValue!, signedAt: e["signed_at"]!.stringValue!)
        }
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
