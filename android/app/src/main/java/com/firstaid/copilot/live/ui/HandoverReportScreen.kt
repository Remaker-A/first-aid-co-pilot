package com.firstaid.copilot.live.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.live.ui.theme.FirstAidDimens
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.live.ui.theme.FirstAidType

data class HandoverEvent(val timeText: String, val text: String)

data class HandoverReportUiModel(
    val startedAtText: String,
    val durationText: String,
    val totalCompressions: Int?,
    val averageRate: Int?,
    val averageQuality: Int?,
    val symptomSummary: String,
    val events: List<HandoverEvent>,
    val aedStatus: String,
    val videoSaved: Boolean,
    val reportText: String? = null,
)

@Composable
fun HandoverReportScreen(
    model: HandoverReportUiModel,
    onShare: () -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(FirstAidColors.Background)
            .padding(FirstAidDimens.ScreenPadding),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(FirstAidDimens.SectionGap),
        ) {
            Header(onClose = onClose)
            MetricsCard(model = model)
            OverviewCard(model = model)
            TimelineCard(events = model.events)
            model.reportText?.takeIf { it.isNotBlank() }?.let { reportText ->
                ReportTextCard(reportText = reportText)
            }
        }

        Spacer(modifier = Modifier.height(FirstAidDimens.SectionGap))
        BottomActions(onSave = onSave, onShare = onShare)
    }
}

@Composable
private fun Header(onClose: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "急救交接报告",
            modifier = Modifier.semantics {
                heading()
                contentDescription = "急救交接报告"
            },
            style = FirstAidType.Headline,
            color = FirstAidColors.TextPrimary,
        )
        TextButton(
            onClick = onClose,
            modifier = Modifier
                .sizeIn(
                    minWidth = FirstAidDimens.MinTouch,
                    minHeight = FirstAidDimens.MinTouch,
                )
                .semantics {
                    contentDescription = "关闭急救交接报告"
                    role = Role.Button
                },
            colors = ButtonDefaults.textButtonColors(
                contentColor = FirstAidColors.TextSecondary,
            ),
        ) {
            Text(
                text = "关闭",
                style = FirstAidType.Label,
                color = FirstAidColors.TextSecondary,
            )
        }
    }
}

