package com.example.cpr_new.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.zIndex
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.cpr_new.core.contract.FrameSink
import com.example.cpr_new.feature.session.CprSessionState
import com.example.cpr_new.hardware.camera.CameraPreview
import com.example.cpr_new.ui.AttentionMode
import com.example.cpr_new.ui.AttentionModeInputs
import com.example.cpr_new.ui.CoachLayoutMetrics
import com.example.cpr_new.ui.CoachPalette
import com.example.cpr_new.ui.coachDockBottomInset
import com.example.cpr_new.ui.compactSecondaryText
import com.example.cpr_new.ui.component.AgentTopStatusBar
import com.example.cpr_new.ui.component.AgentFlowRail
import com.example.cpr_new.ui.component.CoachPrimaryButton
import com.example.cpr_new.ui.component.CprCoachOverlay
import com.example.cpr_new.ui.component.Emergency120Sheet
import com.example.cpr_new.ui.component.GuidanceCard
import com.example.cpr_new.ui.component.HandoverReportSheet
import com.example.cpr_new.ui.component.IdleHeroVisual
import com.example.cpr_new.ui.component.IdleStartBar
import com.example.cpr_new.ui.component.LiveVoiceControls
import com.example.cpr_new.ui.component.QualityScoreDial
import com.example.cpr_new.ui.primaryGuidanceText
import com.example.cpr_new.ui.component.StatusBanner
import com.example.cpr_new.ui.toAttentionMode

/**
 * 急救指导主界面。
 *
 * 进行态层叠结构对齐 first-aid-co-pilot [LiveCprCoachScreen]：
 * 相机 → Canvas 叠层 → 注意力布局 → 顶栏 → 底栏语音控制。
 */
@Composable
fun CprGuidanceScreen(
    state: CprSessionState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onDialEmergency: () -> Unit,
    onDismissIncident: () -> Unit,
    onDismissReport: () -> Unit,
    onDismissEmergency120: () -> Unit = {},
    onPrimaryButton: () -> Unit = {},
    onStartAudio: () -> Unit = {},
    onStopAudio: () -> Unit = {},
    onSubmitText: (String) -> Unit = {},
    onRequestMicPermission: () -> Unit = {},
    onConfirmPendingTool: (Boolean) -> Unit = {},
    onToggleCamera: () -> Unit = {},
    hasMicPermission: Boolean = false,
    modifier: Modifier = Modifier,
    cameraGranted: Boolean = false,
    frameSink: FrameSink? = null,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(CoachPalette.Background),
    ) {
        if (!state.isActive) {
            IdleContent(state = state, onStart = onStart, onDialEmergency = onDialEmergency)
        } else {
            ActiveContent(
                state = state,
                onStop = onStop,
                onDialEmergency = onDialEmergency,
                onPrimaryButton = onPrimaryButton,
                onStartAudio = onStartAudio,
                onStopAudio = onStopAudio,
                onSubmitText = onSubmitText,
                onRequestMicPermission = onRequestMicPermission,
                onToggleCamera = onToggleCamera,
                hasMicPermission = hasMicPermission,
                cameraGranted = cameraGranted,
                frameSink = frameSink,
            )
        }

        if (state.isActive && state.incidentBanner != null) {
            StatusBanner(
                incident = state.incidentBanner,
                onDismissIncident = onDismissIncident,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 64.dp, start = 16.dp, end = 16.dp)
                    .zIndex(12f),
            )
        }

        state.handoverReport?.let { report ->
            HandoverReportSheet(
                report = report,
                onDismiss = onDismissReport,
                onSaveLocal = onDismissReport,
                onShare = onDismissReport,
                modifier = Modifier.zIndex(20f),
            )
        }

        if (state.showEmergency120Sheet) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(18f),
                contentAlignment = Alignment.Center,
            ) {
                Emergency120Sheet(
                    location = state.latestGeo,
                    onDismiss = onDismissEmergency120,
                )
            }
        }

        if (state.pendingConfirmTool != null) {
            PendingConfirmDialog(
                message = state.pendingConfirmMessage.orEmpty(),
                onConfirm = { onConfirmPendingTool(true) },
                onDismiss = { onConfirmPendingTool(false) },
            )
        }
    }
}

