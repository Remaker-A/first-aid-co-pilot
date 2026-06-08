package com.example.cpr_new.hardware.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

/**
 * CPR 音频节拍器（click），对齐 first-aid 契约里的 haptic/metronome。
 *
 * 使用 USAGE_MEDIA 保证静音模式下仍可听见；TTS 播报时通过 [setDucked] 降低音量。
 * 启动后本地自持，不依赖每轮 HTTP 消息。
 */
class AudioMetronomeController {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var runningBpm: Int? = null
    private var ducked = false
    private var track: AudioTrack? = null
    private var loopJob: Job? = null

    val isRunning: Boolean get() = runningBpm != null
    val currentBpm: Int? get() = runningBpm

    fun start(bpm: Int = DEFAULT_BPM) {
        val target = bpm.coerceIn(MIN_BPM, MAX_BPM)
        if (runningBpm == target) return
        stopInternal()
        runningBpm = target
        val intervalMs = (60_000L / target).coerceAtLeast(MIN_INTERVAL_MS)
        val click = buildClickPcm(SAMPLE_RATE)
        val newTrack = runCatching { buildTrack(click.size) }.getOrNull() ?: return
        track = newTrack
        runCatching {
            newTrack.setVolume(currentVolume())
            newTrack.play()
        }
        loopJob = scope.launch {
            val intervalNanos = intervalMs * 1_000_000
            val startNanos = System.nanoTime()
            var beat = 0L
            while (isActive) {
                runCatching { newTrack.write(click, 0, click.size) }
                beat++
                val targetNanos = startNanos + beat * intervalNanos
                val sleepMs = (targetNanos - System.nanoTime()) / 1_000_000
                if (sleepMs > 0) delay(sleepMs)
            }
        }
    }

    fun updateBpm(bpm: Int) = start(bpm)

    fun setDucked(ducked: Boolean) {
        if (this.ducked == ducked) return
        this.ducked = ducked
        runCatching { track?.setVolume(currentVolume()) }
    }

    fun stop() {
        runningBpm = null
        stopInternal()
    }

    fun release() {
        stop()
        scope.cancel()
    }

    private fun stopInternal() {
        loopJob?.cancel()
        loopJob = null
        val current = track
        track = null
        runCatching { current?.pause() }
        runCatching { current?.flush() }
        runCatching { current?.stop() }
        runCatching { current?.release() }
    }

    private fun currentVolume(): Float = if (ducked) DUCKED_VOLUME else FULL_VOLUME

    private fun buildTrack(clickBytes: Int): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, PCM_FORMAT)
            .coerceAtLeast(clickBytes * 2)
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(PCM_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build(),
            )
            .setBufferSizeInBytes(minBuffer)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    companion object {
        const val DEFAULT_BPM = 110
        const val MIN_BPM = 40
        const val MAX_BPM = 200
        const val FULL_VOLUME = 1.0f
        const val DUCKED_VOLUME = 0.3f

        private const val SAMPLE_RATE = 44_100
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO
        private const val PCM_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val CLICK_MS = 40
        private const val MIN_INTERVAL_MS = 250L
        private const val CLICK_FREQ_HZ = 2_000.0
        private const val CLICK_DECAY = 5.0
        private const val CLICK_GAIN = 0.6

        private fun buildClickPcm(sampleRate: Int): ByteArray {
            val samples = (sampleRate * CLICK_MS / 1000).coerceAtLeast(1)
            val pcm = ByteArray(samples * 2)
            val buffer = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until samples) {
                val progress = i.toDouble() / samples
                val envelope = exp(-CLICK_DECAY * progress)
                val tone = sin(2.0 * PI * CLICK_FREQ_HZ * i / sampleRate)
                val value = (tone * envelope * CLICK_GAIN * Short.MAX_VALUE)
                    .toInt()
                    .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                buffer.putShort(value.toShort())
            }
            return pcm
        }
    }
}
