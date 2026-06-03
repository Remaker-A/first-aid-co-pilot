package com.firstaid.copilot.execution

interface GuidanceSink {
    val name: String
    fun supports(action: GuidanceAction, context: DispatchContext = DispatchContext()): Boolean
    fun deliver(action: GuidanceAction, context: DispatchContext = DispatchContext()): Delivery
}

class UiActionRenderer : GuidanceSink {
    override val name: String = ExecutionChannel.UI.value

    override fun supports(action: GuidanceAction, context: DispatchContext): Boolean =
        action.ui.hasRenderableContent() || context.fallbackReason != null

    override fun deliver(action: GuidanceAction, context: DispatchContext): Delivery {
        val fallback = context.fallbackReason != null && !action.ui.hasRenderableContent()
        val payload = if (fallback) {
            mapOf(
                "main_text" to "请继续当前急救步骤",
                "secondary_text" to "系统正在处理下一条指令",
                "fallback_reason" to context.fallbackReason
            )
        } else {
            mapOf(
                "main_text" to action.ui.main_text,
                "secondary_text" to action.ui.secondary_text,
                "status_tags" to action.ui.status_tags,
                "quality_score" to action.ui.quality_score,
                "primary_button" to action.ui.primary_button,
                "visual_overlay" to action.visual_overlay
            )
        }

        return Delivery(
            channel = name,
            status = DeliveryStatus.DELIVERED,
            summary = if (fallback) "Rendered UI fallback" else "Rendered guidance UI",
            payload = payload
        )
    }
}

interface AndroidTtsSink : GuidanceSink

class MockAndroidTtsSink : AndroidTtsSink {
    override val name: String = ExecutionChannel.TTS.value
    private val spoken = mutableListOf<TtsPayload>()

    val spokenPayloads: List<TtsPayload>
        get() = spoken.toList()

    override fun supports(action: GuidanceAction, context: DispatchContext): Boolean =
        action.tts.hasSpeech()

    override fun deliver(action: GuidanceAction, context: DispatchContext): Delivery {
        spoken += action.tts
        return Delivery(
            channel = name,
            status = DeliveryStatus.DELIVERED,
            summary = "Queued TTS",
            payload = mapOf(
                "text" to action.tts.text,
                "tone" to action.tts.tone,
                "speed" to action.tts.speed,
                "interrupt_policy" to action.tts.interrupt_policy
            )
        )
    }
}

interface AndroidHapticSink : GuidanceSink

class MockAndroidHapticSink : AndroidHapticSink {
    override val name: String = ExecutionChannel.HAPTIC.value
    var activePattern: HapticPayload? = null
        private set

    override fun supports(action: GuidanceAction, context: DispatchContext): Boolean =
        action.haptic.hasCommand() || action.tool_actions.any { it.type in HAPTIC_TOOL_TYPES }

    override fun deliver(action: GuidanceAction, context: DispatchContext): Delivery {
        val hapticTools = action.tool_actions.filter { it.type in HAPTIC_TOOL_TYPES }
        val lastHapticTool = hapticTools.lastOrNull()
        val command = lastHapticTool?.type

        activePattern = when (command) {
            "stop_haptic_metronome" -> null
            "start_haptic_metronome",
            "update_haptic_metronome" -> action.haptic.copy(
                enabled = true,
                pattern = action.haptic.pattern ?: "metronome",
                bpm = action.haptic.bpm ?: lastHapticTool.bpm ?: lastHapticTool.intPayload("bpm") ?: 110
            )
            else -> if (action.haptic.enabled) action.haptic else null
        }

        return Delivery(
            channel = name,
            status = DeliveryStatus.DELIVERED,
            summary = "Handled haptic command exclusively",
            payload = mapOf(
                "active" to (activePattern != null),
                "pattern" to activePattern?.pattern,
                "bpm" to activePattern?.bpm,
                "tool_types" to hapticTools.map { it.type }
            ),
            warnings = if (hapticTools.isNotEmpty()) {
                listOf("haptic_tools_routed_to_haptic_sink")
            } else {
                emptyList()
            }
        )
    }
}

class AndroidToolExecutor : GuidanceSink {
    override val name: String = ExecutionChannel.TOOL.value

    override fun supports(action: GuidanceAction, context: DispatchContext): Boolean =
        action.tool_actions.any { it.type !in HAPTIC_TOOL_TYPES }

    override fun deliver(action: GuidanceAction, context: DispatchContext): Delivery {
        val toolResults = action.tool_actions
            .filterNot { it.type in HAPTIC_TOOL_TYPES }
            .map { tool ->
                val confirmed = tool.isConfirmed(context)
                val mustConfirm = tool.type in SHARE_OR_DESTRUCTIVE_TOOL_TYPES ||
                    (tool.requires_user_confirmation && tool.type !in CRITICAL_TOOL_TYPES)

                when {
                    tool.type in CRITICAL_TOOL_TYPES -> mapOf(
                        "type" to tool.type,
                        "status" to DeliveryStatus.DELIVERED.name.lowercase(),
                        "critical" to true,
                        "strategy" to mockStrategyFor(tool.type)
                    )
                    tool.type in CONFIRMATION_REQUEST_TOOL_TYPES -> mapOf(
                        "type" to tool.type,
                        "status" to "prompted",
                        "strategy" to "visible_confirmation_prompt"
                    )
                    mustConfirm && !confirmed -> mapOf(
                        "type" to tool.type,
                        "status" to DeliveryStatus.BLOCKED.name.lowercase(),
                        "reason" to "user_confirmation_required"
                    )
                    else -> mapOf(
                        "type" to tool.type,
                        "status" to DeliveryStatus.DELIVERED.name.lowercase(),
                        "strategy" to mockStrategyFor(tool.type)
                    )
                }
            }

        val blocked = toolResults.all { it["status"] == DeliveryStatus.BLOCKED.name.lowercase() }

        return Delivery(
            channel = name,
            status = if (blocked) DeliveryStatus.BLOCKED else DeliveryStatus.DELIVERED,
            summary = if (blocked) "Blocked unsafe tool action" else "Executed mock tool actions",
            payload = mapOf("tools" to toolResults),
            warnings = toolResults
                .filter { it["status"] == DeliveryStatus.BLOCKED.name.lowercase() }
                .map { "tool_blocked:${it["type"]}" }
        )
    }

    private fun mockStrategyFor(type: String): String =
        when (type) {
            "emergency_call", "mock_emergency_call" -> "dial_or_demo_state_only"
            "attach_gps_location" -> "mock_location_attach"
            "start_local_recording" -> "mock_recording_state"
            "generate_handover_report" -> "mock_report_generation"
            else -> "mock_noop"
        }
}

private fun ToolAction.intPayload(key: String): Int? = when (val value = payload[key]) {
    is Int -> value
    is Number -> value.toInt()
    is String -> value.toIntOrNull()
    else -> null
}
