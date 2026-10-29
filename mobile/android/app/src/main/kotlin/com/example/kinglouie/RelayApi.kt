package com.example.kinglouie

import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Challenge
import com.example.kinglouie.protocol.Digest
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.FrontDoorReply
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.RouteKey.DEVICE
import com.example.kinglouie.RouteKey.ENVELOPE
import com.example.kinglouie.RouteKey.READ
import com.example.kinglouie.protocol.PhoneKey
import com.example.kinglouie.protocol.ProtocolException
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.jsonNumber
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

/** GET /v1/push-token (push spec §7.3): whether the relay holds a token for this phone, and a sender for its platform. */
data class PushTokenState(val registered: Boolean, val sender: Boolean)

/** The relay's leaf certificate does not match the pinned SPKI hash. */
class PinMismatchException : CertificateException("Relay certificate changed — scan a new relay code.")

/** Trusts exactly the relay whose leaf certificate's SPKI hashes to the pin; CAs are ignored. */
class PinningTrustManager(private val pin: String) : X509TrustManager {
    /**
     * The pin of the last certificate this refused (fleet stage 4 §3.3.1).
     * Kept only so a front door's signed re-pin can be checked against it;
     * never trusted on its own.
     */
    @Volatile
    var refusedSpki: String? = null

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw PinMismatchException()
        val actual = "sha256/" + Digest.sha256B64url(leaf.publicKey.encoded)
        if (actual != pin) {
            refusedSpki = actual
            throw PinMismatchException()
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * How a request is signed (android-slim §8.4, `ROUTE_AUTH` in
 * tests/frontdoor-phone-routes.test.js).
 *
 * - READ: a request that only reads, or carries no decision (the lists,
 *   presence, the push token, the views, a watch's transport). The read key
 *   signs it; a phone without one gets `read_key_not_set_up` at once, never a
 *   fingerprint prompt.
 * - ENVELOPE: a request whose body is an envelope the device key signed (the
 *   envelope is the decision: a response, an answer, a lease grant, deny or
 *   revoke, an enrollment, a revocation, a front-door decision, a read-key
 *   statement sent again). The read key signs the request; a phone enrolled
 *   before the read key, until its §8.7 set-up, signs it with the device key,
 *   which the relay accepts on these routes too.
 * - DEVICE: a request that changes something with no envelope, and the first
 *   read-key statement (the relay knows no read key until it has it). The read
 *   key never signs one.
 */
enum class RouteKey { READ, ENVELOPE, DEVICE }

/**
 * The relay's phone API (approval-v1 §7), with the two keys of android-slim
 * §8: `deviceSigner` signs with the device key (a biometric prompt for each
 * signature), `readSigner` with the read key (no prompt; refused while the
 * phone is locked). Each function names its route's [RouteKey]; NONE for the
 * time, code, invite and re-pin routes. Nothing here logs a key, signature or
 * code.
 */
class RelayApi(
    private val base: String,
    pin: String,
    private val deviceId: String?,
    private val deviceSigner: (suspend (ByteArray) -> ByteArray)?,
    private val readSigner: (suspend (ByteArray) -> ByteArray)? = null
) {
    private val trust = PinningTrustManager(pin)
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }

    /** The pin of the certificate the last refusal saw, once. */
    @Synchronized
    fun takeRefusedSpki(): String? = trust.refusedSpki.also { trust.refusedSpki = null }

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
     * Signed as `key` says (RouteKey; NONE for the code, invite, time and
     * re-pin routes). A READ request with no read key throws
     * `read_key_not_set_up` before anything is signed or sent. A 401 clock_skew is answered exactly once: the offset
     * from its `server_time` is kept for this and every later request, and the
     * request is signed again. A second clock_skew is an error. Anything
     * outside 2xx throws RelayException.
     */
    suspend fun request(method: String, pathWithQuery: String, key: RouteKey?, body: JsonElement? = null): Pair<Int, JsonElement?> {
        val (status, json) = exchange(method, pathWithQuery, key, body)
        if (status in 200..299) return status to json
        throw RelayException(status, json["error"].str() ?: "http_$status", json["message"].str() ?: "", json["retry_after"].int())
    }

    /**
     * As `request`, but a status outside 2xx (other than a redirect) comes
     * back with its body (null when it has none this app can parse), for
     * replies read with FrontDoorReply. A transport failure, a refused pin, a
     * redirect or an unreadable 2xx throws.
     */
    suspend fun exchange(method: String, pathWithQuery: String, key: RouteKey?, body: JsonElement? = null, retried: Boolean = false): Pair<Int, JsonElement?> {
        val bytes = body?.let { Jcs.bytes(it) } ?: ByteArray(0)
        val headers = mutableMapOf<String, String>()
        // Only an envelope's request falls back to the device key, on a phone with no read key;
        // a READ request then fails without a prompt, and DEVICE never uses the read key.
        val (signer, used) = when (key) {
            READ -> (readSigner ?: throw RelayException(0, READ_KEY_NOT_SET_UP, READ_KEY_NOT_SET_UP_TEXT)) to PhoneKey.READ
            ENVELOPE -> if (readSigner != null) readSigner to PhoneKey.READ else deviceSigner to PhoneKey.DEVICE
            DEVICE -> deviceSigner to PhoneKey.DEVICE
            null -> null to null
        }
        if (used != null && deviceId != null && signer != null) {
            val timestamp = Timestamps.string(now())
            val s = Messages.phoneAuthString(method, pathWithQuery, timestamp, bytes, used)
            headers["X-KL-Device"] = deviceId
            // A device-key request sends no X-KL-Key, as before the read key, so an older relay reads it as today.
            if (used == PhoneKey.READ) headers["X-KL-Key"] = PhoneKey.READ.header
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
        if (status == 401 && json["error"].str() == "clock_skew" && !retried && learnClock(json["server_time"].str())) {
            return exchange(method, pathWithQuery, key, body, retried = true)
        }
        return status to json
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
        if (!learnClock(request("GET", "/v1/time", NONE).second["server_time"].str())) {
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
            return request("GET", "/v1/approvals?wait=$wait", READ).second.arr() ?: emptyList()
        } finally {
            longPolls.release()
        }
    }

    suspend fun approval(id: String): JsonElement? = request("GET", "/v1/approvals/${segment(id)}", READ).second

    /** `202 { delivered, accepted, reason }`; read it with ResponseOutcome. */
    suspend fun respond(id: String, envelope: Envelope): JsonElement? = request("POST", "/v1/approvals/${segment(id)}/response", ENVELOPE, envelope.json).second

    // Cases stage 4: node-signed kl.question.ask envelopes, and device-signed answers back.
    suspend fun questions(): List<JsonElement> = request("GET", "/v1/questions", READ).second.arr() ?: emptyList()

    /** The node's `{ ok, outcome, ack }` or `{ ok: false, error }`, passed through by the relay. */
    suspend fun answerQuestion(token: String, envelope: Envelope): JsonElement? =
        request("POST", "/v1/questions/${segment(token)}/answer", ENVELOPE, envelope.json).second

    // Fleet stage 5 (§4.7): lease requests, decisions and views. No call here
    // repeats itself; each decision is sent once (R-F5-5).
    /**
     * [nonce] (R-F5-20): 32 random bytes this phone chose for this one
     * request. It is in the query, so under the request signature; each node
     * signs its listing over it (Leases.checkListing). Without one (the fresh
     * status Refresh asks for) no listing comes and none is looked for.
     */
    suspend fun leases(nonce: String? = null): List<JsonElement> =
        request("GET", if (nonce == null) "/v1/leases?wait=0" else "/v1/leases?wait=0&nonce=$nonce", READ).second.arr() ?: emptyList()

    /**
     * `202 { state, reason? }` from the node, passed through by the relay; a
     * watch reply also has `after_seq`. A grant, deny or revoke is an
     * envelope the device key signed (ENVELOPE); a watch is read-only
     * transport (READ), whichever key signed the watch itself.
     */
    suspend fun leaseDecision(action: String, leaseId: String, envelope: Envelope): JsonElement? {
        val route = if (action == "watch") READ else ENVELOPE
        return request("POST", "/v1/leases/${segment(leaseId)}/$action", route, envelope.json).second
    }

    /** Views and statuses after `afterSeq`; `waitS` > 0 holds the request open until something arrives (the relay caps it at 25). */
    suspend fun leaseViews(leaseId: String, afterSeq: Int, waitS: Int): List<JsonElement> =
        request("GET", "/v1/leases/${segment(leaseId)}/views?after_seq=$afterSeq&wait=$waitS", READ).second.arr() ?: emptyList()

    /**
     * Foreground presence (android-slim §9): `{ foreground, at }`, `at` in ms
     * on the relay-corrected clock. The relay forwards it to every node where
     * this phone is active; `{ ok, nodes }`.
     */
    suspend fun presence(foreground: Boolean): JsonElement? =
        request("POST", "/v1/presence", READ, JsonObject(mapOf("foreground" to JsonPrimitive(foreground), "at" to jsonNumber(now().toEpochMilli().toString())))).second

    suspend fun nodes(): List<JsonElement> = request("GET", "/v1/nodes", READ).second.arr() ?: emptyList()
    suspend fun pairingCode(nodeName: String): JsonElement? =
        request("POST", "/v1/pairing-codes", DEVICE, JsonObject(mapOf("node_name" to jsonString(nodeName)))).second
    suspend fun createInvite(): JsonElement? = request("POST", "/v1/devices/invites", DEVICE).second

    /** The claim, or JSON null while nobody has claimed the invite. */
    suspend fun inviteClaim(id: String): JsonElement? = request("GET", "/v1/devices/invites/${segment(id)}", READ).second["claim"]
    suspend fun claimInvite(id: String, device: JsonElement, mac: String) {
        request("POST", "/v1/devices/invites/${segment(id)}/claim", NONE, JsonObject(mapOf("device" to device, "mac" to jsonString(mac))))
    }
    suspend fun enrollDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/enroll", ENVELOPE, envelope.json).second
    suspend fun revokeDevice(envelope: Envelope): JsonElement? = request("POST", "/v1/devices/revoke", ENVELOPE, envelope.json).second

    /**
     * A device-key-signed `kl.device.read_key` statement (android-slim §8.7):
     * `key` DEVICE for the first send (the relay knows no read key until it
     * has this), READ for a re-send to nodes that answered `offline` (an
     * envelope's request, so ENVELOPE). `{ nodes: [{ node_id, state }] }`; a
     * relay from before the read key answers 404.
     */
    suspend fun readKey(statement: Envelope, key: PhoneKey): JsonElement? {
        val route = if (key == PhoneKey.DEVICE) DEVICE else ENVELOPE
        return request("POST", "/v1/devices/read-key", route, statement.json).second
    }
    suspend fun devices(): List<JsonElement> = request("GET", "/v1/devices", READ).second.arr() ?: emptyList()

    /** On the read key: re-sent with no prompt when the token rotates (spec 3 R5). */
    suspend fun pushToken(token: String) {
        request("PUT", "/v1/push-token", READ, JsonObject(mapOf("platform" to jsonString("fcm"), "token" to jsonString(token))))
    }

    /** Reset this phone (push spec §7.3): the relay forgets where this phone's notifications go. 204. */
    suspend fun deletePushToken() {
        request("DELETE", "/v1/push-token", READ)
    }

    /** The gear's Notifications row (push spec §7.3): the relay never echoes the token. */
    suspend fun pushTokenState(): PushTokenState {
        val body = request("GET", "/v1/push-token", READ).second
        return PushTokenState(registered = body["registered"].bool() == true, sender = body["sender"].bool() == true)
    }

    /** `202 { state: 'waiting' }`, or 410 code_closed once the code was used or closed. */
    suspend fun consoleEnroll(codeId: String, envelope: Envelope) {
        request("POST", "/v1/enroll/${segment(codeId)}", NONE, envelope.json)
    }

    /** waiting | done | refused | expired. */
    suspend fun consoleEnrollState(codeId: String): String = request("GET", "/v1/enroll/${segment(codeId)}", NONE).second["state"].str() ?: "waiting"

    // Front door (fleet stage 4, client-grant-v1 §7)

    suspend fun frontDoorInfo(): JsonElement? = request("GET", "/v1/frontdoor", READ).second

    /** Claims the request for this phone; 404 `no_such_request` when the code matches nothing. */
    suspend fun pendingGrant(userCode: String): JsonElement? = request("GET", "/v1/grants/pending?user_code=${segment(userCode)}", DEVICE).second

    /** Decisions, revocations and removals: only FrontDoorReply's exact-state check confirms one, and a refusal's code is data. */
    private suspend fun reply(path: String, envelope: Envelope): FrontDoorReply {
        val (status, body) = exchange("POST", path, ENVELOPE, envelope.json)
        return FrontDoorReply.from(status, body)
    }

    suspend fun grantDecision(grantId: String, envelope: Envelope): FrontDoorReply = reply("/v1/grants/${segment(grantId)}/decision", envelope)
    suspend fun clients(): List<JsonElement> = request("GET", "/v1/clients", READ).second.arr() ?: emptyList()

    /** A fresh challenge for one purpose (`revoke` or `remove`, ruling T2-purpose). */
    suspend fun challenge(purpose: String): Challenge {
        val reply = request("POST", "/v1/challenges", READ, FrontDoor.challengeRequest(purpose)).second
            ?: throw RelayException(0, "malformed", "The front door sent a reply this app refuses as malformed.")
        return Challenge(reply)
    }
    suspend fun revokeClient(grantId: String, envelope: Envelope): FrontDoorReply = reply("/v1/clients/${segment(grantId)}/revoke", envelope)
    suspend fun pendingPairings(): List<JsonElement> = request("GET", "/v1/pairings/pending", READ).second.arr() ?: emptyList()
    suspend fun pairingDecision(pairingId: String, envelope: Envelope): FrontDoorReply = reply("/v1/pairings/${segment(pairingId)}/decision", envelope)
    suspend fun removeNode(nodeId: String, envelope: Envelope): FrontDoorReply = reply("/v1/nodes/${segment(nodeId)}/remove", envelope)
    suspend fun alerts(since: String): List<JsonElement> = request("GET", "/v1/alerts?since=${segment(since)}", READ).second.arr() ?: emptyList()
    suspend fun ackAlert(id: String) {
        request("POST", "/v1/alerts/${segment(id)}/ack", DEVICE)
    }

    /** Unauthenticated: the one request a phone makes after its pin failed. */
    suspend fun repinEnvelope(): JsonElement? = request("GET", "/v1/repin", NONE).second

    companion object {
        private val longPolls = Semaphore(2)

        /** No device signature: the time, code, invite and re-pin routes. */
        val NONE: RouteKey? = null

        /** A READ request on a phone without a read key (P4 of the review): it is set up from the list. */
        const val READ_KEY_NOT_SET_UP = "read_key_not_set_up"
        const val READ_KEY_NOT_SET_UP_TEXT = "This phone's read key is not set up yet. Set it up from the list (two fingerprints, once)."

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
