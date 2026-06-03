#!/usr/bin/env python3
"""Offline STT wrapper around the sherpa-onnx Python API.

The voice adapter (src/voice/stt.js) spawns this script with a model
directory and an input audio file, and reads a JSON transcript from stdout:

    python scripts/speech/sherpa_stt.py --model-dir models/speech/stt --audio in.wav

It auto-detects the SenseVoice model files inside the model directory so the
caller does not need to hardcode exact filenames. Non-wav inputs are decoded to
16 kHz mono PCM via ffmpeg when available.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - older Python or non-reconfigurable stream
        pass


def log(message):
    print(f"[sherpa_stt] {message}", file=sys.stderr, flush=True)


def find_first(model_dir, patterns):
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.join(model_dir, "**", pattern), recursive=True))
        if matches:
            return matches[0]
    return None


def read_wave_any(path):
    """Return (float32 samples in [-1, 1], sample_rate). Uses ffmpeg for non-wav."""
    try:
        return read_wave_pcm(path)
    except Exception as wav_error:  # noqa: BLE001 - fall back to ffmpeg transcode
        log(f"direct wav read failed ({wav_error}); trying ffmpeg transcode")
        converted = transcode_to_wav(path)
        try:
            return read_wave_pcm(converted)
        finally:
            try:
                os.remove(converted)
            except OSError:
                pass


def read_wave_pcm(path):
    with wave.open(path, "rb") as wav:
        n_channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if sample_width != 2:
        raise ValueError(f"unsupported sample width: {sample_width * 8} bit")

    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, sample_rate


def transcode_to_wav(path):
    if not has_ffmpeg():
        raise RuntimeError(
            "input is not a 16-bit PCM wav and ffmpeg is not available to transcode it."
        )
    out_fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(out_fd)
    subprocess.run(
        ["ffmpeg", "-y", "-i", path, "-ac", "1", "-ar", "16000", "-f", "wav", out_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return out_path


def has_ffmpeg():
    from shutil import which

    return which("ffmpeg") is not None


def build_recognizer(model_dir, num_threads, language):
    import sherpa_onnx

    model = find_first(model_dir, ["*.int8.onnx", "model.onnx", "*.onnx"])
    tokens = find_first(model_dir, ["tokens.txt"])
    if not model or not tokens:
        raise FileNotFoundError(
            f"could not find SenseVoice model/tokens under {model_dir}."
        )

    log(f"model={model}")
    log(f"tokens={tokens}")
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=num_threads,
        use_itn=True,
        language=language,
        debug=False,
    )


def transcribe_audio(recognizer, audio_path):
    samples, sample_rate = read_wave_any(audio_path)
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    return (stream.result.text or "").strip()


def parse_serve_request(line):
    text = line.strip()
    if not text:
        return ""
    if not text.startswith("{"):
        return text

    try:
        request = json.loads(text)
    except json.JSONDecodeError:
        return text
    if not isinstance(request, dict):
        return ""
    return request.get("audio") or request.get("audio_path") or request.get("audioPath") or request.get("path") or ""


def serve_stt(args):
    try:
        recognizer = build_recognizer(args.model_dir, args.num_threads, args.language)
    except Exception as error:  # noqa: BLE001 - startup errors should fail the daemon
        log(f"startup failed: {error}")
        return 1

    log("serve mode ready; reading audio paths from stdin")
    for line in sys.stdin:
        audio_path = parse_serve_request(line)
        if not audio_path:
            print(json.dumps({"ok": False, "text": "", "error": "missing_audio"}, ensure_ascii=False), flush=True)
            continue

        try:
            if not os.path.isfile(audio_path):
                log(f"audio file not found: {audio_path}")
                print(json.dumps({"ok": False, "text": "", "error": "audio_not_found"}, ensure_ascii=False), flush=True)
                continue

            text = transcribe_audio(recognizer, audio_path)
            response = {"ok": True, "text": text}
            log(f"transcript={text!r}")
        except Exception as error:  # noqa: BLE001 - keep daemon alive for later requests
            log(f"recognition failed: {error}")
            response = {"ok": False, "text": "", "error": str(error)}

        print(json.dumps(response, ensure_ascii=False), flush=True)

    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--num-threads", type=int, default=2)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if args.serve:
        return serve_stt(args)

    if not args.audio:
        parser.error("--audio is required unless --serve is used")

    if not os.path.isfile(args.audio):
        log(f"audio file not found: {args.audio}")
        print(json.dumps({"text": "", "error": "audio_not_found"}))
        return 2

    try:
        recognizer = build_recognizer(args.model_dir, args.num_threads, args.language)
        text = transcribe_audio(recognizer, args.audio)
    except Exception as error:  # noqa: BLE001 - surface a clean error to the adapter
        log(f"recognition failed: {error}")
        print(json.dumps({"text": "", "error": str(error)}))
        return 1

    log(f"transcript={text!r}")
    print(json.dumps({"text": text}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
