package com.example.cpr_new.feature.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.example.cpr_new.BuildConfig
import com.example.cpr_new.agent.copilot.CopilotActionMapper
import com.example.cpr_new.agent.copilot.CopilotEmergencyTools
import com.example.cpr_new.agent.copilot.CopilotHapticTools
import com.example.cpr_new.agent.copilot.CopilotSystemTools
import com.example.cpr_new.agent.copilot.LiveAgentCapable
import com.example.cpr_new.agent.copilot.LiveAgentEvent
import com.example.cpr_new.agent.copilot.RemoteGuidanceAgent
import com.example.cpr_new.agent.copilot.isExpectedAudioCancelReason
import com.example.cpr_new.agent.copilot.shouldUseLocalLiveTts
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.di.AgentBackend
import com.example.cpr_new.core.di.ServiceLocator
import com.example.cpr_new.core.contract.FrameSink
import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidancePriority
import com.example.cpr_new.core.contract.HandoverReport
import com.example.cpr_new.core.contract.LogEntryType
import com.example.cpr_new.core.contract.PerceptionEvent
import com.example.cpr_new.core.contract.SessionLog
import com.example.cpr_new.core.contract.SessionLogEntry
import com.example.cpr_new.core.di.CprDependencies
import com.example.cpr_new.hardware.audio.AudioMetronomeController
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 急救会话编排 ViewModel —— 第 4 部分的“总线”。
 *
 * 它把各模块串成一条数据流（对应分工表“流程集成”）：
 *
 *   感知源(第3部分) ──events──▶ [feedPerception] ──▶ Agent(第2部分)
 *                                     │                    │
 *                                     ▼                    ▼
 *                              更新质量分/UI        guidance 动作流
 *                                                          │
 *                          ┌───────────────────────────────┤
 *                          ▼            ▼           ▼       ▼
 *                        TTS播报     触觉反馈     节拍变速   阶段切换
 *
 * 同时负责：录音留证、定位采集、120 拨号、异常兜底、生成 Handover。
 * 它不做任何医学判断 —— 那是 Agent 的职责。
 */
