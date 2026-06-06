package com.firstaid.copilot.live.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Typographic scale for the emergency-alert look. [DisplayHero] is the
 * eyes-off CPR headline; [Metric] is for big numbers (quality score, rate).
 * Components reference these directly so sizes never drift.
 */
object FirstAidType {
    val DisplayHero = TextStyle(fontSize = 62.sp, lineHeight = 68.sp, fontWeight = FontWeight.Black)
    val Headline = TextStyle(fontSize = 34.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold)
    val Title = TextStyle(fontSize = 23.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold)
    val Body = TextStyle(fontSize = 17.sp, lineHeight = 26.sp, fontWeight = FontWeight.Normal)
    val Label = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.2.sp,
    )
    val Metric = TextStyle(fontSize = 46.sp, lineHeight = 52.sp, fontWeight = FontWeight.Black)
}
