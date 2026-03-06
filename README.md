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
- Windows is the first-class runtime here.
- Screenshot capture is Windows-only.
- Whisper and TTS are optional and can be disabled in `.env`.

## Run

Windows (recommended):

```bat
copy .env.example .env
start.cmd
```

`start.cmd` can bootstrap Whisper and TTS dependencies when those features are enabled.

Non-Windows:

```bash
node bot.js
```

On non-Windows platforms, set up Whisper/TTS dependencies yourself if enabled.

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
- `/prune` - prune runtime artifacts/logs (keeps chat context)
- `/wipe` - wipe runtime artifacts and reset chat context
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
- `/voice [name|list|default]` - pick/set live TTS voice preset (no restart)

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

Each worker is a separate Codex lane with its own working directory.

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

## Voice flow

Voice notes:
1. Telegram voice note is downloaded.
2. Whisper transcribes locally.
3. Transcript is routed like any text prompt.

Voice replies:
- Enable `TTS_ENABLED=1`.
- If you want automatic voice replies for incoming voice notes, set `TTS_REPLY_TO_VOICE=1`.
- Use `/voice` to switch styles while running; no bot restart needed.
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

## Desktop UI automation (Windows)

Minimal browser-control toolset for real UI testing:

- `tools/ui_automation.ps1` (PowerShell entrypoint)
- `tools/ui.cmd` (wrapper)

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

Move behavior notes:
- Pointer actions glide from the current cursor position to the target (no teleport jumps).
- `move` supports left-button drag mode (`-DragLeft`) to drag sliders.
- `drag` supports explicit start/end points and drag duration.
- `click`, `double_click`, `right_click`, and `click_text` support `-HighlightBeforeClick`.
- `key` now normalizes common Enter aliases (for example `Enter` and `Return`).
- `type` uses randomized per-character delays by default for short strings, and auto-switches to direct send for longer content.

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
- `TELEGRAM_SET_COMMANDS`, `TELEGRAM_COMMAND_SCOPE`
- `STATE_WRITE_DEBOUNCE_MS`, `STATE_WRITE_MAX_DELAY_MS`
- `CHAT_LOG_FLUSH_INTERVAL_MS`, `CHAT_LOG_BUFFER_MAX_LINES`

Codex execution:
- `CODEX_WORKDIR`
- `CODEX_MODEL`, `CODEX_MODEL_CHOICES`
- `CODEX_REASONING_EFFORT`
- `CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY`, `CODEX_DANGEROUS_FULL_ACCESS`
- `CODEX_TIMEOUT_MS`

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
- `TTS_MODEL`, `TTS_REFERENCE_AUDIO`, `TTS_FFMPEG_BIN`
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

## Privacy and safety

- Do not commit `.env`.
- Do not commit anything under `runtime/`.
- By default, only configured chat IDs are allowed.
- Group chats are blocked unless explicitly enabled.

This bot can run Codex with broad machine access depending on your config. Run it only in an environment you trust.

## Troubleshooting

- `poll error: fetch failed`
  - Usually transient network or Telegram API issue. The bot retries.
- Startup `getMe` fetch timeout/failure
  - Keep `TELEGRAM_DNS_RESULT_ORDER=auto` (or `ipv4first` on problematic networks).
  - Check firewall/proxy rules if failures persist.
- Telegram command list not updating
  - Keep `TELEGRAM_SET_COMMANDS=1` and restart.
- Unexpected CLI argument errors
  - Usually an older bot process is still running. Stop old process and restart.

## License

Use the repo license. If you want a specific license added, add one explicitly.
