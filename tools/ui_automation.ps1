[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("windows", "focus", "click", "double_click", "right_click", "move", "mouse_down", "mouse_up", "drag", "highlight", "click_text", "clipboard_copy", "clipboard_paste", "clipboard_read", "type", "key", "scroll", "wait", "screenshot", "batch", "host", "telemetry")]
  [string]$Action,
  [string]$Title = "",
  [string]$Regex = "",
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [int]$EndX = [int]::MinValue,
  [int]$EndY = [int]::MinValue,
  [int]$MoveDuration = 160,
  [int]$MoveSteps = 0,
  [int]$DragDuration = 420,
  [int]$DragSteps = 0,
  [switch]$InstantMove,
  [switch]$DragLeft,
  [ValidateSet("left", "right", "middle")]
  [string]$Button = "left",
  [switch]$HighlightBeforeClick,
  [int]$HighlightMilliseconds = 320,
  [int]$HighlightWidth = 100,
  [int]$HighlightHeight = 36,
  [string]$Text = "",
  [switch]$TypeDirect,
  [int]$TypewriterThreshold = 180,
  [int]$TypewriterMinDelay = 8,
  [int]$TypewriterMaxDelay = 28,
  [switch]$TextRegex,
  [switch]$ExactText,
  [int]$MatchIndex = 1,
  [int]$RegionX = [int]::MinValue,
  [int]$RegionY = [int]::MinValue,
  [int]$RegionWidth = 0,
  [int]$RegionHeight = 0,
  [int]$OcrCacheTtlMs = 1200,
  [string]$Keys = "",
  [int]$Delta = -120,
  [int]$Milliseconds = 100,
  [string]$Output = "",
  [switch]$AllScreens,
  [int]$Limit = 20,
  [int]$TelemetryRecent = 20,
  [switch]$TelemetryReset,
  [string]$CommandsJson = "",
  [switch]$AllowAmbiguousFocus,
  [switch]$AllowUnsafe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:UiReturnMode = $false
$script:UiLastResult = $null
$script:UiResultSignal = "__AIDOLON_UI_RESULT__"
$script:UiOcrCache = @{}
$script:UiQueueSequence = 0L
$script:UiActionStartedAt = $null
$script:UiTelemetryMaxEvents = 240
$script:UiTelemetry = [ordered]@{
  started_at_utc = [DateTime]::UtcNow
  total = 0
  success = 0
  failed = 0
  actions = @{}
  failures = @{}
  events = New-Object System.Collections.ArrayList
}

function Clamp-Int {
  param(
    [int]$Value,
    [int]$Minimum,
    [int]$Maximum
  )
  if ($Value -lt $Minimum) { return $Minimum }
  if ($Value -gt $Maximum) { return $Maximum }
  return $Value
}

function Classify-UiError {
  param([string]$ErrorMessage)
  $msg = ([string]$ErrorMessage).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($msg)) { return "unknown" }
  if ($msg.Contains("cursor did not")) { return "cursor_miss" }
  if ($msg.Contains("no ocr text match")) { return "ocr_no_match" }
  if ($msg.Contains("invalid text regex")) { return "ocr_regex_invalid" }
  if ($msg.Contains("focus target is ambiguous")) { return "focus_ambiguous" }
  if ($msg.Contains("no matching window found")) { return "focus_not_found" }
  if ($msg.Contains("safety gate blocked")) { return "safety_blocked" }
  if ($msg.Contains("no screen is available")) { return "screen_unavailable" }
  if ($msg.Contains("invalid json input")) { return "invalid_json" }
  return "other"
}

function Get-UiTelemetryRecentEvents {
  param([int]$Count = 30)
  $safeCount = Clamp-Int -Value $Count -Minimum 1 -Maximum 400
  $events = @($script:UiTelemetry.events | ForEach-Object { $_ })
  if ($events.Count -le $safeCount) { return $events }
  return @($events[($events.Count - $safeCount)..($events.Count - 1)])
}

function Get-UiAdaptiveProfile {
  $recent = Get-UiTelemetryRecentEvents -Count 30
  $cursorMisses = @($recent | Where-Object { [string]$_.error_kind -eq "cursor_miss" }).Count
  $ocrMisses = @($recent | Where-Object { [string]$_.error_kind -eq "ocr_no_match" }).Count
  $cursorBoost = if ($cursorMisses -ge 2) { Clamp-Int -Value (120 + (($cursorMisses - 2) * 40)) -Minimum 120 -Maximum 320 } else { 0 }
  $ocrTtl = if ($ocrMisses -ge 2) { 2400 } else { 1200 }
  $ocrPromoteAllScreens = ($ocrMisses -ge 3)
  return [ordered]@{
    updated_at_utc = [DateTime]::UtcNow.ToString("o")
    sample_size = @($recent).Count
    cursor_recovery = [ordered]@{
      enabled = ($cursorBoost -gt 0)
      move_duration_boost_ms = [int]$cursorBoost
      min_move_steps = if ($cursorBoost -gt 0) { 24 } else { 0 }
      drag_duration_boost_ms = if ($cursorBoost -gt 0) { [int][Math]::Round($cursorBoost * 1.2) } else { 0 }
      min_drag_steps = if ($cursorBoost -gt 0) { 28 } else { 0 }
    }
    ocr_recovery = [ordered]@{
      enabled = ($ocrMisses -ge 2)
      min_cache_ttl_ms = [int]$ocrTtl
      promote_allscreens = [bool]$ocrPromoteAllScreens
    }
  }
}

function Add-UiTelemetryEvent {
  param(
    [string]$ActionName,
    [bool]$Ok,
    [string]$ErrorMessage,
    [int]$DurationMs
  )
  $safeAction = if ([string]::IsNullOrWhiteSpace($ActionName)) { "unknown" } else { [string]$ActionName.Trim().ToLowerInvariant() }
  $safeDuration = if ($DurationMs -ge 0) { [int]$DurationMs } else { 0 }
  $errorKind = if ($Ok) { "" } else { Classify-UiError -ErrorMessage $ErrorMessage }
  $event = [ordered]@{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    action = $safeAction
    ok = [bool]$Ok
    duration_ms = $safeDuration
    error_kind = $errorKind
  }
  if (-not $Ok) {
    $event.error = [string]$ErrorMessage
  }
  [void]$script:UiTelemetry.events.Add($event)
  while ($script:UiTelemetry.events.Count -gt $script:UiTelemetryMaxEvents) {
    $script:UiTelemetry.events.RemoveAt(0)
  }

  $script:UiTelemetry.total = [int]$script:UiTelemetry.total + 1
  if ($Ok) {
    $script:UiTelemetry.success = [int]$script:UiTelemetry.success + 1
  } else {
    $script:UiTelemetry.failed = [int]$script:UiTelemetry.failed + 1
  }

  if (-not $script:UiTelemetry.actions.ContainsKey($safeAction)) {
    $script:UiTelemetry.actions[$safeAction] = [ordered]@{
      total = 0
      success = 0
      failed = 0
      avg_ms = 0
      last_error = ""
      last_error_kind = ""
    }
  }
  $row = $script:UiTelemetry.actions[$safeAction]
  $row.total = [int]$row.total + 1
  if ($Ok) {
    $row.success = [int]$row.success + 1
  } else {
    $row.failed = [int]$row.failed + 1
    $row.last_error = [string]$ErrorMessage
    $row.last_error_kind = [string]$errorKind
  }
  $row.avg_ms = [int][Math]::Round((([double]$row.avg_ms * [Math]::Max(0, [int]$row.total - 1)) + [double]$safeDuration) / [double]$row.total)
  $script:UiTelemetry.actions[$safeAction] = $row

  if (-not $Ok) {
    if (-not $script:UiTelemetry.failures.ContainsKey($errorKind)) {
      $script:UiTelemetry.failures[$errorKind] = 0
    }
    $script:UiTelemetry.failures[$errorKind] = [int]$script:UiTelemetry.failures[$errorKind] + 1
  }
}

function Reset-UiTelemetry {
  $script:UiTelemetry = [ordered]@{
    started_at_utc = [DateTime]::UtcNow
    total = 0
    success = 0
    failed = 0
    actions = @{}
    failures = @{}
    events = New-Object System.Collections.ArrayList
  }
}

function Get-UiTelemetrySnapshot {
  param([int]$RecentCount = 20)
  $safeRecent = Clamp-Int -Value $RecentCount -Minimum 1 -Maximum 100
  $uptime = [int][Math]::Max(0, ([DateTime]::UtcNow - [DateTime]$script:UiTelemetry.started_at_utc).TotalSeconds)
  $actions = [ordered]@{}
  foreach ($key in @($script:UiTelemetry.actions.Keys | Sort-Object)) {
    $actions[$key] = $script:UiTelemetry.actions[$key]
  }
  $failures = [ordered]@{}
  foreach ($key in @($script:UiTelemetry.failures.Keys | Sort-Object)) {
    $failures[$key] = [int]$script:UiTelemetry.failures[$key]
  }
  return [ordered]@{
    started_at_utc = ([DateTime]$script:UiTelemetry.started_at_utc).ToString("o")
    uptime_seconds = $uptime
    totals = [ordered]@{
      total = [int]$script:UiTelemetry.total
      success = [int]$script:UiTelemetry.success
      failed = [int]$script:UiTelemetry.failed
      success_rate = if ([int]$script:UiTelemetry.total -gt 0) { [Math]::Round(([double]$script:UiTelemetry.success / [double]$script:UiTelemetry.total), 4) } else { 1.0 }
    }
    failures = $failures
    actions = $actions
    adaptive = Get-UiAdaptiveProfile
    recent = @((Get-UiTelemetryRecentEvents -Count $safeRecent))
  }
}

function Get-UiTelemetryBrief {
  $snapshot = Get-UiTelemetrySnapshot -RecentCount 5
  return [ordered]@{
    started_at_utc = $snapshot.started_at_utc
    uptime_seconds = $snapshot.uptime_seconds
    totals = $snapshot.totals
    failures = $snapshot.failures
    adaptive = $snapshot.adaptive
  }
}

