# Codex app chats in Telegram topics

The bot transports text and locally transcribed voice messages directly to the
selected **running Codex desktop app**. It calls the app's `send_message_to_thread`
tool through local IPC, retaining the same thread, model, instructions, workspace,
and conversation. No `codex exec`, model router, or additional inference is used
for delivery. The target chat's normal model turn still consumes its usual usage.

## Configuration

Keep private configuration under ignored `runtime/`. For example,
`runtime/app-hosts.json`:

```json
{
  "default_host": "desktop",
  "hosts": {
    "desktop": {"transport": "local", "label": "PC", "icon": "🖥️"},
    "laptop": {"config_path": "laptop-ssh.json", "label": "Laptop", "icon": "💻"}
  }
}
```

`laptop-ssh.json` uses the existing Companion SSH configuration: `destination`,
`remote_command`, and `ssh_args`. Do not add the local-only entry to a registry
used by the general SSH Companion MCP; use a separate app registry.

Set these in `.env`, and allow the group and its intended users as usual:

```dotenv
APP_COMPANION_CONFIG=runtime/app-hosts.json
APP_TOPIC_GROUP_ID=-1000000000000
```

The Telegram group must have topics enabled and the bot must have
`can_manage_topics`. Keep the Codex app running on each computer; the laptop
also needs its Companion and SSH connection. Update the Companion's
`app-bridge.js` and `app-local-catalog.js` together. Node >=22.19 is required.
Its `runtime/app-bridge.json` can contain `{}` for automatic local discovery,
or explicitly set `contextThreadId` and `pipePath` for multiple app instances.
If multiple pipes exist, discovery uses a read-only check that the configured
context belongs to the local Codex host before selecting a pipe.

## Behavior

- Discovery runs at startup and every 10 seconds. API latency, network outages,
  initial backlog and Telegram rate limits can delay creation.
- Each device + app host + thread gets one persisted topic. PC topics use a blue
  icon and 🖥️; laptop topics use purple and 💻. Names follow app renames.
- Existing history is baselined, not replayed. Subsequent completed commentary
  and final answers are forwarded. Original app-side user prompts, tool outputs,
  permission dialogs, attachments and interactive app UI are not mirrored.
- At most two new topics are created per discovery cycle; newest chats first.
  A large initial catalog takes time (hundreds of chats can take tens of minutes).
  Explicit Telegram rate-limit rejections honor `retry_after`, including voice
  uploads; uncertain network failures are not retried by that mechanism.
  `/app topics` uses the same paced import and enables periodic discovery for
  that group until restart. `APP_TOPIC_GROUP_ID` enables it persistently.
  Existing topics remain when a device goes offline or a chat leaves the catalog.
  Archiving a Codex chat does not delete its Telegram history.
- The app tool exposes only 50 recent unpinned entries. Read-only local Codex
  metadata supplements older user threads; exec jobs, subagents and archived
  threads are excluded from that supplement. A schema incompatibility reports
  degraded coverage rather than silently claiming every chat was synchronized.
- Existing bindings poll with bounded concurrency. Active chats are checked
  frequently; unchanged idle chats are checked at least once per minute.
- The default output mode is `auto`: text input receives text; voice input
  receives speech after local transcription. Existing bindings migrate once to
  this default. The latest Telegram input selects the channel for subsequent
  commentary and final answers; new bindings start with text. Speech errors may
  fall back to text so an answer remains accessible.
- `/app output auto|text|voice|both`, `/app voice`, and `/app screenshots on|off`
  control that topic. Screenshots default off. `/app off` prevents automatic
  recreation for that chat; explicitly reconnect through `/app list` and
  `/app topic <number>` when wanted.
- Other text (including slash-prefixed text except `/app`, `/help`, `/restart`)
  goes to the app. Unsupported attachments produce a notice, never a CLI job.
- Unconfirmed app sends are **not retried automatically**. Check the app before
  resending. Interrupted topic creation is recorded in
  `runtime/app-chat-bindings.json.pending.json`; inspect Telegram before clearing
  that entry or restoring the binding, to avoid duplicate topics.

General Telegram chat remains the existing CLI bot. Ordinary ChatGPT cloud chats
are not supported by this Codex-only bridge. App IPC is a version-dependent
desktop integration; test after app updates. There is no fallback that silently
executes a separate CLI conversation when app transport fails.
