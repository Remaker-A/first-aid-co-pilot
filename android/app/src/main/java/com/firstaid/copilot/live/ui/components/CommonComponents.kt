package com.firstaid.copilot.live.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import com.firstaid.copilot.live.SourceBadge
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType

@Composable
fun SourceBadgeChip(
    badge: SourceBadge,
    modifier: Modifier = Modifier,
) {
    val accent = badge.accentColor()

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(FirstAidDimens.ChipRadius))
            .background(accent.copy(alpha = ChipBackgroundAlpha))
            .padding(
                horizontal = FirstAidDimens.ItemGap,
                vertical = FirstAidDimens.TightGap,
            )
            .clearAndSetSemantics {
                contentDescription = "数据来源：${badge.labelText()}"
            },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(FirstAidDimens.TightGap)
                .clip(CircleShape)
                .background(accent),
        )
        Text(
            text = badge.labelText(),
            style = FirstAidType.Label,
            color = accent,
        )
    }
}

@Composable
fun ErrorBanner(
    message: String?,
    modifier: Modifier = Modifier,
    onDismiss: (() -> Unit)? = null,
) {
    val visibleMessage = message?.takeIf { it.isNotBlank() } ?: return

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FirstAidDimens.ChipRadius))
            .background(FirstAidColors.ErrorRed.copy(alpha = BannerBackgroundAlpha))
            .border(
                width = FirstAidDimens.TightGap / BorderDivisor,
                color = FirstAidColors.Critical,
                shape = RoundedCornerShape(FirstAidDimens.ChipRadius),
            )
            .semantics {
                contentDescription = "错误提示：$visibleMessage"
                liveRegion = LiveRegionMode.Assertive
            }
            .padding(
                horizontal = FirstAidDimens.ItemGap,
                vertical = FirstAidDimens.TightGap,
            ),
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(FirstAidDimens.TightGap)
                .clip(CircleShape)
                .background(FirstAidColors.Critical),
        )
        Text(
            text = visibleMessage,
            modifier = Modifier.weight(1f),
            style = FirstAidType.Body,
            color = FirstAidColors.Critical,
            maxLines = ErrorMessageMaxLines,
            overflow = TextOverflow.Ellipsis,
        )
        if (onDismiss != null) {
            Box(
                modifier = Modifier
                    .sizeIn(
                        minWidth = FirstAidDimens.MinTouch,
                        minHeight = FirstAidDimens.MinTouch,
                    )
                    .clip(CircleShape)
                    .clickable(onClick = onDismiss)
                    .semantics {
                        contentDescription = "关闭错误提示"
                        role = Role.Button
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "×",
                    style = FirstAidType.Title,
                    color = FirstAidColors.Critical,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
fun ResponseStrip(
    text: String?,
    speaking: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val visibleText = text?.takeIf { it.isNotBlank() } ?: return

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FirstAidDimens.CardRadius))
            .background(FirstAidColors.Scrim)
            .clearAndSetSemantics {
                contentDescription = if (speaking) {
                    "正在播报：$visibleText"
                } else {
                    "回应提示：$visibleText"
                }
                liveRegion = LiveRegionMode.Polite
            }
            .padding(FirstAidDimens.ItemGap),
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (speaking) {
            SpeakingIndicator()
        }
        Text(
            text = visibleText,
            modifier = Modifier.weight(1f),
            style = FirstAidType.Body,
            color = FirstAidColors.TextPrimary,
            maxLines = ResponseMaxLines,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
fun StageProgressRail(
    currentStage: String?,
    modifier: Modifier = Modifier,
) {
    val currentIndex = remember(currentStage) { currentStage.stageIndex() }
    val currentStageLabel = remember(currentIndex) {
        StageLabels.getOrNull(currentIndex - StageNumberOffset) ?: "未开始"
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "当前阶段：$currentStageLabel"
                stateDescription = "$currentIndex/${StageLabels.size}"
            },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap / RailGapDivisor),
        verticalAlignment = Alignment.Top,
    ) {
        StageLabels.forEachIndexed { index, label ->
            val stageNumber = index + StageNumberOffset
            val active = stageNumber <= currentIndex
            val color = if (active) FirstAidColors.Progress else FirstAidColors.SurfaceVariant

            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(FirstAidDimens.TightGap)
                        .clip(RoundedCornerShape(FirstAidDimens.ChipRadius))
                        .background(color),
                )
                Spacer(modifier = Modifier.height(FirstAidDimens.TightGap / RailGapDivisor))
                Text(
                    text = label,
                    style = FirstAidType.Label,
                    color = if (active) FirstAidColors.Progress else FirstAidColors.TextTertiary,
                    maxLines = StageLabelMaxLines,
                    overflow = TextOverflow.Clip,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
fun PrimaryActionButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emphasized: Boolean = true,
) {
    val containerColor = if (emphasized) FirstAidColors.Progress else FirstAidColors.SurfaceVariant
    val contentColor = if (emphasized) FirstAidColors.OnAccent else FirstAidColors.TextPrimary

    Button(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .sizeIn(minHeight = FirstAidDimens.MinTouch)
            .height(FirstAidDimens.PrimaryControlHeight)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        shape = RoundedCornerShape(FirstAidDimens.ButtonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = containerColor,
            contentColor = contentColor,
        ),
    ) {
        Text(
            text = label,
            style = FirstAidType.Title,
            color = contentColor,
        )
    }
}

@Composable
private fun SpeakingIndicator(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "speaking-pulse")
    val pulseAlpha by transition.animateFloat(
        initialValue = PulseAlphaMin,
        targetValue = PulseAlphaMax,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = PulseDurationMillis),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "speaking-pulse-alpha",
    )

    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(FirstAidDimens.TightGap)
                .clip(CircleShape)
                .background(FirstAidColors.Progress.copy(alpha = pulseAlpha)),
        )
        Text(
            text = "播报中",
            style = FirstAidType.Label,
            color = FirstAidColors.Progress,
        )
    }
}

