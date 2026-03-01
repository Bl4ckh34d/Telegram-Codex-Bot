# Telegram-Codex-Bot (AIDOLON) 🤖🎙️🧠

Talk to the Codex CLI from Telegram. Text in, text out. Voice in, voice out. Screenshots. Attachments. Multi-repo routing so you’re not stuck waiting on one giant job. ✨

This project is built for personal use on your own machine: it runs as a long-polling Telegram bot and executes the Codex CLI locally.

## What You Get (The Fun Parts) 😎

- 🧠 Codex-in-Telegram: send a message, get an answer
- 🎙️ Voice notes: Whisper transcribes them locally, then Codex handles the prompt
- 🔊 Optional voice replies: auto-reply to voice notes with TTS voice messages
- 🖼️ Vision: ask about images you send, or screenshots the bot captures
- 🖥️ Multi-monitor screenshots: `/screenshot` grabs every monitor if you have more than one
- 🧵 Multi-worker orchestration: separate “workspaces” per repo so long jobs don’t block everything
- 🔁 Session resume + compress: keep long work going without constantly re-explaining yourself
- 🧰 Attachments: the assistant can generate files and send them to you in chat
- 🔒 A few safety rails: chat allowlist, single-instance lock, stale-update skip

## Quickstart 🚀

1. Create a Telegram bot and grab the token.
2. Find your Telegram chat id.
3. Copy `.env.example` to `.env` and fill in the basics:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Start the bot.

Notes:
- Windows is the “first-class” environment here (screenshot capture is Windows-only).
- Voice notes need Whisper installed locally (the repo includes a setup script).
- TTS needs ffmpeg available (or configured).

## Run It (For Real) 🏁

Requirements:
- Node.js 18+ (recommended)
- Codex CLI installed and logged in

Windows (recommended):

```bat
copy .env.example .env
start.cmd
```

Whisper (voice note transcription):

```bat
setup-whisper-venv.cmd
```

TTS:
- Enable `TTS_ENABLED=1` in `.env`
- The Windows launcher will try to bootstrap TTS deps automatically when needed

Non-Windows:

```bash
node bot.js
```

## Commands (The Greatest Hits) 🎛️

Basics:
- `/help` - help text
- `/status` - worker + queue status
- `/wmstatus` - WorldMonitor monitor status + last alert snapshot
- `/news [force|raw]` - run a WorldMonitor risk check immediately
- `/cancel` - stop active run(s) for this chat
- `/restart` - restart the bot process

Workspaces (multi-repo, parallel workers):
- `/workers` - list your workspaces
- `/use <worker>` - switch active workspace
- `/spawn <path> [title]` - create a new repo workspace
- `/retire <worker>` - remove a workspace

Vision:
- Send an image with a caption: caption becomes the question
- Send an image without caption, then ask a question as plain text (it uses the last image)
- `/ask <question>` - force “use the last image”
- `/see <question>` - take screenshot(s), then analyze them

TTS:
- `/tts <text>` - force a voice note reply

Sessions:
- `/resume` - list sessions
- `/resume <id> [text]` - resume a session (optionally with a prompt)
- `/new` - clear active resumed session
- `/compress [hint]` - ask Codex to compress/summarize the active session

Attachments:
- `/sendfile <path> [caption]` - send a file from `ATTACH_ROOT`

## Workspaces + Router (Why This Bot Feels Snappy) 🧵

The big workflow problem with a single Codex loop is head-of-line blocking: one long job and everything else queues behind it.

This bot runs multiple Codex “workers” in parallel:
- One worker = one Codex session lane + one working directory (“workspace”)
- Each worker runs one job at a time
- Different workers run at the same time

Routing:
- The bot uses an LLM router to pick the best worker for each message
- If you reply to a previous bot message, that acts as a strong hint to keep the same worker
- The router only proposes creating a new repo worker when you include an explicit local path

Hard cap:
- By default you get 5 Codex workers max (configurable)
- If the cap is hit and a new workspace is needed, the bot asks you to retire one (button click), then continues

Tip:
- On startup, the bot will usually create a dedicated workspace for its own repo (so it can self-edit fast). You can retire it if you don’t want it.

