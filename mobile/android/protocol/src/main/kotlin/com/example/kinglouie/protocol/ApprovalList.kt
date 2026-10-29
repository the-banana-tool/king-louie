package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement

/**
 * The Approvals list (docs/superpowers/specs/2026-10-28-android-app-slim-design.md
 * §7, §10; the author's calls C-11, C-12, C-18, C-20): one pure function that
 * turns the phone's per-kind stores into rows. It decides each row's kind,
 * ids, host-built strings, buttons and place; it fetches, verifies, signs and
 * sends nothing.
 *
 * Every store holds only what the app already verified (a node-signed
 * request, question, lease request or status; the front door's checked
 * reply), as today. Every string a row shows is composed here from those
 * fields and escaped ([Display.escape], [FrontDoor.shownText]), never taken
 * as relay free text. Times are given as the caller measured them: a waiting
 * item's time left on its own clock (monotonic from receipt for a tool
 * approval, client connection or pairing; the relay-corrected clock for a
 * lease request), and for running leases the relay-corrected now.
 */
object ApprovalList {
    enum class Kind { TOOL_APPROVAL, QUESTION, LEASE_REQUEST, CLIENT_CONNECTION, NODE_PAIRING, ALERT, RUNNING_LEASE, NODE_CHECK }

    /**
     * What a row offers (§7.2). APPROVE signs the row's decision with its
     * defaults, the same decision the detail sends; REVIEW stands in its place
     * when the row cannot show what a yes would mean and opens the detail.
     * OPEN opens the detail; GOT_IT answers a briefing; ACKNOWLEDGE an alert;
     * STOP revokes a running or pending lease.
     */
    enum class Button { APPROVE, REVIEW, DENY, OPEN, GOT_IT, ACKNOWLEDGE, STOP }

    /** A decision the owner made on this phone: the status shown in place of the buttons, and when (any one clock, the same for every row). */
    data class Decided(val status: String, val atMs: Long)

    // ---- the stores, one entry type per kind ----

    /** A verified `kl.approval.request` ([display] is `Display.build`'s, already escaped). */
    data class ToolApproval(val requestId: String, val display: JsonElement, val timeLeftMs: Long, val sending: Boolean = false, val decided: Decided? = null)

    data class Question(val item: QuestionItem, val sending: Boolean = false, val decided: Decided? = null)

    /**
     * A verified lease request; [nodeName] is the pinned node's name.
     * [unconfirmed]: the last Allow or Deny got no answer (R-F5-5), in the
     * app's words; the row says so and keeps its buttons.
     */
    data class LeaseRequestItem(
        val request: LeaseRequest, val nodeName: String, val timeLeftMs: Long, val sending: Boolean = false, val decided: Decided? = null,
        val unconfirmed: String? = null
    )

    /** A claimed client connection, with the code it was claimed by (the grant message needs it). */
    data class ClientConnection(val request: GrantRequest, val userCode: String, val timeLeftMs: Long, val sending: Boolean = false, val decided: Decided? = null)

    data class NodePairing(val request: PairingRequest, val timeLeftMs: Long, val sending: Boolean = false, val decided: Decided? = null)

    /** One `GET /v1/alerts` entry `{ id, kind, subject, detail, at, acked }`; an acknowledged one has no row unless [decided] says this phone just did it. */
    data class Alert(val json: JsonElement, val sending: Boolean = false, val decided: Decided? = null)

    /**
     * A lease this phone knows from a status its pinned node signed (already
     * verified: `Leases.verifiedMessage` then `LeaseStatus.from`): the live
     * view's, a listed one, or a pending one a passed listing named. Which
     * pending leases get here is the app's rule (`noteListedLease`,
     * `notePendingListed`, `dropMayStartRows`); [signedGrant] is whether this
     * phone remembers signing a grant for it, which chooses only the words.
     * [unconfirmed]: the last Stop got no answer the node signed (R-F5-5);
     * the row says so and Stop stays enabled.
     */
    data class RunningLease(
        val status: LeaseStatus, val nodeName: String, val signedGrant: Boolean = false, val sending: Boolean = false,
        val unconfirmed: String? = null
    )

