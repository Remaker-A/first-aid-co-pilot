TTS pre-synth cache (workflow WA)
=================================

This directory is the shippable bundle of pre-rendered standard-phrase audio.
It turns the closed set of coach phrases from a ~3.5s live synthesis into a
near-instant cached playback.

Contents
--------

- `manifest.json` — generated, committed. Maps each cache key to a WAV file and
  records the raw phrase text, the post-`normalizeForTts` text, and tone/speed.
- `wav/*.wav` — generated, NOT committed (binary). One WAV per unique phrase
  (`kind: "phrase"`) and per unique clause (`kind: "clause"`).

Each entry carries two granularities:

- `phrase` — the whole utterance. Played as a single file by the Android coach
  (`EdgeTextToSpeechEdge`, matched by raw `text`) and by the opt-in whole-
  utterance cache in `src/voice/tts.js`.
- `clause` — one small sentence (e.g. "继续按压。"). Consumed by the desktop
  streaming path (`src/voice/streamingTts.js`, matched by `key`) so high-reuse
  clauses are streamed from cache.

Cache key
---------

`key = normalizeForTts(trim/collapse(text)) ␟ tone ␟ speed` (see
`src/voice/ttsText.js#buildTtsCacheKey`). Digits are rewritten before synthesis
(120 → 幺二零 in a dialing context), so the WAV speaks the correct reading and
the key is stable across the raw/normalized forms. The bundle is generated with
`tone`/`speed` empty (the default rendering); Android matches bundled phrases by
raw text and keeps tone/speed only on its runtime LRU.

Regenerating
------------

Manifest only (no model needed, deterministic — commit this):

    node scripts/speech/prerenderTtsCache.mjs

Manifest + WAVs (needs the sherpa VITS TTS env, same vars as the live server):

    # e.g. SHERPA_ONNX_TTS_COMMAND / SPEECH_TTS_* configured
    node scripts/speech/prerenderTtsCache.mjs --audio

Runtime wiring
--------------

- Desktop/server: set `VOICE_TTS_CACHE_DIR=assets/tts_cache` (or pass
  `cacheBundleDir`) so `createLiveTts` attaches the bundle. Without it the
  streamer still keeps a per-session in-memory LRU.
- Android: the manifest + WAVs ship in `android/app/src/main/assets/tts_cache`
  (or alongside the pushed models). A manifest entry whose WAV is absent simply
  degrades to a live-synth miss, so the manifest is safe to ship on its own.
