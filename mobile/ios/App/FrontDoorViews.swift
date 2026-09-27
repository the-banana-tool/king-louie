import KLProtocol
import SwiftUI

/// A node a grant may be limited to; names outside `machines=`'s alphabet
/// (capitals, say) can only be granted without a limit (Deviation 18).
struct MachineChoice: Hashable {
    let name: String
    let limitable: Bool
}

/// Front-door or client text as shown: capped and escaped by the core
/// (FrontDoor.shownText). Every such value on these screens goes through
/// `Text(verbatim:)` or a String-valued label, so it is never read as
/// Markdown, a link or a localization key.
private func shown(_ value: JSONValue?, max: Int = FrontDoor.shownTextMax) -> String {
    FrontDoor.shownText(value?.stringValue, max: max)
}

/// Fleet stage 4 §3.15: what the owner does on a front door.
struct FrontDoorView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                if let problem = model.frontDoorProblem {
                    Text(verbatim: problem).font(.caption).foregroundStyle(.secondary)
                }
                if model.state.frontDoorId == nil {
                    Text("This phone is not paired with a front door.").foregroundStyle(.secondary)
                    Button("Check again") { Task { await model.refreshFrontDoor() } }.disabled(model.mode != .live)
                } else {
                    NavigationLink("Connect a client") { ConnectClientView() }
                    NavigationLink("Connected clients") { ClientsView() }
                    NavigationLink("Nodes waiting for you (\(model.pairings.count))") { PairingsView() }
                    NavigationLink("Nodes") { FrontDoorNodesView() }
                    NavigationLink("Alerts (\(model.alerts.filter { $0["acked"]?.boolValue != true }.count))") { AlertsView() }
                }
            }
            .navigationTitle("Front door")
            .task { await model.refreshFrontDoor() }
        }
    }
}

struct ConnectClientView: View {
    @EnvironmentObject var model: AppModel
    @State private var code = ""
    @State private var enabled: Set<String> = []
    @State private var limits: [String: Set<String>] = [:]
    @State private var busy = false

    var body: some View {
        Form {
            if let request = model.grantRequest {
                Section("Client") {
                    LabeledContent("Name (self-declared)", value: FrontDoor.shownText(request.clientName))
                    LabeledContent("Client host", value: FrontDoor.shownText(request.clientHost))
                    LabeledContent("Returns to", value: FrontDoor.shownText(request.redirectHost))
                }
                // Only the scopes this client asked for, and none of them on unless chosen.
                Section("What it may do") {
                    ForEach(request.requestedScopes, id: \.self) { scope in
                        Toggle(isOn: Binding(
                            get: { enabled.contains(scope) },
                            set: { on in if on { enabled.insert(scope) } else { enabled.remove(scope) } }
                        )) {
                            Text(verbatim: FrontDoor.shownText(scope)).font(.body.monospaced())
                        }
                        if enabled.contains(scope) && scope != "fleet:unsafe" {
                            ForEach(model.machineChoices, id: \.name) { machine in
                                Toggle(isOn: Binding(
                                    get: { limits[scope]?.contains(machine.name) == true },
                                    set: { on in
                                        var set = limits[scope] ?? []
                                        if on { set.insert(machine.name) } else { set.remove(machine.name) }
                                        limits[scope] = set
                                    }
                                )) {
                                    Text(verbatim: "Only " + FrontDoor.shownText(machine.name))
                                }
                                .disabled(!machine.limitable)
                                .font(.caption)
                            }
                        }
                    }
                    Text("With no machine chosen, the client may use every machine. Unsafe actions still need your phone each time.").font(.caption)
                }
                Section {
                    Button("Approve") { decide(request, true) }.disabled(busy || enabled.isEmpty)
                    Button("Deny", role: .destructive) { decide(request, false) }.disabled(busy)
                }
            } else {
                Section("The code the client's browser shows") {
                    TextField("XXX-XXX", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    Button("Find the request") {
                        Task {
                            busy = true
                            await model.findGrant(code: code)
                            enabled = Set(model.grantRequest?.preselected ?? [])
                            limits = [:]
                            busy = false
                        }
                    }
                    .disabled(busy || code.isEmpty || model.mode != .live)
                }
            }
        }
        .navigationTitle("Connect a client")
        .onDisappear { model.cancelGrant() }
    }

    /// What is signed is exactly the scopes switched on (all of them
    /// requested), each with its machine limit; a denial signs none.
    private func decide(_ request: GrantRequest, _ approve: Bool) {
        busy = true
        let scopes = request.requestedScopes.filter { enabled.contains($0) }.map { scope -> ScopeChoice in
            let machines = limits[scope].flatMap { $0.isEmpty ? nil : Array($0) }
            return ScopeChoice(scope: scope, machines: scope == "fleet:unsafe" ? nil : machines)
        }
        Task {
            await model.decideGrant(request, scopes: approve ? scopes : [], approve: approve)
            busy = false
            if model.grantRequest == nil { code = "" }
        }
    }
}

struct ClientsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            if model.clients.isEmpty { Text("No client is connected.").foregroundStyle(.secondary) }
            ForEach(Array(model.clients.enumerated()), id: \.offset) { _, grant in
                let name = grant["client_name"]?.stringValue ?? ""
                let scopes = (grant["scopes"]?.arrayValue ?? []).prefix(FrontDoor.shownTextMax).map { shown($0, max: 64) }.joined(separator: ", ")
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: FrontDoor.shownText(name) + " (self-declared)").font(.headline)
                    Text(verbatim: shown(grant["client_host"])).font(.caption)
                    Text(verbatim: scopes).font(.caption.monospaced())
                    Text(verbatim: "Last used " + ((grant["last_used_at"]?.stringValue).map { FrontDoor.shownText($0, max: 40) } ?? "never"))
                        .font(.caption).foregroundStyle(.secondary)
                    if let grantId = grant["grant_id"]?.stringValue {
                        Button("Revoke", role: .destructive) {
                            Task { await model.revokeClient(grantId: grantId, name: name) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Connected clients")
        .task { await model.refreshClients() }
        .refreshable { await model.refreshClients() }
    }
}

struct PairingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var busy = false

    var body: some View {
        List {
            if model.pairings.isEmpty { Text("No node is waiting. Give the node its code, then run pair on it.").foregroundStyle(.secondary) }
            ForEach(model.pairings, id: \.pairingId) { pairing in
                VStack(alignment: .leading, spacing: 4) {
                    // The core checked the name's alphabet and that the id derives from the key.
                    Text(verbatim: "\(FrontDoor.shownText(pairing.nodeName)) (\(pairing.profile))").font(.headline)
                    Text(verbatim: pairing.fingerprint).font(.body.monospaced())
                    Text("Check the node's console shows the same fingerprint.").font(.caption)
                    if let old = pairing.replaces {
                        Text(verbatim: "Replaces \(FrontDoor.nodeFingerprint(old))").font(.caption).foregroundStyle(.orange)
                    }
                    HStack {
                        Button("Approve") { act(pairing, true) }.disabled(busy)
                        Button("Deny", role: .destructive) { act(pairing, false) }.disabled(busy)
                    }
                }
            }
        }
        .navigationTitle("Nodes waiting for you")
        // Every 5 s while this screen is open (spec §3.13).
        .task {
            while !Task.isCancelled {
                await model.refreshPairings()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func act(_ pairing: PairingRequest, _ approve: Bool) {
        busy = true
        Task {
            await model.decidePairing(pairing, approve: approve)
            busy = false
        }
    }
}

struct FrontDoorNodesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            if model.frontDoorNodes.isEmpty { Text("No node is enrolled with this front door.").foregroundStyle(.secondary) }
            ForEach(Array(model.frontDoorNodes.enumerated()), id: \.offset) { _, node in
                let id = node["node_id"]?.stringValue ?? ""
                let name = node["node_name"]?.stringValue ?? ""
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(verbatim: FrontDoor.shownText(name, max: 64)).font(.headline)
                        Spacer()
                        Text(node["online"]?.boolValue == true ? "online" : "offline").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(verbatim: FrontDoor.shownText(FrontDoor.nodeFingerprint(id), max: 64)).font(.caption.monospaced())
                    Text(verbatim: "\(shown(node["profile"], max: 32)) · confirmed at the \(shown(node["source"], max: 32)) · audit \(shown(node["audit"], max: 32))")
                        .font(.caption)
                    if node["source"]?.stringValue == "phone", !id.isEmpty {
                        Button("Remove", role: .destructive) { Task { await model.removeNode(nodeId: id, name: name) } }
                    }
                }
            }
        }
        .navigationTitle("Nodes")
        .task { await model.refreshFrontDoorNodes() }
        .refreshable { await model.refreshFrontDoorNodes() }
    }
}

