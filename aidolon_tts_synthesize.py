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
import unicodedata
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
    candidate = unicodedata.normalize("NFKC", candidate)

    # Remove markdown code fences and inline backticks.
    candidate = re.sub(r"```.*?```", " ", candidate, flags=re.DOTALL)
    candidate = re.sub(r"(?<![A-Za-z0-9])`([^`\n]+?)`(?![A-Za-z0-9])", r"\1", candidate)

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

    # Collapse whitespace.
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


def _reload_tts_runtime(model: str, ref_path: Path, tts_factory):
    tts = tts_factory(model)
    ctx = tts.encode_audio(str(ref_path))
    return tts, ctx


def _generate_with_recovery(tts, ctx, speak: str, *, model: str, ref_path: Path, tts_factory):
    try:
        return tts.generate(speak, ctx), tts, ctx
    except Exception as exc:
        if not _is_tokenizer_input_type_error(exc):
            raise
        print(
            "TTS: tokenizer input type error detected; reloading runtime and retrying once.",
            file=sys.stderr,
        )
        tts_retry, ctx_retry = _reload_tts_runtime(model, ref_path, tts_factory)
        audio_retry = tts_retry.generate(speak, ctx_retry)
        return audio_retry, tts_retry, ctx_retry


def _synthesize_batch_with_recovery(tts, ctx, texts: list[str], *, model: str, ref_path: Path, tts_factory):
    try:
        formatted_prompts = [tts.codec.format_prompt(t, ctx, None) for t in texts]
        responses = tts.pipe(formatted_prompts, gen_config=tts.gen_config, do_preprocess=False)
        if not isinstance(responses, list):
            raise TypeError(f"Unexpected pipeline response type: {type(responses)}")
        if len(responses) != len(texts):
            raise RuntimeError(f"Unexpected pipeline response count: got {len(responses)}, expected {len(texts)}")
        return [tts.codec.decode(resp.text, ctx) for resp in responses], tts, ctx
    except Exception as exc:
        if not _is_tokenizer_input_type_error(exc):
            raise
        print(
            "TTS: tokenizer input type error detected in batch path; reloading runtime and retrying once.",
            file=sys.stderr,
        )
        tts_retry, ctx_retry = _reload_tts_runtime(model, ref_path, tts_factory)
        formatted_prompts = [tts_retry.codec.format_prompt(t, ctx_retry, None) for t in texts]
        responses = tts_retry.pipe(formatted_prompts, gen_config=tts_retry.gen_config, do_preprocess=False)
        if not isinstance(responses, list):
            raise TypeError(f"Unexpected pipeline response type: {type(responses)}")
        if len(responses) != len(texts):
            raise RuntimeError(f"Unexpected pipeline response count: got {len(responses)}, expected {len(texts)}")
        return [tts_retry.codec.decode(resp.text, ctx_retry) for resp in responses], tts_retry, ctx_retry


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
        # Batch pipe path is more stable than repeated per-item generate() calls.
        try:
            audios, tts, ctx = _synthesize_batch_with_recovery(
                tts,
                ctx,
                texts,
                model=model,
                ref_path=ref_path,
                tts_factory=MiraTTS,
            )
            for idx, (audio, out_wav) in enumerate(zip(audios, out_wavs)):
                try:
                    _write_wav(out_wav, audio, sample_rate)
                except Exception as exc:
                    print(f"TTS: wav write failed (item {idx}): {exc}", file=sys.stderr)
                    return 7

                if not out_wav.is_file():
                    print(f"TTS: output WAV missing after synthesis (item {idx}).", file=sys.stderr)
                    return 8
        except Exception as exc:
            print(f"TTS: synthesis failed (batch): {exc}", file=sys.stderr)
            return 7

        for out_wav in out_wavs:
            print(str(out_wav), file=sys.stdout)
    else:
        for idx, (speak, out_wav) in enumerate(zip(texts, out_wavs)):
            try:
                audio, tts, ctx = _generate_with_recovery(
                    tts,
                    ctx,
                    speak,
                    model=model,
                    ref_path=ref_path,
                    tts_factory=MiraTTS,
                )
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
