package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Spec 2026-10-28-android-app-slim-design.md §7.1 to §7.5, §10 (C-11, C-12, C-18, C-20). */
class ApprovalListTest {
    private val grantVectors = File(System.getProperty("kl.grantVectors") ?: error("run through Gradle: kl.grantVectors is not set"))
    private fun vector(name: String): JsonElement = JsonText.parse(File(grantVectors, "$name.json").readBytes())

    private val gpu = NodePin("kl-node-gpu", "gpu-box", "00")
    private val web = NodePin("kl-node-web", "web-01", "00")
    private val me = "d-this-phone"
    private val now = 1_800_000_000_000L
    private val time: (Long) -> String = { "T$it" }

    private fun input(
        toolApprovals: List<ApprovalList.ToolApproval> = emptyList(),
        questions: List<ApprovalList.Question> = emptyList(),
        leaseRequests: List<ApprovalList.LeaseRequestItem> = emptyList(),
        clientConnections: List<ApprovalList.ClientConnection> = emptyList(),
        nodePairings: List<ApprovalList.NodePairing> = emptyList(),
        alerts: List<ApprovalList.Alert> = emptyList(),
        runningLeases: List<ApprovalList.RunningLease> = emptyList(),
        nodes: List<NodePin> = listOf(gpu, web),
        nodeChecks: Map<String, ApprovalList.NodeCheck> = mapOf(gpu.id to ApprovalList.NodeCheck.Confirmed(now, 0, 0), web.id to ApprovalList.NodeCheck.Confirmed(now, 0, 0)),
        overflowing: Set<String> = emptySet(),
        pushOn: Boolean = false
    ) = ApprovalList.Input(
        toolApprovals = toolApprovals, questions = questions, leaseRequests = leaseRequests, clientConnections = clientConnections,
        nodePairings = nodePairings, alerts = alerts, runningLeases = runningLeases, nodes = nodes, nodeChecks = nodeChecks,
        thisDevice = me, relayNowMs = now, frontDoorName = "kl.example.com", overflowing = overflowing, pushOn = pushOn,
        formatTime = time, formatDateTime = time
    )

    private fun tool(id: String, node: String, leftMs: Long, kind: String = "tool", summary: String = "Bash(ls)", sending: Boolean = false, decided: ApprovalList.Decided? = null) =
        ApprovalList.ToolApproval(
            requestId = id,
            display = JsonObject(
                mapOf(
                    "node" to JsonObject(mapOf("id" to jsonString("kl-$node"), "name" to jsonString(node))),
                    "kind" to jsonString(kind), "name" to jsonString("Bash"), "summary" to jsonString(summary)
                )
            ),
            timeLeftMs = leftMs, sending = sending, decided = decided
        )

    private fun question(token: String, urgency: String = "normal", kind: String = "question", options: List<QuestionOption> = emptyList()) =
        ApprovalList.Question(QuestionItem(token, gpu.id, gpu.name, "case-1", "q-$token", "Lakeside lot", kind, urgency, "Which agent?", options))

    private fun leaseRequest(
        id: String, leftMs: Long, kind: String = "computer_use", resumes: String? = null, limits: List<String> = emptyList(),
        name: String? = null, credentials: Boolean = false, unattended: Boolean = false, minutes: Int = 15
    ) = ApprovalList.LeaseRequestItem(
        LeaseRequest(
            requestId = id, leaseId = "lease-$id", nodeId = gpu.id, nodeName = gpu.name, jobId = "job-1",
            apps = listOf(LeaseApp("calculator", "Calculator", "C:\\calc.exe", emptyList()), LeaseApp("notepad", "Notepad", "C:\\np.exe", emptyList())),
            maxMinutes = minutes, reason = "Enter the totals", resumes = resumes, limits = limits, originClient = "stdio", leaseHash = "h", nonce = "n",
            createdAt = "2027-01-15T08:00:00.000Z", expiresAt = "2027-01-15T08:05:00.000Z", kind = kind, name = name,
            sites = if (kind == "take") listOf("example.com") else emptyList(), credentials = credentials, unattended = unattended
        ),
        nodeName = gpu.name, timeLeftMs = leftMs
    )

