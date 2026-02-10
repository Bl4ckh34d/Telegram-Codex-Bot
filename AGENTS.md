# Agent Instructions

These rules apply to any AI agent (including multi-worker setups) operating in this repo.

## No Unrequested Publishing

- Do not commit, push, or open PRs unless the user explicitly asks for it.
- Default workflow: implement the change, run quick checks, summarize what changed, then ask whether to commit/push.

## Keep Private Stuff Out Of Git

- Never add `.env` to git.
- Never add anything from `runtime/` to git (logs, screenshots, audio, chat logs, state, outputs).

