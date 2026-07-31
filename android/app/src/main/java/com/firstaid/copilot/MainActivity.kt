package com.firstaid.copilot

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview as CameraPreview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.GuidanceActionDispatcher
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.ToolAction
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import com.firstaid.copilot.perception.CameraDeviceState
import com.firstaid.copilot.perception.CameraFrameSignal
import com.firstaid.copilot.perception.CameraPerceptionBridge
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            FirstAidCopilotApp()
        }
    }
}

@Composable
private fun FirstAidCopilotApp() {
    MaterialTheme {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF8FAFC)),
            color = Color(0xFFF8FAFC),
        ) {
            GuidanceActionShell()
        }
    }
}

@Composable
private fun GuidanceActionShell() {
    val haptics = LocalHapticFeedback.current
    val context = LocalContext.current
    val eventLog = remember { mutableStateListOf<String>() }
    var lastAction by remember { mutableStateOf<GuidanceAction?>(null) }
    var lastCameraPayload by remember { mutableStateOf("") }
    val tts = remember { mutableStateOf<TextToSpeech?>(null) }
    val dispatcher = remember { GuidanceActionDispatcher() }
    val cameraBridge = remember { CameraPerceptionBridge(sessionId = "android_camera_session") }

    DisposableEffect(context) {
        val engine = TextToSpeech(context) {}
        tts.value = engine
        onDispose {
            engine.stop()
            engine.shutdown()
            tts.value = null
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "FirstAid Copilot",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF0F172A),
        )

        Text(
            text = lastAction?.ui?.main_text ?: "Waiting for guidance action",
            style = MaterialTheme.typography.titleMedium,
            color = Color(0xFF1E293B),
        )

        CameraInputPanel(
            onCameraState = { state ->
                val event = cameraBridge.deviceStateEvent(state)
                lastCameraPayload = event.toJsonString()
                eventLog.add(
                    event.toLogLine() +
                        " permission=${state.permission} preview=${state.previewActive}"
                )
            },
            onFrameSignal = { signal ->
                val event = cameraBridge.frameSignalEvent(signal)
                lastCameraPayload = event.toJsonString()
                eventLog.add(
                    event.toLogLine() +
                        " brightness=${signal.brightnessLabel} motion=${signal.motionLabel}"
                )
            },
        )

        if (lastCameraPayload.isNotBlank()) {
            Text(
                text = lastCameraPayload,
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF475569),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                onClick = {
                    val action = sampleGuidanceAction()
                    lastAction = action
                    executeAction(action, dispatcher, eventLog)
                    deliverAndroidEdges(action, tts.value) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                },
            ) {
                Text("Dispatch")
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Execution log",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFF334155),
        )

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            eventLog.forEach { line ->
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF475569),
                )
            }
        }
    }
}

@Composable
private fun CameraInputPanel(
    onCameraState: (CameraDeviceState) -> Unit,
    onFrameSignal: (CameraFrameSignal) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var status by remember {
        mutableStateOf(if (hasPermission) "camera_stream_status=previewing" else "camera_permission=required")
    }
    var frameStatus by remember { mutableStateOf("camera_frame_signal=waiting") }
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val cameraFrameAnalyzer = remember {
        CameraFrameAnalyzer { signal ->
            ContextCompat.getMainExecutor(context).execute {
                frameStatus = "brightness=${signal.brightnessLabel} motion=${signal.motionLabel}"
                onFrameSignal(signal)
            }
        }
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasPermission = granted
        status = if (granted) "camera_stream_status=previewing" else "camera_permission=denied"
        onCameraState(
            CameraDeviceState(
                available = granted,
                permission = if (granted) "granted" else "denied",
                previewActive = granted,
            ),
        )
    }

    LaunchedEffect(hasPermission) {
        onCameraState(
            CameraDeviceState(
                available = hasPermission,
                permission = if (hasPermission) "granted" else "required",
                previewActive = hasPermission,
            ),
        )
    }

    DisposableEffect(context, lifecycleOwner, hasPermission) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        if (hasPermission) {
            val executor = ContextCompat.getMainExecutor(context)
            cameraProviderFuture.addListener(
                {
                    try {
                        val cameraProvider = cameraProviderFuture.get()
                        val preview = CameraPreview.Builder().build().also {
                            it.setSurfaceProvider(previewView.surfaceProvider)
                        }
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                            .also {
                                it.setAnalyzer(analysisExecutor, cameraFrameAnalyzer)
                            }
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                        status = "camera_stream_status=analyzing"
                        onCameraState(
                            CameraDeviceState(
                                available = true,
                                permission = "granted",
                                previewActive = true,
                                streamStatus = "analyzing",
                            ),
                        )
                    } catch (error: Exception) {
                        status = "camera_stream_status=failed:${error.javaClass.simpleName}"
                        onCameraState(
                            CameraDeviceState(
                                available = false,
                                permission = "granted",
                                previewActive = false,
                                streamStatus = "failed",
                            ),
                        )
                    }
                },
                executor,
            )
        }

        onDispose {
            if (cameraProviderFuture.isDone) {
                runCatching { cameraProviderFuture.get().unbindAll() }
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            analysisExecutor.shutdown()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Camera input",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFF334155),
        )
        AndroidView(
            factory = { previewView },
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f)
                .background(Color(0xFF0F172A)),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                enabled = !hasPermission,
                onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
            ) {
                Text("Enable camera")
            }
            Text(
                text = status,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF475569),
                modifier = Modifier.weight(1f),
            )
        }
        Text(
            text = frameStatus,
            style = MaterialTheme.typography.bodyMedium,
            color = Color(0xFF475569),
        )
    }
}

