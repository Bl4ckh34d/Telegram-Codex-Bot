# UI Automation Toolset (Windows)

This folder contains a minimal desktop automation bridge for real browser UX testing.

## Entrypoints

- `ui_automation.ps1` (PowerShell)
- `ui.cmd` (wrapper that calls PowerShell script)
- `ui_demo_control.ps1` (demo server control)
- `ui_demo.cmd` (wrapper for demo server control)

## Parameters

- `-Action` (required): `windows|focus|click|double_click|right_click|move|mouse_down|mouse_up|drag|highlight|click_text|clipboard_copy|clipboard_paste|clipboard_read|type|key|scroll|wait|screenshot`
- `-Title` (for `focus`)
- `-Regex` (for `focus`, regex match on window title)
- `-X -Y` (for pointer actions; optional for `scroll`)
- `-EndX -EndY` (for `drag`)
- `-MoveDuration` (for pointer moves, default `160`; lower values still glide with a minimum smooth motion window)
- `-MoveSteps` (for pointer moves; `0` means auto step count)
- `-DragDuration` (for `drag`, default `420`; lower values still glide with a minimum smooth motion window)
- `-DragSteps` (for `drag`; `0` means auto step count)
- `-InstantMove` (legacy no-op kept for compatibility; cursor movement stays smooth)
- `-DragLeft` (for `move`; holds left mouse while moving, then releases)
- `-Button` (for `mouse_down`, `mouse_up`, `drag`; `left|right|middle`)
- `-HighlightBeforeClick` (for `click`, `double_click`, `right_click`, `click_text`)
- `-HighlightMilliseconds` (for highlight duration, default `320`)
- `-HighlightWidth -HighlightHeight` (highlight box size)
- `-Text` (for `type`, `click_text`, `clipboard_copy`, optional for `clipboard_paste`)
- `-TypewriterThreshold` (for `type`; default `180`; text at or below this length is typed character-by-character)
- `-TypewriterMinDelay` (for `type`; per-character random delay minimum in ms, default `35`)
- `-TypewriterMaxDelay` (for `type`; per-character random delay maximum in ms, default `110`)
- `-TypeDirect` (for `type`; force direct one-shot send instead of typewriter mode)
- `-TextRegex` (for `click_text`, treat `-Text` as regex)
- `-ExactText` (for `click_text`, exact match mode)
- `-MatchIndex` (for `click_text`, choose Nth ranked OCR match, default `1`)
- `-Keys` (for `key`; accepts SendKeys format or simple `Ctrl+L` style)
- `-Delta` (for `scroll`, default `-120`)
- `-Milliseconds` (for `wait`, default `250`)
- `-Output` (for `screenshot`; defaults under `runtime/out`)
- `-AllScreens` (for `screenshot` and `click_text`)
- `-Limit` (for `windows`, default `20`)

## Output

All actions print a single JSON object to stdout:

- `ok` (`true` or `false`)
- `action`
- `result` on success
- `error` on failure

## Example flow

1. `windows` to identify the target window title.
2. `focus` that window.
3. `screenshot` for baseline.
4. One action (`click`, `type`, `key`, or `scroll`).
5. `screenshot` again to verify.

`type` default behavior:
- Short text uses human-like typewriter entry with slight random delay between characters.
- Longer text automatically switches to direct insert for speed.

Form entry reliability guidance:
- For adjacent form fields, avoid a second coordinate guess: anchor the first field by label with `click_text`, type, then use `key` with `Tab` to move to the next field.
- For paired inputs like display name and email, ensure values are split across fields; if the second value appears in the first field, refocus and retry that field only.

Drag reliability guidance:
- For sliders and draggable controls, prefer `drag` over `move -DragLeft`.
- Anchor near visible labels with `click_text` when possible instead of blind coordinates.
- After dragging, verify value/position changed; if not, retry once with a clearly different offset.

## Demo server control

Use this helper to avoid running the demo server in a foreground terminal:

- `ui_demo.cmd -Action start` - starts `ui_demo_server.js` in background
- `ui_demo.cmd -Action status` - reports PID and health endpoint status
- `ui_demo.cmd -Action open` - opens the demo URL in default browser
- `ui_demo.cmd -Action stop` - stops the background demo server process
- `ui_demo.cmd -Action restart` - restart server in background