/** 待命态：上方可滚动内容区 + 底部固定操作栏，避免小屏挤压。 */
@Composable
private fun IdleContent(
    state: CprSessionState,
    onStart: () -> Unit,
    onDialEmergency: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 20.dp),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Spacer(Modifier.height(16.dp))

            Box(
                modifier = Modifier
                    .border(2.dp, CoachPalette.CameraBorder, RoundedCornerShape(120.dp))
                    .clip(RoundedCornerShape(120.dp)),
            ) {
                IdleHeroVisual()
            }

            Spacer(Modifier.height(20.dp))

            Text(
                text = "FirstAid Copilot",
                color = CoachPalette.TextPrimary,
                fontSize = 26.sp,
                fontWeight = FontWeight.Black,
            )
            Text(
                text = "对准胸部，语音或按钮即可获得实时 CPR 指导",
                color = CoachPalette.TextSecondary,
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                lineHeight = 20.sp,
                modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp),
            )

            Spacer(Modifier.height(16.dp))
            IdleStepsCard()

            if (state.handoverReport != null) {
                Text(
                    text = "上次急救报告已生成",
                    color = CoachPalette.TextMuted,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }

            Spacer(Modifier.height(16.dp))
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp, bottom = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "开始后将请求相机、麦克风与定位权限",
                color = CoachPalette.TextHint,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            IdleStartBar(onStart = onStart, onDialEmergency = onDialEmergency)
        }
    }
}

@Composable
private fun IdleStepsCard() {
    Surface(
        color = CoachPalette.Panel,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IdleStep("1", "确认环境安全，轻拍呼叫患者")
            IdleStep("2", "无反应无呼吸 → 立即拨打 120")
            IdleStep("3", "跟随节拍，用力快速按压胸部")
        }
    }
}

@Composable
private fun IdleStep(index: String, text: String) {
    Text(
        text = "$index  $text",
        color = CoachPalette.TextSecondary,
        fontSize = 13.sp,
        lineHeight = 18.sp,
    )
}

/** 进行态：严格对齐 LiveCprCoachScreen 的 Box 层叠。 */
@Composable
private fun ActiveContent(
    state: CprSessionState,
    onStop: () -> Unit,
    onDialEmergency: () -> Unit,
    onPrimaryButton: () -> Unit,
    onStartAudio: () -> Unit,
    onStopAudio: () -> Unit,
    onSubmitText: (String) -> Unit,
    onRequestMicPermission: () -> Unit,
    onToggleCamera: () -> Unit,
    hasMicPermission: Boolean,
    cameraGranted: Boolean,
    frameSink: FrameSink?,
) {
    val attentionMode = AttentionModeInputs(
        agentStage = state.agentStage,
        visualOverlayMode = state.visualOverlayMode,
    ).toAttentionMode()
    var inputExpanded by remember { mutableStateOf(false) }
    val horizontalPad = CoachLayoutMetrics.ScreenHorizontal
    val lensFacing = if (state.useFrontCamera) androidx.camera.core.CameraSelector.LENS_FACING_FRONT else androidx.camera.core.CameraSelector.LENS_FACING_BACK

    Box(modifier = Modifier.fillMaxSize()) {
        CameraPreview(
            enabled = cameraGranted,
            sessionId = state.sessionId,
            frameSink = frameSink,
            lensFacing = lensFacing,
            modifier = Modifier.fillMaxSize(),
        )

        CprCoachOverlay(
            mode = state.visualOverlayMode,
            correctionArrow = state.correctionArrow,
            attentionMode = attentionMode,
            modifier = Modifier.fillMaxSize(),
        )

        when (attentionMode) {
            AttentionMode.Coach -> CoachStageLayout(
                state = state,
                onPrimaryButton = onPrimaryButton,
                modifier = Modifier.zIndex(2f),
            )
            AttentionMode.EyesOff -> EyesOffStageLayout(
                state = state,
                inputExpanded = inputExpanded,
                onPrimaryButton = onPrimaryButton,
                modifier = Modifier.zIndex(2f),
            )
            AttentionMode.Glanceable -> GlanceableStageLayout(
                state = state,
                onPrimaryButton = onPrimaryButton,
                modifier = Modifier.zIndex(2f),
            )
        }

        AgentTopStatusBar(
            state = state,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .zIndex(10f),
        )

        // 摄像头翻转按钮
        if (cameraGranted) {
            CameraFlipButton(
                isFront = state.useFrontCamera,
                onClick = onToggleCamera,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(top = 64.dp, end = 16.dp)
                    .zIndex(11f),
            )
        }

        LiveVoiceControls(
            state = state,
            onStartAudio = onStartAudio,
            onStopAudio = onStopAudio,
            onSubmitText = onSubmitText,
            onRequestMicPermission = onRequestMicPermission,
            onDialEmergency = onDialEmergency,
            onStop = onStop,
            hasMicPermission = hasMicPermission,
            onInputExpandedChanged = { inputExpanded = it },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .zIndex(12f),
        )
    }
}

