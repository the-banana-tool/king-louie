package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A seal refused; `reason` is the node's word (src/approvals/seal.js): `malformed`, `not_recipient`, `open_failed`, `content_malformed`. */
class SealException(val reason: String, detail: String = "") : Exception(if (detail.isEmpty()) reason else "$reason: $detail")

/**
 * The phone's box key will not act now (a locked Keystore). It is not a wrap
 * that does not open: an `agree` that throws this goes through [Seal.open], and
 * a reader takes it as [Seal.KEY_LOCKED].
 */
open class SealKeyUnavailableException(message: String) : Exception(message)

/**
 * What opens a sealed message for this phone. A reader calls it only after the
 * node's signature held against the pin: a successful open proves nothing about
 * who sealed it. A wrapper over [Seal.opener] sees only verified messages.
 */
typealias Opener = (type: String, message: JsonObject) -> JsonObject

/**
 * Whether a box key that keeps refusing has stopped working. A Keystore refuses a
 * locked phone by design, and for a moment after it unlocks, so only failures on
 * an unlocked phone count, and only when there are several and they last. A fresh
 * open, or a phone seen locked, starts the count again.
 */
class BoxKeyHealth(private val strikesToBreak: Int = 3, private val afterMs: Long = 30_000L) {
    private var strikes = 0
    private var failingSinceMs = 0L

    var broken = false
        private set

    fun failedUnlocked(nowMs: Long) {
        if (strikes == 0) failingSinceMs = nowMs
        strikes++
        if (strikes >= strikesToBreak && nowMs - failingSinceMs >= afterMs) broken = true
    }

    fun opened() = reset()

    fun locked() = reset()

    fun reset() {
        strikes = 0
        broken = false
    }
}

/** How a message reached a reader: never sealed, sealed and opened, or sealed and not this phone's to open. */
enum class SealState { CLEAR, OPENED, UNREAD }

/**
 * The seal (sealed phones plan, R-SP-1, R-SP-2, R-SP-4), written to match
 * src/approvals/seal.js, proven by the `seal-*` vectors.
 *
 *   sealed = { v: 1, epk, iv, ct, keys }
 *   ct     = AES-256-GCM(cek, iv, JCS(content), aad = JCS(clear part)) ‖ tag
 *   keys   = { [recipient id]: AES-256-GCM(kek, 12 zero bytes, cek) ‖ tag }
 *   kek    = HKDF-SHA256(ECDH(epk, recipient box key), salt = 32 zero bytes,
 *                        info = "kl-seal-v1\n<type>\n<sender id>\n<recipient id>")
 *
 * RFC 5869 makes an empty salt and 32 zero bytes the same HMAC key;
 * SecretKeySpec refuses an empty one. The message a validator checks is clear ∪
 * content; nothing here reads a clear value but the sender id.
 *
 * A sealer adds `pad`, a string of spaces, so that JCS(content) is a whole number
 * of 256-byte blocks: a relay would otherwise read a short answer's option from
 * the length of `ct`. An opener takes a pad of any number of spaces, and strips
 * it. It is in no table and in no hash.
 */
object Seal {
    private class Row(val content: List<String>, val clear: List<String>)

