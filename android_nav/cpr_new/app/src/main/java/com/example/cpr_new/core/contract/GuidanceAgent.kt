package com.example.cpr_new.core.contract

import kotlinx.coroutines.flow.Flow

/**
 * 决策 Agent 接口（由第 2 部分 Edge Gemma 实现，第 4 部分消费）。
 *
 * 第 4 部分把感知事件流交给 Agent，Agent 返回指导动作流；
 * 会话结束时再把累积日志交给 Agent 生成交接报告。
 *
 * 可扩展性：
 * - 真实实现（端侧 Gemma 推理）与 Mock 实现都满足此接口；
 * - 入参/出参均为 [Flow]，天然支持流式、可取消、可背压。
 */
interface GuidanceAgent {

    /**
     * 会话开始时的首条指导（如“确认环境安全，轻拍呼叫患者”）。
     * @param sessionId 本次会话 id，由 Android 下发，便于 Agent 内部按会话维护状态。
     */
    suspend fun onSessionStart(sessionId: String): GuidanceAction

    /**
     * 将感知事件流转换为指导动作流。
     * 实现方内部维护对话状态机；第 4 部分只负责呈现产出的动作。
     */
    fun guidance(perception: Flow<PerceptionEvent>): Flow<GuidanceAction>

    /** 基于完整会话日志生成交接报告。 */
    suspend fun buildHandover(log: SessionLog): HandoverReport

    /**
     * 用户按钮/语音触发的额外回合（远程 Agent 实现；Mock 默认忽略）。
     * @return 新的指导动作；无更新时返回 null。
     */
    suspend fun submitUserTurn(
        sessionId: String,
        text: String,
        viaLiveVoice: Boolean = false,
    ): GuidanceAction? = null

    /** 用户确认/拒绝需二次授权的工具（如分享视频）。 */
    suspend fun submitToolResult(
        sessionId: String,
        toolType: String,
        confirmed: Boolean,
    ): GuidanceAction? = null

    /** 主动上报设备状态变化（如拨号完成），供 co-pilot 状态机跟进。 */
    suspend fun publishDeviceState(sessionId: String): GuidanceAction? = null

    /** Agent 是否就绪（模型加载完成）。用于“模型加载慢”的 UI 兜底。 */
    val isReady: Boolean
}
