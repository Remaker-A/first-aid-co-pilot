package com.example.cpr_new.ui

/**
 * 急救教练注意力模式 —— 对齐 first-aid-co-pilot。
 *
 * - [Coach]：常规引导（进度轨 + 指导卡片）
 * - [EyesOff]：按压阶段少看屏，超大居中指令
 * - [Glanceable]：协助/AED 阶段扫一眼即可
 */
enum class AttentionMode {
    Coach,
    EyesOff,
    Glanceable,
}

data class AttentionModeInputs(
    val agentStage: String?,
    val visualOverlayMode: String?,
)

fun AttentionModeInputs.toAttentionMode(): AttentionMode {
    val stage = agentStage.orEmpty()
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
