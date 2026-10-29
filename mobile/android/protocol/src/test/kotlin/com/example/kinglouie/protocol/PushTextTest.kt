package com.example.kinglouie.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spec 2026-10-28-push-notifications-design.md §7.1, §7.2 (R-PU-4, C-6, C-8). */
class PushTextTest {
    @Test
    fun acceptsTheEightKindsAndNothingElse() {
        assertEquals(
            setOf("approval", "question", "lease", "pairing", "alert", "session_ended", "session_paused", "test"),
            PushText.KINDS
        )
        assertFalse("grant" in PushText.KINDS)
        assertEquals(setOf("approval", "question", "lease", "pairing", "alert"), PushText.APPROVAL_KINDS)
    }

    @Test
    fun nodeNameKeepsSpacesAndTrimsAndCapsAt40() {
        assertEquals("web 01", PushText.nodeName("web 01"))
        assertEquals("gpu-box.lan_2", PushText.nodeName("  gpu-box.lan_2\n"))
        assertEquals("evil node", PushText.nodeName("evil‮ node\u0000"))
        assertEquals("a".repeat(40), PushText.nodeName("a".repeat(60)))
        assertEquals("", PushText.nodeName(null))
        assertEquals("", PushText.nodeName("   "))
    }

    @Test
    fun countAddsCOnlyInItsRange() {
        assertEquals(1, PushText.itemsIn(null))
        assertEquals(1, PushText.itemsIn("1"))
        assertEquals(7, PushText.itemsIn("7"))
        assertEquals(999, PushText.itemsIn("999"))
        assertEquals(1, PushText.itemsIn("1000"))
        assertEquals(1, PushText.itemsIn("x"))
    }

    @Test
    fun approvalTextAtOneNamesTheKindAboveOneTheCount() {
        assertEquals("Approval needed on gpu-box", PushText.approvalText("approval", "gpu-box", 1))
        assertEquals("Approval needed", PushText.approvalText("approval", "", 1))
        assertEquals("Question waiting on gpu-box", PushText.approvalText("question", "gpu-box", 1))
        assertEquals("Session request on gpu-box", PushText.approvalText("lease", "gpu-box", 1))
        assertEquals("Pairing request", PushText.approvalText("pairing", "gpu-box", 1))
        assertEquals("Front door alert", PushText.approvalText("alert", "gpu-box", 1))
        assertEquals("10 waiting", PushText.approvalText("approval", "gpu-box", 10))
        assertEquals("2 waiting", PushText.approvalText("alert", "", 2))
    }

    @Test
    fun sessionAndTestTexts() {
        assertEquals("Session ended on gpu-box", PushText.otherText("session_ended", "gpu-box"))
        assertEquals("Session paused on gpu-box: open to continue", PushText.otherText("session_paused", "gpu-box"))
        assertEquals("Test notification from gpu-box", PushText.otherText("test", "gpu-box"))
        assertEquals("Session ended", PushText.otherText("session_ended", ""))
        assertEquals("Session paused: open to continue", PushText.otherText("session_paused", ""))
        assertEquals("Test notification", PushText.otherText("test", ""))
    }

    @Test
    fun tagsAndChannels() {
        assertEquals("approvals", PushText.tag("approval", "r1"))
        assertEquals("approvals", PushText.tag("alert", "r1"))
        assertEquals("ended:l-1", PushText.tag("session_ended", "l-1"))
        assertEquals("paused:l-1", PushText.tag("session_paused", "l-1"))
        assertEquals("test:t-1", PushText.tag("test", "t-1"))
        assertEquals(PushText.APPROVALS_CHANNEL, PushText.channel("approval"))
        assertEquals(PushText.APPROVALS_CHANNEL, PushText.channel("test"))
        assertEquals(PushText.SESSIONS_CHANNEL, PushText.channel("session_ended"))
        assertEquals(PushText.SESSIONS_CHANNEL, PushText.channel("session_paused"))
        assertEquals("approvals", PushText.APPROVALS_CHANNEL)
        assertEquals("sessions", PushText.SESSIONS_CHANNEL)
        assertNull(PushText.tag("grant", "r1"))
    }

    @Test
    fun aCoalescedPushOfAnyKindJoinsTheRunningCount() {
        // A session kind may be the newest of a window that also held Approvals (§6.4).
        assertTrue(PushText.joinsApprovals("session_ended", 2))
        assertTrue(PushText.joinsApprovals("session_paused", 9))
        assertTrue(PushText.joinsApprovals("test", 3))
        assertTrue(PushText.joinsApprovals("approval", 1))
        assertFalse(PushText.joinsApprovals("session_ended", 1))
        assertFalse(PushText.joinsApprovals("session_paused", 1))
        assertFalse(PushText.joinsApprovals("test", 1))
        assertFalse(PushText.joinsApprovals("grant", 5))
        assertEquals("approvals", PushText.tag("session_ended", "l-1", 3))
        assertEquals("approvals", PushText.tag("session_paused", "l-1", 2))
        assertEquals("approvals", PushText.tag("test", "t-1", 2))
        assertEquals("ended:l-1", PushText.tag("session_ended", "l-1", 1))
        assertNull(PushText.tag("grant", "r1", 4))
        assertEquals(PushText.APPROVALS_CHANNEL, PushText.channel("session_ended", 3))
        assertEquals(PushText.APPROVALS_CHANNEL, PushText.channel("session_paused", 2))
        assertEquals(PushText.SESSIONS_CHANNEL, PushText.channel("session_paused", 1))
        assertEquals("4 waiting", PushText.approvalText("session_ended", "gpu-box", 4))
        assertTrue(PushText.opensList("session_ended", 4))
    }

    @Test
    fun aTapOpensTheListForACountOrATest() {
        assertTrue(PushText.opensList("approval", 2))
        assertTrue(PushText.opensList("test", 1))
        assertTrue(PushText.opensList("grant", 1))
        assertFalse(PushText.opensList("approval", 1))
        assertFalse(PushText.opensList("session_paused", 1))
    }
}