## WorldMonitor Alerts 🌍

This bot now supports a native WorldMonitor-style feed engine, so you do not need to run the WorldMonitor app in the browser.

How it works:
- Loads feed sources from `worldmonitor_native_feeds.json` (generated snapshot of free WorldMonitor feeds)
- Fetches RSS/Atom feeds on interval, stores headline/link/timestamps in local runtime history
- Deep-ingests full article pages, builds compact article summaries, and stores them as report context
- Builds risk scores and Taiwan-focused context from accumulated history
- Adds non-paid telemetry snapshots into context:
  - market/FX/commodity snapshots (Yahoo public chart endpoint)
  - crypto snapshots (CoinGecko public endpoint)
  - seismic activity snapshots (USGS public feed)
  - ADS-B theater posture proxy (OpenSky public states endpoint, Asia theater windows)
  - disaster/humanitarian pressure snapshot (GDACS RSS feed)
  - maritime warning pressure snapshot (NGA broadcast warnings API)
  - critical service health snapshot (major public status pages)
  - macro risk regime snapshot (Yahoo + Alternative.me + mempool.space)
  - prediction-market uncertainty snapshot (Polymarket Gamma API)
  - infrastructure stress proxies from headline clusters (ports, pipelines, subsea cables)
- Assigns headline severity from feed metadata fields (for example severity/priority/category labels)
- Forwards headlines throughout the day at or above your configured minimum severity (for example `critical`)
- Feed alerts are deduped (including normalized title-level dedupe across sources)
- Feed alert messages use a linked headline plus a short 2-3 sentence article summary
- Triggers only on threshold/cooldown/dedupe rules
- Queues a Codex prompt on a dedicated WorldMonitor worker when possible
- Sends the resulting alert summary directly in Telegram chat (text + optional short TTS voice)

## Voice Notes (Whisper) 🎙️

When you send a voice note:
1. The bot downloads it
2. Local Whisper transcribes it
3. The transcript is routed like any normal message

This runs in its own lane so voice transcription doesn’t block other bot work.

## Voice Replies (TTS) 🔊

If enabled, the bot can reply to voice notes with a Telegram voice message (instead of a wall of text).

It uses a “voice-style” prompt so answers stay TTS-friendly. The preferred output format is:
- SPOKEN: short, clean, easy to listen to
- TEXT_ONLY: details that should not be spoken aloud (commands, paths, long lists, etc)

## Screenshots + Vision 🖼️🖥️

- `/screenshot` sends one screenshot per monitor (primary first).
- `/see <question>` captures screenshots and includes them in the vision prompt.

## Attachments 📎

The assistant can send you files in two ways:

1. Manual:
- `/sendfile <relative-path> [caption]` (relative to `ATTACH_ROOT`)

2. Assistant-driven:
- The assistant can include lines like:
  - `ATTACH: relative/path.ext | optional caption`
  - The bot uploads the files and strips those lines from the visible message

## Configuration (The Stuff You Actually Touch) ⚙️

