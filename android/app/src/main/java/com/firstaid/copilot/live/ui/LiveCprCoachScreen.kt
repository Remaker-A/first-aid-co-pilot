package com.firstaid.copilot.live.ui

import android.Manifest
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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.firstaid.copilot.live.AttentionMode
import com.firstaid.copilot.live.ConnectionState
import com.firstaid.copilot.live.DEMO_WAKE_PHRASE
import com.firstaid.copilot.live.DemoTurn
import com.firstaid.copilot.live.LiveSessionViewModel
import com.firstaid.copilot.live.LiveUiState
import com.firstaid.copilot.live.MicState
import com.firstaid.copilot.live.SourceBadge
import com.firstaid.copilot.live.audio.AndroidTextToSpeechEdge
import com.firstaid.copilot.live.audio.LiveAudioCapture
import com.firstaid.copilot.live.audio.MetronomeController
import com.firstaid.copilot.live.demoCprSetupSequence
import com.firstaid.copilot.live.demoPresetById
import com.firstaid.copilot.live.demoPresets
import com.firstaid.copilot.live.normalizeOverlayMode
import com.firstaid.copilot.live.toAttentionMode
import com.firstaid.copilot.live.vision.cpr.CprVisionAnalyzer
import com.firstaid.copilot.live.vision.cpr.VisionCameraFacing
import com.firstaid.copilot.live.vision.cpr.VisionCameraMount
import java.util.concurrent.Executor
import java.util.concurrent.Executors

