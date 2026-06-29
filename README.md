# Telegram-Codex-Bot (AIDOLON)

Use Codex from Telegram with text, voice, images, screenshots, multi-workspace routing, and file attachments.

This bot is built for local personal use. It long-polls Telegram and runs Codex CLI on your machine.

## What it does

- Telegram chat to Codex prompt loop
- Voice note transcription (Whisper)
- Optional voice replies (TTS)
- Image and screenshot analysis
- Windows desktop UI automation for browser UX testing (minimal toolset)
- Multi-worker orchestration across repos
- Session resume and compression
- File attachment upload from assistant output
- Optional native WorldMonitor feed monitoring
- Scheduled daily weather briefing (text + voice)
- Native Codex MCP/plugin/skill compatibility through inherited Codex config

## Quickstart

1. Create a Telegram bot and get the token.
2. Get your Telegram chat ID.
3. Copy `.env.example` to `.env`.
4. Set at least:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Start the bot.

## Requirements

- Node.js 18+
- Codex CLI installed and authenticated

Notes:
- Windows and Ubuntu Linux are supported runtimes.
- Desktop screenshot capture works on Windows and Linux. On GNOME Wayland, AIDOLON first uses Mutter ScreenCast plus GStreamer for unattended screenshots. On other Linux desktops, install `gnome-screenshot` or another supported capture tool (`grim`, `scrot`, `maim`, or ImageMagick `import`).
- Desktop UI automation has Windows and Linux entrypoints.
- Whisper and TTS are optional and can be disabled in `.env`.

## Run

Windows:

```bat
copy .env.example .env
start.cmd
```

`start.cmd` can bootstrap Whisper and TTS dependencies when those features are enabled.

Ubuntu Linux:

```bash
cp .env.example .env
./start.sh
```

`start.sh` mirrors the Windows launcher: it creates `.env` if needed, checks Node/Codex, bootstraps `uv` when allowed, prepares Whisper/TTS virtual environments when those features are enabled, and restarts the bot when `/restart` requests it.

Keep the launcher in the foreground shell you want to monitor. Restarts are handled by `node bot.js` exiting with code `75`, after which `start.sh`/`start.cmd` relaunches the bot in the same terminal. Do not restart by spawning a detached background copy of `start.sh`; that hides logs and can leave the shell showing a stale stopped instance.

Recommended Ubuntu packages:

```bash
sudo apt update
sudo apt install -y nodejs npm python3 python3-venv python3-pip ffmpeg git curl gnome-screenshot xdotool android-tools-adb xclip tesseract-ocr
```

Install and authenticate the Codex CLI before starting the bot. If Codex is not on `PATH`, set `CODEX_BIN` in `.env`.

Optional setup scripts can also be run directly:

```bash
./setup-whisper-venv.sh
./setup-tts.sh
./setup-linux-capture-backend.sh install
```

## Command Reference

Current slash commands supported by the bot:

Core:
- `/start` or `/help` - show help
- `/status` - worker and queue status
- `/workers` - list workspaces/workers
- `/use <worker_id|name|title>` - switch active workspace
- `/spawn <local-path> [title]` - create a repo workspace
- `/retire <worker_id|name|title>` - remove a workspace
- `/queue` - show queued prompts
- `/weather [city]` - weather update for today and tomorrow (text + voice when enabled)
- `/cancel` or `/stop` - cancel active run
- `/clear` - clear queued prompts
- `/prune` - prune runtime artifacts (keeps chat context and chat log)
- `/wipe` - wipe runtime artifacts and reset chat context (keeps chat log)
- `/restart` - restart process when workers are idle and queue is empty

Codex command staging flow:
- `/codex` or `/commands` - show command menu
- `/cmd <args>` - stage a raw Codex CLI command
- `/confirm` or `/run` - execute staged command
- `/reject` or `/deny` or `/cancelcmd` - cancel staged command

Sessions:
- `/resume` - list recent sessions
- `/resume <session_id> [text]` - resume a session, optionally with text
- `/new` - clear active resumed session
- `/compress [hint]` - compress active session context

Vision and media:
- `/screenshot` - capture screenshot(s), one per monitor
- `/see <question>` - take screenshot(s) and analyze
- `/ask <question>` - analyze your last sent image
- `/imgclear` - clear last image context
- `/tts <text>` - send TTS voice message
- `/tts [preset:<name>] <text>` - send one voice message with a one-off preset
- `/abtest [text]` - send one sample per voice preset for A/B listening
- `/voice [name|single|worker|list|default]` - set live TTS voice mode/preset (no restart)

