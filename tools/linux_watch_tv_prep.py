#!/usr/bin/env python3
"""Linux watch-TV prep workflow.

This is a Linux counterpart to watch_tv_prep.ps1.  It keeps the same JSON
stdout contract and uses the Linux UI/ADB helper scripts in this folder.
"""

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
TOOLS = Path(__file__).resolve().parent


def normalize_args(argv: list[str]) -> list[str]:
    bool_flags = {"skipartemiskeysequence", "allowunverifiedstream", "useisolatedfirefoxprofile", "dryrun", "preferreuseexistingconnection"}
    normalized: list[str] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("-") and not token.startswith("--"):
            key = token.lstrip("-")
            normalized.append("--" + re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", key).lower())
            if key.lower() in bool_flags:
                i += 1
                continue
        else:
            normalized.append(token)
        i += 1
    return normalized


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Linux watch TV prep")
    p.add_argument("--sunshine-command", default="sunshine")
    p.add_argument("--tv-host", default="")
    p.add_argument("--tv-port", type=int, default=5555)
    p.add_argument("--tv-serial", default="")
    p.add_argument("--sunshine-wait-ms", type=int, default=1200)
    p.add_argument("--tv-power-wait-ms", type=int, default=700)
    p.add_argument("--artemis-wait-ms", type=int, default=700)
    p.add_argument("--artemis-load-wait-ms", type=int, default=0)
    p.add_argument("--stream-detect-timeout-ms", type=int, default=12000)
    p.add_argument("--stream-detect-poll-ms", type=int, default=500)
    p.add_argument("--prefer-reuse-existing-connection", action="store_true", default=True)
    p.add_argument("--preferred-pc-name", default="ARCU")
    p.add_argument("--skip-artemis-key-sequence", action="store_true")
    p.add_argument("--allow-unverified-stream", action="store_true")
    p.add_argument("--browser-process", default="firefox")
    p.add_argument("--use-isolated-firefox-profile", action="store_true")
    p.add_argument("--browser-settle-ms", type=int, default=450)
    p.add_argument("--move-direction", default="Right")
    p.add_argument("--first-url", default="https://s.to")
    p.add_argument("--second-url", default="https://sflix.ps")
    p.add_argument("--preferred-audio-device", default="Bigscreen")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(normalize_args(argv))


def emit(ok: bool, payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps({"ok": bool(ok), **payload}, separators=(",", ":"), ensure_ascii=False))
    return code


def run_json(cmd: list[str], *, dry_run: bool = False) -> dict[str, Any]:
    if dry_run:
        return {"ok": True, "action": "dryrun", "result": {"cmd": cmd}}
    proc = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("{"):
            try:
                data = json.loads(line)
                if proc.returncode != 0 and data.get("ok") is not False:
                    data["ok"] = False
                return data
            except json.JSONDecodeError:
                pass
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or f"{cmd[0]} exited {proc.returncode}").strip()}
    return {"ok": True, "result": {"stdout": proc.stdout.strip()}}


def run(cmd: list[str], *, check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"{cmd[0]} exited {proc.returncode}").strip())
    return proc


def script(name: str) -> str:
    return str(TOOLS / name)


def tv_args(args: argparse.Namespace) -> list[str]:
    out = ["-Port", str(args.tv_port)]
    if args.tv_serial:
        out += ["-Serial", args.tv_serial]
    if args.tv_host:
        out += ["-Host", args.tv_host]
    return out


