package com.example.cpr_new.feature.session

import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GeoSnapshot
import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.HandoverReport
import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.PerceptionEvent

/**
 * 急救会话 UI 状态 —— 单一数据源（Single Source of Truth）。
 *
 * ViewModel 持有并更新它，Compose UI 只读渲染。所有字段都带默认值，
 * 保证“未开始 / 降级 / 异常”时 UI 都有可渲染的安全状态。
 */
data class CprSessionState(
    /** 会话是否进行中。 */
    val isActive: Boolean = false,
    /** 当前会话 id（驱动摄像头帧 / 日志对齐）。空串表示未开始。 */
    val sessionId: String = "",
    /** 当前急救阶段。 */
    val phase: CprPhase = CprPhase.ASSESS,

    /** 最近一次感知结果（可能为 null：尚未开始 / 识别失败）。 */
    val latestPerception: PerceptionEvent? = null,
    /** 最近一条 Agent 指导。 */
    val latestGuidance: GuidanceAction? = null,

    /** 实时按压质量分（0~100），由感知指标聚合而来，供仪表盘展示。 */
    val qualityScore: Int = 0,
    /** 节拍器目标频率与运行状态（镜像自 Metronome，方便 UI 一处读取）。 */
    val metronomeBpm: Int = Metronome.DEFAULT_BPM,
    val metronomeRunning: Boolean = false,

    /** 就绪标志：用于“模型加载中”兜底提示。 */
    val perceptionReady: Boolean = false,
    val agentReady: Boolean = false,

    /** Node Agent 当前阶段（如 S2_CHECK_RESPONSE），仅远程模式有值。 */
    val agentStage: String? = null,
    /** Agent 下发的可点击主按钮文案。 */
    val primaryButtonLabel: String? = null,
    /** Agent 主按钮动作码（如 mark_unresponsive）。 */
    val primaryButtonAction: String? = null,
    /** HTTP Agent 是否在线（/api/health、/api/turn）。 */
    val agentConnected: Boolean = false,
    /** WS /ws/live 是否已连接（语音流式 TTS/STT）。 */
    val liveWsConnected: Boolean = false,

    /** 麦克风/语音通道状态（对齐 first-aid MicState）。 */
    val micState: MicState = MicState.Idle,
    /** 流式 STT 中间结果（字幕）。 */
    val partialTranscript: String = "",
    /** 最近一次用户语音识别最终结果。 */
    val lastUserTranscript: String? = null,
    /** 麦克风音量 0~1，用于电平指示。 */
    val micLevel: Float = 0f,

    /** Agent UI 副文案（对齐 Copilot secondary_text）。 */
    val secondaryText: String = "",
    /** Agent UI 状态标签（对齐 Copilot status_tags）。 */
    val statusTags: List<String> = emptyList(),
    /** 视觉叠层模式（手位/频率/AED 等 Canvas 反馈）。 */
    val visualOverlayMode: String? = null,
    /** 校正箭头方向（left/right/up/down）。 */
    val correctionArrow: String? = null,
    /** Agent 回合处理中（禁用重复提交）。 */
    val isAgentInFlight: Boolean = false,

    /** 当前置顶的兜底/告警提示（断网、权限、识别失败等），null 表示无。 */
    val incidentBanner: String? = null,

    /** 最近一次定位快照（拨打 120 / attach_gps 时更新）。 */
    val latestGeo: GeoSnapshot? = null,
    /** 是否展示 120 发送确认弹层。 */
    val showEmergency120Sheet: Boolean = false,

    /** 会话结束后的交接报告。 */
    val handoverReport: HandoverReport? = null,

    /** 待用户二次确认的工具类型（如 share_video），null 表示无。 */
    val pendingConfirmTool: String? = null,
    /** 待确认弹窗文案。 */
    val pendingConfirmMessage: String? = null,
    /** 是否使用前置摄像头（默认后置）。 */
    val useFrontCamera: Boolean = false,
) {
    /** 频率是否在标准区间内，UI 用于决定仪表盘配色。 */
    val rateInRange: Boolean
        get() = latestPerception?.compressionRateBpm?.let {
            it >= PerceptionEvent.TARGET_RATE_MIN && it <= PerceptionEvent.TARGET_RATE_MAX
        } ?: false

    /** 手位是否正确（用于 UI 高亮）。 */
    val handPositionOk: Boolean
        get() = latestPerception?.handPosition == HandPosition.CENTER
}