Files:
- `/sendfile <relative-path> [caption]` - send file from `ATTACH_ROOT`

WorldMonitor:
- `/news [force] [count]` - ranked headlines from native feed store
- `/newsreport [force|raw]` - WorldMonitor AI check (global + Taiwan)
- `/newsstatus` - monitor status and last alert data

Model selection:
- `/model` - pick model and reasoning effort for this chat

Natural language shortcuts are also mapped to commands (for example `c` -> `/commands`).

## Code structure

- `bot.js` keeps runtime flow and command handlers.
- `lib/core_utils.js` holds shared parsing, text, timeout, and filesystem helpers.
- `lib/natural_commands.js` holds natural-language command alias maps.
- `lib/state_persistence.js` provides debounced state writes.
- `lib/worldmonitor/constants.js` holds static WorldMonitor constants and pattern tables.

## Workspaces and routing

Each worker is a separate Codex lane with its own working directory. The bot still handles Telegram routing and queues, but Codex itself now owns its native config surfaces: MCP servers, plugins, skills, hooks, sandboxing, approvals, and web search are not stripped unless you explicitly configure that.

- One worker runs one job at a time.
- Multiple workers run in parallel.
- Router mode can auto-pick a worker per message.
- Replying to a previous bot message strongly hints routing to that same worker.

Worker count is capped by `ORCH_MAX_CODEX_WORKERS` (default: 5).

## Failure learning memory

The orchestrator keeps a small persistent memory of repeated failure patterns and injects the most relevant lessons into future prompts.

- Lessons are deduplicated per worker/workdir and pruned by TTL/cap.
- The top lessons are included automatically in new prompts to reduce repeat mistakes.
- `/status` shows whether lesson memory is enabled and how many lessons are stored.

## Workflow catalog persistence

Chat workflow automation preferences are mirrored to a dedicated catalog outside the volatile runtime folder so they survive routine cleanup and restart cycles.

- Default location: `%APPDATA%/workflow-catalog.json` on Windows (fallback: `~/.aidolon/workflow-catalog.json`).
- Override location: set `ORCH_WORKFLOW_CATALOG_PATH`.
- This catalog is local-only and not part of Git operations unless you explicitly point it inside your repo.

## Voice flow

Voice notes:
1. Telegram voice note is downloaded.
2. Whisper transcribes locally.
3. Transcript is routed like any text prompt.

Voice replies:
- Enable `TTS_ENABLED=1`.
- If you want automatic voice replies for incoming voice notes, set `TTS_REPLY_TO_VOICE=1`.
- Use `/voice` to switch styles while running; no bot restart needed.
- `/voice worker` enables role-based voices (each worker keeps a stable voice, orchestrator/general uses `starship-comms`).
- `/voice <preset>` or preset buttons switch to single-voice mode (all workers share that one voice).
- Optional: set `TTS_REFERENCE_AUDIO_ZH_TW` to a Taiwanese Mandarin reference clip and Chinese replies will automatically use it.
- Optional override: set `TTS_WORKER_PRESET_MAP` (for example `astra:hologram-ai,orion:starship-comms,nova:cyber-oracle`).
- Sci-fi presets are intentionally stylized:
  - `hologram-ai`: brighter hologram shimmer with stronger gain staging.
  - `starship-comms`: radio-band comms with NASA-style start/end beeps and short interference bursts.
  - `cyber-oracle`: synthetic oracle tone with wider modulation and louder output.
  - `alien-terminal`: layered dual-voice alien timbre with robotic grit.
- `starship-comms` default beep assets live in `resources/tts/` and can be overridden via env vars.
- Preset `anonymous` keeps the previous legacy post-processing chain for A/B comparisons.

## Daily weather briefing

- Optional automatic weather briefing at `06:00` (Asia/Taipei).
- Includes both today and tomorrow forecasts.
- Uses Celsius only.
- Sends text plus a voice message when `TTS_ENABLED=1` and `WEATHER_DAILY_VOICE_ENABLED=1`.
- On-demand slash command: `/weather [city]`.
- Location behavior:
  - If `WEATHER_DAILY_LAT` and `WEATHER_DAILY_LON` are set, that configured location is used.
  - If they are not set, `/weather` asks you to share your Telegram location once and saves it per chat.
  - Telegram bots cannot read phone GPS automatically without an explicit location share from the user.

