package com.firstaid.copilot.live.edge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The device prompts ask for the smallest possible output: the open-question
 * prompt asks for ONE plain Chinese sentence (no JSON), and the NLU prompt asks
 * for ONE intent label. The heavy redundant blocks (full frame JSON, slot schema,
 * numbered hard rules) are gone, and the JSON scaffolding the model used to emit
 * (which inflated on-device latency ~2.7x) is no longer requested. The hard
 * safety rules are enforced by [EdgeGuidanceGuard] after generation.
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
        assertTrue(prompt.contains("[Safety Phrase]"))
        assertTrue(prompt.contains("双手掌根放在胸口中央。"))
        assertTrue(prompt.contains("[User Input]"))
        assertTrue(prompt.contains("会不会把肋骨按断"))
        assertTrue(prompt.contains("[Answer Focus]"))
        // Asks for one plain sentence, and in a CPR-live stage tells it to keep compressions.
        assertTrue(prompt.contains("只回一句中文"))
        assertTrue(prompt.contains("继续按压"))
        assertTrue(prompt.contains("具体作答"))
    }

    @Test
    fun openQuestionPromptIsPlainTextNotJson() {
        val prompt = builder.openQuestionPrompt(frame())
        // The model is told NOT to emit JSON; the harness owns the structure.
        assertTrue(prompt.contains("不要 JSON"))
        assertFalse(prompt.contains("\"tts\""))
        assertFalse(prompt.contains("[DecisionFrame JSON]"))
        assertFalse(prompt.contains("[Confirmed Facts]"))
        assertTrue("prompt should be small: ${prompt.length}", prompt.length < 850)
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
    fun nluPromptAsksForSingleLabel() {
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
        assertTrue(prompt.contains("[候选标签]"))
        assertTrue(prompt.contains("只输出"))
        // Single-label out: no JSON object and no heavy frame blocks.
        assertFalse(prompt.contains("{"))
        assertFalse(prompt.contains("[Slots Schema]"))
        assertTrue("nlu prompt should be small: ${prompt.length}", prompt.length < 600)
    }
}
