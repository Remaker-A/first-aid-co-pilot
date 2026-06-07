package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.LiveNluRequest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeBreathingNluPrototypeRouterTest {
    @Test
    fun cosineSimilarityHandlesUnitVectorsAndInvalidInput() {
        assertEquals(1.0, cosineSimilarity(floatArrayOf(1f, 0f), floatArrayOf(2f, 0f)), 0.0001)
        assertEquals(0.0, cosineSimilarity(floatArrayOf(1f, 0f), floatArrayOf(0f, 1f)), 0.0001)
        assertTrue(cosineSimilarity(floatArrayOf(1f), floatArrayOf(1f, 0f)).isNaN())
        assertTrue(cosineSimilarity(floatArrayOf(0f, 0f), floatArrayOf(1f, 0f)).isNaN())
    }

    @Test
    fun routesNearestAllowedPrototypeToIntent() {
        val router = BreathingNluPrototypeRouter(
            prototypes = listOf(
                prototype("normal_breathing", 1f, 0f, 0f),
                prototype("no_normal_breathing", 0f, 1f, 0f),
                prototype("agonal_breathing", 0f, 0f, 1f),
            ),
        )

        val resolution = router.classify(floatArrayOf(0.05f, 0.98f, 0f))

        assertEquals("no_normal_breathing", resolution.intent)
        assertFalse(resolution.needsClarification)
        assertTrue(resolution.confidence > 0.95)
    }

    @Test
    fun lowConfidenceReturnsClarification() {
        val router = BreathingNluPrototypeRouter(
            prototypes = listOf(
                prototype("normal_breathing", 1f, 0f),
                prototype("no_normal_breathing", 0f, 1f),
            ),
            minConfidence = 0.8,
        )

        val resolution = router.classify(floatArrayOf(0.55f, 0.55f))

        assertEquals(CLARIFY_BREATHING, resolution.intent)
        assertTrue(resolution.needsClarification)
    }

    @Test
    fun closeScoresReturnClarificationInsteadOfHardIntent() {
        val router = BreathingNluPrototypeRouter(
            prototypes = listOf(
                prototype("normal_breathing", 1f, 0f),
                prototype("normal_breathing_absent", 0.98f, 0.2f),
            ),
            minConfidence = 0.5,
            ambiguityMargin = 0.05,
        )

        val resolution = router.classify(floatArrayOf(1f, 0f))

        assertEquals(CLARIFY_BREATHING, resolution.intent)
        assertTrue(resolution.needsClarification)
    }

    @Test
    fun filtersPrototypeIntentsOutsideClosedSet() {
        val router = BreathingNluPrototypeRouter(
            prototypes = listOf(
                prototype("suspected_cardiac_arrest", 1f, 0f),
                prototype("normal_breathing", 0f, 1f),
            ),
            minConfidence = 0.8,
        )

        val resolution = router.classify(floatArrayOf(1f, 0f))

        assertEquals(CLARIFY_BREATHING, resolution.intent)
        assertTrue(resolution.needsClarification)
    }

    @Test
    fun buildsRouterFromInjectedFakeEmbedder() {
        val fake = TextEmbeddingProvider { text ->
            when (text) {
                "没有呼吸样例" -> floatArrayOf(1f, 0f)
                "正常呼吸样例" -> floatArrayOf(0f, 1f)
                else -> null
            }
        }

        val router = buildBreathingNluPrototypeRouter(
            phrases = listOf(
                BreathingNluPrototypePhrase("no_normal_breathing", "没有呼吸样例"),
                BreathingNluPrototypePhrase("normal_breathing", "正常呼吸样例"),
            ),
            embedder = fake,
        )

        val resolution = requireNotNull(router).classify(floatArrayOf(0.98f, 0.05f))
        assertEquals("no_normal_breathing", resolution.intent)
    }

    @Test
    fun defaultTinyResolverStaysRuleBasedAndStageScoped() = runTest {
        val resolver = EdgeTinyNluResolver()

        val resolution = resolver.resolveIntent(
            LiveNluRequest(transcript = "胸口没有起伏", stage = "S3_CHECK_BREATHING"),
        )

        assertEquals("normal_breathing_absent", resolution?.intent)
        assertNull(resolver.resolveIntent(LiveNluRequest(transcript = "胸口没有起伏", stage = "S2_CHECK_RESPONSE")))
    }

    private fun prototype(intent: String, vararg values: Float): BreathingNluPrototypeVector =
        BreathingNluPrototypeVector(intent = intent, text = "$intent prototype", vector = values)
}
