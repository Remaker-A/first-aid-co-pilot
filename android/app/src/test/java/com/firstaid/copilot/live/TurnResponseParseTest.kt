package com.firstaid.copilot.live

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class TurnResponseParseTest {
    @Test
    fun parseTurnResponse_readsGuidanceAndMetadata() {
        val json = JSONObject()
            .put("ok", true)
            .put("session_id", "session_test")
            .put("transcript", "开始按压")
            .put("state", JSONObject().put("current_stage", "S7_CPR_LOOP"))
            .put("event", JSONObject().put("source", "vision_cpr").put("mode", "demo_assisted"))
            .put("response_type", "guidance")
            .put("guidance_source", "rule_feedback")
            .put("timings", JSONObject().put("total_ms", 12))
            .put("guidance_action", guidanceActionJson())

        val response = parseTurnResponse(json)

        assertEquals(true, response.ok)
        assertEquals("session_test", response.sessionId)
        assertEquals("S7_CPR_LOOP", response.currentStage)
        assertEquals("vision_cpr", response.eventSource)
        assertEquals("继续按压", response.ttsText)
        assertEquals(12L, response.timings["total_ms"])
        assertNotNull(response.guidanceAction)
        assertEquals("rate_feedback", response.guidanceAction?.visual_overlay?.get("mode"))
    }

    private fun guidanceActionJson(): JSONObject =
        JSONObject()
            .put("schema_version", "guidance_action.v0.1")
            .put("action_id", "act_test")
            .put("session_id", "session_test")
            .put("timestamp", "2026-06-03T00:00:00Z")
            .put("stage", "S7_CPR_LOOP")
            .put("intent", "continue_cpr_loop")
            .put("priority", "high")
            .put("source", "unit_test")
            .put("reason_codes", JSONArray())
            .put("tts", JSONObject().put("text", "继续按压").put("interrupt_policy", "interrupt_lower_priority"))
            .put(
                "ui",
                JSONObject()
                    .put("main_text", "继续按压")
                    .put("secondary_text", "跟着节拍")
                    .put("status_tags", JSONArray().put("110 bpm"))
                    .put("quality_score", 75),
            )
            .put("haptic", JSONObject().put("enabled", true).put("bpm", 110))
            .put("visual_overlay", JSONObject().put("mode", "rate_feedback"))
            .put("tool_actions", JSONArray())
}
