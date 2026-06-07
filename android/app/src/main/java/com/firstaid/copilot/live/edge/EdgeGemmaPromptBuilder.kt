package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.ProactiveCueKind
import com.firstaid.copilot.live.ProactivePolishRequest

/**
 * Builds the on-device Gemma prompts for the three edge functions.
 *
 * Device-slimmed AND plain-output on purpose. On-device latency is dominated by
 * the number of *output* tokens (real-device measurement: a fenced multi-line
 * JSON answer took ~8s on this hardware, vs ~3s for a one-line plain answer of
 * the same content). So the model is asked for the smallest possible output and
 * the harness owns all structure:
 *
 * - Open question (C): the model returns ONE short Chinese sentence (plain text).
 *   The harness ([EdgeGuidanceGuard.validateOpenQuestionText]) assigns the intent
 *   label, wraps it as a `GuidanceActionPatch`, and runs the unchanged
 *   [GemmaSuiteAsserts] safety grader (banned words / stop-compression / length /
 *   allow-list). The guard is also robust if the model still emits JSON.
 * - NLU (E): the model returns ONE intent label from the candidate list (plain
 *   text). The harness matches it against the allow-list and enforces the
 *   `suspected_cardiac_arrest` red-line.
 * - Proactive (D): plain one-line text (unchanged), gated by the proactive net.
 *
 * The *hard* safety rules are NOT re-taught to the model here; they are enforced
 * deterministically by the guard after generation, so an over-eager / malformed
 * output is rejected and the caller speaks a deterministic fallback.
 *
 * Pure (Kotlin only, no Android/Context dependency) so it is unit-testable
 * alongside [GemmaSuiteAsserts].
 */
class EdgeGemmaPromptBuilder {

