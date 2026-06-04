#!/usr/bin/env python3
"""Streaming STT daemon for sherpa-onnx OnlineRecognizer.

stdin accepts newline-delimited JSON control/audio messages:

  {"type":"start","sample_rate":16000}
  {"type":"audio","data":"<base64 pcm16le>","sample_rate":16000}
  {"type":"end"}
  {"type":"reset"}

stdout emits newline-delimited JSON events:

  {"type":"ready", ...}
  {"type":"partial","text":"..."}
  {"type":"final","text":"...","reason":"endpoint"}
  {"type":"error","error":"..."}

The process is intentionally long-lived so Node can keep the streaming
Zipformer model warm for a whole live session.
"""
import argparse
import base64
import glob
import json
import os
import sys
from typing import Dict, Iterable, Optional

import numpy as np

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - older Python or non-reconfigurable stream
        pass


def log(message: str) -> None:
    print(f"[sherpa_stt_stream] {message}", file=sys.stderr, flush=True)


def emit(event: Dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def find_first(model_dir: str, patterns: Iterable[str]) -> Optional[str]:
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.join(model_dir, "**", pattern), recursive=True))
        if matches:
            return matches[0]
    return None


def find_decoder(model_dir: str) -> Optional[str]:
    matches = sorted(
        glob.glob(os.path.join(model_dir, "**", "decoder*.onnx"), recursive=True)
    )
    for match in matches:
        if ".int8." not in os.path.basename(match):
            return match
    return matches[0] if matches else None


def find_transducer_files(model_dir: str) -> Dict[str, str]:
    files = {
        "encoder": find_first(
            model_dir,
            [
                "encoder*.int8.onnx",
                "encoder*.onnx",
                "*encoder*.int8.onnx",
                "*encoder*.onnx",
            ],
        ),
        # The official bilingual Zipformer example uses the non-int8 decoder
        # with int8 encoder/joiner.
        "decoder": find_decoder(model_dir),
        "joiner": find_first(
            model_dir,
            [
                "joiner*.int8.onnx",
                "joiner*.onnx",
                "*joiner*.int8.onnx",
                "*joiner*.onnx",
            ],
        ),
        "tokens": find_first(model_dir, ["tokens.txt"]),
    }
    missing = [name for name, value in files.items() if not value]
    if missing:
        raise FileNotFoundError(
            f"missing streaming transducer files under {model_dir}: {', '.join(missing)}"
        )
    return files


def build_recognizer(args):
    import sherpa_onnx

    files = find_transducer_files(args.model_dir)
    for name, path in files.items():
        log(f"{name}={path}")

    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=files["tokens"],
        encoder=files["encoder"],
        decoder=files["decoder"],
        joiner=files["joiner"],
        num_threads=args.num_threads,
        provider=args.provider,
        sample_rate=args.sample_rate,
        feature_dim=args.feature_dim,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=args.rule1_min_trailing_silence,
        rule2_min_trailing_silence=args.rule2_min_trailing_silence,
        rule3_min_utterance_length=args.rule3_min_utterance_length,
        decoding_method=args.decoding_method,
        max_active_paths=args.max_active_paths,
        hotwords_file=args.hotwords_file,
        hotwords_score=args.hotwords_score,
        blank_penalty=args.blank_penalty,
    )


def parse_request(line: str) -> Optional[Dict]:
    text = line.strip()
    if not text:
        return None
    try:
        request = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid json: {error}") from error
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    return request


def decode_pcm16_base64(data: str) -> np.ndarray:
    if not data:
        return np.empty(0, dtype=np.float32)
    raw = base64.b64decode(data)
    if len(raw) % 2:
        raw = raw[:-1]
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def decode_samples(request: Dict) -> np.ndarray:
    if isinstance(request.get("samples"), list):
        return np.asarray(request["samples"], dtype=np.float32)
    data = request.get("data") or request.get("audio") or request.get("pcm")
    return decode_pcm16_base64(data or "")


def get_result_text(recognizer, stream) -> str:
    return (recognizer.get_result(stream) or "").strip()


