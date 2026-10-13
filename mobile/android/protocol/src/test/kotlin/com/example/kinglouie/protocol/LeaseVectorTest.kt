package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** Every lease-v1 vector whose consumers include "android" (shared with the node and iOS). */
class LeaseVectorTest {
    private val dir = File(System.getProperty("kl.leaseVectors") ?: error("run through Gradle: kl.leaseVectors is not set"))
    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())
    private fun allVectors(): List<JsonElement> = dir.listFiles { f -> f.name.endsWith(".json") }!!.map { JsonText.parse(it.readBytes()) }
    private fun s(v: JsonElement?, key: String): String = v[key].str()!!
    private fun pin(v: JsonElement): NodePin = v["given"]["node"].let { NodePin(s(it, "id"), s(it, "name"), s(it, "key")) }
    private fun request(v: JsonElement): LeaseRequest {
        val message = Leases.verifiedMessage(Envelope.fromJson(v["given"]["request"]!!), pin(v)) ?: error("the request verifies against the node pin")
        return LeaseRequest.from(message) ?: error("the request parses")
    }

    private fun assertBuilds(name: String, build: (JsonElement, JsonElement) -> JsonObject) {
        val v = vector(name)
        val expect = v["expect"]["message"]!!
        val built = build(v, expect)
        assertEquals(name, expect, built)
        assertArrayEquals(name, Envelope.fromJson(v["input"]!!).payloadBytes(), Jcs.bytes(built))
    }

    @Test
    fun everyAndroidVectorIsCovered() {
        val names = allVectors().filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }.map { it["name"].str() }.toSet()
        assertEquals(
            setOf(
                "grant-valid", "grant-narrowed", "deny-valid", "resume-capped", "revoke-valid", "watch-valid", "watch-no-token",
                "status-valid", "status-no-contact", "status-pending", "status-granted-unnamed", "view-node-sig-valid", "view-tampered-frame"
            ) + listingVectors,
            names
        )
    }

    private val listingVectors = setOf(
        "listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
        "listing-other-device", "listing-bad-signature"
    )

    /** R-F5-20: a node's listing is taken whole or not at all. */
    @Test
    fun listings() {
        for (name in listingVectors) {
            val v = vector(name)
            val given = v["given"]
            val statuses = given["statuses"].arr()!!.map { Envelope.fromJson(it) }
            val check = Leases.verifyListing(Envelope.fromJson(v["input"]!!), pin(v), s(given, "nonce"), s(given, "device_id"), statuses)
            assertEquals(name, v["expect"]["accepted"].bool(), check.accepted)
            assertEquals(name, v["expect"]["reason"].str(), check.reason)
            if (!check.accepted) assertTrue(name, check.statuses.isEmpty())
            val expected = v["expect"]["leases"].arr() ?: continue
            val got = check.statuses.map { LeaseStatus.from(Leases.verifiedMessage(it, pin(v))!!)!! }
            assertEquals(name, expected.map { it["lease_id"].str() }, got.map { it.leaseId })
            assertEquals(name, expected.map { it["seq"].int() }, got.map { it.seq })
            assertEquals(name, expected.map { it["state"].str() }, got.map { it.state })
        }
        assertEquals(0, vector("listing-none")["expect"]["leases"].arr()!!.size)
        assertEquals(2, vector("listing-live")["expect"]["leases"].arr()!!.size)
    }

    /** R-F5-20: the relay's reply, node by node. No listing for a node is no answer from it. */
    @Test
    fun checkListingReadsTheRelayReply() {
        fun entries(v: JsonElement, nodeId: String = s(v["given"]["node"], "id"), withListing: Boolean = true): List<JsonElement> {
            val node = JsonPrimitive(nodeId)
            val listing = if (withListing) listOf(JsonObject(mapOf("node_id" to node, "envelope" to JsonNull, "status" to JsonNull, "listing" to v["input"]!!))) else emptyList()
            return listing + v["given"]["statuses"].arr()!!.map { JsonObject(mapOf("node_id" to node, "envelope" to JsonNull, "status" to it)) }
        }
        for (name in listingVectors) {
            val v = vector(name)
            val check = Leases.checkListing(entries(v), pin(v), s(v["given"], "nonce"), s(v["given"], "device_id"))
            assertEquals(name, v["expect"]["accepted"].bool(), check.accepted)
            assertEquals(name, v["expect"]["reason"].str(), check.reason)
        }
        val live = vector("listing-live")
        val nonce = s(live["given"], "nonce")
        val device = s(live["given"], "device_id")
        // The listing left out (an offline, slow or older node looks the same): no answer, whatever statuses came.
        assertEquals(ListingCheck(false, "no_listing", emptyList()), Leases.checkListing(entries(live, withListing = false), pin(live), nonce, device))
        assertEquals("no_listing", Leases.checkListing(emptyList(), pin(live), nonce, device).reason)
        // Entries listed under another node are not this node's answer.
        assertEquals("no_listing", Leases.checkListing(entries(live, nodeId = "kl-aaaaaaaaaaaaaaaa"), pin(live), nonce, device).reason)
        // An entry that carries a request is not part of a listing.
        val withRequest = listOf(JsonObject(mapOf("node_id" to JsonPrimitive(pin(live).id), "envelope" to live["input"]!!, "status" to JsonNull, "listing" to live["input"]!!)))
        assertEquals("no_listing", Leases.checkListing(withRequest, pin(live), nonce, device).reason)
        // A nonce this phone did not choose, and no nonce at all.
        assertEquals("nonce_mismatch", Leases.checkListing(entries(live), pin(live), nonce.reversed(), device).reason)
        assertEquals("nonce_mismatch", Leases.checkListing(entries(live), pin(live), "", device).reason)
        // What the owner is told never says nothing is running, and the node's name is escaped.
        assertEquals("Could not confirm with gpu-box", Leases.couldNotConfirm("gpu-box"))
        assertTrue(!Leases.couldNotConfirm("gpu\u202Ebox").contains('\u202E'))
        assertTrue(Leases.COULD_NOT_CONFIRM_DETAIL.contains("A lease could be running"))
    }

    @Test
    fun grants() {
        for (name in listOf("grant-valid", "grant-narrowed", "resume-capped")) {
            assertBuilds(name) { v, e ->
                Leases.grant(request(v), e["grant"]["apps"].arr()!!.map { it.str()!! }, e["grant"]["minutes"].int()!!, s(e, "device_id"), s(e, "signed_at"))
            }
        }
        assertTrue(request(vector("resume-capped")).isResume)
    }

    @Test
    fun deny() {
        assertBuilds("deny-valid") { v, e -> Leases.deny(request(v), s(e, "device_id"), s(e, "signed_at")) }
    }

    @Test
    fun revokeAndWatch() {
        assertBuilds("revoke-valid") { _, e -> Leases.revoke(s(e, "node_id"), s(e, "lease_id"), s(e, "reason"), s(e, "device_id"), s(e, "nonce"), s(e, "signed_at")) }
        // With the token of the newest status or view applied, and with none (null in the message).
        for (name in listOf("watch-valid", "watch-no-token")) {
            assertBuilds(name) { _, e -> Leases.watch(s(e, "node_id"), s(e, "lease_id"), s(e, "device_id"), e["contact_token"].str(), s(e, "nonce"), s(e, "signed_at")) }
        }
        assertNotNull(vector("watch-valid")["expect"]["message"]["contact_token"].str())
        assertEquals(JsonNull, vector("watch-no-token")["expect"]["message"]["contact_token"])
    }

    /** R-F5-15: a status the pinned node signed gives the token the next watch echoes. */
    @Test
    fun statuses() {
        for (name in listOf("status-valid", "status-no-contact", "status-pending", "status-granted-unnamed")) {
            val v = vector(name)
            val message = Leases.verifiedMessage(Envelope.fromJson(v["input"]!!), pin(v)) ?: error("$name verifies against the node pin")
            val status = LeaseStatus.from(message) ?: error("$name parses")
            val expect = v["expect"]["status"]
            assertEquals(name, expect["lease_id"].str(), status.leaseId)
            assertEquals(name, expect["seq"].int(), status.seq)
            assertEquals(name, expect["state"].str(), status.state)
            assertEquals(name, expect["reason"].str(), status.reason)
            assertEquals(name, expect["contact_token"].str(), status.contactToken)
            assertEquals(name, name == "status-no-contact", Leases.isPausedForContact(status.state, status.reason))
            // R-F5-18: who granted it (nobody, a named phone, a phone the node gave no name for).
            assertEquals(name, expect["granted_by"]["device_id"].str(), status.grantedByDevice)
            assertEquals(name, expect["granted_by"]["name"].str(), status.grantedByName)
            assertEquals(name, name != "status-pending", Leases.isLive(status.state))
        }
        // Signed by another node's key: not a status of this pin.
        val v = vector("status-valid")
        val other = NodePin(pin(v).id, pin(v).name, pin(v).key.reversed())
        assertNull(Leases.verifiedMessage(Envelope.fromJson(v["input"]!!), other))
    }

    @Test
    fun views() {
        for (name in listOf("view-node-sig-valid", "view-tampered-frame")) {
            val v = vector(name)
            val r = Leases.verifyView(Envelope.fromJson(v["input"]!!), pin(v))
            assertEquals(name, v["expect"]["accepted"].bool(), r.accepted)
            assertEquals(name, v["expect"]["reason"].str(), r.reason)
        }
        val ok = vector("view-node-sig-valid")
        val view = Leases.verifyView(Envelope.fromJson(ok["input"]!!), pin(ok)).view
        assertEquals("Type", view?.actions?.first()?.tool)
        assertNotNull(view?.frame)
        assertEquals(ok["expect"]["contact_token"].str(), view?.contactToken)
    }

    @Test
    fun refusesWhatTheNodeWouldRefuse() {
        val req = request(vector("grant-valid"))
        for (bad in listOf<() -> Unit>(
            { Leases.grant(req, emptyList(), 5, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") },
            { Leases.grant(req, listOf("calculator"), req.maxMinutes + 1, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") },
            { Leases.grant(req, listOf("terminal"), 5, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z") }
        )) {
            try {
                bad()
                fail("expected a ProtocolException")
            } catch (e: ProtocolException) {
                // refused before anything is signed
            }
        }
        // A request whose lease was changed after signing does not parse (lease_hash).
        val message = Leases.verifiedMessage(Envelope.fromJson(vector("grant-valid")["given"]["request"]!!), pin(vector("grant-valid")))!!
        val lease = message["lease"].obj()!!
        val changed = JsonObject(message + ("lease" to JsonObject(lease + ("max_minutes" to JsonPrimitive(60)))))
        assertNull(LeaseRequest.from(changed))
    }

    @Test
    fun demoLeaseRequestParses() {
        val fleet = DemoFleet()
        val envelope = fleet.leaseRequest(0, listOf("calculator"), 15)
        val message = Leases.verifiedMessage(envelope, fleet.pins[0])!!
        assertEquals("calculator", LeaseRequest.from(message)?.apps?.first()?.id)
    }
}
