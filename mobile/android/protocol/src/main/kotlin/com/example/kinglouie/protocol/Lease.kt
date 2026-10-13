package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.util.Base64

/**
 * Fleet stage 5 (docs/protocol/lease-v1.md): computer-use leases. The node
 * signs requests, statuses and views; the phone signs grants, denies,
 * revokes and watches. Everything shown comes from a message whose node
 * signature verified against the pinned node key.
 */
data class LeaseApp(val id: String, val name: String, val path: String, val processes: List<String>)

data class LeaseRequest(
    val requestId: String, val leaseId: String, val nodeId: String, val nodeName: String, val jobId: String,
    val apps: List<LeaseApp>, val maxMinutes: Int, val reason: String, val resumes: String?, val limits: List<String>,
    val originClient: String, val leaseHash: String, val nonce: String, val createdAt: String, val expiresAt: String
) {
    val isResume: Boolean get() = resumes != null

    companion object {
        const val TYPE = "kl.lease.request"

        /** null unless [message] is a complete kl.lease.request whose lease_hash is the hash of its lease. */
        fun from(message: JsonElement): LeaseRequest? {
            if (message["type"].str() != TYPE || message["v"].int() != 1) return null
            val lease = message["lease"].obj() ?: return null
            val leaseHash = message["lease_hash"].str() ?: return null
            if (lease["kind"].str() != "computer_use") return null
            if (Digest.sha256B64url(Jcs.bytes(lease)) != leaseHash) return null
            val maxMinutes = lease["max_minutes"].int()?.takeIf { it in 1..60 } ?: return null
            val apps = (lease["apps"].arr() ?: return null).map { a ->
                LeaseApp(
                    a["id"].str() ?: return null, a["name"].str() ?: return null, a["path"].str() ?: return null,
                    (a["processes"].arr() ?: return null).mapNotNull { it.str() }
                )
            }
            if (apps.isEmpty()) return null
            return LeaseRequest(
                message["request_id"].str() ?: return null, message["lease_id"].str() ?: return null,
                message["node_id"].str() ?: return null, message["node_name"].str() ?: return null,
                lease["job_id"].str() ?: return null, apps, maxMinutes, lease["reason"].str() ?: return null,
                lease["resumes"].str(), (lease["limits"].arr() ?: JsonArray(emptyList())).mapNotNull { it.str() },
                message["origin"]["client"].str() ?: "", leaseHash, message["nonce"].str() ?: return null,
                message["created_at"].str() ?: return null, message["expires_at"].str() ?: return null
            )
        }
    }
}

data class LeaseStatus(
    val leaseId: String, val nodeId: String, val seq: Int, val state: String, val locked: Boolean, val reason: String?, val expiresAt: String?,
    /** The token this status carries for the phone's next watch to echo (owner ruling R-F5-15); null when the message holds none. */
    val contactToken: String? = null,
    /**
     * The phone whose grant made the lease (owner ruling R-F5-18): its device
     * id, and the name the node knows it by when it gave one. Both null while
     * nobody has granted the lease.
     */
    val grantedByDevice: String? = null,
    val grantedByName: String? = null
) {
    companion object {
        const val TYPE = "kl.lease.status"

        fun from(m: JsonElement): LeaseStatus? {
            if (m["type"].str() != TYPE) return null
            return LeaseStatus(
                m["lease_id"].str() ?: return null, m["node_id"].str() ?: return null, m["seq"].int() ?: return null,
                m["state"].str() ?: return null, m["locked"].bool() ?: return null, m["reason"].str(), m["expires_at"].str(),
                m["contact_token"].str(), m["granted_by"]["device_id"].str(), m["granted_by"]["name"].str()
            )
        }
    }
}

data class LeaseAction(val seq: Int, val at: String, val tool: String, val summary: String, val result: String)

class LeaseView(
    val leaseId: String, val nodeId: String, val seq: Int, val toDevice: String, val state: String, val locked: Boolean, val remainingS: Int,
    val foregroundAppId: String?, val foregroundMatches: Boolean, val frame: ByteArray?, val frameDropped: Boolean, val actions: List<LeaseAction>,
    /** The token this view carries for the phone's next watch to echo (R-F5-15). */
    val contactToken: String? = null
)

data class ViewCheck(val accepted: Boolean, val reason: String?, val view: LeaseView?)

/**
 * What a phone made of one node's answer to "what is running" (owner ruling
 * R-F5-20). [accepted] means the pinned node signed, for this very request
 * and this phone, that the leases named are all it has to list; [statuses]
 * are then the signed statuses it names, in its order (none: the node says
 * nothing is running). Anything else is no answer at all, and [reason] says
 * what failed (`no_listing`: none came).
 */
