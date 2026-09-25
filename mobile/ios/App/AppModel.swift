import Foundation
import KLProtocol
import LocalAuthentication
import SwiftUI
import UIKit

/// What the app keeps (mobile/PRIVACY.md): the relay pin, node pins, its key
/// reference (in the Keychain), the push token and cached history. Nothing
/// else, and no analytics.
struct StoredState: Codable {
    var mode: AppMode = .welcome
    var relayURL: String?
    var relaySpki: String?
    var nodes: [NodePin] = []
    var pushToken: String?

    static let key = "kl.state"

    static func load() -> StoredState {
        guard let data = UserDefaults.standard.data(forKey: key), let state = try? JSONDecoder().decode(StoredState.self, from: data) else { return StoredState() }
        return state
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}

struct PendingItem: Identifiable {
    let id: String
    let envelope: Envelope
    let message: JSONValue
    /// The core's display model (Display.view): every text already escaped.
    let display: JSONValue
    /// Every value whole, for "Show all" (Display.build(collapse: false)).
    let fullText: [String: String]
    let receivedAt: ContinuousClock.Instant
    let expiresInMs: Int
    var status: String?

    /// Counted from receipt on the monotonic clock, never from wall time.
    var timeLeft: Duration {
        let left = Duration.milliseconds(expiresInMs) - (ContinuousClock.now - receivedAt)
        return left < .zero ? .zero : left
    }
}

struct HistoryPage {
    let nodeId: String
    let entries: [JSONValue]
    let asOf: String
}

@MainActor
final class AppModel: ObservableObject {
    /// A request lives at most 300 s (approval-v1 §3.1); a relay cannot stretch it.
    static let maxExpiresInMs = 300_000
    static let retryingStatuses: Set<String> = ["node offline — retrying", "relay busy — retrying"]

    @Published var state = StoredState.load()
    @Published var pending: [PendingItem] = []
    /// A modal message for something the owner did (or must act on).
    @Published var banner: String?
    /// Why the foreground poll is not getting through; shown quietly on the
    /// Pending screen rather than as an alert every few seconds.
    @Published var pollProblem: String?
    @Published private(set) var isPolling = false
    /// Polling waits for the owner's tap: after a cancelled unlock (so the
    /// app never loops on Face ID), and on an invited phone until the other
    /// phone has added it.
    @Published private(set) var needsTap = false
    @Published var onlineNodes: [String: Bool] = [:]
    @Published var devices: [JSONValue] = []
    @Published var history: HistoryPage?
    @Published var fingerprintToCompare: String?
    @Published var inviteQR: String?
    @Published var inviteClaimToConfirm: JSONValue?

    private(set) var key: DeviceKey?
    private var demo: DemoFleet?
    private var client: RelayAPI?
    private var pollTask: Task<Void, Never>?
    private var pollGeneration = 0
    /// A pairing is in progress; the scene must not start a poll under it.
    private var pairing = false
    /// Requests already reported as signed by a changed node key (bounded).
    private var warnedPayloads: Set<String> = []

    var mode: AppMode { state.mode }
    var deviceId: String? { mode == .demo ? demo?.deviceId : key?.deviceId }

    init() {
        key = DeviceKey.load()
        if state.mode == .demo { startDemo() }
        if state.mode == .live { connect() }
    }

    /// The only place a network client is made. RelayClientFactory hands one
    /// out in live mode only, so demo (and welcome) never has one; without a
    /// usable key there is nothing to sign requests with, so no client either.
    private func connect() {
        client?.invalidate()
        client = nil
        guard let key, let base = state.relayURL.flatMap({ URL(string: $0) }) else { return }
        let pin = state.relaySpki ?? ""
        let deviceId = key.deviceId
        let signer: RelayAPI.Signer = { data in try await key.signForSession(data) }
        let factory = RelayClientFactory<RelayAPI> { RelayAPI(base: base, spkiPin: pin, deviceId: deviceId, signer: signer) }
        client = factory.client(for: state.mode)
    }

    // MARK: Errors

