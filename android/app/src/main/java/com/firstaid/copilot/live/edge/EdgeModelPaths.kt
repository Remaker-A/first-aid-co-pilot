package com.firstaid.copilot.live.edge

import android.content.Context
import java.io.File
import org.json.JSONObject

private const val GEMMA_MIN_BYTES = 2_000_000_000L
private const val ASR_MIN_BYTES = 100_000_000L
private const val TTS_MIN_BYTES = 20_000_000L
private const val TTS_INT8_MIN_BYTES = 1_000_000L
private const val STREAMING_ASR_DIR = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"

enum class EdgeModelKind { Gemma, Asr, Tts, SherpaRuntime }

enum class EdgeModelState { Ready, Missing, RuntimeMissing, Error }

data class EdgeModelStatus(
    val kind: EdgeModelKind,
    val state: EdgeModelState,
    val path: String? = null,
    val sizeBytes: Long? = null,
    val detail: String = "",
    val latencyMs: Long? = null,
) {
    val ready: Boolean
        get() = state == EdgeModelState.Ready
}

data class EdgeModelReport(
    val root: String?,
    val statuses: List<EdgeModelStatus>,
) {
    val gemmaReady: Boolean
        get() = status(EdgeModelKind.Gemma).ready

    val asrReady: Boolean
        get() = status(EdgeModelKind.Asr).ready && status(EdgeModelKind.SherpaRuntime).ready

    val ttsReady: Boolean
        get() = status(EdgeModelKind.Tts).ready && status(EdgeModelKind.SherpaRuntime).ready

    fun status(kind: EdgeModelKind): EdgeModelStatus =
        statuses.firstOrNull { it.kind == kind }
            ?: EdgeModelStatus(kind, EdgeModelState.Missing, detail = "not inspected")

    fun summaryLine(): String {
        val parts = listOf(
            "Gemma=${status(EdgeModelKind.Gemma).state.name}",
            "ASR=${status(EdgeModelKind.Asr).state.name}",
            "TTS=${status(EdgeModelKind.Tts).state.name}",
            "sherpa=${status(EdgeModelKind.SherpaRuntime).state.name}",
        )
        return parts.joinToString(" ")
    }
}

data class EdgeModelFiles(
    val root: File?,
    val gemma: File?,
    val asr: StreamingAsrFiles?,
    val tts: TtsFiles?,
)

data class StreamingAsrFiles(
    val modelDir: File,
    val encoder: File,
    val decoder: File,
    val joiner: File,
    val tokens: File,
)

data class TtsFiles(
    val modelDir: File,
    val model: File,
    val lexicon: File,
    val tokens: File,
    val dictDir: File,
    val ruleFsts: List<File>,
)

class EdgeModelPathResolver(private val roots: List<File>) {
    fun resolve(): EdgeModelFiles {
        var rootWithAnyModel: File? = null
        var gemma: File? = null
        var asr: StreamingAsrFiles? = null
        var tts: TtsFiles? = null
        for (root in roots.distinctBy { it.absolutePath }) {
            val files = resolveUnder(root)
            if (rootWithAnyModel == null && (files.gemma != null || files.asr != null || files.tts != null)) {
                rootWithAnyModel = root
            }
            if (gemma == null) gemma = files.gemma
            if (asr == null) asr = files.asr
            if (tts == null) tts = files.tts
            if (gemma != null && asr != null && tts != null) {
                break
            }
        }
        return EdgeModelFiles(root = rootWithAnyModel ?: roots.firstOrNull(), gemma = gemma, asr = asr, tts = tts)
    }

    fun inspect(sherpaRuntimeAvailable: Boolean): EdgeModelReport {
        val files = resolve()
        val statuses = listOf(
            gemmaStatus(files.gemma),
            asrStatus(files.asr),
            ttsStatus(files.tts),
            EdgeModelStatus(
                kind = EdgeModelKind.SherpaRuntime,
                state = if (sherpaRuntimeAvailable) EdgeModelState.Ready else EdgeModelState.RuntimeMissing,
                detail = if (sherpaRuntimeAvailable) "sherpa-onnx classes available" else "download sherpa AAR",
            ),
        )
        return EdgeModelReport(root = files.root?.absolutePath, statuses = statuses)
    }

