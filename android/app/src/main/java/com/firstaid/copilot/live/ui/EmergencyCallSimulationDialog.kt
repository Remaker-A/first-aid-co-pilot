package com.firstaid.copilot.live.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.firstaid.copilot.live.emergency.LocationFix
import com.firstaid.copilot.live.emergency.LocationProvider
import com.firstaid.copilot.live.emergency.LocationResult
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun EmergencyCallSimulationDialog(
    onDismiss: () -> Unit,
    mock: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    if (LocalInspectionMode.current) {
        EmergencyCallDialogFrame(
            locationState = PreviewLocationState,
            mock = mock,
            modifier = modifier,
            onDismiss = onDismiss,
            onRequestPermission = {},
        )
        return
    }

    val locationProvider = remember(context) { LocationProvider(context.applicationContext) }
    var locationState by remember { mutableStateOf<EmergencyLocationUiState>(EmergencyLocationUiState.Loading) }
    var lookupRequest by remember { mutableStateOf(0) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val granted = grants.values.any { it }
        if (granted) {
            locationState = EmergencyLocationUiState.Loading
            lookupRequest += 1
        } else {
            locationState = EmergencyLocationUiState.PermissionRequired
        }
    }

    LaunchedEffect(locationProvider, lookupRequest) {
        if (!context.hasAnyLocationPermission()) {
            locationState = EmergencyLocationUiState.PermissionRequired
            return@LaunchedEffect
        }

        locationState = EmergencyLocationUiState.Loading
        locationState = when (val result = locationProvider.getCurrentLocation()) {
            is LocationResult.Success -> EmergencyLocationUiState.Located(result.fix)
            is LocationResult.Error -> EmergencyLocationUiState.Failed(result.reason)
            LocationResult.PermissionDenied -> EmergencyLocationUiState.PermissionRequired
        }
    }

    EmergencyCallDialogFrame(
        locationState = locationState,
        mock = mock,
        modifier = modifier,
        onDismiss = onDismiss,
        onRequestPermission = {
            permissionLauncher.launch(LocationPermissions)
        },
    )
}

@Composable
private fun EmergencyCallDialogFrame(
    locationState: EmergencyLocationUiState,
    mock: Boolean,
    modifier: Modifier,
    onDismiss: () -> Unit,
    onRequestPermission: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = modifier
                .fillMaxWidth()
                .padding(FirstAidDimens.ScreenPadding),
            color = FirstAidColors.Surface,
            shape = RoundedCornerShape(FirstAidDimens.CardRadius),
        ) {
            Column(
                modifier = Modifier.padding(FirstAidDimens.ScreenPadding),
                verticalArrangement = Arrangement.spacedBy(FirstAidDimens.SectionGap),
            ) {
                EmergencyHeaderCard(locationState = locationState)
                LocationStatusCard(
                    locationState = locationState,
                    onRequestPermission = onRequestPermission,
                )
                if (mock) {
                    MockDisclosure()
                }
                EmergencyPrimaryActionButton(
                    label = "知道了",
                    onClick = onDismiss,
                )
            }
        }
    }
}

@Composable
private fun EmergencyHeaderCard(locationState: EmergencyLocationUiState) {
    Surface(
        modifier = Modifier.semantics(mergeDescendants = true) {
            contentDescription = "已发送120急救信息。${locationState.headerSubtitle()}"
            liveRegion = LiveRegionMode.Assertive
        },
        color = FirstAidColors.Critical.copy(alpha = CriticalCardAlpha),
        shape = RoundedCornerShape(FirstAidDimens.CardRadius),
        border = BorderStroke(
            width = FirstAidDimens.TightGap / BorderWidthDivisor,
            color = FirstAidColors.Critical,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(FirstAidDimens.SectionGap),
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        ) {
            Text(
                text = "已发送 120 急救信息",
                modifier = Modifier.semantics { heading() },
                style = FirstAidType.Headline,
                color = FirstAidColors.Critical,
            )
            Text(
                text = locationState.headerSubtitle(),
                style = FirstAidType.Body,
                color = FirstAidColors.TextSecondary,
            )
        }
    }
}

