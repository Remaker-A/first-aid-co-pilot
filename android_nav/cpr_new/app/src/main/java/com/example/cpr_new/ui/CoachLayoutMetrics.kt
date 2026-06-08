package com.example.cpr_new.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

/** 进行态布局预留尺寸：为顶栏/底栏留出空间，避免内容挤压与点击穿透。 */
object CoachLayoutMetrics {
    val TopBarHeight = 48.dp
    val BottomDockVoiceRow = 48.dp
    val BottomDockEmergencyRow = 36.dp
    val BottomDockSurfacePadding = 20.dp
    val PrimaryButtonHeight = 56.dp
    val ChromeGap = 8.dp
    val DockCollapsedHeight =
        BottomDockSurfacePadding + BottomDockVoiceRow + ChromeGap + BottomDockEmergencyRow
    val VoiceBarExpanded = 88.dp
    val ScreenHorizontal = 16.dp
}

@Composable
fun coachTopInset(): androidx.compose.ui.unit.Dp {
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    return statusTop + CoachLayoutMetrics.TopBarHeight + CoachLayoutMetrics.ChromeGap
}

@Composable
fun coachDockBottomInset(inputExpanded: Boolean = false): androidx.compose.ui.unit.Dp {
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val dock = if (inputExpanded) {
        CoachLayoutMetrics.VoiceBarExpanded + CoachLayoutMetrics.ChromeGap
    } else {
        CoachLayoutMetrics.DockCollapsedHeight + CoachLayoutMetrics.ChromeGap
    }
    return navBottom + dock + CoachLayoutMetrics.ChromeGap
}

@Composable
fun coachPrimaryButtonBottomInset(inputExpanded: Boolean = false): androidx.compose.ui.unit.Dp =
    coachDockBottomInset(inputExpanded) + CoachLayoutMetrics.PrimaryButtonHeight + CoachLayoutMetrics.ChromeGap

/** @deprecated 仅保留兼容；进行态请用 [coachTopInset] / [coachDockBottomInset]。 */
@Composable
fun coachContentPadding(inputExpanded: Boolean = false): PaddingValues =
    PaddingValues(
        top = coachTopInset(),
        bottom = coachDockBottomInset(inputExpanded),
        start = CoachLayoutMetrics.ScreenHorizontal,
        end = CoachLayoutMetrics.ScreenHorizontal,
    )
