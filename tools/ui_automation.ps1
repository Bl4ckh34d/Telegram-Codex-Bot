[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("windows", "focus", "click", "double_click", "right_click", "move", "mouse_down", "mouse_up", "drag", "highlight", "click_text", "clipboard_copy", "clipboard_paste", "clipboard_read", "type", "key", "scroll", "wait", "screenshot")]
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
  [int]$TypewriterMinDelay = 35,
  [int]$TypewriterMaxDelay = 110,
  [switch]$TextRegex,
  [switch]$ExactText,
  [int]$MatchIndex = 1,
  [string]$Keys = "",
  [int]$Delta = -120,
  [int]$Milliseconds = 250,
  [string]$Output = "",
  [switch]$AllScreens,
  [int]$Limit = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::WriteLine($json)
  exit $ExitCode
}

function Require-Point {
  if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) {
    Write-Result -Ok $false -ErrorMessage "x and y are required for this action." -ExitCode 1
  }
}

function Require-EndPoint {
  if ($EndX -eq [int]::MinValue -or $EndY -eq [int]::MinValue) {
    Write-Result -Ok $false -ErrorMessage "endx and endy are required for this action." -ExitCode 1
  }
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
      Write-Result -Ok $false -ErrorMessage "Invalid regex pattern." -Payload @{ regex = $RegexPattern } -ExitCode 1
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

function Get-TargetScreens {
  param([bool]$UseAll = $false)
  Ensure-DrawingTypes
  $source = if ($UseAll) { [System.Windows.Forms.Screen]::AllScreens } else { [System.Windows.Forms.Screen]::PrimaryScreen }
  return @($source | Where-Object { $null -ne $_ })
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
    [int]$Index = 1
  )

  $needle = ([string]$Query).Trim()
  if ([string]::IsNullOrWhiteSpace($needle)) {
    Write-Result -Ok $false -ErrorMessage "text is required for click_text." -ExitCode 1
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

  foreach ($screen in @($Screens)) {
    $bmp = Capture-ScreenBitmap -Screen $screen
    try {
      $ocr = Invoke-OcrOnBitmap -Bitmap $bmp
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
            screen_left = [int]$screen.Bounds.Left
            screen_top = [int]$screen.Bounds.Top
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
      matches = 0
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
  $targetX = [int][Math]::Round([double]$picked.screen_left + [double]$rect.x + ([double]$rect.width / 2.0))
  $targetY = [int][Math]::Round([double]$picked.screen_top + [double]$rect.y + ([double]$rect.height / 2.0))

  return [ordered]@{
    found = $true
    scanned_lines = $scannedLines
    matches = $sorted.Count
    selected_index = $safeIndex
    language = [string]$picked.language
    text = [string]$picked.line_text
    rect = [ordered]@{
      x = [double]$rect.x
      y = [double]$rect.y
      width = [double]$rect.width
      height = [double]$rect.height
      screen_left = [int]$picked.screen_left
      screen_top = [int]$picked.screen_top
    }
    target = [ordered]@{
      x = $targetX
      y = $targetY
    }
  }
}

try {
  $smoothMove = $true

  switch ($Action) {
    "windows" {
      $max = if ($Limit -gt 0) { $Limit } else { 20 }
      $rows = @(Get-WindowCandidates | Select-Object -First $max | ForEach-Object { Get-WindowSummary -Process $_ })
      Write-Result -Ok $true -Payload @{ count = $rows.Count; windows = $rows }
    }

    "focus" {
      $target = Find-Window -TitlePattern $Title -RegexPattern $Regex
      if ($null -eq $target) {
        Write-Result -Ok $false -ErrorMessage "No matching window found." -Payload @{ title = $Title; regex = $Regex } -ExitCode 1
      }
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
      Write-Result -Ok $true -Payload @{
        cursor = Get-CursorPoint
        dragged_left = [bool]$DragLeft.IsPresent
        motion = $motion
      }
    }

    "mouse_down" {
      Ensure-UiTypes
      $motion = $null
      if (($X -ne [int]::MinValue) -or ($Y -ne [int]::MinValue)) {
        Require-Point
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 15
      }
      Invoke-MouseButton -Button $Button -State "down"
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = $Button; state = "down"; motion = $motion }
    }

    "mouse_up" {
      Ensure-UiTypes
      $motion = $null
      if (($X -ne [int]::MinValue) -or ($Y -ne [int]::MinValue)) {
        Require-Point
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 15
      }
      Invoke-MouseButton -Button $Button -State "up"
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = $Button; state = "up"; motion = $motion }
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

      Write-Result -Ok $true -Payload @{
        button = $Button
        start = [ordered]@{ x = $X; y = $Y }
        end = [ordered]@{ x = $EndX; y = $EndY }
        cursor = Get-CursorPoint
        start_motion = $startMotion
        drag_motion = $dragMotion
      }
    }

    "highlight" {
      Require-Point
      $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; frame = $frame }
    }

    "click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "left" -Count 1 -Smooth $smoothMove
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "left"; count = 1; motion = $motion; highlight = $frame }
    }

    "double_click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "left" -Count 2 -Smooth $smoothMove
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "left"; count = 2; motion = $motion; highlight = $frame }
    }

    "right_click" {
      Require-Point
      $frame = $null
      if ($HighlightBeforeClick.IsPresent) {
        $frame = Show-HighlightFrame -CenterX $X -CenterY $Y -Width $HighlightWidth -Height $HighlightHeight -DurationMs $HighlightMilliseconds
      }
      $motion = Invoke-MouseClick -Px $X -Py $Y -Button "right" -Count 1 -Smooth $smoothMove
      Write-Result -Ok $true -Payload @{ cursor = Get-CursorPoint; button = "right"; count = 1; motion = $motion; highlight = $frame }
    }

    "click_text" {
      if ([string]::IsNullOrWhiteSpace($Text)) {
        Write-Result -Ok $false -ErrorMessage "text is required for click_text." -ExitCode 1
      }
      $screens = Get-TargetScreens -UseAll $AllScreens.IsPresent
      $screenCount = ($screens | Measure-Object).Count
      if ($screenCount -eq 0) {
        Write-Result -Ok $false -ErrorMessage "No screen is available for OCR text click." -ExitCode 1
      }

      $match = Find-OcrTextMatch -Screens $screens -Query $Text -UseRegex $TextRegex.IsPresent -Exact $ExactText.IsPresent -Index $MatchIndex
      if (-not $match.found) {
        Write-Result -Ok $false -ErrorMessage "No visible text match found on screen." -Payload @{
          text = $Text
          regex = [bool]$TextRegex.IsPresent
          exact = [bool]$ExactText.IsPresent
          scanned_lines = $match.scanned_lines
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
      Write-Result -Ok $true -Payload @{
        cursor = Get-CursorPoint
        match = $match
        motion = $motion
        highlight = $frame
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
      }
    }

    "clipboard_read" {
      $current = Get-ClipboardTextValue
      Write-Result -Ok $true -Payload @{ text = $current; length = $current.Length }
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
      }
    }

    "key" {
      if ([string]::IsNullOrWhiteSpace($Keys)) {
        Write-Result -Ok $false -ErrorMessage "keys is required for key." -ExitCode 1
      }
      $sent = Send-Keys -Value $Keys -Literal $false
      Write-Result -Ok $true -Payload @{ sent = $sent }
    }

    "scroll" {
      Ensure-UiTypes
      $motion = $null
      if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
        $motion = Move-Cursor -Px $X -Py $Y -Smooth $smoothMove
        Start-Sleep -Milliseconds 20
      }
      $events = Invoke-MouseWheel -WheelDelta $Delta
      Write-Result -Ok $true -Payload @{ delta = $Delta; events = $events; cursor = Get-CursorPoint; motion = $motion }
    }

    "wait" {
      $ms = if ($Milliseconds -gt 0) { $Milliseconds } else { 1 }
      Start-Sleep -Milliseconds $ms
      Write-Result -Ok $true -Payload @{ waited_ms = $ms }
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

      Write-Result -Ok $true -Payload @{ count = $items.Count; images = $items }
    }
  }
} catch {
  Write-Result -Ok $false -ErrorMessage ([string]$_.Exception.Message) -Payload @{
    type = [string]$_.Exception.GetType().FullName
  } -ExitCode 1
}
