package com.example.cpr_new.ui.theme

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import com.example.cpr_new.ui.CoachPalette

private val EmergencyColorScheme = darkColorScheme(
    primary = CoachPalette.ActionStart,
    onPrimary = Color.White,
    secondary = CoachPalette.ActionListen,
    onSecondary = Color.White,
    background = CoachPalette.Background,
    onBackground = CoachPalette.TextPrimary,
    surface = CoachPalette.Panel,
    onSurface = CoachPalette.TextPrimary,
    error = CoachPalette.ActionEmergency,
    onError = Color.White,
)

@Composable
fun Cpr_newTheme(content: @Composable () -> Unit) {
    val colorScheme = EmergencyColorScheme

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = CoachPalette.Background.toArgb()
            window.navigationBarColor = CoachPalette.Background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content,
    )
}
