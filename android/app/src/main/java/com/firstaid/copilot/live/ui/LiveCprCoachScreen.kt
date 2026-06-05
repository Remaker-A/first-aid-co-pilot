package com.firstaid.copilot.live.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview as CameraPreview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.rememberUpdatedState
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
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.firstaid.copilot.live.AttentionMode
import com.firstaid.copilot.live.ConnectionState
import com.firstaid.copilot.live.DemoTurn
import com.firstaid.copilot.live.LiveSessionViewModel
import com.firstaid.copilot.live.LiveUiState
import com.firstaid.copilot.live.MicState
import com.firstaid.copilot.live.audio.LiveAudioCapture
import com.firstaid.copilot.live.audio.MetronomeController
import com.firstaid.copilot.live.demoCprSetupSequence
import com.firstaid.copilot.live.demoPresetById
import com.firstaid.copilot.live.demoPresets
import com.firstaid.copilot.live.edge.EdgeModelKind
import com.firstaid.copilot.live.edge.EdgeModelReport
import com.firstaid.copilot.live.edge.EdgeTextToSpeechEdge
import com.firstaid.copilot.live.edge.OnDeviceGemmaDriver
import com.firstaid.copilot.live.edge.StreamingAsrEvent
import com.firstaid.copilot.live.edge.StreamingAsrSession
import com.firstaid.copilot.live.edge.buildSherpaSpeechEngine
import com.firstaid.copilot.live.edge.buildSherpaStreamingAsrSession
import com.firstaid.copilot.live.edge.inspectEdgeModels
import com.firstaid.copilot.live.normalizeOverlayMode
import com.firstaid.copilot.live.toAttentionMode
import com.firstaid.copilot.live.vision.cpr.CprVisionAnalyzer
import com.firstaid.copilot.live.vision.cpr.VisionCameraFacing
import com.firstaid.copilot.live.vision.cpr.VisionCameraMount
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.Executors
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
    val coroutineScope = rememberCoroutineScope()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val attentionMode = state.attentionModeInputs.toAttentionMode()

    var useCameraSource by remember { mutableStateOf(false) }
    var showDemoDrawer by remember { mutableStateOf(false) }
    var hasCameraPermission by remember {
        mutableStateOf(context.hasPermission(Manifest.permission.CAMERA))
    }
    var hasAudioPermission by remember {
        mutableStateOf(context.hasPermission(Manifest.permission.RECORD_AUDIO))
    }
    var startAudioAfterPermission by remember { mutableStateOf(false) }
    var rmsLevel by remember { mutableFloatStateOf(0f) }
    var liveAudioEnabled by remember { mutableStateOf(false) }
    var edgeReport by remember { mutableStateOf<EdgeModelReport?>(null) }
    var edgeSummary by remember { mutableStateOf("Edge models: checking") }
    var gemmaDriver by remember { mutableStateOf<OnDeviceGemmaDriver?>(null) }
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
            audioCapture.setTtsSpeaking(speaking)
            // Single voice: duck the metronome under TTS, restore to full when done.
            // The beat itself never pauses for TTS — only its volume changes.
            metronome.setDucked(speaking)
            viewModel.setMicState(
                when {
                    speaking -> MicState.Speaking
                    liveAudioEnabled -> MicState.Listening
                    else -> MicState.Idle
                },
            )
        }
    }
    fun handleStreamingAsrEvents(events: List<StreamingAsrEvent>) {
        events.forEach { event ->
            when (event) {
                is StreamingAsrEvent.Partial -> mainHandler.post {
                    viewModel.acceptLocalAsrPartial(event.text)
                }
                is StreamingAsrEvent.Final -> mainHandler.post {
                    if (event.text.isNotBlank()) {
                        viewModel.submitLiveText(text = event.text, intent = event.intent)
                    }
                }
                StreamingAsrEvent.Endpoint -> mainHandler.post {
                    if (liveAudioEnabled) {
                        viewModel.setMicState(MicState.Listening)
                    }
                }
                is StreamingAsrEvent.Error -> mainHandler.post {
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
                when {
                    localStreamingAsr != null -> {
                        handleStreamingAsrEvents(localStreamingAsr.end())
                    }
                    useWholeUtteranceAsr -> {
                        coroutineScope.launch {
                            viewModel.setMicState(MicState.Uploading)
                            val result = asrSpeechEngine.transcribePcm16(pcm16)
                            if (result.ok && result.text.isNotBlank()) {
                                viewModel.submitLiveText(text = result.text)
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
                val driver = OnDeviceGemmaDriver(context.applicationContext, File(gemmaPath))
                gemmaDriver = driver
                val warmup = driver.prewarm()
                gemmaWarmSummary = if (warmup.ok) {
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

    LaunchedEffect(state.isLiveAudioPlaying) {
        if (state.isLiveAudioPlaying) {
            audioCapture.setTtsSpeaking(true)
            metronome.setDucked(true)
        } else {
            delay(180)
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

    DisposableEffect(Unit) {
        onDispose {
            metronome.release()
            audioCapture.release()
            ttsEdge.shutdown()
            asrSpeechEngine.close()
            streamingAsrSession?.close()
            ttsSpeechEngine.close()
            gemmaDriver?.close()
        }
    }

    fun setCameraSource(enabled: Boolean) {
        if (enabled && !hasCameraPermission) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
        useCameraSource = enabled
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF070B12)),
    ) {
        CameraPreviewSurface(
            useCameraSource = useCameraSource,
            hasCameraPermission = hasCameraPermission,
            enableVisionAnalysis = useCameraSource && state.currentStage.isCprVisionAnalysisStage(),
            onVisionMetrics = viewModel::submitVisionMetrics,
            onVisionUnavailable = viewModel::reportVisionUnavailable,
            onRequestCameraPermission = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) },
            modifier = Modifier.fillMaxSize(),
        )

        CprCoachOverlay(
            mode = state.visualOverlayMode,
            correctionArrow = state.correctionArrow,
            attentionMode = attentionMode,
            modifier = Modifier.fillMaxSize(),
        )

        when (attentionMode) {
            AttentionMode.Coach -> CoachLayout(state)
            AttentionMode.EyesOff -> EyesOffLayout(state)
            AttentionMode.Glanceable -> GlanceableLayout(state)
        }

        MinimalTopStatus(
            state = state,
            onOpenDebug = { showDemoDrawer = true },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(16.dp),
        )

        LiveVoiceControls(
            state = state,
            rmsLevel = rmsLevel,
            hasAudioPermission = hasAudioPermission,
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
                .padding(16.dp),
        )

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
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MinimalTopStatus(
    state: LiveUiState,
    onOpenDebug: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = Color(0x990F172A),
        shape = RoundedCornerShape(22.dp),
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {},
                onLongClick = onOpenDebug,
            ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StatusChip(state.connectionState.label, state.connectionState.color)
            Text(
                text = stageStatusLabel(state.currentStage),
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
            )
        }
    }
}

@Composable
private fun CoachLayout(state: LiveUiState) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 92.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        FlowProgressRail(state.currentStage)
        GuidanceCard(state, large = false)
    }
}

@Composable
private fun EyesOffLayout(state: LiveUiState) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 116.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = primaryGuidanceText(state.mainText, state.currentStage),
            color = Color.White,
            fontSize = 46.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center,
            lineHeight = 52.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        compactSecondaryText(state.secondaryText, state.statusTags)?.let {
            Spacer(Modifier.height(16.dp))
            Text(
                text = it,
                color = Color(0xFFE2E8F0),
                fontSize = 22.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        QualityScoreDial(
            score = state.qualityScore,
            currentStage = state.currentStage,
            modifier = Modifier.padding(top = 22.dp),
        )
    }
}

@Composable
private fun GlanceableLayout(state: LiveUiState) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 22.dp, vertical = 108.dp),
        verticalArrangement = Arrangement.Bottom,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        GuidanceCard(state, large = true)
    }
}

@Composable
private fun GuidanceCard(
    state: LiveUiState,
    large: Boolean,
) {
    Surface(
        color = Color(0xE60B1220),
        shape = RoundedCornerShape(28.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = primaryGuidanceText(state.mainText, state.currentStage),
                color = Color.White,
                fontSize = if (large) 36.sp else 28.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            compactSecondaryText(state.secondaryText, state.statusTags)?.let {
                Text(
                    text = it,
                    color = Color(0xFFCBD5E1),
                    fontSize = if (large) 20.sp else 17.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            QualityScoreDial(score = state.qualityScore, currentStage = state.currentStage)
        }
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
private fun CameraPreviewSurface(
    useCameraSource: Boolean,
    hasCameraPermission: Boolean,
    enableVisionAnalysis: Boolean,
    onVisionMetrics: (Map<String, Any?>) -> Unit,
    onVisionUnavailable: (String) -> Unit,
    onRequestCameraPermission: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestOnVisionMetrics by rememberUpdatedState(onVisionMetrics)
    val latestOnVisionUnavailable by rememberUpdatedState(onVisionUnavailable)
    val mainExecutor = remember {
        Executor { command -> Handler(Looper.getMainLooper()).post(command) }
    }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    var previewView by remember { mutableStateOf<PreviewView?>(null) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    var visionAnalyzer by remember { mutableStateOf<CprVisionAnalyzer?>(null) }

    Box(
        modifier = modifier.background(Color(0xFF111827)),
        contentAlignment = Alignment.Center,
    ) {
        if (useCameraSource && hasCameraPermission) {
            AndroidView(
                factory = { viewContext ->
                    PreviewView(viewContext).apply {
                        scaleType = PreviewView.ScaleType.FILL_CENTER
                        previewView = this
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            MockCameraFallback(
                message = if (useCameraSource) "需要相机权限" else null,
                showPermissionButton = useCameraSource,
                onRequestCameraPermission = onRequestCameraPermission,
            )
        }

    }

    LaunchedEffect(useCameraSource, hasCameraPermission, enableVisionAnalysis, previewView, lifecycleOwner) {
        val view = previewView ?: return@LaunchedEffect
        if (!useCameraSource || !hasCameraPermission) {
            visionAnalyzer?.close()
            visionAnalyzer = null
            cameraProvider?.unbindAll()
            return@LaunchedEffect
        }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                runCatching {
                    val provider = future.get()
                    val preview = CameraPreview.Builder().build().also {
                        it.setSurfaceProvider(view.surfaceProvider)
                    }
                    visionAnalyzer?.close()
                    visionAnalyzer = null
                    val analyzer = if (enableVisionAnalysis) {
                        CprVisionAnalyzer(
                            context = context,
                            cameraFacing = VisionCameraFacing.Front,
                            cameraMount = VisionCameraMount.SideFixed,
                            mirrored = true,
                            onMetrics = { metrics ->
                                mainHandler.post { latestOnVisionMetrics(metrics) }
                            },
                            onUnavailable = { message ->
                                mainHandler.post {
                                    latestOnVisionUnavailable(message)
                                }
                            },
                        )
                    } else {
                        null
                    }
                    val analysis = analyzer?.let {
                        ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                            .also { imageAnalysis ->
                                imageAnalysis.setAnalyzer(analysisExecutor, it)
                            }
                    }
                    provider.unbindAll()
                    if (analysis != null) {
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis)
                    } else {
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_FRONT_CAMERA, preview)
                    }
                    cameraProvider = provider
                    visionAnalyzer = analyzer
                }.onFailure {
                    val message = "相机预览不可用：${it.message}"
                    latestOnVisionUnavailable(message)
                }
            },
            mainExecutor,
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            visionAnalyzer?.close()
            cameraProvider?.unbindAll()
            analysisExecutor.shutdown()
        }
    }
}

@Composable
private fun MockCameraFallback(
    message: String?,
    showPermissionButton: Boolean,
    onRequestCameraPermission: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0F172A)),
    ) {
        Box(
            modifier = Modifier
                .size(220.dp, 320.dp)
                .clip(RoundedCornerShape(120.dp))
                .border(2.dp, Color(0xFF334155), RoundedCornerShape(120.dp))
                .background(Color(0xFF111827)),
        )
        message?.let {
            Spacer(Modifier.height(18.dp))
            Text(text = it, color = Color(0xFFCBD5E1), textAlign = TextAlign.Center)
        }
        if (showPermissionButton) {
            OutlinedButton(onClick = onRequestCameraPermission, modifier = Modifier.padding(top = 8.dp)) {
                Text("请求相机权限")
            }
        }
    }
}

@Composable
private fun FlowProgressRail(currentStage: String?) {
    val currentIndex = currentStage?.let { Regex("""S(\d+)""").find(it)?.groupValues?.getOrNull(1)?.toIntOrNull() } ?: 0
    Surface(color = Color(0xB30F172A), shape = RoundedCornerShape(20.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            (0..9).forEach { index ->
                val active = index <= currentIndex
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(10.dp)
                        .clip(CircleShape)
                        .background(if (active) Color(0xFF22C55E) else Color(0xFF334155)),
                )
            }
        }
    }
}

@Composable
private fun LiveVoiceControls(
    state: LiveUiState,
    rmsLevel: Float,
    hasAudioPermission: Boolean,
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
        !voice.flowStarted -> Color(0xFF16A34A)
        voice.active -> Color(0xFFDC2626)
        else -> Color(0xFF2563EB)
    }
    Surface(color = Color(0xE60F172A), shape = RoundedCornerShape(26.dp), modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (inputExpanded) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("输入") },
                    modifier = Modifier
                        .weight(1f)
                        .height(72.dp),
                    singleLine = true,
                )
                Button(
                    enabled = text.isNotBlank() && !state.isInFlight,
                    onClick = {
                        onSubmitText(text)
                        text = ""
                        inputExpanded = false
                    },
                    modifier = Modifier.height(72.dp),
                    colors = ButtonDefaults.buttonColors(
                        disabledContainerColor = Color(0xFF1E293B),
                        disabledContentColor = Color(0xFF94A3B8),
                    ),
                ) {
                    Text("发送")
                }
                OutlinedButton(
                    onClick = { inputExpanded = false },
                    modifier = Modifier.height(72.dp),
                ) {
                    Text("收起")
                }
            } else {
                Button(
                    enabled = !state.isInFlight || voice.active,
                    onClick = {
                        if (!voice.flowStarted) {
                            onStartFirstAid()
                            if (!hasAudioPermission) {
                                onRequestAudioPermission()
                            } else {
                                onStartAudio()
                            }
                        } else if (!hasAudioPermission) {
                            onRequestAudioPermission()
                        } else if (voice.active) {
                            onStopAudio()
                        } else {
                            onStartAudio()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = primaryColor),
                    modifier = Modifier
                        .weight(1f)
                        .height(72.dp),
                ) {
                    Text(voice.label, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                }
                VoiceLevelDot(
                    micState = state.micState,
                    rmsLevel = rmsLevel,
                )
                OutlinedButton(
                    onClick = { inputExpanded = !inputExpanded },
                    modifier = Modifier.height(72.dp),
                ) {
                    Text("输入")
                }
            }
        }
    }
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
private fun QualityScoreDial(
    score: Int?,
    currentStage: String?,
    modifier: Modifier = Modifier,
) {
    val presentation = qualityScorePresentation(score, currentStage) ?: return
    val color = presentation.tone.toColor()

    Surface(
        color = color.copy(alpha = 0.2f),
        shape = RoundedCornerShape(28.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "质量",
                color = Color(0xFFCBD5E1),
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = presentation.valueText,
                    color = Color.White,
                    fontSize = if (presentation.tone == QualityScoreTone.Pending) 24.sp else 44.sp,
                    fontWeight = FontWeight.Black,
                    maxLines = 1,
                )
                if (presentation.labelText.isNotBlank()) {
                    Text(
                        text = presentation.labelText,
                        color = color,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Black,
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
            }
        }
    }
}

private fun QualityScoreTone.toColor(): Color =
    when (this) {
        QualityScoreTone.Good -> Color(0xFF22C55E)
        QualityScoreTone.Steady -> Color(0xFFF59E0B)
        QualityScoreTone.Adjust -> Color(0xFFEF4444)
        QualityScoreTone.Pending -> Color(0xFF38BDF8)
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

private fun String?.isCprVisionAnalysisStage(): Boolean =
    this?.startsWith("S6") == true || this?.startsWith("S7") == true

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

private val recordingMicStates = setOf(MicState.Listening, MicState.Capturing, MicState.Uploading)
