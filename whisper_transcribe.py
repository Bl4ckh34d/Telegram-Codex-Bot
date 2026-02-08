#!/usr/bin/env python3
"""Minimal local Whisper transcription helper for AIDOLON."""

from __future__ import annotations

import argparse
import os
import sys


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Transcribe audio with OpenAI Whisper")
    p.add_argument("--audio", required=True, help="Path to local audio file")
    p.add_argument("--model", default="base", help="Whisper model (tiny, base, small, medium, large)")
    p.add_argument("--language", default="auto", help="Language code (e.g. en, de) or 'auto'")
    p.add_argument("--cache-dir", default="", help="Optional model cache directory")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if not os.path.isfile(args.audio):
        print(f"Audio file not found: {args.audio}", file=sys.stderr)
        return 2

    try:
        import whisper  # type: ignore
    except Exception as exc:  # pragma: no cover
        print(f"Failed to import whisper: {exc}", file=sys.stderr)
        return 3

    try:
        model = whisper.load_model(
            args.model,
            download_root=(args.cache_dir or None),
        )
        kwargs = {"fp16": False}
        language = (args.language or "").strip().lower()
        if language and language != "auto":
            kwargs["language"] = language
        result = model.transcribe(args.audio, **kwargs)
        text = (result.get("text") or "").strip()
        print(text)
        return 0
    except Exception as exc:  # pragma: no cover
        print(f"Whisper transcription failed: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
