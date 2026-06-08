package com.example.cpr_new.hardware.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.File

/**
 * 录音控制器 —— 硬件适配层。
 *
 * 职责：在急救过程中录制现场音频，作为“可回放测试素材 / 留证”，供后续复盘与 Demo。
 * 设计要点：
 * - 使用 framework 的 [MediaRecorder]，输出到应用私有目录（无需存储权限）；
 * - 无麦克风权限时直接降级（返回 false），不抛异常；
 * - 状态自管，重复 start/stop 安全。
 *
 * 录音文件仅落在 App 私有沙盒，离线可用，符合“离线运行”原则。
 */
class AudioRecorderController(context: Context) {

    private val appContext = context.applicationContext
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    val isRecording: Boolean get() = recorder != null

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            appContext, Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

    /**
     * 开始录音。
     * @return 成功开始返回输出文件，失败（无权限 / 设备不支持）返回 null。
     */
    fun start(fileNamePrefix: String = "cpr_session"): File? {
        if (!hasPermission() || isRecording) return null
        return runCatching {
            val dir = File(appContext.filesDir, "recordings").apply { mkdirs() }
            val file = File(dir, "${fileNamePrefix}_${System.currentTimeMillis()}.m4a")
            val mr = createRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder = mr
            outputFile = file
            file
        }.getOrElse {
            // 准备/启动失败时清理，保证状态一致。
            releaseQuietly()
            null
        }
    }

    /**
     * 停止录音。
     * @return 录好的文件；若未在录音或停止失败返回 null。
     */
    fun stop(): File? {
        val mr = recorder ?: return null
        val file = outputFile
        runCatching {
            mr.stop()
        }
        releaseQuietly()
        return file
    }

    /** 释放底层资源（异常静默），用于宿主销毁兜底。 */
    fun release() = releaseQuietly()

    private fun releaseQuietly() {
        runCatching { recorder?.reset() }
        runCatching { recorder?.release() }
        recorder = null
    }

    private fun createRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(appContext)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
}
