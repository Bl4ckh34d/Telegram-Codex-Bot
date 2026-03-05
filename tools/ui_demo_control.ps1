[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("start", "stop", "status", "restart", "open")]
  [string]$Action,
  [string]$DemoHost = "127.0.0.1",
  [int]$Port = 4317
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$RuntimeRoot = Join-Path $RepoRoot "runtime/ui-demo"
$PidPath = Join-Path $RuntimeRoot "server.pid"
$ServerScript = Join-Path $PSScriptRoot "ui_demo_server.js"
$script:ResultExitCode = 0

function Write-Result {
  param(
    [bool]$Ok,
    [object]$Payload = $null,
    [string]$ErrorMessage = "",
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

  Write-Output ($obj | ConvertTo-Json -Depth 8 -Compress)
  $script:ResultExitCode = [int]$ExitCode
}

function Ensure-RuntimeRoot {
  if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  }
}

function Read-StoredPid {
  if (-not (Test-Path -LiteralPath $PidPath)) { return $null }
  $raw = (Get-Content -Path $PidPath -Raw -ErrorAction SilentlyContinue).Trim()
  if ($raw -notmatch "^\d+$") { return $null }
  return [int]$raw
}

function Clear-StoredPid {
  if (Test-Path -LiteralPath $PidPath) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  }
}

function Is-DemoServerProcess {
  param([int]$Pid)
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid"
    if ($null -eq $proc) { return $false }
    $cmd = [string]$proc.CommandLine
    return $cmd -like "*ui_demo_server.js*"
  } catch {
    return $false
  }
}

function Find-RunningServer {
  $stored = Read-StoredPid
  if ($null -ne $stored) {
    try {
      $p = Get-Process -Id $stored -ErrorAction Stop
      if ($null -ne $p -and -not $p.HasExited -and (Is-DemoServerProcess -Pid $stored)) {
        return $p
      }
    } catch {
      # Ignore and fall back to process scan.
    }
  }

  try {
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        ([string]$_.CommandLine) -like "*ui_demo_server.js*"
      })
    if ($nodes.Count -gt 0) {
      $candidatePid = [int]$nodes[0].ProcessId
      return (Get-Process -Id $candidatePid -ErrorAction Stop)
    }
  } catch {
    # Ignore and treat as not running.
  }

  return $null
}

function Get-Health {
  param([string]$HealthUrl)
  try {
    $response = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2
    return [ordered]@{
      online = [bool]($response.ok)
      payload = $response
    }
  } catch {
    return [ordered]@{
      online = $false
      payload = $null
    }
  }
}

function Wait-Health {
  param(
    [string]$HealthUrl,
    [int]$Attempts = 12,
    [int]$DelayMs = 250
  )
  for ($i = 0; $i -lt [Math]::Max(1, $Attempts); $i++) {
    $health = Get-Health -HealthUrl $HealthUrl
    if ($health.online) { return $health }
    Start-Sleep -Milliseconds $DelayMs
  }
  return (Get-Health -HealthUrl $HealthUrl)
}

function Get-NodeExePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $cmd -or [string]::IsNullOrWhiteSpace([string]$cmd.Source)) {
    return $null
  }
  return [string]$cmd.Source
}

try {
  if (-not (Test-Path -LiteralPath $ServerScript)) {
    Write-Result -Ok $false -ErrorMessage "Server script not found." -Payload @{ script = $ServerScript } -ExitCode 1
    return
  }

  $baseUrl = "http://$DemoHost`:$Port"
  $healthUrl = "$baseUrl/api/health"

  switch ($Action) {
    "status" {
      $proc = Find-RunningServer
      if ($null -eq $proc) {
        Clear-StoredPid
      } else {
        Ensure-RuntimeRoot
        Set-Content -Path $PidPath -Value ([string]$proc.Id) -Encoding ASCII
      }
      $health = Get-Health -HealthUrl $healthUrl
      Write-Result -Ok $true -Payload @{
        running = ($null -ne $proc)
        pid = $(if ($null -eq $proc) { $null } else { $proc.Id })
        online = [bool]$health.online
        url = $baseUrl
        pid_file = $PidPath
      }
      return
    }

    "open" {
      Start-Process $baseUrl | Out-Null
      Write-Result -Ok $true -Payload @{ opened = $baseUrl }
      return
    }

    "stop" {
      $proc = Find-RunningServer
      if ($null -eq $proc) {
        Clear-StoredPid
        Write-Result -Ok $true -Payload @{ running = $false; stopped = $false }
        return
      }
      Stop-Process -Id $proc.Id -Force
      Start-Sleep -Milliseconds 120
      Clear-StoredPid
      Write-Result -Ok $true -Payload @{ running = $false; stopped = $true; pid = $proc.Id }
      return
    }

    "start" {
      $existing = Find-RunningServer
      if ($null -ne $existing) {
        Ensure-RuntimeRoot
        Set-Content -Path $PidPath -Value ([string]$existing.Id) -Encoding ASCII
        $health = Get-Health -HealthUrl $healthUrl
        Write-Result -Ok $true -Payload @{
          started = $false
          already_running = $true
          pid = $existing.Id
          online = [bool]$health.online
          url = $baseUrl
        }
        return
      }

      $nodeExe = Get-NodeExePath
      if ([string]::IsNullOrWhiteSpace($nodeExe)) {
        Write-Result -Ok $false -ErrorMessage "node was not found in PATH." -ExitCode 1
        return
      }

      Ensure-RuntimeRoot
      $proc = Start-Process -FilePath $nodeExe -ArgumentList @($ServerScript) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
      Set-Content -Path $PidPath -Value ([string]$proc.Id) -Encoding ASCII
      $health = Wait-Health -HealthUrl $healthUrl

      Write-Result -Ok $true -Payload @{
        started = $true
        pid = $proc.Id
        online = [bool]$health.online
        url = $baseUrl
      }
      return
    }

    "restart" {
      $old = Find-RunningServer
      if ($null -ne $old) {
        Stop-Process -Id $old.Id -Force
        Start-Sleep -Milliseconds 120
      }
      Clear-StoredPid

      $nodeExe = Get-NodeExePath
      if ([string]::IsNullOrWhiteSpace($nodeExe)) {
        Write-Result -Ok $false -ErrorMessage "node was not found in PATH." -ExitCode 1
        return
      }

      Ensure-RuntimeRoot
      $proc = Start-Process -FilePath $nodeExe -ArgumentList @($ServerScript) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
      Set-Content -Path $PidPath -Value ([string]$proc.Id) -Encoding ASCII
      $health = Wait-Health -HealthUrl $healthUrl
      Write-Result -Ok $true -Payload @{
        restarted = $true
        pid = $proc.Id
        online = [bool]$health.online
        url = $baseUrl
      }
      return
    }
  }
} catch {
  Write-Result -Ok $false -ErrorMessage ([string]$_.Exception.Message) -Payload @{
    type = [string]$_.Exception.GetType().FullName
  } -ExitCode 1
  return
}

if ($script:ResultExitCode -ne 0) {
  exit $script:ResultExitCode
}
