package com.firstaid.copilot.live.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.firstaid.copilot.live.HapticState
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Audio metronome for the CPR loop. The cross-platform contract still calls this
 * a "haptic" intent ([HapticState] / `start_haptic_metronome`), but the client is
 * single-voice and **never vibrates**: we synthesize a short click every
 * `60000 / bpm` ms on an independent sonification track that sits *under* TTS.
 *
 * Entry points consumed by `LiveCprCoachScreen` (signatures must stay stable):
 *  - [apply] — start / re-tempo / stop the beat from `guidance_action.haptic`.
 *  - [stop] — silence the metronome.
 *  - [setDucked] — duck the click volume while TTS is speaking, restore on done.
 *
 * Once started the click loop is **locally self-sustaining**: it runs on its own
 * coroutine timer and does not depend on per-turn server messages. A dropped
 * connection during S7/S8 therefore never stops the beat — only an explicit
 * disabled [HapticState] or [stop]/[release] does.
 *
 * The audio I/O is delegated to [MetronomeAudio] so the scheduling/ducking logic
 * stays unit-testable without a real [AudioTrack].
 */
class MetronomeController internal constructor(
    private val audio: MetronomeAudio,
) {
    constructor(context: Context) : this(AudioTrackMetronome())

    private var runningBpm: Int? = null
    private var ducked = false

    fun apply(state: HapticState) {
        if (!state.enabled) {
            stop()
            return
        }
        val bpm = (state.bpm ?: DEFAULT_BPM).coerceIn(MIN_BPM, MAX_BPM)
        // Already ticking at this tempo: keep the local loop alive instead of
        // restarting it, so re-delivered/offline-fallback states never hiccup.
        if (runningBpm == bpm) return
        runningBpm = bpm
        audio.start(bpm)
        audio.setVolume(currentVolume())
    }

    /** Lower the click under TTS while it speaks; restore to full when it finishes. */
    fun setDucked(ducked: Boolean) {
        if (this.ducked == ducked) return
        this.ducked = ducked
        audio.setVolume(currentVolume())
    }

    fun stop() {
        runningBpm = null
        audio.stop()
    }

    /** Fully release the audio track + scheduler. Call from the screen's onDispose. */
    fun release() {
        runningBpm = null
        audio.release()
    }

    private fun currentVolume(): Float = if (ducked) DUCKED_VOLUME else FULL_VOLUME

    companion object {
        const val DEFAULT_BPM = 110
        const val MIN_BPM = 40
        const val MAX_BPM = 200
        const val FULL_VOLUME = 1.0f
        const val DUCKED_VOLUME = 0.3f
    }
}

/**
 * Audio-output seam for [MetronomeController]. Production uses [AudioTrackMetronome];
 * tests inject a fake to assert start/stop/tempo and ducking without Android audio.
 */
internal interface MetronomeAudio {
    fun start(bpm: Int)

    fun setVolume(volume: Float)

    fun stop()

    fun release()
}

/**
 * Default [MetronomeAudio]: a coroutine click loop on an [AudioTrack] using
 * `USAGE_MEDIA` / `CONTENT_TYPE_SONIFICATION`. USAGE_MEDIA routes to STREAM_MUSIC
 * so the safety-critical CPR click stays audible even when the phone is in
 * silent/vibrate ringer mode. (USAGE_ASSISTANCE_SONIFICATION routes to
 * STREAM_SYSTEM, which silent ringer mode force-mutes — that made the beat
 * inaudible on a phone left on silent.) The click still ducks under TTS via
 * [setVolume], not via the audio-focus system. Each beat re-primes one short click
 * into a streaming buffer that underruns to silence between beats; the schedule is
 * anchored to a start time so tempo does not drift over a long CPR session.
 */
