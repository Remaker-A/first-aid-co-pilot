// Phonetic (音近) fuzzy intent matcher — a conservative safety net for CPR-live.
//
// Why this exists: the regex classifier (stt.js classifyIntent) enumerates a few
// homophones by hand for the closed-set critical questions. When SenseVoice
// mishears a rare variant that is NOT in that enumeration — e.g. "除颤仪" → "出差
// 移" ("移" is not in the regex's [一姨仪疑] set) — classifyIntent returns null and
// the turn slides into an open-question ack instead of the fixed AED safety answer.
//
// This module rescues exactly those misses: it converts the transcript and a tiny
// closed set of canonical keywords into toneless pinyin syllables (声母+韵母,
// 忽略声调) and runs a restricted (fuzzy-substring) edit distance. It only ever
// returns one of a few critical intents (AED, stop, call, CPR-quality, etc.) and
// is wired so it runs ONLY when the regex missed and we
// are in a CPR-live stage (see intentResolver.resolveUserIntent). It never
// fabricates observation facts (breathing/response) and never overrides a
// confident regex intent. Zero third-party dependencies: the pinyin table ships
// with knowledge/phonetic_intents.json and the same file is consumed on Android.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "knowledge", "phonetic_intents.json");

const DEFAULTS = Object.freeze({
  maxKeywordCost: 0.2,
  maxTriggerCost: 0.34,
  minScore: 0.7,
  minKeywordSyllables: 2,
  // A single keyword syllable costing more than this is treated as a genuine
  // mismatch (full cost 1), not a cheap substitution. This stops a long shared
  // prefix from carrying a match: "能不能救" must NOT resolve to "能不能停"
  // (停/ting vs 救/jiu are different syllables), while near-homophones such as
  // 颤/chan vs 差/chai (an↔ai) stay below the ceiling and still match.
  maxSyllableCost: 0.5,
  initialWeight: 0.4,
  finalWeight: 0.6,
});

// Two-letter initials must be tested before single-letter ones.
const INITIALS_2 = ["zh", "ch", "sh"];
const INITIALS_1 = new Set("bpmfdtnlgkhjqxrzcsyw".split(""));

let cachedConfig = null;

// Resolve (and cache) the shared phonetic config. Tests may inject a config via
// options.phoneticConfig to stay hermetic; a missing/invalid file disables the
// matcher entirely (returns null) so the regex path is never made less safe.
export function loadPhoneticIntentConfig(options = {}) {
  if (options.phoneticConfig) {
    return normalizeConfig(options.phoneticConfig);
  }
  if (cachedConfig !== null) {
    return cachedConfig || null;
  }
  try {
    const raw = readFileSync(options.phoneticConfigPath || DEFAULT_CONFIG_PATH, "utf8");
    cachedConfig = normalizeConfig(JSON.parse(raw));
  } catch {
    cachedConfig = false; // sentinel: tried and failed, don't retry every call
  }
  return cachedConfig || null;
}

export function reloadPhoneticIntentConfig() {
  cachedConfig = null;
  return loadPhoneticIntentConfig();
}

// Resolve a critical closed-set intent from a (possibly misheard) transcript.
// Returns { intent, score, source, keywordCost } or null. Stage gating is the
// caller's contract too, but enforced here as defense-in-depth.
export function resolvePhoneticIntent(transcript, stage, options = {}) {
  const config = loadPhoneticIntentConfig(options);
  if (!config) {
    return null;
  }
  if (stage && config.stages.length > 0 && !config.stages.includes(stage)) {
    return null;
  }

  const text = normalizeText(transcript);
  if (!text) {
    return null;
  }
  const textSyllables = toSyllables(text, config.pinyin);
  if (textSyllables.length === 0) {
    return null;
  }

  let best = null;
  for (const intent of config.intents) {
    const keyword = bestPhraseMatch(intent.keywords, textSyllables, config);
    if (!keyword || keyword.cost > config.match.maxKeywordCost) {
      continue;
    }

    if (intent.requireTrigger) {
      const trigger = bestPhraseMatch(intent.triggers, textSyllables, config);
      if (!trigger || trigger.cost > config.match.maxTriggerCost) {
        continue;
      }
    }

    const score = clamp01(1 - keyword.cost);
    if (score < config.match.minScore) {
      continue;
    }
    if (!best || score > best.score) {
      best = {
        intent: intent.intent,
        score: Number(score.toFixed(4)),
        source: "phonetic_fuzzy",
        keywordCost: Number(keyword.cost.toFixed(4)),
      };
    }
  }

  return best;
}

function bestPhraseMatch(phrases, textSyllables, config) {
  let best = null;
  for (const phrase of phrases) {
    const syllables = toSyllables(phrase, config.pinyin);
    if (syllables.length < config.match.minKeywordSyllables) {
      continue;
    }
    const cost = fuzzySubstringCost(syllables, textSyllables, config);
    if (!best || cost < best.cost) {
      best = { cost, phrase };
    }
  }
  return best;
}

