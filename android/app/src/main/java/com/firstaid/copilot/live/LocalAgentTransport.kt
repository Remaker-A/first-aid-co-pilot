package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.ToolAction
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch

/**
 * On-device, rule-driven agent transport for the Live CPR Coach.
 *
 * This is the phone-side replacement for the old `/api/turn` dependency in the
 * core live flow. It intentionally stays deterministic: medical progression,
 * CPR correction, 120 simulation, haptics, and handoff are rule-owned. Gemma is
 * still attached separately through the existing edge seams for NLU/open
 * questions/proactive polish, never for critical medical state transitions.
 */
class LocalAgentTransport(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val nowIso: () -> String = { Instant.now().toString() },
) : AgentTransport {
    private val sessions = LinkedHashMap<String, LocalSession>()

    override suspend fun turn(request: TurnRequest): TurnResult {
        val startMs = clockMs()
        val session = synchronized(sessions) {
            sessions.getOrPut(request.sessionId) { LocalSession(request.sessionId) }
        }
        val event = LocalTurnEvent.from(request)
        val response = synchronized(session) {
            session.applyEvent(event)
            val previousStage = session.currentStage
            val nextStage = session.nextStage(event)
            session.currentStage = nextStage
            val action = session.actionFor(previousStage, nextStage, event, nowIso())
            TurnResponse(
                ok = true,
                sessionId = session.sessionId,
                transcript = event.transcript,
                currentStage = session.currentStage,
                guidanceAction = action,
                eventSource = event.source,
                eventMode = "demo_assisted",
                responseType = responseTypeFor(action),
                guidanceSource = action.source,
                ttsText = action.tts.text,
                ttsAudioUrl = null,
                ttsAudioDataUrl = null,
                timings = mapOf("total_ms" to (clockMs() - startMs).coerceAtLeast(0L)),
                error = null,
            )
        }
        return TurnResult.Success(response)
    }

    override suspend fun reset(sessionId: String) {
        synchronized(sessions) {
            sessions.remove(sessionId)
        }
    }

    override suspend fun health(): Boolean = true
}

/**
 * Live channel facade backed by [AgentTransport] instead of a WebSocket.
 *
 * Keeping the same channel interface means the ViewModel's online/live path can
 * run without a cable or local Node server. PCM is intentionally ignored here:
 * Android captures audio and runs Sherpa locally, then commits final text.
 */
