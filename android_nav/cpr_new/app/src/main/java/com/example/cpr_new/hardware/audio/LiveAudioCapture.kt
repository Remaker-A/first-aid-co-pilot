package com.example.cpr_new.hardware.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/**
 * 16kHz 单声道 PCM 采集，带简易 VAD，用于 `/ws/live` 半双工语音。
 *
 * TTS/服务端音频播放期间暂停采集（[setTtsSpeaking]），避免回声。
 */
class LiveAudioCapture {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    private val ttsSpeaking = AtomicBoolean(false)
    private var recorder: AudioRecord? = null

    fun start(
        onPcmChunk: (ByteArray) -> Unit,
        onBargeIn: () -> Unit,
        onError: (String) -> Unit,
        onLevel: ((Float) -> Unit)? = null,
        onUtteranceEnd: (() -> Unit)? = null,
    ) {
        if (!running.compareAndSet(false, true)) return
        scope.launch {
            runCatching { captureLoop(onPcmChunk, onBargeIn, onLevel, onUtteranceEnd) }
                .onFailure {
                    running.set(false)
                    onError(it.message ?: "麦克风采集失败")
                }
        }
    }

    fun pause() = paused.set(true)

    fun resume() = paused.set(false)

    fun setTtsSpeaking(speaking: Boolean) = ttsSpeaking.set(speaking)

    fun stop() {
        running.set(false)
        recorder?.runCatching { stop(); release() }
        recorder = null
    }

    fun release() {
        stop()
        scope.cancel()
    }

    @SuppressLint("MissingPermission")
    private suspend fun captureLoop(
        onPcmChunk: (ByteArray) -> Unit,
        onBargeIn: () -> Unit,
        onLevel: ((Float) -> Unit)?,
        onUtteranceEnd: (() -> Unit)?,
    ) {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, PCM_FORMAT)
            .coerceAtLeast(FRAME_SAMPLES * BYTES_PER_SAMPLE * 4)
        val audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            PCM_FORMAT,
            minBuffer,
        )
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            error("AudioRecord 初始化失败")
        }
        recorder = audioRecord

        val readBuffer = ShortArray(FRAME_SAMPLES)
        var silenceMs = 0
        var voicedMs = 0
        var voiceActive = false
        var bargeInSent = false
        var bargeInVoicedMs = 0

        try {
            audioRecord.startRecording()
            while (running.get()) {
                if (paused.get()) {
                    delay(50)
                    continue
                }
                val count = audioRecord.read(readBuffer, 0, readBuffer.size)
                if (count <= 0) continue

                val frameMs = (count * 1000 / SAMPLE_RATE).coerceAtLeast(1)
                val framePcm = readBuffer.toPcmBytes(count)
                val rms = readBuffer.rms(count)
                onLevel?.invoke(rms.coerceIn(0f, 0.25f) / 0.25f)

                if (ttsSpeaking.get()) {
                    if (rms >= BARGE_IN_RMS) {
                        bargeInVoicedMs += frameMs
                        if (!bargeInSent && bargeInVoicedMs >= BARGE_IN_SPEECH_MS) {
                            bargeInSent = true
                            onBargeIn()
                        }
                    } else {
                        bargeInVoicedMs = 0
                    }
                    continue
                }

                bargeInVoicedMs = 0
                onPcmChunk(framePcm)

                val speech = rms >= LISTENING_RMS
                if (speech) {
                    silenceMs = 0
                    voicedMs += frameMs
                    if (voicedMs >= MIN_UTTERANCE_MS) voiceActive = true
                } else if (voiceActive) {
                    silenceMs += frameMs
                } else {
                    voicedMs = 0
                }

                if (voiceActive && silenceMs >= COMMIT_SILENCE_MS) {
                    voiceActive = false
                    silenceMs = 0
                    voicedMs = 0
                    bargeInSent = false
                    onUtteranceEnd?.invoke()
                }
            }
        } finally {
            audioRecord.runCatching { stop(); release() }
            recorder = null
        }
    }

    private fun ShortArray.rms(count: Int): Float {
        var sum = 0.0
        for (i in 0 until count) {
            val n = this[i] / Short.MAX_VALUE.toDouble()
            sum += n * n
        }
        return sqrt(sum / count).toFloat()
    }

    private fun ShortArray.toPcmBytes(count: Int): ByteArray {
        val pcm = ByteArray(count * BYTES_PER_SAMPLE)
        ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(this, 0, count)
        return pcm
    }

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val BYTES_PER_SAMPLE = 2
        private const val FRAME_MS = 40
        private const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
        private const val LISTENING_RMS = 0.035f
        private const val BARGE_IN_RMS = 0.08f
        private const val BARGE_IN_SPEECH_MS = 320
        private const val MIN_UTTERANCE_MS = 250
        private const val COMMIT_SILENCE_MS = 650
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val PCM_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }
}
