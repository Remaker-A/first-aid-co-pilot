package com.firstaid.copilot.live.emergency

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

sealed interface LocationResult {
    data class Success(val fix: LocationFix) : LocationResult
    data class Error(val reason: String) : LocationResult
    data object PermissionDenied : LocationResult
}

data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyM: Float?,
    val timestampMs: Long,
)

class LocationProvider(private val context: Context) {
    @SuppressLint("MissingPermission")
    suspend fun getCurrentLocation(): LocationResult {
        val hasFineLocation = context.hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val hasCoarseLocation = context.hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (!hasFineLocation && !hasCoarseLocation) {
            return LocationResult.PermissionDenied
        }

        val locationManager = context.getSystemService(LocationManager::class.java)
            ?: return LocationResult.Error(LOCATION_UNAVAILABLE)
        val requestProviders = currentLocationProviders(hasFineLocation, hasCoarseLocation)
            .filter { locationManager.isProviderEnabledSafely(it) }
        val cachedProviders = cachedLocationProviders(hasFineLocation, hasCoarseLocation)
            .filter { locationManager.isProviderEnabledSafely(it) }
        if (requestProviders.isEmpty() && cachedProviders.isEmpty()) {
            return LocationResult.Error(LOCATION_UNAVAILABLE)
        }

        when (val cached = locationManager.lastKnownLocation(cachedProviders)) {
            is LocationResult.Success -> return cached
            LocationResult.PermissionDenied -> return cached
            is LocationResult.Error -> Unit
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            locationManager.currentLocationWithFallback(requestProviders, cachedProviders)
        } else {
            LocationResult.Error(LOCATION_UNAVAILABLE)
        }
    }

    private suspend fun LocationManager.currentLocationWithFallback(
        requestProviders: List<String>,
        cachedProviders: List<String>,
    ): LocationResult {
        for (provider in requestProviders) {
            when (val current = requestCurrentLocation(provider)) {
                is LocationResult.Success -> return current
                LocationResult.PermissionDenied -> return current
                is LocationResult.Error -> {
                    when (val cached = lastKnownLocation(cachedProviders)) {
                        is LocationResult.Success -> return cached
                        LocationResult.PermissionDenied -> return cached
                        is LocationResult.Error -> Unit
                    }
                }
            }
        }

        return LocationResult.Error(LOCATION_UNAVAILABLE)
    }

    @SuppressLint("MissingPermission")
    private suspend fun LocationManager.requestCurrentLocation(provider: String): LocationResult =
        withTimeoutOrNull(CurrentLocationTimeoutMs) {
            suspendCancellableCoroutine { continuation ->
                val cancellationSignal = CancellationSignal()
                continuation.invokeOnCancellation { cancellationSignal.cancel() }

                try {
                    getCurrentLocation(provider, cancellationSignal, mainExecutor) { location ->
                        continuation.resumeIfActive(location.toLocationResult())
                    }
                } catch (_: SecurityException) {
                    continuation.resumeIfActive(LocationResult.PermissionDenied)
                } catch (_: IllegalArgumentException) {
                    continuation.resumeIfActive(LocationResult.Error(LOCATION_UNAVAILABLE))
                } catch (_: IllegalStateException) {
                    continuation.resumeIfActive(LocationResult.Error(LOCATION_UNAVAILABLE))
                }
            }
        } ?: LocationResult.Error(LOCATION_UNAVAILABLE)

    @SuppressLint("MissingPermission")
    private fun LocationManager.lastKnownLocation(providers: List<String>): LocationResult {
        val nowElapsedNanos = SystemClock.elapsedRealtimeNanos()
        val location = providers.mapNotNull { provider ->
            if (!isProviderEnabledSafely(provider)) {
                null
            } else {
                try {
                    getLastKnownLocation(provider)
                } catch (_: SecurityException) {
                    return LocationResult.PermissionDenied
                } catch (_: IllegalArgumentException) {
                    null
                }
            }
        }.filter { it.isRecentEnough(nowElapsedNanos) }
            .maxByOrNull { it.elapsedRealtimeNanos }

        return location.toLocationResult()
    }

    private fun currentLocationProviders(
        hasFineLocation: Boolean,
        hasCoarseLocation: Boolean,
    ): List<String> = buildList {
        if (hasFineLocation || hasCoarseLocation) {
            add(LocationManager.NETWORK_PROVIDER)
        }
        if (hasFineLocation) {
            add(LocationManager.GPS_PROVIDER)
        }
    }

    private fun cachedLocationProviders(
        hasFineLocation: Boolean,
        hasCoarseLocation: Boolean,
    ): List<String> = buildList {
        addAll(currentLocationProviders(hasFineLocation, hasCoarseLocation))
        add(LocationManager.PASSIVE_PROVIDER)
    }

    private fun LocationManager.isProviderEnabledSafely(provider: String): Boolean =
        try {
            isProviderEnabled(provider)
        } catch (_: IllegalArgumentException) {
            false
        }

    private fun Location?.toLocationResult(): LocationResult =
        this?.let { LocationResult.Success(it.toLocationFix()) }
            ?: LocationResult.Error(LOCATION_UNAVAILABLE)

    private fun Location.isRecentEnough(nowElapsedNanos: Long): Boolean {
        val elapsedAgeMs = ((nowElapsedNanos - elapsedRealtimeNanos) / NanosPerMillisecond)
            .takeIf { it >= 0L }
        if (elapsedAgeMs != null) {
            return elapsedAgeMs <= LastKnownMaxAgeMs
        }

        val wallClockAgeMs = System.currentTimeMillis() - time
        return wallClockAgeMs in 0..LastKnownMaxAgeMs
    }

    private fun Location.toLocationFix(): LocationFix =
        LocationFix(
            latitude = latitude,
            longitude = longitude,
            accuracyM = if (hasAccuracy()) accuracy else null,
            timestampMs = time.takeIf { it > 0L } ?: System.currentTimeMillis(),
        )

    private fun Context.hasPermission(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun CancellableContinuation<LocationResult>.resumeIfActive(result: LocationResult) {
        if (isActive) {
            resume(result)
        }
    }

    private val mainExecutor = Executor { command ->
        if (Looper.myLooper() == Looper.getMainLooper()) {
            command.run()
        } else {
            Handler(Looper.getMainLooper()).post(command)
        }
    }

    private companion object {
        const val LOCATION_UNAVAILABLE = "定位不可用"
        const val CurrentLocationTimeoutMs = 8_000L
        const val LastKnownMaxAgeMs = 5 * 60 * 1_000L
        const val NanosPerMillisecond = 1_000_000L
    }
}
