package com.example.cpr_new.ui.component

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.cpr_new.feature.session.CprSessionState
import com.example.cpr_new.feature.session.MicState
import com.example.cpr_new.ui.AttentionMode
import com.example.cpr_new.ui.CoachLayoutMetrics
import com.example.cpr_new.ui.CoachPalette
import com.example.cpr_new.ui.QualityScoreTone
import com.example.cpr_new.ui.FLOW_STAGE_LABELS
import com.example.cpr_new.ui.agentStageIndex
import com.example.cpr_new.ui.compactSecondaryText
import com.example.cpr_new.ui.connectionChip
import com.example.cpr_new.ui.sourceBadgeLabel
import com.example.cpr_new.ui.normalizeOverlayMode
import com.example.cpr_new.ui.primaryGuidanceText
import com.example.cpr_new.ui.qualityScorePresentation
import com.example.cpr_new.ui.stageStatusLabel
import com.example.cpr_new.ui.toColor
import com.example.cpr_new.ui.voiceControlPresentation

@Composable
fun AgentTopStatusBar(
    state: CprSessionState,
    modifier: Modifier = Modifier,
) {
    val (chipLabel, chipColor) = connectionChip(state.agentConnected, state.liveWsConnected)
    Surface(
        color = CoachPalette.TopBar,
        shape = RoundedCornerShape(20.dp),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = CoachLayoutMetrics.TopBarHeight),
        shadowElevation = 4.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StatusChip(chipLabel, chipColor)
            StatusChip(
                text = sourceBadgeLabel(state.perceptionReady, state.latestPerception != null),
                color = Color(0xFF38BDF8),
            )
            Text(
                text = stageStatusLabel(state.agentStage),
                color = CoachPalette.TextPrimary,
                fontSize = 15.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
            )
        }
    }
}

