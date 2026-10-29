package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.security.SecureRandom

/**
 * The messages a phone builds (docs/protocol/approval-v1.md §3). Every one is
 * strings, the integer `v`, and nested objects. Each builder checks its result
 * against the rules a node applies (`validate`) and throws ProtocolException
 * instead of returning something a node would refuse as `malformed`.
 */
object Messages {
    private val random = SecureRandom()

    fun randomNonce(): String = ByteArray(32).also { random.nextBytes(it) }.let { B64Url.encode(it) }

    /** A P-256 public key as a JWK: `{ kty, crv, x, y }`, the coordinates base64url. Not checked here; its users check it. */
    fun jwk(x: String, y: String): JsonObject =
        JsonObject(mapOf("kty" to jsonString("EC"), "crv" to jsonString("P-256"), "x" to jsonString(x), "y" to jsonString(y)))

    /**
     * The `device` object of an enrollment. `name` is 1–64 UTF-16 units. With
     * `readKey` (android-slim §8.2) it has a fifth member, `read_key`: a P-256
     * JWK on the curve whose point is not the device key's. The device id
     * still derives from the device key (`x`, `y`) alone.
     */
    fun device(deviceId: String, name: String, platform: String, x: String, y: String, readKey: JsonObject? = null): JsonObject {
        val fields = linkedMapOf<String, JsonElement>(
            "device_id" to jsonString(deviceId),
            "name" to jsonString(name),
            "platform" to jsonString(platform),
            "public_key" to jwk(x, y)
        )
        if (readKey != null) fields["read_key"] = readKey
        val device = JsonObject(fields)
        if (!Rules.isDevice(device)) throw ProtocolException("not a valid device (name is 1–64 UTF-16 units; a read key is a P-256 key other than the device key)")
        return device
    }

