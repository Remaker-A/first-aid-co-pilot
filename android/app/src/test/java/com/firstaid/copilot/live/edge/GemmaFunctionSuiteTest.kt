package com.firstaid.copilot.live.edge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM unit tests for [GemmaSuiteAsserts]. They feed *fake* model output strings
 * plus hand-built `expected` specs so the scorer can be proven correct without a real
 * device or a real model. Framework mirrors the sibling JUnit4 tests in this package.
 *
 * The `expected` JSONObject is the per-case scoring spec emitted by the fixtures builder.
 * It self-describes which scorer to run via a `kind` discriminator
 * (`guidance_patch` / `nlu` / `handover_narrative`), matching the contract:
 *   - guidance_patch: allowedIntents, requireTtsText, maxTtsChars(0=skip), bannedSubstrings,
 *                     forbidStopCompressionWords, allowFallbackIntent
 *   - nlu:            allowedIntents, requireSlots{slot:boolean}, forbidKeys, acceptNeedsClarification
 *   - handover_narrative: requireNarrative, allowedNumbers, expectedNumbers, bannedSubstrings
 */
class GemmaFunctionSuiteTest {

    private val guidanceAllowed = listOf("guide_cpr_position", "answer_position_question", "encourage_rescuer")
    private val guidanceBanned = listOf("心梗", "脑卒中", "他已经心脏骤停了", "一定能救活")
    private val openQuestionAllowed = listOf("answer_safety_question", "encourage_rescuer", "continue_cpr")
    private val nluAllowed = listOf("report_breathing_status", "report_patient_state", "needs_clarification")
    private val nluForbid = listOf("suspected_cardiac_arrest", "stage", "tts", "ui", "visual_overlay")

    // Single-label NLU (功能 E 端侧方案): the candidate label set + the per-case expected
    // subset, mirroring assets/gemma_suite/nlu_main.json + nlu_boundary.json.
    private val breathingCandidates = listOf(
        "no_normal_breathing", "normal_breathing", "normal_breathing_absent",
        "normal_breathing_present", "agonal_breathing", "clarify_breathing",
    )
    private val mainExpectIntents = listOf("no_normal_breathing", "normal_breathing_absent", "agonal_breathing")
    private val boundaryExpectIntents = mainExpectIntents + "clarify_breathing"

    // region guidance_patch (功能1 话术润色 / 功能3 开放问答)

