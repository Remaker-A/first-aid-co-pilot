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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import com.firstaid.copilot.execution.Delivery
import com.firstaid.copilot.execution.DispatchContext
import com.firstaid.copilot.execution.DispatchResult
import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.GuidanceActionDispatcher
import com.firstaid.copilot.execution.GuidanceFixture
import com.firstaid.copilot.execution.GuidanceFixtureRepository
import com.firstaid.copilot.execution.HAPTIC_TOOL_TYPES
import com.firstaid.copilot.execution.ToolAction
import com.firstaid.copilot.live.ui.LiveCprCoachScreen
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
        var showFixtureDebug by remember { mutableStateOf(false) }
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF8FAFC)),
            color = Color(0xFFF8FAFC),
        ) {
            if (showFixtureDebug) {
                GuidanceActionShell(onBackToLive = { showFixtureDebug = false })
            } else {
                LiveCprCoachScreen(onOpenFixtureDebug = { showFixtureDebug = true })
            }
        }
    }
}

@Composable
private fun GuidanceActionShell(onBackToLive: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val context = LocalContext.current
    val eventLog = remember { mutableStateListOf<String>() }
    var fixtures by remember { mutableStateOf<List<GuidanceFixture>>(emptyList()) }
    var selectedFixtureIndex by remember { mutableStateOf(0) }
    var fixtureLoadError by remember { mutableStateOf<String?>(null) }
    var lastAction by remember { mutableStateOf<GuidanceAction?>(null) }
    var lastDispatch by remember { mutableStateOf<DispatchResult?>(null) }
    var lastRunSummary by remember { mutableStateOf<String?>(null) }
    val tts = remember { mutableStateOf<TextToSpeech?>(null) }
    val dispatcher = remember { GuidanceActionDispatcher() }

    LaunchedEffect(context) {
        runCatching {
            GuidanceFixtureRepository(context.assets).loadFixtures()
        }.onSuccess { loaded ->
            fixtures = loaded
            selectedFixtureIndex = 0
            fixtureLoadError = null
            lastRunSummary = null
            eventLog.add("fixtures:loaded count=${loaded.size}")
        }.onFailure {
            fixtureLoadError = it.message ?: it.toString()
            lastRunSummary = null
            eventLog.add("fixtures:error ${fixtureLoadError}")
        }
    }

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

        OutlinedButton(onClick = onBackToLive) {
            Text("Back to Live CPR Coach")
        }

        Text(
            text = lastAction?.ui?.main_text ?: "Waiting for guidance action",
            style = MaterialTheme.typography.titleMedium,
            color = Color(0xFF1E293B),
        )

        lastAction?.ui?.secondary_text
            ?.takeIf { it.isNotBlank() }
            ?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color(0xFF475569),
                )
            }

        lastAction?.let { action ->
            Text(
                text = "stage=${action.stage} intent=${action.intent} priority=${action.priority}",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF64748B),
            )

            if (action.ui.status_tags.isNotEmpty()) {
                Text(
                    text = "tags: ${action.ui.status_tags.joinToString(", ")}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF475569),
                )
            }

            action.ui.quality_score?.let {
                Text(
                    text = "quality_score=$it",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF475569),
                )
            }
        }

        val selectedFixture = fixtures.getOrNull(selectedFixtureIndex)

        Text(
            text = when {
                fixtureLoadError != null -> "Fixture load failed: $fixtureLoadError"
                selectedFixture != null -> "Fixture ${selectedFixtureIndex + 1}/${fixtures.size}: ${selectedFixture.fileName}"
                else -> "No fixtures loaded"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (fixtureLoadError == null) Color(0xFF475569) else Color(0xFFB91C1C),
        )

        selectedFixture?.expectedChannels
            ?.takeIf { it.isNotEmpty() }
            ?.let {
                Text(
                    text = "expected: ${it.joinToString(", ")}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF64748B),
                )
            }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                enabled = fixtures.isNotEmpty(),
                onClick = {
                    selectedFixtureIndex = previousIndex(selectedFixtureIndex, fixtures.size)
                },
            ) {
                Text("Previous")
            }

            Button(
                enabled = fixtures.isNotEmpty(),
                onClick = {
                    selectedFixtureIndex = nextIndex(selectedFixtureIndex, fixtures.size)
                },
            ) {
                Text("Next")
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                enabled = selectedFixture != null,
                onClick = {
                    val action = selectedFixture?.action ?: return@Button
                    lastRunSummary = null
                    lastAction = action
                    lastDispatch = executeAction(action, selectedFixture, dispatcher, eventLog)
                    deliverAndroidEdges(action, tts.value) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                },
            ) {
                Text("Dispatch Fixture")
            }

            Button(
                enabled = fixtures.isNotEmpty(),
                onClick = {
                    val loadedFixtures = fixtures
                    eventLog.add("run_all:start count=${loadedFixtures.size}")
                    var passed = 0
                    loadedFixtures.forEachIndexed { index, fixture ->
                        selectedFixtureIndex = index
                        lastAction = fixture.action
                        val result = executeAction(fixture.action, fixture, dispatcher, eventLog)
                        lastDispatch = result
                        if (fixture.hasExpectedMatch(result)) {
                            passed += 1
                        }
                        deliverAndroidEdges(fixture.action, tts.value) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        }
                    }
                    lastRunSummary = "run_all:complete passed=$passed/${loadedFixtures.size}"
                    eventLog.add(lastRunSummary!!)
                },
            ) {
                Text("Run All Fixtures")
            }
        }

        lastRunSummary?.let { summary ->
            Text(
                text = summary,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF166534),
                fontWeight = FontWeight.SemiBold,
            )
        }

        lastAction?.ui?.primary_button
            ?.get("label")
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?.let { label ->
                Text(
                    text = "primary_button: $label",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF475569),
                )
            }

        lastDispatch?.let { result ->
            Text(
                text = "channels=${result.channels.joinToString(",").ifBlank { "none" }} fallback=${result.fallback}",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF334155),
            )
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
    fixture: GuidanceFixture,
    dispatcher: GuidanceActionDispatcher,
    eventLog: MutableList<String>,
): DispatchResult {
    val result = dispatcher.dispatch(action, DispatchContext(knownIntents = KNOWN_AGENT_INTENTS))
    eventLog.add("dispatch:${result.action_id} channels=${result.channels.joinToString(",")}")
    result.deliveries.forEach { delivery ->
        eventLog.add(delivery.describe())
    }
    eventLog.add(fixture.describeExpectedMatch(result))
    result.warnings.forEach { eventLog.add("warning:$it") }
    action.log_event?.let { eventLog.add("log:$it") }
    return result
}

