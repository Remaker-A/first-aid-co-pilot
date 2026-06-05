package com.firstaid.copilot.live.edge

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeModelPathResolverTest {
    @Test
    fun resolvePrefersInt8StreamingAsrAndRealTtsModel() {
        val root = Files.createTempDirectory("edge-models-").toFile()
        try {
            val asr = File(root, "speech/stt-stream/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20")
            touch(asr.resolve("encoder-epoch-99-avg-1.int8.onnx"))
            touch(asr.resolve("encoder-epoch-99-avg-1.onnx"))
            touch(asr.resolve("decoder-epoch-99-avg-1.onnx"))
            touch(asr.resolve("decoder-epoch-99-avg-1.int8.onnx"))
            touch(asr.resolve("joiner-epoch-99-avg-1.int8.onnx"))
            touch(asr.resolve("tokens.txt"))

            val tts = File(root, "speech/tts")
            touch(tts.resolve("model.onnx"))
            touch(tts.resolve("model.int8.onnx"))
            touch(tts.resolve("lexicon.txt"))
            touch(tts.resolve("tokens.txt"))
            touch(tts.resolve("number.fst"))
            tts.resolve("dict").mkdirs()

            val files = EdgeModelPathResolver(listOf(root)).resolve()

            assertEquals("encoder-epoch-99-avg-1.int8.onnx", files.asr?.encoder?.name)
            assertEquals("decoder-epoch-99-avg-1.onnx", files.asr?.decoder?.name)
            assertEquals("model.onnx", files.tts?.model?.name)
            assertEquals(listOf("number.fst"), files.tts?.ruleFsts?.map(File::getName))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun inspectRequiresSherpaRuntimeForAsrAndTtsReadiness() {
        val root = Files.createTempDirectory("edge-models-").toFile()
        try {
            val resolver = EdgeModelPathResolver(listOf(root))
            val report = resolver.inspect(sherpaRuntimeAvailable = false)

            assertFalse(report.asrReady)
            assertFalse(report.ttsReady)
            assertEquals(EdgeModelState.RuntimeMissing, report.status(EdgeModelKind.SherpaRuntime).state)
            assertTrue(report.summaryLine().contains("sherpa=RuntimeMissing", ignoreCase = false))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun resolvePrefersRealInt8TtsModelOverFullModel() {
        val root = Files.createTempDirectory("edge-models-").toFile()
        try {
            val tts = File(root, "speech/tts")
            touch(tts.resolve("model.onnx"))
            writeBytes(tts.resolve("model.int8.onnx"), 1_000_000)
            touch(tts.resolve("lexicon.txt"))
            touch(tts.resolve("tokens.txt"))
            tts.resolve("dict").mkdirs()

            val files = EdgeModelPathResolver(listOf(root)).resolve()

            assertEquals("model.int8.onnx", files.tts?.model?.name)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun resolveAcceptsAdbPushedSpeechLayoutVariants() {
        val root = Files.createTempDirectory("edge-models-").toFile()
        try {
            val asr = File(root, "speech/stt-stream/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02")
            touch(asr.resolve("encoder-epoch-99-avg-1.onnx"))
            touch(asr.resolve("decoder-epoch-99-avg-1.onnx"))
            touch(asr.resolve("joiner-epoch-99-avg-1.onnx"))
            touch(asr.resolve("tokens.txt"))

            val speech = File(root, "speech")
            touch(speech.resolve("model.onnx"))
            touch(speech.resolve("lexicon.txt"))
            touch(speech.resolve("tokens.txt"))
            speech.resolve("dict").mkdirs()

            val files = EdgeModelPathResolver(listOf(root)).resolve()

            assertEquals("sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02", files.asr?.modelDir?.name)
            assertEquals(speech.absolutePath, files.tts?.modelDir?.absolutePath)
        } finally {
            root.deleteRecursively()
        }
    }

    private fun touch(file: File) {
        file.parentFile?.mkdirs()
        file.writeBytes(byteArrayOf(1))
    }

    private fun writeBytes(file: File, byteCount: Int) {
        file.parentFile?.mkdirs()
        file.writeBytes(ByteArray(byteCount) { 1 })
    }
}
