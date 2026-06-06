package com.firstaid.copilot.live

import android.content.Context
import org.json.JSONObject

/**
 * On-device twin of the desktop phonetic safety net (src/voice/phoneticIntent.js).
 *
 * The regex hint router ([inferLiveFastIntent]) enumerates a few homophones by
 * hand, so a rare mishearing such as "除颤仪" -> "出差移" yields no hint and the
 * client posts the raw text only. This router is the same conservative net: it
 * converts the transcript and a tiny closed set of canonical keywords into
 * toneless pinyin syllables (声母+韵母, 忽略声调) and runs a restricted
 * (fuzzy-substring) edit distance, returning one of the critical closed-set
 * intents (AED, stop, call, CPR-quality, etc.) only.
 *
 * It is wired into [LiveSessionViewModel.submitLiveText] as a fallback that runs
 * ONLY when the regex hint misses AND the medical stage is CPR-live (S6-S8). It
 * never fabricates observation facts and never overrides a confident regex hint.
 * The word table and thresholds are loaded from the SAME asset the desktop reads
 * (knowledge/phonetic_intents.json, copied to assets/phonetic_intents.json) so
 * the two implementations cannot drift.
 */
object LivePhoneticIntentRouter {
    private const val ASSET_NAME = "phonetic_intents.json"

    @Volatile
    private var cached: PhoneticIntentConfig? = null

    /**
     * Best-effort: load and cache the shared word table from assets. Safe to call
     * repeatedly (e.g. from the Live screen at startup). A missing/invalid asset
     * leaves the router disabled (infer returns null) so the regex path is never
     * made less safe.
     */
    fun warm(context: Context) {
        if (cached != null) return
        cached = runCatching {
            context.applicationContext.assets.open(ASSET_NAME).use { stream ->
                parsePhoneticIntentConfig(stream.readBytes().toString(Charsets.UTF_8))
            }
        }.getOrNull()
    }

    /**
     * Resolve a critical closed-set intent from a (possibly misheard) transcript.
     * Returns null when no config is loaded, the stage is not CPR-live, or nothing
     * clears the conservative thresholds.
     */
    fun infer(
        transcript: String?,
        stage: String?,
        config: PhoneticIntentConfig? = cached,
    ): FastIntentMatch? {
        val cfg = config ?: return null
        if (stage != null && cfg.stages.isNotEmpty() && stage !in cfg.stages) return null
        val text = transcript?.trim().orEmpty()
        if (text.isBlank()) return null

        val textSyllables = toSyllables(text, cfg.pinyin)
        if (textSyllables.isEmpty()) return null

        var best: FastIntentMatch? = null
        for (rule in cfg.intents) {
            val keywordCost = bestPhraseCost(rule.keywords, textSyllables, cfg)
            if (keywordCost == null || keywordCost > cfg.params.maxKeywordCost) continue

            if (rule.requireTrigger) {
                val triggerCost = bestPhraseCost(rule.triggers, textSyllables, cfg)
                if (triggerCost == null || triggerCost > cfg.params.maxTriggerCost) continue
            }

            val score = (1.0 - keywordCost).coerceIn(0.0, 1.0)
            if (score < cfg.params.minScore) continue
            if (best == null || score > best.confidence) {
                best = FastIntentMatch(rule.intent, score)
            }
        }
        return best
    }

    private fun bestPhraseCost(
        phrases: List<String>,
        textSyllables: List<String>,
        cfg: PhoneticIntentConfig,
    ): Double? {
        var best: Double? = null
        for (phrase in phrases) {
            val syllables = toSyllables(phrase, cfg.pinyin)
            if (syllables.size < cfg.params.minKeywordSyllables) continue
            val cost = fuzzySubstringCost(syllables, textSyllables, cfg)
            if (best == null || cost < best) best = cost
        }
        return best
    }

