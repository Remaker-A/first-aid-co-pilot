package com.firstaid.copilot.training

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.firstaid.copilot.live.ui.theme.FirstAidTheme
import com.firstaid.copilot.training.ui.TrainingScenarioScreen

/** Independent Practice Copilot entry. It does not initialize the emergency session. */
class TrainingActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            FirstAidTheme {
                val session: TrainingSessionViewModel = viewModel()
                TrainingScenarioScreen(
                    state = session.state,
                    onAction = { action -> session.submit(action) },
                    onRestart = session::restart,
                )
            }
        }
    }
}
