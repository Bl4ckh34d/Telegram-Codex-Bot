# Codex-Native Overhaul

## Direction

AIDOLON should stay a Telegram transport, media pipeline, and local scheduler. Codex should own agent behavior through native surfaces:

- `AGENTS.md` for durable repo rules
- `.agents/skills` for reusable workflows
- `.codex/agents` for explicit subagent roles
- Codex config for sandbox, approvals, MCP, plugins, hooks, and search
- MCP/plugin servers for live external tools and private connectors

## Implemented Baseline

- Codex runs no longer force `--dangerously-bypass-approvals-and-sandbox` by default.
- `CODEX_SANDBOX` and `CODEX_APPROVAL_POLICY` are passed to Codex runs.
- MCP/plugin-provided MCP servers are inherited by default.
- `CODEX_DISABLE_MCP=1` is available only for intentional isolation.
- `CODEX_SEARCH_ENABLED=1` enables native Codex web search without granting shell network access.
- Telegram response behavior is available as the `aidolon-telegram` repo skill.
- Project-scoped custom agents are available for explicit architecture and verification subagent work.

## Keep Custom In The Bot

- Telegram polling, chat authorization, message chunking, and attachment upload
- Whisper/TTS/media conversion
- Local queueing needed to avoid overlapping Telegram-triggered jobs
- WorldMonitor feed ingestion and weather scheduling

## Prefer Native Codex For

- MCP access to docs, browsers, GitHub, Sentry, Drive, Slack, and similar services
- Plugins and skills for reusable task workflows
- Hooks for policy checks and lifecycle automation
- Explicit subagents for broad reviews or parallel codebase work
- Codex permissions instead of bot-side hardcoded safety assumptions
