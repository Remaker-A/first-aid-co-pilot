package com.firstaid.copilot.live

/**
 * Phase D —端侧主动式推理（proactive coaching）的**纯逻辑**核心。
 *
 * 设计红线（沿用整体架构）：
 * - 永不切 stage、不发起工具调用、不做诊断；只在确定性安全话术内做"陪伴式"提示。
 * - 热路径/critical 绝不被打扰：[hardSpeechBlockReason] 会在任何"正在/即将说话、
 *   弹窗、critical 指令"时直接放弃；外加全局冷却与 high/critical 之后的静默窗口。
 * - 话术默认走确定性模板（本文件），Gemma 仅作可选润色（[ProactivePolisher]），
 *   且润色结果必须过 [isProactiveTextSafe] 才会被采用，否则回退模板。
 *
 * 该文件刻意只依赖 [LiveUiState] 与时间戳，[decideProactiveCue] 为纯函数，便于在
 * 无协程/无虚拟时钟的情况下做穷尽单测；[LiveSessionViewModel] 负责驱动 tick、维护
 * 跨 tick 的 [ProactiveCoachState] 并执行可选润色。
 */

/** 一条主动提示的种类，决定模板与语气。 */
enum class ProactiveCueKind { HandSwitch, AedReminder, Reassure }

/**
 * 一条已决策、准备播报/展示的主动提示。[id] 每次发射唯一（含时间戳），UI 侧据此触发
 * 一次独立的低优先 TTS，绝不复用服务端 guidance 的 actionId/ttsText 通道。
 */
data class ProactiveCue(
    val id: String,
    val kind: ProactiveCueKind,
    val text: String,
    val tone: String = "calm_firm",
    val speed: String = "normal",
    val polished: Boolean = false,
)

/**
 * 跨 tick 携带的冷却/节流记忆。全部用可空时间戳表示"从未触发过"，避免在小 nowMs
 * 的单测里被 epoch 0 的冷却误伤。由 [LiveSessionViewModel] 持有并在每次发射后替换。
 */
data class ProactiveCoachState(
    val lastCueAtMs: Long? = null,
    val lastHandSwitchAtMs: Long? = null,
    val handSwitchCount: Int = 0,
    val lastAedReminderAtMs: Long? = null,
    val aedReminderCount: Int = 0,
    val lastReassureAtMs: Long? = null,
    /** 最近一次 high/critical guidance 抵达的时刻，用于"高优 TTS 之后"的静默窗口。 */
    val lastHighPriorityAtMs: Long? = null,
)

/** 一次决策的结果：发射某条提示（并给出新的冷却状态），或带原因跳过。 */
sealed interface ProactiveDecision {
    data class Emit(val cue: ProactiveCue, val state: ProactiveCoachState) : ProactiveDecision
    data class Skip(val reason: String) : ProactiveDecision
}

/**
 * 可选的端侧 Gemma 润色入口（Phase 0 接入 EdgeGemmaAgent 时注入）。默认不注入即纯模板。
 * 返回 null/超时/不安全都会被忽略并回退模板，因此实现可以在 driver 忙时直接返回 null。
 */
fun interface ProactivePolisher {
    suspend fun polish(request: ProactivePolishRequest): String?
}

/** 提供给润色器的上下文。仅只读快照，润色器**不得**改变医疗决策。 */
data class ProactivePolishRequest(
    val kind: ProactiveCueKind,
    val templateText: String,
    val stage: String?,
    val qualityScore: Int?,
    val cprElapsedMs: Long,
    val tone: String,
)

// --- 节律/门控常量（毫秒）。注释给出经验依据，便于后续调参。 ---

/** 主动监控 tick 周期：每 5s 体检一次状态。 */
internal const val PROACTIVE_TICK_MS: Long = 5_000L

/** 任意两条主动提示之间的全局最小间隔，避免"话痨"。 */
internal const val PROACTIVE_GLOBAL_COOLDOWN_MS: Long = 20_000L

/** 收到 high/critical guidance 后的静默窗口（"高优 TTS 期间/刚结束"不插话）。 */
internal const val PROACTIVE_POST_HIGH_PRIORITY_QUIET_MS: Long = 8_000L

/** 换手：首次在按压满约 2 分钟时建议（指南：每 2 分钟轮换）。 */
internal const val HAND_SWITCH_FIRST_MS: Long = 120_000L

/** 换手：后续每约 2 分钟再次提示（略小于 2min 以贴近各 2min 节点）。 */
internal const val HAND_SWITCH_INTERVAL_MS: Long = 110_000L

/** 换手（疲劳早触发）：质量明显下滑且已按压满该时长时提前建议换手。 */
internal const val HAND_SWITCH_FATIGUE_MIN_MS: Long = 90_000L

