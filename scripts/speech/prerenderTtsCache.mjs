#!/usr/bin/env node
// Pre-render the closed set of standard coach phrases into a shippable TTS
// audio bundle (workflow WA).
//
// What it produces under <out> (default: assets/tts_cache):
//   - manifest.json : key -> wav file map consumed by both the desktop server
//                     (src/voice/ttsCache.js) and Android (assets/tts_cache).
//   - wav/*.wav     : one WAV per unique phrase and per unique clause, only
//                     written when --audio is given AND sherpa-onnx is wired up.
//
// The manifest is fully deterministic and needs no model, so it can be
// committed as-is; the WAVs are produced on a machine that has the sherpa VITS
// model (set SHERPA_ONNX_TTS_COMMAND/SPEECH_TTS_* like the live server, then run
// with --audio). A manifest entry whose WAV is missing simply degrades to a
// live-synth cache miss at runtime, so shipping the manifest alone is safe.
//
// Usage:
//   node scripts/speech/prerenderTtsCache.mjs                 # manifest only
//   node scripts/speech/prerenderTtsCache.mjs --audio         # + synthesize WAVs
//   node scripts/speech/prerenderTtsCache.mjs --audio --sync-android  # + copy into APK assets
//   node scripts/speech/prerenderTtsCache.mjs --out build/cache --max-clause-chars 34
//
// `npm run render:tts-cache` wraps `--audio --sync-android` (render WAVs and mirror
// the bundle into android/app/src/main/assets/tts_cache).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTtsCacheKey, normalizeForTts } from "../../src/voice/ttsText.js";
import { splitTextIntoClauses } from "../../src/voice/streamingTts.js";
import { TTS_CACHE_SCHEMA_VERSION } from "../../src/voice/ttsCache.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SAFETY_PHRASES_PATH = path.join(REPO_ROOT, "knowledge", "safety_phrases.json");
const LIVE_DRIVER_PATH = path.join(REPO_ROOT, "src", "voice", "liveDriver.js");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "assets", "tts_cache");
const DEFAULT_ANDROID_OUT_DIR = path.join(
  REPO_ROOT,
  "android",
  "app",
  "src",
  "main",
  "assets",
  "tts_cache"
);
const DEFAULT_MAX_CLAUSE_CHARS = 34;
const DEFAULT_SAMPLE_RATE_HINT = 22050;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || DEFAULT_OUT_DIR);
  const maxClauseChars = Number(args.maxClauseChars) || DEFAULT_MAX_CLAUSE_CHARS;

  const sources = await collectPhrases();
  const { entries, knowledgeVersion } = buildEntries(sources, maxClauseChars);

  await fs.mkdir(path.join(outDir, "wav"), { recursive: true });

  let audio = { rendered: 0, skipped: 0, failed: 0, attempted: false };
  if (args.audio) {
    audio = await renderAudio(entries, outDir, args);
  }

  const manifest = {
    schema_version: TTS_CACHE_SCHEMA_VERSION,
    knowledge_version: knowledgeVersion,
    generated_at: new Date().toISOString(),
    sample_rate_hint: DEFAULT_SAMPLE_RATE_HINT,
    max_clause_chars: maxClauseChars,
    // True only when WAVs were actually produced. A manifest-only build (or one
    // where sherpa was unavailable so every entry was skipped) stays false, which
    // the manifest guard (test/tts-cache.test.js) treats as a valid, shippable
    // "manifest-only" state. When true, the guard requires every referenced WAV to
    // exist, so a partial/failed render is caught instead of silently shipping gaps.
    audio_rendered: audio.rendered > 0,
    counts: {
      total: entries.length,
      phrases: entries.filter((entry) => entry.kind === "phrase").length,
      clauses: entries.filter((entry) => entry.kind === "clause").length,
    },
    entries,
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  let androidSync = null;
  if (args.syncAndroid) {
    androidSync = await syncToAndroid(outDir, args.androidOut);
  }

  process.stdout.write(
    [
      `Wrote ${manifestPath}`,
      `  entries: ${manifest.counts.total} (phrases ${manifest.counts.phrases}, clauses ${manifest.counts.clauses})`,
      args.audio
        ? `  audio: rendered ${audio.rendered}, skipped ${audio.skipped}, failed ${audio.failed} (audio_rendered=${manifest.audio_rendered})`
        : "  audio: skipped (run with --audio + a sherpa TTS env to synthesize WAVs)",
      androidSync
        ? `  android: synced ${androidSync.files} files -> ${androidSync.dir}`
        : "  android: not synced (pass --sync-android to copy manifest + wav into the APK assets)",
      "",
    ].join("\n")
  );
}

