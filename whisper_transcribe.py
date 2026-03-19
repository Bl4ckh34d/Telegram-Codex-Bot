#!/usr/bin/env python3
"""Minimal local Whisper transcription helper for AIDOLON."""

from __future__ import annotations

import argparse
import os
import sys

DEFAULT_ALLOWED_LANGUAGES = ("en", "de", "zh")


def configure_stdio_utf8() -> None:
    # Windows redirected stdio can default to ANSI code pages (for example cp1252),
    # which breaks non-Latin transcripts like Chinese. Force UTF-8 for pipes/files.
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def normalize_language_code(value: str) -> str:
    code = str(value or "").strip().lower().replace("_", "-")
    if not code:
        return ""
    if code == "auto":
        return "auto"
    if code.startswith("en"):
        return "en"
    if code.startswith("de"):
        return "de"
    if code.startswith("zh"):
        return "zh"
    return code


def parse_allowed_languages(value: str) -> set[str]:
    items = [normalize_language_code(v) for v in str(value or "").split(",")]
    langs = {v for v in items if v and v != "auto"}
    if not langs:
        langs = set(DEFAULT_ALLOWED_LANGUAGES)
    return langs


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Transcribe audio with OpenAI Whisper")
    p.add_argument("--audio", required=True, help="Path to local audio file")
    p.add_argument("--model", default="base", help="Whisper model (tiny, base, small, medium, large)")
    p.add_argument("--language", default="auto", help="Language code (e.g. en, de) or 'auto'")
    p.add_argument(
        "--allowed-languages",
        default="en,de,zh",
        help="Comma-separated output language allowlist used when --language=auto",
    )
    p.add_argument("--cache-dir", default="", help="Optional model cache directory")
    return p.parse_args()


def main() -> int:
    configure_stdio_utf8()
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
        allowed_languages = parse_allowed_languages(args.allowed_languages)

        requested_language = normalize_language_code(args.language)
        explicit_language = ""
        if requested_language and requested_language != "auto" and requested_language in allowed_languages:
            explicit_language = requested_language

        kwargs = {"fp16": False}
        if explicit_language:
            kwargs["language"] = explicit_language
        result = model.transcribe(args.audio, **kwargs)
        text = str(result.get("text") or "").strip()

        # Keep transcripts inside the allowed language set when auto-detecting input.
        if not explicit_language:
            detected_language = normalize_language_code(result.get("language") or "")
            if detected_language and detected_language not in allowed_languages:
                translated = model.transcribe(args.audio, fp16=False, task="translate")
                text = str(translated.get("text") or "").strip()

        print(text)
        return 0
    except Exception as exc:  # pragma: no cover
        print(f"Whisper transcription failed: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
