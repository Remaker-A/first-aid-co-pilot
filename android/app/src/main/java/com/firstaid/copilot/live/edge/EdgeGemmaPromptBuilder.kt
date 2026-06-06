package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.ProactiveCueKind
import com.firstaid.copilot.live.ProactivePolishRequest
import org.json.JSONArray

/**
 * Builds the on-device Gemma prompts for the three edge functions.
 *
 * Device-slimmed on purpose. The on-device 2.4GB LiteRT-LM model's bottleneck is
 * prompt prefill, so a verbose prompt (full schema + numbered hard rules + an
 * example + a redundant full DecisionFrame JSON dump) makes a single generation
 * so slow it does not return on real hardware. These prompts therefore carry only
 * the minimal *dynamic* context the model needs (stage, allowed intents, the
 * actual user utterance), and ask for the smallest useful JSON.
 *
 * The *hard* safety rules are NOT spelled out to the model here. They are enforced
 * deterministically in the harness by [EdgeGuidanceGuard] / [GemmaSuiteAsserts]
 * after generation: banned medical phrases, the "never stop compressions" rule in
 * CPR, the per-stage `allowed_intents` allow-list, the answer length cap, and the
 * NLU forbidden keys / `suspected_cardiac_arrest` red-line. So an over-eager or
 * malformed model output is rejected by the guard and the caller speaks a
 * deterministic fallback — the prompt does not need to re-teach those rules.
 *
 * Output contracts (功能 · 选定方案 B 瘦 JSON):
 * - Open question (C): `{"intent": <allowed>, "tts": {"text": <one line>}}`
 * - NLU (E):           `{"intent": <allowed>, "needs_clarification": bool, "confidence": num}`
 * - Proactive (D):     plain one-line text (gated by the proactive safety net).
 *
 * Pure (Kotlin + `org.json`, no Android/Context dependency) so it is unit-testable
 * alongside [GemmaSuiteAsserts].
 */
class EdgeGemmaPromptBuilder {

    /**
     * 受控开放问答 (功能 C). Asks for a slim `{intent, tts.text}` object. `intent`
     * is constrained to [OpenQuestionFrame.allowedIntents] (the guard re-checks it);
     * everything structural (tone, ui text, JSON assembly defaults) is owned by the
     * harness, so the model only contributes the one short Chinese answer.
     */
    fun openQuestionPrompt(frame: OpenQuestionFrame): String {
        val stage = frame.stage?.takeIf { it.isNotBlank() } ?: "S7_CPR_LOOP"
        val allowedIntents = JSONArray(frame.allowedIntents).toString()
        val safetyPhrase = frame.safetyPhrases.firstOrNull()?.takeIf { it.isNotBlank() }

        return buildString {
            append("SYSTEM:\n")
            append(OPEN_QUESTION_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("[Stage] ").append(stage).append("\n")
            append("[Allowed Intents] ").append(allowedIntents).append("\n")
            if (safetyPhrase != null) {
                append("[Safety Phrase] ").append(safetyPhrase).append("\n")
            }
            append("[User Input] ").append(frame.userInput).append("\n")
            append("只输出一个 JSON：{\"intent\":\"<allowed_intents 之一>\",\"tts\":{\"text\":\"<一句中文，≤30字>\"}}")
        }
    }

    /**
     * 呼吸观察 NLU (功能 E). Asks for a slim `{intent, needs_clarification, confidence}`
     * object. Slots are intentionally not requested: the live path only consumes the
     * intent (+ clarification/confidence), and the breathing semantics live in the
     * one-line rule inside [NLU_SYSTEM_PROMPT].
     */
    fun nluPrompt(
        stage: String,
        transcript: String,
        allowedIntents: List<String>,
    ): String {
        val resolvedStage = stage.takeIf { it.isNotBlank() } ?: "S3_CHECK_BREATHING"
        val allowed = JSONArray(allowedIntents).toString()
        return buildString {
            append("SYSTEM:\n")
            append(NLU_SYSTEM_PROMPT)
            append("\n\nUSER:\n")
            append("[Stage] ").append(resolvedStage).append("\n")
            append("[Transcript] ").append(transcript).append("\n")
            append("[Allowed Intents] ").append(allowed).append("\n")
            append("只输出一个 JSON：{\"intent\":\"<allowed_intents 之一>\",\"needs_clarification\":false,\"confidence\":0.0}")
        }
    }

    /**
     * Proactive-nudge polish prompt (功能 D, 可选). Asks for a single short, calm
     * Chinese rephrase of an already-safe deterministic template. Plain-text out
     * (not JSON) — the agent gates the result with the proactive safety net.
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

    companion object {
        /**
         * Device-slimmed 受控问答 contract. The hard rules (banned diagnosis/outcome
         * words, the stop-compression ban, the length cap, the intent allow-list) are
         * enforced by [EdgeGuidanceGuard] after generation, so they are deliberately
         * not re-listed here; only the behavioural framing + output shape remain.
         */
        const val OPEN_QUESTION_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的受控问答层，运行在成人疑似心脏骤停 CPR 场景。" +
                "施救者问了一个流程外的开放问题，你只用一句中文简短作答。\n" +
                "不决定急救流程、不切换 stage、不调用工具(tool_actions)、不诊断、不承诺结果；" +
                "CPR 进行中绝不让施救者停下按压，先肯定“继续按压”再答。\n" +
                "intent 只能取自 USER 给出的 allowed_intents。" +
                "只输出一个顶层 JSON 对象：{\"intent\":\"...\",\"tts\":{\"text\":\"...\"}}，" +
                "第一个字符必须是 {，最后一个字符必须是 }，不要 Markdown、解释或多余文本。"

        /**
         * Device-slimmed NLU contract. The forbidden-key / `suspected_cardiac_arrest`
         * red-lines are enforced by the guard; only the one breathing rule the model
         * actually needs is kept.
         */
        const val NLU_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的呼吸观察解析层，运行在成人疑似心脏骤停 CPR 场景。" +
                "只把施救者口语判成一个观察 intent，不决定流程、不切 stage、不调用工具、不诊断，" +
                "绝不输出 suspected_cardiac_arrest。\n" +
                "判定规则：偶尔喘/喘息/濒死呼吸都不是正常呼吸；表达不确定时 needs_clarification=true。\n" +
                "intent 只能取自 USER 给出的 allowed_intents。" +
                "只输出一个顶层 JSON 对象：{\"intent\":\"...\",\"needs_clarification\":false,\"confidence\":0.0}，" +
                "第一个字符必须是 {，最后一个字符必须是 }，不要 Markdown 或多余文本。"

        /** Short SYSTEM contract for the optional proactive rephrase (plain text out). */
        const val PROACTIVE_SYSTEM_PROMPT: String =
            "你是 FirstAid Copilot 的主动陪伴话术润色层，运行在成人 CPR 场景。\n" +
                "你只把一句已经安全的确定性提示改写得更自然、更口语化，绝不改变其含义。\n" +
                "硬性限制：绝不让施救者停下按压；不诊断疾病；不承诺结果；不恐吓、不责备；不替用户做医疗决定。\n" +
                "只输出改写后的一句中文短句（最多 30 个汉字），不要 JSON、不要解释、不要引号或多余文本。"
    }
}
