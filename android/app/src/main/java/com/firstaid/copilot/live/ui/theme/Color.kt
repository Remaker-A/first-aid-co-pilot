package com.firstaid.copilot.live.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Emergency-alert palette for the Live CPR Coach. Every screen reads tokens from
 * here instead of inlining `Color(0xFF...)`, so the look stays consistent and a
 * later visual tweak only touches this file.
 *
 * Semantics:
 * - [Critical] danger / stop, [Progress] advance / good, [Warning] caution,
 *   [Info] neutral-but-active. Use these for state, not decoration.
 */
object FirstAidColors {
    // Surfaces (dark, immersive).
    val Background = Color(0xFF080D14)
    val Surface = Color(0xFF111A27)
    val SurfaceVariant = Color(0xFF1D2736)
    val SurfaceElevated = Color(0xFF243044)
    val CardStroke = Color(0xFF334155)
    val Divider = Color(0xFF263244)

    /** Translucent card over the camera/overlay so guidance stays legible. */
    val Scrim = Color(0xE6080D14)
    val ScrimSoft = Color(0x990F172A)

    // Semantic status colors.
    val Critical = Color(0xFFFF4D55)
    val Progress = Color(0xFF34C77B)
    val Warning = Color(0xFFFFB02E)
    val Info = Color(0xFF60A5FA)
    val CriticalSurface = Color(0x33FF4D55)

    // Text layers.
    val TextPrimary = Color(0xFFF8FAFC)
    val TextSecondary = Color(0xFFD7DEE8)
    val TextTertiary = Color(0xFF8A99AD)

    // Connection / availability.
    val Idle = Color(0xFF64748B)
    val Online = Color(0xFF22C55E)
    val Offline = Color(0xFFF59E0B)
    val ErrorRed = Color(0xFFEF4444)

    /** Foreground that sits on a saturated accent fill. */
    val OnAccent = Color(0xFF080D14)
}
