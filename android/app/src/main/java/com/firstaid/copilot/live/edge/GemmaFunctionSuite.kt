package com.firstaid.copilot.live.edge

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drives the on-device Gemma "four-function" probe suite.
 *
 * Test cases live in app assets under [ROOT]; each case targets one product
 * function (grouped by `functionId`) and is scored by [GemmaSuiteAsserts].
 * Latency is aggregated with the same [LatencyStats] / [gemmaLatencyGate]
 * helpers used by the single-prompt smoke benchmark so the two reports stay
 * directly comparable.
 */
class GemmaFunctionSuite(
    private val context: Context,
    private val root: String = "gemma_suite",
) {

    // NLU cases ship structured input and are rendered on-device with the SAME
    // production builder the live path uses, so the probe has zero prompt drift.
    private val promptBuilder = EdgeGemmaPromptBuilder()

    /**
     * Run every asset case against [driver] and return the full report JSON.
     *
     * [checkpoint] is invoked once after each case completes so the caller can
     * persist progress incrementally. The returned object carries the suite's
     * own fields (`ok`, `mode`, `runs`, `functions`); top-level prewarm fields
     * (`backend`, `prewarmOk`, `prewarmLatencyMs`) and `phase`/`updatedAtMs`
     * are owned by the caller's [checkpoint].
     */
    suspend fun run(
        driver: OnDeviceGemmaDriver,
        defaultRuns: Int,
        timeoutMs: Long,
        gateMs: Long,
        budgetMs: Long,
        checkpoint: (JSONObject) -> Unit,
    ): JSONObject {
        val report = JSONObject()
            .put("ok", false)
            .put("mode", MODE)
            .put("runs", defaultRuns)
            .put("functions", JSONObject())

        val cases = try {
            withContext(Dispatchers.IO) { loadCases() }
        } catch (error: Exception) {
            report.put("ok", false)
                .put("error", "failed to load gemma_suite assets: ${error.message}")
                .put("phase", "finished")
            checkpoint(report)
            return report
        }

        if (cases.isEmpty()) {
            report.put("ok", false)
                .put("error", "gemma_suite manifest has no cases")
                .put("phase", "finished")
            checkpoint(report)
            return report
        }

        val functions = LinkedHashMap<String, FunctionAccumulator>()
        for (case in cases) {
            val accumulator = functions.getOrPut(case.functionId) { FunctionAccumulator(case.functionLabel) }
            if (accumulator.label.isBlank() && case.functionLabel.isNotBlank()) {
                accumulator.label = case.functionLabel
            }

            val outcome = runCase(driver, case, defaultRuns, timeoutMs, gateMs, budgetMs)
            accumulator.cases.put(outcome.json)
            accumulator.totalRuns += outcome.totalRuns
            accumulator.parseOkRuns += outcome.parseOkRuns
            accumulator.passRuns += outcome.passRuns
            accumulator.bannedHits += outcome.bannedHits

            report.put("functions", buildFunctions(functions))
                .put("ok", computeOk(functions))
                .put("phase", "case_${case.functionId}_${case.caseId}_done")
            checkpoint(report)
        }

        return report.put("functions", buildFunctions(functions))
            .put("ok", computeOk(functions))
            .put("phase", "finished")
    }

    private suspend fun runCase(
        driver: OnDeviceGemmaDriver,
        case: SuiteCase,
        defaultRuns: Int,
        timeoutMs: Long,
        gateMs: Long,
        budgetMs: Long,
    ): CaseOutcome {
        val totalRuns = (case.runs ?: defaultRuns).coerceAtLeast(1)
        val okLatencies = ArrayList<Long>(totalRuns)
        val samples = JSONArray()
        var parseOkRuns = 0
        var passRuns = 0
        var bannedHits = 0
        val prompt = resolvePrompt(case)
        for (runIndex in 1..totalRuns) {
            val generation = driver.generate(prompt, timeoutMs)
            val verdict = GemmaSuiteAsserts.evaluate(case.expected, generation.text)
            // Latency mirrors the smoke harness: only successful, non-empty runs count.
            if (generation.ok && generation.text.isNotBlank()) {
                okLatencies += generation.latencyMs
            }
            if (verdict.parseOk) parseOkRuns += 1
            if (verdict.pass) passRuns += 1
            bannedHits += verdict.bannedHits.size
            samples.put(
                JSONObject()
                    .put("run", runIndex)
                    .put("ok", generation.ok)
                    .put("latencyMs", generation.latencyMs)
                    .put("parseOk", verdict.parseOk)
                    .put("pass", verdict.pass)
                    .put("failures", JSONArray(verdict.failures))
                    .put("text", generation.text.take(TEXT_LIMIT)),
            )
        }
        val gate = gemmaLatencyGate(okLatencies, totalRuns, gateMs, budgetMs)
        val json = JSONObject()
            .put("caseId", case.caseId)
            .put("label", case.label)
            .put("runs", totalRuns)
            .put("okRuns", okLatencies.size)
            .put("parseOkRate", rate(parseOkRuns, totalRuns))
            .put("assertPassRate", rate(passRuns, totalRuns))
            .put("bannedHits", bannedHits)
            .put("latency", gate.stats.toJson())
            .put("gate", gate.toJson())
            .put("samples", samples)
        return CaseOutcome(json, totalRuns, parseOkRuns, passRuns, bannedHits)
    }

    /**
     * Resolve the final prompt for [case]. The plain-text edge functions (single-label
     * NLU, single-sentence open question) carry structured `input` and are rendered with
     * the production [EdgeGemmaPromptBuilder] from that input, so the probe feeds the
     * model exactly what the live path would; every other case uses its pre-rendered
     * asset prompt.
     */
    private fun resolvePrompt(case: SuiteCase): String {
        val input = case.input ?: return case.prompt
        return when (case.expected.optString("kind")) {
            "nlu_label" -> {
                val stage = input.optString("stage")
                val transcript = input.optString("transcript")
                val allowedIntents = jsonStringList(input.optJSONArray("allowedIntents"))
                if (transcript.isNotBlank() && allowedIntents.isNotEmpty()) {
                    promptBuilder.nluPrompt(stage, transcript, allowedIntents)
                } else {
                    case.prompt
                }
            }
            "open_question_text" -> {
                val stage = input.optString("stage")
                val userInput = input.optString("userInput")
                val frame = OpenQuestionFrame(
                    stage = stage,
                    userInput = userInput,
                    allowedIntents = EdgeOpenQuestionPolicy.answerIntents(stage),
                )
                if (userInput.isNotBlank() && frame.allowedIntents.isNotEmpty()) {
                    promptBuilder.openQuestionPrompt(frame)
                } else {
                    case.prompt
                }
            }
            else -> case.prompt
        }
    }

    private fun loadCases(): List<SuiteCase> {
        val manifest = JSONObject(readAsset("$root/manifest.json"))
        val caseFiles = manifest.optJSONArray("cases") ?: return emptyList()
        val cases = ArrayList<SuiteCase>(caseFiles.length())
        for (index in 0 until caseFiles.length()) {
            val caseFile = caseFiles.optString(index).takeIf { it.isNotBlank() } ?: continue
            val json = JSONObject(readAsset("$root/$caseFile"))
            cases += SuiteCase(
                functionId = json.optString("functionId").ifBlank { "unknown" },
                functionLabel = json.optString("functionLabel"),
                caseId = json.optString("caseId").ifBlank { caseFile },
                label = json.optString("label"),
                prompt = json.optString("prompt"),
                input = json.optJSONObject("input"),
                expected = json.optJSONObject("expected") ?: JSONObject(),
                runs = if (json.has("runs")) json.optInt("runs") else null,
            )
        }
        return cases
    }

    private fun readAsset(path: String): String =
        context.assets.open(path).use { it.readBytes().toString(Charsets.UTF_8) }

    private fun buildFunctions(functions: Map<String, FunctionAccumulator>): JSONObject {
        val obj = JSONObject()
        for ((functionId, accumulator) in functions) {
            obj.put(
                functionId,
                JSONObject()
                    .put("label", accumulator.label.ifBlank { functionId })
                    .put("parseOkRate", rate(accumulator.parseOkRuns, accumulator.totalRuns))
                    .put("assertPassRate", rate(accumulator.passRuns, accumulator.totalRuns))
                    .put("bannedHits", accumulator.bannedHits)
                    .put("cases", accumulator.cases),
            )
        }
        return obj
    }

    private fun computeOk(functions: Map<String, FunctionAccumulator>): Boolean =
        functions.isNotEmpty() && functions.values.all { accumulator ->
            accumulator.totalRuns > 0 &&
                rate(accumulator.parseOkRuns, accumulator.totalRuns) == 1.0 &&
                rate(accumulator.passRuns, accumulator.totalRuns) == 1.0 &&
                accumulator.bannedHits == 0
        }

    private data class SuiteCase(
        val functionId: String,
        val functionLabel: String,
        val caseId: String,
        val label: String,
        val prompt: String,
        val input: JSONObject?,
        val expected: JSONObject,
        val runs: Int?,
    )

    private class CaseOutcome(
        val json: JSONObject,
        val totalRuns: Int,
        val parseOkRuns: Int,
        val passRuns: Int,
        val bannedHits: Int,
    )

    private class FunctionAccumulator(var label: String) {
        val cases = JSONArray()
        var totalRuns = 0
        var parseOkRuns = 0
        var passRuns = 0
        var bannedHits = 0
    }

    private companion object {
        const val MODE = "gemma-suite"
        const val TEXT_LIMIT = 120
    }
}