function Write-Result {
  param(
    [bool]$Ok,
    [string]$ErrorMessage = "",
    [object]$Payload = $null,
    [int]$ExitCode = 0
  )

  $obj = [ordered]@{
    ok = $Ok
    action = $Action
  }
  if (-not $Ok) {
    $obj.error = [string]$ErrorMessage
  }
  if ($null -ne $Payload) {
    $obj.result = $Payload
  }
  $elapsedMs = 0
  if ($null -ne $script:UiActionStartedAt) {
    $elapsedMs = [int][Math]::Max(0, ([DateTime]::UtcNow - [DateTime]$script:UiActionStartedAt).TotalMilliseconds)
  }
  Add-UiTelemetryEvent -ActionName $Action -Ok:$Ok -ErrorMessage $ErrorMessage -DurationMs $elapsedMs

  if ($script:UiReturnMode) {
    $script:UiLastResult = $obj
    throw [System.Exception]::new($script:UiResultSignal)
  }

  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::WriteLine($json)
  exit $ExitCode
}

function Require-Point {
  if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) {
    throw "x and y are required for this action."
  }
}

function Require-EndPoint {
  if ($EndX -eq [int]::MinValue -or $EndY -eq [int]::MinValue) {
    throw "endx and endy are required for this action."
  }
}

function Verify-CursorPosition {
  param(
    [int]$ExpectedX,
    [int]$ExpectedY,
    [int]$Tolerance = 4,
    [string]$Message = "Cursor verification failed."
  )
  $point = Get-CursorPoint
  $dx = [Math]::Abs([int]$point.x - $ExpectedX)
  $dy = [Math]::Abs([int]$point.y - $ExpectedY)
  $ok = ($dx -le $Tolerance -and $dy -le $Tolerance)
  if (-not $ok) {
    Write-Result -Ok $false -ErrorMessage $Message -Payload @{
      expected = @{ x = $ExpectedX; y = $ExpectedY }
      actual = $point
      tolerance = $Tolerance
      delta = @{ x = $dx; y = $dy }
    } -ExitCode 1
  }
  return @{
    ok = $ok
    tolerance = $Tolerance
    expected = @{ x = $ExpectedX; y = $ExpectedY }
    actual = $point
    delta = @{ x = $dx; y = $dy }
  }
}

function Test-MutationAction {
  param([string]$ActionName)
  return @("click", "double_click", "right_click", "move", "mouse_down", "mouse_up", "drag", "click_text", "clipboard_paste", "type", "key", "scroll") -contains $ActionName
}

function Invoke-SafetyGate {
  param(
    [string]$ActionName,
    [string]$KeysPayload,
    [switch]$UnsafeOverride
  )
  $mode = [string]$env:AIDOLON_UI_SAFETY_MODE
  if ($null -eq $mode) { $mode = "" }
  $mode = $mode.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($mode)) { return $null }
  if ($mode -eq "off") { return $null }
  if ($UnsafeOverride.IsPresent) {
    return @{ mode = $mode; bypass = "allow_unsafe" }
  }

  $isMutation = Test-MutationAction -ActionName $ActionName
  $mutationsAllowed = @("1", "true", "yes", "on") -contains [string]$env:AIDOLON_UI_ALLOW_MUTATIONS
  if ($mode -eq "strict" -and $isMutation -and -not $mutationsAllowed) {
    Write-Result -Ok $false -ErrorMessage "Safety gate blocked a mutating UI action. Set AIDOLON_UI_ALLOW_MUTATIONS=1 or use -AllowUnsafe for this call." -Payload @{
      action = $ActionName
      mode = $mode
    } -ExitCode 1
  }

  if ($ActionName -eq "key") {
    $normalized = [string]$KeysPayload
    $danger = @("Alt+F4", "Ctrl+W", "Ctrl+Shift+W", "Delete", "Shift+Delete", "Ctrl+X")
    foreach ($hotkey in $danger) {
      if ($normalized -match [regex]::Escape($hotkey)) {
        if ($mode -eq "strict") {
          Write-Result -Ok $false -ErrorMessage "Safety gate blocked potentially destructive key combination." -Payload @{
            action = $ActionName
            keys = $KeysPayload
            blocked = $hotkey
            mode = $mode
          } -ExitCode 1
        }
        return @{ mode = $mode; warning = "dangerous_hotkey"; blocked = $hotkey }
      }
    }
  }

  return @{ mode = $mode; pass = $true }
}

function Ensure-UiTypes {
  if (-not ("Aidolon.UiNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace Aidolon {
  public struct POINT {
    public int X;
    public int Y;
  }

  public static class UiNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  }
}
"@
  }
}

function Ensure-SendKeysTypes {
  if (-not ("System.Windows.Forms.SendKeys" -as [type])) {
    Add-Type -AssemblyName System.Windows.Forms
  }
  if (-not ("Microsoft.VisualBasic.Interaction" -as [type])) {
    Add-Type -AssemblyName Microsoft.VisualBasic
  }
}

function Ensure-DrawingTypes {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
}

function Ensure-OcrTypes {
  if (-not ("System.WindowsRuntimeSystemExtensions" -as [type])) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
  }
  [void][Windows.Foundation.IAsyncAction, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
}

function Await-WinRtTyped {
  param(
    [object]$Operation,
    [Type]$ResultType
  )
  if ($null -eq $Operation) {
    return $null
  }
  if ($null -eq $ResultType) {
    throw "ResultType is required for Await-WinRtTyped."
  }
  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.IsGenericMethodDefinition -and
    $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*"
  } | Select-Object -First 1
  if ($null -eq $asTaskMethod) {
    throw "Could not resolve WinRT AsTask method."
  }
  $typedMethod = $asTaskMethod.MakeGenericMethod(@($ResultType))
  $task = $typedMethod.Invoke($null, @($Operation))
  [void]$task.Wait()
  return $task.Result
}

function Get-WindowCandidates {
  Get-Process |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
    } |
    Sort-Object -Property StartTime -Descending
}

function Get-WindowSummary {
  param([System.Diagnostics.Process]$Process)
  [ordered]@{
    pid = $Process.Id
    process = $Process.ProcessName
    title = $Process.MainWindowTitle
    handle = ("0x{0:X}" -f [int64]$Process.MainWindowHandle)
  }
}

function Find-Window {
  param(
    [string]$TitlePattern,
    [string]$RegexPattern
  )

  $candidates = @(Get-WindowCandidates)
  if ($candidates.Count -eq 0) {
    return $null
  }

  if (-not [string]::IsNullOrWhiteSpace($RegexPattern)) {
    try {
      $rx = [regex]$RegexPattern
    } catch {
      throw "Invalid regex pattern."
    }
    $matches = @($candidates | Where-Object { $rx.IsMatch($_.MainWindowTitle) })
    if ($matches.Count -gt 0) {
      return $matches[0]
    }
    return $null
  }

  $needle = ([string]$TitlePattern).Trim()
  if ([string]::IsNullOrWhiteSpace($needle)) {
    return $candidates[0]
  }

  $exact = @($candidates | Where-Object { $_.MainWindowTitle -ieq $needle })
  if ($exact.Count -gt 0) {
    return $exact[0]
  }

  $contains = @($candidates | Where-Object { $_.MainWindowTitle -like "*$needle*" })
  if ($contains.Count -gt 0) {
    return $contains[0]
  }

  return $null
}

function Find-WindowMatches {
  param(
    [string]$TitlePattern,
    [string]$RegexPattern
  )
  $candidates = @(Get-WindowCandidates)
  if ($candidates.Count -eq 0) { return @() }

  if (-not [string]::IsNullOrWhiteSpace($RegexPattern)) {
    $rx = [regex]$RegexPattern
    return @($candidates | Where-Object { $rx.IsMatch($_.MainWindowTitle) })
  }

  $needle = ([string]$TitlePattern).Trim()
  if ([string]::IsNullOrWhiteSpace($needle)) {
    return @($candidates)
  }

  $exact = @($candidates | Where-Object { $_.MainWindowTitle -ieq $needle })
  if ($exact.Count -gt 0) { return $exact }

  return @($candidates | Where-Object { $_.MainWindowTitle -like "*$needle*" })
}

function Get-CursorPoint {
  Ensure-UiTypes
  $p = New-Object Aidolon.POINT
  [void][Aidolon.UiNative]::GetCursorPos([ref]$p)
  return [ordered]@{ x = $p.X; y = $p.Y }
}

function Get-ForegroundHandleHex {
  Ensure-UiTypes
  $h = [Aidolon.UiNative]::GetForegroundWindow()
  return ("0x{0:X}" -f [int64]$h)
}

function Move-Cursor {
  param(
    [int]$Px,
    [int]$Py,
    [bool]$Smooth = $true,
    [int]$DurationOverride = -1,
    [int]$StepsOverride = -1
  )
  Ensure-UiTypes

  $start = Get-CursorPoint
  $startX = [int]$start.x
  $startY = [int]$start.y
  $dx = [double]($Px - $startX)
  $dy = [double]($Py - $startY)
  $distance = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))

  if ($distance -lt 2.0) {
    if ($Px -ne $startX -or $Py -ne $startY) {
      [void][Aidolon.UiNative]::SetCursorPos($Px, $Py)
    }
    return [ordered]@{
      smooth = $true
      steps = 1
      duration_ms = $(if ($Px -ne $startX -or $Py -ne $startY) { 20 } else { 0 })
    }
  }

  $durationSource = if ($DurationOverride -gt 0) { $DurationOverride } else { $MoveDuration }
  $stepsSource = if ($StepsOverride -gt 0) { $StepsOverride } elseif ($MoveSteps -gt 0) { $MoveSteps } else { 0 }

  $duration = Clamp-Int -Value $durationSource -Minimum 20 -Maximum 5000
  $steps = if ($stepsSource -gt 0) {
    Clamp-Int -Value $stepsSource -Minimum 2 -Maximum 240
  } else {
    $autoSteps = [int][Math]::Ceiling($distance / 18.0)
    Clamp-Int -Value $autoSteps -Minimum 6 -Maximum 90
  }

  $sleepMs = [int][Math]::Floor([double]$duration / [double]$steps)
  if ($sleepMs -lt 1) { $sleepMs = 1 }

  for ($i = 1; $i -le $steps; $i++) {
    $t = [double]$i / [double]$steps
    $ease = 1.0 - [Math]::Pow((1.0 - $t), 3.0)
    $nextX = [int][Math]::Round($startX + ($dx * $ease))
    $nextY = [int][Math]::Round($startY + ($dy * $ease))
    [void][Aidolon.UiNative]::SetCursorPos($nextX, $nextY)
    if ($i -lt $steps) {
      Start-Sleep -Milliseconds $sleepMs
    }
  }

  return [ordered]@{
    smooth = $true
    steps = $steps
    duration_ms = $duration
  }
}

