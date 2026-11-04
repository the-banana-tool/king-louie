import XCTest
@testable import KLProtocol

/// What cannot be read has no decision and no detail (sealed phones, R-SP-6, R-SP-15), as ApprovalListTest.kt has it.
final class SealedRowTests: XCTestCase {
    func testAMessageThatCannotBeReadHasNoDecisionAndNoDetail() throws {
        let rows = ApprovalList.build(sealedUnreadable: [
            ApprovalList.SealedUnreadable(ref: "question:7QD4KM", nodeId: "kl-aaaaaaaaaaaaaaaa", nodeName: "web-01", label: "Question", line: "Another line", timeLeftMs: nil),
            ApprovalList.SealedUnreadable(ref: "tool:t-sealed", nodeId: "kl-aaaaaaaaaaaaaaaa", nodeName: "web\u{202E}-01", label: "Tool approval", line: "One line about web\u{202E}-01", timeLeftMs: 100_000),
            ApprovalList.SealedUnreadable(ref: "tool:t-sooner", nodeId: "kl-aaaaaaaaaaaaaaaa", nodeName: "web-01", label: "Tool approval", line: "A third", timeLeftMs: 50_000)
        ])
        // Its place is its deadline's; one with no deadline comes last.
        XCTAssertEqual(rows.map { $0.id }, ["sealed:tool:t-sooner", "sealed:tool:t-sealed", "sealed:question:7QD4KM"])
        let row = try XCTUnwrap(rows.first { $0.id == "sealed:tool:t-sealed" })
        XCTAssertEqual(row.kind, .unreadable)
        XCTAssertEqual(row.buttons, [])
        XCTAssertFalse(row.enabled)
        XCTAssertFalse(row.hasDetail)
        XCTAssertTrue(row.warning)
        XCTAssertEqual(row.timeLeftMs, 100_000)
        // What a node named is escaped, in the row's name and in its line.
        XCTAssertEqual(row.nodeName, "web‹U+202E›-01")
        XCTAssertEqual(row.cardLines, ["One line about web‹U+202E›-01"])
    }

    func testTimeLeftIsNeverNegative() {
        let rows = ApprovalList.build(sealedUnreadable: [
            ApprovalList.SealedUnreadable(ref: "tool:late", nodeId: "kl-aaaaaaaaaaaaaaaa", nodeName: "web-01", label: "Tool approval", line: "Late", timeLeftMs: -5)
        ])
        XCTAssertEqual(rows.first?.timeLeftMs, 0)
    }

    func testEqualDeadlinesKeepTheirOrder() {
        let rows = ApprovalList.build(sealedUnreadable: [
            ApprovalList.SealedUnreadable(ref: "a", nodeId: "n", nodeName: "n", label: "l", line: "x", timeLeftMs: nil),
            ApprovalList.SealedUnreadable(ref: "b", nodeId: "n", nodeName: "n", label: "l", line: "x", timeLeftMs: nil)
        ])
        XCTAssertEqual(rows.map { $0.ref }, ["a", "b"])
    }
}

/// Telling a box key that stopped working from a phone just unlocked, as BoxKeyHealthTest.kt has it.
final class BoxKeyHealthTests: XCTestCase {
    func testAFewFailuresRightAfterUnlockAreNotBroken() {
        var health = BoxKeyHealth(strikesToBreak: 3, afterMs: 30_000)
        // Many fetches in the race right after unlock: the count is met, the time is not.
        for t in Int64(0)...4 { health.failedUnlocked(nowMs: t * 1000) }
        XCTAssertFalse(health.broken)
    }

    func testOneLateFailureIsNotBroken() {
        var health = BoxKeyHealth(strikesToBreak: 3, afterMs: 30_000)
        health.failedUnlocked(nowMs: 0)
        health.failedUnlocked(nowMs: 60_000)
        XCTAssertFalse(health.broken)
    }

    func testFailuresThatLastAreBroken() {
        var health = BoxKeyHealth(strikesToBreak: 3, afterMs: 30_000)
        health.failedUnlocked(nowMs: 0)
        health.failedUnlocked(nowMs: 15_000)
        XCTAssertFalse(health.broken)
        health.failedUnlocked(nowMs: 30_000)
        XCTAssertTrue(health.broken)
    }

    func testAnOpenOrALockedPhoneStartsTheCountAgain() {
        var health = BoxKeyHealth(strikesToBreak: 3, afterMs: 30_000)
        health.failedUnlocked(nowMs: 0)
        health.failedUnlocked(nowMs: 15_000)
        health.opened()
        health.failedUnlocked(nowMs: 30_000)
        XCTAssertFalse(health.broken)
        health.failedUnlocked(nowMs: 40_000)
        health.locked()
        health.failedUnlocked(nowMs: 61_000)
        XCTAssertFalse(health.broken)
    }

    func testAnOpenEndsBroken() {
        var health = BoxKeyHealth(strikesToBreak: 1, afterMs: 0)
        health.failedUnlocked(nowMs: 0)
        XCTAssertTrue(health.broken)
        health.opened()
        XCTAssertFalse(health.broken)
    }

    func testTheDefaultsAreThreeOverThirtySeconds() {
        var health = BoxKeyHealth()
        health.failedUnlocked(nowMs: 0)
        health.failedUnlocked(nowMs: 29_999)
        health.failedUnlocked(nowMs: 29_999)
        XCTAssertFalse(health.broken)
        health.failedUnlocked(nowMs: 30_000)
        XCTAssertTrue(health.broken)
    }
}

/// A row has its time left even when the ask cannot be read, as QuestionTest.kt has it.
final class QuestionExpiryTests: XCTestCase {
    private let dated: JSONValue = .object([
        "v": .number("1"),
        "type": .string("kl.question.ask"),
        "node_id": .string("kl-aaaaaaaaaaaaaaaa"),
        "case_id": .string("mfz1k2-0a1b2c3d"),
        "question_id": .string("q-0012"),
        "token": .string("7QD4KM"),
        "kind": .string("question"),
        "urgency": .string("high"),
        "case_title": .string("Lakeside lot"),
        "text": .string("Accept the 41k offer?"),
        "options": .array([]),
        "expires_at": .string("2026-09-25T14:00:00Z")
    ])

    func testAnAskThatCannotBeReadKeepsItsExpiry() throws {
        let held = try XCTUnwrap(QuestionItem(message: dated, nodeName: "web-01", sealedSeen: ["kl-aaaaaaaaaaaaaaaa"]))
        XCTAssertEqual(held.unreadable, Seal.clearAfterSealed)
        XCTAssertEqual(held.expiresAt, "2026-09-25T14:00:00Z")
        XCTAssertEqual(QuestionItem(message: dated, nodeName: "web-01", sealedSeen: [])?.expiresAt, "2026-09-25T14:00:00Z")
    }
}
