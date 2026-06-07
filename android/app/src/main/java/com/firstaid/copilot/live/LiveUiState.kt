package com.firstaid.copilot.live

/**
 * Immutable UI state for the Live CPR Coach screen.
 *
 * This is the shared contract every later phase reads from and the
 * [LiveSessionViewModel] is the single writer. Fields intentionally cover the
 * D1-D4 plan surface up front so later phases (attention modes, overlays,
 * camera/source badge, voice, perception degradation) only consume fields and
 * never have to change this type's shape.
 */
data class LiveUiState(
    val sessionId: String = "",
    val connectionState: ConnectionState = ConnectionState.Connecting,

    /** Current medical stage from `state.current_stage`, e.g. `S7_CPR_LOOP`. */
    val currentStage: String? = null,
    val sessionStartedAtMs: Long? = null,
    val cprStartedAtMs: Long? = null,

    // --- Latest guidance mapped from guidance_action.ui / .tts ---
    val mainText: String = "",
    val secondaryText: String = "",
    val statusTags: List<String> = emptyList(),
    val qualityScore: Int? = null,
    val ttsText: String = "",
    val ttsPriority: String? = null,
    val ttsInterruptPolicy: String? = null,
    val ttsTone: String? = null,
    val ttsSpeed: String? = null,
    val lastActionId: String? = null,

    // --- visual_overlay-derived fields (D2 overlays consume these) ---
    val visualOverlayMode: String? = null,
    val correctionArrow: String? = null,

    // --- Haptic metronome intent (D-phase MetronomeController consumes this) ---
    val haptic: HapticState = HapticState(),

    // --- Honesty + input placeholders for later phases ---
    val sourceBadge: SourceBadge = SourceBadge.DemoData,
    val micState: MicState = MicState.Idle,
    val currentDemoPresetId: String? = null,

    // --- Transcript / subtitle (latest user utterance + latest assistant line) ---
    val partialTranscript: String? = null,
    val lastUserTranscript: String? = null,
    val lastAssistantText: String? = null,
    val isLiveAudioPlaying: Boolean = false,
    val activeAudioActionId: String? = null,
    val lastLiveTurnSeq: Int? = null,
    val suppressLocalTts: Boolean = false,

    // --- Response metadata (honest source badge + debugging) ---
    val responseType: String? = null,
    val guidanceSource: String? = null,
    val eventSource: String? = null,
    val eventMode: String? = null,
    val openQuestionPhase: OpenQuestionPhase = OpenQuestionPhase.Idle,
    val lastOpenQuestionMetrics: LiveTurnMetrics? = null,
    val openQuestionSupplement: OpenQuestionSupplement? = null,

    /**
     * Latest on-device proactive nudge (Phase D). Written only by the proactive
     * monitor; the screen plays it through a dedicated low-priority TTS effect
     * keyed on [ProactiveCue.id] so it never touches the server guidance/audio
     * dedup path. Null means "no pending proactive cue".
     */
    val proactiveCue: ProactiveCue? = null,

    // --- Transport status surface ---
    val lastErrorMessage: String? = null,
    val isInFlight: Boolean = false,

    // --- Tool / action surface (tool UI consumes these; medical flow stays server-driven) ---
    val primaryButton: PrimaryButtonState? = null,
    val pendingConfirmation: ToolConfirmationState? = null,
    val emergencyCall: EmergencyCallState = EmergencyCallState(),

    /**
     * D4 perception-signal holder. The detailed `{value,confidence,source,
     * freshness}` `PerceptionSignal` type lands in a later phase under
     * `live/perception/`; it will implement [PerceptionSignalMarker] so this
     * field can carry it without changing [LiveUiState]'s signature.
     */
    val perceptionSignals: List<PerceptionSignalMarker> = emptyList(),
) {
    /**
     * The inputs the D2 attention-mode mapper needs to choose Coach / EyesOff /
     * Glanceable. Derived so it can never drift from the source fields.
     */
    val attentionModeInputs: AttentionModeInputs
        get() = AttentionModeInputs(currentStage, visualOverlayMode, correctionArrow)
}

/** Connection lifecycle for the agent transport. */
enum class ConnectionState { Connecting, Online, Offline, Error }

/**
 * Honest provenance of the on-screen guidance. The server's `event.mode` is
 * always `demo_assisted`, so the badge is decided by the *input* source, not the
 * server: scripted injection -> [DemoData], real mic/camera capture still routed
 * through voice/script -> [RecordingOnly], future on-device perception ->
 * [LiveRecognition].
 */
enum class SourceBadge { DemoData, RecordingOnly, LiveRecognition }

/** Microphone / half-duplex state. Populated by the voice phase. */
enum class MicState { Idle, Listening, Capturing, Uploading, Speaking, Off }

/** Visible lifecycle for low-latency Gemma open Q&A on the live voice path. */
enum class OpenQuestionPhase { Idle, Ack, Answer, Cancelled }

/**
 * A short Gemma supplement to an already-spoken rule answer. It is intentionally
 * separate from [LiveUiState.ttsText], [LiveUiState.lastActionId], and
 * [LiveUiState.proactiveCue] so it cannot replace primary guidance audio.
 */
data class OpenQuestionSupplement(
    val id: String,
    val text: String,
    val tone: String = "calm_firm",
    val speed: String = "normal",
)

internal const val OPEN_QUESTION_SUPPLEMENT_TTS_PREFIX = "\u8865\u5145\u4e00\u53e5\uff0c"

internal fun OpenQuestionSupplement.toOpenQuestionSupplementTtsText(): String =
    OPEN_QUESTION_SUPPLEMENT_TTS_PREFIX + text.trim()

/** Haptic metronome intent derived from `guidance_action.haptic` / tool actions. */
data class HapticState(
    val enabled: Boolean = false,
    val bpm: Int? = null,
)

/** Inputs for the D2 attention-mode mapper (`stage` + `visual_overlay`). */
data class AttentionModeInputs(
    val currentStage: String? = null,
    val visualOverlayMode: String? = null,
    val correctionArrow: String? = null,
)

/**
 * Marker for D4 perception signals so [LiveUiState] can hold them before the
 * concrete `PerceptionSignal` type exists. The later phase's type implements
 * this; nothing else should.
 */
interface PerceptionSignalMarker

internal fun LiveUiState.withSessionStartedAt(nowMs: Long): LiveUiState =
    if (sessionStartedAtMs == null) copy(sessionStartedAtMs = nowMs) else this

internal fun LiveUiState.withCprStartedAtIfNeeded(
    previousStage: String?,
    nowMs: Long,
): LiveUiState =
    if (
        cprStartedAtMs == null &&
        previousStage?.startsWith("S7") != true &&
        currentStage?.startsWith("S7") == true
    ) {
        copy(cprStartedAtMs = nowMs)
    } else {
        this
    }

/**
 * A primary call-to-action mapped from `guidance_action.ui.primary_button`.
 * Purely presentational; tapping it routes back through the normal turn loop.
 */
data class PrimaryButtonState(
    val label: String,
    val intent: String? = null,
    val style: String? = null,
)

/**
 * A tool that needs explicit, visible user confirmation before it may run
 * (share / send / delete). Surfaced so the UI can show a confirmation sheet;
 * nothing is sent externally without the user acting on it.
 */
data class ToolConfirmationState(
    val toolType: String,
    val title: String,
    val message: String? = null,
)

/**
 * 120 emergency-call simulation surface. Demo builds never dial a real number;
 * [mock] stays true unless a real, separately-approved call path sets it.
 */
data class EmergencyCallState(
    val requested: Boolean = false,
    val mock: Boolean = true,
)