struct AlertsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            if model.alerts.isEmpty { Text("No alerts.").foregroundStyle(.secondary) }
            ForEach(Array(model.alerts.reversed().enumerated()), id: \.offset) { _, alert in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: shown(alert["kind"], max: 64)).font(.headline)
                    Text(verbatim: shown(alert["subject"])).font(.caption.monospaced())
                    Text(verbatim: FrontDoor.shownText(alert["detail"].map { JCS.serialize($0) }, max: 400)).font(.caption.monospaced())
                    Text(verbatim: shown(alert["at"], max: 40)).font(.caption).foregroundStyle(.secondary)
                    if alert["acked"]?.boolValue != true, let id = alert["id"]?.stringValue {
                        Button("Acknowledge") { Task { await model.ackAlert(id) } }
                    }
                }
            }
        }
        .navigationTitle("Alerts")
        .task { await model.refreshAlerts() }
        .refreshable { await model.refreshAlerts() }
    }
}

/// The front door's gap and break records for one node's history. Break
/// reasons are codes (AuditStatus); ones this app does not know are shown as
/// they are, never as a clean history.
struct FrontDoorAuditSection: View {
    let status: AuditStatus

    static func words(_ reason: String?) -> String {
        switch reason {
        case "fork"?: return "the node's history forked from what the front door holds"
        case "withheld_entries"?: return "the node withheld entries"
        case "oversize_entry"?: return "an entry too large to check"
        case let code?: return "reason \(code)"
        case nil: return "a reason this app cannot read"
        }
    }

    var body: some View {
        if status.broken || status.gapCount > 0 {
            Section("Reported by front door") {
                ForEach(Array(status.breaks.enumerated()), id: \.offset) { _, b in
                    Text(verbatim: "Break at #" + (b.seq.map { String($0) } ?? "?") + ": " + Self.words(b.reason)).foregroundStyle(.red)
                }
                if status.gapCount > 0 {
                    Text(verbatim: "\(status.gapCount) gap(s) in the front door's copy of this history")
                }
            }
        }
    }
}
