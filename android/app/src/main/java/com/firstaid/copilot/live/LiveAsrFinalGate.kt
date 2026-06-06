package com.firstaid.copilot.live

internal class LiveAsrFinalGate(
    private val duplicateWindowMs: Long = DEFAULT_DUPLICATE_WINDOW_MS,
) {
    private var lastAcceptedText: String = ""
    private var lastAcceptedAtMs: Long = Long.MIN_VALUE

    fun shouldAccept(
        text: String,
        state: LiveUiState,
        nowMs: Long,
        intent: String? = null,
        confidence: Double? = null,
    ): Boolean {
        val normalized = normalizeAsrFinalForGate(text)
        if (normalized.isBlank()) return false
        if (
            state.isAssistantPlaybackBlocking() &&
            !shouldBypassPlaybackForCriticalAsrFinal(state, intent, confidence)
        ) {
            return false
        }
        if (
            normalized == lastAcceptedText &&
            nowMs >= lastAcceptedAtMs &&
            nowMs - lastAcceptedAtMs <= duplicateWindowMs
        ) {
            return false
        }
        lastAcceptedText = normalized
        lastAcceptedAtMs = nowMs
        return true
    }

    fun reset() {
        lastAcceptedText = ""
        lastAcceptedAtMs = Long.MIN_VALUE
    }

    companion object {
        private const val DEFAULT_DUPLICATE_WINDOW_MS = 4_000L
    }
}

internal fun shouldBypassPlaybackForCriticalAsrFinal(
    state: LiveUiState,
    intent: String?,
    confidence: Double?,
): Boolean =
    state.isAssistantPlaybackBlocking() &&
        state.currentStage == "S2_CHECK_RESPONSE" &&
        intent == "patient_unresponsive" &&
        (confidence ?: 0.0) >= CRITICAL_ASR_FINAL_CONFIDENCE

internal fun normalizeAsrFinalForGate(text: String): String =
    text.trim()
        .lowercase()
        .filterNot { it.isWhitespace() || it.isPunctuationLike() }

private fun Char.isPunctuationLike(): Boolean =
    Character.getType(this) in PUNCTUATION_OR_SYMBOL_TYPES

private fun LiveUiState.isAssistantPlaybackBlocking(): Boolean =
    micState == MicState.Speaking || isLiveAudioPlaying

private const val CRITICAL_ASR_FINAL_CONFIDENCE = 0.8

private val PUNCTUATION_OR_SYMBOL_TYPES = setOf(
    Character.CONNECTOR_PUNCTUATION.toInt(),
    Character.DASH_PUNCTUATION.toInt(),
    Character.START_PUNCTUATION.toInt(),
    Character.END_PUNCTUATION.toInt(),
    Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
    Character.FINAL_QUOTE_PUNCTUATION.toInt(),
    Character.OTHER_PUNCTUATION.toInt(),
    Character.MATH_SYMBOL.toInt(),
    Character.CURRENCY_SYMBOL.toInt(),
    Character.MODIFIER_SYMBOL.toInt(),
    Character.OTHER_SYMBOL.toInt(),
)