data class ListingCheck(val accepted: Boolean, val reason: String?, val statuses: List<Envelope>)

/** What one lease send (grant, deny, revoke, watch) came to. Android shows the third as "not confirmed" and sends nothing again by itself (owner ruling R-F5-5). */
sealed class SendOutcome {
    /**
     * A reply that names a state came back. It arrives through the relay and
     * is not signed by the node, so it says the send was delivered and
     * nothing more: the state a screen shows comes only from a status or a
     * view the pinned node signed.
     */
    data class Confirmed(val state: String) : SendOutcome()

    /** The node answered and refused; `reason` is its word, when it gave one. */
    data class Rejected(val reason: String?) : SendOutcome()

    /** No usable answer: the request failed or timed out, or the reply carried no state. */
    object Unconfirmed : SendOutcome()
}

object Leases {
    /**
     * The reason a node gives when it suspended a lease because the phone
     * that granted it had not been in touch (owner ruling R-F5-15). The node
     * resumes it on that phone's next watch that echoes a recent contact
     * token; nothing is extended.
     */
    const val NO_CONTACT = "no_contact"

    /** Whether a signed state and reason say input is paused for want of contact. */
    fun isPausedForContact(state: String, reason: String?): Boolean = state == "suspended" && reason == NO_CONTACT

    /** A lease that is running: it holds, or can get back, the right to click and type. Such a lease has a banner and a Stop (R-F5-18). */
    fun isLive(state: String): Boolean = state == "active" || state == "suspended"

    /**
     * A lease that may still start (fourth security review, finding 3). Its
     * node signed that it is waiting for a phone's answer, and this phone
     * signed a grant for it that the node never confirmed. A relay can hold
     * such a grant back (answering 503) and deliver it later, so the lease
     * is not running and is not over either. It gets a row with a Stop,
     * like a running one.
     */
    fun mayStillStart(state: String, signedGrant: Boolean): Boolean = state == "pending" && signedGrant

    fun mayStillStartTitle(nodeName: String): String = "May still start on ${Display.escape(nodeName)}"

    /** Under that row. */
    const val MAY_STILL_START_DETAIL = "This phone signed an Allow for it that the computer did not confirm. The relay could still deliver it. Stop cancels it."

    /**
     * Whether such a row stays after a listing its node signed was accepted.
     * [listedState]: the state the listing gives the lease, null when it
     * does not name it. Named: it stays while still pending (a live lease
     * has its ordinary row, an ended one none). Not named: it stays until
     * the request the grant answered has expired, and goes only then.
     * Without an accepted listing nothing is dropped.
     */
    fun keepsMayStart(listedState: String?, requestExpired: Boolean): Boolean = if (listedState == null) !requestExpired else listedState == "pending"

    /**
     * What to say beside Stop for a lease another phone granted (R-F5-18):
     * null when this phone granted it or the node has not said who did. The
     * text is escaped for display.
     */
    fun grantedByOther(device: String?, name: String?, thisDevice: String?): String? {
        if (device == null || device == thisDevice) return null
        return if (!name.isNullOrEmpty()) "Granted by ${Display.escape(name)}" else "Granted by another phone (${Display.escape(device)})"
    }

    /**
     * How old a contact token may be, by this phone's own running clock,
     * before Refresh asks the node for a fresh status first (R-F5-15). The
     * node's window is two minutes by default and never under thirty
     * seconds; a token older than a minute may no longer make contact, and
     * the watch that echoes it would only be answered with a new one.
     */
    const val TOKEN_FRESH_MS = 60_000L

    /** Whether the token applied at [appliedAtMs] (null: none held) is too old at [nowMs] to count on. Both on the same monotonic clock. */
    fun tokenIsStale(appliedAtMs: Long?, nowMs: Long): Boolean = appliedAtMs == null || nowMs - appliedAtMs >= TOKEN_FRESH_MS

    /**
     * Order and addressee (owner ruling R-F5-16). A node numbers the statuses
     * and views of one lease with one rising `seq`. A relay can hold a
     * message back and deliver it later, or hand one phone a view made for
     * another; so a status or view is applied only if its seq is newer than
     * the newest one already applied for that lease, and a view only if it
     * is addressed to this device. Anything else is dropped unshown.
     */
    fun acceptsStatus(status: LeaseStatus, appliedSeq: Int): Boolean = status.seq > appliedSeq

    fun acceptsView(view: LeaseView, appliedSeq: Int, deviceId: String): Boolean = view.seq > appliedSeq && view.toDevice == deviceId

