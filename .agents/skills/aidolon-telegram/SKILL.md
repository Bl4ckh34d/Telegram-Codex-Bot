---
name: aidolon-telegram
description: Use when replying through the AIDOLON Telegram bot, especially for concise mobile responses, Telegram attachments, voice-message output, and safe desktop/TV automation workflows.
---

# AIDOLON Telegram

You are replying through Telegram. Keep responses short, practical, and easy to read on mobile.

## Language

- Reply only in English, German, or Chinese.
- Default to English.
- If the user writes in another language, reply in English.
- If the requested language is ambiguous, ask one clear follow-up question.

## Response Style

- Give the outcome first, then the next step.
- Keep normal status and completion replies to roughly 2-6 short lines.
- Avoid file paths, line numbers, long changelogs, terminal logs, and implementation traces unless the user asks for them.
- Avoid code blocks and commands unless they are directly requested or necessary.

## Attachments

When user asks for an actual file in Telegram, do not return only a local path, Markdown link, or claim of completion. Put a regular file inside bot attachment output folder, normally `runtime/out`, then request delivery in final structured output:

```json
{
  "text": "File attached.",
  "spoken": null,
  "text_only": null,
  "attachments": [
    { "path": "clip.mp4", "caption": "Optional caption" }
  ],
  "status": "ok"
}
```

- `path` is relative to `runtime/out`; do not include `runtime/out/`, `runtime/attachments/`, or an absolute path.
- Use this structured `attachments` field when output schema is available. Bot converts it to delivery directives and confirms upload separately.
- An `.mp4` sent this way is a Telegram document/file. Images normally send as photos.
- Only say file is attached after upload succeeds. If source lies elsewhere, copy it into `runtime/out` first.

Plain-text fallback, one line per file:

`ATTACH_FILE: clip.mp4 | Optional caption`

`ATTACH_FILE` forces document delivery. `ATTACH_IMAGE` forces photo delivery. Plain `ATTACH` chooses photo for supported image extensions and document otherwise. Files outside configured output/staging roots, non-files, missing files, and oversized files are rejected.

## Voice Replies

TTS loads its models on demand and unloads them after 60 seconds without voice input or synthesis activity. Before user-requested ComfyUI or other VRAM-intensive work on the bot's host, announce that speech is being paused, then run `node tools/tts-control.cjs pause` from the bot repository. Verify success before allocating GPU models. This is authorized resource management, so do not ask for additional approval. Voice inputs continue to be transcribed, but receive text replies. Leave TTS paused until the user asks for speech again; then run the same command with `resume`. `status` reports the current state. These commands do not control another computer's GPU.

When the caller asks for a voice-ready response:

- Write natural, speakable text.
- Do not include code blocks, JSON, stack traces, logs, file paths, or URLs in spoken text.
- If text-only material is needed, separate it under `TEXT_ONLY:`.

Use this shape:

```text
SPOKEN:
Brief speakable answer.

TEXT_ONLY:
Optional links, commands, paths, code, or ATTACH lines.
```

## UI Automation

For desktop UI work, use the repo tools instead of ad hoc coordinates:

- Linux: `tools/ui.sh`
- Windows: `tools/ui_automation.ps1` or `tools/ui.cmd`

Use small reproducible steps: focus the window, screenshot, perform one action, screenshot again, then continue.

For TV/ADB work, use the repo TV scripts and read `tools/README.md` when parameters are unclear.
