package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the Phase D proactive coach: stage eligibility, the hard
 * speech gate, cooldown / post-high-priority quiet windows, the hand-switch / AED
 * / reassurance cadence (driven by cprStartedAtMs / qualityScore / stage), the
 * fixed precedence, and the local safety check applied to polished text.
 */
class ProactiveCoachTest {

    private val cprStart = 1_000_000L

    private fun state(
        stage: String = "S7_CPR_LOOP",
        cprStartedAtMs: Long? = cprStart,
        qualityScore: Int? = null,
        isLiveAudioPlaying: Boolean = false,
        suppressLocalTts: Boolean = false,
        micState: MicState = MicState.Listening,
        isInFlight: Boolean = false,
        ttsPriority: String? = null,
        visualOverlayMode: String? = null,
        openQuestionPhase: OpenQuestionPhase = OpenQuestionPhase.Idle,
        pendingConfirmation: ToolConfirmationState? = null,
        emergencyRequested: Boolean = false,
    ): LiveUiState = LiveUiState(
        currentStage = stage,
        cprStartedAtMs = cprStartedAtMs,
        qualityScore = qualityScore,
        isLiveAudioPlaying = isLiveAudioPlaying,
        suppressLocalTts = suppressLocalTts,
        micState = micState,
        isInFlight = isInFlight,
        ttsPriority = ttsPriority,
        visualOverlayMode = visualOverlayMode,
        openQuestionPhase = openQuestionPhase,
        pendingConfirmation = pendingConfirmation,
        emergencyCall = EmergencyCallState(requested = emergencyRequested),
    )

    private fun emit(decision: ProactiveDecision): ProactiveDecision.Emit {
        assertTrue("expected Emit but was $decision", decision is ProactiveDecision.Emit)
        return decision as ProactiveDecision.Emit
    }

    private fun skipReason(decision: ProactiveDecision): String {
        assertTrue("expected Skip but was $decision", decision is ProactiveDecision.Skip)
        return (decision as ProactiveDecision.Skip).reason
    }

    // --- Stage eligibility ---------------------------------------------------

