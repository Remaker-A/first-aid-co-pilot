package com.firstaid.copilot.live.ui

import com.firstaid.copilot.live.LiveUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HandoverReportModelTest {
    @Test
    fun handoverModelFormatsStartAndDurationFromSessionClock() {
        val startMs = 1_800_000L
        val model = LiveUiState(
            sessionStartedAtMs = startMs,
            cprStartedAtMs = startMs + 42_000L,
            currentStage = "S9_HANDOVER",
            qualityScore = 86,
            lastUserTranscript = "患者仍无正常呼吸",
            lastAssistantText = "继续按压，准备交接给急救员。",
            statusTags = listOf("持续按压中"),
        ).toHandoverModel(nowMs = startMs + 278_000L)

        assertNotEquals("未记录", model.startedAtText)
        assertEquals("4 分 38 秒", model.durationText)
        assertEquals(86, model.averageQuality)
        assertEquals(HandoverEvent("00:42", "CPR 开始"), model.events.first())
        assertTrue(model.events.any { it.timeText == "04:38" && it.text.contains("用户反馈") })
        assertTrue(model.events.any { it.timeText == "04:38" && it.text.contains("语音指导") })
        assertTrue(model.events.any { it.timeText == "04:38" && it.text.contains("持续按压中") })
    }
}