    private fun grant(leftMs: Long): ApprovalList.ClientConnection {
        val v = vector("grant-approve")
        val reply = JsonObject(v["given"]["pending"].obj()!!.filterKeys { it !in setOf("user_code", "expires_at", "claimed_by", "used_nonces") } +
            mapOf("preselected" to kotlinx.serialization.json.JsonArray(listOf(jsonString("fleet:read"))), "expires_in_ms" to jsonNumber("280000")))
        return ApprovalList.ClientConnection(GrantRequest(reply), "Q7KM2X", timeLeftMs = leftMs)
    }

    private fun pairing(leftMs: Long, replaces: Boolean = false): ApprovalList.NodePairing {
        val e = vector("enroll-valid")
        val base = e["given"]["pairing"].obj()!!.filterKeys { it !in setOf("expires_at", "used_nonces") } + ("expires_in_ms" to jsonNumber("500000"))
        val entry = JsonObject(if (replaces) base + ("replaces" to base["node_id"]!!) else base)
        return ApprovalList.NodePairing(PairingRequest(entry), timeLeftMs = leftMs)
    }

    private fun alert(id: String, at: String, acked: Boolean = false) = ApprovalList.Alert(
        JsonObject(
            mapOf(
                "id" to jsonString(id), "kind" to jsonString("audit_break"), "subject" to jsonString("web-01"),
                "detail" to JsonObject(mapOf("reason" to jsonString("fork"))), "at" to jsonString(at), "acked" to JsonPrimitive(acked)
            )
        )
    )

    private fun lease(
        id: String, state: String, reason: String? = null, expiresAt: String? = "2027-01-15T09:00:00.000Z", grantedBy: String? = me,
        grantedByName: String? = null, kind: String = "computer_use", unattended: Boolean = false, name: String? = null,
        signedGrant: Boolean = false, pin: NodePin = gpu
    ) = ApprovalList.RunningLease(
        LeaseStatus(id, pin.id, 3, state, false, reason, expiresAt, "tok", grantedBy, grantedByName, kind, unattended, name),
        nodeName = pin.name, signedGrant = signedGrant
    )

    private fun ms(iso: String) = Timestamps.epochMillis(iso)!!

    // ---- §7.2 rows ----