@Composable
private fun CoachStageLayout(
    state: CprSessionState,
    onPrimaryButton: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 24.dp, vertical = 92.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        FlowRailCard(state.agentStage)
        GuidanceCard(
            state = state,
            large = false,
            onPrimaryButton = onPrimaryButton,
        )
    }
}

@Composable
private fun EyesOffStageLayout(
    state: CprSessionState,
    inputExpanded: Boolean,
    onPrimaryButton: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(
                start = 20.dp,
                end = 20.dp,
                top = 16.dp,
                bottom = coachDockBottomInset(inputExpanded) + 14.dp,
            ),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = primaryGuidanceText(
                state.latestGuidance?.messageText.orEmpty(),
                state.agentStage,
            ),
            color = CoachPalette.TextPrimary,
            fontSize = 46.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center,
            lineHeight = 52.sp,
            maxLines = 2,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        )
        compactSecondaryText(state.secondaryText, state.statusTags)?.let { secondary ->
            Spacer(Modifier.height(16.dp))
            Text(
                text = secondary,
                color = CoachPalette.TextSecondary,
                fontSize = 22.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }
        QualityScoreDial(
            score = state.qualityScore,
            agentStage = state.agentStage,
            modifier = Modifier.padding(top = 22.dp),
        )
        state.primaryButtonLabel?.takeIf { it.isNotBlank() }?.let { label ->
            CoachPrimaryButton(
                text = label,
                enabled = !state.isAgentInFlight,
                onClick = onPrimaryButton,
                modifier = Modifier.padding(top = 18.dp),
            )
        }
    }
}

@Composable
private fun GlanceableStageLayout(
    state: CprSessionState,
    onPrimaryButton: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 22.dp, vertical = 80.dp),
        verticalArrangement = Arrangement.Bottom,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        GuidanceCard(
            state = state,
            large = true,
            onPrimaryButton = onPrimaryButton,
        )
    }
}

@Composable
private fun FlowRailCard(agentStage: String?) {
    Surface(
        color = CoachPalette.Rail,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentFlowRail(agentStage = agentStage)
        }
    }
}

@Composable
private fun PendingConfirmDialog(
    message: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = CoachPalette.CameraFrame,
        titleContentColor = CoachPalette.TextPrimary,
        textContentColor = CoachPalette.TextSecondary,
        title = { Text("需要确认", fontWeight = FontWeight.Black) },
        text = {
            Text(
                text = message.ifBlank { "Agent 请求执行一项需要授权的操作，是否继续？" },
                fontSize = 15.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text("确认", color = Color(0xFF93C5FD), fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = CoachPalette.TextMuted)
            }
        },
    )
}

@Composable
private fun CameraFlipButton(
    isFront: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    androidx.compose.material3.IconButton(
        onClick = onClick,
        modifier = modifier
            .size(48.dp)
            .background(
                color = androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.4f),
                shape = RoundedCornerShape(12.dp),
            ),
    ) {
        androidx.compose.material3.Icon(
            imageVector = androidx.compose.material.icons.Icons.Default.Refresh,
            contentDescription = if (isFront) "切换后置摄像头" else "切换前置摄像头",
            tint = androidx.compose.ui.graphics.Color.White,
        )
    }
}
