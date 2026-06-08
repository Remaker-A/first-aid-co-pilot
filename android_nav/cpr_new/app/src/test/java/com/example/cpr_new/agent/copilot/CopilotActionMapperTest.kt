package com.example.cpr_new.agent.copilot

import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GuidancePriority
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CopilotActionMapperTest {

    @Test
    fun toLocalAction_mapsPendingConfirmTools() {
        val copilot = CopilotGuidanceAction(
            actionId = "act_share",
            timestamp = "2026-06-08T00:00:00Z",
            stage = "S9_HANDOVER",
            intent = "request_share",
            priority = CopilotPriority.HIGH,
            tts = CopilotTtsPayload(text = "是否分享视频？"),
            ui = CopilotUiPayload(mainText = "分享视频？"),
            toolActions = listOf(
                CopilotToolAction(
                    type = CopilotShareTools.REQUEST_SHARE_VIDEO,
                    requiresUserConfirmation = true,
                    confirmed = false,
                ),
            ),
        )

        val local = CopilotActionMapper.toLocalAction(copilot, sessionId = "sess-1")

        assertEquals(CprPhase.HANDOVER, local.phase)
        assertEquals(GuidancePriority.HIGH, local.priority)
        assertEquals("request_share_video", local.metadata["pending_confirm_tools"])
        assertTrue(local.metadata["primary_button_label"].isNullOrBlank())
    }

    @Test
    fun mapButtonTextToUserInput_mapsKnownActions() {
        assertEquals("他没有反应", CopilotActionMapper.mapButtonTextToUserInput("", "mark_unresponsive"))
        assertEquals("开始按压", CopilotActionMapper.mapButtonTextToUserInput("", "start_cpr"))
    }
}