    private func friendlyReason(_ reason: String?) -> String {
        switch reason {
        case "action_changed"?: return "the action changed before it ran"
        case "expired"?: return "too late — request expired"
        case let r?: return Display.escape(r)
        case nil: return "no reason given"
        }
    }

    /// The words the owner sees for an error. Never includes a key,
    /// signature or code; relay text is escaped like any other display text.
    private func describe(_ error: Error) -> String {
        if let e = error as? ProtocolError {
            switch e {
            case .keyInvalidated: return DeviceKey.invalidatedMessage
            case .malformed(let why): return why
            }
        }
        if let e = error as? RelayError {
            switch e.code {
            case "clock_skew": return "The relay says this phone's clock is wrong. Check Settings › General › Date & Time."
            case "rate_limited": return e.retryAfter.map { "The relay is busy. Try again in \($0) s." } ?? "The relay is busy. Try again shortly."
            case "code_closed": return "This code is closed. Run enroll-device on the node for a new one."
            case "unknown_code": return "This code is unknown or already closed. Run enroll-device on the node for a new one."
            case "unknown_invite", "already_claimed": return "This invite is used, expired or unknown. Ask the other phone for a new one."
            case "node_offline": return "The node is offline."
            case "gone": return "Too late — this request has expired."
            case "unknown_device": return "The relay does not know this phone yet."
            case "pin_mismatch": return e.message
            default: return e.message.isEmpty ? "The relay refused the request (\(Display.escape(e.code)))." : Display.escape(e.message)
            }
        }
        if let e = error as? LAError {
            switch e.code {
            case .userCancel, .appCancel, .systemCancel: return "Cancelled."
            case .biometryNotEnrolled: return "Set up Face ID or Touch ID first: every approval is signed with it."
            case .biometryLockout: return "Face ID / Touch ID is locked. Unlock the phone with its passcode, then try again."
            default: return e.localizedDescription
            }
        }
        return error.localizedDescription
    }

    private func fail(_ error: Error) {
        if let e = error as? ProtocolError, e == .keyInvalidated {
            dropInvalidKey()
            return
        }
        banner = describe(error)
    }

    /// The Secure Enclave key stopped working (the enrolled biometrics
    /// changed). Forget it, so the next pairing or invite makes a new one.
    private func dropInvalidKey() {
        stopPolling()
        DeviceKey.delete()
        key = nil
        client?.invalidate()
        client = nil
        banner = DeviceKey.invalidatedMessage
        pollProblem = DeviceKey.invalidatedMessage
    }

    // MARK: Demo

    func startDemo() {
        let fleet = DemoFleet()
        demo = fleet
        state.mode = .demo
        state.save()
        pending = []
        for (i, command) in ["nvidia-smi --gpu-reset", "rm -rf ~/Downloads/old", "systemctl restart site"].enumerated() {
            if let env = try? fleet.request(on: i, command: command) {
                receive(.object(["envelope": env.json, "expires_in_ms": .number("300000"), "status": .null]), pins: fleet.pins)
            }
        }
    }

    /// Leaving demo drops the demo fleet and its software key; the hardware
    /// key is made at the first real pairing.
    func leaveDemo() {
        demo = nil
        pending = []
        state = StoredState()
        state.save()
    }

    // MARK: Scanning and pins

    func scanned(_ text: String) async {
        do {
            let payload = try Messages.decodeQR(text.trimmingCharacters(in: .whitespacesAndNewlines))
            switch payload["t"]?.stringValue {
            case "kl.pair"?: try await pairAtConsole(payload)
            case "kl.invite"?: try await claimInvite(payload)
            case "kl.relay"?: try repin(payload)
            default: banner = "That is not a King Louie code."
            }
        } catch {
            fail(error)
        }
    }

    /// `relay` must be an https origin and `relay_spki` a `sha256/` pin.
    private func relayPin(_ payload: JSONValue) throws -> (url: String, spki: String) {
        guard let text = payload["relay"]?.stringValue, let url = URL(string: text), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.path.isEmpty || url.path == "/", url.query == nil, url.user == nil,
              let spki = payload["relay_spki"]?.stringValue, spki.hasPrefix("sha256/"),
              (try? Base64URL.decode(String(spki.dropFirst(7))))?.count == 32 else {
            throw ProtocolError.malformed("This code does not name a relay this app can pin.")
        }
        return (text, spki)
    }