    /** A view larger than this is dropped unread (§4.1). */
    const val VIEW_MAX_BYTES = 262144

    /** The live screen keeps this many actions, newest first (§3.10). */
    const val ACTIONS_KEPT = 200

    /**
     * How long Android's Refresh holds its one views request open for the
     * frame its watch causes (owner ruling R-F5-6). The node captures within a
     * 250 ms tick of the watch unless another capture ran in the last second,
     * may capture once more at lower quality, and the view then crosses the
     * relay; the relay caps a wait at 25 s and a watch lasts 60 s. A judgement,
     * to be confirmed against a real node (plan Deviation 42).
     */
    const val REFRESH_WAIT_S = 5

    /** The answer to one send. Only a reply that names a state counts as an answer. */
    fun sendOutcome(reply: JsonElement?): SendOutcome {
        val state = reply["state"].str() ?: return SendOutcome.Unconfirmed
        return if (state == "rejected") SendOutcome.Rejected(reply["reason"].str()) else SendOutcome.Confirmed(state)
    }

    /**
     * What the live screen says after a Stop was sent (security review,
     * 2026-10-12). No reply ends the lease on screen: a reply is the relay's
     * word, and a relay that wanted the owner to stop watching could say
     * "ended" while the lease went on. The lease is shown as over only when a
     * status or view signed by the pinned node says so. The reply's own
     * state is deliberately not repeated here.
     */
    fun stopNotice(outcome: SendOutcome, problem: String?): String = when (outcome) {
        is SendOutcome.Confirmed -> "Stop sent, not yet confirmed by the computer. Tap Refresh to see its signed answer, or tap Stop now again."
        is SendOutcome.Rejected -> "The stop was refused (${Display.escape(outcome.reason ?: "no reason given")}). The lease may still be active. Tap Stop now again."
        is SendOutcome.Unconfirmed -> "Stop not confirmed: ${problem ?: "no answer"}. The lease may still be active. Tap Stop now again."
    }

    /**
     * Where to ask for views after a watch: the relay's `after_seq` (its
     * mailbox position before the node heard the watch), never behind what
     * this phone has already seen. A reply without one leaves the cursor.
     */
    fun cursorAfterWatch(lastSeq: Int, watchReply: JsonElement?): Int = maxOf(lastSeq, watchReply["after_seq"].int() ?: 0)

    /**
     * The live screen's action log after a view: each action once (by its
     * `seq`; a view's copy replaces an older one), newest first, at most
     * ACTIONS_KEPT. A node sends actions again when a watch starts over
     * (after it lapsed, which on Android is every Refresh more than a minute
     * after the last), so two views can carry the same action.
     */
    fun mergedActions(shown: List<LeaseAction>, fresh: List<LeaseAction>): List<LeaseAction> =
        (fresh + shown).distinctBy { it.seq }.sortedByDescending { it.seq }.take(ACTIONS_KEPT)

    /** The request's own apps, in its order, kept only if the owner left them on. */
    fun grant(request: LeaseRequest, apps: List<String>, minutes: Int, deviceId: String, signedAt: String): JsonObject {
        val chosen = apps.toSet()
        if (chosen.isEmpty() || !request.apps.map { it.id }.containsAll(chosen)) throw ProtocolException("pick at least one of the requested apps")
        if (minutes !in 1..request.maxMinutes) throw ProtocolException("minutes must be 1–${request.maxMinutes}")
        val ordered = request.apps.map { it.id }.filter { it in chosen }
        val grant = JsonObject(mapOf("apps" to JsonArray(ordered.map { jsonString(it) }), "minutes" to jsonNumber(minutes.toString())))
        return decision(request, "grant", grant, deviceId, signedAt)
    }

    fun deny(request: LeaseRequest, deviceId: String, signedAt: String): JsonObject = decision(request, "deny", JsonNull, deviceId, signedAt)

    private fun decision(r: LeaseRequest, decision: String, grant: JsonElement, deviceId: String, signedAt: String): JsonObject = JsonObject(
        mapOf(
            "v" to jsonNumber("1"), "type" to jsonString("kl.lease.grant"), "request_id" to jsonString(r.requestId),
            "lease_id" to jsonString(r.leaseId), "node_id" to jsonString(r.nodeId), "lease_hash" to jsonString(r.leaseHash),
            "nonce" to jsonString(r.nonce), "decision" to jsonString(decision), "grant" to grant,
            "expires_at" to jsonString(r.expiresAt), "device_id" to jsonString(deviceId), "signed_at" to jsonString(signedAt)
        )
    )