private class CameraFrameAnalyzer(
    private val onFrameSignal: (CameraFrameSignal) -> Unit,
) : ImageAnalysis.Analyzer {
    private var frameIndex = 0L
    private var lastBrightness: Double? = null
    private var lastSignalAtMs = 0L

    override fun analyze(image: ImageProxy) {
        try {
            frameIndex += 1
            val now = System.currentTimeMillis()
            if (now - lastSignalAtMs < FRAME_SIGNAL_INTERVAL_MS) {
                return
            }

            val brightness = image.averageLuma()
            val motionScore = lastBrightness?.let { abs(brightness - it) } ?: 0.0
            lastBrightness = brightness
            lastSignalAtMs = now

            onFrameSignal(
                CameraFrameSignal(
                    frameId = "android_frame_$frameIndex",
                    width = image.width,
                    height = image.height,
                    rotationDegrees = image.imageInfo.rotationDegrees,
                    brightness = brightness,
                    brightnessLabel = labelBrightness(brightness),
                    motionScore = motionScore,
                    motionLabel = labelMotion(motionScore),
                ),
            )
        } finally {
            image.close()
        }
    }
}

private fun ImageProxy.averageLuma(): Double {
    val buffer = planes.firstOrNull()?.buffer ?: return 0.0
    var sum = 0L
    var count = 0
    while (buffer.hasRemaining()) {
        sum += buffer.get().toInt() and 0xFF
        count += 1
    }
    buffer.rewind()
    return if (count == 0) 0.0 else sum.toDouble() / count
}

private fun labelBrightness(value: Double): String =
    when {
        value < 45.0 -> "too_dark"
        value > 190.0 -> "too_bright"
        else -> "usable"
    }

private fun labelMotion(value: Double): String =
    when {
        value < 4.0 -> "stable"
        value >= 18.0 -> "high_motion"
        else -> "motion"
    }

private const val FRAME_SIGNAL_INTERVAL_MS = 900L

private fun executeAction(
    action: GuidanceAction,
    dispatcher: GuidanceActionDispatcher,
    eventLog: MutableList<String>,
) {
    val result = dispatcher.dispatch(action)
    eventLog.add("dispatch:${result.action_id} channels=${result.channels.joinToString(",")}")
    result.warnings.forEach { eventLog.add("warning:$it") }
    action.log_event?.let { eventLog.add("log:$it") }
}

private fun deliverAndroidEdges(
    action: GuidanceAction,
    tts: TextToSpeech?,
    haptic: () -> Unit,
) {
    action.tts.text.takeIf { it.isNotBlank() }?.let {
        tts?.language = Locale.US
        tts?.speak(it, TextToSpeech.QUEUE_FLUSH, null, action.action_id)
    }

    if (action.haptic.enabled) {
        haptic()
    }
}

private fun sampleGuidanceAction(): GuidanceAction =
    GuidanceAction(
        action_id = "sample-action-001",
        timestamp = "2026-06-03T00:00:00Z",
        stage = "ANDROID_EXECUTION_SHELL",
        intent = "render_guidance",
        source = "sample_agent_output",
        reason_codes = listOf("android_shell_fixture"),
        tts = TtsPayload(text = "Keep following the agent guidance."),
        ui = UiPayload(
            main_text = "Keep following the agent guidance.",
            secondary_text = "Agent-owned guidance rendered by Android.",
            status_tags = listOf("execution-only"),
        ),
        haptic = HapticPayload(enabled = true, pattern = "prompt"),
        tool_actions = listOf(
            ToolAction(
                type = "log_marker",
                payload = mapOf("fixture" to true),
            ),
        ),
        log_event = mapOf("event" to "guidance_action_dispatched"),
    )

@Preview(showBackground = true)
@Composable
private fun FirstAidCopilotAppPreview() {
    FirstAidCopilotApp()
}
