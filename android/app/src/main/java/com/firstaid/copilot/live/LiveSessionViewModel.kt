package com.firstaid.copilot.live

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HAPTIC_TOOL_TYPES
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Owns the Live CPR Coach session and exposes a single [StateFlow] of
 * [LiveUiState] for the screen.
 *
 * The turn loop is: build a [TurnRequest] -> [AgentTransport.turn] on a coroutine
 * -> reduce the [TurnResult] into [LiveUiState] via the pure [reduceTurnResult]
 * function. Offline/error handling is structural (failures set
 * [ConnectionState.Offline]/[ConnectionState.Error] without crashing); the
 * retry/local-fallback policy itself is a later phase.
 *
 * [transport] is injectable so tests can supply a fake; the default
 * [HttpAgentTransport] talks to the Node voice server.
 */
class LiveSessionViewModel(
    private val transport: AgentTransport = HttpAgentTransport(),
    private val sessionId: String = defaultSessionId(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting),
    )
    val uiState: StateFlow<LiveUiState> = _uiState.asStateFlow()

    /** Probe the agent server and reflect reachability in [LiveUiState.connectionState]. */
    fun connect() {
        viewModelScope.launch {
            _uiState.update { it.copy(connectionState = ConnectionState.Connecting) }
            val online = transport.health()
            _uiState.update {
                it.copy(connectionState = if (online) ConnectionState.Online else ConnectionState.Offline)
            }
        }
    }

    /** Start the design demo mainline: record first, then enter scene safety confirmation. */
    fun startFirstAid() {
        runTurn(
            firstAidSessionStartedRequest(sessionId),
            presetId = null,
            sourceBadge = SourceBadge.RecordingOnly,
            clearDemoPreset = true,
        )
    }

    /** Submit a text and/or audio turn (voice/manual input path). */
    fun submitTurn(
        text: String? = null,
        audioBase64: String? = null,
        mimeType: String? = null,
        presetId: String? = null,
    ) {
        runTurn(
            TurnRequest(
                sessionId = sessionId,
                text = text,
                audioBase64 = audioBase64,
                mimeType = mimeType,
            ),
            presetId = presetId,
            sourceBadge = if (presetId != null) SourceBadge.DemoData else SourceBadge.RecordingOnly,
        )
    }

    /**
     * Inject a perception/device event (the demo-drawer path). The payload is sent
     * as `/api/turn` body fields, i.e. through the public `PerceptionEvent`
     * contract, never pushed straight into the UI.
     */
    fun injectEvent(
        eventSource: String? = null,
        eventType: String? = null,
        patientState: Map<String, Any?>? = null,
        cprQuality: Map<String, Any?>? = null,
        rescuerState: Map<String, Any?>? = null,
        deviceState: Map<String, Any?>? = null,
        metadata: Map<String, Any?>? = null,
        toolResult: Map<String, Any?>? = null,
        text: String? = null,
        presetId: String? = null,
    ) {
        runTurn(
            TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = eventSource,
                eventType = eventType,
                patientState = patientState,
                cprQuality = cprQuality,
                rescuerState = rescuerState,
                deviceState = deviceState,
                metadata = metadata,
                toolResult = toolResult,
            ),
            presetId = presetId,
            sourceBadge = sourceBadgeForTurn(presetId, eventSource),
        )
    }

    fun injectDemoPreset(preset: DemoPreset, text: String? = null) {
        injectEvent(
            eventSource = preset.eventSource,
            eventType = preset.eventType,
            patientState = preset.patientState,
            cprQuality = preset.cprQuality,
            rescuerState = preset.rescuerState,
            deviceState = preset.deviceState,
            metadata = preset.metadata,
            toolResult = preset.toolResult,
            text = text,
            presetId = preset.id,
        )
    }

    fun runDemoTurns(turns: List<DemoTurn>) {
        viewModelScope.launch {
            turns.forEach { turn ->
                val preset = turn.preset
                val request = TurnRequest(
                    sessionId = sessionId,
                    text = turn.text,
                    eventSource = preset.eventSource,
                    eventType = preset.eventType,
                    patientState = preset.patientState,
                    cprQuality = preset.cprQuality,
                    rescuerState = preset.rescuerState,
                    deviceState = preset.deviceState,
                    metadata = preset.metadata,
                    toolResult = preset.toolResult,
                )
                runTurnInline(request, preset.id, SourceBadge.DemoData)
            }
        }
    }

    fun setMicState(micState: MicState) {
        _uiState.update { it.copy(micState = micState) }
    }

    /** Reset the server session and clear local UI state back to a fresh session. */
    fun reset() {
        viewModelScope.launch {
            transport.reset(sessionId)
            _uiState.value = LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting)
        }
    }

    private fun runTurn(
        request: TurnRequest,
        presetId: String?,
        sourceBadge: SourceBadge,
        clearDemoPreset: Boolean = false,
    ) {
        _uiState.update { current ->
            current.copy(
                isInFlight = true,
                currentDemoPresetId = if (clearDemoPreset) null else presetId ?: current.currentDemoPresetId,
                sourceBadge = sourceBadge,
                micState = if (request.audioBase64 != null) MicState.Uploading else current.micState,
            )
        }
        viewModelScope.launch {
            val result = transport.turn(request)
            _uiState.update { current -> reduceTurnResult(current, result) }
        }
    }

    private suspend fun runTurnInline(
        request: TurnRequest,
        presetId: String?,
        sourceBadge: SourceBadge,
    ) {
        _uiState.update { current ->
            current.copy(
                isInFlight = true,
                currentDemoPresetId = presetId ?: current.currentDemoPresetId,
                sourceBadge = sourceBadge,
            )
        }
        val result = transport.turn(request)
        _uiState.update { current -> reduceTurnResult(current, result) }
    }

    companion object {
        private fun defaultSessionId(): String =
            "android_live_" + UUID.randomUUID().toString().substring(0, 8)

        private fun sourceBadgeForTurn(presetId: String?, eventSource: String?): SourceBadge =
            when {
                presetId != null -> SourceBadge.DemoData
                eventSource == "real_perception" -> SourceBadge.LiveRecognition
                else -> SourceBadge.RecordingOnly
            }
    }
}

