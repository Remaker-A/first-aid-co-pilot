package com.firstaid.copilot.live.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

/**
 * App-wide dark, emergency-alert theme. Kept intentionally simple: a single
 * dark [androidx.compose.material3.ColorScheme] mapped from [FirstAidColors] so
 * Material defaults (ripples, text fields, etc.) inherit sensible colors, while
 * screens mostly read explicit [FirstAidColors] / [FirstAidType] tokens.
 */
private val FirstAidColorScheme = darkColorScheme(
    primary = FirstAidColors.Info,
    onPrimary = FirstAidColors.TextPrimary,
    secondary = FirstAidColors.Progress,
    onSecondary = FirstAidColors.OnAccent,
    error = FirstAidColors.Critical,
    onError = FirstAidColors.TextPrimary,
    background = FirstAidColors.Background,
    onBackground = FirstAidColors.TextPrimary,
    surface = FirstAidColors.Surface,
    onSurface = FirstAidColors.TextPrimary,
    surfaceVariant = FirstAidColors.SurfaceVariant,
    onSurfaceVariant = FirstAidColors.TextSecondary,
)

@Composable
fun FirstAidTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = FirstAidColorScheme,
        content = content,
    )
}
