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
`can_manage_topics` and `can_delete_messages`. Keep the Codex app running on each computer; the laptop
also needs its Companion and SSH connection. Update the Companion's
`app-bridge.js`, `app-lifecycle.js`, and `app-local-catalog.js` together. Node >=22.19 is required.
Its `runtime/app-bridge.json` can contain `{}` for automatic local discovery,
or explicitly set `contextThreadId` and `pipePath` for multiple app instances.
If multiple pipes exist, discovery uses a read-only check that the configured
context belongs to the local Codex host before selecting a pipe.

## Behavior

- `/app new` in the forum opens device selection, then that running app's local
  projects (eight per page, searchable) or **No repository**. Reply to the bot's
  explicit prompt with the first message. Only the menu owner can continue it.
  Native `create_thread` starts the app turn without overriding its model,
  workspace instructions, memory, or subagent policy. A topic is created only
  after a real thread ID and successful app read. Its first answer is replayed.
  Offline devices and unsupported app versions cannot create placeholder topics.
  Confirmed creation results are durable and idempotent. Uncertain creation is
  never retried; inspect the app. `/app new` can retry binding after confirmed
  creation without creating another app chat.

- Discovery runs at startup and every 10 seconds. API latency, network outages,
  initial backlog and Telegram rate limits can delay creation.
- Each device + app host + thread gets one persisted topic. PC topics use a blue
  icon and 🖥️; laptop topics use purple and 💻. Names follow app renames.
  Chats whose app host is not `local` additionally start with 🌐, including
  SSH and cloud hosts. The device icon still identifies the connected app.
- Human Telegram topic renames also update the linked local app chat through
  native `set_thread_title`, without a new model turn. Only the configured
  device prefix (for example `🌐 🖥️ PC · `) is removed. Punctuation and emojis
  inside the actual title remain. The bot restores device decoration in Telegram
  after synchronization, ignores its own edit events, and queues offline renames
  durably. Stale discovery cannot immediately overwrite the requested title.
  Update the companion on each device. Non-local SSH/cloud app hosts remain
  unsupported for reverse renaming because this native setter has no host selector.
- Existing history is baselined, not replayed. Subsequent completed commentary
  and final answers are forwarded. Original app-side user prompts, tool outputs,
  permission dialogs, attachments and interactive app UI are not mirrored.
- At most two new topics are created per discovery cycle; newest chats first.
  A large initial catalog takes time (hundreds of chats can take tens of minutes).
  Explicit Telegram rate-limit rejections honor `retry_after`, including voice
  uploads; uncertain network failures are not retried by that mechanism.
  `/app topics` uses the same paced import and enables periodic discovery for
  that group until restart. `APP_TOPIC_GROUP_ID` enables it persistently.
  Existing topics remain when a device goes offline or a chat leaves only the
  filtered catalog. Deletion requires two successful, complete device snapshots
  at least ten seconds apart, anchored to the configured local app context.
  The read-only metadata includes archived and non-sidebar threads. Confirmed
  absence deletes only the matching topic (including Telegram message history),
  at most two per cycle. Failed deletion retains the binding for retry.
  Missing/incomplete metadata never authorizes deletion. Non-local app hosts
  are not automatically deleted because their complete inventory is unavailable.
  Confirmed archiving follows the same two-snapshot rule and closes the matching
  Telegram topic while preserving its messages and binding. Unarchiving reopens
  that same topic. Complete local archive metadata overrides stale sidebar rows.
  Actual app-chat deletion still deletes its topic after confirmed absence.
  Closing a topic in Telegram archives its linked app chat through native
  `set_thread_archived`, without sending a prompt. Deleted Telegram topics also
  archive their app chats and are not recreated. Telegram has no topic-deleted
  update or topic lookup: two topics per discovery cycle are checked by
  reapplying their app-owned title, with at least five minutes between checks
  of one topic. A large catalog can therefore take longer to detect deletion.
  Explicit missing-topic errors also trigger archival. Timeouts, permission
  errors and incomplete app catalogs do not count as deleted topics.
  Archive requests persist and retry the idempotent setter after device
  recovery. Closing, deleted and archive-pending topics stop forwarding input
  and replies. Bot-generated close events do not echo back into the app.
  Unarchiving in the app reopens retained topics; a deleted topic is recreated
  only after the app chat is restored. Update `companion/app-bridge.js` on each
  device for this action. No app prompt is replayed.
- The app tool exposes only 50 recent unpinned entries. Read-only local Codex
  metadata supplements older user threads; exec jobs, subagents and archived
  threads are excluded from that supplement. A schema incompatibility reports
  degraded coverage rather than silently claiming every chat was synchronized.
- Existing bindings poll with bounded concurrency. Active chats are checked
  frequently; unchanged idle chats are checked at least once per minute.
  Background read failures are retried silently and recorded for `/app status`.
  An offline device does not produce repeated connection notices in its topics;
  explicit message-delivery failures are still shown to the sender.
  SSH connection failures and request timeouts pause background requests for
  the whole device: 30 seconds, 1, 2, 4, 8, then at most 10 minutes. One probe
  is admitted after each pause; queued topic reads do not start more SSH
  processes. Successful contact resets the delay. A missing individual chat
  does not mark the device offline. Explicit sends, chat creation and project
  selection may try immediately when no recovery probe is already running;
  uncertain mutations are never automatically replayed.
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
  goes to the app. Photos and documents are downloaded (at most 20 MiB each),
  transferred to the selected device and referenced in that same app chat.
  Captions are preserved; files without captions receive a short inspection
  request. Images are opened with the app agent's image tool; other documents
  use suitable local readers. These are local file references, not native
  drag-and-drop attachment previews. Format support depends on the available
  readers. Files are never executed by the transfer layer.
  Each album item is a separate Telegram message and delivery.
- Files remain under `runtime/app-attachments` on the target device so the chat
  can read them later. Temporary bot downloads are removed after transfer.
  Delivery records prevent the same Telegram message from starting another
  turn after an uncertain send. A deliberate resend as a new Telegram message
  has a new delivery identity. There is no automatic retention cleanup yet.
- Remote installations must update `companion/app-attachments.js`,
  `companion/app-bridge.js` and `companion/request.js` together. A capability
  check blocks file delivery to old companions, rather than sending only the
  caption. The target app host must be `local` on the selected device.
- Unconfirmed app sends are **not retried automatically**. Check the app before
  resending. Interrupted topic creation is recorded in
  `runtime/app-chat-bindings.json.pending.json`; inspect Telegram before clearing
  that entry or restoring the binding, to avoid duplicate topics.

General Telegram chat uses one CLI assistant. Automatic routing, task splitting,
and worker selection are retired. CLI calls disable `features.multi_agent` and
instruct the main assistant not to delegate. Old worker commands explain the new
`/app new` flow; queues, media, schedules, recovery and historical state remain.
Project app chats still follow their device's native subagent rules.

Ordinary ChatGPT cloud chats
are not supported by this Codex-only bridge. App IPC is a version-dependent
desktop integration; test after app updates. There is no fallback that silently
executes a separate CLI conversation when app transport fails.
