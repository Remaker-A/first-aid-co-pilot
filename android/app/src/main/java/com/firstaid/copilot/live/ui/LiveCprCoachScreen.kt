package com.firstaid.copilot.live.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.firstaid.copilot.live.AttentionMode
import com.firstaid.copilot.live.ConnectionState
import com.firstaid.copilot.live.DemoTurn
import com.firstaid.copilot.live.LivePhoneticIntentRouter
import com.firstaid.copilot.live.LiveSessionViewModel
import com.firstaid.copilot.live.LiveUiState
import com.firstaid.copilot.live.MicState
import com.firstaid.copilot.live.ToolConfirmationState
import com.firstaid.copilot.live.resolvePrimaryButtonIntent
import com.firstaid.copilot.live.audio.LiveAudioCapture
import com.firstaid.copilot.live.audio.MetronomeController
import com.firstaid.copilot.live.demoCprSetupSequence
import com.firstaid.copilot.live.demoPresetById
import com.firstaid.copilot.live.demoPresets
import com.firstaid.copilot.live.edge.EdgeGemmaAgent
import com.firstaid.copilot.live.edge.EdgeGemmaFeatureFlags
import com.firstaid.copilot.live.edge.EdgeModelKind
import com.firstaid.copilot.live.edge.EdgeModelReport
import com.firstaid.copilot.live.edge.EdgeTextToSpeechEdge
import com.firstaid.copilot.live.edge.GemmaBackendPreference
import com.firstaid.copilot.live.edge.OnDeviceGemmaDriver
import com.firstaid.copilot.live.edge.StreamingAsrEvent
import com.firstaid.copilot.live.edge.StreamingAsrSession
import com.firstaid.copilot.live.edge.buildSherpaSpeechEngine
import com.firstaid.copilot.live.edge.buildSherpaStreamingAsrSession
import com.firstaid.copilot.live.edge.inspectEdgeModels
import com.firstaid.copilot.live.normalizeOverlayMode
import com.firstaid.copilot.live.toAttentionMode
import com.firstaid.copilot.live.perception.PerceptionSignal
import com.firstaid.copilot.live.ui.components.AedGuidanceCard
import com.firstaid.copilot.live.ui.components.CountdownRing
import com.firstaid.copilot.live.ui.components.ErrorBanner
import com.firstaid.copilot.live.ui.components.PrimaryActionButton
import com.firstaid.copilot.live.ui.components.ResponseStrip
import com.firstaid.copilot.live.ui.components.SourceBadgeChip
import com.firstaid.copilot.live.ui.components.StageProgressRail
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidType
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun LiveCprCoachScreen(
    viewModel: LiveSessionViewModel = viewModel(),
    onOpenFixtureDebug: () -> Unit = {},
) {
    val context = LocalContext.current
    val skipGemmaWarmup = remember {
        (context as? Activity)?.intent?.getBooleanExtra("skipGemmaWarmup", false) == true
    }
    // Phase-0 端侧 Gemma 增强层 flags. Default OFF (DISABLED) so behavior is
    // unchanged; an Activity intent extra can opt individual functions in for
    // testing without changing the production default.
    val edgeGemmaFlags = remember {
        val intent = (context as? Activity)?.intent
        if (intent == null) {
            EdgeGemmaFeatureFlags.DISABLED
        } else {
            EdgeGemmaFeatureFlags(
                enabled = intent.getBooleanExtra("edgeGemmaEnabled", false),
                nluEnabled = intent.getBooleanExtra("edgeGemmaNlu", false),
                openQuestionEnabled = intent.getBooleanExtra("edgeGemmaOpenQuestion", false),
                proactiveEnabled = intent.getBooleanExtra("edgeGemmaProactive", false),
            )
        }
    }
    val coroutineScope = rememberCoroutineScope()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val attentionMode = state.attentionModeInputs.toAttentionMode()

    var useCameraSource by remember { mutableStateOf(false) }
    var showDemoDrawer by remember { mutableStateOf(false) }
    var showHandover by remember { mutableStateOf(false) }
    var hasCameraPermission by remember {
        mutableStateOf(context.hasPermission(Manifest.permission.CAMERA))
    }
    var hasAudioPermission by remember {
        mutableStateOf(context.hasPermission(Manifest.permission.RECORD_AUDIO))
    }
    var startAudioAfterPermission by remember { mutableStateOf(false) }
    var rmsLevel by remember { mutableFloatStateOf(0f) }
    var liveAudioEnabled by remember { mutableStateOf(false) }
    var localTtsSpeaking by remember { mutableStateOf(false) }
    var edgeReport by remember { mutableStateOf<EdgeModelReport?>(null) }
    var edgeSummary by remember { mutableStateOf("Edge models: checking") }
    var gemmaDriver by remember { mutableStateOf<OnDeviceGemmaDriver?>(null) }
    var gemmaAgent by remember { mutableStateOf<EdgeGemmaAgent?>(null) }
    var streamingAsrSession by remember { mutableStateOf<StreamingAsrSession?>(null) }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasCameraPermission = granted }

    val metronome = remember { MetronomeController(context) }
    val audioCapture = remember { LiveAudioCapture() }
    val asrSpeechEngine = remember { buildSherpaSpeechEngine(context, numThreads = 2) }
    val ttsSpeechEngine = remember { buildSherpaSpeechEngine(context, numThreads = 6) }
    val ttsEdge = remember {
        EdgeTextToSpeechEdge(context, ttsSpeechEngine) { speaking ->
            mainHandler.post {
                localTtsSpeaking = speaking
            }
        }
    }
    fun handleStreamingAsrEvents(events: List<StreamingAsrEvent>) {
        events.forEach { event ->
            when (event) {
                is StreamingAsrEvent.Partial -> mainHandler.post {
                    if (viewModel.uiState.value.isAssistantPlaybackActiveForAsr()) {
                        Log.i(TAG, "ASR partial ignored during assistant playback")
                        return@post
                    }
                    Log.i(TAG, "ASR partial='${event.text.take(80)}'")
                    viewModel.acceptLocalAsrPartial(event.text)
                }
                is StreamingAsrEvent.Final -> mainHandler.post {
                    if (viewModel.uiState.value.isAssistantPlaybackActiveForAsr()) {
                        Log.i(TAG, "ASR final ignored during assistant playback")
                        return@post
                    }
                    Log.i(
                        TAG,
                        "ASR final='${event.text.take(80)}' intent=${event.intent.orEmpty()} confidence=${event.confidence}",
                    )
                    if (event.text.isNotBlank()) {
                        viewModel.submitLiveText(text = event.text, intent = event.intent, fromAsr = true)
                    }
                }
                StreamingAsrEvent.Endpoint -> mainHandler.post {
                    if (viewModel.uiState.value.isAssistantPlaybackActiveForAsr()) {
                        Log.i(TAG, "ASR endpoint ignored during assistant playback")
                        return@post
                    }
                    Log.i(TAG, "ASR endpoint")
                    if (liveAudioEnabled) {
                        viewModel.setMicState(MicState.Listening)
                    }
                }
                is StreamingAsrEvent.Error -> mainHandler.post {
                    Log.w(TAG, "ASR error ${event.message}", event.cause)
                    viewModel.reportLocalAsrError(event.message)
                }
            }
        }
    }

    fun startAudioCapture() {
        val localStreamingAsr = if (edgeReport?.asrReady == true) {
            streamingAsrSession?.takeIf { it.available }
        } else {
            null
        }
        val useWholeUtteranceAsr = edgeReport?.asrReady == true && localStreamingAsr == null
        liveAudioEnabled = true
        viewModel.startLiveAudio()
        if (localStreamingAsr != null) {
            handleStreamingAsrEvents(localStreamingAsr.start())
        }
        audioCapture.start(
            onLevel = { level ->
                mainHandler.post {
                    rmsLevel = level.coerceIn(0f, 0.25f) / 0.25f
                }
            },
            onPcmChunk = { pcm16 ->
                if (localStreamingAsr == null && !useWholeUtteranceAsr) {
                    viewModel.sendLivePcm(pcm16)
                }
            },
            onListeningPcmChunk = { pcm16 ->
                if (localStreamingAsr != null) {
                    handleStreamingAsrEvents(localStreamingAsr.feedPcm(pcm16))
                }
            },
            onUtterancePcm = { pcm16 ->
                Log.i(TAG, "Utterance callback bytes=${pcm16.size} streaming=${localStreamingAsr != null} whole=$useWholeUtteranceAsr")
                when {
                    localStreamingAsr != null -> {
                        val events = localStreamingAsr.end()
                        handleStreamingAsrEvents(events)
                        val hasFinalText = events.any {
                            it is StreamingAsrEvent.Final && it.text.isNotBlank()
                        }
                        if (!hasFinalText) {
                            coroutineScope.launch {
                                Log.i(TAG, "Streaming ASR produced no final text; running whole-utterance fallback")
                                viewModel.setMicState(MicState.Uploading)
                                val result = asrSpeechEngine.transcribePcm16(pcm16)
                                Log.i(
                                    TAG,
                                    "Whole-utterance ASR fallback ok=${result.ok} text='${result.text.take(80)}' latency=${result.latencyMs}ms",
                                )
                                if (result.ok && result.text.isNotBlank()) {
                                    viewModel.submitLiveText(text = result.text, fromAsr = true)
                                } else {
                                    viewModel.setMicState(MicState.Listening)
                                }
                            }
                        }
                    }
                    useWholeUtteranceAsr -> {
                        coroutineScope.launch {
                            viewModel.setMicState(MicState.Uploading)
                            val result = asrSpeechEngine.transcribePcm16(pcm16)
                            if (result.ok && result.text.isNotBlank()) {
                                viewModel.submitLiveText(text = result.text, fromAsr = true)
                            } else {
                                viewModel.setMicState(MicState.Listening)
                            }
                        }
                    }
                }
            },
            onBargeIn = {
                mainHandler.post {
                    ttsEdge.stop()
                    viewModel.sendLiveBargeIn()
                }
            },
            onError = { message ->
                mainHandler.post {
                    liveAudioEnabled = false
                    viewModel.setMicState(MicState.Off)
                    viewModel.submitTurn(text = "录音失败：$message")
                }
            },
        )
    }
    val audioPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasAudioPermission = granted
        if (granted && startAudioAfterPermission) {
            startAudioCapture()
        }
        startAudioAfterPermission = false
    }

    LaunchedEffect(Unit) {
        viewModel.connect()
        // Load the shared phonetic safety-net word table so a misheard CPR-live
        // question still carries the right intent hint (parity with the server).
        LivePhoneticIntentRouter.warm(context.applicationContext)
        val report = inspectEdgeModels(context, asrSpeechEngine.runtimeAvailable())
        edgeReport = report
        edgeSummary = report.summaryLine()
        launch {
            var asrWarmSummary = ""
            var ttsWarmSummary = ""
            var gemmaWarmSummary = ""
            fun publishWarmSummary() {
                edgeSummary = listOf(report.summaryLine(), asrWarmSummary, ttsWarmSummary, gemmaWarmSummary)
                    .filter(String::isNotBlank)
                    .joinToString(" ")
            }

            if (report.asrReady) {
                val asrWarmup = asrSpeechEngine.prewarmAsr()
                asrWarmSummary = if (asrWarmup.ok) {
                    "ASRWarm=${asrWarmup.latencyMs}ms"
                } else {
                    "ASRWarm=error"
                }
                publishWarmSummary()
                val session = withContext(Dispatchers.Default) {
                    buildSherpaStreamingAsrSession(context.applicationContext, numThreads = 2)
                }
                streamingAsrSession = session
                asrWarmSummary += if (session.available) {
                    " ASRStream=ready"
                } else {
                    " ASRStream=error"
                }
                publishWarmSummary()
            }

            if (report.ttsReady) {
                val ttsWarmup = ttsEdge.prewarmPhrase(
                    text = "继续按压",
                )
                ttsWarmSummary = if (ttsWarmup.ok) {
                    "TTSWarm=${ttsWarmup.latencyMs}ms"
                } else {
                    "TTSWarm=error"
                }
                publishWarmSummary()
            }

            val gemmaPath = report.status(EdgeModelKind.Gemma).path
            if (gemmaPath != null && !skipGemmaWarmup) {
                val driver = OnDeviceGemmaDriver(
                    context.applicationContext,
                    File(gemmaPath),
                    backendPreference = GemmaBackendPreference.CpuOnly,
                )
                gemmaDriver = driver
                val warmup = driver.prewarm()
                gemmaWarmSummary = if (warmup.ok) {
                    // Wrap the (now warm) exclusive driver in the unified edge agent
                    // and hand it to the ViewModel, which wires each capability seam
                    // from the agent's flags. The agent is inert unless its flags are
                    // on, so this is a no-op for the default (all-off) build.
                    val agent = EdgeGemmaAgent(driver, edgeGemmaFlags)
                    gemmaAgent = agent
                    viewModel.attachEdgeGemmaAgent(agent)
                    "GemmaWarm=${warmup.latencyMs}ms"
                } else {
                    "GemmaWarm=error"
                }
                publishWarmSummary()
            } else if (skipGemmaWarmup) {
                gemmaWarmSummary = "GemmaWarm=skipped"
                publishWarmSummary()
            }
        }
    }

    LaunchedEffect(state.haptic) {
        metronome.apply(state.haptic)
    }

    LaunchedEffect(state.currentStage) {
        if (state.currentStage?.startsWith("S9") == true) {
            showHandover = true
        }
    }

    LaunchedEffect(localTtsSpeaking, state.isLiveAudioPlaying, liveAudioEnabled) {
        val assistantPlaybackActive = localTtsSpeaking || state.isLiveAudioPlaying
        if (assistantPlaybackActive) {
            viewModel.setMicState(MicState.Speaking)
            streamingAsrSession?.reset()
            audioCapture.setTtsSpeaking(true)
            metronome.setDucked(true)
        } else {
            delay(180)
            viewModel.setMicState(if (liveAudioEnabled) MicState.Listening else MicState.Idle)
            streamingAsrSession?.reset()
            audioCapture.setTtsSpeaking(false)
            metronome.setDucked(false)
        }
    }

    LaunchedEffect(state.lastActionId, state.ttsText, state.suppressLocalTts) {
        if (state.suppressLocalTts) {
            ttsEdge.stop()
        } else {
            ttsEdge.speak(
                text = state.ttsText,
                utteranceKey = state.lastActionId,
                priority = state.ttsPriority,
                interruptPolicy = state.ttsInterruptPolicy,
                tone = state.ttsTone,
                speed = state.ttsSpeed,
            )
        }
    }

    // Phase D: proactive nudges ride a *dedicated* low-priority TTS, keyed on the
    // cue id so they never reuse the server guidance/audio path. They only speak
    // when nothing else is talking; "do_not_interrupt_critical" guarantees a
    // critical line is never cut off even if one starts in the same frame.
    LaunchedEffect(state.proactiveCue?.id) {
        val cue = state.proactiveCue ?: return@LaunchedEffect
        if (state.suppressLocalTts || state.isLiveAudioPlaying || state.micState == MicState.Speaking) {
            return@LaunchedEffect
        }
        ttsEdge.speak(
            text = cue.text,
            utteranceKey = cue.id,
            priority = "low",
            interruptPolicy = "do_not_interrupt_critical",
            tone = cue.tone,
            speed = cue.speed,
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            metronome.release()
            audioCapture.release()
            ttsEdge.shutdown()
            asrSpeechEngine.close()
            streamingAsrSession?.close()
            ttsSpeechEngine.close()
            // Detach (clears every seam wired from it) and stop the agent's worker
            // before closing the shared driver, so no in-flight generation outlives it.
            viewModel.detachEdgeGemmaAgent()
            gemmaAgent?.close()
            gemmaDriver?.close()
        }
    }

    fun setCameraSource(enabled: Boolean) {
        if (enabled && !hasCameraPermission) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
        useCameraSource = enabled
    }

    val voice = voiceControlPresentation(state.micState, state.currentStage)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(FirstAidColors.Background),
    ) {
        // Pulsing ambience only during the compression / assist phases.
        if (voice.flowStarted && attentionMode != AttentionMode.Coach) {
            CprCoachOverlay(
                mode = state.visualOverlayMode,
                correctionArrow = state.correctionArrow,
                attentionMode = attentionMode,
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (!voice.flowStarted) {
            EntryScreen(
                connectionLabel = state.connectionState.label,
                onStartFirstAid = {
                    viewModel.startFirstAid()
                    if (!hasAudioPermission) {
                        startAudioAfterPermission = true
                        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    } else {
                        startAudioCapture()
                    }
                },
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            when (attentionMode) {
                AttentionMode.Coach -> CoachLayout(state)
                AttentionMode.EyesOff -> EyesOffLayout(state)
                AttentionMode.Glanceable -> GlanceableLayout(state)
            }
        }

        TopStatusBar(
            state = state,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(FirstAidDimens.ItemGap),
        )

        if (useCameraSource) {
            CameraPiPWindow(
                visible = true,
                hasCameraPermission = hasCameraPermission,
                onRequestPermission = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) },
                onClose = { setCameraSource(false) },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 112.dp, end = FirstAidDimens.ItemGap),
                enableVisionAnalysis = state.currentStage?.let { it.startsWith("S6") || it.startsWith("S7") } == true,
                onVisionMetrics = viewModel::submitVisionMetrics,
                onVisionUnavailable = viewModel::reportVisionUnavailable,
            )
        }

        if (voice.flowStarted) {
            LiveVoiceControls(
                state = state,
                rmsLevel = rmsLevel,
                hasAudioPermission = hasAudioPermission,
                useCameraSource = useCameraSource,
                onToggleCamera = { setCameraSource(!useCameraSource) },
                onOpenMore = { showDemoDrawer = true },
                onPrimaryButton = {
                    state.primaryButton?.let { button ->
                        ttsEdge.stop()
                        viewModel.submitLiveText(
                            text = button.label,
                            intent = resolvePrimaryButtonIntent(button.intent),
                        )
                    }
                },
                onRequestAudioPermission = {
                    startAudioAfterPermission = true
                    audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                },
                onStartFirstAid = { viewModel.startFirstAid() },
                onSubmitText = {
                    ttsEdge.stop()
                    viewModel.submitLiveText(text = it)
                },
                onStartAudio = { startAudioCapture() },
                onStopAudio = {
                    liveAudioEnabled = false
                    audioCapture.stop()
                    viewModel.stopLiveAudio()
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(FirstAidDimens.ItemGap),
            )
        }

        if (showDemoDrawer) {
            DemoInjectionDrawer(
                state = state,
                onClose = { showDemoDrawer = false },
                onRunPreset = { preset -> viewModel.injectDemoPreset(preset) },
                onRunSetup = { viewModel.runDemoTurns(demoCprSetupSequence()) },
                onOpenFixtureDebug = onOpenFixtureDebug,
                onReset = {
                    ttsEdge.stop()
                    viewModel.reset()
                    showHandover = false
                },
                useCameraSource = useCameraSource,
                onCameraToggle = ::setCameraSource,
                edgeSummary = edgeSummary,
                onQuickQuestion = { presetId, text ->
                    val turn = DemoTurn(demoPresetById(presetId), text)
                    val turns = if (state.currentStage?.startsWith("S7") == true) {
                        listOf(turn)
                    } else {
                        demoCprSetupSequence() + turn
                    }
                    viewModel.runDemoTurns(turns)
                },
                modifier = Modifier.align(Alignment.CenterEnd),
            )
        }

        if (state.emergencyCall.requested) {
            EmergencyCallSimulationDialog(
                onDismiss = viewModel::dismissEmergencyCallDialog,
                mock = state.emergencyCall.mock,
            )
        }

        state.pendingConfirmation?.let { confirmation ->
            ToolConfirmationDialog(
                confirmation = confirmation,
                onConfirm = viewModel::confirmPendingTool,
                onDismiss = viewModel::dismissConfirmation,
            )
        }

        if (showHandover) {
            HandoverReportScreen(
                model = state.toHandoverModel(),
                onShare = { viewModel.confirmPendingTool() },
                onSave = { showHandover = false },
                onClose = { showHandover = false },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun TopStatusBar(
    state: LiveUiState,
    modifier: Modifier = Modifier,
) {
    val flowStarted = voiceControlPresentation(state.micState, state.currentStage).flowStarted
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        ) {
            StatusChip(state.connectionState.label, state.connectionState.color)
            SourceBadgeChip(badge = state.sourceBadge)
            Spacer(modifier = Modifier.weight(1f))
            Text(
                text = stageStatusLabel(state.currentStage),
                color = FirstAidColors.TextSecondary,
                style = FirstAidType.Label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
            )
        }
        if (flowStarted) {
            StageProgressRail(currentStage = state.currentStage)
        }
        ErrorBanner(message = state.lastErrorMessage)
    }
}

@Composable
private fun CoachLayout(state: LiveUiState) {
    val isBreathingCheck = state.currentStage?.startsWith("S3") == true
    var breathingSecondsLeft by remember(state.currentStage) { mutableStateOf(10) }

    LaunchedEffect(isBreathingCheck, state.currentStage) {
        if (isBreathingCheck) {
            breathingSecondsLeft = 10
            while (breathingSecondsLeft > 0) {
                delay(1_000)
                breathingSecondsLeft -= 1
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FirstAidDimens.ScreenPadding, vertical = 132.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = primaryGuidanceText(state.mainText, state.currentStage),
            color = FirstAidColors.TextPrimary,
            style = FirstAidType.Headline,
            maxLines = 5,
            overflow = TextOverflow.Ellipsis,
        )
        if (isBreathingCheck) {
            CountdownRing(
                secondsTotal = 10,
                secondsLeft = breathingSecondsLeft,
                label = "观察呼吸 10 秒",
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        }
        ResponseStrip(
            text = compactSecondaryText(state.secondaryText, state.statusTags) ?: state.lastAssistantText,
            speaking = state.micState == MicState.Speaking || state.isLiveAudioPlaying,
        )
    }
}

@Composable
private fun EyesOffLayout(state: LiveUiState) {
    val handPosition = state.cprHandPosition()
    val rate = state.cprRate()
    val armStraight = state.cprArmStraight()
    val hasLocalVisionCorrection = handPosition != null || rate != null || armStraight != null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FirstAidDimens.ScreenPadding, vertical = 132.dp),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = primaryGuidanceText(state.mainText, state.currentStage),
            color = FirstAidColors.TextPrimary,
            style = FirstAidType.DisplayHero,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        BeatPulse(bpm = state.haptic.bpm)
        if (hasLocalVisionCorrection) {
            CprCorrectionHint(
                handPosition = handPosition,
                rate = rate,
                armStraight = armStraight,
            )
        }
    }
}

@Composable
private fun GlanceableLayout(state: LiveUiState) {
    val isAedAssistance = state.currentStage?.startsWith("S8") == true ||
        state.visualOverlayMode == "aed_assistance"

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FirstAidDimens.ScreenPadding, vertical = 132.dp),
        verticalArrangement = Arrangement.Bottom,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = primaryGuidanceText(state.mainText, state.currentStage),
            color = FirstAidColors.TextPrimary,
            style = FirstAidType.Headline,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(modifier = Modifier.height(FirstAidDimens.SectionGap))
        if (isAedAssistance) {
            AedGuidanceCard(
                currentStep = 1,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(FirstAidDimens.ItemGap))
        }
        ResponseStrip(
            text = state.secondaryText.ifBlank { state.lastAssistantText ?: "" },
            speaking = state.micState == MicState.Speaking || state.isLiveAudioPlaying,
        )
    }
}

