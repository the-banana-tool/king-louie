package com.example.kinglouie

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.P1363
import com.example.kinglouie.protocol.P256
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The key is confirmed unusable: Android invalidated it (the enrolled
 * biometrics changed) or its Keystore entry is gone. The only case in which
 * the app replaces the key.
 */
class KeyInvalidatedException : Exception(DeviceKey.INVALIDATED_MESSAGE)

/** The biometric prompt ended without a signature (cancelled, locked out, …). The key itself is fine. */
class BiometricException(val code: Int, message: String) : Exception(message)

/**
 * This phone's approval key: Android Keystore P-256, StrongBox when the phone
 * has it (TEE otherwise), usable only through a strong-biometric prompt for
 * each signature, and invalidated when the enrolled biometrics change.
 */
class DeviceKey private constructor(private val publicKey: ECPublicKey) {
    val x: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineX))
    val y: String get() = B64Url.encode(P256.coordinate(publicKey.w.affineY))
    val deviceId: String get() = Identifiers.deviceId(x, y)

    /**
     * A Signature initialised with the key, without a prompt: per-use
     * authentication is asked for only when it signs. Throws
     * KeyInvalidatedException only when Android says the key is gone for good.
     */
    private fun initialised(): Signature {
        val stored: PrivateKey? = try {
            keyStore().getKey(ALIAS, null) as? PrivateKey
        } catch (e: UnrecoverableKeyException) {
            null
        }
        val key = stored ?: throw KeyInvalidatedException()
        return Signature.getInstance("SHA256withECDSA").apply {
            try {
                initSign(key)
            } catch (e: KeyPermanentlyInvalidatedException) {
                throw KeyInvalidatedException()
            }
        }
    }

    /** Throws KeyInvalidatedException when the key is confirmed unusable; any other error is not proof of that. */
    fun checkUsable() {
        initialised()
    }

    /** One biometric prompt, one signature (raw r||s). Must be called on the main thread. */
    suspend fun sign(activity: FragmentActivity, data: ByteArray, title: String, description: String? = null): ByteArray {
        val signature = initialised()
        val authorized = suspendCancellableCoroutine<Signature> { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val s = result.cryptoObject?.signature
                    if (s == null) cont.resumeWithException(BiometricException(-1, "The fingerprint prompt returned no signature."))
                    else cont.resume(s)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    cont.resumeWithException(BiometricException(errorCode, errString.toString()))
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .apply { if (!description.isNullOrEmpty()) setDescription(description) }
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
            cont.invokeOnCancellation { executor.execute { prompt.cancelAuthentication() } }
        }
        authorized.update(data)
        return P1363.fromDer(authorized.sign())
    }

    companion object {
        const val ALIAS = "kl.device-key"
        const val INVALIDATED_MESSAGE = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

        private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        fun load(): DeviceKey? {
            val cert = keyStore().getCertificate(ALIAS) ?: return null
            return DeviceKey(cert.publicKey as ECPublicKey)
        }

        /** Made at the first real pairing (never in demo mode). */
        fun create(): DeviceKey {
            fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .setIsStrongBoxBacked(strongBox)
                .build()
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val pair = try {
                generator.initialize(spec(true))
                generator.generateKeyPair()
            } catch (e: StrongBoxUnavailableException) {
                generator.initialize(spec(false))
                generator.generateKeyPair()
            }
            return DeviceKey(pair.public as ECPublicKey)
        }

        fun delete() {
            keyStore().deleteEntry(ALIAS)
        }
    }
}
