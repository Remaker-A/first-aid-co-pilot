package com.example.cpr_new.ui.component

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.cpr_new.core.contract.GeoSnapshot
import com.example.cpr_new.core.contract.HandoverReport
import com.example.cpr_new.ui.CoachPalette
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HandoverReportSheet(
    report: HandoverReport,
    onDismiss: () -> Unit,
    onSaveLocal: () -> Unit = onDismiss,
    onShare: () -> Unit = onDismiss,
    modifier: Modifier = Modifier,
) {
    val metrics = parseHandoverMetrics(report.highlights)
    val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    Surface(
        color = CoachPalette.Background,
        modifier = modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "急救交接报告",
                    color = CoachPalette.TextPrimary,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Black,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "关闭",
                    color = Color(0xFF93C5FD),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clickable(onClick = onDismiss)
                        .padding(8.dp),
                )
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                StatsRow(
                    compressions = metrics.compressions,
                    avgRate = metrics.avgRate,
                    avgScore = metrics.avgScore,
                )
                InfoCard(title = "现场概况") {
                    InfoLine("开始时间", timeFormat.format(Date(report.generatedAtMs)))
                    InfoLine("持续时长", metrics.durationText)
                    InfoLine("症状判断", report.headline)
                    report.location?.let { InfoLine("定位", formatLocation(it)) }
                    Text(
                        text = report.narrative,
                        color = CoachPalette.TextSecondary,
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                InfoCard(title = "干预时间线") {
                    report.highlights.forEachIndexed { index, item ->
                        TimelineItem(
                            time = "+%02d:%02d".format(index, index * 10),
                            text = item,
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onSaveLocal,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF334155),
                        contentColor = CoachPalette.TextPrimary,
                    ),
                ) {
                    Text("保存到本地", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
                Button(
                    onClick = onShare,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = CoachPalette.ActionStart,
                        contentColor = Color.Black,
                    ),
                ) {
                    Text("分享给医护", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun StatsRow(compressions: String, avgRate: String, avgScore: String) {
    Surface(color = CoachPalette.Panel, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(vertical = 18.dp, horizontal = 12.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            StatCell(value = compressions, label = "累计按压")
            StatCell(value = avgRate, label = "平均频率\n次/分")
            StatCell(value = avgScore, label = "平均质量分\n/100")
        }
    }
}

@Composable
private fun StatCell(value: String, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = CoachPalette.TextPrimary, fontSize = 26.sp, fontWeight = FontWeight.Black)
        Text(label, color = CoachPalette.TextMuted, fontSize = 11.sp, lineHeight = 14.sp)
    }
}

@Composable
private fun InfoCard(title: String, content: @Composable () -> Unit) {
    Surface(color = CoachPalette.Panel, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, color = CoachPalette.TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = CoachPalette.TextMuted, fontSize = 13.sp)
        Text(
            value,
            color = CoachPalette.TextSecondary,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f),
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
        )
    }
}

@Composable
private fun TimelineItem(time: String, text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(time, color = CoachPalette.TextMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Text(text, color = CoachPalette.TextSecondary, fontSize = 14.sp, modifier = Modifier.weight(1f))
    }
}

private data class HandoverMetrics(
    val compressions: String = "--",
    val avgRate: String = "--",
    val avgScore: String = "--",
    val durationText: String = "--",
)

private fun parseHandoverMetrics(highlights: List<String>): HandoverMetrics {
    var duration = "--"
    var score = "--"
    var rate = "--"
    highlights.forEach { line ->
        when {
            line.contains("时长") || line.contains("秒") -> duration = line.filter { it.isDigit() }.let {
                if (it.isEmpty()) line else "${it}秒"
            }
            line.contains("质量") -> score = Regex("""\d+""").find(line)?.value ?: "--"
            line.contains("频率") -> rate = Regex("""\d+""").find(line)?.value ?: "--"
        }
    }
    return HandoverMetrics(
        compressions = "--",
        avgRate = rate,
        avgScore = score,
        durationText = duration,
    )
}

private fun formatLocation(geo: GeoSnapshot): String =
    "%.6f, %.6f".format(geo.latitude, geo.longitude)
