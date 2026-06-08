package com.example.cpr_new.agent.copilot

import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidancePriority

private const val LOCAL_LIVE_TTS_MAX_CHARS = 24

private val LOCAL_LIVE_TTS_TEXTS = setOf(
    "继续按压",
    "不要停",
    "用力按压",
    "打开 AED",
    "呼叫 120",
)

/** 短句/高优先级指导在 WS 在线时优先走端侧 TTS，降低首包延迟。 */
fun GuidanceAction.shouldUseLocalLiveTts(): Boolean {
    val text = ttsText.trim()
    if (text.isBlank()) return false
    return text.length <= LOCAL_LIVE_TTS_MAX_CHARS ||
        priority == GuidancePriority.CRITICAL ||
        priority == GuidancePriority.HIGH ||
        text in LOCAL_LIVE_TTS_TEXTS
}

fun CopilotGuidanceAction.shouldUseLocalLiveTts(): Boolean {
    val text = tts.text.trim()
    if (text.isBlank()) return false
    return text.length <= LOCAL_LIVE_TTS_MAX_CHARS ||
        priority == CopilotPriority.CRITICAL ||
        priority == CopilotPriority.HIGH ||
        tts.tone == "urgent" ||
        text in LOCAL_LIVE_TTS_TEXTS
}

fun String.isExpectedAudioCancelReason(): Boolean =
    this == "client_barge_in" ||
        this == "new_turn" ||
        this == "reset" ||
        this == "client_stop" ||
        this == "closed"
