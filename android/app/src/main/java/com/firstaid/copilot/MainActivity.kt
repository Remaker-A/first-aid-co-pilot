package com.firstaid.copilot

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.firstaid.copilot.live.AndroidAudioTurnRecorder
import com.firstaid.copilot.live.CprMetronomeController
import com.firstaid.copilot.live.LiveCprCoachScreen
import com.firstaid.copilot.live.LiveSessionViewModel
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val pendingDemoCommand = mutableStateOf<DemoCommand?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleDemoIntent(intent)
        setContent {
            MaterialTheme {
                val context = LocalContext.current
                val tts = remember { mutableStateOf<TextToSpeech?>(null) }
                val metronome = remember { CprMetronomeController(context.applicationContext) }
                val recorder = remember { AndroidAudioTurnRecorder(context.applicationContext) }
                val viewModel = androidx.lifecycle.viewmodel.compose.viewModel<LiveSessionViewModel>()
                val recordAudioLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted ->
                    if (!granted) {
                        viewModel.setMicPermissionDenied()
                    }
                }

                DisposableEffect(context) {
                    val engine = TextToSpeech(context.applicationContext) {}
                    tts.value = engine
                    onDispose {
                        engine.stop()
                        engine.shutdown()
                        tts.value = null
                        recorder.release()
                        metronome.stop()
                    }
                }

                val state = viewModel.uiState

                LaunchedEffect(state.latestAction?.action_id) {
                    state.latestAction?.let { action ->
                        val text = action.tts.text.ifBlank { action.ui.main_text }
                        if (text.isNotBlank()) {
                            tts.value?.language = Locale.CHINA
                            tts.value?.speak(text, TextToSpeech.QUEUE_FLUSH, null, action.action_id)
                        }
                        metronome.apply(action)
                    }
                }

                LaunchedEffect(pendingDemoCommand.value) {
                    when (val command = pendingDemoCommand.value) {
                        DemoCommand.RunCprSetup -> viewModel.runCprSetup()
                        is DemoCommand.InjectPreset -> viewModel.injectPresetById(command.presetId)
                        null -> Unit
                    }
                    pendingDemoCommand.value = null
                }

                LiveCprCoachScreen(
                    state = state,
                    onTextTurn = viewModel::submitTextTurn,
                    onInjectPreset = viewModel::injectSelectedPreset,
                    onSelectPreset = viewModel::selectPreset,
                    onRunCprSetup = viewModel::runCprSetup,
                    onReset = viewModel::resetSession,
                    onEndpointChange = viewModel::setEndpoint,
                    onToggleDrawer = viewModel::setDemoDrawerOpen,
                    onToggleMockCamera = viewModel::setMockCameraEnabled,
                    onMicPressed = {
                        val granted = ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                        if (!granted) {
                            recordAudioLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        } else if (state.micRecording) {
                            viewModel.stopAudioTurn(recorder)
                        } else {
                            viewModel.startAudioTurn(recorder)
                        }
                    }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDemoIntent(intent)
    }

    private fun handleDemoIntent(intent: Intent?) {
        pendingDemoCommand.value = when (intent?.action) {
            ACTION_RUN_CPR_SETUP -> DemoCommand.RunCprSetup
            ACTION_INJECT_MOCK -> {
                val presetId = intent.getStringExtra(EXTRA_PRESET_ID).orEmpty()
                DemoCommand.InjectPreset(presetId)
            }
            else -> pendingDemoCommand.value
        }
    }

    private sealed interface DemoCommand {
        data object RunCprSetup : DemoCommand
        data class InjectPreset(val presetId: String) : DemoCommand
    }

    companion object {
        const val ACTION_RUN_CPR_SETUP = "com.firstaid.copilot.action.RUN_CPR_SETUP"
        const val ACTION_INJECT_MOCK = "com.firstaid.copilot.action.INJECT_MOCK"
        const val EXTRA_PRESET_ID = "preset_id"
    }
}
