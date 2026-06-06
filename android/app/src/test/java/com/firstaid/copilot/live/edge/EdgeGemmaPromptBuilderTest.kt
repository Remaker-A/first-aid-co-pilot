package com.firstaid.copilot.live.edge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The device-slimmed prompts inject only the minimal dynamic frame and ask for a
 * small JSON object; the heavy redundant blocks (full DecisionFrame/NluFrame JSON,
 * slot schema, numbered hard rules) are gone so the on-device model can actually
 * finish a generation. The hard safety rules are enforced by [EdgeGuidanceGuard].
 */
class EdgeGemmaPromptBuilderTest {

    private val builder = EdgeGemmaPromptBuilder()

    private fun frame(): OpenQuestionFrame =
        OpenQuestionFrame(
            stage = "S7_CPR_LOOP",
            userInput = "会不会把肋骨按断",
            allowedIntents = EdgeOpenQuestionPolicy.answerIntents("S7_CPR_LOOP"),
            safetyPhrases = EdgeOpenQuestionPolicy.safetyPhrases("S7_CPR_LOOP"),
            facts = linkedMapOf("adult_likely" to true, "cpr_started" to true, "quality_score" to 80),
        )

    @Test
    fun buildsSystemAndUserSectionsWithFrameFields() {
        val prompt = builder.openQuestionPrompt(frame())

        assertTrue(prompt.startsWith("SYSTEM:"))
        assertTrue(prompt.contains("受控问答"))
        assertTrue(prompt.contains("USER:"))
        assertTrue(prompt.contains("[Stage]"))
        assertTrue(prompt.contains("S7_CPR_LOOP"))
        assertTrue(prompt.contains("[Allowed Intents]"))
        assertTrue(prompt.contains("answer_current_cpr_question"))
        // Only the first safety phrase is injected (slimmed from the full list).
        assertTrue(prompt.contains("[Safety Phrase]"))
        assertTrue(prompt.contains("双手掌根放在胸口中央。"))
        assertTrue(prompt.contains("[User Input]"))
        assertTrue(prompt.contains("会不会把肋骨按断"))
        // Asks for the slim {intent, tts.text} JSON only.
        assertTrue(prompt.contains("\"intent\""))
        assertTrue(prompt.contains("\"tts\""))
    }

    @Test
    fun openQuestionPromptIsSlimmedOfRedundantBlocks() {
        val prompt = builder.openQuestionPrompt(frame())
        // The redundant full-frame dump and verbose blocks must be gone so prefill
        // stays small enough for an on-device generation to return.
        assertFalse(prompt.contains("[DecisionFrame JSON]"))
        assertFalse(prompt.contains("\"current_stage\""))
        assertFalse(prompt.contains("[Confirmed Facts]"))
        // Sanity bound: the whole prompt stays compact.
        assertTrue("prompt should be small: ${prompt.length}", prompt.length < 700)
    }

    @Test
    fun forbidsStateAndToolFieldsInContract() {
        val prompt = builder.openQuestionPrompt(frame())
        // The SYSTEM contract still tells the model not to drive flow or call tools.
        assertTrue(prompt.contains("不切换 stage"))
        assertTrue(prompt.contains("tool_actions"))
    }

    @Test
    fun defaultsStageWhenNull() {
        val prompt = builder.openQuestionPrompt(
            OpenQuestionFrame(stage = null, userInput = "怎么办", allowedIntents = listOf("calm_rescuer")),
        )
        assertTrue(prompt.contains("S7_CPR_LOOP"))
        assertTrue(prompt.contains("怎么办"))
    }

    @Test
    fun nluPromptIsSlimAndAsksForIntentJson() {
        val prompt = builder.nluPrompt(
            stage = "S3_CHECK_BREATHING",
            transcript = "他没有正常呼吸，只是偶尔喘一下",
            allowedIntents = listOf("no_normal_breathing", "agonal_breathing", "clarify_breathing"),
        )

        assertTrue(prompt.startsWith("SYSTEM:"))
        assertTrue(prompt.contains("呼吸观察"))
        assertTrue(prompt.contains("[Transcript]"))
        assertTrue(prompt.contains("他没有正常呼吸，只是偶尔喘一下"))
        assertTrue(prompt.contains("agonal_breathing"))
        assertTrue(prompt.contains("needs_clarification"))
        // Slimmed away: slot schema, escalation markers, and the full frame dump.
        assertFalse(prompt.contains("[Slots Schema]"))
        assertFalse(prompt.contains("[NluFrame JSON]"))
        assertFalse(prompt.contains("escalation_markers"))
        assertTrue("nlu prompt should be small: ${prompt.length}", prompt.length < 600)
    }
}