    @Test
    fun ineligibleStageSkips() {
        val decision = decideProactiveCue(
            state(stage = "S6_CPR_READY"),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("stage_ineligible", skipReason(decision))
    }

    @Test
    fun s8AssistanceIsEligible() {
        // No AED overlay in S8 (still fetching one), 2 min elapsed -> a cue is due.
        val decision = decideProactiveCue(
            state(stage = "S8_ASSISTANCE", visualOverlayMode = "rescuer_assistance"),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertTrue(decision is ProactiveDecision.Emit)
    }

    // --- Hard speech gate (never talk over anything) -------------------------

    @Test
    fun liveAudioPlayingBlocks() {
        val decision = decideProactiveCue(
            state(isLiveAudioPlaying = true),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("live_audio_playing", skipReason(decision))
    }

    @Test
    fun suppressLocalTtsBlocks() {
        val decision = decideProactiveCue(
            state(suppressLocalTts = true),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("suppress_local_tts", skipReason(decision))
    }

    @Test
    fun speakingBlocks() {
        val decision = decideProactiveCue(
            state(micState = MicState.Speaking),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("mic_speaking", skipReason(decision))
    }

    @Test
    fun inFlightTurnBlocks() {
        val decision = decideProactiveCue(
            state(isInFlight = true),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("turn_in_flight", skipReason(decision))
    }

    @Test
    fun openQuestionBlocks() {
        val decision = decideProactiveCue(
            state(openQuestionPhase = OpenQuestionPhase.Answer),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("open_question", skipReason(decision))
    }

    @Test
    fun criticalPriorityBlocks() {
        val decision = decideProactiveCue(
            state(ttsPriority = "critical"),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("critical_priority", skipReason(decision))
    }

    @Test
    fun pendingConfirmationBlocks() {
        val decision = decideProactiveCue(
            state(pendingConfirmation = ToolConfirmationState(toolType = "share_report", title = "x")),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("pending_confirmation", skipReason(decision))
    }

    @Test
    fun emergencyCallBlocks() {
        val decision = decideProactiveCue(
            state(emergencyRequested = true),
            ProactiveCoachState(),
            cprStart + 130_000,
        )
        assertEquals("emergency_call", skipReason(decision))
    }

    // --- Cooldown & post-high-priority quiet ---------------------------------

    @Test
    fun globalCooldownSkips() {
        val now = cprStart + 130_000
        val decision = decideProactiveCue(
            state(),
            ProactiveCoachState(lastCueAtMs = now - (PROACTIVE_GLOBAL_COOLDOWN_MS - 1)),
            now,
        )
        assertEquals("cooldown", skipReason(decision))
    }

    @Test
    fun postHighPriorityQuietSkips() {
        val now = cprStart + 130_000
        val decision = decideProactiveCue(
            state(),
            ProactiveCoachState(lastHighPriorityAtMs = now - (PROACTIVE_POST_HIGH_PRIORITY_QUIET_MS - 1)),
            now,
        )
        assertEquals("post_high_priority", skipReason(decision))
    }

    @Test
    fun cooldownElapsedAllowsCue() {
        val now = cprStart + 130_000
        val decision = decideProactiveCue(
            state(),
            ProactiveCoachState(lastCueAtMs = now - PROACTIVE_GLOBAL_COOLDOWN_MS),
            now,
        )
        assertTrue(decision is ProactiveDecision.Emit)
    }

    // --- AED reminder --------------------------------------------------------

    @Test
    fun aedReminderFiresAfterThreshold() {
        val now = cprStart + AED_FIRST_MS
        val result = emit(decideProactiveCue(state(), ProactiveCoachState(), now))
        assertEquals(ProactiveCueKind.AedReminder, result.cue.kind)
        assertEquals(now, result.state.lastCueAtMs)
        assertEquals(now, result.state.lastAedReminderAtMs)
        assertEquals(1, result.state.aedReminderCount)
        assertTrue(isProactiveTextSafe(result.cue.text))
    }

    @Test
    fun aedReminderSuppressedWhenAedPresent() {
        // AED overlay present + only 50s elapsed -> AED suppressed, reassurance wins.
        val result = emit(
            decideProactiveCue(
                state(visualOverlayMode = "aed_assistance"),
                ProactiveCoachState(),
                cprStart + 50_000,
            ),
        )
        assertEquals(ProactiveCueKind.Reassure, result.cue.kind)
    }

    @Test
    fun aedReminderCappedAtMax() {
        // Max reminders already sent, no hand-switch yet (60s), quality ok -> reassure.
        val result = emit(
            decideProactiveCue(
                state(qualityScore = 70),
                ProactiveCoachState(aedReminderCount = AED_MAX_REMINDERS),
                cprStart + 60_000,
            ),
        )
        assertEquals(ProactiveCueKind.Reassure, result.cue.kind)
    }

    @Test
    fun aedReminderRespectsInterval() {
        val now = cprStart + 60_000
        // Last AED reminder was just sent and cap not reached; spacing too tight.
        val decision = decideProactiveCue(
            state(
                qualityScore = 30, // poor -> no reassurance either
                visualOverlayMode = null,
            ),
            ProactiveCoachState(
                lastCueAtMs = now - PROACTIVE_GLOBAL_COOLDOWN_MS,
                lastAedReminderAtMs = now - (AED_INTERVAL_MS - 1),
                aedReminderCount = 1,
            ),
            now,
        )
        assertEquals("nothing_due", skipReason(decision))
    }

    // --- Hand switch ---------------------------------------------------------

    @Test
    fun handSwitchFiresAtTwoMinutes() {
        // AED overlay present -> AED suppressed so we observe the hand-switch path.
        val now = cprStart + HAND_SWITCH_FIRST_MS
        val result = emit(
            decideProactiveCue(state(visualOverlayMode = "aed_assistance"), ProactiveCoachState(), now),
        )
        assertEquals(ProactiveCueKind.HandSwitch, result.cue.kind)
        assertEquals(now, result.state.lastHandSwitchAtMs)
        assertEquals(1, result.state.handSwitchCount)
        assertTrue(isProactiveTextSafe(result.cue.text))
    }

    @Test
    fun handSwitchFiresEarlyOnFatigue() {
        // 90s + low quality (fatigue) triggers an early switch before the 2-min mark.
        val result = emit(
            decideProactiveCue(
                state(qualityScore = 50, visualOverlayMode = "aed_assistance"),
                ProactiveCoachState(),
                cprStart + HAND_SWITCH_FATIGUE_MIN_MS,
            ),
        )
        assertEquals(ProactiveCueKind.HandSwitch, result.cue.kind)
    }

    @Test
    fun handSwitchNotPrematureWithGoodQuality() {
        // 100s, good quality, AED suppressed -> no hand-switch yet, reassurance instead.
        val result = emit(
            decideProactiveCue(
                state(qualityScore = 80, visualOverlayMode = "aed_assistance"),
                ProactiveCoachState(),
                cprStart + 100_000,
            ),
        )
        assertEquals(ProactiveCueKind.Reassure, result.cue.kind)
    }

    @Test
    fun handSwitchTextAlternatesByCount() {
        val now = cprStart + HAND_SWITCH_FIRST_MS
        val first = emit(
            decideProactiveCue(state(visualOverlayMode = "aed_assistance"), ProactiveCoachState(handSwitchCount = 0), now),
        ).cue.text
        val second = emit(
            decideProactiveCue(state(visualOverlayMode = "aed_assistance"), ProactiveCoachState(handSwitchCount = 1), now),
        ).cue.text
        assertNotEquals(first, second)
        assertTrue(isProactiveTextSafe(first))
        assertTrue(isProactiveTextSafe(second))
    }

    // --- Reassurance ---------------------------------------------------------

    @Test
    fun reassureNeutralWhenQualityModerate() {
        val result = emit(
            decideProactiveCue(
                state(qualityScore = 60, visualOverlayMode = "aed_assistance"),
                ProactiveCoachState(),
                cprStart + REASSURE_FIRST_MS,
            ),
        )
        assertEquals(ProactiveCueKind.Reassure, result.cue.kind)
        assertEquals("保持这个节奏，继续用力快压。", result.cue.text)
        assertEquals("calm_soft", result.cue.tone)
    }

    @Test
    fun reassurePraisesWhenQualityHigh() {
        val result = emit(
            decideProactiveCue(
                state(qualityScore = 90, visualOverlayMode = "aed_assistance"),
                ProactiveCoachState(),
                cprStart + REASSURE_FIRST_MS,
            ),
        )
        assertEquals(ProactiveCueKind.Reassure, result.cue.kind)
        assertTrue(result.cue.text.contains("你做得很好"))
    }

    @Test
    fun reassureSkippedWhenQualityPoor() {
        // Poor quality + AED suppressed + before hand-switch window -> stay quiet.
        val decision = decideProactiveCue(
            state(qualityScore = 40, visualOverlayMode = "aed_assistance"),
            ProactiveCoachState(),
            cprStart + 60_000,
        )
        assertEquals("nothing_due", skipReason(decision))
    }

    // --- Precedence ----------------------------------------------------------

    @Test
    fun aedOutranksHandSwitchAndReassure() {
        // All three are "due" at 130s with no AED present; AED wins.
        val result = emit(decideProactiveCue(state(), ProactiveCoachState(), cprStart + 130_000))
        assertEquals(ProactiveCueKind.AedReminder, result.cue.kind)
    }

    @Test
    fun handSwitchOutranksReassure() {
        val result = emit(
            decideProactiveCue(state(visualOverlayMode = "aed_assistance"), ProactiveCoachState(), cprStart + 130_000),
        )
        assertEquals(ProactiveCueKind.HandSwitch, result.cue.kind)
    }

    @Test
    fun cueIdEncodesKind() {
        val result = emit(decideProactiveCue(state(), ProactiveCoachState(), cprStart + AED_FIRST_MS))
        assertTrue(result.cue.id.startsWith("proactive-aedreminder-"))
    }

    // --- Local safety check (guards polished output) -------------------------

    @Test
    fun safetyRejectsBlankTooLongAndForbidden() {
        assertFalse(isProactiveTextSafe("   "))
        assertFalse(isProactiveTextSafe("啊".repeat(PROACTIVE_TEXT_MAX_CHARS + 1)))
        assertFalse(isProactiveTextSafe("现在可以停了，先休息一下。"))
        assertFalse(isProactiveTextSafe("不用担心，没事的。"))
        assertFalse(isProactiveTextSafe("这是心梗，别按了。"))
    }

    @Test
    fun safetyAcceptsCalmShortGuidance() {
        assertTrue(isProactiveTextSafe("旁边有人就换手，继续用力快压。"))
    }
}
