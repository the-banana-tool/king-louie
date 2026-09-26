import XCTest
@testable import KLProtocol

/// Cases stage 4 §3.9. The expected bytes are the same string the node test
/// (tests/contact-mobile.test.js) feeds to its kl.question.answer validator.
/// The node seals questions as `kl.question.ask` (preflight M6).
final class QuestionTests: XCTestCase {
    let question: JSONValue = .object([
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
        "options": .array([.object(["id": .string("a"), "label": .string("Yes")]), .object(["id": .string("b"), "label": .string("No")])]),
        "expires_at": .null
    ])

    func testParsesAQuestion() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01"))
        XCTAssertEqual(item.token, "7QD4KM")
        XCTAssertEqual(item.caseTitle, "Lakeside lot")
        XCTAssertEqual(item.urgency, "high")
        XCTAssertEqual(item.options, [QuestionOption(id: "a", label: "Yes"), QuestionOption(id: "b", label: "No")])
    }

    func testRefusesAnythingElse() {
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.approval.request")]), nodeName: "web-01"))
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.question.ask"), "token": .string("7QD4KM")]), nodeName: "web-01"))
        // The pre-M6 type name is not a question either.
        guard case .object(var old) = question else { return XCTFail("fixture is an object") }
        old["type"] = .string("kl.question")
        XCTAssertNil(QuestionItem(message: .object(old), nodeName: "web-01"))
    }

    func testBuildsTheAnswerTheNodeVerifies() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01"))
        let message = Questions.answer(to: item, optionId: "a", text: nil, deviceId: "d-bbbbbbbbbbbbbbbb",
                                       nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertEqual(JCS.serialize(message), #"{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}"#)
        let textAnswer = Questions.answer(to: item, optionId: nil, text: "Only after the survey", deviceId: "d-bbbbbbbbbbbbbbbb",
                                          nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertTrue(JCS.serialize(textAnswer).hasPrefix(#"{"answer":{"text":"Only after the survey"},"#))
    }
}
