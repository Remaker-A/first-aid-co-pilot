package com.example.cpr_new.hardware.haptics

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.example.cpr_new.core.contract.HapticPattern

/**
 * 触觉反馈控制器 —— 硬件适配层。
 *
 * 把抽象的 [HapticPattern] 映射为具体震动波形：
 * - TICK：节拍器单拍轻触；
 * - DOUBLE：阶段切换双击；
 * - STRONG：严重告警强震。
 *
 * 兼容性：Android 12+ 用 [VibratorManager]，以下用过时 API；
 * 全程容错，无马达设备直接静默。
 */
class HapticController(context: Context) {

    private val vibrator: Vibrator? = resolveVibrator(context.applicationContext)

    private fun resolveVibrator(context: Context): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    val isAvailable: Boolean get() = vibrator?.hasVibrator() == true

    /** 触发一次指定模式的震动。无马达 / 异常时静默。 */
    fun play(pattern: HapticPattern) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        runCatching {
            when (pattern) {
                HapticPattern.TICK -> oneShot(v, durationMs = 35, amplitude = 120)
                HapticPattern.DOUBLE -> waveform(v, timings = longArrayOf(0, 40, 80, 40))
                HapticPattern.STRONG -> oneShot(v, durationMs = 300, amplitude = VibrationEffect.DEFAULT_AMPLITUDE)
            }
        }
    }

    private fun oneShot(v: Vibrator, durationMs: Long, amplitude: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createOneShot(durationMs, amplitude))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(durationMs)
        }
    }

    private fun waveform(v: Vibrator, timings: LongArray) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // -1 表示不重复
            v.vibrate(VibrationEffect.createWaveform(timings, -1))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(timings, -1)
        }
    }

    fun cancel() {
        runCatching { vibrator?.cancel() }
    }
}
