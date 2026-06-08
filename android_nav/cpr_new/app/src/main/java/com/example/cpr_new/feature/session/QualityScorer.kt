package com.example.cpr_new.feature.session

import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.PerceptionEvent
import kotlin.math.abs

/**
 * 按压质量评分器 —— **兜底用**。
 *
 * 重要边界：质量评分是第 3 部分的职责，正式分值来自 [PerceptionEvent.qualityScore]
 * （v1: quality_score）。本类仅在以下情况兜底：感知方暂未给分（qualityScore<=0）
 * 但事件可靠时，用一个粗略加权估算，避免仪表盘空着。
 *
 * 这里的权重参考 v1 第八节（position 35% / rhythm 30% / continuity 20% / posture 15%），
 * 但因 Android 端拿不到各子项分，只能用可观测字段近似，**不等同**于第 3 部分的精确评分。
 */
object QualityScorer {

    /** 优先用第 3 部分给的分；否则在可靠时兜底估算，不可靠则沿用上一次分值。 */
    fun resolve(event: PerceptionEvent, previousScore: Int): Int = when {
        event.qualityScore > 0 -> event.qualityScore
        event.isReliable() -> estimate(event)
        else -> previousScore
    }

    /** 粗略估算（兜底）：频率 + 手位 + 手臂 + 连续性，按 v1 权重近似。 */
    fun estimate(event: PerceptionEvent): Int {
        val reliability = event.confidence.coerceIn(0f, 1f)

        val rhythm = event.compressionRateBpm?.let { rateScore(it) } ?: 0f
        val position = handScore(event.handPosition)
        val posture = if (event.armStraight) 1f else 0.3f
        val continuity = if (event.isInterrupted()) 0.2f else 1f

        val combined =
            position * 0.35f + rhythm * 0.30f + continuity * 0.20f + posture * 0.15f
        return (combined * reliability * 100).toInt().coerceIn(0, 100)
    }

    /** 频率越接近区间中值越高，超出 [TARGET_RATE_MIN, TARGET_RATE_MAX] 线性衰减。 */
    private fun rateScore(rate: Float): Float {
        val mid = (PerceptionEvent.TARGET_RATE_MIN + PerceptionEvent.TARGET_RATE_MAX) / 2f
        val halfRange = (PerceptionEvent.TARGET_RATE_MAX - PerceptionEvent.TARGET_RATE_MIN) / 2f
        val distance = abs(rate - mid)
        return when {
            distance <= halfRange -> 1f - 0.3f * (distance / halfRange)
            else -> (0.7f - 0.05f * (distance - halfRange)).coerceAtLeast(0f)
        }
    }

    private fun handScore(position: HandPosition): Float = when (position) {
        HandPosition.CENTER -> 1f
        HandPosition.LEFT, HandPosition.RIGHT -> 0.5f
        HandPosition.HIGH, HandPosition.LOW -> 0.4f
        HandPosition.UNKNOWN -> 0f
    }
}