@Composable
fun LiveCprCoachScreen(
    viewModel: LiveSessionViewModel = viewModel(),
    onOpenFixtureDebug: () -> Unit = {},
) {
    val context = LocalContext.current
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
    val mainHandler = remember { Handler(Looper.getMainLooper()) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasCameraPermission = granted }

    val metronome = remember { MetronomeController(context) }
    val audioCapture = remember { LiveAudioCapture() }
    val ttsEdge = remember {
        AndroidTextToSpeechEdge(context) { speaking ->
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
    fun startAudioCapture() {
        liveAudioEnabled = true
        viewModel.startLiveAudio()
        audioCapture.start(
            onLevel = { level ->
                mainHandler.post {
                    rmsLevel = level.coerceIn(0f, 0.25f) / 0.25f
                }
            },
            onPcmChunk = { pcm16 ->
                viewModel.sendLivePcm(pcm16)
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
    }

    LaunchedEffect(state.haptic) {
        metronome.apply(state.haptic)
    }

    LaunchedEffect(state.lastActionId, state.ttsText) {
        ttsEdge.speak(
            text = state.ttsText,
            utteranceKey = state.lastActionId,
            priority = state.ttsPriority,
            interruptPolicy = state.ttsInterruptPolicy,
            tone = state.ttsTone,
            speed = state.ttsSpeed,
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            metronome.release()
            audioCapture.release()
            ttsEdge.shutdown()
        }
    }

    val displayBadge = when {
        state.currentDemoPresetId != null -> SourceBadge.DemoData
        state.sourceBadge == SourceBadge.LiveRecognition -> SourceBadge.LiveRecognition
        useCameraSource || state.micState in recordingMicStates -> SourceBadge.RecordingOnly
        else -> state.sourceBadge
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

        TopStatusStrip(
            state = state,
            sourceBadge = displayBadge,
            useCameraSource = useCameraSource,
            onCameraToggle = {
                if (!hasCameraPermission && !useCameraSource) {
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                }
                useCameraSource = it
            },
            onOpenDemo = { showDemoDrawer = true },
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
            onWakeEntry = { viewModel.triggerWakePhrase(DEMO_WAKE_PHRASE) },
            onSubmitText = {
                ttsEdge.stop()
                viewModel.submitTurn(text = it)
            },
            onStartAudio = { startAudioCapture() },
            onStopAudio = {
                liveAudioEnabled = false
                audioCapture.stop()
                viewModel.stopLiveAudio()
            },
            onReset = {
                ttsEdge.stop()
                viewModel.reset()
            },
            onOpenFixtureDebug = onOpenFixtureDebug,
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

@Composable
private fun TopStatusStrip(
    state: LiveUiState,
    sourceBadge: SourceBadge,
    useCameraSource: Boolean,
    onCameraToggle: (Boolean) -> Unit,
    onOpenDemo: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = Color(0xDD0F172A),
        shape = RoundedCornerShape(24.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StatusChip(state.connectionState.label, state.connectionState.color)
            SourceBadgeView(sourceBadge)
            Text(
                text = state.currentStage ?: "等待状态",
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Text("Camera", color = Color.White, fontSize = 12.sp)
            Switch(checked = useCameraSource, onCheckedChange = onCameraToggle)
            OutlinedButton(onClick = onOpenDemo) {
                Text("Demo")
            }
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
        LiveSubtitleLayer(state)
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
            text = state.mainText.ifBlank { "继续按压" },
            color = Color.White,
            fontSize = 46.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center,
            lineHeight = 52.sp,
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = state.secondaryText.ifBlank { "跟着节拍，胸口中央，持续按压" },
            color = Color(0xFFE2E8F0),
            fontSize = 22.sp,
            textAlign = TextAlign.Center,
        )
        QualityScore(state.qualityScore, Modifier.padding(top = 22.dp))
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
        LiveSubtitleLayer(state)
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
                text = state.mainText.ifBlank { "等待急救引导" },
                color = Color.White,
                fontSize = if (large) 36.sp else 28.sp,
                fontWeight = FontWeight.Bold,
            )
            state.secondaryText.takeIf { it.isNotBlank() }?.let {
                Text(text = it, color = Color(0xFFCBD5E1), fontSize = if (large) 20.sp else 17.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.statusTags.take(4).forEach { tag ->
                    StatusChip(tag, Color(0xFF2563EB))
                }
            }
            QualityScore(state.qualityScore)
            state.lastErrorMessage?.let {
                Text(text = it, color = Color(0xFFFBBF24), fontSize = 13.sp)
            }
            if (state.perceptionSignals.isEmpty()) {
                Text(text = "感知信号：占位接入，当前不做真实识别", color = Color(0xFF94A3B8), fontSize = 12.sp)
            }
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
    var cameraError by remember { mutableStateOf<String?>(null) }

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
                message = if (useCameraSource) "需要相机权限，仅显示模拟背景" else "模拟背景源，不代表实时识别",
                onRequestCameraPermission = onRequestCameraPermission,
            )
        }

        cameraError?.let {
            Text(text = it, color = Color(0xFFFCA5A5), modifier = Modifier.padding(24.dp))
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
                                    cameraError = message
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
                    cameraError = null
                }.onFailure {
                    cameraError = "相机预览不可用：${it.message}"
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
    message: String,
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
        Spacer(Modifier.height(18.dp))
        Text(text = message, color = Color(0xFFCBD5E1), textAlign = TextAlign.Center)
        OutlinedButton(onClick = onRequestCameraPermission, modifier = Modifier.padding(top = 8.dp)) {
            Text("请求相机权限")
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
private fun LiveSubtitleLayer(state: LiveUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        state.partialTranscript?.let {
            SubtitleLine(prefix = "你（实时）", text = it)
        }
        state.lastUserTranscript?.let {
            SubtitleLine(prefix = "你", text = it)
        }
        state.lastAssistantText?.let {
            SubtitleLine(prefix = "助手", text = it)
        }
    }
}

@Composable
private fun SubtitleLine(prefix: String, text: String) {
    Surface(color = Color(0x99000000), shape = RoundedCornerShape(16.dp)) {
        Text(
            text = "$prefix：$text",
            color = Color.White,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            fontSize = 15.sp,
        )
    }
}

@Composable
private fun LiveVoiceControls(
    state: LiveUiState,
    rmsLevel: Float,
    hasAudioPermission: Boolean,
    onRequestAudioPermission: () -> Unit,
    onStartFirstAid: () -> Unit,
    onWakeEntry: () -> Boolean,
    onSubmitText: (String) -> Unit,
    onStartAudio: () -> Unit,
    onStopAudio: () -> Unit,
    onReset: () -> Unit,
    onOpenFixtureDebug: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var text by remember { mutableStateOf("") }
    val listening = state.micState == MicState.Listening || state.micState == MicState.Capturing
    val flowStarted = state.currentStage != null && state.currentStage != "S0_INIT"
    val primaryLabel = when {
        !flowStarted -> "一键急救"
        listening -> "停止录音"
        else -> "继续录音"
    }
    val primaryColor = when {
        !flowStarted -> Color(0xFF16A34A)
        listening -> Color(0xFFDC2626)
        else -> Color(0xFF2563EB)
    }
    Surface(color = Color(0xF20F172A), shape = RoundedCornerShape(26.dp), modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("说不清时可直接输入") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                Button(
                    enabled = text.isNotBlank() && !state.isInFlight,
                    onClick = {
                        onSubmitText(text)
                        text = ""
                    },
                ) {
                    Text("发送")
                }
            }
            if (!flowStarted) {
                // Wake-word entry (Demo): routes through the same EntryAdapter as the
                // always-available "一键急救" fallback below. A real offline wake engine
                // would call viewModel.triggerWakePhrase(recognizedText) on this seam.
                OutlinedButton(
                    onClick = {
                        if (onWakeEntry()) {
                            if (!hasAudioPermission) onRequestAudioPermission() else onStartAudio()
                        }
                    },
                    enabled = !state.isInFlight,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("语音唤起（Demo：有人没有呼吸了）")
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    enabled = !state.isInFlight || listening,
                    onClick = {
                        if (!flowStarted) {
                            onStartFirstAid()
                            if (!hasAudioPermission) {
                                onRequestAudioPermission()
                            } else {
                                onStartAudio()
                            }
                        } else if (!hasAudioPermission) {
                            onRequestAudioPermission()
                        } else if (listening) {
                            onStopAudio()
                        } else {
                            onStartAudio()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = primaryColor),
                ) {
                    Text(primaryLabel)
                }
                LinearProgressIndicator(
                    progress = { rmsLevel },
                    modifier = Modifier
                        .weight(1f)
                        .height(8.dp)
                        .clip(CircleShape),
                )
                OutlinedButton(onClick = onReset) { Text("重置") }
                OutlinedButton(onClick = onOpenFixtureDebug) { Text("旧 Fixture") }
            }
            Text(
                text = "麦克风：${state.micState.label}。TTS 播放时保持采集，仅持续高阈值说话会打断播报。",
                color = Color(0xFFCBD5E1),
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun DemoInjectionDrawer(
    state: LiveUiState,
    onClose: () -> Unit,
    onRunPreset: (com.firstaid.copilot.live.DemoPreset) -> Unit,
    onRunSetup: () -> Unit,
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
private fun QualityScore(score: Int?, modifier: Modifier = Modifier) {
    score ?: return
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("质量分", color = Color(0xFFCBD5E1), fontSize = 13.sp)
            Spacer(Modifier.width(10.dp))
            Text("$score", color = Color.White, fontWeight = FontWeight.Bold)
        }
        LinearProgressIndicator(
            progress = { score.coerceIn(0, 100) / 100f },
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(CircleShape),
        )
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

@Composable
private fun SourceBadgeView(sourceBadge: SourceBadge) {
    val (label, color) = when (sourceBadge) {
        SourceBadge.DemoData -> "演示数据" to Color(0xFFF59E0B)
        SourceBadge.RecordingOnly -> "仅录制/采集" to Color(0xFF38BDF8)
        SourceBadge.LiveRecognition -> "实时识别" to Color(0xFF22C55E)
    }
    StatusChip(label, color)
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

private val MicState.label: String
    get() = when (this) {
        MicState.Idle -> "空闲"
        MicState.Listening -> "监听中"
        MicState.Capturing -> "采集中"
        MicState.Uploading -> "上传中"
        MicState.Speaking -> "TTS 播放"
        MicState.Off -> "关闭"
    }

private val recordingMicStates = setOf(MicState.Listening, MicState.Capturing, MicState.Uploading)
