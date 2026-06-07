package com.firstaid.copilot.live.edge

import android.util.Log
import com.firstaid.copilot.live.LiveNluRequest
import com.firstaid.copilot.live.LiveNluResolution
import com.firstaid.copilot.live.LiveNluResolver
import com.firstaid.copilot.live.ProactivePolishRequest
import com.firstaid.copilot.live.ProactivePolisher
import com.firstaid.copilot.live.isProactiveTextSafe
import java.util.concurrent.PriorityBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * The single on-device Gemma enhancement layer (Phase 0 · A 的骨架).
 *
 * Design contract (端侧 Gemma 扩能 plan):
 * - Owns the one [OnDeviceGemmaDriver] exclusively. `generate()` is internally a
 *   `Mutex`, so a single owner + an internal **priority queue** is the only safe
 *   way to schedule the three product functions without contention.
 * - Priority: NLU (E) and open-question (C) outrank proactive polish (D), so a
 *   low-priority background polish can never starve an interactive request. The
 *   native call cannot be preempted mid-generation, so per-request timeouts bound
 *   the worst case; critical / high-frequency correction never enters this queue.
 * - "确定性先行 + Gemma 异步增强": this agent is NEVER on the critical hot path.
 *   Callers always emit a deterministic result first and only *augment* it.
 * - Fully flag-gated by [EdgeGemmaFeatureFlags]. With the default
 *   [EdgeGemmaFeatureFlags.DISABLED] every entry returns a skip/fallback/null
 *   without ever touching the driver, so attaching this agent changes nothing
 *   until a flag is flipped.
 *
 * It exposes the three seam interfaces the live phases depend on:
 * - [OpenQuestionResponder.answerOpenQuestion] (C),
 * - [LiveNluResolver.resolveIntent] (E),
 * - [ProactivePolisher.polish] (D).
 */
