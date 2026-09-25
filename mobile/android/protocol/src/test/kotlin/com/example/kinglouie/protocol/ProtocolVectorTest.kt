package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.security.spec.EdECPrivateKeySpec
import java.security.spec.NamedParameterSpec
import java.time.Instant

/** Every approval-v1 vector whose consumers include "android" (shared with the node and iOS). */
class ProtocolVectorTest {
    private val dir = File(System.getProperty("kl.vectors") ?: error("run through Gradle: kl.vectors is not set"))

    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())

    private fun keys(): JsonElement = JsonText.parse(File(dir, "keys.json").readBytes())

    private fun throwsProtocol(block: () -> Unit) {
        try {
            block()
        } catch (e: ProtocolException) {
            return
        }
        fail("expected a ProtocolException")
    }

    private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))

    /** A published test key from keys.json (tests only). */
    private fun nodeKey(name: String): PrivateKey {
        val seed = Hex.decode(keys()["nodes"][name]["seed"].str()!!)
        return KeyFactory.getInstance("Ed25519").generatePrivate(EdECPrivateKeySpec(NamedParameterSpec.ED25519, seed))
    }

    private fun deviceKey(name: String): PrivateKey {
        val d = BigInteger(1, B64Url.decode(keys()["devices"][name]["d"].str()!!))
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, P256.params))
    }

    private fun sealEd25519(message: JsonElement, kid: String, key: PrivateKey): Envelope =
        Envelope.seal(message, kid, "Ed25519") { bytes -> Signature.getInstance("Ed25519").run { initSign(key); update(bytes); sign() } }

    @Test
    fun everyAndroidVectorIsCovered() {
        // The vector set has no fixed size (approval-v1 §9); the Android set is exact.
        val names = dir.listFiles { f -> f.name.endsWith(".json") && f.name != "keys.json" }!!
            .map { JsonText.parse(it.readBytes()) }
            .filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }
            .map { it["name"].str() }
            .toSet()
        assertEquals(
            setOf("jcs", "device-id-p256", "device-id-ed25519", "request-valid", "request-bad-node-signature",
                "request-unpinned-node", "request-malformed", "request-display", "request-display-edge",
                "enroll-console", "audit-slice", "phone-api-auth"),
            names
        )
    }

    @Test
    fun jcs() {
        val v = vector("jcs")
        val cases = v["input"]["cases"].arr()!!
        val expected = v["expect"]["canonical"].arr()!!
        assertEquals(expected.size, cases.size)
        cases.zip(expected).forEach { (c, e) -> assertEquals(e.str(), Jcs.serialize(c)) }
    }

    @Test
    fun deviceIds() {
        val p = vector("device-id-p256")
        val ids = p["input"]["jwks"].arr()!!.map { Identifiers.deviceId(it["x"].str()!!, it["y"].str()!!) }
        assertEquals(p["expect"]["device_ids"].arr()!!.map { it.str() }, ids)
        assertEquals(p["expect"]["grouped"].arr()!!.map { it.str() }, ids.map { Identifiers.fingerprintGroups(it) })
        val e = vector("device-id-ed25519")
        assertEquals(e["expect"]["device_id"].str(), Identifiers.deviceId(B64Url.decode(e["input"]["raw"].str()!!), e["input"]["prefix"].str()!!))
    }

    @Test
    fun es256RefusesDerSignaturesAndOffCurveKeys() {
        val v = vector("phone-api-auth")
        val g = v["given"]!!
        val x = g["device"]["jwk"]["x"].str()!!
        val y = g["device"]["jwk"]["y"].str()!!
        val s = Messages.phoneAuthString(g["method"].str()!!, g["path"].str()!!, g["timestamp"].str()!!, g["body"].str()!!.toByteArray())
        val raw = B64Url.decode(v["input"]["signature"].str()!!)
        val good = Envelope("ES256", g["device"]["device_id"].str()!!, B64Url.encode(s.toByteArray()), B64Url.encode(raw))
        assertTrue(good.verifyEs256(x, y))
        // The same signature in DER is refused, never reinterpreted.
        assertFalse(good.copy(sig = B64Url.encode(P1363.toDer(raw))).verifyEs256(x, y))
        assertFalse(good.copy(alg = "Ed25519").verifyEs256(x, y))
        // (x, y + 1) is 32 bytes each but not a point on P-256.
        val offCurve = B64Url.encode(P256.coordinate(BigInteger(1, B64Url.decode(y)).add(BigInteger.ONE)))
        assertFalse(good.verifyEs256(x, offCurve))
        throwsProtocol { Identifiers.deviceId(x, offCurve) }
        throwsProtocol { Identifiers.deviceId(x, B64Url.encode(ByteArray(31))) }
    }

    @Test
    fun requestVectors() {
        for (name in listOf("request-valid", "request-bad-node-signature", "request-unpinned-node", "request-malformed",
            "request-display", "request-display-edge")) {
            val v = vector(name)
            val pins = v["given"]["pinned_nodes"].arr()!!.map { NodePin(it["id"].str()!!, "", it["key"].str()!!) }
            assertEquals(name, v["expect"], Display.view(v["input"]!!, pins).json)
        }
    }

    @Test
    fun showAllKeepsEveryCharacter() {
        val message = Envelope.fromJson(vector("request-display")["input"]!!).message()
        val collapsed = Display.build(message)["items"].arr()!!
        val full = Display.build(message, collapse = false)["items"].arr()!!
        assertEquals(collapsed.map { it["path"] }, full.map { it["path"] })
        val script = full.first { it["path"].str() == "params.script" }
        assertEquals(0, script["hidden"].int())
        assertEquals(message["action"]["params"]["script"].str(), script["text"].str())
        assertTrue(collapsed.first { it["path"].str() == "params.script" }["hidden"].int()!! > 0)
    }

    @Test
    fun displayEscapesHiddenCharacters() {
        val input = StringBuilder("a").appendCodePoint(0x202E).append("b").appendCodePoint(0x200B).append("\n").toString()
        val expected = StringBuilder("a").appendCodePoint(0x2039).append("U+202E").appendCodePoint(0x203A).append("b")
            .appendCodePoint(0x2039).append("U+200B").appendCodePoint(0x203A)
            .appendCodePoint(0x2039).append("U+000A").appendCodePoint(0x203A).toString()
        assertEquals(expected, Display.escape(input))
        assertEquals("plain", Display.escape("plain"))
        assertEquals("\u2039U+E0041\u203A", Display.escape(String(Character.toChars(0xE0041))))
        // Not hidden: U+00A0 and U+3000 are argv spaces, but visible.
        assertEquals("\u00A0\u3000", Display.escape("\u00A0\u3000"))
        assertEquals("run.sh \"\" \"has space\" \"a\\\"b\" \"x\u3000y\"", Display.joinArgv(listOf("run.sh", "", "has space", "a\"b", "x\u3000y")))
        assertEquals("params[\"a.b\"]", Display.pathSegment("params", "a.b"))
        assertEquals("params.a", Display.pathSegment("params", "a"))
        assertEquals("params[\"q\\\"\\\\\"]", Display.pathSegment("params", "q\"\\"))
    }

    /**
     * Shape first: a payload that is not exactly its own JCS bytes (a
     * non-canonical number, a duplicate key, whitespace) is malformed even
     * from a pinned node, before the signature is looked at.
     */
    @Test
    fun nonCanonicalRequestIsMalformed() {
        val v = vector("request-valid")
        val envelope = Envelope.fromJson(v["input"]!!)
        val text = String(envelope.payloadBytes(), Charsets.UTF_8)
        val pins = listOf(NodePin("kl-c2ubd6jjqumalzt5", "web-01", v["given"]["pinned_nodes"].arr()!![0]["key"].str()!!))
        val variants = listOf(
            text.replace("\"v\":1}", "\"v\":1.0}"),
            text.replace("\"v\":1}", "\"v\":1,\"v\":1}"),
            text.replace("{\"action\"", "{ \"action\"")
        )
        for (variant in variants) {
            assertNotEquals(text, variant)
            val forged = envelope.copy(payload = B64Url.encode(variant.toByteArray()))
            assertEquals(variant, "malformed", Display.view(forged.json, pins).reason)
            throwsProtocol { forged.message() }
        }
    }

    /** approval-v1 §5: keys equal under NFC/NFD are refused, as on iOS, even though the node keeps both. */
    @Test
    fun keysEqualUnderNormalizationAreMalformed() {
        throwsProtocol { JsonText.parse("{\"a\":1,\"a\":2}") }
        throwsProtocol { JsonText.parse("{\"\u00e9\":1,\"e\u0301\":2}") }
        throwsProtocol { JsonText.parse("{\"x\":{\"\u212b\":1,\"\u00c5\":2}}") }
        // Distinct keys, and the same key in different objects, are fine.
        assertEquals(2, JsonText.parse("{\"a\":{\"\u00e9\":1},\"b\":{\"\u00e9\":2}}").obj()!!.size)
        throwsProtocol { Messages.decodeQr("kl1:" + B64Url.encode("{\"t\":\"kl.relay\",\"t\":\"kl.pair\"}".toByteArray())) }

        // A node-signed, canonical request whose params carry such a pair is shown by no phone.
        val web01 = keys()["nodes"]["web-01"]!!
        val request = Envelope.fromJson(vector("request-valid")["input"]!!).message().obj()!!
        val action = request["action"].obj()!!
        val params = obj("\u00e9" to jsonString("one"), "e\u0301" to jsonString("two"))
        val edited = JsonObject(action + ("params" to params))
        val message = JsonObject(request + mapOf("action" to edited, "action_hash" to jsonString(Digest.sha256B64url(Jcs.bytes(edited)))))
        val envelope = sealEd25519(message, web01["id"].str()!!, nodeKey("web-01"))
        assertTrue(envelope.verifyEd25519(web01["spki"].str()!!))
        val view = Display.view(envelope.json, listOf(NodePin(web01["id"].str()!!, "web-01", web01["spki"].str()!!)))
        assertEquals("malformed", view.reason)
    }

    @Test
    fun ecmaScriptNumbers() {
        assertEquals("0.5", Jcs.esNumber("0.5"))
        assertEquals("200", Jcs.esNumber("200"))
        assertEquals("-1", Jcs.esNumber("-1"))
        assertEquals("0", Jcs.esNumber("-0"))
        assertEquals("1", Jcs.esNumber("1.0"))
        assertEquals("1e+21", Jcs.esNumber("1e21"))
        assertEquals("100000000000000000000", Jcs.esNumber("1e20"))
        assertEquals("1e-7", Jcs.esNumber("1e-7"))
        assertEquals("0.000001", Jcs.esNumber("0.000001"))
        assertEquals("123456789012345680000", Jcs.esNumber("123456789012345678901"))
        assertEquals("0.1", Jcs.esNumber("0.1"))
        assertEquals("5e-324", Jcs.esNumber("5e-324"))
        assertEquals("1.7976931348623157e+308", Jcs.esNumber("1.7976931348623157e308"))
        assertEquals("2e+23", Jcs.esNumber("2e23"))
        assertEquals("-1.5e-9", Jcs.esNumber("-0.0000000015"))
        assertNull(Jcs.esNumber("1e400"))
    }

    @Test
    fun auditSlice() {
        val v = vector("audit-slice")
        val result = AuditSlice.verify(v["input"]!!, v["given"]["node"]["key"].str()!!)
        assertTrue(result.reason, result.ok)
        assertEquals(v["expect"]["entries"].int(), result.entries.size)
        val wrongKey = AuditSlice.verify(v["input"]!!, Identifiers.ED25519_SPKI_PREFIX + "00".repeat(32))
        assertFalse(wrongKey.ok)
        assertEquals("bad_signature", wrongKey.reason)
    }

    /** The audit-slice vector's message, edited, then signed again with the web-01 test seed from keys.json. */
    private fun resealedSlice(edit: (MutableMap<String, JsonElement>) -> Unit): JsonElement {
        val m = Envelope.fromJson(vector("audit-slice")["input"]!!).message().obj()!!.toMutableMap()
        edit(m)
        return sealEd25519(JsonObject(m), m["node_id"].str()!!, nodeKey("web-01")).json
    }

    /** Rewrites entry `index` (without recomputing its hash). */
    private fun editEntry(m: MutableMap<String, JsonElement>, index: Int, edit: (MutableMap<String, JsonElement>) -> Unit) {
        val entries = m["entries"].arr()!!.toMutableList()
        val entry = entries[index].obj()!!.toMutableMap()
        edit(entry)
        entries[index] = JsonObject(entry)
        m["entries"] = JsonArray(entries)
    }

    /** One tampered slice per failure branch of approval-v1 §3.6. */
    @Test
    fun auditSliceFailureBranches() {
        val key = vector("audit-slice")["given"]["node"]["key"].str()!!
        fun reason(slice: JsonElement): String? = AuditSlice.verify(slice, key).reason
        val entries = Envelope.fromJson(vector("audit-slice")["input"]!!).message()["entries"].arr()!!
        val gpuBox = keys()["nodes"]["gpu-box"]["id"].str()!!

        // The helper itself: an unedited re-seal verifies.
        assertTrue(AuditSlice.verify(resealedSlice { }, key).ok)
        assertEquals("foreign_entry", reason(resealedSlice { m -> editEntry(m, 0) { it["node_id"] = jsonString(gpuBox) } }))
        assertEquals("hash_mismatch", reason(resealedSlice { m -> editEntry(m, 1) { it["kind"] = jsonString("approval.tampered") } }))
        assertEquals("hash_mismatch", reason(resealedSlice { m -> editEntry(m, 1) { it.remove("hash") } }))
        assertEquals("broken_chain", reason(resealedSlice { m -> m["entries"] = JsonArray(listOf(entries[0], entries[2])) }))
        assertEquals("exceeds_head", reason(resealedSlice { m -> m["head"] = obj("seq" to jsonNumber("2"), "hash" to entries[1]["hash"]!!) }))
        assertEquals("head_mismatch", reason(resealedSlice { m -> m["head"] = obj("seq" to jsonNumber("3"), "hash" to entries[1]["hash"]!!) }))
        assertEquals("before_anchor", reason(resealedSlice { m -> m["anchor"] = obj("seq" to jsonNumber("2"), "prev" to entries[0]["hash"]!!) }))
        assertEquals("unsupported_version", reason(resealedSlice { m -> m["v"] = jsonNumber("2") }))
        assertEquals("malformed", reason(resealedSlice { m -> m["extra"] = JsonNull }))

        // Signed correctly but misshapen: malformed, as the JS verifier says.
        val input = vector("audit-slice")["input"].obj()!!
        assertEquals("malformed", reason(JsonObject(input + ("note" to jsonString("x")))))
        assertEquals("malformed", reason(JsonObject(input + ("kid" to jsonString(gpuBox)))))
        assertEquals("malformed", reason(JsonObject(input + ("kid" to jsonString("")))))
        assertEquals("bad_signature", reason(jsonString("not an envelope")))
        assertEquals("bad_signature", reason(JsonObject(input - "sig")))
    }

    @Test
    fun phoneApiAuth() {
        val v = vector("phone-api-auth")
        val g = v["given"]!!
        val body = g["body"].str()!!.toByteArray()
        val s = Messages.phoneAuthString(g["method"].str()!!, g["path"].str()!!, g["timestamp"].str()!!, body)
        assertEquals(v["expect"]["signing_string"].str(), s)
        assertEquals(v["expect"]["body_sha256"].str(), Digest.sha256B64url(body))
        val env = Envelope("ES256", g["device"]["device_id"].str()!!, B64Url.encode(s.toByteArray()), v["input"]["signature"].str()!!)
        assertTrue(env.verifyEs256(g["device"]["jwk"]["x"].str()!!, g["device"]["jwk"]["y"].str()!!))
    }

    /** Phone-side JCS: the console enrollment the phone builds is the vector's bytes, code_mac included. */
    @Test
    fun consoleEnrollBytes() {
        val v = vector("enroll-console")
        val sent = Envelope.fromJson(v["input"]!!).message()
        val rebuilt = Messages.consoleEnroll(sent["device"]!!, v["given"]["code_id"].str()!!, v["given"]["code"].str()!!,
            sent["created_at"].str()!!, sent["expires_at"].str()!!, sent["nonce"].str()!!)
        assertEquals(v["input"]["payload"].str(), B64Url.encode(Jcs.bytes(rebuilt)))
    }

    /** Sign → verify with the fixed device A key; the response the phone builds is the committed bytes. */
    @Test
    fun signVerifyAndResponseBytes() {
        val a = keys()["devices"]["A"]!!
        val private = deviceKey("A")
        val request = Envelope.fromJson(vector("request-valid")["input"]!!).message()
        val response = Messages.response(request, "approve", a["id"].str()!!, "2026-09-23T18:04:31.201Z")
        val envelope = Envelope.seal(response, a["id"].str()!!) { bytes ->
            Signature.getInstance("SHA256withECDSA").run { initSign(private); update(bytes); P1363.fromDer(sign()) }
        }
        assertTrue(envelope.verifyEs256(a["jwk"]["x"].str()!!, a["jwk"]["y"].str()!!))
        val committed = Envelope.fromJson(vector("response-approve")["input"]!!)
        assertEquals(String(committed.payloadBytes(), Charsets.UTF_8), Jcs.serialize(committed.message()))
        assertEquals(committed.payload, envelope.payload)
        throwsProtocol { Messages.response(request, "maybe", a["id"].str()!!, "2026-09-23T18:04:31.201Z") }
        throwsProtocol { Messages.response(request, "approve", "d-not-a-device", "2026-09-23T18:04:31.201Z") }
    }

    /** The field limits a node enforces on what a phone writes (approval-v1 §3). */
    @Test
    fun phoneWrittenFieldLimits() {
        val a = keys()["devices"]["A"]!!
        val id = a["id"].str()!!
        val x = a["jwk"]["x"].str()!!
        val y = a["jwk"]["y"].str()!!
        val emoji = String(Character.toChars(0x1F600))
        fun device(name: String) = Messages.device(id, name, "android", x, y)
        device("n".repeat(64))
        throwsProtocol { device("n".repeat(65)) }
        throwsProtocol { device("") }
        // UTF-16 units, not code points: 32 astral characters fill the 64.
        device(emoji.repeat(32))
        throwsProtocol { device(emoji.repeat(33)) }
        throwsProtocol { Messages.device("d-aaaaaaaaaaaaaaaa", "phone", "android", x, y) }
        throwsProtocol { Messages.device(id, "phone", "desktop", x, y) }

        val nonce = Messages.randomNonce()
        assertEquals(43, nonce.length)
        val b = keys()["devices"]["B"]["id"].str()!!
        fun revoke(reason: String, by: String = id, expires: String = "2026-09-24T18:04:11.201Z") =
            Messages.revoke(b, by, reason, "2026-09-23T18:04:11.201Z", expires, nonce)
        // Code points, not UTF-16 units: 200 astral characters are allowed.
        revoke(emoji.repeat(200))
        throwsProtocol { revoke("r".repeat(201)) }
        throwsProtocol { revoke("lost", by = b) }
        throwsProtocol { revoke("lost", expires = "2026-10-01T18:04:11.201Z") }
        throwsProtocol { revoke("lost", expires = "2026-02-30T00:00:00Z") }

        val dev = device("Owner phone")
        val enroll = Messages.signedEnroll(dev, b, "2026-09-23T18:04:11.201Z", "2026-09-23T18:14:11.201Z", nonce)
        assertNull(Messages.validate("kl.device.enroll", enroll))
        // More than 10 minutes between created_at and expires_at.
        throwsProtocol { Messages.signedEnroll(dev, b, "2026-09-23T18:04:11.201Z", "2026-09-23T18:14:11.202Z", nonce) }
        throwsProtocol { Messages.signedEnroll(dev, b, "2026-09-23T18:04:11.201Z", "2026-09-23T18:14:11.201Z", "short") }
        // A lone surrogate never reaches the wire.
        throwsProtocol { Jcs.serialize(jsonString("\uD800")) }
    }

    @Test
    fun timestamps() {
        assertTrue(Timestamps.isValid("2026-09-23T18:04:11.201Z"))
        assertTrue(Timestamps.isValid("2024-02-29T00:00:00.5Z"))
        assertTrue(Timestamps.isValid("2026-09-23T18:04:11Z"))
        assertFalse(Timestamps.isValid("2026-02-30T00:00:00Z"))
        assertFalse(Timestamps.isValid("2026-01-01T24:00:00Z"))
        assertFalse(Timestamps.isValid("2026-09-23T18:04:11.2012Z"))
        assertFalse(Timestamps.isValid("2026-09-23T18:04:11.Z"))
        assertFalse(Timestamps.isValid("0099-01-01T00:00:00Z"))
        assertFalse(Timestamps.isValid("2026-09-23T18:04:11.201+00:00"))
        // Only ASCII digits count (an Arabic-Indic two is not a digit here).
        assertFalse(Timestamps.isValid("\u0662026-09-23T18:04:11Z"))
        assertEquals(1500L, Timestamps.epochMillis("1970-01-01T00:00:01.5Z"))
        assertEquals(1500L, Timestamps.epochMillis("1970-01-01T00:00:01.50Z"))
        assertEquals(1501L, Timestamps.epochMillis("1970-01-01T00:00:01.501Z"))
        assertEquals(1790186651201L, Timestamps.epochMillis("2026-09-23T18:04:11.201Z"))
        assertNull(Timestamps.epochMillis("2026-02-30T00:00:00Z"))
        assertEquals(Instant.ofEpochMilli(1790186651201L), Timestamps.parse("2026-09-23T18:04:11.201Z"))
        throwsProtocol { Timestamps.parse("2026-02-30T00:00:00Z") }
        assertEquals("2026-09-23T18:04:11.201Z", Timestamps.string(Instant.ofEpochMilli(1790186651201L)))
        assertEquals("1970-01-01T00:00:01.000Z", Timestamps.string(Instant.ofEpochSecond(1)))
        assertTrue(Timestamps.isValid(Timestamps.string(Instant.now())))
    }

    /** Only accepted: true with delivered: true is approved; null is forwarded or not delivered. */
    @Test
    fun responseOutcome() {
        fun outcome(text: String) = ResponseOutcome.from(JsonText.parse(text))
        assertEquals(ResponseOutcome.Accepted, outcome("{\"delivered\":true,\"accepted\":true,\"reason\":null}"))
        assertEquals(ResponseOutcome.Refused("expired"), outcome("{\"delivered\":true,\"accepted\":false,\"reason\":\"expired\"}"))
        assertEquals(ResponseOutcome.Forwarded, outcome("{\"delivered\":true,\"accepted\":null,\"reason\":null}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("{\"delivered\":false,\"accepted\":null,\"reason\":null}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("{\"delivered\":false,\"accepted\":true,\"reason\":null}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("{\"delivered\":true,\"accepted\":\"true\",\"reason\":null}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("{\"delivered\":true,\"accepted\":1,\"reason\":null}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("{\"accepted\":true}"))
        assertEquals(ResponseOutcome.NotDelivered, outcome("[]"))
        assertFalse(ResponseOutcome.Forwarded.approved)
        assertFalse(ResponseOutcome.NotDelivered.approved)
        assertFalse(ResponseOutcome.Refused(null).approved)
        assertTrue(ResponseOutcome.Accepted.approved)
    }

    @Test
    fun approvalStatus() {
        val nodeKeys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val spki = nodeKeys.public.encoded
        val pin = NodePin(Identifiers.nodeId(spki.copyOfRange(12, 44)), "web-01", Hex.encode(spki))
        val requestId = "0f8e7c2a-5b1d-4c3e-9a7f-2d6b8e1c4a90"
        fun status(kid: String = pin.id, edit: (MutableMap<String, JsonElement>) -> Unit = {}): JsonElement {
            val fields = linkedMapOf<String, JsonElement>(
                "v" to jsonNumber("1"), "type" to jsonString("kl.approval.status"), "request_id" to jsonString(requestId),
                "node_id" to jsonString(pin.id), "state" to jsonString("approved"), "device_id" to JsonNull, "reason" to JsonNull,
                "at" to jsonString("2026-09-23T18:04:31.201Z")
            )
            edit(fields)
            return sealEd25519(JsonObject(fields), kid, nodeKeys.private).json
        }
        assertEquals(ApprovalStatus("approved", null, null), ApprovalStatus.verify(status(), requestId, pin))
        assertEquals(ApprovalStatus("refused", "d-3vmwrihhdbnit4oi", "action_changed"), ApprovalStatus.verify(status {
            it["state"] = jsonString("refused"); it["device_id"] = jsonString("d-3vmwrihhdbnit4oi"); it["reason"] = jsonString("action_changed")
        }, requestId, pin))
        assertNotNull(ApprovalStatus.verify(status { it["reason"] = jsonString("x".repeat(300)) }, requestId, pin))
        assertNull(ApprovalStatus.verify(status { it["reason"] = jsonString("x".repeat(301)) }, requestId, pin))
        assertNull(ApprovalStatus.verify(status { it["state"] = jsonString("maybe") }, requestId, pin))
        assertNull(ApprovalStatus.verify(status { it["extra"] = JsonNull }, requestId, pin))
        assertNull(ApprovalStatus.verify(status { it["device_id"] = jsonString("not-a-device") }, requestId, pin))
        assertNull(ApprovalStatus.verify(status { it["v"] = jsonNumber("2") }, requestId, pin))
        assertNull(ApprovalStatus.verify(status(), "1f8e7c2a-5b1d-4c3e-9a7f-2d6b8e1c4a90", pin))
        // Signed by the pinned key, but kid names another node.
        assertNull(ApprovalStatus.verify(status(kid = "kl-aaaaaaaaaaaaaaaa"), requestId, pin))
        // A valid status about another node (kid still the pin).
        assertNull(ApprovalStatus.verify(status { it["node_id"] = jsonString("kl-aaaaaaaaaaaaaaaa") }, requestId, pin))
        // `at` must be a real calendar moment.
        assertNull(ApprovalStatus.verify(status { it["at"] = jsonString("2026-02-30T00:00:00Z") }, requestId, pin))
        val other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().public.encoded
        assertNull(ApprovalStatus.verify(status(), requestId, NodePin(pin.id, "web-01", Hex.encode(other))))
        // No generic fallback: a type without rules here is malformed.
        assertEquals("malformed", Messages.validate("kl.approval.status", JsonText.parse("{\"v\":1,\"type\":\"kl.approval.status\"}")))
        assertEquals("malformed", Messages.validate("kl.lease.grant", JsonText.parse("{\"v\":1,\"type\":\"kl.lease.grant\"}")))
    }

    @Test
    fun p1363Conversion() {
        val keys = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        repeat(20) {
            val data = "x$it".toByteArray()
            val der = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(data); sign() }
            val raw = P1363.fromDer(der)
            assertEquals(64, raw.size)
            assertArrayEquals(der, P1363.toDer(raw))
            assertTrue(Signature.getInstance("SHA256withECDSA").run { initVerify(keys.public); update(data); verify(P1363.toDer(raw)) })
        }
        throwsProtocol { P1363.fromDer(byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x05, 0x01)) }
        throwsProtocol { P1363.fromDer(byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00)) }
        throwsProtocol { P1363.toDer(ByteArray(63)) }
    }

    @Test
    fun strictParsing() {
        throwsProtocol { JsonText.parse("\"\\ud800\"") }
        throwsProtocol { JsonText.parse("\"\\udc00\"") }
        throwsProtocol { JsonText.parse("\"\\u+041\"") }
        throwsProtocol { JsonText.parse(byteArrayOf(0x22, 0xED.toByte(), 0xA0.toByte(), 0x80.toByte(), 0x22)) }
        throwsProtocol { JsonText.parse(byteArrayOf(0x22, 0xC0.toByte(), 0xAF.toByte(), 0x22)) }
        throwsProtocol { JsonText.parse("{} x") }
        throwsProtocol { JsonText.parse("{\"a\":01}") }
        throwsProtocol { JsonText.parse("{\"a\":1.}") }
        throwsProtocol { JsonText.parse("{'a':1}") }
        throwsProtocol { JsonText.parse("[1,]") }
        throwsProtocol { JsonText.parse("\"a\tb\"") }
        throwsProtocol { JsonText.parse("[".repeat(600) + "]".repeat(600)) }
        throwsProtocol { B64Url.decode("ab==") }
        throwsProtocol { B64Url.decode("abd") }
        throwsProtocol { B64Url.decode("a") }
        throwsProtocol { Hex.decode("+f") }
        throwsProtocol { Hex.decode("abc") }
        assertEquals(jsonString("\u00e9" + String(Character.toChars(0x1F600))), JsonText.parse("\"\u00e9\\ud83d\\ude00\""))
        val n = JsonText.parse("{\"n\":1.50,\"b\":true,\"z\":null}")
        assertEquals("1.50", (n["n"] as JsonPrimitive).content)
        assertTrue(n["n"].isNumber())
        assertFalse(n["b"].isNumber())
        assertEquals(true, n["b"].bool())
        assertTrue(n["z"] is JsonNull)
        assertEquals("{\"b\":true,\"n\":1.50,\"z\":null}", Jcs.serialize(n))
    }

    @Test
    fun demoModeNeverBuildsTheNetworkClient() {
        var constructed = 0
        val factory = RelayClientFactory { constructed += 1; "client" }
        assertNull(factory.client(AppMode.DEMO))
        assertNull(factory.client(AppMode.WELCOME))
        assertEquals(0, factory.built)
        assertEquals(0, constructed)
        assertEquals("client", factory.client(AppMode.LIVE))
        assertEquals(1, constructed)

        val fleet = DemoFleet()
        assertEquals(listOf("gpu-box", "laptop", "web-01"), fleet.pins.map { it.name })
        val view = Display.view(fleet.request(2, "systemctl restart site").json, fleet.pins)
        assertTrue(view.reason, view.shown)
        assertEquals("web-01", view.display["node"]["name"].str())
        // A long command still makes a valid request: the summary is cut to 300 code points.
        assertTrue(Display.view(fleet.request(0, "x".repeat(400)).json, fleet.pins).shown)
        assertTrue(fleet.deviceId.startsWith("d-"))
    }

    @Test
    fun qrRoundTrip() {
        val payload = obj("t" to jsonString("kl.relay"), "relay" to jsonString("https://kl.example.com:8443"), "relay_spki" to jsonString("sha256/abc"))
        assertEquals(payload, Messages.decodeQr(Messages.encodeQr(payload)))
        try {
            Messages.decodeQr("kl2:xx")
            fail("expected a refusal")
        } catch (e: ProtocolException) {
            assertTrue(e.message!!.contains("kl1"))
        }
        throwsProtocol { Messages.decodeQr("kl1:!!") }
        throwsProtocol { Messages.decodeQr("kl1:" + B64Url.encode("{\"relay\":\"x\"}".toByteArray())) }
        throwsProtocol { Messages.decodeQr("kl1:" + B64Url.encode("[]".toByteArray())) }
    }
}
