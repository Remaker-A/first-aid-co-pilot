package com.example.cpr_new.mock

import com.example.cpr_new.core.contract.ActionType
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidanceAgent
import com.example.cpr_new.core.contract.GuidancePriority
import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.HandoverReport
import com.example.cpr_new.core.contract.HapticPattern
import com.example.cpr_new.core.contract.MessageCode
import com.example.cpr_new.core.contract.PerceptionEvent
import com.example.cpr_new.core.contract.SessionLog
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Agent 的 Mock 实现 —— 直接落地《v1 第七节·默认规则映射》。
 *
 * 注意：这套规则仅为演示连通性，**不代表医学标准**；真实决策由第 2 部分 Gemma
 * （或第 3 部分规则基线）负责。替换后本类可删除。
 */
class MockGuidanceAgent : GuidanceAgent {

    override val isReady: Boolean get() = true

    override suspend fun onSessionStart(sessionId: String): GuidanceAction = GuidanceAction(
        actionId = UUID.randomUUID().toString(),
        sessionId = sessionId,
        timestampMs = System.currentTimeMillis(),
        actionType = ActionType.COMPOSITE,
        priority = GuidancePriority.CRITICAL,
        messageCode = MessageCode.GOOD_CONTINUE,
        messageText = "用力按压\n胸部中央",
        ttsText = "开始按压，双手交叠置于胸部中央，用力快速按压。",
        hapticPattern = HapticPattern.DOUBLE,
        phase = CprPhase.COMPRESSION,
        targetRate = 110,
    )

    override fun guidance(perception: Flow<PerceptionEvent>): Flow<GuidanceAction> = flow {
        var lastCode: MessageCode? = null
        perception.collect { event ->
            val action = decide(event)
            // 去抖：相同消息码不重复播报，避免刷屏与 TTS 拥塞。
            if (action.messageCode != lastCode) {
                lastCode = action.messageCode
                emit(action)
            }
        }
    }

    /** v1 第七节规则映射：按优先级返回一条最该提醒的动作。 */
    private fun decide(event: PerceptionEvent): GuidanceAction {
        val (code, text, tts, priority) = when {
            !event.isReliable() || event.handPosition == HandPosition.UNKNOWN ->
                Rule(MessageCode.TRACKING_LOST, "看不清\n请对准胸部", "请把手机对准胸部", GuidancePriority.HIGH)

            event.isInterrupted() ->
                Rule(MessageCode.RESUME_COMPRESSIONS, "不要停顿\n继续按压", "不要停，继续按压！", GuidancePriority.CRITICAL)

            event.handPosition == HandPosition.LEFT ->
                Rule(MessageCode.MOVE_RIGHT, "手偏左\n向右移", "手的位置偏左，向右移。", GuidancePriority.MEDIUM)

            event.handPosition == HandPosition.RIGHT ->
                Rule(MessageCode.MOVE_LEFT, "手偏右\n向左移", "手的位置偏右，向左移。", GuidancePriority.MEDIUM)

            event.handPosition == HandPosition.HIGH ->
                Rule(MessageCode.MOVE_DOWN, "手偏高\n向下移", "手的位置偏高，向下移。", GuidancePriority.MEDIUM)

            event.handPosition == HandPosition.LOW ->
                Rule(MessageCode.MOVE_UP, "手偏低\n向上移", "手的位置偏低，向上移。", GuidancePriority.MEDIUM)

            !event.armStraight ->
                Rule(MessageCode.STRAIGHTEN_ARMS, "伸直手臂\n垂直下压", "伸直手臂，垂直向下按压。", GuidancePriority.MEDIUM)

            (event.compressionRateBpm ?: 110f) < PerceptionEvent.TARGET_RATE_MIN ->
                Rule(MessageCode.SPEED_UP, "再快一点\n加快按压", "再快一点，加快按压频率。", GuidancePriority.MEDIUM)

            (event.compressionRateBpm ?: 110f) > PerceptionEvent.TARGET_RATE_MAX ->
                Rule(MessageCode.SLOW_DOWN, "稍慢一点\n跟随节拍", "节奏太快，跟着节拍稍微放慢。", GuidancePriority.MEDIUM)

            else ->
                Rule(MessageCode.GOOD_CONTINUE, "做得好\n保持节奏", "很好，保持这个节奏。", GuidancePriority.LOW)
        }

        return GuidanceAction(
            actionId = UUID.randomUUID().toString(),
            sessionId = event.sessionId,
            timestampMs = System.currentTimeMillis(),
            actionType = ActionType.COMPOSITE,
            priority = priority,
            messageCode = code,
            messageText = text,
            ttsText = tts,
            hapticPattern = hapticFor(priority),
            sourceEventId = event.eventId,
            phase = CprPhase.COMPRESSION,
            targetRate = 110,
        )
    }

    private fun hapticFor(priority: GuidancePriority): HapticPattern? = when (priority) {
        GuidancePriority.CRITICAL -> HapticPattern.STRONG
        GuidancePriority.HIGH, GuidancePriority.MEDIUM -> HapticPattern.DOUBLE
        GuidancePriority.LOW -> null
    }

    /** 规则中间结构，仅本类内部使用，便于在 when 里解构。 */
    private data class Rule(
        val code: MessageCode,
        val text: String,
        val tts: String,
        val priority: GuidancePriority,
    )

    override suspend fun buildHandover(log: SessionLog): HandoverReport {
        val df = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        val avgRate = log.metrics["avgCompressionRate"]?.toInt() ?: 0
        val quality = log.metrics["finalQualityScore"]?.toInt() ?: 0
        val durationSec = (log.durationMs ?: 0L) / 1000

        return HandoverReport(
            sessionId = log.sessionId,
            headline = "施救约 ${durationSec}s，平均频率 $avgRate 次/分，质量分 $quality。",
            highlights = listOf(
                "开始时间：${df.format(Date(log.startedAtMs))}",
                "持续时长：${durationSec} 秒",
                "平均按压频率：$avgRate 次/分",
                "综合质量评分：$quality / 100",
                "事件条目：${log.entries.size} 条",
            ),
            narrative = buildString {
                appendLine("【旁观者 CPR 交接报告（演示）】")
                appendLine("持续约 ${durationSec} 秒，平均按压频率 $avgRate 次/分，综合质量 $quality 分。")
                appendLine("过程中系统已实时纠正手位与节奏，并保存现场录音备查。")
                appendLine("注：本报告由演示用 Mock Agent 生成，不构成医学结论。")
            },
            generatedAtMs = System.currentTimeMillis(),
        )
    }
}