    /** R-SP-4, one row per type, so a type cannot have one column and not the other. */
    private val TABLE = mapOf(
        "kl.approval.request" to Row(
            listOf("action", "origin", "salt"),
            listOf("v", "type", "request_id", "node_id", "node_name", "action_hash", "created_at", "expires_at", "nonce", "node_box")
        ),
        "kl.lease.request" to Row(
            listOf("lease", "origin", "salt"),
            listOf("v", "type", "request_id", "lease_id", "node_id", "node_name", "lease_hash", "created_at", "expires_at", "nonce", "node_box")
        ),
        "kl.lease.status" to Row(
            listOf("name"),
            listOf("v", "type", "node_id", "lease_id", "seq", "at", "state", "locked", "reason", "expires_at", "contact_token", "granted_by", "kind", "unattended")
        ),
        "kl.lease.view" to Row(
            listOf("foreground", "frame", "frame_dropped", "actions"),
            listOf("v", "type", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s", "contact_token")
        ),
        "kl.question.ask" to Row(
            listOf("case_id", "question_id", "case_title", "text", "options"),
            listOf("v", "type", "node_id", "token", "kind", "urgency", "expires_at", "node_box")
        ),
        "kl.question.answer" to Row(
            listOf("case_id", "question_id", "answer"),
            listOf("v", "type", "node_id", "token", "device_id", "nonce", "signed_at")
        )
    )

    /**
     * R-SP-15: a relay can replay an old clear ask or request, signed by the
     * node, to draw a clear answer. Once this phone has verified a sealed message
     * from a node, opened or not, such a message from that node is unreadable with this reason
     * and offers no decision. Checked after the signature, by the reader, so nobody
     * parses an unverified payload to find its node.
     */
    const val CLEAR_AFTER_SEALED = "clear_after_sealed"
    private val HELD_TO_SEALING = setOf("kl.question.ask", "kl.approval.request", "kl.lease.request")

    /** Whether R-SP-15 refuses this message. [sealedSeen]: the nodes this phone has verified a sealed message from. */
    fun clearRefused(type: String, message: JsonObject, sealedSeen: Set<String>): Boolean =
        type in HELD_TO_SEALING && !message.containsKey("sealed") && message["node_id"].str()?.let { it in sealedSeen } == true

    /**
     * Sealed and the phone's box key will not act now: it passes when the phone
     * unlocks. No decision is offered, and what needs nothing opened still reads.
     * It marks a node only as any sealed message does: past the node's signature.
     */
    const val KEY_LOCKED = "key_locked"

    /**
     * The nodes seen sealing, after a message from [nodeId] was read past its signature: a sealed
     * one marks it, opened or not, since only that node could have signed it. Nothing takes one
     * away. A reader answers [SealState.CLEAR] for a misshapen or unverified message, so it marks nothing.
     */
    fun noteSealedSeen(seen: Set<String>, nodeId: String, state: SealState): Set<String> = if (state != SealState.CLEAR) seen + nodeId else seen

    private const val KEY_BYTES = 32
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16
    private const val WRAP_BYTES = KEY_BYTES + TAG_BYTES
    private const val PAD_KEY = "pad"
    private const val PAD_BLOCK = 256
    private val RECIPIENT_ID = Regex("(d|kl)-[a-z2-7]{16}")
    private val secureRandom = SecureRandom()

    /** Which clear key names the sender, the third line of the info. A phone sends only the answer; a node sends the rest. */
    private fun senderKey(type: String) = if (type == "kl.question.answer") "device_id" else "node_id"

    private fun byteLength(v: JsonElement?): Int {
        val text = v.str() ?: return -1
        return try {
            B64Url.decode(text).size
        } catch (e: ProtocolException) {
            -1
        }
    }

    private fun isSealedObject(v: JsonElement?): Boolean {
        val sealed = v.obj() ?: return false
        if (!Rules.hasExactKeys(sealed, listOf("ct", "epk", "iv", "keys", "v"))) return false
        if (sealed["v"]?.let { Rules.isOne(it) } != true || !Rules.isDeviceJwk(sealed["epk"])) return false
        if (byteLength(sealed["iv"]) != IV_BYTES || byteLength(sealed["ct"]) < TAG_BYTES) return false
        val keys = sealed["keys"].obj() ?: return false
        return keys.isNotEmpty() && keys.all { (id, wrap) -> RECIPIENT_ID.matches(id) && byteLength(wrap) == WRAP_BYTES }
    }

    /** Exactly the type's clear keys plus `sealed`, and `sealed` well formed: its epk a point on P-256, checked before any key agreement. */
    fun isSealedShape(type: String, message: JsonObject): Boolean {
        val row = TABLE[type] ?: return false
        return message["type"].str() == type && Rules.hasExactKeys(message, row.clear + "sealed") && isSealedObject(message["sealed"])
    }

    /** JCS refuses what has no one encoding (a lone surrogate). */
    private fun jcs(value: JsonElement, reason: String, what: String): ByteArray = try {
        Jcs.bytes(value)
    } catch (e: ProtocolException) {
        throw SealException(reason, "$what cannot be canonicalized")
    }

    private fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        parts.forEach { update(it) }
        doFinal()
    }

    /** HKDF-SHA256 for 32 bytes: one expand block. */
    private fun kekFor(secret: ByteArray, type: String, senderId: String, recipientId: String): ByteArray {
        val prk = hmac(ByteArray(32), secret)
        return hmac(prk, "kl-seal-v1\n$type\n$senderId\n$recipientId".toByteArray(Charsets.UTF_8), byteArrayOf(1))
    }

