package com.firstaid.copilot.live

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity tests for the on-device phonetic safety net. They parse the SAME shipped
 * word table the app loads from assets (knowledge/phonetic_intents.json) so the
 * Kotlin twin and the desktop matcher (test/phonetic-intent.test.js) cannot drift.
 */
class LivePhoneticIntentRouterTest {
    private val config: PhoneticIntentConfig =
        parsePhoneticIntentConfig(readSharedConfigJson())
            ?: error("phonetic_intents.json must parse into a usable config")

    @Test
    fun sharedConfigShipsTheCriticalClosedSetIntents() {
        val intents = config.intents.map { it.intent }.sorted()
        assertEquals(
            listOf(
                "aed_available",
                "ask_aed_cpr_alternation",
                "ask_aed_help",
                "ask_can_stop",
                "ask_cpr_quality",
                "ask_emergency_call",
            ),
            intents,
        )
        assertEquals(setOf("S6_CPR_READY", "S7_CPR_LOOP", "S8_ASSISTANCE"), config.stages)
        for (ch in "出差移除颤仪心脏起搏器交替配合轮换我爱的得对位置节奏质量样压行数术异") {
            assertNotNull("pinyin table must cover $ch", config.pinyin[ch.toString()])
        }
    }

    @Test
    fun rescuesTheDocumentedAedMishearing() {
        val match = LivePhoneticIntentRouter.infer("出差移来了怎么办", "S7_CPR_LOOP", config)
        assertNotNull(match)
        assertEquals("aed_available", match?.intent)
        assertTrue((match?.confidence ?: 0.0) >= 0.7)
    }

    @Test
    fun matchesFurtherHomophoneVariantsInCprLiveStages() {
        assertEquals("aed_available", LivePhoneticIntentRouter.infer("出柴疑来了怎么办", "S7_CPR_LOOP", config)?.intent)
        assertEquals("ask_aed_help", LivePhoneticIntentRouter.infer("除颤仪在哪", "S8_ASSISTANCE", config)?.intent)
        assertEquals("ask_aed_help", LivePhoneticIntentRouter.infer("数差异怎么用", "S7_CPR_LOOP", config)?.intent)
        assertEquals("aed_available", LivePhoneticIntentRouter.infer("心脏起搏器来了", "S7_CPR_LOOP", config)?.intent)
        assertEquals("ask_can_stop", LivePhoneticIntentRouter.infer("能不能婷", "S7_CPR_LOOP", config)?.intent)
        assertEquals(
            "ask_aed_cpr_alternation",
            LivePhoneticIntentRouter.infer("出差移和按压怎么交替", "S8_ASSISTANCE", config)?.intent,
        )
        assertEquals(
            "ask_emergency_call",
            LivePhoneticIntentRouter.infer("急就电话要不要打", "S7_CPR_LOOP", config)?.intent,
        )
        assertEquals(
            "ask_cpr_quality",
            LivePhoneticIntentRouter.infer("我爱的可以吗", "S7_CPR_LOOP", config)?.intent,
        )
    }

    @Test
    fun doesNotFireOutsideCprLiveStages() {
        assertNull(LivePhoneticIntentRouter.infer("出差移来了怎么办", "S2_CHECK_RESPONSE", config))
        assertNull(LivePhoneticIntentRouter.infer("出差移来了怎么办", "S1_SCENE_SAFE", config))
    }

    @Test
    fun doesNotFalseTriggerOnUnrelatedOrTriggerOnlyOrPrefixCollisions() {
        // Unrelated worry with a question suffix but no keyword.
        assertNull(LivePhoneticIntentRouter.infer("我有点紧张怎么办", "S7_CPR_LOOP", config))
        // Trigger word alone, no keyword.
        assertNull(LivePhoneticIntentRouter.infer("在哪里", "S7_CPR_LOOP", config))
        // Shared prefix 能不能 but 救/jiu != 停/ting must stay an open question.
        assertNull(LivePhoneticIntentRouter.infer("他还能不能救回来呀", "S7_CPR_LOOP", config))
        // Keyword-only mention with no question form (require_trigger).
        assertNull(LivePhoneticIntentRouter.infer("我去拿除颤仪", "S7_CPR_LOOP", config))
        // Warm emotional speech alone must not become a CPR-quality question.
        assertNull(LivePhoneticIntentRouter.infer("我爱你", "S7_CPR_LOOP", config))
        // Blank.
        assertNull(LivePhoneticIntentRouter.infer("   ", "S7_CPR_LOOP", config))
    }

    @Test
    fun disabledWhenNoConfigLoaded() {
        assertNull(LivePhoneticIntentRouter.infer("出差移来了怎么办", "S7_CPR_LOOP", null))
    }

    private fun readSharedConfigJson(): String {
        val candidates = listOf(
            "src/main/assets/phonetic_intents.json",
            "app/src/main/assets/phonetic_intents.json",
            "android/app/src/main/assets/phonetic_intents.json",
            "../../knowledge/phonetic_intents.json",
            "knowledge/phonetic_intents.json",
        )
        val start = File(System.getProperty("user.dir") ?: ".").absoluteFile
        // Try each candidate relative to the working dir and every parent up to the root.
        var dir: File? = start
        while (dir != null) {
            for (candidate in candidates) {
                val file = File(dir, candidate)
                if (file.isFile) {
                    return file.readText(Charsets.UTF_8)
                }
            }
            dir = dir.parentFile
        }
        error("Could not locate phonetic_intents.json from ${start.absolutePath}")
    }
}
