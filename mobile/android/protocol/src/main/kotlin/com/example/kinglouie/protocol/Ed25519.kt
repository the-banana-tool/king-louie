package com.example.kinglouie.protocol

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

/**
 * Ed25519 in software, through Bouncy Castle's lightweight API, the same on
 * the JVM and on every Android release. java.security cannot be used for it:
 * on Android 16 the only "Ed25519" there is the Android Keystore's, whose
 * KeyFactory refuses an outside public key ("To generate a key pair in
 * Android Keystore...") and whose generator makes only Keystore keys, so
 * every node signature failed to verify and the demo could not start.
 */
object Ed25519 {
    /** A node signature over `message` by the key whose raw 32 bytes end a pinned SPKI. */
    fun verify(rawPublicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (rawPublicKey.size != 32 || signature.size != 64) return false
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(rawPublicKey, 0))
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    /** A software key pair for the demo's pretend nodes. */
    class KeyPair internal constructor(private val private: Ed25519PrivateKeyParameters) {
        /** DER SPKI: the fixed Ed25519 prefix and the raw public key. */
        val spki: ByteArray = Hex.decode(Identifiers.ED25519_SPKI_PREFIX) + private.generatePublicKey().encoded

        fun sign(message: ByteArray): ByteArray {
            val signer = Ed25519Signer()
            signer.init(true, private)
            signer.update(message, 0, message.size)
            return signer.generateSignature()
        }
    }

    fun generate(random: SecureRandom = SecureRandom()): KeyPair = KeyPair(Ed25519PrivateKeyParameters(random))
}