    /**
     * kl.device.read_key (android-slim §8.7): the device key's statement of
     * its read key, for a phone enrolled before the read key. Sealed with the
     * device key (`kid` = `deviceId`, ES256). `expiresAt` is after
     * `createdAt` by at most 7 days.
     */
    fun readKeyStatement(deviceId: String, readKey: JsonObject, createdAt: String, expiresAt: String, nonce: String): JsonObject = checked(
        "kl.device.read_key",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.device.read_key"),
                "device_id" to jsonString(deviceId),
                "read_key" to readKey,
                "created_at" to jsonString(createdAt),
                "expires_at" to jsonString(expiresAt),
                "nonce" to jsonString(nonce)
            )
        )
    )

    /**
     * What people compare for a read key (android-slim §8.1): `r-` and the
     * device id's rule (the first 16 base32 characters of SHA-256 over
     * 0x04 || x || y) in groups of four, 'r-abcd efgh ijkl mnop'. Throws for
     * anything that is not a point on P-256. `readKeyFingerprint` in
     * src/approvals/messages.js.
     */
    fun readKeyFingerprint(x: String, y: String): String {
        Identifiers.deviceId(x, y) // checks the coordinates and the curve
        val id = Identifiers.deviceId(byteArrayOf(0x04) + B64Url.decode(x) + B64Url.decode(y), "r-")
        return "r-" + Identifiers.fingerprintGroups(id)
    }

    fun readKeyFingerprint(jwk: JsonElement): String {
        if (!Rules.isDeviceJwk(jwk)) throw ProtocolException("not a P-256 JWK")
        return readKeyFingerprint(jwk["x"].str()!!, jwk["y"].str()!!)
    }

    /** kl.approval.response for a node-signed request message. */
    fun response(request: JsonElement, decision: String, deviceId: String, signedAt: String): JsonObject {
        fun field(k: String) = request[k].str() ?: throw ProtocolException("not a request: $k")
        return checked(
            "kl.approval.response",
            JsonObject(
                mapOf(
                    "v" to jsonNumber("1"),
                    "type" to jsonString("kl.approval.response"),
                    "request_id" to jsonString(field("request_id")),
                    "node_id" to jsonString(field("node_id")),
                    "action_hash" to jsonString(field("action_hash")),
                    "nonce" to jsonString(field("nonce")),
                    "decision" to jsonString(decision),
                    "expires_at" to jsonString(field("expires_at")),
                    "device_id" to jsonString(deviceId),
                    "signed_at" to jsonString(signedAt)
                )
            )
        )
    }

    /** Self-signed console enrollment with code_mac = HMAC-SHA256(code bytes, JCS(message without code_mac)). */
    fun consoleEnroll(device: JsonElement, codeId: String, code: String, createdAt: String, expiresAt: String, nonce: String): JsonObject {
        val fields = linkedMapOf<String, JsonElement>(
            "v" to jsonNumber("1"),
            "type" to jsonString("kl.device.enroll"),
            "device" to device,
            "enrolled_by" to JsonNull,
            "created_at" to jsonString(createdAt),
            "expires_at" to jsonString(expiresAt),
            "nonce" to jsonString(nonce),
            "code_id" to jsonString(codeId)
        )
        fields["code_mac"] = jsonString(Digest.hmacB64url(code, Jcs.bytes(JsonObject(fields))))
        return checked("kl.device.enroll", JsonObject(fields))
    }

    /** Enrollment of another phone by this one (the invite flow). */
    fun signedEnroll(device: JsonElement, enrolledBy: String, createdAt: String, expiresAt: String, nonce: String): JsonObject = checked(
        "kl.device.enroll",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.device.enroll"),
                "device" to device,
                "enrolled_by" to jsonString(enrolledBy),
                "created_at" to jsonString(createdAt),
                "expires_at" to jsonString(expiresAt),
                "nonce" to jsonString(nonce)
            )
        )
    )

    /** `reason` is at most 200 code points; a phone never revokes itself (kid = revoked_by ≠ device_id). */
    fun revoke(deviceId: String, revokedBy: String, reason: String, createdAt: String, expiresAt: String, nonce: String): JsonObject {
        if (deviceId == revokedBy) throw ProtocolException("a device cannot revoke itself")
        return checked(
            "kl.device.revoke",
            JsonObject(
                mapOf(
                    "v" to jsonNumber("1"),
                    "type" to jsonString("kl.device.revoke"),
                    "device_id" to jsonString(deviceId),
                    "revoked_by" to jsonString(revokedBy),
                    "reason" to jsonString(reason),
                    "created_at" to jsonString(createdAt),
                    "expires_at" to jsonString(expiresAt),
                    "nonce" to jsonString(nonce)
                )
            )
        )
    }

    fun inviteMac(secret: String, device: JsonElement): String = Digest.hmacB64url(secret, Jcs.bytes(device))

    /**
     * S for X-KL-Signature: prefix + "\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body)),
     * the prefix "KL-PHONE-V1" for the device key and "KL-PHONE-READ-V1" for the read key (android-slim §8.3;
     * a read-signed request also sends `X-KL-Key: read`, [PhoneKey.header]).
     */
    fun phoneAuthString(method: String, pathWithQuery: String, timestamp: String, body: ByteArray, key: PhoneKey = PhoneKey.DEVICE): String =
        listOf(key.prefix, method.uppercase(), pathWithQuery, timestamp, Digest.sha256B64url(body)).joinToString("\n")

    /** The string the read key signs: [phoneAuthString] with [PhoneKey.READ]. */
    fun phoneReadAuthString(method: String, pathWithQuery: String, timestamp: String, body: ByteArray): String =
        phoneAuthString(method, pathWithQuery, timestamp, body, PhoneKey.READ)

    fun encodeQr(obj: JsonElement): String = "kl1:" + B64Url.encode(Jcs.bytes(obj))

    fun decodeQr(text: String): JsonObject {
        if (!text.startsWith("kl1:")) throw ProtocolException("not a kl1: code")
        val value = try {
            JsonText.parse(B64Url.decode(text.removePrefix("kl1:")))
        } catch (e: ProtocolException) {
            throw ProtocolException("not a kl1: code (${e.message})")
        }
        if (value !is JsonObject || value["t"].str() == null) throw ProtocolException("QR payload has no type")
        return value
    }

    /**
     * null when `message` is a well-formed `type`, else the reason a node gives
     * (`malformed` or `unsupported_version`); `validateMessage` in
     * src/approvals/messages.js. A type without rules here is `malformed`:
     * there is no generic fallback.
     */
    fun validate(type: String, message: JsonElement): String? {
        val m = message.obj() ?: return "malformed"
        val v = m["v"]
        if (m["type"].str() != type || v == null || !Rules.isInteger(v)) return "malformed"
        if (!Rules.isOne(v)) return "unsupported_version"
        val rule = Rules.byType[type] ?: return "malformed"
        return if (rule(m)) null else "malformed"
    }

    private fun checked(type: String, message: JsonObject): JsonObject {
        val reason = validate(type, message)
        if (reason != null) throw ProtocolException("not a valid $type: $reason")
        return message
    }
}