/** 换手（疲劳早触发）：质量分低于该阈值视作疲劳信号。 */
internal const val HAND_SWITCH_FATIGUE_QUALITY: Int = 55

/** AED：按压满该时长仍无 AED 时，开始提醒就近取 AED。 */
internal const val AED_FIRST_MS: Long = 45_000L

/** AED：两次取 AED 提醒之间的最小间隔。 */
internal const val AED_INTERVAL_MS: Long = 60_000L

/** AED：最多提醒次数，超过则不再唠叨（仍无 AED 也停嘴）。 */
internal const val AED_MAX_REMINDERS: Int = 4

/** 安抚：按压满该时长后才开始阶段性安抚。 */
internal const val REASSURE_FIRST_MS: Long = 30_000L

/** 安抚：两次安抚之间的最小间隔。 */
internal const val REASSURE_INTERVAL_MS: Long = 45_000L

/** 安抚：质量分低于该值则不安抚（交给服务端纠错，避免不诚实地"夸奖"）。 */
internal const val REASSURE_MIN_QUALITY: Int = 50

/** 安抚：质量分不低于该值时才用"你做得很好"的肯定话术。 */
internal const val REASSURE_PRAISE_QUALITY: Int = 85

/** 润色结果允许的最大中文字符数（略宽于推荐 30，硬上限避免长篇）。 */
internal const val PROACTIVE_TEXT_MAX_CHARS: Int = 40

/** 可选 Gemma 润色的等待预算；超时则回退模板，绝不拖慢任何热路径。 */
internal const val PROACTIVE_POLISH_TIMEOUT_MS: Long = 1_500L

/**
 * 纯决策函数：给定当前 [state]、跨 tick 的 [coach] 记忆与 [nowMs]，决定是否发射一条
 * 主动提示。优先级：取 AED > 换手 > 安抚。任何"会打扰热路径/critical"的情形一律 Skip。
 */
internal fun decideProactiveCue(
    state: LiveUiState,
    coach: ProactiveCoachState,
    nowMs: Long,
): ProactiveDecision {
    if (!isProactiveEligibleStage(state.currentStage)) {
        return ProactiveDecision.Skip("stage_ineligible")
    }
    hardSpeechBlockReason(state)?.let { return ProactiveDecision.Skip(it) }

    coach.lastHighPriorityAtMs?.let {
        if (nowMs - it < PROACTIVE_POST_HIGH_PRIORITY_QUIET_MS) {
            return ProactiveDecision.Skip("post_high_priority")
        }
    }
    coach.lastCueAtMs?.let {
        if (nowMs - it < PROACTIVE_GLOBAL_COOLDOWN_MS) {
            return ProactiveDecision.Skip("cooldown")
        }
    }

    val cprElapsedMs = state.cprStartedAtMs?.let { (nowMs - it).coerceAtLeast(0L) } ?: 0L
    val quality = state.qualityScore

    if (isAedReminderDue(state, coach, cprElapsedMs, nowMs)) {
        return emitCue(
            kind = ProactiveCueKind.AedReminder,
            text = aedReminderText(coach.aedReminderCount),
            tone = "calm_firm",
            newState = coach.copy(
                lastCueAtMs = nowMs,
                lastAedReminderAtMs = nowMs,
                aedReminderCount = coach.aedReminderCount + 1,
            ),
            nowMs = nowMs,
        )
    }

    if (isHandSwitchDue(coach, cprElapsedMs, quality, nowMs)) {
        return emitCue(
            kind = ProactiveCueKind.HandSwitch,
            text = handSwitchText(coach.handSwitchCount),
            tone = "calm_firm",
            newState = coach.copy(
                lastCueAtMs = nowMs,
                lastHandSwitchAtMs = nowMs,
                handSwitchCount = coach.handSwitchCount + 1,
            ),
            nowMs = nowMs,
        )
    }

    if (isReassureDue(coach, cprElapsedMs, quality, nowMs)) {
        return emitCue(
            kind = ProactiveCueKind.Reassure,
            text = reassureText(quality),
            tone = "calm_soft",
            newState = coach.copy(lastCueAtMs = nowMs, lastReassureAtMs = nowMs),
            nowMs = nowMs,
        )
    }

    return ProactiveDecision.Skip("nothing_due")
}

/**
 * 硬门控：返回非空原因即"绝不插话"。覆盖一切"正在/即将说话、半双工占用、弹窗、
 * critical 指令"的情形；既用于 [decideProactiveCue]，也用于润色后的二次校验
 * （润色可能耗时，期间状态可能变化）。
 */
