package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.9):
 * the node-signed question a phone shows and the device-signed
 * `kl.question.answer` it sends back. The node seals questions as
 * `kl.question.ask` (preflight M6: the relay mailbox routes only full dotted
 * prefixes).
 */
data class QuestionOption(val id: String, val label: String)

data class QuestionItem(
    val token: String,
    val nodeId: String,
    val nodeName: String,
    val caseId: String,
    val questionId: String,
    val caseTitle: String,
    val kind: String,
    val urgency: String,
    val text: String,
    val options: List<QuestionOption>,
    /**
     * Why this question cannot be read, so shows no text and takes no answer:
     * `not_recipient`, `open_failed` (R-SP-6), or `clear_after_sealed` (R-SP-15).
     * Only the clear facts above are set. Null for a question that can be answered.
     */
    val unreadable: String? = null,
    /** The opened ask's node box, which its answer is sealed to (R-SP-3). Null for a clear ask. */
    val nodeBox: JsonObject? = null,
    val seal: SealState = SealState.CLEAR,
    /** The ask's signed `expires_at`, which stays in clear (R-SP-4); null when it has none. */
    val expiresAt: String? = null
) {
    companion object {
        const val TYPE = "kl.question.ask"

        /**
         * null unless [message] is a complete `kl.question.ask`, clear or sealed.
         * [message] has passed the node's signature: only then may [open] read it.
         * What cannot be read has [unreadable] set.
         */
        fun from(message: JsonElement, nodeName: String, open: Opener? = null, sealedSeen: Set<String>): QuestionItem? {
            val received = message.obj() ?: return null
            if (received["type"].str() != TYPE) return null
            val token = received["token"].str() ?: return null
            val nodeId = received["node_id"].str() ?: return null
            fun unreadable(reason: String, state: SealState) = QuestionItem(
                token, nodeId, nodeName, "", "", "", received["kind"].str() ?: "question", received["urgency"].str() ?: "normal", "", emptyList(),
                unreadable = reason, seal = state, expiresAt = received["expires_at"].str()
            )
            if (Seal.clearRefused(TYPE, received, sealedSeen)) return unreadable(Seal.CLEAR_AFTER_SEALED, SealState.CLEAR)
            if (received.containsKey("sealed") && !isSealedAsk(received)) return null
            val read = Seal.read(TYPE, received, open) ?: return null
            if (!read.opened) return unreadable(read.reason ?: return null, read.state)
            val full = read.message
            val sealed = read.state == SealState.OPENED
            val caseId = full["case_id"].str() ?: return null
            val questionId = full["question_id"].str() ?: return null
            val text = full["text"].str() ?: return null
            if (sealed && !isOpenedAsk(full)) return null
            val options = (full["options"].arr() ?: emptyList()).mapNotNull { o ->
                val id = o["id"].str() ?: return@mapNotNull null
                val label = o["label"].str() ?: return@mapNotNull null
                QuestionOption(id, label)
            }
            return QuestionItem(
                token, nodeId, nodeName, caseId, questionId, full["case_title"].str() ?: "",
                full["kind"].str() ?: "question", full["urgency"].str() ?: "normal", text, options,
                nodeBox = if (sealed) full["node_box"].obj() else null, seal = read.state, expiresAt = full["expires_at"].str()
            )
        }

        /** TOKEN_RE in src/cases/contact-format.js; CASE_ID and QUESTION_ID in src/channels/mobile-app-channel.js. */
        private val TOKEN = Regex("[0-9A-HJKMNP-TV-Z]{6}")
        private val CASE_ID = Regex("[A-Za-z0-9._-]{1,80}")
        private val QUESTION_ID = Regex("q-[0-9]{4,}")

        /** What a sealed ask holds in clear (validateAskMessage in src/channels/mobile-app-channel.js). */
        private fun isSealedAsk(m: JsonObject): Boolean =
            m["v"]?.let { Rules.isOne(it) } == true && Seal.isSealedShape(TYPE, m) && Rules.isNodeId(m["node_id"]) &&
                m["token"].str()?.let { TOKEN.matches(it) } == true && m["kind"].str() != null && m["urgency"].str() != null &&
                (m["expires_at"] is JsonNull || Rules.isTimestamp(m["expires_at"])) && Rules.isDeviceJwk(m["node_box"])

        /** And what its content holds once opened. */
        private fun isOpenedAsk(m: JsonObject): Boolean =
            m["case_id"].str()?.let { CASE_ID.matches(it) } == true && m["question_id"].str()?.let { QUESTION_ID.matches(it) } == true &&
                m["case_title"].str() != null && m["text"].str() != null && m["options"].arr() != null
    }
}

object Questions {
    /**
     * The message the phone signs; the node checks every field (R44). An
     * option pick carries only `option_id`, and the text is the answer body
     * only: a signed answer resolves its own question and nothing else.
     * [sealTo] is the node box it is sealed to (R-SP-3), the ask's own by default;
     * a sealed ask is answered to its own box and no other, never in clear, and
     * one that cannot be read is not answered at all. A sealed answer's content is exact JCS ([Seal]).
     */
    fun answer(item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String, sealTo: JsonObject? = item.nodeBox): JsonObject {
        if (item.unreadable != null) throw ProtocolException("this question cannot be answered: ${item.unreadable}")
        if (item.nodeBox != null && sealTo != item.nodeBox) throw ProtocolException("a sealed question is answered sealed, to its own node box")
        val answer = if (optionId != null) JsonObject(mapOf("option_id" to jsonString(optionId)))
        else JsonObject(mapOf("text" to jsonString(text ?: "")))
        val full = JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "type" to jsonString("kl.question.answer"),
                "node_id" to jsonString(item.nodeId),
                "case_id" to jsonString(item.caseId),
                "question_id" to jsonString(item.questionId),
                "token" to jsonString(item.token),
                "answer" to answer,
                "nonce" to jsonString(nonce),
                "signed_at" to jsonString(signedAt),
                "device_id" to jsonString(deviceId)
            )
        )
        if (sealTo == null) return full
        return try {
            val (clear, content) = Seal.split("kl.question.answer", full)
            Seal.seal("kl.question.answer", deviceId, clear, content, item.nodeId to sealTo)
        } catch (e: SealException) {
            throw ProtocolException("cannot seal the answer: ${e.reason}")
        }
    }
}
