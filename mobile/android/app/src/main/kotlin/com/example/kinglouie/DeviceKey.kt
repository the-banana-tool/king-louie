package com.example.kinglouie

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.P1363
import com.example.kinglouie.protocol.P256
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.IOException
import java.security.GeneralSecurityException
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

/**
 * The Keystore could not hand out the key this time (an UnrecoverableKeyException,
 * which Keystore2 also raises for transient failures). Not proof the key is
 * gone: nothing deletes or replaces the key because of it; the owner retries.
 */
class KeyUnavailableException : Exception("This phone's key store did not answer. Try again in a moment.")

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
     * KeyInvalidatedException only when the entry is missing or Android
     * raises KeyPermanentlyInvalidatedException; an UnrecoverableKeyException
     * becomes the retryable KeyUnavailableException.
     */
    private fun initialised(): Signature {
        val stored = try {
            keyStore().getKey(ALIAS, null)
        } catch (e: UnrecoverableKeyException) {
            throw KeyUnavailableException()
        }
        val key = stored as? PrivateKey ?: throw KeyInvalidatedException()
        return Signature.getInstance("SHA256withECDSA").apply {
            try {
                initSign(key)
            } catch (e: KeyPermanentlyInvalidatedException) {
                throw KeyInvalidatedException()
            }
        }
    }

    /** Throws KeyInvalidatedException when the key is confirmed unusable; any other error (KeyUnavailableException included) is not proof of that. */
    fun checkUsable() {
        initialised()
    }

    /**
     * One biometric prompt, one signature (raw r||s). Must be called on the
     * main thread, one prompt at a time (AppModel serialises it): prompts on
     * one activity share its BiometricViewModel, so a second prompt would take
     * over the first one's callback. If the activity is destroyed (including a
     * configuration change, which resets that callback), the prompt ends as
     * ERROR_CANCELED instead of never answering.
     */
    suspend fun sign(activity: FragmentActivity, data: ByteArray, title: String, description: String? = null): ByteArray {
        val signature = initialised()
        val lifecycle = activity.lifecycle
        if (lifecycle.currentState == Lifecycle.State.DESTROYED) {
            throw BiometricException(BiometricPrompt.ERROR_CANCELED, "The app closed before the fingerprint prompt.")
        }
        val authorized = suspendCancellableCoroutine<Signature> { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            var observer: LifecycleEventObserver? = null
            // Every resume goes through here: at most once, and only while the caller still waits.
            fun finish(result: Result<Signature>) {
                observer?.let { lifecycle.removeObserver(it) }
                observer = null
                if (!cont.isActive) return
                result.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }
            val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val s = result.cryptoObject?.signature
                    finish(if (s == null) Result.failure(BiometricException(-1, "The fingerprint prompt returned no signature.")) else Result.success(s))
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    finish(Result.failure(BiometricException(errorCode, errString.toString())))
                }
            })
            observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_DESTROY) {
                    finish(Result.failure(BiometricException(BiometricPrompt.ERROR_CANCELED, "The app closed during the fingerprint prompt.")))
                }
            }.also { lifecycle.addObserver(it) }
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .apply { if (!description.isNullOrEmpty()) setDescription(description) }
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
            cont.invokeOnCancellation {
                executor.execute {
                    observer?.let { lifecycle.removeObserver(it) }
                    observer = null
                    prompt.cancelAuthentication()
                }
            }
        }
        authorized.update(data)
        return P1363.fromDer(authorized.sign())
    }

    companion object {
        const val ALIAS = "kl.device-key"
        const val INVALIDATED_MESSAGE = "This phone's key is no longer usable. Enroll it again from a node console or another phone."

        private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        /**
         * The key, or null. Not proof there is none: on Keystore2 a transient
         * error in getCertificate also comes back as null. See requireAbsent.
         */
        fun load(): DeviceKey? {
            val cert = keyStore().getCertificate(ALIAS) ?: return null
            return DeviceKey(cert.publicKey as ECPublicKey)
        }

        /**
         * Returns only when the Keystore confirms there is no key under the
         * alias (getKey answers null), the one case where create() may run.
         * A key that is there (but did not load), or any Keystore error,
         * throws the retryable KeyUnavailableException, so an enrolled key is
         * never overwritten because of a transient failure.
         */
        fun requireAbsent() {
            val found = try {
                keyStore().getKey(ALIAS, null)
            } catch (e: GeneralSecurityException) {
                // UnrecoverableKeyException, KeyStoreException, …
                throw KeyUnavailableException()
            } catch (e: IOException) {
                throw KeyUnavailableException()
            }
            if (found != null) throw KeyUnavailableException()
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
