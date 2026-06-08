package com.example.cpr_new.hardware.audio

import android.media.MediaPlayer
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File

/**
 * 播放 HTTP `/api/turn` 返回的 TTS 音频（URL 或 data:audio/wav;base64）。
 */
class TurnTtsPlayer(
    private val baseUrl: String,
) {
    var onSpeakingChanged: (Boolean) -> Unit = {}
    var onPlaybackFailed: (() -> Unit)? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val client = OkHttpClient()
    private var player: MediaPlayer? = null
    private var tempFile: File? = null

    fun play(src: String?) {
        if (src.isNullOrBlank()) return
        scope.launch {
            runCatching {
                stopInternal()
                val resolved = resolveSrc(src)
                val mediaPlayer = if (resolved.startsWith("data:")) {
                    playDataUrl(resolved)
                } else {
                    playHttpUrl(resolved)
                }
                player = mediaPlayer
                onSpeakingChanged.invoke(true)
                mediaPlayer.setOnCompletionListener {
                    onSpeakingChanged.invoke(false)
                    stopInternal()
                }
                mediaPlayer.start()
            }.onFailure {
                onSpeakingChanged.invoke(false)
                onPlaybackFailed?.invoke()
            }
        }
    }

    fun stop() {
        onSpeakingChanged.invoke(false)
        stopInternal()
    }

    fun release() {
        stop()
        scope.cancel()
    }

    private fun stopInternal() {
        runCatching {
            player?.stop()
            player?.release()
        }
        player = null
        tempFile?.delete()
        tempFile = null
    }

    private fun resolveSrc(src: String): String =
        when {
            src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") -> src
            else -> baseUrl.trimEnd('/') + src
        }

    private suspend fun playHttpUrl(url: String): MediaPlayer = withContext(Dispatchers.IO) {
        val bytes = client.newCall(Request.Builder().url(url).get().build())
            .execute()
            .body
            ?.bytes()
            ?: error("无法下载 TTS 音频")
        playBytes(bytes)
    }

    private fun playDataUrl(dataUrl: String): MediaPlayer {
        val base64 = dataUrl.substringAfter("base64,", "")
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        return playBytes(bytes)
    }

    private fun playBytes(bytes: ByteArray): MediaPlayer {
        val temp = File.createTempFile("turn_tts_", ".wav")
        temp.writeBytes(bytes)
        tempFile = temp
        return MediaPlayer().apply { setDataSource(temp.absolutePath); prepare() }
    }
}