class EdgeGemmaAgent(
    private val driver: OnDeviceGemmaDriver,
    val flags: EdgeGemmaFeatureFlags = EdgeGemmaFeatureFlags.DISABLED,
    private val promptBuilder: EdgeGemmaPromptBuilder = EdgeGemmaPromptBuilder(),
    private val guard: EdgeGuidanceGuard = EdgeGuidanceGuard(),
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    parentScope: CoroutineScope? = null,
) : OpenQuestionResponder, LiveNluResolver, ProactivePolisher, AutoCloseable {

    private val ownsScope = parentScope == null
    private val scope = parentScope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val pending = PriorityBlockingQueue<QueuedRequest>()
    private val wakeup = Channel<Unit>(Channel.CONFLATED)
    private val seq = AtomicLong(0L)

    @Volatile
    private var closed = false

    private val worker: Job = scope.launch { runWorkLoop() }

    // --- Open-question (C) state: budget + LRU answer cache, ported from the
    // controlled-answer design so a chatty mishear cannot hammer the driver. ---
    private val budgetLock = Any()
    private val callTimestamps = ArrayDeque<Long>()
    private val answerCache = object : LinkedHashMap<String, OpenQuestionOutcome.Answer>(16, 0.75f, true) {
        override fun removeEldestEntry(
            eldest: MutableMap.MutableEntry<String, OpenQuestionOutcome.Answer>?,
        ): Boolean = size > ANSWER_CACHE_MAX_ENTRIES
    }
    @Volatile
    private var openQuestionCircuitOpenUntilMs: Long = 0L
    @Volatile
    private var consecutiveOpenQuestionTimeouts: Int = 0

    /** (C) Answer an out-of-flow open question with a short, guarded patch. */
    override suspend fun answerOpenQuestion(frame: OpenQuestionFrame): OpenQuestionOutcome {
        if (!flags.openQuestionActive) {
            return fallbackOpenQuestion(frame, reason = "disabled")
        }
        if (frame.allowedIntents.isEmpty()) {
            return fallbackOpenQuestion(frame, reason = "no_allowed_intents")
        }

        val now = clockMs()
        if (now < openQuestionCircuitOpenUntilMs) {
            return fallbackOpenQuestion(frame, reason = "circuit_open")
        }

        val key = cacheKey(frame)
        cachedAnswer(key)?.let { return it.copy(cacheHit = true) }

        if (!reserveBudget()) {
            return fallbackOpenQuestion(frame, reason = "budget_exceeded")
        }

        val prompt = promptBuilder.openQuestionPrompt(frame)
        val generation = enqueue(PRIORITY_OPEN_QUESTION, prompt, flags.openQuestionTimeoutMs)
            ?: return fallbackOpenQuestion(frame, reason = "queue_full")
        if (!generation.ok || generation.text.isBlank()) {
            if (generation.isTimeoutLike()) {
                tripOpenQuestionCircuit()
            }
            return fallbackOpenQuestion(
                frame = frame,
                reason = "generation:${generation.error ?: "empty"}",
                latencyMs = generation.latencyMs,
            )
        }

        val decision = guard.validateOpenQuestionText(generation.text, frame)
        if (!decision.accepted) {
            Log.w(TAG, "Edge open-question rejected (${decision.reasons.joinToString(",")})")
            return fallbackOpenQuestion(
                frame = frame,
                reason = "guard:${decision.reasons.joinToString("|")}",
                latencyMs = generation.latencyMs,
            )
        }

        consecutiveOpenQuestionTimeouts = 0
        openQuestionCircuitOpenUntilMs = 0L
        val answer = OpenQuestionOutcome.Answer(
            ttsText = decision.ttsText,
            mainText = decision.mainText,
            secondaryText = decision.secondaryText,
            intent = decision.intent,
            tone = decision.tone,
            latencyMs = generation.latencyMs,
            cacheHit = false,
        )
        storeAnswer(key, answer)
        Log.i(TAG, "Edge open-question answered in ${generation.latencyMs}ms intent=${decision.intent}")
        return answer
    }

    private fun fallbackOpenQuestion(
        frame: OpenQuestionFrame,
        reason: String,
        latencyMs: Long = 0L,
    ): OpenQuestionOutcome.Fallback =
        OpenQuestionOutcome.Fallback(
            reason = reason,
            answerText = EdgeOpenQuestionPolicy.fallbackAnswer(frame.stage, frame.userInput),
            latencyMs = latencyMs,
        )

    private fun tripOpenQuestionCircuit() {
        val count = (consecutiveOpenQuestionTimeouts + 1).coerceAtMost(10)
        consecutiveOpenQuestionTimeouts = count
        val cooldownMs = if (count >= 2) {
            OPEN_QUESTION_TIMEOUT_COOLDOWN_LONG_MS
        } else {
            OPEN_QUESTION_TIMEOUT_COOLDOWN_MS
        }
        openQuestionCircuitOpenUntilMs = clockMs() + cooldownMs
        Log.w(TAG, "Edge open-question circuit opened for ${cooldownMs}ms after timeout count=$count")
    }

    /**
     * (E) Resolve an observation/question intent from a transcript when the
     * deterministic regex + phonetic routers both missed. Returns null (treated as
     * "no correction") when disabled, the stage has no NLU policy, or the guard
     * rejects the output. Never throws for ordinary failures.
     */
    override suspend fun resolveIntent(request: LiveNluRequest): LiveNluResolution? {
        if (!flags.nluActive) return null
        val transcript = request.transcript.trim()
        if (transcript.isEmpty()) return null
        val policy = EdgeNluPolicy.forStage(request.stage) ?: return null
        val prompt = promptBuilder.nluPrompt(
            stage = request.stage ?: "",
            transcript = transcript,
            allowedIntents = policy.allowedIntents,
        )
        val generation = enqueue(PRIORITY_NLU, prompt, flags.nluTimeoutMs) ?: return null
        if (!generation.ok || generation.text.isBlank()) return null
        val decision = guard.validateNluText(generation.text, policy.allowedIntents)
        if (!decision.accepted) {
            Log.w(TAG, "Edge NLU rejected (${decision.reasons.joinToString(",")})")
            return null
        }
        return LiveNluResolution(
            intent = decision.intent,
            confidence = decision.confidence,
            needsClarification = decision.needsClarification,
        )
    }

    /**
     * (D) Optionally polish a proactive nudge whose deterministic template is the
     * fallback. Lowest priority. Returns null (keep the template) when disabled,
     * the driver is busy/slow, or the rewrite fails the proactive safety net.
     */
    override suspend fun polish(request: ProactivePolishRequest): String? {
        if (!flags.proactiveActive) return null
        val prompt = promptBuilder.proactivePrompt(request)
        val generation = enqueue(PRIORITY_PROACTIVE, prompt, flags.proactiveTimeoutMs) ?: return null
        if (!generation.ok) return null
        val text = cleanProactiveText(generation.text) ?: return null
        // Final gate: the proactive safety net (never "stop compressions", no
        // diagnosis/false promises, length-capped). Unsafe -> keep the template.
        return text.takeIf { isProactiveTextSafe(it) }
    }

    // --- Open-question budget / cache helpers ---

    private fun cachedAnswer(key: String): OpenQuestionOutcome.Answer? =
        synchronized(answerCache) { answerCache[key] }

    private fun storeAnswer(key: String, answer: OpenQuestionOutcome.Answer) {
        synchronized(answerCache) { answerCache[key] = answer }
    }

    private fun reserveBudget(): Boolean {
        val now = clockMs()
        synchronized(budgetLock) {
            while (callTimestamps.isNotEmpty() && now - callTimestamps.first() >= WINDOW_MS) {
                callTimestamps.removeFirst()
            }
            if (callTimestamps.size >= flags.openQuestionBudgetPerMinute) return false
            callTimestamps.addLast(now)
            return true
        }
    }

    private fun cacheKey(frame: OpenQuestionFrame): String =
        "${frame.stage.orEmpty()}|${frame.userInput.trim()}"

    // --- Priority scheduler over the single driver ---

    /**
     * Enqueue one generation and suspend until the single worker runs it. Returns
     * null when the queue is over budget or the agent is closed (caller treats as
     * a skip), so a burst of low-value requests can never pile up on the driver.
     */
    private suspend fun enqueue(priority: Int, prompt: String, timeoutMs: Long): EdgeInferenceResult? {
        if (closed) return null
        if (pending.size >= flags.maxQueueDepth) return null
        val deferred = CompletableDeferred<EdgeInferenceResult>()
        val request = QueuedRequest(priority, seq.incrementAndGet(), prompt, timeoutMs, deferred)
        pending.offer(request)
        if (closed) {
            pending.remove(request)
            request.deferred.complete(CLOSED_RESULT)
        } else {
            wakeup.trySend(Unit)
        }
        return try {
            deferred.await()
        } catch (cancellation: CancellationException) {
            deferred.cancel()
            throw cancellation
        }
    }

    private suspend fun runWorkLoop() {
        try {
            for (ignored in wakeup) {
                drainQueue()
            }
        } finally {
            failPending(CLOSED_RESULT)
        }
    }

    private suspend fun drainQueue() {
        while (true) {
            val request = pending.poll() ?: return
            if (!request.deferred.isActive) continue
            val result = try {
                driver.generate(request.prompt, request.timeoutMs)
            } catch (cancellation: CancellationException) {
                request.deferred.complete(CANCELLED_RESULT)
                throw cancellation
            } catch (error: Throwable) {
                Log.w(TAG, "Edge Gemma generation failed", error)
                EdgeInferenceResult(ok = false, error = error.message ?: "edge_generate_failed")
            }
            request.deferred.complete(result)
        }
    }

    private fun failPending(result: EdgeInferenceResult) {
        while (true) {
            val request = pending.poll() ?: break
            request.deferred.complete(result)
        }
    }

    override fun close() {
        closed = true
        wakeup.close()
        failPending(CLOSED_RESULT)
        worker.cancel()
        if (ownsScope) scope.cancel()
    }

    private class QueuedRequest(
        val priority: Int,
        val seq: Long,
        val prompt: String,
        val timeoutMs: Long,
        val deferred: CompletableDeferred<EdgeInferenceResult>,
    ) : Comparable<QueuedRequest> {
        override fun compareTo(other: QueuedRequest): Int {
            val byPriority = priority.compareTo(other.priority)
            return if (byPriority != 0) byPriority else seq.compareTo(other.seq)
        }
    }

    companion object {
        private const val TAG = "EdgeGemmaAgent"

        // Lower weight = higher priority (PriorityBlockingQueue is a min-heap).
        private const val PRIORITY_NLU = 0
        private const val PRIORITY_OPEN_QUESTION = 1
        private const val PRIORITY_PROACTIVE = 2

        private const val ANSWER_CACHE_MAX_ENTRIES = 32
        private const val WINDOW_MS = 60_000L
        private const val OPEN_QUESTION_TIMEOUT_COOLDOWN_MS = 20_000L
        private const val OPEN_QUESTION_TIMEOUT_COOLDOWN_LONG_MS = 60_000L

        private val CLOSED_RESULT = EdgeInferenceResult(ok = false, error = "edge_agent_closed")
        private val CANCELLED_RESULT = EdgeInferenceResult(ok = false, error = "edge_agent_cancelled")

        private fun EdgeInferenceResult.isTimeoutLike(): Boolean =
            error?.contains("exceeded", ignoreCase = true) == true ||
                error?.contains("timeout", ignoreCase = true) == true

        /** Strip wrappers/quotes the model may add around a one-line proactive rewrite. */
        private fun cleanProactiveText(raw: String): String? {
            var text = raw.trim()
            if (text.startsWith("```")) {
                text = text.trim('`').trim()
            }
            val firstLine = text.lineSequence()
                .map { it.trim().trim('"', '“', '”', '「', '」', ' ') }
                .firstOrNull { it.isNotEmpty() }
            return firstLine?.takeIf { it.isNotEmpty() }
        }
    }
}

