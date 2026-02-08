$ErrorActionPreference = "Stop"

function Normalize-PathSegment {
    param([string]$PathSegment)
    $s = [string]$PathSegment
    if (-not $s) { return "" }
    return $s.Trim().TrimEnd('\').ToLowerInvariant()
}

function Add-UserPathSegment {
    param([string]$Segment)
    if (-not $Segment) { return $false }
    if (-not (Test-Path $Segment)) { return $false }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @()
    if ($userPath) {
        $segments = $userPath.Split(';') | Where-Object { $_ -ne '' }
    }

    $normalizedTarget = Normalize-PathSegment -PathSegment $Segment
    foreach ($item in $segments) {
        if ((Normalize-PathSegment -PathSegment $item) -eq $normalizedTarget) {
            Write-Host "$Segment already present in user PATH"
            return $true
        }
    }

    $newSegments = @($segments + $Segment)
    $newPath = $newSegments -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $Segment to user PATH"
    return $true
}

$addedAny = $false

$npmDir = Join-Path $env:APPDATA "npm"
$codexCmd = Join-Path $npmDir "codex.cmd"
if (Test-Path $codexCmd) {
    if (Add-UserPathSegment -Segment $npmDir) { $addedAny = $true }
} else {
    Write-Host "codex.cmd not found in $npmDir"
}

$nodeCandidates = @(
    (Join-Path $env:ProgramFiles "nodejs"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs")
)
$nodeCandidates = $nodeCandidates | Where-Object { $_ -and $_.Trim() -ne "" } | Select-Object -Unique

foreach ($nodeDir in $nodeCandidates) {
    $nodeExe = Join-Path $nodeDir "node.exe"
    if (Test-Path $nodeExe) {
        if (Add-UserPathSegment -Segment $nodeDir) { $addedAny = $true }
    }
}

if (-not $addedAny) {
    Write-Host "No PATH changes were required or possible."
}
