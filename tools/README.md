# UI Automation Toolset (Windows)

This folder contains a minimal desktop automation bridge for real browser UX testing.

## Entrypoints

- `ui_automation.ps1` (PowerShell)
- `ui.cmd` (wrapper that calls PowerShell script)
- `tv_capture.ps1` (ADB TV screenshot capture, pull, and remote cleanup)
- `tv_capture.cmd` (wrapper that calls `tv_capture.ps1`)
- `tv_open_app.ps1` (ADB TV app launcher with presets)
- `tv_open_app.cmd` (wrapper that calls `tv_open_app.ps1`)
- `tv_close_app.ps1` (ADB TV app closer with presets)
- `tv_close_app.cmd` (wrapper that calls `tv_close_app.ps1`)
- `tv_power.ps1` (ADB TV power control: on/off/toggle)
- `tv_power.cmd` (wrapper that calls `tv_power.ps1`)
- `tv_power_on.cmd` (turn TV on / wake)
- `tv_power_off.cmd` (turn TV off / sleep)
- `watch_tv_prep.ps1` (single workflow: Sunshine -> TV on -> Artemis -> stream attempt -> Firefox TV window -> open sites)
- `watch_tv_prep.cmd` (wrapper that calls `watch_tv_prep.ps1`)

## Parameters

- `-Action` (required): `windows|focus|click|double_click|right_click|move|mouse_down|mouse_up|drag|highlight|click_text|clipboard_copy|clipboard_paste|clipboard_read|type|key|scroll|wait|screenshot|batch|host|telemetry`
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
- `-RegionX -RegionY -RegionWidth -RegionHeight` (for `click_text`, optional OCR search region in global screen coordinates)
- `-OcrCacheTtlMs` (for `click_text`, OCR cache TTL in milliseconds, default `1200`)
- `-Keys` (for `key`; accepts SendKeys format or simple `Ctrl+L` style)
- `-Delta` (for `scroll`, default `-120`)
- `-Milliseconds` (for `wait`, default `250`)
- `-Output` (for `screenshot`; defaults under `runtime/out`)
- `-AllScreens` (for `screenshot` and `click_text`)
- `-Limit` (for `windows`, default `20`)
- `-TelemetryRecent` (for `telemetry`; number of recent events to include, default `20`)
- `-TelemetryReset` (for `telemetry`; reset telemetry counters/events before returning snapshot)
- `-CommandsJson` (for `batch`; JSON array/object of nested actions)
- `-AllowAmbiguousFocus` (for `focus`; allow first match when title/regex matches multiple windows)
- `-AllowUnsafe` (bypass strict safety gate for a single call)

## Output

All actions print a single JSON object to stdout:

- `ok` (`true` or `false`)
- `action`
- `result` on success
- `error` on failure

`host` mode:
- Start with `-Action host` and stream JSON lines over stdin.
- Each line should include at least `{"action":"..."}` and optional fields matching normal parameters.
- The host replies with one JSON object per line.
- Host requests support optional integer `priority` (higher runs first when multiple requests are queued together).
- Host supports `{"action":"telemetry"}` and `{"action":"telemetry","telemetryReset":true}` control calls without queueing.
- Send `{"action":"shutdown"}` to stop the host cleanly.

`batch` mode:
- Use `-Action batch -CommandsJson '[{"action":"focus","title":"..."},
{"action":"click","x":100,"y":200}]'`.
- Stops on first failed sub-command and returns partial results.
- Batch items support optional integer `priority` (higher runs first; equal priority keeps original order).
- Batch responses now include telemetry snapshots and per-item adaptive tuning metadata.

`telemetry` action:
- Returns counters, failure breakdown, per-action stats, adaptive profile, and recent event samples.
- Can reset telemetry state with `-TelemetryReset`.

Safety gate:
- `AIDOLON_UI_SAFETY_MODE=strict` enables a runtime mutation guard.
- In strict mode, mutating actions are blocked unless `AIDOLON_UI_ALLOW_MUTATIONS=1` or `-AllowUnsafe` is provided.

## Example flow

1. `windows` to identify the target window title.
2. `focus` that window.
3. `screenshot` for baseline.
4. One action (`click`, `type`, `key`, or `scroll`).
5. `screenshot` again to verify.

