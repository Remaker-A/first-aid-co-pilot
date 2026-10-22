package com.firstaid.copilot.training.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.firstaid.copilot.live.ui.theme.FirstAidColors
import com.firstaid.copilot.training.domain.TrainingAction
import com.firstaid.copilot.training.domain.TrainingEvaluationResult
import com.firstaid.copilot.training.domain.TrainingSessionState
import com.firstaid.copilot.training.domain.TrainingStep

@Composable
fun TrainingScenarioScreen(
    state: TrainingSessionState,
    onAction: (TrainingAction) -> Unit,
    onRestart: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(FirstAidColors.Background),
        color = FirstAidColors.Background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Practice Copilot",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            Text(
                text = "成人倒地 · 商场场景",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF9FB0C3),
            )

            LinearProgressIndicator(
                progress = { state.progress },
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF35D07F),
                trackColor = Color(0xFF26303A),
            )

            ScenarioCard(state.currentStep)

            state.lastEvaluation?.let { evaluation ->
                val feedbackColor = when (evaluation.result) {
                    TrainingEvaluationResult.CORRECT -> Color(0xFF163C2A)
                    TrainingEvaluationResult.UNSAFE -> Color(0xFF4A1F24)
                    else -> Color(0xFF2C3440)
                }
                Card(
                    colors = CardDefaults.cardColors(containerColor = feedbackColor),
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Column(
                        modifier = Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = evaluation.title,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                        )
                        Text(
                            text = evaluation.explanation,
                            style = MaterialTheme.typography.bodyLarge,
                            color = Color(0xFFE1E7EE),
                        )
                        Text(
                            text = evaluation.ruleId,
                            style = MaterialTheme.typography.labelSmall,
                            color = Color(0xFF9FB0C3),
                        )
                    }
                }
            }

            if (state.isComplete) {
                CompletionCard(state, onRestart)
            } else {
                Text(
                    text = "你现在会怎么做？",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                )
                choicesFor(state.currentStep).forEachIndexed { index, choice ->
                    if (index == 0) {
                        Button(
                            onClick = { onAction(choice.action) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(choice.label)
                        }
                    } else {
                        OutlinedButton(
                            onClick = { onAction(choice.action) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(choice.label)
                        }
                    }
                }
            }

            Text(
                text = "本模式仅用于情境演练，不会拨打电话、定位或进入真实急救会话。",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF8493A5),
            )
        }
    }
}
@Composable
private fun ScenarioCard(step: TrainingStep) {
    val (label, description) = when (step) {
        TrainingStep.SCENE_SAFETY -> "场景开始" to "你在商场看到一名成年人突然倒地。周围有人聚集，现场情况尚未确认。"
        TrainingStep.CHECK_RESPONSE -> "患者没有明显动作" to "你已经确认周围没有持续危险，现在来到患者身边。"
        TrainingStep.CHECK_BREATHING -> "患者没有反应" to "轻拍和呼唤后，患者仍然没有反应。"
        TrainingStep.CALL_FOR_HELP -> "没有正常呼吸" to "患者无反应，也没有正常呼吸。旁边有其他人。"
        TrainingStep.PREPARE_CPR -> "急救电话正在接通" to "旁人正在拨打 120 并寻找 AED，你需要继续行动。"
        TrainingStep.COMPLETE -> "完成关键流程" to "你已经完成从现场判断到开始 CPR 的核心步骤。"
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFF171E26)),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(label, style = MaterialTheme.typography.titleLarge, color = Color.White)
            Text(description, style = MaterialTheme.typography.bodyLarge, color = Color(0xFFD2DAE3))
        }
    }
}

@Composable
private fun CompletionCard(state: TrainingSessionState, onRestart: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFF163C2A)),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("演练完成", style = MaterialTheme.typography.headlineSmall, color = Color.White)
            Text(
                "完成 ${state.correctActions} 个关键步骤，共尝试 ${state.attempts} 次。下一阶段将接入语音理解和 CPR 视觉动作反馈。",
                style = MaterialTheme.typography.bodyLarge,
                color = Color(0xFFE1F4E9),
            )
            Spacer(Modifier.height(4.dp))
            Button(onClick = onRestart, modifier = Modifier.fillMaxWidth()) {
                Text("重新演练")
            }
        }
    }
}

private data class TrainingChoice(val label: String, val action: TrainingAction)

private fun choicesFor(step: TrainingStep): List<TrainingChoice> = when (step) {
    TrainingStep.SCENE_SAFETY -> listOf(
        TrainingChoice("先观察并确认现场安全", TrainingAction.CHECK_SCENE_SAFETY),
        TrainingChoice("立即冲过去扶起患者", TrainingAction.APPROACH_IMMEDIATELY),
    )
    TrainingStep.CHECK_RESPONSE -> listOf(
        TrainingChoice("轻拍双肩并大声呼唤", TrainingAction.CHECK_PATIENT_RESPONSE),
        TrainingChoice("先给患者喝水", TrainingAction.GIVE_WATER),
    )
    TrainingStep.CHECK_BREATHING -> listOf(
        TrainingChoice("观察是否有正常呼吸", TrainingAction.CHECK_NORMAL_BREATHING),
        TrainingChoice("再等一会儿看他是否醒来", TrainingAction.WAIT_FOR_PATIENT_TO_WAKE),
    )
    TrainingStep.CALL_FOR_HELP -> listOf(
        TrainingChoice("请人拨打 120 并取 AED", TrainingAction.CALL_EMERGENCY_SERVICES),
        TrainingChoice("先录视频保留现场", TrainingAction.RECORD_VIDEO),
    )
    TrainingStep.PREPARE_CPR -> listOf(
        TrainingChoice("让患者仰卧并准备胸外按压", TrainingAction.POSITION_FOR_CPR),
        TrainingChoice("继续等待急救人员", TrainingAction.WAIT_FOR_PATIENT_TO_WAKE),
    )
    TrainingStep.COMPLETE -> emptyList()
}