class CprSessionViewModel(
    private val deps: CprDependencies,
) : ViewModel() {

    private val _state = MutableStateFlow(CprSessionState())
    val state: StateFlow<CprSessionState> = _state.asStateFlow()

    /**
     * 摄像头帧接收方：若感知源实现了 [FrameSink]（如第 3 部分真实模型需要 Android 取流），
     * 则 CameraX 会把帧推给它；Mock 不实现，返回 null，此时相机仅做预览。
     */
    val frameSink: FrameSink? = deps.perceptionSource as? FrameSink

    // 节拍器挂在 viewModelScope，随 ViewModel 销毁自动取消。
    private val metronome = Metronome(viewModelScope)

    // 感知事件中转流：本地订阅一份更新 UI，同时转交 Agent。
    private val perceptionRelay = MutableSharedFlow<PerceptionEvent>(extraBufferCapacity = 16)

    // 会话日志累积（内存态，结束时打包成不可变 SessionLog）。
    private val logEntries = mutableListOf<SessionLogEntry>()
    private var sessionId: String = ""
    private var startedAtMs: Long = 0L
    private val rateSamples = mutableListOf<Float>()

    private val useRemoteAgent: Boolean =
        ServiceLocator.agentBackend == AgentBackend.REMOTE_COPILOT

    private var lastAppliedActionId: String? = null
    private var lastAppliedAtMs: Long = 0L
    private var pendingTtsActionId: String? = null
    private var pendingTtsText: String = ""
    private var pendingTtsAudioSrc: String? = null
    private var liveCaptureStarted: Boolean = false
    private var micPermissionGranted: Boolean = false
    private var sessionRecordingDesired: Boolean = false
    private var ttsFallbackJob: Job? = null
    private var serverAudioActionId: String? = null

    init {
        observeMetronome()
        setupTtsDucking()
        setupSpeakingCallbacks()
    }

    // region 生命周期：开始 / 结束会话 ---------------------------------------

    /** 开始一次急救会话：拉起感知、Agent、节拍器、录音、定位。 */
    fun startSession(micGranted: Boolean = false) {
        if (_state.value.isActive) return
        sessionId = UUID.randomUUID().toString()
        startedAtMs = System.currentTimeMillis()
        logEntries.clear()
        rateSamples.clear()

        _state.value = CprSessionState(
            isActive = true,
            sessionId = sessionId,
            phase = CprPhase.ASSESS,
            perceptionReady = deps.perceptionSource.isReady,
            agentReady = deps.agent.isReady,
        )
        log(LogEntryType.LIFECYCLE, "会话开始")

        startPerception()
        startGuidance()
        startLiveChannel()
        micPermissionGranted = micGranted
        startLiveCapture(micGranted)
        if (!useRemoteAgent) startMetronome()
        sessionRecordingDesired = true
        reconcileRecording()
        captureLocation()
        if (deps.tts.isUnavailable) {
            log(LogEntryType.INCIDENT, "系统 TTS 不可用，请到设置安装语音引擎")
        }
        emitFirstGuidance()
    }

    /** 结束会话并生成交接报告。 */
    fun stopSession() {
        if (!_state.value.isActive) return
        log(LogEntryType.LIFECYCLE, "会话结束")

        deps.perceptionSource.stop()
        val liveAgent = deps.agent as? LiveAgentCapable
        viewModelScope.launch {
            runCatching { liveAgent?.resetSession(sessionId) }
        }
        liveAgent?.disconnectLive()
        metronome.stop()
        deps.audioMetronome.stop()
        deps.liveAudioCapture.release()
        deps.liveAudioPlayer.release()
        deps.turnTtsPlayer.stop()
        deps.tts.stop()
        deps.haptics.cancel()
        val recording = runCatching { deps.recorder.stop() }.getOrNull()
        if (recording != null) log(LogEntryType.USER_ACTION, "已保存录音：${recording.name}")

        liveCaptureStarted = false
        sessionRecordingDesired = false
        _state.value = _state.value.copy(
            isActive = false,
            metronomeRunning = false,
            micState = MicState.Idle,
            partialTranscript = "",
            lastUserTranscript = null,
            micLevel = 0f,
        )
        buildHandover()
    }

    /** 切换前后摄像头。 */
    fun toggleCamera() {
        _state.value = _state.value.copy(useFrontCamera = !_state.value.useFrontCamera)
        log(LogEntryType.USER_ACTION, if (_state.value.useFrontCamera) "切换前置摄像头" else "切换后置摄像头")
    }

    // endregion

    // region 数据流串联 -------------------------------------------------------

    private fun startPerception() {
        deps.perceptionSource.start(sessionId)
        viewModelScope.launch {
            runCatching {
                deps.perceptionSource.events.collect { event -> onPerception(event) }
            }.onFailure { raiseIncident("感知数据中断，请检查摄像头/光线") }
        }
    }

    /** 处理单条感知事件：更新质量分、记录样本、转交 Agent。 */
    private suspend fun onPerception(event: PerceptionEvent) {
        // 优先用第 3 部分给的 quality_score，缺失时兜底估算。
        val score = QualityScorer.resolve(event, _state.value.qualityScore)
        event.compressionRateBpm?.let { rateSamples.add(it) }

        _state.value = _state.value.copy(
            latestPerception = event,
            qualityScore = score,
            perceptionReady = true,
            // 识别置信度过低时给出兜底提示，但不打断流程。
            incidentBanner = if (!event.isReliable()) "识别置信度较低，请调整手机角度" else _state.value.incidentBanner,
        )
        // 低置信度的事件不污染 Agent 决策。
        if (event.isReliable()) perceptionRelay.emit(event)
    }

    private fun startGuidance() {
        viewModelScope.launch {
            runCatching {
                deps.agent.guidance(perceptionRelay).collect { action -> applyGuidance(action) }
            }.onFailure { raiseIncident("指导引擎异常，已切换到基础节拍模式") }
        }
    }

    private fun startLiveChannel() {
        val liveAgent = deps.agent as? LiveAgentCapable ?: return
        viewModelScope.launch {
            liveAgent.liveEvents.collect { event -> handleLiveEvent(event) }
        }
    }

    private fun startLiveCapture(micGranted: Boolean) {
        micPermissionGranted = micGranted
        if (!useRemoteAgent) return
        if (!micGranted) {
            setMicState(MicState.Off)
            log(LogEntryType.INCIDENT, "未授予麦克风，语音输入不可用（仍可用快捷回复）")
            return
        }
        if (liveCaptureStarted) return
        val liveAgent = deps.agent as? LiveAgentCapable ?: return
        if (!liveAgent.isLiveConnected) {
            setMicState(MicState.Off)
            reconcileRecording()
            return
        }
        if (deps.recorder.isRecording) {
            runCatching { deps.recorder.stop() }
        }
        liveCaptureStarted = true
        deps.liveAudioCapture.start(
            onPcmChunk = { liveAgent.sendPcm(it) },
            onBargeIn = { liveAgent.sendBargeIn() },
            onUtteranceEnd = {
                setMicState(MicState.Capturing)
                liveAgent.commitAudio()
            },
            onError = { message ->
                liveCaptureStarted = false
                setMicState(MicState.Off)
                raiseIncident("麦克风：$message")
            },
            onLevel = { level ->
                _state.value = _state.value.copy(micLevel = level)
            },
        )
        setMicState(MicState.Listening)
        reconcileRecording()
    }

    /** 权限授予或 WS 连上后补开 Live 麦克风。 */
    fun enableLiveCapture(micGranted: Boolean = micPermissionGranted) {
        if (micGranted) micPermissionGranted = true
        startLiveCapture(micGranted = micPermissionGranted)
    }

    /** 开启 Live 语音采集（底栏「听」）。 */
    fun startLiveAudio() {
        startLiveCapture(micGranted = micPermissionGranted)
    }

    /** 关闭 Live 语音采集（底栏「停」）。 */
    fun stopLiveAudio() {
        if (!liveCaptureStarted) return
        liveCaptureStarted = false
        deps.liveAudioCapture.stop()
        setMicState(MicState.Off)
        reconcileRecording()
    }

    /** 文字输入提交（绕过 STT，对齐 first-aid 底栏「输入」）。 */
    fun submitTextInput(text: String) {
        if (!_state.value.isActive || text.isBlank()) return
        viewModelScope.launch { submitAgentTurn(text.trim(), "Agent 未响应，请检查网络连接") }
    }

    private fun setMicState(micState: MicState) {
        _state.value = _state.value.copy(micState = micState)
    }

    private fun handleLiveEvent(event: LiveAgentEvent) {
        when (event) {
            is LiveAgentEvent.ConnectionChanged -> {
                _state.value = _state.value.copy(liveWsConnected = event.connected)
                if (event.connected) {
                    _state.value = _state.value.copy(agentConnected = true)
                    if (micPermissionGranted && !liveCaptureStarted) {
                        startLiveCapture(micGranted = true)
                    } else if (liveCaptureStarted && _state.value.micState != MicState.Speaking) {
                        setMicState(MicState.Listening)
                    }
                } else {
                    if (liveCaptureStarted) setMicState(MicState.Off)
                    if (event.message != null) {
                        log(LogEntryType.INCIDENT, "Live 通道：${event.message}")
                    }
                }
            }
            is LiveAgentEvent.Thinking -> Unit
            is LiveAgentEvent.Guidance -> {
                (deps.agent as? RemoteGuidanceAgent)?.updateStage(
                    event.currentStage ?: event.action.stage,
                )
                val local = CopilotActionMapper.toLocalAction(
                    copilot = event.action,
                    sessionId = sessionId,
                    ttsAudioSrc = event.ttsAudioSrc,
                    suppressLocalTts = event.suppressLocalTts,
                    responseType = event.responseType,
                )
                applyGuidance(
                    local,
                    preferServerTts = true,
                    suppressLocalTts = event.suppressLocalTts,
                    ttsAudioSrc = event.ttsAudioSrc,
                )
            }
            is LiveAgentEvent.State -> {
                (deps.agent as? RemoteGuidanceAgent)?.updateStage(event.currentStage)
                _state.value = _state.value.copy(agentStage = event.currentStage)
            }
            is LiveAgentEvent.PartialTranscript -> {
                if (event.text.isNotBlank()) setMicState(MicState.Capturing)
                _state.value = _state.value.copy(partialTranscript = event.text)
            }
            is LiveAgentEvent.FinalTranscript -> {
                _state.value = _state.value.copy(
                    partialTranscript = "",
                    lastUserTranscript = event.text.takeIf { it.isNotBlank() },
                )
                if (liveCaptureStarted) setMicState(MicState.Listening)
                log(LogEntryType.USER_ACTION, "识别：${event.text}")
                if (event.text.isNotBlank() && !_state.value.isAgentInFlight) {
                    viewModelScope.launch {
                        submitAgentTurn(
                            event.text.trim(),
                            "Agent 未响应语音输入，请检查 Node 服务是否在运行",
                        )
                    }
                }
            }
            is LiveAgentEvent.AudioBegin -> {
                ttsFallbackJob?.cancel()
                serverAudioActionId = event.actionId
                deps.tts.stop()
                deps.turnTtsPlayer.stop()
                setAgentSpeaking(true)
                deps.liveAudioPlayer.onAudioBegin(
                    sampleRate = event.sampleRate,
                    actionId = event.actionId,
                    flushQueue = event.flushQueue,
                )
            }
            is LiveAgentEvent.AudioChunk -> deps.liveAudioPlayer.onPcmChunk(event.bytes)
            is LiveAgentEvent.AudioEnd -> {
                deps.liveAudioPlayer.onAudioEnd(event.actionId)
                setAgentSpeaking(false)
            }
            is LiveAgentEvent.AudioCancel -> {
                deps.liveAudioPlayer.onAudioCancel()
                setAgentSpeaking(false)
                val reason = event.reason.orEmpty()
                if (reason.isNotBlank() && !reason.isExpectedAudioCancelReason()) {
                    log(LogEntryType.INCIDENT, "音频取消：$reason")
                }
            }
            is LiveAgentEvent.AudioUnavailable -> {
                deps.liveAudioPlayer.flushQueue()
                setAgentSpeaking(false)
                playPendingTtsFallback(event.actionId)
            }
            is LiveAgentEvent.Error -> raiseIncident(event.message)
        }
    }

    /** 应用一条 Agent 指导动作：播报 + 触觉 + 节拍变速 + 阶段切换 + 记录。 */
    private fun applyGuidance(
        action: GuidanceAction,
        preferServerTts: Boolean = false,
        suppressLocalTts: Boolean = false,
        ttsAudioSrc: String? = null,
    ) {
        if (shouldDedupeAction(action.actionId)) {
            _state.value = _state.value.copy(isAgentInFlight = false)
            return
        }

        if (action.metadata["offline"] == "true") {
            _state.value = _state.value.copy(
                agentConnected = false,
                isAgentInFlight = false,
                incidentBanner = formatAgentConnectionMessage(action.messageText),
            )
            return
        }

        val partialOffline = action.metadata["offline"] == "partial"
        if (partialOffline) {
            _state.value = _state.value.copy(
                agentConnected = false,
                isAgentInFlight = false,
                incidentBanner = formatAgentConnectionMessage(
                    action.metadata["offline_detail"] ?: "Agent 离线，继续本地按压",
                ),
            )
        }

        playGuidanceSpeech(
            action = action,
            preferServerTts = preferServerTts,
            suppressLocalTts = suppressLocalTts || action.metadata["suppress_local_tts"] == "true",
            ttsAudioSrc = ttsAudioSrc ?: action.metadata["tts_audio_src"],
        )
        if (!useRemoteAgent) {
            action.hapticPattern?.let { deps.haptics.play(it) }
        }
        applyCopilotTools(action)

        val qualityFromAgent = action.metadata["quality_score"]?.toIntOrNull()
        val statusTags = action.metadata["status_tags"]
            ?.split("|")
            ?.filter { it.isNotBlank() }
            .orEmpty()
        val pendingTool = action.metadata["pending_confirm_tools"]
            ?.split(",")
            ?.firstOrNull { it.isNotBlank() }
        _state.value = _state.value.copy(
            latestGuidance = action,
            phase = action.phase,
            agentReady = true,
            agentConnected = true,
            agentStage = action.metadata["copilot_stage"],
            primaryButtonLabel = action.metadata["primary_button_label"],
            primaryButtonAction = action.metadata["primary_button_action"],
            qualityScore = qualityFromAgent ?: _state.value.qualityScore,
            secondaryText = action.metadata["secondary_text"].orEmpty(),
            statusTags = statusTags,
            visualOverlayMode = action.metadata["visual_overlay_mode"],
            correctionArrow = action.metadata["correction_arrow"],
            isAgentInFlight = false,
            pendingConfirmTool = pendingTool,
            pendingConfirmMessage = pendingTool?.let {
                action.messageText.ifBlank { "需要你的确认才能继续" }
            },
        )
        log(
            LogEntryType.GUIDANCE,
            action.messageText.replace("\n", " "),
            mapOf(
                "code" to action.messageCode.name,
                "phase" to action.phase.name,
                "stage" to (action.metadata["copilot_stage"] ?: ""),
            ),
        )
    }

    /** 执行 Agent 下发的工具动作（拨号、节拍器等）。 */
    private fun applyCopilotTools(action: GuidanceAction) {
        val toolTypes = action.metadata["tool_types"]?.split(",")?.filter { it.isNotBlank() }.orEmpty()
        toolTypes.forEach { type ->
            when (type) {
                CopilotHapticTools.START, CopilotHapticTools.UPDATE -> {
                    val bpm = action.targetRate ?: AudioMetronomeController.DEFAULT_BPM
                    deps.audioMetronome.start(bpm)
                    syncUiMetronome(bpm)
                }
                CopilotHapticTools.STOP -> {
                    deps.audioMetronome.stop()
                    metronome.stop()
                }
                CopilotEmergencyTools.MOCK_CALL, CopilotEmergencyTools.REAL_CALL -> dialEmergency()
                CopilotSystemTools.ATTACH_GPS -> captureLocation()
                CopilotSystemTools.START_RECORDING -> {
                    sessionRecordingDesired = true
                    reconcileRecording()
                }
            }
        }
        if (toolTypes.isEmpty() && action.targetRate != null && action.phase == CprPhase.COMPRESSION) {
            deps.audioMetronome.start(action.targetRate)
            syncUiMetronome(action.targetRate)
        }
    }

    private fun syncUiMetronome(bpm: Int) {
        metronome.setBpm(bpm)
        if (!metronome.running.value) metronome.start()
    }

    private fun setupTtsDucking() {
        deps.tts.setProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = setAgentSpeaking(true)

                override fun onDone(utteranceId: String?) = setAgentSpeaking(false)

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = setAgentSpeaking(false)
            },
        )
    }

    private fun setupSpeakingCallbacks() {
        deps.turnTtsPlayer.onSpeakingChanged = { speaking -> setAgentSpeaking(speaking) }
        deps.turnTtsPlayer.onPlaybackFailed = {
            if (pendingTtsText.isNotBlank()) {
                deps.tts.speak(pendingTtsText, interrupt = false)
            }
        }
    }

    private fun setAgentSpeaking(speaking: Boolean) {
        deps.liveAudioCapture.setTtsSpeaking(speaking)
        deps.audioMetronome.setDucked(speaking)
        when {
            speaking -> setMicState(MicState.Speaking)
            liveCaptureStarted && _state.value.liveWsConnected -> setMicState(MicState.Listening)
            liveCaptureStarted -> setMicState(MicState.Off)
        }
    }

    private fun shouldDedupeAction(actionId: String): Boolean {
        val now = System.currentTimeMillis()
        if (actionId == lastAppliedActionId && now - lastAppliedAtMs < ACTION_DEDUPE_MS) {
            return true
        }
        lastAppliedActionId = actionId
        lastAppliedAtMs = now
        return false
    }

    private fun playPendingTtsFallback(actionId: String?) {
        if (actionId != null && pendingTtsActionId != null && actionId != pendingTtsActionId) return
        if (serverAudioActionId == actionId) return
        val audioSrc = pendingTtsAudioSrc
        when {
            !audioSrc.isNullOrBlank() -> deps.turnTtsPlayer.play(audioSrc)
            pendingTtsText.isNotBlank() -> deps.tts.speak(pendingTtsText, interrupt = false)
        }
    }

    private fun guidanceSpeechText(action: GuidanceAction): String =
        action.ttsText.takeIf { it.isNotBlank() } ?: action.messageText

    private fun playGuidanceSpeech(
        action: GuidanceAction,
        preferServerTts: Boolean,
        suppressLocalTts: Boolean,
        ttsAudioSrc: String?,
    ) {
        val speechText = guidanceSpeechText(action)
        pendingTtsActionId = action.actionId
        pendingTtsText = speechText
        pendingTtsAudioSrc = ttsAudioSrc
        ttsFallbackJob?.cancel()
        serverAudioActionId = null

        if (!ttsAudioSrc.isNullOrBlank()) {
            deps.turnTtsPlayer.play(ttsAudioSrc)
        }

        if (speechText.isBlank()) return

        when {
            suppressLocalTts && preferServerTts -> scheduleLocalTtsFallback(action.actionId, speechText)
            preferServerTts && action.shouldUseLocalLiveTts() -> speakLocalTts(speechText, action.priority)
            !preferServerTts && ttsAudioSrc.isNullOrBlank() -> speakLocalTts(speechText, action.priority)
            !preferServerTts && !ttsAudioSrc.isNullOrBlank() -> scheduleLocalTtsFallback(action.actionId, speechText)
            else -> speakLocalTts(speechText, action.priority)
        }
    }

    private fun scheduleLocalTtsFallback(actionId: String, speechText: String) {
        ttsFallbackJob = viewModelScope.launch {
            delay(SERVER_TTS_FALLBACK_MS)
            if (serverAudioActionId == actionId) return@launch
            speakLocalTts(speechText, GuidancePriority.MEDIUM)
        }
    }

    private fun speakLocalTts(text: String, priority: GuidancePriority) {
        if (text.isBlank()) return
        deps.tts.speak(text, interrupt = priority == GuidancePriority.CRITICAL)
    }

    /** 模拟语音输入（联调常用短语，走与主按钮相同的 Agent 回合）。 */
    fun onQuickReply(text: String) {
        if (!_state.value.isActive || text.isBlank()) return
        viewModelScope.launch { submitAgentTurn(text, "Agent 未响应：$text") }
    }

    /** 用户点击 Agent 主按钮（如「没有反应」「开始按压」）。 */
    fun onPrimaryButtonClick() {
        if (!_state.value.isActive) return
        if (_state.value.isAgentInFlight) {
            raiseIncident("正在处理上一步，请稍候…")
            return
        }
        val label = _state.value.primaryButtonLabel.orEmpty()
        val actionCode = _state.value.primaryButtonAction.orEmpty()
        if (label.isBlank() && actionCode.isBlank()) {
            raiseIncident("当前阶段请使用语音或文字输入")
            return
        }

        val userText = CopilotActionMapper.mapButtonTextToUserInput(label, actionCode)
        viewModelScope.launch {
            submitAgentTurn(userText, "Agent 未响应，请检查 Node 服务是否在运行")
        }
    }

    private suspend fun submitAgentTurn(userText: String, emptyResponseMessage: String) {
        Log.d("CprSession", "submitAgentTurn: text='$userText', sessionId=$sessionId, isActive=${_state.value.isActive}")
        _state.value = _state.value.copy(isAgentInFlight = true)
        val guidance = runCatching {
            deps.agent.submitUserTurn(sessionId, userText)
        }.getOrElse { error ->
            Log.e("CprSession", "submitUserTurn failed: ${error.message}", error)
            _state.value = _state.value.copy(isAgentInFlight = false)
            raiseIncident(formatAgentConnectionMessage(error.message ?: "Agent 请求失败"))
            return
        }
        Log.d("CprSession", "submitUserTurn returned: ${guidance?.messageText ?: "null"}, stage=${guidance?.metadata?.get("copilot_stage")}")
        if (guidance == null) {
            _state.value = _state.value.copy(isAgentInFlight = false)
            raiseIncident(formatAgentConnectionMessage(emptyResponseMessage))
            return
        }
        applyGuidance(guidance)
    }

    private fun formatAgentConnectionMessage(detail: String): String {
        if (!useRemoteAgent) return detail
        return buildString {
            append(detail)
            append("\n目标：")
            append(BuildConfig.COPILOT_BASE_URL)
            append("\n请确认：1) npm run voice:serve 已启动  2) adb devices 有设备  3) adb reverse tcp:8787 tcp:8787")
        }
    }

    private fun emitFirstGuidance() {
        viewModelScope.launch {
            runCatching { applyGuidance(deps.agent.onSessionStart(sessionId)) }
                .onFailure { raiseIncident("指导引擎加载较慢，请稍候…") }
        }
    }

    // endregion

    // region 节拍器 -----------------------------------------------------------

    private fun startMetronome() = metronome.start()

    private fun observeMetronome() {
        viewModelScope.launch {
            metronome.bpm.collect { bpm -> _state.value = _state.value.copy(metronomeBpm = bpm) }
        }
        viewModelScope.launch {
            metronome.running.collect { running ->
                _state.value = _state.value.copy(metronomeRunning = running)
            }
        }
        // Mock 模式：每一拍震动；远程模式由 AudioMetronome 发声，不再震动。
        if (!useRemoteAgent) {
            viewModelScope.launch {
                metronome.ticks.collect {
                    if (_state.value.isActive) {
                        deps.haptics.play(com.example.cpr_new.core.contract.HapticPattern.TICK)
                    }
                }
            }
        }
    }

    // endregion

    // region 硬件动作 / 流程集成 ----------------------------------------------

    /** 拨打 120（实际为打开拨号盘预填号码，安全）。 */
    fun dialEmergency() {
        viewModelScope.launch {
            val geo = runCatching { deps.location.requestSingleFix() }.getOrNull()
            val ok = deps.dialer.dial()
            log(LogEntryType.USER_ACTION, if (ok) "已唤起 120 拨号" else "唤起拨号失败")
            _state.value = _state.value.copy(
                latestGeo = geo ?: _state.value.latestGeo,
                showEmergency120Sheet = ok,
            )
            if (ok) {
                deps.deviceState.emergencyCallStarted = true
                publishDeviceStateUpdate()
            } else {
                raiseIncident("无法唤起拨号，请手动拨打 120")
            }
        }
    }

    fun dismissEmergency120Sheet() {
        _state.value = _state.value.copy(showEmergency120Sheet = false)
    }

    /** 用户确认/拒绝 Agent 待授权工具（如分享视频）。 */
    fun confirmPendingTool(confirmed: Boolean) {
        val tool = _state.value.pendingConfirmTool ?: return
        _state.value = _state.value.copy(
            pendingConfirmTool = null,
            pendingConfirmMessage = null,
            isAgentInFlight = true,
        )
        viewModelScope.launch {
            val guidance = runCatching {
                deps.agent.submitToolResult(sessionId, tool, confirmed)
            }.getOrNull()
            if (guidance != null) {
                applyGuidance(guidance)
            } else {
                _state.value = _state.value.copy(isAgentInFlight = false)
                raiseIncident(if (confirmed) "Agent 未响应工具确认" else "已取消操作")
            }
        }
    }

    /**
     * 协调留证录音与 Live 语音采集：二者不能同时占用麦克风。
     * Live 采集优先；关闭 Live 后若会话仍需留证则恢复录音。
     */
    private fun reconcileRecording() {
        if (!_state.value.isActive || !sessionRecordingDesired) return
        val liveActive = useRemoteAgent && liveCaptureStarted
        if (liveActive) {
            if (deps.recorder.isRecording) runCatching { deps.recorder.stop() }
            return
        }
        if (!deps.recorder.isRecording) startRecordingSafely()
    }

    private fun publishDeviceStateUpdate() {
        if (!useRemoteAgent) return
        viewModelScope.launch {
            runCatching { deps.agent.publishDeviceState(sessionId) }
                .getOrNull()
                ?.let { applyGuidance(it) }
        }
    }

    private fun startRecordingSafely() {
        val file = runCatching { deps.recorder.start() }.getOrNull()
        if (file == null) log(LogEntryType.INCIDENT, "未录音（无麦克风权限或设备不支持）")
    }

    private fun captureLocation() {
        viewModelScope.launch {
            val geo = runCatching { deps.location.requestSingleFix() }.getOrNull()
            if (geo != null) {
                _state.value = _state.value.copy(latestGeo = geo)
                log(
                    LogEntryType.USER_ACTION,
                    "已获取定位",
                    mapOf("lat" to geo.latitude.toString(), "lng" to geo.longitude.toString()),
                )
            } else {
                log(LogEntryType.INCIDENT, "定位不可用（无权限或无信号）")
            }
        }
    }

    // endregion

    // region 异常兜底 / 报告 --------------------------------------------------

    /** 抛出一条用户可见的兜底提示并记录。 */
    fun raiseIncident(message: String) {
        _state.value = _state.value.copy(incidentBanner = message)
        log(LogEntryType.INCIDENT, message)
    }

    /** 清除当前兜底提示横幅。 */
    fun dismissIncident() {
        _state.value = _state.value.copy(incidentBanner = null)
    }

    /** 关闭交接报告弹窗（回到待命态）。 */
    fun dismissReport() {
        _state.value = _state.value.copy(handoverReport = null)
    }

    private fun buildHandover() {
        viewModelScope.launch {
            val log = snapshotLog()
            val report: HandoverReport? = runCatching { deps.agent.buildHandover(log) }.getOrNull()
            if (report != null) {
                _state.value = _state.value.copy(handoverReport = report)
            } else {
                raiseIncident("交接报告生成失败，可凭录音/日志人工交接")
            }
        }
    }

    /** 把内存日志打包成不可变快照，附带聚合指标。 */
    private fun snapshotLog(): SessionLog {
        val avgRate = if (rateSamples.isEmpty()) 0f else rateSamples.average().toFloat()
        return SessionLog(
            sessionId = sessionId,
            startedAtMs = startedAtMs,
            endedAtMs = System.currentTimeMillis(),
            entries = logEntries.toList(),
            metrics = mapOf(
                "avgCompressionRate" to avgRate,
                "finalQualityScore" to _state.value.qualityScore.toFloat(),
            ),
        )
    }

    private fun log(type: LogEntryType, summary: String, payload: Map<String, String> = emptyMap()) {
        logEntries.add(
            SessionLogEntry(
                timestampMs = System.currentTimeMillis(),
                type = type,
                summary = summary,
                payload = payload,
            ),
        )
    }

    // endregion

    override fun onCleared() {
        super.onCleared()
        // 兜底释放硬件资源，防止泄漏。
        runCatching { deps.perceptionSource.stop() }
        (deps.agent as? LiveAgentCapable)?.disconnectLive()
        metronome.stop()
        deps.audioMetronome.release()
        deps.liveAudioCapture.release()
        deps.liveAudioPlayer.release()
        deps.turnTtsPlayer.release()
        deps.tts.release()
        deps.recorder.release()
        deps.haptics.cancel()
    }

    /**
     * ViewModel 工厂：把依赖注入进来。
     * UI 侧用 `viewModel(factory = CprSessionViewModel.factory(deps))` 获取实例。
     */
    companion object {
        private const val ACTION_DEDUPE_MS = 800L
        private const val SERVER_TTS_FALLBACK_MS = 1_200L

        fun factory(deps: CprDependencies): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    CprSessionViewModel(deps) as T
            }
    }
}
