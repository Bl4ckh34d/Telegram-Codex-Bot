$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'init.js')
if ($LASTEXITCODE -ne 0) { throw 'Companion initialization failed' }
$name = 'AIDOLON-Companion'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Actions.Execute -ne $node -or $existing.Actions.WorkingDirectory -ne $root) {
        throw 'An existing companion task points elsewhere. Inspect it before replacing.'
    }
    if ($existing.State -eq 'Running') { Write-Output 'Companion is already running'; return }
} else {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $PSScriptRoot 'server.js') + '"') -WorkingDirectory $root
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskName $name
Write-Output 'Companion launch requested in the logged-in desktop session.'