internal fun hardSpeechBlockReason(state: LiveUiState): String? =
    when {
        state.isLiveAudioPlaying -> "live_audio_playing"
        state.suppressLocalTts -> "suppress_local_tts"
        state.micState == MicState.Speaking -> "mic_speaking"
        state.micState == MicState.Uploading -> "mic_uploading"
        state.isInFlight -> "turn_in_flight"
        state.openQuestionPhase == OpenQuestionPhase.Ack ||
            state.openQuestionPhase == OpenQuestionPhase.Answer -> "open_question"
        state.pendingConfirmation != null -> "pending_confirmation"
        state.emergencyCall.requested -> "emergency_call"
        state.ttsPriority == "critical" -> "critical_priority"
        else -> null
    }

/** 仅 S7（按压循环）与 S8（协助/AED）阶段允许主动提示。 */
internal fun isProactiveEligibleStage(stage: String?): Boolean =
    stage?.startsWith("S7") == true || stage?.startsWith("S8") == true

private fun isAedReminderDue(
    state: LiveUiState,
    coach: ProactiveCoachState,
    cprElapsedMs: Long,
    nowMs: Long,
): Boolean {
    if (state.visualOverlayMode == "aed_assistance") return false // AED 已到，不再提醒
    if (cprElapsedMs < AED_FIRST_MS) return false
    if (coach.aedReminderCount >= AED_MAX_REMINDERS) return false
    val sinceLast = coach.lastAedReminderAtMs?.let { nowMs - it }
    return sinceLast == null || sinceLast >= AED_INTERVAL_MS
}

private fun isHandSwitchDue(
    coach: ProactiveCoachState,
    cprElapsedMs: Long,
    quality: Int?,
    nowMs: Long,
): Boolean {
    val baseDue = cprElapsedMs >= HAND_SWITCH_FIRST_MS
    val fatigueDue = quality != null &&
        quality < HAND_SWITCH_FATIGUE_QUALITY &&
        cprElapsedMs >= HAND_SWITCH_FATIGUE_MIN_MS
    if (!baseDue && !fatigueDue) return false
    val sinceLast = coach.lastHandSwitchAtMs?.let { nowMs - it }
    return sinceLast == null || sinceLast >= HAND_SWITCH_INTERVAL_MS
}

private fun isReassureDue(
    coach: ProactiveCoachState,
    cprElapsedMs: Long,
    quality: Int?,
    nowMs: Long,
): Boolean {
    if (cprElapsedMs < REASSURE_FIRST_MS) return false
    if (quality != null && quality < REASSURE_MIN_QUALITY) return false
    val sinceLast = coach.lastReassureAtMs?.let { nowMs - it }
    return sinceLast == null || sinceLast >= REASSURE_INTERVAL_MS
}

private fun emitCue(
    kind: ProactiveCueKind,
    text: String,
    tone: String,
    newState: ProactiveCoachState,
    nowMs: Long,
): ProactiveDecision.Emit =
    ProactiveDecision.Emit(
        cue = ProactiveCue(
            id = "proactive-${kind.name.lowercase()}-$nowMs",
            kind = kind,
            text = text,
            tone = tone,
        ),
        state = newState,
    )

// --- 确定性模板。全部短句、calm、绝不含禁忌话术，永不说"停止按压"。 ---

private fun handSwitchText(count: Int): String =
    if (count % 2 == 0) {
        "已经按了两分钟，旁边有人就换手，节奏别断。"
    } else {
        "又坚持两分钟了，能换手就换上，换人要快。"
    }

private fun aedReminderText(count: Int): String =
    if (count % 2 == 0) {
        "要是还没拿到 AED，让旁人就近去取。"
    } else {
        "让旁边的人去找 AED，越快越好，你先继续按。"
    }

private fun reassureText(quality: Int?): String =
    if (quality != null && quality >= REASSURE_PRAISE_QUALITY) {
        "你做得很好，跟着节拍继续按。"
    } else {
        "保持这个节奏，继续用力快压。"
    }

/** 禁忌片段：润色结果命中任一即判为不安全并回退模板。对齐 safety_phrases 的禁区。 */
private val PROACTIVE_FORBIDDEN_FRAGMENTS: List<String> = listOf(
    "停止按压", "别按了", "可以停了", "停下来", "不用按",
    "已经死", "救不活", "一定能救", "保证能",
    "心梗", "脑卒中", "心脏骤停了",
    "不用担心", "没事的", "你自己决定", "由你决定",
)

/**
 * 端侧轻量安全校验（在 EdgeGuidanceGuard 落地前的兜底）：非空、不超长、且不含任何
 * 禁忌片段。润色文本必须通过本校验才会替换模板。
 */
internal fun isProactiveTextSafe(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return false
    if (trimmed.length > PROACTIVE_TEXT_MAX_CHARS) return false
    return PROACTIVE_FORBIDDEN_FRAGMENTS.none { trimmed.contains(it) }
}
