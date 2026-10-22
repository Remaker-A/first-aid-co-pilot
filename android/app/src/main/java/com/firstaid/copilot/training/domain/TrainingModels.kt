package com.firstaid.copilot.training.domain

/**
 * Practice Copilot domain contract.
 *
 * This contract is intentionally separate from the emergency SessionState and
 * GuidanceAction contracts. Training observations can be evaluated and retried,
 * but they can never produce emergency tools or mutate the live CPR state machine.
 */
enum class TrainingInputSource {
    TOUCH,
    VOICE,
    VISION,
}

enum class TrainingStep {
    SCENE_SAFETY,
    CHECK_RESPONSE,
    CHECK_BREATHING,
    CALL_FOR_HELP,
    PREPARE_CPR,
    COMPLETE,
}

enum class TrainingAction {
    CHECK_SCENE_SAFETY,
    APPROACH_IMMEDIATELY,
    CHECK_PATIENT_RESPONSE,
    GIVE_WATER,
    CHECK_NORMAL_BREATHING,
    WAIT_FOR_PATIENT_TO_WAKE,
    CALL_EMERGENCY_SERVICES,
    RECORD_VIDEO,
    POSITION_FOR_CPR,
    START_CHEST_COMPRESSIONS,
}

enum class TrainingEvaluationResult {
    CORRECT,
    INCOMPLETE,
    UNSAFE,
    OUT_OF_SEQUENCE,
}

data class TrainingObservation(
    val action: TrainingAction,
    val source: TrainingInputSource,
    val confidence: Float = 1f,
)

data class TrainingEvaluation(
    val result: TrainingEvaluationResult,
    val ruleId: String,
    val title: String,
    val explanation: String,
    val advancesScenario: Boolean,
)

data class TrainingSessionState(
    val scenarioId: String = ADULT_COLLAPSE_CPR_SCENARIO_ID,
    val currentStep: TrainingStep = TrainingStep.SCENE_SAFETY,
    val completedSteps: List<TrainingStep> = emptyList(),
    val attempts: Int = 0,
    val correctActions: Int = 0,
    val lastEvaluation: TrainingEvaluation? = null,
) {
    val isComplete: Boolean get() = currentStep == TrainingStep.COMPLETE

    val progress: Float
        get() = completedSteps.size.toFloat() / TRAINING_STEP_COUNT.toFloat()
}

const val ADULT_COLLAPSE_CPR_SCENARIO_ID = "adult_collapse_cpr_v1"
const val TRAINING_STEP_COUNT = 5