/**
 * Which of the phone's two keys signs a phone API request (android-slim §8.3):
 * the device key (biometric, the one that decides) or the read key (no prompt,
 * signs only while the phone is unlocked). `header` is the `X-KL-Key` value;
 * `prefix` the first line of the signed string. `PHONE_AUTH_PREFIXES` in
 * src/approvals/messages.js.
 */
enum class PhoneKey(val header: String, val prefix: String) {
    DEVICE("device", "KL-PHONE-V1"),
    READ("read", "KL-PHONE-READ-V1")
}

/**
 * What the app shows for the relay's answer to `POST /v1/approvals/{id}/response`,
 * `{ delivered, accepted, reason }` (approval-v1 §4, §7). Only `accepted: true`
 * with `delivered: true` is approved; `accepted: null` means the relay forwarded
 * it to a local requester and does not know the verdict, and is never approval.
 */
sealed class ResponseOutcome {
    /** Whether the node approved: only for [Accepted]. */
    open val approved: Boolean get() = false

    /** The node accepted the response. */
    object Accepted : ResponseOutcome() {
        override val approved: Boolean get() = true
        override fun toString() = "Accepted"
    }

    /** The node judged the response and refused it ("refused: <reason>"). */
    data class Refused(val reason: String?) : ResponseOutcome()

    /** Forwarded to a local requester on the node; the verdict comes later ("sent to <node>"). */
    object Forwarded : ResponseOutcome() {
        override fun toString() = "Forwarded"
    }

    /** Nothing on the node saw the response ("not delivered"). */
    object NotDelivered : ResponseOutcome() {
        override fun toString() = "NotDelivered"
    }

    companion object {
        fun from(reply: JsonElement): ResponseOutcome {
            val delivered = reply["delivered"].bool() == true
            val accepted = reply["accepted"]
            return when {
                delivered && accepted.bool() == true -> Accepted
                delivered && accepted.bool() == false -> Refused(reply["reason"].str())
                delivered && accepted is JsonNull -> Forwarded
                else -> NotDelivered
            }
        }
    }
}

/** The node's message validators (src/approvals/messages.js), for the types a phone reads or writes. */
internal object Rules {
    val byType: Map<String, (JsonObject) -> Boolean> = mapOf(
        "kl.approval.request" to ::request,
        "kl.approval.response" to ::response,
        "kl.approval.status" to ::status,
        "kl.device.enroll" to ::enroll,
        "kl.device.revoke" to ::revoke,
        "kl.device.read_key" to ::readKey,
        "kl.audit.slice" to ::auditSlice
    )

    const val SUMMARY_MAX = 300
    const val NODE_NAME_MAX = 64
    const val ORIGIN_STRING_MAX = 200
    const val REVOKE_REASON_MAX = 200

    /** The node's REASON_MAX. */
    const val STATUS_REASON_MAX = 300
    val STATUS_STATES = listOf("approved", "denied", "expired", "withdrawn", "refused")
    const val ENROLL_MAX_MS = 10L * 60 * 1000
    const val REVOKE_MAX_MS = 7L * 24 * 60 * 60 * 1000
    const val READ_KEY_MAX_MS = 7L * 24 * 60 * 60 * 1000
    val PLATFORMS = listOf("ios", "android", "demo")

    // shapes

    fun hasExactKeys(o: JsonObject, keys: List<String>): Boolean = o.size == keys.size && o.keys == keys.toSet()

    fun isString(v: JsonElement?) = v.str() != null
    fun isNullOrString(v: JsonElement?) = v is JsonNull || v.str() != null
    fun isObject(v: JsonElement?) = v is JsonObject
    fun isOneOf(v: JsonElement?, values: List<String>) = v.str()?.let { it in values } ?: false

    /** A string of at most `max` code points (not UTF-16 units). */
    fun withinLength(v: JsonElement?, max: Int): Boolean {
        val s = v.str() ?: return false
        return s.codePointCount(0, s.length) <= max
    }

    /** Number.isInteger over the received number. */
    fun isInteger(v: JsonElement): Boolean {
        if (!v.isNumber()) return false
        val d = (v as kotlinx.serialization.json.JsonPrimitive).content.toDoubleOrNull() ?: return false
        return d.isFinite() && Math.floor(d) == d
    }

    /** `v === 1` over the received number. */
    fun isOne(v: JsonElement): Boolean = v.isNumber() && (v as kotlinx.serialization.json.JsonPrimitive).content.toDoubleOrNull() == 1.0

    fun isTimestamp(v: JsonElement?) = v.str()?.let { Timestamps.isValid(it) } ?: false

    // ids and tokens, as ASCII patterns