    /// A node pin from a pairing or invite code (never from the relay's node
    /// list). Its id must be the one its Ed25519 key derives.
    private func nodePin(_ node: JSONValue) throws -> NodePin {
        guard let id = node["id"]?.stringValue, let name = node["name"]?.stringValue, let key = node["key"]?.stringValue,
              let spki = try? Hex.decode(key), spki.count == 44, Hex.encode(spki.prefix(12)) == Identifiers.ed25519SpkiPrefix,
              Identifiers.nodeId(ed25519Raw: spki.suffix(32)) == id else {
            throw ProtocolError.malformed("This code carries a node key that does not match its id.")
        }
        return NodePin(id: id, name: name, key: key)
    }

    private func pinNode(_ pin: NodePin) {
        state.nodes.removeAll { $0.id == pin.id }
        state.nodes.append(pin)
    }

    private func ensureKey() throws -> DeviceKey {
        if let key { return key }
        let created = try DeviceKey.create()
        key = created
        return created
    }

    private func deviceObject(for key: DeviceKey) throws -> JSONValue {
        do {
            return try Messages.device(deviceId: key.deviceId, name: UIDevice.current.name, platform: "ios", x: key.jwkX, y: key.jwkY)
        } catch {
            throw ProtocolError.malformed("This phone's name must be 1–64 characters to enroll it. Rename it in Settings › General › About.")
        }
    }

    /// Puts back the pins and mode from before a pairing that did not finish,
    /// demo included.
    private func restore(_ before: StoredState) {
        if before.mode == .demo {
            client?.invalidate()
            client = nil
            state = before
            startDemo()
            return
        }
        state = before
        state.save()
        connect()
        if !needsTap { startPolling() }
    }

    /// base64url text that decodes to exactly `count` bytes.
    private func isToken(_ text: String?, bytes count: Int) -> Bool {
        guard let text, let data = try? Base64URL.decode(text) else { return false }
        return data.count == count
    }

    /// Switches to the pins of a pairing or invite code, remembering what
    /// was there before (demo included) for `restore`.
    private func beginPairing(relay: (url: String, spki: String), pins: [NodePin]) -> StoredState {
        let before = state
        if mode == .demo { leaveDemo() }
        stopPolling()
        state.relayURL = relay.url
        state.relaySpki = relay.spki
        for pin in pins { pinNode(pin) }
        state.mode = .live
        connect()
        return before
    }

    // MARK: Console enrollment

    /// Console enrollment (spec §3.10): the phone signs its own enrollment with
    /// the key it enrolls and proves it scanned the code with code_mac. Its
    /// timestamps come from the relay's clock, which the node's is close to.
    private func pairAtConsole(_ payload: JSONValue) async throws {
        guard let codeId = payload["code_id"]?.stringValue, isToken(codeId, bytes: 16),
              let code = payload["code"]?.stringValue, isToken(code, bytes: 32), let node = payload["node"] else {
            throw ProtocolError.malformed("This pairing code is incomplete.")
        }
        let relay = try relayPin(payload)
        let pin = try nodePin(node)
        let key = try ensureKey()
        let device = try deviceObject(for: key)
        pairing = true
        defer { pairing = false }
        let before = beginPairing(relay: relay, pins: [pin])
        guard let client else {
            restore(before)
            throw ProtocolError.malformed("Could not reach the relay named in this code.")
        }
        let result: String
        do {
            let now = try await client.syncClock()
            let message = try Messages.consoleEnroll(device: device, codeId: codeId, code: code, createdAt: Timestamps.string(now),
                                                     expiresAt: Timestamps.string(now.addingTimeInterval(600)), nonce: Messages.randomNonce())
            let envelope = try await key.signEnvelope(message, reason: "Enroll this phone as an approver for \(Display.escape(pin.name)).")
            fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(key.deviceId)
            try await client.consoleEnroll(codeId: codeId, envelope: envelope)
            result = try await consoleResult(client, codeId: codeId)
        } catch let e as RelayError where e.code == "already_claimed" {
            fingerprintToCompare = nil
            restore(before)
            throw ProtocolError.malformed("Another phone already used this pairing code. Run enroll-device on the node for a new one.")
        } catch {
            fingerprintToCompare = nil
            restore(before)
            throw error
        }
        fingerprintToCompare = nil
        switch result {
        case "done":
            state.save()
            needsTap = false
            banner = "Enrolled. This phone now approves for \(Display.escape(pin.name))."
            startPolling()
            await sendPushToken()
        case "refused":
            restore(before)
            banner = "The node did not enroll this phone."
        default:
            restore(before)
            banner = "The pairing code expired before the node answered. Run enroll-device again."
        }
    }

