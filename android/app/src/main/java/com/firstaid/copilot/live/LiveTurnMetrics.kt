package com.firstaid.copilot.live

import org.json.JSONObject

data class LiveTurnMetrics(
    val turnSeq: Int? = null,
    val currentStage: String? = null,
    val autoAdvance: Boolean = false,
    val timings: Map<String, Long> = emptyMap(),
    val tts: LiveTtsTurnMetrics = LiveTtsTurnMetrics(),
    val intent: LiveIntentTurnMetrics = LiveIntentTurnMetrics(),
    val gemma: LiveGemmaTurnMetrics = LiveGemmaTurnMetrics(),
    val openQuestion: LiveOpenQuestionTurnMetrics = LiveOpenQuestionTurnMetrics(),
    val guidanceSource: String? = null,
)

data class LiveTtsTurnMetrics(
    val provider: String? = null,
    val cacheHit: Boolean? = null,
    val spoke: Boolean = false,
)

data class LiveIntentTurnMetrics(
    val source: String? = null,
    val intent: String? = null,
    val fastPath: Boolean? = null,
)

data class LiveGemmaTurnMetrics(
    val skipped: Boolean = false,
    val skipReason: String? = null,
    val stale: Boolean = false,
    val live: Boolean = false,
    val openQuestion: Boolean = false,
    val timeoutMs: Long? = null,
)

data class LiveOpenQuestionTurnMetrics(
    val segment: String? = null,
    val cacheHit: Boolean? = null,
    val fallback: Boolean = false,
    val reason: String? = null,
    val waitMs: Long? = null,
    val timeoutMs: Long? = null,
)

internal fun parseLiveTurnMetrics(json: JSONObject): LiveTurnMetrics =
    LiveTurnMetrics(
        turnSeq = json.intOrNull("turn_seq") ?: json.intOrNull("turnSeq"),
        currentStage = json.stringOrNull("current_stage") ?: json.stringOrNull("currentStage"),
        autoAdvance = json.booleanOrDefault(false, "auto_advance", "autoAdvance"),
        timings = json.optJSONObject("timings").toLongMap(),
        tts = json.optJSONObject("tts").toLiveTtsTurnMetrics(),
        intent = json.optJSONObject("intent").toLiveIntentTurnMetrics(),
        gemma = json.optJSONObject("gemma").toLiveGemmaTurnMetrics(),
        openQuestion = json.optJSONObject("open_question").toLiveOpenQuestionTurnMetrics(),
        guidanceSource = json.stringOrNull("guidance_source") ?: json.stringOrNull("guidanceSource"),
    )

private fun JSONObject?.toLiveTtsTurnMetrics(): LiveTtsTurnMetrics {
    if (this == null) return LiveTtsTurnMetrics()
    return LiveTtsTurnMetrics(
        provider = stringOrNull("provider"),
        cacheHit = booleanOrNull("cache_hit") ?: booleanOrNull("cacheHit"),
        spoke = booleanOrDefault(false, "spoke"),
    )
}

private fun JSONObject?.toLiveIntentTurnMetrics(): LiveIntentTurnMetrics {
    if (this == null) return LiveIntentTurnMetrics()
    return LiveIntentTurnMetrics(
        source = stringOrNull("source"),
        intent = stringOrNull("intent"),
        fastPath = booleanOrNull("fast_path") ?: booleanOrNull("fastPath"),
    )
}

private fun JSONObject?.toLiveGemmaTurnMetrics(): LiveGemmaTurnMetrics {
    if (this == null) return LiveGemmaTurnMetrics()
    return LiveGemmaTurnMetrics(
        skipped = booleanOrDefault(false, "skipped"),
        skipReason = stringOrNull("skip_reason") ?: stringOrNull("skipReason"),
        stale = booleanOrDefault(false, "stale"),
        live = booleanOrDefault(false, "live"),
        openQuestion = booleanOrDefault(false, "open_question", "openQuestion"),
        timeoutMs = longOrNull("timeout_ms") ?: longOrNull("timeoutMs"),
    )
}

private fun JSONObject?.toLiveOpenQuestionTurnMetrics(): LiveOpenQuestionTurnMetrics {
    if (this == null) return LiveOpenQuestionTurnMetrics()
    return LiveOpenQuestionTurnMetrics(
        segment = stringOrNull("segment"),
        cacheHit = booleanOrNull("cache_hit") ?: booleanOrNull("cacheHit"),
        fallback = booleanOrDefault(false, "fallback"),
        reason = stringOrNull("reason"),
        waitMs = longOrNull("wait_ms") ?: longOrNull("waitMs"),
        timeoutMs = longOrNull("timeout_ms") ?: longOrNull("timeoutMs"),
    )
}

private fun JSONObject?.toLongMap(): Map<String, Long> {
    if (this == null) return emptyMap()
    val out = LinkedHashMap<String, Long>()
    keys().forEach { key ->
        if (!isNull(key)) {
            out[key] = optLong(key)
        }
    }
    return out
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf(String::isNotEmpty) else null

private fun JSONObject.intOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

private fun JSONObject.longOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key) else null

private fun JSONObject.booleanOrNull(key: String): Boolean? =
    if (has(key) && !isNull(key)) optBoolean(key) else null

private fun JSONObject.booleanOrDefault(default: Boolean, vararg keys: String): Boolean =
    keys.firstNotNullOfOrNull { key -> booleanOrNull(key) } ?: default
