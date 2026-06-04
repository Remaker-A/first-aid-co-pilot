#!/usr/bin/env python3
"""Streaming TTS daemon for sherpa-onnx OfflineTts.

stdin accepts newline-delimited JSON:

  {"type":"speak","id":"a1","text":"你好。继续按压。"}
  {"type":"cancel","id":"a1"}

stdout emits newline-delimited JSON:

  {"type":"ready", ...}
  {"type":"audio_begin","id":"a1","sample_rate":22050}
  {"type":"audio","id":"a1","data":"<base64 pcm16le>","samples":1024}
  {"type":"audio_end","id":"a1","cancelled":false}
  {"type":"error","id":"a1","error":"..."}

The script keeps the TTS model warm and relies on OfflineTts.generate's callback
to surface generated audio as soon as sherpa-onnx makes it available.
"""
import argparse
import base64
import glob
import json
import os
import re
import sys
import threading
import time
from typing import Dict, Iterable, List, Optional

import numpy as np

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - older Python or non-reconfigurable stream
        pass

_stdout_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[sherpa_tts_stream] {message}", file=sys.stderr, flush=True)


def emit(event: Dict) -> None:
    with _stdout_lock:
        print(json.dumps(event, ensure_ascii=False), flush=True)


def find_first(model_dir: str, patterns: Iterable[str]) -> Optional[str]:
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.join(model_dir, "**", pattern), recursive=True))
        if matches:
            return matches[0]
    return None


def find_dict_dir(model_dir: str) -> str:
    for name in ("dict", "dict_dir", "espeak-ng-data"):
        candidate = os.path.join(model_dir, name)
        if os.path.isdir(candidate):
            return candidate
    for marker in ("jieba.dict.utf8", "phontab"):
        matches = sorted(glob.glob(os.path.join(model_dir, "**", marker), recursive=True))
        if matches:
            return os.path.dirname(matches[0])
    return ""


def collect_rule_fsts(model_dir: str) -> str:
    names = ["phone.fst", "date.fst", "number.fst"]
    found = []
    for name in names:
        path = find_first(model_dir, [name])
        if path:
            found.append(to_process_path(path))
    return ",".join(found)


def to_process_path(target_path: str) -> str:
    if not target_path:
        return target_path
    abs_path = os.path.abspath(target_path)
    try:
        rel_path = os.path.relpath(abs_path, os.getcwd())
    except ValueError:
        return abs_path
    if rel_path and not rel_path.startswith("..") and not os.path.isabs(rel_path):
        return rel_path
    return abs_path


def build_tts(model_dir: str, num_threads: int):
    import sherpa_onnx

    model = to_process_path(find_first(model_dir, ["model.onnx", "*.onnx"]) or "")
    tokens = to_process_path(find_first(model_dir, ["tokens.txt"]) or "")
    lexicon = to_process_path(find_first(model_dir, ["lexicon.txt"]) or "")
    if not model or not tokens:
        raise FileNotFoundError(f"could not find TTS model/tokens under {model_dir}.")

    dict_dir = to_process_path(find_dict_dir(model_dir))
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
        max_num_sentences=1,
    )
    if not config.validate():
        raise RuntimeError("invalid sherpa-onnx OfflineTtsConfig; check model files.")
    return sherpa_onnx.OfflineTts(config)