class LocalAgentChannel(
    private val transport: AgentTransport,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : LiveAgentChannel {
    private val _events = MutableSharedFlow<LiveAgentEvent>(
        replay = 0,
        extraBufferCapacity = 64,
    )
    override val events: Flow<LiveAgentEvent> = _events

    private var sessionId: String = ""

    override fun connect(sessionId: String, mode: String) {
        this.sessionId = sessionId
        emit(LiveAgentEvent.ConnectionChanged(connected = true, message = "On-device agent"))
    }

    override fun updateContext(request: TurnRequest) = Unit

    override fun sendTurn(request: TurnRequest) {
        runTurn(request)
    }

    override fun sendPcm(pcm16: ByteArray) = Unit

    override fun commitText(text: String, intent: String?) {
        if (text.isBlank()) return
        val metadata = intent
            ?.takeIf(String::isNotBlank)
            ?.let { mapOf("intent_hint" to it, "intent_source" to "local_live_commit") }
        runTurn(TurnRequest(sessionId = sessionId, text = text, metadata = metadata))
    }

    override fun sendBargeIn() = Unit

    override fun reset() {
        val id = sessionId
        scope.launch {
            transport.reset(id)
            emit(LiveAgentEvent.ConnectionChanged(connected = true, message = "On-device agent reset"))
        }
    }

    override fun close() {
        scope.cancel()
    }

    private fun runTurn(request: TurnRequest) {
        scope.launch {
            emit(LiveAgentEvent.Thinking(turnSeq = null))
            when (val result = transport.turn(request)) {
                is TurnResult.Success -> {
                    val response = result.response
                    val action = response.guidanceAction
                    if (action != null) {
                        emit(
                            LiveAgentEvent.Guidance(
                                action = action,
                                response = response,
                                guidanceSource = response.guidanceSource,
                                responseType = response.responseType,
                            ),
                        )
                    } else {
                        emit(LiveAgentEvent.State(response.currentStage))
                    }
                }
                is TurnResult.Failure -> {
                    emit(LiveAgentEvent.ConnectionChanged(connected = false, message = result.error.message))
                    emit(LiveAgentEvent.Error(result.error.message))
                }
            }
        }
    }

    private fun emit(event: LiveAgentEvent) {
        _events.tryEmit(event)
    }
}

private data class LocalTurnEvent(
    val transcript: String,
    val intent: String?,
    val source: String?,
    val type: String?,
    val patientState: Map<String, Any?>,
    val cprQuality: Map<String, Any?>,
    val rescuerState: Map<String, Any?>,
    val deviceState: Map<String, Any?>,
    val metadata: Map<String, Any?>,
    val toolResult: Map<String, Any?>,
) {
    companion object {
        fun from(request: TurnRequest): LocalTurnEvent {
            val metadata = request.metadata.orEmpty()
            val transcript = request.text?.trim().orEmpty()
            val intent = metadata.string("intent_hint")
                ?: inferLiveFastIntent(transcript)?.intent
                ?: inferButtonIntent(transcript)
            return LocalTurnEvent(
                transcript = transcript,
                intent = intent,
                source = request.eventSource ?: inferSource(request),
                type = request.eventType ?: inferType(request, intent),
                patientState = request.patientState.orEmpty(),
                cprQuality = request.cprQuality.orEmpty(),
                rescuerState = request.rescuerState.orEmpty(),
                deviceState = request.deviceState.orEmpty(),
                metadata = metadata,
                toolResult = request.toolResult.orEmpty(),
            )
        }
    }
}

private class LocalSession(
    val sessionId: String,
) {
    var currentStage: String = "S0_INIT"
    private var sceneSafe: Boolean? = null
    private var responsive: Boolean? = null
    private var normalBreathing: Boolean? = null
    private var agonalBreathing: Boolean? = null
    private var emergencyCallStarted: Boolean = false
    private var cprStarted: Boolean = false
    private var handPosition: String? = null
    private var armPosture: String? = null
    private var compressionRate: Double? = null
    private var interruptionSeconds: Double = 0.0
    private var qualityScore: Int? = null
    private var fatigueLevel: String? = null
    private var aedAvailable: Boolean = false

    fun applyEvent(event: LocalTurnEvent) {
        event.metadata.boolean("scene_safe")?.let { sceneSafe = it }
        event.patientState.boolean("scene_safe")?.let { sceneSafe = it }
        event.patientState.boolean("responsive")?.let { responsive = it }
        event.patientState.boolean("normal_breathing")?.let { normalBreathing = it }
        event.patientState.boolean("agonal_breathing")?.let { agonalBreathing = it }
        event.deviceState.boolean("emergency_call_started")?.let { emergencyCallStarted = it }
        event.deviceState.string("emergency_call_status")
            ?.takeIf { it == "started" || it == "connected" }
            ?.let { emergencyCallStarted = true }
        event.rescuerState.string("fatigue_level")?.let { fatigueLevel = it }
        event.metadata.boolean("aed_available")?.let { aedAvailable = it }
        event.deviceState.boolean("aed_available")?.let { aedAvailable = it }
        event.rescuerState.boolean("aed_available")?.let { aedAvailable = it }

        if (event.cprQuality.isNotEmpty()) {
            cprStarted = event.cprQuality.boolean("compressions_started") ?: cprStarted
            compressionRate = event.cprQuality.number("compression_rate")
                ?: event.cprQuality.number("compression_rate_bpm")
                ?: event.cprQuality.number("current_rate")
                ?: event.cprQuality.number("rate")
                ?: compressionRate
            qualityScore = event.cprQuality.number("quality_score")?.let { normalizeQualityScore(it) } ?: qualityScore
            handPosition = event.cprQuality.string("hand_position") ?: handPosition
            armPosture = event.cprQuality.string("arm_posture") ?: event.cprQuality.string("arm_position") ?: armPosture
            event.cprQuality.boolean("arm_straight")
                ?.let { armPosture = if (it) "straight" else "bent" }
            interruptionSeconds = event.cprQuality.number("interruption_seconds")
                ?: event.cprQuality.number("last_interruption_seconds")
                ?: interruptionSeconds
        }

        val readinessBridge = currentStage.isCprReadinessBridgeStage() &&
            isLocalCprReadinessUtterance(event.transcript)
        if (readinessBridge) {
            if (currentStage == "S5_CALL_EMERGENCY") {
                emergencyCallStarted = true
            }
            if (isCprStartStage(currentStage)) {
                cprStarted = true
            }
        }

        when (event.intent) {
            "scene_safe" -> sceneSafe = true
            "scene_unsafe" -> sceneSafe = false
            "patient_responsive", "responsive" -> responsive = true
            "patient_unresponsive", "unresponsive" -> responsive = false
            "normal_breathing", "normal_breathing_present" -> normalBreathing = true
            "no_normal_breathing", "normal_breathing_absent", "breathing_absent" -> normalBreathing = false
            "agonal_breathing" -> {
                normalBreathing = false
                agonalBreathing = true
            }
            "emergency_called" -> emergencyCallStarted = true
            "continue_cpr", "compressions_reported" -> {
                if (currentStage == "S5_CALL_EMERGENCY") {
                    emergencyCallStarted = true
                }
                if (isCprStartStage(currentStage)) {
                    cprStarted = true
                }
            }
            "step_done" -> if (currentStage == "S6_CPR_READY") cprStarted = true
            "aed_available" -> aedAvailable = true
        }
    }

    fun nextStage(event: LocalTurnEvent): String {
        if (isHandoverRequested(event)) return "S9_HANDOVER"
        if (isSignsOfLife(event)) return "MONITOR_BREATHING"
        return when (currentStage) {
            "S0_INIT" -> "S1_SCENE_SAFE"
            "S1_SCENE_SAFE" -> if (sceneSafe == true) "S2_CHECK_RESPONSE" else "S1_SCENE_SAFE"
            "S2_CHECK_RESPONSE" -> when (responsive) {
                true -> "MONITOR_RESPONSE"
                false -> "S3_CHECK_BREATHING"
                null -> "S2_CHECK_RESPONSE"
            }
            "S3_CHECK_BREATHING" -> when {
                normalBreathing == true -> "MONITOR_BREATHING"
                normalBreathing == false || agonalBreathing == true -> "S5_CALL_EMERGENCY"
                else -> "S3_CHECK_BREATHING"
            }
            "S4_SUSPECTED_ARREST" -> "S5_CALL_EMERGENCY"
            "S5_CALL_EMERGENCY" -> if (emergencyCallStarted) "S6_CPR_READY" else "S5_CALL_EMERGENCY"
            "S6_CPR_READY" -> if (cprStarted || event.cprQuality.isNotEmpty()) "S7_CPR_LOOP" else "S6_CPR_READY"
            "S7_CPR_LOOP" -> if (aedAvailable || isFatigueHigh()) "S8_ASSISTANCE" else "S7_CPR_LOOP"
            "S8_ASSISTANCE" -> if (event.intent == "continue_cpr" || event.cprQuality.isNotEmpty()) "S7_CPR_LOOP" else "S8_ASSISTANCE"
            "MONITOR_RESPONSE", "MONITOR_BREATHING" -> if (isCprRestart(event)) "S7_CPR_LOOP" else currentStage
            "S9_HANDOVER" -> "S9_HANDOVER"
            else -> "S1_SCENE_SAFE"
        }
    }

    fun actionFor(previousStage: String, nextStage: String, event: LocalTurnEvent, timestamp: String): GuidanceAction {
        val feedback = if (nextStage == "S7_CPR_LOOP") feedbackAction(timestamp) else null
        val question = closedQuestionAction(nextStage, event, timestamp)
        return feedback ?: question ?: when (nextStage) {
            "S1_SCENE_SAFE" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = if (sceneSafe == false) "warn_scene_unsafe" else "ensure_scene_safe",
                priority = if (sceneSafe == false) "critical" else "normal",
                tts = if (sceneSafe == false) "先保证自身安全，呼叫 120，不要进入危险区域。" else "开始记录。先确认周围安全，安全后靠近患者。",
                main = if (sceneSafe == false) "先保证安全" else "确认现场安全",
                secondary = if (sceneSafe == false) "不要进入危险区域" else "安全后靠近患者",
                tags = listOf("现场安全", "靠近患者"),
                primaryButton = mapOf("label" to "现场安全", "action" to "mark_scene_safe"),
                tools = if (sceneSafe == false) listOf(emergencyCallTool()) else emptyList(),
            )
            "S2_CHECK_RESPONSE" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "ask_response_check",
                priority = "normal",
                tts = "请大声呼叫他，并轻拍双肩。",
                main = "检查反应",
                secondary = "呼叫并轻拍双肩",
                tags = listOf("呼叫", "拍肩"),
                primaryButton = mapOf("label" to "没有反应", "action" to "mark_unresponsive"),
            )
            "S3_CHECK_BREATHING" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "ask_breathing_check",
                priority = "high",
                tts = "看他的胸口。只是偶尔大口喘，或者完全不动，都算没有正常呼吸。",
                main = "检查呼吸",
                secondary = "看胸口 5 到 10 秒",
                tags = listOf("看胸口", "正常呼吸"),
                primaryButton = mapOf("label" to "无正常呼吸", "action" to "mark_no_normal_breathing"),
            )
            "S5_CALL_EMERGENCY" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "start_emergency_call_and_cpr",
                priority = "critical",
                tts = "按疑似心脏骤停处理。我将为你拨打 120，请保持手机免提。现在准备胸外按压。",
                main = "正在呼叫 120",
                secondary = "保持免提，准备胸外按压",
                tags = listOf("呼叫120", "GPS", "录制"),
                primaryButton = mapOf("label" to "已拨打120", "action" to "mark_emergency_called"),
                overlay = mapOf("mode" to "prepare_cpr_position", "highlight_target" to "chest_center"),
                tools = listOf(
                    emergencyCallTool(),
                    ToolAction(type = "start_local_recording", requires_user_confirmation = false),
                    ToolAction(type = "attach_gps_location", requires_user_confirmation = false),
                ),
            )
            "S6_CPR_READY" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "guide_cpr_position",
                priority = "critical",
                tts = "双手叠在他胸口中央，手臂伸直。准备好就说开始，或点开始按压。",
                main = "双手叠在胸口中央",
                secondary = "手臂伸直，准备好就开始",
                tags = listOf("胸口中央", "手臂伸直"),
                primaryButton = mapOf("label" to "开始按压", "action" to "mark_cpr_ready"),
                overlay = mapOf("mode" to "prepare_cpr_position", "highlight_target" to "chest_center"),
            )
            "S7_CPR_LOOP" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = if (previousStage == "S6_CPR_READY" || previousStage.startsWith("MONITOR")) {
                    "start_cpr_loop"
                } else {
                    "continue_cpr_loop"
                },
                priority = if (previousStage == "S6_CPR_READY" || previousStage.startsWith("MONITOR")) {
                    "critical"
                } else {
                    "normal"
                },
                tts = if (previousStage == "S6_CPR_READY" || previousStage.startsWith("MONITOR")) {
                    "现在开始按压，跟着节拍，用力快压。"
                } else {
                    "继续保持这个节奏。"
                },
                main = if (previousStage == "S6_CPR_READY" || previousStage.startsWith("MONITOR")) "开始按压" else "持续 CPR",
                secondary = "目标 100 到 120 次每分钟",
                tags = listOf("快速有力", "跟着节拍"),
                quality = qualityScore,
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to "cpr_loop", "highlight_target" to "chest_center"),
                tools = listOf(ToolAction(type = "start_haptic_metronome", requires_user_confirmation = false, bpm = 110)),
            )
            "S8_ASSISTANCE" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = if (aedAvailable) "assist_aed" else "assist_rescuer_fatigue",
                priority = "normal",
                tts = if (aedAvailable) {
                    "AED 到了。让旁人打开它并跟着语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。"
                } else {
                    "如果旁边有人，请准备换手。尽量保持按压不中断。"
                },
                main = if (aedAvailable) "AED 到达" else "准备换手",
                secondary = if (aedAvailable) "打开 AED，分析或电击时所有人离开" else "继续胸外按压",
                tags = if (aedAvailable) listOf("AED", "继续按压") else listOf("换手", "不要中断"),
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to if (aedAvailable) "aed_assistance" else "rescuer_assistance"),
            )
            "MONITOR_RESPONSE" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "monitor_responsive_patient",
                priority = "normal",
                tts = "他有反应，先不要做胸外按压。请呼叫 120 并持续观察。",
                main = "持续观察",
                secondary = "呼叫 120，不做胸外按压",
                tags = listOf("有反应", "观察", "呼叫120"),
                tools = listOf(emergencyCallTool()),
            )
            "MONITOR_BREATHING" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "monitor_breathing_patient",
                priority = "high",
                tts = "他有正常呼吸，先不要做胸外按压。请呼叫 120 并持续观察。",
                main = "持续观察呼吸",
                secondary = "呼叫 120，不做胸外按压",
                tags = listOf("正常呼吸", "观察", "呼叫120"),
                tools = listOf(emergencyCallTool()),
            )
            "S9_HANDOVER" -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "generate_handover_report",
                priority = "critical",
                tts = "急救员到达。把位置让给他们，后面听他们的。我在生成交接报告。",
                main = "交给急救员",
                secondary = "让位并听从急救员，生成交接报告",
                tags = listOf("交接报告", "听急救员"),
                tools = listOf(
                    ToolAction(type = "stop_haptic_metronome", requires_user_confirmation = false),
                    ToolAction(type = "generate_handover_report", requires_user_confirmation = false),
                ),
            )
            else -> action(
                timestamp = timestamp,
                stage = nextStage,
                intent = "noop",
                priority = "low",
                tts = "",
                main = "",
                secondary = "",
                tags = emptyList(),
            )
        }
    }

    private fun feedbackAction(timestamp: String): GuidanceAction? {
        val rate = compressionRate
        val freshActionableRate = rate != null && rate != 0.0 && (rate < 100.0 || rate > 120.0)
        if (interruptionSeconds >= 2.0 && !freshActionableRate) {
            return action(
                timestamp = timestamp,
                stage = "S7_CPR_LOOP",
                intent = "correct_compression_interruption",
                priority = "critical",
                tts = "不要停，继续按压。",
                main = "继续按压",
                secondary = "中断时间过长",
                tags = listOf("不要停", "继续按压"),
                quality = qualityScore,
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to "continue_compressions"),
            )
        }
        handPositionFeedback(timestamp)?.let { return it }
        if (rate != null && rate < 100.0) {
            return action(
                timestamp = timestamp,
                stage = "S7_CPR_LOOP",
                intent = "correct_compression_rate",
                priority = "high",
                tts = "再快一点，跟着节拍按。",
                main = "按压偏慢",
                secondary = "目标 100 到 120 次每分钟",
                tags = listOf("偏慢", "跟着节拍"),
                quality = qualityScore,
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to "rate_feedback"),
            )
        }
        if (rate != null && rate > 120.0) {
            return action(
                timestamp = timestamp,
                stage = "S7_CPR_LOOP",
                intent = "correct_compression_rate",
                priority = "high",
                tts = "稍微慢一点，跟着节拍按。",
                main = "按压偏快",
                secondary = "目标 100 到 120 次每分钟",
                tags = listOf("偏快", "跟着节拍"),
                quality = qualityScore,
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to "rate_feedback"),
            )
        }
        if (armPosture == "bent") {
            return action(
                timestamp = timestamp,
                stage = "S7_CPR_LOOP",
                intent = "correct_arm_posture",
                priority = "high",
                tts = "手臂伸直，用上半身向下压。",
                main = "手臂伸直",
                secondary = "用上半身向下压",
                tags = listOf("手臂伸直", "向下压"),
                quality = qualityScore,
                haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
                overlay = mapOf("mode" to "arm_posture_feedback"),
            )
        }
        return null
    }

    private fun closedQuestionAction(stage: String, event: LocalTurnEvent, timestamp: String): GuidanceAction? {
        if (!stage.isCprQuestionStage()) return null
        val haptic = if (stage.isMetronomeStage()) {
            HapticPayload(enabled = true, pattern = "metronome", bpm = 110)
        } else {
            HapticPayload(enabled = false)
        }
        val overlay = if (stage == "S6_CPR_READY") {
            mapOf("mode" to "prepare_cpr_position", "highlight_target" to "chest_center")
        } else {
            mapOf("mode" to "cpr_loop", "highlight_target" to "chest_center")
        }

        return when (event.intent) {
            "ask_cpr_quality" -> {
                val positionQuestion = isPositionQuestion(event.transcript) || stage == "S6_CPR_READY"
                action(
                    timestamp = timestamp,
                    stage = stage,
                    intent = if (stage == "S6_CPR_READY") "answer_position_question" else "answer_current_cpr_question",
                    priority = "high",
                    tts = if (positionQuestion) {
                        if (stage == "S6_CPR_READY") {
                            "手掌根放在胸口中央，两乳头连线中点，手臂伸直；放好就说开始。"
                        } else {
                            "手掌根压在胸口中央，两乳头连线中点；如果偏了我会提醒，现在继续按压。"
                        }
                    } else {
                        "继续保持这个节奏，目标每分钟 100 到 120 次；我会继续看位置和节奏。"
                    },
                    main = if (positionQuestion) "胸口中央" else "继续保持",
                    secondary = if (positionQuestion) "两乳头连线中点" else "目标 100 到 120 次每分钟",
                    tags = if (positionQuestion) listOf("胸口中央", "继续按压") else listOf("节奏", "继续按压"),
                    haptic = haptic,
                    overlay = overlay,
                    source = "rule_fast_path",
                )
            }
            "ask_can_stop" -> action(
                timestamp = timestamp,
                stage = stage,
                intent = "answer_current_cpr_question",
                priority = "high",
                tts = "不要停，继续按压；等 AED 或急救人员接手，或他恢复正常呼吸再停。",
                main = "不要停",
                secondary = "继续胸外按压",
                tags = listOf("不要停", "继续按压"),
                haptic = haptic,
                overlay = overlay,
                source = "rule_fast_path",
            )
            "ask_aed_cpr_alternation" -> action(
                timestamp = timestamp,
                stage = stage,
                intent = if (stage == "S8_ASSISTANCE") "explain_aed_support" else "answer_current_cpr_question",
                priority = "high",
                tts = "继续按压。让旁人贴好 AED 电极并跟着语音做；AED 分析或提示电击时，所有人离开，结束后马上继续按压。",
                main = "AED 配合按压",
                secondary = "分析或电击时离开，结束后继续按压",
                tags = listOf("AED", "继续按压"),
                haptic = haptic,
                overlay = mapOf("mode" to "aed_assistance"),
                source = "rule_fast_path",
            )
            "ask_aed_help" -> action(
                timestamp = timestamp,
                stage = stage,
                intent = if (stage == "S8_ASSISTANCE") "explain_aed_support" else "answer_current_cpr_question",
                priority = "high",
                tts = "打开 AED，跟着它的语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。",
                main = "AED 协助",
                secondary = "继续按压，分析或电击时离开",
                tags = listOf("AED", "继续按压"),
                haptic = haptic,
                overlay = mapOf("mode" to "aed_assistance"),
                source = "rule_fast_path",
            )
            "ask_next_step" -> action(
                timestamp = timestamp,
                stage = stage,
                intent = "answer_current_cpr_question",
                priority = "normal",
                tts = if (stage == "S6_CPR_READY") {
                    "下一步就是开始胸外按压。手放胸口中央，手臂伸直，准备好就说开始。"
                } else {
                    "继续按压，跟着节拍保持节奏；我会继续看位置和节奏。"
                },
                main = if (stage == "S6_CPR_READY") "准备开始按压" else "继续按压",
                secondary = if (stage == "S6_CPR_READY") "胸口中央，手臂伸直" else "目标 100 到 120 次每分钟",
                tags = listOf("下一步", "继续按压"),
                haptic = haptic,
                overlay = overlay,
                source = "rule_fast_path",
            )
            "ask_emergency_call" -> action(
                timestamp = timestamp,
                stage = stage,
                intent = "answer_current_cpr_question",
                priority = "normal",
                tts = if (emergencyCallStarted) {
                    "120 已经在呼叫中，保持手机免提，你继续胸外按压。"
                } else {
                    "需要立刻拨打 120。拨通后保持免提，同时准备继续胸外按压。"
                },
                main = if (emergencyCallStarted) "120 已呼叫" else "呼叫 120",
                secondary = "保持免提，继续按压",
                tags = listOf("120", "继续按压"),
                haptic = haptic,
                overlay = overlay,
                source = "rule_fast_path",
            )
            else -> null
        }
    }

    private fun handPositionFeedback(timestamp: String): GuidanceAction? {
        val spec = when (handPosition) {
            "left", "left_offset", "too_left" -> HandFeedback("位置偏左", "向右调整一点", "位置向右一点。", "right")
            "right", "right_offset", "too_right" -> HandFeedback("位置偏右", "向左调整一点", "位置向左一点。", "left")
            "too_high", "upper_offset" -> HandFeedback("位置偏高", "往下调整一点", "手再往下一点。", "down")
            "too_low", "lower_offset" -> HandFeedback("位置偏低", "往上调整一点", "手再往上一点。", "up")
            "off_center", "wrong_position" -> HandFeedback("回到胸口中央", "双手掌根按压", "双手掌根放回胸口中央。", null)
            else -> null
        } ?: return null
        val overlay = linkedMapOf<String, Any?>(
            "mode" to "hand_position_feedback",
            "highlight_target" to "chest_center",
        )
        spec.arrow?.let { overlay["correction_arrow"] = it }
        return action(
            timestamp = timestamp,
            stage = "S7_CPR_LOOP",
            intent = "correct_hand_position",
            priority = "high",
            tts = spec.tts,
            main = spec.main,
            secondary = spec.secondary,
            tags = listOf(spec.main, spec.secondary),
            quality = qualityScore,
            haptic = HapticPayload(enabled = true, pattern = "metronome", bpm = 110),
            overlay = overlay,
        )
    }

    private fun action(
        timestamp: String,
        stage: String,
        intent: String,
        priority: String,
        tts: String,
        main: String,
        secondary: String,
        tags: List<String>,
        quality: Int? = null,
        primaryButton: Map<String, Any?>? = null,
        haptic: HapticPayload = HapticPayload(enabled = false),
        overlay: Map<String, Any?>? = null,
        tools: List<ToolAction> = emptyList(),
        source: String = "local_rule_agent",
    ): GuidanceAction =
        GuidanceAction(
            action_id = "local_" + UUID.randomUUID().toString().substring(0, 8),
            session_id = sessionId,
            timestamp = timestamp,
            stage = stage,
            intent = intent,
            priority = priority,
            source = source,
            reason_codes = listOf("on_device_rule_flow"),
            ttl_ms = if (priority == "critical") 3000 else 5000,
            tts = TtsPayload(
                text = tts,
                tone = if (priority == "critical") "calm_firm" else "calm_firm",
                speed = "normal",
                interrupt_policy = if (priority == "critical") "interrupt_lower_priority" else "do_not_interrupt_critical",
            ),
            ui = UiPayload(
                main_text = main,
                secondary_text = secondary,
                status_tags = tags,
                quality_score = quality,
                primary_button = primaryButton,
            ),
            haptic = haptic,
            visual_overlay = overlay,
            tool_actions = tools,
            log_event = mapOf(
                "type" to intent,
                "detail" to "on_device_rule_flow",
            ),
        )

    private fun isFatigueHigh(): Boolean =
        fatigueLevel == "high" || fatigueLevel == "exhausted"

    private data class HandFeedback(
        val main: String,
        val secondary: String,
        val tts: String,
        val arrow: String?,
    )
}

