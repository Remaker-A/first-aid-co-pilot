package com.firstaid.copilot.live

/**
 * Stage-scoped request for on-device NLU intent resolution. The transcript is the
 * raw (trimmed) user utterance; [stage] is the current medical stage so the
 * resolver can constrain itself to that stage's allowed intents.
 */
data class LiveNluRequest(
    val transcript: String,
    val stage: String?,
)

/**
 * Result of an on-device NLU resolution. [intent] is null/blank when the model
 * could not confidently map the utterance; [needsClarification] mirrors the
 * NLU schema's `needs_clarification` so an ambiguous reading is never promoted
 * into a hard intent hint.
 */
data class LiveNluResolution(
    val intent: String?,
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false,
)

/**
 * Seam for on-device NLU (Phase 1 · E). The Live screen attaches an
 * implementation backed by the prewarmed Gemma driver (Phase 0's
 * `EdgeGemmaAgent.resolveIntent()`); the [LiveSessionViewModel] depends only on
 * this interface so the hot path stays decoupled from the model.
 *
 * Contract: implementations resolve observation/question *intent only*. They
 * never advance the medical stage, never emit guidance, and the result is only
 * ever used to refine the intent hint sent on a future turn.
 */
fun interface LiveNluResolver {
    suspend fun resolveIntent(request: LiveNluRequest): LiveNluResolution?
}

/**
 * Read/throttle side of the "ack now, Gemma corrects next turn" strategy.
 *
 * Because the single on-device Gemma driver is far from real-time, the live hot
 * path never blocks on NLU: a regex/phonetic miss is committed immediately, and
 * the transcript is resolved asynchronously. This coordinator owns the two
 * guards that keep that background work from flooding the shared driver:
 *
 * - a small **LRU cache** keyed by transcript, so a repeated utterance carries
 *   the previously-resolved intent on its next turn (and is never re-resolved
 *   while the entry is fresh);
 * - a **per-minute call budget** (sliding window) plus in-flight de-duplication,
 *   so bursty ASR finals cannot queue unbounded generations.
 *
 * All methods are non-suspending and thread-safe; the suspending resolver call
 * itself happens in the caller's coroutine, outside this class.
 */
class LiveNluCoordinator(
    private val maxCacheEntries: Int = DEFAULT_MAX_CACHE_ENTRIES,
    private val maxCallsPerMinute: Int = DEFAULT_MAX_CALLS_PER_MINUTE,
    private val cacheTtlMs: Long = DEFAULT_CACHE_TTL_MS,
    private val minTranscriptChars: Int = DEFAULT_MIN_TRANSCRIPT_CHARS,
    private val maxTranscriptChars: Int = DEFAULT_MAX_TRANSCRIPT_CHARS,
) {
    private val lock = Any()

    private val cache = object : LinkedHashMap<String, CachedNlu>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CachedNlu>): Boolean =
            size > maxCacheEntries
    }

    /** Wall-clock timestamps of resolver attempts within the last [WINDOW_MS]. */
    private val callWindow = ArrayDeque<Long>()

    /** Normalized transcripts whose resolution is currently in flight. */
    private val inFlight = HashSet<String>()

    /**
     * The most recent confident NLU intent cached for [transcript], or null when
     * there is no fresh positive entry. Used as the last fallback after the regex
     * hint and phonetic net both miss.
     */
    fun cachedIntent(transcript: String, nowMs: Long = System.currentTimeMillis()): FastIntentMatch? =
        synchronized(lock) {
            val key = normalize(transcript) ?: return null
            val entry = cache[key] ?: return null
            if (nowMs - entry.atMs > cacheTtlMs) {
                cache.remove(key)
                return null
            }
            entry.match
        }

    /**
     * Reserve a slot to resolve [transcript] asynchronously. Returns the cache key
     * to pass back to [completeResolve], or null when the call should be skipped
     * because the transcript is out of bounds, already resolved (fresh cache
     * entry), already in flight, or the per-minute budget is exhausted.
     */
    fun beginResolve(transcript: String, nowMs: Long = System.currentTimeMillis()): String? =
        synchronized(lock) {
            val key = normalize(transcript) ?: return null
            if (key in inFlight) return null

            val entry = cache[key]
            if (entry != null && nowMs - entry.atMs <= cacheTtlMs) {
                // Already resolved recently (hit or confident miss) — don't re-run.
                return null
            }

            pruneWindow(nowMs)
            if (callWindow.size >= maxCallsPerMinute) return null

            callWindow.addLast(nowMs)
            inFlight.add(key)
            key
        }

    /**
     * Record the outcome of a resolution started via [beginResolve]. A non-null
     * [match] becomes the cached correction for the next identical turn; a null
     * [match] is cached as a confident "no intent" so the same utterance is not
     * re-resolved until the entry expires.
     */
    fun completeResolve(
        key: String,
        match: FastIntentMatch?,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        synchronized(lock) {
            inFlight.remove(key)
            cache[key] = CachedNlu(match, nowMs)
        }
    }

    /**
     * Release an in-flight slot started via [beginResolve] without caching an
     * outcome (the resolver errored or was cancelled), so the transcript can be
     * retried later within budget instead of being stuck in flight forever.
     */
    fun abortResolve(key: String) {
        synchronized(lock) {
            inFlight.remove(key)
        }
    }

    private fun pruneWindow(nowMs: Long) {
        val windowStart = nowMs - WINDOW_MS
        while (callWindow.isNotEmpty() && callWindow.first() < windowStart) {
            callWindow.removeFirst()
        }
    }

    private fun normalize(transcript: String): String? {
        val trimmed = transcript.trim()
        if (trimmed.isEmpty()) return null
        val codePoints = trimmed.codePointCount(0, trimmed.length)
        if (codePoints < minTranscriptChars || codePoints > maxTranscriptChars) return null
        return trimmed
    }

    private data class CachedNlu(val match: FastIntentMatch?, val atMs: Long)

    companion object {
        const val DEFAULT_MAX_CACHE_ENTRIES = 64
        const val DEFAULT_MAX_CALLS_PER_MINUTE = 10
        const val DEFAULT_CACHE_TTL_MS = 5 * 60_000L
        const val DEFAULT_MIN_TRANSCRIPT_CHARS = 2
        const val DEFAULT_MAX_TRANSCRIPT_CHARS = 60
        private const val WINDOW_MS = 60_000L
    }
}

/**
 * Promote an [LiveNluResolution] to a [FastIntentMatch] hint, or null when the
 * model declined (blank intent) or asked for clarification. Kept separate so the
 * ViewModel never caches a low-confidence/ambiguous reading as a hard intent.
 */
internal fun LiveNluResolution.toFastIntentMatch(): FastIntentMatch? {
    val name = intent?.trim().orEmpty()
    if (name.isEmpty() || needsClarification) return null
    return FastIntentMatch(name, confidence)
}
