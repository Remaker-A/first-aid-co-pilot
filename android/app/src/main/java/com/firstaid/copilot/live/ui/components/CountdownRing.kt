package com.firstaid.copilot.live.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType

@Composable
fun CountdownRing(
    secondsTotal: Int,
    secondsLeft: Int,
    label: String,
    modifier: Modifier = Modifier,
) {
    val boundedTotal = secondsTotal.coerceAtLeast(0)
    val boundedLeft = if (boundedTotal == 0) {
        0
    } else {
        secondsLeft.coerceIn(0, boundedTotal)
    }
    val remainingRatio = if (boundedTotal == 0) {
        0f
    } else {
        boundedLeft.toFloat() / boundedTotal.toFloat()
    }
    val progressColor = countdownProgressColor(remainingRatio)

    Box(
        modifier = modifier.size(FirstAidDimens.MinTouch * RingSizeMultiplier),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(
            modifier = Modifier
                .matchParentSize()
                .padding(FirstAidDimens.TightGap),
        ) {
            val strokeWidth = FirstAidDimens.TightGap.toPx()
            val diameter = size.minDimension - strokeWidth
            val arcTopLeft = Offset(
                x = (size.width - diameter) / CenterDivisor,
                y = (size.height - diameter) / CenterDivisor,
            )
            val arcSize = Size(width = diameter, height = diameter)
            val ringStyle = Stroke(width = strokeWidth, cap = StrokeCap.Round)

            drawArc(
                color = FirstAidColors.SurfaceVariant,
                startAngle = RingStartAngle,
                sweepAngle = FullCircleDegrees,
                useCenter = false,
                topLeft = arcTopLeft,
                size = arcSize,
                style = ringStyle,
            )

            if (remainingRatio > 0f) {
                drawArc(
                    color = progressColor,
                    startAngle = RingStartAngle,
                    sweepAngle = FullCircleDegrees * remainingRatio,
                    useCenter = false,
                    topLeft = arcTopLeft,
                    size = arcSize,
                    style = ringStyle,
                )
            }
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = boundedLeft.toString(),
                style = FirstAidType.Metric,
                color = progressColor,
                textAlign = TextAlign.Center,
            )
            Text(
                text = label,
                style = FirstAidType.Label,
                color = FirstAidColors.TextSecondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun countdownProgressColor(remainingRatio: Float): Color {
    val boundedRatio = remainingRatio.coerceIn(0f, 1f)
    return if (boundedRatio >= WarningThreshold) {
        lerp(
            FirstAidColors.Warning,
            FirstAidColors.Progress,
            (boundedRatio - WarningThreshold) / WarningThreshold,
        )
    } else {
        lerp(
            FirstAidColors.Critical,
            FirstAidColors.Warning,
            boundedRatio / WarningThreshold,
        )
    }
}

private const val CenterDivisor = 2f
private const val FullCircleDegrees = 360f
private const val RingSizeMultiplier = 3.4f
private const val RingStartAngle = -90f
private const val WarningThreshold = 0.5f

@Preview(showBackground = true)
@Composable
private fun CountdownRingFullPreview() {
    CountdownRingPreviewSurface {
        CountdownRing(
            secondsTotal = 10,
            secondsLeft = 10,
            label = "检查呼吸",
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun CountdownRingUrgentPreview() {
    CountdownRingPreviewSurface {
        CountdownRing(
            secondsTotal = 10,
            secondsLeft = 2,
            label = "准备换手",
        )
    }
}

@Composable
private fun CountdownRingPreviewSurface(content: @Composable () -> Unit) {
    FirstAidTheme {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(FirstAidColors.Background)
                .padding(FirstAidDimens.ScreenPadding),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}
