package com.example.cpr_new.core.di

import android.content.Context
import com.example.cpr_new.BuildConfig
import com.example.cpr_new.agent.copilot.RemoteGuidanceAgent
import com.example.cpr_new.core.contract.CprPerceptionSource
import com.example.cpr_new.core.contract.GuidanceAgent
import com.example.cpr_new.feature.emergency.EmergencyDialer
import com.example.cpr_new.hardware.audio.AudioMetronomeController
import com.example.cpr_new.hardware.audio.AudioRecorderController
import com.example.cpr_new.hardware.audio.LiveAudioCapture
import com.example.cpr_new.hardware.audio.LiveAudioPlayer
import com.example.cpr_new.hardware.audio.TtsController
import com.example.cpr_new.hardware.audio.TurnTtsPlayer
import com.example.cpr_new.hardware.device.DeviceStateProvider
import com.example.cpr_new.hardware.haptics.HapticController
import com.example.cpr_new.hardware.location.LocationProvider
import com.example.cpr_new.mock.MockCprPerceptionSource
import com.example.cpr_new.mock.MockGuidanceAgent

/**
 * Agent 后端选择：
 * - [MOCK]：离线演示，不依赖 Node 服务
 * - [REMOTE_COPILOT]：连接 first-aid-co-pilot 的 `npm run voice:serve`
 */
enum class AgentBackend {
    MOCK,
    REMOTE_COPILOT,
}

object ServiceLocator {

    /** 切换 Agent 后端。联调 first-aid 时设为 [AgentBackend.REMOTE_COPILOT]。 */
    var agentBackend: AgentBackend = AgentBackend.REMOTE_COPILOT

    var perceptionFactory: (Context) -> CprPerceptionSource = { MockCprPerceptionSource() }

    var agentFactory: (Context, DeviceStateProvider) -> GuidanceAgent = { ctx, deviceState ->
        when (agentBackend) {
            AgentBackend.MOCK -> MockGuidanceAgent()
            AgentBackend.REMOTE_COPILOT -> RemoteGuidanceAgent(ctx, deviceState)
        }
    }

    fun provideDependencies(context: Context): CprDependencies {
        val app = context.applicationContext
        val recorder = AudioRecorderController(app)
        val deviceState = DeviceStateProvider(app, recorder)
        return CprDependencies(
            perceptionSource = perceptionFactory(app),
            agent = agentFactory(app, deviceState),
            tts = TtsController(app),
            audioMetronome = AudioMetronomeController(),
            liveAudioPlayer = LiveAudioPlayer(),
            liveAudioCapture = LiveAudioCapture(),
            turnTtsPlayer = TurnTtsPlayer(BuildConfig.COPILOT_BASE_URL),
            haptics = HapticController(app),
            location = LocationProvider(app),
            recorder = recorder,
            dialer = EmergencyDialer(app),
            deviceState = deviceState,
        )
    }
}
