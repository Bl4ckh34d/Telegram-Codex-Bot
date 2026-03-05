# Agent Instructions

These rules apply to any AI agent (including multi-worker setups) operating in this repo.

## No Unrequested Publishing

- Do not commit, push, or open PRs unless the user explicitly asks for it.
- Default workflow: implement the change, run quick checks, summarize what changed, then ask whether to commit/push.

## Keep Private Stuff Out Of Git

- Never add `.env` to git.
- Never add anything from `runtime/` to git (logs, screenshots, audio, chat logs, state, outputs).

## Front-End UI Automation Toolset

- For real browser UX testing on Windows, use `tools/ui_automation.ps1` (or `tools/ui.cmd`).
- Minimal supported actions: `windows`, `focus`, `click`, `double_click`, `right_click`, `move`, `type`, `key`, `scroll`, `wait`, `screenshot`.
- Preferred execution loop: focus target window, screenshot, perform one action, screenshot again, repeat.
- Keep actions small and reproducible. Ask for confirmation before destructive steps.
