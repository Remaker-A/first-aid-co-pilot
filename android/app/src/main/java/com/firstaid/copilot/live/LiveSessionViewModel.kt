package com.firstaid.copilot.live

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HAPTIC_TOOL_TYPES
import com.firstaid.copilot.live.perception.EmaQualityScore
import com.firstaid.copilot.live.perception.HandPositionHysteresis
import com.firstaid.copilot.live.perception.PerceptionSignal
import com.firstaid.copilot.live.perception.smoothInterruptionSeconds
import com.firstaid.copilot.live.vision.cpr.evaluateVisionReadiness
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
    private val liveChannel: LiveAgentChannel = WebSocketAgentChannel(),
    private val sessionId: String = defaultSessionId(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting),
    )
    val uiState: StateFlow<LiveUiState> = _uiState.asStateFlow()
    private val visionHandPosition = HandPositionHysteresis()
    private val visionQualityScore = EmaQualityScore()
    private var lastVisionMetricsEmitMs = 0L
    private var lastVisionInterruptionSeconds: Double? = null

    init {
        viewModelScope.launch {
            liveChannel.events.collect { event ->
                _uiState.update { current -> reduceLiveEvent(current, event) }
            }
        }
    }

    /** Probe the agent server and reflect reachability in [LiveUiState.connectionState]. */
    fun connect() {
        viewModelScope.launch {
            _uiState.update { it.copy(connectionState = ConnectionState.Connecting) }
            liveChannel.connect(sessionId)
            val online = transport.health()
            _uiState.update {
                it.copy(connectionState = if (online) ConnectionState.Online else ConnectionState.Offline)
            }
        }
    }

    /**
     * Start the live mainline from an explicit [EntrySource]. The always-available
     * "一键急救" button uses [EntrySource.OneKeyButton]; the wake-word path uses
     * [EntrySource.WakePhrase]. Both emit the *same* seed `session_started` event —
     * the entry source only enriches metadata priors, never the medical flow.
     */
    fun startFirstAid(source: EntrySource = EntrySource.OneKeyButton) {
        runTurn(
            firstAidSessionStartedRequest(sessionId, source),
            presetId = null,
            sourceBadge = SourceBadge.RecordingOnly,
            clearDemoPreset = true,
        )
    }

    /**
     * Wake-word entry seam (Demo). A local keyword match stands in for a real
     * offline wake engine, which would instead feed its recognized text here.
     * Returns true if [transcript] matched a wake phrase and a session was started;
     * on no match the caller falls back to the [startFirstAid] button.
     */
    fun triggerWakePhrase(transcript: String): Boolean {
        val phrase = matchWakePhrase(transcript) ?: return false
        startFirstAid(EntrySource.WakePhrase(phrase))
        return true
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
            sourceBadge = sourceBadgeForTurn(presetId, eventSource, metadata),
        )
    }

    /**
     * Submit real on-device CPR vision metrics through the same public
     * PerceptionEvent contract as demo injection. Low-confidence snapshots are
     * dropped here so the UI never claims live recognition from guessed data.
     */
    fun submitVisionMetrics(
        cprQuality: Map<String, Any?>,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        if (!isCprLiveRecognitionStage(_uiState.value.currentStage)) {
            downgradeVisionMetrics("stage_not_cpr_loop", cprQuality, nowMs)
            return
        }

        val confidence = cprQuality.numberOrNull("confidence")
        val readiness = evaluateVisionReadiness(
            confidence = confidence,
            visionReady = cprQuality.booleanOrNull("vision_ready"),
            cameraMount = cprQuality["camera_mount"] as? String,
            poseCoverage = cprQuality.numberOrNull("pose_coverage"),
            frameStability = cprQuality.numberOrNull("frame_stability"),
        )
        if (!readiness.ready) {
            downgradeVisionMetrics(readiness.reason, cprQuality, nowMs)
            return
        }
        val safeConfidence = confidence ?: return
        if (nowMs - lastVisionMetricsEmitMs < VISION_EMIT_INTERVAL_MS) return

        val rawInterruptionSeconds = cprQuality.numberOrNull("interruption_seconds")
        val interruptionSeconds = rawInterruptionSeconds?.let {
            smoothInterruptionSeconds(it, lastVisionInterruptionSeconds)
        }
        if (interruptionSeconds != null) {
            lastVisionInterruptionSeconds = interruptionSeconds
        }

        val smoothedQuality = linkedMapOf(
            "compressions_started" to (cprQuality["compressions_started"] as? Boolean),
            "compression_rate" to cprQuality.numberOrNull("compression_rate"),
            "interruption_seconds" to interruptionSeconds,
            "hand_position" to visionHandPosition.update(cprQuality["hand_position"] as? String),
            "arm_straight" to (cprQuality["arm_straight"] as? Boolean),
            "quality_score" to visionQualityScore.update(cprQuality.numberOrNull("quality_score")),
            "total_compressions" to cprQuality.numberOrNull("total_compressions")?.toInt(),
            "confidence" to safeConfidence,
        )

        lastVisionMetricsEmitMs = nowMs
        _uiState.update {
            it.copy(
                sourceBadge = SourceBadge.LiveRecognition,
                perceptionSignals = smoothedQuality.toPerceptionSignals(nowMs, safeConfidence),
                lastErrorMessage = null,
            )
        }
        injectEvent(
            eventSource = "vision_cpr",
            eventType = "cpr_quality_update",
            cprQuality = smoothedQuality,
            metadata = cprQuality.toVisionMetadata(readiness.reason),
        )
    }

    private fun downgradeVisionMetrics(
        reason: String?,
        cprQuality: Map<String, Any?>,
        nowMs: Long,
    ) {
        _uiState.update {
            it.copy(
                sourceBadge = SourceBadge.RecordingOnly,
                lastErrorMessage = visionReadinessMessage(reason),
                perceptionSignals = cprQuality.toVisionMetadata(reason).toPerceptionSignals(
                    timestampMs = nowMs,
                    confidence = cprQuality.numberOrNull("confidence") ?: 0.0,
                ),
            )
        }
    }

    fun reportVisionUnavailable(message: String) {
        val nowMs = System.currentTimeMillis()
        _uiState.update {
            it.copy(
                sourceBadge = SourceBadge.RecordingOnly,
                lastErrorMessage = message,
                perceptionSignals = listOf(
                    PerceptionSignal(
                        key = "vision_cpr",
                        value = null,
                        confidence = null,
                        source = "sensor_unavailable",
                        timestampMs = nowMs,
                        ttlMs = VISION_SIGNAL_TTL_MS,
                    ),
                ),
            )
        }
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

    fun startLiveAudio() {
        liveChannel.updateContext(TurnRequest(sessionId = sessionId))
        _uiState.update {
            it.copy(
                micState = MicState.Listening,
                sourceBadge = SourceBadge.RecordingOnly,
                partialTranscript = null,
                lastErrorMessage = null,
            )
        }
    }

    fun sendLivePcm(pcm16: ByteArray) {
        liveChannel.sendPcm(pcm16)
    }

    fun sendLiveBargeIn() {
        liveChannel.sendBargeIn()
        _uiState.update {
            it.copy(
                micState = MicState.Capturing,
                partialTranscript = null,
            )
        }
    }

    fun stopLiveAudio() {
        _uiState.update { it.copy(micState = MicState.Off, partialTranscript = null) }
    }

    /** Reset the server session and clear local UI state back to a fresh session. */
    fun reset() {
        viewModelScope.launch {
            liveChannel.reset()
            transport.reset(sessionId)
            _uiState.value = LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting)
        }
    }

    override fun onCleared() {
        liveChannel.close()
        super.onCleared()
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
        private const val VISION_EMIT_INTERVAL_MS = 1_000L
        private const val VISION_SIGNAL_TTL_MS = 1_500L

        private fun defaultSessionId(): String =
            "android_live_" + UUID.randomUUID().toString().substring(0, 8)

        private fun sourceBadgeForTurn(
            presetId: String?,
            eventSource: String?,
            metadata: Map<String, Any?>? = null,
        ): SourceBadge =
            when {
                presetId != null -> SourceBadge.DemoData
                eventSource == "real_perception" -> SourceBadge.LiveRecognition
                metadata?.get("perception_mode") == "real_perception" -> SourceBadge.LiveRecognition
                else -> SourceBadge.RecordingOnly
            }
    }
}

