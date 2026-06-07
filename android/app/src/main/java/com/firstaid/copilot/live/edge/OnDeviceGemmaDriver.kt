package com.firstaid.copilot.live.edge

import android.content.Context
import java.io.File
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.math.ceil
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class EdgeInferenceResult(
    val ok: Boolean,
    val text: String = "",
    val latencyMs: Long = 0,
    val error: String? = null,
)

enum class GemmaBackendPreference { GpuThenCpu, GpuOnly, CpuOnly }

fun parseGemmaBackendPreference(raw: String?): GemmaBackendPreference =
    when (raw?.trim()?.lowercase()) {
        "auto", "gpu-then-cpu", "gpu_then_cpu", "fallback" -> GemmaBackendPreference.GpuThenCpu
        "gpu", "gpu-only", "gpu_only", "gpuonly" -> GemmaBackendPreference.GpuOnly
        "cpu", "cpu-only", "cpu_only", "cpuonly" -> GemmaBackendPreference.CpuOnly
        else -> GemmaBackendPreference.CpuOnly
    }

data class GemmaSamplerSettings(
    val topK: Int,
    val topP: Double,
    val temperature: Double,
    val seed: Int,
) {
    companion object {
        val DETERMINISTIC = GemmaSamplerSettings(topK = 1, topP = 1.0, temperature = 0.0, seed = 0)
    }
}

fun parseGemmaSamplerSettings(raw: String?): GemmaSamplerSettings? =
    when (raw?.trim()?.lowercase()) {
        "deterministic", "greedy", "stable", "top1" -> GemmaSamplerSettings.DETERMINISTIC
        else -> null
    }

/**
 * Reflection bridge for LiteRT-LM.
 *
 * LiteRT-LM 0.12.0 is currently compiled with newer Kotlin metadata than this
 * app. Keeping the dependency runtime-only prevents compiler metadata failures,
 * while still packaging the AAR and calling its public Java ABI on-device.
 */
