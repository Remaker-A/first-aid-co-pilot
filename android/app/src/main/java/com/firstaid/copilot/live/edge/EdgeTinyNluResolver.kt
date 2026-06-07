package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.LiveNluRequest
import com.firstaid.copilot.live.LiveNluResolution
import com.firstaid.copilot.live.LiveNluResolver
import kotlin.math.sqrt

internal fun interface EdgeBreathingNluClassifier {
    fun classify(transcript: String): LiveNluResolution?
}

internal fun interface TextEmbeddingProvider {
    fun embed(text: String): FloatArray?
}

/**
 * Deterministic breathing-only NLU resolver for S3_CHECK_BREATHING.
 *
 * The public no-arg constructor intentionally keeps the current behavior on the
 * local rule set. Model-backed variants are injected through the internal
 * constructor or created via [EdgeBreathingNluResolvers].
 */
class EdgeTinyNluResolver internal constructor(
    private val classifier: EdgeBreathingNluClassifier,
) : LiveNluResolver, AutoCloseable {

    constructor() : this(RuleBasedBreathingNluClassifier())

    internal val classifierDebugName: String
        get() = classifier::class.java.simpleName.ifBlank { classifier::class.java.name }

    override suspend fun resolveIntent(request: LiveNluRequest): LiveNluResolution? {
        val policy = EdgeNluPolicy.forStage(request.stage) ?: return null
        val resolution = classifier.classify(request.transcript) ?: return null
        val intent = resolution.intent?.trim().orEmpty()
        if (intent.isEmpty()) return null
        if (intent !in policy.allowedIntents) return null
        return resolution
    }

    override fun close() {
        (classifier as? AutoCloseable)?.close()
    }
}

internal class RuleBasedBreathingNluClassifier : EdgeBreathingNluClassifier {
    override fun classify(transcript: String): LiveNluResolution? {
        val text = transcript.trim()
        if (text.isEmpty()) return null
        val compact = text.replace(Regex("\\s+"), "")
        return when {
            BREATHING_QUESTION_PATTERN.containsMatchIn(compact) ->
                clarification(confidence = 0.42)

            AGONAL_PATTERN.containsMatchIn(text) ->
                resolution("agonal_breathing", confidence = 0.91)

            ABSENT_NORMAL_PATTERN.containsMatchIn(text) ->
                resolution("no_normal_breathing", confidence = 0.88)

            ABSENT_MOVEMENT_PATTERN.containsMatchIn(text) ->
                resolution("normal_breathing_absent", confidence = 0.86)

            PRESENT_NORMAL_PATTERN.containsMatchIn(text) ->
                resolution("normal_breathing", confidence = 0.88)

            PRESENT_MOVEMENT_PATTERN.containsMatchIn(text) ->
                resolution("normal_breathing_present", confidence = 0.84)

            UNCERTAIN_PATTERN.containsMatchIn(text) ->
                clarification(confidence = 0.45)

            else -> null
        }
    }

    private fun resolution(intent: String, confidence: Double): LiveNluResolution =
        LiveNluResolution(intent = intent, confidence = confidence, needsClarification = false)

    private fun clarification(confidence: Double): LiveNluResolution =
        LiveNluResolution(intent = CLARIFY_BREATHING, confidence = confidence, needsClarification = true)