private fun deliverAndroidEdges(
    action: GuidanceAction,
    tts: TextToSpeech?,
    haptic: () -> Unit,
) {
    action.tts.text.takeIf { it.isNotBlank() }?.let {
        val queueMode = if (
            action.priority == "critical" ||
            action.tts.interrupt_policy == "interrupt_lower_priority"
        ) {
            TextToSpeech.QUEUE_FLUSH
        } else {
            TextToSpeech.QUEUE_ADD
        }
        tts?.language = Locale.SIMPLIFIED_CHINESE
        tts?.speak(it, queueMode, null, action.action_id)
    }

    val hapticCommand = action.tool_actions.lastOrNull { it.type in HAPTIC_TOOL_TYPES }?.type
    if (action.haptic.enabled || hapticCommand in setOf("start_haptic_metronome", "update_haptic_metronome")) {
        haptic()
    }
}

private fun Delivery.describe(): String {
    val toolSummary = (payload["tools"] as? List<*>)
        ?.mapNotNull { it as? Map<*, *> }
        ?.joinToString(";") { tool ->
            "${tool["type"]}:${tool["status"]}"
        }
        ?.takeIf { it.isNotBlank() }
    return buildString {
        append("delivery:$channel:${status.name.lowercase()}")
        summary?.let { append(" $it") }
        toolSummary?.let { append(" tools=$it") }
        error?.let { append(" error=$it") }
    }
}

private fun GuidanceFixture.describeExpectedMatch(result: DispatchResult): String {
    val observed = result.observedAndroidChannels(action)
    val missing = expectedChannels.filterNot { it in observed }
    val unexpected = observed.filterNot { it in expectedChannels }
    return buildString {
        append("expected:")
        append(if (missing.isEmpty()) "pass" else "missing=${missing.joinToString(",")}")
        if (unexpected.isNotEmpty()) {
            append(" extra=${unexpected.joinToString(",")}")
        }
        append(" observed=${observed.joinToString(",")}")
    }
}

private fun GuidanceFixture.hasExpectedMatch(result: DispatchResult): Boolean {
    val observed = result.observedAndroidChannels(action)
    return expectedChannels.all { it in observed }
}

private fun DispatchResult.observedAndroidChannels(action: GuidanceAction): Set<String> {
    val observed = linkedSetOf<String>()
    deliveries.forEach { delivery ->
        if (delivery.status == com.firstaid.copilot.execution.DeliveryStatus.DELIVERED) {
            if (delivery.channel == "ui" && fallback) {
                observed += "ui_fallback"
            } else {
                observed += delivery.channel
            }
        }
        if (delivery.channel == "tool" && delivery.status == com.firstaid.copilot.execution.DeliveryStatus.BLOCKED) {
            observed += "tool_blocked"
        }
    }
    if (action.log_event != null) {
        observed += "log"
    }
    return observed
}

private fun previousIndex(index: Int, size: Int): Int =
    if (size <= 0) 0 else (index - 1 + size) % size

private fun nextIndex(index: Int, size: Int): Int =
    if (size <= 0) 0 else (index + 1) % size

private val KNOWN_AGENT_INTENTS = setOf(
    "ask_response_check",
    "start_cpr_loop",
    "continue_cpr_loop",
    "stop_cpr_loop",
    "start_emergency_call_and_cpr",
    "share_recorded_video",
    "render_guidance",
    "defer_to_critical_action",
    "noop",
)

@Preview(showBackground = true)
@Composable
private fun FirstAidCopilotAppPreview() {
    FirstAidCopilotApp()
}
