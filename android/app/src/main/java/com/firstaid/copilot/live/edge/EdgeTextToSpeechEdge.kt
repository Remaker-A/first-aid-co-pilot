package com.firstaid.copilot.live.edge

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import com.firstaid.copilot.live.audio.AndroidTextToSpeechEdge
import java.io.File
import java.lang.Integer.toHexString
import java.util.UUID
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
        lastUtteranceId = utteranceId

        scope.launch {
            val cached = cachedPhrases[cacheKey(text, tone, speed)]
                ?.takeIf { it.isFile && it.length() > 0L }
            if (cached != null) {
                Log.i(TAG, "Sherpa TTS cache hit ${cached.length()} bytes for '${text.take(16)}'")
                play(cached)
                return@launch
            }
            val bundled = bundledByText[normalizeCacheText(text)]
                ?.takeIf { it.isFile && it.length() > 0L }
            if (bundled != null) {
                // Pre-rendered sherpa audio: best quality + correct digit reading,
                // so prefer it over the system-TTS fast path.
                Log.i(TAG, "Sherpa TTS bundle hit ${bundled.length()} bytes for '${text.take(16)}'")
                play(bundled)
                return@launch
            }
            if (shouldUseFastSystemTts(text, priority, tone) && fallback.isReady()) {
                Log.i(TAG, "Android TTS fast path for '${text.take(16)}'")
                fallback.speak(
                    text = text,
                    utteranceKey = utteranceId,
                    priority = priority,
                    interruptPolicy = interruptPolicy,
                    tone = tone,
                    speed = speed,
                    flushQueue = flushQueue || interruptPolicy == "interrupt_lower_priority",
                )
                synthesizeCacheOnly(text, tone, speed)
                return@launch
            }
            val rate = resolveSpeechRate(tone, speed)
            val outFile = File(appContext.cacheDir, "edge-tts/$utteranceId.wav")
            val result = speechEngine.synthesizeToWav(text, outFile, speed = rate)
            if (result.ok && result.audioFile?.isFile == true) {
                Log.i(TAG, "Sherpa TTS synthesized ${result.audioFile.length()} bytes in ${result.latencyMs}ms")
                if (text.length <= CACHEABLE_TEXT_MAX_CHARS) {
                    cachedPhrases[cacheKey(text, tone, speed)] = result.audioFile
                }
                play(result.audioFile)
            } else {
                Log.w(TAG, "Sherpa TTS unavailable, falling back to Android TTS: ${result.error}")
                fallback.speak(text, utteranceKey, priority, interruptPolicy, tone, speed, flushQueue)
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
    }

    fun shutdown() {
        stop()
        fallback.shutdown()
        scope.cancel()
    }

    private suspend fun play(file: File) {
        withContext(Dispatchers.Main) {
            stopPlayerOnly()
            val next = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    stopPlayerOnly()
                    onSpeakingChanged(false)
                }
                setOnErrorListener { _, _, _ ->
                    Log.w(TAG, "MediaPlayer failed to play Sherpa TTS output")
                    stopPlayerOnly()
                    onSpeakingChanged(false)
                    true
                }
                prepare()
            }
            player = next
            onSpeakingChanged(true)
            next.start()
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

    private fun shouldUseFastSystemTts(text: String, priority: String?, tone: String?): Boolean =
        text.length <= FAST_SYSTEM_TTS_MAX_CHARS ||
            priority == "critical" ||
            priority == "high" ||
            tone == "urgent" ||
            text in FAST_SYSTEM_TTS_TEXTS

    private companion object {
        const val TAG = "EdgeTextToSpeech"
        const val CACHEABLE_TEXT_MAX_CHARS = 24
        const val FAST_SYSTEM_TTS_MAX_CHARS = 24
        const val RUNTIME_CACHE_MAX_ENTRIES = 64
        val WHITESPACE_REGEX = Regex("\\s+")
        val FAST_SYSTEM_TTS_TEXTS = setOf(
            "\u7ee7\u7eed\u6309\u538b",
            "\u4e0d\u8981\u505c",
            "\u7528\u529b\u6309\u538b",
            "\u6253\u5f00 AED",
            "\u547c\u53eb 120",
        )
    }
}
