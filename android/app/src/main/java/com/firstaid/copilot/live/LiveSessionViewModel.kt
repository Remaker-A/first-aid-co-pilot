package com.firstaid.copilot.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.firstaid.copilot.execution.GuidanceActionDispatcher
import kotlinx.coroutines.launch

class LiveSessionViewModel : ViewModel() {
    private val client = VoiceServiceClient()
    private val dispatcher = GuidanceActionDispatcher()

    var uiState by mutableStateOf(LiveUiState(selectedPreset = MockVisionPreset.none))
        private set

    init {
        checkHealth()
    }

    fun setEndpoint(endpoint: String) {
        client.setEndpoint(endpoint)
        uiState = uiState.copy(endpoint = client.endpoint, serverState = ServerState.CHECKING)
        checkHealth()
    }

    fun setDemoDrawerOpen(open: Boolean) {
        uiState = uiState.copy(demoDrawerOpen = open)
    }

    fun setMockCameraEnabled(enabled: Boolean) {
        uiState = uiState.copy(mockCameraEnabled = enabled)
    }

    fun selectPreset(preset: MockVisionPreset) {
        uiState = uiState.copy(selectedPreset = preset)
    }

    fun submitTextTurn(text: String) {
        sendTurn(text = text, preset = uiState.selectedPreset)
    }

    fun injectSelectedPreset() {
        sendTurn(text = "", preset = uiState.selectedPreset)
    }

    fun injectPresetById(presetId: String) {
        val preset = MockVisionPresets.byId(presetId)
        uiState = uiState.copy(selectedPreset = preset)
        sendTurn(text = "", preset = preset)
    }

    fun runCprSetup() {
        if (uiState.busy) return
        viewModelScope.launch {
            uiState = uiState.copy(busy = true, errorMessage = null)
            try {
                for (preset in MockVisionPresets.cprSetupSequence) {
                    val response = client.turn(
                        sessionId = uiState.sessionId,
                        text = preset.setupText,
                        audio = null,
                        presetPayload = preset.payload,
                    )
                    applyResponse(response)
                }
            } catch (error: Throwable) {
                uiState = uiState.copy(
                    serverState = ServerState.ERROR,
                    errorMessage = error.message ?: "CPR setup failed",
                )
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    fun resetSession() {
        if (uiState.busy) return
        viewModelScope.launch {
            uiState = uiState.copy(busy = true, errorMessage = null)
            runCatching { client.reset(uiState.sessionId) }
            uiState = LiveUiState(
                sessionId = uiState.sessionId,
                endpoint = client.endpoint,
                serverState = ServerState.ONLINE,
                selectedPreset = uiState.selectedPreset,
                mockCameraEnabled = uiState.mockCameraEnabled,
            )
            checkHealth()
        }
    }

    fun startAudioTurn(recorder: AndroidAudioTurnRecorder) {
        if (uiState.busy || uiState.micRecording) return
        try {
            recorder.start()
            uiState = uiState.copy(micRecording = true, errorMessage = null)
        } catch (error: Throwable) {
            uiState = uiState.copy(
                micRecording = false,
                errorMessage = error.message ?: "Could not start microphone",
            )
        }
    }

    fun stopAudioTurn(recorder: AndroidAudioTurnRecorder) {
        if (!uiState.micRecording) return
        viewModelScope.launch {
            try {
                val audio = recorder.stop()
                uiState = uiState.copy(micRecording = false)
                sendTurn(text = "", audio = audio, preset = uiState.selectedPreset)
            } catch (error: Throwable) {
                recorder.release()
                uiState = uiState.copy(
                    micRecording = false,
                    errorMessage = error.message ?: "Could not submit microphone turn",
                )
            }
        }
    }

    fun setMicPermissionDenied() {
        uiState = uiState.copy(errorMessage = "Microphone permission denied")
    }

    private fun checkHealth() {
        viewModelScope.launch {
            uiState = uiState.copy(serverState = ServerState.CHECKING)
            val online = runCatching { client.health() }.getOrDefault(false)
            if (online) {
                uiState = uiState.copy(serverState = ServerState.ONLINE)
                return@launch
            }

            if (client.endpoint == DEFAULT_VOICE_ENDPOINT) {
                client.setEndpoint(ADB_REVERSE_VOICE_ENDPOINT)
                val reverseOnline = runCatching { client.health() }.getOrDefault(false)
                uiState = uiState.copy(
                    endpoint = client.endpoint,
                    serverState = if (reverseOnline) ServerState.ONLINE else ServerState.OFFLINE,
                    errorMessage = if (reverseOnline) null else uiState.errorMessage,
                )
                return@launch
            }

            uiState = uiState.copy(serverState = ServerState.OFFLINE)
        }
    }

    private fun sendTurn(
        text: String,
        audio: AudioTurn? = null,
        preset: MockVisionPreset,
    ) {
        if (uiState.busy) return
        viewModelScope.launch {
            uiState = uiState.copy(busy = true, errorMessage = null)
            try {
                val response = client.turn(
                    sessionId = uiState.sessionId,
                    text = text.takeIf { it.isNotBlank() },
                    audio = audio,
                    presetPayload = preset.payload,
                )
                applyResponse(response)
            } catch (error: Throwable) {
                uiState = uiState.copy(
                    serverState = ServerState.ERROR,
                    errorMessage = error.message ?: "Voice service request failed",
                )
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    private fun applyResponse(response: VoiceTurnResponse) {
        val mapped = response.toLiveUiState(uiState)
        val action = mapped.latestAction
        val dispatchResult = action?.let { dispatcher.dispatch(it) }
        uiState = mapped.copy(dispatchResult = dispatchResult)
    }

}