@Composable
private fun LocationStatusCard(
    locationState: EmergencyLocationUiState,
    onRequestPermission: () -> Unit,
) {
    Surface(
        modifier = Modifier.semantics {
            contentDescription = "现场定位，${locationState.accessibilityDescription()}"
            liveRegion = LiveRegionMode.Polite
        },
        color = FirstAidColors.SurfaceVariant,
        shape = RoundedCornerShape(FirstAidDimens.CardRadius),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(FirstAidDimens.SectionGap),
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        ) {
            Text(
                text = "现场定位",
                modifier = Modifier.semantics { heading() },
                style = FirstAidType.Title,
                color = FirstAidColors.TextPrimary,
            )
            when (locationState) {
                EmergencyLocationUiState.Loading -> LoadingLocationRow()
                EmergencyLocationUiState.PermissionRequired -> PermissionRequiredContent(onRequestPermission)
                is EmergencyLocationUiState.Failed -> FailedLocationContent(locationState.reason)
                is EmergencyLocationUiState.Located -> LocatedContent(locationState.fix)
            }
        }
    }
}

@Composable
private fun LoadingLocationRow() {
    Row(
        modifier = Modifier.clearAndSetSemantics {
            contentDescription = "定位中"
        },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(FirstAidDimens.MinTouch),
            color = FirstAidColors.Progress,
            trackColor = FirstAidColors.ScrimSoft,
        )
        Text(
            text = "定位中…",
            style = FirstAidType.Body,
            color = FirstAidColors.Progress,
        )
    }
}

@Composable
private fun PermissionRequiredContent(onRequestPermission: () -> Unit) {
    Text(
        text = "需要定位权限",
        style = FirstAidType.Body,
        color = FirstAidColors.Warning,
    )
    Text(
        text = "授予权限后，将读取真实 GPS 或网络定位，用于急救信息展示。",
        style = FirstAidType.Body,
        color = FirstAidColors.TextSecondary,
    )
    EmergencySecondaryActionButton(
        label = "授予定位权限",
        onClick = onRequestPermission,
    )
}

@Composable
private fun FailedLocationContent(reason: String) {
    Text(
        text = reason.ifBlank { "定位不可用" },
        style = FirstAidType.Body,
        color = FirstAidColors.Warning,
    )
    Text(
        text = "请确认系统定位服务已开启，或稍后重试。",
        style = FirstAidType.Body,
        color = FirstAidColors.TextSecondary,
    )
}

@Composable
private fun LocatedContent(fix: LocationFix) {
    Column(
        verticalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
    ) {
        LocationDetailRow(label = "纬度", value = formatCoordinate(fix.latitude))
        LocationDetailRow(label = "经度", value = formatCoordinate(fix.longitude))
        LocationDetailRow(label = "精度", value = formatAccuracy(fix.accuracyM))
        LocationDetailRow(label = "时间", value = formatFixTime(fix.timestampMs))
    }
}

@Composable
private fun LocationDetailRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "$label：$value"
            },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
        )
        Text(
            text = value,
            style = FirstAidType.Body,
            color = FirstAidColors.TextPrimary,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun MockDisclosure() {
    Row(
        modifier = Modifier.clearAndSetSemantics {
            contentDescription = "模拟演示，未真实拨号"
        },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(FirstAidDimens.TightGap)
                .clip(CircleShape)
                .background(FirstAidColors.Warning),
        )
        Text(
            text = "模拟演示，未真实拨号",
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
        )
    }
}