class StreamingSession:
    def __init__(self, recognizer, default_sample_rate: int, tail_padding_seconds: float):
        self.recognizer = recognizer
        self.default_sample_rate = default_sample_rate
        self.tail_padding_seconds = tail_padding_seconds
        self.stream = recognizer.create_stream()
        self.sample_rate = default_sample_rate
        self.last_partial = ""

    def reset(self, sample_rate: Optional[int] = None) -> None:
        self.stream = self.recognizer.create_stream()
        self.sample_rate = int(sample_rate or self.default_sample_rate)
        self.last_partial = ""
        emit({"type": "state", "state": "reset", "sample_rate": self.sample_rate})

    def accept(self, samples: np.ndarray, sample_rate: Optional[int] = None) -> None:
        if samples.size == 0:
            return
        self.sample_rate = int(sample_rate or self.sample_rate or self.default_sample_rate)
        self.stream.accept_waveform(self.sample_rate, samples)
        self.decode_ready()
        self.emit_partial_or_endpoint()

    def decode_ready(self) -> None:
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

    def emit_partial_or_endpoint(self) -> None:
        text = get_result_text(self.recognizer, self.stream)
        if text and text != self.last_partial:
            self.last_partial = text
            emit({"type": "partial", "text": text})

        if self.recognizer.is_endpoint(self.stream):
            if text:
                emit({"type": "final", "text": text, "reason": "endpoint"})
            self.recognizer.reset(self.stream)
            self.last_partial = ""

    def finish(self) -> None:
        if self.tail_padding_seconds > 0:
            padding = np.zeros(
                int(self.tail_padding_seconds * self.sample_rate),
                dtype=np.float32,
            )
            self.stream.accept_waveform(self.sample_rate, padding)

        try:
            self.stream.input_finished()
        except AttributeError:
            pass

        self.decode_ready()
        text = get_result_text(self.recognizer, self.stream)
        emit({"type": "final", "text": text, "reason": "end"})
        self.reset(self.sample_rate)


def serve(args) -> int:
    try:
        recognizer = build_recognizer(args)
    except Exception as error:  # noqa: BLE001 - startup errors should fail the daemon
        log(f"startup failed: {error}")
        return 1

    session = StreamingSession(
        recognizer=recognizer,
        default_sample_rate=args.sample_rate,
        tail_padding_seconds=args.tail_padding_seconds,
    )
    emit(
        {
            "type": "ready",
            "provider": "sherpa-onnx",
            "sample_rate": args.sample_rate,
            "model_dir": args.model_dir,
        }
    )

    for line in sys.stdin:
        try:
            request = parse_request(line)
            if not request:
                continue

            message_type = (request.get("type") or "audio").lower()
            if message_type in ("start", "reset"):
                session.reset(request.get("sample_rate"))
                continue
            if message_type in ("end", "finish"):
                session.finish()
                continue
            if message_type != "audio":
                raise ValueError(f"unsupported message type: {message_type}")

            session.accept(decode_samples(request), request.get("sample_rate"))
        except Exception as error:  # noqa: BLE001 - keep daemon alive for later chunks
            log(f"request failed: {error}")
            emit({"type": "error", "error": str(error)})

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--feature-dim", type=int, default=80)
    parser.add_argument("--num-threads", type=int, default=1)
    parser.add_argument("--provider", default="cpu")
    parser.add_argument("--decoding-method", default="greedy_search")
    parser.add_argument("--max-active-paths", type=int, default=4)
    parser.add_argument("--hotwords-file", default="")
    parser.add_argument("--hotwords-score", type=float, default=1.5)
    parser.add_argument("--blank-penalty", type=float, default=0.0)
    parser.add_argument("--rule1-min-trailing-silence", type=float, default=2.4)
    # rule2 fires after non-empty text has been decoded: this is the real
    # "the speaker finished a sentence" timer. 0.35s was far below sherpa's
    # 1.2s default and cut speakers off mid-sentence on every natural pause
    # (breath / hesitation). 0.8s tolerates in-sentence pauses while still
    # responding promptly; raise toward 1.0-1.2 if it still feels too eager.
    parser.add_argument("--rule2-min-trailing-silence", type=float, default=0.8)
    parser.add_argument("--rule3-min-utterance-length", type=float, default=20.0)
    parser.add_argument("--tail-padding-seconds", type=float, default=0.2)
    args = parser.parse_args()
    return serve(args)


if __name__ == "__main__":
    sys.exit(main())
