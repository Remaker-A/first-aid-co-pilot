package com.firstaid.copilot.live.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingAsrSessionTest {
    @Test
    fun rejectsFramesOutsideTwentyToFortyMilliseconds() {
        val recognizer = FakeRecognizerBridge()
        val session = SherpaStreamingAsrSession(recognizer)

        val events = session.acceptPcm16Frame(ByteArray(10 * 16_000 / 1000 * 2))

        assertTrue(events.single() is StreamingAsrEvent.Error)
        assertEquals(emptyList<Int>(), recognizer.acceptedSampleCounts)
    }

    @Test
    fun emitsPartialThenFinalAndEndpointFromFrameStream() {
        val recognizer = FakeRecognizerBridge(
            decodeTextBatches = mutableListOf(
                mutableListOf("scene"),
                mutableListOf("scene safe"),
            ),
            endpointResponses = mutableListOf(false, true),
            confidenceResponses = mutableListOf(null, 0.81f),
        )
        val session = SherpaStreamingAsrSession(recognizer)

        val first = session.acceptPcm16Frame(ByteArray(20 * 16_000 / 1000 * 2))
        val second = session.acceptPcm16Frame(ByteArray(40 * 16_000 / 1000 * 2))

        assertEquals(listOf(StreamingAsrEvent.Partial("scene")), first)
        assertEquals(2, second.size)
        val final = second[0] as StreamingAsrEvent.Final
        assertEquals("scene safe", final.text)
        assertNull(final.intent)
        assertEquals(0.81f, final.confidence ?: 0f, 0.0001f)
        assertEquals(StreamingAsrEvent.Endpoint, second[1])
        assertEquals(listOf(320, 640), recognizer.acceptedSampleCounts)
        assertEquals(1, recognizer.resetCount)
    }

    @Test
    fun finishCommitsCurrentUtteranceAndResetsStream() {
        val recognizer = FakeRecognizerBridge(
            decodeTextBatches = mutableListOf(mutableListOf("call emergency")),
            confidenceResponses = mutableListOf(0.72f),
        )
        val session = SherpaStreamingAsrSession(recognizer)

        val events = session.finish()

        assertEquals(1, recognizer.inputFinishedCount)
        assertEquals(2, events.size)
        val final = events[0] as StreamingAsrEvent.Final
        assertEquals("call emergency", final.text)
        assertEquals(0.72f, final.confidence ?: 0f, 0.0001f)
        assertEquals(StreamingAsrEvent.Endpoint, events[1])
        assertEquals(1, recognizer.resetCount)
    }

    @Test
    fun averagesNativeTokenProbabilitiesAsNullableConfidence() {
        assertEquals(0.75f, averageConfidence(floatArrayOf(0.5f, 1.0f)) ?: 0f, 0.0001f)
        assertNull(averageConfidence(floatArrayOf()))
        assertNull(averageConfidence(null))
    }
}

private class FakeRecognizerBridge(
    private val decodeTextBatches: MutableList<MutableList<String>> = mutableListOf(),
    private val endpointResponses: MutableList<Boolean> = mutableListOf(),
    private val confidenceResponses: MutableList<Float?> = mutableListOf(),
) : SherpaOnlineRecognizerBridge {
    val acceptedSampleCounts = mutableListOf<Int>()
    var inputFinishedCount = 0
    var resetCount = 0
    var releaseStreamCount = 0
    var closeCount = 0

    private var currentText = ""
    private var currentConfidence: Float? = null
    private var pendingTexts = mutableListOf<String>()

    override fun createStream(): Any = Any()

    override fun acceptWaveform(stream: Any, samples: FloatArray, sampleRateHz: Int) {
        acceptedSampleCounts += samples.size
        pendingTexts = nextDecodeBatch()
    }

    override fun inputFinished(stream: Any) {
        inputFinishedCount += 1
        pendingTexts = nextDecodeBatch()
    }

    override fun isReady(stream: Any): Boolean =
        pendingTexts.isNotEmpty()

    override fun decode(stream: Any) {
        currentText = pendingTexts.removeAt(0)
        currentConfidence = nextConfidence()
    }

    override fun isEndpoint(stream: Any): Boolean =
        if (endpointResponses.isNotEmpty()) endpointResponses.removeAt(0) else false

    override fun getResult(stream: Any): StreamingAsrNativeResult =
        StreamingAsrNativeResult(currentText, currentConfidence)

    override fun reset(stream: Any) {
        resetCount += 1
        currentText = ""
        currentConfidence = null
        pendingTexts = mutableListOf()
    }

    override fun releaseStream(stream: Any) {
        releaseStreamCount += 1
    }

    override fun close() {
        closeCount += 1
    }

    private fun nextDecodeBatch(): MutableList<String> =
        if (decodeTextBatches.isNotEmpty()) decodeTextBatches.removeAt(0) else mutableListOf()

    private fun nextConfidence(): Float? =
        if (confidenceResponses.isNotEmpty()) confidenceResponses.removeAt(0) else null
}
