package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveSessionMapperTest {
    @Test
    fun handPositionCorrectionMapsToLiveOverlay() {
        val response = GuidanceActionJson.parseTurnResponse(
            """
            {
              "ok": true,
              "session_id": "sess_test",
              "transcript": "我按得对吗",
              "state": { "current_stage": "S7_CPR_LOOP" },
              "event": {
                "source": "vision_cpr",
                "event_type": "cpr_quality_update",
                "cpr_quality": {
                  "compressions_started": true,
                  "current_rate": 110,
                  "average_rate": 105,
                  "quality_score": 42,
                  "hand_position": "left",
                  "arm_posture": "straight",
                  "interruption_seconds": 0,
                  "total_compressions": 40
                }
              },
              "response_type": "critical_correction",
              "guidance_source": "rule_feedback_critical",
              "guidance_action": {
                "schema_version": "guidance_action.v0.1",
                "action_id": "act_hand_left",
                "session_id": "sess_test",
                "timestamp": "2026-06-03T00:00:00Z",
                "stage": "S7_CPR_LOOP",
                "intent": "correct_hand_position",
                "priority": "high",
                "source": "rule_feedback",
                "reason_codes": ["hand_position_left_offset"],
                "tts": { "text": "位置向右一点。" },
                "ui": {
                  "main_text": "手向右一点",
                  "secondary_text": "回到胸口中央",
                  "status_tags": ["手位"],
                  "quality_score": 42
                },
                "haptic": { "enabled": true, "pattern": "metronome", "bpm": 110 },
                "visual_overlay": {
                  "mode": "hand_position_feedback",
                  "highlight_target": "chest_center"
                },
                "tool_actions": []
              },
              "timings": { "total_ms": 34 }
            }
            """.trimIndent()
        )

        val state = response.toLiveUiState(LiveUiState())

        assertEquals("S7_CPR_LOOP", state.currentStage)
        assertEquals("hand_position_feedback", state.overlay.mode)
        assertEquals("right", state.overlay.correctionDirection)
        assertEquals(42, state.cprMetrics.qualityScore)
        assertEquals(110, state.cprMetrics.currentRate)
        assertEquals("位置向右一点。", state.assistantText)
    }

    @Test
    fun rateAndInterruptionFallbacksUseEventMetricsWhenOverlayIsMissing() {
        val rateResponse = GuidanceActionJson.parseTurnResponse(
            baseCprJson(
                actionId = "act_rate_low",
                intent = "correct_compression_rate",
                reason = "compression_rate_low",
                cprQuality = """
                  "compressions_started": true,
                  "current_rate": 82,
                  "average_rate": 95,
                  "quality_score": 50,
                  "hand_position": "center",
                  "arm_posture": "straight",
                  "interruption_seconds": 0
                """.trimIndent()
            )
        ).toLiveUiState(LiveUiState())

        assertEquals("rate_feedback", rateResponse.overlay.mode)
        assertEquals(82, rateResponse.cprMetrics.currentRate)
        assertEquals(50, rateResponse.cprMetrics.qualityScore)

        val interrupted = GuidanceActionJson.parseTurnResponse(
            baseCprJson(
                actionId = "act_interrupted",
                intent = "correct_compression_interruption",
                reason = "compression_interruption",
                cprQuality = """
                  "compressions_started": false,
                  "current_rate": 0,
                  "average_rate": 100,
                  "quality_score": 55,
                  "hand_position": "center",
                  "arm_posture": "straight",
                  "interruption_seconds": 4
                """.trimIndent()
            )
        ).toLiveUiState(LiveUiState())

        assertEquals("interruption_alert", interrupted.overlay.mode)
        assertTrue(interrupted.overlay.alert)
        assertEquals(4, interrupted.cprMetrics.interruptionSeconds)
    }

    private fun baseCprJson(
        actionId: String,
        intent: String,
        reason: String,
        cprQuality: String,
    ): String =
        """
        {
          "ok": true,
          "session_id": "sess_test",
          "state": { "current_stage": "S7_CPR_LOOP" },
          "event": {
            "source": "vision_cpr",
            "event_type": "cpr_quality_update",
            "cpr_quality": { $cprQuality }
          },
          "guidance_action": {
            "schema_version": "guidance_action.v0.1",
            "action_id": "$actionId",
            "session_id": "sess_test",
            "timestamp": "2026-06-03T00:00:00Z",
            "stage": "S7_CPR_LOOP",
            "intent": "$intent",
            "priority": "high",
            "source": "rule_feedback",
            "reason_codes": ["$reason"],
            "tts": { "text": "继续。" },
            "ui": { "main_text": "继续", "status_tags": [], "quality_score": null },
            "haptic": { "enabled": true, "pattern": "metronome", "bpm": 110 },
            "tool_actions": []
          },
          "timings": { "total_ms": 18 }
        }
        """.trimIndent()
}