private fun responseTypeFor(action: GuidanceAction): String =
    when {
        action.intent == "answer_current_cpr_question" || action.intent == "answer_position_question" ||
            action.intent == "explain_aed_support" -> "question_answer"
        action.intent.startsWith("correct_") -> "critical_correction"
        action.source == "local_rule_agent" && action.priority == "critical" -> "flow_instruction"
        else -> "flow_instruction"
    }

private fun inferSource(request: TurnRequest): String =
    when {
        request.cprQuality != null -> "vision_cpr"
        request.rescuerState != null -> "vision_rescuer"
        request.deviceState != null || request.toolResult != null -> "device"
        request.patientState != null -> "vision_patient"
        else -> "local_text"
    }

private fun inferType(request: TurnRequest, intent: String?): String =
    when {
        request.toolResult != null -> "tool_result"
        request.cprQuality != null -> "cpr_quality_update"
        request.rescuerState != null -> "rescuer_state_update"
        request.deviceState != null -> "device_state_update"
        request.patientState?.containsKey("normal_breathing") == true -> "breathing_update"
        request.patientState != null -> "patient_state_update"
        intent == "paramedics_arrived" -> "handover_requested"
        intent == "normal_breathing" || intent == "no_normal_breathing" -> "breathing_update"
        intent == "continue_cpr" || intent == "compressions_reported" -> "cpr_quality_update"
        intent == "emergency_called" -> "device_state_update"
        else -> "user_response"
    }