## Vision and screenshots

- Send an image with a caption to ask directly about that image.
- Send an image first, then ask using `/ask`.
- `/see` captures screenshots and includes them in the vision request.

## Desktop UI automation (Windows and Linux)

Minimal browser-control toolset for real UI testing:

- Windows desktop UI: `tools/ui_automation.ps1` (or `tools/ui.cmd`)
- Linux desktop UI: `tools/ui.sh`
- Windows TV ADB: `tools/tv_capture.ps1`, `tools/tv_open_app.ps1`, `tools/tv_close_app.ps1`, `tools/tv_power.ps1`
- Linux TV ADB: `tools/tv_capture.sh`, `tools/tv_open_app.sh`, `tools/tv_close_app.sh`, `tools/tv_power.sh`
- Power shortcuts: `tools/tv_power_on.cmd`, `tools/tv_power_off.cmd`, `tools/tv_power_on.sh`, `tools/tv_power_off.sh`
- Watch prep workflow: `tools/watch_tv_prep.ps1` on Windows, `tools/watch_tv_prep.sh` on Linux

Supported actions:

- `windows` - list visible top-level windows
- `focus` - focus a window by title or regex
- `click`, `double_click`, `right_click`, `move` - pointer control
- `mouse_down`, `mouse_up` - split press/release control
- `drag` - dedicated start/end drag with custom duration
- `highlight` - temporary visual target box
- `click_text` - OCR-based click on visible text
- `type`, `key` - text and key input (`type` defaults to human-like character-by-character entry for shorter text)
- `clipboard_copy`, `clipboard_paste`, `clipboard_read` - clipboard workflows
- `scroll` - wheel scroll at current or provided cursor point
- `wait` - explicit timing/waits
- `screenshot` - capture active desktop view (single or all screens)
- `batch` - run a JSON list of actions in sequence
- `host` - long-lived JSONL automation host
- `telemetry` - runtime metrics snapshot (totals, failures, adaptive profile, recent events)

Move behavior notes:
- Pointer actions glide from the current cursor position to the target (no teleport jumps).
- `move` supports left-button drag mode (`-DragLeft`) to drag sliders.
- `drag` supports explicit start/end points and drag duration.
- `click`, `double_click`, `right_click`, and `click_text` support `-HighlightBeforeClick`.
- `click_text` supports optional region-targeted OCR (`-RegionX -RegionY -RegionWidth -RegionHeight`) for tighter matching.
- `click_text` supports short-lived OCR caching (`-OcrCacheTtlMs`) to speed repeated host/batch scans.
- `key` now normalizes common Enter aliases (for example `Enter` and `Return`).
- `type` uses randomized per-character delays by default for short strings, and auto-switches to direct send for longer content.
- Pointer actions and drag now include hard cursor-position verification in the result payload.
- Screenshot capture now verifies files were created before returning success.
- Focus is safer by default: ambiguous title/regex matches now fail unless `-AllowAmbiguousFocus` is set.
- Runtime safety gate is available with `AIDOLON_UI_SAFETY_MODE=strict` (use `AIDOLON_UI_ALLOW_MUTATIONS=1` or `-AllowUnsafe` to override).
- `batch` and `host` requests accept optional integer `priority` so higher-priority queued actions execute first.
- `host` supports telemetry control messages (`telemetry`, optional reset) in addition to normal actions.
- Phase 3 adds telemetry and adaptive tuning: repeated cursor misses auto-increase move/drag smoothness, and repeated OCR misses raise OCR cache TTL (and can widen `click_text` scans when safe).

Linux notes:
- Required for UI mutation actions: `xdotool`.
- Required for Linux ADB TV tools: `android-tools-adb`.
- Recommended optional packages: `wmctrl`, `xclip` or `xsel`, `tesseract-ocr`, `gnome-screenshot`, and `gstreamer1.0-pipewire`.
- The Linux `click_text` action needs `tesseract`; without it, OCR calls return a JSON error.
- GNOME Wayland can block normal screenshot tools and the desktop portal may open an interactive rectangle picker. The bot first uses `tools/linux_mutter_screencast_capture.py`, which captures one frame through Mutter ScreenCast and PipeWire without the picker. The legacy trusted framebuffer backend remains available with `AIDOLON_TRUSTED_CAPTURE_SETUP=1`. Interactive desktop portal screenshots are disabled by default; set `AIDOLON_PORTAL_SCREENSHOT_ENABLED=1` only when you intentionally want the local screenshot dialog.
- Linux `highlight` is a lightweight cursor-position wait, not a drawn frame.
- Linux `host` and `telemetry` keep the JSON protocol but do not persist adaptive telemetry yet.

