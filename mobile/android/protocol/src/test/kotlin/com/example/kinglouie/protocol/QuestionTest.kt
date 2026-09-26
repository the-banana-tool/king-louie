package com.example.kinglouie.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cases stage 4 §3.9. The expected bytes are the same string the node test
 * (tests/contact-mobile.test.js) feeds to its kl.question.answer validator.
 * The node seals questions as `kl.question.ask` (preflight M6).
 */
class QuestionTest {
    private val question = JsonText.parse(
        """{"v":1,"type":"kl.question.ask","node_id":"kl-aaaaaaaaaaaaaaaa","case_id":"mfz1k2-0a1b2c3d","question_id":"q-0012","token":"7QD4KM","kind":"question","urgency":"high","case_title":"Lakeside lot","text":"Accept the 41k offer?","options":[{"id":"a","label":"Yes"},{"id":"b","label":"No"}],"expires_at":null}"""
    )

    @Test
    fun parsesAQuestion() {
        val item = QuestionItem.from(question, "web-01")
        assertNotNull(item)
        assertEquals("7QD4KM", item!!.token)
        assertEquals("Lakeside lot", item.caseTitle)
        assertEquals("high", item.urgency)
        assertEquals(listOf(QuestionOption("a", "Yes"), QuestionOption("b", "No")), item.options)
    }

    @Test
    fun refusesAnythingElse() {
        assertNull(QuestionItem.from(JsonText.parse("""{"type":"kl.approval.request"}"""), "web-01"))
        assertNull(QuestionItem.from(JsonText.parse("""{"type":"kl.question.ask","token":"7QD4KM"}"""), "web-01"))
        // The pre-M6 type name is not a question either.
        assertNull(QuestionItem.from(JsonText.parse(Jcs.serialize(question).replace("kl.question.ask", "kl.question")), "web-01"))
    }

    @Test
    fun buildsTheAnswerTheNodeVerifies() {
        val item = QuestionItem.from(question, "web-01")!!
        val message = Questions.answer(item, "a", null, "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
        assertEquals(
            """{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}""",
            Jcs.serialize(message)
        )
        val text = Questions.answer(item, null, "Only after the survey", "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
        assertTrue(Jcs.serialize(text).startsWith("""{"answer":{"text":"Only after the survey"},"""))
    }
}
