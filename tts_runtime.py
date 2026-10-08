"""Shared MiraTTS setup for Windows CUDA and bounded KV-cache usage."""
import os
from pathlib import Path

_dll_handles = []


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