    /// Waits for the node's answer. The status route is unauthenticated, so
    /// it counts against the relay's 10-per-minute per-IP budget: ask every
    /// 7 s and honour a 429's retry_after.
    private func consoleResult(_ client: RelayAPI, codeId: String) async throws -> String {
        let deadline = ContinuousClock.now + .seconds(11 * 60)
        while ContinuousClock.now < deadline {
            try await Task.sleep(for: .seconds(7))
            do {
                let s = try await client.consoleEnrollState(codeId: codeId)
                if s != "waiting" { return s }
            } catch let e as RelayError where e.code == "rate_limited" {
                try await Task.sleep(for: .seconds(max(e.retryAfter ?? 10, 1)))
            } catch let e as RelayError where e.code == "unknown_code" {
                // The relay dropped the code: it closed long enough ago.
                return "expired"
            }
        }
        return "expired"
    }

    private func repin(_ payload: JSONValue) throws {
        guard mode == .live else {
            banner = "Pair this phone with a node first; the pairing code pins the relay."
            return
        }
        let relay = try relayPin(payload)
        stopPolling()
        state.relayURL = relay.url
        state.relaySpki = relay.spki
        state.save()
        connect()
        banner = "Relay pinned again."
        needsTap = false
        startPolling()
    }

    // MARK: Approvals

    /// A status counts only when the pinned node signed a valid
    /// kl.approval.status for this request (the core's ApprovalStatus).
    private func verifiedStatus(_ json: JSONValue?, requestId: String, pin: NodePin) -> String? {
        guard let json, !json.isNull, let status = ApprovalStatus.verify(json, requestId: requestId, pin: pin) else { return nil }
        if let reason = status.reason, !reason.isEmpty { return "\(status.state): \(friendlyReason(reason))" }
        return status.state
    }

    /// Shows a request only when the core says so (shape, pin, node
    /// signature); everything displayed comes from its display model.
    private func receive(_ item: JSONValue, pins: [NodePin]) {
        guard let envJSON = item["envelope"] else { return }
        let view = Display.view(envJSON, pinned: pins)
        guard view.shown, let display = view.display else {
            if view.reason == "bad_node_signature", let payload = envJSON["payload"]?.stringValue, !warnedPayloads.contains(payload) {
                if warnedPayloads.count >= 64 { warnedPayloads.removeAll() }
                warnedPayloads.insert(payload)
                banner = "Node key changed — pair again."
            }
            return
        }
        guard let env = try? Envelope(json: envJSON), let message = try? env.message(),
              let requestId = message["request_id"]?.stringValue,
              let pin = pins.first(where: { $0.id == env.kid }) else { return }
        let status = verifiedStatus(item["status"], requestId: requestId, pin: pin)
        if let i = pending.firstIndex(where: { $0.id == requestId }) {
            pending[i].status = status ?? pending[i].status
            return
        }
        let expiresInMs = min(item["expires_in_ms"]?.intValue ?? 0, Self.maxExpiresInMs)
        // Already over when it arrived: nothing to decide.
        guard expiresInMs > 0 else { return }
        var fullText: [String: String] = [:]
        for entry in Display.build(message, collapse: false)["items"]?.arrayValue ?? [] {
            if let path = entry["path"]?.stringValue { fullText[path] = entry["text"]?.stringValue ?? "" }
        }
        pending.append(PendingItem(id: requestId, envelope: env, message: message, display: display, fullText: fullText,
                                   receivedAt: .now, expiresInMs: expiresInMs, status: status))
    }

