package com.example.cpr_new.agent.copilot

import com.example.cpr_new.core.contract.ActionType
import com.example.cpr_new.core.contract.CprPhase
import com.example.cpr_new.core.contract.GuidanceAction
import com.example.cpr_new.core.contract.GuidancePriority
import com.example.cpr_new.core.contract.MessageCode

object CopilotActionMapper {

    fun toLocalAction(
        copilot: CopilotGuidanceAction,
        sessionId: String,
        ttsAudioSrc: String? = null,
        suppressLocalTts: Boolean = false,
        responseType: String? = null,
    ): GuidanceAction {
        val primaryButton = copilot.ui.primaryButton
        val primaryLabel = primaryButton?.get("label")?.toString().orEmpty()
        val primaryAction = primaryButton?.get("action")?.toString().orEmpty()
        val executableTools = copilot.toolActions.filter { !it.requiresUserConfirmation || it.confirmed }
        val toolTypes = executableTools.joinToString(",") { it.type }
        val pendingConfirm = copilot.toolActions
            .filter { it.requiresUserConfirmation && !it.confirmed }
            .joinToString(",") { it.type }
        val metronomeBpm = resolveMetronomeBpm(copilot)

        return GuidanceAction(
            actionId = copilot.actionId,
            sessionId = sessionId,
            timestampMs = System.currentTimeMillis(),
            actionType = ActionType.COMPOSITE,
            priority = mapPriority(copilot.priority),
            messageCode = mapMessageCode(copilot),
            messageText = copilot.ui.displayText.ifBlank { copilot.tts.text },
            ttsText = copilot.tts.text.ifBlank { copilot.ui.displayText },
            hapticPattern = null,
            sourceEventId = "",
            phase = mapStageToPhase(copilot.stage),
            targetRate = metronomeBpm,
            metadata = buildMap {
                put("copilot_stage", copilot.stage)
                put("copilot_intent", copilot.intent)
                put("copilot_source", copilot.source)
                if (primaryLabel.isNotBlank()) put("primary_button_label", primaryLabel)
                if (primaryAction.isNotBlank()) put("primary_button_action", primaryAction)
                if (toolTypes.isNotBlank()) put("tool_types", toolTypes)
                if (pendingConfirm.isNotBlank()) put("pending_confirm_tools", pendingConfirm)
                copilot.ui.qualityScore?.let { put("quality_score", it.toString()) }
                copilot.ui.secondaryText.takeIf { it.isNotBlank() }?.let { put("secondary_text", it) }
                if (copilot.ui.statusTags.isNotEmpty()) {
                    put("status_tags", copilot.ui.statusTags.joinToString("|"))
                }
                copilot.visualOverlay?.get("mode")?.toString()?.takeIf { it.isNotBlank() }
                    ?.let { put("visual_overlay_mode", it) }
                copilot.visualOverlay?.get("correction_arrow")?.toString()?.takeIf { it.isNotBlank() }
                    ?.let { put("correction_arrow", it) }
                ttsAudioSrc?.takeIf { it.isNotBlank() }?.let { put("tts_audio_src", it) }
                if (suppressLocalTts) put("suppress_local_tts", "true")
                responseType?.takeIf { it.isNotBlank() }?.let { put("response_type", it) }
            },
        )
    }

    fun mapButtonTextToUserInput(label: String, action: String): String =
        when (action) {
            "mark_scene_safe", "confirm_scene_safe" -> "现场安全了，我在患者旁边"
            "mark_unresponsive" -> "他没有反应"
            "mark_no_normal_breathing", "mark_no_breathing" -> "没有呼吸，偶尔喘一下"
            "mark_agonal_breathing" -> "只是偶尔喘一下"
            "mark_emergency_called" -> "已经拨打120"
            "mark_cpr_ready", "start_cpr", "continue_cpr" -> "我准备好了"
            "confirm_share_video" -> "确认分享"
            "confirm_share_report" -> "确认分享报告"
            "decline_share_video" -> "不分享"
            else -> label.ifBlank { action }
        }

    private fun resolveMetronomeBpm(copilot: CopilotGuidanceAction): Int? {
        val hapticBpm = copilot.haptic.bpm
        if (hapticBpm != null && hapticBpm > 0) return hapticBpm
        val toolBpm = copilot.toolActions
            .firstOrNull { it.type in setOf(CopilotHapticTools.START, CopilotHapticTools.UPDATE) }
            ?.bpm
        if (toolBpm != null && toolBpm > 0) return toolBpm
        if (copilot.haptic.enabled || copilot.toolActions.any { it.type == CopilotHapticTools.START }) {
            return 110
        }
        return null
    }

    private fun mapPriority(priority: String): GuidancePriority =
        when (priority) {
            CopilotPriority.CRITICAL -> GuidancePriority.CRITICAL
            CopilotPriority.HIGH -> GuidancePriority.HIGH
            CopilotPriority.LOW, CopilotPriority.SILENT -> GuidancePriority.LOW
            else -> GuidancePriority.MEDIUM
        }

    private fun mapStageToPhase(stage: String): CprPhase =
        when {
            stage.startsWith("S0") || stage.startsWith("S1") || stage.startsWith("S2") ||
                stage.startsWith("S3") || stage.startsWith("S4") -> CprPhase.ASSESS
            stage.startsWith("S5") -> CprPhase.CALL_EMS
            stage.startsWith("S6") || stage.startsWith("S7") || stage.startsWith("S8") ||
                stage.contains("MONITOR") -> CprPhase.COMPRESSION
            stage.startsWith("S9") -> CprPhase.HANDOVER
            else -> CprPhase.COMPRESSION
        }

    private fun mapMessageCode(copilot: CopilotGuidanceAction): MessageCode {
        val intent = copilot.intent
        val reasons = copilot.reasonCodes.joinToString(" ")
        val blob = "$intent $reasons".lowercase()
        return when {
            blob.contains("left") || blob.contains("左") -> MessageCode.MOVE_LEFT
            blob.contains("right") || blob.contains("右") -> MessageCode.MOVE_RIGHT
            blob.contains("high") || blob.contains("上") -> MessageCode.MOVE_UP
            blob.contains("low") || blob.contains("下") -> MessageCode.MOVE_DOWN
            blob.contains("slow") || blob.contains("慢") -> MessageCode.SLOW_DOWN
            blob.contains("fast") || blob.contains("快") -> MessageCode.SPEED_UP
            blob.contains("straight") || blob.contains("弯") -> MessageCode.STRAIGHTEN_ARMS
            blob.contains("resume") || blob.contains("继续") -> MessageCode.RESUME_COMPRESSIONS
            blob.contains("interrupt") || blob.contains("中断") -> MessageCode.RESUME_COMPRESSIONS
            blob.contains("lost") || blob.contains("丢失") -> MessageCode.TRACKING_LOST
            else -> MessageCode.GOOD_CONTINUE
        }
    }
}
