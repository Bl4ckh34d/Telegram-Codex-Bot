# AIDOLON

Minimal Telegram <-> AIDOLON (Codex CLI) bridge with basic hardening and stability controls.

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
- Optional persistent Whisper worker (`WHISPER_KEEP_LOADED=1`) to keep the model loaded between voice notes
- Session resume workflow with Telegram prefill buttons (`/resume`)
- Active-session mode (plain text continues in resumed session until `/new`)
- Codex command control menu (`/codex`) with staged command confirmation flow
- Per-chat model + reasoning picker (`/model`)
- Stream Codex stdout/stderr into the bot terminal (`CODEX_STREAM_OUTPUT_TO_TERMINAL=1`)

## Files
- `bot.js` - main bridge process
- `.env` - runtime config
- `.env.example` - template
- `start.cmd` - launcher for Windows CMD
- `ensure-codex-path.ps1` - adds `%APPDATA%\npm` to user PATH when needed
- `setup-whisper-venv.cmd` - creates `.venv` and installs `openai-whisper`
- `whisper_transcribe.py` - small transcription helper called by bot
- `aidolon_tts_synthesize.py` - small TTS helper (MiraTTS -> WAV)
- `aidolon_tts_worker.py` - optional persistent TTS worker process
- `aidolon_whisper_worker.py` - optional persistent Whisper worker process
- `setup-tts.cmd` - installs bot-local TTS deps (auto-run by `start.cmd` when `TTS_ENABLED=1`)
- `codex_prompt.txt` - base (system) prompt preamble
- `codex_prompt_voice.txt` - voice/TTS-friendly prompt preamble used for voice-note transcripts
- `runtime/` - state, lock, and output files

## Run
From CMD:

```bat
cd C:\Users\ROG\Desktop\AIDOLON
start.cmd
```

Whisper setup (optional one-time):

```bat
cd C:\Users\ROG\Desktop\AIDOLON
setup-whisper-venv.cmd
```

By default, `start.cmd` will try to bootstrap `uv` (unless `UV_ENABLED=0`) and will auto-run `setup-whisper-venv.cmd` when `WHISPER_ENABLED=1`. Control with `UV_ENABLED=auto|1|0` and `WHISPER_ENABLED=0|1` in `.env`.

## Telegram commands
- `/help` - command help
- `/status` - current worker and queue status
- `/queue` - preview queued prompts
- `/codex` or `/commands` - show command menu
- `/cmd <args>` - stage raw Codex CLI command
- `/confirm` (or `/run`) - run staged `/cmd`
- `/reject` (or `/deny`) - cancel staged `/cmd`
- `/cancel` or `/stop` - stop the active Codex run
- `/clear` - clear queued prompts
- `/screenshot` - capture and send the primary display as an image
- `/sendfile <path> [caption]` - send a file attachment (from `ATTACH_ROOT`)
- `/ask <question>` - analyze the last image you sent (requires `VISION_ENABLED=1`)
- `/see <question>` - take a screenshot and analyze it (requires `VISION_ENABLED=1`)
- `/imgclear` - clear the last image context (so plain text goes back to Codex)
- `/model` - pick the model + reasoning effort for this chat
- `/tts <text>` - synthesize TTS and send a Telegram voice message (requires `TTS_ENABLED=1`)
- `/resume` - list recent local sessions with prefill buttons
- `/resume <session_id> [prompt]` - activate/resume a session
- `/new` - clear active resumed session
- `/compress [hint]` - ask Codex to compress/summarize active session context
- `/restart` - restart the bot process
- Voice notes are transcribed and queued as prompts

### Telegram slash suggestions
Telegram's command autocomplete is driven by `setMyCommands`:
- Make sure `TELEGRAM_SET_COMMANDS=1`
- Configure `TELEGRAM_COMMAND_SCOPE` (supports comma-separated scopes like `default,all_private_chats,all_group_chats`)
- If Telegram doesn't show newly added commands yet, restart the bot

## Image analysis (vision)
If enabled, the bot can answer questions about images you send in Telegram:
- Send an image with a caption: the caption is used as the question.
- Send an image without a caption, then send a question as text (it will analyze the last image).
- Use `/ask <question>` explicitly to analyze the last image.
- Use `/see <question>` to take a screenshot on the host machine and analyze it.

Config (in `.env`):
- `VISION_ENABLED=1`
- Requires Codex CLI image support (`codex exec --image`) and an authenticated `codex` login
- Uses `CODEX_MODEL` for vision (make sure it supports images)
- Optional: `VISION_MAX_FILE_MB`, `VISION_AUTO_FOLLOWUP_SEC`