@Composable
fun CprCoachOverlay(
    mode: String?,
    correctionArrow: String?,
    attentionMode: AttentionMode,
    modifier: Modifier = Modifier,
) {
    val normalizedMode = normalizeOverlayMode(mode)
    val transition = rememberInfiniteTransition(label = "cpr_pulse")
    val pulse by transition.animateFloat(
        initialValue = 0.78f,
        targetValue = 1.22f,
        animationSpec = infiniteRepeatable(tween(545), RepeatMode.Reverse),
        label = "pulse",
    )
    val modeColor = when (normalizedMode) {
        "hand_position_feedback" -> Color(0xFFFBBF24)
        "rate_feedback" -> Color(0xFF38BDF8)
        "arm_posture_feedback" -> Color(0xFFF97316)
        "aed_assistance" -> Color(0xFF22C55E)
        "rescuer_assistance" -> Color(0xFFA78BFA)
        else -> Color(0xFF34D399)
    }

    Canvas(modifier = modifier) {
        val center = Offset(size.width / 2f, size.height * 0.43f)
        val baseRadius = size.minDimension * 0.12f
        drawCircle(modeColor.copy(alpha = 0.18f), radius = baseRadius * pulse, center = center)
        drawCircle(modeColor.copy(alpha = 0.28f), radius = baseRadius * 0.72f, center = center, style = Stroke(width = 8f))
        drawCircle(modeColor.copy(alpha = 0.9f), radius = baseRadius * 0.18f, center = center)

        if (normalizedMode == "rate_feedback" || normalizedMode == "continue_compressions" || normalizedMode == "cpr_loop") {
            drawArc(
                color = modeColor.copy(alpha = 0.9f),
                startAngle = -90f,
                sweepAngle = 270f * pulse.coerceAtMost(1f),
                useCenter = false,
                topLeft = Offset(center.x - baseRadius * 1.25f, center.y - baseRadius * 1.25f),
                size = androidx.compose.ui.geometry.Size(baseRadius * 2.5f, baseRadius * 2.5f),
                style = Stroke(width = 10f, cap = StrokeCap.Round),
            )
        }

        val arrow = correctionArrow ?: when (normalizedMode) {
            "arm_posture_feedback" -> "down"
            else -> null
        }
        if (arrow != null) {
            drawCorrectionArrow(center, arrow, modeColor)
        }

        if (attentionMode == AttentionMode.Glanceable) {
            val bannerTop = size.height * 0.18f
            drawRoundRect(
                color = modeColor.copy(alpha = 0.16f),
                topLeft = Offset(size.width * 0.12f, bannerTop),
                size = androidx.compose.ui.geometry.Size(size.width * 0.76f, size.height * 0.11f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(32f, 32f),
            )
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawCorrectionArrow(
    center: Offset,
    direction: String,
    color: Color,
) {
    val length = size.minDimension * 0.18f
    val start = when (direction) {
        "left" -> Offset(center.x + length, center.y)
        "right" -> Offset(center.x - length, center.y)
        "up" -> Offset(center.x, center.y + length)
        "down" -> Offset(center.x, center.y - length)
        else -> Offset(center.x, center.y + length)
    }
    val end = center
    drawLine(color, start, end, strokeWidth = 12f, cap = StrokeCap.Round)
    val head = Path().apply {
        when (direction) {
            "left" -> {
                moveTo(end.x - 28f, end.y)
                lineTo(end.x + 18f, end.y - 24f)
                lineTo(end.x + 18f, end.y + 24f)
            }
            "right" -> {
                moveTo(end.x + 28f, end.y)
                lineTo(end.x - 18f, end.y - 24f)
                lineTo(end.x - 18f, end.y + 24f)
            }
            "up" -> {
                moveTo(end.x, end.y - 28f)
                lineTo(end.x - 24f, end.y + 18f)
                lineTo(end.x + 24f, end.y + 18f)
            }
            else -> {
                moveTo(end.x, end.y + 28f)
                lineTo(end.x - 24f, end.y - 18f)
                lineTo(end.x + 24f, end.y - 18f)
            }
        }
        close()
    }
    drawPath(head, color)
}

@Composable
private fun LiveVoiceControls(
    state: LiveUiState,
    rmsLevel: Float,
    hasAudioPermission: Boolean,
    useCameraSource: Boolean,
    onToggleCamera: () -> Unit,
    onOpenMore: () -> Unit,
    onPrimaryButton: () -> Unit,
    onRequestAudioPermission: () -> Unit,
    onStartFirstAid: () -> Unit,
    onSubmitText: (String) -> Unit,
    onStartAudio: () -> Unit,
    onStopAudio: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var text by remember { mutableStateOf("") }
    var inputExpanded by remember { mutableStateOf(false) }
    val voice = voiceControlPresentation(state.micState, state.currentStage)
    val primaryColor = when {
        !voice.flowStarted -> FirstAidColors.Progress
        voice.active -> FirstAidColors.Critical
        else -> FirstAidColors.Info
    }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
    ) {
        state.primaryButton?.let { button ->
            PrimaryActionButton(label = button.label, onClick = onPrimaryButton)
        }
        Surface(
            color = FirstAidColors.Scrim,
            shape = RoundedCornerShape(FirstAidDimens.CardRadius),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier.padding(FirstAidDimens.ItemGap),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
            ) {
                if (inputExpanded) {
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        placeholder = { Text("输入") },
                        modifier = Modifier
                            .weight(1f)
                            .height(FirstAidDimens.PrimaryControlHeight),
                        singleLine = true,
                    )
                    Button(
                        enabled = text.isNotBlank() && !state.isInFlight,
                        onClick = {
                            onSubmitText(text)
                            text = ""
                            inputExpanded = false
                        },
                        modifier = Modifier.height(FirstAidDimens.PrimaryControlHeight),
                    ) {
                        Text("发送")
                    }
                    OutlinedButton(
                        onClick = { inputExpanded = false },
                        modifier = Modifier.height(FirstAidDimens.PrimaryControlHeight),
                    ) {
                        Text("收起")
                    }
                } else {
                    Button(
                        enabled = !state.isInFlight || voice.active,
                        onClick = {
                            if (!voice.flowStarted) {
                                onStartFirstAid()
                                if (!hasAudioPermission) onRequestAudioPermission() else onStartAudio()
                            } else if (!hasAudioPermission) {
                                onRequestAudioPermission()
                            } else if (voice.active) {
                                onStopAudio()
                            } else {
                                onStartAudio()
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = primaryColor,
                            contentColor = FirstAidColors.OnAccent,
                        ),
                        shape = RoundedCornerShape(FirstAidDimens.ButtonRadius),
                        modifier = Modifier
                            .weight(1f)
                            .height(FirstAidDimens.PrimaryControlHeight),
                    ) {
                        Text(
                            text = voiceButtonLabel(voice),
                            style = FirstAidType.Title,
                            color = FirstAidColors.OnAccent,
                        )
                    }
                    VoiceLevelDot(micState = state.micState, rmsLevel = rmsLevel)
                    ControlChip(label = if (useCameraSource) "关镜头" else "镜头", onClick = onToggleCamera)
                    ControlChip(label = "输入", onClick = { inputExpanded = true })
                    ControlChip(label = "更多", onClick = onOpenMore)
                }
            }
        }
    }
}

@Composable
private fun ControlChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        shape = RoundedCornerShape(FirstAidDimens.ButtonRadius),
        modifier = modifier.height(FirstAidDimens.PrimaryControlHeight),
    ) {
        Text(text = label, style = FirstAidType.Label, color = FirstAidColors.TextSecondary)
    }
}

