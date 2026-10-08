"""Shared MiraTTS setup for Windows CUDA and bounded KV-cache usage."""
import os
import copy
import re
from pathlib import Path

_dll_handles = []
_chinese_converter = None


def normalize_chinese_tts(text):
    """Normalize speech input only; keep the visible response and vocabulary intact."""
    global _chinese_converter
    if os.getenv("TTS_CHINESE_SIMPLIFY", "1").lower() in ("0", "false", "no", "off") or not re.search(r"[\u3400-\u9fff]", text):
        return text
    if _chinese_converter is None:
        from opencc import OpenCC
        _chinese_converter = OpenCC("t2s")
    return _chinese_converter.convert(text)


def resident_mira_factory(mira_class, pipeline_factory, engine_config_factory):
    """Keep independent language pipelines with one shared Mira audio codec.

    MiraTTS has no codec-injection argument. Its installed constructor creates
    only pipe, gen_config and codec; preserve those interfaces without editing
    site-packages. The server serializes all synthesis using the shared codec.
    """
    codec = None
    generation_config = None

    def factory(model, **options):
        nonlocal codec, generation_config
        if codec is None:
            instance = mira_class(model, **options)
            codec = instance.codec
            generation_config = copy.deepcopy(instance.gen_config)
            return instance
        instance = mira_class.__new__(mira_class)
        instance.codec = codec
        instance.gen_config = copy.deepcopy(generation_config)
        config = engine_config_factory(tp=1, dtype="bfloat16", **options)
        instance.pipe = pipeline_factory(model, backend_config=config)
        return instance

    return factory


def prepare_cuda():
    if os.name != "nt" or _dll_handles:
        return
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("MiraTTS requires CUDA-enabled PyTorch and an NVIDIA GPU")
    torch_dir = Path(torch.__file__).resolve().parent
    # PyTorch Windows wheels ship CUDA/cuDNN DLLs. LMDeploy additionally
    # expects CUDA_PATH/bin, even without a separate CUDA Toolkit install.
    _dll_handles.append(os.add_dll_directory(str(torch_dir / "lib")))
    os.environ.setdefault("CUDA_PATH", str(torch_dir))


def create_tts(factory, model):
    cache_fraction = float(os.getenv("TTS_GPU_CACHE_FRACTION", "0.2"))
    if not 0 < cache_fraction < 1:
        raise ValueError("TTS_GPU_CACHE_FRACTION must be greater than 0 and less than 1")
    # TurboMind prefix reuse can stall on successive different prompts on Windows.
    # Keep the model resident, but avoid that optimization by default on this host.
    prefix_cache = os.getenv("TTS_PREFIX_CACHING", "0" if os.name == "nt" else "1").strip().lower()
    if prefix_cache not in ("0", "1", "false", "true", "no", "yes", "off", "on"):
        raise ValueError("TTS_PREFIX_CACHING must be a boolean (0 or 1)")
    prepare_cuda()
    return factory(model, cache_max_entry_count=cache_fraction,
                   enable_prefix_caching=prefix_cache in ("1", "true", "yes", "on"))
