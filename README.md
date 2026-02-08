# TELEGRAM-CODEX-BOT

Minimal Telegram <-> Codex CLI bridge with basic hardening and stability controls.

## Features
- Long-polling Telegram bot listener
- Chat allowlist enforcement (`TELEGRAM_CHAT_ID` + optional `TELEGRAM_ALLOWED_CHAT_IDS`)
- Single-instance lock (`runtime/bot.lock`)
- Startup stale-update skip (prevents old messages from being re-run)
- FIFO queue with size limits
- Short progress updates while Codex is running (configurable interval)
- Cancel active run (`/cancel` or `/stop`)
- Restart bot process from Telegram (`/restart`)
- Safe Codex invocation via `spawn`; Windows `.cmd` shims use shell mode when required
- Default model/reasoning set to `gpt-5.3-codex` + `xhigh`
- Full-access Codex mode enabled by default (`--dangerously-bypass-approvals-and-sandbox`)
- Optional WSL fallback when `codex` is not on Windows PATH (`CODEX_USE_WSL=auto`, optional `CODEX_WSL_BIN`)
- Voice note transcription via local Whisper venv (`setup-whisper-venv.cmd`)
- Session resume workflow with Telegram prefill buttons (`/resume`)
- Active-session mode (plain text continues in resumed session until `/new`)
- Codex command control menu (`/codex`) with staged command confirmation flow

## Files
- `bot.js` - main bridge process
- `.env` - runtime config
- `.env.example` - template
- `start.cmd` - launcher for Windows CMD
- `ensure-codex-path.ps1` - adds `%APPDATA%\npm` to user PATH when needed
- `setup-whisper-venv.cmd` - creates `.venv` and installs `openai-whisper`
- `whisper_transcribe.py` - small transcription helper called by bot
- `runtime/` - state, lock, and output files

## Run
From CMD:

```bat
cd C:\Users\ROG\Desktop\AIDOLON
start.cmd
```

Whisper setup (one-time):

```bat
cd C:\Users\ROG\Desktop\AIDOLON
setup-whisper-venv.cmd
```

## Telegram commands
- `/help` - command help
- `/status` - current worker and queue status
- `/queue` - preview queued prompts
- `/codex` or `/commands` - show command menu
- `/cmd <args>` - stage raw Codex CLI command
- `/confirm` - run staged `/cmd`
- `/reject` - cancel staged `/cmd`
- `/cancel` or `/stop` - stop the active Codex run
- `/clear` - clear queued prompts
- `/screenshot` - capture and send the primary display as an image
- `/resume` - list recent local Codex sessions with prefill buttons
- `/resume <session_id> [prompt]` - activate/resume a session
- `/new` - clear active resumed session
- `/compress [hint]` - ask Codex to compress/summarize active session context
- `/restart` - restart the bot process
- Voice notes are transcribed and queued as prompts

## Progress updates
- `PROGRESS_UPDATES_ENABLED=1` enables short in-chat progress pings while a job is running
- `PROGRESS_FIRST_UPDATE_SEC=8` delays the first progress ping
- `PROGRESS_UPDATE_INTERVAL_SEC=30` controls periodic progress frequency

## Security notes
- By default, only `TELEGRAM_CHAT_ID` is accepted.
- Group chats are blocked unless `ALLOW_GROUP_CHAT=1`.
- Default Codex policy is full-access (`CODEX_DANGEROUS_FULL_ACCESS=1`).
- If token/chat ID were exposed, rotate token in `@BotFather` and update `.env`.
