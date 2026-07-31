package com.firstaid.copilot.live

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.min

@Composable
fun LiveCprCoachScreen(
    state: LiveUiState,
    onTextTurn: (String) -> Unit,
    onInjectPreset: () -> Unit,
    onSelectPreset: (MockVisionPreset) -> Unit,
    onRunCprSetup: () -> Unit,
    onReset: () -> Unit,
    onEndpointChange: (String) -> Unit,
    onToggleDrawer: (Boolean) -> Unit,
    onToggleMockCamera: (Boolean) -> Unit,
    onMicPressed: () -> Unit,
) {
    var textTurn by rememberSaveable { mutableStateOf("") }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A1114))
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            TopStatusStrip(state)

            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF111A1D))
                    .border(1.dp, Color(0xFF284148), RoundedCornerShape(8.dp))
            ) {
                CameraMockSurface(
                    state = state,
                    modifier = Modifier.fillMaxSize()
                )
                CprMetricsOverlay(
                    metrics = state.cprMetrics,
                    overlay = state.overlay,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(12.dp)
                )
                LiveSubtitleLayer(
                    state = state,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(12.dp)
                )
            }

            FlowProgressRail(state)

            LiveVoiceControls(
                textTurn = textTurn,
                onTextChange = { textTurn = it },
                state = state,
                onSendText = {
                    onTextTurn(textTurn)
                    textTurn = ""
                },
                onMicPressed = onMicPressed,
                onToggleMockCamera = onToggleMockCamera,
                onToggleDrawer = onToggleDrawer,
                onReset = onReset,
            )
        }

        AnimatedVisibility(
            visible = state.demoDrawerOpen,
            modifier = Modifier.align(Alignment.CenterEnd)
        ) {
            DemoInjectionDrawer(
                state = state,
                onClose = { onToggleDrawer(false) },
                onEndpointChange = onEndpointChange,
                onSelectPreset = onSelectPreset,
                onInjectPreset = onInjectPreset,
                onRunCprSetup = onRunCprSetup,
            )
        }
    }
}

@Composable
private fun TopStatusStrip(state: LiveUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xD9142327))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stageLabel(state.currentStage),
            color = Color.White,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        StatusChip("120", state.emergencyCallStarted, Color(0xFFE84C3D))
        StatusChip("REC", state.recording, Color(0xFFE84C3D))
        StatusChip("GPS", state.gpsAttached, Color(0xFF58C9A5))
        ServerChip(state)
    }
}

@Composable
private fun StatusChip(label: String, active: Boolean, activeColor: Color) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (active) activeColor.copy(alpha = 0.22f) else Color(0xFF213035))
            .padding(horizontal = 7.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (active) activeColor else Color(0xFF6D7B80))
        )
        Text(label, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ServerChip(state: LiveUiState) {
    val online = state.serverState == ServerState.ONLINE && !state.offlineMode
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (online) Color(0xFF174435) else Color(0xFF3A2B24))
            .padding(horizontal = 7.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (online) Icons.Filled.Wifi else Icons.Filled.WifiOff,
            contentDescription = null,
            tint = if (online) Color(0xFF62D6A3) else Color(0xFFFFB16D),
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = if (state.offlineMode) "offline" else state.serverState.name.lowercase(),
            color = Color.White,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun CameraMockSurface(state: LiveUiState, modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "cpr-pulse")
    val pulse by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 545),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pulse",
    )
    val slowPulse by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1300),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "slow-pulse",
    )

    Box(modifier = modifier) {
        CprPoseAnimation(
            state = state,
            pulse = pulse,
            slowPulse = slowPulse,
            modifier = Modifier.fillMaxSize()
        )
        if (!state.mockCameraEnabled) {
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xD90B1012))
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            ) {
                Text("Mock camera paused", color = Color.White, fontSize = 14.sp)
            }
        }
    }
}

