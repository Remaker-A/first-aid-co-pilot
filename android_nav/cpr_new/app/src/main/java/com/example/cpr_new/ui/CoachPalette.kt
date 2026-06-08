package com.example.cpr_new.ui

import androidx.compose.ui.graphics.Color

/**
 * 对齐 first-aid-co-pilot LiveCprCoachScreen 的深色教练色板。
 * 所有进行态 UI 只从这里取色，避免 Material 默认浅色按钮穿帮。
 */
object CoachPalette {
    val Background = Color(0xFF070B12)
    val CameraDim = Color(0x99070B12)
    val CameraFallback = Color(0xFF111827)
    val CameraFrame = Color(0xFF0F172A)
    val CameraBorder = Color(0xFF334155)

    val TopBar = Color(0x990F172A)
    val Panel = Color(0xE60B1220)
    val Rail = Color(0xB30F172A)
    val VoiceBar = Color(0xE60F172A)

    val TextPrimary = Color(0xFFFFFFFF)
    val TextSecondary = Color(0xFFCBD5E1)
    val TextMuted = Color(0xFF94A3B8)
    val TextHint = Color(0xFF64748B)

    val ActionStart = Color(0xFF16A34A)
    val ActionListen = Color(0xFF2563EB)
    val ActionStop = Color(0xFFDC2626)
    val ActionEmergency = Color(0xFFDC2626)

    val RailActive = Color(0xFF22C55E)
    val RailInactive = Color(0xFF334155)
    val Outline = Color(0xFF334155)
    val InputBg = Color(0xFF1E293B)

    val ChipOnline = Color(0xFF16A34A)
    val ChipHttp = Color(0xFF38BDF8)
    val ChipOffline = Color(0xFFF59E0B)
    val ChipError = Color(0xFFDC2626)
}
