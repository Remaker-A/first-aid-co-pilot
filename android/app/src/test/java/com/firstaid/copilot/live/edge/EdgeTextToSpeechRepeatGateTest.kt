package com.firstaid.copilot.live.edge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeTextToSpeechRepeatGateTest {
    @Test
    fun suppressesNormalRepeatInsideCooldown() {
        assertTrue(
            shouldSuppressRepeatedLocalTts(
                text = "继续保持这个节奏。",
                lastText = "继续保持这个节奏。",
                nowMs = 12_000L,
                lastAtMs = 2_000L,
                priority = "normal",
                interruptPolicy = "do_not_interrupt_critical",
                tone = "calm_firm",
            ),
        )
    }

    @Test
    fun allowsNormalRepeatAfterCooldown() {
        assertFalse(
            shouldSuppressRepeatedLocalTts(
                text = "继续保持这个节奏。",
                lastText = "继续保持这个节奏。",
                nowMs = DEFAULT_LOCAL_TTS_REPEAT_SUPPRESSION_MS + 2_001L,
                lastAtMs = 1_000L,
                priority = "normal",
                interruptPolicy = "do_not_interrupt_critical",
                tone = "calm_firm",
            ),
        )
    }

    @Test
    fun allowsCriticalRepeatInsideCooldown() {
        assertFalse(
            shouldSuppressRepeatedLocalTts(
                text = "按疑似心脏骤停处理。",
                lastText = "按疑似心脏骤停处理。",
                nowMs = 4_000L,
                lastAtMs = 1_000L,
                priority = "critical",
                interruptPolicy = "interrupt_lower_priority",
                tone = "urgent",
            ),
        )
    }
}