internal class AudioTrackMetronome(
    private val sampleRate: Int = SAMPLE_RATE,
) : MetronomeAudio {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var volumeLevel: Float = 1.0f
    private var track: AudioTrack? = null
    private var loopJob: Job? = null

    override fun start(bpm: Int) {
        stopLoop()
        val intervalMs = (60_000L / bpm).coerceAtLeast(MIN_INTERVAL_MS)
        val click = buildClickPcm(sampleRate)
        val newTrack = runCatching { buildTrack(click.size) }.getOrNull() ?: return
        track = newTrack
        runCatching {
            newTrack.setVolume(volumeLevel)
            newTrack.play()
        }
        loopJob = scope.launch {
            val intervalNanos = intervalMs * 1_000_000
            val startNanos = System.nanoTime()
            var beat = 0L
            while (isActive) {
                // Re-prime one click; the stream underruns to silence until the next beat.
                runCatching { newTrack.write(click, 0, click.size) }
                beat++
                val targetNanos = startNanos + beat * intervalNanos
                val sleepMs = (targetNanos - System.nanoTime()) / 1_000_000
                if (sleepMs > 0) delay(sleepMs)
            }
        }
    }

    override fun setVolume(volume: Float) {
        val clamped = volume.coerceIn(0f, 1f)
        volumeLevel = clamped
        runCatching { track?.setVolume(clamped) }
    }

    override fun stop() {
        stopLoop()
        val current = track
        track = null
        runCatching { current?.pause() }
        runCatching { current?.flush() }
        runCatching { current?.stop() }
        runCatching { current?.release() }
    }

    override fun release() {
        stop()
        scope.cancel()
    }

    private fun stopLoop() {
        loopJob?.cancel()
        loopJob = null
    }

    private fun buildTrack(clickBytes: Int): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(sampleRate, CHANNEL_CONFIG, PCM_FORMAT)
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
                    .setSampleRate(sampleRate)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build(),
            )
            .setBufferSizeInBytes(minBuffer)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    companion object {
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

class AndroidTextToSpeechEdge(
    context: Context,
    private val onSpeakingChanged: (Boolean) -> Unit,
) {
    private var ready = false
    private var lastUtteranceId: String? = null
    private val utteranceLock = Any()
    private val queuedUtteranceIds = linkedSetOf<String>()
    private val issuedAtMsByUtteranceId = mutableMapOf<String, Long>()
    private val pendingUtterances = ArrayDeque<PendingUtterance>()
    private val tts = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            flushPendingUtterances()
        }
    }

    init {
        tts.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    val issuedAt = synchronized(utteranceLock) {
                        issuedAtMsByUtteranceId[utteranceId]
                    }
                    if (issuedAt != null) {
                        Log.i(TAG, "Android TTS onStart latency=${SystemClock.elapsedRealtime() - issuedAt}ms")
                    }
                    onSpeakingChanged(true)
                }

                override fun onDone(utteranceId: String?) {
                    markUtteranceFinished(utteranceId)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    markUtteranceFinished(utteranceId)
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    markUtteranceFinished(utteranceId)
                }
            },
        )
    }

    fun isReady(): Boolean = ready

    fun speak(
        text: String,
        utteranceKey: String?,
        priority: String?,
        interruptPolicy: String?,
        tone: String? = null,
        speed: String? = null,
        flushQueue: Boolean = false,
    ) {
        if (text.isBlank()) return
        val utteranceId = utteranceKey ?: UUID.randomUUID().toString()
        if (utteranceId == lastUtteranceId) return
        Log.i(TAG, "Android TTS speak request ready=$ready utterance=$utteranceId chars=${text.length}")
        val utterance = PendingUtterance(
            text = text,
            utteranceId = utteranceId,
            tone = tone,
            speed = speed,
            flushQueue = flushQueue,
            issuedAtMs = SystemClock.elapsedRealtime(),
        )
        if (!ready) {
            synchronized(utteranceLock) {
                if (flushQueue) {
                    pendingUtterances.clear()
                    queuedUtteranceIds.clear()
                    issuedAtMsByUtteranceId.clear()
                }
                pendingUtterances += utterance
                lastUtteranceId = utteranceId
            }
            Log.i(TAG, "Android TTS queued before ready utterance=$utteranceId")
            return
        }
        speakNow(utterance)
    }

    private fun speakNow(utterance: PendingUtterance) {
        lastUtteranceId = utterance.utteranceId
        tts.language = Locale.SIMPLIFIED_CHINESE
        tts.setPitch(NEUTRAL_TTS_PITCH)
        tts.setSpeechRate(resolveSpeechRate(utterance.tone, utterance.speed))

        val queueMode = if (utterance.flushQueue) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        synchronized(utteranceLock) {
            if (queueMode == TextToSpeech.QUEUE_FLUSH) {
                queuedUtteranceIds.clear()
                issuedAtMsByUtteranceId.clear()
            }
            queuedUtteranceIds += utterance.utteranceId
            issuedAtMsByUtteranceId[utterance.utteranceId] = utterance.issuedAtMs
        }
        onSpeakingChanged(true)
        if (tts.speak(utterance.text, queueMode, null, utterance.utteranceId) == TextToSpeech.ERROR) {
            markUtteranceFinished(utterance.utteranceId)
        }
    }

    fun stop() {
        tts.stop()
        lastUtteranceId = null
        synchronized(utteranceLock) {
            pendingUtterances.clear()
            queuedUtteranceIds.clear()
            issuedAtMsByUtteranceId.clear()
        }
        onSpeakingChanged(false)
    }

    fun shutdown() {
        stop()
        tts.shutdown()
    }

    private fun markUtteranceFinished(utteranceId: String?) {
        val stillSpeaking = synchronized(utteranceLock) {
            if (utteranceId != null) {
                queuedUtteranceIds.remove(utteranceId)
                issuedAtMsByUtteranceId.remove(utteranceId)
            }
            queuedUtteranceIds.isNotEmpty()
        }
        onSpeakingChanged(stillSpeaking)
    }

    private fun flushPendingUtterances() {
        val pending = synchronized(utteranceLock) {
            pendingUtterances.toList().also { pendingUtterances.clear() }
        }
        pending.forEach { speakNow(it) }
    }

    private fun resolveSpeechRate(tone: String?, speed: String?): Float =
        when {
            speed == "slow" -> SLOW_TTS_RATE
            tone == "urgent" || speed == "fast" -> URGENT_TTS_RATE
            tone == "calm_firm" || tone == "calm_soft" -> CALM_TTS_RATE
            else -> CALM_TTS_RATE
        }

    companion object {
        private const val TAG = "AndroidTextToSpeech"
        private const val CALM_TTS_RATE = 0.94f
        private const val SLOW_TTS_RATE = 0.92f
        private const val URGENT_TTS_RATE = 1.0f
        private const val NEUTRAL_TTS_PITCH = 1.0f
    }

    private data class PendingUtterance(
        val text: String,
        val utteranceId: String,
        val tone: String?,
        val speed: String?,
        val flushQueue: Boolean,
        val issuedAtMs: Long,
    )
}

