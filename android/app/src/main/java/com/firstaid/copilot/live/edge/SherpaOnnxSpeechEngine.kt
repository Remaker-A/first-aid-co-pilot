package com.firstaid.copilot.live.edge

import android.content.Context
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class EdgeSpeechResult(
    val ok: Boolean,
    val text: String = "",
    val audioFile: File? = null,
    val sampleRate: Int? = null,
    val latencyMs: Long = 0,
    val error: String? = null,
)

class SherpaOnnxSpeechEngine(
    private val context: Context,
    private val files: EdgeModelFiles,
    private val numThreads: Int = 2,
    private val debugTraceFile: File? = null,
) : AutoCloseable {
    private val mutex = Mutex()
    private var recognizer: Any? = null
    private var tts: Any? = null

    fun runtimeAvailable(): Boolean = classAvailable("com.k2fsa.sherpa.onnx.OnlineRecognizer")

    suspend fun transcribePcm16(pcm16: ByteArray, timeoutMs: Long = 60_000L): EdgeSpeechResult {
        trace("asr_enter")
        return mutex.withLock {
            trace("asr_lock_acquired")
            withContext(Dispatchers.Default) {
                trace("asr_default_dispatch")
                runWithHardTimeout("ASR", timeoutMs) { transcribePcm16Blocking(pcm16) }
            }
        }
    }

    suspend fun synthesizeToWav(
        text: String,
        outputFile: File,
        sid: Int = 0,
        speed: Float = 1.08f,
        timeoutMs: Long = 45_000L,
    ): EdgeSpeechResult {
        trace("tts_enter")
        return mutex.withLock {
            trace("tts_lock_acquired")
            withContext(Dispatchers.Default) {
                trace("tts_default_dispatch")
                runWithHardTimeout("TTS", timeoutMs) { synthesizeToWavBlocking(text, outputFile, sid, speed) }
            }
        }
    }

    override fun close() {
        recognizer.callQuietly("release")
        tts.callQuietly("release")
        recognizer = null
        tts = null
    }

    private fun createOnlineRecognizer(asrFiles: StreamingAsrFiles): Any {
        trace("asr_create_start")
        Log.i(TAG, "ASR create start modelDir=${asrFiles.modelDir.absolutePath}")
        val featureConfig = newSherpa("FeatureConfig").apply {
            call("setSampleRate", 16_000)
            call("setFeatureDim", 80)
            call("setDither", 0f)
        }
        val transducer = newSherpa("OnlineTransducerModelConfig").apply {
            call("setEncoder", asrFiles.encoder.absolutePath)
            call("setDecoder", asrFiles.decoder.absolutePath)
            call("setJoiner", asrFiles.joiner.absolutePath)
        }
        val modelConfig = newSherpa("OnlineModelConfig").apply {
            call("setTransducer", transducer)
            call("setTokens", asrFiles.tokens.absolutePath)
            call("setNumThreads", numThreads)
            call("setProvider", "cpu")
            call("setModelType", "zipformer")
        }
        val recognizerConfig = newSherpa("OnlineRecognizerConfig").apply {
            call("setFeatConfig", featureConfig)
            call("setModelConfig", modelConfig)
            call("setEnableEndpoint", true)
            call("setDecodingMethod", "greedy_search")
        }
        trace("asr_ctor_start")
        return ctor("OnlineRecognizer", null, recognizerConfig).also {
            trace("asr_ctor_done")
            Log.i(TAG, "ASR create done")
        }
    }

    private fun createOfflineTts(ttsFiles: TtsFiles): Any {
        trace("tts_create_start model=${ttsFiles.model.name} bytes=${ttsFiles.model.length()}")
        Log.i(TAG, "TTS create start model=${ttsFiles.model.absolutePath}")
        val vits = newSherpa("OfflineTtsVitsModelConfig").apply {
            call("setModel", ttsFiles.model.absolutePath)
            call("setLexicon", ttsFiles.lexicon.absolutePath)
            call("setTokens", ttsFiles.tokens.absolutePath)
            call("setDictDir", ttsFiles.dictDir.absolutePath)
        }
        trace("tts_vits_config_done")
        val model = newSherpa("OfflineTtsModelConfig").apply {
            call("setVits", vits)
            call("setNumThreads", numThreads)
            call("setProvider", "cpu")
        }
        trace("tts_model_config_done")
        val config = newSherpa("OfflineTtsConfig").apply {
            call("setModel", model)
            call("setRuleFsts", ttsFiles.ruleFsts.joinToString(",") { it.absolutePath })
            call("setMaxNumSentences", 2)
        }
        trace("tts_config_done")
        trace("tts_ctor_start")
        return ctor("OfflineTts", null, config).also {
            trace("tts_ctor_done")
            Log.i(TAG, "TTS create done")
        }
    }

    private fun transcribePcm16Blocking(pcm16: ByteArray): EdgeSpeechResult {
        val asrFiles = files.asr ?: return EdgeSpeechResult(
            ok = false,
            error = "ASR model files are missing",
        )
        if (!runtimeAvailable()) {
            return EdgeSpeechResult(ok = false, error = "sherpa-onnx AAR is not packaged")
        }
        val samples = pcm16ToFloat32(pcm16)
        var text = ""
        val elapsed = measureTimeMillis {
            try {
                val localRecognizer = recognizer ?: createOnlineRecognizer(asrFiles).also { recognizer = it }
                val stream = localRecognizer.call("createStream", "")
                    ?: throw IllegalStateException("sherpa-onnx did not create an ASR stream")
                try {
                    Log.i(TAG, "ASR accept waveform samples=${samples.size}")
                    stream.call("acceptWaveform", samples, 16_000)
                    stream.call("inputFinished")
                    var guard = 0
                    while (localRecognizer.call("isReady", stream) as Boolean && guard < 1024) {
                        localRecognizer.call("decode", stream)
                        guard += 1
                    }
                    Log.i(TAG, "ASR decode done iterations=$guard")
                    val result = localRecognizer.call("getResult", stream)
                        ?: throw IllegalStateException("sherpa-onnx returned no ASR result")
                    text = result.call("getText") as? String ?: ""
                } finally {
                    stream.callQuietly("release")
                }
            } catch (error: Throwable) {
                return EdgeSpeechResult(
                    ok = false,
                    error = edgeErrorDetail(error, "ASR failed"),
                )
            }
        }
        return EdgeSpeechResult(ok = true, text = text, latencyMs = elapsed)
    }

    private fun synthesizeToWavBlocking(
        text: String,
        outputFile: File,
        sid: Int,
        speed: Float,
    ): EdgeSpeechResult {
        val ttsFiles = files.tts ?: return EdgeSpeechResult(
            ok = false,
            error = "TTS model files are missing",
        )
        if (!runtimeAvailable()) {
            return EdgeSpeechResult(ok = false, error = "sherpa-onnx AAR is not packaged")
        }
        var sampleRate: Int? = null
        val elapsed = measureTimeMillis {
            try {
                val localTts = tts ?: createOfflineTts(ttsFiles).also { tts = it }
                Log.i(TAG, "TTS generate start chars=${text.length}")
                val audio = localTts.call("generate", text, sid, speed)
                    ?: throw IllegalStateException("sherpa-onnx returned no TTS audio")
                Log.i(TAG, "TTS generate done")
                sampleRate = audio.call("getSampleRate") as? Int
                outputFile.parentFile?.mkdirs()
                audio.call("save", outputFile.absolutePath)
                Log.i(TAG, "TTS save done bytes=${outputFile.length()}")
            } catch (error: Throwable) {
                return EdgeSpeechResult(
                    ok = false,
                    error = edgeErrorDetail(error, "TTS failed"),
                )
            }
        }
        return EdgeSpeechResult(ok = true, audioFile = outputFile, sampleRate = sampleRate, latencyMs = elapsed)
    }

    private fun runWithHardTimeout(
        label: String,
        timeoutMs: Long,
        block: () -> EdgeSpeechResult,
    ): EdgeSpeechResult {
        val tracePrefix = label.lowercase()
        trace("${tracePrefix}_timeout_submit")
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "sherpa-${label.lowercase()}").apply { isDaemon = true }
        }
        val future = executor.submit<EdgeSpeechResult> {
            trace("${tracePrefix}_worker_start")
            block()
        }
        val startedMs = System.currentTimeMillis()
        return try {
            trace("${tracePrefix}_timeout_wait")
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (timeout: TimeoutException) {
            future.cancel(true)
            trace("${tracePrefix}_timeout_fired")
            EdgeSpeechResult(
                ok = false,
                latencyMs = System.currentTimeMillis() - startedMs,
                error = "$label exceeded ${timeoutMs}ms",
            )
        } catch (error: ExecutionException) {
            val cause = error.cause ?: error
            EdgeSpeechResult(
                ok = false,
                latencyMs = System.currentTimeMillis() - startedMs,
                error = edgeErrorDetail(cause, "$label failed"),
            )
        } catch (error: Throwable) {
            EdgeSpeechResult(
                ok = false,
                latencyMs = System.currentTimeMillis() - startedMs,
                error = edgeErrorDetail(error, "$label failed"),
            )
        } finally {
            executor.shutdownNow()
            trace("${tracePrefix}_executor_shutdown")
        }
    }

    private fun trace(event: String) {
        val file = debugTraceFile ?: return
        runCatching {
            file.parentFile?.mkdirs()
            file.appendText("${System.currentTimeMillis()} $event\n")
        }
    }
}

