#!/usr/bin/env python3
"""Minimal TTS synthesis helper using the Aidolon Server MiraTTS integration.

This script is used by the Telegram bot. It intentionally only reads the few
TTS-related env vars it needs from the Aidolon Server .env file (if provided),
so it doesn't accidentally propagate unrelated secrets.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
import time


ENV_KEYS = (
    "AIDOLON_TTS_MODEL",
    "AIDOLON_TTS_REFERENCE_AUDIO",
    "AIDOLON_TTS_SAMPLE_RATE",
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


def _aidolon_speakable_text(text: str) -> str:
    """Use Aidolon's exact TTS preprocessing if available, else fall back.

    The canonical implementation lives in:
      aidolon_server/server/pipeline/orchestrator_tts.py
    """

    try:
        # Import inside the function so this script still works even if the
        # Aidolon Server dependencies are partially missing.
        from server.pipeline.orchestrator_tts import OrchestratorTTSMixin  # type: ignore

        return OrchestratorTTSMixin._tts_speakable_text(text)  # pylint: disable=protected-access
    except Exception:
        return _fallback_clean_tts_text(text)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Synthesize TTS WAV using Aidolon Server's TTSModel")
    p.add_argument("--server-dir", required=True, help="Path to aidolon_server repo root")
    p.add_argument("--env-file", default="", help="Optional path to aidolon_server/.env")
    p.add_argument("--out-wav", required=True, help="Output WAV file path")
    p.add_argument("--model", default="", help="Override model id/path (AIDOLON_TTS_MODEL)")
    p.add_argument("--reference-audio", default="", help="Override reference audio path (AIDOLON_TTS_REFERENCE_AUDIO)")
    p.add_argument("--sample-rate", default="", help="Override sample rate (AIDOLON_TTS_SAMPLE_RATE)")
    p.add_argument("--text", default="", help="Text to synthesize (if omitted, read from stdin)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    server_dir = Path(args.server_dir).expanduser().resolve()
    if not server_dir.is_dir():
        print(f"TTS: server dir not found: {server_dir}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(server_dir))

    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else (server_dir / ".env")
    env_from_file = _parse_env_file(env_file) if env_file.is_file() else {}

    model = (args.model or os.getenv("AIDOLON_TTS_MODEL") or env_from_file.get("AIDOLON_TTS_MODEL") or "").strip()
    ref = (
        args.reference_audio
        or os.getenv("AIDOLON_TTS_REFERENCE_AUDIO")
        or env_from_file.get("AIDOLON_TTS_REFERENCE_AUDIO")
        or ""
    ).strip()
    sr_raw = (args.sample_rate or os.getenv("AIDOLON_TTS_SAMPLE_RATE") or env_from_file.get("AIDOLON_TTS_SAMPLE_RATE") or "").strip()

    if not model:
        print("TTS: missing model. Set AIDOLON_TTS_MODEL in aidolon_server/.env.", file=sys.stderr)
        return 3
    if not ref:
        print("TTS: missing reference audio. Set AIDOLON_TTS_REFERENCE_AUDIO in aidolon_server/.env.", file=sys.stderr)
        return 3

    sample_rate = 48000
    if sr_raw:
        try:
            sample_rate = int(sr_raw)
        except Exception:
            print(f"TTS: invalid sample rate: {sr_raw}", file=sys.stderr)
            return 3

    ref_path = Path(ref).expanduser()
    if not ref_path.is_absolute():
        ref_path = (server_dir / ref_path).resolve()
    if not ref_path.is_file():
        print(f"TTS: reference audio not found: {ref_path}", file=sys.stderr)
        return 3

    raw_text = args.text if args.text else sys.stdin.read()
    speak = _aidolon_speakable_text(raw_text)
    if not speak:
        print("TTS: empty text.", file=sys.stderr)
        return 4

    out_wav = Path(args.out_wav).expanduser()
    if not out_wav.is_absolute():
        out_wav = out_wav.resolve()
    out_wav.parent.mkdir(parents=True, exist_ok=True)

    try:
        from models.tts import TTSModel  # type: ignore
    except Exception as exc:
        print(f"TTS: import failed: {exc}", file=sys.stderr)
        return 5

    print("TTS: loading model...", file=sys.stderr)
    try:
        tts = TTSModel(
            model_path=model,
            sample_rate=sample_rate,
            reference_audio=str(ref_path),
        )
    except Exception as exc:
        print(f"TTS: init failed: {exc}", file=sys.stderr)
        return 6

    print("TTS: synthesizing...", file=sys.stderr)
    start = time.perf_counter()
    try:
        tts.synthesize_to_file(speak, out_wav)
    except Exception as exc:
        print(f"TTS: synthesis failed: {exc}", file=sys.stderr)
        return 7
    elapsed = time.perf_counter() - start

    if not out_wav.is_file():
        print("TTS: output WAV missing after synthesis.", file=sys.stderr)
        return 8

    print(f"TTS: done ({elapsed:.2f}s).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
