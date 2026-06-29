#!/usr/bin/env python3
"""Non-interactive GNOME Wayland screenshot capture via Mutter ScreenCast."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402


BUS_NAME = "org.gnome.Shell"
SCREENCAST_PATH = "/org/gnome/Mutter/ScreenCast"
SCREENCAST_IFACE = "org.gnome.Mutter.ScreenCast"
SESSION_IFACE = "org.gnome.Mutter.ScreenCast.Session"
STREAM_IFACE = "org.gnome.Mutter.ScreenCast.Stream"
DISPLAY_CONFIG_PATH = "/org/gnome/Mutter/DisplayConfig"
DISPLAY_CONFIG_IFACE = "org.gnome.Mutter.DisplayConfig"


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        return int(raw)
    except Exception:
        return default


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(code)


def call(
    conn: Gio.DBusConnection,
    path: str,
    iface: str,
    method: str,
    params: GLib.Variant | None = None,
    reply: str | None = None,
    timeout_ms: int = 5000,
) -> GLib.Variant:
    return conn.call_sync(
        BUS_NAME,
        path,
        iface,
        method,
        params,
        GLib.VariantType(reply) if reply else None,
        Gio.DBusCallFlags.NONE,
        timeout_ms,
        None,
    )


def discover_connector(conn: Gio.DBusConnection) -> str:
    configured = os.environ.get("AIDOLON_MUTTER_SCREENCAST_CONNECTOR", "").strip()
    if configured:
        return configured

    state = call(
        conn,
        DISPLAY_CONFIG_PATH,
        DISPLAY_CONFIG_IFACE,
        "GetCurrentState",
        reply="(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})",
    ).unpack()
    logical_monitors = state[2]
    if not logical_monitors:
        fail("mutter screencast capture failed: no logical monitors reported")

    primary = None
    for monitor in logical_monitors:
        if bool(monitor[4]):
            primary = monitor
            break
    selected = primary or logical_monitors[0]
    monitor_specs = selected[5]
    if not monitor_specs:
        fail("mutter screencast capture failed: selected monitor has no connector")
    return str(monitor_specs[0][0])


def capture(output: Path) -> None:
    timeout_sec = max(2, env_int("AIDOLON_MUTTER_SCREENCAST_TIMEOUT_SEC", 12))
    cursor_mode = max(0, min(2, env_int("AIDOLON_MUTTER_SCREENCAST_CURSOR_MODE", 1)))
    timeout_ms = timeout_sec * 1000
    output.parent.mkdir(parents=True, exist_ok=True)

    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    connector = discover_connector(conn)
    node_ids: list[int] = []
    loop = GLib.MainLoop()

    session = call(
        conn,
        SCREENCAST_PATH,
        SCREENCAST_IFACE,
        "CreateSession",
        GLib.Variant("(a{sv})", ({},)),
        "(o)",
        timeout_ms,
    ).unpack()[0]

    stream_props = {
        "cursor-mode": GLib.Variant("u", cursor_mode),
    }
    stream = call(
        conn,
        session,
        SESSION_IFACE,
        "RecordMonitor",
        GLib.Variant("(sa{sv})", (connector, stream_props)),
        "(o)",
        timeout_ms,
    ).unpack()[0]

    def on_signal(
        _connection: Gio.DBusConnection,
        _sender: str,
        _object_path: str,
        _interface_name: str,
        signal_name: str,
        parameters: GLib.Variant,
        _user_data: object,
    ) -> None:
        if signal_name == "PipeWireStreamAdded":
            node_ids.append(int(parameters.unpack()[0]))
            loop.quit()

    signal_id = conn.signal_subscribe(
        BUS_NAME,
        STREAM_IFACE,
        "PipeWireStreamAdded",
        stream,
        None,
        Gio.DBusSignalFlags.NONE,
        on_signal,
        None,
    )

    def on_timeout() -> bool:
        loop.quit()
        return False

    timeout_id = GLib.timeout_add_seconds(timeout_sec, on_timeout)
    temp_name = ""
    try:
        call(conn, session, SESSION_IFACE, "Start", timeout_ms=timeout_ms)
        loop.run()
        if not node_ids:
            fail("mutter screencast capture failed: PipeWire stream was not created")

        with tempfile.NamedTemporaryFile(
            prefix=f".{output.name}.",
            suffix=".tmp.png",
            dir=str(output.parent),
            delete=False,
        ) as temp:
            temp_name = temp.name

        gst_cmd = [
            "gst-launch-1.0",
            "-q",
            "pipewiresrc",
            f"path={node_ids[0]}",
            "num-buffers=1",
            "!",
            "videoconvert",
            "!",
            "pngenc",
            "!",
            "filesink",
            f"location={temp_name}",
        ]
        proc = subprocess.run(
            gst_cmd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_sec,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            fail(f"mutter screencast capture failed: gst-launch exited {proc.returncode}: {detail}")

        temp_path = Path(temp_name)
        if not temp_path.is_file() or temp_path.stat().st_size <= 0:
            fail("mutter screencast capture failed: output file missing")
        temp_path.replace(output)
    finally:
        if timeout_id:
            try:
                GLib.source_remove(timeout_id)
            except Exception:
                pass
        try:
            call(conn, session, SESSION_IFACE, "Stop", timeout_ms=1000)
        except Exception:
            pass
        try:
            conn.signal_unsubscribe(signal_id)
        except Exception:
            pass
        if temp_name:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except Exception:
                pass


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: linux_mutter_screencast_capture.py OUTPUT.png", file=sys.stderr)
        return 2

    output = Path(sys.argv[1]).expanduser().resolve()
    if output.suffix.lower() != ".png":
        fail("mutter screencast capture failed: output path must end with .png")
    try:
        capture(output)
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"mutter screencast capture failed: {exc}")
    print(str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