@Composable
private fun MetricsCard(model: HandoverReportUiModel) {
    HandoverCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
            verticalAlignment = Alignment.Top,
        ) {
            MetricItem(
                value = model.totalCompressions?.toString() ?: "—",
                label = "累计按压",
                accessibilityLabel = "累计按压：${model.totalCompressions?.let { "$it 次" } ?: "暂无数据"}",
                modifier = Modifier.weight(1f),
            )
            MetricItem(
                value = model.averageRate?.toString() ?: "—",
                label = "平均频率\n次/分",
                accessibilityLabel = "平均频率：${model.averageRate?.let { "$it 次每分钟" } ?: "暂无数据"}",
                modifier = Modifier.weight(1f),
            )
            MetricItem(
                value = model.averageQuality?.toString() ?: "—",
                label = "平均质量分\n/100",
                accessibilityLabel = "质量分：${model.averageQuality?.let { "$it 分，满分100" } ?: "暂无数据"}",
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun MetricItem(
    value: String,
    label: String,
    accessibilityLabel: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.clearAndSetSemantics {
            contentDescription = accessibilityLabel
        },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(FirstAidDimens.TightGap),
    ) {
        Text(
            text = value,
            style = FirstAidType.Metric,
            color = FirstAidColors.TextPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = label,
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun OverviewCard(model: HandoverReportUiModel) {
    HandoverCard {
        Column(verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap)) {
            Text(
                text = "现场概况",
                modifier = Modifier.semantics { heading() },
                style = FirstAidType.Title,
                color = FirstAidColors.TextPrimary,
            )
            OverviewRow(label = "开始时间", value = model.startedAtText)
            OverviewRow(label = "持续时长", value = model.durationText)
            OverviewRow(label = "症状判断", value = model.symptomSummary)
            OverviewRow(label = "AED 状态", value = model.aedStatus)
            OverviewRow(label = "视频记录", value = if (model.videoSaved) "已保存" else "未保存")
        }
    }
}

@Composable
private fun OverviewRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "$label：$value"
            },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = FirstAidType.Body,
            color = FirstAidColors.TextSecondary,
            modifier = Modifier.width(FirstAidDimens.PrimaryControlHeight),
        )
        Text(
            text = value,
            style = FirstAidType.Body,
            color = FirstAidColors.TextSecondary,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun TimelineCard(events: List<HandoverEvent>) {
    HandoverCard {
        Column(verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap)) {
            Text(
                text = "干预时间线",
                modifier = Modifier.semantics { heading() },
                style = FirstAidType.Title,
                color = FirstAidColors.TextPrimary,
            )

            if (events.isEmpty()) {
                Text(
                    text = "暂无记录",
                    style = FirstAidType.Body,
                    color = FirstAidColors.TextSecondary,
                )
            } else {
                events.forEach { event ->
                    TimelineRow(event = event)
                }
            }
        }
    }
}

@Composable
private fun TimelineRow(event: HandoverEvent) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "${event.timeText}，${event.text}"
            },
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = event.timeText,
            style = FirstAidType.Label,
            color = FirstAidColors.TextTertiary,
            modifier = Modifier.width(FirstAidDimens.PrimaryControlHeight),
        )
        Text(
            text = event.text,
            style = FirstAidType.Body,
            color = FirstAidColors.TextPrimary,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ReportTextCard(reportText: String) {
    HandoverCard {
        Column(verticalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap)) {
            Text(
                text = "交接全文",
                modifier = Modifier.semantics { heading() },
                style = FirstAidType.Title,
                color = FirstAidColors.TextPrimary,
            )
            Text(
                text = reportText,
                style = FirstAidType.Body,
                color = FirstAidColors.TextSecondary,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun BottomActions(onSave: () -> Unit, onShare: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(FirstAidDimens.ItemGap),
    ) {
        HandoverActionButton(
            label = "保存到本地",
            onClick = onSave,
            emphasized = false,
            accessibilityLabel = "保存急救交接报告到本地",
            modifier = Modifier.weight(1f),
        )
        HandoverActionButton(
            label = "分享给医护",
            onClick = onShare,
            emphasized = true,
            accessibilityLabel = "分享急救交接报告给医护",
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun HandoverActionButton(
    label: String,
    onClick: () -> Unit,
    emphasized: Boolean,
    accessibilityLabel: String,
    modifier: Modifier = Modifier,
) {
    val containerColor = if (emphasized) FirstAidColors.Progress else FirstAidColors.SurfaceVariant
    val contentColor = if (emphasized) FirstAidColors.OnAccent else FirstAidColors.TextPrimary

    Button(
        onClick = onClick,
        modifier = modifier
            .sizeIn(minHeight = FirstAidDimens.MinTouch)
            .height(FirstAidDimens.PrimaryControlHeight)
            .semantics {
                contentDescription = accessibilityLabel
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
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun HandoverCard(content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(FirstAidDimens.CardRadius),
        colors = CardDefaults.cardColors(
            containerColor = FirstAidColors.Surface,
            contentColor = FirstAidColors.TextPrimary,
        ),
    ) {
        Column(
            modifier = Modifier.padding(FirstAidDimens.SectionGap),
        ) {
            content()
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun HandoverReportScreenPreview() {
    FirstAidTheme {
        HandoverReportScreen(
            model = HandoverReportUiModel(
                startedAtText = "2026-06-06 02:18",
                durationText = "08 分 42 秒",
                totalCompressions = 864,
                averageRate = 112,
                averageQuality = 86,
                symptomSummary = "患者匿名；意识丧失、无正常呼吸，疑似心脏骤停。",
                events = listOf(
                    HandoverEvent("00:00", "完成现场安全确认，初判患者无反应。"),
                    HandoverEvent("00:32", "开始 CPR，按压节奏稳定在 110 次/分左右。"),
                    HandoverEvent("03:10", "出现呕吐风险，已提示侧头清理并恢复按压。"),
                    HandoverEvent("05:40", "施救者换手，按压中断约 6 秒。"),
                    HandoverEvent("07:55", "疑似出现自主呼吸，继续观察并准备交接。"),
                ),
                aedStatus = "AED 已到场，完成贴片提示；未建议电击。",
                videoSaved = true,
                reportText = "患者匿名。初判时间 2026-06-06 02:18，表现为意识丧失、无正常呼吸，疑似心脏骤停。CPR 开始后累计按压 864 次，持续 08 分 42 秒，平均频率 112 次/分，质量评分 86/100。期间完成呕吐处理、换手提醒，并观察到疑似自主呼吸。AED 已到场并完成贴片提示，未建议电击。施救者可继续配合医护复述现场经过，视频记录已本地保存。",
            ),
            onShare = {},
            onSave = {},
            onClose = {},
        )
    }
}
