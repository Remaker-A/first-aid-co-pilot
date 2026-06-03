package com.firstaid.copilot.execution

const val GUIDANCE_ACTION_SCHEMA_VERSION: String = "guidance_action.v0.1"

data class GuidanceAction(
    val schema_version: String = GUIDANCE_ACTION_SCHEMA_VERSION,
    val action_id: String,
    val session_id: String? = null,
    val timestamp: String,
    val stage: String,
    val intent: String,
    val priority: String = Priority.NORMAL.value,
    val source: String = "unknown",
    val reason_codes: List<String> = emptyList(),
    val ttl_ms: Long = 5000,
    val throttle_key: String? = null,
    val min_interval_ms: Long = 0,
    val tts: TtsPayload = TtsPayload(),
    val ui: UiPayload = UiPayload(),
    val haptic: HapticPayload = HapticPayload(),
    val visual_overlay: Map<String, Any?>? = null,
    val tool_actions: List<ToolAction> = emptyList(),
    val log_event: Map<String, Any?>? = null
) {
    val isCritical: Boolean
        get() = priority == Priority.CRITICAL.value

    val isSilent: Boolean
        get() = priority == Priority.SILENT.value || intent in DELIBERATELY_SILENT_INTENTS
}

data class TtsPayload(
    val text: String = "",
    val tone: String = "calm_firm",
    val speed: String = "normal",
    val interrupt_policy: String = "do_not_interrupt_critical"
) {
    fun hasSpeech(): Boolean = text.isNotBlank()
}

data class UiPayload(
    val main_text: String = "",
    val secondary_text: String = "",
    val status_tags: List<String> = emptyList(),
    val quality_score: Int? = null,
    val primary_button: Map<String, Any?>? = null
) {
    fun hasRenderableContent(): Boolean =
        main_text.isNotBlank() ||
            secondary_text.isNotBlank() ||
            status_tags.isNotEmpty() ||
            quality_score != null ||
            primary_button != null
}

data class HapticPayload(
    val enabled: Boolean = false,
    val pattern: String? = null,
    val bpm: Int? = null
) {
    fun hasCommand(): Boolean = enabled || pattern != null || bpm != null
}

data class ToolAction(
    val type: String,
    val requires_user_confirmation: Boolean = false,
    val confirmed: Boolean = false,
    val user_confirmed: Boolean = false,
    val confirmed_by_user: Boolean = false,
    val confirmation: Map<String, Any?> = emptyMap(),
    val bpm: Int? = null,
    val payload: Map<String, Any?> = emptyMap()
) {
    fun isConfirmed(context: DispatchContext): Boolean =
        confirmed ||
            user_confirmed ||
            confirmed_by_user ||
            confirmation["confirmed"] == true ||
            type in context.confirmedToolTypes
}

data class Delivery(
    val channel: String,
    val status: DeliveryStatus,
    val summary: String? = null,
    val payload: Map<String, Any?> = emptyMap(),
    val warnings: List<String> = emptyList(),
    val error: String? = null
)

data class DispatchResult(
    val action_id: String,
    val intent: String,
    val priority: String,
    val stage: String,
    val channels: List<String>,
    val deliveries: List<Delivery>,
    val warnings: List<String>,
    val fallback: Boolean,
    val unknownIntent: Boolean = false
)

enum class DeliveryStatus {
    DELIVERED,
    BLOCKED,
    SKIPPED,
    ERROR
}

enum class Priority(val value: String) {
    SILENT("silent"),
    LOW("low"),
    NORMAL("normal"),
    HIGH("high"),
    CRITICAL("critical")
}

enum class ExecutionChannel(val value: String) {
    UI("ui"),
    TTS("tts"),
    HAPTIC("haptic"),
    TOOL("tool")
}

data class DispatchContext(
    val confirmedToolTypes: Set<String> = emptySet(),
    val knownIntents: Set<String>? = null,
    val fallbackReason: String? = null
)

val DELIBERATELY_SILENT_INTENTS: Set<String> = setOf("defer_to_critical_action", "noop")

val HAPTIC_TOOL_TYPES: Set<String> = setOf(
    "start_haptic_metronome",
    "update_haptic_metronome",
    "stop_haptic_metronome"
)

val SHARE_OR_DESTRUCTIVE_TOOL_TYPES: Set<String> = setOf(
    "share_report",
    "share_video",
    "send_report",
    "send_video",
    "delete_video"
)

val CONFIRMATION_REQUEST_TOOL_TYPES: Set<String> = setOf(
    "request_share_report",
    "request_share_video"
)

val CRITICAL_TOOL_TYPES: Set<String> = setOf(
    "emergency_call",
    "mock_emergency_call"
)