private fun Map<String, Any?>.numberOrNull(key: String): Double? =
    (this[key] as? Number)?.toDouble()

private fun Map<String, Any?>.booleanOrNull(key: String): Boolean? =
    this[key] as? Boolean

private fun Map<String, Any?>.toVisionMetadata(readinessReason: String?): Map<String, Any?> =
    linkedMapOf(
        "perception_mode" to "real_perception",
        "camera_facing" to this["camera_facing"],
        "camera_mount" to this["camera_mount"],
        "mirrored" to this["mirrored"],
        "vision_ready" to this["vision_ready"],
        "vision_readiness_reason" to readinessReason,
        "pose_coverage" to this["pose_coverage"],
        "frame_stability" to this["frame_stability"],
        "observed_window_ms" to this["observed_window_ms"],
    ).filterValues { it != null }

private fun visionReadinessMessage(reason: String?): String =
    when (reason) {
        "low_confidence", "missing_confidence" -> "视觉置信度不足，仅录制/采集。"
        "low_pose_coverage" -> "请让画面看到胸口、双手和手肘；暂时仅录制/采集。"
        "unstable_frame" -> "请把手机支稳在胸口侧；暂时仅录制/采集。"
        "camera_mount_handheld" -> "施救者手持手机时不做实时识别，仅录制/采集。"
        "camera_mount_unusable" -> "当前摆放不适合识别，仅录制/采集。"
        "camera_mount_unknown" -> "手机摆放未知，仅录制/采集。"
        "stage_not_cpr_loop" -> "CPR 按压开始前仅录制/采集。"
        else -> "视觉未就绪，仅录制/采集。"
    }

