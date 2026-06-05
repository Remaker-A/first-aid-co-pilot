import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTtsCacheKey } from "../src/voice/ttsText.js";
import {
  TtsAudioCache,
  parseWav,
  DEFAULT_TTS_CACHE_DIR,
  TTS_CACHE_MANIFEST_NAME,
  TTS_CACHE_SCHEMA_VERSION,
} from "../src/voice/ttsCache.js";
import { createStreamingTts } from "../src/voice/streamingTts.js";
import { synthesizeSpeech } from "../src/voice/tts.js";
import { encodePcm16Wav } from "../src/voice/liveSession.js";

const REPO_ROOT = path.resolve(DEFAULT_TTS_CACHE_DIR, "..", "..");
const ANDROID_TTS_CACHE_DIR = path.join(
  REPO_ROOT,
  "android",
  "app",
  "src",
  "main",
  "assets",
  "tts_cache"
);
const SAFETY_PHRASES_PATH = path.join(REPO_ROOT, "knowledge", "safety_phrases.json");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function fileExists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function fakeWavResult(bytes, sampleRate = 16000) {
  const wav = encodePcm16Wav(Buffer.from(bytes), { sampleRate });
  return {
    provider: "fake",
    audio: { data_url: `data:audio/wav;base64,${wav.toString("base64")}` },
  };
}

test("buildTtsCacheKey rewrites digits and folds in tone/speed", () => {
  const dial = buildTtsCacheKey("我将为你拨打 120，请保持手机免提。");
  assert.match(dial, /幺二零/);
  assert.ok(!dial.includes("120"), "digits must be rewritten before keying");

  // Idempotent: an already-normalized clause keys the same as the raw phrase.
  assert.equal(buildTtsCacheKey("我将为你拨打 幺二零，请保持手机免提。"), dial);

  // Whitespace is collapsed so spacing differences share audio.
  assert.equal(buildTtsCacheKey("继续  按压"), buildTtsCacheKey("继续 按压"));

  // Tone and speed are part of the key.
  const base = buildTtsCacheKey("继续按压。");
  assert.notEqual(buildTtsCacheKey("继续按压。", { tone: "urgent" }), base);
  assert.notEqual(buildTtsCacheKey("继续按压。", { speed: "slow" }), base);
  assert.equal(buildTtsCacheKey("继续按压。", { tone: "", speed: "" }), base);
});

test("parseWav decodes a PCM16 WAV header", () => {
  const parsed = parseWav(encodePcm16Wav(Buffer.from([1, 2, 3, 4]), { sampleRate: 22050 }));
  assert.equal(parsed.sampleRate, 22050);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.deepEqual([...parsed.pcm], [1, 2, 3, 4]);
  assert.equal(parseWav(Buffer.from("not a wav")), null);
});

test("TtsAudioCache stores WAV bytes, parses PCM lazily, and evicts LRU", async () => {
  const cache = new TtsAudioCache({ maxEntries: 2, bundleDir: null });
  const wavA = encodePcm16Wav(Buffer.from([1, 2, 3, 4]), { sampleRate: 22050 });
  cache.set("a", wavA);

  const pcm = await cache.getPcm("a");
  assert.deepEqual([...pcm.pcm], [1, 2, 3, 4]);
  assert.equal(pcm.sampleRate, 22050);
  assert.equal((await cache.getWav("a")).length, wavA.length);

  cache.set("b", encodePcm16Wav(Buffer.from([5, 6])));
  await cache.getWav("a"); // touch "a" so "b" becomes the eviction victim
  cache.set("c", encodePcm16Wav(Buffer.from([7, 8])));

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.has("b"), false, "least-recently-used entry should be evicted");

  const stats = cache.snapshotStats();
  assert.ok(stats.hits >= 3);
  assert.ok(stats.evictions >= 1);
});

