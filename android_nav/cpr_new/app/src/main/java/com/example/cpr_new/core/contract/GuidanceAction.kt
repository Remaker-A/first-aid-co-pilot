package com.example.cpr_new.core.contract

/**
 * 指导动作契约（决策方 -> 第 4 部分）。对齐《CPR 感知模块接口与交接说明 v1》。
 *
 * 说明：v1 中 GuidanceAction 由“上层”根据 PerceptionEvent 生成。无论最终由
 * 第 2 部分（Gemma Agent）还是第 3 部分（规则基线）产出，都实现 [GuidanceAgent] 接口，
 * 字段保持与 v1 一致；Android 端只负责呈现（TTS / 大字 / 震动）。
 *
 * 字段对应 v1：action_id / session_id / timestamp_ms / action_type / priority /
 * message_code / message_text / tts_text / haptic_pattern / source_event_id。
 */
data class GuidanceAction(
    /** 动作唯一标识（v1: action_id）。 */
    val actionId: String,
    /** 所属会话 id（v1: session_id）。 */
    val sessionId: String = "",
    /** 动作产生时间戳（毫秒，v1: timestamp_ms）。 */
    val timestampMs: Long = 0L,
    /** 动作类型（v1: action_type），决定 Android 用哪种通道呈现。 */
    val actionType: ActionType = ActionType.COMPOSITE,
    /** 优先级（v1: priority）。CRITICAL 会打断当前 TTS 并强提示。 */
    val priority: GuidancePriority = GuidancePriority.MEDIUM,
    /** 消息码（v1: message_code）。稳定枚举，便于去抖 / 国际化 / 埋点。 */
    val messageCode: MessageCode = MessageCode.GOOD_CONTINUE,
    /** 屏幕大字提示（v1: message_text）。 */
    val messageText: String,
    /** TTS 播报文本（v1: tts_text）。为空表示本次不播报。 */
    val ttsText: String = "",
    /** 触觉反馈模式（v1: haptic_pattern），null 表示无震动。 */
    val hapticPattern: HapticPattern? = null,
    /** 触发本动作的感知事件 id（v1: source_event_id），用于回溯。 */
    val sourceEventId: String = "",

    // ---- 以下为 Android 端扩展字段（v1 之外），用于驱动 UI，不影响对接 ----
    /** 当前急救阶段，驱动 UI 主视图。 */
    val phase: CprPhase = CprPhase.COMPRESSION,
    /** 节拍器目标频率（次 / 分钟），null 表示沿用当前值。 */
    val targetRate: Int? = null,
    /** 可扩展元数据透传。 */
    val metadata: Map<String, String> = emptyMap(),
)

/** 指导优先级（v1: priority）。 */
enum class GuidancePriority { LOW, MEDIUM, HIGH, CRITICAL }

/** 动作类型（v1: action_type）。 */
enum class ActionType {
    /** 仅语音/文本。 */
    VOICE_TEXT,

    /** 仅视觉提示。 */
    VISUAL_HINT,

    /** 仅触觉。 */
    HAPTIC,

    /** 复合（语音 + 视觉 + 触觉）。 */
    COMPOSITE,
}

/**
 * 消息码（v1: message_code）。
 * Android 可据此做本地化文案 / 图标映射，与具体 message_text 解耦。
 */
enum class MessageCode {
    /** 做得好，保持。 */
    GOOD_CONTINUE,

    /** 手位偏左 -> 向右移。 */
    MOVE_LEFT,

    /** 手位偏右 -> 向左移。 */
    MOVE_RIGHT,

    /** 手位偏低 -> 向上移。 */
    MOVE_UP,

    /** 手位偏高 -> 向下移。 */
    MOVE_DOWN,

    /** 伸直手臂。 */
    STRAIGHTEN_ARMS,

    /** 加快按压。 */
    SPEED_UP,

    /** 放慢按压。 */
    SLOW_DOWN,

    /** 恢复按压（中断过久）。 */
    RESUME_COMPRESSIONS,

    /** 目标丢失 / 识别不到。 */
    TRACKING_LOST,
}

/**
 * CPR 急救阶段。
 * 对应标准流程：评估 -> 呼叫 120 -> 持续按压 -> 人工呼吸 -> AED -> 交接。
 * 注：第 3 部分 MVP 仅识别 [COMPRESSION]（其 CPR_ACTIVE）。
 */
enum class CprPhase {
    /** 评估意识 / 呼吸。 */
    ASSESS,

    /** 呼叫急救（120）。 */
    CALL_EMS,

    /** 胸外按压（v1: CPR_ACTIVE）。 */
    COMPRESSION,

    /** 人工呼吸。 */
    RESCUE_BREATH,

    /** 使用 AED。 */
    AED,

    /** 交接给专业人员（生成 Handover 报告）。 */
    HANDOVER,
}

/** 触觉反馈模式，由硬件层映射为具体震动波形。 */
enum class HapticPattern {
    /** 单次轻触（如节拍）。 */
    TICK,

    /** 双击（提示切换）。 */
    DOUBLE,

    /** 强震（严重告警）。 */
    STRONG,
}
