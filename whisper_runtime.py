"""Shared device and precision settings for one-shot and persistent Whisper."""
import os
import re
from functools import lru_cache


def load_model(whisper, name, cache_dir=""):
    device = os.getenv("WHISPER_DEVICE", "auto").strip().lower()
    if not re.fullmatch(r"auto|cpu|cuda(?::\d+)?", device):
        raise ValueError("WHISPER_DEVICE must be auto, cpu, cuda or cuda:N")
    return whisper.load_model(name, device=None if device == "auto" else device,
                              download_root=cache_dir or None)


def use_fp16(model):
    precision = os.getenv("WHISPER_FP16", "auto").strip().lower()
    if precision not in ("auto", "0", "1", "false", "true"):
        raise ValueError("WHISPER_FP16 must be auto, 0 or 1")
    # Whisper's CPU kernels require float32, including the translation retry.
    return model.device.type == "cuda" and precision not in ("0", "false")


@lru_cache(maxsize=1)
def _cpu_translator(whisper, cache_dir):
    return whisper.load_model("small", device="cpu", download_root=cache_dir or None)


def translate_to_english(whisper, model, audio, name, cache_dir, fp16):
    # Turbo transcribes well but was not trained for translation. Keep the
    # existing language fallback using a lazy CPU model, without consuming
    # the GPU headroom reserved for simultaneous speech synthesis.
    if name in ("turbo", "large-v3-turbo"):
        return _cpu_translator(whisper, cache_dir).transcribe(audio, fp16=False, task="translate")
    return model.transcribe(audio, fp16=fp16, task="translate")
