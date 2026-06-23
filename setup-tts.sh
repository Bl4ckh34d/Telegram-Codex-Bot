#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f ".env" && -f ".env.example" ]]; then
  cp ".env.example" ".env"
fi

env_value() {
  local key="$1"
  [[ -f ".env" ]] || return 0
  awk -F= -v key="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      k=$1
      sub(/^[[:space:]]+/, "", k)
      sub(/[[:space:]]+$/, "", k)
      if (tolower(k) == tolower(key)) {
        $1=""
        sub(/^=/, "")
        sub(/^[[:space:]]+/, "")
        sub(/[[:space:]]+$/, "")
        gsub(/^"|"$/, "")
        gsub(/^'\''|'\''$/, "")
        print
        exit
      }
    }
  ' ".env"
}

is_enabled() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

TTS_ENABLED="$(env_value TTS_ENABLED || true)"
if ! is_enabled "$TTS_ENABLED"; then
  exit 0
fi

TTS_VENV_PATH="$(env_value TTS_VENV_PATH || true)"
TTS_MODEL="$(env_value TTS_MODEL || true)"
TTS_REFERENCE_AUDIO="$(env_value TTS_REFERENCE_AUDIO || true)"
TTS_FFMPEG_BIN="$(env_value TTS_FFMPEG_BIN || true)"
UV_ENABLED="$(env_value UV_ENABLED || true)"

TTS_VENV_PATH="${TTS_VENV_PATH:-.tts-venv}"
TTS_REFERENCE_AUDIO="${TTS_REFERENCE_AUDIO:-assets/reference.wav}"
TTS_FFMPEG_BIN="${TTS_FFMPEG_BIN:-ffmpeg}"
UV_ENABLED="${UV_ENABLED:-auto}"

TTS_VENV_PATH="${TTS_VENV_PATH//\\//}"
TTS_MODEL="${TTS_MODEL//\\//}"
TTS_REFERENCE_AUDIO="${TTS_REFERENCE_AUDIO//\\//}"

if [[ -z "$TTS_MODEL" ]]; then
  echo "TTS setup failed: TTS_MODEL is not set in .env." >&2
  exit 1
fi

if ! command -v "$TTS_FFMPEG_BIN" >/dev/null 2>&1 && [[ ! -x "$TTS_FFMPEG_BIN" ]]; then
  echo "TTS setup failed: ffmpeg not found (\"$TTS_FFMPEG_BIN\")." >&2
  echo "Install ffmpeg or set TTS_FFMPEG_BIN in .env." >&2
  exit 1
fi

if [[ ! -f "$TTS_REFERENCE_AUDIO" ]]; then
  echo "WARNING: Reference audio not found at \"$TTS_REFERENCE_AUDIO\"." >&2
  echo "WARNING: Set TTS_REFERENCE_AUDIO to an existing WAV file." >&2
fi

PYTHON_BIN=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  echo "TTS setup failed: Python 3.10+ not found in PATH. Install Python and retry." >&2
  exit 1
fi

HAS_UV=0
if command -v uv >/dev/null 2>&1; then
  HAS_UV=1
fi
if [[ "$UV_ENABLED" == "0" ]]; then
  HAS_UV=0
fi
if [[ "$UV_ENABLED" == "1" && "$HAS_UV" != "1" ]]; then
  echo "UV is required because UV_ENABLED=1, but uv was not found on PATH." >&2
  exit 1
fi

VENV_DIR="$(realpath -m "$TTS_VENV_PATH")"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "Creating TTS virtual environment at \"$VENV_DIR\"..."
  if [[ "$HAS_UV" == "1" ]]; then
    uv venv --python 3.12 "$VENV_DIR" 2>/dev/null || uv venv "$VENV_DIR"
  else
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
fi

VENV_PY="$VENV_DIR/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  echo "TTS setup failed: venv python was not created at \"$VENV_PY\"." >&2
  exit 1
fi

echo "Installing MiraTTS dependencies into \"$VENV_DIR\"..."
TORCH_CUDA_PACKAGES=(torch==2.8.0+cu128 torchvision==0.23.0+cu128 torchaudio==2.8.0+cu128)
TORCH_CPU_PACKAGES=(torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0)

pip_install() {
  if [[ "$HAS_UV" == "1" ]]; then
    uv pip install --python "$VENV_PY" "$@"
  else
    "$VENV_PY" -m pip install "$@"
  fi
}

pip_uninstall() {
  if [[ "$HAS_UV" == "1" ]]; then
    uv pip uninstall --python "$VENV_PY" "$@" || true
  else
    "$VENV_PY" -m pip uninstall -y "$@" || true
  fi
}

HAS_WORKING_NVIDIA=0
if nvidia-smi >/dev/null 2>&1; then
  HAS_WORKING_NVIDIA=1
fi

if [[ "$HAS_WORKING_NVIDIA" != "1" ]]; then
  echo "Working NVIDIA GPU not detected. Falling back to CPU-capable torch..."
  pip_install "${TORCH_CPU_PACKAGES[@]}"
else
  if ! "$VENV_PY" -c "import torch,sys; v=torch.__version__.split('+')[0].split('.'); sys.exit(0 if torch.cuda.is_available() and (int(v[0]),int(v[1])) >= (2,8) else 1)" >/dev/null 2>&1; then
    echo "Installing CUDA-enabled torch stack..."
    if [[ "$HAS_UV" == "1" ]]; then
      uv pip install --python "$VENV_PY" --upgrade --force-reinstall "${TORCH_CUDA_PACKAGES[@]}" --index-url https://download.pytorch.org/whl/cu128
    else
      "$VENV_PY" -m pip install --upgrade --force-reinstall "${TORCH_CUDA_PACKAGES[@]}" --index-url https://download.pytorch.org/whl/cu128
    fi
  fi
  if ! "$VENV_PY" -c "import torch,torchaudio; assert torch.cuda.is_available()" >/dev/null; then
    echo "CUDA torch installed but CUDA is unavailable. Continuing with CPU execution."
  fi
fi

pip_install "numpy<2" soundfile omegaconf

if ! command -v git >/dev/null 2>&1; then
  echo "TTS setup failed: git not found in PATH." >&2
  echo "Install git, then retry." >&2
  exit 1
fi
pip_install "git+https://github.com/ysharma3501/MiraTTS.git"

echo "Using CPU ONNX Runtime for MiraTTS decoder compatibility..."
pip_uninstall onnxruntime-gpu
pip_install --upgrade --force-reinstall onnxruntime
pip_install "numpy<2"

"$VENV_PY" -c "from mira.model import MiraTTS; print('MiraTTS import ok')"
