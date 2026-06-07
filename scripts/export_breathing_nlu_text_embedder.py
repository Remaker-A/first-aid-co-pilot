#!/usr/bin/env python3
"""Export a MediaPipe TextEmbedder-compatible breathing NLU model.

The Android app expects a BERT-style TextEmbedder model at:

  <modelsRoot>/nlu/breathing_zh_text_embedder.tflite

This script converts a HuggingFace BERT-like sentence embedding model to TFLite,
then writes the mandatory MediaPipe metadata for three integer inputs:
ids, mask, and segment_ids. It exits non-zero instead of producing a fake or
metadata-less model when the local conversion toolchain is incomplete.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Any


DEPENDENCY_HELP = """
Missing conversion dependency.

Recommended Windows setup:
  py -3.10 -m venv .venv-nlu
  .\\.venv-nlu\\Scripts\\Activate.ps1
  python -m pip install --upgrade pip
  python -m pip install ^
    tensorflow==2.10.1 keras==2.10.0 numpy==1.23.5 ^
    torch transformers==4.38.2 sentencepiece mediapipe==0.10.29

Then rerun:
  python scripts/export_breathing_nlu_text_embedder.py
"""


def fail(message: str, error: BaseException | None = None) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    if error is not None:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
    print(textwrap.dedent(DEPENDENCY_HELP).strip(), file=sys.stderr)
    raise SystemExit(2)


def import_conversion_stack() -> dict[str, Any]:
    if sys.version_info >= (3, 13):
        fail("TensorFlow/MediaPipe metadata tooling is not expected to work on Python 3.13; use Python 3.10.")

    try:
        import numpy as np
        import tensorflow as tf
        from transformers import AutoTokenizer, TFAutoModel
        from mediapipe.tasks.python.metadata.metadata_writers import metadata_writer
    except Exception as exc:  # pragma: no cover - exercised by operator environment.
        fail("Unable to import TensorFlow, Transformers, or MediaPipe metadata writer.", exc)

    return {
        "np": np,
        "tf": tf,
        "AutoTokenizer": AutoTokenizer,
        "TFAutoModel": TFAutoModel,
        "metadata_writer": metadata_writer,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export BAAI/bge-small-zh-v1.5 as a MediaPipe TextEmbedder TFLite model.",
    )
    parser.add_argument(
        "--model-id",
        default="BAAI/bge-small-zh-v1.5",
        help="HuggingFace model id. Must use a WordPiece/BERT vocab.txt tokenizer.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts/models/nlu/breathing_zh_text_embedder.tflite"),
        help="Final metadata-populated .tflite output path.",
    )
    parser.add_argument(
        "--metadata-json",
        type=Path,
        default=None,
        help="Optional metadata JSON output path. Defaults next to the .tflite file.",
    )
    parser.add_argument("--max-seq-len", type=int, default=64)
    parser.add_argument(
        "--from-pt",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Load PyTorch weights into the TensorFlow model when TF weights are absent.",
    )
    parser.add_argument(
        "--float16",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Apply float16 weight quantization during TFLite conversion.",
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Forward trust_remote_code=True to HuggingFace loaders.",
    )
    parser.add_argument("--skip-smoke", action="store_true", help="Skip optional Python TextEmbedder smoke test.")
    return parser.parse_args()


def build_tf_embedder(tf: Any, encoder: Any, max_seq_len: int) -> Any:
    class MeanPoolingTextEmbedder(tf.Module):
        def __init__(self, model: Any) -> None:
            super().__init__()
            self.model = model

        @tf.function(
            input_signature=[
                tf.TensorSpec([1, max_seq_len], tf.int32, name="ids"),
                tf.TensorSpec([1, max_seq_len], tf.int32, name="mask"),
                tf.TensorSpec([1, max_seq_len], tf.int32, name="segment_ids"),
            ],
        )
        def __call__(self, ids: Any, mask: Any, segment_ids: Any) -> Any:
            outputs = self.model(
                input_ids=ids,
                attention_mask=mask,
                token_type_ids=segment_ids,
                training=False,
            )
            token_embeddings = outputs.last_hidden_state
            expanded_mask = tf.cast(tf.expand_dims(mask, -1), token_embeddings.dtype)
            summed = tf.reduce_sum(token_embeddings * expanded_mask, axis=1)
            counts = tf.maximum(
                tf.reduce_sum(expanded_mask, axis=1),
                tf.cast(1e-9, token_embeddings.dtype),
            )
            pooled = summed / counts
            return tf.identity(tf.math.l2_normalize(pooled, axis=1), name="embedding")

    return MeanPoolingTextEmbedder(encoder)


def convert_to_tflite(tf: Any, module: Any, use_float16: bool) -> bytes:
    concrete = module.__call__.get_concrete_function()
    converter = tf.lite.TFLiteConverter.from_concrete_functions([concrete], module)
    if use_float16:
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.target_spec.supported_types = [tf.float16]
    return converter.convert()


def inspect_tensors(tf: Any, tflite_model: bytes) -> tuple[str, str, str]:
    interpreter = tf.lite.Interpreter(model_content=tflite_model)
    input_details = interpreter.get_input_details()
    print("TFLite inputs:")
    for detail in input_details:
        print(f"  - {detail['name']} shape={detail['shape']} dtype={detail['dtype']}")

    def find_tensor(*needles: str) -> str:
        for detail in input_details:
            name = str(detail["name"])
            lowered = name.lower()
            if any(needle in lowered for needle in needles):
                return name
        raise ValueError(f"Unable to find input tensor matching any of: {needles}")

    ids_name = find_tensor("ids", "input_ids")
    mask_name = find_tensor("mask", "attention_mask")
    segment_name = find_tensor("segment_ids", "token_type_ids", "segment")
    return ids_name, mask_name, segment_name


def locate_vocab(saved_tokenizer_dir: Path) -> Path:
    vocab = saved_tokenizer_dir / "vocab.txt"
    if vocab.is_file():
        return vocab
    candidates = sorted(saved_tokenizer_dir.glob("**/vocab.txt"))
    if candidates:
        return candidates[0]
    raise FileNotFoundError("No vocab.txt found. Use a WordPiece/BERT tokenizer model.")


def populate_metadata(
    metadata_writer: Any,
    tflite_model: bytes,
    vocab_file: Path,
    output_path: Path,
    metadata_json_path: Path,
    ids_name: str,
    mask_name: str,
    segment_name: str,
) -> None:
    writer = metadata_writer.MetadataWriter.create(bytearray(tflite_model))
    writer.add_general_info(
        "FirstAid Breathing NLU Text Embedder",
        "Chinese breathing-observation embedder for closed-set emergency intent routing.",
    )
    writer.add_bert_text_input(
        metadata_writer.BertTokenizer(str(vocab_file)),
        ids_name=ids_name,
        mask_name=mask_name,
        segment_name=segment_name,
    )
    writer.add_feature_output(
        name="embedding",
        description="L2-normalized sentence embedding used by the app-side prototype router.",
    )
    model_with_metadata, metadata_json = writer.populate()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_json_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(model_with_metadata)
    metadata_json_path.write_bytes(metadata_json)


def smoke_test(output_path: Path) -> None:
    try:
        from mediapipe.tasks.python.core.base_options import BaseOptions
        from mediapipe.tasks.python.text import text_embedder
    except Exception as exc:
        print(f"Smoke skipped: Python TextEmbedder API unavailable ({exc}).")
        return

    options = text_embedder.TextEmbedderOptions(
        base_options=BaseOptions(model_asset_path=str(output_path)),
    )
    with text_embedder.TextEmbedder.create_from_options(options) as embedder:
        result = embedder.embed("他没有正常呼吸")
        embedding = result.embeddings[0]
        values = embedding.embedding
        print(f"Smoke OK: embedded Chinese sample, dim={len(values)}")


def main() -> int:
    args = parse_args()
    stack = import_conversion_stack()
    tf = stack["tf"]
    AutoTokenizer = stack["AutoTokenizer"]
    TFAutoModel = stack["TFAutoModel"]

    metadata_json_path = args.metadata_json or args.output.with_suffix(".metadata.json")

    with tempfile.TemporaryDirectory(prefix="breathing-nlu-export-") as tmp:
        tmp_dir = Path(tmp)
        tokenizer_dir = tmp_dir / "tokenizer"

        print(f"Loading tokenizer: {args.model_id}")
        tokenizer = AutoTokenizer.from_pretrained(args.model_id, trust_remote_code=args.trust_remote_code)
        tokenizer.save_pretrained(tokenizer_dir)
        vocab_file = locate_vocab(tokenizer_dir)
        print(f"Tokenizer vocab: {vocab_file}")

        print(f"Loading TensorFlow model: {args.model_id} (from_pt={args.from_pt})")
        encoder = TFAutoModel.from_pretrained(
            args.model_id,
            from_pt=args.from_pt,
            trust_remote_code=args.trust_remote_code,
        )
        module = build_tf_embedder(tf, encoder, args.max_seq_len)

        print("Converting to TFLite...")
        tflite_model = convert_to_tflite(tf, module, use_float16=args.float16)
        ids_name, mask_name, segment_name = inspect_tensors(tf, tflite_model)

        print("Writing MediaPipe TextEmbedder metadata...")
        populate_metadata(
            stack["metadata_writer"],
            tflite_model,
            vocab_file,
            args.output,
            metadata_json_path,
            ids_name,
            mask_name,
            segment_name,
        )

    if not args.skip_smoke:
        smoke_test(args.output)

    print(json.dumps({"tflite": str(args.output), "metadata": str(metadata_json_path)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
