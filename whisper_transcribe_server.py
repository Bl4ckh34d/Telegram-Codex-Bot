#!/usr/bin/env python3
"""Persistent Whisper transcription worker for Telegram-Codex-Bot.

Protocol:
- Reads JSON lines from stdin.
- Writes JSON lines to stdout.
- Emits {"type":"ready"} once model is loaded.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_ALLOWED_LANGUAGES = ("en", "de", "zh")


def _normalize_language_code(value: str) -> str:
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


def _parse_allowed_languages(value: str) -> set[str]:
    items = [_normalize_language_code(v) for v in str(value or "").split(",")]
    langs = {v for v in items if v and v != "auto"}
    if not langs:
        langs = set(DEFAULT_ALLOWED_LANGUAGES)
    return langs


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _result(request_id: str, ok: bool, *, text: str = "", error: str = "") -> None:
    out = {"type": "result", "id": request_id, "ok": bool(ok)}
    if ok:
        out["text"] = text
    else:
        out["error"] = error or "whisper request failed"
    _emit(out)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Whisper keepalive server")
    parser.add_argument("--model", default="small", help="Whisper model name")
    parser.add_argument("--default-language", default="auto", help="Default language (or auto)")
    parser.add_argument(
        "--allowed-languages",
        default="en,de,zh",
        help="Comma-separated output language allowlist used when language=auto",
    )
    parser.add_argument("--cache-dir", default="", help="Optional Whisper model cache dir")
    return parser.parse_args()


def _pick_language(request_language: str, default_language: str, allowed_languages: set[str]) -> str:
    req = _normalize_language_code(request_language)
    if req and req != "auto" and req in allowed_languages:
        return req
    base = _normalize_language_code(default_language)
    if base and base != "auto" and base in allowed_languages:
        return base
    return ""


def main() -> int:
    args = _parse_args()
    allowed_languages = _parse_allowed_languages(args.allowed_languages)

    try:
        import whisper  # type: ignore
    except Exception as exc:
        print(f"Whisper server import failed: {exc}", file=sys.stderr)
        return 3

    try:
        model = whisper.load_model(
            args.model,
            download_root=(args.cache_dir or None),
        )
    except Exception as exc:
        print(f"Whisper server model load failed: {exc}", file=sys.stderr)
        return 4

    _emit({"type": "ready"})

    for raw in sys.stdin:
        line = (raw or "").strip()
        if not line:
            continue

        request_id = ""
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id", "")).strip()
            req_type = str(payload.get("type", "")).strip().lower()
        except Exception:
            if request_id:
                _result(request_id, False, error="Invalid JSON payload")
            continue

        if req_type != "transcribe":
            _result(request_id, False, error=f"Unsupported request type: {req_type or '(empty)'}")
            continue

        audio_path_raw = str(payload.get("audio_path", "")).strip()
        if not audio_path_raw:
            _result(request_id, False, error="Missing audio_path")
            continue

        audio_path = Path(audio_path_raw).expanduser().resolve()
        if not audio_path.is_file():
            _result(request_id, False, error=f"Audio file not found: {audio_path}")
            continue

        language = _pick_language(
            str(payload.get("language", "")).strip(),
            str(args.default_language or "").strip(),
            allowed_languages,
        )

        kwargs: dict = {"fp16": False}
        if language:
            kwargs["language"] = language

        try:
            result = model.transcribe(str(audio_path), **kwargs)
            text = str(result.get("text") or "").strip()
            if not language:
                detected_language = _normalize_language_code(result.get("language") or "")
                if detected_language and detected_language not in allowed_languages:
                    translated = model.transcribe(str(audio_path), fp16=False, task="translate")
                    text = str(translated.get("text") or "").strip()
            _result(request_id, True, text=text)
        except Exception as exc:
            _result(request_id, False, error=f"Whisper transcription failed: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
