# Agent Instructions

These rules apply to any AI agent (including multi-worker setups) operating in this repo.

## Shared Host Knowledge And Instructions

- Follow `codex_rules.md` as well as the native global Codex instructions. The bot appends this shared file to text, voice, and router prompts, including custom style prompts.
- Use the host's installed `obsidian-memory` skill and existing configured vault for Lookup before substantive project work and Capture after verified reusable results. Do not create a separate Telegram vault.
- Host-specific vault paths belong in the user's global Codex configuration, not in this repository. Keep the existing global caveman preference and explicit Luna/high ceiling for delegated subagents.

## Portable Local Paths

- Store bot-managed workspace, image, recovery, and lesson path references relative to the bot repository. Resolve them against the repository root at runtime, never against the launcher's current directory.
- Do not rewrite message text, remote-machine paths, executable names, model IDs, or historical logs as local paths. Different Windows drives and foreign OS paths require explicit configuration.
- Missing coding workspaces must fail visibly. The native WorldMonitor scheduler may select the valid general worker when its old optional workspace is gone.

## No Unrequested Publishing

- Do not commit, push, or open PRs unless the user explicitly asks for it.
- Default workflow: implement the change, run quick checks, summarize what changed, then ask whether to commit/push.

## Prefer Native Codex Surfaces

- Keep Telegram-specific code as the transport/orchestration layer.
- Prefer native Codex configuration, MCP servers, plugins, skills, hooks, and subagents over custom in-repo replacements.
- Do not disable global or project Codex MCP/plugin configuration unless the user explicitly asks for an isolated run.
- For broad parallel work, ask Codex to use native subagents instead of expanding the bot's custom worker/router logic.

## Keep Private Stuff Out Of Git

- Never add `.env` to git.
- Never add anything from `runtime/` to git (logs, screenshots, audio, chat logs, state, outputs).

## Runtime And Restart Discipline

- Do not start a second detached bot with `nohup`, `setsid`, `disown`, background `./start.sh`, or redirected `runtime/restart_after_*.log` output.
- If the bot is already running under `start.sh` or `start.cmd`, restart it through `/restart` or by making `node bot.js` exit with code `75`; the launcher will relaunch it in the same terminal.
- If the user wants to run the bot manually, stop the existing `node bot.js` process tree first, confirm `runtime/bot.lock` is gone, then let the user start `./start.sh` in their chosen shell.

## Front-End UI Automation Toolset

- For real browser UX testing on Windows, use `tools/ui_automation.ps1` (or `tools/ui.cmd`).
- For real browser UX testing on Linux, use `tools/ui.sh`.
- Minimal supported actions: `windows`, `focus`, `click`, `double_click`, `right_click`, `move`, `type`, `key`, `scroll`, `wait`, `screenshot`.
- Preferred execution loop: focus target window, screenshot, perform one action, screenshot again, repeat.
- Keep actions small and reproducible. Ask for confirmation before destructive steps.
