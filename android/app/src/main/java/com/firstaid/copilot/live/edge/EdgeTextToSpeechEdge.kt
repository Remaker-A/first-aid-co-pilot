package com.firstaid.copilot.live.edge

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import com.firstaid.copilot.live.audio.AndroidTextToSpeechEdge
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class EdgeTextToSpeechEdge(
    context: Context,
    private val speechEngine: SherpaOnnxSpeechEngine,
    private val onSpeakingChanged: (Boolean) -> Unit,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val fallback = AndroidTextToSpeechEdge(appContext, onSpeakingChanged)
    private var player: MediaPlayer? = null
    private var lastUtteranceId: String? = null

    fun speak(
        text: String,
        utteranceKey: String?,
        priority: String?,
        interruptPolicy: String?,
        tone: String? = null,
        speed: String? = null,
        flushQueue: Boolean = false,
    ) {
        if (text.isBlank()) return
        val utteranceId = utteranceKey ?: UUID.randomUUID().toString()
        if (utteranceId == lastUtteranceId) return
        lastUtteranceId = utteranceId

        scope.launch {
            val rate = resolveSpeechRate(tone, speed)
            val outFile = File(appContext.cacheDir, "edge-tts/$utteranceId.wav")
            val result = speechEngine.synthesizeToWav(text, outFile, speed = rate)
            if (result.ok && result.audioFile?.isFile == true) {
                Log.i(TAG, "Sherpa TTS synthesized ${result.audioFile.length()} bytes in ${result.latencyMs}ms")
                play(result.audioFile)
            } else {
                Log.w(TAG, "Sherpa TTS unavailable, falling back to Android TTS: ${result.error}")
                fallback.speak(text, utteranceKey, priority, interruptPolicy, tone, speed, flushQueue)
            }
        }
    }

    fun stop() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        fallback.stop()
        onSpeakingChanged(false)
    }

    fun shutdown() {
        stop()
        fallback.shutdown()
        scope.cancel()
    }

    private suspend fun play(file: File) {
        withContext(Dispatchers.Main) {
            stopPlayerOnly()
            val next = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    stopPlayerOnly()
                    onSpeakingChanged(false)
                }
                setOnErrorListener { _, _, _ ->
                    Log.w(TAG, "MediaPlayer failed to play Sherpa TTS output")
                    stopPlayerOnly()
                    onSpeakingChanged(false)
                    true
                }
                prepare()
            }
            player = next
            onSpeakingChanged(true)
            next.start()
        }
    }

    private fun stopPlayerOnly() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
    }

    private fun resolveSpeechRate(tone: String?, speed: String?): Float =
        when {
            speed == "slow" -> 0.96f
            tone == "urgent" || speed == "fast" -> 1.12f
            else -> 1.04f
        }

    private companion object {
        const val TAG = "EdgeTextToSpeech"
    }
}
