package com.firstaid.copilot.live.edge

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
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
            writeCheckpoint(result, "finished")
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
            ?.takeIf { it in setOf("all", "gemma", "tts", "asr") }
            ?: "all"
        fun shouldRun(target: String): Boolean = mode == "all" || mode == target
        sherpaTraceFile().delete()
        val files = EdgeModelPathResolver(defaultEdgeModelRoots(appContext)).resolve()
        val speechEngine = SherpaOnnxSpeechEngine(
            appContext,
            files,
            debugTraceFile = sherpaTraceFile(),
        )
        speechEngine.use { engine ->
            val report = inspectEdgeModels(appContext, engine.runtimeAvailable())
            val result = JSONObject()
                .put("ok", false)
                .put("mode", mode)
                .put("modelRoot", report.root)
                .put("summary", report.summaryLine())
                .put("gemmaReady", report.gemmaReady)
                .put("asrReady", report.asrReady)
                .put("ttsReady", report.ttsReady)
            writeCheckpoint(result, "models_inspected")

            val gemmaPath = report.status(EdgeModelKind.Gemma).path
            if (shouldRun("gemma") && gemmaPath != null) {
                val gemma = OnDeviceGemmaDriver(appContext, File(gemmaPath))
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
                    val generated = if (warm.ok) {
                        writeCheckpoint(result, "gemma_generate_start")
                        withTimeout(20_000L) {
                            gemma.generate("Reply with exactly: OK", timeoutMs = 15_000L)
                        }
                    } else {
                        EdgeInferenceResult(ok = false, error = "prewarm failed")
                    }
                    result.put(
                        "gemma",
                        JSONObject()
                            .put("ok", warm.ok)
                            .put("latencyMs", warm.latencyMs)
                            .put("backend", warm.text)
                            .put("generateOk", generated.ok)
                            .put("generateLatencyMs", generated.latencyMs)
                            .put("generateText", generated.text.take(80))
                            .put("generateError", generated.error)
                            .put("error", warm.error),
                    )
                    writeCheckpoint(result, "gemma_done")
                } finally {
                    gemma.close()
                }
            }

            if (shouldRun("tts")) {
                writeCheckpoint(result, "tts_warm_start")
                val warmTts = withTimeout(45_000L) {
                    engine.synthesizeToWav("继续按压", File(cacheDir, "edge-smoke/tts-warm.wav"))
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
                val measuredTts = withTimeout(45_000L) {
                    engine.synthesizeToWav("继续按压", File(cacheDir, "edge-smoke/tts-measured.wav"))
                }
                result.put(
                    "tts",
                    JSONObject()
                        .put("ok", measuredTts.ok)
                        .put("warmLatencyMs", warmTts.latencyMs)
                        .put("latencyMs", measuredTts.latencyMs)
                        .put("sampleRate", measuredTts.sampleRate)
                        .put("bytes", measuredTts.audioFile?.length() ?: 0L)
                        .put("error", measuredTts.error),
                )
                writeCheckpoint(result, "tts_done")
            }

            val asrSample = files.asr?.modelDir?.resolve("test_wavs/0.wav")
            if (shouldRun("asr") && asrSample?.isFile == true) {
                writeCheckpoint(result, "asr_start")
                val asr = withTimeout(60_000L) { engine.transcribePcm16(asrSample.readPcm16Data()) }
                result.put(
                    "asr",
                    JSONObject()
                        .put("ok", asr.ok)
                        .put("latencyMs", asr.latencyMs)
                        .put("text", asr.text)
                        .put("error", asr.error),
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

    private companion object {
        const val TAG = "EdgeModelSmoke"
    }
}