function Invoke-MouseButton {
  param(
    [ValidateSet("left", "right", "middle")]
    [string]$Button = "left",
    [ValidateSet("down", "up")]
    [string]$State = "down"
  )

  Ensure-UiTypes
  $flag = if ($Button -eq "right") {
    if ($State -eq "down") { 0x0008 } else { 0x0010 }
  } elseif ($Button -eq "middle") {
    if ($State -eq "down") { 0x0020 } else { 0x0040 }
  } else {
    if ($State -eq "down") { 0x0002 } else { 0x0004 }
  }
  [Aidolon.UiNative]::mouse_event([uint32]$flag, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-MouseClick {
  param(
    [int]$Px,
    [int]$Py,
    [ValidateSet("left", "right")]
    [string]$Button = "left",
    [int]$Count = 1,
    [bool]$Smooth = $true
  )

  Ensure-UiTypes
  $motion = Move-Cursor -Px $Px -Py $Py -Smooth $Smooth
  Start-Sleep -Milliseconds 40

  for ($i = 0; $i -lt [Math]::Max(1, $Count); $i++) {
    Invoke-MouseButton -Button $Button -State "down"
    Start-Sleep -Milliseconds 25
    Invoke-MouseButton -Button $Button -State "up"
    if ($Count -gt 1) {
      Start-Sleep -Milliseconds 75
    }
  }
  return $motion
}

function Show-HighlightFrame {
  param(
    [int]$CenterX,
    [int]$CenterY,
    [int]$Width = 100,
    [int]$Height = 36,
    [int]$DurationMs = 320
  )
  Ensure-DrawingTypes

  $safeWidth = Clamp-Int -Value $Width -Minimum 8 -Maximum 4000
  $safeHeight = Clamp-Int -Value $Height -Minimum 8 -Maximum 4000
  $safeDuration = Clamp-Int -Value $DurationMs -Minimum 40 -Maximum 5000

  $left = [int][Math]::Round($CenterX - ($safeWidth / 2.0))
  $top = [int][Math]::Round($CenterY - ($safeHeight / 2.0))
  $rect = New-Object System.Drawing.Rectangle $left, $top, $safeWidth, $safeHeight

  [System.Windows.Forms.ControlPaint]::DrawReversibleFrame($rect, [System.Drawing.Color]::Aqua, [System.Windows.Forms.FrameStyle]::Thick)
  try {
    Start-Sleep -Milliseconds $safeDuration
  } finally {
    [System.Windows.Forms.ControlPaint]::DrawReversibleFrame($rect, [System.Drawing.Color]::Aqua, [System.Windows.Forms.FrameStyle]::Thick)
  }

  return [ordered]@{
    left = $left
    top = $top
    width = $safeWidth
    height = $safeHeight
    duration_ms = $safeDuration
  }
}

function Unquote-OuterString {
  param([string]$Value)
  $s = ([string]$Value).Trim()
  if ($s.Length -lt 2) { return $s }

  $first = $s.Substring(0, 1)
  $last = $s.Substring($s.Length - 1, 1)
  if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
    return $s.Substring(1, $s.Length - 2).Trim()
  }
  return $s
}

function Convert-ToSendKeysLiteral {
  param([string]$InputText)
  if ($null -eq $InputText) { return "" }
  $value = [string]$InputText
  $value = $value.Replace("{", "{{}")
  $value = $value.Replace("}", "{}}")
  $value = $value.Replace("+", "{+}")
  $value = $value.Replace("^", "{^}")
  $value = $value.Replace("%", "{%}")
  $value = $value.Replace("~", "{~}")
  $value = $value.Replace("(", "{(}")
  $value = $value.Replace(")", "{)}")
  $value = $value.Replace("[", "{[}")
  $value = $value.Replace("]", "{]}")
  return $value
}

function Convert-HotkeyToSendKeys {
  param([string]$InputKeys)
  $raw = Unquote-OuterString -Value $InputKeys
  if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
  if ($raw -eq "+") { return "{+}" }
  if ($raw -eq "^") { return "{^}" }
  if ($raw -eq "%") { return "{%}" }
  if ($raw.Contains("{") -or $raw.Contains("}")) { return $raw }
  $tokens = @($raw -split "\+" | ForEach-Object { Unquote-OuterString -Value $_ } | Where-Object { $_ -ne "" })
  if ($tokens.Count -eq 0) { return "" }

  $mods = ""
  $keyToken = $tokens[$tokens.Count - 1]
  for ($i = 0; $i -lt [Math]::Max(0, ($tokens.Count - 1)); $i++) {
    $mod = $tokens[$i].ToLowerInvariant()
    if ($mod -eq "ctrl" -or $mod -eq "control") { $mods += "^" }
    elseif ($mod -eq "alt") { $mods += "%" }
    elseif ($mod -eq "shift") { $mods += "+" }
  }

  $named = @{
    enter = "{ENTER}"
    return = "{ENTER}"
    newline = "{ENTER}"
    linefeed = "{ENTER}"
    lf = "{ENTER}"
    cr = "{ENTER}"
    carriage_return = "{ENTER}"
    carriagereturn = "{ENTER}"
    esc = "{ESC}"
    escape = "{ESC}"
    tab = "{TAB}"
    space = " "
    spacebar = " "
    up = "{UP}"
    down = "{DOWN}"
    left = "{LEFT}"
    right = "{RIGHT}"
    pageup = "{PGUP}"
    pagedown = "{PGDN}"
    pgup = "{PGUP}"
    pgdn = "{PGDN}"
    home = "{HOME}"
    end = "{END}"
    backspace = "{BACKSPACE}"
    del = "{DELETE}"
    delete = "{DELETE}"
    insert = "{INSERT}"
    ins = "{INSERT}"
  }

  $lower = $keyToken.ToLowerInvariant()
  if ($named.ContainsKey($lower)) {
    return "$mods$($named[$lower])"
  }

  if ($lower -match "^f([1-9]|1[0-2])$") {
    return "$mods{$($lower.ToUpperInvariant())}"
  }

  if ($keyToken.Length -eq 1) {
    $single = $keyToken
    # In SendKeys, uppercase letters can imply Shift. Normalize modified single-letter
    # shortcuts to lowercase so "Ctrl+A" is not interpreted as "Ctrl+Shift+A".
    if (-not [string]::IsNullOrWhiteSpace($mods) -and $single -cmatch "[A-Z]") {
      $single = $single.ToLowerInvariant()
    }
    return "$mods$single"
  }

  if (-not [string]::IsNullOrWhiteSpace($mods)) {
    return "$mods$([string](Convert-ToSendKeysLiteral -InputText $keyToken))"
  }

  return "$mods$keyToken"
}

function Send-KeysPayload {
  param(
    [string]$Payload,
    [int]$PostDelayMs = 30
  )
  Ensure-SendKeysTypes
  if ([string]::IsNullOrEmpty($Payload)) { return "" }
  [System.Windows.Forms.SendKeys]::SendWait($Payload)
  $delayMs = Clamp-Int -Value $PostDelayMs -Minimum 0 -Maximum 5000
  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds $delayMs
  }
  return $Payload
}

function Send-Keys {
  param(
    [string]$Value,
    [bool]$Literal
  )
  $payload = if ($Literal) { Convert-ToSendKeysLiteral -InputText $Value } else { Convert-HotkeyToSendKeys -InputKeys $Value }
  return Send-KeysPayload -Payload $payload -PostDelayMs 30
}

function Send-TextTypewriter {
  param(
    [string]$Value,
    [int]$MinDelayMs = 35,
    [int]$MaxDelayMs = 110
  )

  $safeMin = Clamp-Int -Value $MinDelayMs -Minimum 0 -Maximum 5000
  $safeMax = Clamp-Int -Value $MaxDelayMs -Minimum 0 -Maximum 5000
  if ($safeMax -lt $safeMin) {
    $tmp = $safeMax
    $safeMax = $safeMin
    $safeMin = $tmp
  }

  $input = if ($null -eq $Value) { "" } else { [string]$Value }
  $sentParts = New-Object System.Collections.Generic.List[string]
  $typedChars = 0

  foreach ($ch in $input.ToCharArray()) {
    $piece = [string]$ch
    if ($piece -eq "`r") { continue }

    $payload = if ($piece -eq "`n") {
      "{ENTER}"
    } elseif ($piece -eq "`t") {
      "{TAB}"
    } else {
      Convert-ToSendKeysLiteral -InputText $piece
    }

    if ([string]::IsNullOrEmpty($payload)) { continue }
    [void](Send-KeysPayload -Payload $payload -PostDelayMs 0)
    [void]$sentParts.Add($payload)
    $typedChars++

    $delay = if ($safeMin -eq $safeMax) {
      $safeMin
    } else {
      Get-Random -Minimum $safeMin -Maximum ($safeMax + 1)
    }
    if ($delay -gt 0) {
      Start-Sleep -Milliseconds $delay
    }
  }

  return [ordered]@{
    sent = ($sentParts -join "")
    typed_chars = $typedChars
    min_delay_ms = $safeMin
    max_delay_ms = $safeMax
  }
}

function Get-ClipboardTextValue {
  Ensure-SendKeysTypes
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    return [System.Windows.Forms.Clipboard]::GetText()
  }
  return ""
}

function Set-ClipboardTextValue {
  param([string]$Value)
  Ensure-SendKeysTypes
  $text = if ($null -eq $Value) { "" } else { [string]$Value }
  [System.Windows.Forms.Clipboard]::SetText($text)
  return $text
}

function Invoke-MouseWheel {
  param([int]$WheelDelta)
  Ensure-UiTypes
  if ($WheelDelta -eq 0) { return 0 }

  $remaining = [int]$WheelDelta
  $events = 0
  while ($remaining -ne 0) {
    $step = if ([Math]::Abs($remaining) -ge 120) {
      [int](120 * [Math]::Sign($remaining))
    } else {
      [int]$remaining
    }
    $wheelData = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int32]$step), 0)
    [Aidolon.UiNative]::mouse_event([uint32]0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
    $remaining -= $step
    $events++
    if ($remaining -ne 0) {
      Start-Sleep -Milliseconds 12
    }
  }
  return $events
}