Recommended loop for frontend UX checks:

1. Focus the target app window.
2. Capture screenshot.
3. Perform exactly one action.
4. Capture screenshot again and verify state.
5. Repeat.

## Attachments

Manual:
- `/sendfile <relative-path> [caption]`

Assistant-driven:
- The assistant can emit lines like:
  - `ATTACH: relative/path.ext | optional caption`
- The bot uploads those files and removes ATTACH lines from the visible chat message.

## WorldMonitor (native mode)

The bot uses a native feed engine. You do not need the browser WorldMonitor app.

When enabled (`WORLDMONITOR_MONITOR_ENABLED=1`), it can:
- Fetch RSS/Atom feeds from `worldmonitor_native_feeds.json`
- Maintain a local deduped headline/history store
- Build enriched context (including optional deep article ingest)
- Push threshold-based alerts to Telegram
- Run scheduled or on-demand checks (`/news`, `/newsreport`)

## Configuration

Use `.env.example` as the full source of truth for supported keys and defaults.

Minimum required:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

High-impact bot settings:
- `ALLOW_GROUP_CHAT`, `TELEGRAM_ALLOWED_CHAT_IDS`
- `BOT_REQUIRE_TTY`
- `TELEGRAM_SET_COMMANDS`, `TELEGRAM_COMMAND_SCOPE`, `TELEGRAM_COMMAND_SYNC_TIMEOUT_MS`
- `TELEGRAM_COMMAND_CLEANUP_CHAT_SCOPES`
- `STATE_WRITE_DEBOUNCE_MS`, `STATE_WRITE_MAX_DELAY_MS`
- `CHAT_LOG_FLUSH_INTERVAL_MS`, `CHAT_LOG_BUFFER_MAX_LINES`

Codex execution:
- `CODEX_WORKDIR`
- `CODEX_MODEL`, `CODEX_MODEL_CHOICES`
- `CODEX_REASONING_EFFORT`
- `CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY`, `CODEX_DANGEROUS_FULL_ACCESS`
- `CODEX_DISABLE_MCP`, `CODEX_SEARCH_ENABLED`
- `CODEX_EXEC_JSON`, `CODEX_REASONING_PROGRESS`, `CODEX_REASONING_PROGRESS_MAX_CHARS`
- `CODEX_STREAM_OUTPUT_TO_TERMINAL`, `CODEX_TERMINAL_EVENT_AUDIT`, `CODEX_TERMINAL_RAW_JSON`
- `CODEX_OUTPUT_SCHEMA_ENABLED`, `CODEX_OUTPUT_SCHEMA_FILE`
- `CODEX_TIMEOUT_MS`
- `SCREENSHOT_CAPTURE_TIMEOUT_MS`, `SCREENSHOT_TOOL_TIMEOUT_MS`, `SCREENSHOT_UPLOAD_TIMEOUT_MS`

Orchestration:
- `ORCH_MAX_CODEX_WORKERS`
- `ORCH_ROUTER_ENABLED`
- `ORCH_ROUTER_MAX_CONCURRENCY`
- `ORCH_ROUTER_MODEL`, `ORCH_ROUTER_REASONING_EFFORT`
- `ORCH_ROUTER_PROMPT_FILE`
- `ORCH_LESSONS_ENABLED`
- `ORCH_LESSONS_MAX_ITEMS`
- `ORCH_LESSONS_PER_PROMPT`
- `ORCH_LESSONS_PROMPT_MAX_CHARS`
- `ORCH_LESSON_MAX_TEXT_CHARS`
- `ORCH_LESSON_TTL_DAYS`

