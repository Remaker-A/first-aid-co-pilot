package com.example.cpr_new.ui

import androidx.compose.ui.graphics.Color
import com.example.cpr_new.feature.session.MicState

fun stageStatusLabel(agentStage: String?): String =
    when {
        agentStage.isNullOrBlank() || agentStage == "S0_INIT" -> "待命"
        agentStage.startsWith("S1") -> "安全"
        agentStage.startsWith("S2") -> "反应"
        agentStage.startsWith("S3") -> "呼吸"
        agentStage.startsWith("S4") || agentStage.startsWith("S5") -> "呼叫"
        agentStage.startsWith("S6") -> "准备"
        agentStage.startsWith("S7") -> "按压"
        agentStage.startsWith("S8") -> "协助"
        agentStage.startsWith("S9") -> "交接"
        else -> "进行"
    }

fun agentStageIndex(agentStage: String?): Int =
    agentStage?.let { Regex("""S(\d+)""").find(it)?.groupValues?.getOrNull(1)?.toIntOrNull() } ?: 0

/** 流程轨下方中文标签（对齐产品稿 9 步）。 */
val FLOW_STAGE_LABELS = listOf(
    "安全", "反应", "呼吸", "呼叫", "呼叫", "准备", "按压", "协助", "交接",
)

fun sourceBadgeLabel(perceptionReady: Boolean, hasPerception: Boolean): String =
    when {
        hasPerception && perceptionReady -> "实时识别"
        else -> "仅录制"
    }

fun connectionChip(agentConnected: Boolean, liveWsConnected: Boolean): Pair<String, Color> =
    when {
        agentConnected && liveWsConnected -> "在线" to Color(0xFF22C55E)
        agentConnected -> "HTTP" to Color(0xFF38BDF8)
        else -> "离线" to Color(0xFFEF4444)
    }

fun primaryGuidanceText(messageText: String, agentStage: String?): String =
    when {
        messageText.isNotBlank() -> messageText
        agentStage.isNullOrBlank() || agentStage == "S0_INIT" -> "准备急救"
        agentStage.startsWith("S7") -> "继续按压"
        else -> "听语音指引"
    }

fun compactSecondaryText(secondaryText: String, statusTags: List<String>): String? =
    secondaryText.takeIf { it.isNotBlank() } ?: statusTags.firstOrNull { it.isNotBlank() }

enum class QualityScoreTone {
    Good,
    Steady,
    Adjust,
    Pending,
}

data class QualityScorePresentation(
    val valueText: String,
    val labelText: String,
    val tone: QualityScoreTone,
)

fun qualityScorePresentation(score: Int, agentStage: String?): QualityScorePresentation? {
    val isQualityStage = agentStage?.startsWith("S6") == true ||
        agentStage?.startsWith("S7") == true ||
        agentStage?.startsWith("S8") == true
    if (score <= 0 && !isQualityStage) return null

    if (score <= 0) {
        return QualityScorePresentation(
            valueText = "检测中",
            labelText = "",
            tone = QualityScoreTone.Pending,
        )
    }

    val normalized = score.coerceIn(0, 100)
    val (label, tone) = when {
        normalized >= 80 -> "好" to QualityScoreTone.Good
        normalized >= 60 -> "稳" to QualityScoreTone.Steady
        else -> "调" to QualityScoreTone.Adjust
    }
    return QualityScorePresentation(
        valueText = normalized.toString(),
        labelText = label,
        tone = tone,
    )
}

fun QualityScoreTone.toColor(): Color = when (this) {
    QualityScoreTone.Good -> Color(0xFF22C55E)
    QualityScoreTone.Steady -> Color(0xFFF59E0B)
    QualityScoreTone.Adjust -> Color(0xFFEF4444)
    QualityScoreTone.Pending -> Color(0xFF38BDF8)
}

data class VoiceControlPresentation(
    val label: String,
    val flowStarted: Boolean,
    val active: Boolean,
)

fun voiceControlPresentation(micState: MicState, sessionActive: Boolean): VoiceControlPresentation {
    val flowStarted = sessionActive
    val active = micState in activeMicStates
    val label = when {
        !flowStarted -> "开始急救"
        active -> "停止语音"
        else -> "开启语音"
    }
    return VoiceControlPresentation(label = label, flowStarted = flowStarted, active = active)
}

fun micIndicatorColor(micState: MicState): Color = when (micState) {
    MicState.Speaking -> Color(0xFFA78BFA)
    MicState.Capturing -> Color(0xFF22C55E)
    MicState.Listening -> Color(0xFF38BDF8)
    MicState.Off -> Color(0xFF64748B)
    MicState.Idle -> Color(0xFF334155)
}

private val activeMicStates = setOf(
    MicState.Listening,
    MicState.Capturing,
)
