package com.example.kinglouie

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.P1363
import com.example.kinglouie.protocol.P256
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** This phone has no read key (enrolled before it, or it was deleted): the §8.7 set-up makes one. */
class ReadKeyMissingException : Exception("This phone has no read key yet.")

/**
 * The read key would not sign this time: the phone is locked (the Keystore
 * refuses it then, by design) or the Keystore did not answer. Not proof the
 * key is gone; nothing deletes it because of this.
 */
class ReadKeyUnavailableException : Exception("Unlock this phone to check for requests.")

/**
 * The read key (android-slim §8.1): a second Android Keystore P-256 key,
 * StrongBox when the phone has it, that signs without a prompt and only while
 * the phone is unlocked. It signs read-only relay requests (§8.4), presence
 * and `kl.lease.watch` (§8.5), never a decision. It has no device id of its
 * own: everything it signs names the device it belongs to.
 */
class ReadKey private constructor(private val publicKey: ECPublicKey) {
    val x: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineX))
    val y: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineY))

    /** The public half as a JWK (`kty`, `crv`, `x`, `y`), the `read_key` of an enrollment or statement. */
    val jwk: JsonObject get() = Messages.jwk(x, y)

    /** 'r-abcd efgh ijkl mnop', for people to compare. */
    val fingerprint: String get() = Messages.readKeyFingerprint(x, y)

    /**
     * One signature (raw r||s), no prompt. Throws ReadKeyMissingException
     * when the entry is gone, ReadKeyUnavailableException when the Keystore
     * refuses (a locked phone) or does not answer.
     */
    fun sign(data: ByteArray): ByteArray {
        val stored = try {
            keyStore().getKey(ALIAS, null)
        } catch (e: GeneralSecurityException) {
            throw ReadKeyUnavailableException()
        } catch (e: IOException) {
            throw ReadKeyUnavailableException()
        }
        val key = stored as? PrivateKey ?: throw ReadKeyMissingException()
        return try {
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(key)
            signature.update(data)
            P1363.fromDer(signature.sign())
        } catch (e: GeneralSecurityException) {
            // A locked phone: UserNotAuthenticatedException or a Keystore error, per Android version.
            throw ReadKeyUnavailableException()
        } catch (e: ProviderException) {
            throw ReadKeyUnavailableException()
        }
    }

    companion object {
        const val ALIAS = "kl.read-key"

        private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        /** The key, or null (none, or the Keystore did not answer). */
        fun load(): ReadKey? {
            val cert = keyStore().getCertificate(ALIAS) ?: return null
            return ReadKey(cert.publicKey as ECPublicKey)
        }

        /**
         * A new read key, replacing any under the alias. Made by
         * DeviceKey.create, and by the §8.7 set-up for a phone enrolled
         * before the read key.
         */
        fun create(): ReadKey {
            fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .setUnlockedDeviceRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
                .setIsStrongBoxBacked(strongBox)
                .build()
            keyStore().deleteEntry(ALIAS)
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val pair = try {
                generator.initialize(spec(true))
                generator.generateKeyPair()
            } catch (e: StrongBoxUnavailableException) {
                generator.initialize(spec(false))
                generator.generateKeyPair()
            }
            return ReadKey(pair.public as ECPublicKey)
        }

        fun delete() {
            keyStore().deleteEntry(ALIAS)
        }
    }
}