private fun inferButtonIntent(text: String): String? {
    val compact = text.trim().lowercase().replace(" ", "")
    if (compact.isBlank()) return null
    return when {
        compact.containsAny("\u73b0\u573a\u5b89\u5168", "\u5468\u56f4\u5b89\u5168", "\u786e\u8ba4\u5b89\u5168") -> "scene_safe"
        compact.containsAny(
            "\u6ca1\u53cd\u5e94",
            "\u6ca1\u6709\u53cd\u5e94",
            "\u6ca1\u56de\u5e94",
            "\u6ca1\u6709\u56de\u5e94",
            "\u53eb\u4e0d\u9192",
            "\u558a\u4e0d\u9192",
            "\u62cd\u4e0d\u9192",
            "\u65e0\u53cd\u5e94",
        ) -> "patient_unresponsive"
        compact.contains("\u6709\u53cd\u5e94") -> "patient_responsive"
        compact.containsAny(
            "\u6ca1\u6709\u6b63\u5e38\u547c\u5438",
            "\u65e0\u6b63\u5e38\u547c\u5438",
            "\u6ca1\u6709\u547c\u5438",
            "\u6ca1\u547c\u5438",
            "\u6ca1\u6c14",
            "\u6ca1\u6709\u6c14",
            "\u6ca1\u5598\u6c14",
            "\u80f8\u53e3\u6ca1\u6709\u8d77\u4f0f",
            "\u80f8\u53e3\u4e0d\u8d77\u4f0f",
            "\u770b\u4e0d\u5230\u8d77\u4f0f",
            "\u547c\u5438\u4e0d\u6b63\u5e38",
        ) -> "no_normal_breathing"
        compact.contains("\u6b63\u5e38\u547c\u5438") -> "normal_breathing"
        compact.containsAny("\u5df2\u62e8\u6253120", "\u5df2\u7ecf\u62e8\u6253120", "\u6253\u4e86120") -> "emergency_called"
        compact.containsAny(
            "\u5f00\u59cb\u6309\u538b",
            "\u7ee7\u7eed\u6309\u538b",
            "\u600e\u4e48\u6309\u538b",
            "\u5982\u4f55\u6309\u538b",
            "\u6309\u538b\u600e\u4e48\u505a",
        ) || compact == "\u5f00\u59cb" || compact == "\u7ee7\u7eed" -> "continue_cpr"
        compact.contains("现场安全") || compact.contains("scenesafe") -> "scene_safe"
        compact.contains("没有反应") || compact.contains("无反应") || compact.contains("noresponse") -> "patient_unresponsive"
        compact.contains("有反应") -> "patient_responsive"
        compact.contains("无正常呼吸") || compact.contains("没有正常呼吸") || compact.contains("nonormalbreathing") -> "no_normal_breathing"
        compact.contains("正常呼吸") -> "normal_breathing"
        compact.contains("已拨打120") || compact.contains("120started") || compact.contains("emergencycalldone") -> "emergency_called"
        compact.contains("开始按压") ||
            compact.contains("继续按压") ||
            compact.contains("怎么按压") ||
            compact.contains("如何按压") ||
            compact.contains("cprstarted") ||
            compact == "开始" ||
            compact == "继续" -> "continue_cpr"
        compact.contains("aed") && (compact.contains("来了") || compact.contains("arrived")) -> "aed_available"
        compact.contains("急救员") || compact.contains("emsarrived") -> "paramedics_arrived"
        else -> null
    }
}

