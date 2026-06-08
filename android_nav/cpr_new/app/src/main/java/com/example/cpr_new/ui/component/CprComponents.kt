package com.example.cpr_new.ui.component

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GuidancePriority
import com.example.cpr_new.core.contract.HandPosition
import com.example.cpr_new.core.contract.PerceptionEvent
import com.example.cpr_new.ui.EmergencyPalette

/**
 * 急救 UI 可复用组件集合。
 *
 * 全部为无状态（stateless）组件：只接收数据、回调，不持有业务状态，
 * 便于预览、测试与复用。配色统一走 [EmergencyPalette]。
 *
 * 设计目标（贴合“高压、单手按压、余光瞥屏”的急救场景）：
 * - 一眼可读：当前阶段、最关键的一句指令、节拍，三者层级分明。
 * - 语义即结论：红/黄/绿直接表达“危险/调整/达标”，无需阅读数字。
 * - 弱信号弱呈现：识别置信度低时主动降级，避免误导施救者。
 */

/** CPR 标准六阶段顺序，用于步进条计算进度。 */
private val PHASE_ORDER = listOf(
    CprPhase.ASSESS,
    CprPhase.CALL_EMS,
    CprPhase.COMPRESSION,
    CprPhase.RESCUE_BREATH,
    CprPhase.AED,
    CprPhase.HANDOVER,
)

/**
 * 阶段步进条：六段轨道 + “第 N/6 步 · 阶段名”。
 * 让施救者随时知道“现在在流程的哪一步”，建立心理地图、降低慌乱。
 */
@Composable
fun PhaseStepper(phase: CprPhase, modifier: Modifier = Modifier) {
    val currentIndex = PHASE_ORDER.indexOf(phase).coerceAtLeast(0)
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = "第 ${currentIndex + 1}/${PHASE_ORDER.size} 步 · ${phaseShort(phase)}",
            color = EmergencyPalette.OnSurfaceMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            PHASE_ORDER.forEachIndexed { index, _ ->
                val color = when {
                    index < currentIndex -> EmergencyPalette.Good
                    index == currentIndex -> EmergencyPalette.Primary
                    else -> EmergencyPalette.Track
                }
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(color),
                )
            }
        }
    }
}

