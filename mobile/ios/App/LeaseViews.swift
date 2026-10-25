import KLProtocol
import SwiftUI
import UIKit

/// Fleet stage 5 §3.10: a lease request (exactly what the pinned node signed,
/// the agent's reason labelled unverified), and the live lease with the kill
/// switch. Every text here comes from a node-signed message, escaped.
struct LeaseRequestsSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if !model.leaseRequests.isEmpty || !model.leaseStatusRows.isEmpty {
            Section("Computer use") {
                ForEach(model.leaseRequests) { item in
                    NavigationLink { LeaseRequestView(item: item) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Display.escape(item.nodeName)).font(.headline)
                            if item.request.isTake, let name = item.request.name {
                                Text("Take: \(Display.escape(name))")
                            } else {
                                Text(item.request.isResume ? "Resume computer use" : "Computer use: \(item.request.apps.map { Display.escape($0.name) }.joined(separator: ", "))")
                            }
                            Text("Job \(Display.escape(item.request.jobId)) · \(Display.escape(item.request.originClient))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                // Fourth security review, finding 2: what this phone knows of
                // each paired computer, said as what it is. Not asked yet is
                // not "nothing running"; a checked one carries its time. (A
                // computer that could not be confirmed is in the banner.)
                ForEach(model.leaseStatusRows) { row in
                    Text(model.leaseCheckText(row)).font(.caption).foregroundStyle(.secondary)
                }
                if model.leaseStatusRows.contains(where: { $0.check == nil }) {
                    Text(Leases.notCheckedYetDetail).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct LeaseRequestView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let item: AppModel.LeaseRequestItem
    @State private var chosen: Set<String> = []
    @State private var minutes = 1

    private static let limitText = ["no_lock_detect": "This computer cannot detect a locked screen.",
                                    "no_human_yield": "This computer cannot detect your own typing, so it will not pause for you."]

    // Revised 2026-10-24 (agent-driven demo takes): the host's own words for
    // what a take may do. Each is chosen by a signed field, never taken from
    // a string the request sent.
    static let unattendedLine = "Unattended: no check-ins; runs until it ends or you stop it"
    static let browserTrueLine = "drive the browser on these sites (no scripts, no network changes, no uploads)"
    static let credentialsLine = "credentials from the vault"

    private var nodeSection: some View {
        Section("Node") {
            Text(Display.escape(item.nodeName)).font(.headline)
            LabeledContent("Job", value: Display.escape(item.request.jobId))
            LabeledContent("Asked by", value: Display.escape(item.request.originClient))
        }
    }

    private var reasonSection: some View {
        Section("Agent's reason (unverified)") { Text(Display.escape(item.request.reason)) }
    }

    private var appsSection: some View {
        Section("Apps it may control") {
            ForEach(item.request.apps) { app in
                Toggle(isOn: Binding(get: { chosen.contains(app.id) }, set: { on in if on { _ = chosen.insert(app.id) } else { _ = chosen.remove(app.id) } })) {
                    VStack(alignment: .leading) {
                        Text(Display.escape(app.name))
                        Text(Display.escape(app.path)).font(.caption.monospaced())
                        if !app.processes.isEmpty { Text(app.processes.map { Display.escape($0) }.joined(separator: ", ")).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                    }
                }
                .disabled(item.request.isResume || isTakeBrowser(app))
            }
        }
    }

    /// A take's first app is its browser: it stays on, so a grant never leaves the take's browser out.
    private func isTakeBrowser(_ app: LeaseApp) -> Bool { item.request.isTake && app.id == item.request.apps.first?.id }

    private var minutesSection: some View {
        Section("For how long") {
            if item.request.isResume {
                Text("The \(item.request.maxMinutes) min that were left; a resume never extends the lease.")
            } else {
                Stepper("\(minutes) min", value: $minutes, in: 1...item.request.maxMinutes)
            }
        }
    }

    var body: some View {
        Form {
            if item.request.isTake {
                // A take, in this order: its name, unattended, how long, the
                // sites and what it may do there, the apps, the reason.
                Section("Take") {
                    Text(Display.escape(item.request.name ?? "")).font(.headline)
                    if item.request.unattended { Text(Self.unattendedLine).foregroundStyle(.orange) }
                }
                minutesSection
                Section("Sites") {
                    ForEach(item.request.sites, id: \.self) { Text(Display.escape($0)).font(.body.monospaced()) }
                    if let actions = item.request.browserActions {
                        Text("Browser actions: " + actions.map { Display.escape($0) }.joined(separator: ", "))
                    } else {
                        Text(Self.browserTrueLine)
                    }
                    if item.request.credentials { Text(Self.credentialsLine) }
                }
                appsSection
                reasonSection
                nodeSection
            } else {
                nodeSection
                reasonSection
                appsSection
                minutesSection
            }
            if !item.request.limits.isEmpty {
                Section("Warnings") { ForEach(item.request.limits, id: \.self) { Text(Self.limitText[$0] ?? Display.escape($0)).foregroundStyle(.orange) } }
            }
            Section {
                Button("Allow") {
                    Task { await model.decideLease(item, apps: chosen, minutes: minutes, grant: true); dismiss() }
                }
                .disabled(chosen.isEmpty || model.decidingLease.contains(item.id))
                Button("Deny", role: .destructive) {
                    Task { await model.decideLease(item, apps: [], minutes: 1, grant: false); dismiss() }
                }
                .disabled(model.decidingLease.contains(item.id))
            }
        }
        .navigationTitle(item.request.isTake ? "Take" : "Computer use")
        .onAppear {
            chosen = Set(item.request.apps.map { $0.id })
            minutes = item.request.maxMinutes
        }
    }
}

struct LiveLeaseView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let live = model.liveLease {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(live.locked ? "locked" : Display.escape(live.state)).padding(6).background(chipColor(live).opacity(0.2)).clipShape(Capsule())
                            Spacer()
                            if let expires = live.expiresAt, live.state != "ended" {
                                Text(formatLeft(.seconds(max(0, Int(expires.timeIntervalSince(context.date)))))).monospacedDigit()
                            }
                        }
                        if let frame = live.frame, let image = UIImage(data: frame) {
                            Image(uiImage: image).resizable().scaledToFit()
                        } else {
                            Text("No frame yet").foregroundStyle(.secondary)
                        }
                        if live.frameDropped { Text("Frame dropped (too large)").font(.caption).foregroundStyle(.orange) }
                        if let at = live.frameAt, context.date.timeIntervalSince(at) > 10, live.state == "active" {
                            Text("No frame for more than 10 s").font(.caption).foregroundStyle(.orange)
                        }
                        if let reason = live.reason, live.state != "active" { Text("Reason: \(Display.escape(reason))").font(.caption) }
                        // R-F5-15, R-F5-19: paused for want of contact. With this view open this phone is
                        // watching again, so its own lease continues in a moment; another phone's does not.
                        if Leases.isPausedForContact(state: live.state, reason: live.reason) {
                            Text(model.grantedByOtherText(device: live.grantedByDevice, name: live.grantedByName) == nil
                                 ? "Paused while this view was closed. It continues now that it is open."
                                 : "Paused: the phone that granted it is not watching. You can still stop it here.")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        // R-F5-18: a lease this phone did not grant says who did.
                        if let by = model.grantedByOtherText(device: live.grantedByDevice, name: live.grantedByName) { Text(by).font(.caption) }
                        Button(role: .destructive) { Task { await model.killSwitch() } } label: {
                            Text(live.revoking ? "Revoking…" : "Stop now").frame(maxWidth: .infinity).padding()
                        }
                        .buttonStyle(.borderedProminent).tint(.red)
                        .disabled(live.revoking || live.state == "ended")
                        Text("Actions").font(.headline)
                        ForEach(live.actions) { a in
                            VStack(alignment: .leading) {
                                Text(Display.escape(a.summary))
                                Text("\(Display.escape(a.result)) · \(Display.escape(a.at))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding()
                }
                .navigationTitle(Display.escape(live.nodeName))
            }
        }
        // R-F5-19 (owner ruling, 2026-10-13): this phone watches a lease only
        // while this view is on screen with the app in front. The model is
        // told here and nowhere else. Going to the background stops the
        // watch; a Face ID prompt only makes the scene inactive and does not.
        .onAppear { model.setLiveViewVisible(scenePhase != .background) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.setLiveViewVisible(false) } else if phase == .active { model.setLiveViewVisible(true) }
        }
        // Leaving the screen stops the watch, and forgets only a lease that
        // is over. One that is still running keeps its banner, and so its
        // kill switch, on every tab.
        .onDisappear {
            model.setLiveViewVisible(false)
            if model.liveLease?.state == "ended" { model.closeLiveLease() }
        }
    }

    private func chipColor(_ live: AppModel.LiveLease) -> Color {
        if live.locked { return .gray }
        switch live.state {
        case "active": return .green
        case "suspended": return .orange
        case "ended": return .red
        default: return .blue
        }
    }
}

/// One row, with the kill switch, on every tab, for every lease this phone
/// knows to be running (R-F5-18): the one it is following, and those a
/// pinned node listed with a signed status (granted by another phone, or by
/// this one before a restart). A row of a lease another phone granted says
/// who granted it.
struct LeaseBanner: View {
    @EnvironmentObject var model: AppModel

    /// Revised 2026-10-24: a running lease its node signed as an unattended
    /// take is named by that take and the time it ends; nil for any other
    /// row, which keeps the model's title. The Stop beside it is the same.
    private func takeTitle(_ lease: AppModel.RunningLease) -> String? {
        guard let take = model.unattendedTake(lease) else { return nil }
        return "Unattended take: " + Display.escape(take.name) + ", ends " + take.ends.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        // The stack stays (empty) once no lease is running, so the sheet it
        // presents can still show how a lease ended.
        VStack(spacing: 0) {
            ForEach(model.bannerLeases) { lease in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        if let take = takeTitle(lease) {
                            Button(take) { model.showLease(lease) }
                        } else {
                            Button(model.bannerTitle(lease)) { model.showLease(lease) }
                        }
                        if let by = model.grantedByOtherText(device: lease.grantedByDevice, name: lease.grantedByName) {
                            Text(by).font(.caption).foregroundStyle(.secondary)
                        }
                        // A lease that is not running yet and may still start: what this phone knows of it
                        // (a grant it remembers signing, or only that its node says a request is waiting).
                        if lease.state == "pending" { Text(model.pendingDetail(lease)).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button("Stop", role: .destructive) { Task { await model.stopLease(lease) } }
                        .buttonStyle(.borderedProminent).tint(.red)
                        .disabled(model.isRevoking(lease))
                }
                .padding(8).background(Color.red.opacity(0.1))
            }
            // R-F5-20: a paired computer this phone got no signed answer from
            // about computer use. Said as such; never left to look like
            // "nothing is running".
            if !model.unconfirmedLeaseRows.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(model.unconfirmedLeaseRows) { row in
                        Text(model.leaseCheckText(row)).font(.caption.bold())
                    }
                    Text(Leases.couldNotConfirmDetail).font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8).background(Color.orange.opacity(0.15))
            }
        }
        .sheet(isPresented: $model.showLiveLease) { NavigationStack { LiveLeaseView().environmentObject(model) } }
    }
}
