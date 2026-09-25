import CoreImage.CIFilterBuiltins
import KLProtocol
import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.mode == .welcome {
                WelcomeView()
            } else {
                MainView()
            }
        }
        .alert(model.banner ?? "", isPresented: Binding(get: { model.banner != nil }, set: { if !$0 { model.banner = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }
}

struct ScanSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            VStack {
                QRScannerView { code in
                    dismiss()
                    Task { await model.scanned(code) }
                }
                .frame(maxHeight: 360)
                TextField("Or paste a kl1: code", text: $pasted)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding()
                Button("Use pasted code") {
                    dismiss()
                    let text = pasted
                    Task { await model.scanned(text) }
                }
                .disabled(pasted.isEmpty)
            }
            .navigationTitle("Scan a code")
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 24) {
            Text("King Louie").font(.largeTitle.bold())
            Text("Approve what your machines want to do, with your face or fingerprint.")
                .multilineTextAlignment(.center)
            Button("Scan pairing code") { scanning = true }.buttonStyle(.borderedProminent)
            Button("Try demo") { model.startDemo() }
        }
        .padding()
        .sheet(isPresented: $scanning) { ScanSheet() }
    }
}

struct MainView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if model.mode == .demo {
                Text("Demo — nothing here reaches a real machine").font(.footnote.bold())
                    .frame(maxWidth: .infinity).padding(6).background(Color.yellow)
            }
            if let fingerprint = model.fingerprintToCompare {
                Text("This phone: \(fingerprint)\nCheck the other screen shows the same.")
                    .font(.footnote.monospaced()).padding(6)
            }
            TabView {
                PendingListView().tabItem { Label("Pending", systemImage: "checkmark.shield") }
                HistoryView().tabItem { Label("History", systemImage: "clock") }
                NodesView().tabItem { Label("Nodes", systemImage: "server.rack") }
                DevicesView().tabItem { Label("Devices", systemImage: "iphone") }
                SettingsView().tabItem { Label("Settings", systemImage: "gear") }
            }
        }
    }
}

func formatLeft(_ d: Duration) -> String {
    let s = Int(d.components.seconds)
    return String(format: "%d:%02d", s / 60, s % 60)
}

struct PendingListView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                List {
                    if model.mode == .live {
                        Section {
                            if let problem = model.pollProblem {
                                Text(problem).font(.caption).foregroundStyle(.secondary)
                            }
                            if !model.isPolling {
                                Button("Check for requests") { model.checkNow() }
                            }
                        }
                    }
                    ForEach(model.pending) { item in
                        NavigationLink(value: item.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.display["node"]?["name"]?.stringValue ?? "").font(.headline)
                                Text(item.display["summary"]?.stringValue ?? "").lineLimit(2)
                                HStack {
                                    Text(item.display["origin"]?["client"]?.stringValue ?? "")
                                    Spacer()
                                    Text(item.status ?? formatLeft(item.timeLeft)).monospacedDigit()
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .overlay { if model.pending.isEmpty { Text("Nothing is waiting for you.").foregroundStyle(.secondary) } }
            }
            .navigationTitle("Pending approvals")
            .navigationDestination(for: String.self) { id in
                ApprovalDetailView(itemId: id)
            }
        }
    }
}

/// Exactly what the pinned node signed, as the core's display model gives
/// it: every parameter, command-like values in full or head + tail, hidden
/// characters as ‹U+XXXX›, numbers as their JSON text (spec §3.14).
struct ApprovalDetailView: View {
    @EnvironmentObject var model: AppModel
    let itemId: String
    @State private var expanded: Set<String> = []
    @State private var busy = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            if let item = model.pending.first(where: { $0.id == itemId }) {
                Form {
                    Section("Node") {
                        Text(item.display["node"]?["name"]?.stringValue ?? "").font(.headline)
                        Text(item.display["node"]?["id"]?.stringValue ?? "").font(.caption.monospaced())
                    }
                    Section("Action") {
                        Text(item.display["summary"]?.stringValue ?? "")
                        LabeledContent("Kind", value: item.display["kind"]?.stringValue ?? "")
                        LabeledContent("Name", value: item.display["name"]?.stringValue ?? "")
                        if let cwd = item.display["cwd"]?.stringValue { LabeledContent("Directory", value: cwd) }
                        LabeledContent("Asked by", value: originText(item.display["origin"]))
                        LabeledContent("Time left", value: formatLeft(item.timeLeft))
                    }
                    Section("Everything it will do") {
                        ForEach(Array((item.display["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, entry in
                            ItemRow(entry: entry, full: item.fullText[entry["path"]?.stringValue ?? ""] ?? "", expanded: $expanded)
                        }
                    }
                    if let status = item.status {
                        Section("Status") { Text(status) }
                    } else {
                        Section {
                            Button("Approve") { act(item, true) }.disabled(busy || item.timeLeft == .zero)
                            Button("Deny", role: .destructive) { act(item, false) }.disabled(busy || item.timeLeft == .zero)
                        }
                    }
                }
                .navigationTitle("Approval")
            } else {
                Text("This request is gone.").foregroundStyle(.secondary)
            }
        }
    }

    private func originText(_ origin: JSONValue?) -> String {
        guard let o = origin?.objectValue else { return "" }
        return ["client", "session", "job_id", "deviceId"].compactMap { o[$0]?.stringValue }.joined(separator: " · ")
    }

    private func act(_ item: PendingItem, _ approve: Bool) {
        busy = true
        Task {
            await model.decide(item, approve: approve)
            busy = false
        }
    }
}

struct ItemRow: View {
    let entry: JSONValue
    let full: String
    @Binding var expanded: Set<String>

