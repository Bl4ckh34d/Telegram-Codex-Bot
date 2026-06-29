#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ACTION="${1:-install}"
REPO_ROOT="$(pwd)"
DEFAULT_BOT_USER="${SUDO_USER:-$(id -un)}"
BOT_USER="${AIDOLON_CAPTURE_USER:-$DEFAULT_BOT_USER}"
BOT_GROUP="${AIDOLON_CAPTURE_GROUP:-$(id -gn "$BOT_USER")}"
BOT_UID="$(id -u "$BOT_USER")"
BOT_GID="$(getent group "$BOT_GROUP" | awk -F: '{print $3}')"
OUT_ROOT="${AIDOLON_CAPTURE_OUTPUT_ROOT:-$REPO_ROOT/runtime/out}"
SOCKET_PATH="${AIDOLON_CAPTURE_SOCKET:-/run/aidolon-capture.sock}"
MIN_BYTES="${AIDOLON_CAPTURE_MIN_BYTES:-8000}"
INSTALL_DIR="/usr/local/lib/aidolon"
ENV_FILE="/etc/aidolon-capture.env"
UNIT_FILE="/etc/systemd/system/aidolon-capture.service"

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_backend() {
  if [[ "$OSTYPE" != linux* ]]; then
    echo "Trusted capture backend is Linux-only." >&2
    exit 1
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg is required for the trusted capture backend." >&2
    exit 1
  fi
  if [[ ! -e "/dev/fb0" && ! -d "/dev/dri" ]]; then
    echo "No framebuffer or DRM device was found for the trusted capture backend." >&2
    exit 1
  fi

  mkdir -p "$OUT_ROOT"
  as_root install -d -m 0755 "$INSTALL_DIR"
  as_root install -m 0755 "$REPO_ROOT/tools/linux_trusted_capture_backend.py" "$INSTALL_DIR/linux_trusted_capture_backend.py"

  tmp_env="$(mktemp)"
  cat >"$tmp_env" <<EOF
AIDOLON_CAPTURE_SOCKET=$SOCKET_PATH
AIDOLON_CAPTURE_OUTPUT_ROOT=$OUT_ROOT
AIDOLON_CAPTURE_ALLOWED_UID=$BOT_UID
AIDOLON_CAPTURE_ALLOWED_GID=$BOT_GID
AIDOLON_CAPTURE_FFMPEG_BIN=$(command -v ffmpeg)
AIDOLON_CAPTURE_FB_DEVICE=/dev/fb0
AIDOLON_CAPTURE_DISPLAY=${DISPLAY:-:0}
AIDOLON_CAPTURE_TIMEOUT_SEC=10
AIDOLON_CAPTURE_MIN_STDDEV=2.0
AIDOLON_CAPTURE_MIN_BYTES=$MIN_BYTES
AIDOLON_CAPTURE_REJECT_STRIPES=1
AIDOLON_CAPTURE_KMS_MODIFIERS=default:0
EOF
  as_root install -m 0644 "$tmp_env" "$ENV_FILE"
  rm -f "$tmp_env"

  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=AIDOLON trusted Linux framebuffer capture backend
After=multi-user.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/python3 $INSTALL_DIR/linux_trusted_capture_backend.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  as_root install -m 0644 "$tmp_unit" "$UNIT_FILE"
  rm -f "$tmp_unit"

  as_root systemctl daemon-reload
  as_root systemctl enable aidolon-capture.service
  as_root systemctl restart aidolon-capture.service
  echo "AIDOLON trusted capture backend installed and started."
}

uninstall_backend() {
  as_root systemctl disable --now aidolon-capture.service 2>/dev/null || true
  as_root rm -f "$UNIT_FILE" "$ENV_FILE" "$SOCKET_PATH"
  as_root rm -f "$INSTALL_DIR/linux_trusted_capture_backend.py"
  as_root systemctl daemon-reload
  echo "AIDOLON trusted capture backend removed."
}

status_backend() {
  systemctl --no-pager --plain status aidolon-capture.service || true
  if [[ -S "$SOCKET_PATH" ]]; then
    ls -l "$SOCKET_PATH"
  fi
}

case "$ACTION" in
  install) install_backend ;;
  uninstall) uninstall_backend ;;
  status) status_backend ;;
  *)
    echo "Usage: $0 [install|uninstall|status]" >&2
    exit 2
    ;;
esac
