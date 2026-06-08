package com.example.cpr_new.ui

import androidx.compose.ui.graphics.Color

/**
 * 急救场景专用高对比配色 —— 急救 UI。
 *
 * 设计基调（v2）：
 * - 背景用**深冷石墨蓝**而非纯黑，更有质感、长时间盯看不刺眼；
 * - **红色克制使用**，只留给“真危险 / 主操作”，避免整屏报警感加重施救者焦虑；
 * - 常态/指导用冷静的**青蓝**，达标/警告/危险沿用绿/琥珀/红强语义色，一眼可读；
 * - 卡片用分层灰阶 + 细描边制造层次，避免暗色面块糊在一起。
 *
 * 颜色独立于 Material 主题，确保任何系统主题下都稳定可读。属性名保持稳定（供组件引用）。
 */
object EmergencyPalette {
    val Background = Color(0xFF0B0D12)

    /** 背景纵向渐变端点：顶部略亮、底部更深，营造纵深而非死黑。 */
    val BackgroundTop = Color(0xFF121620)
    val BackgroundBottom = Color(0xFF080A0E)

    /** 卡片面。 */
    val Surface = Color(0xFF161B23)

    /** 比 Surface 略亮，用于卡片内的指标小块，制造轻微层次。 */
    val SurfaceVariant = Color(0xFF1F2630)

    /** 卡片描边：低调勾勒边界。 */
    val Outline = Color(0xFF2B323D)

    val OnSurface = Color(0xFFF4F6FA)
    val OnSurfaceMuted = Color(0xFF99A2AE)

    /** 达标 / 正确。 */
    val Good = Color(0xFF30D158)

    /** 警告 / 需要调整。 */
    val Warn = Color(0xFFFFC53D)

    /** 危险 / 严重告警。 */
    val Danger = Color(0xFFFF453A)

    /** 主操作（开始急救 / 拨打 120）。 */
    val Primary = Color(0xFFFF3B30)

    /** 中性强调（节拍器 / 常态指导）：冷静青蓝，降低焦虑。 */
    val Accent = Color(0xFF38BDF8)

    /** 语义色的柔和底色（半透明），用于指标块 / 告警背景填充。 */
    val GoodSoft = Color(0x2630D158)
    val WarnSoft = Color(0x26FFC53D)
    val DangerSoft = Color(0x26FF453A)
    val AccentSoft = Color(0x2638BDF8)

    /** 未达标 / 未点亮的轨道颜色（步进条、环形进度底环）。 */
    val Track = Color(0xFF2A313C)
}
