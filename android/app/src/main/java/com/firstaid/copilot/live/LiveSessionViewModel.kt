package com.firstaid.copilot.live

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.firstaid.copilot.execution.CONFIRMATION_REQUEST_TOOL_TYPES
import com.firstaid.copilot.execution.CRITICAL_TOOL_TYPES
import com.firstaid.copilot.execution.DispatchContext
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HAPTIC_TOOL_TYPES
import com.firstaid.copilot.execution.SHARE_OR_DESTRUCTIVE_TOOL_TYPES
import com.firstaid.copilot.live.audio.LiveAudioMetadata
import com.firstaid.copilot.live.audio.LiveAudioPlayer
import com.firstaid.copilot.live.edge.EdgeGemmaAgent
import com.firstaid.copilot.live.edge.EdgeOpenQuestionDetector
import com.firstaid.copilot.live.edge.EdgeOpenQuestionPolicy
import com.firstaid.copilot.live.edge.EdgeTinyNluResolver
import com.firstaid.copilot.live.edge.OpenQuestionFrame
import com.firstaid.copilot.live.edge.OpenQuestionSupplementOutcome
import com.firstaid.copilot.live.edge.OpenQuestionSupplementResponder
import com.firstaid.copilot.live.perception.EmaQualityScore
import com.firstaid.copilot.live.perception.HandPositionHysteresis
import com.firstaid.copilot.live.perception.PerceptionSignal
import com.firstaid.copilot.live.perception.smoothInterruptionSeconds
import com.firstaid.copilot.live.vision.cpr.evaluateVisionReadiness
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

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
 * [LocalAgentTransport] keeps the live flow on device without requiring an
 * `adb reverse` tunnel to a Node voice server.
 */
