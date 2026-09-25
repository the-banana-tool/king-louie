import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum AppMode: String, Codable, Equatable {
    case welcome
    case demo
    case live
}

/// The only way the app obtains a network client. Demo mode never gets one:
/// the factory refuses, and `built` proves it in tests.
public final class RelayClientFactory<Client> {
    public private(set) var built = 0
    private let make: () -> Client

    public init(make: @escaping () -> Client) {
        self.make = make
    }

    public func client(for mode: AppMode) -> Client? {
        guard mode == .live else { return nil }
        built += 1
        return make()
    }
}

/// Three pretend nodes with in-app keys and a software phone key, shown
/// under a "Demo" banner. Nothing here touches the network.
public final class DemoFleet {
    public struct Node {
        public let pin: NodePin
        fileprivate let key: Curve25519.Signing.PrivateKey
    }

    public let nodes: [Node]
    private let deviceKey = P256.Signing.PrivateKey()

    public init(names: [String] = ["gpu-box", "laptop", "web-01"]) {
        nodes = names.map { name in
            let key = Curve25519.Signing.PrivateKey()
            let raw = key.publicKey.rawRepresentation
            return Node(pin: NodePin(id: Identifiers.nodeId(ed25519Raw: raw), name: name, key: Identifiers.ed25519SpkiPrefix + Hex.encode(raw)), key: key)
        }
    }

    public var pins: [NodePin] { nodes.map { $0.pin } }

    public var deviceId: String {
        Identifiers.deviceId(raw: deviceKey.publicKey.x963Representation)
    }

    /// A node-signed request, as a real node would send it.
    public func request(on index: Int, command: String, now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let action: JSONValue = .object([
            "kind": .string("tool"),
            "name": .string("Bash"),
            "params": .object(["command": .string(command)]),
            "cwd": .string("/srv/site"),
            "summary": .string(Self.summary("Bash(\(command))"))
        ])
        let message: JSONValue = .object([
            "v": .number("1"),
            "type": .string("kl.approval.request"),
            "request_id": .string(UUID().uuidString.lowercased()),
            "node_id": .string(node.pin.id),
            "node_name": .string(node.pin.name),
            "action": action,
            "action_hash": .string(Digest.sha256B64url(JCS.data(action))),
            "origin": .object(["client": .string("demo"), "session": .null, "job_id": .null]),
            "created_at": .string(Timestamps.string(now)),
            "expires_at": .string(Timestamps.string(now.addingTimeInterval(300))),
            "nonce": .string(Messages.randomNonce())
        ])
        return try Envelope.seal(message, alg: "Ed25519", kid: node.pin.id) { bytes in
            try node.key.signature(for: bytes)
        }
    }

    /// The software key signs demo answers; it is deleted when the owner leaves demo.
    public func sign(_ data: Data) throws -> Data {
        try deviceKey.signature(for: data).rawRepresentation
    }

    /// A summary is at most 300 code points, cut with "…" (the node's cutSummary).
    static func summary(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count > 300 else { return text }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: scalars[0..<299])
        cut.append("\u{2026}")
        return String(cut)
    }
}