    /**
     * 受控开放问答 (功能 C). Asks for a single short Chinese sentence (no JSON). The
     * intent label and JSON structure are assigned by the harness, so the model
     * only contributes the one line it is good at — minimizing output tokens.
     */
    fun openQuestionPrompt(frame: OpenQuestionFrame): String {
        val stage = frame.stage?.takeIf { it.isNotBlank() } ?: "S7_CPR_LOOP"
        val cprLive = EdgeOpenQuestionPolicy.isCprLiveStage(stage)
        val safetyPhrase = frame.safetyPhrases.firstOrNull()?.takeIf { it.isNotBlank() }
        val focus = openQuestionFocus(frame.userInput)

        return buildString {
            append("SYSTEM:\n")
            append(OPEN_QUESTION_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("[Stage] ").append(stage).append("\n")
            if (safetyPhrase != null) {
                append("[Safety Phrase] ").append(safetyPhrase).append("\n")
            }
            append("[User Input] ").append(frame.userInput).append("\n")
            append("[Answer Focus] ").append(focus).append("\n")
            append(
                if (cprLive) {
                    "只回一句中文（不超过12字），以“继续按压”开头；不要 JSON、不要引号、不要解释。"
                } else {
                    "只回一句中文（不超过14字）安抚并简短作答；不要 JSON、不要引号、不要解释。"
                },
            )
        }
    }

    fun openQuestionSupplementPrompt(
        frame: OpenQuestionFrame,
        fastAnswerText: String,
    ): String = openQuestionSupplementPrompt(
        frame = frame,
        fastAnswerText = fastAnswerText,
        answerFocus = openQuestionFocus(frame.userInput),
    )

    fun openQuestionSupplementPrompt(
        frame: OpenQuestionFrame,
        fastAnswerText: String,
        answerFocus: String,
    ): String = openQuestionSupplementPrompt(
        OpenQuestionSupplementRequest(
            frame = frame,
            fastAnswerText = fastAnswerText,
            answerFocus = answerFocus,
        ),
    )

    /**
     * Open-question supplement prompt for "规则首答 + Gemma 简短补充". The rule answer
     * is already spoken, so this asks Gemma for only one additional non-repeated
     * point and leaves all safety enforcement to [EdgeGuidanceGuard].
     */
    fun openQuestionSupplementPrompt(request: OpenQuestionSupplementRequest): String {
        val stage = request.stage?.takeIf { it.isNotBlank() } ?: "S7_CPR_LOOP"
        val fastAnswerSaidContinue = request.fastAnswerText.contains("继续按压")
        return buildString {
            append("SYSTEM:\n")
            append(OPEN_QUESTION_SUPPLEMENT_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("[Question] ").append(request.question).append("\n")
            append("[Stage] ").append(stage).append("\n")
            append("[Fast Answer Text] ").append(request.fastAnswerText).append("\n")
            append("[Answer Focus] ").append(request.answerFocus).append("\n")
            append("只补规则首答没说过的一点，不复述、不同义改写首答。")
            append("只输出一句中文，不超过18个汉字，不要 JSON、不要引号、不要解释。")
            append(
                if (fastAnswerSaidContinue) {
                    "不要以“继续按压”开头，因为首答已经说过。"
                } else {
                    "首答未说“继续按压”时，必要时才可以用它开头。"
                },
            )
        }
    }

    /**
     * 呼吸观察 NLU (功能 E). Asks for a single intent label from [allowedIntents]
     * (plain text, no JSON). The harness matches the label against the allow-list
     * and enforces the red-lines; this keeps both the prompt and the output tiny.
     */
    fun nluPrompt(
        stage: String,
        transcript: String,
        allowedIntents: List<String>,
    ): String {
        val resolvedStage = stage.takeIf { it.isNotBlank() } ?: "S3_CHECK_BREATHING"
        val candidates = allowedIntents.joinToString(" / ")
        return buildString {
            append("SYSTEM:\n")
            append(NLU_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("[Stage] ").append(resolvedStage).append("\n")
            append("[Transcript] ").append(transcript).append("\n")
            append("[候选标签] ").append(candidates).append("\n")
            append("只输出候选标签中的一个英文标签，不要 JSON、不要解释、不要标点。")
        }
    }

    /**
     * Proactive-nudge polish prompt (功能 D, 可选). Asks for a single short, calm
     * Chinese rephrase of an already-safe deterministic template. Plain-text out —
     * the agent gates the result with the proactive safety net.
     */
    fun proactivePrompt(request: ProactivePolishRequest): String {
        val intent = when (request.kind) {
            ProactiveCueKind.HandSwitch -> "提醒在按压满约两分钟时尽快换手，节奏不要中断"
            ProactiveCueKind.AedReminder -> "提醒让旁人就近尽快去取并使用 AED，施救者继续按压"
            ProactiveCueKind.Reassure -> "给施救者一句简短的鼓励/安抚，肯定其坚持"
        }
        return buildString {
            append("SYSTEM:\n")
            append(PROACTIVE_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("把下面这句确定性模板改写成一句更自然、口语化的中文（最多 30 个汉字）。\n")
            append("意图：").append(intent).append("。\n")
            append("绝不能让施救者停下按压；不要诊断、不承诺结果、不责备；只输出改写后的那一句话。\n\n")
            append("[Stage]\n").append(request.stage ?: "S7_CPR_LOOP").append("\n\n")
            append("[Template]\n").append(request.templateText).append("\n\n")
            append("[Tone]\n").append(request.tone)
        }
    }

    private fun openQuestionFocus(question: String): String {
        val compact = question.replace(Regex("\\s+"), "")
        return when {
            Regex("(为什么|为何|为啥|原因|怎么会|突然).*(倒下|晕倒|这样|不行)|倒下.*(为什么|为何|原因)")
                .containsMatchIn(compact) -> "不能判断原因；告诉他按压是在维持血流。"
            Regex("(旁边的人|别人|同伴|家属|路人).*(做什么|帮|怎么帮|最好)|怎么.*(分工|帮忙)")
                .containsMatchIn(compact) -> "他继续按压；旁人拿 AED、开门、迎接或换手。"
            Regex("(接手前|急救员|救护车|等待|等.*时候|留意|注意)")
                .containsMatchIn(compact) -> "继续按压；留意 AED 提示和能否安全换手。"
            Regex("(家属|亲人|通知|告诉)")
                .containsMatchIn(compact) -> "他不要停；让旁人通知家属并迎接急救员。"
            Regex("(害怕|紧张|撑不住|慌)")
                .containsMatchIn(compact) -> "先安抚，再把注意力拉回节拍和按压。"
            else -> "简短回答问题，再把注意力拉回继续按压。"
        }
    }

    companion object {
        /**
         * Device-slimmed 受控问答 contract (plain-text out). The hard rules (banned
         * diagnosis/outcome words, the stop-compression ban, the length cap, the
         * intent allow-list) are enforced by [EdgeGuidanceGuard] after generation,
         * so only the behavioural framing + "one plain sentence" shape remain.
         */
        const val OPEN_QUESTION_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的受控问答层，运行在成人疑似心脏骤停 CPR 场景。" +
                "施救者问了一个流程外的开放问题，你只用一句简短中文口语作答。\n" +
                "像现场教练一样温和、具体、可执行；不要只说“不知道”或“根据现场情况判断”。\n" +
                "不决定急救流程、不切换 stage、不调用工具(tool_actions)、不诊断、不承诺结果、不恐吓；" +
                "CPR 进行中绝不让施救者停下按压，不能说保持呼吸/保持胸腔起伏。\n" +
                "只输出那一句中文本身，不要 JSON、不要 Markdown、不要引号或任何多余文本。"

        const val OPEN_QUESTION_SUPPLEMENT_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的开放问答补充层，运行在成人疑似心脏骤停 CPR 场景。" +
                "规则首答已经先回答了施救者；你只补一句首答没说过的安全细节。\n" +
                "不要复述、扩写或同义改写规则首答；不决定流程、不切 stage、不调用工具(tool_actions)。\n" +
                "不诊断、不承诺结果、不恐吓；CPR 进行中绝不让施救者停下按压。\n" +
                "只输出补充短句本身，不要 JSON、不要 Markdown、不要引号或任何多余文本。"

        /**
         * Device-slimmed NLU contract (single-label out). The forbidden-key /
         * `suspected_cardiac_arrest` red-lines are enforced by the guard; only the
         * one breathing rule the model actually needs is kept.
         */
        const val NLU_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的呼吸观察解析层，运行在成人疑似心脏骤停 CPR 场景。" +
                "把施救者口语判成一个观察标签，不决定流程、不切 stage、不调用工具、不诊断，" +
                "绝不输出 suspected_cardiac_arrest。\n" +
                "判定规则：偶尔喘/喘息/濒死呼吸都不是正常呼吸；表达不确定时选 clarify_breathing。\n" +
                "只输出候选标签中的一个英文标签，不要 JSON、不要解释、不要标点或多余文本。"

        /** Short SYSTEM contract for the optional proactive rephrase (plain text out). */
        const val PROACTIVE_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的主动陪伴话术润色层，运行在成人 CPR 场景。\n" +
                "你只把一句已经安全的确定性提示改写得更自然、更口语化，绝不改变其含义。\n" +
                "硬性限制：绝不让施救者停下按压；不诊断疾病；不承诺结果；不恐吓、不责备；不替用户做医疗决定。\n" +
                "只输出改写后的一句中文短句（最多 30 个汉字），不要 JSON、不要解释、不要引号或多余文本。"
    }
}
