#!/usr/bin/env python3
"""Linux ADB helpers for Android TV control."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


APP_PACKAGES = {
    "youtube": ["com.google.android.youtube.tv", "com.google.android.youtube"],
    "netflix": ["com.netflix.ninja"],
    "sunshine": ["dev.lizardbyte.app", "dev.lizardbyte.sunshine"],
    "artemis": ["de.grill2010.artemis", "com.limelight.noir", "com.limelight"],
    "retroarch": ["com.retroarch.ra32", "com.retroarch.ra64", "com.retroarch"],
    "vlc": ["org.videolan.vlc"],
    "spotify": ["com.spotify.tv.android"],
}


def emit(ok: bool, payload: dict[str, Any], code: int = 0) -> int:
    out = {"ok": bool(ok), **payload}
    print(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    return code


def normalize_args(argv: list[str]) -> list[str]:
    normalized: list[str] = []
    for token in argv:
        if token.startswith("-") and not token.startswith("--"):
            key = token.lstrip("-")
            normalized.append("--" + re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", key).lower())
        else:
            normalized.append(token)
    return normalized


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Linux Android TV ADB helper")
    p.add_argument("--mode", choices=["capture", "open", "close", "power"], default="")
    p.add_argument("--action", default="")
    p.add_argument("--serial", default="")
    p.add_argument("--host", "--tv-host", dest="tv_host", default="")
    p.add_argument("--port", type=int, default=5555)
    p.add_argument("--package", default="")
    p.add_argument("--activity", default="")
    p.add_argument("--wait-ms", type=int, default=700)
    p.add_argument("--remote-dir", default="/sdcard/Download")
    p.add_argument("--remote-prefix", default="orion_capture_")
    p.add_argument("--output-dir", default="runtime/out")
    p.add_argument("--local-prefix", default="tv_capture_")
    return p


def mode_from_argv0() -> str:
    name = Path(sys.argv[0]).name
    if "capture" in name:
        return "capture"
    if "open" in name:
        return "open"
    if "close" in name:
        return "close"
    if "power" in name:
        return "power"
    return ""


def adb_available() -> None:
    if not shutil.which("adb"):
        raise RuntimeError("adb is not installed or not in PATH. Install android-tools-adb.")


def run_adb(args: list[str], *, serial: str = "", check: bool = True, timeout: float = 20) -> subprocess.CompletedProcess[str]:
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += args
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or f"adb exited {proc.returncode}").strip()
        raise RuntimeError(msg)
    return proc


def wait_device(endpoint: str, timeout_ms: int = 12000) -> None:
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        state = run_adb(["get-state"], serial=endpoint, check=False).stdout.strip()
        if state == "device":
            return
        time.sleep(0.5)


def resolve_target(args: argparse.Namespace) -> str:
    if args.serial:
        return args.serial
    host = (args.tv_host or os.environ.get("AIDOLON_TV_HOST") or "192.168.1.104").strip()
    if host:
        endpoint = f"{host}:{int(args.port or 5555)}"
        subprocess.run(["adb", "connect", endpoint], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        wait_device(endpoint)
        return endpoint
    raw = subprocess.run(["adb", "devices"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    online = []
    for line in raw.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[1] == "device":
            online.append(parts[0])
    if len(online) == 1:
        return online[0]
    if len(online) > 1:
        raise RuntimeError("Multiple ADB devices detected. Use -Serial or -Host.")
    raise RuntimeError("No ADB device detected. Connect TV or pass -Host/-Serial.")


def shell(target: str, command: str, *, check: bool = True) -> str:
    return run_adb(["shell", command], serial=target, check=check).stdout


def package_installed(target: str, package: str) -> bool:
    raw = shell(target, f"pm list packages {package} 2>/dev/null || true", check=False)
    return f"package:{package}" in raw


def package_running(target: str, package: str) -> bool:
    return bool(shell(target, f"pidof {package} 2>/dev/null || true", check=False).strip())


def foreground_package(target: str) -> str:
    raw = shell(target, "dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -n 1", check=False)
    match = re.search(r"([A-Za-z0-9_.]+)/", raw)
    if match:
        return match.group(1)
    raw = shell(target, "dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity|ResumedActivity' | head -n 1", check=False)
    match = re.search(r"([A-Za-z0-9_.]+)/", raw)
    return match.group(1) if match else ""


def wakefulness(target: str) -> str:
    raw = shell(target, "dumpsys power 2>/dev/null", check=False)
    match = re.search(r"mWakefulness=([A-Za-z]+)", raw)
    return match.group(1) if match else ""


def mode_power(args: argparse.Namespace) -> int:
    action = args.action or "on"
    if action not in {"on", "off", "toggle"}:
        raise RuntimeError("Action must be on, off, or toggle.")
    target = resolve_target(args)
    before = wakefulness(target)
    if action == "on":
        codes = [3] if before == "Awake" else [224, 3]
    elif action == "off":
        codes = [223]
    else:
        codes = [26]
    for code in codes:
        shell(target, f"input keyevent {code}")
        time.sleep(0.2)
    time.sleep(max(0, args.wait_ms) / 1000.0)
    return emit(True, {
        "action": action,
        "target": target,
        "wakefulnessBefore": before,
        "wakefulnessAfter": wakefulness(target),
        "waitedMs": args.wait_ms,
    })


def launch_package(target: str, package: str, activity: str = "") -> bool:
    commands = []
    if activity:
        commands.append(f"am start -n {package}/{activity}")
    else:
        commands += [
            f"am start -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER -p {package}",
            f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {package}",
            f"monkey -p {package} -c android.intent.category.LAUNCHER 1",
        ]
    for command in commands:
        shell(target, command, check=False)
        deadline = time.time() + 1.8
        while time.time() < deadline:
            if foreground_package(target) == package:
                return True
            time.sleep(0.22)
    return False


def mode_open(args: argparse.Namespace) -> int:
    action = args.action or "youtube"
    if action == "custom":
        if not args.package:
            raise RuntimeError("For custom action, -Package is required.")
        packages = [args.package]
    else:
        packages = APP_PACKAGES.get(action)
        if not packages:
            raise RuntimeError(f"Unsupported app action: {action}")
    target = resolve_target(args)
    attempts = []
    launched = ""
    for package in packages:
        installed = package_installed(target, package)
        ok = launch_package(target, package, args.activity) if installed else False
        attempts.append({"package": package, "installed": installed, "launchOk": ok})
        if ok:
            launched = package
            break
    if not launched:
        return emit(False, {
            "action": action,
            "target": target,
            "error": "Could not launch requested app. Check install state and package name.",
            "attempts": attempts,
        }, 1)
    time.sleep(max(0, args.wait_ms) / 1000.0)
    return emit(True, {"action": action, "target": target, "launchedPackage": launched, "attempts": attempts, "waitedMs": args.wait_ms})


def mode_close(args: argparse.Namespace) -> int:
    action = args.action or "retroarch"
    if action == "custom":
        if not args.package:
            raise RuntimeError("For custom action, -Package is required.")
        packages = [args.package]
    else:
        packages = APP_PACKAGES.get(action)
        if not packages:
            raise RuntimeError(f"Unsupported app action: {action}")
    target = resolve_target(args)
    attempts = []
    stopped = ""
    for package in packages:
        installed = package_installed(target, package)
        running_before = package_running(target, package) if installed else False
        stop_ok = False
        running_after = False
        if installed:
            shell(target, f"am force-stop {package}", check=False)
            time.sleep(max(0, args.wait_ms) / 1000.0)
            running_after = package_running(target, package)
            stop_ok = not running_after
        attempts.append({
            "package": package,
            "installed": installed,
            "runningBefore": running_before,
            "stopOk": stop_ok,
            "runningAfter": running_after,
        })
        if stop_ok:
            stopped = package
            break
    if not stopped:
        return emit(False, {"action": action, "target": target, "error": "Could not close requested app.", "attempts": attempts}, 1)
    return emit(True, {"action": action, "target": target, "stoppedPackage": stopped, "attempts": attempts, "waitedMs": args.wait_ms})


def mode_capture(args: argparse.Namespace) -> int:
    target = resolve_target(args)
    output_dir = Path(args.output_dir).expanduser()
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    shell(target, f"rm -f {args.remote_dir}/{args.remote_prefix}*.png", check=False)
    remaining = shell(target, f"ls -1 {args.remote_dir}/{args.remote_prefix}*.png 2>/dev/null || true", check=False).strip()
    if remaining:
        raise RuntimeError(f"Could not clear existing TV capture files in {args.remote_dir}.")
    ts = time.strftime("%Y%m%d_%H%M%S")
    remote = f"{args.remote_dir}/{args.remote_prefix}{ts}.png"
    local = output_dir / f"{args.local_prefix}{ts}.png"
    shell(target, f"screencap -p {remote}")
    run_adb(["pull", remote, str(local)], serial=target)
    shell(target, f"rm -f {remote}", check=False)
    still = shell(target, f"ls -1 {remote} 2>/dev/null || true", check=False).strip()
    if still:
        raise RuntimeError(f"Remote file still exists after cleanup: {remote}")
    if not local.is_file():
        raise RuntimeError(f"Local capture was not created: {local}")
    return emit(True, {
        "mode": "capture_pull_cleanup",
        "target": target,
        "localPath": str(local),
        "bytes": local.stat().st_size,
        "remoteDeleted": True,
        "timestamp": ts,
    })


def main(argv: list[str]) -> int:
    args = parser().parse_args(normalize_args(argv))
    mode = args.mode or mode_from_argv0()
    try:
        adb_available()
        if mode == "power":
            return mode_power(args)
        if mode == "open":
            return mode_open(args)
        if mode == "close":
            return mode_close(args)
        if mode == "capture":
            return mode_capture(args)
        raise RuntimeError("Mode is required: capture, open, close, or power.")
    except Exception as exc:
        payload = {"error": str(exc)}
        if args.action:
            payload["action"] = args.action
        return emit(False, payload, 1)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