    private fun resolveUnder(root: File): EdgeModelFiles =
        EdgeModelFiles(
            root = root,
            gemma = resolveGemma(root),
            asr = resolveAsr(root),
            tts = resolveTts(root),
        )

    private fun resolveGemma(root: File): File? =
        listOf(
            root.resolve("gemma/gemma-4-E2B-it.litertlm"),
            root.resolve("gemma/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it.litertlm"),
        ).firstOrNull { it.isFile && it.length() >= GEMMA_MIN_BYTES }

    private fun resolveAsr(root: File): StreamingAsrFiles? {
        val sttRoot = root.resolve("speech/stt-stream")
        val candidates = buildList {
            add(sttRoot.resolve(STREAMING_ASR_DIR))
            sttRoot.listFiles()
                ?.filter(File::isDirectory)
                ?.sortedBy(File::getName)
                ?.forEach(::add)
        }
        return candidates.firstNotNullOfOrNull(::resolveAsrDir)
    }

    private fun resolveAsrDir(modelDir: File): StreamingAsrFiles? {
        val encoder = modelDir.resolve("encoder-epoch-99-avg-1.int8.onnx")
            .takeIf { it.isFile }
            ?: modelDir.resolve("encoder-epoch-99-avg-1.onnx")
        val decoder = modelDir.resolve("decoder-epoch-99-avg-1.onnx")
            .takeIf { it.isFile }
            ?: modelDir.resolve("decoder-epoch-99-avg-1.int8.onnx")
        val joiner = modelDir.resolve("joiner-epoch-99-avg-1.int8.onnx")
            .takeIf { it.isFile }
            ?: modelDir.resolve("joiner-epoch-99-avg-1.onnx")
        val tokens = modelDir.resolve("tokens.txt")
        return StreamingAsrFiles(modelDir, encoder, decoder, joiner, tokens)
            .takeIf { listOf(it.encoder, it.decoder, it.joiner, it.tokens).all(File::isFile) }
    }

    private fun resolveTts(root: File): TtsFiles? {
        val candidates = listOf(root.resolve("speech/tts"), root.resolve("speech"))
        return candidates.firstNotNullOfOrNull(::resolveTtsDir)
    }

    private fun resolveTtsDir(modelDir: File): TtsFiles? {
        val model = modelDir.resolve("model.int8.onnx")
            .takeIf { it.isFile && it.length() >= TTS_INT8_MIN_BYTES }
            ?: modelDir.resolve("model.onnx")
        val lexicon = modelDir.resolve("lexicon.txt")
        val tokens = modelDir.resolve("tokens.txt")
        val dictDir = modelDir.resolve("dict")
        val ruleFsts = listOf("date.fst", "number.fst", "phone.fst", "new_heteronym.fst")
            .map { modelDir.resolve(it) }
            .filter(File::isFile)
        return TtsFiles(modelDir, model, lexicon, tokens, dictDir, ruleFsts)
            .takeIf { listOf(it.model, it.lexicon, it.tokens, it.dictDir).all { file -> file.exists() } }
    }
}

@Suppress("DEPRECATION")
fun defaultEdgeModelRoots(context: Context): List<File> {
    val external = context.getExternalFilesDir(null)?.resolve("models")
    val media = context.externalMediaDirs.firstOrNull()?.resolve("models")
    return listOfNotNull(
        external,
        media,
        File("/sdcard/Android/data/${context.packageName}/files/models"),
        File("/sdcard/Android/media/${context.packageName}/models"),
        File("/sdcard/firstaid-copilot/models"),
        File("/data/local/tmp/firstaid/models"),
    )
}

fun inspectEdgeModels(context: Context, sherpaRuntimeAvailable: Boolean): EdgeModelReport =
    EdgeModelPathResolver(defaultEdgeModelRoots(context)).inspect(sherpaRuntimeAvailable)

private fun gemmaStatus(file: File?): EdgeModelStatus =
    if (file != null) {
        EdgeModelStatus(
            kind = EdgeModelKind.Gemma,
            state = EdgeModelState.Ready,
            path = file.absolutePath,
            sizeBytes = file.length(),
            detail = "Gemma LiteRT-LM model found",
        )
    } else {
        EdgeModelStatus(
            kind = EdgeModelKind.Gemma,
            state = EdgeModelState.Missing,
            detail = "missing gemma/gemma-4-E2B-it.litertlm",
        )
    }

