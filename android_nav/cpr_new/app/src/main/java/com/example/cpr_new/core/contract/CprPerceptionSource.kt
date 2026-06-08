package com.example.cpr_new.core.contract

import kotlinx.coroutines.flow.Flow

/**
 * 感知源接口（由第 3 部分实现，第 4 部分消费）。
 *
 * 第 4 部分提供的“接入点”：Android 端负责打开摄像头/麦克风并把帧喂给实现方，
 * 实现方通过 [events] 持续吐出 [PerceptionEvent]。
 *
 * 可扩展性：
 * - 真实实现（基于第 3 部分模型）与 Mock 实现都满足此接口，可在 ServiceLocator 中一键替换；
 * - 摄像头/麦克风的具体采集可由实现方自管，也可由第 4 部分注入帧（见 [FrameSink]）。
 */
interface CprPerceptionSource {
    /** 持续输出的感知事件流。冷流，订阅后才开始产出。 */
    val events: Flow<PerceptionEvent>

    /**
     * 启动感知（如加载模型、开始推理）。应可重复调用且幂等。
     * @param sessionId 本次会话 id，由 Android 下发；实现方需回填到每条 [PerceptionEvent]。
     */
    fun start(sessionId: String)

    /** 停止感知并释放资源。 */
    fun stop()

    /** 当前是否就绪（模型已加载）。用于 UI 显示“正在加载模型…”兜底。 */
    val isReady: Boolean
}

/**
 * 可选的帧注入接口：当第 4 部分（Android）统一管理 CameraX 取流时，
 * 把图像帧推送给感知实现。实现方按需选择是否支持。
 *
 * 注意：这里用通用的 [ByteArray] + 元数据来避免 Android 端与算法端的类型耦合，
 * 具体编码格式（如 NV21 / YUV）由双方在 [FrameMeta.format] 中约定。
 */
interface FrameSink {
    fun onFrame(frame: ByteArray, meta: FrameMeta)
}

data class FrameMeta(
    /** 帧宽（像素）。width × height 即分辨率 resolution，不单设字段避免不一致。 */
    val width: Int,
    /** 帧高（像素）。 */
    val height: Int,
    /** 画面旋转角（0/90/180/270）。由算法侧据此旋正，Android 不预旋转。 */
    val rotationDegrees: Int,
    /** 像素格式，取值见 [CameraInputSpec]（默认 YUV_420_888）。 */
    val format: String,
    /** 帧时间戳（毫秒，单调时钟，见 [CameraInputSpec.TIMESTAMP_CLOCK]）。 */
    val timestampMs: Long,
    /** 所属会话 id，与 [PerceptionEvent.sessionId] 对齐。 */
    val sessionId: String,
)