    // Minimum normalized edit distance of `pattern` against any contiguous run of
    // `text` (approximate substring search). Substitution uses the phonetic
    // syllable cost; a syllable above maxSyllableCost is treated as a full
    // mismatch (cost 1) so a shared prefix cannot carry a match.
    private fun fuzzySubstringCost(
        pattern: List<String>,
        text: List<String>,
        cfg: PhoneticIntentConfig,
    ): Double {
        val n = pattern.size
        val m = text.size
        if (n == 0 || m == 0) return 1.0

        var prev = DoubleArray(m + 1) { 0.0 } // row 0: match may start anywhere for free
        for (i in 1..n) {
            val cur = DoubleArray(m + 1)
            cur[0] = i.toDouble()
            for (j in 1..m) {
                val rawCost = syllableCost(pattern[i - 1], text[j - 1], cfg)
                val subCost = if (rawCost > cfg.params.maxSyllableCost) 1.0 else rawCost
                val substitute = prev[j - 1] + subCost
                val deletePattern = prev[j] + 1.0
                val skipText = cur[j - 1] + 1.0
                cur[j] = minOf(substitute, deletePattern, skipText)
            }
            prev = cur
        }

        var best = Double.MAX_VALUE
        for (j in 0..m) if (prev[j] < best) best = prev[j]
        return best / n
    }

    private fun syllableCost(a: String, b: String, cfg: PhoneticIntentConfig): Double {
        if (a == b) return 0.0
        if (!isPinyin(a) || !isPinyin(b)) return 1.0

        val (initialA, finalA) = splitPinyin(a)
        val (initialB, finalB) = splitPinyin(b)
        val initialSame = initialA == initialB
        val finalSame = finalA == finalB
        if (initialSame && finalSame) return 0.0

        val initialCost = if (initialSame) 0.0 else segmentDistance(initialA, initialB, cfg.confusableInitials)
        val finalCost = if (finalSame) 0.0 else segmentDistance(finalA, finalB, cfg.confusableFinals)
        return (cfg.params.initialWeight * initialCost + cfg.params.finalWeight * finalCost).coerceIn(0.0, 1.0)
    }

    private fun segmentDistance(a: String, b: String, confusable: Set<String>): Double {
        if (a == b) return 0.0
        val key = if (a < b) "$a\u0000$b" else "$b\u0000$a"
        if (key in confusable) return 0.5
        return normalizedLevenshtein(a, b)
    }

    private fun splitPinyin(syllable: String): Pair<String, String> {
        for (initial in INITIALS_2) {
            if (syllable.startsWith(initial)) {
                return initial to syllable.substring(initial.length)
            }
        }
        if (syllable.isNotEmpty() && syllable[0] in INITIALS_1) {
            return syllable.substring(0, 1) to syllable.substring(1)
        }
        return "" to syllable
    }

    private fun toSyllables(text: String, pinyin: Map<String, String>): List<String> {
        val out = ArrayList<String>(text.length)
        for (ch in text) {
            if (ch.isWhitespace()) continue
            val mapped = pinyin[ch.toString()]
            when {
                mapped != null -> out.add(mapped)
                ch in 'a'..'z' || ch in 'A'..'Z' -> out.add(ch.lowercaseChar().toString())
                ch.code in 0x4e00..0x9fff -> out.add(ch.toString())
                // digits / punctuation dropped
            }
        }
        return out
    }

    private fun isPinyin(token: String): Boolean = token.isNotEmpty() && token.all { it in 'a'..'z' }

    private fun normalizedLevenshtein(a: String, b: String): Double {
        val longest = maxOf(a.length, b.length)
        if (longest == 0) return 0.0
        return levenshtein(a, b).toDouble() / longest
    }

    private fun levenshtein(a: String, b: String): Int {
        val m = a.length
        val n = b.length
        if (m == 0) return n
        if (n == 0) return m
        var prev = IntArray(n + 1) { it }
        for (i in 1..m) {
            val cur = IntArray(n + 1)
            cur[0] = i
            for (j in 1..n) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            }
            prev = cur
        }
        return prev[n]
    }

    private val INITIALS_2 = listOf("zh", "ch", "sh")
    private val INITIALS_1 = "bpmfdtnlgkhjqxrzcsyw".toSet()
}

data class PhoneticMatchParams(
    val maxKeywordCost: Double = 0.2,
    val maxTriggerCost: Double = 0.34,
    val minScore: Double = 0.7,
    val minKeywordSyllables: Int = 2,
    val maxSyllableCost: Double = 0.5,
    val initialWeight: Double = 0.4,
    val finalWeight: Double = 0.6,
)

