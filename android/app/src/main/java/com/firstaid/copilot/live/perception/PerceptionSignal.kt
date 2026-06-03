package com.firstaid.copilot.live.perception

import com.firstaid.copilot.live.PerceptionSignalMarker
import kotlin.math.roundToInt

data class PerceptionSignal<T>(
    val key: String,
    val value: T?,
    val confidence: Double?,
    val source: String,
    val timestampMs: Long,
    val ttlMs: Long,
    val quality: DataQuality = assessDataQuality(value, confidence, source, timestampMs, ttlMs),
) : PerceptionSignalMarker {
    fun isFresh(nowMs: Long = System.currentTimeMillis()): Boolean =
        value != null && nowMs - timestampMs <= ttlMs
}

enum class DataQuality {
    Unknown,
    LowConfidence,
    Confident,
    Conflict,
    SensorUnavailable,
}

fun <T> assessDataQuality(
    value: T?,
    confidence: Double?,
    source: String,
    timestampMs: Long,
    ttlMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): DataQuality {
    if (source == "sensor_unavailable") return DataQuality.SensorUnavailable
    if (value == null || nowMs - timestampMs > ttlMs) return DataQuality.Unknown
    val safeConfidence = confidence ?: return DataQuality.LowConfidence
    return if (safeConfidence >= CONFIDENT_THRESHOLD) DataQuality.Confident else DataQuality.LowConfidence
}

fun <T> resolveSignalQuality(signals: List<PerceptionSignal<T>>): DataQuality {
    val freshSignals = signals.filter { it.quality != DataQuality.Unknown && it.quality != DataQuality.SensorUnavailable }
    if (freshSignals.isEmpty()) {
        return signals.firstOrNull { it.quality == DataQuality.SensorUnavailable }?.quality ?: DataQuality.Unknown
    }

    val confidentValues = freshSignals
        .filter { it.quality == DataQuality.Confident }
        .mapNotNull { it.value }
        .toSet()

    if (confidentValues.size > 1) return DataQuality.Conflict
    return freshSignals.maxBy { it.quality.rank }.quality
}

class HandPositionHysteresis(
    private val correctionFrames: Int = 2,
    private val releaseFrames: Int = 3,
) {
    private var stableValue: String? = null
    private var candidateValue: String? = null
    private var candidateCount: Int = 0

    fun update(rawValue: String?): String? {
        if (rawValue == stableValue) {
            candidateValue = null
            candidateCount = 0
            return stableValue
        }

        if (rawValue == candidateValue) {
            candidateCount += 1
        } else {
            candidateValue = rawValue
            candidateCount = 1
        }

        val requiredFrames = if (rawValue == "center" || rawValue == null) releaseFrames else correctionFrames
        if (candidateCount >= requiredFrames) {
            stableValue = rawValue
            candidateValue = null
            candidateCount = 0
        }
        return stableValue
    }
}

class EmaQualityScore(
    private val alpha: Double = 0.3,
) {
    private var ema: Double? = null

    fun update(rawScore: Double?): Int? {
        if (rawScore == null) return ema?.times(100)?.roundToInt()
        val normalized = normalizeQuality(rawScore)
        val next = ema?.let { previous -> alpha * normalized + (1.0 - alpha) * previous } ?: normalized
        ema = next.coerceIn(0.0, 1.0)
        return (ema!! * 100).roundToInt()
    }

    private fun normalizeQuality(rawScore: Double): Double =
        if (rawScore > 1.0) rawScore / 100.0 else rawScore
}

fun smoothInterruptionSeconds(rawSeconds: Double, previousSeconds: Double?): Double =
    if (rawSeconds >= 2.0) rawSeconds else previousSeconds ?: rawSeconds

private const val CONFIDENT_THRESHOLD = 0.75

private val DataQuality.rank: Int
    get() = when (this) {
        DataQuality.Unknown -> 0
        DataQuality.SensorUnavailable -> 0
        DataQuality.LowConfidence -> 1
        DataQuality.Confident -> 2
        DataQuality.Conflict -> 3
    }