function Ensure-ParentDirectory {
  param([string]$FilePath)
  $parent = Split-Path -Path $FilePath -Parent
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Resolve-OutputPath {
  param(
    [string]$CandidatePath,
    [string]$DefaultFileName
  )
  if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    $base = Join-Path (Get-Location) "runtime/out"
    if (-not (Test-Path -LiteralPath $base)) {
      New-Item -ItemType Directory -Path $base -Force | Out-Null
    }
    return Join-Path $base $DefaultFileName
  }
  if ([System.IO.Path]::IsPathRooted($CandidatePath)) {
    return [System.IO.Path]::GetFullPath($CandidatePath)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $CandidatePath))
}

function New-GlobalRegionRect {
  param(
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )
  if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { return $null }
  if ($Width -le 0 -or $Height -le 0) {
    throw "RegionWidth and RegionHeight must be greater than zero when RegionX/RegionY are provided."
  }
  return [System.Drawing.Rectangle]::new($X, $Y, $Width, $Height)
}

function Intersect-Rectangles {
  param(
    [System.Drawing.Rectangle]$A,
    [System.Drawing.Rectangle]$B
  )
  $left = [Math]::Max($A.Left, $B.Left)
  $top = [Math]::Max($A.Top, $B.Top)
  $right = [Math]::Min($A.Right, $B.Right)
  $bottom = [Math]::Min($A.Bottom, $B.Bottom)
  if ($right -le $left -or $bottom -le $top) { return $null }
  return [System.Drawing.Rectangle]::new($left, $top, $right - $left, $bottom - $top)
}

function Capture-Screen {
  param(
    [System.Windows.Forms.Screen]$Screen,
    [string]$FilePath
  )
  $bounds = $Screen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    Ensure-ParentDirectory -FilePath $FilePath
    $bitmap.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [ordered]@{
    path = $FilePath
    output = $FilePath
    width = $bounds.Width
    height = $bounds.Height
    left = $bounds.Left
    top = $bounds.Top
    primary = $Screen.Primary
  }
}

function Capture-ScreenBitmap {
  param([System.Windows.Forms.Screen]$Screen)
  Ensure-DrawingTypes
  $bounds = $Screen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Capture-ScreenBitmapArea {
  param(
    [System.Windows.Forms.Screen]$Screen,
    [System.Drawing.Rectangle]$CaptureRect
  )
  Ensure-DrawingTypes
  $bitmap = New-Object System.Drawing.Bitmap $CaptureRect.Width, $CaptureRect.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $src = [System.Drawing.Point]::new($CaptureRect.Left, $CaptureRect.Top)
    $graphics.CopyFromScreen($src, [System.Drawing.Point]::Empty, $CaptureRect.Size)
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Get-TargetScreens {
  param([bool]$UseAll = $false)
  Ensure-DrawingTypes
  $source = if ($UseAll) { [System.Windows.Forms.Screen]::AllScreens } else { [System.Windows.Forms.Screen]::PrimaryScreen }
  return @($source | Where-Object { $null -ne $_ })
}

function Get-OcrScreenCapture {
  param(
    [System.Windows.Forms.Screen]$Screen,
    [System.Drawing.Rectangle]$GlobalRegion = $null
  )
  $bounds = $Screen.Bounds
  $screenRect = [System.Drawing.Rectangle]::new($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)
  $captureRect = if ($null -eq $GlobalRegion) { $screenRect } else { Intersect-Rectangles -A $screenRect -B $GlobalRegion }
  if ($null -eq $captureRect) { return $null }
  $bitmap = Capture-ScreenBitmapArea -Screen $Screen -CaptureRect $captureRect
  return [ordered]@{
    bitmap = $bitmap
    capture_left = [int]$captureRect.Left
    capture_top = [int]$captureRect.Top
    capture_width = [int]$captureRect.Width
    capture_height = [int]$captureRect.Height
    screen_left = [int]$bounds.Left
    screen_top = [int]$bounds.Top
    screen_width = [int]$bounds.Width
    screen_height = [int]$bounds.Height
  }
}

function Get-BitmapSignature {
  param([System.Drawing.Bitmap]$Bitmap)
  $w = [Math]::Max(1, [int]$Bitmap.Width)
  $h = [Math]::Max(1, [int]$Bitmap.Height)
  $sx = [Math]::Min(8, $w)
  $sy = [Math]::Min(8, $h)
  $parts = @("$w", "$h")
  for ($yy = 0; $yy -lt $sy; $yy++) {
    $py = [int][Math]::Min($h - 1, [Math]::Round(($yy * ($h - 1)) / [Math]::Max(1, $sy - 1)))
    for ($xx = 0; $xx -lt $sx; $xx++) {
      $px = [int][Math]::Min($w - 1, [Math]::Round(($xx * ($w - 1)) / [Math]::Max(1, $sx - 1)))
      $parts += $Bitmap.GetPixel($px, $py).ToArgb().ToString("X8")
    }
  }
  return ($parts -join "-")
}

function Get-OcrFromCacheOrScan {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$CacheKeyPrefix,
    [int]$CacheTtlMs = 1200
  )
  $ttl = if ($CacheTtlMs -gt 0) { $CacheTtlMs } else { 0 }
  $now = [DateTime]::UtcNow
  $signature = Get-BitmapSignature -Bitmap $Bitmap
  $cacheKey = "{0}|{1}" -f $CacheKeyPrefix, $signature
  if ($ttl -gt 0 -and $script:UiOcrCache.ContainsKey($cacheKey)) {
    $entry = $script:UiOcrCache[$cacheKey]
    if ($null -ne $entry -and $now -le [DateTime]$entry.expires_at) {
      return [ordered]@{ ocr = $entry.ocr; cache = [ordered]@{ hit = $true; key = $cacheKey; ttl_ms = $ttl } }
    }
    $script:UiOcrCache.Remove($cacheKey) | Out-Null
  }
  $ocr = Invoke-OcrOnBitmap -Bitmap $Bitmap
  if ($ttl -gt 0) {
    $script:UiOcrCache[$cacheKey] = [ordered]@{
      ocr = $ocr
      expires_at = $now.AddMilliseconds($ttl)
    }
  }
  return [ordered]@{ ocr = $ocr; cache = [ordered]@{ hit = $false; key = $cacheKey; ttl_ms = $ttl } }
}

function Invoke-OcrOnBitmap {
  param([System.Drawing.Bitmap]$Bitmap)
  Ensure-OcrTypes

  $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) ("aidolon-ocr-{0}.png" -f ([guid]::NewGuid().ToString("N")))
  try {
    $Bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $file = Await-WinRtTyped -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) -ResultType ([Windows.Storage.StorageFile])
    $stream = Await-WinRtTyped -Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) -ResultType ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await-WinRtTyped -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await-WinRtTyped -Operation ($decoder.GetSoftwareBitmapAsync()) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $engine) {
        $fallbackLanguage = New-Object Windows.Globalization.Language -ArgumentList "en-US"
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($fallbackLanguage)
      }
      if ($null -eq $engine) {
        throw "Windows OCR engine is unavailable."
      }

      $ocrResult = Await-WinRtTyped -Operation ($engine.RecognizeAsync($softwareBitmap)) -ResultType ([Windows.Media.Ocr.OcrResult])
      $rows = @()
      foreach ($line in @($ocrResult.Lines)) {
        $words = @($line.Words)
        $left = 0.0
        $top = 0.0
        $width = 0.0
        $height = 0.0
        if ($words.Count -gt 0) {
          $minX = [double]::PositiveInfinity
          $minY = [double]::PositiveInfinity
          $maxX = [double]::NegativeInfinity
          $maxY = [double]::NegativeInfinity
          foreach ($word in $words) {
            $r = $word.BoundingRect
            $x = [double]$r.X
            $y = [double]$r.Y
            $rx = $x + [double]$r.Width
            $ry = $y + [double]$r.Height
            if ($x -lt $minX) { $minX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($rx -gt $maxX) { $maxX = $rx }
            if ($ry -gt $maxY) { $maxY = $ry }
          }
          if (-not [double]::IsInfinity($minX) -and -not [double]::IsInfinity($minY) -and -not [double]::IsInfinity($maxX) -and -not [double]::IsInfinity($maxY)) {
            $left = $minX
            $top = $minY
            $width = [Math]::Max(0.0, $maxX - $minX)
            $height = [Math]::Max(0.0, $maxY - $minY)
          }
        }
        $rows += [ordered]@{
          text = [string]$line.Text
          x = [double]$left
          y = [double]$top
          width = [double]$width
          height = [double]$height
          words = $words.Count
        }
      }

      return [ordered]@{
        language = [string]$engine.RecognizerLanguage.LanguageTag
        text = [string]$ocrResult.Text
        lines = $rows
      }
    } finally {
      if ($null -ne $stream) {
        $stream.Dispose()
      }
    }
  } finally {
    Remove-Item -LiteralPath $tempPath -ErrorAction SilentlyContinue
  }
}

