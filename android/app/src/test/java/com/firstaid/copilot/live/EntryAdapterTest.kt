package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EntryAdapterTest {
    @Test
    fun oneKeyButton_seedsOneKeyPriorsWithoutWakePhrase() {
        val json = firstAidSessionStartedRequest("session_one_key", EntrySource.OneKeyButton).toJson()

        // Same seed event regardless of entry source.
        assertEquals("demo_script", json.getString("eventSource"))
        assertEquals("session_started", json.getString("eventType"))

        val metadata = json.getJSONObject("metadata")
        assertEquals("one_key_button", metadata.getString("entry_source"))
        assertEquals("one_key_first_aid", metadata.getString("scene_note"))
        assertEquals(true, metadata.getBoolean("adult_likely"))
        assertEquals(true, metadata.getBoolean("recording"))
        assertFalse("one-key entry must not carry a wake phrase", metadata.has("wake_phrase"))

        // Client never asserts a medical verdict at entry.
        assertFalse(json.has("patientState"))
    }

    @Test
    fun oneKeyButton_isTheDefaultEntrySource() {
        val metadata = firstAidSessionStartedRequest("session_default").toJson().getJSONObject("metadata")
        assertEquals("one_key_button", metadata.getString("entry_source"))
        assertEquals("one_key_first_aid", metadata.getString("scene_note"))
    }

    @Test
    fun wakePhrase_seedsPhraseAsPriorOnly() {
        val phrase = "有人没有呼吸了"
        val json = firstAidSessionStartedRequest("session_wake", EntrySource.WakePhrase(phrase)).toJson()

        // Triggers the SAME seed event as the one-key button.
        assertEquals("demo_script", json.getString("eventSource"))
        assertEquals("session_started", json.getString("eventType"))

        val metadata = json.getJSONObject("metadata")
        assertEquals("wake_phrase", metadata.getString("entry_source"))
        assertEquals("wake_phrase_entry", metadata.getString("scene_note"))
        assertEquals(phrase, metadata.getString("wake_phrase"))
        assertEquals(true, metadata.getBoolean("adult_likely"))

        // The phrase is a prior only: the client never declares no_breathing here.
        assertFalse(json.has("patientState"))
        assertFalse(metadata.has("no_breathing"))
        assertFalse(metadata.has("normal_breathing"))
    }

    @Test
    fun matchWakePhrase_acceptsEmergencyPhrases() {
        assertNotNull(matchWakePhrase("有人没有呼吸了"))
        assertNotNull(matchWakePhrase("快来，有人晕倒了"))
        assertNotNull(matchWakePhrase("他没有反应"))
        assertNotNull(matchWakePhrase(DEMO_WAKE_PHRASE))
        assertEquals("有人没有呼吸了", matchWakePhrase("  有人没有呼吸了  "))
    }

    @Test
    fun matchWakePhrase_rejectsNonEmergencyOrEmpty() {
        assertNull(matchWakePhrase("今天天气不错"))
        assertNull(matchWakePhrase("  "))
        assertNull(matchWakePhrase(null))
        assertNull(matchWakePhrase(""))
    }

    @Test
    fun demoWakePhrase_isRecognized() {
        assertTrue(matchWakePhrase(DEMO_WAKE_PHRASE) != null)
    }
}
