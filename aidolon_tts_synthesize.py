#!/usr/bin/env python3
"""Minimal TTS synthesis helper using MiraTTS.

This script is used by the Telegram bot and is intentionally self-contained.
It does not rely on any external repos.
"""

from __future__ import annotations

import argparse
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
    p.add_argument("--out-wav", required=True, help="Output WAV file path")
    p.add_argument("--env-file", default="", help="Optional .env file to read TTS_* settings from")
    p.add_argument("--model", default="", help="Override model id/path (TTS_MODEL)")
    p.add_argument("--reference-audio", default="", help="Override reference audio path (TTS_REFERENCE_AUDIO)")
    p.add_argument("--sample-rate", default="", help="Override sample rate (TTS_SAMPLE_RATE)")
    p.add_argument("--text", default="", help="Text to synthesize (if omitted, read from stdin)")
    return p.parse_args()


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

    raw_text = args.text if args.text else sys.stdin.read()
    speak = _clean_tts_text(raw_text)
    if not speak:
        print("TTS: empty text.", file=sys.stderr)
        return 4

    out_wav = Path(args.out_wav).expanduser()
    if not out_wav.is_absolute():
        out_wav = out_wav.resolve()
    out_wav.parent.mkdir(parents=True, exist_ok=True)

    try:
        import numpy as np
        from mira.model import MiraTTS
    except Exception as exc:
        print(f"TTS: import failed: {exc}", file=sys.stderr)
        return 5

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

    print("TTS: synthesizing...", file=sys.stderr)
    start = time.perf_counter()
    try:
        audio = tts.generate(speak, ctx)
    except Exception as exc:
        print(f"TTS: synthesis failed: {exc}", file=sys.stderr)
        return 7
    elapsed = time.perf_counter() - start

    try:
        arr = np.asarray(audio).astype(np.float32).reshape(-1)
        arr = np.clip(arr, -1.0, 1.0)
        pcm = (arr * 32767.0).astype(np.int16)

        with wave.open(str(out_wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # int16
            wf.setframerate(sample_rate)
            wf.writeframes(pcm.tobytes())
    except Exception as exc:
        print(f"TTS: wav write failed: {exc}", file=sys.stderr)
        return 7

    if not out_wav.is_file():
        print("TTS: output WAV missing after synthesis.", file=sys.stderr)
        return 8

    print(f"TTS: done ({elapsed:.2f}s).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
