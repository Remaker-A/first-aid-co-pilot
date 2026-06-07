package com.firstaid.copilot.live.edge

/**
 * On-device open-question (受控开放问答) contract, detection, and per-stage policy.
 *
 * This is the Phase C (开放问答) building block for the edge Gemma layer. It is a
 * faithful Kotlin port of the server live driver (`src/voice/liveDriver.js`) so
 * the on-device path stays in parity with the Node service: the same coarse
 * "reads like a question" gate, the same per-stage controlled-answer intents, and
 * the same WA-cache-eligible ack/fallback phrasing.
 *
 * Everything here is pure Kotlin (no Android/`org.json` types) so the JVM
 * `testDebugUnitTest` suite can exercise detection and policy directly.
 */

/**
 * The minimal DecisionFrame the edge open-question layer needs to build a prompt
 * and validate the answer. The medical flow itself stays server-driven; this
 * frame only carries the *language/understanding* context the controlled-answer
 * Gemma is allowed to see.
 */
data class OpenQuestionFrame(
    val stage: String?,
    val userInput: String,
    val allowedIntents: List<String>,
    val safetyPhrases: List<String> = emptyList(),
    val facts: Map<String, Any?> = emptyMap(),
    val recentTts: List<String> = emptyList(),
    val language: String = "zh-CN",
)

/** Result of a controlled open-question answer attempt. */
sealed interface OpenQuestionOutcome {
    val latencyMs: Long

    /** A guard-approved short answer ready to speak. */
    data class Answer(
        val ttsText: String,
        val mainText: String,
        val secondaryText: String,
        val intent: String,
        val tone: String,
        override val latencyMs: Long,
        val cacheHit: Boolean = false,
    ) : OpenQuestionOutcome

    /**
     * The answer could not be produced safely (generation failed / timed out, the
     * guard rejected it, the per-minute budget was spent, …). The caller falls
     * back to a deterministic template so the rescuer always gets a reply.
     */
    data class Fallback(
        val reason: String,
        val answerText: String? = null,
        override val latencyMs: Long = 0L,
    ) : OpenQuestionOutcome
}

/**
 * Input contract for the "规则首答 + Gemma 简短补充" path. The deterministic
 * rules already produced [fastAnswerText]; Gemma may only add one non-repeated
 * detail that helps answer [frame.userInput].
 */
data class OpenQuestionSupplementRequest(
    val frame: OpenQuestionFrame,
    val fastAnswerText: String,
    val answerFocus: String,
) {
    val question: String get() = frame.userInput
    val stage: String? get() = frame.stage
}

/** Result of a post-rule Gemma supplement attempt. */
data class OpenQuestionSupplementOutcome(
    val accepted: Boolean,
    val text: String = "",
    val reason: String? = null,
    val latencyMs: Long = 0L,
    val cacheHit: Boolean = false,
)

/**
 * The single suspendable entry the [com.firstaid.copilot.live.LiveSessionViewModel]
 * depends on for Phase C. [EdgeGemmaAgent] is the production implementation; tests
 * inject a fake. Implementations must never throw for ordinary failures — they
 * return [OpenQuestionOutcome.Fallback] so the deterministic template path runs.
 */
fun interface OpenQuestionResponder {
    suspend fun answerOpenQuestion(frame: OpenQuestionFrame): OpenQuestionOutcome
}

/**
 * Post-rule supplement seam for open questions. The caller has already spoken a
 * deterministic fast answer, so implementations return either one short extra
 * detail or a rejected reason; they must never produce a replacement answer.
 */
fun interface OpenQuestionSupplementResponder {
    suspend fun answerOpenQuestionSupplement(
        frame: OpenQuestionFrame,
        fastAnswerText: String,
    ): OpenQuestionSupplementOutcome
}

/**
 * Per-stage open-question policy, mirroring `liveDriver.js`:
 *  - which controlled-answer intents Gemma may use in each stage,
 *  - which stages open the Q&A exception at all (S3/S4 stay deterministic),
 *  - the immediate stabilizing ack text and the safety fallback phrase.
 */