@Composable
fun CprPoseAnimation(
    state: LiveUiState,
    pulse: Float,
    slowPulse: Float,
    modifier: Modifier = Modifier,
) {
    val metrics = state.cprMetrics
    val overlay = state.overlay

    Canvas(modifier = modifier) {
        drawRect(
            brush = Brush.verticalGradient(
                colors = listOf(Color(0xFF162327), Color(0xFF0B1114))
            )
        )

        val unit = min(size.width, size.height)
        val center = Offset(size.width * 0.5f, size.height * 0.48f)
        val bodyWidth = unit * 0.36f
        val bodyHeight = unit * 0.58f
        val bodyTop = center.y - bodyHeight * 0.36f
        val chest = Offset(center.x, bodyTop + bodyHeight * 0.42f)
        val alertColor = if (overlay.alert) Color(0xFFFF5C48) else Color(0xFF6FE7B1)
        val targetRadius = unit * (0.07f + pulse * 0.025f)

        drawRoundRect(
            color = Color(0xFF263A40),
            topLeft = Offset(center.x - bodyWidth / 2f, bodyTop),
            size = Size(bodyWidth, bodyHeight),
            cornerRadius = CornerRadius(bodyWidth * 0.45f, bodyWidth * 0.45f),
        )
        drawCircle(
            color = Color(0xFF2F474E),
            radius = unit * 0.09f,
            center = Offset(center.x, bodyTop - unit * 0.08f),
        )
        drawLine(
            color = Color(0xFF39545B),
            start = Offset(center.x - bodyWidth * 0.56f, bodyTop + bodyHeight * 0.18f),
            end = Offset(center.x - bodyWidth * 0.95f, bodyTop + bodyHeight * 0.48f),
            strokeWidth = 10f,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = Color(0xFF39545B),
            start = Offset(center.x + bodyWidth * 0.56f, bodyTop + bodyHeight * 0.18f),
            end = Offset(center.x + bodyWidth * 0.95f, bodyTop + bodyHeight * 0.48f),
            strokeWidth = 10f,
            cap = StrokeCap.Round,
        )

        drawCircle(
            color = alertColor.copy(alpha = 0.10f + slowPulse * 0.10f),
            radius = targetRadius * 1.9f,
            center = chest,
        )
        drawCircle(
            color = alertColor.copy(alpha = 0.24f),
            radius = targetRadius,
            center = chest,
            style = Stroke(width = 5f),
        )
        drawCircle(
            color = alertColor,
            radius = unit * 0.018f,
            center = chest,
        )

        val handOffset = when (metrics.handPosition) {
            "left" -> -unit * 0.09f
            "right" -> unit * 0.09f
            "high" -> -unit * 0.04f
            "low" -> unit * 0.04f
            else -> 0f
        }
        val handCenter = Offset(chest.x + handOffset, chest.y - unit * (0.025f + pulse * 0.03f))
        drawRoundRect(
            color = Color(0xFFE7DDD0),
            topLeft = Offset(handCenter.x - unit * 0.08f, handCenter.y - unit * 0.032f),
            size = Size(unit * 0.16f, unit * 0.064f),
            cornerRadius = CornerRadius(12f, 12f),
        )
        drawRoundRect(
            color = Color(0xFFD4C3AE),
            topLeft = Offset(handCenter.x - unit * 0.06f, handCenter.y - unit * 0.070f),
            size = Size(unit * 0.12f, unit * 0.052f),
            cornerRadius = CornerRadius(10f, 10f),
        )

        if (state.currentStage == "S7_CPR_LOOP" || state.currentStage == "S6_CPR_READY") {
            drawCompressionArrows(chest, unit, pulse, overlay.alert)
        }

        when (overlay.mode) {
            "hand_position_feedback" -> drawCorrectionArrow(chest, unit, overlay.correctionDirection)
            "rate_feedback", "cpr_quality_feedback" -> drawRhythmMarks(chest, unit, pulse, metrics.currentRate)
            "arm_posture_feedback" -> drawArmPostureCue(chest, unit, slowPulse)
            "interruption_alert" -> drawInterruptionAlert(chest, unit, slowPulse)
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawCompressionArrows(
    chest: Offset,
    unit: Float,
    pulse: Float,
    alert: Boolean,
) {
    val color = if (alert) Color(0xFFFF5C48) else Color(0xFF6FE7B1)
    val top = chest.y - unit * (0.22f + pulse * 0.04f)
    val bottom = chest.y - unit * 0.09f
    for (offsetX in listOf(-unit * 0.12f, unit * 0.12f)) {
        drawLine(
            color = color,
            start = Offset(chest.x + offsetX, top),
            end = Offset(chest.x + offsetX, bottom),
            strokeWidth = 6f,
            cap = StrokeCap.Round,
        )
        val arrow = Path().apply {
            moveTo(chest.x + offsetX, bottom + unit * 0.045f)
            lineTo(chest.x + offsetX - unit * 0.035f, bottom - unit * 0.005f)
            lineTo(chest.x + offsetX + unit * 0.035f, bottom - unit * 0.005f)
            close()
        }
        drawPath(arrow, color)
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawCorrectionArrow(
    chest: Offset,
    unit: Float,
    direction: String?,
) {
    val delta = when (direction) {
        "left" -> Offset(-unit * 0.17f, 0f)
        "right" -> Offset(unit * 0.17f, 0f)
        "up" -> Offset(0f, -unit * 0.14f)
        "down" -> Offset(0f, unit * 0.14f)
        else -> Offset.Zero
    }
    if (delta == Offset.Zero) return
    val start = chest - delta * 0.6f
    val end = chest + delta * 0.6f
    drawLine(Color(0xFFFFD166), start, end, strokeWidth = 8f, cap = StrokeCap.Round)
    drawCircle(Color(0xFFFFD166), radius = unit * 0.025f, center = end)
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawRhythmMarks(
    chest: Offset,
    unit: Float,
    pulse: Float,
    rate: Int?,
) {
    val color = if ((rate ?: TARGET_CPR_BPM) < 100) Color(0xFFFFD166) else Color(0xFF6FE7B1)
    val baseY = chest.y + unit * 0.19f
    repeat(5) { index ->
        val height = unit * (0.025f + ((index + pulse) % 2f) * 0.035f)
        val x = chest.x - unit * 0.13f + index * unit * 0.065f
        drawRoundRect(
            color = color.copy(alpha = if (index % 2 == 0) 0.95f else 0.55f),
            topLeft = Offset(x, baseY - height),
            size = Size(unit * 0.025f, height),
            cornerRadius = CornerRadius(8f, 8f),
        )
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawArmPostureCue(
    chest: Offset,
    unit: Float,
    pulse: Float,
) {
    val color = Color(0xFFFFB16D)
    val y = chest.y - unit * 0.24f
    drawLine(
        color = color.copy(alpha = 0.65f + pulse * 0.25f),
        start = Offset(chest.x - unit * 0.22f, y),
        end = Offset(chest.x + unit * 0.22f, y),
        strokeWidth = 7f,
        cap = StrokeCap.Round,
    )
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawInterruptionAlert(
    chest: Offset,
    unit: Float,
    pulse: Float,
) {
    drawCircle(
        color = Color(0xFFFF5C48).copy(alpha = 0.12f + pulse * 0.16f),
        radius = unit * 0.32f,
        center = chest,
    )
    drawLine(
        color = Color(0xFFFF5C48),
        start = Offset(chest.x - unit * 0.16f, chest.y - unit * 0.16f),
        end = Offset(chest.x + unit * 0.16f, chest.y + unit * 0.16f),
        strokeWidth = 8f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = Color(0xFFFF5C48),
        start = Offset(chest.x + unit * 0.16f, chest.y - unit * 0.16f),
        end = Offset(chest.x - unit * 0.16f, chest.y + unit * 0.16f),
        strokeWidth = 8f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun CprMetricsOverlay(
    metrics: CprMetrics,
    overlay: CoachOverlay,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .widthIn(min = 154.dp, max = 190.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xD90B1012))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        MetricHeader(metrics.qualityScore)
        MetricLine("BPM", "${metrics.currentRate ?: "--"} / ${metrics.targetBpm}")
        MetricLine("Hand", handLabel(metrics.handPosition))
        MetricLine("Arms", armLabel(metrics.armPosture))
        MetricLine("Pause", "${metrics.interruptionSeconds}s")
        if (overlay.alert) {
            Text(
                text = "继续按压",
                color = Color(0xFFFF7A66),
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun MetricHeader(score: Int?) {
    val value = score ?: 0
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text("Quality", color = Color(0xFFB8C7CB), fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text("${score ?: "--"}", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xFF26363B))
        ) {
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(value.coerceIn(0, 100) / 100f)
                    .background(if (value >= 75) Color(0xFF6FE7B1) else Color(0xFFFFB16D))
            )
        }
    }
}

@Composable
private fun MetricLine(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Color(0xFF8EA1A7), fontSize = 11.sp, modifier = Modifier.weight(1f))
        Text(value, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun LiveSubtitleLayer(state: LiveUiState, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xCC071012))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (state.transcript.isNotBlank()) {
            Text(
                text = state.transcript,
                color = Color(0xFFD7E6EA),
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = state.assistantText,
            color = Color.White,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (state.errorMessage != null) {
            Text(
                text = state.errorMessage,
                color = Color(0xFFFFB16D),
                fontSize = 13.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun FlowProgressRail(state: LiveUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF101A1D))
            .padding(horizontal = 6.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CPR_FLOW_STAGES.forEachIndexed { index, stage ->
            val active = index == state.stageIndex
            val completed = index < state.stageIndex
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(
                            when {
                                active -> Color(0xFFFFD166)
                                completed -> Color(0xFF6FE7B1)
                                else -> Color(0xFF2B3A3F)
                            }
                        )
                )
                Text(
                    text = stage.label,
                    color = if (active || completed) Color.White else Color(0xFF75868C),
                    fontSize = 10.sp,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
fun LiveVoiceControls(
    textTurn: String,
    onTextChange: (String) -> Unit,
    state: LiveUiState,
    onSendText: () -> Unit,
    onMicPressed: () -> Unit,
    onToggleMockCamera: (Boolean) -> Unit,
    onToggleDrawer: (Boolean) -> Unit,
    onReset: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF101A1D))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = textTurn,
            onValueChange = onTextChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("我按得对吗") },
            enabled = !state.busy && !state.micRecording,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { onToggleMockCamera(!state.mockCameraEnabled) }) {
                Icon(
                    imageVector = if (state.mockCameraEnabled) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                    contentDescription = "Toggle mock camera",
                    tint = Color.White,
                )
            }
            IconButton(onClick = { onToggleDrawer(true) }) {
                Icon(Icons.Filled.Tune, contentDescription = "Open demo menu", tint = Color.White)
            }
            Button(
                onClick = onMicPressed,
                enabled = !state.busy,
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (state.micRecording) Color(0xFFE84C3D) else Color(0xFF1F7A5A)
                ),
                modifier = Modifier.size(64.dp),
            ) {
                Icon(
                    imageVector = if (state.micRecording) Icons.Filled.GraphicEq else Icons.Filled.Mic,
                    contentDescription = "Push to talk",
                    tint = Color.White,
                )
            }
            IconButton(
                onClick = onSendText,
                enabled = textTurn.isNotBlank() && !state.busy,
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send text turn", tint = Color.White)
            }
            IconButton(onClick = onReset, enabled = !state.busy) {
                Icon(Icons.Filled.Close, contentDescription = "Reset session", tint = Color.White)
            }
        }
    }
}

@Composable
fun DemoInjectionDrawer(
    state: LiveUiState,
    onClose: () -> Unit,
    onEndpointChange: (String) -> Unit,
    onSelectPreset: (MockVisionPreset) -> Unit,
    onInjectPreset: () -> Unit,
    onRunCprSetup: () -> Unit,
) {
    var endpointDraft by remember(state.endpoint) { mutableStateOf(state.endpoint) }
    Surface(
        modifier = Modifier
            .fillMaxHeight()
            .width(340.dp),
        color = Color(0xFFECF4F2),
        shadowElevation = 10.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Demo",
                    color = Color(0xFF102023),
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.Close, contentDescription = "Close demo menu")
                }
            }
            OutlinedTextField(
                value = endpointDraft,
                onValueChange = { endpointDraft = it },
                label = { Text("Voice endpoint") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { onEndpointChange(endpointDraft) },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp),
            ) {
                Text("Apply endpoint")
            }
            Button(
                onClick = onRunCprSetup,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.busy,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1F7A5A)),
            ) {
                Icon(Icons.Filled.RadioButtonChecked, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Run CPR setup")
            }
            Button(
                onClick = onInjectPreset,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.busy && state.selectedPreset.id != "none",
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF315B88)),
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Inject selected")
            }
            Text("Mock vision", color = Color(0xFF405157), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            MockVisionPresets.all.forEach { preset ->
                PresetRow(
                    preset = preset,
                    selected = preset.id == state.selectedPreset.id,
                    currentStage = state.currentStage,
                    onClick = { onSelectPreset(preset) },
                )
            }
        }
    }
}

@Composable
private fun PresetRow(
    preset: MockVisionPreset,
    selected: Boolean,
    currentStage: String,
    onClick: () -> Unit,
) {
    val warns = preset.requiresCprLoop && currentStage != "S7_CPR_LOOP"
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) Color(0xFFD6EDE4) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(9.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            text = preset.label,
            color = Color(0xFF132529),
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
        )
        Text(
            text = if (warns) "${preset.summary} · 当前 ${stageLabel(currentStage)}" else preset.summary,
            color = if (warns) Color(0xFF9A5B16) else Color(0xFF53666B),
            fontSize = 12.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun stageLabel(stage: String): String = when (stage) {
    "S0_SCENE_SAFETY", "S1_SCENE_SAFETY" -> "安全确认"
    "S2_CHECK_RESPONSE" -> "检查反应"
    "S3_CHECK_BREATHING" -> "检查呼吸"
    "S4_SUSPECTED_ARREST" -> "疑似心脏骤停"
    "S5_CALL_EMERGENCY" -> "呼叫120"
    "S6_CPR_READY" -> "准备CPR"
    "S7_CPR_LOOP" -> "持续按压"
    "S8_ASSISTANCE" -> "AED/换手"
    "S9_HANDOVER" -> "交接"
    else -> stage.ifBlank { "待机" }
}

private fun handLabel(value: String): String = when (value) {
    "center", "acceptable" -> "center"
    "left" -> "move right"
    "right" -> "move left"
    "high" -> "move down"
    "low" -> "move up"
    else -> "--"
}

private fun armLabel(value: String): String = when (value) {
    "straight", "acceptable" -> "straight"
    "bent", "not_straight" -> "straighten"
    else -> "--"
}
