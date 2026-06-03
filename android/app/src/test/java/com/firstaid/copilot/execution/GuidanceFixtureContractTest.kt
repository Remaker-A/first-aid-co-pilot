package com.firstaid.copilot.execution

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test

class GuidanceFixtureContractTest {
    @Test
    fun manifestFixturesMatchExpectedAndroidChannels() {
        val assetsDir = File("src/main/assets/fixtures")
        val manifest = JSONObject(assetsDir.resolve("manifest.json").readText(Charsets.UTF_8))
        val fixtures = manifest.getJSONArray("fixtures")
        val dispatcher = GuidanceActionDispatcher()
        val failures = mutableListOf<String>()

        for (index in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(index)
            val fileName = fixture.getString("file")
            val expected = fixture.getJSONArray("expected_android_channels").stringValues()
            val action = parseAction(JSONObject(assetsDir.resolve(fileName).readText(Charsets.UTF_8)))
            val result = dispatcher.dispatch(action, DispatchContext(knownIntents = KNOWN_TEST_INTENTS))
            val observed = result.observedAndroidChannels(action)
            val missing = expected.filterNot { it in observed }
            if (missing.isNotEmpty()) {
                failures += "$fileName missing=${missing.joinToString(",")} observed=${observed.joinToString(",")}"
            }
        }

        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    private fun DispatchResult.observedAndroidChannels(action: GuidanceAction): Set<String> {
        val observed = linkedSetOf<String>()
        deliveries.forEach { delivery ->
            if (delivery.status == DeliveryStatus.DELIVERED) {
                if (delivery.channel == "ui" && fallback) {
                    observed += "ui_fallback"
                } else {
                    observed += delivery.channel
                }
            }
            if (delivery.channel == "tool" && delivery.status == DeliveryStatus.BLOCKED) {
                observed += "tool_blocked"
            }
        }
        if (action.log_event != null) {
            observed += "log"
        }
        return observed
    }

    private fun org.json.JSONArray.stringValues(): List<String> =
        (0 until length()).map { index -> getString(index) }

    private companion object {
        val KNOWN_TEST_INTENTS = setOf(
            "ask_response_check",
            "start_cpr_loop",
            "continue_cpr_loop",
            "stop_cpr_loop",
            "start_emergency_call_and_cpr",
            "share_recorded_video",
            "render_guidance",
            "defer_to_critical_action",
            "noop",
        )
    }
}
