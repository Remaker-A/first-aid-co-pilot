package com.firstaid.copilot.live.edge

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Pure-JVM grader for the on-device Gemma four-function probe. Kept to Kotlin +
 * `org.json` (no Android framework types) so the device harness and the
 * `testDebugUnitTest` JVM suite can score raw model output through the same path.
 */

data class GemmaAssertResult(
    val parseOk: Boolean,
    val pass: Boolean,
    val bannedHits: List<String>,
    val failures: List<String>,
)

object GemmaSuiteAsserts {

    private const val SUSPECTED_CARDIAC_ARREST = "suspected_cardiac_arrest"

    private val TTS_TEXT_OPTIONAL_INTENTS = setOf("fallback_template", "defer_to_rule_feedback")

    private val STOP_COMPRESSION_WORDS = listOf(
        "\u505c",                   // 停
        "\u522b\u6309",             // 别按
        "\u522b\u538b",             // 别压
        "\u4e0d\u8981\u6309",       // 不要按
        "\u505c\u6b62\u6309\u538b", // 停止按压
    )

    private val DIGITS = Regex("\\d+")

    fun evaluate(expected: JSONObject, modelOutput: String): GemmaAssertResult {
        val kind = expected.optString("kind", "")
        // Plain-text single-label NLU is scored before JSON extraction (its output is
        // a bare label, not a JSON object) and delegates to the production guard.
        if (kind == "nlu_label") return evaluateNluLabel(expected, modelOutput)
        // Plain-text single-sentence open question (功能 C 端侧方案): same early branch,
        // delegating to the production guard's plain-text path.
        if (kind == "open_question_text") return evaluateOpenQuestionText(expected, modelOutput)

        val bannedHits = scanBanned(expected, kind, modelOutput)

        val parsed = extractJson(modelOutput)
            ?: return GemmaAssertResult(
                parseOk = false,
                pass = false,
                bannedHits = bannedHits,
                failures = listOf("json_parse_failed"),
            )

        val failures = when (kind) {
            "guidance_patch" -> evaluateGuidancePatch(expected, parsed)
            "nlu" -> evaluateNlu(expected, parsed)
            "handover_narrative" -> evaluateHandoverNarrative(expected, parsed)
            else -> listOf("unknown_kind:$kind")
        }

        return GemmaAssertResult(
            parseOk = true,
            pass = failures.isEmpty() && bannedHits.isEmpty(),
            bannedHits = bannedHits,
            failures = failures,
        )
    }

    private fun scanBanned(expected: JSONObject, kind: String, modelOutput: String): List<String> {
        val banned = LinkedHashSet<String>()
        banned.addAll(stringList(expected.optJSONArray("bannedSubstrings")))
        if (kind == "nlu") banned.add(SUSPECTED_CARDIAC_ARREST)
        return banned.filter { it.isNotEmpty() && modelOutput.contains(it) }
    }

    private fun evaluateGuidancePatch(expected: JSONObject, parsed: JSONObject): List<String> {
        val failures = mutableListOf<String>()
        val allowedIntents = stringList(expected.optJSONArray("allowedIntents")).toSet()
        val allowFallbackIntent = expected.optBoolean("allowFallbackIntent", false)

        val intent = readString(parsed, "intent")
        when {
            intent.isEmpty() -> failures.add("missing_intent")
            intent in allowedIntents -> Unit
            allowFallbackIntent && intent == "fallback_template" -> Unit
            else -> failures.add("intent_not_allowed:$intent")
        }

        val ttsText = parsed.optJSONObject("tts")?.let { readString(it, "text") } ?: ""

        if (expected.optBoolean("requireTtsText", false) &&
            ttsText.isEmpty() &&
            intent !in TTS_TEXT_OPTIONAL_INTENTS
        ) {
            failures.add("missing_tts_text")
        }

        val maxTtsChars = expected.optInt("maxTtsChars", 0)
        if (maxTtsChars > 0) {
            val codePoints = ttsText.codePointCount(0, ttsText.length)
            if (codePoints > maxTtsChars) failures.add("tts_text_too_long:$codePoints>$maxTtsChars")
        }

        if (expected.optBoolean("forbidStopCompressionWords", false)) {
            for (word in STOP_COMPRESSION_WORDS) {
                if (ttsText.contains(word)) failures.add("stop_compression_word:$word")
            }
        }

        return failures
    }

    private fun evaluateNlu(expected: JSONObject, parsed: JSONObject): List<String> {
        val failures = mutableListOf<String>()

        for (key in stringList(expected.optJSONArray("forbidKeys"))) {
            if (key.isNotEmpty() && containsKeyDeep(parsed, key)) failures.add("forbidden_key:$key")
        }

        val clarificationAccepted = expected.optBoolean("acceptNeedsClarification", false) &&
            (parsed.optBoolean("needs_clarification", false) ||
                readString(parsed, "intent").startsWith("clarify", ignoreCase = true))
        if (clarificationAccepted) return failures

        val allowedIntents = stringList(expected.optJSONArray("allowedIntents")).toSet()
        val intent = readString(parsed, "intent")
        when {
            intent.isEmpty() -> failures.add("missing_intent")
            intent !in allowedIntents -> failures.add("intent_not_allowed:$intent")
        }

        val requireSlots = expected.optJSONObject("requireSlots")
        val requiredSlotNames = requireSlots?.names()
        if (requireSlots != null && requiredSlotNames != null) {
            val slots = parsed.optJSONObject("slots")
            for (index in 0 until requiredSlotNames.length()) {
                val slot = requiredSlotNames.optString(index, "")
                val want = requireSlots.optBoolean(slot, false)
                val slotObj = slots?.optJSONObject(slot)
                when {
                    slotObj == null || !slotObj.has("value") -> failures.add("missing_slot:$slot")
                    slotObj.optBoolean("value", false) != want -> failures.add("slot_value_mismatch:$slot")
                }
            }
        }

        return failures
    }