private fun SourceBadge.labelText(): String =
    when (this) {
        SourceBadge.DemoData -> "演示数据"
        SourceBadge.RecordingOnly -> "仅录制"
        SourceBadge.LiveRecognition -> "实时识别"
    }

private fun SourceBadge.accentColor(): Color =
    when (this) {
        SourceBadge.DemoData -> FirstAidColors.Warning
        SourceBadge.RecordingOnly -> FirstAidColors.Info
        SourceBadge.LiveRecognition -> FirstAidColors.Progress
    }

private fun String?.stageIndex(): Int =
    this
        ?.let { StagePattern.find(it) }
        ?.groupValues
        ?.getOrNull(StageGroupIndex)
        ?.toIntOrNull()
        ?.coerceIn(StageMinIndex, StageMaxIndex)
        ?: StageMinIndex

private val StagePattern = Regex("S(\\d+)")

private val StageLabels = listOf(
    "安全",
    "反应",
    "呼吸",
    "呼叫",
    "呼叫",
    "准备",
    "按压",
    "协助",
    "交接",
)

private const val BannerBackgroundAlpha = 0.18f
private const val BorderDivisor = 8f
private const val ChipBackgroundAlpha = 0.18f
private const val ErrorMessageMaxLines = 2
private const val PulseAlphaMin = 0.35f
private const val PulseAlphaMax = 1f
private const val PulseDurationMillis = 650
private const val RailGapDivisor = 2f
private const val ResponseMaxLines = 3
private const val StageGroupIndex = 1
private const val StageLabelMaxLines = 1
private const val StageMaxIndex = 9
private const val StageMinIndex = 0
private const val StageNumberOffset = 1

@Preview(showBackground = true)
@Composable
private fun SourceBadgeChipPreview() {
    PreviewSurface {
        SourceBadgeChip(badge = SourceBadge.LiveRecognition)
    }
}

@Preview(showBackground = true)
@Composable
private fun ErrorBannerPreview() {
    PreviewSurface {
        ErrorBanner(
            message = "麦克风不可用，正在使用演示数据。",
            onDismiss = {},
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun ResponseStripPreview() {
    PreviewSurface {
        ResponseStrip(
            text = "保持节奏，继续按压。每次按压后让胸廓完全回弹。",
            speaking = true,
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun StageProgressRailPreview() {
    PreviewSurface {
        StageProgressRail(currentStage = "S7_CPR_LOOP")
    }
}

@Preview(showBackground = true)
@Composable
private fun PrimaryActionButtonPreview() {
    PreviewSurface {
        PrimaryActionButton(
            label = "开始急救",
            onClick = {},
        )
    }
}

@Composable
private fun PreviewSurface(content: @Composable () -> Unit) {
    FirstAidTheme {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(FirstAidColors.Background)
                .padding(FirstAidDimens.ScreenPadding),
        ) {
            content()
        }
    }
}
