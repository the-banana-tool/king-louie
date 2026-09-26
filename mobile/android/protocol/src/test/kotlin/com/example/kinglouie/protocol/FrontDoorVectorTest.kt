package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.EdECPrivateKeySpec
import java.security.spec.NamedParameterSpec

/** Every client-grant-v1 vector whose consumers include "android" (shared with the front door and iOS). */
class FrontDoorVectorTest {
    private val dir = File(System.getProperty("kl.grantVectors") ?: error("run through Gradle: kl.grantVectors is not set"))
    private val keys: JsonElement by lazy {
        JsonText.parse(File(System.getProperty("kl.vectors") ?: error("run through Gradle: kl.vectors is not set"), "keys.json").readBytes())
    }

    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())
    private fun allVectors(): List<JsonElement> = dir.listFiles { f -> f.name.endsWith(".json") }!!.map { JsonText.parse(it.readBytes()) }
    private fun s(v: JsonElement?, key: String): String = v[key].str()!!
    private fun payload(v: JsonElement): ByteArray = Envelope.fromJson(v["input"]!!).payloadBytes()

    private fun throwsProtocol(block: () -> Unit) {
        try {
            block()
        } catch (e: ProtocolException) {
            return
        }
        fail("expected a ProtocolException")
    }

    /** The published front-door test key ("relay" in keys.json; tests only). */
    private fun frontdoorKey(): PrivateKey {
        val seed = Hex.decode(keys["nodes"]["relay"]["seed"].str()!!)
        return KeyFactory.getInstance("Ed25519").generatePrivate(EdECPrivateKeySpec(NamedParameterSpec.ED25519, seed))
    }

    private fun sealRepin(message: JsonElement, kid: String): JsonObject =
        Envelope.seal(message, kid, "Ed25519") { bytes -> Signature.getInstance("Ed25519").run { initSign(frontdoorKey()); update(bytes); sign() } }.json

    private fun repinKeyHex(g: JsonElement?): String = Identifiers.ED25519_SPKI_PREFIX + Hex.encode(B64Url.decode(s(g["frontdoor"], "key")))

    @Test
    fun everyAndroidVectorIsCovered() {
        val names = allVectors()
            .filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }
            .map { it["name"].str() }
            .toSet()
        assertEquals(
            setOf(
                "grant-approve", "grant-deny", "client-revoke-valid", "enroll-valid", "remove-valid", "repin-valid",
                "repin-reject-bad-signature", "repin-reject-spki-mismatch", "repin-reject-old-pin-mismatch", "fingerprint-grouping"
            ),
            names
        )
    }

    @Test
    fun grantApproveBytes() {
        val v = vector("grant-approve")
        val expect = v["expect"]["message"]!!
        val choices = listOf(ScopeChoice("fleet:run", listOf("web-01", "gpu-box", "web-01")), ScopeChoice("fleet:read"))
        val built = FrontDoor.clientGrant(s(v["given"]["frontdoor"], "id"), v["given"]["pending"]!!, "q7k-m2x", choices, "approve",
            s(expect, "nonce"), s(expect, "device_id"), s(expect, "signed_at"))
        assertEquals(expect, built)
        assertArrayEquals(payload(v), Jcs.bytes(built))
        val a = keys["devices"]["A"]
        assertTrue(Envelope.fromJson(v["input"]!!).verifyEs256(s(a["jwk"], "x"), s(a["jwk"], "y")))
        assertNull(FrontDoor.validate("kl.client.grant", built))
    }

    @Test
    fun grantDenyBytes() {
        val v = vector("grant-deny")
        val expect = v["expect"]["message"]!!
        val built = FrontDoor.clientGrant(s(v["given"]["frontdoor"], "id"), v["given"]["pending"]!!, "Q7KM2X", listOf(ScopeChoice("fleet:read")), "deny",
            s(expect, "nonce"), s(expect, "device_id"), s(expect, "signed_at"))
        assertArrayEquals(payload(v), Jcs.bytes(built))
    }

    @Test
    fun revokeEnrollRemoveBytes() {
        val revoke = vector("client-revoke-valid")
        val r = revoke["expect"]["message"]
        assertEquals("revoke", s(revoke["given"]["challenges"].arr()!![0], "purpose"))
        assertArrayEquals(payload(revoke), Jcs.bytes(FrontDoor.clientRevoke(s(r, "frontdoor_id"), s(r, "grant_id"),
            s(revoke["given"]["challenges"].arr()!![0], "challenge"), s(r, "device_id"), s(r, "signed_at"))))

        val enroll = vector("enroll-valid")
        val e = enroll["expect"]["message"]
        assertArrayEquals(payload(enroll), Jcs.bytes(FrontDoor.nodeEnroll(s(e, "frontdoor_id"), enroll["given"]["pairing"]!!, "approve",
            s(e, "nonce"), s(e, "device_id"), s(e, "signed_at"))))

        val remove = vector("remove-valid")
        val m = remove["expect"]["message"]
        assertEquals("remove", s(remove["given"]["challenges"].arr()!![0], "purpose"))
        assertArrayEquals(payload(remove), Jcs.bytes(FrontDoor.nodeRemove(s(m, "frontdoor_id"), s(m, "node_id"),
            s(remove["given"]["challenges"].arr()!![0], "challenge"), s(m, "device_id"), s(m, "signed_at"))))
    }

    @Test
    fun repin() {
        for (name in listOf("repin-valid", "repin-reject-bad-signature", "repin-reject-spki-mismatch", "repin-reject-old-pin-mismatch")) {
            val v = vector(name)
            val g = v["given"]
            val check = FrontDoor.verifyRepin(v["input"]!!, s(g["frontdoor"], "id"), repinKeyHex(g), s(g, "received_spki"), s(g, "current_pin"))
            assertEquals(name, v["expect"]["accepted"].bool(), check.ok)
            assertEquals(name, v["expect"]["reason"].str(), check.reason)
            if (check.ok) assertEquals(s(g, "received_spki"), check.newSpki) else assertNull(name, check.newSpki)
        }
        val v = vector("repin-valid")
        val g = v["given"]
        val keyHex = repinKeyHex(g)
        val fd = s(g["frontdoor"], "id")
        val other = "sha256/" + "A".repeat(43)
        assertEquals("spki_mismatch", FrontDoor.verifyRepin(v["input"]!!, fd, keyHex, other, s(g, "current_pin")).reason)
        assertEquals("old_pin_mismatch", FrontDoor.verifyRepin(v["input"]!!, fd, keyHex, s(g, "received_spki"), other).reason)
        assertEquals("wrong_frontdoor", FrontDoor.verifyRepin(v["input"]!!, "kl-aaaaaaaaaaaaaaaa", keyHex, s(g, "received_spki"), s(g, "current_pin")).reason)
        assertEquals("malformed", FrontDoor.verifyRepin(jsonString("x"), fd, keyHex, other, other).reason)
    }

    /** §4.7 step 1: a pinned key that is not an Ed25519 key is `malformed`, before the envelope is looked at. */
    @Test
    fun repinRefusesABadPinnedKey() {
        val v = vector("repin-valid")
        val g = v["given"]
        for (bad in listOf("", "00", Identifiers.ED25519_SPKI_PREFIX, "302a300506032b6571032100" + "00".repeat(32), repinKeyHex(g) + "00")) {
            val check = FrontDoor.verifyRepin(v["input"]!!, s(g["frontdoor"], "id"), bad, s(g, "received_spki"), s(g, "current_pin"))
            assertEquals(bad, "malformed", check.reason)
            assertFalse(check.ok)
        }
    }

    /** Fail closed on what the front door signs: unknown fields, old = new, a later version, a non-canonical payload, the wrong alg. */
    @Test
    fun repinRefusesMalformedMessages() {
        val v = vector("repin-valid")
        val g = v["given"]
        val fd = s(g["frontdoor"], "id")
        val keyHex = repinKeyHex(g)
        val message = Envelope.fromJson(v["input"]!!).message()
        fun check(m: JsonObject, received: String = s(g, "received_spki"), current: String = s(g, "current_pin")) =
            FrontDoor.verifyRepin(sealRepin(m, fd), fd, keyHex, received, current)

        // The same message re-signed passes: the refusals below are the changes.
        assertTrue(check(message).ok)
        assertEquals("malformed", check(JsonObject(message + ("extra" to jsonString("x")))).reason)
        assertEquals("malformed", check(JsonObject(message - "created_at")).reason)
        assertEquals("malformed", check(JsonObject(message + ("new_spki" to message["old_spki"]!!)), current = s(message, "old_spki"), received = s(message, "old_spki")).reason)
        assertEquals("malformed", check(JsonObject(message + ("relay" to jsonString("http://mcp.kl.example.com")))).reason)
        assertEquals("malformed", check(JsonObject(message + ("relay" to jsonString("https://user@mcp.kl.example.com")))).reason)
        assertEquals("malformed", check(JsonObject(message + ("relay" to jsonString("https://mcp.kl.example.com/#x")))).reason)
        assertEquals("malformed", check(JsonObject(message + ("new_spki" to jsonNumber("1")))).reason)
        assertEquals("unsupported_version", check(JsonObject(message + ("v" to jsonNumber("2")))).reason)

        val env = Envelope.fromJson(v["input"]!!)
        assertEquals("malformed", FrontDoor.verifyRepin(env.copy(alg = "ES256").json, fd, keyHex, s(g, "received_spki"), s(g, "current_pin")).reason)
        // Whitespace in the payload: not its own canonical bytes.
        val spaced = B64Url.encode((" " + String(env.payloadBytes(), Charsets.UTF_8)).toByteArray(Charsets.UTF_8))
        assertEquals("malformed", FrontDoor.verifyRepin(env.copy(payload = spaced).json, fd, keyHex, s(g, "received_spki"), s(g, "current_pin")).reason)
        // A fifth envelope member.
        assertEquals("malformed", FrontDoor.verifyRepin(JsonObject(env.json + ("x" to jsonString("y"))), fd, keyHex, s(g, "received_spki"), s(g, "current_pin")).reason)
    }

    @Test
    fun fingerprintsAndUserCodes() {
        val v = vector("fingerprint-grouping")
        val ids = v["input"]["node_ids"].arr()!!.map { it.str()!! }
        assertEquals(v["expect"]["node_fingerprints"].arr()!!.map { it.str() }, ids.map { FrontDoor.nodeFingerprint(it) })
        val normalized = v["input"]["typed_codes"].arr()!!.map { FrontDoor.normalizeUserCode(it.str()!!) }
        assertEquals(v["expect"]["user_codes"].arr()!!.map { if (it is JsonNull) null else it.str() }, normalized)
        assertEquals(v["expect"]["displayed"].arr()!!.map { if (it is JsonNull) null else it.str() }, normalized.map { c -> c?.let { FrontDoor.formatUserCode(it) } })
        assertTrue(FrontDoor.isMachineName("gpu-box"))
        assertFalse(FrontDoor.isMachineName("GPU-box"))
    }

    /** The front door's normalizeUserCode, character for character (client-grant-v1 §6). */
    @Test
    fun userCodesFollowTheFrontDoor() {
        assertEquals("Q7KM2X", FrontDoor.normalizeUserCode("Q7K\u3000M2X"))
        assertEquals("Q7KM2X", FrontDoor.normalizeUserCode("\uFEFFq7k\u00A0m2x\n"))
        assertEquals("Q7KM2X", FrontDoor.normalizeUserCode("Q7K" + " ".repeat(58) + "M2X"))
        assertNull(FrontDoor.normalizeUserCode("Q7K" + " ".repeat(59) + "M2X"))
        // Checked as ASCII before upper-casing: no look-alike becomes the alphabet.
        assertNull(FrontDoor.normalizeUserCode("Q7KM\u00DF"))
        assertNull(FrontDoor.normalizeUserCode("Q7KM2\u0131"))
        assertNull(FrontDoor.normalizeUserCode("Q7KM2\uFB00"))
        assertNull(FrontDoor.normalizeUserCode("Q7KM2\uFF38"))
        assertNull(FrontDoor.normalizeUserCode("Q7K_M2X"))
        assertNull(FrontDoor.normalizeUserCode(""))
    }

    /** What the front door refuses as malformed, the phone never signs. */
    @Test
    fun buildersRefuse() {
        val v = vector("grant-approve")
        val fd = s(v["given"]["frontdoor"], "id")
        val pending = v["given"]["pending"]!!
        val a = s(keys["devices"]["A"], "id")
        fun grant(p: JsonElement, scopes: List<ScopeChoice>, code: String = "Q7KM2X", decision: String = "approve") =
            FrontDoor.clientGrant(fd, p, code, scopes, decision, Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z")
        throwsProtocol { grant(pending, emptyList()) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:run", listOf("Web-01")))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:run", emptyList()))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read"), ScopeChoice("fleet:read"))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("Fleet:read"))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read")), code = "Q7KM2") }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read")), decision = "Approve") }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read")), decision = "maybe") }
        throwsProtocol { grant(JsonObject(pending.obj()!! + ("client_id" to jsonNumber("7"))), listOf(ScopeChoice("fleet:read"))) }
        throwsProtocol { grant(JsonObject(pending.obj()!! - "code_challenge"), listOf(ScopeChoice("fleet:read"))) }
        val emoji = String(Character.toChars(0x1F600))
        val long = JsonObject(pending.obj()!! + ("client_name" to jsonString(emoji.repeat(201))))
        throwsProtocol { grant(long, listOf(ScopeChoice("fleet:read"))) }
        grant(JsonObject(pending.obj()!! + ("client_name" to jsonString(emoji.repeat(200)))), listOf(ScopeChoice("fleet:read")))
        throwsProtocol { FrontDoor.clientRevoke(fd, "gr_short", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z") }
        throwsProtocol { FrontDoor.nodeRemove(fd, "kl-short", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z") }

        // kl.node.enroll signs `replaces` exactly as given: a missing or non-string value is refused, never turned into null.
        val pairing = vector("enroll-valid")["given"]["pairing"].obj()!!
        fun enroll(p: JsonObject) = FrontDoor.nodeEnroll(fd, p, "approve", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z")
        enroll(pairing)
        throwsProtocol { enroll(JsonObject(pairing - "replaces")) }
        throwsProtocol { enroll(JsonObject(pairing + ("replaces" to jsonNumber("1")))) }
        throwsProtocol { enroll(JsonObject(pairing + ("replaces" to jsonString("gpu-box")))) }
        throwsProtocol { enroll(JsonObject(pairing + ("profile" to jsonString("frontdoor")))) }
    }

    /**
     * Every phone-signed vector (the node-only T3 additions included) is well formed by the phone's rules exactly when
     * the front door does not refuse it as malformed: what the front door refuses for its own state
     * (unknown_challenge, demo_device, unknown_request, ...) the phone signs, and the front door decides.
     */
    @Test
    fun phoneRulesAgreeWithEveryPhoneSignedVector() {
        val phoneTypes = setOf("kl.client.grant", "kl.client.revoke", "kl.node.enroll", "kl.node.remove")
        val seen = mutableSetOf<String>()
        for (v in allVectors()) {
            val input = v["input"].obj() ?: continue
            if (input["alg"].str() != "ES256") continue
            val name = v["name"].str()!!
            val reason = v["expect"]["reason"].str()
            val env = Envelope.fromJson(input)
            val message = try {
                env.message()
            } catch (e: ProtocolException) {
                assertEquals(name, "malformed", reason)
                seen += name
                continue
            }
            val type = message["type"].str()!!
            assertTrue(name, type in phoneTypes)
            val phoneReason = FrontDoor.validate(type, message)
            if (reason == "malformed" || reason == "unsupported_version") assertEquals(name, reason, phoneReason) else assertNull(name, phoneReason)
            seen += name
        }
        assertTrue(seen.containsAll(listOf("client-revoke-reject-challenge-unknown", "grant-reject-demo-device", "grant-reject-unknown-request",
            "grant-reject-noncanonical", "grant-reject-machines-unsorted")))
    }

    @Test
    fun grantAndPairingRequests() {
        val v = vector("grant-approve")
        val reply = JsonObject(v["given"]["pending"].obj()!!.filterKeys { it !in setOf("user_code", "expires_at", "claimed_by", "used_nonces") } +
            mapOf("preselected" to JsonArray(listOf(jsonString("fleet:read"))), "expires_in_ms" to jsonNumber("280000")))
        val request = GrantRequest(reply)
        assertEquals("Example Client", request.clientName)
        assertEquals("client.example.com", request.redirectHost)
        assertEquals(listOf("fleet:read", "fleet:run"), request.requestedScopes)
        assertEquals(listOf("fleet:read"), request.preselected)
        assertEquals(280000, request.expiresInMs)
        throwsProtocol { GrantRequest(JsonObject(reply + ("grant_id" to jsonString("gr_x")))) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("extra" to jsonString("x")))) }
        throwsProtocol { GrantRequest(JsonObject(reply - "client_host")) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("requested_scopes" to JsonArray(listOf(jsonString("fleet:read"), jsonString("fleet:read")))))) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("requested_scopes" to JsonArray(listOf(jsonString("Fleet:read")))))) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("preselected" to JsonArray(listOf(jsonNumber("1")))))) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("expires_in_ms" to jsonString("280000")))) }
        throwsProtocol { GrantRequest(JsonObject(reply + ("expires_in_ms" to jsonNumber("-1")))) }
        throwsProtocol { GrantRequest(jsonString("x")) }
        val signed = request.message(s(v["given"]["frontdoor"], "id"), "Q7KM2X", listOf(ScopeChoice("fleet:run", listOf("web-01", "gpu-box")), ScopeChoice("fleet:read")),
            "approve", s(v["expect"]["message"], "nonce"), s(v["expect"]["message"], "device_id"), s(v["expect"]["message"], "signed_at"))
        assertArrayEquals(payload(v), Jcs.bytes(signed))

        val e = vector("enroll-valid")
        val entry = JsonObject(e["given"]["pairing"].obj()!!.filterKeys { it !in setOf("expires_at", "used_nonces") } + ("expires_in_ms" to jsonNumber("500000")))
        val pairing = PairingRequest(entry)
        assertEquals(FrontDoor.nodeFingerprint(s(e["given"]["pairing"], "node_id")), pairing.fingerprint)
        assertNull(pairing.replaces)
        val m = e["expect"]["message"]
        assertArrayEquals(Envelope.fromJson(e["input"]!!).payloadBytes(),
            Jcs.bytes(pairing.message(s(m, "frontdoor_id"), "approve", s(m, "nonce"), s(m, "device_id"), s(m, "signed_at"))))
        throwsProtocol { PairingRequest(JsonObject(entry + ("node_id" to jsonString("kl-aaaaaaaaaaaaaaaa")))) }
        throwsProtocol { PairingRequest(JsonObject(entry + ("extra" to jsonString("x")))) }
        throwsProtocol { PairingRequest(JsonObject(entry - "replaces")) }
        throwsProtocol { PairingRequest(JsonObject(entry + ("public_key" to jsonString("A".repeat(43))))) }
        throwsProtocol { PairingRequest(JsonObject(entry + ("node_name" to jsonString("gpu box")))) }
    }

    /** Ruling T2-purpose: a challenge is asked for with the purpose of the message it will be spent on. */
    @Test
    fun challengesCarryAPurpose() {
        assertEquals(JsonObject(mapOf("purpose" to jsonString("revoke"))), FrontDoor.challengeRequest(FrontDoor.PURPOSE_REVOKE))
        assertEquals(JsonObject(mapOf("purpose" to jsonString("remove"))), FrontDoor.challengeRequest(FrontDoor.PURPOSE_REMOVE))
        throwsProtocol { FrontDoor.challengeRequest("pair") }
        throwsProtocol { FrontDoor.challengeRequest("Revoke") }

        val nonce = Messages.randomNonce()
        val c = Challenge(JsonObject(mapOf("challenge" to jsonString(nonce), "expires_in_ms" to jsonNumber("120000"))))
        assertEquals(nonce, c.challenge)
        assertEquals(120000, c.expiresInMs)
        throwsProtocol { Challenge(JsonObject(mapOf("challenge" to jsonString("short"), "expires_in_ms" to jsonNumber("120000")))) }
        throwsProtocol { Challenge(JsonObject(mapOf("challenge" to jsonString(nonce), "expires_in_ms" to jsonNumber("120000"), "x" to JsonNull))) }
        throwsProtocol { Challenge(JsonObject(mapOf("challenge" to jsonString(nonce)))) }
    }

    /**
     * The front door's decision and removal replies: only a 2xx whose `state` is exactly the one asked for confirms
     * anything; refusal codes (replaces_changed, key_enrolled_as_other_name, save_failed, and codes this app does
     * not know yet) come through as data for the app to word.
     */
    @Test
    fun repliesPassCodesThrough() {
        fun obj(vararg p: Pair<String, JsonElement>) = JsonObject(mapOf(*p))
        val approved = FrontDoorReply.from(200, obj("state" to jsonString("approved")))
        assertTrue(approved.confirms("approved"))
        assertFalse(approved.confirms("enrolled"))
        assertTrue(FrontDoorReply.from(200, obj("state" to jsonString("enrolled"))).confirms("enrolled"))
        assertFalse(FrontDoorReply.from(200, obj("state" to jsonString("Approved"))).confirms("approved"))
        assertFalse(FrontDoorReply.from(200, obj("state" to kotlinx.serialization.json.JsonPrimitive(true))).confirms("approved"))
        assertFalse(FrontDoorReply.from(200, jsonString("approved")).confirms("approved"))
        assertFalse(FrontDoorReply.from(409, obj("state" to jsonString("approved"))).confirms("approved"))
        assertEquals(FrontDoorReply.Done(null), FrontDoorReply.from(204, null))
        assertTrue(FrontDoorReply.from(204, null).succeeded)

        for (code in listOf("replaces_changed", "key_enrolled_as_other_name", "no_such_request", "a_code_from_a_later_front_door")) {
            val r = FrontDoorReply.from(409, obj("error" to jsonString(code), "message" to jsonString("text")))
            assertEquals(FrontDoorReply.Refused(409, code, null), r)
            assertFalse(r.succeeded)
            assertFalse(r.retryable)
        }
        val saveFailed = FrontDoorReply.from(503, obj("error" to jsonString("save_failed"), "message" to jsonString("try again"), "retry_after" to jsonNumber("1")))
        assertEquals(FrontDoorReply.Refused(503, "save_failed", 1), saveFailed)
        assertTrue(saveFailed.retryable)
        // Not a code: kept out, never crashes.
        assertEquals(FrontDoorReply.Refused(400, null, null), FrontDoorReply.from(400, obj("error" to jsonString("<b>x</b>"))))
        assertEquals(FrontDoorReply.Refused(400, null, null), FrontDoorReply.from(400, obj("error" to jsonString("x".repeat(65)))))
        assertEquals(FrontDoorReply.Refused(400, null, null), FrontDoorReply.from(400, obj("error" to jsonNumber("3"))))
        assertEquals(FrontDoorReply.Refused(500, null, null), FrontDoorReply.from(500, null))
        assertEquals(FrontDoorReply.Refused(503, "save_failed", null), FrontDoorReply.from(503, obj("error" to jsonString("save_failed"), "retry_after" to jsonString("1"))))
    }

    /** Mirror break reasons are data: known or not, they come through as codes, and nothing else in the reply is trusted blindly. */
    @Test
    fun auditStatusPassesBreakReasonsThrough() {
        val status = AuditStatus(JsonText.parse("""{"head_seq":12,"anchor":{"seq":3,"prev":null},"gaps":[{"kind":"gap","from_seq":5,"to_seq":6,"at":"2026-09-23T18:04:11.201Z"}],
            "breaks":[{"seq":9,"reason":"fork","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"},{"seq":null,"reason":"a_reason_from_later","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"},
            {"seq":10,"reason":"<script>","mirror_head":null,"at":"2026-09-23T18:04:11.201Z"}]}"""))
        assertEquals(12, status.headSeq)
        assertEquals(3, status.anchorSeq)
        assertEquals(1, status.gapCount)
        assertEquals(listOf(AuditBreak(9, "fork"), AuditBreak(null, "a_reason_from_later"), AuditBreak(10, null)), status.breaks)
        assertTrue(status.broken)
        val clean = AuditStatus(JsonText.parse("""{"head_seq":0,"anchor":null,"gaps":[],"breaks":[]}"""))
        assertFalse(clean.broken)
        assertNull(clean.anchorSeq)
        throwsProtocol { AuditStatus(JsonText.parse("""{"head_seq":"0","anchor":null,"gaps":[],"breaks":[]}""")) }
        throwsProtocol { AuditStatus(JsonText.parse("""{"head_seq":0,"anchor":null,"gaps":[],"breaks":{}}""")) }
        throwsProtocol { AuditStatus(JsonText.parse("""{"head_seq":0,"anchor":null,"gaps":[],"breaks":[7]}""")) }
        throwsProtocol { AuditStatus(JsonText.parse("[]")) }
        assertNotNull(AuditStatus(JsonText.parse("""{"head_seq":0,"anchor":null,"gaps":[],"breaks":[],"later_field":1}""")))
    }
    /** The front door's isHttpsUrl, never looser: ports 1-65535, hosts of ASCII labels or a bracketed IPv6 literal, no userinfo or fragment. */
    @Test
    fun httpsUrlsFollowTheFrontDoor() {
        for (ok in listOf("https://client.example.com/meta.json", "https://client.example.com:443/meta.json", "HTTPS://client.example.com",
                "https://client.example.com:1/", "https://client.example.com:65535/", "https://[2001:db8::1]:8443/m", "https://10.0.0.1/m")) {
            assertTrue(ok, FrontDoorRules.isHttpsUrl(ok, FrontDoorRules.CLIENT_ID_MAX))
        }
        for (bad in listOf("https://client.example.com:65536/", "https://client.example.com:99999/", "https://client.example.com:0443x/",
                "https://client.example.com:/", "https://client.example.com:123456/", "https://exa mple.com/", "https://exa_mple.com/",
                "https://client..example.com/", "https://.example.com/", "https://[::1/", "https://[zz::1]/", "https://user@client.example.com/m",
                "https://@client.example.com/m", "https://client.example.com/m#x", "https://client.example.com/m#", "http://client.example.com/m",
                "https:client.example.com/m", "https:///m", "https://")) {
            assertFalse(bad, FrontDoorRules.isHttpsUrl(bad, FrontDoorRules.CLIENT_ID_MAX))
        }
    }

    /** URL-form client_id (a client ID metadata document): accepted in a request and signed as is; the refused forms never are. */
    @Test
    fun urlClientIds() {
        val v = vector("grant-approve")
        val fd = s(v["given"]["frontdoor"], "id")
        val a = s(keys["devices"]["A"], "id")
        val pending = v["given"]["pending"].obj()!!
        val reply = JsonObject(pending.filterKeys { it !in setOf("user_code", "expires_at", "claimed_by", "used_nonces") } +
            mapOf("preselected" to JsonArray(emptyList()), "expires_in_ms" to jsonNumber("280000")))
        fun withId(id: String) = JsonObject(reply + ("client_id" to jsonString(id)))
        for (ok in listOf("https://client.example.com/meta.json", "https://client.example.com:443/.well-known/client")) {
            val r = GrantRequest(withId(ok))
            assertEquals(ok, r.clientId)
            val m = r.message(fd, "Q7KM2X", listOf(ScopeChoice("fleet:read")), "approve", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z")
            assertEquals(ok, m["client_id"].str())
        }
        for (bad in listOf("https://user@client.example.com/meta.json", "https://client.example.com/meta.json#x", "https://client.example.com:65536/meta.json",
                "https://exa mple.com/meta.json", "http://client.example.com/meta.json", "https://client.example.com/" + "a".repeat(512))) {
            throwsProtocol { GrantRequest(withId(bad)) }
            throwsProtocol { FrontDoor.clientGrant(fd, JsonObject(pending + ("client_id" to jsonString(bad))), "Q7KM2X", listOf(ScopeChoice("fleet:read")), "approve",
                Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z") }
        }
    }

    /** Modelled on grant-reject-scope-widened: the phone never signs a scope the client did not request. */
    @Test
    fun grantRequestRefusesUnrequestedScopes() {
        val v = vector("grant-reject-scope-widened")
        val fd = s(v["given"]["frontdoor"], "id")
        val a = s(keys["devices"]["A"], "id")
        val reply = JsonObject(v["given"]["pending"].obj()!!.filterKeys { it !in setOf("user_code", "expires_at", "claimed_by", "used_nonces") } +
            mapOf("preselected" to JsonArray(emptyList()), "expires_in_ms" to jsonNumber("280000")))
        val request = GrantRequest(reply)
        fun sign(scopes: List<ScopeChoice>, decision: String = "approve") =
            request.message(fd, "Q7KM2X", scopes, decision, Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z")
        // The vector's widened set: fleet:delegate was never requested.
        val widened = Envelope.fromJson(v["input"]!!).message()["scopes"].arr()!!.map { ScopeChoice(it["scope"].str()!!) }
        throwsProtocol { sign(widened) }
        throwsProtocol { sign(listOf(ScopeChoice("fleet:read"), ScopeChoice("fleet:unsafe"))) }
        sign(listOf(ScopeChoice("fleet:read")))
        sign(listOf(ScopeChoice("fleet:read"), ScopeChoice("fleet:run", listOf("gpu-box"))))
        // A denial carries no scopes, so what was chosen does not matter.
        assertEquals(JsonArray(emptyList()), sign(widened, "deny")["scopes"])
    }
}