Post-action verification:
- Pointer actions now hard-verify final cursor position with tolerance.
- `screenshot` now verifies output files were created successfully.

OCR improvements:
- `click_text` now supports region-targeted OCR scans to reduce false positives and speed up matching.
- OCR results are cached briefly per captured region in long-lived host/batch flows.

Adaptive tuning (Phase 3):
- Host and batch requests apply safe auto-tuning when recent failures cluster.
- Repeated cursor-miss failures increase movement/drag duration and minimum step counts.
- Repeated OCR no-match failures raise OCR cache TTL and can promote `AllScreens` for `click_text` when not explicitly set.

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

## TV screenshot flow (ADB)

Use `tv_capture.ps1` when capturing screenshots from a connected Android TV.

Default behavior (single command):
- Deletes any stale remote files that match `orion_capture_*.png` in `/sdcard/Download`
- Captures a new screenshot on TV
- Pulls it locally into `runtime/out`
- Deletes the remote TV copy
- Verifies remote cleanup and local file creation

Outputs one JSON line to stdout with `ok`, `localPath`, `bytes`, and status fields.

Useful parameters:
- `-Serial <device>` select a specific ADB device
- `-OutputDir <dir>` set local destination folder
- `-RemoteDir <dir>` and `-RemotePrefix <prefix>` customize TV location/pattern

## TV app tools (ADB)

Use `tv_open_app.ps1` for app launches on a connected Android TV.

Actions:
- `youtube`
- `netflix`
- `sunshine`
- `artemis`
- `retroarch`
- `custom` (requires `-Package`)

Useful parameters:
- `-Action <youtube|netflix|sunshine|artemis|retroarch|custom>`
- `-Serial <device>` select a specific ADB device
- `-Package <android.package.name>` for `custom`
- `-Activity <activity>` optional explicit activity for `custom` or advanced launch cases
- `-WaitMs <milliseconds>` post-launch settle wait

Use `tv_close_app.ps1` for closing apps on a connected Android TV.

Actions:
- `youtube`
- `netflix`
- `sunshine`
- `artemis`
- `retroarch`
- `vlc`
- `spotify`
- `custom` (requires `-Package`)

Useful parameters:
- `-Action <youtube|netflix|sunshine|artemis|retroarch|vlc|spotify|custom>`
- `-Serial <device>` select a specific ADB device
- `-Host <ip-or-hostname>` connect to TV over ADB Wi-Fi (uses `:5555` by default)
- `-Port <port>` customize ADB Wi-Fi port when needed
- `-Package <android.package.name>` for `custom`
- `-WaitMs <milliseconds>` post-close settle wait

## TV power tools (ADB over Wi-Fi or USB)

Use `tv_power.ps1` to wake the TV or turn it off.

Actions:
- `on` (sends wake + home)
- `off` (sends sleep only)
- `toggle` (single power key event)

Useful parameters:
- `-Action <on|off|toggle>`
- `-Serial <device>` select a specific ADB device
- `-Host <ip-or-hostname>` connect to TV over ADB Wi-Fi (uses `:5555` by default)
- `-Port <port>` customize ADB Wi-Fi port when needed
- `-WaitMs <milliseconds>` settle wait before status sampling

Shortcut wrappers:
- `tv_power_on.cmd`
- `tv_power_off.cmd`

## One-shot TV watch prep

Use `watch_tv_prep.ps1` to automate the fixed setup before selecting a show/movie.

Default flow:
- Restart Sunshine (if running, close first; otherwise start) and verify process is running
- Wake TV
- Wait 2 seconds
- Launch Artemis on TV
- Wait 2 seconds
- Attempt Artemis connect/start stream with center-button key presses
- Wait for second-display activation (or continue if `-AllowUnverifiedStream`)
- Open a brand new Firefox window
- Move it to TV monitor with `Win+Shift+Right` (or `-MoveDirection Left`)
- Fullscreen
- Open `https://s.to`, then open `https://sflix.ps` in a new tab

Useful parameters:
- `-SunshineCommand <path>` launcher command or script
- `-TvHost <ip>` / `-TvPort <port>` / `-TvSerial <serial>`
- `-SkipArtemisKeySequence`
- `-AllowUnverifiedStream` (default on)
- `-MoveDirection <Left|Right>`
- `-DryRun` (prints JSON plan without executing actions)
