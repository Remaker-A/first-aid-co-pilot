package com.example.cpr_new.agent.copilot

import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.PerceptionEvent

object PerceptionEventMapper {

    fun toCprQualityTurn(
        sessionId: String,
        event: PerceptionEvent,
        deviceState: Map<String, Any?>,
    ): TurnRequest =
        TurnRequest(
            sessionId = sessionId,
            eventSource = "vision_cpr",
            eventType = "cpr_quality_update",
            cprQuality = mapOf(
                "compression_started" to true,
                "hand_position" to mapHandPosition(event.handPosition),
                "compression_rate" to (event.compressionRateBpm?.toInt() ?: 0),
                "interruption_seconds" to event.interruptionMs / 1000.0,
                "arm_straight" to event.armStraight,
                "quality_score" to event.qualityScore,
                "confidence" to event.confidence.toDouble(),
            ),
            deviceState = deviceState,
        )

    private fun mapHandPosition(position: HandPosition): String =
        when (position) {
            HandPosition.CENTER -> "center"
            HandPosition.LEFT -> "left_offset"
            HandPosition.RIGHT -> "right_offset"
            HandPosition.HIGH -> "high_offset"
            HandPosition.LOW -> "low_offset"
            HandPosition.UNKNOWN -> "unknown"
        }
}
