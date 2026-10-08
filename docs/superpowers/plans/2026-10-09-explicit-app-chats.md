# Explicit app chats and lifecycle synchronization

**Goal:** Replace automatic CLI delegation with explicit Telegram device/project selection and synchronize app chat lifecycle.

**Architecture:** Keep the current device transport and app IPC. Extend it with native `list_projects` and `create_thread`. Bind a topic only after a real thread ID and successful read. Track creation attempts durably; never retry an uncertain creation automatically. Only reconcile missing local chats against a successful app query and complete, anchored local metadata including archives. Preserve archives and offline devices.

**Constraints:** Work in the user-designated checkout, preserving existing uncommitted changes. No commits or pushes. No delegated agents. Restart only via the current launcher. General CLI never delegates; project app chat rules remain native.

- [x] Companion lifecycle: tests for project selection, projectless creation, durable duplicate suppression, incomplete/archived metadata; then implement `companion/app-lifecycle.js` and integrate `app-bridge.js` and transport.
- [x] Telegram flow: `/app new`, device buttons, paginated project choices and search, first-message entry, confirmed creation and binding; test offline, stale/duplicate clicks, failures and pending creation.
- [x] Deletion sync: per-device snapshots, two observations of confirmed absence, archived preservation, deletion failure retry and startup reconciliation. Test without external deletion first.
- [x] Retire automatic routing/task splitting and workspace selection commands; keep one general CLI lane plus media/scheduler infrastructure. Verify ordinary and voice routing.
- [ ] Run JS suite and syntax checks; update companion on reachable laptop with recoverable backups. Restart through existing launcher and perform bounded real creation/sync checks. Capture exact verification limits in Obsidian.

Native app schema was inspected read-only: creation accepts `{prompt,title?,target:{type:'projectless'}}` or `{prompt,title?,target:{type:'project',projectId,environment:{type:'local'}}}`. Preserve the app's default model and reasoning; do not inject bot rules into app chats.

Pre-restart evidence: 139 JS tests pass, 2 skipped; syntax and whitespace checks pass. Real PC creation returns a durable thread ID, responds with the test marker, and gains a Telegram topic. Laptop unreachable; lifecycle companion deployment and live laptop testing remain pending. Destructive deletion tested with mocks only. Runtime helper schedules an idle restart and reports post-restart checks without launching a second bot.
