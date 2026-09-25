package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A node the phone trusts, pinned from a pairing or invite QR code only. `key` is DER SPKI hex. */
data class NodePin(val id: String, val name: String, val key: String)

/** Whether a request may be shown, and exactly what the approval screen displays (§5, vectors `request-*`). */
data class PhoneView(val shown: Boolean, val reason: String?, val display: JsonElement?) {
    val json: JsonObject
        get() = JsonObject(mapOf("shown" to JsonPrimitive(shown), "reason" to (reason?.let { jsonString(it) } ?: JsonNull), "display" to (display ?: JsonNull)))
}

/**
 * The phone rules of approval-v1 §5, written to match
 * tests/vectors/approval-v1/phone-reference.js (and the iOS core) line for line.
 */
object Display {
    const val COLLAPSE_OVER = 2000
    const val HEAD = 1200
    const val TAIL = 400
    private val commandKeys = setOf("command", "script", "argv")

    /**
     * The EXACT code-point list of approval-v1 §5 (not a Unicode-property
     * lookup, which drifts between platform Unicode versions): Cc, Zl/Zp,
     * Bidi_Control, and Default_Ignorable_Code_Point as of Unicode 15.1.
     */
    fun isHidden(cp: Int): Boolean =
        // Cc
        cp <= 0x1F || cp == 0x7F || cp in 0x80..0x9F ||
            // Zl, Zp
            cp == 0x2028 || cp == 0x2029 ||
            // Bidi_Control
            cp == 0x061C || cp in 0x200E..0x200F || cp in 0x202A..0x202E || cp in 0x2066..0x2069 ||
            // Default_Ignorable_Code_Point (Unicode 15.1)
            cp == 0x00AD || cp == 0x034F || cp in 0x115F..0x1160 || cp in 0x17B4..0x17B5 ||
            cp in 0x180B..0x180F || cp in 0x200B..0x200F || cp in 0x2060..0x206F ||
            cp == 0x3164 || cp in 0xFE00..0xFE0F || cp == 0xFEFF || cp == 0xFFA0 ||
            cp in 0xFFF0..0xFFF8 || cp in 0x1BCA0..0x1BCA3 || cp in 0x1D173..0x1D17A ||
            cp in 0xE0000..0xE0FFF

    /** Every hidden code point becomes ‹U+XXXX› (uppercase hex, at least four digits). */
    fun escape(text: String): String {
        val out = StringBuilder()
        text.codePoints().forEach { cp ->
            if (isHidden(cp)) {
                out.append('‹').append("U+").append(Integer.toHexString(cp).uppercase().padStart(4, '0')).append('›')
            } else {
                out.appendCodePoint(cp)
            }
        }
        return out.toString()
    }

    // paths

    /** A key containing '.', '[', ']', '"' or a hidden code point is shown bracket-quoted. */
    private fun keyNeedsQuoting(key: String): Boolean =
        key.codePoints().anyMatch { it == '.'.code || it == '['.code || it == ']'.code || it == '"'.code || isHidden(it) }

    /** The escaped key with '\' and '"' backslash-escaped. */
    private fun quotedKey(key: String): String = escape(key).replace("\\", "\\\\").replace("\"", "\\\"")

    fun pathSegment(parent: String, key: String): String =
        if (keyNeedsQuoting(key)) "$parent[\"${quotedKey(key)}\"]" else "$parent.${escape(key)}"

    // argv

    /** The EXACT argv whitespace list of approval-v1 §5 (JavaScript's `\s`), not Kotlin's ASCII-only `\s`. */
    private fun isArgvSpace(cp: Int): Boolean =
        cp in 0x09..0x0D || cp == 0x20 || cp == 0xA0 || cp == 0x1680 || cp in 0x2000..0x200A ||
            cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000 || cp == 0xFEFF

    private fun quoteArgvItem(item: String): String {
        val needsQuoting = item.isEmpty() || item.codePoints().anyMatch { it == '"'.code || isArgvSpace(it) }
        return if (needsQuoting) "\"" + item.replace("\"", "\\\"") + "\"" else item
    }

    /** Items joined with spaces; an empty item or one with whitespace or a quote is quoted, so boundaries stay visible. */
    fun joinArgv(items: List<String>): String = items.joinToString(" ") { quoteArgvItem(it) }

    // items

    private fun item(path: String, text: String, tail: String?, hidden: Int): JsonObject = JsonObject(
        mapOf("path" to jsonString(path), "text" to jsonString(text), "tail" to (tail?.let { jsonString(it) } ?: JsonNull), "hidden" to JsonPrimitive(hidden))
    )