class LiveSessionViewModel(
    private val transport: AgentTransport = LocalAgentTransport(),
    private val liveChannel: LiveAgentChannel = LocalAgentChannel(transport),
    private val liveAudioPlayer: LiveAudioPlayer = LiveAudioPlayer(),
    private val sessionId: String = defaultSessionId(),
    private val nluCoordinator: LiveNluCoordinator = LiveNluCoordinator(),
    /**
     * Phase D: drive the always-on [proactiveMonitor] loop in [init]. Tests set
     * this false and pump [proactiveTick] manually so cues are deterministic
     * without virtual time.
     */
    private val autoStartProactiveMonitor: Boolean = true,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting),
    )
    val uiState: StateFlow<LiveUiState> = _uiState.asStateFlow()

    /**
     * On-device NLU seam (Phase 1 · E). Attached at runtime by the Live screen
     * once the Gemma driver is prewarmed (wrapped as `EdgeGemmaAgent`); null until
     * then, so the default behaviour is exactly the prior regex+phonetic-only hot
     * path.
     */
    @Volatile
    private var nluResolver: LiveNluResolver? = null
    private val visionHandPosition = HandPositionHysteresis()
    private val visionQualityScore = EmaQualityScore()
    private val liveAudioDispatcher = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "live-audio-player").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val liveAsrFinalGate = LiveAsrFinalGate()
    private var ignoredServerAudioActionId: String? = null
    private var lastVisionMetricsEmitMs = 0L
    private var lastVisionInterruptionSeconds: Double? = null

    /**
     * Phase-0 seam for the端侧 Gemma 增强层. The Live screen wraps the prewarmed
     * [com.firstaid.copilot.live.edge.OnDeviceGemmaDriver] in an [EdgeGemmaAgent]
     * and attaches it here; later phases (NLU / open-question / proactive) read it
     * off the hot path. The agent is inert unless its feature flags are enabled,
     * so holding a reference changes no current behavior.
     */
    @Volatile
    private var edgeGemmaAgent: EdgeGemmaAgent? = null

    /**
     * The on-device tiny NLU resolver (功能 E), attached alongside the agent when
     * `nluEnabled` so breathing-observation intent resolution bypasses the slow 2B
     * driver entirely. Tracked separately from the agent so [detachEdgeGemmaAgent]
     * clears exactly what [attachEdgeGemmaAgent] set.
     */
    @Volatile
    private var edgeNluResolver: LiveNluResolver? = null

    /**
     * Phase 2 · C seam — the on-device open-question responder. Attached (usually
     * the [EdgeGemmaAgent] itself) once Gemma is prewarmed and the open-question
     * flag is on; null keeps the prior server-driven open-question path. The hot
     * path only ever *augments* an immediate deterministic ack with this answer.
     */
    @Volatile
    private var openQuestionSupplementResponder: OpenQuestionSupplementResponder? = null

    /**
     * True while the edge layer owns the in-flight/last open question, so the
     * server's own `open_question_ack` / `open_question_answer` (and their audio)
     * are dropped to avoid double-answering ("置标志忽略服务端 open_question_answer").
     */
    private var edgeOpenQuestionActive = false

    /** Monotonic token; a superseded async answer (new turn / barge-in) is ignored. */
    private var openQuestionEpoch = 0
    private var openQuestionJob: Job? = null

    /** `action_id`s of dropped server open-question guidance whose audio must also be muted. */
    private val suppressedOpenQuestionActionIds = mutableSetOf<String>()

    /**
     * Phase D (proactive coaching) seam. The polisher is an *optional* on-device
     * Gemma touch-up attached at runtime once the driver is prewarmed; null keeps
     * the deterministic templates ("D 默认走模板"). [proactiveCoach] carries the
     * cross-tick cooldown/cadence memory; [lastObservedGuidanceActionId] lets the
     * monitor notice a fresh high/critical guidance and stay quiet around it.
     */
    @Volatile
    private var proactivePolisher: ProactivePolisher? = null

    /**
     * Explicit proactive-coaching override, default OFF to keep behaviour
     * unchanged ("全部 flag 可关"). Production normally leaves this false and lets
     * the attached agent's `proactiveActive` flag drive [proactiveCoachingActive];
     * tests flip it on to exercise the monitor without constructing an agent.
     * While inactive the loop keeps ticking but never emits a cue.
     */
    @Volatile
    private var proactiveCoachingEnabled = false
    private var proactiveCoach = ProactiveCoachState()
    private var lastObservedGuidanceActionId: String? = null

    init {
        viewModelScope.launch {
            liveChannel.events.collect { event ->
                if (shouldDropServerEvent(event)) {
                    return@collect
                }
                if (event is LiveAgentEvent.Metrics) {
                    logLiveMetrics(event.metrics)
                }
                if (event.isLiveAudioPlaybackEvent()) {
                    withContext(liveAudioDispatcher) {
                        liveAudioPlayer.consume(event)
                    }
                }
                _uiState.update { current ->
                    reduceLiveEvent(current, event).withCprStartedAtIfNeeded(
                        previousStage = current.currentStage,
                        nowMs = System.currentTimeMillis(),
                    )
                }
            }
        }
        if (autoStartProactiveMonitor) {
            launchProactiveMonitor()
        }
    }

    /**
     * Phase D — always-on proactive coaching loop. Every [PROACTIVE_TICK_MS] it
     * snapshots [_uiState] and lets the pure [decideProactiveCue] decide whether a
     * hand-switch / AED / reassurance nudge is due. The first tick is staggered by
     * one period so a freshly-started session is never interrupted at t=0; the
     * loop is cancelled automatically when [viewModelScope] is cleared.
     */
    private fun launchProactiveMonitor() {
        viewModelScope.launch {
            delay(PROACTIVE_TICK_MS)
            while (isActive) {
                proactiveTick(System.currentTimeMillis())
                delay(PROACTIVE_TICK_MS)
            }
        }
    }

    /** Probe the agent server and reflect reachability in [LiveUiState.connectionState]. */
    fun connect() {
        viewModelScope.launch {
            _uiState.update { it.copy(connectionState = ConnectionState.Connecting) }
            liveChannel.connect(sessionId)
            val online = transport.health()
            _uiState.update { current ->
                if (online) {
                    current.copy(connectionState = ConnectionState.Online, lastErrorMessage = null)
                } else {
                    current.copy(connectionState = ConnectionState.Offline)
                }
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
        liveAsrFinalGate.reset()
        resetEdgeOpenQuestionState()
        val request = firstAidSessionStartedRequest(sessionId, source)
        val nowMs = System.currentTimeMillis()
        if (_uiState.value.connectionState == ConnectionState.Online) {
            cancelLiveAudio("new_turn")
            liveChannel.sendTurn(request)
            _uiState.update { current ->
                current.withSessionStartedAt(nowMs).copy(
                    isInFlight = true,
                    currentDemoPresetId = null,
                    sourceBadge = SourceBadge.RecordingOnly,
                    isLiveAudioPlaying = false,
                    activeAudioActionId = null,
                    lastErrorMessage = null,
                    openQuestionPhase = OpenQuestionPhase.Idle,
                )
            }
        } else {
            runTurn(
                request,
                presetId = null,
                sourceBadge = SourceBadge.RecordingOnly,
                clearDemoPreset = true,
                startSessionIfNeeded = true,
                nowMs = nowMs,
            )
        }
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
        metadata: Map<String, Any?>? = null,
    ) {
        runTurn(
            TurnRequest(
                sessionId = sessionId,
                text = text,
                audioBase64 = audioBase64,
                mimeType = mimeType,
                metadata = metadata,
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

    fun acceptLocalAsrPartial(text: String) {
        val clean = text.trim()
        _uiState.update {
            it.copy(
                partialTranscript = clean.takeIf(String::isNotBlank),
                micState = MicState.Capturing,
                sourceBadge = SourceBadge.RecordingOnly,
                lastErrorMessage = null,
            )
        }
    }

    fun reportLocalAsrError(message: String) {
        _uiState.update {
            it.copy(
                micState = if (it.micState == MicState.Capturing) MicState.Listening else it.micState,
                lastErrorMessage = message,
            )
        }
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

    /**
     * Attach the on-device Gemma enhancement layer once the driver has prewarmed.
     * The screen owns the agent's lifecycle (it closes it on dispose); the
     * ViewModel only holds the reference for later phases to use off the hot path.
     */
    fun attachEdgeGemmaAgent(agent: EdgeGemmaAgent) {
        edgeGemmaAgent = agent
        // Wire each capability seam from the single agent, gated by its flags, so the
        // default (all-off) build keeps the exact prior behavior on every path.
        val flags = agent.flags
        // E (NLU) is a closed-set classification, so it runs on the microsecond tiny
        // resolver instead of the ~10-17s 2B driver path (which also drives the driver's
        // timeout discard/rebuild cascade). C/D still use the agent.
        if (flags.enabled && flags.nluEnabled) {
            val tiny = EdgeTinyNluResolver()
            edgeNluResolver = tiny
            nluResolver = tiny
        }
        if (flags.enabled && flags.proactiveEnabled) proactivePolisher = agent
        if (flags.enabled && flags.openQuestionEnabled) openQuestionSupplementResponder = agent
        Log.i(TAG, "Edge Gemma agent attached (flags=${agent.flags})")
    }

    /** Drop the reference when the screen is leaving / re-warming the driver. */
    fun detachEdgeGemmaAgent() {
        val agent = edgeGemmaAgent
        edgeGemmaAgent = null
        if (nluResolver === edgeNluResolver) nluResolver = null
        edgeNluResolver = null
        if (proactivePolisher === agent) proactivePolisher = null
        if (openQuestionSupplementResponder === agent) openQuestionSupplementResponder = null
    }

    /**
     * Wire (or clear) the on-device open-question responder (Phase 2 · C). Safe to
     * call repeatedly; null restores the server-driven open-question path. Tests
     * inject a fake; production attaches the [EdgeGemmaAgent] via
     * [attachEdgeGemmaAgent].
     */
    fun attachOpenQuestionSupplementResponder(responder: OpenQuestionSupplementResponder?) {
        openQuestionSupplementResponder = responder
    }

    /** Accessor for later live phases (NLU / open-question / proactive). */
    internal fun currentEdgeGemmaAgent(): EdgeGemmaAgent? = edgeGemmaAgent

    /**
     * Wire (or clear) the on-device NLU resolver. Safe to call repeatedly; passing
     * null restores the regex+phonetic-only hot path. The medical flow is never
     * affected — the resolver only refines the *intent hint* sent on a later turn.
     */
    fun attachNluResolver(resolver: LiveNluResolver?) {
        nluResolver = resolver
    }

    /**
     * Phase D seam: attach (or clear) an optional on-device Gemma polisher for
     * proactive cues. Safe to call repeatedly; null keeps the deterministic
     * templates. The polisher only rewords an already-safe template and its
     * output must still pass [isProactiveTextSafe] — it can never change the
     * medical flow, the cue cadence, or the gating.
     */
    fun attachProactivePolisher(polisher: ProactivePolisher?) {
        proactivePolisher = polisher
    }

    /**
     * Explicit proactive-coaching override (OR'd with the attached agent's
     * `proactiveActive` flag in [proactiveCoachingActive]). Mainly a test/seam
     * hook; production usually relies on the agent flag set via
     * [attachEdgeGemmaAgent].
     */
    fun setProactiveCoachingEnabled(enabled: Boolean) {
        proactiveCoachingEnabled = enabled
    }

    fun submitLiveText(
        text: String,
        intent: String? = null,
        fromAsr: Boolean = false,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val clean = text.trim()
        if (clean.isBlank()) return
        // Regex hint first; if it misses, fall back to the phonetic safety net so a
        // misheard CPR-live question (e.g. "除颤仪" -> "出差移") still carries the right
        // intent hint. The net is stage-gated and returns null until it is warmed.
        val explicitMatch = intent
            ?.takeIf { it.isNotBlank() }
            ?.let { FastIntentMatch(it, 1.0) }
        val fastMatch = explicitMatch
            ?: inferLiveFastIntent(clean)
            ?: LivePhoneticIntentRouter.infer(clean, _uiState.value.currentStage)
        // Read side of the async NLU: on a regex + phonetic miss, reuse the most
        // recent on-device correction cached for this exact transcript so the next
        // identical turn carries the right hint. Empty until a resolver is attached.
        val resolvedMatch = fastMatch ?: nluCoordinator.cachedIntent(clean, nowMs)
        val currentState = _uiState.value
        val rawResolvedIntent = resolvedMatch?.intent
        val shouldRouteAsOpenQuestion =
            EdgeOpenQuestionPolicy.isOpenQuestionStage(currentState.currentStage) &&
                !isResponseCheckQuestionTranscript(clean) &&
                EdgeOpenQuestionDetector.looksLikeOpenQuestion(clean) &&
                !isDeterministicLiveQuestionIntent(rawResolvedIntent)
        val resolvedIntent = if (shouldRouteAsOpenQuestion) null else rawResolvedIntent
        val intentMetadata = resolvedIntent
            ?.takeIf(String::isNotBlank)
            ?.let { mapOf("intent_hint" to it, "intent_source" to "local_live_submit") }
        val criticalPlaybackBypass = fromAsr &&
            shouldBypassPlaybackForCriticalAsrFinal(
                currentState,
                resolvedIntent,
                resolvedMatch?.confidence,
            )
        if (
            fromAsr &&
            !liveAsrFinalGate.shouldAccept(
                text = clean,
                state = currentState,
                nowMs = nowMs,
                intent = resolvedIntent,
                confidence = resolvedMatch?.confidence,
            )
        ) {
            return
        }
        // Phase 2 · C — open-question detection. A regex + phonetic + NLU-cache miss
        // that "reads like a question" in an open-question-eligible stage is handled
        // on-device (immediate ack + async controlled answer) when a responder is
        // attached. Response-check questions keep their deterministic server path.
        val isEdgeOpenQuestion = shouldRouteAsOpenQuestion &&
            EdgeOpenQuestionPolicy.isOpenQuestionStage(currentState.currentStage) &&
            !isResponseCheckQuestionTranscript(clean) &&
            EdgeOpenQuestionDetector.looksLikeOpenQuestion(clean)

        // Non-blocking on-device NLU: when both the regex hint and the phonetic net
        // miss, resolve this transcript in the background and cache the intent so
        // the *next* identical turn is corrected. The hot path never waits on Gemma
        // (mirrors the server's GEMMA_NLU_ASYNC=1 contract); throttled by the
        // coordinator's LRU cache + per-minute budget. Skipped for an edge open
        // question — that path already spends this turn's single-driver generation.
        if (fastMatch == null && !isEdgeOpenQuestion && !shouldRouteAsOpenQuestion) {
            maybeResolveIntentAsync(clean, nowMs)
        }
        if (_uiState.value.connectionState != ConnectionState.Online) {
            if (isEdgeOpenQuestion) {
                // Offline: no server to mirror or dedup — answer purely on-device.
                cancelLiveAudio("new_turn")
                startEdgeOpenQuestion(clean, commitToServer = false)
            } else {
                submitTurn(text = clean, metadata = intentMetadata)
            }
            return
        }
        if (criticalPlaybackBypass) {
            cancelLiveAudio("critical_asr_final")
            liveChannel.sendBargeIn()
        } else {
            cancelLiveAudio("new_turn")
        }
        val mirrorEdgeOpenQuestionTurn = !isEdgeOpenQuestion || liveChannel.mirrorsEdgeOpenQuestionTurns
        if (mirrorEdgeOpenQuestionTurn) {
            liveChannel.updateContext(TurnRequest(sessionId = sessionId))
            liveChannel.commitText(clean, resolvedIntent)
        }
        if (isEdgeOpenQuestion) {
            // The server still sees the turn (transcript / stage sync), but the edge
            // owns the answer; its open-question ack/answer is dropped to avoid a
            // double reply. LocalAgentChannel is not a server mirror, so it is not
            // fed the question; otherwise its deterministic flow guidance wins the
            // race and hides the edge answer.
            startEdgeOpenQuestion(clean, commitToServer = liveChannel.mirrorsEdgeOpenQuestionTurns)
        } else {
            resetEdgeOpenQuestionState()
            _uiState.update {
                it.copy(
                    partialTranscript = null,
                    lastUserTranscript = clean,
                    isInFlight = true,
                    micState = MicState.Listening,
                    sourceBadge = SourceBadge.RecordingOnly,
                    isLiveAudioPlaying = false,
                    activeAudioActionId = null,
                    lastErrorMessage = null,
                    openQuestionPhase = OpenQuestionPhase.Idle,
                    lastOpenQuestionMetrics = null,
                    openQuestionSupplement = null,
                )
            }
        }
    }

    /**
     * Rule-first open-question turn. The fast rule answer is the user-visible
     * reply; Gemma may only add a later one-line supplement.
     */
    private fun startEdgeOpenQuestion(question: String, commitToServer: Boolean) {
        resetEdgeOpenQuestionState()
        val stage = _uiState.value.currentStage
        val epoch = ++openQuestionEpoch
        edgeOpenQuestionActive = commitToServer
        val actionId = edgeOpenQuestionActionId("fast_rule", epoch)
        val fastAnswerText = EdgeOpenQuestionPolicy.fallbackAnswer(stage, question)
        val metrics = edgeOpenQuestionFastRuleMetrics(stage)
        _uiState.update {
            it.copy(
                partialTranscript = null,
                lastUserTranscript = question,
                isInFlight = false,
                micState = MicState.Listening,
                sourceBadge = SourceBadge.RecordingOnly,
                isLiveAudioPlaying = false,
                activeAudioActionId = null,
                lastErrorMessage = null,
                openQuestionPhase = OpenQuestionPhase.Answer,
                mainText = EdgeOpenQuestionPolicy.ackMainText(stage),
                secondaryText = fastAnswerText,
                ttsText = fastAnswerText,
                lastAssistantText = fastAnswerText,
                lastActionId = actionId,
                ttsPriority = "normal",
                ttsInterruptPolicy = "do_not_interrupt_critical",
                ttsTone = "calm_firm",
                ttsSpeed = "normal",
                suppressLocalTts = false,
                responseType = "open_question_answer",
                guidanceSource = "open_question_fast_rule",
                lastOpenQuestionMetrics = metrics,
                openQuestionSupplement = null,
            )
        }
        launchEdgeOpenQuestionSupplement(stage, question, fastAnswerText, epoch, actionId)
    }

    /** Generate + guard a short, non-repeated supplement off the hot path. */
    private fun launchEdgeOpenQuestionSupplement(
        stage: String?,
        question: String,
        fastAnswerText: String,
        epoch: Int,
        fastActionId: String,
    ) {
        val responder = openQuestionSupplementResponder ?: return
        val frame = buildOpenQuestionFrame(stage, question)
        openQuestionJob = viewModelScope.launch {
            val outcome = try {
                responder.answerOpenQuestionSupplement(frame, fastAnswerText)
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Throwable) {
                OpenQuestionSupplementOutcome(
                    accepted = false,
                    reason = "exception:${error.message ?: "unknown"}",
                )
            }
            applyEdgeOpenQuestionSupplement(stage, question, fastActionId, outcome, epoch)
        }
    }

    private fun applyEdgeOpenQuestionSupplement(
        stage: String?,
        question: String,
        fastActionId: String,
        outcome: OpenQuestionSupplementOutcome,
        epoch: Int,
    ) {
        val metrics = edgeOpenQuestionSupplementMetrics(stage, outcome)
        _uiState.update { current ->
            if (epoch != openQuestionEpoch) return@update current
            val updatedMetrics = current.copy(lastOpenQuestionMetrics = metrics)
            if (!outcome.accepted || outcome.text.isBlank()) return@update updatedMetrics
            if (
                current.currentStage != stage ||
                current.lastActionId != fastActionId ||
                current.lastUserTranscript != question ||
                current.ttsPriority == "critical" ||
                current.pendingConfirmation != null ||
                current.emergencyCall.requested
            ) {
                return@update updatedMetrics
            }
            updatedMetrics.copy(
                openQuestionSupplement = OpenQuestionSupplement(
                    id = edgeOpenQuestionActionId(
                        if (outcome.cacheHit) "supplement_cache" else "supplement",
                        epoch,
                    ),
                    text = outcome.text,
                    tone = "calm_firm",
                    speed = "normal",
                ),
            )
        }
    }

    private fun buildOpenQuestionFrame(stage: String?, question: String): OpenQuestionFrame {
        val snapshot = _uiState.value
        val facts = linkedMapOf<String, Any?>(
            "adult_likely" to true,
            "cpr_started" to EdgeOpenQuestionPolicy.isCprLiveStage(stage),
        )
        snapshot.qualityScore?.let { facts["quality_score"] = it }
        return OpenQuestionFrame(
            stage = stage,
            userInput = question,
            allowedIntents = EdgeOpenQuestionPolicy.answerIntents(stage),
            safetyPhrases = EdgeOpenQuestionPolicy.safetyPhrases(stage),
            facts = facts,
            recentTts = listOfNotNull(snapshot.lastAssistantText?.takeIf { it.isNotBlank() }),
        )
    }

    private fun edgeOpenQuestionFastRuleMetrics(stage: String?): LiveTurnMetrics =
        LiveTurnMetrics(
            currentStage = stage,
            gemma = LiveGemmaTurnMetrics(
                skipped = true,
                skipReason = "fast_rule_first",
                openQuestion = true,
            ),
            openQuestion = LiveOpenQuestionTurnMetrics(
                segment = "fast_rule",
                fallback = false,
                waitMs = 0L,
            ),
            guidanceSource = "open_question_fast_rule",
        )

    private fun edgeOpenQuestionSupplementMetrics(
        stage: String?,
        outcome: OpenQuestionSupplementOutcome,
    ): LiveTurnMetrics =
        LiveTurnMetrics(
            currentStage = stage,
            timings = if (outcome.cacheHit) emptyMap() else mapOf("gemma_supplement_ms" to outcome.latencyMs),
            gemma = LiveGemmaTurnMetrics(
                skipped = !outcome.accepted,
                skipReason = outcome.reason,
                live = outcome.accepted && !outcome.cacheHit,
                openQuestion = true,
            ),
            openQuestion = LiveOpenQuestionTurnMetrics(
                segment = "gemma_supplement",
                cacheHit = outcome.cacheHit,
                fallback = !outcome.accepted,
                reason = outcome.reason,
                waitMs = outcome.latencyMs,
            ),
            guidanceSource = if (outcome.cacheHit) {
                "open_question_supplement_cache"
            } else {
                "open_question_supplement"
            },
        )

    /**
     * Supersede any in-flight edge open-question turn and clear its dedup state.
     * Bumps the epoch so a returning async answer is dropped, cancels the worker,
     * and stops muting the server's open-question reply.
     */
    private fun resetEdgeOpenQuestionState() {
        openQuestionEpoch++
        openQuestionJob?.cancel()
        openQuestionJob = null
        edgeOpenQuestionActive = false
        suppressedOpenQuestionActionIds.clear()
        _uiState.update { it.copy(openQuestionSupplement = null) }
    }

    /**
     * Resolve [transcript] with the on-device NLU off the hot path and cache the
     * result for the next identical turn. No-op when no resolver is attached or
     * the coordinator declines (cache hit, in flight, or per-minute budget hit).
     */
    private fun maybeResolveIntentAsync(transcript: String, nowMs: Long) {
        val resolver = nluResolver ?: return
        val key = nluCoordinator.beginResolve(transcript, nowMs) ?: return
        val stage = _uiState.value.currentStage
        viewModelScope.launch {
            try {
                val resolution = resolver.resolveIntent(LiveNluRequest(transcript = transcript, stage = stage))
                nluCoordinator.completeResolve(key, resolution?.toFastIntentMatch())
            } catch (cancel: CancellationException) {
                nluCoordinator.abortResolve(key)
                throw cancel
            } catch (error: Throwable) {
                Log.w(TAG, "On-device NLU resolve failed: ${error.message}")
                nluCoordinator.abortResolve(key)
            }
        }
    }

    /**
     * Phase D — one proactive-coaching tick. Pure decision in [decideProactiveCue];
     * this method only owns the side effects: maintaining the high-priority quiet
     * window, optionally polishing the chosen template off the hot path, and
     * publishing the cue into [_uiState] for the screen's dedicated low-priority
     * TTS effect. `internal` so tests can pump it with a controlled [nowMs].
     */
    internal suspend fun proactiveTick(nowMs: Long) {
        if (!proactiveCoachingActive()) return
        val snapshot = _uiState.value
        observeGuidancePriority(snapshot, nowMs)
        val decision = decideProactiveCue(snapshot, proactiveCoach, nowMs)
        if (decision !is ProactiveDecision.Emit) return
        proactiveCoach = decision.state
        val cprElapsedMs = snapshot.cprStartedAtMs?.let { (nowMs - it).coerceAtLeast(0L) } ?: 0L
        val resolved = resolveProactiveText(decision.cue, snapshot, cprElapsedMs)
        // Re-validate the speech gate after any (suspending) polish: never talk
        // over a critical line, server audio, or a turn that began meanwhile.
        if (hardSpeechBlockReason(_uiState.value) != null) return
        val cue = decision.cue.copy(text = resolved.first, polished = resolved.second)
        _uiState.update { it.copy(proactiveCue = cue, lastAssistantText = cue.text) }
    }

    /**
     * Proactive coaching is on when either the explicit switch is set (tests /
     * direct control) or a proactive polisher has been attached. `attachEdgeGemmaAgent`
     * already sets [proactivePolisher] exactly when the proactive flag is active,
     * so reusing that field turns the monitor on for free without coupling to the
     * agent's flag API — and the deterministic templates still drive the cue even
     * when the polisher declines a rewrite (template-first).
     */
    private fun proactiveCoachingActive(): Boolean =
        proactiveCoachingEnabled || proactivePolisher != null

    /**
     * Track when a fresh high/critical guidance arrives (by [LiveUiState.lastActionId]
     * change) so the monitor stays quiet for [PROACTIVE_POST_HIGH_PRIORITY_QUIET_MS]
     * afterwards. `ttsPriority` alone is unreliable (it persists across turns), so
     * we anchor the window to the *arrival* of a new action.
     */
    private fun observeGuidancePriority(state: LiveUiState, nowMs: Long) {
        val actionId = state.lastActionId ?: return
        if (actionId == lastObservedGuidanceActionId) return
        lastObservedGuidanceActionId = actionId
        if (state.ttsPriority == "critical" || state.ttsPriority == "high") {
            proactiveCoach = proactiveCoach.copy(lastHighPriorityAtMs = nowMs)
        }
    }

    /**
     * Resolve the spoken text for [cue]: deterministic template by default, or an
     * on-device Gemma polish when a polisher is attached, the rewrite returns in
     * time, and it passes [isProactiveTextSafe]. Any timeout/blank/unsafe result
     * silently falls back to the template, so the driver being busy is harmless.
     * Returns (text, polished?).
     */
    private suspend fun resolveProactiveText(
        cue: ProactiveCue,
        state: LiveUiState,
        cprElapsedMs: Long,
    ): Pair<String, Boolean> {
        val polisher = proactivePolisher ?: return cue.text to false
        val polished = withTimeoutOrNull(PROACTIVE_POLISH_TIMEOUT_MS) {
            polisher.polish(
                ProactivePolishRequest(
                    kind = cue.kind,
                    templateText = cue.text,
                    stage = state.currentStage,
                    qualityScore = state.qualityScore,
                    cprElapsedMs = cprElapsedMs,
                    tone = cue.tone,
                ),
            )
        }?.trim()
        return if (polished != null && isProactiveTextSafe(polished)) {
            polished to true
        } else {
            cue.text to false
        }
    }

    fun sendLiveBargeIn() {
        cancelLiveAudio("client_barge_in")
        resetEdgeOpenQuestionState()
        liveChannel.sendBargeIn()
        _uiState.update {
            it.copy(
                micState = MicState.Capturing,
                partialTranscript = null,
                isLiveAudioPlaying = false,
                activeAudioActionId = null,
                suppressLocalTts = true,
                openQuestionPhase = if (it.openQuestionPhase.isActiveOpenQuestion()) {
                    OpenQuestionPhase.Cancelled
                } else {
                    it.openQuestionPhase
                },
            )
        }
    }

    fun stopLiveAudio() {
        cancelLiveAudio("client_stop")
        resetEdgeOpenQuestionState()
        _uiState.update {
            it.copy(
                micState = MicState.Off,
                partialTranscript = null,
                isLiveAudioPlaying = false,
                activeAudioActionId = null,
                suppressLocalTts = false,
                openQuestionPhase = OpenQuestionPhase.Idle,
            )
        }
    }

    /** Reset the server session and clear local UI state back to a fresh session. */
    fun reset() {
        viewModelScope.launch {
            liveAsrFinalGate.reset()
            resetEdgeOpenQuestionState()
            cancelLiveAudio("reset")
            liveChannel.reset()
            transport.reset(sessionId)
            _uiState.value = LiveUiState(sessionId = sessionId, connectionState = ConnectionState.Connecting)
        }
    }

    /** Dismiss the 120 simulation dialog. Does not touch the medical flow. */
    fun dismissEmergencyCallDialog() {
        _uiState.update { it.copy(emergencyCall = it.emergencyCall.copy(requested = false)) }
    }

    /** User declined a share / send / delete confirmation. */
    fun dismissConfirmation() {
        _uiState.update { it.copy(pendingConfirmation = null) }
    }

    /**
     * User explicitly confirmed a pending share / send / delete tool. This phase
     * only clears the prompt; real external send stays gated by the dispatcher
     * and server contract (mock-only in Demo).
     */
    fun confirmPendingTool() {
        _uiState.update { it.copy(pendingConfirmation = null) }
    }

    override fun onCleared() {
        liveChannel.close()
        liveAudioPlayer.release()
        liveAudioDispatcher.close()
        super.onCleared()
    }

    private fun cancelLiveAudio(reason: String) {
        liveAudioPlayer.onAudioCancel(reason)
    }

    /**
     * Top-level server-event filter. While the edge layer owns the open question,
     * the server's parallel open-question ack/answer guidance, its open-question
     * metrics, and its streamed audio are all dropped so the rescuer hears a single
     * (edge) reply. Everything else — real flow guidance, stage/connection updates,
     * non-open-question audio — passes straight through to the existing audio gate.
     */
    private fun shouldDropServerEvent(event: LiveAgentEvent): Boolean {
        if (edgeOpenQuestionActive) {
            when (event) {
                is LiveAgentEvent.Guidance -> if (event.openQuestionPhase() != null) {
                    // Remember its action_id so the matching server audio is muted too.
                    event.action.action_id?.let { suppressedOpenQuestionActionIds.add(it) }
                    return true
                }
                is LiveAgentEvent.Metrics -> if (event.metrics.gemma.openQuestion) return true
                else -> Unit
            }
        }
        return shouldDropServerAudioEvent(event)
    }

    private fun shouldDropServerAudioEvent(event: LiveAgentEvent): Boolean {
        when (event) {
            is LiveAgentEvent.AudioBegin -> {
                val current = _uiState.value
                val shouldUseLocal = !current.suppressLocalTts &&
                    event.actionId != null &&
                    event.actionId == current.lastActionId
                val suppressedOpenQuestion = event.actionId != null &&
                    event.actionId in suppressedOpenQuestionActionIds
                val drop = shouldUseLocal || suppressedOpenQuestion
                ignoredServerAudioActionId = if (drop) event.actionId else null
                return drop
            }
            is LiveAgentEvent.AudioChunk -> return ignoredServerAudioActionId != null
            is LiveAgentEvent.AudioEnd -> {
                val ignored = ignoredServerAudioActionId ?: return false
                val matchesIgnored = event.actionId == null || event.actionId == ignored
                if (matchesIgnored) {
                    suppressedOpenQuestionActionIds.remove(ignored)
                    ignoredServerAudioActionId = null
                }
                return matchesIgnored
            }
            is LiveAgentEvent.AudioCancel -> {
                val wasIgnoring = ignoredServerAudioActionId != null
                ignoredServerAudioActionId = null
                return wasIgnoring
            }
            else -> return false
        }
    }

    private fun edgeOpenQuestionActionId(segment: String, epoch: Int): String =
        "edge_open_question_${segment}_$epoch"

    private fun runTurn(
        request: TurnRequest,
        presetId: String?,
        sourceBadge: SourceBadge,
        clearDemoPreset: Boolean = false,
        startSessionIfNeeded: Boolean = false,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        _uiState.update { current ->
            val base = if (startSessionIfNeeded) current.withSessionStartedAt(nowMs) else current
            base.copy(
                isInFlight = true,
                currentDemoPresetId = if (clearDemoPreset) null else presetId ?: current.currentDemoPresetId,
                sourceBadge = sourceBadge,
                micState = if (request.audioBase64 != null) MicState.Uploading else current.micState,
            )
        }
        viewModelScope.launch {
            val result = transport.turn(request)
            _uiState.update { current ->
                reduceTurnResult(current, result).withCprStartedAtIfNeeded(
                    previousStage = current.currentStage,
                    nowMs = System.currentTimeMillis(),
                )
            }
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
        _uiState.update { current ->
            reduceTurnResult(current, result).withCprStartedAtIfNeeded(
                previousStage = current.currentStage,
                nowMs = System.currentTimeMillis(),
            )
        }
    }

    private fun logLiveMetrics(metrics: LiveTurnMetrics) {
        Log.i(
            TAG,
            "Live metrics turn=${metrics.turnSeq ?: -1} " +
                "stage=${metrics.currentStage.orEmpty()} " +
                "source=${metrics.guidanceSource.orEmpty()} " +
                "intent=${metrics.intent.intent.orEmpty()} " +
                "intentSource=${metrics.intent.source.orEmpty()} " +
                "total=${metrics.timings["total_ms"] ?: -1}ms " +
                "tts=${metrics.timings["tts_ms"] ?: -1}ms " +
                "audio=${metrics.timings["tts_first_chunk_ms"] ?: -1}ms " +
                "openSegment=${metrics.openQuestion.segment.orEmpty()} " +
                "openWait=${metrics.openQuestion.waitMs ?: -1}ms " +
                "openFallback=${metrics.openQuestion.fallback}",
        )
    }

    companion object {
        private const val TAG = "LiveSessionViewModel"
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
        is LiveAgentEvent.Thinking -> current.copy(
            isInFlight = true,
            lastLiveTurnSeq = event.turnSeq ?: current.lastLiveTurnSeq,
            connectionState = ConnectionState.Online,
            lastErrorMessage = null,
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
            val useLocalTts = !event.suppressLocalTts && event.action.shouldUseLocalLiveTts()
            val openQuestionPhase = event.openQuestionPhase()
            val base = current.copy(
                connectionState = ConnectionState.Online,
                currentStage = response?.currentStage ?: current.currentStage,
                responseType = response?.responseType ?: event.responseType ?: current.responseType,
                guidanceSource = response?.guidanceSource ?: event.guidanceSource ?: current.guidanceSource,
                eventSource = response?.eventSource ?: current.eventSource,
                eventMode = response?.eventMode ?: current.eventMode,
                ttsText = event.action.tts.text,
                lastAssistantText = event.action.tts.text.ifBlank { null } ?: current.lastAssistantText,
                lastLiveTurnSeq = event.turnSeq ?: current.lastLiveTurnSeq,
                suppressLocalTts = !useLocalTts,
                lastErrorMessage = null,
                isInFlight = false,
                micState = if (current.micState == MicState.Capturing) MicState.Listening else current.micState,
                openQuestionPhase = openQuestionPhase ?: OpenQuestionPhase.Idle,
                openQuestionSupplement = null,
            )
            base.applyGuidance(event.action)
        }
        is LiveAgentEvent.State -> {
            val nextStage = event.currentStage ?: current.currentStage
            current.copy(
                currentStage = nextStage,
                openQuestionSupplement = if (nextStage != current.currentStage) null else current.openQuestionSupplement,
            )
        }
        is LiveAgentEvent.Metrics -> current.applyLiveMetrics(event.metrics)
        is LiveAgentEvent.AudioBegin -> current.copy(
            isLiveAudioPlaying = true,
            activeAudioActionId = event.actionId,
            lastLiveTurnSeq = event.turnSeq ?: current.lastLiveTurnSeq,
            suppressLocalTts = true,
            micState = MicState.Speaking,
            lastErrorMessage = null,
        )
        is LiveAgentEvent.AudioChunk -> current.copy(isLiveAudioPlaying = true)
        is LiveAgentEvent.AudioEnd -> current.copy(
            isLiveAudioPlaying = false,
            activeAudioActionId = null,
            lastLiveTurnSeq = event.turnSeq ?: current.lastLiveTurnSeq,
            micState = if (current.micState == MicState.Speaking) MicState.Listening else current.micState,
        )
        is LiveAgentEvent.AudioCancel -> current.copy(
            isLiveAudioPlaying = false,
            activeAudioActionId = null,
            micState = if (current.micState == MicState.Speaking) MicState.Listening else current.micState,
            openQuestionPhase = if (current.openQuestionPhase.isActiveOpenQuestion()) {
                OpenQuestionPhase.Cancelled
            } else {
                current.openQuestionPhase
            },
            lastErrorMessage = event.reason
                ?.takeIf { it.isNotBlank() && !it.isExpectedAudioCancelReason() }
                ?.let { "Audio cancelled: $it" },
        )
        is LiveAgentEvent.AudioUnavailable -> {
            val alreadyUsingLocalTts = !current.suppressLocalTts &&
                event.actionId != null &&
                event.actionId == current.lastActionId
            current.copy(
                isLiveAudioPlaying = false,
                activeAudioActionId = null,
                suppressLocalTts = false,
                openQuestionPhase = current.openQuestionPhase,
                lastErrorMessage = if (alreadyUsingLocalTts) {
                    current.lastErrorMessage
                } else {
                    event.reason?.takeIf { it.isNotBlank() } ?: current.lastErrorMessage
                },
            )
        }
        is LiveAgentEvent.Error -> current.copy(
            connectionState = ConnectionState.Error,
            lastErrorMessage = event.message,
            isInFlight = false,
        )
    }

private fun LiveAgentEvent.Guidance.openQuestionPhase(): OpenQuestionPhase? =
    when {
        openQuestionAnswer || responseType == "open_question_answer" -> OpenQuestionPhase.Answer
        guidanceSource == "open_question_ack" || responseType == "open_question_ack" -> OpenQuestionPhase.Ack
        else -> null
    }

private fun OpenQuestionPhase.isActiveOpenQuestion(): Boolean =
    this == OpenQuestionPhase.Ack || this == OpenQuestionPhase.Answer

private fun LiveUiState.applyLiveMetrics(metrics: LiveTurnMetrics): LiveUiState =
    copy(
        currentStage = metrics.currentStage ?: currentStage,
        lastLiveTurnSeq = metrics.turnSeq ?: lastLiveTurnSeq,
        lastOpenQuestionMetrics = if (metrics.gemma.openQuestion) metrics else lastOpenQuestionMetrics,
        openQuestionPhase = if (metrics.gemma.openQuestion && openQuestionPhase == OpenQuestionPhase.Idle) {
            OpenQuestionPhase.Ack
        } else {
            openQuestionPhase
        },
    )

private fun LiveAudioPlayer.consume(event: LiveAgentEvent) {
    when (event) {
        is LiveAgentEvent.AudioBegin -> onAudioBegin(
            LiveAudioMetadata(
                streamId = event.streamId,
                sessionId = event.sessionId,
                actionId = event.actionId,
                turnSeq = event.turnSeq?.toLong(),
                format = event.format,
                sampleRateHz = event.sampleRate,
                channels = event.channels,
                bitsPerSample = event.bitsPerSample,
                flushQueue = event.flushQueue,
            ),
        )
        is LiveAgentEvent.AudioChunk -> onPcmChunk(event.bytes)
        is LiveAgentEvent.AudioEnd -> onAudioEnd(event.actionId)
        is LiveAgentEvent.AudioCancel -> onAudioCancel(event.reason)
        is LiveAgentEvent.AudioUnavailable -> flushQueue()
        else -> Unit
    }
}

private fun LiveAgentEvent.isLiveAudioPlaybackEvent(): Boolean =
    this is LiveAgentEvent.AudioBegin ||
        this is LiveAgentEvent.AudioChunk ||
        this is LiveAgentEvent.AudioEnd ||
        this is LiveAgentEvent.AudioCancel ||
        this is LiveAgentEvent.AudioUnavailable

private fun String.isExpectedAudioCancelReason(): Boolean =
    this == "client_barge_in" ||
        this == "new_turn" ||
        this == "reset" ||
        this == "client_stop" ||
        this == "closed"

private fun GuidanceAction.shouldUseLocalLiveTts(): Boolean {
    val text = tts.text.trim()
    return text.isNotBlank()
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
        suppressLocalTts = false,
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
    val nextHaptic = resolveNextHaptic(action)
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
        haptic = nextHaptic,
        primaryButton = action.ui.primary_button.toPrimaryButtonState() ?: primaryButton,
        emergencyCall = resolveEmergencyCall(action),
        pendingConfirmation = resolvePendingConfirmation(action),
    )
}

private fun Map<String, Any?>?.toPrimaryButtonState(): PrimaryButtonState? {
    val map = this ?: return null
    val label = (map["label"] as? String)?.takeIf { it.isNotBlank() } ?: return null
    return PrimaryButtonState(
        label = label,
        intent = (map["intent"] as? String) ?: (map["action"] as? String),
        style = map["style"] as? String,
    )
}

private fun LiveUiState.resolveEmergencyCall(action: GuidanceAction): EmergencyCallState {
    val callTool = action.tool_actions.firstOrNull { it.type in CRITICAL_TOOL_TYPES }
        ?: return emergencyCall
    // Android has no real dialing capability in this demo; the 120 dialog is
    // always a simulation by safety policy, regardless of the server tool type.
    return EmergencyCallState(requested = true, mock = true)
}

private fun LiveUiState.resolvePendingConfirmation(action: GuidanceAction): ToolConfirmationState? {
    val ctx = DispatchContext()
    val tool = action.tool_actions.firstOrNull { it.type in CONFIRMATION_REQUEST_TOOL_TYPES }
        ?: action.tool_actions.firstOrNull {
            it.type in SHARE_OR_DESTRUCTIVE_TOOL_TYPES && !it.isConfirmed(ctx)
        }
        ?: return pendingConfirmation
    return ToolConfirmationState(
        toolType = tool.type,
        title = confirmationTitleFor(tool.type),
        message = tool.confirmation["message"] as? String,
    )
}

private fun confirmationTitleFor(toolType: String): String =
    when (toolType) {
        "request_share_report", "share_report", "send_report" -> "分享交接报告？"
        "request_share_video", "share_video", "send_video" -> "分享急救视频？"
        "delete_video" -> "删除本地视频？"
        else -> "需要确认"
    }

private fun LiveUiState.resolveNextHaptic(action: GuidanceAction): HapticState {
    val hapticTools = action.tool_actions.filter { it.type in HAPTIC_TOOL_TYPES }
    val lastHapticTool = hapticTools.lastOrNull()

    if (lastHapticTool?.type == "stop_haptic_metronome") {
        return HapticState(enabled = false)
    }

    if (action.haptic.enabled || lastHapticTool?.type in START_OR_UPDATE_HAPTIC_TOOL_TYPES) {
        return HapticState(
            enabled = true,
            bpm = action.haptic.bpm ?: lastHapticTool?.bpm ?: haptic.bpm ?: 110,
        )
    }

    // In the CPR loop, haptic=false usually means "this guidance has no new
    // haptic command"; keep the locally running beat alive unless an explicit
    // stop command or a stage exit says otherwise.
    return if (haptic.enabled && currentStage.isMetronomeContinuityStage()) {
        haptic
    } else {
        HapticState(enabled = false)
    }
}

private fun String?.isOfflineCprFallbackStage(): Boolean =
    this?.startsWith("S7") == true || this?.startsWith("S8") == true

private fun String?.isMetronomeContinuityStage(): Boolean =
    this?.startsWith("S7") == true || this?.startsWith("S8") == true

private val START_OR_UPDATE_HAPTIC_TOOL_TYPES = setOf(
    "start_haptic_metronome",
    "update_haptic_metronome",
)

private fun isDeterministicLiveQuestionIntent(intent: String?): Boolean =
    intent in setOf(
        "ask_cpr_quality",
        "ask_can_stop",
        "ask_aed_cpr_alternation",
        "ask_aed_help",
        "ask_next_step",
        "ask_emergency_call",
    )