    fun revoke(nodeId: String, leaseId: String, reason: String = "kill_switch", deviceId: String, nonce: String, signedAt: String): JsonObject = JsonObject(
        mapOf(
            "v" to jsonNumber("1"), "type" to jsonString("kl.lease.revoke"), "node_id" to jsonString(nodeId), "lease_id" to jsonString(leaseId),
            "reason" to jsonString(reason), "device_id" to jsonString(deviceId), "nonce" to jsonString(nonce), "signed_at" to jsonString(signedAt)
        )
    )

    /**
     * [contactToken]: the token of the newest status or view of this lease
     * that this phone has applied, or null when it has applied none (the
     * message then carries null). The node counts a watch as contact only
     * when it echoes a token it issued recently (R-F5-15): that shows the
     * watch was signed after the node sent that message.
     */
    fun watch(nodeId: String, leaseId: String, deviceId: String, contactToken: String?, nonce: String, signedAt: String): JsonObject {
        val token: JsonElement = if (contactToken != null) jsonString(contactToken) else JsonNull
        return JsonObject(
            mapOf(
                "v" to jsonNumber("1"), "type" to jsonString("kl.lease.watch"), "node_id" to jsonString(nodeId), "lease_id" to jsonString(leaseId),
                "device_id" to jsonString(deviceId), "contact_token" to token, "nonce" to jsonString(nonce), "signed_at" to jsonString(signedAt)
            )
        )
    }

