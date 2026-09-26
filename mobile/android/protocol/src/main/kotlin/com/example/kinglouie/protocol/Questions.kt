package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
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
    val options: List<QuestionOption>
) {
    companion object {
        const val TYPE = "kl.question.ask"

        /** null unless [message] is a complete `kl.question.ask`. */
        fun from(message: JsonElement, nodeName: String): QuestionItem? {
            if (message["type"].str() != TYPE) return null
            val token = message["token"].str() ?: return null
            val nodeId = message["node_id"].str() ?: return null
            val caseId = message["case_id"].str() ?: return null
            val questionId = message["question_id"].str() ?: return null
            val text = message["text"].str() ?: return null
            val options = (message["options"].arr() ?: emptyList()).mapNotNull { o ->
                val id = o["id"].str() ?: return@mapNotNull null
                val label = o["label"].str() ?: return@mapNotNull null
                QuestionOption(id, label)
            }
            return QuestionItem(
                token, nodeId, nodeName, caseId, questionId, message["case_title"].str() ?: "",
                message["kind"].str() ?: "question", message["urgency"].str() ?: "normal", text, options
            )
        }
    }
}

object Questions {
    /**
     * The message the phone signs; the node checks every field (R44). An
     * option pick carries only `option_id`, and the text is the answer body
     * only: a signed answer resolves its own question and nothing else.
     */
    fun answer(item: QuestionItem, optionId: String?, text: String?, deviceId: String, nonce: String, signedAt: String): JsonObject {
        val answer = if (optionId != null) JsonObject(mapOf("option_id" to jsonString(optionId)))
        else JsonObject(mapOf("text" to jsonString(text ?: "")))
        return JsonObject(
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
    }
}
