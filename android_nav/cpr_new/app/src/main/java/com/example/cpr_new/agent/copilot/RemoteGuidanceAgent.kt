package com.example.cpr_new.agent.copilot

import com.example.cpr_new.BuildConfig
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidanceAgent
import com.example.cpr_new.core.contract.GuidancePriority
import com.example.cpr_new.core.contract.HandoverReport
import com.example.cpr_new.core.contract.PerceptionEvent
import android.util.Log
import com.example.cpr_new.core.contract.SessionLog
import com.example.cpr_new.hardware.device.DeviceStateProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 通过 HTTP + WebSocket 连接 first-aid-co-pilot Node voice server。
 *
 * - HTTP `/api/turn`：会话启动、按钮回合、感知上报、交接
 * - WS `/ws/live`：流式 guidance、服务端 TTS 音频、阶段状态
 */
class RemoteGuidanceAgent(
    @Suppress("UNUSED_PARAMETER") context: android.content.Context,
    private val deviceStateProvider: DeviceStateProvider,
    private val transport: AgentTransport = HttpAgentTransport(BuildConfig.COPILOT_BASE_URL),
    private val wsChannel: WebSocketAgentChannel = WebSocketAgentChannel(BuildConfig.COPILOT_WS_URL),
) : GuidanceAgent, LiveAgentCapable {

    private val turnMutex = Mutex()
    private var sessionId: String = ""
    private var currentStage: String? = null
    private var lastPerceptionTurnMs: Long = 0L
    private var ready: Boolean = false

    override val isReady: Boolean get() = ready

    override val liveEvents: Flow<LiveAgentEvent> = wsChannel.events

    override val isLiveConnected: Boolean get() = wsChannel.isConnected

    override fun connectLive(sessionId: String) {
        this.sessionId = sessionId
        wsChannel.connect(sessionId)
    }

    override fun disconnectLive() {
        wsChannel.close()
    }

    override suspend fun resetSession(sessionId: String) {
        wsChannel.reset()
        transport.reset(sessionId)
        currentStage = null
        lastPerceptionTurnMs = 0L
    }

    override fun commitText(text: String, intent: String?) {
        wsChannel.commitText(text, intent)
    }

    override fun sendTurn(request: TurnRequest) {
        wsChannel.sendTurn(request)
    }

    override fun sendPcm(pcm16: ByteArray) {
        wsChannel.sendPcm(pcm16)
    }

    override fun sendBargeIn() {
        wsChannel.sendBargeIn()
    }

    override fun commitAudio() {
        wsChannel.commitAudio()
    }

    override suspend fun onSessionStart(sessionId: String): GuidanceAction {
        this.sessionId = sessionId
        connectLive(sessionId)
        ready = transport.health()
        if (!ready) {
            return offlineFallback(
                sessionId,
                "无法连接 Agent 服务。请确认 npm run voice:serve 已启动；" +
                    "真机/无线调试请在终端执行 adb reverse tcp:8787 tcp:8787 后重装 App",
            )
        }

        val request = sessionStartedRequest(sessionId, deviceStateProvider.snapshot())
        wsChannel.updateContext(request)
        return postTurn(request) ?: offlineFallback(sessionId, "Agent 未返回启动指导")
    }

    override fun guidance(perception: Flow<PerceptionEvent>): Flow<GuidanceAction> = flow {
        perception.collect { event ->
            if (!event.isReliable()) return@collect
            if (!shouldForwardPerception()) return@collect
            val now = System.currentTimeMillis()
            if (now - lastPerceptionTurnMs < PERCEPTION_MIN_INTERVAL_MS) return@collect
            lastPerceptionTurnMs = now

            val request = PerceptionEventMapper.toCprQualityTurn(
                sessionId = sessionId,
                event = event,
                deviceState = deviceStateProvider.snapshot(),
            )
            postTurn(request)?.let { emit(it) }
        }
    }

    /**
     * 按钮/快捷回复走 HTTP；在线语音仅 WS commit_text（guidance 由 WS 推送）。
     */
    override suspend fun submitUserTurn(
        sessionId: String,
        text: String,
        viaLiveVoice: Boolean,
    ): GuidanceAction? {
        this.sessionId = sessionId
        if (viaLiveVoice && isLiveConnected) {
            commitText(text)
            return null
        }
        val request = buildUserTurnRequest(sessionId, text)
        return postTurn(request)
    }

    override suspend fun publishDeviceState(sessionId: String): GuidanceAction? {
        this.sessionId = sessionId
        val request = TurnRequest(
            sessionId = sessionId,
            eventSource = "device",
            eventType = "device_state_update",
            deviceState = deviceStateProvider.snapshot(),
        )
        return postTurn(request)
    }

    override suspend fun submitToolResult(
        sessionId: String,
        toolType: String,
        confirmed: Boolean,
    ): GuidanceAction? {
        this.sessionId = sessionId
        val request = TurnRequest(
            sessionId = sessionId,
            eventSource = "device",
            eventType = "tool_result",
            deviceState = deviceStateProvider.snapshot(),
            toolResult = mapOf(
                "type" to toolType,
                "status" to if (confirmed) "ok" else "cancelled",
                "confirmed" to confirmed,
            ),
        )
        return postTurn(request)
    }

    override suspend fun buildHandover(log: SessionLog): HandoverReport {
        val request = TurnRequest(
            sessionId = log.sessionId,
            eventType = "handover_requested",
            eventSource = "device",
            deviceState = deviceStateProvider.snapshot(),
        )
        val guidance = postTurn(request)
        val narrative = guidance?.messageText?.takeIf { it.isNotBlank() }
            ?: guidance?.ttsText?.takeIf { it.isNotBlank() }
            ?: "会话 ${log.sessionId.take(8)} 已结束，请结合录音与日志向医护交接。"

        return HandoverReport(
            sessionId = log.sessionId,
            headline = "急救会话交接摘要",
            highlights = listOf(
                "按压时长约 ${log.durationMs?.div(1000) ?: 0} 秒",
                "最终质量分 ${log.metrics["finalQualityScore"]?.toInt() ?: 0}",
                "平均频率 ${log.metrics["avgCompressionRate"]?.toInt() ?: 0} 次/分",
            ),
            narrative = narrative,
            generatedAtMs = System.currentTimeMillis(),
        )
    }

    fun updateStage(stage: String?) {
        currentStage = stage
    }

    private fun buildUserTurnRequest(sessionId: String, text: String): TurnRequest {
        val normalized = text.lowercase()
        val deviceState = deviceStateProvider.snapshot()

        fun hasAny(vararg needles: String): Boolean = needles.any { normalized.contains(it) }

        return when {
            hasAny("现场安全", "安全了", "环境安全", "scene safe") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "patient_state_update",
                patientState = mapOf("scene_safe" to true),
                metadata = mapOf("scene_safe" to true),
                deviceState = deviceState,
            )

            hasAny("没有反应", "没反应", "无反应", "unresponsive") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "patient_state_update",
                patientState = mapOf("responsive" to false),
                deviceState = deviceState,
            )

            hasAny("有反应", "醒着", "responsive") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "patient_state_update",
                patientState = mapOf("responsive" to true),
                deviceState = deviceState,
            )

            hasAny("没有呼吸", "没呼吸", "无呼吸", "无正常呼吸", "不呼吸", "喘一下", "喘气", "agonal") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "breathing_update",
                patientState = mapOf(
                    "normal_breathing" to false,
                    "agonal_breathing" to hasAny("喘", "agonal"),
                ),
                deviceState = deviceState,
            )

            hasAny("正常呼吸", "有呼吸", "breathing normally") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "breathing_update",
                patientState = mapOf("normal_breathing" to true),
                deviceState = deviceState,
            )

            hasAny("已拨打", "已经拨打", "打了120", "拨了120", "called 120") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "device_state_update",
                deviceState = deviceState + mapOf("emergency_call_started" to true),
                metadata = mapOf("emergency_call_started" to true),
            )

            hasAny("准备好了", "开始按压", "开始cpr", "开始 cpr", "可以开始", "continue cpr") -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "cpr_quality_update",
                cprQuality = mapOf("compressions_started" to true, "started" to true),
                deviceState = deviceState,
            )

            else -> TurnRequest(
                sessionId = sessionId,
                text = text,
                eventSource = "ui",
                eventType = "user_response",
                deviceState = deviceState,
            )
        }
    }

    private suspend fun postTurn(request: TurnRequest): GuidanceAction? = turnMutex.withLock {
        Log.d("RemoteAgent", "postTurn: eventType=${request.eventType}, text=${request.text?.take(50)}")
        when (val result = transport.turn(request)) {
            is TurnResult.Success -> {
                val response = result.response
                Log.d("RemoteAgent", "postTurn success: ok=${response.ok}, stage=${response.currentStage}, guidanceAction=${response.guidanceAction != null}")
                if (!response.ok) {
                    return offlineFallback(request.sessionId, response.error ?: "Agent 返回错误")
                }
                currentStage = response.currentStage ?: response.guidanceAction?.stage
                if (response.guidanceAction == null) {
                    Log.w("RemoteAgent", "postTurn: guidanceAction is null, stage=${response.currentStage}")
                }
                response.guidanceAction?.let { copilot ->
                    CopilotActionMapper.toLocalAction(
                        copilot,
                        request.sessionId,
                        ttsAudioSrc = response.ttsAudioSrc,
                    )
                }
            }

            is TurnResult.Failure -> {
                Log.e("RemoteAgent", "postTurn failure: ${result.error.message}")
                if (isCompressionStage()) {
                    return offlineCompressionFallback(request.sessionId, result.error.message)
                }
                ready = false
                offlineFallback(request.sessionId, result.error.message)
            }
        }
    }

    private fun shouldForwardPerception(): Boolean = isCompressionStage()

    private fun isCompressionStage(): Boolean {
        val stage = currentStage ?: return false
        return stage.contains("S7") || stage.contains("S8") || stage.contains("MONITOR")
    }

    private fun offlineFallback(sessionId: String, message: String): GuidanceAction =
        GuidanceAction(
            actionId = "offline_${System.currentTimeMillis()}",
            sessionId = sessionId,
            messageText = message,
            ttsText = "",
            phase = CprPhase.ASSESS,
            priority = GuidancePriority.HIGH,
            metadata = mapOf("offline" to "true"),
        )

    private fun offlineCompressionFallback(sessionId: String, message: String): GuidanceAction =
        GuidanceAction(
            actionId = "offline_cpr_${System.currentTimeMillis()}",
            sessionId = sessionId,
            messageText = "继续按压",
            ttsText = "",
            phase = CprPhase.COMPRESSION,
            priority = GuidancePriority.HIGH,
            targetRate = 110,
            metadata = mapOf(
                "offline" to "partial",
                "offline_detail" to message,
                "tool_types" to CopilotHapticTools.UPDATE,
                "copilot_stage" to (currentStage ?: "S7_CPR_LOOP"),
            ),
        )

    companion object {
        private const val PERCEPTION_MIN_INTERVAL_MS = 2_000L
    }
}
