package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Test

class FirstAidStartRequestTest {
    @Test
    fun firstAidSessionStartedRequest_serializesDesignStartPayload() {
        val json = firstAidSessionStartedRequest("session_design_start").toJson()

        assertEquals("session_design_start", json.getString("sessionId"))
        assertEquals("demo_script", json.getString("eventSource"))
        assertEquals("session_started", json.getString("eventType"))

        val deviceState = json.getJSONObject("deviceState")
        assertEquals(true, deviceState.getBoolean("camera_available"))
        assertEquals(true, deviceState.getBoolean("mic_available"))
        assertEquals(true, deviceState.getBoolean("gps_available"))
        assertEquals(true, deviceState.getBoolean("recording"))
        assertEquals(false, deviceState.getBoolean("emergency_call_started"))
        assertEquals("offline", deviceState.getString("network"))

        val metadata = json.getJSONObject("metadata")
        assertEquals(true, metadata.getBoolean("adult_likely"))
        assertEquals(true, metadata.getBoolean("recording"))
        assertEquals("one_key_first_aid", metadata.getString("scene_note"))
    }
}