class OnDeviceGemmaDriver(
    private val context: Context,
    private val modelFile: File,
    private val backendPreference: GemmaBackendPreference = GemmaBackendPreference.CpuOnly,
    private val enableGpuSpeculativeDecoding: Boolean = true,
    private val cpuThreads: Int = DEFAULT_CPU_THREADS,
    private val maxNumTokens: Int = DEFAULT_MAX_NUM_TOKENS,
    private val samplerSettings: GemmaSamplerSettings? = null,
) : AutoCloseable {
    private val mutex = Mutex()

    // LiteRT-LM's maxNumTokens is the whole KV-cache budget (prefill + decode), so
    // a prompt longer than this overflows the cache and can SIGSEGV liblitertlm_jni
    // instead of failing cleanly. Reserve room for the decoded answer and refuse
    // anything that would not fit before it ever reaches native sendMessage().
    private val promptTokenBudget: Int = (maxNumTokens - DECODE_TOKEN_RESERVE).coerceAtLeast(1)
    @Volatile
    private var engine: Any? = null
    @Volatile
    private var backendName: String? = null
    @Volatile
    private var activeConversation: Any? = null

    suspend fun prewarm(timeoutMs: Long = 30_000L): EdgeInferenceResult =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                // ensureEngine()/initialize() are blocking native calls with no
                // suspension points, so a coroutine withTimeout() cannot interrupt
                // them. Run on a dedicated thread and enforce a hard bound with
                // future.get(timeout) + cancel(true) instead.
                val executor = Executors.newSingleThreadExecutor { runnable ->
                    Thread(runnable, "litertlm-prewarm").apply { isDaemon = true }
                }
                val future = executor.submit<String> {
                    ensureEngine()
                    backendName ?: "ready"
                }
                val startedMs = System.currentTimeMillis()
                try {
                    val backend = future.get(timeoutMs, TimeUnit.MILLISECONDS)
                    EdgeInferenceResult(
                        ok = true,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        text = backend,
                    )
                } catch (timeout: TimeoutException) {
                    // Initialization is stuck: hard-cancel the worker and report a
                    // bounded "not ready" so UI readiness stays deterministic and
                    // the flow can retry later instead of blocking indefinitely.
                    future.cancel(true)
                    discardEngine()
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = "Gemma prewarm exceeded ${timeoutMs}ms",
                    )
                } catch (error: ExecutionException) {
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = edgeErrorDetail(error.cause ?: error, "Gemma prewarm failed"),
                    )
                } catch (error: Throwable) {
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = edgeErrorDetail(error, "Gemma prewarm failed"),
                    )
                } finally {
                    executor.shutdownNow()
                }
            }
        }

    suspend fun generate(
        prompt: String,
        timeoutMs: Long = 1_500L,
    ): EdgeInferenceResult =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                val estimatedTokens = estimateTokenCount(prompt)
                if (estimatedTokens > promptTokenBudget) {
                    return@withContext EdgeInferenceResult(
                        ok = false,
                        latencyMs = 0,
                        error = "prompt_too_long: $estimatedTokens tokens > $promptTokenBudget",
                    )
                }
                val localEngine = try {
                    ensureEngineWithin(ENGINE_INIT_TIMEOUT_MS)
                } catch (timeout: TimeoutException) {
                    discardEngine()
                    return@withContext EdgeInferenceResult(
                        ok = false,
                        latencyMs = 0,
                        error = "Gemma engine init exceeded ${ENGINE_INIT_TIMEOUT_MS}ms",
                    )
                } catch (error: Throwable) {
                    discardEngine()
                    return@withContext EdgeInferenceResult(
                        ok = false,
                        latencyMs = 0,
                        error = edgeErrorDetail(error, "Gemma engine unavailable"),
                    )
                }
                val executor = Executors.newSingleThreadExecutor { runnable ->
                    Thread(runnable, "litertlm-generate").apply { isDaemon = true }
                }
                val future = executor.submit<String> { generateBlocking(localEngine, prompt) }
                val startedMs = System.currentTimeMillis()
                try {
                    val text = future.get(timeoutMs, TimeUnit.MILLISECONDS)
                    EdgeInferenceResult(
                        ok = true,
                        text = text,
                        latencyMs = System.currentTimeMillis() - startedMs,
                    )
                } catch (timeout: TimeoutException) {
                    future.cancel(true)
                    discardEngine()
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = "Gemma generation exceeded ${timeoutMs}ms",
                    )
                } catch (error: ExecutionException) {
                    val cause = error.cause ?: error
                    if (cause.message?.contains("session already exists", ignoreCase = true) == true) {
                        discardEngine()
                    }
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = edgeErrorDetail(cause, "Gemma inference failed"),
                    )
                } catch (error: Throwable) {
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = edgeErrorDetail(error, "Gemma inference failed"),
                    )
                } finally {
                    executor.shutdownNow()
                }
            }
        }

    override fun close() {
        cancelActiveConversation()
        resetEngine()
    }

    private fun ensureEngineWithin(timeoutMs: Long): Any {
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "litertlm-engine-init").apply { isDaemon = true }
        }
        val future = executor.submit<Any> { ensureEngine() }
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: ExecutionException) {
            throw error.cause ?: error
        } finally {
            future.cancel(true)
            executor.shutdownNow()
        }
    }

    private fun ensureEngine(): Any {
        engine?.let {
            if (it.call("isInitialized") as? Boolean == true) return it
        }
        val attempts = when (backendPreference) {
            GemmaBackendPreference.GpuThenCpu -> listOf(newLitert("Backend\$GPU"), newCpuBackend())
            GemmaBackendPreference.GpuOnly -> listOf(newLitert("Backend\$GPU"))
            GemmaBackendPreference.CpuOnly -> listOf(newCpuBackend())
        }
        var lastError: Throwable? = null
        for (backend in attempts) {
            try {
                enableLowLatencyFlags(backend)
                val litertCacheDir = File(context.cacheDir, "litertlm").apply { mkdirs() }
                val config = newLitert(
                    "EngineConfig",
                    modelFile.absolutePath,
                    backend,
                    null,
                    null,
                    maxNumTokens,
                    null,
                    litertCacheDir.absolutePath,
                )
                val candidate = newLitert("Engine", config)
                candidate.call("initialize")
                engine = candidate
                backendName = backend.call("getName") as? String ?: backend.javaClass.simpleName
                return candidate
            } catch (error: Throwable) {
                lastError = error
            }
        }
        val cause = lastError ?: IllegalStateException("Could not initialize LiteRT-LM")
        throw IllegalStateException(edgeErrorDetail(cause, "Could not initialize LiteRT-LM"), cause)
    }

    private fun enableLowLatencyFlags(backend: Any) {
        val flags = litertClass("ExperimentalFlags").getField("INSTANCE").get(null) ?: return
        flags.call("setEnableBenchmark", false)
        flags.call(
            "setEnableSpeculativeDecoding",
            backend.javaClass.name.endsWith("Backend\$GPU") && enableGpuSpeculativeDecoding,
        )
    }

    private fun newCpuBackend(): Any =
        if (cpuThreads > 0) newLitert("Backend\$CPU", cpuThreads) else newLitert("Backend\$CPU")

    private fun generateBlocking(localEngine: Any, prompt: String): String {
        val conversation = localEngine.call("createConversation", newConversationConfig())
            ?: throw IllegalStateException("LiteRT-LM did not create a conversation")
        activeConversation = conversation
        return try {
            val message = conversation.call("sendMessage", prompt, emptyMap<String, Any>())
                ?: throw IllegalStateException("LiteRT-LM returned no response")
            message.textContent()
        } finally {
            conversation.callQuietly("close")
            if (activeConversation === conversation) {
                activeConversation = null
            }
        }
    }

    private fun newConversationConfig(): Any {
        val sampler = samplerSettings?.let {
            newLitert("SamplerConfig", it.topK, it.topP, it.temperature, it.seed)
        } ?: return newLitert("ConversationConfig")
        return newLitert(
            "ConversationConfig",
            null,
            emptyList<Any>(),
            emptyList<Any>(),
            sampler,
        )
    }

    private fun cancelActiveConversation() {
        activeConversation?.let { conversation ->
            conversation.callQuietly("cancelProcess")
            conversation.callQuietly("close")
            activeConversation = null
        }
    }

    private fun resetEngine() {
        engine.callQuietly("close")
        engine = null
        backendName = null
    }

    private fun discardEngine() {
        val staleEngine = engine
        val staleConversation = activeConversation
        engine = null
        activeConversation = null
        backendName = null
        if (staleEngine == null && staleConversation == null) return
        Thread({
            staleConversation.callQuietly("cancelProcess")
            staleConversation.callQuietly("close")
            staleEngine.callQuietly("close")
        }, "litertlm-discard").apply { isDaemon = true }.start()
    }

    private fun estimateTokenCount(prompt: String): Int {
        var cjkChars = 0
        var otherChars = 0
        var index = 0
        while (index < prompt.length) {
            val codePoint = prompt.codePointAt(index)
            index += Character.charCount(codePoint)
            if (isCjkLike(codePoint)) cjkChars += 1 else otherChars += 1
        }
        return ceil(cjkChars * CJK_TOKENS_PER_CHAR + otherChars / OTHER_CHARS_PER_TOKEN).toInt()
    }

    private fun isCjkLike(codePoint: Int): Boolean =
        codePoint in 0x3000..0x303F ||
            codePoint in 0x3400..0x9FFF ||
            codePoint in 0xF900..0xFAFF ||
            codePoint in 0xFF00..0xFFEF ||
            codePoint in 0x20000..0x2FA1F

    companion object {
        const val DEFAULT_CPU_THREADS = 0
        const val DEFAULT_MAX_NUM_TOKENS = 4096
        private const val DECODE_TOKEN_RESERVE = 512
        private const val ENGINE_INIT_TIMEOUT_MS = 60_000L
        private const val CJK_TOKENS_PER_CHAR = 1.2
        private const val OTHER_CHARS_PER_TOKEN = 3.0
    }
}

