package com.firstaid.copilot.live.vision.cpr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
import java.io.ByteArrayOutputStream

class CprVisionAnalyzer(
    context: Context,
    private val onMetrics: (Map<String, Any?>) -> Unit,
    private val onUnavailable: (String) -> Unit,
    private val cameraFacing: VisionCameraFacing = VisionCameraFacing.Front,
    private val cameraMount: VisionCameraMount = VisionCameraMount.SideFixed,
    private val mirrored: Boolean = cameraFacing == VisionCameraFacing.Front,
    private val deriver: CprMetricsDeriver = CprMetricsDeriver(
        CprMetricsDeriver.Options(mirrorX = mirrored),
    ),
    private val minFrameIntervalMs: Long = 80L,
) : ImageAnalysis.Analyzer, AutoCloseable {
    private val appContext = context.applicationContext
    private var landmarker: PoseLandmarker? = null
    private var lastSubmittedTimestampMs: Long = Long.MIN_VALUE
    private var unavailableReported = false

    init {
        landmarker = createLandmarker()
    }

    override fun analyze(image: ImageProxy) {
        val poseLandmarker = landmarker
        if (poseLandmarker == null) {
            image.close()
            return
        }

        val rawTimestampMs = image.imageInfo.timestamp / NANOS_PER_MILLI
        val timestampMs = if (lastSubmittedTimestampMs == Long.MIN_VALUE) {
            rawTimestampMs
        } else {
            maxOf(rawTimestampMs, lastSubmittedTimestampMs + 1)
        }
        if (lastSubmittedTimestampMs != Long.MIN_VALUE &&
            timestampMs - lastSubmittedTimestampMs < minFrameIntervalMs
        ) {
            image.close()
            return
        }

        runCatching {
            val bitmap = image.toBitmapCompat()
            val mpImage = BitmapImageBuilder(bitmap).build()
            lastSubmittedTimestampMs = timestampMs
            poseLandmarker.detectAsync(mpImage, timestampMs)
        }.onFailure {
            reportUnavailable("姿态分析失败：${it.message ?: it.javaClass.simpleName}")
        }
        image.close()
    }

    override fun close() {
        landmarker?.close()
        landmarker = null
    }

    private fun createLandmarker(): PoseLandmarker? {
        if (!assetExists(MODEL_ASSET_NAME)) {
            reportUnavailable("缺少姿态模型 assets/$MODEL_ASSET_NAME，仅保留相机预览，不上报实时识别。")
            return null
        }

        return runCatching {
            val baseOptions = BaseOptions.builder()
                .setModelAssetPath(MODEL_ASSET_NAME)
                .build()
            val options = PoseLandmarker.PoseLandmarkerOptions.builder()
                .setBaseOptions(baseOptions)
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setNumPoses(1)
                .setMinPoseDetectionConfidence(0.5f)
                .setMinPosePresenceConfidence(0.5f)
                .setMinTrackingConfidence(0.5f)
                .setResultListener { result, _ -> handleResult(result) }
                .setErrorListener { error ->
                    reportUnavailable("姿态模型运行错误：${error.message ?: error.javaClass.simpleName}")
                }
                .build()
            PoseLandmarker.createFromOptions(appContext, options)
        }.onFailure {
            reportUnavailable("姿态模型初始化失败：${it.message ?: it.javaClass.simpleName}")
        }.getOrNull()
    }

    private fun handleResult(result: PoseLandmarkerResult) {
        val pose = result.landmarks().firstOrNull()
        if (pose.isNullOrEmpty()) return
        val landmarks = pose.map { landmark ->
            CprLandmark(
                x = landmark.x().toDouble(),
                y = landmark.y().toDouble(),
                visibility = landmark.visibility().orElse(0f).toDouble(),
            )
        }
        val metrics = deriver.update(landmarks, result.timestampMs()) ?: return
        onMetrics(
            metrics.toCprQualityMap() + mapOf(
                "camera_facing" to cameraFacing.eventValue,
                "camera_mount" to cameraMount.eventValue,
                "mirrored" to mirrored,
            ),
        )
    }

    private fun assetExists(assetName: String): Boolean =
        runCatching {
            appContext.assets.open(assetName).use { }
        }.isSuccess

    private fun reportUnavailable(message: String) {
        if (unavailableReported) return
        unavailableReported = true
        onUnavailable(message)
    }

    companion object {
        const val MODEL_ASSET_NAME = "pose_landmarker_lite.task"
        private const val NANOS_PER_MILLI = 1_000_000L
    }
}

private fun ImageProxy.toBitmapCompat(): Bitmap {
    val nv21 = toNv21()
    val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
    val jpeg = ByteArrayOutputStream()
    yuvImage.compressToJpeg(Rect(0, 0, width, height), 90, jpeg)
    val bytes = jpeg.toByteArray()
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}

private fun ImageProxy.toNv21(): ByteArray {
    val yPlane = planes[0]
    val uPlane = planes[1]
    val vPlane = planes[2]
    val ySize = width * height
    val nv21 = ByteArray(ySize + ySize / 2)

    var outputOffset = 0
    val yBuffer = yPlane.buffer
    for (row in 0 until height) {
        yBuffer.position(row * yPlane.rowStride)
        yBuffer.get(nv21, outputOffset, width)
        outputOffset += width
    }

    val uBuffer = uPlane.buffer
    val vBuffer = vPlane.buffer
    val chromaHeight = height / 2
    val chromaWidth = width / 2
    for (row in 0 until chromaHeight) {
        for (col in 0 until chromaWidth) {
            val vuOffset = ySize + row * width + col * 2
            nv21[vuOffset] = vBuffer.get(row * vPlane.rowStride + col * vPlane.pixelStride)
            nv21[vuOffset + 1] = uBuffer.get(row * uPlane.rowStride + col * uPlane.pixelStride)
        }
    }

    return nv21
}