    /** One pinned node's listing check; a node with none in [Input.nodeChecks] has not been asked yet. */
    sealed class NodeCheck {
        /** A listing this phone accepted at [atMs] (its own wall clock): [running] live leases, [waiting] requests not yet answered. */
        data class Confirmed(val atMs: Long, val running: Int, val waiting: Int) : NodeCheck()

        /** The last fetch brought no listing this phone could accept. */
        object Unconfirmed : NodeCheck()
    }

    data class Input(
        val toolApprovals: List<ToolApproval> = emptyList(),
        val questions: List<Question> = emptyList(),
        val leaseRequests: List<LeaseRequestItem> = emptyList(),
        val clientConnections: List<ClientConnection> = emptyList(),
        val nodePairings: List<NodePairing> = emptyList(),
        val alerts: List<Alert> = emptyList(),
        val runningLeases: List<RunningLease> = emptyList(),
        /** The pinned nodes, in the app's order. */
        val nodes: List<NodePin> = emptyList(),
        val nodeChecks: Map<String, NodeCheck> = emptyMap(),
        val thisDevice: String?,
        /** Now, on the relay-corrected clock (epoch ms): running leases' time left. */
        val relayNowMs: Long,
        /** What front-door rows name as their machine (the front door's domain or name). */
        val frontDoorName: String = "",
        /** Row ids whose summary line did not fit when drawn (Compose's `hasVisualOverflow`): they get Review in place of Approve. */
        val overflowing: Set<String> = emptySet(),
        val pushOn: Boolean = false,
        /** A take's end time ("ends <time>"). */
        val formatTime: (Long) -> String,
        /** A footer's "Checked <node> at <time>". */
        val formatDateTime: (Long) -> String
    )

    data class Row(
        /** Unique across kinds: `<kind prefix>:<ref>`; the key the app keeps rows and overflow by. */
        val id: String,
        val kind: Kind,
        /** The kind's own id: request id, question token, grant id, pairing id, alert id, lease id or node id. */
        val ref: String,
        /** The node it concerns, when one does (null for front-door kinds). */
        val nodeId: String?,
        /** The node's name, or the front door's for its kinds; escaped. */
        val nodeName: String,
        val label: String,
        val summary: String,
        /** A second line: a pairing's fingerprint. */
        val secondLine: String? = null,
        val secondLineMonospace: Boolean = false,
        /** What is said under a lease or node row (who granted it, what a pending or unconfirmed row means). */
        val detail: String? = null,
        /** Time left, in ms, when the kind has a deadline. */
        val timeLeftMs: Long? = null,
        /** When it happened (an alert), as the front door wrote it, shown as text. */
        val at: String? = null,
        val buttons: List<Button> = emptyList(),
        /** False while the row's decision is being signed or sent, after its deadline, or once decided. */
        val enabled: Boolean = true,
        /** "Sending…", or a decided row's status, shown in place of the buttons' effect. */
        val status: String? = null,
        /**
         * An unanswered send (R-F5-5), shown in the warning colour under the
         * row while nothing is being sent; the buttons stay enabled, so the
         * owner can tap again.
         */
        val notConfirmed: String? = null,
        /** Shown in the warning colour ("Could not confirm"). */
        val warning: Boolean = false,
        /** A question of `high` urgency. */
        val highUrgency: Boolean = false
    )

    /** §7.5: what an empty list says; [toScanner] adds the button to the Scanner. */
    data class Empty(val title: String, val line: String?, val toScanner: Boolean)

    /** [footer]: one "Checked <node> at <time>: …" line per node whose listing passed. [empty]: non-null only when there are no rows. */
    data class Result(val rows: List<Row>, val footer: List<String>, val empty: Empty?)

