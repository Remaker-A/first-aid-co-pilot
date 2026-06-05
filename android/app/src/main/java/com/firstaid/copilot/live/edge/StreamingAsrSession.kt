package com.firstaid.copilot.live.edge

import android.content.Context
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

sealed interface StreamingAsrEvent {
    data class Partial(val text: String) : StreamingAsrEvent

    data class Final(
        val text: String,
        val intent: String? = null,
        val confidence: Float? = null,
    ) : StreamingAsrEvent

    object Endpoint : StreamingAsrEvent

    data class Error(
        val message: String,
        val cause: Throwable? = null,
    ) : StreamingAsrEvent
}

interface StreamingAsrSession : AutoCloseable {
    val available: Boolean
    val sampleRateHz: Int
    val frameDurationMs: IntRange
    val events: Flow<StreamingAsrEvent>

    fun start(): List<StreamingAsrEvent> = reset()
    fun feedPcm(pcm16Frame: ByteArray): List<StreamingAsrEvent> = acceptPcm16Frame(pcm16Frame)
    fun end(): List<StreamingAsrEvent> = finish()

    fun acceptPcm16Frame(pcm16Frame: ByteArray): List<StreamingAsrEvent>
    fun finish(): List<StreamingAsrEvent>
    fun reset(): List<StreamingAsrEvent>
}