internal fun isCprLiveRecognitionStage(stage: String?): Boolean =
    stage == "S7_CPR_LOOP"

private fun Map<String, Any?>.toPerceptionSignals(
    timestampMs: Long,
    confidence: Double,
): List<PerceptionSignal<Any>> =
    map { (key, value) ->
        PerceptionSignal(
            key = key,
            value = value,
            confidence = confidence,
            source = "vision_cpr",
            timestampMs = timestampMs,
            ttlMs = 1_500L,
        )
    }

/**
 * Protocol-agnostic entry seam: where a live session was triggered from. Every
 * source maps to the *same* seed perception event (`session_started`) plus a set
 * of metadata **priors**. Priors are advisory only — the client never asserts a
 * medical verdict (e.g. `no_breathing`); the server uses them to shorten the
 * judgement-funnel observation windows, and S3 is still never skipped.
 */
sealed interface EntrySource {
    /** Always-available bulletproof fallback (the big "一键急救" button). */
    data object OneKeyButton : EntrySource

    /** Demo wake-word / voice trigger. [phrase] rides along as a prior, not a diagnosis. */
    data class WakePhrase(val phrase: String) : EntrySource

    /** Metadata priors seeded into PerceptionEvent #0 for this entry source. */
    fun seedMetadata(): Map<String, Any?> =
        when (this) {
            OneKeyButton -> linkedMapOf(
                "adult_likely" to true,
                "recording" to true,
                "scene_note" to "one_key_first_aid",
                "entry_source" to "one_key_button",
            )
            is WakePhrase -> linkedMapOf(
                "adult_likely" to true,
                "recording" to true,
                "scene_note" to "wake_phrase_entry",
                "entry_source" to "wake_phrase",
                "wake_phrase" to phrase,
            )
        }
}

/** Canonical Demo phrase used by the on-screen "语音唤起" trigger. */
const val DEMO_WAKE_PHRASE: String = "有人没有呼吸了"

private val WAKE_PHRASE_KEYWORDS: List<String> = listOf(
    "没有呼吸", "没呼吸", "不能呼吸", "停止呼吸", "不动了",
    "没有反应", "没反应", "叫不醒", "晕倒", "昏倒", "倒下", "倒地",
    "心脏骤停", "心跳停", "救命",
)

/**
 * Minimal local wake-phrase matcher (Demo placeholder for a real offline wake
 * engine). Returns the trimmed transcript when it contains a known emergency
 * keyword, else null. Intentionally lenient: a false start is recoverable (the
 * judgement funnel re-checks S2/S3), a missed start is not.
 */
internal fun matchWakePhrase(transcript: String?): String? {
    val text = transcript?.trim().orEmpty()
    if (text.isEmpty()) return null
    return if (WAKE_PHRASE_KEYWORDS.any { text.contains(it) }) text else null
}

internal fun firstAidSessionStartedRequest(
    sessionId: String,
    source: EntrySource = EntrySource.OneKeyButton,
): TurnRequest =
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
        metadata = source.seedMetadata(),
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

internal fun reduceLiveEvent(current: LiveUiState, event: LiveAgentEvent): LiveUiState =
    when (event) {
        is LiveAgentEvent.ConnectionChanged -> current.copy(
            connectionState = if (event.connected) ConnectionState.Online else ConnectionState.Offline,
            lastErrorMessage = event.message,
        )
        is LiveAgentEvent.PartialTranscript -> current.copy(
            partialTranscript = event.text.takeIf { it.isNotBlank() },
            micState = MicState.Capturing,
            sourceBadge = SourceBadge.RecordingOnly,
            lastErrorMessage = null,
        )
        is LiveAgentEvent.FinalTranscript -> current.copy(
            partialTranscript = null,
            lastUserTranscript = event.text.ifBlank { null } ?: current.lastUserTranscript,
            micState = MicState.Listening,
            isInFlight = true,
        )
        is LiveAgentEvent.Guidance -> {
            val response = event.response
            val base = current.copy(
                connectionState = ConnectionState.Online,
                currentStage = response?.currentStage ?: current.currentStage,
                responseType = response?.responseType ?: current.responseType,
                guidanceSource = response?.guidanceSource ?: current.guidanceSource,
                eventSource = response?.eventSource ?: current.eventSource,
                eventMode = response?.eventMode ?: current.eventMode,
                ttsText = event.action.tts.text,
                lastAssistantText = event.action.tts.text.ifBlank { null } ?: current.lastAssistantText,
                lastErrorMessage = null,
                isInFlight = false,
                micState = if (current.micState == MicState.Capturing) MicState.Listening else current.micState,
            )
            base.applyGuidance(event.action)
        }
        is LiveAgentEvent.State -> current.copy(currentStage = event.currentStage ?: current.currentStage)
        is LiveAgentEvent.AudioChunk -> current
        is LiveAgentEvent.Error -> current.copy(
            connectionState = ConnectionState.Error,
            lastErrorMessage = event.message,
            isInFlight = false,
        )
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
        partialTranscript = null,
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
        ttsTone = action.tts.tone,
        ttsSpeed = action.tts.speed,
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
