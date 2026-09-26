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
/// authorities are ignored; redirects are refused. Nothing here logs a key,
/// signature or code.
final class RelayAPI: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    typealias Signer = @MainActor (Data) async throws -> Data

    let base: URL
    let spkiPin: String
    private let deviceId: String?
    private let signer: Signer?
    private let lock = NSLock()
    private var clockOffset: TimeInterval = 0
    /// Tasks whose server certificate did not match the pin.
    private var pinRefusedTasks: Set<Int> = []
    /// Set by invalidate(); an invalidated session must never be asked for a
    /// new task (URLSession raises NSGenericException).
    private var invalidated = false
    private var session: URLSession!

    init(base: URL, spkiPin: String, deviceId: String?, signer: Signer?) {
        self.base = base
        self.spkiPin = spkiPin
        self.deviceId = deviceId
        self.signer = signer
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    /// The relay's clock as far as this client knows it (local time plus the
    /// offset learned from a clock_skew answer or GET /v1/time).
    func now() -> Date {
        Date().addingTimeInterval(locked { clockOffset })
    }

    /// Asks the relay for its time (unauthenticated) and keeps the offset.
    func syncClock() async throws -> Date {
        guard let text = try await request("GET", "/v1/time", auth: false).1?["server_time"]?.stringValue,
              let server = Timestamps.date(text) else {
            throw RelayError(status: 0, code: "bad_reply", message: "The relay sent a reply this app cannot read.")
        }
        let offset = server.timeIntervalSinceNow
        locked { clockOffset = offset }
        return server
    }

    /// The session keeps its delegate (this object) alive; call this when the
    /// client is replaced so both go away.
    func invalidate() {
        // The flag goes up under the lock that also covers task creation in
        // send(), so no task can be created after this point.
        locked { invalidated = true }
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

    /// Task-level on purpose: with no session-level handler, URLSession
    /// sends the server-trust challenge here, with the task, so a refusal is
    /// recorded against the one request it belongs to. Do not add a
    /// session-level `urlSession(_:didReceive:completionHandler:)`: it would
    /// take server trust away from this method, and any such handler must
    /// run exactly this pin check (and record the refusal) or the pin is gone.
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first, let pin = Self.spkiPin(of: leaf), pin == spkiPin else {
            let id = task.taskIdentifier
            locked { _ = pinRefusedTasks.insert(id) }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private func takePinRefusal(_ taskId: Int) -> Bool {
        locked { pinRefusedTasks.remove(taskId) != nil }
    }

    /// Redirects are refused: the 3xx itself comes back and is an error.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// One data task, cancelled with the calling Swift task. A pin refusal
    /// for this task becomes `pin_mismatch`; any other cancellation stays a
    /// URLError.
    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let handle = TaskHandle()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, URLResponse), Error>) in
                let once = ResumeOnce(continuation)
                let task: URLSessionDataTask? = locked {
                    guard !invalidated else { return nil }
                    return session.dataTask(with: request) { [weak self] data, response, error in
                        let refused = self?.takePinRefusal(handle.identifier) ?? false
                        if refused {
                            once.resume(throwing: RelayError(status: 0, code: "pin_mismatch", message: "Relay certificate changed — scan a new relay code."))
                        } else if let error {
                            once.resume(throwing: error)
                        } else if let data, let response {
                            once.resume(returning: (data, response))
                        } else {
                            once.resume(throwing: URLError(.badServerResponse))
                        }
                    }
                }
                guard let task else {
                    once.resume(throwing: URLError(.cancelled))
                    return
                }
                // Cancelled before it could start: never resumed, so its
                // completion may never run. Answer here; a late completion
                // is ignored by ResumeOnce.
                if !handle.start(task) {
                    once.resume(throwing: URLError(.cancelled))
                    task.cancel()
                }
            }
        } onCancel: {
            handle.cancel()
        }
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
    /// `signWith` replaces the client's signer for this one request (a
    /// presence ping signs only with an already-unlocked session).
    func request(_ method: String, _ pathWithQuery: String, body: JSONValue? = nil, auth: Bool = true, retried: Bool = false,
                 signWith: Signer? = nil, makeBody: (() -> JSONValue)? = nil) async throws -> (Int, JSONValue?) {
        // `makeBody` builds the body on each attempt, so a clock_skew retry
        // uses the corrected clock (presence `at`).
        let sentBody = makeBody?() ?? body
        let bodyData = sentBody.map { JCS.data($0) } ?? Data()
        guard let url = URL(string: pathWithQuery, relativeTo: base) else {
            throw RelayError(status: 0, code: "bad_request", message: "Could not build the relay address.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // A long poll waits up to 25 s on the relay.
        request.timeoutInterval = 40
        if sentBody != nil {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth, let deviceId, let signer = signWith ?? signer {
            let offset = locked { clockOffset }
            let timestamp = Timestamps.string(Date().addingTimeInterval(offset))
            let s = Messages.phoneAuthString(method: method, pathWithQuery: pathWithQuery, timestamp: timestamp, body: bodyData)
            let signature = try await signer(Data(s.utf8))
            request.setValue(deviceId, forHTTPHeaderField: "X-KL-Device")
            request.setValue(timestamp, forHTTPHeaderField: "X-KL-Timestamp")
            request.setValue(Base64URL.encode(signature), forHTTPHeaderField: "X-KL-Signature")
        }
        let (data, response) = try await send(request)
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
            return try await self.request(method, pathWithQuery, body: body, auth: auth, retried: true, signWith: signWith,
                                          makeBody: makeBody)
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

    // Cases stage 4: node-signed kl.question.ask envelopes, device-signed answers back.
    /// `signWith`: sign with this instead of the client's signer (the
    /// no-prompt session signer when the screen merely appears).
    func questions(signWith: Signer? = nil) async throws -> [JSONValue] {
        try await request("GET", "/v1/questions", signWith: signWith).1?.arrayValue ?? []
    }

    /// The node's `{ ok, outcome, ack }` or `{ ok: false, error }`, passed through by the relay.
    func answerQuestion(_ token: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/questions/\(Self.segment(token))/answer", body: envelope.json).1
    }

    /// Unsigned foreground ping `{ foreground, at }` (ruling T17-presence),
    /// `at` in ms since the epoch on the relay-corrected clock. The request
    /// itself is device-authenticated with `signer`.
    func presence(foreground: Bool, signer: @escaping Signer) async throws {
        _ = try await request("POST", "/v1/presence", signWith: signer, makeBody: { [unowned self] in
            let at = Int64((self.now().timeIntervalSince1970 * 1000).rounded())
            return .object(["foreground": .bool(foreground), "at": .number(String(at))])
        })
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

/// The data task behind one request: started once, cancellable from any
/// thread, including before it starts.
private final class TaskHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false
    private var taskIdentifier = -1

    var identifier: Int {
        lock.lock()
        defer { lock.unlock() }
        return taskIdentifier
    }

    /// Resumes the task, or returns false (and leaves it alone) when the
    /// request was already cancelled.
    func start(_ task: URLSessionTask) -> Bool {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return false
        }
        self.task = task
        taskIdentifier = task.taskIdentifier
        lock.unlock()
        task.resume()
        return true
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

/// A continuation resumed at most once, whichever of the completion handler
/// and the cancellation path gets there first.
private final class ResumeOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    init(_ continuation: CheckedContinuation<T, Error>) {
        self.continuation = continuation
    }

    private func take() -> CheckedContinuation<T, Error>? {
        lock.lock()
        defer { lock.unlock() }
        let c = continuation
        continuation = nil
        return c
    }

    func resume(returning value: T) {
        take()?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        take()?.resume(throwing: error)
    }
}