fun buildSherpaSpeechEngine(context: Context): SherpaOnnxSpeechEngine {
    val resolver = EdgeModelPathResolver(defaultEdgeModelRoots(context))
    return SherpaOnnxSpeechEngine(context.applicationContext, resolver.resolve())
}

private fun classAvailable(name: String): Boolean =
    runCatching { Class.forName(name) }.isSuccess

private fun newSherpa(simpleName: String): Any =
    Class.forName("com.k2fsa.sherpa.onnx.$simpleName").getDeclaredConstructor().newInstance()

private fun ctor(simpleName: String, vararg args: Any?): Any {
    val clazz = Class.forName("com.k2fsa.sherpa.onnx.$simpleName")
    val ctor = clazz.constructors.firstOrNull { constructor ->
        constructor.parameterTypes.size == args.size &&
            constructor.parameterTypes.zip(args).all { (type, arg) -> type.accepts(arg) }
    } ?: throw NoSuchMethodException("No matching constructor for $simpleName")
    return ctor.newInstance(*args)
}

private fun Any?.callQuietly(name: String) {
    if (this == null) return
    runCatching { call(name) }
}

private fun Any.call(name: String, vararg args: Any): Any? {
    val method = javaClass.methods.firstOrNull { method ->
        method.name == name &&
            method.parameterTypes.size == args.size &&
            method.parameterTypes.zip(args).all { (type, arg) -> type.accepts(arg) }
    } ?: throw NoSuchMethodException("${javaClass.name}.$name(${args.size})")
    return method.invoke(this, *args)
}

private fun Class<*>.accepts(arg: Any?): Boolean =
    when {
        arg == null -> !isPrimitive
        isPrimitive && this == java.lang.Integer.TYPE -> arg is Int
        isPrimitive && this == java.lang.Float.TYPE -> arg is Float
        isPrimitive && this == java.lang.Boolean.TYPE -> arg is Boolean
        isPrimitive && this == java.lang.Long.TYPE -> arg is Long
        else -> isAssignableFrom(arg.javaClass)
    }

private fun pcm16ToFloat32(pcm16: ByteArray): FloatArray {
    val shorts = pcm16.size / 2
    val out = FloatArray(shorts)
    val buffer = ByteBuffer.wrap(pcm16).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until shorts) {
        out[i] = buffer.short / 32768f
    }
    return out
}

private fun edgeErrorDetail(error: Throwable, fallback: String): String {
    val head = error.message ?: error.cause?.message ?: fallback
    val type = error::class.java.name
    return "$type: $head"
}

private const val TAG = "SherpaSpeechEngine"
