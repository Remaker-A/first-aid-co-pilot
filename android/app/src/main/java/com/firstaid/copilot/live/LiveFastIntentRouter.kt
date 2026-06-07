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
    if (isResponseCheckQuestionTranscript(text)) return null
    val match = FAST_INTENT_RULES.firstOrNull { it.pattern.containsMatchIn(text) } ?: return null
    if (match.intent == "paramedics_arrived" && isParamedicsArrivalNegatedOrHypothetical(text)) {
        return null
    }
    return FastIntentMatch(match.intent, match.confidence)
}

internal fun resolvePrimaryButtonIntent(actionOrIntent: String?): String? {
    val value = actionOrIntent?.trim()?.takeIf { it.isNotBlank() } ?: return null
    return when (value) {
        "mark_scene_safe" -> "scene_safe"
        "mark_scene_unsafe" -> "scene_unsafe"
        "mark_unresponsive" -> "patient_unresponsive"
        "mark_responsive" -> "patient_responsive"
        "mark_no_normal_breathing" -> "no_normal_breathing"
        "mark_normal_breathing" -> "normal_breathing"
        "mark_emergency_called" -> "emergency_called"
        "mark_cpr_ready" -> "continue_cpr"
        "mark_aed_available" -> "aed_available"
        "mark_paramedics_arrived" -> "paramedics_arrived"
        else -> value
    }
}

internal fun isResponseCheckQuestionTranscript(transcript: String?): Boolean {
    val text = transcript?.trim().orEmpty()
    if (text.isBlank()) return false
    val compact = text.replace(Regex("\\s+"), "")
    if (CLEAN_RESPONSE_CHECK_QUESTION_PATTERN.containsMatchIn(compact)) return true
    return RESPONSE_CHECK_QUESTION_PATTERN.containsMatchIn(text)
}

private data class FastIntentRule(
    val intent: String,
    val pattern: Regex,
    val confidence: Double = 0.86,
)

private val CLEAN_RESPONSE_CHECK_QUESTION_PATTERN = Regex(
    "(\\u6709\\u6ca1\\u6709\\u53cd\\u5e94|\\u662f\\u5426\\u6709\\u53cd\\u5e94|\\u6709\\u53cd\\u5e94(\\u5417|\\u4e48|\\u5462|\\u6ca1\\u6709)|\\u8fd8\\u6709\\u6ca1\\u6709\\u53cd\\u5e94|\\u6ca1(?:\\u6709)?\\u53cd\\u5e94(\\u5417|\\u4e48|\\u5462)|\\u65e0\\u53cd\\u5e94(\\u5417|\\u4e48|\\u5462))",
    RegexOption.IGNORE_CASE,
)

private val RESPONSE_CHECK_QUESTION_PATTERN = Regex(
    "(有\\s*没\\s*有\\s*反应|是否\\s*有\\s*反应|有\\s*反应\\s*(吗|么|嘛|没有)|还有\\s*没有\\s*反应|没(?:有)?\\s*反应\\s*(吗|么|嘛)|无\\s*反应\\s*(吗|么|嘛))",
    RegexOption.IGNORE_CASE,
)

