package com.firstaid.copilot.live.ui

import com.firstaid.copilot.live.MicState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MinimalUiPresentationTest {
    @Test
    fun qualityScoreHiddenBeforeCprWhenNoScoreExists() {
        assertNull(qualityScorePresentation(score = null, currentStage = "S1_SCENE_SAFE"))
    }

    @Test
    fun qualityScoreShowsPendingDuringCprSetupWithoutScore() {
        val presentation = qualityScorePresentation(score = null, currentStage = "S6_CPR_READY")

        assertEquals("检测中", presentation?.valueText)
        assertEquals("", presentation?.labelText)
        assertEquals(QualityScoreTone.Pending, presentation?.tone)
    }

    @Test
    fun qualityScoreMapsToShortEmergencyLabels() {
        assertEquals("调", qualityScorePresentation(score = 42, currentStage = "S7_CPR_LOOP")?.labelText)
        assertEquals(QualityScoreTone.Adjust, qualityScorePresentation(score = 42, currentStage = "S7_CPR_LOOP")?.tone)

        assertEquals("稳", qualityScorePresentation(score = 72, currentStage = "S7_CPR_LOOP")?.labelText)
        assertEquals(QualityScoreTone.Steady, qualityScorePresentation(score = 72, currentStage = "S7_CPR_LOOP")?.tone)

        assertEquals("好", qualityScorePresentation(score = 91, currentStage = "S7_CPR_LOOP")?.labelText)
        assertEquals(QualityScoreTone.Good, qualityScorePresentation(score = 91, currentStage = "S7_CPR_LOOP")?.tone)
    }

    @Test
    fun qualityScoreClampsAndLocksThresholds() {
        assertEquals("0", qualityScorePresentation(score = -1, currentStage = "S7_CPR_LOOP")?.valueText)
        assertEquals(QualityScoreTone.Adjust, qualityScorePresentation(score = 59, currentStage = "S7_CPR_LOOP")?.tone)
        assertEquals(QualityScoreTone.Steady, qualityScorePresentation(score = 60, currentStage = "S7_CPR_LOOP")?.tone)
        assertEquals(QualityScoreTone.Steady, qualityScorePresentation(score = 79, currentStage = "S7_CPR_LOOP")?.tone)
        assertEquals(QualityScoreTone.Good, qualityScorePresentation(score = 80, currentStage = "S7_CPR_LOOP")?.tone)
        assertEquals("100", qualityScorePresentation(score = 101, currentStage = "S7_CPR_LOOP")?.valueText)
    }

    @Test
    fun qualityScoreStillShowsIfAgentAlreadyProvidedScoreOutsideCpr() {
        val presentation = qualityScorePresentation(score = 88, currentStage = "S1_SCENE_SAFE")

        assertEquals("88", presentation?.valueText)
        assertEquals("好", presentation?.labelText)
        assertEquals(QualityScoreTone.Good, presentation?.tone)
    }

    @Test
    fun voiceControlUsesStartListenStopOnly() {
        assertEquals("开始", voiceControlPresentation(MicState.Idle, null).label)
        assertEquals("开始", voiceControlPresentation(MicState.Idle, "").label)
        assertEquals("听", voiceControlPresentation(MicState.Idle, "S1_SCENE_SAFE").label)
        assertEquals("停", voiceControlPresentation(MicState.Listening, "S1_SCENE_SAFE").label)
        assertEquals("停", voiceControlPresentation(MicState.Capturing, "S1_SCENE_SAFE").label)
        assertEquals("停", voiceControlPresentation(MicState.Uploading, "S1_SCENE_SAFE").label)
        assertEquals("停", voiceControlPresentation(MicState.Speaking, "S7_CPR_LOOP").label)
        assertEquals("听", voiceControlPresentation(MicState.Off, "S7_CPR_LOOP").label)
    }

    @Test
    fun primaryGuidanceHasMinimalFallbacks() {
        assertEquals("准备急救", primaryGuidanceText("", null))
        assertEquals("继续按压", primaryGuidanceText("", "S7_CPR_LOOP"))
        assertEquals("确认现场安全", primaryGuidanceText("确认现场安全", "S1_SCENE_SAFE"))
    }

    @Test
    fun secondaryTextPrefersGuidanceThenSingleTag() {
        assertEquals("安全后靠近患者", compactSecondaryText("安全后靠近患者", listOf("现场安全")))
        assertEquals("现场安全", compactSecondaryText("", listOf("现场安全", "靠近患者")))
        assertEquals("靠近患者", compactSecondaryText("", listOf("", "靠近患者")))
        assertNull(compactSecondaryText("", emptyList()))
    }

    @Test
    fun stageStatusLabelsAvoidInternalStageCodes() {
        assertEquals("待命", stageStatusLabel(null))
        assertEquals("安全", stageStatusLabel("S1_SCENE_SAFE"))
        assertEquals("呼吸", stageStatusLabel("S3_CHECK_BREATHING"))
        assertEquals("按压", stageStatusLabel("S7_CPR_LOOP"))
        assertEquals("交接", stageStatusLabel("S9_HANDOVER"))
    }
}