    const val SENDING = "Sending…"
    const val NOTHING_WAITING = "Nothing waiting."
    const val PUSH_ON_LINE = "A notification tells you when a machine asks."
    const val PUSH_OFF_LINE = "Requests appear here while the app is open."
    const val NO_NODE = "No node is paired yet."

    fun build(input: Input): Result {
        // Within each group of §7.4 the soonest expires_at first (none: last).
        val running = input.runningLeases
            .sortedWith(compareBy<RunningLease> { runningGroup(it.status, input) }.thenBy { it.status.expiresAt?.let(Timestamps::epochMillis) ?: Long.MAX_VALUE })
            .mapNotNull { runningRow(it, input) }
        val checks = input.nodes.mapNotNull { checkRow(it, input) }
        val waiting = ArrayList<Pair<Row, Decided?>>()
        input.toolApprovals.forEach { waiting.add(toolRow(it, input) to it.decided) }
        input.leaseRequests.forEach { waiting.add(leaseRequestRow(it, input) to it.decided) }
        input.clientConnections.forEach { waiting.add(clientRow(it, input) to it.decided) }
        input.nodePairings.forEach { waiting.add(pairingRow(it, input) to it.decided) }
        val alerts = input.alerts.mapNotNull { a -> alertRow(a, input)?.let { Triple(it, a.decided, Timestamps.epochMillis(a.json["at"].str() ?: "")) } }
        val questions = input.questions.map { questionRow(it, input) to it.decided }

        val deadline = waiting.filter { it.second == null }.map { it.first }
            .sortedWith(compareBy<Row> { it.timeLeftMs ?: Long.MAX_VALUE }.thenBy { it.nodeName })
        val noDeadline = alerts.filter { it.second == null }.sortedByDescending { it.third ?: Long.MIN_VALUE }.map { it.first } +
            questions.filter { it.second == null }.map { it.first }.sortedBy { if (it.highUrgency) 0 else 1 }
        val decided = (waiting + alerts.map { it.first to it.second } + questions).mapNotNull { (row, d) -> d?.let { row to it } }
            .sortedByDescending { it.second.atMs }.map { it.first }

        val rows = running + checks + deadline + noDeadline + decided
        val footer = input.nodes.mapNotNull { pin ->
            (input.nodeChecks[pin.id] as? NodeCheck.Confirmed)?.let { Leases.checked(pin.name, input.formatDateTime(it.atMs), it.running, it.waiting) }
        }
        val empty = when {
            rows.isNotEmpty() -> null
            input.nodes.isEmpty() -> Empty(NO_NODE, null, toScanner = true)
            else -> Empty(NOTHING_WAITING, if (input.pushOn) PUSH_ON_LINE else PUSH_OFF_LINE, toScanner = false)
        }
        return Result(rows, footer, empty)
    }

    // ---- running leases and node checks (§7.3) ----

    private fun grantedByThisPhone(s: LeaseStatus, input: Input): Boolean = Leases.grantedByOther(s.grantedByDevice, s.grantedByName, input.thisDevice) == null

    /** §7.4 group 1: paused for want of contact and granted by this phone, then active, then paused otherwise, then pending. */
    private fun runningGroup(s: LeaseStatus, input: Input): Int = when {
        Leases.isPausedForContact(s.state, s.reason) && grantedByThisPhone(s, input) -> 0
        s.state == "active" -> 1
        s.state == "suspended" -> 2
        else -> 3
    }