test("TtsAudioCache loads a bundle manifest; missing WAVs degrade to a miss", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-bundle-"));
  try {
    await fs.mkdir(path.join(dir, "wav"), { recursive: true });
    const presentKey = buildTtsCacheKey("继续按压。");
    const missingKey = buildTtsCacheKey("这一句没有音频。");
    const wav = encodePcm16Wav(Buffer.from([9, 9, 9, 9]), { sampleRate: 16000 });
    await fs.writeFile(path.join(dir, "wav", "clause-present.wav"), wav);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        schema_version: "tts_cache.v1",
        entries: [
          { kind: "clause", text: "继续按压。", tone: "", speed: "", key: presentKey, file: "wav/clause-present.wav" },
          { kind: "clause", text: "这一句没有音频。", tone: "", speed: "", key: missingKey, file: "wav/missing.wav" },
        ],
      })
    );

    const cache = new TtsAudioCache({ bundleDir: dir });
    await cache.loadBundle();
    await cache.loadBundle(); // idempotent

    const hit = await cache.getPcm(presentKey, { sampleRate: 16000 });
    assert.deepEqual([...hit.pcm], [9, 9, 9, 9]);
    assert.equal(await cache.getWav(missingKey), null);
    assert.equal(cache.snapshotStats().bundleHits, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("streaming TTS replays cached clauses without re-synthesizing", async () => {
  const cache = new TtsAudioCache({ bundleDir: null });
  cache.set(buildTtsCacheKey("继续按压。"), encodePcm16Wav(Buffer.from([1, 2, 3, 4]), { sampleRate: 16000 }));

  let synthCalls = 0;
  const tts = createStreamingTts({
    cache,
    chunkBytes: 4,
    synthesize: async () => {
      synthCalls += 1;
      return fakeWavResult([5, 6]);
    },
  });

  const chunks = [];
  for await (const item of tts.speak("继续按压。AED 来了怎么办？")) {
    chunks.push(item);
  }

  assert.equal(synthCalls, 1, "the cached clause must skip synthesis");
  const firstClause = chunks.filter((chunk) => chunk.clauseIndex === 0);
  assert.equal(firstClause[0].provider, "tts_cache");
  assert.deepEqual([...firstClause[0].chunk], [1, 2, 3, 4]);
  const secondClause = chunks.filter((chunk) => chunk.clauseIndex === 1);
  assert.equal(secondClause[0].provider, "fake");
});

test("streaming TTS caches a synthesized clause for the rest of the session", async () => {
  let synthCalls = 0;
  const tts = createStreamingTts({
    chunkBytes: 8,
    synthesize: async () => {
      synthCalls += 1;
      return fakeWavResult([1, 2]);
    },
  });

  for await (const _item of tts.speak("继续按压。")) {
    // drain
  }
  for await (const _item of tts.speak("继续按压。")) {
    // drain
  }

  assert.equal(synthCalls, 1, "the second turn must be served from the per-instance LRU");
});

test("synthesizeSpeech replays a pre-rendered phrase from the cache", async () => {
  const cache = new TtsAudioCache({ bundleDir: null });
  const text = "不要停，继续按压。";
  const wav = encodePcm16Wav(Buffer.from([3, 3, 3, 3]), { sampleRate: 16000 });
  cache.set(buildTtsCacheKey(text), wav);

  const result = await synthesizeSpeech(text, { cache, provider: "mock" });
  assert.equal(result.provider, "tts_cache");
  assert.equal(result.cached, true);
  assert.ok(result.audio.data_url.startsWith("data:audio/wav;base64,"));
  assert.equal(Buffer.from(result.audio.data_url.split(",")[1], "base64").length, wav.length);
});

test("synthesizeSpeech misses fall through to synthesis without caching mock audio", async () => {
  const cache = new TtsAudioCache({ bundleDir: null });
  const result = await synthesizeSpeech("现场安全了吗", { cache, provider: "mock" });
  assert.equal(result.provider, "mock");
  assert.equal(cache.has(buildTtsCacheKey("现场安全了吗")), false);
  assert.equal(cache.snapshotStats().misses >= 1, true);
});

// ---------------------------------------------------------------------------
// Shipped WA bundle guard (P0-2): the committed/rendered manifest must stay
// internally consistent and fresh so the desktop server and the on-device coach
// never ship a stale or half-rendered cache.
// ---------------------------------------------------------------------------

async function assertManifestGuard(dir, label) {
  const manifestPath = path.join(dir, TTS_CACHE_MANIFEST_NAME);
  assert.equal(await fileExists(manifestPath), true, `${label}: manifest.json must exist`);
  const manifest = await readJson(manifestPath);

  assert.equal(manifest.schema_version, TTS_CACHE_SCHEMA_VERSION, `${label}: schema_version`);
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0, `${label}: entries`);

  // Freshness: a manifest built against an older safety_phrases.json is stale and
  // must be re-rendered, so the knowledge_version has to match the source of truth.
  const safety = await readJson(SAFETY_PHRASES_PATH);
  assert.equal(
    manifest.knowledge_version,
    safety.knowledge_version,
    `${label}: stale cache — knowledge_version must match safety_phrases.json`
  );

  // Key integrity: every entry's key must be reproducible from its text + prosody.
  for (const entry of manifest.entries) {
    assert.ok(typeof entry.file === "string" && entry.file, `${label}: entry.file`);
    assert.ok(typeof entry.text === "string" && entry.text, `${label}: entry.text`);
    assert.equal(
      entry.key,
      buildTtsCacheKey(entry.text, { tone: entry.tone, speed: entry.speed }),
      `${label}: entry.key must match buildTtsCacheKey(${entry.text})`
    );
  }

  // When audio_rendered is true, every referenced WAV must exist on disk so we
  // never ship a manifest that claims audio it does not have. A manifest-only
  // build (audio_rendered:false) is a valid shippable state and skips this.
  if (manifest.audio_rendered === true) {
    for (const entry of manifest.entries) {
      assert.equal(
        await fileExists(path.resolve(dir, entry.file)),
        true,
        `${label}: audio_rendered=true but missing WAV ${entry.file}`
      );
    }
  }

  return manifest;
}

