package com.firstaid.copilot.live.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * Playback side of the `/ws/live` server-audio contract.
 *
 * The WebSocket emits `audio_begin` metadata, binary PCM frames, then
 * `audio_end` or `audio_cancel`. This class owns the small state machine for
 * those events while delegating real audio I/O to [LiveAudioSink], so queue and
 * cancel behavior stays JVM-testable without constructing Android framework
 * classes.
 */
class LiveAudioPlayer internal constructor(
    private val sinkFactory: LiveAudioSinkFactory,
    private val clockMs: () -> Long,
    private val logger: LiveAudioLogger,
) {
    constructor() : this(
        sinkFactory = AndroidLiveAudioSinkFactory(),
        clockMs = { SystemClock.elapsedRealtime() },
        logger = AndroidLiveAudioLogger,
    )

    private var active: ActiveStream? = null
    private var drainingSink: LiveAudioSink? = null

    @Synchronized
    fun onAudioBegin(metadata: LiveAudioMetadata) {
        releaseDrainingSink()
        active?.let { previous ->
            logger.warn("Replacing unfinished live audio stream ${previous.metadata.logId}")
            previous.sink.flushAndStop()
            previous.sink.release()
        }
        active = null

        if (!metadata.isPlayablePcm16Mono()) {
            logger.warn(
                "Ignoring unsupported live audio stream ${metadata.logId}: " +
                    "format=${metadata.format}, channels=${metadata.channels}, " +
                    "bits=${metadata.bitsPerSample}, sampleRate=${metadata.sampleRateHz}",
            )
            return
        }

        if (metadata.flushQueue) {
            logger.info("Live audio begin requested queue flush for ${metadata.logId}")
        }

        active = ActiveStream(
            metadata = metadata,
            sink = sinkFactory.create(metadata),
            beganAtMs = clockMs(),
        )
    }

    @Synchronized
    fun onPcmChunk(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val stream = active
        if (stream == null) {
            logger.warn("Dropping ${bytes.size} live audio bytes without audio_begin")
            return
        }
        if (!stream.started) {
            stream.sink.start()
            stream.started = true
            logger.info(
                "Live audio start latency=${clockMs() - stream.beganAtMs}ms " +
                    "sampleRate=${stream.metadata.sampleRateHz} stream=${stream.metadata.logId}",
            )
        }
        val written = stream.sink.writePcm(bytes)
        if (written < bytes.size) {
            logger.warn("Live audio short write $written/${bytes.size} stream=${stream.metadata.logId}")
        }
    }

    @Synchronized
    fun onAudioEnd(actionId: String? = null) {
        val stream = active ?: return
        if (!stream.matches(actionId)) {
            logger.warn("Ignoring stale live audio_end actionId=$actionId active=${stream.metadata.logId}")
            return
        }
        stream.sink.finish()
        active = null
        releaseDrainingSink()
        drainingSink = stream.sink
        logger.info("Live audio ended stream=${stream.metadata.logId}")
    }

    @Synchronized
    fun onAudioCancel(reason: String? = null) {
        val stream = active
        active = null
        releaseDrainingSink()
        if (stream == null) {
            logger.info("Live audio cancel with no active stream reason=${reason.orEmpty()}")
            return
        }
        stream.sink.flushAndStop()
        stream.sink.release()
        logger.info("Live audio cancelled stream=${stream.metadata.logId} reason=${reason.orEmpty()}")
    }

    @Synchronized
    fun flushQueue() {
        onAudioCancel(reason = "flush_queue")
    }

    @Synchronized
    fun release() {
        active?.sink?.release()
        active = null
        releaseDrainingSink()
    }

    private fun releaseDrainingSink() {
        drainingSink?.release()
        drainingSink = null
    }

    private data class ActiveStream(
        val metadata: LiveAudioMetadata,
        val sink: LiveAudioSink,
        val beganAtMs: Long,
        var started: Boolean = false,
    ) {
        fun matches(actionId: String?): Boolean =
            actionId == null ||
                metadata.actionId == null ||
                actionId == metadata.actionId ||
                actionId == metadata.streamId
    }
}

