package com.example.cpr_new.hardware.camera

import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.cpr_new.core.contract.CameraInputSpec
import com.example.cpr_new.core.contract.FrameMeta
import com.example.cpr_new.core.contract.FrameSink
import java.util.concurrent.Executors

/**
 * 摄像头预览组件 —— 硬件适配层（CameraX）。
 *
 * 职责（第 4 部分边界内）：
 * 1. 打开摄像头并在界面显示实时预览（[Preview] 用例）；
 * 2. 可选地把每帧通过 [ImageAnalysis] 转交给 [frameSink]（第 3 部分识别模型）。
 * 3. 支持前后摄像头切换（[lensFacing] 控制，默认后置）。
 *
 * 不做任何图像理解——那是第 3 部分的职责。本组件只负责“取流 + 递帧 + 预览”。
 *
 * 设计要点：
 * - 无状态、自管生命周期：绑定到 [LocalLifecycleOwner]，离开界面自动解绑、释放相机；
 * - [enabled] 作为 key：权限授予后翻转为 true，会自动重新绑定相机；
 * - 仅当 [frameSink] 非空时才启用帧分析，避免 Mock 模式下做无谓的像素拷贝；
 * - 全程容错：相机不可用 / 绑定失败时不崩溃，显示占位。
 */
@Composable
fun CameraPreview(
    enabled: Boolean,
    sessionId: String,
    frameSink: FrameSink?,
    modifier: Modifier = Modifier,
    lensFacing: Int = CameraSelector.LENS_FACING_BACK,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    if (!enabled) {
        CameraPlaceholder(text = "摄像头未开启（需授予相机权限）", modifier = modifier)
        return
    }

    val previewView = remember {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }

    // enabled / sessionId / frameSink / lensFacing 变化时重新绑定；离开时解绑并关闭分析线程。
    DisposableEffect(enabled, sessionId, frameSink, lensFacing) {
        cameraProviderFuture.addListener({
            runCatching {
                val provider = cameraProviderFuture.get()
                bindUseCases(provider, lifecycleOwner, previewView, frameSink, analysisExecutor, sessionId, lensFacing)
            }
        }, mainExecutor)

        onDispose {
            runCatching { cameraProviderFuture.get().unbindAll() }
            analysisExecutor.shutdown()
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

/** 占位视图：无权限 / 相机不可用时展示，对齐 first-aid MockCameraFallback。 */
@Composable
private fun CameraPlaceholder(text: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(com.example.cpr_new.ui.CoachPalette.CameraFallback),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(width = 220.dp, height = 320.dp)
                .background(com.example.cpr_new.ui.CoachPalette.CameraFrame, RoundedCornerShape(120.dp))
                .border(2.dp, com.example.cpr_new.ui.CoachPalette.CameraBorder, RoundedCornerShape(120.dp)),
        )
        Spacer(Modifier.height(18.dp))
        Text(text = text, color = com.example.cpr_new.ui.CoachPalette.TextSecondary, fontSize = 14.sp)
    }
}

/** 绑定预览（始终）+ 帧分析（仅当有 sink）。 */
private fun bindUseCases(
    provider: ProcessCameraProvider,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
    previewView: PreviewView,
    frameSink: FrameSink?,
    analysisExecutor: java.util.concurrent.Executor,
    sessionId: String,
    lensFacing: Int,
) {
    val preview = Preview.Builder().build().also {
        it.surfaceProvider = previewView.surfaceProvider
    }

    val useCases = mutableListOf<UseCase>(preview)

    if (frameSink != null) {
        val analysis = ImageAnalysis.Builder()
            // 推理慢时丢旧帧而非堆积，保证实时性（对应 CameraInputSpec.keepOnlyLatest）。
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(analysisExecutor) { proxy ->
            forwardFrame(proxy, sessionId, frameSink)
        }
        useCases.add(analysis)
    }

    val cameraSelector = CameraSelector.Builder()
        .requireLensFacing(lensFacing)
        .build()

    provider.unbindAll()
    runCatching {
        provider.bindToLifecycle(
            lifecycleOwner,
            cameraSelector,
            *useCases.toTypedArray(),
        )
    }
}

/**
 * 把一帧转成字节并交给第 3 部分。务必 close 以释放缓冲。
 *
 * 按 planes rowStride 正确转换；像素格式通过 [FrameMeta.format] 告知接收方。
 */
private fun forwardFrame(proxy: ImageProxy, sessionId: String, sink: FrameSink) {
    runCatching {
        val nv21 = proxy.toNv21()
        sink.onFrame(
            frame = nv21,
            meta = FrameMeta(
                width = proxy.width,
                height = proxy.height,
                rotationDegrees = proxy.imageInfo.rotationDegrees,
                format = CameraInputSpec.PIXEL_FORMAT_NV21,
                timestampMs = SystemClock.elapsedRealtime(),
                sessionId = sessionId,
            ),
        )
    }
    proxy.close()
}
