import KLProtocol
import SwiftUI

/// Cases stage 4: questions from the nodes, each answered with a fresh
/// biometric signature (the node verifies it; the relay only forwards).
/// Opening the screen loads questions only when the API session is already
/// unlocked; "Check for questions" and pull-to-refresh may ask for Face ID.
struct QuestionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var drafts: [String: String] = [:]

    private func draft(_ token: String) -> String {
        (drafts[token] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func tooLong(_ token: String) -> Bool {
        draft(token).utf16.count > AppModel.maxAnswerChars
    }

    var body: some View {
        NavigationStack {
            List {
                if model.mode == .live {
                    Button("Check for questions") { Task { await model.refreshQuestions() } }
                }
                ForEach(model.questions) { item in
                    let busy = model.answering.contains(item.token)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(Display.escape(item.caseTitle)) · \(Display.escape(item.nodeName))").font(.caption).foregroundStyle(.secondary)
                        Text(Display.escape(item.text)).fontWeight(item.urgency == "high" ? .bold : .regular)
                        if item.kind == "briefing" {
                            Button("Got it") { Task { await model.answer(item, optionId: nil, text: "ok") } }
                                .buttonStyle(.bordered).disabled(busy)
                        } else {
                            ForEach(item.options) { option in
                                Button(Display.escape(option.label)) { Task { await model.answer(item, optionId: option.id, text: nil) } }
                                    .buttonStyle(.bordered).disabled(busy)
                            }
                            HStack {
                                TextField("Answer…", text: Binding(get: { drafts[item.token] ?? "" }, set: { drafts[item.token] = $0 }))
                                    .textFieldStyle(.roundedBorder)
                                Button("Send") {
                                    let text = draft(item.token)
                                    Task { await model.answer(item, optionId: nil, text: text) }
                                }
                                .disabled(busy || draft(item.token).isEmpty || tooLong(item.token))
                            }
                            if tooLong(item.token) {
                                Text("At most \(AppModel.maxAnswerChars) characters.").font(.caption).foregroundStyle(.red)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .overlay { if model.questions.isEmpty { Text("No open questions").foregroundStyle(.secondary) } }
            .refreshable { await model.refreshQuestions() }
            .task { await model.refreshQuestions(onlyIfUnlocked: true) }
            .navigationTitle("Questions")
        }
    }
}

/// Foreground presence (ruling T19-presence): a ping every 60 s while the
/// scene is active and the API session is already unlocked, never a Face ID
/// prompt of its own (§3.4: a ping is fresh for 120 s). Nothing is sent when
/// the scene leaves: the node lets the last ping lapse. A Face ID prompt makes
/// the scene inactive, which only pauses this loop.
struct PresencePinger: ViewModifier {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase

    func body(content: Content) -> some View {
        content.task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await model.pingPresence()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
}