    private companion object {
        private val BREATHING_QUESTION_PATTERN = Regex(
            "(有没有|是否|是不是|算不算|还算|有无).{0,8}(呼吸|喘气|起伏)|(呼吸|喘气|起伏).{0,6}(吗|么|嘛|呢)",
            RegexOption.IGNORE_CASE,
        )
        private val AGONAL_PATTERN = Regex(
            "(agonal|gasping|濒死呼吸|喘息|偶尔喘|只是?喘|点头样呼吸|点头一样呼吸|偶尔点头)",
            RegexOption.IGNORE_CASE,
        )
        private val ABSENT_NORMAL_PATTERN = Regex(
            // "有" is optional so "没正常呼吸" (no 有) is caught here as no_normal_breathing
            // instead of falling through to PRESENT_NORMAL on the "正常呼吸" substring.
            "(没\\s*有?\\s*正常呼吸|无\\s*正常呼吸|呼吸不正常|不正常呼吸|没有呼吸|没呼吸|无呼吸|没气|没有气|没喘气|停止呼吸|不喘气|not breathing|no breathing|abnormal breathing)",
            RegexOption.IGNORE_CASE,
        )
        private val ABSENT_MOVEMENT_PATTERN = Regex(
            "(胸口|胸部|胸廓|肚子|腹部).{0,6}(没|没有|不|看不到).{0,6}(动|起伏)|(看不到|没有).{0,6}(胸口|胸部|胸廓|肚子|腹部).{0,6}(动|起伏)",
            RegexOption.IGNORE_CASE,
        )
        private val PRESENT_NORMAL_PATTERN = Regex(
            "(有正常呼吸|正常呼吸|呼吸正常|呼吸平稳|breathing normally|normal breathing)",
            RegexOption.IGNORE_CASE,
        )
        private val PRESENT_MOVEMENT_PATTERN = Regex(
            "(胸口|胸部|胸廓|肚子|腹部).{0,6}(有|看到|能看到).{0,6}(动|起伏)|(有|看到|能看到).{0,6}(胸口|胸部|胸廓|肚子|腹部).{0,6}(动|起伏)",
            RegexOption.IGNORE_CASE,
        )
        private val UNCERTAIN_PATTERN = Regex(
            "(不确定|不知道|看不清|听不清|说不准|分不清|好像|可能).{0,10}(呼吸|喘气|起伏)|呼吸.{0,6}(不确定|不清楚|说不准)",
            RegexOption.IGNORE_CASE,
        )
    }
}

internal data class BreathingNluPrototypePhrase(
    val intent: String,
    val text: String,
)

internal data class BreathingNluPrototypeVector(
    val intent: String,
    val text: String,
    val vector: FloatArray,
)

internal class BreathingNluPrototypeRouter(
    prototypes: List<BreathingNluPrototypeVector>,
    private val minConfidence: Double = DEFAULT_MIN_CONFIDENCE,
    private val ambiguityMargin: Double = DEFAULT_AMBIGUITY_MARGIN,
) {
    private val prototypes: List<BreathingNluPrototypeVector> =
        prototypes.filter { it.intent in BREATHING_NLU_ALLOWED_INTENTS && it.vector.isNotEmpty() }

    fun classify(queryVector: FloatArray): LiveNluResolution {
        val bestByIntent = prototypes
            .mapNotNull { prototype ->
                val score = cosineSimilarity(queryVector, prototype.vector)
                if (score.isFinite()) ScoredIntent(prototype.intent, score) else null
            }
            .groupBy { it.intent }
            .mapValues { (_, scores) -> scores.maxOf { it.score } }
            .entries
            .sortedByDescending { it.value }

        val best = bestByIntent.firstOrNull() ?: return clarify(confidence = 0.0)
        val second = bestByIntent.drop(1).firstOrNull()
        val confidence = best.value.coerceIn(0.0, 1.0)
        val isAmbiguous = second != null && best.value - second.value < ambiguityMargin
        val shouldClarify = best.key == CLARIFY_BREATHING || best.value < minConfidence || isAmbiguous
        return if (shouldClarify) {
            clarify(confidence = confidence)
        } else {
            LiveNluResolution(intent = best.key, confidence = confidence, needsClarification = false)
        }
    }

    private fun clarify(confidence: Double): LiveNluResolution =
        LiveNluResolution(intent = CLARIFY_BREATHING, confidence = confidence, needsClarification = true)

    private data class ScoredIntent(val intent: String, val score: Double)

    companion object {
        const val DEFAULT_MIN_CONFIDENCE: Double = 0.68
        const val DEFAULT_AMBIGUITY_MARGIN: Double = 0.04
    }
}

