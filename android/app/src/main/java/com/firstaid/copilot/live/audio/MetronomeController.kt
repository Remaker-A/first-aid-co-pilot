package com.firstaid.copilot.live.audio

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import com.firstaid.copilot.live.HapticState
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MetronomeController(context: Context) {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Vibrator::class.java)
    }

    private var runningBpm: Int? = null

    fun apply(state: HapticState) {
        val bpm = state.bpm ?: DEFAULT_BPM
        if (!state.enabled) {
            stop()
            return
        }
        if (runningBpm == bpm) return
        runningBpm = bpm
        val intervalMs = (60_000L / bpm).coerceAtLeast(250L)
        val pulseMs = 70L
        vibrator?.vibrate(
            VibrationEffect.createWaveform(
                longArrayOf(0L, pulseMs, (intervalMs - pulseMs).coerceAtLeast(1L)),
                intArrayOf(0, 180, 0),
                0,
            ),
        )
    }

    fun stop() {
        runningBpm = null
        vibrator?.cancel()
    }

    companion object {
        private const val DEFAULT_BPM = 110
    }
}

class AndroidTextToSpeechEdge(
    context: Context,
    private val onSpeakingChanged: (Boolean) -> Unit,
) {
    private var ready = false
    private var lastUtteranceId: String? = null
    private val tts = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
    }

    init {
        tts.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    onSpeakingChanged(true)
                }

                override fun onDone(utteranceId: String?) {
                    onSpeakingChanged(false)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    onSpeakingChanged(false)
                }
            },
        )
    }

    fun speak(
        text: String,
        utteranceKey: String?,
        priority: String?,
        interruptPolicy: String?,
    ) {
        if (!ready || text.isBlank()) return
        val utteranceId = utteranceKey ?: UUID.randomUUID().toString()
        if (utteranceId == lastUtteranceId) return
        lastUtteranceId = utteranceId
        tts.language = Locale.SIMPLIFIED_CHINESE

        val queueMode = if (priority == "critical" || interruptPolicy == "interrupt_lower_priority") {
            TextToSpeech.QUEUE_FLUSH
        } else {
            TextToSpeech.QUEUE_ADD
        }
        tts.speak(text, queueMode, null, utteranceId)
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
        onSpeakingChanged(false)
    }
}

class LiveAudioCapture {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    private var recorder: AudioRecord? = null

    fun start(
        onLevel: (Float) -> Unit,
        onSegment: (String) -> Unit,
        onError: (String) -> Unit,
    ) {
        if (!running.compareAndSet(false, true)) return
        scope.launch {
            runCatching {
                captureLoop(onLevel, onSegment)
            }.onFailure {
                running.set(false)
                onError(it.message ?: "Audio capture failed")
            }
        }
    }

    fun pause() {
        paused.set(true)
    }

    fun resume() {
        paused.set(false)
    }

    fun stop() {
        running.set(false)
        recorder?.runCatchingStop()
        recorder = null
    }

    fun release() {
        stop()
        scope.cancel()
    }

    @Suppress("MissingPermission")
    private fun captureLoop(
        onLevel: (Float) -> Unit,
        onSegment: (String) -> Unit,
    ) {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, PCM_FORMAT)
            .coerceAtLeast(SAMPLE_RATE / 2)
        val audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            PCM_FORMAT,
            minBuffer,
        )
        recorder = audioRecord
        audioRecord.startRecording()

        val readBuffer = ShortArray(minBuffer / BYTES_PER_SAMPLE)
        val utterance = ArrayList<Short>(SAMPLE_RATE * 4)
        var speechFrames = 0
        var silenceFrames = 0

        while (running.get()) {
            if (paused.get()) {
                Thread.sleep(50)
                continue
            }

            val count = audioRecord.read(readBuffer, 0, readBuffer.size)
            if (count <= 0) continue

            val rms = readBuffer.rms(count)
            onLevel(rms)
            val speech = rms >= VAD_RMS_THRESHOLD

            if (speech) {
                speechFrames += 1
                silenceFrames = 0
            } else if (speechFrames > 0) {
                silenceFrames += 1
            }

            if (speechFrames > 0) {
                for (index in 0 until count) {
                    utterance += readBuffer[index]
                }
            }

            val longEnough = utterance.size >= SAMPLE_RATE / 2
            val ended = longEnough && silenceFrames >= END_SILENCE_FRAMES
            if (ended || utterance.size >= MAX_SAMPLES) {
                onSegment(encodeWavBase64(utterance.toShortArray()))
                utterance.clear()
                speechFrames = 0
                silenceFrames = 0
            }
        }
        audioRecord.runCatchingStop()
    }

    private fun AudioRecord.runCatchingStop() {
        runCatching { stop() }
        runCatching { release() }
    }

    private fun ShortArray.rms(count: Int): Float {
        var sum = 0.0
        for (index in 0 until count) {
            val normalized = this[index] / Short.MAX_VALUE.toDouble()
            sum += normalized * normalized
        }
        return sqrt(sum / count).toFloat()
    }

    private fun encodeWavBase64(samples: ShortArray): String {
        val pcm = ByteArray(samples.size * BYTES_PER_SAMPLE)
        ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(samples)
        val wav = ByteArrayOutputStream()
        wav.write("RIFF".toByteArray(Charsets.US_ASCII))
        wav.writeIntLe(36 + pcm.size)
        wav.write("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        wav.writeIntLe(16)
        wav.writeShortLe(1)
        wav.writeShortLe(1)
        wav.writeIntLe(SAMPLE_RATE)
        wav.writeIntLe(SAMPLE_RATE * BYTES_PER_SAMPLE)
        wav.writeShortLe(BYTES_PER_SAMPLE)
        wav.writeShortLe(16)
        wav.write("data".toByteArray(Charsets.US_ASCII))
        wav.writeIntLe(pcm.size)
        wav.write(pcm)
        return Base64.encodeToString(wav.toByteArray(), Base64.NO_WRAP)
    }

    private fun ByteArrayOutputStream.writeIntLe(value: Int) {
        write(byteArrayOf((value and 0xff).toByte(), ((value shr 8) and 0xff).toByte(), ((value shr 16) and 0xff).toByte(), ((value shr 24) and 0xff).toByte()))
    }

    private fun ByteArrayOutputStream.writeShortLe(value: Int) {
        write(byteArrayOf((value and 0xff).toByte(), ((value shr 8) and 0xff).toByte()))
    }

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val BYTES_PER_SAMPLE = 2
        private const val VAD_RMS_THRESHOLD = 0.035f
        private const val END_SILENCE_FRAMES = 12
        private const val MAX_SAMPLES = SAMPLE_RATE * 8
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val PCM_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }
}
