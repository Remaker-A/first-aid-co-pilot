package com.firstaid.copilot.live

enum class AttentionMode {
    Coach,
    EyesOff,
    Glanceable,
}

fun AttentionModeInputs.toAttentionMode(): AttentionMode {
    val stage = currentStage.orEmpty()
    val normalizedOverlay = normalizeOverlayMode(visualOverlayMode)

    if (stage.startsWith("S8") || normalizedOverlay in glanceableOverlayModes) {
        return AttentionMode.Glanceable
    }

    if (stage.startsWith("S7") && normalizedOverlay in eyesOffOverlayModes) {
        return AttentionMode.EyesOff
    }

    return AttentionMode.Coach
}

fun normalizeOverlayMode(mode: String?): String? =
    when (mode) {
        "cpr_quality_feedback" -> "rate_feedback"
        else -> mode
    }

private val eyesOffOverlayModes = setOf(
    "cpr_loop",
    "continue_compressions",
    "rate_feedback",
    "arm_posture_feedback",
    "hand_position_feedback",
)

private val glanceableOverlayModes = setOf(
    "rescuer_assistance",
    "aed_assistance",
)