    /// Drops what is over: undecided requests at zero, and decided ones a
    /// minute after they ran out.
    private func pruneExpired() {
        pending.removeAll { item in
            item.timeLeft == .zero && (item.status == nil || ContinuousClock.now - item.receivedAt > .milliseconds(item.expiresInMs) + .seconds(60))
        }
    }

    /// From the scene becoming active: polls unless the owner must tap first
    /// or a pairing is under way.
    func resumePolling() {
        guard !needsTap, !pairing else { return }
        startPolling()
    }

    /// The owner's "Check for requests".
    func checkNow() {
        guard !pairing else { return }
        needsTap = false
        pollProblem = nil
        if client == nil, mode == .live {
            pollProblem = key == nil ? "This phone has no approval key. Scan a pairing code from a node console." : "This phone is not paired with a relay."
            return
        }
        startPolling()
    }

    /// Foreground long-poll (the no-push mode, and the fetch after a tap).
    /// One poll at a time: the relay parks at most two per device.
    func startPolling() {
        guard mode == .live, pollTask == nil, client != nil else { return }
        pollGeneration += 1
        let generation = pollGeneration
        isPolling = true
        pollProblem = nil
        pollTask = Task { [weak self] in
            await self?.pollLoop(generation)
        }
    }

    private func pollLoop(_ generation: Int) async {
        defer {
            if pollGeneration == generation {
                pollTask = nil
                isPolling = false
            }
        }
        while !Task.isCancelled, mode == .live, let client {
            do {
                let items = try await client.approvals(wait: 25)
                pollProblem = nil
                fingerprintToCompare = nil
                for item in items { receive(item, pins: state.nodes) }
                pruneExpired()
            } catch {
                if Task.isCancelled { return }
                if error is LAError {
                    // A cancelled or failed unlock: wait for the owner, never re-prompt on our own.
                    needsTap = true
                    pollProblem = "Locked. Tap “Check for requests” to unlock."
                    return
                }
                if let e = error as? ProtocolError, e == .keyInvalidated {
                    dropInvalidKey()
                    return
                }
                if let e = error as? RelayError, e.code == "pin_mismatch" {
                    banner = e.message
                    pollProblem = e.message
                    needsTap = true
                    return
                }
                pollProblem = describe(error)
                pruneExpired()
                // A request that fails device auth counts against the relay's
                // per-IP budget (10/min, shared by every phone behind the same
                // address), so an unknown device backs off further.
                var wait = 5
                if let e = error as? RelayError {
                    if let after = e.retryAfter { wait = after } else if e.status == 401 || e.code == "rate_limited" { wait = 15 }
                }
                try? await Task.sleep(for: .seconds(max(wait, 1)))
            }
        }
    }

    /// Cancelling drops our connection, but the relay keeps a parked long
    /// poll for up to its 25 s wait. It allows two per device, so one
    /// stop-and-start is fine; a third quick one gets a 429, which the loop
    /// waits out.
    func stopPolling() {
        pollGeneration += 1
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
        key?.endSession()
    }

