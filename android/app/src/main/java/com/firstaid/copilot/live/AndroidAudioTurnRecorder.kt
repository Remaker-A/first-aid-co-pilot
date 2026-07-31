package com.firstaid.copilot.live

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import java.io.File

class AndroidAudioTurnRecorder(
    private val context: Context,
) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    fun start() {
        release()
        val file = File.createTempFile("firstaid_turn_", ".m4a", context.cacheDir)
        outputFile = file
        recorder = createRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(16000)
            setAudioEncodingBitRate(64000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
    }

    fun stop(): AudioTurn {
        val active = recorder ?: error("Recorder is not active")
        val file = outputFile ?: error("Recorder output is missing")
        runCatching { active.stop() }
        releaseRecorderOnly()
        val bytes = file.readBytes()
        file.delete()
        outputFile = null
        return AudioTurn(
            base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
            mimeType = "audio/mp4",
        )
    }

    fun release() {
        releaseRecorderOnly()
        outputFile?.delete()
        outputFile = null
    }

    private fun releaseRecorderOnly() {
        recorder?.runCatching { reset() }
        recorder?.runCatching { release() }
        recorder = null
    }

    private fun createRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
}
