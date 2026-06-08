package com.example.cpr_new.core.contract

/**
 * 摄像头输入规格约定（Android 第 4 部分 -> 第 3 部分感知）。
 *
 * 这是“Android 喂给感知算法的图像帧长什么样”的**唯一真相源**：
 * - Android 端 CameraX 取流时按本规格配置；
 * - 第 3 部分按本规格解析帧；
 * - 文档 `docs/04-android/07-接口对接约定.md` 直接引用这里的默认值。
 *
 * 全部带默认值，可在 [ServiceLocator] 或相机初始化时按设备/模型需要覆盖，
 * 不改动接口即可调参（可扩展）。
 *
 * 说明：分辨率（resolution）= [analysisWidth] × [analysisHeight]，
 * 不单独设字段，避免与宽高重复、产生不一致。
 */
data class CameraInputSpec(
    /** 分析流宽（像素）。默认 640。 */
    val analysisWidth: Int = 640,
    /** 分析流高（像素）。默认 480。640×480 对 CPR 姿态识别足够且低延迟。 */
    val analysisHeight: Int = 480,
    /** 采集帧率（fps）。默认 30。 */
    val captureFps: Int = 30,
    /**
     * 送入算法的分析帧率（fps）。默认 15。
     * 按压约 2Hz，15fps 足够；过高只增加功耗与发热。
     */
    val analysisFps: Int = 15,
    /** 像素格式。默认 YUV_420_888（CameraX 原生，零拷贝最省）。 */
    val pixelFormat: String = PIXEL_FORMAT_YUV_420_888,
    /**
     * 是否只保留最新帧（CameraX STRATEGY_KEEP_ONLY_LATEST）。
     * 默认 true：推理慢时丢旧帧而非堆积，保证实时性。
     */
    val keepOnlyLatest: Boolean = true,
) {
    /** 人类可读的分辨率标签，如 "640x480"。 */
    val resolutionLabel: String get() = "${analysisWidth}x$analysisHeight"

    companion object {
        /** CameraX `ImageAnalysis` 原生输出，推荐首选。 */
        const val PIXEL_FORMAT_YUV_420_888 = "YUV_420_888"

        /** 备选：部分传统 CV 模型需要 NV21（需算法侧或工具转换）。 */
        const val PIXEL_FORMAT_NV21 = "NV21"

        /**
         * 时间戳时钟源约定：统一使用单调时钟（毫秒）。
         * Android 端建议 `SystemClock.elapsedRealtime()`，**禁止**混用 wall-clock，
         * 避免对时漂移导致帧/事件错位。
         */
        const val TIMESTAMP_CLOCK = "SystemClock.elapsedRealtime() (monotonic, ms)"

        /** 推荐默认规格，联调时直接用这个。 */
        val DEFAULT = CameraInputSpec()
    }
}
