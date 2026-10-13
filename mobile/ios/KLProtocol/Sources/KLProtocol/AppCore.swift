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

    /// A node-signed lease request, as a real node would send it (demo mode, §3.10).
    public func leaseRequest(on index: Int, apps: [String], minutes: Int, now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let lease: JSONValue = .object([
            "kind": .string("computer_use"),
            "job_id": .string("job-demo"),
            "apps": .array(apps.map { id -> JSONValue in
                .object(["id": .string(id), "name": .string(id.capitalized), "path": .string("/Applications/\(id.capitalized).app"), "processes": .array([])])
            }),
            "max_minutes": .number(String(minutes)),
            "reason": .string("Enter the monthly totals"),
            "resumes": .null,
            "limits": .array([])
        ])
        let message: JSONValue = .object([
            "v": .number("1"),
            "type": .string("kl.lease.request"),
            "request_id": .string(UUID().uuidString.lowercased()),
            "lease_id": .string(UUID().uuidString.lowercased()),
            "node_id": .string(node.pin.id),
            "node_name": .string(node.pin.name),
            "lease": lease,
            "lease_hash": .string(Digest.sha256B64url(JCS.data(lease))),
            "origin": .object(["client": .string("demo"), "session": .null, "job_id": .string("job-demo")]),
            "created_at": .string(Timestamps.string(now)),
            "expires_at": .string(Timestamps.string(now.addingTimeInterval(300))),
            "nonce": .string(Messages.randomNonce())
        ])
        return try Envelope.seal(message, alg: "Ed25519", kid: node.pin.id) { bytes in
            try node.key.signature(for: bytes)
        }
    }

    /// A node-signed view carrying a canned frame (the app draws it).
    public func leaseView(on index: Int, leaseId: String, seq: Int, toDevice: String, frame: Data, remaining: Int, actions: [LeaseAction], now: Date = Date()) throws -> Envelope {
        let node = nodes[index]
        let message: JSONValue = .object([
            "v": .number("1"), "type": .string("kl.lease.view"), "node_id": .string(node.pin.id), "lease_id": .string(leaseId),
            "seq": .number(String(seq)), "at": .string(Timestamps.string(now)), "to_device": .string(toDevice),
            "state": .string("active"), "locked": .bool(false), "remaining_s": .number(String(remaining)),
            "foreground": .object(["app_id": .string("calculator"), "matches": .bool(true)]),
            "frame": .object(["mime": .string("image/jpeg"), "width": .number("960"), "height": .number("640"),
                              "sha256": .string(Digest.sha256B64url(frame)), "data": .string(frame.base64EncodedString())]),
            "frame_dropped": .bool(false),
            "actions": .array(actions.map { a -> JSONValue in
                .object(["seq": .number(String(a.seq)), "at": .string(a.at), "tool": .string(a.tool), "summary": .string(a.summary), "result": .string(a.result)])
            })
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
