package com.firstaid.copilot.live.edge

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** A guard verdict over one controlled open-question answer. */
data class EdgeGuardDecision(
    val accepted: Boolean,
    val intent: String = "",
    val ttsText: String = "",
    val mainText: String = "",
    val secondaryText: String = "",
    val tone: String = DEFAULT_TONE,
    val reasons: List<String> = emptyList(),
) {
    companion object {
        const val DEFAULT_TONE = "calm_firm"
    }
}

/** A guard verdict over one NLU observation parse. */
data class EdgeNluDecision(
    val accepted: Boolean,
    val intent: String = "",
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false,
    val reasons: List<String> = emptyList(),
)

/**
 * Production safety gate for the edge Gemma outputs.
 *
 * The benchmark grader [GemmaSuiteAsserts] is the single source of truth for the
 * scoring logic (banned medical substrings, the "never stop compressions" rule,
 * the per-stage `allowed_intents` allow-list, the answer length cap, and the NLU
 * forbidden-key / suspected_cardiac_arrest red-lines). This class is the
 * *production entry point* the plan calls for ("逻辑不变，新增一个生产入口"): it
 * constructs the same `expected` contract the grader cases use, runs the grader,
 * and — on pass — extracts the validated fields the live path needs. The grading
 * logic itself is unchanged.
 */
class EdgeGuidanceGuard(
    private val bannedSubstrings: List<String> = EdgeOpenQuestionPolicy.BANNED_SUBSTRINGS,
    private val maxTtsChars: Int = EdgeOpenQuestionPolicy.MAX_TTS_CHARS,
    private val nluForbiddenKeys: List<String> = DEFAULT_NLU_FORBIDDEN_KEYS,
) {
    fun validateOpenQuestion(modelOutput: String, frame: OpenQuestionFrame): EdgeGuardDecision {
        if (frame.allowedIntents.isEmpty()) {
            return EdgeGuardDecision(accepted = false, reasons = listOf("no_allowed_intents"))
        }

        val expected = JSONObject()
            .put("kind", "guidance_patch")
            .put("allowedIntents", JSONArray(frame.allowedIntents))
            .put("requireTtsText", true)
            .put("maxTtsChars", maxTtsChars)
            .put("bannedSubstrings", JSONArray(bannedSubstrings))
            // Never let the answer tell the rescuer to stop compressions in CPR-live.
            .put("forbidStopCompressionWords", EdgeOpenQuestionPolicy.isCprLiveStage(frame.stage))
            // The open-question exception must produce a real controlled answer.
            .put("allowFallbackIntent", false)

        val verdict = GemmaSuiteAsserts.evaluate(expected, modelOutput)
        if (!verdict.pass) {
            return EdgeGuardDecision(accepted = false, reasons = rejectionReasons(verdict))
        }

        val parsed = extractJson(modelOutput)
            ?: return EdgeGuardDecision(accepted = false, reasons = listOf("json_parse_failed"))

        val ttsText = parsed.optJSONObject("tts")?.optStringOrEmpty("text").orEmpty().trim()
        // The grader treats a few intents as tts-optional, but an open question
        // must yield something to speak; an empty answer falls back deterministically.
        if (ttsText.isEmpty()) {
            return EdgeGuardDecision(accepted = false, reasons = listOf("missing_tts_text"))
        }

        val ui = parsed.optJSONObject("ui")
        val tone = parsed.optJSONObject("tts")?.optStringOrEmpty("tone").orEmpty()
        return EdgeGuardDecision(
            accepted = true,
            intent = parsed.optStringOrEmpty("intent").orEmpty(),
            ttsText = ttsText,
            mainText = ui?.optStringOrEmpty("main_text").orEmpty(),
            secondaryText = ui?.optStringOrEmpty("secondary_text").orEmpty(),
            tone = if (tone in ALLOWED_TONES) tone else EdgeGuardDecision.DEFAULT_TONE,
        )
    }

    /**
     * Validate an NLU observation parse against [allowedIntents]. Production never
     * knows the "correct" slot values up front, so `requireSlots` is omitted — the
     * grader still enforces the allow-list, the forbidden keys, and the
     * unconditional `suspected_cardiac_arrest` raw guard. Clarification is accepted
     * (an ambiguous reading must not be promoted into a hard intent by the caller).
     */
    fun validateNlu(modelOutput: String, allowedIntents: List<String>): EdgeNluDecision {
        if (allowedIntents.isEmpty()) {
            return EdgeNluDecision(accepted = false, reasons = listOf("no_allowed_intents"))
        }

        val expected = JSONObject()
            .put("kind", "nlu")
            .put("allowedIntents", JSONArray(allowedIntents))
            .put("forbidKeys", JSONArray(nluForbiddenKeys))
            .put("acceptNeedsClarification", true)

        val verdict = GemmaSuiteAsserts.evaluate(expected, modelOutput)
        if (!verdict.pass) {
            return EdgeNluDecision(accepted = false, reasons = rejectionReasons(verdict))
        }

        val parsed = extractJson(modelOutput)
            ?: return EdgeNluDecision(accepted = false, reasons = listOf("json_parse_failed"))

        return EdgeNluDecision(
            accepted = true,
            intent = parsed.optStringOrEmpty("intent").orEmpty(),
            confidence = parsed.optDouble("overall_confidence", 0.0),
            needsClarification = parsed.optBoolean("needs_clarification", false),
        )
    }

    private fun rejectionReasons(verdict: GemmaAssertResult): List<String> =
        buildList {
            if (!verdict.parseOk) add("json_parse_failed")
            addAll(verdict.failures)
            addAll(verdict.bannedHits.map { "banned:$it" })
        }.distinct().ifEmpty { listOf("rejected") }

    private fun extractJson(raw: String): JSONObject? {
        val start = raw.indexOf('{')
        val end = raw.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return try {
            JSONObject(raw.substring(start, end + 1))
        } catch (error: JSONException) {
            null
        }
    }

    private fun JSONObject.optStringOrEmpty(key: String): String? =
        if (has(key) && !isNull(key)) optString(key, "") else ""

    private companion object {
        val ALLOWED_TONES = setOf("calm_firm", "calm_soft", "urgent")

        /** Keys the NLU parser may never emit (mirrors the server forbidden set). */
        val DEFAULT_NLU_FORBIDDEN_KEYS = listOf(
            "stage", "next_stage", "tts", "ui", "tool_action", "tool_actions", "suspected_cardiac_arrest",
        )
    }
}
