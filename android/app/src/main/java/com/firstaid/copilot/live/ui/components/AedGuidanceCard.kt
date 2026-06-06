package com.firstaid.copilot.live.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType

@Composable
fun AedGuidanceCard(
    currentStep: Int,
    modifier: Modifier = Modifier,
) {
    val activeStep = currentStep.coerceIn(AedStepMin, AedSteps.size)

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(FirstAidDimens.CardRadius),
        color = FirstAidColors.Surface,
    ) {
        Column(
            modifier = Modifier.padding(FirstAidDimens.ScreenPadding),
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        ) {
            Text(
                text = "AED 分步引导",
                style = FirstAidType.Title,
                color = FirstAidColors.TextPrimary,
            )

            AedSteps.forEachIndexed { index, instruction ->
                val stepNumber = index + AedStepMin
                AedGuidanceStepRow(
                    stepNumber = stepNumber,
                    instruction = instruction,
                    isActive = stepNumber == activeStep,
                    isCompleted = stepNumber < activeStep,
                )
            }
        }
    }
}

@Composable
private fun AedGuidanceStepRow(
    stepNumber: Int,
    instruction: String,
    isActive: Boolean,
    isCompleted: Boolean,
    modifier: Modifier = Modifier,
) {
    val activeAccent = if (stepNumber == NoTouchStepNumber) {
        FirstAidColors.Warning
    } else {
        FirstAidColors.Progress
    }
    val textColor = when {
        isCompleted -> FirstAidColors.TextTertiary
        isActive -> activeAccent
        else -> FirstAidColors.TextSecondary
    }
    val indicatorBackground = when {
        isActive -> activeAccent
        isCompleted -> FirstAidColors.SurfaceVariant
        else -> Color.Transparent
    }
    val indicatorBorder = if (isActive) {
        activeAccent
    } else {
        FirstAidColors.SurfaceVariant
    }
    val indicatorTextColor = if (isActive) {
        FirstAidColors.OnAccent
    } else {
        textColor
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FirstAidDimens.ChipRadius))
            .background(if (isActive) activeAccent.copy(alpha = ActiveRowAlpha) else Color.Transparent)
            .padding(
                horizontal = FirstAidDimens.TightGap,
                vertical = FirstAidDimens.TightGap,
            ),
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(FirstAidDimens.PrimaryControlHeight / IndicatorSizeDivisor)
                .clip(CircleShape)
                .background(indicatorBackground)
                .border(
                    width = FirstAidDimens.TightGap / BorderWidthDivisor,
                    color = indicatorBorder,
                    shape = CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stepNumber.toString(),
                style = FirstAidType.Label,
                color = indicatorTextColor,
                fontWeight = if (isActive) FontWeight.Bold else FontWeight.SemiBold,
            )
        }

        Text(
            text = instruction.withNoTouchHighlight(textColor),
            modifier = Modifier.weight(1f),
            style = FirstAidType.Body,
            color = textColor,
            fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
        )
    }
}

private fun String.withNoTouchHighlight(baseColor: Color) = buildAnnotatedString {
    val highlightStart = indexOf(NoTouchPhrase)
    if (highlightStart < 0) {
        append(this@withNoTouchHighlight)
        return@buildAnnotatedString
    }

    append(substring(startIndex = 0, endIndex = highlightStart))
    withStyle(
        SpanStyle(
            color = FirstAidColors.Critical,
            fontWeight = FontWeight.Bold,
        ),
    ) {
        append(NoTouchPhrase)
    }
    withStyle(SpanStyle(color = baseColor)) {
        append(substring(startIndex = highlightStart + NoTouchPhrase.length))
    }
}

private val AedSteps = listOf(
    "打开 AED 电源",
    "贴好两片电极片（按图示位置）",
    "插入电极插头",
    "分析心律，所有人不要触碰患者",
    "提示电击时按下电击键",
    "立即继续胸外按压",
)

private const val ActiveRowAlpha = 0.14f
private const val AedStepMin = 1
private const val BorderWidthDivisor = 8f
private const val IndicatorSizeDivisor = 2f
private const val NoTouchPhrase = "不要触碰"
private const val NoTouchStepNumber = 4

@Preview(showBackground = true)
@Composable
private fun AedGuidanceCardFirstStepPreview() {
    AedGuidancePreviewSurface {
        AedGuidanceCard(currentStep = 1)
    }
}

@Preview(showBackground = true)
@Composable
private fun AedGuidanceCardNoTouchStepPreview() {
    AedGuidancePreviewSurface {
        AedGuidanceCard(currentStep = 4)
    }
}

@Composable
private fun AedGuidancePreviewSurface(content: @Composable () -> Unit) {
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