    /**
     * One node's listing (R-F5-20), checked the way `verifyLeaseListing` in
     * src/gui/lease-protocol.js does: the pinned node's signature over the
     * received bytes; a kl.lease.listing of that node; the nonce this phone
     * chose for this very request (so an answer to an earlier request cannot
     * be played again); made for this phone; and, for every lease it names, a
     * status of that lease with that seq which the same node signed, among
     * [statuses] (so no entry can be left out or swapped for an older one).
     * Statuses it does not name are not returned.
     */
    fun verifyListing(envelope: Envelope, pin: NodePin, nonce: String, deviceId: String, statuses: List<Envelope>): ListingCheck {
        fun refused(reason: String) = ListingCheck(false, reason, emptyList())
        if (envelope.alg != "Ed25519" || envelope.kid != pin.id) return refused("malformed")
        if (!envelope.verifyEd25519(pin.key)) return refused("bad_signature")
        val m = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return refused("malformed")
        }
        if (m["type"].str() != "kl.lease.listing" || m["v"].int() != 1) return refused("malformed")
        val named = m["leases"].arr() ?: return refused("malformed")
        val signedNonce = m["nonce"].str() ?: return refused("malformed")
        val toDevice = m["to_device"].str() ?: return refused("malformed")
        if (m["node_id"].str() != pin.id) return refused("wrong_node")
        if (nonce.isEmpty() || signedNonce != nonce) return refused("nonce_mismatch")
        if (toDevice != deviceId) return refused("wrong_device")
        val signed = statuses.mapNotNull { candidate -> verifiedMessage(candidate, pin)?.let { LeaseStatus.from(it) }?.let { it to candidate } }
        val listed = ArrayList<Envelope>()
        for (entry in named) {
            val leaseId = entry["lease_id"].str() ?: return refused("malformed")
            val seq = entry["seq"].int() ?: return refused("malformed")
            val match = signed.firstOrNull { it.first.leaseId == leaseId && it.first.seq == seq } ?: return refused("status_missing")
            listed.add(match.second)
        }
        return ListingCheck(true, null, listed)
    }

    /**
     * The same check on the relay's reply to `GET /v1/leases?nonce=…` for one
     * pinned node: its entries without a request are its listing (`listing`)
     * and the statuses beside it (`status`). No listing among them is
     * `no_listing`: the node is offline, slow or older, or the relay kept its
     * answer back; this phone cannot tell which.
     */
    fun checkListing(entries: List<JsonElement>, pin: NodePin, nonce: String, deviceId: String): ListingCheck {
        fun envelopeOf(json: JsonElement?): Envelope? = json?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() }
        val mine = entries.filter { entry -> entry["node_id"].str() == pin.id && entry["envelope"].let { it == null || it is JsonNull } }
        val listing = mine.firstNotNullOfOrNull { envelopeOf(it["listing"]) } ?: return ListingCheck(false, "no_listing", emptyList())
        return verifyListing(listing, pin, nonce, deviceId, mine.mapNotNull { envelopeOf(it["status"]) })
    }

    /** What a phone says of a pinned node it has no accepted listing from (R-F5-20). Never "nothing is running": this phone does not know. */
    fun couldNotConfirm(nodeName: String): String = "Could not confirm with ${Display.escape(nodeName)}"

    /** Under those rows: what it means and what it does not. */
    const val COULD_NOT_CONFIRM_DETAIL = "No signed answer about computer use came from there. It may be off or out of reach, or the relay may be keeping its answer back. A lease could be running."

    /**
     * What a phone says of a pinned node it has not asked yet (fourth
     * security review, finding 2). Not "nothing is running": nothing has
     * been checked.
     */
    fun notCheckedYet(nodeName: String): String = "Not checked yet: ${Display.escape(nodeName)}"

    /** Under those rows. */
    const val NOT_CHECKED_YET_DETAIL = "This phone has not asked there about computer use yet, so it does not know whether a session is running."

    /**
     * What a phone says of a pinned node whose listing it accepted
     * ([checkListing]), and only of such a node: [time] is when this phone
     * accepted it, by its own clock, so an old answer never reads as a
     * current one. [running] counts the leases it listed that are live,
     * [waiting] those still waiting for a phone's answer.
     */
    fun checked(nodeName: String, time: String, running: Int, waiting: Int): String {
        val sessions = if (running == 0) "no computer-use session" else if (running == 1) "1 computer-use session running" else "$running computer-use sessions running"
        val requests = if (waiting == 0) "" else if (waiting == 1) "; 1 request waiting for an answer" else "; $waiting requests waiting for an answer"
        return "Checked ${Display.escape(nodeName)} at $time: $sessions$requests"
    }

    /** The statuses an accepted listing names, read. None for a listing that was not accepted: such a listing says nothing. */
    fun listedStatuses(check: ListingCheck, pin: NodePin): List<LeaseStatus> =
        if (!check.accepted) emptyList() else check.statuses.mapNotNull { envelope -> verifiedMessage(envelope, pin)?.let { LeaseStatus.from(it) } }

    /** A node-signed message whose signature, kid and node_id are all the pinned node's; null otherwise. */
    fun verifiedMessage(envelope: Envelope, pin: NodePin): JsonObject? {
        if (envelope.alg != "Ed25519" || envelope.kid != pin.id || !envelope.verifyEd25519(pin.key)) return null
        val m = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return null
        }
        return m.takeIf { it["node_id"].str() == pin.id }
    }

    fun verifyView(envelope: Envelope, pin: NodePin): ViewCheck {
        val bytes = try {
            envelope.payloadBytes()
        } catch (e: ProtocolException) {
            return ViewCheck(false, "malformed", null)
        }
        if (bytes.size > VIEW_MAX_BYTES) return ViewCheck(false, "too_large", null)
        if (envelope.alg != "Ed25519" || envelope.kid != pin.id) return ViewCheck(false, "malformed", null)
        if (!envelope.verifyEd25519(pin.key)) return ViewCheck(false, "bad_signature", null)
        val m = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return ViewCheck(false, "malformed", null)
        }
        if (m["type"].str() != "kl.lease.view") return ViewCheck(false, "malformed", null)
        if (m["node_id"].str() != pin.id) return ViewCheck(false, "wrong_node", null)
        var frame: ByteArray? = null
        val f: JsonElement? = m["frame"]
        if (f != null && f !is JsonNull) {
            val text = f["data"].str() ?: return ViewCheck(false, "malformed", null)
            val hash = f["sha256"].str() ?: return ViewCheck(false, "malformed", null)
            val data = try {
                Base64.getDecoder().decode(text)
            } catch (e: IllegalArgumentException) {
                return ViewCheck(false, "malformed", null)
            }
            if (Digest.sha256B64url(data) != hash) return ViewCheck(false, "frame_hash_mismatch", null)
            frame = data
        }
        val actions = (m["actions"].arr() ?: JsonArray(emptyList())).mapNotNull { a ->
            LeaseAction(
                a["seq"].int() ?: return@mapNotNull null, a["at"].str() ?: return@mapNotNull null, a["tool"].str() ?: return@mapNotNull null,
                a["summary"].str() ?: return@mapNotNull null, a["result"].str() ?: return@mapNotNull null
            )
        }
        val view = LeaseView(
            m["lease_id"].str() ?: return ViewCheck(false, "malformed", null), pin.id, m["seq"].int() ?: return ViewCheck(false, "malformed", null),
            m["to_device"].str() ?: return ViewCheck(false, "malformed", null),
            m["state"].str() ?: return ViewCheck(false, "malformed", null), m["locked"].bool() ?: false, m["remaining_s"].int() ?: 0,
            m["foreground"]["app_id"].str(), m["foreground"]["matches"].bool() ?: false, frame, m["frame_dropped"].bool() ?: false, actions,
            m["contact_token"].str()
        )
        return ViewCheck(true, null, view)
    }
}
