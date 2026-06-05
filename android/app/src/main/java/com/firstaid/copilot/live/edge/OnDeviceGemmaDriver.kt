package com.firstaid.copilot.live.edge

import android.content.Context
import java.io.File
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

data class EdgeInferenceResult(
    val ok: Boolean,
    val text: String = "",
    val latencyMs: Long = 0,
    val error: String? = null,
)

enum class GemmaBackendPreference { GpuThenCpu, CpuOnly }

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
    private val backendPreference: GemmaBackendPreference = GemmaBackendPreference.GpuThenCpu,
    private val maxNumTokens: Int = 1536,
) : AutoCloseable {
    private val mutex = Mutex()
    private var engine: Any? = null
    private var backendName: String? = null

    suspend fun prewarm(timeoutMs: Long = 30_000L): EdgeInferenceResult =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                val elapsed = measureTimeMillis {
                    try {
                        withTimeout(timeoutMs) {
                            ensureEngine()
                        }
                    } catch (error: Throwable) {
                        return@withContext EdgeInferenceResult(
                            ok = false,
                            latencyMs = 0,
                            error = edgeErrorDetail(error, "Gemma prewarm failed"),
                        )
                    }
                }
                EdgeInferenceResult(ok = true, latencyMs = elapsed, text = backendName ?: "ready")
            }
        }

    suspend fun generate(
        prompt: String,
        timeoutMs: Long = 1_500L,
    ): EdgeInferenceResult =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                val localEngine = try {
                    ensureEngine()
                } catch (error: Throwable) {
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
                    EdgeInferenceResult(
                        ok = false,
                        latencyMs = System.currentTimeMillis() - startedMs,
                        error = "Gemma generation exceeded ${timeoutMs}ms",
                    )
                } catch (error: ExecutionException) {
                    val cause = error.cause ?: error
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
        engine.callQuietly("close")
        engine = null
    }

    private fun ensureEngine(): Any {
        engine?.let {
            if (it.call("isInitialized") as? Boolean == true) return it
        }
        val attempts = when (backendPreference) {
            GemmaBackendPreference.GpuThenCpu -> listOf(newLitert("Backend\$GPU"), newLitert("Backend\$CPU"))
            GemmaBackendPreference.CpuOnly -> listOf(newLitert("Backend\$CPU"))
        }
        var lastError: Throwable? = null
        for (backend in attempts) {
            try {
                enableLowLatencyFlags(backend)
                val config = newLitert(
                    "EngineConfig",
                    modelFile.absolutePath,
                    backend,
                    null,
                    null,
                    maxNumTokens,
                    null,
                    File(context.cacheDir, "litertlm").absolutePath,
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
        throw IllegalStateException(lastError?.message ?: "Could not initialize LiteRT-LM")
    }

    private fun enableLowLatencyFlags(backend: Any) {
        val flags = litertClass("ExperimentalFlags").getField("INSTANCE").get(null) ?: return
        flags.call("setEnableBenchmark", true)
        flags.call("setEnableSpeculativeDecoding", backend.javaClass.name.endsWith("Backend\$GPU"))
    }

    private fun generateBlocking(localEngine: Any, prompt: String): String {
        val conversation = localEngine.call("createConversation", newLitert("ConversationConfig"))
            ?: throw IllegalStateException("LiteRT-LM did not create a conversation")
        return try {
            val message = conversation.call("sendMessage", prompt, emptyMap<String, Any>())
                ?: throw IllegalStateException("LiteRT-LM returned no response")
            message.textContent()
        } finally {
            conversation.callQuietly("close")
        }
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
