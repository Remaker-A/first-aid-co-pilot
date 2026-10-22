package com.firstaid.copilot.training.engine

import com.firstaid.copilot.training.domain.TrainingAction
import com.firstaid.copilot.training.domain.TrainingEvaluation
import com.firstaid.copilot.training.domain.TrainingEvaluationResult
import com.firstaid.copilot.training.domain.TrainingObservation
import com.firstaid.copilot.training.domain.TrainingSessionState
import com.firstaid.copilot.training.domain.TrainingStep

/**
 * Deterministic evaluator for the first Practice Copilot scenario.
 *
 * Medical sequence and correctness live here, never in Gemma-generated text.
 * Future voice/vision adapters may create [TrainingObservation] values, but this
 * engine remains the sole owner of scenario progression and evaluation.
 */
object TrainingRuleEngine {

    fun evaluate(
        state: TrainingSessionState,
        observation: TrainingObservation,
    ): TrainingSessionState {
        if (state.isComplete) return state

        val evaluation = evaluateAction(state.currentStep, observation)
        val nextStep = if (evaluation.advancesScenario) state.currentStep.next() else state.currentStep
        val completed = if (evaluation.advancesScenario) {
            state.completedSteps + state.currentStep
        } else {
            state.completedSteps
        }

        return state.copy(
            currentStep = nextStep,
            completedSteps = completed,
            attempts = state.attempts + 1,
            correctActions = state.correctActions + if (evaluation.advancesScenario) 1 else 0,
            lastEvaluation = evaluation,
        )
    }

    fun restart(): TrainingSessionState = TrainingSessionState()

    private fun evaluateAction(
        step: TrainingStep,
        observation: TrainingObservation,
    ): TrainingEvaluation {
        if (observation.confidence < MIN_ACTION_CONFIDENCE) {
            return feedback(
                TrainingEvaluationResult.INCOMPLETE,
                "TRAIN-CONFIDENCE-001",
                "我还没有确认你的动作",
                "请再清楚地说一次，或使用屏幕按钮完成这一步。",
            )
        }

        val action = observation.action
        return when (step) {
            TrainingStep.SCENE_SAFETY -> when (action) {
                TrainingAction.CHECK_SCENE_SAFETY -> correct(
                    "CPR-SEQ-001",
                    "先确认现场安全",
                    "正确。确认自己、患者和周围人没有持续危险后再靠近。",
                )
                TrainingAction.APPROACH_IMMEDIATELY -> unsafe(
                    "CPR-SAFE-001",
                    "不要立即冲过去",
                    "先观察车辆、电线、火源等危险，保证现场安全。",
                )
                else -> outOfSequence("CPR-SEQ-001", "现在先确认现场是否安全。")
            }

            TrainingStep.CHECK_RESPONSE -> when (action) {
                TrainingAction.CHECK_PATIENT_RESPONSE -> correct(
                    "CPR-SEQ-002",
                    "检查患者反应",
                    "正确。轻拍双肩并大声呼唤，观察是否有反应。",
                )
                TrainingAction.GIVE_WATER -> unsafe(
                    "CPR-SAFE-002",
                    "不要给倒地者喂水",
                    "患者意识不清时喂水可能造成误吸，应先检查反应。",
                )
                else -> outOfSequence("CPR-SEQ-002", "下一步是检查患者有没有反应。")
            }

            TrainingStep.CHECK_BREATHING -> when (action) {
                TrainingAction.CHECK_NORMAL_BREATHING -> correct(
                    "CPR-SEQ-003",
                    "检查正常呼吸",
                    "正确。观察胸廓起伏，判断是否有正常呼吸；濒死喘息不属于正常呼吸。",
                )
                TrainingAction.WAIT_FOR_PATIENT_TO_WAKE -> unsafe(
                    "CPR-SAFE-003",
                    "不要等待",
                    "无反应时应立即检查正常呼吸并继续急救流程。",
                )
                else -> outOfSequence("CPR-SEQ-003", "现在需要检查是否有正常呼吸。")
            }

            TrainingStep.CALL_FOR_HELP -> when (action) {
                TrainingAction.CALL_EMERGENCY_SERVICES -> correct(
                    "CPR-SEQ-004",
                    "立即呼叫急救",
                    "正确。请旁人拨打 120 并取 AED；独自一人时打开免提呼叫。",
                )
                TrainingAction.RECORD_VIDEO -> unsafe(
                    "CPR-SAFE-004",
                    "不要把录制放在急救之前",
                    "当前最重要的是呼叫 120、寻找 AED 并尽快开始 CPR。",
                )
                else -> outOfSequence("CPR-SEQ-004", "现在应呼叫 120 并让人取 AED。")
            }

            TrainingStep.PREPARE_CPR -> when (action) {
                TrainingAction.POSITION_FOR_CPR -> correct(
                    "CPR-SEQ-005",
                    "准备开始胸外按压",
                    "正确。让患者仰卧在坚硬平面，双手掌根放在胸口中央。",
                )
                TrainingAction.START_CHEST_COMPRESSIONS -> correct(
                    "CPR-SEQ-005",
                    "开始胸外按压",
                    "正确。双手掌根放在胸口中央，手臂伸直，按压频率保持每分钟 100 到 120 次。",
                )
                else -> outOfSequence("CPR-SEQ-005", "准备体位和手位，然后开始胸外按压。")
            }

            TrainingStep.COMPLETE -> feedback(
                TrainingEvaluationResult.INCOMPLETE,
                "TRAIN-COMPLETE",
                "本次演练已完成",
                "你可以查看复盘或重新开始。",
            )
        }
    }

    private fun correct(ruleId: String, title: String, explanation: String) = feedback(
        TrainingEvaluationResult.CORRECT,
        ruleId,
        title,
        explanation,
        advances = true,
    )

    private fun unsafe(ruleId: String, title: String, explanation: String) = feedback(
        TrainingEvaluationResult.UNSAFE,
        ruleId,
        title,
        explanation,
    )

    private fun outOfSequence(ruleId: String, explanation: String) = feedback(
        TrainingEvaluationResult.OUT_OF_SEQUENCE,
        ruleId,
        "顺序还不对",
        explanation,
    )

    private fun feedback(
        result: TrainingEvaluationResult,
        ruleId: String,
        title: String,
        explanation: String,
        advances: Boolean = false,
    ) = TrainingEvaluation(result, ruleId, title, explanation, advances)

    private fun TrainingStep.next(): TrainingStep = when (this) {
        TrainingStep.SCENE_SAFETY -> TrainingStep.CHECK_RESPONSE
        TrainingStep.CHECK_RESPONSE -> TrainingStep.CHECK_BREATHING
        TrainingStep.CHECK_BREATHING -> TrainingStep.CALL_FOR_HELP
        TrainingStep.CALL_FOR_HELP -> TrainingStep.PREPARE_CPR
        TrainingStep.PREPARE_CPR -> TrainingStep.COMPLETE
        TrainingStep.COMPLETE -> TrainingStep.COMPLETE
    }

    private const val MIN_ACTION_CONFIDENCE = 0.65f
}
