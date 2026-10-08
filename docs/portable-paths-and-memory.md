# Portable paths and shared Codex knowledge

## Local paths

Bot configuration paths are relative to the repository root, independent of the terminal's working directory. For example, `CODEX_WORKDIR=.` selects the bot checkout; `/spawn ../another-project` selects a sibling checkout. Empty `CODEX_WORKDIR` also uses the bot checkout.

The bot stores worker directories, recent image references, lesson workspace keys, and recovery-journal image paths relative to its root. It resolves them to absolute paths when loading them for execution. Existing absolute local references are converted on the next save. No live state file needs to be edited manually.

Move the repository together with its `runtime/` directory. Sibling projects must retain their relative locations, or be selected again using `/spawn` and `/use`. Missing coding workspaces fail visibly; changing a path's representation cannot recreate a missing directory.

OS execution boundaries still use absolute paths. Paths on another Windows drive, paths belonging to a different OS, SSH identity files, external Codex/MCP registrations, and remote commands need host-specific configuration. Bare executable names and remote model IDs are not filesystem paths. Message text, native Codex session data, historical logs, and remote host paths are not rewritten.

The native WorldMonitor pipeline does not require the former standalone `worldmonitor-fork` checkout. It prefers a valid `WORLDMONITOR_WORKDIR`, otherwise a valid stored or matching worker, then the general worker. An unavailable old workspace no longer prevents report jobs from being queued. This does not silently repoint the old coding worker.

## Codex instructions and Obsidian

Codex CLI inherits the current user's native global instructions and the selected workspace's `AGENTS.md`. The bot also appends `codex_rules.md` to every text, voice, and router style prompt, including custom prompts. `CODEX_SHARED_RULES_FILE` may select another file relative to the bot root. Keep host-specific vault locations in the user's global Codex instructions; do not commit personal absolute paths here.

Shared rules require the installed `obsidian-memory` skill, the same existing host-configured vault, Lookup before substantive project work, and Capture after verified reusable results. Captures follow the skill's schema, deduplication, overview links, existing topic taxonomy, and secret exclusions. The rules also retain the host's caveman preference and the explicit Luna/high ceiling for delegated subagents.

Telegram transport does not perform vault synchronization itself. A WSL, laptop, remote, or service-account Codex process must have its own accessible skill and vault configuration. A missing integration must be reported, never replaced with an invented vault. An existing Codex app thread uses the rules of the host where that thread runs; the bot's prompt file does not reconfigure a remote app.

## Group voice messages

The bot checks authorization before downloading or transcribing voice messages. To enable a group, put its numeric chat ID in `TELEGRAM_ALLOWED_CHAT_IDS`, set `ALLOW_GROUP_CHAT=1`, and list authorized senders in `TELEGRAM_ALLOWED_USER_IDS`. Both group and sender must be allowed. Keep these values in private `.env`.

Environment changes require a restart. Until then, an unauthorized group cannot issue `/restart`; use the bot's private chat or restart through the existing terminal launcher. Messages already discarded by authorization must be sent again.

## Responsive speech replies

`TTS_SEND_TEXT=1` now also sends the completed Codex answer immediately when its voice reply is queued. The speech job does not repeat that text on success. With `0`, replies retain voice-only behavior and error fallback.

Automatic WorldMonitor report speech is marked as background work. Direct voice replies go ahead of queued reports. A successfully progressing pipelined report yields its remaining chunks between synthesis requests when a direct reply is waiting. An in-progress synthesis request still needs to complete or time out.

For the local 12 GB desktop profile, `TTS_TIMEOUT_MS=30000`, `TTS_TIMEOUT_RETRIES=0`, and `TTS_HARD_TIMEOUT_MS=120000` bound stalls instead of leaving one request active for ten minutes. Slow hardware or longer speech requests may need larger limits. These local settings live in private `.env`.
