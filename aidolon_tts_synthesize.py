#!/usr/bin/env python3
"""Minimal TTS synthesis helper using MiraTTS.

This script is used by the Telegram bot and is intentionally self-contained.
It does not rely on any external repos.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import wave


ENV_KEYS = (
    "TTS_MODEL",
    "TTS_REFERENCE_AUDIO",
    "TTS_SAMPLE_RATE",
)

# HuggingFace tokenizers can spawn threads; in practice this has caused rare, hard-to-debug
# issues when combined with other thread-based runtimes. Disable by default (caller can override).
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _parse_env_file(env_path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return out
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        key = k.strip()
        val = v.strip()
        if not key or key not in ENV_KEYS:
            continue
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        out[key] = val
    return out


def _fallback_clean_tts_text(text: str) -> str:
    candidate = (text or "").strip()
    if not candidate:
        return candidate

    # Remove markdown code fences and inline backticks.
    candidate = re.sub(r"```.*?```", " ", candidate, flags=re.DOTALL)
    candidate = re.sub(r"`([^`]+?)`", r"\1", candidate)

    # Links: keep label text.
    candidate = re.sub(r"!?\[([^\]]+?)\]\([^\)]+\)", r"\1", candidate)

    # Strip leading markdown bullets/headings per line.
    candidate = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", candidate)
    candidate = re.sub(r"(?m)^\s{0,3}[-*+]\s+", "", candidate)

    # Emphasis markers.
    for pat in (r"\*\*([^*]+?)\*\*", r"\*([^*]+?)\*", r"__([^_]+?)__", r"_([^_]+?)_", r"~~([^~]+?)~~"):
        prev = None
        while prev != candidate:
            prev = candidate
            candidate = re.sub(pat, r"\1", candidate)

    # Collapse whitespace.
    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate


def _clean_tts_text(text: str) -> str:
    return _fallback_clean_tts_text(text)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Synthesize TTS WAV using MiraTTS")
    # In batch mode, use --out-wav-base instead.
    p.add_argument("--out-wav", default="", help="Output WAV file path (single mode)")
    p.add_argument(
        "--out-wav-base",
        default="",
        help="Batch mode output base path (no extension). Writes <base>-000.wav, <base>-001.wav, ...",
    )
    p.add_argument(
        "--batch-jsonl",
        action="store_true",
        help="Read stdin as JSONL objects ({\"text\": \"...\"}) and synthesize each line into its own WAV file.",
    )
    p.add_argument("--env-file", default="", help="Optional .env file to read TTS_* settings from")
    p.add_argument("--model", default="", help="Override model id/path (TTS_MODEL)")
    p.add_argument("--reference-audio", default="", help="Override reference audio path (TTS_REFERENCE_AUDIO)")
    p.add_argument("--sample-rate", default="", help="Override sample rate (TTS_SAMPLE_RATE)")
    p.add_argument("--text", default="", help="Text to synthesize (if omitted, read from stdin)")
    return p.parse_args()


def _resolve_output_base(path_str: str) -> str:
    base = (path_str or "").strip()
    if not base:
        return ""
    # Avoid surprising names if callers accidentally pass a filename with extension.
    lowered = base.lower()
    for ext in (".wav", ".ogg"):
        if lowered.endswith(ext):
            base = base[: -len(ext)]
            lowered = base.lower()
    return str(Path(base).expanduser().resolve())


def _write_wav(out_wav: Path, audio, sample_rate: int) -> None:
    import numpy as np

    arr = np.asarray(audio).astype(np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # int16
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


def main() -> int:
    args = parse_args()

    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else None
    env_from_file = _parse_env_file(env_file) if env_file and env_file.is_file() else {}

    model = (args.model or os.getenv("TTS_MODEL") or env_from_file.get("TTS_MODEL") or "").strip()
    ref = (
        args.reference_audio
        or os.getenv("TTS_REFERENCE_AUDIO")
        or env_from_file.get("TTS_REFERENCE_AUDIO")
        or ""
    ).strip()
    sr_raw = (args.sample_rate or os.getenv("TTS_SAMPLE_RATE") or env_from_file.get("TTS_SAMPLE_RATE") or "").strip()

    if not model:
        print("TTS: missing model. Set TTS_MODEL.", file=sys.stderr)
        return 3
    if not ref:
        print("TTS: missing reference audio. Set TTS_REFERENCE_AUDIO.", file=sys.stderr)
        return 3

    sample_rate = 48000
    if sr_raw:
        try:
            sample_rate = int(sr_raw)
        except Exception:
            print(f"TTS: invalid sample rate: {sr_raw}", file=sys.stderr)
            return 3

    ref_path = Path(ref).expanduser().resolve()
    if not ref_path.is_file():
        print(f"TTS: reference audio not found: {ref_path}", file=sys.stderr)
        return 3

    try:
        from mira.model import MiraTTS
    except Exception as exc:
        print(f"TTS: import failed: {exc}", file=sys.stderr)
        return 5

    texts: list[str] = []
    out_wavs: list[Path] = []

    if args.batch_jsonl:
        out_base = _resolve_output_base(args.out_wav_base)
        if not out_base:
            print("TTS: missing --out-wav-base for batch mode.", file=sys.stderr)
            return 3

        for raw in sys.stdin.read().splitlines():
            line = (raw or "").strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except Exception as exc:
                print(f"TTS: invalid JSONL line: {exc}", file=sys.stderr)
                return 4

            if isinstance(payload, str):
                raw_text = payload
            elif isinstance(payload, dict):
                raw_text = payload.get("text", "")
            else:
                raw_text = ""

            speak = _clean_tts_text(str(raw_text or ""))
            if speak:
                texts.append(speak)

        if not texts:
            print("TTS: empty batch.", file=sys.stderr)
            return 4

        out_wavs = [Path(f"{out_base}-{idx:03}.wav") for idx in range(len(texts))]
    else:
        raw_text = args.text if args.text else sys.stdin.read()
        speak = _clean_tts_text(raw_text)
        if not speak:
            print("TTS: empty text.", file=sys.stderr)
            return 4

        out_wav_str = (args.out_wav or "").strip()
        if not out_wav_str:
            print("TTS: missing --out-wav.", file=sys.stderr)
            return 3

        out_wav = Path(out_wav_str).expanduser()
        if not out_wav.is_absolute():
            out_wav = out_wav.resolve()
        texts = [speak]
        out_wavs = [out_wav]

    print("TTS: loading MiraTTS...", file=sys.stderr)
    try:
        tts = MiraTTS(model)
    except Exception as exc:
        print(f"TTS: init failed: {exc}", file=sys.stderr)
        return 6

    print("TTS: encoding reference audio...", file=sys.stderr)
    try:
        ctx = tts.encode_audio(str(ref_path))
    except Exception as exc:
        print(f"TTS: reference encode failed: {exc}", file=sys.stderr)
        return 6

    if args.batch_jsonl:
        print(f"TTS: synthesizing batch ({len(texts)} item(s))...", file=sys.stderr)
    else:
        print("TTS: synthesizing...", file=sys.stderr)

    started = time.perf_counter()

    if args.batch_jsonl:
        # One pipeline call for the whole batch is more robust than calling generate() repeatedly.
        try:
            formatted_prompts = [tts.codec.format_prompt(t, ctx, None) for t in texts]
            responses = tts.pipe(formatted_prompts, gen_config=tts.gen_config, do_preprocess=False)
            if not isinstance(responses, list):
                raise TypeError(f"Unexpected pipeline response type: {type(responses)}")
            if len(responses) != len(texts):
                raise RuntimeError(f"Unexpected pipeline response count: got {len(responses)}, expected {len(texts)}")
        except Exception as exc:
            print(f"TTS: synthesis failed (batch): {exc}", file=sys.stderr)
            return 7

        for idx, (resp, out_wav) in enumerate(zip(responses, out_wavs)):
            try:
                audio = tts.codec.decode(resp.text, ctx)
            except Exception as exc:
                print(f"TTS: decode failed (item {idx}): {exc}", file=sys.stderr)
                return 7

            try:
                _write_wav(out_wav, audio, sample_rate)
            except Exception as exc:
                print(f"TTS: wav write failed (item {idx}): {exc}", file=sys.stderr)
                return 7

            if not out_wav.is_file():
                print(f"TTS: output WAV missing after synthesis (item {idx}).", file=sys.stderr)
                return 8

            print(str(out_wav), file=sys.stdout)
    else:
        for idx, (speak, out_wav) in enumerate(zip(texts, out_wavs)):
            try:
                audio = tts.generate(speak, ctx)
            except Exception as exc:
                print(f"TTS: synthesis failed: {exc}", file=sys.stderr)
                return 7

            try:
                _write_wav(out_wav, audio, sample_rate)
            except Exception as exc:
                print(f"TTS: wav write failed: {exc}", file=sys.stderr)
                return 7

            if not out_wav.is_file():
                print("TTS: output WAV missing after synthesis.", file=sys.stderr)
                return 8

    elapsed = time.perf_counter() - started
    print(f"TTS: done ({elapsed:.2f}s).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
