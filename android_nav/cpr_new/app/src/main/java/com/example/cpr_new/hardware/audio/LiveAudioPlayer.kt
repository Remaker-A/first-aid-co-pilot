package com.example.cpr_new.hardware.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

/**
 * 播放 Node `/ws/live` 下发的流式 PCM16 TTS 音频。
 */
class LiveAudioPlayer {

    private var track: AudioTrack? = null
    private var activeActionId: String? = null

    fun onAudioBegin(
        sampleRate: Int = 16_000,
        actionId: String? = null,
        flushQueue: Boolean = false,
    ) {
        if (flushQueue) onAudioCancel()
        releaseTrack()
        activeActionId = actionId
        track = buildTrack(sampleRate)
        runCatching {
            track?.setVolume(1f)
            track?.play()
        }
    }

    fun onPcmChunk(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        runCatching { track?.write(bytes, 0, bytes.size, AudioTrack.WRITE_BLOCKING) }
    }

    fun onAudioEnd(actionId: String? = null) {
        if (actionId != null && activeActionId != null && actionId != activeActionId) return
        activeActionId = null
        releaseTrack()
    }

    fun onAudioCancel() {
        activeActionId = null
        releaseTrack()
    }

    fun flushQueue() = onAudioCancel()

    fun release() = onAudioCancel()

    private fun releaseTrack() {
        val current = track
        track = null
        runCatching { current?.pause() }
        runCatching { current?.flush() }
        runCatching { current?.stop() }
        runCatching { current?.release() }
    }

    private fun buildTrack(sampleRateHz: Int): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(sampleRateHz * 2)
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRateHz)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(minBuffer)
            .build()
    }
}
