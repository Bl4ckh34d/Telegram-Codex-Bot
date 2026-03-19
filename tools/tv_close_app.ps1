param(
  [ValidateSet("youtube", "netflix", "sunshine", "artemis", "retroarch", "vlc", "spotify", "custom")]
  [string]$Action = "retroarch",
  [string]$Serial = "",
  [Alias("Host")]
  [string]$TvHost = "",
  [int]$Port = 5555,
  [string]$Package = "",
  [int]$WaitMs = 350
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

function Test-PackageInstalled {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceSerial,
    [Parameter(Mandatory = $true)][string]$Pkg
  )
  $raw = (Invoke-Adb @("shell", "pm list packages $Pkg 2>/dev/null || true") -DeviceSerial $DeviceSerial | Out-String).Trim()
  return $raw -match ("package:" + [Regex]::Escape($Pkg))
}

function Test-PackageRunning {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceSerial,
    [Parameter(Mandatory = $true)][string]$Pkg
  )
  $raw = (Invoke-Adb @("shell", "pidof $Pkg 2>/dev/null || true") -DeviceSerial $DeviceSerial | Out-String).Trim()
  return -not [string]::IsNullOrWhiteSpace($raw)
}

function Stop-Package {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceSerial,
    [Parameter(Mandatory = $true)][string]$Pkg
  )
  Invoke-Adb @("shell", "am force-stop $Pkg") -DeviceSerial $DeviceSerial | Out-Null
  Start-Sleep -Milliseconds $WaitMs
  return -not (Test-PackageRunning -DeviceSerial $DeviceSerial -Pkg $Pkg)
}

try {
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }

  $target = Resolve-TargetSerial
  $candidates = @()

  switch ($Action) {
    "youtube" {
      $candidates = @("com.google.android.youtube.tv", "com.google.android.youtube")
    }
    "netflix" {
      $candidates = @("com.netflix.ninja")
    }
    "sunshine" {
      $candidates = @("dev.lizardbyte.app", "dev.lizardbyte.sunshine")
    }
    "artemis" {
      $candidates = @("de.grill2010.artemis", "com.limelight.noir", "com.limelight")
    }
    "retroarch" {
      $candidates = @("com.retroarch.ra32", "com.retroarch.ra64", "com.retroarch")
    }
    "vlc" {
      $candidates = @("org.videolan.vlc")
    }
    "spotify" {
      $candidates = @("com.spotify.tv.android")
    }
    "custom" {
      if ([string]::IsNullOrWhiteSpace($Package)) {
        throw "For custom action, -Package is required."
      }
      $candidates = @($Package)
    }
  }

  $attempts = @()
  $stopped = $null

  foreach ($pkg in $candidates) {
    $installed = Test-PackageInstalled -DeviceSerial $target -Pkg $pkg
    $runningBefore = $false
    $stopOk = $false
    $runningAfter = $false

    if ($installed) {
      $runningBefore = Test-PackageRunning -DeviceSerial $target -Pkg $pkg
      $stopOk = Stop-Package -DeviceSerial $target -Pkg $pkg
      $runningAfter = Test-PackageRunning -DeviceSerial $target -Pkg $pkg
      if ($stopOk) {
        $stopped = $pkg
      }
    }

    $attempts += [pscustomobject]@{
      package = $pkg
      installed = $installed
      runningBefore = $runningBefore
      stopOk = $stopOk
      runningAfter = $runningAfter
    }

    if ($stopped) { break }
  }

  if (-not $stopped) {
    throw "Could not close requested app. Check install state and package name."
  }

  [pscustomobject]@{
    ok = $true
    action = $Action
    target = $target
    stoppedPackage = $stopped
    attempts = $attempts
    waitedMs = $WaitMs
  } | ConvertTo-Json -Compress -Depth 6
  exit 0
} catch {
  [pscustomobject]@{
    ok = $false
    action = $Action
    error = [string]$_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 1
}
