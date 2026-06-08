package com.example.cpr_new.agent.copilot

import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidancePriority
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveTtsPolicyTest {

    @Test
    fun shouldUseLocalLiveTts_forShortCriticalText() {
        val action = GuidanceAction(
            actionId = "a1",
            sessionId = "s1",
            messageText = "继续按压",
            ttsText = "继续按压",
            priority = GuidancePriority.CRITICAL,
        )
        assertTrue(action.shouldUseLocalLiveTts())
    }

    @Test
    fun shouldUseLocalLiveTts_falseForLongText() {
        val action = GuidanceAction(
            actionId = "a2",
            sessionId = "s1",
            messageText = "这是一段超过二十四个字的详细指导文案，应走服务端流式音频",
            ttsText = "这是一段超过二十四个字的详细指导文案，应走服务端流式音频",
            priority = GuidancePriority.MEDIUM,
        )
        assertFalse(action.shouldUseLocalLiveTts())
    }
}