    private fun isToken(v: JsonElement?, length: Int): Boolean {
        val s = v.str() ?: return false
        return s.length == length && s.all { B64Url.isAlphabet(it) }
    }

    fun isNonce(v: JsonElement?) = isToken(v, 43)
    fun isHash(v: JsonElement?) = isToken(v, 43)
    fun isCodeId(v: JsonElement?) = isToken(v, 22)

    private fun isBase32Id(v: JsonElement?, prefix: String): Boolean {
        val s = v.str() ?: return false
        return s.length == prefix.length + 16 && s.startsWith(prefix) && s.substring(prefix.length).all { it in 'a'..'z' || it in '2'..'7' }
    }

    fun isDeviceId(v: JsonElement?) = isBase32Id(v, "d-")
    fun isNodeId(v: JsonElement?) = isBase32Id(v, "kl-")

    /** Lowercase UUID v4: 8-4-4-4-12 hex, version 4, variant 8/9/a/b. */
    fun isUuidV4(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        if (s.length != 36) return false
        for ((k, c) in s.withIndex()) {
            if (k == 8 || k == 13 || k == 18 || k == 23) {
                if (c != '-') return false
            } else if (c !in '0'..'9' && c !in 'a'..'f') {
                return false
            }
        }
        return s[14] == '4' && s[19] in "89ab"
    }

    // device keys

    fun isDeviceJwk(v: JsonElement?): Boolean {
        val jwk = v.obj() ?: return false
        if (!hasExactKeys(jwk, listOf("crv", "kty", "x", "y")) || jwk["kty"].str() != "EC" || jwk["crv"].str() != "P-256") return false
        val x = jwk["x"].str() ?: return false
        val y = jwk["y"].str() ?: return false
        return try {
            Identifiers.deviceId(x, y)
            true
        } catch (e: ProtocolException) {
            false
        }
    }

    private val DEVICE_KEYS = listOf("device_id", "name", "platform", "public_key")

    /** The four keys of today, or exactly those and `read_key`: a P-256 JWK whose point is not `public_key`'s (android-slim §8.2). */
    fun isDevice(v: JsonElement?): Boolean {
        val d = v.obj() ?: return false
        val withReadKey = d.containsKey("read_key")
        if (!hasExactKeys(d, if (withReadKey) DEVICE_KEYS + "read_key" else DEVICE_KEYS)) return false
        val name = d["name"].str() ?: return false
        if (name.length !in 1..64) return false
        if (!isOneOf(d["platform"], PLATFORMS) || !isDeviceJwk(d["public_key"]) || !isDeviceId(d["device_id"])) return false
        if (withReadKey && (!isDeviceJwk(d["read_key"]) || samePoint(d["read_key"], d["public_key"]))) return false
        return Identifiers.deviceId(d["public_key"]["x"].str()!!, d["public_key"]["y"].str()!!) == d["device_id"].str()
    }

    /** Two JWKs for one point; the node compares the coordinate strings (`samePoint`). */
    private fun samePoint(a: JsonElement?, b: JsonElement?): Boolean = a["x"].str() == b["x"].str() && a["y"].str() == b["y"].str()

    /** expires_at − created_at in (0, max] milliseconds. */
    private fun spanWithin(m: JsonObject, max: Long): Boolean {
        val created = m["created_at"].str()?.let { Timestamps.epochMillis(it) } ?: return false
        val expires = m["expires_at"].str()?.let { Timestamps.epochMillis(it) } ?: return false
        val span = expires - created
        return span > 0 && span <= max
    }

    // per type

    private fun action(v: JsonElement?): Boolean {
        val a = v.obj() ?: return false
        if (!withinLength(a["summary"], SUMMARY_MAX) || !isString(a["name"])) return false
        return when (a["kind"].str()) {
            "tool" -> hasExactKeys(a, listOf("kind", "name", "params", "cwd", "summary")) && isObject(a["params"]) && isNullOrString(a["cwd"])
            "runbook" -> hasExactKeys(a, listOf("kind", "name", "params", "steps", "cwd", "summary")) && isObject(a["params"]) &&
                a["steps"].arr() != null && isNullOrString(a["cwd"])
            "envelope" -> {
                val p = a["params"].obj()
                hasExactKeys(a, listOf("kind", "name", "params", "summary")) && p != null &&
                    hasExactKeys(p, listOf("case_id", "envelope_hash")) && isString(p["case_id"]) && isString(p["envelope_hash"])
            }
            else -> false
        }
    }