    @Test
    fun toolApprovalRow() {
        val row = ApprovalList.build(input(toolApprovals = listOf(tool("r1", "gpu-box", 60_000, summary = "Bash(rm -rf build)")))).rows.single()
        assertEquals(ApprovalList.Kind.TOOL_APPROVAL, row.kind)
        assertEquals("tool:r1", row.id)
        assertEquals("r1", row.ref)
        assertEquals("gpu-box", row.nodeName)
        assertEquals("Tool approval", row.label)
        assertEquals("Bash(rm -rf build)", row.summary)
        assertEquals(60_000L, row.timeLeftMs)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), row.buttons)
        assertTrue(row.enabled)
        assertNull(row.status)
        assertEquals("Runbook", ApprovalList.build(input(toolApprovals = listOf(tool("r2", "gpu-box", 1, kind = "runbook")))).rows.single().label)
        assertEquals("Envelope", ApprovalList.build(input(toolApprovals = listOf(tool("r3", "gpu-box", 1, kind = "envelope")))).rows.single().label)
    }

    @Test
    fun aSummaryThatDoesNotFitAsksForReview() {
        val row = ApprovalList.build(input(toolApprovals = listOf(tool("r1", "gpu-box", 60_000)), overflowing = setOf("tool:r1"))).rows.single()
        assertEquals(listOf(ApprovalList.Button.REVIEW, ApprovalList.Button.DENY), row.buttons)
    }

    @Test
    fun aRowBeingSentSaysSendingAndIsDisabled() {
        val row = ApprovalList.build(input(toolApprovals = listOf(tool("r1", "gpu-box", 60_000, sending = true)))).rows.single()
        assertEquals("Sending…", row.status)
        assertFalse(row.enabled)
        val expired = ApprovalList.build(input(toolApprovals = listOf(tool("r2", "gpu-box", 0)))).rows.single()
        assertFalse(expired.enabled)
    }

    @Test
    fun leaseRequestRows() {
        val cu = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("a", 1000)))).rows.single()
        assertEquals(ApprovalList.Kind.LEASE_REQUEST, cu.kind)
        assertEquals("Computer use", cu.label)
        assertEquals("Calculator, Notepad · 15 min", cu.summary)
        assertEquals("gpu-box", cu.nodeName)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), cu.buttons)

        val take = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("b", 1000, kind = "take", name = "Quarterly demo", unattended = true, minutes = 90)))).rows.single()
        assertEquals("Take", take.label)
        assertEquals("Quarterly demo · 90 min · unattended", take.summary)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), take.buttons)
        val attended = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("c", 1000, kind = "take", name = "Demo", minutes = 30)))).rows.single()
        assertEquals("Demo · 30 min", attended.summary)

        val resume = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("d", 1000, resumes = "lease-x", minutes = 7)))).rows.single()
        assertEquals("Resume", resume.label)
        assertEquals("Resume computer use · 7 min left", resume.summary)
    }

    @Test
    fun leaseRequestExceptionsAskForReview() {
        val review = listOf(ApprovalList.Button.REVIEW, ApprovalList.Button.DENY)
        assertEquals(review, ApprovalList.build(input(leaseRequests = listOf(leaseRequest("a", 1000, limits = listOf("no_lock_detect"))))).rows.single().buttons)
        assertEquals(review, ApprovalList.build(input(leaseRequests = listOf(leaseRequest("b", 1000, kind = "take", name = "Demo", credentials = true)))).rows.single().buttons)
        assertEquals(review, ApprovalList.build(input(leaseRequests = listOf(leaseRequest("c", 1000)), overflowing = setOf("lease-request:c"))).rows.single().buttons)
    }

    @Test
    fun clientConnectionRow() {
        val row = ApprovalList.build(input(clientConnections = listOf(grant(90_000)))).rows.single()
        assertEquals(ApprovalList.Kind.CLIENT_CONNECTION, row.kind)
        assertEquals("Client connection", row.label)
        assertEquals("Example Client (self-declared) · fleet:read, fleet:run", row.summary)
        assertEquals("kl.example.com", row.nodeName)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), row.buttons)
        assertEquals(90_000L, row.timeLeftMs)
    }

    @Test
    fun nodePairingRow() {
        val p = pairing(90_000)
        val row = ApprovalList.build(input(nodePairings = listOf(p))).rows.single()
        assertEquals(ApprovalList.Kind.NODE_PAIRING, row.kind)
        assertEquals("Node pairing", row.label)
        assertEquals("${p.request.nodeName} (${p.request.profile})", row.summary)
        assertEquals(p.request.fingerprint, row.secondLine)
        assertTrue(row.secondLineMonospace)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), row.buttons)
        val replacing = ApprovalList.build(input(nodePairings = listOf(pairing(90_000, replaces = true)))).rows.single()
        assertEquals(listOf(ApprovalList.Button.REVIEW, ApprovalList.Button.DENY), replacing.buttons)
    }

    @Test
    fun questionRows() {
        val q = ApprovalList.build(input(questions = listOf(question("t1")))).rows.single()
        assertEquals(ApprovalList.Kind.QUESTION, q.kind)
        assertEquals("Question", q.label)
        assertEquals("Lakeside lot: Which agent?", q.summary)
        assertEquals("gpu-box", q.nodeName)
        assertNull(q.timeLeftMs)
        assertEquals(listOf(ApprovalList.Button.OPEN), q.buttons)
        val briefing = ApprovalList.build(input(questions = listOf(question("t2", kind = "briefing")))).rows.single()
        assertEquals(listOf(ApprovalList.Button.GOT_IT), briefing.buttons)
    }

    @Test
    fun alertRows() {
        val rows = ApprovalList.build(input(alerts = listOf(alert("a1", "2027-01-15T08:00:00.000Z"), alert("a2", "2027-01-15T08:01:00.000Z", acked = true)))).rows
        val row = rows.single()
        assertEquals(ApprovalList.Kind.ALERT, row.kind)
        assertEquals("Alert", row.label)
        assertEquals("audit_break: web-01", row.summary)
        assertEquals("2027-01-15T08:00:00.000Z", row.at)
        assertEquals("kl.example.com", row.nodeName)
        assertEquals(listOf(ApprovalList.Button.OPEN, ApprovalList.Button.ACKNOWLEDGE), row.buttons)
    }

    @Test
    fun rowTextIsEscaped() {
        val q = ApprovalList.Question(QuestionItem("t", gpu.id, "gpu\u202Ebox", "c", "q", "Lot\u200B", "question", "normal", "Go?", emptyList()))
        val row = ApprovalList.build(input(questions = listOf(q))).rows.single()
        assertEquals(Display.escape("gpu\u202Ebox"), row.nodeName)
        assertEquals(Display.escape("Lot\u200B") + ": Go?", row.summary)
    }

    // ---- decided rows ----

    @Test
    fun decidedRowsShowTheirStatusAndGoLast() {
        val rows = ApprovalList.build(
            input(
                toolApprovals = listOf(
                    tool("old", "gpu-box", 1000, decided = ApprovalList.Decided("Approved", 100)),
                    tool("new", "gpu-box", 1000, decided = ApprovalList.Decided("Denied", 200)),
                    tool("open", "gpu-box", 5000)
                ),
                questions = listOf(question("t1").copy(decided = ApprovalList.Decided("Answered", 150)))
            )
        ).rows
        assertEquals(listOf("tool:open", "tool:new", "question:t1", "tool:old"), rows.map { it.id })
        val decided = rows.last()
        assertEquals("Approved", decided.status)
        assertEquals(emptyList<ApprovalList.Button>(), decided.buttons)
    }

    @Test
    fun decidedRowsOfEveryYesNoKindShowTheirStatusAndGoLast() {
        val lr = leaseRequest("lr", 30_000).copy(decided = ApprovalList.Decided("Allowed", 300))
        val client = grant(10_000).copy(decided = ApprovalList.Decided("Connected", 200))
        val pair = pairing(40_000).copy(decided = ApprovalList.Decided("Refused", 100))
        val rows = ApprovalList.build(input(leaseRequests = listOf(lr), clientConnections = listOf(client), nodePairings = listOf(pair), toolApprovals = listOf(tool("open", "gpu-box", 5000)))).rows
        assertEquals(listOf("tool:open", "lease-request:lr", "client:${client.request.grantId}", "pairing:${pair.request.pairingId}"), rows.map { it.id })
        for ((row, status) in rows.drop(1).zip(listOf("Allowed", "Connected", "Refused"))) {
            assertEquals(status, row.status)
            assertEquals(emptyList<ApprovalList.Button>(), row.buttons)
            assertFalse(row.enabled)
        }
    }

    // ---- R-F5-5: an unanswered send is shown as not confirmed ----

    @Test
    fun anUnansweredLeaseDecisionSaysNotConfirmedAndKeepsItsButtons() {
        val text = "Not confirmed: no answer. Tap again, or wait for the list to show what the node did."
        val row = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("a", 1000).copy(unconfirmed = text)))).rows.single()
        assertEquals(text, row.notConfirmed)
        assertEquals(listOf(ApprovalList.Button.APPROVE, ApprovalList.Button.DENY), row.buttons)
        assertTrue(row.enabled)
        assertNull(row.status)
        // While it is sent again, Sending… stands in its place.
        val again = ApprovalList.build(input(leaseRequests = listOf(leaseRequest("b", 1000).copy(unconfirmed = text, sending = true)))).rows.single()
        assertNull(again.notConfirmed)
        assertEquals(ApprovalList.SENDING, again.status)
        assertNull(ApprovalList.build(input(leaseRequests = listOf(leaseRequest("c", 1000)))).rows.single().notConfirmed)
    }

    @Test
    fun anUnconfirmedStopKeepsStopEnabled() {
        val text = Leases.stopNotice(SendOutcome.Unconfirmed, "no answer")
        val row = ApprovalList.build(input(runningLeases = listOf(lease("l1", "active").copy(unconfirmed = text)))).rows.single()
        assertEquals(text, row.notConfirmed)
        assertEquals(listOf(ApprovalList.Button.STOP), row.buttons)
        assertTrue(row.enabled)
        val sending = ApprovalList.build(input(runningLeases = listOf(lease("l2", "active").copy(unconfirmed = text, sending = true)))).rows.single()
        assertNull(sending.notConfirmed)
        assertFalse(sending.enabled)
        assertNull(ApprovalList.build(input(runningLeases = listOf(lease("l3", "active")))).rows.single().notConfirmed)
    }

    // ---- §7.3 running leases ----

    @Test
    fun runningLeaseRows() {
        val active = ApprovalList.build(input(runningLeases = listOf(lease("l1", "active")))).rows.single()
        assertEquals(ApprovalList.Kind.RUNNING_LEASE, active.kind)
        assertEquals("lease:l1", active.id)
        assertEquals("l1", active.ref)
        assertEquals(gpu.id, active.nodeId)
        assertEquals("Computer use", active.label)
        assertEquals("Lease active on gpu-box", active.summary)
        assertEquals(listOf(ApprovalList.Button.STOP), active.buttons)
        assertEquals(ms("2027-01-15T09:00:00.000Z") - now, active.timeLeftMs)
        assertNull(active.detail)

        val paused = ApprovalList.build(input(runningLeases = listOf(lease("l2", "suspended", reason = "helper_lost")))).rows.single()
        assertEquals("Lease paused on gpu-box", paused.summary)

        val other = ApprovalList.build(input(runningLeases = listOf(lease("l3", "active", grantedBy = "d-other", grantedByName = "Pixel")))).rows.single()
        assertEquals("Granted by Pixel", other.detail)
    }

    @Test
    fun aNoContactLeaseThisPhoneGrantedSaysOpenToContinue() {
        val mine = ApprovalList.build(input(runningLeases = listOf(lease("l1", "suspended", reason = Leases.NO_CONTACT)))).rows.single()
        assertTrue(mine.summary.startsWith("Paused: open to let it continue"))
        val theirs = ApprovalList.build(input(runningLeases = listOf(lease("l2", "suspended", reason = Leases.NO_CONTACT, grantedBy = "d-other")))).rows.single()
        assertEquals("Lease paused on gpu-box", theirs.summary)
        assertEquals("Granted by another phone (d-other)", theirs.detail)
    }

    @Test
    fun anUnattendedTakeRow() {
        val row = ApprovalList.build(input(runningLeases = listOf(lease("l1", "active", kind = "take", unattended = true, name = "Quarterly demo")))).rows.single()
        assertEquals("Take", row.label)
        assertEquals("Unattended take: Quarterly demo, ends T${ms("2027-01-15T09:00:00.000Z")}", row.summary)
    }

    @Test
    fun pendingLeaseRows() {
        val signed = ApprovalList.build(input(runningLeases = listOf(lease("l1", "pending", grantedBy = null, signedGrant = true)))).rows.single()
        assertEquals(Leases.mayStillStartTitle("gpu-box"), signed.summary)
        assertEquals(Leases.MAY_STILL_START_DETAIL, signed.detail)
        assertEquals(listOf(ApprovalList.Button.STOP), signed.buttons)
        val listed = ApprovalList.build(input(runningLeases = listOf(lease("l2", "pending", grantedBy = null)))).rows.single()
        assertEquals(Leases.requestWaitingTitle("gpu-box"), listed.summary)
        assertEquals(Leases.REQUEST_WAITING_DETAIL, listed.detail)
    }

    @Test
    fun anEndedLeaseHasNoRow() {
        assertTrue(ApprovalList.build(input(runningLeases = listOf(lease("l1", "ended")))).rows.isEmpty())
    }

    @Test
    fun nodeChecks() {
        val result = ApprovalList.build(
            input(nodes = listOf(gpu, web), nodeChecks = mapOf(gpu.id to ApprovalList.NodeCheck.Unconfirmed))
        )
        assertEquals(listOf("check:${gpu.id}", "check:${web.id}"), result.rows.map { it.id })
        val warn = result.rows[0]
        assertEquals(ApprovalList.Kind.NODE_CHECK, warn.kind)
        assertEquals(Leases.couldNotConfirm("gpu-box"), warn.summary)
        assertEquals(Leases.COULD_NOT_CONFIRM_DETAIL, warn.detail)
        assertTrue(warn.warning)
        assertEquals(emptyList<ApprovalList.Button>(), warn.buttons)
        val unasked = result.rows[1]
        assertEquals(Leases.notCheckedYet("web-01"), unasked.summary)
        assertEquals(Leases.NOT_CHECKED_YET_DETAIL, unasked.detail)
        assertFalse(unasked.warning)
        assertTrue(result.footer.isEmpty())
        assertNull(result.empty)
    }

    @Test
    fun theFooterSaysWhatEachConfirmedNodeSigned() {
        val result = ApprovalList.build(
            input(nodeChecks = mapOf(gpu.id to ApprovalList.NodeCheck.Confirmed(42, 1, 2), web.id to ApprovalList.NodeCheck.Confirmed(43, 0, 0)))
        )
        assertEquals(listOf("Checked gpu-box at T42: 1 computer-use session running; 2 requests waiting for an answer", "Checked web-01 at T43: no computer-use session"), result.footer)
    }

    // ---- §7.5 empty state ----

    @Test
    fun theEmptyStatesWords() {
        val off = ApprovalList.build(input()).empty!!
        assertEquals("Nothing waiting.", off.title)
        assertEquals("Requests appear here while the app is open.", off.line)
        assertFalse(off.toScanner)
        assertEquals("A notification tells you when a machine asks.", ApprovalList.build(input(pushOn = true)).empty!!.line)
        val none = ApprovalList.build(input(nodes = emptyList(), nodeChecks = emptyMap())).empty!!
        assertEquals("No node is paired yet.", none.title)
        assertNull(none.line)
        assertTrue(none.toScanner)
        assertNull(ApprovalList.build(input(questions = listOf(question("t")))).empty)
    }

    // ---- §7.4 order ----

    @Test
    fun theOrderOverMixedStores() {
        val result = ApprovalList.build(
            input(
                toolApprovals = listOf(tool("t-late", "web-01", 50_000), tool("t-tie-b", "web-01", 20_000), tool("t-tie-a", "gpu-box", 20_000), tool("t-done", "gpu-box", 0, decided = ApprovalList.Decided("Approved", 5))),
                leaseRequests = listOf(leaseRequest("lr", 30_000)),
                clientConnections = listOf(grant(10_000)),
                nodePairings = listOf(pairing(40_000)),
                questions = listOf(question("q-normal"), question("q-high", urgency = "high"), question("q-normal2")),
                alerts = listOf(alert("a-old", "2027-01-15T08:00:00.000Z"), alert("a-new", "2027-01-15T08:30:00.000Z")),
                runningLeases = listOf(
                    lease("pending", "pending", grantedBy = null),
                    lease("paused-other", "suspended", reason = "helper_lost", expiresAt = "2027-01-15T08:10:00.000Z"),
                    lease("active-late", "active", expiresAt = "2027-01-15T10:00:00.000Z"),
                    lease("active-soon", "active", expiresAt = "2027-01-15T08:20:00.000Z"),
                    lease("nocontact-theirs", "suspended", reason = Leases.NO_CONTACT, grantedBy = "d-other", expiresAt = "2027-01-15T08:01:00.000Z"),
                    lease("nocontact-mine", "suspended", reason = Leases.NO_CONTACT, expiresAt = "2027-01-15T11:00:00.000Z")
                ),
                nodeChecks = mapOf(gpu.id to ApprovalList.NodeCheck.Unconfirmed, web.id to ApprovalList.NodeCheck.Confirmed(1, 0, 0))
            )
        )
        val grantId = grant(0).request.grantId
        val pairingId = pairing(0).request.pairingId
        assertEquals(
            listOf(
                "lease:nocontact-mine", "lease:active-soon", "lease:active-late", "lease:nocontact-theirs", "lease:paused-other", "lease:pending",
                "check:${gpu.id}",
                "client:$grantId", "tool:t-tie-a", "tool:t-tie-b", "lease-request:lr", "pairing:$pairingId", "tool:t-late",
                "alert:a-new", "alert:a-old", "question:q-high", "question:q-normal", "question:q-normal2",
                "tool:t-done"
            ),
            result.rows.map { it.id }
        )
    }
}
