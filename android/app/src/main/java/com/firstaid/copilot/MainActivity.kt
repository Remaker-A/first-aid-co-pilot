package com.firstaid.copilot

import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.GuidanceActionDispatcher
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.ToolAction
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            FirstAidCopilotApp()
        }
    }
}

@Composable
private fun FirstAidCopilotApp() {
    MaterialTheme {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF8FAFC)),
            color = Color(0xFFF8FAFC),
        ) {
            GuidanceActionShell()
        }
    }
}

@Composable
private fun GuidanceActionShell() {
    val haptics = LocalHapticFeedback.current
    val context = LocalContext.current
    val eventLog = remember { mutableStateListOf<String>() }
    var lastAction by remember { mutableStateOf<GuidanceAction?>(null) }
    val tts = remember { mutableStateOf<TextToSpeech?>(null) }
    val dispatcher = remember { GuidanceActionDispatcher() }

    DisposableEffect(context) {
        val engine = TextToSpeech(context) {}
        tts.value = engine
        onDispose {
            engine.stop()
            engine.shutdown()
            tts.value = null
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "FirstAid Copilot",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF0F172A),
        )

        Text(
            text = lastAction?.ui?.main_text ?: "Waiting for guidance action",
            style = MaterialTheme.typography.titleMedium,
            color = Color(0xFF1E293B),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                onClick = {
                    val action = sampleGuidanceAction()
                    lastAction = action
                    executeAction(action, dispatcher, eventLog)
                    deliverAndroidEdges(action, tts.value) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                },
            ) {
                Text("Dispatch")
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Execution log",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFF334155),
        )

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            eventLog.forEach { line ->
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF475569),
                )
            }
        }
    }
}

private fun executeAction(
    action: GuidanceAction,
    dispatcher: GuidanceActionDispatcher,
    eventLog: MutableList<String>,
) {
    val result = dispatcher.dispatch(action)
    eventLog.add("dispatch:${result.action_id} channels=${result.channels.joinToString(",")}")
    result.warnings.forEach { eventLog.add("warning:$it") }
    action.log_event?.let { eventLog.add("log:$it") }
}

private fun deliverAndroidEdges(
    action: GuidanceAction,
    tts: TextToSpeech?,
    haptic: () -> Unit,
) {
    action.tts.text.takeIf { it.isNotBlank() }?.let {
        tts?.language = Locale.US
        tts?.speak(it, TextToSpeech.QUEUE_FLUSH, null, action.action_id)
    }

    if (action.haptic.enabled) {
        haptic()
    }
}

private fun sampleGuidanceAction(): GuidanceAction =
    GuidanceAction(
        action_id = "sample-action-001",
        timestamp = "2026-06-03T00:00:00Z",
        stage = "ANDROID_EXECUTION_SHELL",
        intent = "render_guidance",
        source = "sample_agent_output",
        reason_codes = listOf("android_shell_fixture"),
        tts = TtsPayload(text = "Keep following the agent guidance."),
        ui = UiPayload(
            main_text = "Keep following the agent guidance.",
            secondary_text = "Agent-owned guidance rendered by Android.",
            status_tags = listOf("execution-only"),
        ),
        haptic = HapticPayload(enabled = true, pattern = "prompt"),
        tool_actions = listOf(
            ToolAction(
                type = "log_marker",
                payload = mapOf("fixture" to true),
            ),
        ),
        log_event = mapOf("event" to "guidance_action_dispatched"),
    )

@Preview(showBackground = true)
@Composable
private fun FirstAidCopilotAppPreview() {
    FirstAidCopilotApp()
}
