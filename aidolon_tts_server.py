#!/usr/bin/env python3
"""Persistent MiraTTS synthesis worker for Telegram-Codex-Bot.

Protocol:
- Reads JSON lines from stdin.
- Writes JSON lines to stdout.
- Emits {"type":"ready"} once model and reference context are loaded.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
import wave

import numpy as np


# Match one-shot script defaults.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _result(request_id: str, ok: bool, *, data: dict | None = None, error: str = "") -> None:
    out = {"type": "result", "id": request_id, "ok": bool(ok)}
    if ok:
        if data:
            out.update(data)
    else:
        out["error"] = error or "tts request failed"
    _emit(out)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MiraTTS keepalive server")
    parser.add_argument("--model", required=True, help="MiraTTS model id/path")
    parser.add_argument("--reference-audio", required=True, help="Reference WAV path")
    parser.add_argument("--sample-rate", default="48000", help="Output WAV sample rate")
    return parser.parse_args()


def _fallback_clean_tts_text(text: str) -> str:
    candidate = (text or "").strip()
    if not candidate:
        return candidate
    candidate = unicodedata.normalize("NFKC", candidate)

    candidate = re.sub(r"```.*?```", " ", candidate, flags=re.DOTALL)
    candidate = re.sub(r"(?<![A-Za-z0-9])`([^`\n]+?)`(?![A-Za-z0-9])", r"\1", candidate)
    candidate = re.sub(r"!?\[([^\]]+?)\]\([^\)]+\)", r"\1", candidate)
    candidate = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", candidate)
    candidate = re.sub(r"(?m)^\s{0,3}[-*+]\s+", "", candidate)

    for pattern in (
        r"\*\*([^*]+?)\*\*",
        r"\*([^*]+?)\*",
        r"__([^_]+?)__",
        r"_([^_]+?)_",
        r"~~([^~]+?)~~",
    ):
        previous = None
        while previous != candidate:
            previous = candidate
            candidate = re.sub(pattern, r"\1", candidate)

    # Normalize punctuation variants that TTS may pronounce inconsistently.
    candidate = re.sub(r"\\+([`´‘’‚‛ʼʻʹʽʾʿ′＇ꞌ'])", r"\1", candidate)
    candidate = re.sub(r"[\u200B-\u200D\u2060\uFEFF]", "", candidate)
    candidate = re.sub(r"[`´‘’‚‛ʼʻʹʽʾʿ′＇ꞌ]", "'", candidate)
    candidate = re.sub(r'[“”„‟«»]', '"', candidate)
    candidate = re.sub(r"[‐‑‒–—―]", "-", candidate)

    # Expand common contractions for smoother synthesis while avoiding possessive "'s" terms.
    contraction_rules = (
        (r"\b([A-Za-z]+)\s*'\s*m\b", r"\1 am"),
        (r"\b([A-Za-z]+)\s*'\s*re\b", r"\1 are"),
        (r"\b([A-Za-z]+)\s*'\s*ve\b", r"\1 have"),
        (r"\b([A-Za-z]+)\s*'\s*ll\b", r"\1 will"),
        (r"\b([A-Za-z]+)\s*'\s*d\b", r"\1 would"),
        (r"\b([A-Za-z]+)\s*n\s*'\s*t\b", r"\1 not"),
        (
            r"\b(?:it|he|she|that|there|here|what|who|where|when|how)\s*'\s*s\b",
            lambda m: re.sub(r"\s*'\s*s$", " is", m.group(0), flags=re.IGNORECASE),
        ),
    )
    for pattern, replacement in contraction_rules:
        candidate = re.sub(pattern, replacement, candidate, flags=re.IGNORECASE)

    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate


def _clean_tts_text(text: str) -> str:
    return _fallback_clean_tts_text(text)


def _is_tokenizer_input_type_error(exc: Exception) -> bool:
    msg = str(exc or "")
    if not msg:
        return False
    lowered = msg.lower()
    if "textencodeinput must be union[textinputsequence, tuple[inputsequence, inputsequence]]" in lowered:
        return True
    if "callback failed during tokenizer batch encoding" in lowered:
        return True
    return (
        "exception calling callback for <future" in lowered
        and ("tokenization_utils_fast.py" in lowered or "_batch_encode_plus" in lowered or "lmdeploy/pipeline.py" in lowered)
    )


def _reload_tts_runtime(state: dict) -> None:
    model = str(state.get("model", "") or "")
    ref_path = state.get("default_ref_path")
    if not model:
        raise RuntimeError("Cannot reload TTS runtime: missing model")
    if not isinstance(ref_path, Path):
        raise RuntimeError("Cannot reload TTS runtime: missing reference audio path")
    tts = state.get("tts_factory")(model)
    state["tts"] = tts
    state["ctx_cache"] = {}
    _get_ctx_for_ref_path(state, ref_path)


def _resolve_request_ref_path(state: dict, payload: dict) -> Path:
    raw = str(payload.get("reference_audio", "") or "").strip()
    if not raw:
        ref_path = state.get("default_ref_path")
        if isinstance(ref_path, Path):
            return ref_path
        raise RuntimeError("TTS runtime missing default reference audio path")

    ref_path = Path(raw).expanduser().resolve()
    if not ref_path.is_file():
        raise RuntimeError(f"Reference audio not found: {ref_path}")
    return ref_path


def _get_ctx_for_ref_path(state: dict, ref_path: Path):
    if not isinstance(ref_path, Path):
        raise RuntimeError("Missing reference audio path")
    tts = state.get("tts")
    if tts is None:
        raise RuntimeError("TTS runtime unavailable")

    cache = state.get("ctx_cache")
    if not isinstance(cache, dict):
        cache = {}
        state["ctx_cache"] = cache

    key = str(ref_path)
    if key in cache:
        return cache[key]

    ctx = tts.encode_audio(str(ref_path))
    cache[key] = ctx
    return ctx


def _generate_with_recovery(state: dict, text: str, ref_path: Path):
    tts = state.get("tts")
    if tts is None:
        raise RuntimeError("TTS runtime unavailable")
    ctx = _get_ctx_for_ref_path(state, ref_path)
    try:
        return tts.generate(text, ctx)
    except Exception as exc:
        if not _is_tokenizer_input_type_error(exc):
            raise
        print(
            "TTS server: tokenizer input type error detected; reloading runtime and retrying once.",
            file=sys.stderr,
        )
        _reload_tts_runtime(state)
        tts_retry = state.get("tts")
        ctx_retry = _get_ctx_for_ref_path(state, ref_path)
        return tts_retry.generate(text, ctx_retry)


def _synthesize_batch_with_recovery(state: dict, cleaned: list[str], ref_path: Path):
    tts = state.get("tts")
    if tts is None:
        raise RuntimeError("TTS runtime unavailable")
    ctx = _get_ctx_for_ref_path(state, ref_path)
    try:
        prompts = [tts.codec.format_prompt(text, ctx, None) for text in cleaned]
        responses = tts.pipe(prompts, gen_config=tts.gen_config, do_preprocess=False)
        if not isinstance(responses, list):
            raise TypeError(f"Unexpected response type: {type(responses)}")
        if len(responses) != len(cleaned):
            raise RuntimeError(f"Unexpected response count: got {len(responses)}, expected {len(cleaned)}")
        return [tts.codec.decode(response.text, ctx) for response in responses]
    except Exception as exc:
        if not _is_tokenizer_input_type_error(exc):
            raise
        print(
            "TTS server: tokenizer input type error detected in batch path; reloading runtime and retrying once.",
            file=sys.stderr,
        )
        _reload_tts_runtime(state)
        tts_retry = state.get("tts")
        ctx_retry = _get_ctx_for_ref_path(state, ref_path)
        prompts = [tts_retry.codec.format_prompt(text, ctx_retry, None) for text in cleaned]
        responses = tts_retry.pipe(prompts, gen_config=tts_retry.gen_config, do_preprocess=False)
        if not isinstance(responses, list):
            raise TypeError(f"Unexpected response type: {type(responses)}")
        if len(responses) != len(cleaned):
            raise RuntimeError(f"Unexpected response count: got {len(responses)}, expected {len(cleaned)}")
        return [tts_retry.codec.decode(response.text, ctx_retry) for response in responses]


def _write_wav(out_wav: Path, audio, sample_rate: int) -> None:
    arr = np.asarray(audio).astype(np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())


def _handle_synthesize(request_id: str, payload: dict, *, state: dict, sample_rate: int) -> None:
    text = _clean_tts_text(str(payload.get("text", "") or ""))
    out_raw = str(payload.get("out_wav", "") or "").strip()

    if not text:
        _result(request_id, False, error="Empty text")
        return
    if not out_raw:
        _result(request_id, False, error="Missing out_wav")
        return

    out_wav = Path(out_raw).expanduser().resolve()

    try:
        ref_path = _resolve_request_ref_path(state, payload)
        audio = _generate_with_recovery(state, text, ref_path)
        _write_wav(out_wav, audio, sample_rate)
        if not out_wav.is_file():
            raise RuntimeError("Output WAV file missing after synthesis")
        _result(request_id, True, data={"out_wav": str(out_wav)})
    except Exception as exc:
        _result(request_id, False, error=f"TTS synthesis failed: {exc}")


def _handle_synthesize_batch(request_id: str, payload: dict, *, state: dict, sample_rate: int) -> None:
    texts_raw = payload.get("texts", [])
    out_base_raw = str(payload.get("out_wav_base", "") or "").strip()

    if not isinstance(texts_raw, list) or len(texts_raw) == 0:
        _result(request_id, False, error="Missing texts array")
        return
    if not out_base_raw:
        _result(request_id, False, error="Missing out_wav_base")
        return

    cleaned = []
    for item in texts_raw:
        line = _clean_tts_text(str(item or ""))
        if line:
            cleaned.append(line)

    if len(cleaned) == 0:
        _result(request_id, False, error="All batch texts were empty")
        return

    out_base = Path(out_base_raw).expanduser().resolve()
    out_paths = [Path(f"{out_base}-{idx:03}.wav") for idx in range(len(cleaned))]

    try:
        ref_path = _resolve_request_ref_path(state, payload)
        audios = _synthesize_batch_with_recovery(state, cleaned, ref_path)
        for idx, (audio, out_wav) in enumerate(zip(audios, out_paths)):
            _write_wav(out_wav, audio, sample_rate)
            if not out_wav.is_file():
                raise RuntimeError(f"Output WAV missing for index {idx}")

        _result(
            request_id,
            True,
            data={
                "count": len(out_paths),
                "out_wav_paths": [str(path) for path in out_paths],
            },
        )
    except Exception as exc:
        _result(request_id, False, error=f"TTS batch synthesis failed: {exc}")


def main() -> int:
    args = _parse_args()

    try:
        sample_rate = int(str(args.sample_rate or "48000").strip())
    except Exception:
        print(f"TTS server invalid sample rate: {args.sample_rate}", file=sys.stderr)
        return 3

    ref_path = Path(args.reference_audio).expanduser().resolve()
    if not ref_path.is_file():
        print(f"TTS server reference audio not found: {ref_path}", file=sys.stderr)
        return 3

    try:
        from mira.model import MiraTTS
    except Exception as exc:
        print(f"TTS server import failed: {exc}", file=sys.stderr)
        return 4

    try:
        state = {
            "model": str(args.model),
            "default_ref_path": ref_path,
            "tts_factory": MiraTTS,
            "tts": None,
            "ctx_cache": {},
        }
        _reload_tts_runtime(state)
    except Exception as exc:
        print(f"TTS server init failed: {exc}", file=sys.stderr)
        return 5

    _emit({"type": "ready"})

    for raw in sys.stdin:
        line = (raw or "").strip()
        if not line:
            continue

        request_id = ""
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id", "")).strip()
            request_type = str(payload.get("type", "")).strip().lower()
        except Exception:
            if request_id:
                _result(request_id, False, error="Invalid JSON payload")
            continue

        if request_type == "synthesize":
            _handle_synthesize(request_id, payload, state=state, sample_rate=sample_rate)
            continue

        if request_type == "synthesize_batch":
            _handle_synthesize_batch(request_id, payload, state=state, sample_rate=sample_rate)
            continue

        _result(request_id, False, error=f"Unsupported request type: {request_type or '(empty)'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