private fun asrStatus(files: StreamingAsrFiles?): EdgeModelStatus =
    if (files != null && files.encoder.length() >= ASR_MIN_BYTES) {
        EdgeModelStatus(
            kind = EdgeModelKind.Asr,
            state = EdgeModelState.Ready,
            path = files.modelDir.absolutePath,
            sizeBytes = listOf(files.encoder, files.decoder, files.joiner, files.tokens).sumOf(File::length),
            detail = "streaming zh/en ASR model found",
        )
    } else {
        EdgeModelStatus(
            kind = EdgeModelKind.Asr,
            state = EdgeModelState.Missing,
            detail = "missing streaming sherpa-onnx ASR model",
        )
    }

// ---- WA pre-synth TTS cache (assets/tts_cache) --------------------------------
//
// The shippable bundle of pre-rendered standard phrases. The manifest is shared
// with the desktop server (src/voice/ttsCache.js); on device it is loaded from
// the APK assets first, then from a tts_cache dir pushed alongside the models.

private const val TTS_CACHE_DIR_NAME = "tts_cache"
private const val TTS_CACHE_MANIFEST_NAME = "manifest.json"

enum class TtsCacheSource { Asset, File }

data class TtsCacheEntry(
    val kind: String,
    val text: String,
    val tone: String,
    val speed: String,
    val key: String,
    val file: String,
)

data class TtsCacheBundle(
    val source: TtsCacheSource,
    val baseDir: File?,
    val assetRoot: String?,
    val entries: List<TtsCacheEntry>,
) {
    val phraseEntries: List<TtsCacheEntry>
        get() = entries.filter { it.kind == "phrase" }
}

fun loadTtsCacheBundle(
    context: Context,
    roots: List<File> = defaultEdgeModelRoots(context),
): TtsCacheBundle? {
    runCatching {
        context.applicationContext.assets
            .open("$TTS_CACHE_DIR_NAME/$TTS_CACHE_MANIFEST_NAME")
            .use { stream ->
                val entries = parseTtsCacheEntries(stream.readBytes().toString(Charsets.UTF_8))
                if (entries.isNotEmpty()) {
                    return TtsCacheBundle(TtsCacheSource.Asset, null, TTS_CACHE_DIR_NAME, entries)
                }
            }
    }

    for (root in roots.distinctBy { it.absolutePath }) {
        val candidates = listOfNotNull(root.resolve(TTS_CACHE_DIR_NAME), root.parentFile?.resolve(TTS_CACHE_DIR_NAME))
        for (dir in candidates) {
            val manifest = dir.resolve(TTS_CACHE_MANIFEST_NAME)
            if (manifest.isFile) {
                val entries = runCatching { parseTtsCacheEntries(manifest.readText()) }.getOrDefault(emptyList())
                if (entries.isNotEmpty()) {
                    return TtsCacheBundle(TtsCacheSource.File, dir, null, entries)
                }
            }
        }
    }
    return null
}

private fun parseTtsCacheEntries(json: String): List<TtsCacheEntry> {
    val array = JSONObject(json).optJSONArray("entries") ?: return emptyList()
    val out = ArrayList<TtsCacheEntry>(array.length())
    for (index in 0 until array.length()) {
        val obj = array.optJSONObject(index) ?: continue
        val file = obj.optString("file")
        val text = obj.optString("text")
        if (file.isBlank() || text.isBlank()) {
            continue
        }
        out.add(
            TtsCacheEntry(
                kind = obj.optString("kind", "phrase"),
                text = text,
                tone = obj.optString("tone", ""),
                speed = obj.optString("speed", ""),
                key = obj.optString("key", ""),
                file = file,
            ),
        )
    }
    return out
}

private fun ttsStatus(files: TtsFiles?): EdgeModelStatus =
    if (files != null && files.model.length() >= TTS_MIN_BYTES) {
        EdgeModelStatus(
            kind = EdgeModelKind.Tts,
            state = EdgeModelState.Ready,
            path = files.modelDir.absolutePath,
            sizeBytes = (listOf(files.model, files.lexicon, files.tokens) + files.ruleFsts).sumOf(File::length),
            detail = "VITS TTS model found",
        )
    } else {
        EdgeModelStatus(
            kind = EdgeModelKind.Tts,
            state = EdgeModelState.Missing,
            detail = "missing speech/tts model.onnx assets",
        )
    }
