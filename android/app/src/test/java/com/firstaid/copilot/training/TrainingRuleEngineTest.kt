package com.firstaid.copilot.training

import com.firstaid.copilot.training.domain.TrainingAction
import com.firstaid.copilot.training.domain.TrainingEvaluationResult
import com.firstaid.copilot.training.domain.TrainingInputSource
import com.firstaid.copilot.training.domain.TrainingObservation
import com.firstaid.copilot.training.domain.TrainingSessionState
import com.firstaid.copilot.training.domain.TrainingStep
import com.firstaid.copilot.training.engine.TrainingRuleEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrainingRuleEngineTest {

    @Test
    fun `adult collapse scenario completes only through rule-approved sequence`() {
        val actions = listOf(
            TrainingAction.CHECK_SCENE_SAFETY,
            TrainingAction.CHECK_PATIENT_RESPONSE,
            TrainingAction.CHECK_NORMAL_BREATHING,
            TrainingAction.CALL_EMERGENCY_SERVICES,
            TrainingAction.POSITION_FOR_CPR,
        )

        val completed = actions.fold(TrainingSessionState()) { state, action ->
            TrainingRuleEngine.evaluate(state, observation(action))
        }

        assertEquals(TrainingStep.COMPLETE, completed.currentStep)
        assertEquals(5, completed.correctActions)
        assertEquals(5, completed.attempts)
        assertTrue(completed.isComplete)
    }

    @Test
    fun `unsafe action returns feedback without advancing scenario`() {
        val result = TrainingRuleEngine.evaluate(
            TrainingSessionState(),
            observation(TrainingAction.APPROACH_IMMEDIATELY),
        )

        assertEquals(TrainingStep.SCENE_SAFETY, result.currentStep)
        assertEquals(TrainingEvaluationResult.UNSAFE, result.lastEvaluation?.result)
        assertFalse(result.lastEvaluation?.advancesScenario ?: true)
    }

    @Test
    fun `out of sequence action cannot skip medical steps`() {
        val result = TrainingRuleEngine.evaluate(
            TrainingSessionState(),
            observation(TrainingAction.START_CHEST_COMPRESSIONS),
        )

        assertEquals(TrainingStep.SCENE_SAFETY, result.currentStep)
        assertEquals(TrainingEvaluationResult.OUT_OF_SEQUENCE, result.lastEvaluation?.result)
    }

    @Test
    fun `low confidence multimodal observation does not advance`() {
        val result = TrainingRuleEngine.evaluate(
            TrainingSessionState(),
            TrainingObservation(
                action = TrainingAction.CHECK_SCENE_SAFETY,
                source = TrainingInputSource.VOICE,
                confidence = 0.4f,
            ),
        )

        assertEquals(TrainingStep.SCENE_SAFETY, result.currentStep)
        assertEquals(TrainingEvaluationResult.INCOMPLETE, result.lastEvaluation?.result)
    }

    @Test
    fun `restart clears all training state`() {
        val advanced = TrainingRuleEngine.evaluate(
            TrainingSessionState(),
            observation(TrainingAction.CHECK_SCENE_SAFETY),
        )

        assertEquals(TrainingSessionState(), TrainingRuleEngine.restart())
        assertFalse(advanced == TrainingRuleEngine.restart())
    }

    private fun observation(action: TrainingAction) = TrainingObservation(
        action = action,
        source = TrainingInputSource.TOUCH,
    )
}
