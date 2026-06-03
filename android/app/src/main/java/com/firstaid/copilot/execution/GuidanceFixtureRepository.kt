package com.firstaid.copilot.execution

import android.content.res.AssetManager
import org.json.JSONArray
import org.json.JSONObject

data class GuidanceFixture(
    val fileName: String,
    val expectedChannels: List<String>,
    val action: GuidanceAction,
)

class GuidanceFixtureRepository(
    private val assets: AssetManager,
) {
    fun loadFixtures(): List<GuidanceFixture> {
        val manifest = JSONObject(readAsset("fixtures/manifest.json"))
        return manifest.optJSONArray("fixtures").orEmptyJsonObjects().mapNotNull { item ->
            val fileName = item.optString("file").takeIf(String::isNotBlank) ?: return@mapNotNull null
            GuidanceFixture(
                fileName = fileName,
                expectedChannels = item.optStringList("expected_android_channels"),
                action = parseAction(JSONObject(readAsset("fixtures/$fileName"))),
            )
        }
    }

    private fun readAsset(path: String): String =
        assets.open(path).bufferedReader(Charsets.UTF_8).use { it.readText() }
}

fun parseAction(json: JSONObject): GuidanceAction =
    GuidanceAction(
        schema_version = json.optString("schema_version", GUIDANCE_ACTION_SCHEMA_VERSION),
        action_id = json.getString("action_id"),
        session_id = json.optNullableString("session_id"),
        timestamp = json.getString("timestamp"),
        stage = json.getString("stage"),
        intent = json.getString("intent"),
        priority = json.optString("priority", Priority.NORMAL.value),
        source = json.optString("source", "unknown"),
        reason_codes = json.optStringList("reason_codes"),
        ttl_ms = json.optLong("ttl_ms", 5000),
        throttle_key = json.optNullableString("throttle_key"),
        min_interval_ms = json.optLong("min_interval_ms", 0),
        tts = parseTts(json.optJSONObject("tts")),
        ui = parseUi(json.optJSONObject("ui")),
        haptic = parseHaptic(json.optJSONObject("haptic")),
        visual_overlay = json.optJSONObject("visual_overlay")?.toMap(),
        tool_actions = json.optJSONArray("tool_actions").orEmptyJsonObjects()
            .map(::parseToolAction),
        log_event = json.optJSONObject("log_event")?.toMap(),
    )

private fun parseTts(json: JSONObject?): TtsPayload =
    TtsPayload(
        text = json?.optString("text", "") ?: "",
        tone = json?.optString("tone", "calm_firm") ?: "calm_firm",
        speed = json?.optString("speed", "normal") ?: "normal",
        interrupt_policy = json?.optString("interrupt_policy", "do_not_interrupt_critical")
            ?: "do_not_interrupt_critical",
    )

private fun parseUi(json: JSONObject?): UiPayload =
    UiPayload(
        main_text = json?.optString("main_text", "") ?: "",
        secondary_text = json?.optString("secondary_text", "") ?: "",
        status_tags = json?.optStringList("status_tags") ?: emptyList(),
        quality_score = json?.optNullableInt("quality_score"),
        primary_button = json?.optJSONObject("primary_button")?.toMap(),
    )

private fun parseHaptic(json: JSONObject?): HapticPayload =
    HapticPayload(
        enabled = json?.optBoolean("enabled", false) ?: false,
        pattern = json?.optNullableString("pattern"),
        bpm = json?.optNullableInt("bpm"),
    )

private fun parseToolAction(json: JSONObject): ToolAction =
    ToolAction(
        type = json.getString("type"),
        requires_user_confirmation = json.optBoolean("requires_user_confirmation", false),
        confirmed = json.optBoolean("confirmed", false),
        user_confirmed = json.optBoolean("user_confirmed", false),
        confirmed_by_user = json.optBoolean("confirmed_by_user", false),
        confirmation = json.optJSONObject("confirmation")?.toMap() ?: emptyMap(),
        bpm = json.optNullableInt("bpm"),
        payload = json.optJSONObject("payload")?.toMap() ?: emptyMap(),
    )

private fun JSONObject.optNullableString(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null

private fun JSONObject.optNullableInt(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

private fun JSONObject.optStringList(key: String): List<String> =
    optJSONArray(key).orEmptyList().mapNotNull { it as? String }

private fun JSONArray?.orEmptyJsonObjects(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { index -> optJSONObject(index) }
}

private fun JSONArray?.orEmptyList(): List<Any?> {
    if (this == null) return emptyList()
    return (0 until length()).map { index -> normalizeJsonValue(get(index)) }
}

private fun JSONObject.toMap(): Map<String, Any?> =
    keys().asSequence().associateWith { key -> normalizeJsonValue(get(key)) }

private fun normalizeJsonValue(value: Any?): Any? =
    when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.toMap()
        is JSONArray -> value.orEmptyList()
        else -> value
    }
