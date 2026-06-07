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

    /**
     * Validate a PLAIN-TEXT open-question answer (功能 C 选定方案：模型只回一句话，结构
     * 由 harness 组装). The model returns one sentence; the harness assigns the primary
     * stage intent, wraps it as a GuidanceActionPatch, and reuses [validateOpenQuestion]
     * so the banned-word / stop-compression / length / allow-list grading is identical.
     * Robust if the model ignored the instruction and still emitted JSON: the answer
     * text is extracted from `tts.text` / `text` first.
     */
    fun validateOpenQuestionText(rawText: String, frame: OpenQuestionFrame): EdgeGuardDecision {
        if (frame.allowedIntents.isEmpty()) {
            return EdgeGuardDecision(accepted = false, reasons = listOf("no_allowed_intents"))
        }
        val answer = cleanAnswerText(rawText)
            ?: return EdgeGuardDecision(accepted = false, reasons = listOf("empty_answer"))
        lowQualityOpenQuestionReason(answer)?.let { reason ->
            return EdgeGuardDecision(accepted = false, reasons = listOf(reason))
        }
        val intent = frame.allowedIntents.first()
        val assembled = JSONObject()
            .put("intent", intent)
            .put("tts", JSONObject().put("text", answer))
            .toString()
        return validateOpenQuestion(assembled, frame)
    }

    /**
     * Validate a PLAIN-TEXT NLU label (功能 E 选定方案：模型只回一个标签). Matches the
     * cleaned label against [allowedIntents] and enforces the unconditional
     * `suspected_cardiac_arrest` red-line on the raw output. `confidence` is a fixed
     * "the model classified it" default since a single label carries no score.
     */
    fun validateNluText(rawText: String, allowedIntents: List<String>): EdgeNluDecision {
        if (allowedIntents.isEmpty()) {
            return EdgeNluDecision(accepted = false, reasons = listOf("no_allowed_intents"))
        }
        if (rawText.contains(SUSPECTED_CARDIAC_ARREST)) {
            return EdgeNluDecision(accepted = false, reasons = listOf("banned:$SUSPECTED_CARDIAC_ARREST"))
        }
        val cleaned = cleanLabelText(rawText)
            ?: return EdgeNluDecision(accepted = false, reasons = listOf("empty"))
        val matched = allowedIntents.firstOrNull { it.equals(cleaned, ignoreCase = true) }
            ?: allowedIntents.firstOrNull { cleaned.contains(it, ignoreCase = true) }
            ?: return EdgeNluDecision(accepted = false, reasons = listOf("intent_not_matched"))
        val clarify = matched.startsWith("clarify", ignoreCase = true)
        return EdgeNluDecision(
            accepted = true,
            intent = matched,
            confidence = if (clarify) 0.0 else NLU_LABEL_CONFIDENCE,
            needsClarification = clarify,
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

    /**
     * Reduce a model open-question output to the single sentence to speak. If the
     * model (wrongly) returned JSON, pull `tts.text` / `text`; otherwise strip code
     * fences + wrapping quotes and take the first non-empty line.
     */
    private fun cleanAnswerText(raw: String): String? {
        extractJson(raw)?.let { obj ->
            val viaTts = obj.optJSONObject("tts")?.optStringOrEmpty("text").orEmpty()
            val direct = obj.optStringOrEmpty("text").orEmpty()
            val value = viaTts.ifBlank { direct }.trim()
            if (value.isNotEmpty()) return value
        }
        return firstMeaningfulLine(raw)
    }

    private fun cleanLabelText(raw: String): String? = firstMeaningfulLine(raw)

    private fun lowQualityOpenQuestionReason(answer: String): String? {
        val compact = answer.replace(Regex("[\\s，。,.！？!、；;：:\"“”'「」]+"), "")
        if (compact.isBlank()) return "empty_answer"
        if (Regex("(保持呼吸|保持胸腔起伏|保持胸口起伏|维持呼吸|让他呼吸)").containsMatchIn(compact)) {
            return "misleading_breathing_wording"
        }
        if (Regex("(通知家属|告诉家属|联系家属|通知亲人|告诉亲人|联系亲人)").containsMatchIn(compact) &&
            !Regex("(旁人|别人|同伴|路人).{0,12}(通知|告诉|联系)(家属|亲人)|让.{0,6}(旁人|别人|同伴|路人).{0,12}(通知|告诉|联系)(家属|亲人)").containsMatchIn(compact)
        ) {
            return "unsafe_family_notice_wording"
        }
        if (Regex("^(继续按压|保持按压|别停)(不知道|不清楚|不确定|说不准)?$").containsMatchIn(compact)) {
            return "low_value_open_question_answer"
        }
        if (Regex("(不知道|不清楚|不确定|说不准|根据现场情况判断)").containsMatchIn(compact) && compact.length < 18) {
            return "low_value_open_question_answer"
        }
        return null
    }

    private fun firstMeaningfulLine(raw: String): String? {
        var text = raw.trim()
        if (text.startsWith("```")) text = text.trim('`').trim()
        return text.lineSequence()
            .map { it.trim().trim('"', '“', '”', '「', '」', '\'', ' ', '。', '，', '：') }
            .firstOrNull { it.isNotEmpty() }
    }

    private fun JSONObject.optStringOrEmpty(key: String): String? =
        if (has(key) && !isNull(key)) optString(key, "") else ""

    private companion object {
        val ALLOWED_TONES = setOf("calm_firm", "calm_soft", "urgent")

        /** Unconditional NLU red-line: the parser may never declare/diagnose arrest. */
        const val SUSPECTED_CARDIAC_ARREST = "suspected_cardiac_arrest"

        /** A single label carries no score; treat an accepted label as a confident hint. */
        const val NLU_LABEL_CONFIDENCE = 0.7

        /** Keys the NLU parser may never emit (mirrors the server forbidden set). */
        val DEFAULT_NLU_FORBIDDEN_KEYS = listOf(
            "stage", "next_stage", "tts", "ui", "tool_action", "tool_actions", "suspected_cardiac_arrest",
        )
    }
}