private fun String.containsAny(vararg needles: String): Boolean =
    needles.any { contains(it) }

private fun isLocalCprReadinessUtterance(text: String): Boolean {
    val compact = text.trim().lowercase().replace(Regex("[\\s，。,.！？!、]+"), "")
    if (compact.isBlank()) return false
    return compact in setOf(
        "好",
        "好的",
        "好啊",
        "好了",
        "行",
        "行了",
        "可以",
        "可以了",
        "准备好了",
        "我准备好了",
        "已经准备好了",
        "我已经准备好了",
        "开始",
        "开始吧",
        "开始了",
        "现在开始",
        "这就开始",
        "马上开始",
        "可以开始",
        "开始按压",
        "开始胸外按压",
        "开始cpr",
        "开始心肺复苏",
        "继续",
        "继续吧",
        "继续按压",
        "继续胸外按压",
        "继续cpr",
        "继续心肺复苏",
    ) || compact.contains("准备好") ||
        compact.contains("开始胸外按压") ||
        compact.contains("继续胸外按压")
}

private fun isPositionQuestion(text: String): Boolean {
    val compact = text.trim().lowercase().replace(Regex("\\s+"), "")
    return compact.containsAny("位置", "胸口", "胸前", "中间", "中央", "这里", "这个位置")
}