function Find-OcrTextMatch {
  param(
    [System.Windows.Forms.Screen[]]$Screens,
    [string]$Query,
    [bool]$UseRegex = $false,
    [bool]$Exact = $false,
    [int]$Index = 1,
    [System.Drawing.Rectangle]$GlobalRegion = $null,
    [int]$CacheTtlMs = 1200
  )

  $needle = ([string]$Query).Trim()
  if ([string]::IsNullOrWhiteSpace($needle)) {
    throw "text is required for click_text."
  }

  $rx = $null
  if ($UseRegex) {
    try {
      $rx = [regex]::new($needle, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    } catch {
      Write-Result -Ok $false -ErrorMessage "Invalid text regex pattern." -Payload @{ text = $needle } -ExitCode 1
    }
  }

  $matches = @()
  $scannedLines = 0
  $cacheHits = 0
  $cacheMisses = 0
  $scannedScreens = 0

  foreach ($screen in @($Screens)) {
    $capture = Get-OcrScreenCapture -Screen $screen -GlobalRegion $GlobalRegion
    if ($null -eq $capture) {
      continue
    }
    $scannedScreens++
    $bmp = $capture.bitmap
    try {
      $cachePrefix = "screen={0},{1},{2},{3}|capture={4},{5},{6},{7}" -f `
        $capture.screen_left, $capture.screen_top, $capture.screen_width, $capture.screen_height, `
        $capture.capture_left, $capture.capture_top, $capture.capture_width, $capture.capture_height
      $cached = Get-OcrFromCacheOrScan -Bitmap $bmp -CacheKeyPrefix $cachePrefix -CacheTtlMs $CacheTtlMs
      if ([bool]$cached.cache.hit) { $cacheHits++ } else { $cacheMisses++ }
      $ocr = $cached.ocr
      foreach ($line in @($ocr.lines)) {
        $candidate = [string]$line.text
        if ([string]::IsNullOrWhiteSpace($candidate)) {
          continue
        }

        $trimmed = $candidate.Trim()
        $isMatch = $false
        if ($UseRegex) {
          $isMatch = $rx.IsMatch($trimmed)
        } elseif ($Exact) {
          $isMatch = [string]::Equals($trimmed, $needle, [System.StringComparison]::OrdinalIgnoreCase)
        } else {
          $isMatch = ($trimmed.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        }

        if ($isMatch) {
          $score = if ([string]::Equals($trimmed, $needle, [System.StringComparison]::OrdinalIgnoreCase)) {
            300
          } elseif ($trimmed.StartsWith($needle, [System.StringComparison]::OrdinalIgnoreCase)) {
            220
          } elseif ($trimmed.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            180
          } else {
            120
          }
          $score += [Math]::Max(0, 80 - [Math]::Abs($trimmed.Length - $needle.Length))

          $matches += [ordered]@{
            score = [int]$score
            language = [string]$ocr.language
            line_text = $trimmed
            line = $line
            capture_left = [int]$capture.capture_left
            capture_top = [int]$capture.capture_top
          }
        }
        $scannedLines++
      }
    } finally {
      $bmp.Dispose()
    }
  }

  if ($matches.Count -eq 0) {
    return [ordered]@{
      found = $false
      scanned_lines = $scannedLines
      scanned_screens = $scannedScreens
      matches = 0
      cache = [ordered]@{
        hits = $cacheHits
        misses = $cacheMisses
        ttl_ms = [int]$CacheTtlMs
      }
    }
  }

  $sorted = @(
    $matches |
      Sort-Object -Property `
        @{ Expression = { [int]$_.score }; Descending = $true }, `
        @{ Expression = { [double]$_.line.y }; Descending = $false }, `
        @{ Expression = { [double]$_.line.x }; Descending = $false }
  )

  $safeIndex = Clamp-Int -Value $Index -Minimum 1 -Maximum $sorted.Count
  $picked = $sorted[$safeIndex - 1]
  $rect = $picked.line
  $targetX = [int][Math]::Round([double]$picked.capture_left + [double]$rect.x + ([double]$rect.width / 2.0))
  $targetY = [int][Math]::Round([double]$picked.capture_top + [double]$rect.y + ([double]$rect.height / 2.0))

  return [ordered]@{
    found = $true
    scanned_lines = $scannedLines
    scanned_screens = $scannedScreens
    matches = $sorted.Count
    selected_index = $safeIndex
    language = [string]$picked.language
    text = [string]$picked.line_text
    rect = [ordered]@{
      x = [double]$rect.x
      y = [double]$rect.y
      width = [double]$rect.width
      height = [double]$rect.height
      capture_left = [int]$picked.capture_left
      capture_top = [int]$picked.capture_top
    }
    target = [ordered]@{
      x = $targetX
      y = $targetY
    }
    cache = [ordered]@{
      hits = $cacheHits
      misses = $cacheMisses
      ttl_ms = [int]$CacheTtlMs
    }
  }
}

function Invoke-UiActionRunner {
try {
  $script:UiActionStartedAt = [DateTime]::UtcNow
  $smoothMove = $true
  $safety = Invoke-SafetyGate -ActionName $Action -KeysPayload $Keys -UnsafeOverride:$AllowUnsafe

  switch ($Action) {
    "windows" {
      $max = if ($Limit -gt 0) { $Limit } else { 20 }
      $rows = @(Get-WindowCandidates | Select-Object -First $max | ForEach-Object { Get-WindowSummary -Process $_ })
      Write-Result -Ok $true -Payload @{ count = $rows.Count; windows = $rows; safety = $safety }
    }

    "focus" {
      $matches = @(Find-WindowMatches -TitlePattern $Title -RegexPattern $Regex)
      if ($matches.Count -eq 0) {
        Write-Result -Ok $false -ErrorMessage "No matching window found." -Payload @{ title = $Title; regex = $Regex } -ExitCode 1
      }
      if ($matches.Count -gt 1 -and -not $AllowAmbiguousFocus.IsPresent) {
        Write-Result -Ok $false -ErrorMessage "Focus target is ambiguous. Refine title/regex or pass -AllowAmbiguousFocus." -Payload @{
          title = $Title
          regex = $Regex
          matches = $matches.Count
          candidates = @($matches | Select-Object -First 6 | ForEach-Object { Get-WindowSummary -Process $_ })
        } -ExitCode 1
      }
      $target = $matches[0]
      Ensure-UiTypes
      Ensure-SendKeysTypes
      $restored = $false
      # Only restore if minimized. Restoring unconditionally can unsnap/maximized windows.
      if ([Aidolon.UiNative]::IsIconic($target.MainWindowHandle)) {
        [void][Aidolon.UiNative]::ShowWindowAsync($target.MainWindowHandle, 9)
        $restored = $true
      }
      $activated = $false
      try {
        $activated = [Microsoft.VisualBasic.Interaction]::AppActivate([int]$target.Id)
      } catch {
        $activated = $false
      }
      if (-not $activated) {
        try {
          $ws = New-Object -ComObject WScript.Shell
          $activated = [bool]$ws.AppActivate([int]$target.Id)
          if (-not $activated) {
            $activated = [bool]$ws.AppActivate($target.MainWindowTitle)
          }
        } catch {
          $activated = $false
        }
      }
      if (-not $activated) {
        $activated = [Aidolon.UiNative]::SetForegroundWindow($target.MainWindowHandle)
      }
      Start-Sleep -Milliseconds 80
      $targetHandleHex = ("0x{0:X}" -f [int64]$target.MainWindowHandle)
      $foregroundHandleHex = Get-ForegroundHandleHex
      if (-not $activated -and $foregroundHandleHex -eq $targetHandleHex) {
        $activated = $true
      }
      Write-Result -Ok ([bool]$activated) -ErrorMessage $(if ($activated) { "" } else { "Could not bring target window to foreground." }) -Payload @{
        activated = [bool]$activated
        restored = [bool]$restored
        foreground_handle = $foregroundHandleHex
        window = Get-WindowSummary -Process $target
        matches = $matches.Count
        safety = $safety
      } -ExitCode ($(if ($activated) { 0 } else { 1 }))
    }

    "move" {
      Require-Point
      $draggedLeft = $false
      if ($DragLeft.IsPresent) {
        Invoke-MouseButton -Button "left" -State "down"
        $draggedLeft = $true
        Start-Sleep -Milliseconds 15
      }
      try {
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
      } finally {
        if ($draggedLeft) {
          Start-Sleep -Milliseconds 15
          Invoke-MouseButton -Button "left" -State "up"
        }
      }
      Start-Sleep -Milliseconds 30
      $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not reach move target."
      Write-Result -Ok $true -Payload @{
        cursor = Get-CursorPoint
        dragged_left = [bool]$DragLeft.IsPresent
        motion = $motion
        verify = $verify
        safety = $safety
      }
    }

    "mouse_down" {
      Ensure-UiTypes
      $motion = $null
      $verify = $null
      if (($X -ne [int]::MinValue) -or ($Y -ne [int]::MinValue)) {
        Require-Point
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 15
        $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not reach mouse_down target."
      }
      Invoke-MouseButton -Button $Button -State "down"
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = $Button; state = "down"; motion = $motion; verify = $verify; safety = $safety }
    }

    "mouse_up" {
      Ensure-UiTypes
      $motion = $null
      $verify = $null
      if (($X -ne [int]::MinValue) -or ($Y -ne [int]::MinValue)) {
        Require-Point
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 15
        $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not reach mouse_up target."
      }
      Invoke-MouseButton -Button $Button -State "up"
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = $Button; state = "up"; motion = $motion; verify = $verify; safety = $safety }
    }

    "drag" {
      Require-Point
      Require-EndPoint
      Ensure-UiTypes

      $startMotion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
      Start-Sleep -Milliseconds 20
      Invoke-MouseButton -Button $Button -State "down"
      try {
        $dragSmooth = $true
        $dragMotion = Move-Cursor -Px $EndX -Py $EndY -Smooth $dragSmooth -DurationOverride $DragDuration -StepsOverride $DragSteps
      } finally {
        Start-Sleep -Milliseconds 15
        Invoke-MouseButton -Button $Button -State "up"
      }
      Start-Sleep -Milliseconds 30
      $verify = Verify-CursorPosition -ExpectedX $EndX -ExpectedY $EndY -Tolerance 5 -Message "Cursor did not reach drag end point."

      Write-Result -Ok $true -Payload @{
        button = $Button
        start = [ordered]@{ x = $X; y = $Y }
        end = [ordered]@{ x = $EndX; y = $EndY }
        cursor = Get-CursorPoint
        start_motion = $startMotion
        drag_motion = $dragMotion
        verify = $verify
        safety = $safety
      }
    }

    "highlight" {
      Require-Point
      $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; frame = $frame; safety = $safety }
    }

    "click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "left" -Count 1 -Smooth $smoothMove
      $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not remain at click target."
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "left"; count = 1; motion = $motion; highlight = $frame; verify = $verify; safety = $safety }
    }

    "double_click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "left" -Count 2 -Smooth $smoothMove
      $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not remain at double_click target."
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "left"; count = 2; motion = $motion; highlight = $frame; verify = $verify; safety = $safety }
    }

    "right_click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "right" -Count 1 -Smooth $smoothMove
      $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not remain at right_click target."
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "right"; count = 1; motion = $motion; highlight = $frame; verify = $verify; safety = $safety }
    }

    "click_text" {
      if ([string]::IsNullOrWhiteSpace($Text)) {
        Write-Result -Ok $false -ErrorMessage "text is required for click_text." -ExitCode 1
      }
      $ocrRegion = New-GlobalRegionRect -X $RegionX -Y $RegionY -Width $RegionWidth -Height $RegionHeight
      $screens = Get-TargetScreens -UseAll $AllScreens.IsPresent
      $screenCount = ($screens | Measure-Object).Count
      if ($screenCount -eq 0) {
        Write-Result -Ok $false -ErrorMessage "No screen is available for OCR text click." -ExitCode 1
      }

      $match = Find-OcrTextMatch `
        -Screens $screens `
        -Query $Text `
        -UseRegex $TextRegex.IsPresent `
        -Exact $ExactText.IsPresent `
        -Index $MatchIndex `
        -GlobalRegion $ocrRegion `
        -CacheTtlMs $OcrCacheTtlMs
      if (-not $match.found) {
        Write-Result -Ok $false -ErrorMessage "No visible text match found on screen." -Payload @{
          text = $Text
          regex = [bool]$TextRegex.IsPresent
          exact = [bool]$ExactText.IsPresent
          scanned_lines = $match.scanned_lines
          scanned_screens = $match.scanned_screens
          cache = $match.cache
          region = if ($null -eq $ocrRegion) { $null } else { @{ x = $ocrRegion.X; y = $ocrRegion.Y; width = $ocrRegion.Width; height = $ocrRegion.Height } }
        } -ExitCode 1
      }

      $targetX = [int]$match.target.x
      $targetY = [int]$match.target.y
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $matchWidth = [int][Math]::Ceiling([double]$match.rect.width + 18.0)
        $matchHeight = [int][Math]::Ceiling([double]$match.rect.height + 12.0)
        $frame = Show-HighlightFrame `
          -CenterX $targetX `
          -CenterY $targetY `
          -Width ([Math]::Max($HighlightWidth, $matchWidth)) `
          -Height ([Math]::Max($HighlightHeight, $matchHeight)) `
          -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $targetX -Py $targetY -Button "left" -Count 1 -Smooth $smoothMove
      $verify = Verify-CursorPosition -ExpectedX $targetX -ExpectedY $targetY -Message "Cursor did not land on OCR click target."
      Write-Result -Ok $true -Payload @{
        cursor = Get-CursorPoint
        match = $match
        region = if ($null -eq $ocrRegion) { $null } else { @{ x = $ocrRegion.X; y = $ocrRegion.Y; width = $ocrRegion.Width; height = $ocrRegion.Height } }
        motion = $motion
        highlight = $frame
        verify = $verify
        safety = $safety
      }
    }

    "clipboard_copy" {
      $mode = ""
      $sent = ""
      if (-not [string]::IsNullOrEmpty($Text)) {
        [void](Set-ClipboardTextValue -Value $Text)
        $mode = "set"
      } else {
        $sent = Send-Keys -Value "Ctrl+c" -Literal $false
        Start-Sleep -Milliseconds 90
        $mode = "hotkey"
      }
      $current = Get-ClipboardTextValue
      Write-Result -Ok $true -Payload @{
        mode = $mode
        sent = $sent
        text = $current
        length = $current.Length
        safety = $safety
      }
    }

    "clipboard_paste" {
      $seeded = $false
      if (-not [string]::IsNullOrEmpty($Text)) {
        [void](Set-ClipboardTextValue -Value $Text)
        $seeded = $true
      }
      $sent = Send-Keys -Value "Ctrl+v" -Literal $false
      $current = Get-ClipboardTextValue
      Write-Result -Ok $true -Payload @{
        seeded = $seeded
        sent = $sent
        text = $current
        length = $current.Length
        safety = $safety
      }
    }

    "clipboard_read" {
      $current = Get-ClipboardTextValue
      Write-Result -Ok $true -Payload @{ text = $current; length = $current.Length; safety = $safety }
    }

    "type" {
      if ([string]::IsNullOrWhiteSpace($Text)) {
        Write-Result -Ok $false -ErrorMessage "text is required for type." -ExitCode 1
      }
      $threshold = Clamp-Int -Value $TypewriterThreshold -Minimum 1 -Maximum 20000
      $useTypewriter = (-not $TypeDirect.IsPresent) -and ($Text.Length -le $threshold)

      if ($useTypewriter) {
        $typed = Send-TextTypewriter -Value $Text -MinDelayMs $TypewriterMinDelay -MaxDelayMs $TypewriterMaxDelay
        Write-Result -Ok $true -Payload @{
          sent = $typed.sent
          length = $Text.Length
          mode = "typewriter"
          typed_chars = $typed.typed_chars
          min_delay_ms = $typed.min_delay_ms
          max_delay_ms = $typed.max_delay_ms
          threshold = $threshold
          safety = $safety
        }
      }

      $sent = Send-Keys -Value $Text -Literal $true
      $reason = if ($TypeDirect.IsPresent) { "forced_direct" } else { "length_exceeds_threshold" }
      Write-Result -Ok $true -Payload @{
        sent = $sent
        length = $Text.Length
        mode = "direct"
        threshold = $threshold
        reason = $reason
        safety = $safety
      }
    }

    "key" {
      if ([string]::IsNullOrWhiteSpace($Keys)) {
        Write-Result -Ok $false -ErrorMessage "keys is required for key." -ExitCode 1
      }
      $sent = Send-Keys -Value $Keys -Literal $false
      Write-Result -Ok $true -Payload @{ sent = $sent; safety = $safety }
    }

    "scroll" {
      Ensure-UiTypes
      $motion = $null
      $verify = $null
      if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 20
        $verify = Verify-CursorPosition -ExpectedX $X -ExpectedY $Y -Message "Cursor did not reach scroll anchor."
      }
      $events = Invoke-MouseWheel -WheelDelta $Delta
      Write-Result -Ok $true -Payload @{ delta = $Delta; events = $events; cursor = Get-CursorPoint; motion = $motion; verify = $verify; safety = $safety }
    }

    "wait" {
      $ms = if ($Milliseconds -gt 0) { $Milliseconds } else { 1 }
      Start-Sleep -Milliseconds $ms
      Write-Result -Ok $true -Payload @{ waited_ms = $ms; safety = $safety }
    }

    "screenshot" {
      $screens = Get-TargetScreens -UseAll $AllScreens.IsPresent
      $screenCount = ($screens | Measure-Object).Count
      if ($screenCount -eq 0) {
        Write-Result -Ok $false -ErrorMessage "No screen is available for capture." -ExitCode 1
      }
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
      $defaultName = "ui-shot-$stamp.png"
      $targetPath = Resolve-OutputPath -CandidatePath $Output -DefaultFileName $defaultName
      $items = @()

      if ($screenCount -le 1) {
        $items += Capture-Screen -Screen $screens[0] -FilePath $targetPath
      } else {
        $ext = [System.IO.Path]::GetExtension($targetPath)
        if ([string]::IsNullOrWhiteSpace($ext)) { $ext = ".png" }
        $baseNoExt = if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetFileNameWithoutExtension($targetPath))) {
          Join-Path (Split-Path -Path $targetPath -Parent) "ui-shot-$stamp"
        } else {
          Join-Path (Split-Path -Path $targetPath -Parent) ([System.IO.Path]::GetFileNameWithoutExtension($targetPath))
        }

        for ($idx = 0; $idx -lt $screenCount; $idx++) {
          $file = "{0}-{1}{2}" -f $baseNoExt, $idx, $ext
          $items += Capture-Screen -Screen $screens[$idx] -FilePath $file
        }
      }

      $missing = @($items | Where-Object { -not (Test-Path -LiteralPath $_.path) })
      if ($missing.Count -gt 0) {
        Write-Result -Ok $false -ErrorMessage "Screenshot verification failed: one or more output files were not created." -Payload @{
          images = $items
          missing = $missing
        } -ExitCode 1
      }
      Write-Result -Ok $true -Payload @{ count = $items.Count; images = $items; verified = $true; safety = $safety }
    }

    "telemetry" {
      if ($TelemetryReset.IsPresent) {
        Reset-UiTelemetry
      }
      Write-Result -Ok $true -Payload @{
        telemetry = Get-UiTelemetrySnapshot -RecentCount $TelemetryRecent
        reset = [bool]$TelemetryReset.IsPresent
        safety = $safety
      }
    }

    "batch" {
      if ([string]::IsNullOrWhiteSpace($CommandsJson)) {
        Write-Result -Ok $false -ErrorMessage "commandsjson is required for batch." -ExitCode 1
      }
      $parsed = $CommandsJson | ConvertFrom-Json
      $rows = if ($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])) { @($parsed) } else { @($parsed) }
      if ($rows.Count -eq 0) {
        Write-Result -Ok $false -ErrorMessage "No commands provided for batch." -ExitCode 1
      }
      $queue = @()
      for ($idx = 0; $idx -lt $rows.Count; $idx++) {
        $priority = Get-RequestPriority -Request $rows[$idx]
        $queue += [ordered]@{
          index = $idx
          priority = $priority
          request = $rows[$idx]
        }
      }
      $orderedQueue = @(
        $queue |
          Sort-Object -Property `
            @{ Expression = { [int]$_.priority }; Descending = $true }, `
            @{ Expression = { [int]$_.index }; Descending = $false }
      )
      $results = @()
      for ($idx = 0; $idx -lt $orderedQueue.Count; $idx++) {
        $item = $orderedQueue[$idx]
        $prepared = Prepare-AdaptiveRequest -Request $item.request
        $response = Invoke-UiRequest -Request $prepared.request
        $results += [ordered]@{
          index = [int]$item.index
          priority = [int]$item.priority
          adaptive = $prepared.adaptive
          response = $response
        }
        if (-not [bool]$response.ok) {
          Write-Result -Ok $false -ErrorMessage "Batch command failed." -Payload @{
            index = [int]$item.index
            priority = [int]$item.priority
            adaptive = $prepared.adaptive
            response = $response
            results = $results
            telemetry = Get-UiTelemetrySnapshot -RecentCount $TelemetryRecent
          } -ExitCode 1
        }
      }
      $priorityOrder = @($orderedQueue | ForEach-Object { [ordered]@{ index = [int]$_.index; priority = [int]$_.priority } })
      Write-Result -Ok $true -Payload @{
        count = $results.Count
        results = $results
        priority_order = $priorityOrder
        telemetry = Get-UiTelemetrySnapshot -RecentCount $TelemetryRecent
        safety = $safety
      }
    }

    "host" {
      Write-Result -Ok $false -ErrorMessage "Use top-level host mode entrypoint; host is not valid as a nested command." -ExitCode 1
    }
  }
} catch {
  if ([string]$_.Exception.Message -eq $script:UiResultSignal) {
    return $script:UiLastResult
  }
  Write-Result -Ok $false -ErrorMessage ([string]$_.Exception.Message) -Payload @{
    type = [string]$_.Exception.GetType().FullName
  } -ExitCode 1
}
}

function Convert-ToSafeBool {
  param([object]$Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [bool]) { return [bool]$Value }
  return @("1", "true", "yes", "on") -contains ([string]$Value).Trim().ToLowerInvariant()
}

function Get-ObjectPropertyValue {
  param(
    [object]$Source,
    [string]$Name,
    [object]$DefaultValue = $null
  )
  if ($null -eq $Source -or [string]::IsNullOrWhiteSpace($Name)) { return $DefaultValue }
  foreach ($prop in @($Source.PSObject.Properties)) {
    if ([string]::Equals([string]$prop.Name, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $prop.Value
    }
  }
  return $DefaultValue
}

function Get-RequestPriority {
  param([object]$Request)
  $raw = Get-ObjectPropertyValue -Source $Request -Name "priority" -DefaultValue 0
  try {
    return [int]$raw
  } catch {
    return 0
  }
}

function Convert-RequestToHashtable {
  param([object]$Request)
  $row = if ($Request -is [string]) { $Request | ConvertFrom-Json } else { $Request }
  $map = [ordered]@{}
  foreach ($prop in @($row.PSObject.Properties)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$prop.Name)) {
      $map[[string]$prop.Name] = $prop.Value
    }
  }
  return $map
}

function Find-MapKeyIgnoreCase {
  param(
    [System.Collections.IDictionary]$Map,
    [string]$Name
  )
  if ($null -eq $Map -or [string]::IsNullOrWhiteSpace($Name)) { return "" }
  foreach ($key in @($Map.Keys)) {
    if ([string]::Equals([string]$key, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      return [string]$key
    }
  }
  return ""
}

function Get-MapValueIgnoreCase {
  param(
    [System.Collections.IDictionary]$Map,
    [string]$Name,
    [object]$DefaultValue = $null
  )
  $key = Find-MapKeyIgnoreCase -Map $Map -Name $Name
  if ([string]::IsNullOrWhiteSpace($key)) { return $DefaultValue }
  return $Map[$key]
}

function Set-MapValueIgnoreCase {
  param(
    [System.Collections.IDictionary]$Map,
    [string]$Name,
    [object]$Value
  )
  $key = Find-MapKeyIgnoreCase -Map $Map -Name $Name
  if ([string]::IsNullOrWhiteSpace($key)) {
    $Map[$Name] = $Value
    return [string]$Name
  }
  $Map[$key] = $Value
  return [string]$key
}

function Test-IsPointerAction {
  param([string]$ActionName)
  $a = ([string]$ActionName).Trim().ToLowerInvariant()
  return @("move", "mouse_down", "mouse_up", "drag", "click", "double_click", "right_click", "scroll", "click_text") -contains $a
}

function Prepare-AdaptiveRequest {
  param([Parameter(Mandatory = $true)][object]$Request)
  $map = Convert-RequestToHashtable -Request $Request
  $actionRaw = [string](Get-MapValueIgnoreCase -Map $map -Name "action" -DefaultValue "")
  $actionName = $actionRaw.Trim().ToLowerInvariant()
  $profile = Get-UiAdaptiveProfile
  $changes = New-Object System.Collections.ArrayList
  $adaptiveEnabled = $false

  if (Test-IsPointerAction -ActionName $actionName) {
    $cursorRecovery = $profile.cursor_recovery
    if ([bool]$cursorRecovery.enabled) {
      $adaptiveEnabled = $true
      $baseMoveDuration = 160
      $baseDragDuration = 420
      $curMoveDuration = [int](Get-MapValueIgnoreCase -Map $map -Name "MoveDuration" -DefaultValue $baseMoveDuration)
      $curMoveSteps = [int](Get-MapValueIgnoreCase -Map $map -Name "MoveSteps" -DefaultValue 0)
      $curDragDuration = [int](Get-MapValueIgnoreCase -Map $map -Name "DragDuration" -DefaultValue $baseDragDuration)
      $curDragSteps = [int](Get-MapValueIgnoreCase -Map $map -Name "DragSteps" -DefaultValue 0)

      $targetMoveDuration = Clamp-Int -Value ([int]([Math]::Max($curMoveDuration, $baseMoveDuration + [int]$cursorRecovery.move_duration_boost_ms))) -Minimum 80 -Maximum 900
      $targetMoveSteps = [int][Math]::Max($curMoveSteps, [int]$cursorRecovery.min_move_steps)
      $targetDragDuration = Clamp-Int -Value ([int]([Math]::Max($curDragDuration, $baseDragDuration + [int]$cursorRecovery.drag_duration_boost_ms))) -Minimum 120 -Maximum 1400
      $targetDragSteps = [int][Math]::Max($curDragSteps, [int]$cursorRecovery.min_drag_steps)

      if ($targetMoveDuration -ne $curMoveDuration) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "MoveDuration" -Value $targetMoveDuration)
        [void]$changes.Add(@{ key = "MoveDuration"; from = $curMoveDuration; to = $targetMoveDuration })
      }
      if ($targetMoveSteps -ne $curMoveSteps) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "MoveSteps" -Value $targetMoveSteps)
        [void]$changes.Add(@{ key = "MoveSteps"; from = $curMoveSteps; to = $targetMoveSteps })
      }
      if ($targetDragDuration -ne $curDragDuration) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "DragDuration" -Value $targetDragDuration)
        [void]$changes.Add(@{ key = "DragDuration"; from = $curDragDuration; to = $targetDragDuration })
      }
      if ($targetDragSteps -ne $curDragSteps) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "DragSteps" -Value $targetDragSteps)
        [void]$changes.Add(@{ key = "DragSteps"; from = $curDragSteps; to = $targetDragSteps })
      }
    }
  }

  if ($actionName -eq "click_text") {
    $ocrRecovery = $profile.ocr_recovery
    if ([bool]$ocrRecovery.enabled) {
      $adaptiveEnabled = $true
      $currentTtl = [int](Get-MapValueIgnoreCase -Map $map -Name "OcrCacheTtlMs" -DefaultValue 1200)
      $targetTtl = [int][Math]::Max($currentTtl, [int]$ocrRecovery.min_cache_ttl_ms)
      if ($targetTtl -ne $currentTtl) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "OcrCacheTtlMs" -Value $targetTtl)
        [void]$changes.Add(@{ key = "OcrCacheTtlMs"; from = $currentTtl; to = $targetTtl })
      }
      $existingAllScreensKey = Find-MapKeyIgnoreCase -Map $map -Name "AllScreens"
      $allScreensValue = Convert-ToSafeBool (Get-MapValueIgnoreCase -Map $map -Name "AllScreens" -DefaultValue $false)
      if ([bool]$ocrRecovery.promote_allscreens -and [string]::IsNullOrWhiteSpace($existingAllScreensKey) -and -not $allScreensValue) {
        [void](Set-MapValueIgnoreCase -Map $map -Name "AllScreens" -Value $true)
        [void]$changes.Add(@{ key = "AllScreens"; from = $false; to = $true })
      }
    }
  }

  return [ordered]@{
    request = $map
    adaptive = [ordered]@{
      enabled = [bool]$adaptiveEnabled
      applied = @($changes)
      profile = $profile
    }
  }
}

function Invoke-UiRequest {
  param([Parameter(Mandatory = $true)][object]$Request)
  $row = if ($Request -is [string]) { $Request | ConvertFrom-Json } else { $Request }
  $map = @{}
  if ($row -is [System.Collections.IDictionary]) {
    foreach ($key in @($row.Keys)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$key)) {
        $map[[string]$key.ToLowerInvariant()] = $row[$key]
      }
    }
  } else {
    foreach ($prop in @($row.PSObject.Properties)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$prop.Name)) {
        $map[[string]$prop.Name.ToLowerInvariant()] = $prop.Value
      }
    }
  }
  function Get-MapValue {
    param([hashtable]$Source, [string]$Name, [object]$DefaultValue = $null)
    $key = if ($null -eq $Name) { "" } else { [string]$Name.ToLowerInvariant() }
    if ($Source.ContainsKey($key)) { return $Source[$key] }
    return $DefaultValue
  }
  $rowAction = [string](Get-MapValue -Source $map -Name "action" -DefaultValue "")
  if ([string]::IsNullOrWhiteSpace($rowAction)) {
    return [ordered]@{ ok = $false; action = ""; error = "request.action is required." }
  }
  if ($rowAction -eq "host") {
    return [ordered]@{ ok = $false; action = "host"; error = "Nested host action is not allowed." }
  }

  $prior = [ordered]@{
    Action = $Action; Title = $Title; Regex = $Regex; X = $X; Y = $Y; EndX = $EndX; EndY = $EndY
    MoveDuration = $MoveDuration; MoveSteps = $MoveSteps; DragDuration = $DragDuration; DragSteps = $DragSteps
    InstantMove = $InstantMove; DragLeft = $DragLeft; Button = $Button; HighlightBeforeClick = $HighlightBeforeClick
    HighlightMilliseconds = $HighlightMilliseconds; HighlightWidth = $HighlightWidth; HighlightHeight = $HighlightHeight
    Text = $Text; TypeDirect = $TypeDirect; TypewriterThreshold = $TypewriterThreshold; TypewriterMinDelay = $TypewriterMinDelay
    TypewriterMaxDelay = $TypewriterMaxDelay; TextRegex = $TextRegex; ExactText = $ExactText; MatchIndex = $MatchIndex
    RegionX = $RegionX; RegionY = $RegionY; RegionWidth = $RegionWidth; RegionHeight = $RegionHeight; OcrCacheTtlMs = $OcrCacheTtlMs
    Keys = $Keys; Delta = $Delta; Milliseconds = $Milliseconds; Output = $Output; AllScreens = $AllScreens; Limit = $Limit
    TelemetryRecent = $TelemetryRecent; TelemetryReset = $TelemetryReset
    CommandsJson = $CommandsJson; AllowAmbiguousFocus = $AllowAmbiguousFocus; AllowUnsafe = $AllowUnsafe
  }
  try {
    $Action = $rowAction
    $Title = [string](Get-MapValue -Source $map -Name "title" -DefaultValue "")
    $Regex = [string](Get-MapValue -Source $map -Name "regex" -DefaultValue "")
    $X = [int](Get-MapValue -Source $map -Name "x" -DefaultValue ([int]::MinValue))
    $Y = [int](Get-MapValue -Source $map -Name "y" -DefaultValue ([int]::MinValue))
    $EndX = [int](Get-MapValue -Source $map -Name "endx" -DefaultValue ([int]::MinValue))
    $EndY = [int](Get-MapValue -Source $map -Name "endy" -DefaultValue ([int]::MinValue))
    $MoveDuration = [int](Get-MapValue -Source $map -Name "moveduration" -DefaultValue 160)
    $MoveSteps = [int](Get-MapValue -Source $map -Name "movesteps" -DefaultValue 0)
    $DragDuration = [int](Get-MapValue -Source $map -Name "dragduration" -DefaultValue 420)
    $DragSteps = [int](Get-MapValue -Source $map -Name "dragsteps" -DefaultValue 0)
    $InstantMove = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "instantmove" -DefaultValue $false))
    $DragLeft = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "dragleft" -DefaultValue $false))
    $Button = [string](Get-MapValue -Source $map -Name "button" -DefaultValue "left")
    $HighlightBeforeClick = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "highlightbeforeclick" -DefaultValue $false))
    $HighlightMilliseconds = [int](Get-MapValue -Source $map -Name "highlightmilliseconds" -DefaultValue 320)
    $HighlightWidth = [int](Get-MapValue -Source $map -Name "highlightwidth" -DefaultValue 100)
    $HighlightHeight = [int](Get-MapValue -Source $map -Name "highlightheight" -DefaultValue 36)
    $Text = [string](Get-MapValue -Source $map -Name "text" -DefaultValue "")
    $TypeDirect = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "typedirect" -DefaultValue $false))
    $TypewriterThreshold = [int](Get-MapValue -Source $map -Name "typewriterthreshold" -DefaultValue 180)
    $TypewriterMinDelay = [int](Get-MapValue -Source $map -Name "typewritermindelay" -DefaultValue 8)
    $TypewriterMaxDelay = [int](Get-MapValue -Source $map -Name "typewritermaxdelay" -DefaultValue 28)
    $TextRegex = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "textregex" -DefaultValue $false))
    $ExactText = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "exacttext" -DefaultValue $false))
    $MatchIndex = [int](Get-MapValue -Source $map -Name "matchindex" -DefaultValue 1)
    $RegionX = [int](Get-MapValue -Source $map -Name "regionx" -DefaultValue ([int]::MinValue))
    $RegionY = [int](Get-MapValue -Source $map -Name "regiony" -DefaultValue ([int]::MinValue))
    $RegionWidth = [int](Get-MapValue -Source $map -Name "regionwidth" -DefaultValue 0)
    $RegionHeight = [int](Get-MapValue -Source $map -Name "regionheight" -DefaultValue 0)
    $OcrCacheTtlMs = [int](Get-MapValue -Source $map -Name "ocrcachettlms" -DefaultValue 1200)
    $Keys = [string](Get-MapValue -Source $map -Name "keys" -DefaultValue "")
    $Delta = [int](Get-MapValue -Source $map -Name "delta" -DefaultValue (-120))
    $Milliseconds = [int](Get-MapValue -Source $map -Name "milliseconds" -DefaultValue 100)
    $Output = [string](Get-MapValue -Source $map -Name "output" -DefaultValue "")
    $AllScreens = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "allscreens" -DefaultValue $false))
    $Limit = [int](Get-MapValue -Source $map -Name "limit" -DefaultValue 20)
    $TelemetryRecent = [int](Get-MapValue -Source $map -Name "telemetryrecent" -DefaultValue 20)
    $TelemetryReset = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "telemetryreset" -DefaultValue $false))
    $CommandsJson = [string](Get-MapValue -Source $map -Name "commandsjson" -DefaultValue "")
    $AllowAmbiguousFocus = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "allowambiguousfocus" -DefaultValue $false))
    $AllowUnsafe = [switch](Convert-ToSafeBool (Get-MapValue -Source $map -Name "allowunsafe" -DefaultValue $false))
    $script:UiReturnMode = $true
    return Invoke-UiActionRunner
  } catch {
    return [ordered]@{ ok = $false; action = $rowAction; error = [string]$_.Exception.Message }
  } finally {
    $script:UiReturnMode = $false
    foreach ($name in $prior.Keys) {
      if ([string]::IsNullOrWhiteSpace([string]$name)) { continue }
      Set-Variable -Name $name -Value $prior[$name]
    }
  }
}

function Start-UiHost {
  $pending = New-Object System.Collections.ArrayList
  [Console]::WriteLine((@{
      ok = $true
      action = "host"
      result = @{
        ready = $true
        protocol = "jsonl"
        pid = $PID
        controls = @("shutdown", "telemetry", "telemetry_reset")
        queue_priority = $true
        telemetry = $true
        adaptive_tuning = $true
      }
    } | ConvertTo-Json -Depth 8 -Compress))

  function Add-HostQueueItem {
    param([object]$Request)
    $script:UiQueueSequence++
    $item = [ordered]@{
      sequence = [long]$script:UiQueueSequence
      priority = [int](Get-RequestPriority -Request $Request)
      request = $Request
    }
    [void]$pending.Add($item)
  }

  function Pop-HostQueueItem {
    if ($pending.Count -le 0) { return $null }
    $bestIdx = 0
    for ($i = 1; $i -lt $pending.Count; $i++) {
      $candidate = $pending[$i]
      $best = $pending[$bestIdx]
      $isHigher = ([int]$candidate.priority -gt [int]$best.priority)
      $isTieEarlier = ([int]$candidate.priority -eq [int]$best.priority) -and ([long]$candidate.sequence -lt [long]$best.sequence)
      if ($isHigher -or $isTieEarlier) {
        $bestIdx = $i
      }
    }
    $picked = $pending[$bestIdx]
    $pending.RemoveAt($bestIdx)
    return $picked
  }

  function Try-QueueRequestLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace([string]$Line)) { return @{ continue = $true; shutdown = $false } }
    $request = $null
    try {
      $request = $Line | ConvertFrom-Json
    } catch {
      [Console]::WriteLine((@{ ok = $false; action = "host"; error = "Invalid JSON input." } | ConvertTo-Json -Depth 8 -Compress))
      return @{ continue = $true; shutdown = $false }
    }
    $requestAction = ([string](Get-ObjectPropertyValue -Source $request -Name "action" -DefaultValue "")).Trim().ToLowerInvariant()
    if ($requestAction -eq "shutdown") {
      [Console]::WriteLine((@{
          ok = $true
          action = "shutdown"
          result = @{
            stopped = $true
            remaining = $pending.Count
            telemetry = Get-UiTelemetrySnapshot -RecentCount 40
          }
        } | ConvertTo-Json -Depth 8 -Compress))
      return @{ continue = $false; shutdown = $true }
    }
    if ($requestAction -eq "telemetry") {
      $recentRaw = Get-ObjectPropertyValue -Source $request -Name "telemetryRecent" -DefaultValue 20
      $recentCount = 20
      try { $recentCount = [int]$recentRaw } catch { $recentCount = 20 }
      $wantReset = Convert-ToSafeBool (Get-ObjectPropertyValue -Source $request -Name "telemetryReset" -DefaultValue $false)
      if ($wantReset) { Reset-UiTelemetry }
      [Console]::WriteLine((@{
          ok = $true
          action = "telemetry"
          result = @{
            reset = [bool]$wantReset
            telemetry = Get-UiTelemetrySnapshot -RecentCount $recentCount
          }
          queue = @{
            remaining = [int]$pending.Count
          }
        } | ConvertTo-Json -Depth 8 -Compress))
      return @{ continue = $true; shutdown = $false }
    }
    Add-HostQueueItem -Request $request
    return @{ continue = $true; shutdown = $false }
  }

  for (;;) {
    if ($pending.Count -le 0) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $result = Try-QueueRequestLine -Line $line
      if (-not [bool]$result.continue) { break }
    }

    for (;;) {
      $peek = -1
      try {
        $peek = [Console]::In.Peek()
      } catch {
        $peek = -1
      }
      if ($peek -lt 0) { break }
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $result = Try-QueueRequestLine -Line $line
      if (-not [bool]$result.continue) { return }
    }

    $item = Pop-HostQueueItem
    if ($null -eq $item) { continue }
    $prepared = Prepare-AdaptiveRequest -Request $item.request
    $response = Invoke-UiRequest -Request $prepared.request
    $hasResult = $false
    $resultValue = $null
    $errorValue = ""
    if ($response -is [System.Collections.IDictionary]) {
      if ($response.Contains("result")) {
        $hasResult = $true
        $resultValue = $response["result"]
      }
      if ($response.Contains("error")) {
        $errorValue = [string]$response["error"]
      }
    } else {
      $resultProp = $response.PSObject.Properties["result"]
      if ($null -ne $resultProp) {
        $hasResult = $true
        $resultValue = $resultProp.Value
      }
      $errorProp = $response.PSObject.Properties["error"]
      if ($null -ne $errorProp) {
        $errorValue = [string]$errorProp.Value
      }
    }
    $envelope = [ordered]@{
      ok = [bool]$response.ok
      action = [string]$response.action
      adaptive = $prepared.adaptive
      queue = [ordered]@{
        priority = [int]$item.priority
        sequence = [long]$item.sequence
        remaining = [int]$pending.Count
      }
      telemetry = Get-UiTelemetryBrief
    }
    if ([bool]$response.ok) {
      if ($hasResult) {
        $envelope.result = $resultValue
      }
    } else {
      $envelope.error = $errorValue
      if ($hasResult) {
        $envelope.result = $resultValue
      }
    }
    [Console]::WriteLine(($envelope | ConvertTo-Json -Depth 8 -Compress))
  }
}

if ($Action -eq "host") {
  Start-UiHost
  exit 0
}

Invoke-UiActionRunner