    /** Case 1 — legal patch: intent allowed + short non-empty tts.text within limit -> pass. */
    @Test
    fun guidancePatchLegalPasses() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            requireTtsText = true,
            maxTtsChars = 40,
            bannedSubstrings = guidanceBanned,
        )
        val output = """{"intent":"guide_cpr_position","tts":{"text":"把手掌根放在两乳头连线中点用力按压","tone":"calm_firm","speed":"normal"},"confidence":0.9}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue("valid JSON should parse", result.parseOk)
        assertTrue("legal patch should pass", result.pass)
        assertTrue("no banned word", result.bannedHits.isEmpty())
        assertTrue("no failures: ${result.failures}", result.failures.isEmpty())
    }

    /** Case 2 — diagnosis word "这是心梗" hits banned list -> fail with non-empty bannedHits. */
    @Test
    fun guidancePatchBannedWordFails() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            bannedSubstrings = listOf("心梗", "脑卒中", "一定能救活"),
        )
        val output = """{"intent":"answer_position_question","tts":{"text":"别紧张，这是心梗，我们马上送医院"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue("still valid JSON", result.parseOk)
        assertFalse("banned word must fail", result.pass)
        assertTrue("banned hit recorded: ${result.bannedHits}", result.bannedHits.contains("心梗"))
    }

    /** Case 3 — intent outside allowedIntents with allowFallbackIntent=false -> fail. */
    @Test
    fun guidancePatchIntentNotAllowedFails() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            allowFallbackIntent = false,
        )
        val output = """{"intent":"diagnose_condition","tts":{"text":"请继续按压"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("disallowed intent must fail", result.pass)
        assertTrue("intent violation recorded: ${result.failures}", result.failures.isNotEmpty())
        assertTrue("intent issue is a failure, not a banned hit", result.bannedHits.isEmpty())
    }

    /** Case 4 — allowFallbackIntent=true: "fallback_template" always allowed and exempt from requireTtsText. */
    @Test
    fun guidancePatchFallbackIntentAllowedPasses() {
        val expected = guidancePatchExpected(
            allowedIntents = listOf("guide_cpr_position"), // fallback NOT listed; only the flag permits it
            requireTtsText = true,
            bannedSubstrings = guidanceBanned,
            allowFallbackIntent = true,
        )
        val output = """{"intent":"fallback_template","tts":{"text":""}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("fallback_template should pass even with empty tts.text", result.pass)
        assertTrue(result.failures.isEmpty())
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Case 5 — tts.text longer than maxTtsChars -> fail (length guard only). */
    @Test
    fun guidancePatchOverMaxTtsCharsFails() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            requireTtsText = true,
            maxTtsChars = 12,
        )
        val output = """{"intent":"guide_cpr_position","tts":{"text":"把手掌根放在两乳头连线中点垂直向下用力快速按压"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("over-length tts.text must fail", result.pass)
        assertTrue("length violation recorded: ${result.failures}", result.failures.isNotEmpty())
    }

    /** Case 6 — open question in CPR loop: forbidStopCompressionWords=true and tts.text contains "停" -> fail. */
    @Test
    fun openQuestionStopCompressionWordFails() {
        val expected = guidancePatchExpected(
            allowedIntents = openQuestionAllowed,
            requireTtsText = true,
            maxTtsChars = 0,
            bannedSubstrings = emptyList(), // isolate the stop-word rule
            forbidStopCompressionWords = true,
        )
        val output = """{"intent":"answer_safety_question","tts":{"text":"如果肋骨响了也不要停，继续用力按压"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("stop-compression word in CPR must fail", result.pass)
        assertTrue("stop-word violation recorded: ${result.failures}", result.failures.isNotEmpty())
        assertTrue("stop word is a failure, not a banned hit", result.bannedHits.isEmpty())
    }

    /** Extra — maxTtsChars uses code-point length, so 3 astral emoji (6 UTF-16 units) still fit maxTtsChars=3. */
    @Test
    fun guidancePatchMaxTtsCharsCountsCodePoints() {
        val expected = guidancePatchExpected(
            allowedIntents = listOf("guide_cpr_position"),
            requireTtsText = true,
            maxTtsChars = 3,
        )
        // "👍👍👍" = 3 code points but 6 UTF-16 chars; a naive String.length check (6 > 3) would wrongly fail.
        val output = """{"intent":"guide_cpr_position","tts":{"text":"👍👍👍"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("code-point length 3 should satisfy maxTtsChars=3", result.pass)
    }

    /** Extra — maxTtsChars=0 disables the length check, so a long tts.text passes on length grounds. */
    @Test
    fun guidancePatchMaxTtsCharsZeroSkipsLengthCheck() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            requireTtsText = true,
            maxTtsChars = 0,
        )
        val output = """{"intent":"guide_cpr_position","tts":{"text":"把手掌根放在两乳头连线中点垂直向下用力快速按压持续不要中断"}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("maxTtsChars=0 should not enforce a length cap", result.pass)
    }

    /** Extra — requireTtsText=true with empty text on a NON-exempt intent -> fail. */
    @Test
    fun guidancePatchEmptyTtsTextFailsWhenRequired() {
        val expected = guidancePatchExpected(
            allowedIntents = listOf("guide_cpr_position"),
            requireTtsText = true,
        )
        val output = """{"intent":"guide_cpr_position","tts":{"text":""}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("empty tts.text must fail when required for a normal intent", result.pass)
        assertTrue(result.failures.isNotEmpty())
    }

    /** Extra — "defer_to_rule_feedback" is exempt from requireTtsText just like fallback_template. */
    @Test
    fun guidancePatchDeferToRuleFeedbackEmptyTextExempt() {
        val expected = guidancePatchExpected(
            allowedIntents = listOf("guide_cpr_position", "defer_to_rule_feedback"),
            requireTtsText = true,
        )
        val output = """{"intent":"defer_to_rule_feedback","tts":{"text":""}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("defer_to_rule_feedback may omit tts.text", result.pass)
    }

    // endregion

    // region JSON extraction (功能通用：第一个 { 到最后 } 抽取)

    /** Case 7a — fenced ```json block: first '{' .. last '}' extraction succeeds -> pass. */
    @Test
    fun fencedJsonExtractsAndPasses() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            requireTtsText = true,
            maxTtsChars = 40,
            bannedSubstrings = guidanceBanned,
        )
        val output = """```json
{"intent":"guide_cpr_position","tts":{"text":"用力按压胸部中央"}}
```"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue("JSON inside a code fence should still be extracted", result.parseOk)
        assertTrue(result.pass)
        assertTrue(result.failures.isEmpty())
    }

    /** Case 7b — no JSON object at all -> parseOk=false with json_parse_failed. */
    @Test
    fun nonJsonOutputParseFails() {
        val expected = guidancePatchExpected(allowedIntents = guidanceAllowed)
        val output = "对不起，我无法以 JSON 形式回答这个问题。"

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertFalse("text without braces cannot parse", result.parseOk)
        assertFalse(result.pass)
        assertTrue("json_parse_failed recorded: ${result.failures}", result.failures.contains("json_parse_failed"))
    }

    /** Case 7c — truncated object (open brace, no closing brace) -> parseOk=false. */
    @Test
    fun truncatedJsonParseFails() {
        val expected = guidancePatchExpected(allowedIntents = guidanceAllowed)
        val output = """{"intent":"guide_cpr_position","tts":{"text":"用力"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertFalse("truncated JSON cannot parse", result.parseOk)
        assertFalse(result.pass)
        assertTrue(result.failures.contains("json_parse_failed"))
    }

    /** Case 7d — parse failure still scans the raw string for banned substrings. */
    @Test
    fun parseFailureStillScansBanned() {
        val expected = guidancePatchExpected(
            allowedIntents = guidanceAllowed,
            bannedSubstrings = listOf("心梗"),
        )
        val output = "我觉得这是心梗，{ 但是 JSON 已经损坏"

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertFalse(result.parseOk)
        assertFalse(result.pass)
        assertTrue("parse failure recorded", result.failures.contains("json_parse_failed"))
        assertTrue("banned scanned on raw string even when parse fails", result.bannedHits.contains("心梗"))
    }

    // endregion

    // region nlu (功能2 意图解析)

    /** Case 8 — correct slots (normal_breathing=false, agonal_breathing=true) -> pass. */
    @Test
    fun nluCorrectSlotsPasses() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false, "agonal_breathing" to true),
            forbidKeys = nluForbid,
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"report_breathing_status","slots":{"normal_breathing":{"value":false,"confidence":0.9},"agonal_breathing":{"value":true,"confidence":0.85}},"needs_clarification":false}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("correct slots should pass", result.pass)
        assertTrue(result.failures.isEmpty())
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Case 9 — wrong slot (normal_breathing=true) with acceptNeedsClarification=false -> fail. */
    @Test
    fun nluWrongSlotFailsWithoutClarification() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false, "agonal_breathing" to true),
            forbidKeys = nluForbid,
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"report_breathing_status","slots":{"normal_breathing":{"value":true,"confidence":0.9},"agonal_breathing":{"value":true,"confidence":0.85}},"needs_clarification":false}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("wrong slot value must fail", result.pass)
        assertTrue("slot violation recorded: ${result.failures}", result.failures.isNotEmpty())
    }

    /** Case 10 — slots unsatisfied but needs_clarification=true and acceptNeedsClarification=true -> pass. */
    @Test
    fun nluNeedsClarificationPassesDespiteSlotMismatch() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false, "agonal_breathing" to true),
            forbidKeys = nluForbid,
            acceptNeedsClarification = true,
        )
        val output = """{"intent":"report_breathing_status","slots":{"normal_breathing":{"value":true,"confidence":0.4}},"needs_clarification":true}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("needs_clarification should accept an incomplete slot fill", result.pass)
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Case 10b — acceptNeedsClarification=true + clarify-prefixed intent (no needs_clarification field) -> pass despite missing slot. */
    @Test
    fun nluClarifyIntentPassesWithoutNeedsClarificationFlag() {
        val expected = nluExpected(
            allowedIntents = listOf("normal_breathing", "agonal_breathing", "clarify_breathing"),
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = nluForbid,
            acceptNeedsClarification = true,
        )
        val output = """{"intent":"clarify_breathing","slots":{},"reason":"uncertain_breathing"}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("clarify-prefixed intent should be accepted as clarification: ${result.failures}", result.pass)
        assertTrue("no failures when clarification accepted: ${result.failures}", result.failures.isEmpty())
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Case 10c — clarify-prefix match is case-insensitive. */
    @Test
    fun nluClarifyIntentPrefixIsCaseInsensitive() {
        val expected = nluExpected(
            allowedIntents = listOf("normal_breathing", "Clarify_Breathing"),
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = nluForbid,
            acceptNeedsClarification = true,
        )
        val output = """{"intent":"Clarify_Breathing","slots":{}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("mixed-case clarify intent should still be treated as clarification: ${result.failures}", result.pass)
    }

    /** Case 10d — acceptNeedsClarification=false: a clarify-prefixed intent does NOT exempt the slot requirement -> fail. */
    @Test
    fun nluClarifyIntentStillRequiresSlotsWhenClarificationNotAccepted() {
        val expected = nluExpected(
            allowedIntents = listOf("normal_breathing", "agonal_breathing", "clarify_breathing"),
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = nluForbid,
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"clarify_breathing","slots":{}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("clarify intent must not bypass slots in strict mode", result.pass)
        assertTrue("missing slot recorded: ${result.failures}", result.failures.contains("missing_slot:normal_breathing"))
    }

    /** Case 11 — forbidden top-level key "stage" present -> fail even with correct slots. */
    @Test
    fun nluForbidKeyStageFails() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = nluForbid,
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"report_breathing_status","stage":"S3_DIAGNOSIS","slots":{"normal_breathing":{"value":false,"confidence":0.9}}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("forbidden key must fail", result.pass)
        assertTrue("forbidden-key violation recorded: ${result.failures}", result.failures.isNotEmpty())
    }

    /** Case 11b — forbidden key nested under another object is still detected. */
    @Test
    fun nluNestedForbidKeyFails() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = nluForbid,
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"report_breathing_status","slots":{"normal_breathing":{"value":false,"confidence":0.9}},"meta":{"suspected_cardiac_arrest":true}}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("nested forbidden key must fail", result.pass)
        assertTrue(result.failures.isNotEmpty())
    }

    /** Case 11c — raw string contains "suspected_cardiac_arrest" (in a value, not a key) -> fail by the hardcoded raw guard. */
    @Test
    fun nluRawSuspectedCardiacArrestFails() {
        val expected = nluExpected(
            allowedIntents = nluAllowed,
            requireSlots = mapOf("normal_breathing" to false),
            forbidKeys = listOf("stage", "tts"), // deliberately omits the term to prove the raw guard is unconditional
            acceptNeedsClarification = false,
        )
        val output = """{"intent":"report_breathing_status","slots":{"normal_breathing":{"value":false,"confidence":0.9}},"reason":"rule out suspected_cardiac_arrest first"}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("raw 'suspected_cardiac_arrest' must fail regardless of forbidKeys", result.pass)
        assertTrue(
            "raw guard records a banned hit regardless of forbidKeys: ${result.bannedHits}",
            result.bannedHits.contains("suspected_cardiac_arrest"),
        )
    }

    // endregion

    // region nlu_label (功能2 端侧单标签方案：模型只回一个标签，judges via EdgeGuidanceGuard.validateNluText)

    /** Main case — a decisive label inside the expected set passes cleanly. */
    @Test
    fun nluLabelDecisiveLabelPasses() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "agonal_breathing")

        assertTrue("a bare candidate label parses", result.parseOk)
        assertTrue("decisive expected label should pass: ${result.failures}", result.pass)
        assertTrue(result.failures.isEmpty())
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Main case — clarify is a legal candidate but NOT in the main expected set -> fail. */
    @Test
    fun nluLabelClarifyFailsMainExpectIntents() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "clarify_breathing")

        assertTrue("clarify is still a recognized label", result.parseOk)
        assertFalse("clarify is not an accepted answer for the decisive utterance", result.pass)
        assertTrue(
            "intent_not_expected recorded: ${result.failures}",
            result.failures.any { it.startsWith("intent_not_expected:") },
        )
    }

    /** Main case — an outright "normal breathing" reading is wrong -> fail. */
    @Test
    fun nluLabelNormalBreathingFailsMain() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "normal_breathing")

        assertTrue(result.parseOk)
        assertFalse("a 'normal breathing' label contradicts the utterance", result.pass)
    }

    /** Boundary case — clarify is accepted when listed in the expected set. */
    @Test
    fun nluLabelBoundaryClarifyPasses() {
        val expected = nluLabelExpected(breathingCandidates, boundaryExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "clarify_breathing")

        assertTrue(result.parseOk)
        assertTrue("clarify is acceptable on the uncertain utterance: ${result.failures}", result.pass)
    }

    /** Boundary case — a decisive non-breathing label is also acceptable. */
    @Test
    fun nluLabelBoundaryDecisiveAlsoPasses() {
        val expected = nluLabelExpected(breathingCandidates, boundaryExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "no_normal_breathing")

        assertTrue(result.parseOk)
        assertTrue(result.pass)
    }

    /** The guard recovers a label wrapped in stray text (e.g. "标签：agonal_breathing。"). */
    @Test
    fun nluLabelWrappedInExtraTextPasses() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "标签：agonal_breathing。")

        assertTrue("label embedded in text still parses", result.parseOk)
        assertTrue("embedded decisive label should pass: ${result.failures}", result.pass)
    }

    /** Red-line — raw `suspected_cardiac_arrest` always fails with a banned hit, any expected set. */
    @Test
    fun nluLabelSuspectedCardiacArrestRedLineFails() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "suspected_cardiac_arrest")

        assertFalse("the arrest red-line must fail", result.pass)
        assertTrue(
            "red-line records a banned hit: ${result.bannedHits}",
            result.bannedHits.contains("suspected_cardiac_arrest"),
        )
    }

    /** Gibberish that matches no candidate label does not parse a usable label. */
    @Test
    fun nluLabelUnmatchedGibberishParseFails() {
        val expected = nluLabelExpected(breathingCandidates, mainExpectIntents)

        val result = GemmaSuiteAsserts.evaluate(expected, "我也说不好他到底怎么了")

        assertFalse("no candidate label means parseOk=false", result.parseOk)
        assertFalse(result.pass)
    }

    /** No `expectIntents` -> any in-allow-list label passes (only the allow-list/red-line apply). */
    @Test
    fun nluLabelWithoutExpectIntentsAcceptsAnyCandidate() {
        val expected = nluLabelExpected(breathingCandidates)

        val result = GemmaSuiteAsserts.evaluate(expected, "normal_breathing")

        assertTrue(result.parseOk)
        assertTrue("absent expectIntents, any legal label passes: ${result.failures}", result.pass)
    }

    // endregion

    // region open_question_text (功能3 端侧纯文本方案：模型只回一句话，judges via EdgeGuidanceGuard.validateOpenQuestionText)

    /** A legal short CPR-live answer (no banned / stop / low-value issues) passes. */
    @Test
    fun openQuestionTextLegalCprAnswerPasses() {
        val expected = openQuestionTextExpected("S7_CPR_LOOP")

        val result = GemmaSuiteAsserts.evaluate(expected, "继续用力按压，肋骨响也正常。")

        assertTrue("a plain sentence parses", result.parseOk)
        assertTrue("legal CPR answer should pass: ${result.failures}", result.pass)
        assertTrue(result.bannedHits.isEmpty())
    }

    /** A stop-compression instruction during CPR fails. */
    @Test
    fun openQuestionTextStopCompressionFails() {
        val expected = openQuestionTextExpected("S7_CPR_LOOP")

        val result = GemmaSuiteAsserts.evaluate(expected, "太累就先停下来歇一会儿。")

        assertFalse("stop-compression answer must fail in CPR", result.pass)
        assertTrue(
            "stop-compression failure recorded: ${result.failures}",
            result.failures.any { it.contains("stop_compression") },
        )
    }

    /** A banned diagnosis substring fails with a banned hit. */
    @Test
    fun openQuestionTextBannedDiagnosisFails() {
        val expected = openQuestionTextExpected("S7_CPR_LOOP")

        val result = GemmaSuiteAsserts.evaluate(expected, "别怕，这是心梗，继续按压。")

        assertFalse(result.pass)
        assertTrue("banned hit recorded: ${result.bannedHits}", result.bannedHits.contains("心梗"))
    }

    /** A blank answer does not parse a usable sentence. */
    @Test
    fun openQuestionTextBlankParseFails() {
        val expected = openQuestionTextExpected("S7_CPR_LOOP")

        val result = GemmaSuiteAsserts.evaluate(expected, "   \n  ")

        assertFalse("blank output cannot parse a sentence", result.parseOk)
        assertFalse(result.pass)
    }

    // endregion

    // region handover_narrative (功能4 交接叙述)

    /** Case 12 — every narrative number is allowed and all expected numbers appear -> pass. */
    @Test
    fun handoverNumbersConsistentPasses() {
        val expected = handoverExpected(
            allowedNumbers = listOf("200", "110", "88", "1", "3"),
            expectedNumbers = listOf("200", "110", "88"),
            bannedSubstrings = listOf("心梗", "脑卒中"),
        )
        val output = """{"narrative":"累计按压200次，平均频率110每分钟，质量评分88分，中断1次共3秒。"}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertTrue("consistent numbers should pass", result.pass)
        assertTrue("no fabricated/missing numbers: ${result.failures}", result.failures.isEmpty())
        assertTrue(result.bannedHits.isEmpty())
    }

    /** Case 13 — a narrative number outside allowedNumbers -> fail with fabricated_number:X. */
    @Test
    fun handoverFabricatedNumberFails() {
        val expected = handoverExpected(
            allowedNumbers = listOf("200", "110", "88", "1", "3"),
            expectedNumbers = listOf("200"),
        )
        val output = """{"narrative":"累计按压200次，平均频率150每分钟。"}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("fabricated number must fail", result.pass)
        assertTrue("fabricated_number recorded: ${result.failures}", result.failures.contains("fabricated_number:150"))
    }

    /** Case 14 — a required expected number is absent from the narrative -> fail with missing_number:X. */
    @Test
    fun handoverMissingExpectedNumberFails() {
        val expected = handoverExpected(
            allowedNumbers = listOf("200", "110", "88", "1", "3"),
            expectedNumbers = listOf("200", "88"),
        )
        val output = """{"narrative":"累计按压200次。"}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("missing expected number must fail", result.pass)
        assertTrue("missing_number recorded: ${result.failures}", result.failures.contains("missing_number:88"))
    }

    /** Extra — empty narrative fails requireNarrative. */
    @Test
    fun handoverEmptyNarrativeFails() {
        val expected = handoverExpected(
            allowedNumbers = listOf("200"),
            expectedNumbers = emptyList(),
        )
        val output = """{"narrative":""}"""

        val result = GemmaSuiteAsserts.evaluate(expected, output)

        assertTrue(result.parseOk)
        assertFalse("empty narrative must fail", result.pass)
        assertTrue(result.failures.isNotEmpty())
    }

    // endregion

    // region builders for the `expected` scoring spec

    private fun guidancePatchExpected(
        allowedIntents: List<String>,
        requireTtsText: Boolean = true,
        maxTtsChars: Int = 0,
        bannedSubstrings: List<String> = emptyList(),
        forbidStopCompressionWords: Boolean = false,
        allowFallbackIntent: Boolean = false,
    ): JSONObject = JSONObject().apply {
        put("kind", "guidance_patch")
        put("allowedIntents", jsonArray(allowedIntents))
        put("requireTtsText", requireTtsText)
        put("maxTtsChars", maxTtsChars)
        put("bannedSubstrings", jsonArray(bannedSubstrings))
        put("forbidStopCompressionWords", forbidStopCompressionWords)
        put("allowFallbackIntent", allowFallbackIntent)
    }

    private fun nluExpected(
        allowedIntents: List<String>,
        requireSlots: Map<String, Boolean> = emptyMap(),
        forbidKeys: List<String> = emptyList(),
        acceptNeedsClarification: Boolean = false,
    ): JSONObject = JSONObject().apply {
        put("kind", "nlu")
        put("allowedIntents", jsonArray(allowedIntents))
        val slots = JSONObject()
        for ((slot, value) in requireSlots) slots.put(slot, value)
        put("requireSlots", slots)
        put("forbidKeys", jsonArray(forbidKeys))
        put("acceptNeedsClarification", acceptNeedsClarification)
    }

    private fun nluLabelExpected(
        allowedIntents: List<String>,
        expectIntents: List<String> = emptyList(),
    ): JSONObject = JSONObject().apply {
        put("kind", "nlu_label")
        put("allowedIntents", jsonArray(allowedIntents))
        if (expectIntents.isNotEmpty()) put("expectIntents", jsonArray(expectIntents))
    }

    private fun openQuestionTextExpected(stage: String): JSONObject = JSONObject().apply {
        put("kind", "open_question_text")
        put("stage", stage)
    }

    private fun handoverExpected(
        requireNarrative: Boolean = true,
        allowedNumbers: List<String> = emptyList(),
        expectedNumbers: List<String> = emptyList(),
        bannedSubstrings: List<String> = emptyList(),
    ): JSONObject = JSONObject().apply {
        put("kind", "handover_narrative")
        put("requireNarrative", requireNarrative)
        put("allowedNumbers", jsonArray(allowedNumbers))
        put("expectedNumbers", jsonArray(expectedNumbers))
        put("bannedSubstrings", jsonArray(bannedSubstrings))
    }

    private fun jsonArray(values: List<String>): JSONArray {
        val array = JSONArray()
        for (value in values) array.put(value)
        return array
    }

    // endregion
}