object EdgeOpenQuestionPolicy {
    /**
     * Per-stage controlled-answer intents. Every entry is a subset of that stage's
     * `allowed_intents`, so a passing answer also clears the production validator.
     * Stages without a safe answer intent (the tightly gated S3/S4 breathing /
     * arrest checks) are intentionally omitted.
     */
    private val ANSWER_INTENTS_BY_STAGE: Map<String, List<String>> = mapOf(
        "S0_INIT" to listOf("reassure_rescuer"),
        "S1_SCENE_SAFE" to listOf("reassure_rescuer"),
        "S2_CHECK_RESPONSE" to listOf("reassure_rescuer"),
        "S5_CALL_EMERGENCY" to listOf("calm_rescuer"),
        "S6_CPR_READY" to listOf("encourage_rescuer", "answer_position_question"),
        "S7_CPR_LOOP" to listOf("answer_current_cpr_question", "encourage_rescuer", "calm_rescuer"),
        "S8_ASSISTANCE" to listOf("calm_rescuer", "explain_aed_support"),
    )

    /** A minimal per-stage safety-phrase set Gemma is encouraged to reuse/stay near. */
    private val SAFETY_PHRASES_BY_STAGE: Map<String, List<String>> = mapOf(
        "S0_INIT" to listOf("我会一步步告诉你怎么做。"),
        "S1_SCENE_SAFE" to listOf("先确认周围安全，再靠近他。"),
        "S2_CHECK_RESPONSE" to listOf("请大声呼叫他，并轻拍双肩。"),
        "S5_CALL_EMERGENCY" to listOf("我将为你拨打 120，请保持手机免提。"),
        "S6_CPR_READY" to listOf(
            "让他平躺在硬的平面上。",
            "双手掌根放在胸口中央。",
            "如果手机能稳住，放在患者胸侧，屏幕朝向你；放不好不要耽误，立刻开始按压。",
        ),
        "S7_CPR_LOOP" to listOf(
            "双手掌根放在胸口中央。",
            "双手掌根放到胸口中央，现在开始按。",
            "跟着节拍按，快速有力。",
            "不要停，继续按压。",
            "你做得很好，跟着节拍继续。",
        ),
        "S8_ASSISTANCE" to listOf(
            "打开 AED，跟着它的语音做，先继续按压。",
            "如果旁边有人，请让他准备接替按压。",
            "你做得很好，跟着节拍继续。",
        ),
    )

    /** The immediate stabilizing ack spoken while CPR is actively running. */
    const val CPR_ACK_TEXT: String = "我在，继续按压。"

    /** The immediate stabilizing ack spoken outside the active-CPR stages. */
    const val NON_CPR_ACK_TEXT: String = "别紧张，按我说的做。"

    /** The deterministic CPR-live fallback answer (guard reject / timeout / budget). */
    const val CPR_FALLBACK_TEXT: String = "继续按压，不要停，我在。"

    /** The deterministic non-CPR fallback answer. */
    const val NON_CPR_FALLBACK_TEXT: String = "我在，按我说的做，别紧张。"

    /** Recommended max answer length, mirroring `open_question_main.json` expected. */
    const val MAX_TTS_CHARS: Int = 40

    /**
     * Medical substrings the answer must never contain (diagnosis / outcome
     * promises). Mirrors the `bannedSubstrings` in the open-question grader case.
     */
    val BANNED_SUBSTRINGS: List<String> = listOf(
        "心梗",
        "脑卒中",
        "脑梗",
        "他已经心脏骤停了",
        "心脏骤停了",
        "一定能救活",
        "保证能救活",
    )

    fun answerIntents(stage: String?): List<String> =
        ANSWER_INTENTS_BY_STAGE[stage]?.toList() ?: emptyList()

    /** A stage supports edge open-question Q&A only if it has a safe answer intent. */
    fun isOpenQuestionStage(stage: String?): Boolean = answerIntents(stage).isNotEmpty()

    /** True for the stages where CPR is actively being performed (S7/S8). */
    fun isCprLiveStage(stage: String?): Boolean =
        stage == "S7_CPR_LOOP" || stage == "S8_ASSISTANCE"

    fun ackText(stage: String?): String =
        if (isCprLiveStage(stage)) CPR_ACK_TEXT else NON_CPR_ACK_TEXT

    fun fallbackAnswer(stage: String?): String =
        if (isCprLiveStage(stage)) CPR_FALLBACK_TEXT else NON_CPR_FALLBACK_TEXT