## TTS (voice messages)
The bot can synthesize text into a Telegram voice message using MiraTTS:
- Enable: `TTS_ENABLED=1`
- Configure: `TTS_MODEL` (path to the local MiraTTS model directory)
- Optional: `TTS_REFERENCE_AUDIO` (defaults to `assets\\reference.wav`, gitignored)
- Optional: `TTS_SAMPLE_RATE` (defaults to `48000`)
- Optional: `TTS_REPLY_TO_VOICE=1` to auto-reply to incoming voice notes with a voice message (otherwise replies are text).
- Optional (auto voice replies): split long `SPOKEN` into multiple voice notes with `TTS_VOICE_MAX_CHARS`, `TTS_VOICE_MAX_SENTENCES`, `TTS_VOICE_MAX_CHUNKS` (0 = unlimited; batch-synthesized for speed).
- Run: `/tts <text>`
- Requires `ffmpeg` on PATH (or set `TTS_FFMPEG_BIN`).
- `start.cmd` will automatically run `setup-tts.cmd` to create `TTS_VENV_PATH` (default `.tts-venv`) and install MiraTTS deps for this repo.

## Base prompt (system prompt)
The preamble sent to Codex before each user message is loaded from `codex_prompt.txt` (set `CODEX_PROMPT_FILE` to change the path).

For voice-note transcripts (incoming Telegram voice messages), the bot can use a separate “spoken” prompt preamble from `codex_prompt_voice.txt` (set `CODEX_VOICE_PROMPT_FILE` to change the path). This is useful when `TTS_REPLY_TO_VOICE=1` so responses are TTS-friendly (no commands, paths, or other symbol-heavy text).

## File attachments
The bot can send local files as Telegram document attachments.

- Manual: `/sendfile <path> [caption]` (path is resolved relative to `ATTACH_ROOT`)
- Assistant-driven: include one or more lines in a reply:
  - `ATTACH: relative/path.ext | optional caption`
  - The bot uploads the file(s) and removes these `ATTACH:` lines from the displayed message.

Config (in `.env`):
- `ATTACH_ENABLED=1`
- `ATTACH_ROOT` (defaults to `runtime/out`)
- `ATTACH_MAX_FILE_MB`
- `ATTACH_UPLOAD_TIMEOUT_MS`

## Progress updates
- `PROGRESS_UPDATES_ENABLED=1` enables short in-chat progress pings while a job is running (default is off)
- `PROGRESS_FIRST_UPDATE_SEC=0` minimum runtime before sending progress messages (set >0 to suppress updates for short runs)
- `PROGRESS_UPDATE_INTERVAL_SEC=30` minimum seconds between progress messages (updates are output-driven, not a fixed timer)

## Timeouts
- `CODEX_TIMEOUT_MS` sets a hard wall-clock timeout for Codex jobs (default `0` = disabled).
- `TTS_TIMEOUT_MS` sets a hard wall-clock timeout for TTS synthesis (default `0` = disabled).
- `TELEGRAM_API_TIMEOUT_MS` sets a timeout for Telegram API JSON requests (default `0` = disabled).
- `TELEGRAM_UPLOAD_TIMEOUT_MS` sets a timeout for Telegram API multipart uploads (default `0` = disabled).

## Model picker
- `/model` shows buttons to pick a model and a reasoning effort for the current chat.
- Configure the button list with `CODEX_MODEL_CHOICES` (comma-separated).
- Optionally set `CODEX_REASONING_EFFORT_CHOICES` (comma-separated). Default is low, medium, high, xhigh.

## Terminal output
- `CODEX_STREAM_OUTPUT_TO_TERMINAL=1` streams Codex stdout/stderr into the terminal running the bot (default is on).
- Set `CODEX_STREAM_OUTPUT_TO_TERMINAL=0` to disable if it's too noisy.
- `TERMINAL_COLORS=1` and `CHAT_LOG_USE_COLORS=1` colorize chat logs in the terminal (your messages vs bot replies).
- Set `NO_COLOR=1` to force-disable ANSI colors.

## Telegram formatting
By default, the bot renders `**bold**` as Telegram bold. Disable with `TELEGRAM_FORMAT_BOLD=0`.

## Security notes
- By default, only `TELEGRAM_CHAT_ID` is accepted.
- Group chats are blocked unless `ALLOW_GROUP_CHAT=1`.
- Default policy is full-access (`CODEX_DANGEROUS_FULL_ACCESS=1`).
- If token/chat ID were exposed, rotate token in `@BotFather` and update `.env`.
