package com.firstaid.copilot.execution

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GuidanceActionDispatcherTest {
    @Test
    fun dispatch_deliversUiTtsAndLoggableChannels() {
        val result = GuidanceActionDispatcher().dispatch(
            baseAction(
                tts = TtsPayload(text = "检查反应"),
                ui = UiPayload(main_text = "检查反应", secondary_text = "呼叫并轻拍双肩"),
                log_event = mapOf("event" to "guidance_shown"),
            )
        )

        assertEquals(listOf("ui", "tts"), result.channels)
        assertFalse(result.fallback)
        assertFalse(result.unknownIntent)
    }

    @Test
    fun dispatch_routesHapticToolsOnlyToHapticSink() {
        val result = GuidanceActionDispatcher().dispatch(
            baseAction(
                tts = TtsPayload(text = "开始胸外按压"),
                ui = UiPayload(main_text = "胸外按压"),
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                tool_actions = listOf(ToolAction(type = "start_haptic_metronome", bpm = 110)),
            )
        )

        assertTrue(result.channels.contains("haptic"))
        assertFalse(result.channels.contains("tool"))
        assertTrue(result.warnings.contains("haptic_tools_routed_to_haptic_sink"))
    }

    @Test
    fun dispatch_blocksUnconfirmedShareVideoTool() {
        val result = GuidanceActionDispatcher().dispatch(
            baseAction(
                ui = UiPayload(main_text = "是否分享视频？"),
                tool_actions = listOf(
                    ToolAction(
                        type = "share_video",
                        requires_user_confirmation = true,
                    )
                ),
            )
        )

        val toolDelivery = result.deliveries.single { it.channel == "tool" }
        assertEquals(DeliveryStatus.BLOCKED, toolDelivery.status)
        assertTrue(result.warnings.contains("tool_blocked:share_video"))
    }

    @Test
    fun dispatch_marksUnknownIntentAndFallsBackWhenNoChannelDelivers() {
        val result = GuidanceActionDispatcher().dispatch(
            baseAction(intent = "mystery_intent"),
            DispatchContext(knownIntents = setOf("ask_response_check"))
        )

        assertTrue(result.unknownIntent)
        assertTrue(result.fallback)
        assertEquals(listOf("ui"), result.channels)
        assertTrue(result.warnings.contains("unknown_intent:mystery_intent"))
    }

    @Test(expected = IllegalStateException::class)
    fun dispatch_throwsWhenStrictCriticalHasNoNaturalChannel() {
        GuidanceActionDispatcher(strictCritical = true).dispatch(
            baseAction(priority = Priority.CRITICAL.value)
        )
    }

    private fun baseAction(
        intent: String = "ask_response_check",
        priority: String = Priority.NORMAL.value,
        tts: TtsPayload = TtsPayload(),
        ui: UiPayload = UiPayload(),
        haptic: HapticPayload = HapticPayload(),
        tool_actions: List<ToolAction> = emptyList(),
        log_event: Map<String, Any?>? = null,
    ): GuidanceAction =
        GuidanceAction(
            action_id = "act_test",
            session_id = "session_test",
            timestamp = "2026-06-03T00:00:00Z",
            stage = "response_check",
            intent = intent,
            priority = priority,
            source = "unit_test",
            tts = tts,
            ui = ui,
            haptic = haptic,
            tool_actions = tool_actions,
            log_event = log_event,
        )
}
