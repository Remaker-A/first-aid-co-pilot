package com.firstaid.copilot.live.edge

import android.app.Activity
import android.content.Context
import android.media.MediaPlayer
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

class EdgeModelSmokeActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        statusView = TextView(this).apply {
            text = "Running edge model smoke..."
            textSize = 16f
            setPadding(32, 32, 32, 32)
        }
        setContentView(statusView)

        scope.launch {
            val result = runCatching { runSmoke() }
                .getOrElse { error ->
                    JSONObject()
                        .put("ok", false)
                        .put("error", error.stackTraceToString())
                }
            if (result.optString("mode") == GEMMA_SUITE_MODE) {
                writeGemmaSuiteCheckpoint(result, "finished")
            } else {
                writeCheckpoint(result, "finished")
            }
            Log.i(TAG, "Edge model smoke result: $result")
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun runSmoke(): JSONObject {
        val appContext = applicationContext
        val mode = intent.getStringExtra("mode")
            ?.lowercase()
            ?.takeIf { it in setOf("all", "gemma", "tts", "asr", GEMMA_SUITE_MODE) }
            ?: "all"
        val runs = intent.getIntExtra("runs", 1).coerceIn(1, 20)
        val threads = intent.getIntExtra("threads", 2).coerceIn(1, 8)
        val ttsText = intent.getStringExtra("ttsText")?.takeIf { it.isNotBlank() } ?: DEFAULT_TTS_TEXT
        val asrSampleName = intent.getStringExtra("asrSample")?.takeIf { it.isNotBlank() } ?: "0.wav"
        val asrMaxMs = intent.getIntExtra("asrMaxMs", 0).coerceAtLeast(0)
        val gemmaPrompt = intent.getStringExtra("gemmaPrompt")?.takeIf { it.isNotBlank() }
            ?: GEMMA_BENCH_DEFAULT_PROMPT
        val gemmaBackendPreference = parseGemmaBackendPreference(intent.getStringExtra("gemmaBackend"))
        val gemmaSpeculative = intent.getStringExtra("gemmaSpeculative")
            ?.trim()
            ?.lowercase()
            ?.let { it !in setOf("0", "false", "off", "no") }
            ?: true
        val gemmaCpuThreads = intent.getIntExtra("gemmaCpuThreads", OnDeviceGemmaDriver.DEFAULT_CPU_THREADS)
            .coerceIn(0, 8)
        val gemmaMaxNumTokens = intent.getIntExtra(
            "gemmaMaxNumTokens",
            OnDeviceGemmaDriver.DEFAULT_MAX_NUM_TOKENS,
        ).coerceIn(512, 8192)
        val gemmaSamplerName = intent.getStringExtra("gemmaSampler")
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.isNotBlank() }
            ?: "default"
        val gemmaSamplerSettings = parseGemmaSamplerSettings(gemmaSamplerName)
        val gemmaGateMs = intent.getIntExtra("gemmaGateMs", GEMMA_NEAR_REALTIME_GATE_MS.toInt())
            .coerceIn(1, 60_000).toLong()
        val gemmaBudgetMs = intent.getIntExtra("gemmaBudgetMs", GEMMA_GENERATE_BUDGET_MS.toInt())
            .coerceIn(1, 60_000).toLong()
        val gemmaTimeoutMs = intent.getIntExtra("gemmaTimeoutMs", GEMMA_BENCH_TIMEOUT_MS.toInt())
            .coerceIn(1_000, 60_000).toLong()
        if (mode == GEMMA_SUITE_MODE) {
            // Isolated branch: never touches the speech engine or the smoke report.
            val suiteRuns = intent.getIntExtra("runs", 3).coerceIn(1, 20)
            return runGemmaSuite(
                appContext,
                suiteRuns,
                gemmaTimeoutMs,
                gemmaGateMs,
                gemmaBudgetMs,
                gemmaBackendPreference,
                gemmaSpeculative,
                gemmaCpuThreads,
                gemmaMaxNumTokens,
                gemmaSamplerName,
                gemmaSamplerSettings,
            )
        }
        fun shouldRun(target: String): Boolean = mode == "all" || mode == target
        sherpaTraceFile().delete()
        val files = EdgeModelPathResolver(defaultEdgeModelRoots(appContext)).resolve()
        val speechEngine = SherpaOnnxSpeechEngine(
            appContext,
            files,
            numThreads = threads,
            debugTraceFile = sherpaTraceFile(),
        )
        speechEngine.use { engine ->
            val report = inspectEdgeModels(appContext, engine.runtimeAvailable())
            val result = JSONObject()
                .put("ok", false)
                .put("mode", mode)
                .put("runs", runs)
                .put("threads", threads)
                .put("gemmaBackendPreference", gemmaBackendPreference.name)
                .put("gemmaSpeculative", gemmaSpeculative)
                .put("gemmaCpuThreads", gemmaCpuThreads)
                .put("gemmaMaxNumTokens", gemmaMaxNumTokens)
                .put("gemmaSampler", gemmaSamplerName)
                .put("modelRoot", report.root)
                .put("summary", report.summaryLine())
                .put("gemmaReady", report.gemmaReady)
                .put("asrReady", report.asrReady)
                .put("ttsReady", report.ttsReady)
            writeCheckpoint(result, "models_inspected")

            val gemmaPath = report.status(EdgeModelKind.Gemma).path
            if (shouldRun("gemma") && gemmaPath != null) {
                val gemma = OnDeviceGemmaDriver(
                    appContext,
                    File(gemmaPath),
                    backendPreference = gemmaBackendPreference,
                    enableGpuSpeculativeDecoding = gemmaSpeculative,
                    cpuThreads = gemmaCpuThreads,
                    maxNumTokens = gemmaMaxNumTokens,
                    samplerSettings = gemmaSamplerSettings,
                )
                try {
                    writeCheckpoint(result, "gemma_prewarm_start")
                    val warm = withTimeout(60_000L) { gemma.prewarm(55_000L) }
                    writeCheckpoint(
                        result.put(
                            "gemma",
                            JSONObject()
                                .put("ok", warm.ok)
                                .put("latencyMs", warm.latencyMs)
                                .put("backend", warm.text)
                                .put("error", warm.error),
                        ),
                        "gemma_prewarm_done",
                    )
                    if (warm.ok) {
                        // Warm-up generation primes the LiteRT graph; excluded from p50/p95.
                        writeCheckpoint(result, "gemma_generate_warm_start")
                        val warmGen = withTimeout(gemmaTimeoutMs + 5_000L) {
                            gemma.generate(gemmaPrompt, timeoutMs = gemmaTimeoutMs)
                        }
                        writeCheckpoint(
                            result.put(
                                "gemma",
                                JSONObject()
                                    .put("ok", warm.ok)
                                    .put("latencyMs", warm.latencyMs)
                                    .put("backend", warm.text)
                                    .put("prompt", gemmaPrompt)
                                    .put("warmGenerateOk", warmGen.ok)
                                    .put("warmGenerateLatencyMs", warmGen.latencyMs)
                                    .put("warmGenerateError", warmGen.error)
                                    .put("error", warm.error),
                            ),
                            "gemma_generate_warm_done",
                        )

                        // Measured short-answer runs -> p50/p95 -> WB near-realtime gate.
                        writeCheckpoint(result, "gemma_generate_measured_start")
                        val measuredRuns = JSONArray()
                        val okLatencies = mutableListOf<Long>()
                        var lastGen = warmGen
                        repeat(runs) { index ->
                            val gen = withTimeout(gemmaTimeoutMs + 5_000L) {
                                gemma.generate(gemmaPrompt, timeoutMs = gemmaTimeoutMs)
                            }
                            lastGen = gen
                            if (gen.ok && gen.text.isNotBlank()) {
                                okLatencies += gen.latencyMs
                            }
                            measuredRuns.put(
                                JSONObject()
                                    .put("ok", gen.ok)
                                    .put("latencyMs", gen.latencyMs)
                                    .put("text", gen.text.take(80))
                                    .put("error", gen.error),
                            )
                            writeCheckpoint(
                                result.put("gemmaRuns", measuredRuns),
                                "gemma_generate_measured_${index + 1}_done",
                            )
                        }

                        val gate = gemmaLatencyGate(
                            okLatenciesMs = okLatencies,
                            totalRuns = runs,
                            gateMs = gemmaGateMs,
                            budgetMs = gemmaBudgetMs,
                        )
                        result.put(
                            "gemma",
                            JSONObject()
                                .put("ok", warm.ok)
                                .put("latencyMs", warm.latencyMs)
                                .put("backend", warm.text)
                                .put("prompt", gemmaPrompt)
                                .put("generateOk", runs > 0 && okLatencies.size == runs)
                                .put("generateLatencyMs", lastGen.latencyMs)
                                .put("generateText", lastGen.text.take(80))
                                .put("generateError", lastGen.error)
                                .put("warmGenerateOk", warmGen.ok)
                                .put("warmGenerateLatencyMs", warmGen.latencyMs)
                                .put("runs", measuredRuns)
                                .put("latency", gate.stats.toJson())
                                .put("gate", gate.toJson())
                                .put("error", warm.error),
                        )
                        writeCheckpoint(result, "gemma_done")
                    } else {
                        result.put(
                            "gemma",
                            JSONObject()
                                .put("ok", false)
                                .put("latencyMs", warm.latencyMs)
                                .put("backend", warm.text)
                                .put("prompt", gemmaPrompt)
                                .put("generateOk", false)
                                .put("generateError", "prewarm failed")
                                .put("error", warm.error),
                        )
                        writeCheckpoint(result, "gemma_done")
                    }
                } finally {
                    gemma.close()
                }
            }

            if (shouldRun("tts")) {
                writeCheckpoint(result, "tts_warm_start")
                val warmTts = withTimeout(45_000L) {
                    engine.synthesizeToWav(ttsText, File(cacheDir, "edge-smoke/tts-warm.wav"))
                }
                writeCheckpoint(
                    result.put(
                        "tts",
                        JSONObject()
                            .put("warmOk", warmTts.ok)
                            .put("warmLatencyMs", warmTts.latencyMs)
                            .put("warmError", warmTts.error),
                    ),
                    "tts_warm_done",
                )
                writeCheckpoint(result, "tts_measured_start")
                val measuredRuns = JSONArray()
                var okCount = 0
                var latencySum = 0L
                var minLatency: Long? = null
                var maxLatency: Long? = null
                var lastTts = warmTts
                repeat(runs) { index ->
                    val measuredTts = withTimeout(45_000L) {
                        engine.synthesizeToWav(
                            ttsText,
                            File(cacheDir, "edge-smoke/tts-measured-${index + 1}.wav"),
                        )
                    }
                    lastTts = measuredTts
                    if (measuredTts.ok) {
                        okCount += 1
                        latencySum += measuredTts.latencyMs
                        minLatency = minOf(minLatency ?: measuredTts.latencyMs, measuredTts.latencyMs)
                        maxLatency = maxOf(maxLatency ?: measuredTts.latencyMs, measuredTts.latencyMs)
                    }
                    measuredRuns.put(
                        JSONObject()
                            .put("ok", measuredTts.ok)
                            .put("latencyMs", measuredTts.latencyMs)
                            .put("sampleRate", measuredTts.sampleRate)
                            .put("bytes", measuredTts.audioFile?.length() ?: 0L)
                            .put("error", measuredTts.error),
                    )
                    writeCheckpoint(result.put("ttsRuns", measuredRuns), "tts_measured_${index + 1}_done")
                }
                result.put(
                    "tts",
                    JSONObject()
                        .put("ok", okCount == runs)
                        .put("text", ttsText)
                        .put("warmLatencyMs", warmTts.latencyMs)
                        .put("cachedStartLatencyMs", warmTts.audioFile?.measureMediaPlayerStartMs() ?: JSONObject.NULL)
                        .put("latencyMs", lastTts.latencyMs)
                        .put("avgLatencyMs", if (okCount > 0) latencySum.toDouble() / okCount else JSONObject.NULL)
                        .put("minLatencyMs", minLatency ?: JSONObject.NULL)
                        .put("maxLatencyMs", maxLatency ?: JSONObject.NULL)
                        .put("sampleRate", lastTts.sampleRate)
                        .put("bytes", lastTts.audioFile?.length() ?: 0L)
                        .put("runs", measuredRuns)
                        .put("error", lastTts.error),
                )
                writeCheckpoint(result, "tts_done")
            }

            val asrSample = files.asr?.modelDir?.resolve("test_wavs/$asrSampleName")
            if (shouldRun("asr") && asrSample?.isFile == true) {
                val asrInput = asrSample.readPcm16Data().limitPcm16Duration(asrMaxMs)
                writeCheckpoint(result.put("asrInputBytes", asrInput.size), "asr_warm_start")
                val warmAsr = withTimeout(60_000L) { engine.transcribePcm16(asrInput) }
                writeCheckpoint(
                    result.put(
                        "asr",
                        JSONObject()
                            .put("warmOk", warmAsr.ok)
                            .put("warmLatencyMs", warmAsr.latencyMs)
                            .put("warmText", warmAsr.text)
                            .put("warmError", warmAsr.error),
                    ),
                    "asr_warm_done",
                )
                val measuredRuns = JSONArray()
                var okCount = 0
                var latencySum = 0L
                var minLatency: Long? = null
                var maxLatency: Long? = null
                var lastAsr = warmAsr
                repeat(runs) { index ->
                    val asr = withTimeout(60_000L) { engine.transcribePcm16(asrInput) }
                    lastAsr = asr
                    if (asr.ok && asr.text.isNotBlank()) {
                        okCount += 1
                        latencySum += asr.latencyMs
                        minLatency = minOf(minLatency ?: asr.latencyMs, asr.latencyMs)
                        maxLatency = maxOf(maxLatency ?: asr.latencyMs, asr.latencyMs)
                    }
                    measuredRuns.put(
                        JSONObject()
                            .put("ok", asr.ok)
                            .put("latencyMs", asr.latencyMs)
                            .put("text", asr.text)
                            .put("error", asr.error),
                    )
                    writeCheckpoint(result.put("asrRuns", measuredRuns), "asr_measured_${index + 1}_done")
                }
                result.put(
                    "asr",
                    JSONObject()
                        .put("ok", okCount == runs)
                        .put("sample", asrSampleName)
                        .put("inputMs", asrInput.size / BYTES_PER_SAMPLE * 1000 / ASR_SAMPLE_RATE)
                        .put("inputBytes", asrInput.size)
                        .put("warmLatencyMs", warmAsr.latencyMs)
                        .put("latencyMs", lastAsr.latencyMs)
                        .put("avgLatencyMs", if (okCount > 0) latencySum.toDouble() / okCount else JSONObject.NULL)
                        .put("minLatencyMs", minLatency ?: JSONObject.NULL)
                        .put("maxLatencyMs", maxLatency ?: JSONObject.NULL)
                        .put("text", lastAsr.text)
                        .put("runs", measuredRuns)
                        .put("error", lastAsr.error),
                )
                writeCheckpoint(result, "asr_done")
            } else if (shouldRun("asr")) {
                result.put("asr", JSONObject().put("ok", false).put("error", "sample wav missing"))
                writeCheckpoint(result, "asr_missing_sample")
            }

            val gemmaOk = !shouldRun("gemma") || (
                report.gemmaReady &&
                    result.optJSONObject("gemma")?.optBoolean("ok") == true &&
                    result.optJSONObject("gemma")?.optBoolean("generateOk") == true &&
                    result.optJSONObject("gemma")?.optString("generateText").orEmpty().isNotBlank()
                )
            val asrOk = !shouldRun("asr") || (
                report.asrReady &&
                    result.optJSONObject("asr")?.optBoolean("ok") == true &&
                    result.optJSONObject("asr")?.optString("text").orEmpty().isNotBlank()
                )
            val ttsOk = !shouldRun("tts") || (
                report.ttsReady &&
                    result.optJSONObject("tts")?.optBoolean("ok") == true
                )
            val ok = gemmaOk && asrOk && ttsOk
            return result.put("ok", ok)
        }
    }

    private suspend fun runGemmaSuite(
        appContext: Context,
        runs: Int,
        gemmaTimeoutMs: Long,
        gemmaGateMs: Long,
        gemmaBudgetMs: Long,
        gemmaBackendPreference: GemmaBackendPreference,
        gemmaSpeculative: Boolean,
        gemmaCpuThreads: Int,
        gemmaMaxNumTokens: Int,
        gemmaSamplerName: String,
        gemmaSamplerSettings: GemmaSamplerSettings?,
    ): JSONObject {
        val report = JSONObject()
            .put("ok", false)
            .put("mode", GEMMA_SUITE_MODE)
            .put("runs", runs)
            .put("backendPreference", gemmaBackendPreference.name)
            .put("gemmaSpeculative", gemmaSpeculative)
            .put("gemmaCpuThreads", gemmaCpuThreads)
            .put("gemmaMaxNumTokens", gemmaMaxNumTokens)
            .put("gemmaSampler", gemmaSamplerName)
            .put("backend", JSONObject.NULL)
            .put("prewarmOk", false)
            .put("prewarmLatencyMs", 0L)
            .put("functions", JSONObject())

        val gemmaPath = EdgeModelPathResolver(defaultEdgeModelRoots(appContext)).resolve().gemma?.absolutePath
        if (gemmaPath == null) {
            report.put("ok", false).put("error", "Gemma LiteRT-LM model missing")
            writeGemmaSuiteCheckpoint(report, "finished")
            return report
        }

        writeGemmaSuiteCheckpoint(report, "gemma_prewarm_start")
        val gemma = OnDeviceGemmaDriver(
            appContext,
            File(gemmaPath),
            backendPreference = gemmaBackendPreference,
            enableGpuSpeculativeDecoding = gemmaSpeculative,
            cpuThreads = gemmaCpuThreads,
            maxNumTokens = gemmaMaxNumTokens,
            samplerSettings = gemmaSamplerSettings,
        )
        try {
            val warm = withTimeout(60_000L) { gemma.prewarm(55_000L) }
            val backendValue: Any = warm.text.ifBlank { null } ?: JSONObject.NULL
            report.put("backend", backendValue)
                .put("prewarmOk", warm.ok)
                .put("prewarmLatencyMs", warm.latencyMs)
            writeGemmaSuiteCheckpoint(report, "gemma_prewarm_done")
            if (!warm.ok) {
                report.put("ok", false).put("error", warm.error ?: "Gemma prewarm failed")
                writeGemmaSuiteCheckpoint(report, "finished")
                return report
            }

            val checkpoint: (JSONObject) -> Unit = { progress ->
                progress.put("backend", backendValue)
                    .put("backendPreference", gemmaBackendPreference.name)
                    .put("gemmaSpeculative", gemmaSpeculative)
                    .put("gemmaCpuThreads", gemmaCpuThreads)
                    .put("gemmaMaxNumTokens", gemmaMaxNumTokens)
                    .put("gemmaSampler", gemmaSamplerName)
                    .put("prewarmOk", warm.ok)
                    .put("prewarmLatencyMs", warm.latencyMs)
                writeGemmaSuiteCheckpoint(progress, progress.optString("phase").ifBlank { "running" })
            }
            val suiteReport = GemmaFunctionSuite(
                appContext,
                intent.getStringExtra("suiteDir")?.takeIf { it.isNotBlank() } ?: "gemma_suite",
            ).run(
                driver = gemma,
                defaultRuns = runs,
                timeoutMs = gemmaTimeoutMs,
                gateMs = gemmaGateMs,
                budgetMs = gemmaBudgetMs,
                checkpoint = checkpoint,
            )
            suiteReport.put("backend", backendValue)
                .put("backendPreference", gemmaBackendPreference.name)
                .put("gemmaSpeculative", gemmaSpeculative)
                .put("gemmaCpuThreads", gemmaCpuThreads)
                .put("gemmaMaxNumTokens", gemmaMaxNumTokens)
                .put("gemmaSampler", gemmaSamplerName)
                .put("prewarmOk", warm.ok)
                .put("prewarmLatencyMs", warm.latencyMs)
            writeGemmaSuiteCheckpoint(suiteReport, "finished")
            return suiteReport
        } finally {
            gemma.close()
        }
    }

    private fun gemmaSuiteOutputFile(): File =
        smokeOutputFile().parentFile?.resolve("gemma-suite.json")
            ?: File(filesDir, "smoke/gemma-suite.json")

    private fun writeGemmaSuiteCheckpoint(report: JSONObject, phase: String) {
        report.put("phase", phase)
        report.put("updatedAtMs", System.currentTimeMillis())
        val rendered = report.toString(2)
        val output = gemmaSuiteOutputFile()
        output.parentFile?.mkdirs()
        output.writeText(rendered)
        statusView.text = rendered
        Log.i(TAG, "Gemma suite phase=$phase")
    }

    private fun smokeOutputFile(): File {
        val media = externalMediaDirs.firstOrNull()
        return (media ?: filesDir).resolve("smoke/edge-model-smoke.json")
    }

    private fun sherpaTraceFile(): File =
        smokeOutputFile().parentFile?.resolve("sherpa-debug.txt")
            ?: File(filesDir, "smoke/sherpa-debug.txt")

    private fun writeCheckpoint(result: JSONObject, phase: String) {
        result.put("phase", phase)
        result.put("updatedAtMs", System.currentTimeMillis())
        val output = smokeOutputFile()
        output.parentFile?.mkdirs()
        output.writeText(result.toString(2))
        statusView.text = result.toString(2)
        Log.i(TAG, "Edge model smoke phase=$phase")
    }

    private fun File.readPcm16Data(): ByteArray {
        val bytes = readBytes()
        require(bytes.size > 44) { "WAV too small: $absolutePath" }
        require(String(bytes, 0, 4) == "RIFF") { "Not a RIFF WAV: $absolutePath" }
        var offset = 12
        while (offset + 8 <= bytes.size) {
            val id = String(bytes, offset, 4)
            val size = ByteBuffer.wrap(bytes, offset + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            val dataStart = offset + 8
            if (id == "data") {
                return bytes.copyOfRange(dataStart, dataStart + size)
            }
            offset = dataStart + size + (size and 1)
        }
        error("No data chunk in WAV: $absolutePath")
    }

    private fun ByteArray.limitPcm16Duration(maxMs: Int): ByteArray {
        if (maxMs <= 0) return this
        val maxBytes = maxMs * ASR_SAMPLE_RATE / 1000 * BYTES_PER_SAMPLE
        val evenBytes = minOf(size, maxBytes).let { it - (it % BYTES_PER_SAMPLE) }
        return copyOfRange(0, evenBytes)
    }

    private fun File.measureMediaPlayerStartMs(): Long? =
        takeIf { it.isFile && it.length() > 0L }?.let { wav ->
            var player: MediaPlayer? = null
            try {
                measureTimeMillis {
                    player = MediaPlayer().apply {
                        setDataSource(wav.absolutePath)
                        prepare()
                        start()
                    }
                }
            } finally {
                runCatching { player?.stop() }
                runCatching { player?.release() }
            }
        }

    private fun LatencyStats.toJson(): JSONObject =
        JSONObject()
            .put("count", count)
            .put("avgMs", avgMs ?: JSONObject.NULL)
            .put("minMs", minMs ?: JSONObject.NULL)
            .put("maxMs", maxMs ?: JSONObject.NULL)
            .put("p50Ms", p50Ms ?: JSONObject.NULL)
            .put("p95Ms", p95Ms ?: JSONObject.NULL)

    private fun GemmaLatencyGate.toJson(): JSONObject =
        JSONObject()
            .put("gateMs", gateMs)
            .put("budgetMs", budgetMs)
            .put("totalRuns", totalRuns)
            .put("okRuns", okRuns)
            .put("withinBudgetRuns", withinBudgetRuns)
            .put("p50Ms", stats.p50Ms ?: JSONObject.NULL)
            .put("p95Ms", stats.p95Ms ?: JSONObject.NULL)
            .put("nearRealtimeCapable", nearRealtimeCapable)
            .put("recommendation", recommendation)

    private companion object {
        const val TAG = "EdgeModelSmoke"
        const val GEMMA_SUITE_MODE = "gemma-suite"
        const val DEFAULT_TTS_TEXT = "\u7ee7\u7eed\u6309\u538b"
        const val ASR_SAMPLE_RATE = 16_000
        const val BYTES_PER_SAMPLE = 2
    }
}
