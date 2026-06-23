#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

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

UV_ENABLED="$(env_value UV_ENABLED || true)"
WHISPER_VENV_PATH="$(env_value WHISPER_VENV_PATH || true)"
UV_ENABLED="${UV_ENABLED:-auto}"
WHISPER_VENV_PATH="${WHISPER_VENV_PATH:-.venv}"

VENV_DIR="$(realpath -m "$WHISPER_VENV_PATH")"
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

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "Creating venv for Whisper at \"$VENV_DIR\"..."
  if [[ "$HAS_UV" == "1" ]]; then
    uv venv --python 3.12 "$VENV_DIR" 2>/dev/null || uv venv "$VENV_DIR"
  else
    PYTHON_BIN=""
    for candidate in python3.12 python3.11 python3.10 python3; do
      if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON_BIN="$candidate"
        break
      fi
    done
    if [[ -z "$PYTHON_BIN" ]]; then
      echo "Failed to create venv. Ensure Python 3.10+ is installed." >&2
      exit 1
    fi
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "Failed to create venv. Ensure Python 3.10+ is installed." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Warning: ffmpeg not found on PATH. Whisper transcription will fail without ffmpeg." >&2
fi

echo "Installing OpenAI Whisper into \"$VENV_DIR\"..."
if [[ "$HAS_UV" == "1" ]]; then
  uv pip install --python "$VENV_DIR/bin/python" --upgrade openai-whisper
else
  "$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
  "$VENV_DIR/bin/python" -m pip install --upgrade openai-whisper
fi

echo "Whisper venv setup complete."
echo "Python: $VENV_DIR/bin/python"
