package com.example.cpr_new.hardware.audio

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 文本转语音（TTS）控制器。
 *
 * 引擎异步初始化：未就绪时先排队，就绪后自动播报，避免首条指导无声。
 */
class TtsController(context: Context) {

    private val ready = AtomicBoolean(false)
    private var initFailed = false
    private var pendingText: String? = null
    private var pendingInterrupt: Boolean = false

    private val tts = TextToSpeech(context.applicationContext) { status ->
        if (status == TextToSpeech.SUCCESS) {
            val result = engineSetLanguage()
            ready.set(result)
            initFailed = !result
            if (result) {
                drainPending()
            }
        } else {
            initFailed = true
        }
    }

    private fun engineSetLanguage(): Boolean {
        val zh = tts.setLanguage(Locale.SIMPLIFIED_CHINESE)
        if (zh != TextToSpeech.LANG_MISSING_DATA && zh != TextToSpeech.LANG_NOT_SUPPORTED) {
            return true
        }
        val en = tts.setLanguage(Locale.US)
        return en != TextToSpeech.LANG_MISSING_DATA && en != TextToSpeech.LANG_NOT_SUPPORTED
    }

    val isReady: Boolean get() = ready.get()
    val isUnavailable: Boolean get() = initFailed

    fun speak(text: String, interrupt: Boolean = false) {
        if (text.isBlank()) return
        if (!ready.get()) {
            pendingText = text
            pendingInterrupt = interrupt
            return
        }
        val mode = if (interrupt) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        tts.speak(text, mode, null, "cpr-${System.nanoTime()}")
    }

    fun stop() {
        pendingText = null
        if (ready.get()) tts.stop()
    }

    fun setProgressListener(listener: UtteranceProgressListener) {
        tts.setOnUtteranceProgressListener(listener)
    }

    fun release() {
        runCatching {
            tts.stop()
            tts.shutdown()
        }
        ready.set(false)
        pendingText = null
    }

    private fun drainPending() {
        val text = pendingText ?: return
        val interrupt = pendingInterrupt
        pendingText = null
        speak(text, interrupt)
    }
}
