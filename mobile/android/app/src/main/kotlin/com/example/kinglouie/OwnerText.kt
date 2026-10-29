package com.example.kinglouie

import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.FrontDoorReply

// The owner's words for what came back (split out of AppModel.kt; android-slim
// review S8). Pure functions: every string a relay, node or front door sent is
// escaped here before it reaches a banner or a prompt.

/** A node's or the relay's refusal reason, in the owner's words. */
internal fun friendlyReason(reason: String?): String = when (reason) {
    null, "" -> "no reason given"
    "action_changed" -> "the action changed before it ran"
    "expired" -> "too late — request expired"
    else -> Display.escape(reason)
}

/** At most `max` code points, then escaped (never cut through an escape). */
internal fun promptText(text: String, max: Int): String {
    val cps = text.codePoints().toArray()
    val cut = if (cps.size <= max) text else String(cps, 0, max - 1) + "…"
    return Display.escape(cut)
}

/**
 * A front-door answer that did not confirm what was asked, in the owner's
 * words. Known codes are worded; any other code, and a 2xx without the
 * expected state, is shown as neutral data, never as success.
 */
internal fun frontDoorUnconfirmed(reply: FrontDoorReply): String = when (reply) {
    is FrontDoorReply.Done -> "The front door answered but did not confirm it (state: ${reply.state ?: "none"}). Check again before relying on it."
    is FrontDoorReply.Refused -> when (reply.code) {
        "expired", "unknown_request" -> "This request expired or was already decided. Start again in the client."
        "not_claimant" -> "Another phone claimed this request."
        "forbidden" -> "This phone is not an approver on this front door."
        "revoked_device" -> "This phone was revoked on this front door."
        "unknown_machine" -> "The front door has no machine by one of the names chosen. Choose again."
        "already_decided" -> "This was already decided."
        "unknown_pairing" -> "This pairing expired or was withdrawn."
        "replaces_changed" -> "The node this one replaces changed. Check the pairing again."
        "key_enrolled_as_other_name" -> "This node's key is already enrolled under another name."
        "console_record" -> "This node was confirmed at the console. Remove it there with frontdoor remove-node."
        "save_failed" -> "The front door could not save this. Try again" + (reply.retryAfterSeconds?.let { " in $it s." } ?: ".")
        "not_found" -> "The front door no longer has it."
        null -> "The front door did not confirm this (HTTP ${reply.status})."
        else -> "The front door did not confirm this (${reply.code}, HTTP ${reply.status})."
    }
}