class SherpaStreamingAsrSession internal constructor(
    private val recognizer: SherpaOnlineRecognizerBridge,
    override val sampleRateHz: Int = STREAMING_ASR_SAMPLE_RATE_HZ,
    override val frameDurationMs: IntRange = STREAMING_ASR_FRAME_DURATION_MS,
    private val maxDecodeIterationsPerFrame: Int = STREAMING_ASR_MAX_DECODE_ITERATIONS_PER_FRAME,
    private val maxDecodeIterationsOnFinish: Int = STREAMING_ASR_MAX_DECODE_ITERATIONS_ON_FINISH,
) : StreamingAsrSession {
    override val available: Boolean = true
    private val _events = MutableSharedFlow<StreamingAsrEvent>(
        replay = 0,
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val events: Flow<StreamingAsrEvent> = _events.asSharedFlow()

    private val lock = Any()
    private var stream: Any? = null
    private var closed = false
    private var lastPartialText = ""

    override fun acceptPcm16Frame(pcm16Frame: ByteArray): List<StreamingAsrEvent> {
        val nextEvents = synchronized(lock) {
            if (closed) {
                return@synchronized listOf(StreamingAsrEvent.Error("ASR streaming session is closed"))
            }
            validatePcm16Frame(pcm16Frame)?.let { error ->
                return@synchronized listOf(StreamingAsrEvent.Error(error))
            }
            runCatching {
                val currentStream = activeStream()
                recognizer.acceptWaveform(currentStream, sherpaPcm16ToFloat32(pcm16Frame), sampleRateHz)
                collectEvents(currentStream, forceFinal = false)
            }.getOrElse { error ->
                listOf(StreamingAsrEvent.Error(sherpaEdgeErrorDetail(error, "ASR streaming failed"), error))
            }
        }
        publish(nextEvents)
        return nextEvents
    }

    override fun finish(): List<StreamingAsrEvent> {
        val nextEvents = synchronized(lock) {
            if (closed) {
                return@synchronized listOf(StreamingAsrEvent.Error("ASR streaming session is closed"))
            }
            runCatching {
                val currentStream = activeStream()
                recognizer.inputFinished(currentStream)
                collectEvents(currentStream, forceFinal = true)
            }.getOrElse { error ->
                listOf(StreamingAsrEvent.Error(sherpaEdgeErrorDetail(error, "ASR streaming finish failed"), error))
            }
        }
        publish(nextEvents)
        return nextEvents
    }

    override fun reset(): List<StreamingAsrEvent> {
        val nextEvents = synchronized(lock) {
            if (closed) {
                return@synchronized listOf(StreamingAsrEvent.Error("ASR streaming session is closed"))
            }
            runCatching {
                stream?.let(recognizer::reset)
                lastPartialText = ""
                emptyList<StreamingAsrEvent>()
            }.getOrElse { error ->
                listOf(StreamingAsrEvent.Error(sherpaEdgeErrorDetail(error, "ASR streaming reset failed"), error))
            }
        }
        publish(nextEvents)
        return nextEvents
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            stream?.let(recognizer::releaseStream)
            stream = null
            recognizer.close()
            closed = true
            lastPartialText = ""
        }
    }

    private fun activeStream(): Any =
        stream ?: recognizer.createStream().also { stream = it }

    private fun publish(nextEvents: List<StreamingAsrEvent>) {
        nextEvents.forEach { _events.tryEmit(it) }
    }

    private fun collectEvents(currentStream: Any, forceFinal: Boolean): List<StreamingAsrEvent> {
        val events = mutableListOf<StreamingAsrEvent>()
        val maxIterations = if (forceFinal) maxDecodeIterationsOnFinish else maxDecodeIterationsPerFrame
        drainDecode(currentStream, maxIterations)

        val result = recognizer.getResult(currentStream)
        val text = result.text.trim()
        val endpoint = forceFinal || recognizer.isEndpoint(currentStream)
        if (!endpoint && text.isNotEmpty() && text != lastPartialText) {
            events += StreamingAsrEvent.Partial(text)
            lastPartialText = text
        }

        if (endpoint) {
            if (text.isNotEmpty() || lastPartialText.isNotEmpty()) {
                events += StreamingAsrEvent.Final(
                    text = text.ifEmpty { lastPartialText },
                    intent = null,
                    confidence = result.confidence,
                )
            }
            events += StreamingAsrEvent.Endpoint
            recognizer.reset(currentStream)
            lastPartialText = ""
        }
        return events
    }

    private fun drainDecode(currentStream: Any, maxIterations: Int) {
        var guard = 0
        while (recognizer.isReady(currentStream) && guard < maxIterations) {
            recognizer.decode(currentStream)
            guard += 1
        }
    }

    private fun validatePcm16Frame(pcm16Frame: ByteArray): String? {
        if (pcm16Frame.isEmpty()) {
            return "PCM16 ASR frame is empty"
        }
        if (pcm16Frame.size % BYTES_PER_PCM16_SAMPLE != 0) {
            return "PCM16 ASR frame must contain whole little-endian 16-bit samples"
        }
        val samples = pcm16Frame.size / BYTES_PER_PCM16_SAMPLE
        val durationMs = samples * 1000.0 / sampleRateHz
        if (durationMs < frameDurationMs.first || durationMs > frameDurationMs.last) {
            return "PCM16 ASR frame must be ${frameDurationMs.first}-${frameDurationMs.last}ms at ${sampleRateHz}Hz; got ${"%.1f".format(durationMs)}ms"
        }
        return null
    }

    companion object {
        fun open(
            asrFiles: StreamingAsrFiles,
            numThreads: Int = 2,
            sampleRateHz: Int = STREAMING_ASR_SAMPLE_RATE_HZ,
            trace: (String) -> Unit = {},
        ): SherpaStreamingAsrSession {
            require(sampleRateHz == STREAMING_ASR_SAMPLE_RATE_HZ) {
                "Sherpa streaming ASR is configured for ${STREAMING_ASR_SAMPLE_RATE_HZ}Hz PCM"
            }
            val nativeRecognizer = createSherpaOnlineRecognizer(asrFiles, numThreads, trace)
            return SherpaStreamingAsrSession(
                recognizer = ReflectiveSherpaOnlineRecognizerBridge(nativeRecognizer),
                sampleRateHz = sampleRateHz,
            )
        }
    }
}

fun buildSherpaStreamingAsrSession(context: Context, numThreads: Int = 2): StreamingAsrSession {
    val files = EdgeModelPathResolver(defaultEdgeModelRoots(context)).resolve()
    val asrFiles = files.asr
        ?: return UnavailableStreamingAsrSession("ASR model files are missing")
    if (!sherpaClassAvailable("com.k2fsa.sherpa.onnx.OnlineRecognizer")) {
        return UnavailableStreamingAsrSession("sherpa-onnx AAR is not packaged")
    }
    return runCatching {
        SherpaStreamingAsrSession.open(asrFiles, numThreads)
    }.getOrElse { error ->
        UnavailableStreamingAsrSession(sherpaEdgeErrorDetail(error, "ASR streaming session failed to open"))
    }
}

