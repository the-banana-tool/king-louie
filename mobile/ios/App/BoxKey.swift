import CryptoKit
import Foundation
import KLProtocol
import Security

/// The box key (sealed phones plan, R-SP-1, R-SP-10): a Secure Enclave P-256 key
/// that opens what a node seals to this phone. No prompt, and only while the phone
/// is unlocked. It signs nothing. A wrap opens to anyone who holds the key, whoever
/// sealed it, so nothing is believed of a sealed message until its node's signature
/// has held. Its opaque dataRepresentation (a handle only the Secure Enclave can
/// use) lives in the Keychain beside the device key's. A plain value: opening runs
/// off the main actor.
struct BoxKey {
    static let account = "kl.box-key"

    private let dataRepresentation: Data
    let publicKey: P256.KeyAgreement.PublicKey

    private init(dataRepresentation: Data, publicKey: P256.KeyAgreement.PublicKey) {
        self.dataRepresentation = dataRepresentation
        self.publicKey = publicKey
    }

    var x: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 1..<33)) }
    var y: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 33..<65)) }

    /// The public half as a JWK, the `box_key` of an enrollment or statement.
    var jwk: JSONValue { Messages.jwk(x: x, y: y) }

    /// 'b-abcd efgh ijkl mnop', for people to compare.
    var fingerprint: String? { try? Messages.boxKeyFingerprint(x: x, y: y) }

    /// The raw x-coordinate of ECDH with the point (x, y), which the core has
    /// checked is on the curve. A locked phone's Secure Enclave refuses, so every
    /// failure of the key here is SealKeyUnavailable; AppModel tells a locked phone
    /// from a key that stopped working. A peer that does not parse is no such thing.
    func agree(x: String, y: String) throws -> Data {
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + Base64URL.decode(x) + Base64URL.decode(y))
        do {
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: dataRepresentation)
            let secret = try key.sharedSecretFromKeyAgreement(with: peer)
            return secret.withUnsafeBytes { Data($0) }
        } catch {
            throw SealKeyUnavailable("The box key did not answer.")
        }
    }

    /// The key, or nil. Not proof there is none: the Keychain item cannot be read
    /// while the phone is locked, so AppModel asks again when the app comes forward.
    static func load() -> BoxKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data) else { return nil }
        return BoxKey(dataRepresentation: data, publicKey: key.publicKey)
    }

    /// A new box key, replacing any there was. Made by DeviceKey.create, and by the
    /// statement flow for a phone enrolled before it. One agreement while it is made
    /// (the phone is in use now), so a key that cannot agree is never kept.
    static func create() throws -> BoxKey {
        guard SecureEnclave.isAvailable else { throw ProtocolError.malformed("This phone has no Secure Enclave, so it cannot hold a box key.") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage], &error) else {
            throw error.map { $0.takeRetainedValue() as Error } ?? ProtocolError.malformed("Could not set up the box key's access control.")
        }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        _ = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PrivateKey().publicKey)
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: key.dataRepresentation
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ProtocolError.malformed("Could not save the box key in the Keychain (error \(status)).") }
        return BoxKey(dataRepresentation: key.dataRepresentation, publicKey: key.publicKey)
    }

    static func delete() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}

/// The box key as each pinned node knows it (sealed phones plan, R-SP-10; as
/// BoxKeyNodes.kt): the signed `kl.device.box_key` statement kept to re-post it,
/// each node's answer to it, whether any node has been told of this key, and
/// whether this phone refused one. Kept in UserDefaults beside the pins, under its
/// own key. Nothing here holds or uses a key: AppModel signs and sends.
struct BoxKeyNodes: Codable, Equatable {
    // A node's answer to the box-key statement, as kept.
    static let inUse = "in_use"
    static let waiting = "waiting"
    static let offline = "offline"
    static let rejected = "rejected"

    private static let storeKey = "kl.box-key.nodes"

    private var nodes: [String: String] = [:]
    /// The envelope, as JSON, until it expires.
    private var statement: Data?
    /// A statement of this box key went to every node, or every pinned node enrolled
    /// with it. A key made and told to nobody, or to a new node only, still needs the
    /// set-up. So `noneSent` with this set means every node holds it.
    private(set) var sent = false
    /// This phone would not make the key: it enrolled without one.
    private(set) var refused = false

    static func load() -> BoxKeyNodes {
        guard let data = UserDefaults.standard.data(forKey: storeKey), let nodes = try? JSONDecoder().decode(BoxKeyNodes.self, from: data) else { return BoxKeyNodes() }
        return nodes
    }

