package com.firstaid.copilot.live.edge

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeModelsDeviceSmokeTest {
    @Test
    fun asrAndTtsRunAgainstDeviceModels() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val engine = buildSherpaSpeechEngine(context)
        engine.use {
            val report = inspectEdgeModels(context, engine.runtimeAvailable())
            assertTrue(report.summaryLine(), report.asrReady)
            assertTrue(report.summaryLine(), report.ttsReady)

            val files = EdgeModelPathResolver(defaultEdgeModelRoots(context)).resolve()
            val sample = files.asr?.modelDir?.resolve("test_wavs/0.wav")
            assertNotNull("ASR sample wav missing", sample)

            val asrResult = engine.transcribePcm16(sample!!.readPcm16Data())
            assertTrue(asrResult.error ?: "ASR failed", asrResult.ok)
            assertTrue("ASR returned blank text in ${asrResult.latencyMs}ms", asrResult.text.isNotBlank())
            assertTrue("ASR latency too high: ${asrResult.latencyMs}ms", asrResult.latencyMs < 20_000L)

            val warmTts = engine.synthesizeToWav(
                text = "继续按压",
                outputFile = File(context.cacheDir, "edge-smoke/tts-warm.wav"),
            )
            assertTrue(warmTts.error ?: "TTS warmup failed", warmTts.ok)

            val measuredTts = engine.synthesizeToWav(
                text = "继续按压",
                outputFile = File(context.cacheDir, "edge-smoke/tts-measured.wav"),
            )
            assertTrue(measuredTts.error ?: "TTS failed", measuredTts.ok)
            assertTrue(measuredTts.audioFile?.isFile == true)
            assertTrue("TTS latency too high: ${measuredTts.latencyMs}ms", measuredTts.latencyMs < 12_000L)
        }
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
}