private fun isParamedicsArrivalNegatedOrHypothetical(text: String): Boolean {
    val compact = text.lowercase().replace(Regex("\\s+"), "")
    if (!Regex("(120|\\u5e7a\\u4e8c\\u96f6|\\u4e00\\u4e8c\\u96f6|\\u6551[\\u62a4\\u8d27]\\u8f66|\\u6025\\u6551(?:\\u5458|\\u4eba\\u5458)?|\\u533b\\u62a4|\\u6551\\u63f4|ems|ambulance|paramedics)").containsMatchIn(compact)) {
        return false
    }
    return Regex("(\\u8fd8\\u6ca1|\\u8fd8\\u672a|\\u6ca1\\u6709|\\u6ca1|\\u672a|\\u5c1a\\u672a).{0,8}(\\u5230|\\u6765|\\u5230\\u8fbe)|(\\u5230|\\u6765|\\u5230\\u8fbe).{0,4}(\\u524d|\\u4e4b\\u524d|\\u4ee5\\u524d)|(\\u6765\\u7684?\\u8def\\u4e0a|\\u5728\\u8def\\u4e0a)|before|notyet|notarrived|hasn'?tarrived", RegexOption.IGNORE_CASE)
        .containsMatchIn(compact)
}

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
            "(scene\\s+safe|\\u73b0\\u573a.*\\u5b89\\u5168|\\u5468\\u56f4.*\\u5b89\\u5168|\\u73af\\u5883.*\\u5b89\\u5168|\\u786e\\u8ba4.*\\u5b89\\u5168|\\u5b89\\u5168\\u4e86|\\u53ef\\u4ee5.*\\u9760\\u8fd1|\\u6ca1\\u6709.*\\u5371\\u9669|\\u5728\\u60a3\\u8005(?:\\u8eab\\u8fb9|\\u8eab\\u65c1|\\u65c1\\u8fb9))",
            RegexOption.IGNORE_CASE,
        ),
    ),
    FastIntentRule(
        "patient_unresponsive",
        Regex("(unresponsive|no response|not responding|\\u6ca1\\u53cd\\u5e94|\\u6ca1\\u6709\\u53cd\\u5e94|\\u6ca1\\u6709\\u56de\\u5e94|\\u6ca1\\u56de\\u5e94|\\u53eb\\u4e0d\\u9192|\\u558a\\u4e0d\\u9192|\\u62cd\\u4e0d\\u9192|\\u65e0\\u53cd\\u5e94|\\u4e0d\\u9192)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "patient_responsive",
        Regex("(responsive|responding|\\u6709\\u53cd\\u5e94|\\u9192\\u4e86|\\u4f1a\\u56de\\u5e94)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "agonal_breathing",
        Regex("(gasping|agonal|\\u5598\\u606f|\\u6fd2\\u6b7b\\u547c\\u5438|\\u5076\\u5c14\\u5598|\\u53ea\\u662f?\\u5598|\\u70b9\\u5934\\u6837\\u547c\\u5438|\\u70b9\\u5934\\u4e00\\u6837\\u547c\\u5438|\\u5076\\u5c14\\u70b9\\u5934)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "no_normal_breathing",
        Regex("(not breathing|no breathing|abnormal breathing|\\u6ca1\\u6709\\u6b63\\u5e38\\u547c\\u5438|\\u6ca1\\s*\\u6709\\s*\\u6b63\\u5e38\\u547c\\u5438|\\u65e0\\s*\\u6b63\\u5e38\\u547c\\u5438|\\u6ca1\\u6709\\u547c\\u5438|\\u6ca1\\u547c\\u5438|\\u65e0\\u547c\\u5438|\\u6ca1\\u6c14|\\u6ca1\\u6709\\u6c14|\\u6ca1\\u5598\\u6c14|\\u80f8\\u53e3(?:\\u6ca1|\\u6ca1\\u6709|\\u4e0d)(?:\\u52a8|\\u8d77\\u4f0f)|\\u770b\\u4e0d\\u5230(?:\\u80f8\\u53e3)?\\u8d77\\u4f0f|\\u547c\\u5438\\u4e0d\\u6b63\\u5e38|\\u4e0d\\u6b63\\u5e38\\u547c\\u5438)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "normal_breathing",
        Regex("(normal breathing|breathing normally|\\u6b63\\u5e38\\u547c\\u5438|\\u6709\\u6b63\\u5e38\\u547c\\u5438)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "aed_available",
        Regex("(aed|a\\s*e\\s*d|\\u9664\\u98a4\\u4eea|\\u9664\\u98a4\\u5668|\\u81ea\\u52a8\\u4f53\\u5916\\u9664\\u98a4(?:\\u4eea|\\u5668)?|\\u7535\\u51fb\\u5668).*?(\\u6765\\u4e86|\\u5230\\u4e86|\\u5230\\u8fbe|\\u62ff\\u6765|\\u62ff\\u6765\\u4e86|\\u53d6\\u6765|\\u53d6\\u6765\\u4e86|\\u9001\\u6765|\\u9001\\u6765\\u4e86)|(?:\\u6765\\u4e86|\\u5230\\u4e86|\\u62ff\\u6765\\u4e86|\\u53d6\\u6765\\u4e86|\\u9001\\u6765\\u4e86).*?(aed|a\\s*e\\s*d|\\u9664\\u98a4\\u4eea|\\u9664\\u98a4\\u5668|\\u81ea\\u52a8\\u4f53\\u5916\\u9664\\u98a4(?:\\u4eea|\\u5668)?|\\u7535\\u51fb\\u5668)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_aed_cpr_alternation",
        Regex("(?:(?:aed|a\\s*e\\s*d|\\u9664\\u98a4\\u4eea|\\u9664\\u98a4\\u5668|\\u81ea\\u52a8\\u4f53\\u5916\\u9664\\u98a4(?:\\u4eea|\\u5668)?|\\u7535\\u51fb\\u5668).*?(?:\\u6309\\u538b|CPR|\\u5fc3\\u80ba\\u590d\\u82cf).*?(?:\\u4ea4\\u66ff|\\u8f6e\\u6362|\\u914d\\u5408|\\u600e\\u4e48\\u4ea4\\u66ff|\\u600e\\u4e48\\u914d\\u5408)|(?:\\u6309\\u538b|CPR|\\u5fc3\\u80ba\\u590d\\u82cf).*?(?:aed|a\\s*e\\s*d|\\u9664\\u98a4\\u4eea|\\u9664\\u98a4\\u5668|\\u81ea\\u52a8\\u4f53\\u5916\\u9664\\u98a4(?:\\u4eea|\\u5668)?|\\u7535\\u51fb\\u5668).*?(?:\\u4ea4\\u66ff|\\u8f6e\\u6362|\\u914d\\u5408|\\u600e\\u4e48\\u4ea4\\u66ff|\\u600e\\u4e48\\u914d\\u5408))", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_aed_help",
        Regex("(aed|a\\s*e\\s*d|\\u9664\\u98a4\\u4eea|\\u9664\\u98a4\\u5668|\\u81ea\\u52a8\\u4f53\\u5916\\u9664\\u98a4(?:\\u4eea|\\u5668)?|\\u7535\\u51fb\\u5668).*?(\\u600e\\u4e48\\u529e|\\u600e\\u4e48\\u7528|\\u8981\\u600e\\u4e48\\u505a|\\u600e\\u4e48\\u505a|\\u5728\\u54ea|\\u5728\\u54ea\\u91cc|\\u8d34\\u54ea|\\u600e\\u4e48\\u8d34|\\u600e\\u4e48\\u6253\\u5f00)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_can_stop",
        Regex("(\\u80fd\\u4e0d\\u80fd\\u505c|\\u80fd\\u4e0d\\u80fd\\u542c|\\u53ef\\u4e0d\\u53ef\\u4ee5\\u505c|\\u53ef\\u4ee5\\u505c|\\u80fd\\u505c|\\u8981\\u4e0d\\u8981\\u505c|\\u662f\\u4e0d\\u662f.*\\u505c|\\u8fd8\\u8981(?:\\u518d|\\u7ee7\\u7eed)?\\u6309(?:\\u5417|\\u591a\\u4e45)?|\\u8fd8\\u8981\\u6309\\u591a\\u4e45|\\u6309\\u5230\\u4ec0\\u4e48\\u65f6\\u5019|\\u4e00\\u76f4(?:\\u8fd9\\u6837|\\u8fd9\\u4e48)?\\u6309(?:\\u5417|\\u4e0b\\u53bb)?|\\u8981\\u4e00\\u76f4\\u6309|\\u5c31\\u8fd9\\u6837\\u4e00\\u76f4\\u6309|\\u4e00\\u76f4\\u6309\\u5230\\u4ec0\\u4e48\\u65f6\\u5019|\\u4e00\\u76f4\\u6309\\u591a\\u4e45)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_cpr_quality",
        Regex("(\\u6309\\u5f97\\u5bf9|\\u6309\\u7684\\u5bf9|\\u8fd9\\u6837.*(?:\\u53ef\\u4ee5|\\u5bf9\\u5417|\\u884c\\u5417)|\\u6211.*\\u6309.*(?:\\u5bf9\\u5417|\\u53ef\\u4ee5\\u5417|\\u884c\\u5417)|\\u6211\\u7231\\u7684\\u5bf9\\u5417|\\u6211\\u7231\\u4f60\\u7684\\u5bf9\\u5417|\\u4f4d\\u7f6e.*\\u5bf9\\u5417|\\u8282\\u594f.*\\u5bf9\\u5417|\\u8d28\\u91cf.*\\u600e\\u4e48\\u6837)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "ask_next_step",
        Regex("(\\u4e0b\\u4e00\\u6b65|\\u63a5\\u4e0b\\u6765|\\u73b0\\u5728\\u600e\\u4e48\\u529e|\\u73b0\\u5728\\u505a\\u4ec0\\u4e48|\\u7136\\u540e\\u5462)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "emergency_called",
        Regex("(called|call connected|(?:120|\\u5e7a\\u4e8c\\u96f6|\\u4e00\\u4e8c\\u96f6).*(\\u5df2\\u6253|\\u6253\\u4e86|\\u62e8\\u6253|\\u5df2\\u62e8|\\u63a5\\u901a)|(?:\\u5df2|\\u5df2\\u7ecf)?(?:\\u62e8\\u6253|\\u62e8\\u901a|\\u6253\\u4e86?|\\u547c\\u53eb)\\s*(?:120|\\u5e7a\\u4e8c\\u96f6|\\u4e00\\u4e8c\\u96f6))", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "continue_cpr",
        Regex("(continue cpr|start cpr|keep pressing|\\u51c6\\u5907\\u597d\\u4e86?|\\u51c6\\u5907\\u5c31\\u7eea|\\u51c6\\u5907\\u597d\\u4e86.*\\u5f00\\u59cb|\\u6211\\u597d\\u4e86|\\u6211\\u4eec\\u597d\\u4e86|\\u53ef\\u4ee5\\u5f00\\u59cb|\\u53ef\\u4ee5\\u6309|\\u6765\\u5427|\\u5f00\\u59cb\\u5427|\\u5f00\\u59cb\\u538b|\\u5f00\\u59cb\\u6309|\\u73b0\\u5728\\u5f00\\u59cb|\\u9a6c\\u4e0a\\u5f00\\u59cb|\\u8fd9\\u5c31\\u5f00\\u59cb|\\u5f00\\u59cb\\u80f8\\u5916\\u6309\\u538b|\\u5f00\\u59cb CPR|\\u5f00\\u59cb\\u5fc3\\u80ba\\u590d\\u82cf|\\u7ee7\\u7eed\\u6309|\\u7ee7\\u7eed\\u80f8\\u5916\\u6309\\u538b|\\u7ee7\\u7eed CPR|\\u7ee7\\u7eed\\u5fc3\\u80ba\\u590d\\u82cf|\\u600e\\u4e48\\u6309\\u538b|\\u5982\\u4f55\\u6309\\u538b|\\u6309\\u538b\\u600e\\u4e48\\u505a|\\u600e\\u4e48\\u5f00\\u59cb\\u6309\\u538b|\\u6211\\u6765\\u6309\\u538b|\\u6211\\u73b0\\u5728\\u6309\\u538b)", RegexOption.IGNORE_CASE),
    ),
    FastIntentRule(
        "paramedics_arrived",
        Regex("(paramedics|ems arrived|ambulance arrived|(?:120|\\u5e7a\\u4e8c\\u96f6|\\u4e00\\u4e8c\\u96f6).*(\\u5230|\\u6765|\\u5230\\u4e86|\\u6765\\u4e86)|\\u6025\\u6551\\u5458.*(\\u5230|\\u6765)|\\u6025\\u6551\\u4eba\\u5458.*(\\u5230|\\u6765)|\\u6551\\u62a4\\u8f66.*(\\u5230|\\u6765)|\\u533b\\u751f.*(\\u5230|\\u6765)|\\u533b\\u62a4.*(\\u5230|\\u6765|\\u8d76\\u5230)|\\u6551\\u63f4.*(\\u5230|\\u6765))", RegexOption.IGNORE_CASE),
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
