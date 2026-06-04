package com.firstaid.copilot.live.vision.cpr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VisionPlacementTest {
    @Test
    fun phonePlacementsMapToRecordingAndRecognitionMounts() {
        assertEquals(VisionCameraMount.SideFixed, cameraMountForPlacement(PhonePlacement.SideFixed))
        assertEquals(VisionCameraMount.BystanderHandheld, cameraMountForPlacement(PhonePlacement.BystanderHandheld))
        assertEquals(VisionCameraMount.Handheld, cameraMountForPlacement(PhonePlacement.RescuerHandheld))
        assertEquals(VisionCameraMount.Unusable, cameraMountForPlacement(PhonePlacement.FlatOnGround))
        assertEquals(VisionCameraMount.Unknown, cameraMountForPlacement(PhonePlacement.Unknown))
    }

    @Test
    fun sideFixedAndStableBystanderViewsCanBecomeLiveRecognition() {
        assertTrue(ready(VisionCameraMount.SideFixed).ready)
        assertTrue(ready(VisionCameraMount.BystanderHandheld).ready)
    }

    @Test
    fun rescuerHandheldAndFlatGroundStayRecordingOnly() {
        assertFalse(ready(VisionCameraMount.Handheld).ready)
        assertFalse(ready(VisionCameraMount.Unusable).ready)
    }

    @Test
    fun readinessRequiresConfidenceCoverageAndStableFrames() {
        assertEquals("low_confidence", ready(VisionCameraMount.SideFixed, confidence = 0.5).reason)
        assertEquals("low_pose_coverage", ready(VisionCameraMount.SideFixed, poseCoverage = 0.5).reason)
        assertEquals("unstable_frame", ready(VisionCameraMount.SideFixed, frameStability = 0.5).reason)
        assertEquals("not_ready", ready(VisionCameraMount.SideFixed, visionReady = false).reason)
    }

    private fun ready(
        mount: VisionCameraMount,
        confidence: Double = 0.9,
        visionReady: Boolean = true,
        poseCoverage: Double = 1.0,
        frameStability: Double = 1.0,
    ): VisionReadiness =
        evaluateVisionReadiness(
            confidence = confidence,
            visionReady = visionReady,
            cameraMount = mount.eventValue,
            poseCoverage = poseCoverage,
            frameStability = frameStability,
        )
}
