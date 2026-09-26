package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.net.URI

/** A scope the owner grants to a client, with an optional machine limit (client-grant-v1 §3.1). */
data class ScopeChoice(val scope: String, val machines: List<String>? = null)

/** The result of checking a `kl.relay.repin` (client-grant-v1 §4.7). Only `ok == true` moves the pin. */
data class RepinCheck(val ok: Boolean, val reason: String?, val newSpki: String?)

/**
 * client-grant-v1 (docs/protocol/client-grant-v1.md): what a phone builds for
 * a front door and what it checks from one. Each builder applies the front
 * door's own rules first and throws ProtocolException instead of returning a
 * message the front door would refuse as `malformed`.
 */
object FrontDoor {
    internal const val USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** Longer typed input is refused outright (§6), as the front door does. */
    internal const val USER_CODE_INPUT_MAX = 64

    /** The challenge purposes (ruling T2-purpose, §4.6): `revoke` for kl.client.revoke, `remove` for kl.node.remove. */
    const val PURPOSE_REVOKE = "revoke"
    const val PURPOSE_REMOVE = "remove"
    private val PURPOSES = listOf(PURPOSE_REVOKE, PURPOSE_REMOVE)

    /** JavaScript's `\s` (what the front door strips), every one a single UTF-16 unit. */
    private fun isJsWhitespace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    private fun isAsciiAlnum(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9'

    /**
     * What the owner typed, as the grant carries it (the front door's
     * normalizeUserCode): at most 64 UTF-16 units; `-` and whitespace dropped;
     * then exactly six ASCII letters and digits (checked before upper-casing,
     * so no look-alike such as `ß` or a dotless i becomes the alphabet);
     * upper case, O→0 and I/L→1; null unless that is six alphabet characters.
     */
    fun normalizeUserCode(text: String): String? {
        if (text.length > USER_CODE_INPUT_MAX) return null
        val compact = text.filter { it != '-' && !isJsWhitespace(it) }
        if (compact.length != 6 || !compact.all(::isAsciiAlnum)) return null
        val s = compact.map { ch ->
            when (val up = if (ch in 'a'..'z') ch - 32 else ch) {
                'O' -> '0'
                'I', 'L' -> '1'
                else -> up
            }
        }.joinToString("")
        return if (s.all { it in USER_CODE_ALPHABET }) s else null
    }

    /** `Q7KM2X` → `Q7K-M2X`, as the browser shows it. */
    fun formatUserCode(code: String): String = code.take(3) + "-" + code.drop(3)

    /** `kl-3v7q2m4k8d1x9c0a` → `kl-3v7q 2m4k 8d1x 9c0a`. */
    fun nodeFingerprint(nodeId: String): String = "kl-" + Identifiers.fingerprintGroups(nodeId)

    /** A node name a grant can limit to (`machines=`); other names can only be granted without a limit (Deviation 18). */
    fun isMachineName(name: String): Boolean = FrontDoorRules.isMachineName(name)

    /** Sorted by scope (UTF-16 order, as the front door compares); each machine list sorted and de-duplicated. */
    fun scopesJson(choices: List<ScopeChoice>): JsonArray = JsonArray(
        choices.sortedWith { a, b -> a.scope.compareTo(b.scope) }.map { c ->
            JsonObject(
                mapOf(
                    "scope" to jsonString(c.scope),
                    "machines" to (c.machines?.let { list -> JsonArray(list.distinct().sorted().map { jsonString(it) }) } ?: JsonNull)
                )
            )
        }
    )

    /** The body of `POST /v1/challenges`: the purpose of the message the challenge will be spent on. */
    fun challengeRequest(purpose: String): JsonObject {
        if (purpose !in PURPOSES) throw ProtocolException("a challenge purpose is revoke or remove")
        return JsonObject(mapOf("purpose" to jsonString(purpose)))
    }

    private fun field(v: JsonElement, key: String): String = v[key].str() ?: throw ProtocolException("missing $key")

    /** kl.client.grant for a pending authorization (the `GET /v1/grants/pending` reply) and the code the owner typed. `deny` carries no scopes. */
    fun clientGrant(frontdoorId: String, pending: JsonElement, userCode: String, scopes: List<ScopeChoice>, decision: String,
                    nonce: String, deviceId: String, signedAt: String): JsonObject {
        val code = normalizeUserCode(userCode) ?: throw ProtocolException("the code is six letters and digits")
        return checked(
            "kl.client.grant",
            JsonObject(
                mapOf(
                    "v" to jsonNumber("1"),
                    "type" to jsonString("kl.client.grant"),
                    "frontdoor_id" to jsonString(frontdoorId),
                    "grant_id" to jsonString(field(pending, "grant_id")),
                    "client_id" to jsonString(field(pending, "client_id")),
                    "client_name" to jsonString(field(pending, "client_name")),
                    "redirect_uri" to jsonString(field(pending, "redirect_uri")),
                    "resource" to jsonString(field(pending, "resource")),
                    "code_challenge" to jsonString(field(pending, "code_challenge")),
                    "user_code" to jsonString(code),
                    "scopes" to if (decision == "deny") JsonArray(emptyList()) else scopesJson(scopes),
                    "decision" to jsonString(decision),
                    "nonce" to jsonString(nonce),
                    "device_id" to jsonString(deviceId),
                    "signed_at" to jsonString(signedAt)
                )
            )
        )
    }

    /** `challenge` comes from `POST /v1/challenges` with purpose `revoke`. */
    fun clientRevoke(frontdoorId: String, grantId: String, challenge: String, deviceId: String, signedAt: String): JsonObject = checked(
        "kl.client.revoke",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.client.revoke"),
                "frontdoor_id" to jsonString(frontdoorId),
                "grant_id" to jsonString(grantId),
                "challenge" to jsonString(challenge),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    )

    /**
     * kl.node.enroll for one pending pairing (a `GET /v1/pairings/pending` entry).
     * `replaces` is signed exactly as given: null or a node id; missing or any
     * other value is refused rather than signed as null.
     */
    fun nodeEnroll(frontdoorId: String, pairing: JsonElement, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject {
        val replaces = pairing["replaces"]
        if (replaces !is JsonNull && replaces.str() == null) throw ProtocolException("replaces is null or a node id")
        return checked(
            "kl.node.enroll",
            JsonObject(
                mapOf(
                    "v" to jsonNumber("1"),
                    "type" to jsonString("kl.node.enroll"),
                    "frontdoor_id" to jsonString(frontdoorId),
                    "pairing_id" to jsonString(field(pairing, "pairing_id")),
                    "node_id" to jsonString(field(pairing, "node_id")),
                    "node_name" to jsonString(field(pairing, "node_name")),
                    "profile" to jsonString(field(pairing, "profile")),
                    "public_key" to jsonString(field(pairing, "public_key")),
                    "tls_fingerprint" to jsonString(field(pairing, "tls_fingerprint")),
                    "replaces" to replaces!!,
                    "decision" to jsonString(decision),
                    "nonce" to jsonString(nonce),
                    "device_id" to jsonString(deviceId),
                    "signed_at" to jsonString(signedAt)
                )
            )
        )
    }

    /** `challenge` comes from `POST /v1/challenges` with purpose `remove`. */
    fun nodeRemove(frontdoorId: String, nodeId: String, challenge: String, deviceId: String, signedAt: String): JsonObject = checked(
        "kl.node.remove",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.node.remove"),
                "frontdoor_id" to jsonString(frontdoorId),
                "node_id" to jsonString(nodeId),
                "challenge" to jsonString(challenge),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    )

    /** null when well formed, else `malformed` or `unsupported_version` (the front door's validateMessage). */
    fun validate(type: String, message: JsonElement): String? {
        val m = message.obj() ?: return "malformed"
        val v = m["v"]
        if (m["type"].str() != type || v == null || !Rules.isInteger(v)) return "malformed"
        if (!Rules.isOne(v)) return "unsupported_version"
        val rule = FrontDoorRules.byType[type] ?: return "malformed"
        return if (rule(m)) null else "malformed"
    }

    private fun checked(type: String, message: JsonObject): JsonObject {
        val reason = validate(type, message)
        if (reason != null) throw ProtocolException("not a valid $type: $reason")
        return message
    }

    /** The pinned key is a DER SPKI Ed25519 key: the 12-byte prefix and 32 key bytes. */
    private fun isEd25519SpkiHex(hex: String): Boolean = try {
        val der = Hex.decode(hex)
        der.size == 44 && Hex.encode(der.copyOfRange(0, 12)) == Identifiers.ED25519_SPKI_PREFIX
    } catch (e: ProtocolException) {
        false
    }

    /**
     * The re-pin rule (client-grant-v1 §4.7, the front door's `verifyRepin`
     * order and reasons): the pinned front-door key parses; the envelope opens
     * canonically and matches its shape; `alg` is Ed25519; `kid` and
     * `frontdoor_id` are the pinned front door; the signature verifies against
     * the pinned key; `new_spki` is the key just received; `old_spki` is the
     * current pin. Any failure leaves the pin unchanged.
     */
    fun verifyRepin(envelopeJson: JsonElement, frontdoorId: String, frontdoorKeyHex: String, receivedSpki: String, currentPin: String): RepinCheck {
        fun fail(reason: String) = RepinCheck(false, reason, null)
        if (!isEd25519SpkiHex(frontdoorKeyHex)) return fail("malformed")
        val envelope: Envelope
        val message: JsonObject
        try {
            envelope = Envelope.fromJson(envelopeJson)
            message = envelope.message()
        } catch (e: ProtocolException) {
            return fail("malformed")
        }
        validate("kl.relay.repin", message)?.let { return fail(it) }
        if (envelope.alg != "Ed25519") return fail("malformed")
        if (envelope.kid != frontdoorId || message["frontdoor_id"].str() != frontdoorId) return fail("wrong_frontdoor")
        if (!envelope.verifyEd25519(frontdoorKeyHex)) return fail("bad_signature")
        val newSpki = message["new_spki"].str() ?: return fail("malformed")
        if (newSpki != receivedSpki) return fail("spki_mismatch")
        if (message["old_spki"].str() != currentPin) return fail("old_pin_mismatch")
        return RepinCheck(true, null, newSpki)
    }
}

/**
 * One `GET /v1/grants/pending` reply (client-grant-v1 §7): exactly its ten
 * fields. Everything in it is the front door's (and the client's) word; the
 * app shows `clientName` as self-declared.
 */
class GrantRequest(val json: JsonElement) {
    val grantId: String
    val clientId: String
    val clientName: String
    val clientHost: String
    val redirectUri: String
    val resource: String
    val requestedScopes: List<String>
    val preselected: List<String>
    val expiresInMs: Int

    init {
        val o = json.obj()
        val requested = o["requested_scopes"].arr()
        val pre = o["preselected"].arr()
        val expires = o["expires_in_ms"].int()
        if (o == null || !Rules.hasExactKeys(o, FIELDS) ||
            !FrontDoorRules.isGrantId(o["grant_id"]) || !FrontDoorRules.isClientId(o["client_id"]) ||
            !Rules.withinLength(o["client_name"], FrontDoorRules.CLIENT_NAME_MAX) || !FrontDoorRules.isUri(o["client_host"]) ||
            !FrontDoorRules.isUri(o["redirect_uri"]) || !FrontDoorRules.isUri(o["resource"]) ||
            !FrontDoorRules.isCodeChallenge(o["code_challenge"]) || requested == null || pre == null || expires == null || expires < 0 ||
            requested.size > FrontDoorRules.MAX_SCOPES || pre.size > FrontDoorRules.MAX_SCOPES
        ) throw ProtocolException("the front door sent a connection request this app cannot read")
        val names = requested.mapNotNull { e -> e.str()?.takeIf { FrontDoorRules.isScopeName(it) } }
        if (names.size != requested.size || names.toSet().size != names.size) throw ProtocolException("unknown or repeated scope names in the request")
        val preNames = pre.mapNotNull { it.str() }
        if (preNames.size != pre.size) throw ProtocolException("the preselected scopes are not names")
        grantId = o["grant_id"].str()!!
        clientId = o["client_id"].str()!!
        clientName = o["client_name"].str()!!
        clientHost = o["client_host"].str()!!
        redirectUri = o["redirect_uri"].str()!!
        resource = o["resource"].str()!!
        requestedScopes = names
        // Only what was requested can be preselected.
        preselected = preNames.filter { it in names }
        expiresInMs = expires
    }

    /** The host the browser returns to (the redirect URI's); the whole URI when it has none this parser can read. */
    val redirectHost: String get() = runCatching { URI(redirectUri).host }.getOrNull() ?: redirectUri

    fun message(frontdoorId: String, userCode: String, scopes: List<ScopeChoice>, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject =
        FrontDoor.clientGrant(frontdoorId, json, userCode, scopes, decision, nonce, deviceId, signedAt)

    private companion object {
        val FIELDS = listOf("grant_id", "client_id", "client_name", "client_host", "redirect_uri", "resource", "code_challenge",
            "requested_scopes", "preselected", "expires_in_ms")
    }
}

/**
 * One `GET /v1/pairings/pending` entry (client-grant-v1 §7): exactly its
 * eight fields. Its id must derive from its key, so the fingerprint shown is
 * the key's.
 */
class PairingRequest(val json: JsonElement) {
    val pairingId: String
    val nodeId: String
    val nodeName: String
    val profile: String
    val replaces: String?
    val expiresInMs: Int

    init {
        val o = json.obj()
        val name = o["node_name"].str()
        val expires = o["expires_in_ms"].int()
        val raw = if (FrontDoorRules.isRawEd25519(o["public_key"])) runCatching { B64Url.decode(o["public_key"].str()!!) }.getOrNull() else null
        val ok = o != null && Rules.hasExactKeys(o, FIELDS) &&
            FrontDoorRules.isPairingId(o["pairing_id"]) && Rules.isNodeId(o["node_id"]) && name != null && FrontDoorRules.isNodeName(name) &&
            Rules.isOneOf(o["profile"], listOf("agent", "runbook")) && FrontDoorRules.isHex64(o["tls_fingerprint"]) &&
            (o["replaces"] is JsonNull || Rules.isNodeId(o["replaces"])) && expires != null && expires >= 0 &&
            raw != null && raw.size == 32 && Identifiers.nodeId(raw) == o["node_id"].str()
        if (!ok) throw ProtocolException("the front door sent a pairing this app cannot verify")
        pairingId = o["pairing_id"].str()!!
        nodeId = o["node_id"].str()!!
        nodeName = name!!
        profile = o["profile"].str()!!
        replaces = o["replaces"].str()
        expiresInMs = expires!!
    }

    val fingerprint: String get() = FrontDoor.nodeFingerprint(nodeId)

    fun message(frontdoorId: String, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject =
        FrontDoor.nodeEnroll(frontdoorId, json, decision, nonce, deviceId, signedAt)

    private companion object {
        val FIELDS = listOf("pairing_id", "node_name", "node_id", "profile", "public_key", "tls_fingerprint", "replaces", "expires_in_ms")
    }
}

/** A `POST /v1/challenges` reply: `{ challenge, expires_in_ms }` exactly. */
class Challenge(json: JsonElement) {
    val challenge: String
    val expiresInMs: Int

    init {
        val o = json.obj()
        val expires = o["expires_in_ms"].int()
        if (o == null || !Rules.hasExactKeys(o, listOf("challenge", "expires_in_ms")) || !Rules.isNonce(o["challenge"]) || expires == null || expires < 0) {
            throw ProtocolException("the front door sent a challenge this app cannot read")
        }
        challenge = o["challenge"].str()!!
        expiresInMs = expires
    }
}

/**
 * The front door's answer to a decision, revoke or remove (`POST
 * /v1/grants/{id}/decision`, `/v1/pairings/{id}/decision`,
 * `/v1/clients/{id}/revoke`, `/v1/nodes/{id}/remove`). Refusal codes are
 * data for the app to word (`replaces_changed`, `key_enrolled_as_other_name`,
 * `save_failed`, and codes a later front door adds); anything that is not
 * code-shaped is dropped, never shown or acted on.
 */
sealed class FrontDoorReply {
    /** A 2xx. `state` is the reply's `state` when it is code-shaped (a 204 has none). */
    data class Done(val state: String?) : FrontDoorReply()

    /** Anything else: the HTTP status, the `error` code, and `retry_after` seconds when given. */
    data class Refused(val status: Int, val code: String?, val retryAfterSeconds: Int?) : FrontDoorReply()

    /** The call went through (for revoke and remove, which answer 204). */
    val succeeded: Boolean get() = this is Done

    /** Only a 2xx whose `state` is exactly `expected` (`approved`, `denied`, `enrolled`) confirms a decision. */
    fun confirms(expected: String): Boolean = this is Done && state != null && state == expected

    /** `save_failed`: the front door asks for the same envelope again. */
    val retryable: Boolean get() = this is Refused && code == "save_failed"

    companion object {
        fun from(status: Int, body: JsonElement?): FrontDoorReply =
            if (status in 200..299) Done(FrontDoorRules.code(body["state"]))
            else Refused(status, FrontDoorRules.code(body["error"]), body["retry_after"].int()?.takeIf { it >= 0 })
    }
}

/** One mirror break: `reason` is the recorded code (known or not), null when it is not code-shaped. */
data class AuditBreak(val seq: Int?, val reason: String?)

/**
 * `GET /v1/nodes/{node_id}/audit-status`: `{ head_seq, anchor, gaps, breaks }`.
 * Break reasons pass through as codes for the app to word (fork,
 * withheld_entries, oversize_entry, ... and any a later front door adds).
 */
class AuditStatus(json: JsonElement) {
    val headSeq: Int
    val anchorSeq: Int?
    val gapCount: Int
    val breaks: List<AuditBreak>

    /** Any recorded break means the node's history can no longer be trusted as whole. */
    val broken: Boolean get() = breaks.isNotEmpty()

    init {
        val o = json.obj()
        val head = o["head_seq"].int()
        val anchor = o["anchor"]
        val gaps = o["gaps"].arr()
        val list = o["breaks"].arr()
        if (o == null || head == null || head < 0 || gaps == null || list == null || gaps.size > MAX_RECORDS || list.size > MAX_RECORDS ||
            !(anchor is JsonNull || anchor.obj()?.let { it["seq"].int() != null } == true)
        ) throw ProtocolException("the front door sent an audit status this app cannot read")
        headSeq = head
        anchorSeq = anchor.obj()?.let { it["seq"].int() }
        gapCount = gaps.size
        breaks = list.map { b ->
            val e = b.obj() ?: throw ProtocolException("an audit break is not an object")
            AuditBreak(e["seq"].int(), FrontDoorRules.code(e["reason"]))
        }
    }

    private companion object {
        const val MAX_RECORDS = 1000
    }
}

/** The front door's validators (src/frontdoor/protocol/messages.js) for the types a phone writes or reads. */
internal object FrontDoorRules {
    val byType: Map<String, (JsonObject) -> Boolean> = mapOf(
        "kl.client.grant" to ::grant,
        "kl.client.revoke" to ::revoke,
        "kl.node.enroll" to ::enroll,
        "kl.node.remove" to ::remove,
        "kl.relay.repin" to ::repin
    )

    const val CLIENT_NAME_MAX = 200
    const val URI_MAX = 2048
    const val CLIENT_ID_MAX = 512
    const val MAX_SCOPES = 32
    const val MAX_MACHINES = 64

    // `matches` is a whole-input match: no anchors, and no "$ before a final newline" surprise.
    private val SCOPE_NAME = Regex("[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}")
    private val MACHINE_NAME = Regex("[a-z0-9][a-z0-9._-]{0,62}")
    private val NODE_NAME = Regex("[A-Za-z0-9._-]{1,64}")
    private val HEX64 = Regex("[0-9a-f]{64}")
    private val B64URL = Regex("[A-Za-z0-9_-]*")
    private val CODE = Regex("[a-z0-9_]{1,64}")

    /** A reply's reason or state code: lower-case ASCII, digits and `_`, at most 64; anything else is null. */
    fun code(v: JsonElement?): String? = v.str()?.takeIf { CODE.matches(it) }

    private fun token(v: JsonElement?, prefix: String, length: Int): Boolean {
        val s = v.str() ?: return false
        return s.length == prefix.length + length && s.startsWith(prefix) && B64URL.matches(s.substring(prefix.length))
    }

    fun isGrantId(v: JsonElement?) = token(v, "gr_", 22)
    fun isPairingId(v: JsonElement?) = token(v, "pr_", 22)
    fun isRawEd25519(v: JsonElement?) = token(v, "", 43)
    fun isSpkiPin(v: JsonElement?) = token(v, "sha256/", 43)
    fun isHex64(v: JsonElement?) = v.str()?.let { HEX64.matches(it) } ?: false
    fun isScopeName(s: String) = SCOPE_NAME.matches(s)
    fun isMachineName(s: String) = MACHINE_NAME.matches(s)
    fun isNodeName(s: String) = NODE_NAME.matches(s)

    /**
     * An `https:` URL with a host, no userinfo and no fragment (the front
     * door's isHttpsUrl). Stricter where parsers differ: the text must start
     * `https://`, and java.net.URI must read a host from it.
     */
    fun isHttpsUrl(s: String, max: Int): Boolean {
        if (s.isEmpty() || s.length > max || '#' in s) return false
        if (!s.regionMatches(0, "https://", 0, 8, ignoreCase = true)) return false
        val authority = s.substring(8).split('/', '?', '\\')[0]
        if (authority.isEmpty() || '@' in authority) return false
        val uri = runCatching { URI(s) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawFragment == null
    }

    fun isClientId(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return token(v, "dcr_", 22) || isHttpsUrl(s, CLIENT_ID_MAX)
    }

    fun isUri(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.isNotEmpty() && s.length <= URI_MAX
    }

    fun isCodeChallenge(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.length in 43..128 && B64URL.matches(s)
    }

    fun isUserCode(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.length == 6 && s.all { it in FrontDoor.USER_CODE_ALPHABET }
    }

    /** Strictly increasing (so sorted and unique), each passing `test`. */
    private fun sortedUnique(list: List<JsonElement>, min: Int, max: Int, test: (String) -> Boolean): Boolean {
        if (list.size !in min..max) return false
        var previous: String? = null
        for (value in list) {
            val s = value.str() ?: return false
            if (!test(s)) return false
            if (previous != null && previous >= s) return false
            previous = s
        }
        return true
    }

    fun isScopeList(v: JsonElement?): Boolean {
        val list = v.arr() ?: return false
        if (list.size > MAX_SCOPES) return false
        var previous: String? = null
        for (entry in list) {
            val o = entry.obj() ?: return false
            if (!Rules.hasExactKeys(o, listOf("scope", "machines"))) return false
            val scope = o["scope"].str() ?: return false
            if (!isScopeName(scope)) return false
            if (previous != null && previous >= scope) return false
            previous = scope
            val machines = o["machines"]
            if (machines !is JsonNull) {
                val names = machines.arr() ?: return false
                if (!sortedUnique(names, 1, MAX_MACHINES, ::isMachineName)) return false
            }
        }
        return true
    }

    private fun grant(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "grant_id", "client_id", "client_name", "redirect_uri", "resource",
                "code_challenge", "user_code", "scopes", "decision", "nonce", "device_id", "signed_at"))) return false
        if (!Rules.isNodeId(m["frontdoor_id"]) || !isGrantId(m["grant_id"]) || !isClientId(m["client_id"]) ||
            !Rules.withinLength(m["client_name"], CLIENT_NAME_MAX) || !isUri(m["redirect_uri"]) || !isUri(m["resource"]) ||
            !isCodeChallenge(m["code_challenge"]) || !isUserCode(m["user_code"]) || !isScopeList(m["scopes"]) ||
            !Rules.isNonce(m["nonce"]) || !Rules.isDeviceId(m["device_id"]) || !Rules.isTimestamp(m["signed_at"])) return false
        val scopes = m["scopes"].arr()!!
        return when (m["decision"].str()) {
            "approve" -> scopes.isNotEmpty()
            "deny" -> scopes.isEmpty()
            else -> false
        }
    }

    private fun revoke(m: JsonObject): Boolean =
        Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "grant_id", "challenge", "device_id", "signed_at")) &&
            Rules.isNodeId(m["frontdoor_id"]) && isGrantId(m["grant_id"]) && Rules.isNonce(m["challenge"]) &&
            Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])

    private fun enroll(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "pairing_id", "node_id", "node_name", "profile", "public_key",
                "tls_fingerprint", "replaces", "decision", "nonce", "device_id", "signed_at"))) return false
        val name = m["node_name"].str() ?: return false
        return Rules.isNodeId(m["frontdoor_id"]) && isPairingId(m["pairing_id"]) && Rules.isNodeId(m["node_id"]) && isNodeName(name) &&
            Rules.isOneOf(m["profile"], listOf("agent", "runbook")) && isRawEd25519(m["public_key"]) && isHex64(m["tls_fingerprint"]) &&
            (m["replaces"] is JsonNull || Rules.isNodeId(m["replaces"])) && Rules.isOneOf(m["decision"], listOf("approve", "deny")) &&
            Rules.isNonce(m["nonce"]) && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    private fun remove(m: JsonObject): Boolean =
        Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "node_id", "challenge", "device_id", "signed_at")) &&
            Rules.isNodeId(m["frontdoor_id"]) && Rules.isNodeId(m["node_id"]) && Rules.isNonce(m["challenge"]) &&
            Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])

    /** `old_spki ≠ new_spki` (§3.7): a re-pin to the same key is malformed. */
    private fun repin(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "relay", "old_spki", "new_spki", "created_at"))) return false
        val relay = m["relay"].str() ?: return false
        return Rules.isNodeId(m["frontdoor_id"]) && isHttpsUrl(relay, URI_MAX) && isSpkiPin(m["old_spki"]) &&
            isSpkiPin(m["new_spki"]) && m["old_spki"].str() != m["new_spki"].str() && Rules.isTimestamp(m["created_at"])
    }
}
