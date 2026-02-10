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

## Troubleshooting 🧯

- “poll error: fetch failed”
  - Usually a transient network/Telegram hiccup. The bot retries automatically.
- Telegram command autocomplete not updating
  - Make sure set-commands is enabled, then restart the bot.
- “unexpected argument …”
  - Often means an older bot window/process is still running. Stop old instances and restart.

## License

Whatever license is in this repo applies. If there isn’t one yet and you want one, say the word and I’ll add it.