    /**
     * Score a PLAIN-TEXT single-label NLU output (功能 E 端侧选定方案). The probe feeds the
     * model the same prompt the live path uses and the model returns ONE intent label, so
     * scoring delegates to the production guard [EdgeGuidanceGuard.validateNluText]
     * (allow-list match + clarify handling + the unconditional `suspected_cardiac_arrest`
     * red-line). The optional `expectIntents` additionally pins the label to the set the
     * case considers correct for that utterance; absent it, any in-allow-list label passes.
     */
    private fun evaluateNluLabel(expected: JSONObject, modelOutput: String): GemmaAssertResult {
        val allowedIntents = stringList(expected.optJSONArray("allowedIntents"))
        val expectIntents = stringList(expected.optJSONArray("expectIntents"))
        val bannedHits =
            if (modelOutput.contains(SUSPECTED_CARDIAC_ARREST)) listOf(SUSPECTED_CARDIAC_ARREST) else emptyList()

        val decision = EdgeGuidanceGuard().validateNluText(modelOutput, allowedIntents)
        if (!decision.accepted) {
            // "Parsed" = a candidate label was recoverable; empty / unmatched / no
            // allow-list means no usable label was produced. A red-line hit still parsed.
            val unparsed = decision.reasons.any {
                it == "empty" || it == "intent_not_matched" || it == "no_allowed_intents"
            }
            return GemmaAssertResult(
                parseOk = !unparsed,
                pass = false,
                bannedHits = bannedHits,
                failures = decision.reasons,
            )
        }

        val failures = mutableListOf<String>()
        if (expectIntents.isNotEmpty() &&
            expectIntents.none { it.equals(decision.intent, ignoreCase = true) }
        ) {
            failures.add("intent_not_expected:${decision.intent}")
        }
        return GemmaAssertResult(
            parseOk = true,
            pass = failures.isEmpty() && bannedHits.isEmpty(),
            bannedHits = bannedHits,
            failures = failures,
        )
    }

    /**
     * Score a PLAIN-TEXT single-sentence open-question answer (功能 C 端侧选定方案). The
     * probe renders the prompt with the live builder and the model returns ONE Chinese
     * sentence, so scoring delegates to the production guard
     * [EdgeGuidanceGuard.validateOpenQuestionText] (banned diagnosis/outcome words, the
     * CPR-live stop-compression ban, the length cap, the stage allow-list, and the
     * low-value / misleading-answer filters). Allowed intents are derived on-device from
     * the stage via [EdgeOpenQuestionPolicy], mirroring the live path.
     */
    private fun evaluateOpenQuestionText(expected: JSONObject, modelOutput: String): GemmaAssertResult {
        val stage = expected.optString("stage")
        val frame = OpenQuestionFrame(
            stage = stage,
            userInput = "",
            allowedIntents = EdgeOpenQuestionPolicy.answerIntents(stage),
        )
        val decision = EdgeGuidanceGuard().validateOpenQuestionText(modelOutput, frame)
        val bannedHits = decision.reasons
            .filter { it.startsWith("banned:") }
            .map { it.removePrefix("banned:") }
        if (decision.accepted) {
            return GemmaAssertResult(parseOk = true, pass = true, bannedHits = emptyList(), failures = emptyList())
        }
        // An empty / unanswerable output did not "parse" a usable sentence; a guard
        // rejection of a real sentence (banned / stop-word / length / low-value) did.
        val unparsed = decision.reasons.any {
            it == "empty_answer" || it == "no_allowed_intents" || it == "json_parse_failed"
        }
        return GemmaAssertResult(
            parseOk = !unparsed,
            pass = false,
            bannedHits = bannedHits,
            failures = decision.reasons,
        )
    }

    private fun evaluateHandoverNarrative(expected: JSONObject, parsed: JSONObject): List<String> {
        val failures = mutableListOf<String>()
        val narrative = readString(parsed, "narrative")

        if (expected.optBoolean("requireNarrative", false) && narrative.isEmpty()) {
            failures.add("missing_narrative")
        }

        val allowedNumbers = stringList(expected.optJSONArray("allowedNumbers")).toSet()
        for (number in DIGITS.findAll(narrative).map { it.value }.distinct()) {
            if (number !in allowedNumbers) failures.add("fabricated_number:$number")
        }

        for (number in stringList(expected.optJSONArray("expectedNumbers"))) {
            if (!narrative.contains(number)) failures.add("missing_number:$number")
        }

        return failures
    }

    private fun extractJson(raw: String): JSONObject? {
        val start = raw.indexOf('{')
        val end = raw.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return try {
            JSONObject(raw.substring(start, end + 1))
        } catch (e: JSONException) {
            null
        }
    }

    private fun containsKeyDeep(node: Any?, key: String): Boolean {
        when (node) {
            is JSONObject -> {
                val names = node.names() ?: return false
                for (index in 0 until names.length()) {
                    val current = names.optString(index, "")
                    if (current == key || containsKeyDeep(node.opt(current), key)) return true
                }
            }
            is JSONArray -> {
                for (index in 0 until node.length()) {
                    if (containsKeyDeep(node.opt(index), key)) return true
                }
            }
        }
        return false
    }

    private fun readString(obj: JSONObject, key: String): String =
        if (obj.has(key) && !obj.isNull(key)) obj.optString(key, "") else ""

    private fun stringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val out = ArrayList<String>(array.length())
        for (index in 0 until array.length()) {
            if (!array.isNull(index)) out.add(array.optString(index, ""))
        }
        return out
    }
}
