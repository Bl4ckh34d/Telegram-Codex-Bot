#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ -z "${AIDOLON_LAUNCH_STARTED_AT_MS:-}" ]]; then
  AIDOLON_LAUNCH_STARTED_AT_MS="$(date +%s%3N 2>/dev/null || printf '0')"
  export AIDOLON_LAUNCH_STARTED_AT_MS
fi

if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    cp ".env.example" ".env"
    echo "Created .env from .env.example. Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
  else
    echo ".env is missing and .env.example was not found." >&2
    exit 1
  fi
fi

env_value() {
  local key="$1"
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

maybe_add_uv_dir() {
  local dir="$1"
  if [[ -x "$dir/uv" ]]; then
    PATH="$dir:$PATH"
    export PATH
  fi
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return 0
  fi

  maybe_add_uv_dir "$HOME/.local/bin"
  maybe_add_uv_dir "$HOME/.cargo/bin"
  if command -v uv >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "uv not found and curl is not installed; cannot bootstrap uv." >&2
    return 1
  fi

  echo "uv not found; installing uv for current user..."
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  maybe_add_uv_dir "$HOME/.local/bin"
  maybe_add_uv_dir "$HOME/.cargo/bin"

  command -v uv >/dev/null 2>&1
}

UV_ENABLED="$(env_value UV_ENABLED || true)"
WHISPER_ENABLED="$(env_value WHISPER_ENABLED || true)"
TRUSTED_CAPTURE_SETUP="$(env_value AIDOLON_TRUSTED_CAPTURE_SETUP || true)"
UV_ENABLED="${UV_ENABLED:-auto}"
WHISPER_ENABLED="${WHISPER_ENABLED:-1}"
TRUSTED_CAPTURE_SETUP="${TRUSTED_CAPTURE_SETUP:-0}"

if [[ "$UV_ENABLED" == "1" || "$UV_ENABLED" == "auto" ]]; then
  if ! ensure_uv; then
    if [[ "$UV_ENABLED" == "1" ]]; then
      echo "uv bootstrap failed and UV_ENABLED=1. Aborting." >&2
      exit 1
    fi
    echo "WARNING: uv bootstrap failed; continuing without uv. Installs may be slower." >&2
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH. Install Node.js 18+ and retry." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "WARNING: codex not found in PATH. Set CODEX_BIN in .env if it is installed elsewhere." >&2
fi

if is_enabled "$WHISPER_ENABLED" && [[ -f "./setup-whisper-venv.sh" ]]; then
  ./setup-whisper-venv.sh
fi

if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] && is_enabled "$TRUSTED_CAPTURE_SETUP" && [[ -f "./setup-linux-capture-backend.sh" ]]; then
  ./setup-linux-capture-backend.sh install
fi

if [[ -f "./setup-tts.sh" ]]; then
  ./setup-tts.sh
fi

while true; do
  set +e
  node bot.js
  exit_code=$?
  set -e
  if [[ "$exit_code" == "75" ]]; then
    echo "Bot restart requested. Relaunching..."
    sleep 1
    export AIDOLON_LAUNCH_REASON="restart"
    export AIDOLON_LAUNCH_PREV_EXIT_CODE="$exit_code"
    continue
  fi
  exit "$exit_code"
done
