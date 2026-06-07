package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.LiveNluRequest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rule-classifier intent-mapping coverage for the default (rule-based)
 * [EdgeTinyNluResolver]. The prototype router itself is covered by
 * [EdgeBreathingNluPrototypeRouterTest]; this locks in the closed-set mapping and
 * the safety-relevant "没正常呼吸 → no_normal_breathing" case.
 */
class EdgeTinyNluResolverTest {

    private val resolver = EdgeTinyNluResolver()

    @Test
    fun absentBreathingMapsToNoNormalBreathing() = runTest {
        listOf("他没有呼吸", "他没气了", "停止呼吸").forEach { transcript ->
            assertEquals(transcript, "no_normal_breathing", resolve(transcript)?.intent)
        }
    }

    @Test
    fun negatedNormalBreathingIsNoNormalBreathingNotNormal() = runTest {
        // Safety: "没正常呼吸" must not be misread as normal_breathing via the
        // "正常呼吸" substring; the missing-breathing reading wins.
        val result = resolve("没正常呼吸")
        assertEquals("no_normal_breathing", result?.intent)
        assertFalse(result?.needsClarification ?: true)
    }

    @Test
    fun absentChestMovementMapsToNormalBreathingAbsent() = runTest {
        assertEquals("normal_breathing_absent", resolve("胸口没有起伏")?.intent)
    }

    @Test
    fun presentBreathingMapsToNormalBreathing() = runTest {
        assertEquals("normal_breathing", resolve("他有正常呼吸")?.intent)
    }

    @Test
    fun presentChestMovementMapsToNormalBreathingPresent() = runTest {
        assertEquals("normal_breathing_present", resolve("胸口有起伏")?.intent)
    }

    @Test
    fun agonalPhraseMapsToAgonalBreathing() = runTest {
        listOf("只是偶尔喘一下", "疑似濒死呼吸").forEach { transcript ->
            assertEquals(transcript, "agonal_breathing", resolve(transcript)?.intent)
        }
    }

    @Test
    fun breathingQuestionAsksForClarification() = runTest {
        val result = resolve("有呼吸吗")
        assertEquals("clarify_breathing", result?.intent)
        assertTrue(result?.needsClarification ?: false)
    }

    @Test
    fun staysStageScopedAndNeverEmitsArrestIntent() = runTest {
        // No baked policy outside S3 → decline (the hot path already committed).
        assertNull(resolve("他没有呼吸", stage = "S2_CHECK_RESPONSE"))

        val allowed = EdgeNluPolicy.forStage(S3)?.allowedIntents.orEmpty()
        listOf("他没有呼吸", "没正常呼吸", "他有正常呼吸", "只是偶尔喘一下").forEach { transcript ->
            val result = resolve(transcript)
            assertTrue(transcript, result != null)
            assertTrue(transcript, allowed.any { it == result!!.intent })
            assertFalse(transcript, result!!.intent == "suspected_cardiac_arrest")
        }
    }

    private suspend fun resolve(
        transcript: String,
        stage: String = S3,
    ) = resolver.resolveIntent(LiveNluRequest(transcript = transcript, stage = stage))

    private companion object {
        const val S3 = "S3_CHECK_BREATHING"
    }
}
