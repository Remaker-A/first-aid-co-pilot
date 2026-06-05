// TTS text normalization.
//
// Why this exists: the sherpa-onnx VITS Chinese voice drops its pitch by almost
// an octave (F0 ~80–90Hz vs ~200Hz for words) whenever it speaks Arabic digits,
// and reads decimals (e.g. GPS coordinates) digit-by-digit for many seconds.
// That is the "时不时降调 / 降速" the user hears. Measured fix: rewrite digits to
// Chinese reading words BEFORE synthesis (emergency phone numbers per-digit,
// everything else as cardinals; decimals defensively as "整数点逐位"). UI text,
// logs and TTS substring assertions keep the original "120 / 100 到 120" because
// this runs only at the synthesis entry points, not on the action payloads.

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
// Phone digits use 幺 for 1 (the standard Chinese way to read phone numbers).
// Measured bonus: on this VITS voice 幺二零 keeps F0 ~13Hz higher than 一二零,
// which reads almost as low as the Arabic form.
const PHONE_DIGITS = ["零", "幺", "二", "三", "四", "五", "六", "七", "八", "九"];
const SMALL_UNITS = ["", "十", "百", "千"];
const BIG_UNITS = ["", "万", "亿", "兆"];

// Numbers that should be read digit-by-digit when dialed/announced as a phone
// number (一二零 instead of 一百二十). Kept narrow so quantities like "120 次"
// are never affected.
const EMERGENCY_NUMBERS = ["120", "110", "119", "112", "122", "999", "911"];
const EMERGENCY_ALT = EMERGENCY_NUMBERS.join("|");
const DIAL_VERBS = "拨打|拨通|呼叫|接通|拨|打";
const CALL_STATUS_LOOKAHEAD = "已|在|呼叫|拨通|接通|急救|电话|中";

export function normalizeForTts(text) {
  let value = typeof text === "string" ? text : "";
  if (!value || !/\d/.test(value)) {
    return value;
  }

  // 1) Emergency phone number in a dialing context -> per-digit (拨打 120 -> 拨打幺二零).
  value = value.replace(
    new RegExp(`(${DIAL_VERBS})(\\s*)(${EMERGENCY_ALT})`, "g"),
    (_match, verb, gap, num) => `${verb}${gap}${phoneDigitsSpoken(num)}`
  );

  // 2) Emergency phone number immediately announced as a call -> per-digit
  //    (120 已经在呼叫中 -> 幺二零 已经在呼叫中).
  value = value.replace(
    new RegExp(`(${EMERGENCY_ALT})(?=\\s*(?:${CALL_STATUS_LOOKAHEAD}))`, "g"),
    (num) => phoneDigitsSpoken(num)
  );

  // 3) Decimals (coordinates etc.) -> "整数点逐位". Coordinates are normally not
  //    spoken at all, but if any decimal reaches TTS this avoids a 5s digit crawl
  //    sounding like slow-motion.
  value = value.replace(
    /(\d+)\.(\d+)/g,
    (_match, intPart, fracPart) => `${integerToChinese(intPart)}点${digitsSpoken(fracPart)}`
  );

  // 4) Long digit runs (callback phone numbers, ids) -> per-digit, so an 11-digit
  //    number is not read as "一百三十八亿…". Quantities in the scripts are <=3
  //    digits, so this only catches real phone/id strings.
  value = value.replace(/\d{7,}/g, (num) => phoneDigitsSpoken(num));

  // 5) Remaining integers -> Chinese cardinals (100 -> 一百, 30 -> 三十, 5 -> 五).
  value = value.replace(/\d+/g, (num) => integerToChinese(num));

  return value;
}

// Canonical cache key for pre-synthesized / cached TTS audio.
//
// The key MUST be built from the post-`normalizeForTts` text (the digits are
// rewritten before synthesis, so "120" and "幺二零" must collapse to the same
// key) plus the prosody dimensions that change the rendered waveform (tone and
// speed). Whitespace is collapsed first so "继续 按压" and "继续按压" share audio.
// `normalizeForTts` is idempotent, so calling this on an already-normalized
// clause (the streaming path) yields the same key as calling it on the raw
// phrase (the whole-utterance path).
const TTS_CACHE_KEY_DELIMITER = "\u241f";

export function buildTtsCacheKey(text, options = {}) {
  const collapsed = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  const normalized = normalizeForTts(collapsed);
  const tone = typeof options.tone === "string" ? options.tone.trim() : "";
  const speed =
    options.speed === undefined || options.speed === null ? "" : String(options.speed).trim();
  return [normalized, tone, speed].join(TTS_CACHE_KEY_DELIMITER);
}

export function digitsSpoken(numStr) {
  return String(numStr)
    .replace(/\D/g, "")
    .split("")
    .map((ch) => CN_DIGITS[ch.charCodeAt(0) - 48])
    .join("");
}

export function phoneDigitsSpoken(numStr) {
  return String(numStr)
    .replace(/\D/g, "")
    .split("")
    .map((ch) => PHONE_DIGITS[ch.charCodeAt(0) - 48])
    .join("");
}

export function integerToChinese(numStr) {
  const digits = String(numStr).replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (digits === "" || digits === "0") {
    return "零";
  }

  const groups = [];
  let rest = digits;
  while (rest.length > 0) {
    groups.unshift(rest.slice(-4));
    rest = rest.slice(0, -4);
  }

  let out = "";
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const bigUnit = BIG_UNITS[groups.length - 1 - i];
    const part = fourDigitsToChinese(group);

    if (part === "") {
      // All-zero group: keep a single 零 separator between non-empty groups.
      if (out && !out.endsWith("零") && i < groups.length - 1) {
        out += "零";
      }
      continue;
    }

    // Leading zero inside a non-first group needs a spoken 零 (e.g. 100_0005).
    if (out && group.length === 4 && group[0] === "0" && !out.endsWith("零")) {
      out += "零";
    }
    out += part + bigUnit;
  }

  // 一十 -> 十 (10 -> 十, 11 -> 十一) only at the very start.
  out = out.replace(/^一十/, "十");
  return out || "零";
}

function fourDigitsToChinese(groupStr) {
  const length = groupStr.length;
  let out = "";
  let pendingZero = false;

  for (let i = 0; i < length; i += 1) {
    const digit = groupStr.charCodeAt(i) - 48;
    const unit = length - 1 - i;
    if (digit === 0) {
      pendingZero = true;
      continue;
    }
    if (pendingZero && out) {
      out += "零";
    }
    pendingZero = false;
    out += CN_DIGITS[digit] + SMALL_UNITS[unit];
  }

  return out;
}