def process_running(name: str) -> bool:
    return subprocess.run(["pgrep", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def stop_sunshine() -> int:
    before = run(["pgrep", "-f", "sunshine"], check=False).stdout.split()
    if not before:
        return 0
    run(["pkill", "-f", "sunshine"], check=False)
    deadline = time.time() + 4
    while time.time() < deadline:
        if not process_running("sunshine"):
            break
        time.sleep(0.2)
    return len(before)


def start_sunshine(command_text: str, dry_run: bool) -> dict[str, Any]:
    command = (command_text or "sunshine").strip()
    if dry_run:
        return {"started": True, "command": command, "dryRun": True}
    if not command:
        raise RuntimeError("Sunshine command is empty.")
    if shutil.which(command):
        subprocess.Popen([command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT)
    else:
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT, shell=True)
    return {"started": True, "command": command}


def screen_count() -> int:
    if shutil.which("xrandr"):
        raw = run(["xrandr", "--listmonitors"], check=False).stdout
        match = re.search(r"Monitors:\s*(\d+)", raw)
        if match:
            return int(match.group(1))
    return 1


def adb_shell(args: argparse.Namespace, command: str) -> str:
    if not shutil.which("adb"):
        raise RuntimeError("adb is not installed or not in PATH. Install android-tools-adb.")
    adb = ["adb"]
    target = args.tv_serial or (f"{args.tv_host}:{args.tv_port}" if args.tv_host else "")
    if target:
        adb += ["-s", target]
    return run(adb + ["shell", command], check=False).stdout


def foreground_package(args: argparse.Namespace) -> str:
    raw = adb_shell(args, "dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -n 1")
    match = re.search(r"([A-Za-z0-9_.]+)/", raw)
    return match.group(1) if match else ""


def send_adb_key(args: argparse.Namespace, code: int, dry_run: bool) -> None:
    if dry_run:
        return
    if not shutil.which("adb"):
        raise RuntimeError("adb is not installed or not in PATH. Install android-tools-adb.")
    adb = ["adb"]
    target = args.tv_serial or (f"{args.tv_host}:{args.tv_port}" if args.tv_host else "")
    if target:
        adb += ["-s", target]
    run(adb + ["shell", "input", "keyevent", str(code)])


def set_audio_device(name: str, dry_run: bool) -> dict[str, Any]:
    wanted = (name or "").strip().lower()
    if not wanted:
        return {"attempted": False, "changed": False}
    if dry_run:
        return {"attempted": True, "changed": False, "matched": name, "dryRun": True}
    if shutil.which("pactl"):
        raw = run(["pactl", "list", "short", "sinks"], check=False).stdout
        sinks = []
        for line in raw.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                sinks.append(parts[1])
        matched = next((s for s in sinks if wanted in s.lower()), "")
        if matched:
            run(["pactl", "set-default-sink", matched], check=False)
            return {"attempted": True, "changed": True, "matched": matched, "available": sinks}
        return {"attempted": True, "changed": False, "warning": "No matching PulseAudio sink found.", "available": sinks}
    if shutil.which("wpctl"):
        raw = run(["wpctl", "status"], check=False).stdout
        return {"attempted": True, "changed": False, "warning": "wpctl is available, but automatic sink matching is not implemented.", "availableText": raw[-2000:]}
    return {"attempted": True, "changed": False, "warning": "Neither pactl nor wpctl is available."}


def start_browser(args: argparse.Namespace, dry_run: bool) -> dict[str, Any]:
    browser = args.browser_process or "firefox"
    if dry_run:
        return {"process": browser, "pid": None, "dryRun": True}
    if not shutil.which(browser):
        raise RuntimeError(f"Browser executable not found: {browser}")
    cmd = [browser, "--new-window", args.first_url]
    if args.use_isolated_firefox_profile:
        profile = ROOT / "runtime" / "firefox-watch-tv-profile"
        profile.mkdir(parents=True, exist_ok=True)
        cmd = [browser, "--no-remote", "--profile", str(profile), "--new-window", args.first_url]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT)
    time.sleep(max(0, args.browser_settle_ms) / 1000.0)
    return {"process": browser, "pid": proc.pid, "isolated": bool(args.use_isolated_firefox_profile)}


def open_urls(args: argparse.Namespace, dry_run: bool) -> list[dict[str, Any]]:
    if dry_run:
        return [{"url": args.first_url}, {"url": args.second_url}]
    ui = script("ui.sh")
    results = []
    focus = run_json([ui, "-Action", "focus", "-Title", args.browser_process, "-AllowAmbiguousFocus", "-AllowUnsafe"])
    results.append({"step": "focus", "result": focus})
    if args.second_url:
        for cmd in (
            [ui, "-Action", "key", "-Keys", "Ctrl+L", "-AllowUnsafe"],
            [ui, "-Action", "type", "-Text", args.first_url, "-TypeDirect", "-AllowUnsafe"],
            [ui, "-Action", "key", "-Keys", "Enter", "-AllowUnsafe"],
            [ui, "-Action", "key", "-Keys", "Ctrl+T", "-AllowUnsafe"],
            [ui, "-Action", "type", "-Text", args.second_url, "-TypeDirect", "-AllowUnsafe"],
            [ui, "-Action", "key", "-Keys", "Enter", "-AllowUnsafe"],
        ):
            results.append({"cmd": cmd[2], "result": run_json(cmd)})
    return results


def move_browser(args: argparse.Namespace, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {"moved": True, "dryRun": True}
    ui = script("ui.sh")
    direction = "Left" if str(args.move_direction).lower().startswith("l") else "Right"
    key = f"Super+Shift+{direction}"
    move = run_json([ui, "-Action", "key", "-Keys", key, "-AllowUnsafe"])
    maximize = run_json([ui, "-Action", "key", "-Keys", "Alt+F10", "-AllowUnsafe"])
    return {"moveKey": key, "move": move, "maximize": maximize}


def main(argv: list[str]) -> int:
    args = parse(argv)
    dry = bool(args.dry_run)
    summary: dict[str, Any] = {
        "mode": "dry-run" if dry else "live",
        "steps": [],
        "streamVerified": False,
        "firstUrl": args.first_url,
        "secondUrl": args.second_url,
    }
    try:
        initial_screens = screen_count()
        summary["initialScreenCount"] = initial_screens

        summary["steps"].append("restart_sunshine")
        already = process_running("sunshine") if not dry else False
        stopped = stop_sunshine() if already and not dry else 0
        start = start_sunshine(args.sunshine_command, dry)
        time.sleep(max(0, args.sunshine_wait_ms) / 1000.0)
        summary["sunshineAction"] = "restarted" if already else "started"
        summary["sunshineStoppedCount"] = stopped
        summary["sunshine"] = start
        if not dry and not process_running("sunshine"):
            raise RuntimeError("Sunshine did not start. Stopping before TV connection.")

        summary["steps"].append("tv_power_on")
        power = run_json([script("tv_power.sh"), "-Action", "on", "-WaitMs", str(args.tv_power_wait_ms), *tv_args(args)], dry_run=dry)
        if not power.get("ok"):
            raise RuntimeError(f"TV power on failed: {power.get('error')}")
        summary["tvPower"] = power

        summary["steps"].append("open_artemis")
        app = run_json([script("tv_open_app.sh"), "-Action", "artemis", "-WaitMs", str(args.artemis_wait_ms), *tv_args(args)], dry_run=dry)
        if not app.get("ok"):
            raise RuntimeError(f"Opening Artemis failed: {app.get('error')}")
        summary["artemis"] = app

        summary["steps"].append("set_audio_output")
        audio = set_audio_device(args.preferred_audio_device, dry)
        summary["audioDeviceTarget"] = args.preferred_audio_device
        summary["audio"] = audio

        summary["steps"].append("artemis_connect_attempt")
        if args.artemis_load_wait_ms > 0:
            time.sleep(args.artemis_load_wait_ms / 1000.0)
        if not args.skip_artemis_key_sequence:
            for code, delay in [(22, 0.06), (23, 0.38), (22, 0.06), (22, 0.06), (23, 0.0)]:
                send_adb_key(args, code, dry)
                time.sleep(delay)
        baseline = initial_screens
        deadline = time.time() + max(0, args.stream_detect_timeout_ms) / 1000.0
        if dry:
            summary["streamVerified"] = True
        while not dry and time.time() < deadline:
            if screen_count() > baseline:
                summary["streamVerified"] = True
                break
            time.sleep(max(50, args.stream_detect_poll_ms) / 1000.0)
        if not summary["streamVerified"] and not args.allow_unverified_stream:
            raise RuntimeError("Artemis connection was not verified. Stopping before browser automation.")

        summary["steps"].append("open_firefox_window")
        summary["browser"] = start_browser(args, dry)
        summary["steps"].append("move_and_maximize")
        summary["browserMove"] = move_browser(args, dry)
        summary["steps"].append("open_sites")
        summary["browserUrlActions"] = open_urls(args, dry)
        summary["ok"] = True
        return emit(True, summary)
    except Exception as exc:
        summary["ok"] = False
        summary["error"] = str(exc)
        return emit(False, summary, 1)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
