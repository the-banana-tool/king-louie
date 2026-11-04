import Foundation

/// Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.9):
/// the node-signed question a phone shows, and the device-signed
/// `kl.question.answer` it sends back. The node seals questions as
/// `kl.question.ask` (preflight M6: the relay mailbox routes only full dotted
/// prefixes).
public struct QuestionOption: Equatable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct QuestionItem: Equatable, Identifiable {
    public static let messageType = "kl.question.ask"

    public var id: String { token }
    public let token: String
    public let nodeId: String
    public let nodeName: String
    public let caseId: String
    public let questionId: String
    public let caseTitle: String
    public let kind: String
    public let urgency: String
    public let text: String
    public let options: [QuestionOption]
    /// Why this question cannot be read, so shows no text and takes no answer:
    /// `not_recipient`, `open_failed`, `key_locked` (R-SP-6), or
    /// `clear_after_sealed` (R-SP-15). Only the clear facts above are set. nil for
    /// a question that can be answered.
    public let unreadable: String?
    /// The opened ask's node box, which its answer is sealed to (R-SP-3). nil for a clear ask.
    public let nodeBox: JSONValue?
    public let seal: SealState

    /// nil unless `message` is a complete `kl.question.ask`, clear or sealed; a
    /// sealed one is held to the node's rules (`validateAskMessage`), its clear
    /// part before it is opened and its content after. `message` has passed the
    /// node's signature: only then may `open` read it. What cannot be read has
    /// `unreadable` set.
    public init?(message: JSONValue, nodeName: String, open: Opener? = nil, sealedSeen: Set<String>) {
        guard message["type"]?.stringValue == QuestionItem.messageType,
              let token = message["token"]?.stringValue, let nodeId = message["node_id"]?.stringValue else { return nil }
        var why: String?
        var state = SealState.clear
        var readable: JSONValue?
        if Seal.clearRefused(type: QuestionItem.messageType, message: message, sealedSeen: sealedSeen) {
            why = Seal.clearAfterSealed
        } else {
            if message["sealed"] != nil && !Self.isSealedAsk(message) { return nil }
            guard let read = Seal.read(type: QuestionItem.messageType, message: message, open: open) else { return nil }
            state = read.state
            if read.opened {
                readable = read.message
            } else {
                guard let reason = read.reason else { return nil }
                why = reason
            }
        }
        self.token = token
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.unreadable = why
        self.seal = state
        guard let full = readable else {
            self.caseId = ""
            self.questionId = ""
            self.caseTitle = ""
            self.kind = message["kind"]?.stringValue ?? "question"
            self.urgency = message["urgency"]?.stringValue ?? "normal"
            self.text = ""
            self.options = []
            self.nodeBox = nil
            return
        }
        let sealed = state == .opened
        guard let caseId = full["case_id"]?.stringValue, let questionId = full["question_id"]?.stringValue,
              let text = full["text"]?.stringValue else { return nil }
        if sealed && !Self.isOpenedAsk(full) { return nil }
        self.caseId = caseId
        self.questionId = questionId
        self.caseTitle = full["case_title"]?.stringValue ?? ""
        self.kind = full["kind"]?.stringValue ?? "question"
        self.urgency = full["urgency"]?.stringValue ?? "normal"
        self.text = text
        self.options = (full["options"]?.arrayValue ?? []).compactMap { option in
            guard let id = option["id"]?.stringValue, let label = option["label"]?.stringValue else { return nil }
            return QuestionOption(id: id, label: label)
        }
        self.nodeBox = sealed ? full["node_box"] : nil
    }

    /// TOKEN_RE: ^[0-9A-HJKMNP-TV-Z]{6}$ (src/cases/contact-format.js).
    private static func isToken(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v), b.count == 6 else { return false }
        let excluded = [UInt8(ascii: "I"), UInt8(ascii: "L"), UInt8(ascii: "O"), UInt8(ascii: "U")]
        return b.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A && !excluded.contains($0)) }
    }

    /// CASE_ID: ^[A-Za-z0-9._-]{1,80}$.
    private static func isCaseId(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v), (1...80).contains(b.count) else { return false }
        return b.allSatisfy { ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39)
            || $0 == UInt8(ascii: ".") || $0 == UInt8(ascii: "_") || $0 == UInt8(ascii: "-") }
    }

    /// QUESTION_ID: ^q-\d{4,}$.
    private static func isQuestionId(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v), b.count >= 6, b[0] == UInt8(ascii: "q"), b[1] == UInt8(ascii: "-") else { return false }
        return b[2...].allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// What a sealed ask holds in clear (validateAskMessage in src/channels/mobile-app-channel.js).
    private static func isSealedAsk(_ message: JSONValue) -> Bool {
        guard Seal.isSealedShape(type: messageType, message: message), message["v"] == JSONValue.number("1"),
              Rules.isNodeId(message["node_id"]), isToken(message["token"]),
              message["kind"]?.stringValue != nil, message["urgency"]?.stringValue != nil else { return false }
        return (message["expires_at"]?.isNull == true || Rules.isTimestamp(message["expires_at"])) && Rules.isDeviceJwk(message["node_box"])
    }

    /// What a sealed ask holds once open, as the node's clear rule has it.
    private static func isOpenedAsk(_ full: JSONValue) -> Bool {
        isCaseId(full["case_id"]) && isQuestionId(full["question_id"]) && full["case_title"]?.stringValue != nil
            && full["text"]?.stringValue != nil && full["options"]?.arrayValue != nil
    }
}

public enum Questions {
    /// The message the phone signs; the node checks every field (R44). An
    /// option pick carries only `option_id`, and the text is the answer body
    /// only: a signed answer resolves its own question and nothing else.
    /// A sealed ask is answered sealed to its own node box (R-SP-3).
    public static func answer(to item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String) throws -> JSONValue {
        try Questions.answer(to: item, optionId: optionId, text: text, deviceId: deviceId, nonce: nonce, signedAt: signedAt, sealTo: item.nodeBox)
    }

    /// `answer`, sealed to `sealTo` (nil: in clear). A sealed ask is never answered
    /// in clear or to any box but its own, and a question that cannot be read is
    /// not answered at all. A sealed answer's content is exact JCS (`Seal`).
    public static func answer(to item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String, sealTo: JSONValue?) throws -> JSONValue {
        if let unreadable = item.unreadable { throw ProtocolError.malformed("this question cannot be answered: \(unreadable)") }
        if item.nodeBox != nil && sealTo != item.nodeBox { throw ProtocolError.malformed("a sealed question is answered sealed to its own node box") }
        let answer: JSONValue = optionId.map { .object(["option_id": .string($0)]) } ?? .object(["text": .string(text ?? "")])
        let full: JSONValue = .object([
            "v": .number("1"),
            "type": .string("kl.question.answer"),
            "node_id": .string(item.nodeId),
            "case_id": .string(item.caseId),
            "question_id": .string(item.questionId),
            "token": .string(item.token),
            "answer": answer,
            "nonce": .string(nonce),
            "signed_at": .string(signedAt),
            "device_id": .string(deviceId)
        ])
        guard let box = sealTo else { return full }
        do {
            let parts = try Seal.split(type: "kl.question.answer", full: full)
            return try Seal.seal(type: "kl.question.answer", senderId: deviceId, clear: parts.clear, content: parts.content, recipient: (id: item.nodeId, key: box))
        } catch let refused as SealError {
            throw ProtocolError.malformed("cannot seal the answer: \(refused.reason)")
        }
    }
}