@Composable
private fun EmergencyPrimaryActionButton(
    label: String,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = FirstAidDimens.MinTouch)
            .height(FirstAidDimens.PrimaryControlHeight)
            .semantics {
                contentDescription = "知道了，关闭急救信息提示"
                role = Role.Button
            },
        shape = RoundedCornerShape(FirstAidDimens.ButtonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = FirstAidColors.Progress,
            contentColor = FirstAidColors.OnAccent,
        ),
    ) {
        Text(
            text = label,
            style = FirstAidType.Title,
            color = FirstAidColors.OnAccent,
        )
    }
}

@Composable
private fun EmergencySecondaryActionButton(
    label: String,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = FirstAidDimens.MinTouch)
            .height(FirstAidDimens.PrimaryControlHeight)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        shape = RoundedCornerShape(FirstAidDimens.ButtonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = FirstAidColors.Warning,
            contentColor = FirstAidColors.OnAccent,
        ),
    ) {
        Text(
            text = label,
            style = FirstAidType.Title,
            color = FirstAidColors.OnAccent,
        )
    }
}

private sealed interface EmergencyLocationUiState {
    data object Loading : EmergencyLocationUiState
    data object PermissionRequired : EmergencyLocationUiState
    data class Located(val fix: LocationFix) : EmergencyLocationUiState
    data class Failed(val reason: String) : EmergencyLocationUiState
}

private fun EmergencyLocationUiState.headerSubtitle(): String =
    when (this) {
        EmergencyLocationUiState.Loading -> "位置：定位中… · 时间：${formatFixTime(System.currentTimeMillis())}"
        EmergencyLocationUiState.PermissionRequired -> "位置：需要定位权限 · 时间：${formatFixTime(System.currentTimeMillis())}"
        is EmergencyLocationUiState.Failed -> "位置：${reason.ifBlank { "定位不可用" }} · 时间：${formatFixTime(System.currentTimeMillis())}"
        is EmergencyLocationUiState.Located -> "位置：${formatCoordinate(fix.latitude)}，${formatCoordinate(fix.longitude)} · 时间：${formatFixTime(fix.timestampMs)}"
    }

private fun EmergencyLocationUiState.accessibilityDescription(): String =
    when (this) {
        EmergencyLocationUiState.Loading -> "定位中"
        EmergencyLocationUiState.PermissionRequired -> "需要定位权限"
        is EmergencyLocationUiState.Failed -> reason.ifBlank { "定位不可用" }
        is EmergencyLocationUiState.Located -> {
            "纬度 ${formatCoordinate(fix.latitude)}，经度 ${formatCoordinate(fix.longitude)}，" +
                "精度 ${formatAccuracy(fix.accuracyM)}，时间 ${formatFixTime(fix.timestampMs)}"
        }
    }

private fun Context.hasAnyLocationPermission(): Boolean =
    checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

private fun formatCoordinate(value: Double): String =
    String.format(Locale.US, CoordinateFormat, value)

private fun formatAccuracy(value: Float?): String =
    value?.let { String.format(Locale.CHINA, AccuracyFormat, it) } ?: "未知"

private fun formatFixTime(timestampMs: Long): String =
    SimpleDateFormat(TimeFormat, Locale.CHINA).format(Date(timestampMs))

private val LocationPermissions = arrayOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION,
)

private val PreviewLocationState = EmergencyLocationUiState.Located(
    LocationFix(
        latitude = 39.904211,
        longitude = 116.407395,
        accuracyM = 12f,
        timestampMs = 1_735_689_600_000L,
    ),
)

private const val AccuracyFormat = "%.0f 米"
private const val BorderWidthDivisor = 8f
private const val CoordinateFormat = "%.6f"
private const val CriticalCardAlpha = 0.18f
private const val TimeFormat = "HH:mm:ss"

@Preview(showBackground = true)
@Composable
private fun EmergencyCallSimulationDialogPreview() {
    FirstAidTheme {
        EmergencyCallSimulationDialog(
            onDismiss = {},
            mock = true,
        )
    }
}
