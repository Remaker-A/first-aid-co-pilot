package com.firstaid.copilot.live.audio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveAudioPlayerTest {
    private class FakeSinkFactory : LiveAudioSinkFactory {
        val created = mutableListOf<Pair<LiveAudioMetadata, FakeSink>>()

        override fun create(metadata: LiveAudioMetadata): LiveAudioSink =
            FakeSink().also { created += metadata to it }
    }

    private class FakeSink : LiveAudioSink {
        var startCount = 0
        var finishCount = 0
        var flushAndStopCount = 0
        var releaseCount = 0
        val writes = mutableListOf<ByteArray>()

        override fun start() {
            startCount++
        }

        override fun writePcm(bytes: ByteArray): Int {
            writes += bytes.copyOf()
            return bytes.size
        }

        override fun finish() {
            finishCount++
        }

        override fun flushAndStop() {
            flushAndStopCount++
        }

        override fun release() {
            releaseCount++
        }
    }

    private class FakeLogger : LiveAudioLogger {
        val infos = mutableListOf<String>()
        val warnings = mutableListOf<String>()

        override fun info(message: String) {
            infos += message
        }

        override fun warn(message: String) {
            warnings += message
        }
    }

    @Test
    fun metadataFromJson_readsServerAudioBeginShape() {
        val metadata = LiveAudioMetadata.fromJson(
            JSONObject()
                .put("id", "stream_1")
                .put("session_id", "session_1")
                .put("turn_seq", 7)
                .put("action_id", "act_1")
                .put("format", "pcm16")
                .put("sample_rate", 22050)
                .put("channels", 1)
                .put("bits_per_sample", 16)
                .put("flush_queue", true),
        )

        assertEquals("stream_1", metadata.streamId)
        assertEquals("session_1", metadata.sessionId)
        assertEquals(7L, metadata.turnSeq)
        assertEquals("act_1", metadata.actionId)
        assertEquals(22050, metadata.sampleRateHz)
        assertEquals(1, metadata.channels)
        assertEquals(16, metadata.bitsPerSample)
        assertEquals(true, metadata.flushQueue)
    }

    @Test
    fun beginAndChunk_startSinkWithMetadataSampleRateAndLogLatency() {
        val factory = FakeSinkFactory()
        val logger = FakeLogger()
        var now = 100L
        val player = LiveAudioPlayer(factory, clockMs = { now }, logger = logger)

        player.onAudioBegin(LiveAudioMetadata(actionId = "act_1", sampleRateHz = 22050))
        now = 142L
        player.onPcmChunk(byteArrayOf(1, 2, 3, 4))

        assertEquals(1, factory.created.size)
        assertEquals(22050, factory.created.single().first.sampleRateHz)
        val sink = factory.created.single().second
        assertEquals(1, sink.startCount)
        assertEquals(listOf(byteArrayOf(1, 2, 3, 4).toList()), sink.writes.map { it.toList() })
        assertTrue(logger.infos.any { it.contains("latency=42ms") && it.contains("sampleRate=22050") })
    }

    @Test
    fun audioEndFinishesCurrentStreamAndReleaseReleasesDrainingSink() {
        val factory = FakeSinkFactory()
        val player = LiveAudioPlayer(factory, clockMs = { 0L }, logger = FakeLogger())

        player.onAudioBegin(LiveAudioMetadata(actionId = "act_1"))
        player.onPcmChunk(byteArrayOf(1, 2))
        player.onAudioEnd(actionId = "act_1")
        player.onPcmChunk(byteArrayOf(3, 4))

        val sink = factory.created.single().second
        assertEquals(1, sink.finishCount)
        assertEquals(1, sink.writes.size)

        player.release()

        assertEquals(1, sink.releaseCount)
    }

    @Test
    fun audioCancelFlushesAndReleasesActiveStreamAndDropsLaterChunks() {
        val factory = FakeSinkFactory()
        val player = LiveAudioPlayer(factory, clockMs = { 0L }, logger = FakeLogger())

        player.onAudioBegin(LiveAudioMetadata(actionId = "act_1"))
        player.onPcmChunk(byteArrayOf(1, 2))
        player.onAudioCancel(reason = "barge_in")
        player.onPcmChunk(byteArrayOf(3, 4))

        val sink = factory.created.single().second
        assertEquals(1, sink.flushAndStopCount)
        assertEquals(1, sink.releaseCount)
        assertEquals(1, sink.writes.size)
    }

    @Test
    fun newBeginFlushesUnfinishedStreamBeforeStartingReplacement() {
        val factory = FakeSinkFactory()
        val player = LiveAudioPlayer(factory, clockMs = { 0L }, logger = FakeLogger())

        player.onAudioBegin(LiveAudioMetadata(actionId = "act_1"))
        player.onPcmChunk(byteArrayOf(1, 2))
        player.onAudioBegin(LiveAudioMetadata(actionId = "act_2", flushQueue = true))
        player.onPcmChunk(byteArrayOf(3, 4))

        val firstSink = factory.created[0].second
        val secondSink = factory.created[1].second
        assertEquals(1, firstSink.flushAndStopCount)
        assertEquals(1, firstSink.releaseCount)
        assertEquals(1, secondSink.startCount)
        assertEquals(listOf(byteArrayOf(3, 4).toList()), secondSink.writes.map { it.toList() })
    }

    @Test
    fun unsupportedFormatDoesNotCreateSinkOrPlayChunks() {
        val factory = FakeSinkFactory()
        val logger = FakeLogger()
        val player = LiveAudioPlayer(factory, clockMs = { 0L }, logger = logger)

        player.onAudioBegin(LiveAudioMetadata(actionId = "act_1", channels = 2))
        player.onPcmChunk(byteArrayOf(1, 2))

        assertEquals(0, factory.created.size)
        assertTrue(logger.warnings.any { it.contains("unsupported live audio") })
    }
}
