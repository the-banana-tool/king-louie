import CryptoKit
import Foundation
import KLProtocol
import Security

/// A relay answer outside 2xx: `{ "error": "<code>", "message": "…" }`, plus
/// `retry_after` (seconds) on 429. Codes the app acts on: clock_skew,
/// rate_limited, code_closed, unknown_code, node_offline, gone, forbidden,
/// unknown_device. `pin_mismatch` and `bad_reply` are the app's own.
struct RelayError: Error, LocalizedError {
    let status: Int
    let code: String
    let message: String
    var retryAfter: Int? = nil
    var errorDescription: String? { message.isEmpty ? code : message }
}

/// The relay's phone API over HTTPS (approval-v1 §7). The TLS leaf
/// certificate's public key must match the pinned SPKI hash; certificate
/// authorities are ignored. Nothing here logs a key, signature or code.
final class RelayAPI: NSObject, URLSessionDelegate, @unchecked Sendable {
    typealias Signer = @MainActor (Data) async throws -> Data

    let base: URL
    let spkiPin: String
    private let deviceId: String?
    private let signer: Signer?
    private let lock = NSLock()
    private var clockOffset: TimeInterval = 0
    private var pinRefused = false
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    init(base: URL, spkiPin: String, deviceId: String?, signer: Signer?) {
        self.base = base
        self.spkiPin = spkiPin
        self.deviceId = deviceId
        self.signer = signer
    }

