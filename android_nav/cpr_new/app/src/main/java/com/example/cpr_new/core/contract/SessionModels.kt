package com.example.cpr_new.core.contract

/**
 * 会话日志与 Handover 报告契约。
 *
 * 流转关系（对应分工表）：
 *   PerceptionEvent + GuidanceAction --累积--> SessionLog --交给 Agent--> HandoverReport
 *
 * 第 4 部分负责：在会话过程中累积 [SessionLog]，最终把它交给第 2 部分的 Agent 生成
 * [HandoverReport]，并以 UI / 分享形式呈现。报告的“医学措辞”由 Agent 负责。
 */

/** 单条会话记录项（时间线上的一个事件）。 */
data class SessionLogEntry(
    val timestampMs: Long,
    val type: LogEntryType,
    /** 人类可读摘要，便于直接展示在时间线。 */
    val summary: String,
    /** 可扩展结构化负载（指标快照、动作 id 等）。 */
    val payload: Map<String, String> = emptyMap(),
)

enum class LogEntryType {
    /** 会话生命周期（开始 / 结束 / 暂停）。 */
    LIFECYCLE,

    /** 感知指标快照。 */
    PERCEPTION,

    /** Agent 指导动作。 */
    GUIDANCE,

    /** 用户操作（拨打 120、确认等）。 */
    USER_ACTION,

    /** 异常 / 兜底事件（断网、权限拒绝、识别失败等）。 */
    INCIDENT,
}

/**
 * 一次完整急救会话的日志聚合。不可变快照，便于线程安全地传给 Agent。
 */
data class SessionLog(
    val sessionId: String,
    val startedAtMs: Long,
    val endedAtMs: Long?,
    val entries: List<SessionLogEntry> = emptyList(),
    /** 关键聚合指标（如平均频率、按压占比），由编排层计算后填入。 */
    val metrics: Map<String, Float> = emptyMap(),
) {
    val durationMs: Long?
        get() = endedAtMs?.let { it - startedAtMs }
}

/**
 * 交接报告（Agent 产出，第 4 部分展示 / 分享）。
 */
data class HandoverReport(
    val sessionId: String,
    /** 一句话结论。 */
    val headline: String,
    /** 结构化要点（症状、已实施措施、用时、质量评分等）。 */
    val highlights: List<String>,
    /** 完整可读正文（可直接复制给医护）。 */
    val narrative: String,
    /** 现场定位信息（若可用）。 */
    val location: GeoSnapshot? = null,
    val generatedAtMs: Long,
)

/** 轻量地理坐标快照，避免 Android 端到处依赖 framework 的 Location 类型。 */
data class GeoSnapshot(
    val latitude: Double,
    val longitude: Double,
    /** 定位精度（米）。 */
    val accuracyMeters: Float? = null,
    val capturedAtMs: Long,
)
