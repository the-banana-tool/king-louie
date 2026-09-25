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

    /** The `device` object of an enrollment. `name` is 1–64 UTF-16 units. */
    fun device(deviceId: String, name: String, platform: String, x: String, y: String): JsonObject {
        val device = JsonObject(
            mapOf(
                "device_id" to jsonString(deviceId),
                "name" to jsonString(name),
                "platform" to jsonString(platform),
                "public_key" to JsonObject(mapOf("kty" to jsonString("EC"), "crv" to jsonString("P-256"), "x" to jsonString(x), "y" to jsonString(y)))
            )
        )
        if (!Rules.isDevice(device)) throw ProtocolException("not a valid device (name is 1–64 UTF-16 units)")
        return device
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

    /** S for X-KL-Signature: "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body)). */
    fun phoneAuthString(method: String, pathWithQuery: String, timestamp: String, body: ByteArray): String =
        listOf("KL-PHONE-V1", method.uppercase(), pathWithQuery, timestamp, Digest.sha256B64url(body)).joinToString("\n")

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

    fun isDevice(v: JsonElement?): Boolean {
        val d = v.obj() ?: return false
        if (!hasExactKeys(d, listOf("device_id", "name", "platform", "public_key"))) return false
        val name = d["name"].str() ?: return false
        if (name.length !in 1..64) return false
        if (!isOneOf(d["platform"], PLATFORMS) || !isDeviceJwk(d["public_key"]) || !isDeviceId(d["device_id"])) return false
        return Identifiers.deviceId(d["public_key"]["x"].str()!!, d["public_key"]["y"].str()!!) == d["device_id"].str()
    }

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
