package com.firstaid.copilot.live.edge

import android.content.Context
import android.media.MediaPlayer
import android.os.SystemClock
import android.util.Log
import com.firstaid.copilot.live.audio.AndroidTextToSpeechEdge
import java.io.File
import java.lang.Integer.toHexString
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class EdgeTextToSpeechEdge(
    context: Context,
    private val speechEngine: SherpaOnnxSpeechEngine,
    private val onSpeakingChanged: (Boolean) -> Unit,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val fallback = AndroidTextToSpeechEdge(appContext, onSpeakingChanged)
    // Runtime LRU of phrases synthesized on-device this session (bounded so a
    // long resuscitation does not grow the map without limit).
    private val cachedPhrases = object : LinkedHashMap<String, File>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, File>?): Boolean =
            size > RUNTIME_CACHE_MAX_ENTRIES
    }
    // Workflow WA: shipped pre-rendered standard phrases (raw text -> WAV file),
    // loaded once from assets/tts_cache (or a pushed tts_cache dir).
    @Volatile private var bundledByText: Map<String, File> = emptyMap()
    private var bundleLoaded = false
    private var player: MediaPlayer? = null
    private var lastUtteranceId: String? = null
    private var lastAcceptedText: String = ""
    private var lastAcceptedTextAtMs: Long = Long.MIN_VALUE

    init {
        scope.launch(Dispatchers.IO) { preloadBundledCache() }
    }

    suspend fun prewarmPhrase(
        text: String,
        tone: String? = null,
        speed: String? = null,
    ): EdgeSpeechResult {
        if (text.isBlank()) return EdgeSpeechResult(ok = false, error = "blank TTS text")
        val key = cacheKey(text, tone, speed)
        cachedPhrases[key]?.takeIf { it.isFile && it.length() > 0L }?.let {
            return EdgeSpeechResult(ok = true, audioFile = it, latencyMs = 0)
        }
        val outFile = File(appContext.cacheDir, "edge-tts/cache-${toHexString(key.hashCode())}.wav")
        val result = speechEngine.synthesizeToWav(
            text = text,
            outputFile = outFile,
            speed = resolveSpeechRate(tone, speed),
        )
        if (result.ok && result.audioFile?.isFile == true) {
            cachedPhrases[key] = result.audioFile
            Log.i(TAG, "Sherpa TTS cached '${text.take(16)}' in ${result.latencyMs}ms")
        }
        return result
    }

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
        val normalizedText = normalizeCacheText(text)
        val nowMs = SystemClock.elapsedRealtime()
        if (
            shouldSuppressRepeatedLocalTts(
                text = normalizedText,
                lastText = lastAcceptedText,
                nowMs = nowMs,
                lastAtMs = lastAcceptedTextAtMs,
                priority = priority,
                interruptPolicy = interruptPolicy,
                tone = tone,
            )
        ) {
            Log.i(TAG, "Suppress repeated local TTS for '${text.take(16)}'")
            return
        }
        lastUtteranceId = utteranceId
        lastAcceptedText = normalizedText
        lastAcceptedTextAtMs = nowMs

        val shouldFlushQueue = shouldFlushSystemTtsQueue(
            priority = priority,
            interruptPolicy = interruptPolicy,
            tone = tone,
            explicitFlush = flushQueue,
        )
        Log.i(TAG, "Foreground Android system TTS for '${text.take(16)}'")
        fallback.speak(text, utteranceId, priority, interruptPolicy, tone, speed, shouldFlushQueue)

        scope.launch(Dispatchers.IO) {
            preloadBundledCache()
            val key = cacheKey(text, tone, speed)
            val hasCache = cachedPhrases[key]?.takeIf { it.isFile && it.length() > 0L } != null ||
                bundledByText[normalizeCacheText(text)]?.takeIf { it.isFile && it.length() > 0L } != null
            if (!hasCache) {
                synthesizeCacheOnly(text, tone, speed)
            }
        }
    }

    private suspend fun synthesizeCacheOnly(text: String, tone: String?, speed: String?) {
        if (text.length > CACHEABLE_TEXT_MAX_CHARS) return
        val key = cacheKey(text, tone, speed)
        val outFile = File(appContext.cacheDir, "edge-tts/cache-${toHexString(key.hashCode())}.wav")
        val result = speechEngine.synthesizeToWav(
            text = text,
            outputFile = outFile,
            speed = resolveSpeechRate(tone, speed),
        )
        if (result.ok && result.audioFile?.isFile == true) {
            cachedPhrases[key] = result.audioFile
            Log.i(TAG, "Sherpa TTS background cached '${text.take(16)}' in ${result.latencyMs}ms")
        } else {
            Log.w(TAG, "Sherpa TTS background cache failed: ${result.error}")
        }
    }

    // Load the shipped WA bundle into memory so the closed-set phrases play
    // from a pre-rendered WAV (~0ms) on their first request, with no synthesis.
    suspend fun preloadBundledCache() {
        if (bundleLoaded) return
        bundleLoaded = true
        val bundle = loadTtsCacheBundle(appContext)
        if (bundle == null) {
            Log.i(TAG, "No bundled TTS cache present")
            return
        }
        val resolved = HashMap<String, File>()
        for (entry in bundle.phraseEntries) {
            val file = materializeBundledFile(bundle, entry) ?: continue
            resolved[normalizeCacheText(entry.text)] = file
        }
        bundledByText = resolved
        Log.i(
            TAG,
            "Bundled TTS cache ready: ${resolved.size}/${bundle.phraseEntries.size} phrases (${bundle.source})",
        )
    }

    private fun materializeBundledFile(bundle: TtsCacheBundle, entry: TtsCacheEntry): File? =
        when (bundle.source) {
            TtsCacheSource.File ->
                bundle.baseDir?.resolve(entry.file)?.takeIf { it.isFile && it.length() > 0L }
            TtsCacheSource.Asset -> runCatching {
                val out = File(appContext.cacheDir, "tts_cache_bundle/${entry.file}")
                if (out.isFile && out.length() > 0L) return@runCatching out
                out.parentFile?.mkdirs()
                appContext.assets.open("${bundle.assetRoot}/${entry.file}").use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
                out.takeIf { it.isFile && it.length() > 0L }
            }.getOrNull()
        }

    fun stop() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        fallback.stop()
        onSpeakingChanged(false)
        lastUtteranceId = null
    }

    fun shutdown() {
        stop()
        fallback.shutdown()
        scope.cancel()
    }

    // Plays a pre-rendered/synthesized Sherpa WAV. If MediaPlayer cannot prepare,
    // start, or fails mid-playback, fall back to the system TTS so a critical
    // instruction is never silently dropped. The original text + speech params
    // are threaded through purely to enable that fallback.
    private suspend fun play(
        file: File,
        text: String,
        utteranceId: String,
        priority: String?,
        interruptPolicy: String?,
        tone: String?,
        speed: String?,
        flushQueue: Boolean,
    ) {
        withContext(Dispatchers.Main) {
            stopPlayerOnly()
            val fellBack = AtomicBoolean(false)
            fun fallbackToSystemTts(reason: String) {
                if (!fellBack.compareAndSet(false, true)) return
                Log.w(TAG, "MediaPlayer playback failed ($reason); falling back to Android TTS for '${text.take(16)}'")
                stopPlayerOnly()
                if (fallback.isReady()) {
                    fallback.speak(
                        text = text,
                        utteranceKey = utteranceId,
                        priority = priority,
                        interruptPolicy = interruptPolicy,
                        tone = tone,
                        speed = speed,
                        flushQueue = flushQueue,
                    )
                } else {
                    onSpeakingChanged(false)
                }
            }
            var pending: MediaPlayer? = null
            try {
                val next = MediaPlayer()
                pending = next
                next.setDataSource(file.absolutePath)
                next.setOnCompletionListener {
                    stopPlayerOnly()
                    onSpeakingChanged(false)
                }
                next.setOnErrorListener { _, what, extra ->
                    fallbackToSystemTts("onError what=$what extra=$extra")
                    true
                }
                next.prepare()
                player = next
                pending = null
                onSpeakingChanged(true)
                next.start()
            } catch (error: Throwable) {
                runCatching { pending?.release() }
                fallbackToSystemTts(error.message ?: error::class.java.simpleName)
            }
        }
    }

    private fun stopPlayerOnly() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
    }

    private fun resolveSpeechRate(tone: String?, speed: String?): Float =
        when {
            speed == "slow" -> 0.96f
            tone == "urgent" || speed == "fast" -> 1.12f
            else -> 1.04f
        }

    private fun cacheKey(text: String, tone: String?, speed: String?): String =
        listOf(normalizeCacheText(text), tone.orEmpty(), speed.orEmpty()).joinToString("|")

    private fun normalizeCacheText(text: String): String =
        text.trim().replace(WHITESPACE_REGEX, " ")

    private fun shouldFlushSystemTtsQueue(
        priority: String?,
        interruptPolicy: String?,
        tone: String?,
        explicitFlush: Boolean,
    ): Boolean =
        explicitFlush ||
            priority == "critical" ||
            priority == "high" ||
            tone == "urgent" ||
            interruptPolicy == "interrupt_lower_priority"

    private companion object {
        const val TAG = "EdgeTextToSpeech"
        const val CACHEABLE_TEXT_MAX_CHARS = 24
        const val RUNTIME_CACHE_MAX_ENTRIES = 64
        val WHITESPACE_REGEX = Regex("\\s+")
    }
}

internal fun shouldSuppressRepeatedLocalTts(
    text: String,
    lastText: String,
    nowMs: Long,
    lastAtMs: Long,
    priority: String?,
    interruptPolicy: String?,
    tone: String?,
    cooldownMs: Long = DEFAULT_LOCAL_TTS_REPEAT_SUPPRESSION_MS,
): Boolean {
    if (text.isBlank() || text != lastText) return false
    if (nowMs < lastAtMs || nowMs - lastAtMs > cooldownMs) return false
    return !isRepeatSuppressionExempt(priority, interruptPolicy, tone)
}

private fun isRepeatSuppressionExempt(
    priority: String?,
    interruptPolicy: String?,
    tone: String?,
): Boolean =
    priority == "critical" ||
        priority == "high" ||
        tone == "urgent" ||
        interruptPolicy == "interrupt_lower_priority"

internal const val DEFAULT_LOCAL_TTS_REPEAT_SUPPRESSION_MS = 60_000L
