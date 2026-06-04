import { promises as fs } from "node:fs";
import { synthesizeSpeech } from "./tts.js";
import { normalizeForTts } from "./ttsText.js";

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

    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      this.assertCurrent(token);
      const clause = clauses[clauseIndex];
      const result = await this.synthesize(clause, {
        ...this.ttsOptions,
        ...(options.ttsOptions || options.tts || {}),
      });
      this.assertCurrent(token);

      const audio = await wavPcmFromTtsResult(result, {
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitsPerSample: this.bitsPerSample,
      });

      for (const chunk of chunkBuffer(audio.pcm, options.chunkBytes || this.chunkBytes)) {
        this.assertCurrent(token);
        yield {
          type: "audio",
          provider: result?.provider || "unknown",
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
  const audio = result.audio || {};
  const bytes = await readAudioBytes(audio);
  const parsed = parseWav(bytes);
  if (parsed) {
    return parsed;
  }

  return {
    pcm: bytes,
    sampleRate: positiveInteger(defaults.sampleRate, DEFAULT_SAMPLE_RATE),
    channels: positiveInteger(defaults.channels, DEFAULT_CHANNELS),
    bitsPerSample: positiveInteger(defaults.bitsPerSample, DEFAULT_BITS_PER_SAMPLE),
  };
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

function parseWav(buffer) {
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
