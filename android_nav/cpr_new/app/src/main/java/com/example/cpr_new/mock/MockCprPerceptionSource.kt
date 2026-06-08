package com.example.cpr_new.mock

import com.example.cpr_new.core.contract.CameraView
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.CprPerceptionSource
import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.PerceptionEvent
import com.example.cpr_new.feature.session.QualityScorer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.util.UUID
import kotlin.random.Random

/**
 * 感知源的 Mock 实现 —— 让第 4 部分在没有第 3 部分模型时也能端到端演示。
 * 输出已对齐《CPR 感知模块接口 v1》的 [PerceptionEvent] 字段。
 *
 * 行为：模拟一段“逐渐稳定”的按压过程，并周期性插入中断 / 低置信度帧演示兜底。
 * 真实实现替换后本类可删除（依赖的是接口而非本类）。
 */
class MockCprPerceptionSource(
    private val emitIntervalMs: Long = 500,
) : CprPerceptionSource {

    @Volatile
    private var running = false

    @Volatile
    private var sessionId: String = ""

    override val isReady: Boolean get() = true

    override val events: Flow<PerceptionEvent> = flow {
        var tick = 0
        while (running) {
            emit(fakeEvent(tick))
            tick++
            delay(emitIntervalMs)
        }
    }

    override fun start(sessionId: String) {
        this.sessionId = sessionId
        running = true
    }

    override fun stop() { running = false }

    /** 生成一帧带噪声、随时间收敛的假数据（含 v1 全字段）。 */
    private fun fakeEvent(tick: Int): PerceptionEvent {
        // 频率从 ~135 收敛到 ~110。
        val baseRate = 135f - (tick * 1.5f).coerceAtMost(28f)
        val rate = baseRate + Random.nextFloat() * 6f - 3f

        val lowConfidenceFrame = tick % 13 == 7
        val interruptedFrame = tick % 17 == 5

        val handPosition = when {
            lowConfidenceFrame -> HandPosition.UNKNOWN
            tick < 6 -> HandPosition.HIGH
            tick < 12 -> HandPosition.LEFT
            else -> HandPosition.CENTER
        }
        val armStraight = tick % 11 != 3
        val interruptionMs = if (interruptedFrame) 1800L else (tick % 5) * 100L

        // 先用兜底估算填 quality_score，模拟“第 3 部分已给分”。
        val draft = PerceptionEvent(
            eventId = UUID.randomUUID().toString(),
            sessionId = sessionId,
            timestampMs = System.currentTimeMillis(),
            phase = CprPhase.COMPRESSION,
            cameraView = CameraView.SIDE_FRONT,
            compressionRateBpm = rate,
            interruptionMs = interruptionMs,
            handPosition = handPosition,
            armStraight = armStraight,
            qualityScore = 0,
            confidence = if (lowConfidenceFrame) 0.3f else 0.85f + Random.nextFloat() * 0.1f,
            rawSignals = mapOf("mockTick" to tick.toFloat()),
        )
        return draft.copy(qualityScore = if (draft.isReliable()) QualityScorer.estimate(draft) else 0)
    }
}