/**
 * Feature switches for the edge agent. Everything defaults OFF, so a default-built
 * agent is inert and Phase 0 wiring is a behavioral no-op until a flag is enabled
 * (e.g. via an Activity intent extra in the Live screen). Phase D's
 * [com.firstaid.copilot.live.LiveSessionViewModel.setProactiveCoachingEnabled] is
 * wired from [proactiveEnabled].
 */
data class EdgeGemmaFeatureFlags(
    /** Master switch. When false the agent never calls the driver. */
    val enabled: Boolean = false,
    /** (E) On-device NLU fallback when regex + phonetic routers miss. */
    val nluEnabled: Boolean = false,
    /** (C) On-device open-question answering. */
    val openQuestionEnabled: Boolean = false,
    /** (D) Proactive nudge polishing + the proactive monitor master switch. */
    val proactiveEnabled: Boolean = false,
    /** Max queued (not-yet-running) requests before new ones are dropped. */
    val maxQueueDepth: Int = 4,
    /** Per-minute open-question call budget (sliding window). */
    val openQuestionBudgetPerMinute: Int = 20,
    val nluTimeoutMs: Long = GEMMA_GENERATE_BUDGET_MS,
    val openQuestionTimeoutMs: Long = OPEN_QUESTION_ANSWER_TIMEOUT_MS,
    val proactiveTimeoutMs: Long = GEMMA_GENERATE_BUDGET_MS,
) {
    /** Master switch AND the per-feature switch — the only "is this on" predicate. */
    val nluActive: Boolean get() = enabled && nluEnabled
    val openQuestionActive: Boolean get() = enabled && openQuestionEnabled
    val proactiveActive: Boolean get() = enabled && proactiveEnabled

    companion object {
        /** The default, fully-off posture used everywhere until a phase opts in. */
        val DISABLED = EdgeGemmaFeatureFlags()

        /**
         * Open-question generation ceiling. The immediate ack covers perceived
         * latency, so keep the async answer wait inside the 1-2s live target
         * and degrade to ack-then-async when the model cannot make that window.
         */
        const val OPEN_QUESTION_ANSWER_TIMEOUT_MS: Long = 1_800L
    }
}

/**
 * Minimal per-stage on-device NLU policy (allowed observation intents).
 * Distilled from the validated `assets/gemma_suite/nlu_main.json` case and the
 * server knowledge defaults. Stages without a baked policy resolve to null so the
 * agent simply declines (the hot path already committed deterministically). Later
 * phases can widen this table without touching the agent.
 *
 * Slots are intentionally omitted: the slim NLU output is `{intent,
 * needs_clarification, confidence}`, and the breathing semantics the model needs
 * live in one line of [EdgeGemmaPromptBuilder.NLU_SYSTEM_PROMPT].
 */
internal object EdgeNluPolicy {
    data class StageNlu(
        val allowedIntents: List<String>,
    )

    private val BY_STAGE: Map<String, StageNlu> = mapOf(
        "S3_CHECK_BREATHING" to StageNlu(
            allowedIntents = listOf(
                "no_normal_breathing",
                "normal_breathing",
                "normal_breathing_absent",
                "normal_breathing_present",
                "agonal_breathing",
                "clarify_breathing",
            ),
        ),
    )

    fun forStage(stage: String?): StageNlu? = stage?.let { BY_STAGE[it] }
}
