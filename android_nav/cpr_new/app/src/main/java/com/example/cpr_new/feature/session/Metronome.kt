package com.example.cpr_new.feature.session

import com.example.cpr_new.core.contract.PerceptionEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 节拍器 —— 急救交互核心组件。
 *
 * 职责：按目标频率（次 / 分钟）稳定发出节拍，驱动 UI 闪烁与触觉反馈，
 * 帮助施救者把按压频率控制在 100~120 次 / 分的标准区间。
 *
 * 设计要点：
 * - 用协程 + delay 实现，挂在传入的 [scope] 上，随会话生命周期自动取消；
 * - [ticks] 是节拍事件流（每拍发一次），UI / 触觉各自订阅，互不阻塞；
 * - [bpm] 可运行时调整（Agent 下发 targetRate 时即时变速），无需重启。
 */
class Metronome(private val scope: CoroutineScope) {

    private val _bpm = MutableStateFlow(DEFAULT_BPM)
    val bpm: StateFlow<Int> = _bpm.asStateFlow()

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    // extraBufferCapacity 保证即使没有订阅者也不丢拍、不挂起发射。
    private val _ticks = MutableSharedFlow<Long>(extraBufferCapacity = 4)
    val ticks: SharedFlow<Long> = _ticks.asSharedFlow()

    private var job: Job? = null

    /** 设置目标频率，自动夹到标准区间，运行中可热更新。 */
    fun setBpm(target: Int) {
        _bpm.value = target.coerceIn(
            PerceptionEvent.TARGET_RATE_MIN,
            PerceptionEvent.TARGET_RATE_MAX,
        )
    }

    /** 启动节拍器（幂等）。 */
    fun start() {
        if (job?.isActive == true) return
        _running.value = true
        job = scope.launch {
            var beatIndex = 0L
            while (isActive) {
                _ticks.emit(beatIndex++)
                // 每次循环读取最新 bpm，实现平滑变速。
                delay(beatIntervalMs(_bpm.value))
            }
        }
    }

    /** 停止节拍器。 */
    fun stop() {
        job?.cancel()
        job = null
        _running.value = false
    }

    private fun beatIntervalMs(bpm: Int): Long = (60_000L / bpm.coerceAtLeast(1))

    companion object {
        /** 默认 110 次 / 分，取标准区间中值。 */
        const val DEFAULT_BPM = 110
    }
}
