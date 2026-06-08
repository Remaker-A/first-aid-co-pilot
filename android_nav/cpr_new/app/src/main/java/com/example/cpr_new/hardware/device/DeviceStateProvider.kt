package com.example.cpr_new.hardware.device

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.core.content.ContextCompat
import com.example.cpr_new.hardware.audio.AudioRecorderController
import com.example.cpr_new.hardware.permission.CprPermissions

/**
 * 向 first-aid-co-pilot 上报的真实设备快照。
 * 避免硬编码 deviceState 导致 Agent 状态机与真机脱节。
 */
class DeviceStateProvider(
    context: Context,
    private val recorder: AudioRecorderController,
) {
    private val appContext = context.applicationContext

    @Volatile
    var emergencyCallStarted: Boolean = false

    fun snapshot(): Map<String, Any?> =
        mapOf(
            "camera_available" to hasPermission(Manifest.permission.CAMERA),
            "mic_available" to recorder.hasPermission(),
            "gps_available" to (
                hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                    hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                ),
            "recording" to recorder.isRecording,
            "emergency_call_started" to emergencyCallStarted,
            "network" to resolveNetworkState(),
        )

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED

    private fun resolveNetworkState(): String {
        if (!hasPermission(Manifest.permission.ACCESS_NETWORK_STATE)) return "unknown"
        return runCatching {
            val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
            val network = cm.activeNetwork ?: return "offline"
            val caps = cm.getNetworkCapabilities(network) ?: return "offline"
            when {
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "online"
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "limited"
                else -> "offline"
            }
        }.getOrDefault("unknown")
    }
}
