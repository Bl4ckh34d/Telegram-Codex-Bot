param(
  [string]$SunshineCommand = "C:\Users\ROG\AppData\Local\Apollo\StartSunshine.cmd",
  [string]$TvHost = "",
  [int]$TvPort = 5555,
  [string]$TvSerial = "",
  [int]$SunshineWaitMs = 3500,
  [int]$TvPowerWaitMs = 2000,
  [int]$ArtemisWaitMs = 2000,
  [int]$ArtemisLoadWaitMs = 0,
  [int]$StreamDetectTimeoutMs = 25000,
  [int]$StreamDetectPollMs = 1500,
  [switch]$SkipArtemisKeySequence,
  [switch]$AllowUnverifiedStream = $true,
  [string]$BrowserProcess = "firefox",
  [int]$BrowserSettleMs = 1400,
  [string]$MoveDirection = "Right",
  [string]$FirstUrl = "https://s.to",
  [string]$SecondUrl = "https://sflix.ps",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-FromJsonLine {
  param([string]$Raw)
  $text = [string]$Raw
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "Command returned no output."
  }
  $lines = @($text -split "(`r`n|`n|`r)" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = [string]$lines[$i]
    if ($line.TrimStart().StartsWith("{")) {
      try {
        return ($line | ConvertFrom-Json -ErrorAction Stop)
      } catch {}
    }
  }
  throw "Could not find JSON output in command response."
}

function Invoke-JsonScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][hashtable]$Arguments
  )
  if ($DryRun.IsPresent) {
    return [pscustomobject]@{
      ok = $true
      action = "dryrun"
      result = @{
        script = $ScriptPath
        args = $Arguments
      }
    }
  }
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath)
  foreach ($key in @($Arguments.Keys)) {
    $val = $Arguments[$key]
    if ($null -eq $val) { continue }
    if ($val -is [switch]) {
      if (-not $val.IsPresent) { continue }
      $argList += "-$key"
      continue
    }
    if ($val -is [bool]) {
      if (-not $val) { continue }
      $argList += "-$key"
      continue
    }
    if ($val -is [string] -and [string]::IsNullOrWhiteSpace([string]$val)) { continue }
    $argList += "-$key"
    $argList += [string]$val
  }

  # Run in a child process so Console.WriteLine output from tool scripts is captured.
  $raw = (& powershell @argList 2>&1 | Out-String)
  return Convert-FromJsonLine -Raw $raw
}

function Invoke-Ui {
  param([Parameter(Mandatory = $true)][hashtable]$Arguments)
  $resp = Invoke-JsonScript -ScriptPath $script:UiScript -Arguments $Arguments
  if (-not $resp.ok) {
    $msg = [string]$resp.error
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "UI automation action failed." }
    throw $msg
  }
  return $resp
}

function Get-ScreenCountSafe {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    return [System.Windows.Forms.Screen]::AllScreens.Count
  } catch {
    return 0
  }
}

function Invoke-SunshineStart {
  param([string]$CommandText)
  if ($DryRun.IsPresent) { return }
  if ([string]::IsNullOrWhiteSpace($CommandText)) {
    throw "Sunshine command is empty."
  }
  $trimmed = $CommandText.Trim()
  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "Sunshine launcher file was not found."
  }
  $ext = [IO.Path]::GetExtension($trimmed).ToLowerInvariant()
  if ($ext -eq ".ps1") {
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $trimmed) -WindowStyle Hidden | Out-Null
    return
  }
  if ($ext -eq ".cmd" -or $ext -eq ".bat") {
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$trimmed`"") -WindowStyle Hidden | Out-Null
    return
  }
  Start-Process -FilePath $trimmed -WindowStyle Hidden | Out-Null
}

function Test-SunshineRunning {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "sunshine" })
  return ($procs.Count -gt 0)
}

function Stop-SunshineProcesses {
  if ($DryRun.IsPresent) { return 0 }
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "sunshine" })
  if ($procs.Count -eq 0) {
    return 0
  }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.Id -Force -ErrorAction Stop
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds(5000)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-SunshineRunning)) {
      return $procs.Count
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Sunshine was running but could not be stopped cleanly."
}

function Resolve-AdbTarget {
  if ($TvSerial) { return $TvSerial }
  if ($TvHost) {
    $endpoint = "$TvHost`:$TvPort"
    & adb connect $endpoint | Out-Null
    return $endpoint
  }
  $envHost = ([string]$env:AIDOLON_TV_HOST).Trim()
  if ($envHost) {
    $endpoint = "$envHost`:$TvPort"
    & adb connect $endpoint | Out-Null
    return $endpoint
  }
  return ""
}

