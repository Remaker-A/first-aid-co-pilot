package com.firstaid.copilot.live

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalAgentTransportTest {
    @Test
    fun localTransportRunsCoreCprFlowWithoutServer() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_flow"

        val start = transport.success(firstAidSessionStartedRequest(sessionId))
        assertEquals("S1_SCENE_SAFE", start.currentStage)
        assertEquals("local_rule_agent", start.guidanceAction?.source)
        assertFalse(start.guidanceAction?.tool_actions.orEmpty().any { it.type == "emergency_call" })

        assertEquals(
            "S2_CHECK_RESPONSE",
            transport.success(TurnRequest(sessionId = sessionId, text = "现场安全")).currentStage,
        )
        assertEquals(
            "S3_CHECK_BREATHING",
            transport.success(TurnRequest(sessionId = sessionId, text = "没有反应")).currentStage,
        )

        val call = transport.success(TurnRequest(sessionId = sessionId, text = "没有正常呼吸"))
        assertEquals("S5_CALL_EMERGENCY", call.currentStage)
        assertEquals("start_emergency_call_and_cpr", call.guidanceAction?.intent)
        assertTrue(call.guidanceAction?.tool_actions.orEmpty().any { it.type == "emergency_call" })

        assertEquals(
            "S6_CPR_READY",
            transport.success(TurnRequest(sessionId = sessionId, text = "已拨打120")).currentStage,
        )

        val cpr = transport.success(TurnRequest(sessionId = sessionId, text = "开始按压"))
        assertEquals("S7_CPR_LOOP", cpr.currentStage)
        assertEquals("start_cpr_loop", cpr.guidanceAction?.intent)
        assertTrue(cpr.guidanceAction?.haptic?.enabled == true)
        assertEquals(110, cpr.guidanceAction?.haptic?.bpm)
    }

    @Test
    fun localTransportBridgesPostCallStartWordsWithoutSkippingReadyGate() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_s5_start_bridge"

        transport.success(firstAidSessionStartedRequest(sessionId))
        transport.success(TurnRequest(sessionId = sessionId, text = "现场安全"))
        transport.success(TurnRequest(sessionId = sessionId, text = "没有反应"))
        val call = transport.success(TurnRequest(sessionId = sessionId, text = "没有正常呼吸"))
        assertEquals("S5_CALL_EMERGENCY", call.currentStage)

        val bridge = transport.success(TurnRequest(sessionId = sessionId, text = "继续"))
        assertEquals("S6_CPR_READY", bridge.currentStage)
        assertEquals("guide_cpr_position", bridge.guidanceAction?.intent)
        assertTrue(bridge.guidanceAction?.haptic?.enabled != true)

        val start = transport.success(TurnRequest(sessionId = sessionId, text = "怎么按压"))
        assertEquals("S7_CPR_LOOP", start.currentStage)
        assertEquals("start_cpr_loop", start.guidanceAction?.intent)
        assertTrue(start.guidanceAction?.haptic?.enabled == true)
    }

    @Test
    fun localTransportAcceptsRetestReadinessPhrases() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_retest_readiness"

        transport.success(firstAidSessionStartedRequest(sessionId))
        transport.success(TurnRequest(sessionId = sessionId, text = "确认安全"))
        transport.success(TurnRequest(sessionId = sessionId, text = "他没有反应"))
        val call = transport.success(TurnRequest(sessionId = sessionId, text = "没有正常呼吸"))
        assertEquals("S5_CALL_EMERGENCY", call.currentStage)

        val postCallStart = transport.success(TurnRequest(sessionId = sessionId, text = "开始胸外按压"))
        assertEquals("S6_CPR_READY", postCallStart.currentStage)
        assertEquals("guide_cpr_position", postCallStart.guidanceAction?.intent)

        val ready = transport.success(TurnRequest(sessionId = sessionId, text = "准备好了"))
        assertEquals("S7_CPR_LOOP", ready.currentStage)
        assertEquals("start_cpr_loop", ready.guidanceAction?.intent)
        assertTrue(ready.guidanceAction?.haptic?.enabled == true)
    }

    @Test
    fun localTransportAcknowledgesAedArrivalAtReadyGateWithoutSkippingCprStart() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_s6_aed_arrival"

        transport.success(firstAidSessionStartedRequest(sessionId))
        transport.success(TurnRequest(sessionId = sessionId, text = "现场安全"))
        transport.success(TurnRequest(sessionId = sessionId, text = "没有反应"))
        transport.success(TurnRequest(sessionId = sessionId, text = "没有正常呼吸"))
        transport.success(TurnRequest(sessionId = sessionId, text = "已拨打120"))

        val aed = transport.success(TurnRequest(sessionId = sessionId, text = "AED 来了"))
        assertEquals("S6_CPR_READY", aed.currentStage)
        assertEquals("guide_cpr_position", aed.guidanceAction?.intent)
        assertTrue(aed.guidanceAction?.tts?.text.orEmpty().contains("AED"))
        assertTrue(aed.guidanceAction?.tts?.text.orEmpty().contains("开始"))

        val ready = transport.success(TurnRequest(sessionId = sessionId, text = "准备好了可以开始"))
        assertEquals("S7_CPR_LOOP", ready.currentStage)
        assertEquals("start_cpr_loop", ready.guidanceAction?.intent)
        assertTrue(ready.guidanceAction?.haptic?.enabled == true)
    }

    @Test
    fun localTransportAcceptsChineseAedArrivalDuringCprLoop() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_zh_aed_arrival"
        bringToCprLoop(transport, sessionId)

        val aed = transport.success(TurnRequest(sessionId = sessionId, text = "除颤仪到了"))
        assertEquals("S8_ASSISTANCE", aed.currentStage)
        assertEquals("assist_aed", aed.guidanceAction?.intent)
        assertTrue(aed.guidanceAction?.tts?.text.orEmpty().contains("AED"))
    }

    @Test
    fun localTransportAnswersCprLoopClosedQuestionsWithoutLeavingLoop() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_cpr_questions"
        bringToCprLoop(transport, sessionId)

        val position = transport.success(TurnRequest(sessionId = sessionId, text = "我按的位置对吗"))
        assertEquals("S7_CPR_LOOP", position.currentStage)
        assertEquals("question_answer", position.responseType)
        assertEquals("answer_current_cpr_question", position.guidanceAction?.intent)
        assertTrue(position.guidanceAction?.tts?.text.orEmpty().contains("胸口中央"))
        assertTrue(position.guidanceAction?.haptic?.enabled == true)

        val keepGoing = transport.success(TurnRequest(sessionId = sessionId, text = "还要继续按吗"))
        assertEquals("S7_CPR_LOOP", keepGoing.currentStage)
        assertEquals("question_answer", keepGoing.responseType)
        assertEquals("answer_current_cpr_question", keepGoing.guidanceAction?.intent)
        assertTrue(keepGoing.guidanceAction?.tts?.text.orEmpty().contains("不要停"))
        assertTrue(keepGoing.guidanceAction?.haptic?.enabled == true)
    }

    @Test
    fun localTransportAcceptsShortNaturalChineseFlowPhrases() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_natural_zh"

        transport.success(firstAidSessionStartedRequest(sessionId))
        assertEquals(
            "S2_CHECK_RESPONSE",
            transport.success(TurnRequest(sessionId = sessionId, text = "\u786e\u8ba4\u5b89\u5168")).currentStage,
        )
        assertEquals(
            "S3_CHECK_BREATHING",
            transport.success(TurnRequest(sessionId = sessionId, text = "\u6ca1\u53cd\u5e94")).currentStage,
        )

        val call = transport.success(
            TurnRequest(sessionId = sessionId, text = "\u6ca1\u6709\u6b63\u5e38\u547c\u5438"),
        )
        assertEquals("S5_CALL_EMERGENCY", call.currentStage)
        assertEquals("start_emergency_call_and_cpr", call.guidanceAction?.intent)
        assertTrue(call.guidanceAction?.tool_actions.orEmpty().any { it.type == "emergency_call" })
    }

    @Test
    fun localTransportKeepsCprCorrectionsOnDevice() = runTest {
        val transport = LocalAgentTransport()
        val sessionId = "local_correction"
        bringToCprLoop(transport, sessionId)

        val response = transport.success(
            TurnRequest(
                sessionId = sessionId,
                eventSource = "vision_cpr",
                eventType = "cpr_quality_update",
                cprQuality = mapOf(
                    "compressions_started" to true,
                    "current_rate" to 82,
                    "quality_score" to 50,
                    "hand_position" to "center",
                    "arm_posture" to "straight",
                ),
            ),
        )

        assertEquals("S7_CPR_LOOP", response.currentStage)
        assertEquals("correct_compression_rate", response.guidanceAction?.intent)
        assertEquals(50, response.guidanceAction?.ui?.quality_score)
        assertTrue(response.guidanceAction?.haptic?.enabled == true)
    }

    private suspend fun bringToCprLoop(transport: LocalAgentTransport, sessionId: String) {
        transport.success(firstAidSessionStartedRequest(sessionId))
        transport.success(TurnRequest(sessionId = sessionId, text = "现场安全"))
        transport.success(TurnRequest(sessionId = sessionId, text = "没有反应"))
        transport.success(TurnRequest(sessionId = sessionId, text = "没有正常呼吸"))
        transport.success(TurnRequest(sessionId = sessionId, text = "已拨打120"))
        transport.success(TurnRequest(sessionId = sessionId, text = "开始按压"))
    }

    private suspend fun AgentTransport.success(request: TurnRequest): TurnResponse {
        val result = turn(request)
        assertTrue(result is TurnResult.Success)
        val response = (result as TurnResult.Success).response
        assertTrue(response.ok)
        assertNotNull(response.guidanceAction)
        return response
    }
}
