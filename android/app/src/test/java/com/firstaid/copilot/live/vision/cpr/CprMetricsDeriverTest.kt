package com.firstaid.copilot.live.vision.cpr

import kotlin.math.PI
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CprMetricsDeriverTest {
    @Test
    fun update_estimatesCompressionRateFromRhythmicWristMotion() {
        val deriver = CprMetricsDeriver()
        var latest: CprMetricsSnapshot? = null

        for (frame in 0..150) {
            val timestampMs = frame * 33L
            val y = 0.56 + 0.04 * sin(2.0 * PI * 110.0 * timestampMs / 60_000.0)
            latest = deriver.update(landmarks(wristY = y), timestampMs)
        }

        assertNotNull(latest)
        assertTrue(latest!!.compressionsStarted)
        assertEquals(110.0, latest.compressionRate ?: 0.0, 5.0)
        assertTrue(latest.totalCompressions > 5)
    }

    @Test
    fun update_accumulatesInterruptionAfterMotionStops() {
        val deriver = CprMetricsDeriver()
        var latest: CprMetricsSnapshot? = null

        for (frame in 0..120) {
            val timestampMs = frame * 33L
            val y = 0.56 + 0.04 * sin(2.0 * PI * 110.0 * timestampMs / 60_000.0)
            latest = deriver.update(landmarks(wristY = y), timestampMs)
        }
        for (frame in 121..220) {
            latest = deriver.update(landmarks(wristY = 0.56), frame * 33L)
        }

        assertNotNull(latest)
        assertTrue(latest!!.interruptionSeconds >= 2.0)
    }

    @Test
    fun update_classifiesHandPositionOffsets() {
        val left = CprMetricsDeriver().update(landmarks(wristX = 0.39), 1_000L)
        val right = CprMetricsDeriver().update(landmarks(wristX = 0.61), 1_000L)
        val center = CprMetricsDeriver().update(landmarks(wristX = 0.50), 1_000L)

        assertEquals("left", left?.handPosition)
        assertEquals("right", right?.handPosition)
        assertEquals("center", center?.handPosition)
    }

    @Test
    fun update_mirrorsFrontCameraXCoordinatesBeforeClassifyingOffsets() {
        val mirrored = CprMetricsDeriver(
            CprMetricsDeriver.Options(mirrorX = true),
        ).update(landmarks(wristX = 0.39), 1_000L)

        assertEquals("right", mirrored?.handPosition)
    }

    @Test
    fun update_classifiesBentArms() {
        val snapshot = CprMetricsDeriver().update(landmarks(bentArms = true), 1_000L)

        assertFalse(snapshot?.armStraight ?: true)
    }

    @Test
    fun update_nullsGuessedFieldsWhenConfidenceIsLow() {
        val snapshot = CprMetricsDeriver().update(landmarks(confidence = 0.2), 1_000L)

        assertEquals(0.2, snapshot?.confidence ?: 0.0, 0.0)
        assertNull(snapshot?.compressionRate)
        assertNull(snapshot?.handPosition)
        assertNull(snapshot?.armStraight)
        assertNull(snapshot?.qualityScore)
    }

    @Test
    fun update_marksVisionReadyOnlyAfterStableCoveredFrames() {
        val deriver = CprMetricsDeriver()

        val first = deriver.update(landmarks(), 0L)
        deriver.update(landmarks(), 400L)
        val third = deriver.update(landmarks(), 800L)

        assertFalse(first?.visionReady ?: true)
        assertTrue(third?.visionReady ?: false)
        assertTrue((third?.poseCoverage ?: 0.0) >= 0.75)
        assertTrue((third?.frameStability ?: 0.0) >= 0.75)
    }

    @Test
    fun update_keepsVisionNotReadyWhenFrameIsUnstable() {
        val deriver = CprMetricsDeriver()
        var latest: CprMetricsSnapshot? = null

        listOf(0.0, 0.16, -0.16).forEachIndexed { index, shift ->
            latest = deriver.update(landmarks(shiftX = shift), index * 400L)
        }

        assertFalse(latest?.visionReady ?: true)
        assertTrue((latest?.frameStability ?: 1.0) < 0.75)
    }

    @Test
    fun update_keepsVisionNotReadyWhenKeypointsAreMissing() {
        val deriver = CprMetricsDeriver()
        var latest: CprMetricsSnapshot? = null

        for (frame in 0..2) {
            latest = deriver.update(landmarks(missingRightArm = true), frame * 400L)
        }

        assertFalse(latest?.visionReady ?: true)
        assertTrue((latest?.confidence ?: 0.0) >= 0.75)
        assertTrue((latest?.poseCoverage ?: 1.0) < 0.75)
    }

    private fun landmarks(
        wristX: Double = 0.50,
        wristY: Double = 0.56,
        confidence: Double = 0.95,
        bentArms: Boolean = false,
        shiftX: Double = 0.0,
        missingRightArm: Boolean = false,
    ): List<CprLandmark> =
        MutableList(33) { CprLandmark(0.0, 0.0, 0.0) }.apply {
            this[CprMetricsDeriver.LEFT_SHOULDER] = CprLandmark(0.40 + shiftX, 0.25, confidence)
            this[CprMetricsDeriver.RIGHT_SHOULDER] = CprLandmark(0.60 + shiftX, 0.25, confidence)
            this[CprMetricsDeriver.LEFT_HIP] = CprLandmark(0.42 + shiftX, 0.75, confidence)
            this[CprMetricsDeriver.RIGHT_HIP] = CprLandmark(0.58 + shiftX, 0.75, confidence)
            if (bentArms) {
                this[CprMetricsDeriver.LEFT_ELBOW] = CprLandmark(0.58 + shiftX, 0.44, confidence)
                this[CprMetricsDeriver.RIGHT_ELBOW] = CprLandmark(0.42 + shiftX, 0.44, confidence)
            } else {
                this[CprMetricsDeriver.LEFT_ELBOW] = CprLandmark(0.45 + shiftX, 0.40, confidence)
                this[CprMetricsDeriver.RIGHT_ELBOW] = CprLandmark(0.55 + shiftX, 0.40, confidence)
            }
            this[CprMetricsDeriver.LEFT_WRIST] = CprLandmark(wristX + shiftX, wristY, confidence)
            this[CprMetricsDeriver.RIGHT_WRIST] = CprLandmark(wristX + shiftX, wristY, confidence)
            if (missingRightArm) {
                this[CprMetricsDeriver.LEFT_ELBOW] = CprLandmark(0.45 + shiftX, 0.40, 0.0)
                this[CprMetricsDeriver.RIGHT_ELBOW] = CprLandmark(0.55 + shiftX, 0.40, 0.0)
                this[CprMetricsDeriver.RIGHT_WRIST] = CprLandmark(wristX + shiftX, wristY, 0.0)
            }
        }
}
