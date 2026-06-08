package com.example.cpr_new.core.di

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

/**
 * 依赖集合 —— 把会话编排所需的全部能力打成一个包，注入 ViewModel。
 *
 * 这样做的好处：
 * - ViewModel 不直接 new 任何实现，所有依赖来自外部 -> 易测试、易替换；
 * - 第 2 / 3 部分的真实实现（[agent] / [perceptionSource]）只需在 [ServiceLocator]
 *   里替换 Mock 即可，业务代码零改动。
 */
data class CprDependencies(
    /** 第 3 部分：感知源（Mock 或真实模型）。 */
    val perceptionSource: CprPerceptionSource,
    /** 第 2 部分：决策 Agent（Mock 或真实 Gemma）。 */
    val agent: GuidanceAgent,
    /** 硬件能力。 */
    val tts: TtsController,
    val audioMetronome: AudioMetronomeController,
    val liveAudioPlayer: LiveAudioPlayer,
    val liveAudioCapture: LiveAudioCapture,
    val turnTtsPlayer: TurnTtsPlayer,
    val haptics: HapticController,
    val location: LocationProvider,
    val recorder: AudioRecorderController,
    val dialer: EmergencyDialer,
    /** 动态设备快照，供 Remote Agent 上报 co-pilot。 */
    val deviceState: DeviceStateProvider,
)
