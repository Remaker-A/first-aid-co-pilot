#!/usr/bin/env python3
"""Offline TTS wrapper around the sherpa-onnx Python API.

The voice adapter (src/voice/tts.js) spawns this script with a model directory,
an output wav path, and the text to speak:

    python scripts/speech/sherpa_tts.py --model-dir models/speech/tts --output out.wav --text "你好"

It auto-detects the VITS / MeloTTS model files inside the model directory and
writes a 16-bit PCM wav to the requested output path.
"""
import argparse
import glob
import os
import sys
import wave

import numpy as np

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - older Python or non-reconfigurable stream
        pass


def log(message):
    print(f"[sherpa_tts] {message}", file=sys.stderr, flush=True)


def find_first(model_dir, patterns):
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.join(model_dir, "**", pattern), recursive=True))
        if matches:
            return matches[0]
    return None


def find_dict_dir(model_dir):
    for name in ("dict", "dict_dir"):
        candidate = os.path.join(model_dir, name)
        if os.path.isdir(candidate):
            return candidate
    for jieba in glob.glob(os.path.join(model_dir, "**", "jieba.dict.utf8"), recursive=True):
        return os.path.dirname(jieba)
    return ""


def collect_rule_fsts(model_dir):
    names = ["phone.fst", "date.fst", "number.fst"]
    found = []
    for name in names:
        path = find_first(model_dir, [name])
        if path:
            found.append(path)
    return ",".join(found)


def build_tts(model_dir, num_threads):
    import sherpa_onnx

    model = find_first(model_dir, ["model.onnx", "*.onnx"])
    tokens = find_first(model_dir, ["tokens.txt"])
    lexicon = find_first(model_dir, ["lexicon.txt"]) or ""
    if not model or not tokens:
        raise FileNotFoundError(f"could not find VITS model/tokens under {model_dir}.")

    dict_dir = find_dict_dir(model_dir)
    rule_fsts = collect_rule_fsts(model_dir)

    log(f"model={model}")
    log(f"tokens={tokens}")
    log(f"lexicon={lexicon or '<none>'}")
    log(f"dict_dir={dict_dir or '<none>'}")
    log(f"rule_fsts={rule_fsts or '<none>'}")

    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=model,
                lexicon=lexicon,
                tokens=tokens,
                dict_dir=dict_dir,
            ),
            num_threads=num_threads,
            provider="cpu",
            debug=False,
        ),
        rule_fsts=rule_fsts,
        max_num_sentences=2,
    )
    if not config.validate():
        raise RuntimeError("invalid sherpa-onnx OfflineTtsConfig; check model files.")

    return sherpa_onnx.OfflineTts(config)


def write_wave(path, samples, sample_rate):
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--sid", type=int, default=0)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--num-threads", type=int, default=2)
    args = parser.parse_args()

    text = (args.text or "").strip()
    if not text:
        log("empty text; nothing to synthesize")
        return 2

    try:
        tts = build_tts(args.model_dir, args.num_threads)
        audio = tts.generate(text, sid=args.sid, speed=args.speed)
        if audio is None or len(audio.samples) == 0:
            raise RuntimeError("TTS produced no samples.")
        write_wave(args.output, np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)
    except Exception as error:  # noqa: BLE001 - surface a clean error to the adapter
        log(f"synthesis failed: {error}")
        return 1

    log(f"wrote {args.output} ({audio.sample_rate} Hz, {len(audio.samples)} samples)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