data class PhoneticIntentRule(
    val intent: String,
    val requireTrigger: Boolean,
    val keywords: List<String>,
    val triggers: List<String>,
)

data class PhoneticIntentConfig(
    val stages: Set<String>,
    val params: PhoneticMatchParams,
    val confusableInitials: Set<String>,
    val confusableFinals: Set<String>,
    val pinyin: Map<String, String>,
    val intents: List<PhoneticIntentRule>,
)

/**
 * Parse the shared phonetic word table. Returns null for malformed input or when
 * no usable intent survives, so callers can disable the net safely.
 */
fun parsePhoneticIntentConfig(json: String): PhoneticIntentConfig? {
    val root = runCatching { JSONObject(json) }.getOrNull() ?: return null

    val stages = root.optJSONArray("stages").toStringList().toSet()

    val matchObj = root.optJSONObject("match") ?: JSONObject()
    val defaults = PhoneticMatchParams()
    val params = PhoneticMatchParams(
        maxKeywordCost = positiveOr(matchObj.optDouble("max_keyword_cost"), defaults.maxKeywordCost),
        maxTriggerCost = positiveOr(matchObj.optDouble("max_trigger_cost"), defaults.maxTriggerCost),
        minScore = positiveOr(matchObj.optDouble("min_score"), defaults.minScore),
        minKeywordSyllables = positiveIntOr(matchObj.optInt("min_keyword_syllables", -1), defaults.minKeywordSyllables),
        maxSyllableCost = positiveOr(matchObj.optDouble("max_syllable_cost"), defaults.maxSyllableCost),
        initialWeight = positiveOr(matchObj.optDouble("initial_weight"), defaults.initialWeight),
        finalWeight = positiveOr(matchObj.optDouble("final_weight"), defaults.finalWeight),
    )

    val pinyin = HashMap<String, String>()
    root.optJSONObject("pinyin")?.let { obj ->
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = obj.optString(key, "")
            if (key.isNotEmpty() && value.isNotEmpty()) pinyin[key] = value
        }
    }

    val intents = ArrayList<PhoneticIntentRule>()
    root.optJSONArray("intents")?.let { array ->
        for (index in 0 until array.length()) {
            val obj = array.optJSONObject(index) ?: continue
            val intent = obj.optString("intent")
            if (intent.isBlank()) continue
            val keywords = obj.optJSONArray("keywords").toStringList()
            if (keywords.isEmpty()) continue
            intents.add(
                PhoneticIntentRule(
                    intent = intent,
                    requireTrigger = obj.optBoolean("require_trigger", false),
                    keywords = keywords,
                    triggers = obj.optJSONArray("triggers").toStringList(),
                ),
            )
        }
    }
    if (intents.isEmpty()) return null

    return PhoneticIntentConfig(
        stages = stages,
        params = params,
        confusableInitials = parseConfusable(matchObj.optJSONArray("confusable_initials")),
        confusableFinals = parseConfusable(matchObj.optJSONArray("confusable_finals")),
        pinyin = pinyin,
        intents = intents,
    )
}

private fun parseConfusable(array: org.json.JSONArray?): Set<String> {
    val set = HashSet<String>()
    if (array == null) return set
    for (index in 0 until array.length()) {
        val pair = array.optJSONArray(index) ?: continue
        if (pair.length() != 2) continue
        val a = pair.optString(0).trim()
        val b = pair.optString(1).trim()
        if (a.isEmpty() || b.isEmpty() || a == b) continue
        set.add(if (a < b) "$a\u0000$b" else "$b\u0000$a")
    }
    return set
}

private fun org.json.JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    val out = ArrayList<String>(length())
    for (index in 0 until length()) {
        val value = optString(index, "").trim()
        if (value.isNotEmpty()) out.add(value)
    }
    return out
}

private fun positiveOr(value: Double, fallback: Double): Double =
    if (value.isFinite() && value > 0.0) value else fallback

private fun positiveIntOr(value: Int, fallback: Int): Int = if (value > 0) value else fallback
