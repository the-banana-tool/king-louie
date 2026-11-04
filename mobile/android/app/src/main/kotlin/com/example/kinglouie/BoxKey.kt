package com.example.kinglouie

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.P256
import com.example.kinglouie.protocol.SealKeyUnavailableException
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * The box key will not agree now: the phone is locked (the Keystore refuses it
 * then, by design) or the Keystore did not answer. Not proof the wrap is bad,
 * so a reader says to unlock, never to run `device apply`.
 */
class BoxKeyUnavailableException : SealKeyUnavailableException("The phone is locked.")

/**
 * The box key (sealed phones plan, R-SP-1, R-SP-10): a third Android Keystore
 * P-256 key, StrongBox when the phone has it and it agrees, that opens what a
 * node seals to this phone. No prompt, and only while the phone is unlocked. It
 * signs nothing. A wrap opens to anyone who holds the key, whoever sealed it, so
 * nothing is believed of a sealed message until its node's signature has held.
 */
class BoxKey private constructor(private val publicKey: ECPublicKey) {
    val x: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineX))
    val y: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineY))

    /** The public half as a JWK, the `box_key` of an enrollment or statement. */
    val jwk: JsonObject get() = Messages.jwk(x, y)

    /** 'b-abcd efgh ijkl mnop', for people to compare. */
    val fingerprint: String get() = Messages.boxKeyFingerprint(x, y)

    /**
     * The raw x-coordinate of ECDH with the point (x, y), which the core has
     * checked is on the curve. A locked phone's error varies by Android version,
     * so every Keystore failure here is BoxKeyUnavailableException; create() has
     * already found a StrongBox that will not agree. An entry that is gone throws
     * something else, which the core reads as `open_failed`.
     */
    fun agree(x: String, y: String): ByteArray {
        val peer = P256.publicKey(x, y)
        val stored = try {
            keyStore().getKey(ALIAS, null)
        } catch (e: GeneralSecurityException) {
            throw BoxKeyUnavailableException()
        } catch (e: IOException) {
            throw BoxKeyUnavailableException()
        }
        val key = stored as? PrivateKey ?: throw IllegalStateException("no box key")
        return try {
            agreement(key, peer)
        } catch (e: GeneralSecurityException) {
            throw BoxKeyUnavailableException()
        } catch (e: ProviderException) {
            throw BoxKeyUnavailableException()
        }
    }

    companion object {
        const val ALIAS = "kl.box-key"

        private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        private fun agreement(key: PrivateKey, peer: java.security.PublicKey): ByteArray =
            KeyAgreement.getInstance("ECDH", "AndroidKeyStore").run {
                init(key)
                doPhase(peer, true)
                generateSecret()
            }

        /** The key, or null (none, or the Keystore did not answer). */
        fun load(): BoxKey? {
            val cert = keyStore().getCertificate(ALIAS) ?: return null
            return BoxKey(cert.publicKey as ECPublicKey)
        }

        /** One agreement while the key is made (the phone is in use now), so a key that cannot agree is never kept. */
        private fun firstAgreement(key: PrivateKey) {
            val peer = KeyPairGenerator.getInstance("EC").run {
                initialize(ECGenParameterSpec("secp256r1"))
                generateKeyPair().public
            }
            try {
                agreement(key, peer)
            } catch (e: GeneralSecurityException) {
                throw ProviderException(e)
            }
        }

        private fun generate(strongBox: Boolean): BoxKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setUserAuthenticationRequired(false)
                .setUnlockedDeviceRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
                .setIsStrongBoxBacked(strongBox)
                .build()
            keyStore().deleteEntry(ALIAS)
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(spec)
            val pair = generator.generateKeyPair()
            firstAgreement(pair.private)
            return BoxKey(pair.public as ECPublicKey)
        }

        /**
         * A new box key, replacing any under the alias. Made by DeviceKey.create,
         * and by the statement flow for a phone enrolled before the box key. Some
         * StrongBox chips make the key and then refuse to agree with it: those use
         * the TEE. A throw from here means this Keystore will not hold such a key.
         */
        fun create(): BoxKey = try {
            generate(strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            generate(strongBox = false)
        } catch (e: ProviderException) {
            generate(strongBox = false)
        }

        fun delete() {
            keyStore().deleteEntry(ALIAS)
        }
    }
}
