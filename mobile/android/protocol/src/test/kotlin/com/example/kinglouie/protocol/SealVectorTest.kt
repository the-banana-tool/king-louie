package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.spec.ECPrivateKeySpec
import javax.crypto.KeyAgreement

/** ECDH in software from a vector's `d`, standing in for the phone's Keystore key. */
internal fun softwareAgree(d: String): (String, String) -> ByteArray = softwareAgree(B64Url.decode(d))

internal fun softwareAgree(d: ByteArray): (String, String) -> ByteArray = { x, y ->
    val key = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, d), P256.params))
    KeyAgreement.getInstance("ECDH").run {
        init(key)
        doPhase(P256.publicKey(x, y), true)
        generateSecret()
    }
}

/** What opens a vector's sealed message: the phone's box from `given.box`. */
internal fun openerOf(box: JsonElement?): Opener = Seal.opener(box["device_id"].str()!!, softwareAgree(box["d"].str()!!))

/** The seal, against src/approvals/seal.js through the vectors. */
class SealVectorTest {
    private val dir = File(System.getProperty("kl.vectors") ?: error("run through Gradle: kl.vectors is not set"))
    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())
    private fun keys(): JsonElement = JsonText.parse(File(dir, "keys.json").readBytes())
    private val requestType = "kl.approval.request"

    private fun reasonOf(block: () -> Unit): String? = try {
        block()
        null
    } catch (e: SealException) {
        e.reason
    }

    private fun sealedVectors() = dir.listFiles { f -> f.name.startsWith("seal-") && f.name.endsWith(".json") }!!.map { JsonText.parse(it.readBytes()) }

    /** What a phone does with a sealed request: open it, then hold the clear hash to the opened content. */
    private fun run(v: JsonElement): Pair<String?, JsonObject?> = try {
        val box = v["given"]["box"]
        val opened = Seal.open(v["given"]["type"].str()!!, v["input"].obj()!!, box["device_id"].str()!!, softwareAgree(box["d"].str()!!))
        val problem = Messages.validateOpenedRequest(opened)
        if (problem != null) problem to null else null to opened
    } catch (e: SealException) {
        e.reason to null
    }

    @Test
    fun everySealVectorAnswersAsTheNodeDoes() {
        val vectors = sealedVectors()
        assertEquals(8, vectors.size)
        for (v in vectors) {
            val name = v["name"].str()!!
            assertTrue(name, v["consumers"].arr()!!.any { it.str() == "android" })
            val (reason, message) = run(v)
            assertEquals(name, v["expect"]["reason"].str(), reason)
            if (reason == null) assertEquals(name, v["expect"]["message"], message)
        }
        assertEquals(null to vector("seal-open")["expect"]["message"], run(vector("seal-open")))
    }

    @Test
    fun saltedHashIsTheNodes() {
        val m = vector("seal-open")["expect"]["message"]
        assertEquals(m["action_hash"].str(), Seal.saltedHash(m["salt"].str()!!, m["action"]!!))
        assertEquals("malformed", reasonOf { Seal.saltedHash("short", m["action"]!!) })
        assertEquals("malformed", reasonOf { Seal.saltedHash(B64Url.encode(ByteArray(31)), m["action"]!!) })
        // Not the clear rule: the salt is in the hash.
        assertNotEquals(m["action_hash"].str(), Digest.sha256B64url(Jcs.bytes(m["action"]!!)))
    }

    @Test
    fun theSealedShape() {
        val good = vector("seal-open")["input"].obj()!!
        assertTrue(Seal.isSealedShape(requestType, good))
        val sealed = good["sealed"].obj()!!
        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(sealed["epk"]["y"].str()!!)).add(BigInteger.ONE)))
        fun withSealed(key: String, value: JsonElement?): JsonObject =
            JsonObject(good + ("sealed" to JsonObject(if (value == null) sealed - key else sealed + (key to value))))
        val wrap = sealed["keys"].obj()!!.values.first()
        val bad = listOf(
            "not a sealed type" to Seal.isSealedShape("kl.approval.response", JsonObject(good + ("type" to jsonString("kl.approval.response")))),
            "another type" to Seal.isSealedShape("kl.lease.request", good),
            "a key missing" to Seal.isSealedShape(requestType, JsonObject(good - "node_box")),
            "a key too many" to Seal.isSealedShape(requestType, JsonObject(good + ("action" to JsonNull))),
            "v 2" to Seal.isSealedShape(requestType, withSealed("v", jsonNumber("2"))),
            "no epk" to Seal.isSealedShape(requestType, withSealed("epk", null)),
            "an epk off the curve" to Seal.isSealedShape(requestType, withSealed("epk", Messages.jwk(sealed["epk"]["x"].str()!!, offCurve))),
            "an iv of 11" to Seal.isSealedShape(requestType, withSealed("iv", jsonString(B64Url.encode(ByteArray(11))))),
            "a ct under the tag" to Seal.isSealedShape(requestType, withSealed("ct", jsonString(B64Url.encode(ByteArray(15))))),
            "no recipients" to Seal.isSealedShape(requestType, withSealed("keys", JsonObject(emptyMap()))),
            "a recipient that is no id" to Seal.isSealedShape(requestType, withSealed("keys", JsonObject(mapOf("phone" to wrap)))),
            "a wrap of 47" to Seal.isSealedShape(requestType, withSealed("keys", JsonObject(mapOf("d-aaaaaaaaaaaaaaaa" to jsonString(B64Url.encode(ByteArray(47)))))))
        )
        for ((why, accepted) in bad) assertFalse(why, accepted)
    }

    /** The epk is checked before any key agreement, and every failure past that is one answer. */
    @Test
    fun openRefusals() {
        val good = vector("seal-open")["input"].obj()!!
        val sealed = good["sealed"].obj()!!
        val a = keys()["devices"]["A"]["id"].str()!!
        val d = keys()["devices"]["A_box"]["d"].str()!!
        var calls = 0
        val spy: (String, String) -> ByteArray = { x, y -> calls += 1; softwareAgree(d)(x, y) }

        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(sealed["epk"]["y"].str()!!)).add(BigInteger.ONE)))
        val badEpk = JsonObject(good + ("sealed" to JsonObject(sealed + ("epk" to Messages.jwk(sealed["epk"]["x"].str()!!, offCurve)))))
        assertEquals("malformed", reasonOf { Seal.open(requestType, badEpk, a, spy) })
        assertEquals(0, calls)
        assertEquals("not_recipient", reasonOf { Seal.open(requestType, good, "d-aaaaaaaaaaaaaaaa", spy) })
        assertEquals(0, calls)
        assertNotNull(Seal.open(requestType, good, a, spy))
        assertEquals(1, calls)

        // Another phone's box under this id; an agreement of the wrong size; one that throws.
        assertEquals("open_failed", reasonOf { Seal.open(requestType, good, a, softwareAgree(keys()["devices"]["B_box"]["d"].str()!!)) })
        assertEquals("open_failed", reasonOf { Seal.open(requestType, good, a) { _, _ -> ByteArray(31) } })
        assertEquals("open_failed", reasonOf { Seal.open(requestType, good, a) { _, _ -> throw IllegalStateException("no key") } })
        // A locked Keystore is not a wrap that does not open: it passes through for the row's own words.
        try {
            Seal.open(requestType, good, a) { _, _ -> throw SealKeyUnavailableException("locked") }
            fail("expected the key's own refusal")
        } catch (e: SealKeyUnavailableException) {
            assertEquals("locked", e.message)
        }
    }

    /** The sender in the info and the AAD: the device for an answer, the node for all else. */
    @Test
    fun theSenderIdIsBound() {
        val device = keys()["devices"]["A"]["id"].str()!!
        val node = keys()["nodes"]["web-01"]
        val nodeId = node["id"].str()!!
        val nodeBox = node["box"]["jwk"].obj()!!
        val clear = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "type" to jsonString("kl.question.answer"), "node_id" to jsonString(nodeId), "token" to jsonString("7QD4KM"),
                "device_id" to jsonString(device), "nonce" to jsonString("n".repeat(43)), "signed_at" to jsonString("2026-09-23T18:04:11.201Z")
            )
        )
        val content = JsonObject(mapOf("case_id" to jsonString("c-1"), "question_id" to jsonString("q-1"), "answer" to JsonObject(mapOf("text" to jsonString("yes")))))
        val answerType = "kl.question.answer"
        val sealed = Seal.seal(answerType, device, clear, content, nodeId to nodeBox)
        assertTrue(Seal.isSealedShape(answerType, sealed))
        val agree = softwareAgree(node["box"]["d"].str()!!)
        assertEquals(JsonObject(clear + content), Seal.open(answerType, sealed, nodeId, agree))
        // Another device named in the clear part: neither the kek nor the AAD holds.
        val other = keys()["devices"]["B"]["id"].str()!!
        assertEquals("open_failed", reasonOf { Seal.open(answerType, JsonObject(sealed + ("device_id" to jsonString(other))), nodeId, agree) })
        // The sender is the clear part's: the device for an answer.
        assertEquals("malformed", reasonOf { Seal.seal(answerType, nodeId, clear, content, nodeId to nodeBox) })
        // Sealed under another sender than the one a reader takes.
        val askClear = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "type" to jsonString("kl.question.ask"), "node_id" to jsonString(nodeId), "token" to jsonString("7QD4KM"),
                "kind" to jsonString("question"), "urgency" to jsonString("high"), "expires_at" to JsonNull, "node_box" to nodeBox
            )
        )
        val askContent = JsonObject(mapOf("case_id" to jsonString("c-1"), "question_id" to jsonString("q-1"), "case_title" to jsonString("Lakeside lot"), "text" to jsonString("Ok?"), "options" to kotlinx.serialization.json.JsonArray(emptyList())))
        assertEquals("malformed", reasonOf { Seal.seal("kl.question.ask", device, askClear, askContent, nodeId to nodeBox) })
        assertNotNull(Seal.seal("kl.question.ask", nodeId, askClear, askContent, nodeId to nodeBox))
    }

    @Test
    fun sealRefusals() {
        val v = vector("question-answer-sealed")
        val full = v["expect"]["message"].obj()!!
        val type = "kl.question.answer"
        val device = full["device_id"].str()!!
        val node = keys()["nodes"]["web-01"]
        val nodeId = node["id"].str()!!
        val nodeBox = node["box"]["jwk"].obj()!!
        val (clear, content) = Seal.split(type, full)
        assertEquals(setOf("case_id", "question_id", "answer"), content.keys)
        assertNotNull(Seal.seal(type, device, clear, content, nodeId to nodeBox))
        // A key outside the row, the clear part holding `sealed`, a clear key missing, not a sealed type.
        assertEquals("malformed", reasonOf { Seal.seal(type, device, clear, JsonObject(content + ("token" to jsonString("x"))), nodeId to nodeBox) })
        assertEquals("malformed", reasonOf { Seal.seal(type, device, JsonObject(clear + ("sealed" to JsonNull)), content, nodeId to nodeBox) })
        assertEquals("malformed", reasonOf { Seal.seal(type, device, JsonObject(clear - "nonce"), content, nodeId to nodeBox) })
        assertEquals("malformed", reasonOf { Seal.seal("kl.approval.response", device, clear, content, nodeId to nodeBox) })
        // The recipient: an id, and a P-256 JWK on the curve, checked before anything is used.
        assertEquals("malformed", reasonOf { Seal.seal(type, device, clear, content, "web-01" to nodeBox) })
        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(nodeBox["y"].str()!!)).add(BigInteger.ONE)))
        assertEquals("malformed", reasonOf { Seal.seal(type, device, clear, content, nodeId to Messages.jwk(nodeBox["x"].str()!!, offCurve)) })
        assertEquals("malformed", reasonOf { Seal.seal(type, device, clear, content, nodeId to JsonObject(nodeBox + ("kid" to jsonString("x")))) })
    }

    /** Byte for byte: with the vector's ephemeral key and random bytes, the phone's seal is the signed payload. */
    @Test
    fun theAnswerThePhoneSealsIsTheVectorsBytes() {
        val v = vector("question-answer-sealed")
        val envelope = Envelope.fromJson(v["input"]!!)
        val sent = envelope.message()
        fun sha(text: String) = Digest.sha256(text.toByteArray())
        val ephemeral = Seal.Ephemeral(sent["sealed"]["epk"].obj()!!, softwareAgree(sha("sealed answer epk")))
        val (clear, content) = Seal.split("kl.question.answer", v["expect"]["message"].obj()!!)
        val sealed = Seal.sealWith("kl.question.answer", v["given"]["device"]["device_id"].str()!!, clear, content, v["given"]["box"]["node_id"].str()!! to v["given"]["ask"]["node_box"].obj()!!, ephemeral) { n ->
            if (n == 32) sha("sealed answer cek") else sha("sealed answer iv").copyOfRange(0, n)
        }
        assertEquals(sent, sealed)
        assertArrayEquals(envelope.payloadBytes(), Jcs.bytes(sealed))
        // And a reader's fresh seal opens to the same message, with its own ephemeral key.
        val box = v["given"]["box"]
        val fresh = Seal.seal("kl.question.answer", v["given"]["device"]["device_id"].str()!!, clear, content, box["node_id"].str()!! to v["given"]["ask"]["node_box"].obj()!!)
        assertNotEquals(sent["sealed"]["epk"], fresh["sealed"]["epk"])
        assertEquals(v["expect"]["message"], Seal.open("kl.question.answer", fresh, box["node_id"].str()!!, softwareAgree(box["d"].str()!!)))
    }

    /** R-SP-1, R-SP-2: a sealed request shows what the clear one shows, and only to a box that opens it. */
    @Test
    fun aSealedRequestOnTheScreen() {
        val v = vector("request-sealed-display")
        val given = v["given"]
        val pins = given["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        val input = v["input"]!!
        val shown = Display.view(input, pins, openerOf(given["box"]), sealedSeen = emptySet())
        assertEquals(v["expect"], shown.json)
        assertEquals(SealState.OPENED, shown.seal)
        assertEquals(vector("request-display")["expect"]["display"], shown.display)
        // The same clear form as the node validates.
        assertNull(Messages.validate(requestType, Envelope.fromJson(input).message()))
        assertFalse(Envelope.fromJson(input).message().containsKey("action"))

        val hidden = JsonObject(mapOf("shown" to kotlinx.serialization.json.JsonPrimitive(false), "reason" to jsonString("not_recipient"), "display" to JsonNull))
        val noBox = Display.view(input, pins, sealedSeen = emptySet())
        assertEquals(hidden, noBox.json)
        assertEquals(SealState.UNREAD, noBox.seal)
        assertEquals("unpinned_node", Display.view(input, emptyList(), openerOf(given["box"]), sealedSeen = emptySet()).reason)
        // Not a recipient at all: the box key of a device with no wrap here.
        assertEquals("not_recipient", Display.view(input, pins, Seal.opener("d-aaaaaaaaaaaaaaaa", softwareAgree(given["box"]["d"].str()!!)), sealedSeen = emptySet()).reason)
        // A wrap that does not open: another phone's box under this one's id.
        val wrong = Display.view(input, pins, Seal.opener(given["box"]["device_id"].str()!!, softwareAgree(keys()["devices"]["B_box"]["d"].str()!!)), sealedSeen = emptySet())
        assertEquals("open_failed", wrong.reason)
        assertEquals(SealState.UNREAD, wrong.seal)
        assertNull(wrong.display)
        // A response to it is over the hash as received, salted: a phone signs what it signs today.
        val device = given["box"]["device_id"].str()!!
        val response = Messages.responseToOpened(shown.opened!!, "approve", device, "2026-09-23T18:04:31.201Z")
        assertEquals(Envelope.fromJson(input).message()["action_hash"], response["action_hash"])
    }

    /** No decision is signed over what was not opened, or over what opened and did not hold. */
    @Test
    fun aResponseNeedsAnOpenedRequest() {
        val v = vector("request-sealed-display")
        val device = v["given"]["box"]["device_id"].str()!!
        val at = "2026-09-23T18:04:31.201Z"
        val unopened = Envelope.fromJson(v["input"]!!).message()
        fun refuses(block: () -> Unit) = try {
            block()
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // refused before anything is signed
        }
        refuses { Messages.response(unopened, "approve", device, at) }
        refuses { Messages.response(unopened, "deny", device, at) }
        refuses { Messages.responseToOpened(unopened, "approve", device, at) }
        val opened = Seal.open(requestType, unopened, device, softwareAgree(v["given"]["box"]["d"].str()!!))
        assertNotNull(Messages.responseToOpened(opened, "deny", device, at))
        val action = opened["action"].obj()!!
        refuses { Messages.responseToOpened(JsonObject(opened + ("action" to JsonObject(action + ("summary" to jsonString("other"))))), "approve", device, at) }
        // A clear request has no opened form, and its own answer is as it was.
        val clear = Envelope.fromJson(vector("request-valid")["input"]!!).message()
        refuses { Messages.responseToOpened(clear, "approve", device, at) }
        assertNotNull(Messages.response(clear, "approve", device, at))
        // Only what was opened is handed to the screen.
        val pins = v["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        assertNull(Display.view(v["input"]!!, pins, sealedSeen = emptySet()).opened)
        val clearPins = vector("request-valid")["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        assertNull(Display.view(vector("request-valid")["input"]!!, clearPins, sealedSeen = emptySet()).opened)
    }

    /** The phone's box key will not act: no decision, for a reason that passes. Its signature held, so it marks the node as any sealed message does. */
    @Test
    fun aLockedPhoneAndARequest() {
        val v = vector("request-sealed-display")
        val pins = v["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        val locked = Seal.opener(v["given"]["box"]["device_id"].str()!!) { _, _ -> throw SealKeyUnavailableException("locked") }
        val view = Display.view(v["input"]!!, pins, locked, sealedSeen = emptySet())
        assertFalse(view.shown)
        assertEquals("key_locked", view.reason)
        assertEquals(SealState.UNREAD, view.seal)
        assertNull(view.display)
        assertEquals(setOf(pins[0].id), Seal.noteSealedSeen(emptySet(), pins[0].id, view.seal))
    }

    @Test
    fun aLockedPhoneAndAQuestion() {
        val v = vector("question-ask-sealed")
        val locked = Seal.opener(v["given"]["box"]["device_id"].str()!!) { _, _ -> throw SealKeyUnavailableException("locked") }
        val item = QuestionItem.from(Envelope.fromJson(v["input"]!!).message(), "web-01", locked, sealedSeen = emptySet())!!
        assertEquals("key_locked", item.unreadable)
        assertEquals(SealState.UNREAD, item.seal)
        assertEquals("", item.text)
        try {
            Questions.answer(item, "a", null, v["given"]["box"]["device_id"].str()!!, "n".repeat(43), "2026-09-23T18:04:11.201Z")
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // no answer offered
        }
    }

    /** Sealed by hand, as a sender that does not follow the format: the plaintext is whatever it is given. */
    private fun handSealed(type: String, clear: JsonObject, senderId: String, plaintext: ByteArray): JsonObject {
        val recipient = keys()["devices"]["A"]["id"].str()!!
        val box = keys()["devices"]["A_box"]["jwk"]!!
        val pair = java.security.KeyPairGenerator.getInstance("EC").run { initialize(java.security.spec.ECGenParameterSpec("secp256r1")); generateKeyPair() }
        val w = (pair.public as java.security.interfaces.ECPublicKey).w
        val secret = KeyAgreement.getInstance("ECDH").run {
            init(pair.private)
            doPhase(P256.publicKey(box["x"].str()!!, box["y"].str()!!), true)
            generateSecret()
        }
        fun hmac(key: ByteArray, data: ByteArray) = javax.crypto.Mac.getInstance("HmacSHA256").run { init(javax.crypto.spec.SecretKeySpec(key, "HmacSHA256")); doFinal(data) }
        val kek = hmac(hmac(ByteArray(32), secret), "kl-seal-v1\n$type\n$senderId\n$recipient".toByteArray() + byteArrayOf(1))
        fun gcm(key: ByteArray, iv: ByteArray, input: ByteArray, aad: ByteArray?) = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").run {
            init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, iv))
            if (aad != null) updateAAD(aad)
            doFinal(input)
        }
        val cek = ByteArray(32) { 7 }
        val iv = ByteArray(12) { 9 }
        val sealed = JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "epk" to Messages.jwk(B64Url.encode(P256.coordinate(w.affineX)), B64Url.encode(P256.coordinate(w.affineY))),
                "iv" to jsonString(B64Url.encode(iv)), "ct" to jsonString(B64Url.encode(gcm(cek, iv, plaintext, Jcs.bytes(clear)))),
                "keys" to JsonObject(mapOf(recipient to jsonString(B64Url.encode(gcm(kek, ByteArray(12), cek, null)))))
            )
        )
        return JsonObject(clear + ("sealed" to sealed))
    }

    private fun signedByWeb(message: JsonObject): Envelope {
        val key = KeyFactory.getInstance("Ed25519").generatePrivate(
            java.security.spec.EdECPrivateKeySpec(java.security.spec.NamedParameterSpec.ED25519, Hex.decode(keys()["nodes"]["web-01"]["seed"].str()!!))
        )
        return Envelope.seal(message, message["node_id"].str()!!, "Ed25519") { bytes -> java.security.Signature.getInstance("Ed25519").run { initSign(key); update(bytes); sign() } }
    }

    /** content_malformed, signed by the pinned node, through every reader: a decision is refused; a status keeps its clear part. */
    @Test
    fun contentMalformedThroughEveryReader() {
        val leaseDir = File(System.getProperty("kl.leaseVectors") ?: error("kl.leaseVectors is not set"))
        fun leaseVector(name: String) = JsonText.parse(File(leaseDir, "$name.json").readBytes())
        val web = keys()["nodes"]["web-01"]
        val pin = NodePin(web["id"].str()!!, "web-01", web["spki"].str()!!)
        val a = keys()["devices"]["A"]["id"].str()!!
        val d = keys()["devices"]["A_box"]["d"].str()!!
        val open = Seal.opener(a, softwareAgree(d))
        // JSON with the right kind of key, but not the JCS bytes.
        val notJcs = "{ \"name\": null }".toByteArray()
        fun malformed(type: String, input: JsonElement): JsonObject {
            val clear = JsonObject(Envelope.fromJson(input).message() - "sealed")
            val message = handSealed(type, clear, web["id"].str()!!, notJcs)
            assertEquals(type, "content_malformed", reasonOf { Seal.open(type, message, a, softwareAgree(d)) })
            return message
        }

        val request = malformed(requestType, vector("request-sealed-display")["input"]!!)
        val shown = Display.view(signedByWeb(request).json, listOf(pin), open, sealedSeen = emptySet())
        assertEquals("malformed", shown.reason)
        assertFalse(shown.shown)
        assertNull(shown.display)
        assertEquals(SealState.UNREAD, shown.seal)

        val lease = LeaseRequest.check(malformed("kl.lease.request", leaseVector("request-sealed")["input"]!!), open, sealedSeen = emptySet())
        assertEquals("malformed", lease.reason)
        assertNull(lease.request)
        assertEquals(SealState.UNREAD, lease.seal)

        val status = LeaseStatus.from(malformed("kl.lease.status", leaseVector("status-sealed")["input"]!!), open)!!
        assertEquals(SealState.UNREAD, status.seal)
        assertNull(status.name)
        assertEquals("active", status.state)

        val view = Leases.verifyView(signedByWeb(malformed("kl.lease.view", leaseVector("view-sealed")["input"]!!)), pin, open)
        assertFalse(view.accepted)
        assertEquals("malformed", view.reason)
        assertNull(view.view)

        assertNull(QuestionItem.from(malformed("kl.question.ask", vector("question-ask-sealed")["input"]!!), "web-01", open, sealedSeen = emptySet()))
    }

    /** The pad: every sealer's length is a whole number of 256-byte blocks; an opener takes only spaces, and strips them. */
    @Test
    fun thePad() {
        val a = keys()["devices"]["A"]["id"].str()!!
        val d = keys()["devices"]["A_box"]["d"].str()!!
        val v = vector("seal-open")
        val full = v["expect"]["message"].obj()!!
        val (clear, content) = Seal.split(requestType, full)
        val sender = full["node_id"].str()!!
        fun sealedWith(fields: JsonObject) = handSealed(requestType, clear, sender, Jcs.bytes(fields))
        fun withPad(pad: JsonElement) = JsonObject(content + ("pad" to pad))

        assertEquals(full, Seal.open(requestType, sealedWith(content), a, softwareAgree(d)))
        for (n in listOf(0, 1, 255, 1000)) {
            val opened = Seal.open(requestType, sealedWith(withPad(jsonString(" ".repeat(n)))), a, softwareAgree(d))
            assertEquals(full, opened)
            assertFalse(opened.containsKey("pad"))
        }
        val bad = listOf(jsonString("x"), jsonString(" x "), jsonString("\t"), jsonString("\n"), jsonString("\u00a0"), jsonString("\u3000"), jsonNumber("1"), JsonNull, kotlinx.serialization.json.JsonPrimitive(true), kotlinx.serialization.json.JsonArray(listOf(jsonString(" "))), JsonObject(mapOf("a" to jsonString(" "))))
        for (pad in bad) assertEquals(pad.toString(), "content_malformed", reasonOf { Seal.open(requestType, sealedWith(withPad(pad)), a, softwareAgree(d)) })
        // Every other key is refused as it always was, a pad or no pad beside it.
        for (key in listOf("padding", "Pad", "PAD", "pad ", "node_name", "extra")) {
            assertEquals(key, "content_malformed", reasonOf { Seal.open(requestType, sealedWith(JsonObject(withPad(jsonString("")) + (key to jsonString(" ")))), a, softwareAgree(d)) })
        }
        // Pad bytes outside JCS order are refused too.
        val outOfOrder = (String(Jcs.bytes(content), Charsets.UTF_8).dropLast(1) + ",\"pad\":\" \"}").toByteArray()
        assertEquals("content_malformed", reasonOf { Seal.open(requestType, handSealed(requestType, clear, sender, outOfOrder), a, softwareAgree(d)) })

        // A sender cannot pass its own; two answers of different lengths seal to one length.
        val answer = vector("question-answer-sealed")
        val answerFull = answer["expect"]["message"].obj()!!
        val device = answerFull["device_id"].str()!!
        val node = keys()["nodes"]["web-01"]
        val nodeTo = node["id"].str()!! to node["box"]["jwk"].obj()!!
        val (answerClear, answerContent) = Seal.split("kl.question.answer", answerFull)
        assertEquals("malformed", reasonOf { Seal.seal("kl.question.answer", device, answerClear, JsonObject(answerContent + ("pad" to jsonString(" "))), nodeTo) })
        fun ctOf(option: String) = B64Url.decode(Seal.seal("kl.question.answer", device, answerClear, JsonObject(answerContent + ("answer" to JsonObject(mapOf("option_id" to jsonString(option))))), nodeTo)["sealed"]["ct"].str()!!).size
        assertEquals(ctOf("approve"), ctOf("refuse"))
        assertEquals(256 + TAG, ctOf("approve"))
        // An exact fit takes an empty pad, and one byte more the next block.
        var longest = 0
        for (n in 0 until 520) {
            val text = "\u20ac".repeat(n % 3) + "x".repeat(n)
            val sealed = Seal.seal("kl.question.answer", device, answerClear, JsonObject(answerContent + ("answer" to JsonObject(mapOf("text" to jsonString(text))))), nodeTo)
            val size = B64Url.decode(sealed["sealed"]["ct"].str()!!).size - TAG
            assertEquals(0, size % 256)
            longest = maxOf(longest, size)
        }
        assertTrue(longest >= 512)
        // Every sealed vector a sealer built is padded.
        val ct = Envelope.fromJson(vector("request-sealed-display")["input"]!!).message()["sealed"]["ct"].str()!!
        assertEquals(0, (B64Url.decode(ct).size - TAG) % 256)
        assertEquals(0, (B64Url.decode(v["input"]["sealed"]["ct"].str()!!).size - TAG) % 256)
    }

    private val TAG = 16

    /** What the node holds an ask to, sealed: in clear before anything opens, and inside after. */
    @Test
    fun aSealedAskIsHeldToTheNodesRules() {
        val v = vector("question-ask-sealed")
        val box = v["given"]["box"]
        val message = Envelope.fromJson(v["input"]!!).message()
        val open = openerOf(box)
        fun read(m: JsonObject) = QuestionItem.from(m, "web-01", open, sealedSeen = emptySet())
        assertNotNull(read(message))
        assertNull("v 2", read(JsonObject(message + ("v" to jsonNumber("2")))))
        assertNull("a token outside the alphabet", read(JsonObject(message + ("token" to jsonString("7qd4km")))))
        assertNull("a token of five", read(JsonObject(message + ("token" to jsonString("7QD4K")))))
        assertNull("the letter I is not in tokens", read(JsonObject(message + ("token" to jsonString("7QD4KI")))))
        val full = v["expect"]["message"].obj()!!
        val a = keys()["devices"]["A"]
        fun opened(change: JsonObject): QuestionItem? {
            val (clear, content) = Seal.split("kl.question.ask", change)
            return read(Seal.seal("kl.question.ask", full["node_id"].str()!!, clear, content, a["id"].str()!! to keys()["devices"]["A_box"]["jwk"].obj()!!))
        }
        assertNotNull(opened(full))
        assertNull("a case id with a space", opened(JsonObject(full + ("case_id" to jsonString("a b")))))
        assertNull("a case id of 81", opened(JsonObject(full + ("case_id" to jsonString("a".repeat(81))))))
        assertNull("no case id", opened(JsonObject(full - "case_id")))
        assertNull("a question id without q-", opened(JsonObject(full + ("question_id" to jsonString("0012")))))
        assertNull("a question id of three digits", opened(JsonObject(full + ("question_id" to jsonString("q-012")))))
        assertNull("options that are no list", opened(JsonObject(full + ("options" to jsonString("a")))))
        assertNull("no case title", opened(JsonObject(full - "case_title")))
    }

    /** An answer goes to the ask's own box and no other. */
    @Test
    fun anAnswerGoesToTheAsksOwnBox() {
        val v = vector("question-ask-sealed")
        val item = QuestionItem.from(Envelope.fromJson(v["input"]!!).message(), "web-01", openerOf(v["given"]["box"]), sealedSeen = emptySet())!!
        val device = v["given"]["box"]["device_id"].str()!!
        val otherBox = keys()["devices"]["B_box"]["jwk"].obj()!!
        try {
            Questions.answer(item, "a", null, device, "n".repeat(43), "2026-09-23T18:04:11.201Z", sealTo = otherBox)
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // refused before anything is signed
        }
        assertNotNull(Questions.answer(item, "a", null, device, "n".repeat(43), "2026-09-23T18:04:11.201Z", sealTo = item.nodeBox))
    }

    /** A failed signature, an unpinned node, a misshapen message: nothing is opened. */
    @Test
    fun theSignatureComesBeforeTheOpen() {
        val v = vector("request-sealed-display")
        val pin = v["given"]["pinned_nodes"].arr()!![0]
        var calls = 0
        val opener: Opener = { t, m -> calls += 1; openerOf(v["given"]["box"])(t, m) }
        val input = v["input"]!!
        val otherKey = keys()["nodes"]["gpu-box"]["spki"].str()!!
        assertEquals("bad_node_signature", Display.view(input, listOf(NodePin(pin["id"].str()!!, "", otherKey)), opener, sealedSeen = emptySet()).reason)
        assertEquals("unpinned_node", Display.view(input, emptyList(), opener, sealedSeen = emptySet()).reason)
        val garbled = Envelope.fromJson(input).run { copy(payload = B64Url.encode("{\"sealed\":{}}".toByteArray())) }
        assertEquals("malformed", Display.view(garbled.json, listOf(NodePin(pin["id"].str()!!, "", pin["key"].str()!!)), opener, sealedSeen = emptySet()).reason)
        assertEquals(0, calls)
        assertTrue(Display.view(input, listOf(NodePin(pin["id"].str()!!, "", pin["key"].str()!!)), opener, sealedSeen = emptySet()).shown)
        assertEquals(1, calls)
    }

    /** What content cannot be, signed by the pinned node and opened: `malformed` on the screen, as the reference says. */
    @Test
    fun aHashThatDoesNotHoldIsRefusedBeforeAnythingIsShown() {
        val v = vector("request-sealed-display")
        val message = Envelope.fromJson(v["input"]!!).message()
        val opened = Seal.open(requestType, message, v["given"]["box"]["device_id"].str()!!, softwareAgree(v["given"]["box"]["d"].str()!!))
        assertNull(Messages.validateOpenedRequest(opened))
        val action = opened["action"].obj()!!
        val changed = JsonObject(opened + ("action" to JsonObject(action + ("summary" to jsonString("other")))))
        assertEquals("action_hash_mismatch", Messages.validateOpenedRequest(changed))
        // What the clear shape would refuse, inside.
        assertEquals("malformed", Messages.validateOpenedRequest(JsonObject(opened - "origin")))
        assertEquals("malformed", Messages.validateOpenedRequest(JsonObject(opened + ("salt" to jsonString("short")))))
        assertEquals("malformed", Messages.validateOpenedRequest(JsonObject(opened - "node_box")))
        // A clear request is not an opened one: it has no salt and no node_box.
        assertEquals("malformed", Messages.validateOpenedRequest(Envelope.fromJson(vector("request-valid")["input"]!!).message()))
    }

    /** R-SP-2 on the screen: the vector's bytes signed by the pinned node, opened, and its hash does not hold. Nothing shows, and nothing is there to answer. */
    @Test
    fun aHashMismatchOnTheScreen() {
        val web = keys()["nodes"]["web-01"]
        val pin = NodePin(web["id"].str()!!, "web-01", web["spki"].str()!!)
        val v = vector("seal-hash-mismatch")
        assertEquals("action_hash_mismatch", v["expect"]["reason"].str())
        val view = Display.view(signedByWeb(v["input"].obj()!!).json, listOf(pin), openerOf(v["given"]["box"]), sealedSeen = emptySet())
        assertFalse(view.shown)
        assertEquals("action_hash_mismatch", view.reason)
        assertNull(view.display)
        assertNull(view.opened)
    }

    /** R-SP-15: once a node was seen sealing, its clear request is unreadable and offers no decision. */
    @Test
    fun aClearRequestAfterSealedIsUnreadable() {
        val clear = vector("request-valid")
        val pins = clear["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        assertEquals("clear_after_sealed", Seal.CLEAR_AFTER_SEALED)
        val seen = setOf(keys()["nodes"]["web-01"]["id"].str()!!)
        val refused = Display.view(clear["input"]!!, pins, sealedSeen = seen)
        assertFalse(refused.shown)
        assertEquals("clear_after_sealed", refused.reason)
        assertNull(refused.display)
        // Not seen sealing: byte for byte what it was.
        assertEquals(clear["expect"], Display.view(clear["input"]!!, pins, sealedSeen = emptySet()).json)
        // Another node seen sealing says nothing of this one.
        assertEquals(clear["expect"], Display.view(clear["input"]!!, pins, sealedSeen = setOf("kl-aaaaaaaaaaaaaaaa")).json)
        assertEquals(clear["expect"], Display.view(clear["input"]!!, pins, sealedSeen = emptySet()).json)
        assertEquals(SealState.CLEAR, Display.view(clear["input"]!!, pins, sealedSeen = emptySet()).seal)
        // The signature and the pin still come first: nothing unverified earns the words.
        assertEquals("unpinned_node", Display.view(clear["input"]!!, emptyList(), sealedSeen = seen).reason)
        val bad = vector("request-bad-node-signature")
        assertEquals("bad_node_signature", Display.view(bad["input"]!!, bad["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }, sealedSeen = seen).reason)
        // A sealed one goes on being shown.
        val sealed = vector("request-sealed-display")
        val sealedPins = sealed["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
        assertTrue(Display.view(sealed["input"]!!, sealedPins, openerOf(sealed["given"]["box"]), sealedSeen = seen).shown)
    }

    /** The rule for one node: a verified sealed message marks it, opened or not, for good; nothing else does; types not listed are not held to it. */
    @Test
    fun theSealedSeenRule() {
        val node = "kl-aaaaaaaaaaaaaaaa"
        val other = "kl-bbbbbbbbbbbbbbbb"
        var seen = emptySet<String>()
        seen = Seal.noteSealedSeen(seen, node, SealState.CLEAR)
        assertEquals(emptySet<String>(), seen)
        assertEquals(setOf(node), Seal.noteSealedSeen(seen, node, SealState.UNREAD))
        seen = Seal.noteSealedSeen(seen, node, SealState.OPENED)
        assertEquals(setOf(node), seen)
        seen = Seal.noteSealedSeen(seen, node, SealState.CLEAR)
        assertEquals(setOf(node), seen)
        assertFalse(other in seen)

        val clearAsk = JsonObject(mapOf("type" to jsonString("kl.question.ask"), "node_id" to jsonString(node)))
        for (type in listOf("kl.question.ask", "kl.approval.request", "kl.lease.request")) {
            assertTrue(type, Seal.clearRefused(type, clearAsk, seen))
            assertFalse(type, Seal.clearRefused(type, clearAsk, emptySet()))
            assertFalse(type, Seal.clearRefused(type, clearAsk, setOf(other)))
            assertFalse(type, Seal.clearRefused(type, JsonObject(clearAsk + ("sealed" to JsonNull)), seen))
            assertFalse(type, Seal.clearRefused(type, JsonObject(clearAsk - "node_id"), seen))
        }
        for (type in listOf("kl.lease.status", "kl.lease.view", "kl.approval.status", "kl.lease.listing")) assertFalse(type, Seal.clearRefused(type, clearAsk, seen))
    }

    /** L-3: every reader says UNREAD past the signature with no way to open, and CLEAR for what is not verified or not in shape. */
    @Test
    fun whatMarksANodeThroughTheReaders() {
        val web = keys()["nodes"]["web-01"]
        val pin = NodePin(web["id"].str()!!, "web-01", web["spki"].str()!!)
        fun marks(state: SealState) = Seal.noteSealedSeen(emptySet(), pin.id, state) == setOf(pin.id)
        val leaseDir = File(System.getProperty("kl.leaseVectors") ?: error("kl.leaseVectors is not set"))
        fun leaseVector(name: String) = JsonText.parse(File(leaseDir, "$name.json").readBytes())
        val request = vector("request-sealed-display")["input"]!!

        assertEquals(SealState.UNREAD, Display.view(request, listOf(pin), sealedSeen = emptySet()).seal)
        assertTrue(marks(QuestionItem.from(Envelope.fromJson(vector("question-ask-sealed")["input"]!!).message(), "web-01", sealedSeen = emptySet())!!.seal))
        assertTrue(marks(LeaseRequest.check(Envelope.fromJson(leaseVector("request-sealed")["input"]!!).message(), sealedSeen = emptySet()).seal))
        assertTrue(marks(LeaseStatus.from(Envelope.fromJson(leaseVector("status-sealed")["input"]!!).message())!!.seal))
        assertTrue(marks(Leases.verifyView(Envelope.fromJson(leaseVector("view-sealed")["input"]!!), pin).view!!.seal))
        assertTrue(marks(Display.view(request, listOf(pin), Seal.opener("d-aaaaaaaaaaaaaaaa", softwareAgree(keys()["devices"]["A_box"]["d"].str()!!)), sealedSeen = emptySet()).seal))

        // Unverified, unpinned, or misshapen: nothing.
        val other = NodePin(pin.id, "web-01", keys()["nodes"]["gpu-box"]["spki"].str()!!)
        assertFalse(marks(Display.view(request, listOf(other), sealedSeen = emptySet()).seal))
        assertFalse(marks(Display.view(request, emptyList(), sealedSeen = emptySet()).seal))
        val noBox = JsonObject(Envelope.fromJson(request).message() - "node_box")
        assertFalse(marks(Display.view(signedByWeb(noBox).json, listOf(pin), sealedSeen = emptySet()).seal))
        assertFalse(marks(LeaseRequest.check(noBox, sealedSeen = emptySet()).seal))
        // A clear message from a node never marks it.
        val clear = vector("request-valid")
        assertFalse(marks(Display.view(clear["input"]!!, clear["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }, sealedSeen = emptySet()).seal))
    }

    // ---- the box key (R-SP-10) ----

    @Test
    fun boxKeyFingerprint() {
        for (name in listOf("A_box", "B_box")) {
            val k = keys()["devices"][name]!!
            assertEquals(name, k["fingerprint"].str(), Messages.boxKeyFingerprint(k["jwk"]!!))
            assertEquals(name, k["fingerprint"].str(), Messages.boxKeyFingerprint(k["jwk"]["x"].str()!!, k["jwk"]["y"].str()!!))
        }
        val jwk = keys()["devices"]["A_box"]["jwk"]!!
        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(jwk["y"].str()!!)).add(BigInteger.ONE)))
        try {
            Messages.boxKeyFingerprint(Messages.jwk(jwk["x"].str()!!, offCurve))
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // not a P-256 point
        }
    }

    @Test
    fun consoleEnrollWithBoxKey() {
        val v = vector("enroll-console-box-key")
        val sent = Envelope.fromJson(v["input"]!!).message()
        val d = sent["device"]!!
        val boxKey = v["expect"]["box_key"].obj()!!
        val device = Messages.device(d["device_id"].str()!!, d["name"].str()!!, d["platform"].str()!!, d["public_key"]["x"].str()!!, d["public_key"]["y"].str()!!, boxKey = boxKey)
        assertEquals(d, device)
        val rebuilt = Messages.consoleEnroll(device, v["given"]["code_id"].str()!!, v["given"]["code"].str()!!, sent["created_at"].str()!!, sent["expires_at"].str()!!, sent["nonce"].str()!!)
        assertEquals(v["input"]["payload"].str(), B64Url.encode(Jcs.bytes(rebuilt)))
        val a = keys()["devices"]["A"]!!
        assertTrue(Envelope.fromJson(v["input"]!!).verifyEs256(a["jwk"]["x"].str()!!, a["jwk"]["y"].str()!!))

        val id = a["id"].str()!!
        val x = a["jwk"]["x"].str()!!
        val y = a["jwk"]["y"].str()!!
        val readKey = keys()["devices"]["A_read"]["jwk"].obj()!!
        // The device id still derives from the device key; all three together are allowed.
        val all = Messages.device(id, "Phone", "android", x, y, readKey, boxKey)
        assertEquals(setOf("device_id", "name", "platform", "public_key", "read_key", "box_key"), all.keys)
        assertEquals(setOf("device_id", "name", "platform", "public_key"), Messages.device(id, "Phone", "android", x, y).keys)
        // No key is another: the box key is not the device key, nor the read key.
        fun refuses(block: () -> Unit) = try {
            block()
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // refused before anything is signed
        }
        refuses { Messages.device(id, "Phone", "android", x, y, boxKey = Messages.jwk(x, y)) }
        refuses { Messages.device(id, "Phone", "android", x, y, readKey, readKey) }
        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(boxKey["y"].str()!!)).add(BigInteger.ONE)))
        refuses { Messages.device(id, "Phone", "android", x, y, boxKey = Messages.jwk(boxKey["x"].str()!!, offCurve)) }
    }

    @Test
    fun boxKeyStatement() {
        val v = vector("box-key-valid")
        val envelope = Envelope.fromJson(v["input"].arr()!![0])
        val sent = envelope.message()
        val boxKey = v["expect"]["staged_box_keys"].arr()!![0].obj()!!
        val id = sent["device_id"].str()!!
        val nonce = sent["nonce"].str()!!
        val built = Messages.boxKeyStatement(id, boxKey, sent["created_at"].str()!!, sent["expires_at"].str()!!, nonce)
        assertEquals(sent, built)
        assertArrayEquals(envelope.payloadBytes(), Jcs.bytes(built))
        assertNull(Messages.validate("kl.device.box_key", built))
        val a = keys()["devices"]["A"]!!
        assertEquals(a["id"].str(), envelope.kid)
        assertTrue(envelope.verifyEs256(a["jwk"]["x"].str()!!, a["jwk"]["y"].str()!!))

        Messages.boxKeyStatement(id, boxKey, "2026-09-23T18:04:11.201Z", "2026-09-30T18:04:11.201Z", nonce)
        fun refuses(block: () -> Unit) = try {
            block()
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // a node would refuse it as malformed
        }
        refuses { Messages.boxKeyStatement(id, boxKey, "2026-09-23T18:04:11.201Z", "2026-09-30T18:04:11.202Z", nonce) }
        refuses { Messages.boxKeyStatement(id, boxKey, "2026-09-23T18:04:11.201Z", "2026-09-23T18:04:11.201Z", nonce) }
        refuses { Messages.boxKeyStatement("d-not-a-device", boxKey, "2026-09-23T18:04:11.201Z", "2026-09-24T18:04:11.201Z", nonce) }
        refuses { Messages.boxKeyStatement(id, JsonObject(emptyMap()), "2026-09-23T18:04:11.201Z", "2026-09-24T18:04:11.201Z", nonce) }
        assertEquals("malformed", Messages.validate("kl.device.box_key", JsonObject(built + ("extra" to JsonNull))))
        assertEquals("unsupported_version", Messages.validate("kl.device.box_key", JsonObject(built + ("v" to jsonNumber("2")))))
    }

    // ---- questions (R-SP-4) ----

    @Test
    fun aSealedAsk() {
        val v = vector("question-ask-sealed")
        val envelope = Envelope.fromJson(v["input"]!!)
        assertTrue(envelope.verifyEd25519(v["given"]["node_public_key"].str()!!))
        val message = envelope.message()
        for (key in listOf("case_id", "question_id", "case_title", "text", "options")) assertFalse(key, message.containsKey(key))
        val box = v["given"]["box"]
        val expect = v["expect"]["message"]!!
        assertEquals(expect, Seal.open("kl.question.ask", message, box["device_id"].str()!!, softwareAgree(box["d"].str()!!)))

        val item = QuestionItem.from(message, "web-01", openerOf(box), sealedSeen = emptySet())!!
        assertEquals(expect["text"].str(), item.text)
        assertEquals(expect["case_id"].str(), item.caseId)
        assertEquals(expect["question_id"].str(), item.questionId)
        assertEquals(expect["case_title"].str(), item.caseTitle)
        assertEquals(listOf(QuestionOption("a", "Yes"), QuestionOption("b", "No")), item.options)
        assertEquals(expect["node_box"], item.nodeBox)
        assertEquals(SealState.OPENED, item.seal)
        assertNull(item.unreadable)

        // Not this phone's to open: the clear facts and no question.
        val unread = QuestionItem.from(message, "web-01", sealedSeen = emptySet())!!
        assertEquals("not_recipient", unread.unreadable)
        assertEquals(SealState.UNREAD, unread.seal)
        assertEquals("web-01", unread.nodeName)
        assertEquals("question", unread.kind)
        assertEquals("high", unread.urgency)
        assertEquals("", unread.text)
        assertEquals(emptyList<QuestionOption>(), unread.options)
        assertEquals("open_failed", QuestionItem.from(message, "web-01", Seal.opener(box["device_id"].str()!!, softwareAgree(keys()["devices"]["B_box"]["d"].str()!!)), sealedSeen = emptySet())!!.unreadable)
        // Nothing can be answered from it.
        try {
            Questions.answer(unread, "a", null, box["device_id"].str()!!, "n".repeat(43), "2026-09-23T18:04:11.201Z")
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // no answer offered
        }
        // A message claiming to be sealed in another shape is not read at all.
        assertNull(QuestionItem.from(JsonObject(message - "node_box"), "web-01", openerOf(box), sealedSeen = emptySet()))
    }

    /** The whole answer of given.ask and given.answer, sealed to the ask's node_box without the caller asking for it. */
    @Test
    fun aSealedAnswer() {
        val ask = vector("question-ask-sealed")
        val item = QuestionItem.from(Envelope.fromJson(ask["input"]!!).message(), "web-01", openerOf(ask["given"]["box"]), sealedSeen = emptySet())!!
        val v = vector("question-answer-sealed")
        val g = v["given"]
        val device = g["device"]["device_id"].str()!!
        val built = Questions.answer(item, g["answer"]["option_id"].str(), null, device, g["nonce"].str()!!, g["signed_at"].str()!!)
        assertTrue(Seal.isSealedShape("kl.question.answer", built))
        for (key in listOf("case_id", "question_id", "answer")) assertFalse(key, built.containsKey(key))
        assertEquals(setOf(g["box"]["node_id"].str()), built["sealed"]["keys"].obj()!!.keys)
        assertEquals(0, (B64Url.decode(built["sealed"]["ct"].str()!!).size - 16) % 256)
        val clearOfVector = JsonObject(Envelope.fromJson(v["input"]!!).message() - "sealed")
        assertEquals(clearOfVector, JsonObject(built - "sealed"))
        assertEquals(v["expect"]["message"], Seal.open("kl.question.answer", built, g["box"]["node_id"].str()!!, softwareAgree(g["box"]["d"].str()!!)))
        // Signed like any answer, over its canonical bytes.
        val a = keys()["devices"]["A"]!!
        assertTrue(Envelope.fromJson(v["input"]!!).verifyEs256(a["jwk"]["x"].str()!!, a["jwk"]["y"].str()!!))
        assertEquals(Jcs.serialize(built), String(Jcs.bytes(built), Charsets.UTF_8))

        // A sealed ask is never answered in clear.
        try {
            Questions.answer(item, "a", null, device, g["nonce"].str()!!, g["signed_at"].str()!!, sealTo = null)
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // refused before anything is signed
        }
    }
}