    private fun runningRow(lease: RunningLease, input: Input): Row? {
        val s = lease.status
        // C-18: an ended lease (or any state that is neither running nor waiting) has no row.
        if (!Leases.isLive(s.state) && s.state != "pending") return null
        val node = Display.escape(lease.nodeName)
        val expiresMs = s.expiresAt?.let { Timestamps.epochMillis(it) }
        val take = if (s.state != "pending" && s.unattended && s.name != null && expiresMs != null) s.name else null
        val summary = when {
            s.state == "pending" -> Leases.pendingTitle(lease.nodeName, lease.signedGrant)
            take != null -> "Unattended take: " + Display.escape(take) + ", ends " + input.formatTime(expiresMs!!)
            // The iOS words (R-F5-19): opening the detail is what keeps it going.
            Leases.isPausedForContact(s.state, s.reason) && grantedByThisPhone(s, input) -> "Paused: open to let it continue ($node)"
            else -> "Lease ${if (s.state == "suspended") "paused" else "active"} on $node"
        }
        val detail = if (s.state == "pending") Leases.pendingDetail(lease.signedGrant) else Leases.grantedByOther(s.grantedByDevice, s.grantedByName, input.thisDevice)
        return Row(
            id = "lease:${s.leaseId}", kind = Kind.RUNNING_LEASE, ref = s.leaseId, nodeId = s.nodeId, nodeName = node,
            label = if (s.kind == "take") "Take" else "Computer use", summary = summary, detail = detail,
            timeLeftMs = expiresMs?.let { (it - input.relayNowMs).coerceAtLeast(0) },
            buttons = listOf(Button.STOP), enabled = !lease.sending, status = if (lease.sending) SENDING else null,
            notConfirmed = if (lease.sending) null else lease.unconfirmed
        )
    }

    private fun checkRow(pin: NodePin, input: Input): Row? {
        val (summary, detail, warning) = when (input.nodeChecks[pin.id]) {
            null -> Triple(Leases.notCheckedYet(pin.name), Leases.NOT_CHECKED_YET_DETAIL, false)
            is NodeCheck.Unconfirmed -> Triple(Leases.couldNotConfirm(pin.name), Leases.COULD_NOT_CONFIRM_DETAIL, true)
            is NodeCheck.Confirmed -> return null
        }
        return Row(
            id = "check:${pin.id}", kind = Kind.NODE_CHECK, ref = pin.id, nodeId = pin.id, nodeName = Display.escape(pin.name),
            label = "Computer use", summary = summary, detail = detail, warning = warning
        )
    }

    // ---- waiting Approvals (§7.2) ----

    /** Approve and Deny, Review in place of Approve when the row cannot show the yes; disabled while sending or past the deadline; none once decided. */
    private fun decisionRow(row: Row, review: Boolean, input: Input, sending: Boolean, decided: Decided?, unconfirmed: String? = null): Row = when {
        decided != null -> row.copy(buttons = emptyList(), enabled = false, status = decided.status)
        else -> row.copy(
            buttons = listOf(if (review || row.id in input.overflowing) Button.REVIEW else Button.APPROVE, Button.DENY),
            enabled = !sending && (row.timeLeftMs ?: 1) > 0,
            status = if (sending) SENDING else null,
            notConfirmed = if (sending) null else unconfirmed
        )
    }

    private fun toolRow(t: ToolApproval, input: Input): Row {
        val d = t.display
        val label = when (d["kind"].str()) {
            "runbook" -> "Runbook"
            "envelope" -> "Envelope"
            else -> "Tool approval"
        }
        // Display.build escaped the node name and the node-signed summary already.
        val row = Row(
            id = "tool:${t.requestId}", kind = Kind.TOOL_APPROVAL, ref = t.requestId, nodeId = d["node"]["id"].str(),
            nodeName = d["node"]["name"].str() ?: "", label = label, summary = d["summary"].str() ?: "", timeLeftMs = t.timeLeftMs.coerceAtLeast(0)
        )
        return decisionRow(row, false, input, t.sending, t.decided)
    }