internal fun firstAidSessionStartedRequest(sessionId: String): TurnRequest =
    TurnRequest(
        sessionId = sessionId,
        eventSource = "demo_script",
        eventType = "session_started",
        deviceState = mapOf(
            "camera_available" to true,
            "mic_available" to true,
            "gps_available" to true,
            "recording" to true,
            "emergency_call_started" to false,
            "network" to "offline",
        ),
        metadata = mapOf(
            "adult_likely" to true,
            "recording" to true,
            "scene_note" to "one_key_first_aid",
        ),
    )

/**
 * Pure reducer: fold a [TurnResult] into the next [LiveUiState]. Kept top-level
 * and side-effect free so it can be unit-tested without a ViewModel/coroutine
 * harness.
 */
internal fun reduceTurnResult(current: LiveUiState, result: TurnResult): LiveUiState =
    when (result) {
        is TurnResult.Success -> reduceSuccess(current, result.response)
        is TurnResult.Failure -> reduceFailure(current, result.error)
    }

private fun reduceSuccess(current: LiveUiState, response: TurnResponse): LiveUiState {
    if (!response.ok) {
        // Server was reachable but reported an application error: surface it as an
        // error (not offline), and keep the last good guidance on screen.
        return current.copy(
            connectionState = ConnectionState.Error,
            currentStage = response.currentStage ?: current.currentStage,
            lastErrorMessage = response.error ?: "Agent server returned ok=false",
            isInFlight = false,
        )
    }

    val base = current.copy(
        connectionState = ConnectionState.Online,
        currentStage = response.currentStage ?: current.currentStage,
        responseType = response.responseType ?: current.responseType,
        guidanceSource = response.guidanceSource ?: current.guidanceSource,
        eventSource = response.eventSource ?: current.eventSource,
        eventMode = response.eventMode ?: current.eventMode,
        sourceBadge = when {
            current.currentDemoPresetId != null -> SourceBadge.DemoData
            response.eventSource == "real_perception" -> SourceBadge.LiveRecognition
            else -> current.sourceBadge
        },
        ttsText = response.ttsText,
        lastUserTranscript = response.transcript.ifBlank { null } ?: current.lastUserTranscript,
        lastAssistantText = response.ttsText.ifBlank { null } ?: current.lastAssistantText,
        lastErrorMessage = null,
        isInFlight = false,
        micState = if (current.micState == MicState.Uploading) MicState.Idle else current.micState,
    )

    val action = response.guidanceAction ?: return base
    return base.applyGuidance(action)
}

private fun reduceFailure(current: LiveUiState, error: TransportError): LiveUiState {
    val connection = when (error.kind) {
        TransportErrorKind.NETWORK, TransportErrorKind.TIMEOUT -> ConnectionState.Offline
        else -> ConnectionState.Error
    }
    val shouldFallback = connection == ConnectionState.Offline && current.currentStage.isOfflineCprFallbackStage()
    if (shouldFallback) {
        return current.copy(
            connectionState = ConnectionState.Offline,
            mainText = "继续按压",
            secondaryText = "网络暂时不可用，我会保留节拍提示；恢复后继续同步。",
            visualOverlayMode = "continue_compressions",
            haptic = HapticState(enabled = true, bpm = 110),
            lastErrorMessage = "离线保底：${error.message}",
            isInFlight = false,
            micState = if (current.micState == MicState.Uploading) MicState.Idle else current.micState,
        )
    }
    return current.copy(
        connectionState = connection,
        lastErrorMessage = error.message,
        isInFlight = false,
        micState = if (current.micState == MicState.Uploading) MicState.Idle else current.micState,
    )
}

private fun LiveUiState.applyGuidance(action: GuidanceAction): LiveUiState {
    val overlay = action.visual_overlay
    return copy(
        // Keep the last non-blank headline so the EyesOff big text never blanks out.
        mainText = action.ui.main_text.ifBlank { mainText },
        secondaryText = action.ui.secondary_text,
        statusTags = action.ui.status_tags,
        // quality_score persists across turns that omit it during the CPR loop.
        qualityScore = action.ui.quality_score ?: qualityScore,
        visualOverlayMode = normalizeOverlayMode(overlay?.get("mode") as? String),
        correctionArrow = overlay?.get("correction_arrow") as? String,
        ttsPriority = action.priority,
        ttsInterruptPolicy = action.tts.interrupt_policy,
        lastActionId = action.action_id,
        haptic = HapticState(
            enabled = action.haptic.enabled,
            bpm = action.haptic.bpm
                ?: action.tool_actions.firstOrNull { it.type in HAPTIC_TOOL_TYPES }?.bpm,
        ),
    )
}

private fun String?.isOfflineCprFallbackStage(): Boolean =
    this?.startsWith("S7") == true || this?.startsWith("S8") == true