function Send-AdbKey {
  param(
    [string]$Target,
    [int]$Code
  )
  if ($DryRun.IsPresent) { return }
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }
  $args = @()
  if ($Target) { $args += @("-s", $Target) }
  $args += @("shell", "input", "keyevent", [string]$Code)
  & adb @args | Out-Null
}

if ($MoveDirection -ne "Left" -and $MoveDirection -ne "Right") {
  throw "MoveDirection must be Left or Right."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TvPowerScript = Join-Path $scriptRoot "tv_power.ps1"
$TvOpenScript = Join-Path $scriptRoot "tv_open_app.ps1"
$script:UiScript = Join-Path $scriptRoot "ui_automation.ps1"

foreach ($must in @($TvPowerScript, $TvOpenScript, $script:UiScript)) {
  if (-not (Test-Path -LiteralPath $must)) {
    throw "Required tool script is missing."
  }
}

$summary = [ordered]@{
  ok = $false
  mode = if ($DryRun.IsPresent) { "dry-run" } else { "live" }
  steps = @()
  streamVerified = $false
  firstUrl = $FirstUrl
  secondUrl = $SecondUrl
}

$previousUiAllow = [string]$env:AIDOLON_UI_ALLOW_MUTATIONS
$env:AIDOLON_UI_ALLOW_MUTATIONS = "1"

try {
  $summary.steps += "restart_sunshine"
  $stoppedSunshineCount = 0
  $sunshineAlreadyRunning = $false
  if (-not $DryRun.IsPresent) {
    $sunshineAlreadyRunning = Test-SunshineRunning
  }
  if ($sunshineAlreadyRunning) {
    $stoppedSunshineCount = Stop-SunshineProcesses
  }
  Invoke-SunshineStart -CommandText $SunshineCommand
  Start-Sleep -Milliseconds $SunshineWaitMs
  if ($DryRun.IsPresent) {
    $summary.sunshineAction = "dry_run"
  } else {
    $summary.sunshineAction = if ($sunshineAlreadyRunning) { "restarted" } else { "started" }
    if ($sunshineAlreadyRunning) {
      $summary.sunshineStoppedCount = $stoppedSunshineCount
    }
  }
  if (-not $DryRun.IsPresent -and -not (Test-SunshineRunning)) {
    throw "Sunshine did not start. Stopping before TV connection."
  }

  $summary.steps += "tv_power_on"
  $tvPower = Invoke-JsonScript -ScriptPath $TvPowerScript -Arguments @{
    Action = "on"
    WaitMs = $TvPowerWaitMs
    Host = $TvHost
    Port = $TvPort
    Serial = $TvSerial
  }
  if (-not $tvPower.ok) {
    throw "TV power on failed: $([string]$tvPower.error)"
  }

  $summary.steps += "open_artemis"
  $tvApp = Invoke-JsonScript -ScriptPath $TvOpenScript -Arguments @{
    Action = "artemis"
    WaitMs = $ArtemisWaitMs
    Host = $TvHost
    Port = $TvPort
    Serial = $TvSerial
  }
  if (-not $tvApp.ok) {
    throw "Opening Artemis failed: $([string]$tvApp.error)"
  }

  $baselineScreens = Get-ScreenCountSafe
  $summary.steps += "artemis_connect_attempt"
  if ($ArtemisLoadWaitMs -gt 0) {
    Start-Sleep -Milliseconds $ArtemisLoadWaitMs
  }
  if (-not $SkipArtemisKeySequence.IsPresent) {
    $target = Resolve-AdbTarget
    # Default Artemis flow with one PC entry:
    # Center selects PC, second center enters TV display stream.
    Send-AdbKey -Target $target -Code 23
    Start-Sleep -Milliseconds 1300
    Send-AdbKey -Target $target -Code 23
  }

  $deadline = [DateTime]::UtcNow.AddMilliseconds($StreamDetectTimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($DryRun.IsPresent) {
      $summary.streamVerified = $true
      break
    }
    $currentScreens = Get-ScreenCountSafe
    if ($baselineScreens -gt 0 -and $currentScreens -gt $baselineScreens) {
      $summary.streamVerified = $true
      break
    }
    Start-Sleep -Milliseconds $StreamDetectPollMs
  }
  if (-not $summary.streamVerified -and -not $AllowUnverifiedStream.IsPresent) {
    throw "Stream activation could not be verified from display detection."
  }

  if ($DryRun.IsPresent) {
    $summary.steps += "open_firefox_window"
    $summary.steps += "move_and_fullscreen"
    $summary.steps += "open_sites"
    $summary.ok = $true
    $summary.message = "Dry run complete. No actions were executed."
    ($summary | ConvertTo-Json -Compress -Depth 8)
    exit 0
  }

  $summary.steps += "open_firefox_window"
  if (-not $DryRun.IsPresent -and -not (Get-Process -Name $BrowserProcess -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "$BrowserProcess.exe" | Out-Null
    Start-Sleep -Milliseconds $BrowserSettleMs
  }
  $winsBeforeResp = Invoke-Ui -Arguments @{
    Action = "windows"
    Limit = 100
  }
  $winsBefore = @($winsBeforeResp.result.windows | Where-Object { [string]$_.process -eq $BrowserProcess }).Count

  Invoke-Ui -Arguments @{
    Action = "focus"
    Regex = "Firefox"
    AllowAmbiguousFocus = $true
  } | Out-Null
  Start-Sleep -Milliseconds 260
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "Ctrl+N"
  } | Out-Null
  Start-Sleep -Milliseconds $BrowserSettleMs

  $winsAfterResp = Invoke-Ui -Arguments @{
    Action = "windows"
    Limit = 100
  }
  $winsAfter = @($winsAfterResp.result.windows | Where-Object { [string]$_.process -eq $BrowserProcess }).Count
  if (-not $DryRun.IsPresent -and $winsAfter -le $winsBefore) {
    throw "Could not open a brand new Firefox window. Stopping before typing into any address bar."
  }

  $moveHotkey = if ($MoveDirection -eq "Left") { "Win+Shift+Left" } else { "Win+Shift+Right" }
  $summary.steps += "move_and_fullscreen"
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = $moveHotkey
  } | Out-Null
  Start-Sleep -Milliseconds 520
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "F11"
  } | Out-Null

  $summary.steps += "open_sites"
  Start-Sleep -Milliseconds 420
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "Ctrl+L"
  } | Out-Null
  Start-Sleep -Milliseconds 180
  Invoke-Ui -Arguments @{
    Action = "type"
    Text = $FirstUrl
    TypeDirect = $true
  } | Out-Null
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "{ENTER}"
  } | Out-Null
  Start-Sleep -Milliseconds 2400
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "Ctrl+T"
  } | Out-Null
  Start-Sleep -Milliseconds 220
  Invoke-Ui -Arguments @{
    Action = "type"
    Text = $SecondUrl
    TypeDirect = $true
  } | Out-Null
  Invoke-Ui -Arguments @{
    Action = "key"
    Keys = "{ENTER}"
  } | Out-Null

  $summary.ok = $true
  $summary.message = "TV prep is complete. Ready for show/movie selection."
  ($summary | ConvertTo-Json -Compress -Depth 8)
  exit 0
} catch {
  $summary.ok = $false
  $summary.error = [string]$_.Exception.Message
  ($summary | ConvertTo-Json -Compress -Depth 8)
  exit 1
} finally {
  if ([string]::IsNullOrEmpty($previousUiAllow)) {
    Remove-Item Env:AIDOLON_UI_ALLOW_MUTATIONS -ErrorAction SilentlyContinue
  } else {
    $env:AIDOLON_UI_ALLOW_MUTATIONS = $previousUiAllow
  }
}