    fun fallbackAnswer(stage: String?, question: String?): String {
        val compact = question?.replace(Regex("\\s+"), "").orEmpty()
        if (compact.isBlank()) return fallbackAnswer(stage)
        return when {
            Regex("(为什么|为何|为啥|原因|突然|怎么会).*(倒下|晕倒|这样|不行)|倒下.*(为什么|为何|原因)")
                .containsMatchIn(compact) ->
                "先不要判断原因，继续按压，这是现在最能帮他的事。"
            Regex("(旁边的人|别人|同伴|路人).*(做什么|帮|怎么帮|最好)|怎么.*(分工|帮忙)")
                .containsMatchIn(compact) ->
                "继续按压，让旁人拿 AED、开门，并准备和你换手。"
            Regex("(家属|亲人|通知|告诉)")
                .containsMatchIn(compact) ->
                "先让旁人联系家属，你继续按压，别停下来解释。"
            Regex("(AED|aed|除颤|电击)")
                .containsMatchIn(compact) ->
                "让旁人打开 AED 跟语音做；分析或电击时所有人离开。"
            Regex("(救护车|急救员|急救人员|等待|还没到|留意|注意)")
                .containsMatchIn(compact) ->
                "继续按压，留意 AED 指令和是否恢复正常呼吸。"
            Regex("(肋骨|骨头|按断|压断|断了)")
                .containsMatchIn(compact) ->
                "先别因担心停下，继续按压，这是现在最重要的事。"
            Regex("(害怕|紧张|慌|按错|不准|位置)")
                .containsMatchIn(compact) ->
                "你做得对，手掌根在胸口中央，跟着节拍继续。"
            Regex("(会不会|能不能).*(醒|救活|好)|醒过来|结果")
                .containsMatchIn(compact) ->
                "现在不能保证结果，但持续按压是在帮他维持血流。"
            Regex("(累|没力|撑不住|换手)")
                .containsMatchIn(compact) ->
                "让旁人准备换手，换手要快，你先继续按压。"
            Regex("(数|节拍|频率|多快)")
                .containsMatchIn(compact) ->
                "不用自己数，我会给节拍，你跟着用力快压。"
            else -> fallbackAnswer(stage)
        }
    }

    fun questionBucket(question: String?): String {
        val compact = question?.replace(Regex("\\s+"), "").orEmpty()
        return when {
            Regex("(为什么|为何|为啥|原因|突然|怎么会|怎么就)").containsMatchIn(compact) -> "cause"
            Regex("(旁边的人|别人|同伴|路人|帮我|分工|做什么)").containsMatchIn(compact) -> "bystander"
            Regex("(家属|亲人|通知|告诉)").containsMatchIn(compact) -> "family"
            Regex("(AED|aed|除颤|电击)").containsMatchIn(compact) -> "aed"
            Regex("(救护车|急救员|急救人员|等待|还没到|注意)").containsMatchIn(compact) -> "waiting"
            Regex("(肋骨|骨头|按断|压断|断了)").containsMatchIn(compact) -> "fear"
            Regex("(害怕|紧张|慌|按错|不准|位置)").containsMatchIn(compact) -> "fear"
            Regex("(会不会|能不能).*(醒|救活|好|醒过来)|结果").containsMatchIn(compact) -> "outcome"
            Regex("(累|没力|撑不住|换手)").containsMatchIn(compact) -> "tired"
            Regex("(数|节拍|频率|多快)").containsMatchIn(compact) -> "count"
            else -> "general"
        }
    }

    fun ackMainText(stage: String?): String = if (isCprLiveStage(stage)) "继续按压" else "我在"

    fun ackSecondaryText(stage: String?): String = if (isCprLiveStage(stage)) "我在，听我说" else "别紧张，听我说"

    fun safetyPhrases(stage: String?): List<String> =
        SAFETY_PHRASES_BY_STAGE[stage]?.toList() ?: emptyList()
}

/**
 * Coarse "reads like a question" detector, ported verbatim from the server
 * `OPEN_QUESTION_TEXT_PATTERN`. Kept narrow on purpose so plain status reports
 * ("按了三十下", "放好了") never become open questions.
 */
object EdgeOpenQuestionDetector {
    private val OPEN_QUESTION_TEXT_PATTERN = Regex(
        "[?？]|(?:吗|呢)[?？。!！\\s]*$|怎么|为什么|为啥|为何|多久|多长|多大|多少|几分钟|" +
            "什么|啥|哪(?:里|儿|个|边)?|如何|怎样|能不能|能否|可不可以|可以吗|要不要|用不用|" +
            "是不是|有没有|该不该|会不会|需不需要|how\\b|why\\b|what\\b|when\\b|where\\b|" +
            "which\\b|should\\b|can\\s+i|do\\s+i|need\\s+to",
        RegexOption.IGNORE_CASE,
    )

    fun looksLikeOpenQuestion(transcript: String?): Boolean {
        val text = transcript?.trim().orEmpty()
        if (text.length < 2) return false
        return OPEN_QUESTION_TEXT_PATTERN.containsMatchIn(text)
    }
}
