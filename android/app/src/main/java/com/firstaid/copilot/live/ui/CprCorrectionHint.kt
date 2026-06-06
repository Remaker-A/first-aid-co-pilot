package com.firstaid.copilot.live.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType

@Composable
fun CprCorrectionHint(
    handPosition: String?,
    rate: Int?,
    armStraight: Boolean?,
    modifier: Modifier = Modifier,
) {
    val hint = cprHintFor(
        handPosition = handPosition,
        rate = rate,
        armStraight = armStraight,
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FirstAidDimens.CardRadius))
            .background(if (hint.calm) FirstAidColors.ScrimSoft else FirstAidColors.Scrim)
            .clearAndSetSemantics {
                contentDescription = if (hint.calm) {
                    hint.message
                } else {
                    "按压纠正：${hint.message}"
                }
            }
            .padding(FirstAidDimens.SectionGap),
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HintGlyph(
            hint = hint,
            modifier = Modifier.size(
                if (hint.calm) FirstAidDimens.MinTouch else FirstAidDimens.PrimaryControlHeight,
            ),
        )
        Text(
            text = hint.message,
            modifier = Modifier.weight(1f),
            style = if (hint.calm) FirstAidType.Title else FirstAidType.Headline,
            color = hint.accent,
            maxLines = if (hint.calm) CalmHintMaxLines else AlertHintMaxLines,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
fun BeatPulse(
    bpm: Int?,
    modifier: Modifier = Modifier,
) {
    val displayedBpm = bpm ?: DefaultBpm
    val periodMillis = MinuteMillis / displayedBpm.coerceAtLeast(MinAnimatedBpm)
    val transition = rememberInfiniteTransition(label = "cpr-beat-pulse")
    val pulse by transition.animateFloat(
        initialValue = PulseStart,
        targetValue = PulseEnd,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = periodMillis),
            repeatMode = RepeatMode.Restart,
        ),
        label = "cpr-beat-progress",
    )

    Column(
        modifier = modifier.clearAndSetSemantics {
            contentDescription = "节拍提示，每分钟 $displayedBpm 次"
        },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Canvas(
            modifier = Modifier.size(FirstAidDimens.PrimaryControlHeight + FirstAidDimens.MinTouch),
        ) {
            val center = Offset(size.width / CenterDivisor, size.height / CenterDivisor)
            val dotRadius = size.minDimension * BeatDotRadiusFraction
            val ringRadius = dotRadius + size.minDimension * BeatRingTravelFraction * pulse
            val ringAlpha = BeatRingAlpha * (PulseEnd - pulse)

            drawCircle(
                color = FirstAidColors.Progress.copy(alpha = BeatHaloAlpha),
                radius = size.minDimension * BeatHaloRadiusFraction,
                center = center,
            )
            drawCircle(
                color = FirstAidColors.Progress.copy(alpha = ringAlpha),
                radius = ringRadius,
                center = center,
                style = Stroke(width = FirstAidDimens.TightGap.toPx(), cap = StrokeCap.Round),
            )
            drawCircle(
                color = FirstAidColors.Progress,
                radius = dotRadius,
                center = center,
            )
        }
        Spacer(modifier = Modifier.height(FirstAidDimens.TightGap))
        Text(
            text = "$displayedBpm 次/分",
            style = FirstAidType.Label,
            color = FirstAidColors.Progress,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun HintGlyph(
    hint: CprHint,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val center = Offset(size.width / CenterDivisor, size.height / CenterDivisor)
        val strokeWidth = FirstAidDimens.TightGap.toPx() / StrokeWidthDivisor
        val targetRadius = size.minDimension * TargetRadiusFraction

        drawCircle(
            color = hint.accent.copy(alpha = TargetBackgroundAlpha),
            radius = targetRadius,
            center = center,
        )
        drawCircle(
            color = hint.accent.copy(alpha = TargetStrokeAlpha),
            radius = targetRadius,
            center = center,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
        drawLine(
            color = hint.accent.copy(alpha = TargetStrokeAlpha),
            start = Offset(center.x - targetRadius, center.y),
            end = Offset(center.x + targetRadius, center.y),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = hint.accent.copy(alpha = TargetStrokeAlpha),
            start = Offset(center.x, center.y - targetRadius),
            end = Offset(center.x, center.y + targetRadius),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )

        hint.arrow?.let { arrow ->
            drawHintArrow(
                direction = arrow,
                color = hint.accent,
                center = center,
                strokeWidth = FirstAidDimens.TightGap.toPx(),
            )
        } ?: drawCircle(
            color = hint.accent,
            radius = size.minDimension * GoodDotRadiusFraction,
            center = center,
        )
    }
}

private fun cprHintFor(
    handPosition: String?,
    rate: Int?,
    armStraight: Boolean?,
): CprHint {
    val normalizedPosition = handPosition?.lowercase()

    return when {
        normalizedPosition == HandPositionLeft -> CprHint(
            message = "手往右移到胸口中央",
            accent = FirstAidColors.Critical,
            arrow = HintArrow.Right,
        )
        normalizedPosition == HandPositionRight -> CprHint(
            message = "手往左移到胸口中央",
            accent = FirstAidColors.Critical,
            arrow = HintArrow.Left,
        )
        rate != null && rate < TargetRateMin -> CprHint(
            message = "快一点",
            accent = FirstAidColors.Warning,
            arrow = HintArrow.Up,
        )
        rate != null && rate > TargetRateMax -> CprHint(
            message = "慢一点",
            accent = FirstAidColors.Warning,
            arrow = HintArrow.Down,
        )
        armStraight == false -> CprHint(
            message = "手臂伸直，用上半身向下压",
            accent = FirstAidColors.Warning,
            arrow = HintArrow.Down,
        )
        else -> CprHint(
            message = "按压良好",
            accent = FirstAidColors.Progress,
            arrow = null,
            calm = true,
        )
    }
}

private fun DrawScope.drawHintArrow(
    direction: HintArrow,
    color: Color,
    center: Offset,
    strokeWidth: Float,
) {
    val length = size.minDimension * ArrowLengthFraction
    val halfLength = length / CenterDivisor
    val start = when (direction) {
        HintArrow.Left -> Offset(center.x + halfLength, center.y)
        HintArrow.Right -> Offset(center.x - halfLength, center.y)
        HintArrow.Up -> Offset(center.x, center.y + halfLength)
        HintArrow.Down -> Offset(center.x, center.y - halfLength)
    }
    val end = when (direction) {
        HintArrow.Left -> Offset(center.x - halfLength, center.y)
        HintArrow.Right -> Offset(center.x + halfLength, center.y)
        HintArrow.Up -> Offset(center.x, center.y - halfLength)
        HintArrow.Down -> Offset(center.x, center.y + halfLength)
    }

    drawLine(
        color = color,
        start = start,
        end = end,
        strokeWidth = strokeWidth,
        cap = StrokeCap.Round,
    )
    drawPath(
        path = arrowHeadPath(direction = direction, tip = end, size = FirstAidDimens.ItemGap.toPx()),
        color = color,
    )
}

private fun arrowHeadPath(
    direction: HintArrow,
    tip: Offset,
    size: Float,
): Path =
    Path().apply {
        moveTo(tip.x, tip.y)
        when (direction) {
            HintArrow.Left -> {
                lineTo(tip.x + size, tip.y - size * ArrowHeadSlope)
                lineTo(tip.x + size, tip.y + size * ArrowHeadSlope)
            }
            HintArrow.Right -> {
                lineTo(tip.x - size, tip.y - size * ArrowHeadSlope)
                lineTo(tip.x - size, tip.y + size * ArrowHeadSlope)
            }
            HintArrow.Up -> {
                lineTo(tip.x - size * ArrowHeadSlope, tip.y + size)
                lineTo(tip.x + size * ArrowHeadSlope, tip.y + size)
            }
            HintArrow.Down -> {
                lineTo(tip.x - size * ArrowHeadSlope, tip.y - size)
                lineTo(tip.x + size * ArrowHeadSlope, tip.y - size)
            }
        }
        close()
    }

private data class CprHint(
    val message: String,
    val accent: Color,
    val arrow: HintArrow?,
    val calm: Boolean = false,
)

private enum class HintArrow {
    Left,
    Right,
    Up,
    Down,
}

@Preview(showBackground = true)
@Composable
private fun CprCorrectionHintNormalPreview() {
    PreviewSurface {
        Column(
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.SectionGap),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CprCorrectionHint(
                handPosition = HandPositionCenter,
                rate = DefaultBpm,
                armStraight = true,
            )
            BeatPulse(bpm = DefaultBpm)
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun CprCorrectionHintAbnormalPreview() {
    PreviewSurface {
        Column(
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.SectionGap),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CprCorrectionHint(
                handPosition = HandPositionLeft,
                rate = TargetRateMin - RatePreviewOffset,
                armStraight = false,
            )
            BeatPulse(bpm = TargetRateMin - RatePreviewOffset)
        }
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

private const val AlertHintMaxLines = 2
private const val ArrowHeadSlope = 0.72f
private const val ArrowLengthFraction = 0.68f
private const val BeatDotRadiusFraction = 0.18f
private const val BeatHaloAlpha = 0.14f
private const val BeatHaloRadiusFraction = 0.34f
private const val BeatRingAlpha = 0.58f
private const val BeatRingTravelFraction = 0.2f
private const val CalmHintMaxLines = 1
private const val CenterDivisor = 2f
private const val DefaultBpm = 110
private const val GoodDotRadiusFraction = 0.08f
private const val HandPositionCenter = "center"
private const val HandPositionLeft = "left"
private const val HandPositionRight = "right"
private const val MinAnimatedBpm = 1
private const val MinuteMillis = 60_000
private const val PulseEnd = 1f
private const val PulseStart = 0f
private const val RatePreviewOffset = 14
private const val StrokeWidthDivisor = 2f
private const val TargetBackgroundAlpha = 0.14f
private const val TargetRateMax = 120
private const val TargetRateMin = 100
private const val TargetRadiusFraction = 0.24f
private const val TargetStrokeAlpha = 0.7f