private fun voiceButtonLabel(voice: VoiceControlPresentation): String =
    when {
        !voice.flowStarted -> "开始急救"
        voice.active -> "停止聆听"
        else -> "开始聆听"
    }

@Composable
private fun VoiceLevelDot(
    micState: MicState,
    rmsLevel: Float,
    modifier: Modifier = Modifier,
) {
    val active = micState in recordingMicStates || micState == MicState.Speaking
    val color = when (micState) {
        MicState.Speaking -> Color(0xFFA78BFA)
        MicState.Off -> Color(0xFF64748B)
        else -> if (active) Color(0xFF22C55E) else Color(0xFF334155)
    }
    val size = 14.dp + (10.dp * rmsLevel.coerceIn(0f, 1f))

    Box(
        modifier = modifier.size(34.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(color),
        )
    }
}

@Composable
private fun DemoInjectionDrawer(
    state: LiveUiState,
    onClose: () -> Unit,
    onRunPreset: (com.firstaid.copilot.live.DemoPreset) -> Unit,
    onRunSetup: () -> Unit,
    onOpenFixtureDebug: () -> Unit,
    onReset: () -> Unit,
    useCameraSource: Boolean,
    onCameraToggle: (Boolean) -> Unit,
    edgeSummary: String,
    onQuickQuestion: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = Color(0xFF0F172A),
        shape = RoundedCornerShape(topStart = 28.dp, bottomStart = 28.dp),
        modifier = modifier
            .fillMaxHeight()
            .width(360.dp),
    ) {
        Column(
            modifier = Modifier
                .padding(18.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Demo Injection",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                    modifier = Modifier.weight(1f),
                )
                Text("关闭", color = Color(0xFF93C5FD), modifier = Modifier.clickable(onClick = onClose))
            }
            Text(
                text = "当前：${state.currentStage ?: "未进入流程"}。Demo 注入会走 /api/turn，不直塞 UI。",
                color = Color(0xFFCBD5E1),
                fontSize = 13.sp,
            )
            Text(
                text = "Transcript: ${state.partialTranscript ?: "-"} / ${state.lastUserTranscript ?: "-"} / ${state.lastAssistantText ?: "-"}",
                color = Color(0xFF94A3B8),
                fontSize = 12.sp,
            )
            Text(
                text = "Runtime: $edgeSummary",
                color = Color(0xFF93C5FD),
                fontSize = 12.sp,
            )
            Text(
                text = "OpenQ: ${state.openQuestionStatusLine()}",
                color = Color(0xFF86EFAC),
                fontSize = 12.sp,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = onReset, modifier = Modifier.weight(1f)) {
                    Text("重置")
                }
                OutlinedButton(onClick = onOpenFixtureDebug, modifier = Modifier.weight(1f)) {
                    Text("旧 Fixture")
                }
            }
            OutlinedButton(
                onClick = { onCameraToggle(!useCameraSource) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (useCameraSource) "关闭 Camera" else "打开 Camera")
            }
            Button(onClick = onRunSetup, modifier = Modifier.fillMaxWidth()) {
                Text("运行 6 步 CPR setup")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = { onQuickQuestion("hand_left", "我按得对吗") },
                    modifier = Modifier.weight(1f),
                ) { Text("按得对吗") }
                OutlinedButton(
                    onClick = { onQuickQuestion("none", "我能不能停") },
                    modifier = Modifier.weight(1f),
                ) { Text("能不能停") }
            }
            OutlinedButton(
                onClick = { onQuickQuestion("none", "AED 来了怎么办") },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("AED 来了怎么办")
            }
            demoPresets.forEach { preset ->
                Surface(
                    color = if (preset.id == state.currentDemoPresetId) Color(0xFF1E40AF) else Color(0xFF1E293B),
                    shape = RoundedCornerShape(18.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onRunPreset(preset) },
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("${preset.id}  ${preset.label}", color = Color.White, fontWeight = FontWeight.SemiBold)
                        Text(preset.summary, color = Color(0xFFCBD5E1), fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusChip(text: String, color: Color) {
    Surface(color = color.copy(alpha = 0.22f), shape = CircleShape) {
        Text(
            text = text,
            color = Color.White,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

private fun Context.hasPermission(permission: String): Boolean =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

private val ConnectionState.label: String
    get() = when (this) {
        ConnectionState.Connecting -> "连接中"
        ConnectionState.Online -> "在线"
        ConnectionState.Offline -> "离线"
        ConnectionState.Error -> "错误"
    }

private val ConnectionState.color: Color
    get() = when (this) {
        ConnectionState.Connecting -> Color(0xFF64748B)
        ConnectionState.Online -> Color(0xFF16A34A)
        ConnectionState.Offline -> Color(0xFFF59E0B)
        ConnectionState.Error -> Color(0xFFDC2626)
    }

private fun LiveUiState.openQuestionStatusLine(): String {
    val metrics = lastOpenQuestionMetrics
    val phase = when (openQuestionPhase) {
        com.firstaid.copilot.live.OpenQuestionPhase.Idle -> "idle"
        com.firstaid.copilot.live.OpenQuestionPhase.Ack -> "ack"
        com.firstaid.copilot.live.OpenQuestionPhase.Answer -> "answer"
        com.firstaid.copilot.live.OpenQuestionPhase.Cancelled -> "cancelled"
    }
    if (metrics == null) return phase
    val segment = metrics.openQuestion.segment?.let { "segment=$it" }
    val total = metrics.timings["total_ms"]?.let { "total=${it}ms" }
    val gemma = metrics.timings["gemma_ms"]?.let { "gemma=${it}ms" }
    val wait = metrics.openQuestion.waitMs?.let { "wait=${it}ms" }
    val firstAudio = metrics.timings["tts_first_chunk_ms"]?.let { "audio=${it}ms" }
    val tts = metrics.tts.provider?.let { provider ->
        val cache = when (metrics.tts.cacheHit) {
            true -> "hit"
            false -> "miss"
            null -> "n/a"
        }
        "tts=$provider/$cache"
    }
    val answerCache = metrics.openQuestion.cacheHit?.let { cacheHit ->
        "answerCache=${if (cacheHit) "hit" else "miss"}"
    }
    val gemmaRoute = when {
        metrics.gemma.live -> "gemma=live"
        metrics.gemma.skipped -> "gemma=skip:${metrics.gemma.skipReason ?: "unknown"}"
        else -> null
    }
    return listOfNotNull(phase, segment, total, gemma, wait, firstAudio, tts, answerCache, gemmaRoute)
        .joinToString(" ")
}

private fun LiveUiState.isAssistantPlaybackActiveForAsr(): Boolean =
    micState == MicState.Speaking || isLiveAudioPlaying

private val recordingMicStates = setOf(MicState.Listening, MicState.Capturing, MicState.Uploading)
private const val TAG = "LiveCprCoachScreen"

@Composable
private fun EntryScreen(
    connectionLabel: String,
    onStartFirstAid: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(FirstAidDimens.ScreenPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(FirstAidDimens.SectionGap),
    ) {
        Text(
            text = "急救助手",
            style = FirstAidType.DisplayHero,
            color = FirstAidColors.TextPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "有人倒地、没有反应或没有呼吸时，点下面的按钮，我会一步步语音指导你急救。",
            style = FirstAidType.Body,
            color = FirstAidColors.TextSecondary,
            textAlign = TextAlign.Center,
        )
        PrimaryActionButton(label = "一键急救", onClick = onStartFirstAid)
        Text(
            text = "也可以直接说\u201C有人没有呼吸了\u201D唤起",
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "连接状态：$connectionLabel",
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
        )
    }
}

@Composable
private fun ToolConfirmationDialog(
    confirmation: ToolConfirmationState,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(text = confirmation.title, style = FirstAidType.Title, color = FirstAidColors.TextPrimary)
        },
        text = {
            confirmation.message?.let {
                Text(text = it, style = FirstAidType.Body, color = FirstAidColors.TextSecondary)
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(
                    containerColor = FirstAidColors.Progress,
                    contentColor = FirstAidColors.OnAccent,
                ),
            ) {
                Text("确认")
            }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) { Text("取消") }
        },
        containerColor = FirstAidColors.Surface,
    )
}

private fun LiveUiState.signalValue(key: String): Any? =
    perceptionSignals
        .filterIsInstance<PerceptionSignal<*>>()
        .firstOrNull { it.key == key && it.isFresh() }
        ?.value

private fun LiveUiState.cprHandPosition(): String? =
    signalValue("hand_position") as? String

private fun LiveUiState.cprRate(): Int? =
    (signalValue("compression_rate") as? Number)?.toInt()

private fun LiveUiState.cprArmStraight(): Boolean? =
    signalValue("arm_straight") as? Boolean

internal fun LiveUiState.toHandoverModel(nowMs: Long = System.currentTimeMillis()): HandoverReportUiModel {
    val total = (signalValue("total_compressions") as? Number)?.toInt()
    val latestTimeText = sessionStartedAtMs?.let { formatTimelineOffset(nowMs - it) } ?: "当前"
    val events = buildList {
        cprStartedAtMs?.let { startedAt ->
            add(HandoverEvent(formatTimelineTime(startedAt, sessionStartedAtMs), "CPR 开始"))
        }
        lastUserTranscript?.takeIf { it.isNotBlank() }?.let {
            add(HandoverEvent(latestTimeText, "用户反馈：$it"))
        }
        lastAssistantText?.takeIf { it.isNotBlank() }?.let {
            add(HandoverEvent(latestTimeText, "语音指导：$it"))
        }
        statusTags.forEach { tag -> add(HandoverEvent(latestTimeText, "状态：$tag")) }
    }
    return HandoverReportUiModel(
        startedAtText = sessionStartedAtMs?.let(::formatClockTime) ?: "未记录",
        durationText = sessionStartedAtMs?.let { formatDurationText(nowMs - it) } ?: "—",
        totalCompressions = total,
        averageRate = cprRate(),
        averageQuality = qualityScore,
        symptomSummary = "疑似心脏骤停：依现场判断为无反应、无正常呼吸",
        events = events,
        aedStatus = if (currentStage?.startsWith("S8") == true) "进入协助/AED 阶段" else "未记录",
        videoSaved = true,
        reportText = null,
    )
}

private fun formatClockTime(epochMs: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(epochMs))

private fun formatDurationText(durationMs: Long): String {
    val totalSeconds = (durationMs.coerceAtLeast(0L) / 1_000L).toInt()
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "$minutes 分 $seconds 秒"
}

private fun formatTimelineTime(eventMs: Long, sessionStartedAtMs: Long?): String =
    sessionStartedAtMs?.let { formatTimelineOffset(eventMs - it) } ?: formatClockTime(eventMs)

private fun formatTimelineOffset(durationMs: Long): String {
    val totalSeconds = (durationMs.coerceAtLeast(0L) / 1_000L).toInt()
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return String.format(Locale.US, "%02d:%02d", minutes, seconds)
}
