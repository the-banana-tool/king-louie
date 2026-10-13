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
