package com.example.cpr_new.hardware.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.example.cpr_new.core.contract.GeoSnapshot
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 定位提供者 —— 硬件适配层。
 *
 * 职责：为 120 拨号与 Handover 报告提供现场坐标 [GeoSnapshot]。
 * 设计要点：
 * - 仅依赖 framework 的 [LocationManager]，零额外依赖、可离线（GPS 不需要网络）；
 * - 先取“最后已知位置”秒回，再尝试单次实时定位，二者皆失败则返回 null；
 * - 全程检查权限，未授权直接降级返回 null，由上层 UI 兜底提示。
 *
 * 不在此处申请权限（权限交互属于 UI 层），只做“有权限就取，没权限就降级”。
 */
class LocationProvider(context: Context) {

    private val appContext = context.applicationContext
    private val locationManager =
        appContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    /** 是否已被授予任一定位权限。 */
    fun hasPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            appContext, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            appContext, Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    /** 快速返回最后已知位置（可能为 null / 过期），用于秒级兜底。 */
    fun lastKnown(): GeoSnapshot? {
        val lm = locationManager ?: return null
        if (!hasPermission()) return null
        return runCatching {
            lm.getProviders(true)
                .mapNotNull { provider -> getLastKnownSafe(lm, provider) }
                .maxByOrNull { it.time }
                ?.toSnapshot()
        }.getOrNull()
    }

    @Suppress("MissingPermission") // 已在 hasPermission() 中校验
    private fun getLastKnownSafe(lm: LocationManager, provider: String): Location? =
        runCatching { lm.getLastKnownLocation(provider) }.getOrNull()

    /**
     * 请求一次实时定位（带超时）。失败返回 null。
     * 用协程封装回调，避免阻塞主线程。
     */
    @Suppress("MissingPermission")
    suspend fun requestSingleFix(timeoutMs: Long = 8_000): GeoSnapshot? {
        val lm = locationManager ?: return null
        if (!hasPermission()) return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // 旧系统直接回退到最后已知位置，避免引入复杂的 listener 兼容代码。
            return lastKnown()
        }
        return withTimeoutOrNull(timeoutMs) {
            runCatching {
                suspendCancellableCoroutine<GeoSnapshot?> { cont ->
                    val cancellation = android.os.CancellationSignal()
                    cont.invokeOnCancellation { runCatching { cancellation.cancel() } }
                    lm.getCurrentLocation(
                        LocationManager.GPS_PROVIDER,
                        cancellation,
                        appContext.mainExecutor,
                    ) { location ->
                        if (cont.isActive) cont.resume(location?.toSnapshot() ?: lastKnown())
                    }
                }
            }.getOrElse { lastKnown() }
        } ?: lastKnown()
    }

    private fun Location.toSnapshot(): GeoSnapshot = GeoSnapshot(
        latitude = latitude,
        longitude = longitude,
        accuracyMeters = if (hasAccuracy()) accuracy else null,
        capturedAtMs = time,
    )
}
