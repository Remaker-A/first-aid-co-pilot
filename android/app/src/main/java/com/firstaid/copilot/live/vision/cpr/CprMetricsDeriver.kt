package com.firstaid.copilot.live.vision.cpr

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.round
import kotlin.math.roundToInt

data class CprLandmark(
    val x: Double,
    val y: Double,
    val visibility: Double? = null,
)

data class CprMetricsSnapshot(
    val compressionsStarted: Boolean,
    val compressionRate: Double?,
    val interruptionSeconds: Double,
    val handPosition: String?,
    val armStraight: Boolean?,
    val qualityScore: Int?,
    val totalCompressions: Int,
    val confidence: Double,
    val poseCoverage: Double,
    val frameStability: Double,
    val visionReady: Boolean,
    val observedWindowMs: Long,
) {
    fun toCprQualityMap(): Map<String, Any?> =
        linkedMapOf(
            "compressions_started" to compressionsStarted,
            "compression_rate" to compressionRate,
            "interruption_seconds" to interruptionSeconds,
            "hand_position" to handPosition,
            "arm_straight" to armStraight,
            "quality_score" to qualityScore,
            "total_compressions" to totalCompressions,
            "confidence" to confidence,
            "pose_coverage" to poseCoverage,
            "frame_stability" to frameStability,
            "vision_ready" to visionReady,
            "observed_window_ms" to observedWindowMs,
        )
}

/**
 * Deterministic Kotlin port of `src/vision/cprMetrics.js`.
 *
 * The output keys intentionally match the backend `cpr_quality` contract exactly.
 * Downstream ViewModel code applies the Android-side confidence gate, hand-position
 * hysteresis, score EMA, and event throttle.
 */
