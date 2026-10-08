# Windows speech setup for a 12 GB NVIDIA GPU

Keep private settings in `.env`. The repository defaults remain suitable for
smaller machines; this profile was measured on an RTX 4070 SUPER, Ryzen 9 9950X,
and 64 GB RAM on Windows.

```dotenv
CODEX_USE_WSL=0
CODEX_WORKDIR=
CODEX_MODEL=gpt-6.1-sol
CODEX_MODEL_CHOICES=gpt-6.1-sol,gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna
WHISPER_MODEL=turbo
WHISPER_DEVICE=cuda
WHISPER_FP16=auto
WHISPER_KEEPALIVE=1
WHISPER_PREWARM_ON_STARTUP=1
WHISPER_UPGRADE=0
TTS_PREWARM_ON_STARTUP=1
TTS_GPU_CACHE_FRACTION=0.05
```

Explicit model choices take precedence in the 12-button picker, even if the
native catalog is large or stale. Reasoning choices use native metadata when
available, with model-specific fallbacks. Listing a model is not proof of
account access; test a real request. Both Sol 6.1 and Astra were successfully
invoked during this setup.

## Setup and migration

Use Node 22.19 or newer. `start.cmd` also recognizes an optional portable Node
installation at `runtime/node/node.exe`; obtain its Windows ZIP and checksum
from [nodejs.org](https://nodejs.org/en/download). This avoids replacing Node
used by unrelated applications. The tested portable version was 22.23.3.

Python virtual environments copied from another Windows account can retain
the original account's interpreter path. Back up `pyvenv.cfg` before repairing:

```powershell
py -3.12 -m venv .venv
py -3.12 -m venv .tts-venv
.\setup-whisper-venv.cmd
.\setup-tts.cmd
```

The Whisper installer now detects a CPU-only PyTorch installation on NVIDIA
systems and installs `torch==2.8.0+cu128`. Working installations are reused at
startup; `WHISPER_UPGRADE=1` explicitly requests a Whisper package upgrade.
With `WHISPER_DEVICE=cpu`, no CUDA installation is requested. `auto` selects
CUDA if available; `cuda` fails visibly if CUDA is unavailable. Both workers
use FP16 on CUDA by default and FP32 on CPU. `WHISPER_FP16=0` forces FP32.

MiraTTS uses the CUDA DLLs shipped by its PyTorch Windows wheel. The shared
runtime prepares DLL lookup before LMDeploy initialization, including recovery
reloads. A separate CUDA Toolkit is not required for the tested wheels.
An existing `CUDA_PATH` is preserved and must point to a valid installation.

Also review private state after moving PCs: `.env` working directories and
workspace paths in `runtime/state.json` may still refer to the old account.
Keep backups and preserve unrelated local changes before pulling upstream.

## Memory and measured latency

`TTS_GPU_CACHE_FRACTION` reserves a fraction of free GPU memory for LMDeploy's
KV cache. Increasing it does not inherently improve single-request latency.
With both workers resident, reducing it from `0.2` to `0.05` left about
1.8 GiB free after inference, compared with about 0.4 GiB at `0.2`.

On 8 October 2026, the persistent-worker English roundtrip measured:

| Operation | Measured time |
| --- | --- |
| Whisper turbo startup, model already downloaded | 5.44 s |
| MiraTTS startup, assets already downloaded | 10.17 s |
| First speech synthesis / transcription | 1.40 s / 0.52 s |
| Warm synthesis, about 5.5 seconds of audio | 0.93–0.95 s |
| Warm transcription of that audio | 0.16–0.18 s |

These are short, local synthetic-audio measurements, not a German/Mandarin
accuracy benchmark or Telegram end-to-end latency. Codex generation, network
latency, voice effects, and uploads add time. Keep other GPU workloads out of
this memory budget. The existing voice reference and effects are retained.

[Whisper turbo does not translate audio](https://github.com/openai/whisper#command-line-usage).
For an auto-detected language outside the existing `en,de,zh` allowlist, the
workers lazily cache `small` on CPU for the English translation retry. This
preserves the existing fallback without allocating another GPU model. This
uncommon path is slower and downloads `small` on first use if not cached.

## Verification

```powershell
npm test
.\.tts-venv\Scripts\python.exe -m unittest discover -s tests -p '*runtime_test.py'
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

The JavaScript tests use Windows named pipes and directory junctions where
needed. POSIX permission-bit and process-group assertions remain platform
specific. Test speech workers directly before starting Telegram polling.
Never start a second poller for the same token.

For remote computers, keep host registries and SSH keys private. See
[Companion setup and testing](../companion/README.md). Use fixed DHCP leases
if firewall rules and SSH key restrictions are bound to the controller IP.