private fun rate(passed: Int, total: Int): Double =
    if (total <= 0) 0.0 else passed.toDouble() / total

private fun jsonStringList(array: JSONArray?): List<String> {
    if (array == null) return emptyList()
    val out = ArrayList<String>(array.length())
    for (index in 0 until array.length()) {
        if (!array.isNull(index)) {
            val value = array.optString(index, "")
            if (value.isNotEmpty()) out.add(value)
        }
    }
    return out
}

private fun LatencyStats.toJson(): JSONObject =
    JSONObject()
        .put("count", count)
        .put("avgMs", avgMs ?: JSONObject.NULL)
        .put("minMs", minMs ?: JSONObject.NULL)
        .put("maxMs", maxMs ?: JSONObject.NULL)
        .put("p50Ms", p50Ms ?: JSONObject.NULL)
        .put("p95Ms", p95Ms ?: JSONObject.NULL)

private fun GemmaLatencyGate.toJson(): JSONObject =
    JSONObject()
        .put("gateMs", gateMs)
        .put("budgetMs", budgetMs)
        .put("totalRuns", totalRuns)
        .put("okRuns", okRuns)
        .put("withinBudgetRuns", withinBudgetRuns)
        .put("p50Ms", stats.p50Ms ?: JSONObject.NULL)
        .put("p95Ms", stats.p95Ms ?: JSONObject.NULL)
        .put("nearRealtimeCapable", nearRealtimeCapable)
        .put("recommendation", recommendation)
