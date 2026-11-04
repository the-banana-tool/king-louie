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
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: []))
        XCTAssertEqual(item.token, "7QD4KM")
        XCTAssertEqual(item.caseTitle, "Lakeside lot")
        XCTAssertEqual(item.urgency, "high")
        XCTAssertEqual(item.options, [QuestionOption(id: "a", label: "Yes"), QuestionOption(id: "b", label: "No")])
    }

    func testRefusesAnythingElse() {
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.approval.request")]), nodeName: "web-01", sealedSeen: []))
        XCTAssertNil(QuestionItem(message: .object(["type": .string("kl.question.ask"), "token": .string("7QD4KM")]), nodeName: "web-01", sealedSeen: []))
        // The pre-M6 type name is not a question either.
        guard case .object(var old) = question else { return XCTFail("fixture is an object") }
        old["type"] = .string("kl.question")
        XCTAssertNil(QuestionItem(message: .object(old), nodeName: "web-01", sealedSeen: []))
    }

    func testSealsTheAnswerToWhatItIsTold() throws {
        let box = freshBox()
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: []))
        let nonce = String(repeating: "n", count: 43)
        let message = try Questions.answer(to: item, optionId: nil, text: "Only after the survey", deviceId: "d-bbbbbbbbbbbbbbbb", nonce: nonce, signedAt: "2026-09-25T14:00:00Z", sealTo: box.jwk)
        for key in ["case_id", "question_id", "answer"] { XCTAssertNil(message[key], key) }
        XCTAssertEqual(message["node_id"]?.stringValue, "kl-aaaaaaaaaaaaaaaa")
        XCTAssertEqual(Set(message["sealed"]!["keys"]!.objectValue!.keys), Set(["kl-aaaaaaaaaaaaaaaa"]))
        let clearAnswer = try Questions.answer(to: item, optionId: nil, text: "Only after the survey", deviceId: "d-bbbbbbbbbbbbbbbb", nonce: nonce, signedAt: "2026-09-25T14:00:00Z")
        XCTAssertEqual(try Seal.open(type: "kl.question.answer", message: message, recipientId: "kl-aaaaaaaaaaaaaaaa", agree: box.agree), clearAnswer)
    }

    /// A clear ask takes no node_box from its text: only an opened one has it.
    func testAClearAskHasNothingToSealTo() throws {
        for message in [question, withField(question, "node_box", freshBox().jwk)] {
            let item = try XCTUnwrap(QuestionItem(message: message, nodeName: "web-01", sealedSeen: []))
            XCTAssertNil(item.nodeBox)
            XCTAssertNil(item.unreadable)
            XCTAssertEqual(item.seal, .clear)
        }
    }

    /// R-SP-15: a clear ask from a node seen sealing shows no question and takes no answer.
    func testAClearAskAfterSealed() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: ["kl-aaaaaaaaaaaaaaaa"]))
        XCTAssertEqual(item.unreadable, "clear_after_sealed")
        XCTAssertEqual(item.text, "")
        XCTAssertEqual(item.caseId, "")
        XCTAssertTrue(item.options.isEmpty)
        XCTAssertEqual(item.nodeName, "web-01")
        XCTAssertEqual(item.token, "7QD4KM")
        XCTAssertThrowsError(try Questions.answer(to: item, optionId: "a", text: nil, deviceId: "d-bbbbbbbbbbbbbbbb", nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z"))
        // Another node seen sealing is not this one.
        XCTAssertNil(try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: ["kl-bbbbbbbbbbbbbbbb"])).unreadable)
        XCTAssertNil(try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: [])).unreadable)
    }

    func testBuildsTheAnswerTheNodeVerifies() throws {
        let item = try XCTUnwrap(QuestionItem(message: question, nodeName: "web-01", sealedSeen: []))
        let message = try Questions.answer(to: item, optionId: "a", text: nil, deviceId: "d-bbbbbbbbbbbbbbbb",
                                       nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertEqual(JCS.serialize(message), #"{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}"#)
        let textAnswer = try Questions.answer(to: item, optionId: nil, text: "Only after the survey", deviceId: "d-bbbbbbbbbbbbbbbb",
                                          nonce: String(repeating: "n", count: 43), signedAt: "2026-09-25T14:00:00Z")
        XCTAssertTrue(JCS.serialize(textAnswer).hasPrefix(#"{"answer":{"text":"Only after the survey"},"#))
    }
}