test("desktop WA bundle manifest is internally consistent and fresh", async () => {
  await assertManifestGuard(DEFAULT_TTS_CACHE_DIR, "desktop");
});

test("android WA bundle manifest matches the desktop bundle (no drift)", async () => {
  const desktop = await readJson(path.join(DEFAULT_TTS_CACHE_DIR, TTS_CACHE_MANIFEST_NAME));
  const android = await assertManifestGuard(ANDROID_TTS_CACHE_DIR, "android");

  // The on-device assets must cover at least the same closed-set keys the desktop
  // ships, otherwise the edge coach would miss phrases the server caches.
  const desktopKeys = new Set(desktop.entries.map((entry) => entry.key));
  const androidKeys = new Set(android.entries.map((entry) => entry.key));
  for (const key of desktopKeys) {
    assert.equal(androidKeys.has(key), true, `android bundle missing desktop key: ${key}`);
  }
  assert.equal(
    android.knowledge_version,
    desktop.knowledge_version,
    "android/desktop knowledge_version drift"
  );
});

test("a rendered standard phrase replays from the shipped bundle (not synthesized)", async () => {
  const manifest = await readJson(path.join(DEFAULT_TTS_CACHE_DIR, TTS_CACHE_MANIFEST_NAME));
  if (manifest.audio_rendered !== true) {
    // Manifest-only checkout: nothing to replay. The guard test above already
    // verified consistency; the bundle-hit path is covered by the synthetic test.
    return;
  }

  const phrase = manifest.entries.find((entry) => entry.kind === "phrase") || manifest.entries[0];
  const cache = new TtsAudioCache({ bundleDir: DEFAULT_TTS_CACHE_DIR });
  await cache.loadBundle();

  // provider:"mock" guarantees a bundle MISS would fall through to mock audio, so a
  // tts_cache provider proves the pre-rendered WAV was actually replayed (~0ms).
  const result = await synthesizeSpeech(phrase.text, { cache, provider: "mock" });
  assert.equal(result.provider, "tts_cache", `expected bundle hit for "${phrase.text}"`);
  assert.equal(result.cached, true);
  assert.ok(result.audio.data_url.startsWith("data:audio/wav;base64,"));

  const stats = cache.snapshotStats();
  assert.ok(stats.bundleHits >= 1, "bundle hit must be counted in the cache stats");
});