    private func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.storeKey) }
    }

    /// Reset: what is on disk (the caller clears what is in memory).
    static func clearStored() {
        UserDefaults.standard.removeObject(forKey: storeKey)
    }

    mutating func markSent() {
        sent = true
        save()
    }

    mutating func markRefused(_ value: Bool) {
        refused = value
        save()
    }

    /// No statement was ever needed: the phone enrolled with its box key, so every node holds it.
    var noneSent: Bool { nodes.isEmpty }

    /// A node's answer, in this app's words; nil when it gave none.
    subscript(nodeId: String) -> String? { nodes[nodeId] }

    /// A node was offline when the statement went: it is sent to it again.
    var anyOffline: Bool { nodes.values.contains(Self.offline) }

    /// Keeps a statement for re-posting (until it expires).
    mutating func keep(_ envelope: Envelope) {
        statement = JCS.data(envelope.json)
        save()
    }

    /// The statement kept for re-posting, while it has not expired at `relayNow`; an expired one is forgotten.
    mutating func kept(relayNow: Date) -> Envelope? {
        guard let held = statement else { return nil }
        if let envelope = try? Envelope(json: JSONParser.parse(held)),
           let expires = (try? envelope.message())?["expires_at"]?.stringValue.flatMap({ Timestamps.date($0) }), expires > relayNow {
            return envelope
        }
        statement = nil
        save()
        return nil
    }

    /// Each node's answer to a statement. A first post replaces every answer. A
    /// re-post goes to every node again (the relay forwards it to all), so only the
    /// nodes that were offline take the new answer. `applied`: the node's record
    /// holds this box key. `duplicate`: it has the statement staged, waiting for
    /// `device apply`. The relay words anything else (no answer, a node from before
    /// the box key) `offline`.
    mutating func noteReply(_ reply: JSONValue?, firstPost: Bool) {
        if firstPost { nodes = [:] }
        for n in reply?["nodes"]?.arrayValue ?? [] {
            guard let id = n["node_id"]?.stringValue else { continue }
            if !firstPost, let before = nodes[id], before != Self.offline { continue }
            switch n["state"]?.stringValue {
            case "box-key-pending-apply"?, "duplicate"?: nodes[id] = Self.waiting
            case "applied"?: nodes[id] = Self.inUse
            case "rejected"?: nodes[id] = Self.rejected
            default: nodes[id] = Self.offline
            }
        }
        save()
    }

    /// What an enrollment showed of its box key (only once a statement was needed).
    mutating func set(_ nodeId: String, _ state: String) {
        guard !nodes.isEmpty, nodes[nodeId] != state else { return }
        nodes[nodeId] = state
        save()
    }

    /// A new device key enrolls with its own box key: no set-up is pending.
    mutating func forget() {
        self = BoxKeyNodes()
        save()
    }
}

/// What verified sealed messages opened to, so a poll asks the Secure Enclave once
/// for each and off the main actor (AppModel.warmSeals), and the readers find it
/// done. It holds plaintext, some of it no store keeps, so it lasts only while it is
/// of use: AppModel clears it when the app leaves the foreground, when the live view
/// closes and at Reset, and a view's entry goes as soon as it is read. Successes
/// only; a failure is remembered for one fetch, so a locked phone reads the item once
/// it unlocks. Shared between the main actor and the opening task, under its lock.
final class SealMemo: @unchecked Sendable {
    private static let maxEntries = 32

    private let lock = NSLock()
    private var opened: [Data: JSONValue] = [:]
    /// Oldest first, for the bound.
    private var order: [Data] = []
    private var failed: [Data: Error] = [:]
    /// Moves at every clear: an open that started before one stores nothing.
    private var generation = 0
    private var paused = false

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// `open`, with what is known already, and keeping what it opens.
    func wrapping(_ open: @escaping Opener) -> Opener {
        let asked = locked { generation }
        return { [self] type, message in
            let key = JCS.data(message)
            if let failure = locked({ failed[key] }) { throw failure }
            if let done = locked({ opened[key] }) { return done }
            let result = try open(type, message)
            locked {
                if asked == generation && !paused {
                    opened[key] = result
                    order.removeAll { $0 == key }
                    order.append(key)
                    if order.count > Self.maxEntries { opened[order.removeFirst()] = nil }
                }
            }
            return result
        }
    }

    /// What has already been opened, and a refusal for anything else: it never asks
    /// the key. For what drawing and the counts read.
    var openedOnly: Opener {
        { [self] _, message in
            if let done = locked({ opened[JCS.data(message)] }) { return done }
            throw SealKeyUnavailable("Not opened yet.")
        }
    }

    func holds(_ message: JSONValue) -> Bool {
        let key = JCS.data(message)
        return locked { opened[key] != nil }
    }

    /// A new fetch: what failed before is asked again. Its generation, for `noteFailure`.
    func beginFetch() -> Int {
        locked {
            failed = [:]
            return generation
        }
    }

    func noteFailure(_ message: JSONValue, _ error: Error, generation asked: Int) {
        let key = JCS.data(message)
        locked { if asked == generation { failed[key] = error } }
    }

    func isCurrent(_ asked: Int) -> Bool {
        locked { asked == generation }
    }

    func clear() {
        locked {
            generation += 1
            opened = [:]
            order = []
            failed = [:]
        }
    }

    /// In the background nothing is kept, whatever the live loop still reads.
    func pause() {
        locked { paused = true }
    }

    func resume() {
        locked { paused = false }
    }

    /// A view is read once and holds a frame: its entry does not wait to age out.
    func drop(_ message: JSONValue) {
        let key = JCS.data(message)
        locked {
            opened.removeValue(forKey: key)
            order.removeAll { $0 == key }
        }
    }
}