Media and voice:
- `WHISPER_ENABLED`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`
- `VISION_ENABLED`
- `TTS_ENABLED`, `TTS_REPLY_TO_VOICE`
- `TTS_MODEL`, `TTS_REFERENCE_AUDIO`, `TTS_REFERENCE_AUDIO_ZH_TW`, `TTS_FFMPEG_BIN`
- `TTS_WORKER_PRESET_MAP`
- `TTS_STARSHIP_BEEP_START`, `TTS_STARSHIP_BEEP_END`

WorldMonitor core:
- `WORLDMONITOR_MONITOR_ENABLED`
- `WORLDMONITOR_NATIVE_FEEDS_PATH`
- `WORLDMONITOR_MONITOR_INTERVAL_SEC`
- `WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS`
- `WORLDMONITOR_INTERVAL_ALERT_MODE`
- `WORLDMONITOR_FEED_ALERTS_ENABLED`
- `WORLDMONITOR_CHECK_LOOKBACK_HOURS`
- `WORLDMONITOR_CHECK_MAX_HEADLINES`
- `WORLDMONITOR_CHECK_FETCH_TIMEOUT_MS`
- `WORLDMONITOR_DEEP_INGEST_CONCURRENCY`
- `WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS`
- `WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE`, `WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE`

Daily weather:
- `WEATHER_DAILY_ENABLED`
- `WEATHER_DAILY_CHAT_ID`
- `WEATHER_DAILY_HOUR`, `WEATHER_DAILY_MINUTE`
- `WEATHER_DAILY_LOCATION_NAME`, `WEATHER_DAILY_LAT`, `WEATHER_DAILY_LON`
- `WEATHER_DAILY_VOICE_ENABLED`
- `WEATHER_FORECAST_TIMEOUT_MS`, `WEATHER_GEOCODING_TIMEOUT_MS`

Prompts:
- `CODEX_PROMPT_FILE`
- `CODEX_VOICE_PROMPT_FILE`
- `ORCH_ROUTER_PROMPT_FILE`

## Prompt files

- `codex_prompt.txt` - default text mode behavior
- `codex_prompt_voice.txt` - voice/TTS style responses
- `codex_prompt_router.txt` - worker routing policy

## Native Codex integration

- The bot launches Codex through `codex exec` and passes the configured sandbox and approval policy instead of forcing full bypass.
- By default the bot adds `--json`, parses Codex JSONL events, and turns reasoning deltas, tool calls, MCP calls, hooks, web search, and turn completion into clean progress updates.
- Normal Telegram replies use `schemas/aidolon-telegram-final.schema.json` with `--output-schema` when enabled; router calls stay plain text.
- MCP servers and plugin-provided MCP servers from Codex config remain available by default. Set `CODEX_DISABLE_MCP=1` only when you intentionally want an isolated run.
- Native Codex web search can be enabled with `CODEX_SEARCH_ENABLED=1`; this is separate from shell/network access in the sandbox.
- Reusable Telegram response behavior is also available as a repo skill under `.agents/skills/`.
- Repo-local plugin packaging uses `.agents/plugins/marketplace.json` plus `plugins/aidolon-native-control`, which exposes the existing desktop/TV scripts as Codex-native MCP tools plus a skill.
- For large tasks, ask Codex explicitly to use subagents. The bot no longer needs to fake that behavior with prompt-only routing.

## Privacy and safety

- Do not commit `.env`.
- Do not commit anything under `runtime/`.
- By default, only configured chat IDs are allowed.
- Group chats are blocked unless explicitly enabled.
- Prefer `CODEX_SANDBOX=workspace-write` and `CODEX_APPROVAL_POLICY=never` for Telegram/noninteractive use. Use `CODEX_DANGEROUS_FULL_ACCESS=1` only on a separately sandboxed machine.

This bot can run Codex with broad machine access depending on your config. Run it only in an environment you trust.

## Troubleshooting

- `poll error: fetch failed`
  - Usually transient network or Telegram API issue. The bot retries.
- Startup `getMe` fetch timeout/failure
  - Keep `TELEGRAM_DNS_RESULT_ORDER=auto` (or `ipv4first` on problematic networks).
  - Check firewall/proxy rules if failures persist.
- Telegram command list not updating
  - Keep `TELEGRAM_SET_COMMANDS=1` and restart.
  - If boot hangs on `deleteMyCommands`, keep `TELEGRAM_COMMAND_CLEANUP_CHAT_SCOPES=0`; that cleanup is optional.
  - Command sync is best-effort during startup and uses `TELEGRAM_COMMAND_SYNC_TIMEOUT_MS`.
- Unexpected CLI argument errors
  - Usually an older bot process is still running. Stop old process and restart.

## License

Use the repo license. If you want a specific license added, add one explicitly.