/** 顶部兜底/告警横幅（断网、权限、识别失败等）。 */
@Composable
fun StatusBanner(
    incident: String?,
    onDismissIncident: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = incident != null,
        modifier = modifier,
        enter = slideInVertically(initialOffsetY = { -it }) + fadeIn(),
        exit = slideOutVertically(targetOffsetY = { -it }) + fadeOut(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // 悬浮在内容之上：用阴影 + 不透明底色，避免下方内容透出来。
                .shadow(10.dp, RoundedCornerShape(14.dp))
                .clip(RoundedCornerShape(14.dp))
                .background(EmergencyPalette.Surface)
                .background(EmergencyPalette.WarnSoft)
                .border(1.dp, EmergencyPalette.Warn, RoundedCornerShape(14.dp))
                .clickable(onClick = onDismissIncident)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "⚠  ${incident.orEmpty()}",
                color = EmergencyPalette.OnSurface,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "关闭",
                color = EmergencyPalette.Warn,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

/**
 * 大字指导卡片 —— 急救主视图核心（动词开头、超大字号）。
 *
 * 按 [priority] 调整视觉强度：CRITICAL 红色边框 + 呼吸高亮，强制夺取注意力；
 * WARNING 琥珀描边；INFO 中性。
 */
@Composable
fun GuidanceCard(
    displayText: String,
    priority: GuidancePriority,
    modifier: Modifier = Modifier,
) {
    val accent = priorityColor(priority)
    val critical = priority == GuidancePriority.CRITICAL

    val transition = rememberInfiniteTransition(label = "guidance")
    val glow by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "glow",
    )
    val borderColor = if (critical) accent.copy(alpha = glow) else EmergencyPalette.Outline
    val borderWidth = if (priority == GuidancePriority.LOW) 1.dp else 2.dp

    Column(
        modifier = modifier
            .fillMaxWidth()
            // 固定最小高度，避免指导文字在 1 行/2 行/有无徽章间切换时卡片高度跳动。
            .heightIn(min = 150.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(EmergencyPalette.Surface)
            .border(borderWidth, borderColor, RoundedCornerShape(22.dp))
            .padding(horizontal = 20.dp, vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (priority != GuidancePriority.LOW) {
            Text(
                text = if (critical) "立即执行" else "请调整",
                color = accent,
                fontSize = 13.sp,
                fontWeight = FontWeight.Black,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        Text(
            text = displayText.ifBlank { "准备就绪" },
            color = EmergencyPalette.OnSurface,
            fontSize = 44.sp,
            lineHeight = 50.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * 节拍器脉冲指示器（按压节奏的“视觉心跳”）。
 *
 * 圆环按 bpm 做呼吸缩放近似逐拍；环色随 [inRange] 在“达标绿/调整蓝”间切换，
 * 让施救者无需读数即可判断快慢是否合适。性能友好：纯动画，不依赖逐拍事件。
 */
@Composable
fun MetronomeIndicator(
    bpm: Int,
    running: Boolean,
    inRange: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val periodMs = (60_000 / bpm.coerceAtLeast(1))
    val transition = rememberInfiniteTransition(label = "metronome")
    val scale by transition.animateFloat(
        initialValue = if (running) 0.72f else 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(periodMs / 2),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse",
    )
    val ringColor by animateColorAsState(
        targetValue = when {
            !running -> EmergencyPalette.Track
            inRange -> EmergencyPalette.Good
            else -> EmergencyPalette.Accent
        },
        label = "ring",
    )

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier,
    ) {
        Box(
            modifier = Modifier.size(150.dp),
            contentAlignment = Alignment.Center,
        ) {
            // 外圈静态轨道环。
            Canvas(modifier = Modifier.size(150.dp)) {
                drawCircle(
                    color = EmergencyPalette.Track,
                    radius = size.minDimension / 2 - 6.dp.toPx(),
                    style = Stroke(width = 4.dp.toPx()),
                )
            }
            // 内核：随拍缩放的实心圆。
            Box(
                modifier = Modifier
                    .size(110.dp)
                    .scale(if (running) scale else 1f)
                    .clip(CircleShape)
                    .background(ringColor.copy(alpha = if (running) 1f else 0.3f)),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "$bpm",
                        color = Color.White,
                        fontSize = 38.sp,
                        fontWeight = FontWeight.Black,
                    )
                    Text(
                        text = "次/分",
                        color = Color.White.copy(alpha = 0.85f),
                        fontSize = 12.sp,
                    )
                }
            }
        }
        Text(
            text = if (running) "跟随节奏用力按压" else "节拍待命",
            color = EmergencyPalette.OnSurfaceMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 10.dp),
        )
    }
}

/**
 * 质量仪表盘：综合分（环形）+ 频率 + 深度 + 手位。
 *
 * 当感知不可靠（置信度低 / 尚未识别）时整体降级为“识别中”，避免展示误导数字。
 */
@Composable
fun QualityDashboard(
    qualityScore: Int,
    perception: PerceptionEvent?,
    rateInRange: Boolean,
    modifier: Modifier = Modifier,
) {
    val reliable = perception?.isReliable() == true

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(EmergencyPalette.Surface)
            .border(1.dp, EmergencyPalette.Outline, RoundedCornerShape(18.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            ScoreRing(score = qualityScore, dimmed = !reliable)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "按压质量",
                    color = EmergencyPalette.OnSurface,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = if (reliable) scoreHint(qualityScore) else "识别中…",
                    color = EmergencyPalette.OnSurfaceMuted,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            MetricTile(
                modifier = Modifier.weight(1f),
                label = "频率",
                value = if (reliable) perception?.compressionRateBpm?.let { "%.0f".format(it) } ?: "--" else "--",
                unit = "次/分",
                color = if (reliable && rateInRange) EmergencyPalette.Good else EmergencyPalette.Warn,
                dimmed = !reliable,
            )
            MetricTile(
                modifier = Modifier.weight(1f),
                label = "手臂",
                value = if (reliable) armLabel(perception?.armStraight) else "--",
                unit = "姿态",
                color = armColor(perception?.armStraight, reliable),
                dimmed = !reliable,
            )
            MetricTile(
                modifier = Modifier.weight(1f),
                label = "手位",
                value = if (reliable) handLabel(perception?.handPosition) else "--",
                unit = "位置",
                color = if (reliable && perception?.handPosition == HandPosition.CENTER)
                    EmergencyPalette.Good else EmergencyPalette.Warn,
                dimmed = !reliable,
            )
        }
    }
}

/** 环形质量分：底环 + 进度弧 + 居中分数。 */
@Composable
private fun ScoreRing(score: Int, dimmed: Boolean, modifier: Modifier = Modifier) {
    val color = if (dimmed) EmergencyPalette.OnSurfaceMuted else scoreColor(score)
    val sweep by animateFloatAsState(
        targetValue = score.coerceIn(0, 100) / 100f,
        animationSpec = tween(600),
        label = "scoreSweep",
    )
    Box(
        modifier = modifier.size(72.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(72.dp)) {
            val stroke = 8.dp.toPx()
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            drawArc(
                color = EmergencyPalette.Track,
                startAngle = -90f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
            drawArc(
                color = color,
                startAngle = -90f,
                sweepAngle = 360f * sweep,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
        Text(
            text = if (dimmed) "--" else "$score",
            color = color,
            fontSize = 22.sp,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
private fun MetricTile(
    label: String,
    value: String,
    unit: String,
    color: Color,
    dimmed: Boolean,
    modifier: Modifier = Modifier,
) {
    val shownColor = if (dimmed) EmergencyPalette.OnSurfaceMuted else color
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(EmergencyPalette.SurfaceVariant)
            .padding(vertical = 12.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, color = EmergencyPalette.OnSurfaceMuted, fontSize = 12.sp)
        Text(
            value,
            color = shownColor,
            fontSize = 24.sp,
            fontWeight = FontWeight.Black,
            modifier = Modifier.padding(vertical = 2.dp),
        )
        Text(unit, color = EmergencyPalette.OnSurfaceMuted, fontSize = 11.sp)
    }
}

private fun priorityColor(priority: GuidancePriority): Color = when (priority) {
    GuidancePriority.CRITICAL -> EmergencyPalette.Danger
    GuidancePriority.HIGH -> EmergencyPalette.Danger
    GuidancePriority.MEDIUM -> EmergencyPalette.Warn
    GuidancePriority.LOW -> EmergencyPalette.Accent
}

private fun scoreColor(score: Int): Color = when {
    score >= 75 -> EmergencyPalette.Good
    score >= 45 -> EmergencyPalette.Warn
    else -> EmergencyPalette.Danger
}

private fun scoreHint(score: Int): String = when {
    score >= 75 -> "动作达标，保持"
    score >= 45 -> "基本可以，注意调整"
    else -> "请加强按压质量"
}

private fun armLabel(straight: Boolean?): String = when (straight) {
    true -> "伸直"
    false -> "未直"
    null -> "--"
}

private fun armColor(straight: Boolean?, reliable: Boolean): Color = when {
    !reliable || straight == null -> EmergencyPalette.OnSurfaceMuted
    straight -> EmergencyPalette.Good
    else -> EmergencyPalette.Warn
}

private fun handLabel(position: HandPosition?): String = when (position) {
    HandPosition.CENTER -> "正确"
    HandPosition.LEFT -> "偏左"
    HandPosition.RIGHT -> "偏右"
    HandPosition.HIGH -> "偏高"
    HandPosition.LOW -> "偏低"
    HandPosition.UNKNOWN, null -> "--"
}

private fun phaseShort(phase: CprPhase): String = when (phase) {
    CprPhase.ASSESS -> "评估意识与呼吸"
    CprPhase.CALL_EMS -> "呼叫急救 120"
    CprPhase.COMPRESSION -> "胸外按压"
    CprPhase.RESCUE_BREATH -> "人工呼吸"
    CprPhase.AED -> "使用 AED"
    CprPhase.HANDOVER -> "交接"
}
