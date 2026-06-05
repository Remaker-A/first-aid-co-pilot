package com.firstaid.copilot.live

data class FastIntentMatch(
    val intent: String,
    val confidence: Double,
)

/**
 * Tiny local intent hint for the live hot path. It never creates guidance or
 * advances medical stages; the server-side rule/state-machine still decides.
 */
internal fun inferLiveFastIntent(transcript: String?): FastIntentMatch? {
    val text = transcript?.trim().orEmpty()
    if (text.isBlank()) return null
    return FAST_INTENT_RULES.firstOrNull { it.pattern.containsMatchIn(text) }
        ?.let { FastIntentMatch(it.intent, it.confidence) }
}

private data class FastIntentRule(
    val intent: String,
    val pattern: Regex,
    val confidence: Double = 0.86,
)

private val FAST_INTENT_RULES = listOf(
    FastIntentRule(
        "scene_unsafe",
        Regex(
            "(unsafe|danger|\\u4e0d\\u5b89\\u5168|\\u5371\\u9669|\\u4e0d\\u80fd\\u9760\\u8fd1|\\u4e0d\\u8981\\u9760\\u8fd1|\\u522b\\u9760\\u8fd1)",
            RegexOption.IGNORE_CASE,
        ),
    ),
    FastIntentRule(
        "scene_safe",
        Regex(
            "(scene\\s+safe|\\u73b0\\u573a.*\\u5b89\\u5168|\\u5468\\u56f4.*\\u5b89\\u5168|\\u73af\\u5883.*\\u5b89\\u5168|\\u786e\\u8ba4.*\\u5b89\\u5168|\\u5b89\\u5168\\u4e86|\\u53ef\\u4ee5.*\\u9760\\u8fd1|\\u6ca1\\u6709.*\\u5371\\u9669)",
            RegexOption.IGNORE_CASE,
        ),
    ),
    FastIntentRule(
        "patient_unresponsive",
        Regex("(unresponsive|no response|not responding|\\u6ca1\\u53cd\\u5e94|\\u6ca1\\u6709\\u53cd\\u5e94|\\u53eb\\u4e0d\\u9192|\\u65e0\\u53cd\\u5e94)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "patient_responsive",
        Regex("(responsive|responding|\\u6709\\u53cd\\u5e94|\\u9192\\u4e86|\\u4f1a\\u56de\\u5e94)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "agonal_breathing",
        Regex("(gasping|agonal|\\u5598\\u606f|\\u6fd2\\u6b7b\\u547c\\u5438|\\u5076\\u5c14\\u5598|\\u53ea\\u662f?\\u5598)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "no_normal_breathing",
        Regex("(not breathing|no breathing|abnormal breathing|\\u6ca1\\u6709\\u6b63\\u5e38\\u547c\\u5438|\\u6ca1\\u6709\\u547c\\u5438|\\u6ca1\\u547c\\u5438|\\u65e0\\u547c\\u5438|\\u547c\\u5438\\u4e0d\\u6b63\\u5e38|\\u4e0d\\u6b63\\u5e38\\u547c\\u5438)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "normal_breathing",
        Regex("(normal breathing|breathing normally|\\u6b63\\u5e38\\u547c\\u5438|\\u6709\\u6b63\\u5e38\\u547c\\u5438)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_aed_help",
        Regex("(aed|a e d|\\u9664\\u98a4\\u4eea|\\u7535\\u51fb).*?(\\u6765\\u4e86|\\u5230\\u4e86|\\u600e\\u4e48\\u529e|\\u600e\\u4e48\\u7528)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_can_stop",
        Regex("(\\u80fd\\u4e0d\\u80fd\\u505c|\\u53ef\\u4ee5\\u505c|\\u80fd\\u505c|\\u8981\\u4e0d\\u8981\\u505c|\\u8fd8\\u8981\\u6309\\u591a\\u4e45)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_next_step",
        Regex("(\\u4e0b\\u4e00\\u6b65|\\u63a5\\u4e0b\\u6765|\\u73b0\\u5728\\u600e\\u4e48\\u529e|\\u73b0\\u5728\\u505a\\u4ec0\\u4e48|\\u7136\\u540e\\u5462)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "emergency_called",
        Regex("(called|call connected|120.*(\\u5df2\\u6253|\\u6253\\u4e86|\\u62e8\\u6253|\\u5df2\\u62e8|\\u63a5\\u901a)|(?:\\u5df2|\\u5df2\\u7ecf)?(?:\\u62e8\\u6253|\\u62e8\\u901a|\\u6253\\u4e86?|\\u547c\\u53eb)120)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "continue_cpr",
        Regex("(continue cpr|start cpr|keep pressing|\\u5f00\\u59cb\\u6309|\\u5f00\\u59cb CPR|\\u5f00\\u59cb\\u5fc3\\u80ba\\u590d\\u82cf|\\u7ee7\\u7eed\\u6309|\\u7ee7\\u7eed CPR|\\u7ee7\\u7eed\\u5fc3\\u80ba\\u590d\\u82cf)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "paramedics_arrived",
        Regex("(paramedics|ems arrived|ambulance arrived|\\u6025\\u6551\\u5458.*(\\u5230|\\u6765)|\\u6025\\u6551\\u4eba\\u5458.*(\\u5230|\\u6765)|\\u6551\\u62a4\\u8f66.*(\\u5230|\\u6765)|\\u533b\\u751f.*(\\u5230|\\u6765))", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "compressions_reported",
        Regex("(\\u6309\\u4e86\\s*\\d+\\s*[\\u6b21\\u4e0b]?|\\u538b\\u4e86\\s*\\d+\\s*[\\u6b21\\u4e0b]?|\\u5df2\\u7ecf\\u5728\\u6309|\\u5728\\u6309\\u4e86|\\u6309\\u5b8c\\u4e86|\\u538b\\u5b8c\\u4e86)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "step_done",
        Regex("(\\u653e\\u597d\\u4e86|\\u6446\\u597d\\u4e86|\\u505a\\u597d\\u4e86|\\u5f04\\u597d\\u4e86|\\u660e\\u767d\\u4e86?|\\u61c2\\u4e86|\\u77e5\\u9053\\u4e86|\\u53ef\\u4ee5\\u4e86|\\u5b8c\\u6210\\u4e86|(?<!\\u51c6\\u5907)\\u597d\\u4e86)", RegexOption.IGNORE_CASE),
    ),
)
