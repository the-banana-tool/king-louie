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

data class LeaseStatus(val leaseId: String, val nodeId: String, val seq: Int, val state: String, val locked: Boolean, val reason: String?, val expiresAt: String?) {
    companion object {
        const val TYPE = "kl.lease.status"

        fun from(m: JsonElement): LeaseStatus? {
            if (m["type"].str() != TYPE) return null
            return LeaseStatus(
                m["lease_id"].str() ?: return null, m["node_id"].str() ?: return null, m["seq"].int() ?: return null,
                m["state"].str() ?: return null, m["locked"].bool() ?: return null, m["reason"].str(), m["expires_at"].str()
            )
        }
    }
}

data class LeaseAction(val seq: Int, val at: String, val tool: String, val summary: String, val result: String)

class LeaseView(
    val leaseId: String, val nodeId: String, val seq: Int, val state: String, val locked: Boolean, val remainingS: Int,
    val foregroundAppId: String?, val foregroundMatches: Boolean, val frame: ByteArray?, val frameDropped: Boolean, val actions: List<LeaseAction>
)

data class ViewCheck(val accepted: Boolean, val reason: String?, val view: LeaseView?)

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
     * resumes it on that phone's next watch; nothing is extended.
     */
    const val NO_CONTACT = "no_contact"

    /** Whether a signed state and reason say input is paused for want of contact. */
    fun isPausedForContact(state: String, reason: String?): Boolean = state == "suspended" && reason == NO_CONTACT

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

    fun watch(nodeId: String, leaseId: String, deviceId: String, nonce: String, signedAt: String): JsonObject = JsonObject(
        mapOf(
            "v" to jsonNumber("1"), "type" to jsonString("kl.lease.watch"), "node_id" to jsonString(nodeId), "lease_id" to jsonString(leaseId),
            "device_id" to jsonString(deviceId), "nonce" to jsonString(nonce), "signed_at" to jsonString(signedAt)
        )
    )

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
            m["state"].str() ?: return ViewCheck(false, "malformed", null), m["locked"].bool() ?: false, m["remaining_s"].int() ?: 0,
            m["foreground"]["app_id"].str(), m["foreground"]["matches"].bool() ?: false, frame, m["frame_dropped"].bool() ?: false, actions
        )
        return ViewCheck(true, null, view)
    }
}
