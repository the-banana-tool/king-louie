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

    /** Fourth security review, finding 3: a pending lease this phone signed a grant for may still start; when its row stays. */
    @Test
    fun mayStillStart() {
        assertTrue(Leases.mayStillStart("pending", true))
        assertTrue(!Leases.mayStillStart("pending", false))
        for (state in listOf("active", "suspended", "ended", "")) assertTrue(!Leases.mayStillStart(state, true))
        // Named by an accepted listing: kept only while still pending.
        assertTrue(Leases.keepsMayStart("pending", false))
        assertTrue(Leases.keepsMayStart("pending", true))
        for (state in listOf("active", "suspended", "ended")) assertTrue(!Leases.keepsMayStart(state, false))
        // Not named: kept until the request has expired.
        assertTrue(Leases.keepsMayStart(null, false))
        assertTrue(!Leases.keepsMayStart(null, true))
        assertEquals("May still start on gpu-box", Leases.mayStillStartTitle("gpu-box"))
        assertTrue(!Leases.mayStillStartTitle("gpu\u202Ebox").contains('\u202E'))
    }

    /** Fifth security review, finding 1: a pending lease an accepted listing names gets a row whatever this phone remembers; what it remembers only chooses the words. */
    @Test
    fun listedPendingGetsRow() {
        // No memory of a grant (a restarted app, or another phone), no request on screen: a row.
        assertTrue(Leases.listedPendingGetsRow("pending", shownAsRequest = false, signedGrant = false))
        assertTrue(Leases.listedPendingGetsRow("pending", shownAsRequest = false, signedGrant = true))
        assertTrue(Leases.listedPendingGetsRow("pending", shownAsRequest = true, signedGrant = true))
        // The request is on screen, unanswered by this phone: that card is its row.
        assertTrue(!Leases.listedPendingGetsRow("pending", shownAsRequest = true, signedGrant = false))
        for (state in listOf("active", "suspended", "ended", "")) assertTrue(!Leases.listedPendingGetsRow(state, shownAsRequest = false, signedGrant = true))
        assertEquals("May still start on gpu-box", Leases.pendingTitle("gpu-box", true))
        assertEquals("A request is waiting on gpu-box", Leases.pendingTitle("gpu-box", false))
        val rlo = Char(0x202E)
        assertTrue(!Leases.requestWaitingTitle("gpu${rlo}box").contains(rlo))
        assertEquals(Leases.MAY_STILL_START_DETAIL, Leases.pendingDetail(true))
        assertEquals(Leases.REQUEST_WAITING_DETAIL, Leases.pendingDetail(false))
        assertTrue(Leases.REQUEST_WAITING_DETAIL.contains("does not remember allowing it"))
        assertTrue(!Leases.REQUEST_WAITING_DETAIL.contains("This phone signed"))
    }

    /** Fourth security review, finding 2: the words for a node not asked yet and for one whose listing was accepted. */
    @Test
    fun checkedWords() {
        assertEquals("Not checked yet: gpu-box", Leases.notCheckedYet("gpu-box"))
        assertEquals("Checked gpu-box at 14:02: no computer-use session", Leases.checked("gpu-box", "14:02", 0, 0))
        assertEquals("Checked gpu-box at 14:02: 1 computer-use session running", Leases.checked("gpu-box", "14:02", 1, 0))
        assertEquals("Checked gpu-box at 14:02: 2 computer-use sessions running; 1 request waiting for an answer", Leases.checked("gpu-box", "14:02", 2, 1))
        assertEquals("Checked gpu-box at 14:02: no computer-use session; 2 requests waiting for an answer", Leases.checked("gpu-box", "14:02", 0, 2))
    }

    /** R-F5-18: which leases get a banner, and what a phone says of one it did not grant. */
    @Test
    fun liveAndGrantedBy() {
        assertTrue(Leases.isLive("active"))
        assertTrue(Leases.isLive("suspended"))
        assertTrue(!Leases.isLive("pending"))
        assertTrue(!Leases.isLive("ended"))
        assertTrue(!Leases.isLive(""))
        assertEquals(null, Leases.grantedByOther("d-me", "My phone", "d-me"))
        assertEquals(null, Leases.grantedByOther(null, null, "d-me"))
        assertEquals("Granted by Owner phone", Leases.grantedByOther("d-other", "Owner phone", "d-me"))
        assertEquals("Granted by another phone (d-other)", Leases.grantedByOther("d-other", null, "d-me"))
        assertEquals("Granted by another phone (d-other)", Leases.grantedByOther("d-other", "", "d-me"))
        // A phone with no key of its own (it cannot be the granting one) still names the granter.
        assertEquals("Granted by Owner phone", Leases.grantedByOther("d-other", "Owner phone", null))
        // The name is the node's word for a device: shown escaped.
        assertTrue(!Leases.grantedByOther("d-other", "Owner‮phone", "d-me")!!.contains('‮'))
    }

    /** R-F5-15: Refresh asks for a fresh status first when the token it holds is over a minute old, or it holds none. */
    @Test
    fun tokenIsStale() {
        assertEquals(60_000L, Leases.TOKEN_FRESH_MS)
        assertTrue(Leases.tokenIsStale(null, 5_000L))
        assertTrue(!Leases.tokenIsStale(1_000L, 1_000L))
        assertTrue(!Leases.tokenIsStale(1_000L, 60_999L))
        assertTrue(Leases.tokenIsStale(1_000L, 61_000L))
        assertTrue(Leases.tokenIsStale(1_000L, 500_000L))
    }

    /** R-F5-16: nothing older than what is on screen, and no view made for another device. */
    @Test
    fun orderAndAddressee() {
        fun status(seq: Int) = LeaseStatus("lease-1", "kl-node", seq, "active", false, null, null)
        fun view(seq: Int, toDevice: String) = LeaseView("lease-1", "kl-node", seq, toDevice, "active", false, 60, null, false, null, false, emptyList())
        assertTrue(Leases.acceptsStatus(status(1), 0))
        assertTrue(Leases.acceptsStatus(status(8), 7))
        // The same seq again (a replay) and an older one (held back, then delivered) are dropped.
        assertTrue(!Leases.acceptsStatus(status(7), 7))
        assertTrue(!Leases.acceptsStatus(status(3), 7))
        assertTrue(Leases.acceptsView(view(8, "d-me"), 7, "d-me"))
        assertTrue(!Leases.acceptsView(view(7, "d-me"), 7, "d-me"))
        assertTrue(!Leases.acceptsView(view(2, "d-me"), 7, "d-me"))
        // Newer, but addressed to another phone.
        assertTrue(!Leases.acceptsView(view(9, "d-other"), 7, "d-me"))
        assertTrue(!Leases.acceptsView(view(9, ""), 7, "d-me"))
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
