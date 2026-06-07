package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.LiveNluRequest
import com.firstaid.copilot.live.LiveNluResolution
import com.firstaid.copilot.live.LiveNluResolver
import java.util.Locale

/**
 * Ultra-light S3 breathing NLU path for the live hot loop (功能 E).
 *
 * This deliberately avoids the shared 2B Gemma driver: that path is ~10-17s per
 * call on this hardware and, because it almost always exceeds the live timeout, it
 * also drives the driver's discard/rebuild cascade. A closed-set observation label
 * for S3_CHECK_BREATHING is a classification problem, so it is resolved here in
 * microseconds. Ambiguous phrases return clarification so they are never promoted
 * into a hard intent hint, and the stage allow-list + the unconditional
 * suspected_cardiac_arrest red-line are still enforced upstream.
 *
 * The classifier is injected behind [EdgeBreathingNluClassifier] so the rule-based
 * v1 can later be swapped for an embedding / small-model scorer without touching the
 * live wiring.
 */
class EdgeTinyNluResolver internal constructor(
    private val classifier: EdgeBreathingNluClassifier,
) : LiveNluResolver {

    constructor() : this(RuleBasedBreathingNluClassifier())

    override suspend fun resolveIntent(request: LiveNluRequest): LiveNluResolution? {
        val transcript = request.transcript.trim()
        if (transcript.isEmpty()) return null

        val policy = EdgeNluPolicy.forStage(request.stage) ?: return null
        val resolution = classifier.classify(transcript) ?: return null
        val intent = resolution.intent?.trim().orEmpty()
        if (intent !in policy.allowedIntents) return null

        return resolution
    }
}

internal fun interface EdgeBreathingNluClassifier {
    fun classify(transcript: String): LiveNluResolution?
}

internal class RuleBasedBreathingNluClassifier : EdgeBreathingNluClassifier {

    override fun classify(transcript: String): LiveNluResolution? {
        val text = transcript.normalizedForBreathingNlu()
        if (text.isEmpty()) return null

        val agonal = AGONAL_PATTERNS.any { it.containsMatchIn(text) }
        if (agonal) {
            return LiveNluResolution(intent = INTENT_AGONAL, confidence = 0.92)
        }

        val absent = ABSENT_PATTERNS.any { it.containsMatchIn(text) }
        val present = PRESENT_PATTERNS.any { it.containsMatchIn(text) }
        val uncertain = UNCERTAIN_PATTERNS.any { it.containsMatchIn(text) } ||
            QUESTION_PATTERNS.any { it.containsMatchIn(text) }

        if (uncertain || (absent && present)) {
            return LiveNluResolution(
                intent = INTENT_CLARIFY,
                confidence = 0.62,
                needsClarification = true,
            )
        }

        if (absent) {
            return LiveNluResolution(intent = INTENT_NO_NORMAL, confidence = 0.88)
        }

        if (present) {
            return LiveNluResolution(intent = INTENT_NORMAL, confidence = 0.86)
        }

        return null
    }

    private fun String.normalizedForBreathingNlu(): String =
        lowercase(Locale.ROOT)
            .replace(Regex("""[\s　，。！？、,.!?；;："“”'‘’（）()【】\[\]-]+"""), "")

    companion object {
        private const val INTENT_NO_NORMAL = "no_normal_breathing"
        private const val INTENT_NORMAL = "normal_breathing"
        private const val INTENT_AGONAL = "agonal_breathing"
        private const val INTENT_CLARIFY = "clarify_breathing"

        private val AGONAL_PATTERNS = listOf(
            "喘息",
            "濒死呼吸",
            "喘一下",
            "偶尔喘",
            "只是喘",
            "只有.*喘",
            "一阵一阵喘",
            "点头样呼吸",
            "点头一样呼吸",
            "偶尔点头",
            "gasping",
            "agonal",
        ).map(::Regex)

        private val ABSENT_PATTERNS = listOf(
            "没有正常呼吸",
            "没正常呼吸",
            "无正常呼吸",
            "没有呼吸",
            "没呼吸",
            "无呼吸",
            "不能呼吸",
            "停止呼吸",
            "没气",
            "没有气",
            "没喘气",
            "胸口(?:没|没有|不)(?:动|起伏)",
            "看不到(?:胸口)?起伏",
            "呼吸不正常",
            "不正常呼吸",
            "呼吸很弱",
            "呼吸弱",
            "notbreathing",
            "nobreathing",
            "abnormalbreathing",
        ).map(::Regex)

        private val PRESENT_PATTERNS = listOf(
            "(?<!没)(?<!无)有正常呼吸",
            "呼吸正常",
            "(?<!没有)(?<!没)(?<!无)正常地?呼吸",
            "胸口有起伏",
            "看到(?:胸口)?起伏",
            "(?<!没)(?<!无)有呼吸了?",
            "在呼吸",
            "breathingnormally",
            "normalbreathing",
        ).map(::Regex)

        private val UNCERTAIN_PATTERNS = listOf(
            "不确定",
            "不太确定",
            "说不清",
            "说不好",
            "看不清",
            "看不太清",
            "不清楚",
            "好像",
            "似乎",
            "可能",
            "也许",
            "不知道",
        ).map(::Regex)

        private val QUESTION_PATTERNS = listOf(
            "有没有呼吸",
            "是否有呼吸",
            "有呼吸吗",
            "有呼吸么",
            "有呼吸嘛",
            "没有呼吸吗",
            "没呼吸吗",
            "呼吸了吗",
        ).map(::Regex)
    }
}
