#!/usr/bin/env python3
"""Client for the AIDOLON trusted Linux capture backend."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys


def population_stddev(values: list[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((value - mean) ** 2 for value in values) / len(values)) ** 0.5


def horizontal_stripe_artifact(path: Path) -> str:
    if os.environ.get("AIDOLON_CAPTURE_REJECT_STRIPES", "1").strip().lower() in {
        "0",
        "false",
        "off",
        "no",
    }:
        return ""
    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as img:
            gray = img.convert("L")
            gray.thumbnail((320, 180), 2)
            width, height = gray.size
            if width < 64 or height < 64:
                return ""
            pixels = list(gray.tobytes())
    except Exception:
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
            "trusted capture output appears horizontally corrupted "
            f"(row/column variance {row_std / max(col_std, 0.01):.1f}, "
            f"vertical/horizontal edge {vertical_mean / max(horizontal_mean, 0.01):.1f})"
        )
    return ""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: linux_trusted_capture_client.py OUTPUT.png", file=sys.stderr)
        return 2

    socket_path = os.environ.get("AIDOLON_CAPTURE_SOCKET", "/run/aidolon-capture.sock")
    output = str(Path(sys.argv[1]).resolve())
    timeout = float(os.environ.get("AIDOLON_CAPTURE_CLIENT_TIMEOUT_SEC", "12"))

    if os.environ.get("AIDOLON_CAPTURE_DIRECT", "0").strip().lower() in {"1", "true", "yes", "on"}:
        try:
            os.environ.setdefault("AIDOLON_CAPTURE_OUTPUT_ROOT", str(Path(output).parent))
            os.environ.setdefault("AIDOLON_CAPTURE_ALLOWED_UID", str(os.getuid()))
            os.environ.setdefault("AIDOLON_CAPTURE_ALLOWED_GID", str(os.getgid()))
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from linux_trusted_capture_backend import capture_framebuffer  # type: ignore

            response = {"ok": True, **capture_framebuffer(Path(output))}
        except Exception as exc:
            print(f"direct capture failed: {exc}", file=sys.stderr)
            return 1
    else:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
                conn.settimeout(timeout)
                conn.connect(socket_path)
                conn.sendall((json.dumps({"output": output}) + "\n").encode("utf-8"))
                data = b""
                while not data.endswith(b"\n") and len(data) < 8192:
                    chunk = conn.recv(1024)
                    if not chunk:
                        break
                    data += chunk
        except Exception as exc:
            print(f"trusted capture backend unavailable: {exc}", file=sys.stderr)
            return 1

        try:
            response = json.loads(data.decode("utf-8"))
        except Exception as exc:
            print(f"trusted capture backend returned invalid response: {exc}", file=sys.stderr)
            return 1

    if not response.get("ok"):
        print(str(response.get("error") or "trusted capture failed"), file=sys.stderr)
        return 1
    output_path = Path(output)
    if not output_path.is_file() or output_path.stat().st_size <= 0:
        print("trusted capture output file missing", file=sys.stderr)
        return 1
    artifact = "" if response.get("relaxed") else horizontal_stripe_artifact(output_path)
    if artifact:
        try:
            output_path.unlink()
        except Exception:
            pass
        print(artifact, file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
