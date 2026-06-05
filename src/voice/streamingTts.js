import { promises as fs } from "node:fs";
import { synthesizeSpeech } from "./tts.js";
import { buildTtsCacheKey, normalizeForTts } from "./ttsText.js";
import { TtsAudioCache, parseWav } from "./ttsCache.js";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;
const DEFAULT_CHUNK_BYTES = 3200;
const DEFAULT_MAX_CLAUSE_CHARS = 34;

export function createStreamingTts(options = {}) {
  return new StreamingTts(options);
}

export class StreamingTts {
  constructor(options = {}) {
    this.synthesize = options.synthesize || synthesizeSpeech;
    this.ttsOptions = options.ttsOptions || options.tts || {};
    this.chunkBytes = evenPositiveInteger(options.chunkBytes, DEFAULT_CHUNK_BYTES);
    this.maxClauseChars = positiveInteger(options.maxClauseChars, DEFAULT_MAX_CLAUSE_CHARS);
    this.sampleRate = positiveInteger(options.sampleRate, DEFAULT_SAMPLE_RATE);
    this.channels = positiveInteger(options.channels, DEFAULT_CHANNELS);
    this.bitsPerSample = positiveInteger(options.bitsPerSample, DEFAULT_BITS_PER_SAMPLE);
    // WA pre-synth cache: clause audio keyed by normalizeForTts(text)+tone+speed.
    // Default is a per-instance LRU with no on-disk bundle so tests stay
    // hermetic; the live path opts into the shipped bundle via cacheBundleDir.
    this.cache = resolveCache(options);
    this.cacheTone = options.cacheTone ?? this.ttsOptions.tone ?? null;
    this.cacheSpeed = options.cacheSpeed ?? this.ttsOptions.speed ?? null;
    this.token = 0;
    this.cancelReason = null;
  }

  cancel(reason = "cancelled") {
    this.cancelReason = reason;
    this.token += 1;
  }

  speak(text = "", options = {}) {
    const token = this.token + 1;
    this.token = token;
    this.cancelReason = null;
    return this.iterateSpeech(normalizeForTts(normalizeText(text)), token, options);
  }

  async *iterateSpeech(text, token, options = {}) {
    const clauses = splitTextIntoClauses(text, {
      maxClauseChars: options.maxClauseChars || this.maxClauseChars,
    });
    const audioDefaults = {
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
    };
    const tone = options.tone ?? this.cacheTone;
    const speed = options.speed ?? this.cacheSpeed;

    if (this.cache?.bundleDir && !this.cache.bundleLoaded) {
      await this.cache.loadBundle();
      this.assertCurrent(token);
    }

    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      this.assertCurrent(token);
      const clause = clauses[clauseIndex];
      const cacheKey = this.cache ? buildTtsCacheKey(clause, { tone, speed }) : null;

      let audio = null;
      let provider = "tts_cache";
      if (cacheKey) {
        audio = await this.cache.getPcm(cacheKey, audioDefaults);
        this.assertCurrent(token);
      }

      if (!audio) {
        const result = await this.synthesize(clause, {
          ...this.ttsOptions,
          ...(options.ttsOptions || options.tts || {}),
        });
        this.assertCurrent(token);
        provider = result?.provider || "unknown";
        const bytes = await readTtsAudioBytes(result);
        audio = decodeTtsAudio(bytes, audioDefaults);
        if (cacheKey && bytes.length) {
          this.cache.set(cacheKey, bytes, audio);
        }
      }

      for (const chunk of chunkBuffer(audio.pcm, options.chunkBytes || this.chunkBytes)) {
        this.assertCurrent(token);
        yield {
          type: "audio",
          provider,
          clause,
          clauseIndex,
          clauseCount: clauses.length,
          sampleRate: audio.sampleRate,
          channels: audio.channels,
          bitsPerSample: audio.bitsPerSample,
          chunk,
        };
      }
    }
  }

  assertCurrent(token) {
    if (token !== this.token) {
      const error = new Error(this.cancelReason || "TTS stream cancelled.");
      error.code = "ERR_TTS_STREAM_CANCELLED";
      throw error;
    }
  }
}

export function splitTextIntoClauses(text = "", options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  const maxClauseChars = positiveInteger(options.maxClauseChars, DEFAULT_MAX_CLAUSE_CHARS);
  const roughClauses = normalized
    .split(/(?<=[。！？!?；;，,、])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const clauses = roughClauses.length ? roughClauses : [normalized];

  return clauses.flatMap((clause) => splitLongClause(clause, maxClauseChars));
}

export async function wavPcmFromTtsResult(result = {}, defaults = {}) {
  const bytes = await readTtsAudioBytes(result);
  return decodeTtsAudio(bytes, defaults);
}

export async function readTtsAudioBytes(result = {}) {
  return readAudioBytes(result.audio || {});
}

function decodeTtsAudio(bytes, defaults = {}) {
  const parsed = parseWav(bytes);
  if (parsed) {
    return parsed;
  }

  return {
    pcm: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []),
    sampleRate: positiveInteger(defaults.sampleRate, DEFAULT_SAMPLE_RATE),
    channels: positiveInteger(defaults.channels, DEFAULT_CHANNELS),
    bitsPerSample: positiveInteger(defaults.bitsPerSample, DEFAULT_BITS_PER_SAMPLE),
  };
}

function resolveCache(options = {}) {
  if (options.cache === null || options.cache === false) {
    return null;
  }
  if (options.cache) {
    return options.cache;
  }
  return new TtsAudioCache({
    maxEntries: options.cacheMaxEntries,
    bundleDir: options.cacheBundleDir ?? null,
  });
}

async function readAudioBytes(audio = {}) {
  if (audio.path) {
    return fs.readFile(audio.path);
  }

  if (audio.data_url || audio.dataUrl) {
    const dataUrl = audio.data_url || audio.dataUrl;
    const base64 = String(dataUrl).split(",", 2)[1] || "";
    return Buffer.from(base64, "base64");
  }

  if (audio.base64 || audio.data_base64) {
    return Buffer.from(audio.base64 || audio.data_base64, "base64");
  }

  if (Buffer.isBuffer(audio.bytes)) {
    return audio.bytes;
  }

  return Buffer.alloc(0);
}

function* chunkBuffer(buffer, chunkBytes) {
  const size = evenPositiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES);
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
  }
}

function splitLongClause(clause, maxChars) {
  if (clause.length <= maxChars) {
    return [clause];
  }

  const parts = [];
  let remaining = clause;
  while (remaining.length > maxChars) {
    const breakAt = findBreakPosition(remaining, maxChars);
    parts.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function findBreakPosition(text, maxChars) {
  const window = text.slice(0, maxChars + 1);
  const punctuation = Math.max(
    window.lastIndexOf("，"),
    window.lastIndexOf(","),
    window.lastIndexOf("、")
  );
  return punctuation > Math.floor(maxChars * 0.45) ? punctuation + 1 : maxChars;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function positiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }
  return undefined;
}

function evenPositiveInteger(value, fallback) {
  const number = positiveInteger(value, fallback) || fallback;
  return number % 2 === 0 ? number : number + 1;
}