internal data class StreamingAsrNativeResult(
    val text: String,
    val confidence: Float?,
)

internal interface SherpaOnlineRecognizerBridge : AutoCloseable {
    fun createStream(): Any
    fun acceptWaveform(stream: Any, samples: FloatArray, sampleRateHz: Int)
    fun inputFinished(stream: Any)
    fun isReady(stream: Any): Boolean
    fun decode(stream: Any)
    fun isEndpoint(stream: Any): Boolean
    fun getResult(stream: Any): StreamingAsrNativeResult
    fun reset(stream: Any)
    fun releaseStream(stream: Any)
}

private class ReflectiveSherpaOnlineRecognizerBridge(
    private val recognizer: Any,
) : SherpaOnlineRecognizerBridge {
    override fun createStream(): Any =
        recognizer.sherpaCall("createStream", "")
            ?: throw IllegalStateException("sherpa-onnx did not create an ASR stream")

    override fun acceptWaveform(stream: Any, samples: FloatArray, sampleRateHz: Int) {
        stream.sherpaCall("acceptWaveform", samples, sampleRateHz)
    }

    override fun inputFinished(stream: Any) {
        stream.sherpaCall("inputFinished")
    }

    override fun isReady(stream: Any): Boolean =
        recognizer.sherpaCall("isReady", stream) as? Boolean ?: false

    override fun decode(stream: Any) {
        recognizer.sherpaCall("decode", stream)
    }

    override fun isEndpoint(stream: Any): Boolean =
        recognizer.sherpaCall("isEndpoint", stream) as? Boolean ?: false

    override fun getResult(stream: Any): StreamingAsrNativeResult {
        val result = recognizer.sherpaCall("getResult", stream)
            ?: throw IllegalStateException("sherpa-onnx returned no ASR result")
        return StreamingAsrNativeResult(
            text = result.sherpaCall("getText") as? String ?: "",
            confidence = averageConfidence(result.sherpaCall("getYsProbs") as? FloatArray),
        )
    }

    override fun reset(stream: Any) {
        recognizer.sherpaCall("reset", stream)
    }

    override fun releaseStream(stream: Any) {
        stream.sherpaCallQuietly("release")
    }

    override fun close() {
        recognizer.sherpaCallQuietly("release")
    }
}

private class UnavailableStreamingAsrSession(
    private val message: String,
) : StreamingAsrSession {
    override val available: Boolean = false
    override val sampleRateHz: Int = STREAMING_ASR_SAMPLE_RATE_HZ
    override val frameDurationMs: IntRange = STREAMING_ASR_FRAME_DURATION_MS
    private val _events = MutableSharedFlow<StreamingAsrEvent>(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val events: Flow<StreamingAsrEvent> = _events.asSharedFlow()

    override fun acceptPcm16Frame(pcm16Frame: ByteArray): List<StreamingAsrEvent> =
        publishError()

    override fun finish(): List<StreamingAsrEvent> =
        publishError()

    override fun reset(): List<StreamingAsrEvent> =
        emptyList()

    override fun close() = Unit

    private fun publishError(): List<StreamingAsrEvent> {
        val events = listOf(StreamingAsrEvent.Error(message))
        events.forEach { _events.tryEmit(it) }
        return events
    }
}

internal fun averageConfidence(ysProbs: FloatArray?): Float? {
    if (ysProbs == null || ysProbs.isEmpty()) return null
    val valid = ysProbs.filter { it.isFinite() && it >= 0f }
    if (valid.isEmpty()) return null
    return valid.average().toFloat().coerceIn(0f, 1f)
}

private const val BYTES_PER_PCM16_SAMPLE = 2
internal const val STREAMING_ASR_SAMPLE_RATE_HZ = 16_000
internal val STREAMING_ASR_FRAME_DURATION_MS = 20..40
private const val STREAMING_ASR_MAX_DECODE_ITERATIONS_PER_FRAME = 64
private const val STREAMING_ASR_MAX_DECODE_ITERATIONS_ON_FINISH = 4096
