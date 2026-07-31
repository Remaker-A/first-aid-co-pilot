package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction

fun VoiceTurnResponse.toLiveUiState(previous: LiveUiState): LiveUiState {
    val action = guidanceAction ?: stateAction
    val stage = stringValue(state["current_stage"]).ifBlank {
        action?.stage ?: previous.currentStage
    }
    val eventDevice = mapValue(event["device_state"])
    val stateDevice = mapValue(state["device_state"])
    val device = eventDevice + stateDevice
    val metrics = deriveCprMetrics(action, state, event, previous.cprMetrics)
    val overlay = deriveOverlay(action, stage, metrics)

    return previous.copy(
        sessionId = sessionId ?: previous.sessionId,
        serverState = if (ok) ServerState.ONLINE else ServerState.ERROR,
        currentStage = stage,
        responseType = responseType,
        guidanceSource = guidanceSource,
        eventSource = stringValue(event["source"]),
        eventType = stringValue(event["event_type"]),
        transcript = transcript,
        assistantText = action?.tts?.text?.ifBlank { action.ui.main_text }
            ?: previous.assistantText,
        secondaryText = action?.ui?.secondary_text?.ifBlank { previous.secondaryText }
            ?: previous.secondaryText,
        statusTags = action?.ui?.status_tags ?: previous.statusTags,
        emergencyCallStarted = boolValue(device["emergency_call_started"])
            ?: previous.emergencyCallStarted,
        recording = boolValue(device["recording"]) ?: previous.recording,
        gpsAttached = boolValue(device["gps_attached"]) ?: previous.gpsAttached,
        offlineMode = stringValue(device["network"]).equals("offline", ignoreCase = true),
        latestAction = action,
        latestResponse = this,
        cprMetrics = metrics,
        overlay = overlay,
        timings = timings,
        errorMessage = null,
    )
}

fun deriveCprMetrics(
    action: GuidanceAction?,
    state: Map<String, Any?>,
    event: Map<String, Any?>,
    previous: CprMetrics = CprMetrics(),
): CprMetrics {
    val eventQuality = mapValue(event["cpr_quality"])
    val stateQuality = mapValue(state["cpr_state"]) + mapValue(state["cpr_quality"])
    val quality = stateQuality + eventQuality
    val currentRate = intValue(
        quality["current_rate"],
        quality["compression_rate"],
        quality["compression_rate_bpm"],
        quality["rate"],
    )
    val averageRate = intValue(quality["average_rate"], quality["average_rate_per_min"])
    val score = intValue(quality["quality_score"], quality["score"])
        ?: action?.ui?.quality_score
        ?: previous.qualityScore
    val targetBpm = action?.haptic?.bpm
        ?: action?.tool_actions?.lastOrNull { it.bpm != null }?.bpm
        ?: previous.targetBpm
    val started = boolValue(quality["compressions_started"])
        ?: boolValue(quality["started"])
        ?: previous.compressionsStarted

    return previous.copy(
        qualityScore = score,
        currentRate = currentRate ?: previous.currentRate,
        averageRate = averageRate ?: previous.averageRate,
        targetBpm = targetBpm,
        handPosition = stringValue(quality["hand_position"]).ifBlank { previous.handPosition },
        armPosture = stringValue(quality["arm_posture"]).ifBlank {
            if (boolValue(quality["arm_bent"]) == true) "bent" else previous.armPosture
        },
        interruptionSeconds = intValue(quality["interruption_seconds"], quality["last_interruption_seconds"])
            ?: previous.interruptionSeconds,
        compressionsStarted = started,
        totalCompressions = intValue(quality["total_compressions"]) ?: previous.totalCompressions,
    )
}

fun deriveOverlay(
    action: GuidanceAction?,
    stage: String,
    metrics: CprMetrics,
): CoachOverlay {
    val visual = action?.visual_overlay.orEmpty()
    val reasonCodes = action?.reason_codes.orEmpty()
    val intent = action?.intent.orEmpty()
    val visualMode = stringValue(visual["mode"])
    val mode = when {
        visualMode.isNotBlank() -> visualMode
        metrics.interruptionSeconds >= 3 || intent.contains("interruption") -> "interruption_alert"
        metrics.handPosition !in listOf("unknown", "center", "acceptable") -> "hand_position_feedback"
        metrics.armPosture in listOf("bent", "not_straight") || intent.contains("arm") -> "arm_posture_feedback"
        (metrics.currentRate ?: TARGET_CPR_BPM) !in 100..120 || reasonCodes.any { it.contains("rate") } -> "rate_feedback"
        stage == "S6_CPR_READY" -> "prepare_cpr_position"
        stage == "S7_CPR_LOOP" -> "cpr_loop"
        else -> "observe"
    }
    return CoachOverlay(
        mode = mode,
        highlightTarget = stringValue(visual["highlight_target"]).ifBlank { "chest_center" },
        correctionDirection = directionFor(metrics.handPosition, reasonCodes),
        alert = mode.contains("alert") || mode.contains("interruption"),
    )
}

fun mapValue(value: Any?): Map<String, Any?> =
    @Suppress("UNCHECKED_CAST")
    (value as? Map<String, Any?>).orEmpty()

fun stringValue(value: Any?): String = when (value) {
    null -> ""
    is String -> value
    else -> value.toString()
}

fun intValue(vararg values: Any?): Int? {
    for (value in values) {
        val number = when (value) {
            is Number -> value
            is String -> value.toDoubleOrNull()
            else -> null
        } ?: continue
        return if (stringValue(value).contains(".") || number.toDouble() in 0.0..1.0) {
            normalizeScore(number)
        } else {
            number.toInt()
        }
    }
    return null
}

fun boolValue(value: Any?): Boolean? = when (value) {
    is Boolean -> value
    is String -> value.equals("true", ignoreCase = true)
    else -> null
}

private fun directionFor(handPosition: String, reasonCodes: List<String>): String? {
    val text = (listOf(handPosition) + reasonCodes).joinToString(" ").lowercase()
    return when {
        "left" in text -> "right"
        "right" in text -> "left"
        "high" in text -> "down"
        "low" in text -> "up"
        "off_center" in text -> "center"
        else -> null
    }
}