    /** Collapse counts Unicode code points, not UTF-16 units. */
    private fun stringItem(path: String, value: String, commandLike: Boolean, collapse: Boolean): JsonObject {
        val cps = value.codePoints().toArray()
        if (collapse && commandLike && cps.size > COLLAPSE_OVER) {
            val head = String(cps, 0, HEAD)
            val tail = String(cps, cps.size - TAIL, TAIL)
            return item(path, escape(head), escape(tail), cps.size - HEAD - TAIL)
        }
        return item(path, escape(value), null, 0)
    }

    /** Every element a string: the array as argv items, else null. */
    private fun argv(values: JsonArray): List<String>? = values.map { it.str() ?: return null }

    private fun flatten(value: JsonElement, path: String, commandLike: Boolean, collapse: Boolean, out: MutableList<JsonElement>) {
        when (value) {
            // The payload is JCS, so a number's content is the lexeme the node sent.
            is JsonNull -> out.add(item(path, "null", null, 0))
            is JsonPrimitive -> if (value.isString) out.add(stringItem(path, value.content, commandLike, collapse)) else out.add(item(path, value.content, null, 0))
            is JsonArray -> {
                val words = if (commandLike) argv(value) else null
                when {
                    value.isEmpty() -> out.add(item(path, "[]", null, 0))
                    words != null -> out.add(stringItem(path, joinArgv(words), true, collapse))
                    else -> value.forEachIndexed { i, v -> flatten(v, "$path[$i]", commandLike, collapse, out) }
                }
            }
            is JsonObject -> {
                if (value.isEmpty()) out.add(item(path, "{}", null, 0))
                // UTF-16 code-unit order, the same order JCS uses.
                value.keys.sorted().forEach { k -> flatten(value.getValue(k), pathSegment(path, k), commandLike || k in commandKeys, collapse, out) }
            }
        }
    }

    /** What the approval screen shows for a request message. With collapse = false every value is shown whole ("Show all"). */
    fun build(message: JsonElement, collapse: Boolean = true): JsonObject {
        val action = message["action"]
        val items = mutableListOf<JsonElement>()
        flatten(action["params"] ?: JsonObject(emptyMap()), "params", false, collapse, items)
        action["steps"].arr()?.forEachIndexed { i, step ->
            val words = step.arr()?.let { argv(it) }
            if (words != null) {
                items.add(stringItem("steps[$i]", joinArgv(words), true, collapse))
            } else {
                // `check` steps (and anything that is not an argv of strings) are shown as their JCS text, never collapsed.
                items.add(item("steps[$i]", escape(Jcs.serialize(step)), null, 0))
            }
        }
        val origin = (message["origin"].obj() ?: JsonObject(emptyMap())).mapValues { (_, v) -> v.str()?.let { jsonString(escape(it)) } ?: JsonNull }
        return JsonObject(
            mapOf(
                "node" to JsonObject(mapOf("id" to (message["node_id"] ?: JsonNull), "name" to jsonString(escape(message["node_name"].str() ?: "")))),
                "kind" to (action["kind"] ?: JsonNull),
                "name" to jsonString(escape(action["name"].str() ?: "")),
                "summary" to jsonString(escape(action["summary"].str() ?: "")),
                "cwd" to (action["cwd"].str()?.let { jsonString(escape(it)) } ?: JsonNull),
                "origin" to JsonObject(origin),
                "items" to JsonArray(items)
            )
        )
    }

    /**
     * Shape first (`malformed`, even from a pinned node), then the pin
     * (`unpinned_node`: node_id not pinned or kid ≠ node_id), then the node's
     * signature over the received bytes (`bad_node_signature`).
     */
    fun view(envelopeJson: JsonElement, pinned: List<NodePin>): PhoneView {
        fun hide(reason: String) = PhoneView(false, reason, null)
        val envelope: Envelope
        val message: JsonObject
        try {
            envelope = Envelope.fromJson(envelopeJson)
            message = envelope.message()
        } catch (e: ProtocolException) {
            return hide("malformed")
        }
        if (Messages.validate("kl.approval.request", message) != null) return hide("malformed")
        val nodeId = message["node_id"].str() ?: return hide("malformed")
        val pin = pinned.firstOrNull { it.id == nodeId }
        if (pin == null || envelope.kid != nodeId) return hide("unpinned_node")
        if (!envelope.verifyEd25519(pin.key)) return hide("bad_node_signature")
        return PhoneView(true, null, build(message))
    }
}

