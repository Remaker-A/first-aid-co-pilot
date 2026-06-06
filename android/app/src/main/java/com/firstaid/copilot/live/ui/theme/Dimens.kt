package com.firstaid.copilot.live.ui.theme

import androidx.compose.ui.unit.dp

/**
 * Spacing / radius / sizing tokens. Touch targets stay >= [MinTouch] so the app
 * is usable under stress with shaky hands.
 */
object FirstAidDimens {
    val ScreenPadding = 22.dp
    val SectionGap = 18.dp
    val ItemGap = 12.dp
    val TightGap = 8.dp

    val CardRadius = 30.dp
    val ChipRadius = 24.dp
    val ButtonRadius = 22.dp
    val CardStrokeWidth = 1.dp
    val DividerThickness = 1.dp

    val MinTouch = 56.dp
    val PrimaryControlHeight = 76.dp
}
