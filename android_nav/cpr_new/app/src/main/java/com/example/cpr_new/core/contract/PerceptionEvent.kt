package com.example.cpr_new.core.contract

/**
 * 感知事件契约（第 3 部分 -> 第 4 部分）。对齐《CPR 感知模块接口与交接说明 v1》。
 *
 * 设计原则：
 * - 这是“CPR 感知识别 / 质量评估”模块向 Android 终端输出的**结构化结果**，
 *   第 4 部分只消费、不计算。算法与评分（quality_score）都由第 3 部分负责。
 * - 字段全部可空 / 带置信度，便于在识别失败、模型未就绪时由 UI 做兜底降级。
 * - [rawSignals] 作为可扩展口袋字段，后续新增原始信号时无需改动 Android 端编译。
 *
 * 字段对应 v1：event_id / session_id / timestamp_ms / phase / camera_view /
 * compression_rate_bpm / interruption_ms / hand_position / arm_straight /
 * quality_score / confidence。
 */
data class PerceptionEvent(
    /** 事件唯一 id（v1: event_id）。GuidanceAction 通过 sourceEventId 回溯到它。 */
    val eventId: String,
    /** 所属会话 id，由 Android 经 [CprPerceptionSource.start] 下发并回填。 */
    val sessionId: String,
    /** 事件时间戳（毫秒，单调时钟，见 [CameraInputSpec.TIMESTAMP_CLOCK]）。 */
    val timestampMs: Long,
    /** 急救阶段。MVP 阶段第 3 部分只产 CPR_ACTIVE，对应这里的 [CprPhase.COMPRESSION]。 */
    val phase: CprPhase = CprPhase.COMPRESSION,
    /** 机位信息（v1: camera_view），默认演示机位 SIDE_FRONT。 */
    val cameraView: CameraView = CameraView.SIDE_FRONT,
    /** 按压频率（次 / 分钟，v1: compression_rate_bpm）。null 表示当前帧无法判定。 */
    val compressionRateBpm: Float? = null,
    /** 距上次有效按压的间隔（毫秒，v1: interruption_ms）。用于判断是否中断。 */
    val interruptionMs: Long = 0L,
    /** 手部按压位置评估（v1: hand_position）。 */
    val handPosition: HandPosition = HandPosition.UNKNOWN,
    /** 手臂是否伸直（v1: arm_straight）。 */
    val armStraight: Boolean = true,
    /**
     * 综合质量评分 0~100（v1: quality_score）。
     * **由第 3 部分按其评分规则算好**（position/rhythm/continuity/posture 加权），
     * Android 直接展示，不重新计算（评分非本模块职责）。
     */
    val qualityScore: Int = 0,
    /** 本次识别整体置信度（0f~1f）。低置信度时 UI 应弱化提示、避免误导。 */
    val confidence: Float = 0f,
    /** 可扩展原始信号字典（如关键点坐标、各子项评分等），默认空，便于平滑演进。 */
    val rawSignals: Map<String, Float> = emptyMap(),
) {
    /** 置信度是否达到可用于驱动 UI 的最低阈值。集中在此便于统一调参。 */
    fun isReliable(threshold: Float = MIN_RELIABLE_CONFIDENCE): Boolean = confidence >= threshold

    /** 是否构成“按压中断”：间隔超过暂停阈值（v1: pause_threshold_ms）。 */
    fun isInterrupted(thresholdMs: Long = PAUSE_THRESHOLD_MS): Boolean = interruptionMs >= thresholdMs

    companion object {
        const val MIN_RELIABLE_CONFIDENCE = 0.5f

        /** 标准成人 CPR 推荐按压频率区间（次 / 分钟，v1: target_bpm_min/max）。 */
        const val TARGET_RATE_MIN = 100
        const val TARGET_RATE_MAX = 120

        /** 判定按压中断的间隔阈值（毫秒，v1: pause_threshold_ms）。 */
        const val PAUSE_THRESHOLD_MS = 1500L
    }
}

/**
 * 手部按压位置（v1: hand_position）。
 * CENTER 为正确位置，其余为需要纠正的偏移方向。
 */
enum class HandPosition {
    /** 位置正确（胸部正中）。 */
    CENTER,

    /** 偏左，应向右移。 */
    LEFT,

    /** 偏右，应向左移。 */
    RIGHT,

    /** 偏高，应向下移。 */
    HIGH,

    /** 偏低，应向上移。 */
    LOW,

    /** 无法识别 / 画面中无有效目标。 */
    UNKNOWN,
}

/** 机位（v1: camera_view）。MVP 默认 SIDE_FRONT，其余预留扩展。 */
enum class CameraView {
    /** 侧前方（默认演示机位）。 */
    SIDE_FRONT,

    /** 正前方。 */
    FRONT,

    /** 正侧方。 */
    SIDE,

    /** 顶部俯拍。 */
    TOP,

    /** 未知 / 未标定。 */
    UNKNOWN,
}