// Minimum normalized edit distance of `pattern` against any contiguous run of
// `text` (approximate substring search). Substitution uses the phonetic syllable
// cost; insert/delete cost 1. Normalized by pattern length so it is comparable
// across keyword lengths.
function fuzzySubstringCost(pattern, text, config) {
  const n = pattern.length;
  const m = text.length;
  if (n === 0 || m === 0) {
    return 1;
  }

  // Row i = 0 is all zeros: the match may start at any position for free.
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1);
    cur[0] = i; // i pattern syllables vs empty text prefix => i deletions
    for (let j = 1; j <= m; j += 1) {
      const rawCost = syllableCost(pattern[i - 1], text[j - 1], config);
      const subCost = rawCost > config.match.maxSyllableCost ? 1 : rawCost;
      const substitute = prev[j - 1] + subCost;
      const deletePattern = prev[j] + 1;
      const skipText = cur[j - 1] + 1;
      cur[j] = Math.min(substitute, deletePattern, skipText);
    }
    prev = cur;
  }

  let best = Infinity;
  for (let j = 0; j <= m; j += 1) {
    if (prev[j] < best) {
      best = prev[j];
    }
  }
  return best / n;
}

// Phonetic distance in [0,1] between two toneless pinyin syllables. Non-pinyin
// tokens (unmapped CJK chars, latin/digits) only match an identical token, so a
// forgotten homophone degrades to a miss, never a false positive.
function syllableCost(a, b, config) {
  if (a === b) {
    return 0;
  }
  if (!isPinyin(a) || !isPinyin(b)) {
    return 1;
  }

  const sa = splitPinyin(a);
  const sb = splitPinyin(b);
  const initialSame = sa.initial === sb.initial;
  const finalSame = sa.final === sb.final;
  if (initialSame && finalSame) {
    return 0;
  }

  const initialCost = initialSame ? 0 : segmentDistance(sa.initial, sb.initial, config.confusableInitials);
  const finalCost = finalSame ? 0 : segmentDistance(sa.final, sb.final, config.confusableFinals);
  return clamp01(config.match.initialWeight * initialCost + config.match.finalWeight * finalCost);
}

// Confusable pairs are "near" (cost 0.5); otherwise normalized Levenshtein.
function segmentDistance(a, b, confusable) {
  if (a === b) {
    return 0;
  }
  const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  if (confusable.has(key)) {
    return 0.5;
  }
  return normalizedLevenshtein(a, b);
}

function splitPinyin(syllable) {
  for (const initial of INITIALS_2) {
    if (syllable.startsWith(initial)) {
      return { initial, final: syllable.slice(initial.length) };
    }
  }
  if (INITIALS_1.has(syllable[0])) {
    return { initial: syllable[0], final: syllable.slice(1) };
  }
  return { initial: "", final: syllable };
}

function toSyllables(text, pinyin) {
  const out = [];
  for (const ch of String(text)) {
    if (/\s/.test(ch)) {
      continue;
    }
    const mapped = pinyin[ch];
    if (mapped) {
      out.push(mapped);
    } else if (/[a-zA-Z]/.test(ch)) {
      out.push(ch.toLowerCase());
    } else if (isCjk(ch)) {
      out.push(ch); // unmapped han char -> only matches itself
    }
    // digits / punctuation are dropped
  }
  return out;
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const match = raw.match && typeof raw.match === "object" ? raw.match : {};
  const intents = Array.isArray(raw.intents)
    ? raw.intents
        .filter((entry) => entry && typeof entry.intent === "string")
        .map((entry) => ({
          intent: entry.intent,
          requireTrigger: entry.require_trigger === true,
          keywords: stringArray(entry.keywords),
          triggers: stringArray(entry.triggers),
        }))
        .filter((entry) => entry.keywords.length > 0)
    : [];

  const pinyin = raw.pinyin && typeof raw.pinyin === "object" && !Array.isArray(raw.pinyin) ? raw.pinyin : {};

  return {
    stages: stringArray(raw.stages),
    match: {
      maxKeywordCost: positiveNumber(match.max_keyword_cost, DEFAULTS.maxKeywordCost),
      maxTriggerCost: positiveNumber(match.max_trigger_cost, DEFAULTS.maxTriggerCost),
      minScore: positiveNumber(match.min_score, DEFAULTS.minScore),
      minKeywordSyllables: positiveInteger(match.min_keyword_syllables, DEFAULTS.minKeywordSyllables),
      maxSyllableCost: positiveNumber(match.max_syllable_cost, DEFAULTS.maxSyllableCost),
      initialWeight: positiveNumber(match.initial_weight, DEFAULTS.initialWeight),
      finalWeight: positiveNumber(match.final_weight, DEFAULTS.finalWeight),
    },
    confusableInitials: buildConfusableSet(match.confusable_initials),
    confusableFinals: buildConfusableSet(match.confusable_finals),
    pinyin,
    intents,
  };
}

function buildConfusableSet(pairs) {
  const set = new Set();
  if (!Array.isArray(pairs)) {
    return set;
  }
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      continue;
    }
    const a = String(pair[0]).trim();
    const b = String(pair[1]).trim();
    if (!a || !b || a === b) {
      continue;
    }
    set.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  }
  return set;
}

function isPinyin(token) {
  return /^[a-z]+$/.test(token);
}

function isCjk(ch) {
  return /[\u4e00-\u9fff]/.test(ch);
}

function normalizedLevenshtein(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 0;
  }
  return levenshtein(a, b) / longest;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function stringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