@Composable
private fun StatusChip(text: String, color: Color) {
    Surface(color = color.copy(alpha = 0.22f), shape = CircleShape) {
        Text(
            text = text,
            color = CoachPalette.TextPrimary,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun AgentFlowRail(agentStage: String?, modifier: Modifier = Modifier) {
    LabeledFlowRail(agentStage = agentStage, modifier = modifier)
}

/** 带中文阶段标签的流程轨（对齐产品稿）。 */
@Composable
fun LabeledFlowRail(agentStage: String?, modifier: Modifier = Modifier) {
    val currentIndex = agentStageIndex(agentStage)
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            (0..9).forEach { index ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(8.dp)
                        .clip(CircleShape)
                        .background(
                            if (index <= currentIndex) CoachPalette.RailActive else CoachPalette.RailInactive,
                        ),
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            FLOW_STAGE_LABELS.forEachIndexed { index, label ->
                val segmentIndex = index + 1
                Text(
                    text = label,
                    color = if (segmentIndex <= currentIndex) CoachPalette.RailActive else CoachPalette.TextHint,
                    fontSize = 10.sp,
                    fontWeight = if (segmentIndex == currentIndex) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                )
            }
        }
    }
}

/** 顶部指令区：流程轨 + 大字（靠上排列，中间留给相机与节拍脉冲）。 */
@Composable
fun CoachInstructionHeader(
    state: CprSessionState,
    instructionSizeSp: Int,
    modifier: Modifier = Modifier,
) {
    val mainText = primaryGuidanceText(
        state.latestGuidance?.messageText.orEmpty(),
        state.agentStage,
    )
    val showQuality = state.agentStage?.startsWith("S7") == true

    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LabeledFlowRail(agentStage = state.agentStage)
        Text(
            text = mainText,
            color = CoachPalette.TextPrimary,
            fontSize = instructionSizeSp.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center,
            lineHeight = (instructionSizeSp + 6).sp,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
        compactSecondaryText(state.secondaryText, state.statusTags)?.let { secondary ->
            Text(
                text = secondary,
                color = CoachPalette.TextSecondary,
                fontSize = 16.sp,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (showQuality) {
            CompactQualityChip(score = state.qualityScore, agentStage = state.agentStage)
        }
    }
}


@Composable
fun CoachPrimaryButton(text: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp),
        shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(containerColor = CoachPalette.ActionStart),
    ) {
        Text(text, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Color.Black)
    }
}

@Composable
fun CompactQualityChip(score: Int, agentStage: String?) {
    val presentation = qualityScorePresentation(score, agentStage) ?: return
    val color = presentation.tone.toColor()
    Surface(color = color.copy(alpha = 0.18f), shape = RoundedCornerShape(999.dp)) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("质量", color = CoachPalette.TextMuted, fontSize = 12.sp)
            Text(presentation.valueText, color = CoachPalette.TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Black)
            if (presentation.labelText.isNotBlank()) {
                Text(presentation.labelText, color = color, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
fun GuidanceCard(
    state: CprSessionState,
    large: Boolean,
    onPrimaryButton: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val mainText = primaryGuidanceText(
        state.latestGuidance?.messageText.orEmpty(),
        state.agentStage,
    )
    Surface(
        color = CoachPalette.Panel,
        shape = RoundedCornerShape(28.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = mainText,
                color = CoachPalette.TextPrimary,
                fontSize = if (large) 32.sp else 26.sp,
                fontWeight = FontWeight.Bold,
                maxLines = if (large) 2 else 2,
                overflow = TextOverflow.Ellipsis,
            )
            compactSecondaryText(state.secondaryText, state.statusTags)?.let { secondary ->
                Text(
                    text = secondary,
                    color = CoachPalette.TextSecondary,
                    fontSize = if (large) 20.sp else 17.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.partialTranscript.isNotBlank()) {
                Text(
                    text = "「${state.partialTranscript}」",
                    color = CoachPalette.TextMuted,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            QualityScoreDial(score = state.qualityScore, agentStage = state.agentStage)
            state.primaryButtonLabel?.takeIf { it.isNotBlank() }?.let { label ->
                Button(
                    onClick = onPrimaryButton,
                    enabled = !state.isAgentInFlight,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = CoachPalette.ActionStart),
                ) {
                    Text(label, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
fun QualityScoreDial(
    score: Int,
    agentStage: String?,
    modifier: Modifier = Modifier,
) {
    val presentation = qualityScorePresentation(score, agentStage) ?: return
    val color = presentation.tone.toColor()

    Surface(
        color = color.copy(alpha = 0.2f),
        shape = RoundedCornerShape(28.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "质量",
                color = CoachPalette.TextSecondary,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = presentation.valueText,
                    color = CoachPalette.TextPrimary,
                    fontSize = if (presentation.tone == QualityScoreTone.Pending) 24.sp else 44.sp,
                    fontWeight = FontWeight.Black,
                    maxLines = 1,
                )
                if (presentation.labelText.isNotBlank()) {
                    Text(
                        text = presentation.labelText,
                        color = color,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Black,
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun CprCoachOverlay(
    mode: String?,
    correctionArrow: String?,
    attentionMode: AttentionMode,
    modifier: Modifier = Modifier,
) {
    val normalizedMode = normalizeOverlayMode(mode)
    val transition = rememberInfiniteTransition(label = "cpr_pulse")
    val pulse by transition.animateFloat(
        initialValue = 0.78f,
        targetValue = 1.22f,
        animationSpec = infiniteRepeatable(tween(545), RepeatMode.Reverse),
        label = "pulse",
    )
    val modeColor = when (normalizedMode) {
        "hand_position_feedback" -> Color(0xFFFBBF24)
        "rate_feedback" -> Color(0xFF38BDF8)
        "arm_posture_feedback" -> Color(0xFFF97316)
        "aed_assistance" -> Color(0xFF22C55E)
        "rescuer_assistance" -> Color(0xFFA78BFA)
        else -> Color(0xFF34D399)
    }

    Canvas(modifier = modifier) {
        val center = Offset(size.width / 2f, size.height * 0.43f)
        val baseRadius = size.minDimension * 0.12f
        drawCircle(modeColor.copy(alpha = 0.18f), radius = baseRadius * pulse, center = center)
        drawCircle(
            modeColor.copy(alpha = 0.28f),
            radius = baseRadius * 0.72f,
            center = center,
            style = Stroke(width = 8f),
        )
        drawCircle(modeColor.copy(alpha = 0.9f), radius = baseRadius * 0.18f, center = center)

        if (normalizedMode == "rate_feedback" ||
            normalizedMode == "continue_compressions" ||
            normalizedMode == "cpr_loop"
        ) {
            drawArc(
                color = modeColor.copy(alpha = 0.9f),
                startAngle = -90f,
                sweepAngle = 270f * pulse.coerceAtMost(1f),
                useCenter = false,
                topLeft = Offset(center.x - baseRadius * 1.25f, center.y - baseRadius * 1.25f),
                size = androidx.compose.ui.geometry.Size(baseRadius * 2.5f, baseRadius * 2.5f),
                style = Stroke(width = 10f, cap = StrokeCap.Round),
            )
        }

        val arrow = correctionArrow ?: when (normalizedMode) {
            "arm_posture_feedback" -> "down"
            else -> null
        }
        if (arrow != null) {
            drawCorrectionArrow(center, arrow, modeColor)
        }

    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawCorrectionArrow(
    center: Offset,
    direction: String,
    color: Color,
) {
    val length = size.minDimension * 0.18f
    val start = when (direction) {
        "left" -> Offset(center.x + length, center.y)
        "right" -> Offset(center.x - length, center.y)
        "up" -> Offset(center.x, center.y + length)
        else -> Offset(center.x, center.y - length)
    }
    val end = center
    drawLine(color, start, end, strokeWidth = 12f, cap = StrokeCap.Round)
    val head = Path().apply {
        when (direction) {
            "left" -> {
                moveTo(end.x - 28f, end.y)
                lineTo(end.x + 18f, end.y - 24f)
                lineTo(end.x + 18f, end.y + 24f)
            }
            "right" -> {
                moveTo(end.x + 28f, end.y)
                lineTo(end.x - 18f, end.y - 24f)
                lineTo(end.x - 18f, end.y + 24f)
            }
            "up" -> {
                moveTo(end.x, end.y - 28f)
                lineTo(end.x - 24f, end.y + 18f)
                lineTo(end.x + 24f, end.y + 18f)
            }
            else -> {
                moveTo(end.x, end.y + 28f)
                lineTo(end.x - 24f, end.y - 18f)
                lineTo(end.x + 24f, end.y - 18f)
            }
        }
        close()
    }
    drawPath(head, color)
}

@Composable
fun LiveVoiceControls(
    state: CprSessionState,
    onStartAudio: () -> Unit,
    onStopAudio: () -> Unit,
    onSubmitText: (String) -> Unit,
    onRequestMicPermission: () -> Unit,
    onDialEmergency: () -> Unit,
    onStop: () -> Unit,
    hasMicPermission: Boolean,
    onInputExpandedChanged: (Boolean) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var text by remember { mutableStateOf("") }
    var inputExpanded by remember { mutableStateOf(false) }
    val voice = voiceControlPresentation(state.micState, state.isActive)
    val primaryColor = when {
        !voice.flowStarted -> CoachPalette.ActionStart
        voice.active -> CoachPalette.ActionStop
        else -> CoachPalette.ActionListen
    }

    fun setExpanded(expanded: Boolean) {
        inputExpanded = expanded
        onInputExpandedChanged(expanded)
    }

    Surface(
        color = CoachPalette.VoiceBar,
        shape = RoundedCornerShape(22.dp),
        modifier = modifier.fillMaxWidth(),
        shadowElevation = 6.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (inputExpanded) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("输入指令", color = CoachPalette.TextHint, fontSize = 14.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, lineHeight = 18.sp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = CoachPalette.TextPrimary,
                        unfocusedTextColor = CoachPalette.TextPrimary,
                        focusedBorderColor = CoachPalette.ActionListen,
                        unfocusedBorderColor = CoachPalette.Outline,
                        cursorColor = CoachPalette.ActionListen,
                        focusedContainerColor = CoachPalette.InputBg,
                        unfocusedContainerColor = CoachPalette.InputBg,
                    ),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        enabled = text.isNotBlank() && !state.isAgentInFlight,
                        onClick = {
                            onSubmitText(text)
                            text = ""
                            setExpanded(false)
                        },
                        modifier = Modifier
                            .weight(1f)
                            .height(40.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = CoachPalette.ActionListen,
                            disabledContainerColor = CoachPalette.InputBg,
                            disabledContentColor = CoachPalette.TextMuted,
                        ),
                    ) {
                        Text("发送", fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                    CoachOutlinedButton(
                        text = "收起",
                        onClick = { setExpanded(false) },
                        modifier = Modifier
                            .weight(1f)
                            .height(40.dp),
                    )
                }
            } else {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Button(
                        enabled = !state.isAgentInFlight || voice.active,
                        onClick = {
                            if (!hasMicPermission) {
                                onRequestMicPermission()
                            } else if (!voice.active) {
                                onStartAudio()
                            } else {
                                onStopAudio()
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = primaryColor),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .weight(1f)
                            .height(CoachLayoutMetrics.BottomDockVoiceRow),
                    ) {
                        Text(voice.label, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    VoiceLevelDot(micState = state.micState, level = state.micLevel)
                    CoachOutlinedButton(
                        text = "输入",
                        onClick = { setExpanded(true) },
                        modifier = Modifier
                            .widthIn(min = 64.dp)
                            .height(CoachLayoutMetrics.BottomDockVoiceRow),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EmergencyBarButton(
                        text = "拨打 120",
                        tint = CoachPalette.ActionEmergency,
                        onClick = onDialEmergency,
                        modifier = Modifier.weight(1f),
                    )
                    EmergencyBarButton(
                        text = "结束急救",
                        tint = CoachPalette.Outline,
                        onClick = onStop,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun EmergencyBarButton(
    text: String,
    tint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(CoachLayoutMetrics.BottomDockEmergencyRow)
            .clip(RoundedCornerShape(12.dp))
            .background(tint.copy(alpha = 0.28f))
            .clickable(onClick = onClick)
            .defaultMinSize(minHeight = 40.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = CoachPalette.TextPrimary,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun CoachOutlinedButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minWidth = 48.dp, minHeight = 40.dp),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, CoachPalette.Outline),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = CoachPalette.TextSecondary,
        ),
    ) {
        Text(text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun VoiceLevelDot(micState: MicState, level: Float) {
    val active = micState == MicState.Listening ||
        micState == MicState.Capturing ||
        micState == MicState.Speaking
    val color = when (micState) {
        MicState.Speaking -> Color(0xFFA78BFA)
        MicState.Off -> CoachPalette.TextHint
        else -> if (active) CoachPalette.RailActive else CoachPalette.RailInactive
    }
    val size = 14.dp + (10.dp * level.coerceIn(0f, 1f))
    Box(
        modifier = Modifier.size(34.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(color),
        )
    }
}

/** 待命页相机占位 + 脉冲动画；宽度随屏自适应，避免小屏纵向挤压。 */
@Composable
fun IdleHeroVisual(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "idle_pulse")
    val pulse by transition.animateFloat(
        initialValue = 0.78f,
        targetValue = 1.22f,
        animationSpec = infiniteRepeatable(tween(545), RepeatMode.Reverse),
        label = "idle_pulse_anim",
    )
    val accent = Color(0xFF34D399)

    Box(
        modifier = modifier
            .fillMaxWidth(0.46f)
            .aspectRatio(11f / 16f)
            .heightIn(max = 220.dp)
            .clip(RoundedCornerShape(120.dp))
            .background(CoachPalette.CameraFrame),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val center = Offset(size.width / 2f, size.height / 2f)
            val baseRadius = size.minDimension * 0.22f
            drawCircle(accent.copy(alpha = 0.12f), radius = baseRadius * pulse, center = center)
            drawCircle(
                accent.copy(alpha = 0.25f),
                radius = baseRadius * 0.72f,
                center = center,
                style = Stroke(width = 6f),
            )
            drawCircle(accent.copy(alpha = 0.85f), radius = baseRadius * 0.14f, center = center)
        }
    }
}

@Composable
fun IdleStartBar(
    onStart: () -> Unit,
    onDialEmergency: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = CoachPalette.VoiceBar,
        shape = RoundedCornerShape(26.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onStart,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = CoachPalette.ActionStart),
            ) {
                Text("开始急救", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
            CoachOutlinedButton(
                text = "立即拨打 120",
                onClick = onDialEmergency,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )
        }
    }
}