    private fun leaseRequestRow(item: LeaseRequestItem, input: Input): Row {
        val r = item.request
        val (label, summary) = when {
            r.isResume -> "Resume" to "Resume computer use · ${r.maxMinutes} min left"
            r.isTake -> "Take" to (Display.escape(r.name ?: "") + " · ${r.maxMinutes} min" + if (r.unattended) " · unattended" else "")
            else -> "Computer use" to (r.apps.joinToString(", ") { Display.escape(it.name) } + " · ${r.maxMinutes} min")
        }
        val row = Row(
            id = "lease-request:${r.requestId}", kind = Kind.LEASE_REQUEST, ref = r.requestId, nodeId = r.nodeId,
            nodeName = Display.escape(item.nodeName), label = label, summary = summary, timeLeftMs = item.timeLeftMs.coerceAtLeast(0)
        )
        // C-12: limits carry warnings that must be read; a take with credentials may use logins from the vault.
        return decisionRow(row, r.limits.isNotEmpty() || (r.isTake && r.credentials), input, item.sending, item.decided, item.unconfirmed)
    }

    private fun clientRow(c: ClientConnection, input: Input): Row {
        val r = c.request
        val row = Row(
            id = "client:${r.grantId}", kind = Kind.CLIENT_CONNECTION, ref = r.grantId, nodeId = null,
            nodeName = FrontDoor.shownText(input.frontDoorName), label = "Client connection",
            summary = "${FrontDoor.shownText(r.clientName)} (self-declared) · ${r.requestedScopes.joinToString(", ")}",
            timeLeftMs = c.timeLeftMs.coerceAtLeast(0)
        )
        return decisionRow(row, false, input, c.sending, c.decided)
    }

    private fun pairingRow(p: NodePairing, input: Input): Row {
        val r = p.request
        // The core checked the name's alphabet and that the id derives from the key.
        val row = Row(
            id = "pairing:${r.pairingId}", kind = Kind.NODE_PAIRING, ref = r.pairingId, nodeId = null,
            nodeName = FrontDoor.shownText(input.frontDoorName), label = "Node pairing",
            summary = "${FrontDoor.shownText(r.nodeName)} (${r.profile})", secondLine = r.fingerprint, secondLineMonospace = true,
            timeLeftMs = p.timeLeftMs.coerceAtLeast(0)
        )
        return decisionRow(row, r.replaces != null, input, p.sending, p.decided)
    }

    private fun alertRow(a: Alert, input: Input): Row? {
        val id = a.json["id"].str() ?: return null
        if (a.json["acked"].bool() == true && a.decided == null) return null
        val row = Row(
            id = "alert:$id", kind = Kind.ALERT, ref = id, nodeId = null, nodeName = FrontDoor.shownText(input.frontDoorName),
            label = "Alert", summary = "${FrontDoor.shownText(a.json["kind"].str(), 64)}: ${FrontDoor.shownText(a.json["subject"].str())}",
            at = FrontDoor.shownText(a.json["at"].str(), 40)
        )
        return when {
            a.decided != null -> row.copy(enabled = false, status = a.decided.status)
            else -> row.copy(buttons = listOf(Button.OPEN, Button.ACKNOWLEDGE), enabled = !a.sending, status = if (a.sending) SENDING else null)
        }
    }

    private fun questionRow(q: Question, input: Input): Row {
        val i = q.item
        val title = Display.escape(i.caseTitle)
        val row = Row(
            id = "question:${i.token}", kind = Kind.QUESTION, ref = i.token, nodeId = i.nodeId, nodeName = Display.escape(i.nodeName),
            label = "Question", summary = if (title.isEmpty()) Display.escape(i.text) else "$title: ${Display.escape(i.text)}",
            highUrgency = i.urgency == "high"
        )
        return when {
            q.decided != null -> row.copy(enabled = false, status = q.decided.status)
            // A briefing has one answer, so its row carries it; any other question opens its detail.
            else -> row.copy(
                buttons = listOf(if (i.kind == "briefing") Button.GOT_IT else Button.OPEN),
                enabled = !q.sending, status = if (q.sending) SENDING else null
            )
        }
    }
}
