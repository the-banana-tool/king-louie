package com.example.kinglouie.protocol

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Telling a box key that stopped working from a phone just unlocked (sealed phones, Task 10's review). */
class BoxKeyHealthTest {
    @Test
    fun aFewFailuresRightAfterUnlockAreNotBroken() {
        val health = BoxKeyHealth(strikesToBreak = 3, afterMs = 30_000)
        // Many fetches in the race right after unlock: the count is met, the time is not.
        for (t in 0L..4L) health.failedUnlocked(t * 1000)
        assertFalse(health.broken)
    }

    @Test
    fun oneLateFailureIsNotBroken() {
        val health = BoxKeyHealth(strikesToBreak = 3, afterMs = 30_000)
        health.failedUnlocked(0)
        health.failedUnlocked(60_000)
        assertFalse(health.broken)
    }

    @Test
    fun failuresThatLastAreBroken() {
        val health = BoxKeyHealth(strikesToBreak = 3, afterMs = 30_000)
        health.failedUnlocked(0)
        health.failedUnlocked(15_000)
        assertFalse(health.broken)
        health.failedUnlocked(30_000)
        assertTrue(health.broken)
    }

    @Test
    fun anOpenOrALockedPhoneStartsTheCountAgain() {
        val health = BoxKeyHealth(strikesToBreak = 3, afterMs = 30_000)
        health.failedUnlocked(0)
        health.failedUnlocked(15_000)
        health.opened()
        health.failedUnlocked(30_000)
        assertFalse(health.broken)
        health.failedUnlocked(40_000)
        health.locked()
        health.failedUnlocked(61_000)
        assertFalse(health.broken)
    }

    @Test
    fun anOpenEndsBroken() {
        val health = BoxKeyHealth(strikesToBreak = 1, afterMs = 0)
        health.failedUnlocked(0)
        assertTrue(health.broken)
        health.opened()
        assertFalse(health.broken)
    }
}
