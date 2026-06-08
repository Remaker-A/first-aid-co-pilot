package com.example.cpr_new.feature.session

/** 对齐 first-aid-co-pilot 的麦克风/语音通道状态。 */
enum class MicState {
    Idle,
    Listening,
    Capturing,
    Speaking,
    Off,
}

fun MicState.statusLabel(liveWsConnected: Boolean, debugMode: Boolean = false): String = when {
    !liveWsConnected && this != MicState.Off && this != MicState.Idle ->
        if (debugMode) "语音通道未连接（请检查 adb reverse）" else "语音通道未连接"
    this == MicState.Speaking -> "Agent 播报中"
    this == MicState.Capturing -> "识别中…"
    this == MicState.Listening -> "正在聆听"
    this == MicState.Off -> "麦克风未开启"
    else -> ""
}

fun MicState.isVoiceActive(): Boolean =
    this == MicState.Listening || this == MicState.Capturing
