package com.firstaid.copilot.execution

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GuidanceFixtureRepositoryAndroidTest {
    @Test
    fun loadFixtures_readsManifestAndParsesAllActions() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixtures = GuidanceFixtureRepository(context.assets).loadFixtures()

        assertEquals(8, fixtures.size)
        assertEquals("01_ui_tts_response_check.json", fixtures.first().fileName)
        assertEquals("08_unknown_intent_fallback.json", fixtures.last().fileName)
        assertTrue(fixtures.all { it.action.action_id.isNotBlank() })
        assertTrue(fixtures.all { it.expectedChannels.isNotEmpty() })
    }
}
