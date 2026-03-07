param(
  [ValidateSet("on", "off", "toggle")]
  [string]$Action = "on",
  [string]$Serial = "",
  [Alias("Host")]
  [string]$TvHost = "",
  [int]$Port = 5555,
  [int]$WaitMs = 700
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-AdbRaw {
  param([Parameter(Mandatory = $true)][string[]]$Args)
  & adb @Args
}

function Invoke-Adb {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args,
    [string]$DeviceSerial = ""
  )
  $full = @()
  if ($DeviceSerial) { $full += @("-s", $DeviceSerial) }
  $full += $Args
  & adb @full
}

function Resolve-TargetSerial {
  if ($Serial) { return $Serial }

  $defaultHost = ([string]$env:AIDOLON_TV_HOST).Trim()
  if (-not $defaultHost) { $defaultHost = "192.168.1.104" }

  $tvHostValue = ([string]$TvHost).Trim()
  if (-not $tvHostValue) { $tvHostValue = $defaultHost }
  if ($tvHostValue) {
    $endpoint = "$tvHostValue`:$Port"
    Invoke-AdbRaw @("connect", $endpoint) | Out-Null
    return $endpoint
  }

  $lines = (Invoke-AdbRaw @("devices") | Out-String).Split("`n")
  $online = @()
  foreach ($line in $lines) {
    $trimmed = ([string]$line).Trim()
    if (-not $trimmed -or $trimmed -like "List of devices*") { continue }
    $parts = $trimmed -split "\s+"
    if ($parts.Count -ge 2 -and $parts[1] -eq "device") {
      $online += $parts[0]
    }
  }
  if ($online.Count -eq 1) { return $online[0] }
  if ($online.Count -gt 1) {
    throw "Multiple ADB devices detected. Use -Serial or -Host."
  }
  throw "No ADB device detected. Connect TV or pass -Host/-Serial."
}

function Get-Wakefulness {
  param([Parameter(Mandatory = $true)][string]$DeviceSerial)
  try {
    $raw = (Invoke-Adb @("shell", "dumpsys power") -DeviceSerial $DeviceSerial | Out-String)
    $m = [Regex]::Match($raw, "mWakefulness=([A-Za-z]+)")
    if ($m.Success) { return $m.Groups[1].Value }
  } catch {}
  return ""
}

function Send-KeyEvents {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceSerial,
    [Parameter(Mandatory = $true)][int[]]$Codes
  )
  foreach ($code in $Codes) {
    Invoke-Adb @("shell", "input keyevent $code") -DeviceSerial $DeviceSerial | Out-Null
    Start-Sleep -Milliseconds 200
  }
}

try {
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }

  $target = Resolve-TargetSerial
  $before = Get-Wakefulness -DeviceSerial $target

  switch ($Action) {
    "on" {
      if ($before -eq "Awake") {
        Send-KeyEvents -DeviceSerial $target -Codes @(3) # HOME
      } else {
        Send-KeyEvents -DeviceSerial $target -Codes @(224, 3) # WAKEUP, HOME
      }
    }
    "off" {
      Send-KeyEvents -DeviceSerial $target -Codes @(223) # SLEEP (standby-only; avoids bounce-back on some TVs)
    }
    "toggle" {
      Send-KeyEvents -DeviceSerial $target -Codes @(26) # POWER
    }
  }

  Start-Sleep -Milliseconds $WaitMs
  $after = Get-Wakefulness -DeviceSerial $target

  [pscustomobject]@{
    ok = $true
    action = $Action
    target = $target
    wakefulnessBefore = $before
    wakefulnessAfter = $after
    waitedMs = $WaitMs
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  [pscustomobject]@{
    ok = $false
    action = $Action
    error = [string]$_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 1
}