internal fun buildBreathingNluPrototypeRouter(
    phrases: List<BreathingNluPrototypePhrase>,
    embedder: TextEmbeddingProvider,
    minConfidence: Double = BreathingNluPrototypeRouter.DEFAULT_MIN_CONFIDENCE,
    ambiguityMargin: Double = BreathingNluPrototypeRouter.DEFAULT_AMBIGUITY_MARGIN,
): BreathingNluPrototypeRouter? {
    val vectors = phrases.mapNotNull { phrase ->
        embedder.embed(phrase.text)?.let { vector ->
            BreathingNluPrototypeVector(phrase.intent, phrase.text, vector)
        }
    }
    return vectors.takeIf { it.isNotEmpty() }?.let {
        BreathingNluPrototypeRouter(
            prototypes = it,
            minConfidence = minConfidence,
            ambiguityMargin = ambiguityMargin,
        )
    }
}

internal fun cosineSimilarity(left: FloatArray, right: FloatArray): Double {
    if (left.isEmpty() || left.size != right.size) return Double.NaN
    var dot = 0.0
    var leftNorm = 0.0
    var rightNorm = 0.0
    for (index in left.indices) {
        val l = left[index].toDouble()
        val r = right[index].toDouble()
        dot += l * r
        leftNorm += l * l
        rightNorm += r * r
    }
    if (leftNorm == 0.0 || rightNorm == 0.0) return Double.NaN
    return dot / sqrt(leftNorm * rightNorm)
}

internal const val CLARIFY_BREATHING = "clarify_breathing"

internal val BREATHING_NLU_ALLOWED_INTENTS: Set<String> = setOf(
    "no_normal_breathing",
    "normal_breathing",
    "normal_breathing_absent",
    "normal_breathing_present",
    "agonal_breathing",
    CLARIFY_BREATHING,
)

internal val DEFAULT_BREATHING_NLU_PROTOTYPE_PHRASES: List<BreathingNluPrototypePhrase> = listOf(
    BreathingNluPrototypePhrase("no_normal_breathing", "他没有正常呼吸"),
    BreathingNluPrototypePhrase("no_normal_breathing", "呼吸不正常"),
    BreathingNluPrototypePhrase("no_normal_breathing", "他没气了"),
    BreathingNluPrototypePhrase("no_normal_breathing", "没有稳定的呼吸"),
    BreathingNluPrototypePhrase("normal_breathing", "他有正常呼吸"),
    BreathingNluPrototypePhrase("normal_breathing", "呼吸平稳规律"),
    BreathingNluPrototypePhrase("normal_breathing", "能正常喘气"),
    BreathingNluPrototypePhrase("normal_breathing_absent", "胸口没有起伏"),
    BreathingNluPrototypePhrase("normal_breathing_absent", "看不到胸部起伏"),
    BreathingNluPrototypePhrase("normal_breathing_absent", "没有呼吸起伏"),
    BreathingNluPrototypePhrase("normal_breathing_present", "胸口有规律起伏"),
    BreathingNluPrototypePhrase("normal_breathing_present", "能看到胸部上下动"),
    BreathingNluPrototypePhrase("normal_breathing_present", "腹部还有呼吸起伏"),
    BreathingNluPrototypePhrase("agonal_breathing", "只是偶尔喘一下"),
    BreathingNluPrototypePhrase("agonal_breathing", "像点头样呼吸"),
    BreathingNluPrototypePhrase("agonal_breathing", "疑似濒死呼吸"),
    BreathingNluPrototypePhrase(CLARIFY_BREATHING, "我不确定有没有呼吸"),
    BreathingNluPrototypePhrase(CLARIFY_BREATHING, "看不清楚胸口起伏"),
    BreathingNluPrototypePhrase(CLARIFY_BREATHING, "不知道这算不算正常呼吸"),
)