class CprMetricsDeriver(
    private val options: Options = Options(),
) {
    private val state = TrackerState()

    fun reset() {
        state.resetAll()
    }

    fun snapshot(): CprMetricsSnapshot? = state.lastSnapshot

    fun update(landmarks: List<CprLandmark>, timestampMs: Long): CprMetricsSnapshot? {
        if (landmarks.isEmpty() || timestampMs < 0) return state.lastSnapshot

        val normalizedLandmarks = normalizeLandmarks(landmarks)
        state.lastSampleMs?.let { previous ->
            if (timestampMs - previous > options.staleGapMs) {
                state.resetTransient()
            }
        }
        val confidence = computeConfidence(normalizedLandmarks)
        val poseCoverage = computePoseCoverage(normalizedLandmarks)
        val frameStability = updateFrameStability(normalizedLandmarks, timestampMs)
        if (confidence < options.minConfidence) {
            return commitSnapshot(
                CprMetricsSnapshot(
                    compressionsStarted = state.everMoved,
                    compressionRate = null,
                    interruptionSeconds = round2(state.interruptionSeconds),
                    handPosition = null,
                    armStraight = null,
                    qualityScore = null,
                    totalCompressions = state.totalCompressions,
                    confidence = round2(confidence),
                    poseCoverage = round2(poseCoverage),
                    frameStability = round2(frameStability),
                    visionReady = false,
                    observedWindowMs = observedWindowMs(),
                ),
            )
        }

        val verticalY = verticalSignal(normalizedLandmarks, options.visibilityFloor)

        if (verticalY != null) {
            ingestVerticalSample(verticalY, timestampMs)
        }
        state.lastSampleMs = timestampMs

        val compressionRate = estimateCompressionRate(state.samples, options)
        val handPosition = estimateHandPosition(normalizedLandmarks, options)
        val armStraight = estimateArmStraight(normalizedLandmarks, options)
        val qualityScore = computeQualityScore(
            compressionRate = compressionRate,
            armStraight = armStraight,
            handPosition = handPosition,
            interruptionSeconds = state.interruptionSeconds,
        )
        val visionReady =
            poseCoverage >= options.readyPoseCoverage &&
                frameStability >= options.readyFrameStability &&
                confidence >= options.readyConfidence

        return commitSnapshot(
            CprMetricsSnapshot(
                compressionsStarted = state.everMoved,
                compressionRate = compressionRate?.let(::round1),
                interruptionSeconds = round2(state.interruptionSeconds),
                handPosition = handPosition,
                armStraight = armStraight,
                qualityScore = qualityScore?.roundToInt(),
                totalCompressions = state.totalCompressions,
                confidence = round2(confidence),
                poseCoverage = round2(poseCoverage),
                frameStability = round2(frameStability),
                visionReady = visionReady,
                observedWindowMs = observedWindowMs(),
            ),
        )
    }

    private fun commitSnapshot(snapshot: CprMetricsSnapshot): CprMetricsSnapshot {
        state.lastSnapshot = snapshot
        return snapshot
    }

    private fun ingestVerticalSample(verticalY: Double, timestampMs: Long) {
        state.samples.add(Sample(timestampMs, verticalY))
        val windowStart = timestampMs - options.rateWindowMs
        while (state.samples.isNotEmpty() && state.samples.first().t < windowStart) {
            state.samples.removeAt(0)
        }

        val dt = clamp(
            ((state.lastSampleMs?.let { timestampMs - it } ?: options.maxDeltaMs)).toDouble(),
            1.0,
            options.maxDeltaMs.toDouble(),
        )

        val baseline = state.baseline
        if (baseline == null) {
            state.baseline = verticalY
        } else {
            val baselineAlpha = 1 - exp(-dt / options.baselineTauMs)
            state.baseline = baseline + baselineAlpha * (verticalY - baseline)
        }

        val centered = verticalY - (state.baseline ?: verticalY)
        val devAlpha = 1 - exp(-dt / options.deviationTauMs)
        state.deviationEma += devAlpha * (abs(centered) - state.deviationEma)
        val deadband = clamp(
            options.deadbandFraction * state.deviationEma,
            options.minDeadband,
            options.maxDeadband,
        )

        if (state.compressionState != CompressionState.High && centered > deadband) {
            if (state.compressionState == CompressionState.Low) {
                val farEnough = state.lastCompressionMs == null ||
                    timestampMs - state.lastCompressionMs!! >= options.minCompressionSpacingMs
                if (farEnough) {
                    state.totalCompressions += 1
                    state.lastCompressionMs = timestampMs
                }
            }
            state.compressionState = CompressionState.High
        } else if (state.compressionState != CompressionState.Low && centered < -deadband) {
            state.compressionState = CompressionState.Low
        }

        if (state.lastMotionMs == null) {
            state.lastMotionMs = timestampMs
        }
        val recentP2P = recentPeakToPeak(state.samples, timestampMs, options.recentWindowMs)
        if (recentP2P >= options.pausePeakToPeak) {
            state.lastMotionMs = timestampMs
            state.everMoved = true
        }
        state.interruptionSeconds = if (state.everMoved) {
            ((timestampMs - (state.lastMotionMs ?: timestampMs)) / 1000.0).coerceAtLeast(0.0)
        } else {
            0.0
        }
    }

    private fun normalizeLandmarks(landmarks: List<CprLandmark>): List<CprLandmark> {
        if (!options.mirrorX) return landmarks
        return landmarks.map { landmark ->
            if (landmark.x.isFinite()) {
                landmark.copy(x = 1.0 - landmark.x)
            } else {
                landmark
            }
        }
    }

    private fun computeConfidence(landmarks: List<CprLandmark>): Double {
        val indices = intArrayOf(
            LEFT_SHOULDER,
            RIGHT_SHOULDER,
            LEFT_WRIST,
            RIGHT_WRIST,
            LEFT_HIP,
            RIGHT_HIP,
        )
        val sum = indices.sumOf { visibility(landmarks, it) }
        return clamp(sum / indices.size, 0.0, 1.0)
    }

    private fun computePoseCoverage(landmarks: List<CprLandmark>): Double {
        val indices = intArrayOf(
            LEFT_SHOULDER,
            RIGHT_SHOULDER,
            LEFT_ELBOW,
            RIGHT_ELBOW,
            LEFT_WRIST,
            RIGHT_WRIST,
            LEFT_HIP,
            RIGHT_HIP,
        )
        val visibleCount = indices.count { visibility(landmarks, it) >= options.visibilityFloor }
        return visibleCount.toDouble() / indices.size
    }

    private fun updateFrameStability(landmarks: List<CprLandmark>, timestampMs: Long): Double {
        val center = torsoCenter(landmarks, options.visibilityFloor) ?: return 0.0
        state.frameCenters.add(FrameCenter(timestampMs, center.x, center.y))
        val windowStart = timestampMs - options.readinessWindowMs
        while (state.frameCenters.isNotEmpty() && state.frameCenters.first().t < windowStart) {
            state.frameCenters.removeAt(0)
        }
        if (state.frameCenters.size < options.minReadinessFrames) {
            state.frameStability = 0.0
            return state.frameStability
        }

        val meanX = state.frameCenters.sumOf { it.x } / state.frameCenters.size
        val meanY = state.frameCenters.sumOf { it.y } / state.frameCenters.size
        val maxDrift = state.frameCenters.maxOf {
            hypot(it.x - meanX, it.y - meanY)
        }
        state.frameStability = clamp(1.0 - maxDrift / options.maxReadyCenterDrift, 0.0, 1.0)
        return state.frameStability
    }

    private fun observedWindowMs(): Long {
        val first = state.samples.firstOrNull()?.t
        val last = state.samples.lastOrNull()?.t
        return if (first != null && last != null && last >= first) last - first else 0L
    }

    private fun recentPeakToPeak(samples: List<Sample>, nowMs: Long, windowMs: Long): Double {
        val start = nowMs - windowMs
        var min = Double.POSITIVE_INFINITY
        var max = Double.NEGATIVE_INFINITY
        var count = 0
        for (index in samples.indices.reversed()) {
            val sample = samples[index]
            if (sample.t < start) break
            if (sample.y < min) min = sample.y
            if (sample.y > max) max = sample.y
            count += 1
        }
        return if (count >= 2) max - min else 0.0
    }

    private fun estimateCompressionRate(samples: List<Sample>, options: Options): Double? {
        val n = samples.size
        if (n < options.minRateSamples) return null

        val first = samples.first().t
        val last = samples.last().t
        if (last - first < options.minRateSpanMs) return null

        var sumX = 0.0
        var sumY = 0.0
        var sumXX = 0.0
        var sumXY = 0.0
        for (sample in samples) {
            val x = (sample.t - first).toDouble()
            val y = sample.y
            sumX += x
            sumY += y
            sumXX += x * x
            sumXY += x * y
        }
        val denom = n * sumXX - sumX * sumX
        var slope = 0.0
        var intercept = sumY / n
        if (abs(denom) > 1e-9) {
            slope = (n * sumXY - sumX * sumY) / denom
            intercept = (sumY - slope * sumX) / n
        }

        val detrended = DoubleArray(n)
        var min = Double.POSITIVE_INFINITY
        var max = Double.NEGATIVE_INFINITY
        for (index in samples.indices) {
            val sample = samples[index]
            val v = sample.y - (intercept + slope * (sample.t - first))
            detrended[index] = v
            if (v < min) min = v
            if (v > max) max = v
        }

        val peakToPeak = max - min
        if (peakToPeak < options.pausePeakToPeak) return null
        val deadband = 0.25 * (peakToPeak / 2)

        val crossings = mutableListOf<Double>()
        var armed = true
        for (index in 1 until n) {
            if (detrended[index] < -deadband) armed = true
            if (armed && detrended[index - 1] < 0 && detrended[index] >= 0) {
                val y0 = detrended[index - 1]
                val y1 = detrended[index]
                val fraction = if (y1 == y0) 0.0 else (0 - y0) / (y1 - y0)
                val tCross = samples[index - 1].t + fraction * (samples[index].t - samples[index - 1].t)
                crossings.add(tCross)
                armed = false
            }
        }

        if (crossings.size < options.minRateCrossings) return null
        val period = (crossings.last() - crossings.first()) / (crossings.size - 1)
        if (period <= 0) return null
        val bpm = 60000 / period
        return if (bpm in options.minRateBpm..options.maxRateBpm) bpm else null
    }

    private fun estimateHandPosition(landmarks: List<CprLandmark>, options: Options): String? {
        val floor = options.visibilityFloor
        val wrist = averageVisible(landmarks, intArrayOf(LEFT_WRIST, RIGHT_WRIST), floor)
        val leftShoulder = visiblePoint(landmarks, LEFT_SHOULDER, floor)
        val rightShoulder = visiblePoint(landmarks, RIGHT_SHOULDER, floor)
        if (wrist == null || leftShoulder == null || rightShoulder == null) return null

        val shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2
        val shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2
        val shoulderWidth = abs(leftShoulder.x - rightShoulder.x)
        if (shoulderWidth < 1e-4) return null

        val hip = averageVisible(landmarks, intArrayOf(LEFT_HIP, RIGHT_HIP), floor)
        val centerX = if (hip != null) (shoulderMidX + hip.x) / 2 else shoulderMidX
        val normalizedDx = (wrist.x - centerX) / shoulderWidth
        val horizontalOff = abs(normalizedDx) > options.handCenterTolerance

        var verticalState: String? = null
        if (hip != null) {
            val torsoHeight = hip.y - shoulderMidY
            if (torsoHeight > 1e-4) {
                val ratio = (wrist.y - shoulderMidY) / torsoHeight
                verticalState = when {
                    ratio < options.handTooHighRatio -> "too_high"
                    ratio > options.handTooLowRatio -> "too_low"
                    else -> null
                }
            }
        }

        return when {
            horizontalOff && verticalState != null -> "off_center"
            horizontalOff -> if (normalizedDx < 0) "left" else "right"
            verticalState != null -> verticalState
            else -> "center"
        }
    }

    private fun estimateArmStraight(landmarks: List<CprLandmark>, options: Options): Boolean? {
        val sides = arrayOf(
            intArrayOf(LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST),
            intArrayOf(RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST),
        )
        val angles = mutableListOf<Double>()
        for (side in sides) {
            val shoulder = visiblePoint(landmarks, side[0], options.visibilityFloor)
            val elbow = visiblePoint(landmarks, side[1], options.visibilityFloor)
            val wrist = visiblePoint(landmarks, side[2], options.visibilityFloor)
            if (shoulder == null || elbow == null || wrist == null) continue
            angleDeg(shoulder, elbow, wrist)?.let { angles.add(it) }
        }
        if (angles.isEmpty()) return null
        return angles.average() >= options.armStraightDeg
    }

    private fun computeQualityScore(
        compressionRate: Double?,
        armStraight: Boolean?,
        handPosition: String?,
        interruptionSeconds: Double,
    ): Double? {
        val components = mutableListOf<WeightedComponent>()

        if (compressionRate != null) {
            val value = if (compressionRate >= 100 && compressionRate <= 120) {
                1.0
            } else {
                val distance = if (compressionRate < 100) 100 - compressionRate else compressionRate - 120
                clamp(1 - distance / 20, 0.0, 1.0)
            }
            components.add(WeightedComponent(weight = 0.4, value = value))
        }

        if (armStraight != null) {
            components.add(WeightedComponent(weight = 0.2, value = if (armStraight) 1.0 else 0.0))
        }

        if (handPosition != null) {
            components.add(WeightedComponent(weight = 0.2, value = if (handPosition == "center") 1.0 else 0.0))
        }

        val interruptionValue = when {
            interruptionSeconds <= 0.5 -> 1.0
            interruptionSeconds >= 2 -> 0.0
            else -> clamp(1 - (interruptionSeconds - 0.5) / 1.5, 0.0, 1.0)
        }
        components.add(WeightedComponent(weight = 0.2, value = interruptionValue))

        if (components.isEmpty()) return null
        val weightSum = components.sumOf { it.weight }
        if (weightSum <= 0) return null
        val accumulator = components.sumOf { it.weight * it.value }
        return clamp((accumulator / weightSum) * 100, 0.0, 100.0)
    }

    private fun verticalSignal(landmarks: List<CprLandmark>, floor: Double): Double? {
        val wrist = averageVisible(landmarks, intArrayOf(LEFT_WRIST, RIGHT_WRIST), floor)
        if (wrist != null) return wrist.y
        return averageVisible(landmarks, intArrayOf(LEFT_SHOULDER, RIGHT_SHOULDER), floor)?.y
    }

    private fun torsoCenter(landmarks: List<CprLandmark>, floor: Double): Point? {
        val shoulder = averageVisible(landmarks, intArrayOf(LEFT_SHOULDER, RIGHT_SHOULDER), floor)
        val hip = averageVisible(landmarks, intArrayOf(LEFT_HIP, RIGHT_HIP), floor)
        return when {
            shoulder != null && hip != null -> Point((shoulder.x + hip.x) / 2, (shoulder.y + hip.y) / 2)
            shoulder != null -> shoulder
            hip != null -> hip
            else -> null
        }
    }

    private fun averageVisible(landmarks: List<CprLandmark>, indices: IntArray, floor: Double): Point? {
        var sumX = 0.0
        var sumY = 0.0
        var count = 0
        for (index in indices) {
            val point = visiblePoint(landmarks, index, floor)
            if (point != null) {
                sumX += point.x
                sumY += point.y
                count += 1
            }
        }
        return if (count == 0) null else Point(sumX / count, sumY / count)
    }

    private fun visiblePoint(landmarks: List<CprLandmark>, index: Int, floor: Double): Point? {
        val landmark = landmarks.getOrNull(index) ?: return null
        if (!landmark.x.isFinite() || !landmark.y.isFinite()) return null
        if (visibility(landmarks, index) < floor) return null
        return Point(landmark.x, landmark.y)
    }

    private fun visibility(landmarks: List<CprLandmark>, index: Int): Double {
        val value = landmarks.getOrNull(index)?.visibility ?: return 0.0
        return if (value.isFinite()) clamp(value, 0.0, 1.0) else 0.0
    }

    private fun angleDeg(a: Point, b: Point, c: Point): Double? {
        val v1x = a.x - b.x
        val v1y = a.y - b.y
        val v2x = c.x - b.x
        val v2y = c.y - b.y
        val m1 = hypot(v1x, v1y)
        val m2 = hypot(v2x, v2y)
        if (m1 < 1e-6 || m2 < 1e-6) return null
        val cosine = clamp((v1x * v2x + v1y * v2y) / (m1 * m2), -1.0, 1.0)
        return (acos(cosine) * 180) / PI
    }

    data class Options(
        val mirrorX: Boolean = false,
        val rateWindowMs: Long = 4000,
        val minRateSamples: Int = 10,
        val minRateSpanMs: Long = 2500,
        val minRateCrossings: Int = 3,
        val minRateBpm: Double = 60.0,
        val maxRateBpm: Double = 160.0,
        val recentWindowMs: Long = 900,
        val pausePeakToPeak: Double = 0.02,
        val baselineTauMs: Double = 2000.0,
        val deviationTauMs: Double = 700.0,
        val deadbandFraction: Double = 0.4,
        val minDeadband: Double = 0.004,
        val maxDeadband: Double = 0.2,
        val minCompressionSpacingMs: Long = 200,
        val staleGapMs: Long = 1500,
        val maxDeltaMs: Long = 250,
        val minConfidence: Double = 0.5,
        val visibilityFloor: Double = 0.5,
        val armStraightDeg: Double = 155.0,
        val handCenterTolerance: Double = 0.35,
        val handTooHighRatio: Double = 0.1,
        val handTooLowRatio: Double = 0.7,
        val readinessWindowMs: Long = 1200,
        val minReadinessFrames: Int = 3,
        val maxReadyCenterDrift: Double = 0.05,
        val readyConfidence: Double = LIVE_CONFIDENCE_THRESHOLD,
        val readyPoseCoverage: Double = LIVE_POSE_COVERAGE_THRESHOLD,
        val readyFrameStability: Double = LIVE_FRAME_STABILITY_THRESHOLD,
    )

    private data class Sample(val t: Long, val y: Double)
    private data class FrameCenter(val t: Long, val x: Double, val y: Double)
    private data class Point(val x: Double, val y: Double)
    private data class WeightedComponent(val weight: Double, val value: Double)

    private enum class CompressionState { Unknown, High, Low }

    private class TrackerState {
        val samples = mutableListOf<Sample>()
        var lastSampleMs: Long? = null
        var baseline: Double? = null
        var deviationEma: Double = 0.0
        var compressionState: CompressionState = CompressionState.Unknown
        var totalCompressions: Int = 0
        var lastCompressionMs: Long? = null
        var lastMotionMs: Long? = null
        var everMoved: Boolean = false
        var interruptionSeconds: Double = 0.0
        var lastSnapshot: CprMetricsSnapshot? = null
        val frameCenters = mutableListOf<FrameCenter>()
        var frameStability: Double = 0.0

        fun resetAll() {
            samples.clear()
            lastSampleMs = null
            baseline = null
            deviationEma = 0.0
            compressionState = CompressionState.Unknown
            totalCompressions = 0
            lastCompressionMs = null
            lastMotionMs = null
            everMoved = false
            interruptionSeconds = 0.0
            lastSnapshot = null
            frameCenters.clear()
            frameStability = 0.0
        }

        fun resetTransient() {
            samples.clear()
            baseline = null
            deviationEma = 0.0
            compressionState = CompressionState.Unknown
            lastCompressionMs = null
            lastMotionMs = null
            interruptionSeconds = 0.0
            frameCenters.clear()
            frameStability = 0.0
        }
    }

    companion object {
        const val LEFT_SHOULDER = 11
        const val RIGHT_SHOULDER = 12
        const val LEFT_ELBOW = 13
        const val RIGHT_ELBOW = 14
        const val LEFT_WRIST = 15
        const val RIGHT_WRIST = 16
        const val LEFT_HIP = 23
        const val RIGHT_HIP = 24
    }
}

private fun clamp(value: Double, min: Double, max: Double): Double =
    when {
        value < min -> min
        value > max -> max
        else -> value
    }

private fun round1(value: Double): Double = round(value * 10) / 10

private fun round2(value: Double): Double = round(value * 100) / 100

