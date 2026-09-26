package com.example.kinglouie

import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Digest
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.ProtocolException
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/**
 * A relay answer outside 2xx, `{ error, message, retry_after? }`, or one of
 * the app's own codes: `pin_mismatch`, `malformed` (a reply the strict parser
 * refuses), `network`, `redirect`, `poll_busy`.
 */
class RelayException(val status: Int, val code: String, message: String, val retryAfter: Int? = null) : Exception(message.ifEmpty { code })

/** The relay's leaf certificate does not match the pinned SPKI hash. */
class PinMismatchException : CertificateException("Relay certificate changed — scan a new relay code.")

/** Trusts exactly the relay whose leaf certificate's SPKI hashes to the pin; CAs are ignored. */
class PinningTrustManager(private val pin: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw PinMismatchException()
        val actual = "sha256/" + Digest.sha256B64url(leaf.publicKey.encoded)
        if (actual != pin) throw PinMismatchException()
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * The relay's phone API (approval-v1 §7). `signer` signs S for
 * device-authenticated routes; on this phone each signature is a biometric
 * prompt. Nothing here logs a key, signature or code.
 */
class RelayApi(
    private val base: String,
    pin: String,
    private val deviceId: String?,
    private val signer: (suspend (ByteArray) -> ByteArray)?
) {
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(PinningTrustManager(pin)), null) }

    /** Relay clock minus this phone's, learned from a clock_skew answer or GET /v1/time. */
    private val clockOffsetMs = AtomicLong(0)

    /** The relay's clock as far as this client knows it. */
    fun now(): Instant = Instant.now().plusMillis(clockOffsetMs.get())

    private fun learnClock(serverTime: String?): Boolean {
        val server = serverTime?.let { Timestamps.epochMillis(it) } ?: return false
        clockOffsetMs.set(server - System.currentTimeMillis())
        return true
    }

    /**
     * Device-signed unless `auth` is false (code and invite routes). A 401
     * clock_skew is answered exactly once: the offset from its `server_time`
     * is kept for this and every later request, and the request is signed
     * again. A second clock_skew is an error.
     */
    suspend fun request(method: String, pathWithQuery: String, body: JsonElement? = null, auth: Boolean = true, retried: Boolean = false): Pair<Int, JsonElement?> {
        val bytes = body?.let { Jcs.bytes(it) } ?: ByteArray(0)
        val headers = mutableMapOf<String, String>()
        if (auth && deviceId != null && signer != null) {
            val timestamp = Timestamps.string(now())
            val s = Messages.phoneAuthString(method, pathWithQuery, timestamp, bytes)
            headers["X-KL-Device"] = deviceId
            headers["X-KL-Timestamp"] = timestamp
            headers["X-KL-Signature"] = B64Url.encode(signer.invoke(s.toByteArray(Charsets.UTF_8)))
        }
        val (status, text) = withContext(Dispatchers.IO) { send(method, pathWithQuery, headers, if (body != null) bytes else null) }
        if (status in 200..299) {
            if (text.isEmpty()) return status to null
            return try {
                status to JsonText.parse(text)
            } catch (e: ProtocolException) {
                throw RelayException(status, "malformed", "The relay sent a reply this app refuses as malformed.")
            }
        }
        if (status in 300..399) throw RelayException(status, "redirect", "The relay tried to redirect this app; redirects are refused.")
        val json = if (text.isEmpty()) null else runCatching { JsonText.parse(text) }.getOrNull()
        val code = json["error"].str() ?: "http_$status"
        if (status == 401 && code == "clock_skew" && !retried && learnClock(json["server_time"].str())) {
            return request(method, pathWithQuery, body, auth, retried = true)
        }
        throw RelayException(status, code, json["message"].str() ?: "", json["retry_after"].int())
    }

    private fun send(method: String, pathWithQuery: String, headers: Map<String, String>, body: ByteArray?): Pair<Int, ByteArray> {
        val conn = try {
            URL(base.trimEnd('/') + pathWithQuery).openConnection() as HttpsURLConnection
        } catch (e: Exception) {
            throw RelayException(0, "network", "This phone is not paired with a relay it can reach.")
        }
        try {
            conn.sslSocketFactory = ssl.socketFactory
            // The SPKI pin, not a hostname, is what identifies the relay.
            conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
            conn.instanceFollowRedirects = false
            conn.requestMethod = method
            conn.connectTimeout = 15000
            // A long poll waits up to 25 s on the relay.
            conn.readTimeout = 40000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            return code to (stream?.use { it.readBytes() } ?: ByteArray(0))
        } catch (e: SSLException) {
            if (generateSequence<Throwable>(e) { it.cause }.any { it is PinMismatchException }) {
                throw RelayException(0, "pin_mismatch", "Relay certificate changed — scan a new relay code.")
            }
            throw RelayException(0, "network", "Could not make a secure connection to the relay.")
        } catch (e: IOException) {
            throw RelayException(0, "network", "Could not reach the relay.")
        } finally {
            conn.disconnect()
        }
    }

    /** Asks the relay for its time (unauthenticated) and keeps the offset. */
    suspend fun syncClock(): Instant {
        if (!learnClock(request("GET", "/v1/time", auth = false).second["server_time"].str())) {
            throw RelayException(0, "malformed", "The relay sent a reply this app refuses as malformed.")
        }
        return now()
    }

    /**
     * One long poll. The relay parks at most two per device; this phone
     * never has more than two open, across every client it makes.
     */
    suspend fun approvals(wait: Int): List<JsonElement> {
        if (!longPolls.tryAcquire()) throw RelayException(0, "poll_busy", "A check is already running.")
        try {
            return request("GET", "/v1/approvals?wait=$wait").second.arr() ?: emptyList()
        } finally {
            longPolls.release()
        }
    }

    suspend fun approval(id: String): JsonElement? = request("GET", "/v1/approvals/${segment(id)}").second

    /** `202 { delivered, accepted, reason }`; read it with ResponseOutcome. */
    suspend fun respond(id: String, envelope: Envelope): JsonElement? = request("POST", "/v1/approvals/${segment(id)}/response", envelope.json).second

    // Cases stage 4: node-signed kl.question.ask envelopes, and device-signed answers back.
    // No presence route here: on this phone every device-signed request is a
    // biometric prompt, so it sends no foreground pings (ruling T19-presence).
    suspend fun questions(): List<JsonElement> = request("GET", "/v1/questions").second.arr() ?: emptyList()

    /** The node's `{ ok, outcome, ack }` or `{ ok: false, error }`, passed through by the relay. */
    suspend fun answerQuestion(token: String, envelope: Envelope): JsonElement? =
        request("POST", "/v1/questions/${segment(token)}/answer", envelope.json).second
    suspend fun nodes(): List<JsonElement> = request("GET", "/v1/nodes").second.arr() ?: emptyList()
    suspend fun history(nodeId: String, limit: Int, beforeSeq: Int?): JsonElement? =
        request("GET", "/v1/nodes/${segment(nodeId)}/history?limit=$limit" + (beforeSeq?.let { "&before_seq=$it" } ?: "")).second
    suspend fun pairingCode(nodeName: String): JsonElement? =
        request("POST", "/v1/pairing-codes", JsonObject(mapOf("node_name" to jsonString(nodeName)))).second
    suspend fun createInvite(): JsonElement? = request("POST", "/v1/devices/invites").second

    /** The claim, or JSON null while nobody has claimed the invite. */
    suspend fun inviteClaim(id: String): JsonElement? = request("GET", "/v1/devices/invites/${segment(id)}").second["claim"]
    suspend fun claimInvite(id: String, device: JsonElement, mac: String) {
        request("POST", "/v1/devices/invites/${segment(id)}/claim", JsonObject(mapOf("device" to device, "mac" to jsonString(mac))), auth = false)
    }
    suspend fun enrollDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/enroll", envelope.json).second
    suspend fun revokeDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/revoke", envelope.json).second
    suspend fun devices(): List<JsonElement> = request("GET", "/v1/devices").second.arr() ?: emptyList()
    suspend fun pushToken(token: String) {
        request("PUT", "/v1/push-token", JsonObject(mapOf("platform" to jsonString("fcm"), "token" to jsonString(token))))
    }

    /** `202 { state: 'waiting' }`, or 410 code_closed once the code was used or closed. */
    suspend fun consoleEnroll(codeId: String, envelope: Envelope) {
        request("POST", "/v1/enroll/${segment(codeId)}", envelope.json, auth = false)
    }

    /** waiting | done | refused | expired. */
    suspend fun consoleEnrollState(codeId: String): String = request("GET", "/v1/enroll/${segment(codeId)}", auth = false).second["state"].str() ?: "waiting"

    companion object {
        private val longPolls = Semaphore(2)

        /** One path segment, percent-encoded so an id can never add a segment or a query. */
        fun segment(value: String): String = buildString {
            for (b in value.toByteArray(Charsets.UTF_8)) {
                val v = b.toInt() and 0xff
                val c = v.toChar()
                if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '-' || c == '_') append(c)
                else append('%').append(HEX[v shr 4]).append(HEX[v and 0xf])
            }
        }

        private const val HEX = "0123456789ABCDEF"
    }
}
