package com.firstaid.copilot.live.perception

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PerceptionSignalTest {
    @Test
    fun qualityReflectsFreshnessAndConfidence() {
        val now = 10_000L
        assertEquals(
            DataQuality.Confident,
            assessDataQuality("center", 0.9, "vision_cpr", now, ttlMs = 1_000L, nowMs = now),
        )
        assertEquals(
            DataQuality.LowConfidence,
            assessDataQuality("center", 0.4, "vision_cpr", now, ttlMs = 1_000L, nowMs = now),
        )
        assertEquals(
            DataQuality.Unknown,
            assessDataQuality("center", 0.9, "vision_cpr", timestampMs = 0L, ttlMs = 1_000L, nowMs = now),
        )
        assertEquals(
            DataQuality.SensorUnavailable,
            assessDataQuality("center", 0.9, "sensor_unavailable", now, ttlMs = 1_000L, nowMs = now),
        )
    }

    @Test
    fun signalFreshnessExpiresAfterTtl() {
        val signal = PerceptionSignal(
            key = "hand_position",
            value = "center",
            confidence = 0.9,
            source = "vision_cpr",
            timestampMs = 100L,
            ttlMs = 50L,
        )

        assertTrue(signal.isFresh(nowMs = 120L))
        assertFalse(signal.isFresh(nowMs = 200L))
    }

    @Test
    fun handPositionUsesTwoFrameCorrectionAndThreeFrameRelease() {
        val hysteresis = HandPositionHysteresis()

        assertEquals(null, hysteresis.update("left"))
        assertEquals("left", hysteresis.update("left"))
        assertEquals("left", hysteresis.update("center"))
        assertEquals("left", hysteresis.update("center"))
        assertEquals("center", hysteresis.update("center"))
    }

    @Test
    fun qualityScoreUsesEmaAndNormalizesToPercent() {
        val score = EmaQualityScore(alpha = 0.3)

        assertEquals(50, score.update(0.5))
        assertEquals(65, score.update(100.0))
    }

    @Test
    fun interruptionTwoSecondsOrMoreIsNotSmoothed() {
        assertEquals(3.0, smoothInterruptionSeconds(rawSeconds = 3.0, previousSeconds = 0.5), 0.0)
        assertEquals(0.5, smoothInterruptionSeconds(rawSeconds = 1.0, previousSeconds = 0.5), 0.0)
    }
}
