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

    /// nil unless `message` is a complete `kl.question.ask`.
    public init?(message: JSONValue, nodeName: String) {
        guard message["type"]?.stringValue == QuestionItem.messageType,
              let token = message["token"]?.stringValue, let nodeId = message["node_id"]?.stringValue,
              let caseId = message["case_id"]?.stringValue, let questionId = message["question_id"]?.stringValue,
              let text = message["text"]?.stringValue else { return nil }
        self.token = token
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.caseId = caseId
        self.questionId = questionId
        self.caseTitle = message["case_title"]?.stringValue ?? ""
        self.kind = message["kind"]?.stringValue ?? "question"
        self.urgency = message["urgency"]?.stringValue ?? "normal"
        self.text = text
        self.options = (message["options"]?.arrayValue ?? []).compactMap { option in
            guard let id = option["id"]?.stringValue, let label = option["label"]?.stringValue else { return nil }
            return QuestionOption(id: id, label: label)
        }
    }
}

public enum Questions {
    /// The message the phone signs; the node checks every field (R44). An
    /// option pick carries only `option_id`, and the text is the answer body
    /// only: a signed answer resolves its own question and nothing else.
    public static func answer(to item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String) -> JSONValue {
        let answer: JSONValue = optionId.map { .object(["option_id": .string($0)]) } ?? .object(["text": .string(text ?? "")])
        return .object([
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
    }
}
