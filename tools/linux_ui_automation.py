#!/usr/bin/env python3
"""Linux desktop automation bridge.

This is the Linux counterpart to tools/ui_automation.ps1.  It intentionally
keeps the same JSON stdout contract while using common Linux desktop tools.
Required for mutating UI actions: xdotool.  Optional: wmctrl, tesseract, xclip,
xsel, wl-copy/wl-paste, gnome-screenshot, grim, scrot, maim, or ImageMagick.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "runtime" / "out"
MUTATING_ACTIONS = {
    "focus",
    "click",
    "double_click",
    "right_click",
    "move",
    "mouse_down",
    "mouse_up",
    "drag",
    "click_text",
    "clipboard_copy",
    "clipboard_paste",
    "type",
    "key",
    "scroll",
}


def ensure_display() -> None:
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        os.environ["DISPLAY"] = ":0"


def which(name: str) -> str:
    return shutil.which(name) or ""


def run(args: list[str], *, timeout: float = 10, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    proc = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=env,
    )
    if check and proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or f"{args[0]} exited {proc.returncode}").strip()
        raise RuntimeError(msg)
    return proc


def out(ok: bool, action: str, *, result: Any = None, error: str = "", code: int = 0) -> int:
    payload: dict[str, Any] = {"ok": bool(ok), "action": action}
    if ok:
        payload["result"] = result if result is not None else {}
    else:
        payload["error"] = str(error or "failed")
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    return code


def normalize_args(argv: list[str]) -> list[str]:
    bool_flags = {
        "allscreens",
        "allowambiguousfocus",
        "allowunsafe",
        "dragleft",
        "exacttext",
        "highlightbeforeclick",
        "instantmove",
        "telemetryreset",
        "textregex",
        "typedirect",
    }
    normalized: list[str] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("-") and not token.startswith("--"):
            key = token.lstrip("-")
            lowered = key.lower()
            normalized.append("--" + re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", key).lower())
            if lowered in bool_flags:
                i += 1
                continue
        else:
            normalized.append(token)
        i += 1
    return normalized


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--action", default="windows")
    parser.add_argument("--title", default="")
    parser.add_argument("--regex", default="")
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    parser.add_argument("--end-x", type=int, default=None)
    parser.add_argument("--end-y", type=int, default=None)
    parser.add_argument("--move-duration", type=int, default=160)
    parser.add_argument("--move-steps", type=int, default=0)
    parser.add_argument("--drag-duration", type=int, default=420)
    parser.add_argument("--drag-steps", type=int, default=0)
    parser.add_argument("--button", default="left")
    parser.add_argument("--text", default="")
    parser.add_argument("--text-regex", action="store_true")
    parser.add_argument("--exact-text", action="store_true")
    parser.add_argument("--match-index", type=int, default=1)
    parser.add_argument("--region-x", type=int, default=None)
    parser.add_argument("--region-y", type=int, default=None)
    parser.add_argument("--region-width", type=int, default=None)
    parser.add_argument("--region-height", type=int, default=None)
    parser.add_argument("--keys", default="")
    parser.add_argument("--delta", type=int, default=-120)
    parser.add_argument("--milliseconds", type=int, default=100)
    parser.add_argument("--output", default="")
    parser.add_argument("--all-screens", action="store_true")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--commands-json", default="")
    parser.add_argument("--allow-ambiguous-focus", action="store_true")
    parser.add_argument("--allow-unsafe", action="store_true")
    parser.add_argument("--drag-left", action="store_true")
    parser.add_argument("--type-direct", action="store_true")
    parser.add_argument("--telemetry-reset", action="store_true")
    parser.add_argument("--telemetry-recent", type=int, default=20)
    parser.add_argument("--typewriter-threshold", type=int, default=180)
    parser.add_argument("--typewriter-min-delay", type=int, default=8)
    parser.add_argument("--typewriter-max-delay", type=int, default=28)
    parser.add_argument("--highlight-before-click", action="store_true")
    parser.add_argument("--highlight-milliseconds", type=int, default=320)
    parser.add_argument("--highlight-width", type=int, default=80)
    parser.add_argument("--highlight-height", type=int, default=40)


def parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Linux UI automation")
    add_common(parser)
    return parser.parse_args(normalize_args(argv))


def require_xdotool() -> None:
    if not which("xdotool"):
        raise RuntimeError("xdotool is required for this action. Install it with: sudo apt install xdotool")


def safety_gate(action: str, allow_unsafe: bool) -> None:
    mode = os.environ.get("AIDOLON_UI_SAFETY_MODE", "").strip().lower()
    allowed = os.environ.get("AIDOLON_UI_ALLOW_MUTATIONS", "").strip().lower() in {"1", "true", "yes", "on"}
    if mode == "strict" and action in MUTATING_ACTIONS and not allowed and not allow_unsafe:
        raise RuntimeError("UI mutation blocked by AIDOLON_UI_SAFETY_MODE=strict. Set AIDOLON_UI_ALLOW_MUTATIONS=1 or pass -AllowUnsafe.")


def parse_geometry(raw: str) -> dict[str, int]:
    data: dict[str, int] = {}
    for line in raw.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        try:
            data[key.lower()] = int(value)
        except ValueError:
            pass
    return data


def window_ids() -> list[str]:
    require_xdotool()
    proc = run(["xdotool", "search", "--onlyvisible", "--name", "."], check=False)
    ids = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    return ids


def window_summary(wid: str) -> dict[str, Any]:
    title = run(["xdotool", "getwindowname", wid], check=False).stdout.strip()
    pid_raw = run(["xdotool", "getwindowpid", wid], check=False).stdout.strip()
    geom_raw = run(["xdotool", "getwindowgeometry", "--shell", wid], check=False).stdout
    geom = parse_geometry(geom_raw)
    return {
        "id": wid,
        "handle": wid,
        "title": title,
        "pid": int(pid_raw) if pid_raw.isdigit() else None,
        "x": geom.get("x"),
        "y": geom.get("y"),
        "width": geom.get("width"),
        "height": geom.get("height"),
    }


def action_windows(args: argparse.Namespace) -> dict[str, Any]:
    items = [window_summary(wid) for wid in window_ids()]
    items = [w for w in items if w.get("title")]
    return {"count": len(items), "windows": items[: max(1, args.limit)]}


def find_windows(args: argparse.Namespace) -> list[dict[str, Any]]:
    items = [window_summary(wid) for wid in window_ids()]
    title = (args.title or "").lower()
    regex = args.regex or ""
    matches = []
    for item in items:
        name = str(item.get("title") or "")
        if title and title not in name.lower():
            continue
        if regex and not re.search(regex, name):
            continue
        if not title and not regex:
            continue
        matches.append(item)
    return matches


def action_focus(args: argparse.Namespace) -> dict[str, Any]:
    matches = find_windows(args)
    if not matches:
        raise RuntimeError("No matching window found.")
    if len(matches) > 1 and not args.allow_ambiguous_focus:
        raise RuntimeError("Multiple matching windows found. Pass -AllowAmbiguousFocus to use the first match.")
    target = matches[0]
    run(["xdotool", "windowactivate", "--sync", str(target["id"])])
    return {"focused": target}


def button_num(name: str) -> str:
    table = {"left": "1", "middle": "2", "right": "3"}
    key = str(name or "left").lower()
    if key not in table:
        raise RuntimeError("Button must be left, middle, or right.")
    return table[key]


def require_point(args: argparse.Namespace) -> tuple[int, int]:
    if args.x is None or args.y is None:
        raise RuntimeError("X and Y are required.")
    return int(args.x), int(args.y)


def move_to(x: int, y: int) -> None:
    require_xdotool()
    run(["xdotool", "mousemove", str(x), str(y)])


def action_pointer(args: argparse.Namespace, kind: str) -> dict[str, Any]:
    x, y = require_point(args)
    move_to(x, y)
    btn = button_num(args.button)
    if kind == "move":
        if args.drag_left:
            run(["xdotool", "mousedown", "1"])
            run(["xdotool", "mouseup", "1"])
        return {"x": x, "y": y}
    if kind == "click":
        run(["xdotool", "click", "1"])
    elif kind == "double_click":
        run(["xdotool", "click", "--repeat", "2", "--delay", "90", "1"])
    elif kind == "right_click":
        run(["xdotool", "click", "3"])
    elif kind == "mouse_down":
        run(["xdotool", "mousedown", btn])
    elif kind == "mouse_up":
        run(["xdotool", "mouseup", btn])
    return {"x": x, "y": y, "button": args.button}


def action_drag(args: argparse.Namespace) -> dict[str, Any]:
    x, y = require_point(args)
    if args.end_x is None or args.end_y is None:
        raise RuntimeError("EndX and EndY are required for drag.")
    btn = button_num(args.button)
    move_to(x, y)
    run(["xdotool", "mousedown", btn])
    time.sleep(max(0.02, args.drag_duration / 3000.0))
    move_to(int(args.end_x), int(args.end_y))
    time.sleep(0.04)
    run(["xdotool", "mouseup", btn])
    return {"x": x, "y": y, "endX": args.end_x, "endY": args.end_y, "button": args.button}


def key_sequence(raw: str) -> str:
    s = str(raw or "").strip()
    if not s:
        raise RuntimeError("Keys are required.")
    replacements = {
        "ctrl": "ctrl",
        "control": "ctrl",
        "alt": "alt",
        "shift": "shift",
        "win": "super",
        "cmd": "super",
        "super": "super",
        "escape": "Escape",
        "esc": "Escape",
        "enter": "Return",
        "return": "Return",
        "tab": "Tab",
        "space": "space",
        "backspace": "BackSpace",
        "delete": "Delete",
        "left": "Left",
        "right": "Right",
        "up": "Up",
        "down": "Down",
        "home": "Home",
        "end": "End",
    }
    parts = re.split(r"\s*\+\s*", s)
    converted = []
    for part in parts:
        key = part.strip()
        low = key.lower()
        converted.append(replacements.get(low, key))
    return "+".join(converted)


def action_key(args: argparse.Namespace) -> dict[str, Any]:
    require_xdotool()
    seq = key_sequence(args.keys)
    run(["xdotool", "key", seq])
    return {"keys": seq}


def set_clipboard(text: str) -> str:
    if which("wl-copy"):
        run(["wl-copy"], input_text=text)
        return "wl-copy"
    if which("xclip"):
        run(["xclip", "-selection", "clipboard"], input_text=text)
        return "xclip"
    if which("xsel"):
        run(["xsel", "--clipboard", "--input"], input_text=text)
        return "xsel"
    raise RuntimeError("No clipboard writer found. Install wl-clipboard, xclip, or xsel.")


def get_clipboard() -> tuple[str, str]:
    if which("wl-paste"):
        return run(["wl-paste", "--no-newline"], check=False).stdout, "wl-paste"
    if which("xclip"):
        return run(["xclip", "-selection", "clipboard", "-o"], check=False).stdout, "xclip"
    if which("xsel"):
        return run(["xsel", "--clipboard", "--output"], check=False).stdout, "xsel"
    raise RuntimeError("No clipboard reader found. Install wl-clipboard, xclip, or xsel.")


def action_type(args: argparse.Namespace) -> dict[str, Any]:
    require_xdotool()
    text = str(args.text or "")
    if not text:
        raise RuntimeError("Text is required.")
    if args.type_direct or len(text) > max(0, args.typewriter_threshold):
        tool = set_clipboard(text)
        run(["xdotool", "key", "ctrl+v"])
        return {"method": "clipboard", "clipboardTool": tool, "chars": len(text)}
    delay = max(0, int(args.typewriter_min_delay))
    run(["xdotool", "type", "--delay", str(delay), "--", text])
    return {"method": "typewriter", "chars": len(text)}


def action_scroll(args: argparse.Namespace) -> dict[str, Any]:
    require_xdotool()
    if args.x is not None and args.y is not None:
        move_to(args.x, args.y)
    clicks = max(1, min(20, abs(int(args.delta or 0)) // 120 or 1))
    button = "4" if int(args.delta or 0) > 0 else "5"
    for _ in range(clicks):
        run(["xdotool", "click", button])
    return {"delta": args.delta, "clicks": clicks}


def resolve_output(path_text: str, prefix: str = "screenshot") -> Path:
    if path_text:
        p = Path(path_text).expanduser()
        if p.suffix.lower() != ".png":
            p.mkdir(parents=True, exist_ok=True)
            p = p / f"{prefix}-{int(time.time())}.png"
    else:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        p = OUT_DIR / f"{prefix}-{int(time.time())}.png"
    if not p.is_absolute():
        p = (ROOT / p).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def capture_screen(path: Path) -> str:
    candidates = [
        ("gnome-screenshot", ["gnome-screenshot", "-f", str(path)]),
        ("grim", ["grim", str(path)]),
        ("scrot", ["scrot", str(path)]),
        ("maim", ["maim", str(path)]),
        ("import", ["import", "-window", "root", str(path)]),
    ]
    errors = []
    for name, cmd in candidates:
        if not which(name):
            continue
        try:
            run(cmd, timeout=15)
            if path.is_file() and path.stat().st_size > 0:
                return name
            errors.append(f"{name}: output missing")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    if errors:
        raise RuntimeError("Screenshot failed. " + " | ".join(errors))
    raise RuntimeError("No screenshot tool found. Install gnome-screenshot, grim, scrot, maim, or ImageMagick import.")


def action_screenshot(args: argparse.Namespace) -> dict[str, Any]:
    path = resolve_output(args.output, "ui_screenshot")
    tool = capture_screen(path)
    return {"path": str(path), "bytes": path.stat().st_size, "tool": tool, "allScreens": bool(args.all_screens)}


def action_clipboard_copy(args: argparse.Namespace) -> dict[str, Any]:
    tool = set_clipboard(str(args.text or ""))
    return {"chars": len(str(args.text or "")), "tool": tool}


def action_clipboard_read(args: argparse.Namespace) -> dict[str, Any]:
    text, tool = get_clipboard()
    return {"text": text, "chars": len(text), "tool": tool}


def action_clipboard_paste(args: argparse.Namespace) -> dict[str, Any]:
    require_xdotool()
    tool = ""
    if args.text:
        tool = set_clipboard(str(args.text))
    run(["xdotool", "key", "ctrl+v"])
    return {"pasted": True, "clipboardTool": tool or None}


def tesseract_matches(image: Path, args: argparse.Namespace) -> list[dict[str, Any]]:
    if not which("tesseract"):
        raise RuntimeError("tesseract is required for click_text. Install it with: sudo apt install tesseract-ocr")
    proc = run(["tesseract", str(image), "stdout", "--psm", "6", "tsv"], timeout=30)
    rows = list(csv.DictReader(proc.stdout.splitlines(), delimiter="\t"))
    grouped: dict[tuple[str, str, str], list[dict[str, str]]] = {}
    for row in rows:
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        key = (row.get("block_num", ""), row.get("par_num", ""), row.get("line_num", ""))
        grouped.setdefault(key, []).append(row)

    wanted = str(args.text or "")
    if not wanted:
        raise RuntimeError("Text is required for click_text.")
    matches = []
    for line_rows in grouped.values():
        line_text = " ".join(str(r.get("text") or "").strip() for r in line_rows if str(r.get("text") or "").strip())
        if args.text_regex:
            matched = re.search(wanted, line_text, flags=re.IGNORECASE) is not None
        elif args.exact_text:
            matched = line_text.strip().lower() == wanted.strip().lower()
        else:
            matched = wanted.strip().lower() in line_text.strip().lower()
        if not matched:
            continue
        boxes = []
        for r in line_rows:
            try:
                x = int(float(r.get("left") or 0))
                y = int(float(r.get("top") or 0))
                w = int(float(r.get("width") or 0))
                h = int(float(r.get("height") or 0))
                boxes.append((x, y, x + w, y + h))
            except ValueError:
                pass
        if not boxes:
            continue
        left = min(b[0] for b in boxes)
        top = min(b[1] for b in boxes)
        right = max(b[2] for b in boxes)
        bottom = max(b[3] for b in boxes)
        cx = (left + right) // 2
        cy = (top + bottom) // 2
        if args.region_x is not None and args.region_y is not None and args.region_width is not None and args.region_height is not None:
            if not (args.region_x <= cx <= args.region_x + args.region_width and args.region_y <= cy <= args.region_y + args.region_height):
                continue
        matches.append({"text": line_text, "x": cx, "y": cy, "left": left, "top": top, "right": right, "bottom": bottom})
    return matches


def action_click_text(args: argparse.Namespace) -> dict[str, Any]:
    path = resolve_output("", "ocr")
    capture_screen(path)
    matches = tesseract_matches(path, args)
    if not matches:
        raise RuntimeError("No OCR text match found.")
    idx = max(1, int(args.match_index or 1)) - 1
    if idx >= len(matches):
        raise RuntimeError(f"MatchIndex {idx + 1} is out of range; found {len(matches)} match(es).")
    match = matches[idx]
    move_to(int(match["x"]), int(match["y"]))
    run(["xdotool", "click", "1"])
    return {"match": match, "matchCount": len(matches), "screenshot": str(path)}


def action_batch(args: argparse.Namespace) -> dict[str, Any]:
    if not args.commands_json:
        raise RuntimeError("CommandsJson is required for batch.")
    commands = json.loads(args.commands_json)
    if isinstance(commands, dict):
        commands = [commands]
    if not isinstance(commands, list):
        raise RuntimeError("CommandsJson must be a JSON object or array.")
    results = []
    for item in commands:
        if not isinstance(item, dict):
            raise RuntimeError("Batch items must be objects.")
        merged = vars(args).copy()
        for key, value in item.items():
            snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower().replace("-", "_")
            merged[snake] = value
        sub_args = argparse.Namespace(**merged)
        action = str(getattr(sub_args, "action", "") or "").lower()
        try:
            safety_gate(action, bool(getattr(sub_args, "allow_unsafe", False)))
            result = dispatch(sub_args)
            results.append({"ok": True, "action": action, "result": result})
        except Exception as exc:
            results.append({"ok": False, "action": action, "error": str(exc)})
            return {"ok": False, "results": results}
    return {"ok": True, "results": results}


def action_host(args: argparse.Namespace) -> dict[str, Any]:
    print(json.dumps({"ok": True, "action": "host", "result": {"ready": True}}, separators=(",", ":")), flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if str(req.get("action", "")).lower() == "shutdown":
                print(json.dumps({"ok": True, "action": "shutdown", "result": {}}, separators=(",", ":")), flush=True)
                break
            merged = vars(args).copy()
            for key, value in req.items():
                snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower().replace("-", "_")
                merged[snake] = value
            sub_args = argparse.Namespace(**merged)
            action = str(getattr(sub_args, "action", "") or "").lower()
            safety_gate(action, bool(getattr(sub_args, "allow_unsafe", False)))
            result = dispatch(sub_args)
            print(json.dumps({"ok": True, "action": action, "result": result}, separators=(",", ":"), ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "action": "host", "error": str(exc)}, separators=(",", ":"), ensure_ascii=False), flush=True)
    return {"stopped": True}


def action_wait(args: argparse.Namespace) -> dict[str, Any]:
    ms = max(0, int(args.milliseconds or 0))
    time.sleep(ms / 1000.0)
    return {"waitedMs": ms}


def action_highlight(args: argparse.Namespace) -> dict[str, Any]:
    x, y = require_point(args)
    move_to(x, y)
    time.sleep(max(0, int(args.highlight_milliseconds or 0)) / 1000.0)
    return {"x": x, "y": y, "note": "Linux highlight is a cursor-position wait."}


def action_telemetry(args: argparse.Namespace) -> dict[str, Any]:
    return {"counters": {}, "recent": [], "note": "Telemetry persistence is not implemented in the Linux bridge."}


def dispatch(args: argparse.Namespace) -> Any:
    action = str(args.action or "windows").strip().lower()
    if action == "windows":
        return action_windows(args)
    if action == "focus":
        return action_focus(args)
    if action in {"click", "double_click", "right_click", "move", "mouse_down", "mouse_up"}:
        return action_pointer(args, action)
    if action == "drag":
        return action_drag(args)
    if action == "type":
        return action_type(args)
    if action == "key":
        return action_key(args)
    if action == "scroll":
        return action_scroll(args)
    if action == "wait":
        return action_wait(args)
    if action == "screenshot":
        return action_screenshot(args)
    if action == "clipboard_copy":
        return action_clipboard_copy(args)
    if action == "clipboard_read":
        return action_clipboard_read(args)
    if action == "clipboard_paste":
        return action_clipboard_paste(args)
    if action == "click_text":
        return action_click_text(args)
    if action == "highlight":
        return action_highlight(args)
    if action == "batch":
        return action_batch(args)
    if action == "host":
        return action_host(args)
    if action == "telemetry":
        return action_telemetry(args)
    raise RuntimeError(f"Unsupported action: {action}")


def main(argv: list[str]) -> int:
    ensure_display()
    args = parse(argv)
    action = str(args.action or "windows").strip().lower()
    if action == "host":
        try:
            action_host(args)
            return 0
        except Exception as exc:
            return out(False, action, error=str(exc), code=1)
    try:
        safety_gate(action, bool(args.allow_unsafe))
        result = dispatch(args)
        return out(True, action, result=result, code=0)
    except Exception as exc:
        return out(False, action, error=str(exc), code=1)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
