package com.example.cpr_new.agent.copilot

const val GUIDANCE_ACTION_SCHEMA_VERSION = "guidance_action.v0.1"

data class CopilotGuidanceAction(
    val schemaVersion: String = GUIDANCE_ACTION_SCHEMA_VERSION,
    val actionId: String,
    val sessionId: String? = null,
    val timestamp: String,
    val stage: String,
    val intent: String,
    val priority: String = CopilotPriority.NORMAL,
    val source: String = "unknown",
    val reasonCodes: List<String> = emptyList(),
    val ttlMs: Long = 5000,
    val throttleKey: String? = null,
    val minIntervalMs: Long = 0,
    val tts: CopilotTtsPayload = CopilotTtsPayload(),
    val ui: CopilotUiPayload = CopilotUiPayload(),
    val haptic: CopilotHapticPayload = CopilotHapticPayload(),
    val visualOverlay: Map<String, Any?>? = null,
    val toolActions: List<CopilotToolAction> = emptyList(),
    val logEvent: Map<String, Any?>? = null,
    val callBrief: Map<String, Any?>? = null,
) {
    val isCritical: Boolean get() = priority == CopilotPriority.CRITICAL
}

data class CopilotTtsPayload(
    val text: String = "",
    val tone: String = "calm_firm",
    val speed: String = "normal",
    val interruptPolicy: String = "do_not_interrupt_critical",
)

data class CopilotUiPayload(
    val mainText: String = "",
    val secondaryText: String = "",
    val statusTags: List<String> = emptyList(),
    val qualityScore: Int? = null,
    val primaryButton: Map<String, Any?>? = null,
) {
    val displayText: String
        get() = mainText.ifBlank { secondaryText }
}

data class CopilotHapticPayload(
    val enabled: Boolean = false,
    val pattern: String? = null,
    val bpm: Int? = null,
)

data class CopilotToolAction(
    val type: String,
    val requiresUserConfirmation: Boolean = false,
    val confirmed: Boolean = false,
    val bpm: Int? = null,
    val payload: Map<String, Any?> = emptyMap(),
)

object CopilotPriority {
    const val SILENT = "silent"
    const val LOW = "low"
    const val NORMAL = "normal"
    const val HIGH = "high"
    const val CRITICAL = "critical"
}

object CopilotHapticTools {
    const val START = "start_haptic_metronome"
    const val UPDATE = "update_haptic_metronome"
    const val STOP = "stop_haptic_metronome"
}

object CopilotEmergencyTools {
    const val MOCK_CALL = "mock_emergency_call"
    const val REAL_CALL = "emergency_call"
}

object CopilotSystemTools {
    const val ATTACH_GPS = "attach_gps_location"
    const val START_RECORDING = "start_local_recording"
    const val GENERATE_HANDOVER = "generate_handover_report"
}

object CopilotShareTools {
    const val SHARE_VIDEO = "share_video"
    const val SHARE_REPORT = "share_report"
    const val SEND_VIDEO = "send_video"
    const val SEND_REPORT = "send_report"
    const val DELETE_VIDEO = "delete_video"
    const val REQUEST_SHARE_VIDEO = "request_share_video"
    const val REQUEST_SHARE_REPORT = "request_share_report"
}

val COPILOT_DESTRUCTIVE_TOOLS = setOf(
    CopilotShareTools.SHARE_VIDEO,
    CopilotShareTools.SHARE_REPORT,
    CopilotShareTools.SEND_VIDEO,
    CopilotShareTools.SEND_REPORT,
    CopilotShareTools.DELETE_VIDEO,
)