private fun String.isCprReadinessBridgeStage(): Boolean =
    this == "S5_CALL_EMERGENCY" || this == "S6_CPR_READY"

private fun String.isCprQuestionStage(): Boolean =
    this == "S6_CPR_READY" || this == "S7_CPR_LOOP" || this == "S8_ASSISTANCE"

private fun String.isMetronomeStage(): Boolean =
    this == "S7_CPR_LOOP" || this == "S8_ASSISTANCE"

private fun isCprStartStage(stage: String): Boolean =
    stage == "S6_CPR_READY" ||
        stage == "S7_CPR_LOOP" ||
        stage == "S8_ASSISTANCE" ||
        stage.startsWith("MONITOR")

private fun isHandoverRequested(event: LocalTurnEvent): Boolean =
    event.type == "handover_requested" ||
        event.metadata.boolean("ems_arrived") == true ||
        event.intent == "paramedics_arrived" ||
        event.intent == "emergency_team_arrived"

private fun isSignsOfLife(event: LocalTurnEvent): Boolean =
    event.intent == "signs_of_life" ||
        event.intent == "patient_recovered" ||
        event.intent == "patient_responsive" ||
        event.intent == "responsive" ||
        event.intent == "normal_breathing" ||
        event.intent == "normal_breathing_present" ||
        event.metadata.boolean("signs_of_life") == true ||
        event.patientState.boolean("signs_of_life") == true

