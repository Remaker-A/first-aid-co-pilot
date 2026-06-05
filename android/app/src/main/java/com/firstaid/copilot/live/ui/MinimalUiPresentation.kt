package com.firstaid.copilot.live.ui

import com.firstaid.copilot.live.MicState

internal enum class QualityScoreTone {
    Good,
    Steady,
    Adjust,
    Pending,
}

internal data class QualityScorePresentation(
    val valueText: String,
    val labelText: String,
    val tone: QualityScoreTone,
)

internal fun qualityScorePresentation(
    score: Int?,
    currentStage: String?,
): QualityScorePresentation? {
    if (score == null && !currentStage.isCprQualityStage()) {
        return null
    }

    if (score == null) {
        return QualityScorePresentation(
            valueText = "检测中",
            labelText = "",
            tone = QualityScoreTone.Pending,
        )
    }

    val normalizedScore = score.coerceIn(0, 100)
    val (label, tone) = when {
        normalizedScore >= 80 -> "好" to QualityScoreTone.Good
        normalizedScore >= 60 -> "稳" to QualityScoreTone.Steady
        else -> "调" to QualityScoreTone.Adjust
    }

    return QualityScorePresentation(
        valueText = normalizedScore.toString(),
        labelText = label,
        tone = tone,
    )
}

internal data class VoiceControlPresentation(
    val label: String,
    val flowStarted: Boolean,
    val active: Boolean,
)

internal fun voiceControlPresentation(
    micState: MicState,
    currentStage: String?,
): VoiceControlPresentation {
    val flowStarted = currentStage?.isNotBlank() == true && currentStage != "S0_INIT"
    val active = micState in activeMicStates
    val label = when {
        !flowStarted -> "开始"
        active -> "停"
        else -> "听"
    }

    return VoiceControlPresentation(
        label = label,
        flowStarted = flowStarted,
        active = active,
    )
}

internal fun primaryGuidanceText(
    mainText: String,
    currentStage: String?,
): String =
    when {
        mainText.isNotBlank() -> mainText
        currentStage == null || currentStage == "S0_INIT" -> "准备急救"
        currentStage.startsWith("S7") -> "继续按压"
        else -> "听语音指引"
    }

internal fun compactSecondaryText(
    secondaryText: String,
    statusTags: List<String>,
): String? =
    secondaryText.takeIf { it.isNotBlank() } ?: statusTags.firstOrNull { it.isNotBlank() }

internal fun stageStatusLabel(currentStage: String?): String =
    when {
        currentStage == null || currentStage == "S0_INIT" -> "待命"
        currentStage.startsWith("S1") -> "安全"
        currentStage.startsWith("S2") -> "反应"
        currentStage.startsWith("S3") -> "呼吸"
        currentStage.startsWith("S4") || currentStage.startsWith("S5") -> "呼叫"
        currentStage.startsWith("S6") -> "准备"
        currentStage.startsWith("S7") -> "按压"
        currentStage.startsWith("S8") -> "协助"
        currentStage.startsWith("S9") -> "交接"
        else -> "进行"
    }

private fun String?.isCprQualityStage(): Boolean =
    this?.startsWith("S6") == true || this?.startsWith("S7") == true

private val activeMicStates = setOf(
    MicState.Listening,
    MicState.Capturing,
    MicState.Uploading,
    MicState.Speaking,
)
