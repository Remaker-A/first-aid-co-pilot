package com.firstaid.copilot.live.edge

import com.firstaid.copilot.live.LiveNluRequest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeTinyNluResolverTest {

    private val resolver = EdgeTinyNluResolver()

    @Test
    fun agonalBreathingPhrasesResolveWithoutGemma() = runTest {
        listOf(
            "他只有偶尔喘息",
            "只是偶尔喘一下",
            "好像没有呼吸，偶尔喘一下",
        ).forEach { transcript ->
            val result = resolve(transcript)

            assertTrue(transcript, result?.intent == "agonal_breathing")
            assertFalse(transcript, result?.needsClarification ?: true)
            assertTrue(transcript, (result?.confidence ?: 0.0) >= 0.78)
        }
    }

    @Test
    fun absentBreathingPhrasesResolveToNoNormalBreathing() = runTest {
        listOf(
            "他没有呼吸",
            "没正常呼吸",
            "胸口看不到起伏",
            "呼吸很弱",
        ).forEach { transcript ->
            val result = resolve(transcript)

            assertTrue(transcript, result?.intent == "no_normal_breathing")
            assertFalse(transcript, result?.needsClarification ?: true)
            assertTrue(transcript, (result?.confidence ?: 0.0) >= 0.78)
        }
    }

    @Test
    fun presentBreathingPhrasesResolveToNormalBreathing() = runTest {
        listOf(
            "他有正常呼吸",
            "胸口有起伏",
            "他现在呼吸正常",
        ).forEach { transcript ->
            val result = resolve(transcript)

            assertTrue(transcript, result?.intent == "normal_breathing")
            assertFalse(transcript, result?.needsClarification ?: true)
        }
    }

    @Test
    fun uncertainBreathingPhrasesAskForClarification() = runTest {
        listOf(
            "我看不太清楚他有没有呼吸",
            "不确定",
            "他好像没气",
            "有呼吸吗",
        ).forEach { transcript ->
            val result = resolve(transcript)

            assertTrue(transcript, result?.intent == "clarify_breathing")
            assertTrue(transcript, result?.needsClarification ?: false)
        }
    }

    @Test
    fun resolverIsStageScopedAndNeverEmitsArrestIntent() = runTest {
        // No baked policy outside S3 → decline (the hot path already committed).
        assertNull(resolve("他没有呼吸", stage = "S7_CPR_LOOP"))

        val allowed = EdgeNluPolicy.forStage(S3)?.allowedIntents.orEmpty()
        listOf(
            "他没有呼吸",
            "他有正常呼吸",
            "只是偶尔喘一下",
            "我看不清有没有呼吸",
        ).forEach { transcript ->
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