/** A node-signed kl.approval.status (approval-v1 §3.3) for one request. */
data class ApprovalStatus(val state: String, val deviceId: String?, val reason: String?) {
    companion object {
        /**
         * The status, or null unless: the envelope opens strictly, `kid` is the
         * pinned node, its signature verifies against the pinned key, the
         * message is a valid kl.approval.status, and it names this request and
         * this node.
         */
        fun verify(envelopeJson: JsonElement, requestId: String, pin: NodePin): ApprovalStatus? {
            val envelope = try {
                Envelope.fromJson(envelopeJson)
            } catch (e: ProtocolException) {
                return null
            }
            if (envelope.kid != pin.id || !envelope.verifyEd25519(pin.key)) return null
            val message = try {
                envelope.message()
            } catch (e: ProtocolException) {
                return null
            }
            if (Messages.validate("kl.approval.status", message) != null) return null
            if (message["request_id"].str() != requestId || message["node_id"].str() != pin.id) return null
            val state = message["state"].str() ?: return null
            return ApprovalStatus(state, message["device_id"].str(), message["reason"].str())
        }
    }
}

/**
 * History comes as node-signed kl.audit.slice envelopes; the phone checks them
 * in the order of approval-v1 §3.6 (`verifyAuditSlice` in
 * src/audit/audit-ledger.js). The first failure decides the reason.
 */
object AuditSlice {
    data class Result(val ok: Boolean, val reason: String?, val entries: List<JsonElement>)

    private fun fail(reason: String) = Result(false, reason, emptyList())

    private fun seq(v: JsonElement?): Double? = if (v.isNumber()) (v as JsonPrimitive).content.toDoubleOrNull()?.takeIf { it.isFinite() } else null

    fun verify(envelopeJson: JsonElement, nodeKeyHex: String): Result {
        // 1. Signature against the pinned node key. Like the JS verifier, this
        // looks only at alg, payload and sig; the envelope's full shape is step
        // 2, so a correctly signed but misshapen envelope is `malformed`.
        val alg = envelopeJson["alg"].str()
        val payload = envelopeJson["payload"].str()
        val sig = envelopeJson["sig"].str()
        if (alg == null || payload == null || sig == null || !Envelope(alg, "", payload, sig).verifyEd25519(nodeKeyHex)) {
            return fail("bad_signature")
        }
        // 2. Opens (exactly alg, kid, payload, sig; canonical bytes), and is a kl.audit.slice.
        val envelope: Envelope
        val message: JsonObject
        try {
            envelope = Envelope.fromJson(envelopeJson)
            message = envelope.message()
        } catch (e: ProtocolException) {
            return fail("malformed")
        }
        Messages.validate("kl.audit.slice", message)?.let { return fail(it) }
        // 3. kid is the node inside.
        val nodeId = message["node_id"].str()
        val entries = message["entries"].arr()
        val head = message["head"]
        val anchor = message["anchor"]
        val headSeq = seq(head["seq"])
        val anchorSeq = seq(anchor["seq"])
        if (nodeId == null || envelope.kid != nodeId || entries == null || headSeq == null || anchorSeq == null) return fail("malformed")

        var previousSeq: Double? = null
        var previousHash: String? = null
        for (entry in entries) {
            // An array has no node_id (foreign_entry); any other non-object is malformed.
            if (entry is JsonArray) return fail("foreign_entry")
            val fields = entry.obj() ?: return fail("malformed")
            // 4. Every entry belongs to this node.
            if (fields["node_id"].str() != nodeId) return fail("foreign_entry")
            // 5. hash = hex SHA-256 over JCS(entry without hash).
            val hash = fields["hash"].str()
            val computed = try {
                Digest.sha256Hex(Jcs.bytes(JsonObject(fields - "hash")))
            } catch (e: ProtocolException) {
                null
            }
            if (hash == null || computed != hash) return fail("hash_mismatch")
            val entrySeq = seq(fields["seq"]) ?: return fail("malformed")
            // 6. seq increments by one and prev links to the previous hash.
            if (previousSeq != null && (entrySeq != previousSeq + 1 || fields["prev"].str() != previousHash)) return fail("broken_chain")
            previousSeq = entrySeq
            previousHash = hash
        }
        // 7. The last entry does not read past the slice's own signed head.
        if (previousSeq != null) {
            if (previousSeq > headSeq) return fail("exceeds_head")
            if (previousSeq == headSeq && head["hash"].str() != previousHash) return fail("head_mismatch")
        }
        // 8. The first entry does not read before the slice's own signed anchor.
        val firstSeq = entries.firstOrNull()?.let { seq(it["seq"]) }
        if (firstSeq != null && firstSeq < anchorSeq) return fail("before_anchor")
        return Result(true, null, entries)
    }
}