    /// Approve or deny: a fresh biometric signature over the response, and
    /// only for an action whose hash the node signed.
    func decide(_ item: PendingItem, approve: Bool) async {
        guard item.timeLeft > .zero else {
            setStatus(item.id, "expired")
            banner = "Too late — this request has expired."
            return
        }
        guard let action = item.message["action"], let actionHash = item.message["action_hash"]?.stringValue,
              actionHash == Digest.sha256B64url(JCS.data(action)) else {
            banner = "This request's action does not match its signed hash. Nothing was signed."
            return
        }
        do {
            if mode == .demo, let demo {
                let response = try Messages.response(to: item.message, decision: approve ? "approve" : "deny", deviceId: demo.deviceId, signedAt: Timestamps.string(Date()))
                _ = try Envelope.seal(response, kid: demo.deviceId) { try demo.sign($0) }
                setStatus(item.id, approve ? "approved (demo)" : "denied (demo)")
                return
            }
            guard let key, let client else {
                banner = "This phone is not paired with a relay."
                return
            }
            let response = try Messages.response(to: item.message, decision: approve ? "approve" : "deny", deviceId: key.deviceId,
                                                 signedAt: Timestamps.string(client.now()))
            let summary = item.display["summary"]?.stringValue ?? "this action"
            let envelope = try await key.signEnvelope(response, reason: approve ? "Approve: \(summary)" : "Deny: \(summary)")
            // The prompt takes time; never send once the request has run out.
            guard item.timeLeft > .zero else {
                setStatus(item.id, "expired")
                banner = "Too late — this request has expired."
                return
            }
            guard let reply = try await sendResponse(client, item: item, envelope: envelope) else { return }
            // Only accepted: true is a verdict the node applied. null is never shown as approved.
            switch ResponseOutcome(reply: reply) {
            case .accepted: setStatus(item.id, approve ? "approved" : "denied")
            case .refused(let reason): setStatus(item.id, "refused: \(friendlyReason(reason))")
            case .forwarded: setStatus(item.id, "sent to \(item.display["node"]?["name"]?.stringValue ?? "the node")")
            case .notDelivered: setStatus(item.id, "not delivered")
            }
            if let fresh = try? await client.approval(item.id) { receive(fresh, pins: state.nodes) }
        } catch let e as RelayError where e.code == "gone" {
            setStatus(item.id, "expired")
        } catch {
            clearRetrying(item.id)
            fail(error)
        }
    }

    /// Sends the signed response, retrying while the node is offline (or the
    /// relay asks to wait) and the request still has time left. nil once it ran out.
    private func sendResponse(_ client: RelayAPI, item: PendingItem, envelope: Envelope) async throws -> JSONValue? {
        while true {
            do {
                return try await client.respond(item.id, envelope: envelope) ?? .null
            } catch let e as RelayError where e.code == "node_offline" || e.code == "rate_limited" {
                guard item.timeLeft > .zero else {
                    setStatus(item.id, "expired")
                    return nil
                }
                setStatus(item.id, e.code == "node_offline" ? "node offline — retrying" : "relay busy — retrying")
                try await Task.sleep(for: .seconds(max(e.retryAfter ?? 3, 1)))
            }
        }
    }

    private func setStatus(_ id: String, _ status: String) {
        if let i = pending.firstIndex(where: { $0.id == id }) { pending[i].status = status }
    }

    /// After an error that ends the retries, the request is undecided again.
    private func clearRetrying(_ id: String) {
        if let i = pending.firstIndex(where: { $0.id == id }), let status = pending[i].status, Self.retryingStatuses.contains(status) {
            pending[i].status = nil
        }
    }

    // MARK: History, nodes, devices

    func loadHistory(nodeId: String, beforeSeq: Int? = nil) async {
        guard let client, let pin = state.nodes.first(where: { $0.id == nodeId }) else { return }
        do {
            guard let envelope = try await client.history(nodeId: nodeId, limit: 50, beforeSeq: beforeSeq) else { return }
            let result = AuditSlice.verify(envelope, nodeKeyHex: pin.key)
            guard result.ok else {
                banner = "History from \(Display.escape(pin.name)) did not verify (\(Display.escape(result.reason ?? "unknown")))."
                return
            }
            // Signed by the pinned key, and about the node that was asked for.
            let slice = try? Envelope(json: envelope).message()
            guard let sliceNode = slice?["node_id"]?.stringValue, sliceNode == pin.id else {
                banner = "History from \(Display.escape(pin.name)) is about a different node."
                return
            }
            history = HistoryPage(nodeId: nodeId, entries: Array(result.entries.reversed()), asOf: slice?["created_at"]?.stringValue ?? "")
        } catch {
            fail(error)
        }
    }