private fun isCprRestart(event: LocalTurnEvent): Boolean =
    event.intent == "continue_cpr" ||
        event.intent == "no_normal_breathing" ||
        event.intent == "breathing_absent" ||
        event.intent == "agonal_breathing" ||
        event.intent == "patient_unresponsive" ||
        event.intent == "unresponsive" ||
        event.intent == "compressions_reported" ||
        event.metadata.boolean("cpr_restart") == true ||
        event.cprQuality.isNotEmpty()

private fun emergencyCallTool(): ToolAction =
    ToolAction(
        type = "emergency_call",
        requires_user_confirmation = false,
        payload = mapOf(
            "target" to "120",
            "mode" to "demo_configured",
            "demo_safe" to true,
        ),
    )

private fun Map<String, Any?>.string(key: String): String? =
    (this[key] as? String)?.takeIf(String::isNotBlank)

private fun Map<String, Any?>.boolean(key: String): Boolean? =
    when (val value = this[key]) {
        is Boolean -> value
        is String -> when (value.lowercase()) {
            "true", "1", "yes" -> true
            "false", "0", "no" -> false
            else -> null
        }
        is Number -> value.toInt() != 0
        else -> null
    }

private fun Map<String, Any?>.number(key: String): Double? =
    when (val value = this[key]) {
        is Number -> value.toDouble()
        is String -> value.toDoubleOrNull()
        else -> null
    }

private fun normalizeQualityScore(value: Double): Int =
    if (value <= 1.0) {
        (value * 100).toInt().coerceIn(0, 100)
    } else {
        value.toInt().coerceIn(0, 100)
    }
