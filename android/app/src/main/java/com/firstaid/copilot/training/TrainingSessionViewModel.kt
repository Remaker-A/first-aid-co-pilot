package com.firstaid.copilot.training

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import com.firstaid.copilot.training.domain.TrainingAction
import com.firstaid.copilot.training.domain.TrainingInputSource
import com.firstaid.copilot.training.domain.TrainingObservation
import com.firstaid.copilot.training.domain.TrainingSessionState
import com.firstaid.copilot.training.engine.TrainingRuleEngine

class TrainingSessionViewModel : ViewModel() {
    var state by mutableStateOf(TrainingSessionState())
        private set

    fun submit(action: TrainingAction, source: TrainingInputSource = TrainingInputSource.TOUCH) {
        state = TrainingRuleEngine.evaluate(
            state,
            TrainingObservation(action = action, source = source),
        )
    }

    fun restart() {
        state = TrainingRuleEngine.restart()
    }
}