def pcm16_base64(samples: np.ndarray, gain: float = 1.0) -> str:
    arr = np.asarray(samples, dtype=np.float32)
    if gain and gain != 1.0:
        arr = arr * float(gain)
    clipped = np.clip(arr, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def split_clauses(text: str, max_chars: int) -> List[str]:
    normalized = " ".join((text or "").strip().split())
    if not normalized:
        return []

    parts = re.split(r"([。！？!?；;，,\n])", normalized)
    clauses = []
    current = ""
    for part in parts:
        if not part:
            continue
        current += part
        if re.fullmatch(r"[。！？!?；;，,\n]", part) or len(current) >= max_chars:
            clauses.append(current.strip())
            current = ""
    if current.strip():
        clauses.append(current.strip())

    out = []
    for clause in clauses:
        while len(clause) > max_chars:
            out.append(clause[:max_chars].strip())
            clause = clause[max_chars:].strip()
        if clause:
            out.append(clause)
    return out


class StreamingTtsServer:
    def __init__(self, tts, default_sid: int, default_speed: float, default_gain: float, max_clause_chars: int):
        self.tts = tts
        self.default_sid = default_sid
        self.default_speed = default_speed
        self.default_gain = default_gain
        self.max_clause_chars = max_clause_chars
        self.current_thread = None
        self.current_cancel = None
        self.lock = threading.Lock()

    def speak(self, request: Dict) -> None:
        text = (request.get("text") or "").strip()
        request_id = str(request.get("id") or request.get("actionId") or f"tts-{int(time.time() * 1000)}")
        if not text:
            emit({"type": "error", "id": request_id, "error": "missing text"})
            return

        with self.lock:
            if self.current_thread and self.current_thread.is_alive():
                if self.current_cancel:
                    self.current_cancel.set()
                emit({"type": "error", "id": request_id, "error": "tts_busy"})
                return

            cancel_event = threading.Event()
            thread = threading.Thread(
                target=self._run_speak,
                args=(request_id, text, request, cancel_event),
                daemon=True,
            )
            self.current_thread = thread
            self.current_cancel = cancel_event
            thread.start()

    def cancel(self, request: Dict) -> None:
        request_id = request.get("id") or request.get("actionId")
        with self.lock:
            if self.current_cancel:
                self.current_cancel.set()
        emit({"type": "cancelled", "id": request_id})

    def _run_speak(self, request_id: str, text: str, request: Dict, cancel_event: threading.Event) -> None:
        sid = int(request.get("sid", self.default_sid))
        speed = float(request.get("speed", self.default_speed))
        gain = float(request.get("gain", self.default_gain))
        total_samples = 0
        emitted_chunks = 0

        emit(
            {
                "type": "audio_begin",
                "id": request_id,
                "sample_rate": self.tts.sample_rate,
                "text": text,
            }
        )

        try:
            for index, clause in enumerate(split_clauses(text, self.max_clause_chars)):
                if cancel_event.is_set():
                    break

                clause_chunk_count = 0

                def callback(samples: np.ndarray, progress: float):
                    nonlocal clause_chunk_count, emitted_chunks, total_samples
                    if cancel_event.is_set():
                        return 0
                    if samples is None or len(samples) == 0:
                        return 1

                    arr = np.asarray(samples, dtype=np.float32)
                    total_samples += len(arr)
                    emitted_chunks += 1
                    clause_chunk_count += 1
                    emit(
                        {
                            "type": "audio",
                            "id": request_id,
                            "clause_index": index,
                            "sample_rate": self.tts.sample_rate,
                            "samples": len(arr),
                            "progress": float(progress),
                            "data": pcm16_base64(arr, gain),
                        }
                    )
                    return 1

                audio = self.tts.generate(clause, sid=sid, speed=speed, callback=callback)
                if cancel_event.is_set():
                    break

                # Older bindings or very short text may not call the callback.
                if clause_chunk_count == 0 and audio is not None and len(audio.samples) > 0:
                    arr = np.asarray(audio.samples, dtype=np.float32)
                    total_samples += len(arr)
                    emitted_chunks += 1
                    emit(
                        {
                            "type": "audio",
                            "id": request_id,
                            "clause_index": index,
                            "sample_rate": audio.sample_rate,
                            "samples": len(arr),
                            "progress": 1.0,
                            "data": pcm16_base64(arr, gain),
                        }
                    )

            emit(
                {
                    "type": "audio_end",
                    "id": request_id,
                    "sample_rate": self.tts.sample_rate,
                    "samples": total_samples,
                    "chunks": emitted_chunks,
                    "cancelled": cancel_event.is_set(),
                }
            )
        except Exception as error:  # noqa: BLE001 - keep daemon alive for later requests
            log(f"synthesis failed: {error}")
            emit({"type": "error", "id": request_id, "error": str(error)})
        finally:
            with self.lock:
                if self.current_cancel is cancel_event:
                    self.current_thread = None
                    self.current_cancel = None


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


def serve(args) -> int:
    try:
        tts = build_tts(args.model_dir, args.num_threads)
    except Exception as error:  # noqa: BLE001 - startup errors should fail the daemon
        log(f"startup failed: {error}")
        return 1

    server = StreamingTtsServer(
        tts=tts,
        default_sid=args.sid,
        default_speed=args.speed,
        default_gain=args.gain,
        max_clause_chars=args.max_clause_chars,
    )
    emit(
        {
            "type": "ready",
            "provider": "sherpa-onnx",
            "sample_rate": tts.sample_rate,
            "model_dir": args.model_dir,
        }
    )

    for line in sys.stdin:
        try:
            request = parse_request(line)
            if not request:
                continue
            message_type = (request.get("type") or "speak").lower()
            if message_type == "speak":
                server.speak(request)
            elif message_type == "cancel":
                server.cancel(request)
            else:
                raise ValueError(f"unsupported message type: {message_type}")
        except Exception as error:  # noqa: BLE001 - keep daemon alive
            log(f"request failed: {error}")
            emit({"type": "error", "error": str(error)})

    server.cancel({"id": None})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--sid", type=int, default=0)
    parser.add_argument("--speed", type=float, default=1.1)
    parser.add_argument("--gain", type=float, default=1.4)
    parser.add_argument("--num-threads", type=int, default=2)
    parser.add_argument("--max-clause-chars", type=int, default=32)
    args = parser.parse_args()
    return serve(args)


if __name__ == "__main__":
    sys.exit(main())