    func refreshNodes() async {
        guard let client else { return }
        do {
            for node in try await client.nodes() {
                if let id = node["node_id"]?.stringValue { onlineNodes[id] = node["online"]?.boolValue ?? false }
            }
        } catch {
            fail(error)
        }
    }

    func pairingCode(forNode name: String) async -> String? {
        guard let client else { return nil }
        do {
            return try await client.pairingCode(nodeName: name)?["code"]?.stringValue
        } catch {
            fail(error)
            return nil
        }
    }

    func refreshDevices() async {
        guard let client else { return }
        do { devices = try await client.devices() } catch { fail(error) }
    }

    /// Phone A: create an invite and show it with the relay and node pins.
    func startInvite() async {
        guard let client else { return }
        do {
            guard let invite = try await client.createInvite(), let inviteId = invite["invite_id"]?.stringValue, isToken(inviteId, bytes: 16) else {
                banner = "The relay did not return an invite."
                return
            }
            let secret = Messages.randomNonce()
            inviteQR = Messages.encodeQR(.object([
                "t": .string("kl.invite"),
                "relay": .string(state.relayURL ?? ""),
                "relay_spki": .string(state.relaySpki ?? ""),
                "invite_id": .string(inviteId),
                "secret": .string(secret),
                "nodes": .array(state.nodes.map { .object(["id": .string($0.id), "name": .string($0.name), "key": .string($0.key)]) })
            ]))
            // Device-authenticated, so asking every 2 s stays inside the
            // per-device budget; a 429 is waited out. The invite lives 10 minutes.
            let deadline = ContinuousClock.now + .seconds(10 * 60)
            while ContinuousClock.now < deadline {
                let claim: JSONValue?
                do {
                    claim = try await client.inviteClaim(inviteId)
                } catch let e as RelayError where e.code == "rate_limited" {
                    try await Task.sleep(for: .seconds(max(e.retryAfter ?? 10, 1)))
                    continue
                }
                if let claim, !claim.isNull {
                    inviteQR = nil
                    guard let device = verifiedClaim(claim, secret: secret) else {
                        banner = "The invite was claimed by something that did not scan it. Nothing was enrolled."
                        return
                    }
                    inviteClaimToConfirm = device
                    return
                }
                try await Task.sleep(for: .seconds(2))
            }
            inviteQR = nil
            banner = "Nobody used the invite within 10 minutes."
        } catch {
            inviteQR = nil
            fail(error)
        }
    }

    /// The claimed device, exactly as a valid enrollment would carry it
    /// (Messages.device rebuilds and checks it), with a mac only the scanner
    /// of this invite could make.
    private func verifiedClaim(_ claim: JSONValue, secret: String) -> JSONValue? {
        guard let device = claim["device"], let mac = claim["mac"]?.stringValue,
              let id = device["device_id"]?.stringValue, let name = device["name"]?.stringValue,
              let platform = device["platform"]?.stringValue, platform == "ios" || platform == "android",
              let x = device["public_key"]?["x"]?.stringValue, let y = device["public_key"]?["y"]?.stringValue,
              let rebuilt = try? Messages.device(deviceId: id, name: name, platform: platform, x: x, y: y), rebuilt == device,
              id != key?.deviceId,
              let expected = try? Messages.inviteMac(secret: secret, device: device), expected == mac else { return nil }
        return device
    }