class LiveAudioCapture {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    private val ttsSpeaking = AtomicBoolean(false)
    private val ttsTailHoldoffUntilMs = AtomicLong(0L)
    private var recorder: AudioRecord? = null

    fun start(
        onLevel: (Float) -> Unit,
        onPcmChunk: (ByteArray) -> Unit,
        onListeningPcmChunk: ((ByteArray) -> Unit)? = null,
        onUtterancePcm: ((ByteArray) -> Unit)? = null,
        onBargeIn: () -> Unit,
        onError: (String) -> Unit,
    ) {
        if (!running.compareAndSet(false, true)) return
        scope.launch {
            runCatching {
                captureLoop(onLevel, onPcmChunk, onListeningPcmChunk, onUtterancePcm, onBargeIn)
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

    fun setTtsSpeaking(speaking: Boolean) {
        ttsSpeaking.set(speaking)
        if (!speaking) {
            ttsTailHoldoffUntilMs.set(SystemClock.elapsedRealtime() + POST_TTS_TAIL_HOLDOFF_MS)
        }
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
        onPcmChunk: (ByteArray) -> Unit,
        onListeningPcmChunk: ((ByteArray) -> Unit)?,
        onUtterancePcm: ((ByteArray) -> Unit)?,
        onBargeIn: () -> Unit,
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
        recorder = audioRecord
        val acousticEchoCanceler = createAcousticEchoCanceler(audioRecord.audioSessionId)
        val noiseSuppressor = createNoiseSuppressor(audioRecord.audioSessionId)

        val readBuffer = ShortArray(FRAME_SAMPLES)
        var silenceMs = 0
        var voicedMs = 0
        var voiceActive = false
        var lastCaptureStatsAtMs = 0L
        var peakRmsSinceLog = 0f
        var peakRmsForUtterance = 0f
        val utterancePcm = ByteArrayOutputStream(FRAME_SAMPLES * BYTES_PER_SAMPLE * 32)
        val listeningFramePcm = ByteArrayOutputStream(FRAME_SAMPLES * BYTES_PER_SAMPLE)
        val ttsTailPreRollPcm = ByteArrayOutputStream(FRAME_BYTES * (TTS_TAIL_PREROLL_MS / FRAME_MS))

        fun resetTtsTailPreRoll() {
            if (ttsTailPreRollPcm.size() > 0) {
                ttsTailPreRollPcm.reset()
            }
        }

        fun appendTtsTailPreRoll(pcm: ByteArray) {
            val maxBytes = FRAME_BYTES * (TTS_TAIL_PREROLL_MS / FRAME_MS)
            if (ttsTailPreRollPcm.size() + pcm.size > maxBytes) {
                val current = ttsTailPreRollPcm.toByteArray()
                val keepBytes = (maxBytes - pcm.size).coerceAtLeast(0)
                ttsTailPreRollPcm.reset()
                if (keepBytes > 0) {
                    val offset = (current.size - keepBytes).coerceAtLeast(0)
                    ttsTailPreRollPcm.write(current, offset, current.size - offset)
                }
            }
            ttsTailPreRollPcm.write(pcm)
        }

        fun feedListeningPcm(pcm: ByteArray) {
            if (onListeningPcmChunk == null) return
            listeningFramePcm.write(pcm)
            while (listeningFramePcm.size() >= FRAME_BYTES) {
                val pending = listeningFramePcm.toByteArray()
                onListeningPcmChunk.invoke(pending.copyOfRange(0, FRAME_BYTES))
                listeningFramePcm.reset()
                if (pending.size > FRAME_BYTES) {
                    listeningFramePcm.write(pending, FRAME_BYTES, pending.size - FRAME_BYTES)
                }
            }
        }

        fun feedLivePcm(pcm: ByteArray) {
            onPcmChunk(pcm)
            feedListeningPcm(pcm)
        }

        try {
            audioRecord.startRecording()
            Log.i(
                TAG_CAPTURE,
                "Audio capture started threshold=$LISTENING_RMS_THRESHOLD " +
                    "frameMs=$FRAME_MS minUtteranceMs=$MIN_UTTERANCE_MS " +
                    "commitSilenceMs=$COMMIT_SILENCE_MS postTtsHoldoffMs=$POST_TTS_TAIL_HOLDOFF_MS",
            )
            while (running.get()) {
                if (paused.get()) {
                    Thread.sleep(50)
                    continue
                }

                val count = audioRecord.read(readBuffer, 0, readBuffer.size)
                if (count <= 0) continue

                val rms = readBuffer.rms(count)
                val frameMs = (count * 1000 / SAMPLE_RATE).coerceAtLeast(1)
                val framePcm = readBuffer.toPcmBytes(count)
                val nowMs = SystemClock.elapsedRealtime()
                onLevel(rms)
                peakRmsSinceLog = maxOf(peakRmsSinceLog, rms)
                if (nowMs - lastCaptureStatsAtMs >= CAPTURE_STATS_LOG_INTERVAL_MS) {
                    Log.i(
                        TAG_CAPTURE,
                        "Capture rmsPeak=$peakRmsSinceLog voiceActive=$voiceActive " +
                            "voicedMs=$voicedMs tts=${ttsSpeaking.get()} " +
                            "tail=${nowMs < ttsTailHoldoffUntilMs.get()}",
                    )
                    peakRmsSinceLog = 0f
                    lastCaptureStatsAtMs = nowMs
                }

                val suppressForTts = ttsSpeaking.get()
                val suppressForTtsTail = !suppressForTts &&
                    nowMs < ttsTailHoldoffUntilMs.get()
                if (suppressForTts) {
                    // Half-duplex: phone speaker echo can exceed speech RMS, so never auto-barge-in here.
                    listeningFramePcm.reset()
                    utterancePcm.reset()
                    resetTtsTailPreRoll()
                    voiceActive = false
                    silenceMs = 0
                    voicedMs = 0
                    peakRmsForUtterance = 0f
                    continue
                }
                val speech = rms >= LISTENING_RMS_THRESHOLD
                if (suppressForTtsTail) {
                    if (speech || ttsTailPreRollPcm.size() > 0) {
                        appendTtsTailPreRoll(framePcm)
                    }
                    listeningFramePcm.reset()
                    utterancePcm.reset()
                    voiceActive = false
                    silenceMs = 0
                    voicedMs = 0
                    peakRmsForUtterance = 0f
                    continue
                }

                if (speech && utterancePcm.size() == 0 && ttsTailPreRollPcm.size() > 0) {
                    val preRoll = ttsTailPreRollPcm.toByteArray()
                    Log.i(TAG_CAPTURE, "Prepending TTS-tail preroll bytes=${preRoll.size}")
                    feedLivePcm(preRoll)
                    utterancePcm.write(preRoll)
                    resetTtsTailPreRoll()
                } else if (!speech && !voiceActive) {
                    resetTtsTailPreRoll()
                }

                feedLivePcm(framePcm)
                if (speech) {
                    utterancePcm.write(framePcm)
                    silenceMs = 0
                    voicedMs += frameMs
                    peakRmsForUtterance = maxOf(peakRmsForUtterance, rms)
                    if (!voiceActive && voicedMs >= MIN_UTTERANCE_MS) {
                        voiceActive = true
                        Log.i(
                            TAG_CAPTURE,
                            "Voice active voicedMs=$voicedMs peakRms=$peakRmsForUtterance " +
                                "threshold=$LISTENING_RMS_THRESHOLD",
                        )
                    }
                } else if (voiceActive) {
                    utterancePcm.write(framePcm)
                    silenceMs += frameMs
                } else {
                    voicedMs = 0
                    peakRmsForUtterance = 0f
                    if (utterancePcm.size() > 0) utterancePcm.reset()
                }

                if (voiceActive && silenceMs >= COMMIT_SILENCE_MS) {
                    val committed = utterancePcm.toByteArray()
                    if (committed.isNotEmpty()) {
                        Log.i(
                            TAG_CAPTURE,
                            "Local utterance committed bytes=${committed.size} " +
                                "voicedMs=$voicedMs peakRms=$peakRmsForUtterance",
                        )
                        onUtterancePcm?.invoke(committed)
                    }
                    utterancePcm.reset()
                    voiceActive = false
                    silenceMs = 0
                    voicedMs = 0
                    peakRmsForUtterance = 0f
                }
            }
        } finally {
            runCatching { acousticEchoCanceler?.release() }
            runCatching { noiseSuppressor?.release() }
            audioRecord.runCatchingStop()
            recorder = null
        }
    }

    private fun createAcousticEchoCanceler(audioSessionId: Int): AcousticEchoCanceler? =
        if (!AcousticEchoCanceler.isAvailable()) {
            null
        } else {
            runCatching {
                AcousticEchoCanceler.create(audioSessionId)?.also { effect ->
                    runCatching { effect.setEnabled(true) }
                }
            }.getOrNull()
        }

    private fun createNoiseSuppressor(audioSessionId: Int): NoiseSuppressor? =
        if (!NoiseSuppressor.isAvailable()) {
            null
        } else {
            runCatching {
                NoiseSuppressor.create(audioSessionId)?.also { effect ->
                    runCatching { effect.setEnabled(true) }
                }
            }.getOrNull()
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

    private fun ShortArray.toPcmBytes(count: Int): ByteArray {
        val pcm = ByteArray(count * BYTES_PER_SAMPLE)
        ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(this, 0, count)
        return pcm
    }

    companion object {
        private const val TAG_CAPTURE = "LiveAudioCapture"
        private const val SAMPLE_RATE = 16_000
        private const val BYTES_PER_SAMPLE = 2
        private const val FRAME_MS = 40
        private const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
        private const val FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE
        private const val LISTENING_RMS_THRESHOLD = 0.018f
        private const val MIN_UTTERANCE_MS = 180
        private const val COMMIT_SILENCE_MS = 450
        private const val CAPTURE_STATS_LOG_INTERVAL_MS = 2_000L
        private const val POST_TTS_TAIL_HOLDOFF_MS = 400L
        private const val TTS_TAIL_PREROLL_MS = 800
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val PCM_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }
}