    private fun origin(v: JsonElement?): Boolean {
        val o = v.obj() ?: return false
        val client = o["client"].str() ?: return false
        val keys = if (client == "desktop") listOf("client", "session", "job_id", "deviceId") else listOf("client", "session", "job_id")
        return hasExactKeys(o, keys) && o.values.all { it is JsonNull || withinLength(it, ORIGIN_STRING_MAX) }
    }

    private fun request(m: JsonObject): Boolean =
        hasExactKeys(m, listOf("v", "type", "request_id", "node_id", "node_name", "action", "action_hash", "origin", "created_at", "expires_at", "nonce")) &&
            isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && withinLength(m["node_name"], NODE_NAME_MAX) && action(m["action"]) &&
            isHash(m["action_hash"]) && origin(m["origin"]) && isTimestamp(m["created_at"]) && isTimestamp(m["expires_at"]) && isNonce(m["nonce"])

    private fun response(m: JsonObject): Boolean =
        hasExactKeys(m, listOf("v", "type", "request_id", "node_id", "action_hash", "nonce", "decision", "expires_at", "device_id", "signed_at")) &&
            isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && isHash(m["action_hash"]) && isNonce(m["nonce"]) &&
            isOneOf(m["decision"], listOf("approve", "deny")) && isTimestamp(m["expires_at"]) && isDeviceId(m["device_id"]) && isTimestamp(m["signed_at"])

    /** kl.approval.status (node-signed): `device_id` null or a device id, `reason` null or at most 300 code points. */
    private fun status(m: JsonObject): Boolean =
        hasExactKeys(m, listOf("v", "type", "request_id", "node_id", "state", "device_id", "reason", "at")) &&
            isUuidV4(m["request_id"]) && isNodeId(m["node_id"]) && isOneOf(m["state"], STATUS_STATES) &&
            (m["device_id"] is JsonNull || isDeviceId(m["device_id"])) &&
            (m["reason"] is JsonNull || withinLength(m["reason"], STATUS_REASON_MAX)) &&
            isTimestamp(m["at"])

    private fun enroll(m: JsonObject): Boolean {
        val base = listOf("v", "type", "device", "enrolled_by", "created_at", "expires_at", "nonce")
        val console = m["enrolled_by"] is JsonNull
        if (!hasExactKeys(m, if (console) base + listOf("code_id", "code_mac") else base)) return false
        if (!console && !isDeviceId(m["enrolled_by"])) return false
        if (console && !(isCodeId(m["code_id"]) && isHash(m["code_mac"]))) return false
        if (!isDevice(m["device"]) || !isTimestamp(m["created_at"]) || !isTimestamp(m["expires_at"]) || !isNonce(m["nonce"])) return false
        return spanWithin(m, ENROLL_MAX_MS)
    }

    private fun revoke(m: JsonObject): Boolean {
        if (!hasExactKeys(m, listOf("v", "type", "device_id", "revoked_by", "reason", "created_at", "expires_at", "nonce"))) return false
        if (!isDeviceId(m["device_id"]) || !isDeviceId(m["revoked_by"]) || !withinLength(m["reason"], REVOKE_REASON_MAX)) return false
        if (!isTimestamp(m["created_at"]) || !isTimestamp(m["expires_at"]) || !isNonce(m["nonce"])) return false
        return spanWithin(m, REVOKE_MAX_MS)
    }

    /** kl.device.read_key: who signed it is the verifier's check; here, the shape and a window of at most 7 days. */
    private fun readKey(m: JsonObject): Boolean {
        if (!hasExactKeys(m, listOf("v", "type", "device_id", "read_key", "created_at", "expires_at", "nonce"))) return false
        if (!isDeviceId(m["device_id"]) || !isDeviceJwk(m["read_key"])) return false
        if (!isTimestamp(m["created_at"]) || !isTimestamp(m["expires_at"]) || !isNonce(m["nonce"])) return false
        return spanWithin(m, READ_KEY_MAX_MS)
    }

    private fun auditSlice(m: JsonObject): Boolean {
        if (!hasExactKeys(m, listOf("v", "type", "node_id", "entries", "head", "anchor", "created_at"))) return false
        val head = m["head"].obj() ?: return false
        val anchor = m["anchor"].obj() ?: return false
        return isNodeId(m["node_id"]) && m["entries"].arr() != null &&
            head["seq"]?.let { isInteger(it) } == true && isNullOrString(head["hash"]) &&
            anchor["seq"]?.let { isInteger(it) } == true && isNullOrString(anchor["prev"]) &&
            isTimestamp(m["created_at"])
    }
}
