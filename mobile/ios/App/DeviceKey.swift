import CryptoKit
import Foundation
import KLProtocol
import LocalAuthentication
import Security

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
    static let invalidatedMessage = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

    private let dataRepresentation: Data
    let publicKey: P256.Signing.PublicKey
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
        guard let data = keychainRead(), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) else { return nil }
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
        return DeviceKey(dataRepresentation: key.dataRepresentation, publicKey: key.publicKey)
    }

    static func delete() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }

    /// A fresh biometric prompt, then one signature (raw r||s). A key that
    /// refuses to sign right after a successful prompt was invalidated by a
    /// change to the enrolled biometrics.
    func sign(_ data: Data, reason: String) async throws -> Data {
        let context = LAContext()
        _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        do {
            return try signature(data, context: context)
        } catch {
            throw ProtocolError.keyInvalidated
        }
    }

    /// Signs API requests with a context unlocked once per session. If the
    /// cached context no longer works, unlock once more before concluding
    /// the key itself is gone.
    func signForSession(_ data: Data) async throws -> Data {
        if let context = sessionContext, let signed = try? signature(data, context: context) {
            return signed
        }
        endSession()
        let context = try await unlockSession()
        do {
            return try signature(data, context: context)
        } catch {
            endSession()
            throw ProtocolError.keyInvalidated
        }
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

    func endSession() {
        sessionContext?.invalidate()
        sessionContext = nil
    }

    private func signature(_ data: Data, context: LAContext) throws -> Data {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: context)
        return try key.signature(for: data).rawRepresentation
    }

    private static func keychainRead() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
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
