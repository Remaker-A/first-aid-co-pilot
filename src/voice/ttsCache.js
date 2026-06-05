// Pre-synthesized TTS audio cache (workflow WA).
//
// Two layers behind one key (see buildTtsCacheKey):
//   1. A bounded in-memory LRU of WAV bytes (+ lazily parsed PCM) filled at
//      runtime on every cache miss, so a clause synthesized once is replayed
//      from memory for the rest of the session (~0ms).
//   2. A read-only "bundle" of pre-rendered WAVs shipped on disk (the closed
//      set of safety phrases). The bundle is described by a manifest.json that
//      maps each cache key to a WAV file; the bytes are read lazily on the
//      first hit and then promoted into the LRU.
//
// The same manifest is consumed on Android (assets/tts_cache) so the closed-set
// audio is shared between the desktop server and the on-device coach.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTtsCacheKey } from "./ttsText.js";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");

export const DEFAULT_TTS_CACHE_DIR = path.join(REPO_ROOT, "assets", "tts_cache");
export const TTS_CACHE_MANIFEST_NAME = "manifest.json";
export const TTS_CACHE_SCHEMA_VERSION = "tts_cache.v1";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;

export class TtsAudioCache {
  constructor(options = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.bundleDir =
      options.bundleDir === null || options.bundleDir === false
        ? null
        : options.bundleDir || DEFAULT_TTS_CACHE_DIR;
    // key -> { wav: Buffer, pcm: parsed|null } in insertion/most-recent order.
    this.lru = new Map();
    // key -> absolute WAV file path (read lazily on first hit).
    this.bundle = new Map();
    this.bundleLoaded = false;
    this.bundleLoading = null;
    this.stats = { hits: 0, misses: 0, lruHits: 0, bundleHits: 0, stores: 0, evictions: 0 };
  }

  async loadBundle() {
    if (this.bundleLoaded) {
      return this;
    }
    if (this.bundleLoading) {
      return this.bundleLoading;
    }
    this.bundleLoading = (async () => {
      if (this.bundleDir) {
        try {
          const raw = await fs.readFile(path.join(this.bundleDir, TTS_CACHE_MANIFEST_NAME), "utf8");
          this.registerManifest(JSON.parse(raw));
        } catch {
          // No bundle on disk (or unreadable) -> behave as an LRU-only cache.
        }
      }
      this.bundleLoaded = true;
      this.bundleLoading = null;
      return this;
    })();
    return this.bundleLoading;
  }

  registerManifest(manifest) {
    const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
    for (const entry of entries) {
      if (!entry || typeof entry.file !== "string" || !entry.file) {
        continue;
      }
      const key =
        typeof entry.key === "string" && entry.key
          ? entry.key
          : buildTtsCacheKey(entry.text, { tone: entry.tone, speed: entry.speed });
      const file = path.isAbsolute(entry.file)
        ? entry.file
        : path.resolve(this.bundleDir || REPO_ROOT, entry.file);
      this.bundle.set(key, file);
    }
    return this.bundle.size;
  }

  has(key) {
    return this.lru.has(key) || this.bundle.has(key);
  }

  async getWav(key) {
    if (!key) {
      this.stats.misses += 1;
      return null;
    }
    const existing = this.lru.get(key);
    if (existing) {
      this.touch(key, existing);
      this.stats.hits += 1;
      this.stats.lruHits += 1;
      return existing.wav;
    }
    const file = this.bundle.get(key);
    if (file) {
      try {
        const wav = await fs.readFile(file);
        this.store(key, wav);
        this.stats.hits += 1;
        this.stats.bundleHits += 1;
        return wav;
      } catch {
        // A manifest entry whose WAV is missing on disk degrades to a miss so
        // the caller falls back to live synthesis.
      }
    }
    this.stats.misses += 1;
    return null;
  }

  async getPcm(key, defaults = {}) {
    if (!key) {
      this.stats.misses += 1;
      return null;
    }
    const existing = this.lru.get(key);
    if (existing) {
      this.touch(key, existing);
      this.stats.hits += 1;
      this.stats.lruHits += 1;
      return existing.pcm || (existing.pcm = decodeWav(existing.wav, defaults));
    }
    const file = this.bundle.get(key);
    if (file) {
      try {
        const wav = await fs.readFile(file);
        const stored = this.store(key, wav);
        stored.pcm = decodeWav(wav, defaults);
        this.stats.hits += 1;
        this.stats.bundleHits += 1;
        return stored.pcm;
      } catch {
        // missing/unreadable bundle file -> miss
      }
    }
    this.stats.misses += 1;
    return null;
  }

  // Stores raw WAV bytes (the canonical cached form). The optional parsed PCM is
  // attached so a freshly synthesized clause is not re-decoded on its next play.
  set(key, wav, parsedPcm = null) {
    if (!key || !wav || !wav.length) {
      return null;
    }
    const stored = this.store(key, Buffer.isBuffer(wav) ? wav : Buffer.from(wav));
    if (parsedPcm) {
      stored.pcm = parsedPcm;
    }
    this.stats.stores += 1;
    return stored;
  }

  store(key, wav) {
    if (this.lru.has(key)) {
      this.lru.delete(key);
    }
    const entry = { wav, pcm: null };
    this.lru.set(key, entry);
    while (this.lru.size > this.maxEntries) {
      const oldestKey = this.lru.keys().next().value;
      this.lru.delete(oldestKey);
      this.stats.evictions += 1;
    }
    return entry;
  }

  touch(key, entry) {
    this.lru.delete(key);
    this.lru.set(key, entry);
  }

  snapshotStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    return { ...this.stats, total, hitRate: Number(hitRate.toFixed(4)) };
  }

  clear() {
    this.lru.clear();
  }
}

// Minimal RIFF/WAVE PCM decoder. Returns null for anything that is not a PCM
// WAV so callers can fall back to treating the bytes as raw PCM.
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return null;
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let channels = DEFAULT_CHANNELS;
  let bitsPerSample = DEFAULT_BITS_PER_SAMPLE;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);

    if (id === "fmt " && size >= 16 && end <= buffer.length) {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataStart = start;
      dataSize = Math.max(0, end - start);
      break;
    }

    offset = start + size + (size % 2);
  }

  if (dataStart < 0) {
    return null;
  }

  return {
    pcm: buffer.subarray(dataStart, dataStart + dataSize),
    sampleRate,
    channels,
    bitsPerSample,
  };
}

function decodeWav(wav, defaults = {}) {
  const parsed = parseWav(wav);
  if (parsed) {
    return parsed;
  }
  return {
    pcm: Buffer.isBuffer(wav) ? wav : Buffer.from(wav || []),
    sampleRate: positiveInteger(defaults.sampleRate, DEFAULT_SAMPLE_RATE),
    channels: positiveInteger(defaults.channels, DEFAULT_CHANNELS),
    bitsPerSample: positiveInteger(defaults.bitsPerSample, DEFAULT_BITS_PER_SAMPLE),
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return Math.floor(number);
  }
  return fallback;
}