// Mirror the freshly written bundle (manifest + wav/*) into the Android APK assets
// so the on-device coach (assets/tts_cache, EdgeTextToSpeechEdge.preloadBundledCache)
// loads the exact same closed-set audio as the desktop server. Cross-platform
// (Node fs) so it works the same on Windows/macOS/Linux CI.
async function syncToAndroid(outDir, androidOutArg) {
  const dir = path.resolve(androidOutArg || DEFAULT_ANDROID_OUT_DIR);
  await fs.rm(dir, { recursive: true, force: true });
  const files = await copyDir(outDir, dir);
  return { dir, files };
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  let count = 0;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

async function collectPhrases() {
  const sources = [];

  const safety = JSON.parse(await fs.readFile(SAFETY_PHRASES_PATH, "utf8"));
  const knowledgeVersion = safety.knowledge_version || "unknown";
  for (const phrase of safety.allowed_phrases || []) {
    if (phrase && typeof phrase.text === "string") {
      sources.push({ text: phrase.text, declaredTone: phrase.tone || "", source: `safety:${phrase.id}` });
    }
  }

  // The live driver's fixed coach answers are authored as inline literals. Sweep
  // them out of the source so the bundle covers the high-frequency answers too;
  // template literals (containing ${...}) are intentionally skipped.
  try {
    const driverSource = await fs.readFile(LIVE_DRIVER_PATH, "utf8");
    for (const literal of extractLiveDriverPhrases(driverSource)) {
      sources.push({ text: literal, declaredTone: "", source: "liveDriver" });
    }
  } catch {
    // liveDriver not present -> safety phrases only.
  }

  // WB open-question fixed phrases (the stabilizing ack + the CPR-live safety
  // fallback) are stored as `text:` fields / an inline service string, which the
  // ttsText/return regex sweep above cannot see. Pull them from the module's
  // exported source of truth so the bundle covers them and the immediate ack
  // plays from cache (~0ms) instead of a live synthesis.
  try {
    const { OPEN_QUESTION_FIXED_PHRASES } = await import(pathToFileURL(LIVE_DRIVER_PATH).href);
    for (const text of OPEN_QUESTION_FIXED_PHRASES || []) {
      if (typeof text === "string" && text.trim()) {
        sources.push({ text, declaredTone: "", source: "liveDriver:open_question" });
      }
    }
  } catch {
    // liveDriver not importable -> regex-swept literals only.
  }

  return { sources, knowledgeVersion };
}

function extractLiveDriverPhrases(source) {
  const found = new Set();
  // ttsText: "..."   and   return "...";   (double-quoted, no interpolation)
  const patterns = [/ttsText:\s*"((?:[^"\\]|\\.)*)"/g, /return\s+"((?:[^"\\]|\\.)*)"\s*;/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const text = match[1].replace(/\\"/g, '"');
      if (text && !text.includes("${") && /[\u4e00-\u9fff]/.test(text)) {
        found.add(text);
      }
    }
  }
  return [...found];
}

function buildEntries(collected, maxClauseChars) {
  const byKey = new Map();

  const addEntry = (entry) => {
    const existing = byKey.get(entry.key);
    if (existing) {
      // Keep the richest provenance but never duplicate a key/file.
      if (!existing.sources.includes(entry.sources[0])) {
        existing.sources.push(entry.sources[0]);
      }
      return;
    }
    byKey.set(entry.key, entry);
  };

  for (const { text, declaredTone, source } of collected.sources) {
    const collapsed = text.trim().replace(/\s+/g, " ");
    if (!collapsed) {
      continue;
    }
    const normalized = normalizeForTts(collapsed);

    const phraseKey = buildTtsCacheKey(collapsed, { tone: "", speed: "" });
    addEntry({
      kind: "phrase",
      text: collapsed,
      normalized,
      tone: "",
      speed: "",
      declared_tone: declaredTone,
      key: phraseKey,
      speak_text: collapsed,
      file: `wav/${fileName("phrase", phraseKey)}`,
      sources: [source],
    });

    for (const clause of splitTextIntoClauses(normalized, { maxClauseChars })) {
      const clauseKey = buildTtsCacheKey(clause, { tone: "", speed: "" });
      addEntry({
        kind: "clause",
        text: clause,
        normalized: clause,
        tone: "",
        speed: "",
        declared_tone: declaredTone,
        key: clauseKey,
        speak_text: clause,
        file: `wav/${fileName("clause", clauseKey)}`,
        sources: [source],
      });
    }
  }

  const entries = [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "phrase" ? -1 : 1;
    }
    return a.key.localeCompare(b.key);
  });
  return { entries, knowledgeVersion: collected.knowledgeVersion };
}

async function renderAudio(entries, outDir, args) {
  const { synthesizeSpeech } = await import("../../src/voice/tts.js");
  const { readTtsAudioBytes } = await import("../../src/voice/streamingTts.js");
  const stats = { rendered: 0, skipped: 0, failed: 0, attempted: true };
  const limit = Number(args.limit) > 0 ? Number(args.limit) : entries.length;
  const queue = entries.slice(0, limit);

  for (const entry of queue) {
    const target = path.join(outDir, entry.file);
    try {
      const result = await synthesizeSpeech(entry.speak_text, {
        provider: args.provider || "sherpa",
      });
      if (result.provider !== "sherpa-onnx" || !result.ok) {
        stats.skipped += 1;
        if (stats.skipped <= 1) {
          process.stderr.write(
            `[prerender] sherpa TTS unavailable (provider=${result.provider}); skipping WAV output.\n`
          );
        }
        continue;
      }
      const bytes = await readTtsAudioBytes(result);
      if (!bytes.length) {
        stats.failed += 1;
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      stats.rendered += 1;
    } catch (error) {
      stats.failed += 1;
      process.stderr.write(`[prerender] failed "${entry.speak_text.slice(0, 16)}": ${error?.message}\n`);
    }
  }

  return stats;
}

function fileName(kind, key) {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return `${kind}-${hash}.wav`;
}

function parseArgs(argv) {
  const args = { audio: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--audio") {
      args.audio = true;
    } else if (token === "--no-audio") {
      args.audio = false;
    } else if (token === "--out") {
      args.out = argv[++i];
    } else if (token === "--max-clause-chars") {
      args.maxClauseChars = argv[++i];
    } else if (token === "--provider") {
      args.provider = argv[++i];
    } else if (token === "--limit") {
      args.limit = argv[++i];
    } else if (token === "--sync-android") {
      args.syncAndroid = true;
    } else if (token === "--android-out") {
      args.androidOut = argv[++i];
    }
  }
  return args;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
