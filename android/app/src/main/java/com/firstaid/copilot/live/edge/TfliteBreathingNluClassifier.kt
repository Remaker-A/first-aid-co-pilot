package com.firstaid.copilot.live.edge

import android.content.Context
import android.util.Log
import com.firstaid.copilot.live.LiveNluResolution
import com.firstaid.copilot.live.LiveNluResolver
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder
import java.io.File

/**
 * Public factory surface for future wiring. The default [EdgeTinyNluResolver]
 * constructor remains rule-based; callers must opt in here to try the TFLite
 * TextEmbedder-backed classifier.
 */
object EdgeBreathingNluResolvers {
    fun ruleBased(): EdgeTinyNluResolver = EdgeTinyNluResolver()

    fun tfliteOrRuleBased(context: Context): EdgeTinyNluResolver =
        EdgeTinyNluResolver(TfliteBreathingNluClassifier.create(context.applicationContext))

    fun asLiveResolver(context: Context, useTflite: Boolean): LiveNluResolver =
        if (useTflite) tfliteOrRuleBased(context) else ruleBased()
}

internal class TfliteBreathingNluClassifier private constructor(
    private val embedder: TextEmbeddingProvider,
    private val router: BreathingNluPrototypeRouter,
    private val fallback: EdgeBreathingNluClassifier,
) : EdgeBreathingNluClassifier, AutoCloseable {

    override fun classify(transcript: String): LiveNluResolution? {
        val text = transcript.trim()
        if (text.isEmpty()) return null
        val vector = embedder.embed(text) ?: return fallback.classify(text)
        return router.classify(vector)
    }

    override fun close() {
        (embedder as? AutoCloseable)?.close()
    }

    companion object {
        fun create(
            context: Context,
            roots: List<File> = defaultEdgeModelRoots(context),
            fallback: EdgeBreathingNluClassifier = RuleBasedBreathingNluClassifier(),
        ): EdgeBreathingNluClassifier {
            val modelFile = resolveBreathingNluTextEmbedderModel(roots) ?: return fallback
            val provider = MediaPipeTextEmbeddingProvider.create(context.applicationContext, modelFile)
                ?: return fallback

            val router = buildBreathingNluPrototypeRouter(DEFAULT_BREATHING_NLU_PROTOTYPE_PHRASES, provider)
            if (router == null) {
                provider.close()
                return fallback
            }
            return TfliteBreathingNluClassifier(
                embedder = provider,
                router = router,
                fallback = fallback,
            )
        }
    }
}

internal fun resolveBreathingNluTextEmbedderModel(roots: List<File>): File? {
    for (root in roots.distinctBy { it.absolutePath }) {
        val candidates = listOf(
            root.resolve("nlu/breathing_zh_text_embedder.tflite"),
            root.resolve("nlu/text_embedder.tflite"),
            root.resolve("nlu/breathing_text_embedder.tflite"),
            root.resolve("text/breathing_zh_text_embedder.tflite"),
        )
        candidates.firstOrNull { it.isFile && it.length() >= BREATHING_NLU_MODEL_MIN_BYTES }?.let {
            return it
        }
    }
    return null
}

private class MediaPipeTextEmbeddingProvider private constructor(
    private val textEmbedder: TextEmbedder,
) : TextEmbeddingProvider, AutoCloseable {
    override fun embed(text: String): FloatArray? =
        runCatching {
            textEmbedder.embed(text)
                .embeddingResult()
                .embeddings()
                .firstOrNull()
                ?.floatEmbedding()
                ?.takeIf { it.isNotEmpty() }
                ?.copyOf()
        }.onFailure { error ->
            Log.w(TAG, "Breathing NLU embedding failed", error)
        }.getOrNull()

    override fun close() {
        textEmbedder.close()
    }

    companion object {
        fun create(context: Context, modelFile: File): MediaPipeTextEmbeddingProvider? =
            runCatching {
                MediaPipeTextEmbeddingProvider(TextEmbedder.createFromFile(context, modelFile))
            }.onFailure { error ->
                Log.w(TAG, "Breathing NLU TextEmbedder unavailable: ${modelFile.absolutePath}", error)
            }.getOrNull()

        private const val TAG = "TfliteBreathingNlu"
    }
}

private const val BREATHING_NLU_MODEL_MIN_BYTES = 1_000_000L
