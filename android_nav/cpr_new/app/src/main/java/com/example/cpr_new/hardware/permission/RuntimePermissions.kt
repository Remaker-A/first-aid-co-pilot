package com.example.cpr_new.hardware.permission

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

/**
 * 运行时权限工具 —— 硬件适配层（Compose 友好）。
 *
 * 设计要点：
 * - 集中声明本 App 需要的权限，避免散落各处；
 * - 提供一个 [rememberPermissionState] 给 UI 用，一行接入“请求 + 状态回读”；
 * - 不强绑业务：任何需要权限的功能都可复用。
 *
 * 注意：拨打 120 使用 ACTION_DIAL（仅预填号码），无需 CALL_PHONE 权限，故不在此列。
 */
object CprPermissions {
    const val CAMERA = Manifest.permission.CAMERA
    const val RECORD_AUDIO = Manifest.permission.RECORD_AUDIO
    const val FINE_LOCATION = Manifest.permission.ACCESS_FINE_LOCATION
    const val COARSE_LOCATION = Manifest.permission.ACCESS_COARSE_LOCATION

    /** 急救主流程建议申请的权限集合（缺任一都仍可降级运行）。 */
    val recommended = listOf(CAMERA, RECORD_AUDIO, FINE_LOCATION, COARSE_LOCATION)
    val sessionStart = listOf(CAMERA, RECORD_AUDIO)

    fun isGranted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

/** 一组权限的当前授予情况快照。 */
data class PermissionSnapshot(
    val granted: Set<String>,
    val denied: Set<String>,
) {
    fun isGranted(permission: String): Boolean = permission in granted
    val allGranted: Boolean get() = denied.isEmpty()
}

/**
 * 权限状态持有者：暴露当前快照与一个 [request] 触发器。
 * UI 调用 request() 即可弹出系统授权框，结果自动回写 snapshot 触发重组。
 */
class PermissionState internal constructor(
    initial: PermissionSnapshot,
    private val launch: () -> Unit,
) {
    var snapshot by mutableStateOf(initial)
        internal set

    fun request() = launch()
}

/**
 * 记住一组权限的状态。典型用法：
 * ```
 * val perm = rememberPermissionState(CprPermissions.recommended)
 * if (!perm.snapshot.allGranted) Button(onClick = perm::request) { Text("授权") }
 * ```
 */
@Composable
fun rememberPermissionState(permissions: List<String>): PermissionState {
    val context = LocalContext.current

    fun snapshot(): PermissionSnapshot {
        val granted = permissions.filter { CprPermissions.isGranted(context, it) }.toSet()
        return PermissionSnapshot(granted = granted, denied = (permissions - granted).toSet())
    }

    val state = remember { PermissionState(snapshot()) {} }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        // 结果可能只包含被询问的项，这里统一以系统真实状态为准重新计算。
        val granted = permissions.filter {
            result[it] == true || CprPermissions.isGranted(context, it)
        }.toSet()
        state.snapshot = PermissionSnapshot(granted = granted, denied = (permissions - granted).toSet())
    }

    // 用最新 launcher 覆盖触发器；remember 只为持有 mutableState，launch 每次重组刷新。
    return remember(launcher) {
        PermissionState(snapshot()) { launcher.launch(permissions.toTypedArray()) }
            .also { it.snapshot = snapshot() }
    }
}