private const val LITERT_PACKAGE = "com.google.ai.edge.litertlm"

private fun Any?.callQuietly(name: String) {
    if (this == null) return
    runCatching { call(name) }
}

private fun newLitert(simpleName: String, vararg args: Any?): Any {
    val clazz = litertClass(simpleName)
    val constructor = clazz.constructors.firstOrNull { candidate ->
        candidate.parameterTypes.size == args.size &&
            candidate.parameterTypes.zip(args).all { (type, arg) -> type.accepts(arg) }
    } ?: throw NoSuchMethodException("No matching constructor for $simpleName")
    return constructor.newInstance(*args)
}

private fun litertClass(simpleName: String): Class<*> = Class.forName("$LITERT_PACKAGE.$simpleName")

private fun Any.call(name: String, vararg args: Any?): Any? {
    val method = javaClass.methods.firstOrNull { candidate ->
        candidate.name == name &&
            candidate.parameterTypes.size == args.size &&
            candidate.parameterTypes.zip(args).all { (type, arg) -> type.accepts(arg) }
    } ?: throw NoSuchMethodException("${javaClass.name}.$name(${args.size})")
    return method.invoke(this, *args)
}

private fun Class<*>.accepts(arg: Any?): Boolean =
    when {
        arg == null -> !isPrimitive
        isPrimitive && this == java.lang.Integer.TYPE -> arg is Int
        isPrimitive && this == java.lang.Float.TYPE -> arg is Float
        isPrimitive && this == java.lang.Double.TYPE -> arg is Double
        isPrimitive && this == java.lang.Boolean.TYPE -> arg is Boolean
        isPrimitive && this == java.lang.Long.TYPE -> arg is Long
        else -> isAssignableFrom(arg.javaClass)
    }

private fun Any?.textContent(): String {
    if (this == null) return ""
    val contents = call("getContents") ?: return ""
    val items = contents.call("getContents") as? List<*> ?: return ""
    return items.joinToString(separator = "") { item ->
        if (item?.javaClass?.name == "$LITERT_PACKAGE.Content\$Text") {
            item.call("getText") as? String ?: ""
        } else {
            ""
        }
    }
}

private fun edgeErrorDetail(error: Throwable, fallback: String): String {
    val head = error.message ?: error.cause?.message ?: fallback
    val type = error::class.java.name
    return "$type: $head"
}
