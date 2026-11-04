package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

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

    /** A P-256 key for the node's box, made here: the answer opens with it and nothing else. */
    private fun nodeBox(): Pair<JsonObject, (String, String) -> ByteArray> {
        val pair = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        val w = (pair.public as ECPublicKey).w
        val jwk = Messages.jwk(B64Url.encode(P256.coordinate(w.affineX)), B64Url.encode(P256.coordinate(w.affineY)))
        return jwk to softwareAgree(P256.coordinate((pair.private as ECPrivateKey).s))
    }

    @Test
    fun sealsTheAnswerToWhatItIsTold() {
        val (box, agree) = nodeBox()
        val item = QuestionItem.from(question, "web-01")!!
        val message = Questions.answer(item, null, "Only after the survey", "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z", sealTo = box)
        for (key in listOf("case_id", "question_id", "answer")) assertFalse(key, message.containsKey(key))
        assertEquals("kl-aaaaaaaaaaaaaaaa", message["node_id"].str())
        assertEquals(setOf("kl-aaaaaaaaaaaaaaaa"), message["sealed"]["keys"].obj()!!.keys)
        val clearAnswer = Questions.answer(item, null, "Only after the survey", "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
        assertEquals(clearAnswer, Seal.open("kl.question.answer", message, "kl-aaaaaaaaaaaaaaaa", agree))
    }

    /** A clear ask takes no node_box from its text: only an opened one has it. */
    @Test
    fun aClearAskHasNothingToSealTo() {
        val item = QuestionItem.from(question, "web-01")!!
        assertNull(item.nodeBox)
        assertNull(item.unreadable)
        assertEquals(SealState.CLEAR, item.seal)
    }

    /** R-SP-15: a clear ask from a node seen sealing shows no question and takes no answer. */
    @Test
    fun aClearAskAfterSealed() {
        val item = QuestionItem.from(question, "web-01", sealedSeen = true)!!
        assertEquals("clear_after_sealed", item.unreadable)
        assertEquals("", item.text)
        assertEquals("", item.caseId)
        assertTrue(item.options.isEmpty())
        assertEquals("web-01", item.nodeName)
        assertEquals("7QD4KM", item.token)
        try {
            Questions.answer(item, "a", null, "d-bbbbbbbbbbbbbbbb", "n".repeat(43), "2026-09-25T14:00:00Z")
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // no answer offered
        }
        assertNull(QuestionItem.from(question, "web-01", sealedSeen = false)!!.unreadable)
    }
}
