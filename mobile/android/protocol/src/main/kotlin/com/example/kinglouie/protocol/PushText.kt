package com.example.kinglouie.protocol

/**
 * What a push notification says and where it goes (push spec §7.1, §7.2;
 * R-PU-4, C-6, C-8). A push carries `k`, `rid`, `n` and, on a coalesced one,
 * `c`; everything shown is built here from those, never from the relay's
 * words. The fcm flavor's Push.kt is the only caller; it adds no buttons.
 */
object PushText {
    /** The relay's fcm kinds (`src/frontdoor/push/text.js` KINDS less `grant`, which goes to APNs only). */
    val KINDS = setOf("approval", "question", "lease", "pairing", "alert", "session_ended", "session_paused", "test")

    /** The kinds that share the one replaced notification with its running count. */
    val APPROVAL_KINDS = setOf("approval", "question", "lease", "pairing", "alert")

    const val APPROVALS_CHANNEL = "approvals"

    /** Endings and pauses (C-8): their own channel, so the owner can quiet them alone. */
    const val SESSIONS_CHANNEL = "sessions"

    /** The tag of the one Approvals notification. */
    const val APPROVALS_TAG = "approvals"

    const val NODE_NAME_MAX = 40

    /** `n`: letters, digits, spaces and `._-`, trimmed, at most 40 characters. */
    fun nodeName(raw: String?): String =
        raw.orEmpty().filter { it.isLetterOrDigit() || it == ' ' || it in "._-" }.trim().take(NODE_NAME_MAX).trim()

    /** How many items one push stands for: `c` when it is 2 to 999, else 1. */
    fun itemsIn(c: String?): Int = c?.toIntOrNull()?.takeIf { it in 2..999 } ?: 1

    /** The Approvals notification's text for a running [count] (the newest push's [kind] at 1). */
    fun approvalText(kind: String, node: String, count: Int): String {
        if (count > 1) return "$count waiting"
        return when (kind) {
            "pairing" -> "Pairing request"
            "alert" -> "Front door alert"
            "question" -> on("Question waiting", node)
            "lease" -> on("Session request", node)
            else -> on("Approval needed", node)
        }
    }

    /** `session_ended`, `session_paused` and `test`. */
    fun otherText(kind: String, node: String): String = when (kind) {
        "session_ended" -> on("Session ended", node)
        "session_paused" -> on("Session paused", node) + ": open to continue"
        else -> if (node.isEmpty()) "Test notification" else "Test notification from $node"
    }

    /**
     * Whether a push of [kind] standing for [items] (from [itemsIn]) shows as
     * the one Approvals notification with its running count. A coalesced push
     * (items above 1) of any kind does: the relay's window may hold Approvals
     * and a session kind, and `k` is only the newest's (push spec §6.4, §7.2,
     * read on the phone side). With c absent or 1, the session kinds and
     * `test` keep their own notifications.
     */
    fun joinsApprovals(kind: String, items: Int): Boolean =
        kind in KINDS && (kind in APPROVAL_KINDS || items > 1)

    /** The notification's tag, or null for a kind this app does not show. */
    fun tag(kind: String, rid: String, items: Int = 1): String? = when {
        kind !in KINDS -> null
        joinsApprovals(kind, items) -> APPROVALS_TAG
        kind == "session_ended" -> "ended:$rid"
        kind == "session_paused" -> "paused:$rid"
        else -> "test:$rid"
    }

    fun channel(kind: String, items: Int = 1): String =
        if (!joinsApprovals(kind, items) && (kind == "session_ended" || kind == "session_paused")) SESSIONS_CHANNEL else APPROVALS_CHANNEL

    /** A tap with a count above 1, a test, or a kind with no detail opens the Approvals list. */
    fun opensList(kind: String, count: Int): Boolean =
        count > 1 || kind == "test" || kind !in KINDS

    private fun on(what: String, node: String): String = if (node.isEmpty()) what else "$what on $node"
}
