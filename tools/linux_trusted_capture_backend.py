#!/usr/bin/env python3
"""Trusted local framebuffer capture backend for AIDOLON.

This service is intended to run as root through systemd. It exposes a local
Unix socket owned by the bot user, verifies the caller UID, captures /dev/fb0
with ffmpeg, and writes screenshots only under the configured output root.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
from typing import Any


SO_PEERCRED = 17


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        return int(raw)
    except Exception:
        return default


SOCKET_PATH = Path(os.environ.get("AIDOLON_CAPTURE_SOCKET", "/run/aidolon-capture.sock"))
OUTPUT_ROOT = Path(os.environ.get("AIDOLON_CAPTURE_OUTPUT_ROOT", "")).resolve()
ALLOWED_UID = env_int("AIDOLON_CAPTURE_ALLOWED_UID", -1)
ALLOWED_GID = env_int("AIDOLON_CAPTURE_ALLOWED_GID", -1)
FFMPEG_BIN = os.environ.get("AIDOLON_CAPTURE_FFMPEG_BIN", "ffmpeg")
FB_DEVICE = os.environ.get("AIDOLON_CAPTURE_FB_DEVICE", "/dev/fb0")
DISPLAY_NAME = os.environ.get("AIDOLON_CAPTURE_DISPLAY", ":0")
CAPTURE_TIMEOUT_SEC = env_int("AIDOLON_CAPTURE_TIMEOUT_SEC", 10)
MIN_STDDEV = float(os.environ.get("AIDOLON_CAPTURE_MIN_STDDEV", "2.0") or "2.0")
MIN_BYTES = env_int("AIDOLON_CAPTURE_MIN_BYTES", 8000)
STRIPE_REJECT = os.environ.get("AIDOLON_CAPTURE_REJECT_STRIPES", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
}


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(code)


def is_inside(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def sanitize_target(value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("missing output path")

    target = Path(raw)
    if not target.is_absolute():
        target = OUTPUT_ROOT / target
    target = target.resolve()

    if target.suffix.lower() != ".png":
        raise ValueError("output path must end with .png")
    if not is_inside(OUTPUT_ROOT, target):
        raise ValueError("output path is outside the configured output root")
    return target


def peer_credentials(conn: socket.socket) -> tuple[int, int, int]:
    raw = conn.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)


def send_json(conn: socket.socket, payload: dict[str, Any]) -> None:
    conn.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))


def discover_drm_devices() -> list[str]:
    devices: list[str] = []
    for status_file in sorted(Path("/sys/class/drm").glob("card*-*/status")):
        try:
            if status_file.read_text(encoding="utf-8").strip().lower() != "connected":
                continue
        except Exception:
            continue
        card = status_file.parent.name.split("-", 1)[0]
        device = f"/dev/dri/{card}"
        if Path(device).exists() and device not in devices:
            devices.append(device)
    for device in sorted(Path("/dev/dri").glob("card*")):
        text = str(device)
        if text not in devices:
            devices.append(text)
    return devices


def image_stats(path: Path) -> tuple[float, tuple[int, int], str]:
    try:
        from PIL import Image, ImageStat  # type: ignore

        with Image.open(path) as img:
            rgb = img.convert("RGB")
            stat = ImageStat.Stat(rgb)
            stddev = max(float(x) for x in stat.stddev)
            artifact = ""
            if STRIPE_REJECT:
                try:
                    artifact = detect_horizontal_stripe_artifact(rgb)
                except Exception:
                    artifact = ""
            return stddev, rgb.size, artifact
    except Exception:
        return ffmpeg_image_stats(path)


def ffmpeg_image_stats(path: Path) -> tuple[float, tuple[int, int], str]:
    size = path.stat().st_size if path.exists() else 0
    fallback = (MIN_STDDEV + 1.0 if size >= MIN_BYTES else 0.0), (0, 0), ""
    try:
        width = 320
        height = 180
        proc = subprocess.run(
            [
                FFMPEG_BIN,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(path),
                "-vf",
                f"scale={width}:{height}:flags=fast_bilinear,format=gray",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "pipe:1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(1, CAPTURE_TIMEOUT_SEC),
        )
        if proc.returncode != 0:
            return fallback
        pixels = list(proc.stdout[: width * height])
        if len(pixels) < width * height:
            return fallback
        return population_stddev([float(x) for x in pixels]), (width, height), detect_horizontal_stripe_bytes(pixels, width, height)
    except Exception:
        return fallback


def population_stddev(values: list[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((value - mean) ** 2 for value in values) / len(values)) ** 0.5


def detect_horizontal_stripe_artifact(rgb: Any) -> str:
    """Detect framebuffer captures decoded with a bad plane layout/modifier."""
    gray = rgb.convert("L")
    gray.thumbnail((320, 180), 2)
    width, height = gray.size
    if width < 64 or height < 64:
        return ""

    return detect_horizontal_stripe_bytes(list(gray.tobytes()), width, height)


def detect_horizontal_stripe_bytes(pixels: list[int], width: int, height: int) -> str:
    if width < 64 or height < 64:
        return ""
    row_means: list[float] = []
    col_sums = [0.0] * width
    vertical_edge = 0.0
    horizontal_edge = 0.0
    vertical_count = 0
    horizontal_count = 0

    for y in range(height):
        offset = y * width
        row = pixels[offset : offset + width]
        row_means.append(sum(row) / width)
        for x, value in enumerate(row):
            col_sums[x] += value
            if x:
                horizontal_edge += abs(value - row[x - 1])
                horizontal_count += 1
            if y:
                vertical_edge += abs(value - pixels[offset - width + x])
                vertical_count += 1

    col_means = [value / height for value in col_sums]
    row_std = population_stddev(row_means)
    col_std = population_stddev(col_means)
    vertical_mean = vertical_edge / max(1, vertical_count)
    horizontal_mean = horizontal_edge / max(1, horizontal_count)

    if row_std > max(8.0, col_std * 6.0) and vertical_mean > max(4.0, horizontal_mean * 2.8):
        return (
            "capture output appears horizontally corrupted "
            f"(row/column variance {row_std / max(col_std, 0.01):.1f}, "
            f"vertical/horizontal edge {vertical_mean / max(horizontal_mean, 0.01):.1f})"
        )
    return ""


def validate_capture(path: Path, *, relaxed: bool = False) -> None:
    if not path.is_file() or path.stat().st_size <= 0:
        raise RuntimeError("capture output file missing")
    min_bytes = max(1024, MIN_BYTES // 4) if relaxed else MIN_BYTES
    if path.stat().st_size < min_bytes:
        raise RuntimeError(f"capture output too small ({path.stat().st_size} bytes)")
    stddev, size, artifact = image_stats(path)
    if stddev < MIN_STDDEV:
        dims = f" {size[0]}x{size[1]}" if size != (0, 0) else ""
        raise RuntimeError(f"capture output appears blank{dims} (stddev {stddev:.2f})")
    if artifact and not relaxed:
        raise RuntimeError(artifact)


def run_ffmpeg_capture(cmd: list[str], temp_path: Path, *, relaxed: bool = False) -> None:
    proc = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=max(1, CAPTURE_TIMEOUT_SEC),
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or f"ffmpeg exited {proc.returncode}").strip()
        raise RuntimeError(message)
    validate_capture(temp_path, relaxed=relaxed)


def capture_kms(temp_path: Path, *, relaxed: bool = False) -> str:
    errors = []
    devices_raw = os.environ.get("AIDOLON_CAPTURE_DRM_DEVICES", "").strip()
    devices = [x.strip() for x in devices_raw.split(":") if x.strip()] if devices_raw else discover_drm_devices()
    formats_raw = os.environ.get("AIDOLON_CAPTURE_KMS_FORMATS", "").strip()
    formats = [x.strip() for x in formats_raw.split(":") if x.strip()] if formats_raw else [
        "bgr0",
        "rgb0",
        "0rgb",
        "0bgr",
        "bgra",
        "rgba",
    ]
    modifiers_raw = os.environ.get("AIDOLON_CAPTURE_KMS_MODIFIERS", "").strip()
    modifiers = [x.strip() for x in modifiers_raw.split(":") if x.strip()] if modifiers_raw else [
        "default",
        "0",
    ]
    for device in devices:
        for modifier in modifiers:
            modifier_args = [] if modifier.lower() == "default" else ["-format_modifier", modifier]
            for pix_fmt in formats:
                try:
                    run_ffmpeg_capture([
                        FFMPEG_BIN,
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-device",
                        device,
                        *modifier_args,
                        "-f",
                        "kmsgrab",
                        "-i",
                        "-",
                        "-vf",
                        f"hwdownload,format={pix_fmt}",
                        "-frames:v",
                        "1",
                        "-update",
                        "1",
                        str(temp_path),
                    ], temp_path, relaxed=relaxed)
                    suffix = "" if modifier.lower() == "default" else f":modifier={modifier}"
                    return f"kmsgrab:{device}:{pix_fmt}{suffix}"
                except Exception as exc:
                    errors.append(f"{device}/{pix_fmt}/modifier={modifier}: {exc}")
                    try:
                        temp_path.unlink()
                    except FileNotFoundError:
                        pass
    raise RuntimeError("kmsgrab failed" + (f" ({' | '.join(errors[:3])})" if errors else ""))


def capture_x11(temp_path: Path, *, relaxed: bool = False) -> str:
    run_ffmpeg_capture([
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-i",
        DISPLAY_NAME,
        "-frames:v",
        "1",
        "-update",
        "1",
        str(temp_path),
    ], temp_path, relaxed=relaxed)
    return f"x11grab:{DISPLAY_NAME}"


def capture_fbdev(temp_path: Path, *, relaxed: bool = False) -> str:
    run_ffmpeg_capture([
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "fbdev",
        "-i",
        FB_DEVICE,
        "-frames:v",
        "1",
        "-update",
        "1",
        str(temp_path),
    ], temp_path, relaxed=relaxed)
    return f"fbdev:{FB_DEVICE}"


def capture_framebuffer(target: Path) -> dict[str, Any]:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp.png", dir=str(target.parent))
    os.close(fd)
    temp_path = Path(temp_name)
    errors: list[str] = []

    try:
        method = ""
        strict_methods = [
            ("kmsgrab", capture_kms),
            ("x11grab", capture_x11),
            ("fbdev", capture_fbdev),
        ]
        for name, capture in strict_methods:
            try:
                method = capture(temp_path)
                break
            except Exception as exc:
                errors.append(f"{name}: {exc}")
                try:
                    temp_path.unlink()
                except FileNotFoundError:
                    pass
        relaxed = False
        if not method:
            for name, capture in [
                ("fbdev-relaxed", capture_fbdev),
                ("kmsgrab-relaxed", capture_kms),
                ("x11grab-relaxed", capture_x11),
            ]:
                try:
                    method = capture(temp_path, relaxed=True)
                    relaxed = True
                    break
                except Exception as exc:
                    errors.append(f"{name}: {exc}")
                    try:
                        temp_path.unlink()
                    except FileNotFoundError:
                        pass
        if not method:
            raise RuntimeError("all capture methods failed: " + " | ".join(errors))
        os.replace(temp_path, target)
        os.chown(target, ALLOWED_UID, ALLOWED_GID if ALLOWED_GID >= 0 else -1)
        os.chmod(target, 0o600)
        return {"path": str(target), "bytes": target.stat().st_size, "method": method, "relaxed": relaxed}
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except Exception:
            pass


def handle_client(conn: socket.socket) -> None:
    pid, uid, gid = peer_credentials(conn)
    if ALLOWED_UID >= 0 and uid != ALLOWED_UID:
        send_json(conn, {"ok": False, "error": f"unauthorized uid {uid}"})
        return
    if ALLOWED_GID >= 0 and gid != ALLOWED_GID:
        send_json(conn, {"ok": False, "error": f"unauthorized gid {gid}"})
        return

    data = b""
    while not data.endswith(b"\n") and len(data) < 8192:
        chunk = conn.recv(1024)
        if not chunk:
            break
        data += chunk

    try:
        request = json.loads(data.decode("utf-8"))
        target = sanitize_target(request.get("output"))
        result = capture_framebuffer(target)
        send_json(conn, {"ok": True, **result, "pid": pid})
    except Exception as exc:
        send_json(conn, {"ok": False, "error": str(exc)})


def main() -> int:
    if not OUTPUT_ROOT:
        fail("AIDOLON_CAPTURE_OUTPUT_ROOT is required")
    if ALLOWED_UID < 0:
        fail("AIDOLON_CAPTURE_ALLOWED_UID is required")
    if not discover_drm_devices() and not Path(FB_DEVICE).exists():
        fail(f"no DRM devices or framebuffer device found (fb={FB_DEVICE})")

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    os.chown(SOCKET_PATH, ALLOWED_UID, ALLOWED_GID if ALLOWED_GID >= 0 else -1)
    os.chmod(SOCKET_PATH, 0o600)
    server.listen(8)

    def cleanup(_signum: int, _frame: Any) -> None:
        try:
            server.close()
        finally:
            try:
                SOCKET_PATH.unlink()
            except FileNotFoundError:
                pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    print(f"AIDOLON capture backend listening on {SOCKET_PATH}", flush=True)

    while True:
        conn, _addr = server.accept()
        with conn:
            handle_client(conn)


if __name__ == "__main__":
    raise SystemExit(main())
