package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
                "status-valid", "status-no-contact", "status-pending", "status-granted-unnamed", "view-node-sig-valid", "view-tampered-frame",
                // Revised 2026-10-24: the take lease.
                "take-grant", "take-grant-minutes-over-cap", "take-request-missing-name", "computer-use-with-unattended", "status-take"
            ) + listingVectors + readKeyVectors + taskRequestsAccepted + taskRequestsRefused + taskGrantsBuilt + taskGrantsRefused + taskStatuses,
            names
        )
    }

    // Revised 2026-11-03: the task lease (tasks stage 1 spec §4.6, §4.9).
    private val taskRequestsAccepted = listOf("task-request", "task-request-read-only")
    private val taskRequestsRefused = listOf(
        "task-request-allows-unsorted", "task-request-allows-repeated", "task-request-allows-unknown", "task-request-resumes",
        "task-request-sites-over-32", "task-request-bad-site", "task-request-usd-under", "task-request-usd-over", "task-request-usd-fraction",
        "task-request-attended", "task-request-minutes-over-240", "task-request-with-apps", "task-request-name-hidden", "task-request-name-too-long"
    )
    private val taskGrantsBuilt = listOf("task-grant", "task-grant-ignores-take-cap")
    private val taskGrantsRefused = listOf(
        "task-grant-with-apps", "task-grant-minutes-over-requested", "task-grant-minutes-over-240", "computer-use-grant-no-apps", "take-grant-no-apps"
    )
    private val taskStatuses = listOf("task-status", "task-status-no-name")

    // Revised 2026-10-28: the read key (android-slim spec §8.8), run by
    // watchSignedWithTheReadKey below.
    private val readKeyVectors = setOf("watch-read-key")

    private val listingVectors = setOf(
        "listing-none", "listing-live", "listing-nonce-mismatch", "listing-status-withheld", "listing-status-stale",
        "listing-other-device", "listing-bad-signature",
        // Fourth security review: another pinned node's listing, an extra status beside one, and the shape.
        "listing-other-node", "listing-wrong-node", "listing-extra-status", "listing-duplicate-lease",
        "listing-too-many", "listing-extra-key", "listing-bad-at"
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
        // An extra signed status beside the listing is not part of it.
        assertEquals(2, vector("listing-extra-status")["given"]["statuses"].arr()!!.size)
        assertEquals(1, vector("listing-extra-status")["expect"]["leases"].arr()!!.size)
    }

    /**
     * Fourth security review: the shape of a listing, as the node's validator
     * has it. The four vectors are signed by the node, so it is the shape
     * alone that refuses them; and each rule is tried by hand.
     */
    @Test
    fun listingShape() {
        for (name in listOf("listing-duplicate-lease", "listing-too-many", "listing-extra-key", "listing-bad-at")) {
            val v = vector(name)
            val envelope = Envelope.fromJson(v["input"]!!)
            assertTrue(name, envelope.verifyEd25519(pin(v).key))
            assertTrue(name, !Leases.isListing(envelope.message()))
        }
        val good = Envelope.fromJson(vector("listing-live")["input"]!!).message()
        assertTrue(Leases.isListing(good))
        assertTrue(Leases.isListing(Envelope.fromJson(vector("listing-none")["input"]!!).message()))
        assertEquals(8, Leases.LISTING_MAX)
        fun changed(key: String, value: JsonElement?): JsonElement =
            JsonObject(if (value == null) good.obj()!!.filterKeys { it != key } else good.obj()!! + (key to value))
        val entry = good["leases"].arr()!![0]
        fun leases(entries: List<JsonElement>): JsonElement = changed("leases", JsonArray(entries))
        fun entryWith(key: String, value: JsonElement?): JsonElement =
            JsonObject(if (value == null) entry.obj()!!.filterKeys { it != key } else entry.obj()!! + (key to value))
        val bad = listOf(
            "a key missing" to changed("at", null), "a key too many" to changed("note", JsonPrimitive("x")),
            "v 2" to changed("v", JsonPrimitive(2)), "another type" to changed("type", JsonPrimitive("kl.lease.status")),
            "node id" to changed("node_id", JsonPrimitive("gpu-box")), "device id" to changed("to_device", JsonPrimitive("phone")),
            "nonce" to changed("nonce", JsonPrimitive("short")), "at: not a time" to changed("at", JsonPrimitive("now")),
            "at: no such day" to changed("at", JsonPrimitive("2026-02-30T18:04:11.201Z")), "at: a number" to changed("at", JsonPrimitive(1)),
            "leases: not a list" to changed("leases", JsonObject(emptyMap())),
            "the same lease twice" to leases(listOf(entry, entry)),
            "nine leases" to leases(List(9) { entry }),
            "an entry that is not an object" to leases(listOf(JsonPrimitive("x"))),
            "an entry with a key too many" to leases(listOf(entryWith("state", JsonPrimitive("active")))),
            "an entry with no seq" to leases(listOf(entryWith("seq", null))),
            "seq 0" to leases(listOf(entryWith("seq", JsonPrimitive(0)))), "seq 1.5" to leases(listOf(entryWith("seq", JsonPrimitive(1.5)))),
            "seq as text" to leases(listOf(entryWith("seq", JsonPrimitive("7")))),
            "lease id" to leases(listOf(entryWith("lease_id", JsonPrimitive("lease-1")))),
            "not an object" to JsonArray(emptyList())
        )
        for ((why, message) in bad) assertTrue(why, !Leases.isListing(message))
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
        // A take is built like any grant; the admin's take cap (120 in the second) is the node's to refuse.
        for (name in listOf("grant-valid", "grant-narrowed", "resume-capped", "take-grant", "take-grant-minutes-over-cap")) {
            assertBuilds(name) { v, e ->
                Leases.grant(request(v), e["grant"]["apps"].arr()!!.map { it.str()!! }, e["grant"]["minutes"].int()!!, s(e, "device_id"), s(e, "signed_at"))
            }
        }
        assertTrue(request(vector("resume-capped")).isResume)
        assertFalse(request(vector("resume-capped")).isTake)
        val take = request(vector("take-grant"))
        assertTrue(take.isTake)
        assertEquals("BSEOA in ChatGPT", take.name)
        assertEquals(listOf("chatgpt.com", "*.chatgpt.com"), take.sites)
        assertNull(take.browserActions)
        assertFalse(take.credentials)
        assertTrue(take.unattended)
        assertEquals(180, take.maxMinutes)
        // The phone's cap is the request's, and never past 240 for a take.
        try {
            Leases.grant(take, listOf("notepad"), 181, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z")
            fail("expected a ProtocolException")
        } catch (e: ProtocolException) {
            // refused before anything is signed
        }
        assertEquals(240, Leases.TAKE_MAX_MINUTES)
        assertEquals(60, Leases.MAX_MINUTES)
    }

    /** Revised 2026-10-24: a node-signed request whose lease has the wrong keys for its kind is not read. */
    @Test
    fun requestsWithTheWrongKeysForTheirKind() {
        for (name in listOf("take-request-missing-name", "computer-use-with-unattended")) {
            val v = vector(name)
            val message = Leases.verifiedMessage(Envelope.fromJson(v["input"]!!), pin(v)) ?: error("$name verifies against the node pin")
            assertNull(name, LeaseRequest.from(message))
            assertFalse(name, Leases.isLease(message["lease"]))
            assertEquals(name, "malformed", v["expect"]["reason"].str())
        }
        val given = vector("take-grant")
        val lease = Leases.verifiedMessage(Envelope.fromJson(given["given"]["request"]!!), pin(given))!!["lease"].obj()!!
        assertTrue(Leases.isLease(lease))
        fun leaseWith(key: String, value: JsonElement?): JsonObject = JsonObject(if (value == null) lease - key else lease + (key to value))
        val bad = listOf(
            "an unknown kind" to leaseWith("kind", JsonPrimitive("screen")), "no name" to leaseWith("name", null),
            "an empty name" to leaseWith("name", JsonPrimitive("")), "a name of 61" to leaseWith("name", JsonPrimitive("a".repeat(61))),
            "a line break" to leaseWith("name", JsonPrimitive("a\nb")), "two spaces" to leaseWith("name", JsonPrimitive("a  b")),
            "a no-break space" to leaseWith("name", JsonPrimitive("a\u00A0b")), "a bidi override" to leaseWith("name", JsonPrimitive("a\u202Eb")),
            "an object replacement" to leaseWith("name", JsonPrimitive("a\uFFFCb")),
            "four combining marks" to leaseWith("name", JsonPrimitive("a\u0301\u0301\u0301\u0301")),
            "no sites" to leaseWith("sites", JsonArray(emptyList())), "an upper-case host" to leaseWith("sites", JsonArray(listOf(JsonPrimitive("Example.com")))),
            "a bare label" to leaseWith("sites", JsonArray(listOf(JsonPrimitive("localhost")))), "a path" to leaseWith("sites", JsonArray(listOf(JsonPrimitive("example.com/x")))),
            "browser false" to leaseWith("browser", JsonPrimitive(false)), "browser empty" to leaseWith("browser", JsonArray(emptyList())),
            "an empty browser action" to leaseWith("browser", JsonArray(listOf(JsonPrimitive("")))),
            "credentials not a boolean" to leaseWith("credentials", JsonPrimitive("no")), "unattended not a boolean" to leaseWith("unattended", JsonNull),
            "241 minutes" to leaseWith("max_minutes", JsonPrimitive(241))
        )
        for ((why, value) in bad) assertFalse(why, Leases.isLease(value))
        assertTrue(Leases.isLease(leaseWith("name", JsonPrimitive("a\u0301\u0301\u0301"))))
        assertTrue(Leases.isLease(leaseWith("browser", JsonArray(listOf(JsonPrimitive("navigate"), JsonPrimitive("click"))))))
        assertTrue(Leases.isLease(leaseWith("max_minutes", JsonPrimitive(240))))
    }

    private fun taskCard(name: String): LeaseRequest = vector(name).let { LeaseRequest.from(Leases.verifiedMessage(Envelope.fromJson(it["input"]!!), pin(it))!!)!! }

    /** A task's request: no apps, its own sites, allows and usd; empty allows is the card that raises a look-only task's spend. */
    @Test
    fun taskRequests() {
        for (name in taskRequestsAccepted) {
            val r = taskCard(name)
            assertTrue(name, r.isTask)
            assertFalse(name, r.isTake)
            assertFalse(name, r.isResume)
            assertTrue(name, r.apps.isEmpty())
            assertEquals(name, "Find a dentist", r.name)
            assertEquals(name, listOf("*.example.com"), r.sites)
            assertEquals(name, 2, r.usd)
            assertEquals(name, 20, r.maxMinutes)
            assertTrue(name, r.unattended)
        }
        assertEquals(listOf("browser-act"), taskCard("task-request").allows)
        assertTrue(taskCard("task-request-read-only").allows.isEmpty())
        for (name in taskRequestsRefused) {
            val v = vector(name)
            val message = Leases.verifiedMessage(Envelope.fromJson(v["input"]!!), pin(v)) ?: error("$name verifies against the node pin")
            assertNull(name, LeaseRequest.from(message))
            assertFalse(name, Leases.isLease(message["lease"]))
            assertEquals(name, "malformed", v["expect"]["reason"].str())
        }
        assertEquals(500, Leases.TASK_USD_MAX)
        assertEquals(2, Leases.TASK_USD_MIN)
        assertEquals(listOf("browser-act", "files-write", "logins", "shell"), Leases.TASK_ALLOWS)
    }

    /** The card, in the spec's order, host-built from the signed fields. Nothing is cut: the owner approves what it shows. */
    @Test
    fun taskCard() {
        assertEquals(
            listOf(
                "Task: Find a dentist", "Sites: *.example.com", "May: click and type in your signed-in browser",
                "For: 20 minutes", "Spend up to \$2", "Node: gpu-box"
            ),
            Leases.taskLines(taskCard("task-request"))
        )
        assertEquals("May: read only", Leases.taskLines(taskCard("task-request-read-only"))[2])
        val base = taskCard("task-request")
        val sites = List(16) { "s$it.example.com" }
        val all = base.copy(sites = sites, allows = listOf("browser-act", "files-write", "logins", "shell"), usd = 500, maxMinutes = 240)
        assertEquals(
            listOf(
                "Task: Find a dentist", "Sites: " + sites.joinToString(", "),
                "May: click and type in your signed-in browser, sign in with saved logins, run shell commands, write files",
                "For: 240 minutes", "Spend up to \$500", "Node: gpu-box"
            ),
            Leases.taskLines(all)
        )
        // No sites (a shell-only grant): the line is left out.
        assertEquals(
            listOf("Task: Find a dentist", "May: run shell commands", "For: 20 minutes", "Spend up to \$2", "Node: gpu-box"),
            Leases.taskLines(base.copy(sites = emptyList(), allows = listOf("shell")))
        )
        // The name the phone pinned, when the screen has it; escaped whichever it is.
        assertEquals("Node: pinned-name", Leases.taskLines(base, "pinned-name").last())
        assertFalse(Leases.taskLines(base, "gpu\u202Ebox").last().contains('\u202E'))
        assertEquals("Task on gpu-box: Find a dentist", Leases.taskTitle("gpu-box", "Find a dentist"))
        assertFalse(Leases.taskTitle("gpu\u202Ebox", "Find a dentist").contains('\u202E'))
        assertEquals("Task on gpu-box ended: Find a dentist (spend_cap)", Leases.taskEnded("gpu-box", "Find a dentist", "spend_cap"))
        assertEquals("Task on gpu-box ended: Find a dentist", Leases.taskEnded("gpu-box", "Find a dentist", null))
        assertFalse(Leases.taskEnded("gpu-box", "Find a dentist", "odd\u202Ereason").contains('\u202E'))
    }

    /** Fix round 1: one minute is reachable, every class has its words, a class with none is not read, and a pending task says task. */
    @Test
    fun taskWords() {
        val base = taskCard("task-request")
        assertEquals("For: 1 minute", Leases.taskLines(base.copy(maxMinutes = 1))[3])
        assertEquals("For: 2 minutes", Leases.taskLines(base.copy(maxMinutes = 2))[3])
        for (allow in Leases.TASK_ALLOWS) assertNotNull(allow, Leases.taskMayWords(allow))
        assertNull(Leases.taskMayWords("desktop-input"))
        val lease = Envelope.fromJson(vector("task-request")["input"]!!).message()["lease"].obj()!!
        assertFalse(Leases.isLease(JsonObject(lease + ("allows" to JsonArray(listOf(JsonPrimitive("desktop-input")))))))
        assertEquals(Leases.TASK_REQUEST_WAITING_DETAIL, Leases.pendingDetail(false, task = true))
        assertTrue(Leases.TASK_REQUEST_WAITING_DETAIL.contains("a request for a task"))
        assertFalse(Leases.TASK_REQUEST_WAITING_DETAIL.contains("computer use"))
        assertEquals(Leases.MAY_STILL_START_DETAIL, Leases.pendingDetail(true, task = true))
        assertEquals(Leases.REQUEST_WAITING_DETAIL, Leases.pendingDetail(false))
    }

    /** Fix round 1: what Stop's prompt may read of a status its pinned node signed. The name only when it is one plain line. */
    @Test
    fun taskStopPrompt() {
        fun signed(name: String) = vector(name).let { Leases.verifiedMessage(Envelope.fromJson(it["input"]!!), pin(it))!! }
        val task = signed("task-status")
        assertTrue(Leases.isTaskStatus(task))
        assertEquals("Find a dentist", Leases.taskStopName(task))
        // A task with no readable name is still a task: its prompt names the node alone.
        val noName = signed("task-status-no-name")
        assertTrue(Leases.isTaskStatus(noName))
        assertNull(Leases.taskStopName(noName))
        assertNull(Leases.taskStopName(JsonObject(task + ("name" to JsonPrimitive("Find\u200Ba dentist")))))
        assertNull(Leases.taskStopName(JsonObject(task + ("name" to JsonPrimitive("x".repeat(61))))))
        assertFalse(Leases.isTaskStatus(signed("status-take")))
        assertFalse(Leases.isTaskStatus(signed("status-valid")))
        assertFalse(Leases.isTaskStatus(null))
        assertNull(Leases.taskStopName(null))
    }

    /** A task's grant names no apps and the minutes the card shows; anything else is refused before it is signed. */
    @Test
    fun taskGrants() {
        for (name in taskGrantsBuilt) {
            assertBuilds(name) { v, e ->
                assertEquals(name, 0, e["grant"]["apps"].arr()!!.size)
                Leases.grant(request(v), emptyList(), request(v).maxMinutes, s(e, "device_id"), s(e, "signed_at"))
            }
        }
        for (name in taskGrantsRefused) {
            val v = vector(name)
            val e = v["expect"]["message"]!!
            try {
                Leases.grant(request(v), e["grant"]["apps"].arr()!!.map { it.str()!! }, e["grant"]["minutes"].int()!!, s(e, "device_id"), s(e, "signed_at"))
                fail("$name: expected a ProtocolException")
            } catch (ex: ProtocolException) {
                // refused before anything is signed
            }
        }
        // Fewer minutes than the card shows is no grant of a task either.
        val task = request(vector("task-grant"))
        try {
            Leases.grant(task, emptyList(), task.maxMinutes - 1, "d-aaaaaaaaaaaaaaaa", "2026-09-23T18:04:16.201Z")
            fail("expected a ProtocolException")
        } catch (ex: ProtocolException) {
            // refused before anything is signed
        }
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

    /** android-slim §8.5: the read key signs a watch the phone builds as today; it verifies against the read key only. */
    @Test
    fun watchSignedWithTheReadKey() {
        assertBuilds("watch-read-key") { _, e -> Leases.watch(s(e, "node_id"), s(e, "lease_id"), s(e, "device_id"), e["contact_token"].str(), s(e, "nonce"), s(e, "signed_at")) }
        val v = vector("watch-read-key")
        assertEquals("read", v["expect"]["key"].str())
        val envelope = Envelope.fromJson(v["input"]!!)
        val signer = v["given"]["approvers"].arr()!!.single { it["device_id"].str() == envelope.kid }
        assertEquals(v["expect"]["message"]["device_id"].str(), envelope.kid)
        assertTrue(envelope.verifyEs256(s(signer["read_key"], "x"), s(signer["read_key"], "y")))
        assertFalse(envelope.verifyEs256(s(signer["public_key"], "x"), s(signer["public_key"], "y")))
        // The same message as watch-valid's, key for key.
        assertEquals(vector("watch-valid")["expect"]["message"].obj()!!.keys, v["expect"]["message"].obj()!!.keys)
    }

    /** R-F5-15: a status the pinned node signed gives the token the next watch echoes. */
    @Test
    fun statuses() {
        for (name in listOf("status-valid", "status-no-contact", "status-pending", "status-granted-unnamed", "status-take", "task-status")) {
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
            // Revised 2026-10-24: every status says its kind, whether it runs unattended, and a take's name.
            assertEquals(name, expect["kind"].str() ?: "computer_use", status.kind)
            assertEquals(name, expect["unattended"].bool() ?: false, status.unattended)
            assertEquals(name, expect["name"].str(), status.name)
        }
        // The three must agree: computer_use is never unattended and has no name; a take has a name.
        val plainVector = vector("status-valid")
        val plain = Leases.verifiedMessage(Envelope.fromJson(plainVector["input"]!!), pin(plainVector))!!
        fun status(vararg changes: Pair<String, JsonElement?>): LeaseStatus? {
            var o: Map<String, JsonElement> = plain
            for ((k, value) in changes) o = if (value == null) o - k else o + (k to value)
            return LeaseStatus.from(JsonObject(o))
        }
        assertNotNull(status())
        assertNull(status("unattended" to JsonPrimitive(true)))
        assertNull(status("name" to JsonPrimitive("A take")))
        assertNull(status("kind" to JsonPrimitive("take")))
        assertNotNull(status("kind" to JsonPrimitive("take"), "name" to JsonPrimitive("A take"), "unattended" to JsonPrimitive(true)))
        assertNotNull(status("kind" to JsonPrimitive("take"), "name" to JsonPrimitive("A take"), "unattended" to JsonPrimitive(false)))
        assertNull(status("kind" to JsonPrimitive("take"), "name" to JsonPrimitive("A  take"), "unattended" to JsonPrimitive(true)))
        assertNull(status("kind" to JsonPrimitive("screen")))
        // Revised 2026-11-03: a task as a take: a name, and unattended allowed.
        assertNull(status("kind" to JsonPrimitive("task")))
        assertNotNull(status("kind" to JsonPrimitive("task"), "name" to JsonPrimitive("A task"), "unattended" to JsonPrimitive(true)))
        assertNull(LeaseStatus.from(vector("task-status-no-name").let { Leases.verifiedMessage(Envelope.fromJson(it["input"]!!), pin(it))!! }))
        assertNull(status("kind" to null))
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