    var body: some View {
        let path = entry["path"]?.stringValue ?? ""
        let hidden = entry["hidden"]?.intValue ?? 0
        VStack(alignment: .leading, spacing: 4) {
            Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
            if hidden > 0 && expanded.contains(path) {
                Text(full).font(.body.monospaced()).textSelection(.enabled)
            } else {
                Text(entry["text"]?.stringValue ?? "").font(.body.monospaced()).textSelection(.enabled)
                if hidden > 0 {
                    Button("\(hidden) characters hidden — Show all") { expanded.insert(path) }.font(.caption)
                    Text(entry["tail"]?.stringValue ?? "").font(.body.monospaced())
                }
            }
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject var model: AppModel
    @State private var nodeId: String = ""

    var body: some View {
        NavigationStack {
            List {
                Picker("Node", selection: $nodeId) {
                    ForEach(model.state.nodes, id: \.id) { Text(Display.escape($0.name)).tag($0.id) }
                }
                if let page = model.history, page.nodeId == nodeId {
                    Section("As of \(Display.escape(page.asOf))") {
                        ForEach(Array(page.entries.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading) {
                                Text(Display.escape(entry["kind"]?.stringValue ?? "")).font(.headline)
                                Text("#\(entry["seq"]?.intValue ?? 0) · \(Display.escape(entry["at"]?.stringValue ?? "")) · \(Display.escape(entry["writer"]?.stringValue ?? ""))").font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .onChange(of: nodeId) { _, id in Task { await model.loadHistory(nodeId: id) } }
            .onAppear { if nodeId.isEmpty, let first = model.state.nodes.first { nodeId = first.id } }
        }
    }
}

struct NodesView: View {
    @EnvironmentObject var model: AppModel
    @State private var newNodeName = ""
    @State private var code: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.state.nodes, id: \.id) { node in
                    VStack(alignment: .leading) {
                        HStack {
                            Text(Display.escape(node.name)).font(.headline)
                            Spacer()
                            Circle().fill(model.onlineNodes[node.id] == true ? Color.green : Color.gray).frame(width: 10, height: 10)
                        }
                        Text(Identifiers.fingerprintGroups(node.id)).font(.caption.monospaced())
                    }
                }
                Section("Pairing code for a new node") {
                    TextField("Node name, e.g. gpu-box", text: $newNodeName)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Get code") { Task { code = await model.pairingCode(forNode: newNodeName) } }.disabled(newNodeName.isEmpty || model.mode != .live)
                    if let code { Text(code).font(.body.monospaced()).textSelection(.enabled) }
                }
            }
            .navigationTitle("Nodes")
            .refreshable { await model.refreshNodes() }
        }
    }
}

struct QRImage: View {
    let text: String

    var body: some View {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        let context = CIContext()
        if let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
           let cg = context.createCGImage(image, from: image.extent) {
            return AnyView(Image(decorative: cg, scale: 1).interpolation(.none).resizable().scaledToFit())
        }
        return AnyView(Text(text).font(.caption.monospaced()))
    }
}

struct DevicesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                if let id = model.deviceId {
                    Section("This phone") { Text("d-" + Identifiers.fingerprintGroups(id)).font(.body.monospaced()) }
                }
                Section("Devices") {
                    ForEach(Array(model.devices.enumerated()), id: \.offset) { _, device in
                        let id = device["device_id"]?.stringValue ?? ""
                        let name = device["name"]?.stringValue ?? ""
                        VStack(alignment: .leading) {
                            Text("\(Display.escape(name)) (\(Display.escape(device["platform"]?.stringValue ?? "")))")
                            // The relay's list, not a pin: escaped like any other relay text.
                            Text(Display.escape("d-" + Identifiers.fingerprintGroups(id))).font(.caption.monospaced())
                            ForEach(Array((device["nodes"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, n in
                                Text("\(nodeLabel(n["node_id"]?.stringValue ?? "")): \(Display.escape(n["state"]?.stringValue ?? ""))").font(.caption)
                            }
                            if id != model.deviceId {
                                Button("Revoke", role: .destructive) { Task { await model.revoke(deviceId: id, name: name) } }
                            }
                        }
                    }
                }
                Section {
                    Button("Add a device") { Task { await model.startInvite() } }.disabled(model.mode != .live || model.inviteQR != nil)
                    if let qr = model.inviteQR {
                        QRImage(text: qr).frame(height: 240)
                        Text("Scan this with the new phone.").font(.caption)
                    }
                    if let device = model.inviteClaimToConfirm {
                        Text("New phone \(Display.escape(device["name"]?.stringValue ?? "")): d-\(Identifiers.fingerprintGroups(device["device_id"]?.stringValue ?? ""))")
                            .font(.body.monospaced())
                        Button("It shows the same — add it") { Task { await model.confirmInvitedDevice() } }
                        Button("Cancel", role: .cancel) { model.inviteClaimToConfirm = nil }
                    }
                }
            }
            .navigationTitle("Devices")
            .refreshable { await model.refreshDevices() }
        }
    }

    /// A pinned node's name, else its id (the relay's list is not a pin).
    private func nodeLabel(_ id: String) -> String {
        model.state.nodes.first(where: { $0.id == id }).map { Display.escape($0.name) } ?? Display.escape(id)
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    Text(model.state.relayURL ?? "not paired")
                    Text(model.state.relaySpki ?? "").font(.caption.monospaced())
                    Button("Re-pin the relay (scan a relay code)") { scanning = true }.disabled(model.mode != .live)
                }
                if model.mode == .demo {
                    Button("Leave demo") { model.leaveDemo() }
                }
                Section {
                    Button("Reset this phone", role: .destructive) { model.reset() }
                }
                Section("Privacy") {
                    Text("No analytics. The relay sees every action you are asked to approve; see PRIVACY.md.").font(.caption)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $scanning) { ScanSheet() }
        }
    }
}