    /// The session keeps its delegate (this object) alive; call this when the
    /// client is replaced so both go away.
    func invalidate() {
        session.invalidateAndCancel()
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: Pinning

    // DER SubjectPublicKeyInfo headers for the key types a relay certificate
    // may use. SecKeyCopyExternalRepresentation gives the raw key (EC: the
    // X9.63 point; RSA: PKCS#1), so the header is put back before hashing.
    private static let spkiHeaders: [String: [UInt8]] = [
        "ec256": [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00],
        "ec384": [0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00],
        "rsa2048": [0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00],
        "rsa3072": [0x30, 0x82, 0x01, 0xa2, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x8f, 0x00],
        "rsa4096": [0x30, 0x82, 0x02, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x02, 0x0f, 0x00]
    ]

    /// `sha256/<b64url of SHA-256 over the SPKI DER>` (src/frontdoor/tls.js),
    /// or nil for a key type not listed above.
    static func spkiPin(of certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }
        let type = attributes[kSecAttrKeyType as String] as? String
        let bits = attributes[kSecAttrKeySizeInBits as String] as? Int ?? 0
        let name: String
        if type == (kSecAttrKeyTypeECSECPrimeRandom as String) {
            name = "ec\(bits)"
        } else if type == (kSecAttrKeyTypeRSA as String) {
            name = "rsa\(bits)"
        } else {
            return nil
        }
        guard let header = spkiHeaders[name] else { return nil }
        return "sha256/" + Digest.sha256B64url(Data(header) + raw)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first, let pin = Self.spkiPin(of: leaf), pin == spkiPin else {
            locked { pinRefused = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    // MARK: Requests

    /// One path segment, percent-encoded so an id can never add a segment or
    /// a query. The signed string is the encoded path, exactly as sent.
    static func segment(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    /// Device-signed unless `auth` is false (code and invite routes). A 401
    /// clock_skew is answered once, using the relay's `server_time` as the
    /// offset for this and every later request.
    func request(_ method: String, _ pathWithQuery: String, body: JSONValue? = nil, auth: Bool = true, retried: Bool = false) async throws -> (Int, JSONValue?) {
        let bodyData = body.map { JCS.data($0) } ?? Data()
        guard let url = URL(string: pathWithQuery, relativeTo: base) else {
            throw RelayError(status: 0, code: "bad_request", message: "Could not build the relay address.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // A long poll waits up to 25 s on the relay.
        request.timeoutInterval = 40
        if body != nil {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth, let deviceId, let signer {
            let offset = locked { clockOffset }
            let timestamp = Timestamps.string(Date().addingTimeInterval(offset))
            let s = Messages.phoneAuthString(method: method, pathWithQuery: pathWithQuery, timestamp: timestamp, body: bodyData)
            let signature = try await signer(Data(s.utf8))
            request.setValue(deviceId, forHTTPHeaderField: "X-KL-Device")
            request.setValue(timestamp, forHTTPHeaderField: "X-KL-Timestamp")
            request.setValue(Base64URL.encode(signature), forHTTPHeaderField: "X-KL-Signature")
        }
        locked { pinRefused = false }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled && locked({ pinRefused }) {
            throw RelayError(status: 0, code: "pin_mismatch", message: "Relay certificate changed — scan a new relay code.")
        }
        let (data, response) = result
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) {
            guard !data.isEmpty else { return (status, nil) }
            do {
                return (status, try JSONParser.parse(data))
            } catch {
                throw RelayError(status: status, code: "bad_reply", message: "The relay sent a reply this app cannot read.")
            }
        }
        let json = data.isEmpty ? nil : try? JSONParser.parse(data)
        let code = json?["error"]?.stringValue ?? "http_\(status)"
        if status == 401, code == "clock_skew", !retried,
           let serverTime = json?["server_time"]?.stringValue, let server = Timestamps.date(serverTime) {
            let offset = server.timeIntervalSinceNow
            locked { clockOffset = offset }
            return try await self.request(method, pathWithQuery, body: body, auth: auth, retried: true)
        }
        throw RelayError(status: status, code: code, message: json?["message"]?.stringValue ?? "",
                         retryAfter: json?["retry_after"]?.intValue)
    }

    func approvals(wait: Int) async throws -> [JSONValue] {
        try await request("GET", "/v1/approvals?wait=\(wait)").1?.arrayValue ?? []
    }

    func approval(_ requestId: String) async throws -> JSONValue? {
        try await request("GET", "/v1/approvals/\(Self.segment(requestId))").1
    }

    /// `202 { delivered, accepted, reason }`; read it with ResponseOutcome.
    func respond(_ requestId: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/approvals/\(Self.segment(requestId))/response", body: envelope.json).1
    }

    func nodes() async throws -> [JSONValue] {
        try await request("GET", "/v1/nodes").1?.arrayValue ?? []
    }

    func history(nodeId: String, limit: Int, beforeSeq: Int?) async throws -> JSONValue? {
        let before = beforeSeq.map { "&before_seq=\($0)" } ?? ""
        return try await request("GET", "/v1/nodes/\(Self.segment(nodeId))/history?limit=\(limit)\(before)").1
    }

    func pairingCode(nodeName: String) async throws -> JSONValue? {
        try await request("POST", "/v1/pairing-codes", body: .object(["node_name": .string(nodeName)])).1
    }

    func createInvite() async throws -> JSONValue? {
        try await request("POST", "/v1/devices/invites").1
    }

    /// The claim, or JSON null while nobody has claimed the invite.
    func inviteClaim(_ inviteId: String) async throws -> JSONValue? {
        try await request("GET", "/v1/devices/invites/\(Self.segment(inviteId))").1?["claim"]
    }

    func claimInvite(_ inviteId: String, device: JSONValue, mac: String) async throws {
        _ = try await request("POST", "/v1/devices/invites/\(Self.segment(inviteId))/claim",
                              body: .object(["device": device, "mac": .string(mac)]), auth: false)
    }

    func enrollDevice(_ envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/devices/enroll", body: envelope.json).1
    }

    func revokeDevice(_ envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/devices/revoke", body: envelope.json).1
    }

    func devices() async throws -> [JSONValue] {
        try await request("GET", "/v1/devices").1?.arrayValue ?? []
    }

    func pushToken(_ token: String) async throws {
        _ = try await request("PUT", "/v1/push-token", body: .object(["platform": .string("apns"), "token": .string(token)]))
    }

    /// `202 { state: 'waiting' }`, or 410 code_closed once the code is closed.
    func consoleEnroll(codeId: String, envelope: Envelope) async throws {
        _ = try await request("POST", "/v1/enroll/\(Self.segment(codeId))", body: envelope.json, auth: false)
    }

    /// waiting | done | refused | expired.
    func consoleEnrollState(codeId: String) async throws -> String {
        try await request("GET", "/v1/enroll/\(Self.segment(codeId))", auth: false).1?["state"]?.stringValue ?? "waiting"
    }
}