Minimum required:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Most-used toggles:
- `WHISPER_ENABLED` - voice note transcription on/off
- `TTS_ENABLED` and `TTS_REPLY_TO_VOICE` - voice replies
- `VISION_ENABLED` - image + screenshot analysis
- `ORCH_MAX_CODEX_WORKERS` and `ORCH_ROUTER_ENABLED` - multi-worker routing
- `WORLDMONITOR_MONITOR_ENABLED` - background WorldMonitor polling
- `WORLDMONITOR_NATIVE_FEEDS_PATH` - feed manifest used in native mode
- `WORLDMONITOR_NATIVE_FEED_TIMEOUT_MS`, `WORLDMONITOR_NATIVE_FEED_FETCH_CONCURRENCY` - native fetch behavior
- `WORLDMONITOR_NATIVE_STORE_MAX_ITEMS`, `WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS` - local history retention
- `WORLDMONITOR_NATIVE_SIGNAL_TIMEOUT_MS` - timeout for non-news signal fetchers
- `WORLDMONITOR_NATIVE_SIGNALS_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_SEISMIC_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_ADSB_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_DISASTER_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_MARITIME_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_SERVICE_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_MACRO_REFRESH_MIN_INTERVAL_SEC`, `WORLDMONITOR_NATIVE_PREDICTION_REFRESH_MIN_INTERVAL_SEC` - signal refresh cadence
- `WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS` - signal history retention
- `WORLDMONITOR_DEEP_INGEST_ENABLED` - enable full-article scraping/summarization context
- `WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS`, `WORLDMONITOR_DEEP_INGEST_CONCURRENCY` - deep ingest fetch behavior
- `WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE`, `WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS` - enrichment bounds (`0` means no hard cap / full retained window)
- `WORLDMONITOR_DEEP_INGEST_RETRY_COOLDOWN_SEC`, `WORLDMONITOR_DEEP_INGEST_MAX_TEXT_CHARS`, `WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS`, `WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_CHARS` - summary quality/cost controls
- `WORLDMONITOR_WORKDIR` - repo path for dedicated WorldMonitor worker
- `WORLDMONITOR_MONITOR_INTERVAL_SEC` and `WORLDMONITOR_ALERT_COOLDOWN_SEC` - check cadence + anti-spam cooldown
- `WORLDMONITOR_INTERVAL_ALERT_MODE` - interval monitor output mode: `smart` (default), `headlines`, `report`, or `off`
- `WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL` - in interval `smart/headlines` mode, only forward headline links when global level is at least this severity
- `WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY`, `WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY`, `WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC`, `WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA` - full report policy (default baseline 1/day, no hard cap when max_per_day=0, additional same-day reports require significant delta)
- `WORLDMONITOR_ALERT_VOICE_ENABLED` and `WORLDMONITOR_ALERT_VOICE_MAX_CHARS` - optional voice alert output tuning
- `WORLDMONITOR_FEED_ALERTS_ENABLED` - forward WorldMonitor feed `ALERT` headlines/links + short summaries to Telegram
- `WORLDMONITOR_FEED_ALERTS_MIN_LEVEL` - minimum feed alert severity to forward (`critical` by default)
- `WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC` - feed alert relay cadence
- `WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE`, `WORLDMONITOR_FEED_ALERTS_CHAT_ID`, `WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS`, `WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP` - throughput, destination, freshness window, and dedupe memory controls
- `WORLDMONITOR_CHECK_LOOKBACK_HOURS`, `WORLDMONITOR_CHECK_MAX_HEADLINES`, `WORLDMONITOR_CHECK_TAIWAN_COUNTRY_CODE` - `/news` comprehensive report scope (global + Taiwan)

Prompts:
- `codex_prompt.txt` - normal text mode
- `codex_prompt_voice.txt` - voice replies (TTS-friendly)
- `codex_prompt_router.txt` - routing decisions (do not do work, only choose a worker)

## Privacy + Safety Notes 🔒

This bot is designed to run on a personal machine, for a small allowlisted set of chats.

- `.env` is gitignored (keep it that way)
- `runtime/` is gitignored (logs, chat logs, screenshots, outputs, state)
- By default, only the configured chat id is allowed
- Group chats are blocked unless you opt in

Important: by default this bot runs Codex in full-access mode. That’s the point for a personal automation bot, but you should treat it like “giving shell access to an assistant.” Use it in an environment you trust.

Foreground behavior:
- By default, `BOT_REQUIRE_TTY=1` so the bot refuses to start without an interactive terminal.
- If you intentionally want headless/background mode, set `BOT_REQUIRE_TTY=0`.

## Troubleshooting 🧯

- “poll error: fetch failed”
  - Usually a transient network/Telegram hiccup. The bot retries automatically.
- “Fatal startup error: TypeError: fetch failed” on `getMe`
  - On some Windows networks, IPv6 resolution can time out. Keep `TELEGRAM_DNS_RESULT_ORDER=auto` (or set `ipv4first`) in `.env`.
  - Startup now retries `getMe`, but persistent failures still indicate network/proxy/firewall issues.
- Telegram command autocomplete not updating
  - Make sure set-commands is enabled, then restart the bot.
- “unexpected argument …”
  - Often means an older bot window/process is still running. Stop old instances and restart.

## License

Whatever license is in this repo applies. If there isn’t one yet and you want one, say the word and I’ll add it.
