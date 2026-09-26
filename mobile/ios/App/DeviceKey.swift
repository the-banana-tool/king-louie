import CryptoKit
import Foundation
import KLProtocol
import LocalAuthentication
import Security

/// A signing failure that does not prove the key is gone (a locked device,
/// a transient Secure Enclave error). The key is kept; it is only replaced
/// at the next pairing or invite.
struct DeviceKeyUnusable: Error, LocalizedError {
    var errorDescription: String? {
        "This phone's key could not sign just now. Try again; if it keeps failing, pair the phone again from a node console or another phone."
    }
}

/// This phone's approval key: a Secure Enclave P-256 key that signs only
/// after Face ID / Touch ID, and stops working when the enrolled biometrics
/// change (.biometryCurrentSet). Its opaque dataRepresentation (a handle the
/// Secure Enclave alone can use, never the private key) lives in the
/// Keychain, readable only while this device is unlocked. Nothing here is
/// ever logged or exported.
///
/// Main-actor isolated: AppModel and RelayAPI's signer both call it there,
/// so the session context below has one writer.
@MainActor
final class DeviceKey {
    static let account = "kl.device-key"
    /// SHA-256 of the biometric domain state when the key was made. It
    /// changes exactly when the enrolled biometrics change, which is what
    /// invalidates a .biometryCurrentSet key. Not secret; only a comparison.
    static let domainStateKey = "kl.device-key.domain-state"
    static let invalidatedMessage = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

    private let dataRepresentation: Data
    let publicKey: P256.Signing.PublicKey
    /// A signature failed without proof the key is gone; ensureKey replaces
    /// the key at the next pairing or invite. Cleared by the next signature.
    private(set) var unusable = false
    /// One unlock for API requests while the app is in use; every approval,
    /// enrollment and revocation still asks again (see sign(_:reason:)).
    private var sessionContext: LAContext?
    /// The unlock in progress, so two API calls at once share one prompt.
    private var unlocking: Task<LAContext, Error>?

    private init(dataRepresentation: Data, publicKey: P256.Signing.PublicKey) {
        self.dataRepresentation = dataRepresentation
        self.publicKey = publicKey
    }

    var deviceId: String { Identifiers.deviceId(raw: publicKey.x963Representation) }
    var jwkX: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 1..<33)) }
    var jwkY: String { Base64URL.encode(publicKey.x963Representation.subdata(in: 33..<65)) }

    static func load() -> DeviceKey? {
        guard case .found(let data) = keychainRead(), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) else { return nil }
        return DeviceKey(dataRepresentation: data, publicKey: key.publicKey)
    }

    /// Made at the first real pairing (never in demo mode).
    static func create() throws -> DeviceKey {
        guard SecureEnclave.isAvailable else { throw ProtocolError.malformed("This phone has no Secure Enclave, so it cannot hold an approval key.") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryCurrentSet], &error) else {
            throw error.map { $0.takeRetainedValue() as Error } ?? ProtocolError.malformed("Could not set up the key's access control.")
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try keychainWrite(key.dataRepresentation)
        // canEvaluatePolicy fills evaluatedPolicyDomainState without a prompt.
        let context = LAContext()
        var laError: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &laError)
        if let state = context.evaluatedPolicyDomainState {
            UserDefaults.standard.set(Digest.sha256B64url(state), forKey: domainStateKey)
        } else {
            UserDefaults.standard.removeObject(forKey: domainStateKey)
        }
        return DeviceKey(dataRepresentation: key.dataRepresentation, publicKey: key.publicKey)
    }

    static func delete() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: domainStateKey)
    }

    /// A fresh biometric prompt, then one signature (raw r||s).
    func sign(_ data: Data, reason: String) async throws -> Data {
        let context = LAContext()
        _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        return try signAfterUnlock(data, context: context)
    }

    /// A phone-signed envelope over the canonical bytes of `message`, after a
    /// fresh biometric prompt: responses, enrollments and revocations.
    func signEnvelope(_ message: JSONValue, reason: String) async throws -> Envelope {
        let bytes = JCS.data(message)
        let signature = try await sign(bytes, reason: reason)
        return Envelope(alg: "ES256", kid: deviceId, payload: Base64URL.encode(bytes), sig: Base64URL.encode(signature))
    }

    /// Signs API requests with a context unlocked once per session. If the
    /// cached context no longer works, unlock once more before judging the key.
    func signForSession(_ data: Data) async throws -> Data {
        if let context = sessionContext, let signed = try? signature(data, context: context) {
            unusable = false
            return signed
        }
        endSession()
        let context = try await unlockSession()
        do {
            return try signAfterUnlock(data, context: context)
        } catch {
            endSession()
            throw error
        }
    }

    /// A signature with the session context the app already unlocked, or nil.
    /// Never prompts: for background work that must not ask for Face ID
    /// (cases stage 4 presence pings, ruling T19-presence).
    func signIfUnlocked(_ data: Data) -> Data? {
        guard let context = sessionContext, let signed = try? signature(data, context: context) else { return nil }
        unusable = false
        return signed
    }

    /// Signs with a context that just passed biometrics. On failure, the key
    /// is declared invalid (ProtocolError.keyInvalidated, and the app deletes
    /// it) only when that is confirmed: the Keychain no longer has it, or the
    /// enrolled biometrics changed since it was made. Anything else leaves
    /// the key in place and marks it unusable.
    private func signAfterUnlock(_ data: Data, context: LAContext) throws -> Data {
        do {
            let signed = try signature(data, context: context)
            unusable = false
            return signed
        } catch {
            if confirmedInvalid(after: context) { throw ProtocolError.keyInvalidated }
            unusable = true
            throw DeviceKeyUnusable()
        }
    }

    private func confirmedInvalid(after context: LAContext) -> Bool {
        if case .missing = Self.keychainRead() { return true }
        guard let stored = UserDefaults.standard.string(forKey: Self.domainStateKey),
              let now = context.evaluatedPolicyDomainState else { return false }
        return Digest.sha256B64url(now) != stored
    }

    private func unlockSession() async throws -> LAContext {
        if let unlocking { return try await unlocking.value }
        let task = Task { () throws -> LAContext in
            let context = LAContext()
            _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock King Louie to check for approvals.")
            return context
        }
        unlocking = task
        defer { unlocking = nil }
        let context = try await task.value
        sessionContext = context
        return context
    }

    /// An API session is unlocked (no prompt needed to sign a request).
    var isSessionUnlocked: Bool { sessionContext != nil }

    func endSession() {
        sessionContext?.invalidate()
        sessionContext = nil
    }

    private func signature(_ data: Data, context: LAContext) throws -> Data {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: context)
        return try key.signature(for: data).rawRepresentation
    }

    private enum KeychainResult {
        case found(Data)
        /// errSecItemNotFound: the reference is gone for good.
        case missing
        /// Anything else (a locked device, say): says nothing about the key.
        case unavailable
    }

    private static func keychainRead() -> KeychainResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let data = item as? Data else { return .unavailable }
        return .found(data)
    }

    private static func keychainWrite(_ data: Data) throws {
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ProtocolError.malformed("Could not save the key reference in the Keychain (error \(status)).") }
    }
}
