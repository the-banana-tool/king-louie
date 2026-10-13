package com.example.kinglouie.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Owner rulings R-F5-5 and R-F5-6 (2026-10-12): what the Android lease screens decide without a network. */
class LeaseFlowTest {
    private fun json(text: String) = JsonText.parse(text.toByteArray())

    @Test
    fun sendOutcome() {
        assertEquals(SendOutcome.Confirmed("active"), Leases.sendOutcome(json("""{"state":"active"}""")))
        assertEquals(SendOutcome.Confirmed("ended"), Leases.sendOutcome(json("""{"state":"ended","reason":"job_closed"}""")))
        assertEquals(SendOutcome.Rejected("minutes_out_of_range"), Leases.sendOutcome(json("""{"state":"rejected","reason":"minutes_out_of_range"}""")))
        assertEquals(SendOutcome.Rejected(null), Leases.sendOutcome(json("""{"state":"rejected"}""")))
        // No answer, or one with no state, is never read as success.
        assertTrue(Leases.sendOutcome(null) is SendOutcome.Unconfirmed)
        assertTrue(Leases.sendOutcome(json("""{}""")) is SendOutcome.Unconfirmed)
        assertTrue(Leases.sendOutcome(json("""{"state":7}""")) is SendOutcome.Unconfirmed)
        assertTrue(Leases.sendOutcome(json("""[]""")) is SendOutcome.Unconfirmed)
    }

    /** A Stop's reply is the relay's word: no outcome lets the screen say the lease is over. */
    @Test
    fun stopNotice() {
        val sent = Leases.stopNotice(SendOutcome.Confirmed("ended"), null)
        assertTrue(sent.startsWith("Stop sent, not yet confirmed by the computer."))
        // The same words whatever state the reply named: it is not repeated, and never believed.
        assertEquals(sent, Leases.stopNotice(SendOutcome.Confirmed("active"), null))
        assertEquals(sent, Leases.stopNotice(SendOutcome.Confirmed("<b>ended</b>"), null))
        val refused = Leases.stopNotice(SendOutcome.Rejected("unknown_lease"), null)
        assertTrue(refused.contains("refused (unknown_lease)") && refused.contains("may still be active"))
        assertTrue(Leases.stopNotice(SendOutcome.Rejected(null), null).contains("no reason given"))
        val lost = Leases.stopNotice(SendOutcome.Unconfirmed, "no network")
        assertTrue(lost.startsWith("Stop not confirmed: no network.") && lost.contains("may still be active"))
        assertTrue(Leases.stopNotice(SendOutcome.Unconfirmed, null).startsWith("Stop not confirmed: no answer."))
        for (text in listOf(sent, refused, lost)) {
            assertTrue(text.contains("Stop now again"))
            assertTrue(!text.contains("ended") && !text.contains("stopped"))
        }
    }

    /** R-F5-15: only the node's own word "suspended, no_contact" is the pause the screen names. */
    @Test
    fun pausedForContact() {
        assertEquals("no_contact", Leases.NO_CONTACT)
        assertTrue(Leases.isPausedForContact("suspended", "no_contact"))
        assertTrue(!Leases.isPausedForContact("suspended", "foreground_changed"))
        assertTrue(!Leases.isPausedForContact("suspended", null))
        assertTrue(!Leases.isPausedForContact("active", "no_contact"))
        assertTrue(!Leases.isPausedForContact("ended", "no_contact"))
    }

    @Test
    fun cursorAfterWatch() {
        assertEquals(5, Leases.REFRESH_WAIT_S)
        assertEquals(12, Leases.cursorAfterWatch(0, json("""{"state":"active","after_seq":12}""")))
        // Never behind what this phone has already seen.
        assertEquals(20, Leases.cursorAfterWatch(20, json("""{"state":"active","after_seq":12}""")))
        // A relay that sends no position, or a bad one, leaves the cursor where it was.
        assertEquals(7, Leases.cursorAfterWatch(7, json("""{"state":"active"}""")))
        assertEquals(7, Leases.cursorAfterWatch(7, json("""{"state":"active","after_seq":"12"}""")))
        assertEquals(7, Leases.cursorAfterWatch(7, null))
    }

    /** A node sends an action again when a watch starts over; the log holds each one once, newest first. */
    @Test
    fun mergedActions() {
        fun action(seq: Int, summary: String = "") = LeaseAction(seq, "2026-09-23T18:04:11.201Z", "Click", summary, "ok")
        val merged = Leases.mergedActions(listOf(action(3), action(2), action(1)), listOf(action(2, "again"), action(4)))
        assertEquals(listOf(4, 3, 2, 1), merged.map { it.seq })
        assertEquals("again", merged.first { it.seq == 2 }.summary)
        val many = Leases.mergedActions(emptyList(), (1..250).map { action(it) })
        assertEquals(Leases.ACTIONS_KEPT, many.size)
        assertEquals(250, many.first().seq)
    }
}