    /// Phone A, after both screens show the same id: sign B's enrollment.
    func confirmInvitedDevice() async {
        guard let device = inviteClaimToConfirm, let key, let client else { return }
        inviteClaimToConfirm = nil
        do {
            let now = client.now()
            let message = try Messages.signedEnroll(device: device, enrolledBy: key.deviceId, createdAt: Timestamps.string(now),
                                                    expiresAt: Timestamps.string(now.addingTimeInterval(600)), nonce: Messages.randomNonce())
            let name = Display.escape(device["name"]?.stringValue ?? "the new phone")
            let envelope = try await key.signEnvelope(message, reason: "Add \(name) as an approver.")
            let result = try await client.enrollDevice(envelope)
            let lines = (result?["nodes"]?.arrayValue ?? []).map { n -> String in
                let id = n["node_id"]?.stringValue ?? ""
                let label = state.nodes.first(where: { $0.id == id }).map { Display.escape($0.name) } ?? Display.escape(id)
                return "\(label): \(Display.escape(n["state"]?.stringValue ?? "unknown"))"
            }
            banner = "Sent to \(lines.count) node(s)" + (lines.isEmpty ? "." : " — " + lines.joined(separator: ", ") + ".")
                + " An administrator applies it on each node with `device apply`."
        } catch {
            fail(error)
        }
    }

    /// Phone B: claim an invite from phone A. It does not poll until the
    /// owner taps: the relay knows this phone only once phone A has added it.
    private func claimInvite(_ payload: JSONValue) async throws {
        guard let inviteId = payload["invite_id"]?.stringValue, isToken(inviteId, bytes: 16),
              let secret = payload["secret"]?.stringValue, isToken(secret, bytes: 32),
              let nodes = payload["nodes"]?.arrayValue, !nodes.isEmpty else {
            throw ProtocolError.malformed("This invite is incomplete.")
        }
        let relay = try relayPin(payload)
        let pins = try nodes.map { try nodePin($0) }
        let key = try ensureKey()
        let device = try deviceObject(for: key)
        let mac = try Messages.inviteMac(secret: secret, device: device)
        pairing = true
        defer { pairing = false }
        let before = beginPairing(relay: relay, pins: pins)
        guard let client else {
            restore(before)
            throw ProtocolError.malformed("Could not reach the relay named in this invite.")
        }
        do {
            try await client.claimInvite(inviteId, device: device, mac: mac)
        } catch {
            restore(before)
            throw error
        }
        state.save()
        fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(key.deviceId)
        needsTap = true
        pollProblem = "When the other phone has added this one, tap “Check for requests”."
        banner = "Check that the other phone shows the same id, then confirm there."
        await sendPushToken()
    }

    func revoke(deviceId target: String, name: String) async {
        guard let key, let client else { return }
        do {
            let now = client.now()
            let message = try Messages.revoke(deviceId: target, revokedBy: key.deviceId, reason: "revoked from a phone",
                                              createdAt: Timestamps.string(now), expiresAt: Timestamps.string(now.addingTimeInterval(3600)), nonce: Messages.randomNonce())
            let label = name.isEmpty ? "d-" + Identifiers.fingerprintGroups(target) : name
            let envelope = try await key.signEnvelope(message, reason: "Revoke \(Display.escape(label)) on every node.")
            _ = try await client.revokeDevice(envelope)
            await refreshDevices()
        } catch {
            fail(error)
        }
    }

    // MARK: Push

    func registerPushToken(_ token: String) async {
        state.pushToken = token
        state.save()
        await sendPushToken()
    }

    private func sendPushToken() async {
        guard mode == .live, let client, let token = state.pushToken else { return }
        do { try await client.pushToken(token) } catch { fail(error) }
    }

    /// A push carries only { kind, id }: fetch the envelope and verify it.
    func openPushed(requestId: String) async {
        guard let client else { return }
        // A request id is a lowercase UUID; anything else is not ours to fetch.
        guard requestId.count == 36, requestId.unicodeScalars.allSatisfy({ "0123456789abcdef-".unicodeScalars.contains($0) }) else { return }
        do {
            if let item = try await client.approval(requestId) { receive(item, pins: state.nodes) }
        } catch {
            fail(error)
        }
    }

    func reset() {
        stopPolling()
        DeviceKey.delete()
        key = nil
        client?.invalidate()
        client = nil
        demo = nil
        pending = []
        history = nil
        devices = []
        onlineNodes = [:]
        inviteQR = nil
        inviteClaimToConfirm = nil
        fingerprintToCompare = nil
        needsTap = false
        pollProblem = nil
        state = StoredState()
        state.save()
    }
}
