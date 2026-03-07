param(
  [string]$Serial = "",
  [Alias("Host")]
  [string]$TvHost = "",
  [int]$Port = 5555,
  [string]$RemoteDir = "/sdcard/Download",
  [string]$RemotePrefix = "orion_capture_",
  [string]$OutputDir = "runtime/out",
  [string]$LocalPrefix = "tv_capture_"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

function Invoke-AdbRaw {
  param([Parameter(Mandatory = $true)][string[]]$Args)
  & adb @Args
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

function Remove-RemoteCaptureFiles {
  param([Parameter(Mandatory = $true)][string]$DeviceSerial)
  $pattern = "$RemotePrefix*.png"
  Invoke-Adb @("shell", "rm -f $RemoteDir/$pattern") -DeviceSerial $DeviceSerial
  $remaining = (Invoke-Adb @("shell", "ls -1 $RemoteDir/$pattern 2>/dev/null || true") -DeviceSerial $DeviceSerial | Out-String).Trim()
  return [string]::IsNullOrWhiteSpace($remaining)
}

try {
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }

  if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  }

  $target = Resolve-TargetSerial

  $cleanupOk = Remove-RemoteCaptureFiles -DeviceSerial $target
  if (-not $cleanupOk) {
    throw "Could not clear existing TV capture files in $RemoteDir."
  }

  $ts = Get-Date -Format "yyyyMMdd_HHmmss"
  $remote = "$RemoteDir/$RemotePrefix$ts.png"
  $local = Join-Path $OutputDir "$LocalPrefix$ts.png"

  Invoke-Adb @("shell", "screencap -p $remote") -DeviceSerial $target | Out-Null
  Invoke-Adb @("pull", $remote, $local) -DeviceSerial $target | Out-Null
  Invoke-Adb @("shell", "rm -f $remote") -DeviceSerial $target | Out-Null

  $stillThere = (Invoke-Adb @("shell", "ls -1 $remote 2>/dev/null || true") -DeviceSerial $target | Out-String).Trim()
  if (-not [string]::IsNullOrWhiteSpace($stillThere)) {
    throw "Remote file still exists after cleanup: $remote"
  }
  if (-not (Test-Path -LiteralPath $local)) {
    throw "Local capture was not created: $local"
  }

  $fileInfo = Get-Item -LiteralPath $local
  [pscustomobject]@{
    ok = $true
    mode = "capture_pull_cleanup"
    target = $target
    localPath = $local
    bytes = [int64]$fileInfo.Length
    remoteDeleted = $true
    timestamp = $ts
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  [pscustomobject]@{
    ok = $false
    error = [string]$_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 1
}