    /** doFinal checks the tag; nothing leaves here until it has. */
    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, input: ByteArray, aad: ByteArray? = null): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
        if (aad != null) updateAAD(aad)
        doFinal(input)
    }

    /** A space is one byte in JCS, so the bytes with an empty pad say how many it takes. */
    private fun padded(content: JsonObject): ByteArray {
        val bare = jcs(JsonObject(content + (PAD_KEY to jsonString(""))), "malformed", "content").size
        val spaces = (PAD_BLOCK - bare % PAD_BLOCK) % PAD_BLOCK
        return jcs(JsonObject(content + (PAD_KEY to jsonString(" ".repeat(spaces)))), "malformed", "content")
    }

    private fun parseContent(type: String, plaintext: ByteArray): JsonObject {
        val content = try {
            JsonText.parse(plaintext)
        } catch (e: ProtocolException) {
            throw SealException("content_malformed", "not JSON")
        }
        if (content !is JsonObject) throw SealException("content_malformed", "not an object")
        // The table's keys and the pad, and no other: a clear key here could overrule what the relay and the AAD saw.
        if (!(TABLE.getValue(type).content + PAD_KEY).containsAll(content.keys)) throw SealException("content_malformed", "holds a key the type does not seal")
        if (content.containsKey(PAD_KEY) && content[PAD_KEY].str()?.all { it == ' ' } != true) throw SealException("content_malformed", "a pad is only spaces")
        // The bytes are the JCS of the object, as Envelope.open holds a payload to.
        val canonical = try {
            Jcs.numbersAreCanonical(content) && Jcs.bytes(content).contentEquals(plaintext)
        } catch (e: ProtocolException) {
            false
        }
        if (!canonical) throw SealException("content_malformed", "not canonical")
        return JsonObject(content - PAD_KEY)
    }

    /**
     * The whole message (clear ∪ content) of one sealed to [recipientId]. [agree]
     * gives the raw x-coordinate of ECDH(epk, this box key). A successful open is
     * not authentication: anyone can seal to a public box key and name any sender,
     * so the caller verifies the signed envelope and its signer first.
     */
    fun open(type: String, message: JsonObject, recipientId: String, agree: (x: String, y: String) -> ByteArray): JsonObject {
        if (!isSealedShape(type, message)) throw SealException("malformed", "not a sealed message of this type")
        val sealed = message.getValue("sealed").obj()!!
        val wrap = sealed["keys"].obj()!![recipientId] ?: throw SealException("not_recipient")
        val clear = JsonObject(message - "sealed")
        val aad = jcs(clear, "malformed", "the clear part")
        val senderId = clear[senderKey(type)].str() ?: throw SealException("malformed", "no sender id")
        val plaintext = try {
            val secret = agree(sealed["epk"]["x"].str()!!, sealed["epk"]["y"].str()!!)
            if (secret.size != KEY_BYTES) throw SealException("open_failed")
            val cek = gcm(Cipher.DECRYPT_MODE, kekFor(secret, type, senderId, recipientId), ByteArray(IV_BYTES), B64Url.decode(wrap.str()!!))
            gcm(Cipher.DECRYPT_MODE, cek, B64Url.decode(sealed["iv"].str()!!), B64Url.decode(sealed["ct"].str()!!), aad)
        } catch (e: SealKeyUnavailableException) {
            throw e
        } catch (e: Exception) {
            // One answer whichever step failed, and no bytes from a step that did.
            throw SealException("open_failed")
        }
        return JsonObject(clear + parseContent(type, plaintext))
    }

    /** [open] for one phone's box key. */
    fun opener(recipientId: String, agree: (x: String, y: String) -> ByteArray): Opener = { type, message -> open(type, message, recipientId, agree) }

    /** A fresh key for the epk: its JWK, and ECDH with a recipient's point. */
    internal class Ephemeral(val jwk: JsonObject, val agree: (x: String, y: String) -> ByteArray)

    private fun newEphemeral(): Ephemeral {
        val pair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"), secureRandom)
            generateKeyPair()
        }
        val w = (pair.public as ECPublicKey).w
        return Ephemeral(Messages.jwk(B64Url.encode(P256.coordinate(w.affineX)), B64Url.encode(P256.coordinate(w.affineY)))) { x, y ->
            KeyAgreement.getInstance("ECDH").run {
                init(pair.private)
                doPhase(P256.publicKey(x, y), true)
                generateSecret()
            }
        }
    }

    /** What a phone sends sealed, to one recipient: [recipient] is its id and its box key, a P-256 JWK checked on the curve before use. The result is `clear` and `sealed`. */
    fun seal(type: String, senderId: String, clear: JsonObject, content: JsonObject, recipient: Pair<String, JsonObject>): JsonObject =
        sealWith(type, senderId, clear, content, recipient, newEphemeral()) { n -> ByteArray(n).also { secureRandom.nextBytes(it) } }

    /** [seal] with its key and random bytes given: for vectors only. */
    internal fun sealWith(
        type: String, senderId: String, clear: JsonObject, content: JsonObject, recipient: Pair<String, JsonObject>,
        ephemeral: Ephemeral, random: (Int) -> ByteArray
    ): JsonObject {
        val row = TABLE[type] ?: throw SealException("malformed", "this type is not sealed")
        // The new message would overwrite it, and the AAD would cover what no opener sees.
        if (clear.containsKey("sealed")) throw SealException("malformed", "the clear part holds sealed")
        if (clear[senderKey(type)].str() != senderId) throw SealException("malformed", "senderId is not the sender the clear part names")
        if (!row.content.containsAll(content.keys)) throw SealException("malformed", "content holds a key the type does not seal")
        val (id, boxKey) = recipient
        if (!RECIPIENT_ID.matches(id)) throw SealException("malformed", "a recipient id is not a device or node id")
        if (!Rules.isDeviceJwk(boxKey)) throw SealException("malformed", "a recipient key is not a P-256 point")
        val cek = random(KEY_BYTES)
        val iv = random(IV_BYTES)
        val ct = gcm(Cipher.ENCRYPT_MODE, cek, iv, padded(content), jcs(clear, "malformed", "the clear part"))
        val secret = ephemeral.agree(boxKey["x"].str()!!, boxKey["y"].str()!!)
        if (secret.size != KEY_BYTES) throw SealException("malformed", "the key agreement gave the wrong size")
        val wrap = gcm(Cipher.ENCRYPT_MODE, kekFor(secret, type, senderId, id), ByteArray(IV_BYTES), cek)
        val sealed = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "epk" to ephemeral.jwk, "iv" to jsonString(B64Url.encode(iv)), "ct" to jsonString(B64Url.encode(ct)),
                "keys" to JsonObject(mapOf(id to jsonString(B64Url.encode(wrap))))
            )
        )
        val message = JsonObject(clear + ("sealed" to sealed))
        // What is built here must be what an opener takes: a clear key missing or extra is refused now.
        if (!isSealedShape(type, message)) throw SealException("malformed", "the clear part does not fit the type")
        return message
    }

    /** A whole message split by the table: what stays clear, what is sealed. */
    internal fun split(type: String, full: JsonObject): Pair<JsonObject, JsonObject> {
        val row = TABLE[type] ?: throw SealException("malformed", "this type is not sealed")
        if (full.containsKey("sealed")) throw SealException("malformed", "not a full message")
        val (content, clear) = full.entries.partition { it.key in row.content }
        return JsonObject(clear.associate { it.key to it.value }) to JsonObject(content.associate { it.key to it.value })
    }

    /** R-SP-2: b64url(SHA-256(raw(salt) ‖ JCS(value))). */
    fun saltedHash(salt: String, value: JsonElement): String {
        val raw = try {
            B64Url.decode(salt)
        } catch (e: ProtocolException) {
            throw SealException("malformed", "a salt is 32 bytes")
        }
        if (raw.size != KEY_BYTES) throw SealException("malformed", "a salt is 32 bytes")
        return Digest.sha256B64url(raw + jcs(value, "malformed", "the value"))
    }

    /**
     * How a verified message reads. [reason] when not opened: `not_recipient` (no
     * opener, or no wrap for this phone), `open_failed` or [KEY_LOCKED]. [message] is then the
     * clear part alone. Null: sealed in no shape of this type, or it opened to
     * something that is no such content; a screen says `malformed`.
     */
    internal class Read(val message: JsonObject, val state: SealState, val reason: String?) {
        val opened: Boolean get() = state != SealState.UNREAD
    }

    internal fun read(type: String, message: JsonObject, open: Opener?): Read? {
        if (!message.containsKey("sealed")) return Read(message, SealState.CLEAR, null)
        if (!isSealedShape(type, message)) return null
        val clear = JsonObject(message - "sealed")
        if (open == null) return Read(clear, SealState.UNREAD, "not_recipient")
        return try {
            Read(open(type, message), SealState.OPENED, null)
        } catch (e: SealException) {
            if (e.reason == "not_recipient" || e.reason == "open_failed") Read(clear, SealState.UNREAD, e.reason) else null
        } catch (e: SealKeyUnavailableException) {
            Read(clear, SealState.UNREAD, KEY_LOCKED)
        }
    }
}