data class LiveAudioMetadata(
    val streamId: String? = null,
    val sessionId: String? = null,
    val turnSeq: Long? = null,
    val actionId: String? = null,
    val format: String = FORMAT_PCM16,
    val sampleRateHz: Int = DEFAULT_SAMPLE_RATE_HZ,
    val channels: Int = DEFAULT_CHANNELS,
    val bitsPerSample: Int = DEFAULT_BITS_PER_SAMPLE,
    val flushQueue: Boolean = false,
) {
    val logId: String
        get() = actionId ?: streamId ?: "unknown"

    fun isPlayablePcm16Mono(): Boolean =
        format.equals(FORMAT_PCM16, ignoreCase = true) &&
            channels == DEFAULT_CHANNELS &&
            bitsPerSample == DEFAULT_BITS_PER_SAMPLE &&
            sampleRateHz in MIN_SAMPLE_RATE_HZ..MAX_SAMPLE_RATE_HZ

    companion object {
        const val FORMAT_PCM16 = "pcm16"
        const val DEFAULT_SAMPLE_RATE_HZ = 16_000
        const val DEFAULT_CHANNELS = 1
        const val DEFAULT_BITS_PER_SAMPLE = 16
        const val MIN_SAMPLE_RATE_HZ = 8_000
        const val MAX_SAMPLE_RATE_HZ = 48_000

        fun fromJson(json: JSONObject): LiveAudioMetadata =
            LiveAudioMetadata(
                streamId = json.stringOrNull("id") ?: json.stringOrNull("stream_id"),
                sessionId = json.stringOrNull("session_id") ?: json.stringOrNull("sessionId"),
                turnSeq = json.longOrNull("turn_seq") ?: json.longOrNull("turnSeq"),
                actionId = json.stringOrNull("action_id") ?: json.stringOrNull("actionId"),
                format = json.stringOrNull("format") ?: FORMAT_PCM16,
                sampleRateHz = json.positiveIntOrDefault(
                    DEFAULT_SAMPLE_RATE_HZ,
                    "sample_rate",
                    "sampleRate",
                    "sampleRateHz",
                ),
                channels = json.positiveIntOrDefault(DEFAULT_CHANNELS, "channels"),
                bitsPerSample = json.positiveIntOrDefault(
                    DEFAULT_BITS_PER_SAMPLE,
                    "bits_per_sample",
                    "bitsPerSample",
                ),
                flushQueue = json.booleanOrDefault(false, "flush_queue", "flushQueue"),
            )
    }
}

internal interface LiveAudioSinkFactory {
    fun create(metadata: LiveAudioMetadata): LiveAudioSink
}

internal interface LiveAudioSink {
    fun start()

    fun writePcm(bytes: ByteArray): Int

    fun finish()

    fun flushAndStop()

    fun release()
}

internal interface LiveAudioLogger {
    fun info(message: String)

    fun warn(message: String)
}

private object AndroidLiveAudioLogger : LiveAudioLogger {
    override fun info(message: String) {
        Log.i(TAG, message)
    }

    override fun warn(message: String) {
        Log.w(TAG, message)
    }
}

private class AndroidLiveAudioSinkFactory : LiveAudioSinkFactory {
    override fun create(metadata: LiveAudioMetadata): LiveAudioSink =
        AndroidPcm16MonoSink(metadata)
}

private class AndroidPcm16MonoSink(
    private val metadata: LiveAudioMetadata,
) : LiveAudioSink {
    private val track: AudioTrack = buildTrack(metadata.sampleRateHz)
    private var released = false

    override fun start() {
        if (released) return
        runCatching { track.play() }
    }

    override fun writePcm(bytes: ByteArray): Int {
        if (released) return 0
        return runCatching {
            track.write(bytes, 0, bytes.size, AudioTrack.WRITE_BLOCKING)
        }.getOrDefault(0)
    }

    override fun finish() {
        // Leave the AudioTrack playing so any already-buffered PCM can drain.
        // It is released on the next stream/cancel/release.
    }

    override fun flushAndStop() {
        if (released) return
        runCatching { track.pause() }
        runCatching { track.flush() }
        runCatching { track.stop() }
    }

    override fun release() {
        if (released) return
        flushAndStop()
        released = true
        runCatching { track.release() }
    }

    private fun buildTrack(sampleRateHz: Int): AudioTrack {
        val bytesPerFrame = LiveAudioMetadata.DEFAULT_CHANNELS * BYTES_PER_SAMPLE
        val minBuffer = AudioTrack.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).takeIf { it > 0 } ?: (sampleRateHz * bytesPerFrame / 2)
        val bufferSize = maxOf(minBuffer, sampleRateHz * bytesPerFrame / 5)

        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRateHz)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setBufferSizeInBytes(bufferSize)
            .build()
    }

    companion object {
        private const val BYTES_PER_SAMPLE = 2
    }
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf(String::isNotBlank) else null

private fun JSONObject.longOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key) else null

private fun JSONObject.positiveIntOrDefault(default: Int, vararg keys: String): Int =
    keys.firstNotNullOfOrNull { key ->
        if (has(key) && !isNull(key)) optInt(key).takeIf { it > 0 } else null
    } ?: default

private fun JSONObject.booleanOrDefault(default: Boolean, vararg keys: String): Boolean =
    keys.firstNotNullOfOrNull { key ->
        if (has(key) && !isNull(key)) optBoolean(key) else null
    } ?: default

private const val TAG = "LiveAudioPlayer"
