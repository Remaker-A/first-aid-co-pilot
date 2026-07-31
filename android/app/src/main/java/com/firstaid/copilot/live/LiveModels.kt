package com.firstaid.copilot.live

import com.firstaid.copilot.execution.DispatchResult
import com.firstaid.copilot.execution.GuidanceAction
import java.util.UUID

const val DEFAULT_VOICE_ENDPOINT = "http://10.0.2.2:8787"
const val ADB_REVERSE_VOICE_ENDPOINT = "http://127.0.0.1:8787"
const val TARGET_CPR_BPM = 110

data class LiveUiState(
    val sessionId: String = "android_live_" + UUID.randomUUID().toString().replace("-", ""),
    val endpoint: String = DEFAULT_VOICE_ENDPOINT,
    val serverState: ServerState = ServerState.CHECKING,
    val deviceNetwork: String = "server",
    val currentStage: String = "S0_SCENE_SAFETY",
    val responseType: String = "",
    val guidanceSource: String = "",
    val eventSource: String = "",
    val eventType: String = "",
    val transcript: String = "",
    val assistantText: String = "等待现场安全确认",
    val secondaryText: String = "Camera mock ready",
    val statusTags: List<String> = emptyList(),
    val emergencyCallStarted: Boolean = false,
    val recording: Boolean = true,
    val gpsAttached: Boolean = false,
    val offlineMode: Boolean = false,
    val mockCameraEnabled: Boolean = true,
    val micRecording: Boolean = false,
    val busy: Boolean = false,
    val demoDrawerOpen: Boolean = false,
    val selectedPreset: MockVisionPreset = MockVisionPreset.none,
    val latestAction: GuidanceAction? = null,
    val latestResponse: VoiceTurnResponse? = null,
    val dispatchResult: DispatchResult? = null,
    val cprMetrics: CprMetrics = CprMetrics(),
    val overlay: CoachOverlay = CoachOverlay(mode = "observe"),
    val timings: TurnTimings = TurnTimings(),
    val errorMessage: String? = null,
) {
    val stageIndex: Int
        get() = CPR_FLOW_STAGES.indexOfFirst { it.stage == currentStage }.coerceAtLeast(0)
}

data class FlowStage(
    val stage: String,
    val label: String,
)

val CPR_FLOW_STAGES: List<FlowStage> = listOf(
    FlowStage("S1_SCENE_SAFETY", "安全"),
    FlowStage("S2_CHECK_RESPONSE", "反应"),
    FlowStage("S3_CHECK_BREATHING", "呼吸"),
    FlowStage("S5_CALL_EMERGENCY", "呼叫120"),
    FlowStage("S6_CPR_READY", "准备CPR"),
    FlowStage("S7_CPR_LOOP", "持续按压"),
    FlowStage("S8_ASSISTANCE", "AED/换手"),
    FlowStage("S9_HANDOVER", "交接"),
)

enum class ServerState {
    CHECKING,
    ONLINE,
    OFFLINE,
    ERROR,
}

data class CprMetrics(
    val qualityScore: Int? = null,
    val currentRate: Int? = null,
    val averageRate: Int? = null,
    val targetBpm: Int = TARGET_CPR_BPM,
    val handPosition: String = "unknown",
    val armPosture: String = "unknown",
    val interruptionSeconds: Int = 0,
    val compressionsStarted: Boolean = false,
    val totalCompressions: Int? = null,
)

data class CoachOverlay(
    val mode: String,
    val highlightTarget: String? = null,
    val correctionDirection: String? = null,
    val alert: Boolean = false,
)

data class TurnTimings(
    val totalMs: Int? = null,
    val sttMs: Int? = null,
    val ttsMs: Int? = null,
    val gemmaMs: Int? = null,
)

data class VoiceTurnResponse(
    val ok: Boolean,
    val sessionId: String?,
    val transcript: String,
    val state: Map<String, Any?>,
    val event: Map<String, Any?>,
    val guidanceAction: GuidanceAction?,
    val stateAction: GuidanceAction?,
    val responseType: String,
    val guidanceSource: String,
    val timings: TurnTimings,
    val raw: String,
)

data class AudioTurn(
    val base64: String,
    val mimeType: String,
)

data class MockVisionPreset(
    val id: String,
    val label: String,
    val summary: String,
    val payload: Map<String, Any?> = emptyMap(),
    val setupText: String = "",
    val requiresCprLoop: Boolean = false,
    val setupStep: Boolean = false,
) {
    companion object {
        val none = MockVisionPreset(
            id = "none",
            label = "No mock",
            summary = "Text/audio only",
        )
    }
}
