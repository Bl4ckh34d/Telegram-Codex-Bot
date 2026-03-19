param(
  [ValidateSet("youtube", "netflix", "sunshine", "artemis", "retroarch", "custom")]
  [string]$Action = "youtube",
  [string]$Serial = "",
  [Alias("Host")]
  [string]$TvHost = "",
  [int]$Port = 5555,
  [string]$Package = "",
  [string]$Activity = "",
  [int]$WaitMs = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Adb {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args,
    [string]$DeviceSerial = ""
  )
  $full = @()
  if ($DeviceSerial) { $full += @("-s", $DeviceSerial) }
  $full += $Args
  $prevEA = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & adb @full 2>&1
  } finally {
    $ErrorActionPreference = $prevEA
  }
}

function Invoke-AdbRaw {
  param([Parameter(Mandatory = $true)][string[]]$Args)
  $prevEA = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & adb @Args 2>&1
  } finally {
    $ErrorActionPreference = $prevEA
  }
}

function Resolve-TargetSerial {
  function Wait-DeviceReady {
    param(
      [Parameter(Mandatory = $true)][string]$Endpoint,
      [int]$TimeoutMs = 12000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
      $prevEA = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $state = (& adb -s $Endpoint get-state 2>&1 | Out-String).Trim()
      } finally {
        $ErrorActionPreference = $prevEA
      }
      if ($state -eq "device") { return $true }
      Start-Sleep -Milliseconds 600
    }
    return $false
  }

  if ($Serial) { return $Serial }

  $defaultHost = ([string]$env:AIDOLON_TV_HOST).Trim()
  if (-not $defaultHost) { $defaultHost = "192.168.1.104" }

  $tvHostValue = ([string]$TvHost).Trim()
  if (-not $tvHostValue) { $tvHostValue = $defaultHost }
  if ($tvHostValue) {
    $endpoint = "$tvHostValue`:$Port"
    Invoke-AdbRaw @("connect", $endpoint) | Out-Null
    [void](Wait-DeviceReady -Endpoint $endpoint)
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
  $raw = (Invoke-Adb @("shell", "pm", "list", "packages", $Pkg) -DeviceSerial $DeviceSerial | Out-String).Trim()
  return $raw -match ("package:" + [Regex]::Escape($Pkg))
}

function Start-PackageLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceSerial,
    [Parameter(Mandatory = $true)][string]$Pkg,
    [string]$Act = ""
  )
  function Test-PackageForeground {
    param(
      [Parameter(Mandatory = $true)][string]$TargetSerial,
      [Parameter(Mandatory = $true)][string]$PackageName
    )
    $windowDump = (Invoke-Adb @("shell", "dumpsys", "window", "windows") -DeviceSerial $TargetSerial | Out-String)
    $windowLine = ([string]$windowDump -split "(`r`n|`n|`r)" | Where-Object { $_ -match "mCurrentFocus|mFocusedApp" } | Select-Object -First 1)
    if ($windowLine -and $windowLine -match ([Regex]::Escape($PackageName) + "\/")) {
      return $true
    }

    $activityDump = (Invoke-Adb @("shell", "dumpsys", "activity", "activities") -DeviceSerial $TargetSerial | Out-String)
    $activityLine = ([string]$activityDump -split "(`r`n|`n|`r)" | Where-Object { $_ -match "mResumedActivity|topResumedActivity|ResumedActivity" } | Select-Object -First 1)
    if ($activityLine -and $activityLine -match ([Regex]::Escape($PackageName) + "\/")) {
      return $true
    }
    return $false
  }

  function Start-And-Confirm {
    param(
      [Parameter(Mandatory = $true)][string[]]$CommandArgs,
      [Parameter(Mandatory = $true)][string]$TargetSerial,
      [Parameter(Mandatory = $true)][string]$PackageName
    )
    $raw = (Invoke-Adb -Args $CommandArgs -DeviceSerial $TargetSerial | Out-String).Trim()
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1800)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 220
      if (Test-PackageForeground -TargetSerial $TargetSerial -PackageName $PackageName) {
        return $true
      }
    }
    if ($raw -match "Error|Exception|does not exist|No activities found") {
      return $false
    }
    return $false
  }

  if ($Act) {
    $component = "$Pkg/$Act"
    return (Start-And-Confirm -CommandArgs @("shell", "am", "start", "-n", $component) -TargetSerial $DeviceSerial -PackageName $Pkg)
  }

  if (Start-And-Confirm -CommandArgs @("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LEANBACK_LAUNCHER", "-p", $Pkg) -TargetSerial $DeviceSerial -PackageName $Pkg) {
    return $true
  }
  if (Start-And-Confirm -CommandArgs @("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", $Pkg) -TargetSerial $DeviceSerial -PackageName $Pkg) {
    return $true
  }
  return (Start-And-Confirm -CommandArgs @("shell", "monkey", "-p", $Pkg, "-c", "android.intent.category.LAUNCHER", "1") -TargetSerial $DeviceSerial -PackageName $Pkg)
}

try {
  if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not installed or not in PATH."
  }

  $target = Resolve-TargetSerial
  $targets = @()
  switch ($Action) {
    "youtube" {
      $targets = @("com.google.android.youtube.tv", "com.google.android.youtube")
    }
    "netflix" {
      $targets = @("com.netflix.ninja")
    }
    "sunshine" {
      $targets = @("dev.lizardbyte.app", "dev.lizardbyte.sunshine")
    }
    "artemis" {
      $targets = @("de.grill2010.artemis", "com.limelight.noir", "com.limelight")
    }
    "retroarch" {
      $targets = @("com.retroarch.ra32", "com.retroarch.ra64", "com.retroarch")
    }
    "custom" {
      if ([string]::IsNullOrWhiteSpace($Package)) {
        throw "For custom action, -Package is required."
      }
      $targets = @($Package)
    }
  }

  $attempts = @()
  $launched = $null

  foreach ($pkg in $targets) {
    $installed = Test-PackageInstalled -DeviceSerial $target -Pkg $pkg
    $launchOk = $false
    if ($installed) {
      $launchOk = Start-PackageLauncher -DeviceSerial $target -Pkg $pkg -Act $Activity
      if ($launchOk) {
        $launched = $pkg
      }
    }

    $attempts += [pscustomobject]@{
      package = $pkg
      installed = $installed
      launchOk = $launchOk
    }

    if ($launched) { break }
  }

  if (-not $launched) {
    [pscustomobject]@{
      ok = $false
      action = $Action
      target = $target
      error = "Could not launch requested app. Check install state and package name."
      attempts = $attempts
    } | ConvertTo-Json -Compress -Depth 6
    exit 1
  }

  Start-Sleep -Milliseconds $WaitMs

  [pscustomobject]@{
    ok = $true
    action = $Action
    target = $target
    launchedPackage = $launched
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
