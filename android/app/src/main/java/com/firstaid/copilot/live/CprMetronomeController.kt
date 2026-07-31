package com.firstaid.copilot.live

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HAPTIC_TOOL_TYPES

class CprMetronomeController(context: Context) {
    private val vibrator: Vibrator? =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    private val handler = Handler(Looper.getMainLooper())
    private var activeBpm: Int? = null

    private val tick = object : Runnable {
        override fun run() {
            val bpm = activeBpm ?: return
            vibrator?.vibrate(VibrationEffect.createOneShot(42, VibrationEffect.DEFAULT_AMPLITUDE))
            handler.postDelayed(this, intervalMs(bpm))
        }
    }

    fun apply(action: GuidanceAction) {
        val command = action.tool_actions.lastOrNull { it.type in HAPTIC_TOOL_TYPES }?.type
        when {
            command == "stop_haptic_metronome" -> stop()
            command == "start_haptic_metronome" ||
                command == "update_haptic_metronome" ||
                action.haptic.enabled -> startOrUpdate(action.haptic.bpm ?: TARGET_CPR_BPM)
            action.stage != "S7_CPR_LOOP" -> stop()
        }
    }

    fun stop() {
        activeBpm = null
        handler.removeCallbacks(tick)
        vibrator?.cancel()
    }

    private fun startOrUpdate(bpm: Int) {
        val sanitized = bpm.coerceIn(80, 140)
        if (activeBpm == sanitized) return
        activeBpm = sanitized
        handler.removeCallbacks(tick)
        handler.post(tick)
    }

    private fun intervalMs(bpm: Int): Long = (60_000L / bpm.coerceAtLeast(1))
}
