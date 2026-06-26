---
name: native-control
description: Use AIDOLON local desktop and TV control tools through Codex-native plugin/MCP surfaces.
---

# AIDOLON Native Control

Use this skill when the user asks Codex to control the local desktop browser, inspect the screen, or control the Android TV.

## Desktop UI

- Use the `aidolon_ui_action` MCP tool for reversible UI automation.
- Prefer `click_text` for visible text targets and `drag` for sliders.
- Use this loop: list/focus windows, screenshot, perform one small action, screenshot again.
- Ask before destructive steps.

## TV

- Use `aidolon_tv_power`, `aidolon_tv_open_app`, `aidolon_tv_close_app`, and `aidolon_tv_capture`.
- Supported app names follow the repo TV scripts: YouTube, Netflix, Sunshine, Artemis, RetroArch, VLC, and Spotify.
- Capture after opening or closing an app when the result matters.

## Fallback

If the MCP server is unavailable, use the repo scripts directly:

- Linux desktop: `tools/ui.sh`
- Windows desktop: `tools/ui.cmd`
- Linux TV: `tools/tv_power.sh`, `tools/tv_open_app.sh`, `tools/tv_close_app.sh`, `tools/tv_capture.sh`
- Windows TV: `tools/tv_power.ps1`, `tools/tv_open_app.ps1`, `tools/tv_close_app.ps1`, `tools/tv_capture.ps1`
